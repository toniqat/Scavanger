import * as THREE from 'three';
import {
  GRAVITY, PICKUP_LIFETIME, PICKUP_MAX,
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
    const p = this.spawnInternal(id, item, position, velocity ?? null, false);
    if (!p) return '';
    this.broadcast({ t: 'item', ev: 'drop', item: this.wireOf(p), v: velocity ? toTuple(velocity) : undefined }, 'others');
    return id;
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
    const ground = world.getHeightAt(p.position.x, p.position.z) + rest;
    if (p.position.y <= ground) {
      p.position.y = ground;
      world.getNormalAt(p.position.x, p.position.z, _n);
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
    const b = p.visual.body;
    b.rotation.set(0, Math.random() * Math.PI * 2, 0);
    b.position.set(0, 0, 0);
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
    if (velocity) {
      p.vel.copy(velocity);
      p.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    } else {
      p.vel.set(0, 0, 0);
      // resting spawn (sync / echo without velocity): snap onto the terrain
      const world = this.ctx.world;
      if (world && world.ready) p.position.y = world.getHeightAt(position.x, position.z) + restHeightFor(def.category);
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
      const id = this.nextId();
      const p = this.spawnInternal(id, item, position, velocity, true);
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
    return w;
  }

  private itemFromWire(w: PickupWire): ItemInstance {
    const loot = this.ctx.loot;
    if (loot && loot.getItemDef(w.defId)) return loot.createItem(w.defId, w.qty, w.ex);
    return { uid: `pk-${w.id}`, defId: w.defId, qty: w.qty, rotated: false, ...(w.ex ?? {}) };
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
