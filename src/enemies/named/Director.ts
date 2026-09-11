/**
 * src/enemies/named/Director.ts — **네임드 로그 스폰 디렉터** (2026-09-11).
 *
 * 이 파일이 답하는 질문: *이번 레이드에 네임드가 나오는가, 누가, 어디에 서는가.*
 *
 * ## 굴림 (호스트 · 레이드당 1회)
 * `EnemySystem` 의 `world:ready` 권한 분기가 로그 가드 배치 **뒤에** `roll()` 을 한 번 부른다. 훈련장은 no-op.
 * 시드 스트림은 `worldSeed ^ hash('named')` 하나이고, 그 스트림에서 차례로
 *   ① 등장 여부 `NAMED_ROGUE_CHANCE_BY_RANK[planetTier(행성) − 1]` (행성 없음 = 난이도 1),
 *   ② 셋 중 누구인지 (균등),
 *   ③ 자리 · 헤비 호위의 자리
 * 를 뽑는다 — 같은 시드 + 같은 행성 = 같은 답이다. 굴림은 `world:ready` 에서만 일어나므로 호스트 이관으로
 * 승격된 사람은 다시 굴리지 않는다 (그 사람은 리플리카일 때 이미 `ee spawn` 으로 네임드를 받았다).
 *
 * ## 자리 (전부 스폰 지점에서 `NAMED_ROGUE_MIN_SPAWN_DIST` 이상 · 맵 안 · 선로 회랑 밖 · 구조물 발자국 밖 · 막히지 않은 곳)
 *  - 로든(`rogue_sniper`) — **개활지의 언덕**: 후보를 여럿 뽑아 주변 장애물이 적고(`obstacleCoverage`),
 *    구조물에서 멀고, 둘레보다 **높은** 지형을 고른다. 스폰 지점(= 분대가 오는 쪽)을 바라본다.
 *  - 타길라(`rogue_hammer`) — **구조물 곁**: 스폰에서 먼 구조물 하나의 발자국 둘레 `NAMED_HAMMER.structureRadius`
 *    안에서 엄폐물이 가장 많은 자리. `guardPos` = 그 구조물. 구조물이 없는 맵이면 장애물이 가장 많은 자리.
 *  - 헤비(`rogue_heavy`) — **스폰에서 먼 구조물 · 폐허(상자) 곁**. SMG 로그 호위
 *    `NAMED_HEAVY_ESCORTS_BY_SQUAD[분대 인원 − 1]` 명이 `NAMED_HEAVY.escortRadius` 안에 붙는다
 *    (`escortOf` = 헤비 → 기존 보스 호위 리시 규칙 그대로).
 *
 * ## 스폰 · 알림
 * 스폰은 기존 `spawnRogue` 경로라 `enemy:spawned` · `ee spawn` 이 그대로 나간다. 네임드 · 호위는 로그 팩션이라
 * `ensureCapacity` 의 재활용 대상이 아니다 (`e.isRogue`). 알림 `enemy:namedSpawned` 는 권한이면 스폰 직후,
 * 리플리카면 `enemy:spawned` 에서 네임드 종류를 처음 볼 때 id 당 한 번 낸다. 기록은 `reset()` 이 레이드마다 비운다.
 *
 * 배치 탐색의 후보 수 · 표본 반경 같은 값은 **탐색 알고리즘의 파라미터**이지 밸런스 수치가 아니라 이 파일에 둔다
 * (`RogueGuards` 의 시도 횟수 · 링 반경과 같은 성격). 등장 확률 · 거리 · 호위 수는 전부 csv 에서 온다.
 */
import * as THREE from 'three';
import {
  ENEMY_SPAWN_BLOCK_RATIO, ENEMY_SPAWN_CLEARANCE_MUL, NAMED_HEAVY_ESCORTS_BY_SQUAD, NAMED_ROGUE_CHANCE_BY_RANK, NAMED_ROGUE_MIN_SPAWN_DIST,
  NAMED_ROGUE_TYPES, RAIL_CLEARANCE_M, Random, isNamedRogueType, planetTier,
  type EnemyType, type NamedRogueType, type PlanetId, type WorldRef,
} from '@/shared';
import type { Enemy } from '../Enemy';
import { ENEMY_STATS, NAMED_HAMMER, NAMED_HEAVY } from '../EnemyTypes';
import type { RogueSpawnHost } from '../RogueGuards';

