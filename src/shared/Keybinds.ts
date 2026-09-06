import { DEFAULT_KEYS, KEYBINDS_STORAGE_KEY, Keys, mouseButtonOf, type KeyBindings } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * Key rebinding (2026-09-06). `Keys` (constants.ts) is the live table every system reads at use time; this
 * module owns its persistence (localStorage `scav.keybinds`), the user-facing action catalogue (labels /
 * groups / scopes for the controls screen and the rebinding menu), conflict detection and key-code labels.
 * `main.ts` calls `loadKeybinds()` once before the systems initialise.
 * ──────────────────────────────────────────────────────────────────────────── */

export type KeyAction = keyof KeyBindings;

/**
 * Where an action is listened to. Two actions on the same key only clash when their scopes overlap:
 * `global` clashes with everything, `game` with `game`, `inventory` (window open) with `inventory`.
 */
export type KeyScope = 'game' | 'inventory' | 'global';

export interface KeyActionDef {
  id: KeyAction;
  /** Korean label shown in the controls list. */
  label: string;
  group: KeyGroup;
  scope: KeyScope;
  /** Only mouse buttons may be bound (사격 / 조준 / 핑). */
  mouseOnly?: boolean;
  /** Listed in the rebinding menu but not on the title screen (inventory-internal keys). */
  menuOnly?: boolean;
}

export type KeyGroup = '이동' | '전투' | '장비' | '상호작용' | '인터페이스' | '인벤토리';
export const KEY_GROUPS: readonly KeyGroup[] = ['이동', '전투', '장비', '상호작용', '인터페이스', '인벤토리'];

/** Every user-facing action, in display order. Aliases (`KEY_ALIASES`) are not listed. */
export const KEY_ACTION_DEFS: readonly KeyActionDef[] = [
  { id: 'FORWARD', label: '앞으로', group: '이동', scope: 'game' },
  { id: 'BACK', label: '뒤로', group: '이동', scope: 'game' },
  { id: 'LEFT', label: '왼쪽', group: '이동', scope: 'game' },
  { id: 'RIGHT', label: '오른쪽', group: '이동', scope: 'game' },
  { id: 'SPRINT', label: '달리기 (스태미나)', group: '이동', scope: 'game' },
  { id: 'JUMP', label: '점프 · (전투불능) 포기 · (사망) 부활', group: '이동', scope: 'game' },
  { id: 'CROUCH', label: '앉기', group: '이동', scope: 'game' },
  { id: 'PRONE', label: '엎드리기', group: '이동', scope: 'game' },
  { id: 'DIVE', label: '구르기', group: '이동', scope: 'game' },

  { id: 'FIRE', label: '사격 · 사용', group: '전투', scope: 'game', mouseOnly: true },
  { id: 'AIM', label: '조준 · (투척) 언더핸드', group: '전투', scope: 'game', mouseOnly: true },
  { id: 'RELOAD', label: '재장전 / (수류탄을 들고 있을 때) 코킹', group: '전투', scope: 'game' },
  { id: 'PRIMARY', label: '주무기 I', group: '전투', scope: 'game' },
  { id: 'PRIMARY2', label: '주무기 II', group: '전투', scope: 'game' },
  { id: 'SECONDARY', label: '보조무기', group: '전투', scope: 'game' },
  { id: 'SWAP', label: '이전 무기', group: '전투', scope: 'game' },
  { id: 'MELEE', label: '근접 공격', group: '전투', scope: 'game' },

  { id: 'IMPLANT', label: '전술 임플란트', group: '장비', scope: 'game' },
  { id: 'STIM', label: '스팀', group: '장비', scope: 'game' },
  { id: 'QUICK', label: '빠른 사용 (길게: 휠)', group: '장비', scope: 'game' },
  { id: 'SHIP_CALL', label: '함선 호출', group: '장비', scope: 'game' },
  { id: 'THROW_MODE', label: '투척 방식 전환 (가젯)', group: '장비', scope: 'game' },

  { id: 'INTERACT', label: '상호작용 (길게) · 전투불능 아군 구조', group: '상호작용', scope: 'game' },
  { id: 'PING', label: '핑 (홀드+드래그: 방향 핑)', group: '상호작용', scope: 'game', mouseOnly: true },
  { id: 'CHAT', label: '채팅', group: '상호작용', scope: 'game' },

  { id: 'INVENTORY', label: '인벤토리', group: '인터페이스', scope: 'global' },
  { id: 'MAP', label: '지도', group: '인터페이스', scope: 'game' },
  { id: 'MENU', label: '일시 정지 · 닫기', group: '인터페이스', scope: 'global' },

  /* dev console (only active on a dev client; listed so the key can be moved off a layout that lacks `) */
  { id: 'CONSOLE', label: '개발자 콘솔 (서버 PC 전용)', group: '인터페이스', scope: 'global', menuOnly: true },
  { id: 'MOVE_CHEAT', label: '이동 치트 (콘솔 /movecheat 1)', group: '인터페이스', scope: 'game', menuOnly: true },

  { id: 'ROTATE_ITEM', label: '아이템 회전', group: '인벤토리', scope: 'inventory', menuOnly: true },
  { id: 'DROP_ITEM', label: '아이템 버리기', group: '인벤토리', scope: 'inventory', menuOnly: true },
];

