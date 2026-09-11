import type { GameContext, LobbyState, NetRef, PlanetDef, PlanetId } from '@/shared';
import {
  ENV_COLOR, ENV_DESC_KO, ENV_ICON, ENV_LABEL_KO,
  Keys, MENU_BLOCKER, NET_SLOT_COLORS_CSS, NET_MAX_PLAYERS, PLANET_DEFS, PLANET_IDS, PLANET_THREAT_LABELS,
  isValidLobbyCode, normalizeLobbyCode, planetIndex,
} from '@/shared';
import { el, isolateInput, setText, toggleClass } from './dom';
import { createPlanetHologram, type PlanetHologram } from './PlanetHologram';

/** What the menu needs from HubSystem. */
export interface HubMenuHost {
  /** Called after the menu closed itself (E / 닫기) so the hub re-locks the pointer. */
  onClosed(): void;
  /** 시뮬레이션 훈련장 (Phase 7, shared ship): start a training or join the one already running. */
  startTraining(): void;
  /* ── 목표 행성 (Phase 11) ── */
  /** The ship's current 목표 행성 (`HubRef.planet`), or null while nothing is picked. */
  planet(): PlanetId | null;
  /**
   * Why 행성 이동 is refused right now (Korean, shown on the disabled button), or null when it is allowed.
   * The rules live in `HubSystem.travelBlockReason` — the menu only renders them.
   */
  travelBlock(planet?: PlanetId): string | null;
  /** Commit the previewed planet: `HubRef.setPlanet` (starts the in-ship 창문 워프; the terminal closes). */
  travelTo(planet: PlanetId): void;
}

const MSG_TTL = 4500;

/**
 * Ship terminal (`.menu.hub-menu.fullscreen`) — **full-screen since Phase 11**, three columns:
 *
 * - **left**: the matchmaking sections, unchanged in behaviour — `신호` (개인 함선: 신호 찾기 / 코드로 도킹 /
 *   신호 송출) and `공유 함선` (코드 · 초대 링크 · 공개 전환 · 승무원 4행 · 도킹 해제).
 * - **centre**: the 행성 홀로그램 (`ui/PlanetHologram`, its own WebGL canvas) with the planet's name, 지형, a
 *   위협 badge and its one-line brief, `◀ ▶` (mouse, `←` / `→` and `A` / `D`) and the **행성 이동** button.
 *   Stepping left / right only *previews* — the ship flies when 행성 이동 is pressed (`HubRef.setPlanet`).
 * - **right, bottom**: `시뮬레이션 훈련장`; the footer is **닫기 (E) alone**. (2026-09-08: the `/seed` 안내
 *   줄과 신호 섹션의 `자동 매칭은 …` 안내 줄은 지웠다 — 화면에 당연한 설명을 남기지 않는다.)
 *   2026-09-08: the terminal closes on **E**, not Escape — Escape is the 일시정지 메뉴 everywhere now.
 *   2026-09-09: **Tab closes it too** (every screen does — `Keys.INVENTORY`, polled in `update()` which `HubSystem`
 *   runs before `InventorySystem`, and consumed so the same press cannot open the inventory).
 *
 * **2026-09-09 (두 가지를 지웠다)**:
 *  - **타이틀로 is gone from the footer.** The 일시정지 메뉴 already has it behind a 경고 팝업 with a 1초 홀드;
 *    a one-click "leave everything" in the corner of a screen you open to pick a planet is a trap, not a shortcut.
 *    `HubMenuHost.toTitle` went with it (nothing else called it), and so did `HubSystem.toTitle` / `Trans.toTitle`.
 *  - **The bottom-right 키 가이드 (`ui:keyGuide`, owner `'terminal'`) is gone.** The terminal is a full screen with
 *    a visible 닫기 (E) button and on-screen `◀ ▶` arrows, so a one-line key strip only repeated what the screen
 *    already showed. The **arrow-key stepping still works** (`onKeyDown`) — only the guide line left, so no
 *    `'terminal'` entry can be left standing on the guide stack.
 *
 * The 승무원 이름 section is **gone** (Phase 11): the call sign is entered once on the title screen
 * (`ui/menus/TitleMenu` → `net.setPlayerName`), so the terminal no longer renames anyone.
 * The mission-seed field left the terminal on 2026-09-06: seeds are set only through the dev console (`/seed`).
 * Cursor etiquette is Phase 10's: add the `'hub'` blocker, then `ctx.input.setCursorMode(true, 'hub')` — the pointer
 * lock is **kept**, never `exitPointerLock()`. Emits `ui:hubMenuToggled` **and** `hub:terminalToggled`.
 */