/* ── 무기 (items/WeaponDefs 의 무기 def id — 로그 `weaponId` 는 계열 id 규약, `ROGUE_AI_TEXT` 와 같다) ── */
/** 로든의 저격소총 = 저격소총 계열 I. */
const SNIPER_WEAPON = 'sr';
/** 헤비의 미니건 = `data/weapons_unique.csv` 의 `u_minigun` (아이템 id 는 `wpn_u_minigun`). */
const HEAVY_WEAPON = 'u_minigun';
/** 헤비 호위가 드는 SMG 계열 I. */
const ESCORT_WEAPON = 'smg';

/* ── 배치 탐색 파라미터 (밸런스 수치가 아니다) ─────────────────────────────────────────────── */
/** 맵 가장자리에서 이만큼은 안쪽에 선다(m). */
const EDGE_MARGIN = 24;
/** 선로 회랑 반폭에 더 비워 둘 여유(m) — 회랑 경계에 딱 붙어 서면 전차가 스친다. */
const RAIL_EXTRA_M = 4;
/** 로든 후보 수. */
const SNIPER_CANDIDATES = 48;
/** 로든: 개활도를 재는 원의 반경(m). */
const SNIPER_OPEN_RADIUS = 22;
/** 로든: 둘레 높이를 표본하는 링 반경(m)과 표본 수. */
const SNIPER_RING_RADIUS = 30;
const SNIPER_RING_SAMPLES = 8;
/** 로든: 구조물 발자국에서 최소 이만큼 떨어진다(m). 점수는 `SNIPER_STRUCT_CAP` 까지만 오른다. */
const SNIPER_STRUCT_MIN = 30;
const SNIPER_STRUCT_CAP = 80;
/** 로든 점수 가중치: 둘레보다 높은 1 m · 개활도 1.0 · 구조물 거리 1 m · 맵 바깥쪽으로 치우친 정도. */
const W_PROMINENCE = 1;
const W_OPEN = 40;
const W_STRUCT = 0.1;
const W_EDGE = 40;
/** 맵 중심에서 반폭의 이 비율을 넘어가면 점수가 깎인다 (분대가 거의 오지 않는 구석). */
const EDGE_SOFT = 0.75;
/** 타길라: 구조물 하나당 둘레 표본 수, 엄폐 밀도를 재는 원의 반경(m), 발자국 바깥 최소 간격(m). */
const HAMMER_RING_TRIES = 16;
const HAMMER_COVER_RADIUS = 10;
const HAMMER_FOOTPRINT_GAP = 1.5;
/** 헤비: 앵커(구조물 · 폐허) 둘레 링 — 발자국 바깥 최소 · 최대 간격(m)과 표본 수. */
const HEAVY_RING_MIN = 6;
const HEAVY_RING_MAX = 18;
const HEAVY_RING_TRIES = 12;
/** 앵커가 상자일 때 쓰는 대략 반경(m). */
const CRATE_ANCHOR_RADIUS = 3;
/** 앵커가 하나도 없을 때 무작위로 뽑는 후보 수. */
const FALLBACK_CANDIDATES = 32;
/** 호위 한 명당 자리 재시도 수. */
const ESCORT_TRIES = 6;
/** 분대 정원 — `RogueDrop` · `WaveDirector` 와 같은 값. */
const MAX_SQUAD = 4;
/** 디버그 스폰: 플레이어 앞 거리(m). */
const DEBUG_AHEAD_M = 40;

