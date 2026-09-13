/* ────────────────────────────────────────────────────────────────────────────
 * src/housing/MiningRules.ts — **암호화폐 채굴의 순수 규칙** (2026-09-13, docs/plans/power-crypto.md, 사용자 결정).
 *
 * ctx · DOM 없음. `parts/Mining.ts`(런타임)와 `ShipState.sanitize`(세이브 정리)가 같이 쓴다 — `Rules.ts` 는 배치 규칙 에이전트의
 * 파일이라 채굴 규칙은 여기로 갈라 두었다. 주기 · 진행도 식 자체는 릴레이와 함께 쓰는 `shared/cryptoMarket` 에 있다
 * (`miningCycleMs` · `miningProgressAt`); 여기서는 그 식을 **클러스터 한 칸**에 적용하는 부분만 갖는다.
 * ──────────────────────────────────────────────────────────────────────────── */
import type { ComputeClusterSlot } from '@/shared';
import { miningProgressAt } from '@/shared';

/** 코어가 꽂힌 클러스터를 회수하려 할 때의 사유 (책장의 `BOOKS_BLOCK_REASON` 과 같은 자리). */
export const CLUSTER_CORES_BLOCK_REASON = '코어를 먼저 빼세요';

/** 채굴 따라잡기 틱 간격(ms) — 주기는 최소 수 분이라 1초면 충분하다 (표시 · 저장 빈도이지 밸런스 수치가 아니다). */
export const MINING_TICK_MS = 1000;

/** 세이브 · 크레딧 사유가 쓰는 코인 id 모양 (`shared/crypto` 의 규칙 + 길이 상한). */
export const COIN_ID_SHAPE = /^[a-z0-9_]{1,40}$/;

/** 진행도 상한 — 세이브의 진행도는 [0, 1) 이다 (넘친 주기는 이미 지갑에 들어갔어야 한다). */
const PROGRESS_MAX = 1 - 1e-9;

/**
 * 끝난 주기를 떼어 낸다 (순수 — 칸을 고친다). `now` 기준 누적 진행도에서 정수 부분이 끝난 주기 수이고, 칸에는 소수 부분과
 * 새 구간 시작(`now`)이 남는다 — 소수 부분을 버리지 않으므로 몇 번에 나눠 떼어도 같은 답이다. 끝난 주기 수를 돌려준다 (0 = 칸 그대로).
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
 * 지금까지의 진행도를 접고 `now` 에서 새 구간을 연다 (코어 수가 바뀌기 **직전**에 옛 주기 길이로 부른다 — 손해 없음).
 * 주기가 없으면(코인 · 코어 없음) 진행도는 그대로이고 구간만 새로 연다. 끝난 주기는 먼저 `takeCompletedCycles` 로 떼어 둔다.
 */
export function foldProgress(slot: ComputeClusterSlot, cycleMs: number, now: number): void {
  const p = Number.isFinite(cycleMs) && cycleMs > 0 ? miningProgressAt(slot.progress, slot.segmentAt, now, cycleMs) : slot.progress;
  slot.progress = Math.min(PROGRESS_MAX, Math.max(0, Number.isFinite(p) ? p : 0));
  slot.segmentAt = now;
}

/** 이 칸을 세이브에 남길 이유가 있는가 (코인을 정했거나 코어가 꽂혀 있다). */
export function slotWorthKeeping(slot: ComputeClusterSlot): boolean {
  return !!slot.coinId || slot.cores > 0;
}

export interface SanitizedClusters {
  clusters: ComputeClusterSlot[];
  /** 배치되지 않은(회수 · 창고로 밀려남 · 드롭) 클러스터에 꽂혀 있던 코어 수 — 부르는 쪽이 함선 창고로 환불한다. */
  orphanCores: number;
}

/**
 * `ShipState.clusters` 정리 (순수). 배치된 클러스터 uid(`placed`)의 칸만 남기고 uid 하나에 한 칸, 코어는 정수 0 … `maxCores`,
 * 진행도는 유한한 [0, 1), 구간 시작은 유한한 양수(아니면 `now` — 진행을 새로 쌓는다), 코인 id 는 모양만 본다(진짜 코인인지는 런타임).
 * 배치되지 않은 uid 의 칸은 버리되 **꽂혀 있던 코어는 `orphanCores` 로 센다** — 코어는 사라지지 않는다.
 * 같은 uid 의 두 번째 칸은 망가진 세이브라 코어를 세지 않고 버린다 (손으로 고친 세이브로 코어를 불리는 길을 막는다).
 */
export function sanitizeClusters(raw: unknown, placed: ReadonlySet<string>, maxCores: number, now: number = Date.now()): SanitizedClusters {
  const clusters: ComputeClusterSlot[] = [];
  let orphanCores = 0;
  const seen = new Set<string>();
  const max = Math.max(0, Math.floor(maxCores));
  for (const e of Array.isArray(raw) ? (raw as Partial<ComputeClusterSlot>[]) : []) {
    if (!e || typeof e !== 'object' || typeof e.uid !== 'string' || !e.uid) continue;
    const coresRaw = Math.floor(Number(e.cores));
    const cores = Number.isFinite(coresRaw) ? Math.max(0, Math.min(max, coresRaw)) : 0;
    if (!placed.has(e.uid)) { if (!seen.has(e.uid)) orphanCores += cores; seen.add(e.uid); continue; }
    if (seen.has(e.uid)) continue;
    seen.add(e.uid);
    const progress = typeof e.progress === 'number' && Number.isFinite(e.progress) ? Math.min(PROGRESS_MAX, Math.max(0, e.progress)) : 0;
    const segmentAt = typeof e.segmentAt === 'number' && Number.isFinite(e.segmentAt) && e.segmentAt > 0 ? e.segmentAt : now;
    const slot: ComputeClusterSlot = { uid: e.uid, cores, progress, segmentAt };
    if (typeof e.coinId === 'string' && COIN_ID_SHAPE.test(e.coinId)) slot.coinId = e.coinId;
    if (slotWorthKeeping(slot)) clusters.push(slot);
  }
  return { clusters, orphanCores };
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
