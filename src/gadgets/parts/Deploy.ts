/**
 * src/gadgets/parts/Deploy.ts — **placing gadgets and recovering them**.
 *
 * Deployables are **host-authoritative**: a client asks with `gadq` and the host confirms with `gad`.
 * The placement test, the recover / defuse hold and the item handed back are this file's range.
 */
import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_CLOAK_SHARE_RADIUS, Keys,
  type BuffMessage, type GadgetDef, type GadgetId, type GameContext,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost,
} from '@/shared';
import { gadgetDef, gadgetForKind, isRecoverable } from '../GadgetDefs';
/* 2026-09-15: the internal gadget (the fire zone `incendiary` — no item) · deployable ids · the fire sound */
import { deployableIdFor, isInternalGadget } from '../GadgetDefs';
import { FIRE_ZONE_CRACKLE_S, THUMPER_INTERVAL_S } from '@/shared';
import { Deployable } from '../Deployable';
import { MAX_DEPLOYABLES, RECOVER_RADIUS, USE_COOLDOWN, _a, _b, _c, toTuple } from '../model';
import type { GadgetSystem } from '../GadgetSystem';
import { droneKindOfGadget } from '@/shared';
import * as Preview from './Preview';
import * as Mount from './Mount';

/**
 * What the defib raises. 2026-09-15 (android squadmates): `ally` was added — true means a downed **android**, so it
 * goes through `AlliesRef.requestRevive` instead of `buff revive`. Omitted · false is the same human squadmate as
 * before.
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
  // 2026-09-15: the internal def (the fire zone `incendiary`) has no item, so `consumeItem` would let it through
  // consuming nothing — the one way to light it is `igniteGrenadeFire`
  if (!def || isInternalGadget(id)) return false;
  const player = ctx.player;
  // usable from the quick bar with the inventory open, but never in the hub / menus / while paused
  if (!ctx.isGameplayPhase() || ctx.uiBlockers.has('menu')) return sys.deny(null);
  if (!player || player.isDead || player.isDowned) return sys.deny(null);
  if (sys.useCooldown > 0) return false;

  // 2026-09-11: a drone consumes no item — the quick-slot item stays in hand as the controller (shared/drones).
  // `drones` takes one away when the drone is destroyed.
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
  // 2026-09-11: a `place` gadget re-runs **the same test** as the preview at that moment (parts/Preview) — red
  // refuses it for the same reason
  if (def.use === 'place') {
    // The detonator hand (after the last C4 was placed) places nothing — right-click detonation only (weapons'
    // `remoteState.detonator`)
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
  // 2026-09-15 (user's decision): a gadget whose item carries the durability (`돔 실드` · barricade) stands up with
  // **the durability left on the very item just used** — the value `consumeItem` wrote down
  // (`lastConsumedDurability`, otherwise `undefined` = a new one).
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
    // Androids are simulated by allies/ — the authority raises it straight away, anyone else goes to the host
    // with `allyq revive {defib}`
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
  /* 2026-09-21: raising a body we were carrying puts it down first — `validateCarry` would notice on its own once
   * their snapshot says they are up, but that is a round trip away and the shoulder pose would flicker. `'revived'`
   * is the existing reason for exactly this end, and it releases immediately (only `'manual'` plays the put-down). */
  if (ctx.player && (ctx.player.carrying ?? null) === target.id) ctx.player.dropCarried('revived');
  sys.visuals.pulse(target.position, def.color, 0.4, 3.2, 0.6);
  ctx.bus.emit('audio:play', { id: 'gadget_defib', position: target.position, volume: 0.9 });
  ctx.bus.emit('ui:notify', { text: `${target.name} 부활`, kind: 'success', duration: 2 });
  ctx.bus.emit('chat:post', { text: `${target.name} 을(를) 일으켰다`, kind: 'system' });
  }

/**
 * @param startHp 2026-09-15: the durability left on a `wearsItemDurability` gadget — the canister carries it until
 *   it lands.
 */
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
 * 2026-09-15 (B-16): an incendiary grenade (`ItemDef.grenade === 'fire'`) went off at `position` — it stands up a
 * fire zone owned by the local player through **the same path** as `onThrownImpact` (`requestPlace`: the authority
 * spawns it at once · a client sends `gadq place {gadget:'incendiary'}`). The spawn takes the height down to the
 * surface under that point (`Queries.groundY`) — a grenade that goes off in the air still lights the ground. The
 * only caller is weapons' local explosion.
 *
 * 2026-09-15 (the gadget rework, user's decision): the fire zone defs were merged into the one `incendiary` (the
 * fire merge section of `GadgetDefs`) — the old internal def `grenadeFire` is gone, and only this function's name
 * stayed, because the name is the contract (`GadgetsRef.igniteGrenadeFire`).
 */
export function igniteGrenadeFire(sys: GadgetSystem, position: THREE.Vector3): void {
  const def = gadgetDef('incendiary');
  if (!def || !sys.ctx.world?.ready) return;
  sys.requestPlace(def, position, sys.ctx.player?.yaw ?? 0);
  }

