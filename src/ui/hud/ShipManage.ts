import type { CraftIngredient, FurnitureDef, FurnitureModelKind, GameContext, ItemDef, RoomPurpose } from '@/shared';
import {
  FACILITY_COLOR, FACILITY_GLYPH, Keys, renderItemCost, ROOM_PURPOSES, ROOM_PURPOSES_ACTIVE, ROOM_PURPOSE_COLOR,
  ROOM_PURPOSE_GLYPH, ROOM_PURPOSE_LABEL_KO, SHIP_ROOM_COUNT,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';

interface RoomRow {
  index: number;
  root: HTMLButtonElement;
  thumbEl: HTMLElement;
  glyphEl: HTMLElement;
  purposeEl: HTMLElement;
  countEl: HTMLElement;
  key: string;
}

interface Card {
  defId: string;
  root: HTMLButtonElement;
}

/** Which list the right-hand panel shows for a room that already has a purpose. */
type FurnTab = 'craft' | 'store';

/** Glyph per procedural furniture model (no asset files — the card thumbnail is a tinted frame + a character). */
const MODEL_GLYPH: Readonly<Record<FurnitureModelKind, string>> = {
  bench_gun: '⚒', bench_gear: '⛭', bench_gadget: '⚙', bench_medical: '✚',
  range_console: '▣', target_lane: '◎', sim_hub: '◈',
  grow_rack: '❀', repair_bench: '⛏', bookshelf: '▤',
  locker: '▤', table: '▭', shelf: '☰', crate: '▨', lamp: '☀', plant: '❦', chair: '⌂', bunk: '▬',
};

/** Purposes offered to an empty room (빈 방 itself is the "clear" action in the header instead). */
const ASSIGNABLE: readonly RoomPurpose[] = ROOM_PURPOSES.filter((p) => p !== 'empty');

/**
 * 시설 관리 screen (`.ship-manage`, Phase 8) — the DOM half of `ctx.housing`'s manage mode (M in the ship). It lives in
 * the **`.hud.housing`** layer so it is never gated by the gameplay / social visibility logic, and is `.interactive`
 * (the layer itself is `pointer-events: none`).
 *
 *   - **Left**: 방 목록 — `SHIP_ROOM_COUNT` rows with the 1-based room number, its `RoomPurpose` label and how many
 *     pieces it holds. Clicking one calls `ctx.housing.setManageRoom(i)`; the active room is highlighted.
 *   - **Right**: a vertical side panel that shows one of two things for the selected room:
 *       · an **empty** room → the 용도 지정 picker: every assignable `RoomPurpose` led by the shared facility
 *         thumbnail and followed by the **materials the 시설 증축 costs** (`ctx.housing.purposeCost` rendered with
 *         `renderItemCost` — the Phase 9 UI pass dropped the prose description in favour of the cost chips), disabled
 *         with the 한국어 reason from `ctx.housing.purposeBlock` when the rules or the materials refuse it.
 *       · a room **with a purpose** → the 가구 목록 behind two tabs (Phase 9 UI pass):
 *           **가구 제작** — every furniture def the room accepts (`getFurnitureFor`), its craft materials as
 *           `.item-chip`s and a 제작 button that calls `ctx.housing.craftFurniture` (this is the only place furniture
 *           is crafted); clicking the row selects it for placement when one is already in storage.
 *           **가구 창고** — what `getStored()` holds: pieces this room accepts first (clickable → `selectFurniture`),
 *           every other stored piece under them, dimmed and disabled with the reason.
 *         A 빈 방으로 button in the header clears the room — through a confirm popup and
 *         `HousingRef.removeRoomFacility`, so every material the facility cost comes back (2026-09-08).
 *
 * Driven by `housing:shipManageChanged` (open / close / room change) and `housing:changed` (storage, purposes,
 * materials); `housing:selectionChanged` only re-marks the active card. Takes no blocker token — housing/ owns the
 * mode and hub/ owns the camera and the placement keys.
 *
 * **Phase 12 (시설 증축 that "did nothing"):** on a fresh ship every purpose is refused by the 발전기 gate
 * (`ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` 1 vs a generator at level 0) while the cost chips read as affordable — the
 * reason only lived in a `title` tooltip on a `disabled` button, and the generator itself could only be raised from
 * the Tab 함선 tab. Now: the picker is headed by a **발전기 row** (`.sm-gen`: level, next-level cost chips,
 * 업그레이드 → the confirm popup → `ctx.housing.upgrade('generator')`) that is highlighted while it is what blocks
 * the purposes; a purpose row stays **clickable** when blocked and prints its 한국어 reason inline (`.sm-block`) —
 * clicking it repeats the reason as a toast; and an allowed purpose opens a centred **modeless confirm popup**
 * (`.sm-confirm`: `정말로 N번 방을 <용도> 시설로 만들겠습니까?` + `renderItemCost` chips of `purposeCost`, 확인 →
 * `setRoomPurpose`, 취소 / Esc → close). Escape is caught in the capture phase and `Input.consume`d, so it closes
 * the popup only — the hub's own Esc (leave 시설 관리) and game/'s pause never see it.
 *
 * **2026-09-08 (튜토리얼은 잠그지 않고 감춘다):** `ctx.tutorial.hides('roomPurpose' | 'furniture', id)` 가 참인
 * 항목은 목록에서 **빠진다** — "튜토리얼에서는 ~" 사유를 단 줄을 남겨 두는 대신, 지금 지을 수 있는 것만
 * 보여 준다 (안내 단계에서는 발전기 행 + 작업실 한 줄). 단계가 넘어가거나 튜토리얼을 건너뛰면
 * `tutorial:changed` 로 목록을 다시 그려 감춰 둔 것이 전부 돌아온다.
 */
export class ShipManage {
  readonly root: HTMLElement;
  private roomsEl: HTMLElement;
  private sideHead: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private tabsEl: HTMLElement;
  private tabBtns = new Map<FurnTab, HTMLButtonElement>();
  private cardsEl: HTMLElement;
  private storeEl: HTMLElement;
  private purposesEl: HTMLElement;
  private emptyEl: HTMLElement;
  private rows: RoomRow[] = [];
  private cards: Card[] = [];
  private cardsKey = '';
  private storeKey = '';
  private purposeKey = '';
  private tab: FurnTab = 'craft';
  private active = false;
  private room: number | null = null;
  private selected: string | null = null;
  private ctx!: GameContext;
  private unsubs: Array<() => void> = [];
  /* Phase 12: confirm popup */
  private confirmEl: HTMLElement;
  private confirmTitle: HTMLElement;
  private confirmBody: HTMLElement;
  private confirmCost: HTMLElement;
  private confirmOk: HTMLButtonElement;
  private confirmAction: (() => void) | null = null;
  private pendingPurpose: RoomPurpose | null = null;

  private onKey = (e: KeyboardEvent): void => {
    if (!this.isConfirmOpen || e.code !== Keys.MENU) return;
    // Capture phase on `window`: `Input`'s bubble listener never records this Escape, so neither the hub (leave
    // 시설 관리) nor game/ (pause) polls it. `consume` covers the case where Input already saw it this frame.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.ctx?.input.consume(Keys.MENU);
    this.closeConfirm();
  };

  constructor(parent: HTMLElement) {
    this.root = el('div', { cls: 'ship-manage', parent });

    const rooms = el('div', { cls: 'sm-rooms interactive', parent: this.root });
    el('div', { cls: 'sm-title', text: '방 목록', parent: rooms });
    this.roomsEl = el('div', { cls: 'sm-room-list', parent: rooms });
    for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
      const b = el('button', { cls: 'sm-room', parent: this.roomsEl });
      const thumbEl = el('div', { cls: 'sm-thumb', parent: b });
      const glyphEl = el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH.empty, parent: thumbEl });
      el('span', { cls: 'n', text: `방 ${i + 1}`, parent: b });
      const purposeEl = el('span', { cls: 'p', text: '—', parent: b });
      const countEl = el('span', { cls: 'c', text: '', parent: b });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickRoom(i); });
      this.rows.push({ index: i, root: b, thumbEl, glyphEl, purposeEl, countEl, key: '' });
    }

    const side = el('div', { cls: 'sm-side interactive', parent: this.root });
    const head = el('div', { cls: 'sm-side-head', parent: side });
    this.sideHead = el('div', { cls: 'sm-bar-head', text: '가구', parent: head });
    this.clearBtn = el('button', { cls: 'sm-clear', text: '빈 방으로', parent: head });
    this.clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.clearRoom(); });
    // 가구 제작 / 가구 창고 tabs (hidden while an empty room shows the 용도 지정 picker)
    this.tabsEl = el('div', { cls: 'sm-tabs', parent: side });
    for (const [id, label] of [['craft', '가구 제작'], ['store', '가구 창고']] as ReadonlyArray<readonly [FurnTab, string]>) {
      const b = el('button', { cls: 'sm-tab', text: label, parent: this.tabsEl });
      b.dataset.tab = id;               // 2026-09-08: 튜토리얼 스포트라이트가 '가구 창고' 탭을 집는 손잡이
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickTab(id); });
      this.tabBtns.set(id, b);
    }
    this.purposesEl = el('div', { cls: 'sm-purposes', parent: side });
    this.purposesEl.hidden = true;
    this.cardsEl = el('div', { cls: 'sm-cards', parent: side });
    this.storeEl = el('div', { cls: 'sm-store', parent: side });
    this.storeEl.hidden = true;
    this.emptyEl = el('div', { cls: 'sm-empty', text: '이 방에 설치할 수 있는 가구가 없습니다', parent: side });
    this.emptyEl.hidden = true;

    // The lists scroll vertically with the wheel; the wheel also cycles the housing selection, so keep it local.
    for (const scroller of [this.cardsEl, this.storeEl, this.purposesEl]) {
      scroller.addEventListener('wheel', (e) => {
        if (scroller.scrollHeight <= scroller.clientHeight) return;
        e.preventDefault(); e.stopPropagation();
        scroller.scrollTop += e.deltaY;
      }, { passive: false });
    }
    /* Phase 12: centred modeless confirm popup (purpose build / 발전기 upgrade). A child of the screen root, so it is
       gated with it; `.interactive` because the `.hud.housing` layer itself is pointer-events: none. */
    this.confirmEl = el('div', { cls: 'sm-confirm interactive', parent: this.root });
    this.confirmEl.hidden = true;
    const card = el('div', { cls: 'sm-confirm-card', parent: this.confirmEl });
    this.confirmTitle = el('div', { cls: 'title', text: '시설 증축', parent: card });
    this.confirmBody = el('div', { cls: 'body', parent: card });
    this.confirmCost = el('div', { cls: 'cost', parent: card });
    const acts = el('div', { cls: 'acts', parent: card });
    const cancel = el('button', { cls: 'ui-btn', text: '취소', parent: acts });
    this.confirmOk = el('button', { cls: 'ui-btn primary', text: '확인', parent: acts });
    cancel.addEventListener('click', (e) => { e.stopPropagation(); this.closeConfirm(true); });
    this.confirmOk.addEventListener('click', (e) => { e.stopPropagation(); this.runConfirm(); });
    // a click on the dimmed backdrop cancels, like the 함선 tab's popups
    this.confirmEl.addEventListener('mousedown', (e) => { if (e.target === this.confirmEl) this.closeConfirm(true); });

    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    window.addEventListener('keydown', this.onKey, true);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:shipManageChanged', ({ active, room }) => this.setActive(active, room)),
      b.on('housing:changed', () => { if (this.active) this.refresh(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.markSelection(defId)),
      b.on('inventory:changed', () => { if (this.active) this.refresh(); }),
      b.on('inventory:stashChanged', () => { if (this.active) this.refresh(); }),
      b.on('game:newMission', () => this.setActive(false, null)),
      b.on('game:abort', () => this.setActive(false, null)),
      // 2026-09-08: 튜토리얼이 단계를 넘기거나 건너뛰어지면 숨겨 뒀던 용도 · 가구가 다시 나타난다
      b.on('tutorial:changed', () => { if (this.active) this.refresh(); }),
    );
  }

  /** Whether the manage screen is showing (debug). */
  get isShowing(): boolean { return this.active; }
  /** Room the screen is editing (debug). */
  get activeRoom(): number | null { return this.room; }
  /** Furniture cards currently rendered in the visible list (debug). */
  get cardCount(): number { return this.cards.length; }
  /** Purpose buttons currently rendered — non-zero only while an empty room is selected (debug). */
  get purposeCount(): number { return this.purposesEl.hidden ? 0 : this.purposesEl.childElementCount; }
  /** Which furniture tab is showing (debug). */
  get furnitureTab(): FurnTab { return this.tab; }
  /** Phase 12: the confirm popup (purpose build or 발전기 upgrade) and the purpose it is asking about (debug). */
  get isConfirmOpen(): boolean { return !this.confirmEl.hidden; }
  get confirmPurpose(): RoomPurpose | null { return this.pendingPurpose; }

  /**
   * 2026-09-08 — 튜토리얼이 막는 항목은 사유를 달아 두지 않고 **아예 그리지 않는다**. 목록에 지금 할 수
   * 있는 것만 남으므로 "왜 안 되지"가 생기지 않는다 (튜토리얼이 꺼져 있으면 언제나 false).
   */
  private tutHides(gate: 'roomPurpose' | 'furniture', id: string): boolean {
    return this.ctx?.tutorial?.hides(gate, id) ?? false;
  }

  /** 목록 캐시 키에 섞는 튜토리얼 단계 — 단계가 바뀌면 숨김 집합도 바뀐다. */
  private get tutKey(): string { return this.ctx?.tutorial?.step ?? '-'; }

  private setActive(active: boolean, room: number | null): void {
    const changed = active !== this.active || room !== this.room;
    this.active = active;
    this.room = active ? room : null;
    toggleClass(this.root, 'show', active);
    if (changed && this.isConfirmOpen) this.closeConfirm();
    if (!active) {
      this.selected = null;
      this.cardsKey = '';
      this.storeKey = '';
      this.purposeKey = '';
      return;
    }
    if (changed) { this.cardsEl.scrollTop = 0; this.storeEl.scrollTop = 0; this.purposesEl.scrollTop = 0; }
    this.refresh();
  }

  private pickRoom(index: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    // housing/ answers with `housing:shipManageChanged {room}` — the highlight follows that, not the click.
    housing.setManageRoom(index);
  }

  private pickTab(tab: FurnTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.cardsEl.scrollTop = 0;
    this.storeEl.scrollTop = 0;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.refreshSide();
  }

  /** A 가구 제작 row: craft one piece into furniture storage (materials come from bag + stash). */
  private craftCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const info = housing.canCraftFurniture(defId);
    if (!info.ok) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      const short = info.missing.map((m) => `${this.itemDef(m.defId)?.name ?? m.defId} ${m.qty}`).join(' · ');
      this.ctx.bus.emit('ui:notify', { text: `재료 부족: ${short}`, kind: 'warning' });
      return;
    }
    if (!housing.craftFurniture(defId)) { this.ctx.bus.emit('audio:play', { id: 'ui_deny' }); return; }
    this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    const def = housing.getFurnitureDef(defId);
    this.ctx.bus.emit('ui:notify', { text: `${def?.name ?? defId} 제작 완료 — 가구 창고에 있습니다`, kind: 'success' });
    this.refresh();
  }

  /** A 가구 창고 row: arm it for placement (housing refuses a def with nothing in storage). */
  private pickCard(defId: string): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    housing.selectFurniture(this.selected === defId ? null : defId);
  }

  /**
   * A 용도 row was pressed. Blocked → the reason (already printed under the row) is repeated as a toast and the row
   * flashes; allowed → the confirm popup. Nothing is built from the row itself any more (Phase 12).
   */
  private pickPurpose(purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const blocked = housing.purposeBlock(room, purpose);
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      const row = this.purposesEl.querySelector<HTMLElement>(`.sm-purpose[data-purpose="${purpose}"]`);
      if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.openConfirm(
      `방 ${room + 1} — ${ROOM_PURPOSE_LABEL_KO[purpose]} 증축`,
      `정말로 ${room + 1}번 방을 ${ROOM_PURPOSE_LABEL_KO[purpose]} 시설로 만들겠습니까? 재료는 가방과 함선 창고에서 함께 빠져나갑니다.`,
      housing.purposeCost(purpose),
      purpose,
      () => this.buildPurpose(room, purpose),
    );
  }

  /** 확인 on a purpose: re-check the rules (materials may have moved while the popup was up), then build. */
  private buildPurpose(room: number, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const blocked = housing.purposeBlock(room, purpose);
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
    } else if (housing.setRoomPurpose(room, purpose)) {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `방 ${room + 1} → ${ROOM_PURPOSE_LABEL_KO[purpose]} 증축 완료`, kind: 'success' });
      this.tab = 'craft';
    } else {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: '증축에 실패했습니다', kind: 'danger' });
    }
    this.refresh();
  }

  /** The 발전기 row's 업그레이드 button: blocked → reason toast, else the confirm popup → `housing.upgrade`. */
  private pickGenerator(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const info = housing.getFacility('generator');
    if (info.blocked || !info.nextCost) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: info.blocked ?? '업그레이드할 수 없습니다', kind: 'warning' });
      return;
    }
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.openConfirm(
      `발전기 Lv.${info.level} → Lv.${info.level + 1}`,
      info.level === 0
        ? '발전기를 가동하겠습니까? 발전기 Lv.1 부터 시설을 증축하고 업그레이드할 수 있습니다. 재료는 가방과 함선 창고에서 함께 빠져나갑니다.'
        : `발전기를 Lv.${info.level + 1} 로 업그레이드하겠습니까? 재료는 가방과 함선 창고에서 함께 빠져나갑니다.`,
      info.nextCost,
      null,
      () => {
        const ok = housing.upgrade('generator');
        this.ctx.bus.emit('audio:play', { id: ok ? 'ui_equip' : 'ui_deny' });
        this.ctx.bus.emit('ui:notify', ok
          ? { text: `발전기 Lv.${housing.getFacility('generator').level}`, kind: 'success' }
          : { text: housing.getFacility('generator').blocked ?? '업그레이드에 실패했습니다', kind: 'warning' });
        this.refresh();
      },
    );
  }

  /* ── Phase 12: confirm popup ─────────────────────────────────────────── */
  private openConfirm(title: string, body: string, cost: readonly CraftIngredient[], purpose: RoomPurpose | null, action: () => void): void {
    setText(this.confirmTitle, title);
    setText(this.confirmBody, body);
    this.confirmCost.replaceChildren();
    if (cost.length) renderItemCost(this.confirmCost, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 34 });
    else el('span', { cls: 'item-chip-free', text: '재료 없음', parent: this.confirmCost });
    this.confirmAction = action;
    this.pendingPurpose = purpose;
    this.confirmEl.hidden = false;
    this.confirmOk.focus({ preventScroll: true });
  }

  private closeConfirm(sound = false): void {
    if (this.confirmEl.hidden) return;
    this.confirmEl.hidden = true;
    this.confirmAction = null;
    this.pendingPurpose = null;
    if (sound) this.ctx?.bus.emit('audio:play', { id: 'ui_close' });
  }

  private runConfirm(): void {
    const action = this.confirmAction;
    this.closeConfirm();
    action?.();
  }

  /**
   * Header 빈 방으로: give the room back. Placed pieces go to the 가구 창고 and **every material the facility ever
   * cost comes back into the 함선 창고**.
   *
   * 2026-09-08: this used to call `setRoomPurpose(room, 'empty')` straight, which is the *free* path housing takes
   * **after** it has already worked out a refund — so clearing a room from here silently burned the 시설 증축 price
   * and the player could not rebuild what they had just torn down by mistake. It goes through
   * `HousingRef.removeRoomFacility` now (the same call the Tab 함선 tab's 🗑 makes), and because the mistake is the
   * whole story it asks first, showing the chips it is about to hand back.
   */
  private clearRoom(): void {
    const housing = this.ctx.housing;
    const room = this.room;
    if (!housing || room === null) return;
    const blocked = housing.purposeBlock(room, 'empty');
    if (blocked) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning' });
      return;
    }
    const purpose = housing.getRoom(room)?.purpose ?? 'empty';
    const placed = housing.getPlaced(room).length;
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
    this.openConfirm(
      `방 ${room + 1} — ${ROOM_PURPOSE_LABEL_KO[purpose]} 제거`,
      `정말로 ${room + 1}번 방을 빈 방으로 되돌리겠습니까?${placed > 0 ? ` 놓인 가구 ${placed}개는 가구 창고로 돌아갑니다.` : ''} 들어간 재료는 전부 함선 창고로 돌려받습니다.`,
      housing.facilityRefund(room),
      null,
      () => this.emptyRoom(room),
    );
  }

  /** 확인 on 빈 방으로: `removeRoomFacility` refunds 100 % into the 함선 창고 (or refuses with a 한국어 reason). */
  private emptyRoom(room: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const reason = housing.removeRoomFacility(room);
    if (reason) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
      this.ctx.bus.emit('ui:notify', { text: reason, kind: 'warning' });
    } else {
      this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
      this.ctx.bus.emit('ui:notify', { text: `방 ${room + 1} — 시설을 제거하고 재료를 함선 창고로 돌려보냈습니다`, kind: 'success' });
    }
    this.refresh();
  }

  /* ── render ──────────────────────────────────────────────────────────── */
  private refresh(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    for (const r of this.rows) {
      const state = housing.getRoom(r.index);
      const purpose = state?.purpose ?? 'empty';
      const count = housing.getPlaced(r.index).length;
      const key = `${purpose}|${count}`;
      if (key !== r.key) {
        r.key = key;
        setText(r.purposeEl, ROOM_PURPOSE_LABEL_KO[purpose]);
        setText(r.countEl, count > 0 ? `${count}개` : '');
        setText(r.glyphEl, ROOM_PURPOSE_GLYPH[purpose]);
        r.thumbEl.style.setProperty('--pc', ROOM_PURPOSE_COLOR[purpose]);
        toggleClass(r.root, 'empty', purpose === 'empty');
      }
      toggleClass(r.root, 'is-on', r.index === this.room);
    }
    this.refreshSide();
  }

  private refreshSide(): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const room = this.room;
    const purpose = room !== null ? (housing.getRoom(room)?.purpose ?? 'empty') : 'empty';
    const assigning = room !== null && purpose === 'empty';

    setText(this.sideHead, room === null
      ? '가구'
      : assigning ? `방 ${room + 1} — 용도 지정` : `가구 · 방 ${room + 1} — ${ROOM_PURPOSE_LABEL_KO[purpose]}`);
    // clearing is only offered on an assigned room the rules allow to go back to 빈 방 (never the built-in 작업실)
    this.clearBtn.hidden = room === null || assigning || !!housing.purposeBlock(room, 'empty');

    this.purposesEl.hidden = !assigning;
    this.tabsEl.hidden = assigning || room === null;
    for (const [id, b] of this.tabBtns) toggleClass(b, 'is-on', id === this.tab);
    if (assigning) {
      this.cardsEl.hidden = true;
      this.storeEl.hidden = true;
      this.emptyEl.hidden = true;
      this.refreshPurposes(room as number);
      return;
    }
    this.cardsEl.hidden = this.tab !== 'craft';
    this.storeEl.hidden = this.tab !== 'store';
    if (this.tab === 'craft') this.refreshCards(room, purpose);
    else this.refreshStore(room, purpose);
  }

  /**
   * Rank of a purpose in the 용도 지정 picker (Phase 9 UI pass): **0** assignable right now, **1** blocked by a
   * prerequisite (materials, the 발전기 gate, 연구실 without an 온실, furniture that must be recovered first),
   * **2** already built somewhere else on the ship. The list is sorted by rank, then by the catalogue order.
   */
  private purposeRank(room: number, p: RoomPurpose, blocked: string | null): 0 | 1 | 2 {
    if (!blocked) return 0;
    const housing = this.ctx.housing;
    if (!housing) return 1;
    for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (i !== room && housing.getRoom(i)?.purpose === p) return 2;
    return 1;
  }

  /**
   * 용도 지정 buttons for an empty room, **sorted 제작 가능 → 제작 불가 → 이미 제작** (`purposeRank`), each led by
   * the shared facility thumbnail (`ROOM_PURPOSE_GLYPH` / `ROOM_PURPOSE_COLOR`) and followed by the **materials the
   * 시설 증축 costs** as `.item-chip`s. The prose description is gone (Phase 9 UI pass); a blocked purpose keeps the
   * 한국어 reason as its title and, when the rules refuse it outright, as a short line under the name.
   */
  private refreshPurposes(room: number): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const entries = ASSIGNABLE.filter((p) => !this.tutHides('roomPurpose', p)).map((p) => {
      const blocked = housing.purposeBlock(room, p);
      return { p, blocked, rank: this.purposeRank(room, p, blocked), cost: housing.purposeCost(p) };
    });
    entries.sort((a, b) => a.rank - b.rank || ASSIGNABLE.indexOf(a.p) - ASSIGNABLE.indexOf(b.p));
    const gen = housing.getFacility('generator');
    // the gate is what stops everything when the generator is the only reason left on an otherwise buildable room
    const gateBlocks = entries.some((e) => !!e.blocked && /발전기/.test(e.blocked));
    const key = `${room}|t${this.tutKey}|g${gen.level}/${gen.maxLevel}|${gen.blocked ?? ''}|${this.costKeyOf(gen.nextCost)}|${gateBlocks ? 1 : 0}|`
      + entries.map((e) => `${e.p}${e.rank}${e.blocked ?? ''}${this.costKeyOf(e.cost)}`).join(',');
    if (key === this.purposeKey) return;
    this.purposeKey = key;
    this.purposesEl.replaceChildren();

    /* Phase 12: the 발전기 row leads the picker — it is the prerequisite of every purpose below. */
    const g = el('div', { cls: `sm-gen${gateBlocks ? ' is-hint' : ''}${gen.blocked && gen.nextCost ? ' is-blocked' : ''}`, parent: this.purposesEl });
    const gthumb = el('div', { cls: 'sm-thumb', parent: g });
    gthumb.style.setProperty('--pc', FACILITY_COLOR.generator);
    el('span', { cls: 'g', text: FACILITY_GLYPH.generator, parent: gthumb });
    const gbody = el('div', { cls: 'bd', parent: g });
    const gline = el('div', { cls: 'ln', parent: gbody });
    el('span', { cls: 'nm', text: '발전기', parent: gline });
    el('span', { cls: 'lv ui-mono', text: `Lv.${gen.level} / ${gen.maxLevel}`, parent: gline });
    if (gen.nextCost) {
      const gcost = el('div', { cls: 'sm-cost', parent: gbody });
      renderItemCost(gcost, gen.nextCost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
    }
    const genNote = gateBlocks
      ? `시설 증축에는 발전기 Lv.1 이 필요합니다 — 먼저 발전기를 가동하세요${gen.blocked && gen.nextCost ? ` (${gen.blocked})` : ''}`
      : gen.blocked && gen.nextCost ? gen.blocked : gen.nextCost ? '' : '최대 레벨';
    if (genNote) el('div', { cls: 'sm-block', text: genNote, parent: gbody });
    const gbtn = el('button', { cls: 'sm-gen-btn', text: gen.nextCost ? (gen.level === 0 ? '가동' : '업그레이드') : '최대', parent: g });
    gbtn.disabled = !gen.nextCost;
    gbtn.title = gen.blocked ?? (gen.level === 0 ? '발전기 가동' : `발전기 Lv.${gen.level + 1}`);
    gbtn.addEventListener('click', (e) => { e.stopPropagation(); this.pickGenerator(); });

    for (const { p, blocked, rank, cost } of entries) {
      const b = el('button', { cls: `sm-purpose rank-${rank}`, parent: this.purposesEl });
      b.dataset.purpose = p;
      const thumb = el('div', { cls: 'sm-thumb', parent: b });
      thumb.style.setProperty('--pc', ROOM_PURPOSE_COLOR[p]);
      el('span', { cls: 'g', text: ROOM_PURPOSE_GLYPH[p], parent: thumb });
      const body = el('div', { cls: 'bd', parent: b });
      const line = el('div', { cls: 'ln', parent: body });
      el('span', { cls: 'nm', text: ROOM_PURPOSE_LABEL_KO[p], parent: line });
      if (rank === 2) el('span', { cls: 'badge', text: '이미 제작', parent: line });
      else if (!ROOM_PURPOSES_ACTIVE.includes(p)) el('span', { cls: 'badge', text: '다음 업데이트', parent: line });
      const costEl = el('div', { cls: 'sm-cost', parent: body });
      renderItemCost(costEl, cost, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
      // Phase 12: the reason is printed, not tucked into a tooltip, and the row stays clickable (→ toast + flash)
      if (blocked) el('div', { cls: 'sm-block', text: blocked, parent: body });
      toggleClass(b, 'is-blocked', !!blocked);
      b.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      b.title = blocked ?? `${ROOM_PURPOSE_LABEL_KO[p]} 증축`;
      b.addEventListener('click', (e) => { e.stopPropagation(); this.pickPurpose(p); });
    }
  }

  /** 가구 제작 tab: one row per furniture def the room accepts — cost chips + a 제작 button. */
  private refreshCards(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const defs = housing.getFurnitureFor(purpose).filter((d) => !this.tutHides('furniture', d.id));
    const stored = this.storedCounts();

    // Rebuild only when the visible content actually changed (room / def list / storage / material counts / 튜토리얼 단계).
    const key = `craft|${room}|${purpose}|t${this.tutKey}|${defs.map((d) => `${d.id}:${stored.get(d.id) ?? 0}:${this.costKey(d)}`).join(',')}`;
    if (key === this.cardsKey) { this.markSelection(this.selected); return; }
    this.cardsKey = key;

    this.cardsEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = defs.length > 0;
    for (const def of defs) {
      const owned = stored.get(def.id) ?? 0;
      const can = housing.canCraftFurniture(def.id);
      const card = el('button', { cls: 'fcard', parent: this.cardsEl });
      card.dataset.defId = def.id;      // 2026-09-08: 튜토리얼 스포트라이트 · 스모크가 카드를 집는 손잡이
      card.style.setProperty('--fc', def.color);
      card.title = `${def.name}\n${def.description}`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      const cost = el('div', { cls: 'fcard-cost', parent: body });
      renderItemCost(cost, def.craft, (id) => this.itemDef(id), (id) => this.owned(id), { size: 24 });
      const own = el('div', { cls: 'fcard-own', text: `보유 ${owned}`, parent: body });
      toggleClass(own, 'none', owned <= 0);
      toggleClass(card, 'is-empty', owned <= 0);
      // the row selects a stored piece for placement; the 제작 button spends materials for a new one
      card.addEventListener('click', (e) => { e.stopPropagation(); if (owned > 0) this.pickCard(def.id); else this.craftCard(def.id); });
      const make = el('button', { cls: 'fcard-craft', text: '제작', parent: card });
      make.disabled = !can.ok;
      make.title = can.ok ? `${def.name} 제작` : '재료가 부족합니다';
      make.addEventListener('click', (e) => { e.stopPropagation(); this.craftCard(def.id); });
      this.cards.push({ defId: def.id, root: card });
    }
    this.markSelection(this.selected);
  }

  /**
   * 가구 창고 tab: everything in furniture storage. Pieces this room accepts come first and are clickable; the rest
   * follow, dimmed and disabled, so the player can still see what the ship owns without switching rooms.
   */
  private refreshStore(room: number | null, purpose: RoomPurpose): void {
    const housing = this.ctx.housing;
    if (!housing) return;
    const allowed = new Set(housing.getFurnitureFor(purpose).map((d) => d.id));
    const stored = this.storedCounts();
    const entries = [...stored].map(([defId, qty]) => ({ defId, qty, def: housing.getFurnitureDef(defId), fits: allowed.has(defId) }))
      .filter((e) => !!e.def) as Array<{ defId: string; qty: number; def: FurnitureDef; fits: boolean }>;
    entries.sort((a, b) => Number(b.fits) - Number(a.fits) || a.def.name.localeCompare(b.def.name, 'ko'));

    const key = `store|${room}|${purpose}|${entries.map((e) => `${e.defId}:${e.qty}:${e.fits ? 1 : 0}`).join(',')}`;
    if (key === this.storeKey) { this.markSelection(this.selected); return; }
    this.storeKey = key;

    this.storeEl.replaceChildren();
    this.cards = [];
    this.emptyEl.hidden = entries.length > 0;
    if (entries.length === 0) setText(this.emptyEl, '가구 창고가 비어 있습니다 — 가구 제작 탭에서 만드세요');
    for (const { defId, qty, def, fits } of entries) {
      const card = el('button', { cls: `fcard store${fits ? '' : ' is-blocked'}`, parent: this.storeEl });
      card.dataset.defId = defId;       // 가구 제작 카드와 같은 손잡이 — 튜토리얼 스포트라이트 · 스모크가 집는다
      card.style.setProperty('--fc', def.color);
      card.title = fits ? `${def.name}\n${def.description}` : `${def.name} — 이 방에 설치할 수 없습니다`;
      const thumb = el('div', { cls: 'fcard-thumb', parent: card });
      el('span', { cls: 'fcard-glyph', text: MODEL_GLYPH[def.model] ?? '▨', parent: thumb });
      el('span', { cls: 'fcard-size', text: `${def.cols}×${def.rows}`, parent: thumb });
      const body = el('div', { cls: 'fcard-body', parent: card });
      el('div', { cls: 'fcard-name', text: def.name, parent: body });
      el('div', { cls: 'fcard-note', text: fits ? '클릭해 배치' : `${ROOM_PURPOSE_LABEL_KO[def.room === 'any' ? 'empty' : def.room]} 전용`, parent: body });
      const own = el('div', { cls: 'fcard-own', text: `보유 ${qty}`, parent: body });
      toggleClass(own, 'none', qty <= 0);
      card.disabled = !fits;
      if (fits) card.addEventListener('click', (e) => { e.stopPropagation(); this.pickCard(defId); });
      this.cards.push({ defId, root: card });
    }
    this.markSelection(this.selected);
  }

  /** Furniture storage merged per def id (levels collapse — placement takes the highest level anyway). */
  private storedCounts(): Map<string, number> {
    const stored = new Map<string, number>();
    for (const s of this.ctx.housing?.getStored() ?? []) stored.set(s.defId, (stored.get(s.defId) ?? 0) + s.qty);
    return stored;
  }

  private costKey(def: FurnitureDef): string {
    return this.costKeyOf(def.craft);
  }

  private costKeyOf(cost: readonly { defId: string; qty: number }[] | null | undefined): string {
    if (!cost || cost.length === 0) return '-';
    return cost.map((c) => `${c.defId}x${c.qty}/${this.owned(c.defId)}`).join('+');
  }

  private itemDef(defId: string): ItemDef | undefined {
    return this.ctx.loot?.getItemDef(defId) ?? this.ctx.inventory?.getDef(defId);
  }

  private owned(defId: string): number {
    return this.ctx.inventory?.countDefAll(defId) ?? 0;
  }

  private markSelection(defId: string | null): void {
    this.selected = defId;
    for (const c of this.cards) toggleClass(c.root, 'is-sel', c.defId === defId);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    window.removeEventListener('keydown', this.onKey, true);
    this.root.remove();
  }
}
