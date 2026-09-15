/**
 * src/enemies/sandworm/Director.ts — **땅굴벌레 이벤트 디렉터** (2026-09-13, 등장 판정 개편 2026-09-15).
 *
 * 이 파일이 답하는 질문: *이번 레이드에 땅굴벌레가 나오는가, 언제 · 어디서, 나온 뒤에는 무엇을 하나.*
 *
 * ## 등장 — 누적 확률제 (사용자 결정 2026-09-15, docs/DECISIONS.md 「2026-09-15 — 땅굴벌레」)
 * 미리 굴리지 않고 시각 창도 없다. **호스트**가 `SANDWORM_CHECK_S` 마다 조건을 보고 그때의 확률 `p` 를 굴린다 — 레이드당 최대 1회.
 *   1. 후보 = 살아 있는 사람(로컬 + `ctx.net.getRemotePlayers()` 중 임무 안 · 안 죽고 안 쓰러짐) + **안드로이드 분대원**
 *      (`ctx.allies.getCombatBodies()`). 무게 상태: 로컬 `ctx.inventory.getWeight().state`, 원격 `RemotePlayerRef.weightState`
 *      (옛 송신자 = 모름 = normal), 안드로이드 = 자기 가방의 kg / 용량을 사람과 같은 문턱(`WEIGHT_*_RATIO`)으로 (모르면 normal).
 *   2. **자격 인원** = 달리는 중(`isSprinting` · `PlayerFlags.SPRINT` · `ALLY_FLAGS.SPRINT`) 이고 무게가 `light`(조금 무거움) 이상.
 *      자격 인원끼리 `SANDWORM_GROUP_RADIUS`(40 m) 안에 `SANDWORM_MIN_MEMBERS`(2) 이상 모인 가장 큰 무리를 잡는다 — 없으면 p = 0.
 *      **혼자(안드로이드 없는 솔로)는 절대 나오지 않는다.**
 *   3. p = `SANDWORM_BASE_CHANCE_BY_THREAT[threat]` × min(1, Σ 가중치) × 거리 계수 (+ 유인 가산), 0..1 로 자른다.
 *      - 가중치: light `SANDWORM_P_PER_LIGHT`, heavy · over `SANDWORM_P_PER_HEAVY`.
 *      - 거리 계수: 무리 안 서로의 평균 거리 d̄ ≤ `SANDWORM_P_NEAR_M` → 1, d̄ = `SANDWORM_GROUP_RADIUS` → `SANDWORM_P_FAR_MUL` (사이는 선형).
 *      - 유인: 무리 중심 `SANDWORM_LURE_RANGE_M` 안에 살아 있는 유인 수류탄(가젯 lure 배치물 · `LureField` 의 `'lure'`)이 있으면
 *        `SANDWORM_P_LURE` 를 더하고, 그 자리가 `SANDWORM_LURE_SPOT_CHANCE` 확률로 분출 자리가 된다 (땅 검사 실패 → 다른 쪽).
 *   4. 자리 검사(`validSpot`): 맵 안 · 무리 중 누구도 지형보다 `OFF_TERRAIN_M` 높이 서 있지 않다(데크 · 지붕 · 전차) ·
 *      `WorldRef.burrowGroundOk(x, z, BURROW_GROUND_CHECK_R × 크기)` (평평한 맨땅 — 구조물 · 선로 · 흙길 · 소품 · 둥지 · 포자 군락 ·
 *      재해 구역 · 채집 · 상자 · 함선 외피 없음; 없는 월드는 false). 굴림이 성공했는데 자리가 나쁘면 이번 검사는 건너뛴다.
 *
 * ### 검사 한 번의 p (csv 기본값 — light 0.12 · heavy 0.25 · near 20 m · far ×0.25 · threat 0.6 / 0.8 / 1.0, 유인 없음)
 * | 인원 · 무게      | d̄ ≤ 20 m (threat 1 · 2 · 3) | d̄ = 40 m (threat 1 · 2 · 3) |
 * |------------------|------------------------------|------------------------------|
 * | 2 light          | 0.144 · 0.192 · 0.24         | 0.036 · 0.048 · 0.06         |
 * | 2 heavy          | 0.30 · 0.40 · 0.50           | 0.075 · 0.10 · 0.125         |
 * | 3 light          | 0.216 · 0.288 · 0.36         | 0.054 · 0.072 · 0.09         |
 * | 3 heavy          | 0.45 · 0.60 · 0.75           | 0.1125 · 0.15 · 0.1875       |
 * | 4 light          | 0.288 · 0.384 · 0.48         | 0.072 · 0.096 · 0.12         |
 * | 4 heavy          | 0.60 · 0.80 · 1.00           | 0.15 · 0.20 · 0.25           |
 * 3 heavy · 20 m · threat 3 = 0.75/검사 → 2 초 간격 3 검사 안에 98 %. 2 light · 40 m · threat 2 = 0.048/검사 → 30 초(15 검사)에 52 %.
 * 유인 수류탄은 어느 칸에나 +0.15.
 *
 * ## 진동 장치 (`sandworm:summon`, gadgets 가 호스트에서 낸다)
 * 이 레이드에 아직 없었으면 확률 · 땅 검사 없이 그 자리에서 곧장 전조 (`OFF_TERRAIN_M` 검사만). 이미 있었으면 무시.
 *
 * ## 종류 (행성 위협)
 * threat 1 → **어린 개체** `sandworm_weak` (체력 `SANDWORM_WEAK_HP` 고정 · 몸 · 분출 반경 × `SANDWORM_WEAK_SCALE` · 스캐빈저만 뱉는다),
 * threat 2–3 → 성체 `sandworm` (체력 `SANDWORM_HP_MIN..MAX` 굴림). 콘솔 · 스모크는 `weak` 로 강제할 수 있다.
 *
 * ## 순서
 *   전조 `SANDWORM_WARN_S`(5 s): `ee wormWarn` → 모든 클라이언트가 분진 · 흙 파임(점점 거세짐) · 피해 반경 링 · 거리에 따라
 *   약 → 강으로 오르는 흔들림 · 토스트 「지상이변 발생」 · 땅울림.
 *   → 분출: 반경 R 안 플레이어에 피해 + 넉백(`applyDamage` — 로컬은 직접, 원격은 `dmg.kb`, 끊긴 사람은 `ghost:damage`) ·
 *   다른 팩션 적 · 드론 · 땅굴벌레 스폰(`ee spawn` + `em` = 솟아오름, 최대 체력은 호스트가 정해 `ee wormErupt.hp` · 종류 `ty`)
 *   · 분대 인원만큼 버그 무리가 파고 나온다(`SANDWORM_BURST_BY_SQUAD`).
 *   → 버그 뱉기 `SANDWORM_SPIT_PHASE_S`(30 s): 입에서 `SANDWORM_SPIT_COUNT` 마리씩 포물선으로 뱉는다(`ee wormSpit`, 생존 상한
 *   `SANDWORM_ALIVE_CAP`). **먼저 죽이면 더 뱉지 않는다.**
 *   → 독극물: 땅에 박힌 채 `SANDWORM_ACID_RANGE` 안의 가장 가까운 플레이어에게 산성 연발(기존 `ee acid` · `ee acidAt`).
 * 죽으면 보스급 시체(`loot_corpses.csv` 의 `sandworm` · `sandworm_weak`)가 남고 킬 · 분대 킬 · 계약은 기존 경로 그대로다.
 *
 * ## 늦은 합류 · 재접속 · 호스트 이관
 * `flow rejoined` 를 받은 호스트가 `resync()` — 진행 중인 전조(남은 eta), 살아 있는 땅굴벌레마다 `wormErupt {sy: 1}`(최대 체력 ·
 * 남은 뱉기 시간 · 종류), 이미 끝났으면 `wormErupt {id: 0, sy: 1}`(끝났다는 표식). 리플리카는 받은 값을 땅굴벌레에 적어 두므로
 * (`Enemy.wormSpitUntil` · `maxHp`) 승격되면 그대로 이어서 돌리고, `done` 표식 덕에 새 호스트가 두 마리째를 내지 않는다.
 *
 * 수치는 전부 csv 다. 이 파일의 상수는 연출 박자(흔들림 틱 · 입 벌림 준비 시간) · 산성 흩뿌림 · 행성 없는 미션의 구성 가중치 ·
 * 자리 검사의 높이 문턱뿐이다.
 */
