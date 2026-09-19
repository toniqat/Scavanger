import type { GameContext, IntelSpec, NetRef, PlanetDef, PlanetId } from '@/shared';
import {
  ENV_COLOR, ENV_DESC_KO, ENV_ICON, ENV_LABEL_KO,
  INTEL_OPTIONS_IN_ORDER, Keys, MENU_BLOCKER, NAMED_ROGUE_NAME_KO, NET_MAX_PLAYERS, PLANET_DEFS, PLANET_IDS,
  PLANET_THREAT_LABELS, getPlanet, humanPlayersOf, intelEffectText, isBotPlayer, isDockedLobby, planetIndex, planetLabel,
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
  /** `시뮬레이션 훈련장` (Phase 7, shared ship): start a training or join the one already running. */
  startTraining(): void;
  /* ── the target planet (Phase 11) ── */
  /** The ship's current target planet (`HubRef.planet`), or null while nothing is picked. */
  planet(): PlanetId | null;
  /**
   * Why `행성 이동` is refused right now (Korean, shown on the disabled button), or null when it is allowed.
   * The rules live in `HubSystem.travelBlockReason` — the menu only renders them.
   */
  travelBlock(planet?: PlanetId): string | null;
  /** Commit the previewed planet: `HubRef.setPlanet` (starts the in-ship window warp; the terminal closes). */
  travelTo(planet: PlanetId): void;
}

/** The terminal's top tabs. */
export type HubMenuTab = 'planet' | 'match';

const MSG_TTL = 4500;

