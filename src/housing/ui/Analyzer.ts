import type { AnalysisSlotInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance, SampleFamily } from '@/shared';
import {
  RARITY_COLORS, RARITY_LABEL_KO, RARITY_ORDER, SAMPLE_FAMILY_COLOR, SAMPLE_FAMILY_ICON, SAMPLE_FAMILY_LABEL_KO,
  analyzerSlotsForLevel, buildItemChip,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { createSampleDex } from './SampleDex';
import type { SampleDexView } from './SampleDex';
import { buildStationShell, mountStationGrids, paintStationLevel } from './StationShell';
import type { StationGridsView, StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, el, formatRemaining, renderClock, renderClockText, setText, toggleClass } from './dom';
import { researchTimeMul } from '../parts/Lab';   // 2026-09-13 (H3): the research skill's analysis time multiplier
import { analysisDexBonus } from '../Rules';     // 2026-09-16: the speedup the catalogue entries of a rarity give

/** 0.035 → `4 %` (`<1 %` above 0 but under 1 %) — the one place a speedup ratio is spelled. */
const pctText = (v: number): string => {
  const p = Math.max(0, v) * 100;
  if (p <= 0) return '0 %';
  if (p < 1) return '<1 %';
  return `${Math.round(p)} %`;
};

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;
/** Result chip edge (px) in the slot's result column. */
const RESULT_CHIP_PX = 44;

type AnalyzerTab = 'slots' | 'dex';

interface SlotCard {
  slot: number;
  wrap: HTMLElement;
  cell: HTMLElement;
  glyph: HTMLElement;
  name: HTMLElement;
  /** The family chip (2026-09-13) — shown only while a sample is in. */
  fam: HTMLElement;
  /** The sample level chip (2026-09-16) — `Lv.n −x %`. Shown only while a sample is in. */
  lv: HTMLElement;
  time: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  /** The result column (2026-09-13): 「?」 while analysing, the product chip + 「새 발견」 once finished. */
  result: HTMLElement;
  resultKey: string;
  collect: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * **The analysis screen** (the lab A-12, 2026-09-11 · screen rework 2026-09-12 · result table 2026-09-13 — `openAnalyzer(uid)` ← E on an analyzer).
 *
 * The frame is the shared `StationShell` (title + `Lv. n` · the upgrade modal at the top right · the left panel / the bag · the ship stash on the right).
 * The **vertical tabs** (「해석」 · 「분석 도감」) are the screen's leftmost rail (`StationShell.rail`) — the same place · the same grain as the grow station list.
 *
 * One analysis slot row is four columns: **the cell (the sample glyph, the drop target) | the body (name + the family chip · `HH:MM:SS` · the progress bar) | the result | the buttons (「회수」 · 「중단」)**.
 * **2026-09-13 (cooking material tiers)**: a sample is analysed by family (cell · mineral · DNA) and the result is already rolled **the moment it goes in** —
 * the result column is 「?」 while analysing, and once finished the product chip (`resultDefId ×resultQty`, hover = the item card) plus a 「새 발견」 badge
 * (`firstTime`) when that product was not in the analysis catalogue. An old save's slot (one with no rolled result) stays 「?」 even when finished and is
 * rolled the moment it is collected. A locked slot is an **empty cell** with no thumbnail and no text. A finished slot is **double-click = the ship stash
 * first**, and a drag onto a grid collects into that grid (`ProductDrag`). The analysis catalogue (`createSampleDex`) is refreshed only while its tab is up.
 *
 * **2026-09-16 (the sample rework — user's decision)**: the analysis speedup shows on the screen. The slot's name row carries the
 * sample level chip `Lv.n −x %` (`paintSampleLevel`, hover = the catalogue · level breakdown), and the head of the 해석 tab
 * carries the per-rarity catalogue line (`paintDexSpeed` — 「일반 12칸 −12 %」). Both are values that apply to **the next sample put
 * in**: a running analysis's time was fixed the moment it went in (which is what the chip's title says).
 */
export class Analyzer extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly slotsEl: HTMLElement;
  /** 2026-09-13 (H3): the 「연구 숙련 — 해석 시간 ×0.85」 line at the head of the 해석 tab (hidden when the multiplier is 1). */
  private readonly researchEl: HTMLElement;
  /** 2026-09-16: the 「분석 도감 — 일반 12칸 −12 % · …」 line at the head of the 해석 tab (hidden with no entries at all). */
  private readonly dexSpeedEl: HTMLElement;
  private readonly dexHost: HTMLElement;
  private readonly tabBtns: Record<AnalyzerTab, HTMLButtonElement>;
  private readonly modal: UpgradeModal;
  private readonly drag: ProductDrag;
  private tab: AnalyzerTab = 'slots';
  private grids: StationGridsView | null = null;
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

    // 2026-09-12: the tabs are an independent column **outside** the analyzer panel (`StationShell.rail`) — the same place ·
    // the same grain as the grow station list, so the left side of the two screens agrees. Only the pages stay in the left panel.
    const tabs = this.shell.rail;
    tabs.hidden = false;
    this.tabBtns = { slots: this.tabButton(tabs, '해석', 'slots'), dex: this.tabButton(tabs, '분석 도감', 'dex') };
    const pages = el('div', { cls: 'az-pages', parent: this.shell.left });
    this.researchEl = el('div', { cls: 'hint az-research', parent: pages });
    this.researchEl.hidden = true;
    // 2026-09-16: the speedup the analysis catalogue gives **per rarity** — 「fill one catalogue entry and every sample of that rarity gets faster」 is this one line
    this.dexSpeedEl = el('div', { cls: 'hint az-dexspeed', parent: pages });
    this.dexSpeedEl.hidden = true;
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
      // 2026-09-16: it goes to **the very cell** it was dropped on (the grids are built when the screen opens, so they come as a function)
      grids: () => this.grids,
    });
    // 2026-09-13: a collect changes the catalogue · the analysis level — so the header row (Lv · XP) and the result rows follow (the refreshes coalesce into one)
    this.unsubs.push(
      ctx.bus.on('housing:analysisChanged', () => this.refreshIfOpen()),
      ctx.bus.on('housing:analysisFound', () => this.refreshIfOpen()),
      ctx.bus.on('housing:analysisLevelUp', () => this.refreshIfOpen()),
    );
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
    this.paintResearch();
    if (id === 'dex') {
      this.mountDex();
      this.dex?.refresh();
    }
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one analyzer. */
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

  /** The analysis catalogue is mounted lazily for the same reason the grids are (`ctx.loot` may not exist at construction). */
  private mountDex(): void {
    if (this.dex) return;
    if (!this.ctx.loot || typeof this.ctx.loot.getItemDef !== 'function') return;
    this.dex = createSampleDex(this.ctx, this.housing, this.dexHost);
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the bag / stash onto an analysis slot (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('표본을 해석 칸으로 끌어다 놓으세요', 'info'); return; }
    const slot = Number(target.dataset.slot);
    if (!Number.isInteger(slot)) { this.showMsg('없는 해석 칸입니다', 'warning'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    if (!def.sample) { this.showMsg('미확인 표본만 넣을 수 있습니다', 'warning'); return; }
    const reason = this.housing.startAnalysis(this.uid, slot, item.defId);
    const fam = def.sample.family ? SAMPLE_FAMILY_LABEL_KO[def.sample.family] : null;
    // 2026-09-13 (H3): the analysis time fixed on insertion (analysis level × the research skill) is announced with it — read from the same `readyAt` as the slot's clock
    const info = reason ? null : this.infoOf(slot);
    const time = info && info.sampleDefId && !info.ready ? formatRemaining(Math.max(0, Math.ceil(info.remainingS))) : '';
    // 2026-09-16: the speedup on this sample is announced with it — 「why it takes this long」 is all in the one toast line
    const sa = reason ? null : this.housing.getSampleAnalysis(item.defId);
    const speed = sa && sa.speedup > 0 ? `Lv.${sa.level} −${pctText(sa.speedup)}` : '';
    const extra = [fam ? `${fam} 분석` : '', time, speed].filter(Boolean).join(' · ');
    this.showMsg(reason ?? `${def.name} 해석을 시작했습니다${extra ? ` (${extra})` : ''}`, reason ? 'warning' : 'success');
  }

  /** 2026-09-13 (H3): while the research skill is shortening the analysis time, its multiplier at the head of the 해석 tab — it applies from the next sample put in. */
  private paintResearch(): void {
    if (!this.researchEl) return;
    const mul = researchTimeMul(this.housing);
    const show = this.tab === 'slots' && mul < 0.9995;
    this.researchEl.hidden = !show;
    if (show) setText(this.researchEl, `연구 숙련 — 해석 시간 ×${mul.toFixed(2)} (넣는 순간 정해집니다)`);
    this.paintDexSpeed();
  }

  /**
   * 2026-09-16: 「도감 n칸 −x %」 per rarity. The catalogue bonus is grouped by **rarity**, not by kind, and applies to every
   * sample of that rarity — a rarity with no entries at all is not written (an empty row must not hide the rule).
   */
  private paintDexSpeed(): void {
    if (!this.dexSpeedEl) return;
    const counts = this.housing.getAnalysisDexByRarity();
    const parts = RARITY_ORDER.filter((r) => (counts[r] ?? 0) > 0)
      .map((r) => `${RARITY_LABEL_KO[r]} ${counts[r]}칸 −${pctText(analysisDexBonus(counts[r]))}`);
    const show = this.tab === 'slots' && parts.length > 0;
    this.dexSpeedEl.hidden = !show;
    if (show) setText(this.dexSpeedEl, `분석 도감 — ${parts.join(' · ')} (같은 등급 표본의 해석 시간)`);
  }

  private infoOf(slot: number): AnalysisSlotInfo | null {
    return this.housing.getAnalyses(this.uid).find((i) => i.slot === slot) ?? null;
  }

  /** A finished slot's product — the rolled result when there is one, else (an old slot, rolled on collection) the fallback product · the sample glyph is dragged. */
  private productAt(target: Element): Product | null {
    if (target.closest('.az-acts')) return null;              // the buttons have their own click
    const slot = Number(target.closest<HTMLElement>('.az-slot[data-slot]')?.dataset.slot);
    const info = Number.isInteger(slot) ? this.infoOf(slot) : null;
    if (!info || !info.ready || !info.sampleDefId) return null;
    const defId = info.resultDefId ?? info.rewardDefId ?? info.sampleDefId;
    const qty = info.resultDefId ? info.resultQty : info.rewardDefId ? info.rewardQty : 1;
    return { key: String(slot), defId, qty: Math.max(1, qty || 1) };
  }

  /** Collect a finished analysis — the button · a double-click go to the ship stash first, a drag onto a grid to that grid. */
  private collect(slot: number, dest: HarvestDestination): void {
    const info = this.infoOf(slot);
    if (!info) return;
    const reason = this.housing.collectAnalysis(this.uid, slot, dest);
    if (reason) { this.deny(reason); return; }
    const id = info.resultDefId ?? info.rewardDefId;
    const qty = info.resultDefId ? info.resultQty : info.rewardQty;
    this.showMsg(id
      ? `${this.housing.nameOf(id)} ×${qty} 회수${info.firstTime ? ' · 분석 도감에 새로 기록했습니다' : ''}`
      : '해석 산출물을 회수했습니다', 'success');
  }

  private cancel(slot: number): void {
    const reason = this.housing.cancelAnalysis(this.uid, slot);
    this.showMsg(reason ?? '해석을 중단했습니다 (표본은 돌아오지 않습니다)', reason ? 'warning' : 'info');
  }

  /* ── the upgrade modal ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** How many slots the next level opens is derived from the contract's `analyzerSlotsForLevel`. */
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
      requirements: h.furnitureUpgradeRequirements(this.uid),
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
    this.paintResearch();
    if (this.tab === 'dex') { this.mountDex(); this.dex?.refresh(); }
    this.modal.refresh();
  }

  /** Rebuild the analysis slot rows — only when the analyzer (or its level) changed. */
  private build(infos: readonly AnalysisSlotInfo[]): void {
    this.debug.builds++;
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '분석기가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) {
      if (info.locked) { el('div', { cls: 'az-slot is-locked', parent: this.slotsEl }); continue; }   // a locked slot = an empty cell
      this.cards.push(this.buildSlot(this.slotsEl, info));
    }
  }

  private buildSlot(parent: HTMLElement, info: AnalysisSlotInfo): SlotCard {
    const s = String(info.slot);
    const wrap = el('div', { cls: 'az-slot', attrs: { 'data-slot': s }, parent });
    const cell = el('div', { cls: 'az-cell', attrs: { 'data-slot': s }, parent: wrap });
    const glyph = el('span', { cls: 'az-glyph', text: '', parent: cell });
    const body = el('div', { cls: 'az-slot-body', parent: wrap });
    const head = el('div', { cls: 'az-name', parent: body });
    const name = el('span', { cls: 'az-name-text', text: '', parent: head });
    const fam = el('span', { cls: 'az-fam', text: '', parent: head });
    fam.hidden = true;
    const lv = el('span', { cls: 'az-lv', text: '', parent: head });
    lv.hidden = true;
    const time = el('div', { cls: 'az-time hs-clock', text: '', parent: body });
    const prog = el('div', { cls: 'az-prog', parent: body });
    const fill = el('i', { parent: prog });
    const result = el('div', { cls: 'az-result', parent: wrap });
    const acts = el('div', { cls: 'az-acts', parent: wrap });
    const collect = this.button(acts, '회수', () => this.collect(info.slot, 'stash-first'), 'small primary');
    const cancel = this.button(acts, '중단', () => this.cancel(info.slot), 'small');
    return { slot: info.slot, wrap, cell, glyph, name, fam, lv, time, prog, fill, result, resultKey: '', collect, cancel };
  }

  /** The family chip: glyph + name, in the family colour (`SAMPLE_FAMILY_*`). */
  private paintFamily(card: SlotCard, family: SampleFamily | null): void {
    const key = family ?? '';
    if (card.fam.dataset.f === key) return;
    card.fam.dataset.f = key;
    card.fam.hidden = !family;
    if (!family) { card.fam.textContent = ''; return; }
    card.fam.textContent = `${SAMPLE_FAMILY_ICON[family]} ${SAMPLE_FAMILY_LABEL_KO[family]}`;
    card.fam.style.setProperty('--fc', SAMPLE_FAMILY_COLOR[family]);
  }

  /**
   * 2026-09-16 (user's decision 「the sample level · the catalogue speedup have to be visible」): the sample level chip `Lv.n −x %`.
   * The level is **how often that sample was collected** and the speedup is the current sum of the catalogue (entries of the same
   * rarity) + the level — a running analysis's time was fixed on insertion, so the chip says 「this much next time」 in its title.
   */
  private paintSampleLevel(card: SlotCard, defId: string | null): void {
    const info = defId ? this.housing.getSampleAnalysis(defId) : null;
    const key = info ? `${info.level}:${info.speedup.toFixed(4)}` : '';
    if (card.lv.dataset.k === key) return;
    card.lv.dataset.k = key;
    card.lv.hidden = !info;
    if (!info) { card.lv.textContent = ''; return; }
    card.lv.textContent = `Lv.${info.level}${info.speedup > 0 ? ` −${pctText(info.speedup)}` : ''}`;
    card.lv.style.setProperty('--fc', RARITY_COLORS[info.rarity]);
    card.lv.title = `${RARITY_LABEL_KO[info.rarity]} 표본 · 해석 ${info.level}회`
      + `\n분석 도감 ${info.dexEntries}칸 −${pctText(info.dexBonus)} + 표본 레벨 −${pctText(info.levelBonus)}`
      + `\n= 해석 시간 −${pctText(info.speedup)} (다음에 넣는 표본부터)`;
  }

  /** The result column: an empty slot = empty · analysing (or an old slot with no rolled result) = 「?」 · finished = the product chip (+ 「새 발견」). Rebuilt only when it changes. */
  private paintResult(card: SlotCard, info: AnalysisSlotInfo, running: boolean): void {
    const done = running && info.ready && !!info.resultDefId;
    const key = !running ? '' : done ? `r:${info.resultDefId}:${info.resultQty}:${info.firstTime ? 1 : 0}` : '?';
    if (card.resultKey === key) return;
    card.resultKey = key;
    clear(card.result);
    toggleClass(card.result, 'is-pending', key === '?');
    toggleClass(card.result, 'is-done', done);
    if (!running) return;
    if (!done) {
      el('span', { cls: 'az-result-q', text: '?', parent: card.result });
      card.result.title = info.ready ? '회수하면 결과가 정해집니다' : '해석이 끝나면 결과가 보입니다';
      return;
    }
    card.result.removeAttribute('title');
    // `buildItemChip` attaches `data-def-id`, so hover = that product's item card (`ui/hud/ItemTip`)
    card.result.appendChild(buildItemChip(this.housing.defOf(info.resultDefId!), { size: RESULT_CHIP_PX, have: Math.max(1, info.resultQty) }));
    if (info.firstTime) el('span', { cls: 'az-new', text: '새 발견', parent: card.result });
  }

  /** Cheap repaint: glyph, name, family, clock, progress, result and button states only. */
  private paint(infos: readonly AnalysisSlotInfo[] = this.housing.getAnalyses(this.uid)): void {
    this.debug.paints++;
    const bySlot = new Map<number, AnalysisSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const running = !!info.sampleDefId;
      const sampleDef = running ? this.housing.defOf(info.sampleDefId!) : undefined;
      const family: SampleFamily | null = running ? (info.family ?? sampleDef?.sample?.family ?? null) : null;
      toggleClass(card.wrap, 'is-running', running);
      toggleClass(card.wrap, 'is-ready', info.ready);
      setText(card.glyph, running ? (sampleDef?.icon || (family ? SAMPLE_FAMILY_ICON[family] : '◍')) : '+');
      if (family) card.cell.style.setProperty('--fc', SAMPLE_FAMILY_COLOR[family]); else card.cell.style.removeProperty('--fc');
      // hovering the sample cell = that sample's item card (`ui/hud/ItemTip` looks at `[data-item-tip][data-def-id]`)
      if (sampleDef) { card.cell.dataset.itemTip = ''; card.cell.dataset.defId = sampleDef.id; }
      else { delete card.cell.dataset.itemTip; delete card.cell.dataset.defId; }

      setText(card.name, running ? (sampleDef?.name ?? '표본') : '');
      this.paintFamily(card, family);
      this.paintSampleLevel(card, running ? info.sampleDefId : null);
      if (!running) renderClockText(card.time, '');
      else if (info.ready) renderClockText(card.time, '해석 완료');
      else renderClock(card.time, info.remainingS);

      card.prog.hidden = !running || info.ready;
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';
      this.paintResult(card, info, running);
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
