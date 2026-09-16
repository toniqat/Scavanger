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
import { researchTimeMul } from '../parts/Lab';   // 2026-09-13 (H3): 연구 숙련 해석 시간 배수
import { analysisDexBonus } from '../Rules';     // 2026-09-16: 등급별 도감 칸이 주는 단축

/** 0.035 → `4 %` (0 보다 크고 1 % 미만이면 `<1 %`) — 단축 비율 표기 한 곳. */
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
  /** 계열 칩 (2026-09-13) — 표본이 들어 있을 때만 보인다. */
  fam: HTMLElement;
  /** 표본 레벨 칩 (2026-09-16) — `Lv.n −x %`. 표본이 들어 있을 때만 보인다. */
  lv: HTMLElement;
  time: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  /** 결과 자리 (2026-09-13): 해석 중 「?」, 끝나면 산출물 칩 + 「새 발견」. */
  result: HTMLElement;
  resultKey: string;
  collect: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

/**
 * **분석 화면** (연구실 A-12, 2026-09-11 · 화면 개편 2026-09-12 · 결과표 2026-09-13 — `openAnalyzer(uid)` ← E on a 분석기).
 *
 * 틀은 `StationShell` 공통이다 (제목 + `Lv. n` · 우상단 업그레이드 모달 · 좌 패널 / 우 가방 · 함선 창고).
 * **세로 탭**(「해석」 · 「분석 도감」)은 화면 맨 왼쪽 레일(`StationShell.rail`)이다 — 재배 스테이션 목록과 같은 자리 · 같은 결.
 *
 * 해석 칸 한 줄 = **칸(표본 글리프, 드롭 대상) | 본문(이름 + 계열 칩 · `HH:MM:SS` · 진행바) | 결과 | 버튼(「회수」 · 「중단」)** 의
 * 네 열이다. **2026-09-13 (요리 재료 티어)**: 표본은 계열(세포 · 광물 · DNA)로 해석되고 결과는 **넣는 순간** 굴려져 있다 —
 * 결과 자리는 해석 중에 「?」, 끝나면 산출물 칩(`resultDefId ×resultQty`, 호버 = 아이템 카드)과, 분석 도감에 없던 산출물이면
 * 「새 발견」 배지(`firstTime`). 옛 세이브의 칸(결과를 안 굴린 칸)은 끝나도 「?」 이고 회수하는 순간 굴린다.
 * 잠긴 칸은 썸네일도 글자도 없는 **빈 칸**이다. 끝난 칸은 **더블클릭 = 함선 창고 먼저**, 끌어서 격자에 놓으면 그 격자로
 * 회수된다 (`ProductDrag`). 분석 도감(`createSampleDex`)은 도감 탭일 때만 갱신한다.
 *
 * **2026-09-16 (표본 개편 — 사용자 결정)**: 해석 시간 단축이 화면에 드러난다. 칸의 이름 줄에 표본 레벨 칩
 * `Lv.n −x %`(`paintSampleLevel`, 호버 = 도감 · 레벨 분해)가 서고, 해석 탭 머리에 등급별 도감 줄
 * (`paintDexSpeed` — 「일반 12칸 −12 %」)이 붙는다. 둘 다 **다음에 넣는 표본**에 듣는 값이다: 돌아가는 해석의
 * 시간은 넣는 순간 확정돼 있다 (그래서 칩의 제목이 그렇게 적는다).
 */
