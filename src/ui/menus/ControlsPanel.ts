import {
  KEY_ACTION_DEFS, KEY_GROUPS, Keys, actionsOnKey, keyLabel, onKeybindsChanged, type KeyAction, type KeyActionDef, type KeyGroup,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

/** One physical key of the diagram: `KeyboardEvent.code`, printed label, width in key units. */
interface KeyDef { code: string; label: string; w?: number }

/** Compact ANSI layout (number row → modifier row). Widths in units of one letter key. */
const KEYBOARD_ROWS: readonly (readonly KeyDef[])[] = [
  [
    { code: 'Escape', label: 'Esc', w: 1.25 }, { code: 'Digit1', label: '1' }, { code: 'Digit2', label: '2' }, { code: 'Digit3', label: '3' },
    { code: 'Digit4', label: '4' }, { code: 'Digit5', label: '5' }, { code: 'Digit6', label: '6' }, { code: 'Digit7', label: '7' },
    { code: 'Digit8', label: '8' }, { code: 'Digit9', label: '9' }, { code: 'Digit0', label: '0' }, { code: 'Minus', label: '-' },
    { code: 'Equal', label: '=' }, { code: 'Backspace', label: '⌫', w: 1.75 },
  ],
  [
    { code: 'Tab', label: 'Tab', w: 1.75 }, { code: 'KeyQ', label: 'Q' }, { code: 'KeyW', label: 'W' }, { code: 'KeyE', label: 'E' },
    { code: 'KeyR', label: 'R' }, { code: 'KeyT', label: 'T' }, { code: 'KeyY', label: 'Y' }, { code: 'KeyU', label: 'U' },
    { code: 'KeyI', label: 'I' }, { code: 'KeyO', label: 'O' }, { code: 'KeyP', label: 'P' }, { code: 'BracketLeft', label: '[' },
    { code: 'BracketRight', label: ']' }, { code: 'Backslash', label: '\\', w: 1.25 },
  ],
  [
    { code: 'CapsLock', label: 'Caps', w: 2 }, { code: 'KeyA', label: 'A' }, { code: 'KeyS', label: 'S' }, { code: 'KeyD', label: 'D' },
    { code: 'KeyF', label: 'F' }, { code: 'KeyG', label: 'G' }, { code: 'KeyH', label: 'H' }, { code: 'KeyJ', label: 'J' },
    { code: 'KeyK', label: 'K' }, { code: 'KeyL', label: 'L' }, { code: 'Semicolon', label: ';' }, { code: 'Quote', label: "'" },
    { code: 'Enter', label: 'Enter', w: 2 },
  ],
  [
    { code: 'ShiftLeft', label: 'Shift', w: 2.5 }, { code: 'KeyZ', label: 'Z' }, { code: 'KeyX', label: 'X' }, { code: 'KeyC', label: 'C' },
    { code: 'KeyV', label: 'V' }, { code: 'KeyB', label: 'B' }, { code: 'KeyN', label: 'N' }, { code: 'KeyM', label: 'M' },
    { code: 'Comma', label: ',' }, { code: 'Period', label: '.' }, { code: 'Slash', label: '/' }, { code: 'ShiftRight', label: 'Shift', w: 2.5 },
  ],
  [
    { code: 'ControlLeft', label: 'Ctrl', w: 1.5 }, { code: 'MetaLeft', label: '◆', w: 1.25 }, { code: 'AltLeft', label: 'Alt', w: 1.5 },
    { code: 'Space', label: '', w: 6.25 }, { code: 'AltRight', label: 'Alt', w: 1.5 }, { code: 'ContextMenu', label: '☰', w: 1.25 },
    { code: 'ControlRight', label: 'Ctrl', w: 1.5 },
  ],
];

/** Mouse buttons drawn on the mouse silhouette (SVG regions). */
const MOUSE_BUTTONS: readonly { code: string; label: string; cls: string }[] = [
  { code: 'Mouse0', label: 'LMB', cls: 'lmb' },
  { code: 'Mouse2', label: 'RMB', cls: 'rmb' },
  { code: 'Mouse1', label: 'MMB', cls: 'mmb' },
  { code: 'Mouse3', label: 'M4', cls: 'm4' },
  { code: 'Mouse4', label: 'M5', cls: 'm5' },
];

const MOVE_ACTIONS: readonly KeyAction[] = ['FORWARD', 'LEFT', 'BACK', 'RIGHT'];

/**
 * Controls diagram for the title screen: a procedural keyboard (DOM keys) and a mouse (inline SVG) with every bound
 * key highlighted and captioned, plus the per-function list underneath (grouped, inventory-internal keys omitted).
 * Re-renders on `onKeybindsChanged` so a rebinding in the key-settings overlay shows up immediately.
 */
export class ControlsPanel {
  readonly root: HTMLElement;
  private keyEls = new Map<string, { el: HTMLElement; cap: HTMLElement }>();
  private mouseEls = new Map<string, { shape: SVGElement; cap: HTMLElement }>();
  private list: HTMLElement;
  private unsub: () => void;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'controls-panel', parent });
    const diagram = el('div', { cls: 'ctl-diagram', parent: this.root });
    this.buildKeyboard(diagram);
    this.buildMouse(diagram);
    this.list = el('div', { cls: 'ctl-list', parent: this.root });
    this.refresh();
    this.unsub = onKeybindsChanged(() => this.refresh());
  }

  /* ── keyboard ─────────────────────────────────────────────────────────── */
  private buildKeyboard(parent: HTMLElement): void {
    const kb = el('div', { cls: 'ctl-keyboard', parent });
    for (const row of KEYBOARD_ROWS) {
      const r = el('div', { cls: 'ctl-row', parent: kb });
      for (const k of row) {
        const key = el('div', { cls: 'ctl-key', parent: r });
        key.style.flex = `${k.w ?? 1} 0 0`;
        key.dataset.code = k.code;
        el('span', { cls: 'lbl', text: k.label, parent: key });
        const cap = el('span', { cls: 'cap', text: '', parent: key });
        this.keyEls.set(k.code, { el: key, cap });
      }
    }
  }

  /* ── mouse ────────────────────────────────────────────────────────────── */
  private buildMouse(parent: HTMLElement): void {
    const wrap = el('div', { cls: 'ctl-mouse', parent });
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 180');
    svg.setAttribute('class', 'ctl-mouse-svg');
    const mk = (tag: string, attrs: Record<string, string>): SVGElement => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      svg.appendChild(e);
      return e;
    };
    // body
    mk('path', { class: 'body', d: 'M60 8 C 28 8 14 34 14 72 L 14 118 C 14 152 34 174 60 174 C 86 174 106 152 106 118 L 106 72 C 106 34 92 8 60 8 Z' });
    // buttons: left / right halves of the upper shell, wheel in the middle, two side buttons on the left flank
    const lmb = mk('path', { class: 'btn lmb', d: 'M57 10 C 30 12 18 36 17 70 L 17 76 L 51 76 L 51 40 L 57 40 Z' });
    const rmb = mk('path', { class: 'btn rmb', d: 'M63 10 C 90 12 102 36 103 70 L 103 76 L 69 76 L 69 40 L 63 40 Z' });
    const mmb = mk('rect', { class: 'btn mmb', x: '53', y: '30', width: '14', height: '30', rx: '6' });
    const m4 = mk('rect', { class: 'btn m4', x: '8', y: '84', width: '9', height: '20', rx: '3' });
    const m5 = mk('rect', { class: 'btn m5', x: '8', y: '108', width: '9', height: '20', rx: '3' });
    mk('line', { class: 'seam', x1: '60', y1: '62', x2: '60', y2: '76' });
    wrap.appendChild(svg);
    const caps = el('div', { cls: 'ctl-mouse-caps', parent: wrap });
    const shapes: Record<string, SVGElement> = { lmb, rmb, mmb, m4, m5 };
    for (const b of MOUSE_BUTTONS) {
      const cap = el('div', { cls: `mcap ${b.cls}`, parent: caps });
      el('span', { cls: 'k', text: b.label, parent: cap });
      el('span', { cls: 'v', text: '', parent: cap });
      this.mouseEls.set(b.code, { shape: shapes[b.cls], cap });
    }
  }

  /* ── render ───────────────────────────────────────────────────────────── */
  refresh(): void {
    // keyboard highlights + captions
    for (const [code, k] of this.keyEls) {
      const acts = actionsOnKey(code).filter((d) => !d.menuOnly);
      const bound = acts.length > 0;
      toggleClass(k.el, 'bound', bound);
      setText(k.cap, bound ? this.caption(acts) : '');
      k.el.title = bound ? acts.map((a) => a.label).join(' · ') : '';
    }
    for (const [code, m] of this.mouseEls) {
      const acts = actionsOnKey(code);
      const bound = acts.length > 0;
      m.shape.classList.toggle('bound', bound);
      toggleClass(m.cap, 'bound', bound);
      const v = m.cap.querySelector<HTMLElement>('.v');
      if (v) setText(v, bound ? acts.map((a) => this.shortLabel(a)).join(' · ') : '—');
    }
    // function list
    this.list.textContent = '';
    for (const group of KEY_GROUPS) {
      const defs = KEY_ACTION_DEFS.filter((d) => d.group === group && !d.menuOnly);
      if (defs.length === 0) continue;
      const g = el('div', { cls: 'ctl-group', parent: this.list });
      el('div', { cls: 'ctl-group-title', text: group, parent: g });
      const rows = el('div', { cls: 'ctl-rows', parent: g });
      const done = new Set<KeyAction>();
      for (const d of defs) {
        if (done.has(d.id)) continue;
        if (group === '이동' && MOVE_ACTIONS.includes(d.id)) {
          // W A S D collapse into one row when they are still four single keys
          for (const m of MOVE_ACTIONS) done.add(m);
          this.row(rows, MOVE_ACTIONS.map((m) => keyLabel(Keys[m])), '이동');
          continue;
        }
        done.add(d.id);
        this.row(rows, [keyLabel(Keys[d.id])], d.label);
      }
    }
  }

  private row(parent: HTMLElement, keys: string[], label: string): void {
    const r = el('div', { cls: 'ctl-fn', parent });
    const ks = el('div', { cls: 'keys', parent: r });
    for (const k of keys) el('span', { cls: 'keycap', text: k, parent: ks });
    el('span', { cls: 'fn', text: label, parent: r });
  }

  /** Caption printed inside a key: the shortest useful word of the first action (movement keys share one). */
  private caption(acts: KeyActionDef[]): string {
    const a = acts[0];
    if (MOVE_ACTIONS.includes(a.id)) return '이동';
    return this.shortLabel(a);
  }

  private shortLabel(a: KeyActionDef): string {
    const cut = a.label.split(/\s*[·(/]/)[0].trim();
    return cut.length > 6 ? `${cut.slice(0, 5)}…` : cut;
  }

  dispose(): void { this.unsub(); this.root.remove(); }
}

/** Shared by TitleMenu / PauseMenu: label of the key-settings button. */
export const KEYBIND_BUTTON_LABEL = '키 설정 변경';

/** Groups exposed for tests / other menus. */
export const CONTROLS_GROUPS: readonly KeyGroup[] = KEY_GROUPS;