const _p = new THREE.Vector3();
const _best = new THREE.Vector3();
const _guard = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** 이번 레이드의 굴림 결과 (`EnemySystem.debugNamedRoll`). */
export interface NamedRollResult {
  /** 이 클라이언트가 이번 레이드에 굴렸는가 (리플리카 · 훈련장 · 굴림 전이면 false). */
  rolled: boolean;
  planet: PlanetId | null;
  /** `planetTier` (1..5). */
  tier: number;
  /** 등장 확률. */
  chance: number;
  /** 굴린 값 (0..1, `< chance` 면 등장). */
  roll: number;
  /** 뽑힌 종류 (등장하지 않았으면 null). */
  type: NamedRogueType | null;
  /** 자리를 찾아 실제로 세웠는가. */
  placed: boolean;
  /** 네임드의 적 id, 없으면 null. */
  id: number | null;
  position: { x: number; y: number; z: number } | null;
  /** 자리를 정한 근거: `structure:<id>` · `crate` · `open`. */
  anchor: string | null;
  /** 헤비와 함께 세운 호위 수. */
  escorts: number;
}

/** 디렉터가 `EnemySystem` 에 요구하는 것. */
export interface NamedDirectorHost extends RogueSpawnHost {
  /** 이 클라이언트가 적을 시뮬레이션하는가 (싱글 또는 호스트). */
  readonly authority: boolean;
  /** 시뮬레이션 훈련장인가. */
  readonly training: boolean;
  /** 활성 적 조회 (리플리카의 `enemy:spawned` → 네임드 알림). */
  find(id: number): Enemy | undefined;
}

function emptyResult(): NamedRollResult {
  return { rolled: false, planet: null, tier: 1, chance: 0, roll: 1, type: null, placed: false, id: null, position: null, anchor: null, escorts: 0 };
}

export class NamedRogueDirector {
  private host!: NamedDirectorHost;
  /** 이번 레이드에 `enemy:namedSpawned` 를 이미 낸 적 id. */
  private readonly announced = new Set<number>();
  private result: NamedRollResult = emptyResult();
  private debugCount = 0;

  bind(host: NamedDirectorHost): void { this.host = host; }

  /** 레이드 리셋 (`Pool.reset`). */
  reset(): void {
    this.announced.clear();
    this.result = emptyResult();
  }

  /* ── 굴림 ─────────────────────────────────────────────────────────────── */
  /**
   * `world:ready` 권한 분기에서 로그 가드 배치 뒤 한 번. 등장하면 자리를 찾아 세우고 알린다.
   * `planet` = 이번 레이드의 목표 행성 (null = 난이도 1 취급).
   */
  roll(planet: PlanetId | null): NamedRollResult {
    const host = this.host;
    const ctx = host?.ctx;
    const world = ctx?.world;
    if (!host || !host.authority || host.training || ctx.isTraining() || !world?.ready) return this.result;
    const tier = planetTier(planet);
    const idx = Math.max(0, Math.min(NAMED_ROGUE_CHANCE_BY_RANK.length - 1, tier - 1));
    const raw = NAMED_ROGUE_CHANCE_BY_RANK[idx];
    const chance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const rng = new Random(((world.seed >>> 0) ^ Random.hash('named')) >>> 0);
    const r = rng.next();
    const res = emptyResult();
    res.rolled = true; res.planet = planet; res.tier = tier; res.chance = chance; res.roll = r;
    this.result = res;
    if (!(r < chance)) return res;

    const type = NAMED_ROGUE_TYPES[rng.int(0, NAMED_ROGUE_TYPES.length - 1)];
    res.type = type;
    const spawn = world.getPlayerSpawn();
    let anchor: string | null = null;
    if (type === 'rogue_sniper') anchor = pickSniperSpot(world, rng, spawn, _best) ? 'open' : null;
    else if (type === 'rogue_hammer') anchor = pickHammerSpot(world, rng, spawn, _best, _guard);
    else anchor = pickHeavySpot(world, rng, spawn, _best, _guard);
    if (!anchor) return res;
    if (type === 'rogue_sniper') _guard.copy(_best);

    settle(world, _best, ENEMY_STATS[type].radius);
    // 로든은 분대가 오는 쪽(스폰)을 바라보고, 타길라 · 헤비는 지키는 곳을 등지고 바깥을 본다
    const yaw = type === 'rogue_sniper'
      ? Math.atan2(spawn.x - _best.x, spawn.z - _best.z)
      : outwardYaw(_best, _guard);
    const e = this.spawnNamed(type, _best, yaw, _guard, rng, res);
    if (!e) return res;
    res.anchor = anchor;
    return res;
  }

