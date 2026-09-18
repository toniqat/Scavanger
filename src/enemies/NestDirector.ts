/**
 * src/enemies/NestDirector.ts — **bug nests** (2026-09-18, user's decision 「둥지 반경 60 m 리시 · 초기 수 절반 ·
 * 재스폰 50/35/15 %」 + 「둥지의 장식 알을 부숬 수 있는 적으로」).
 *
 * It answers three things about this raid's nests.
 *
 * ① **Eggs** — one `bug_egg` per spot of `WorldRef.getNestEggSpots()` (`world:ready`, authority only). An egg is a fixed target
 *    that does not move · attack · notice (`Enemy.isEgg`), and since its size varies 0.35–0.7 m per spot a **per-instance
 *    `EnemyStats` copy** plus `rig.baseScale` keep 「the drawn egg = the hit box」 matched. The spot's `position` is the
 *    **centre of the drawn sphere**, so the feet (= `Enemy.position`) sit `radius × EGG_CENTER_MUL` below it. Replicas see it
 *    through `ee spawn` as usual — no new wire. Planet raids only: `getNestEggSpots()` is empty in the training range · the tutorial, so this file does nothing.
 *
 * ② **Nest anchor** — where 「what a person calls one nest」 stands (`NestEggSpot.nest` = the pad index). `getNestPositions()` lists
 *    4–6 holes (mounds) per nest in a row and indexes differently, so **it is not used to find a pad.** The anchor is the
 *    **centroid** of that pad's egg spots — eggs ring the foot of the mounds, so their middle is the middle of the nest.
 *    `AmbientSpawner` uses this anchor as 「the nest」 in the raid-start placement (the `nests` argument), and the group that stands there becomes its garrison.
 *
 * ③ **Garrison · refills** — the garrison remembers its nest in `Enemy.nestOf` and `ai/NestLeash` leashes it at `NEST_LEASH_M` (60 m).
 *    The raid-start count is halved by `NEST_INITIAL_GARRISON_MUL` (0.5), which multiplies the group count in `Spawner.initialPopulate`.
 *    Per nest, **how many refills this raid allows** is rolled once from the world seed (`NEST_REFILL_COUNT_CHANCE` — 1 refill 50 % ·
 *    2 refills 35 % · 3 refills 15 %). The roll is a stream of its own from `Random.hash('nest@<seed>')`, so it touches not one world ·
 *    named roll and a host change answers the same. When that nest's living **mobile** bugs (eggs are not `isCombatant`, so they never
 *    count) fall to the initially laid count × `NEST_REFILL_TRIGGER_FRAC` or below, one refill fires and a group digs out of the nest
 *    (`BURROW_EMERGE_S` — the same path as a patrol). Once the allotted refills are spent that nest stays empty until the raid ends.
 *
 * All of it is the authority's decision (host · single-player) and there is **no new wire** — replicas only see `ee spawn`. `nestOf`
 * is host memory, so a host change releases the leash and they become plain bugs (the same intent as `escortOf` in `ai/ArtilleryPack`).
 */
import * as THREE from 'three';
import { BURROW_EMERGE_S, Random, type NestEggSpot, type PlanetEcosystem, type WorldRef } from '@/shared';
import type { Enemy } from './Enemy';
import { ENEMY_STATS } from './EnemyTypes';
import {
  NEST_REFILL_CHECK_S, NEST_REFILL_COUNT_CHANCE, NEST_REFILL_TRIGGER_FRAC, type BugThreatTuning, bugThreatTuning,
} from './factionTables';
import { EGG_CENTER_MUL, setEggScale } from './models/EggModel';
import { ambientCap, ambientGroup, ambientOptsOf, spawnGroup, type SpawnHost } from './Spawner';

/** One nest of this raid (an authority-only record). */
interface NestState {
  /** `NestEggSpot.nest` — the pad index verbatim (for the record · debug). */
  readonly pad: number;
  /** The middle of the nest (the centroid of that pad's egg spots). The leash's reference point and where a refill digs out. */
  readonly anchor: THREE.Vector3;
  /** Refills left this raid. */
  refillsLeft: number;
  /** How many bodies the garrison was laid with (0 = no garrison stood at this nest → no refill trigger either). */
  garrison: number;
}

/** Raid summary (debug · smokes — `EnemySystem.debugNests()`). */
export interface NestPlacement {
  /** How many eggs were placed. */
  eggs: number;
  /** Per-nest record (the anchor index = `Enemy.nestOf`). */
  nests: Array<{ pad: number; refills: number; garrison: number; x: number; z: number }>;
}

const _p = new THREE.Vector3();

