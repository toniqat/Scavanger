import type { CraftRecipe, ItemDef } from '@/shared';
import { UI_HOLD_CONFIRM_S, buildItemChip, createHoldButtonCap, renderItemCost } from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { Modeless } from './Modeless';
import { TEXT } from './labels';

/**
 * Phase 8 — the **item salvage** dialog.
 *
 * Salvage used to be four `break_ammo_*` rows in the craft list; it is now a `분해` entry in the item context menu that
 * opens this **modeless** popup over the inventory window. The dialog is a *preview of the expected result*: the
 * input item chip (보유/필요, dimmed + red when short) `→` the output item chip (×n), the craft duration, and a
 * 분해 button that runs the very recipe the craft panel would have run (`InventorySystem.craft`).
 *
 * Like every modeless popup it adds no blocker and never exits the pointer lock — the window owns both — and it is
 * dismissed by Escape (through `InventoryUI.closeOverlays()`), by the 닫기 button or by a pointerdown outside it.
 * Emits `ui:disassembleToggled {open, uid}` on both edges.
 *
 * Phase 12 (2026-09-08) — **the salvage gauge**: while the hold runs, the `분해 중…` **button itself** fills 0 → 100 % in real
 * time (`.inv-craft-fill`). It is driven per frame by `tick()` (called from `InventoryUI.refreshCraft`, which the
 * system calls from `updateCraft` every frame the job advances) — the width *is* the job's progress, carried only by
 * the fill's own 80 ms smoothing. The panel also reports the hold through `onProgress` → the window emits
 * `inventory:disassembleProgress {uid, t, done}`: at most every `PROGRESS_EMIT_MS` while running, exactly once with
 * `done:true` when the recipe completes, and `{t:0, done:false}` when a cancel (button / close / death) resets it.
 *
 * **2026-09-08 (salvage UX)**: three cuts, all of them the same complaint — the dialog told you things after the fact.
 *  - The `1회 분해 · 2.0 s` line under the preview is gone; the duration is what the button fill shows.
 *  - The second horizontal bar under the button is gone too — the button *is* the progress bar.
 *  - **Room comes first** (`InventorySystem.craftHasRoom`, 2026-09-09 — on the ship stash → bag since the
 *    2026-09-15 2nd pass). The bag used to be checked when the hold ended, so a full bag cost you the hold and then
 *    said no; the button now refuses up front with the reason on it.
 *
 * **2026-09-10 (craft rework, stage 2)** — the output rides the **remaining durability**. The popup resolves the
 * recipe again on every `refresh()` instead of once on open (`disassembleRecipeFor(uid)` = `ctx.loot.getSalvageFor(inst)`),
 * and asks the room check about that item too. It used to draw the static `break_*` row (bucket 4), so **a fully
 * broken `방탄복 I` still read `폐금속 4 + 천조각 2`** — what actually comes out is `폐금속 1`. The one
 * `.inv-dur-note` line under the preview names the current bucket and its multiplier.
 */
/** Minimum spacing of two `inventory:disassembleProgress` emits (≤ 30 Hz). */
const PROGRESS_EMIT_MS = 1000 / 30;

/** One captioned side of the 재료 → 결과물 preview. */
function column(caption: string, host: HTMLElement): HTMLElement {
  const col = document.createElement('div');
  col.className = 'inv-dis-col';
  const cap = document.createElement('div');
  cap.className = 'inv-eyebrow';
  cap.textContent = caption;
  col.append(cap, host);
  return col;
}

