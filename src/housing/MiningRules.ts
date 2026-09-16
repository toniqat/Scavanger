/* ────────────────────────────────────────────────────────────────────────────
 * src/housing/MiningRules.ts — **암호화폐 채굴의 순수 규칙** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, 사용자 결정).
 *
 * ctx · DOM 없음. `parts/Mining.ts`(런타임)와 `ShipState.sanitize`(세이브 정리)가 같이 쓴다 — `Rules.ts` 는 배치 규칙 에이전트의
 * 파일이라 채굴 규칙은 여기로 갈라 두었다. 주기 · 진행도 식 자체는 릴레이와 함께 쓰는 `shared/cryptoMarket` 에 있다
 * (`miningCycleMs` · `miningProgressAt`); 여기서는 그 식을 **클러스터 한 칸**에 적용하는 부분만 갖는다.
 *
 * **2026-09-16 (사용자 결정 — 연산 코어 폐지)**: 클러스터에는 **프로세서**가 직접 꽂히고 프로세서에는 내구도가 있다.
 * 그래서 칸은 「개수 하나」가 아니라 **칸마다의 남은 내구도 목록**(`ComputeClusterSlot.processors`)이다 — 인덱스가 곧 화면
 * 격자의 칸이라 3번 칸의 다 닳은 것만 빼서 고칠 수 있다. 속도는 개수가 아니라 **성능 합**(`clusterPerf`)에서 나고,
 * 주기가 한 번 끝날 때마다 꽂힌 전부가 `PROCESSOR_WEAR_PER_CYCLE` 만큼 닳는다.
 * ──────────────────────────────────────────────────────────────────────────── */
import type { ComputeClusterSlot, CryptoCoinDef } from '@/shared';
import { COMPUTE_CORE_TIME_MUL, PROCESSOR_WEAR_PER_CYCLE, miningProgressAt, processorPerf } from '@/shared';

/** 프로세서가 꽂힌 클러스터를 회수하려 할 때의 사유 (책장의 `BOOKS_BLOCK_REASON` 과 같은 자리). */
export const CLUSTER_CORES_BLOCK_REASON = '프로세서를 먼저 빼세요';

/** 채굴 따라잡기 틱 간격(ms) — 주기는 최소 수 분이라 1초면 충분하다 (표시 · 저장 빈도이지 밸런스 수치가 아니다). */
export const MINING_TICK_MS = 1000;

/** 세이브 · 크레딧 사유가 쓰는 코인 id 모양 (`shared/crypto` 의 규칙 + 길이 상한). */
export const COIN_ID_SHAPE = /^[a-z0-9_]{1,40}$/;

/** 진행도 상한 — 세이브의 진행도는 [0, 1) 이다 (넘친 주기는 이미 지갑에 들어갔어야 한다). */
const PROGRESS_MAX = 1 - 1e-9;

/* ── 프로세서 칸 ───────────────────────────────────────────────────────────── */

