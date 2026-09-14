import type { ComputeClusterInfo, CryptoCoinInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance, PlacedFurniture } from '@/shared';
import { COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, COMPUTE_CORE_DEF_ID, coinCycleMs, formatCoinUnits } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { ProductDrag } from '../ProductDrag';
import type { Product } from '../ProductDrag';
import { mountStationGrids } from '../StationShell';
import { clear, el, renderClock, renderClockText, setText, toggleClass } from '../dom';
import { CoinPicker } from './CoinPicker';
import type { MiningHost } from './MiningScreen';
import {
  MiningAsk, clusterOf, coinDef, coinInfos, fmtCredits, fmtDuration, livePrice, unitsPerHour, unitsValue, type MiningHousing,
} from './common';

const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const NO_API = '채굴 기능을 사용할 수 없습니다';

interface RailItem { uid: string; el: HTMLElement; dots: HTMLElement[]; red: HTMLElement }
interface StatRow { row: HTMLElement; v: HTMLElement }

/**
 * **채굴 탭** (`MiningTab 'cluster'` — 옛 연산 클러스터 화면, 2026-09-14 통합 창의 한 쪽).
 *
 * 위에서 아래로: **코어 9칸**(가로로 긴 칸 · 중앙 정렬) → **이번 주기** 진행 막대 → **채굴 코인 드롭다운 + 현황 수치**.
 * 왼쪽 레일은 함선의 연산 클러스터 목록(이름 + 코어 점 9개 · 멈췄으면 레드닷)이고, 오른쪽 [함선 창고] [가방]
 * 카드에서 연산 코어를 끌어 온다.
 *
 * 2026-09-14 (사용자 결정):
 *  - 코어 아이템이 **2×1** 이 되어 칸도 가로로 길다.
 *  - 드롭 · 더블클릭 · 우클릭은 **한 개씩** 옮긴다 (`insertClusterCores(uid, 1)` · `removeClusterCores(uid, 1, dest)`).
 *    세이브(`ComputerClusterSlot.cores`)는 **개수 하나**라 꽂힌 칸은 늘 앞에서부터 n칸이다 — 어느 빈 칸에 놓아도
 *    다음 빈 칸이 켜진다.
 *  - 코인 목록 버튼 줄 · 안내문(`.mn-hint` · 푸터 · 「코인을 바꾸면 진행도가 초기화됩니다」)은 없어졌다 — 코인은
 *    현황 칸의 **드롭다운**(`CoinPicker`)이 고르고, 진행도가 있으면 1초 홀드 경고(`MiningAsk`)가 그것을 말한다.
 *
 * 규칙은 하나도 여기 없다 — 사유는 전부 `ctx.housing`(parts/Mining)이 돌려준다.
 */
export class ClusterPage {
  readonly el: HTMLElement;
  private uid = '';
  private readonly coresEl: HTMLElement;
  private readonly coreCells: HTMLElement[] = [];
  private readonly coreCount: HTMLElement;
  private readonly stats: Record<'cycle' | 'next' | 'yield' | 'rate' | 'credits', StatRow>;
  private readonly progFill: HTMLElement;
  private readonly progClock: HTMLElement;
  private readonly progPct: HTMLElement;
  private readonly picker: CoinPicker;
  private readonly ask: MiningAsk;
  private readonly drag: ProductDrag;
  private grids: EmbeddedView | null = null;
  private railItems: RailItem[] = [];
  private railKey = '';
  private active = false;

