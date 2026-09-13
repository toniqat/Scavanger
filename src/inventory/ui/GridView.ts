import type { AmmoType, EffectiveWeaponStats, ItemDef, ItemInstance, Loadout, RaidFoundScope } from '@/shared';
import { CONTAINER_TAKE_ANIM_S, CONTAINER_TAKE_END_SCALE, CONTAINER_TAKE_RISE_PX, SOCKET_SLOTS } from '@/shared';
import { countsForRecovery, sameRaidFoundScope } from '@/shared';
import { mealQualityStars, normalizeMealQuality } from '@/shared';
import type { Grid } from '../Grid';
import type { GridId } from '../InventorySystem';
import { WEAPON_SLOT_IDS } from '../model';
import { CELL, DURABILITY_LOW, GAP, STEP, TEXT, tileSize, tileSizeAt } from './labels';

export type DefLookup = (defId: string) => ItemDef | undefined;
/** Effective stats for weapon instances (null for anything else); drives socket pips + durability bar. */
export type StatsLookup = (item: ItemInstance) => EffectiveWeaponStats | null;
export type HighlightState = 'ok' | 'bad' | 'swap' | 'merge';

export interface TileHandlers {
  onPointerDown(uid: string, gridId: GridId, e: PointerEvent): void;
  onEnter(uid: string, gridId: GridId, e: PointerEvent): void;
  onMove(uid: string, gridId: GridId, e: PointerEvent): void;
  onLeave(uid: string, gridId: GridId): void;
  onContext(uid: string, gridId: GridId, e: MouseEvent): void;
  onDblClick(uid: string, gridId: GridId): void;
}

/** Phase 7: an item rolled into a container that has not been searched yet shows only its footprint. */
export const isHiddenItem = (item: ItemInstance): boolean => item.searched === false;

/* ── 2026-09-12 (사용자 결정): 내게 필요한 탄약에만 사선 띠 ──────────────────────────────────────────────────
 * "내가 장착하고 있는 무기에 맞는 탄약에만 탄약 아이템 타일 우측 상단에 표시용 사선 띠를 추가한다."
 *
 * 타일을 그리는 `buildTileContent` 는 격자 · 장비칸 · 고스트 · 카탈로그 · 거래 화면이 함께 쓰는 **순수 함수**라
 * 로드아웃을 모른다. 그래서 "지금 필요한 탄종"만 모듈 하나에 들고, 타일을 그리는 쪽(Tab 창 `InventoryUI` ·
 * 끼워 넣는 격자 `TradeGrids`)이 갱신한다 — 표시 전용 상태이고 인벤토리 데이터는 한 글자도 건드리지 않는다.
 */
let neededAmmo: ReadonlySet<string> = new Set<string>();

/** `def` 가 지금 장착한 주무기가 쓰는 탄약인가 (탄약이 아니면 언제나 false). */
export const isNeededAmmo = (def: ItemDef): boolean =>
  def.category === 'ammo' && def.ammoType !== undefined && neededAmmo.has(def.ammoType);

/**
 * 장착한 주무기 I · II 의 탄종으로 표를 갈아 끼운다. **바뀌었을 때만 true** 를 돌려주므로 부른 쪽이 그때만
 * 타일을 다시 그리면 된다 (`GridView.refresh(true)`). 무기를 바꾸면 띠도 따라 움직인다.
 */
export function setNeededAmmoFrom(loadout: Loadout, getStats: StatsLookup): boolean {
  const next = new Set<AmmoType>();
  for (const slot of WEAPON_SLOT_IDS) {
    const w = loadout[slot];
    if (!w) continue;
    const stats = getStats(w);
    if (stats) next.add(stats.ammoType);
  }
  if (next.size === neededAmmo.size) {
    let same = true;
    for (const t of next) if (!neededAmmo.has(t)) { same = false; break; }
    if (same) return false;
  }
  neededAmmo = next;
  return true;
}

/* ── 2026-09-12 (E1, 사용자 결정): 즐겨찾기 — 타일 우측 상단 **파란 사선 띠** ─────────────────────────────────────
 * `neededAmmo` 와 같은 이유로 모듈이 표 하나를 든다: `buildTileContent` 는 순수 함수라 인벤토리를 모르기 때문이다.
 * 표의 주인은 `InventorySystem`(`parts/Favorites`)이고 여기는 그 사본만 받는다. `favoriteRev` 는 바뀔 때마다 오르며
 * `GridView.refresh` 가 그것을 보고 격자 버전이 그대로여도 다시 칠한다 (띠 · 필터 칩 「즐겨찾기」의 어두움).
 */
