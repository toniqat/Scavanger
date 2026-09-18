/**
 * src/enemies/RogueDrop.ts — **raider drops** (2026-09-09 rogue drops → 2026-09-13 raider waves).
 *
 * The question this file answers: *what happens when an abandoned outpost · lab · rail platform is searched.*
 *
 * world/ emits `structure:investigated {zoneId, kind, position}` when that zone's container is investigated the **first** time.
 * The host rolls the **per-planet-threat chance** exactly once for that zone (`RAIDER_DROP_CHANCE_BY_THREAT`, threat 1 = 0 →
 * not even rolled), and on a success a **raider** squad comes down from the sky:
 *
 *   announced (`rogueDrop:incoming` + `rdrop incoming`) → `ROGUE_DROP_ETA_S` s of falling →
 *   landing (`rogueDrop:landed` + `rdrop landed`) → raiders spawn → **advance on the trigger point (the structure)**
 *
 * The names (`rogueDrop:*` · `rdrop` · `callRogueDrop` · `getRogueDrops` · `ROGUE_DROP_ETA_S` · `ROGUE_DROP_RADIUS`) are a
 * contract and stay. The wording people see ("레이더 강하") belongs to ui/.
 *
 * ## Waves (2026-09-13, user's decision)
 * One drop is **at most two waves**, and each wave's size comes from the squad size — `RAIDER_DROP_WAVE1_*` ·
 * `RAIDER_DROP_WAVE2_*` in `data/tables.csv` (index 0 = a squad of 1): 1 → 3 · 2 → 3 then 2 · 3 → 3 then 3 · 4 → 4 then 3–4.
 * A wave never exceeds `RAIDER_DROP_WAVE_MAX` (4). The second wave is an **independently announced drop** `RAIDER_DROP_WAVE_GAP_S`
 * (10) s after the first announcement — dropId `${zoneId}#2`, its own `rdrop incoming` / `landed`, its own pods · landing spots
 * (seed = that dropId). A replica knows nothing of waves: each `rdrop` it gets is one drop. One squad per wave (`allocSquadId`),
 * exactly one `flanker`, site `'drop'`; no squad leader (`rogue_boss` — `RogueDropView.boss` is always false). The second wave
 * is **a reservation the host holds** — a host change inside those 10 s and that wave never comes (a known limit).
 *
 * ## Telling everyone (2026-09-10)
 * A drop must not happen quietly. All this file plays is **the pod impact sound (`rogue_pod_impact`)**; the radio alarm
 * (`rogue_drop_alarm`) and the air-tearing fall roar (`rogue_pod_fall`) are played by `audio/AudioSystem` off
 * `rogueDrop:incoming` — both gated not by perception but by the dedicated radius `ROGUE_DROP_ALERT_RADIUS`, falling off
 * with distance inside it. The screen side is `ui/hud/RaidAlerts` (the toast) and `ui/hud/DangerIndicators` (on screen = a
 * head marker · off screen = a direction arc). It sounds once per wave.
 *
 * ## Host authority · once per zone
 * **Only the host** rolls and the result flows out as `rdrop`. "This zone is already used" comes from two places:
 *  1. `used` — every zone this client saw (the host's own rolls + the zones of an **`rdrop incoming` a replica received** —
 *     written under the zoneId with `#2` stripped too). A replica records them, so a promoted host never re-rolls that zone.
 *  2. `StructureDef.rogueDropUsed` from `ctx.world.getStructures()` — the per-structure flag world/ fills in through
 *     `struct sync`. It covers someone who joined mid-raid, never saw an `rdrop`, and then becomes the host.
 * Either one true = no roll. The first wave's `dropId` is `structure:investigated.zoneId` verbatim, so both records use the
 * same key. **A failed roll counts as "rolled" too** (user's rule: it happens once per zone). The roll itself is a seed stream
 * of `worldSeed ^ hash(zoneId)`, so whoever is host gets the same answer.
 *
 * ## The population cap
 * Drop troops **do not go through** `AmbientSpawner`'s `ensureCapacity` — they call `host.spawnRogue` directly, so the cap
 * cannot trim the head count. Nor do they silently disappear: the recycling pass skips `e.isHumanoid`.
 * They do count in `aliveCount()` though, so **ambient bug patrols shrink by that much** — intended.
 *
 * ## The pod
 * Generated in code in this file with no external asset (`player/Hellpod` · the rescue pod in `stratagems` were **only
 * referenced**, never imported — the enemy pod is a red hexagonal capsule, a different silhouette from the friendly hellpod).
 * Geometry · materials are shared per module and `disposeRogueDropAssets()` cleans them up at mission reset.
 */
