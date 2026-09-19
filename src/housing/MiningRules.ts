/* ────────────────────────────────────────────────────────────────────────────
 * src/housing/MiningRules.ts — **the pure rules of crypto mining** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, user's decision).
 *
 * No ctx · no DOM. Used by `parts/Mining.ts` (runtime) and `ShipState.sanitize` (save sanitizing) alike — `Rules.ts` holds
 * the placement · facility · station rules, so the mining rules live in their own file rather than growing it. The cycle · progress formulas themselves
 * live in `shared/cryptoMarket` alongside the relay (`miningCycleMs` · `miningProgressAt`); only their **one cluster cell** form is here.
 *
 * **2026-09-16 (user's decision — the `연산 코어` compute core dropped)**: **processors** mount into a cluster directly and
 * have durability. So a cell is not 「one count」 but a **list of remaining durabilities per cell** (`ComputeClusterSlot.processors`)
 * — the index is the screen grid cell, so only the worn-out one in cell 3 can be pulled and repaired. Speed comes from the
 * **perf sum** (`clusterPerf`), not the count, and every completed cycle wears every mounted one by `PROCESSOR_WEAR_PER_CYCLE`.
 * ──────────────────────────────────────────────────────────────────────────── */
import type { ComputeClusterSlot, CryptoCoinDef } from '@/shared';
import { COMPUTE_CORE_TIME_MUL, PROCESSOR_WEAR_PER_CYCLE, miningProgressAt, processorPerf } from '@/shared';

/** The reason for refusing to recover a cluster with processors mounted (the same place as the bookshelf's `BOOKS_BLOCK_REASON`). */
export const CLUSTER_CORES_BLOCK_REASON = '프로세서를 먼저 빼세요';

/** The mining catch-up tick interval (ms) — a cycle is minutes at the shortest, so 1 s is plenty (a display · save frequency, not a balance number). */
export const MINING_TICK_MS = 1000;

/** The coin id shape the save · the credit reason use (`shared/crypto`'s rule + a length cap). */
export const COIN_ID_SHAPE = /^[a-z0-9_]{1,40}$/;

/** The progress cap — progress in the save is [0, 1) (an overflowed cycle must already have gone into the wallet). */
const PROGRESS_MAX = 1 - 1e-9;

/* ── Processor cells ───────────────────────────────────────────────────── */

/** A copy of the cell list sized to `max` (a missing cell is empty), so a stored list that is short or long still matches the screen grid. */
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

/** The **count** of mounted processors (the rail dot · the 「n/m」 readout · deciding 「is there a free cell to mount into」). */
export function processorCount(slot: ComputeClusterSlot | null | undefined): number {
  const src = slot?.processors;
  return Array.isArray(src) ? src.reduce((n: number, v) => n + (typeof v === 'number' ? 1 : 0), 0) : 0;
}

/**
 * The cluster's **perf sum** — where 「the core count」 stood in the old formula. A new one is 1 and **a worn-out one is 0.5**,
 * so two worn-out ones do the work of one new one (user's decision: reaching top perf takes a repair). `durMax` is the
 * processor's maximum durability (0 when the item table cannot be read — everything then counts as new).
 */
export function clusterPerf(slot: ComputeClusterSlot | null | undefined, durMax: number): number {
  const src = slot?.processors;
  if (!Array.isArray(src)) return 0;
  let sum = 0;
  for (const v of src) if (typeof v === 'number' && Number.isFinite(v)) sum += processorPerf(v, durMax);
  return sum;
}

/**
 * The cycle (ms) for mining this coin at perf sum `perf`. **The same formula** as the contract's `coinCycleMs(def, cores)`, but
 * that one floors the core count — a perf sum is fractional (a worn-out processor = 0.5), so this is its fractional form. Perf 0 = Infinity.
 */
export function clusterCycleMs(def: CryptoCoinDef, perf: number): number {
  if (!(perf > 0) || !(def.cycleHours > 0)) return Infinity;
  return Math.max(1000, def.cycleHours * 3_600_000 * Math.pow(COMPUTE_CORE_TIME_MUL, perf - 1));
}

