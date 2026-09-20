import * as THREE from 'three';
import {
  PROP_STEP_UP_MAX,
  PICKUP_SEPARATION_M, PICKUP_SPOT_RINGS, PICKUP_SPOT_STEP_M,
  GRAVITY, PICKUP_LIFETIME, PICKUP_MAX, normalizeMealQuality,
  type GameContext, type GameSystem, type Interactable, type ItemDef, type ItemInstance, type PickupRef, type PickupsRef,
  type ItemMessage, type ItemRequest, type FlowMessage, type PickupWire, type PeerId, type Vec3Tuple, type ItemInstanceExtras,
} from '@/shared';
import { PickupVisualPool, restHeightFor, type PickupVisual } from './PickupVisuals';

/** Interaction radius (m). */
const TAKE_RADIUS = 2.2;
/** Collider radius used against obstacles while tossed. */
const BODY_R = 0.18;
/** Below this speed a landed pickup stops moving. */
const REST_SPEED_SQ = 0.15;
/** A client's `itemq take` is not repeated for this long (s). */
const TAKE_REQUEST_COOLDOWN = 1.0;
/** Clients drop optimistic spawns that the host never echoed after this long (s). */
const OPTIMISTIC_TIMEOUT = 4.0;

class Pickup implements PickupRef {
  readonly position = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly spin = new THREE.Vector3();
  /**
   * 2026-09-21: where this body is expected to come to rest — the ballistic guess while it is still flying, the real
   * spot once it has settled. Only the free-spot search reads it, and it must: a whole bagful is dropped in **one
   * frame**, so every earlier body is still sitting at the shared spawn point and comparing against `position` would
   * find the ground clear for all of them.
   */
  readonly restSpot = new THREE.Vector3();
  resting = false;
  age = 0;
  /** Client: awaiting the host's echo of our own drop. */
  optimistic = false;
  /** Client: `itemq take` sent, waiting for `item take`. */
  takeRequestedAt = -Infinity;
  interactable: Interactable | null = null;
  constructor(readonly id: string, readonly item: ItemInstance, readonly def: ItemDef, readonly visual: PickupVisual) {}
  get object(): THREE.Object3D { return this.visual.root; }
}

const _n = new THREE.Vector3(), _tmp = new THREE.Vector3(), _v = new THREE.Vector3();
// 2026-09-21 (free-spot search): own scratch objects — `_tmp` / `_v` are live across `onLocalDrop` (the bag-full re-drop
// hands them straight in), so the search may not borrow them. No allocation on any path (CLAUDE.md §4.1).
const _spot = new THREE.Vector3(), _land = new THREE.Vector3(), _probe = new THREE.Vector3();

function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/** Per-instance weapon state (durability / loaded rounds / sockets) that must survive the trip over the wire. */
function extrasOf(item: ItemInstance): ItemInstanceExtras | null {
  if (item.durability === undefined && item.ammoInMag === undefined && !item.sockets) return null;
  const ex: ItemInstanceExtras = {};
  if (item.durability !== undefined) ex.durability = item.durability;
  if (item.ammoInMag !== undefined) ex.ammoInMag = item.ammoInMag;
  if (item.sockets && Object.keys(item.sockets).length > 0) ex.sockets = item.sockets;
  return ex;
}

/**
 * World item pickups (dropped items lying on the ground). Publishes `ctx.pickups`.
 *
 * - `inventory:itemDropped` → toss arc (gravity, terrain landing, obstacle push-out), then rests with a pulse + beam.
 * - Each pickup registers an `Interactable` (E, 2.2 m): "<name> ×n 줍기" → `inventory.tryAddItem`.
 * - Multiplayer is host-authoritative: clients send `itemq drop/take/sync`, the host answers with `item drop/take/sync`.
 *   Ids are `${peerId|'sp'}-${n}`; a client proposes its own id for a drop and the host keeps it, so the optimistic
 *   local spawn and the echo dedupe by id.
 * - Emits `pickup:spawned` / `pickup:taken` / `pickup:removed` (removed fires for every removal, taken included).
 */
