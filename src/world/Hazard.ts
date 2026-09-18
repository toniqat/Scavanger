/**
 * src/world/Hazard.ts — **environmental hazard** (`HazardRef`, published as `ctx.world.hazard`).
 *
 * A planet-wide phenomenon that starts at one time in **30 s steps** between `HAZARD_START_MIN_S` and
 * `HAZARD_START_MAX_S` after the raid begins (spores alone are fixed at `SPORE_START_S`) and covers the map
 * over `HAZARD_FULL_S`. Inside it `HAZARD_DPS` is taken every `HAZARD_TICK_S` and sight narrows; at the end
 * no safe area is left — in practice a forced extraction timer.
 *
 * **No wire in normal play.** Kind · start time · zone shapes are all functions of `the mission seed + missionTime`,
 * so every client answers the same (the same philosophy as `Fog`). Only a late joiner asks `hzq sync` and takes
 * the plan from the host's `hz sync {data}`(= `serialize()`).
 *
 * Owned contract: `HazardKind` · `HazardZone` · `HazardSource` · `HazardRef` · `WorldRef.hazard`,
 * `hazard:planned / announced / started / progress / insideChanged`, `atmo:override`,
 * `HazardMessage`(`hz`) / `HazardRequest`(`hzq`), the `HAZARD_*` · `STORM_EYE_*` · `SPORE_*` constants,
 * `PlanetDef.hazards` (`data/planets.csv`). Look numbers are `data/hazards.csv` (read by `hazard/model.ts`).
 *
 * Sight is narrowed **only through `atmo:override`** — `core/Atmosphere` takes that one and lays it on fog · sky.
 * `src/core/` is not touched.
 */
import * as THREE from 'three';
import {
  HAZARD_DPS, HAZARD_DPS_MAX, HAZARD_EDGE_M, HAZARD_FOG_MUL, HAZARD_FOG_RAMP_END, HAZARD_FOG_RAMP_START,
  HAZARD_SPORES_BYPASS_SHIELD, HAZARD_TICK_S,
  HAZARD_WARN_S, Random,
  type GameContext, type HazardKind, type HazardRef, type HazardSource, type HazardZone, type PeerId,
} from '@/shared';
import { PLAY_LIMIT, type BuildCtx } from './build';
import { ATMO_EPS, PROGRESS_EMIT_S, type HazardPlan, type HazardRow, hazardRow } from './hazard/model';
import { HAZARD_FORK, drawHazardKind, planGroveSpots, planHazard } from './hazard/parts/Plan';
import { buildZones, maxDepth, progressAt } from './hazard/parts/Zones';
import { Groves } from './hazard/parts/Grove';
import { HazardVisuals } from './hazard/parts/Visuals';
import type { PlayerDamageOptions, PlayerDamageSource } from '@/shared';

/** 2026-09-15 (result screen rework): the hazard damage source — one per kind, reused (not allocated per tick). */
const HAZARD_DAMAGE_SOURCES = new Map<HazardKind, PlayerDamageSource>();
function hazardDamageSource(kind: HazardKind): PlayerDamageSource {
  let s = HAZARD_DAMAGE_SOURCES.get(kind);
  if (!s) { s = Object.freeze({ kind: 'hazard' as const, hazard: kind }); HAZARD_DAMAGE_SOURCES.set(kind, s); }
  return s;
}

/**
 * 2026-09-15 (user's decision): **spores alone** bypass the shield and take hp directly (`HAZARD_SPORES_BYPASS_SHIELD`).
 * Every other hazard (sandstorm · blizzard · storm eye) is `undefined` — the shield takes it first, exactly as before.
 * One frozen constant is reused so that no object is allocated per tick.
 */
const SPORE_DAMAGE_OPTS: PlayerDamageOptions = Object.freeze({ bypassShield: true });
function hazardDamageOpts(kind: HazardKind): PlayerDamageOptions | undefined {
  return kind === 'spores' && HAZARD_SPORES_BYPASS_SHIELD ? SPORE_DAMAGE_OPTS : undefined;
}

