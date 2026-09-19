import type { ComputeClusterInfo, CryptoChartRange, CryptoCoinInfo, CryptoTradeSide, GameContext, MiningComputerTab } from '@/shared';
import {
  COMPUTE_CLUSTER_MAX_CORES, CRYPTO_CHART_RANGES, CRYPTO_CHART_RANGE_LABEL_KO, CRYPTO_QUOTE_WINDOW_S, CRYPTO_TICK_S, CRYPTO_TRADE_FEE, CRYPTO_TRADE_MAX_UNITS,
  coinToUnits, createHoldButtonCap, formatCoinUnits,
} from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { clear, el, isolateInput, renderClock, renderClockText, setText, toggleClass } from '../dom';
import { CryptoChart, withLivePrice } from './CryptoChart';
import type { ChartMode } from './CryptoChart';
import type { MiningHost } from './MiningScreen';
import {
  affordableUnits, bindHoldButton, changeTone, clusterList, coinDef, coinGlyph, coinInfos, fmtChange, fmtCredits, fmtPrice,
  livePrice, unitsPerHour, unitsValue, type HoldButton, type MiningHousing,
} from './common';

const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const OFFLINE = '서버에 연결되어야 합니다';
/**
 * A quote older than this blocks the trade confirm (ms). The relay only checks the amount against a quote inside the last
 * `CRYPTO_QUOTE_WINDOW_S` window, so nothing is sent on a quote that will leave the window before the request arrives — the
 * window minus half a tick. Both numbers come from `data/tuning.csv`.
 */
const STALE_MS = Math.max(1000, CRYPTO_QUOTE_WINDOW_S * 1000 - (CRYPTO_TICK_S * 1000) / 2);
const STALE = '시세가 오래되었습니다 — 새 시세를 기다리는 중';
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
}
interface WalletRow { id: string; row: HTMLElement; units: HTMLElement; value: HTMLElement; change: HTMLElement; mined: HTMLElement; lock: HTMLElement }
interface ListRow { id: string; row: HTMLElement; price: HTMLElement; change: HTMLElement; lock: HTMLElement }

/**
 * **The main computer's three tabs** (`클러스터 현황` · `지갑` · `거래소`) — since 2026-09-14 they live in **one window** with
 * the `채굴` tab (`MiningScreen`). The content is the old `MiningComputer` panel's as it was; only three things differ: the tab
 * row moved to the top of the screen (the window owns it), the header row · the banner are painted through `MiningHost`, and
 * 「click a status row → that cluster」 switches to the **`채굴` tab** instead of closing the window.
 *
 *  - **`클러스터 현황`** — one row per cluster (room · coin glyph + ticker · processors n/9 · progress bar + `HH:MM:SS` · mining / the blocking reason).
 *  - **`지갑`** — per coin the holding · value · the 24-hour change · the mined total, plus the total value. Pressing a row opens that coin's exchange.
 *  - **`거래소`** — the coin list + the chart (`CryptoChart`) + trading (quantity · 25/50/100 % · the quote · a **1 s hold confirm**).
 *
 * The price subscription (`ctx.net.crypto.watch()`) is held only while the `지갑` · `거래소` tab is open.
 */
export class ComputerPages {
  private uid: string | null = null;
  private tab: MiningComputerTab | null = null;
  private readonly pages: Record<MiningComputerTab, HTMLElement>;
  /* Cluster overview */
  private readonly clSummary: HTMLElement;
  private readonly clList: HTMLElement;
  private clRows: ClusterRow[] = [];
  private clKey = '';
  /* Wallet */
  private readonly wSummary: HTMLElement;
  private readonly wList: HTMLElement;
  private wRows: WalletRow[] = [];
  /* Exchange */
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

