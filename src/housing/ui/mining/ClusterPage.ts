import type { ComputeClusterInfo, CryptoCoinInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance, PlacedFurniture } from '@/shared';
import { COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_MAX_CORES, PROCESSOR_DEF_ID, formatCoinUnits, itemGridBox } from '@/shared';
import { clusterCycleMs } from '../../MiningRules';
import type { HousingSystem } from '../../HousingSystem';
import { buildFootprintCells, buildStationItemTile, itemFootprint } from '../ItemTile';
import { ProductDrag } from '../ProductDrag';
import type { Product } from '../ProductDrag';
import { mountStationGrids } from '../StationShell';
import type { StationGridsView } from '../StationShell';
import { clear, el, renderClock, renderClockText, setText, toggleClass } from '../dom';
import { CoinPicker } from './CoinPicker';
import type { MiningHost } from './MiningScreen';
import {
  MiningAsk, clusterOf, coinDef, coinInfos, fmtCredits, fmtDuration, livePrice, unitsPerHour, unitsValue, type MiningHousing,
} from './common';

const MAX_CORES = Math.max(1, Math.floor(COMPUTE_CLUSTER_MAX_CORES));
const NO_API = '채굴 기능을 사용할 수 없습니다';

/**
 * **The item that mounts into a cluster cell** — read in one place only. Since 2026-09-16 (user's decision 「연산 코어를 없애고 프로세서를 직접 껣는다」)
 * it is a **processor** (`mat_processor`, a 2×1 item with durability). The cell size comes from that item's footprint, and a
 * mounted cell's tile carries `ComputeClusterInfo.processors[i]`'s remaining durability as-is (the inventory tile's durability bar).
 */
const SLOT_DEF_ID = PROCESSOR_DEF_ID;
/** One cell edge (px) — a layout constant of the same grain as the furniture screen's grid (`stationGridCell`). The cell box comes from the item footprint. */
const SLOT_CELL_PX = 52;
/** The fingerprint prefix for the drawn shape of an empty · mounted cell (a changed footprint — item data arriving late — redraws it). */
const EMPTY_KEY = 'e:';

interface RailItem { uid: string; el: HTMLElement; dots: HTMLElement[]; red: HTMLElement }
interface StatRow { row: HTMLElement; v: HTMLElement }

/**
 * **The `채굴` tab** (`MiningTab 'cluster'` — the old compute cluster screen, one side of the 2026-09-14 combined window).
 *
 * Top to bottom: **9 processor cells** (item grid cells · centred) → the **`이번 주기`** progress bar → the **`채굴 코인` dropdown + the stat numbers**.
 * The left rail is the ship's list of compute clusters (a name + 9 cell dots · a red dot when stopped), and processors are
 * dragged in from the [함선 창고] [가방] cards on the right.
 *
 * 2026-09-14 (user's decision):
 *  - The cell's shape is decided by the mounted item's **footprint** (a processor is 2×1, so the cell is wide).
 *  - A drop · a double-click · a right-click moves **one at a time**.
 *  - The coin list button row · the guidance text (`.mn-hint` · the footer · 「코인을 바꾸면 진행도가 초기화됩니다」) are gone — the
 *    coin is picked by the **dropdown** (`CoinPicker`) in the stat row, and with progress a 1 s hold warning (`MiningAsk`) says so.
 *
 * 2026-09-16 (user's decision — processors mounted directly): a processor has durability, so it differs from cell to cell. The
 * save and the screen are therefore both a **cell list** (`ComputeClusterSlot.processors`, index = a cell of this grid), and the
 * cell dropped on · the cell picked from is used as-is (`insertClusterProcessor` · `removeClusterProcessor`). A mounted tile
 * carries that cell's durability bar — a worn-out one is not unmounted and runs at half perf, so 「repair it and it speeds up」 has to be visible.
 *
 * Not one rule lives here — every reason comes back from `ctx.housing` (parts/Mining).
 */
