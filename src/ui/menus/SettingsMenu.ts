import type { AudioChannel, GameContext } from '@/shared';
import { el, setText } from '../dom';
import type { KeybindMenu } from './KeybindMenu';
import { ControlsPanel, KEYBIND_BUTTON_LABEL } from './ControlsPanel';

interface Slider {
  channel: AudioChannel;
  input: HTMLInputElement;
  value: HTMLElement;
}

const CHANNEL_LABEL: Readonly<Record<AudioChannel, string>> = { master: '전체', sfx: '효과음' };
const CHANNEL_DESC: Readonly<Record<AudioChannel, string>> = {
  master: '모든 소리의 기준 볼륨입니다.',
  sfx: '총성 · 타격 · UI 등 효과음 볼륨입니다.',
};
/** Channels the 오디오 section exposes. A BGM row would simply be appended here once music exists. */
const CHANNELS: readonly AudioChannel[] = ['master', 'sfx'];

/**
 * 설정 panel (`.menu.settings-menu.side`, Phase 8; a **left-centre side panel** since Phase 11 so it sits on the same
 * side as the re-laid-out ESC button column) opened from the pause menu's `설정` button — in a mission and in the ship
 * alike. Two sections:
 *   - **오디오**: 전체 / 효과음 sliders driving `ctx.audio.setVolume(channel, v)` live, with `ctx.audio.preview(channel)`
 *     on release and the current percentage next to the label. `ctx.audio` may be null (audio system not registered) —
 *     the rows then render disabled with a note. Room is left for a future BGM row (`CHANNELS`), but there is no BGM.
 *   - **키 설정**: a real `menus/ControlsPanel` instance (the procedural keyboard + mouse diagram and the per-function
 *     list, identical to the title screen) with the `KEYBIND_BUTTON_LABEL` button under it, which opens the shared
 *     `KeybindMenu` overlay on top of this one. There is exactly one rebinding code path in the game (that class);
 *     this panel never duplicates its rows.
 *
 * Like `KeybindMenu` it takes **no** `ctx.uiBlockers` token: it only ever opens on top of a menu that already holds
 * `'menu'` (the pause menu), so closing it must not release the host's blocker. Escape is captured and yields while
 * `keybinds.isOpen`. Emits `ui:settingsToggled`.
 */
export class SettingsMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private note: HTMLElement;
  private controls: ControlsPanel;
  private sliders: Slider[] = [];
  private _open = false;
  private ctx!: GameContext;

  /** Escape closes the settings — unless the key-settings overlay above us is open (it owns Escape then). */
  private onKey = (e: KeyboardEvent): void => {
    if (!this._open || this.keybinds.isOpen) return;
    if (e.code !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };

  constructor(parent: HTMLElement, private readonly keybinds: KeybindMenu) {
    this.root = el('div', { cls: 'menu settings-menu side interactive', parent });
    this.root.hidden = true;
    el('div', { cls: 'scan', parent: this.root });
    const f = this.frame = el('div', { cls: 'frame', parent: this.root });

    const head = el('div', { cls: 'set-head', parent: f });
    el('div', { cls: 'title', text: '설정', parent: head });
    this.note = el('div', { cls: 'subtitle', text: '키 설정과 오디오 볼륨을 조절합니다.', parent: head });

    const body = el('div', { cls: 'set-body', parent: f });

    /* ── 오디오 ── */
    const audio = el('div', { cls: 'set-section audio', parent: body });
    el('div', { cls: 'set-section-title', text: '오디오', parent: audio });
    for (const channel of CHANNELS) {
      const row = el('div', { cls: `set-row vol ${channel}`, parent: audio });
      const left = el('div', { cls: 'set-row-left', parent: row });
      el('div', { cls: 'set-row-label', text: CHANNEL_LABEL[channel], parent: left });
      el('div', { cls: 'set-row-desc', text: CHANNEL_DESC[channel], parent: left });
      const right = el('div', { cls: 'set-row-right', parent: row });
      const input = el('input', { cls: 'set-slider', parent: right });
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = '100';
      const value = el('span', { cls: 'set-vol ui-mono', text: '100%', parent: right });
      // Drag → apply live; release (change) → a short reference blip at the new level.
      input.addEventListener('input', () => this.onSlide(channel, input, value));
      input.addEventListener('change', () => {
        this.onSlide(channel, input, value);
        this.ctx.audio?.preview(channel);
      });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      this.sliders.push({ channel, input, value });
    }
    el('div', { cls: 'set-hint', text: '배경 음악은 아직 없습니다.', parent: audio });

    /* ── 키 설정 — the title screen's own diagram, then the one rebinding entry point ── */
    const keys = el('div', { cls: 'set-section keys', parent: body });
    el('div', { cls: 'set-section-title', text: '키 설정', parent: keys });
    this.controls = new ControlsPanel(keys);
    const keyRow = el('div', { cls: 'set-row', parent: keys });
    el('div', { cls: 'set-row-label', text: '키 배치를 변경하고 충돌을 확인합니다.', parent: keyRow });
    const keyBtn = el('button', { cls: 'ui-btn set-key-btn', text: KEYBIND_BUTTON_LABEL, parent: keyRow });
    keyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.keybinds.open();
    });

    const foot = el('div', { cls: 'set-foot', parent: f });
    const close = el('button', { cls: 'ui-btn primary', text: '닫기', parent: foot });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
  }

  get isOpen(): boolean { return this._open; }

  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    window.addEventListener('keydown', this.onKey, true);
    this.refresh();
    this.ctx.bus.emit('ui:settingsToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(): void {
    if (!this._open) return;
    this.keybinds.close();
    this._open = false;
    this.root.hidden = true;
    window.removeEventListener('keydown', this.onKey, true);
    this.ctx.bus.emit('ui:settingsToggled', { open: false });
  }

  /** Re-read the live volumes + key diagram (called on open; cheap enough to call again from a smoke). */
  refresh(): void {
    this.controls.refresh();
    const audio = this.ctx.audio;
    for (const s of this.sliders) {
      const v = audio ? audio.settings[s.channel] : 1;
      const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
      s.input.value = String(pct);
      s.input.disabled = !audio;
      setText(s.value, `${pct}%`);
    }
    setText(this.note, audio
      ? '키 설정과 오디오 볼륨을 조절합니다.'
      : '오디오 시스템을 사용할 수 없어 볼륨을 조절할 수 없습니다.');
  }

  private onSlide(channel: AudioChannel, input: HTMLInputElement, value: HTMLElement): void {
    const pct = Math.max(0, Math.min(100, Math.round(Number(input.value) || 0)));
    setText(value, `${pct}%`);
    this.ctx.audio?.setVolume(channel, pct / 100);
  }

  dispose(): void {
    this.close();
    // Same order as `TitleMenu`: the diagram unsubscribes from `onKeybindsChanged` before its host goes away.
    this.controls.dispose();
    this.root.remove();
  }
}
