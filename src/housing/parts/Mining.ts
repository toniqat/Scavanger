/**
 * src/housing/parts/Mining.ts — **crypto mining · the wallet · the exchange** (2026-09-13, user's decision).
 *
 * One compute cluster (`furn_compute_cluster`) is one clock — it does not run separately per mounted processor. The cycle is
 * `clusterCycleMs(coin, the perf sum)`, and each completed cycle puts `yieldUnits` into the wallet (`ShipState.cryptoWallet`) by
 * itself before the next one follows. Offline · in-raid time is caught up in one go when the tick runs in the ship (one `housing:cryptoMined` per cluster).
 *
 * **2026-09-16 (user's decision — the `연산 코어` compute core dropped)**: what mounts into a cluster is a **processor** (`PROCESSOR_DEF_ID`), and it has durability.
 * A cell is not a count but the **remaining durability per cell** (`ComputeClusterSlot.processors`), and the index is the screen grid cell.
 *  - **Speed** is the perf sum (`clusterPerf`), not the count — a worn-out processor is worth half a new one (`PROCESSOR_PERF_MIN`).
 *  - **Wear** lands on **every** mounted processor right where the cycle ends, `PROCESSOR_WEAR_PER_CYCLE × the completed cycles`.
 *    A 0 is not unmounted and keeps running at half perf — reaching top perf means pulling it and repairing it at the ship workbench.
 *  - Pulling one returns it to the bag · the stash **carrying that cell's durability** (`loot.createItem(…, { durability })`).
 *
 * The clock contract:
 *  - 「now」 = `sys.nowMs()`. Power allocation was dropped the same day, 2026-09-13, so there is no stopped clock (`stationNow` · `housing:operationalChanged`).
 *  - When the mounted processors change, the completed cycles go in first and the progress is folded at the old cycle length (nothing is lost). Changing coin resets progress to 0.
 *  - **It does not run while the ship has no main computer** (user's decision 「메인 컴퓨터 필수」) — while blocked, a new segment is opened.
 *
 * Trading only ever goes by the server quote — the credits wait on `ctx.meta.creditsTx` through the relay's check (`cbuy` · `csell`), and the
 * wallet grows **only on success** (a sale is taken off first and restored on a refusal — it closes the route to selling the same units twice).
 */
import type {
  ComputeClusterInfo, ComputeClusterSlot, CryptoCoinDef, CryptoCoinInfo, CryptoQuote, CryptoTradeSide, HarvestDestination, PlacedFurniture,
} from '@/shared';
import {
  COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, CORP_DEFS, CRYPTO_COIN_DEFS,
  CRYPTO_COIN_MAP, CRYPTO_TRADE_MAX_UNITS, MINING_COMPUTER_DEF_ID, MINING_COMPUTER_REQUIRED_REASON_KO, NPC_DEF_MAP, NPC_QUEST_MAP, PROCESSOR_DEF_ID, cryptoCreditsFor,
  formatCoinUnits, formatCreditReason, miningProgressAt,
} from '@/shared';
import type { ItemInstance } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import {
  CLUSTER_CORES_BLOCK_REASON, MINING_TICK_MS, clusterCycleMs, clusterPerf, foldProgress, processorCells, processorCount,
  slotWorthKeeping, takeCompletedCycles, wearProcessors,
} from '../MiningRules';
import { deliverItem, noRoomReason } from './Deliver';

/* ── Runtime (not saved) ───────────────────────────────────────────────── */
interface MiningRuntime {
  /** The last tick's `performance.now()`. */
  lastTick: number;
  /** A cell was edited while handling an event and has to be saved on the next tick (so `changed()` is never called inside an event). */
  dirty: boolean;
}
const RUNTIME = new WeakMap<HousingSystem, MiningRuntime>();
function runtime(sys: HousingSystem): MiningRuntime {
  let r = RUNTIME.get(sys);
  if (!r) { r = { lastTick: -Infinity, dirty: false }; RUNTIME.set(sys, r); }
  return r;
}

const EMPTY_WALLET: Readonly<Record<string, number>> = Object.freeze({});

/* ── State access ──────────────────────────────────────────────────────── */
export function clusterSlots(sys: HousingSystem): ComputeClusterSlot[] { return (sys.state.clusters ??= []); }
function walletMap(sys: HousingSystem): Record<string, number> { return (sys.state.cryptoWallet ??= {}); }
function minedMap(sys: HousingSystem): Record<string, number> { return (sys.state.cryptoMined ??= {}); }

