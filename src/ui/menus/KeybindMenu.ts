import type { GameContext } from '@/shared';
import {
  KEY_ACTION_DEFS, KEY_GROUPS, Keys, canBind, conflictsOf, getKeyActionDef, keyLabel, resetKeybinds, setKeybind,
  type KeyAction,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface Row { def: KeyAction; root: HTMLElement; btn: HTMLButtonElement; warn: HTMLElement }

/**
 * Key-settings overlay (`.menu.keybind-menu`, above the title / pause menus). Every action is a row (grouped by
 * `KeyGroup`, separated by rules): function name on the left, a button with the current key on the right. Clicking
 * the button waits for the next key / mouse press (capture phase, so nothing else sees it); Esc cancels. Rows whose
 * key collides with another action in an overlapping scope are flagged with a warning. `기본 키 설정으로 초기화`
 * restores `DEFAULT_KEYS`. Emits `input:bindingsChanged` after every change and `ui:keybindsToggled` on open / close.
 *
 * It does not add a UI blocker of its own: it only ever opens on top of a menu that already holds `'menu'`.
 */
export class KeybindMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private rows: Row[] = [];
  private note: HTMLElement;
  private capturing: KeyAction | null = null;
  private _open = false;
  private ctx!: GameContext;

  private onKey = (e: KeyboardEvent): void => {
    if (!this._open) return;
    if (this.capturing) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code === 'Escape') { this.endCapture(null); return; }
      if (e.repeat) return;
      this.endCapture(e.code);
      return;
    }
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
  };
  private onMouse = (e: MouseEvent): void => {
    if (!this._open || !this.capturing) return;
    e.preventDefault(); e.stopImmediatePropagation();
    this.endCapture(`Mouse${e.button}`);
  };
  private onMouseUp = (e: MouseEvent): void => {
    // the release of the binding click must not reach the game either
    if (this._open && this.capturing) { e.preventDefault(); e.stopImmediatePropagation(); }
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'menu keybind-menu interactive', parent });
    this.root.hidden = true;
    el('div', { cls: 'scan', parent: this.root });
    const f = this.frame = el('div', { cls: 'frame', parent: this.root });
    const head = el('div', { cls: 'kb-head', parent: f });
    el('div', { cls: 'title', text: '키 설정', parent: head });
    this.note = el('div', { cls: 'subtitle', text: '기능 오른쪽 버튼을 누른 뒤 원하는 키를 입력하세요. Esc 로 취소합니다.', parent: head });

    const body = el('div', { cls: 'kb-body', parent: f });
    for (const group of KEY_GROUPS) {
      const defs = KEY_ACTION_DEFS.filter((d) => d.group === group);
      if (defs.length === 0) continue;
      const g = el('div', { cls: 'kb-group', parent: body });
      el('div', { cls: 'kb-group-title', text: group, parent: g });
      for (const d of defs) {
        const row = el('div', { cls: 'kb-row', parent: g });
        const left = el('div', { cls: 'kb-left', parent: row });
        el('span', { cls: 'kb-label', text: d.label, parent: left });
        const warn = el('span', { cls: 'kb-warn', text: '', parent: left });
        warn.hidden = true;
        const right = el('div', { cls: 'kb-right', parent: row });
        if (d.mouseOnly) el('span', { cls: 'kb-tag', text: '마우스', parent: right });
        const btn = el('button', { cls: 'ui-btn kb-key', text: '', parent: right });
        if (d.id === 'MENU') {
          btn.disabled = true;
          btn.title = 'Esc 는 모든 창을 닫는 키로 고정되어 있습니다';
        } else {
          btn.addEventListener('click', (e) => { e.stopPropagation(); this.beginCapture(d.id, btn); });
        }
        this.rows.push({ def: d.id, root: row, btn, warn });
      }
    }

    const foot = el('div', { cls: 'kb-foot', parent: f });
    const reset = el('button', { cls: 'ui-btn danger', text: '기본 키 설정으로 초기화', parent: foot });
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      this.endCapture(null);
      resetKeybinds();
      this.ctx.bus.emit('input:bindingsChanged', {});
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.refresh();
    });
    const close = el('button', { cls: 'ui-btn primary', text: '닫기', parent: foot });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

    this.root.addEventListener('mousedown', (e) => { if (!this.capturing) e.stopPropagation(); });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bind(ctx: GameContext): void { this.ctx = ctx; }

  get isOpen(): boolean { return this._open; }

  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('mousedown', this.onMouse, true);
    window.addEventListener('mouseup', this.onMouseUp, true);
    this.refresh();
    this.ctx.bus.emit('ui:keybindsToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this.endCapture(null);
    this._open = false;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('mousedown', this.onMouse, true);
    window.removeEventListener('mouseup', this.onMouseUp, true);
    this.ctx.bus.emit('ui:keybindsToggled', { open: false });
  }

  /* ── capture ──────────────────────────────────────────────────────────── */
  private beginCapture(action: KeyAction, btn: HTMLButtonElement): void {
    if (this.capturing) this.endCapture(null);
    this.capturing = action;
    btn.classList.add('capturing');
    setText(btn, '키 입력…');
    const def = getKeyActionDef(action);
    setText(this.note, def?.mouseOnly ? `${def.label}: 마우스 버튼을 누르세요 (Esc 취소)` : `${def?.label ?? action}: 키 또는 마우스 버튼을 누르세요 (Esc 취소)`);
    toggleClass(this.note, 'hot', true);
  }

  private endCapture(code: string | null): void {
    const action = this.capturing;
    this.capturing = null;
    toggleClass(this.note, 'hot', false);
    if (!action) return;
    const def = getKeyActionDef(action);
    if (code !== null) {
      if (!canBind(action, code)) {
        setText(this.note, def?.mouseOnly ? '이 기능에는 마우스 버튼만 지정할 수 있습니다' : '그 키는 지정할 수 없습니다');
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
      } else if (setKeybind(action, code)) {
        this.ctx.bus.emit('input:bindingsChanged', {});
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        const conflicts = conflictsOf(action);
        setText(this.note, conflicts.length
          ? `${def?.label ?? action} → ${keyLabel(code)} · 경고: ${conflicts.map((c) => getKeyActionDef(c)?.label ?? c).join(', ')} 와 겹칩니다`
          : `${def?.label ?? action} → ${keyLabel(code)}`);
      }
    } else {
      setText(this.note, '기능 오른쪽 버튼을 누른 뒤 원하는 키를 입력하세요. Esc 로 취소합니다.');
    }
    this.refresh();
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  refresh(): void {
    for (const r of this.rows) {
      const code = Keys[r.def];
      r.btn.classList.remove('capturing');
      setText(r.btn, keyLabel(code));
      const conflicts = conflictsOf(r.def);
      const bad = conflicts.length > 0;
      toggleClass(r.root, 'conflict', bad);
      r.warn.hidden = !bad;
      setText(r.warn, bad ? `⚠ ${conflicts.map((c) => getKeyActionDef(c)?.label.split(/\s*[·(/]/)[0] ?? c).join(', ')} 와 겹침` : '');
    }
  }

  dispose(): void {
    this.close();
    this.root.remove();
  }
}
