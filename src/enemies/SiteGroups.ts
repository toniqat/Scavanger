/**
 * src/enemies/SiteGroups.ts — **site occupation** (2026-09-13, per-planet enemy factions).
 *
 * The question this file answers: *when a raid starts, which humanoids stand at which site, and in how many groups.*
 * Decision: docs/DECISIONS.md 「2026-09-13 — 행성별 적 팩션」. It replaces the old crate guards (`placeRogueGuards`).
 *
 * ## Rules (planet threat = `planetThreat`, no planet = 1)
 *  - threat 1 — per lab · outpost, **androids** in 1 indoor + 1–2 outdoor groups (1–2 per group). Platforms · ruins are empty.
 *  - threat 2 — labs · outposts are **always occupied**: per site rogues 65 % / raiders 35 %, 1 indoor + 1 outdoor group (3–4 per group).
 *    A rail platform = 1 rogue group at 60 %, a ruin outpost = 1 rogue group at 50 %. One rogue group is led by a rogue boss at 40 % (at most 1 per raid).
 *  - threat 3 — the same spots · chances as threat 2, but **all raiders**.
 *  - The crashed ship is empty at every threat (it is only the raider-drop trigger).
 * Chances · head counts all come from the `SITE_*` tables of `data/tables.csv` (key = threat − 1); only the faction rule (1 = android) is code.
 *
 * ## Squads
 * Every group gets a `squadId` of its own from `allocSquadId()`. A raider group has **exactly one** `flanker` (the humanoid AI owns its AI),
 * and a rogue group with a boss has `rogue_boss` (`leader`) in the first spot and the rest `escortOf` = the boss. `site` = the site kind
 * (`StructureKind` · `platform` · `ruin`) — an input to corpse loot.
 *
 * ## Spots
 * `WorldRef.getSiteSpawnPoints(siteId, place, count, minGap, seed)` is asked for **more than that place's head-count sum**, then each
 * group is bundled from an anchor (first group = the first candidate, later groups = the candidate farthest from the earlier anchors) and
 * the candidates nearest it — two outdoor groups stand scattered around the site while one group stands together. Indoor spots running
 * short are filled with outdoor candidates. A build whose world does not carry that query yet (an optional method) uses the minimal
 * `scatterPoints` fallback path. `guardPos` = the site centre, leash = site radius + `SITE_GROUP_LEASH_INDOOR_M` / `_OUTDOOR_M` (escorts: `spawnRogue` sets `escortLeash`).
 *
 * ## Determinism (host only · once at `world:ready`)
 * Per site one `worldSeed ^ hash('sites:<siteId>')` stream rolls occupation · faction · group count · head count · weapons · the flanker —
 * one site's rolls never shift another's. The boss has a separate `hash('sites:boss')` stream. The spot seed is a `siteId:place` hash too.
 * The same seed + the same planet = the same placement. Enemies flow through the existing `spawnRogue` → `ee spawn` and replicas know
 * nothing of sites (only the corpse's `si` goes over `ee corpse`).
 *
 * Population cap: it does not pass `ensureCapacity`. Humanoids are not recycling candidates (`isHumanoid`) — the same as the old crate guards.
 */