export class HubMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private unsubs: Array<() => void> = [];
  private _open = false;
  private msgTimer = 0;
  private busy = false;

  // header
  private subtitle: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  // personal
  private secSignal: HTMLElement;
  private btnMatch: HTMLButtonElement;
  private codeInput: HTMLInputElement;
  private btnJoin: HTMLButtonElement;
  private btnCreate: HTMLButtonElement;
  // shared
  private secShip: HTMLElement;
  private codeText: HTMLElement;
  private visTag: HTMLElement;
  private btnInvite: HTMLButtonElement;
  private btnPublic: HTMLButtonElement;
  private crew: HTMLElement;
  private crewRows: Array<{ root: HTMLElement; name: HTMLElement; badge: HTMLElement; state: HTMLElement }> = [];
  private btnLeave: HTMLButtonElement;
  // training (shared ship)
  private secTrain: HTMLElement;
  private btnTrain: HTMLButtonElement;
  // planet (Phase 11)
  private holoHost: HTMLElement;
  private holo: PlanetHologram | null = null;
  private holoTried = false;
  private pName: HTMLElement;
  private pTerrain: HTMLElement;
  private pThreat: HTMLElement;
  private pBrief: HTMLElement;
  /** 행성 상시 환경 한 줄 (A-13, 2026-09-11). 환경이 없는 행성에서는 숨는다. */
  private pEnv: HTMLElement;
  private pDots: HTMLElement[] = [];
  private pDotsEl: HTMLElement;
  private btnPrev: HTMLButtonElement;
  private btnNext: HTMLButtonElement;
  private btnTravel: HTMLButtonElement;
  private pCurrent: HTMLElement;
  /** Previewed planet index into `PLANET_IDS` (not the ship's planet until 행성 이동 is pressed). */
  private cursor = 0;
  // footer / message
  private msg: HTMLElement;

  constructor(private readonly ctx: GameContext, private readonly host: HubMenuHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu fullscreen interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    // ── header ──
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '함선 터미널', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    this.pill = el('div', { cls: 'status-pill offline', parent: head });
    el('i', { parent: this.pill });
    this.pillText = el('span', { text: '오프라인', parent: this.pill });

    // ── three columns (the terminal is ship-only since the Tab screen took implants / repairs) ──
    const grid = el('div', { cls: 'hub-grid', parent: f });
    const left = el('div', { cls: 'hub-col left', parent: grid });
    const centre = el('div', { cls: 'hub-col centre', parent: grid });
    const right = el('div', { cls: 'hub-col right', parent: grid });

    // ── signal (personal ship) ──
    this.secSignal = this.section(left, '신호');
    this.btnMatch = this.button(this.secSignal, '신호 찾기 (자동 매칭)', () => this.connectThen((n) => n.quickMatch()), 'primary wide');
    const codeRow = el('div', { cls: 'row', parent: this.secSignal });
    this.codeInput = el('input', { cls: 'ui-input code-input', attrs: { type: 'text', maxlength: '8', placeholder: '함선 코드', spellcheck: 'false', autocomplete: 'off' }, parent: codeRow });
    isolateInput(this.codeInput);    // 2026-09-08: Escape only blurs the field; the terminal closes on E
    this.codeInput.addEventListener('input', () => { this.codeInput.value = normalizeLobbyCode(this.codeInput.value); });
    this.codeInput.addEventListener('keydown', (e) => { if (e.code === 'Enter') this.join(); });
    this.btnJoin = this.button(codeRow, '코드로 도킹', () => this.join());
    this.btnCreate = this.button(this.secSignal, '신호 송출 (비공개 함선 생성)', () => this.connectThen((n) => n.createLobby()), 'wide');

    // ── ship (shared) ──
    this.secShip = this.section(left, '공유 함선');
    const codeBlock = el('div', { cls: 'hub-code', parent: this.secShip });
    this.codeText = el('div', { cls: 'code', text: '------', parent: codeBlock });
    this.visTag = el('div', { cls: 'vis', text: '비공개', parent: codeBlock });
    const shipRow = el('div', { cls: 'row', parent: this.secShip });
    this.btnInvite = this.button(shipRow, '초대 링크 복사', () => this.copyInvite());
    this.btnPublic = this.button(shipRow, '공개 전환', () => {
      const n = ctx.net; if (!n?.lobby || !n.isHost) return;
      n.setPublic(!n.lobby.isPublic);
    });
    this.crew = el('div', { cls: 'hub-crew', parent: this.secShip });
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const row = el('div', { cls: 'crew-row empty', parent: this.crew });
      row.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i]);
      el('div', { cls: 'bar', parent: row });
      const name = el('div', { cls: 'name', text: '빈 자리', parent: row });
      const badge = el('div', { cls: 'badge', text: '호스트', parent: row });
      badge.hidden = true;
      const state = el('div', { cls: 'state', text: '', parent: row });
      this.crewRows.push({ root: row, name, badge, state });
    }
    this.btnLeave = this.button(this.secShip, '도킹 해제', () => ctx.net?.leaveLobby(), 'danger wide');

    // ── 목표 행성 (centre column, Phase 11) ──
    const planet = el('div', { cls: 'hub-planet', parent: centre });
    el('div', { cls: 'hp-eyebrow', text: '목표 행성', parent: planet });
    const stage = el('div', { cls: 'hp-stage', parent: planet });
    this.btnPrev = this.button(stage, '◀', () => this.step(-1), 'hp-arrow prev');
    this.holoHost = el('div', { cls: 'hp-holo', parent: stage });
    this.btnNext = this.button(stage, '▶', () => this.step(1), 'hp-arrow next');
    this.pCurrent = el('div', { cls: 'hp-current', text: '현재 목표', parent: this.holoHost });
    this.pCurrent.hidden = true;
    const dots = this.pDotsEl = el('div', { cls: 'hp-dots', parent: planet });
    for (let i = 0; i < PLANET_IDS.length; i++) {
      const d = el('i', { parent: dots });
      d.dataset.planet = PLANET_IDS[i];
      this.pDots.push(d);
    }
    const nameRow = el('div', { cls: 'hp-name-row', parent: planet });
    this.pName = el('div', { cls: 'hp-name', text: '—', parent: nameRow });
    this.pThreat = el('div', { cls: 'hp-threat', text: '', parent: nameRow });
    this.pTerrain = el('div', { cls: 'hp-terrain', text: '', parent: planet });
    this.pBrief = el('div', { cls: 'hp-brief', text: '', parent: planet });
    this.pEnv = el('div', { cls: 'hp-env', text: '', parent: planet });
    this.pEnv.hidden = true;
    this.btnTravel = this.button(planet, '행성 이동', () => this.travel(), 'primary hp-travel');

    // ── 시뮬레이션 훈련장 (shared ship; the personal ship enters through the 사격장 sim hub) ──
    this.secTrain = this.section(right, '시뮬레이션 훈련장');
    this.btnTrain = this.button(this.secTrain, '시작', () => host.startTraining(), 'primary wide');
    el('div', { cls: 'hint', text: '개별 입장 · 카운트다운 없음. 탄약과 내구도는 소모되지 않습니다. 진행 중인 훈련에는 언제든 합류할 수 있습니다.', parent: this.secTrain });

    // ── message + footer ──
    this.msg = el('div', { cls: 'form-msg', parent: f });
    this.msg.hidden = true;
    const foot = el('div', { cls: 'hub-foot', parent: f });
    const footRight = el('div', { cls: 'right', parent: foot });
    this.button(footRight, '닫기 (E)', () => this.close());

    // keep clicks inside from reaching the canvas' click-to-lock fallback
    root.addEventListener('mousedown', (e) => e.stopPropagation());

    const b = ctx.bus;
    this.unsubs.push(
      b.on('net:statusChanged', () => this.refresh()),
      b.on('net:lobbyUpdated', () => this.refresh()),
      b.on('net:lobbyLeft', ({ reason }) => {
        this.refresh();
        // `toast:false` — with the terminal closed these already have a line elsewhere: hostLeft (ui/Notifications),
        // kicked (the `net:error` below carries the real reason), disconnected (ui/hud/NetBadge's 끊김 toast / badge).
        if (reason === 'hostLeft') this.showMsg('호스트가 함선을 떠났습니다', 'warning', false);
        else if (reason === 'disconnected') this.showMsg('서버와의 연결이 끊어졌습니다', 'danger', false);
        else if (reason === 'kicked') this.showMsg('함선에서 분리되었습니다', 'warning', false);
      }),
      // C-59 (2026-09-11): a refusal (`kicked` · `server_full` · `duplicate`) usually arrives while the terminal is closed —
      // `showMsg` hands it to a toast then, so the server's Korean reason is never lost.
      b.on('net:error', ({ code, message }) => this.showMsg(this.errorText(code, message), 'danger')),
      b.on('net:matched', ({ created }) => this.showMsg(created ? '열린 신호가 없어 새 공개 함선을 열었습니다' : '신호 포착 — 도킹 절차 시작', 'success', false)),
      b.on('net:peerJoined', ({ name }) => this.showMsg(`${name} 합류`, 'info', false)),
      b.on('net:peerLeft', ({ name }) => this.showMsg(`${name} 이탈`, 'warning', false)),
      // 목표 행성: a squad-mate's pick (or our own, once the warp arrived) re-syncs the preview
      b.on('hub:planetChanged', ({ planet: p }) => { this.cursor = planetIndex(p); this.syncPlanet(0); this.refresh(); }),
      b.on('hub:travel', () => this.refresh()),
      // 2026-09-08: 튜토리얼이 감춘 매치메이킹 섹션 · 행성 넘김은 단계가 넘어가거나 건너뛰어지면 돌아온다
      b.on('tutorial:changed', () => { if (this._open) this.refresh(); }),
    );
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean { return this._open; }

  /* ── 목표 행성 ─────────────────────────────────────────────────────────── */
  /** `←` / `→` and `A` / `D` step the hologram. Bubble phase, so `isolateInput` fields swallow their own keys. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._open) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { this.step(-1); e.preventDefault(); }
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') { this.step(1); e.preventDefault(); }
  };

  private def(): PlanetDef { return PLANET_DEFS[this.cursor] ?? PLANET_DEFS[0]; }

  /** 튜토리얼이 행성을 하나로 좁혀 놓았는가 (꺼져 있으면 언제나 false). */
  private get planetLocked(): boolean { return this.ctx.tutorial?.hides('planet') ?? false; }

  private step(dir: number): void {
    if (this.planetLocked) return;      // 튜토리얼: 고를 수 있는 행성이 하나뿐이라 넘김 자체를 막는다
    const n = PLANET_IDS.length;
    const next = ((this.cursor + dir) % n + n) % n;
    if (next === this.cursor) return;
    this.cursor = next;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.syncPlanet(dir);
    this.refresh();
  }

  /** Push the previewed planet into the hologram + the labels. `dir` 0 = no slide (open / external change). */
  private syncPlanet(dir: number): void {
    const d = this.def();
    if (!this.holoTried) {
      this.holoTried = true;
      this.holo = createPlanetHologram(this.holoHost);
      toggleClass(this.root, 'no-holo', !this.holo);
    }
    this.holo?.setPlanet(d, dir === 0 ? 1 : dir);
    setText(this.pName, d.name);
    setText(this.pTerrain, d.terrain);
    setText(this.pThreat, PLANET_THREAT_LABELS[d.threat] ?? '');
    this.pThreat.dataset.threat = String(d.threat);
    setText(this.pBrief, d.brief);
    this.refreshEnv();
    for (let i = 0; i < this.pDots.length; i++) toggleClass(this.pDots[i], 'on', i === this.cursor);
  }

  /**
   * 행성 상시 환경 한 줄 (A-13, 2026-09-11, 사용자 결정 **소프트 게이트**): `PlanetDef.env` 가 있으면
   * `ENV_ICON` + `ENV_LABEL_KO` + `ENV_DESC_KO` 를 브리핑 밑에 붙이고, 맞는 준비물이 실려 있지 않으면
   * 경고색(`.warn`)으로 바꾼다. **이동을 막지 않는다** — 버튼 상태는 `refreshTravel` 이 정하며 여기서는
   * 아무 것도 잠그지 않는다. 준비물 판정은 `ctx.progression.hasEnvPrep` 하나이고, 그 폴더가 아직 없는 동안은
   * (duck-typed) 「준비물 없음」으로 읽어 경고를 보여 준다.
   */
  private refreshEnv(): void {
    const env = this.def().env;
    this.pEnv.hidden = !env;
    if (!env) return;
    let prepared = false;
    const pr = this.ctx.progression;
    if (pr && typeof pr.hasEnvPrep === 'function') { try { prepared = pr.hasEnvPrep(env); } catch { prepared = false; } }
    setText(this.pEnv, `${ENV_ICON[env]} ${ENV_LABEL_KO[env]} — ${ENV_DESC_KO[env]}${prepared ? ' (준비물 있음)' : ''}`);
    this.pEnv.style.setProperty('--env-c', ENV_COLOR[env]);
    toggleClass(this.pEnv, 'warn', !prepared);
  }

  private travel(): void {
    const d = this.def();
    const blocked = this.host.travelBlock(d.id);
    if (blocked) { this.showMsg(blocked, 'warning'); this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
    if (this.host.planet() === d.id) return;
    this.host.travelTo(d.id);
  }

  /** Button state of 행성 이동: 현재 목표 / a `travelBlock` reason / enabled. */
  private refreshTravel(): void {
    this.refreshEnv();      // 준비물은 터미널이 열려 있는 동안에도 바뀔 수 있다 (가방에서 「사용」)
    const d = this.def();
    const here = this.host.planet() === d.id;
    const blocked = this.host.travelBlock();
    this.pCurrent.hidden = !here;
    if (here) { setText(this.btnTravel, '현재 목표'); this.btnTravel.disabled = true; }
    else if (blocked) { setText(this.btnTravel, blocked); this.btnTravel.disabled = true; }
    else { setText(this.btnTravel, `${d.name}(으)로 이동`); this.btnTravel.disabled = false; }
    const lock = !!blocked;
    // 2026-09-08: 튜토리얼이 첫 번째 행성만 허용하는 동안에는 넘김 화살표와 점을 **감춘다** — 다른 행성을
    // 보여 주고 "튜토리얼에서는 ~" 로 거절하느니, 고를 수 있는 하나만 보여 준다.
    const narrow = this.planetLocked;
    this.btnPrev.hidden = narrow;
    this.btnNext.hidden = narrow;
    this.pDotsEl.hidden = narrow;
    this.btnPrev.disabled = false;      // stepping is a preview — never locked
    this.btnNext.disabled = false;
    toggleClass(this.btnTravel, 'locked', lock);
    const cur = this.host.planet();
    for (let i = 0; i < this.pDots.length; i++) toggleClass(this.pDots[i], 'here', PLANET_IDS[i] === cur);
  }

  /* ── open / close ─────────────────────────────────────────────────────── */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.ctx.uiBlockers.add('hub');            // before the cursor mode (GameFlow / hub UI etiquette)
    // Phase 10: keep the pointer lock and drive the software cursor instead of handing the OS cursor back.
    this.ctx.escape.push('hub:terminal', () => this.close());
    this.ctx.input.setCursorMode(true, 'hub');
    this.root.hidden = false;
    this.frame.style.animation = 'none';
    void this.frame.offsetWidth;
    this.frame.style.animation = '';
    // 튜토리얼이 첫 번째 행성만 허용하는 동안에는 그 행성을 보여 준 채로 연다 (넘김은 감춰진다)
    this.cursor = this.planetLocked ? 0 : planetIndex(this.host.planet());
    this.syncPlanet(0);
    this.holo?.setVisible(true);
    this.refresh();
    this.ctx.bus.emit('ui:hubMenuToggled', { open: true });
    this.ctx.bus.emit('hub:terminalToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    this.root.hidden = true;
    this.holo?.setVisible(false);              // stop rendering the second WebGL context while it is closed
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.ctx.uiBlockers.delete('hub');
    this.ctx.escape.remove('hub:terminal');
    this.ctx.input.setCursorMode(false, 'hub');
    this.ctx.bus.emit('ui:hubMenuToggled', { open: false });
    this.ctx.bus.emit('hub:terminalToggled', { open: false });
    if (relock) this.host.onClosed();
  }

  /* ── state → DOM ──────────────────────────────────────────────────────── */
  refresh(): void {
    if (!this._open) return;
    const ctx = this.ctx, net = ctx.net;
    const lobby = net?.lobby ?? null;
    const status = net?.status ?? 'offline';
    const isHost = !!net?.isHost && !!lobby;

    // header
    setText(this.subtitle, lobby ? `공유 함선 · ${lobby.players.length}/${NET_MAX_PLAYERS} 승무원` : '개인 함선');
    this.pill.className = `status-pill ${status}`;
    setText(this.pillText, status === 'connected' ? `연결됨${net && net.rttMs > 0 ? ` · ${Math.round(net.rttMs)} ms` : ''}` : status === 'connecting' ? '연결 중' : status === 'error' ? '오류' : '오프라인');


    // sections — 2026-09-08: 튜토리얼 동안에는 매치메이킹을 통째로 감춘다 (혼자 한 바퀴 돌게 한다)
    const hideNet = ctx.tutorial?.hides('matchmaking') ?? false;
    this.secSignal.hidden = hideNet || !!lobby;
    this.secShip.hidden = hideNet || !lobby;
    const canNet = !!net && !this.busy;
    this.btnMatch.disabled = !canNet;
    this.btnJoin.disabled = !canNet;
    this.btnCreate.disabled = !canNet;

    this.refreshTravel();

    this.secTrain.hidden = !lobby;
    if (lobby) {
      const mode = net?.missionMode ?? lobby.mode ?? 'raid';
      const training = lobby.started && mode === 'training';
      const n = lobby.players.filter((p) => p.connected && p.inMission === true).length;
      if (lobby.started && !training) { setText(this.btnTrain, '임무 진행 중'); this.btnTrain.disabled = true; }
      else if (training) { setText(this.btnTrain, `합류 (${n}명 훈련 중)`); this.btnTrain.disabled = !(net?.missionInProgress ?? false); }
      else { setText(this.btnTrain, '시작'); this.btnTrain.disabled = !net; }
      setText(this.codeText, lobby.code);
      setText(this.visTag, lobby.isPublic ? '공개' : '비공개');
      toggleClass(this.visTag, 'public', lobby.isPublic);
      this.btnPublic.hidden = !isHost;
      setText(this.btnPublic, lobby.isPublic ? '비공개로 전환' : '공개로 전환');
      toggleClass(this.btnPublic, 'on', lobby.isPublic);
      this.renderCrew(lobby, net);
      this.btnLeave.disabled = false;
    }
  }

  private renderCrew(lobby: LobbyState, net: NetRef | null): void {
    for (let slot = 0; slot < NET_MAX_PLAYERS; slot++) {
      const row = this.crewRows[slot];
      const p = lobby.players.find((q) => q.slot === slot);
      if (!p) {
        row.root.className = 'crew-row empty';
        setText(row.name, '빈 자리'); setText(row.state, ''); row.badge.hidden = true;
        continue;
      }
      const me = p.id === net?.localId;
      const off = !p.connected;
      row.root.className = `crew-row${p.ready ? ' ready' : ''}${me ? ' me' : ''}${off ? ' off' : ''}`;
      setText(row.name, p.name);
      row.badge.hidden = !p.isHost;
      const training = lobby.started && (net?.missionMode ?? lobby.mode ?? 'raid') === 'training';
      setText(row.state, off ? '연결 끊김' : training ? (p.inMission ? '훈련장' : '함선') : lobby.started ? (p.ready ? '임무 중' : '함선') : p.ready ? '탑승 완료' : '대기 중');
    }
  }

  /* ── actions ──────────────────────────────────────────────────────────── */
  private join(): void {
    const code = normalizeLobbyCode(this.codeInput.value);
    if (!isValidLobbyCode(code)) { this.showMsg('6자리 함선 코드를 입력하세요', 'warning'); return; }
    this.connectThen((n) => n.joinLobby(code));
  }

  /** Connect (idempotent) then run `action`; shows an inline error when the relay is unreachable. */
  private connectThen(action: (n: NetRef) => void): void {
    const net = this.ctx.net;
    if (!net) { this.showMsg('멀티플레이 사용 불가 (네트워크 모듈 없음)', 'danger'); return; }
    this.busy = true; this.refresh();
    const p: Promise<boolean> = typeof net.ensureConnected === 'function'
      ? net.ensureConnected()
      : net.connect().then(() => true, () => false);
    p.then((ok) => {
      this.busy = false; this.refresh();
      if (!ok) { this.showMsg('서버에 연결할 수 없습니다', 'danger'); return; }
      action(net);
    }).catch(() => { this.busy = false; this.refresh(); this.showMsg('서버에 연결할 수 없습니다', 'danger'); });
  }

  private copyInvite(): void {
    const url = this.ctx.net?.getInviteUrl();
    if (!url) return;
    const done = (): void => { this.showMsg('초대 링크 복사됨', 'success', false); this.ctx.bus.emit('ui:notify', { text: '초대 링크가 복사되었습니다', kind: 'success' }); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => this.showMsg(url, 'info'));
    else this.showMsg(url, 'info');
  }

  private errorText(code: string, message: string): string {
    switch (code) {
      case 'not_found': return '해당 코드의 함선을 찾을 수 없습니다';
      case 'full': return '함선이 만석입니다';
      case 'started': return '해당 함선은 이미 임무 중입니다';
      case 'not_host': return '호스트만 할 수 있습니다';
      case 'not_ready': return '모든 승무원이 탑승해야 합니다';
      case 'in_lobby': return '이미 함선에 도킹되어 있습니다';
      case 'not_in_lobby': return '도킹된 함선이 없습니다';
      case 'not_started': return '진행 중인 임무가 없습니다';
      case 'duplicate': return '다른 탭에서 같은 세션이 연결되었습니다';
      case 'no_planet': return '목표 행성을 먼저 지정하세요';
      case 'invalid': return '잘못된 요청입니다';
      /* C-29 / C-59 (2026-09-11): 서버 콘솔 — 서버 문구(`kick <id> [사유]` 의 사유 포함)가 있으면 그대로 쓴다. */
      case 'kicked': return message || '서버 관리자가 연결을 끊었습니다';
      case 'server_full': return message || '서버 접속 인원이 가득 찼습니다';
      default: return message || '서버 오류';
    }
  }

  /* ── helpers ──────────────────────────────────────────────────────────── */
  private section(parent: HTMLElement, label: string): HTMLElement {
    const s = el('div', { cls: 'hub-section', parent });
    el('div', { cls: 'ui-label', text: label, parent: s });
    return s;
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  /**
   * The terminal's inline message line. **C-59 (2026-09-11)**: with the terminal closed the text used to vanish — it now
   * goes to a toast (`ui:notify`) while in the ship, unless `toast` is false because another folder already toasts the
   * same moment. Outside the ship (raid / title) a closed terminal stays silent: game/ owns the in-mission lines.
   */
  showMsg(text: string, kind: 'info' | 'success' | 'warning' | 'danger' = 'info', toast = true): void {
    if (!this._open) {
      if (toast && this.ctx.phase === 'hub') this.ctx.bus.emit('ui:notify', { text, kind, duration: 4 });
      return;
    }
    this.msg.className = `form-msg ${kind}`;
    setText(this.msg, text);
    this.msg.hidden = false;
    this.msgTimer = performance.now() + MSG_TTL;
  }

  /**
   * Called every hub frame: expire the inline message and drive the hologram's own render loop. 2026-09-09: also
   * the **Tab** close — `HubSystem.update` runs this before `InventorySystem.update`, so consuming the key here is
   * what keeps the same press from opening the inventory. A Tab typed into the 함선 코드 field never gets here
   * (`isolateInput` stops it at the field). Ignored while the 일시정지 메뉴 is on top.
   */
  update(dt = 0): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
    if (!this._open) return;
    if (this.ctx.input.wasPressed(Keys.INVENTORY) && !this.ctx.uiBlockers.has(MENU_BLOCKER)) {
      this.ctx.input.consume(Keys.INVENTORY);
      this.close();
      return;
    }
    this.holo?.render(dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    this.holo?.dispose(); this.holo = null;
    this.ctx.uiBlockers.delete('hub');
    this.ctx.escape.remove('hub:terminal');
    this.ctx.input.setCursorMode(false, 'hub');
    this.root.remove();
  }
}
