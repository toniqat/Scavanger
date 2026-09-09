/**
 * src/stratagems/parts/Calls.ts — **호출된 함선 지원이 실제로 하는 일**.
 *
 * 궤도 레이저(10초 지속 피해) · 항공 폭탄 · 보급품 상자(티어 5) · 파괴 가능 엄폐 구조물(트라이포드). 구조선은 `parts/Rescue`.
 * 시각 효과는 전부 절차 생성이고 조명은 쓰지 않는다.
 */
import * as THREE from 'three';
import {
  Keys, MouseButtons, Random,
  STRATAGEM_DEFS, STRATAGEM_ORDER, STRATAGEM_WHEEL_HOLD, STRATAGEM_CHARGE_TIME,
  TOPVIEW_HEIGHT, TOPVIEW_RANGE, TOPVIEW_CURSOR_SPEED, GROUND_TARGET_RANGE,
  LASER_DURATION, LASER_RADIUS, LASER_DPS, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE,
  SUPPLY_FALL_TIME, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE, SUPPLY_CRATE_TIER,
  STRUCTURE_COUNT, STRUCTURE_HP, STRUCTURE_SCATTER, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE, STRUCTURE_FALL_TIME,
  type GameContext, type GameSystem, type StratagemsRef, type StratagemId, type StratagemCall, type StratagemStage, type StratagemDef,
  type PlayerRef, type PlayerWeaponHost, type Interactable, type Obstacle, type DestructibleRef, type WorldRef, type Vec3Tuple, type PeerId,
  type StratagemCallWire,
} from '@/shared';
import {
  SharedGeo, TargetRing, CallMarker, Burst, dustBurst, sparkBurst, LaserBeam, Fireball, SupplyCrateMesh, BarricadeMesh, makeRubble, KIND_COLOR,
} from '../Visuals';
import { AIRSTRIKE_FX_TIME, Call, GRENADE_STRUCTURE_DAMAGE, type Host, LASER_TICK, SHAKE_RANGE, STRUCTURE_DROP_HEIGHT, STRUCTURE_MIN_GAP, STRUCTURE_STAGGER, SUPPLY_DROP_HEIGHT, Structure, TARGET_EMIT_EPS, WHEEL_DRAG_PX, _a, _b, _dir, defOf, toTuple } from '../model';
import * as Rescue from './Rescue';
import type { StratagemSystem } from '../StratagemSystem';

export function createCall(sys: StratagemSystem, kind: StratagemId, position: THREE.Vector3, eta: number, seed: number, local: boolean, id?: string, caller?: PeerId | null): Call {
  const ctx = sys.ctx;
  const callId = id ?? `${ctx.net?.localId ?? 'sp'}-${++sys.seq}`;
  const who = caller !== undefined ? caller : (ctx.net?.localId ?? null);
  const call = new Call(callId, kind, position.clone(), ctx.time + eta, who, seed, local);
  sys.calls.push(call);
  sys.byId.set(callId, call);
  call.marker = new CallMarker(sys.geo, kind, call.def.radius);
  call.marker.group.position.copy(position);
  sys.group.add(call.marker.group);
  if (kind === 'supply_drop') sys.prepareSupply(call);
  else if (kind === 'structure_drop') sys.prepareStructures(call);
  ctx.bus.emit('stratagem:called', { callId, kind, position: call.position, landsAt: call.landsAt, caller: who });
  return call;
  }

export function removeMarker(sys: StratagemSystem, call: Call): void {
  if (!call.marker) return;
  sys.group.remove(call.marker.group);
  call.marker.dispose();
  call.marker = null;
  }

export function landed(sys: StratagemSystem, call: Call): void {
  sys.ctx.bus.emit('stratagem:landed', { callId: call.id, kind: call.kind, position: call.position });
  }

export function ended(sys: StratagemSystem, call: Call): void {
  if (call.stage === 'done') return;
  call.stage = 'done';
  sys.ctx.bus.emit('stratagem:ended', { callId: call.id, kind: call.kind });
  }

/** Radial damage of an impact: enemies only on the caller's client, the local player everywhere (linear falloff). */
export function impactDamage(sys: StratagemSystem, call: Call, center: THREE.Vector3, radius: number, damage: number): void {
  const ctx = sys.ctx;
  if (sys.silent) return;   // fast-forwarded sync landing: the impact happened before we joined
  if (call.local && ctx.enemies) ctx.enemies.applyExplosion(center, radius, damage);
  const p = ctx.player;
  if (p && !p.isDead) {
    _a.copy(p.position); _a.y += 0.9;
    const d = _a.distanceTo(center);
    if (d < radius) {
      const dmg = damage * (1 - d / radius);
      if (dmg > 1) p.takeDamage(dmg, center.clone());
    }
  }
  }

