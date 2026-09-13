/**
 * src/enemies/SiteGroups.ts — **거점 점거** (2026-09-13, 행성별 적 팩션).
 *
 * 이 파일이 답하는 질문: *레이드가 시작될 때 어느 거점에 어떤 인간형이 몇 그룹 서 있는가.*
 * 계획서: docs/plans/enemy-factions.md §1. 옛 상자 경비(`placeRogueGuards`)를 대신한다.
 *
 * ## 규칙 (행성 threat = `planetThreat`, 행성 없음 = 1)
 *  - threat 1 — 연구소 · 전진기지마다 **안드로이드** 실내 1 + 실외 1–2 그룹 (그룹당 1–2명). 플랫폼 · 폐허는 비어 있다.
 *  - threat 2 — 연구소 · 전진기지 **항상 점거**: 거점마다 로그 65 % / 레이더 35 %, 실내 1 + 실외 1 그룹 (그룹당 3–4명).
 *    선로 플랫폼 = 로그 1그룹 60 %, 폐허 전초 = 로그 1그룹 50 %. 로그 그룹 하나를 40 % 로 로그 분대장이 이끈다 (레이드당 최대 1명).
 *  - threat 3 — threat 2 와 같은 자리 · 확률이지만 **전부 레이더**.
 *  - 불시착 함선은 어느 threat 에서도 비어 있다 (레이더 강하 트리거만).
 * 확률 · 인원은 전부 `data/tables.csv` 의 `SITE_*` 표(key = threat − 1)이고, 팩션 규칙(1 = 안드로이드)만 코드다.
 *
 * ## 분대
 * 그룹마다 `allocSquadId()` 로 유일한 `squadId`. 레이더 그룹은 **정확히 한 명**이 `flanker`(우회조 — AI 는 인간형 AI 담당),
 * 분대장이 있는 로그 그룹은 첫 자리가 `rogue_boss`(`leader`)이고 나머지가 `escortOf` = 분대장이다. `site` = 거점 종류
 * (`StructureKind` · `platform` · `ruin`) — 시체 전리품의 입력이다.
 *
 * ## 자리
 * `WorldRef.getSiteSpawnPoints(siteId, place, count, minGap, seed)` 에 **그 자리(place)의 인원 합보다 넉넉히** 달라고 한 뒤,
 * 그룹마다 앵커(첫 그룹 = 첫 후보, 다음 그룹 = 앞 앵커들에서 가장 먼 후보)와 그 앵커에 가장 가까운 후보들로 묶는다 —
 * 실외 두 그룹이 거점 둘레에 흩어져 서되 한 그룹은 뭉쳐 선다. 실내 자리가 모자라면 실외 후보로 채운다.
 * world 가 아직 그 질의를 안 가진 빌드(선택 메서드)면 `scatterPoints` 로 된 최소 대체 경로를 쓴다.
 * `guardPos` = 거점 중심, 리시 = 거점 반경 + `SITE_GROUP_LEASH_INDOOR_M` / `_OUTDOOR_M` (호위는 `spawnRogue` 가 `escortLeash`).
 *
 * ## 결정성 (호스트 전용 · `world:ready` 한 번)
 * 거점마다 `worldSeed ^ hash('sites:<siteId>')` 스트림 하나로 점거 · 팩션 · 그룹 수 · 인원 · 무기 · 우회조를 굴린다 —
 * 한 거점의 굴림이 다른 거점을 밀지 않는다. 분대장은 따로 `hash('sites:boss')` 스트림. 자리 시드도 `siteId:place` 해시다.
 * 같은 시드 + 같은 행성 = 같은 배치. 적은 기존 `spawnRogue` → `ee spawn` 으로 흐르고 리플리카는 거점을 모른다
 * (시체의 `si` 만 `ee corpse` 로 간다).
 *
 * 개체수 상한: `ensureCapacity` 를 거치지 않는다. 인간형은 재활용 대상이 아니다(`isHumanoid`) — 옛 상자 경비와 같다.
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

/* ── 탐색 파라미터 (밸런스 수치가 아니다) ─────────────────────────────────────────────────────────────── */
/** 한 자리(place)의 인원 합에 더해 달라고 하는 여분 후보 수 — 그룹을 뭉치게 고를 여지. */
const CANDIDATE_EXTRA = 6;
/** 대체 경로: 실내 산포 반경 = 거점 반경 × 이 값. */
const FALLBACK_INDOOR_FRAC = 0.4;
/** 대체 경로: 실외 링 = 거점 반경 + 이 값(m)부터 + `FALLBACK_OUTDOOR_WIDTH` 까지. */
const FALLBACK_OUTDOOR_GAP = 3;
const FALLBACK_OUTDOOR_WIDTH = 14;

