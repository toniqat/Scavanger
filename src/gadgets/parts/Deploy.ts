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
/* 2026-09-15: 내부 가젯(화염 지대 `incendiary` — 아이템 없음) · 배치물 id · 화염 소리 */
import { deployableIdFor, isInternalGadget } from '../GadgetDefs';
import { FIRE_ZONE_CRACKLE_S, THUMPER_INTERVAL_S } from '@/shared';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from '../Deployable';
import { GadgetVisualPool } from '../GadgetVisuals';
import { ThrownGadgetManager } from '../ThrownGadget';
import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';
import { droneKindOfGadget } from '@/shared';
import * as Preview from './Preview';
import * as Mount from './Mount';

/**
 * 제세동기가 일으킬 대상. 2026-09-15 (안드로이드 분대원): `ally` 가 붙었다 — true 면 쓰러진 **안드로이드**라
 * `buff revive` 가 아니라 `AlliesRef.requestRevive` 로 간다. 생략 · false 는 지금까지와 똑같은 사람 분대원이다.
 */
export interface DefibTarget {
  id: PeerId;
  position: THREE.Vector3;
  name: string;
  ally?: boolean;
}

export function use(sys: GadgetSystem, id: GadgetId, underhand?: boolean): boolean {
  const ctx = sys.ctx;
  const def = gadgetDef(id);
  // 2026-09-15: 내부 정의(화염 지대 `incendiary`)는 아이템이 없어 `consumeItem` 이 소모 없이 통과시킨다 — 쓰는 길은 `igniteGrenadeFire` 하나
  if (!def || isInternalGadget(id)) return false;
  const player = ctx.player;
  // usable from the quick bar with the inventory open, but never in the hub / menus / while paused
  if (!ctx.isGameplayPhase() || ctx.uiBlockers.has('menu')) return sys.deny(null);
  if (!player || player.isDead || player.isDowned) return sys.deny(null);
  if (sys.useCooldown > 0) return false;

  // 2026-09-11: 드론은 아이템을 소모하지 않는다 — 퀵슬롯의 그 아이템이 조종기로 남는다 (shared/drones). 파괴될 때 drones 가 하나 뺀다.
  if (def.use === 'drone') {
    const kind = droneKindOfGadget(def.id);
    if (!kind || !ctx.drones) return sys.deny('드론을 사용할 수 없다');
    if (!ctx.drones.deploy(kind)) return false;
    sys.useCooldown = USE_COOLDOWN / Math.max(0.25, sys.derived('useSpeedMul', 1));
    ctx.bus.emit('gadget:used', { id, position: player.position.clone() });
    return true;
  }

  // validate before consuming the item
  let target: DefibTarget | null = null;
  // 2026-09-11: 설치형은 미리보기와 **같은 판정**을 그 순간 다시 돌린다 (parts/Preview) — 빨강이면 같은 사유로 거부
  if (def.use === 'place') {
    // 기폭기 손(마지막 C4 를 놓은 뒤)에서는 설치하지 않는다 — 우클릭 기폭만 (weapons 의 `remoteState.detonator`)
    if (Preview.isDetonatorHand(ctx)) return sys.deny(null);
    const spot = Preview.computePlacement(sys, def, sys.placeUse);
    if (!spot.valid) return sys.deny(spot.reason ?? '설치할 공간이 없다');
  }
  if (def.use === 'target') {
    target = sys.findDownedAlly(def.radius);
    if (!target) return sys.deny('근처에 쓰러진 아군이 없다');
  }
  if (!sys.consumeItem(def)) return sys.deny(`${def.name} 없음`);

  sys.useCooldown = USE_COOLDOWN / Math.max(0.25, sys.derived('useSpeedMul', 1));
  const over = underhand === undefined ? sys.underhand : underhand;
  // 2026-09-15 (사용자 결정): 내구도를 아이템이 들고 다니는 가젯(돔 실드 · 바리케이드)은 **방금 쓴 그 아이템의 남은
  // 내구도**로 선다 — `consumeItem` 이 적어 둔 값 (`lastConsumedDurability`, 아니면 `undefined` = 새것).
  const startHp = def.wearsItemDurability ? sys.lastConsumedDurability : undefined;
  switch (def.use) {
    case 'self': sys.useCloakVeil(def); break;
    case 'target': if (target) sys.useDefib(def, target); break;
    case 'throw': sys.throwGadget(def, over, startHp); break;
    case 'place': sys.requestPlace(def, sys.placeUse.position, sys.placeUse.yaw, sys.placeUse.mount, startHp); break;
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

export function useDefib(sys: GadgetSystem, def: GadgetDef, target: DefibTarget): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (target.ally) {
    // 안드로이드는 allies/ 가 굴린다 — 권위면 바로 세우고, 아니면 `allyq revive {defib}` 로 호스트에게 간다
    ctx.allies?.requestRevive?.(target.id, { defib: true });
  } else {
    const msg: BuffMessage = {
      t: 'buff', kind: 'revive',
      amount: ctx.player?.maxHp ?? 100,
      duration: 0,
      by: net?.playerName ?? '아군',
    };
    net?.send(msg, target.id);
  }
  sys.visuals.pulse(target.position, def.color, 0.4, 3.2, 0.6);
  ctx.bus.emit('audio:play', { id: 'gadget_defib', position: target.position, volume: 0.9 });
  ctx.bus.emit('ui:notify', { text: `${target.name} 부활`, kind: 'success', duration: 2 });
  ctx.bus.emit('chat:post', { text: `${target.name} 을(를) 일으켰다`, kind: 'system' });
  }

/** @param startHp 2026-09-15: `wearsItemDurability` 가젯이 실려 나가는 남은 내구도 (통이 땅에 닿을 때까지 들고 간다). */
export function throwGadget(sys: GadgetSystem, def: GadgetDef, underhand: boolean, startHp?: number): void {
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
  sys.thrown.throw(def.id, def.color, _a, _c, startHp);
  ctx.bus.emit('audio:play', { id: 'grenade_throw', position: _a, volume: 0.65 });
  }

export function onThrownImpact(sys: GadgetSystem, gid: GadgetId, pos: THREE.Vector3, startHp?: number): void {
  const def = gadgetDef(gid);
  if (!def || !def.deployable) return;
  const yaw = sys.ctx.player?.yaw ?? 0;
  sys.requestPlace(def, pos, yaw, null, startHp);
  }

/**
 * 2026-09-15 (B-16): 화염 수류탄(`ItemDef.grenade === 'fire'`)이 `position` 에서 터졌다 — `onThrownImpact` 와 **같은 길**
 * (`requestPlace`: 권위자는 즉시 스폰 · 클라는 `gadq place {gadget:'incendiary'}`)로 로컬 플레이어 소유의 화염 지대를 세운다.
 * 높이는 스폰이 그 점 아래 표면으로 내린다(`Queries.groundY`) — 공중에서 터져도 바닥에 불이 붙는다. 부르는 곳은 weapons 의 로컬 폭발뿐.
 *
 * 2026-09-15 (가젯 개편, 사용자 결정): 화염 지대 정의가 `incendiary` 하나로 합쳐졌다 (`GadgetDefs` 의 「화염 통합」 절) —
 * 옛 내부 정의 `grenadeFire` 는 없어졌고 이 함수 이름만 계약(`GadgetsRef.igniteGrenadeFire`)이라 그대로다.
 */
export function igniteGrenadeFire(sys: GadgetSystem, position: THREE.Vector3): void {
  const def = gadgetDef('incendiary');
  if (!def || !sys.ctx.world?.ready) return;
  sys.requestPlace(def, position, sys.ctx.player?.yaw ?? 0);
  }

/**
 * Authority spawns straight away; clients ask the host and wait for `gad spawn`.
 *
 * @param startHp 2026-09-15: `wearsItemDurability` 가젯이 물려받는 남은 내구도 — 비호스트도 `gadq place` 의
 *   `hp` 로 실어 보낸다(계약 추가, 2026-09-15 2차). 호스트는 그 값을 **아이템의 `durabilityMax` 로 클램프**해
 *   그대로 세운다(`Preview.resolveRemotePlace` 뒤 `spawnDeployable`) — 생략 = 새것이다(옛 클라이언트).
 */
export function requestPlace(sys: GadgetSystem, def: GadgetDef, position: THREE.Vector3, yaw: number, mount: string | null = null, startHp?: number): void {
  const ctx = sys.ctx;
  if (!def.deployable) return;
  if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
    // 2026-09-11: 드론 위에 올리는 요청이면 `mount` (호스트가 `Preview.resolveRemotePlace` 로 다시 본다)
    ctx.net.send({
      t: 'gadq', ev: 'place', gadget: def.id, p: toTuple(position), yaw,
      ...(mount ? { mount } : {}),
      // 2026-09-15 2차: 깎인 돔 실드 · 바리케이드는 그만큼 약하게 서야 한다 (호스트가 `durabilityMax` 로 클램프한다)
      ...(def.wearsItemDurability && typeof startHp === 'number' && startHp > 0 ? { hp: Math.round(startHp) } : {}),
    }, 'host');
    return;
  }
  sys.spawnDeployable(sys.nextId(def.id), def, ctx.net?.localId ?? 'local', position, yaw, null, mount, startHp);
  }

