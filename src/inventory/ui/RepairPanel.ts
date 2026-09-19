import type { ItemDef, LoadoutSlot } from '@/shared';
import { renderItemCost } from '@/shared';
import type { BenchRepairRow, InventorySystem } from '../InventorySystem';
import { Modeless } from './Modeless';
import { SLOT_LABEL, TEXT } from './labels';

/**
 * **The gear repair popup** (2026-09-08).
 *
 * Repair used to be a **list at the bottom of the craft panel** — half of a screen opened to read recipes was
 * permanently taken by gear nobody meant to repair. Now `모두 수리` in the bench header (left of `닫기`) opens this popup:
 *
 *   - **The list** — one row per worn item (`benchRepairRows(wornOnly)`). The panel is wide: under the name a
 *     durability bar and `현재 / 최대`, on the right the material chips one repair costs, **×** at the far right.
 *   - **×** — drops that one item out of `모두 수리` (the row stays, dimmed; pressing again brings it back). Closing
 *     the popup resets it (user's decision) — a temporary pick for one `모두 수리`, not a setting that is saved.
 *   - **Materials spent** — below the list, the **total** without the dropped rows as `보유/필요` chips. Every × recounts it.
 *
 * **2026-09-10 (craft rework, stage 2)** — a repair now costs `craft materials × the multiplier of the remaining
 * durability bucket` (rounded up), and **armor pays materials too** (that slot used to be free). So every row carries
 * `61~80 % · 제작 재료의 20 %` beside its durability bar and a hint under the list says "the more worn, the more it
 * costs" — why the same gear costs more than yesterday must be on screen. Multipliers: `ctx.loot.durabilityBucketInfo` (source `data/tables.csv`).
 *
 * A single repair belongs to `수리` in the item right-click menu (`ui/parts/ContextMenu`) — this popup only works in bulk.
 *
 * It looks modal, but the shell is the same `Modeless` as every other popup: it touches neither blocker nor pointer
 * lock (the window holds both already) and closes on Escape · `닫기` · an outside click. Only the dark plate behind it (`scrim`) is this file's own.
 */
export class RepairPanel {
  /** The shell holding the popup frame and the plate behind it (appended to `InventoryUI.modelessLayer`). */
  readonly el: HTMLElement;
  private readonly shell: Modeless;
  private readonly scrim: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private readonly totalChips: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly msgEl: HTMLElement;
  private msgTimer: number | null = null;
  /** The items dropped with × during this opening (cleared on close). */
  private excluded = new Set<string>();

  constructor(
    private readonly sys: InventorySystem,
    private readonly getDef: (id: string) => ItemDef | undefined,
  ) {
    // When the shell closes itself (the `닫기` button · an outside click) the plate and the drop marks go with it
    this.shell = new Modeless('repair', () => this.afterClose());
    this.shell.withHeader(TEXT.bench.repairEyebrow, TEXT.bench.repairModal);

    this.listEl = document.createElement('div');
    this.listEl.className = 'inv-repair-list';
    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'inv-craft-empty';
    this.emptyEl.textContent = TEXT.bench.repairNone;

    this.totalEl = document.createElement('div');
    this.totalEl.className = 'inv-rep-total';
    const totalCap = document.createElement('div');
    totalCap.className = 'inv-eyebrow';
    totalCap.textContent = TEXT.bench.repairTotal;
    this.totalChips = document.createElement('div');
    this.totalChips.className = 'inv-rep-total-chips';
    this.totalEl.append(totalCap, this.totalChips);

    this.msgEl = document.createElement('div');
    this.msgEl.className = 'inv-repair-msg';
    this.msgEl.hidden = true;

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'inv-rep-hint';
    // 2026-09-10: two lines — where a single repair lives, and why the cost differs each time (the durability bucket)
    const where = document.createElement('span');
    where.textContent = TEXT.bench.repairHint;
    const why = document.createElement('em');
    why.textContent = TEXT.durability.repairNote;
    this.hintEl.append(where, why);

    this.runBtn = document.createElement('button');
    this.runBtn.type = 'button';
    this.runBtn.className = 'inv-btn inv-repair-all';
    this.runBtn.textContent = TEXT.bench.repairAll;
    this.runBtn.addEventListener('click', () => this.runAll());

    this.shell.body.append(this.listEl, this.emptyEl, this.totalEl, this.msgEl, this.hintEl, this.runBtn);

    // The plate behind it. A click on it is read as "outside" by `Modeless`'s document listener, which closes.
    this.scrim = document.createElement('div');
    this.scrim.className = 'inv-rep-scrim';
    this.scrim.hidden = true;

    this.el = document.createElement('div');
    this.el.className = 'inv-rep-host';
    this.el.append(this.scrim, this.shell.el);
  }

  get isOpen(): boolean { return this.shell.isOpen; }

  /** `모두 수리` in the bench header. It opens at the centre of the screen (`anchor` only keeps that button's own click out of "outside"). */
  open(anchor: HTMLElement | null = null): void {
    if (this.shell.isOpen) { this.close(); return; }
    this.excluded.clear();
    this.hideMsg();
    this.scrim.hidden = false;
    this.shell.open(anchor, true);
    this.refresh();
    // 2026-09-09 key guide: mouse-only popup, so the line is the close entry alone (Tab closes this before the window)
    this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.repair', keys: [] });
  }

  /** Escape · the window closing. True when it was open (Escape is consumed). */
  close(): boolean {
    const was = this.shell.close();
    this.afterClose();
    return was;
  }