let favoriteDefs: ReadonlySet<string> = new Set<string>();
let favoriteRev = 0;

/** 이 아이템 종류가 즐겨찾기인가 (표시 전용 사본 — 규칙은 `InventoryRef.isFavorite`). */
export const isFavoriteDef = (defId: string): boolean => favoriteDefs.has(defId);
/** 즐겨찾기 표가 바뀐 횟수 — 다시 그릴지 판단하는 서명에 넣는다. */
export const favoritesRevision = (): number => favoriteRev;
/** 표를 갈아 끼운다 (`parts/Favorites` 만 부른다). */
export function setFavoriteDefs(defs: ReadonlySet<string>): void {
  favoriteDefs = new Set(defs);
  favoriteRev++;
}

/* ── 2026-09-12 (아이템 회수 계약, 사용자 결정): 이번 레이드에서 얻은 계약 아이템 — 즐겨찾기와 **똑같은** 사선 띠 ────────────
 * 레이드 중(훈련장 아님)에만, 활성 `extract_with_items` 계약 아이템 중 **이번 레이드 표식**(`ItemInstance.raidFound`)이 있는
 * 스택에 `.is-recovery-item` 을 건다. CSS 는 `.is-favorite` 띠와 같은 선언이라 둘은 구분되지 않고, 둘 다면 띠는 하나다.
 * `.is-favorite` 는 계속 「사용자 즐겨찾기」 만 뜻한다 (필터 · 정렬 · 글로우 · 판매/분해 확인). 범위의 주인은
 * `InventorySystem`(`parts/RaidFound.raidFoundScope`)이고 매 프레임 · Tab 창 새로 그리기 때 여기 사본을 갈아 끼운다.
 */
let recoveryScope: RaidFoundScope | null = null;
let recoveryRev = 0;

/** 이 타일에 회수 계약 띠를 거나 (표시 전용 사본 — 규칙은 `shared/raidFound.countsForRecovery`). */
export const isRecoveryTile = (item: ItemInstance): boolean => countsForRecovery(item, recoveryScope);
/** 회수 범위가 바뀐 횟수 — 다시 그릴지 판단하는 서명에 넣는다. */
export const recoveryRevision = (): number => recoveryRev;
/** 범위를 갈아 끼운다. **바뀌었을 때만 true**. */
export function setRecoveryScope(scope: RaidFoundScope | null): boolean {
  if (sameRaidFoundScope(scope, recoveryScope)) return false;
  recoveryScope = scope;
  recoveryRev++;
  return true;
}

/**
 * Footprint-only content for an unsearched container item (Phase 7 search): neutral colour, `?` icon, `???` name —
 * nothing that leaks the def (no rarity class / colour, no qty, no pips, no durability).
 */
function buildHiddenTileContent(el: HTMLElement, item: ItemInstance, w: number, h: number, cell: number): void {
  el.className = 'inv-tile rarity-hidden is-hidden-item';
  el.style.removeProperty('--rc');
  const { width, height } = tileSizeAt(w, h, cell);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', item.rotated);
  el.innerHTML = '';
  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = TEXT.search.hiddenIcon;
  el.appendChild(icon);
  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = TEXT.search.hiddenName;
    el.appendChild(name);
  }
}

/**
 * The equipped-item card that fills an **equipment slot** box (2026-09-08). Shared by the Tab window
 * (`ui/InventoryUI`) and the read-only 분대원 장비 view (`ui/CrewLoadoutView`) so the two never drift apart.
 *
 * The slot no longer draws the item at its grid footprint: a 4×2 돌격소총 and a 5×1 저격소총 are the same object in
 * the hand and only differ in how they pack a bag, so the box is one size and the card fills it. Everything the old
 * `.inv-slot-meta` sentence carried is laid out in fixed corners instead — name top-left, sockets top-right, rounds
 * bottom-left, durability bottom-right (a step smaller) over the durability bar along the bottom edge — so the same
 * number is always in the same place, 무기 · 방탄복 · 가방 alike.
 *
 * Keeps the `.inv-tile` (+ `.is-weapon`) contract the drag / socket-drop / tooltip code matches on.
 *
 * @returns true when the item is worn (durability below max) — the caller flags its `.inv-slot` with `is-worn`.
 */