/* ═══════════════════════════ spawn / remove ═══════════════════════════ */
/** 2026-09-15 (B-16): `gadget` 이 G-10 화염 지대면 id 에 `-gf` 표식 (`GadgetDefs.deployableIdFor` — 복제본이 정의를 되찾는 열쇠). */
export function nextId(sys: GadgetSystem, gadget?: GadgetId): string {
  return deployableIdFor(sys.ctx.net?.localId ?? 'sp', ++sys.seq, gadget);
  }

/**
 * @param wire non-null when this is a replica built from a `gad spawn` / `gad sync` broadcast
 *   (hp / armed / ttl come from the host instead of the definition).
 */
export function spawnDeployable(sys: GadgetSystem, id: string, def: GadgetDef, owner: PeerId | 'local', position: THREE.Vector3, yaw: number, wire: DeployableWire | null, mount?: string | null, startHp?: number): Deployable | null {
  const kind = def.deployable;
  if (!kind || sys.byId.has(id)) return null;
  const ctx = sys.ctx;
  while (sys.deployables.length >= MAX_DEPLOYABLES) sys.removeLocal(sys.deployables[0], 'expired');

  // 2026-09-15 (사용자 결정): `wearsItemDurability` 면 최대 hp 가 `GadgetDef.hp` 가 아니라 **그 아이템의 `durabilityMax`** 다.
  // 복제본은 늘 와이어(`maxHp` 가 이미 실려 있다)를 그대로 쓰므로 이 갈래는 권위자 · 싱글에서만 돌다.
  const defMax = def.wearsItemDurability ? itemDurabilityMaxFor(sys, def) : def.hp;
  const maxHp = wire ? wire.maxHp : defMax;
  const hp = wire ? wire.hp : (def.wearsItemDurability && typeof startHp === 'number' && startHp > 0
    ? Math.min(defMax, Math.round(startHp)) : defMax);
  const armed = wire ? wire.armed : !(kind === 'mine' || kind === 'domeShield' || kind === 'remoteMine');
  const ttl = wire ? wire.ttl : def.duration;
  const expires = ttl > 0 ? ctx.time + ttl : 0;

  const visual = sys.visuals.acquire(kind, def.color, def.radius);
  const d = new Deployable(id, kind, owner, def.id, def.radius, hp, maxHp, armed, expires, visual);
  d.position.copy(position);
  // 2026-09-15 (진동 장치): 복제본은 호스트가 실어 보낸 나이로 시작해 망치 박자(1 초 주기)가 맞는다 — 늦은 합류자의 `gad sync` 도 같다
  if (wire && typeof wire.age === 'number' && wire.age > 0) { d.age = wire.age; d.strikes = Math.floor(wire.age / THUMPER_INTERVAL_S); }
  // 2026-09-11: 설치형(place)은 미리보기 판정이 준 높이(표면 · 건물 바닥 · 드론 윗면)를, 복제본은 호스트가 정한 높이를
  // 그대로 쓴다. 지형으로 내리는 것은 투척형(돔 · 연막 · 화염 · 유인)을 권위자가 처음 스폰할 때뿐이다.
  if (!wire && def.use !== 'place') d.position.y = sys.groundY(position);
  d.yaw = yaw;
  d.headYaw = yaw;
  d.onDamage = (dep, amount, from) => sys.onDeployableDamage(dep, amount, from);
  // 2026-09-11 (parts/Mount): 드론 위 — 복제본은 와이어의 `mount`, 권위자는 요청의 `mount`
  const mountId = wire ? (wire.mount ?? null) : (mount ?? null);
  if (mountId) Mount.attach(sys, d, mountId);
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
  // 2026-09-11: 원격 지뢰는 `parts/Remote` 가 첫 프레임에 `c4_place` 를 낸다 — 여기서는 조용히
  // 2026-09-15 (B-16): 화염 지대는 불붙는 소리 — 이 클라이언트에 생길 때마다 (복제본 포함, 와이어 없음). 지지직은 `Simulate.animate`.
  if (kind === 'fire') {
    d.crackleTimer = FIRE_ZONE_CRACKLE_S;
    ctx.bus.emit('audio:play', { id: 'fire_ignite', position: d.position, volume: 0.9 });
  } else if (kind !== 'remoteMine') ctx.bus.emit('audio:play', { id: kind === 'mine' ? 'mine_place' : 'gadget_deploy', position: d.position, volume: 0.8 });
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
  if (d.mount) Mount.unmount(sys, d);   // 2026-09-11: 드론 쪽 탑재 표시를 지운다
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
  // 2026-09-15 (사용자 결정): 돔 실드 · 바리케이드는 **까인 만큼 내구도가 닳아서** 돌아온다 — 함선 장비 작업대에서
  // 고쳐야 다시 튼튼해지고, 분해 산출도 「제작 재료 × 남은 내구도 20 % 5구간」(2026-09-10)에 그대로 올라탄다.
  if (gadgetDef(d.gadgetId)?.wearsItemDurability) {
    const max = loot.getItemDef(defId)?.durabilityMax ?? 0;
    if (max > 0) item.durability = Math.max(0, Math.min(max, Math.round(d.hp)));
  }
  const ok = sys.ctx.inventory?.tryAddItem(item) ?? false;
  if (!ok) return null;   // inventory already emitted `inventory:full`; the deployable is removed anyway
  sys.ctx.bus.emit('gadget:recovered', { id: d.id, item });
  sys.ctx.bus.emit('audio:play', { id: 'gadget_recover', position: d.position, volume: 0.7 });
  return item;
  }

