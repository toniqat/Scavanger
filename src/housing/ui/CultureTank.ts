import type { CultureSlotInfo, EmbeddedView, GameContext, HarvestDestination, ItemInstance } from '@/shared';
import { cultureSlotsForLevel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { ProductDrag } from './ProductDrag';
import type { Product } from './ProductDrag';
import { StationMenu } from './StationMenu';
import { StationTip } from './StationTip';
import type { TipRow, TipSpec } from './StationTip';
import { buildStationShell, mountStationGrids, paintStationLevel } from './StationShell';
import type { StationShell } from './StationShell';
import { UpgradeModal } from './UpgradeModal';
import type { UpgradeSpec } from './UpgradeModal';
import { clear, clockText, el, renderClock, renderClockText, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;

interface SlotCard {
  slot: number;
  wrap: HTMLElement;
  cell: HTMLElement;
  fluid: HTMLElement;
  glyph: HTMLElement;
  name: HTMLElement;
  time: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
}

/**
 * **배양 화면** (배양조 A-14, 2026-09-11 · 화면 개편 2026-09-12 — `openCultureTank(uid)` ← E on a 배양조).
 *
 * 틀은 `StationShell` 공통이고 **수확 규칙은 재배 스테이션과 똑같다** (사용자 결정): 칸 아래 「수확」 · 「배지 비우기」
 * 버튼과 「모두 수확」을 걷어내고, 끝난 칸은 **더블클릭 = 함선 창고 먼저 · 끌어서 격자에 놓기 = 그 격자**
 * (`ProductDrag`), 배지 비우기는 **우클릭 메뉴**(`StationMenu`), 부연 설명은 **호버 카드**(`StationTip`)로 옮겼다.
 *
 * 배양 칸 한 줄 = 배양관(배지 색으로 차오른다, 드롭 대상) + 위 = 이름, 아래 = `HH:MM:SS` 또는 「수확 가능」 + 얇은
 * 진행바. 잠긴 칸은 분석기처럼 **빈 칸**이다.
 */
export class CultureTank extends HousingPanel {
  private uid = '';
  private readonly shell: StationShell;
  private readonly slotsEl: HTMLElement;
  private readonly modal: UpgradeModal;
  private readonly tip: StationTip;
  private readonly menu: StationMenu;
  private readonly drag: ProductDrag;
  private grids: EmbeddedView | null = null;
  private cards: SlotCard[] = [];
  private builtKey = '';
  private hoverSlot: number | null = null;
  private timer = 0;
  /** Smoke / perf counters. */
  readonly debug = { builds: 0, paints: 0 };

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'culture', 'culture-tank hs-station');
    this.coalesceRefresh = true;
    this.shell = buildStationShell(this.frame, {
      title: '배양조',
      upgrade: true,
      onUpgrade: () => this.openUpgrade(),
      button: (p, l, fn, c) => this.button(p, l, fn, c),
    });
    this.slotsEl = el('div', { cls: 'cult-slots', parent: this.shell.left });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: this.frame });
    el('div', { cls: 'hint', text: '배양은 현실 시간에 맞춰 진행됩니다 — 함선을 떠나도 계속 자랍니다.', parent: el('div', { cls: 'left', parent: foot }) });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());

    this.modal = new UpgradeModal(ctx, this.root, housing);
    this.tip = new StationTip(this.root);
    this.menu = new StationMenu(this.root);
    this.overlays.push(this.modal, this.menu);
    this.drag = new ProductDrag(this.slotsEl, {
      productAt: (t) => this.productAt(t),
      collect: (key, dest) => this.collect(Number(key), dest),
      defOf: (id) => housing.defOf(id),
      onDragStart: () => this.hideTip(),
    });

    this.slotsEl.addEventListener('pointerover', (e) => this.onHover(e));
    this.slotsEl.addEventListener('pointermove', (e) => { if (this.hoverSlot !== null && !this.drag.dragging) this.tip.move(e.clientX, e.clientY); });
    this.slotsEl.addEventListener('pointerleave', () => this.hideTip());
    this.slotsEl.addEventListener('contextmenu', (e) => this.onContext(e));
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 배양조. */
  openTank(uid: string): void {
    if (uid !== this.uid) this.builtKey = '';
    this.uid = uid;
    this.openPanel();
    if (!this.grids) this.grids = mountStationGrids(this.ctx, this.shell.invHost, '.cult-cell[data-slot]', (item, target) => this.dropOn(item, target));
    this.startTicking();
  }

  override close(relock = true): void {
    this.stopTicking();
    this.hideTip();
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

  /* ── actions ───────────────────────────────────────────────────────────── */
  /** A tile was dragged out of the 가방 / 창고 onto a 배양관 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('배지 · 세포주를 배양관으로 끌어다 놓으세요', 'info'); return; }
    const slot = Number(target.dataset.slot);
    if (!Number.isInteger(slot)) { this.showMsg('없는 배양 칸입니다', 'warning'); return; }
    const def = this.housing.defOf(item.defId);
    if (!def) { this.showMsg('알 수 없는 아이템입니다', 'warning'); return; }
    let reason: string | null;
    let done: string;
    if (def.medium) {
      reason = this.housing.fillMedium(this.uid, slot, item.defId);
      done = `${def.name}을(를) 부었습니다`;
    } else if (def.strain) {
      reason = this.housing.insertStrain(this.uid, slot, item.defId);
      done = `${def.name} 배양을 시작했습니다`;
    } else {
      this.showMsg('영양 배지나 세포주만 넣을 수 있습니다', 'warning');
      return;
    }
    this.showMsg(reason ?? done, reason ? 'warning' : 'success');
  }

  private infoOf(slot: number): CultureSlotInfo | null {
    return this.housing.getCultureSlots(this.uid).find((i) => i.slot === slot) ?? null;
  }

  private slotAt(target: Element | null): number | null {
    const s = Number(target?.closest<HTMLElement>('.cult-slot[data-slot]')?.dataset.slot);
    return Number.isInteger(s) ? s : null;
  }

  private productAt(target: Element): Product | null {
    const slot = this.slotAt(target);
    const info = slot !== null ? this.infoOf(slot) : null;
    if (!info || !info.ready || !info.yieldDefId) return null;
    return { key: String(info.slot), defId: info.yieldDefId, qty: info.yieldQty };
  }

  private collect(slot: number, dest: HarvestDestination): void {
    const info = this.infoOf(slot);
    if (!info) return;
    const reason = this.housing.harvestCulture(this.uid, slot, dest);
    if (reason) { this.deny(reason); return; }
    const name = info.yieldDefId ? this.housing.nameOf(info.yieldDefId) : '배양 산물';
    this.showMsg(`${name} ×${info.yieldQty} 수확`, 'success');
    this.hideTip();
  }

  private clearMedium(slot: number, discardStrain: boolean): void {
    const reason = this.housing.clearMedium(this.uid, slot, discardStrain);
    if (reason) { this.deny(reason); return; }
    this.showMsg(discardStrain ? '세포주를 버리고 배지를 비웠습니다' : '배지를 비웠습니다 (남은 횟수는 돌려받지 않습니다)', 'info');
  }

  /* ── 업그레이드 (모달) ─────────────────────────────────────────────────── */
  private openUpgrade(): void {
    if (!this.housing.getPlacedByUid(this.uid)) return;
    this.hideTip();
    this.modal.open(() => this.upgradeSpec(), () => this.upgrade());
  }

  /** 다음 레벨이 여는 칸 수는 계약 `cultureSlotsForLevel` 에서 유도한다. */
  private upgradeSpec(): UpgradeSpec | null {
    const h = this.housing;
    const tank = h.getPlacedByUid(this.uid);
    const def = tank ? h.getFurnitureDef(tank.defId) : undefined;
    if (!tank || !def) return null;
    const level = tank.level;
    const opened = cultureSlotsForLevel(level + 1) - cultureSlotsForLevel(level);
    return {
      name: def.name,
      level,
      maxLevel: furnitureMaxLevel(def),
      gain: opened > 0 ? `배양 칸 ${opened}개 개방` : '',
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
      const opened = cultureSlotsForLevel(before + 1) - cultureSlotsForLevel(before);
      this.showMsg(`배양조 Lv.${before + 1}${opened > 0 ? ` — 배양 칸 ${opened}개 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
  }

  /* ── 호버 카드 · 우클릭 ────────────────────────────────────────────────── */
  private onHover(e: PointerEvent): void {
    if (this.drag.dragging) return;
    const slot = this.slotAt(e.target as Element | null);
    if (slot === this.hoverSlot) return;
    this.hoverSlot = slot;
    const spec = slot !== null ? this.tipSpec(slot) : null;
    if (spec) this.tip.show(spec, e.clientX, e.clientY);
    else this.tip.hide();
  }

  private hideTip(): void {
    this.hoverSlot = null;
    this.tip.hide();
  }

  private tipSpec(slot: number): TipSpec | null {
    const info = this.infoOf(slot);
    if (!info || info.locked) return null;
    const h = this.housing;
    const hasMedium = !!info.mediumDefId;
    const running = !!info.strainDefId;
    const mediumDef = hasMedium ? h.defOf(info.mediumDefId!) : undefined;
    const rows: TipRow[] = [];
    if (hasMedium) {
      rows.push({ k: '배지', v: `${mediumDef?.name ?? info.mediumDefId} · 수확 ${info.mediumUsesLeft}회 남음` });
      rows.push({ k: '배양 속도', v: speedText(info), tone: info.mediumSpeedMul < 1 ? 'good' : undefined });
    }
    if (running) {
      rows.push({ k: '세포주', v: h.nameOf(info.strainDefId!) });
      rows.push({ k: '남은 시간', v: info.ready ? '수확 가능' : clockText(info.remainingS), tone: info.ready ? 'good' : undefined });
      if (info.yieldDefId) rows.push({ k: '산출물', v: `${h.nameOf(info.yieldDefId)} ×${info.yieldQty}` });
    }
    const foot: string[] = [];
    if (info.ready) foot.push('더블클릭 · 끌어다 놓기: 수확');
    if (hasMedium) foot.push('우클릭: 배지 비우기');
    return {
      name: running ? h.nameOf(info.strainDefId!) : mediumDef?.name ?? '빈 배양관',
      sub: info.ready ? '수확 가능' : running ? '배양 중' : hasMedium ? '세포주를 넣을 수 있습니다' : '영양 배지를 부을 수 있습니다',
      color: mediumDef?.color,
      rows,
      foot: foot.join('\n'),
    };
  }

  private onContext(e: MouseEvent): void {
    const slot = this.slotAt(e.target as Element | null);
    if (slot === null) return;
    e.preventDefault();
    e.stopPropagation();
    const info = this.infoOf(slot);
    if (!info || info.locked || !info.mediumDefId) return;
    this.hideTip();
    const running = !!info.strainDefId;
    this.menu.show(e.clientX, e.clientY, [{
      label: running ? '세포주 버리고 배지 비우기' : '배지 비우기',
      danger: running,
      run: () => this.clearMedium(slot, running),
    }]);
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const tank = h.getPlacedByUid(this.uid);
    const def = tank ? h.getFurnitureDef(tank.defId) : undefined;
    setText(this.shell.title, def?.name ?? '배양조');
    paintStationLevel(this.shell, tank && def ? tank.level : null, def ? furnitureMaxLevel(def) : 0);
    const infos = tank ? h.getCultureSlots(this.uid) : [];
    const key = tank ? `${this.uid}:${tank.level}` : '';
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.build(infos);
    }
    this.paint(infos);
    this.modal.refresh();
  }

  /** Rebuild the 배양 칸 rows — only when the tank (or its level) changed. */
  private build(infos: readonly CultureSlotInfo[]): void {
    this.debug.builds++;
    this.hideTip();
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '배양조가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) {
      if (info.locked) { el('div', { cls: 'cult-slot is-locked', parent: this.slotsEl }); continue; }   // 잠긴 칸 = 빈 칸
      this.cards.push(this.buildSlot(this.slotsEl, info));
    }
  }

  private buildSlot(parent: HTMLElement, info: CultureSlotInfo): SlotCard {
    const s = String(info.slot);
    const wrap = el('div', { cls: 'cult-slot', attrs: { 'data-slot': s }, parent });
    const cell = el('div', { cls: 'cult-cell', attrs: { 'data-slot': s }, parent: wrap });
    const fluid = el('i', { cls: 'cult-fluid', parent: cell });   // 배지가 관 안을 채운다 (온실 흙구멍의 흙과 같은 몸짓)
    const glyph = el('span', { cls: 'cult-glyph', text: '', parent: cell });
    const body = el('div', { cls: 'cult-slot-body', parent: wrap });
    const name = el('div', { cls: 'cult-name', text: '', parent: body });
    const time = el('div', { cls: 'cult-time hs-clock', text: '', parent: body });
    const prog = el('div', { cls: 'cult-prog', parent: body });
    const fill = el('i', { parent: prog });
    return { slot: info.slot, wrap, cell, fluid, glyph, name, time, prog, fill };
  }

  /** Cheap repaint: fluid, glyph, name, clock and progress only. */
  private paint(infos: readonly CultureSlotInfo[] = this.housing.getCultureSlots(this.uid)): void {
    this.debug.paints++;
    const bySlot = new Map<number, CultureSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const hasMedium = !!info.mediumDefId;
      const running = !!info.strainDefId;
      toggleClass(card.wrap, 'has-medium', hasMedium);
      toggleClass(card.wrap, 'is-running', running);
      toggleClass(card.wrap, 'is-ready', info.ready);

      const mediumDef = hasMedium ? this.housing.defOf(info.mediumDefId!) : undefined;
      const color = mediumDef?.color ?? '';
      if (card.fluid.dataset.c !== color) { card.fluid.dataset.c = color; card.fluid.style.background = color; }

      const strainDef = running ? this.housing.defOf(info.strainDefId!) : undefined;
      setText(card.glyph, running ? (strainDef?.icon || '◍') : hasMedium ? '+' : '');
      setText(card.name, running ? (strainDef?.name ?? '세포주') : mediumDef?.name ?? '');
      if (!running) renderClockText(card.time, '');
      else if (info.ready) renderClockText(card.time, '수확 가능');
      else renderClock(card.time, info.remainingS);

      card.prog.hidden = !running || info.ready;
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';
    }
    if (this.hoverSlot !== null && this.tip.isShown) {
      const spec = this.tipSpec(this.hoverSlot);
      if (spec) this.tip.update(spec);
      else this.hideTip();
    }
  }

  override dispose(): void {
    this.stopTicking();
    this.drag.dispose();
    this.modal.dispose();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}

/** 「배지 등급」 한 줄: 등급이 좋을수록 배양이 빠르다 (수치는 넣는 순간 이미 확정돼 있다). */
function speedText(info: CultureSlotInfo): string {
  const cut = Math.round((1 - info.mediumSpeedMul) * 100);
  return cut > 0 ? `+${cut} %` : '기본';
}