export function buildSlotCardContent(el: HTMLElement, item: ItemInstance, def: ItemDef, stats?: EffectiveWeaponStats | null): boolean {
  el.className = `inv-tile inv-slot-card rarity-${def.rarity}`;
  if (isFavoriteDef(def.id)) el.classList.add('is-favorite');   // 2026-09-12 (E1): 파란 사선 띠
  if (isRecoveryTile(item)) el.classList.add('is-recovery-item');   // 2026-09-12: 회수 계약 — 같은 띠
  el.style.setProperty('--rc', def.color);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-slot-ico';
  icon.textContent = def.icon;
  el.appendChild(icon);

  const name = document.createElement('div');
  name.className = 'inv-slot-name';
  name.textContent = def.name;
  el.appendChild(name);

  if (stats) {
    el.classList.add('is-weapon');
    const pips = document.createElement('div');
    pips.className = 'inv-slot-sockets';
    for (const sk of SOCKET_SLOTS) {
      const pip = document.createElement('i');
      pip.className = 'inv-pip';
      pip.dataset.socket = sk;
      if (item.sockets?.[sk]) pip.classList.add('is-filled');
      pips.appendChild(pip);
    }
    el.appendChild(pips);

    const ammo = document.createElement('div');
    ammo.className = 'inv-slot-ammo';
    ammo.textContent = `${item.ammoInMag ?? 0}/${stats.magSize}`;
    el.appendChild(ammo);
  }

  // 무기 read their durability from the effective stats; 방탄복 / 가방 from the def
  const max = stats ? Math.max(1, stats.maxDurability) : (def.durabilityMax ?? 0);
  if (max <= 0) return false;
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  const ratio = cur / max;
  const bar = document.createElement('div');
  bar.className = 'inv-slot-dur';
  bar.style.setProperty('--p', `${Math.round(ratio * 100)}%`);
  if (cur <= 0) { bar.classList.add('is-broken'); el.classList.add('is-broken'); }
  else if (ratio < DURABILITY_LOW) bar.classList.add('is-low');
  el.appendChild(bar);

  const num = document.createElement('div');
  num.className = 'inv-slot-durnum';
  num.textContent = `${Math.round(cur)}/${max}`;
  el.appendChild(num);
  return cur < max;
}

/**
 * Builds the visual content of a tile (shared by grid tiles, slot tiles and the drag ghost). Weapons (`stats`
 * given) also get five socket pips (filled = attached) and a thin durability bar (amber < 30 %, red at 0).
 * An unsearched container item (`searched === false`) renders the footprint mask instead.
 */
export function buildTileContent(el: HTMLElement, item: ItemInstance, def: ItemDef, w: number, h: number, stats?: EffectiveWeaponStats | null, cell: number = CELL): void {
  if (isHiddenItem(item)) { buildHiddenTileContent(el, item, w, h, cell); return; }
  el.className = `inv-tile rarity-${def.rarity}`;
  if (def.attachment) el.classList.add('is-attachment');
  if (def.bag) el.classList.add('is-bag');
  // 2026-09-12: 우상단 사선 띠 — 지금 장착한 무기가 쓰는 탄약만 (무기 타일의 소켓 핍과 자리가 겹칠 일은 없다)
  if (isNeededAmmo(def)) el.classList.add('is-ammo-needed');
  // 2026-09-12 (E1): 즐겨찾기 파란 띠 — 필요한 탄약이기도 하면 CSS 가 노란 띠를 그 **아래**로 민다 (둘 다 보인다)
  if (isFavoriteDef(def.id)) el.classList.add('is-favorite');
  // 2026-09-12: 이번 레이드에서 얻은 회수 계약 아이템 — 즐겨찾기와 같은 띠 (감정 전 타일은 위에서 이미 돌아갔다: 내용을 흘리지 않는다)
  if (isRecoveryTile(item)) el.classList.add('is-recovery-item');
  el.style.setProperty('--rc', def.color);
  const { width, height } = tileSizeAt(w, h, cell);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.classList.toggle('is-wide', w >= 2);
  el.classList.toggle('is-tall', h >= 2);
  el.classList.toggle('is-rotated', item.rotated);
  el.innerHTML = '';

  const icon = document.createElement('div');
  icon.className = 'inv-tile-icon';
  icon.textContent = def.icon;
  el.appendChild(icon);

  if (w >= 2 || h >= 2) {
    const name = document.createElement('div');
    name.className = 'inv-tile-name';
    name.textContent = def.name;
    el.appendChild(name);
  }

  const qty = document.createElement('div');
  qty.className = 'inv-tile-qty';
  qty.textContent = def.stackMax > 1 ? `${item.qty}` : '';
  qty.hidden = def.stackMax <= 1;
  el.appendChild(qty);

  // 2026-09-13 (요리 품질): 품질이 붙은 요리에만 좌하단 작은 `★n` — 수량(우하단) · 휠 방향(좌상단) · 사선 띠(우상단)와 모서리가 다르다
  const quality = def.meal ? normalizeMealQuality(item.quality) : 0;
  if (quality > 0) {
    el.classList.add('has-quality');
    const star = document.createElement('div');
    star.className = 'inv-tile-quality';
    star.dataset.quality = String(quality);
    star.textContent = `★${quality}`;
    star.title = mealQualityStars(quality);
    el.appendChild(star);
  }

  if (stats) {
    el.classList.add('is-weapon');
    const pips = document.createElement('div');
    pips.className = 'inv-tile-sockets';
    for (const s of SOCKET_SLOTS) {
      const pip = document.createElement('i');
      pip.className = 'inv-pip';
      pip.dataset.socket = s;
      if (item.sockets?.[s]) pip.classList.add('is-filled');
      pips.appendChild(pip);
    }
    el.appendChild(pips);

    appendDurabilityBar(el, item, stats.maxDurability);
  } else if (def.durabilityMax !== undefined && def.durabilityMax > 0 && def.heal?.spray) {
    // Phase 12: a channelled consumable (회복 스프레이) wears its 게이지 like a durability bar — an empty can (0) stays
    // a tile, marked broken, until the ship repairs it
    appendDurabilityBar(el, item, def.durabilityMax);
  }

  const glow = document.createElement('div');
  glow.className = 'inv-tile-glow';
  el.appendChild(glow);
}

