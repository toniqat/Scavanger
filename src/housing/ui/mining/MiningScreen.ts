import type { GameContext, MiningComputerTab, MiningTab } from '@/shared';
import { COMPUTE_CLUSTER_DEF_ID, MINING_COMPUTER_DEF_ID, MINING_TABS, MINING_TAB_LABEL_KO } from '@/shared';
import type { HousingSystem } from '../../HousingSystem';
import { HousingPanel } from '../Panel';
import type { PanelOverlay } from '../Panel';
import { buildStationShell } from '../StationShell';
import type { StationShell } from '../StationShell';
import { el, setText, toggleClass } from '../dom';
import { ClusterPage } from './ClusterPage';
import { ComputerPages } from './ComputerPages';
import type { MiningHousing } from './common';

const TICK_MS = 1000;

/** One counter shared by the four pages (smoke tests · performance measurement). */
export interface MiningDebug {
  paints: number; tabSets: number;
  /* the `채굴` tab */ rails: number; inserts: number; removes: number; coinSets: number;
  /* the computer tabs */ watches: number; unwatches: number; requests: number; trades: number; chartPaints: number;
}

/**
 * Everything a page asks of the window (the panel) — a page is not a `HousingPanel` but **one side inside this window**.
 * The window opens `HousingPanel`'s protected helpers (`button` · `deny` · `overlays`) in this shape.
 */
export interface MiningHost {
  readonly shell: StationShell;
  readonly isOpen: boolean;
  readonly debug: MiningDebug;
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger'): void;
  denyMsg(reason: string): void;
  addOverlay(o: PanelOverlay): void;
  /** The header row's title · sub-text (a page paints its own). */
  setTitle(text: string, meta: string, bad?: boolean): void;
  /** The red banner at the top of the left panel (null = hidden). */
  setBanner(text: string | null): void;
  setTab(tab: MiningTab): void;
  /** The redraw a bus event calls — the window folds several events of one call stack into one (`coalesceRefresh`). */
  refreshLater(): void;
  /** Clicking a status row → that cluster's `채굴` tab. */
  openCluster(uid: string): void;
}

/**
 * **The mining screen** (2026-09-14, user's decision — the compute cluster screen and the main computer screen merged into **one window**).
 *
 * Four horizontal tabs at the top of the screen (`MINING_TABS` — `채굴` · `클러스터 현황` · `지갑` · `거래소`, of the same grain
 * as the 인벤토리/캐릭터 Tab screens' `nav.scr-tabs > button.scr-tab`) swap the card layout of one `StationShell`:
 *  - **`채굴`** (`ClusterPage`) — the left rail = the ship's list of compute clusters · 9 processor cells · `이번 주기` · the
 *    `채굴 코인` dropdown + the stat numbers, and the [함선 창고] [가방] cards. The grid cards and the rail show on this tab only.
 *  - **`클러스터 현황` · `지갑` · `거래소`** (`ComputerPages`) — the old main computer's three pages as they were.
 *
 * The **default tab an E on the furniture opens is that furniture's tab** (user's decision): a compute cluster → `'cluster'`, the
 * main computer → `'clusters'`. The old entry-point names (`openComputeCluster` · `openMiningComputer`) are a contract and stay; only the default tab differs.
 */
export class MiningScreen extends HousingPanel {
  readonly shell: StationShell;
  readonly cluster: ClusterPage;
  readonly computer: ComputerPages;
  readonly debug: MiningDebug = {
    paints: 0, tabSets: 0, rails: 0, inserts: 0, removes: 0, coinSets: 0,
    watches: 0, unwatches: 0, requests: 0, trades: 0, chartPaints: 0,
  };
  private tab: MiningTab = 'cluster';
  private readonly tabBtns = new Map<MiningTab, HTMLButtonElement>();
  private readonly banner: HTMLElement;
  private timer = 0;