/** 칸 목록을 `max` 길이로 맞춘 사본 (없는 칸은 빈 칸). 저장된 목록이 짧거나 길어도 화면 격자와 길이가 맞는다. */
export function processorCells(slot: ComputeClusterSlot | null | undefined, max: number): (number | null)[] {
  const n = Math.max(0, Math.floor(max));
  const src = slot?.processors;
  const out: (number | null)[] = new Array(n).fill(null);
  if (!Array.isArray(src)) return out;
  for (let i = 0; i < n && i < src.length; i++) {
    const v = src[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null;
  }
  return out;
}

/** 꽂힌 프로세서 **개수** (레일 점 · 「n/m」 표시 · 「꽂을 자리가 있나」 판단). */
export function processorCount(slot: ComputeClusterSlot | null | undefined): number {
  const src = slot?.processors;
  return Array.isArray(src) ? src.reduce((n: number, v) => n + (typeof v === 'number' ? 1 : 0), 0) : 0;
}

/**
 * 클러스터의 **성능 합** — 옛 식에서 「코어 개수」가 있던 자리다. 새것 한 개가 1, **다 닳은 것은 0.5** 이므로
 * 다 닳은 둘은 새것 하나 몫밖에 못 한다 (사용자 결정: 최고 성능을 내려면 수리해야 한다). `durMax` 는 프로세서의
 * 최대 내구도 (아이템 표를 못 읽으면 0 — 그때는 전부 새것으로 본다).
 */
export function clusterPerf(slot: ComputeClusterSlot | null | undefined, durMax: number): number {
  const src = slot?.processors;
  if (!Array.isArray(src)) return 0;
  let sum = 0;
  for (const v of src) if (typeof v === 'number' && Number.isFinite(v)) sum += processorPerf(v, durMax);
  return sum;
}

/**
 * 성능 합 `perf` 로 이 코인을 캘 때의 주기 (ms). 계약의 `coinCycleMs(def, cores)` 와 **같은 식**이지만 그쪽은 코어 개수를
 * 정수로 내림한다 — 성능 합은 소수(다 닳은 프로세서 = 0.5)라 여기서 같은 식을 소수로 편다. 성능 0 = Infinity.
 */
export function clusterCycleMs(def: CryptoCoinDef, perf: number): number {
  if (!(perf > 0) || !(def.cycleHours > 0)) return Infinity;
  return Math.max(1000, def.cycleHours * 3_600_000 * Math.pow(COMPUTE_CORE_TIME_MUL, perf - 1));
}

/**
 * 주기 `cycles` 번이 끝났을 때의 마모 (순수 — 칸을 고친다): 꽂힌 **모든** 프로세서가 `PROCESSOR_WEAR_PER_CYCLE × cycles`
 * 만큼 닳고 0 에서 멈춘다 (0 이어도 빠지지 않는다 — 절반 성능으로 계속 돈다). 실제로 닳은 프로세서가 있었으면 true.
 * 부동소수 찌꺼기는 소수 둘째 자리에서 자른다 (흙 · 배지의 `wearAfterHarvest` 와 같은 규약).
 */
export function wearProcessors(slot: ComputeClusterSlot, cycles: number): boolean {
  const n = Math.max(0, Math.floor(Number.isFinite(cycles) ? cycles : 0));
  const amount = n * PROCESSOR_WEAR_PER_CYCLE;
  if (!(amount > 0) || !Array.isArray(slot.processors)) return false;
  let worn = false;
  for (let i = 0; i < slot.processors.length; i++) {
    const v = slot.processors[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    slot.processors[i] = Math.max(0, Math.round((v - amount) * 100) / 100);
    worn = true;
  }
  return worn;
}

/**
 * 끝난 주기를 떼어 낸다 (순수 — 칸을 고친다). `now` 기준 누적 진행도에서 정수 부분이 끝난 주기 수이고, 칸에는 소수 부분과
 * 새 구간 시작(`now`)이 남는다 — 소수 부분을 버리지 않으므로 몇 번에 나눠 떼어도 같은 답이다. 끝난 주기 수를 돌려준다 (0 = 칸 그대로).
 *
 * 한 번에 여러 주기가 밀려 나오는 것은 오프라인 · 레이드 뒤의 따라잡기다. 그 구간은 **구간 시작 시점의 성능**으로 셈한다
 * (그 사이의 마모를 주기마다 되먹이지 않는다) — 닳는 양은 정확하고 속도만 그 구간 동안 고정인 근사다.
 */
export function takeCompletedCycles(slot: ComputeClusterSlot, cycleMs: number, now: number): number {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return 0;
  const p = miningProgressAt(slot.progress, slot.segmentAt, now, cycleMs);
  const whole = Math.floor(p);
  if (!(whole >= 1)) return 0;
  slot.progress = Math.min(PROGRESS_MAX, Math.max(0, p - whole));
  slot.segmentAt = now;
  return whole;
}

/**
 * 지금까지의 진행도를 접고 `now` 에서 새 구간을 연다 (프로세서가 바뀌기 **직전**에 옛 주기 길이로 부른다 — 손해 없음).
 * 주기가 없으면(코인 · 프로세서 없음) 진행도는 그대로이고 구간만 새로 연다. 끝난 주기는 먼저 `takeCompletedCycles` 로 떼어 둔다.
 */
export function foldProgress(slot: ComputeClusterSlot, cycleMs: number, now: number): void {
  const p = Number.isFinite(cycleMs) && cycleMs > 0 ? miningProgressAt(slot.progress, slot.segmentAt, now, cycleMs) : slot.progress;
  slot.progress = Math.min(PROGRESS_MAX, Math.max(0, Number.isFinite(p) ? p : 0));
  slot.segmentAt = now;
}

/** 이 칸을 세이브에 남길 이유가 있는가 (코인을 정했거나 프로세서가 꽂혀 있다). */
export function slotWorthKeeping(slot: ComputeClusterSlot): boolean {
  return !!slot.coinId || processorCount(slot) > 0;
}

export interface SanitizedClusters {
  clusters: ComputeClusterSlot[];
  /**
   * 함선 창고로 돌려줄 **프로세서 개수**. 둘이 들어온다:
   *  ① 배치되지 않은(회수 · 창고로 밀려남 · 드롭) 클러스터에 꽂혀 있던 것,
   *  ② 2026-09-16 이관 — 옛 세이브의 `cores`(연산 코어 개수). 연산 코어는 아이템 표에서 **사라졌으므로**
   *     같은 수의 프로세서로 바꿔 돌려주고 클러스터는 비운다 (내구도를 모르는 채 꽂아 두는 것보다 정직하다).
   * 환불 자루(`CraftIngredient`)는 내구도를 싣지 못하므로 전부 **새것으로** 돌아간다.
   */
  orphanCores: number;
}

/**
 * `ShipState.clusters` 정리 (순수). 배치된 클러스터 uid(`placed`)의 칸만 남기고 uid 하나에 한 칸, 프로세서는 칸마다
 * `null` 또는 유한한 0 이상의 내구도(길이 ≤ `maxCores`), 진행도는 유한한 [0, 1), 구간 시작은 유한한 양수(아니면 `now` —
 * 진행을 새로 쌓는다), 코인 id 는 모양만 본다(진짜 코인인지는 런타임).
 * 배치되지 않은 uid 의 칸은 버리되 **꽂혀 있던 프로세서는 `orphanCores` 로 센다** — 프로세서는 사라지지 않는다.
 * 같은 uid 의 두 번째 칸은 망가진 세이브라 세지 않고 버린다 (손으로 고친 세이브로 프로세서를 불리는 길을 막는다).
 *
 * 2026-09-16 이관: 옛 세이브의 `cores`(연산 코어 개수)는 칸에 꽂지 않고 그 수만큼 `orphanCores` 로 보낸다 —
 * 세이브 정리는 순수 함수라 아이템 표(프로세서의 최대 내구도)를 모르고, 내구도를 지어내느니 **새 프로세서로 돌려주는**
 * 편이 정직하다. `SanitizedClusters.orphanCores` 의 주석이 그 자리다.
 */
export function sanitizeClusters(raw: unknown, placed: ReadonlySet<string>, maxCores: number, now: number = Date.now()): SanitizedClusters {
  const clusters: ComputeClusterSlot[] = [];
  let orphanCores = 0;
  const seen = new Set<string>();
  const max = Math.max(0, Math.floor(maxCores));
  for (const e of Array.isArray(raw) ? (raw as Partial<ComputeClusterSlot>[]) : []) {
    if (!e || typeof e !== 'object' || typeof e.uid !== 'string' || !e.uid) continue;
    const processors = readProcessors(e, max);
    const legacyCores = Array.isArray(e.processors) ? 0 : clampInt(e.cores, max);
    const mounted = processors.reduce((n: number, v) => n + (typeof v === 'number' ? 1 : 0), 0) + legacyCores;
    if (!placed.has(e.uid)) { if (!seen.has(e.uid)) orphanCores += mounted; seen.add(e.uid); continue; }
    if (seen.has(e.uid)) continue;
    seen.add(e.uid);
    orphanCores += legacyCores;                       // 배치돼 있어도 옛 코어는 칸에 남지 않고 프로세서로 환불된다
    const progress = typeof e.progress === 'number' && Number.isFinite(e.progress) ? Math.min(PROGRESS_MAX, Math.max(0, e.progress)) : 0;
    const segmentAt = typeof e.segmentAt === 'number' && Number.isFinite(e.segmentAt) && e.segmentAt > 0 ? e.segmentAt : now;
    const slot: ComputeClusterSlot = { uid: e.uid, processors, progress, segmentAt };
    if (typeof e.coinId === 'string' && COIN_ID_SHAPE.test(e.coinId)) slot.coinId = e.coinId;
    if (slotWorthKeeping(slot)) clusters.push(slot);
  }
  return { clusters, orphanCores };
}

function clampInt(v: unknown, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

/**
 * 저장된 칸 목록 → 검증된 `max` 길이 목록 (빈 칸 null · 유한한 0 이상의 내구도). 목록이 없으면 전부 빈 칸이다.
 * **`processorCells` 와 같은 규칙을 써야 한다** — 둘이 갈리면 같은 세이브가 읽는 경로에 따라 프로세서 하나를
 * 꽂힌 것으로도, 빈 칸으로도 보게 된다. 음수 내구도(손으로 고친 세이브)는 **0 으로 조여 꽂아 둔다**: 칸을
 * 비우면 플레이어의 아이템이 조용히 사라지고, 0 으로 두면 완전히 닳은 프로세서라 수리해서 되살릴 수 있다.
 */
function readProcessors(e: Partial<ComputeClusterSlot>, max: number): (number | null)[] {
  return processorCells({ processors: Array.isArray(e.processors) ? e.processors : undefined } as ComputeClusterSlot, max);
}

/** 지갑 · 누적 채굴 정리 (순수): 코인 id 모양의 키, 유한한 정수 ≥ 1 값만 (0 은 적지 않는다). */
export function sanitizeUnitsMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!COIN_ID_SHAPE.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const n = Math.floor(v);
    if (n >= 1) out[k] = Math.min(Number.MAX_SAFE_INTEGER, n);
  }
  return out;
}