/** Thin durability bar under the tile (amber < 30 %, red + `is-broken` on the tile at 0). */
function appendDurabilityBar(el: HTMLElement, item: ItemInstance, maxDurability: number): void {
  const max = Math.max(1, maxDurability);
  const cur = Math.max(0, Math.min(max, item.durability ?? max));
  const ratio = cur / max;
  const bar = document.createElement('div');
  bar.className = 'inv-tile-dur';
  bar.style.setProperty('--p', `${Math.round(ratio * 100)}%`);
  if (cur <= 0) { bar.classList.add('is-broken'); el.classList.add('is-broken'); }
  else if (ratio < DURABILITY_LOW) bar.classList.add('is-low');
  el.appendChild(bar);
}

/**
 * 2026-09-12: everything a grid tile draws, as one string — `GridView.refresh` rebuilds a tile's DOM only when this
 * changed. Weapon stats (sockets / grade / durability bar) derive from the fields listed here, so they are covered.
 * `needAmmo` (2026-09-12) is in here because the 사선 띠 depends on the **equipped weapon**, not on the item itself —
 * swapping guns has to redraw the ammo tiles.
 */
function tileSignature(item: ItemInstance, w: number, h: number, badge: string | undefined, needAmmo: boolean, favorite: boolean, recovery = false): string {
  let sockets = '';
  if (item.sockets) for (const s of SOCKET_SLOTS) sockets += `${item.sockets[s]?.defId ?? ''},`;
  return `${item.defId}|${item.qty}|${item.rotated ? 1 : 0}|${w}x${h}|${item.durability ?? ''}|${item.ammoInMag ?? ''}|${sockets}|${item.searched === false ? 0 : 1}|${badge ?? ''}|${needAmmo ? 1 : 0}|${favorite ? 1 : 0}|${recovery ? 1 : 0}|${item.quality ?? ''}`;
}

/** Small wheel-direction badge (top-left) on a bag tile that sits in a quick-use slot. */
export function addQuickBadge(el: HTMLElement, glyph: string): void {
  el.classList.add('is-quick');
  const b = document.createElement('div');
  b.className = 'inv-tile-quick';
  b.textContent = glyph;
  el.appendChild(b);
}

/**
 * Renders one Grid as DOM: a static cell layer, absolutely positioned item
 * tiles, and a highlight rectangle for drag feedback. Tiles are diffed by uid so
 * only changed grids re-render.
 */
