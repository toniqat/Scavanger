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

/** 카운터 하나를 네 페이지가 나눠 쓴다 (스모크 · 성능 계측). */
export interface MiningDebug {
  paints: number; tabSets: number;
  /* 채굴 탭 */ rails: number; inserts: number; removes: number; coinSets: number;
  /* 컴퓨터 탭 */ watches: number; unwatches: number; requests: number; trades: number; chartPaints: number;
}

/**
 * 페이지가 창(패널)에 물어보는 것 전부 — 페이지는 `HousingPanel` 이 아니라 **이 창 안의 한 쪽**이다.
 * 창이 `HousingPanel` 의 protected 헬퍼(`button` · `deny` · `overlays`)를 이 모양으로 열어 준다.
 */
export interface MiningHost {
  readonly shell: StationShell;
  readonly isOpen: boolean;
  readonly debug: MiningDebug;
  showMsg(text: string, kind?: 'info' | 'success' | 'warning' | 'danger'): void;
  denyMsg(reason: string): void;
  addOverlay(o: PanelOverlay): void;
  /** 머리줄 제목 · 부가 글 (페이지가 자기 것으로 칠한다). */
  setTitle(text: string, meta: string, bad?: boolean): void;
  /** 좌 패널 맨 위 빨간 배너 (null = 숨김). */
  setBanner(text: string | null): void;
  setTab(tab: MiningTab): void;
  /** 버스 이벤트가 부르는 다시 그리기 — 한 호출 스택의 여러 이벤트를 창이 하나로 합친다(`coalesceRefresh`). */
  refreshLater(): void;
  /** 현황 줄 클릭 → 그 클러스터의 채굴 탭. */
  openCluster(uid: string): void;
}

/**
 * **채굴 화면** (2026-09-14, 사용자 결정 — 연산 클러스터 화면과 메인 컴퓨터 화면을 **한 창**으로 합쳤다).
 *
 * 화면 상단 가로 탭 네 개(`MINING_TABS` — 채굴 · 클러스터 현황 · 지갑 · 거래소, 인벤토리/캐릭터 Tab 화면의
 * `nav.scr-tabs > button.scr-tab` 과 같은 결)가 한 `StationShell` 카드 배치를 갈아 끼운다:
 *  - **채굴**(`ClusterPage`) — 좌측 레일 = 함선의 연산 클러스터 목록 · 프로세서 9칸 · 이번 주기 · 채굴 코인 드롭다운 +
 *    현황 수치, 그리고 [함선 창고] [가방] 카드. 이 탭에서만 격자 카드와 레일이 보인다.
 *  - **클러스터 현황 · 지갑 · 거래소**(`ComputerPages`) — 옛 메인 컴퓨터 세 쪽 그대로.
 *
 * 가구 E 가 여는 **기본 탭은 누른 가구의 탭**이다 (사용자 결정): 연산 클러스터 → `'cluster'`, 메인 컴퓨터 →
 * `'clusters'`. 옛 진입점 이름(`openComputeCluster` · `openMiningComputer`)은 계약이라 그대로 남고 기본 탭만 다르다.
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

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    // `HousingPage` 는 계약이라 값을 더하지 않는다 — 통합 창은 옛 `'cluster'` 쪽 이름을 그대로 쓴다
    super(ctx, 'cluster', 'mining-screen hs-station');
    this.coalesceRefresh = true;

    const tabs = el('nav', { cls: 'mn-tabs', parent: this.frame });
    for (const id of MINING_TABS) {
      const b = el('button', { cls: 'mn-tab', text: MINING_TAB_LABEL_KO[id], attrs: { 'data-tab': id }, parent: tabs });
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

  /* ── 탭 ────────────────────────────────────────────────────────────────── */
  get currentTab(): MiningTab { return this.tab; }
  /** 옛 `MiningComputer.selectedCoin` (거래소 탭의 코인) — 스모크 · 콘솔이 본다. */
  get selectedCoin(): string { return this.computer.selectedCoin; }
  /** 옛 `ClusterScreen.currentUid` (채굴 탭의 클러스터). */
  get currentUid(): string { return this.cluster.currentUid; }
  get chart(): ComputerPages['chart'] { return this.computer.chart; }
  /** 메인 컴퓨터 가구가 바뀌었다 (E 를 다른 컴퓨터에서 눌렀다) — 배너가 그 가구를 본다. */
  setComputerUid(uid: string): void { this.computer.setUid(uid); }

  /** DOM 만 갈아 끼운다 (refresh 없이) — 열기 직전에도 쓴다. */
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

  /** `ui:miningToggled` 의 `page` 는 계약이라 둘뿐이다 — 채굴 탭은 `'cluster'`, 나머지 셋은 `'computer'`. */
  private wirePage(): 'cluster' | 'computer' { return this.tab === 'cluster' ? 'cluster' : 'computer'; }
  private activeUid(): string | null {
    return this.tab === 'cluster' ? this.cluster.currentUid || null : this.computer.currentUid;
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** `uid` = 누른 가구. 채굴 탭이면 그 연산 클러스터, 나머지 탭이면 그 메인 컴퓨터. */
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
    this.computer.syncWatch();              // 창이 닫혔으니 시세 구독을 푼다
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

  /* ── 머리줄 · 배너 ─────────────────────────────────────────────────────── */
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

/* ── 진입점 (`HousingRef`) ──────────────────────────────────────────────────── */

/** `openComputeCluster(uid)` 의 몸통 — 연산 클러스터가 아니면 토스트. 기본 탭 `채굴`. */
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

/** `openMiningComputer(uid, tab)` 의 몸통 — `uid` null = 함선의 메인 컴퓨터. 기본 탭 `클러스터 현황`. */
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