/**
 * Authority spawns straight away; clients ask the host and wait for `gad spawn`.
 *
 * @param startHp 2026-09-15: the durability a `wearsItemDurability` gadget inherits — a non-host sends it too, as
 *   `gadq place`'s `hp` (added to the contract, 2026-09-15 2nd pass). The host **clamps that value to the item's
 *   `durabilityMax`** and stands it up with it (`spawnDeployable` after `Preview.resolveRemotePlace`) — omitted =
 *   a new one (an older client).
 */
export function requestPlace(sys: GadgetSystem, def: GadgetDef, position: THREE.Vector3, yaw: number, mount: string | null = null, startHp?: number): void {
  const ctx = sys.ctx;
  if (!def.deployable) return;
  if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
    // 2026-09-11: a drone mount request carries `mount` (the host re-checks it in `Preview.resolveRemotePlace`)
    ctx.net.send({
      t: 'gadq', ev: 'place', gadget: def.id, p: toTuple(position), yaw,
      ...(mount ? { mount } : {}),
      // 2026-09-15 2nd pass: a worn `돔 실드` · barricade must stand up that much weaker (the host clamps it to
      // `durabilityMax`)
      ...(def.wearsItemDurability && typeof startHp === 'number' && startHp > 0 ? { hp: Math.round(startHp) } : {}),
    }, 'host');
    return;
  }
  sys.spawnDeployable(sys.nextId(def.id), def, ctx.net?.localId ?? 'local', position, yaw, null, mount, startHp);
  }

/* ═══════════════════════════ spawn / remove ═══════════════════════════ */
/**
 * The deployable id. `gadget` no longer shapes it: the 2026-09-15 fire merge left one definition producing `fire`,
 * so the old `-gf` mark is retired and a replica finds the definition by `kind` alone
 * (`GadgetDefs.deployableIdFor` · `defForWire`). The argument is kept so the call sites stay as they are.
 */
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

  // 2026-09-15 (user's decision): with `wearsItemDurability` the max hp is **the item's `durabilityMax`**, not
  // `GadgetDef.hp`. A replica always takes the wire as it is (`maxHp` is already on it), so this branch only runs on
  // the authority · in single-player.
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
  // 2026-09-15 (the thumper): a replica starts from the age the host sent, so the hammer beat (a 1 s cycle)
  // matches — a late joiner's `gad sync` is the same
  if (wire && typeof wire.age === 'number' && wire.age > 0) { d.age = wire.age; d.strikes = Math.floor(wire.age / THUMPER_INTERVAL_S); }
  // 2026-09-11: a `place` gadget keeps the height the placement test gave it (the surface · a building floor · a
  // drone's top face), and a replica keeps the height the host decided. The only thing taken down to the ground is a
  // thrown gadget (dome · smoke · fire · lure), and only when the authority first spawns it.
  if (!wire && def.use !== 'place') d.position.y = sys.groundY(position);
  d.yaw = yaw;
  d.headYaw = yaw;
  d.onDamage = (dep, amount, from) => sys.onDeployableDamage(dep, amount, from);
  // 2026-09-11 (parts/Mount): on a drone — a replica takes the wire's `mount`, the authority the request's
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
  // 2026-09-11: for a remote mine `parts/Remote` plays `c4_place` on the first frame — this path stays silent
  // 2026-09-15 (B-16): a fire zone gets the ignition sound — every time one appears on this client (replicas
  // included, not gated on the wire). The crackle is `Simulate.animate`.
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
  if (d.mount) Mount.unmount(d);   // 2026-09-11: clears the mount mark
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
  // 2026-09-15 (user's decision): the `돔 실드` · barricade come back with **the durability worn down by what they
  // took** — they are strong again only after a repair at the ship's gear workbench, and the salvage yield rides the
  // 「craft materials × five 20 % buckets of remaining durability」 rule (2026-09-10) unchanged.
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
 * 2026-09-11: the fixed spot straight ahead of the player was taken out — this is a thin wrapper around the
 * aim-point test (`Preview.computePlacement`). 2026-09-19: its constant (`model.PLACE_DISTANCE`) is gone too.
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
  // 2026-09-15 (user's decision): a gadget that carries durability has to know **which stack was taken** (it stands
  // up with that remaining durability). `consumeWhere`'s predicate sees the candidates in the order they will be
  // taken, so the first candidate is the one that goes — these items have `stackMax` 1, so the 「smallest quantity
  // first」 sort does not change that order (and the bag → pouch → wheel order of the passes stands too).
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
 * 2026-09-15 (user's decision): the max hp of a `wearsItemDurability` gadget — **that item's
 * `ItemDef.durabilityMax`**. With no item yet (parallel development), or a def that carries no durability, it falls
 * back to `GadgetDef.hp`.
 */
export function itemDurabilityMaxFor(sys: GadgetSystem, def: GadgetDef): number {
  const defId = sys.itemDefIdFor(def.id);
  const loot = sys.ctx.loot;
  const max = defId && loot ? loot.getItemDef(defId)?.durabilityMax ?? 0 : 0;
  return max > 0 ? max : def.hp;
  }

/**
 * The squadmate the defib raises.
 *
 * 2026-09-15 (user's decision): it picks the squadmate at **the smallest angle from the aim ray**, not the nearest
 * one — the new control is 「크로스헤어를 대상에 가져다 대고 좌클릭을 둔다」, so with two of them down inside the
 * range, raising the near one instead of the one being aimed at would be a lie. **Whether it is aimed at** (the
 * half-angle `DEFIB_AIM_CONE_DEG`) is judged from the crosshair by `weapons/parts/Defib`, and only 「which
 * squadmate」 is decided here — which is why the two places point at the same one. With no aim ray (an older call)
 * the old nearest-one rule applies.
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
  /** `onShoulder` = the body hangs on **our own** shoulder — it always wins (see the loop below). */
  const consider = (id: PeerId, position: THREE.Vector3, name: string, ally: boolean, onShoulder = false): void => {
    const dist = position.distanceToSquared(p.position);
    if (dist > r2) return;
    let score = dist;
    if (onShoulder) score = -Infinity;
    else if (aimed) {
      _c.copy(position); _c.y += DEFIB_CHEST_Y; _c.sub(_a);
      const len = _c.length();
      score = len < 1e-3 ? -1 : -(_c.dot(_b) / len);   // smaller angle (bigger cosine) = smaller score
    }
    if (score < bestScore) { bestScore = score; best = { id, position, name, ally }; }
  };
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.isDowned || r.stale) continue;
    /* 2026-09-21 (user's decision — 「업힌 사람에게도 제세동기가 통해야 한다」). A shouldered body's own
     * `position` is a stale snapshot (the contract: `RemotePlayerRef.isCarried` says to ignore it), so it used to
     * sit wherever it was picked up — metres behind the carrier, out of the 5 m range and off the crosshair. The
     * carrier's position stands in for it instead, exactly as `RemotePlayerSystem.syncRevive` does for the revive
     * prompt. And a body on **our own** shoulder cannot be aimed at at all — nobody puts the crosshair on their
     * own back — so it is treated as aimed outright (`onShoulder`); `useDefib` puts it down as it raises it. */
    const carrier = carrierPositionOf(ctx, r.id);
    consider(r.id, carrier ? carrier.position : r.position, r.name, false, carrier?.mine === true);
  }
  /* 2026-09-15 (android squadmates, the other direction of the user's decision 「제세동기가 있으면 안전상태가
   * 아니어도 시도한다」): a downed **android** is aimed at with the same range and the same aim score as a person.
   * Only the path that raises it differs — `buff revive` for a person, and for an android
   * `AlliesRef.requestRevive(id, {defib:true})` (`useDefib`). */
  for (const b of ctx.allies?.getBodies?.() ?? []) {
    if (!b.downed || b.dead || b.hidden || b.mode !== 'raid') continue;
    consider(b.id, b.position, b.name, true);
  }
  return best;
  }

