import type { GameContext } from '@/shared';
import { FURNITURE_DEF_MAP, Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';

type Yaw = 0 | 1 | 2 | 3;
/** Facing glyph per 90° step (yaw 0 = the furniture's default facing). */
const YAW_GLYPH: readonly string[] = ['↑', '→', '↓', '←'];

/**
 * Housing-mode hint bar (`.housing-hint`, bottom-centre of its own `.hud.housing` layer so it shows in the ship where the
 * gameplay HUD is hidden). Shown on `housing:modeChanged {active:true}`: selected furniture name (`FURNITURE_DEF_MAP`) +
 * yaw glyph / degrees from `housing:selectionChanged` (`선택 없음 — 휠로 선택` when nothing is picked), cursor cell `x,y` +
 * `설치 가능` / `설치 불가` from `housing:cursorChanged`, and the key hints
 * `LMB 설치 · R 회전 · X 회수 · 휠 선택 · C 취소 · Esc 종료` read from the live bindings
 * (`keyLabel(Keys.FIRE / ROTATE_ITEM / DROP_ITEM / MENU)`, refreshed on `input:bindingsChanged`; `C` is fixed).
 * Hidden (and reset) on `active:false`, `game:newMission` and `game:abort`.
 */
export class HousingHint {
  readonly root: HTMLElement;
  private selEl: HTMLElement;
  private yawEl: HTMLElement;
  private cellEl: HTMLElement;
  private validEl: HTMLElement;
  private keysEl: HTMLElement;
  private active = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'housing-hint', parent });
    const sel = el('div', { cls: 'row sel', parent: this.root });
    el('span', { cls: 'k', text: '가구', parent: sel });
    this.selEl = el('span', { cls: 'v name', text: '선택 없음 — 휠로 선택', parent: sel });
    this.yawEl = el('span', { cls: 'yaw', text: '', parent: sel });
    const cell = el('div', { cls: 'row cell', parent: this.root });
    el('span', { cls: 'k', text: '셀', parent: cell });
    this.cellEl = el('span', { cls: 'v ui-mono', text: '—', parent: cell });
    this.validEl = el('span', { cls: 'valid', text: '', parent: cell });
    this.keysEl = el('div', { cls: 'row keys', text: '', parent: this.root });
    this.refreshKeys();
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:modeChanged', ({ active }) => this.setActive(active)),
      b.on('housing:selectionChanged', ({ defId, yaw }) => this.setSelection(defId, yaw)),
      b.on('housing:cursorChanged', ({ x, y, valid }) => {
        setText(this.cellEl, `${x},${y}`);
        setText(this.validEl, valid ? '설치 가능' : '설치 불가');
        toggleClass(this.validEl, 'ok', valid);
        toggleClass(this.validEl, 'bad', !valid);
      }),
      b.on('input:bindingsChanged', () => this.refreshKeys()),
      b.on('game:newMission', () => this.setActive(false)),
      b.on('game:abort', () => this.setActive(false)),
    );
  }

  /** Whether the bar is showing (debug). */
  get isActive(): boolean { return this.active; }

  private setActive(on: boolean): void {
    if (this.active === on) return;
    this.active = on;
    toggleClass(this.root, 'show', on);
    if (!on) {
      this.setSelection(null, 0);
      setText(this.cellEl, '—');
      setText(this.validEl, '');
      this.validEl.classList.remove('ok', 'bad');
    }
  }

  private setSelection(defId: string | null, yaw: Yaw): void {
    const def = defId ? FURNITURE_DEF_MAP.get(defId) : undefined;
    setText(this.selEl, def ? def.name : defId ? defId : '선택 없음 — 휠로 선택');
    toggleClass(this.selEl, 'none', !defId);
    setText(this.yawEl, defId ? `${YAW_GLYPH[yaw] ?? '↑'} ${yaw * 90}°` : '');
    if (def) this.selEl.style.setProperty('--fc', def.color); else this.selEl.style.removeProperty('--fc');
  }

  private refreshKeys(): void {
    // `C` is a fixed cancel key owned by hub/HousingMode (Phase 8, alongside Escape) — not a rebindable action,
    // so it is printed literally while every other hint reads its live binding.
    setText(this.keysEl,
      `${keyLabel(Keys.FIRE)} 설치 · ${keyLabel(Keys.ROTATE_ITEM)} 회전 · ${keyLabel(Keys.DROP_ITEM)} 회수 · 휠 선택 · C 취소 · ${keyLabel(Keys.MENU)} 종료`);
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