  constructor(
    private readonly ctx: GameContext,
    private readonly housing: HousingSystem,
    private readonly host: MiningHost,
  ) {
    const page = this.el = el('div', { cls: 'mn-page mn-cl', attrs: { 'data-page': 'cluster' }, parent: host.shell.left });
    host.shell.rail.addEventListener('click', (e) => this.onRailClick(e));

    /* 연산 코어 — 가로로 긴 칸 9개, 중앙 정렬 */
    const coreBox = el('div', { cls: 'mn-corebox', parent: page });
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

    /* 이번 주기 */
    const prog = el('div', { cls: 'mn-cl-prog', parent: page });
    const progHead = el('div', { cls: 'mn-sec-head', parent: prog });
    el('span', { cls: 'mn-sec-title', text: '이번 주기', parent: progHead });
    this.progPct = el('span', { cls: 'mn-sec-count', text: '', parent: progHead });
    this.progClock = el('span', { cls: 'mn-clock hs-clock', text: '', parent: progHead });
    this.progFill = el('i', { parent: el('div', { cls: 'mn-bar', parent: prog }) });

    /* 채굴 코인 드롭다운 + 현황 수치 */
    const statBox = el('div', { cls: 'mn-stats', parent: page });
    const coinRow = el('div', { cls: 'mn-stat mn-stat-coin', parent: statBox });
    el('span', { cls: 'k', text: '채굴 코인', parent: coinRow });
    const coinVal = el('span', { cls: 'v', parent: coinRow });
    this.picker = new CoinPicker(coinVal, {
      coins: () => this.coins(),
      current: () => this.info()?.coinId ?? null,
      pick: (id) => (id === null ? this.clearCoin() : this.selectCoin(id)),
      denyLocked: (reason) => this.host.denyMsg(reason),
    });
    host.addOverlay(this.picker);
    const stat = (k: string): StatRow => {
      const row = el('div', { cls: 'mn-stat', parent: statBox });
      el('span', { cls: 'k', text: k, parent: row });
      return { row, v: el('span', { cls: 'v', text: '—', parent: row }) };
    };
    this.stats = {
      cycle: stat('채굴 주기'),
      next: stat('코어 +1'),
      yield: stat('주기당 채굴'),
      rate: stat('시간당 예상'),
      credits: stat('시간당 크레딧'),
    };

    this.ask = new MiningAsk(ctx);
    host.addOverlay(this.ask);
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
  }

  /** Bus subscriptions the panel owns (pushed into its `unsubs`). */
  bind(): Array<() => void> {
    const b = this.ctx.bus;
    const hit = (): void => { if (this.active && this.host.isOpen) this.host.refreshLater(); };
    return [
      b.on('housing:clusterChanged', hit),
      b.on('housing:cryptoMined', hit),
      b.on('net:cryptoPrices', hit),
    ];
  }

  private get ref(): MiningHousing { return this.housing; }

  get currentUid(): string { return this.uid; }
  setUid(uid: string): void { this.uid = uid; }

  setActive(on: boolean): void {
    this.active = on;
    this.el.hidden = !on;
    if (on) return;
    this.picker.close();
    this.ask.close();
    this.drag.end();
  }

  onClose(): void {
    this.picker.close();
    this.ask.close();
    this.drag.end();
    this.grids?.dispose();
    this.grids = null;
  }

  dispose(): void {
    this.drag.dispose();
    this.picker.dispose();
    this.ask.close();
    this.grids?.dispose();
    this.grids = null;
  }

  tick(): void { this.paint(); }

  /* ── state helpers ─────────────────────────────────────────────────────── */
  private info(): ComputeClusterInfo | null {
    return this.uid ? clusterOf(this.ref, this.uid) : null;
  }

  private coins(): CryptoCoinInfo[] { return coinInfos(this.ref, this.ctx); }