  /** 이번 레이드의 굴림 결과 (복사본). */
  debugRoll(): NamedRollResult {
    const r = this.result;
    return { ...r, position: r.position ? { ...r.position } : null };
  }

  /* ── 알림 ─────────────────────────────────────────────────────────────── */
  /** `enemy:spawned` — 리플리카만: 네임드 종류를 id 당 처음 볼 때 `enemy:namedSpawned`. 권한은 스폰 경로가 직접 낸다. */
  onSpawned(id: number, type: EnemyType): void {
    const host = this.host;
    if (!host || host.authority || !isNamedRogueType(type)) return;
    const e = host.find(id);
    if (!e) return;
    this.announce(e);
  }

  private announce(e: Enemy): void {
    const type = e.type;
    if (!isNamedRogueType(type) || this.announced.has(e.id)) return;
    this.announced.add(e.id);
    this.host.ctx.bus.emit('enemy:namedSpawned', { id: e.id, type, position: e.position });
  }

  /* ── 디버그 ───────────────────────────────────────────────────────────── */
  /**
   * 판정 없이 `type` 을 세운다 (헤비면 호위 포함). `at` 이 없으면 로컬 플레이어 앞 `DEBUG_AHEAD_M`.
   * 레이드당 1명 규칙도 굴림 기록도 건드리지 않는다. 권한이 아니면 null.
   */
  debugSpawn(type: NamedRogueType, at?: { x: number; z: number }): Enemy | null {
    const host = this.host;
    const ctx = host?.ctx;
    const world = ctx?.world;
    if (!host || !host.authority || !world?.ready || !isNamedRogueType(type)) return null;
    const player = ctx.player;
    const look = player ? player.position : world.getPlayerSpawn();
    if (at) _p.set(at.x, 0, at.z);
    else if (player) {
      player.getForward(_fwd);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
      _fwd.normalize();
      _p.set(player.position.x + _fwd.x * DEBUG_AHEAD_M, 0, player.position.z + _fwd.z * DEBUG_AHEAD_M);
    } else _p.set(look.x, 0, look.z + DEBUG_AHEAD_M);
    settle(world, _p, ENEMY_STATS[type].radius);
    const yaw = Math.atan2(look.x - _p.x, look.z - _p.z);
    _guard.copy(_p);
    const rng = new Random(((world.seed >>> 0) ^ Random.hash('named:debug') ^ ++this.debugCount) >>> 0);
    return this.spawnNamed(type, _p, yaw, _guard, rng, null);
  }

  /* ── 스폰 ─────────────────────────────────────────────────────────────── */
  /** 네임드 한 명 (+ 헤비면 호위). `res` 가 있으면 결과를 적는다. */
  private spawnNamed(type: NamedRogueType, pos: THREE.Vector3, yaw: number, guard: THREE.Vector3, rng: Random, res: NamedRollResult | null): Enemy | null {
    const host = this.host;
    const weapon = type === 'rogue_sniper' ? SNIPER_WEAPON : type === 'rogue_heavy' ? HEAVY_WEAPON : '';
    const e = host.spawnRogue(type, pos, yaw, guard, weapon, null);
    if (!e) return null;
    let escorts = 0;
    if (type === 'rogue_heavy') escorts = this.placeEscorts(e, rng);
    if (res) {
      res.placed = true;
      res.id = e.id;
      res.position = { x: e.position.x, y: e.position.y, z: e.position.z };
      res.escorts = escorts;
    }
    this.announce(e);
    return e;
  }

