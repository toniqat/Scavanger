import type { GameContext, IntelSpec, NetRef, PlanetDef, PlanetId } from '@/shared';
import {
  ENV_COLOR, ENV_DESC_KO, ENV_ICON, ENV_LABEL_KO,
  INTEL_OPTIONS_IN_ORDER, Keys, MENU_BLOCKER, NAMED_ROGUE_NAME_KO, NET_MAX_PLAYERS, PLANET_DEFS, PLANET_IDS,
  PLANET_THREAT_LABELS, getPlanet, humanPlayersOf, intelEffectText, isBotPlayer, isDockedLobby, planetIndex,
} from '@/shared';
import { el, setText, toggleClass } from './dom';
import { IntelMenu } from './IntelMenu';
import { InviteModal } from './InviteModal';
import { MatchTab } from './MatchTab';
import { createPlanetHologram, type PlanetHologram } from './PlanetHologram';
import { TrainingConfirm } from './TrainingConfirm';

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

/** 터미널 상단 탭. */
export type HubMenuTab = 'planet' | 'match';

const MSG_TTL = 4500;

/**
 * Ship terminal (`.menu.hub-menu.fullscreen`) — **full-screen since Phase 11**.
 *
 * **2026-09-15 (분대 · 도킹 매칭, 사용자 결정 — `docs/DECISIONS.md` 「2026-09-15 — 분대 · 도킹 매칭」): 상단 탭 둘.**
 * 인벤토리 Tab 화면과 같은 알약 탭(`nav.scr-tabs > button.scr-tab`, `ui/styles/base.css`)이 프레임 위 가운데에 떠 있다:
 *
 * - **행성** (`.hub-pane-planet`): 3칸 격자 — 빈 왼쪽 칸 · **가운데 행성 카드**(홀로그램 · 이름 · 지형 · 위협 · 브리핑 ·
 *   `◀ ▶` · 행성 이동) · 오른쪽 **정보상 패널**. 왼쪽 칸이 오른쪽과 같은 폭을 차지해 행성이 프레임 한가운데에 선다.
 *   `시뮬레이션 훈련장` 은 섹션이 아니라 **프레임 우하단 버튼**(`.hub-train`, 푸터 오른쪽)이고 안내 줄은 지웠다.
 *   누르면 곧장 들어가지 않고 확인 카드(`TrainingConfirm`)를 띄운다. 도킹 전 분대에서는 `분대 대기 중` 으로 잠긴다.
 * - **매칭** (`.hub-pane-match`, `ui/MatchTab`): 정사각 초상 4칸 + `비공개 매칭` / `공개 매칭` (또는 `도킹 해제`).
 *   빈 칸의 `초대` 가 초대 창(`ui/InviteModal`)을 연다. 옛 머리 우상단 `📡 매칭` 버튼 · 매칭 팝업(`MatchPanel` —
 *   코드 · 초대 링크 · 공개 토글)은 지웠다. 튜토리얼 게이트 `matchmaking` 이 **이 탭을 감춘다**.
 *
 * 터미널은 **언제나 행성 탭으로 열린다** — 튜토리얼의 행성 단계 스포트라이트(`.hp-travel`)가 그 탭에 있고, 행성을
 * 고르는 것이 이 화면을 여는 주된 이유다.
 *
 * 닫기 사슬 (`closeTop`, E · Tab 공용 — Escape 는 `ctx.escape` 스택이 같은 순서로 닫는다):
 * 훈련장 확인 → 초대 창 → 정보상 화면 → 터미널. 자식 화면은 전부 **자기 토큰**을 쓴다 (`hub:trainConfirm` ·
 * `hub:invite` · `hub:intel`) — 닫혀도 뒤의 터미널이 `hub` blocker · 커서를 잃지 않는다.
 *
 * 그 전의 이력 (동작은 그대로다):
 * - 2026-09-14 (정보상): 행성 브리핑이 중앙에서 넓게, 정보상 패널(`.hub-intel`, 접두사 `.hi-`)은 **멀티에서 비호스트는
 *   전부 읽기 전용**. 전체 화면은 `ui/IntelMenu`.
 * - Stepping left / right only *previews* — the ship flies when 행성 이동 is pressed (`HubRef.setPlanet`).
 * - 2026-09-12: 시뮬레이션실이 없어져 훈련장은 **어느 함선에서든 터미널로** 들어간다.
 * - 2026-09-08: the terminal closes on **E**, not Escape. 2026-09-09: **Tab closes it too** (`Keys.INVENTORY`, polled in
 *   `update()` which `HubSystem` runs before `InventorySystem`, and consumed so the same press cannot open the inventory).
 * - 2026-09-09: 타이틀로 · 우하단 키 가이드는 지웠다 (터미널 자신은 가이드를 올리지 않는다 — 자식 화면만 올린다).
 * - The 승무원 이름 section is gone (Phase 11); the mission seed is set only through the dev console (`/seed`).
 *
 * Cursor etiquette is Phase 10's: add the `'hub'` blocker, then `ctx.input.setCursorMode(true, 'hub')`.
 * Emits `ui:hubMenuToggled` **and** `hub:terminalToggled`.
 */
