/**
 * src/housing/parts/Mining.ts — **암호화폐 채굴 · 지갑 · 거래소** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, 사용자 결정).
 *
 * 연산 클러스터(`furn_compute_cluster`) 한 대가 시계 하나다 — 코어마다 따로 흐르지 않는다. 주기 = `coinCycleMs(coin, cores)`,
 * 한 주기가 끝날 때마다 `yieldUnits` 가 지갑(`ShipState.cryptoWallet`)에 저절로 들어가고 다음 주기가 이어진다. 오프라인 · 레이드 중의
 * 시간은 함선에서 틱이 돌 때 한 번에 따라잡는다 (클러스터마다 `housing:cryptoMined` 한 번).
 *
 * 시계 규약:
 *  - 「지금」 = `sys.nowMs()`. 2026-09-13 같은 날 전력 할당이 폐지되어 멈춘 시계(`stationNow` · `housing:operationalChanged`)는 없다.
 *  - 코어 수가 바뀌면 끝난 주기를 먼저 넣고 옛 주기 길이로 진행도를 접는다(손해 없음). 코인을 바꾸면 진행도 0.
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
  COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, COMPUTE_CORE_DEF_ID, CORP_DEFS, CRYPTO_COIN_DEFS,
  CRYPTO_COIN_MAP, CRYPTO_TRADE_MAX_UNITS, MINING_COMPUTER_DEF_ID, MINING_COMPUTER_REQUIRED_REASON_KO, NPC_DEF_MAP, NPC_QUEST_MAP, coinCycleMs, cryptoCreditsFor,
  formatCoinUnits, formatCreditReason, miningProgressAt,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { CLUSTER_CORES_BLOCK_REASON, MINING_TICK_MS, foldProgress, slotWorthKeeping, takeCompletedCycles } from '../MiningRules';
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
  if (!s) { s = { uid, cores: 0, progress: 0, segmentAt: clockOf(sys, uid) }; clusterSlots(sys).push(s); }
  return s;
}

/** 코인도 코어도 없는 칸은 세이브에 남기지 않는다. */
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

/** 채굴 칸이 주기를 가질 수 있는가 (알려진 · 열린 코인 + 코어 1개 이상) — 그 코인, 아니면 null. */
function activeCoin(sys: HousingSystem, slot: ComputeClusterSlot | null): CryptoCoinDef | null {
  if (!slot || slot.cores < 1 || !slot.coinId) return null;
  const coin = CRYPTO_COIN_MAP.get(slot.coinId);
  return coin && !coinLockReason(sys, coin) ? coin : null;
}

/** 시계가 흐르지 않는 한국어 사유 (코인 미지정 · 잠긴 코인 · 코어 없음 · 전력 · 비활성 · 메인 컴퓨터), 흐르면 null. */
function miningBlock(sys: HousingSystem, uid: string, slot: ComputeClusterSlot | null): string | null {
  const coin = slot?.coinId ? CRYPTO_COIN_MAP.get(slot.coinId) : undefined;
  if (!coin) return '채굴할 코인을 정하세요';
  const lock = coinLockReason(sys, coin);
  if (lock) return lock;
  if (!slot || slot.cores < 1) return '연산 코어를 꽂으세요';
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
  const cycles = takeCompletedCycles(slot, coinCycleMs(coin, slot.cores), now);
  if (cycles < 1) return { units: 0, touched: false };
  const units = Math.min(Number.MAX_SAFE_INTEGER, cycles * coin.yieldUnits);
  const mined = minedMap(sys);
  mined[coin.id] = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((mined[coin.id] ?? 0) + units));
  addWallet(sys, coin.id, units, 'mined');
  sys.ctx.bus.emit('housing:cryptoMined', { uid: slot.uid, coinId: coin.id, units });
  return { units, touched: true };
}

/** 끝난 주기를 넣고 지금 설정(코어 수 · 코인)의 주기로 진행도를 접는다 — 설정을 바꾸기 **직전**에 부른다. */
function settleAndFold(sys: HousingSystem, slot: ComputeClusterSlot): void {
  settle(sys, slot);
  const coin = activeCoin(sys, slot);
  const now = clockOf(sys, slot.uid);
  const blocked = !!operationalBlock(sys, slot.uid);
  foldProgress(slot, coin && !blocked ? coinCycleMs(coin, slot.cores) : Infinity, now);
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
      clusterSlots(sys).splice(clusterSlots(sys).indexOf(slot), 1);   // 코어는 회수 전에 이미 빠졌다 (`clusterRecoverBlock`)
    }),
  ];
}