export class ClusterPage {
  readonly el: HTMLElement;
  private uid = '';
  private readonly coresEl: HTMLElement;
  private readonly coreCells: HTMLElement[] = [];
  private readonly coreCount: HTMLElement;
  private readonly stats: Record<'cycle' | 'next' | 'yield' | 'rate' | 'credits', StatRow>;
  /** The state last drawn per cell (an empty cell = '' · the durability) — so the `paint` that runs every second does not rebuild the DOM. */
  private readonly cellKeys: string[] = [];
  /** The cell shape (`w×h`) — the footprint last written onto the grid. */
  private cellShape = '';
  private readonly progFill: HTMLElement;
  private readonly progClock: HTMLElement;
  private readonly progPct: HTMLElement;
  private readonly picker: CoinPicker;
  private readonly ask: MiningAsk;
  private readonly drag: ProductDrag;
  private grids: StationGridsView | null = null;
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

    /* Processors — 9 wide cells, centred */
    const coreBox = el('div', { cls: 'mn-corebox', parent: page });
    const coreHead = el('div', { cls: 'mn-sec-head', parent: coreBox });
    el('span', { cls: 'mn-sec-title', text: '프로세서', parent: coreHead });
    this.coreCount = el('span', { cls: 'mn-sec-count', text: `0 / ${MAX_CORES}`, parent: coreHead });
    this.coresEl = el('div', { cls: 'mn-cores', parent: coreBox });
    /* 2026-09-16 (user's decision): a cell is an **item grid cell** — the dedicated drawing (`.mn-core-chip` · the LED) is gone,
       and a mounted cell carries the same tile seen in the bag (`ui/ItemTile`). The cell box is that item's footprint size.
       2026-09-17 (bug): measuring that size **here** gave 1×1 — housing is registered before inventory, so at constructor time
       there is no `ctx.loot`. The footprint is measured by `paint` (`applyCellShape`). */
    for (let i = 0; i < MAX_CORES; i++) {
      this.coreCells.push(el('div', { cls: 'mn-core', attrs: { 'data-core': String(i) }, parent: this.coresEl }));
    }

    /* The `이번 주기` progress bar */
    const prog = el('div', { cls: 'mn-cl-prog', parent: page });
    const progHead = el('div', { cls: 'mn-sec-head', parent: prog });
    el('span', { cls: 'mn-sec-title', text: '이번 주기', parent: progHead });
    this.progPct = el('span', { cls: 'mn-sec-count', text: '', parent: progHead });
    this.progClock = el('span', { cls: 'mn-clock hs-clock', text: '', parent: progHead });
    this.progFill = el('i', { parent: el('div', { cls: 'mn-bar', parent: prog }) });