import * as THREE from 'three';
import {
  ALLY_FLAGS, BURROW_EMERGE_S, BURROW_GROUND_CHECK_R, PLAYER_RADIUS, PlayerFlags, explosionFalloff, planetThreat,
  SANDWORM_ACID_INTERVAL_S, SANDWORM_ACID_RANGE, SANDWORM_ACID_VOLLEY, SANDWORM_ALERT_RADIUS, SANDWORM_ALIVE_CAP,
  SANDWORM_BASE_CHANCE_BY_THREAT, SANDWORM_BURST_BY_SQUAD, SANDWORM_BURST_RING_MAX, SANDWORM_BURST_RING_MIN, SANDWORM_CHECK_S,
  SANDWORM_ERUPT_DAMAGE, SANDWORM_ERUPT_KNOCKBACK, SANDWORM_ERUPT_RADIUS, SANDWORM_GROUP_RADIUS, SANDWORM_HP_MAX, SANDWORM_HP_MIN,
  SANDWORM_LURE_RANGE_M, SANDWORM_LURE_SPOT_CHANCE, SANDWORM_MIN_MEMBERS, SANDWORM_P_FAR_MUL, SANDWORM_P_LURE, SANDWORM_P_NEAR_M,
  SANDWORM_P_PER_HEAVY, SANDWORM_P_PER_LIGHT, SANDWORM_RISE_S, SANDWORM_SHAKE_MAX, SANDWORM_SPIT_COUNT, SANDWORM_SPIT_FLIGHT_S,
  SANDWORM_SPIT_INTERVAL_S, SANDWORM_SPIT_MAX_M, SANDWORM_SPIT_MIN_M, SANDWORM_SPIT_PHASE_S, SANDWORM_WARN_S, SANDWORM_WEAK_HP,
  SANDWORM_WEAK_SCALE, WEIGHT_HEAVY_RATIO, WEIGHT_LIGHT_RATIO, WEIGHT_OVER_RATIO,
  type EnemyEvent, type EnemyType, type PlanetEcosystem, type PlanetId, type WeightState,
} from '@/shared';
import { Enemy } from '../Enemy';
import { ENEMY_STATS, isWormType, type WormEnemyType } from '../EnemyTypes';
import { ecoAllows, pickEcoType, spawnBlocked } from '../Spawner';
import type { CombatTarget } from '../Targets';
import { turnToward, yawTo } from '../ai/Steering';
import { round, tuple } from '../net/HostSync';
import { isVec3Tuple } from '../model';
import { applyWormHint, WORM_HINT_ACID, WORM_HINT_SPIT } from './Pose';
/* appended (2026-09-15, 안드로이드 분대원): 분출의 안드로이드 몫 */
import { damageAlliesAt } from '../parts/Damage';
import type { EnemySystem } from '../EnemySystem';

/** 성체의 뱉기 · 분출 무리 후보 (행성 생태계 가중치로 뽑는다). 포병 · 차저 · 베헤모스는 뱉기에 너무 크다. */
const SPIT_TYPES: readonly EnemyType[] = ['scavenger', 'hunter', 'warrior', 'spewer', 'toxic'];
/** 행성이 없는 미션(`eco` null)에서 쓰는 같은 순서의 가중치. */
const SPIT_FALLBACK: readonly number[] = [5, 2, 1.2, 1, 0.8];
/** 어린 개체(위협 1)는 **가장 약한 벌레만** 뱉고 분출 무리도 그것뿐이다 (사용자 결정). */
const SPIT_TYPES_WEAK: readonly EnemyType[] = ['scavenger'];
const SPIT_FALLBACK_WEAK: readonly number[] = [1];
/** 분대 정원 — `RogueDrop` · `WaveDirector` 와 같은 값. */
const MAX_SQUAD = 4;
/** 전조 흔들림을 더하는 간격(초) — `camera:shake` 는 trauma 를 **더하므로** 이 박자가 세기의 단위다. */
const WARN_SHAKE_TICK_S = 0.2;
/** 뱉기 · 독극물 직전 입을 벌리는 시간(초) — 와이어 힌트 21 / 22 가 이만큼 먼저 선다. */
const SPIT_WINDUP_S = 0.7;
const ACID_WINDUP_S = 0.6;
/** 독극물 연발의 두 번째부터 표적 주변에 흩뿌리는 반경(m). */
const ACID_SCATTER_MIN = 2.5;
const ACID_SCATTER_MAX = 5;
/** 리플리카: 분출 방송을 못 받은 전조를 이만큼 뒤에 스스로 거둔다(초). */
const REPLICA_WARN_TIMEOUT_S = 3;
/** 발동 자리 검사: 무리 중 누가 지형보다 이만큼 높이 서 있으면 (데크 · 지붕 · 전차) 건너뛴다(m). */
const OFF_TERRAIN_M = 1.2;
/** 발동 자리 바로 위에 올라설 수 있는 소품(바위)이 이만큼 솟아 있으면 건너뛴다(m). */
const PROP_ON_SPOT_M = 0.6;
/** 후보 목록의 상한 (사람 4 + 안드로이드 3 — 재사용 풀 크기). */
const MAX_CANDIDATES = 8;

const TOAST_WARN = '지상이변 발생 — 발밑에서 무언가 파고 올라온다!';
const TOAST_KILLED = '땅굴벌레 처치 — 사체를 수색할 수 있다';
const TOAST_KILLED_WEAK = '어린 땅굴벌레 처치 — 사체를 수색할 수 있다';

const TWO_PI = Math.PI * 2;
const _p = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Vector3();
const _kb = new THREE.Vector3();
const _to = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _mouth = new THREE.Vector3();
const _erupt = new THREE.Vector3();
const _lure = new THREE.Vector3();

/** 등장 검사의 후보 한 명 (재사용). */
interface Candidate {
  x: number; z: number;
  sprint: boolean;
  ws: WeightState;
  android: boolean;
  /** 이번 검사에서 무리에 들었나. */
  inGroup: boolean;
}

/** 검사 한 번의 결과 (`debugState().plan.last` · `debugChance`). */
export interface SandwormCheck {
  /** `ctx.time`. */
  at: number;
  /** 후보 수 (사람 + 안드로이드). */
  candidates: number;
  /** 자격 인원 수 (달리기 + light 이상). */
  eligible: number;
  /** 가장 큰 무리의 인원 (< SANDWORM_MIN_MEMBERS 면 p = 0). */
  n: number;
  /** Σ 가중치 (상한 전). */
  sum: number;
  /** 무리 안 서로의 평균 거리(m). */
  spread: number;
  closeMul: number;
  lure: boolean;
  p: number;
  cx: number; cz: number;
}

