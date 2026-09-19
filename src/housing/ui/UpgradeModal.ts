import type { CraftIngredient, FacilityRequirement, GameContext } from '@/shared';
import { FACILITY_COLOR, FACILITY_GLYPH, FACILITY_LABEL_KO, Keys, UI_HOLD_CONFIRM_S, buildFacilityChip, createHoldButtonCap } from '@/shared';
import type { PanelOverlay } from './Panel';
import type { CostSource } from './dom';
import { clear, el, facilityChipTip, renderCost, setText, toggleClass } from './dom';

/**
 * What the modal shows for **one upgradable thing** — re-read on every refresh (materials can come and go between the
 * bag · the stash).
 *
 * 2026-09-16: what was furniture-only is **used by facilities too** (the stash upgrade). The fields were always just
 * 「name · level · what the next level opens · materials · the block reason」, nothing furniture-specific — only the
 * names were generalised, the look · the rules are unchanged.
 */
export interface UpgradeSpec {
  /** The subject's name (furniture `FurnitureDef.name` · facility `FACILITY_LABEL_KO`). */
  name: string;
  level: number;
  maxLevel: number;
  /** One line of what the next level opens (`아래 재배층 개방` · `해석 칸 +1`), an empty string when there is none. */
  gain: string;
  /** Next level's materials (`nextFurnitureCost`), null at the last level. */
  cost: readonly CraftIngredient[] | null;
  /** `furnitureUpgradeBlock(uid)` — null = it can be upgraded. */
  reason: string | null;
  /**
   * appended (2026-09-12): the unmet **facility level requirements** (`HousingRef.furnitureUpgradeRequirements(uid)` —
   * usually the generator). Drawn on the same row after the material chips, as a wide double-bordered chip
   * (`buildFacilityChip`, `현재 레벨/필요 레벨`).
   */
  requirements?: readonly FacilityRequirement[];
}

const ESCAPE_TOKEN = 'housing.upgrade';
/** Cost chip edge inside the modal (px) — bigger than the inline 32 px chips, the chips are the whole content. */
const MODAL_CHIP_SIZE = 44;

/**
 * 2026-09-16 (the stash upgrade): what is attached when it stands alone **outside** a furniture screen.
 *
 * With `standalone` the modal is a direct child of `ctx.uiRoot`, so it wears `.interactive` (= releases `#ui-root`'s
 * `pointer-events: none`) and `.hs-modal-top` (z above the inventory window, `housing.css`) itself, and **swallows Tab
 * to close itself too** — no panel closes it for it, and letting Tab through would close only the inventory window
 * behind it and leave the modal alone (§4.2 「Tab is the universal close key」). No blocker is added: the two places
 * that open this modal (the inventory Tab · the workbench window) already hold a blocker and the cursor.
 */
export interface UpgradeModalOptions {
  standalone?: boolean;
  /** Called once however it closed (cancel · Escape · Tab · an outside click · confirm) — the caller cuts its subscription. */
  onClose?(): void;
}

/**
 * **The upgrade modal** (2026-09-12) — opened by the 「업그레이드」 at the right of a furniture screen's header row. It
 * replaces the old 「강화 줄」 (`.gs-up` · `.az-up` · `.ct-up`). **Since 2026-09-16 facilities (the stash) use the same
 * modal** (`ui/StorageUpgrade.ts` — the `standalone` branch that stands on `ctx.uiRoot`, not on a furniture screen).
 * One look, one set of rules.
 *
 * It is a confirm that consumes materials, so it is a **`UI_HOLD_CONFIRM_S` hold** like craft · salvage · trade (user's
 * decision): a click alone does nothing, a fill bar sweeps the button while it is held, and releasing or leaving part
 * way returns it to 0. **Enter is swallowed.** Escape closes it through the `ctx.escape` stack (it stacks above the
 * panel); E · Tab are closed first by the panel through `PanelOverlay`.
 *
 * The hold is measured with `setInterval` + real elapsed time, not rAF — so a hidden tab · headless, where rAF stops,
 * can still reach the confirm.
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
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // 2026-09-16: a standalone modal eats Tab itself and closes (keys are always read at use time — `docs/CONTROLS.md`)
    if (this.opts.standalone && e.code === Keys.INVENTORY) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
  };

  /** Listened for on `window`, so no hold is left behind wherever the pointer is released. */
  private readonly onUp = (): void => this.stopHold();

  constructor(
    private readonly ctx: GameContext,
    parent: HTMLElement,
    private readonly costs: CostSource,
    private readonly opts: UpgradeModalOptions = {},
  ) {
    this.root = el('div', { cls: opts.standalone ? 'hs-modal hs-modal-top interactive' : 'hs-modal', parent });
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
    // 2026-09-15, 2nd pass (user's decision): the left-click hold keycap **inside** the button instead of a 「hold for N seconds …」 hint line.
    createHoldButtonCap(this.okBtn);
    el('span', { cls: 'hs-hold-label', text: '업그레이드', parent: this.okBtn });
    no.type = 'button';
    this.okBtn.type = 'button';
    no.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    this.okBtn.addEventListener('click', (e) => e.stopPropagation());          // a click never confirms — only the hold
    this.okBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.startHold();
    });
    this.okBtn.addEventListener('pointerleave', () => this.stopHold());
    // pressing outside (the dark backdrop) closes it
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(); });
  }

  get isOpen(): boolean { return !this.root.hidden; }
  /** Hold progress 0..1 (for the smoke test). */
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
    // 2026-09-12: a facility level requirement (generator Lv.n) goes **on the same row after** the material chips — a wide double-bordered chip nothing confuses with an item
    if (!atMax) {
      for (const q of s.requirements ?? []) {
        // 2026-09-15 (user's decision): the chip draws only the icon and the hover tooltip says the facility name · level (`facilityChipTip`)
        this.costEl.appendChild(facilityChipTip(
          buildFacilityChip(FACILITY_LABEL_KO[q.facility], FACILITY_GLYPH[q.facility], FACILITY_COLOR[q.facility], q.have, q.need, { size: MODAL_CHIP_SIZE }),
          FACILITY_LABEL_KO[q.facility], q.have, q.need));
      }
    }
    const blocked = atMax ? '최대 레벨입니다' : s.reason;
    // 2026-09-15, 2nd pass (user's decision): this line says only the **block reason** — the keycap inside the button
    // carries the hold hint, and with nothing blocking the line itself goes (`hidden`, so an empty line does not eat the card's `gap`).
    setText(this.noteEl, blocked ?? '');
    this.noteEl.hidden = !blocked;
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
    this.opts.onClose?.();
  }

  /* ── the hold confirm ─────────────────────────────────────────────────── */
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