    /* the `채굴 코인` dropdown + the stat numbers */
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
      next: stat('프로세서 +1'),
      yield: stat('주기당 채굴'),
      rate: stat('시간당 예상'),
      credits: stat('시간당 크레딧'),
    };

    this.ask = new MiningAsk(ctx);
    host.addOverlay(this.ask);
    this.drag = new ProductDrag(this.coresEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.removeCore(Number(key), dest),
      defOf: (id) => housing.defOf(id),
      // 2026-09-16: it goes to **the exact cell** it was dropped on (the grids are built when the screen opens, so they are passed as a function)
      grids: () => this.grids,
    });
    this.coresEl.addEventListener('contextmenu', (e) => {
      if (!(e.target as Element | null)?.closest('.mn-core')) return;
      e.preventDefault(); e.stopPropagation();
      const p = this.productAt(e.target as Element);
      if (p) this.removeCore(Number(p.key), 'bag-first');
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

  /** The compute clusters placed in the ship (in placement order — the rail numbers never shift). */
  private clusters(): readonly PlacedFurniture[] {
    try { return this.housing.getPlaced().filter((p) => p.defId === COMPUTE_CLUSTER_DEF_ID); } catch { return []; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /**
   * A tile from the bag / the stash was dropped on a processor cell (or double-clicked — `target` null).
   * **That exact instance** is mounted into **the cell it was dropped on** (2026-09-16): processors differ in durability, so
   * 「any one into the next empty cell」 is no longer the same result. A double-click named no cell, so it takes the first empty one (`insertClusterCores(uid, 1)`).
   */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (item.defId !== SLOT_DEF_ID) { this.host.denyMsg('프로세서만 꽂을 수 있습니다'); return; }
    const info = this.info();
    if (!info) { this.host.denyMsg('연산 클러스터가 없습니다'); return; }
    if (info.cores >= (info.maxCores || MAX_CORES)) { this.host.denyMsg('프로세서 칸이 가득 찼습니다'); return; }
    const cell = target ? Number(target.dataset.core) : -1;
    const reason = Number.isInteger(cell) && cell >= 0
      ? this.ref.insertClusterProcessor?.call(this.ref, this.uid, cell, item.uid) ?? NO_API
      : this.ref.insertClusterCores?.call(this.ref, this.uid, 1) ?? NO_API;
    if (reason) { this.host.denyMsg(reason); return; }
    this.host.debug.inserts++;
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const after = this.info();
    this.host.showMsg(`프로세서를 꽂았습니다${after && after.cycleMs > 0 ? ` — 채굴 주기 ${fmtDuration(after.cycleMs)}` : ''}`, 'success');
  }

  /** Pulls the processor in cell `cell` — its durability follows it (the route for picking the worn one out and taking it to the workbench). */
  private removeCore(cell: number, dest: HarvestDestination): void {
    const info = this.info();
    if (!info || !Number.isInteger(cell) || info.processors[cell] === null || info.processors[cell] === undefined) return;
    const remove = this.ref.removeClusterProcessor;
    if (typeof remove !== 'function') { this.host.denyMsg(NO_API); return; }
    const reason = remove.call(this.ref, this.uid, cell, dest);
    if (reason) { this.host.denyMsg(reason); return; }
    this.host.debug.removes++;
    this.host.showMsg(`프로세서 1개를 뺐습니다 (${dest === 'bag' || dest === 'bag-first' ? '가방' : '함선 창고'})`, 'info');
  }

  private productAt(target: Element): Product | null {
    const cell = target.closest<HTMLElement>('.mn-core[data-core]');
    if (!cell || !cell.classList.contains('is-on')) return null;
    return { key: cell.dataset.core ?? '', defId: SLOT_DEF_ID, qty: 1 };
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

  /* ── The rail ──────────────────────────────────────────────────────────── */
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
    /* 2026-09-17 (bug: pressing the 「채굴」 tab in a window opened from the main computer gave the 「연산 클러스터가 없습니다」 banner) — that
       path has no cluster uid (`''`) · the chosen cluster may have been recovered. With any cluster in the ship, the **first** one is shown. */
    const placedList = this.clusters();
    if (placedList.length && !placedList.some((p) => p.uid === this.uid)) this.uid = placedList[0].uid;
    if (!this.grids) {
      this.grids = mountStationGrids(this.ctx, this.host.shell.invHost, '.mn-core[data-core]', (item, target) => this.dropOn(item, target));
    }
    const list = placedList;
    const key = list.map((p) => p.uid).join(',');
    if (key !== this.railKey) { this.railKey = key; this.buildRail(list); }
    // the rail is opened once by the tab in `MiningScreen.applyTab`, and closed again here when there is no cluster at all
    this.host.shell.rail.hidden = list.length === 0;
    this.paint();
  }

  /**
   * The cell box = the mounted item's footprint (`--mn-core-w/h`). Item data (`ctx.loot`) arrives later than the constructor, so
   * it is measured every time and written only when it changed (the 1 s tick never shakes the style).
   */
  private applyCellShape(): void {
    const fp = itemFootprint(this.ctx, SLOT_DEF_ID);
    const shape = `${fp.w}x${fp.h}`;
    if (shape === this.cellShape) return;
    this.cellShape = shape;
    const box = itemGridBox(fp.w, fp.h, SLOT_CELL_PX);
    this.coresEl.style.setProperty('--mn-core-w', `${box.width}px`);
    this.coresEl.style.setProperty('--mn-core-h', `${box.height}px`);
  }

  private paint(): void {
    this.paintRail();
    const info = this.info();
    const placed = this.uid ? this.housing.getPlacedByUid(this.uid) : null;
    const def = coinDef(info?.coinId);
    const index = this.clusters().findIndex((p) => p.uid === this.uid);

    /* 2026-09-17 (user's decision): **with no processor at all, nothing is announced** — no red banner (`프로세서를 껣으세요` ·
       `채굴할 코인을 정하세요`) and no red reason in the header row. The empty cell grid says it by itself. The reason itself
       (`info.block`) is still there on the rules side and is read elsewhere (the rail red dot · the status tab). */
    const empty = !!info && info.cores <= 0;
    const status = !placed ? '없는 클러스터'
      : !info ? NO_API
        : info.mining ? `채굴 중 · ${def?.ticker ?? ''}`.trim()
          : empty ? '대기' : info.block ?? '대기';
    this.host.setTitle(index >= 0 ? `연산 클러스터 ${index + 1}` : '연산 클러스터', status, !info?.mining && !empty);
    this.host.setBanner(!placed ? '연산 클러스터가 없습니다' : !info ? NO_API : info.mining || empty ? null : info.block ?? null);
    this.applyCellShape();

    // processor cells — a mounted cell is **the same item tile as in the bag** and carries that cell's durability bar (2026-09-16 user's decision)
    const cores = info?.cores ?? 0;
    const max = info?.maxCores || MAX_CORES;
    const cells = info?.processors ?? [];
    setText(this.coreCount, `${cores} / ${max}`);
    toggleClass(this.coresEl, 'is-mining', !!info?.mining);
    this.coreCells.forEach((c, i) => {
      const dur = cells[i] ?? null;
      const on = dur !== null;
      toggleClass(c, 'is-on', on);
      toggleClass(c, 'is-closed', i >= max);
      // the tile is built **only when the cell's durability changes** (so the `paint` that runs every second does not rebuild the DOM).
      // a mounted cell's hover card (`ui/hud/ItemTip`) comes with the tile's own `data-item-tip`, so the cell attaches nothing.
      // an empty cell is **grid cells the size of the footprint** (2026-09-17 user's decision — a processor is 2×1 = two cells wide, `ui/ItemTile.buildFootprintCells`)
      const key = on ? String(dur) : EMPTY_KEY + this.cellShape;
      if (this.cellKeys[i] === key) return;
      this.cellKeys[i] = key;
      clear(c);
      if (on) c.appendChild(buildStationItemTile(this.ctx, SLOT_DEF_ID, { cell: SLOT_CELL_PX, durability: dur }));
      else {
        const fp = itemFootprint(this.ctx, SLOT_DEF_ID);
        c.appendChild(buildFootprintCells(fp.w, fp.h, SLOT_CELL_PX));
      }
    });
    if (def) this.coresEl.style.setProperty('--cc', def.color); else this.coresEl.style.removeProperty('--cc');

    // the progress bar · the clock
    const p = Math.max(0, Math.min(1, info?.progress ?? 0));
    this.progFill.style.transform = `scaleX(${p.toFixed(4)})`;
    toggleClass(this.progFill.parentElement!, 'is-paused', !info?.mining);
    setText(this.progPct, info && (info.mining || p > 0) ? `${Math.floor(p * 100)} %` : '');
    if (info?.mining) renderClock(this.progClock, info.remainingS);
    else renderClockText(this.progClock, info && p > 0 ? '정지됨' : '—');

    // the `채굴 코인` dropdown + the stat numbers
    this.picker.paint();
    const s = this.stats;
    const statText = (row: StatRow, text: string, tone: '' | 'good' | 'bad' = ''): void => {
      setText(row.v, text);
      toggleClass(row.v, 'good', tone === 'good');
      toggleClass(row.v, 'bad', tone === 'bad');
    };
    /* The cycle comes from the **perf sum** (`ComputeClusterInfo.perf`), not the count — 「프로세서 +1」 is mounting **one more new one**
       (adding a worn-out one is half of that, and the new-one figure is the number a person expects). */
    const perf = info?.perf ?? 0;
    const cycle = info && info.cycleMs > 0 ? info.cycleMs : def && perf > 0 ? clusterCycleMs(def, perf) : 0;
    // 2026-09-17: with no processor it is `—` and no guidance text (an empty cluster asks for nothing)
    statText(s.cycle, cores <= 0 ? '—' : !def ? '코인을 고르세요' : fmtDuration(cycle), cores > 0 && !def ? 'bad' : '');
    s.next.row.hidden = !def || cores >= max;
    if (def && cores < max) statText(s.next, `${fmtDuration(clusterCycleMs(def, perf + 1))}`, 'good');
    statText(s.yield, def ? `${formatCoinUnits(def.yieldUnits)} ${def.ticker}` : '—');
    const uph = def && cycle > 0 ? unitsPerHour({ coinId: def.id, cycleMs: cycle }) : 0;
    statText(s.rate, uph > 0 ? `${formatCoinUnits(Math.round(uph))} ${def!.ticker}` : '—');
    const price = def ? livePrice(this.ctx, def.id) : null;
    statText(s.credits, uph > 0 && price !== null ? `≈ ${fmtCredits(unitsValue(price, uph))} 크레딧` : uph > 0 ? '— (서버 시세 없음)' : '—');
  }
}
