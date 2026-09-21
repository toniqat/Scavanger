/**
 * src/world/Structures.ts — **the abandoned structures** (outpost · lab · crash-landed ship).
 *
 * Derelict buildings that can be entered. Interactable containers crowd inside; an outpost may come with a
 * **basement** and a lab that got a second floor with a floor-2 **locked room** — both are **always locked** and are
 * opened with a consumable key (2026-09-12: the basement = a basement key, the locked room = a lab keycard — the
 * `key` column of `data/structures.csv`), and opening one consumes one of the opener's. A key is not guaranteed
 * inside that building — each ground-floor container holds one now and then at `keyChance`, and they also come out
 * of crates · rogue corpses · the nomad shop.
 *
 * **2026-09-21 (user's decision) — a key is planet-bound, and the room shoots back.** The csv `key` column is now
 * only the **kind**; the id a door takes is `<kind>_<this raid's planet>` (`key_basement_amber` …, `data/items.csv`
 * has all ten), so a door accepts only **this planet's** key and the prompt · deny toast name that planet. Finding
 * one is still planet-independent: a container's bonus roll keeps the kind of the building it stands in and draws
 * the **planet uniformly**. Inside both locked spaces hangs an **indestructible ceiling turret**
 * (`structures/parts/Turret`) that fires on anyone in the room; opening that room's door is its only off switch.
 * At the bottom of the wall right beside a locked door is a **vent** only a ground drone passes (`parts/Build`). On
 * the **roof** of an outpost · lab stands a **map scanner** that clears the fog around it (once per structure).
 *
 * 2026-09-11 — ceilings · a second floor · windows · ladders · the roof scanner · indoor lighting · the basement
 * stair corridor and its standing door (geometry in `structures/parts/Build`, glass in `parts/Glass`, the wave in
 * `parts/ScanWave`). What stays here is lifetime · interaction · multiplayer only.
 *
 * Owned contract: `StructureDef` · `LadderDef` · `WorldRef.getStructures / structureAt / getLadders` ·
 * `structure:unlocked / scanned / investigated / glassBroken` · `ladder:grab` · `StructureMessage` (`struct`) /
 * `StructureRequest` (`structq`) · the `STRUCTURE_*` constants. The numbers are `data/structures.csv`
 * (`structures/model.ts` reads it).
 *
 * Multiplayer: opening the basement · the map scan are **host-authoritative** (the same shape as `harv` / `harvq` in
 * `Gather`). A window is **announced by whoever broke it** — the result is the same whoever breaks it, so nothing
 * needs to be decided.
 */
