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
 * 정보상 화면 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 정보상」 — 사용자 결정).
 *
 * 「행성의 정보를 산다」지만 실제로 하는 일은 **그 레이드의 기믹을 고정하는 것**이다. 화면은 두 국면이다:
 *
 *   ① 고르는 국면 — 좌: 후보 지역 지도(격자로 흐릿하게, `IntelMap`), 우: 기믹 7줄 `◀ 0 / N ▶` · 줄마다 비용 ·
 *      우하단 총액(큰 폰트) · `취소` / `확정`(**`UI_HOLD_CONFIRM_S` 홀드** — 클릭 · Enter 로는 안 된다).
 *   ② 확정 국면 — 좌: 홀로그램이 한 좌표에 **락온**(`PlanetHologram.startLockOn`), 우: 같은 그리기 함수로 그린
 *      지도 + 산 기믹 요약. 우상단 `지역 재배치` 는 경고 팝업 + 홀드(전부 폐기 · 환불 없음).
 *
 * 두 가지가 규약이다 —
 *  - **홀로그램을 새로 만들지 않는다.** 터미널에서 **빌려** 온다(`IntelMenuHost.borrowHologram`): 두 번째
 *    `WebGLRenderer` 를 띄우면 컨텍스트가 하나 더 늘고 `createPlanetHologram` 이 null 을 돌려줄 위험이 커진다.
 *    씬의 광원 개수는 락온 연출에서도 **바뀌지 않는다** (`PlanetHologram` 은 opacity 만 만진다).
 *  - **지도는 고르는 국면과 확정 국면이 같은 캔버스 · 같은 함수**다 (CLAUDE.md 「열지 않고 미리 보는 것은 여는
 *    것과 같은 함수여야 한다」) — 패널만 갈아탄다.
 *
 * 수치는 하나도 코드에 없다: 비용 `ctx.meta.intel.costOf`(없으면 `shared/intel.intelCost` + `INTEL_COST_TABLE`),
 * 줄 이름 · 효과 문장 · 잠김 기준은 `shared/intelDefs`(→ `data/intel_options.csv`).
 *
 * CSS 접두사 `.his-` (`hub/intel.css`) — 2026-09-17 에 `.it-` 에서 옮겼다: 그것은 `ui` 의 아이템 카드가
 * 먼저 쓰던 접두사여서 여기 전역 규칙이 남의 카드를 망가뜨리고 있었다 (`hub/intel.css` 머리 주석).
 * Owner: hub/ui. 여는 곳 — `hub/ui/HubMenu.ts` 우측 정보상 패널.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface IntelMenuHost {
  /** 함선의 목표 행성 (터미널의 미리보기가 아니다). null 이면 살 수 없다. */
  planet(): PlanetId | null;
  /** 터미널의 홀로그램을 빌려 `host` 안으로 옮긴다. null = 홀로그램이 없는 환경. */
  borrowHologram(host: HTMLElement): PlanetHologram | null;
  /** 빌린 홀로그램을 터미널로 되돌린다. */
  returnHologram(): void;
  /** 화면이 닫혔다 — 터미널이 정보상 패널을 다시 그린다. */
  onClosed(): void;
}

