import type {
  GameContext, ImplantDef, ImplantId, ItemDef, ItemInstance, KeyGuideEntry, LoadoutSlot, PeerId, PortraitRef,
  SocketSlot, WeaponDef,
} from '@/shared';
import {
  ANDROID_KIT, CATEGORY_ICON, HUB_READY_BLOCKER, HUB_READY_CELLS, HUB_READY_PORTRAIT_YAW, Keys, MENU_BLOCKER,
  NET_SLOT_COLORS_CSS, RARITY_COLORS, SOCKET_SLOTS, UI_HOLD_CONFIRM_S, createKeycap, formatCredits, itemCreditValue, keyLabel,
  paintKeycap,
} from '@/shared';
import { el, setText, toggleClass } from './dom';
import { CrewLoadoutPanel } from './CrewLoadoutPanel';

/** One READY cell's worth of state, assembled by `HubSystem.syncPods()`. */
export interface ReadyCellInfo {
  slot: number;
  /** null while the slot is empty. */
  peerId: PeerId | null;
  name: string;
  /**
   * true = this member is **in** the launch slot → the cell draws a character. 2026-09-14: 탑승과 준비가 갈라지면서
   * 이것은 「발사 슬롯에 있다」 뿐이다 (로컬 = 탑승, 원격 = `LobbyPlayer.ready` — 원격의 탑승은 와이어에 없다).
   */
  ready: boolean;
  /** 2026-09-14: 준비 확정(스페이스 1초 홀드)까지 끝났는가. `ready` 와 갈라지는 것은 **로컬 셀뿐**이다. */
  confirmed: boolean;
  local: boolean;
  connected: boolean;
  /** Short Korean state line (`탑승 · 준비 대기` / `준비 완료` / `연결 끊김` …). */
  state: string;
  /** `ProgressionRef.level` locally, `CrewCardWire.level` for a peer; null when unknown. */
  level: number | null;
  /** Implant equipped **on the ship** (never the wielded one — that is always null in the hub). */
  implant: ImplantId | null;
  /** Equipped armor def id, handed to the portrait so the body wears the right plates. */
  armorId: string | null;
  /**
   * 2026-09-15 (안드로이드 분대원): 이 칸이 **봇 멤버**인가. 몸(`createPortraits`)을 그리지 않고 `snapshotAndroidFace`
   * 한 장을 얹으며, 장비 판은 `ctx.allies.getLoadout` (없으면 `ANDROID_KIT`)에서 오고 우클릭 장비 창은 열리지 않는다.
   */
  bot?: boolean;
  /** 봇의 조종실 슬롯 번호 (이름 · 얼굴 색). 사람이면 무시된다. */
  bay?: number;
}

/** What the panel needs from `HubSystem` (the ready hold is an input, and inputs belong to the system). */
export interface ReadyPanelHost {
  /** 스페이스 1초 홀드가 끝났다 — 준비 / 준비 해제 (출격 경고 팝업은 이 안에서 뜬다). */
  toggleReady(): void;
}

/** One equipment thumbnail in a cell's bottom half. */
type GearKind = 'primary' | 'primary2' | 'bag' | 'armor' | 'implant';
/** The five thumbnails, left → right. The four item ones map 1:1 onto a `LoadoutSlot`. */
const GEAR_ORDER: readonly GearKind[] = ['primary', 'primary2', 'bag', 'armor', 'implant'];
const GEAR_KEY_KO: Readonly<Record<GearKind, string>> = {
  primary: 'I', primary2: 'II', bag: '가방', armor: '방탄복', implant: '임플란트',
};

/** Per-thumbnail render model — everything a cell needs, already resolved from either source. */
interface GearView {
  kind: GearKind;
  /** Item def id (null for an empty slot, for the tactical implant, and for a peer's unknown 가방). */
  defId: string | null;
  /** Glyph + colours; `null` = draw the empty box. */
  icon: string;
  color: string;
  rarity: string;
  name: string;
  /** `true` = we genuinely do not know (a peer's 가방 — `CrewCardWire` carries no bag). Draws `?`. */
  unknown: boolean;
  /** Sockets the weapon accepts, in `SOCKET_SLOTS` order ([] for anything that is not a weapon). */
  sockets: readonly SocketSlot[];
  /** Sockets we know are filled. A peer's attachments are not on the wire, so this is empty for a peer. */
  filled: ReadonlySet<SocketSlot>;
  /** true when `filled` is meaningful (the local player). A peer's pips are outlines only. */
  socketsKnown: boolean;
  /** Credit value of this piece (0 when unknown / not an item). */
  value: number;
}

