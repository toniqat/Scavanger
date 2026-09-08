/**
 * src/gadgets/parts/Deploy.ts — **가젯을 놓고 회수하기**.
 *
 * 배치물은 **호스트 권한**이다: 클라이언트는 `gadq` 로 요청하고 호스트가 `gad` 로 확정한다.
 * 설치 위치 판정, 회수 / 해체 홀드, 되돌려주는 아이템까지가 이 파일의 범위다.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from '../Deployable';
import { GadgetVisualPool } from '../GadgetVisuals';
import { ThrownGadgetManager } from '../ThrownGadget';
import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

export function use(sys: GadgetSystem, id: GadgetId, underhand?: boolean): boolean {
  const ctx = sys.ctx;
  const def = gadgetDef(id);
  if (!def) return false;
  const player = ctx.player;
  // usable from the quick bar with the inventory open, but never in the hub / menus / while paused
  if (!ctx.isGameplayPhase() || ctx.uiBlockers.has('menu')) return sys.deny(null);
  if (!player || player.isDead || player.isDowned) return sys.deny(null);
  if (sys.useCooldown > 0) return false;

  // validate before consuming the item
  let target: { id: PeerId; position: THREE.Vector3; name: string } | null = null;
  if (def.use === 'place' && !sys.placementSpot(def, _a)) return sys.deny('설치할 공간이 없다');
  if (def.use === 'target') {
    target = sys.findDownedAlly(def.radius);
    if (!target) return sys.deny('근처에 쓰러진 아군이 없다');
  }
  if (!sys.consumeItem(def)) return sys.deny(`${def.name} 없음`);

  sys.useCooldown = USE_COOLDOWN / Math.max(0.25, sys.derived('useSpeedMul', 1));
  const over = underhand === undefined ? sys.underhand : underhand;
  switch (def.use) {
    case 'self': sys.useCloakVeil(def); break;
    case 'target': if (target) sys.useDefib(def, target); break;
    case 'throw': sys.throwGadget(def, over); break;
    case 'place': sys.requestPlace(def, _a, player.yaw); break;
  }
  ctx.bus.emit('gadget:used', { id, position: player.position.clone() });
  return true;
  }

export function recover(sys: GadgetSystem, id: string): ItemInstance | null {
  const ctx = sys.ctx;
  const d = sys.byId.get(id);
  if (!d || d.removing) return null;
  const def = gadgetForKind(d.kind);
  if (!def || def.recoverTime <= 0) return null;
  if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
    // client: ask the host; the item is granted when `gad remove {recovered}` echoes back
    sys.pendingRecover.add(id);
    ctx.net.send({ t: 'gadq', ev: 'recover', id }, 'host');
    return null;
  }
  const item = sys.grantRecovered(d);
  sys.remove(d, 'recovered');
  return item;
  }

export function clear(sys: GadgetSystem): void {
  for (let i = sys.deployables.length - 1; i >= 0; i--) sys.removeLocal(sys.deployables[i], 'expired');
  sys.pendingRecover.clear();
  sys.thrown.clear();
  }

/* ═══════════════════════════ input ═══════════════════════════ */
export function handleInput(sys: GadgetSystem, ctx: GameContext): void {
  if (!ctx.isGameplayActive()) return;
  if (ctx.input.wasPressed(Keys.THROW_MODE)) {
    sys.underhand = !sys.underhand;
    ctx.bus.emit('gadget:throwModeChanged', { underhand: sys.underhand });
    ctx.bus.emit('ui:notify', { text: sys.underhand ? '언더 스로' : '오버 스로', kind: 'info', duration: 1 });
    ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.4 });
  }
  }

/* ═══════════════════════════ use paths ═══════════════════════════ */
export function useCloakVeil(sys: GadgetSystem, def: GadgetDef): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;
  if (typeof p.setCloak === 'function') p.setCloak(def.duration, 'gadget');
  sys.visuals.pulse(p.position, def.color, 0.6, def.radius, 0.8);
  ctx.bus.emit('audio:play', { id: 'gadget_cloak', position: p.position, volume: 0.8 });
  ctx.bus.emit('ui:notify', { text: `은폐 ${Math.round(def.duration)}초`, kind: 'success', duration: 1.6 });

  // Share the cloak with squadmates standing inside the veil. Each recipient applies it locally on `buff`.
  const net = ctx.net;
  if (!net?.inSession) return;
  const shareSq = GADGET_CLOAK_SHARE_RADIUS * GADGET_CLOAK_SHARE_RADIUS;
  let shared = 0;
  for (const r of net.getRemotePlayers()) {
    if (!r.connected || r.isDead) continue;
    if (r.position.distanceToSquared(p.position) > shareSq) continue;
    const msg: BuffMessage = { t: 'buff', kind: 'cloak', amount: 0, duration: def.duration, by: net.playerName };
    net.send(msg, r.id);
    shared++;
  }
  if (shared > 0) {
    ctx.bus.emit('ui:notify', { text: `아군 ${shared}명 은폐`, kind: 'success', duration: 1.6 });
  }
  }

