import type { CraftRecipe, ItemDef } from '@/shared';
import { buildItemChip, renderItemCost } from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { Modeless } from './Modeless';
import { TEXT } from './labels';

/**
 * Phase 8 — **아이템 분해** dialog.
 *
 * 분해 used to be four `break_ammo_*` rows in the craft list; it is now a `분해` entry in the item context menu that
 * opens this **modeless** popup over the inventory window. The dialog is a *preview of the expected result*: the
 * input item chip (보유/필요, dimmed + red when short) `→` the output item chip (×n), the craft duration, and a
 * 분해 button that runs the very recipe the craft panel would have run (`InventorySystem.craft`).
 *
 * Like every modeless popup it adds no blocker and never exits the pointer lock — the window owns both — and it is
 * dismissed by Escape (through `InventoryUI.closeOverlays()`), by the 닫기 button or by a pointerdown outside it.
 * Emits `ui:disassembleToggled {open, uid}` on both edges.
 *
 * Phase 12 (2026-09-08) — **분해 게이지**: while the hold runs, the `분해 중…` **button itself** fills 0 → 100 % in real
 * time (`.inv-craft-fill`). It is driven per frame by `tick()` (called from `InventoryUI.refreshCraft`, which the
 * system calls from `updateCraft` every frame the job advances) — the width *is* the job's progress, carried only by
 * the fill's own 80 ms smoothing. The panel also reports the hold through `onProgress` → the window emits
 * `inventory:disassembleProgress {uid, t, done}`: at most every `PROGRESS_EMIT_MS` while running, exactly once with
 * `done:true` when the recipe completes, and `{t:0, done:false}` when a cancel (button / close / death) resets it.
 *
 * **2026-09-08 (분해 UX)**: three cuts, all of them the same complaint — the dialog told you things after the fact.
 *  - The `1회 분해 · 2.0 s` line under the preview is gone; the duration is what the button fill shows.
 *  - The second horizontal bar under the button is gone too — the button *is* the progress bar.
 *  - **가방 공간을 먼저 본다** (`InventorySystem.craftHasRoom`). The bag used to be checked when the hold ended, so a
 *    full bag cost you the 2 s and then said no; the button now refuses up front with the reason on it.
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

    this.shell.body.append(this.preview, this.msgEl, this.button);
  }

  get el(): HTMLElement { return this.shell.el; }
  get isOpen(): boolean { return this.shell.isOpen; }
  /** The item currently previewed (smoke tests). */
  get itemUid(): string | null { return this.uid; }
  /** The 분해 게이지 element — the button itself since 2026-09-08 (smoke tests). */
  get barEl(): HTMLElement { return this.button; }
  /** 0..1 fill of the 분해 게이지 (0 while idle). */
  get progress(): number { return this.lastT < 0 ? 0 : this.lastT; }

  /** Open the dialog for `uid`; false when the item has no `break_*` recipe. */
  open(uid: string, anchor: HTMLElement | null = null): boolean {
    const recipe = this.sys.disassembleRecipeFor(uid);
    if (!recipe) return false;
    this.uid = uid;
    this.recipe = recipe;
    this.running = false;
    this.hideMsg();
    this.refresh();
    this.shell.open(anchor);
    this.shell.place();
    this.onToggled(true, uid);
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
    this.uid = null;
    this.recipe = null;
    this.hideMsg();
    this.onToggled(false, uid);
  }

  /** Repaint the chips / affordability. Called on open and from the window's `refresh()`. */
  refresh(): void {
    const r = this.recipe;
    if (!r) return;
    // the item may have been consumed / moved away meanwhile
    if (this.uid && !this.sys.findItem(this.uid)) { this.close(); return; }
    const cost = this.sys.craftCost(r);
    const enough = renderItemCost(this.inputHost, cost, this.getDef, (id) => this.sys.countWhere((d) => d.id === id), { size: 46, withName: true });
    // 2026-09-08: 기계 부품처럼 여러 재료가 나오는 분해는 결과물 칩을 나란히 (`CraftRecipe.extraOutputs`)
    this.outputHost.replaceChildren(
      buildItemChip(this.getDef(r.outputDefId), { need: r.outputQty, size: 46, withName: true }),
      ...(r.extraOutputs ?? []).map((e) => buildItemChip(this.getDef(e.defId), { need: e.qty, size: 46, withName: true })),
    );
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    this.running = active;
    // 2026-09-08: 칸부터 본다 — the bag check that used to run when the hold ended now gates the button.
    const room = this.sys.craftHasRoom(r.id);
    const block = !enough ? TEXT.disassemble.short : !room ? TEXT.disassemble.noRoom : '';
    this.button.disabled = !active && !!block;
    this.buttonLabel.textContent = active ? TEXT.disassemble.working : block || TEXT.disassemble.button;
    this.button.title = block;
    this.tick();
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
    this.shell.dispose();
  }
}