import * as THREE from 'three';
import {
  LADDER_GRAB_RANGE, Layers, LightPool, PLANET_IDS, STRUCTURE_INTERACT_RANGE, STRUCTURE_LABEL_KO, STRUCTURE_POINT_LIGHTS,
  STRUCTURE_SCAN_HOLD_S, STRUCTURE_SCAN_RADIUS, STRUCTURE_UNLOCK_HOLD_S, planetLabel,
  type GameContext, type ItemInstance, type LadderDef, type LightFixture, type PeerId, type PlanetId, type Random,
  type StructureDef, type StructureKind, type StructureMessage, type StructureRequest,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { type BuildCtx, merge, paint, paintGradient, xform } from './build';
import type { ObstacleEntry, SpatialHash } from './SpatialHash';
import {
  BREACH_W, PALETTE, type BuildingPlan, type DoorSpot, type Spot, type StructureNav, buildBuilding, buildWreck, mergeOrNull,
} from './structures/parts/Build';
import { ContainerSet, type ContainerSpec } from './structures/parts/Containers';
import { GlassSet, type WindowSpec } from './structures/parts/Glass';
import { ScanWave } from './structures/parts/ScanWave';
/* appended (2026-09-21): the ceiling turret inside a locked space */
import { CeilingTurretSet, type TurretSpec } from './structures/parts/Turret';
import { DOOR_W, PARAPET_H, WALL_T, WINDOW_SILL, pickTier, structureRow } from './structures/model';
import type { NavBuilding, NavWindow } from './nav/model';

/* 2026-09-19: the `BASEMENT_KEY_DEF` constant is gone. Since 2026-09-12 the key id's source is the `key` column of
   `data/structures.csv`, nothing in this module read the constant, and the only thing left holding it up was
   `world/index.ts` re-exporting a name no folder imported (outside code goes through `ctx.world`). The id
   `key_basement` itself is unchanged — it lives in the csv. */

/** The kind of locked door — it only splits the prompt · toast wording (the rules are the same). */
type DoorKind = 'basement' | 'locked';
/**
 * 2026-09-21 (planet-bound keys): `locked` · `need` **name the planet the door wants**. The key is no longer a
 * skeleton key, so a player standing there holding 아켈론 II's key in front of 카민 I's door has to be told which
 * planet the door is asking for — that is the whole point of the feature (it sends them to that planet).
 * `planet` is the Korean planet label (`planetLabel`), never the id.
 */
const DOOR_TEXT: Readonly<Record<DoorKind, {
  open: string; locked: (planet: string) => string; need: (planet: string) => string; done: string;
}>> = {
  basement: {
    open: '열쇠로 지하실 개방 (E)',
    locked: (planet) => `지하실 잠김 — ${planet} 열쇠 필요`,
    need: (planet) => `${planet} 지하실 열쇠가 필요하다`,
    done: '지하실이 열렸다 (열쇠 소모)',
  },
  locked: {
    open: '키카드로 잠긴 방 개방 (E)',
    locked: (planet) => `잠긴 방 — ${planet} 키카드 필요`,
    need: (planet) => `${planet} 연구소 보안 키카드가 필요하다`,
    done: '잠긴 방이 열렸다 (키카드 소모)',
  },
};

/** How long (s) the basement door takes to slide aside. */
const DOOR_SLIDE_S = 1.1;

interface Inst {
  def: StructureDef;
  /** The door collider blocking the corridor while locked. It leaves the hash once opened. */
  doorEntry: ObstacleEntry | null;
  doorMesh: THREE.Object3D | null;
  readonly doorBase: THREE.Vector3;
  readonly doorSlide: THREE.Vector3;
  doorAnim: number;      // −1 idle
  scanMat: THREE.MeshStandardMaterial | null;
  /** The roof scanner's spot (null for a crash-landed ship). */
  scanPos: THREE.Vector3 | null;
  /** 2026-09-12: the kind of locked door (null with none) · the item def id that opens it. */
  doorKind: DoorKind | null;
  keyDefId: string | null;
  /** 2026-09-21: the Korean label of the planet this door's key belongs to (the prompt · the deny toast). */
  keyPlanetLabel: string;
}

/** One building nav row for debug · smokes. */
interface NavRow {
  id: string; kind: StructureKind; nav: StructureNav;
  /** The basement door's interaction spot (null with none). */
  basementDoor: { x: number; y: number; z: number } | null;
  /** 2026-09-12: the locked room door's interaction spot (null with none). */
  lockedDoor: { x: number; y: number; z: number } | null;
  /** 2026-09-21 (A-18 phase 2): the roof floor height (NaN for an open-topped wreck) · the window panes, for the nav graph. */
  roofY: number;
  windows: readonly WindowSpec[];
}

/** A climb spot keeps this far (m) clear of the door's · the breach's edge (`navBuildings`). */
const NAV_OPENING_CLEAR_M = 0.6;

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Structures {
  readonly group = new THREE.Group();
  private readonly insts: Inst[] = [];
  private readonly byId = new Map<string, Inst>();
  private readonly defs: StructureDef[] = [];
  private readonly ladders: LadderDef[] = [];
  /** 2026-09-12: the building navs (reach smokes · site spawn points · 2026-09-21 the nav graph's region rectangles — `navOf`). */
  private readonly navs: NavRow[] = [];
  /**
   * Zones whose rogue drop has already been rolled (the `zoneId` of `structure:investigated`). It holds not only
   * structure ids but the zoneIds of **rail platforms · trams** too — those have no `StructureDef` and survive only
   * as a string here. `struct sync.rogued` carries the whole set: a zone whose roll **failed** has no other wire, so
   * after a host change the new host learns "that zone is already spent" from this list alone.
   */
  private readonly roguedZones = new Set<string>();
  private readonly containers = new ContainerSet('StructureContainers');
  /** 2026-09-21: the ceiling turrets of the locked spaces (`parts/Turret`). */
  private turrets = new CeilingTurretSet();
  private glass = new GlassSet();
  private scanWave = new ScanWave();
  private lightPool: LightPool | null = null;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private structMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;
  private hash: SpatialHash | null = null;
  private game: GameContext | null = null;
  private built = false;
  private netHooked = false;
  private busHooked = false;
  private readonly unsubs: Array<() => void> = [];

  constructor() { this.group.name = 'Structures'; }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Once from `WorldSystem.init`. The network hooks attach lazily, after `ctx.net` is published. */
  attach(game: GameContext): void {
    this.game = game;
    this.hookBus();
    this.ensureNet();
  }

  /** For system dispose only (`clear()` between missions keeps the subscriptions). */
  detach(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.busHooked = false;
    this.game = null;
  }

  getDefs(): readonly StructureDef[] { return this.defs; }

  getLadders(): readonly LadderDef[] { return this.ladders; }

  /** The windows (debug · smoke). */
  get glassSet(): GlassSet { return this.glass; }
  /** The map scanner waves (debug · smoke). */
  get scanWaves(): ScanWave { return this.scanWave; }
  /** The light pool (debug · smoke). */
  get lights(): LightPool | null { return this.lightPool; }
  /** Is a container in its opened look (debug · smoke). */
  isContainerOpened(id: string): boolean { return this.containers.isOpened(id); }
  /** 2026-09-21: is that structure's ceiling turret still armed — true · false · null when it has none (debug · smoke). */
  isTurretArmed(id: string): boolean | null { return this.turrets.isArmed(id); }
  /**
   * 2026-09-12: the nav of each building — outside / inside the front door · the room rectangles · the stair landing
   * and arrival spots · the basement door's interaction spot (`scripts/smoke-structure-reach.mjs` starts its flood
   * fill and picks its goals from this). Debug · smoke only.
   */
  debugNav(): readonly NavRow[] {
    return this.navs;
  }

  /**
   * 2026-09-13: the building nav of structure `id`, null with none. The **site spawn points** (`SiteSpawns` —
   * `WorldRef.getSiteSpawnPoints`) read the inside of the front door · the level heights · the locked room rectangle
   * from it. 2026-09-21 (A-18): the nav graph takes each building's rectangle (`cx` · `cz` · `yaw` · `halfW` · `halfD`) as
   * the grid it bakes the floors into (`WorldSystem.startNav`). World collision · surface checks still never look at it.
   */
  navOf(id: string): StructureNav | null {
    return this.navs.find((n) => n.id === id)?.nav ?? null;
  }

  /**
   * 2026-09-21 (A-18 phase 2): every window pane as the nav graph needs it — its `GlassSet.key`, the normal pointing
   * **into** the building (the pane's own normal has no fixed side, so it is turned toward the building's centre),
   * the floor it belongs to and the ground level outside.
   */
  navWindows(): NavWindow[] {
    const out: NavWindow[] = [];
    for (const row of this.navs) {
      row.windows.forEach((w, i) => {
        let nx = -Math.sin(w.yaw), nz = Math.cos(w.yaw);
        if ((row.nav.cx - w.x) * nx + (row.nav.cz - w.z) * nz < 0) { nx = -nx; nz = -nz; }
        out.push({
          id: GlassSet.key(row.id, i), building: row.id, x: w.x, z: w.z, sillY: w.y, halfW: w.halfW, height: w.height,
          nx, nz, floorY: w.y - WINDOW_SILL, groundY: row.nav.levels[0],
        });
      });
    }
    return out;
  }

  /**
   * 2026-09-21 (A-18 phase 2): the **roofed** buildings whose outer walls a small bug may climb (a wreck is open-topped
   * and has no `roofY`). `avoid` = the front door and the collapsed breach, which no climb spot is put in front of.
   */
  navBuildings(): NavBuilding[] {
    const out: NavBuilding[] = [];
    for (const row of this.navs) {
      if (!Number.isFinite(row.roofY)) continue;
      const n = row.nav;
      const c = Math.cos(n.yaw), s = Math.sin(n.yaw);
      const at = (lx: number, lz: number, r: number) => ({ x: n.cx + lx * c - lz * s, z: n.cz + lx * s + lz * c, r });
      const avoid = [at(n.doorOut[0], -n.halfD, DOOR_W / 2 + NAV_OPENING_CLEAR_M)];
      if (n.breach) {
        const r = BREACH_W / 2 + NAV_OPENING_CLEAR_M;
        avoid.push(n.breach.side === 0 ? at(n.breach.c, n.halfD, r) : at(n.breach.side === 1 ? -n.halfW : n.halfW, n.breach.c, r));
      }
      out.push({
        key: row.id, cx: n.cx, cz: n.cz, yaw: n.yaw, halfW: n.halfW, halfD: n.halfD, wallHalfT: WALL_T / 2,
        groundY: n.levels[0], roofY: row.roofY, wallTopY: row.roofY + PARAPET_H, avoid,
      });
    }
    return out;
  }

  /** 2026-09-21 (A-18 phase 2): `NavRef.windowWhole` — `key` is a `GlassSet.key`. */
  windowWhole(key: string): boolean { return this.glass.isWhole(key); }

  /**
   * 2026-09-21 (A-18 phase 2): `NavRef.breakWindow` — a bug crawling in breaks the pane **the way a local bullet
   * does** (`breakGlass(…, true)`: sound · shards · `structure:glassBroken` · `struct glass` on the wire). Only the
   * authority moves enemies, so only the authority ever calls it.
   */
  breakWindow(key: string): void {
    const ref = this.glass.refOf(key);
    if (ref) this.breakGlass(ref.structureId, ref.index, true);
  }

  /**
   * 2026-09-21 (A-18 phase 2): told the `GlassSet.key` of every pane that breaks, whoever broke it (bullet · bug ·
   * wire · a late joiner's sync) — the nav graph makes that window's link cheaper and rebuilds its flow fields.
   */
  onGlassBroken: ((key: string) => void) | null = null;

  /** 2026-09-12 (C): the contents from the first opening of this set's container
   * (`WorldRef.previewContainerItems`), null with none. */
  previewContainerItems(id: string): ItemInstance[] | null { return this.containers.preview(id); }
  /** 2026-09-16: the roll rules of this set's container (`WorldRef.crateLootOpts` — the locked room), undefined with none. */
  crateLootOpts(id: string) { return this.containers.lootOpts(id); }

  /** The structure holding `(x, z)` (inside its own `radius`), null with none. */
  structureAt(x: number, z: number): StructureDef | null {
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i];
      const dx = d.position.x - x, dz = d.position.z - z;
      if (dx * dx + dz * dz <= d.radius * d.radius) return d;
    }
    return null;
  }

  /** Fired when a container first opens on this client (world sends `crate opened`). */
  setOpenListener(cb: ((id: string) => void) | null): void { this.containers.setOpenListener(cb); }
  /** Puts a container somebody else opened into its opened look. false when it is not in this set. */
  markContainerOpened(id: string): boolean { return this.containers.markOpened(id); }
  /** 2026-09-11 (C-57): a container's position (null with none). */
  containerPositionOf(id: string): THREE.Vector3 | null { return this.containers.positionOf(id); }
  /** 2026-09-15 (androids): hands over this set's containers one by one (`WorldRef.getLootContainers`). */
  collectContainers(push: (id: string, position: THREE.Vector3, tier: number, opened: boolean) => void): void { this.containers.collect(push); }

  build(ctx: BuildCtx, game: GameContext): void {
    this.game = game;
    this.hash = ctx.hash;
    this.hookBus();
    this.ensureNet();
    this.built = true;
    /* The light pool is built **even with no structures at all** — it keeps the raid's point-light count
     * the same on every map (`core/LightBudget`). */
    this.lightPool = new LightPool(this.group, STRUCTURE_POINT_LIGHTS, [], 'StructureLight');
    this.group.add(this.scanWave.group);
    ctx.root.add(this.group);
    const sites = ctx.layout.structures;
    if (sites.length === 0) return;
    const rng = ctx.rng.fork('structures');
    /* 2026-09-12: for the locked room only (spot · container count · tiers) — one `fork(id)` per structure,
     * so it shifts neither the original stream nor another building. */
    const lockBase = ctx.rng.fork('structureLocks');

    this.structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.84, metalness: 0.2 });
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x08120f, emissive: new THREE.Color(0xfff0d0), emissiveIntensity: 1.6 });
    this.mats.push(this.structMat, this.glowMat);

    const specs: ContainerSpec[] = [];
    const turretSpecs: TurretSpec[] = [];
    const glassSpecs: { structureId: string; index: number; spec: WindowSpec }[] = [];
    /**
     * 2026-09-21 (planet-bound keys, user's decision): the `key` column of `structures.csv` is only the **kind**
     * (`key_basement` · `keycard_lab`) — the id a door really takes is that kind plus **this raid's planet**
     * (`data/items.csv` holds the ten). Outside a planet raid (a mode with no `missionPlanet`) there are no
     * structures at all, so the first planet is just a defined fallback, never a played case.
     */
    const missionPlanet: PlanetId = game.missionPlanet ?? PLANET_IDS[0];
    const keyIdFor = (kind: string, planet: PlanetId): string => `${kind}_${planet}`;
    const fixtures: LightFixture[] = [];
    const counters: Partial<Record<StructureKind, number>> = {};
    for (const site of sites) {
      const row = structureRow(site.kind);
      if (!row) continue;
      const n = counters[site.kind] ?? 0;
      counters[site.kind] = n + 1;
      const id = `struct_${site.kind}_${n}`;
      const lockRng = lockBase.fork(id);
      const lockedCount = site.kind !== 'wreck' && row.lockedMax > 0 ? lockRng.int(row.lockedMin, row.lockedMax) : 0;
      const plan: BuildingPlan = {
        cx: site.pad.x, cz: site.pad.z, yaw: site.pad.yaw, y0: site.pad.height,
        halfW: site.halfW, halfD: site.halfD, wallH: site.wallH, pit: site.pit, floors: site.floors,
        containers: row.containers, basementContainers: row.basementContainers,
        lockedContainers: lockedCount, lockRng: lockedCount > 0 ? lockRng : null,
      };
      const out = site.kind === 'wreck' ? buildWreck(ctx, plan, rng) : buildBuilding(ctx, plan, rng, site.kind === 'lab');

      const body = mergeOrNull(out.parts);
      if (body) {
        this.geos.push(body);
        const mesh = new THREE.Mesh(body, this.structMat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.layers.enable(Layers.PROP);
        mesh.name = id;
        this.group.add(mesh);
      }
      const glow = mergeOrNull(out.glow);
      if (glow) {
        this.geos.push(glow);
        const gm = new THREE.Mesh(glow, this.glowMat);
        gm.name = `${id}_glow`;
        this.group.add(gm);
      }

      /* 2026-09-12: at most one locked door per building — the basement door (outpost) or the floor-2 locked room door (lab). */
      const lockDoor = out.door ?? out.lockedDoor;
      const doorKind: DoorKind | null = out.door ? 'basement' : out.lockedDoor ? 'locked' : null;
      if (lockDoor && !row.key) console.warn(`[Structures] ${id}: 잠긴 문이 있는데 structures.csv 의 key 가 비었다 — 영영 열리지 않는다`);
      const def: StructureDef = {
        id, kind: site.kind,
        position: new THREE.Vector3(site.pad.x, site.pad.height, site.pad.z),
        yaw: site.pad.yaw,
        radius: Math.hypot(site.halfW, site.halfD) + 2,
        hasBasement: out.door !== null,
        basementDoor: out.door ? new THREE.Vector3(out.door.x, out.door.y, out.door.z) : null,
        hasLockedRoom: out.lockedDoor !== null,
        lockedRoomDoor: out.lockedDoor ? new THREE.Vector3(out.lockedDoor.x, out.lockedDoor.y, out.lockedDoor.z) : null,
        unlockDefId: lockDoor && row.key ? keyIdFor(row.key, missionPlanet) : null,
        unlocked: false, scanned: false, rogueDropUsed: false,
      };
      const inst: Inst = {
        def, doorEntry: null, doorMesh: null, doorBase: new THREE.Vector3(), doorSlide: new THREE.Vector3(), doorAnim: -1,
        scanMat: null, scanPos: null, doorKind, keyDefId: def.unlockDefId ?? null,
        keyPlanetLabel: planetLabel(missionPlanet),
      };

      /* Containers: the ground levels (floors 1 · 2) + the basement (when there is one) + the floor-2 locked room
       * (when there is one). `buildBuilding` has already finished picking the spots (the lighting hangs in those
       * rooms). 2026-09-12: the key is no longer "guaranteed in one ground-floor container" — each ground-floor
       * container may hold that kind's key as a **bonus** at `keyChance` (never guaranteed), and `ContainerSet` rolls
       * it from the seed. */
      const ground = out.containers;
      const bonusKind = row.key && row.keyChance > 0 ? row.key : undefined;
      /* 2026-09-21 (planet-bound keys): the container decides the key's **kind** from the building, but its
       * **planet uniformly at random** — any planet's key turns up on any planet, which is what sends a player
       * to the planet a key names. The planet is drawn per container on a fork of the lock stream, so it moves
       * neither the building's own rng nor the container's contents roll, and it is baked into the spec, so
       * `previewContainerItems` still equals opening. */
      const keyPlanetRng = bonusKind ? lockBase.fork(`${id}_keyPlanet`) : null;
      ground.forEach((s, i) => specs.push({
        id: `${id}_c${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(row.tiers, rng.next()), style: (i % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
        bonusDefId: bonusKind && keyPlanetRng ? keyIdFor(bonusKind, keyPlanetRng.pick(PLANET_IDS)) : undefined,
        bonusChance: bonusKind ? row.keyChance : undefined,
      }));
      const deepTiers = row.basementTiers.length > 0 ? row.basementTiers : row.tiers;
      /* 2026-09-15 (thumper, user's decision 「only in the 아켈론 II outpost basement」): a basement container gets the
       * **same bonus roll** as the ground floor's key (`bonusDefId` · `bonusChance`, rolled by `ContainerSet` on its
       * own rng) — the `basementBonus*` columns of `structures.csv` decide the item · chance · planets, and with the
       * target planet not on the list there is no roll at all. The crate tier roll is untouched. */
      const deepBonus = row.basementBonus && (row.basementBonusPlanets.length === 0 || (game.missionPlanet != null && row.basementBonusPlanets.includes(game.missionPlanet)))
        ? row.basementBonus : undefined;
      out.basementContainers.forEach((s, i) => specs.push({
        id: `${id}_b${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(deepTiers, rng.next()), style: ((i + 1) % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind,
        bonusDefId: deepBonus, bonusChance: deepBonus ? row.basementBonusChance : undefined,
      }));
      const lockTiers = row.lockedTiers.length > 0 ? row.lockedTiers : deepTiers;
      /* 2026-09-16: locked room containers are exempt from the epic+ drop rate gate (`lockedRoom` →
       * `CrateLootOpts`, user's decision 「the locked room stays as it is」). */
      out.lockedContainers.forEach((s, i) => specs.push({
        id: `${id}_l${i}`, position: new THREE.Vector3(s.x, s.y, s.z), yaw: s.yaw,
        tier: pickTier(lockTiers, lockRng.next()), style: ((i + 2) % 3) as 0 | 1 | 2,
        zoneId: id, zoneKind: site.kind, lockedRoom: true,
      }));

      if (out.console) this.buildConsole(ctx, game, rng, inst, out.console);
      if (lockDoor) this.buildDoor(ctx, game, rng, inst, lockDoor);
      /* 2026-09-21: the ceiling turret only exists where there is really a locked door to skip — a building whose
       * csv row has no `key` has no door either, so arming a room nobody can shut would just be a trap. */
      if (lockDoor && inst.keyDefId) {
        out.turrets.forEach((spot, i) => turretSpecs.push({ id: `${id}_t${i}`, structureId: id, spot }));
      }
      out.ladders.forEach((l, i) => {
        const ladder: LadderDef = {
          id: `ladder_${id}_${i}`,
          base: new THREE.Vector3(l.base.x, l.base.y, l.base.z),
          topY: l.topY,
          normal: new THREE.Vector3(l.normal.x, 0, l.normal.z).normalize(),
          exit: new THREE.Vector3(l.exit.x, l.exit.y, l.exit.z),
        };
        this.ladders.push(ladder);
        this.registerLadder(game, ladder);
      });
      out.windows.forEach((w, i) => glassSpecs.push({ structureId: id, index: i, spec: w }));
      fixtures.push(...out.fixtures);
      this.navs.push({
        id, kind: site.kind, nav: out.nav,
        basementDoor: out.door ? { ...out.door.interact } : null,
        lockedDoor: out.lockedDoor ? { ...out.lockedDoor.interact } : null,
        roofY: out.roofY, windows: out.windows,
      });

      this.insts.push(inst);
      this.byId.set(id, inst);
      this.defs.push(def);
    }

    this.containers.build(ctx, game, specs);
    this.turrets.build(ctx, game, turretSpecs, this.structMat!);
    this.glass.build(ctx, glassSpecs, (sid, idx, point) => this.breakGlass(sid, idx, true, point));
    this.group.add(this.glass.group);
    this.lightPool.setFixtures(fixtures);
    this.requestSync();
  }

  /** `eye` = what the light pool picks the nearest rooms by (the player's eye, or the camera with none). */
  update(dt: number, time: number, eye: THREE.Vector3 | null): void {
    if (!this.built) return;
    this.containers.update(dt, time);
    this.turrets.update(dt, time);
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.35 + 0.15 * Math.sin(time * 1.7);
    for (const inst of this.insts) {
      if (inst.scanMat) inst.scanMat.emissiveIntensity = inst.def.scanned ? 0.3 : 1.1 + 0.7 * Math.sin(time * 3.1);
      if (inst.doorAnim < 0 || !inst.doorMesh) continue;
      inst.doorAnim += dt;
      const t = Math.min(1, inst.doorAnim / DOOR_SLIDE_S);
      const e = 1 - Math.pow(1 - t, 3);
      inst.doorMesh.position.copy(inst.doorBase).addScaledVector(inst.doorSlide, e);
      if (t >= 1) inst.doorAnim = -1;
    }
    if (eye && this.lightPool) this.lightPool.update(dt, eye.x, eye.z, -1, eye.y);
    this.scanWave.update(dt);
  }

  dispose(): void {
    const game = this.game;
    this.containers.dispose();
    this.turrets.dispose();
    this.turrets = new CeilingTurretSet();
    for (const inst of this.insts) {
      game?.interactables.unregister(`struct:${inst.def.id}:scan`);
      game?.interactables.unregister(`struct:${inst.def.id}:door`);
    }
    for (const l of this.ladders) {
      game?.interactables.unregister(`ladder:${l.id}:bottom`);
      game?.interactables.unregister(`ladder:${l.id}:top`);
    }
    this.ladders.length = 0;
    this.navs.length = 0;
    this.insts.length = 0;
    this.byId.clear();
    this.defs.length = 0;
    this.roguedZones.clear();
    this.glass.dispose();
    this.glass = new GlassSet();
    this.scanWave.dispose();
    this.scanWave = new ScanWave();
    this.lightPool?.dispose();
    this.lightPool = null;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.structMat = null;
    this.glowMat = null;
    this.hash = null;
    this.group.clear();
    this.group.removeFromParent();
    this.built = false;
  }

  /* ── The roof map scanner ──────────────────────────────────────────── */

  private buildConsole(ctx: BuildCtx, game: GameContext, rng: Random, inst: Inst, spot: Spot): void {
    const parts: THREE.BufferGeometry[] = [];
    const ped = new THREE.BoxGeometry(0.95, 1.05, 0.62);
    xform(ped, { x: spot.x, y: spot.y + 0.52, z: spot.z }, new THREE.Euler(0, -spot.yaw, 0));
    paintGradient(ped, PALETTE.METAL_DARK, PALETTE.METAL, spot.y, spot.y + 1.05);
    parts.push(ped);
    const hood = new THREE.BoxGeometry(0.9, 0.55, 0.24);
    xform(hood, { x: spot.x, y: spot.y + 1.4, z: spot.z }, new THREE.Euler(-0.32, -spot.yaw, 0));
    paint(hood, PALETTE.METAL_DARK, 0.06, rng);
    parts.push(hood);
    // An antenna dish to look like a roof scanner (drawing only)
    const px = spot.x - Math.cos(spot.yaw) * 0.72, pz = spot.z - Math.sin(spot.yaw) * 0.72;
    const dishPole = new THREE.BoxGeometry(0.1, 1.1, 0.1);
    xform(dishPole, { x: px, y: spot.y + 1.6, z: pz });
    paint(dishPole, PALETTE.METAL_DARK);
    parts.push(dishPole);
    const dish = new THREE.CylinderGeometry(0.55, 0.12, 0.22, 12);
    xform(dish, { x: px, y: spot.y + 2.2, z: pz }, new THREE.Euler(0.6, -spot.yaw, 0));
    paint(dish, PALETTE.METAL, 0.05, rng);
    parts.push(dish);
    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.structMat!);
    mesh.castShadow = true;
    mesh.name = `${inst.def.id}_console`;
    this.group.add(mesh);

    const screenGeo = new THREE.BoxGeometry(0.74, 0.44, 0.05);
    this.geos.push(screenGeo);
    const scanMat = new THREE.MeshStandardMaterial({ color: 0x05121a, emissive: new THREE.Color(0x66ccff), emissiveIntensity: 1.2 });
    this.mats.push(scanMat);
    inst.scanMat = scanMat;
    const screen = new THREE.Mesh(screenGeo, scanMat);
    screen.name = `${inst.def.id}_console_screen`;
    screen.position.set(spot.x + Math.sin(spot.yaw) * 0.14, spot.y + 1.42, spot.z - Math.cos(spot.yaw) * 0.14);
    screen.rotation.set(-0.32, -spot.yaw, 0);
    this.group.add(screen);

    /* 2026-09-12: the pedestal box as drawn (the old radius-0.55 cylinder was an invisible wall 24 cm out front and back) + the dish pole */
    ctx.hash.addBox(new THREE.Vector3(spot.x, spot.y, spot.z), 0.475, 0.31, spot.yaw, 1.1, 'console');
    ctx.hash.addBox(new THREE.Vector3(px, spot.y, pz), 0.05, 0.05, spot.yaw, 2.2, 'console');

    const pos = new THREE.Vector3(spot.x, spot.y, spot.z);
    inst.scanPos = pos;
    game.interactables.register({
      id: `struct:${inst.def.id}:scan`,
      position: pos,
      radius: STRUCTURE_INTERACT_RANGE,
      holdTime: STRUCTURE_SCAN_HOLD_S,
      hidePillar: true,
      getPrompt: () => (inst.def.scanned ? null : '맵 스캔 (E)'),
      canInteract: () => !inst.def.scanned && !!this.game?.isGameplayActive(),
      interact: () => this.requestScan(inst),
    });
  }

  /* ── The locked door (basement door · floor-2 locked room door — a standing door panel) ─────────────── */

  private buildDoor(ctx: BuildCtx, game: GameContext, rng: Random, inst: Inst, door: DoorSpot): void {
    const parts: THREE.BufferGeometry[] = [];
    const panel = new THREE.BoxGeometry(door.halfW * 2, door.height, door.thick);
    xform(panel, { x: 0, y: door.height / 2, z: 0 });
    paintGradient(panel, PALETTE.METAL_DARK, PALETTE.METAL, 0, door.height);
    parts.push(panel);
    for (const y of [0.45, door.height - 0.55]) {
      const st = new THREE.BoxGeometry(door.halfW * 1.8, 0.16, door.thick + 0.03);
      xform(st, { x: 0, y, z: 0 });
      paint(st, new THREE.Color(0x9a7a2a), 0.05, rng);
      parts.push(st);
    }
    const handle = new THREE.BoxGeometry(0.08, 0.5, door.thick + 0.12);
    xform(handle, { x: door.halfW * 0.7, y: 1.1, z: 0 });
    paint(handle, PALETTE.METAL_DARK);
    parts.push(handle);
    const geo = merge(parts);
    this.geos.push(geo);
    const mesh = new THREE.Mesh(geo, this.structMat!);
    mesh.castShadow = true;
    mesh.name = `${inst.def.id}_door`;
    const holder = new THREE.Group();
    holder.name = `${inst.def.id}_door_holder`;
    holder.position.set(door.x, door.y, door.z);
    holder.rotation.y = -door.yaw;
    holder.add(mesh);
    this.group.add(holder);
    inst.doorMesh = holder;
    inst.doorBase.set(door.x, door.y, door.z);
    inst.doorSlide.set(door.slideX, 0, door.slideZ);
    /* While locked the door panel is the collider — once open it leaves the hash and slides aside. */
    inst.doorEntry = ctx.hash.addBox(new THREE.Vector3(door.x, door.y, door.z), door.halfW, door.thick / 2 + 0.02, door.yaw, door.height, 'door');

    // The card reader (a chest-height box on the corridor wall + an LED)
    {
      const box = new THREE.BoxGeometry(0.3, 0.42, 0.16);
      xform(box, { x: door.reader.x, y: door.y + 1.35, z: door.reader.z }, new THREE.Euler(0, -door.reader.yaw, 0));
      paint(box, PALETTE.METAL_DARK);
      this.geos.push(box);
      const bm = new THREE.Mesh(box, this.structMat!);
      bm.name = `${inst.def.id}_reader`;
      this.group.add(bm);
      const led = new THREE.BoxGeometry(0.17, 0.08, 0.2);
      xform(led, { x: door.reader.x, y: door.y + 1.46, z: door.reader.z }, new THREE.Euler(0, -door.reader.yaw, 0));
      this.geos.push(led);
      const lm = new THREE.Mesh(led, this.glowMat!);
      lm.name = `${inst.def.id}_reader_led`;
      this.group.add(lm);
    }

    const pos = new THREE.Vector3(door.interact.x, door.interact.y, door.interact.z);
    const self = this;
    const text = DOOR_TEXT[inst.doorKind ?? 'basement'];
    game.interactables.register({
      id: `struct:${inst.def.id}:door`,
      position: pos,
      radius: STRUCTURE_INTERACT_RANGE,
      /* Hold 0 without the right key — pressing gives the deny sound at once. Better than being refused after filling the whole gauge. */
      get holdTime(): number { return self.hasKey(inst) ? STRUCTURE_UNLOCK_HOLD_S : 0; },
      getPrompt: () => (inst.def.unlocked ? null : self.hasKey(inst) ? text.open : text.locked(inst.keyPlanetLabel)),
      canInteract: () => !inst.def.unlocked && !!this.game?.isGameplayActive(),
      interact: () => this.requestUnlock(inst),
    });
  }

  /** Does this client carry even one of the key that opens that door (`inst.keyDefId`) — bag · quick slots · pouches (`countWhere`). */
  private hasKey(inst: Inst): boolean {
    const inv = this.game?.inventory;
    const key = inst.keyDefId;
    return !!inv && !!key && inv.countWhere((def) => def.id === key) > 0;
  }

  /** The locked door's world position (sound · events). */
  private doorPosOf(inst: Inst): THREE.Vector3 {
    return inst.def.basementDoor ?? inst.def.lockedRoomDoor ?? inst.def.position;
  }

  /* ── Ladders ──────────────────────────────────────────────────────── */

  /**
   * Two `Interactable`s per ladder, at the **foot · top**. Pressing only emits `ladder:grab`; all the climbing is done
   * by `player/`. While hanging both prompts hide (E is letting go of the ladder then).
   */
  private registerLadder(game: GameContext, ladder: LadderDef): void {
    const self = this;
    const can = (): boolean => !!self.game?.isGameplayActive() && !self.game.player?.climbingLadder && !self.game.player?.isDead;
    const grab = (from: 'bottom' | 'top'): void => {
      const g = self.game;
      if (!g || g.player?.climbingLadder) return;
      g.bus.emit('ladder:grab', { ladder, from });
    };
    game.interactables.register({
      id: `ladder:${ladder.id}:bottom`,
      position: ladder.base.clone(),
      radius: LADDER_GRAB_RANGE,
      getPrompt: () => '사다리 오르기 (E)',
      canInteract: can,
      interact: () => grab('bottom'),
    });
    game.interactables.register({
      id: `ladder:${ladder.id}:top`,
      position: ladder.exit.clone(),
      radius: LADDER_GRAB_RANGE,
      getPrompt: () => '사다리 내려가기 (E)',
      canInteract: can,
      interact: () => grab('top'),
    });
  }

  /* ── Windows ──────────────────────────────────────────────────────── */

  /** Breaks one pane. `byLocal` = this client's bullet · throwable broke it (announce it on the wire). */
  private breakGlass(structureId: string, index: number, byLocal: boolean, point?: THREE.Vector3): void {
    if (!this.glass.breakPane(structureId, index)) return;
    this.onGlassBroken?.(GlassSet.key(structureId, index));
    const ctx = this.game;
    if (!ctx) return;
    const center = this.glass.centerOf(structureId, index, new THREE.Vector3());
    if (!center) return;
    const fx = FxManager.get();
    if (fx && this.glass.normalOf(structureId, index, _n)) {
      _c.copy(point ?? center);
      ParticleBurst.sparks(fx.additive, _c, _n, 12, 3.5, 0xd8f4ff);
      ParticleBurst.sparks(fx.additive, _c, _n.negate(), 9, 2.5, 0xd8f4ff);
    }
    ctx.bus.emit('audio:play', { id: 'glass_break', position: center });
    ctx.bus.emit('structure:glassBroken', { structureId, index, position: center, byLocal });
    const net = ctx.net;
    if (byLocal && ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'glass', id: structureId, w: index }, 'others');
  }

  /* ── Interaction → host authority ─────────────────────────────────── */

  private requestScan(inst: Inst): void {
    const ctx = this.game;
    if (!ctx || inst.def.scanned) return;
    const net = ctx.net;
    /* 2026-09-14 (NPC quest interact): 「I ran the scanner」. The host's `struct scanned` does not say who ran it, so
       the client emits it **the moment it requests** — an already scanned scanner is stopped by the guard above, so
       the only case that gets refused is a race in the same tick. */
    ctx.bus.emit('world:interacted', { kind: 'scanner', id: inst.def.id, structureKind: inst.def.kind });
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'structq', ev: 'scan', id: inst.def.id }, 'host'); return; }
    this.applyScan(inst, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'scanned', id: inst.def.id }, 'others');
  }

  private requestUnlock(inst: Inst): void {
    const ctx = this.game;
    if (!ctx || inst.def.unlocked) return;
    if (!this.hasKey(inst)) {
      ctx.bus.emit('audio:play', { id: 'keycard_deny', position: this.doorPosOf(inst) });
      ctx.bus.emit('ui:notify', { text: DOOR_TEXT[inst.doorKind ?? 'basement'].need(inst.keyPlanetLabel), kind: 'warning', duration: 2.4 });
      return;
    }
    const net = ctx.net;
    if (ctx.isMultiplayer && net && !net.isHost) { net.send({ t: 'structq', ev: 'unlock', id: inst.def.id }, 'host'); return; }
    const by: PeerId | null = net?.localId ?? null;
    this.applyUnlock(inst, by, true);
    if (ctx.isMultiplayer && net) net.send({ t: 'struct', ev: 'unlocked', id: inst.def.id, by }, 'others');
  }

  /**
   * `announce` = did this client's own action cause it (the toast). **The wave and the sound happen on everyone's
   * screen** (when somebody scans from a roof the whole squad sees the wave sweep the map).
   */
  private applyScan(inst: Inst, announce: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.scanned) return;
    inst.def.scanned = true;
    const at = inst.scanPos ?? inst.def.position;
    ctx.world?.fog?.reveal(at.x, at.z, STRUCTURE_SCAN_RADIUS);
    this.scanWave.fire(at);
    ctx.bus.emit('structure:scanned', {
      id: inst.def.id, kind: inst.def.kind, position: inst.def.position, radius: STRUCTURE_SCAN_RADIUS,
    });
    ctx.bus.emit('audio:play', { id: 'scan_pulse', position: at, volume: 1, pitch: 0.7 });
    if (!announce) return;
    ctx.bus.emit('ui:notify', { text: `${STRUCTURE_LABEL_KO[inst.def.kind]} — 맵 스캔 완료`, kind: 'success', duration: 2.6 });
  }

  /** `consume` = is this client the one who spent the key (one of that door's key `inst.keyDefId` is consumed). */
  private applyUnlock(inst: Inst, by: PeerId | null, consume: boolean): void {
    const ctx = this.game;
    if (!ctx || inst.def.unlocked) return;
    inst.def.unlocked = true;
    if (inst.doorEntry) { this.hash?.remove(inst.doorEntry); inst.doorEntry = null; }
    inst.doorAnim = 0;
    /* 2026-09-21: opening the door with the right planet's key is the **only** off switch of that room's ceiling
     * turret, and it is permanent. This runs on every path `unlocked` arrives by — the opener, `struct unlocked`
     * from the host, and a late joiner's `struct sync.unlocked` — so **powering it down** needs no wire of its own.
     * (What the turret does have a wire for, since 2026-09-21 / B-100, is which body it is on: `struct turret`.) */
    this.turrets.disableFor(inst.def.id);
    const at = this.doorPosOf(inst);
    if (consume) {
      const key = inst.keyDefId;
      if (key) ctx.inventory?.consumeWhere((def) => def.id === key, 1);
      ctx.bus.emit('audio:play', { id: 'keycard_use', position: at });
      ctx.bus.emit('ui:notify', { text: DOOR_TEXT[inst.doorKind ?? 'basement'].done, kind: 'success', duration: 2.2 });
      // 2026-09-14 (NPC quest interact): the one who spent the key = this client (after the host decided it with `by`)
      ctx.bus.emit('world:interacted', { kind: inst.doorKind === 'locked' ? 'lab_door' : 'basement_door', id: inst.def.id, structureKind: inst.def.kind });
    }
    ctx.bus.emit('structure:unlocked', { id: inst.def.id, kind: inst.def.kind, by, position: at });
  }

  /* ── Multiplayer ──────────────────────────────────────────────────── */

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('struct', (m) => this.onMessage(m)),
      net.onMessage('structq', (m, from) => this.onRequest(m, from)),
      net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from); }),
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost && this.built) this.requestSync(); }),
    );
  }

  /**
   * The subscriptions that must attach even with no network. `ensureNet` attaches only after `ctx.net` is published,
   * but the rogue drop's "once per zone" record has to be kept **in single player too** (so that zone is not rolled
   * again next time).
   */
  private hookBus(): void {
    const ctx = this.game;
    if (!ctx || this.busHooked) return;
    this.busHooked = true;
    this.unsubs.push(ctx.bus.on('structure:investigated', ({ zoneId }) => this.markRogued(zoneId)));
  }

  /** Notes that the zone's rogue drop draw is done (on the `StructureDef` too when it is a structure). */
  private markRogued(zoneId: string): void {
    this.roguedZones.add(zoneId);
    const inst = this.byId.get(zoneId);
    if (inst) inst.def.rogueDropUsed = true;
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'structq', ev: 'sync' }, 'host');
  }

  /** Host → client. Windows alone are **anyone → everyone**, so the host receives them too. */
  private onMessage(m: StructureMessage): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    if (m.ev === 'glass') { this.breakGlass(m.id, m.w, false); return; }
    if (net.isHost) return;
    if (m.ev === 'unlocked') {
      const inst = this.byId.get(m.id);
      // The key · keycard disappears **only from the one who opened it**
      if (inst) this.applyUnlock(inst, m.by, m.by !== null && m.by === net.localId);
      return;
    }
    if (m.ev === 'scanned') {
      const inst = this.byId.get(m.id);
      if (inst) this.applyScan(inst, false);
      return;
    }
    /* 2026-09-21 (B-100): the ceiling turret's chosen body — the replica paints and warns from this, never from a
       target it picked itself (`structures/parts/Turret.applyWire`). */
    if (m.ev === 'turret') { this.turrets.applyWire(m.id, m.tg, m.st); return; }
    for (const id of m.unlocked) { const i = this.byId.get(id); if (i) this.applyUnlock(i, null, false); }
    for (const id of m.scanned) { const i = this.byId.get(id); if (i) this.applyScanQuiet(i); }
    for (const id of m.rogued) this.markRogued(id);
    for (const key of m.glass ?? []) {
      const at = key.lastIndexOf(':');
      if (at > 0) this.breakGlassQuiet(key.slice(0, at), Number(key.slice(at + 1)));
    }
  }

  /** A late joiner's sync: a scan that already finished restores state only, with no wave and no sound. */
  private applyScanQuiet(inst: Inst): void {
    if (inst.def.scanned) return;
    inst.def.scanned = true;
    const at = inst.scanPos ?? inst.def.position;
    this.game?.world?.fog?.reveal(at.x, at.z, STRUCTURE_SCAN_RADIUS);
  }

  /** A late joiner's sync: an already broken pane gets no shards and no sound. */
  private breakGlassQuiet(structureId: string, index: number): void {
    if (!Number.isFinite(index)) return;
    if (!this.glass.breakPane(structureId, index)) return;
    this.onGlassBroken?.(GlassSet.key(structureId, index));
    const center = this.glass.centerOf(structureId, index, new THREE.Vector3());
    if (center) this.game?.bus.emit('structure:glassBroken', { structureId, index, position: center, byLocal: false });
  }

  /** Client → host. */
  private onRequest(m: StructureRequest, from: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !net.isHost) return;
    if (m.ev === 'sync') { this.sendSync(from); return; }
    const inst = this.byId.get(m.id);
    if (!inst) return;
    if (m.ev === 'unlock') {
      if (inst.def.unlocked) return;              // somebody opened it first — the requester's key survives
      if (!inst.keyDefId) return;                 // a door with no key decided (a csv setup error) — nobody can open it
      this.applyUnlock(inst, from, false);
      net.send({ t: 'struct', ev: 'unlocked', id: inst.def.id, by: from }, 'others');
      return;
    }
    if (inst.def.scanned) return;
    this.applyScan(inst, false);
    net.send({ t: 'struct', ev: 'scanned', id: inst.def.id }, 'others');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer) return;
    net.send({
      t: 'struct', ev: 'sync',
      unlocked: this.defs.filter((d) => d.unlocked).map((d) => d.id),
      scanned: this.defs.filter((d) => d.scanned).map((d) => d.id),
      rogued: [...this.roguedZones],
      glass: this.glass.brokenKeys(),
    }, to);
    /* 2026-09-21 (B-100): a turret only speaks on a change, so a client joining mid-lock is told once what every
       armed turret is already on. */
    for (const w of this.turrets.activeWire()) net.send({ t: 'struct', ev: 'turret', id: w.id, tg: w.tg, st: w.st }, to);
  }
}
