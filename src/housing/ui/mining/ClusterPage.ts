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
 * **클러스터 칸에 꽂는 아이템** — 한 곳에서만 읽는다. 2026-09-16 (사용자 결정 「연산 코어를 없애고 프로세서를 직접 꽂는다」)
 * 부터 **프로세서**(`mat_processor`, 내구도를 갖는 2×1 아이템)다. 칸 크기는 그 아이템의 발자국에서 나오고,
 * 꽂힌 칸의 타일은 `ComputeClusterInfo.processors[i]` 의 남은 내구도를 그대로 들고 선다 (인벤토리 타일의 내구도 막대).
 */
const SLOT_DEF_ID = PROCESSOR_DEF_ID;
/** 칸 한 변(px) — 가구 화면의 격자(`stationGridCell`)와 같은 결의 배치 상수. 칸 상자는 아이템 발자국에서 나온다. */
const SLOT_CELL_PX = 52;
/** 빈 칸 · 꽂힌 칸을 그린 모양의 기억 열쇠 접두사 (발자국이 바뀌면 — 아이템 데이터가 늦게 붙으면 — 다시 그린다). */
const EMPTY_KEY = 'e:';

interface RailItem { uid: string; el: HTMLElement; dots: HTMLElement[]; red: HTMLElement }
interface StatRow { row: HTMLElement; v: HTMLElement }