import * as THREE from 'three';
import {
  Random,
  type EnemySpawnSite, type EnemySquadRole, type EnemyType, type SiteSpawnPlace, type WorldRef,
} from '@/shared';
import type { Enemy } from './Enemy';
import { HUMANOID_WEAPONS, ROGUE_AI } from './EnemyTypes';
import type { RogueSpawnHost } from './RogueGuards';
import {
  SITE_BOSS_CHANCE as BOSS_CHANCE, SITE_BOSS_MAX_PER_RAID as BOSS_MAX_PER_RAID, SITE_GROUP_LEASH_INDOOR_M as LEASH_INDOOR,
  SITE_GROUP_LEASH_OUTDOOR_M as LEASH_OUTDOOR, SITE_GROUP_MIN_GAP_M as GROUP_MIN_GAP, SITE_GROUP_SIZE_MAX as GROUP_SIZE_MAX,
  SITE_GROUP_SIZE_MIN as GROUP_SIZE_MIN, SITE_INDOOR_GROUPS as INDOOR_GROUPS, SITE_OCCUPY_CHANCE_PLATFORM as OCCUPY_PLATFORM,
  SITE_OCCUPY_CHANCE_RUIN as OCCUPY_RUIN, SITE_OCCUPY_CHANCE_STRUCTURE as OCCUPY_STRUCTURE, SITE_OUTDOOR_GROUPS_MAX as OUTDOOR_GROUPS_MAX,
  SITE_OUTDOOR_GROUPS_MIN as OUTDOOR_GROUPS_MIN, SITE_RAIDER_SHARE_OUTLYING as RAIDER_SHARE_OUTLYING,
  SITE_RAIDER_SHARE_STRUCTURE as RAIDER_SHARE_STRUCTURE, byThreat as at,
  SITE_OUTLYING_GROUP_SIZE_MAX, SITE_OUTLYING_GROUP_SIZE_MIN,
} from './factionTables';

/* ── Search parameters (not balance numbers) ──────────────────────────────────────────────────────────── */
/** Extra candidates asked for on top of one place's head-count sum — room to pick a group that stands together. */
const CANDIDATE_EXTRA = 6;
/** Fallback path: the indoor scatter radius = the site radius × this. */
const FALLBACK_INDOOR_FRAC = 0.4;
/** Fallback path: the outdoor ring runs from the site radius + this (m) to + `FALLBACK_OUTDOOR_WIDTH`. */
const FALLBACK_OUTDOOR_GAP = 3;
const FALLBACK_OUTDOOR_WIDTH = 14;

/** The humanoid faction that occupies a site. */
export type SiteFaction = 'android' | 'rogue' | 'raider';

export interface SiteGroupMember { id: number; type: EnemyType; role: EnemySquadRole; weapon: string; x: number; y: number; z: number }
export interface SiteGroupRecord {
  squadId: number;
  place: SiteSpawnPlace;
  faction: SiteFaction;
  /** Whether a rogue boss leads this group. */
  leader: boolean;
  /** The rolled head count (`members` is smaller when spots run short). */
  planned: number;
  members: SiteGroupMember[];
}
export interface SiteRecord {
  siteId: string;
  site: EnemySpawnSite;
  occupied: boolean;
  faction: SiteFaction | null;
  groups: SiteGroupRecord[];
}
export interface SitePlacement {
  threat: 1 | 2 | 3;
  sites: SiteRecord[];
  /** The site's rogue boss (null when there is none). */
  boss: Enemy | null;
  /** How many humanoids were placed. */
  humanoids: number;
  /** Where the spots came from — `world` = `getSiteSpawnPoints`, `fallback` = the `scatterPoints` fallback path. */
  source: 'world' | 'fallback';
}

interface SiteRef { id: string; site: EnemySpawnSite; center: THREE.Vector3; radius: number; outlying: 'platform' | 'ruin' | null }
interface GroupPlan { place: SiteSpawnPlace; size: number; weapons: string[]; flanker: number; leader: boolean; yawSeed: number }
interface SitePlan { ref: SiteRef; faction: SiteFaction | null; groups: GroupPlan[] }

const _tmp = new THREE.Vector3();

/** This map's site list (the world's array order = seed-deterministic). The crashed ship is left out. */
function collectSites(world: WorldRef): SiteRef[] {
  const out: SiteRef[] = [];
  for (const s of world.getStructures()) {
    if (s.kind === 'wreck') continue;
    out.push({ id: s.id, site: s.kind, center: s.position, radius: s.radius, outlying: null });
  }
  for (const line of world.getRailLines()) {
    for (const p of line.platforms) out.push({ id: p.id, site: 'platform', center: p.position, radius: p.radius, outlying: 'platform' });
  }
  const ruins = world.getRuinSites?.() ?? [];
  for (const r of ruins) out.push({ id: r.id, site: 'ruin', center: r.position, radius: r.radius, outlying: 'ruin' });
  return out;
}