/** The furniture when `uid` is a placed compute cluster, else null. */
export function clusterOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const f = sys.getPlacedByUid(uid);
  return f && f.defId === COMPUTE_CLUSTER_DEF_ID ? f : null;
}

function slotOf(sys: HousingSystem, uid: string): ComputeClusterSlot | null {
  return sys.state.clusters?.find((s) => s.uid === uid) ?? null;
}

function ensureSlot(sys: HousingSystem, uid: string): ComputeClusterSlot {
  let s = slotOf(sys, uid);
  if (!s) { s = { uid, processors: [], progress: 0, segmentAt: clockOf(sys, uid) }; clusterSlots(sys).push(s); }
  return s;
}

/** A cell with neither a coin nor a processor is not kept in the save. */
function pruneSlot(sys: HousingSystem, slot: ComputeClusterSlot): void {
  if (slotWorthKeeping(slot)) return;
  const list = clusterSlots(sys);
  const i = list.indexOf(slot);
  if (i >= 0) list.splice(i, 1);
}

/** This cluster's 「now」 (since power was dropped on 2026-09-13 there is no stopped clock, so it is the server time as-is). */
function clockOf(sys: HousingSystem, _uid: string): number {
  return sys.nowMs();
}

/* ── Processor cells ───────────────────────────────────────────────────── */
/**
 * The processor's maximum durability (`ItemDef.durabilityMax`). 0 while the item table cannot be read yet — `processorPerf` then
 * counts everything as new (housing is registered **before** inventory · items, so at constructor time it really is 0).
 */
function processorDurMax(sys: HousingSystem): number {
  const v = sys.defOf(PROCESSOR_DEF_ID)?.durabilityMax;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** This cluster's perf sum — the cycle comes from this value, not from the count. */
function perfOf(sys: HousingSystem, slot: ComputeClusterSlot | null): number {
  return clusterPerf(slot, processorDurMax(sys));
}

/** The processor instances in the bag + the ship stash, **highest durability first** (a count-based mount uses the good ones first). */
function ownedProcessors(sys: HousingSystem): ItemInstance[] {
  const inv = sys.ctx.inventory;
  if (!inv) return [];
  const bag = typeof inv.getAllItems === 'function' ? inv.getAllItems() : [];
  const stash = typeof inv.getStashItems === 'function' ? inv.getStashItems() : [];
  const max = processorDurMax(sys);
  return [...bag, ...stash]
    .filter((i) => i.defId === PROCESSOR_DEF_ID)
    .sort((a, b) => (b.durability ?? max) - (a.durability ?? max));
}

/** Resizes the cell list to `COMPUTE_CLUSTER_MAX_CORES` and writes it back into the cell (matching the save · the screen grid length). */
function cellsOf(slot: ComputeClusterSlot): (number | null)[] {
  slot.processors = processorCells(slot, COMPUTE_CLUSTER_MAX_CORES);
  return slot.processors;
}

/* ── Locks · operation ─────────────────────────────────────────────────── */
/** Why the coin is locked (`<기업> 퀘스트 「…」 완료 필요`), null once unlocked. With no meta it counts as locked. */
export function coinLockReason(sys: HousingSystem, def: CryptoCoinDef): string | null {
  if (!def.unlockQuest) return null;
  let state: string | undefined;
  try { state = sys.ctx.meta?.getQuestState(def.unlockQuest); } catch { state = undefined; }
  if (state === 'complete') return null;
  // 2026-09-14: corporation quests dropped — an unlock quest is a corporation-executive NPC's quest (`shared/npc.ts`)
  const quest = NPC_QUEST_MAP.get(def.unlockQuest);
  const npc = quest ? NPC_DEF_MAP.get(quest.npc) : undefined;
  const corpId = def.corp ?? npc?.corp ?? null;
  const corpName = corpId ? CORP_DEFS[corpId]?.name ?? corpId : '기업';
  return `${corpName} 퀘스트 「${quest?.name ?? def.unlockQuest}」 완료 필요`;
}

export function getMiningComputerUid(sys: HousingSystem): string | null {
  return sys.state.furniture.find((f) => f.defId === MINING_COMPUTER_DEF_ID)?.uid ?? null;
}

/**
 * The furniture-side reason a compute cluster cannot mine — the ship has no main computer (user's decision 「메인 컴퓨터 필수」). Null when it is not a cluster.
 * `HousingSystem.furnitureOperationalBlock` returns this as-is (the only 「running」 condition left after power was dropped on 2026-09-13).
 */
export function clusterOperationalBlock(sys: HousingSystem, uid: string): string | null {
  if (!clusterOf(sys, uid)) return null;
  return getMiningComputerUid(sys) ? null : MINING_COMPUTER_REQUIRED_REASON_KO;
}

function operationalBlock(sys: HousingSystem, uid: string): string | null {
  return clusterOperationalBlock(sys, uid);
}

/** Can this mining cell have a cycle (a known · unlocked coin + at least one processor) — that coin, else null. */
function activeCoin(sys: HousingSystem, slot: ComputeClusterSlot | null): CryptoCoinDef | null {
  if (!slot || processorCount(slot) < 1 || !slot.coinId) return null;
  const coin = CRYPTO_COIN_MAP.get(slot.coinId);
  return coin && !coinLockReason(sys, coin) ? coin : null;
}

/** The Korean reason the clock is not running (no coin chosen · a locked coin · no processor · the main computer), null when it runs. */
function miningBlock(sys: HousingSystem, uid: string, slot: ComputeClusterSlot | null): string | null {
  const coin = slot?.coinId ? CRYPTO_COIN_MAP.get(slot.coinId) : undefined;
  if (!coin) return '채굴할 코인을 정하세요';
  const lock = coinLockReason(sys, coin);
  if (lock) return lock;
  if (!slot || processorCount(slot) < 1) return '프로세서를 꽂으세요';
  return operationalBlock(sys, uid);
}

/* ── Wallet ────────────────────────────────────────────────────────────── */
function addWallet(sys: HousingSystem, coinId: string, delta: number, reason: 'mined' | 'buy' | 'sell' | 'cheat'): void {
  const w = walletMap(sys);
  const before = Math.max(0, Math.floor(w[coinId] ?? 0));
  const after = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(before + delta)));
  if (after > 0) w[coinId] = after; else delete w[coinId];
  if (after !== before) sys.ctx.bus.emit('housing:walletChanged', { coinId, units: after, delta: after - before, reason });
}