  constructor(ctx: GameContext, housing: HousingSystem) {
    // `HousingPage` is a contract, so no value is added to it — the combined window keeps the old `'cluster'` name
    super(ctx, 'cluster', 'mining-screen hs-station');
    this.coalesceRefresh = true;

    /* 2026-09-17 (user's decision): the tab row sits in **the same place** as on the Tab screens — the same `.scr-tabs`, attached
       to the screen root rather than the frame (absolute, `top: 22px`, `ui/styles/base.css`). The frame starts below it (`mining.css`). */
    const tabs = el('nav', { cls: 'scr-tabs mn-tabs', parent: this.root });
    for (const id of MINING_TABS) {
      const b = el('button', { cls: 'scr-tab mn-tab', text: MINING_TAB_LABEL_KO[id], attrs: { 'data-tab': id }, parent: tabs });
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.tab === id) return;
        ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.setTab(id);
      });
      this.tabBtns.set(id, b);
    }

    this.shell = buildStationShell(this.frame, {
      title: '채굴',
      upgrade: false,
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    this.banner = el('div', { cls: 'mn-banner', parent: this.shell.left });
    this.banner.hidden = true;

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const host: MiningHost = {
      shell: this.shell,
      debug: this.debug,
      get isOpen() { return self.isOpen; },
      showMsg: (t, k) => this.showMsg(t, k),
      denyMsg: (r) => this.deny(r),
      addOverlay: (o) => { this.overlays.push(o); },
      setTitle: (text, meta, bad) => this.paintHead(text, meta, !!bad),
      setBanner: (text) => this.setBanner(text),
      setTab: (t) => this.setTab(t),
      refreshLater: () => this.refreshIfOpen(),
      openCluster: (uid) => this.openMining(uid, 'cluster'),
    };

    this.cluster = new ClusterPage(ctx, housing, host);
    this.computer = new ComputerPages(ctx, housing, host);
    this.unsubs.push(...this.cluster.bind(), ...this.computer.bind());

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'left', parent: foot });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.applyTab('cluster');
  }

  /* ── Tabs ──────────────────────────────────────────────────────────────── */
  get currentTab(): MiningTab { return this.tab; }
  /** The old `MiningComputer.selectedCoin` (the `거래소` tab's coin) — read by the smoke tests · the console. */
  get selectedCoin(): string { return this.computer.selectedCoin; }
  /** The old `ClusterScreen.currentUid` (the `채굴` tab's cluster). */
  get currentUid(): string { return this.cluster.currentUid; }
  get chart(): ComputerPages['chart'] { return this.computer.chart; }
  /** The main computer furniture changed (E was pressed on another computer) — the banner looks at that furniture. */
  setComputerUid(uid: string): void { this.computer.setUid(uid); }

  /** Swaps the DOM only (no refresh) — used just before opening too. */
  private applyTab(id: MiningTab): void {
    this.tab = MINING_TABS.includes(id) ? id : 'cluster';
    const onCluster = this.tab === 'cluster';
    for (const [k, b] of this.tabBtns) toggleClass(b, 'is-on', k === this.tab);
    this.cluster.setActive(onCluster);
    this.computer.setActive(onCluster ? null : (this.tab as MiningComputerTab));
    this.shell.rail.hidden = !onCluster;
    this.shell.right.hidden = !onCluster;
    toggleClass(this.root, 'is-cluster', onCluster);
  }

  setTab(id: MiningTab): void {
    const before = this.tab;
    this.applyTab(id);
    if (before !== this.tab) this.debug.tabSets++;
    if (!this.isOpen) return;
    this.refresh();
    this.ctx.bus.emit('ui:miningToggled', { open: true, uid: this.activeUid(), page: this.wirePage() });
  }

  /** `ui:miningToggled`'s `page` is a contract, so there are only two — the `채굴` tab is `'cluster'`, the other three `'computer'`. */
  private wirePage(): 'cluster' | 'computer' { return this.tab === 'cluster' ? 'cluster' : 'computer'; }
  private activeUid(): string | null {
    return this.tab === 'cluster' ? this.cluster.currentUid || null : this.computer.currentUid;
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** `uid` = the furniture pressed. On the `채굴` tab that compute cluster, on the other tabs that main computer. */
  openMining(uid: string, tab: MiningTab): void {
    if (tab === 'cluster') this.cluster.setUid(uid); else this.computer.setUid(uid);
    this.applyTab(tab);
    this.openPanel();                       // → refresh()
    this.startTicking();
    this.ctx.bus.emit('ui:miningToggled', { open: true, uid, page: this.wirePage() });
  }

  override close(relock = true): void {
    const was = this.isOpen;
    const page = this.wirePage();
    const uid = this.activeUid();
    this.stopTicking();
    this.cluster.onClose();
    this.computer.onClose();
    super.close(relock);
    this.computer.syncWatch();              // the window closed, so the price subscription is released
    if (was) this.ctx.bus.emit('ui:miningToggled', { open: false, uid, page });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.tick(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  private tick(): void {
    if (this.tab === 'cluster') this.cluster.tick(); else this.computer.tick();
  }

  /* ── The header row · the banner ───────────────────────────────────────── */
  private paintHead(title: string, meta: string, bad: boolean): void {
    setText(this.shell.title, title);
    setText(this.shell.meta, meta);
    this.shell.meta.hidden = !meta;
    toggleClass(this.shell.meta, 'mn-meta-bad', bad);
  }

  private setBanner(text: string | null): void {
    this.banner.hidden = !text;
    setText(this.banner, text ?? '');
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    this.debug.paints++;
    if (this.tab === 'cluster') this.cluster.refresh(); else this.computer.refresh();
  }

  override dispose(): void {
    this.stopTicking();
    this.cluster.dispose();
    this.computer.dispose();
    super.dispose();
  }
}

/* ── Entry points (`HousingRef`) ────────────────────────────────────────── */

/** The body of `openComputeCluster(uid)` — a toast when it is not a compute cluster. Default tab `채굴`. */
export function openComputeClusterScreen(sys: HousingSystem, uid: string): void {
  const screen = sys.miningScreen;
  if (!screen) return;
  const placed = sys.getPlacedByUid(uid);
  if (!placed || placed.defId !== COMPUTE_CLUSTER_DEF_ID) { sys.notify('연산 클러스터가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  if (screen.isOpen && screen.currentTab === 'cluster' && screen.currentUid === uid) return;
  if (!screen.isOpen) sys.closeMenus(false);
  screen.openMining(uid, 'cluster');
}

/** The body of `openMiningComputer(uid, tab)` — `uid` null = the ship's main computer. Default tab `클러스터 현황`. */
export function openMiningComputerScreen(sys: HousingSystem, uid: string | null, tab?: MiningComputerTab): void {
  const screen = sys.miningScreen;
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
  if (screen.isOpen) {
    screen.setComputerUid(id);
    screen.setTab(tab ?? (screen.currentTab === 'cluster' ? 'clusters' : screen.currentTab));
    return;
  }
  sys.closeMenus(false);
  screen.openMining(id, tab ?? 'clusters');
}
