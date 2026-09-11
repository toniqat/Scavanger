import '../styles/netBadge.css';
import type { GameContext, NetLinkInfo, NetLinkState } from '@/shared';
import { el, setText, toggleClass } from '../dom';
import type { CutsceneWatch } from './CutsceneWatch';

/** How long the `연결됨` confirmation stays after a connection lands (ms). */
const CONNECTED_SHOW_MS = 3000;
/** From this many scheduled probes on (≈ 15 s of looking) the badge also names the address it keeps failing on. */
const ADDRESS_HINT_AFTER_PROBES = 3;

type Tone = 'info' | 'ok' | 'warn' | 'bad';

/**
 * 서버 연결 배지 (2026-09-11, B-1) — `ctx.net.link` 를 **함선 · 타이틀 우측 상단**의 작은 배지로 그린다.
 *
 *  - 레이드 · 훈련 HUD 에서는 **숨긴다** (사용자 결정 — 분대원 HUD 의 `연결 끊김` 과 GameFlow 의 재접속 토스트가 이미 있다).
 *    함선에서는 도킹 · 워프 컷씬과 화면(blocker)이 떠 있는 동안 숨는다 — 터미널 머리줄이 연결 상태를 이미 보여 준다.
 *  - 문구: `서버 연결 중…` / `연결됨`(3 초 뒤 사라짐) / `서버 재연결 중… (n)` / `오프라인 · 서버 찾는 중 (12초 뒤)`
 *    (+ 몇 번 못 찾으면 `서버 주소를 확인하세요 — <주소>`) / `서버 발견 — 함선에서 연결` / `추방됨` · `서버 인원 초과` ·
 *    `다른 곳에서 접속됨`. `idle`(아직 아무도 접속을 시도하지 않았다)이면 아무것도 그리지 않는다.
 *  - **타이틀**(커서가 있다)에서는 배지 옆에 `다시 시도`(`ensureConnected`) · `서버 설정`(설정 › 서버 설정) 버튼.
 *  - **전이 토스트도 여기서만** 낸다 (함선 안에서만): 연결 → 끊김 `서버 연결이 끊겼습니다 — 다시 찾는 중`,
 *    끊김 → 연결 `서버에 다시 연결되었습니다` (한 번도 붙은 적 없던 페이지면 `서버에 연결되었습니다`). 같은 welcome 이
 *    `net:resumed` 를 냈으면 그 줄(`hub/parts/Transitions` 의 `함선에 재접속했습니다`)이 대신하므로 이 토스트는 삼킨다.
 *
 * DOM: `#ui-root` 의 직계 자식 `.net-badge(.show)(.nb-ship)(.nb-info|ok|warn|bad)` > `.nb-body`(`.nb-dot` + `.nb-main` + `.nb-sub`) +
 * `.nb-actions`(`.ui-btn` 둘). z 83 — 타이틀(`.menu`, z 없음) 위, 캐릭터 선택(84) · 일시정지(85) · 설정(86) 아래.
 * 클래스 이름은 전부 `nb-` 접두사다 (HUD 위젯 클래스와 modifier 가 겹치지 않게 — `kc-hold` 사례).
 */