  /** 헤비 둘레 `escortRadius` 안에 SMG 로그 호위를 세운다. 세운 수를 돌려준다. */
  private placeEscorts(heavy: Enemy, rng: Random): number {
    const host = this.host;
    const world = host.ctx.world!;
    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, squadSize(host) - 1));
    const count = Math.max(0, Math.round(NAMED_HEAVY_ESCORTS_BY_SQUAD[idx] ?? 0));
    if (count <= 0) return 0;
    const radius = Math.max(2, NAMED_HEAVY.escortRadius);
    const escortRadius = ENEMY_STATS.rogue.radius;
    const base = rng.range(0, Math.PI * 2);
    let placed = 0;
    for (let i = 0; i < count; i++) {
      let ok = false;
      for (let a = 0; a < ESCORT_TRIES && !ok; a++) {
        const ang = base + (i / count) * Math.PI * 2 + rng.range(-0.45, 0.45);
        const rad = rng.range(radius * 0.4, radius);
        _p.set(heavy.position.x + Math.cos(ang) * rad, 0, heavy.position.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(_p.x, _p.z) || blocked(world, _p.x, _p.z, escortRadius)) continue;
        ok = true;
      }
      if (!ok) continue;
      settle(world, _p, escortRadius);
      const yaw = outwardYaw(_p, heavy.position);
      // escortOf = 헤비 → `spawnRogue` 가 리시를 `ROGUE_AI.escortLeash` 로, RogueAI 가 guardPos 를 헤비에 붙인다
      if (host.spawnRogue('rogue', _p, yaw, heavy.position, ESCORT_WEAPON, heavy)) placed++;
    }
    return placed;
  }
}

/* ══ 자리 고르기 ═════════════════════════════════════════════════════════════════════════════════════ */

/** 로든: 개활지 언덕. 찾으면 `out` 에 적고 true. */
function pickSniperSpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  const radius = ENEMY_STATS.rogue_sniper.radius;
  let bestScore = -Infinity;
  for (let i = 0; i < SNIPER_CANDIDATES; i++) {
    // 후보마다 rng 를 정확히 두 번 쓴다 — 거절돼도 소비량이 같아 뒤따르는 호위 배치 굴림이 흔들리지 않는다
    const x = rng.range(-half, half);
    const z = rng.range(-half, half);
    if (!spotOk(world, x, z, spawn, radius)) continue;
    const clearance = structureClearance(world, x, z);
    if (clearance < SNIPER_STRUCT_MIN) continue;
    const h = world.getHeightAt(x, z);
    let ring = 0;
    for (let k = 0; k < SNIPER_RING_SAMPLES; k++) {
      const a = (k / SNIPER_RING_SAMPLES) * Math.PI * 2;
      ring += world.getHeightAt(x + Math.cos(a) * SNIPER_RING_RADIUS, z + Math.sin(a) * SNIPER_RING_RADIUS);
    }
    const prominence = h - ring / SNIPER_RING_SAMPLES;
    const open = world.obstacleCoverage(x, z, SNIPER_OPEN_RADIUS);
    const edge = Math.max(0, Math.hypot(x, z) / Math.max(1, world.size / 2) - EDGE_SOFT);
    const score = prominence * W_PROMINENCE - open * W_OPEN + Math.min(clearance, SNIPER_STRUCT_CAP) * W_STRUCT - edge * W_EDGE;
    if (score > bestScore) { bestScore = score; out.set(x, h, z); }
  }
  return bestScore > -Infinity;
}

/** 타길라: 스폰에서 먼 구조물 곁 엄폐가 많은 자리. `guard` = 그 구조물 (없으면 자리 자신). 근거 문자열 또는 null. */
function pickHammerSpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3, guard: THREE.Vector3): string | null {
  const radius = ENEMY_STATS.rogue_hammer.radius;
  const structures = farthestFirst(world.getStructures(), spawn);
  if (structures.length > 0) {
    // 먼 쪽 절반에서 시작해 한 바퀴 — 가까운 구조물은 자리가 하나도 안 날 때만 쓴다
    const start = rng.int(0, Math.max(0, Math.ceil(structures.length / 2) - 1));
    for (let n = 0; n < structures.length; n++) {
      const s = structures[(start + n) % structures.length];
      const inner = s.radius + HAMMER_FOOTPRINT_GAP;
      const outer = Math.max(inner + 2, Math.min(NAMED_HAMMER.structureRadius, s.radius + 12));
      let best = -Infinity;
      for (let t = 0; t < HAMMER_RING_TRIES; t++) {
        const ang = rng.range(0, Math.PI * 2);
        const rad = rng.range(inner, outer);
        const x = s.position.x + Math.cos(ang) * rad;
        const z = s.position.z + Math.sin(ang) * rad;
        if (!spotOk(world, x, z, spawn, radius)) continue;
        const cover = world.obstacleCoverage(x, z, HAMMER_COVER_RADIUS);
        if (cover > best) { best = cover; out.set(x, 0, z); }
      }
      if (best > -Infinity) {
        guard.copy(s.position);
        return `structure:${s.id}`;
      }
    }
  }
  // 구조물이 없는 맵: 장애물이 가장 빽빽한(= 엄폐가 많은) 자리
  if (!pickOpenOrCluttered(world, rng, spawn, radius, HAMMER_COVER_RADIUS, 1, out)) return null;
  guard.copy(out);
  return 'open';
}