interface CellDom {
  root: HTMLElement;
  /** 안드로이드 얼굴 한 장 (`snapshotAndroidFace`) — 봇 칸에서만 보인다. */
  face: HTMLImageElement;
  name: HTMLElement;
  lv: HTMLElement;
  state: HTMLElement;
  gear: HTMLElement;
  slots: Array<{ root: HTMLElement; icon: HTMLElement; pips: HTMLElement; key: HTMLElement }>;
  value: HTMLElement;
  /** 홀드 줄 전체 (`Space` 키캡 + 게이지) — 보이고 숨는 단위는 이것이다. */
  holdRow: HTMLElement;
  holdKey: HTMLElement;
  hold: HTMLElement;
  holdFill: HTMLElement;
  holdLabel: HTMLElement;
}

/** 우측 하단 키 가이드 owner (2026-09-14 2차). `ui/hud/KeyGuide` 의 `NO_CLOSE_OWNERS` 에 들어 있다 — 닫는 화면이 아니다. */
const GUIDE_OWNER = 'pod';

/**
 * 발사 준비 패널 (Phase 10 · **2026-09-14 대개편**) — four cells across the middle of the ship screen, shown as soon as
 * **any** launch slot is filled. Each cell is 위 55 % 초상 · 아래 45 % 장비 (`docs/DECISIONS.md` 「2026-09-14 — 정보상」).
 *
 * The bodies come from `ctx.player.createPortraits(host, HUB_READY_CELLS)` — **one** canvas with `HUB_READY_CELLS`
 * scissored viewports, owned by `player/` because it needs `SoldierModel`. That code slices the canvas into `n`
 * **equal columns**, so the row must stay `grid-template-columns: repeat(4, 1fr); gap: 0` (see `hub.css`); the
 * canvas host is inset to the cells' top 55 % so the bodies stand in the portrait half only. When `createPortraits`
 * returns null (no second WebGL context) the panel degrades to name-only cells. A member who is not in a launch
 * slot draws **no character** (`setMember(i, null)`).
 *
 * **장비 줄 (2026-09-14).** 주무기 I · II · 가방 · 방탄복 · 전술 임플란트 다섯 칸 + 착용 장비 가치 합계 한 줄. 내 것은
 * `ctx.inventory.getEquipped(slot)` 의 **인스턴스**라 소켓 핍이 실제 부착물을 그린다; 분대원 것은 `CrewCardWire` 의 def id
 * 뿐이라 그 무기가 **받는** 소켓(`ctx.loot.getWeaponDef(...).sockets`)을 윤곽 핍으로만 그린다 — 와이어를 늘리지 않는다는
 * 결정이다. `CrewCardWire` 에는 가방이 아예 없으므로 분대원의 가방 칸은 `?` 다 (우클릭 `CrewLoadoutPanel` 이 진짜 답이다).
 * 썸네일은 `data-item-tip` + `data-def-id` 만 달고 카드는 `ui/hud/ItemTip` 이 그린다 — 새 툴팁을 만들지 않는다.
 *
 * **준비 (2026-09-14).** 포드에 타는 것(E)은 더 이상 준비가 아니다: 탑승한 뒤 **스페이스를 `UI_HOLD_CONFIRM_S` 동안
 * 꾹** 눌러야 `net.setReady(true)` 가 나가고, 다시 꾹 누르면 풀린다. 게이지는 크로스헤어 홀드 링이 아니라 **내 카드
 * 하단**이고, 준비 전에는 내 카드가 `needs-ready` 로 펄스한다. 실제 동작은 `parts/Pods.toggleReady` 가 한다 (출격 경고
 * 팝업이 그 앞에 선다) — 여기서는 키를 재고 그림만 그린다.
 *
 * **2026-09-14 2차 (사용자 결정).** 게이지 왼쪽에 `Space` 키캡(`.keycap.kc-hold`)이 붙었고, 조작 키는 화면 중앙
 * 하단(`ui/HubStatus`)이 아니라 **우측 하단 키 가이드**(owner `'pod'` — `E 내리기` · `Space 준비`)에 선다.
 * 중앙 하단 줄에는 상태 텍스트(`준비 대기 (1/4)`)와 카운트다운만 남는다. 키 가이드를 올리고 내리는 곳은
 * `syncGuide()` 하나이고, `setInteractive` · `hide()` · `dispose()` · `setLaunching()` 이 전부 그것을 지난다.
 *
 * Interactivity is deliberately narrower than visibility: the panel only takes `HUB_READY_BLOCKER` + the software
 * cursor (`setCursorMode`, **never** `exitPointerLock`) while the **local** player is boarded, i.e. while they are
 * strapped into the pod and have no controls anyway. A remote readying up while we walk the ship shows the panel but
 * must not steal our mouse look. `HubSystem` ignores that one token in its un-board / pointer-lock gates.
 */