export class PickupSystem implements GameSystem, PickupsRef {
  readonly name = 'pickups';
  private ctx!: GameContext;
  private readonly visuals = new PickupVisualPool();
  private readonly pickups: Pickup[] = [];
  private readonly byId = new Map<string, Pickup>();
  private seq = 0;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];

  /* ─────────────────────────── PickupsRef ─────────────────────────── */
  getPickups(): readonly PickupRef[] { return this.pickups; }

  findNear(pos: THREE.Vector3, radius: number): PickupRef | null {
    let best: Pickup | null = null, bestD = radius * radius;
    for (const p of this.pickups) {
      const d = p.position.distanceToSquared(pos);
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** Local authority (solo / host) spawn. Assigns an id and replicates `item drop` to the others. */
  spawn(item: ItemInstance, position: THREE.Vector3, velocity?: THREE.Vector3): string {
    const id = this.nextId();
    // the free-spot search runs **here**, before `wireOf` reads the position, so the spot crosses the wire and
    // every peer holds the same one (2026-09-21 — see `freeSpotFor`)
    const p = this.spawnInternal(id, item, this.freeSpotFor(position, velocity ?? null), velocity ?? null, false);
    if (!p) return '';
    this.broadcast({ t: 'item', ev: 'drop', item: this.wireOf(p), v: velocity ? toTuple(velocity) : undefined }, 'others');
    return id;
  }

  /**
   * 2026-09-15 (android squadmates) — on the authority (solo · lobby host): a non-human body (`by` = an android
   * id) picks a ground item up. It is **the same** path as the host judging someone else's `itemq take`
   * (`onItemRequest`) — it removes the pickup and broadcasts `item take {id, by}`.
   * On the receiving side `by` is not their own PeerId, so it takes the 「someone else took it」 path unchanged (no
   * new branch appears).
   * Not the authority, or an unknown id → null.
   */
  takeBy(id: string, by: string): ItemInstance | null {
    const ctx = this.ctx;
    if (ctx.isMultiplayer && !ctx.isAuthority) return null;
    const p = this.byId.get(id);
    if (!p) return null;
    this.remove(p);
    const byName = ctx.net?.getLobbyPlayer?.(by as PeerId)?.name ?? null;
    ctx.bus.emit('pickup:taken', { id: p.id, item: p.item, byLocal: false, byName });
    this.broadcast({ t: 'item', ev: 'take', id: p.id, by: by as PeerId }, 'others');
    return p.item;
  }

  clear(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) this.remove(this.pickups[i]);
  }

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.pickups = this;
    ctx.scene.add(this.visuals.group);
    this.visuals.warm();
    const b = ctx.bus;
    this.unsubs.push(
      b.on('inventory:itemDropped', ({ item, position, velocity }) => this.onLocalDrop(item, position, velocity)),
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
      b.on('world:ready', () => {
        this.clear();
        // (re)joining client: ask the host for the current pickups
        const net = ctx.net;
        if (ctx.isMultiplayer && net && !net.isHost) net.send({ t: 'itemq', ev: 'sync' }, 'host');
      }),
      // Phase 9: a promoted host answers from its own mirror — every other member re-requests the pickup list
      b.on('net:hostChanged', ({ isLocalHost }) => {
        const net = ctx.net;
        if (isLocalHost || !ctx.isMultiplayer || !net || !ctx.world || !ctx.world.ready) return;
        net.send({ t: 'itemq', ev: 'sync' }, 'host');
      }),
    );
    this.ensureNetHooks();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (this.pickups.length === 0) return;
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const t = ctx.time;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (dt > 0) {
        p.age += dt;
        if (PICKUP_LIFETIME > 0 && p.age >= PICKUP_LIFETIME) { this.remove(p); continue; }
        if (p.optimistic && p.age > OPTIMISTIC_TIMEOUT && ctx.isMultiplayer) { this.remove(p); continue; }
        if (!p.resting) this.simulate(p, dt, world);
      }
      p.visual.root.position.copy(p.position);
      this.visuals.animate(p.visual, t, p.resting);
    }
  }

  dispose(): void {
    this.clear();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.visuals.dispose();
    if (this.ctx?.pickups === this) this.ctx.pickups = null;
  }

  /* ─────────────────────────── physics ─────────────────────────── */
  private simulate(p: Pickup, dt: number, world: NonNullable<GameContext['world']> | null): void {
    const rest = restHeightFor(p.def.category);
    if (!world) {
      // no terrain (hub / menu): settle where it is
      p.vel.set(0, 0, 0); this.settle(p); return;
    }
    p.vel.y -= GRAVITY * dt;
    p.position.addScaledVector(p.vel, dt);
    world.resolveCollision(p.position, BODY_R);
    if (!world.isInsideBounds(p.position.x, p.position.z)) { p.vel.x *= -0.5; p.vel.z *= -0.5; }
    // 2026-09-11: the ground is not the terrain but **the surface at that spot** — an item dropped on a building's
    // second floor · roof · stairs does not fall through the floor plate. Only a top up to a little above the
    // body's top is taken, so it never pops up onto a ceiling plate.
    const terrain = world.getHeightAt(p.position.x, p.position.z);
    const surface = world.getSurfaceY(p.position.x, p.position.z, p.position.y - rest + 0.25 - PROP_STEP_UP_MAX);
    const ground = surface + rest;
    if (p.position.y <= ground) {
      p.position.y = ground;
      if (surface > terrain + 0.02) _n.set(0, 1, 0); else world.getNormalAt(p.position.x, p.position.z, _n);
      const vn = p.vel.dot(_n);
      if (vn < 0) {
        p.vel.addScaledVector(_n, -vn * 1.25);   // small bounce
        p.vel.multiplyScalar(0.45);              // friction
      }
      p.spin.multiplyScalar(0.6);
      if (p.vel.lengthSq() < REST_SPEED_SQ) { p.vel.set(0, 0, 0); this.settle(p); return; }
    }
    // tumble while airborne
    const b = p.visual.body;
    b.rotation.x += p.spin.x * dt; b.rotation.y += p.spin.y * dt; b.rotation.z += p.spin.z * dt;
  }

  private settle(p: Pickup): void {
    p.resting = true;
    p.restSpot.copy(p.position);   // the guess is now a fact

    const b = p.visual.body;
    b.rotation.set(0, Math.random() * Math.PI * 2, 0);
    b.position.set(0, 0, 0);
  }

  /* ─────────────────────────── free-spot search ───────────────────────────
   *
   * 2026-09-21, user's decision 「생성 시 빈자리 탐색」. Dropping a bagful at once (a bag swap, a corpse strip) emits one
   * `inventory:itemDropped` per item in the same frame with the **same** position and the **same** velocity, so every
   * body flew the identical arc and the models merged into one blob.
   *
   * The spot is chosen **once, at spawn**, and never again: a per-frame separation pass would put a loop over every
   * resting pickup on a hot path for a purely cosmetic gain (CLAUDE.md §4.1). It is chosen on the peer that
   * *originates* the drop (`spawn` = the authority, the client branch of `onLocalDrop` = a client's own drop), i.e.
   * exactly where the pickup is decided today, and rides out on the position the existing `item drop` / `itemq drop`
   * already carries — no new message, and no replicated spawn (`item drop|sync` echo, `itemq drop` on the host)
   * searches again, because it must land on the position it was given.
   */

  /**
   * The spawn position for a new drop, moved just far enough that its body does not merge with one already lying
   * there. Rings out from the **guessed landing point** (`landingGuess`) — the offset that lands the item clear is
   * then applied to the spawn point, so the whole arc is translated and the physics is untouched.
   *
   * `PICKUP_SPOT_RINGS` rings, `PICKUP_SPOT_STEP_M` apart; a candidate is kept when it is `PICKUP_SEPARATION_M` from
   * every pickup, in bounds, on a surface within one step of the original one (so nothing is flicked off a balcony
   * or onto another floor) and not inside a collider. Every ring taken → the original spot, unchanged: **an item is
   * never lost.**
   *
   * The two csv numbers stay independent of each other: while `PICKUP_SPOT_STEP_M` is the shorter of the two, the
   * first ring simply cannot clear a blocker sitting on the spot and is walked and rejected (five distance tests).
   *
   * Returns a shared scratch vector; `spawnInternal` copies it.
   */
  private freeSpotFor(position: THREE.Vector3, velocity: THREE.Vector3 | null): THREE.Vector3 {
    _spot.copy(position);
    if (this.pickups.length === 0) return _spot;
    const world = this.ctx.world && this.ctx.world.ready ? this.ctx.world : null;
    this.landingGuess(position, velocity, world, _land);
    if (this.spotIsClear(_land.x, _land.z)) return _spot;
    // §4.4: the surface is asked for **before** any collision resolve, and with the drop's own feet height
    const baseY = world ? world.getSurfaceY(_land.x, _land.z, position.y) : 0;
    for (let ring = 1; ring <= PICKUP_SPOT_RINGS; ring++) {
      const r = ring * PICKUP_SPOT_STEP_M;
      // one candidate per `PICKUP_SEPARATION_M` of arc: the ring is sampled exactly as finely as the gap it must keep
      const n = Math.max(1, Math.round((2 * Math.PI * r) / PICKUP_SEPARATION_M));
      // half a step of twist per ring turns concentric rings into a spiral (no spokes). It is arithmetic, not a
      // random draw, so every peer that ever repeats this search walks the candidates in the same order.
      const a0 = (Math.PI / n) * ring;
      for (let i = 0; i < n; i++) {
        const a = a0 + (Math.PI * 2 * i) / n;
        const x = _land.x + Math.cos(a) * r, z = _land.z + Math.sin(a) * r;
        if (!this.spotIsClear(x, z)) continue;
        if (world && !this.spotIsGround(world, x, z, position.y, baseY)) continue;
        _spot.set(position.x + (x - _land.x), position.y, position.z + (z - _land.z));
        return _spot;
      }
    }
    return _spot;
  }

  /**
   * No pickup's resting spot within `PICKUP_SEPARATION_M` of `(x, z)`. Measured on the ground plane — the height is
   * the arc's business — and against `restSpot`, not `position`, so a body still in the air already holds its place.
   */
  private spotIsClear(x: number, z: number): boolean {
    const gapSq = PICKUP_SEPARATION_M * PICKUP_SEPARATION_M;
    for (const p of this.pickups) {
      const dx = p.restSpot.x - x, dz = p.restSpot.z - z;
      if (dx * dx + dz * dz < gapSq) return false;
    }
    return true;
  }

  /** In bounds, on the same surface the original spot was on, and not standing inside an obstacle. */
  private spotIsGround(world: NonNullable<GameContext['world']>, x: number, z: number, feetY: number, baseY: number): boolean {
    if (!world.isInsideBounds(x, z)) return false;
    const surface = world.getSurfaceY(x, z, feetY);
    if (Math.abs(surface - baseY) > PROP_STEP_UP_MAX) return false;   // another floor, or over an edge
    _probe.set(x, surface + BODY_R, z);
    world.resolveCollision(_probe, BODY_R);
    const dx = _probe.x - x, dz = _probe.z - z;
    return dx * dx + dz * dz <= 1e-6;   // pushed aside = the spot is inside a collider
  }

  /**
   * Where a toss will come down, guessed from the ballistic arc alone (no bounce, the surface under the thrower).
   * It only picks *which* neighbours the search must dodge, so the guess being a few cm off costs nothing — the real
   * landing is still resolved frame by frame in `simulate`. Without a velocity the spawn point **is** the landing point.
   */
  private landingGuess(position: THREE.Vector3, velocity: THREE.Vector3 | null, world: NonNullable<GameContext['world']> | null, out: THREE.Vector3): void {
    out.copy(position);
    if (!velocity) return;
    const ground = world ? world.getSurfaceY(position.x, position.z, position.y) : position.y;
    const fall = Math.max(0, position.y - ground);
    const t = (velocity.y + Math.sqrt(Math.max(0, velocity.y * velocity.y + 2 * GRAVITY * fall))) / GRAVITY;
    out.set(position.x + velocity.x * t, ground, position.z + velocity.z * t);
  }

  /* ─────────────────────────── spawn / remove ─────────────────────────── */
  private nextId(): string {
    const local = this.ctx.net?.localId ?? 'sp';
    return `${local}-${++this.seq}`;
  }

  private defOf(defId: string): ItemDef | undefined {
    return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId);
  }

  private spawnInternal(id: string, item: ItemInstance, position: THREE.Vector3, velocity: THREE.Vector3 | null, optimistic: boolean): Pickup | null {
    if (this.byId.has(id)) return null;
    const def = this.defOf(item.defId);
    if (!def) { console.warn(`[pickups] unknown item def '${item.defId}'`); return null; }
    while (this.pickups.length >= PICKUP_MAX) this.remove(this.pickups[0]);
    const visual = this.visuals.acquire(def);
    const p = new Pickup(id, item, def, visual);
    p.position.copy(position);
    const world = this.ctx.world && this.ctx.world.ready ? this.ctx.world : null;
    if (velocity) {
      p.vel.copy(velocity);
      p.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
      // 2026-09-21: claim the spot this arc is heading for, so the next drop in the same frame searches around it
      this.landingGuess(p.position, velocity, world, p.restSpot);
    } else {
      p.vel.set(0, 0, 0);
      // resting spawn (sync / echo without velocity): snap onto the terrain
      if (world) p.position.y = world.getSurfaceY(position.x, position.z, position.y + 0.3 - PROP_STEP_UP_MAX) + restHeightFor(def.category);
      this.settle(p);
    }
    p.optimistic = optimistic;
    visual.root.position.copy(p.position);
    this.pickups.push(p);
    this.byId.set(id, p);
    p.interactable = this.makeInteractable(p);
    this.ctx.interactables.register(p.interactable);
    this.ctx.bus.emit('pickup:spawned', { id, item, position: p.position });
    return p;
  }

  private remove(p: Pickup): void {
    const i = this.pickups.indexOf(p);
    if (i >= 0) this.pickups.splice(i, 1);
    this.byId.delete(p.id);
    if (p.interactable) { this.ctx.interactables.unregister(p.interactable.id); p.interactable = null; }
    this.visuals.release(p.visual);
    // `pickup:removed` fires for every removal (taken included) so markers can be cleared from one place
    this.ctx.bus.emit('pickup:removed', { id: p.id });
  }

  private makeInteractable(p: Pickup): Interactable {
    return {
      id: `pickup:${p.id}`,
      position: p.position,
      radius: TAKE_RADIUS,
      getPrompt: () => p.item.qty > 1 ? `${p.def.name} ×${p.item.qty} 줍기` : `${p.def.name} 줍기`,
      canInteract: () => this.ctx.isGameplayActive() && p.resting && !p.optimistic && this.ctx.time - p.takeRequestedAt > TAKE_REQUEST_COOLDOWN,
      interact: () => this.take(p),
    };
  }

  /* ─────────────────────────── taking ─────────────────────────── */
  private take(p: Pickup): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      // client: ask the host; the item is added when `item take {by: me}` comes back
      p.takeRequestedAt = ctx.time;
      net.send({ t: 'itemq', ev: 'take', id: p.id }, 'host');
      return;
    }
    if (!this.addToBag(p.item)) return;   // inventory already emitted `inventory:full`
    this.remove(p);
    ctx.bus.emit('pickup:taken', { id: p.id, item: p.item, byLocal: true, byName: null });
    ctx.bus.emit('audio:play', { id: 'pickup', position: p.position, volume: 0.7 });
    this.broadcast({ t: 'item', ev: 'take', id: p.id, by: net?.localId ?? 'local' }, 'others');
  }

  private addToBag(item: ItemInstance): boolean {
    const inv = this.ctx.inventory;
    if (!inv) return false;
    return inv.tryAddItem(item);
  }

  /* ─────────────────────────── local drop ─────────────────────────── */
  private onLocalDrop(item: ItemInstance, position: THREE.Vector3, velocity: THREE.Vector3): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) {
      // client: optimistic spawn under a proposed id; the host keeps the id and echoes `item drop`
      // The free spot is picked here too — `wireOf` then carries it in `itemq drop`, the host spawns at that exact
      // spot and echoes `m.item.p` back unchanged, so the optimistic body and every replica stand in one place.
      const id = this.nextId();
      const p = this.spawnInternal(id, item, this.freeSpotFor(position, velocity), velocity, true);
      if (!p) return;
      net.send({ t: 'itemq', ev: 'drop', item: this.wireOf(p), v: toTuple(velocity) }, 'host');
      return;
    }
    this.spawn(item, position, velocity);
  }

  /* ─────────────────────────── networking ─────────────────────────── */
  private ensureNetHooks(): void {
    const net = this.ctx.net;
    if (!net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('item', (m, from) => this.onItemMessage(m, from)),
      net.onMessage('itemq', (m, from) => this.onItemRequest(m, from)),
      net.onMessage('flow', (m, from) => this.onFlow(m, from)),
    );
  }

  private broadcast(msg: ItemMessage, to: 'all' | 'others' | PeerId): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    ctx.net.send(msg, to);
  }

  private wireOf(p: Pickup): PickupWire {
    const w: PickupWire = { id: p.id, defId: p.item.defId, qty: p.item.qty, p: toTuple(p.position) };
    const ex = extrasOf(p.item);
    if (ex) w.ex = ex;
    if (typeof p.item.raidFound === 'number') w.rf = p.item.raidFound;   // 2026-09-12: item recovery contract mark
    const q = normalizeMealQuality(p.item.quality);   // 2026-09-13: meal quality (0 = omitted)
    if (q > 0) w.q = q;
    return w;
  }

  private itemFromWire(w: PickupWire): ItemInstance {
    const loot = this.ctx.loot;
    const item: ItemInstance = loot && loot.getItemDef(w.defId)
      ? loot.createItem(w.defId, w.qty, w.ex)
      : { uid: `pk-${w.id}`, defId: w.defId, qty: w.qty, rotated: false, ...(w.ex ?? {}) };
    // 2026-09-12: the raid-found mark travels with the item (omitted = not raid-found — an older peer, a brought item)
    if (typeof w.rf === 'number' && Number.isFinite(w.rf)) item.raidFound = w.rf >>> 0;
    // 2026-09-13: the meal quality travels with it too (omitted = 0 — an older peer, not a meal)
    const q = normalizeMealQuality(w.q);
    if (q > 0) item.quality = q;
    return item;
  }

  /** Host → clients. */
  private onItemMessage(m: ItemMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer || net.isHost) return;
    const hostId = net.lobby?.hostId;
    if (hostId && from !== hostId) return;
    switch (m.ev) {
      case 'drop': {
        const existing = this.byId.get(m.item.id);
        if (existing) { existing.optimistic = false; return; }   // our own optimistic spawn, confirmed
        _tmp.set(m.item.p[0], m.item.p[1], m.item.p[2]);
        if (m.v) { _v.set(m.v[0], m.v[1], m.v[2]); this.spawnInternal(m.item.id, this.itemFromWire(m.item), _tmp, _v, false); }
        else this.spawnInternal(m.item.id, this.itemFromWire(m.item), _tmp, null, false);
        break;
      }
      case 'take': {
        const p = this.byId.get(m.id);
        if (!p) return;
        const mine = m.by === net.localId;
        this.remove(p);
        if (mine) {
          if (this.addToBag(p.item)) {
            ctx.bus.emit('pickup:taken', { id: p.id, item: p.item, byLocal: true, byName: null });
            ctx.bus.emit('audio:play', { id: 'pickup', position: p.position, volume: 0.7 });
          } else {
            // bag full but the host already removed it: put it back on the ground in front of us
            _tmp.copy(p.position); _v.set(0, 2.5, 0);
            this.onLocalDrop(p.item, _tmp, _v);
          }
        } else {
          ctx.bus.emit('pickup:taken', { id: p.id, item: p.item, byLocal: false, byName: net.getLobbyPlayer(m.by)?.name ?? null });
        }
        break;
      }
      case 'sync': {
        this.clear();
        for (const w of m.items) {
          _tmp.set(w.p[0], w.p[1], w.p[2]);
          this.spawnInternal(w.id, this.itemFromWire(w), _tmp, null, false);
        }
        break;
      }
    }
  }

  /** Clients → host. */
  private onItemRequest(m: ItemRequest, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer || !net.isHost) return;
    switch (m.ev) {
      case 'drop': {
        _tmp.set(m.item.p[0], m.item.p[1], m.item.p[2]);
        _v.set(m.v[0], m.v[1], m.v[2]);
        const p = this.spawnInternal(m.item.id, this.itemFromWire(m.item), _tmp, _v, false);
        if (!p) return;
        // echo to everyone (the dropper dedupes by id)
        this.broadcast({ t: 'item', ev: 'drop', item: { ...this.wireOf(p), p: m.item.p }, v: m.v }, 'others');
        break;
      }
      case 'take': {
        const p = this.byId.get(m.id);
        if (!p) return;   // already gone → no reply; the requester's cooldown expires
        this.remove(p);
        ctx.bus.emit('pickup:taken', { id: p.id, item: p.item, byLocal: false, byName: net.getLobbyPlayer(from)?.name ?? null });
        this.broadcast({ t: 'item', ev: 'take', id: p.id, by: from }, 'others');
        break;
      }
      case 'sync':
        this.sendSync(from);
        break;
    }
  }

  private onFlow(m: FlowMessage, from: PeerId): void {
    // a peer re-entered the running mission → hand it the current pickups without waiting for its `itemq sync`
    if (m.ev === 'rejoined' && this.ctx.net?.isHost) this.sendSync(from);
  }

  private sendSync(to: PeerId): void {
    const items: PickupWire[] = this.pickups.map((p) => this.wireOf(p));
    this.broadcast({ t: 'item', ev: 'sync', items }, to);
  }
}
