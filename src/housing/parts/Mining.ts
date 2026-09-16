/**
 * src/housing/parts/Mining.ts — **암호화폐 채굴 · 지갑 · 거래소** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, 사용자 결정).
 *
 * 연산 클러스터(`furn_compute_cluster`) 한 대가 시계 하나다 — 꽂힌 것마다 따로 흐르지 않는다. 주기는 `clusterCycleMs(coin, 성능 합)`,
 * 한 주기가 끝날 때마다 `yieldUnits` 가 지갑(`ShipState.cryptoWallet`)에 저절로 들어가고 다음 주기가 이어진다. 오프라인 · 레이드 중의
 * 시간은 함선에서 틱이 돌 때 한 번에 따라잡는다 (클러스터마다 `housing:cryptoMined` 한 번).
 *
 * **2026-09-16 (사용자 결정 — 연산 코어 폐지)**: 클러스터에 꽂는 것은 **프로세서**(`PROCESSOR_DEF_ID`)이고 내구도가 있다.
 * 칸은 개수가 아니라 **칸마다의 남은 내구도**(`ComputeClusterSlot.processors`)이고 인덱스가 곧 화면 격자의 칸이다.
 *  - **속도**는 개수가 아니라 성능 합(`clusterPerf`)이다 — 다 닳은 프로세서는 새것 반 개 몫(`PROCESSOR_PERF_MIN`).
 *  - **마모**는 주기가 끝나는 그 자리에서 꽂힌 **전부**에게 `PROCESSOR_WEAR_PER_CYCLE × 끝난 주기 수` 만큼 붙는다.
 *    0 이 되어도 빠지지 않고 절반 성능으로 계속 돈다 — 최고 성능을 내려면 빼서 함선 작업대에서 수리한다.
 *  - 빼면 **그 칸의 내구도를 그대로 들고** 가방 · 창고로 돌아간다 (`loot.createItem(…, { durability })`).
 *
 * 시계 규약:
 *  - 「지금」 = `sys.nowMs()`. 2026-09-13 같은 날 전력 할당이 폐지되어 멈춘 시계(`stationNow` · `housing:operationalChanged`)는 없다.
 *  - 꽂힌 것이 바뀌면 끝난 주기를 먼저 넣고 옛 주기 길이로 진행도를 접는다(손해 없음). 코인을 바꾸면 진행도 0.
 *  - **메인 컴퓨터가 함선에 없는 동안은 흐르지 않는다** (사용자 결정 「메인 컴퓨터 필수」) — 막힌 동안은 구간을 새로 연다.
 *
 * 매매는 서버 시세로만 한다 — 크레딧은 `ctx.meta.creditsTx` 가 릴레이 검증(`cbuy` · `csell`)까지 기다리고, 지갑은 **성공했을 때만** 늘어난다
 * (팔 때는 먼저 떼어 두고 거절이면 되돌린다 — 같은 단위를 두 번 파는 길을 막는다).
 */