export class GridView {
  readonly el: HTMLElement;
  private cellsEl: HTMLElement;
  private tilesEl: HTMLElement;
  private hlEl: HTMLElement;
  private tiles = new Map<string, HTMLElement>();
  private grid: Grid | null = null;
  private lastVersion = -1;
  /** 2026-09-12 (E1): `favoritesRevision()` at the last repaint. */
  private lastFavRev = -1;
  /** 2026-09-12 (아이템 회수 계약): `recoveryRevision()` at the last repaint. */
  private lastRecoveryRev = -1;
  private dims = '';
  /** uid → direction glyph for items assigned to the quick-use wheel (bag grid only). */
  private quickBadges = new Map<string, string>();
  /** Phase 7: the container item being searched (`.inv-tile-scan` with `--p`) and takes awaiting the host. */
  private scan: { uid: string; progress: number } | null = null;
  private pendingUids = new Set<string>();
  /** Phase 10: uids whose next removal animates out instead of being deleted on the spot (a live container take). */
  private vanishUids = new Set<string>();
  /** Tiles currently animating out → their removal timer. */
  private vanishing = new Map<HTMLElement, number>();
  /**
   * 2026-09-09: items this view must **not draw** although they sit in the grid (no tile → no hover, no press, no
   * drag, no menu). The stash view answers with `ctx.tutorial.hides('stashItem', defId)` so the guided steps show only
   * the tutorial's own materials; the data is untouched and the tiles come back on the next forced refresh.
   */
  private hideItem: ((item: ItemInstance) => boolean) | null = null;

  /** Cell edge / cell pitch of this grid in px. Only the 기업 거래 desk passes anything but the default. */
  private readonly cell: number;
  private readonly step: number;
  /**
   * 2026-09-12 (가방 틀 고정, 사용자 결정): the box is drawn at least this many rows tall. Rows past the grid's real
   * `rows` are blank space — no cell layer, no drop target — so the 가방 panel keeps the size of the longest bag and a
   * bigger bag simply fills more of that space with cells. null = the box is exactly the grid.
   */
  private frameRows: number | null = null;
  /**
   * 2026-09-12 (필터): tiles the predicate rejects get `.is-filtered-out` (dimmed). Positions never change and the
   * tile stays draggable — a Diablo grid that hid items would lie about which cells are free.
   */
  private filter: ((item: ItemInstance, def: ItemDef) => boolean) | null = null;
  /**
   * 2026-09-12: per-tile content signature. `refresh` used to rebuild **every** tile's DOM whenever the grid version
   * moved (a 200-stack 창고 → 200 × `innerHTML` for one drop), which is what made dragging in the embedded grids
   * stutter. A tile is now rebuilt only when what it draws changed; otherwise only its position is written.
   */
  private sigs = new Map<string, string>();

  constructor(readonly id: GridId, private readonly getDef: DefLookup, private readonly getStats: StatsLookup, private readonly handlers: TileHandlers, cell: number = CELL) {
    this.cell = cell;
    this.step = cell + GAP;
    this.el = document.createElement('div');
    this.el.className = `inv-grid inv-grid-${id}`;
    if (cell !== CELL) this.el.style.setProperty('--inv-cell', `${cell}px`);
    this.cellsEl = document.createElement('div');
    this.cellsEl.className = 'inv-cells';
    this.tilesEl = document.createElement('div');
    this.tilesEl.className = 'inv-tiles';
    this.hlEl = document.createElement('div');
    this.hlEl.className = 'inv-hl';
    this.hlEl.hidden = true;
    this.el.append(this.cellsEl, this.tilesEl, this.hlEl);
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get current(): Grid | null { return this.grid; }

  /** Predicate for items to leave undrawn (see `hideItem`); null shows everything. Re-renders at once. */
  setHideItem(fn: ((item: ItemInstance) => boolean) | null): void {
    this.hideItem = fn;
    this.refresh(true);
  }

  setGrid(grid: Grid | null): void {
    this.grid = grid;
    this.lastVersion = -1;
    this.sigs.clear();
    if (!grid) { this.clearTiles(); return; }
    this.syncDims(grid);
    this.refresh(true);
  }

  /** 2026-09-12: minimum box height in rows (see `frameRows`); null = exactly the grid. */
  setFrameRows(rows: number | null): void {
    const next = rows !== null && rows > 0 ? Math.floor(rows) : null;
    if (next === this.frameRows) return;
    this.frameRows = next;
    this.dims = '';
    if (this.grid) this.syncDims(this.grid);
    this.el.classList.toggle('has-frame', next !== null);
  }

  /** 2026-09-12: dim every tile the predicate rejects (null = show all at full strength). Cheap: classes only. */
  setFilter(fn: ((item: ItemInstance, def: ItemDef) => boolean) | null): void {
    this.filter = fn;
    const grid = this.grid;
    for (const [uid, el] of this.tiles) {
      const item = grid?.get(uid)?.item;
      const def = item && this.getDef(item.defId);
      el.classList.toggle('is-filtered-out', !!fn && !!item && !!def && !fn(item, def));
    }
  }

  /** Rebuild the cell layer when the grid dimensions changed (bag swap, stash resize). */
  private syncDims(grid: Grid): void {
    const dims = `${grid.cols}x${grid.rows}`;
    if (dims === this.dims) return;
    this.dims = dims;
    this.el.style.setProperty('--cols', String(grid.cols));
    this.el.style.setProperty('--rows', String(grid.rows));
    this.el.style.width = `${grid.cols * this.step - GAP}px`;
    this.el.style.height = `${Math.max(grid.rows, this.frameRows ?? 0) * this.step - GAP}px`;
    this.cellsEl.innerHTML = '';
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      const c = document.createElement('div');
      c.className = 'inv-cell';
      this.cellsEl.appendChild(c);
    }
  }