/* ── Taking cycles off · folding ───────────────────────────────────────── */
/**
 * Puts the completed cycles into the wallet. Blocked with no main computer it puts nothing in and only opens a new segment (it does not run while blocked).
 * Returns the units put in and whether the cell was edited — `touched` is what `tickMining` saves on, so a fold-only pass stays out of the save.
 */
function settle(sys: HousingSystem, slot: ComputeClusterSlot): { units: number; touched: boolean } {
  const coin = activeCoin(sys, slot);
  if (!coin) return { units: 0, touched: false };
  const now = clockOf(sys, slot.uid);
  if (operationalBlock(sys, slot.uid)) {
    foldProgress(slot, Infinity, now);                  // the time ledger only — not saved every tick (the next real change carries it)
    return { units: 0, touched: false };
  }
  const cycles = takeCompletedCycles(slot, clusterCycleMs(coin, perfOf(sys, slot)), now);
  if (cycles < 1) return { units: 0, touched: false };
  // 2026-09-16 (user's decision): when a cycle ends every mounted processor wears right there — the next cycle is that much slower (it stops at 0 and runs at half perf)
  wearProcessors(slot, cycles);
  const units = Math.min(Number.MAX_SAFE_INTEGER, cycles * coin.yieldUnits);
  const mined = minedMap(sys);
  mined[coin.id] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((mined[coin.id] ?? 0) + units));
  addWallet(sys, coin.id, units, 'mined');
  sys.ctx.bus.emit('housing:cryptoMined', { uid: slot.uid, coinId: coin.id, units });
  return { units, touched: true };
}

/** Puts the completed cycles in and folds the progress at the current setup's cycle (mounted processors · coin) — called **just before** that setup changes. */
function settleAndFold(sys: HousingSystem, slot: ComputeClusterSlot): void {
  settle(sys, slot);
  const coin = activeCoin(sys, slot);
  const now = clockOf(sys, slot.uid);
  const blocked = !!operationalBlock(sys, slot.uid);
  foldProgress(slot, coin && !blocked ? clusterCycleMs(coin, perfOf(sys, slot)) : Infinity, now);
}

