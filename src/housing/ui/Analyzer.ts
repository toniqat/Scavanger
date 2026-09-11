import type { AnalysisSlotInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance } from '@/shared';
import { analyzerSlotsForLevel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { createSampleDex } from './SampleDex';
import type { SampleDexView } from './SampleDex';
import { buildStationShell, mountStationGrids, paintStationLevel } from './StationShell';
import type { StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, el, renderClock, renderClockText, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;

type AnalyzerTab = 'slots' | 'dex';

interface SlotCard {
  slot: number;
  wrap: HTMLElement;
  cell: HTMLElement;
  glyph: HTMLElement;
  name: HTMLElement;
  time: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  collect: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * **분석 화면** (연구실 A-12, 2026-09-11 · 화면 개편 2026-09-12 — `openAnalyzer(uid)` ← E on a 분석기).
 *
 * 틀은 `StationShell` 공통이다 (제목 + `Lv. n` · 우상단 업그레이드 모달 · 좌 패널 / 우 가방 · 함선 창고). 좌 패널은
 * 다시 **왼쪽 세로 탭**(「해석」 · 「해석 도감」)과 그 페이지로 갈린다 — 도감이 오른쪽 격자 밑에서 자기 탭으로 옮겨 갔다.
 *
 * 해석 칸 한 줄 = 칸(표본 글리프, 드롭 대상) + **위 = 표본 이름, 아래 = 작은 `HH:MM:SS`**(끝나면 「해석 완료」) +
 * 얇은 진행바, 그리고 **오른쪽 아래** 「회수」 · 「중단」. 잠긴 칸은 썸네일도 글자도 없는 **빈 칸**이다. 「처음 해석」
 * 같은 부연 · 「모두 회수」는 걷어냈다. 끝난 칸은 재배 스테이션처럼 **더블클릭 = 함선 창고 먼저**, 끌어서 격자에 놓으면
 * 그 격자로 회수된다 (`ProductDrag`).
 */
export class Analyzer extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly slotsEl: HTMLElement;
  private readonly dexHost: HTMLElement;
  private readonly tabBtns: Record<AnalyzerTab, HTMLButtonElement>;
  private readonly modal: UpgradeModal;
  private readonly drag: ProductDrag;
  private tab: AnalyzerTab = 'slots';
  private grids: EmbeddedView | null = null;
  private dex: SampleDexView | null = null;
  private cards: SlotCard[] = [];
  private builtKey = '';
  private timer = 0;
  /** Smoke / perf counters. */
  readonly debug = { builds: 0, paints: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'analyzer', 'analyzer-panel hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '분석기',
      upgrade: true,
      onUpgrade: () => this.openUpgrade(),
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });

    const split = el('div', { cls: 'az-split', parent: this.shell.left });
    const tabs = el('div', { cls: 'hs-tabs', parent: split });
    this.tabBtns = { slots: this.tabButton(tabs, '해석', 'slots'), dex: this.tabButton(tabs, '해석 도감', 'dex') };
    const pages = el('div', { cls: 'az-pages', parent: split });
    this.slotsEl = el('div', { cls: 'az-slots', parent: pages });
    this.dexHost = el('div', { cls: 'az-dexhost', parent: pages });
    this.setTab('slots');

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '해석은 현실 시간에 맞춰 진행됩니다 — 함선을 떠나도 계속 돌아갑니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.overlays.push(this.modal);
    this.drag = new ProductDrag(this.slotsEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.collect(Number(key), dest),
      defOf: (id) => housing.defOf(id),
    });
  }

  private tabButton(parent: HTMLElement, label: string, id: AnalyzerTab): HTMLButtonElement {
    const b = el('button', { cls: 'hs-tab', text: label, attrs: { 'data-tab': id }, parent });
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.tab === id) return;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.setTab(id);
    });
    return b;
  }

  private setTab(id: AnalyzerTab): void {
    this.tab = id;
    for (const k of Object.keys(this.tabBtns) as AnalyzerTab[]) toggleClass(this.tabBtns[k], 'is-active', k === id);
    this.slotsEl.hidden = id !== 'slots';
    this.dexHost.hidden = id !== 'dex';
    if (id === 'dex') {
      this.mountDex();
      this.dex?.refresh();
    }
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 분석기. */
  openAnalyzer(uid: string): void {
    if (uid !== this.uid) this.builtKey = '';
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.az-cell[data-slot]', (item, target) => this.dropOn(item, target));
    this.startTicking();
  }

  override close(relock = true): void {
    this.stopTicking();
    this.drag.end();
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /** The 해석 도감 is mounted lazily for the same reason the grids are (`ctx.loot` may not exist at construction). */
  private mountDex(): void {
    if (this.dex) return;
    if (!this.ctx.loot || typeof this.ctx.loot.getAllItemDefs !== 'function') return;
    this.dex = createSampleDex(this.ctx, this.housing, this.dexHost);
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 가방 / 창고 onto a 해석 칸 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('표본을 해석 칸으로 끌어다 놓으세요', 'info'); return; }
    const slot = Number(target.dataset.slot);
    if (!Number.isInteger(slot)) { this.showMsg('없는 해석 칸입니다', 'warning'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    if (!def.sample) { this.showMsg('미확인 표본만 넣을 수 있습니다', 'warning'); return; }
    const reason = this.housing.startAnalysis(this.uid, slot, item.defId);
    this.showMsg(reason ?? `${def.name} 해석을 시작했습니다`, reason ? 'warning' : 'success');
  }

  private infoOf(slot: number): AnalysisSlotInfo | null {
    return this.housing.getAnalyses(this.uid).find((i) => i.slot === slot) ?? null;
  }

  private productAt(target: Element): Product | null {
    if (target.closest('.az-acts')) return null;              // the buttons have their own click
    const slot = Number(target.closest<HTMLElement>('.az-slot[data-slot]')?.dataset.slot);
    const info = Number.isInteger(slot) ? this.infoOf(slot) : null;
    if (!info || !info.ready || !info.rewardDefId) return null;
    return { key: String(slot), defId: info.rewardDefId, qty: info.rewardQty };
  }

  /** 끝난 해석을 회수한다 — 버튼 · 더블클릭은 함선 창고 먼저, 격자에 끌어다 놓으면 그 격자. */
  private collect(slot: number, dest: HarvestDestination): void {
    const info = this.infoOf(slot);
    if (!info) return;
    const reason = this.housing.collectAnalysis(this.uid, slot, dest);
    if (reason) { this.deny(reason); return; }
    const reward = info.rewardDefId ? this.housing.nameOf(info.rewardDefId) : '산출물';
    this.showMsg(`${reward} ×${info.rewardQty} 회수${info.firstTime ? ' · 해석 도감에 기록했습니다' : ''}`, 'success');
  }

  private cancel(slot: number): void {
    const reason = this.housing.cancelAnalysis(this.uid, slot);
    this.showMsg(reason ?? '해석을 중단했습니다 (표본은 돌아오지 않습니다)', reason ? 'warning' : 'info');
  }

  /* ── 업그레이드 (모달) ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** 다음 레벨이 여는 칸 수는 계약 `analyzerSlotsForLevel` 에서 유도한다. */
  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const analyzer = h.getPlacedByUid(this.uid);
    const def = analyzer ? h.getFurnitureDef(analyzer.defId) : undefined;
    if (!analyzer || !def) return null;
    const level = analyzer.level;
    const opened = analyzerSlotsForLevel(level + 1) - analyzerSlotsForLevel(level);
    return {
      name: def.name,
      level,
      maxLevel: furnitureMaxLevel(def),
      gain: opened > 0 ? `해석 칸 ${opened}개 개방` : '',
      cost: nextFurnitureCost(def, level),
      reason: h.furnitureUpgradeBlock(this.uid),
    };
  }

  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.deny(reason); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = analyzerSlotsForLevel(before + 1) - analyzerSlotsForLevel(before);
      this.showMsg(`분석기 Lv.${before + 1}${opened > 0 ? ` — 해석 칸 ${opened}개 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const analyzer = h.getPlacedByUid(this.uid);
    const def = analyzer ? h.getFurnitureDef(analyzer.defId) : undefined;
    setText(this.shell.title, def?.name ?? '분석기');
    paintStationLevel(this.shell, analyzer && def ? analyzer.level : null, def ? furnitureMaxLevel(def) : 0);
    const infos = analyzer ? h.getAnalyses(this.uid) : [];
    const key = analyzer ? `${this.uid}:${analyzer.level}` : '';
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(infos);
    }
    this.paint(infos);
    if (this.tab === 'dex') { this.mountDex(); this.dex?.refresh(); }
    this.modal.refresh();
  }

  /** Rebuild the 해석 칸 rows — only when the analyzer (or its level) changed. */
  private build(infos: readonly AnalysisSlotInfo[]): void {
    this.debug.builds++;
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '분석기가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) {
      if (info.locked) { el('div', { cls: 'az-slot is-locked', parent: this.slotsEl }); continue; }   // 잠긴 칸 = 빈 칸
      this.cards.push(this.buildSlot(this.slotsEl, info));
    }
  }

  private buildSlot(parent: HTMLElement, info: AnalysisSlotInfo): SlotCard {
    const s = String(info.slot);
    const wrap = el('div', { cls: 'az-slot', attrs: { 'data-slot': s }, parent });
    const cell = el('div', { cls: 'az-cell', attrs: { 'data-slot': s }, parent: wrap });
    const glyph = el('span', { cls: 'az-glyph', text: '', parent: cell });
    const body = el('div', { cls: 'az-slot-body', parent: wrap });
    const name = el('div', { cls: 'az-name', text: '', parent: body });
    const time = el('div', { cls: 'az-time hs-clock', text: '', parent: body });
    const prog = el('div', { cls: 'az-prog', parent: body });
    const fill = el('i', { parent: prog });
    const acts = el('div', { cls: 'az-acts', parent: wrap });
    const collect = this.button(acts, '회수', () => this.collect(info.slot, 'stash-first'), 'small primary');
    const cancel = this.button(acts, '중단', () => this.cancel(info.slot), 'small');
    return { slot: info.slot, wrap, cell, glyph, name, time, prog, fill, collect, cancel };
  }

  /** Cheap repaint: glyph, name, clock, progress and button states only. */
  private paint(infos: readonly AnalysisSlotInfo[] = this.housing.getAnalyses(this.uid)): void {
    this.debug.paints++;
    const bySlot = new Map<number, AnalysisSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const running = !!info.sampleDefId;
      const sampleDef = running ? this.housing.defOf(info.sampleDefId!) : undefined;
      toggleClass(card.wrap, 'is-running', running);
      toggleClass(card.wrap, 'is-ready', info.ready);
      setText(card.glyph, running ? (sampleDef?.icon || '◍') : '+');
      // 표본 칸 호버 = 그 표본의 아이템 카드 (`ui/hud/ItemTip` 이 `[data-item-tip][data-def-id]` 를 본다)
      if (sampleDef) { card.cell.dataset.itemTip = ''; card.cell.dataset.defId = sampleDef.id; }
      else { delete card.cell.dataset.itemTip; delete card.cell.dataset.defId; }

      setText(card.name, running ? (sampleDef?.name ?? '표본') : '');
      if (!running) renderClockText(card.time, '');
      else if (info.ready) renderClockText(card.time, '해석 완료');
      else renderClock(card.time, info.remainingS);

      card.prog.hidden = !running || info.ready;
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';
      card.collect.hidden = !running;
      card.collect.disabled = !info.ready;
      card.cancel.hidden = !running || info.ready;
    }
  }

  override dispose(): void {
    this.stopTicking();
    this.drag.dispose();
    this.modal.dispose();
    this.grids?.dispose();
    this.grids = null;
    this.dex = null;
    super.dispose();
  }
}
