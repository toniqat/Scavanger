import type { GameContext, IntelGimmick, IntelPick, IntelRef, IntelSpec, PlanetId } from '@/shared';
import {
  INTEL_COST_TABLE, INTEL_OPTIONS_IN_ORDER, NAMED_ROGUE_NAME_KO, NAMED_ROGUE_TYPES, PLANET_THREAT_LABELS,
  UI_HOLD_CONFIRM_S, createHoldButtonCap, getPlanet, intelCost, intelEffectText, intelMaxTier, intelPlanetThreat, openHoldAsk, planetLabel,
  resolveIntelEffects,
} from '@/shared';
import { el, randomSeed, setText, toggleClass } from './dom';
import { createIntelMapView, type IntelMapLayout, type IntelMapView } from './IntelMap';
import type { PlanetHologram } from './PlanetHologram';

/* ────────────────────────────────────────────────────────────────────────────
 * The intel broker's screen (2026-09-14, user's decision — `src/meta/README.md` Decisions).
 *
 * The concept is 「buying a planet's intel」, but what it actually does is **pin down that raid's gimmicks**. The
 * screen has two phases:
 *
 *   ① The pick phase — left: the candidate-area map (blurred onto a grid, `IntelMap`), right: 7 gimmick rows
 *      `◀ 0 / N ▶` · a cost per row · the total bottom right (large font) · `취소` / `확정`
 *      (**a `UI_HOLD_CONFIRM_S` hold** — a click or Enter will not do it).
 *   ② The confirmed phase — left: the hologram **locks on** to one coordinate (`PlanetHologram.startLockOn`), right:
 *      the map drawn by the same function + a summary of the gimmicks bought. `지역 재배치` top right is a warning
 *      popup + a hold (everything discarded · no refund).
 *
 * Two things are the contract —
 *  - **No new hologram is built.** It is **borrowed** from the terminal (`IntelMenuHost.borrowHologram`): raising a
 *    second `WebGLRenderer` costs one more context and makes it likelier that `createPlanetHologram` returns null.
 *    The scene's light count **does not change** during the lock-on either (`PlanetHologram` only touches opacity).
 *  - **The map is the same canvas and the same function in the pick phase and the confirmed phase** (CLAUDE.md
 *    「previewing contents must equal opening」) — only the panel it hangs in changes.
 *
 * Not one number is in the code: the cost is `ctx.meta.intel.costOf` (with none, `shared/intel.intelCost` +
 * `INTEL_COST_TABLE`); row names · effect sentences · lock thresholds are `shared/intelDefs`
 * (→ `data/intel_options.csv`).
 *
 * CSS prefix `.his-` (`hub/intel.css`) — moved off `.it-` on 2026-09-17: `ui`'s item cards used that prefix first,
 * so the global rules here were breaking somebody else's card (`hub/intel.css` head comment).
 * Owner: hub/ui. Opened from — the intel panel on the right of `hub/ui/HubMenu.ts`.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface IntelMenuHost {
  /** The ship's 목표 행성 (not the terminal's preview). With null nothing can be bought. */
  planet(): PlanetId | null;
  /** Borrows the terminal's hologram into `host`. null = an environment with no hologram. */
  borrowHologram(host: HTMLElement): PlanetHologram | null;
  /** Gives the borrowed hologram back to the terminal. */
  returnHologram(): void;
  /** The screen closed — the terminal redraws its intel panel. */
  onClosed(): void;
}

const BLOCKER = 'hub:intel';
const GUIDE_OWNER = 'hub.intel';
/** Length of the lock-on cutscene (seconds). Presentation timing, not a balance number (`MSG_TTL`'s kind). */
const LOCK_ON_S = 2.6;

interface Row {
  g: IntelGimmick;
  root: HTMLElement;
  effect: HTMLElement;
  tierVal: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  cost: HTMLElement;
  lock: HTMLElement;
  namedRow: HTMLElement | null;
  namedBtns: Array<{ id: string; btn: HTMLButtonElement }>;
}

