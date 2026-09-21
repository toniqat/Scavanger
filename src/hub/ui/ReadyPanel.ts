import type {
  AllyEquip, GameContext, ImplantDef, ImplantId, ItemDef, ItemInstance, KeyGuideEntry, LoadoutSlot, PeerId, PortraitRef,
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
   * true = this member is **in** the launch slot → the cell draws a character. 2026-09-14: since boarding and
   * readying split apart this says 「is in a launch slot」 and no more (local = boarded, remote = `LobbyPlayer.ready`
   * — a remote player's boarding is not on the wire).
   */
  ready: boolean;
  /** 2026-09-14: has the ready confirm (a 1 s `Space` hold) finished. Only the **local cell** differs from `ready`. */
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
   * 2026-09-15 (android squadmates): is this cell a **bot member**. Its gear board comes from
   * `ctx.allies.getLoadout` (falling back to `ANDROID_KIT`) and the right-click loadout popup does not open.
   *
   * 2026-09-16 (user's decision): the portrait is **exactly** a human cell's — `createPortraits`' full body; the path
   * that laid a single face on it (`snapshotAndroidFace`) is gone. The body takes the android look through
   * `PortraitRef.setAndroid`, and the armor worn is `ctx.allies.getLoadout(peerId)?.equip.armor`, not `armorId`
   * (falling back to the base kit `ANDROID_KIT.armor`) — see `armorIdOf`.
   */
  bot?: boolean;
  /** The bot's android bay index (name · face colour). Ignored for a human. */
  bay?: number;
}

/** What the panel needs from `HubSystem` (the ready hold is an input, and inputs belong to the system). */
export interface ReadyPanelHost {
  /** The 1 s `Space` hold finished — ready / un-ready (the launch warning popup is raised inside this). */
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
  name: HTMLElement;
  lv: HTMLElement;
  state: HTMLElement;
  gear: HTMLElement;
  slots: Array<{ root: HTMLElement; icon: HTMLElement; pips: HTMLElement; key: HTMLElement }>;
  value: HTMLElement;
  /** The whole hold row (the `Space` keycap + the gauge) — this is the unit that shows and hides. */
  holdRow: HTMLElement;
  holdKey: HTMLElement;
  hold: HTMLElement;
  holdFill: HTMLElement;
  holdLabel: HTMLElement;
}

/** Bottom-right key guide owner (2026-09-14, 2nd pass). In `ui/hud/KeyGuide`'s `NO_CLOSE_OWNERS` — not a closing screen. */
const GUIDE_OWNER = 'pod';

/**
 * The launch ready panel (Phase 10 · **the 2026-09-14 rework**) — four cells across the middle of the ship screen,
 * shown **only while the local player is in a launch slot**. Each cell is a portrait over its top 55 % and gear over
 * the bottom 45 %.
 *
 * The bodies come from `ctx.player.createPortraits(host, HUB_READY_CELLS)` — **one** canvas with `HUB_READY_CELLS`
 * scissored viewports, owned by `player/` because it needs `SoldierModel`. That code slices the canvas into `n`
 * **equal columns**, so the row must stay `grid-template-columns: repeat(4, 1fr); gap: 0` (see `hub.css`); the
 * canvas host is inset to the cells' top 55 % so the bodies stand in the portrait half only. When `createPortraits`
 * returns null (no second WebGL context) the panel degrades to name-only cells. A member who is not in a launch
 * slot draws **no character** (`setMember(i, null)`).
 *
 * **The gear row (2026-09-14).** Five slots — 주무기 I · II · 가방 · 방탄복 · 전술 임플란트 — plus one line with the
 * summed credit value of what is worn. Mine are the **instances** from `ctx.inventory.getEquipped(slot)`, so the socket
 * pips draw the real attachments; a squadmate's are only `CrewCardWire` def ids, so the pips are outlines of the
 * sockets that weapon **accepts** (`ctx.loot.getWeaponDef(...).sockets`) — the decision was not to grow the wire.
 * `CrewCardWire` has no bag at all, so a squadmate's 가방 slot is `?` (the right-click `CrewLoadoutPanel` is the real
 * answer). A thumbnail carries only `data-item-tip` + `data-def-id` and `ui/hud/ItemTip` draws the card — no new
 * tooltip is built.
 *
 * **Readying (2026-09-14).** Climbing into the pod (E) is no longer readying: once boarded, **`Space` has to be held
 * for `UI_HOLD_CONFIRM_S`** before `net.setReady(true)` goes out, and holding again releases it. The gauge is not the
 * crosshair hold ring but **the bottom of my own card**, and before readying that card pulses with `needs-ready`. The
 * work itself is `parts/Pods.toggleReady`'s (the launch warning popup stands in front of it) — this file only measures
 * the key and draws.
 *
 * **2026-09-14, 2nd pass (user's decision).** A `Space` keycap (`.keycap.kc-hold`) sits left of the gauge, and the
 * controls stand in the **bottom-right key guide** (owner `'pod'` — `E 내리기` · `Space 준비`), not in the bottom
 * centre of the screen (`ui/HubStatus`). That centre line keeps only the state text (`준비 대기 (1/4)`) and the
 * countdown. The one place that raises and drops the key guide is `syncGuide()`, and `setInteractive` · `hide()` ·
 * `dispose()` · `setLaunching()` all pass through it.
 *
 * **2026-09-16 (user's decision) — visible exactly while I am sitting in a slot.** It used to be 「up whenever any
 * cell is `ready`」. With android squadmates a recruited bot cell sits down `ready: true` at once (the relay holds it
 * that way), so the panel covered the middle of the screen while the player just walked the shared ship. Now
 * `boarded` in `sync(cells, boarded)` is **both the visibility and the interactivity condition** — the two never
 * split, so `_visible` implies `_interactive`. The panel still takes only `HUB_READY_BLOCKER` + the software cursor
 * (`setCursorMode` — **never `exitPointerLock`**), and the player is strapped into the pod with no controls then.
 * `HubSystem` ignores that one token at the un-board and pointer-lock gates.
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
  /** Seconds the ready key has been held (0 = not holding). */
  private hold = 0;
  /** The current hold already fired — the key must be released before it can fire again. */
  private holdFired = false;
  /** The signature last pushed to the key guide (`''` = nothing is up). */
  private guideKey = '';
  /** Is the countdown running — pushed by `parts/Pods.tickCountdown` (no un-boarding, no changing readiness). */
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
      const top = el('div', { cls: 'hr-top', parent: head });
      const name = el('span', { cls: 'hr-name', text: '빈 슬롯', parent: top });
      const lv = el('span', { cls: 'hr-lv', text: '', parent: top });
      const state = el('div', { cls: 'hr-state', text: '—', parent: head });
      // ── bottom 45 %: equipment thumbnails + the value total + (local only) the ready hold gauge
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
       * 2026-09-14, 2nd pass: a **hold keycap** stands left of the gauge (`.keycap.kc-hold` — the chevron is drawn
       * in one place, `ui/styles/base.css`). `paintHold` repaints its label from `Keys.JUMP` every time — keys are
       * never cached in module constants, by rule, so the card follows a rebind.
       * 2026-09-15: drawn by the shared `shared/keycap.createKeycap` / `paintKeycap` (the chevron moved inside the
       * keycap's top edge).
       */
      const holdRow = el('div', { cls: 'hr-holdrow', parent: body });
      holdRow.hidden = true;
      const holdKey = createKeycap(Keys.JUMP, { hold: true, parent: holdRow });
      const hold = el('div', { cls: 'hr-hold', parent: holdRow });
      const holdFill = el('i', { cls: 'hr-hold-fill', parent: hold });
      const holdLabel = el('span', { cls: 'hr-hold-label', text: '', parent: hold });
      cell.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.openLoadout(i, cell); });
      this.cells.push({ root: cell, name, lv, state, gear, slots, value, holdRow, holdKey, hold, holdFill, holdLabel });
      this.memberKey.push('');
      this.gearKey.push('');
    }
    this.loadout = new CrewLoadoutPanel(ctx);
    // a rebind has to carry into the key guide and the cards' keycaps (clear the signature so the next `syncGuide` resends)
    this.unsubs.push(ctx.bus.on('input:bindingsChanged', () => { this.guideKey = ''; this.syncGuide(); }));
  }

  get isVisible(): boolean { return this._visible; }
  get isInteractive(): boolean { return this._interactive; }
  /** Debug: the crew-loadout popup. */
  get crewLoadout(): CrewLoadoutPanel { return this.loadout; }
  /** Debug / smoke: 0 … 1 of the ready hold in progress. */
  get holdProgress(): number { return Math.max(0, Math.min(1, this.hold / Math.max(0.01, UI_HOLD_CONFIRM_S))); }

  /**
   * Push the whole row. `boarded` is `HubSystem`'s **「I am sitting in a launch slot right now」** —
   * `parts/Pods.syncPods` computes it as `sys.boardedSlot >= 0 && ctx.phase === 'hub' && !sys.cutscene` and hands it
   * over. By the 2026-09-16 user's decision it is **both the visibility and the interactivity condition** (see the
   * class doc): it used to go up whenever 「somebody is in a slot」, and recruiting an android made a bot cell
   * `ready: true` at once, so the panel stayed up the whole time the player walked the shared ship.
   */
  sync(cells: readonly (ReadyCellInfo | null)[], boarded: boolean): void {
    this.info = cells.slice(0, HUB_READY_CELLS);
    // measure the seated-but-no-cell-of-mine case too (the lobby snapshot does not know me yet) — no empty panel
    const visible = boarded && this.info.some((c) => !!c && c.ready);
    this.setVisible(visible);
    this.setInteractive(visible);
    for (let i = 0; i < this.cells.length; i++) this.paint(i, this.info[i] ?? null);
    if (visible) this.ensurePortraits();
    this.portraits?.setVisible(visible);
    if (this.loadout.isOpen && !this.cellFor(this.loadout.peerId)) this.loadout.close();
    this.syncGuide();
  }

  /**
   * While the countdown runs the bottom-right key guide is dropped — nothing can be un-boarded or re-readied then
   * (`parts/Pods.tickCountdown` pushes this every frame). It comes straight back if the launch is cancelled.
   */
  setLaunching(on: boolean): void {
    if (on === this.launching) return;
    this.launching = on;
    this.syncGuide();
  }

  /**
   * The bottom-right key guide (2026-09-14, 2nd pass, user's decision) — `E 내리기` · `Space 준비` (hold).
   *
   * `슬롯에서 내리기` used to sit in the **bottom centre** of the screen (`ui/HubStatus`). That line now says only the
   * state text and the countdown, and the controls moved to where every other screen in the game keeps them
   * (`ui/hud/KeyGuide`). It goes up **while the panel is `interactive`** = only while I really am sitting in a launch
   * slot (since 2026-09-16 the same value as the panel's visibility — see `sync`). `setInteractive` · `hide()` ·
   * `dispose()` all pass through here (docking · mission start · tearing the ship down included), so nothing is left.
   */
  private syncGuide(): void {
    const info = this._interactive && !this.launching ? this.localCell() : null;
    const key = info ? (info.confirmed ? 'unready' : 'ready') : '';
    // a keycap's text can change on a rebind even with the same signature — that path clears `guideKey` first
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
    // 「your turn now」 — only my own card glows hard, while I sit in a launch slot and have not readied yet
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
     * 2026-09-16 (user's decision): **a bot cell gets the same full-body portrait as a human**. The body takes the
     * android look through `PortraitRef.setAndroid` (`SoldierModel.setAndroidLook` — the cell remembers it, so it
     * survives a rebuilt body), and `armorIdOf` falls back as far as the kit for the armor. That is why `bot` is in
     * the key — a human ↔ android swap in the same slot has to hang the look again even when the armor is identical.
     */
    const bot = !!info?.bot && filled;
    const armorId = filled && info ? this.armorIdOf(info) : null;
    const key = filled && info ? `${info.slot}|${bot ? 'a' : 'h'}|${armorId ?? ''}` : '';
    if (key !== this.memberKey[i]) {
      this.memberKey[i] = key;
      if (this.portraits) {
        if (key === '') this.portraits.setMember(i, null);
        else if (info) {
          this.portraits.setAndroid?.(i, bot);
          this.portraits.setMember(i, { slot: info.slot, armorId });
          this.portraits.setYaw(i, HUB_READY_PORTRAIT_YAW);
        }
      }
    }
    toggleClass(c.root, 'is-bot', bot);
  }

  /**
   * The armor def id this cell's body wears. For a human it is the `armorId` the crew card gave, unchanged.
   *
   * 2026-09-16 (user's decision): an android has to stand there wearing the **base kit's armor**. When the loadout
   * (`ctx.allies.getLoadout`) already exists its instance is the truth (it may have picked something up in the raid);
   * until then it falls back to `ANDROID_KIT.armor` — so a late loadout never draws a bare body.
   */
  private armorIdOf(info: ReadyCellInfo): string | null {
    if (!info.bot) return info.armorId;
    return this.androidEquip(info)?.armor?.defId ?? ANDROID_KIT.armor;
  }

  /* ── the gear row (2026-09-14) ────────────────────────────────────────── */

  /** Draw the five thumbnails + the value-total line. `info` null = empty cell (everything blank). */
  private paintGear(i: number, info: ReadyCellInfo | null): void {
    const c = this.cells[i];
    const views = info ? this.gearOf(info) : null;
    const key = views ? views.map((v) => `${v.defId ?? ''}:${v.unknown ? '?' : ''}${[...v.filled].join('')}`).join('|') : '';
    // Visibility is applied **before** the no-change bail-out: a cell that never held gear has key `''` and `gearKey[i]`
    // starts `''` too, so the bail-out used to fire on the very first paint and leave the five empty `.hr-slot`s and the
    // empty `.hr-value` on screen. Setting `hidden` is idempotent, so doing it every call costs nothing.
    c.gear.hidden = !views;
    c.value.hidden = !views;
    if (key === this.gearKey[i]) return;
    this.gearKey[i] = key;
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
   * An android's gear board (2026-09-15). When `allies/` already knows this raid's loadout its **instances** are
   * used (the socket pips are real too); until then the def ids of the per-raid base kit (`ANDROID_KIT`) are drawn. An
   * android has no 주무기 II and no 전술 임플란트 (user's decision — the base kit is three: primary · armor · bag).
   */
  private androidGearOf(info: ReadyCellInfo): GearView[] {
    const equip = this.androidEquip(info);
    const view = (kind: GearKind, inst: ItemInstance | null, defId: string | null): GearView => this.itemView(kind, inst, defId);
    return [
      view('primary', equip?.primary ?? null, equip ? null : ANDROID_KIT.primary),
      this.blankView('primary2'),
      view('bag', equip?.bag ?? null, equip ? null : ANDROID_KIT.bag),
      view('armor', equip?.armor ?? null, equip ? null : ANDROID_KIT.armor),
      this.blankView('implant'),
    ];
  }

  /**
   * What this android is carrying right now (`ctx.allies.getLoadout`) — the portrait (its armor) and the gear board
   * use **the same answer**. It is null in a build without the contract and at a moment before the body exists; the
   * caller falls back to `ANDROID_KIT` then.
   */
  private androidEquip(info: ReadyCellInfo): Readonly<AllyEquip> | null {
    const allies = this.ctx.allies;
    if (!info.peerId || !allies || typeof allies.getLoadout !== 'function') return null;
    try { return allies.getLoadout(info.peerId)?.equip ?? null; } catch { return null; }
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

  /* ── the ready hold (2026-09-14) ──────────────────────────────────────── */

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
    // 2026-09-15: an android has no socket to ask `crewq loadout` on — the gear board already shows all there is
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
      this.portraits?.setMember(i, null);
      this.paint(i, null);
    }
    this.launching = false;
    this.setInteractive(false);
    this.setVisible(false);
    this.portraits?.setVisible(false);
    this.syncGuide();     // clear it for certain even if `setInteractive` already ran (it may have been false)
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
   * A 1 s `Space` hold → ready / un-ready. The key is read **at use time** through `Keys.JUMP`, so it follows a
   * rebind. Player controls are off while seated in the pod, so this never collides with jumping.
   *
   * ⚠ It is measured **only while no blocker but our own token is up** — chat (`'chat'`) · the messenger · the
   * inventory · the pause menu · the launch warning popup can all want `Space` for themselves, and listing the tokens
   * one by one would miss every new screen.
   */
  private tickHold(dt: number): void {
    const c = this.localCell();
    if (!this._interactive || !c) { this.hold = 0; this.holdFired = false; this.drawHold(); return; }
    const ctx = this.ctx;
    /*
     * `holdFired` is released **only when the key goes up** — when the hold completes and the launch warning popup
     * appears, that popup takes a blocker and `free` turns false; releasing it there too would let the hold refill
     * right after the popup is accepted (with `Space` still held) and switch the readiness it just set back off.
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
    // the cells were painted before the strip existed — replay what they hold (bot cells included, `paint`'s order)
    for (let i = 0; i < this.cells.length; i++) {
      const info = this.info[i] ?? null;
      if (info && info.ready) {
        ref.setAndroid?.(i, !!info.bot);
        ref.setMember(i, { slot: info.slot, armorId: this.armorIdOf(info) });
        ref.setYaw(i, HUB_READY_PORTRAIT_YAW);
      } else ref.setMember(i, null);
    }
  }
}