export class ReadyPanel {
  readonly root: HTMLElement;
  private readonly portraitHost: HTMLElement;
  private readonly cells: CellDom[] = [];

  private portraits: PortraitRef | null = null;
  /** true once `createPortraits` was tried (null result = unavailable, never retried). */
  private portraitsTried = false;
  private readonly loadout: CrewLoadoutPanel;
  private info: (ReadyCellInfo | null)[] = [];
  private _visible = false;
  private _interactive = false;
  /** Per-cell portrait key so `setMember` only runs on a real change. */
  private memberKey: string[] = [];
  /** Per-cell gear key so the thumbnails are only rebuilt on a real change. */
  private gearKey: string[] = [];
  /** Per-cell android-face key (the accent it was drawn with; `''` = no face). */
  private faceKey: string[] = [];
  /** Seconds the ready key has been held (0 = not holding). */
  private hold = 0;
  /** The current hold already fired — the key must be released before it can fire again. */
  private holdFired = false;
  /** 마지막으로 키 가이드에 올린 서명 (`''` = 아무것도 안 올라가 있다). */
  private guideKey = '';
  /** 카운트다운이 도는 중인가 — `parts/Pods.tickCountdown` 이 밀어 준다 (내릴 수도 준비를 바꿀 수도 없다). */
  private launching = false;
  private readonly unsubs: Array<() => void> = [];