function fmtCredits(n: number): string { return `${Math.round(n).toLocaleString('ko-KR')} C`; }

export class IntelMenu {
  readonly root: HTMLElement;
  private _open = false;
  private unsubs: Array<() => void> = [];

  private subEl: HTMLElement;
  private creditsEl: HTMLElement;
  private btnRelocate: HTMLButtonElement;
  private leftPane: HTMLElement;
  private rightPane: HTMLElement;

  /** Right-hand side of the pick phase (gimmick rows · total · confirm). */
  private rowsWrap: HTMLElement;
  private rows: Row[] = [];
  private totalEl: HTMLElement;
  private reasonEl: HTMLElement;
  private btnCancel: HTMLButtonElement;
  private btnConfirm: HTMLButtonElement;
  private holdFill: HTMLElement;

  /** Confirmed phase: the hologram on the left · the map + summary on the right. */
  private holoWrap: HTMLElement;
  private holoHost: HTMLElement;
  private coordEl: HTMLElement;
  private doneWrap: HTMLElement;
  private mapHost: HTMLElement;
  private summaryEl: HTMLElement;
  private doneNote: HTMLElement;

  private mapView: IntelMapView;
  private holo: PlanetHologram | null = null;

  /** The **candidate-area seed** this screen holds. Rolled once on open, changed only by 「지역 재배치」. */
  private seed = randomSeed();
  private tiers = new Map<IntelGimmick, number>();
  private namedId: string = NAMED_ROGUE_TYPES[0];
  private phase: 'pick' | 'locked' = 'pick';
  private lockDone = false;
  private busy = false;
  private layoutCache: IntelMapLayout | null = null;

  private holdTimer = 0;
  private holdStart = 0;