export class DisassemblePanel {
  private readonly shell: Modeless;
  private readonly preview: HTMLElement;
  private readonly inputHost: HTMLElement;
  private readonly outputHost: HTMLElement;
  /** The remaining durability bucket + that bucket's salvage multiplier (2026-09-10). Hidden for an item with no durability. */
  private readonly durEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private readonly buttonLabel: HTMLElement;
  private uid: string | null = null;
  private recipe: CraftRecipe | null = null;
  private running = false;
  private msgTimer: number | null = null;
  /** `performance.now()` of the last progress emit (throttle). */
  private lastEmitAt = -Infinity;
  /** Last progress written to the bar (-1 = idle); skips a DOM write when nothing moved. */
  private lastT = -1;
  /** A progress report went out for the current hold (so a cancel owes the `{t:0}` reset). */
  private reported = false;
  /*
   * 2026-09-12 (E1, user's decision) — **a favourite item is asked about once more before salvage.** Exactly the warning
   * popup's contract: confirming is holding the red `분해` for `UI_HOLD_CONFIRM_S` alone (not a click, not Enter); `취소` ·
   * Escape · Tab withdraw the card only (`InventoryUI.closePopups` → `cancelConfirm`). One confirm covers that one salvage.
   */
  private readonly confirmEl: HTMLElement;
  private readonly confirmBody: HTMLElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly confirmOk: HTMLButtonElement;
  private readonly confirmFill: HTMLElement;
  /** The uid whose salvage was just confirmed (the next `run()` for it skips the card once). */
  private confirmedUid: string | null = null;
  private holdRaf = 0;
  private holdStart = 0;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    private readonly onToggled: (open: boolean, uid: string | null) => void,
    /** Phase 12: `inventory:disassembleProgress` sink (the window owns the bus). */
    private readonly onProgress: (uid: string, t: number, done: boolean) => void = () => {},
  ) {
    this.shell = new Modeless('disassemble', () => this.finishClose());
    this.shell.withHeader(TEXT.disassemble.eyebrow, TEXT.disassemble.title);

    this.preview = document.createElement('div');
    this.preview.className = 'inv-dis-preview';
    this.inputHost = document.createElement('div');
    this.inputHost.className = 'inv-dis-side';
    const arrow = document.createElement('div');
    arrow.className = 'inv-dis-arrow';
    arrow.textContent = TEXT.disassemble.arrow;
    this.outputHost = document.createElement('div');
    this.outputHost.className = 'inv-dis-side';
    this.preview.append(
      column(TEXT.disassemble.input, this.inputHost), arrow, column(TEXT.disassemble.output, this.outputHost),
    );

    // 2026-09-10: the output rides the remaining durability, so it says **which bucket makes this number**
    // (the craft rework's durability buckets — CLAUDE.md §4.7, `items/Salvage`).
    this.durEl = document.createElement('div');
    this.durEl.className = 'inv-dur-note';
    this.durEl.hidden = true;

    this.msgEl = document.createElement('div');
    this.msgEl.className = 'inv-dis-msg';
    this.msgEl.hidden = true;

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'inv-btn inv-craft-btn inv-dis-btn';
    this.fill = document.createElement('i');
    this.fill.className = 'inv-craft-fill';
    this.buttonLabel = document.createElement('span');
    this.buttonLabel.textContent = TEXT.disassemble.button;
    this.button.append(this.fill, this.buttonLabel);
    this.button.addEventListener('click', () => this.run());

    this.shell.body.append(this.preview, this.durEl, this.msgEl, this.button);

    // 2026-09-12 (E1): the favourite confirm card (hidden most of the time)
    this.confirmEl = document.createElement('div');
    this.confirmEl.className = 'inv-dis-confirm';
    this.confirmEl.hidden = true;
    const cTitle = document.createElement('div');
    cTitle.className = 'inv-dis-confirm-title';
    cTitle.textContent = `★ ${TEXT.favorite.confirmTitle}`;
    this.confirmBody = document.createElement('div');
    this.confirmBody.className = 'inv-dis-confirm-body';
    const cRow = document.createElement('div');
    cRow.className = 'inv-dis-confirm-row';
    this.confirmCancel = document.createElement('button');
    this.confirmCancel.type = 'button';
    this.confirmCancel.className = 'inv-btn inv-dis-confirm-cancel';
    this.confirmCancel.textContent = TEXT.favorite.cancel;
    this.confirmCancel.addEventListener('click', () => { if (this.cancelConfirm()) this.sys.sfx('ui_drop'); });
    this.confirmOk = document.createElement('button');
    this.confirmOk.type = 'button';
    this.confirmOk.className = 'inv-btn inv-dis-confirm-ok';
    this.confirmFill = document.createElement('i');
    this.confirmFill.className = 'inv-dis-confirm-fill';
    const okLabel = document.createElement('span');
    okLabel.textContent = TEXT.favorite.confirm;
    // 2026-09-15 2nd pass (user's decision): the left-click hold keycap **inside** the button replaces the 「N초 동안 누르고 있어야 …」 line above the card.
    this.confirmOk.append(this.confirmFill, createHoldButtonCap(), okLabel);
    this.confirmOk.addEventListener('pointerdown', (e) => this.startHold(e));
    this.confirmOk.addEventListener('pointerleave', () => this.stopHold());
    // Enter / Space on the focused button never confirm — only the hold does
    this.confirmOk.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } });
    this.confirmOk.addEventListener('click', (e) => e.preventDefault());
    cRow.append(this.confirmCancel, this.confirmOk);
    this.confirmEl.append(cTitle, this.confirmBody, cRow);
    this.shell.body.append(this.confirmEl);
  }

  /* ── 2026-09-12 (E1): the favourite salvage confirm ──────────────────── */

  /** The confirm card is showing (smoke tests). */
  get isConfirming(): boolean { return !this.confirmEl.hidden; }
  /** The red hold-to-confirm button (smoke tests). */
  get confirmButton(): HTMLButtonElement { return this.confirmOk; }

  private needsFavoriteConfirm(uid: string): boolean {
    const item = this.sys.findItem(uid);
    return !!item && this.sys.isFavorite(item.defId) && this.confirmedUid !== uid;
  }

  private openConfirm(uid: string): void {
    const item = this.sys.findItem(uid);
    const def = item ? this.getDef(item.defId) : undefined;
    this.confirmBody.textContent = TEXT.favorite.confirmBody(def?.name ?? '');
    this.stopHold();
    this.confirmEl.hidden = false;
    this.button.style.display = 'none';
    this.sys.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.confirmCancel.focus({ preventScroll: true });
  }

  /** Close the confirm card (nothing is salvaged). True when it was showing — Escape / Tab consume that press. */
  cancelConfirm(): boolean {
    if (this.confirmEl.hidden) return false;
    this.stopHold();
    this.confirmEl.hidden = true;
    this.button.style.display = '';
    return true;
  }

  private startHold(e: PointerEvent): void {
    if (e.button !== 0 || this.holdRaf) return;
    e.preventDefault();
    this.holdStart = performance.now();
    window.addEventListener('pointerup', this.onHoldRelease, true);
    window.addEventListener('pointercancel', this.onHoldRelease, true);
    const step = (): void => {
      const t = Math.min(1, (performance.now() - this.holdStart) / (Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000));
      this.confirmFill.style.width = `${(t * 100).toFixed(1)}%`;
      if (t >= 1) { this.finishHold(); return; }
      this.holdRaf = requestAnimationFrame(step);
    };
    this.holdRaf = requestAnimationFrame(step);
  }

  private onHoldRelease = (): void => { this.stopHold(); };

  private stopHold(): void {
    if (this.holdRaf) { cancelAnimationFrame(this.holdRaf); this.holdRaf = 0; }
    window.removeEventListener('pointerup', this.onHoldRelease, true);
    window.removeEventListener('pointercancel', this.onHoldRelease, true);
    this.confirmFill.style.width = '0%';
  }

  private finishHold(): void {
    const uid = this.uid;
    this.cancelConfirm();
    if (!uid) return;
    this.confirmedUid = uid;
    this.run();
  }

  get el(): HTMLElement { return this.shell.el; }
  get isOpen(): boolean { return this.shell.isOpen; }
  /** The item currently previewed (smoke tests). */
  get itemUid(): string | null { return this.uid; }
  /** The salvage gauge element — the button itself since 2026-09-08 (smoke tests). */
  get barEl(): HTMLElement { return this.button; }
  /** 0..1 fill of the salvage gauge (0 while idle). */
  get progress(): number { return this.lastT < 0 ? 0 : this.lastT; }

  /** Open the dialog for `uid`; false when the item has no `break_*` recipe. */
  open(uid: string, anchor: HTMLElement | null = null): boolean {
    const recipe = this.sys.disassembleRecipeFor(uid);
    if (!recipe) return false;
    this.uid = uid;
    this.recipe = recipe;
    this.running = false;
    this.hideMsg();
    this.confirmedUid = null;   // 2026-09-12 (E1): a fresh dialog asks again
    this.cancelConfirm();
    this.refresh();
    this.shell.open(anchor);
    this.shell.place();
    this.onToggled(true, uid);
    // 2026-09-09 key guide: the `분해` button is a hold; Tab closes this popup before the window
    this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.disassemble', keys: [{ key: '홀드', label: '분해' }] });
    return true;
  }

  /** Returns true when the dialog was open (Escape consumed). */
  close(): boolean {
    if (!this.shell.close()) return false;
    this.finishClose();
    return true;
  }

  /** Shared tail of every close path (own 닫기 / outside click / owner `close()`). */
  private finishClose(): void {
    const uid = this.uid;
    if (this.running) { this.sys.cancelCraft(); this.running = false; }
    this.resetBar(uid);
    this.cancelConfirm();
    this.confirmedUid = null;
    this.uid = null;
    this.recipe = null;
    this.hideMsg();
    this.onToggled(false, uid);
    this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.disassemble', keys: null });
  }

  /** Repaint the chips / affordability. Called on open and from the window's `refresh()`. */
  refresh(): void {
    if (!this.recipe) return;
    // the item may have been consumed / moved away meanwhile
    if (this.uid && !this.sys.findItem(this.uid)) { this.close(); return; }
    // 2026-09-10: the output is a function of **the durability left right now** — resolved again every time so preview
    // and reality stay together (`disassembleRecipeFor` → `ctx.loot.getSalvageFor`); an item worn while the dialog is open is followed.
    const fresh = this.uid ? this.sys.disassembleRecipeFor(this.uid) : null;
    if (fresh) this.recipe = fresh;
    const r = this.recipe;
    const cost = this.sys.craftCost(r);
    const enough = renderItemCost(this.inputHost, cost, this.getDef, (id) => this.sys.countWhere((d) => d.id === id), { size: 46, withName: true });
    // 2026-09-08: a salvage yielding several materials (machine parts and the like) lines its output chips up side by side (`CraftRecipe.extraOutputs`)
    this.outputHost.replaceChildren(
      buildItemChip(this.getDef(r.outputDefId), { need: r.outputQty, size: 46, withName: true }),
      ...(r.extraOutputs ?? []).map((e) => buildItemChip(this.getDef(e.defId), { need: e.qty, size: 46, withName: true })),
    );
    this.paintDurability();
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    this.running = active;
    // 2026-09-08: cells first — the bag check that used to run when the hold ended now gates the button.
    // 2026-09-10: asked **about this item** — measuring by the static bucket-4 row puts the room count out of step.
    const room = this.sys.craftHasRoom(r.id, 1, this.uid ?? undefined);
    const noRoom = this.sys.ctx.isHubPhase() ? TEXT.disassemble.noRoomShip : TEXT.disassemble.noRoom;
    const block = !enough ? TEXT.disassemble.short : !room ? noRoom : '';
    this.button.disabled = !active && !!block;
    this.buttonLabel.textContent = active ? TEXT.disassemble.working : block || TEXT.disassemble.button;
    this.button.title = block;
    this.tick();
  }

  /**
   * **The remaining-durability bucket line** (2026-09-10, the craft rework — CLAUDE.md §4.7). `81~100 % · 제작 재료의 40 %` and one hint
   * line under it — it has to read that the output chips above change with the bucket. Every multiplier comes
   * from `ctx.loot.durabilityBucketInfo` (source `data/tables.csv`); there is no number here.
   * An item that uses no durability (ammo · materials · bags) is always bucket 4, so the line itself is hidden —
   * there is no reason to explain a gauge that does not exist.
   */
  private paintDurability(): void {
    const item = this.uid ? this.sys.findItem(this.uid) : null;
    const dur = item ? this.sys.getDurability(item.uid) : null;
    if (!item || !dur || dur.max <= 0) { this.durEl.hidden = true; return; }
    const info = this.sys.loot.durabilityBucketInfo(item);
    this.durEl.hidden = false;
    this.durEl.replaceChildren();
    const cap = document.createElement('span');
    cap.className = 'inv-eyebrow';
    cap.textContent = TEXT.durability.eyebrow;
    const val = document.createElement('b');
    val.textContent = TEXT.durability.salvage(info.label, info.salvageMul);
    const note = document.createElement('em');
    note.textContent = TEXT.durability.salvageNote;
    this.durEl.append(cap, val, note);
  }

  /**
   * Per-frame gauge update (Phase 12): the button fill and the horizontal bar follow the running job and the
   * progress is reported (throttled). Cheap on purpose — `InventoryUI.refreshCraft` calls it every frame the job
   * advances, unlike `refresh()` which rebuilds the chips.
   */
  tick(): void {
    const r = this.recipe;
    const uid = this.uid;
    if (!r || !uid) return;
    const job = this.sys.craftProgress();
    if (job?.recipeId !== r.id) {
      // idle (or a different craft): nothing to show; `run()` / `resetBar` own the transitions out of a hold
      if (this.lastT >= 0) this.clearBar();
      return;
    }
    const t = Math.max(0, Math.min(1, job.progress));
    this.running = true;
    if (t !== this.lastT) {
      this.fill.style.width = `${(t * 100).toFixed(1)}%`;
      this.lastT = t;
    }
    const now = performance.now();
    if (now - this.lastEmitAt >= PROGRESS_EMIT_MS) {
      this.lastEmitAt = now;
      this.reported = true;
      this.onProgress(uid, t, false);
    }
  }

  /** Zero the button fill (no report). */
  private clearBar(): void {
    this.fill.style.width = '0%';
    this.lastT = -1;
  }

  /** `clearBar` plus — when this hold had already been reported — the `{t:0, done:false}` reset report. */
  private resetBar(uid: string | null): void {
    this.clearBar();
    if (this.reported && uid) { this.reported = false; this.onProgress(uid, 0, false); }
  }

  private run(): void {
    const r = this.recipe;
    const uid = this.uid;
    if (!r || !uid) return;
    if (this.running) { this.sys.cancelCraft(); this.running = false; this.resetBar(uid); this.refresh(); return; }
    // 2026-09-12 (E1): a favourite def asks with the confirm card first — the confirmation covers this one salvage
    if (this.needsFavoriteConfirm(uid)) { this.openConfirm(uid); return; }
    this.confirmedUid = null;
    this.running = true;
    this.lastEmitAt = -Infinity;
    this.reported = false;
    void this.sys.craft(r.id, uid).then((item) => {
      this.running = false;
      if (item) {
        this.sys.sfx('ui_equip'); this.showMsg(TEXT.disassemble.done, 'ok');
        // the one `done:true` of this hold; the fill then returns to its idle (empty) state
        this.clearBar();
        this.reported = false;
        this.onProgress(uid, 1, true);
      } else {
        this.sys.sfx('ui_error'); this.showMsg(TEXT.disassemble.fail, 'bad');
        this.resetBar(uid);
      }
      // the source stack may be gone now — `refresh` closes the dialog in that case
      this.refresh();
    });
    this.refresh();
  }

  private showMsg(text: string, kind: 'ok' | 'bad'): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `inv-dis-msg is-${kind}`;
    this.msgEl.hidden = false;
    if (this.msgTimer !== null) clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.hideMsg(), 2500);
  }

  private hideMsg(): void {
    if (this.msgTimer !== null) { clearTimeout(this.msgTimer); this.msgTimer = null; }
    this.msgEl.hidden = true;
  }

  dispose(): void {
    this.hideMsg();
    this.stopHold();
    this.shell.dispose();
  }
}
