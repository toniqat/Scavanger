/**
 * src/game/Corpses.ts — **the corpse of a dead player** (`ctx.corpses`, 2026-09-09).
 *
 * The question this file answers: *what is left in the world when a player dies fully, and how it is searched.*
 *
 * - Automatic revival is gone, so a **corpse** stands where the player died. **It does not disappear before the
 *   raid ends** — no lifetime, no distance culling (user's decision: kept out of the optimisation targets).
 * - A corpse is one container: `Interactable` `pcorpse:<ownerId>:<n>` → `openContainerItemsSized(...)`.
 *   **Taking** rides the existing `cont` / `contq` host-authority path exactly as a crate does (no new path).
 * - The mesh is procedural — `SoldierModel` is frozen once into the dead pose and never updated again.
 *   (`SoldierModel` from `@/player` is the only symbol of another feature folder that game/ uses. A deliberate
 *   exception so the soldier model is not built twice — see the folder README's `Notes`.)
 */
import * as THREE from 'three';
import {
  NET_SLOT_COLORS, PLAYER_CORPSE_COLS, PLAYER_CORPSE_LOOT_RANGE, PLAYER_CORPSE_ROWS,
  recordRideLocal, restoreRideLocal, normalizeMealQuality,
  /* appended (2026-09-15): android squadmates — one id decides the corpse's look · prompt */
  isAndroidId,
  /* appended (2026-09-16): empty-corpse removal */
  CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_SINK_DEPTH_M, CORPSE_EMPTY_SINK_S,
  /* appended (2026-09-16): an empty corpse sinks only after every loot window has closed */
  CorpseViewTracker,
  type CorpseItemWire, type CorpsesRef, type GameContext, type Interactable, type ItemInstance, type Obstacle,
  type PlayerCorpse, type PlayerCorpseWire, type TramDef, type WorldRef,
} from '@/shared';

/** `PlayerCorpseWire.ride` (C-63) — the vehicle-local coordinates of a corpse riding a tram. */
type CorpseRideWire = NonNullable<PlayerCorpseWire['ride']>;

const _rideScratch = new THREE.Vector3();
const _shipQ = new THREE.Quaternion();
const _shipE = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * C-63: which tram the ridden platform (`Obstacle`) is a part of. Every tram part gets **the same value** as
 * `TramDef.yaw` for its `box.yaw` (`world/rails/parts/Tram.placeTram` writes both from one variable in one frame)
 * — of those, the nearest tram.
 */