/**
 * **채굴 탭** (`MiningTab 'cluster'` — 옛 연산 클러스터 화면, 2026-09-14 통합 창의 한 쪽).
 *
 * 위에서 아래로: **프로세서 9칸**(아이템 격자 칸 · 중앙 정렬) → **이번 주기** 진행 막대 → **채굴 코인 드롭다운 + 현황 수치**.
 * 왼쪽 레일은 함선의 연산 클러스터 목록(이름 + 칸 점 9개 · 멈췄으면 레드닷)이고, 오른쪽 [함선 창고] [가방]
 * 카드에서 프로세서를 끌어 온다.
 *
 * 2026-09-14 (사용자 결정):
 *  - 칸의 모양은 꽂는 아이템의 **발자국**이 정한다 (프로세서 2×1 이라 가로로 긴 칸).
 *  - 드롭 · 더블클릭 · 우클릭은 **한 개씩** 옮긴다.
 *  - 코인 목록 버튼 줄 · 안내문(`.mn-hint` · 푸터 · 「코인을 바꾸면 진행도가 초기화됩니다」)은 없어졌다 — 코인은
 *    현황 칸의 **드롭다운**(`CoinPicker`)이 고르고, 진행도가 있으면 1초 홀드 경고(`MiningAsk`)가 그것을 말한다.
 *
 * 2026-09-16 (사용자 결정 — 프로세서 직접 장착): 프로세서에는 내구도가 있어 칸마다 다르다. 그래서 세이브도 화면도
 * **칸 목록**(`ComputeClusterSlot.processors`, 인덱스 = 이 격자의 칸)이고, 놓은 칸 · 집은 칸이 그대로 쓰인다
 * (`insertClusterProcessor` · `removeClusterProcessor`). 꽂힌 타일에는 그 칸의 내구도 막대가 선다 — 다 닳아도
 * 빠지지 않고 절반 성능으로 돌므로, 「고쳐야 빨라진다」가 눈에 보여야 한다.
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
  /** 칸마다 마지막으로 그린 상태 (`빈 칸` = '' · `내구도`) — 1초마다 도는 `paint` 가 DOM 을 다시 만들지 않게. */
  private readonly cellKeys: string[] = [];
  /** 칸 모양(`w×h`) — 마지막으로 격자에 쓴 발자국. */
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

    /* 프로세서 — 가로로 긴 칸 9개, 중앙 정렬 */
    const coreBox = el('div', { cls: 'mn-corebox', parent: page });
    const coreHead = el('div', { cls: 'mn-sec-head', parent: coreBox });
    el('span', { cls: 'mn-sec-title', text: '프로세서', parent: coreHead });
    this.coreCount = el('span', { cls: 'mn-sec-count', text: `0 / ${MAX_CORES}`, parent: coreHead });
    this.coresEl = el('div', { cls: 'mn-cores', parent: coreBox });
    /* 2026-09-16 (사용자 결정): 칸은 **아이템 격자 칸**이다 — 전용 그림(`.mn-core-chip` · LED)을 걷어내고, 꽂힌
       칸에는 가방에서 보던 타일이 그대로 선다 (`ui/ItemTile`). 칸 상자는 그 아이템의 발자국 크기다.
       2026-09-17 (버그): 그 크기를 **여기서** 재면 1×1 이었다 — housing 은 inventory 보다 먼저 등록되어 생성자 시점에
       `ctx.loot` 이 없다. 발자국은 `paint` 가 잰다 (`applyCellShape`). */
    for (let i = 0; i < MAX_CORES; i++) {
      this.coreCells.push(el('div', { cls: 'mn-core', attrs: { 'data-core': String(i) }, parent: this.coresEl }));
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
      // 2026-09-16: 빼서 놓은 **그 칸**으로 간다 (격자는 화면이 열릴 때 만들어지므로 함수로 준다)
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

  /** 함선에 놓인 연산 클러스터 (배치 순서 그대로 — 레일 번호가 흔들리지 않는다). */
  private clusters(): readonly PlacedFurniture[] {
    try { return this.housing.getPlaced().filter((p) => p.defId === COMPUTE_CLUSTER_DEF_ID); } catch { return []; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /**
   * 가방 / 창고의 타일을 프로세서 칸에 놓았다 (또는 더블클릭 — `target` null).
   * **놓은 그 칸**에, **끌어온 그 인스턴스**를 꽂는다 (2026-09-16): 프로세서는 내구도가 저마다 달라 「아무거나 다음 빈 칸」이
   * 더 이상 같은 결과가 아니다. 더블클릭은 칸을 고르지 않았으므로 첫 빈 칸이다 (`insertClusterCores(uid, 1)`).
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

  /** `cell` 칸의 프로세서를 뺀다 — 내구도는 그대로 따라간다 (닳은 것을 골라 빼서 작업대로 가져가는 길). */
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
    /* 2026-09-17 (버그: 메인 컴퓨터로 연 창에서 「채굴」 탭을 누르면 「연산 클러스터가 없습니다」 배너) — 그 길에는
       클러스터 uid 가 없다(`''`) · 고른 클러스터가 회수됐을 수도 있다. 함선에 클러스터가 있으면 **첫 번째**를 보여 준다. */
    const placedList = this.clusters();
    if (placedList.length && !placedList.some((p) => p.uid === this.uid)) this.uid = placedList[0].uid;
    if (!this.grids) {
      this.grids = mountStationGrids(this.ctx, this.host.shell.invHost, '.mn-core[data-core]', (item, target) => this.dropOn(item, target));
    }
    const list = placedList;
    const key = list.map((p) => p.uid).join(',');
    if (key !== this.railKey) { this.railKey = key; this.buildRail(list); }
    // 레일은 `MiningScreen.applyTab` 이 탭으로 한 번 열고, 클러스터가 하나도 없으면 여기서 다시 닫는다
    this.host.shell.rail.hidden = list.length === 0;
    this.paint();
  }

  /**
   * 칸 상자 = 꽂는 아이템의 발자국 (`--mn-core-w/h`). 아이템 데이터(`ctx.loot`)는 생성자보다 늦게 붙으므로 매번 재고,
   * 바뀐 때만 쓴다 (1 초 틱이 스타일을 흔들지 않는다).
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

    /* 2026-09-17 (사용자 결정): **프로세서가 하나도 없으면 아무 안내도 하지 않는다** — 빨간 배너(`프로세서를 꽂으세요` ·
       `채굴할 코인을 정하세요`)도, 머리줄의 빨간 사유도 없다. 빈 칸 격자가 스스로 말한다. 사유 자체(`info.block`)는
       규칙 쪽에 그대로 있고 다른 곳(레일 레드닷 · 현황 탭)이 읽는다. */
    const empty = !!info && info.cores <= 0;
    const status = !placed ? '없는 클러스터'
      : !info ? NO_API
        : info.mining ? `채굴 중 · ${def?.ticker ?? ''}`.trim()
          : empty ? '대기' : info.block ?? '대기';
    this.host.setTitle(index >= 0 ? `연산 클러스터 ${index + 1}` : '연산 클러스터', status, !info?.mining && !empty);
    this.host.setBanner(!placed ? '연산 클러스터가 없습니다' : !info ? NO_API : info.mining || empty ? null : info.block ?? null);
    this.applyCellShape();

    // 프로세서 칸 — 꽂힌 칸은 **가방과 같은 아이템 타일**이고 그 칸의 내구도 막대를 들고 선다 (2026-09-16 사용자 결정)
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
      // 타일은 **칸의 내구도가 바뀔 때만** 짓는다 (1 초마다 도는 `paint` 가 DOM 을 다시 만들지 않게).
      // 꽂힌 칸의 호버 카드(`ui/hud/ItemTip`)는 타일이 `data-item-tip` 을 달고 오므로 칸은 아무것도 달지 않는다.
      // 빈 칸은 **발자국만큼의 격자 칸**이다 (2026-09-17 사용자 결정 — 프로세서 2×1 = 가로 두 칸, `ui/ItemTile.buildFootprintCells`)
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
    /* 주기는 개수가 아니라 **성능 합**(`ComputeClusterInfo.perf`)에서 난다 — 「프로세서 +1」은 **새것 한 개**를 더 꽂았을 때다
       (다 닳은 것을 더하면 그 절반이라, 새것 기준이 사람이 기대하는 수치다). */
    const perf = info?.perf ?? 0;
    const cycle = info && info.cycleMs > 0 ? info.cycleMs : def && perf > 0 ? clusterCycleMs(def, perf) : 0;
    // 2026-09-17: 프로세서가 없으면 안내 문구 없이 `—` (빈 클러스터는 아무것도 요구하지 않는다)
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