/** 이번 레이드의 등장 설정 (`EnemySystem.debugSandwormState.plan`). */
export interface SandwormPlan {
  /** 행성 threat (1..3). */
  threat: number;
  /** 검사 한 번의 위협 배수 (`SANDWORM_BASE_CHANCE_BY_THREAT`). 0 = 이 레이드에는 자연 등장이 없다 (벌레 없는 행성 · 훈련장). */
  base: number;
  /** 이 행성의 땅굴벌레 종류. */
  type: WormEnemyType;
  /** 호스트가 돌린 검사 횟수 · 굴림이 성공한 횟수(자리가 나빠 미뤄진 것 포함). */
  checks: number;
  hits: number;
  /** 마지막 검사 (아직 없으면 null). */
  last: SandwormCheck | null;
}

function emptyPlan(): SandwormPlan {
  return { threat: 1, base: 0, type: 'sandworm', checks: 0, hits: 0, last: null };
}

/** 행성 threat → 종류 (1 = 어린 개체). */
export function wormTypeForThreat(threat: number): WormEnemyType {
  return threat <= 1 ? 'sandworm_weak' : 'sandworm';
}
/** 종류의 크기 배수 — 분출 반경 · 자리 검사 반지름에 곱한다. */
export function wormScaleOf(type: EnemyType): number {
  return type === 'sandworm_weak' ? SANDWORM_WEAK_SCALE : 1;
}
/** kg / 용량 → 무게 상태 (사람의 `WeightInfo.state` 와 같은 문턱 — 안드로이드 가방에 쓴다). */
function weightStateOfRatio(ratio: number): WeightState {
  if (!Number.isFinite(ratio)) return 'normal';
  if (ratio >= WEIGHT_OVER_RATIO) return 'over';
  if (ratio >= WEIGHT_HEAVY_RATIO) return 'heavy';
  if (ratio >= WEIGHT_LIGHT_RATIO) return 'light';
  return 'normal';
}
function weightOf(ws: WeightState): number {
  return ws === 'light' ? SANDWORM_P_PER_LIGHT : ws === 'heavy' || ws === 'over' ? SANDWORM_P_PER_HEAVY : 0;
}

export class SandwormDirector {
  private sys!: EnemySystem;
  private plan: SandwormPlan = emptyPlan();
  private eco: PlanetEcosystem | null = null;
  /** 이번 레이드의 이벤트가 이미 시작됐다 (레이드당 최대 1회 — 리플리카는 방송을 받으면 켠다). */
  private done = false;
  /** 진동 장치가 불렀다 (디버그 표시). */
  private summoned = false;
  private checkTimer = 0;
  private readonly warn = { active: false, p: new THREE.Vector3(), startedAt: 0, eruptAt: 0, shakeAcc: 0, r: 0, type: 'sandworm' as WormEnemyType };
  /** 콘솔 · 스모크가 바꾼 다음 분출의 뱉기 단계 길이(초), null = csv. */
  private forcedSpitS: number | null = null;
  /** 리플리카: `wormErupt` 로 받은 최대 체력 · 뱉기 종료 시각 — 그 적이 생기면 적용하고 지운다. */
  private readonly meta = new Map<number, { hp: number; spitUntil: number }>();
  /** 등장 검사의 후보 풀 (할당 없음). */
  private readonly cands: Candidate[] = [];
  private readonly lastCheck: SandwormCheck = { at: 0, candidates: 0, eligible: 0, n: 0, sum: 0, spread: 0, closeMul: 0, lure: false, p: 0, cx: 0, cz: 0 };
  /* 디버그 · 스모크 카운터 (이 클라이언트 기준) */
  warnings = 0;
  eruptions = 0;
  spitVolleys = 0;
  acidVolleys = 0;
  warnShakes = 0;

  bind(sys: EnemySystem): void {
    this.sys = sys;
    for (let i = this.cands.length; i < MAX_CANDIDATES; i++) this.cands.push({ x: 0, z: 0, sprint: false, ws: 'normal', android: false, inGroup: false });
  }

  /** 레이드 리셋 (`Pool.reset`). */
  reset(): void {
    this.plan = emptyPlan();
    this.eco = null;
    this.done = false;
    this.summoned = false;
    this.checkTimer = 0;
    this.warn.active = false;
    this.forcedSpitS = null;
    this.meta.clear();
    this.warnings = 0; this.eruptions = 0; this.spitVolleys = 0; this.acidVolleys = 0; this.warnShakes = 0;
  }

  /* ── 설정 ─────────────────────────────────────────────────────────────── */
  /** `world:ready` (권위 · 리플리카 모두). 훈련장 · 튜토리얼이면 계획이 없다 (base 0). */
  onWorldReady(planet: PlanetId | null, eco: PlanetEcosystem | null, training: boolean): void {
    const ctx = this.sys?.ctx;
    const world = ctx?.world;
    this.eco = eco;
    this.plan = emptyPlan();
    if (!ctx || training || ctx.isTraining() || !world?.ready) return;
    const threat = planetThreat(planet);
    const type = wormTypeForThreat(threat);
    const raw = SANDWORM_BASE_CHANCE_BY_THREAT[threat - 1];
    let base = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    if (eco && !this.spitTypes(type).some((t) => ecoAllows(eco, t))) base = 0;   // 벌레가 안 사는 행성
    this.plan = { threat, base, type, checks: 0, hits: 0, last: null };
    this.checkTimer = SANDWORM_CHECK_S;
    if (base > 0) this.prewarm(type);
  }

  private spitTypes(type: EnemyType): readonly EnemyType[] { return type === 'sandworm_weak' ? SPIT_TYPES_WEAK : SPIT_TYPES; }
  private spitFallback(type: EnemyType): readonly number[] { return type === 'sandworm_weak' ? SPIT_FALLBACK_WEAK : SPIT_FALLBACK; }