  refresh(force = false): void {
    const grid = this.grid;
    if (!grid) return;
    // 2026-09-12 (E1): 즐겨찾기가 바뀌면 격자 버전이 그대로여도 다시 칠한다 (띠 · 「즐겨찾기」 필터)
    // 2026-09-12: …and when the 회수 계약 범위 changed (raid start / end, contract abandoned) — the ribbon follows it
    if (!force && grid.version === this.lastVersion && favoriteRev === this.lastFavRev && recoveryRev === this.lastRecoveryRev) return;
    this.lastVersion = grid.version;
    this.lastFavRev = favoriteRev;
    this.lastRecoveryRev = recoveryRev;
    this.syncDims(grid);

    const seen = new Set<string>();
    for (const p of grid.items()) {
      const def = this.getDef(p.item.defId);
      if (!def) continue;
      if (this.hideItem?.(p.item)) continue; // not in `seen` → an existing tile is swept away below
      seen.add(p.item.uid);
      let el = this.tiles.get(p.item.uid);
      const fp = grid.footprintOf(p.item);
      if (!el) {
        el = document.createElement('div');
        el.dataset.uid = p.item.uid;
        this.bindTile(el, p.item.uid);
        this.tiles.set(p.item.uid, el);
        this.tilesEl.appendChild(el);
        // 2026-09-12: no `.is-new` pop — an item that moved grids is simply there (사용자 결정: 즉시 옮겨진다)
      }
      const badge = this.quickBadges.get(p.item.uid);
      const sig = tileSignature(p.item, fp.w, fp.h, badge, isNeededAmmo(def), isFavoriteDef(def.id), isRecoveryTile(p.item));
      if (this.sigs.get(p.item.uid) !== sig) {
        this.sigs.set(p.item.uid, sig);
        const wasDragging = el.classList.contains('is-dragging');
        const wasHover = el.classList.contains('is-hover');
        buildTileContent(el, p.item, def, fp.w, fp.h, this.getStats(p.item), this.cell);
        if (badge && !isHiddenItem(p.item)) addQuickBadge(el, badge);
        if (this.scan?.uid === p.item.uid) this.applyScan(el, this.scan.progress);
        if (wasDragging) el.classList.add('is-dragging');
        if (wasHover) el.classList.add('is-hover');
      }
      el.classList.toggle('is-pending', this.pendingUids.has(p.item.uid));
      el.classList.toggle('is-filtered-out', !!this.filter && !this.filter(p.item, def));
      el.style.transform = `translate(${p.x * this.step}px, ${p.y * this.step}px)`;
    }
    for (const [uid, el] of this.tiles) {
      if (seen.has(uid)) continue;
      this.tiles.delete(uid);
      this.sigs.delete(uid);
      // the item being searched left the grid (a remote take): drop the gauge state, it would otherwise linger
      // on the container until the next `updateSearch` frame
      if (this.scan?.uid === uid) this.scan = null;
      this.clearScanOn(el);
      if (this.vanishUids.delete(uid)) this.startVanish(el);
      else el.remove();
    }
  }

  /* ── Phase 10: live container take (exit animation) ── */

  /**
   * Mark `uid` so the next `refresh()` that no longer finds it animates the tile out (`.is-vanishing`, removed after
   * `CONTAINER_TAKE_ANIM_S`) instead of deleting it synchronously. Used when another member's take is confirmed.
   */
  vanish(uid: string): void {
    if (this.tiles.has(uid)) this.vanishUids.add(uid);
  }

  private startVanish(el: HTMLElement): void {
    el.classList.remove('is-hover', 'is-dragging', 'is-pending', 'is-scanning', 'is-split-source', 'is-socket-ok', 'is-socket-bad');
    // the animation drives the `translate:` / `scale:` / `opacity` channels — `transform` is the tile's cell position
    el.style.setProperty('--vanish-t', `${CONTAINER_TAKE_ANIM_S}s`);
    el.style.setProperty('--vanish-rise', `${-CONTAINER_TAKE_RISE_PX}px`);
    el.style.setProperty('--vanish-scale', String(CONTAINER_TAKE_END_SCALE));
    el.classList.add('is-vanishing');
    const timer = window.setTimeout(() => { this.vanishing.delete(el); el.remove(); }, Math.round(CONTAINER_TAKE_ANIM_S * 1000) + 60);
    this.vanishing.set(el, timer);
  }