const BLOCKER = 'hub:intel';
const GUIDE_OWNER = 'hub.intel';
/** 락온 연출 길이(초). 연출 시간이라 밸런스 수치가 아니다 (`MSG_TTL` 과 같은 자리). */
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

  private titleEl: HTMLElement;
  private subEl: HTMLElement;
  private creditsEl: HTMLElement;
  private btnRelocate: HTMLButtonElement;
  private leftPane: HTMLElement;
  private rightPane: HTMLElement;

  /** 고르는 국면의 우측 (기믹 줄 · 총액 · 확정). */
  private rowsWrap: HTMLElement;
  private rows: Row[] = [];
  private totalEl: HTMLElement;
  private reasonEl: HTMLElement;
  private btnCancel: HTMLButtonElement;
  private btnConfirm: HTMLButtonElement;
  private holdFill: HTMLElement;

  /** 확정 국면: 좌측 홀로그램 · 우측 지도 + 요약. */
  private holoWrap: HTMLElement;
  private holoHost: HTMLElement;
  private coordEl: HTMLElement;
  private doneWrap: HTMLElement;
  private mapHost: HTMLElement;
  private summaryEl: HTMLElement;
  private doneNote: HTMLElement;

  private mapView: IntelMapView;
  private holo: PlanetHologram | null = null;

  /** 이 화면이 들고 있는 **후보 지역 시드**. 열 때 한 번 굴리고 「지역 재배치」로만 바뀐다. */
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

    // ── 머리 ──
    const head = el('div', { cls: 'his-head', parent: f });
    const hl = el('div', { cls: 'hl', parent: head });
    this.titleEl = el('div', { cls: 'title', text: '정보상 — 레이븐', parent: hl });
    this.subEl = el('div', { cls: 'subtitle', text: '', parent: hl });
    const hr = el('div', { cls: 'his-head-right', parent: head });
    this.creditsEl = el('div', { cls: 'his-credits', text: '', parent: hr });
    this.btnRelocate = this.button(hr, '지역 재배치', () => this.askRelocate(), 'his-relocate');
    this.btnRelocate.hidden = true;
    this.button(hr, '닫기', () => this.close(), 'his-close');

    // ── 본문 2열 ──
    const body = el('div', { cls: 'his-body', parent: f });
    this.leftPane = el('div', { cls: 'his-pane left', parent: body });
    this.rightPane = el('div', { cls: 'his-pane right', parent: body });

    this.mapView = createIntelMapView();

    // 고르는 국면: 기믹 줄
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
    // 2026-09-15 2차 (사용자 결정): `(1초 꾹)` 도 「누르고 있으면 결제합니다」 줄도 없앴다 — 그 말은 라벨 왼쪽의
    // 좌클릭 홀드 키캡이 한다.
    createHoldButtonCap(this.btnConfirm);
    el('span', { cls: 'his-confirm-label', text: '확정', parent: this.btnConfirm });
    // **홀드만** 확정한다 — click 핸들러를 달지 않으므로 Enter · Space 로는 아무 일도 일어나지 않는다
    this.btnConfirm.addEventListener('pointerdown', (e) => { e.preventDefault(); this.startHold(); });
    window.addEventListener('pointerup', this.onPointerUp, true);
    this.btnConfirm.addEventListener('pointerleave', () => this.stopHold());

    // 확정 국면: 좌 홀로그램 / 우 지도 + 요약
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

  /* ── 열기 · 닫기 ──────────────────────────────────────────────────────────── */

  /**
   * 연다. 보유 정보가 **이 행성의 것**이면 확정 국면(요약 · 지도 · 지역 재배치)으로, 아니면 새 후보 시드를
   * 굴려 고르는 국면으로 연다.
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
      // 크레딧이 늘면(계약 정산 · 판매) 잠겼던 `확정` 이 그 자리에서 풀려야 한다
      this.ctx.bus.on('meta:creditsChanged', () => this.refresh()),
      // 분대원은 분대장의 구매를 `lobby.intel` 로 받는다 (`ctx.net.lobbyIntel`)
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
    this.btnCancel.focus();                 // 최초 포커스는 안전한 쪽 (CLAUDE.md 확인 규약)
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /** 터미널의 `지역 재배치` — 화면을 열고 곧바로 경고 팝업을 띄운다 (E-5: 확인은 1초 홀드 · 환불 없음). */
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

  /* ── 상태 → DOM ──────────────────────────────────────────────────────────── */

  private intel(): IntelRef | null { return this.ctx.meta?.intel ?? null; }

  /**
   * 화면에 보여 줄 「보유 정보」. 분대장 · 솔로는 자기 프로필(`intel.get()`)이고, **분대원은 분대장의 것**
   * (`ctx.net.lobbyIntel`)이다 — `Intel.get()` 은 로컬 프로필만 읽으므로 비호스트에게는 늘 null 이고,
   * 로비 동기화(`meta/parts/Intel.syncLobby`)가 호스트 쪽에서만 밀어 준다. `IntelWire` 에는 행성이 없으니
   * 로비의 목표 행성을 붙인다 (그 정보는 정의상 그 행성의 것이다).
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
   * 잠긴 줄의 사유 한 줄 — **어느 행성으로 판정했는지를 함께 적는다** (2026-09-18, 사용자 보고
   * 「보레아스 IX · 베르단트 III 에서 현상 수배가 잠긴다」).
   *
   * 잠김은 터미널에서 **넘겨 보던 행성**이 아니라 **함선의 목표 행성**(`IntelMenuHost.planet()` →
   * `HubSystem.planet`)으로 갈린다. 터미널의 ◀ ▶ 는 미리보기일 뿐이라(`HubMenu.refreshTravel` 의
   * 「stepping is a preview」), 목표가 아직 아켈론 II(위험도 1)인 채로 보레아스 IX 를 띄워 놓고 정보상을
   * 열면 현상 수배(`minThreat` 2)가 잠긴 채로 뜬다 — 예전 글자는 위험도 숫자만 적어서 **화면에 보이던
   * 행성이 잠긴 것처럼** 읽혔다. 데이터는 맞다 (`data/intel_options.csv` `named.minThreat = 2`,
   * `planets.csv` 의 tundra · mossy `threat = 2` → `intelMaxTier` 는 1 을 돌려준다).
   *
   * 목표가 아예 없으면 위험도 이야기를 꺼내지 않는다 — 그건 잠김이 아니라 미지정이고, 그 상태에서는
   * `maxTier` 가 모든 줄에 0 을 돌려주므로 위험도 1 짜리 줄까지 「위험도 1 이상 행성에서만」이 떴다.
   *
   * 같은 날 사용자 결정으로 **터미널이 「보던 행성 ≠ 목표 행성」이면 `정보 구매` 자체를 막는다**
   * (`HubMenu.refreshIntel`). 그래서 이 화면이 열렸을 때 판정 행성은 방금 지정한 목표와 같고, 이 줄은
   * 평상시에 뜨지 않는 **이중 안전장치**다 — 보유 정보 확인(`정보 확인`)처럼 목표가 그 사이에 바뀔 수 있는
   * 길로 들어왔을 때만 보인다. 두 글자는 같은 말을 한다: 판정 기준은 **목표 행성**이다.
   */
  private lockText(minThreat: number): string {
    const p = this.planet();
    if (!p) return '목표 행성을 먼저 지정하세요';
    return `위험도 ${minThreat} 이상 행성에서만 — 지금 목표는 ${planetLabel(p)} (위험도 ${this.threat()})`;
  }

  /** 지금 고른 줄들. 순서는 `INTEL_OPTIONS_IN_ORDER` (= 계약 순서). */
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

  /** 살 수 없는 이유 (한국어), 살 수 있으면 null. */
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
    // 2026-09-15 2차 (사용자 결정): 이 줄은 **막힌 사유**만 말한다 — 사유가 없으면 줄 자체가 사라진다.
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

  /* ── 국면 배치 ────────────────────────────────────────────────────────────── */

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

  /** 후보 지역 레이아웃을 다시 받아 지도를 그린다. */
  private refreshMap(): void {
    this.layoutCache = this.resolveLayout();
    this.mapView.setLayout(this.layoutCache);
  }

  /**
   * 지도 미리보기 = **`ctx.world.previewLayout(seed, planet, intel)` 한 줄**(계약은 `shared/types`). 그 함수는 실제
   * 생성과 같은 코드를 지나므로 미리보기가 진짜 맵과 어긋날 수 없다. 산 기믹은 `resolveIntelEffects` 로 넘긴다 —
   * 고르는 중에도 지금 고른 것을 반영하므로 「고정한 줄이 지도에 어떻게 보이나」를 사기 전에 본다.
   *
   * 함선에서 부르므로 `previewLayout` 이 아직 없는 클라이언트(옛 번들)도 있을 수 있다 — 그러면 격자만 그린다.
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
      return null;                              // 미리보기 실패는 화면을 막지 않는다
    }
  }

  /* ── 구매 · 락온 ─────────────────────────────────────────────────────────── */

  private confirm(): void {
    if (this.busy) return;
    const picks = this.picks();
    const planet = this.planet();
    const ref = this.intel();
    const total = this.costOf(picks);
    if (this.blockReason(total) || !planet || !ref) return;
    this.busy = true;
    this.refreshRows();
    // `buy` 는 서버 답을 기다릴 수 있다 (크레딧 사유 검증) — 동기 반환도 그대로 받는다
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

  /** 결제가 끝났다 — 국면을 바꾸고 홀로그램을 물린다. */
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

  /** 락온이 끝났다 (또는 홀로그램이 없어 건너뛴다) — 우측 패널에 지도가 뜬다. */
  private settleLock(): void {
    this.lockDone = true;
    if (this.holo && this.holo.lockProgress <= 0) {
      const { u, v } = this.lockDir();
      this.holo.startLockOn(u, v, 0.4);
    }
    this.refreshMap();
    this.refresh();
  }

  /** 후보 시드에서 나오는 락온 좌표 — 같은 시드면 늘 같은 자리다 (화면에 적는 값). */
  private lockUV(): { u: number; v: number } {
    const s = this.seed >>> 0;
    return { u: ((s >>> 7) % 9973) / 9973, v: 0.14 + (((s >>> 19) % 7919) / 7919) * 0.72 };
  }

  /**
   * 홀로그램에 물릴 **방향**. 표시 좌표를 그대로 쓰면 절반은 구의 뒤쪽 · 가장자리라 표식이 안 보인다 —
   * 카메라를 보는 앞면(`u ≈ 0`, 경도 ±43°)으로 접어 넣는다. 적히는 좌표는 `lockUV` 그대로다.
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

  /* ── 지역 재배치 (전부 폐기 · 환불 없음) ──────────────────────────────────── */

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

  /* ── 홀드 확인 ────────────────────────────────────────────────────────────── */

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

  /* ── DOM 헬퍼 ────────────────────────────────────────────────────────────── */

  private buildRow(parent: HTMLElement, g: IntelGimmick): Row {
    const def = INTEL_OPTIONS_IN_ORDER.find((d) => d.id === g);
    const root = el('div', { cls: 'his-row', parent });
    root.dataset.g = g;
    if (def?.note) root.title = def.note;                     // `note` 는 호버 툴팁 (설계안 §4.2)
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
    this.refreshMap();      // 고정한 줄이 지도에 어떻게 보이는지 **사기 전에** 본다 (같은 시드 · 같은 함수)
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