  constructor(private readonly ctx: GameContext, private readonly host: ReadyPanelHost) {
    this.root = el('div', { cls: 'hub-ready', parent: ctx.uiRoot });
    this.root.hidden = true;
    this.portraitHost = el('div', { cls: 'hr-portraits', parent: this.root });
    const row = el('div', { cls: 'hr-row', parent: this.root });
    for (let i = 0; i < HUB_READY_CELLS; i++) {
      const cell = el('div', { cls: 'hr-cell is-empty', parent: row, attrs: { 'data-slot': String(i) } });
      cell.style.setProperty('--sc', NET_SLOT_COLORS_CSS[i % NET_SLOT_COLORS_CSS.length]);
      el('span', { cls: 'hr-edge', parent: cell });
      // ── top 55 %: the portrait shows through; only the name / level / state float over it
      const head = el('div', { cls: 'hr-head', parent: cell });
      // 2026-09-15: 봇 칸의 안드로이드 얼굴 (`player/FaceSnapshot` 의 오프스크린 렌더러 한 장 — 칸마다 캔버스를 만들지 않는다)
      const face = el('img', { cls: 'hr-face', parent: cell }) as HTMLImageElement;
      face.alt = ''; face.draggable = false; face.hidden = true;
      const top = el('div', { cls: 'hr-top', parent: head });
      const name = el('span', { cls: 'hr-name', text: '빈 슬롯', parent: top });
      const lv = el('span', { cls: 'hr-lv', text: '', parent: top });
      const state = el('div', { cls: 'hr-state', text: '—', parent: head });
      // ── bottom 45 %: equipment thumbnails + 가치 합계 + (local only) the ready hold gauge
      const body = el('div', { cls: 'hr-body', parent: cell });
      const gear = el('div', { cls: 'hr-gear', parent: body });
      const slots: CellDom['slots'] = [];
      for (const kind of GEAR_ORDER) {
        const s = el('div', { cls: 'hr-slot is-empty', parent: gear, attrs: { 'data-gear': kind } });
        const icon = el('span', { cls: 'hr-slot-icon', text: '', parent: s });
        const pips = el('div', { cls: 'hr-slot-socks', parent: s });
        const key = el('span', { cls: 'hr-slot-key', text: GEAR_KEY_KO[kind], parent: s });
        slots.push({ root: s, icon, pips, key });
      }
      const value = el('div', { cls: 'hr-value', parent: body });
      /*
       * 2026-09-14 2차: 게이지 왼쪽에 **꾹 누르는 키캡**이 선다 (`.keycap.kc-hold` — chevron 은 `ui/styles/base.css`
       * 한 곳이 그린다). 라벨은 `paintHold` 가 매번 `Keys.JUMP` 로 다시 칠한다 — 키는 모듈 상수로
       * 캐시하지 않는다는 규약이라, 리바인드해도 카드가 따라온다.
       * 2026-09-15: 공용 `shared/keycap.createKeycap` / `paintKeycap` 으로 그린다 (chevron 이 키캡 안 윗변으로 들어갔다).
       */
      const holdRow = el('div', { cls: 'hr-holdrow', parent: body });
      holdRow.hidden = true;
      const holdKey = createKeycap(Keys.JUMP, { hold: true, parent: holdRow });
      const hold = el('div', { cls: 'hr-hold', parent: holdRow });
      const holdFill = el('i', { cls: 'hr-hold-fill', parent: hold });
      const holdLabel = el('span', { cls: 'hr-hold-label', text: '', parent: hold });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.openLoadout(i, cell); });
      this.cells.push({ root: cell, face, name, lv, state, gear, slots, value, holdRow, holdKey, hold, holdFill, holdLabel });
      this.memberKey.push('');
      this.gearKey.push('');
      this.faceKey.push('');
    }
    this.loadout = new CrewLoadoutPanel(ctx);
    // 리바인드하면 키 가이드 · 카드의 키캡이 따라와야 한다 (서명을 비워 다음 `syncGuide` 가 반드시 다시 보낸다)
    this.unsubs.push(ctx.bus.on('input:bindingsChanged', () => { this.guideKey = ''; this.syncGuide(); }));
  }

  get isVisible(): boolean { return this._visible; }
  get isInteractive(): boolean { return this._interactive; }
  /** Debug: the crew-loadout popup. */
  get crewLoadout(): CrewLoadoutPanel { return this.loadout; }
  /** Debug / smoke: 0 … 1 of the ready hold in progress. */
  get holdProgress(): number { return Math.max(0, Math.min(1, this.hold / Math.max(0.01, UI_HOLD_CONFIRM_S))); }

  /**
   * Push the whole row. `interactive` is `HubSystem`'s "the local player is boarded" — see the class doc for why that
   * is narrower than `visible`.
   */
  sync(cells: readonly (ReadyCellInfo | null)[], interactive: boolean): void {
    this.info = cells.slice(0, HUB_READY_CELLS);
    const visible = this.info.some((c) => !!c && c.ready);
    this.setVisible(visible);
    this.setInteractive(visible && interactive);
    for (let i = 0; i < this.cells.length; i++) this.paint(i, this.info[i] ?? null);
    if (visible) this.ensurePortraits();
    this.portraits?.setVisible(visible);
    if (this.loadout.isOpen && !this.cellFor(this.loadout.peerId)) this.loadout.close();
    this.syncGuide();
  }

  /**
   * 카운트다운이 도는 동안에는 우측 하단 키 가이드를 내린다 — 그때는 내릴 수도 준비를 바꿀 수도 없다
   * (`parts/Pods.tickCountdown` 이 매 프레임 밀어 준다). 발사가 취소되면 그대로 돌아온다.
   */
  setLaunching(on: boolean): void {
    if (on === this.launching) return;
    this.launching = on;
    this.syncGuide();
  }

  /**
   * 우측 하단 키 가이드 (2026-09-14 2차, 사용자 결정) — `E 내리기` · `Space 준비`(꾹).
   *
   * 예전에는 `슬롯에서 내리기` 가 화면 **중앙 하단**(`ui/HubStatus`)에 있었다. 그 줄은 이제 상태 텍스트 ·
   * 카운트다운만 말하고, 조작 키는 게임의 다른 모든 화면과 같은 자리(`ui/hud/KeyGuide`)로 모였다.
   * 올리는 조건은 **패널이 `interactive` 일 때** = 내가 실제로 발사 슬롯에 앉아 있을 때뿐이다. `setInteractive` ·
   * `hide()` · `dispose()` 가 모두 여기를 지나므로(도킹 · 임무 시작 · 함선 허물기 포함) 남는 항목이 없다.
   */
  private syncGuide(): void {
    const info = this._interactive && !this.launching ? this.localCell() : null;
    const key = info ? (info.confirmed ? 'unready' : 'ready') : '';
    // 키캡은 서명이 같아도 리바인드로 글자가 바뀔 수 있다 — 그때는 `guideKey` 를 비워 두고 들어온다
    for (const c of this.cells) if (!c.holdRow.hidden) paintKeycap(c.holdKey, Keys.JUMP, { hold: true });
    if (key === this.guideKey) return;
    this.guideKey = key;
    if (!info) { this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys: null }); return; }
    const keys: KeyGuideEntry[] = [
      { key: keyLabel(Keys.INTERACT), label: '내리기' },
      { key: keyLabel(Keys.JUMP), label: info.confirmed ? '준비 해제' : '준비', hold: true },
    ];
    this.ctx.bus.emit('ui:keyGuide', { owner: GUIDE_OWNER, keys });
  }

  private cellFor(peerId: PeerId | null): ReadyCellInfo | null {
    for (const c of this.info) {
      if (!c || !c.ready) continue;
      if (c.peerId === peerId || (peerId === null && c.local)) return c;
    }
    return null;
  }

  private paint(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const filled = !!info && info.ready;
    toggleClass(c.root, 'is-empty', !info);
    toggleClass(c.root, 'is-ready', filled);
    toggleClass(c.root, 'is-confirmed', !!info?.confirmed);
    toggleClass(c.root, 'is-local', !!info?.local);
    toggleClass(c.root, 'is-off', !!info && !info.connected);
    // 「지금 네 차례」 — 발사 슬롯에 앉아 있는데 아직 준비하지 않은 내 카드만 강하게 빛난다
    toggleClass(c.root, 'needs-ready', !!info?.local && filled && !info.confirmed);
    setText(c.name, info ? info.name : '빈 슬롯');
    const lv = info?.level ?? null;
    setText(c.lv, lv === null ? '' : `Lv. ${lv}`);
    c.lv.hidden = lv === null;
    setText(c.state, info ? info.state : '—');
    this.paintGear(i, filled ? info : null);
    this.paintHold(i, info);

    /*
     * Portrait: only a member in the slot gets a body; the key keeps `setMember` off the hot path.
     * 2026-09-15: 봇 칸은 3D 몸 **대신** 안드로이드 얼굴 한 장이다 — `createPortraits` 는 사람 몸(방탄복 · 무기)을 그리는
     * 물건이라 안드로이드 외형 인자가 없다 (리드에게 보고: 칸마다 `android` 플래그가 필요하면 player/ 가 갖는다).
     */
    const bot = !!info?.bot && filled;
    const key = filled && info && !bot ? `${info.slot}|${info.armorId ?? ''}` : '';
    if (key !== this.memberKey[i]) {
      this.memberKey[i] = key;
      if (this.portraits) {
        if (key === '') this.portraits.setMember(i, null);
        else if (info) {
          this.portraits.setMember(i, { slot: info.slot, armorId: info.armorId });
          this.portraits.setYaw(i, HUB_READY_PORTRAIT_YAW);
        }
      }
    }
    toggleClass(c.root, 'is-bot', bot);
    this.paintFace(i, bot ? info : null);
  }

  /** 봇 칸의 안드로이드 얼굴 — 색만 바뀌므로 악센트를 키로 다시 찍지 않는다. */
  private paintFace(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const accent = info ? (NET_SLOT_COLORS_CSS[info.slot % NET_SLOT_COLORS_CSS.length] ?? NET_SLOT_COLORS_CSS[0]) : '';
    if (accent === this.faceKey[i]) return;
    this.faceKey[i] = accent;
    if (!info) { c.face.hidden = true; c.face.removeAttribute('src'); return; }
    let url: string | null = null;
    try { url = this.ctx.player?.snapshotAndroidFace?.({ accent }) ?? null; } catch { url = null; }
    // player/ 가 아직 이 계약을 구현하지 않았거나 두 번째 GL 컨텍스트가 없으면 이름만 남는다
    if (url) { c.face.src = url; c.face.hidden = false; }
    else { c.face.removeAttribute('src'); c.face.hidden = true; }
  }

  /* ── 장비 줄 (2026-09-14) ──────────────────────────────────────────────── */

  /** Draw the five thumbnails + the 가치 합계 line. `info` null = empty cell (everything blank). */
  private paintGear(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const views = info ? this.gearOf(info) : null;
    const key = views ? views.map((v) => `${v.defId ?? ''}:${v.unknown ? '?' : ''}${[...v.filled].join('')}`).join('|') : '';
    if (key === this.gearKey[i]) return;
    this.gearKey[i] = key;
    c.gear.hidden = !views;
    c.value.hidden = !views;
    if (!views) return;
    let total = 0;
    for (let k = 0; k < c.slots.length; k++) {
      const s = c.slots[k];
      const v = views[k];
      total += v.value;
      toggleClass(s.root, 'is-empty', !v.defId && !v.unknown && v.icon === '');
      toggleClass(s.root, 'is-unknown', v.unknown);
      s.root.style.setProperty('--rc', v.rarity);
      s.root.style.setProperty('--ic', v.color);
      setText(s.icon, v.unknown ? '?' : v.icon);
      setText(s.key, GEAR_KEY_KO[v.kind]);
      s.root.title = v.name;
      if (v.defId) { s.root.dataset.itemTip = ''; s.root.dataset.defId = v.defId; }
      else { delete s.root.dataset.itemTip; delete s.root.dataset.defId; }
      s.pips.replaceChildren();
      s.pips.hidden = v.sockets.length === 0;
      toggleClass(s.pips, 'is-unknown', !v.socketsKnown);
      for (const sk of v.sockets) {
        const pip = el('i', { cls: 'hr-pip', parent: s.pips, attrs: { 'data-socket': sk } });
        if (v.socketsKnown && v.filled.has(sk)) pip.classList.add('is-filled');
      }
    }
    setText(c.value, `장비 가치 ${formatCredits(total)}`);
  }

  /** The five thumbnails for one member — local reads live instances, a peer reads its `crew card`. */
  private gearOf(info: ReadyCellInfo): GearView[] {
    if (info.bot) return this.androidGearOf(info);
    const out: GearView[] = [];
    for (const kind of GEAR_ORDER) {
      if (kind === 'implant') { out.push(this.implantView(info.implant)); continue; }
      const slot = kind as LoadoutSlot;
      if (info.local) {
        out.push(this.itemView(kind, this.equipped(slot), null));
      } else {
        const card = this.cardOf(info.peerId);
        // `CrewCardWire` has no 가방 — say so instead of drawing an empty slot (an empty slot is a claim).
        if (kind === 'bag') { out.push({ ...this.blankView(kind), unknown: !!card }); continue; }
        const defId = kind === 'primary' ? (card?.primary ?? null) : (card?.primary2 ?? null);
        out.push(this.itemView(kind, null, defId));
      }
    }
    return out;
  }

  /**
   * 안드로이드의 장비 판 (2026-09-15). allies/ 가 이미 이번 레이드의 소지품을 알고 있으면 그 **인스턴스**를 쓰고
   * (소켓 핍까지 진짜다), 아직 없으면 매 레이드의 기본 킷(`ANDROID_KIT`) def id 를 그린다. 주무기 II 와 전술
   * 임플란트는 안드로이드에게 없다 (사용자 결정 — 기본 킷은 주무기 · 방탄복 · 가방 셋뿐이다).
   */
  private androidGearOf(info: ReadyCellInfo): GearView[] {
    let equip: { primary: ItemInstance | null; armor: ItemInstance | null; bag: ItemInstance | null } | null = null;
    const allies = this.ctx.allies;
    if (info.peerId && allies && typeof allies.getLoadout === 'function') {
      try { equip = allies.getLoadout(info.peerId)?.equip ?? null; } catch { equip = null; }
    }
    const view = (kind: GearKind, inst: ItemInstance | null, defId: string | null): GearView => this.itemView(kind, inst, defId);
    return [
      view('primary', equip?.primary ?? null, equip ? null : ANDROID_KIT.primary),
      this.blankView('primary2'),
      view('bag', equip?.bag ?? null, equip ? null : ANDROID_KIT.bag),
      view('armor', equip?.armor ?? null, equip ? null : ANDROID_KIT.armor),
      this.blankView('implant'),
    ];
  }

  private blankView(kind: GearKind): GearView {
    return {
      kind, defId: null, icon: '', color: 'var(--c-text-faint)', rarity: 'var(--c-border)', name: '없음',
      unknown: false, sockets: [], filled: new Set(), socketsKnown: false, value: 0,
    };
  }

  /**
   * One item thumbnail. `inst` (local) wins over `defId` (a peer's card): the instance is what knows which sockets are
   * actually filled. A weapon always shows its **accepted** sockets as outline pips so the shape reads the same for
   * everyone; only the fill is per-instance.
   */
  private itemView(kind: GearKind, inst: ItemInstance | null, defId: string | null): GearView {
    const id = inst?.defId ?? defId;
    if (!id) return this.blankView(kind);
    const def = this.itemDef(id);
    if (!def) return this.blankView(kind);
    const v = this.blankView(kind);
    v.defId = id;
    v.icon = def.icon || CATEGORY_ICON[def.category] || '?';
    v.color = def.color;
    v.rarity = RARITY_COLORS[def.rarity] ?? RARITY_COLORS.common;
    v.name = def.name;
    v.value = itemCreditValue(def);
    const sockets = this.socketsOf(def);
    if (sockets.length > 0) {
      v.sockets = sockets;
      v.socketsKnown = !!inst;
      if (inst?.sockets) {
        const filled = new Set<SocketSlot>();
        for (const s of sockets) if (inst.sockets[s]) filled.add(s);
        v.filled = filled;
      }
    }
    return v;
  }

  /** The tactical implant is not an item (no def, no credit value) — it keeps the glyph chip it always had. */
  private implantView(id: ImplantId | null): GearView {
    const v = this.blankView('implant');
    const def = this.implantDef(id);
    if (!def) return v;
    v.icon = def.icon || '◈';
    v.color = def.color;
    v.rarity = def.color;
    v.name = def.name;
    return v;
  }

  /** Sockets this weapon def accepts (`WeaponDef.sockets`, undefined = all five). [] for anything else. */
  private socketsOf(def: ItemDef): readonly SocketSlot[] {
    const weaponId = def.weaponId;
    if (!weaponId) return [];
    let wd: WeaponDef | undefined;
    try { wd = this.ctx.loot?.getWeaponDef(weaponId); } catch { wd = undefined; }
    if (!wd || wd.unique) return [];
    const list = wd.sockets;
    return Array.isArray(list) ? SOCKET_SLOTS.filter((s) => list.includes(s)) : SOCKET_SLOTS;
  }

  private itemDef(defId: string): ItemDef | undefined {
    try { return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId); } catch { return undefined; }
  }

  private equipped(slot: LoadoutSlot): ItemInstance | null {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.getEquipped !== 'function') return null;
    try { return inv.getEquipped(slot); } catch { return null; }
  }

  /** A peer's last `crew card` (level / implant / armor / weapon def ids). */
  private cardOf(peerId: PeerId | null): { primary?: string | null; primary2?: string | null; armor: string | null } | null {
    const net = this.ctx.net;
    if (!peerId || !net || typeof net.getCrewCard !== 'function') return null;
    try { return net.getCrewCard(peerId); } catch { return null; }
  }

  /**
   * `ImplantDef` for an id. `IMPLANT_DEFS` lives in `implants/`, not in `shared/`, so the table is read through the
   * `ctx.implants` contract (defs are global — a peer's id resolves the same as our own). Missing ref → no chip.
   */
  private implantDef(id: ImplantId | null): ImplantDef | null {
    if (!id) return null;
    const imp = this.ctx.implants;
    if (!imp || typeof imp.getDef !== 'function') return null;
    try { return imp.getDef(id) ?? null; } catch { return null; }
  }

  /* ── 준비 홀드 (2026-09-14) ────────────────────────────────────────────── */

  /** The gauge lives in the **local** cell only, and only while we are actually sitting in the pod. */
  private paintHold(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const mine = !!info && info.local && info.ready && this._interactive;
    c.holdRow.hidden = !mine;
    if (!mine || !info) return;
    paintKeycap(c.holdKey, Keys.JUMP, { hold: true });
    setText(c.holdLabel, info.confirmed ? '꾹 눌러 준비 해제' : '꾹 눌러 준비');
    toggleClass(c.hold, 'is-confirmed', info.confirmed);
  }

  private openLoadout(i: number, cell: HTMLElement): void {
    if (!this._interactive) return;
    const info = this.info[i] ?? null;
    if (!info || !info.ready) return;
    // 2026-09-15: 안드로이드에게는 `crewq loadout` 을 물어볼 소켓이 없다 — 장비 판이 이미 보여 주는 것이 전부다
    if (info.bot) return;
    this.loadout.toggle({ peerId: info.local ? (this.ctx.net?.localId ?? null) : info.peerId, name: info.name, slot: info.slot, local: info.local }, cell);
  }

  private setVisible(on: boolean): void {
    if (on === this._visible) return;
    this._visible = on;
    this.root.hidden = !on;
    this.ctx.bus.emit('hub:readyPanelToggled', { open: on });
  }

  /** Take / release the blocker token **and** the software cursor together (never `exitPointerLock`). */
  private setInteractive(on: boolean): void {
    if (on === this._interactive) return;
    this._interactive = on;
    toggleClass(this.root, 'interactive', on);
    if (!on) { this.hold = 0; this.holdFired = false; }
    if (on) {
      this.ctx.uiBlockers.add(HUB_READY_BLOCKER);
      this.ctx.input.setCursorMode(true, HUB_READY_BLOCKER);
    } else {
      this.loadout.close();
      this.ctx.uiBlockers.delete(HUB_READY_BLOCKER);
      this.ctx.input.setCursorMode(false, HUB_READY_BLOCKER);
    }
    this.syncGuide();
  }

  /** Esc chain (`HubSystem`): true when the popup was open and is now closed. */
  closePopup(): boolean {
    if (!this.loadout.isOpen) return false;
    this.loadout.close();
    return true;
  }

  /** Hard hide (teardown / docking): drops the token, the cursor and the popup. */
  hide(): void {
    this.info = [];
    for (let i = 0; i < this.cells.length; i++) {
      this.memberKey[i] = '';
      this.gearKey[i] = '';
      // `faceKey` 는 비우지 않는다 — 바로 아래 `paint(i, null)` 이 그것과 달라야 얼굴을 지운다
      this.portraits?.setMember(i, null);
      this.paint(i, null);
    }
    this.launching = false;
    this.setInteractive(false);
    this.setVisible(false);
    this.portraits?.setVisible(false);
    this.syncGuide();     // `setInteractive` 가 이미 지나갔어도(이미 false 였을 수 있다) 확실히 걷는다
  }

  update(dt: number, time: number): void {
    if (!this._visible) return;
    // 2026-09-09 (Tab closes the innermost popup first): while the 분대원 장비 popup is up and the inventory is *not*,
    // Tab closes the popup and is consumed — `HubSystem` runs this before `InventorySystem` polls the key. With the
    // inventory open over the pod, Tab stays the window's (it closes the window; the popup is left alone). Boarding
    // itself is deliberately **not** left on Tab: Tab opens the bag while boarded (Phase 10) and E is the way out.
    if (this.loadout.isOpen && !(this.ctx.inventory?.isOpen ?? false) && !this.ctx.uiBlockers.has(MENU_BLOCKER)
      && this.ctx.input.wasPressed(Keys.INVENTORY)) {
      this.ctx.input.consume(Keys.INVENTORY);
      this.loadout.close();
    }
    this.tickHold(dt);
    this.portraits?.render(dt, time);
  }

  /**
   * 스페이스 1초 홀드 → 준비 / 준비 해제. 키는 **사용 시점에** `Keys.JUMP` 로 읽는다 (리바인드를 따라간다). 포드에 앉아
   * 있는 동안 플레이어 컨트롤은 꺼져 있으므로 점프와 겹치지 않는다.
   *
   * ⚠ 재는 조건은 **우리 토큰 말고는 blocker 가 하나도 없을 때**다 — 채팅(`'chat'`) · 메신저 · 인벤토리 · 일시정지 ·
   * 출격 경고 팝업이 전부 스페이스를 자기 용도로 쓸 수 있고, 토큰을 하나씩 열거하면 새 화면이 생길 때마다 빠진다.
   */
  private tickHold(dt: number): void {
    const c = this.localCell();
    if (!this._interactive || !c) { this.hold = 0; this.holdFired = false; this.drawHold(); return; }
    const ctx = this.ctx;
    /*
     * `holdFired` 는 **키를 뗄 때만** 풀린다 — 홀드가 끝나 출격 경고 팝업이 뜨면 그 팝업이 blocker 를 잡아
     * `free` 가 false 가 되는데, 거기서 같이 풀어 버리면 팝업을 승인한 직후(아직 스페이스를 쥔 채) 홀드가
     * 다시 차올라 방금 켠 준비를 스스로 꺼 버린다.
     */
    if (!ctx.input.isDown(Keys.JUMP)) { this.hold = 0; this.holdFired = false; this.drawHold(); return; }
    let free = !(ctx.inventory?.isOpen ?? false) && !ctx.uiBlockers.has(MENU_BLOCKER);
    if (free) for (const b of ctx.uiBlockers) if (b !== HUB_READY_BLOCKER) { free = false; break; }
    if (!free || this.holdFired) { this.hold = 0; this.drawHold(); return; }
    this.hold += dt;
    if (this.hold >= UI_HOLD_CONFIRM_S) {
      this.holdFired = true;
      this.hold = 0;
      this.drawHold();
      this.host.toggleReady();
      return;
    }
    this.drawHold();
  }

  private localCell(): ReadyCellInfo | null {
    for (const c of this.info) if (c && c.local && c.ready) return c;
    return null;
  }

  private drawHold(): void {
    const p = this.holdProgress;
    for (let i = 0; i < this.cells.length; i++) {
      const info = this.info[i] ?? null;
      if (!info?.local) continue;
      const c = this.cells[i];
      c.holdFill.style.transform = `scaleX(${p.toFixed(3)})`;
      toggleClass(c.hold, 'is-holding', p > 0);
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.launching = false;
    this.setInteractive(false);
    this.syncGuide();
    this.loadout.dispose();
    if (this.portraits) { try { this.portraits.dispose(); } catch { /* ignore */ } this.portraits = null; }
    this.root.remove();
  }

  /** Build the portrait strip once the panel is on screen (it needs a laid-out host to size its canvas). */
  private ensurePortraits(): void {
    if (this.portraits || this.portraitsTried) return;
    this.portraitsTried = true;
    const p = this.ctx.player;
    if (!p || typeof p.createPortraits !== 'function') { toggleClass(this.root, 'no-portraits', true); return; }
    let ref: PortraitRef | null = null;
    try { ref = p.createPortraits(this.portraitHost, HUB_READY_CELLS); } catch (e) { console.warn('[hub] createPortraits failed', e); }
    if (!ref) { toggleClass(this.root, 'no-portraits', true); return; }
    this.portraits = ref;
    toggleClass(this.root, 'no-portraits', false);
    // the cells were painted before the strip existed — replay what they hold
    for (let i = 0; i < this.cells.length; i++) {
      const info = this.info[i] ?? null;
      if (info && info.ready) { ref.setMember(i, { slot: info.slot, armorId: info.armorId }); ref.setYaw(i, HUB_READY_PORTRAIT_YAW); }
      else ref.setMember(i, null);
    }
  }
}