/**
 * Ship terminal (`.menu.hub-menu.fullscreen`) — **full-screen since Phase 11**.
 *
 * **2026-09-15 (squad docking, user's decision — `docs/DECISIONS.md` 「2026-09-15 — 분대 · 도킹 매칭」): two top tabs.**
 * The inventory Tab screen's pill tabs (`nav.scr-tabs > button.scr-tab`, `ui/styles/base.css`) float top-centre of the frame:
 *
 * - **`행성`** (`.hub-pane-planet`): a 3-column grid — empty left column · **the centre planet card** (hologram · name ·
 *   terrain · threat · briefing · `◀ ▶` · `행성 이동`) · the **intel panel** right; the left column is as wide as the
 *   right, so the planet stands dead centre in the frame. `시뮬레이션 훈련장` is not a section but a **button at the
 *   frame's bottom right** (`.hub-train`), and its help line is gone. 2026-09-15 (user's decision): **above** the
 *   footer, not inside it — its own right-aligned row under the content (`.hub-train-row`), a separator below it, and
 *   only `닫기 (E)` left in the footer. It raises a confirm card (`TrainingConfirm`) rather than entering straight
 *   away, and locks as `분대 대기 중` in a squad that has not docked yet.
 * - **`매칭`** (`.hub-pane-match`, `ui/MatchTab`): four square portrait tiles + `비공개 매칭` / `공개 매칭` (or `도킹 해제`).
 *   An empty tile's `초대` opens the invite window (`ui/InviteModal`). The old `📡 매칭` button in the header's top
 *   right and the matchmaking popup (`MatchPanel` — code · invite link · public toggle) are gone. The tutorial gate
 *   `matchmaking` **hides this tab**.
 *
 * The terminal **always opens on the planet tab** — the tutorial's planet-step spotlight (`.hp-travel`) is on that tab,
 * and picking a planet is the main reason this screen is opened at all.
 *
 * Close chain (`closeTop`, shared by E · Tab — Escape closes the same order through the `ctx.escape` stack):
 * the training confirm → the invite window → the intel screen → the terminal. Every child screen uses **its own token**
 * (`hub:trainConfirm` · `hub:invite` · `hub:intel`) — closing one never costs the terminal behind it its `hub` blocker
 * or its cursor.
 *
 * Earlier history (the behaviour is unchanged):
 * - 2026-09-14 (intel): the planet briefing runs wide in the centre, and the intel panel (`.hub-intel`, prefix `.hi-`)
 *   is **entirely read-only for a non-host in multiplayer**. The full-screen form is `ui/IntelMenu`.
 * - Stepping left / right only *previews* — the ship flies when `행성 이동` is pressed (`HubRef.setPlanet`).
 * - 2026-09-12: the simulation room is gone, so the training arena is entered **from the terminal in either ship**.
 * - 2026-09-08: the terminal closes on **E**, not Escape. 2026-09-09: **Tab closes it too** (`Keys.INVENTORY`, polled in
 *   `update()` which `HubSystem` runs before `InventorySystem`, and consumed so the same press cannot open the inventory).
 * - 2026-09-09: `타이틀로` and the bottom-right key guide are gone (the terminal raises no guide itself — its children do).
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
  // the `매칭` tab (2026-09-15)
  private match: MatchTab;
  private invite: InviteModal;
  // the intel broker panel (`정보상`, 2026-09-14)
  private secIntel: HTMLElement;
  private intelBody: HTMLElement;
  private intelActions: HTMLElement;
  private intelNote: HTMLElement;
  private btnIntelBuy: HTMLButtonElement;
  private btnIntelView: HTMLButtonElement;
  private btnIntelMove: HTMLButtonElement;
  private intelMenu: IntelMenu;
  // `시뮬레이션 훈련장` (2026-09-15: a bottom-right button on its own row above the footer + a confirm card)
  private trainRow: HTMLElement;
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
  /** The planet's permanent-environment line (A-13, 2026-09-11). Hidden on a planet that has no environment. */
  private pEnv: HTMLElement;
  private pDots: HTMLElement[] = [];
  private pDotsEl: HTMLElement;
  private btnPrev: HTMLButtonElement;
  private btnNext: HTMLButtonElement;
  private btnTravel: HTMLButtonElement;
  private pCurrent: HTMLElement;
  /** Previewed planet index into `PLANET_IDS` (not the ship's planet until `행성 이동` is pressed). */
  private cursor = 0;
  // footer / message
  private msg: HTMLElement;

  constructor(private readonly ctx: GameContext, private readonly host: HubMenuHost) {
    const root = this.root = el('div', { cls: 'menu hub-menu fullscreen interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = this.frame = el('div', { cls: 'frame', parent: root });

    // ── top tabs (2026-09-15) — the same classes as the inventory Tab screen's pill tabs ──
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

    // ── `행성` tab: empty left column · the planet in the centre · the intel broker on the right ──
    this.panePlanet = el('div', { cls: 'hub-pane hub-pane-planet', parent: f });
    const grid = el('div', { cls: 'hub-grid', parent: this.panePlanet });
    el('div', { cls: 'hub-col left', parent: grid });
    const centre = el('div', { cls: 'hub-col centre', parent: grid });
    const right = el('div', { cls: 'hub-col right', parent: grid });

    // ── `매칭` tab ──
    this.paneMatch = el('div', { cls: 'hub-pane hub-pane-match', parent: f });
    this.paneMatch.hidden = true;
    this.invite = new InviteModal(ctx, () => this.refresh());
    this.match = new MatchTab(ctx, this.paneMatch, {
      connectThen: (action) => this.connectThen(action),
      isBusy: () => this.busy,
      openInvite: () => this.invite.open(),
    });

    // ── the intel broker (right column, 2026-09-14) ──
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

    // ── the target planet (centre column, Phase 11) ──
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

    // ── message + training row + footer (2026-09-15, user's decision): `시뮬레이션 훈련장` stands at the right end of
    //    its own row **above** the footer (`.hub-train-row`), the separator (the footer's top line) below it, and only
    //    `닫기 (E)` left in the footer under that (the two used to share one footer row). The bottom-left corner is
    //    left empty: that is where the ship HUD draws its squad list and name lines over the terminal.
    this.msg = el('div', { cls: 'form-msg', parent: f });
    this.msg.hidden = true;
    this.trainRow = el('div', { cls: 'hub-train-row', parent: f });
    this.btnTrain = el('button', { cls: 'ui-btn primary hub-train', parent: this.trainRow });
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
      // 2026-09-15: the invite window's friends / recent lists and its `초대 중` badge follow the social snapshot
      b.on('social:updated', () => { if (this._open) this.refresh(); }),
      b.on('social:inviteResult', () => { if (this._open) this.refresh(); }),
      // the target planet: a squad-mate's pick (or our own, once the warp arrived) re-syncs the preview
      b.on('hub:planetChanged', ({ planet: p }) => { this.cursor = planetIndex(p); this.syncPlanet(0); this.refresh(); }),
      b.on('hub:travel', () => this.refresh()),
      // the intel broker (2026-09-14): buying · discarding · consuming · a server document load all repaint it
      b.on('intel:changed', () => this.refresh()),
      b.on('meta:creditsChanged', () => { if (this._open) this.refresh(); }),
      b.on('progress:levelUp', () => { if (this._open) this.refresh(); }),
      // 2026-09-08: the `매칭` tab and planet stepping the tutorial hid come back when its step passes or is skipped
      b.on('tutorial:changed', () => { if (this._open) this.refresh(); }),
    );
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean { return this._open; }
  /** The top tab on screen right now (smoke · debug). */
  get activeTab(): HubMenuTab { return this.tab; }

  /* ── top tabs ─────────────────────────────────────────────────────────── */
  /** Change the tab. While the tutorial hides matchmaking it stays on the planet tab. */
  setTab(tab: HubMenuTab, sound = false): void {
    if (tab === 'match' && this.matchHidden) tab = 'planet';
    const changed = tab !== this.tab;
    this.tab = tab;
    for (const [id, b] of this.tabButtons) toggleClass(b, 'is-on', id === tab);
    this.panePlanet.hidden = tab !== 'planet';
    this.paneMatch.hidden = tab !== 'match';
    // 2026-09-17 (user's decision): during the tutorial's `증축 안내` the training button is gone, row and all
    const trainHidden = tab !== 'planet' || (this.ctx.tutorial?.hides('training') ?? false);
    this.btnTrain.hidden = trainHidden;
    this.trainRow.hidden = trainHidden;            // hide the row too, or the `매칭` tab keeps an empty row
    // the hologram is not visible on the `매칭` tab — stop it so the second GL context does not spin for nothing
    this.holo?.setVisible(this._open && tab === 'planet');
    if (changed && sound) this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (tab !== 'match') this.invite.close();
    this.refresh();
  }

  /** Does the tutorial hide the `매칭` tab (always false while it is off). */
  private get matchHidden(): boolean { return this.ctx.tutorial?.hides('matchmaking') ?? false; }

  /* ── the target planet ────────────────────────────────────────────────── */
  /** `←` / `→` and `A` / `D` step the hologram. Bubble phase, so `isolateInput` fields swallow their own keys. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this._open || this.tab !== 'planet') return;
    // 2026-09-14: a screen over this one (intel · confirm · invite) stops planet stepping — the unseen must not move
    if (this.intelMenu.isOpen || this.trainConfirm.isOpen || this.invite.isOpen) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { this.step(-1); e.preventDefault(); }
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') { this.step(1); e.preventDefault(); }
  };

  private def(): PlanetDef { return PLANET_DEFS[this.cursor] ?? PLANET_DEFS[0]; }

  /** Has the tutorial narrowed the planets down to one (always false while it is off). */
  private get planetLocked(): boolean { return this.ctx.tutorial?.hides('planet') ?? false; }

  private step(dir: number): void {
    if (this.planetLocked) return;      // tutorial: only one planet can be picked, so stepping itself is refused
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
   * The planet's permanent-environment line (A-13, 2026-09-11, user's decision — a **soft gate**): with a
   * `PlanetDef.env` it appends `ENV_ICON` + `ENV_LABEL_KO` + `ENV_DESC_KO` under the briefing and turns it the warning
   * colour (`.warn`) when no matching preparation is carried. **It never blocks travel** — the button state is decided
   * by `refreshTravel`, and nothing is locked here. The one judgement is `ctx.progression.hasEnvPrep`; while that
   * folder is missing it reads (duck-typed) as 「no preparation」 and the warning is shown.
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

  /** Button state of `행성 이동`: `현재 목표` / a `travelBlock` reason / enabled. */
  private refreshTravel(): void {
    this.refreshEnv();      // preparations can change while the terminal is open (「사용」 from the bag)
    const d = this.def();
    const here = this.host.planet() === d.id;
    const blocked = this.host.travelBlock();
    this.pCurrent.hidden = !here;
    if (here) { setText(this.btnTravel, '현재 목표'); this.btnTravel.disabled = true; }
    else if (blocked) { setText(this.btnTravel, blocked); this.btnTravel.disabled = true; }
    else { setText(this.btnTravel, `${d.name}(으)로 이동`); this.btnTravel.disabled = false; }
    const lock = !!blocked;
    // 2026-09-08: while the tutorial allows only the first planet the stepping arrows and dots are **hidden** —
    // rather than show another planet and refuse it with "튜토리얼에서는 ~", only the one that can be picked is shown.
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
    // while the tutorial allows only the first planet, open showing that planet (stepping is hidden)
    this.cursor = this.planetLocked ? 0 : planetIndex(this.host.planet());
    this.syncPlanet(0);
    this.setTab('planet');                     // 2026-09-15: always opens on the planet tab (refresh included)
    this.ctx.bus.emit('ui:hubMenuToggled', { open: true });
    this.ctx.bus.emit('hub:terminalToggled', { open: true });
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /**
   * **E closes the topmost one only** (2026-09-14). The training confirm · the invite window · the intel screen can
   * stand over the terminal, so `HubSystem`'s E and this screen's Tab both pass through here — the same order as the
   * Escape stack (`ctx.escape`). True when there was a child to close.
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
    // closing the terminal closes the screens over it too, so no blocker or escape token is left behind
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

    // header — 2026-09-15: with a squad but before the dock this is still the personal ship
    // 2026-09-15 (android squadmates): the crew count is **humans**, and androids are appended separately after it
    const humans = humanPlayersOf(lobby).length;
    const bots = lobby ? lobby.players.length - humans : 0;
    const botLine = bots > 0 ? ` · 안드로이드 ${bots}` : '';
    setText(this.subtitle, docked && lobby ? `공유 함선 · ${humans}/${NET_MAX_PLAYERS} 승무원${botLine}`
      : lobby ? `개인 함선 · 분대 ${humans}/${NET_MAX_PLAYERS}${botLine}` : '개인 함선');
    this.pill.className = `status-pill ${status}`;
    setText(this.pillText, status === 'connected' ? `연결됨${net && net.rttMs > 0 ? ` · ${Math.round(net.rttMs)} ms` : ''}` : status === 'connecting' ? '연결 중' : status === 'error' ? '오류' : '오프라인');

    // 2026-09-08: matchmaking is hidden wholesale during the tutorial (one lap alone) — 2026-09-15: the whole tab goes
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
   * The state line on the bottom-right `시뮬레이션 훈련장` button (behaviour unchanged since 2026-09-12, plus
   * 2026-09-15's `분대 대기 중`). Solo `시작` · a running training `합류 (n명 훈련 중)` · a running raid `임무 진행 중`
   * (locked) · a **squad that has not docked** `분대 대기 중` (locked — the server refuses it with `not_docked`; the
   * whole squad has to dock before anyone can enter).
   */
  private refreshTraining(): void {
    const net = this.ctx.net;
    const lobby = net?.lobby ?? null;
    if (!lobby) { setText(this.trainState, '시작'); this.btnTrain.disabled = false; return; }   // solo: `startTraining` enters without a relay
    if (!isDockedLobby(lobby)) { setText(this.trainState, '분대 대기 중'); this.btnTrain.disabled = true; return; }
    const mode = net?.missionMode ?? lobby.mode ?? 'raid';
    const training = lobby.started && mode === 'training';
    // 2026-09-15: androids do not go to the training arena — the count is humans only (as `parts/Crew.trainingCount`)
    const n = lobby.players.filter((p) => !isBotPlayer(p) && p.connected && p.inMission === true).length;
    if (lobby.started && !training) { setText(this.trainState, '임무 진행 중'); this.btnTrain.disabled = true; }
    else if (training) { setText(this.trainState, `합류 (${n}명 훈련 중)`); this.btnTrain.disabled = !(net?.missionInProgress ?? false); }
    else { setText(this.trainState, '시작'); this.btnTrain.disabled = !net; }
  }

  /* ── the intel broker panel (2026-09-14) ──────────────────────────────── */

  /**
   * With no intel held, one Raven intro line + `정보 구매`; with intel, a summary of the gimmicks bought + that
   * intel's planet + `정보 확인` / `지역 재배치`. When the held intel's planet **differs from the current target
   * planet** it says so in the warning colour (the intel only counts on a launch to that planet). **A non-host in
   * multiplayer is entirely read-only** — the buttons are dimmed and given a reason (user's decision).
   */
  private refreshIntel(): void {
    const ctx = this.ctx;
    const here = this.host.planet();
    const net = ctx.net;
    const readOnly = !!net?.lobby && !net.isHost;
    const available = !!ctx.meta?.intel;
    /*
     * The squad leader and a solo player read their own profile (`intel.get()`), **a squadmate reads the leader's**
     * (`ctx.net.lobbyIntel`) — `Intel.get()` only reads the local profile, so it is always null for a non-host (the
     * host pushes the sync). `IntelWire` carries no planet, so the lobby's target planet is attached to it (that
     * intel is by definition the intel of that planet).
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
    /*
     * 2026-09-18 (user's decision 「보는 행성을 목표로 정해야 정보를 살 수 있게」) —
     * **nothing can be bought for the planet being paged past.**
     *
     * The intel screen (`ui/IntelMenu`) has judged value · price · locks against the **ship's target planet**
     * (`IntelMenuHost.planet()` → `HubSystem.planet`) from the start. This tab's ◀ ▶ is only a preview, however
     * (`refreshTravel`'s 「stepping is a preview」), and this intel pane sits **right beside** that preview. So with
     * the target still 아켈론 II (threat 1) and 보레아스 IX paged up, the screen opened with the `현상 수배` row locked
     * and it read as though the planet on screen was the locked one (user's report — `data/intel_options.csv`'s
     * `named.minThreat = 2` is right, so are `planets.csv`'s tundra · mossy `threat = 2`, and `intelMaxTier`
     * returns 1 on that planet).
     *
     * The fix chosen is **to refuse**: not to move the target when it is pressed (a buy button must not fly the ship
     * while an 「이동」 button stands next to it), and not to let the purchase follow the preview (held intel · the
     * launch · the relay's validation all judge by the target planet, so it would silently go out of step).
     * **Held intel is untouched** — it belongs to the planet it was bought for and `IntelMenu.heldSpec()` already
     * pins that planet, so `정보 확인` and `지역 재배치` are unchanged.
     */
    const looking = this.def();
    const offTarget = !blocked && !spec && here !== looking.id
      ? `지금 목표는 ${planetLabel(here)}입니다 — 목표를 ${looking.name}(으)로 지정해야 그 행성의 정보를 살 수 있습니다`
      : null;
    const buyBlocked = blocked ?? offTarget;
    this.btnIntelBuy.disabled = !!buyBlocked;
    this.btnIntelMove.disabled = !!blocked;       // relocation is the held intel's business — the paged planet is irrelevant
    this.btnIntelView.disabled = !available;      // a non-host can view too (read-only)
    this.intelNote.hidden = !buyBlocked;
    if (buyBlocked) setText(this.intelNote, buyBlocked);
  }

  /** The shared entry for `정보 구매` · `정보 확인` · `지역 재배치` (`relocate` goes straight to the warning popup). */
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
      case 'drifted': return '포기한 임무에는 다시 들어갈 수 없습니다';   // 2026-09-15: the raid was abandoned from the title (`표류`)
      case 'duplicate': return '다른 탭에서 같은 세션이 연결되었습니다';
      case 'no_planet': return '목표 행성을 먼저 지정하세요';
      case 'invalid': return '잘못된 요청입니다';
      /* C-29 / C-59 (2026-09-11): operator console — the server's own text (`kick <id> [사유]`'s reason included) wins. */
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
   * what keeps the same press from opening the inventory. Ignored while the pause menu is on top.
   * 2026-09-15: while the invite window is open, its `초대 중 · n초` is ticked down.
   */
  update(dt = 0): void {
    if (this.msgTimer > 0 && !this.msg.hidden && performance.now() > this.msgTimer) { this.msg.hidden = true; this.msgTimer = 0; }
    if (!this._open) return;
    if (this.ctx.input.wasPressed(Keys.INVENTORY) && !this.ctx.uiBlockers.has(MENU_BLOCKER)) {
      this.ctx.input.consume(Keys.INVENTORY);
      // 2026-09-14: Tab also closes **only the topmost one** (confirm · invite · intel screens stand over this)
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
