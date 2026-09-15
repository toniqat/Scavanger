import '../styles/music.css';
import type { GameContext, MusicMode, MusicPlayerState } from '@/shared';
import { AUDIO_DEFAULT_BGM, MUSIC_MODE_LABEL_KO, MUSIC_PLAYER_OFF } from '@/shared';
import { el, setText, toggleClass } from '../dom';

/**
 * 음악 재생 창 (2026-09-14 사용자 결정) — 축음기 · 주크박스 · 턴테이블을 켜면 **화면에 늘 떠 있는 작은 창**으로
 * 지금 곡의 제목 · 아티스트 · 볼륨 · 진행을 보여 준다. **소리는 나지 않는다** (`housing/parts/Music` 이 상태의 주인이고
 * 여기서는 그 사실을 그린다 — 상태는 `housing:musicChanged` 로 받고, 버튼만 옵셔널 조작 계약 `musicPrev` · `musicNext` · `setMusicMode` · `musicStop` 을 부른다).
 *
 *  - **함선에서만** 보인다 (`ctx.phase === 'hub'`). 레이드 · 훈련장 · 타이틀에서는 housing 이 이미 상태를 끄지만
 *    페이즈 게이트를 한 번 더 둬서 「상태가 남았는데 창이 뜬다」가 원천적으로 없다.
 *  - **`housing:musicChanged` 를 한 번도 못 받으면 `MUSIC_PLAYER_OFF` 이고 창은 안 뜬다** (기본값 = 꺼짐).
 *  - 메뉴 blocker(`'menu'`)가 서면 숨는다 — `hud/KeyGuide.apply()` 와 **같은 규칙**이다(인벤토리 · 지도 같은 다른
 *    화면 위에는 그대로 떠 있다). 그래서 z 는 그 창들(≤ 80)보다 위, `.screen-fade`(82) · `.key-guide`(84)보다 아래인 **81**.
 *  - 재생 목록이 비어 있으면(레코드를 한 장도 안 꽂았다) 창은 **뜨고** `꽂힌 레코드가 없습니다` 한 줄만 그린다
 *    (`.is-empty` — 「켰는데 아무 반응이 없다」를 만들지 않기 위한 선택이고, 이 규칙 하나로 일관한다).
 *  - **조작 넷**(`◀` 이전 · `▶` 다음 · 재생 목록 ↔ 한 곡 반복 · `■` 정지)은 `HousingRef` 의 2026-09-14 추가 계약
 *    (`musicPrev` · `musicNext` · `setMusicMode` · `musicStop`)으로 간다. 전부 **옵셔널**이라 `?.()` 로 부르고,
 *    메서드가 없는 빌드에서는 그 버튼을 숨긴다. 창 전체는 `pointer-events: none` 이고 **버튼에만 `auto`** 다
 *    (`.nb-actions` 와 같은 규칙) — 지도 · 인벤토리 위에 떠 있어도 그 아래의 입력을 가리지 않는다.
 *
 * DOM: `#ui-root` 직계 `.mus-player(.show)(.is-empty)` > `.mus-body`
 *      (`.mus-head`(`.mus-icon` + `.mus-mode` + `.mus-vol`) + `.mus-title` + `.mus-artist` + `.mus-bar > .mus-fill` +
 *       `.mus-time` + `.mus-actions`(`.mus-btn` 넷)).
 * 클래스는 전부 `mus-` 접두사다 (폴더마다 접두사가 달라야 한다 — `.ct-cell` 충돌 사례).
 */
export class MusicPlayer {
  readonly root: HTMLElement;
  private modeEl: HTMLElement;
  private volEl: HTMLElement;
  private titleEl: HTMLElement;
  private artistEl: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private timeEl: HTMLElement;
  private actions: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private modeBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;

  private ctx: GameContext | null = null;
  private unsubs: Array<() => void> = [];

