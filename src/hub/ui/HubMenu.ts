import type { GameContext, IntelSpec, NetRef, PlanetDef, PlanetId } from '@/shared';
import {
  ENV_COLOR, ENV_DESC_KO, ENV_ICON, ENV_LABEL_KO,
  INTEL_OPTIONS_IN_ORDER, Keys, MENU_BLOCKER, NAMED_ROGUE_NAME_KO, NET_MAX_PLAYERS, PLANET_DEFS, PLANET_IDS,
  PLANET_THREAT_LABELS, getPlanet, intelEffectText, planetIndex,
} from '@/shared';
import { el, setText, toggleClass } from './dom';
import { IntelMenu } from './IntelMenu';
import { MatchPanel } from './MatchPanel';
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
 * Ship terminal (`.menu.hub-menu.fullscreen`) — **full-screen since Phase 11**.
 *
 * **2026-09-14 (정보상, 사용자 결정 — `docs/plans/intel-broker.md` §4.1): 3열 → 2열.** 좌측 매치메이킹 열이
 * 통째로 머리 우상단 `📡 매칭` 버튼 뒤의 팝업(`ui/MatchPanel`)으로 갔고, 행성 브리핑이 **중앙에서 넓게**
 * 자리를 차지한다. 우측 열은 위에서부터 **정보상 패널**(`.hub-intel`, 접두사 `.hi-`) · **시뮬레이션 훈련장**이다.
 * 정보상 패널은 보유 정보가 없으면 `정보 구매`, 있으면 요약 + `정보 확인` / `지역 재배치` 이고 **멀티에서
 * 비호스트는 전부 읽기 전용**이다 (탐사 차량 요금의 「결제자 한 명」 규약과 같다). 전체 화면은 `ui/IntelMenu`.
 *
 * 아래는 그 전 구조의 설명이고 매치메이킹 · 행성 · 훈련장의 **동작은 한 줄도 바뀌지 않았다**:
 *
 * - **left (→ 2026-09-14 매칭 팝업)**: `신호` (개인 함선: 신호 찾기 / 코드로 도킹 /
 *   신호 송출) and `공유 함선` (코드 · 초대 링크 · 공개 전환 · 승무원 4행 · 도킹 해제).
 * - **centre**: the 행성 홀로그램 (`ui/PlanetHologram`, its own WebGL canvas) with the planet's name, 지형, a
 *   위협 badge and its one-line brief, `◀ ▶` (mouse, `←` / `→` and `A` / `D`) and the **행성 이동** button.
 *   Stepping left / right only *previews* — the ship flies when 행성 이동 is pressed (`HubRef.setPlanet`).
 * - **right, bottom**: `시뮬레이션 훈련장` — **2026-09-12: on both ships** (solo too): the 시뮬레이션실 and its
 *   시뮬레이션 허브 were retired, so the terminal is the only way into the arena. The footer is **닫기 (E) alone**. (2026-09-08: the `/seed` 안내
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
  private btnMatching: HTMLButtonElement;
  // 매칭 팝업 (2026-09-14) — 옛 좌측 열 전부가 여기 산다
  private match: MatchPanel;
  // 정보상 (2026-09-14)
  private secIntel: HTMLElement;
  private intelBody: HTMLElement;
  private intelActions: HTMLElement;
  private intelNote: HTMLElement;
  private btnIntelBuy: HTMLButtonElement;
  private btnIntelView: HTMLButtonElement;
  private btnIntelMove: HTMLButtonElement;
  private intelMenu: IntelMenu;
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
    // 2026-09-14 (사용자 결정): 매치메이킹은 머리 우상단 버튼 → 팝업이다 (옛 좌측 열)
    this.btnMatching = this.button(head, '📡 매칭', () => this.match.open(), 'hub-matching');

    // ── two columns (2026-09-14): centre = 행성 (넓게), right = 정보상 → 시뮬레이션 훈련장 ──
    const grid = el('div', { cls: 'hub-grid', parent: f });
    const centre = el('div', { cls: 'hub-col centre', parent: grid });
    const right = el('div', { cls: 'hub-col right', parent: grid });

    this.match = new MatchPanel(ctx, {
      connectThen: (action) => this.connectThen(action),
      showMsg: (text, kind, toast) => this.showMsg(text, kind, toast),
      isBusy: () => this.busy,
      copyInvite: () => this.copyInvite(),
      onClosed: () => this.refresh(),
    });

    // ── 정보상 (right column, 2026-09-14) ──
    this.secIntel = this.section(right, '정보상');
    this.secIntel.classList.add('hub-intel');
    this.intelBody = el('div', { cls: 'hi-body', parent: this.secIntel });
    this.intelNote = el('div', { cls: 'hi-note', text: '', parent: this.secIntel });
    this.intelNote.hidden = true;
    this.intelActions = el('div', { cls: 'hi-actions', parent: this.secIntel });
    this.btnIntelBuy = this.button(this.intelActions, '정보 구매', () => this.openIntel(false), 'primary wide');
    this.btnIntelView = this.button(this.intelActions, '정보 확인', () => this.openIntel(false), 'wide');
    this.btnIntelMove = this.button(this.intelActions, '지역 재배치', () => this.openIntel(true), 'wide');

    this.intelMenu = new IntelMenu(ctx, {
      planet: () => this.host.planet(),
      borrowHologram: (hostEl) => { this.holo?.attachTo(hostEl); return this.holo; },
      returnHologram: () => { this.holo?.clearLockOn(); this.holo?.attachTo(this.holoHost); },
      onClosed: () => { this.refresh(); },
    });

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

    // ── 시뮬레이션 훈련장 — 2026-09-12: **both ships** (the 시뮬레이션실 · 시뮬레이션 허브 are retired, the terminal is the one entry) ──
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
      // 정보상 (2026-09-14): 구매 · 폐기 · 소모 · 서버 문서 로드 전부가 패널을 다시 그린다
      b.on('intel:changed', () => this.refresh()),
      b.on('meta:creditsChanged', () => { if (this._open) this.refresh(); }),
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
    // 2026-09-14: 위에 뜬 화면(매칭 · 정보상)이 있으면 행성 넘김은 멎는다 — 보이지도 않는 것이 움직이면 안 된다
    if (this.match.isOpen || this.intelMenu.isOpen) return;
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

  /**
   * **E 가 닫는 것은 맨 위 하나다** (2026-09-14). 터미널 위에 매칭 팝업 · 정보상 화면이 뜰 수 있으므로
   * `HubSystem` 의 E 는 이 함수를 지난다 — Escape 스택(`ctx.escape`)과 같은 순서다. 닫을 자식이 있었으면 true.
   */
  closeTop(): boolean {
    if (this.intelMenu.isOpen) { this.intelMenu.close(); return true; }
    if (this.match.isOpen) { this.match.close(); return true; }
    this.close();
    return false;
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    // 터미널이 닫히면 그 위의 화면도 같이 닫힌다 (blocker · escape 토큰이 남지 않게)
    this.intelMenu.close();
    this.match.close();
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


    // 2026-09-08: 튜토리얼 동안에는 매치메이킹을 통째로 감춘다 (혼자 한 바퀴 돌게 한다) — 이제 버튼째 사라진다
    const hideNet = ctx.tutorial?.hides('matchmaking') ?? false;
    this.btnMatching.hidden = hideNet;
    setText(this.btnMatching, lobby ? `📡 매칭 · ${lobby.code}` : '📡 매칭');
    toggleClass(this.btnMatching, 'on', !!lobby);
    if (hideNet && this.match.isOpen) this.match.close();
    this.match.refresh();

    this.refreshTravel();
    this.refreshIntel();

    // 2026-09-12 (사용자 결정): 시뮬레이션실이 없어져 훈련장은 **어느 함선에서든 터미널로** 들어간다 — 섹션은 늘 보인다
    this.secTrain.hidden = false;
    if (!lobby) { setText(this.btnTrain, '시작'); this.btnTrain.disabled = false; }   // 솔로: `startTraining` 이 네트 없이 연다
    if (lobby) {
      const mode = net?.missionMode ?? lobby.mode ?? 'raid';
      const training = lobby.started && mode === 'training';
      const n = lobby.players.filter((p) => p.connected && p.inMission === true).length;
      if (lobby.started && !training) { setText(this.btnTrain, '임무 진행 중'); this.btnTrain.disabled = true; }
      else if (training) { setText(this.btnTrain, `합류 (${n}명 훈련 중)`); this.btnTrain.disabled = !(net?.missionInProgress ?? false); }
      else { setText(this.btnTrain, '시작'); this.btnTrain.disabled = !net; }
    }
    void isHost;
  }

  /* ── 정보상 패널 (2026-09-14) ─────────────────────────────────────────────── */

  /**
   * 보유 정보가 없으면 레이븐 소개 한 줄 + `정보 구매`, 있으면 산 기믹 요약 + 그 정보의 행성 + `정보 확인` /
   * `지역 재배치`. 보유 정보의 행성이 **지금 목표 행성과 다르면** 경고색으로 그렇게 적는다 (그 행성으로
   * 출격해야 쓰인다). **멀티에서 비호스트는 전부 읽기 전용** — 버튼이 딤드 + 사유 (사용자 결정).
   */
  private refreshIntel(): void {
    const ctx = this.ctx;
    const here = this.host.planet();
    const net = ctx.net;
    const readOnly = !!net?.lobby && !net.isHost;
    const available = !!ctx.meta?.intel;
    /*
     * 분대장 · 솔로는 자기 프로필(`intel.get()`)을, **분대원은 분대장의 것**(`ctx.net.lobbyIntel`)을 본다 —
     * `Intel.get()` 은 로컬 프로필만 읽으므로 비호스트에게는 늘 null 이다 (동기화는 호스트가 민다).
     * `IntelWire` 에는 행성이 없어 로비의 목표 행성을 붙인다 (그 정보는 정의상 그 행성의 것이다).
     */
    let spec: IntelSpec | null = ctx.meta?.intel?.get() ?? null;
    if (!spec) {
      const wire = net?.lobbyIntel ?? null;
      if (wire && here && Array.isArray(wire.picks) && wire.picks.length) spec = { planet: here, seed: wire.seed, picks: wire.picks };
    }

    this.intelBody.replaceChildren();
    if (!spec) {
      el('div', { cls: 'hi-intro', text: '레이븐 — 행성 정보를 판다. 산 만큼 그 레이드의 기믹이 고정된다.', parent: this.intelBody });
      el('div', { cls: 'hi-empty', text: '보유한 정보 없음', parent: this.intelBody });
    } else {
      const planetDef = getPlanet(spec.planet);
      const pl = el('div', { cls: 'hi-planet', parent: this.intelBody });
      el('span', { cls: 'hi-planet-name', text: planetDef?.name ?? spec.planet, parent: pl });
      const mismatch = !!here && here !== spec.planet;
      if (mismatch) el('span', { cls: 'hi-warn', text: '다른 행성의 정보', parent: pl });
      toggleClass(this.secIntel, 'is-mismatch', mismatch);
      for (const p of spec.picks) {
        const def = INTEL_OPTIONS_IN_ORDER.find((d) => d.id === p.g);
        if (!def) continue;
        const row = el('div', { cls: 'hi-row', parent: this.intelBody });
        el('span', { cls: 'hi-row-label', text: def.label, parent: row });
        const named = p.g === 'named' && p.id ? NAMED_ROGUE_NAME_KO[p.id as keyof typeof NAMED_ROGUE_NAME_KO] : null;
        el('span', { cls: 'hi-row-effect', text: named ? `${intelEffectText(p.g, p.tier)} — ${named}` : intelEffectText(p.g, p.tier), parent: row });
      }
    }
    if (!spec) toggleClass(this.secIntel, 'is-mismatch', false);

    this.btnIntelBuy.hidden = !!spec;
    this.btnIntelView.hidden = !spec;
    this.btnIntelMove.hidden = !spec;
    const blocked = !available ? '정보상을 사용할 수 없습니다'
      : readOnly ? '분대장만 정보를 살 수 있습니다'
        : !here ? '목표 행성을 먼저 지정하세요'
          : null;
    this.btnIntelBuy.disabled = !!blocked;
    this.btnIntelMove.disabled = !!blocked;
    this.btnIntelView.disabled = !available;      // 확인은 비호스트도 할 수 있다 (읽기 전용)
    this.intelNote.hidden = !blocked;
    if (blocked) setText(this.intelNote, blocked);
  }

  /** `정보 구매` · `정보 확인` · `지역 재배치` 의 공통 입구 (`relocate` 면 경고 팝업까지 바로 띄운다). */
  private openIntel(relocate: boolean): void {
    if (relocate) this.intelMenu.openRelocate();
    else this.intelMenu.open();
  }

  /* ── actions ──────────────────────────────────────────────────────────── */

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
      // 2026-09-14: Tab 도 **맨 위 하나**만 닫는다 (터미널 위에 매칭 팝업 · 정보상 화면이 뜬다)
      if (this.closeTop()) return;
      return;
    }
    this.holo?.render(dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    this.intelMenu.dispose();
    this.match.dispose();
    this.holo?.dispose(); this.holo = null;
    this.ctx.uiBlockers.delete('hub');
    this.ctx.escape.remove('hub:terminal');
    this.ctx.input.setCursorMode(false, 'hub');
    this.root.remove();
  }
}