function commit(sys: HousingSystem, uid: string, reason: string): null {
  sys.ctx.bus.emit('housing:clusterChanged', { uid });
  sys.changed(reason);
  return null;
}

/* ── Tick · subscriptions ──────────────────────────────────────────────── */
/** `HousingSystem.update` calls this every frame — completed cycles go in once a second. Nothing goes in during a raid (it catches up on the return to the ship). */
export function tickMining(sys: HousingSystem): void {
  const r = runtime(sys);
  const t = performance.now();
  if (t - r.lastTick < MINING_TICK_MS) return;
  r.lastTick = t;
  let dirty = r.dirty;
  r.dirty = false;
  let raid = false;
  try { raid = sys.ctx.isRaidActive(); } catch { raid = false; }
  const list = sys.state.clusters;
  if (!raid && list?.length) {
    for (const slot of list) {
      if (!clusterOf(sys, slot.uid)) continue;
      if (settle(sys, slot).touched) dirty = true;
    }
  }
  if (dirty) sys.changed('mining');
}

/** Subscriptions — clearing the cell of a recovered cluster. `HousingSystem.init` puts it into unsubs. */
export function bindMining(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  return [
    b.on('housing:furnitureRecovered', ({ uid, defId }) => {
      if (defId !== COMPUTE_CLUSTER_DEF_ID) return;
      const slot = slotOf(sys, uid);
      if (!slot) return;
      clusterSlots(sys).splice(clusterSlots(sys).indexOf(slot), 1);   // the processors were already pulled before the recovery (`clusterRecoverBlock`)
    }),
  ];
}

/** A cluster with processors mounted cannot be recovered (so no durability is lost — a person pulls them first). Null when it is not a cluster, or empty. */
export function clusterRecoverBlock(sys: HousingSystem, uid: string): string | null {
  const slot = slotOf(sys, uid);
  return slot && processorCount(slot) > 0 ? CLUSTER_CORES_BLOCK_REASON : null;
}

/* ── Queries (HousingRef) ──────────────────────────────────────────────── */
function infoOf(sys: HousingSystem, f: PlacedFurniture): ComputeClusterInfo {
  const slot = slotOf(sys, f.uid);
  const processors = processorCells(slot, COMPUTE_CLUSTER_MAX_CORES);
  const cores = processorCount(slot);
  const perf = perfOf(sys, slot);
  const coin = slot?.coinId ? CRYPTO_COIN_MAP.get(slot.coinId) ?? null : null;
  const block = miningBlock(sys, f.uid, slot);
  const cycle = coin && perf > 0 ? clusterCycleMs(coin, perf) : Infinity;
  let progress = 0, remainingS = 0;
  if (slot && activeCoin(sys, slot) && Number.isFinite(cycle)) {
    const p = miningProgressAt(slot.progress, slot.segmentAt, clockOf(sys, f.uid), cycle);
    progress = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
    if (block === null) remainingS = Math.max(0, Math.ceil(((1 - progress) * cycle) / 1000));
  }
  return {
    uid: f.uid, room: f.room, coinId: coin?.id ?? null, cores, maxCores: COMPUTE_CLUSTER_MAX_CORES,
    processors, processorMax: processorDurMax(sys), perf,
    // `power` stays because it is a required contract field with no reader left — always 0 since power allocation was dropped on 2026-09-13
    cycleMs: Number.isFinite(cycle) ? cycle : 0, progress, remainingS, mining: block === null, block, power: 0,
  };
}

const uidIndex = (uid: string): number => { const m = /^f-(\d+)$/.exec(uid); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };

export function getComputeClusters(sys: HousingSystem): ComputeClusterInfo[] {
  return sys.state.furniture
    .filter((f) => f.defId === COMPUTE_CLUSTER_DEF_ID)
    .sort((a, b) => a.room - b.room || uidIndex(a.uid) - uidIndex(b.uid))
    .map((f) => infoOf(sys, f));
}

export function getComputeCluster(sys: HousingSystem, uid: string): ComputeClusterInfo | null {
  const f = clusterOf(sys, uid);
  return f ? infoOf(sys, f) : null;
}