/** Hidden actions that always follow another one (contextual uses of the same key). */
export const KEY_ALIASES: Readonly<Partial<Record<KeyAction, KeyAction>>> = {
  RESPAWN: 'JUMP', GIVE_UP: 'JUMP', GRENADE: 'SHIP_CALL',
};

const DEF_BY_ID = new Map<KeyAction, KeyActionDef>(KEY_ACTION_DEFS.map((d) => [d.id, d]));
export function getKeyActionDef(id: KeyAction): KeyActionDef | undefined { return DEF_BY_ID.get(id); }

export function isMouseCode(code: string): boolean { return mouseButtonOf(code) >= 0; }

const MOUSE_LABEL = ['LMB', 'MMB', 'RMB', 'M4', 'M5'];
const SPECIAL_LABEL: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Enter',
  ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl',
  AltLeft: 'Alt', AltRight: 'R Alt', CapsLock: 'Caps', Backspace: 'Back', Delete: 'Del', Insert: 'Ins',
  Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  MetaLeft: 'Win', MetaRight: 'Win', ContextMenu: 'Menu',
};

/** Human label of a key / mouse code: `KeyW` → `W`, `Digit1` → `1`, `Mouse0` → `LMB`, `ShiftLeft` → `Shift`. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  const m = mouseButtonOf(code);
  if (m >= 0) return MOUSE_LABEL[m] ?? `M${m + 1}`;
  if (code in SPECIAL_LABEL) return SPECIAL_LABEL[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * May `code` be bound to `action`? Mouse-only actions take mouse buttons only; nothing but `MENU` may sit on
 * Escape (it closes every window), and modifier-less browser keys we cannot intercept are refused.
 */
export function canBind(action: KeyAction, code: string): boolean {
  const def = DEF_BY_ID.get(action);
  if (!def || !code) return false;
  const mouse = isMouseCode(code);
  if (def.mouseOnly) return mouse;
  if (code === 'Escape') return action === 'MENU';
  if (code === 'F5' || code === 'F11' || code === 'F12' || code.startsWith('Meta')) return false;
  return true;
}

function scopesClash(a: KeyScope, b: KeyScope): boolean {
  return a === 'global' || b === 'global' || a === b;
}

/** Other listed actions sharing `action`'s key within an overlapping scope. */
export function conflictsOf(action: KeyAction): KeyAction[] {
  const def = DEF_BY_ID.get(action);
  if (!def) return [];
  const code = Keys[action];
  const out: KeyAction[] = [];
  for (const other of KEY_ACTION_DEFS) {
    if (other.id === action || Keys[other.id] !== code) continue;
    if (scopesClash(def.scope, other.scope)) out.push(other.id);
  }
  return out;
}

/** Every listed action involved in at least one conflict. */
export function allConflicts(): Set<KeyAction> {
  const set = new Set<KeyAction>();
  for (const d of KEY_ACTION_DEFS) if (conflictsOf(d.id).length > 0) set.add(d.id);
  return set;
}

/** Listed actions bound to `code` (labels for the keyboard diagram). */
export function actionsOnKey(code: string): KeyActionDef[] {
  return KEY_ACTION_DEFS.filter((d) => Keys[d.id] === code);
}

/* ── persistence ─────────────────────────────────────────────────────────── */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to binding changes (menus refresh their labels). Returns the unsubscribe. */
export function onKeybindsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify(): void { for (const cb of listeners) cb(); }

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function applyAliases(): void {
  for (const alias in KEY_ALIASES) {
    const src = KEY_ALIASES[alias as KeyAction];
    if (src) Keys[alias as KeyAction] = Keys[src];
  }
}

/** Overwrite `Keys` from localStorage (unknown / invalid entries are ignored). Call once at startup. */
export function loadKeybinds(): void {
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(KEYBINDS_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<Record<string, unknown>>;
    if (!saved || typeof saved !== 'object') return;
    for (const d of KEY_ACTION_DEFS) {
      const v = saved[d.id];
      if (typeof v === 'string' && canBind(d.id, v)) Keys[d.id] = v;
    }
    applyAliases();
  } catch { /* corrupt → defaults */ }
}

export function saveKeybinds(): void {
  const s = storage();
  if (!s) return;
  const out: Partial<Record<KeyAction, string>> = {};
  for (const d of KEY_ACTION_DEFS) if (Keys[d.id] !== DEFAULT_KEYS[d.id]) out[d.id] = Keys[d.id];
  try {
    if (Object.keys(out).length === 0) s.removeItem(KEYBINDS_STORAGE_KEY);
    else s.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(out));
  } catch { /* quota / private mode */ }
}

/** Bind `action` to `code` (validated by `canBind`), persist and notify. False when refused. */
export function setKeybind(action: KeyAction, code: string): boolean {
  if (!canBind(action, code)) return false;
  if (Keys[action] === code) return true;
  Keys[action] = code;
  applyAliases();
  saveKeybinds();
  notify();
  return true;
}

/** Back to `DEFAULT_KEYS`. */
export function resetKeybinds(): void {
  for (const k in DEFAULT_KEYS) Keys[k as KeyAction] = DEFAULT_KEYS[k as KeyAction];
  saveKeybinds();
  notify();
}

/** true when any listed action differs from its default. */
export function hasCustomKeybinds(): boolean {
  return KEY_ACTION_DEFS.some((d) => Keys[d.id] !== DEFAULT_KEYS[d.id]);
}