import * as THREE from 'three';
import {
  ROGUE_DROP_ETA_S, ROGUE_DROP_RADIUS, Random,
  type EnemySquadRole, type RogueDropView, type Vec3Tuple,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import type { Enemy } from './Enemy';
import { HUMANOID_WEAPONS, ROGUE_AI } from './EnemyTypes';
import { beginInvestigation } from './ai/Investigate';
import { tuple } from './net/HostSync';
import type { RogueSpawnHost } from './RogueGuards';
/* ── tables · constants (data/tables.csv · data/constants.csv → factionTables.ts) ────────────────────── */
import {
  RAIDER_DROP_CHANCE_BY_THREAT as DROP_CHANCE_BY_THREAT, RAIDER_DROP_WAVE1_MAX as WAVE1_MAX, RAIDER_DROP_WAVE1_MIN as WAVE1_MIN,
  RAIDER_DROP_WAVE2_MAX as WAVE2_MAX, RAIDER_DROP_WAVE2_MIN as WAVE2_MIN, RAIDER_DROP_WAVE_GAP_S as WAVE_GAP_S,
  RAIDER_DROP_WAVE_MAX as WAVE_MAX,
} from './factionTables';

/* ── FX constants (timing, not balance numbers, so not csv) ──────────────────────────────────────────── */
/** The altitude the pod appears at (m). A dot in the sky at the announcement, growing sharply just before landing. */
const POD_HEIGHT = 420;
/** Exponent of the fall acceleration curve (1 = constant speed; larger crowds it into the end). */
const POD_FALL_EXP = 2.4;
/** How long a landed pod stays in the world (s). After that its geometry is released. */
const POD_LINGER_S = 30;
/** Minimum gap between landing spots (m) — passed to `scatterPoints`. */
const POD_MIN_GAP = 4.5;
/** Fall smoke particle interval (s). */
const SMOKE_INTERVAL = 0.08;
/** Smoke only below this altitude (m) — particles high up are not even visible and just eat the pool. */
const SMOKE_MAX_ALT = 140;
/** Maximum distance at which a landing impact shakes the screen (m). */
const IMPACT_SHAKE_DIST = 45;
/** Index range of the drop head-count tables (a squad of 1..4). */
const MAX_SQUAD = 4;
/** The second wave's dropId suffix (`${zoneId}#2`). */
const WAVE2_SUFFIX = '#2';
/** Salt for the landing-spot seed · the slot seed. */
const POINT_SALT = 0x5bf03635;
const SLOT_SALT = 0x2545f491;

/** `zone#2` → `zone` (a first-wave id is unchanged). */
export function dropZoneOf(dropId: string): string {
  return dropId.endsWith(WAVE2_SUFFIX) ? dropId.slice(0, -WAVE2_SUFFIX.length) : dropId;
}

/** What rides down to one landing spot (the type is always `raider`). */
interface Slot { weaponId: string; role: EnemySquadRole }

/* ══ the procedural pod ══════════════════════════════════════════════════════════════════════════════ */

interface PodAssets {
  geo: THREE.BufferGeometry[];
  hull: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  burn: THREE.MeshStandardMaterial;
}
let assets: PodAssets | null = null;

function getAssets(): PodAssets {
  if (assets) return assets;
  const glow = new THREE.MeshStandardMaterial({ color: 0x2a0a08, roughness: 0.4, metalness: 0.3 });
  glow.emissive.setHex(0xff3322); glow.emissiveIntensity = 1.4;
  const burn = new THREE.MeshStandardMaterial({ color: 0x2a1000, roughness: 0.5, metalness: 0.2 });
  burn.emissive.setHex(0xff8a20); burn.emissiveIntensity = 0;
  assets = {
    geo: [
      new THREE.CylinderGeometry(0.62, 0.84, 1.9, 6),   // 0 body
      new THREE.ConeGeometry(0.64, 0.8, 6),             // 1 nose cone
      new THREE.CylinderGeometry(0.88, 0.88, 0.16, 6),  // 2 glow band
      new THREE.BoxGeometry(0.09, 1.05, 0.62),          // 3 fin
      new THREE.CylinderGeometry(0.4, 0.62, 0.5, 6),    // 4 retro nozzle
    ],
    hull: new THREE.MeshStandardMaterial({ color: 0x4a2b26, roughness: 0.72, metalness: 0.45 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x14100f, roughness: 0.6, metalness: 0.6 }),
    glow, burn,
  };
  return assets;
}

/** Mission reset: releases the geometry · materials the pod made (called from `EnemySystem.disposePools`). */
export function disposeRogueDropAssets(): void {
  if (!assets) return;
  for (const g of assets.geo) g.dispose();
  assets.hull.dispose(); assets.dark.dispose(); assets.glow.dispose(); assets.burn.dispose();
  assets = null;
}

/**
 * The retro glow is **one shared material**, so it is put back to 0 every frame and the pods falling that frame raise it
 * with `Math.max` (a material per pod would make eight of them in a single drop).
 */
function resetPodBurn(): void {
  if (assets) assets.burn.emissiveIntensity = 0;
}

const _fxDir = new THREE.Vector3(0, 1, 0);

/**
 * One drop pod. It accelerates down from the sky over `fallTime` seconds and buries itself at `landing`.
 * Pure FX that changes no state — the enemy spawn is `RogueDropDirector`'s, done separately at the landing time.
 */
class RogueDropPod {
  readonly group = new THREE.Group();
  private readonly landing = new THREE.Vector3();
  private readonly burn: THREE.MeshStandardMaterial;
  private t = 0;
  private fallTime = 1;
  private smoke = 0;
  /** true while falling (false once landed — it still stays in the world). */
  falling = false;
  active = false;

  constructor() {
    const a = getAssets();
    this.burn = a.burn;
    this.group.name = 'RogueDropPod';
    const hull = new THREE.Mesh(a.geo[0], a.hull);
    hull.position.y = 0.95;
    this.group.add(hull);
    const nose = new THREE.Mesh(a.geo[1], a.hull);
    nose.position.y = 2.3;
    this.group.add(nose);
    const band = new THREE.Mesh(a.geo[2], a.glow);
    band.position.y = 1.55;
    this.group.add(band);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const fin = new THREE.Mesh(a.geo[3], a.dark);
      fin.position.set(Math.cos(ang) * 0.78, 0.6, Math.sin(ang) * 0.78);
      fin.rotation.y = -ang;
      this.group.add(fin);
    }
    const bell = new THREE.Mesh(a.geo[4], a.burn);
    bell.position.y = -0.12;
    this.group.add(bell);
  }

  get position(): THREE.Vector3 { return this.group.position; }

  start(landing: THREE.Vector3, yaw: number, fallTime: number): void {
    this.landing.copy(landing);
    this.fallTime = Math.max(0.2, fallTime);
    this.t = 0;
    this.smoke = 0;
    this.falling = true;
    this.active = true;
    this.group.rotation.set(0, yaw, 0);
    this.group.position.set(landing.x, landing.y + POD_HEIGHT, landing.z);
    this.group.visible = true;
  }

  /** Plants it at the spot it was already falling to (the host's `rdrop landed` arrived before the local timer). */
  snapDown(): void {
    this.t = 1;
    this.falling = false;
    this.group.position.copy(this.landing);
  }

  /** One tick. true if it touched the ground this frame. */
  update(dt: number, fx: FxManager | null): boolean {
    if (!this.active || !this.falling) return false;
    this.t = Math.min(1, this.t + dt / this.fallTime);
    const rest = 1 - this.t;
    this.group.position.y = this.landing.y + POD_HEIGHT * Math.pow(rest, POD_FALL_EXP);
    // the retro burn comes on in the last 1.2 s
    const brake = this.t > 0.82 ? (this.t - 0.82) / 0.18 : 0;
    this.burn.emissiveIntensity = Math.max(this.burn.emissiveIntensity, brake * 2.5);
    // smoke only at a visible altitude — particles 400 m up are invisible anyway and just eat the pool
    if (fx && this.group.position.y - this.landing.y < SMOKE_MAX_ALT) {
      this.smoke -= dt;
      if (this.smoke <= 0) {
        this.smoke = SMOKE_INTERVAL;
        ParticleBurst.dust(fx.alpha, this.group.position, _fxDir, 2, 1.1, 0x6a5a50);
      }
    }
    if (this.t >= 1) {
      this.falling = false;
      this.group.position.copy(this.landing);
      // buried at a slight tilt — a perfectly upright pod does not read as a prop
      this.group.rotation.x = (Math.random() - 0.5) * 0.16;
      this.group.rotation.z = (Math.random() - 0.5) * 0.16;
      return true;
    }
    return false;
  }

  retire(): void {
    this.active = false;
    this.falling = false;
    this.group.visible = false;
  }
}