  constructor(
    private readonly ctx: GameContext,
    private readonly housing: HousingSystem,
    private readonly host: MiningHost,
  ) {
    const left = host.shell.left;
    this.pages = {
      clusters: el('div', { cls: 'mn-page', attrs: { 'data-page': 'clusters' }, parent: left }),
      wallet: el('div', { cls: 'mn-page', attrs: { 'data-page': 'wallet' }, parent: left }),
      exchange: el('div', { cls: 'mn-page mn-page-x', attrs: { 'data-page': 'exchange' }, parent: left }),
    };
    for (const k of TABS) this.pages[k].hidden = true;

    /* ── Cluster overview ── */
    this.clSummary = el('div', { cls: 'mn-sum', parent: this.pages.clusters });
    this.clList = el('div', { cls: 'mn-crows', parent: this.pages.clusters });
    this.clList.addEventListener('click', (e) => {
      const uid = (e.target as Element | null)?.closest<HTMLElement>('.mn-crow[data-uid]')?.dataset.uid;
      if (!uid) return;
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.host.openCluster(uid);
    });

    /* ── Wallet ── */
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
      this.host.setTab('exchange');
    });

    /* ── Exchange ── */
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
    // 2026-09-15 2nd pass (user's decision): a left-click hold keycap **inside** the button instead of the 「버튼을 1초 동안 누르고 있으면 …」 guidance row.
    createHoldButtonCap(this.holdBtn);
    this.holdLabel = el('span', { cls: 'mn-hold-label', text: '매수', parent: this.holdBtn });
    this.hold = bindHoldButton(this.holdBtn, fill, () => { void this.runTrade(); }, () => this.host.showMsg('거래 버튼을 1초간 꾹 누르세요', 'info'));
  }

  /** Bus subscriptions the panel owns (pushed into its `unsubs`). */
  bind(): Array<() => void> {
    const b = this.ctx.bus;
    const hit = (): void => { if (this.tab && this.host.isOpen) this.host.refreshLater(); };
    return [
      b.on('housing:clusterChanged', hit),
      b.on('housing:cryptoMined', hit),
      b.on('housing:walletChanged', hit),
      b.on('meta:creditsChanged', () => { if (this.tab && this.host.isOpen) this.paintTrade(); }),
      b.on('net:cryptoPrices', hit),
      b.on('net:cryptoHistory', ({ coin, range }) => {
        if (this.tab === 'exchange' && this.host.isOpen && coin === this.coin && range === this.range) this.paintChart();
      }),
    ];
  }

  private get ref(): MiningHousing { return this.housing; }

  get currentUid(): string | null { return this.uid; }
  setUid(uid: string): void { this.uid = uid; }
  get selectedCoin(): string { return this.coin; }

  /** `null` = the `채굴` tab is up (all three pages hidden, the price subscription released). */
  setActive(tab: MiningComputerTab | null): void {
    this.tab = tab;
    for (const k of TABS) this.pages[k].hidden = k !== tab;
    this.hold.cancel();
    this.syncWatch();
    if (tab === 'exchange') {
      if (!this.coin) this.selectCoin(this.defaultCoin(), false);
      this.ensureHistory(false);
      this.chart.resize();
    }
  }

  onClose(): void {
    this.hold.cancel();
  }

  dispose(): void {
    this.hold.dispose();
    this.chart.dispose();
    if (this.unwatch) { try { this.unwatch(); } catch { /* net gone */ } this.unwatch = null; }
  }

  tick(): void {
    this.paintHeader();
    if (this.tab === 'clusters') this.paintClusters();
    else if (this.tab === 'exchange') this.paintTrade();   // a stale quote has to lock the confirm button even with no event
  }

  /** The price subscription — only while the `지갑` · `거래소` tab is open. */
  syncWatch(): void {
    const want = this.host.isOpen && (this.tab === 'exchange' || this.tab === 'wallet');
    const market = this.ctx.net?.crypto;
    if (want && !this.unwatch && market && typeof market.watch === 'function') {
      try { this.unwatch = market.watch(); this.host.debug.watches++; } catch { this.unwatch = null; }
    } else if (!want && this.unwatch) {
      const u = this.unwatch;
      this.unwatch = null;
      try { u(); } catch { /* net gone */ }
      this.host.debug.unwatches++;
    }
  }

  private defaultCoin(): string {
    const list = coinInfos(this.ref, this.ctx);
    return (list.find((c) => c.unlocked) ?? list[0])?.def.id ?? '';
  }

  /* ── Exchange actions ──────────────────────────────────────────────────── */
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
    if (paint && this.tab && this.host.isOpen) this.refresh();
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

  /** Requests the candle history — on every pick (`force`), and once when the server has just connected and there is no history. */
  private ensureHistory(force: boolean): void {
    if (!this.host.isOpen || this.tab !== 'exchange' || !this.coin) return;
    const market = this.ctx.net?.crypto;
    if (!market || !market.available || typeof market.requestHistory !== 'function') return;
    const key = `${this.coin}:${this.range}`;
    const have = market.getHistory(this.coin, this.range);
    if (!force && this.requested === key && have) return;
    if (!force && this.requested === key) return;
    this.requested = key;
    this.host.debug.requests++;
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

  /** The reason a trade is blocked right now, and the quote (what the UI checks first → the housing quote). */
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

  /** Is the last quote older than `STALE_MS` (by the server clock — the local clock with none). */
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
    if (q.block) { this.host.denyMsg(q.block); return; }
    const fn = this.ref.tradeCrypto;
    if (typeof fn !== 'function') { this.host.denyMsg('거래소를 사용할 수 없습니다'); return; }
    const coin = this.coin, side = this.side, units = this.units();
    const def = coinDef(coin);
    this.pending = true;
    this.host.debug.trades++;
    this.paintTrade();
    // the relay pushes quotes only to subscribed sockets and validates the trade against that window — the subscription is held until the answer arrives even if the tab changes (a reference separate from the tab's)
    const market = this.ctx.net?.crypto;
    let release: (() => void) | null = null;
    try { release = market && typeof market.watch === 'function' ? market.watch() : null; } catch { release = null; }
    let reason: string | null;
    try { reason = await fn.call(this.ref, coin, side, units); } catch { reason = '거래에 실패했습니다'; } finally {
      try { release?.(); } catch { /* net gone */ }
    }
    this.pending = false;
    if (reason) { this.host.denyMsg(reason); this.paintTrade(); return; }
    const text = `${def?.name ?? coin} ${formatCoinUnits(units)} ${def?.ticker ?? ''} ${side === 'buy' ? '매수' : '매도'} — ${fmtCredits(q.credits ?? 0)} 크레딧`;
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.ctx.bus.emit('ui:notify', { text, kind: 'success' });
    this.host.showMsg(text, 'success');
    this.amount.value = '';
    if (this.tab && this.host.isOpen) this.refresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    this.syncWatch();
    const market = this.ctx.net?.crypto;
    const available = !!market?.available;
    if (available && !this.lastAvailable) this.requested = '';     // just connected — the history is fetched once more
    this.lastAvailable = available;
    this.paintHeader();
    if (this.tab === 'clusters') this.paintClusters();
    else if (this.tab === 'wallet') this.paintWallet();
    else if (this.tab === 'exchange') { this.ensureHistory(false); this.paintExchange(); }
  }

  private paintHeader(): void {
    const list = clusterList(this.ref);
    const mining = list.filter((c) => c.mining).length;
    this.host.setTitle('메인 컴퓨터', list.length ? `채굴 중 ${mining} / ${list.length}대` : '연산 클러스터 없음', list.length > 0 && mining === 0);
    // 2026-09-13 (power allocation dropped): the main computer never stops — the only banner left is 「메인 컴퓨터가 없다」
    const placed = this.uid ? this.housing.getPlacedByUid(this.uid) : null;
    this.host.setBanner(!placed ? '메인 컴퓨터가 없습니다' : null);
  }

  /* Cluster overview */
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
    for (const t of ['클러스터', '코인', '프로세서', '이번 주기', '상태']) el('span', { text: t, parent: head });
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
      this.clRows.push({ uid: c.uid, row, glyph, coin, cores, pips, fill, clock, status });
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
    toggleClass(r.row, 'is-mining', c.mining);
  }

  /* Wallet */
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

  /* Exchange */
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
    this.host.debug.chartPaints++;
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
    // 2026-09-15 2nd pass (user's decision): this row says **only the blocking reason** — the hold guidance is the keycap inside
    // the button instead, and with nothing blocking the row disappears (`hidden`, so an empty row takes no space).
    setText(this.blockEl, q.block ?? '');
    this.blockEl.hidden = !q.block;
    toggleClass(this.blockEl, 'bad', !!q.block);
    const disabled = !!q.block || this.pending;
    if (this.holdBtn.disabled !== disabled) this.holdBtn.disabled = disabled;
    if (disabled) this.hold.cancel();
    toggleClass(this.holdBtn, 'danger', this.side === 'sell');
    toggleClass(this.holdBtn, 'primary', this.side === 'buy');
    setText(this.holdLabel, this.pending ? '처리 중…' : this.side === 'buy' ? '매수' : '매도');
  }
}