/**
 * Spot for a 'place' gadget. false when it is blocked / off the map.
 * 2026-09-11: 정면 2.8 m 고정 자리는 걷어냈다 — 조준점 판정(`Preview.computePlacement`)의 얇은 포장이다.
 */
export function placementSpot(sys: GadgetSystem, def: GadgetDef, out: THREE.Vector3): boolean {
  const spot = Preview.computePlacement(sys, def, sys.placeUse);
  out.copy(spot.position);
  return spot.valid;
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
  sys.lastConsumedDurability = undefined;
  if (!inv || !defId) return true;
  // 2026-09-15 (사용자 결정): 내구도를 들고 다니는 가젯은 **어느 스택이 빠졌는지**를 알아야 한다 (그 남은 내구도로 선다).
  // `consumeWhere` 의 술어는 빠질 후보를 순서대로 보므로 첫 후보가 곰 빠지는 것이다 — 이 아이템들은 `stackMax` 1 이라
  // 「수량이 작은 것 먼저」 정렬이 순서를 바꾸지 않는다 (가방 → 주머니 → 휠 단계 순서도 그대로).
  if (def.wearsItemDurability) {
    let first: number | undefined;
    const n = inv.consumeWhere((d, inst) => {
      if (d.id !== defId) return false;
      if (first === undefined) first = inst.durability;
      return true;
    }, 1);
    if (n <= 0) return false;
    sys.lastConsumedDurability = first;
    return true;
  }
  if (typeof inv.consumeDef === 'function') return inv.consumeDef(defId, 1);
  return inv.consumeWhere((d) => d.id === defId, 1) > 0;
  }

