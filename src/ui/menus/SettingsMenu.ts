import type { AudioChannel, GameContext, RelayProbe } from '@/shared';
import { NET_DEFAULT_PORT, NET_WS_PATH, relayUrlFrom } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import { AskPopup } from './askPopup';
import type { KeybindMenu } from './KeybindMenu';
import { ControlsPanel, KEYBIND_BUTTON_LABEL } from './ControlsPanel';
import type { DisplaySettings } from './displaySettings';
import { DISPLAY_SCALES, isFullscreen, loadDisplaySettings, saveDisplaySettings, setFullscreen } from './displaySettings';

interface Slider {
  channel: AudioChannel;
  input: HTMLInputElement;
  value: HTMLElement;
}

/** The four sections, in nav order. 화면 is the default so the 전체화면 toggle is the first thing on screen. */
type SectionId = 'display' | 'audio' | 'keys' | 'network';
const SECTIONS: readonly { id: SectionId; label: string }[] = [
  { id: 'display', label: '화면 설정' },
  { id: 'audio', label: '오디오 설정' },
  { id: 'keys', label: '키 설정' },
  { id: 'network', label: '서버 설정' },
];

/**
 * 데스크톱 셸이 고른 기본 주소를 알려 주는 로컬 라우트 (`electron/main.ts`). 브라우저 · vite 에는 없으므로
 * 404 / 실패는 "같은 주소의 서버" 로 읽는다 — 그게 사실이다 (vite 프록시가 `/ws` 를 릴레이로 넘긴다).
 */
const SHELL_RELAY_ROUTE = '/__scav/relay';

const CHANNEL_LABEL: Readonly<Record<AudioChannel, string>> = { master: '전체', sfx: '효과음' };
const CHANNEL_DESC: Readonly<Record<AudioChannel, string>> = {
  master: '모든 소리의 기준 볼륨입니다.',
  sfx: '총성 · 타격 · UI 등 효과음 볼륨입니다.',
};
/** Channels the 오디오 section exposes. A BGM row would simply be appended here once music exists. */
const CHANNELS: readonly AudioChannel[] = ['master', 'sfx'];

/** C-58: the 화면 효과 pill while the perf guard holds bloom off (the stored choice is still 켬). */
const BLOOM_AUTO_OFF_LABEL = '꺼짐 (성능 자동)';
const BLOOM_AUTO_OFF_TIP = '프레임이 낮아 자동으로 껐습니다. 누르면 다시 켭니다.';
const BLOOM_AUTO_OFF_TOAST = '프레임이 낮아 화면 효과(블룸)를 자동으로 껐습니다 — 설정 › 화면 설정에서 다시 켤 수 있습니다';

