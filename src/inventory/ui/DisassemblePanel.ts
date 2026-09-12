import type { CraftRecipe, ItemDef } from '@/shared';
import { UI_HOLD_CONFIRM_S, buildItemChip, renderItemCost } from '@/shared';
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
 *  - **넣을 자리를 먼저 본다** (`InventorySystem.craftHasRoom` — 함선에서는 가방 → 창고, 2026-09-09). The bag used to be checked when the hold ended, so a
 *    full bag cost you the 2 s and then said no; the button now refuses up front with the reason on it.
 *
 * **2026-09-10 (제작 대개편 2단계)** — 산출이 **남은 내구도**를 탄다. 팝업은 열 때 한 번이 아니라 매 `refresh()`
 * 마다 `disassembleRecipeFor(uid)` 로 레시피를 다시 풀고(= `ctx.loot.getSalvageFor(inst)`), 자리 검사도 그
 * 아이템 기준으로 묻는다. 예전에는 정적 `break_*` 줄(구간 4 기준)을 그렸기 때문에 **다 망가진 방탄복 I 도
 * `폐금속 4 + 천조각 2` 라고 적혀 있었다** — 실제로 나오는 것은 `폐금속 1` 이다. 미리보기 밑에 붙은
 * `.inv-dur-note` 한 줄이 지금 구간과 그 배수를 말한다.
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
  /** 남은 내구도 구간 + 그 구간의 분해 배수 (2026-09-10). 내구도가 없는 아이템에서는 숨는다. */
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
   * 2026-09-12 (E1, 사용자 결정) — **즐겨찾기한 아이템은 분해 전에 한 번 더 묻는다.** 경고 팝업의 규약 그대로:
   * 확정은 빨간 `분해` 를 `UI_HOLD_CONFIRM_S` 동안 누르는 것뿐이고(클릭 · Enter 로는 안 된다), `취소` · Escape · Tab 은
   * 카드만 물린다 (`InventoryUI.closePopups` → `cancelConfirm`). 한 번 확인하면 그 분해 한 번에만 유효하다.
   */
  private readonly confirmEl: HTMLElement;
  private readonly confirmBody: HTMLElement;
  private readonly confirmCancel: HTMLButtonElement;
  private readonly confirmOk: HTMLButtonElement;
  private readonly confirmFill: HTMLElement;
  /** The uid whose 분해 was just confirmed (the next `run()` for it skips the card once). */
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

    // 2026-09-10: 산출이 남은 내구도를 타므로 **어느 구간이라 이 숫자인가**를 말해 준다 (사양서 §4).
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

    // 2026-09-12 (E1): 즐겨찾기 확인 카드 (평소에는 숨어 있다)
    this.confirmEl = document.createElement('div');
    this.confirmEl.className = 'inv-dis-confirm';
    this.confirmEl.hidden = true;
    const cTitle = document.createElement('div');
    cTitle.className = 'inv-dis-confirm-title';
    cTitle.textContent = `★ ${TEXT.favorite.confirmTitle}`;
    this.confirmBody = document.createElement('div');
    this.confirmBody.className = 'inv-dis-confirm-body';
    const cHint = document.createElement('div');
    cHint.className = 'inv-dis-confirm-hint';
    cHint.textContent = TEXT.favorite.confirmHint(UI_HOLD_CONFIRM_S);
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
    this.confirmOk.append(this.confirmFill, okLabel);
    this.confirmOk.addEventListener('pointerdown', (e) => this.startHold(e));
    this.confirmOk.addEventListener('pointerleave', () => this.stopHold());
    // Enter / Space on the focused button never confirm — only the hold does
    this.confirmOk.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } });
    this.confirmOk.addEventListener('click', (e) => e.preventDefault());
    cRow.append(this.confirmCancel, this.confirmOk);
    this.confirmEl.append(cTitle, this.confirmBody, cHint, cRow);
    this.shell.body.append(this.confirmEl);
  }

  /* ── 2026-09-12 (E1): 즐겨찾기 분해 확인 ─────────────────────────────── */

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
    this.confirmedUid = null;   // 2026-09-12 (E1): a fresh dialog asks again
    this.cancelConfirm();
    this.refresh();
    this.shell.open(anchor);
    this.shell.place();
    this.onToggled(true, uid);
    // 2026-09-09 키 가이드: the 분해 button is a hold; Tab closes this popup before the window
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
    // 2026-09-10: 산출은 **지금 남은 내구도**의 함수다 — 매번 다시 풀어 미리보기와 실제를 붙여 둔다
    // (`disassembleRecipeFor` → `ctx.loot.getSalvageFor`). 창을 열어 둔 채 아이템이 닳아도 숫자가 따라온다.
    const fresh = this.uid ? this.sys.disassembleRecipeFor(this.uid) : null;
    if (fresh) this.recipe = fresh;
    const r = this.recipe;
    const cost = this.sys.craftCost(r);
    const enough = renderItemCost(this.inputHost, cost, this.getDef, (id) => this.sys.countWhere((d) => d.id === id), { size: 46, withName: true });
    // 2026-09-08: 기계 부품처럼 여러 재료가 나오는 분해는 결과물 칩을 나란히 (`CraftRecipe.extraOutputs`)
    this.outputHost.replaceChildren(
      buildItemChip(this.getDef(r.outputDefId), { need: r.outputQty, size: 46, withName: true }),
      ...(r.extraOutputs ?? []).map((e) => buildItemChip(this.getDef(e.defId), { need: e.qty, size: 46, withName: true })),
    );
    this.paintDurability();
    const job = this.sys.craftProgress();
    const active = job?.recipeId === r.id;
    this.running = active;
    // 2026-09-08: 칸부터 본다 — the bag check that used to run when the hold ended now gates the button.
    // 2026-09-10: **이 아이템 기준으로** 묻는다 — 구간 4 기준의 정적 줄로 재면 자리 계산이 어긋난다.
    const room = this.sys.craftHasRoom(r.id, 1, this.uid ?? undefined);
    const noRoom = this.sys.ctx.isHubPhase() ? TEXT.disassemble.noRoomShip : TEXT.disassemble.noRoom;
    const block = !enough ? TEXT.disassemble.short : !room ? noRoom : '';
    this.button.disabled = !active && !!block;
    this.buttonLabel.textContent = active ? TEXT.disassemble.working : block || TEXT.disassemble.button;
    this.button.title = block;
    this.tick();
  }

  /**
   * **남은 내구도 구간 한 줄** (2026-09-10, 사양서 §4). `81~100 % · 제작 재료의 40 %` 와 그 아래 안내
   * 한 줄 — 구간이 바뀌면 위의 결과물 칩이 함께 바뀐다는 것이 읽혀야 한다. 배수는 전부
   * `ctx.loot.durabilityBucketInfo` 에서 오고(원본은 `data/tables.csv`) 여기에는 숫자가 없다.
   * 내구도를 쓰지 않는 아이템(탄약 · 재료 · 가방)은 언제나 구간 4 이므로 줄 자체를 숨긴다 —
   * 있지도 않은 게이지를 설명할 이유가 없다.
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
    // 2026-09-12 (E1): 즐겨찾기한 종류면 확인 카드부터 — 확인은 이 한 번의 분해에만 유효하다
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