/* ══ a drop in progress ═══════════════════════════════════════════════════════════════════════════════ */

interface Drop {
  /** This wave's dropId (`zone` or `zone#2`). */
  id: string;
  /** The trigger point = the structure's centre. The goal the raiders advance on and the centre the pods scatter around. */
  readonly position: THREE.Vector3;
  count: number;
  landsAt: number;
  points: THREE.Vector3[];
  slots: Slot[];
  pods: RogueDropPod[];
  landed: boolean;
  /** Has the host finished the actual spawn (always false on a replica — enemies arrive as `es` / `ee`). */
  spawned: boolean;
  /** When the pods are cleared away after landing. */
  retireAt: number;
}

/** The second wave the host has reserved. */
interface PendingWave { id: string; position: THREE.Vector3; count: number; at: number }

/** What RogueDrop requires of EnemySystem. */
export interface RogueDropHost extends RogueSpawnHost {
  /** Does this client simulate enemies (single-player or host). */
  readonly authority: boolean;
  /** Is it the host inside a session (= must it broadcast `rdrop`). */
  readonly hosting: boolean;
  /** Is this the simulated training range. */
  readonly training: boolean;
  /** 2026-09-13: the threat of this raid's target planet (1..3, decided at `world:ready` — no planet = 1). */
  readonly planetThreatLevel: 1 | 2 | 3;
  playAudio(id: string, position: THREE.Vector3, volume?: number, pitch?: number): void;
}