function tramOfCarrier(world: WorldRef, c: Obstacle): TramDef | null {
  if (!c.box) return null;
  const trams = world.getTrams();
  let best: TramDef | null = null, bestD = Infinity;
  for (let i = 0; i < trams.length; i++) {
    const t = trams[i];
    if (Math.abs(t.yaw - c.box.yaw) > 1e-6) continue;
    const d = (t.position.x - c.position.x) ** 2 + (t.position.z - c.position.z) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
import { SoldierModel, SOLDIER_DEFAULT_ACCENT, type SoldierPose } from '@/player';

/** The frozen dead pose (the damping is run through in one go, then it is never touched again). */
const DEAD_POSE: SoldierPose = {
  moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
  verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 1,
  prone: 1, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
};
/** The big step run just once at creation so the dead pose converges (not an animation that runs per frame). */
const SETTLE_STEPS = 6;
const SETTLE_DT = 0.5;

/**
 * One corpse. It is both an `Interactable` and a `PlayerCorpse`. The item list passes to the container on the first
 * interaction, and from then on the container cache is the truth (`crate:looted` tells it that it went empty).
 */
export class PlayerCorpseObject implements Interactable, PlayerCorpse {
  readonly radius = PLAYER_CORPSE_LOOT_RANGE;
  /** 2026-09-11 (C-4): the light pillar · recon classification reads this first instead of the id prefix. */
  readonly kind = 'playerCorpse' as const;
  readonly position = new THREE.Vector3();
  readonly group = new THREE.Group();
  emptied = false;
  private readonly model: SoldierModel;
  /* ── 2026-09-11 (C-18): a corpse on a running tram is carried along by it ─────────────────────────────────────────
   * The same formula as the player · enemies (`ride.ts` in `@/shared`). Right after creation the **moving
   * platform** under its feet (`Obstacle.velocity`) is found once (`boardCarrier`) and written down in
   * vehicle-local coordinates, then resolved again every frame with the vehicle's **current** transform
   * (`followCarrier`). `carrier` is a live `Obstacle` inside the `SpatialHash`, so it changes with the moving tram.
   * A corpse never moves by itself, so there is no stay test (`rideContains`) and no exit inertia — it rides until
   * the raid ends. */
  private carrier: Obstacle | null = null;
  private readonly rideLocal = new THREE.Vector3();
  /**
   * The vehicle's `box.yaw` (math convention) and the corpse yaw (three.js convention) at the moment of boarding —
   * on a curve the body turns with the car.
   */
  private rideCarrierYaw0 = 0;
  private rideYaw0 = 0;
  private yawNow: number;
  /**
   * 2026-09-13 (the extraction rework): a corpse carried on the extraction ship's deck — the mesh group is a
   * **child** of the ship `root`, so it moves with the tilt too, and its world place each frame is the interaction
   * position. Unlike a tram (`carrier`) there is no platform query (a ship deck is not a world platform).
   * Once it leaves with the ship, extraction clears it away with `removeCorpse`.
   */
  private shipParent: THREE.Object3D | null = null;

  constructor(
    private readonly ctx: GameContext,
    readonly id: string,
    readonly ownerId: string,
    readonly ownerName: string,
    position: THREE.Vector3,
    yaw: number,
    readonly diedAt: number,
    /** Everything carried at the moment of death. Used only when the container is first built. */
    readonly items: ItemInstance[],
    slot: number,
  ) {
    this.yawNow = yaw;
    this.position.copy(position);
    this.group.name = `PlayerCorpse:${id}`;
    this.group.position.copy(position);
    this.group.rotation.y = yaw;
    this.model = new SoldierModel(NET_SLOT_COLORS[slot] ?? SOLDIER_DEFAULT_ACCENT);
    /*
     * 2026-09-15 (android squadmates): an android's `잔해` is known **by id** (`pcorpse:android:<scope>:<bay>:<n>`).
     * That is why no field is added to the wire — a receiver sees the same id and so builds the same look.
     * `setAndroidLook` is a method player/ attaches, so it is used when present (else it stays a plain soldier).
     */
    if (isAndroidId(ownerId)) {
      (this.model as { setAndroidLook?: (on: boolean) => void }).setAndroidLook?.(true);
    }
    // corpses are greyed — told apart from a living squadmate at a glance
    this.model.setGreyed(true);
    for (let i = 0; i < SETTLE_STEPS; i++) this.model.update(SETTLE_DT, 0, DEAD_POSE);
    // 2026-09-16: the sinking is owned by a group one level in — `group` follows the tram · ship and
    // rewrites its place every frame
    this.sinkRoot.name = 'PlayerCorpseSink';
    this.sinkRoot.add(this.model.root);
    this.group.add(this.sinkRoot);
  }

  /* ── 2026-09-16: empty-corpse removal ─────────────────────────────────────────────────────────────────────────────
   * A corpse with no items at all waits `CORPSE_EMPTY_REMOVE_DELAY_S` from `emptiedAt` (`ctx.missionTime`) and then
   * sinks `CORPSE_EMPTY_SINK_DEPTH_M` into the ground over `CORPSE_EMPTY_SINK_S` (not a fade — user's decision).
   * It runs on the mission clock, so it stops while the loading gate holds (sim dt 0). Once fully sunk the manager
   * clears it away with `removeCorpse`.
   * 2026-09-16 (2nd pass): `emptiedAt` is the moment it became 「empty **and no longer looked into by anybody**」 —
   * it does not count while a loot window is open (`PlayerCorpseManager.update`, `shared/corpseViewers`). `emptied`
   * true with `emptiedAt` still -1 means somebody is still looking. */
  /** The sinking body (a child of `group`, the parent of `model.root`). */
  private readonly sinkRoot = new THREE.Group();
  /** The `ctx.missionTime` it went empty with nobody looking (-1 = not yet — not empty, or a window is open). */
  emptiedAt = -1;

  /** How deep it has sunk right now (m, 0 = not yet). For smokes · debugging. */
  get sinkDepth(): number { return -this.sinkRoot.position.y; }

  /** Draws the sinking at `now` (the mission clock). true = fully sunk (time to clear it away). */
  stepSink(now: number): boolean {
    if (this.emptiedAt < 0) return false;
    const elapsed = now - this.emptiedAt - CORPSE_EMPTY_REMOVE_DELAY_S;
    if (elapsed < 0) return false;
    const k = CORPSE_EMPTY_SINK_S > 0 ? Math.min(1, elapsed / CORPSE_EMPTY_SINK_S) : 1;
    this.sinkRoot.position.y = -CORPSE_EMPTY_SINK_DEPTH_M * k * k;   // ease-in: it settles slowly, then speeds up
    return k >= 1;
  }

  /** The direction the body faces now (three.js `rotation.y` convention). A corpse on a tram changes on curves. */
  get yaw(): number { return this.yawNow; }

  /** true = being carried by a moving platform (for smokes · debugging). */
  get riding(): boolean { return this.carrier !== null; }

  /**
   * Boards the moving platform under its feet if there is one (an obstacle with `velocity` — a tram deck). Called
   * just once, right after creation. A tie between platforms is settled by `getStandingObstacle`, which picks the
   * moving one first (C-38).
   */
  boardCarrier(world: WorldRef | null): void {
    if (this.carrier || !world?.ready) return;
    const o = world.getStandingObstacle(this.position.x, this.position.z, this.position.y);
    if (!o || !o.velocity) return;
    this.carrier = o;
    recordRideLocal(o, this.position, this.rideLocal);
    this.rideCarrierYaw0 = o.box ? o.box.yaw : 0;
    this.rideYaw0 = this.yawNow;
  }

  /**
   * C-63: boards from the wire's `ride` (the tram the sender rode · vehicle-local coordinates · the yaw against the
   * vehicle). The spot is taken by resolving those local coordinates with **this client's current transform of that
   * tram** instead of `p` — the gap where interpolation lag dropped a corpse at the tail end outside the tram when
   * `p` was used. An unknown tram id, or no platform of that tram at the resolved spot, does nothing and returns
   * false (the caller falls back to the old `boardCarrier`). It may be called again on a corpse already standing:
   * the same local coordinates on the same tram give the same result as `followCarrier`.
   */
  boardFromWire(world: WorldRef | null, ride: CorpseRideWire | undefined): boolean {
    if (!world?.ready || !ride || typeof ride.tram !== 'string' || !Array.isArray(ride.local)) return false;
    const [lx, ly, lz] = ride.local;
    if (!Number.isFinite(lx) || !Number.isFinite(ly) || !Number.isFinite(lz)) return false;
    let tram: TramDef | null = null;
    for (const t of world.getTrams()) if (t.id === ride.tram) { tram = t; break; }
    if (!tram) return false;
    // TramDef frame: position = the car's centre (y = the deck's top face), yaw = local +X → world (cos, sin)
    // — the same convention as `shared/ride`
    const cs = Math.cos(tram.yaw), sn = Math.sin(tram.yaw);
    const p = _rideScratch.set(
      tram.position.x + lx * cs - lz * sn,
      tram.position.y + ly,
      tram.position.z + lx * sn + lz * cs,
    );
    const o = world.getStandingObstacle(p.x, p.z, p.y);
    if (!o || !o.velocity) return false;
    this.position.copy(p);
    this.carrier = o;
    recordRideLocal(o, this.position, this.rideLocal);
    this.rideCarrierYaw0 = o.box ? o.box.yaw : 0;
    this.yawNow = Number.isFinite(ride.yaw) ? ride.yaw - tram.yaw : this.yawNow;
    this.rideYaw0 = this.yawNow;
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yawNow;
    return true;
  }

  /**
   * C-63: the tram it rides right now, as `PlayerCorpseWire.ride` (the dead player's own `spawn` · the host's
   * `sync` — both compute it from the **current** ride state). The yaw against the vehicle = the corpse yaw
   * (three.js) + the tram yaw (math convention) — it does not change while riding.
   */
  rideWire(): CorpseRideWire | undefined {
    const c = this.carrier, world = this.ctx.world;
    if (!c || !world?.ready) return undefined;
    const tram = tramOfCarrier(world, c);
    if (!tram) return undefined;
    const cs = Math.cos(tram.yaw), sn = Math.sin(tram.yaw);
    const dx = this.position.x - tram.position.x, dz = this.position.z - tram.position.z;
    return {
      tram: tram.id,
      local: [dx * cs + dz * sn, this.position.y - tram.position.y, -dx * sn + dz * cs],
      yaw: this.yawNow + tram.yaw,
    };
  }

  /** 2026-09-13: true = it is carried on the extraction ship's deck (for smokes · debugging). */
  get onShip(): boolean { return this.shipParent !== null; }

  /**
   * 2026-09-13 (`CorpsesRef.attachCorpse`): lays it at `parent`-local `local` (omitted = its current world place)
   * and makes it follow that transform. null = puts it down at its current world place. A tram ride is released
   * (one vehicle at a time).
   */
  attachToParent(parent: THREE.Object3D | null, local?: THREE.Vector3): void {
    if (parent) {
      this.carrier = null;
      parent.updateWorldMatrix(true, false);
      if (local) this.group.position.copy(local).applyMatrix4(parent.matrixWorld);
      this.group.rotation.set(0, this.yawNow, 0);
      this.group.updateMatrixWorld(true);
      parent.attach(this.group);   // keeps the world transform, then rides the parent
      this.shipParent = parent;
      this.group.getWorldPosition(this.position);
      return;
    }
    if (!this.shipParent) return;
    this.shipParent = null;
    this.ctx.scene.attach(this.group);
    this.group.getWorldPosition(this.position);
  }

  /**
   * Every frame: resolves the spot (= the interaction position) and the direction again with the ridden vehicle's
   * **current** transform. Riding nothing, it does nothing.
   */
  followCarrier(): void {
    if (this.shipParent) {
      // 2026-09-13: the mesh hangs off the ship — read back where that put it
      this.group.getWorldPosition(this.position);
      this.group.getWorldQuaternion(_shipQ);
      this.yawNow = _shipE.setFromQuaternion(_shipQ, 'YXZ').y;
      return;
    }
    const c = this.carrier;
    if (!c) return;
    restoreRideLocal(c, this.rideLocal, this.position);
    this.group.position.copy(this.position);
    // box.yaw follows the local +X → world (cos, sin) convention and a mesh's rotation.y has the opposite sign
    // (`rotation.y = −yaw` in `world/rails`)
    this.yawNow = this.rideYaw0 - ((c.box ? c.box.yaw : 0) - this.rideCarrierYaw0);
    this.group.rotation.y = this.yawNow;
  }

  /** 2026-09-15: is it an android's (the look · the prompt). */
  get isAndroid(): boolean { return isAndroidId(this.ownerId); }

  getPrompt(): string | null {
    if (this.emptied) return '비어 있음';
    // 2026-09-15: a person leaves 「유해」, an android 「잔해」 (the same container, a different thing)
    return this.isAndroid ? `${this.ownerName}의 잔해 뒤지기` : `${this.ownerName}의 유해 뒤지기`;
  }

  canInteract(): boolean {
    const ctx = this.ctx;
    if (this.emptied || !ctx.isGameplayActive()) return false;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return false;
    return !!ctx.inventory && typeof ctx.inventory.openContainerItemsSized === 'function';
  }

  interact(): void {
    const inv = this.ctx.inventory;
    if (this.emptied || !inv || typeof inv.openContainerItemsSized !== 'function') return;
    inv.openContainerItemsSized(this.id, this.items, this.position,
      PLAYER_CORPSE_COLS, PLAYER_CORPSE_ROWS, `${this.ownerName}의 ${this.isAndroid ? '잔해' : '유해'}`);
  }

  /** To `PlayerCorpseWire` (the host's `pcorpse sync` · the dead player's own `spawn`). */
  toWire(): PlayerCorpseWire {
    const wire: PlayerCorpseWire = {
      id: this.id, owner: this.ownerId, name: this.ownerName,
      p: [this.position.x, this.position.y, this.position.z], yaw: this.yaw, at: this.diedAt,
      items: itemsToWire(this.items),
    };
    const ride = this.rideWire();   // C-63: omitted = not riding
    if (ride) wire.ride = ride;
    return wire;
  }

  dispose(): void {
    this.model.dispose();
    this.group.removeFromParent();
  }
}

/** `ItemInstance[]` → the wire (durability · loaded ammo · sockets ride in `ex` — measured, not rolled). */
export function itemsToWire(items: readonly ItemInstance[]): CorpseItemWire[] {
  const out: CorpseItemWire[] = [];
  for (const it of items) {
    if (!it) continue;
    const ex = (it.durability !== undefined || it.ammoInMag !== undefined || it.sockets !== undefined)
      ? { durability: it.durability, ammoInMag: it.ammoInMag, sockets: it.sockets }
      : undefined;
    const w: CorpseItemWire = ex ? { defId: it.defId, qty: it.qty, ex } : { defId: it.defId, qty: it.qty };
    if (typeof it.raidFound === 'number') w.rf = it.raidFound;   // 2026-09-12: the recovery contract mark goes along
    const q = normalizeMealQuality(it.quality);   // 2026-09-13: the meal quality too (0 = omitted)
    if (q > 0) w.q = q;
    out.push(w);
  }
  return out;
}

/**
 * Every corpse standing in the raid. Published as `ctx.corpses` (`GameFlowSystem` builds and owns it).
 * The host has to hold **other people's corpses with their `items` too**, or it cannot answer a late joiner's
 * `pcorpse sync`.
 */
export class PlayerCorpseManager implements CorpsesRef {
  private readonly corpses = new Map<string, PlayerCorpseObject>();
  /** The corpse number per owner (`pcorpse:<owner>:<n>`) — one person dying several times leaves several corpses. */
  private readonly seq = new Map<string, number>();
  /**
   * C-63: a `ride` that arrived on the wire is held per corpse id for a moment and consumed by `add`. The caller
   * that spawns the corpse (`parts/CorpseNet.applyCorpseWire`) passes only the position · yaw, so this manager
   * **subscribes separately** to the same `pcorpse` message and takes just the `ride` (inventory's `CorpseLoot`
   * listens to the same message separately too). It comes out right whatever the handler order: heard first, it is
   * written down here for `add` to use; with `add` first, the corpse already standing is boarded again on the spot.
   */
  private readonly pendingRide = new Map<string, CorpseRideWire>();
  private netUnsub: (() => void) | null = null;
  /**
   * 2026-09-16 (empty-corpse removal): the corpse ids cleared away in this raid. `add` filters them so that a late
   * `pcorpse spawn` (the `'all'` echo) · a host `sync` sent before the removal cannot spawn **a corpse already
   * emptied and cleared away** again with its items (inventory's container cache is empty already and
   * `crate:looted` has gone out once, so a corpse spawned again is left with a 「뒤지기」 prompt forever). Cleared
   * on a mission reset.
   */
  private readonly removed = new Set<string>();
  /** 2026-09-16: owners whose corpse stood at least once this raid (`ownerHadCorpse` — hides the remote avatar). */
  private readonly owners = new Set<string>();
  /**
   * 2026-09-16 (2nd pass, user's decision): who is holding a corpse window open (`shared/corpseViewers`). An empty
   * corpse does not count its sink clock until the last person closes their window. The ids it owns are `pcorpse:`
   * only (an enemy corpse `corpse:<id>` belongs to the tracker in enemies).
   */
  readonly viewers: CorpseViewTracker;

  constructor(private readonly ctx: GameContext) {
    this.viewers = new CorpseViewTracker(ctx, {
      matches: (id) => id.startsWith('pcorpse:'),
      positionOf: (id) => this.corpses.get(id)?.position ?? null,
    });
    this.hookNet();
  }

  /** Listens separately for the `ride` of `pcorpse` alone (once). `update` calls it again for a late `ctx.net`. */
  private hookNet(): void {
    const net = this.ctx.net;
    if (this.netUnsub || !net || typeof net.onMessage !== 'function') return;
    this.netUnsub = net.onMessage('pcorpse', (msg) => {
      if (msg.ev === 'spawn') this.noteWireRide(msg.corpse);
      else if (msg.ev === 'sync') for (const w of msg.corpses ?? []) this.noteWireRide(w);
    });
  }

  /** C-63: one wire body's `ride` — a corpse already standing boards again at once, else it is noted for `add`. */
  noteWireRide(w: PlayerCorpseWire): void {
    if (!w || typeof w.id !== 'string' || !w.ride || this.removed.has(w.id)) return;
    const known = this.corpses.get(w.id);
    if (known) { known.boardFromWire(this.ctx.world, w.ride); return; }
    if (this.pendingRide.size > 64) this.pendingRide.clear();   // so wires that never stood a corpse do not pile up
    this.pendingRide.set(w.id, w.ride);
  }

  getCorpses(): readonly PlayerCorpse[] { return [...this.corpses.values()]; }

  get(id: string): PlayerCorpse | null { return this.corpses.get(id) ?? null; }

  latestOf(ownerId: string): PlayerCorpse | null {
    let best: PlayerCorpseObject | null = null;
    for (const c of this.corpses.values()) {
      if (c.ownerId !== ownerId) continue;
      if (!best || c.diedAt >= best.diedAt) best = c;
    }
    return best;
  }

  /** The next corpse id. */
  nextId(ownerId: string): string {
    const n = (this.seq.get(ownerId) ?? 0) + 1;
    this.seq.set(ownerId, n);
    return `pcorpse:${ownerId}:${n}`;
  }

  /**
   * An id already known is ignored and the existing one returned (so a message sent to `'all'` does not echo back).
   * 2026-09-16: an id already emptied and cleared away this raid returns null (it is not spawned again). **With no
   * items at all** it is marked an empty corpse the moment it stands (`markEmptied`) — the dead player · the host ·
   * the receivers all see the same `items`, so they reach the same conclusion with no wire.
   */
  add(id: string, ownerId: string, ownerName: string, position: THREE.Vector3, yaw: number,
    diedAt: number, items: ItemInstance[], slot: number): PlayerCorpseObject | null {
    const known = this.corpses.get(id);
    if (known) return known;
    if (this.removed.has(id)) return null;
    this.owners.add(ownerId);
    // an id from outside has to go into the sequence too, or our own numbers collide
    const n = Number(id.slice(id.lastIndexOf(':') + 1));
    if (Number.isFinite(n)) this.seq.set(ownerId, Math.max(this.seq.get(ownerId) ?? 0, n));
    const c = new PlayerCorpseObject(this.ctx, id, ownerId, ownerName, position, yaw, diedAt, items, slot);
    // 2026-09-11 (C-63): when the wire named the tram it rode, board with that tram's current transform; otherwise
    // (an unknown id included) look for the platform under its feet as before (C-18: dying on a tram rides it)
    const ride = this.pendingRide.get(id);
    if (ride) this.pendingRide.delete(id);
    if (!c.boardFromWire(this.ctx.world, ride)) c.boardCarrier(this.ctx.world);
    this.corpses.set(id, c);
    this.ctx.scene.add(c.group);
    this.ctx.interactables.register(c);
    this.ctx.bus.emit('corpse:playerSpawned', {
      id, ownerId, ownerName, position: c.position.clone(), yaw,
    });
    // 2026-09-16: a corpse that stood empty-handed (it died with nothing) — empty the moment it stood and never
    // opened by anybody, so the clock starts at once. Every client sees the same `items`, so nothing is broadcast.
    if (c.items.length === 0) this.releaseEmptied(id);
    return c;
  }

  /**
   * 2026-09-15 (`CorpsesRef.spawnAllyCorpse`, caller: allies/): leaves a dead android's `잔해`.
   *
   * It is **the same path** as a person's corpse (`parts/CorpseNet.spawnLocalCorpse`) — the container id
   * `pcorpse:<allyId>:<n>`, the same `pcorpse spawn` broadcast, taking through the existing `cont` / `contq`.
   * Only three things differ:
   *  ① **the authority alone** makes it (the host simulates androids — the dead one cannot speak for itself),
   *  ② `items` is only what the caller picked, the **things found in the raid** (the base kit is a bound thing, so
   *     it is not left behind),
   *  ③ the body wears the android look — that is decided by the id (the `PlayerCorpseObject` constructor).
   * The id of the corpse made, or null when none was.
   */
  spawnAllyCorpse(allyId: string, name: string, slot: number, position: THREE.Vector3, yaw: number,
    items: readonly ItemInstance[]): string | null {
    const ctx = this.ctx;
    if (!ctx.isAuthority || typeof allyId !== 'string' || !allyId) return null;
    const pos = position.clone();
    // the same rule as for a person — the walkable surface, not the terrain (a tram deck · an upper floor)
    if (ctx.world?.ready) pos.y = ctx.world.getSurfaceY(pos.x, pos.z, pos.y);
    const id = this.nextId(allyId);
    const corpse = this.add(id, allyId, name || '안드로이드', pos, Number.isFinite(yaw) ? yaw : 0,
      ctx.missionTime, items.filter((it) => !!it), Math.max(0, slot | 0));
    if (!corpse) return null;
    if (ctx.isMultiplayer) ctx.net?.send({ t: 'pcorpse', ev: 'spawn', corpse: corpse.toWire() }, 'all');
    return id;
  }

  /**
   * `crate:looted` (every client): the prompt becomes `비어 있음`. 2026-09-16 (2nd pass): the sink clock starts only
   * **once nobody holds a window open any more** — the authority (single player · host) at once when nobody is
   * looking right now, otherwise `update` releases it the moment the last person closes and (in a session)
   * broadcasts `pcorpse emptied`. A non-host waits for that broadcast of the host's (`releaseEmptied`).
   */
  markEmptied(id: string): boolean {
    const c = this.corpses.get(id);
    if (!c || c.emptied) return false;
    c.emptied = true;
    this.ctx.bus.emit('corpse:playerEmptied', { id, ownerId: c.ownerId });
    if (this.ctx.isAuthority && !this.viewers.isViewed(id)) this.releaseByAuthority(c);
    return true;
  }

  /**
   * 2026-09-16 (2nd pass): starts an empty corpse's sink clock from now — a corpse that stood empty-handed (`add`) ·
   * the host's `pcorpse emptied` (`parts/CorpseNet`). It also marks it when it was not known to be empty yet.
   * Already counting, it does nothing. An unknown id returns false.
   */
  releaseEmptied(id: string): boolean {
    const c = this.corpses.get(id);
    if (!c) return false;
    if (!c.emptied) {
      c.emptied = true;
      this.ctx.bus.emit('corpse:playerEmptied', { id, ownerId: c.ownerId });
    }
    if (c.emptiedAt < 0) c.emptiedAt = this.ctx.missionTime;
    return true;
  }

  /**
   * The authority: releases the clock of an empty corpse nobody is looking at and, in a session, tells the squad
   * (only the host sends — receivers accept it from the host alone).
   */
  private releaseByAuthority(c: PlayerCorpseObject): void {
    if (c.emptiedAt >= 0) return;
    c.emptiedAt = this.ctx.missionTime;
    if (this.ctx.isMultiplayer) this.ctx.net?.send({ t: 'pcorpse', ev: 'emptied', id: c.id }, 'others');
  }

  /** 2026-09-16 (`CorpsesRef.ownerHadCorpse`, caller: player/RemoteAvatar): has this owner had a corpse this raid? */
  ownerHadCorpse(ownerId: string): boolean { return this.owners.has(ownerId); }

  /** 2026-09-13 (`CorpsesRef.attachCorpse`, caller: extraction): loads a corpse onto the extraction ship / off it. */
  attachCorpse(id: string, parent: THREE.Object3D | null, local?: THREE.Vector3): boolean {
    const c = this.corpses.get(id);
    if (!c) return false;
    c.attachToParent(parent, local);
    return true;
  }

  /**
   * 2026-09-13 (`CorpsesRef.removeCorpse`, caller: extraction): clears a corpse that left with the ship out of the
   * raid. The items inside go too — the same id left in inventory's container cache has no way left to be opened
   * (the interactable is gone).
   */
  removeCorpse(id: string): boolean {
    const c = this.corpses.get(id);
    if (!c) return false;
    // the light pillar goes with it too (`ui/hud/Detection` only looks at what is registered)
    this.ctx.interactables.unregister(id);
    // a body carried on a ship · tram is detached from its parent too (`group.removeFromParent`)
    c.dispose();
    this.corpses.delete(id);
    this.pendingRide.delete(id);
    this.removed.add(id);   // 2026-09-16: so a late `spawn` · `sync` cannot spawn it again
    return true;
  }

  /**
   * Every frame (`GameFlowSystem.update`): moves a corpse riding a tram to the vehicle's current place. A corpse
   * riding nothing costs nothing.
   * 2026-09-16: sinks empty corpses and clears away the ones fully sunk (the clock = `ctx.missionTime`).
   * 2026-09-16 (2nd pass): an empty corpse somebody holds a window open on is not counted — the authority releases
   * and broadcasts it the moment the last person closes, and even a corpse already counting has its clock held
   * while **my** window shows it (a broadcast and my own close that crossed — the 1 s after the close is kept).
   */
  update(): void {
    if (!this.netUnsub) this.hookNet();
    this.viewers.update();
    const now = this.ctx.missionTime;
    const mine = this.viewers.localViewing;
    const authority = this.ctx.isAuthority;
    let done: string[] | null = null;
    for (const c of this.corpses.values()) {
      c.followCarrier();
      if (!c.emptied) continue;
      if (c.emptiedAt < 0) {
        if (authority && !this.viewers.isViewed(c.id)) this.releaseByAuthority(c);
        continue;
      }
      if (mine === c.id) { c.emptiedAt = now; continue; }
      if (c.stepSink(now)) (done ??= []).push(c.id);
    }
    if (done) for (const id of done) this.removeCorpse(id);
  }

  /**
   * The whole list to send as `pcorpse sync` (the host alone sends it). 2026-09-16: empty corpses are left out
   * because they are about to disappear — on the receiving side one would stand with its original `items` and show
   * 「뒤지기」 until a `cont sync` arrived.
   */
  syncWire(): PlayerCorpseWire[] {
    const out: PlayerCorpseWire[] = [];
    for (const c of this.corpses.values()) if (!c.emptied) out.push(c.toWire());
    return out;
  }

  /** Mission reset: unregisters the interactables + disposes geometries · materials. */
  clear(): void {
    for (const c of this.corpses.values()) {
      this.ctx.interactables.unregister(c.id);
      c.dispose();
    }
    this.corpses.clear();
    this.seq.clear();
    this.pendingRide.clear();
    this.removed.clear();   // 2026-09-16
    this.owners.clear();
    this.viewers.reset();   // 2026-09-16 (2nd pass)
  }
}