export class NestDirector {
  private host: SpawnHost | null = null;
  private readonly nests: NestState[] = [];
  private readonly anchorList: THREE.Vector3[] = [];
  private checkT = 0;
  /** Raid summary (authority, once). */
  placement: NestPlacement | null = null;
  /** This raid's effective ecosystem · difficulty · ramp threat — the refill group's composition (`EnemySystem` puts them in at `world:ready`). */
  eco: PlanetEcosystem | null = null;
  tuning: BugThreatTuning = bugThreatTuning(1);
  threat = 0.35;

  bind(host: SpawnHost): void { this.host = host; }

  /** The anchors `AmbientSpawner.initialPopulate` uses as 「the nests」 (empty = it uses `getNestPositions()` as before). */
  get anchors(): readonly THREE.Vector3[] { return this.anchorList; }

  reset(): void {
    this.nests.length = 0;
    this.anchorList.length = 0;
    this.checkT = 0;
    this.placement = null;
  }

  /**
   * `world:ready` (authority, not the training range · tutorial) — places the eggs and rolls each nest's refill count.
   * It must be called **before `AmbientSpawner.initialPopulate`** (a garrison only stands at a nest once the anchors exist).
   */
  onWorldReady(): void {
    const host = this.host;
    const world = host?.ctx.world;
    this.reset();
    if (!host || !world?.ready) return;
    const spots = world.getNestEggSpots();
    if (spots.length === 0) return;           // the training range · the tutorial · a map with no nests

    // ① the centroid per pad = the nest anchor
    const sum = new Map<number, { x: number; y: number; z: number; n: number }>();
    for (const s of spots) {
      const pad = s.nest;
      if (!Number.isInteger(pad) || pad < 0) continue;
      const acc = sum.get(pad) ?? { x: 0, y: 0, z: 0, n: 0 };
      acc.x += s.position.x; acc.y += s.position.y; acc.z += s.position.z; acc.n++;
      sum.set(pad, acc);
    }
    // ② the refill count per nest — its own stream off the world seed (the same trick as `named/Director`). Ascending pad order keeps the roll order fixed.
    const rng = new Random(Random.hash(`nest@${world.seed >>> 0}`));
    const placement: NestPlacement = { eggs: 0, nests: [] };
    for (const pad of [...sum.keys()].sort((a, b) => a - b)) {
      const acc = sum.get(pad)!;
      const anchor = new THREE.Vector3(acc.x / acc.n, 0, acc.z / acc.n);
      anchor.y = world.getHeightAt(anchor.x, anchor.z);
      const refills = rollRefills(rng);
      this.nests.push({ pad, anchor, refillsLeft: refills, garrison: 0 });
      this.anchorList.push(anchor);
      placement.nests.push({ pad, refills, garrison: 0, x: anchor.x, z: anchor.z });
    }

    // ③ eggs — one body per spot
    for (const s of spots) if (this.spawnEgg(host, s)) placement.eggs++;
    this.placement = placement;
  }

  /**
   * One egg body. The spot's `position` is the **centre of the drawn sphere**, so the feet (= `Enemy.position`) sit
   * `radius × EGG_CENTER_MUL` below it. The size is not set here — `parts/Pool.acquire` applies it with `applyEggSize` on **both** authority and replica.
   */
  private spawnEgg(host: SpawnHost, spot: NestEggSpot): boolean {
    const base = ENEMY_STATS.bug_egg;
    const r = Number.isFinite(spot.radius) && spot.radius > 0 ? spot.radius : base.radius;
    // the spot vector is a live entry of the world — it is only read, never changed
    _p.set(spot.position.x, spot.position.y - r * EGG_CENTER_MUL, spot.position.z);
    return host.spawn('bug_egg', _p, Math.random() * Math.PI * 2, false, false) !== null;
  }

