import type { AudioChannel, GameContext } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import type { KeybindMenu } from './KeybindMenu';
import { ControlsPanel, KEYBIND_BUTTON_LABEL } from './ControlsPanel';
import type { DisplaySettings } from './displaySettings';
import { DISPLAY_SCALES, isFullscreen, loadDisplaySettings, saveDisplaySettings, setFullscreen } from './displaySettings';

interface Slider {
  channel: AudioChannel;
  input: HTMLInputElement;
  value: HTMLElement;
}

/** The three sections, in nav order. 화면 is the default so the 전체화면 toggle is the first thing on screen. */
type SectionId = 'display' | 'audio' | 'keys';
const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'display', label: '화면 설정' },
  { id: 'audio', label: '오디오 설정' },
  { id: 'keys', label: '키 설정' },
];

const CHANNEL_LABEL: Readonly<Record<AudioChannel, string>> = { master: '전체', sfx: '효과음' };
const CHANNEL_DESC: Readonly<Record<AudioChannel, string>> = {
  master: '모든 소리의 기준 볼륨입니다.',
  sfx: '총성 · 타격 · UI 등 효과음 볼륨입니다.',
};
/** Channels the 오디오 section exposes. A BGM row would simply be appended here once music exists. */
const CHANNELS: readonly AudioChannel[] = ['master', 'sfx'];

/**
 * 설정 panel (`.menu.settings-menu.side`), opened from the pause menu's `설정` button — in a mission and in the ship
 * alike. **2026-09-08**: a two-column screen — a **nav rail on the left** (화면 설정 / 오디오 설정 / 키 설정, 화면
 * first and selected by default) and a **fixed-size right pane** that scrolls vertically. The pane's box never
 * resizes between sections, so switching does not make the panel jump.
 *
 *   - **화면 설정**: 전체화면 (see `displaySettings` — the only way Escape stops breaking the pointer lock), 화면
 *     효과(블룸), 그림자, 해상도 배율. Everything but 전체화면 is applied by `main.ts` off `ui:displayChanged`,
 *     because the `Engine` lives there and ui/ must not import core/.
 *   - **오디오 설정**: 전체 / 효과음 sliders driving `ctx.audio.setVolume(channel, v)` live, with
 *     `ctx.audio.preview(channel)` on release. `ctx.audio` may be null (audio system not registered) — the rows then
 *     render disabled with a note.
 *   - **키 설정**: a real `menus/ControlsPanel` (the title screen's keyboard + mouse diagram and function list) with
 *     the `KEYBIND_BUTTON_LABEL` button under it, which opens the shared `KeybindMenu` overlay on top of this one.
 *     There is exactly one rebinding code path in the game (that class); this panel never duplicates its rows.
 *
 * Like `KeybindMenu` it takes **no** `ctx.uiBlockers` token: it only ever opens on top of a menu that already holds
 * `'menu'` (the pause menu), so closing it must not release the host's blocker. Escape is captured and closes the
 * settings — this is a sub-screen *inside* the pause menu, not one of the game screens the 2026-09-08 rule covers,
 * so Escape here steps back to the menu it was opened from rather than opening a second pause. Emits
 * `ui:settingsToggled`.
 */