export function useDefib(sys: GadgetSystem, def: GadgetDef, target: { id: PeerId; position: THREE.Vector3; name: string }): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  const msg: BuffMessage = {
    t: 'buff', kind: 'revive',
    amount: ctx.player?.maxHp ?? 100,
    duration: 0,
    by: net?.playerName ?? '아군',
  };
  net?.send(msg, target.id);
  sys.visuals.pulse(target.position, def.color, 0.4, 3.2, 0.6);
  ctx.bus.emit('audio:play', { id: 'gadget_defib', position: target.position, volume: 0.9 });
  ctx.bus.emit('ui:notify', { text: `${target.name} 부활`, kind: 'success', duration: 2 });
  ctx.bus.emit('chat:post', { text: `${target.name} 을(를) 일으켰다`, kind: 'system' });
  }

export function throwGadget(sys: GadgetSystem, def: GadgetDef, underhand: boolean): void {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return;
  const range = sys.derived('throwRangeMul', 1);
  // use the camera aim ray when the player exposes it (pitch included), else the horizontal forward
  const host = p as unknown as Partial<PlayerWeaponHost>;
  if (typeof host.getAimRay === 'function') { host.getAimRay(_a, _b); }
  else { p.getEyePosition(_a); p.getForward(_b); }
  _b.normalize();
  _a.addScaledVector(_b, 0.6);
  const speed = (underhand ? 8 : 17) * range;
  _c.copy(_b).multiplyScalar(speed).addScaledVector(p.velocity, 0.5);
  _c.y += underhand ? 2.4 : 3.5;
  sys.thrown.throw(def.id, def.color, _a, _c);
  ctx.bus.emit('audio:play', { id: 'grenade_throw', position: _a, volume: 0.65 });
  }

export function onThrownImpact(sys: GadgetSystem, gid: GadgetId, pos: THREE.Vector3): void {
  const def = gadgetDef(gid);
  if (!def || !def.deployable) return;
  const yaw = sys.ctx.player?.yaw ?? 0;
  sys.requestPlace(def, pos, yaw);
  }

/** Authority spawns straight away; clients ask the host and wait for `gad spawn`. */
export function requestPlace(sys: GadgetSystem, def: GadgetDef, position: THREE.Vector3, yaw: number): void {
  const ctx = sys.ctx;
  if (!def.deployable) return;
  if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
    ctx.net.send({ t: 'gadq', ev: 'place', gadget: def.id, p: toTuple(position), yaw }, 'host');
    return;
  }
  sys.spawnDeployable(sys.nextId(), def, ctx.net?.localId ?? 'local', position, yaw, null);
  }

/* ═══════════════════════════ spawn / remove ═══════════════════════════ */
export function nextId(sys: GadgetSystem): string {
  return `${sys.ctx.net?.localId ?? 'sp'}-g${++sys.seq}`;
  }

/**
 * @param wire non-null when this is a replica built from a `gad spawn` / `gad sync` broadcast
 *   (hp / armed / ttl come from the host instead of the definition).
 */
export function spawnDeployable(sys: GadgetSystem, id: string, def: GadgetDef, owner: PeerId | 'local', position: THREE.Vector3, yaw: number, wire: DeployableWire | null): Deployable | null {
  const kind = def.deployable;
  if (!kind || sys.byId.has(id)) return null;
  const ctx = sys.ctx;
  while (sys.deployables.length >= MAX_DEPLOYABLES) sys.removeLocal(sys.deployables[0], 'expired');

  const hp = wire ? wire.hp : def.hp;
  const maxHp = wire ? wire.maxHp : def.hp;
  const armed = wire ? wire.armed : !(kind === 'mine' || kind === 'domeShield');
  const ttl = wire ? wire.ttl : def.duration;
  const expires = ttl > 0 ? ctx.time + ttl : 0;

  const visual = sys.visuals.acquire(kind, def.color, def.radius);
  const d = new Deployable(id, kind, owner, def.id, def.radius, hp, maxHp, armed, expires, visual);
  d.position.copy(position);
  d.position.y = sys.groundY(position);
  d.yaw = yaw;
  d.headYaw = yaw;
  d.onDamage = (dep, amount, from) => sys.onDeployableDamage(dep, amount, from);
  visual.root.position.copy(d.position);
  visual.root.rotation.y = yaw;

  sys.deployables.push(d);
  sys.byId.set(id, d);
  if (def.recoverTime > 0) {
    const it = sys.makeInteractable(d, def);
    sys.interactables.set(id, it);
    ctx.interactables.register(it);
  }
  ctx.bus.emit('gadget:deployed', { id, kind, position: d.position, owner: String(owner) });
  ctx.bus.emit('audio:play', { id: kind === 'mine' ? 'mine_place' : 'gadget_deploy', position: d.position, volume: 0.8 });
  sys.visuals.pulse(d.position, def.color, 0.3, Math.min(def.radius, 4), 0.45);
  if (ctx.isAuthority) sys.broadcast({ t: 'gad', ev: 'spawn', d: sys.wireOf(d) }, 'others');
  return d;
  }

