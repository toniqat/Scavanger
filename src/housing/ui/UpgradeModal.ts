import type { CraftIngredient, GameContext } from '@/shared';
import { UI_HOLD_CONFIRM_S } from '@/shared';
import type { PanelOverlay } from './Panel';
import type { CostSource } from './dom';
import { clear, el, renderCost, setText, toggleClass } from './dom';

/** What the modal shows for one piece of furniture — re-read on every refresh (재료가 가방 · 창고에서 오갈 수 있다). */
export interface UpgradeSpec {
  /** 가구 이름 (`FurnitureDef.name`). */
  name: string;
  level: number;
  maxLevel: number;
  /** 다음 레벨이 여는 것 한 줄 (`아래 재배층 개방` · `해석 칸 +1`), 없으면 빈 문자열. */
  gain: string;
  /** Next level's materials (`nextFurnitureCost`), null at the last level. */
  cost: readonly CraftIngredient[] | null;
  /** `furnitureUpgradeBlock(uid)` — null = 강화할 수 있다. */
  reason: string | null;
}

const ESCAPE_TOKEN = 'housing.upgrade';
/** Cost chip edge inside the modal (px) — bigger than the inline 32 px chips, the chips are the whole content. */
const MODAL_CHIP_SIZE = 44;

/**
 * **업그레이드 모달** (2026-09-12) — 가구 화면 머리줄 오른쪽 「업그레이드」가 연다. 옛 「강화 줄」(`.gs-up` · `.az-up` ·
 * `.ct-up`)을 대신한다.
 *
 * 재료를 소모하는 확정이라 제작 · 분해 · 거래와 같은 **`UI_HOLD_CONFIRM_S` 홀드**다 (사용자 결정): 클릭만으로는 아무
 * 일도 없고, 누르는 동안 채움 바가 버튼을 쓸고 가며 도중에 놓거나 벗어나면 0 으로 돌아간다. **Enter 는 삼킨다.**
 * Escape 는 `ctx.escape` 스택으로 닫힌다 (패널보다 위에 쌓인다), E · Tab 은 패널이 `PanelOverlay` 로 먼저 닫는다.
 *
 * 홀드는 rAF 가 아니라 `setInterval` + 실제 경과 시간으로 잰다 — 숨겨진 탭 · 헤드리스에서 rAF 가 멈춰도 확정이
 * 영영 안 되는 일이 없게.
 */
export class UpgradeModal implements PanelOverlay {
  readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly lvEl: HTMLElement;
  private readonly gainEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly okBtn: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private spec: (() => UpgradeSpec | null) | null = null;
  private run: (() => void) | null = null;
  private hold = 0;
  private holdStart = 0;
  private holdTimer = 0;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.root.hidden) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  /** 포인터를 어디서 놓든 홀드가 남지 않게 `window` 에서 듣는다. */
  private readonly onUp = (): void => this.stopHold();

  constructor(private readonly ctx: GameContext, parent: HTMLElement, private readonly costs: CostSource) {
    this.root = el('div', { cls: 'hs-modal', parent });
    this.root.hidden = true;
    const card = el('div', { cls: 'hs-modal-card', parent: this.root });
    this.titleEl = el('div', { cls: 'hs-modal-title', text: '', parent: card });
    this.lvEl = el('div', { cls: 'hs-modal-lv', text: '', parent: card });
    this.gainEl = el('div', { cls: 'hs-modal-gain', text: '', parent: card });
    this.costEl = el('div', { cls: 'hs-modal-cost', parent: card });
    this.noteEl = el('div', { cls: 'hs-modal-note', text: '', parent: card });
    const foot = el('div', { cls: 'hs-modal-foot', parent: card });
    const no = el('button', { cls: 'ui-btn', text: '취소', parent: foot });
    this.okBtn = el('button', { cls: 'ui-btn primary hs-hold hs-modal-ok', parent: foot });
    this.fill = el('i', { cls: 'hs-hold-fill', parent: this.okBtn });
    el('span', { cls: 'hs-hold-label', text: '업그레이드', parent: this.okBtn });
    no.type = 'button';
    this.okBtn.type = 'button';
    no.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.okBtn.addEventListener('click', (e) => e.stopPropagation());          // 클릭은 확정하지 않는다 — 홀드만
    this.okBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.startHold();
    });
    this.okBtn.addEventListener('pointerleave', () => this.stopHold());
    // 바깥(어두운 막)을 누르면 닫는다
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
  }

  get isOpen(): boolean { return !this.root.hidden; }
  /** 홀드 진행도 0..1 (스모크). */
  get holdProgress(): number { return this.hold; }

  /** Open for one piece of furniture. `spec` is re-read on every `refresh()`; `run` performs the upgrade. */
  open(spec: () => UpgradeSpec | null, run: () => void): void {
    this.spec = spec;
    this.run = run;
    const wasOpen = this.isOpen;
    this.root.hidden = false;
    this.resetHold();
    this.refresh();
    if (!this.isOpen || wasOpen) return;         // the furniture vanished (refresh closed us) / already listening
    this.ctx.escape.push(ESCAPE_TOKEN, () => this.close());
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerup', this.onUp, true);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** Repaint from the spec (the panel calls this on every housing / inventory change while open). */
  refresh(): void {
    if (this.root.hidden) return;
    const s = this.spec?.() ?? null;
    if (!s) { this.close(); return; }
    const atMax = s.level >= s.maxLevel;
    setText(this.titleEl, `${s.name} 업그레이드`);
    setText(this.lvEl, atMax ? `Lv. ${s.level} · 최대 레벨` : `Lv. ${s.level}  →  Lv. ${s.level + 1}`);
    setText(this.gainEl, atMax ? '' : s.gain);
    this.gainEl.hidden = atMax || !s.gain;
    if (atMax || !s.cost) clear(this.costEl);
    else renderCost(this.costEl, s.cost, this.costs, MODAL_CHIP_SIZE);
    const blocked = atMax ? '최대 레벨입니다' : s.reason;
    setText(this.noteEl, blocked ?? `「업그레이드」를 ${UI_HOLD_CONFIRM_S}초 동안 누르고 있으면 강화합니다`);
    toggleClass(this.noteEl, 'bad', !!blocked);
    this.okBtn.disabled = !!blocked;
    if (blocked) this.stopHold();
  }

  close(): void {
    if (this.root.hidden) return;
    this.stopHold();
    this.root.hidden = true;
    this.spec = null;
    this.run = null;
    this.ctx.escape.remove(ESCAPE_TOKEN);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('pointerup', this.onUp, true);
  }

  /* ── 홀드 확인 ────────────────────────────────────────────────────────── */
  private startHold(): void {
    if (this.okBtn.disabled || this.holdTimer) return;
    this.holdStart = performance.now();
    this.holdTimer = window.setInterval(() => {
      const dur = Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000;
      this.hold = Math.min(1, (performance.now() - this.holdStart) / dur);
      this.fill.style.width = `${(this.hold * 100).toFixed(1)}%`;
      if (this.hold >= 1) this.confirm();
    }, 16);
  }

  private stopHold(): void {
    if (this.holdTimer) { clearInterval(this.holdTimer); this.holdTimer = 0; }
    this.resetHold();
  }

  private resetHold(): void {
    this.hold = 0;
    this.fill.style.width = '0%';
  }

  private confirm(): void {
    const run = this.run;
    this.close();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    run?.();
  }

  dispose(): void { this.close(); this.root.remove(); }
}