export function updateCalls(sys: StratagemSystem, dt: number): void {
  // Call timing is expressed in ctx.time (unscaled, keeps running while the game is frozen) so the HUD can show ETAs.
  // While the simulation is paused (dt === 0, single-player pause) shift every pending timestamp forward by the wall
  // time that passed, so an incoming call never lands or ticks during a pause.
  const now = sys.ctx.time;
  const wall = sys.lastClock >= 0 ? now - sys.lastClock : 0;
  sys.lastClock = now;
  if (dt <= 0 && wall > 0) {
    for (const c of sys.calls) {
      (c as { landsAt: number }).landsAt += wall;
      for (const s of c.structures) (s as { landAt: number }).landAt += wall;
    }
    return;
  }
  const t = now;
  for (let i = sys.calls.length - 1; i >= 0; i--) {
    const c = sys.calls[i];
    if (c.marker) {
      const frac = THREE.MathUtils.clamp(1 - (c.landsAt - t) / Math.max(0.01, c.def.delay), 0, 1);
      c.marker.animate(t, frac);
    }
    if (c.stage === 'incoming' && !c.audioStarted && c.landsAt - t <= 2.5) {
      c.audioStarted = true;
      sys.audio('hellpod_fall', c.position, 0.8);
    }
    switch (c.kind) {
      case 'orbital_laser': sys.updateLaser(c, t, dt); break;
      case 'airstrike': sys.updateAirstrike(c, t); break;
      case 'supply_drop': sys.updateSupply(c, t); break;
      case 'structure_drop': sys.updateStructures(c, t); break;
      /* 2026-09-09: 구조선 — 포드 메시는 player/ 가 그리므로 여기서는 마커 · 착륙 FX · 이벤트만 */
      case 'rescue_drop': sys.updateRescue(c, t); break;
    }
  }
  }

/* ─────────────────────────── orbital laser ─────────────────────────── */
export function updateLaser(sys: StratagemSystem, c: Call, t: number, _dt: number): void {
  if (c.stage === 'incoming') {
    if (t < c.landsAt) return;
    c.stage = 'active';
    sys.removeMarker(c);
    c.beam = new LaserBeam(sys.geo, LASER_RADIUS);
    c.beam.group.position.copy(c.position);
    sys.group.add(c.beam.group);
    c.nextTick = t;
    sys.landed(c);
    sys.audio('explosion', c.position, 0.7);
    sys.shakeFrom(c.position, 0.6);
  }
  if (c.stage !== 'active' || !c.beam) return;
  const since = t - c.landsAt;
  const remaining = LASER_DURATION - since;
  if (remaining <= 0) {
    sys.group.remove(c.beam.group); c.beam.dispose(); c.beam = null;
    sys.ended(c);
    return;
  }
  c.beam.animate(since, remaining);
  while (t >= c.nextTick) {
    c.nextTick += LASER_TICK;
    sys.impactDamage(c, c.position, LASER_RADIUS, LASER_DPS * LASER_TICK);
    sys.burst(sparkBurst(c.position, KIND_COLOR.orbital_laser));
    sys.shakeFrom(c.position, 0.12);
  }
  }

/* ─────────────────────────── airstrike ─────────────────────────── */
export function updateAirstrike(sys: StratagemSystem, c: Call, t: number): void {
  if (c.stage === 'incoming') {
    if (t < c.landsAt) return;
    c.stage = 'active';
    sys.removeMarker(c);
    c.fireball = new Fireball(sys.geo, AIRSTRIKE_RADIUS);
    c.fireball.group.position.copy(c.position);
    sys.group.add(c.fireball.group);
    sys.impactDamage(c, c.position, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE);
    sys.burst(dustBurst(c.position, AIRSTRIKE_RADIUS));
    sys.burst(sparkBurst(c.position, 0xffa040));
    sys.shakeFrom(c.position, 1.0);
    sys.audio('explosion', c.position, 1);
    sys.landed(c);
  }
  if (c.stage !== 'active' || !c.fireball) return;
  if (!c.fireball.animate(t - c.landsAt) || t - c.landsAt >= AIRSTRIKE_FX_TIME) {
    sys.group.remove(c.fireball.group); c.fireball.dispose(); c.fireball = null;
    sys.ended(c);
  }
  }

/* ─────────────────────────── supply drop ─────────────────────────── */
export function prepareSupply(sys: StratagemSystem, c: Call): void {
  c.crate = new SupplyCrateMesh(sys.geo);
  c.crate.group.position.set(c.position.x, c.position.y + SUPPLY_DROP_HEIGHT, c.position.z);
  c.crate.group.visible = false;
  c.crate.group.rotation.y = (c.seed % 628) / 100;
  sys.group.add(c.crate.group);
  }