/** 코어가 꽂힌 클러스터는 회수할 수 없다 (`코어를 먼저 빼세요`). 클러스터가 아니거나 비었으면 null. */
export function clusterRecoverBlock(sys: HousingSystem, uid: string): string | null {
  const slot = slotOf(sys, uid);
  return slot && slot.cores > 0 ? CLUSTER_CORES_BLOCK_REASON : null;
}

/* ── 조회 (HousingRef) ─────────────────────────────────────────────────────── */
function infoOf(sys: HousingSystem, f: PlacedFurniture): ComputeClusterInfo {
  const slot = slotOf(sys, f.uid);
  const cores = slot?.cores ?? 0;
  const coin = slot?.coinId ? CRYPTO_COIN_MAP.get(slot.coinId) ?? null : null;
  const block = miningBlock(sys, f.uid, slot);
  const cycle = coin && cores >= 1 ? coinCycleMs(coin, cores) : Infinity;
  let progress = 0, remainingS = 0;
  if (slot && activeCoin(sys, slot) && Number.isFinite(cycle)) {
    const p = miningProgressAt(slot.progress, slot.segmentAt, clockOf(sys, f.uid), cycle);
    progress = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
    if (block === null) remainingS = Math.max(0, Math.ceil(((1 - progress) * cycle) / 1000));
  }
  return {
    uid: f.uid, room: f.room, coinId: coin?.id ?? null, cores, maxCores: COMPUTE_CLUSTER_MAX_CORES,
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

export function insertClusterCores(sys: HousingSystem, uid: string, qty: number): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const want = Math.floor(Number(qty));
  if (!(want >= 1)) return '꽂을 코어 수가 올바르지 않습니다';
  const cur = slotOf(sys, uid)?.cores ?? 0;
  const free = COMPUTE_CLUSTER_MAX_CORES - cur;
  if (free <= 0) return '코어 칸이 가득 찼습니다';
  const have = sys.countDef(COMPUTE_CORE_DEF_ID);
  if (have < 1) return `${sys.nameOf(COMPUTE_CORE_DEF_ID)}이(가) 없습니다`;
  const n = Math.min(want, free, have);
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(COMPUTE_CORE_DEF_ID, n)) return '연산 코어를 꺼낼 수 없습니다';
  const slot = ensureSlot(sys, uid);
  settleAndFold(sys, slot);                             // 옛 코어 수의 주기로 접는다 — 손해 없음
  slot.cores = Math.min(COMPUTE_CLUSTER_MAX_CORES, slot.cores + n);
  return commit(sys, uid, 'clusterCores');
}

export function removeClusterCores(sys: HousingSystem, uid: string, qty: number, dest: HarvestDestination = 'bag-first'): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const slot = slotOf(sys, uid);
  const cur = slot?.cores ?? 0;
  if (!slot || cur < 1) return '꽂힌 코어가 없습니다';
  const want = Math.floor(Number(qty));
  if (!(want >= 1)) return '뺄 코어 수가 올바르지 않습니다';
  const n = Math.min(want, cur);
  const loot = sys.ctx.loot, inv = sys.ctx.inventory;
  if (!loot || typeof loot.createItem !== 'function' || !inv) return '연산 코어를 만들 수 없습니다';
  const stack = Math.max(1, Math.floor(loot.getItemDef(COMPUTE_CORE_DEF_ID)?.stackMax ?? 1));
  // all-or-nothing: 스택 단위로 건네고, 하나라도 자리가 없으면 건넨 만큼 도로 뺀다 (코어는 서로 같아 개수로 되돌리면 된다)
  let delivered = 0;
  while (delivered < n) {
    const chunk = Math.min(stack, n - delivered);
    if (!deliverItem(sys, loot.createItem(COMPUTE_CORE_DEF_ID, chunk), dest)) {
      if (delivered > 0 && typeof inv.consumeDefAll === 'function') inv.consumeDefAll(COMPUTE_CORE_DEF_ID, delivered);
      return noRoomReason(dest);
    }
    delivered += chunk;
  }
  settleAndFold(sys, slot);
  slot.cores = cur - n;
  pruneSlot(sys, slot);
  return commit(sys, uid, 'clusterCores');
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

export function devSetClusterCores(sys: HousingSystem, uid: string, cores: number): string | null {
  if (!clusterOf(sys, uid)) return '연산 클러스터가 아닙니다';
  const n = Math.floor(Number(cores));
  if (!Number.isFinite(n)) return '코어 수가 올바르지 않습니다';
  const slot = ensureSlot(sys, uid);
  settleAndFold(sys, slot);
  slot.cores = Math.max(0, Math.min(COMPUTE_CLUSTER_MAX_CORES, n));
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
