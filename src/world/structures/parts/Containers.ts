/**
 * src/world/structures/parts/Containers.ts — the **interactable containers** in structures · rail platforms · trams.
 *
 * It creates no new loot path. Opening one just emits `crate:open {crateId, tier, position}` and `inventory/`'s crate
 * code does the rest exactly as before (the per-tier roll · the container cache · multiplayer sync · appraisal XP ·
 * contract counters · `stats.cratesOpened`). What this file adds is the **silhouette** (cabinet · chest · reagent
 * cabinet) and two rules only:
 *   1. Opening a container **for the first time in that zone** emits `structure:investigated` (the trigger for
 *      enemies/'s rogue drop).
 *   2. A container may hold `bonusDefId` (a key · keycard) as a **bonus** at chance `bonusChance` — only when that
 *      roll hits are the contents filled in directly with `inventory.openContainerItems` and `crate:open` emitted
 *      **afterwards**. The cache is built first, so the crate code shows the container that already exists, and
 *      stats · XP · contracts rise exactly as for any other crate.
 *
 * 2026-09-12 — the **preview** (`preview`, the body of `WorldRef.previewContainerItems`): the same `contents()` the
 * opening code uses builds the items. A container whose bonus roll missed is rolled by the crate code
 * (`inventory/Container.ContainerStore.getOrCreate`), and both sides call the one **`shared/lootRolls.crateLootRandom`**
 * formula (`<map seed> ^ hash(id)` → `rollCrateOn(tier, rng, target planet)`) (2026-09-12 lead — the copy is gone).
 * The bonus roll uses a **separate rng** of `<map seed> ^ hash(id + '#bonus')`, so it does not shift the crate contents.
 */
import * as THREE from 'three';
import {
  Layers, Random, crateLootRandom,
  type GameContext, type Interactable, type ItemInstance, type StructureKind,
} from '@/shared';
/* appended (2026-09-12): recovery contracts — the raid-found mark */
import { markRaidFound, raidFoundSeed } from '@/shared';
/* appended (2026-09-16): the epic+ drop rate gate — the locked room exemption */
import type { CrateLootOpts } from '@/shared';

/** 2026-09-16: the roll rules of a lab locked-room container (`opts` for `LootRef.rollCrateOn` — exempt from
 * the epic+ gate). Shared · frozen. */
const LOCKED_ROOM_LOOT: CrateLootOpts = Object.freeze({ lockedRoom: true });

/**
 * 2026-09-12 — **the contents the crate code rolls** when this client first opens container `id` (tier `tier`).
 * Pure · deterministic. The seed formula is the same `crateLootRandom` as in
 * `inventory/Container.ContainerStore.getOrCreate` (structure · platform · tram containers and map crates all open
 * through it). null with no `ctx.loot`.
 * 2026-09-16: `opts` = that container's roll rules (`ContainerSet.lootOpts` — the locked room). inventory passes the
 * same value through `WorldRef.crateLootOpts`.
 */
export function rollCrateContents(game: GameContext, id: string, tier: number, opts?: CrateLootOpts): ItemInstance[] | null {
  const loot = game.loot;
  if (!loot) return null;
  const rng = crateLootRandom(game.world?.seed ?? 0, id);
  return loot.rollCrateOn(tier, rng, game.missionPlanet, opts);
}
import type { BuildCtx } from '../../build';
import { merge, paint, paintGradient, xform } from '../../build';
import { CONTAINER_RADIUS } from '../model';