/**
 * 2026-09-15 (사용자 결정): `wearsItemDurability` 가젯의 최대 hp — **그 아이템의 `ItemDef.durabilityMax`**.
 * 아이템이 아직 없거나(병렬 개발) 내구도가 없는 정의면 `GadgetDef.hp` 로 돌아간다.
 */
export function itemDurabilityMaxFor(sys: GadgetSystem, def: GadgetDef): number {
  const defId = sys.itemDefIdFor(def.id);
  const loot = sys.ctx.loot;
  const max = defId && loot ? loot.getItemDef(defId)?.durabilityMax ?? 0 : 0;
  return max > 0 ? max : def.hp;
  }

/**
 * 제세동기가 일으킬 아군.
 *
 * 2026-09-15 (사용자 결정): 거리가 아니라 **조준 광선에서 각이 가장 작은** 아군을 고른다 — 새 조작이 「크로스헤어를
 * 대상에 가져다 대고 좌클릭을 둔다」 라서, 사거리 안에 둘이 쓰러져 있을 때 견눈 쪽이 아니라 가까운 쪽을 일으키면
 * 거짓말이 된다. **견눴는지**(반각 `DEFIB_AIM_CONE_DEG`)는 `weapons/parts/Defib` 이 크로스헤어에서 판정하고, 여기서는
 * 「어느 아군인가」만 정한다 — 그래서 두 곳이 같은 아군을 가리킨다. 조준 광선이 없으면(구식 호출) 옛 최근접 규칙.
 */