  /** 함선에 놓인 연산 클러스터 (배치 순서 그대로 — 레일 번호가 흔들리지 않는다). */
  private clusters(): readonly PlacedFurniture[] {
    try { return this.housing.getPlaced().filter((p) => p.defId === COMPUTE_CLUSTER_DEF_ID); } catch { return []; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /**
   * 가방 / 창고의 타일을 코어 칸에 놓았다 (또는 더블클릭 — `target` null).
   * **한 번에 하나**다 (2026-09-14 사용자 결정): 세이브가 개수 하나라 꽂힌 칸은 늘 앞에서부터이므로, 어느 빈 칸에
   * 놓아도 다음 빈 칸이 켜진다.
   */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.host.showMsg('연산 코어를 코어 칸으로 끌어다 놓으세요', 'info'); return; }
    if (item.defId !== COMPUTE_CORE_DEF_ID) { this.host.denyMsg('연산 코어만 꽂을 수 있습니다'); return; }
    const info = this.info();
    if (!info) { this.host.denyMsg('연산 클러스터가 없습니다'); return; }
    if (info.cores >= (info.maxCores || MAX_CORES)) { this.host.denyMsg('코어 칸이 가득 찼습니다'); return; }
    const insert = this.ref.insertClusterCores;
    if (typeof insert !== 'function') { this.host.denyMsg(NO_API); return; }
    const reason = insert.call(this.ref, this.uid, 1);
    if (reason) { this.host.denyMsg(reason); return; }
    this.host.debug.inserts++;
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const after = this.info();
    this.host.showMsg(`연산 코어를 꽂았습니다${after && after.cycleMs > 0 ? ` — 채굴 주기 ${fmtDuration(after.cycleMs)}` : ''}`, 'success');
  }

  private removeCore(dest: HarvestDestination): void {
    const info = this.info();
    if (!info || info.cores <= 0) return;
    const remove = this.ref.removeClusterCores;
    if (typeof remove !== 'function') { this.host.denyMsg(NO_API); return; }
    const reason = remove.call(this.ref, this.uid, 1, dest);
    if (reason) { this.host.denyMsg(reason); return; }
    this.host.debug.removes++;
    this.host.showMsg(`연산 코어 1개를 뺐습니다 (${dest === 'bag' || dest === 'bag-first' ? '가방' : '함선 창고'})`, 'info');
  }

  private productAt(target: Element): Product | null {
    const cell = target.closest<HTMLElement>('.mn-core[data-core]');
    if (!cell || !cell.classList.contains('is-on')) return null;
    return { key: 'core', defId: COMPUTE_CORE_DEF_ID, qty: 1 };
  }

