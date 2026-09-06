import type { GameContext } from '@/shared';
import { Keys, keyLabel } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * 시설 관리 (housing-mode) hints, both in the `.hud.housing` layer so they show in the ship where the gameplay HUD
 * is hidden. Shown on `housing:modeChanged {active:true}`, hidden on `active:false` / `game:newMission` / `game:abort`.
 *
 * Phase 9 UI pass — the bar carries **only the placement key hints** now:
 *   • `.housing-hint` (bottom centre) — `LMB 설치 · R 회전 · X 회수 · 휠 선택 · C 취소`, every label read live from the
 *     bindings (`keyLabel`, refreshed on `input:bindingsChanged`; `C` is a fixed key owned by hub/HousingMode).
 *     The old 가구 / 셀 rows are gone: the selected piece is highlighted in the right-hand 시설 관리 panel and the
 *     ghost is already green / red under the cursor, so repeating both in text was noise.
 *   • `.housing-exit` (bottom right) — the `종료` + `Esc` chip, styled like the ship's 시설 관리 (M) hint that it
 *     replaces while the mode is open.
 */
export class HousingHint {
  readonly root: HTMLElement;
  /** Bottom-right 종료 chip (its own element so it can sit in the corner). */
  readonly exit: HTMLElement;
  private keysEl: HTMLElement;
  private exitKey: HTMLElement;
  private active = false;
  private unsubs: Array<() => void> = [];

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'housing-hint', parent });
    this.keysEl = el('div', { cls: 'row keys', text: '', parent: this.root });

    this.exit = el('div', { cls: 'housing-exit', parent });
    el('span', { cls: 't', text: '종료', parent: this.exit });
    this.exitKey = el('span', { cls: 'keycap', text: keyLabel(Keys.MENU), parent: this.exit });

    this.refreshKeys();
  }

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:modeChanged', ({ active }) => this.setActive(active)),
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
    toggleClass(this.exit, 'show', on);
  }

  private refreshKeys(): void {
    // `C` is a fixed cancel key owned by hub/HousingMode (Phase 8) — not a rebindable action, so it is printed
    // literally while every other hint reads its live binding. Esc lives in the bottom-right 종료 chip.
    setText(this.keysEl,
      `${keyLabel(Keys.FIRE)} 설치 · ${keyLabel(Keys.ROTATE_ITEM)} 회전 · ${keyLabel(Keys.DROP_ITEM)} 회수 · 휠 선택 · C 취소`);
    setText(this.exitKey, keyLabel(Keys.MENU));
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
    this.exit.remove();
  }
}