/** Removes locally and, on the authority, tells everyone. */
export function remove(sys: GadgetSystem, d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void {
  if (d.removing) return;
  if (sys.ctx.isAuthority) sys.broadcast({ t: 'gad', ev: 'remove', id: d.id, reason }, 'others');
  sys.removeLocal(d, reason);
  }

export function removeLocal(sys: GadgetSystem, d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void {
  if (d.removing) return;
  d.removing = true;
  const i = sys.deployables.indexOf(d);
  if (i >= 0) sys.deployables.splice(i, 1);
  sys.byId.delete(d.id);
  const it = sys.interactables.get(d.id);
  if (it) { sys.ctx.interactables.unregister(it.id); sys.interactables.delete(d.id); }
  sys.visuals.release(d.visual);
  sys.pendingRecover.delete(d.id);
  sys.ctx.bus.emit('gadget:removed', { id: d.id, kind: d.kind, reason });
  }

export function makeInteractable(sys: GadgetSystem, d: Deployable, def: GadgetDef): Interactable {
  // (the class body kept a `const sys = this` alias — the parameter is that alias now)
  const prompt = d.kind === 'mine' ? '지뢰 해체' : `${def.name} 회수`;
  return {
    id: `gadget:${d.id}`,
    position: d.position,
    radius: RECOVER_RADIUS,
    getPrompt: () => prompt,
    canInteract: () => sys.ctx.isGameplayActive() && !d.removing && !sys.pendingRecover.has(d.id),
    interact: () => { sys.recover(d.id); },
    // base hold; the player applies `derived.interactSpeedMul` to every hold (Phase 5)
    holdTime: def.recoverTime || GADGET_DEFUSE_TIME,
  };
  }

/** Puts the recovered item in the local bag (barricade / turret / jump pad only). */
export function grantRecovered(sys: GadgetSystem, d: Deployable): ItemInstance | null {
  if (!isRecoverable(d.kind)) return null;
  const defId = sys.itemDefIdFor(d.gadgetId);
  const loot = sys.ctx.loot;
  if (!defId || !loot) return null;
  const item = loot.createItem(defId, 1);
  const ok = sys.ctx.inventory?.tryAddItem(item) ?? false;
  if (!ok) return null;   // inventory already emitted `inventory:full`; the deployable is removed anyway
  sys.ctx.bus.emit('gadget:recovered', { id: d.id, item });
  sys.ctx.bus.emit('audio:play', { id: 'gadget_recover', position: d.position, volume: 0.7 });
  return item;
  }

/** Spot in front of the player for a 'place' gadget. false when it is blocked / off the map. */
export function placementSpot(sys: GadgetSystem, def: GadgetDef, out: THREE.Vector3): boolean {
  const ctx = sys.ctx;
  const p = ctx.player;
  const world = ctx.world;
  if (!p || !world || !world.ready) return false;
  p.getForward(_fwd);
  out.copy(p.position).addScaledVector(_fwd, PLACE_DISTANCE);
  if (!world.isInsideBounds(out.x, out.z)) return false;
  out.y = world.getHeightAt(out.x, out.z);
  // do not stack deployables on top of each other
  for (const d of sys.deployables) {
    if (d.removing) continue;
    const clearance = d.kind === 'barricade' ? PLACE_CLEARANCE * 2 : PLACE_CLEARANCE;
    if (d.position.distanceTo(out) < clearance) return false;
  }
  // too steep? (slope guard so barricades / turrets do not float)
  world.getNormalAt(out.x, out.z, _b);
  if (_b.y < 0.72) return false;
  void def;
  return true;
  }

/** Item def id whose `gadgetId` matches (items/ owns the actual definitions). */
export function itemDefIdFor(sys: GadgetSystem, id: GadgetId): string | null {
  const cached = sys.itemDefCache.get(id);
  if (cached) return cached;
  const loot = sys.ctx.loot;
  if (!loot) return null;
  for (const def of loot.getAllItemDefs()) {
    if (def.gadgetId === id) { sys.itemDefCache.set(id, def.id); return def.id; }
  }
  return null;
  }

/**
 * Takes one unit out of the bag. When items/ has not published a gadget item yet (parallel development),
 * the gadget is allowed through so the system stays testable.
 */
export function consumeItem(sys: GadgetSystem, def: GadgetDef): boolean {
  const inv = sys.ctx.inventory;
  const defId = sys.itemDefIdFor(def.id);
  if (!inv || !defId) return true;
  if (typeof inv.consumeDef === 'function') return inv.consumeDef(defId, 1);
  return inv.consumeWhere((d) => d.id === defId, 1) > 0;
  }

export function findDownedAlly(sys: GadgetSystem, radius: number): { id: PeerId; position: THREE.Vector3; name: string } | null {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return null;
  let best: { id: PeerId; position: THREE.Vector3; name: string } | null = null;
  let bestD = radius * radius;
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.isDowned || r.stale) continue;
    const dist = r.position.distanceToSquared(p.position);
    if (dist <= bestD) { bestD = dist; best = { id: r.id, position: r.position, name: r.name }; }
  }
  return best;
  }

export function deny(sys: GadgetSystem, text: string | null): false {
  if (text) {
    sys.ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
  }
  return false;
  }
