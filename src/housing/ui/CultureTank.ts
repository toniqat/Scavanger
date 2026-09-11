import type {
  CultureSlotInfo, EmbeddedView, FurnitureDef, GameContext, ItemInstance, PlacedFurniture,
} from '@/shared';
import { CULTURE_MAX_SLOTS, cultureSlotsForLevel } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { furnitureMaxLevel, nextFurnitureCost } from '../Rules';
import { HousingPanel } from './Panel';
import { CHIP_SIZE, clear, el, formatRemaining, levelText, renderCost, setText, toggleClass } from './dom';

/** How often the countdowns / progress bars are refreshed while the panel is open (ms). */
const TICK_MS = 1000;

interface SlotCard {
  slot: number;
  cell: HTMLElement;
  fluid: HTMLElement;
  glyph: HTMLElement;
  prog: HTMLElement;
  fill: HTMLElement;
  line: HTMLElement;
  sub: HTMLElement;
  harvest: HTMLButtonElement;
  clear: HTMLButtonElement;
}

/**
 * **배양 화면** (배양조 A-14, 2026-09-11 — `openCultureTank(uid)` ← E on a 배양조).
 *
 * `ui/GrowStation.ts` · `ui/Analyzer.ts` 가 그대로 본보기다: **좌 = 강화 줄 + 배양 칸, 우 = 가방 · 함선 창고.**
 * 배양 칸은 `CULTURE_MAX_SLOTS` 개를 **언제나** 그리고 잠긴 칸은 딤드 + 「Lv.N 강화로 열립니다」다 (드롭 대상이
 * 아니다 — `dropSelector` 가 `:not(.is-locked)` 이다). 한 칸은 **두 단계**라 온실의 화분과 같은 몸짓이다:
 * 배지를 끌어다 놓으면 관 안이 배지 색으로 차오르고, 그 위에 세포주를 넣으면 진행바 · 남은 실시간 · 수확
 * 버튼이 산다.
 *
 * 화면은 상태를 **읽기만** 한다 — 타이머는 `ShipState.cultures` 에 있고, 1초 틱은 글자 · 바 · 버튼만 다시
 * 칠한다 (재구축 없음). 강화 줄은 `.gs-up` · `.az-up` 과 같은 판단이라 **1초 홀드가 없다** (되돌릴 수 있는 확정).
 */
export class CultureTank extends HousingPanel {
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
  private readonly btnAll: HTMLButtonElement;
  private grids: EmbeddedView | null = null;
  private cards: SlotCard[] = [];
  private timer = 0;