/** One container's spec (built by whoever places it). */
export interface ContainerSpec {
  id: string;
  position: THREE.Vector3;
  yaw: number;
  tier: number;
  /** 0 = wall cabinet, 1 = floor chest, 2 = reagent cabinet / shelf. */
  style: 0 | 1 | 2;
  /** The key that counts "once per zone" — a structure id or a platform id. */
  zoneId: string;
  zoneKind: StructureKind | 'platform';
  /** The item def id this container may hold as a bonus (a key · keycard). */
  bonusDefId?: string;
  /** 2026-09-12: the chance `bonusDefId` is inside (0–1, seed-deterministic). Omitted = 1, always. */
  bonusChance?: number;
  /**
   * 2026-09-16: true = a container in the lab's floor-2 **locked room** — it does not go through the epic+ drop rate
   * gate (`epicPlusMul` in `planet_loot.csv`) (user's decision 「the locked room stays as it is」). The opening path,
   * the preview and inventory all read the same value through `lootOpts(id)`.
   */
  lockedRoom?: boolean;
  /**
   * true = a **moving** container (inside a tram). It gets no collider, and `position` / `yaw` are re-applied to the
   * mesh every frame — when whoever placed it edits the same `Vector3` object in place, the interaction check follows
   * along too (`Interactable.position` is that very object).
   */
  dynamic?: boolean;
}

interface Inst {
  spec: ContainerSpec;
  root: THREE.Group;
  door: THREE.Object3D;
  lamp: THREE.Mesh;
  anim: number;                 // −1 idle, else seconds since opening
  /** The **look** of an opened door — whoever opened it (2026-09-11: one a squadmate opened is opened through `markOpened` too). */
  opened: boolean;
  /**
   * Has this client already opened it once (split out 2026-09-11). Filling in the keycard contents and
   * `structure:investigated` hang on **my own first opening** — even when someone else opened it first and the door
   * stands open, my cache holds no keycard, so it has to be filled in here.
   */
  rolled: boolean;
  interactable: Interactable;
}

const STYLE_H = [1.75, 0.85, 1.5];
const STYLE_R = [0.5, 0.6, 0.55];
const OPEN_S = 0.45;

/**
 * 2026-09-14 — the **centre → corner** distance of the body collider (m, the largest of the three shapes). Whoever
 * picks the spots (the container spots in `parts/Build`) uses it to back off from a 「spot to keep clear」 by this much
 * plus a body's diameter. Changing the box size (`STYLE_R` · the `0.95r × 0.675r` in `addBox` below) carries the
 * back-off width along by itself.
 */
export const CONTAINER_REACH = Math.max(...STYLE_R.map((r) => Math.hypot(r * 0.95, r * 0.675)));

/** A container set — one structure · one platform · one tram may each hold their own, or share one. */
export class ContainerSet {
  readonly group = new THREE.Group();
  private readonly insts: Inst[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private lampMat: THREE.MeshStandardMaterial | null = null;
  private game: GameContext | null = null;
  /** Zones already investigated (`structure:investigated` exactly once per zone). */
  private readonly investigated = new Set<string>();
  private readonly byId = new Map<string, Inst>();
  /** Fired when a container door first opens on this client (world tells the squad with `crate opened`). */
  private onOpened: ((id: string) => void) | null = null;

  constructor(name = 'StructureContainers') { this.group.name = name; }

  get count(): number { return this.insts.length; }

  /** 2026-09-11: opened-look sync — called when a door first opens on this client. */
  setOpenListener(cb: ((id: string) => void) | null): void { this.onOpened = cb; }

  /** 2026-09-11 (C-57): a container's position (inside a tram, the `Vector3` that follows it every frame). null with none. */
  positionOf(id: string): THREE.Vector3 | null { return this.byId.get(id)?.spec.position ?? null; }

  /** 2026-09-16: the roll rules of container `id` (`WorldRef.crateLootOpts`) — `{ lockedRoom: true }` for a locked room, else undefined. */
  lootOpts(id: string): CrateLootOpts | undefined { return this.byId.get(id)?.spec.lockedRoom ? LOCKED_ROOM_LOOT : undefined; }

  /**
   * 2026-09-11: puts a container a squadmate opened into its **opened look** (the door animation only, no event and
   * no contents). false when it is not in this set. The light pillar is gone, so this look is what says "somebody has
   * already searched this".
   */
  markOpened(id: string): boolean {
    const inst = this.byId.get(id);
    if (!inst) return false;
    if (!inst.opened) { inst.opened = true; inst.anim = 0; inst.lamp.visible = false; }
    return true;
  }

  /** Is it in its opened look (debug · smoke). */
  isOpened(id: string): boolean { return this.byId.get(id)?.opened ?? false; }

  /**
   * 2026-09-15 (android squadmates) — hands over this set's containers one by one (`WorldRef.getLootContainers`).
   * It is a callback, so no new array is built. `position` is the **live** vector (the ones inside a tram move every
   * frame).
   */
  collect(push: (id: string, position: THREE.Vector3, tier: number, opened: boolean) => void): void {
    for (let i = 0; i < this.insts.length; i++) {
      const c = this.insts[i];
      push(c.spec.id, c.spec.position, c.spec.tier, c.opened);
    }
  }

  build(ctx: BuildCtx, game: GameContext, specs: readonly ContainerSpec[]): void {
    this.game = game;
    const rng = ctx.rng.fork('structContainers');
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: new THREE.Color(0x6fd8ff), emissiveIntensity: 1.8 });
    this.mats.push(bodyMat, this.lampMat);