  private selectCoin(id: string): void {
    const coin = this.coins().find((c) => c.def.id === id) ?? null;
    if (!coin) return;
    if (!coin.unlocked) { this.host.denyMsg(coin.lockReason ?? '잠긴 코인입니다'); return; }
    const info = this.info();
    if (!info) { this.host.denyMsg('연산 클러스터가 없습니다'); return; }
    if (info.coinId === id) return;
    const old = coinDef(info.coinId);
    if (old && info.progress > 0) {
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
    if (typeof set !== 'function') { this.host.denyMsg(NO_API); return; }
    const reason = set.call(this.ref, this.uid, id);
    if (reason) { this.host.denyMsg(reason); return; }
    this.host.debug.coinSets++;
    const def = coinDef(id);
    this.host.showMsg(def ? `${def.name} (${def.ticker}) 채굴을 시작합니다` : '채굴 코인을 해제했습니다', 'success');
  }

  private clearCoin(): void {
    const info = this.info();
    if (!info?.coinId) return;
    if (info.progress > 0) {
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
    this.host.debug.rails++;
    const rail = this.host.shell.rail;
    clear(rail);
    this.railItems = [];
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
    if (!this.active) return;
    const uid = (e.target as Element | null)?.closest<HTMLElement>('.hs-rail-item')?.dataset.uid;
    if (!uid || uid === this.uid) return;
    e.stopPropagation();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.picker.close();
    this.drag.end();
    this.ask.close();
    this.uid = uid;
    this.refresh();
    this.ctx.bus.emit('ui:miningToggled', { open: true, uid, page: 'cluster' });
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    if (!this.grids) {
      this.grids = mountStationGrids(this.ctx, this.host.shell.invHost, '.mn-core[data-core]', (item, target) => this.dropOn(item, target));
    }
    const list = this.clusters();
    const key = list.map((p) => p.uid).join(',');
    if (key !== this.railKey) { this.railKey = key; this.buildRail(list); }
    // 레일은 `MiningScreen.applyTab` 이 탭으로 한 번 열고, 클러스터가 하나도 없으면 여기서 다시 닫는다
    this.host.shell.rail.hidden = list.length === 0;
    this.paint();
  }

  private paint(): void {
    this.paintRail();
    const info = this.info();
    const placed = this.uid ? this.housing.getPlacedByUid(this.uid) : null;
    const def = coinDef(info?.coinId);
    const index = this.clusters().findIndex((p) => p.uid === this.uid);

    const status = !placed ? '없는 클러스터'
      : !info ? NO_API
        : info.mining ? `채굴 중 · ${def?.ticker ?? ''}`.trim()
          : info.block ?? '대기';
    this.host.setTitle(index >= 0 ? `연산 클러스터 ${index + 1}` : '연산 클러스터', status, !info?.mining);
    this.host.setBanner(!placed ? '연산 클러스터가 없습니다' : !info ? NO_API : info.mining ? null : info.block ?? null);

    // 코어 칸 — 꽂힌 칸에는 아이템 호버 카드(`ui/hud/ItemTip` 이 `[data-item-tip][data-def-id]` 를 본다)
    const cores = info?.cores ?? 0;
    const max = info?.maxCores || MAX_CORES;
    setText(this.coreCount, `${cores} / ${max}`);
    toggleClass(this.coresEl, 'is-mining', !!info?.mining);
    this.coreCells.forEach((c, i) => {
      const on = i < cores;
      toggleClass(c, 'is-on', on);
      toggleClass(c, 'is-closed', i >= max);
      if (on) { c.dataset.itemTip = ''; c.dataset.defId = COMPUTE_CORE_DEF_ID; }
      else { delete c.dataset.itemTip; delete c.dataset.defId; }
    });
    if (def) this.coresEl.style.setProperty('--cc', def.color); else this.coresEl.style.removeProperty('--cc');

    // 진행 막대 · 시계
    const p = Math.max(0, Math.min(1, info?.progress ?? 0));
    this.progFill.style.transform = `scaleX(${p.toFixed(4)})`;
    toggleClass(this.progFill.parentElement!, 'is-paused', !info?.mining);
    setText(this.progPct, info && (info.mining || p > 0) ? `${Math.floor(p * 100)} %` : '');
    if (info?.mining) renderClock(this.progClock, info.remainingS);
    else renderClockText(this.progClock, info && p > 0 ? '정지됨' : '—');

    // 채굴 코인 드롭다운 + 현황 수치
    this.picker.paint();
    const s = this.stats;
    const statText = (row: StatRow, text: string, tone: '' | 'good' | 'bad' = ''): void => {
      setText(row.v, text);
      toggleClass(row.v, 'good', tone === 'good');
      toggleClass(row.v, 'bad', tone === 'bad');
    };
    const cycle = info && info.cycleMs > 0 ? info.cycleMs : def && cores > 0 ? coinCycleMs(def, cores) : 0;
    statText(s.cycle, !def ? '코인을 고르세요' : cores <= 0 ? '코어가 필요합니다' : fmtDuration(cycle), !def || cores <= 0 ? 'bad' : '');
    s.next.row.hidden = !def || cores >= max;
    if (def && cores < max) statText(s.next, `${fmtDuration(coinCycleMs(def, cores + 1))}`, 'good');
    statText(s.yield, def ? `${formatCoinUnits(def.yieldUnits)} ${def.ticker}` : '—');
    const uph = def && cycle > 0 ? unitsPerHour({ coinId: def.id, cycleMs: cycle }) : 0;
    statText(s.rate, uph > 0 ? `${formatCoinUnits(Math.round(uph))} ${def!.ticker}` : '—');
    const price = def ? livePrice(this.ctx, def.id) : null;
    statText(s.credits, uph > 0 && price !== null ? `≈ ${fmtCredits(unitsValue(price, uph))} 크레딧` : uph > 0 ? '— (서버 시세 없음)' : '—');
  }
}