import type {
  ComputeClusterInfo, ComputeClusterSlot, CryptoCoinDef, CryptoCoinInfo, CryptoQuote, CryptoTradeSide, HarvestDestination, HousingRef,
  PlacedFurniture,
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

/* ── 런타임 (저장하지 않는다) ─────────────────────────────────────────────── */
interface MiningRuntime {
  /** 마지막 틱의 `performance.now()`. */
  lastTick: number;
  /** 이벤트 처리 중에 칸을 고쳐 다음 틱에 저장해야 한다 (이벤트 안에서 `changed()` 를 부르지 않기 위해). */
  dirty: boolean;
}
const RUNTIME = new WeakMap<HousingSystem, MiningRuntime>();
function runtime(sys: HousingSystem): MiningRuntime {
  let r = RUNTIME.get(sys);
  if (!r) { r = { lastTick: -Infinity, dirty: false }; RUNTIME.set(sys, r); }
  return r;
}

const EMPTY_WALLET: Readonly<Record<string, number>> = Object.freeze({});

/* ── 상태 접근 ─────────────────────────────────────────────────────────────── */
export function clusterSlots(sys: HousingSystem): ComputeClusterSlot[] { return (sys.state.clusters ??= []); }
function walletMap(sys: HousingSystem): Record<string, number> { return (sys.state.cryptoWallet ??= {}); }
function minedMap(sys: HousingSystem): Record<string, number> { return (sys.state.cryptoMined ??= {}); }

/** `uid` 가 배치된 연산 클러스터면 그 가구, 아니면 null. */
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

/** 코인도 프로세서도 없는 칸은 세이브에 남기지 않는다. */
function pruneSlot(sys: HousingSystem, slot: ComputeClusterSlot): void {
  if (slotWorthKeeping(slot)) return;
  const list = clusterSlots(sys);
  const i = list.indexOf(slot);
  if (i >= 0) list.splice(i, 1);
}

/** 이 클러스터의 「지금」 (2026-09-13 전력 폐지 뒤로는 멈춘 시계가 없어 서버 시각 그대로다). */
function clockOf(sys: HousingSystem, _uid: string): number {
  return sys.nowMs();
}

/* ── 프로세서 칸 ───────────────────────────────────────────────────────────── */
/**
 * 프로세서의 최대 내구도 (`ItemDef.durabilityMax`). 아이템 표를 아직 못 읽으면 0 — 그때 `processorPerf` 는 전부 새것으로 본다
 * (housing 은 inventory · items 보다 **먼저** 등록되므로 생성자 시점에는 정말로 0 이다).
 */
function processorDurMax(sys: HousingSystem): number {
  const v = sys.defOf(PROCESSOR_DEF_ID)?.durabilityMax;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 이 클러스터의 성능 합 — 주기는 개수가 아니라 이 값에서 난다. */
function perfOf(sys: HousingSystem, slot: ComputeClusterSlot | null): number {
  return clusterPerf(slot, processorDurMax(sys));
}

/** 가방 + 함선 창고의 프로세서 인스턴스, **내구도가 높은 것부터** (개수를 지정한 꽂기가 좋은 것을 먼저 쓴다). */
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

/** 칸 목록을 `COMPUTE_CLUSTER_MAX_CORES` 길이로 맞춰 칸에 다시 적는다 (저장 · 화면 격자와 길이를 맞춘다). */
function cellsOf(slot: ComputeClusterSlot): (number | null)[] {
  slot.processors = processorCells(slot, COMPUTE_CLUSTER_MAX_CORES);
  return slot.processors;
}

/* ── 잠금 · 가동 ───────────────────────────────────────────────────────────── */
/** 코인이 잠긴 이유 (`<기업> 퀘스트 「…」 완료 필요`), 열렸으면 null. meta 가 없으면 잠긴 것으로 본다. */
export function coinLockReason(sys: HousingSystem, def: CryptoCoinDef): string | null {
  if (!def.unlockQuest) return null;
  let state: string | undefined;
  try { state = sys.ctx.meta?.getQuestState(def.unlockQuest); } catch { state = undefined; }
  if (state === 'complete') return null;
  // 2026-09-14: 기업 퀘스트 폐지 — 해금 퀘스트는 기업 임원 NPC 의 퀘스트다 (`shared/npc.ts`)
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
 * 연산 클러스터가 채굴하지 못하는 가구 쪽 사유 — 함선에 메인 컴퓨터가 없다 (사용자 결정 「메인 컴퓨터 필수」). 클러스터가 아니면 null.
 * `HousingSystem.furnitureOperationalBlock` 이 이것을 그대로 돌려준다 (2026-09-13 전력 폐지 뒤 남은 유일한 「가동」 조건).
 */
export function clusterOperationalBlock(sys: HousingSystem, uid: string): string | null {
  if (!clusterOf(sys, uid)) return null;
  return getMiningComputerUid(sys) ? null : MINING_COMPUTER_REQUIRED_REASON_KO;
}

function operationalBlock(sys: HousingSystem, uid: string): string | null {
  return clusterOperationalBlock(sys, uid);
}

/** 채굴 칸이 주기를 가질 수 있는가 (알려진 · 열린 코인 + 프로세서 1개 이상) — 그 코인, 아니면 null. */
function activeCoin(sys: HousingSystem, slot: ComputeClusterSlot | null): CryptoCoinDef | null {
  if (!slot || processorCount(slot) < 1 || !slot.coinId) return null;
  const coin = CRYPTO_COIN_MAP.get(slot.coinId);
  return coin && !coinLockReason(sys, coin) ? coin : null;
}

/** 시계가 흐르지 않는 한국어 사유 (코인 미지정 · 잠긴 코인 · 프로세서 없음 · 메인 컴퓨터), 흐르면 null. */
function miningBlock(sys: HousingSystem, uid: string, slot: ComputeClusterSlot | null): string | null {
  const coin = slot?.coinId ? CRYPTO_COIN_MAP.get(slot.coinId) : undefined;
  if (!coin) return '채굴할 코인을 정하세요';
  const lock = coinLockReason(sys, coin);
  if (lock) return lock;
  if (!slot || processorCount(slot) < 1) return '프로세서를 꽂으세요';
  return operationalBlock(sys, uid);
}

/* ── 지갑 ─────────────────────────────────────────────────────────────────── */
function addWallet(sys: HousingSystem, coinId: string, delta: number, reason: 'mined' | 'buy' | 'sell' | 'cheat'): void {
  const w = walletMap(sys);
  const before = Math.max(0, Math.floor(w[coinId] ?? 0));
  const after = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(before + delta)));
  if (after > 0) w[coinId] = after; else delete w[coinId];
  if (after !== before) sys.ctx.bus.emit('housing:walletChanged', { coinId, units: after, delta: after - before, reason });
}

/* ── 주기 떼어 내기 · 접기 ─────────────────────────────────────────────────── */
/**
 * 끝난 주기를 지갑에 넣는다. 메인 컴퓨터가 없어 막혀 있으면 넣지 않고 구간만 새로 연다 (막힌 동안은 흐르지 않는다).
 * 넣은 단위 수(칸을 고쳤으면 −1 도 참).
 */
function settle(sys: HousingSystem, slot: ComputeClusterSlot): { units: number; touched: boolean } {
  const coin = activeCoin(sys, slot);
  if (!coin) return { units: 0, touched: false };
  const now = clockOf(sys, slot.uid);
  if (operationalBlock(sys, slot.uid)) {
    foldProgress(slot, Infinity, now);                  // 시간 장부만 — 매 틱 저장하지 않는다 (다음 실제 변경이 싣는다)
    return { units: 0, touched: false };
  }
  const cycles = takeCompletedCycles(slot, clusterCycleMs(coin, perfOf(sys, slot)), now);
  if (cycles < 1) return { units: 0, touched: false };
  // 2026-09-16 (사용자 결정): 주기가 끝나면 그 자리에서 꽂힌 프로세서가 전부 닳는다 — 다음 주기는 그만큼 느려진다 (0 에서 멈추고 절반 성능)
  wearProcessors(slot, cycles);
  const units = Math.min(Number.MAX_SAFE_INTEGER, cycles * coin.yieldUnits);
  const mined = minedMap(sys);
  mined[coin.id] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((mined[coin.id] ?? 0) + units));
  addWallet(sys, coin.id, units, 'mined');
  sys.ctx.bus.emit('housing:cryptoMined', { uid: slot.uid, coinId: coin.id, units });
  return { units, touched: true };
}

