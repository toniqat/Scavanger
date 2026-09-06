import type { GameContext, GrowPlotInfo } from '@/shared';
import { GROW_PLOTS_PER_RACK, buildItemChip } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { HousingPanel } from './Panel';
import { CHIP_SIZE_SMALL, clear, el, formatRemaining, setText, toggleClass } from './dom';

interface PlotCard {
  root: HTMLElement;
  state: HTMLElement;
  chip: HTMLElement;
  fill: HTMLElement;
  line: HTMLElement;
  plant: HTMLButtonElement;
  harvest: HTMLButtonElement;
}

/** How often the countdown text is refreshed while the panel is open (ms). */
const TICK_MS = 1000;

/**
 * 재배 패널 (`openGrowMenu(uid)` — E on a 재배층): `GROW_PLOTS_PER_RACK` plot cards with a progress bar and the
 * remaining **real** time, a seed picker built from `getOwnedSeeds()` (item chips: thumbnail + 보유 수) and
 * 심기 / 수확 / 모두 수확. Growth keeps running while the game is closed, so the cards only ever read the state —
 * the timers live in `ShipState.plots`.
 */
export class GrowMenu extends HousingPanel {
  private uid = '';
  private seedDefId: string | null = null;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private cards: PlotCard[] = [];
  private seedList: HTMLElement;
  private seedHint: HTMLElement;
  private btnAll: HTMLButtonElement;
  private timer = 0;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'grow', 'grow-menu');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '재배층', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const page = el('div', { cls: 'hs-page', parent: f });
    const secPlots = this.section(page, '재배 칸');
    const grid = el('div', { cls: 'hs-plots', parent: secPlots });
    for (let slot = 0; slot < GROW_PLOTS_PER_RACK; slot++) grid.appendChild(this.buildCard(slot).root);

    const secSeeds = this.section(page, '보유 씨앗');
    this.seedList = el('div', { cls: 'hs-seeds', parent: secSeeds });
    this.seedHint = el('div', { cls: 'hint', text: '', parent: secSeeds });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const left = el('div', { cls: 'left', parent: foot });
    this.btnAll = this.button(left, '모두 수확', () => this.harvestAll(), 'primary');
    el('div', { cls: 'hint', text: '씨앗은 현실 시간에 맞춰 자랍니다 — 함선을 떠나도 계속 자랍니다.', parent: left });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  private buildCard(slot: number): PlotCard {
    const root = el('div', { cls: 'hs-plot', attrs: { 'data-slot': String(slot) } });
    const top = el('div', { cls: 'top', parent: root });
    el('span', { cls: 'idx', text: `${slot + 1}번 칸`, parent: top });
    const state = el('span', { cls: 'state', text: '', parent: top });
    const chip = el('div', { cls: 'chipwrap', parent: root });
    const bar = el('div', { cls: 'bar', parent: root });
    const fill = el('i', { parent: bar });
    const line = el('div', { cls: 'line', text: '', parent: root });
    const actions = el('div', { cls: 'actions', parent: root });
    const plant = this.button(actions, '심기', () => this.plant(slot), 'small');
    const harvest = this.button(actions, '수확', () => this.harvest(slot), 'small primary');
    const card: PlotCard = { root, state, chip, fill, line, plant, harvest };
    this.cards.push(card);
    return card;
  }

  /** Open the panel for one 재배층. */
  openRack(uid: string): void {
    this.uid = uid;
    this.openPanel();
    this.startTicking();
    this.ctx.bus.emit('ui:growToggled', { open: true, uid });
  }

  override close(relock = true): void {
    const wasOpen = this.isOpen;
    this.stopTicking();
    super.close(relock);
    if (wasOpen) this.ctx.bus.emit('ui:growToggled', { open: false, uid: null });
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = window.setInterval(() => { if (this.isOpen) this.paint(); }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = 0; }
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  private plant(slot: number): void {
    if (!this.seedDefId) { this.showMsg('심을 씨앗을 먼저 고르세요', 'warning'); return; }
    const name = this.housing.nameOf(this.seedDefId);
    const reason = this.housing.plantSeed(this.uid, slot, this.seedDefId);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸에 ${name} 심기 완료`, 'success');
    this.refresh();
  }

  private harvest(slot: number): void {
    const reason = this.housing.harvestPlot(this.uid, slot);
    if (reason) this.showMsg(reason, 'warning');
    else this.showMsg(`${slot + 1}번 칸 수확 완료`, 'success');
    this.refresh();
  }

  private harvestAll(): void {
    const n = this.housing.harvestAll(this.uid);
    this.showMsg(n > 0 ? `${n}칸 수확 완료` : '수확할 수 있는 칸이 없습니다', n > 0 ? 'success' : 'info');
    this.refresh();
  }

  private pickSeed(defId: string): void {
    this.seedDefId = this.seedDefId === defId ? null : defId;
    this.refresh();
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const rack = h.getPlacedByUid(this.uid);
    setText(this.title, rack ? `재배층 · 방 ${rack.room + 1}` : '재배층');
    const layer = rack ? (rack.layer ?? 0) + 1 : 1;
    setText(this.subtitle, rack ? `${layer}층 · 칸 ${GROW_PLOTS_PER_RACK}개 · 씨앗은 현실 시간으로 자랍니다.` : '재배층이 사라졌습니다.');

    // seed picker
    clear(this.seedList);
    const seeds = h.getOwnedSeeds();
    if (this.seedDefId && !seeds.some((s) => s.defId === this.seedDefId)) this.seedDefId = null;
    if (!seeds.length) {
      el('div', { cls: 'hs-empty', text: '가방과 창고에 씨앗이 없습니다 — 레이드 컨테이너나 기업 상점에서 구하세요', parent: this.seedList });
    } else {
      for (const s of seeds) {
        const def = h.defOf(s.defId);
        const chip = buildItemChip(def, { have: s.qty, withName: true, size: 38, button: true });
        chip.classList.add('hs-seed');
        toggleClass(chip, 'sel', this.seedDefId === s.defId);
        chip.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); this.pickSeed(s.defId); });
        this.seedList.appendChild(chip);
      }
    }
    const picked = this.seedDefId ? h.defOf(this.seedDefId) : null;
    setText(this.seedHint, picked && picked.seed
      ? `${picked.name} · 성장 ${picked.seed.growHours}시간 (원예 숙련만큼 단축) → ${h.nameOf(picked.seed.yieldDefId)}`
      : '씨앗을 고르고 빈 칸의 심기를 누르세요.');

    this.paint();
  }

  /** Cheap per-second repaint: progress, countdown and button states only. */
  private paint(): void {
    const infos = this.housing.getPlots(this.uid);
    let ready = 0;
    this.cards.forEach((card, slot) => {
      const info: GrowPlotInfo | undefined = infos[slot];
      const empty = !info || info.seedDefId === null;
      toggleClass(card.root, 'empty', empty);
      toggleClass(card.root, 'ready', !!info && info.ready);
      if (empty) {
        setText(card.state, '비어 있음');
        clear(card.chip);
        card.fill.style.width = '0%';
        setText(card.line, this.seedDefId ? `${this.housing.nameOf(this.seedDefId)} 심기` : '씨앗을 선택하세요');
        card.plant.hidden = false;
        card.plant.disabled = !this.seedDefId;
        card.harvest.hidden = true;
        return;
      }
      if (info!.ready) ready++;
      const seedDef = this.housing.defOf(info!.seedDefId!);
      clear(card.chip);
      card.chip.appendChild(buildItemChip(seedDef, { withName: true, size: CHIP_SIZE_SMALL }));
      setText(card.state, info!.ready ? '수확 준비' : '자라는 중');
      card.fill.style.width = `${Math.round(Math.max(0, info!.progress) * 100)}%`;
      const yieldName = info!.yieldDefId ? this.housing.nameOf(info!.yieldDefId) : '수확물';
      setText(card.line, info!.ready ? `${yieldName} ×${info!.yieldQty}` : `${formatRemaining(info!.remainingS)} 남음`);
      card.plant.hidden = true;
      card.harvest.hidden = false;
      card.harvest.disabled = !info!.ready;
    });
    this.btnAll.disabled = ready === 0;
    setText(this.btnAll, ready > 0 ? `모두 수확 (${ready})` : '모두 수확');
  }

  override dispose(): void {
    this.stopTicking();
    super.dispose();
  }
}
