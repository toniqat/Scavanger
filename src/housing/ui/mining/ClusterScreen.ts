import type { ComputeClusterInfo, CryptoCoinInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance, PlacedFurniture } from '@/shared';
import { COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, COMPUTE_CORE_DEF_ID, coinCycleMs, formatCoinUnits } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { HousingPanel } from '../Panel';
import { ProductDrag } from '../ProductDrag';
import type { Product } from '../ProductDrag';
import { StationTip } from '../StationTip';
import type { TipRow, TipSpec } from '../StationTip';
import { buildStationShell, mountStationGrids, paintStationMeta, paintStationPower } from '../StationShell';
import type { StationShell } from '../StationShell';
import { clear, el, renderClock, renderClockText, setText, toggleClass } from '../dom';
import {
  MiningAsk, clusterOf, coinDef, coinGlyph, coinInfos, fmtChange, fmtCredits, fmtDuration, fmtPrice, livePrice, liveChange,
  paintCoinGlyph, unitsPerHour, unitsValue, type MiningHousing,
} from './common';

const TICK_MS = 1000;
const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const NO_API = '채굴 기능을 사용할 수 없습니다';

interface RailItem { uid: string; el: HTMLElement; dots: HTMLElement[]; red: HTMLElement }
interface CoinBtn { id: string; el: HTMLElement; price: HTMLElement }
interface StatRow { row: HTMLElement; v: HTMLElement }

/**
 * **연산 클러스터 화면** (2026-09-13, 암호화폐 채굴 — `openComputeCluster(uid)` ← E on a 연산 클러스터).
 *
 * `StationShell` 카드 배치 (재배 스테이션 · 배양조와 같은 결): [스테이션 카드] [함선 창고] [가방].
 *  - **레일** = 함선의 연산 클러스터 전부 (이름 + 3×3 점 = 꽂힌 코어 — 채굴 중이면 초록, 멈췄으면 회색 · 코인과 코어가 있는데
 *    멈췄으면 레드닷). 누르면 그 클러스터로 바뀐다.
 *  - **코어 칸 3×3** (`.mn-core[data-core]` = 드롭 대상): 창고 · 가방의 연산 코어를 떨어뜨리면 빈 칸만큼 꽂는다
 *    (`insertClusterCores(uid, min(스택, 빈 칸))`). 꽂힌 칸 = 켜진 코어. 더블클릭 = 함선 창고 먼저 · 우클릭 = 가방 먼저 ·
 *    끌어서 격자에 놓기 = 그 격자로 한 개씩 뺀다 (`removeClusterCores(uid, 1, dest)`, `ProductDrag`).
 *  - **상태** — 채굴 주기(지금 코어) · 코어 +1 이면 · 주기당 채굴 · 시간당 예상 코인 / 크레딧(시세가 있을 때) · 요구 전력 · 시설 전력,
 *    이번 주기 진행 막대 + `HH:MM:SS`, 막는 사유 배너(`ComputeClusterInfo.block`).
 *  - **채굴 코인** 8종 — 잠긴 코인은 딤드(호버 카드에 잠긴 이유). 진행도가 있는 채로 다른 코인을 고르면 1초 홀드 경고
 *    (진행도가 0 이 된다 — 되돌릴 수 없다). 지금 코인 우클릭 = 채굴 해제.
 *
 * 규칙은 하나도 여기 없다 — 사유는 전부 `ctx.housing`(parts/Mining, 에이전트 ③)이 돌려준다. 계약 메서드는 optional 이라
 * 없으면 `채굴 기능을 사용할 수 없습니다` 로 거절한다.
 */
