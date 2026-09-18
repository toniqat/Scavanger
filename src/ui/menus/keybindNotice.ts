import type { GameContext, KeyAction, KeybindLoadReport } from '@/shared';
import { Keys, getKeyActionDef, keyLabel, saveKeybinds } from '@/shared';
import { el, toggleClass } from '../dom';

/**
 * **The notice for an old keybind save** (2026-09-11, C-9 · X-8).
 *
 * `scav.keybinds` carries no version, so a blob saved before a default key moved (say `RELOAD=V` saved, then the new
 * default `DIVE=V`) **silently** shares a key with the new default — `⚠ 겹침` was only visible once the key settings
 * screen was opened. And the rows of actions dropped from the list (`SWAP` the previous weapon · `SECONDARY` the
 * sidearm · `CURSOR` the cursor) stayed in the blob forever. `shared/Keybinds.loadKeybinds()` (the main.ts boot)
 * gathers them and `takeKeybindLoadReport()` hands them back **exactly once**.
 *
 * One place reads it, `TitleMenu.bind` — the same reason as `takeAutoStart()` (exactly once per boot · the first
 * screen is here).
 *  - On a boot that shows the title, this card (`.kb-notice`) appears bottom centre of the title. Once
 *    `KEYBIND_NOTICE_S` seconds have passed while the title is visible it folds itself, `확인` closes it at once, and
 *    `키 설정 열기` opens the settings panel.
 *  - On an auto start after a slot switch (the title is skipped) the same lines go out as `ui:notify` at the first
 *    `hub:entered`.
 * Either way, **the moment it is told**, `saveKeybinds()` is called and the retired rows are erased from the blob (a
 * collision stays in the blob until the user fixes it, so it is told again on the next boot — two actions really are
 * bound to one key, so it is not passed over silently).
 */

/** Measured against the time the title is visible, the card folds once this much has passed. */
export const KEYBIND_NOTICE_S = 14;
/** The most lines a card · toast carries (past that the last line reads `외 n건`). */
const MAX_LINES = 4;

/** Names of actions dropped from the list — a retired action is a raw string, so `KEY_ACTION_DEFS` has no label for it. */
const RETIRED_LABEL_KO: Readonly<Record<string, string>> = {
  SWAP: '이전 무기',
  SECONDARY: '보조무기',
  CURSOR: '커서',
};

/** The short action name: `재장전 / (수류탄을 들고 있을 때) 코킹` → `재장전`. */
function actionName(id: KeyAction): string {
  const label = getKeyActionDef(id)?.label ?? id;
  return label.split(' / ')[0];
}

/**
 * The report as lines a person reads. Retired actions are gathered into one line and a collision is one line **per
 * key** — two actions from the blob that collide appear in the report as both `A→[B]` and `B→[A]`, so they are
 * grouped by key code and written once.
 */
export function describeKeybindReport(report: KeybindLoadReport): string[] {
  const lines: string[] = [];
  const byCode = new Map<string, Set<KeyAction>>();
  for (const c of report.conflicts) {
    const code = Keys[c.action];
    let set = byCode.get(code);
    if (!set) { set = new Set(); byCode.set(code, set); }
    set.add(c.action);
    for (const o of c.with) set.add(o);
  }
  for (const [code, set] of byCode) {
    lines.push(`같은 키 ${keyLabel(code)}: ${[...set].map(actionName).join(' · ')}`);
  }
  if (report.retired.length > 0) {
    lines.push(`없어진 기능의 키 설정을 지웠습니다: ${report.retired.map((r) => RETIRED_LABEL_KO[r] ?? r).join(' · ')}`);
  }
  if (lines.length > MAX_LINES) {
    const rest = lines.length - (MAX_LINES - 1);
    lines.length = MAX_LINES - 1;
    lines.push(`외 ${rest}건 — 설정 › 키 설정에서 확인하세요`);
  }
  return lines;
}

/** The notice card inside the title. `TitleMenu` makes it and hands it `update(dt, titleShown)` every frame. */
export class KeybindNotice {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private left = 0;
  private _report: KeybindLoadReport | null = null;
  private _lines: string[] = [];
  private unsub: (() => void) | null = null;
  private ctx: GameContext | null = null;

  constructor(parent: HTMLElement, private readonly onOpenSettings: () => void) {
    this.root = el('div', { cls: 'kb-notice', parent });
    this.root.hidden = true;
    const head = el('div', { cls: 'kbn-head', parent: this.root });
    el('i', { cls: 'kbn-ico', text: '⚠', parent: head });
    el('span', { cls: 'kbn-title', text: '키 설정을 확인하세요', parent: head });
    this.list = el('div', { cls: 'kbn-lines', parent: this.root });
    el('div', { cls: 'kbn-sub', text: '예전에 저장한 키 설정이 새 기본 키와 맞지 않습니다.', parent: this.root });
    const foot = el('div', { cls: 'kbn-foot', parent: this.root });
    const open = el('button', { cls: 'ui-btn', text: '키 설정 열기', parent: foot });
    open.type = 'button';
    open.addEventListener('click', (e) => { e.stopPropagation(); this.click(); this.dismiss(); this.onOpenSettings(); });
    const ok = el('button', { cls: 'ui-btn primary', text: '확인', parent: foot });
    ok.type = 'button';
    ok.addEventListener('click', (e) => { e.stopPropagation(); this.click(); this.dismiss(); });
  }

  /**
   * Takes the boot report. With `autoStart` it goes out as a toast at the first `hub:entered` instead of a card.
   * With no report it does nothing.
   */
  take(ctx: GameContext, report: KeybindLoadReport | null, autoStart: boolean): void {
    this.ctx = ctx;
    if (!report) return;
    this._report = report;
    this._lines = describeKeybindReport(report);
    if (this._lines.length === 0) return;
    if (autoStart) {
      this.unsub = ctx.bus.on('hub:entered', () => {
        this.unsub?.();
        this.unsub = null;
        for (const text of this._lines) ctx.bus.emit('ui:notify', { text: `키 설정 — ${text}`, kind: 'warning', duration: 8 });
        saveKeybinds();
      });
      return;
    }
    this.list.replaceChildren();
    for (const text of this._lines) el('div', { cls: 'kbn-line', text, parent: this.list });
    this.left = KEYBIND_NOTICE_S;
    this.root.hidden = false;
    toggleClass(this.root, 'fade', false);
    saveKeybinds();
  }

  /** Time only runs while the title is visible (not covered by a child screen). */
  update(dt: number, titleShown: boolean): void {
    if (this.root.hidden || !titleShown || this.left <= 0) return;
    this.left -= dt;
    if (this.left <= 0) this.dismiss();
    else if (this.left < 0.4) toggleClass(this.root, 'fade', true);
  }

  /** The same click sound as `MenuBase.button`. */
  private click(): void { this.ctx?.bus.emit('audio:play', { id: 'ui_click' }); }

  dismiss(): void {
    this.left = 0;
    if (!this.root.hidden) { this.root.hidden = true; toggleClass(this.root, 'fade', false); }
  }

  /** The report taken this boot · its lines · is the card up (debug / smoke). */
  get report(): KeybindLoadReport | null { return this._report; }
  get lines(): readonly string[] { return this._lines; }
  get isOn(): boolean { return !this.root.hidden; }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.root.remove();
  }
}
