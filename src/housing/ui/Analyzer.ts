import type {
  AnalysisSlotInfo, EmbeddedView, FurnitureDef, GameContext, ItemInstance, PlacedFurniture,
} from '@/shared';
import { ANALYZER_MAX_SLOTS, analyzerSlotsForLevel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { createSampleDex } from './SampleDex';
import type { SampleDexView } from './SampleDex';
import { CHIP_SIZE, clear, el, formatRemaining, levelText, renderCost, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;

interface SlotCard {
  slot: number;
  cell: HTMLElement;
  glyph: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  line: HTMLElement;
  sub: HTMLElement;
  collect: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * **분석 화면** (연구실 A-12, 2026-09-11 — `openAnalyzer(uid)` ← E on a 분석기).
 *
 * `ui/GrowStation.ts` 가 그대로 본보기다: **좌 = 해석 칸 + 강화 줄, 우 = 가방 · 함선 창고 + 해석 도감.**
 * 해석 칸은 `ANALYZER_MAX_SLOTS` 개를 **언제나** 그리고 잠긴 칸은 딤드 + 「Lv.N 강화로 열립니다」다 (드롭 대상이
 * 아니다 — `dropSelector` 가 `:not(.is-locked)` 이다). 오른쪽은 `ctx.inventory.createTradeGrids` 가 그리는 진짜
 * 격자라, 표본을 끌어다 칸에 떨어뜨리면 `startAnalysis` 가 돌고 규칙이 거절하면 한국어 사유가 메시지 줄에 뜬다.
 *
 * 화면은 상태를 **읽기만** 한다 — 타이머는 `ShipState.analyses` 에 있고, 1초 틱은 글자 · 바 · 버튼만 다시 칠한다
 * (재구축 없음). 강화 줄은 재배 스테이션의 `.gs-up` 과 같은 판단이다: 되돌릴 수 있는 확정이라 1초 홀드가 없다.
 */
export class Analyzer extends HousingPanel {
  private uid = '';
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly slotsEl: HTMLElement;
  private readonly upRow: HTMLElement;
  private readonly upLevel: HTMLElement;
  private readonly upNext: HTMLElement;
  private readonly upCost: HTMLElement;
  private readonly upNote: HTMLElement;
  private readonly btnUp: HTMLButtonElement;
  private readonly invHost: HTMLElement;
  private readonly invNote: HTMLElement;
  private readonly dexHost: HTMLElement;
  private readonly btnAll: HTMLButtonElement;
  private grids: EmbeddedView | null = null;
  private dex: SampleDexView | null = null;
  private cards: SlotCard[] = [];
  private timer = 0;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'analyzer', 'analyzer-panel');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '분석기', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const body = el('div', { cls: 'az-body', parent: f });
    const left = el('div', { cls: 'az-left', parent: body });

    // 강화 줄 — 해석 칸을 여는 유일한 입구 (가구 레벨 = 열린 칸 수), 재배 스테이션의 `.gs-up` 과 같은 결
    this.upRow = el('div', { cls: 'az-up', parent: left });
    const upMain = el('div', { cls: 'az-up-main', parent: this.upRow });
    const upHead = el('div', { cls: 'az-up-head', parent: upMain });
    this.upLevel = el('span', { cls: 'lv', text: '', parent: upHead });
    this.upNext = el('span', { cls: 'next', text: '', parent: upHead });
    this.upCost = el('div', { cls: 'az-up-cost', parent: upMain });
    this.upNote = el('div', { cls: 'az-up-note', text: '', parent: upMain });
    this.btnUp = this.button(this.upRow, '강화', () => this.upgrade(), 'small primary az-up-btn');

    this.slotsEl = el('div', { cls: 'az-slots', parent: left });

    const right = el('div', { cls: 'az-right', parent: body });
    el('div', { cls: 'ui-label', text: '가방 · 함선 창고', parent: right });
    this.invNote = el('div', { cls: 'hint', text: '미확인 표본을 왼쪽 해석 칸으로 끌어다 놓으세요.', parent: right });
    this.invHost = el('div', { cls: 'az-inv', parent: right });
    el('div', { cls: 'ui-label', text: '해석 도감', parent: right });
    this.dexHost = el('div', { cls: 'az-dexhost', parent: right });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const footLeft = el('div', { cls: 'left', parent: foot });
    this.btnAll = this.button(footLeft, '모두 회수', () => this.collectAll(), 'primary');
    el('div', { cls: 'hint', text: '해석은 현실 시간에 맞춰 진행됩니다 — 함선을 떠나도 계속 돌아갑니다.', parent: footLeft });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 분석기. */
  openAnalyzer(uid: string): void {
    this.uid = uid;
    this.openPanel();
    this.mountGrids();
    this.startTicking();
  }

  override close(relock = true): void {
    this.stopTicking();
    // the embedded grids keep listening to `inventory:changed` while they live, so a closed panel drops them
    this.grids?.dispose();
    this.grids = null;
    super.close(relock);
  }

  /**
   * The 가방 / 함선 창고 grids are built **lazily**: housing/ is registered before inventory/, so `ctx.inventory`
   * does not exist yet when this panel is constructed. Same cell edge as the 제작 창 (the view's default, 54 px).
   */
  private mountGrids(): void {
    if (this.grids) return;
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.createTradeGrids !== 'function') {
      setText(this.invNote, '인벤토리를 사용할 수 없습니다');
      return;
    }
    setText(this.invNote, '미확인 표본을 왼쪽 해석 칸으로 끌어다 놓으세요.');
    this.grids = inv.createTradeGrids(this.invHost, {
      grids: ['bag', 'stash'],
      dropSelector: '.az-cell:not(.is-locked)',
      onTake: (item, _gridId, target) => this.dropOn(item, target),
    });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
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
    this.refresh();
  }

  private collect(slot: number): void {
    const reason = this.housing.collectAnalysis(this.uid, slot);
    this.showMsg(reason ?? '해석 완료 — 가방이 차면 함선 창고로 들어갑니다', reason ? 'warning' : 'success');
    this.refresh();
  }

  private cancel(slot: number): void {
    const reason = this.housing.cancelAnalysis(this.uid, slot);
    this.showMsg(reason ?? '해석을 중단했습니다 (표본은 돌아오지 않습니다)', reason ? 'warning' : 'info');
    this.refresh();
  }

  private collectAll(): void {
    const n = this.housing.collectAllAnalyses(this.uid);
    this.showMsg(n > 0 ? `${n}칸 회수 완료` : '회수할 수 있는 칸이 없습니다', n > 0 ? 'success' : 'info');
    this.refresh();
  }

  /**
   * 분석기 한 단계 강화 = 해석 칸 한 개 개방. 규칙 · 재료 소모는 전부 `HousingRef.upgradeFurniture` 안에 있고
   * 여기서는 그 앞에 `furnitureUpgradeBlock` 의 한국어 사유를 한 번 더 보여 줄 뿐이다 (버튼이 이미 비활성이라
   * 보통은 닿지 않지만, 두 번 클릭 사이에 재료가 빠졌을 수 있다).
   */
  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = analyzerSlotsForLevel(before + 1) - analyzerSlotsForLevel(before);
      this.showMsg(`분석기 Lv.${before + 1}${opened > 0 ? ` — 해석 칸 ${opened}개 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
    this.refresh();                 // 새 칸 + 재료가 빠진 가방 · 창고를 곧바로 그린다
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const analyzer = h.getPlacedByUid(this.uid);
    const def = analyzer ? h.getFurnitureDef(analyzer.defId) : undefined;
    setText(this.title, analyzer ? `분석기 · 방 ${analyzer.room + 1}` : '분석기');
    const open = analyzer ? analyzerSlotsForLevel(analyzer.level) : 0;
    setText(this.subtitle, analyzer
      ? `Lv.${analyzer.level} / ${def?.maxLevel ?? analyzer.level} · 해석 칸 ${open} / ${ANALYZER_MAX_SLOTS}`
      : '분석기가 사라졌습니다.');

    this.paintUpgrade(analyzer, def);
    this.build(h.getAnalyses(this.uid));
    this.grids?.refresh();          // 표본 · 강화 재료 · 산출물이 오간 것이 곧바로 보이도록
    this.mountDex();
    this.dex?.refresh();
    this.paint();
  }

  /** The 해석 도감 is mounted lazily for the same reason the grids are (`ctx.loot` may not exist at construction). */
  private mountDex(): void {
    if (this.dex) return;
    if (!this.ctx.loot || typeof this.ctx.loot.getAllItemDefs !== 'function') return;
    this.dex = createSampleDex(this.ctx, this.housing, this.dexHost);
  }

  /** 강화 줄: 현재 레벨 · 다음 레벨이 여는 칸 수 · 비용 칩 · 버튼 (사유는 `furnitureUpgradeBlock` 한 줄). */
  private paintUpgrade(analyzer: PlacedFurniture | null, def: FurnitureDef | undefined): void {
    const max = def ? furnitureMaxLevel(def) : 0;
    const level = analyzer?.level ?? 0;
    const atMax = !analyzer || !def || level >= max;
    setText(this.upLevel, analyzer && def ? levelText(level, max) : '—');

    const cost = analyzer && def ? nextFurnitureCost(def, level) : null;
    if (cost) {
      renderCost(this.upCost, cost, this.housing, CHIP_SIZE);
    } else {
      clear(this.upCost);
      el('span', { cls: 'item-chip-free', text: atMax ? '최대 레벨' : '—', parent: this.upCost });
    }

    // 다음 레벨이 여는 칸 수는 계약 `analyzerSlotsForLevel` 에서 유도한다 (칸 수를 코드에 적지 않는다)
    const opened = analyzer && !atMax ? analyzerSlotsForLevel(level + 1) - analyzerSlotsForLevel(level) : 0;
    setText(this.upNext, opened > 0
      ? `강화하면 해석 칸 ${opened}개 개방`
      : atMax && analyzer ? '모든 해석 칸이 열렸습니다' : '');

    const reason = analyzer ? this.housing.furnitureUpgradeBlock(this.uid) : '분석기가 사라졌습니다';
    setText(this.upNote, reason ?? '강화할 수 있습니다');
    toggleClass(this.upNote, 'ok', !reason);
    this.btnUp.disabled = !!reason;
    this.btnUp.title = reason ?? '';
    toggleClass(this.upRow, 'is-max', atMax);
  }

  /** Rebuild the 해석 칸 cards (the analyzer level may have changed since the last open). */
  private build(infos: readonly AnalysisSlotInfo[]): void {
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '분석기가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) this.cards.push(this.buildSlot(this.slotsEl, info));
  }

  private buildSlot(parent: HTMLElement, info: AnalysisSlotInfo): SlotCard {
    const wrap = el('div', { cls: 'az-slot', parent });
    const cell = el('div', {
      cls: `az-cell${info.locked ? ' is-locked' : ''}`,
      attrs: info.locked ? {} : { 'data-slot': String(info.slot) },
      parent: wrap,
    });
    const glyph = el('span', { cls: 'az-glyph', text: '', parent: cell });
    const body = el('div', { cls: 'az-slot-body', parent: wrap });
    const line = el('div', { cls: 'az-line', text: '', parent: body });
    const sub = el('div', { cls: 'az-sub', text: '', parent: body });
    const prog = el('div', { cls: 'az-prog', parent: body });
    const fill = el('i', { parent: prog });
    const acts = el('div', { cls: 'az-acts', parent: body });
    const collect = this.button(acts, '회수', () => this.collect(info.slot), 'small primary');
    const cancel = this.button(acts, '중단', () => this.cancel(info.slot), 'small');
    return { slot: info.slot, cell, glyph, prog, fill, line, sub, collect, cancel };
  }

  /** Cheap per-second repaint: glyph, progress, countdown and button states only. */
  private paint(): void {
    const infos = this.housing.getAnalyses(this.uid);
    const bySlot = new Map<number, AnalysisSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    let ready = 0;
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const running = !!info.sampleDefId;
      if (info.ready) ready++;
      toggleClass(card.cell, 'is-running', running);
      toggleClass(card.cell, 'is-ready', info.ready);

      const sampleDef = info.sampleDefId ? this.housing.defOf(info.sampleDefId) : undefined;
      setText(card.glyph, info.locked ? '🔒' : running ? (sampleDef?.icon || '◍') : '+');

      card.prog.hidden = !running;
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';

      if (info.locked) {
        setText(card.line, '잠긴 해석 칸');
        setText(card.sub, `Lv.${info.unlockLevel} 강화로 열립니다 · 위 「강화」`);
      } else if (!running) {
        setText(card.line, '빈 해석 칸');
        setText(card.sub, '미확인 표본을 끌어다 놓으세요');
      } else if (info.ready) {
        const reward = info.rewardDefId ? this.housing.nameOf(info.rewardDefId) : '산출물';
        setText(card.line, `${reward} ×${info.rewardQty} 회수 준비`);
        setText(card.sub, info.firstTime ? '처음 해석하는 표본 — 도감이 차고 보너스가 붙습니다' : `${sampleDef?.name ?? '표본'} 해석 완료`);
      } else {
        setText(card.line, `${formatRemaining(info.remainingS)} 남음`);
        setText(card.sub, `${sampleDef?.name ?? '표본'}${info.firstTime ? ' · 처음 해석' : ' · 도감에 있는 표본 (빠름)'}`);
      }

      card.collect.hidden = !running;
      card.collect.disabled = !info.ready;
      card.cancel.hidden = !running || info.ready;
    }
    this.btnAll.disabled = ready === 0;
    setText(this.btnAll, ready > 0 ? `모두 회수 (${ready})` : '모두 회수');
  }

  override dispose(): void {
    this.stopTicking();
    this.grids?.dispose();
    this.grids = null;
    this.dex = null;
    super.dispose();
  }
}