const _p = new THREE.Vector3();
const _spawn = new THREE.Vector3();

function dropSeed(worldSeed: number, dropId: string): number {
  return (((worldSeed >>> 0) ^ Random.hash(dropId) ^ POINT_SALT) >>> 0);
}

/**
 * Owns raider drops end to end. On the host: the roll · wave reservation · spawn · broadcast; on every client: the pod FX.
 */
export class RogueDropDirector {
  private host!: RogueDropHost;
  private readonly drops: Drop[] = [];
  /** The second wave the host reserved. */
  private readonly pending: PendingWave[] = [];
  /** Zones already rolled (success or failure alike). A replica fills it from `rdrop incoming` too. */
  private readonly used = new Set<string>();
  private readonly podPool: RogueDropPod[] = [];
  private readonly viewBuf: RogueDropView[] = [];
  private viewsDirty = true;
  /** Debug · smoke: rolls this raid / drops (zones) actually called / waves dropped. */
  rolls = 0;
  calls = 0;
  waves = 0;
  /** Debug · smoke: treat the squad size as this value (1..4) (null = the real head count). Mission reset clears it. */
  squadOverride: number | null = null;

  bind(host: RogueDropHost): void { this.host = host; }

  /* ── the trigger ─────────────────────────────────────────────────────── */
  /**
   * `structure:investigated` — that zone was investigated for the first time. **Only the host** rolls, and the roll itself is
   * recorded (a failure too: it happens once per zone). On a planet with no drops (threat 1) it neither rolls nor records.
   */
  onInvestigated(zoneId: string, position: THREE.Vector3): void {
    const host = this.host;
    if (!host || !host.authority || host.training) return;
    const ctx = host.ctx;
    if (ctx.isTraining() || !ctx.world?.ready) return;
    if (this.hasRolled(zoneId)) return;
    const chance = this.dropChance();
    if (chance <= 0) return;
    this.used.add(zoneId);
    this.rolls++;
    // seeded roll: whoever is host (even after a transfer), the same zone gives the same answer
    const rng = new Random((((ctx.world.seed >>> 0) ^ Random.hash(zoneId)) >>> 0));
    if (!rng.chance(chance)) return;
    this.call(zoneId, this.dropTargetFor(ctx.world, zoneId, position));
  }