export function getCryptoWallet(sys: HousingSystem): Readonly<Record<string, number>> {
  return sys.state.cryptoWallet ?? EMPTY_WALLET;
}

/** The server quote (credits per coin), null when not connected to the server or not known yet. */
function priceOf(sys: HousingSystem, coinId: string): number | null {
  const m = sys.ctx.net?.crypto;
  if (!m || m.available !== true) return null;
  const p = m.prices?.[coinId];
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

export function getCryptoCoins(sys: HousingSystem): CryptoCoinInfo[] {
  const m = sys.ctx.net?.crypto;
  const wallet = getCryptoWallet(sys);
  return CRYPTO_COIN_DEFS.map((def) => {
    const lockReason = coinLockReason(sys, def);
    const ch = m && m.available === true ? m.change24h?.[def.id] : undefined;
    return {
      def, unlocked: lockReason === null, lockReason,
      walletUnits: Math.max(0, Math.floor(wallet[def.id] ?? 0)),
      price: priceOf(sys, def.id),
      change24h: typeof ch === 'number' && Number.isFinite(ch) ? ch : null,
    };
  });
}

/* ── Operations (HousingRef) ───────────────────────────────────────────── */
export function setClusterCoin(sys: HousingSystem, uid: string, coinId: string | null): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  if (coinId === null) {
    const slot = slotOf(sys, uid);
    if (!slot?.coinId) return null;
    settle(sys, slot);                                  // the old coin's completed cycles are still put in
    delete slot.coinId;
    slot.progress = 0;
    slot.segmentAt = clockOf(sys, uid);
    pruneSlot(sys, slot);
    return commit(sys, uid, 'clusterCoin');
  }
  const coin = CRYPTO_COIN_MAP.get(coinId);
  if (!coin) return '알 수 없는 코인입니다';
  const lock = coinLockReason(sys, coin);
  if (lock) return lock;
  const slot = ensureSlot(sys, uid);
  if (slot.coinId === coin.id) return null;
  settle(sys, slot);
  slot.coinId = coin.id;
  slot.progress = 0;                                    // changing coin resets progress to 0 (the user's decision default)
  slot.segmentAt = clockOf(sys, uid);
  return commit(sys, uid, 'clusterCoin');
}

/**
 * Mounts one processor into **cell `cell`** (`insertClusterCores`, which names no cell, comes down this path too).
 * With `itemUid` it uses **that exact instance** in the bag · the stash (the dropped tile), without it the highest durability one.
 * The taken instance's **durability is written into the cell as-is** — a worn processor works worn.
 */
function mountOne(sys: HousingSystem, uid: string, cell: number, itemUid?: string): string | null {
  const slot = ensureSlot(sys, uid);
  const cells = cellsOf(slot);
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells.length) return '없는 프로세서 칸입니다';
  if (cells[cell] !== null) return '이미 프로세서가 꽂힌 칸입니다';
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.takeItem !== 'function') return '프로세서를 꺼낼 수 없습니다';
  const name = sys.nameOf(PROCESSOR_DEF_ID);
  const max = processorDurMax(sys);
  let inst: ItemInstance | null = null;
  if (itemUid) {
    const found = typeof inv.findItemAnywhere === 'function' ? inv.findItemAnywhere(itemUid) : null;
    if (!found || found.defId !== PROCESSOR_DEF_ID) return `${name}이(가) 아닙니다`;
    inst = found;
  } else {
    inst = ownedProcessors(sys)[0] ?? null;
  }
  if (!inst) return `${name}이(가) 없습니다`;
  const durability = typeof inst.durability === 'number' && Number.isFinite(inst.durability) ? Math.max(0, inst.durability) : max;
  if (inv.takeItem(inst.uid, 1) < 1) return `${name}을(를) 꺼낼 수 없습니다`;
  settleAndFold(sys, slot);                             // folded at the old perf's cycle — nothing is lost
  cellsOf(slot)[cell] = durability;
  return null;
}

/** The index of the first empty cell, −1 when full. */
function firstFreeCell(slot: ComputeClusterSlot | null): number {
  const cells = processorCells(slot, COMPUTE_CLUSTER_MAX_CORES);
  return cells.indexOf(null);
}

export function insertClusterProcessor(sys: HousingSystem, uid: string, cell: number, itemUid?: string): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const reason = mountOne(sys, uid, cell, itemUid);
  if (reason) { pruneSlot(sys, ensureSlot(sys, uid)); return reason; }
  return commit(sys, uid, 'clusterCores');
}