/**
 * The site stream's seed. Mixing as `worldSeed ^ hash(label)` makes mulberry32's **first output** similar for seeds that
 * differ only in the world seed's low bits (at seeds 21 · 404 · 77 the platform occupation roll came out 0.6 or more every
 * time), so the occupation chance effectively answers the same on every seed. Hence the world seed goes **inside the string hash**.
 */
function siteSeed(seed: number, label: string): number {
  return Random.hash(`${label}@${seed >>> 0}`);
}

/** One site's plan — rolled only from that site's stream (the first two rolls are fixed whether it is occupied or not). */
function planSite(ref: SiteRef, threat: 1 | 2 | 3, seed: number): SitePlan {
  const rng = new Random(siteSeed(seed, `sites:${ref.id}`));
  const occupyRoll = rng.next();
  const factionRoll = rng.next();
  const occupy = ref.outlying === 'platform' ? at(OCCUPY_PLATFORM, threat) : ref.outlying === 'ruin' ? at(OCCUPY_RUIN, threat) : at(OCCUPY_STRUCTURE, threat);
  if (!(occupyRoll < occupy)) return { ref, faction: null, groups: [] };
  const share = ref.outlying ? at(RAIDER_SHARE_OUTLYING, threat) : at(RAIDER_SHARE_STRUCTURE, threat);
  const faction: SiteFaction = threat === 1 ? 'android' : factionRoll < share ? 'raider' : 'rogue';

  const places: SiteSpawnPlace[] = [];
  if (ref.outlying) places.push('indoor');                       // a platform = on the deck, a ruin = inside the walls — always 1 group
  else {
    const indoor = Math.max(0, Math.round(at(INDOOR_GROUPS, threat)));
    const oLo = Math.max(0, Math.round(at(OUTDOOR_GROUPS_MIN, threat)));
    const oHi = Math.max(oLo, Math.round(at(OUTDOOR_GROUPS_MAX, threat)));
    const outdoor = rng.int(oLo, oHi);
    for (let i = 0; i < indoor; i++) places.push('indoor');
    for (let i = 0; i < outdoor; i++) places.push('outdoor');
  }
  // 2026-09-13 follow-up decision: platform · ruin groups get their own small table (labs · outposts 3–4 · outlying sites 2–3)
  const sLo = Math.max(1, Math.round(at(ref.outlying ? SITE_OUTLYING_GROUP_SIZE_MIN : GROUP_SIZE_MIN, threat)));
  const sHi = Math.max(sLo, Math.round(at(ref.outlying ? SITE_OUTLYING_GROUP_SIZE_MAX : GROUP_SIZE_MAX, threat)));
  const list = HUMANOID_WEAPONS[faction];
  const groups: GroupPlan[] = [];
  for (const place of places) {
    const size = rng.int(sLo, sHi);
    const weapons: string[] = [];
    for (let i = 0; i < size; i++) weapons.push(list.length > 0 ? list[rng.int(0, list.length - 1)] : 'ar');
    const flanker = rng.int(0, size - 1);                          // always rolled — it is simply unused unless the faction is raiders
    groups.push({ place, size, weapons, flanker: faction === 'raider' ? flanker : -1, leader: false, yawSeed: rng.int(0, 0x7fffffff) });
  }
  return { ref, faction, groups };
}

/**
 * Once at `world:ready` (host · not the training range): places the site groups by planet threat. The result is a record for debug · smokes.
 */
