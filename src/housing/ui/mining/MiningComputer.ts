import type { ComputeClusterInfo, CryptoChartRange, CryptoCoinInfo, CryptoTradeSide, GameContext, MiningComputerTab } from '@/shared';
import {
  COMPUTE_CLUSTER_MAX_CORES, CRYPTO_CHART_RANGES, CRYPTO_CHART_RANGE_LABEL_KO, CRYPTO_QUOTE_WINDOW_S, CRYPTO_TICK_S, CRYPTO_TRADE_FEE, CRYPTO_TRADE_MAX_UNITS,
  MINING_COMPUTER_DEF_ID, coinToUnits, formatCoinUnits,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { HousingPanel } from '../Panel';
import { buildStationShell, paintStationMeta, paintStationPower } from '../StationShell';
import type { StationShell } from '../StationShell';
import { clear, el, isolateInput, renderClock, renderClockText, setText, toggleClass } from '../dom';
import { CryptoChart, withLivePrice } from './CryptoChart';
import type { ChartMode } from './CryptoChart';
import {
  affordableUnits, bindHoldButton, changeTone, clusterList, coinDef, coinGlyph, coinInfos, fmtChange, fmtCredits, fmtPrice,
  livePrice, unitsPerHour, unitsValue, type HoldButton, type MiningHousing,
} from './common';

const TICK_MS = 1000;
const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const OFFLINE = '서버에 연결되어야 합니다';
/**
 * 시세가 이보다 오래되면 매매 확정을 막는다 (ms). 릴레이는 최근 `CRYPTO_QUOTE_WINDOW_S` 창의 시세로만 금액을 맞춰 보므로, 거래 요청이
 * 도착하기 전에 창을 벗어날 시세로는 보내지 않는다 — 창에서 틱 반 개를 뺀 값 (30 s · 10 s → 25 s). 수치의 원본은 `data/tuning.csv`.
 */
const STALE_MS = Math.max(1000, CRYPTO_QUOTE_WINDOW_S * 1000 - (CRYPTO_TICK_S * 1000) / 2);
const STALE = '시세가 오래되었습니다 — 새 시세를 기다리는 중';
const TAB_LABEL: Readonly<Record<MiningComputerTab, string>> = { clusters: '클러스터 현황', wallet: '지갑', exchange: '거래소' };
const TABS: readonly MiningComputerTab[] = ['clusters', 'wallet', 'exchange'];
const QUICK_PCTS = [0.25, 0.5, 1] as const;

interface ClusterRow {
  uid: string;
  row: HTMLElement;
  glyph: HTMLElement;
  coin: HTMLElement;
  cores: HTMLElement;
  pips: HTMLElement[];
  fill: HTMLElement;
  clock: HTMLElement;
  status: HTMLElement;
  power: HTMLElement;
}
interface WalletRow { id: string; row: HTMLElement; units: HTMLElement; value: HTMLElement; change: HTMLElement; mined: HTMLElement; lock: HTMLElement }
interface ListRow { id: string; row: HTMLElement; price: HTMLElement; change: HTMLElement; lock: HTMLElement }

/**
 * **메인 컴퓨터 화면** (2026-09-13, 암호화폐 채굴 — `openMiningComputer(uid | null, tab?)` ← E on a 메인 컴퓨터).
 *
 * `StationShell` 카드 하나(`inventory: false`, 업그레이드 없음 — 메인 컴퓨터는 Lv.1 뿐)에 **레일 탭 셋**:
 *  - **클러스터 현황** — 클러스터마다 한 줄(방 · 코인 글리프 + 티커 · 코어 n/9 · 진행 막대 + `HH:MM:SS` · 채굴 중 / 막는 사유 · 전력),
 *    줄을 누르면 그 클러스터 화면. 머리 = 채굴 중 n / 전체 · 시간당 예상 크레딧 합(시세를 아는 코인만).
 *  - **지갑** — 코인마다 보유(`formatCoinUnits`) · 평가액(시세 없으면 `—`) · 24시간 변동 · 누적 채굴(`ShipState.cryptoMined`), 총 평가액.
 *    줄을 누르면 그 코인의 거래소.
 *  - **거래소** — 코인 목록(시세 · 24시간 변동 색 · 잠김) + 차트(`CryptoChart` — 1시간/1일/1주/1개월 · 봉/선 · 호버 OHLC) + 매매
 *    (매수/매도 · 코인 수량 입력 + 25/50/100 % · `cryptoQuote` 견적(수수료 포함) · 막는 사유 · **1초 홀드 확정** → `tradeCrypto`).
 *    잠긴 코인은 차트만 보이고 매매는 잠김 사유와 함께 막힌다. 서버에 붙어 있지 않으면 차트 자리에 「서버에 연결되어야 합니다」.
 *
 * 시세 구독(`ctx.net.crypto.watch()`)은 지갑 · 거래소 탭이 열려 있는 동안만 건다 (탭을 바꾸거나 닫으면 푼다). 봉 이력은 코인 ·
 * 기간을 고를 때마다 `requestHistory` 하고 `net:cryptoHistory` 에서 그린다 — 마지막 봉은 `net:cryptoPrices` 의 지금 시세로 고친다.
 */
export class MiningComputer extends HousingPanel {
  private uid: string | null = null;
  private tab: MiningComputerTab = 'clusters';
  private readonly shell: StationShell;
  private readonly tabBtns: Record<MiningComputerTab, HTMLButtonElement>;
  private readonly banner: HTMLElement;
  private readonly pages: Record<MiningComputerTab, HTMLElement>;
  /* 클러스터 현황 */
  private readonly clSummary: HTMLElement;
  private readonly clList: HTMLElement;
  private clRows: ClusterRow[] = [];
  private clKey = '';
  /* 지갑 */
  private readonly wSummary: HTMLElement;
  private readonly wList: HTMLElement;
  private wRows: WalletRow[] = [];
  /* 거래소 */
  private readonly xList: HTMLElement;
  private xRows: ListRow[] = [];
  private readonly xHeadGlyph: HTMLElement;
  private readonly xHeadName: HTMLElement;
  private readonly xHeadPrice: HTMLElement;
  private readonly xHeadChange: HTMLElement;
  private readonly rangeBtns = new Map<CryptoChartRange, HTMLButtonElement>();
  private readonly modeBtns = new Map<ChartMode, HTMLButtonElement>();
  readonly chart: CryptoChart;
  private readonly trade: HTMLElement;
  private readonly sideBtns = new Map<CryptoTradeSide, HTMLButtonElement>();
  private readonly amount: HTMLInputElement;
  private readonly amountTicker: HTMLElement;
  private readonly have: HTMLElement;
  private readonly quoteRows: { price: HTMLElement; fee: HTMLElement; credits: HTMLElement; creditsK: HTMLElement };
  private readonly blockEl: HTMLElement;
  private readonly holdBtn: HTMLButtonElement;
  private readonly holdLabel: HTMLElement;
  private readonly hold: HoldButton;
  private coin = '';
  private range: CryptoChartRange = '1d';
  private side: CryptoTradeSide = 'buy';
  private pending = false;
  private unwatch: (() => void) | null = null;
  private requested = '';
  private lastAvailable = false;
  private timer = 0;
  /** Smoke / perf counters. */
  readonly debug = { watches: 0, unwatches: 0, requests: 0, trades: 0, paints: 0, chartPaints: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'computer', 'mining-computer hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '메인 컴퓨터',
      upgrade: false,
      inventory: false,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
      power: { ctx, uid: () => this.uid },
    });
    const rail = this.shell.rail;
    rail.hidden = false;
    const tabBtn = (id: MiningComputerTab): HTMLButtonElement => {
      const b = el('button', { cls: 'hs-tab', text: TAB_LABEL[id], attrs: { 'data-tab': id }, parent: rail });
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.tab === id) return;
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.setTab(id);
      });
      return b;
    };
    this.tabBtns = { clusters: tabBtn('clusters'), wallet: tabBtn('wallet'), exchange: tabBtn('exchange') };

    const left = this.shell.left;
    left.classList.add('mn-pc');
    this.banner = el('div', { cls: 'mn-banner', parent: left });
    this.banner.hidden = true;
    this.pages = {
      clusters: el('div', { cls: 'mn-page', attrs: { 'data-page': 'clusters' }, parent: left }),
      wallet: el('div', { cls: 'mn-page', attrs: { 'data-page': 'wallet' }, parent: left }),
      exchange: el('div', { cls: 'mn-page mn-page-x', attrs: { 'data-page': 'exchange' }, parent: left }),
    };

    /* ── 클러스터 현황 ── */
    this.clSummary = el('div', { cls: 'mn-sum', parent: this.pages.clusters });
    this.clList = el('div', { cls: 'mn-crows', parent: this.pages.clusters });
    this.clList.addEventListener('click', (e) => {
      const uid = (e.target as Element | null)?.closest<HTMLElement>('.mn-crow[data-uid]')?.dataset.uid;
      if (!uid) return;
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.housing.openComputeCluster(uid);
    });

    /* ── 지갑 ── */
    this.wSummary = el('div', { cls: 'mn-sum', parent: this.pages.wallet });
    const wHead = el('div', { cls: 'mn-wrow mn-whead', parent: this.pages.wallet });
    for (const t of ['코인', '보유', '평가액', '24시간', '누적 채굴']) el('span', { text: t, parent: wHead });
    this.wList = el('div', { cls: 'mn-wrows', parent: this.pages.wallet });
    this.wList.addEventListener('click', (e) => {
      const id = (e.target as Element | null)?.closest<HTMLElement>('.mn-wrow[data-coin]')?.dataset.coin;
      if (!id) return;
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.selectCoin(id);
      this.setTab('exchange');
    });

    /* ── 거래소 ── */
    const x = this.pages.exchange;
    this.xList = el('div', { cls: 'mn-xlist', parent: x });
    this.xList.addEventListener('click', (e) => {
      const id = (e.target as Element | null)?.closest<HTMLElement>('.mn-xrow[data-coin]')?.dataset.coin;
      if (!id || id === this.coin) return;
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.selectCoin(id);
    });
    const main = el('div', { cls: 'mn-xmain', parent: x });
    const head = el('div', { cls: 'mn-xhead', parent: main });
    const hl = el('div', { cls: 'mn-xhead-l', parent: head });
    this.xHeadGlyph = coinGlyph(hl, null, 'lg');
    const names = el('div', { cls: 'mn-xhead-names', parent: hl });
    this.xHeadName = el('div', { cls: 'mn-xhead-name', text: '', parent: names });
    const priceLine = el('div', { cls: 'mn-xhead-priceline', parent: names });
    this.xHeadPrice = el('span', { cls: 'mn-xhead-price', text: '—', parent: priceLine });
    this.xHeadChange = el('span', { cls: 'mn-chg', text: '', parent: priceLine });
    const hr = el('div', { cls: 'mn-xhead-r', parent: head });
    const ranges = el('div', { cls: 'mn-seg', parent: hr });
    for (const r of CRYPTO_CHART_RANGES) {
      const b = el('button', { cls: 'mn-seg-btn', text: CRYPTO_CHART_RANGE_LABEL_KO[r], attrs: { 'data-range': r }, parent: ranges });
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setRange(r); });
      this.rangeBtns.set(r, b);
    }
    const modes = el('div', { cls: 'mn-seg', parent: hr });
    for (const [m, label] of [['candle', '봉'], ['line', '선']] as const) {
      const b = el('button', { cls: 'mn-seg-btn', text: label, attrs: { 'data-mode': m }, parent: modes });
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setMode(m); });
      this.modeBtns.set(m, b);
    }
    this.chart = new CryptoChart(main);

    this.trade = el('div', { cls: 'mn-trade', parent: main });
    const tHead = el('div', { cls: 'mn-trade-head', parent: this.trade });
    const sides = el('div', { cls: 'mn-seg mn-sides', parent: tHead });
    for (const [s, label] of [['buy', '매수'], ['sell', '매도']] as const) {
      const b = el('button', { cls: `mn-seg-btn mn-side-${s}`, text: label, attrs: { 'data-side': s }, parent: sides });
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setSide(s); });
      this.sideBtns.set(s, b);
    }
    this.have = el('div', { cls: 'mn-have', text: '', parent: tHead });
    const tRow = el('div', { cls: 'mn-trade-row', parent: this.trade });
    const amtWrap = el('label', { cls: 'mn-amt', parent: tRow });
    this.amount = el('input', { cls: 'mn-amt-input', attrs: { type: 'text', inputmode: 'decimal', placeholder: '0.000', autocomplete: 'off', spellcheck: 'false' }, parent: amtWrap });
    this.amountTicker = el('span', { cls: 'mn-amt-ticker', text: '', parent: amtWrap });
    isolateInput(this.amount);
    this.amount.addEventListener('input', () => this.paintTrade());
    const quick = el('div', { cls: 'mn-quick', parent: tRow });
    for (const pct of QUICK_PCTS) {
      const b = el('button', { cls: 'mn-seg-btn', text: `${Math.round(pct * 100)} %`, attrs: { 'data-pct': String(pct) }, parent: quick });
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.quickFill(pct); });
    }
    const quote = el('div', { cls: 'mn-quote', parent: this.trade });
    const qrow = (k: string): { k: HTMLElement; v: HTMLElement } => {
      const r = el('div', { cls: 'mn-quote-row', parent: quote });
      return { k: el('span', { cls: 'k', text: k, parent: r }), v: el('span', { cls: 'v', text: '—', parent: r }) };
    };
    const qPrice = qrow('시세');
    const qFee = qrow('수수료');
    const qCredits = qrow('내는 크레딧');
    this.quoteRows = { price: qPrice.v, fee: qFee.v, credits: qCredits.v, creditsK: qCredits.k };
    this.blockEl = el('div', { cls: 'mn-trade-block', text: '', parent: this.trade });
    this.holdBtn = el('button', { cls: 'ui-btn primary mn-hold', parent: this.trade });
    this.holdBtn.type = 'button';
    const fill = el('i', { cls: 'mn-hold-fill', parent: this.holdBtn });
    this.holdLabel = el('span', { cls: 'mn-hold-label', text: '매수', parent: this.holdBtn });
    this.hold = bindHoldButton(this.holdBtn, fill, () => { void this.runTrade(); }, () => this.showMsg('거래 버튼을 1초간 꾹 누르세요', 'info'));

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '시세 · 차트 · 매매는 서버 시세를 씁니다 — 채굴은 서버 없이도 진행됩니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:clusterChanged', () => this.refreshIfOpen()),
      b.on('housing:cryptoMined', () => this.refreshIfOpen()),
      b.on('housing:walletChanged', () => this.refreshIfOpen()),
      b.on('housing:powerChanged', () => this.refreshIfOpen()),
      b.on('housing:operationalChanged', () => this.refreshIfOpen()),
      b.on('meta:creditsChanged', () => { if (this.isOpen) this.paintTrade(); }),
      b.on('net:cryptoPrices', () => this.refreshIfOpen()),
      b.on('net:cryptoHistory', ({ coin, range }) => { if (this.isOpen && coin === this.coin && range === this.range) this.paintChart(); }),
    );
    this.setTab('clusters');
  }

  private get ref(): MiningHousing { return this.housing; }

  /* ── open / close ──────────────────────────────────────────────────────── */
  openComputer(uid: string, tab?: MiningComputerTab): void {
    const was = this.isOpen;
    this.uid = uid;
    this.openPanel();
    this.setTab(tab ?? this.tab);
    this.startTicking();
    if (!was) this.ctx.bus.emit('ui:miningToggled', { open: true, uid, page: 'computer' });
  }

  get currentTab(): MiningComputerTab { return this.tab; }
  get selectedCoin(): string { return this.coin; }

  override close(relock = true): void {
    const was = this.isOpen;
    this.stopTicking();
    this.hold.cancel();
    super.close(relock);
    this.syncWatch();
    if (was) this.ctx.bus.emit('ui:miningToggled', { open: false, uid: this.uid, page: 'computer' });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.tick(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  private tick(): void {
    this.paintHeader();
    if (this.tab === 'clusters') this.paintClusters();
    else if (this.tab === 'exchange') this.paintTrade();         // 시세가 오래되면 이벤트 없이도 확정 버튼이 잠겨야 한다
  }

  setTab(id: MiningComputerTab): void {
    this.tab = TABS.includes(id) ? id : 'clusters';
    for (const k of TABS) {
      toggleClass(this.tabBtns[k], 'is-active', k === this.tab);
      this.pages[k].hidden = k !== this.tab;
    }
    this.hold.cancel();
    this.syncWatch();
    if (!this.isOpen) return;
    if (this.tab === 'exchange') {
      if (!this.coin) this.selectCoin(this.defaultCoin(), false);
      this.ensureHistory(false);
      this.chart.resize();
    }
    this.refresh();
  }

  /** 시세 구독 — 지갑 · 거래소 탭이 열려 있는 동안만. */
  private syncWatch(): void {
    const want = this.isOpen && (this.tab === 'exchange' || this.tab === 'wallet');
    const market = this.ctx.net?.crypto;
    if (want && !this.unwatch && market && typeof market.watch === 'function') {
      try { this.unwatch = market.watch(); this.debug.watches++; } catch { this.unwatch = null; }
    } else if (!want && this.unwatch) {
      const u = this.unwatch;
      this.unwatch = null;
      try { u(); } catch { /* net gone */ }
      this.debug.unwatches++;
    }
  }

  private defaultCoin(): string {
    const list = coinInfos(this.ref, this.ctx);
    return (list.find((c) => c.unlocked) ?? list[0])?.def.id ?? '';
  }

  /* ── 거래소 조작 ───────────────────────────────────────────────────────── */
  selectCoin(id: string, paint = true): void {
    if (!coinDef(id)) return;
    const changed = id !== this.coin;
    this.coin = id;
    if (changed) {
      this.hold.cancel();
      this.amount.value = '';
      this.requested = '';
    }
    this.ensureHistory(changed);
    if (paint && this.isOpen) this.refresh();
  }

  private setRange(r: CryptoChartRange): void {
    if (r === this.range) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.range = r;
    this.requested = '';
    this.ensureHistory(true);
    this.paintExchange();
  }

  private setMode(m: ChartMode): void {
    if (this.chart.currentMode === m) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.chart.setMode(m);
    for (const [k, b] of this.modeBtns) toggleClass(b, 'is-active', k === m);
  }

  private setSide(s: CryptoTradeSide): void {
    if (s === this.side) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.side = s;
    this.hold.cancel();
    this.paintTrade();
  }

  /** 봉 이력 요청 — 고를 때마다(`force`), 그리고 서버에 막 붙었는데 이력이 없을 때 한 번. */
  private ensureHistory(force: boolean): void {
    if (!this.isOpen || this.tab !== 'exchange' || !this.coin) return;
    const market = this.ctx.net?.crypto;
    if (!market || !market.available || typeof market.requestHistory !== 'function') return;
    const key = `${this.coin}:${this.range}`;
    const have = market.getHistory(this.coin, this.range);
    if (!force && this.requested === key && have) return;
    if (!force && this.requested === key) return;
    this.requested = key;
    this.debug.requests++;
    try { market.requestHistory(this.coin, this.range); } catch { /* net gone */ }
  }

  private quickFill(pct: number): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    const coin = coinInfos(this.ref, this.ctx).find((c) => c.def.id === this.coin);
    let units = 0;
    if (this.side === 'sell') {
      units = Math.floor((coin?.walletUnits ?? 0) * pct);
    } else {
      const price = coin?.price ?? livePrice(this.ctx, this.coin);
      units = price !== null ? Math.floor(affordableUnits(price, this.ctx.meta?.credits ?? 0) * pct) : 0;
    }
    units = Math.max(0, Math.min(CRYPTO_TRADE_MAX_UNITS, units));
    this.amount.value = units > 0 ? formatCoinUnits(units) : '';
    this.paintTrade();
  }

  private units(): number {
    const raw = this.amount.value.trim().replace(/,/g, '.');
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? coinToUnits(n) : 0;
  }

  /** 지금 매매를 막는 사유와 견적 (UI 가 먼저 보는 것 → housing 견적). */
  private quote(): { block: string | null; price: number | null; credits: number | null } {
    const coin = coinInfos(this.ref, this.ctx).find((c) => c.def.id === this.coin);
    if (!coin) return { block: '코인을 고르세요', price: null, credits: null };
    const price = coin.price ?? livePrice(this.ctx, this.coin);
    if (!coin.unlocked) return { block: coin.lockReason ?? '잠긴 코인입니다', price, credits: null };
    const market = this.ctx.net?.crypto;
    if (!market || !market.available) return { block: OFFLINE, price: null, credits: null };
    if (this.pricesStale(market.pricesAt)) return { block: STALE, price, credits: null };
    const units = this.units();
    if (units <= 0) return { block: '수량을 입력하세요', price, credits: null };
    const fn = this.ref.cryptoQuote;
    if (typeof fn !== 'function') return { block: '거래소를 사용할 수 없습니다', price, credits: null };
    let q: ReturnType<NonNullable<MiningHousing['cryptoQuote']>> = null;
    try { q = fn.call(this.ref, this.coin, this.side, units); } catch { q = null; }
    if (!q) return { block: '견적을 낼 수 없습니다', price, credits: null };
    return { block: q.block, price: q.price, credits: q.credits };
  }

  /** 마지막 시세가 `STALE_MS` 보다 오래됐는가 (서버 시계 기준 — 없으면 로컬 시계). */
  private pricesStale(pricesAt: number): boolean {
    if (!(pricesAt > 0)) return true;
    let now = Date.now();
    try {
      const t = this.ctx.net?.serverNow?.();
      if (typeof t === 'number' && Number.isFinite(t) && t > 0) now = t;
    } catch { /* net gone */ }
    return now - pricesAt > STALE_MS;
  }

  private async runTrade(): Promise<void> {
    if (this.pending) return;
    const q = this.quote();
    if (q.block) { this.deny(q.block); return; }
    const fn = this.ref.tradeCrypto;
    if (typeof fn !== 'function') { this.deny('거래소를 사용할 수 없습니다'); return; }
    const coin = this.coin, side = this.side, units = this.units();
    const def = coinDef(coin);
    this.pending = true;
    this.debug.trades++;
    this.paintTrade();
    // 릴레이는 구독 중인 소켓에만 시세를 밀고 그 창으로 거래를 검증한다 — 답이 올 때까지 탭을 바꿔도 구독을 쥐고 있는다 (탭 구독과 별개의 참조)
    const market = this.ctx.net?.crypto;
    let release: (() => void) | null = null;
    try { release = market && typeof market.watch === 'function' ? market.watch() : null; } catch { release = null; }
    let reason: string | null;
    try { reason = await fn.call(this.ref, coin, side, units); } catch { reason = '거래에 실패했습니다'; } finally {
      try { release?.(); } catch { /* net gone */ }
    }
    this.pending = false;
    if (reason) { this.deny(reason); this.paintTrade(); return; }
    const text = `${def?.name ?? coin} ${formatCoinUnits(units)} ${def?.ticker ?? ''} ${side === 'buy' ? '매수' : '매도'} — ${fmtCredits(q.credits ?? 0)} 크레딧`;
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.ctx.bus.emit('ui:notify', { text, kind: 'success' });
    this.showMsg(text, 'success');
    this.amount.value = '';
    if (this.isOpen) this.refresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    this.debug.paints++;
    this.syncWatch();
    const market = this.ctx.net?.crypto;
    const available = !!market?.available;
    if (available && !this.lastAvailable) this.requested = '';     // 막 붙었다 — 이력을 한 번 다시 받는다
    this.lastAvailable = available;
    this.paintHeader();
    if (this.tab === 'clusters') this.paintClusters();
    else if (this.tab === 'wallet') this.paintWallet();
    else { this.ensureHistory(false); this.paintExchange(); }
  }

  private paintHeader(): void {
    const list = clusterList(this.ref);
    const mining = list.filter((c) => c.mining).length;
    paintStationMeta(this.shell, list.length ? `채굴 중 ${mining} / ${list.length}대` : '연산 클러스터 없음');
    let block: string | null = null;
    try { block = this.uid && this.ref.furnitureOperationalBlock ? this.ref.furnitureOperationalBlock(this.uid) : null; } catch { block = null; }
    const placed = this.uid ? this.housing.getPlacedByUid(this.uid) : null;
    paintStationPower(this.shell);
    const powerShown = !!this.shell.powerBanner && !this.shell.powerBanner.hidden;
    const text = !placed ? '메인 컴퓨터가 없습니다'
      : block ? (powerShown ? '메인 컴퓨터가 멈춰 있어 클러스터가 채굴하지 않습니다' : `${block} — 메인 컴퓨터가 멈춰 있어 클러스터가 채굴하지 않습니다`) : null;
    this.banner.hidden = !text;
    setText(this.banner, text ?? '');
  }

  /* 클러스터 현황 */
  private paintClusters(): void {
    const list = clusterList(this.ref);
    const key = list.map((c) => c.uid).join(',');
    if (key !== this.clKey) { this.clKey = key; this.buildClusterRows(list); }
    let credits = 0, priced = 0, unpriced = 0;
    const perCoin = new Map<string, number>();
    for (const c of list) {
      const row = this.clRows.find((r) => r.uid === c.uid);
      if (row) this.paintClusterRow(row, c);
      if (!c.mining || !c.coinId) continue;
      const uph = unitsPerHour(c);
      perCoin.set(c.coinId, (perCoin.get(c.coinId) ?? 0) + uph);
      const price = livePrice(this.ctx, c.coinId);
      if (price !== null) { credits += unitsValue(price, uph); priced++; } else unpriced++;
    }
    clear(this.clSummary);
    const mining = list.filter((c) => c.mining).length;
    this.sumItem('채굴 중', `${mining} / ${list.length}대`, mining > 0 ? 'good' : '');
    this.sumItem('시간당 예상 크레딧', priced > 0 ? `≈ ${fmtCredits(credits)}${unpriced > 0 ? ' +' : ''}` : mining > 0 ? '— (서버 시세 없음)' : '—');
    const rates = el('div', { cls: 'mn-sum-item mn-sum-rates', parent: this.clSummary });
    el('span', { cls: 'k', text: '시간당 채굴', parent: rates });
    const rv = el('span', { cls: 'v', parent: rates });
    if (!perCoin.size) setText(rv, '—');
    for (const [id, uph] of perCoin) {
      const def = coinDef(id);
      const chip = el('span', { cls: 'mn-rate', parent: rv });
      coinGlyph(chip, def, 'sm');
      el('span', { text: `${formatCoinUnits(Math.round(uph))} ${def?.ticker ?? id}`, parent: chip });
    }
  }

  private sumItem(k: string, v: string, tone: '' | 'good' | 'bad' = ''): void {
    const it = el('div', { cls: 'mn-sum-item', parent: this.clSummary });
    el('span', { cls: 'k', text: k, parent: it });
    el('span', { cls: `v ${tone}`.trim(), text: v, parent: it });
  }

  private buildClusterRows(list: readonly ComputeClusterInfo[]): void {
    clear(this.clList);
    this.clRows = [];
    if (!list.length) {
      el('div', { cls: 'hs-empty', text: '연산 클러스터가 없습니다 — 채굴 시설에 연산 클러스터를 배치하세요', parent: this.clList });
      return;
    }
    const head = el('div', { cls: 'mn-crow mn-chead', parent: this.clList });
    for (const t of ['클러스터', '코인', '코어', '이번 주기', '상태', '전력']) el('span', { text: t, parent: head });
    list.forEach((c, i) => {
      const row = el('div', { cls: 'mn-crow', attrs: { 'data-uid': c.uid, role: 'button' }, parent: this.clList });
      const name = el('span', { cls: 'mn-cname', parent: row });
      el('b', { text: `연산 클러스터 ${i + 1}`, parent: name });
      el('small', { text: `방 ${c.room + 1}`, parent: name });
      const coinCell = el('span', { cls: 'mn-ccoin', parent: row });
      const glyph = coinGlyph(coinCell, null, 'sm');
      const coin = el('span', { text: '—', parent: coinCell });
      const coresCell = el('span', { cls: 'mn-ccores', parent: row });
      const cores = el('span', { text: '', parent: coresCell });
      const pipsEl = el('span', { cls: 'mn-pips', parent: coresCell });
      const pips: HTMLElement[] = [];
      for (let k = 0; k < MAX_CORES; k++) pips.push(el('i', { parent: pipsEl }));
      const progCell = el('span', { cls: 'mn-cprog', parent: row });
      const fill = el('i', { parent: el('span', { cls: 'mn-bar', parent: progCell }) });
      const clock = el('span', { cls: 'mn-clock hs-clock', parent: progCell });
      const status = el('span', { cls: 'mn-cstatus', parent: row });
      const power = el('span', { cls: 'mn-cpower', parent: row });
      this.clRows.push({ uid: c.uid, row, glyph, coin, cores, pips, fill, clock, status, power });
    });
  }

  private paintClusterRow(r: ClusterRow, c: ComputeClusterInfo): void {
    const def = coinDef(c.coinId);
    const { glyph } = r;
    if (glyph.dataset.coin !== (c.coinId ?? '')) {
      glyph.dataset.coin = c.coinId ?? '';
      glyph.textContent = def?.glyph ?? '·';
      if (def) glyph.style.setProperty('--cc', def.color); else glyph.style.removeProperty('--cc');
    }
    setText(r.coin, def?.ticker ?? '—');
    setText(r.cores, `${c.cores}/${c.maxCores || MAX_CORES}`);
    r.pips.forEach((p, k) => toggleClass(p, 'on', k < c.cores));
    r.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, c.progress)).toFixed(4)})`;
    toggleClass(r.fill.parentElement!, 'is-paused', !c.mining);
    if (c.mining) renderClock(r.clock, c.remainingS);
    else renderClockText(r.clock, c.progress > 0 ? '정지됨' : '—');
    setText(r.status, c.mining ? '채굴 중' : c.block ?? '대기');
    toggleClass(r.status, 'good', c.mining);
    toggleClass(r.status, 'bad', !c.mining);
    r.status.title = c.block ?? '';
    setText(r.power, `⚡ ${c.power}`);
    toggleClass(r.row, 'is-mining', c.mining);
  }

  /* 지갑 */
  private paintWallet(): void {
    const coins = coinInfos(this.ref, this.ctx);
    if (this.wRows.length !== coins.length) this.buildWalletRows(coins);
    const mined = this.housing.state.cryptoMined ?? {};
    let total = 0, anyPrice = false, anyHeld = false;
    for (const c of coins) {
      const r = this.wRows.find((x) => x.id === c.def.id);
      if (!r) continue;
      const price = c.price ?? livePrice(this.ctx, c.def.id);
      setText(r.units, `${formatCoinUnits(c.walletUnits)} ${c.def.ticker}`);
      toggleClass(r.units, 'dim', c.walletUnits <= 0);
      const value = price !== null ? unitsValue(price, c.walletUnits) : null;
      setText(r.value, value !== null ? `${fmtCredits(value)} 크레딧` : '—');
      const ch = c.change24h ?? null;
      setText(r.change, fmtChange(ch));
      toggleClass(r.change, 'up', changeTone(ch) === 'up');
      toggleClass(r.change, 'down', changeTone(ch) === 'down');
      setText(r.mined, `${formatCoinUnits(mined[c.def.id] ?? 0)}`);
      r.lock.hidden = c.unlocked;
      if (c.walletUnits > 0) anyHeld = true;
      if (value !== null) { total += value; anyPrice = true; }
    }
    clear(this.wSummary);
    const it = el('div', { cls: 'mn-sum-item', parent: this.wSummary });
    el('span', { cls: 'k', text: '총 평가액', parent: it });
    el('span', { cls: 'v', text: anyPrice ? `${fmtCredits(total)} 크레딧` : anyHeld ? `— (${OFFLINE})` : '—', parent: it });
    const cr = el('div', { cls: 'mn-sum-item', parent: this.wSummary });
    el('span', { cls: 'k', text: '보유 크레딧', parent: cr });
    el('span', { cls: 'v', text: `${fmtCredits(this.ctx.meta?.credits ?? 0)}`, parent: cr });
  }

  private buildWalletRows(coins: readonly CryptoCoinInfo[]): void {
    clear(this.wList);
    this.wRows = [];
    for (const c of coins) {
      const row = el('div', { cls: 'mn-wrow', attrs: { 'data-coin': c.def.id, role: 'button' }, parent: this.wList });
      const name = el('span', { cls: 'mn-wname', parent: row });
      coinGlyph(name, c.def);
      const n = el('span', { parent: name });
      el('b', { text: c.def.name, parent: n });
      el('small', { text: c.def.ticker, parent: n });
      const lock = el('span', { cls: 'mn-lock', text: '잠김', parent: name });
      const units = el('span', { cls: 'mn-num', parent: row });
      const value = el('span', { cls: 'mn-num', parent: row });
      const change = el('span', { cls: 'mn-num mn-chg', parent: row });
      const mined = el('span', { cls: 'mn-num dim', parent: row });
      this.wRows.push({ id: c.def.id, row, units, value, change, mined, lock });
    }
  }

  /* 거래소 */
  private paintExchange(): void {
    const coins = coinInfos(this.ref, this.ctx);
    if (!this.coin) this.coin = this.defaultCoin();
    if (this.xRows.length !== coins.length) this.buildListRows(coins);
    for (const c of coins) {
      const r = this.xRows.find((x) => x.id === c.def.id);
      if (!r) continue;
      toggleClass(r.row, 'is-active', c.def.id === this.coin);
      toggleClass(r.row, 'is-locked', !c.unlocked);
      const price = c.price ?? livePrice(this.ctx, c.def.id);
      setText(r.price, price !== null ? fmtPrice(price) : '—');
      setText(r.change, fmtChange(c.change24h));
      toggleClass(r.change, 'up', changeTone(c.change24h) === 'up');
      toggleClass(r.change, 'down', changeTone(c.change24h) === 'down');
      r.lock.hidden = c.unlocked;
    }
    for (const [k, b] of this.rangeBtns) toggleClass(b, 'is-active', k === this.range);
    for (const [k, b] of this.modeBtns) toggleClass(b, 'is-active', k === this.chart.currentMode);
    const cur = coins.find((c) => c.def.id === this.coin) ?? null;
    const def = cur?.def ?? null;
    const glyph = this.xHeadGlyph;
    glyph.textContent = def?.glyph ?? '·';
    if (def) glyph.style.setProperty('--cc', def.color);
    setText(this.xHeadName, def ? `${def.name} · ${def.ticker}` : '');
    const price = cur ? cur.price ?? livePrice(this.ctx, cur.def.id) : null;
    setText(this.xHeadPrice, price !== null ? `${fmtPrice(price)} 크레딧` : '—');
    setText(this.xHeadChange, cur ? fmtChange(cur.change24h) : '');
    toggleClass(this.xHeadChange, 'up', changeTone(cur?.change24h ?? null) === 'up');
    toggleClass(this.xHeadChange, 'down', changeTone(cur?.change24h ?? null) === 'down');
    this.paintChart();
    this.paintTrade();
  }

  private buildListRows(coins: readonly CryptoCoinInfo[]): void {
    clear(this.xList);
    this.xRows = [];
    for (const c of coins) {
      const row = el('div', { cls: 'mn-xrow', attrs: { 'data-coin': c.def.id, role: 'button' }, parent: this.xList });
      coinGlyph(row, c.def);
      const n = el('span', { cls: 'mn-xrow-name', parent: row });
      el('b', { text: c.def.ticker, parent: n });
      el('small', { text: c.def.name, parent: n });
      const nums = el('span', { cls: 'mn-xrow-nums', parent: row });
      const price = el('span', { cls: 'mn-num', text: '—', parent: nums });
      const change = el('span', { cls: 'mn-num mn-chg', text: '', parent: nums });
      const lock = el('span', { cls: 'mn-lock', text: '잠김', parent: row });
      this.xRows.push({ id: c.def.id, row, price, change, lock });
    }
  }

  private paintChart(): void {
    this.debug.chartPaints++;
    const market = this.ctx.net?.crypto;
    const def = coinDef(this.coin);
    if (!market || !market.available) { this.chart.setMessage(OFFLINE); return; }
    let hist: readonly import('@/shared').CryptoCandle[] | null = null;
    try { hist = def ? market.getHistory(this.coin, this.range) : null; } catch { hist = null; }
    if (!hist || !hist.length) { this.chart.setMessage('시세 이력을 불러오는 중…'); return; }
    this.chart.setMessage(null);
    this.chart.setData(withLivePrice(hist, this.range, livePrice(this.ctx, this.coin), market.pricesAt), this.range, def?.color ?? '#8fe8ff');
  }

  private paintTrade(): void {
    const coin = coinInfos(this.ref, this.ctx).find((c) => c.def.id === this.coin) ?? null;
    const def = coin?.def ?? null;
    for (const [k, b] of this.sideBtns) toggleClass(b, 'is-active', k === this.side);
    setText(this.amountTicker, def?.ticker ?? '');
    setText(this.have, def ? `보유 ${formatCoinUnits(coin?.walletUnits ?? 0)} ${def.ticker} · 크레딧 ${fmtCredits(this.ctx.meta?.credits ?? 0)}` : '');
    const q = this.quote();
    const locked = !!coin && !coin.unlocked;
    const offline = !this.ctx.net?.crypto?.available;
    toggleClass(this.trade, 'is-locked', locked);
    toggleClass(this.trade, 'is-offline', offline && !locked);
    this.amount.disabled = locked || offline;
    setText(this.quoteRows.price, q.price !== null ? `${fmtPrice(q.price)} 크레딧` : '—');
    setText(this.quoteRows.fee, `${(CRYPTO_TRADE_FEE * 100).toFixed(1)} %`);
    setText(this.quoteRows.creditsK, this.side === 'buy' ? '내는 크레딧' : '받는 크레딧');
    setText(this.quoteRows.credits, q.credits !== null ? `${fmtCredits(q.credits)} 크레딧` : '—');
    setText(this.blockEl, q.block ?? `버튼을 1초 동안 누르고 있으면 ${this.side === 'buy' ? '매수' : '매도'}합니다`);
    toggleClass(this.blockEl, 'bad', !!q.block);
    const disabled = !!q.block || this.pending;
    if (this.holdBtn.disabled !== disabled) this.holdBtn.disabled = disabled;
    if (disabled) this.hold.cancel();
    toggleClass(this.holdBtn, 'danger', this.side === 'sell');
    toggleClass(this.holdBtn, 'primary', this.side === 'buy');
    setText(this.holdLabel, this.pending ? '처리 중…' : this.side === 'buy' ? '매수' : '매도');
  }

  override dispose(): void {
    this.stopTicking();
    this.hold.dispose();
    this.chart.dispose();
    if (this.unwatch) { try { this.unwatch(); } catch { /* */ } this.unwatch = null; }
    super.dispose();
  }
}

/** `openMiningComputer(uid, tab)` 의 몸통 — `uid` null = 함선의 메인 컴퓨터 (없으면 토스트). */
export function openMiningComputerScreen(sys: HousingSystem, uid: string | null, tab?: MiningComputerTab): void {
  const screen = sys.miningComputer;
  if (!screen) return;
  const ref: MiningHousing = sys;
  let id = uid;
  if (id === null) {
    try { id = ref.getMiningComputerUid?.() ?? null; } catch { id = null; }
    if (id === null) id = sys.getPlaced().find((p) => p.defId === MINING_COMPUTER_DEF_ID)?.uid ?? null;
  }
  const placed = id ? sys.getPlacedByUid(id) : null;
  if (!id || !placed || placed.defId !== MINING_COMPUTER_DEF_ID) { sys.notify('메인 컴퓨터가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  if (screen.isOpen) { if (tab) screen.setTab(tab); return; }
  sys.closeMenus(false);
  screen.openComputer(id, tab);
}