export class HubMenu {
  readonly root: HTMLElement;
  private frame: HTMLElement;
  private unsubs: Array<() => void> = [];
  private _open = false;
  private msgTimer = 0;
  private busy = false;
  private tab: HubMenuTab = 'planet';

  // header + tabs
  private subtitle: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private readonly tabButtons = new Map<HubMenuTab, HTMLButtonElement>();
  private panePlanet: HTMLElement;
  private paneMatch: HTMLElement;
  // 매칭 탭 (2026-09-15)
  private match: MatchTab;
  private invite: InviteModal;
  // 정보상 (2026-09-14)
  private secIntel: HTMLElement;
  private intelBody: HTMLElement;
  private intelActions: HTMLElement;
  private intelNote: HTMLElement;
  private btnIntelBuy: HTMLButtonElement;
  private btnIntelView: HTMLButtonElement;
  private btnIntelMove: HTMLButtonElement;
  private intelMenu: IntelMenu;
  // 시뮬레이션 훈련장 (2026-09-15: 우하단 버튼 + 확인 카드)
  private btnTrain: HTMLButtonElement;
  private trainState: HTMLElement;
  private trainConfirm: TrainingConfirm;
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

    // ── 상단 탭 (2026-09-15) — 인벤토리 Tab 화면의 알약 탭과 같은 클래스 ──
    const tabs = el('nav', { cls: 'scr-tabs hub-tabs', parent: f });
    for (const [id, label] of [['planet', '행성'], ['match', '매칭']] as const) {
      const b = el('button', { cls: `scr-tab${id === this.tab ? ' is-on' : ''}`, text: label, parent: tabs });
      b.type = 'button';
      b.dataset.tab = id;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setTab(id, true); });
      this.tabButtons.set(id, b);
    }

    // ── header ──
    const head = el('div', { cls: 'hub-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '함선 터미널', parent: hl });
    this.subtitle = el('div', { cls: 'subtitle', text: '', parent: hl });
    this.pill = el('div', { cls: 'status-pill offline', parent: head });
    el('i', { parent: this.pill });
    this.pillText = el('span', { text: '오프라인', parent: this.pill });

    // ── 행성 탭: 빈 왼쪽 칸 · 가운데 행성 · 오른쪽 정보상 ──
    this.panePlanet = el('div', { cls: 'hub-pane hub-pane-planet', parent: f });
    const grid = el('div', { cls: 'hub-grid', parent: this.panePlanet });
    el('div', { cls: 'hub-col left', parent: grid });
    const centre = el('div', { cls: 'hub-col centre', parent: grid });
    const right = el('div', { cls: 'hub-col right', parent: grid });

    // ── 매칭 탭 ──
    this.paneMatch = el('div', { cls: 'hub-pane hub-pane-match', parent: f });
    this.paneMatch.hidden = true;
    this.invite = new InviteModal(ctx, () => this.refresh());
    this.match = new MatchTab(ctx, this.paneMatch, {
      connectThen: (action) => this.connectThen(action),
      isBusy: () => this.busy,
      openInvite: () => this.invite.open(),
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

    // ── message + footer (2026-09-15): 오른쪽에 `닫기 (E)` → `시뮬레이션 훈련장` — 훈련장이 프레임 우하단 모서리다.
    //    왼쪽 아래 구석은 비워 둔다: 함선 HUD 의 분대 목록 · 이름 줄이 터미널 위에 그려지는 자리다.
    this.msg = el('div', { cls: 'form-msg', parent: f });
    this.msg.hidden = true;
    const foot = el('div', { cls: 'hub-foot', parent: f });
    const footRight = el('div', { cls: 'right', parent: foot });
    this.button(footRight, '닫기 (E)', () => this.close());
    this.btnTrain = el('button', { cls: 'ui-btn primary hub-train', parent: footRight });
    this.btnTrain.type = 'button';
    el('span', { cls: 'hub-train-name', text: '시뮬레이션 훈련장', parent: this.btnTrain });
    this.trainState = el('span', { cls: 'hub-train-state', text: '시작', parent: this.btnTrain });
    this.btnTrain.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.btnTrain.disabled) return;
      this.ctx.bus.emit('audio:play', { id: 'ui_click' });
      this.trainConfirm.open(() => this.host.startTraining());
    });
    this.trainConfirm = new TrainingConfirm(ctx, () => this.refresh());

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
      // 2026-09-15: 초대 창의 친구 · 최근 목록과 `초대 중` 배지는 소셜 스냅숏을 따라간다
      b.on('social:updated', () => { if (this._open) this.refresh(); }),
      b.on('social:inviteResult', () => { if (this._open) this.refresh(); }),
      // 목표 행성: a squad-mate's pick (or our own, once the warp arrived) re-syncs the preview
      b.on('hub:planetChanged', ({ planet: p }) => { this.cursor = planetIndex(p); this.syncPlanet(0); this.refresh(); }),
      b.on('hub:travel', () => this.refresh()),
      // 정보상 (2026-09-14): 구매 · 폐기 · 소모 · 서버 문서 로드 전부가 패널을 다시 그린다
      b.on('intel:changed', () => this.refresh()),
      b.on('meta:creditsChanged', () => { if (this._open) this.refresh(); }),
      b.on('progress:levelUp', () => { if (this._open) this.refresh(); }),
      // 2026-09-08: 튜토리얼이 감춘 매칭 탭 · 행성 넘김은 단계가 넘어가거나 건너뛰어지면 돌아온다
      b.on('tutorial:changed', () => { if (this._open) this.refresh(); }),
    );
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean { return this._open; }
  /** 지금 보이는 상단 탭 (스모크 · 디버그). */
  get activeTab(): HubMenuTab { return this.tab; }

  /* ── 상단 탭 ──────────────────────────────────────────────────────────── */
  /** 탭을 바꾼다. 튜토리얼이 매칭을 감춘 동안에는 행성 탭에 머문다. */
  setTab(tab: HubMenuTab, sound = false): void {
    if (tab === 'match' && this.matchHidden) tab = 'planet';
    const changed = tab !== this.tab;
    this.tab = tab;
    for (const [id, b] of this.tabButtons) toggleClass(b, 'is-on', id === tab);
    this.panePlanet.hidden = tab !== 'planet';
    this.paneMatch.hidden = tab !== 'match';
    this.btnTrain.hidden = tab !== 'planet';
    // 매칭 탭에서는 홀로그램이 보이지 않는다 — 두 번째 GL 컨텍스트가 헛돌지 않게 멈춘다
    this.holo?.setVisible(this._open && tab === 'planet');
    if (changed && sound) this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (tab !== 'match') this.invite.close();
    this.refresh();
  }

  /** 튜토리얼이 매칭(탭)을 감추는가 (꺼져 있으면 언제나 false). */
  private get matchHidden(): boolean { return this.ctx.tutorial?.hides('matchmaking') ?? false; }

  /* ── 목표 행성 ─────────────────────────────────────────────────────────── */
  /** `←` / `→` and `A` / `D` step the hologram. Bubble phase, so `isolateInput` fields swallow their own keys. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._open || this.tab !== 'planet') return;
    // 2026-09-14: 위에 뜬 화면(정보상 · 확인 · 초대)이 있으면 행성 넘김은 멎는다 — 보이지도 않는 것이 움직이면 안 된다
    if (this.intelMenu.isOpen || this.trainConfirm.isOpen || this.invite.isOpen) return;
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
      this.holo?.setVisible(this._open && this.tab === 'planet');
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
    this.setTab('planet');                     // 2026-09-15: 언제나 행성 탭으로 연다 (refresh 포함)
    this.ctx.bus.emit('ui:hubMenuToggled', { open: true });
    this.ctx.bus.emit('hub:terminalToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /**
   * **E 가 닫는 것은 맨 위 하나다** (2026-09-14). 터미널 위에 훈련장 확인 · 초대 창 · 정보상 화면이 뜰 수 있으므로
   * `HubSystem` 의 E 와 이 화면의 Tab 은 이 함수를 지난다 — Escape 스택(`ctx.escape`)과 같은 순서다. 닫을 자식이 있었으면 true.
   */
  closeTop(): boolean {
    if (this.trainConfirm.isOpen) { this.trainConfirm.close(); return true; }
    if (this.invite.isOpen) { this.invite.close(); return true; }
    if (this.intelMenu.isOpen) { this.intelMenu.close(); return true; }
    this.close();
    return false;
  }

  close(relock = true): void {
    if (!this._open) return;
    this._open = false;
    // 터미널이 닫히면 그 위의 화면도 같이 닫힌다 (blocker · escape 토큰이 남지 않게)
    this.trainConfirm.close();
    this.invite.close();
    this.intelMenu.close();
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
    const docked = isDockedLobby(lobby);

    // header — 2026-09-15: 분대가 있어도 도킹 전이면 여전히 개인 함선이다
    // 2026-09-15 (안드로이드 분대원): 승무원 수는 **사람**이고, 안드로이드는 뒤에 따로 붙인다
    const humans = humanPlayersOf(lobby).length;
    const bots = lobby ? lobby.players.length - humans : 0;
    const botLine = bots > 0 ? ` · 안드로이드 ${bots}` : '';
    setText(this.subtitle, docked && lobby ? `공유 함선 · ${humans}/${NET_MAX_PLAYERS} 승무원${botLine}`
      : lobby ? `개인 함선 · 분대 ${humans}/${NET_MAX_PLAYERS}${botLine}` : '개인 함선');
    this.pill.className = `status-pill ${status}`;
    setText(this.pillText, status === 'connected' ? `연결됨${net && net.rttMs > 0 ? ` · ${Math.round(net.rttMs)} ms` : ''}` : status === 'connecting' ? '연결 중' : status === 'error' ? '오류' : '오프라인');

    // 2026-09-08: 튜토리얼 동안에는 매치메이킹을 통째로 감춘다 (혼자 한 바퀴 돌게 한다) — 2026-09-15: 매칭 **탭**째 사라진다
    const hideNet = this.matchHidden;
    const matchBtn = this.tabButtons.get('match');
    if (matchBtn) matchBtn.hidden = hideNet;
    if (hideNet && this.tab === 'match') { this.setTab('planet'); return; }

    if (this.tab === 'match') { this.match.refresh(); this.invite.refresh(); }
    this.refreshTravel();
    this.refreshIntel();
    this.refreshTraining();
  }

  /**
   * 우하단 `시뮬레이션 훈련장` 버튼의 상태 줄 (2026-09-12 이후 동작 그대로 + 2026-09-15 `분대 대기 중`).
   * 솔로 `시작` · 훈련이 돌고 있으면 `합류 (n명 훈련 중)` · 레이드가 돌고 있으면 `임무 진행 중`(잠김) ·
   * **도킹 전 분대**면 `분대 대기 중`(잠김 — 서버가 `not_docked` 로 막는다, 분대 전원이 도킹해야 들어간다).
   */
  private refreshTraining(): void {
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    if (!lobby) { setText(this.trainState, '시작'); this.btnTrain.disabled = false; return; }   // 솔로: `startTraining` 이 네트 없이 연다
    if (!isDockedLobby(lobby)) { setText(this.trainState, '분대 대기 중'); this.btnTrain.disabled = true; return; }
    const mode = net?.missionMode ?? lobby.mode ?? 'raid';
    const training = lobby.started && mode === 'training';
    // 2026-09-15: 안드로이드는 훈련장에 가지 않는다 — 훈련 중 인원은 사람만 센다 (`parts/Crew.trainingCount` 과 같은 규칙)
    const n = lobby.players.filter((p) => !isBotPlayer(p) && p.connected && p.inMission === true).length;
    if (lobby.started && !training) { setText(this.trainState, '임무 진행 중'); this.btnTrain.disabled = true; }
    else if (training) { setText(this.trainState, `합류 (${n}명 훈련 중)`); this.btnTrain.disabled = !(net?.missionInProgress ?? false); }
    else { setText(this.trainState, '시작'); this.btnTrain.disabled = !net; }
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
      this.refresh();
    }).catch(() => { this.busy = false; this.refresh(); this.showMsg('서버에 연결할 수 없습니다', 'danger'); });
  }

  private errorText(code: string, message: string): string {
    switch (code) {
      case 'not_found': return '해당 코드의 함선을 찾을 수 없습니다';
      case 'full': return '함선이 만석입니다';
      case 'started': return '해당 함선은 이미 임무 중입니다';
      case 'not_host': return '분대장만 할 수 있습니다';
      case 'not_ready': return '모든 승무원이 탑승해야 합니다';
      case 'in_lobby': return '이미 함선에 도킹되어 있습니다';
      case 'not_in_lobby': return '도킹된 함선이 없습니다';
      case 'not_started': return '진행 중인 임무가 없습니다';
      case 'not_docked': return '분대가 아직 공유 함선에 도킹하지 않았습니다';
      case 'drifted': return '포기한 임무에는 다시 들어갈 수 없습니다';   // 2026-09-15: 타이틀 레이드 포기 (표류)
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
    b.type = 'button';
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
   * what keeps the same press from opening the inventory. Ignored while the 일시정지 메뉴 is on top.
   * 2026-09-15: 초대 창이 열려 있으면 `초대 중 · n초` 를 흘린다.
   */
  update(dt = 0): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
    if (!this._open) return;
    if (this.ctx.input.wasPressed(Keys.INVENTORY) && !this.ctx.uiBlockers.has(MENU_BLOCKER)) {
      this.ctx.input.consume(Keys.INVENTORY);
      // 2026-09-14: Tab 도 **맨 위 하나**만 닫는다 (터미널 위에 확인 · 초대 · 정보상 화면이 뜬다)
      this.closeTop();
      return;
    }
    if (this.invite.isOpen) this.invite.tick();
    if (this.tab === 'planet') this.holo?.render(dt);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    this.intelMenu.dispose();
    this.invite.dispose();
    this.trainConfirm.dispose();
    this.holo?.dispose(); this.holo = null;
    this.ctx.uiBlockers.delete('hub');
    this.ctx.escape.remove('hub:terminal');
    this.ctx.input.setCursorMode(false, 'hub');
    this.root.remove();
  }
}