/** Grove discovery check interval (s). Fog is painted at 5 Hz, so there is no reason to look more often. */
const DISCOVER_INTERVAL_S = 0.5;
/** Smallest change that re-emits `atmo:override` when only progress moves the sight multiplier in a zone (2026-09-13). */
const FOG_MUL_EPS = 0.1;

/* ── 2026-09-15 (`nearestSafePoint`) — all **geometric clearance**, not balance numbers (the same place as `ATMO_EPS`). ── */
/** Extra clearance (m) so a candidate never lands exactly on the edge — float error would put it back "inside". */
const ZONE_SLACK = 0.25;
/** Spacing (m) of the rings scanned over an overlapping field of circles. */
const SAFE_RING_STEP_M = 8;
/** Maximum number of rings scanned (= it looks out to radius `SAFE_RING_STEP_M × this count`). */
const SAFE_RING_STEPS = 40;

/** 2026-09-13 — damage per second at `progress`: linear from `HAZARD_DPS` (start) to `HAZARD_DPS_MAX` (map covered). */
function dpsAt(progress: number): number {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return HAZARD_DPS + (HAZARD_DPS_MAX - HAZARD_DPS) * p;
}

export class Hazard implements HazardRef {
  private plan: HazardPlan | null = null;
  private row: HazardRow | null = null;
  private game: GameContext | null = null;
  private root: THREE.Group | null = null;

  private readonly groves = new Groves();
  private readonly visuals = new HazardVisuals();
  /** Grove spots taken on a planet whose candidates include `spores` (`Gather` plants harvest mushrooms around them). */
  private groveSpots: Array<{ x: number; z: number }> = [];

  /** The array `getZones()` returns and its zone pool (zero allocation per frame). */
  private readonly zones: HazardZone[] = [];
  private readonly zonePool: HazardZone[] = [];
  private zonesAt = -1;
  private readonly sources: HazardSource[] = [];
  /** Grove ids that already emitted `fog:discovered`. */
  private readonly discovered = new Set<string>();