export class SettingsMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private controls: ControlsPanel;
  private sliders: Slider[] = [];
  private navBtns = new Map<SectionId, HTMLButtonElement>();
  private panes = new Map<SectionId, HTMLElement>();
  private section: SectionId = 'display';
  private display: DisplaySettings;
  private fsRow!: HTMLButtonElement;
  private bloomRow!: HTMLButtonElement;
  private shadowRow!: HTMLButtonElement;
  private scaleBtns: { scale: number; btn: HTMLButtonElement }[] = [];
  private audioNote!: HTMLElement;
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

  /** F11 / the browser's own exit changes fullscreen behind our back — keep the row honest. */
  private onFullscreenChange = (): void => {
    this.display.fullscreen = isFullscreen();
    this.syncDisplayRows();
  };

  constructor(parent: HTMLElement, private readonly keybinds: KeybindMenu) {
    this.display = loadDisplaySettings();
    this.root = el('div', { cls: 'menu settings-menu side interactive', parent });
    this.root.hidden = true;
    el('div', { cls: 'scan', parent: this.root });
    const f = this.frame = el('div', { cls: 'frame', parent: this.root });

    el('div', { cls: 'title', text: '설정', parent: f });

    const cols = el('div', { cls: 'set-cols', parent: f });
    const nav = el('nav', { cls: 'set-nav', parent: cols });
    const pane = el('div', { cls: 'set-pane', parent: cols });
    for (const s of SECTIONS) {
      const b = el('button', { cls: 'set-nav-btn', text: s.label, parent: nav });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.select(s.id);
      });
      this.navBtns.set(s.id, b);
      const body = el('div', { cls: `set-body ${s.id}`, parent: pane });
      body.hidden = true;
      this.panes.set(s.id, body);
    }

    this.buildDisplay(this.panes.get('display')!);
    this.buildAudio(this.panes.get('audio')!);
    this.controls = this.buildKeys(this.panes.get('keys')!);

    const foot = el('div', { cls: 'set-foot', parent: f });
    const close = el('button', { cls: 'ui-btn primary', text: '닫기', parent: foot });
    close.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });

    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.select('display');
  }

  /* ── sections ──────────────────────────────────────────────────────────── */

  /** A label + description on the left and an on/off pill on the right. Returns the pill. */
  private toggleRow(parent: HTMLElement, label: string, desc: string, onClick: () => void): HTMLButtonElement {
    const row = el('div', { cls: 'set-row', parent });
    const left = el('div', { cls: 'set-row-left', parent: row });
    el('div', { cls: 'set-row-label', text: label, parent: left });
    el('div', { cls: 'set-row-desc', text: desc, parent: left });
    const right = el('div', { cls: 'set-row-right', parent: row });
    const pill = el('button', { cls: 'set-toggle', text: '끔', parent: right });
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      onClick();
    });
    return pill;
  }

  private buildDisplay(host: HTMLElement): void {
    this.fsRow = this.toggleRow(host, '전체화면',
      'Esc 가 포인터 락을 깨지 않아 메뉴를 닫으면 시점이 곧바로 돌아옵니다.',
      () => { void this.toggleFullscreen(); });
    this.bloomRow = this.toggleRow(host, '화면 효과',
      '발광 · 블룸 후처리입니다. 끄면 프레임이 올라갑니다.',
      () => { this.display.bloom = !this.display.bloom; this.applyDisplay(); });
    this.shadowRow = this.toggleRow(host, '그림자',
      '햇빛 그림자입니다. 끄면 프레임이 올라갑니다.',
      () => { this.display.shadows = !this.display.shadows; this.applyDisplay(); });

    const row = el('div', { cls: 'set-row', parent: host });
    const left = el('div', { cls: 'set-row-left', parent: row });
    el('div', { cls: 'set-row-label', text: '해상도 배율', parent: left });
    el('div', { cls: 'set-row-desc', text: '낮추면 화면이 흐려지는 대신 가벼워집니다.', parent: left });
    const right = el('div', { cls: 'set-row-right', parent: row });
    for (const scale of DISPLAY_SCALES) {
      const b = el('button', { cls: 'set-seg', text: `${Math.round(scale * 100)}%`, parent: right });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.ctx.bus.emit('audio:play', { id: 'ui_click' });
        this.display.scale = scale;
        this.applyDisplay();
      });
      this.scaleBtns.push({ scale, btn: b });
    }
  }

  private buildAudio(host: HTMLElement): void {
    for (const channel of CHANNELS) {
      const row = el('div', { cls: `set-row vol ${channel}`, parent: host });
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
    this.audioNote = el('div', { cls: 'set-hint', text: '배경 음악은 아직 없습니다.', parent: host });
  }

  private buildKeys(host: HTMLElement): ControlsPanel {
    const controls = new ControlsPanel(host);
    const keyRow = el('div', { cls: 'set-row', parent: host });
    el('div', { cls: 'set-row-label', text: '키 배치를 변경하고 충돌을 확인합니다.', parent: keyRow });
    const keyBtn = el('button', { cls: 'ui-btn set-key-btn', text: KEYBIND_BUTTON_LABEL, parent: keyRow });
    keyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.keybinds.open();
    });
    return controls;
  }

  /* ── state ─────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    // Publish the stored settings once so the Engine matches the panel before it is ever opened.
    this.emitDisplay();
  }

  get isOpen(): boolean { return this._open; }
  /** Which section the right pane is showing (debug). */
  get activeSection(): string { return this.section; }
  /** The live 화면 설정 (debug). */
  get displaySettings(): Readonly<DisplaySettings> { return this.display; }

  select(id: SectionId): void {
    this.section = id;
    for (const [key, btn] of this.navBtns) toggleClass(btn, 'is-on', key === id);
    for (const [key, body] of this.panes) body.hidden = key !== id;
  }

  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    window.addEventListener('keydown', this.onKey, true);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.select('display');
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
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.ctx.bus.emit('ui:settingsToggled', { open: false });
  }

  /** Re-read the live volumes + key diagram + display state (called on open; cheap enough to call again). */
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
    setText(this.audioNote, audio
      ? '배경 음악은 아직 없습니다.'
      : '오디오 시스템을 사용할 수 없어 볼륨을 조절할 수 없습니다.');
    this.display.fullscreen = isFullscreen();
    this.syncDisplayRows();
  }

  private async toggleFullscreen(): Promise<void> {
    this.display.fullscreen = await setFullscreen(!this.display.fullscreen);
    this.syncDisplayRows();
    this.emitDisplay();
  }

  private applyDisplay(): void {
    saveDisplaySettings(this.display);
    this.syncDisplayRows();
    this.emitDisplay();
  }

  private emitDisplay(): void {
    const d = this.display;
    this.ctx.bus.emit('ui:displayChanged', { fullscreen: d.fullscreen, bloom: d.bloom, shadows: d.shadows, scale: d.scale });
  }

  private syncDisplayRows(): void {
    const pill = (b: HTMLButtonElement, on: boolean): void => { toggleClass(b, 'is-on', on); setText(b, on ? '켬' : '끔'); };
    pill(this.fsRow, this.display.fullscreen);
    pill(this.bloomRow, this.display.bloom);
    pill(this.shadowRow, this.display.shadows);
    for (const s of this.scaleBtns) toggleClass(s.btn, 'is-on', Math.abs(s.scale - this.display.scale) < 1e-3);
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