/** 거점을 차지하는 인간형 팩션. */
export type SiteFaction = 'android' | 'rogue' | 'raider';

export interface SiteGroupMember { id: number; type: EnemyType; role: EnemySquadRole; weapon: string; x: number; y: number; z: number }
export interface SiteGroupRecord {
  squadId: number;
  place: SiteSpawnPlace;
  faction: SiteFaction;
  /** 로그 분대장이 이끄는 그룹인가. */
  leader: boolean;
  /** 굴린 인원 (자리가 모자라면 `members` 가 더 적다). */
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
  /** 거점 로그 분대장 (없으면 null). */
  boss: Enemy | null;
  /** 세운 인간형 수. */
  humanoids: number;
  /** 자리를 어디서 얻었나 — `world` = `getSiteSpawnPoints`, `fallback` = `scatterPoints` 대체 경로. */
  source: 'world' | 'fallback';
}

interface SiteRef { id: string; site: EnemySpawnSite; center: THREE.Vector3; radius: number; outlying: 'platform' | 'ruin' | null }
interface GroupPlan { place: SiteSpawnPlace; size: number; weapons: string[]; flanker: number; leader: boolean; yawSeed: number }
interface SitePlan { ref: SiteRef; faction: SiteFaction | null; groups: GroupPlan[] }

const _tmp = new THREE.Vector3();

/** 이번 맵의 거점 목록 (월드 배열 순서 = 시드 결정적). 불시착 함선은 빠진다. */
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
 * 거점 스트림 시드. `worldSeed ^ hash(label)` 로 섞으면 월드 시드의 낮은 비트만 다른 시드끼리 mulberry32 **첫 출력**이
 * 비슷하게 나와(시드 21 · 404 · 77 에서 플랫폼 점거 굴림이 전부 0.6 이상) 점거 확률이 사실상 시드마다 같은 답이 된다.
 * 그래서 월드 시드를 **문자열 해시 안에** 넣는다.
 */
function siteSeed(seed: number, label: string): number {
  return Random.hash(`${label}@${seed >>> 0}`);
}

/** 거점 하나의 계획 — 그 거점 스트림에서만 굴린다 (굴림 수는 점거 여부와 무관하게 앞 두 번이 고정). */
function planSite(ref: SiteRef, threat: 1 | 2 | 3, seed: number): SitePlan {
  const rng = new Random(siteSeed(seed, `sites:${ref.id}`));
  const occupyRoll = rng.next();
  const factionRoll = rng.next();
  const occupy = ref.outlying === 'platform' ? at(OCCUPY_PLATFORM, threat) : ref.outlying === 'ruin' ? at(OCCUPY_RUIN, threat) : at(OCCUPY_STRUCTURE, threat);
  if (!(occupyRoll < occupy)) return { ref, faction: null, groups: [] };
  const share = ref.outlying ? at(RAIDER_SHARE_OUTLYING, threat) : at(RAIDER_SHARE_STRUCTURE, threat);
  const faction: SiteFaction = threat === 1 ? 'android' : factionRoll < share ? 'raider' : 'rogue';

  const places: SiteSpawnPlace[] = [];
  if (ref.outlying) places.push('indoor');                       // 플랫폼 = 데크 위, 폐허 = 벽 안쪽 — 늘 1그룹
  else {
    const indoor = Math.max(0, Math.round(at(INDOOR_GROUPS, threat)));
    const oLo = Math.max(0, Math.round(at(OUTDOOR_GROUPS_MIN, threat)));
    const oHi = Math.max(oLo, Math.round(at(OUTDOOR_GROUPS_MAX, threat)));
    const outdoor = rng.int(oLo, oHi);
    for (let i = 0; i < indoor; i++) places.push('indoor');
    for (let i = 0; i < outdoor; i++) places.push('outdoor');
  }
  // 2026-09-13 후속 결정: 플랫폼 · 폐허 그룹은 따로 작은 표 (연구소 · 전진기지 3–4명 · 바깥 거점 2–3명)
  const sLo = Math.max(1, Math.round(at(ref.outlying ? SITE_OUTLYING_GROUP_SIZE_MIN : GROUP_SIZE_MIN, threat)));
  const sHi = Math.max(sLo, Math.round(at(ref.outlying ? SITE_OUTLYING_GROUP_SIZE_MAX : GROUP_SIZE_MAX, threat)));
  const list = HUMANOID_WEAPONS[faction];
  const groups: GroupPlan[] = [];
  for (const place of places) {
    const size = rng.int(sLo, sHi);
    const weapons: string[] = [];
    for (let i = 0; i < size; i++) weapons.push(list.length > 0 ? list[rng.int(0, list.length - 1)] : 'ar');
    const flanker = rng.int(0, size - 1);                          // 늘 굴린다 — 레이더가 아니면 쓰지 않을 뿐
    groups.push({ place, size, weapons, flanker: faction === 'raider' ? flanker : -1, leader: false, yawSeed: rng.int(0, 0x7fffffff) });
  }
  return { ref, faction, groups };
}