/**
 * 설정 panel (`.menu.settings-menu.side`), opened from the pause menu's `설정` button — in a mission and in the ship
 * alike. **2026-09-08**: a two-column screen — a **nav rail on the left** (화면 설정 / 오디오 설정 / 키 설정 /
 * 서버 설정, 화면 first and selected by default) and a **fixed-size right pane** that scrolls vertically. The pane's
 * box never resizes between sections, so switching does not make the panel jump.
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
 *   - **서버 설정** (2026-09-10): 접속할 릴레이 주소. 배포본에서 이 게임의 유일한 서버 선택 창구다 — 나머지
 *     경로(`--relay` · `SCAV_RELAY` · `server.txt` · 임베디드)는 데스크톱 셸이 고르고 렌더러에는 같은 오리진
 *     `/ws` 로만 보인다. 자세한 우선순위는 `shared/net` 의 `RELAY_STORAGE_KEY` 주석.
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
  /* ── 서버 설정 (2026-09-10) ── */
  private netInput!: HTMLInputElement;
  private netStatus!: HTMLElement;
  private netDefault!: HTMLElement;
  private netTestBtn!: HTMLButtonElement;
  private netApplyBtn!: HTMLButtonElement;
  private netResetBtn!: HTMLButtonElement;
  private ask!: AskPopup;
  /** 연결 테스트가 도는 동안 버튼을 잠근다. */
  private netBusy = false;
  private netProbe: RelayProbe | null = null;
  /** 셸이 고른 기본 주소 (`SHELL_RELAY_ROUTE`); 브라우저에서는 null 로 남는다. */
  private shellDefault: string | null = null;
  private _open = false;
  private ctx!: GameContext;
  /**
   * C-58 (2026-09-11): the Engine's perf guard turned bloom off by itself this boot (`render:autoAdjusted`). Not saved —
   * `display.bloom` keeps the stored choice (켬) for the next boot; the row shows `BLOOM_AUTO_OFF_LABEL` meanwhile and
   * every publish carries the *effective* bloom (`false`), so an unrelated change here never turns it back on.
   */
  private bloomAutoOff = false;
  /** C-58: the explanatory toast went out (debug / smoke) · the interval waiting for the HUD layer (0 = none). */
  private autoOffToasted = false;
  private toastPoll = 0;
  private unsubs: Array<() => void> = [];

  /** Escape closes the settings — unless the key-settings overlay above us is open (it owns Escape then). */
  private onKey = (e: KeyboardEvent): void => {
    if (!this._open || this.keybinds.isOpen || this.ask?.isOpen) return;
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
    this.buildNetwork(this.panes.get('network')!);

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
      () => {
        // C-58: while auto-off the pill reads 꺼짐, so a press means 켜기 — the stored value is already true
        if (this.bloomAutoOff) { this.bloomAutoOff = false; this.display.bloom = true; }
        else this.display.bloom = !this.display.bloom;
        this.applyDisplay();
      });
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

  /**
   * **서버 설정** (2026-09-10). 주소 한 칸 · 연결 테스트 · 적용 · 기본값으로.
   *
   * 여기 적은 주소는 `NetRef.setRelayOverride` 를 통해 슬롯 공용 localStorage 에 남고 `defaultUrl()` 이 그것을
   * 제일 먼저 본다 (우선순위는 `shared/net` 의 `RELAY_STORAGE_KEY` 주석). **적용은 재접속을 부른다** — 분대에
   * 들어가 있었다면 그 분대를 떠나므로 `AskPopup {danger}` 의 1초 홀드를 지난다 (파티 떠나기와 같은 규약).
   * 레이드 중에는 아예 잠근다: 돌아올 수 없는 세션을 설정 화면에서 끊을 이유가 없다.
   */
  private buildNetwork(host: HTMLElement): void {
    const row = el('div', { cls: 'set-row net', parent: host });
    const left = el('div', { cls: 'set-row-left', parent: row });
    el('div', { cls: 'set-row-label', text: '서버 주소', parent: left });
    el('div', { cls: 'set-row-desc', parent: left,
      text: `친구가 켠 서버의 주소입니다. 주소만 적으면 :${NET_DEFAULT_PORT}${NET_WS_PATH} 를 붙입니다. 비우면 기본값을 씁니다.` });
    const right = el('div', { cls: 'set-row-right', parent: row });
    const input = this.netInput = el('input', { cls: 'set-text ui-mono', parent: right });
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = '192.168.0.12';
    input.maxLength = 120;
    // 채팅 입력과 같은 규약: 주소를 타이핑하는 동안 게임이 그 키를 읽지 않는다 (`shared/Input` 은 버블에서 듣는다).
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); void this.testRelay(); }
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('input', () => this.syncNetRows());

    this.netStatus = el('div', { cls: 'set-net-status', text: '', parent: host });
    this.netDefault = el('div', { cls: 'set-hint', text: '', parent: host });

    const foot = el('div', { cls: 'set-net-foot', parent: host });
    this.netTestBtn = el('button', { cls: 'ui-btn', text: '연결 테스트', parent: foot });
    this.netTestBtn.addEventListener('click', (e) => { e.stopPropagation(); void this.testRelay(); });
    this.netApplyBtn = el('button', { cls: 'ui-btn primary', text: '적용하고 다시 접속', parent: foot });
    this.netApplyBtn.addEventListener('click', (e) => { e.stopPropagation(); this.applyRelay(); });
    this.netResetBtn = el('button', { cls: 'ui-btn', text: '기본값으로', parent: foot });
    this.netResetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.netInput.value = '';
      this.syncNetRows();
    });

    el('div', { cls: 'set-hint', parent: host,
      text: '서버는 배포 폴더의 SCAVANGER-Server.exe 를 켜면 됩니다 — 그 창에 적히는 주소를 그대로 적으세요.' });
    this.ask = new AskPopup(this.root);
    // 2026-09-10: `.tm-ask` 가 이제 문서에 **둘**이다 — 타이틀의 것(`ctx.uiRoot` 직속)과 이것(설정 안).
    // 셋 중 어느 것을 집었는지 헷갈리지 않게 표식을 준다. 전역 `.tm-ask` 셀렉터로 타이틀 팝업을 찾는
    // 코드는 `:not(.set-ask)` 로 걸러야 한다 — 이 팝업이 문서 순서상 먼저 온다.
    this.ask.root.classList.add('set-ask');
  }

  /** 입력칸의 주소를 두드려 본다. 살아 있는 접속은 건드리지 않는다 (`probeRelay` 는 익명 소켓이다). */
  private async testRelay(): Promise<void> {
    const net = this.ctx.net;
    if (!net || this.netBusy) return;
    this.netBusy = true;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.setNetStatus('확인 중…', null);
    this.syncNetRows();
    let r: RelayProbe;
    try { r = await net.probeRelay(this.netInput.value.trim()); } finally { this.netBusy = false; }
    this.netProbe = r;
    this.setNetStatus(r.ok
      ? `응답 ${r.ms}ms · ${r.url}`
      : `${r.error ?? '연결할 수 없습니다'}${r.url ? ` · ${r.url}` : ''}`, r.ok);
    this.ctx.bus.emit('audio:play', { id: r.ok ? 'ui_confirm' : 'ui_deny' });
    this.syncNetRows();
  }

  /**
   * 주소를 저장하고 다시 붙는다. 분대에 있으면 1초 홀드 팝업을 지난다.
   *
   * **저장은 홀드 확정 뒤에 한다.** 형식 검사만 먼저(`relayUrlFrom` — `setRelayOverride` 가 쓰는 그 함수)
   * 하고 저장은 `go()` 안에서 한다 — 먼저 저장해 버리면 팝업을 **취소해도** 주소가 남아, 다음 자동 재접속이
   * 조용히 새 서버로 간다.
   */
  private applyRelay(): void {
    const net = this.ctx.net;
    if (!net) return;
    const typed = this.netInput.value.trim();
    if (typed && !relayUrlFrom(typed)) {
      this.setNetStatus('주소 형식이 아닙니다', false);
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      return;
    }
    const go = (): void => {
      net.setRelayOverride(typed);
      this.setNetStatus('다시 접속하는 중…', null);
      void net.reconnectRelay().then((ok) => {
        this.setNetStatus(`${ok ? '접속됨' : '접속 실패'} · ${net.relayUrl}`, ok);
        this.syncNetRows();
      });
    };
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (net.lobby) {
      // 경고는 **보수적으로** 맞다: 새 주소가 우연히 같은 릴레이를 가리키면(vite 프록시 ↔ 직접 주소)
      // 서버의 재접속 유예가 로비를 되살려 주므로 실제로는 떠나지 않는다. 진짜 다른 서버면 그 로비가
      // 없으니 떠난다 — 중요한 쪽에서 틀리지 않으므로 문구는 이대로 둔다.
      this.ask.bind(this.ctx);
      this.ask.open({
        title: '서버를 옮깁니다',
        body: '지금 있는 분대를 떠나고 새 서버에 접속합니다.\n분대원에게는 나간 것으로 보입니다.',
        ok: '분대를 떠나고 접속',
        danger: true,
        run: go,
      });
      return;
    }
    go();
  }

  /** 상태 한 줄. `ok` 가 null 이면 중립(진행 중)이다. */
  private setNetStatus(text: string, ok: boolean | null): void {
    setText(this.netStatus, text);
    toggleClass(this.netStatus, 'ok', ok === true);
    toggleClass(this.netStatus, 'bad', ok === false);
  }

  /** 버튼 잠금 · 기본값 줄을 지금 상태에 맞춘다 (입력할 때마다 · 열 때마다). */
  private syncNetRows(): void {
    const net = this.ctx?.net;
    const typed = this.netInput.value.trim();
    const inRaid = !!net?.inSession;
    this.netInput.disabled = !net || inRaid;
    this.netTestBtn.disabled = !net || this.netBusy || !typed;
    this.netApplyBtn.disabled = !net || this.netBusy || inRaid || typed === (net?.relayOverride ?? '');
    this.netResetBtn.disabled = !net || inRaid || !typed;
    setText(this.netDefault, !net
      ? '이 화면에서는 서버 설정을 바꿀 수 없습니다.'
      : inRaid
        ? '레이드 중에는 서버를 옮길 수 없습니다. 함선으로 돌아온 뒤에 바꾸세요.'
        : `기본값: ${this.shellDefault ?? '같은 주소의 서버'}`);
  }

  /* ── state ─────────────────────────────────────────────────────────────── */

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    // C-58: subscribed here (boot), not on open — the guard fires in the first 90 s, usually with the panel closed.
    this.unsubs.push(ctx.bus.on('render:autoAdjusted', ({ bloom, reason }) => {
      if (bloom !== false || reason !== 'perf') return;
      // the guard only runs while bloom is drawn, i.e. the stored choice is 켬; anything else has nothing to show
      if (!this.display.bloom) return;
      this.bloomAutoOff = true;
      this.syncDisplayRows();
      this.queueAutoOffToast();
    }));
    // Someone else turned bloom back on (a console / smoke publish): the Engine is drawing it again, so drop the label.
    // Our own publishes carry `false` while auto-off, and a 켜기 press clears the flag before it publishes.
    this.unsubs.push(ctx.bus.on('ui:displayChanged', ({ bloom }) => {
      if (bloom && this.bloomAutoOff) { this.bloomAutoOff = false; this.syncDisplayRows(); }
    }));
    // Publish the stored settings once so the Engine matches the panel before it is ever opened.
    this.emitDisplay();
  }

  /**
   * C-58: one toast explaining the auto-off. Toasts live in the social HUD layer, which is hidden under a `'menu'`
   * blocker (타이틀 · 일시정지) and outside the ship / raid — and they expire on wall-clock time — so a guard that fires on
   * the title screen would toast into nothing. Wait (cheap 0.5 s poll) until that layer is up; drop it if the player
   * has already turned bloom back on by then.
   */
  private queueAutoOffToast(): void {
    if (this.toastPoll) return;
    const tryShow = (): boolean => {
      if (!this.bloomAutoOff) return true;
      const c = this.ctx;
      const layerUp = !c.uiBlockers.has('menu')
        && (c.isGameplayPhase() || c.phase === 'deploying' || c.phase === 'hub' || c.phase === 'docking');
      if (!layerUp) return false;
      c.bus.emit('ui:notify', { text: BLOOM_AUTO_OFF_TOAST, kind: 'warning', duration: 6 });
      this.autoOffToasted = true;
      return true;
    };
    if (tryShow()) return;
    this.toastPoll = window.setInterval(() => { if (tryShow()) this.stopToastPoll(); }, 500);
  }

  private stopToastPoll(): void {
    if (this.toastPoll) window.clearInterval(this.toastPoll);
    this.toastPoll = 0;
  }

  get isOpen(): boolean { return this._open; }
  /** Which section the right pane is showing (debug). */
  get activeSection(): string { return this.section; }
  /** The live 화면 설정 (debug). `bloom` is the stored choice — see `bloomAutoOff` for what is drawn. */
  get displaySettings(): Readonly<DisplaySettings> { return this.display; }
  /** C-58 (debug / smoke): the perf guard is holding bloom off and the row says so. */
  get isBloomAutoOff(): boolean { return this.bloomAutoOff; }
  /** C-58 (debug / smoke): the auto-off toast has been shown · is still waiting for the HUD layer. */
  get bloomAutoOffToast(): 'shown' | 'waiting' | 'none' { return this.autoOffToasted ? 'shown' : this.toastPoll ? 'waiting' : 'none'; }
  /** 서버 설정 상태 (debug / 스모크): 입력값 · 마지막 테스트 결과 · 버튼 잠금 · 기본값 줄. */
  get networkState(): { typed: string; probe: RelayProbe | null; canApply: boolean; canTest: boolean; note: string } {
    return {
      typed: this.netInput.value.trim(), probe: this.netProbe,
      canApply: !this.netApplyBtn.disabled, canTest: !this.netTestBtn.disabled,
      note: this.netDefault.textContent ?? '',
    };
  }

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
    const net = this.ctx.net;
    this.netInput.value = net?.relayOverride ?? '';
    this.netProbe = null;
    this.setNetStatus(net?.connected ? `접속됨 · ${net.relayUrl}` : '접속되어 있지 않습니다', net?.connected ? true : null);
    this.syncNetRows();
    void this.loadShellDefault();
  }

  /** 셸이 고른 기본 주소를 한 번만 물어본다 (브라우저 · vite 에는 라우트가 없으므로 그냥 실패한다). */
  private async loadShellDefault(): Promise<void> {
    if (this.shellDefault !== null) return;
    try {
      const res = await fetch(SHELL_RELAY_ROUTE, { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json() as { target?: unknown; source?: unknown };
      if (typeof j.target !== 'string' || !j.target) return;
      this.shellDefault = typeof j.source === 'string' && j.source ? `${j.target}  (${j.source})` : j.target;
      this.syncNetRows();
    } catch { /* 라우트가 없다 = 같은 오리진의 릴레이다. "같은 주소의 서버" 가 맞는 답이다 */ }
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

  /**
   * Publish what the Engine should draw. C-58: `bloom` is the **effective** value — false while the perf guard holds it
   * off — so a 전체화면 · 그림자 · 해상도 change is the same bloom request again (a no-op in `Engine.setPostProcessing`)
   * and cannot undo the guard. `saveDisplaySettings` still writes `display.bloom`, the stored choice.
   */
  private emitDisplay(): void {
    const d = this.display;
    const bloom = d.bloom && !this.bloomAutoOff;
    this.ctx.bus.emit('ui:displayChanged', { fullscreen: d.fullscreen, bloom, shadows: d.shadows, scale: d.scale });
  }

  private syncDisplayRows(): void {
    const pill = (b: HTMLButtonElement, on: boolean): void => { toggleClass(b, 'is-on', on); setText(b, on ? '켬' : '끔'); };
    pill(this.fsRow, this.display.fullscreen);
    const auto = this.bloomAutoOff && this.display.bloom;
    pill(this.bloomRow, this.display.bloom && !auto);
    if (auto) setText(this.bloomRow, BLOOM_AUTO_OFF_LABEL);
    toggleClass(this.bloomRow, 'is-auto', auto);
    this.bloomRow.title = auto ? BLOOM_AUTO_OFF_TIP : '';
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
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.stopToastPoll();
    this.ask.dispose();
    // Same order as `TitleMenu`: the diagram unsubscribes from `onKeybindsChanged` before its host goes away.
    this.controls.dispose();
    this.root.remove();
  }
}
