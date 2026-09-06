import type { GameContext } from '@/shared';
import { el, setText } from '../dom';
import { MenuBase } from './MenuBase';

/**
 * Escape menu: 게임으로 돌아가기 / 설정 / (임무 중에만) 함선으로 귀환 / 타이틀로. Driven by `game:paused`.
 *
 * Phase 8: the **ship** can be paused too (`game:paused {freeze:false}` from `game/GameFlowSystem` — Escape in the hub
 * no longer opens the terminal). The hub variant re-words the title / subtitle and hides `함선으로 귀환`, which only
 * makes sense while a mission is running.
 *
 * - `설정` opens the shared `SettingsMenu` overlay on top of this menu (`onSettings`, owned by HudSystem); the key
 *   rebinding lives inside it, so this menu no longer carries its own `키 설정 변경` button.
 * - `함선으로 귀환` emits `hub:enter {ship}` (shared ship while in a lobby, else personal); the hub aborts the mission.
 * - `타이틀로` leaves the lobby first (so `game:abort` does not regroup us in the shared ship) and then aborts, which
 *   sends GameFlow to `menu` and tears the hub down → the title screen.
 * Multiplayer / the ship: the simulation keeps running (`freeze:false`), so the subtitle says so.
 */
export class PauseMenu extends MenuBase {
  private titleEl: HTMLElement;
  private subtitle: HTMLElement;
  private mpNote: HTMLElement;
  private returnBtn: HTMLButtonElement;
  private hint: HTMLElement;
  /** True while the pause was opened from the ship (no mission to abandon). */
  private inHub = false;

  constructor(parent: HTMLElement, private readonly onSettings: () => void) {
    super(parent, 'pause');
    const head = el('div', { parent: this.frame });
    this.titleEl = el('div', { cls: 'title', text: '일시 정지', parent: head });
    this.subtitle = el('div', { cls: 'subtitle', text: '임무 진행이 정지되었습니다', parent: head });
    this.mpNote = el('div', { cls: 'mp-note', text: '멀티플레이: 일시 정지 중에도 임무는 계속 진행됩니다', parent: this.frame });
    this.mpNote.hidden = true;
    const actions = el('div', { cls: 'actions', parent: this.frame });
    this.button(actions, '게임으로 돌아가기', () => this.ctx.bus.emit('game:paused', { paused: false }), 'primary');
    this.button(actions, '설정', () => this.onSettings());
    this.returnBtn = this.button(actions, '함선으로 귀환', () => this.returnToShip(), 'danger');
    this.button(actions, '타이틀로', () => this.toTitle(), 'danger');
    this.hint = el('div', { cls: 'hint', text: 'Esc — 계속 · 귀환 시 임무를 포기합니다', parent: this.frame });
  }

  override bind(ctx: GameContext): void {
    super.bind(ctx);
    this.unsubs.push(
      ctx.bus.on('game:paused', ({ paused, freeze }) => {
        if (!paused) { this.hide(); return; }
        // The ship pause (Phase 8) is menu-only: nothing to abandon, so no 함선으로 귀환 and no squad note.
        const hub = ctx.isHubPhase();
        this.inHub = hub;
        const mp = !hub && (ctx.isMultiplayer || freeze === false);
        this.mpNote.hidden = !mp;
        // `.ui-btn` sets `display`, so the `hidden` attribute would not hide it — drive `display` directly.
        this.returnBtn.style.display = hub ? 'none' : '';
        setText(this.titleEl, hub ? '함선 · 일시 정지' : '일시 정지');
        setText(this.subtitle, hub
          ? '함선 시스템은 계속 작동합니다'
          : mp ? '분대 임무 — 시뮬레이션은 계속됩니다' : '임무 진행이 정지되었습니다');
        setText(this.hint, hub
          ? 'Esc — 계속 · 타이틀로 이동 시 함선에서 내립니다'
          : 'Esc — 계속 · 귀환 시 임무를 포기합니다');
        this.show();
      }),
      ctx.bus.on('game:phaseChanged', () => this.hide()),
    );
  }

  /** Whether the hub variant is showing (debug). */
  get isHubVariant(): boolean { return this.inHub; }

  private returnToShip(): void {
    this.ctx.bus.emit('hub:enter', { ship: this.ctx.net?.lobby ? 'shared' : 'personal' });
  }

  /**
   * 타이틀로. The lobby is left **before** the abort: `GameFlowSystem.onAbort` regroups the squad in the shared ship
   * whenever `ctx.net.lobby` still exists, which would bounce us straight back into the hub.
   */
  private toTitle(): void {
    const ctx = this.ctx;
    try { if (ctx.net?.lobby) ctx.net.leaveLobby(); } catch (e) { console.error('[ui] leaveLobby failed', e); }
    ctx.bus.emit('game:paused', { paused: false });
    // GameFlow's `game:abort` handler clears the mission state and sets the phase to `menu`;
    // HubSystem tears the ship down on the same event, so the title screen is what remains.
    ctx.bus.emit('game:abort', {});
  }
}