  private announcedFlag = false;
  private startedFlag = false;
  private insideFlag = false;
  private damageTimer = 0;
  /** 2026-09-11 (C-14): the damage tick for disconnected squadmates (ghosts) — it runs apart from the local tick. */
  private ghostTimer = 0;
  private progressTimer = 0;
  private lastProgress = -1;
  private discoverTimer = 0;
  private lastBlend = 0;
  /** The last `atmo:override.fogMul` sent (2026-09-13 — the progress ramp changes it even when blend stays). */
  private lastFogMul = 1;

  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * `candidates` = `PlanetDef.hazards` (the planet's candidates). With an empty array it builds nothing and returns
   * **false** — the caller (`WorldSystem`) then leaves `ctx.world.hazard` null.
   *
   * Must be called **before** props and crates: the giant mushroom stems have to be in the `SpatialHash` for
   * `isSpotFree` to avoid a grove spot (so no rock stands in the middle of a grove).
   */
  build(ctx: BuildCtx, game: GameContext, candidates: readonly HazardKind[]): boolean {
    this.game = game;
    this.root = ctx.root;
    if (candidates.length === 0) return false;

    const biomeId = ctx.biome?.id ?? null;
    /* 2026-09-13: this raid's kind was decided **before the layout** — `WorldSystem` drew it with the same function and picked a
     * central drop · outer pads for spores. Drawing it again here gives the same value (the root's `'hazard'` fork, first draw). */
    const drawn = drawHazardKind(ctx.rng, candidates, biomeId);
    // Grove spots use a fork **independent** of the hazard draw. Central on a spore raid, scattered over the whole map otherwise (2026-09-13)
    if (candidates.includes('spores')) {
      this.groveSpots = planGroveSpots(ctx, ctx.rng.fork('hazardGroves'), drawn === 'spores');
      this.groves.build(ctx, ctx.rng.fork('hazardGroveMesh'), this.groveSpots);
    }

    // 2026-09-10: the biome is passed too — on snow-covered terrain a sandstorm becomes a blizzard (`Plan.SNOWY_BIOMES`).
    // 2026-09-13: the drop point is passed too — the sandstorm · blizzard front enters from that edge of the map.
    // 2026-09-14: intel 「기상 예보」 — adds seconds to the start time (added after the roll, so the draw count stays)
    const plan = planHazard(ctx.rng.fork(HAZARD_FORK), candidates, this.groveSpots, biomeId, ctx.layout.spawn,
      game.missionIntel?.hazardDelayS ?? 0);
    if (!plan) return false;
    this.plan = plan;
    this.row = hazardRow(plan.kind) ?? null;
    if (this.row) {
      this.visuals.build(ctx.root, this.row, plan, HazardVisuals.ringsFor(plan));
      this.visuals.warm(game.shaders);
    }
    this.rebuildSources();
    this.ensureNet();
    this.requestSync();

    game.bus.emit('hazard:planned', { kind: plan.kind, startsAt: plan.startsAt });
    return true;
  }

  /**
   * What `WorldRef.hazard` returns. null with no plan (a planet with no candidates · a seed that found no spot) —
   * the object itself still lives (a grove is a terrain feature, so it can stand even with no hazard).
   */
  get ref(): HazardRef | null { return this.plan ? this : null; }

  /** Grove spots (`Gather` plants harvest mushrooms around them). Groves can stand even when the hazard is not spores. */
  getGroveSpots(): ReadonlyArray<{ x: number; z: number }> { return this.groveSpots; }

  dispose(): void {
    // The atmosphere override must be restored on the way out — otherwise sight stays narrow into the next mission
    if (this.lastBlend > 0) this.game?.bus.emit('atmo:override', { fogMul: 1, color: null, blend: 0 });
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.netHooked = false;
    this.visuals.dispose();
    this.groves.dispose();
    this.groveSpots = [];
    this.zones.length = 0;
    this.zonePool.length = 0;
    this.sources.length = 0;
    this.discovered.clear();
    this.zonesAt = -1;
    this.announcedFlag = false;
    this.startedFlag = false;
    this.lastProgress = -1;
    this.progressTimer = 0;
    this.damageTimer = 0;
    this.ghostTimer = 0;
    this.discoverTimer = 0;
    this.plan = null;
    this.row = null;
    this.game = null;
    this.root = null;
    this.lastBlend = 0;
    this.lastFogMul = 1;
    this.insideFlag = false;
  }

  /* ── HazardRef ─────────────────────────────────────────────────────── */

  get kind(): HazardKind | null { return this.plan?.kind ?? null; }
  get startsAt(): number { return this.plan?.startsAt ?? -1; }
  get announced(): boolean { return this.announcedFlag; }
  get active(): boolean {
    const p = this.plan;
    return !!p && !!this.game && this.game.missionTime >= p.startsAt;
  }
  get progress(): number {
    const p = this.plan;
    return p && this.game ? progressAt(p, this.game.missionTime) : 0;
  }
  /** 2026-09-13: damage per second now / `HAZARD_DPS` — 1 → `HAZARD_DPS_MAX / HAZARD_DPS` (enemies' silent damage multiplies by it). */
  get damageMul(): number {
    return HAZARD_DPS > 0 ? dpsAt(this.progress) / HAZARD_DPS : 1;
  }

  isInside(x: number, z: number): boolean {
    if (!this.active) return false;
    return maxDepth(this.getZones(), x, z) > 0;
  }

  /**
   * 2026-09-15 (android squadmates) — the **nearest safe spot** from `(x, z)`. Safe = every zone's penetration depth
   * is at most `-margin` (`margin` m inside the edge). null when the map is fully covered or there is no hazard.
   *
   * Two steps. ① Per zone it builds 「the nearest point out of that one」 — a half-plane (`front`) is pushed along its
   * normal, a danger-inside circle outward, a danger-outside circle (the storm eye) inward. A hazard with one zone
   * (sandstorm · blizzard · storm eye) gets an **exact** answer here. ② With several circles (spores) a candidate can
   * land in another circle, so an expanding ring is scanned and the first point that passes is used (an approximation).
   * `out.y` is the terrain height at that spot (0 with no world).
   */
  nearestSafePoint(x: number, z: number, margin: number, out: THREE.Vector3): THREE.Vector3 | null {
    const zones = this.active ? this.getZones() : null;
    const m = Number.isFinite(margin) && margin > 0 ? margin : 0;
    const limit = PLAY_LIMIT - m;
    const safe = (px: number, pz: number): boolean =>
      Math.abs(px) <= limit && Math.abs(pz) <= limit && (!zones || zones.length === 0 || maxDepth(zones, px, pz) <= -m);
    const write = (px: number, pz: number): THREE.Vector3 => {
      out.set(px, this.game?.world?.getHeightAt(px, pz) ?? 0, pz);
      return out;
    };
    if (safe(x, z)) return write(x, z);
    if (!zones || zones.length === 0) return null;

    let bestX = 0, bestZ = 0, bestD = Infinity;
    const offer = (px: number, pz: number): void => {
      if (!safe(px, pz)) return;
      const d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < bestD) { bestD = d; bestX = px; bestZ = pz; }
    };
    for (let i = 0; i < zones.length; i++) {
      const zn = zones[i];
      if (zn.shape === 'front') {
        // Signed distance = (p − center)·dir. Safety needs ≥ m, so it is pushed along the normal by what is missing.
        const dot = (x - zn.center.x) * zn.dirX + (z - zn.center.z) * zn.dirZ;
        const need = m + ZONE_SLACK - dot;
        if (need > 0) offer(x + zn.dirX * need, z + zn.dirZ * need);
        continue;
      }
      const dx = x - zn.center.x, dz = z - zn.center.z;
      const d = Math.hypot(dx, dz);
      const ux = d > 1e-4 ? dx / d : 1, uz = d > 1e-4 ? dz / d : 0;
      if (zn.safeInside) {
        // Danger outside (the storm eye): inward to radius − margin. With no eye that large left there is no candidate.
        const r = zn.radius - m - ZONE_SLACK;
        if (r > 0 && d > r) offer(zn.center.x + ux * r, zn.center.z + uz * r);
      } else {
        const r = zn.radius + m + ZONE_SLACK;
        offer(zn.center.x + ux * r, zn.center.z + uz * r);
      }
    }
    if (bestD < Infinity) return write(bestX, bestZ);

    // Every candidate landed in another zone (overlapping spore circles) — scan with a widening ring
    for (let step = 1; step <= SAFE_RING_STEPS; step++) {
      const r = step * SAFE_RING_STEP_M;
      const n = Math.max(8, Math.min(64, Math.round((2 * Math.PI * r) / SAFE_RING_STEP_M)));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        offer(x + Math.cos(a) * r, z + Math.sin(a) * r);
      }
      if (bestD < Infinity) return write(bestX, bestZ);
    }
    return null;
  }

  getZones(): readonly HazardZone[] {
    const p = this.plan;
    const t = this.game?.missionTime ?? 0;
    if (!p) return this.zones;
    if (t !== this.zonesAt) {
      this.zonesAt = t;
      buildZones(p, t, this.zonePool, this.zones);
    }
    return this.zones;
  }

  getSources(): readonly HazardSource[] {
    return this.plan?.kind === 'spores' ? this.sources : EMPTY_SOURCES;
  }

  /* ── per frame ─────────────────────────────────────────────────────── */

  update(dt: number, ctx: GameContext): void {
    const plan = this.plan;
    if (!plan) return;
    this.ensureNet();
    this.groves.update(ctx.time);

    const t = ctx.missionTime;
    const active = t >= plan.startsAt;

    // announced → started
    if (!this.announcedFlag && t >= plan.startsAt - HAZARD_WARN_S) {
      this.announcedFlag = true;
      const left = Math.max(0, Math.round(plan.startsAt - t));
      ctx.bus.emit('hazard:announced', { kind: plan.kind, secondsLeft: left });
    }
    if (!this.startedFlag && active) {
      this.startedFlag = true;
      this.announcedFlag = true;
      ctx.bus.emit('hazard:started', { kind: plan.kind });
    }

    const zones = this.getZones();

    // Progress — only a few times per second (the contract comment)
    const pr = progressAt(plan, t);
    if (active) {
      this.progressTimer -= dt;
      if (this.progressTimer <= 0 && Math.abs(pr - this.lastProgress) > 1e-4) {
        this.progressTimer = PROGRESS_EMIT_S;
        this.lastProgress = pr;
        ctx.bus.emit('hazard:progress', { kind: plan.kind, progress: pr });
      }
    }

    // Source state (has it bloomed · is it out of the fog)
    this.discoverTimer -= dt;
    if (this.discoverTimer <= 0) {
      this.discoverTimer = DISCOVER_INTERVAL_S;
      this.refreshSources(ctx, t);
    }

    // Damage · sight
    const p = ctx.player;
    const alive = !!p && !p.isDead && !p.isInShip && !p.isDropping;
    const playable = alive && ctx.isGameplayPhase() && !ctx.isTraining();
    const depth = p ? maxDepth(zones, p.position.x, p.position.z) : -Infinity;
    const inside = active && playable && depth > 0;

    if (inside !== this.insideFlag) {
      this.insideFlag = inside;
      ctx.bus.emit('hazard:insideChanged', { inside, kind: inside ? plan.kind : null });
    }

    if (inside && p) {
      this.damageTimer += dt;
      // Even on a long frame spike, damage is taken exactly once per `HAZARD_TICK_S`
      while (this.damageTimer >= HAZARD_TICK_S) {
        this.damageTimer -= HAZARD_TICK_S;
        // 2026-09-13: a hazard grows stronger over time — `HAZARD_DPS` at progress 0, `HAZARD_DPS_MAX` at 1
        // 2026-09-13: a rider inside the rover takes no hazard damage (the vehicle takes it — world/rover). Sight · alerts are unchanged.
        // 2026-09-15 (result screen rework): source `hazard` + the hazard kind
        // 2026-09-15 (user's decision): spores alone bypass the shield and take hp directly (`HAZARD_SPORES_BYPASS_SHIELD`).
        // The `PLANET_ENV_DPS` reasoning that armor stopping the atmosphere is odd — every other hazard still hits the shield first.
        if (!p.roverRide) p.takeDamage(dpsAt(pr) * HAZARD_TICK_S, undefined, hazardDamageSource(plan.kind), hazardDamageOpts(plan.kind));
      }
    } else {
      this.damageTimer = 0;
    }

    this.tickGhosts(dt, ctx, active, zones, pr);

    // 0 → 1 over `HAZARD_EDGE_M` from the edge. Gated on the **same condition** as `insideChanged` — a screen that
    // fogs up while dead or in the ship goes out of step with the HUD's "위험 구역" readout.
    const raw = active && playable && depth > -Infinity ? depth / (HAZARD_EDGE_M > 0 ? HAZARD_EDGE_M : 1) : 0;
    const blend = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
    // 2026-09-10: how hard sight is narrowed **differs per hazard** (`data/hazards.csv` fogMul). The storm eye is
    // far larger so only the PC's surroundings stay visible inside the storm — that is what makes "the safe area
    // is inside that wall over there" readable. `HAZARD_FOG_MUL` is left only as the fallback when no row is found.
    // 2026-09-13: that strength **rises with progress** — (fogMul − 1) is multiplied by `HAZARD_FOG_RAMP_START` → `END`.
    const baseFog = this.row ? this.row.fogMul : HAZARD_FOG_MUL;
    const ramp = HAZARD_FOG_RAMP_START + (HAZARD_FOG_RAMP_END - HAZARD_FOG_RAMP_START) * pr;
    const peak = Math.max(1, 1 + (baseFog - 1) * ramp);
    const fogMul = 1 + (peak - 1) * blend;
    if (Math.abs(blend - this.lastBlend) > ATMO_EPS || (blend === 0 && this.lastBlend !== 0)
      || (blend > 0 && Math.abs(fogMul - this.lastFogMul) > FOG_MUL_EPS)) {
      this.lastBlend = blend;
      this.lastFogMul = fogMul;
      ctx.bus.emit('atmo:override', {
        fogMul,
        color: blend > 0 && this.row ? this.row.fogColor : null,
        blend,
      });
    }

    this.visuals.update(dt, ctx.time, ctx.camera, zones, this.lastBlend, active, pr);
  }

  /**
   * 2026-09-11 (C-14 · X-7) — **a disconnected squadmate's body (ghost) takes hazard damage too.** It used to be the
   * local check above only, so a body whose socket had dropped stood unharmed in the storm until the raid ended.
   *
   * A ghost is **simulated by the authority (solo · host)** and its one damage entry is `ghost:damage`, the same as
   * an enemy attack (`player/RemotePlayerSystem.damageGhost` — shield → hp → downed → death is the order there). So
   * this only emits that event every `HAZARD_TICK_S` for a `suspended` squadmate inside a zone. No new wire — the
   * host's `ghost state` already broadcasts the result. It is a **different timer** from the local tick: a
   * disconnected player's body keeps taking damage even when the host is dead or in the ship. Enemies' silent DoT is `enemies/`.
   */
  private tickGhosts(dt: number, ctx: GameContext, active: boolean, zones: readonly HazardZone[], progress: number): void {
    const net = ctx.net;
    if (!active || !net || !ctx.isAuthority || !ctx.isGameplayPhase() || ctx.isTraining()) { this.ghostTimer = 0; return; }
    this.ghostTimer += dt;
    if (this.ghostTimer < HAZARD_TICK_S) return;
    // Exactly as many ticks even on a long frame spike — the same total as the local damage `while`, in one event
    const ticks = Math.floor(this.ghostTimer / HAZARD_TICK_S);
    this.ghostTimer -= ticks * HAZARD_TICK_S;
    const amount = dpsAt(progress) * HAZARD_TICK_S * ticks;   // 2026-09-13: the same ramp as local damage
    const refs = net.getRemotePlayers();
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      if (!r.suspended || !r.inMission || r.isDead || r.ghostState === 2) continue;
      if (maxDepth(zones, r.position.x, r.position.z) <= 0) continue;
      ctx.bus.emit('ghost:damage', { id: r.id, amount });
    }
  }

  /* ── sources (giant mushroom groves) ───────────────────────────────── */

  private rebuildSources(): void {
    this.sources.length = 0;
    const plan = this.plan;
    if (!plan) return;
    for (let i = 0; i < plan.sources.length; i++) {
      const s = plan.sources[i];
      this.sources.push({
        id: `grove_${i}`,
        position: new THREE.Vector3(s.x, 0, s.z),
        radius: plan.sourceRadius,
        erupted: false,
        discovered: false,
      });
    }
  }

  /**
   * Refreshes source state and emits `fog:discovered {kind:'grove'}` **the first time a grove leaves the fog**.
   * It raises no toast — that wording is owned by ui/ (the same reason `grove` is not in `Fog.TOAST`).
   *
   * User's request: **discovering every grove** tells the player in advance where the spores will start 6 minutes
   * later. So `discovered` looks only at the fog, whatever the hazard kind is.
   */
  private refreshSources(ctx: GameContext, missionTime: number): void {
    const fog = ctx.world?.fog ?? null;
    const plan = this.plan;
    // A grove stands even when the hazard is not spores — the discovery event is emitted then too (it is terrain)
    for (const g of this.groves.getDefs()) {
      if (this.discovered.has(g.id)) continue;
      if (fog && !fog.isDiscovered(g.position)) continue;
      this.discovered.add(g.id);
      ctx.bus.emit('fog:discovered', { kind: 'grove', id: g.id, position: g.position });
    }
    if (!plan) return;
    const defs = this.groves.getDefs();
    for (let i = 0; i < this.sources.length; i++) {
      const src = this.sources[i];
      const p = plan.sources[i];
      if (!p) continue;
      // If the grove was built, its terrain height is used as is (the map reads only xz, but world markers read y)
      const def = defs[i];
      if (def) src.position.y = def.position.y;
      src.erupted = missionTime >= p.eruptAt;
      src.discovered = fog ? fog.isDiscovered(src.position) : true;
    }
  }

  /* ── multiplayer (late joiners only) ───────────────────────────────── */

  serialize(): string {
    return this.plan ? JSON.stringify(this.plan) : '';
  }

  /**
   * Takes the host's plan as is. With the same seed · the same planet it is already the same value and nothing
   * changes — this path is a safety net for a client whose seed is out of step (an older peer · a tampered save).
   */
  applySerialized(data: string): void {
    if (!data) return;
    let next: HazardPlan | null = null;
    try { next = JSON.parse(data) as HazardPlan; } catch { return; }
    if (!next || typeof next.kind !== 'string' || !Number.isFinite(next.startsAt)) return;
    if (!Array.isArray(next.sources)) next.sources = [];
    const prev = this.plan;
    if (prev && prev.kind === next.kind && prev.startsAt === next.startsAt && prev.sources.length === next.sources.length) {
      this.plan = next;
      this.zonesAt = -1;
      this.rebuildSources();
      return;
    }
    this.plan = next;
    this.zonesAt = -1;
    this.rebuildSources();
    const row = hazardRow(next.kind) ?? null;
    this.row = row;
    // A different kind rebuilds the walls · particles (the groves are terrain and are left alone — README `Hazards`)
    if (row && this.root) {
      this.visuals.dispose();
      this.visuals.build(this.root, row, next, HazardVisuals.ringsFor(next));
      this.visuals.warm(this.game?.shaders);
    }
    console.warn(`[Hazard] 호스트의 계획으로 교체했다 — ${next.kind} @ ${next.startsAt}s`);
  }

  private ensureNet(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('hz', (m) => {
        if (m.ev === 'sync' && !ctx.net?.isHost) this.applySerialized(m.data);
      }),
      net.onMessage('hzq', (m, from) => {
        if (m.ev === 'sync' && ctx.net?.isHost) this.sendSync(from);
      }),
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && ctx.net?.isHost) this.sendSync(from);
      }),
      // The promoted host's plan becomes the truth — the same convention as Fog / Gather
      ctx.bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestSync(); }),
    );
  }

  private requestSync(): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || net.isHost) return;
    net.send({ t: 'hzq', ev: 'sync' }, 'host');
  }

  private sendSync(to: PeerId): void {
    const ctx = this.game;
    const net = ctx?.net;
    if (!ctx || !net || !ctx.isMultiplayer || !this.plan) return;
    net.send({ t: 'hz', ev: 'sync', data: this.serialize() }, to);
  }

  /* ── debug / smoke ─────────────────────────────────────────────────── */

  /** A copy of the plan that lets a smoke check the zones without winding time forward. */
  get debugPlan(): Readonly<HazardPlan> | null { return this.plan; }
  /** The value a smoke uses to check that the plan reproduces from the same seed. */
  static debugPlanFor(seed: number, candidates: readonly HazardKind[], spots: ReadonlyArray<{ x: number; z: number }>): HazardPlan | null {
    return planHazard(new Random(seed >>> 0).fork(HAZARD_FORK), candidates, spots);
  }
}

const EMPTY_SOURCES: readonly HazardSource[] = [];