  constructor(ctx: GameContext, private readonly housing: HousingSystem) {
    super(ctx, 'culture', 'culture-tank');
    const f = this.frame;
    const head = el('div', { cls: 'hs-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.title = el('div', { cls: 'title', text: '배양조', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });

    const body = el('div', { cls: 'ct-body', parent: f });
    const left = el('div', { cls: 'ct-left', parent: body });

    // 강화 줄 — 배양 칸을 여는 유일한 입구 (가구 레벨 = 열린 칸 수), 분석기의 `.az-up` 과 같은 결
    this.upRow = el('div', { cls: 'ct-up', parent: left });
    const upMain = el('div', { cls: 'ct-up-main', parent: this.upRow });
    const upHead = el('div', { cls: 'ct-up-head', parent: upMain });
    this.upLevel = el('span', { cls: 'lv', text: '', parent: upHead });
    this.upNext = el('span', { cls: 'next', text: '', parent: upHead });
    this.upCost = el('div', { cls: 'ct-up-cost', parent: upMain });
    this.upNote = el('div', { cls: 'ct-up-note', text: '', parent: upMain });
    this.btnUp = this.button(this.upRow, '강화', () => this.upgrade(), 'small primary ct-up-btn');

    this.slotsEl = el('div', { cls: 'ct-slots', parent: left });

    const right = el('div', { cls: 'ct-right', parent: body });
    el('div', { cls: 'ui-label', text: '가방 · 함선 창고', parent: right });
    this.invNote = el('div', { cls: 'hint', text: '영양 배지를 먼저 붓고, 그 위에 세포주를 끌어다 놓으세요.', parent: right });
    this.invHost = el('div', { cls: 'ct-inv', parent: right });

    this.mountMsg();
    const foot = el('div', { cls: 'hs-foot', parent: f });
    const footLeft = el('div', { cls: 'left', parent: foot });
    this.btnAll = this.button(footLeft, '모두 수확', () => this.harvestAll(), 'primary');
    el('div', { cls: 'hint', text: '배양은 현실 시간에 맞춰 진행됩니다 — 함선을 떠나도 계속 자랍니다.', parent: footLeft });
    this.button(el('div', { cls: 'right', parent: foot }), '닫기', () => this.close());
  }

  /* ── open / close ──────────────────────────────────────────────────────── */
  /** Open the panel for one 배양조. */
  openTank(uid: string): void {
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
    setText(this.invNote, '영양 배지를 먼저 붓고, 그 위에 세포주를 끌어다 놓으세요.');
    this.grids = inv.createTradeGrids(this.invHost, {
      grids: ['bag', 'stash'],
      dropSelector: '.ct-cell:not(.is-locked)',
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
  /** A tile was dragged out of the 가방 / 창고 onto a 배양 칸 (or double-clicked, `target` null). */
  private dropOn(item: ItemInstance, target: HTMLElement | null): void {
    if (!target) { this.showMsg('배지 · 세포주를 배양 칸으로 끌어다 놓으세요', 'info'); return; }
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
    this.refresh();
  }

  private harvest(slot: number): void {
    const reason = this.housing.harvestCulture(this.uid, slot);
    this.showMsg(reason ?? '수확 완료 — 가방이 차면 함선 창고로 들어갑니다', reason ? 'warning' : 'success');
    this.refresh();
  }

  private clearMedium(slot: number): void {
    const reason = this.housing.clearMedium(this.uid, slot);
    this.showMsg(reason ?? '배지를 비웠습니다 (남은 횟수는 돌려받지 않습니다)', reason ? 'warning' : 'info');
    this.refresh();
  }

  private harvestAll(): void {
    const n = this.housing.harvestAllCultures(this.uid);
    this.showMsg(n > 0 ? `${n}칸 수확 완료` : '수확할 수 있는 칸이 없습니다', n > 0 ? 'success' : 'info');
    this.refresh();
  }

  /**
   * 배양조 한 단계 강화 = 배양 칸 한 개 개방. 규칙 · 재료 소모는 전부 `HousingRef.upgradeFurniture` 안에 있고
   * 여기서는 그 앞에 `furnitureUpgradeBlock` 의 한국어 사유를 한 번 더 보여 줄 뿐이다.
   */
  private upgrade(): void {
    const reason = this.housing.furnitureUpgradeBlock(this.uid);
    if (reason) { this.showMsg(reason, 'warning'); return; }
    const before = this.housing.getPlacedByUid(this.uid)?.level ?? 0;
    if (this.housing.upgradeFurniture(this.uid)) {
      const opened = cultureSlotsForLevel(before + 1) - cultureSlotsForLevel(before);
      this.showMsg(`배양조 Lv.${before + 1}${opened > 0 ? ` — 배양 칸 ${opened}개 개방` : ''}`, 'success');
    } else {
      this.showMsg('강화에 실패했습니다', 'danger');
    }
    this.refresh();                 // 새 칸 + 재료가 빠진 가방 · 창고를 곧바로 그린다
  }

  /* ── state → DOM ───────────────────────────────────────────────────────── */
  refresh(): void {
    const h = this.housing;
    const tank = h.getPlacedByUid(this.uid);
    const def = tank ? h.getFurnitureDef(tank.defId) : undefined;
    setText(this.title, tank ? `배양조 · 방 ${tank.room + 1}` : '배양조');
    const open = tank ? cultureSlotsForLevel(tank.level) : 0;
    setText(this.subtitle, tank
      ? `Lv.${tank.level} / ${def?.maxLevel ?? tank.level} · 배양 칸 ${open} / ${CULTURE_MAX_SLOTS}`
      : '배양조가 사라졌습니다.');

    this.paintUpgrade(tank, def);
    this.build(h.getCultureSlots(this.uid));
    this.grids?.refresh();          // 배지 · 세포주 · 강화 재료 · 산출물이 오간 것이 곧바로 보이도록
    this.paint();
  }

  /** 강화 줄: 현재 레벨 · 다음 레벨이 여는 칸 수 · 비용 칩 · 버튼 (사유는 `furnitureUpgradeBlock` 한 줄). */
  private paintUpgrade(tank: PlacedFurniture | null, def: FurnitureDef | undefined): void {
    const max = def ? furnitureMaxLevel(def) : 0;
    const level = tank?.level ?? 0;
    const atMax = !tank || !def || level >= max;
    setText(this.upLevel, tank && def ? levelText(level, max) : '—');

    const cost = tank && def ? nextFurnitureCost(def, level) : null;
    if (cost) {
      renderCost(this.upCost, cost, this.housing, CHIP_SIZE);
    } else {
      clear(this.upCost);
      el('span', { cls: 'item-chip-free', text: atMax ? '최대 레벨' : '—', parent: this.upCost });
    }

    // 다음 레벨이 여는 칸 수는 계약 `cultureSlotsForLevel` 에서 유도한다 (칸 수를 코드에 적지 않는다)
    const opened = tank && !atMax ? cultureSlotsForLevel(level + 1) - cultureSlotsForLevel(level) : 0;
    setText(this.upNext, opened > 0
      ? `강화하면 배양 칸 ${opened}개 개방`
      : atMax && tank ? '모든 배양 칸이 열렸습니다' : '');

    const reason = tank ? this.housing.furnitureUpgradeBlock(this.uid) : '배양조가 사라졌습니다';
    setText(this.upNote, reason ?? '강화할 수 있습니다');
    toggleClass(this.upNote, 'ok', !reason);
    this.btnUp.disabled = !!reason;
    this.btnUp.title = reason ?? '';
    toggleClass(this.upRow, 'is-max', atMax);
  }

  /** Rebuild the 배양 칸 cards (the tank level may have changed since the last open). */
  private build(infos: readonly CultureSlotInfo[]): void {
    clear(this.slotsEl);
    this.cards = [];
    if (!infos.length) {
      el('div', { cls: 'hs-empty', text: '배양조가 없습니다', parent: this.slotsEl });
      return;
    }
    for (const info of infos) this.cards.push(this.buildSlot(this.slotsEl, info));
  }

  private buildSlot(parent: HTMLElement, info: CultureSlotInfo): SlotCard {
    const wrap = el('div', { cls: 'ct-slot', parent });
    const cell = el('div', {
      cls: `ct-cell${info.locked ? ' is-locked' : ''}`,
      attrs: info.locked ? {} : { 'data-slot': String(info.slot) },
      parent: wrap,
    });
    const fluid = el('i', { cls: 'ct-fluid', parent: cell });   // 배지가 관 안을 채운다 (온실 화분의 흙과 같은 몸짓)
    const glyph = el('span', { cls: 'ct-glyph', text: '', parent: cell });
    const body = el('div', { cls: 'ct-slot-body', parent: wrap });
    const line = el('div', { cls: 'ct-line', text: '', parent: body });
    const sub = el('div', { cls: 'ct-sub', text: '', parent: body });
    const prog = el('div', { cls: 'ct-prog', parent: body });
    const fill = el('i', { parent: prog });
    const acts = el('div', { cls: 'ct-acts', parent: body });
    const harvest = this.button(acts, '수확', () => this.harvest(info.slot), 'small primary');
    const clearBtn = this.button(acts, '배지 비우기', () => this.clearMedium(info.slot), 'small');
    return { slot: info.slot, cell, fluid, glyph, prog, fill, line, sub, harvest, clear: clearBtn };
  }

  /** Cheap per-second repaint: fluid level, glyph, progress, countdown and button states only. */
  private paint(): void {
    const infos = this.housing.getCultureSlots(this.uid);
    const bySlot = new Map<number, CultureSlotInfo>();
    for (const i of infos) bySlot.set(i.slot, i);
    let ready = 0;
    for (const card of this.cards) {
      const info = bySlot.get(card.slot);
      if (!info) continue;
      const hasMedium = !!info.mediumDefId;
      const running = !!info.strainDefId;
      if (info.ready) ready++;
      toggleClass(card.cell, 'has-medium', hasMedium);
      toggleClass(card.cell, 'is-running', running);
      toggleClass(card.cell, 'is-ready', info.ready);

      // 배지: 관 안이 배지 색(아이템 색)으로 78 % 높이까지 찬다 — 외부 에셋 없이 아이템 표의 색만 쓴다
      card.fluid.style.height = hasMedium ? '78%' : '0%';
      const mediumDef = info.mediumDefId ? this.housing.defOf(info.mediumDefId) : undefined;
      if (mediumDef) card.fluid.style.background = mediumDef.color;

      const strainDef = info.strainDefId ? this.housing.defOf(info.strainDefId) : undefined;
      setText(card.glyph, info.locked ? '🔒' : running ? (strainDef?.icon || '◍') : hasMedium ? '+' : '');

      card.prog.hidden = !running;
      card.fill.style.width = running ? `${Math.round(Math.max(0, info.progress) * 100)}%` : '0%';

      if (info.locked) {
        setText(card.line, '잠긴 배양 칸');
        setText(card.sub, `Lv.${info.unlockLevel} 강화로 열립니다 · 위 「강화」`);
      } else if (!hasMedium) {
        setText(card.line, '배지 없음');
        setText(card.sub, '영양 배지를 끌어다 놓으세요');
      } else if (!running) {
        setText(card.line, `${this.housing.nameOf(info.mediumDefId!)} · 수확 ${info.mediumUsesLeft}회 남음`);
        setText(card.sub, `${this.speedText(info)} · 세포주를 끌어다 놓으세요`);
      } else if (info.ready) {
        const name = info.yieldDefId ? this.housing.nameOf(info.yieldDefId) : '배양 산물';
        setText(card.line, `${name} ×${info.yieldQty} 수확 준비`);
        setText(card.sub, `배지 ${info.mediumUsesLeft}회 남음 · 수확하면 1회 소모`);
      } else {
        setText(card.line, `${formatRemaining(info.remainingS)} 남음`);
        setText(card.sub, `${strainDef?.name ?? '세포주'} · ${this.speedText(info)}`);
      }

      card.harvest.hidden = !running;
      card.harvest.disabled = !info.ready;
      card.clear.hidden = !hasMedium || running;
    }
    this.btnAll.disabled = ready === 0;
    setText(this.btnAll, ready > 0 ? `모두 수확 (${ready})` : '모두 수확');
  }

  /** 「배지 등급」 한 줄: 등급이 좋을수록 배양이 빠르다 (수치는 넣는 순간 이미 확정돼 있다). */
  private speedText(info: CultureSlotInfo): string {
    const cut = Math.round((1 - info.mediumSpeedMul) * 100);
    return cut > 0 ? `배양 속도 +${cut} %` : '기본 배양 속도';
  }

  override dispose(): void {
    this.stopTicking();
    this.grids?.dispose();
    this.grids = null;
    super.dispose();
  }
}
