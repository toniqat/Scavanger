import type { CraftRecipe, ItemDef } from '@/shared';
import { buildItemChip, renderItemCost } from '@/shared';
import type { InventorySystem } from '../InventorySystem';
import { Modeless } from './Modeless';
import { TEXT, fmtSeconds } from './labels';

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
 */
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
  private readonly hintEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly fill: HTMLElement;
  private readonly buttonLabel: HTMLElement;
  private uid: string | null = null;
  private recipe: CraftRecipe | null = null;
  private running = false;
  private msgTimer: number | null = null;

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
    private readonly onToggled: (open: boolean, uid: string | null) => void,
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

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'inv-dis-hint';
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

    this.shell.body.append(this.preview, this.hintEl, this.msgEl, this.button);
  }

  get el(): HTMLElement { return this.shell.el; }
  get isOpen(): boolean { return this.shell.isOpen; }
  /** The item currently previewed (smoke tests). */
  get itemUid(): string | null { return this.uid; }

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
    this.outputHost.replaceChildren(buildItemChip(this.getDef(r.outputDefId), { need: r.outputQty, size: 46, withName: true }));
    this.hintEl.textContent = TEXT.disassemble.hint(this.sys.craftDuration(r.id));
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    this.running = active;
    this.button.disabled = !active && !enough;
    this.buttonLabel.textContent = active ? TEXT.disassemble.working : TEXT.disassemble.button;
    this.fill.style.width = active ? `${Math.round(job!.progress * 100)}%` : '0%';
    this.button.title = enough ? '' : TEXT.disassemble.short;
  }

  private run(): void {
    const r = this.recipe;
    if (!r) return;
    if (this.running) { this.sys.cancelCraft(); this.running = false; this.refresh(); return; }
    this.running = true;
    void this.sys.craft(r.id).then((item) => {
      this.running = false;
      if (item) { this.sys.sfx('ui_equip'); this.showMsg(TEXT.disassemble.done, 'ok'); }
      else { this.sys.sfx('ui_error'); this.showMsg(TEXT.disassemble.fail, 'bad'); }
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