export class Analyzer extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly slotsEl: HTMLElement;
  /** 2026-09-13 (H3): 해석 탭 머리의 「연구 숙련 — 해석 시간 ×0.85」 줄 (배수가 1 이면 숨김). */
  private readonly researchEl: HTMLElement;
  /** 2026-09-16: 해석 탭 머리의 「분석 도감 — 일반 12칸 −12 % · …」 줄 (칸이 하나도 없으면 숨김). */
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

    // 2026-09-12: 탭은 분석기 패널 **바깥**의 독립 열이다 (`StationShell.rail`) — 재배 스테이션 목록과 같은 자리 ·
    // 같은 결이라 두 화면의 좌측이 일관된다. 좌 패널에는 페이지만 남는다.
    const tabs = this.shell.rail;
    tabs.hidden = false;
    this.tabBtns = { slots: this.tabButton(tabs, '해석', 'slots'), dex: this.tabButton(tabs, '분석 도감', 'dex') };
    const pages = el('div', { cls: 'az-pages', parent: this.shell.left });
    this.researchEl = el('div', { cls: 'hint az-research', parent: pages });
    this.researchEl.hidden = true;
    // 2026-09-16: 분석 도감이 **등급별로** 주는 단축 — 「도감을 한 칸 채우면 같은 등급 표본 전체가 빨라진다」가 이 한 줄이다
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
      // 2026-09-16: 끌어서 놓은 **그 칸**으로 간다 (격자는 화면이 열릴 때 만들어지므로 함수로 준다)
      grids: () => this.grids,
    });
    // 2026-09-13: 회수가 도감 · 분석 레벨을 바꾼다 — 머리줄(Lv · 경험치)과 결과 행이 따라오게 (refresh 는 한 번으로 합쳐진다)
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

  /** The 분석 도감 is mounted lazily for the same reason the grids are (`ctx.loot` may not exist at construction). */
  private mountDex(): void {
    if (this.dex) return;
    if (!this.ctx.loot || typeof this.ctx.loot.getItemDef !== 'function') return;
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
    const fam = def.sample.family ? SAMPLE_FAMILY_LABEL_KO[def.sample.family] : null;
    // 2026-09-13 (H3): 넣는 순간 정해진 해석 시간(분석 레벨 × 연구 숙련)을 같이 알린다 — 칸의 시계와 같은 `readyAt` 에서 읽는다
    const info = reason ? null : this.infoOf(slot);
    const time = info && info.sampleDefId && !info.ready ? formatRemaining(Math.max(0, Math.ceil(info.remainingS))) : '';
    // 2026-09-16: 이 표본에 붙은 단축을 같이 알린다 — 「왜 이만큼 걸리는가」가 토스트 한 줄에 다 있다
    const sa = reason ? null : this.housing.getSampleAnalysis(item.defId);
    const speed = sa && sa.speedup > 0 ? `Lv.${sa.level} −${pctText(sa.speedup)}` : '';
    const extra = [fam ? `${fam} 분석` : '', time, speed].filter(Boolean).join(' · ');
    this.showMsg(reason ?? `${def.name} 해석을 시작했습니다${extra ? ` (${extra})` : ''}`, reason ? 'warning' : 'success');
  }

  /** 2026-09-13 (H3): 연구 숙련이 해석 시간을 줄이고 있으면 해석 탭 머리에 그 배수 — 새로 넣는 표본부터 적용된다. */
  private paintResearch(): void {
    if (!this.researchEl) return;
    const mul = researchTimeMul(this.housing);
    const show = this.tab === 'slots' && mul < 0.9995;
    this.researchEl.hidden = !show;
    if (show) setText(this.researchEl, `연구 숙련 — 해석 시간 ×${mul.toFixed(2)} (넣는 순간 정해집니다)`);
    this.paintDexSpeed();
  }

  /**
   * 2026-09-16: 등급마다 「도감 n칸 −x %」. 도감 보너스는 종류가 아니라 **등급**으로 묶여 그 등급 표본 전체에 듣는다 —
   * 칸이 하나도 없는 등급은 적지 않는다 (없는 줄이 규칙을 가리지 않게).
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

  /** 끝난 칸의 산출물 — 결과가 굴려져 있으면 그것, 옛 칸이면(회수할 때 굴린다) 대체 산출물 · 표본 글리프로 끈다. */
  private productAt(target: Element): Product | null {
    if (target.closest('.az-acts')) return null;              // the buttons have their own click
    const slot = Number(target.closest<HTMLElement>('.az-slot[data-slot]')?.dataset.slot);
    const info = Number.isInteger(slot) ? this.infoOf(slot) : null;
    if (!info || !info.ready || !info.sampleDefId) return null;
    const defId = info.resultDefId ?? info.rewardDefId ?? info.sampleDefId;
    const qty = info.resultDefId ? info.resultQty : info.rewardDefId ? info.rewardQty : 1;
    return { key: String(slot), defId, qty: Math.max(1, qty || 1) };
  }

  /** 끝난 해석을 회수한다 — 버튼 · 더블클릭은 함선 창고 먼저, 격자에 끌어다 놓으면 그 격자. */
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

  /** 계열 칩: 글리프 + 이름, 계열 색 (`SAMPLE_FAMILY_*`). */
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
   * 2026-09-16 (사용자 결정 「표본 레벨 · 도감 단축이 보여야 한다」): 표본 레벨 칩 `Lv.n −x %`.
   * 레벨은 **그 표본을 회수한 횟수**이고 단축은 도감(같은 등급 칸수) + 레벨을 합친 지금 값이다 — 돌아가는 해석의
   * 시간은 넣는 순간 확정됐으므로, 이 칩은 「다음에 넣으면 이만큼」이라고 제목(title)에 적는다.
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

  /** 결과 자리: 빈 칸 = 비움 · 해석 중(또는 결과를 아직 안 굴린 옛 칸) = 「?」 · 끝남 = 산출물 칩 (+ 「새 발견」). 바뀔 때만 짓는다. */
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
    // `buildItemChip` 이 `data-def-id` 를 달아 호버 = 그 산출물의 아이템 카드 (`ui/hud/ItemTip`)
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
      // 표본 칸 호버 = 그 표본의 아이템 카드 (`ui/hud/ItemTip` 이 `[data-item-tip][data-def-id]` 를 본다)
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