  private clearScanOn(el: HTMLElement): void {
    el.querySelector('.inv-tile-scan')?.remove();
    el.classList.remove('is-scanning');
  }

  private stopVanishing(): void {
    for (const [el, timer] of this.vanishing) { clearTimeout(timer); el.remove(); }
    this.vanishing.clear();
    this.vanishUids.clear();
  }

  private bindTile(el: HTMLElement, uid: string): void {
    el.addEventListener('pointerdown', (e) => this.handlers.onPointerDown(uid, this.id, e));
    el.addEventListener('pointerenter', (e) => { el.classList.add('is-hover'); this.handlers.onEnter(uid, this.id, e); });
    el.addEventListener('pointermove', (e) => this.handlers.onMove(uid, this.id, e));
    el.addEventListener('pointerleave', () => { el.classList.remove('is-hover'); this.handlers.onLeave(uid, this.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.handlers.onContext(uid, this.id, e); });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); this.handlers.onDblClick(uid, this.id); });
  }

  /** Quick-slot badges (uid → glyph). Forces a re-render when the set changed. */
  setQuickBadges(badges: ReadonlyMap<string, string>): void {
    let same = badges.size === this.quickBadges.size;
    if (same) for (const [uid, g] of badges) if (this.quickBadges.get(uid) !== g) { same = false; break; }
    if (same) return;
    this.quickBadges = new Map(badges);
    this.refresh(true);
  }

  /* ── Phase 7: container search gauge / pending takes ── */

  /**
   * Show the search gauge on `uid` at `progress` (0..1); null clears it. Cheap: only the `--p` custom property changes
   * while the same item is being searched (no re-render), so it can be called every frame.
   */
  setScan(uid: string | null, progress = 0): void {
    const prev = this.scan;
    if (uid === null) {
      if (!prev) return;
      this.scan = null;
      const el = this.tiles.get(prev.uid);
      if (el) { el.querySelector('.inv-tile-scan')?.remove(); el.classList.remove('is-scanning'); }
      return;
    }
    const p = Math.max(0, Math.min(1, progress));
    if (prev && prev.uid !== uid) {
      const old = this.tiles.get(prev.uid);
      if (old) { old.querySelector('.inv-tile-scan')?.remove(); old.classList.remove('is-scanning'); }
    }
    this.scan = { uid, progress: p };
    const el = this.tiles.get(uid);
    if (el) this.applyScan(el, p);
  }

  private applyScan(el: HTMLElement, progress: number): void {
    let scan = el.querySelector<HTMLElement>('.inv-tile-scan');
    if (!scan) {
      scan = document.createElement('div');
      scan.className = 'inv-tile-scan';
      el.appendChild(scan);
    }
    scan.style.setProperty('--p', `${Math.round(progress * 100)}%`);
    el.classList.add('is-scanning');
  }

  /** Tiles whose take is waiting for the host's answer pulse (`is-pending`). */
  setPending(uids: ReadonlySet<string>): void {
    let same = uids.size === this.pendingUids.size;
    if (same) for (const u of uids) if (!this.pendingUids.has(u)) { same = false; break; }
    if (same) return;
    this.pendingUids = new Set(uids);
    for (const [id, el] of this.tiles) el.classList.toggle('is-pending', this.pendingUids.has(id));
  }

  /** Socket-drop feedback on a weapon tile (attachment dragged over it). null clears every tile. */
  setSocketTarget(uid: string | null, state: 'ok' | 'bad' | null): void {
    for (const [id, el] of this.tiles) {
      el.classList.toggle('is-socket-ok', id === uid && state === 'ok');
      el.classList.toggle('is-socket-bad', id === uid && state === 'bad');
    }
  }

  private clearTiles(): void {
    this.stopVanishing();
    for (const el of this.tiles.values()) el.remove();
    this.tiles.clear();
    this.sigs.clear();
    this.scan = null;
  }

  /* ── drag feedback ─────────────────────────────────────────────────────── */

  rect(): DOMRect { return this.el.getBoundingClientRect(); }

  /**
   * True when the pointer lies within `pad` px of this grid's box. `pad = 0` is strict containment — the caller
   * (`InventoryUI.updateDragTarget`) resolves strictly first and only then with a tolerance, so two grids that sit
   * a few px apart (가방 over 함선 창고) can no longer steal each other's edge rows.
   */
  hitTest(pointerX: number, pointerY: number, pad: number): boolean {
    if (!this.grid) return false;
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return false;
    // 2026-09-12: the blank rows of a fixed 가방 frame (`frameRows`) are not a target — only the real cells are
    const cellsBottom = Math.min(r.bottom, r.top + this.grid.rows * this.step - GAP);
    let top = r.top - pad, bottom = cellsBottom + pad;
    const clip = this.clipEl;
    if (clip && clip.scrollHeight > clip.clientHeight + 1) {
      // 2026-09-11 (C-60): rows scrolled out of the viewport are not a target, and a clipped edge has no tolerance —
      // otherwise a release over the panel header would land on a row hidden above it
      const c = clip.getBoundingClientRect();
      if (r.top < c.top) top = c.top;
      if (r.bottom > c.bottom) bottom = c.bottom;
    }
    return pointerX >= r.left - pad && pointerX <= r.right + pad && pointerY >= top && pointerY <= bottom;
  }

  /**
   * 2026-09-11 (C-60): the scroll viewport this grid sits in (the container panel's `.inv-cont-scroll`). Cell math keeps
   * reading the grid's own `getBoundingClientRect` (it already includes the scroll offset — nothing is cached); the clip
   * only trims `hitTest` to the visible rows while the viewport actually overflows. null = no clipping (bag · 창고).
   */
  setClip(el: HTMLElement | null): void { this.clipEl = el; }
  private clipEl: HTMLElement | null = null;

  /** Tolerance (px) used for the padded second pass. */
  get hitPad(): number { return this.step * 0.5; }

  /**
   * Cell under a ghost whose top-left is at (left, top) in client space, clamped
   * so a w×h footprint stays inside. Null when the pointer is outside the grid (`pad` px of tolerance).
   */
  cellForGhost(left: number, top: number, w: number, h: number, pointerX: number, pointerY: number, pad = this.step * 0.5): { x: number; y: number } | null {
    const grid = this.grid;
    if (!grid) return null;
    if (!this.hitTest(pointerX, pointerY, pad)) return null;
    const r = this.rect();
    let x = Math.round((left - r.left) / this.step);
    let y = Math.round((top - r.top) / this.step);
    x = Math.max(0, Math.min(grid.cols - w, x));
    y = Math.max(0, Math.min(grid.rows - h, y));
    if (w > grid.cols || h > grid.rows) return null;
    return { x, y };
  }

  showHighlight(x: number, y: number, w: number, h: number, state: HighlightState): void {
    const { width, height } = tileSizeAt(w, h, this.cell);
    this.hlEl.hidden = false;
    this.hlEl.className = `inv-hl is-${state}`;
    this.hlEl.style.width = `${width}px`;
    this.hlEl.style.height = `${height}px`;
    this.hlEl.style.transform = `translate(${x * this.step}px, ${y * this.step}px)`;
  }

  hideHighlight(): void { this.hlEl.hidden = true; }

  setDragging(uid: string | null): void {
    for (const [id, el] of this.tiles) el.classList.toggle('is-dragging', id === uid);
  }

  /**
   * Partial (Shift/Ctrl) drag feedback: the source tile stays lit and its badge shows what would remain.
   * `remaining` null clears the state; the next `refresh(true)` rebuilds the badge anyway.
   */
  markSplitSource(uid: string, remaining: number | null): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.toggle('is-split-source', remaining !== null);
    const badge = el.querySelector<HTMLElement>('.inv-tile-qty');
    if (!badge) return;
    if (remaining === null) {
      const item = this.grid?.get(uid)?.item;
      if (item) badge.textContent = String(item.qty);
    } else {
      badge.textContent = String(remaining);
    }
  }

  shake(uid: string): void {
    const el = this.tiles.get(uid);
    if (!el) return;
    el.classList.remove('is-shake');
    void el.offsetWidth; // restart animation
    el.classList.add('is-shake');
    setTimeout(() => el.classList.remove('is-shake'), 360);
  }

  tileEl(uid: string): HTMLElement | undefined { return this.tiles.get(uid); }

  /** 2026-09-12: visit every drawn tile (per-tile flags an embedding view layers on top — `TradeGrids` staging / tips). */
  forEachTile(fn: (uid: string, el: HTMLElement) => void): void {
    for (const [uid, el] of this.tiles) fn(uid, el);
  }

  dispose(): void {
    this.clearTiles();
    this.el.remove();
  }
}