export class ClusterScreen extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly banner: HTMLElement;
  private readonly coresEl: HTMLElement;
  private readonly coreCells: HTMLElement[] = [];
  private readonly coreCount: HTMLElement;
  private readonly stats: Record<'coin' | 'cycle' | 'next' | 'yield' | 'rate' | 'credits' | 'power' | 'facility', StatRow>;
  private readonly progFill: HTMLElement;
  private readonly progClock: HTMLElement;
  private readonly progPct: HTMLElement;
  private readonly coinsEl: HTMLElement;
  private readonly coinBtns: CoinBtn[] = [];
  private readonly tip: StationTip;
  private readonly ask: MiningAsk;
  private readonly drag: ProductDrag;
  private grids: EmbeddedView | null = null;
  private railItems: RailItem[] = [];
  private railKey = '';
  private hoverCoin: string | null = null;
  private timer = 0;
  /** Smoke / perf counters. */
  readonly debug = { paints: 0, rails: 0, inserts: 0, removes: 0, coinSets: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'cluster', 'mining-cluster hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '연산 클러스터',
      upgrade: false,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
      power: { ctx, uid: () => this.uid || null },
    });
    this.shell.rail.addEventListener('click', (e) => this.onRailClick(e));
    const left = this.shell.left;
    left.classList.add('mn-cl');

    this.banner = el('div', { cls: 'mn-banner', parent: left });
    this.banner.hidden = true;

    const top = el('div', { cls: 'mn-cl-top', parent: left });
    const coreBox = el('div', { cls: 'mn-corebox', parent: top });
    const coreHead = el('div', { cls: 'mn-sec-head', parent: coreBox });
    el('span', { cls: 'mn-sec-title', text: '연산 코어', parent: coreHead });
    this.coreCount = el('span', { cls: 'mn-sec-count', text: `0 / ${MAX_CORES}`, parent: coreHead });
    this.coresEl = el('div', { cls: 'mn-cores', parent: coreBox });
    for (let i = 0; i < MAX_CORES; i++) {
      const c = el('div', { cls: 'mn-core', attrs: { 'data-core': String(i) }, parent: this.coresEl });
      el('i', { cls: 'mn-core-chip', parent: c });
      el('i', { cls: 'mn-core-led', parent: c });
      this.coreCells.push(c);
    }
    el('div', { cls: 'mn-hint', text: '연산 코어를 끌어다 놓아 꽂습니다 · 더블클릭 / 우클릭으로 뺍니다', parent: coreBox });

    const statBox = el('div', { cls: 'mn-stats', parent: top });
    const stat = (k: string): StatRow => {
      const row = el('div', { cls: 'mn-stat', parent: statBox });
      el('span', { cls: 'k', text: k, parent: row });
      return { row, v: el('span', { cls: 'v', text: '—', parent: row }) };
    };
    this.stats = {
      coin: stat('채굴 코인'),
      cycle: stat('채굴 주기'),
      next: stat('코어 +1'),
      yield: stat('주기당 채굴'),
      rate: stat('시간당 예상'),
      credits: stat('시간당 크레딧'),
      power: stat('요구 전력'),
      facility: stat('시설 전력'),
    };

    const prog = el('div', { cls: 'mn-cl-prog', parent: left });
    const progHead = el('div', { cls: 'mn-sec-head', parent: prog });
    el('span', { cls: 'mn-sec-title', text: '이번 주기', parent: progHead });
    this.progPct = el('span', { cls: 'mn-sec-count', text: '', parent: progHead });
    this.progClock = el('span', { cls: 'mn-clock hs-clock', text: '', parent: progHead });
    this.progFill = el('i', { parent: el('div', { cls: 'mn-bar', parent: prog }) });

    const coinSec = el('div', { cls: 'mn-coinsec', parent: left });
    const coinHead = el('div', { cls: 'mn-sec-head', parent: coinSec });
    el('span', { cls: 'mn-sec-title', text: '채굴 코인', parent: coinHead });
    el('span', { cls: 'mn-sec-count', text: '코인을 바꾸면 진행도가 초기화됩니다', parent: coinHead });
    this.coinsEl = el('div', { cls: 'mn-coins', parent: coinSec });
    this.coinsEl.addEventListener('click', (e) => {
      const id = (e.target as Element | null)?.closest<HTMLElement>('.mn-coin[data-coin]')?.dataset.coin;
      if (!id) return;
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.selectCoin(id);
    });
    this.coinsEl.addEventListener('contextmenu', (e) => {
      const id = (e.target as Element | null)?.closest<HTMLElement>('.mn-coin[data-coin]')?.dataset.coin;
      if (!id) return;
      e.preventDefault(); e.stopPropagation();
      if (this.info()?.coinId === id) this.clearCoin();
    });
    this.coinsEl.addEventListener('pointerover', (e) => this.onCoinHover(e));
    this.coinsEl.addEventListener('pointermove', (e) => { if (this.hoverCoin) this.tip.move(e.clientX, e.clientY); });
    this.coinsEl.addEventListener('pointerleave', () => this.hideTip());

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '채굴은 현실 시간에 맞춰 진행됩니다 — 메인 컴퓨터가 가동 중이어야 클러스터가 채굴합니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.tip = new StationTip(this.root);
    this.ask = new MiningAsk(ctx);
    this.overlays.push(this.ask);
    this.drag = new ProductDrag(this.coresEl, {
      productAt: (t) => this.productAt(t),
      collect: (_key, dest) => this.removeCore(dest),
      defOf: (id) => housing.defOf(id),
    });
    this.coresEl.addEventListener('contextmenu', (e) => {
      if (!(e.target as Element | null)?.closest('.mn-core')) return;
      e.preventDefault(); e.stopPropagation();
      if (this.productAt(e.target as Element)) this.removeCore('bag-first');
    });

    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:clusterChanged', () => this.refreshIfOpen()),
      b.on('housing:cryptoMined', () => this.refreshIfOpen()),
      b.on('housing:powerChanged', () => this.refreshIfOpen()),
      b.on('housing:operationalChanged', () => this.refreshIfOpen()),
      b.on('net:cryptoPrices', () => this.refreshIfOpen()),
    );
  }

  private get ref(): MiningHousing { return this.housing; }

  /* ── open / close ──────────────────────────────────────────────────────── */
  openCluster(uid: string): void {
    const was = this.isOpen;
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.mn-core[data-core]', (item, target) => this.dropOn(item, target));
    this.startTicking();
    if (!was) this.ctx.bus.emit('ui:miningToggled', { open: true, uid, page: 'cluster' });
  }

  get currentUid(): string { return this.uid; }

  override close(relock = true): void {
    const was = this.isOpen;
    this.stopTicking();
    this.hideTip();
    this.drag.end();
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
    if (was) this.ctx.bus.emit('ui:miningToggled', { open: false, uid: this.uid || null, page: 'cluster' });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /* ── state helpers ─────────────────────────────────────────────────────── */
  private info(): ComputeClusterInfo | null {
    return this.uid ? clusterOf(this.ref, this.uid) : null;
  }

  /** 함선에 놓인 연산 클러스터 (배치 순서 그대로 — 레일 번호가 흔들리지 않는다). */
  private clusters(): readonly PlacedFurniture[] {
    try { return this.housing.getPlaced().filter((p) => p.defId === COMPUTE_CLUSTER_DEF_ID); } catch { return []; }
  }

  private coinInfo(id: string): CryptoCoinInfo | null {
    return coinInfos(this.ref, this.ctx).find((c) => c.def.id === id) ?? null;
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 가방 / 창고 onto a 코어 칸 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('연산 코어를 코어 칸으로 끌어다 놓으세요', 'info'); return; }
    if (item.defId !== COMPUTE_CORE_DEF_ID) { this.deny('연산 코어만 꽂을 수 있습니다'); return; }
    const info = this.info();
    if (!info) { this.deny('연산 클러스터가 없습니다'); return; }
    const free = Math.max(0, (info.maxCores || MAX_CORES) - info.cores);
    if (free <= 0) { this.deny('코어 칸이 가득 찼습니다'); return; }
    const insert = this.ref.insertClusterCores;
    if (typeof insert !== 'function') { this.deny(NO_API); return; }
    const n = Math.max(1, Math.min(free, Math.floor(item.qty || 1)));
    const reason = insert.call(this.ref, this.uid, n);
    if (reason) { this.deny(reason); return; }
    this.debug.inserts++;
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const after = this.info();
    this.showMsg(`연산 코어 ${n}개를 꽂았습니다${after && after.cycleMs > 0 ? ` — 채굴 주기 ${fmtDuration(after.cycleMs)}` : ''}`, 'success');
  }

  private removeCore(dest: HarvestDestination): void {
    const info = this.info();
    if (!info || info.cores <= 0) return;
    const remove = this.ref.removeClusterCores;
    if (typeof remove !== 'function') { this.deny(NO_API); return; }
    const reason = remove.call(this.ref, this.uid, 1, dest);
    if (reason) { this.deny(reason); return; }
    this.debug.removes++;
    this.hideTip();
    this.showMsg(`연산 코어 1개를 뺐습니다 (${dest === 'bag' || dest === 'bag-first' ? '가방' : '함선 창고'})`, 'info');
  }

  private productAt(target: Element): Product | null {
    const cell = target.closest<HTMLElement>('.mn-core[data-core]');
    if (!cell || !cell.classList.contains('is-on')) return null;
    return { key: 'core', defId: COMPUTE_CORE_DEF_ID, qty: 1 };
  }

  private selectCoin(id: string): void {
    const coin = this.coinInfo(id);
    if (!coin) return;
    if (!coin.unlocked) { this.deny(coin.lockReason ?? '잠긴 코인입니다'); return; }
    const info = this.info();
    if (!info) { this.deny('연산 클러스터가 없습니다'); return; }
    if (info.coinId === id) return;
    const old = coinDef(info.coinId);
    if (old && info.progress > 0) {
      this.hideTip();
      this.ask.confirm({
        id: 'mn-coin-change',
        title: '채굴 코인 변경',
        body: `코인을 바꾸면 이번 주기의 진행도(${Math.floor(info.progress * 100)} %)가 사라집니다.\n${old.name} (${old.ticker}) → ${coin.def.name} (${coin.def.ticker})`,
        label: '변경',
        run: () => this.applyCoin(id),
      });
      return;
    }
    this.applyCoin(id);
  }

  private applyCoin(id: string | null): void {
    const set = this.ref.setClusterCoin;
    if (typeof set !== 'function') { this.deny(NO_API); return; }
    const reason = set.call(this.ref, this.uid, id);
    if (reason) { this.deny(reason); return; }
    this.debug.coinSets++;
    const def = coinDef(id);
    this.showMsg(def ? `${def.name} (${def.ticker}) 채굴을 시작합니다` : '채굴 코인을 해제했습니다', 'success');
  }

  private clearCoin(): void {
    const info = this.info();
    if (!info?.coinId) return;
    if (info.progress > 0) {
      this.hideTip();
      this.ask.confirm({
        id: 'mn-coin-clear',
        title: '채굴 해제',
        body: `채굴을 해제하면 이번 주기의 진행도(${Math.floor(info.progress * 100)} %)가 사라집니다.`,
        label: '해제',
        run: () => this.applyCoin(null),
      });
      return;
    }
    this.applyCoin(null);
  }

  /* ── 레일 ──────────────────────────────────────────────────────────────── */
  private buildRail(list: readonly PlacedFurniture[]): void {
    this.debug.rails++;
    const rail = this.shell.rail;
    clear(rail);
    this.railItems = [];
    rail.hidden = list.length === 0;
    list.forEach((p, i) => {
      const btn = el('button', { cls: 'hs-rail-item', attrs: { 'data-uid': p.uid }, parent: rail });
      btn.type = 'button';
      const red = el('i', { cls: 'hs-rail-red', parent: btn });
      el('span', { cls: 'hs-rail-name', text: `클러스터 ${i + 1}`, parent: btn });
      const dotsEl = el('span', { cls: 'hs-rail-dots', parent: btn });
      const dots: HTMLElement[] = [];
      for (let k = 0; k < MAX_CORES; k++) dots.push(el('i', { parent: dotsEl }));
      this.railItems.push({ uid: p.uid, el: btn, dots, red });
    });
  }

  private paintRail(): void {
    for (const it of this.railItems) {
      toggleClass(it.el, 'is-active', it.uid === this.uid);
      const c = clusterOf(this.ref, it.uid);
      const cores = c?.cores ?? 0;
      for (let k = 0; k < it.dots.length; k++) {
        toggleClass(it.dots[k], 'ready', k < cores && !!c?.mining);
        toggleClass(it.dots[k], 'growing', k < cores && !c?.mining);
      }
      toggleClass(it.red, 'on', !!c && !c.mining && !!c.coinId && cores > 0);
    }
  }

  private onRailClick(e: MouseEvent): void {
    const uid = (e.target as Element | null)?.closest<HTMLElement>('.hs-rail-item')?.dataset.uid;
    if (!uid || uid === this.uid) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.hideTip();
    this.drag.end();
    this.ask.close();
    this.uid = uid;
    this.refresh();
    this.ctx.bus.emit('ui:miningToggled', { open: true, uid, page: 'cluster' });
  }

  /* ── 호버 카드 (코인) ──────────────────────────────────────────────────── */
  private onCoinHover(e: PointerEvent): void {
    const id = (e.target as Element | null)?.closest<HTMLElement>('.mn-coin[data-coin]')?.dataset.coin ?? null;
    if (id === this.hoverCoin) return;
    this.hoverCoin = id;
    const spec = id ? this.coinTip(id) : null;
    if (spec) this.tip.show(spec, e.clientX, e.clientY);
    else this.tip.hide();
  }

  private hideTip(): void {
    this.hoverCoin = null;
    this.tip.hide();
  }

  private coinTip(id: string): TipSpec | null {
    const coin = this.coinInfo(id);
    if (!coin) return null;
    const def = coin.def;
    const info = this.info();
    const cores = Math.max(1, info?.cores ?? 1);
    const cycle = coinCycleMs(def, cores);
    const uph = unitsPerHour({ coinId: id, cycleMs: cycle });
    const price = coin.price ?? livePrice(this.ctx, id);
    const change = coin.change24h ?? liveChange(this.ctx, id);
    const rows: TipRow[] = [
      { k: `코어 ${cores}개 주기`, v: fmtDuration(cycle) },
      { k: '주기당 채굴', v: `${formatCoinUnits(def.yieldUnits)} ${def.ticker}` },
      { k: '시간당 예상', v: `${formatCoinUnits(Math.round(uph))} ${def.ticker}` },
      { k: '시세', v: price !== null ? `${fmtPrice(price)} 크레딧 (${fmtChange(change)})` : '— (서버 시세 없음)' },
    ];
    if (!coin.unlocked) rows.push({ k: '잠김', v: coin.lockReason ?? '잠긴 코인입니다', tone: 'bad' });
    return {
      name: `${def.name} (${def.ticker})`,
      sub: !coin.unlocked ? '잠긴 코인 — 차트는 메인 컴퓨터에서 볼 수 있습니다'
        : info?.coinId === id ? '채굴 중인 코인 · 우클릭: 채굴 해제' : '클릭: 채굴 코인으로 지정',
      color: def.color,
      rows,
      foot: def.description,
    };
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const list = this.clusters();
    const key = list.map((p) => p.uid).join(',');
    if (key !== this.railKey) { this.railKey = key; this.buildRail(list); }
    if (!this.coinBtns.length) this.buildCoins();
    this.paint();
  }

  private buildCoins(): void {
    clear(this.coinsEl);
    this.coinBtns.length = 0;
    for (const c of coinInfos(this.ref, this.ctx)) {
      const b = el('button', { cls: 'mn-coin', attrs: { 'data-coin': c.def.id }, parent: this.coinsEl });
      b.type = 'button';
      b.style.setProperty('--cc', c.def.color);
      coinGlyph(b, c.def);
      const body = el('span', { cls: 'mn-coin-body', parent: b });
      el('span', { cls: 'mn-coin-ticker', text: c.def.ticker, parent: body });
      el('span', { cls: 'mn-coin-name', text: c.def.name, parent: body });
      const price = el('span', { cls: 'mn-coin-price', text: '', parent: b });
      el('span', { cls: 'mn-lock', text: '잠김', parent: b });
      this.coinBtns.push({ id: c.def.id, el: b, price });
    }
  }

  private paint(): void {
    this.debug.paints++;
    this.paintRail();
    const h = this.ref;
    const info = this.info();
    const placed = this.uid ? this.housing.getPlacedByUid(this.uid) : null;
    const def = coinDef(info?.coinId);
    const index = this.clusters().findIndex((p) => p.uid === this.uid);
    setText(this.shell.title, index >= 0 ? `연산 클러스터 ${index + 1}` : '연산 클러스터');

    // 머리줄 부가 글 = 지금 상태
    const status = !placed ? '없는 클러스터'
      : !info ? NO_API
        : info.mining ? `채굴 중 · ${def?.ticker ?? ''}`.trim()
          : info.block ?? '대기';
    paintStationMeta(this.shell, status);
    toggleClass(this.shell.meta, 'mn-meta-bad', !info?.mining);

    // 전력 부족 · 비활성은 틀(`paintStationPower`)의 멈춤 배너가 말한다 — 그 배너가 떠 있으면 같은 사유를 두 번 적지 않는다
    paintStationPower(this.shell);
    const powerShown = !!this.shell.powerBanner && !this.shell.powerBanner.hidden;
    const banner = !placed ? '연산 클러스터가 없습니다' : !info ? NO_API : info.mining || powerShown ? null : info.block;
    this.banner.hidden = !banner;
    setText(this.banner, banner ?? '');

    // 코어 칸
    const cores = info?.cores ?? 0;
    const max = info?.maxCores || MAX_CORES;
    setText(this.coreCount, `${cores} / ${max}`);
    toggleClass(this.coresEl, 'is-mining', !!info?.mining);
    this.coreCells.forEach((c, i) => {
      toggleClass(c, 'is-on', i < cores);
      toggleClass(c, 'is-closed', i >= max);
    });
    if (def) this.coresEl.style.setProperty('--cc', def.color); else this.coresEl.style.removeProperty('--cc');

    // 상태 줄
    const s = this.stats;
    const statText = (row: StatRow, text: string, tone: '' | 'good' | 'bad' = ''): void => {
      setText(row.v, text);
      toggleClass(row.v, 'good', tone === 'good');
      toggleClass(row.v, 'bad', tone === 'bad');
    };
    if (!s.coin.v.firstElementChild) { clear(s.coin.v); coinGlyph(s.coin.v, null, 'sm'); el('span', { parent: s.coin.v }); }
    paintCoinGlyph(s.coin.v.firstElementChild as HTMLElement, def);
    setText(s.coin.v.lastElementChild as HTMLElement, def ? `${def.name} (${def.ticker})` : '지정 안 됨');
    const cycle = info && info.cycleMs > 0 ? info.cycleMs : def && cores > 0 ? coinCycleMs(def, cores) : 0;
    statText(s.cycle, !def ? '코인을 고르세요' : cores <= 0 ? '코어가 필요합니다' : fmtDuration(cycle), !def || cores <= 0 ? 'bad' : '');
    s.next.row.hidden = !def || cores >= max;
    if (def && cores < max) statText(s.next, `${fmtDuration(coinCycleMs(def, cores + 1))}`, 'good');
    statText(s.yield, def ? `${formatCoinUnits(def.yieldUnits)} ${def.ticker}` : '—');
    const uph = def && cycle > 0 ? unitsPerHour({ coinId: def.id, cycleMs: cycle }) : 0;
    statText(s.rate, uph > 0 ? `${formatCoinUnits(Math.round(uph))} ${def!.ticker}` : '—');
    const price = def ? livePrice(this.ctx, def.id) : null;
    statText(s.credits, uph > 0 && price !== null ? `≈ ${fmtCredits(unitsValue(price, uph))} 크레딧` : uph > 0 ? '— (서버 시세 없음)' : '—');
    statText(s.power, info ? `${info.power}` : '—');
    let fac: ReturnType<NonNullable<MiningHousing['getFacilityPower']>> = null;
    try { fac = info && h.getFacilityPower ? h.getFacilityPower(info.room) : null; } catch { fac = null; }
    s.facility.row.hidden = !fac;
    if (fac) statText(s.facility, `할당 ${fac.allocated} / 요구 ${fac.required}`, fac.powered ? 'good' : 'bad');

    // 진행 막대 · 시계
    const p = Math.max(0, Math.min(1, info?.progress ?? 0));
    this.progFill.style.transform = `scaleX(${p.toFixed(4)})`;
    toggleClass(this.progFill.parentElement!, 'is-paused', !info?.mining);
    setText(this.progPct, info && (info.mining || p > 0) ? `${Math.floor(p * 100)} %` : '');
    if (info?.mining) renderClock(this.progClock, info.remainingS);
    else renderClockText(this.progClock, info && p > 0 ? '정지됨' : '—');

    // 코인 버튼
    const coins = coinInfos(h, this.ctx);
    for (const btn of this.coinBtns) {
      const c = coins.find((x) => x.def.id === btn.id);
      toggleClass(btn.el, 'is-active', info?.coinId === btn.id);
      toggleClass(btn.el, 'is-locked', !!c && !c.unlocked);
      const cp = c?.price ?? livePrice(this.ctx, btn.id);
      setText(btn.price, cp !== null ? fmtPrice(cp) : '—');
    }

    if (this.hoverCoin && this.tip.isShown) {
      const spec = this.coinTip(this.hoverCoin);
      if (spec) this.tip.update(spec); else this.hideTip();
    }
  }

  override dispose(): void {
    this.stopTicking();
    this.drag.dispose();
    this.ask.close();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}

/** `openComputeCluster(uid)` 의 몸통 — 연산 클러스터가 아니면 토스트. */
export function openComputeClusterScreen(sys: HousingSystem, uid: string): void {
  const screen = sys.clusterScreen;
  if (!screen) return;
  const placed = sys.getPlacedByUid(uid);
  if (!placed || placed.defId !== COMPUTE_CLUSTER_DEF_ID) { sys.notify('연산 클러스터가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  if (screen.isOpen && screen.currentUid === uid) return;
  sys.closeMenus(false);
  screen.openCluster(uid);
}