/** The 「chest」 height `findDownedAlly`'s aim test uses — the same value as `CHEST_Y` in `weapons/parts/Defib`. */
const DEFIB_CHEST_Y = 1.15;

/**
 * Who is carrying `id` right now and where they stand (2026-09-21), or null when nobody is. `mine` = it is **our**
 * shoulder. Three carriers are possible and all three expose a stable `position` vector, so this allocates nothing:
 * the local player (`PlayerRef.carrying`), another peer (`RemotePlayerRef.carrying`, derived `carriedBy`) and an
 * android (`AlliesRef.carrierOf`).
 *
 * `weapons/parts/Defib.hasAimedAlly` runs the same lookup — the two files already duplicate the chest height and
 * the cone test on purpose (they must never disagree about the same body), and a shared home for it would mean a
 * new `src/shared` module, which is a contract change nobody asked for. Change one, change the other.
 */
function carrierPositionOf(ctx: GameContext, id: PeerId): Carrier | null {
  const me = ctx.player;
  if (me && (me.carrying ?? null) === id) return carrier(me.position, true);
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (r.id === id) { if (r.carriedBy) { const c = ctx.net?.getRemotePlayer(r.carriedBy); if (c) return carrier(c.position, false); } continue; }
    if (r.carrying === id) return carrier(r.position, false);
  }
  const android = ctx.allies?.carrierOf?.(id) ?? null;
  return android ? carrier(android.position, false) : null;
}

/** Reused result — `findDownedAlly` is polled while the defibrillator is in hand, so the lookup allocates nothing. */
interface Carrier { position: THREE.Vector3; mine: boolean }
const _carrier: Carrier = { position: new THREE.Vector3(), mine: false };
function carrier(position: THREE.Vector3, mine: boolean): Carrier {
  _carrier.position = position; _carrier.mine = mine;
  return _carrier;
}

export function deny(sys: GadgetSystem, text: string | null): false {
  if (text) {
    sys.ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 });
    sys.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
  }
  return false;
  }