  private state: MusicPlayerState = MUSIC_PLAYER_OFF;
  private volume = AUDIO_DEFAULT_BGM;
  private shown = false;
  /** Last rendered text key — the per-frame update only touches the DOM when something actually changed. */
  private lastText = '';
  private lastFill = -1;

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'mus-player', parent });
    const body = el('div', { cls: 'mus-body', parent: this.root });
    const head = el('div', { cls: 'mus-head', parent: body });
    el('span', { cls: 'mus-icon', text: '♪', parent: head });
    this.modeEl = el('span', { cls: 'mus-mode', parent: head });
    this.volEl = el('span', { cls: 'mus-vol', parent: head });
    this.titleEl = el('div', { cls: 'mus-title', parent: body });
    this.artistEl = el('div', { cls: 'mus-artist', parent: body });
    this.barEl = el('div', { cls: 'mus-bar', parent: body });
    this.fillEl = el('div', { cls: 'mus-fill', parent: this.barEl });
    this.timeEl = el('div', { cls: 'mus-time', parent: body });
    this.actions = el('div', { cls: 'mus-actions', parent: body });
    this.prevBtn = this.button('◀', '이전 곡', () => this.housing()?.musicPrev?.() ?? false);
    this.nextBtn = this.button('▶', '다음 곡', () => this.housing()?.musicNext?.() ?? false);
    this.modeBtn = this.button(MUSIC_MODE_LABEL_KO.playlist, '재생 방식 전환', () => {
      const next: MusicMode = this.state.mode === 'repeat' ? 'playlist' : 'repeat';
      return this.housing()?.setMusicMode?.(next) ?? false;
    });
    this.modeBtn.classList.add('mus-btn-mode');
    this.stopBtn = this.button('■', '정지', () => this.housing()?.musicStop?.() ?? false);
  }

  /** `ctx.housing` — 조작 계약 넷이 전부 옵셔널이므로 호출부는 늘 `?.()` 다. */
  private housing(): GameContext['housing'] { return this.ctx?.housing ?? null; }

  private button(label: string, title: string, run: () => boolean): HTMLButtonElement {
    const btn = el('button', { cls: 'mus-btn', text: label, attrs: { title, type: 'button' }, parent: this.actions });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!run()) return;
      this.ctx?.bus.emit('audio:play', { id: 'ui_click' });
    });
    // 창은 HUD 위에 떠 있을 뿐이다 — 버튼을 누른 뒤 포커스 링이 남아 키 입력을 먹지 않게 한다.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    return btn;
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:musicChanged', ({ state }) => { this.state = state; this.lastText = ''; }),
      // 볼륨은 **설정의 `오디오 › 음악`** 값을 그대로 비춘다 (이 창은 소리를 내지도, 볼륨을 바꾸지도 않는다).
      b.on('audio:volumeChanged', ({ channel, value }) => {
        if (channel !== 'bgm') return;
        this.volume = value;
        this.lastText = '';
      }),
      // 미션 리셋 — housing 이 같은 사건으로 상태를 끄지만, 이벤트 순서에 기대지 않고 여기서도 비운다.
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
    );
    if (ctx.audio) this.volume = ctx.audio.settings.bgm ?? AUDIO_DEFAULT_BGM;
    // 늦게 붙어도 첫 `housing:musicChanged` 를 기다리지 않는다 (`HousingRef.getMusicState?`, 2026-09-14 계약).
    this.state = ctx.housing?.getMusicState?.() ?? MUSIC_PLAYER_OFF;
    // 조작 계약이 없는 빌드에서는 그 버튼을 아예 숨긴다 (눌러도 아무 일도 없는 버튼을 두지 않는다).
    const h = ctx.housing;
    this.prevBtn.hidden = typeof h?.musicPrev !== 'function';
    this.nextBtn.hidden = typeof h?.musicNext !== 'function';
    this.modeBtn.hidden = typeof h?.setMusicMode !== 'function';
    this.stopBtn.hidden = typeof h?.musicStop !== 'function';
  }

  private reset(): void {
    this.state = MUSIC_PLAYER_OFF;
    this.lastText = '';
  }

  /** Called every frame from `HudSystem.update` — two compares while nothing is playing. */
  update(ctx: GameContext): void {
    const playing = this.state.furnitureUid !== null;
    const menu = ctx.uiBlockers.has('menu');
    const on = playing && ctx.phase === 'hub' && !menu;
    if (on !== this.shown) { this.shown = on; toggleClass(this.root, 'show', on); }
    if (!on) return;

    const track = this.state.track;
    const empty = track === null;
    toggleClass(this.root, 'is-empty', empty);

    const key = `${track?.defId ?? ''}|${this.state.mode}|${this.volume.toFixed(2)}|${this.state.index}|${this.state.playlist.length}`;
    if (key !== this.lastText) {
      this.lastText = key;
      setText(this.modeEl, MUSIC_MODE_LABEL_KO[this.state.mode]);
      setText(this.volEl, `음량 ${Math.round(this.volume * 100)}%`);
      setText(this.titleEl, track ? track.title : '꽂힌 레코드가 없습니다');
      setText(this.artistEl, track ? track.artist : '');
      this.artistEl.hidden = empty;
      this.barEl.hidden = empty;
      this.timeEl.hidden = empty;
      // 버튼: 곡 넘김은 목록이 있어야 하고, 방식 전환 버튼은 **누르면 될 값**을 적는다 (지금 값은 머리줄에 있다).
      const nextMode: MusicMode = this.state.mode === 'repeat' ? 'playlist' : 'repeat';
      setText(this.modeBtn, MUSIC_MODE_LABEL_KO[nextMode]);
      this.modeBtn.title = `${MUSIC_MODE_LABEL_KO[nextMode]}(으)로 전환`;
      this.prevBtn.disabled = empty;
      this.nextBtn.disabled = empty;
    }
    if (empty) return;

    const lengthMs = Math.max(1, track.lengthS * 1000);
    const elapsed = Math.max(0, Math.min(lengthMs, nowMs(ctx) - this.state.startedAt));
    const frac = elapsed / lengthMs;
    if (Math.abs(frac - this.lastFill) > 0.002) {
      this.lastFill = frac;
      this.fillEl.style.width = `${(frac * 100).toFixed(2)}%`;
      setText(this.timeEl, `${clock(elapsed / 1000)} / ${clock(track.lengthS)}`);
    }
  }

  /* ── debug / smoke ── */
  get isShowing(): boolean { return this.shown; }
  get titleText(): string { return this.titleEl.textContent ?? ''; }
  get artistText(): string { return this.artistEl.textContent ?? ''; }
  get volumeText(): string { return this.volEl.textContent ?? ''; }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.state = MUSIC_PLAYER_OFF;
    this.root.remove();
  }
}

/**
 * 진행 막대의 「지금」. `startedAt` 은 housing 이 `ctx.net.serverNow() ?? Date.now()` 로 찍은 epoch ms 이므로
 * 여기서도 **같은 규약**으로 읽는다 (재배 · 배양 · 해석 화면과 같다).
 */
function nowMs(ctx: GameContext): number {
  const net = ctx.net;
  if (net && typeof net.serverNow === 'function') {
    const t = net.serverNow();
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Date.now();
}

/** `m:ss`. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