/** 헤비: 스폰에서 먼 구조물 · 폐허(상자) 곁. `guard` = 그 앵커. 근거 문자열 또는 null. */
function pickHeavySpot(world: WorldRef, rng: Random, spawn: THREE.Vector3, out: THREE.Vector3, guard: THREE.Vector3): string | null {
  const radius = ENEMY_STATS.rogue_heavy.radius;
  const structures = farthestFirst(world.getStructures(), spawn);
  if (structures.length > 0) {
    const start = rng.int(0, Math.max(0, Math.ceil(structures.length / 2) - 1));
    for (let n = 0; n < structures.length; n++) {
      const s = structures[(start + n) % structures.length];
      if (ringAround(world, rng, spawn, s.position, s.radius, radius, out)) {
        guard.copy(s.position);
        return `structure:${s.id}`;
      }
    }
  }
  const crates = farthestFirst(world.getCrates().filter((c) => c.tier >= 2), spawn);
  if (crates.length > 0) {
    const tries = Math.min(crates.length, 8);
    const start = rng.int(0, Math.max(0, Math.ceil(crates.length / 2) - 1));
    for (let n = 0; n < tries; n++) {
      const c = crates[(start + n) % crates.length];
      if (ringAround(world, rng, spawn, c.position, CRATE_ANCHOR_RADIUS, radius, out)) {
        guard.copy(c.position);
        return 'crate';
      }
    }
  }
  if (!pickOpenOrCluttered(world, rng, spawn, radius, HAMMER_COVER_RADIUS, 0, out)) return null;
  guard.copy(out);
  return 'open';
}

/** 앵커 발자국 바깥 `HEAVY_RING_MIN..MAX` 링의 첫 유효 자리. */
function ringAround(world: WorldRef, rng: Random, spawn: THREE.Vector3, center: THREE.Vector3, footprint: number, radius: number, out: THREE.Vector3): boolean {
  for (let t = 0; t < HEAVY_RING_TRIES; t++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = footprint + rng.range(HEAVY_RING_MIN, HEAVY_RING_MAX);
    const x = center.x + Math.cos(ang) * rad;
    const z = center.z + Math.sin(ang) * rad;
    if (!spotOk(world, x, z, spawn, radius)) continue;
    out.set(x, 0, z);
    return true;
  }
  return false;
}

/**
 * 앵커가 없을 때: 무작위 후보 중 `coverRadius` 원의 장애물 밀도가 가장 높은(`sign` 1) 자리, `sign` 0 이면 첫 유효 자리.
 */
function pickOpenOrCluttered(world: WorldRef, rng: Random, spawn: THREE.Vector3, radius: number, coverRadius: number, sign: 0 | 1, out: THREE.Vector3): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  let best = -Infinity;
  for (let i = 0; i < FALLBACK_CANDIDATES; i++) {
    const x = rng.range(-half, half);
    const z = rng.range(-half, half);
    if (!spotOk(world, x, z, spawn, radius)) continue;
    const score = sign === 1 ? world.obstacleCoverage(x, z, coverRadius) : 0;
    if (score > best) { best = score; out.set(x, 0, z); if (sign === 0) return true; }
  }
  return best > -Infinity;
}

/* ══ 공용 판정 ═══════════════════════════════════════════════════════════════════════════════════════ */