/** 끝난 주기를 넣고 지금 설정(꽂힌 프로세서 · 코인)의 주기로 진행도를 접는다 — 설정을 바꾸기 **직전**에 부른다. */
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

/* ── 틱 · 구독 ────────────────────────────────────────────────────────────── */
/** `HousingSystem.update` 가 매 프레임 부른다 — 1초에 한 번 끝난 주기를 넣는다. 레이드 중에는 넣지 않는다 (함선에 돌아와 따라잡는다). */
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

/** 구독 — 회수된 클러스터의 칸 지우기. `HousingSystem.init` 이 unsubs 에 넣는다. */
export function bindMining(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  return [
    b.on('housing:furnitureRecovered', ({ uid, defId }) => {
      if (defId !== COMPUTE_CLUSTER_DEF_ID) return;
      const slot = slotOf(sys, uid);
      if (!slot) return;
      clusterSlots(sys).splice(clusterSlots(sys).indexOf(slot), 1);   // 프로세서는 회수 전에 이미 빠졌다 (`clusterRecoverBlock`)
    }),
  ];
}

/** 프로세서가 꽂힌 클러스터는 회수할 수 없다 (내구도를 잃지 않게 — 사람이 먼저 뺀다). 클러스터가 아니거나 비었으면 null. */
export function clusterRecoverBlock(sys: HousingSystem, uid: string): string | null {
  const slot = slotOf(sys, uid);
  return slot && processorCount(slot) > 0 ? CLUSTER_CORES_BLOCK_REASON : null;
}