/** Mounts `qty` of them without naming a cell, **from the first empty cell on** — the reason when none went in, success when even one did. */
export function insertClusterCores(sys: HousingSystem, uid: string, qty: number): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const want = Math.floor(Number(qty));
  if (!(want >= 1)) return '꽂을 프로세서 수가 올바르지 않습니다';
  if (firstFreeCell(slotOf(sys, uid)) < 0) return '프로세서 칸이 가득 찼습니다';
  let done = 0;
  let last: string | null = null;
  for (let k = 0; k < want; k++) {
    const cell = firstFreeCell(slotOf(sys, uid));
    if (cell < 0) break;
    last = mountOne(sys, uid, cell, undefined);
    if (last) break;
    done++;
  }
  if (done < 1) { pruneSlot(sys, ensureSlot(sys, uid)); return last ?? '프로세서를 꽂을 수 없습니다'; }
  return commit(sys, uid, 'clusterCores');
}

/** Pulls the processor in cell `cell` **with its durability** and returns it to `dest`. With no room the cell is left alone. */
export function removeClusterProcessor(sys: HousingSystem, uid: string, cell: number, dest: HarvestDestination = 'bag-first'): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const slot = slotOf(sys, uid);
  if (!slot) return '꽂힌 프로세서가 없습니다';
  const cells = cellsOf(slot);
  if (!Number.isInteger(cell) || cell < 0 || cell >= cells.length) return '없는 프로세서 칸입니다';
  const durability = cells[cell];
  if (durability === null) return '꽂힌 프로세서가 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '프로세서를 만들 수 없습니다';
  // durability is carried when the instance is created (`ItemInstanceExtras`) — it has to come out worn for the workbench to have something to repair
  if (!deliverItem(sys, loot.createItem(PROCESSOR_DEF_ID, 1, { durability }), dest)) return noRoomReason(dest);
  settleAndFold(sys, slot);
  cellsOf(slot)[cell] = null;
  pruneSlot(sys, slot);
  return commit(sys, uid, 'clusterCores');
}

/** Pulls `qty` of them without naming a cell, **from the last cell back** (processors differ from each other, so nothing is shifted up from the front). */
export function removeClusterCores(sys: HousingSystem, uid: string, qty: number, dest: HarvestDestination = 'bag-first'): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const slot = slotOf(sys, uid);
  if (!slot || processorCount(slot) < 1) return '꽂힌 프로세서가 없습니다';
  const want = Math.floor(Number(qty));
  if (!(want >= 1)) return '뺄 프로세서 수가 올바르지 않습니다';
  let done = 0;
  let last: string | null = null;
  for (let k = 0; k < want; k++) {
    const cells = processorCells(slotOf(sys, uid), COMPUTE_CLUSTER_MAX_CORES);
    let cell = -1;
    for (let i = cells.length - 1; i >= 0; i--) if (cells[i] !== null) { cell = i; break; }
    if (cell < 0) break;
    last = removeClusterProcessor(sys, uid, cell, dest);
    if (last) break;
    done++;
  }
  return done > 0 ? null : last ?? '꽂힌 프로세서가 없습니다';
}

/* ── Exchange ──────────────────────────────────────────────────────────── */
export function cryptoQuote(sys: HousingSystem, coinId: string, side: CryptoTradeSide, units: number): CryptoQuote | null {
  const coin = CRYPTO_COIN_MAP.get(coinId);
  if (!coin) return null;
  const u = Number.isFinite(units) ? Math.floor(units) : 0;
  const price = priceOf(sys, coin.id);
  const credits = price !== null && u > 0 && (side === 'buy' || side === 'sell') ? cryptoCreditsFor(side, price, u) : 0;
  return { coinId: coin.id, side, units: u, price: price ?? 0, credits, block: quoteBlock(sys, coin, side, u, price, credits) };
}