/**
 * `world:ready` (호스트 · 훈련장 아님)에서 한 번: 행성 threat 대로 거점 그룹을 세운다. 결과는 디버그 · 스모크용 기록이다.
 */
export function placeSiteGroups(host: RogueSpawnHost, seed: number, threat: 1 | 2 | 3): SitePlacement {
  const result: SitePlacement = { threat, sites: [], boss: null, humanoids: 0, source: 'fallback' };
  const world = host.ctx.world;
  if (!world) return result;
  result.source = typeof world.getSiteSpawnPoints === 'function' ? 'world' : 'fallback';

  const plans = collectSites(world).map((ref) => planSite(ref, threat, seed));

  // 로그 분대장: 로그 그룹 중 하나 (레이드당 최대 SITE_BOSS_MAX_PER_RAID) — 거점 스트림과 따로 굴린다
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

/** 한 거점의 그룹들을 자리에 묶어 세운다. */
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
    // 실내 자리가 모자라면 실외 후보로 채운다 (그룹 인원 규칙이 자리 탓에 깨지지 않게)
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
 * `pool` 에서 `count` 개를 떼어 낸다 (고른 것은 `pool` 에서 빠진다). 앵커 = `near` 가 있으면 그것에 가장 가까운 후보,
 * 없으면 `avoid` 들에서 가장 먼 후보(없으면 첫 후보). 나머지는 앵커에 가까운 순.
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

/** 거점 자리 후보 — world 질의가 있으면 그것, 없으면 `scatterPoints` 대체 경로. */
function sitePoints(world: WorldRef, ref: SiteRef, place: SiteSpawnPlace, count: number, seed: number): THREE.Vector3[] {
  if (typeof world.getSiteSpawnPoints === 'function') return world.getSiteSpawnPoints(ref.id, place, count, GROUP_MIN_GAP, seed).map((p) => p.clone());
  // 대체 경로 (world 가 질의를 싣기 전 빌드) — 최소한만: 실내 = 중심 근처 바닥, 실외 = 발자국 바깥 링
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

/** 한 그룹을 세운다 (분대장이면 첫 자리가 `rogue_boss`, 레이더면 한 명이 우회조). */
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
    if (!escortOf) e.leash = leash;                                // 호위는 spawnRogue 가 escortLeash 로 둔다
    if (isLeader) { leader = e; grec.leader = true; result.boss = e; }
    spawned.push(e);
    result.humanoids++;
    grec.members.push({ id: e.id, type, role, weapon, x: e.position.x, y: e.position.y, z: e.position.z });
  }
  // 우회조 자리가 스폰에 실패했으면 살아남은 첫 멤버가 맡는다 (레이더 그룹 = 정확히 한 명)
  if (flanker >= 0 && spawned.length > 0 && !spawned.some((e) => e.squadRole === 'flanker')) {
    const e = spawned.find((x) => x.squadRole === 'member') ?? spawned[0];
    e.squadRole = 'flanker';
    const m = grec.members.find((x) => x.id === e.id);
    if (m) m.role = 'flanker';
  }
}

/** `center` 를 등지고 바깥을 보는 yaw (옛 `RogueGuards.placeAround` 규약). */
function outwardYaw(p: THREE.Vector3, center: THREE.Vector3): number {
  if (Math.abs(p.x - center.x) + Math.abs(p.z - center.z) < 1e-3) return 0;
  return Math.atan2(center.x - p.x, center.z - p.z) + Math.PI;
}