  /** 이 행성 종류의 리그 하나를 풀에 미리 만들어 숨긴 채 씬에 넣고 셰이더를 걸어 둔다 (`acquire` 가 그대로 꺼내 쓴다). */
  private prewarm(type: WormEnemyType): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    let pool = sys.pools.get(type);
    if (!pool) { pool = []; sys.pools.set(type, pool); }
    if (pool.length === 0) {
      const e = new Enemy(type);
      e.bindHost(sys);
      pool.push(e);
    }
    const root = pool[pool.length - 1].rig.root;
    if (!root.parent) ctx.scene.add(root);
    void ctx.shaders?.warm(root);
  }

  /* ── 프레임 ───────────────────────────────────────────────────────────── */
  update(dt: number): void {
    const sys = this.sys;
    const ctx = sys?.ctx;
    if (!ctx?.world?.ready) return;
    if (this.warn.active) this.tickWarn(dt);
    if (this.meta.size > 0) this.applyMeta();
    if (!sys.authority || !ctx.isGameplayPhase()) return;
    const now = ctx.time;
    if (this.warn.active) {
      if (now >= this.warn.eruptAt) this.erupt();
    } else if (!this.done && this.plan.base > 0 && ctx.phase === 'playing') {
      this.checkTimer -= dt;
      if (this.checkTimer <= 0) {
        this.checkTimer = SANDWORM_CHECK_S;
        this.check();
      }
    }
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (isWormType(e.type) && e.active && e.state !== 'dead') this.tickWorm(e, dt);
    }
  }

  /* ── 등장 검사 (호스트) ────────────────────────────────────────────────── */
  /** 후보 목록을 채운다 (사람 + 안드로이드). 돌려주는 값 = 후보 수. */
  private collectCandidates(): number {
    const sys = this.sys;
    const ctx = sys.ctx;
    const cands = this.cands;
    let n = 0;
    const put = (x: number, z: number, sprint: boolean, ws: WeightState, android: boolean): void => {
      if (n >= cands.length) return;
      const c = cands[n++];
      c.x = x; c.z = z; c.sprint = sprint; c.ws = ws; c.android = android; c.inGroup = false;
    };
    const p = ctx.player;
    if (p && !p.isDead && !p.isDowned && !p.isDropping && p.roverRide !== true) {
      const inv = ctx.inventory;
      const ws: WeightState = inv && typeof inv.getWeight === 'function' ? inv.getWeight().state : 'normal';
      put(p.position.x, p.position.z, p.isSprinting === true, ws, false);
    }
    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      const remotes = net.getRemotePlayers();
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        if (!r.connected || !r.inMission || (r.stale && !r.suspended)) continue;
        const f = r.flags;
        if (r.isDead || r.isDowned || (f & (PlayerFlags.DEAD | PlayerFlags.DOWNED | PlayerFlags.DROPPING | PlayerFlags.IN_ROVER | PlayerFlags.IN_HUB)) !== 0) continue;
        if (r.suspended) { put(r.position.x, r.position.z, false, r.weightState ?? 'normal', false); continue; }   // 고스트는 달리지 않는다
        put(r.position.x, r.position.z, (f & PlayerFlags.SPRINT) !== 0, r.weightState ?? 'normal', false);
      }
    }
    const allies = ctx.allies;
    if (allies) {
      const bodies = allies.getCombatBodies();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const lo = allies.getLoadout(b.id);
        const ws = lo && lo.capacity > 0 ? weightStateOfRatio(lo.weight / lo.capacity) : 'normal';
        put(b.position.x, b.position.z, (b.flags & ALLY_FLAGS.SPRINT) !== 0, ws, true);
      }
    }
    return n;
  }

  /**
   * 후보 `cands[0..count)` 로 검사 한 번의 확률을 계산한다 (굴리지 않는다). 유인은 무리 중심이 정해진 뒤에만 뜻이 있어
   * 두 단계로 돈다: 무리 → 중심 → (호출자가 유인을 찾은 뒤) `applyLure`.
   */
  private evaluate(cands: readonly Candidate[], count: number, out: SandwormCheck, base: number): void {
    out.candidates = count; out.eligible = 0; out.n = 0; out.sum = 0; out.spread = 0; out.closeMul = 0; out.lure = false; out.p = 0; out.cx = 0; out.cz = 0;
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    let eligible = 0;
    for (let i = 0; i < count; i++) { cands[i].inGroup = false; if (cands[i].sprint && weightOf(cands[i].ws) > 0) eligible++; }
    out.eligible = eligible;
    const minN = Math.max(1, Math.round(SANDWORM_MIN_MEMBERS));
    if (eligible < minN) return;
    // 가장 큰 무리: 자격 인원 각각을 닻으로 삼아 반경 안의 자격 인원을 센다
    let bestN = 0, bestAnchor = -1, bestSum = 0;
    for (let i = 0; i < count; i++) {
      const a = cands[i];
      if (!a.sprint || weightOf(a.ws) <= 0) continue;
      let n = 0, sum = 0;
      for (let j = 0; j < count; j++) {
        const b = cands[j];
        if (!b.sprint) continue;
        const w = weightOf(b.ws);
        if (w <= 0) continue;
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > r2) continue;
        n++; sum += w;
      }
      if (n > bestN || (n === bestN && sum > bestSum)) { bestN = n; bestAnchor = i; bestSum = sum; }
    }
    if (bestN < minN || bestAnchor < 0) return;
    const a = cands[bestAnchor];
    let cx = 0, cz = 0;
    for (let j = 0; j < count; j++) {
      const b = cands[j];
      if (!b.sprint || weightOf(b.ws) <= 0) continue;
      const dx = a.x - b.x, dz = a.z - b.z;
      if (dx * dx + dz * dz > r2) continue;
      b.inGroup = true; cx += b.x; cz += b.z;
    }
    cx /= bestN; cz /= bestN;
    // 거리 = 무리 안 **서로**의 평균 거리 (중심까지의 거리로 재면 둘이 40 m 떨어져도 20 m 로 읽혀 「가까울수록」 이 사라진다)
    let spread = 0, pairs = 0;
    for (let j = 0; j < count; j++) {
      const b = cands[j];
      if (!b.inGroup) continue;
      for (let k = j + 1; k < count; k++) {
        const c = cands[k];
        if (!c.inGroup) continue;
        spread += Math.hypot(b.x - c.x, b.z - c.z); pairs++;
      }
    }
    spread = pairs > 0 ? spread / pairs : 0;
    const near = Math.max(0, SANDWORM_P_NEAR_M);
    const span = Math.max(1e-6, SANDWORM_GROUP_RADIUS - near);
    const k = THREE.MathUtils.clamp((spread - near) / span, 0, 1);
    const closeMul = THREE.MathUtils.lerp(1, THREE.MathUtils.clamp(SANDWORM_P_FAR_MUL, 0, 1), k);
    out.n = bestN; out.sum = bestSum; out.spread = spread; out.closeMul = closeMul; out.cx = cx; out.cz = cz;
    out.p = THREE.MathUtils.clamp(base * Math.min(1, bestSum) * closeMul, 0, 1);
  }

  /** 유인 수류탄이 무리 중심 근처에 있으면 가산 (자격 무리가 있을 때만). */
  private applyLure(out: SandwormCheck, lureNear: boolean): void {
    out.lure = lureNear;
    if (out.n > 0 && lureNear) out.p = THREE.MathUtils.clamp(out.p + Math.max(0, SANDWORM_P_LURE), 0, 1);
  }

  /** 무리 중심 `(cx, cz)` 의 `SANDWORM_LURE_RANGE_M` 안에 살아 있는 유인 수류탄이 있으면 그 자리를 `out` 에 쓴다. */
  private findLure(cx: number, cz: number, out: THREE.Vector3): boolean {
    const sys = this.sys;
    const ctx = sys.ctx;
    const range = Math.max(0, SANDWORM_LURE_RANGE_M);
    if (sys.lures.nearestLure(cx, cz, range, ctx.time, out)) return true;
    const g = ctx.gadgets;
    if (g) {
      _c.set(cx, 0, cz);
      const dep = g.findDistraction(_c, range);
      if (dep) { out.copy(dep.position); return true; }
    }
    return false;
  }

  /** 검사 한 번 (호스트): 후보 → 확률 → 굴림 → 자리 → 전조. */
  private check(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const world = ctx.world;
    if (!world) return;
    const plan = this.plan;
    const out = this.lastCheck;
    out.at = ctx.time;
    const count = this.collectCandidates();
    this.evaluate(this.cands, count, out, plan.base);
    const lureNear = out.n > 0 && this.findLure(out.cx, out.cz, _lure);
    this.applyLure(out, lureNear);
    plan.checks++;
    plan.last = { ...out };
    if (out.p <= 0 || Math.random() >= out.p) return;
    plan.hits++;
    // 자리: 유인 자리를 먼저 볼지, 무리 중심을 먼저 볼지
    const scale = wormScaleOf(plan.type);
    const lureFirst = lureNear && Math.random() < SANDWORM_LURE_SPOT_CHANCE;
    const spots: Array<[number, number]> = lureFirst
      ? [[_lure.x, _lure.z], [out.cx, out.cz]]
      : lureNear ? [[out.cx, out.cz], [_lure.x, _lure.z]] : [[out.cx, out.cz]];
    for (let i = 0; i < spots.length; i++) {
      if (this.validSpot(spots[i][0], spots[i][1], scale, _p)) { this.warnAt(_p, SANDWORM_WARN_S, plan.type); return; }
    }
  }

  /**
   * 분출할 수 있는 땅인가: 맵 안 · 주변 사람이 데크 · 지붕 · 전차 위가 아니다 · 바로 위에 바위가 없다 · `burrowGroundOk`
   * (평평한 맨땅, 없는 월드는 false). 되면 지형 높이로 `out` 에 적는다.
   */
  private validSpot(x: number, z: number, scale: number, out: THREE.Vector3): boolean {
    const sys = this.sys;
    const world = sys.ctx.world!;
    if (!world.isInsideBounds(x, z)) return false;
    if (!this.nobodyOffTerrain(x, z)) return false;
    const h = world.getHeightAt(x, z);
    if (world.getSurfaceY(x, z, h) > h + PROP_ON_SPOT_M) return false;
    if (!(world.burrowGroundOk?.(x, z, BURROW_GROUND_CHECK_R * scale) ?? false)) return false;
    out.set(x, h, z);
    return true;
  }

  /** `(x, z)` 의 `SANDWORM_GROUP_RADIUS` 안에 지형보다 `OFF_TERRAIN_M` 높이 선 사람이 없다 (데크 · 지붕 · 전차 위면 false). */
  private nobodyOffTerrain(x: number, z: number): boolean {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const r2 = SANDWORM_GROUP_RADIUS * SANDWORM_GROUP_RADIUS;
    const alive = sys.targets.alive;
    for (let i = 0; i < alive.length; i++) {
      const p = alive[i].position;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (p.y > world.getHeightAt(p.x, p.z) + OFF_TERRAIN_M) return false;
    }
    return true;
  }

  /* ── 진동 장치 (호스트) ────────────────────────────────────────────────── */
  /**
   * `sandworm:summon` — 이 레이드에 아직 없었으면 확률 · 땅 검사 없이 `position` 에서 곧장 전조를 시작한다 (설치 미리보기가 이미
   * `burrowGroundOk` 를 지났다). 주변 사람이 데크 · 지붕 위면 이번 부름은 버린다. 이미 있었으면 무시. 시작했으면 true.
   */
  onSummon(position: THREE.Vector3): boolean {
    const sys = this.sys;
    const ctx = sys?.ctx;
    const world = ctx?.world;
    if (!sys || !sys.authority || !ctx || !world?.ready || !ctx.isGameplayPhase() || this.done || this.warn.active) return false;
    if (!world.isInsideBounds(position.x, position.z) || !this.nobodyOffTerrain(position.x, position.z)) return false;
    _p.set(position.x, world.getHeightAt(position.x, position.z), position.z);
    this.summoned = true;
    this.warnAt(_p, SANDWORM_WARN_S, this.plan.type);
    return true;
  }

  /* ── 전조 ─────────────────────────────────────────────────────────────── */
  /** 호스트: 전조를 시작하고 방송한다. */
  private warnAt(p: THREE.Vector3, eta: number, type: WormEnemyType): void {
    const sys = this.sys;
    const r = SANDWORM_ERUPT_RADIUS * wormScaleOf(type);
    this.startWarnLocal(p, eta, r, type);
    if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'wormWarn', p: tuple(p, 2), eta: round(eta, 2), r: round(r, 2) }, 'others');
  }

  /** 이 클라이언트의 전조 연출 (권위 · 리플리카 공통). 같은 자리의 전조가 이미 돌고 있으면 남은 시간만 맞춘다. */
  private startWarnLocal(p: THREE.Vector3, eta: number, r: number, type: WormEnemyType): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const now = ctx.time;
    const w = this.warn;
    const already = w.active && w.p.distanceToSquared(p) < 1;
    this.done = true;
    w.eruptAt = now + eta;
    if (already) return;
    w.active = true;
    w.p.copy(p);
    w.r = r;
    w.type = type;
    const elapsed = Math.max(0, SANDWORM_WARN_S - eta);
    w.startedAt = now - elapsed;
    w.shakeAcc = 0;
    this.warnings++;
    sys.burrowFx?.warn(p, r, eta, ctx.world, now, elapsed);
    sys.playAudio('sandworm_rumble', p, 1, 1);
    ctx.bus.emit('ui:notify', { text: TOAST_WARN, kind: 'danger', duration: 5 });
    ctx.bus.emit('sandworm:warning', { position: p.clone(), radius: r, eta });
  }

  private endWarn(): void {
    this.warn.active = false;
    this.sys.burrowFx?.endWarn();
  }

  /** 거리에 따라 약 → 강으로 오르는 흔들림 (모든 클라이언트). */
  private tickWarn(dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const w = this.warn;
    const now = ctx.time;
    if (!sys.authority && now > w.eruptAt + REPLICA_WARN_TIMEOUT_S) { this.endWarn(); return; }
    w.shakeAcc -= dt;
    if (w.shakeAcc > 0) return;
    w.shakeAcc = WARN_SHAKE_TICK_S;
    const d = sys.targets.distToLocal(w.p);
    if (!(d < SANDWORM_ALERT_RADIUS)) return;
    const k = THREE.MathUtils.clamp((now - w.startedAt) / SANDWORM_WARN_S, 0, 1);
    const fall = Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.5);
    this.warnShakes++;
    ctx.bus.emit('camera:shake', { intensity: SANDWORM_SHAKE_MAX * (0.12 + 0.88 * k * k) * fall, duration: 0.3 });
  }

  /* ── 분출 (호스트) ────────────────────────────────────────────────────── */
  private erupt(): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    const world = ctx.world;
    if (!world) return;
    const p = _erupt.copy(this.warn.p);
    const type = this.warn.type;
    const R = this.warn.r > 0 ? this.warn.r : SANDWORM_ERUPT_RADIUS * wormScaleOf(type);
    this.endWarn();
    this.eruptions++;

    const face = sys.targets.nearestAlive(p);
    const yaw = face ? Math.atan2(face.position.x - p.x, face.position.z - p.z) : Math.random() * TWO_PI;
    const worm = sys.spawn(type, p, yaw, true, true, SANDWORM_RISE_S);
    const spitPhase = this.forcedSpitS ?? SANDWORM_SPIT_PHASE_S;
    this.forcedSpitS = null;
    let hp = 0;
    if (worm) {
      // 성체는 MIN..MAX 굴림, 어린 개체는 고정 (사용자 결정 750)
      hp = type === 'sandworm_weak'
        ? Math.max(1, Math.round(SANDWORM_WEAK_HP))
        : Math.round(SANDWORM_HP_MIN + Math.random() * Math.max(0, SANDWORM_HP_MAX - SANDWORM_HP_MIN));
      worm.maxHp = hp;
      worm.hp = hp;
      worm.aware = true;
      worm.wormSpitUntil = ctx.time + SANDWORM_RISE_S + spitPhase;
      worm.wormTimer = SPIT_WINDUP_S + 0.5;   // 다 솟은 뒤(틱은 굴착이 끝나야 돈다) 곧 첫 뱉기
    }

    // 피해 + 넉백 — 로컬은 직접, 원격은 `dmg.kb`, 끊긴 분대원은 `ghost:damage` (`applyDamage` 가 가른다)
    const players = sys.targets.alive;
    for (let i = 0; i < players.length; i++) {
      const t = players[i];
      const dx = t.position.x - p.x, dz = t.position.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > R + PLAYER_RADIUS) continue;
      /* 2026-09-15 (사용자 결정 — 모든 폭발물이 같은 공식): **피해**는 공용 2단 계단(`shared/explosion`)이고
       * **넉백**은 옛 선형 그대로다. 감쇠 곡선을 갈아 끼운 것은 피해뿐이라는 그날의 선을 여기서도 지킨다 —
       * 넉백이 계단이면 안전지대 경계에서 날아가는 거리가 뚝 끊긴다. 하한 0.3 은 둘 다 유지.
       * 어린 개체는 **반경**만 `SANDWORM_WEAK_SCALE` 배다 (피해량 · 넉백 속도는 그대로 — 사용자 결정 「넉백 + 피해 범위 70 %」). */
      const kbFalloff = THREE.MathUtils.clamp(1 - Math.max(0, d - PLAYER_RADIUS) / R, 0.3, 1);
      const falloff = Math.max(0.3, explosionFalloff(Math.max(0, d - PLAYER_RADIUS), R));
      if (d > 0.05) _kb.set(dx / d, 0, dz / d);
      else { const a = Math.random() * TWO_PI; _kb.set(Math.cos(a), 0, Math.sin(a)); }
      _kb.y = 0.8;
      _kb.normalize();
      sys.applyDamage(t, SANDWORM_ERUPT_DAMAGE * falloff, p, worm?.id ?? 0, type, null, 0, false, _kb, SANDWORM_ERUPT_KNOCKBACK * kbFalloff);
    }
    // 2026-09-15 (안드로이드 분대원): 사람 루프와 같은 식 (수평 거리 · 하한 0.3). 넉백은 없다 — 몸은 권위가 굴린다.
    damageAlliesAt(sys, p, R, SANDWORM_ERUPT_DAMAGE, worm?.id ?? 0, type, 0.3, 'feet2d');
    _c.set(p.x, p.y + 1, p.z);
    sys.explode(_c, R, SANDWORM_ERUPT_DAMAGE, 'ai', null, worm, 'bug');   // 다른 팩션 적 (벌레는 제 편)
    ctx.drones?.applyExplosion(p, R, SANDWORM_ERUPT_DAMAGE);
    sys.targets.damageVehicleAt(p, R, SANDWORM_ERUPT_DAMAGE, 0.3);   // 2026-09-13: 탐사 차량 (플레이어와 같은 최소 감쇠)

    this.spawnBurst(p, type);
    this.eruptFxLocal(p, R);
    if (worm) {
      if (sys.hosting) {
        sys.ctx.net!.send({ t: 'ee', ev: 'wormErupt', id: worm.id, p: tuple(p, 2), r: round(R, 2), hp, spit: round(worm.wormSpitUntil - ctx.time, 2), ty: type }, 'others');
      }
      ctx.bus.emit('sandworm:erupted', { id: worm.id, position: worm.position.clone(), radius: R });
    }
  }

  /** 분출과 함께 링 위에서 파고 나오는 버그 무리 (분대 인원표). 어린 개체는 스캐빈저만. */
  private spawnBurst(p: THREE.Vector3, wormType: WormEnemyType): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const idx = Math.max(0, Math.min(MAX_SQUAD - 1, squadSize(sys) - 1));
    const want = Math.max(0, Math.round(SANDWORM_BURST_BY_SQUAD[idx] ?? 0));
    if (want <= 0) return;
    const allowed = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    const base = Math.random() * TWO_PI;
    const from = this.spitTypes(wormType), fb = this.spitFallback(wormType);
    for (let i = 0; i < allowed; i++) {
      const type = pickEcoType(this.eco, from, fb);
      if (!type) continue;
      let placed = false;
      let ang = base;
      for (let a = 0; a < 4 && !placed; a++) {
        ang = base + (i / allowed) * TWO_PI + (Math.random() - 0.5) * 0.6 + a * 0.9;
        const rad = SANDWORM_BURST_RING_MIN + Math.random() * Math.max(0, SANDWORM_BURST_RING_MAX - SANDWORM_BURST_RING_MIN);
        _q.set(p.x + Math.sin(ang) * rad, 0, p.z + Math.cos(ang) * rad);
        if (!world.isInsideBounds(_q.x, _q.z)) continue;
        world.resolveCollision(_q, ENEMY_STATS[type].radius + 0.3);
        if (spawnBlocked(world, type, _q.x, _q.z)) continue;
        placed = true;
      }
      if (!placed) continue;
      _q.y = world.getHeightAt(_q.x, _q.z);
      const face = sys.targets.nearestAlive(_q);
      const yaw = face ? Math.atan2(face.position.x - _q.x, face.position.z - _q.z) : ang;
      sys.spawn(type, _q, yaw, true, true, BURROW_EMERGE_S);
    }
  }

  /** 분출 연출 (권위 · 리플리카 공통): 흙 폭발 · 굉음 · 거리 흔들림. */
  private eruptFxLocal(p: THREE.Vector3, r: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.erupt(p, r, ctx.world);
    sys.playAudio('sandworm_erupt', p, 1, 1);
    sys.playAudio('sandworm_roar', p, 1, 1);
    const d = sys.targets.distToLocal(p);
    if (d < SANDWORM_ALERT_RADIUS) {
      ctx.bus.emit('camera:shake', { intensity: Math.min(1, 0.25 + 0.75 * Math.pow(1 - d / SANDWORM_ALERT_RADIUS, 1.2)), duration: 0.8 });
    }
  }

  /* ── 땅굴벌레 틱 (호스트) ─────────────────────────────────────────────── */
  private tickWorm(e: Enemy, dt: number): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    e.velocity.set(0, 0, 0);
    e.hasMoveTarget = false;
    e.investigating = false;
    e.relentless = true;
    e.aware = true;
    if (e.state !== 'stagger') e.state = 'chase';   // 전소는 stagger 를 탄다 — 그동안은 뱉지 않는다
    if (e.emergeT > 0) { e.namedHint = 0; applyWormHint(e, 0, dt); return; }
    const target = sys.targets.nearestAlive(e.position);
    if (target) e.yaw = turnToward(e.yaw, yawTo(e.position, target.position), e.stats.turnRate, dt);
    let hint = 0;
    if (!e.isIncapacitated) {
      e.wormTimer -= dt;
      if (ctx.time < e.wormSpitUntil) {
        if (e.wormTimer <= SPIT_WINDUP_S) hint = WORM_HINT_SPIT;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_SPIT_INTERVAL_S; this.spitBugs(e, target); }
      } else if (target && target.dist2D(e.position) <= SANDWORM_ACID_RANGE) {
        if (e.wormTimer <= ACID_WINDUP_S) hint = WORM_HINT_ACID;
        if (e.wormTimer <= 0) { e.wormTimer = SANDWORM_ACID_INTERVAL_S; this.spitAcid(e, target); }
      } else if (e.wormTimer < ACID_WINDUP_S + 0.2) {
        e.wormTimer = ACID_WINDUP_S + 0.2;   // 사거리 밖: 들어오면 입을 벌린 뒤 쏜다
      }
    }
    e.namedHint = hint;
    applyWormHint(e, hint, dt);
  }

  /** 입에서 버그를 뱉는다 (호스트). 버그는 `ee spawn` 으로 먼저 생기고 `ee wormSpit` 이 비행을 알린다. */
  private spitBugs(e: Enemy, target: CombatTarget | null): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    const want = Math.max(0, Math.round(SANDWORM_SPIT_COUNT));
    const n = sys.ensureCapacity(want, SANDWORM_ALIVE_CAP);
    if (n <= 0) return;
    mouthOf(e, _mouth);
    const base = target ? Math.atan2(target.position.x - e.position.x, target.position.z - e.position.z) : Math.random() * TWO_PI;
    const entries: [number, number, number, number][] = [];
    const lo = SANDWORM_SPIT_MIN_M, hi = Math.max(lo, SANDWORM_SPIT_MAX_M);
    const from = this.spitTypes(e.type), fb = this.spitFallback(e.type);
    for (let i = 0; i < n; i++) {
      const type = pickEcoType(this.eco, from, fb);
      if (!type) continue;
      const ang = base + (Math.random() - 0.5) * 1.8;
      const dist = lo + Math.random() * (hi - lo);
      _to.set(e.position.x + Math.sin(ang) * dist, 0, e.position.z + Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) _to.set(e.position.x - Math.sin(ang) * dist, 0, e.position.z - Math.cos(ang) * dist);
      if (!world.isInsideBounds(_to.x, _to.z)) continue;
      world.resolveCollision(_to, ENEMY_STATS[type].radius + 0.3);
      _to.y = world.getSurfaceY(_to.x, _to.z, world.getHeightAt(_to.x, _to.z));
      const b = sys.spawn(type, _mouth, ang, true, true);
      if (!b) continue;
      b.startSpat(_mouth, _to, SANDWORM_SPIT_FLIGHT_S);
      entries.push([b.id, round(_to.x, 2), round(_to.y, 2), round(_to.z, 2)]);
    }
    if (entries.length === 0) return;
    this.spitVolleys++;
    sys.fx?.burst(_mouth, 36, 'acid', 6);
    sys.playAudio('sandworm_spit', _mouth, 1, 1);
    if (sys.hosting) {
      sys.ctx.net!.send({ t: 'ee', ev: 'wormSpit', id: e.id, from: tuple(_mouth, 2), b: entries, T: round(SANDWORM_SPIT_FLIGHT_S, 2) }, 'others');
    }
  }

  /** 독극물 연발 (호스트): 첫 발은 예측 조준(`ee acid`), 나머지는 주변에 흩뿌린다(`ee acidAt`). 피해는 기존 산성 경로. */
  private spitAcid(e: Enemy, target: CombatTarget): void {
    const sys = this.sys;
    const world = sys.ctx.world!;
    mouthOf(e, _mouth);
    sys.fireAcid(_mouth, e, target);
    const extra = Math.max(0, Math.round(SANDWORM_ACID_VOLLEY) - 1);
    for (let k = 0; k < extra; k++) {
      const a = Math.random() * TWO_PI;
      const r = ACID_SCATTER_MIN + Math.random() * (ACID_SCATTER_MAX - ACID_SCATTER_MIN);
      _aim.set(target.position.x + Math.cos(a) * r, 0, target.position.z + Math.sin(a) * r);
      if (!world.isInsideBounds(_aim.x, _aim.z)) continue;
      _aim.y = world.getHeightAt(_aim.x, _aim.z);
      sys.fireAcidAt(_mouth, _aim, e);
    }
    this.acidVolleys++;
    sys.playAudio('sandworm_spit', _mouth, 0.8, 1.3);
  }

  /* ── 사망 (모든 클라이언트 — `parts/Damage.onEnemyKilled`) ─────────────── */
  onWormKilled(e: Enemy): void {
    const sys = this.sys;
    const ctx = sys.ctx;
    sys.burrowFx?.puff(e.position, 3 * wormScaleOf(e.type), ctx.world);
    sys.playAudio('sandworm_death', e.position, 1, e.type === 'sandworm_weak' ? 1.25 : 1);
    ctx.bus.emit('ui:notify', { text: e.type === 'sandworm_weak' ? TOAST_KILLED_WEAK : TOAST_KILLED, kind: 'success', duration: 4 });
    const d = sys.targets.distToLocal(e.position);
    if (d < 40) ctx.bus.emit('camera:shake', { intensity: 0.45 * (1 - d / 40) * wormScaleOf(e.type), duration: 0.6 });
  }

  /* ── 와이어 (리플리카) ────────────────────────────────────────────────── */
  onWire(msg: EnemyEvent): void {
    const sys = this.sys;
    if (!sys || sys.authority) return;
    const ctx = sys.ctx;
    if (!ctx.world?.ready) return;
    switch (msg.ev) {
      case 'wormWarn': {
        if (!isVec3Tuple(msg.p) || !Number.isFinite(msg.eta)) return;
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        const r = Number.isFinite(msg.r) && msg.r > 0 ? msg.r : SANDWORM_ERUPT_RADIUS;
        // 종류는 반경으로 가늠할 뿐이다 (스폰은 `ee spawn.ty` 가 정한다) — 이 값은 전조 링 · 이벤트 반경에만 쓴다
        const type: WormEnemyType = r < SANDWORM_ERUPT_RADIUS * 0.999 ? 'sandworm_weak' : 'sandworm';
        this.startWarnLocal(_p, THREE.MathUtils.clamp(msg.eta, 0, SANDWORM_WARN_S * 2), r, type);
        return;
      }
      case 'wormErupt': {
        this.done = true;
        if (!(msg.id > 0) || !isVec3Tuple(msg.p)) return;   // id 0 = 이미 끝난 이벤트라는 표식뿐
        _p.set(msg.p[0], msg.p[1], msg.p[2]);
        if (this.warn.active) this.endWarn();
        const r = Number.isFinite(msg.r) && msg.r > 0 ? msg.r : SANDWORM_ERUPT_RADIUS;
        if (!msg.sy) { this.eruptions++; this.eruptFxLocal(_p, r); }
        const hp = Number.isFinite(msg.hp) && msg.hp > 0 ? msg.hp : 0;
        const spit = Number.isFinite(msg.spit) ? Math.max(0, msg.spit) : 0;
        this.meta.set(msg.id, { hp, spitUntil: ctx.time + spit });
        this.applyMeta();
        if (!msg.sy) ctx.bus.emit('sandworm:erupted', { id: msg.id, position: _p.clone(), radius: r });
        return;
      }
      case 'wormSpit': {
        if (!isVec3Tuple(msg.from) || !Array.isArray(msg.b) || !Number.isFinite(msg.T)) return;
        _mouth.set(msg.from[0], msg.from[1], msg.from[2]);
        const T = THREE.MathUtils.clamp(msg.T, 0.2, 3);
        for (let i = 0; i < msg.b.length; i++) {
          const row = msg.b[i];
          if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isFinite)) continue;
          const b = sys.byId.get(row[0]);
          if (!b || !b.active || b.state === 'dead') continue;
          _to.set(row[1], row[2], row[3]);
          b.startSpat(_mouth, _to, T);
        }
        this.spitVolleys++;
        sys.fx?.burst(_mouth, 36, 'acid', 6);
        sys.playAudio('sandworm_spit', _mouth, 1, 1);
        return;
      }
      default:
        return;
    }
  }

  /** 리플리카: 받아 둔 최대 체력 · 뱉기 종료 시각을 그 땅굴벌레에 적는다 (승격되면 그대로 이어 돌린다). */
  private applyMeta(): void {
    const sys = this.sys;
    for (const [id, m] of this.meta) {
      const e = sys.byId.get(id);
      if (!e || !e.active || !isWormType(e.type)) continue;
      if (m.hp > 0) { e.maxHp = m.hp; if (e.hp > m.hp) e.hp = m.hp; }
      e.wormSpitUntil = m.spitUntil;
      this.meta.delete(id);
    }
  }

  /** 호스트: 재접속 · 늦은 합류(`flow rejoined`)에 진행 상황을 다시 보낸다. */
  resync(): void {
    const sys = this.sys;
    if (!sys?.hosting) return;
    const ctx = sys.ctx;
    const net = ctx.net!;
    const now = ctx.time;
    if (this.warn.active) {
      net.send({ t: 'ee', ev: 'wormWarn', p: tuple(this.warn.p, 2), eta: round(Math.max(0, this.warn.eruptAt - now), 2), r: round(this.warn.r, 2) }, 'others');
    }
    let alive = 0;
    const active = sys.active;
    for (let i = 0; i < active.length; i++) {
      const e = active[i];
      if (!isWormType(e.type) || !e.active || e.state === 'dead') continue;
      alive++;
      net.send({ t: 'ee', ev: 'wormErupt', id: e.id, p: tuple(e.position, 2), r: round(SANDWORM_ERUPT_RADIUS * wormScaleOf(e.type), 2), hp: round(e.maxHp, 0), spit: round(Math.max(0, e.wormSpitUntil - now), 2), sy: 1, ty: e.type }, 'others');
    }
    if (this.done && !this.warn.active && alive === 0) {
      net.send({ t: 'ee', ev: 'wormErupt', id: 0, p: [0, 0, 0], r: 0, hp: 0, spit: 0, sy: 1 }, 'others');
    }
  }

  /* ── 디버그 ───────────────────────────────────────────────────────────── */
  /**
   * 콘솔 · 스모크: 확률 · 땅 검사 · 레이드당 1회를 무시하고 **지금** 전조를 시작한다 (권위 · 레이드 중만). `at` 이 없으면 로컬 플레이어 발밑.
   * `spitS` = 이번 분출의 뱉기 단계 길이(초, 0 = 곧장 독극물). `weak` = 어린 개체로 강제 (생략 = 행성 threat). 시작했으면 true.
   */
  debugForce(opts: { at?: { x: number; z: number }; spitS?: number; weak?: boolean } = {}): boolean {
    const sys = this.sys;
    const ctx = sys?.ctx;
    const world = ctx?.world;
    if (!sys || !sys.authority || sys.training || !ctx || ctx.isTraining() || !world?.ready || !ctx.isGameplayPhase() || this.warn.active) return false;
    const src = opts.at ?? ctx.player?.position ?? null;
    if (!src || !world.isInsideBounds(src.x, src.z)) return false;
    _p.set(src.x, world.getHeightAt(src.x, src.z), src.z);
    this.forcedSpitS = typeof opts.spitS === 'number' && Number.isFinite(opts.spitS) && opts.spitS >= 0 ? opts.spitS : null;
    this.warnAt(_p, SANDWORM_WARN_S, opts.weak ? 'sandworm_weak' : this.plan.type);
    return true;
  }

  /** 스모크: 「이 레이드에 이미 있었다」 표식을 지운다 — 강제 분출 뒤 `sandworm:summon` 을 검사하려고. */
  debugClearOnce(): void { this.done = false; this.summoned = false; }

  /**
   * 스모크: 가상의 인원 목록으로 검사 한 번의 확률을 계산한다 (굴리지도, 상태를 바꾸지도 않는다). `threat` 생략 = 이 레이드의 plan.
   * 그 밖의 필드는 `SandwormCheck` 그대로.
   */
  debugChance(members: ReadonlyArray<{ x: number; z: number; ws: WeightState; sprint: boolean }>, lure = false, threat?: number): SandwormCheck {
    const list: Candidate[] = members.slice(0, MAX_CANDIDATES).map((m) => ({ x: m.x, z: m.z, sprint: m.sprint, ws: m.ws, android: false, inGroup: false }));
    const raw = threat === undefined ? this.plan.base : SANDWORM_BASE_CHANCE_BY_THREAT[Math.max(1, Math.min(3, Math.round(threat))) - 1];
    const base = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    const out: SandwormCheck = { at: this.sys?.ctx.time ?? 0, candidates: 0, eligible: 0, n: 0, sum: 0, spread: 0, closeMul: 0, lure: false, p: 0, cx: 0, cz: 0 };
    this.evaluate(list, list.length, out, base);
    this.applyLure(out, lure);
    return out;
  }

  debugState(): {
    plan: SandwormPlan; done: boolean; summoned: boolean; warning: { x: number; y: number; z: number; eta: number; r: number; type: WormEnemyType } | null;
    worms: Array<{ id: number; type: EnemyType; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }>;
    warnings: number; eruptions: number; spitVolleys: number; acidVolleys: number; warnShakes: number;
  } {
    const sys = this.sys;
    const now = sys?.ctx.time ?? 0;
    const worms: Array<{ id: number; type: EnemyType; hp: number; maxHp: number; spitLeft: number; emerging: boolean; hint: number }> = [];
    if (sys) {
      for (const e of sys.active) {
        if (!isWormType(e.type) || !e.active || e.state === 'dead') continue;
        worms.push({ id: e.id, type: e.type, hp: e.hp, maxHp: e.maxHp, spitLeft: Math.max(0, e.wormSpitUntil - now), emerging: e.emergeT > 0, hint: e.namedHint });
      }
    }
    const w = this.warn;
    return {
      plan: { ...this.plan, last: this.plan.last ? { ...this.plan.last } : null }, done: this.done, summoned: this.summoned,
      warning: w.active ? { x: w.p.x, y: w.p.y, z: w.p.z, eta: w.eruptAt - now, r: w.r, type: w.type } : null,
      worms, warnings: this.warnings, eruptions: this.eruptions, spitVolleys: this.spitVolleys, acidVolleys: this.acidVolleys, warnShakes: this.warnShakes,
    };
  }
}

/** 입 월드 위치 (리그의 입 그룹 — 마지막 프레임 자세). 리그가 없으면 머리 구 중심. */
function mouthOf(e: Enemy, out: THREE.Vector3): THREE.Vector3 {
  const rig = e.rig;
  if (rig.kind === 'worm') {
    rig.root.updateMatrixWorld(true);
    return rig.mouth.getWorldPosition(out);
  }
  return e.headCenter(out);
}

/** 분대 인원 (1..4). 싱글은 1. `RogueDrop.squadSize` · `WaveDirector.squadSize` 와 같은 계산. */
function squadSize(sys: EnemySystem): number {
  const net = sys.ctx.net;
  let n = 1;
  if (net) for (const r of net.getRemotePlayers()) if (r.connected) n++;
  return Math.max(1, Math.min(MAX_SQUAD, n));
}