/* ── 조회 (HousingRef) ─────────────────────────────────────────────────────── */
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
    // `power` 는 계약 필드라 남는다 — 2026-09-13 전력 할당 폐지로 늘 0
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

/** 서버 시세 (코인 1개당 크레딧), 서버에 붙어 있지 않거나 아직 모르면 null. */
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

/* ── 조작 (HousingRef) ─────────────────────────────────────────────────────── */
export function setClusterCoin(sys: HousingSystem, uid: string, coinId: string | null): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  if (coinId === null) {
    const slot = slotOf(sys, uid);
    if (!slot?.coinId) return null;
    settle(sys, slot);                                  // 옛 코인의 끝난 주기는 넣어 준다
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
  slot.progress = 0;                                    // 코인을 바꾸면 진행도 0 (사용자 결정 기본값)
  slot.segmentAt = clockOf(sys, uid);
  return commit(sys, uid, 'clusterCoin');
}

/**
 * 프로세서 하나를 **`cell` 칸**에 꽂는다 (칸을 정하지 않는 `insertClusterCores` 도 이 길로 온다).
 * `itemUid` 를 주면 가방 · 창고의 **바로 그 인스턴스**(끌어다 놓은 타일)를 쓰고, 없으면 내구도가 가장 높은 것을 쓴다.
 * 꺼낸 인스턴스의 **내구도를 그대로** 칸에 적는다 — 닳은 프로세서는 닳은 채로 일한다.
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
  settleAndFold(sys, slot);                             // 옛 성능의 주기로 접는다 — 손해 없음
  cellsOf(slot)[cell] = durability;
  return null;
}

/** 첫 빈 칸의 번호, 가득 찼으면 −1. */
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

/** 칸을 정하지 않고 `qty` 개를 **빈 칸 앞에서부터** 꽂는다 — 하나도 못 꽂으면 그 사유, 하나라도 꽂으면 성공이다. */
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

/** `cell` 칸의 프로세서를 **내구도 그대로** 빼서 `dest` 로 돌려준다. 자리가 없으면 칸은 그대로다. */
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
  // 내구도는 인스턴스를 만들 때 실어 준다 (`ItemInstanceExtras`) — 닳은 채로 나와야 작업대에서 고칠 것이 남는다
  if (!deliverItem(sys, loot.createItem(PROCESSOR_DEF_ID, 1, { durability }), dest)) return noRoomReason(dest);
  settleAndFold(sys, slot);
  cellsOf(slot)[cell] = null;
  pruneSlot(sys, slot);
  return commit(sys, uid, 'clusterCores');
}

/** 칸을 정하지 않고 `qty` 개를 **뒤 칸부터** 뺀다 (프로세서는 서로 달라 앞에서부터 밀지 않는다). */
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

/* ── 거래소 ───────────────────────────────────────────────────────────────── */
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
    addWallet(sys, q.coinId, -q.units, 'sell');         // 먼저 떼어 둔다 — 같은 단위를 두 번 팔지 못하게
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

/* ── 개발용 (콘솔 `crypto`) ───────────────────────────────────────────────── */
export function devSetCryptoWallet(sys: HousingSystem, coinId: string, units: number): string | null {
  if (!CRYPTO_COIN_MAP.has(coinId)) return `알 수 없는 코인입니다: ${coinId}`;
  const target = Math.max(0, Math.floor(Number(units)));
  if (!Number.isFinite(target)) return '단위 수가 올바르지 않습니다';
  addWallet(sys, coinId, target - Math.floor(getCryptoWallet(sys)[coinId] ?? 0), 'cheat');
  sys.changed('cryptoCheat');
  return null;
}

/** 아이템 없이 **새 프로세서** `cores` 개를 앞 칸부터 채운다 (줄이면 뒤 칸부터 사라진다 — 치트라 돌려주지 않는다). */
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

/** 채굴할 수 있는 모든 클러스터(열린 코인 + 코어)의 구간을 `hours` 만큼 앞당기고 끝난 주기를 넣는다. 넣은 단위 합. */
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