export function updateSupply(sys: StratagemSystem, c: Call, t: number): void {
  if (c.stage === 'incoming') {
    const crate = c.crate!;
    const k = (t - (c.landsAt - SUPPLY_FALL_TIME)) / SUPPLY_FALL_TIME;   // 0 = release, 1 = touchdown
    if (k >= 0 && k < 1) {
      crate.group.visible = true;
      crate.setFalling(true);
      crate.group.position.y = c.position.y + SUPPLY_DROP_HEIGHT * (1 - k * k);
      crate.group.rotation.y += 0.01;
    }
    if (t < c.landsAt) return;
    c.stage = 'active';
    crate.group.visible = true;
    crate.setFalling(false);
    crate.group.position.copy(c.position);
    sys.removeMarker(c);
    sys.impactDamage(c, c.position, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE);
    sys.burst(dustBurst(c.position, SUPPLY_IMPACT_RADIUS));
    sys.shakeFrom(c.position, 0.5);
    sys.audio('explosion', c.position, 0.5);
    c.obstacleRemover = sys.addObstacle({ position: c.position.clone(), radius: 0.8, height: 1.2 });
    const id = 'supply:' + c.id;
    const ctx = sys.ctx;
    c.interactable = {
      id, position: c.position, radius: 2.4,
      getPrompt: () => (c.looted ? null : '보급 상자 열기'),
      canInteract: () => !c.looted && c.stage === 'active',
      interact: () => { ctx.bus.emit('crate:open', { crateId: id, tier: SUPPLY_CRATE_TIER, position: c.position }); },
    };
    ctx.interactables.register(c.interactable);
    sys.landed(c);
  }
  }

export function onCrateLooted(sys: StratagemSystem, crateId: string): void {
  if (!crateId.startsWith('supply:')) return;
  const c = sys.byId.get(crateId.slice(7));
  if (!c || c.looted) return;
  c.looted = true;
  c.crate?.setLooted();
  sys.ended(c);
  }

/* ─────────────────────────── structures ─────────────────────────── */
export function addObstacle(sys: StratagemSystem, o: Obstacle): (() => void) | null {
  const w = sys.world();
  if (!w) return null;
  if (typeof w.addObstacle !== 'function') {
    if (!sys.warnedNoObstacle) { sys.warnedNoObstacle = true; console.warn('[stratagems] WorldRef.addObstacle missing — structures have no collision'); }
    return null;
  }
  return w.addObstacle(o);
  }

export function prepareStructures(sys: StratagemSystem, c: Call): void {
  const world = sys.world();
  const rnd = new Random(c.seed);
  const placed: THREE.Vector3[] = [];
  for (let i = 0; i < STRUCTURE_COUNT; i++) {
    let pos: THREE.Vector3 | null = null;
    for (let tries = 0; tries < 24 && !pos; tries++) {
      const a = rnd.next() * Math.PI * 2, r = Math.sqrt(rnd.next()) * STRUCTURE_SCATTER;
      const x = c.position.x + Math.cos(a) * r, z = c.position.z + Math.sin(a) * r;
      if (world && !world.isInsideBounds(x, z)) continue;
      let ok = true;
      for (const q of placed) if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < STRUCTURE_MIN_GAP * STRUCTURE_MIN_GAP) { ok = false; break; }
      if (!ok) continue;
      pos = new THREE.Vector3(x, world ? world.getHeightAt(x, z) : c.position.y, z);
    }
    if (!pos) pos = new THREE.Vector3(c.position.x + i * STRUCTURE_MIN_GAP, c.position.y, c.position.z);
    placed.push(pos);
    const yaw = rnd.next() * Math.PI * 2;
    const mesh = new BarricadeMesh(sys.geo, yaw);
    mesh.group.position.set(pos.x, pos.y + STRUCTURE_DROP_HEIGHT, pos.z);
    mesh.group.visible = false;
    sys.group.add(mesh.group);
    const s = new Structure(`${c.id}:${i}`, c, i, pos, c.landsAt + i * STRUCTURE_STAGGER, mesh, (st, amount) => sys.damageStructure(st, amount, true));
    c.structures.push(s);
  }
  }