export function placeSiteGroups(host: RogueSpawnHost, seed: number, threat: 1 | 2 | 3): SitePlacement {
  const result: SitePlacement = { threat, sites: [], boss: null, humanoids: 0, source: 'fallback' };
  const world = host.ctx.world;
  if (!world) return result;
  result.source = typeof world.getSiteSpawnPoints === 'function' ? 'world' : 'fallback';

  const plans = collectSites(world).map((ref) => planSite(ref, threat, seed));

  // The rogue boss: one of the rogue groups (at most SITE_BOSS_MAX_PER_RAID per raid) — rolled apart from the site streams
  const rogueGroups: GroupPlan[] = [];
  for (const p of plans) if (p.faction === 'rogue') for (const g of p.groups) rogueGroups.push(g);
  const bossRng = new Random(siteSeed(seed, 'sites:boss'));
  const bossChance = at(BOSS_CHANCE, threat);
  const bossMax = Math.max(0, Math.round(BOSS_MAX_PER_RAID));
  for (let k = 0; k < bossMax; k++) {
    const roll = bossRng.next();
    const free = rogueGroups.filter((g) => !g.leader);
    if (free.length === 0 || !(roll < bossChance)) break;
    free[bossRng.int(0, free.length - 1)].leader = true;
  }

  for (const plan of plans) {
    const rec: SiteRecord = { siteId: plan.ref.id, site: plan.ref.site, occupied: plan.faction !== null, faction: plan.faction, groups: [] };
    result.sites.push(rec);
    if (!plan.faction) continue;
    spawnSite(host, world, plan, plan.faction, seed, rec, result);
  }
  return result;
}

/** Binds one site's groups to spots and places them. */
function spawnSite(host: RogueSpawnHost, world: WorldRef, plan: SitePlan, faction: SiteFaction, seed: number, rec: SiteRecord, result: SitePlacement): void {
  const ref = plan.ref;
  const need = (place: SiteSpawnPlace): number => plan.groups.reduce((n, g) => n + (g.place === place ? g.size : 0), 0);
  const pools = new Map<SiteSpawnPlace, THREE.Vector3[]>();
  const pool = (place: SiteSpawnPlace, count: number): THREE.Vector3[] => {
    let got = pools.get(place);
    if (!got) {
      got = sitePoints(world, ref, place, count + CANDIDATE_EXTRA, siteSeed(seed, `sites:${ref.id}:${place}`));
      pools.set(place, got);
    }
    return got;
  };
  const anchors: THREE.Vector3[] = [];
  for (const g of plan.groups) {
    const main = pool(g.place, Math.max(need(g.place), g.size));
    const picked = pickCluster(main, g.size, anchors);
    // indoor spots running short are filled with outdoor candidates (so a shortage of spots never breaks the group-size rule)
    if (picked.length < g.size && g.place === 'indoor') {
      const extra = pool('outdoor', Math.max(need('outdoor'), 0) + g.size);
      const more = pickCluster(extra, g.size - picked.length, picked.length > 0 ? [] : anchors, picked[0] ?? null);
      picked.push(...more);
    }
    if (picked.length === 0) continue;
    anchors.push(picked[0]);
    spawnGroup(host, ref, faction, g, picked, rec, result);
  }
}

/**
 * Takes `count` out of `pool` (what is picked leaves `pool`). The anchor = the candidate nearest `near` when there is one,
 * else the candidate farthest from `avoid` (with none, the first candidate). The rest follow in order of nearness to the anchor.
 */
function pickCluster(pool: THREE.Vector3[], count: number, avoid: readonly THREE.Vector3[], near: THREE.Vector3 | null = null): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (count <= 0 || pool.length === 0) return out;
  let ai = 0;
  if (near) {
    let best = Infinity;
    for (let i = 0; i < pool.length; i++) { const d = dist2(pool[i], near); if (d < best) { best = d; ai = i; } }
  } else if (avoid.length > 0) {
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      let m = Infinity;
      for (const a of avoid) m = Math.min(m, dist2(pool[i], a));
      if (m > best) { best = m; ai = i; }
    }
  }
  const anchor = pool.splice(ai, 1)[0];
  out.push(anchor);
  while (out.length < count && pool.length > 0) {
    let bi = 0; let best = Infinity;
    for (let i = 0; i < pool.length; i++) { const d = dist2(pool[i], anchor); if (d < best) { best = d; bi = i; } }
    out.push(pool.splice(bi, 1)[0]);
  }
  return out;
}