function quoteBlock(sys: HousingSystem, coin: CryptoCoinDef, side: CryptoTradeSide, units: number, price: number | null, credits: number): string | null {
  if (side !== 'buy' && side !== 'sell') return '잘못된 거래입니다';
  if (price === null) return '서버에 연결되어야 합니다';
  const lock = coinLockReason(sys, coin);
  if (lock) return lock;
  if (units < 1) return '거래할 수량을 정하세요';
  if (units > CRYPTO_TRADE_MAX_UNITS) return `한 번에 ${formatCoinUnits(CRYPTO_TRADE_MAX_UNITS)}개까지 거래할 수 있습니다`;
  const meta = sys.ctx.meta;
  if (!meta || typeof meta.creditsTx !== 'function') return '크레딧 거래를 할 수 없습니다';
  if (side === 'sell') {
    if (Math.floor(getCryptoWallet(sys)[coin.id] ?? 0) < units) return '지갑 잔고가 부족합니다';
    if (credits < 1) return '거래 금액이 너무 작습니다';
  } else if (credits > meta.credits) {
    return '크레딧이 부족합니다';
  }
  return null;
}

export async function tradeCrypto(sys: HousingSystem, coinId: string, side: CryptoTradeSide, units: number): Promise<string | null> {
  const q = cryptoQuote(sys, coinId, side, units);
  if (!q) return '알 수 없는 코인입니다';
  if (q.block) return q.block;
  const meta = sys.ctx.meta!;
  const reason = formatCreditReason({ kind: side === 'buy' ? 'crypto-buy' : 'crypto-sell', id: q.coinId, qty: q.units });
  const tx = async (delta: number): Promise<{ ok: boolean; reason?: string }> => {
    try { return await meta.creditsTx!(delta, reason); } catch { return { ok: false, reason: '서버 응답이 없습니다' }; }
  };
  if (side === 'sell') {
    addWallet(sys, q.coinId, -q.units, 'sell');         // taken off first — so the same units cannot be sold twice
    sys.changed('cryptoSell');
    const res = await tx(q.credits);
    if (!res.ok) {
      addWallet(sys, q.coinId, q.units, 'sell');
      sys.changed('cryptoSellRefused');
      return res.reason || '서버가 거래를 거절했습니다';
    }
    return null;
  }
  const res = await tx(-q.credits);
  if (!res.ok) return res.reason || '서버가 거래를 거절했습니다';
  addWallet(sys, q.coinId, q.units, 'buy');
  sys.changed('cryptoBuy');
  return null;
}

/* ── Dev (the `crypto` console) ────────────────────────────────────────── */
export function devSetCryptoWallet(sys: HousingSystem, coinId: string, units: number): string | null {
  if (!CRYPTO_COIN_MAP.has(coinId)) return `알 수 없는 코인입니다: ${coinId}`;
  const target = Math.max(0, Math.floor(Number(units)));
  if (!Number.isFinite(target)) return '단위 수가 올바르지 않습니다';
  addWallet(sys, coinId, target - Math.floor(getCryptoWallet(sys)[coinId] ?? 0), 'cheat');
  sys.changed('cryptoCheat');
  return null;
}

/** Fills `cores` **new processors** from the front cell on, with no item (lowering it clears from the last cell back — a cheat, so nothing is returned). */
export function devSetClusterCores(sys: HousingSystem, uid: string, cores: number): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const n = Math.floor(Number(cores));
  if (!Number.isFinite(n)) return '프로세서 수가 올바르지 않습니다';
  const slot = ensureSlot(sys, uid);
  settleAndFold(sys, slot);
  const want = Math.max(0, Math.min(COMPUTE_CLUSTER_MAX_CORES, n));
  const fresh = processorDurMax(sys);
  const cells = cellsOf(slot);
  for (let i = 0; i < cells.length; i++) cells[i] = i < want ? fresh : null;
  pruneSlot(sys, slot);
  return commit(sys, uid, 'clusterCheat');
}

/** Brings the segment of every cluster that can mine (an unlocked coin + cores) forward by `hours` and puts the completed cycles in. The total units put in. */
export function devAdvanceMining(sys: HousingSystem, hours: number): number {
  const ms = Number(hours) * 3_600_000;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  let total = 0, any = false;
  for (const slot of sys.state.clusters ?? []) {
    if (!clusterOf(sys, slot.uid) || !activeCoin(sys, slot)) continue;
    slot.segmentAt -= ms;
    any = true;
    total += settle(sys, slot).units;
    sys.ctx.bus.emit('housing:clusterChanged', { uid: slot.uid });
  }
  if (any) sys.changed('miningCheat');
  return total;
}