  /** This planet's drop chance (`RAIDER_DROP_CHANCE_BY_THREAT[threat − 1]`, 0..1). */
  private dropChance(): number {
    const t = this.host.planetThreatLevel ?? 1;
    const raw = DROP_CHANCE_BY_THREAT[Math.max(0, Math.min(DROP_CHANCE_BY_THREAT.length - 1, t - 1))];
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  }

  /**
   * 2026-09-11 (C-18): the drop target. A structure · fixed platform keeps the investigation point. But a **container inside a
   * tram** (zoneId `tram_<lineId>`) hands over the tram's position at the moment of investigation, so a moving tram would drop
   * the pods mid-track and leave the squad guarding empty rail. So it is swapped for the **nearest platform** on that line —
   * the tram docks at a platform in the end. A line with no platform (there should be none) keeps the original point.
   */
  private dropTargetFor(world: NonNullable<RogueDropHost['ctx']['world']>, zoneId: string, position: THREE.Vector3): THREE.Vector3 {
    if (!zoneId.startsWith('tram_')) return position;
    const lines = world.getRailLines();
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const plats = lines[i].platforms;
      for (let j = 0; j < plats.length; j++) {
        const p = plats[j].position;
        const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    return best ?? position;
  }

  /** Has this zone been rolled — this file's own record + `StructureDef.rogueDropUsed`, which world/ syncs. */
  private hasRolled(zoneId: string): boolean {
    if (this.used.has(zoneId)) return true;
    const structures = this.host?.ctx.world?.getStructures();
    if (!structures) return false;
    for (let i = 0; i < structures.length; i++) {
      if (structures[i].id === zoneId) return structures[i].rogueDropUsed === true;
    }
    return false;
  }

  /* ── EnemyManagerRef.callRogueDrop ───────────────────────────────────── */
  /**
   * Host only. Drops the raiders' first wave around `position` and, when the squad head-count table gives a second wave,
   * reserves it `RAIDER_DROP_WAVE_GAP_S` later (dropId `${dropId}#2`). It does not look at the planet threat — only the
   * investigation trigger does. false when the same `dropId` is in progress · reserved, when not the host, or with no room.
   */
  call(dropId: string, position: THREE.Vector3): boolean {
    const host = this.host;
    if (!host || !host.authority || host.training) return false;
    const ctx = host.ctx;
    const world = ctx.world;
    if (!world?.ready || ctx.isTraining()) return false;
    const wave2 = dropId + WAVE2_SUFFIX;
    if (this.find(dropId) || this.find(wave2) || this.pending.some((w) => w.id === wave2)) return false;

    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, this.squadSize() - 1));
    const rng = new Random(dropSeed(world.seed, dropId));
    const n1 = waveCount(rng, WAVE1_MIN, WAVE1_MAX, idx);
    const n2 = waveCount(rng, WAVE2_MIN, WAVE2_MAX, idx);   // always rolled — so the stream does not shift with the head-count table
    if (n1 <= 0 || !this.launch(dropId, position, n1)) return false;
    this.calls++;
    if (n2 > 0) this.pending.push({ id: wave2, position: position.clone(), count: n2, at: ctx.time + Math.max(0, WAVE_GAP_S) });
    return true;
  }

  /** Announces one wave (host): landing spots · pods · event · `rdrop incoming`. false when there is no room. */
  private launch(id: string, position: THREE.Vector3, count: number): boolean {
    const host = this.host;
    const ctx = host.ctx;
    const world = ctx.world!;
    const seed = dropSeed(world.seed, id);
    const points = world.scatterPoints(position, ROGUE_DROP_RADIUS, count, POD_MIN_GAP, seed);
    if (points.length === 0) return false;       // with too few spots, only that many come down
    const drop = this.begin(id, position, points.length, ROGUE_DROP_ETA_S, points, seed);
    this.waves++;
    ctx.bus.emit('rogueDrop:incoming', { dropId: id, position: drop.position.clone(), count: drop.count, boss: false, eta: ROGUE_DROP_ETA_S });
    if (host.hosting) {
      ctx.net!.send({ t: 'rdrop', ev: 'incoming', dropId: id, p: tuple(drop.position, 2), eta: ROGUE_DROP_ETA_S, count: drop.count, boss: false }, 'others');
    }
    return true;
  }

  /** Drops in progress (announcement ~ landing, one row per wave). Read by ui/'s HUD warning · off-screen arrow. */
  views(): readonly RogueDropView[] {
    if (this.viewsDirty) {
      this.viewBuf.length = 0;
      for (const d of this.drops) {
        if (d.landed) continue;
        this.viewBuf.push({ id: d.id, position: d.position, count: d.count, boss: false, landsAt: d.landsAt });
      }
      this.viewsDirty = false;
    }
    return this.viewBuf;
  }

  /** Debug · smoke: the reserved second waves (a copy). */
  pendingWaves(): Array<{ id: string; count: number; at: number }> {
    return this.pending.map((w) => ({ id: w.id, count: w.count, at: w.at }));
  }

  /* ── the wire (non-host) ─────────────────────────────────────────────── */
  /** `rdrop incoming` — the host announced a drop (one wave). No enemy is made here (the existing `es` / `ee` path). */
  onIncomingWire(dropId: string, p: Vec3Tuple, eta: number, count: number, _boss: boolean): void {
    const host = this.host;
    if (!host || host.authority) return;                  // the host does not take its own broadcast back
    this.used.add(dropId);
    this.used.add(dropZoneOf(dropId));                    // even once promoted, this zone is never rolled again
    if (this.find(dropId)) return;
    const ctx = host.ctx;
    if (!ctx.world?.ready) return;
    _p.set(p[0], p[1], p[2]);
    const n = Math.max(0, Math.min(16, Math.round(count)));
    if (n === 0) return;
    const seed = dropSeed(ctx.world.seed, dropId);
    // the host's seed · the host's arguments → the same landing spots. The pods land exactly where the raiders will stand.
    const points = ctx.world.scatterPoints(_p, ROGUE_DROP_RADIUS, n, POD_MIN_GAP, seed);
    if (points.length === 0) return;
    const drop = this.begin(dropId, _p, points.length, Math.max(0.5, eta), points, seed);
    ctx.bus.emit('rogueDrop:incoming', { dropId, position: drop.position.clone(), count: drop.count, boss: false, eta: Math.max(0.5, eta) });
  }

  /** `rdrop landed` — the host confirmed the landing. If the local timer has not run out, it is put down now. */
  onLandedWire(dropId: string): void {
    const host = this.host;
    if (!host || host.authority) return;
    const drop = this.find(dropId);
    if (!drop || drop.landed) return;                     // a drop whose announcement was missed is ignored (the enemies arrive as `ee spawn`)
    this.land(drop);
  }

  /* ── the tick ────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const host = this.host;
    if (!host) return;
    if (this.pending.length > 0) this.launchDueWaves();
    if (this.drops.length === 0) return;
    const ctx = host.ctx;
    const now = ctx.time;
    const fx = FxManager.get();
    resetPodBurn();                              // the shared glow is rebuilt from 0 every frame
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const drop = this.drops[i];
      for (const pod of drop.pods) {
        if (pod.update(dt, fx)) this.impactFx(pod.position);
      }
      if (!drop.landed && now >= drop.landsAt) this.land(drop);
      if (drop.landed && now >= drop.retireAt) {
        for (const pod of drop.pods) { pod.retire(); this.podPool.push(pod); }
        drop.pods.length = 0;
        this.drops.splice(i, 1);
      }
    }
  }

  /** Launches a second wave whose reserved time has come. Dropped if the authority was lost meanwhile (host transfer). */
  private launchDueWaves(): void {
    const host = this.host;
    const ctx = host.ctx;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const w = this.pending[i];
      if (ctx.time < w.at) continue;
      this.pending.splice(i, 1);
      if (!host.authority || host.training || ctx.isTraining() || !ctx.world?.ready || this.find(w.id)) continue;
      this.launch(w.id, w.position, w.count);
    }
  }

  /** Mission reset: throws away the roll records · drops in progress · reservations · pods. */
  reset(): void {
    for (const drop of this.drops) for (const pod of drop.pods) { pod.retire(); this.podPool.push(pod); }
    this.drops.length = 0;
    this.pending.length = 0;
    this.used.clear();
    this.viewBuf.length = 0;
    this.viewsDirty = true;
    this.rolls = 0;
    this.calls = 0;
    this.waves = 0;
    this.squadOverride = null;
  }

  /** dispose: removes the pods from the scene and releases the geometry. */
  dispose(scene: THREE.Object3D): void {
    this.reset();
    for (const pod of this.podPool) scene.remove(pod.group);
    this.podPool.length = 0;
  }

  /* ── internals ───────────────────────────────────────────────────────── */
  private find(dropId: string): Drop | null {
    for (const d of this.drops) if (d.id === dropId) return d;
    return null;
  }

  /** Squad size (1..4). Single-player is 1. */
  private squadSize(): number {
    if (this.squadOverride != null && Number.isFinite(this.squadOverride)) return Math.max(1, Math.min(MAX_SQUAD, Math.round(this.squadOverride)));
    const net = this.host.ctx.net;
    let n = 1;
    if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
    return Math.max(1, Math.min(MAX_SQUAD, n));
  }

  /**
   * Builds the announced state (host · replica alike): the slot composition + the pods start falling. The sound is audio/'s.
   * The slots (weapon · flanker) are rolled from `seed` — host and replica see the same one (the replica just never uses it).
   */
  private begin(id: string, position: THREE.Vector3, count: number, eta: number, points: THREE.Vector3[], seed: number): Drop {
    const ctx = this.host.ctx;
    const rng = new Random((seed ^ SLOT_SALT) >>> 0);
    const weapons = HUMANOID_WEAPONS.raider;
    const flanker = rng.int(0, Math.max(0, count - 1));
    const slots: Slot[] = [];
    for (let i = 0; i < count; i++) {
      slots.push({
        weaponId: weapons.length > 0 ? weapons[rng.int(0, weapons.length - 1)] : 'ar',
        role: i === flanker ? 'flanker' : 'member',
      });
    }
    const drop: Drop = {
      id, position: position.clone(), count,
      landsAt: ctx.time + eta, points, slots, pods: [],
      landed: false, spawned: false, retireAt: Infinity,
    };
    for (let i = 0; i < points.length; i++) {
      const pod = this.acquirePod();
      const yaw = Math.atan2(position.x - points[i].x, position.z - points[i].z);
      pod.start(points[i], yaw, eta);
      drop.pods.push(pod);
    }
    this.drops.push(drop);
    this.viewsDirty = true;
    /*
     * 2026-09-10 — **the alarm · the fall roar do not sound here.** Only `rogueDrop:incoming` is emitted, and
     * `audio/AudioSystem` takes it and plays `rogue_drop_alarm` (the radio alarm, now) and `rogue_pod_fall`
     * (the air-tearing roar, `ROGUE_DROP_FALL_LEAD_S` s before landing). There are two reasons:
     *  ① the sound's **distance falloff** is a function of the dedicated radius `ROGUE_DROP_ALERT_RADIUS` (nothing to do
     *     with perception), and that curve must not overlap the panner's, so only audio/, which knows `panOnly`, can compute it,
     *  ② the announcement and the roar happen at **different times** — sounding it all 8 s early leaves the landing quiet.
     * The event goes out from both the host and the replica (`onIncomingWire`), so in multiplayer everyone hears it.
     * Only each pod's own landing impact (`rogue_pod_impact`) stays in `impactFx`, because its position is the pod itself.
     */
    return drop;
  }

  private acquirePod(): RogueDropPod {
    const pod = this.podPool.pop();
    if (pod) { pod.active = true; return pod; }
    const fresh = new RogueDropPod();
    this.host.ctx.scene.add(fresh.group);
    return fresh;
  }

  /** Landing: the event · the broadcast · (on the host) the actual spawn + the advance order. */
  private land(drop: Drop): void {
    const host = this.host;
    const ctx = host.ctx;
    drop.landed = true;
    drop.retireAt = ctx.time + POD_LINGER_S;
    this.viewsDirty = true;
    for (const pod of drop.pods) if (pod.falling) { pod.snapDown(); this.impactFx(pod.position); }
    ctx.bus.emit('rogueDrop:landed', { dropId: drop.id, position: drop.position.clone(), count: drop.count, boss: false });
    if (host.hosting) ctx.net!.send({ t: 'rdrop', ev: 'landed', dropId: drop.id, p: tuple(drop.position, 2) }, 'others');
    if (!host.authority || drop.spawned) return;
    drop.spawned = true;
    this.spawnSquad(drop);
  }

  /** Host: stands a raider at each landing spot and sends them at the trigger point. One wave = one squad (one flanker). */
  private spawnSquad(drop: Drop): void {
    const host = this.host;
    const world = host.ctx.world;
    if (!world?.ready) return;
    const squadId = host.allocSquadId();
    const spawned: Enemy[] = [];
    for (let i = 0; i < drop.points.length && i < drop.slots.length; i++) {
      const slot = drop.slots[i];
      _spawn.copy(drop.points[i]);
      world.resolveCollision(_spawn, 1.0);
      _spawn.y = world.getHeightAt(_spawn.x, _spawn.z);
      const yaw = Math.atan2(drop.position.x - _spawn.x, drop.position.z - _spawn.z);
      // guardPos = the structure: once the advance ends they hold and patrol that spot (the existing humanoid guard AI)
      const e = host.spawnRogue('raider', _spawn, yaw, drop.position, slot.weaponId, null, { site: 'drop', squadId, role: slot.role });
      if (!e) continue;
      e.leash = ROGUE_AI.leash;
      // they advance to the structure on the existing investigate/advance path — seeing anyone on the way starts the fight
      beginInvestigation(e, drop.position);
      spawned.push(e);
    }
    // if the flanker's slot failed to spawn, the first member takes the role
    if (spawned.length > 0 && !spawned.some((e) => e.squadRole === 'flanker')) spawned[0].squadRole = 'flanker';
  }

  private impactFx(p: THREE.Vector3): void {
    const host = this.host;
    const ctx = host.ctx;
    const fx = FxManager.get();
    if (fx) {
      ParticleBurst.groundBlast(fx.alpha, p, 42, 10, 0x8f7f66, 0.4);
      ParticleBurst.dust(fx.alpha, p, _fxDir, 12, 1.6);
      ParticleBurst.sparks(fx.additive, p, _fxDir, 10, 6, 0xff8844);
    }
    // 2026-09-10: the impact sound of an **enemy pod**, not the friendly hellpod (`hellpod_impact`) — lower, with debris
    host.playAudio('rogue_pod_impact', p, 0.9, 0.9);
    const player = ctx.player?.position;
    if (player) {
      const d = Math.hypot(player.x - p.x, player.z - p.z);
      if (d < IMPACT_SHAKE_DIST) ctx.bus.emit('camera:shake', { intensity: 0.55 * (1 - d / IMPACT_SHAKE_DIST), duration: 0.3 });
    }
  }
}

/** One roll of a wave's head count — the `[lo, hi]` table cell (missing = 0) → clamped by `RAIDER_DROP_WAVE_MAX`. */
function waveCount(rng: Random, minTable: readonly number[], maxTable: readonly number[], idx: number): number {
  const lo = Math.max(0, Math.round(Number.isFinite(minTable[idx]) ? minTable[idx] : 0));
  const hi = Math.max(lo, Math.round(Number.isFinite(maxTable[idx]) ? maxTable[idx] : lo));
  const n = rng.int(lo, hi);
  return Math.min(n, Math.max(1, Math.round(Number.isFinite(WAVE_MAX) ? WAVE_MAX : 4)));
}