/**
 * The wear once `cycles` cycles have completed (pure — it edits the cell): **every** mounted processor wears by
 * `PROCESSOR_WEAR_PER_CYCLE × cycles` and stops at 0 (a 0 is not unmounted — it keeps running at half perf). True when a processor really wore.
 * Float residue is cut at the second decimal (the same contract as soil · medium `wearAfterHarvest`).
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
 * Takes the completed cycles off (pure — it edits the cell). The integer part of the accumulated progress at `now` is the number of
 * completed cycles, and the cell keeps the fractional part and a new segment start (`now`) — the fraction is never dropped, so taking them
 * off in several goes gives the same answer. Returns the number of completed cycles (0 = the cell is untouched).
 *
 * Several cycles falling out at once is the catch-up after being offline · after a raid. That segment is counted at **the perf at the
 * segment's start** (the wear in between is not fed back per cycle) — the wear is exact, only the speed is an approximation held fixed across it.
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
 * Folds the progress so far and opens a new segment at `now` (called **just before** the processors change, with the old cycle length — nothing is lost).
 * With no cycle (no coin · no processor) the progress is left alone and only the segment is reopened. Completed cycles are taken off with `takeCompletedCycles` first.
 */
export function foldProgress(slot: ComputeClusterSlot, cycleMs: number, now: number): void {
  const p = Number.isFinite(cycleMs) && cycleMs > 0 ? miningProgressAt(slot.progress, slot.segmentAt, now, cycleMs) : slot.progress;
  slot.progress = Math.min(PROGRESS_MAX, Math.max(0, Number.isFinite(p) ? p : 0));
  slot.segmentAt = now;
}

/** Is there a reason to keep this cell in the save (a coin is chosen, or a processor is mounted). */
export function slotWorthKeeping(slot: ComputeClusterSlot): boolean {
  return !!slot.coinId || processorCount(slot) > 0;
}

export interface SanitizedClusters {
  clusters: ComputeClusterSlot[];
  /**
   * The **number of processors** to return to the ship stash. Two things land here:
   *  ① what was mounted in a cluster that is not placed (recovered · pushed into the stash · dropped),
   *  ② the 2026-09-16 migration — an old save's `cores` (the `연산 코어` count). The compute core is **gone** from the item
   *     table, so the same number of processors is returned instead and the cluster is emptied (more honest than mounting them
   *     with a durability nobody knows).
   * The refund bag (`CraftIngredient`) cannot carry durability, so they all come back **as new**.
   */
  orphanCores: number;
}

/**
 * Sanitizes `ShipState.clusters` (pure). Only the cells of a placed cluster uid (`placed`) survive, one cell per uid; a processor
 * is `null` or a finite durability ≥ 0 per cell (length ≤ `maxCores`), progress a finite [0, 1), the segment start a finite positive
 * number (otherwise `now` — progress accumulates afresh), and the coin id is shape-checked only (whether it is a real coin is runtime).
 * A cell of a uid that is not placed is dropped, but **the processors it held are counted into `orphanCores`** — a processor never disappears.
 * A second cell for the same uid is a broken save: dropped uncounted (it closes the route to multiplying processors with a hand-edited save).
 *
 * 2026-09-16 migration: an old save's `cores` (the `연산 코어` count) is not mounted into a cell but sent to `orphanCores` as that
 * many — save sanitizing is a pure function and does not know the item table (a processor's maximum durability), and **returning new
 * processors** is more honest than inventing a durability. The comment on `SanitizedClusters.orphanCores` is where that is written down.
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
    orphanCores += legacyCores;                       // even when placed, an old core does not stay in a cell — it is refunded as a processor
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
 * A stored cell list → a validated list of length `max` (an empty cell null · a finite durability ≥ 0). With no list every cell is empty.
 * **It must use the same rule as `processorCells`** — if the two differ, the same save shows one processor as mounted down one
 * read path and as an empty cell down the other. A negative durability (a hand-edited save) is **clamped to 0 and left mounted**:
 * emptying the cell would silently lose the player's item, while 0 is a fully worn processor that a repair brings back.
 */
function readProcessors(e: Partial<ComputeClusterSlot>, max: number): (number | null)[] {
  return processorCells({ processors: Array.isArray(e.processors) ? e.processors : undefined } as ComputeClusterSlot, max);
}

/** Sanitizes the wallet · the mined total (pure): keys of coin-id shape, values a finite integer ≥ 1 only (0 is not written). */
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