export class NetBadge {
  readonly root: HTMLElement;
  private body: HTMLElement;
  private mainEl: HTMLElement;
  private subEl: HTMLElement;
  private actions: HTMLElement;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];

  private link: NetLinkInfo | null = null;
  /** `performance.now()` when `link` arrived (its `nextProbeInMs` counts from here). */
  private linkAt = 0;
  private connectedUntil = 0;
  /** Probes scheduled since the link went `unreachable` (drives the address hint). */
  private probeSchedules = 0;
  /** The link went down (or never came up) since the last connection — the next `connected` deserves a toast. */
  private wasDown = false;
  private everConnected = false;
  /** A `net:resumed` arrived in the same tick as the `connected` transition (its own toast wins). */
  private resumedThisTick = false;

  private shown = false;
  private lastRender = '';

  constructor(parent: HTMLElement, private readonly onSettings: () => void, private readonly cutscene: CutsceneWatch | null = null) {
    this.root = el('div', { cls: 'net-badge', parent });
    this.body = el('div', { cls: 'nb-body', parent: this.root });
    el('span', { cls: 'nb-dot', parent: this.body });
    const txt = el('div', { cls: 'nb-text', parent: this.body });
    this.mainEl = el('div', { cls: 'nb-main', parent: txt });
    this.subEl = el('div', { cls: 'nb-sub', parent: txt });
    this.actions = el('div', { cls: 'nb-actions', parent: this.root });
    this.button('다시 시도', () => { void this.ctx.net?.ensureConnected(); });
    this.button('서버 설정', () => this.onSettings());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('net:linkChanged', ({ link, prev }) => this.onLink(link, prev)),
      b.on('net:resumed', () => { this.resumedThisTick = true; queueMicrotask(() => { this.resumedThisTick = false; }); }),
    );
    if (ctx.net) this.onLink(ctx.net.link, ctx.net.link.state);
  }

  /* ── debug / smoke ── */
  get isShowing(): boolean { return this.shown; }
  get mainText(): string { return this.mainEl.textContent ?? ''; }
  get subText(): string { return this.subEl.textContent ?? ''; }
  get hasActions(): boolean { return this.shown && !this.actions.hidden; }

  private onLink(link: NetLinkInfo, prev: NetLinkState): void {
    const now = performance.now();
    const state = link.state;
    if (state === 'unreachable') {
      if (prev !== 'unreachable') this.probeSchedules = 0;
      if (typeof link.nextProbeInMs === 'number' && link.nextProbeInMs > 0) this.probeSchedules++;
    }
    this.link = link;
    this.linkAt = now;

    const inShip = this.ctx.phase === 'hub';
    if (state === 'connected' && prev !== 'connected') {
      this.connectedUntil = now + CONNECTED_SHOW_MS;
      if (this.wasDown && inShip) {
        const text = this.everConnected ? '서버에 다시 연결되었습니다' : '서버에 연결되었습니다';
        // `onWelcome` emits `net:resumed` synchronously after this event — decide once the handler is done.
        queueMicrotask(() => { if (!this.resumedThisTick && this.ctx.phase === 'hub') this.toast(text, 'success'); });
      }
      this.wasDown = false;
      this.everConnected = true;
    } else if (state === 'reconnecting' || state === 'unreachable' || state === 'refused') {
      // A refusal (kicked · server_full · duplicate) carries its own Korean reason (`net:error` → hub terminal / toast).
      if (prev === 'connected' && state !== 'refused' && inShip) this.toast('서버 연결이 끊겼습니다 — 다시 찾는 중', 'warning');
      this.wasDown = true;
    }
  }

  update(ctx: GameContext): void {
    const phase = ctx.phase;
    const title = phase === 'menu';
    const ship = phase === 'hub' && ctx.uiBlockers.size === 0 && !(this.cutscene?.active ?? false);
    const view = (title || ship) ? this.describe(performance.now()) : null;
    const on = view !== null;
    if (on !== this.shown) { this.shown = on; toggleClass(this.root, 'show', on); }
    if (!view) return;
    const key = `${view.tone}|${view.main}|${view.sub}|${view.actions && title}|${ship}`;
    if (key === this.lastRender) return;
    this.lastRender = key;
    for (const t of ['info', 'ok', 'warn', 'bad'] as const) toggleClass(this.root, `nb-${t}`, t === view.tone);
    toggleClass(this.root, 'nb-ship', ship);
    setText(this.mainEl, view.main);
    setText(this.subEl, view.sub);
    this.subEl.hidden = view.sub === '';
    this.actions.hidden = !(view.actions && title);
  }

  /** What the badge says right now; null = nothing to show. */
  private describe(now: number): { tone: Tone; main: string; sub: string; actions: boolean } | null {
    const l = this.link;
    if (!l) return null;
    switch (l.state) {
      case 'idle': return null;
      case 'connecting': return { tone: 'info', main: '서버 연결 중…', sub: '', actions: false };
      case 'connected': return now < this.connectedUntil ? { tone: 'ok', main: '연결됨', sub: '', actions: false } : null;
      case 'reconnecting': return { tone: 'warn', main: `서버 재연결 중… (${l.attempt ?? 1})`, sub: '', actions: false };
      case 'refused': {
        const why = l.refused === 'kicked' ? ['추방됨', '서버 관리자가 연결을 끊었습니다']
          : l.refused === 'server_full' ? ['서버 인원 초과', '서버 접속 인원이 가득 찼습니다']
            : ['다른 곳에서 접속됨', '같은 캐릭터가 다른 창에서 접속했습니다'];
        return { tone: 'bad', main: why[0], sub: why[1], actions: true };
      }
      case 'unreachable': {
        if (l.found) return { tone: 'ok', main: '서버 발견 — 함선에서 연결', sub: '', actions: false };
        if (l.embedded) return { tone: 'bad', main: '오프라인', sub: '이 PC 의 내장 서버를 시작하지 못했습니다', actions: true };
        const left = typeof l.nextProbeInMs === 'number' ? l.nextProbeInMs - (now - this.linkAt) : null;
        const main = left !== null && left > 0 ? `오프라인 · 서버 찾는 중 (${Math.ceil(left / 1000)}초 뒤)` : '오프라인 · 서버 찾는 중…';
        const sub = this.probeSchedules >= ADDRESS_HINT_AFTER_PROBES ? `서버 주소를 확인하세요 — ${l.url}` : '';
        return { tone: 'warn', main, sub, actions: true };
      }
      default: return null;
    }
  }

  private toast(text: string, kind: 'success' | 'warning'): void {
    this.ctx.bus.emit('ui:notify', { text, kind, duration: 3.5 });
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const btn = el('button', { cls: 'ui-btn nb-btn', text: label, parent: this.actions });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      onClick();
    });
    return btn;
  }

  dispose(): void { for (const u of this.unsubs) u(); this.root.remove(); }
}
