import type { GameContext, ImplantId, SlotId, StatDef, StatId } from '@/shared';
import {
  ACCENT_COLORS, CHARACTER_NAME_MAX, CREATE_IMPLANT_IDS, CREATE_STAT_MAX, CREATE_STAT_MIN, CREATE_STAT_POINTS,
  DEFAULT_ACCENT, STAT_IDS, baseCreateStats, canAdjustStat, createCharacterInSlot, deleteSlot, markAutoStart,
  rollCallsign, rollCreateStats, sanitizeCharacterName, setActiveSlot, statPointsLeft,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from './askPopup';
import { createSoldierPreview, type SoldierPreview } from './SoldierPreview';

interface StatRow {
  root: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
  down: HTMLButtonElement;
  up: HTMLButtonElement;
}

/**
 * Character creation (2026-09-09) — opened from an empty slot on the character select screen.
 *
 * The screen is **two columns** (`.cc-body`) (2026-09-14 rework — it must fit 1280×720 with no scrolling):
 *  - **Left column `.cc-main`**: the name card (`.cc-panel` — name + 🎲) on top, the character stat card
 *    (`.cc-stats-wrap`) below. The five stats are allotted **one vertical row each** (`.cc-stat-list`) via `◀ ▶`.
 *    The look is copied from the character sheet (`.cs-stat` in `progression/ui/SheetBody`) — name · description ·
 *    thin bar · mono number. `◀` and `▶` are both accent (orange) outlines, only the unusable one dims, and the
 *    points left are shown large.
 *  - **Right · the 3D preview**: `menus/SoldierPreview` (its own WebGL context, the rules of `hub/ui/PlanetHologram`).
 *    **Right below it the accent swatches** (`.cc-accent`) — picking one repaints on the spot.
 *
 * **2026-09-14 (user's decision) — the starting implant choice is gone from the screen.** Every new character is
 * **fixed** to `CREATE_IMPLANT_IDS[0]` (the grapple). The big tile (`.cc-imp-tile`) · the context menu
 * (`.cc-imp-menu`) · the `시작 임플란트` label · their CSS all went, and the left settings column, left with only the
 * name card, merged with the middle stat column into one (three columns → two). The `implant` field handed to
 * `createCharacterInSlot` and `sanitize` in `shared/character.ts` **stay as they are — they are the contract**; only
 * the value is always the same. Granting and equipping the grapple as an item is the first ship entry's job.
 *
 * **Every rule lives in `shared/character.ts`** (`CREATE_STAT_MIN/MAX/POINTS`, `canAdjustStat`,
 * `rollCreateStats`, `rollCallsign`, `sanitizeCharacterName`, `ACCENT_COLORS`, `CREATE_IMPLANT_IDS`).
 * This file only draws them — it holds no number at all.
 *
 * **The dice never silently erases what a person put in by hand**: if the name was typed directly or a stat was
 * adjusted even once, a warning popup (`menus/askPopup`) comes first and only a confirm overwrites. `확정` passes a
 * summary popup too.
 *
 * **2026-09-14 (user's decision) — the confirm popup is a summary card** (`buildSummary`): on the left the name and
 * five horizontal stat gauges (value / 5), on the right a still image of the preview soldier's face. The
 * 「정말로 만들겠습니까?」 line is gone and `만들기` is a `UI_HOLD_CONFIRM_S` hold (`AskSpec.hold` — a hold that is not
 * red, its fill in the accent colour).
 * **2026-09-15 2nd pass (user's decision)**: those five stats went **from five columns across to five rows down** —
 * one row = `[name] [gauge] [value]`. The gauge ratio · the `maxed` emphasis · the face thumbnail are unchanged. The
 * hold notice line disappeared from `askPopup` entirely (the left-click hold keycap inside `만들기` says it instead).
 *
 * **It cannot be confirmed while points remain** (2026-09-09): the `확정` button is `disabled` while
 * `statPointsLeft > 0` (tooltip `남은 점수를 모두 배분하세요`), and if it is pressed anyway (by keyboard, say) only the
 * `능력치 배분 미완료` notice popup appears. So the old "남은 점수 N점은 버려집니다" line is gone from the summary —
 * that can no longer happen.
 *
 * After the confirm comes `createCharacterInSlot` → `setActiveSlot` → `markAutoStart` → `location.reload()`.
 * There is no way to push a new profile into running systems (stash · meta · the ship all have to be read again, and
 * that is a boot).
 *
 * It holds no blocker token and no cursor ownership — the title (`MenuBase`) keeps holding both and this screen is
 * laid on top of it.
 */
export class CharacterCreate {
  readonly root: HTMLElement;
  private ctx!: GameContext;
  private readonly ask: AskPopup;

  private readonly nameInput: HTMLInputElement;
  private readonly slotTag: HTMLElement;
  private readonly swatches: { hex: string; btn: HTMLButtonElement }[] = [];
  private readonly statRows = new Map<StatId, StatRow>();
  private readonly pointsValue: HTMLElement;
  private readonly pointsBox: HTMLElement;
  private readonly confirmBtn: HTMLButtonElement;
  private readonly msg: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly noGl: HTMLElement;
  private preview: SoldierPreview | null = null;
  /** The preview is built the first time the screen opens — the title does not hold a second GL context all along. */
  private previewTried = false;
  /** The stat list needs `ctx` to get its names, so it is filled on the first `open()`. */
  private statHost: HTMLElement | null = null;

  private slot: SlotId = 1;
  private stats: Record<StatId, number> = baseCreateStats();
  private accent: string = DEFAULT_ACCENT;
  /**
   * 2026-09-14 (user's decision): the starting implant is **not chosen** — every new character has the same value.
   * The field is kept so that the contract of `createCharacterInSlot` (`implant`) is still filled as before.
   */
  private readonly implant: ImplantId = CREATE_IMPLANT_IDS[0];
  /** Did the person type the name / move a stat by hand — decides whether the dice raises a warning. */
  private nameTouched = false;
  private statsTouched = false;
  private _open = false;

  constructor(parent: HTMLElement, private readonly onCancel: () => void) {
    this.root = el('div', { cls: 'title-screen char-create interactive', parent });
    this.root.hidden = true;

    const head = el('div', { cls: 'ts-head', parent: this.root });
    el('div', { cls: 'ts-title', text: '캐릭터 생성', parent: head });
    this.slotTag = el('div', { cls: 'ts-sub', text: '', parent: head });

    const body = el('div', { cls: 'cc-body', parent: this.root });

    /* ── Left column: name + stat cards (2026-09-14: the implant went, so the old settings and stat columns merged) ── */
    const main = el('div', { cls: 'cc-main', parent: body });
    const form = el('div', { cls: 'cc-panel', parent: main });

    const nameSec = el('div', { cls: 'cc-section', parent: form });
    el('span', { cls: 'ui-label', text: '이름', parent: nameSec });
    const nameRow = el('div', { cls: 'cc-name-row', parent: nameSec });
    this.nameInput = el('input', {
      cls: 'ui-input',
      attrs: {
        type: 'text', placeholder: `최대 ${CHARACTER_NAME_MAX}자까지 입력`, maxlength: String(CHARACTER_NAME_MAX),
        spellcheck: 'false', autocomplete: 'off',
      },
      parent: nameRow,
    });
    // Game keys (WASD · Tab · Escape) stop at the field and never reach `Input` (the contract every menu input follows).
    this.nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') { e.preventDefault(); this.nameInput.blur(); }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.nameInput.blur(); }
    });
    this.nameInput.addEventListener('keyup', (e) => e.stopPropagation());
    this.nameInput.addEventListener('input', () => { this.nameTouched = this.nameInput.value.trim().length > 0; });
    const dice = el('button', { cls: 'ui-btn cc-dice', text: '🎲', attrs: { title: '무작위 호출명' }, parent: nameRow });
    dice.addEventListener('click', (e) => { e.stopPropagation(); this.rollName(); });

    /* ── Character stats (same column, one row each) ── */
    const statsWrap = el('div', { cls: 'cc-stats-wrap', parent: main });
    const statsHead = el('div', { cls: 'cc-stats-head', parent: statsWrap });
    el('span', { cls: 'ui-label', text: '캐릭터 스탯', parent: statsHead });
    const right = el('div', { cls: 'cc-stats-head-right', parent: statsHead });
    this.pointsBox = el('div', { cls: 'cc-points', parent: right });
    el('span', { cls: 'k', text: '남은 점수', parent: this.pointsBox });
    this.pointsValue = el('span', { cls: 'v', text: String(CREATE_STAT_POINTS), parent: this.pointsBox });
    const statDice = el('button', { cls: 'ui-btn cc-dice', text: '🎲', attrs: { title: '능력치 무작위 배분' }, parent: right });
    statDice.addEventListener('click', (e) => { e.stopPropagation(); this.rollStats(); });

    this.statHost = el('div', { cls: 'cc-stat-list', parent: statsWrap });

    /* ── Right: the 3D preview + the accent swatches below it ── */
    const side = el('div', { cls: 'cc-side', parent: body });
    const preview = el('div', { cls: 'cc-preview', parent: side });
    this.stage = el('div', { cls: 'cc-stage', parent: preview });
    this.noGl = el('div', {
      cls: 'cc-nogl',
      text: '이 브라우저에서는 미리보기를 그릴 수 없습니다 (WebGL 컨텍스트 부족). 캐릭터 생성은 그대로 진행됩니다.',
      parent: this.stage,
    });
    this.noGl.hidden = true;
    const accentSec = el('div', { cls: 'cc-section cc-accent', parent: side });
    el('span', { cls: 'ui-label', text: '악센트 색상', parent: accentSec });
    const swWrap = el('div', { cls: 'cc-swatches', parent: accentSec });
    for (const hex of ACCENT_COLORS) {
      const btn = el('button', { cls: 'cc-sw', attrs: { title: hex, 'aria-label': hex }, parent: swWrap });
      btn.style.setProperty('--sw', hex);
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.setAccent(hex); });
      this.swatches.push({ hex, btn });
    }

    this.msg = el('div', { cls: 'form-msg danger', text: '', parent: this.root });
    this.msg.hidden = true;

    const foot = el('div', { cls: 'ts-foot', parent: this.root });
    const cancel = el('button', { cls: 'ui-btn', text: '취소', parent: foot });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); this.cancel(); });
    this.confirmBtn = el('button', { cls: 'ui-btn primary', text: '확정', parent: foot });
    this.confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); this.askConfirm(); });

    this.ask = new AskPopup(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ── build ────────────────────────────────────────────────────────────── */

  /** ctx access that is safe even before `bind`. */
  private ctxSafe(): GameContext | null { return (this.ctx as GameContext | undefined) ?? null; }

  private statDefs(): readonly StatDef[] {
    const defs = this.ctxSafe()?.progression?.getAllStatDefs?.();
    if (defs && defs.length > 0) return defs;
    // A skeleton boot with no progression system — the five rows are drawn from the ids alone.
    return STAT_IDS.map((id) => ({ id, name: id, description: '' }));
  }

  private fillStats(): void {
    const host = this.statHost;
    if (!host || this.statRows.size > 0) return;
    for (const def of this.statDefs()) {
      const row = el('div', { cls: 'cc-stat', parent: host });
      const down = el('button', { cls: 'ui-btn step down', text: '◀', attrs: { title: `${def.name} 낮추기` }, parent: row });
      const txt = el('div', { cls: 't', parent: row });
      el('div', { cls: 'n', text: def.name, parent: txt });
      if (def.description) el('div', { cls: 'd', text: def.description, parent: txt });
      const prog = el('div', { cls: 'sp', parent: txt });
      const bar = el('div', { cls: 'bar', parent: prog });
      const fill = el('i', { parent: bar });
      const value = el('div', { cls: 'v', text: String(CREATE_STAT_MIN), parent: row });
      const up = el('button', { cls: 'ui-btn step up', text: '▶', attrs: { title: `${def.name} 올리기` }, parent: row });
      down.addEventListener('click', (e) => { e.stopPropagation(); this.adjust(def.id, -1); });
      up.addEventListener('click', (e) => { e.stopPropagation(); this.adjust(def.id, +1); });
      this.statRows.set(def.id, { root: row, value, fill, down, up });
    }
  }

  /* ── state ────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    this.ask.bind(ctx);
  }

  get isOpen(): boolean { return this._open; }
  /** The slot being drawn right now (debug / smoke). */
  get targetSlot(): SlotId { return this.slot; }
  /** The allotment as it stands (debug / smoke). */
  get draftStats(): Readonly<Record<StatId, number>> { return this.stats; }
  /** Is the preview canvas alive (debug). */
  get hasPreview(): boolean { return this.preview !== null; }
  /** The starting implant that will be saved (debug / smoke). **Fixed** since 2026-09-14 — there is nowhere to pick it. */
  get draftImplant(): ImplantId { return this.implant; }

  /** Opens the screen that makes a new character in slot `slot` (the state starts from scratch every time). */
  open(slot: SlotId): void {
    this.slot = slot;
    this.stats = baseCreateStats();
    this.accent = DEFAULT_ACCENT;
    this.nameTouched = false;
    this.statsTouched = false;
    this.nameInput.value = '';
    this.msg.hidden = true;
    setText(this.slotTag, `슬롯 ${slot}`);

    this.fillStats();
    this.root.hidden = false;
    this._open = true;

    if (!this.previewTried) {
      this.previewTried = true;
      this.preview = createSoldierPreview(this.stage);
      this.noGl.hidden = this.preview !== null;
    }
    this.preview?.setVisible(true);
    this.refresh();
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.ask.close();
    this.preview?.setVisible(false);
    this.root.hidden = true;
  }

  /** Every frame (HudSystem → TitleMenu). While closed the preview returns immediately by itself. */
  update(dt: number): void { this.preview?.render(dt); }

  private cancel(): void {
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.close();
    this.onCancel();
  }

  /* ── picking ──────────────────────────────────────────────────────────── */

  private setAccent(hex: string): void {
    this.accent = hex;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  private adjust(id: StatId, delta: number): void {
    if (!canAdjustStat(this.stats, id, delta)) return;
    const next = { ...this.stats } as Record<StatId, number>;
    next[id] = (next[id] ?? CREATE_STAT_MIN) + delta;
    this.stats = next;
    this.statsTouched = true;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refresh();
  }

  /* ── the dice (never silently erases a value put in by hand) ───────────── */

  private rollName(): void {
    const run = (): void => {
      this.nameInput.value = rollCallsign();
      this.nameTouched = false;      // a name the dice put in is not "typed directly"
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    };
    if (this.nameTouched && this.nameInput.value.trim()) {
      this.ask.open({
        title: '이름 다시 뽑기',
        body: '직접 입력한 이름이 사라집니다. 무작위 호출명으로 덮어쓸까요?',
        ok: '덮어쓰기',
        run,
      });
      return;
    }
    run();
  }

  private rollStats(): void {
    const run = (): void => {
      this.stats = rollCreateStats();
      this.statsTouched = false;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    };
    if (this.statsTouched) {
      this.ask.open({
        title: '능력치 다시 뽑기',
        body: '직접 배분한 능력치가 사라집니다. 무작위 배분으로 덮어쓸까요?',
        ok: '덮어쓰기',
        run,
      });
      return;
    }
    run();
  }

  /* ── confirm ──────────────────────────────────────────────────────────── */

  private askConfirm(): void {
    const left = statPointsLeft(this.stats);
    if (left > 0) {
      // The button is already disabled, but a keyboard · a smoke test can get around it — only notify, create nothing.
      this.ask.open({
        title: '능력치 배분 미완료',
        body: `남은 점수 ${left}점을 모두 배분해야 캐릭터를 만들 수 있습니다.`,
        ok: '확인',
        run: () => {},
      });
      return;
    }
    const name = sanitizeCharacterName(this.nameInput.value);
    // 2026-09-14 (user's decision): the summary is a card, not prose — 「정말로 만들겠습니까?」 went, `만들기` is a 1 s hold.
    this.ask.open({
      title: '캐릭터 확정',
      body: '',
      content: this.buildSummary(name),
      cardCls: 'cc-confirm-card',
      ok: '만들기',
      hold: true,
      run: () => this.create(name),
    });
  }

  /**
   * The confirm popup's summary card (2026-09-14, user's decision · reworked into five rows down, 2026-09-15 2nd pass).
   *  - Left: one name line + the five stats **one row each, downward** — one row = `[name] [horizontal gauge] [value]`.
   *    The name is a fixed width on the left (`--cf-name`, the same width as the `이름` label of the name line, so the
   *    first column lines up vertically), the gauge takes all the width that is left, and the value sits right in
   *    `tabular-nums` so the digits never shift. The gauge is **value / max** (`CREATE_STAT_MAX` = 5 is full, the
   *    minimum 1 fills 1/5 — the bar on the creation screen differs: it is (value − min) / (max − min)).
   *  - Right: a **still image of the preview soldier's face** (`SoldierPreview.snapshotFace`). With no GL that column
   *    is dropped and only the left side is drawn.
   * No number lives here — the ranges are constants in `shared/character.ts`.
   */
  private buildSummary(name: string): HTMLElement {
    const root = el('div', { cls: 'cc-confirm' });
    const main = el('div', { cls: 'cc-cf-main', parent: root });
    const nameRow = el('div', { cls: 'cc-cf-name', parent: main });
    el('span', { cls: 'ui-label', text: '이름', parent: nameRow });
    el('span', { cls: 'v', text: name, parent: nameRow });
    const stats = el('div', { cls: 'cc-cf-stats', parent: main });
    const max = Math.max(1, CREATE_STAT_MAX);
    for (const def of this.statDefs()) {
      const v = this.stats[def.id] ?? CREATE_STAT_MIN;
      const cell = el('div', { cls: 'cc-cf-stat', parent: stats });
      toggleClass(cell, 'maxed', v >= CREATE_STAT_MAX);
      el('span', { cls: 'n', text: def.name, parent: cell });
      const bar = el('div', { cls: 'bar', parent: cell });
      const fill = el('i', { parent: bar });
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, v / max)).toFixed(4)})`;
      el('span', { cls: 'v', text: String(v), parent: cell });
    }
    const url = this.preview?.snapshotFace() ?? null;
    if (url) {
      const face = el('div', { cls: 'cc-cf-face', parent: root });
      const img = el('img', { parent: face }) as HTMLImageElement;
      img.alt = '';
      img.draggable = false;
      img.src = url;
    }
    return root;
  }

  private create(name: string): void {
    const slot = this.slot;
    // It only opens on an empty slot so this is normally empty, but per the contract the caller clears it first.
    deleteSlot(slot);
    const profile = createCharacterInSlot(slot, {
      name, stats: this.stats, accent: this.accent, implant: this.implant,
    });
    if (!profile) {
      this.refresh();
      setText(this.msg, '저장소에 쓸 수 없어 캐릭터를 만들지 못했습니다 — 브라우저의 사이트 데이터 차단 · 시크릿 모드를 확인하세요.');
      this.msg.hidden = false;
      return;
    }
    this.confirmBtn.disabled = true;
    // The systems read storage once at boot — a reload is the only way into a new character.
    setActiveSlot(slot);
    markAutoStart();
    window.location.reload();
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  private refresh(): void {
    for (const s of this.swatches) toggleClass(s.btn, 'is-on', s.hex === this.accent);
    this.preview?.setAccent(this.accent);

    const left = statPointsLeft(this.stats);
    setText(this.pointsValue, String(left));
    toggleClass(this.pointsBox, 'spent', left <= 0);
    // With points left it cannot be created — the button says so itself.
    this.confirmBtn.disabled = left > 0;
    this.confirmBtn.title = left > 0 ? '남은 점수를 모두 배분하세요' : '';
    for (const [id, row] of this.statRows) {
      const v = this.stats[id] ?? CREATE_STAT_MIN;
      setText(row.value, String(v));
      const span = Math.max(1, CREATE_STAT_MAX - CREATE_STAT_MIN);
      row.fill.style.transform = `scaleX(${((v - CREATE_STAT_MIN) / span).toFixed(4)})`;
      toggleClass(row.root, 'maxed', v >= CREATE_STAT_MAX);
      row.down.disabled = !canAdjustStat(this.stats, id, -1);
      row.up.disabled = !canAdjustStat(this.stats, id, +1);
    }
  }

  dispose(): void {
    this.close();
    this.preview?.dispose();
    this.preview = null;
    this.ask.dispose();
    this.root.remove();
  }
}