  constructor(private readonly ctx: GameContext, private readonly host: IntelMenuHost) {
    const root = this.root = el('div', { cls: 'menu his-menu fullscreen interactive', parent: ctx.uiRoot });
    root.hidden = true;
    el('div', { cls: 'scan', parent: root });
    const f = el('div', { cls: 'frame', parent: root });

    // ── head ──
    const head = el('div', { cls: 'his-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    el('div', { cls: 'title', text: '정보상 — 레이븐', parent: hl });
    this.subEl = el('div', { cls: 'subtitle', text: '', parent: hl });
    const hr = el('div', { cls: 'his-head-right', parent: head });
    this.creditsEl = el('div', { cls: 'his-credits', text: '', parent: hr });
    this.btnRelocate = this.button(hr, '지역 재배치', () => this.askRelocate(), 'his-relocate');
    this.btnRelocate.hidden = true;
    this.button(hr, '닫기', () => this.close(), 'his-close');

    // ── body, two columns ──
    const body = el('div', { cls: 'his-body', parent: f });
    this.leftPane = el('div', { cls: 'his-pane left', parent: body });
    this.rightPane = el('div', { cls: 'his-pane right', parent: body });

    this.mapView = createIntelMapView();

    // pick phase: the gimmick rows
    this.rowsWrap = el('div', { cls: 'his-rows-wrap' });
    el('div', { cls: 'his-rows-head', text: '고정할 기믹', parent: this.rowsWrap });
    const rows = el('div', { cls: 'his-rows', parent: this.rowsWrap });
    for (const def of INTEL_OPTIONS_IN_ORDER) this.rows.push(this.buildRow(rows, def.id));

    const foot = el('div', { cls: 'his-foot', parent: this.rowsWrap });
    const totalRow = el('div', { cls: 'his-total', parent: foot });
    el('div', { cls: 'his-total-label', text: '총 비용', parent: totalRow });
    this.totalEl = el('div', { cls: 'his-total-val', text: fmtCredits(0), parent: totalRow });
    el('div', { cls: 'his-total-note', text: '여러 줄을 고정할수록 총액이 가파르게 오릅니다', parent: foot });
    this.reasonEl = el('div', { cls: 'his-reason', text: '', parent: foot });
    const actions = el('div', { cls: 'his-actions', parent: foot });
    this.btnCancel = this.button(actions, '취소', () => this.close());
    this.btnConfirm = el('button', { cls: 'ui-btn primary his-confirm', parent: actions });
    this.holdFill = el('div', { cls: 'his-hold-fill', parent: this.btnConfirm });
    // 2026-09-15 2nd pass (user's decision): both `(1초 꾹)` and the 「누르고 있으면 결제합니다」 line are gone —
    // the left-click hold keycap to the left of the label says it instead.
    createHoldButtonCap(this.btnConfirm);
    el('span', { cls: 'his-confirm-label', text: '확정', parent: this.btnConfirm });
    // **Only a hold** confirms — no click handler is attached, so Enter · Space do nothing at all
    this.btnConfirm.addEventListener('pointerdown', (e) => { e.preventDefault(); this.startHold(); });
    window.addEventListener('pointerup', this.onPointerUp, true);
    this.btnConfirm.addEventListener('pointerleave', () => this.stopHold());

    // confirmed phase: hologram left / map + summary right
    this.holoWrap = el('div', { cls: 'his-holo-wrap' });
    el('div', { cls: 'his-eyebrow', text: '지역 락온', parent: this.holoWrap });
    this.holoHost = el('div', { cls: 'his-holo', parent: this.holoWrap });
    this.coordEl = el('div', { cls: 'his-coord', text: '', parent: this.holoWrap });

    this.doneWrap = el('div', { cls: 'his-done' });
    this.mapHost = el('div', { cls: 'his-map-host', parent: this.doneWrap });
    this.summaryEl = el('div', { cls: 'his-summary', parent: this.doneWrap });
    this.doneNote = el('div', { cls: 'his-done-note', text: '', parent: this.doneWrap });

    root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean { return this._open; }

  /* ── open · close ─────────────────────────────────────────────────────────── */

  /**
   * Opens. If the held intel is **this planet's** it opens in the confirmed phase (summary · map · 지역 재배치);
   * otherwise it rolls a new candidate seed and opens in the pick phase.
   */
  open(): void {
    if (this._open) return;
    this._open = true;
    this.root.hidden = false;
    this.ctx.uiBlockers.add(BLOCKER);
    this.ctx.escape.push(BLOCKER, () => this.close());
    this.ctx.input.setCursorMode(true, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: [] });
    this.unsubs.push(
      this.ctx.bus.on('intel:changed', () => this.refresh()),
      // when credits go up (a contract payout · a sale) a locked `확정` has to unlock on the spot
      this.ctx.bus.on('meta:creditsChanged', () => this.refresh()),
      // a squadmate receives the squad leader's purchase through `lobby.intel` (`ctx.net.lobbyIntel`)
      this.ctx.bus.on('net:lobbyUpdated', () => this.refresh()),
    );

    const held = this.heldSpec();
    if (held && held.planet === this.host.planet()) {
      this.seed = held.seed;
      this.tiers.clear();
      for (const p of held.picks) { this.tiers.set(p.g, p.tier); if (p.g === 'named' && p.id) this.namedId = p.id; }
      this.phase = 'locked';
      this.lockDone = true;
    } else {
      this.seed = randomSeed();
      this.tiers.clear();
      this.phase = 'pick';
      this.lockDone = false;
    }
    this.busy = false;
    this.applyLayout();
    this.refresh();
    if (this.phase === 'locked') this.settleLock();
    this.btnCancel.focus();                 // initial focus on the safe side (CLAUDE.md's confirm rule)
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** The terminal's `지역 재배치` — opens the screen and raises the warning popup at once (a 1 s hold confirms · no refund). */
  openRelocate(): void {
    this.open();
    this.askRelocate();
  }

  close(): void {
    if (!this._open) return;
    this._open = false;
    this.stopHold();
    this.root.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.holo?.clearLockOn();
    this.holo = null;
    this.host.returnHologram();
    this.ctx.uiBlockers.delete(BLOCKER);
    this.ctx.escape.remove(BLOCKER);
    this.ctx.input.setCursorMode(false, BLOCKER);
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null });
    this.host.onClosed();
  }

  /* ── state → DOM ─────────────────────────────────────────────────────────── */

  private intel(): IntelRef | null { return this.ctx.meta?.intel ?? null; }

  /**
   * The 「held intel」 to show on screen. For the squad leader · a solo player it is their own profile
   * (`intel.get()`); **for a squadmate it is the squad leader's** (`ctx.net.lobbyIntel`) — `Intel.get()` reads the
   * local profile only, so it is always null for a non-host, and the lobby sync (`meta/parts/Intel.syncLobby`) pushes
   * it from the host side only. `IntelWire` carries no planet, so the lobby's 목표 행성 is attached to it (that intel
   * is by definition that planet's).
   */
  private heldSpec(): IntelSpec | null {
    const own = this.intel()?.get() ?? null;
    if (own) return own;
    const wire = this.ctx.net?.lobbyIntel ?? null;
    const planet = this.planet();
    if (!wire || !planet || !Array.isArray(wire.picks) || !wire.picks.length) return null;
    return { planet, seed: wire.seed, picks: wire.picks };
  }

  private planet(): PlanetId | null { return this.host.planet(); }

  private threat(): number { return intelPlanetThreat(this.planet()); }

  private maxTier(g: IntelGimmick): number {
    const p = this.planet();
    if (!p) return 0;
    return this.intel()?.maxTierOf(g, p) ?? intelMaxTier(g, p);
  }

  /**
   * The one-line reason on a locked row — **it also names the planet the row was judged against** (2026-09-18, a
   * user's report 「보레아스 IX · 베르단트 III 에서 현상 수배가 잠긴다」).
   *
   * A lock is decided by the **ship's 목표 행성** (`IntelMenuHost.planet()` → `HubSystem.planet`), not by the planet
   * being **paged through** on the terminal. The terminal's ◀ ▶ is only a preview (`HubMenu.refreshTravel`'s
   * 「stepping is a preview」), so with the target still 아켈론 II (threat 1) and 보레아스 IX on screen, opening the
   * intel broker shows `현상 수배` (`minThreat` 2) locked — and the old text printed the threat number only, so it
   * read as if **the planet on screen were the locked one**. The data is right (`data/intel_options.csv`
   * `named.minThreat = 2`, `planets.csv` tundra · mossy `threat = 2` → `intelMaxTier` returns 1).
   *
   * With no target at all the threat is not brought up — that is not a lock but an unset target, and in that state
   * `maxTier` returns 0 for every row, so even a threat-1 row used to read 「위험도 1 이상 행성에서만」.
   *
   * The same day's user decision **blocks `정보 구매` itself while 「the planet on screen ≠ the 목표 행성」**
   * (`HubMenu.refreshIntel`). So by the time this screen is open the judged planet is the target just set, and this
   * line is a **belt-and-braces** one that does not normally show — it appears only on a path where the target can
   * have changed in between, such as checking held intel (`정보 확인`). Both texts say the same thing: the **목표 행성**
   * is what decides.
   */
  private lockText(minThreat: number): string {
    const p = this.planet();
    if (!p) return '목표 행성을 먼저 지정하세요';
    return `위험도 ${minThreat} 이상 행성에서만 — 지금 목표는 ${planetLabel(p)} (위험도 ${this.threat()})`;
  }

  /** The rows picked right now. The order is `INTEL_OPTIONS_IN_ORDER` (= the contract order). */
  private picks(): IntelPick[] {
    const out: IntelPick[] = [];
    for (const def of INTEL_OPTIONS_IN_ORDER) {
      const tier = Math.min(this.tiers.get(def.id) ?? 0, this.maxTier(def.id));
      if (tier <= 0) continue;
      out.push(def.id === 'named' ? { g: def.id, tier, id: this.namedId } : { g: def.id, tier });
    }
    return out;
  }

  private costOf(picks: readonly IntelPick[]): number {
    if (!picks.length) return 0;
    const p = this.planet();
    const ref = this.intel();
    if (ref && p) return ref.costOf(p, picks);
    return intelCost(this.threat(), picks, INTEL_COST_TABLE);
  }

  /** Why it cannot be bought (Korean), null when it can. */
  private blockReason(total: number): string | null {
    if (this.busy) return '처리 중…';
    if (!this.planet()) return '목표 행성을 먼저 지정하세요';
    const net = this.ctx.net;
    if (net?.lobby && !net.isHost) return '분대장만 정보를 살 수 있습니다';
    if (!this.intel()) return '정보상을 사용할 수 없습니다';
    if (!this.picks().length) return '고정할 항목을 하나 이상 고르세요';
    const credits = this.ctx.meta?.credits ?? 0;
    if (credits < total) return `크레딧이 ${fmtCredits(total - credits)} 부족합니다`;
    return null;
  }

  refresh(): void {
    if (!this._open) return;
    const p = this.planet();
    const def = p ? getPlanet(p) : null;
    const threat = this.threat();
    setText(this.subEl, def
      ? `${def.name} · ${PLANET_THREAT_LABELS[threat] ?? ''} · 지역 코드 ${(this.seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
      : '목표 행성이 지정되지 않았습니다');
    setText(this.creditsEl, fmtCredits(this.ctx.meta?.credits ?? 0));

    if (this.phase === 'pick') this.refreshRows();
    else this.refreshDone();
    this.btnRelocate.hidden = this.phase !== 'locked' || !this.lockDone;
  }

  private refreshRows(): void {
    for (const row of this.rows) {
      const def = INTEL_OPTIONS_IN_ORDER.find((d) => d.id === row.g);
      if (!def) continue;
      const max = this.maxTier(row.g);
      const locked = max <= 0;
      toggleClass(row.root, 'is-locked', locked);
      row.lock.hidden = !locked;
      if (locked) setText(row.lock, this.lockText(def.minThreat));
      let tier = this.tiers.get(row.g) ?? 0;
      if (tier > max) { tier = max; this.tiers.set(row.g, tier); }
      toggleClass(row.root, 'is-on', tier > 0);
      row.prev.disabled = locked || tier <= 0;
      row.next.disabled = locked || tier >= max;
      setText(row.tierVal, locked ? '—' : `${tier} / ${max}`);
      setText(row.effect, intelEffectText(row.g, Math.max(1, tier)));
      toggleClass(row.effect, 'is-off', tier <= 0);
      const cost = tier > 0 ? this.costOf([row.g === 'named' ? { g: row.g, tier, id: this.namedId } : { g: row.g, tier }]) : 0;
      setText(row.cost, tier > 0 ? fmtCredits(cost) : '—');
      toggleClass(row.cost, 'is-off', tier <= 0);
      if (row.namedRow) {
        row.namedRow.hidden = locked || tier <= 0;
        for (const nb of row.namedBtns) toggleClass(nb.btn, 'on', nb.id === this.namedId);
      }
    }
    const total = this.costOf(this.picks());
    setText(this.totalEl, fmtCredits(total));
    const reason = this.blockReason(total);
    // 2026-09-15 2nd pass (user's decision): this line says **only the blocking reason** — with none it disappears.
    setText(this.reasonEl, reason ?? '');
    this.reasonEl.hidden = !reason;
    toggleClass(this.reasonEl, 'bad', !!reason);
    this.btnConfirm.disabled = !!reason;
    if (reason) this.stopHold();
  }

  private refreshDone(): void {
    const spec = this.heldSpec();
    this.summaryEl.replaceChildren();
    if (!this.lockDone) {
      el('div', { cls: 'his-sum-wait', text: '지역 좌표 확보 중…', parent: this.summaryEl });
      this.mapHost.hidden = true;
      setText(this.doneNote, '');
      return;
    }
    this.mapHost.hidden = false;
    const picks = spec?.picks ?? this.picks();
    for (const p of picks) {
      const def = INTEL_OPTIONS_IN_ORDER.find((d) => d.id === p.g);
      if (!def) continue;
      const line = el('div', { cls: 'his-sum-row', parent: this.summaryEl });
      el('div', { cls: 'his-sum-label', text: def.label, parent: line });
      const txt = p.g === 'named' && p.id
        ? `${intelEffectText(p.g, p.tier)} — ${NAMED_ROGUE_NAME_KO[p.id as keyof typeof NAMED_ROGUE_NAME_KO] ?? p.id}`
        : intelEffectText(p.g, p.tier);
      el('div', { cls: 'his-sum-effect', text: txt, parent: line });
    }
    if (!picks.length) el('div', { cls: 'his-sum-wait', text: '보유한 정보가 없습니다', parent: this.summaryEl });
    setText(this.doneNote, '이 정보는 해당 행성으로 출격해 레이드가 끝나면 소모됩니다.');
    setText(this.coordEl, this.coordText());
  }

  /* ── phase layout ─────────────────────────────────────────────────────────── */

  private applyLayout(): void {
    if (this.phase === 'pick') {
      this.holoWrap.remove();
      this.doneWrap.remove();
      this.holo?.clearLockOn();
      this.holo = null;
      this.host.returnHologram();
      this.mapView.mount(this.leftPane);
      if (this.rowsWrap.parentElement !== this.rightPane) this.rightPane.appendChild(this.rowsWrap);
    } else {
      this.rowsWrap.remove();
      if (this.holoWrap.parentElement !== this.leftPane) this.leftPane.appendChild(this.holoWrap);
      if (this.doneWrap.parentElement !== this.rightPane) this.rightPane.appendChild(this.doneWrap);
      this.mapView.mount(this.mapHost);
      this.holo = this.host.borrowHologram(this.holoHost);
    }
    this.refreshMap();
  }

  /** Fetches the candidate-area layout again and draws the map. */
  private refreshMap(): void {
    this.layoutCache = this.resolveLayout();
    this.mapView.setLayout(this.layoutCache);
  }

  /**
   * The map preview is **one line, `ctx.world.previewLayout(seed, planet, intel)`** (the contract is in
   * `shared/types`). That function goes through the same code as real generation, so the preview cannot differ from
   * the real map. The gimmicks bought are handed over through `resolveIntelEffects` — it reflects the current picks
   * while picking too, so 「how a pinned row looks on the map」 is seen before buying.
   *
   * It is called from the ship, so a client may not have `previewLayout` yet (an older bundle) — then only the grid
   * is drawn.
   */
  private resolveLayout(): IntelMapLayout | null {
    const planet = this.planet();
    const world = this.ctx.world;
    if (!planet || !world || typeof world.previewLayout !== 'function') return null;
    const picks: readonly IntelPick[] = this.phase === 'locked' ? (this.heldSpec()?.picks ?? this.picks()) : this.picks();
    try {
      return world.previewLayout(this.seed, planet, resolveIntelEffects(picks));
    } catch (e) {
      console.warn('[IntelMenu] previewLayout failed', e);
      return null;                              // a failed preview never blocks the screen
    }
  }

  /* ── buy · lock-on ───────────────────────────────────────────────────────── */

  private confirm(): void {
    if (this.busy) return;
    const picks = this.picks();
    const planet = this.planet();
    const ref = this.intel();
    const total = this.costOf(picks);
    if (this.blockReason(total) || !planet || !ref) return;
    this.busy = true;
    this.refreshRows();
    // `buy` may wait for the server's answer (the credit reason check) — a synchronous return is taken as it is
    const res = ref.buy(planet, this.seed, picks) as IntelSpec | null | PromiseLike<IntelSpec | null>;
    Promise.resolve(res).then((spec) => {
      this.busy = false;
      if (!this._open) return;
      if (!spec) { this.fail('정보를 구매하지 못했습니다'); return; }
      this.startLock();
    }, () => {
      this.busy = false;
      if (this._open) this.fail('정보를 구매하지 못했습니다');
    });
  }

  private fail(text: string): void {
    this.refreshRows();
    this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    this.ctx.bus.emit('ui:notify', { text, kind: 'danger', duration: 4 });
  }

  /** Payment went through — switch phase and set the hologram locking on. */
  private startLock(): void {
    this.phase = 'locked';
    this.lockDone = false;
    this.applyLayout();
    this.refresh();
    const { u, v } = this.lockDir();
    setText(this.coordEl, '좌표 확보 중…');
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    if (!this.holo) { this.settleLock(); return; }
    this.holo.startLockOn(u, v, LOCK_ON_S, () => { if (this._open) this.settleLock(); });
  }

  /** The lock-on finished (or was skipped for want of a hologram) — the map appears in the right-hand panel. */
  private settleLock(): void {
    this.lockDone = true;
    if (this.holo && this.holo.lockProgress <= 0) {
      const { u, v } = this.lockDir();
      this.holo.startLockOn(u, v, 0.4);
    }
    this.refreshMap();
    this.refresh();
  }

  /** The lock-on coordinate the candidate seed yields — one seed is always one spot (the value printed on screen). */
  private lockUV(): { u: number; v: number } {
    const s = this.seed >>> 0;
    return { u: ((s >>> 7) % 9973) / 9973, v: 0.14 + (((s >>> 19) % 7919) / 7919) * 0.72 };
  }

  /**
   * The **direction** to lock the hologram onto. Used as they are, half the displayed coordinates sit on the back
   * or the rim of the sphere and the marker is invisible — they are folded onto the face turned toward the camera
   * (`u ≈ 0`, longitude ±43°). The coordinate that gets printed stays `lockUV`.
   */
  private lockDir(): { u: number; v: number } {
    const { u, v } = this.lockUV();
    return { u: (1 + (u - 0.5) * 0.24) % 1, v: 0.5 + (v - 0.5) * 0.55 };
  }

  private coordText(): string {
    const { u, v } = this.lockUV();
    const lat = (v - 0.5) * 180, lon = (u - 0.5) * 360;
    return `${lat >= 0 ? 'N' : 'S'} ${Math.abs(lat).toFixed(1)}°   ·   ${lon >= 0 ? 'E' : 'W'} ${Math.abs(lon).toFixed(1)}°`;
  }

  /* ── 지역 재배치 (everything discarded · no refund) ───────────────────────── */

  private askRelocate(): void {
    if (this.busy) return;
    const net = this.ctx.net;
    if (net?.lobby && !net.isHost) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: '분대장만 정보를 살 수 있습니다', kind: 'warning', duration: 3 });
      return;
    }
    openHoldAsk(this.ctx, {
      title: '지역 재배치',
      body: '지금 가진 정보를 전부 버리고 새 후보 지역을 찾습니다.\n고정한 기믹도, 지불한 크레딧도 돌아오지 않습니다.\n이전 정보는 되돌릴 수 없습니다.',
      danger: true,
      id: 'intel-relocate',
      buttons: [
        { label: '취소', cancel: true },
        { label: '재배치', kind: 'danger', hold: true, run: () => this.doRelocate() },
      ],
    });
  }

  private doRelocate(): void {
    this.intel()?.discard();
    this.seed = randomSeed();
    this.tiers.clear();
    this.phase = 'pick';
    this.lockDone = false;
    this.applyLayout();
    this.refresh();
    this.btnCancel.focus();
  }

  /* ── hold confirm ─────────────────────────────────────────────────────────── */

  private startHold(): void {
    if (this.btnConfirm.disabled || this.holdTimer) return;
    this.holdStart = performance.now();
    this.holdTimer = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - this.holdStart) / (Math.max(0.05, UI_HOLD_CONFIRM_S) * 1000));
      this.holdFill.style.transform = `scaleX(${t.toFixed(3)})`;
      if (t >= 1) { this.stopHold(); this.confirm(); }
    }, 16);
  }

  private stopHold(): void {
    if (this.holdTimer) { clearInterval(this.holdTimer); this.holdTimer = 0; }
    this.holdFill.style.transform = 'scaleX(0)';
  }

  private onPointerUp = (): void => { this.stopHold(); };

  /* ── DOM helpers ─────────────────────────────────────────────────────────── */

  private buildRow(parent: HTMLElement, g: IntelGimmick): Row {
    const def = INTEL_OPTIONS_IN_ORDER.find((d) => d.id === g);
    const root = el('div', { cls: 'his-row', parent });
    root.dataset.g = g;
    if (def?.note) root.title = def.note;                     // `note` is the hover tooltip (design doc §4.2)
    const main = el('div', { cls: 'his-row-main', parent: root });
    el('div', { cls: 'his-row-label', text: def?.label ?? g, parent: main });
    const effect = el('div', { cls: 'his-row-effect', text: '', parent: main });
    const lock = el('div', { cls: 'his-row-lock', text: '', parent: main });
    lock.hidden = true;

    const tier = el('div', { cls: 'his-row-tier', parent: root });
    const prev = this.button(tier, '◀', () => this.step(g, -1), 'his-step');
    const tierVal = el('div', { cls: 'his-tier-val', text: '0 / 1', parent: tier });
    const next = this.button(tier, '▶', () => this.step(g, 1), 'his-step');
    const cost = el('div', { cls: 'his-row-cost', text: '—', parent: root });

    let namedRow: HTMLElement | null = null;
    const namedBtns: Array<{ id: string; btn: HTMLButtonElement }> = [];
    if (g === 'named') {
      namedRow = el('div', { cls: 'his-named', parent: root });
      for (const id of NAMED_ROGUE_TYPES) {
        const btn = this.button(namedRow, NAMED_ROGUE_NAME_KO[id], () => { this.namedId = id; this.refreshRows(); }, 'his-named-btn');
        namedBtns.push({ id, btn });
      }
      namedRow.hidden = true;
    }
    return { g, root, effect, tierVal, prev, next, cost, lock, namedRow, namedBtns };
  }

  private step(g: IntelGimmick, dir: number): void {
    const max = this.maxTier(g);
    if (max <= 0) return;
    const next = Math.max(0, Math.min(max, (this.tiers.get(g) ?? 0) + dir));
    if (next === (this.tiers.get(g) ?? 0)) return;
    this.tiers.set(g, next);
    this.refreshRows();
    this.refreshMap();      // see how a pinned row looks on the map **before buying** (same seed · same function)
  }

  private button(parent: HTMLElement, label: string, onClick: () => void, extraCls = ''): HTMLButtonElement {
    const b = el('button', { cls: `ui-btn ${extraCls}`, text: label, parent });
    b.addEventListener('click', (e) => { e.stopPropagation(); this.ctx.bus.emit('audio:play', { id: 'ui_click' }); onClick(); });
    return b;
  }

  dispose(): void {
    if (this._open) this.close();
    this.stopHold();
    window.removeEventListener('pointerup', this.onPointerUp, true);
    this.mapView.dispose();
    this.root.remove();
  }
}