  /** The tail both paths pass through: the shell closing itself (the `닫기` button · an outside click) and `close()`. */
  private afterClose(): void {
    const wasUp = !this.scrim.hidden;
    this.scrim.hidden = true;
    this.excluded.clear();
    this.hideMsg();
    if (wasUp) this.sys.ctx.bus.emit('ui:keyGuide', { owner: 'inventory.repair', keys: null });
  }

  /** Redraws list · total · button from the current state (only while open). */
  refresh(): void {
    if (!this.shell.isOpen) return;
    const rows = this.sys.benchRepairRows(true);
    // Drop marks for items that are gone go with them (repaired out of the list, or thrown away)
    const live = new Set(rows.map((r) => r.uid));
    for (const uid of [...this.excluded]) if (!live.has(uid)) this.excluded.delete(uid);

    this.listEl.replaceChildren();
    for (const r of rows) this.listEl.appendChild(this.buildRow(r));
    this.emptyEl.hidden = rows.length > 0;
    this.listEl.hidden = rows.length === 0;

    const picked = rows.filter((r) => !this.excluded.has(r.uid));
    this.paintTotal(picked);
    this.runBtn.textContent = TEXT.bench.repairRun(picked.length);
    this.runBtn.disabled = picked.length === 0;
    this.shell.place();
  }

  private buildRow(r: BenchRepairRow): HTMLElement {
    const max = Math.max(1, r.dur.max);
    const cur = Math.max(0, Math.min(max, r.dur.durability));
    const frac = cur / max;
    const off = this.excluded.has(r.uid);

    const row = document.createElement('div');
    row.className = `inv-repair-row${cur <= 0 ? ' is-broken' : ''}${off ? ' is-excluded' : ''}${r.short ? ' is-short-row' : ''}`;
    row.dataset.uid = r.uid;

    const where = document.createElement('div');
    where.className = 'inv-repair-slot';
    where.textContent = r.where ? SLOT_LABEL[r.where as LoadoutSlot] : TEXT.bag;

    const mid = document.createElement('div');
    mid.className = 'inv-repair-mid';
    const name = document.createElement('div');
    name.className = 'inv-repair-name';
    name.textContent = off ? `${r.def.name} · ${TEXT.bench.repairExcluded}`
      : cur <= 0 ? `${r.def.name} · ${TEXT.broken}` : r.def.name;
    const bar = document.createElement('div');
    bar.className = `inv-repair-bar ${frac > 0.5 ? 'ok' : frac > 0.2 ? 'warn' : 'low'}`;
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(frac * 100)}%`;
    bar.appendChild(fill);
    const text = document.createElement('div');
    text.className = 'inv-repair-dur';
    text.textContent = `${Math.round(cur)} / ${Math.round(max)}`;
    // 2026-09-10: the bucket *is* the material multiplier — `61~80 % · 제작 재료의 20 %`
    const bucket = document.createElement('span');
    bucket.className = 'inv-repair-bucket';
    bucket.textContent = TEXT.durability.repair(r.bucket.label, r.bucket.repairMul);
    text.appendChild(bucket);
    mid.append(name, bar, text);

    const cost = document.createElement('div');
    cost.className = `inv-repair-cost${r.short ? ' is-short' : ''}`;
    const have = new Map(r.cost.map((c) => [c.defId, c.have]));
    renderItemCost(cost, r.cost, this.getDef, (id) => have.get(id) ?? 0, { size: 28 });

    // × — drops that one item out of `모두 수리` (pressing again puts it back)
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'inv-repair-drop';
    drop.textContent = off ? '+' : '×';
    drop.title = off ? TEXT.bench.repairKeep : TEXT.bench.repairDrop;
    drop.addEventListener('click', () => {
      if (this.excluded.has(r.uid)) this.excluded.delete(r.uid); else this.excluded.add(r.uid);
      this.sys.sfx('ui_drop');
      this.refresh();
    });

    row.append(where, mid, cost, drop);
    return row;
  }

  /** The total materials without the dropped rows (`보유/필요`). Two items using the same material merge into one chip. */
  private paintTotal(rows: readonly BenchRepairRow[]): void {
    const need = new Map<string, number>();
    const have = new Map<string, number>();
    for (const r of rows) {
      for (const c of r.cost) {
        need.set(c.defId, (need.get(c.defId) ?? 0) + c.qty);
        have.set(c.defId, c.have);
      }
    }
    const cost = [...need].map(([defId, qty]) => ({ defId, qty }));
    this.totalChips.replaceChildren();
    if (cost.length === 0) {
      const none = document.createElement('div');
      none.className = 'inv-rep-total-none';
      none.textContent = TEXT.bench.repairTotalNone;
      this.totalChips.appendChild(none);
      return;
    }
    renderItemCost(this.totalChips, cost, this.getDef, (id) => have.get(id) ?? 0, { size: 30 });
  }

  private runAll(): void {
    const { done, skipped } = this.sys.benchRepairAll(this.excluded);
    this.sys.sfx(done > 0 ? 'ui_equip' : 'ui_error');
    this.showMsg(TEXT.bench.repairAllResult(done, skipped), done > 0 ? 'ok' : 'bad');
    this.refresh();
  }

  private showMsg(text: string, kind: 'ok' | 'bad'): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `inv-repair-msg is-${kind}`;
    this.msgEl.hidden = false;
    if (this.msgTimer !== null) clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.hideMsg(), 3000);
  }

  private hideMsg(): void {
    if (this.msgTimer !== null) { clearTimeout(this.msgTimer); this.msgTimer = null; }
    this.msgEl.hidden = true;
  }

  dispose(): void {
    this.hideMsg();
    this.shell.dispose();
    this.el.remove();
  }
}