function dist2(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

/** Site spot candidates — the world query when it exists, the `scatterPoints` fallback path when it does not. */
function sitePoints(world: WorldRef, ref: SiteRef, place: SiteSpawnPlace, count: number, seed: number): THREE.Vector3[] {
  if (typeof world.getSiteSpawnPoints === 'function') return world.getSiteSpawnPoints(ref.id, place, count, GROUP_MIN_GAP, seed).map((p) => p.clone());
  // the fallback path (a build before the world carried the query) — the minimum: indoor = floor near the centre, outdoor = a ring outside the footprint
  if (place === 'indoor') {
    const pts = world.scatterPoints(ref.center, Math.max(1.5, ref.radius * FALLBACK_INDOOR_FRAC), count, GROUP_MIN_GAP, seed);
    for (const p of pts) { world.resolveCollision(p, 0.6); p.y = world.getSurfaceY(p.x, p.z, ref.center.y + 0.3); }
    return pts;
  }
  const inner = ref.radius + FALLBACK_OUTDOOR_GAP;
  const pts = world.scatterPoints(ref.center, inner + FALLBACK_OUTDOOR_WIDTH, count * 3, GROUP_MIN_GAP, seed)
    .filter((p) => Math.hypot(p.x - ref.center.x, p.z - ref.center.z) >= inner && world.isInsideBounds(p.x, p.z) && !world.structureAt(p.x, p.z))
    .slice(0, count);
  for (const p of pts) { world.resolveCollision(p, 0.8); p.y = world.getSurfaceY(p.x, p.z, world.getHeightAt(p.x, p.z)); }
  return pts;
}

/** Places one group (with a boss the first spot is `rogue_boss`; with raiders one member is the flanker). */
function spawnGroup(host: RogueSpawnHost, ref: SiteRef, faction: SiteFaction, g: GroupPlan, points: THREE.Vector3[], rec: SiteRecord, result: SitePlacement): void {
  const squadId = host.allocSquadId();
  const grec: SiteGroupRecord = { squadId, place: g.place, faction, leader: false, planned: g.size, members: [] };
  rec.groups.push(grec);
  const yawRng = new Random(g.yawSeed >>> 0);
  const leash = Math.max(2, ref.radius + (g.place === 'indoor' ? LEASH_INDOOR : LEASH_OUTDOOR));
  const flanker = g.flanker >= 0 ? Math.min(g.flanker, points.length - 1) : -1;
  let leader: Enemy | null = null;
  const spawned: Enemy[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const isLeader = g.leader && i === 0;
    const type: EnemyType = isLeader ? 'rogue_boss' : faction;
    const role: EnemySquadRole = isLeader ? 'leader' : i === flanker ? 'flanker' : 'member';
    const weapon = isLeader ? ROGUE_AI.bossWeapon : g.weapons[i] ?? g.weapons[0] ?? 'ar';
    const yaw = g.place === 'outdoor' ? outwardYaw(p, ref.center) : yawRng.range(0, Math.PI * 2);
    const escortOf = !isLeader && leader ? leader : null;
    _tmp.copy(p);
    const e = host.spawnRogue(type, _tmp, yaw, ref.center, weapon, escortOf, { site: ref.site, squadId, role });
    if (!e) continue;
    if (!escortOf) e.leash = leash;                                // spawnRogue gives escorts escortLeash instead
    if (isLeader) { leader = e; grec.leader = true; result.boss = e; }
    spawned.push(e);
    result.humanoids++;
    grec.members.push({ id: e.id, type, role, weapon, x: e.position.x, y: e.position.y, z: e.position.z });
  }
  // when the flanker's spot failed to spawn the first surviving member takes the role (a raider group = exactly one)
  if (flanker >= 0 && spawned.length > 0 && !spawned.some((e) => e.squadRole === 'flanker')) {
    const e = spawned.find((x) => x.squadRole === 'member') ?? spawned[0];
    e.squadRole = 'flanker';
    const m = grec.members.find((x) => x.id === e.id);
    if (m) m.role = 'flanker';
  }
}

/** The yaw that turns its back on `center` and looks outward: `atan2(Δx, Δz)` at the centre turned by π (humanoid yaw convention, nose along +Z). */
function outwardYaw(p: THREE.Vector3, center: THREE.Vector3): number {
  if (Math.abs(p.x - center.x) + Math.abs(p.z - center.z) < 1e-3) return 0;
  return Math.atan2(center.x - p.x, center.z - p.z) + Math.PI;
}