    const bodies = [0, 1, 2].map((k) => this.makeBody(k as 0 | 1 | 2, rng));
    const doors = [0, 1, 2].map((k) => this.makeDoor(k as 0 | 1 | 2, rng));
    const lampGeo = new THREE.BoxGeometry(0.1, 0.06, 0.05);
    this.geos.push(...bodies, ...doors, lampGeo);

    for (const spec of specs) {
      const root = new THREE.Group();
      root.position.copy(spec.position);
      root.rotation.y = -spec.yaw;
      root.name = spec.id;

      // 2026-09-20 (`docs/PERF_PLAN.md` Phase A2, user's decision 「작은 물체도 그림자 끄기」): a loot box
      // is waist-high and stands on open ground or a lit floor, so its own shadow reads as a smudge under it —
      // 138 casters in S2 for 12k triangles. It still **receives** shadow, which is what makes it sit on the ground.
      const body = new THREE.Mesh(bodies[spec.style], bodyMat);
      body.castShadow = false; body.receiveShadow = true;
      body.layers.enable(Layers.INTERACTABLE);
      root.add(body);

      const door = new THREE.Group();
      door.position.set(-STYLE_R[spec.style] * 0.9, 0, STYLE_R[spec.style] * 0.62);
      const doorMesh = new THREE.Mesh(doors[spec.style], bodyMat);
      doorMesh.castShadow = false;
      door.add(doorMesh);
      root.add(door);

      const lamp = new THREE.Mesh(lampGeo, this.lampMat);
      lamp.position.set(0.28, STYLE_H[spec.style] - 0.22, STYLE_R[spec.style] * 0.66);
      root.add(lamp);

      const inst: Inst = { spec, root, door, lamp, anim: -1, opened: false, rolled: false, interactable: null as unknown as Interactable };
      inst.interactable = {
        id: `container:${spec.id}`,
        position: spec.position,
        radius: CONTAINER_RADIUS,
        getPrompt: () => (inst.opened ? '컨테이너 살펴보기 (E)' : '컨테이너 열기 (E)'),
        canInteract: () => !!this.game?.isGameplayActive(),
        get hidePillar(): boolean { return inst.opened; },
        interact: () => this.open(inst),
      };
      this.insts.push(inst);
      this.byId.set(spec.id, inst);
      this.group.add(root);
      game.interactables.register(inst.interactable);
      if (!spec.dynamic) {
        /* 2026-09-12: the collider is the box of the drawn body (cap width `1.9r × 1.35r`). The old radius-`r`
         * cylinder was an invisible wall over 20 cm out on the door side and the back (the indoor "invisible wall"
         * report). A low chest (0.85 m) is stepped on by the box rule. */
        const r = STYLE_R[spec.style];
        ctx.hash.addBox(new THREE.Vector3(spec.position.x, spec.position.y, spec.position.z),
          r * 0.95, r * 0.675, spec.yaw, STYLE_H[spec.style], 'container');
      }
    }
    ctx.root.add(this.group);
  }

  private open(inst: Inst): void {
    const game = this.game;
    if (!game) return;
    const spec = inst.spec;
    const first = !inst.rolled;
    if (!inst.opened) {
      inst.opened = true;
      inst.anim = 0;
      inst.lamp.visible = false;
      this.onOpened?.(spec.id);
    }
    if (first) {
      inst.rolled = true;
      // Only a container whose key bonus roll hit gets its contents filled in directly — the rest the crate
      // code rolls by tier with the same formula.
      const c = spec.bonusDefId ? this.contents(spec) : null;
      if (c?.bonus) {
        // 2026-09-12: raid loot carries the raid-found mark (the preview path stays unmarked — it never reaches a player)
        markRaidFound(c.items, raidFoundSeed(game));
        game.inventory?.openContainerItems(spec.id, c.items, spec.position, '컨테이너');
      }
    }
    // 2026-09-14: carries the zone id · kind — the NPC quest 「search containers inside a structure」 counts it
    game.bus.emit('crate:open', { crateId: spec.id, tier: spec.tier, position: spec.position, zoneId: spec.zoneId, zoneKind: spec.zoneKind });
    if (!first) return;
    if (this.investigated.has(spec.zoneId)) return;
    this.investigated.add(spec.zoneId);
    game.bus.emit('structure:investigated', { zoneId: spec.zoneId, kind: spec.zoneKind, position: spec.position });
  }

  /**
   * The contents rolled **the same way** as the crate code, plus the keycard. The rng seed is the same
   * `<map seed> ^ hash(id)` as in `inventory/Container`, so the same items come out whichever client opens it
   * (`ctx.world.seed` = this map's seed). When `items/` has not registered the keycard def yet it is **dropped
   * silently** and only the rest is filled in.
   *
   * 2026-09-10 — it is **`rollCrateOn(tier, rng, missionPlanet)`**, not `rollCrate`. `inventory/Container` had been
   * passing the planet since 2026-09-09 and only this site did not, so crates in structures · basements · platforms ·
   * trams alone rode neither the planet's weapon grade curve (`data/planet_loot.csv`) nor its rarity multiplier — on
   * an early planet where grades IV · V are sealed, structures were the way around that seal. This comment's promise
   * of "the same way as the crate code" is the contract itself.
   */
  private contents(spec: ContainerSpec): { items: ItemInstance[]; bonus: boolean } | null {
    const game = this.game;
    const loot = game?.loot;
    if (!game || !loot) return null;
    const items = rollCrateContents(game, spec.id, spec.tier, spec.lockedRoom ? LOCKED_ROOM_LOOT : undefined);
    if (!items) return null;
    let bonus = false;
    if (spec.bonusDefId && loot.getItemDef(spec.bonusDefId)) {
      const chance = spec.bonusChance ?? 1;
      const hit = chance >= 1
        || (chance > 0 && new Random((((game.world?.seed ?? 0) >>> 0) ^ Random.hash(`${spec.id}#bonus`)) >>> 0).chance(chance));
      if (hit) {
        try { items.unshift(loot.createItem(spec.bonusDefId, 1)); bonus = true; } catch { /* a def that exists but cannot be created is simply skipped */ }
      }
    }
    return { items, bonus };
  }

  /**
   * 2026-09-12 — the contents that **come out of the first opening** of this set's container `id` (the key bonus roll
   * included). Pure — it touches no opened mark, no event and no cache. null when it is not in this set or there is
   * no `ctx.loot`.
   */
  preview(id: string): ItemInstance[] | null {
    const inst = this.byId.get(id);
    return inst ? this.contents(inst.spec)?.items ?? null : null;
  }

  update(dt: number, time: number): void {
    if (this.lampMat) this.lampMat.emissiveIntensity = (time % 2.2) < 0.5 ? 2.2 : 0.3;
    for (let i = 0; i < this.insts.length; i++) {
      const c = this.insts[i];
      if (c.spec.dynamic) { c.root.position.copy(c.spec.position); c.root.rotation.y = -c.spec.yaw; }
      if (c.anim < 0) continue;
      c.anim += dt;
      const t = Math.min(1, c.anim / OPEN_S);
      c.door.rotation.y = -1.9 * (1 - Math.pow(1 - t, 3));
      if (t >= 1) c.anim = -1;
    }
  }

  dispose(): void {
    for (const c of this.insts) {
      this.game?.interactables.unregister(c.interactable.id);
      this.group.remove(c.root);
    }
    this.insts.length = 0;
    this.byId.clear();
    this.investigated.clear();
    this.onOpened = null;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    for (const m of this.mats) m.dispose();
    this.mats = [];
    this.lampMat = null;
    this.group.removeFromParent();
    this.game = null;
  }

  /* ── Geometry ───────────────────────────────────────────────────────── */

  private makeBody(style: 0 | 1 | 2, rng: Random): THREE.BufferGeometry {
    const shell = new THREE.Color(style === 2 ? 0x3d4a54 : 0x4b4f52);
    const dark = shell.clone().multiplyScalar(0.55);
    const trim = new THREE.Color(style === 2 ? 0x6fd8ff : 0x8a6a3a);
    const parts: THREE.BufferGeometry[] = [];
    const h = STYLE_H[style], r = STYLE_R[style];

    const box = new THREE.BoxGeometry(r * 1.8, h, r * 1.25);
    xform(box, { x: 0, y: h / 2, z: 0 });
    paintGradient(box, dark, shell, 0, h);
    parts.push(box);

    // Feet · top rim
    for (const sx of [-1, 1]) {
      const foot = new THREE.BoxGeometry(0.16, 0.1, r * 1.1);
      xform(foot, { x: sx * (r * 0.75), y: 0.05, z: 0 });
      paint(foot, dark);
      parts.push(foot);
    }
    const cap = new THREE.BoxGeometry(r * 1.9, 0.1, r * 1.35);
    xform(cap, { x: 0, y: h + 0.04, z: 0 });
    paint(cap, dark, 0.06, rng);
    parts.push(cap);

    if (style === 0) {
      // Wall cabinet: three vertical grooves
      for (let i = 0; i < 3; i++) {
        const rib = new THREE.BoxGeometry(0.05, h - 0.3, 0.04);
        xform(rib, { x: (i - 1) * r * 0.5, y: h / 2, z: r * 0.64 });
        paint(rib, trim);
        parts.push(rib);
      }
    } else if (style === 1) {
      // Chest: two bands
      for (const y of [h * 0.35, h * 0.72]) {
        const band = new THREE.BoxGeometry(r * 1.85, 0.07, r * 1.3);
        xform(band, { x: 0, y, z: 0 });
        paint(band, trim);
        parts.push(band);
      }
    } else {
      // Reagent cabinet: two glass shelves
      for (const y of [h * 0.4, h * 0.72]) {
        const shelf = new THREE.BoxGeometry(r * 1.6, 0.05, r * 1.0);
        xform(shelf, { x: 0, y, z: 0 });
        paint(shelf, trim);
        parts.push(shelf);
      }
    }
    return merge(parts);
  }

  private makeDoor(style: 0 | 1 | 2, rng: Random): THREE.BufferGeometry {
    const h = STYLE_H[style], r = STYLE_R[style];
    const shell = new THREE.Color(style === 2 ? 0x46545f : 0x55595c);
    const parts: THREE.BufferGeometry[] = [];
    const panel = new THREE.BoxGeometry(r * 1.75, h - 0.14, 0.07);
    xform(panel, { x: r * 0.88, y: h / 2, z: 0 });
    paintGradient(panel, shell.clone().multiplyScalar(0.7), shell, 0, h);
    parts.push(panel);
    const handle = new THREE.BoxGeometry(0.07, 0.28, 0.07);
    xform(handle, { x: r * 1.6, y: h * 0.55, z: 0.07 });
    paint(handle, new THREE.Color(0x22252a), 0.08, rng);
    parts.push(handle);
    return merge(parts);
  }
}