export function updateStructures(sys: StratagemSystem, c: Call, t: number): void {
  if (c.stage === 'done') return;
  for (const s of c.structures) {
    if (s.landed) continue;
    const k = (t - (s.landAt - STRUCTURE_FALL_TIME)) / STRUCTURE_FALL_TIME;
    if (k < 0) continue;
    if (k < 1) {
      s.mesh.group.visible = true;
      s.mesh.group.position.y = s.position.y + STRUCTURE_DROP_HEIGHT * (1 - k * k);
      continue;
    }
    s.landed = true;
    s.mesh.group.visible = true;
    s.mesh.group.position.copy(s.position);
    sys.impactDamage(c, s.position, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE);
    sys.burst(dustBurst(s.position, STRUCTURE_IMPACT_RADIUS));
    sys.shakeFrom(s.position, 0.45);
    sys.audio('explosion', s.position, 0.45);
    s.remover = sys.addObstacle({ position: s.position.clone(), radius: 1.35, height: 1.5, destructible: s.destructible });
    if (s.hp <= 0) sys.destroyStructure(s);   // destroyed by a `structHp` that arrived before it landed
    if (++c.landedCount === 1) { sys.removeMarker(c); c.stage = 'active'; sys.landed(c); }
  }
  if (c.landedCount >= c.structures.length) sys.ended(c);
  }

export function damageStructure(sys: StratagemSystem, s: Structure, amount: number, broadcast: boolean): void {
  if (s.destroyed || amount <= 0) return;
  sys.setStructureHp(s, s.hp - amount);
  if (broadcast && sys.ctx.isMultiplayer && sys.ctx.net) {
    sys.ctx.net.send({ t: 'strat', ev: 'structHp', callId: s.call.id, index: s.index, hp: Math.max(0, Math.round(s.hp)) }, 'others');
  }
  }

export function setStructureHp(sys: StratagemSystem, s: Structure, hp: number): void {
  if (s.destroyed) return;
  s.hp = Math.max(0, hp);
  s.mesh.setDamage(1 - s.hp / STRUCTURE_HP);
  sys.ctx.bus.emit('structure:damaged', { id: s.id, hp: s.hp, maxHp: STRUCTURE_HP, position: s.position });
  if (s.hp <= 0 && s.landed) sys.destroyStructure(s);
  }

export function destroyStructure(sys: StratagemSystem, s: Structure): void {
  if (s.destroyed) return;
  s.destroyed = true;
  s.remover?.(); s.remover = null;
  sys.group.remove(s.mesh.group); s.mesh.dispose();
  s.rubble = makeRubble(sys.geo, s.index + s.call.seed % 13);
  s.rubble.position.copy(s.position);
  sys.group.add(s.rubble);
  sys.burst(dustBurst(s.position, 2.0, true));
  sys.shakeFrom(s.position, 0.3);
  sys.audio('explosion', s.position, 0.35);
  sys.ctx.bus.emit('structure:destroyed', { id: s.id, position: s.position });
  }

/** Radial damage to standing structures (grenades). */
export function splashStructures(sys: StratagemSystem, center: THREE.Vector3, radius: number, damage: number): void {
  for (const c of sys.calls) for (const s of c.structures) {
    if (!s.landed || s.destroyed) continue;
    const d = s.position.distanceTo(center);
    if (d < radius + 1.3) {
      const dmg = damage * (1 - Math.max(0, d - 1.3) / radius);
      if (dmg > 1) sys.damageStructure(s, dmg, true);
    }
  }
  }

export function disposeStructure(sys: StratagemSystem, s: Structure): void {
  s.remover?.(); s.remover = null;
  if (!s.destroyed) { sys.group.remove(s.mesh.group); s.mesh.dispose(); }
  if (s.rubble) {
    sys.group.remove(s.rubble);
    (s.rubble.userData.mat as THREE.Material | undefined)?.dispose();
    s.rubble = null;
  }
  }

/* ─────────────────────────── cleanup ─────────────────────────── */
export function removeCall(sys: StratagemSystem, c: Call): void {
  sys.removeMarker(c);
  if (c.beam) { sys.group.remove(c.beam.group); c.beam.dispose(); c.beam = null; }
  if (c.fireball) { sys.group.remove(c.fireball.group); c.fireball.dispose(); c.fireball = null; }
  if (c.crate) { sys.group.remove(c.crate.group); c.crate.dispose(); c.crate = null; }
  if (c.interactable) { sys.ctx.interactables.unregister(c.interactable.id); c.interactable = null; }
  c.obstacleRemover?.(); c.obstacleRemover = null;
  for (const s of c.structures) sys.disposeStructure(s);
  c.structures.length = 0;
  sys.byId.delete(c.id);
  const i = sys.calls.indexOf(c);
  if (i >= 0) sys.calls.splice(i, 1);
  }

export function clearAll(sys: StratagemSystem): void {
  sys.putAway();
  sys.gHeld = false;
  // 2026-09-09: 분대 공용 구조선 횟수는 레이드마다 새로 채워진다
  Rescue.resetRescue(sys);
  for (let i = sys.calls.length - 1; i >= 0; i--) sys.removeCall(sys.calls[i]);
  for (const b of sys.bursts) { sys.group.remove(b.points); b.dispose(); }
  sys.bursts.length = 0;
  }