export function findDownedAlly(sys: GadgetSystem, radius: number): DefibTarget | null {
  const ctx = sys.ctx;
  const p = ctx.player;
  if (!p) return null;
  const host = p as unknown as Partial<PlayerWeaponHost>;
  const aimed = typeof host.getAimRay === 'function';
  if (aimed) { host.getAimRay!(_a, _b); _b.normalize(); }
  let best: DefibTarget | null = null;
  let bestScore = Infinity;
  const r2 = radius * radius;
  const consider = (id: PeerId, position: THREE.Vector3, name: string, ally: boolean): void => {
    const dist = position.distanceToSquared(p.position);
    if (dist > r2) return;
    let score = dist;
    if (aimed) {
      _c.copy(position); _c.y += DEFIB_CHEST_Y; _c.sub(_a);
      const len = _c.length();
      score = len < 1e-3 ? -1 : -(_c.dot(_b) / len);   // 각이 작을수록(코사인이 클수록) 작은 점수
    }
    if (score < bestScore) { bestScore = score; best = { id, position, name, ally }; }
  };
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.isDowned || r.stale) continue;
    consider(r.id, r.position, r.name, false);
  }
  /* 2026-09-15 (안드로이드 분대원, 사용자 결정 「제세동기가 있으면 안전상태가 아니어도 시도한다」의 역방향):
   * 쓰러진 **안드로이드**도 사람과 같은 사거리 · 같은 조준 점수로 겨눠진다. 일으키는 길만 다르다 —
   * 사람은 `buff revive`, 안드로이드는 `AlliesRef.requestRevive(id, {defib:true})` (`useDefib`). */
  for (const b of ctx.allies?.getBodies?.() ?? []) {
    if (!b.downed || b.dead || b.hidden || b.mode !== 'raid') continue;
    consider(b.id, b.position, b.name, true);
  }
  return best;
  }

/** `findDownedAlly` 의 조준 판정이 쓰는 「가슴」 높이 — `weapons/parts/Defib` 의 `CHEST_Y` 와 같은 값이다. */
const DEFIB_CHEST_Y = 1.15;

export function deny(sys: GadgetSystem, text: string | null): false {
  if (text) {
    sys.ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
  }
  return false;
  }