/** 네임드가 설 수 있는 자리인가: 맵 안 · 스폰에서 충분히 멀다 · 선로 회랑 밖 · 구조물 발자국 밖 · 막히지 않았다. */
function spotOk(world: WorldRef, x: number, z: number, spawn: THREE.Vector3, radius: number): boolean {
  const half = world.size / 2 - EDGE_MARGIN;
  if (Math.abs(x) > half || Math.abs(z) > half || !world.isInsideBounds(x, z)) return false;
  if (Math.hypot(x - spawn.x, z - spawn.z) < NAMED_ROGUE_MIN_SPAWN_DIST) return false;
  if (railDistance(world, x, z) < RAIL_CLEARANCE_M + RAIL_EXTRA_M) return false;
  if (world.structureAt(x, z)) return false;
  return !blocked(world, x, z, radius);
}

/** `Spawner.spawnBlocked` 와 같은 규칙을 반경으로 직접 — 네임드는 `ENEMY_BIG_RADIUS` 밑이라 그 함수가 늘 false 다. */
function blocked(world: WorldRef, x: number, z: number, radius: number): boolean {
  return world.obstacleCoverage(x, z, Math.max(0.5, radius) * ENEMY_SPAWN_CLEARANCE_MUL) > ENEMY_SPAWN_BLOCK_RATIO;
}

/** 가장 가까운 선로 중심선까지의 수평 거리(m). 선로가 없으면 Infinity. 할당 없음. */
function railDistance(world: WorldRef, x: number, z: number): number {
  let best = Infinity;
  const lines = world.getRailLines();
  for (let l = 0; l < lines.length; l++) {
    const pts = lines[l].points;
    const n = pts.length;
    if (n === 0) continue;
    if (n === 1) { best = Math.min(best, Math.hypot(x - pts[0].x, z - pts[0].z)); continue; }
    const segs = lines[l].kind === 'loop' ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2)) : 0;
      const dx = x - (a.x + abx * t), dz = z - (a.z + abz * t);
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
  }
  return best;
}

/** 가장 가까운 구조물 발자국 가장자리까지의 거리(m). 구조물이 없으면 Infinity. */
function structureClearance(world: WorldRef, x: number, z: number): number {
  let best = Infinity;
  const list = world.getStructures();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const d = Math.hypot(x - s.position.x, z - s.position.z) - s.radius;
    if (d < best) best = d;
  }
  return best;
}

/** 스폰에서 `NAMED_ROGUE_MIN_SPAWN_DIST` 이상 떨어진 것만, 먼 순으로 (복사본 — 월드 배열은 건드리지 않는다). */
function farthestFirst<T extends { position: THREE.Vector3 }>(list: readonly T[], spawn: THREE.Vector3): T[] {
  const d = (o: T): number => Math.hypot(o.position.x - spawn.x, o.position.z - spawn.z);
  return list.filter((o) => d(o) >= NAMED_ROGUE_MIN_SPAWN_DIST).sort((a, b) => d(b) - d(a));
}

/** 장애물 밖으로 밀어내고 발이 닿는 높이로. */
function settle(world: WorldRef, p: THREE.Vector3, radius: number): void {
  world.resolveCollision(p, Math.max(1, radius + 0.4));
  p.y = world.getSurfaceY(p.x, p.z, world.getHeightAt(p.x, p.z));
}

/** `center` 를 등지고 바깥을 보는 yaw (`RogueGuards.placeAround` 와 같은 규약). */
function outwardYaw(p: THREE.Vector3, center: THREE.Vector3): number {
  if (Math.abs(p.x - center.x) + Math.abs(p.z - center.z) < 1e-3) return 0;
  return Math.atan2(center.x - p.x, center.z - p.z) + Math.PI;
}

/** 분대 인원 (1..4). 싱글은 1. `RogueDrop.squadSize` · `WaveDirector.squadSize` 와 같은 계산. */
function squadSize(host: NamedDirectorHost): number {
  const net = host.ctx.net;
  let n = 1;
  if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
  return Math.max(1, Math.min(MAX_SQUAD, n));
}