  /**
   * Binds the bodies that just stood up at anchor `index` (from index `from` of the active list) as that nest's garrison —
   * called right after `Spawner.initialPopulate` placed the group.
   */
  claimGarrison(index: number, host: SpawnHost, from: number): void {
    const nest = this.nests[index];
    if (!nest) return;
    const list = host.active;
    for (let i = from; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.isEgg || e.isHumanoid) continue;
      e.nestOf = index;
      e.nestReturning = false;
      e.guardPos.copy(nest.anchor);
      nest.garrison++;
    }
    const rec = this.placement?.nests[index];
    if (rec) rec.garrison = nest.garrison;
  }

  /**
   * The host tick (the authority branch of `EnemySystem.update`, not the training range · tutorial). Every `NEST_REFILL_CHECK_S`
   * it counts each nest's survivors and fires one refill at every nest past the trigger.
   */
  update(dt: number, host: SpawnHost): void {
    if (this.nests.length === 0) return;
    this.checkT -= dt;
    if (this.checkT > 0) return;
    this.checkT = Math.max(0.25, NEST_REFILL_CHECK_S);
    for (let i = 0; i < this.nests.length; i++) {
      const nest = this.nests[i];
      if (nest.refillsLeft <= 0 || nest.garrison <= 0) continue;
      if (countNestBugs(host, i) > Math.floor(nest.garrison * Math.max(0, NEST_REFILL_TRIGGER_FRAC))) continue;
      if (this.refill(host, nest, i)) nest.refillsLeft--;
    }
  }

  /** One refill — a group digs out of the nest (the `BURROW_EMERGE_S` path a patrol takes). Placing not one body spends no refill. */
  private refill(host: SpawnHost, nest: NestState, index: number): boolean {
    const types = ambientGroup(this.threat, this.eco, ambientOptsOf(this.tuning));
    if (types.length === 0) return false;
    const allowed = host.ensureCapacity(types.length, ambientCap(this.threat, this.eco));
    if (allowed <= 0) return false;
    const from = host.active.length;
    if (spawnGroup(host, types.slice(0, allowed), nest.anchor, false, false, undefined, BURROW_EMERGE_S) <= 0) return false;
    this.claimGarrisonOnly(index, host, from, nest);
    return true;
  }

  /** Binds bodies a refill placed to this nest — `garrison` (the trigger's denominator) must stay **the initially laid count**, so it is kept apart. */
  private claimGarrisonOnly(index: number, host: SpawnHost, from: number, nest: NestState): void {
    const list = host.active;
    for (let i = from; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.isEgg || e.isHumanoid) continue;
      e.nestOf = index;
      e.nestReturning = false;
      e.guardPos.copy(nest.anchor);
    }
  }

  /** Debug · smokes: refills left per nest · how many are alive right now. */
  debugState(host: SpawnHost): Array<{ pad: number; anchorIndex: number; refillsLeft: number; garrison: number; alive: number }> {
    return this.nests.map((n, i) => ({ pad: n.pad, anchorIndex: i, refillsLeft: n.refillsLeft, garrison: n.garrison, alive: countNestBugs(host, i) }));
  }
}

/**
 * Matches one egg's **size** to its spot's radius (`parts/Pool.acquire` calls it for the egg type only).
 *
 * It picks the egg spot nearest the (x, z) under the feet from the spot list and uses that radius — a world builds identically
 * on every client for the same seed, so **host and replica get the same answer**. That is why no radius field was added to
 * `ee spawn` (the same trick `BUG_HP_MUL_BY_THREAT` uses to match the hp multiplier with no wire). No spot found = the csv size.
 *
 * The body (`rig.baseScale`) and the hit capsule (`stats.radius` / `height` / `headRadius`) take the **same multiplier** — the
 * egg is the only type that carries a per-instance copy of `EnemyStats` (the `Enemy` constructor), so it spreads to no other
 * egg · other type. `hp` is independent of size (one csv row) — a small egg is not a weak one.
 */
export function applyEggSize(e: Enemy, world: WorldRef): void {
  const base = ENEMY_STATS.bug_egg;
  const spots = world.getNestEggSpots();
  let best = -1, bestD = Infinity;
  for (let i = 0; i < spots.length; i++) {
    const p = spots[i].position;
    const dx = p.x - e.position.x, dz = p.z - e.position.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  const raw = best >= 0 ? spots[best].radius : base.radius;
  const r = Number.isFinite(raw) && raw > 0 ? raw : base.radius;
  const k = r / Math.max(0.05, base.radius);
  e.stats.radius = base.radius * k;
  e.stats.height = base.height * k;
  e.stats.headRadius = base.headRadius * k;
  if (e.rig.kind === 'egg') { setEggScale(e.rig, r); e.rig.root.scale.setScalar(e.rig.baseScale); }
}

/** One roll of `NEST_REFILL_COUNT_CHANCE` → how many refills that nest may have this raid (index k = k+1 refills). */
function rollRefills(rng: Random): number {
  const table = NEST_REFILL_COUNT_CHANCE;
  let total = 0;
  for (const w of table) if (Number.isFinite(w) && w > 0) total += w;
  if (total <= 0) return 0;
  let r = rng.next() * total;
  for (let i = 0; i < table.length; i++) {
    const w = Number.isFinite(table[i]) && table[i] > 0 ? table[i] : 0;
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return i + 1;
  }
  return table.length;
}

/** How many **living, fighting** bugs belong to that nest (eggs are `isCombatant` false, so they drop out — `Enemy.isEgg`). */
function countNestBugs(host: SpawnHost, index: number): number {
  const list = host.active;
  let n = 0;
  for (let i = 0; i < list.length; i++) if (list[i].nestOf === index && list[i].isCombatant) n++;
  return n;
}
