import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, EffectiveWeaponStats, GameContext, GameSystem, InventoryRef,
  ItemCategory, ItemDef, ItemInstance, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind,
  EmbeddedView, TradeGridsViewOptions,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, LootService, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from './Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from './Grid';
import { Container, ContainerStore } from './Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from './Sockets';
import {
  assignQuickSlot, autoAssignQuickSlots, createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, pruneQuickSlots,
  quickSlotOf, quickSlotsSignature, relinkQuickSlot, type QuickSlotUids,
} from './QuickSlots';
import { InventoryUI, type ScreenTab } from './ui/InventoryUI';
export type { ScreenTab } from './ui/InventoryUI';
import { TradeGrids, type TradeGridsOptions } from './ui/TradeGrids';
import { Stash, setStarterGrantState, starterGrantState } from './Stash';
import { LOADOUT_SAVE_VERSION, LoadoutStore, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from './Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from './Serialize';
/* appended (Phase 10): 분대원 장비 열람 */
import type { CrewLoadoutViewOptions } from '@/shared';
import { HUB_READY_BLOCKER } from '@/shared';
import { CrewLoadoutView } from './ui/CrewLoadoutView';

/* ── UI ↔ system vocabulary ─────────────────────────────────────────────── */
/** 'stash' = the ship stash (hub Tab screen only; persisted, see Stash.ts). */
export type GridId = 'bag' | 'container' | 'stash';
/** Equipment slots = the shared `LoadoutSlot` (주무기 I / 주무기 II / 보조무기 / 가방 / 방탄복). */
export type SlotId = LoadoutSlot;
export const LOADOUT_SLOTS: readonly LoadoutSlot[] = ['primary', 'primary2', 'secondary', 'bag', 'armor'];
export const WEAPON_SLOT_IDS: readonly WeaponSlot[] = ['primary', 'primary2', 'secondary'];
export type ItemLocation = { kind: 'grid'; grid: GridId } | { kind: 'slot'; slot: SlotId };
export type DropTarget =
  | { kind: 'grid'; grid: GridId; x: number; y: number; rotated: boolean }
  | { kind: 'slot'; slot: SlotId }
  /** An attachment released over a weapon tile (bag or equipment slot): socket it. */
  | { kind: 'weapon'; uid: string; loc: ItemLocation }
  /** A stim / grenade released over a quick-use wheel cell: assign it (`setQuickSlot`). */
  | { kind: 'quick'; index: number };
/**
 * `ok` mutated, `noop` nothing to do (drop in place), `fail` refused (UI shakes), `pending` (Phase 7, multiplayer client)
 * = the take was sent to the host; the move happens on `cont taken`, a `cont denied` shakes the tile.
 */
export type OpResult = 'ok' | 'noop' | 'fail' | 'pending';
export type DropPreview = 'ok' | 'swap' | 'merge' | 'noop' | 'bad';
export type UiSfx = 'ui_pickup' | 'ui_drop' | 'ui_rotate' | 'ui_error' | 'ui_equip';
export type BagSize = { cols: number; rows: number; quickSlots: number };
/** How the last mission ended; decides what `game:abort` does to the bag (see README "Reset policy"). */
type MissionOutcome = 'none' | 'complete' | 'over';
/* ── Phase 6: bench crafting vocabulary (CraftPanel) ── */
/** Active 작업실 bench of the craft panel (`openBenchCraft`); null = the plain 제작 panel. */
export type ActiveBench = { kind: WorkbenchKind; level: number };
/** A craft-panel row: `locked` = the recipe belongs to this bench but needs a higher bench level. */
export type BenchRecipeRow = { recipe: CraftRecipe; locked: boolean };
/** A repair-list row of the bench panel (`where` = loadout slot, null = in the bag grid). */
export type BenchRepairRow = {
  uid: string; item: ItemInstance; def: ItemDef; where: LoadoutSlot | null; dur: DurabilityInfo;
  cost: { defId: string; qty: number; name: string; have: number }[]; short: boolean;
};

const AUTO_CLOSE_DISTANCE = 6;
/** `container:searchProgress` rate cap (s). */
const SEARCH_EMIT_INTERVAL = 1 / 20;
/** A take request the host never answered is dropped after this (s, sim time) so the tile stops pulsing. */
const TAKE_REQUEST_TIMEOUT = 8;

/* ── Phase 7: host-authoritative container takes (multiplayer clients) ── */
/** A container → player move waiting for the host's `cont taken` / `cont denied`; `run` replays the move on confirmation. */
interface PendingTake {
  containerId: string;
  idx: number;
  qty: number;
  uid: string;
  from: ItemLocation;
  run: () => OpResult;
  sentAt: number;
}
/** `captureRaidState()` shape: the loadout save plus `searched: false` flags on bag entries (never persisted to disk). */
export interface RaidInventoryState extends LoadoutSave { raid: 1 }
const BLOCKER_TOKEN = 'inventory';
/** World-drop throw: eye position lowered / pushed forward, forward speed + upward pop. */
const DROP_EYE_LOWER = 0.3;
const DROP_FORWARD_OFFSET = 0.4;
const DROP_FORWARD_SPEED = 3.5;
const DROP_UP_SPEED = 2.0;
const MOD_SHIFT = ['ShiftLeft', 'ShiftRight'] as const;
const MOD_CTRL = ['ControlLeft', 'ControlRight'] as const;
/**
 * Phase 12: materials for one **full** 회복 스프레이 refill (ship 수리). Scaled down by the missing gauge fraction in
 * `sprayRepairCost` (ceil, min 1 each). Existing material defs — 캔 / 소독약 (소독약 is craft-only, `items/Recipes`).
 */
const SPRAY_REFILL_COST: readonly CraftIngredient[] = [{ defId: 'mat_can', qty: 1 }, { defId: 'mat_antiseptic', qty: 1 }];

/** Which item categories a loadout slot accepts. */
export function slotAccepts(def: ItemDef, slot: LoadoutSlot): boolean {
  if (slot === 'bag') return def.category === 'bag';
  if (slot === 'armor') return def.category === 'armor';
  if (slot === 'secondary') return def.category === 'secondary';
  return def.category === 'primary';
}

export const isWeaponDef = (def: ItemDef | undefined): boolean => isWeaponItemDef(def);
export const isAttachmentDef = (def: ItemDef | undefined): boolean => !!def?.attachment;
export const isBagDef = (def: ItemDef | undefined): boolean => !!def?.bag;
export const isArmorDef = (def: ItemDef | undefined): boolean => def?.category === 'armor' && !!def.armorId;

/**
 * Phase 8 — a **분해** recipe (`break_*`). These no longer appear in the craft list: 분해 is a context-menu entry
 * on the item itself (`disassembleRecipeFor` → the modeless `DisassemblePanel`). `craft()` still accepts them.
 */
export const isDisassembleRecipe = (r: CraftRecipe): boolean => r.id.startsWith('break_');

/** Minimum craft speed multiplier so a pathological derived value cannot make a craft instant. */
const CRAFT_MIN_SPEED = 0.2;

interface CraftJob {
  recipe: CraftRecipe;
  remaining: number;
  duration: number;
  resolve(item: ItemInstance | null): void;
}

/**
 * Owns the player's bag grid, the four equipment slots and the open loot container.
 * Publishes `ctx.inventory` (this) and `ctx.loot` (LootService).
 */
export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  private ctx!: GameContext;
  private loot = new LootService();
  private bag!: Grid;
  private loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
  /** Tactical kit: last emitted weight / loadout (gates `inventory:weightChanged` / `equip:changed`), running craft. */
  private lastWeight: WeightInfo | null = null;
  private lastEquipUids: Partial<Record<LoadoutSlot, string | null>> = {};
  private craftJob: CraftJob | null = null;
  private containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  /** 함선 창고 (persisted). Shown only while the window is open in the hub (`hubMode`). */
  private stash!: Stash;
  /** Phase 5: loadout save (`scav.loadout`); `announcePending` = a save was restored at init and nobody has been told yet. */
  private loadoutStore!: LoadoutStore;
  private announcePending = false;
  private hubMode = false;
  private activeContainer: Container | null = null;
  private _open = false;
  private missionSeed = 0;
  private outcome: MissionOutcome = 'none';
  private lastGrenades = -1;
  private lastStims = -1;
  /** Quick-use wheel: bag item uids by wheel direction (see `QuickSlots.ts`); `lastQuickSig` gates the change event. */
  private quickSlots: QuickSlotUids = createQuickSlots();
  private lastQuickSig = '';
  private lastStashVersion = 0;
  /* Phase 6: 무한 상자 window state + the bench the craft panel is showing. */
  private catalogOpen = false;
  private bench: ActiveBench | null = null;
  /* Phase 7: container search + host authority + net subscriptions. */
  private openedIds = new Set<string>();
  private pendingTakes: PendingTake[] = [];
  private lastSearchEmit = -1;
  /**
   * Phase 9: no inventory-side offline queue any more — every save goes to `profile.set` (`ProfileSync` stamps it and
   * keeps the newest doc per key while offline). `freshSave` marks the saves made inside `withFreshSave` as defaults
   * (`{fresh:true}`: the server keeps them only while it has no document for that key) — the fresh-browser starter
   * kit and the startup stash resize must never beat a real server profile.
   */
  private freshSave = false;
  /** 2026-09-07: `STARTER_STASH` was granted this session (a brand-new profile) → equip the minimum kit once. */
  private firstRunGrant = false;
  private ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    e.preventDefault();
    e.stopPropagation();
    // A context menu / split dialog swallows the first Escape; the window closes on the next one.
    if (this.ui?.closeOverlays()) return;
    this.closeAll();
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.inventory = this;
    ctx.loot = this.loot;
    this.bag = new Grid(BAG_DEFAULT_COLS, BAG_DEFAULT_ROWS, (id) => ITEM_DEF_MAP.get(id));
    this.stash = new Stash((id) => ITEM_DEF_MAP.get(id), this.loot);
    this.stash.onSaved = (file) => this.uploadProfileDoc('stash', file); // Phase 7: mirror to the server profile
    // ship housing: the 창고 facility decides the stash size. At startup only *grow* to it — a persisted larger grid
    // (older facility state, cheat) is kept, and a shrink could strand items; `housing:stashSizeChanged` applies exactly.
    const housing = ctx.housing;
    if (housing && typeof housing.getStashSize === 'function') {
      const want = housing.getStashSize();
      if (want && Number.isFinite(want.cols) && Number.isFinite(want.rows)) {
        const cols = Math.max(this.stash.cols, Math.floor(want.cols)), rows = Math.max(this.stash.rows, Math.floor(want.rows));
        // a default, not an edit: uploaded as a `fresh` document (Phase 9)
        if ((cols !== this.stash.cols || rows !== this.stash.rows) && this.stash.resize(cols, rows)) this.withFreshSave(() => this.stash.flush());
      }
    }
    // 2026-09-07: 기본 지급품 — handed out once per **profile** (`starterGrantState()`), not once per stash file.
    if (starterGrantState() === 'none') this.tryStarterGrant();
    // Phase 10: a take that arrives through the shared state (`cont sync`, or the pending map applied on the first
    // open) is a catch-up, not something happening in front of the player → `live: false`, no animation.
    this.containers.onTaken = (info) =>
      this.emitItemTaken(info.containerId, info.idx, info.uid, info.qty, info.remaining, null, false);
    // Phase 5: the persisted loadout fills the bag + slots once, here; from now on the session state is the truth.
    this.loadoutStore = new LoadoutStore(() => this.captureLoadoutSave(), (reason, file) => {
      ctx.bus.emit('inventory:loadoutSaved', { reason });
      if (reason !== 'profile') this.uploadProfileDoc('loadout', file); // Phase 7: mirror to the server profile
    });
    this.restoreLoadoutSave();
    this.ui = new InventoryUI(this, ctx);
    this.ui.mount();

    const bus = ctx.bus;
    this.offs.push(
      bus.on('meta:creditsChanged', () => { if (this._open) this.ui?.refreshCredits(); }),
      bus.on('housing:stashSizeChanged', ({ cols, rows }) => {
        if (!this.setStashSize(cols, rows)) {
          ctx.bus.emit('ui:notify', { text: '창고 크기를 바꿀 수 없습니다: 범위 밖에 아이템이 있습니다', kind: 'warning', duration: 2.5 });
        }
      }),
      bus.on('world:ready', ({ seed }) => this.onWorldReady(seed)),
      bus.on('crate:open', ({ crateId, tier, position }) => this.openContainer(crateId, tier, position)),
      bus.on('player:died', () => this.closeAll()),
      bus.on('game:complete', () => { this.outcome = 'complete'; this.loadoutStore.saveNow('complete'); }),
      bus.on('game:over', () => this.onGameOver()),
      bus.on('player:respawn', () => this.onRespawn()),
      bus.on('game:abort', () => this.onAbort()),
      bus.on('game:newMission', () => { this.closeAll(); this.clearContainers(); this.outcome = 'none'; }),
      /* Phase 7: server profile documents + host migration */
      bus.on('net:profileLoaded', ({ profile }) => this.onProfileLoaded(profile)),
      bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestContainerSync(); }),
      bus.on('hub:entered', () => {
        // 2026-09-07: only the very first run (`STARTER_STASH` was just granted) and a player with nothing anywhere
        // get the kit handed to them — a lost raid is re-equipped from the 함선 창고, not refilled for free.
        if (this.isCompletelyEmpty() && (this.firstRunGrant || this.stash.count === 0)) {
          this.firstRunGrant = false;
          // a fresh browser: the starter is "no data", not an edit — it goes up as a `fresh` document so a real server profile wins
          this.withFreshSave(() => this.applyStarter());
        } else if (this.announcePending) this.announceLoaded();
      }),
      bus.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) this.closeAll(); }),
      bus.on('implant:equipped', () => { if (this._open) this.ui?.refresh(); }),
    );
    // Phase 7: host-authoritative container contents (`cont` / `contq`, sync on rejoin)
    const net = ctx.net;
    if (net && typeof net.onMessage === 'function') {
      this.offs.push(
        net.onMessage('cont', (msg, from) => this.onContainerMessage(msg, from)),
        net.onMessage('contq', (msg, from) => this.onContainerRequest(msg, from)),
        net.onMessage('flow', (msg, from) => {
          if (msg.ev === 'rejoined' && this.isNetAuthority()) net.send({ t: 'cont', ev: 'sync', items: this.containers.takenWire() }, from);
        }),
      );
    }
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(dt: number, ctx: GameContext): void {
    // Tab: bag window on a mission, the 3-column ship screen (창고 / 장비 / 가방) in the hub.
    // Phase 10: the launch-pod READY panel holds its own blocker, and Tab must still work while boarded (as before).
    const onlyReadyBlocked = ctx.uiBlockers.size === 0
      || (ctx.uiBlockers.size === 1 && ctx.uiBlockers.has(HUB_READY_BLOCKER));
    if (ctx.input.wasPressed(Keys.INVENTORY) && (ctx.isGameplayPhase() || ctx.isHubPhase()) && (this._open || onlyReadyBlocked)) {
      this.toggleBag();
    }
    this.updateCraft(dt);
    if (!this._open) return;
    if (ctx.input.wasPressed(Keys.ROTATE_ITEM)) this.ui?.onRotateKey();
    if (ctx.input.wasPressed(Keys.DROP_ITEM)) {
      const shift = MOD_SHIFT.some((c) => ctx.input.isDown(c));
      const ctrl = MOD_CTRL.some((c) => ctx.input.isDown(c));
      this.ui?.onDropKey(shift, ctrl);
    }
    const player = ctx.player;
    if (player?.isDead) { this.closeAll(); return; }
    if (this.activeContainer && player && player.position.distanceTo(this.activeContainer.position) > AUTO_CLOSE_DISTANCE) {
      this.closeAll();
      return;
    }
    this.updateSearch(dt);
    this.expirePendingTakes();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    window.removeEventListener('keydown', this.escHandler, true);
    this.closeAll();
    this.loadoutStore?.dispose();
    this.stash?.dispose();
    this.ui?.dispose();
    this.ui = null;
    if (this.ctx?.inventory === (this as InventoryRef)) this.ctx.inventory = null;
  }

  /* ── reset policy ──────────────────────────────────────────────────────── */

  /**
   * `world:ready`: the kit the player equipped in the ship is what they raid with (2026-09-07 — no automatic starter
   * per mission any more). Only a player with nothing anywhere (loadout, bag **and** 함선 창고) gets the minimum kit
   * so a lost run can never soft-lock the game; otherwise everything is kept and only the events every consumer needs
   * (`loadout:changed`, counts, `inventory:changed`) are re-emitted.
   */
  private onWorldReady(seed: number): void {
    this.missionSeed = seed;
    this.outcome = 'none';
    this.closeAll();
    this.clearContainers();
    if (this.isDestitute()) { this.applyStarter(); return; }
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = '';
    if (this.announcePending) { this.announcePending = false; this.lastEquipUids = {}; this.lastWeight = null; }
    this.emitLoadout();
    this.afterChange();
  }

  /* ── Phase 5: loadout persistence (`Loadout.ts`, localStorage `scav.loadout`) ── */

  /** Snapshot for the save file: slots + bag placements + quick slots as bag indices. */
  private captureLoadoutSave(): LoadoutSave {
    const slots: LoadoutSave['slots'] = {};
    for (const s of LOADOUT_SLOTS) { const it = this.loadout[s]; if (it) slots[s] = serializeExtras(it); }
    const placements = this.bag.items();
    const quick = this.quickSlots.map((uid) => {
      if (uid === null) return null;
      const i = placements.findIndex((p) => p.item.uid === uid);
      return i >= 0 ? i : null;
    });
    return { v: LOADOUT_SAVE_VERSION, slots, bag: placements.map(serializePlacement), quick };
  }

  /**
   * Fill the slots / bag / quick slots from the save (init only, no events). A missing / empty save leaves
   * everything empty so `hub:entered` hands out the starter kit as before. Unknown defs and items that no longer
   * fit are dropped with a warning; a wrong-category slot entry is ignored.
   */
  private restoreLoadoutSave(): boolean {
    const save = loadLoadoutSave();
    if (!save || isEmptyLoadoutSave(save)) return false;
    this.applyLoadoutSave(save);
    this.announcePending = true;
    return true;
  }

  /**
   * Replace the slots / bag / quick slots with `save` (no events — callers announce). Returns the revived bag
   * instances in `save.bag` order (null = dropped) so a raid state can restore per-entry flags.
   */
  private applyLoadoutSave(save: LoadoutSave): (ItemInstance | null)[] {
    const getDef = (id: string): ItemDef | undefined => ITEM_DEF_MAP.get(id);
    const loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
    for (const slot of LOADOUT_SLOTS) {
      const item = reviveItem(save.slots[slot], getDef, this.loot, 'Loadout');
      if (!item) continue;
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def || !slotAccepts(def, slot)) { console.warn(`[Loadout] '${item.defId}' cannot sit in slot ${slot} — dropped`); continue; }
      loadout[slot] = item;
    }
    this.loadout = loadout;
    const size = this.bagSizeOf(loadout.bag);
    this.bag.clear();
    this.bag.resize(size.cols, size.rows);
    const revived: (ItemInstance | null)[] = [];
    const pending: ItemInstance[] = [];
    for (const sv of save.bag) {
      const item = reviveItem(sv, getDef, this.loot, 'Loadout');
      revived.push(item);
      if (!item) continue;
      const cell = savedCell(sv);
      if (cell && this.bag.place(item, cell.x, cell.y, !!sv.rotated)) continue;
      pending.push(item);
    }
    for (const item of pending) {
      if (!this.bag.autoPlace(item)) { console.warn(`[Loadout] no room for '${item.defId}' on load — discarded`); revived[revived.indexOf(item)] = null; }
    }
    // quick slots: bag index → uid (locked slots keep their assignment, as they do in a session)
    this.quickSlots = createQuickSlots();
    save.quick.forEach((idx, i) => {
      const item = idx === null ? null : revived[idx];
      if (!item || !this.bag.has(item.uid) || !isQuickUsable(getDef(item.defId))) return;
      assignQuickSlot(this.quickSlots, i, item.uid);
    });
    return revived;
  }

  /** First `hub:entered` after a restored save: tell every consumer (they subscribed after our init). */
  private announceLoaded(): void {
    this.announcePending = false;
    this.lastEquipUids = {}; this.lastWeight = null;
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = '';
    this.ctx.bus.emit('inventory:bagChanged', { ...this.getBagSize(), dropped: [] });
    this.emitLoadout();
    this.afterChange();
  }

  /** Legacy mission failure (Phase 2 death flow no longer emits it): everything carried is lost (2026-09-07). */
  private onGameOver(): void {
    this.outcome = 'over';
    this.closeAll();
    this.clearContainers();
    this.loseKit();
  }

  /** Phase 2 death flow: the hellpod re-drop after `PLAYER_RESPAWN_DELAY` brings the starter kit (mission continues, crates keep their state). */
  private onRespawn(): void {
    this.closeAll();
    this.applyStarter();
  }

  /**
   * `game:abort` after a completed mission is just the hub's mechanical transition (result screen → ship): keep
   * the worn weapons for the workbench. After death the kit was already reset. Any other abort (quit mid-mission,
   * lobby lost, back to title) resets to the starter kit.
   */
  private onAbort(): void {
    this.closeAll();
    this.clearContainers();
    const outcome = this.outcome;
    this.outcome = 'none';
    if (outcome === 'complete' || outcome === 'over') return;
    this.loseKit();
  }

  private hasAnyWeapon(): boolean {
    for (const s of WEAPON_SLOT_IDS) if (this.loadout[s]) return true;
    return this.bag.items().some((p) => isWeaponItemDef(ITEM_DEF_MAP.get(p.item.defId)));
  }

  private isCompletelyEmpty(): boolean {
    return LOADOUT_SLOTS.every((s) => !this.loadout[s]) && this.bag.isEmpty;
  }

  /** Nothing to raid with anywhere: no loadout, empty bag **and** an empty 함선 창고 (2026-09-07 safety net). */
  private isDestitute(): boolean {
    return this.isCompletelyEmpty() && this.stash.count === 0;
  }

  /**
   * A failed / abandoned raid: everything the player carried is gone and they re-equip from the 함선 창고
   * (2026-09-07). Only a player whose stash is empty too falls back to the minimum kit.
   */
  private loseKit(): void {
    if (this.stash.count === 0) { this.applyStarter(); return; }
    this.bag.clear();
    this.loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
    const size = this.bagSizeOf(null);
    this.bag.resize(size.cols, size.rows);
    this.quickSlots.fill(null);
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = '';
    this.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
    this.emitLoadout();
    this.afterChange();
    this.announcePending = false;
    this.loadoutStore.saveNow('starter');
  }

  /**
   * 기본 지급품, once per profile (2026-09-07 fix). The old condition was `Stash.firstRun` — no `scav.stash` file —
   * which silently skipped every profile that existed before the grant did, and every profile whose 창고 was emptied
   * by an incoming (empty) server document. The state now lives in its own localStorage key:
   *   `none` → grant here (as a `fresh` document on a true first run, so a real server profile still wins) and mark
   *            `pending`; `pending` → re-checked once at `net:profileLoaded`, where the server's 창고 is known, and
   *            settled to `done` either way. A player who already owns something is settled without a grant.
   */
  private tryStarterGrant(): void {
    const state = starterGrantState();
    // already owns a 창고 → nothing to hand out, and never ask again
    if (this.stash.count > 0) { setStarterGrantState('done'); return; }
    // a grant made at init can still be replaced by an (empty) server 창고 document, so it stays `pending` until
    // the `net:profileLoaded` re-check has seen the result once — that call is the one that settles it.
    setStarterGrantState(state === 'none' ? 'pending' : 'done');
    if (this.stash.firstRun && state === 'none') this.withFreshSave(() => this.grantStarterStash());
    else this.grantStarterStash();
    // the minimum kit is equipped from `hub:entered`; a grant that lands after the player is already aboard equips now
    if (this.ctx.isHubPhase() && this.isCompletelyEmpty()) this.applyStarter();
    else this.firstRunGrant = true;
  }

  /**
   * `STARTER_STASH` into the 함선 창고 (2026-09-07); the "once per profile" decision is `tryStarterGrant`. `stacks`
   * splits an entry into that many full stacks — one 세트 per grid cell.
   */
  private grantStarterStash(): void {
    for (const e of STARTER_STASH) {
      const def = ITEM_DEF_MAP.get(e.id);
      if (!def) { console.warn(`[Inventory] 기본 지급품 '${e.id}' has no def`); continue; }
      for (let n = 0; n < Math.max(1, e.stacks ?? 1); n++) {
        const qty = Math.max(1, Math.min(e.qty, def.stackMax));
        if (!this.stash.grid.autoPlace(this.loot.createItem(e.id, qty))) {
          console.warn(`[Inventory] 함선 창고가 가득 차 기본 지급품 '${e.id}'를 넣지 못했습니다`);
          break;
        }
      }
    }
    this.stash.markDirty();
    this.stash.flush();
    this.ctx.bus.emit('inventory:stashChanged', { count: this.stash.count });
  }

  /** Wipe the bag + slots and apply `STARTER_LOADOUT` (`items[].qty` are units / rounds). */
  private applyStarter(): void {
    this.bag.clear();
    const mk = (id: string | null): ItemInstance | null => (id && ITEM_DEF_MAP.has(id) ? this.loot.createItem(id) : null);
    const bagItem = mk(STARTER_LOADOUT.bag);
    this.loadout = {
      primary: mk(STARTER_LOADOUT.primary),
      primary2: mk(STARTER_LOADOUT.primary2),
      secondary: mk(STARTER_LOADOUT.secondary),
      bag: bagItem,
      armor: mk(STARTER_LOADOUT.armor),
    };
    const size = this.bagSizeOf(bagItem);
    this.bag.resize(size.cols, size.rows);
    for (const e of STARTER_LOADOUT.items) this.addUnits(e.id, e.qty);
    autoAssignQuickSlots(this.quickSlots, this.getAllItems(), (id) => ITEM_DEF_MAP.get(id), this.getQuickSlotCount());
    this.lastGrenades = -1; this.lastStims = -1; this.lastQuickSig = ''; // force count / quick-slot events
    this.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: [] });
    this.emitLoadout();
    this.afterChange();
    // Phase 5: persist the starter right away so a reload cannot bring back a bag lost to death / abort
    this.announcePending = false;
    this.loadoutStore.saveNow('starter');
  }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout { return { ...this.loadout }; }

  getDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }

  getAllItems(): ItemInstance[] { return this.bag.items().map((p) => p.item); }

  getTotalValue(): number { return this.bag.totalValue(); }

  getBagSize(): BagSize { return this.bagSizeOf(this.loadout.bag); }

  /* ── appended: tactical kit — gear slots / weight / durability / crafting ── */

  getEquipped(slot: LoadoutSlot): ItemInstance | null { return this.loadout[slot] ?? null; }

  consumeDef(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDef(defId) < want) return false;
    return this.consumeWhere((d) => d.id === defId, want) === want;
  }

  private countDef(defId: string): number {
    return this.countWhere((d) => d.id === defId);
  }

  /** Bag + equipped gear weight against the character's carry capacity (근력 via `ctx.progression`). */
  getWeight(): WeightInfo {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    let w = sumWeight(this.bag.items().map((p) => p.item), (id) => ITEM_DEF_MAP.get(id));
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (!it) continue;
      const d = ITEM_DEF_MAP.get(it.defId);
      if (d) w += itemWeight(d, it.qty);
    }
    // bigger bags carry more: +0.5 kg of capacity per grid cell above the default bag
    const size = this.bagSizeOf(this.loadout.bag);
    const capacity = mult.carryCapacity + Math.max(0, size.cols * size.rows - BAG_DEFAULT_COLS * BAG_DEFAULT_ROWS) * 0.5;
    return makeWeightInfo(Math.round(w * 100) / 100, capacity, mult.carryRelief);
  }

  private emitWeight(): void {
    const info = this.getWeight();
    const prev = this.lastWeight;
    const same = prev && prev.state === info.state
      && Math.abs(prev.weight - info.weight) < 0.005 && Math.abs(prev.capacity - info.capacity) < 0.005;
    if (same) return;
    this.lastWeight = info;
    this.ctx.bus.emit('inventory:weightChanged', { weight: info.weight, capacity: info.capacity, ratio: info.ratio, state: info.state });
    if ((!prev || prev.state !== info.state) && (info.state === 'heavy' || info.state === 'over')) {
      this.ctx.bus.emit('inventory:overloaded', { state: info.state });
    }
  }

  /** Durability of a weapon (effective max) or armor (`ItemDef.durabilityMax`), or null. */
  getDurability(uid: string): DurabilityInfo | null {
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return null;
    const stats = this.loot.getEffectiveStats(item);
    if (stats) {
      const cur = Math.max(0, Math.min(stats.maxDurability, item.durability ?? stats.maxDurability));
      return { uid, durability: cur, max: stats.maxDurability, broken: cur <= 0 };
    }
    return durabilityInfo(item, def);
  }

  /** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
  damageDurability(uid: string, amount: number): void {
    const wear = Math.max(0, amount);
    if (wear === 0) return;
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    const max = def?.durabilityMax;
    if (!item || !def || max === undefined || max <= 0) return;
    const before = Math.max(0, Math.min(max, item.durability ?? max));
    if (before <= 0) return;
    const after = Math.max(0, before - wear);
    if (after === before) return;
    item.durability = after;
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: after, max });
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    if (after <= 0) {
      this.ctx.bus.emit('durability:broken', { uid, defId: def.id, name: def.name });
      this.ctx.bus.emit('ui:notify', { text: `${def.name} 파손!`, kind: 'danger' });
      this.ctx.bus.emit('audio:play', { id: 'gear_broken' });
    }
    if (this._open) this.ui?.refresh();
  }

  /**
   * Phase 12: refill cost of a 회복 스프레이 (`ItemDef.heal.spray`, gauge = `durability` / `durabilityMax`) — one 캔 +
   * one 소독약 per **full** refill, scaled by the missing fraction (ceil, never below 1 each). null for anything else
   * or a full can. The materials come from the bag, exactly like a weapon repair.
   */
  sprayRepairCost(item: ItemInstance, def: ItemDef): CraftIngredient[] | null {
    if (!def.heal?.spray) return null;
    const max = def.durabilityMax;
    if (max === undefined || max <= 0) return null;
    const cur = Math.max(0, Math.min(max, item.durability ?? max));
    if (cur >= max) return null;
    const missing = (max - cur) / max;
    return SPRAY_REFILL_COST.map((c) => ({ defId: c.defId, qty: Math.max(1, Math.ceil(c.qty * missing - 1e-9)) }));
  }

  /**
   * Ship workbench: weapons go through `repairWeapon` (materials), a 회복 스프레이 is refilled for `sprayRepairCost`
   * (Phase 12), armor is restored to full for free.
   */
  repair(uid: string): boolean {
    if (this.ctx.isRaidActive()) return false;
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    if (this.loot.getEffectiveStats(item)) {
      const ok = this.repairWeapon(uid);
      if (ok) this.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: item.durability ?? 0 });
      return ok;
    }
    const max = def.durabilityMax;
    if (max === undefined || max <= 0) return false;
    if ((item.durability ?? max) >= max) return false;
    const sprayCost = this.sprayRepairCost(item, def);
    if (sprayCost) {
      // all materials or nothing — the empty can stays a valid (0 / max) item until then
      for (const c of sprayCost) if (this.countDef(c.defId) < c.qty) return false;
      for (const c of sprayCost) this.consumeWhere((d) => d.id === c.defId, c.qty);
    }
    item.durability = max;
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    this.ctx.bus.emit('durability:changed', { uid, defId: def.id, durability: max, max });
    this.ctx.bus.emit('repair:completed', { uid, name: def.name, durability: max });
    this.ctx.bus.emit('audio:play', { id: 'gear_repair' });
    this.afterChange();
    return true;
  }

  /**
   * Context-menu repair readout (hub only): materials still needed for a weapon (`[]` = free / armor), `short`
   * = which of them the bag lacks. null when the item is not worn / not repairable.
   */
  repairInfo(uid: string): { cost: { defId: string; qty: number; name: string; have: number }[]; short: boolean } | null {
    const item = this.findItem(uid);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return null;
    const dur = this.getDurability(uid);
    if (!dur || dur.max <= 0 || dur.durability >= dur.max) return null;
    // weapons: the loot table's cost; 회복 스프레이 (Phase 12): 캔 + 소독약 scaled by the missing gauge; armor: free
    const raw = this.loot.getEffectiveStats(item) ? this.loot.getRepairCost(item) : this.sprayRepairCost(item, def) ?? [];
    const cost = raw.map((c) => ({
      ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: this.countDef(c.defId),
    }));
    return { cost, short: cost.some((c) => c.have < c.qty) };
  }

  /** 'ship' while walking the hub / menus, 'field' on a mission. */
  currentStation(): CraftStation {
    return this.ctx.isRaidActive() ? 'field' : 'ship';
  }

  /* ── Phase 6 (2026-09-06): 무한 상자 catalog ──────────────────────────── */

  /**
   * `/items` cheat: open the catalog panel (every item def, infinite stock) inside the inventory window — the ship
   * screen in the hub, the bag window on a mission. Opens the window itself when it is closed (blocker `'inventory'`).
   */
  openCatalog(opts?: { category?: ItemCategory }): void {
    const ctx = this.ctx;
    const category = opts?.category;
    if (this.catalogOpen) { if (category) this.ui?.catalog.setTabForCategory(category); return; }
    if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) {
      ctx.bus.emit('ui:notify', { text: '무한 상자는 함선이나 임무 중에만 열 수 있습니다', kind: 'warning', duration: 2 });
      return;
    }
    this.catalogOpen = true;
    if (!this._open) {
      this.activeContainer = null;
      this.hubMode = ctx.isHubPhase();
      this.setOpen(true);
      this.ui?.show(null, this.hubMode);
      ctx.bus.emit('inventory:opened', { containerId: null });
    }
    this.ui?.setCatalog(true);
    // Phase 9: `category` preselects the tab holding it (훈련장 무기 거치대 → 'primary'); unknown / unbuilt → 전체 stays
    if (category) this.ui?.catalog.setTabForCategory(category);
    ctx.bus.emit('ui:catalogToggled', { open: true });
  }

  /** Close the catalog panel; the rest of the window stays open. */
  closeCatalog(): void {
    if (!this.catalogOpen) return;
    this.catalogOpen = false;
    this.ui?.setCatalog(false);
    this.ctx.bus.emit('ui:catalogToggled', { open: false });
  }

  get isCatalogOpen(): boolean { return this.catalogOpen; }

  /** Units a catalog drag / double-click creates: a full stack for stackables, one otherwise. */
  catalogQty(def: ItemDef): number { return def.stackMax > 1 ? def.stackMax : 1; }

  /** Drag preview for a detached (catalog) instance over `target`: grids (free cell / merge) and equipment slots. */
  previewCatalog(item: ItemInstance, target: DropTarget): DropPreview {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return 'bad';
    if (target.kind === 'quick' || target.kind === 'weapon') return 'bad';
    if (target.kind === 'slot') {
      if (!slotAccepts(def, target.slot)) return 'bad';
      const current = this.loadout[target.slot];
      if (!current) return 'ok';
      if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
      return this.canStow(current) ? 'swap' : 'bad';
    }
    const grid = this.getGrid(target.grid);
    if (!grid) return 'bad';
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    const other = grid.get(blockers[0]);
    return other && other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax ? 'merge' : 'bad';
  }

  /**
   * Release a catalog drag: the fresh instance lands in the grid cell (or merges into the stack there) / the slot
   * (displaced gear → bag, else stash in the ship). The catalog tile is untouched. 'fail' → the UI shakes the tile.
   */
  dropFromCatalog(item: ItemInstance, target: DropTarget): OpResult {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || this.previewCatalog(item, target) === 'bad') return 'fail';
    if (target.kind === 'slot') {
      const slot = target.slot;
      if (slot === 'bag') {
        if (this.changeBag(item, null, 'grid') !== 'ok') return 'fail';
        this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
        return 'ok';
      }
      const current = this.loadout[slot];
      if (current) {
        const dest = this.stow(current);
        if (!dest) return 'fail';
        const cd = ITEM_DEF_MAP.get(current.defId);
        if (cd) this.emitTransfer(current, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
      }
      this.loadout[slot] = item;
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    if (target.kind !== 'grid') return 'fail';
    const grid = this.getGrid(target.grid);
    if (!grid) return 'fail';
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, item.uid);
    if (blockers.length === 0) {
      if (!grid.place(item, target.x, target.y, target.rotated)) return 'fail';
    } else {
      const other = grid.get(blockers[0]);
      if (!other || grid.mergeInto(item, other.item.uid) <= 0) return 'fail';
    }
    if (target.grid === 'bag') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return 'ok';
  }

  /** Catalog double-click: a fresh instance straight into the bag (merge into stacks first). */
  takeFromCatalog(defId: string): OpResult {
    const def = ITEM_DEF_MAP.get(defId);
    if (!def || !this.catalogOpen) return 'fail';
    const item = this.loot.createItem(defId, this.catalogQty(def));
    if (!this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return 'fail';
    }
    this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return 'ok';
  }

  /** Where displaced gear can go: the bag, else the ship stash (hub only). */
  private canStow(item: ItemInstance): boolean {
    return this.bag.canAbsorb(item) || (this.ctx.isHubPhase() && this.stash.grid.canAbsorb(item));
  }

  /** Put a detached item into the bag, else the stash (ship). Returns where it went, null when nothing fits. */
  private stow(item: ItemInstance): GridId | null {
    if (this.bag.autoPlace(item)) return 'bag';
    if (this.ctx.isHubPhase() && this.stash.grid.autoPlace(item)) return 'stash';
    return null;
  }

  /* ── Phase 6: stash size (housing 창고 facility) ─────────────────────── */

  getStashSize(): { cols: number; rows: number } { return { cols: this.stash.cols, rows: this.stash.rows }; }

  /** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
  setStashSize(cols: number, rows: number): boolean {
    if (!this.stash.resize(cols, rows)) return false;
    this.afterChange(); // stash version changed → markDirty + inventory:stashChanged + UI re-render
    return true;
  }

  /* ── Phase 6: materials across bag + stash (facility upgrades / furniture) ── */

  countDefAll(defId: string): number { return this.countDef(defId) + this.stashCountDef(defId); }

  private stashCountDef(defId: string): number {
    let n = 0;
    for (const p of this.stash.grid.items()) if (p.item.defId === defId) n += p.item.qty;
    return n;
  }

  /** Bag first, then the stash; all-or-nothing. */
  consumeDefAll(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDefAll(defId) < want) return false;
    let left = want;
    const fromBag = Math.min(left, this.countDef(defId));
    if (fromBag > 0) left -= this.consumeWhere((d) => d.id === defId, fromBag);
    if (left > 0) {
      const stash = this.stash.grid;
      const matches = stash.items().filter((p) => p.item.defId === defId).sort((a, b) => a.item.qty - b.item.qty);
      for (const p of matches) {
        if (left <= 0) break;
        const take = Math.min(left, p.item.qty);
        p.item.qty -= take; left -= take;
        if (p.item.qty <= 0) stash.remove(p.item.uid);
        else stash.version++;
      }
      this.afterChange();
    }
    return left === 0;
  }

  /* ── Phase 6: loadout presets (사격장) ───────────────────────────────── */

  captureLoadout(): LoadoutPreset {
    const l = this.loadout;
    return {
      name: '프리셋', primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null, secondary: l.secondary?.defId ?? null,
      bag: l.bag?.defId ?? null, armor: l.armor?.defId ?? null,
      implant: this.ctx.progression?.profile.implant ?? this.ctx.implants?.equipped ?? null,
    };
  }

  /**
   * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
   * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
   * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
   * Ship only — on a mission nothing changes and the result is empty.
   */
  applyLoadout(preset: LoadoutPreset): { equipped: number; missing: string[] } {
    if (!this.ctx.isHubPhase()) return { equipped: 0, missing: [] };
    let equipped = 0;
    const missing: string[] = [];
    for (const slot of LOADOUT_SLOTS) {
      const want = preset[slot];
      if (want === null || want === undefined) continue;
      const cur = this.loadout[slot];
      if (cur?.defId === want) { equipped++; continue; }
      const found = this.findStoredByDef(want);
      if (!found) {
        missing.push(want);
        if (cur) this.unequipToStorage(slot);
        continue;
      }
      if (this.equipFromStorage(found.item, found.grid, slot)) equipped++;
      else missing.push(want);
    }
    if (preset.implant !== null && preset.implant !== undefined) {
      const imp = this.ctx.implants;
      if (imp?.equipped === preset.implant) equipped++;
      else if (imp && typeof imp.setEquipped === 'function' && imp.setEquipped(preset.implant)) equipped++;
      else missing.push(preset.implant);
    }
    this.emitLoadout();
    this.afterChange();
    return { equipped, missing };
  }

  /** First instance of `defId` in the bag, then the stash. */
  private findStoredByDef(defId: string): { item: ItemInstance; grid: GridId } | null {
    for (const gridId of ['bag', 'stash'] as const) {
      const p = this.getGrid(gridId)?.items().find((q) => q.item.defId === defId);
      if (p) return { item: p.item, grid: gridId };
    }
    return null;
  }

  /** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
  private unequipToStorage(slot: LoadoutSlot): boolean {
    const cur = this.loadout[slot];
    if (!cur) return true;
    if (slot === 'bag') {
      // the old bag lands in the shrunk grid (priority), else the ship stash through `throwToWorld`
      if (this.changeBag(null, null, 'grid') === 'ok') return true;
      return this.changeBag(null, null, 'world') === 'ok';
    }
    this.loadout[slot] = null;
    const dest = this.stow(cur);
    if (!dest) { this.loadout[slot] = cur; return false; }
    const def = ITEM_DEF_MAP.get(cur.defId);
    if (def) this.emitTransfer(cur, def, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
    return true;
  }

  /** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
  private equipFromStorage(item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean {
    const def = ITEM_DEF_MAP.get(item.defId);
    const grid = this.getGrid(gridId);
    if (!def || !grid || !slotAccepts(def, slot)) return false;
    const from: ItemLocation = { kind: 'grid', grid: gridId };
    if (slot === 'bag') {
      let r = this.changeBag(item, from, 'grid');
      if (r === 'fail' && this.loadout.bag) {
        // the displaced bag does not fit the new grid: park it in the stash first, then retry
        if (this.moveToStash(this.loadout.bag.uid, { kind: 'slot', slot: 'bag' }) !== 'ok') return false;
        const again = this.locate(item.uid);
        if (!again || again.from.kind !== 'grid') return false;
        r = this.changeBag(item, again.from, 'grid');
      }
      return r === 'ok';
    }
    const cur = this.loadout[slot];
    const src = grid.get(item.uid);
    if (!src) return false;
    const sx = src.x, sy = src.y, srot = item.rotated;
    grid.remove(item.uid);
    if (cur) {
      this.loadout[slot] = null;
      let dest: GridId | null = this.stow(cur);
      if (!dest && grid.autoPlace(cur)) dest = gridId;
      if (!dest) { this.loadout[slot] = cur; grid.place(item, sx, sy, srot); return false; }
      const cd = ITEM_DEF_MAP.get(cur.defId);
      if (cd) this.emitTransfer(cur, cd, { kind: 'slot', slot }, { kind: 'grid', grid: dest });
    }
    this.loadout[slot] = item;
    this.emitTransfer(item, def, from, { kind: 'slot', slot });
    return true;
  }

  /* ── Phase 6: 작업실 bench crafting ─────────────────────────────────── */

  /**
   * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
   * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
   */
  openBenchCraft(bench: WorkbenchKind, level: number): void {
    const ctx = this.ctx;
    if (!ctx.isHubPhase()) {
      ctx.bus.emit('ui:notify', { text: '작업대는 함선에서만 사용할 수 있습니다', kind: 'warning', duration: 2 });
      return;
    }
    this.bench = { kind: bench, level: Math.max(0, Math.floor(level)) };
    if (!this._open) {
      this.activeContainer = null;
      this.hubMode = true;
      this.setOpen(true);
      this.ui?.show(null, true);
      ctx.bus.emit('inventory:opened', { containerId: null });
    }
    this.ui?.setCraftOpen(true);
    ctx.bus.emit('ui:craftToggled', { open: true });
  }

  /** Bench the craft panel is showing (null = plain 제작 panel). */
  getBench(): ActiveBench | null { return this.bench; }

  /** Leave bench mode (panel 닫기 / window closed). The window itself stays open. */
  closeBench(): void {
    if (!this.bench) return;
    this.bench = null;
    this.cancelCraft();
    this.ui?.setCraftOpen(false);
    this.ctx.bus.emit('ui:craftToggled', { open: false });
  }

  /** Rows for the craft panel: available recipes, then (bench mode) the bench's recipes above its level as locked. */
  getBenchRecipes(): BenchRecipeRow[] {
    const b = this.bench;
    if (!b) return this.getRecipes(this.currentStation()).filter((r) => !isDisassembleRecipe(r)).map((recipe) => ({ recipe, locked: false }));
    const open = this.getRecipes('ship', b.kind, b.level).filter((r) => !isDisassembleRecipe(r));
    const skillOf = (id: CraftRecipe['skill']): number => this.ctx.progression?.getSkill(id) ?? 0;
    const locked = this.loot.getAllRecipes().filter((r) =>
      r.station === 'ship' && r.bench === b.kind && (r.benchLevel ?? 1) > b.level && skillOf(r.skill) >= r.skillRequired);
    return [...open.map((recipe) => ({ recipe, locked: false })), ...locked.map((recipe) => ({ recipe, locked: true }))];
  }

  /** Gear the active bench repairs: gun → weapons (slots + bag), gear → armor + bags, others none. Items without durability are skipped. */
  benchRepairRows(): BenchRepairRow[] {
    const b = this.bench;
    if (!b || (b.kind !== 'gun' && b.kind !== 'gear')) return [];
    const wants = (def: ItemDef): boolean => b.kind === 'gun' ? isWeaponItemDef(def) : (def.category === 'armor' || def.category === 'bag');
    const rows: BenchRepairRow[] = [];
    const push = (item: ItemInstance, where: LoadoutSlot | null): void => {
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def || !wants(def)) return;
      const dur = this.getDurability(item.uid);
      if (!dur || dur.max <= 0) return;
      const cost = (this.loot.getEffectiveStats(item) ? this.loot.getRepairCost(item) : []).map((c) => ({
        ...c, name: ITEM_DEF_MAP.get(c.defId)?.name ?? c.defId, have: this.countDef(c.defId),
      }));
      rows.push({ uid: item.uid, item, def, where, dur, cost, short: cost.some((c) => c.have < c.qty) });
    };
    for (const slot of LOADOUT_SLOTS) { const it = this.loadout[slot]; if (it) push(it, slot); }
    for (const p of this.bag.items()) push(p.item, null);
    return rows;
  }

  /** `모두 수리`: every worn row in order while the materials last. */
  benchRepairAll(): { done: number; skipped: number } {
    let done = 0, skipped = 0;
    for (const row of this.benchRepairRows()) {
      if (row.dur.durability >= row.dur.max) continue;
      if (row.short) { skipped++; continue; }
      if (this.repair(row.uid)) done++; else skipped++;
    }
    return { done, skipped };
  }

  /**
   * Recipes for a station given the current skills. Field: `station: 'field'` recipes only. Ship: field recipes
   * too; a recipe with `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed
   * bench of that kind at that level (`ctx.housing.getBenchLevel`, 0 without housing).
   */
  getRecipes(station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] {
    const skillOf = (id: CraftRecipe['skill']): number => this.ctx.progression?.getSkill(id) ?? 0;
    const housing = this.ctx.housing;
    const placedLevel = (kind: WorkbenchKind): number =>
      housing && typeof housing.getBenchLevel === 'function' ? Math.max(0, housing.getBenchLevel(kind) || 0) : 0;
    return this.loot.getAllRecipes().filter((r) => {
      if (skillOf(r.skill) < r.skillRequired) return false;
      if (station === 'field') return r.station === 'field';
      if (r.bench === undefined) return true;
      const need = r.benchLevel ?? 1;
      if (bench !== undefined) return r.bench === bench && need <= level;
      return placedLevel(r.bench) >= need;
    });
  }

  /**
   * Phase 8 — 분해 recipe of an item the player owns, or null. A `break_*` recipe whose **only** input is that
   * item's def id counts; the UI turns it into the `분해` context-menu entry and the modeless dialog. Crafting
   * itself is unchanged (`craft()` still accepts these recipes) — they are only hidden from the craft *list*.
   */
  disassembleRecipeFor(uid: string): CraftRecipe | null {
    const item = this.findItem(uid);
    if (!item) return null;
    for (const r of this.loot.getAllRecipes()) {
      if (!isDisassembleRecipe(r)) continue;
      if (r.inputs.length === 1 && r.inputs[0].defId === item.defId) return r;
    }
    return null;
  }

  /**
   * Open the modeless 분해 dialog over the open window (the item context menu's `분해` entry; also a handle for
   * the console / smoke tests). False when the window is closed or the item has no `break_*` recipe.
   */
  openDisassemble(uid: string): boolean {
    if (!this._open) return false;
    return this.ui?.openDisassemble(uid) ?? false;
  }

  /** Recipes the running station / bench may craft right now. */
  private availableRecipes(): readonly CraftRecipe[] {
    const b = this.bench;
    return b ? this.getRecipes('ship', b.kind, b.level) : this.getRecipes(this.currentStation());
  }

  /** Workshop material discount (`ctx.housing.getCraftCostMul`, ship only); 1 when nothing applies. */
  craftCostMul(): number {
    if (this.currentStation() !== 'ship') return 1;
    const h = this.ctx.housing;
    const m = h && typeof h.getCraftCostMul === 'function' ? h.getCraftCostMul() : 1;
    return Number.isFinite(m) && m > 0 && m < 1 ? m : 1;
  }

  /** Inputs of a recipe after the workshop discount (ceil, never below 1). */
  craftCost(recipe: CraftRecipe): CraftIngredient[] {
    const mul = this.craftCostMul();
    return recipe.inputs.map((i) => ({ defId: i.defId, qty: Math.max(1, Math.ceil(i.qty * mul - 1e-9)) }));
  }

  canCraft(recipeId: string): boolean {
    const r = getRecipe(recipeId);
    if (!r) return false;
    return this.craftCost(r).every((i) => this.countDef(i.defId) >= i.qty);
  }

  /** Seconds one craft takes right now (recipe duration scaled by 제작 skill and 재주). */
  craftDuration(recipeId: string): number {
    const r = getRecipe(recipeId);
    if (!r) return 0;
    const mult = gearMultipliers(this.ctx.progression?.derived);
    const speed = Math.max(CRAFT_MIN_SPEED, mult.craftSpeedMul * mult.useSpeedMul);
    return r.duration / speed;
  }

  craft(recipeId: string): Promise<ItemInstance | null> {
    const r = getRecipe(recipeId);
    if (!r) return Promise.resolve(null);
    this.cancelCraft();
    if (this.availableRecipes().indexOf(r) < 0 || !this.canCraft(recipeId)) {
      this.ctx.bus.emit('craft:failed', { recipeId, reason: 'missing' });
      return Promise.resolve(null);
    }
    const duration = this.craftDuration(recipeId);
    this.ctx.bus.emit('craft:started', { recipeId, duration });
    return new Promise<ItemInstance | null>((resolve) => {
      this.craftJob = { recipe: r, remaining: duration, duration, resolve };
    });
  }

  /** Abort the running craft (releasing the hold button, closing the panel, dying). */
  cancelCraft(): boolean {
    const job = this.craftJob;
    if (!job) return false;
    this.craftJob = null;
    this.ctx.bus.emit('craft:failed', { recipeId: job.recipe.id, reason: 'cancelled' });
    job.resolve(null);
    this.ui?.refreshCraft();
    return true;
  }

  /** 0..1 progress of the running craft (null when idle). */
  craftProgress(): { recipeId: string; progress: number } | null {
    const job = this.craftJob;
    if (!job) return null;
    return { recipeId: job.recipe.id, progress: 1 - Math.max(0, job.remaining) / Math.max(0.001, job.duration) };
  }

  private updateCraft(dt: number): void {
    const job = this.craftJob;
    if (!job || dt <= 0) return;
    job.remaining -= dt;
    if (job.remaining > 0) { this.ui?.refreshCraft(); return; }
    this.craftJob = null;
    const r = job.recipe;
    const outDef = ITEM_DEF_MAP.get(r.outputDefId);
    if (!this.canCraft(r.id) || !outDef) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'missing' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    const product = this.loot.createItem(r.outputDefId, Math.min(outDef.stackMax, r.outputQty));
    if (!this.bag.canAbsorb(product)) {
      this.ctx.bus.emit('craft:failed', { recipeId: r.id, reason: 'space' });
      this.ctx.bus.emit('ui:notify', { text: '가방에 공간이 없습니다', kind: 'warning' });
      job.resolve(null);
      this.ui?.refreshCraft();
      return;
    }
    for (const i of this.craftCost(r)) this.consumeDef(i.defId, i.qty);
    const made = this.addUnits(r.outputDefId, r.outputQty);
    const first = made[0] ?? product;
    this.ctx.bus.emit('inventory:itemAdded', { item: first, name: outDef.name, rarity: outDef.rarity });
    this.ctx.bus.emit('craft:completed', { recipeId: r.id, item: first });
    this.ctx.bus.emit('audio:play', { id: 'craft_done' });
    this.afterChange();
    this.ui?.refreshCraft();
    job.resolve(first);
  }

  countWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean): number {
    let n = 0;
    for (const p of this.bag.items()) {
      const def = ITEM_DEF_MAP.get(p.item.defId);
      if (def && pred(def, p.item)) n += p.item.qty;
    }
    return n;
  }

  consumeWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean, qty: number): number {
    let left = Math.max(0, Math.floor(qty));
    if (left === 0) return 0;
    let consumed = 0;
    // consume smallest stacks first so partial stacks disappear before full ones
    const matches = this.bag.items()
      .filter((p) => { const d = ITEM_DEF_MAP.get(p.item.defId); return !!d && pred(d, p.item); })
      .sort((a, b) => a.item.qty - b.item.qty);
    for (const p of matches) {
      if (left <= 0) break;
      const take = Math.min(left, p.item.qty);
      p.item.qty -= take; left -= take; consumed += take;
      if (p.item.qty <= 0) this.removeEmptyStack(p.item);
      else this.bag.version++;
    }
    if (consumed > 0) this.afterChange();
    return consumed;
  }

  /* ── quick-use wheel (InventoryRef) ────────────────────────────────────── */

  /** Wheel slots resolved to live bag items (null = empty or the stack left the bag). */
  getQuickSlots(): readonly (ItemInstance | null)[] {
    return this.quickSlots.map((uid) => (uid === null ? null : this.bag.get(uid)?.item ?? null));
  }

  /** Usable wheel slots for the equipped bag (clamped to QUICK_SLOTS; tactical legendary bags define 9). */
  getQuickSlotCount(): number {
    return Math.min(QUICK_SLOTS, this.getBagSize().quickSlots);
  }

  /**
   * Assign bag item `uid` (stim / grenade) to wheel slot `index`, or clear it with null. A uid lives in one slot
   * only, so assigning it elsewhere moves it. Locked slots (`!isQuickSlotActive(index, getQuickSlotCount())`,
   * unlock order N S E W then diagonals) can be cleared but not filled.
   */
  setQuickSlot(index: number, uid: string | null): boolean {
    if (!isQuickIndex(index)) return false;
    if (uid !== null) {
      const item = this.bag.get(uid)?.item;
      if (!item || !isQuickUsable(ITEM_DEF_MAP.get(item.defId))) return false;
      if (!isQuickSlotActive(index, this.getQuickSlotCount())) return false;
    }
    if (assignQuickSlot(this.quickSlots, index, uid)) {
      this.bag.version++; // bag tiles carry the direction badge
      this.syncQuickSlots();
      this.ui?.refresh();
    }
    return true;
  }

  /** Slot index of bag item `uid`, or -1 (UI badges / menu state). */
  quickIndexOf(uid: string): number { return quickSlotOf(this.quickSlots, uid); }

  /** Context menu `빠른 슬롯에 등록`: first free usable slot. 'noop' when already assigned, 'fail' when none is free / not usable. */
  registerQuick(uid: string): OpResult {
    if (this.quickIndexOf(uid) >= 0) return 'noop';
    const index = firstFreeQuickSlot(this.quickSlots, this.getQuickSlotCount());
    if (index < 0) return 'fail';
    return this.setQuickSlot(index, uid) ? 'ok' : 'fail';
  }

  /**
   * Weapons: a stim was injected / a grenade thrown from this exact bag stack. Removes up to `qty` units and
   * returns the count. At 0 the stack leaves the bag (`inventory:itemRemoved`); its wheel slot moves to another
   * stack of the same item when one is free, else clears (`inventory:quickSlotsChanged`).
   */
  consumeItem(uid: string, qty = 1): number {
    const p = this.bag.get(uid);
    const n = Math.min(Math.max(0, Math.floor(qty)), p?.item.qty ?? 0);
    if (!p || n <= 0) return 0;
    p.item.qty -= n;
    if (p.item.qty <= 0) this.removeEmptyStack(p.item);
    else this.bag.version++;
    this.afterChange();
    return n;
  }

  /** A bag stack hit 0: drop it from the grid, hand its wheel slot to a sibling stack of the same def, emit removed. */
  private removeEmptyStack(item: ItemInstance): void {
    this.bag.remove(item.uid);
    if (quickSlotOf(this.quickSlots, item.uid) >= 0) {
      const sibling = this.bag.items().find((q) => q.item.defId === item.defId && !this.quickSlots.includes(q.item.uid));
      if (sibling) relinkQuickSlot(this.quickSlots, item.uid, sibling.item.uid);
    }
    this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  /** Prune slots whose stack left the bag, then emit `inventory:quickSlotsChanged` when anything the HUD shows changed. */
  private syncQuickSlots(): void {
    pruneQuickSlots(this.quickSlots, (uid) => this.bag.has(uid));
    const active = this.getQuickSlotCount();
    const sig = quickSlotsSignature(this.quickSlots, (uid) => this.bag.get(uid)?.item ?? null, active);
    if (sig === this.lastQuickSig) return;
    this.lastQuickSig = sig;
    this.ctx.bus.emit('inventory:quickSlotsChanged', { slots: [...this.getQuickSlots()], active });
  }

  tryAddItem(item: ItemInstance): boolean {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    if (!this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return false;
    }
    this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return true;
  }

  /**
   * Drop `qty` units (default: the whole stack) of `uid` into the world. Searches the bag, the open container
   * and the equipment slots. Emits `inventory:itemRemoved` (player-owned only), `loadout:changed` (slots) and
   * `inventory:itemDropped` — `pickups/` spawns the world object from that. Weapons travel whole (sockets,
   * durability, rounds stay on the instance). Dropping the equipped bag shrinks the grid first (`changeBag`).
   */
  dropItem(uid: string, qty?: number): boolean {
    const found = this.locate(uid);
    if (!found) return false;
    if (this.isContainerLoc(found.from)) {
      // Phase 7: a container item thrown into the world is a take (host-confirmed in multiplayer)
      const n = qty === undefined ? null : Math.floor(qty);
      const r = this.guardedTake(uid, found.from, n, () => (this.dropItemImpl(uid, qty) ? 'ok' : 'fail'));
      return r === 'ok' || r === 'pending';
    }
    return this.dropItemImpl(uid, qty);
  }

  private dropItemImpl(uid: string, qty?: number): boolean {
    // in the ship `throwToWorld` lands the item in the stash first (no ground to drop onto)
    const found = this.locate(uid);
    if (!found) return false;
    const { item, from } = found;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    const want = qty === undefined ? item.qty : Math.floor(qty);
    if (!Number.isFinite(want) || want < 1) return false;
    const n = Math.min(want, item.qty);

    if (from.kind === 'slot' && from.slot === 'bag') return this.changeBag(null, null, 'world') === 'ok';

    let dropped: ItemInstance;
    if (n >= item.qty) {
      this.detach(item, from);
      dropped = item;
    } else {
      dropped = this.loot.createItem(item.defId, n);
      item.qty -= n;
      if (from.kind === 'grid') { const g = this.getGrid(from.grid); if (g) g.version++; }
    }
    this.throwToWorld(dropped, this.locKind(from) === 'player');
    if (from.kind === 'slot') this.emitLoadout();
    this.afterChange();
    return true;
  }

  /**
   * Split `qty` units off stack `uid` into a brand-new stack placed at the first free slot of the same grid.
   * False when the item is not stackable, `qty` is not in 1..qty-1, or there is no free cell.
   */
  splitItem(uid: string, qty: number): boolean {
    const found = this.locateInGrids(uid);
    if (!found) return false;
    const { item, grid } = found;
    // Phase 7: an unsearched item stays untouched; in multiplayer a split inside the container would create a stack
    // the host cannot address (no roll index)
    if (found.gridId === 'container' && (item.searched === false || this.ctx.isMultiplayer)) return false;
    const def = ITEM_DEF_MAP.get(item.defId);
    const n = Math.floor(qty);
    if (!def || def.stackMax <= 1 || !Number.isFinite(n) || n < 1 || n >= item.qty) return false;
    const created = this.loot.createItem(item.defId, n);
    const slot = grid.findFreeSlot(created, item.rotated);
    if (!slot || !grid.place(created, slot.x, slot.y, slot.rotated)) return false;
    item.qty -= n;
    this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
    this.afterChange();
    return true;
  }

  /** Any player-owned item: bag → equipment slots → attachments socketed in an owned weapon. */
  findItem(uid: string, from?: ItemLocation): ItemInstance | null {
    if (from) {
      if (from.kind === 'slot') return this.loadout[from.slot]?.uid === uid ? (this.loadout[from.slot] ?? null) : null;
      return this.getGrid(from.grid)?.get(uid)?.item ?? null;
    }
    const p = this.bag.get(uid);
    if (p) return p.item;
    for (const s of LOADOUT_SLOTS) {
      const it = this.loadout[s];
      if (it?.uid === uid) return it;
    }
    return findSocketed(this.ownedWeapons(), uid)?.item ?? null;
  }

  /** Patch persistent instance fields (weapons write `ammoInMag` / `durability` here every shot). */
  updateItem(uid: string, patch: Partial<Pick<ItemInstance, 'durability' | 'ammoInMag'>>): boolean {
    const item = this.findItem(uid);
    if (!item) return false;
    if (patch.durability !== undefined) item.durability = Math.max(0, patch.durability);
    if (patch.ammoInMag !== undefined) item.ammoInMag = Math.max(0, patch.ammoInMag);
    if (this.bag.has(uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    this.afterChange();
    return true;
  }

  /** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
  attachToWeapon(weaponUid: string, attachmentUid: string): boolean {
    const w = this.locate(weaponUid);
    const a = this.locate(attachmentUid);
    if (!w || !a || a.from.kind !== 'grid') return false;
    return this.attachFrom(attachmentUid, a.from, weaponUid, w.from) === 'ok';
  }

  /** Every attachment of weapon `uid` back into the bag (overflow drops to the ground). False when none / not found. */
  detachAllSockets(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player' || !isWeaponItemDef(ITEM_DEF_MAP.get(w.item.defId))) return false;
    const weapon = w.item;
    let n = 0;
    for (const socket of SOCKET_SLOTS) {
      const att = clearSocket(weapon, socket);
      if (!att) continue;
      n++;
      if (!this.bag.autoPlace(att)) this.throwToWorld(att, true);
      this.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: null });
    }
    if (n === 0) return false;
    this.afterSocketChange(weapon);
    this.afterChange();
    return true;
  }

  /** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
  unloadWeapon(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player') return false;
    const weapon = w.item;
    const stats = this.loot.getEffectiveStats(weapon);
    const rounds = Math.floor(weapon.ammoInMag ?? 0);
    if (!stats || rounds <= 0) return false;
    weapon.ammoInMag = 0;
    this.returnRounds(stats.ammoType, rounds);
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
    this.afterChange();
    return true;
  }

  /** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
  repairWeapon(uid: string): boolean {
    const w = this.locate(uid);
    if (!w || this.locKind(w.from) !== 'player') return false;
    const weapon = w.item;
    const stats = this.loot.getEffectiveStats(weapon);
    const cost = this.loot.getRepairCost(weapon);
    if (!stats || cost.length === 0) return false;
    for (const c of cost) if (this.countWhere((d) => d.id === c.defId) < c.qty) return false;
    for (const c of cost) this.consumeWhere((d) => d.id === c.defId, c.qty);
    weapon.durability = stats.maxDurability;
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
    this.afterChange();
    return true;
  }

  /** Equip a bag / container item into `slot`, move a weapon between the primary slots, or unequip with null. */
  equip(uid: string | null, slot: LoadoutSlot): boolean {
    if (uid === null) {
      const cur = this.loadout[slot];
      if (!cur) return false;
      return this.quickMove(cur.uid, { kind: 'slot', slot }) === 'ok';
    }
    const found = this.locate(uid);
    const def = found && ITEM_DEF_MAP.get(found.item.defId);
    if (!found || !def) return false;
    const r = this.guardedTake(uid, found.from, null, () => this.dropOnSlot(found.item, def, found.from, slot));
    return r === 'ok' || r === 'pending';
  }

  /** Context menu `창고로 이동` on an equipped item (hub only): unequip straight into the stash. The bag slot shrinks the grid first. */
  moveToStash(uid: string, from: ItemLocation): OpResult {
    if (!this.hubMode) return 'fail';
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (from.kind === 'grid' && from.grid === 'stash') return 'noop';
    if (from.kind === 'slot' && from.slot === 'bag') {
      // bag → grid first (its contents must survive the shrink), then the bag itself → stash
      const r = this.changeBag(null, null, 'grid');
      if (r !== 'ok') return r;
      const found = this.locate(uid);
      if (!found || found.from.kind !== 'grid') return 'ok';
      from = found.from;
    }
    const stash = this.stash.grid;
    if (!stash.canAbsorb(item)) { this.ctx.bus.emit('ui:notify', { text: '창고에 공간이 없습니다', kind: 'warning' }); return 'fail'; }
    this.detach(item, from);
    stash.autoPlace(item);
    this.afterMove(item, from, { kind: 'grid', grid: 'stash' });
    return 'ok';
  }

  /** Quick chat: ammo request for weapons, "<name> 필요" for anything else (`chat:post`, kind 'request'). */
  requestItem(uid: string, from: ItemLocation): boolean {
    if (this.isItemLocked(uid, from)) return false;
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    const stats = this.loot.getEffectiveStats(item);
    const text = stats ? `탄약 요청: ${def.name} (${AMMO_LABEL_KO[stats.ammoType]})` : `${def.name} 필요`;
    this.ctx.bus.emit('chat:post', { text, kind: 'request' });
    return true;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    const first = !this.openedIds.has(containerId);
    this.openedIds.add(containerId);
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed);
    this.showContainer(c);
    this.ctx.bus.emit('inventory:containerOpened', { containerId, first });
  }

  /**
   * Loot window for a container whose contents the caller supplies (corpses: `ctx.loot.rollCorpse`).
   * `items` are placed only on the first open of `containerId` (largest-first on the fixed 6×4 grid,
   * overflow dropped with a warning); a known id shows what is left. Title defaults to `컨테이너`.
   */
  openContainerItems(containerId: string, items: ItemInstance[], position: THREE.Vector3, title?: string): void {
    const first = !this.openedIds.has(containerId);
    this.openedIds.add(containerId);
    const c = this.containers.getOrCreateWithItems(containerId, items, position, title);
    this.showContainer(c);
    this.ctx.bus.emit('inventory:containerOpened', { containerId, first });
  }

  private showContainer(c: Container): void {
    this.activeContainer = c;
    this.hubMode = false;
    this.setOpen(true);
    this.ui?.show(c, false);
    this.ctx.bus.emit('inventory:opened', { containerId: c.id });
    this.checkLooted();
  }

  toggleBag(): void {
    if (this._open) { this.closeAll(); return; }
    this.activeContainer = null;
    this.hubMode = this.ctx.isHubPhase();
    this.setOpen(true);
    this.ui?.show(null, this.hubMode);
    this.ctx.bus.emit('inventory:opened', { containerId: null });
  }

  /** true while the hub screen (with the stash) is what the window shows. */
  get isHubScreen(): boolean { return this._open && this.hubMode; }

  /**
   * Open the Tab window in ship mode on a **screen tab** (2026-09-07). The 기업 네트워크 console uses this: the corp
   * screen has no overlay of its own any more, it is the window's 기업 tab. Ship-only (the embedded screens are), and
   * returns false when the tab could not be shown (wrong phase, the owning folder missing).
   */
  openScreen(tab: ScreenTab): boolean {
    if (!this.ctx.isHubPhase()) return false;
    if (!this._open) {
      this.activeContainer = null;
      this.hubMode = true;
      this.setOpen(true);
      this.ui?.show(null, true);
      this.ctx.bus.emit('inventory:opened', { containerId: null });
    }
    return this.ui?.showScreenTab(tab) ?? false;
  }

  /** Screen tab the window is showing (`'inventory'` while it is closed). */
  get screenTab(): ScreenTab { return this._open ? this.ui?.screenTab ?? 'inventory' : 'inventory'; }

  /** Ship stash grid (persisted). */
  getStash(): Grid { return this.stash.grid; }
  getStashItems(): ItemInstance[] { return this.stash.items(); }

  /**
   * Phase 9 UI pass: the player's real 가방 / 함선 창고 grids embedded in another folder's screen (기업 거래).
   * `ui/TradeGrids.ts` is read + drag-out only and mutates nothing — see `InventoryRef.createTradeGrids`.
   */
  createTradeGrids(host: HTMLElement, opts: TradeGridsViewOptions = {}): EmbeddedView {
    return new TradeGrids(this, this.ctx, host, opts as TradeGridsOptions);
  }

  /* ── Phase 5: corp shop / stash access (InventoryRef) ─────────────────── */

  /** Bag → slots → sockets of owned weapons → stash (incl. sockets of stashed weapons). */
  findItemAnywhere(uid: string): ItemInstance | null {
    const owned = this.findItem(uid);
    if (owned) return owned;
    const stashed = this.stash.grid.get(uid)?.item;
    if (stashed) return stashed;
    const stashWeapons = this.stash.items().filter((it) => isWeaponItemDef(ITEM_DEF_MAP.get(it.defId)));
    return findSocketed(stashWeapons, uid)?.item ?? null;
  }

  /** Auto-place a fresh instance in the stash (merging into stacks first). Persists + `inventory:stashChanged`. */
  tryAddToStash(item: ItemInstance): boolean {
    if (!ITEM_DEF_MAP.has(item.defId)) return false;
    if (!this.stash.grid.autoPlace(item)) return false;
    this.afterChange();
    return true;
  }

  /** Bag first (`inventory:itemAdded`), then the stash. No `inventory:full` — the caller (corp shop) reports. */
  tryAddItemAnywhere(item: ItemInstance): 'bag' | 'stash' | null {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return null;
    if (this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.afterChange();
      return 'bag';
    }
    if (this.stash.grid.autoPlace(item)) { this.afterChange(); return 'stash'; }
    return null;
  }

  /**
   * Remove `qty` units (default: all) of bag / stash stack `uid` without a world drop (corp sale). Equipped gear,
   * socketed attachments and crate contents are refused (0). A bag stack that hits 0 leaves through the usual
   * path (`inventory:itemRemoved`, its wheel slot relinked / cleared); the stash persists through `afterChange`.
   */
  takeItem(uid: string, qty?: number): number {
    const found = this.locateInGrids(uid);
    if (!found || found.gridId === 'container') return 0;
    const { item, grid, gridId } = found;
    const want = qty === undefined ? item.qty : Math.floor(qty);
    if (!Number.isFinite(want) || want < 1) return 0;
    const n = Math.min(want, item.qty);
    item.qty -= n;
    if (item.qty <= 0) {
      if (gridId === 'bag') this.removeEmptyStack(item);
      else grid.remove(item.uid);
    } else {
      grid.version++;
    }
    this.afterChange();
    return n;
  }

  /**
   * `relock` is kept for the callers that pass it (nothing to re-acquire since Phase 10 — the window never gave the
   * pointer lock away, it only ran the software cursor).
   */
  closeAll(relock = true): void {
    void relock;
    if (!this._open) return;
    this.closeCatalog();
    this.closeBench();
    this.activeContainer = null;
    this.hubMode = false;
    this.setOpen(false);
    this.ui?.hide();
    this.ctx.bus.emit('inventory:closed', {});
  }

  /** Lose the carried kit (also closes windows and forgets rolled containers). */
  reset(): void {
    this.closeAll();
    this.clearContainers();
    this.loseKit();
  }

  /** Forget every rolled container, pending take and opened id (new mission / abort). */
  private clearContainers(): void {
    this.containers.clear();
    this.openedIds.clear();
    this.pendingTakes = [];
    this.lastSearchEmit = -1;
  }

  /* ── Phase 7 (2026-09-06): container search (감정) ──────────────────────── */

  /**
   * Every frame while a container window is open: reveal the first unsearched item in grid order (top-left →
   * bottom-right) once its `searchTimeFor` elapsed. Progress only advances within `SEARCH_MAX_DISTANCE` of the
   * container and is kept on the container across a close / reopen. `container:searchProgress` ≤ 20 Hz,
   * `container:itemRevealed` per item, `container:searchDone` once everything is revealed.
   */
  private updateSearch(dt: number): void {
    const c = this.activeContainer;
    const player = this.ctx.player;
    if (!c || !player) return;
    const next = c.nextToSearch();
    if (!next) {
      this.ui?.setSearchProgress(null, 0, false);
      if (!c.searchDoneEmitted) {
        c.searchDoneEmitted = true;
        this.ctx.bus.emit('container:searchDone', { containerId: c.id });
        this.ui?.refreshSearchStatus();
      }
      return;
    }
    const item = next.item;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) { item.searched = true; c.grid.version++; return; }
    const inRange = player.position.distanceTo(c.position) <= SEARCH_MAX_DISTANCE;
    const need = searchTimeFor(def, gearMultipliers(this.ctx.progression?.derived).searchSpeedMul);
    let t = c.searchProgress.get(item.uid) ?? 0;
    if (inRange && dt > 0) { t += dt; c.searchProgress.set(item.uid, t); }
    const progress = need > 0 ? Math.min(1, t / need) : 1;
    this.ui?.setSearchProgress(item.uid, progress, inRange);
    const now = this.ctx.time;
    if (inRange && (now - this.lastSearchEmit >= SEARCH_EMIT_INTERVAL || progress >= 1)) {
      this.lastSearchEmit = now;
      this.ctx.bus.emit('container:searchProgress', { containerId: c.id, uid: item.uid, progress });
    }
    if (t < need) return;
    item.searched = true;
    c.searchProgress.delete(item.uid);
    c.grid.version++;
    this.ctx.bus.emit('container:itemRevealed', { containerId: c.id, uid: item.uid, defId: def.id, rarity: def.rarity });
    this.ctx.bus.emit('audio:play', { id: 'ui_pickup', volume: 0.35 });
    this.ui?.setSearchProgress(null, 0, inRange);
    this.ui?.refresh();
  }

  /** True for a container item that has not been searched yet (no drag / menu / tooltip / take). */
  isItemLocked(uid: string, from?: ItemLocation): boolean {
    if (from && !(from.kind === 'grid' && from.grid === 'container')) return false;
    const p = this.activeContainer?.grid.get(uid);
    return !!p && p.item.searched === false;
  }

  /** Unsearched items left in the open container (0 without one). */
  unsearchedCount(): number { return this.activeContainer?.unsearchedCount ?? 0; }

  /* ── Phase 7: host-authoritative container takes (multiplayer) ─────────── */

  /** Multiplayer client: every container → player move is a request to the host. */
  private needsTakeRequest(from: ItemLocation): boolean {
    return from.kind === 'grid' && from.grid === 'container' && this.ctx.isMultiplayer && !this.ctx.isAuthority;
  }

  /** Multiplayer host: applies takes itself and broadcasts them. */
  private isNetAuthority(): boolean { return this.ctx.isMultiplayer && this.ctx.isAuthority; }

  private isContainerLoc(loc: ItemLocation): boolean { return loc.kind === 'grid' && loc.grid === 'container'; }

  /** Multiplayer: nothing may be put INTO a container (only takes are shared), so container-bound drops are refused. */
  private refusesIntoContainer(from: ItemLocation, target: DropTarget): boolean {
    if (!this.ctx.isMultiplayer) return false;
    if (target.kind === 'grid' && target.grid === 'container' && !this.isContainerLoc(from)) return true;
    return false;
  }

  /**
   * Gate for a container → player move of `qty` units (null = the whole stack) of `uid`: an unsearched item is refused;
   * a multiplayer client sends `contq take` and replays `run` on `cont taken` (`'pending'`); the host / single-player
   * runs it now and — in multiplayer — records + broadcasts what actually left the container.
   */
  private guardedTake(uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult {
    if (this.isItemLocked(uid, from)) return 'fail';
    if (this.needsTakeRequest(from)) return this.requestTake(uid, from, qty, run);
    return this.trackTake(uid, from, run);
  }

  private requestTake(uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult {
    const c = this.activeContainer;
    const net = this.ctx.net;
    const p = c?.grid.get(uid);
    if (!c || !p || !net) return 'fail';
    const idx = c.indexOf(uid);
    if (idx < 0) return 'fail';
    if (this.pendingTakes.some((t) => t.uid === uid)) return 'noop';
    const n = Math.max(1, Math.min(p.item.qty, Math.floor(qty ?? p.item.qty)));
    this.pendingTakes.push({ containerId: c.id, idx, qty: n, uid, from, run, sentAt: this.ctx.time });
    net.send({ t: 'contq', ev: 'take', id: c.id, idx, qty: n }, 'host');
    this.ui?.refresh();
    return 'pending';
  }

  /**
   * Run a container take now (host / single-player). The multiplayer host records + broadcasts the units that left its
   * copy; every local take also reports `container:itemTaken {live: true, byLocal: true}` so the same consumers see
   * my own loot and a squad mate's through one event.
   */
  private trackTake(uid: string, from: ItemLocation, run: () => OpResult): OpResult {
    const c = this.activeContainer;
    if (!c || !this.isContainerLoc(from)) return run();
    const idx = c.indexOf(uid);
    const before = c.grid.get(uid)?.item.qty ?? 0;
    const r = run();
    const after = c.grid.get(uid)?.item.qty ?? 0;
    const removed = before - after;
    if (idx < 0 || removed <= 0) return r;
    if (this.isNetAuthority()) this.announceTake(c, idx, removed);
    const me = this.ctx.isMultiplayer ? this.ctx.net?.localId ?? null : null;
    this.emitItemTaken(c.id, idx, uid, removed, after, me, true);
    return r;
  }

  private announceTake(c: Container, idx: number, qty: number): void {
    const net = this.ctx.net;
    if (!net || !net.localId) return;
    c.recordTaken(idx, qty);
    net.send({
      t: 'cont', ev: 'taken', id: c.id, idx, qty, by: net.localId,
      rem: c.remainingAt(idx), seq: this.containers.nextTakeSeq(c.id),
    }, 'others');
  }

  /**
   * Phase 10 — the one place `container:itemTaken` is emitted. `live` separates a real-time take (someone is looting
   * this crate right now → animate) from a `cont sync` / pending catch-up (silent). A live take by **another** member
   * also marks the tile so `GridView.refresh` animates it out instead of deleting it.
   */
  private emitItemTaken(containerId: string, idx: number, uid: string | null, qty: number, remaining: number,
    by: NetPeerId | null, live: boolean): void {
    const net = this.ctx.net;
    const byLocal = by === null || (!!net?.localId && by === net.localId);
    const byName = by && !byLocal ? net?.getLobbyPlayer?.(by)?.name ?? null : null;
    if (live && !byLocal && uid && this.activeContainer?.id === containerId) this.ui?.vanishContainerItem(uid);
    this.ctx.bus.emit('container:itemTaken', { containerId, idx, uid, qty, remaining, by, byName, byLocal, live });
  }

  /** Uids of container items whose take is waiting for the host (UI pulse). */
  pendingTakeUids(): ReadonlySet<string> {
    const out = new Set<string>();
    for (const t of this.pendingTakes) out.add(t.uid);
    return out;
  }

  private expirePendingTakes(): void {
    if (this.pendingTakes.length === 0) return;
    const now = this.ctx.time;
    const keep = this.pendingTakes.filter((t) => now - t.sentAt < TAKE_REQUEST_TIMEOUT);
    if (keep.length === this.pendingTakes.length) return;
    this.pendingTakes = keep;
    this.ui?.refresh();
  }

  /** Host → all `cont` (taken / denied / sync). Only the lobby host is trusted. */
  private onContainerMessage(msg: ContainerMessage, from: NetPeerId): void {
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer) return;
    const hostId = net.lobby?.hostId;
    if (hostId && from !== hostId) return;
    if (msg.ev === 'taken') {
      // Phase 10: `seq` is the host's per-container take counter — a duplicate / out-of-order message is dropped
      // (it would otherwise remove the same units twice and animate a tile that is already gone).
      if (!this.containers.acceptTakeSeq(msg.id, msg.seq)) return;
      if (msg.by === net.localId) this.resolvePendingTake(msg.id, msg.idx, msg.qty);
      else this.applyRemoteTaken(msg.id, msg.idx, msg.qty, msg.by, msg.rem);
    } else if (msg.ev === 'denied') {
      const i = this.pendingTakes.findIndex((t) => t.containerId === msg.id && t.idx === msg.idx);
      if (i < 0) return;
      const [t] = this.pendingTakes.splice(i, 1);
      this.ctx.bus.emit('audio:play', { id: 'ui_error' });
      this.ctx.bus.emit('ui:notify', { text: '다른 대원이 먼저 가져갔습니다', kind: 'warning', duration: 1.6 });
      this.ui?.refresh();
      this.ui?.shakeItem(t.uid, t.from);
    } else if (msg.ev === 'sync') {
      const changed = this.containers.applySync(msg.items);
      for (const id of changed) { const c = this.containers.get(id); if (c) this.checkLootedFor(c); }
      if (changed.length > 0) this.ui?.refresh();
    }
  }

  /** My `contq take` was confirmed: replay the move (the item may sit in a container whose window closed meanwhile). */
  private resolvePendingTake(id: string, idx: number, qty: number): void {
    const i = this.pendingTakes.findIndex((t) => t.containerId === id && t.idx === idx);
    if (i < 0) { this.applyRemoteTaken(id, idx, qty, this.ctx.net?.localId ?? null); return; }
    const [t] = this.pendingTakes.splice(i, 1);
    const c = this.containers.get(id);
    if (!c) { this.containers.recordPending(id, idx, qty); return; }
    const before = c.remainingAt(idx);
    const prev = this.activeContainer;
    this.activeContainer = c;
    let r: OpResult = 'fail';
    try { r = t.run(); } finally { this.activeContainer = prev; }
    const removed = before - c.remainingAt(idx);
    c.recordTaken(idx, Math.max(removed, 0));
    if (removed < qty) {
      // the replay took less than the host granted (bag changed meanwhile): stay consistent with the host's copy
      if (r !== 'ok') console.warn(`[Inventory] confirmed take of ${id}#${idx} could not be applied (${r})`);
      c.applyTaken(idx, qty - removed);
      c.taken.set(idx, (c.taken.get(idx) ?? 0) - (qty - removed)); // applyTaken recorded it again
    }
    if (r === 'ok') this.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
    this.emitItemTaken(id, idx, t.uid, qty, c.remainingAt(idx), this.ctx.net?.localId ?? null, true);
    this.checkLootedFor(c);
    this.ui?.refresh();
  }

  /**
   * Someone else's take was confirmed: remove it from my copy (or remember it for a container I have not opened).
   * Phase 10: the uid is read **before** `applyTaken` drops the placement and reported as a live take, so the tile
   * animates out and the HUD can name the looter.
   */
  private applyRemoteTaken(id: string, idx: number, qty: number, by: NetPeerId | null, hostRemaining?: number): void {
    const c = this.containers.get(id);
    if (!c) { this.containers.recordPending(id, idx, qty); return; }
    const uid = c.uidAt(idx) ?? null;
    let removed = c.applyTaken(idx, qty);
    // `cont taken.rem` (Phase 10) is the host's own remaining count: converge on it when this copy still holds more
    if (typeof hostRemaining === 'number' && Number.isFinite(hostRemaining) && hostRemaining >= 0) {
      const extra = c.remainingAt(idx) - Math.floor(hostRemaining);
      if (extra > 0) removed += c.applyTaken(idx, extra);
    }
    if (removed <= 0) return;
    this.emitItemTaken(id, idx, uid, removed, c.remainingAt(idx), by, true);
    this.checkLootedFor(c);
    if (this._open) this.ui?.refresh();
  }

  /** Host: validate a peer's `contq take` against its own copy (rolled on demand for world crates) and broadcast. */
  private onContainerRequest(msg: ContainerRequest, from: NetPeerId): void {
    const net = this.ctx.net;
    if (!net || !this.isNetAuthority()) return;
    if (msg.ev === 'sync') { net.send({ t: 'cont', ev: 'sync', items: this.containers.takenWire() }, from); return; }
    const qty = Math.floor(msg.qty);
    const c = this.containers.get(msg.id) ?? this.materializeCrate(msg.id);
    const allowed = Number.isFinite(qty) && qty >= 1 && (c
      ? c.uidAt(msg.idx) !== undefined && qty <= c.remainingAt(msg.idx)
      : this.containers.pendingTakenOf(msg.id, msg.idx) === 0);
    if (!allowed) { net.send({ t: 'cont', ev: 'denied', id: msg.id, idx: msg.idx }, from); return; }
    if (c) {
      const uid = c.uidAt(msg.idx) ?? null;
      const removed = c.applyTaken(msg.idx, qty);
      if (removed > 0) this.emitItemTaken(msg.id, msg.idx, uid, removed, c.remainingAt(msg.idx), from, true);
      this.checkLootedFor(c);
      if (this._open) this.ui?.refresh();
    } else {
      this.containers.recordPending(msg.id, msg.idx, qty);
    }
    net.send({
      t: 'cont', ev: 'taken', id: msg.id, idx: msg.idx, qty, by: from,
      ...(c ? { rem: c.remainingAt(msg.idx) } : {}), seq: this.containers.nextTakeSeq(msg.id),
    }, 'others');
  }

  /** Host: a world crate it never opened can still be rolled (deterministic seed ^ id) to validate a request. */
  private materializeCrate(id: string): Container | null {
    const crate = this.ctx.world?.getCrates().find((k) => k.id === id);
    if (!crate) return null;
    return this.containers.getOrCreate(id, crate.tier, crate.position, this.loot, this.missionSeed);
  }

  /** Ask the (new) host for every taken map (host migration, rejoin fallback). */
  private requestContainerSync(): void {
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer || this.ctx.isAuthority) return;
    this.pendingTakes = [];
    this.containers.resetTakeSeq(); // the new host counts its takes from 1 again
    net.send({ t: 'contq', ev: 'sync' }, 'host');
  }

  /* ── Phase 7: canFit / raid state (InventoryRef) ───────────────────────── */

  /** Would `qty` units of `defId` fit now? Bag first, then (hub phase) the stash. Non-mutating. */
  canFit(defId: string, qty = 1): 'bag' | 'stash' | null {
    const def = ITEM_DEF_MAP.get(defId);
    const n = Math.floor(qty);
    if (!def || !Number.isFinite(n) || n < 1) return null;
    if (this.gridFits(this.bag, def, n)) return 'bag';
    if (this.ctx.isHubPhase() && this.gridFits(this.stash.grid, def, n)) return 'stash';
    return null;
  }

  /** Trial placement of `qty` units (merge into stacks, then new stacks chunked by `stackMax`), rolled back afterwards. */
  private gridFits(grid: Grid, def: ItemDef, qty: number): boolean {
    const snap = grid.snapshot();
    const version = grid.version;
    let left = qty;
    let ok = true;
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      const probe = this.loot.createItem(def.id, chunk);
      if (grid.mergeIntoStacks(probe) <= 0) continue;
      if (!grid.autoPlace(probe)) { ok = false; break; }
    }
    grid.restore(snap);
    grid.version = version;
    return ok;
  }

  /** Bag + 5 slots + quick slots with every instance field incl. `searched` (raid session blob / training freeze). */
  captureRaidState(): unknown {
    const save = this.captureLoadoutSave();
    const placements = this.bag.items();
    const bag = save.bag.map((sv, i) => {
      const flag = placements[i]?.item.searched;
      return flag === undefined ? sv : { ...sv, searched: flag };
    });
    const state: RaidInventoryState = { ...save, bag, raid: 1 };
    return state;
  }

  /** Replace the bag / slots / quick slots with a `captureRaidState()` result and re-announce everything. */
  applyRaidState(state: unknown): boolean {
    const save = sanitizeLoadoutSave(state);
    if (!save) return false;
    this.cancelCraft();
    const revived = this.applyLoadoutSave(save);
    save.bag.forEach((sv, i) => {
      const item = revived[i];
      const flag = (sv as { searched?: boolean }).searched;
      if (item && typeof flag === 'boolean') item.searched = flag;
    });
    this.announcePending = false;
    this.announceLoaded();
    return true;
  }

  /* ── Phase 7: server profile documents ─────────────────────────────────── */

  /**
   * Mirror a local save to the server profile. Phase 9: always handed to `profile.set` — offline included (`ProfileSync`
   * stamps it with `serverNow()` and keeps the newest doc per key until the next connection); inside `withFreshSave`
   * the document is sent as a default (`{fresh:true}`, accepted only while the server has none for that key).
   */
  private uploadProfileDoc(key: 'stash' | 'loadout', doc: unknown): void {
    const profile = this.ctx.net?.profile;
    if (!profile || typeof profile.set !== 'function') return;
    try { profile.set(key, doc, this.freshSave ? { fresh: true } : undefined); } catch { /* net not ready */ }
  }

  /** Run `fn` with every save it triggers uploaded as a `fresh` (default) document. */
  private withFreshSave(fn: () => void): void {
    const prev = this.freshSave;
    this.freshSave = true;
    try { fn(); } finally { this.freshSave = prev; }
  }

  /** JSON equality of two save documents (`ProfileSync` hands our own pending document back inside the merged record). */
  private static sameDoc(a: unknown, b: unknown): boolean {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }

  /**
   * `net:profileLoaded`: the record is already merged newest-wins (Phase 9: `ProfileSync` weighed its pending offline
   * edits against the server's `docsAt` before emitting), so a server document simply replaces the local state — the
   * loadout only outside a raid (mid-mission the raid blob is the truth). A document that is **identical to the current
   * local state** is our own upload coming back through the merge: nothing is applied, nothing is re-saved (Phase 9 —
   * otherwise the starter kit would be re-announced and re-written with reason `profile` on every welcome). A key the
   * server has never seen gets the current local state (stamped, so it becomes the profile); an empty local loadout is
   * not worth uploading (the starter kit follows as a `fresh` document). Grids are rebuilt and announced.
   */
  private onProfileLoaded(profile: ProfileRecord): void {
    this.applyProfileDocs(profile);
    // 2026-09-07: a first-run grant goes up as a `fresh` document, so an (empty) server 창고 has just replaced it —
    // re-check exactly once, now that the server's stash is known. A profile that really owns something skips it.
    if (starterGrantState() === 'pending') this.tryStarterGrant();
  }

  private applyProfileDocs(profile: ProfileRecord): void {
    const docs = profile?.docs ?? {};
    if (docs.stash === undefined) this.uploadProfileDoc('stash', this.stash.saveFile());
    else if (InventorySystem.sameDoc(docs.stash, this.stash.saveFile())) { /* our own document: already applied */ }
    else if (this.stash.loadFrom(docs.stash)) {
      this.lastStashVersion = this.stash.grid.version;
      this.ctx.bus.emit('inventory:stashChanged', { count: this.stash.count });
      if (this._open) this.ui?.refresh();
    }
    if (docs.loadout === undefined) {
      const local = this.captureLoadoutSave();
      if (!isEmptyLoadoutSave(local)) this.uploadProfileDoc('loadout', local);
      return;
    }
    if (this.ctx.isRaidActive()) return;
    const save = sanitizeLoadoutSave(docs.loadout);
    if (!save) return;
    if (InventorySystem.sameDoc(save, sanitizeLoadoutSave(this.captureLoadoutSave()))) return; // our own document
    if (isEmptyLoadoutSave(save)) {
      // 2026-09-07: an empty server document must never wipe a kit the player is standing in — it only means the
      // profile has no loadout yet. The local kit stays (and is uploaded); only a player with nothing anywhere is
      // handed the minimum kit.
      if (this.ctx.isHubPhase() && this.isDestitute()) this.applyStarter();
      return;
    }
    this.cancelCraft();
    this.applyLoadoutSave(save);
    this.announcePending = false;
    this.announceLoaded();
    this.loadoutStore.saveNow('profile'); // mirror to localStorage without echoing the document back
  }

  /* ── UI-facing operations ──────────────────────────────────────────────── */

  getGrid(id: GridId): Grid | null {
    if (id === 'bag') return this.bag;
    if (id === 'stash') return this.stash.grid;
    return this.activeContainer?.grid ?? null;
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }
  getStats(item: ItemInstance): EffectiveWeaponStats | null { return this.loot.getEffectiveStats(item); }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /** Find an item anywhere (bag → container → slots). */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null {
    const inGrid = this.locateInGrids(uid);
    if (inGrid) return { item: inGrid.item, from: { kind: 'grid', grid: inGrid.gridId } };
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (it?.uid === uid) return { item: it, from: { kind: 'slot', slot } };
    }
    return null;
  }

  private locateInGrids(uid: string): { item: ItemInstance; grid: Grid; gridId: GridId } | null {
    for (const gridId of ['bag', 'container', 'stash'] as const) {
      const grid = this.getGrid(gridId);
      const p = grid?.get(uid);
      if (grid && p) return { item: p.item, grid, gridId };
    }
    return null;
  }

  /** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else 주무기 I (swap). Armor / bags → their slot. */
  equipTargetFor(def: ItemDef): LoadoutSlot | null {
    if (def.category === 'bag') return 'bag';
    if (def.category === 'armor') return 'armor';
    if (def.category === 'secondary') return 'secondary';
    if (def.category !== 'primary') return null;
    if (!this.loadout.primary) return 'primary';
    if (!this.loadout.primary2) return 'primary2';
    return 'primary';
  }

  /** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
  partialQtyFor(item: ItemInstance, mode: 'half' | 'one'): number | null {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def || def.stackMax <= 1 || item.qty < 2) return null;
    return mode === 'one' ? 1 : Math.max(1, Math.floor(item.qty / 2));
  }

  /** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
  previewPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview {
    const v = this.validatePartial(uid, from, qty, target);
    if (!v) return 'bad';
    const { item, def, grid, blockers } = v;
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    if (blockers[0] === uid) return 'noop';
    const other = grid.get(blockers[0]);
    return other && other.item.defId === item.defId && other.item.qty < def.stackMax ? 'merge' : 'bad';
  }

  /**
   * Execute a partial-stack drag: onto a free cell → new stack of `qty` there; onto a same-def stack → merge
   * (capped by `stackMax`); onto the source or anything else → nothing.
   */
  dropPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult {
    const takes = this.isContainerLoc(from) && !(target.kind === 'grid' && target.grid === 'container');
    if (takes) return this.guardedTake(uid, from, Math.floor(qty), () => this.dropPartialImpl(uid, from, qty, target));
    return this.dropPartialImpl(uid, from, qty, target);
  }

  private dropPartialImpl(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult {
    const v = this.validatePartial(uid, from, qty, target);
    if (!v || target.kind !== 'grid' || from.kind !== 'grid') return 'fail';
    const { item, def, grid, blockers } = v;
    const to: ItemLocation = { kind: 'grid', grid: target.grid };
    const srcGrid = this.getGrid(from.grid);
    if (!srcGrid) return 'fail';

    if (blockers.length === 0) {
      const created = this.loot.createItem(item.defId, qty);
      if (!grid.place(created, target.x, target.y, target.rotated)) return 'fail';
      item.qty -= qty;
      srcGrid.version++;
      if (this.locKind(from) !== this.locKind(to)) this.emitTransfer(created, def, from, to);
      this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
      this.afterChange();
      return 'ok';
    }
    if (blockers.length !== 1 || blockers[0] === OOB) return 'fail';
    if (blockers[0] === uid) return 'noop';
    const other = grid.get(blockers[0]);
    if (!other || other.item.defId !== item.defId || other.item.searched === false) return 'fail';
    const moved = Math.min(def.stackMax - other.item.qty, qty);
    if (moved <= 0) return 'fail';
    other.item.qty += moved;
    item.qty -= moved;
    grid.version++;
    srcGrid.version++;
    if (this.locKind(from) !== this.locKind(to)) this.emitTransfer({ ...item, qty: moved }, def, from, to);
    this.afterChange();
    return 'ok';
  }

  private validatePartial(uid: string, from: ItemLocation, qty: number, target: DropTarget):
    { item: ItemInstance; def: ItemDef; grid: Grid; blockers: string[] } | null {
    if (from.kind !== 'grid' || target.kind !== 'grid') return null;
    if (this.isItemLocked(uid, from) || this.refusesIntoContainer(from, target)) return null;
    if (this.ctx.isMultiplayer && from.grid === 'container' && target.grid === 'container') return null; // no local splits of shared contents
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def || def.stackMax <= 1) return null;
    const n = Math.floor(qty);
    if (!Number.isFinite(n) || n < 1 || n >= item.qty) return null;
    const grid = this.getGrid(target.grid);
    if (!grid) return null;
    const probe: ItemInstance = { uid: '__split__', defId: item.defId, qty: n, rotated: target.rotated };
    return { item, def, grid, blockers: grid.blockersAt(probe, target.x, target.y, target.rotated, probe.uid) };
  }

  /** Non-mutating classification used for the drag highlight. */
  previewDrop(uid: string, from: ItemLocation, target: DropTarget): DropPreview {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'bad';
    if (this.isItemLocked(uid, from) || this.refusesIntoContainer(from, target)) return 'bad';

    if (target.kind === 'weapon') return this.previewAttach(uid, from, target.uid, target.loc);

    if (target.kind === 'quick') {
      if (from.kind !== 'grid' || from.grid !== 'bag' || !isQuickUsable(def)) return 'bad';
      if (!isQuickIndex(target.index) || !isQuickSlotActive(target.index, this.getQuickSlotCount())) return 'bad';
      return this.quickSlots[target.index] === uid ? 'noop' : this.quickSlots[target.index] ? 'swap' : 'ok';
    }

    if (target.kind === 'slot') {
      if (!slotAccepts(def, target.slot)) return 'bad';
      const current = this.loadout[target.slot];
      if (from.kind === 'slot') {
        if (from.slot === target.slot) return 'noop';
        if (target.slot === 'bag' || from.slot === 'bag') return 'bad';
        return current ? 'swap' : 'ok';
      }
      if (!current) return 'ok';
      if (target.slot === 'bag') return 'swap'; // the displaced bag is placed first in the resized grid
      return this.canPlaceDisplaced(current, from, uid) ? 'swap' : 'bad';
    }

    const grid = this.getGrid(target.grid);
    if (!grid) return 'bad';
    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }
    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
    if (from.kind === 'slot' && from.slot === 'bag' && target.grid !== 'bag') return 'bad';
    if (blockers.length === 0) return 'ok';
    if (blockers.length !== 1 || blockers[0] === OOB) return 'bad';
    const other = grid.get(blockers[0]);
    if (!other) return 'bad';
    if (target.grid === 'container' && other.item.searched === false) return 'bad'; // never touch an unsearched item
    if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) return 'merge';
    if (from.kind === 'slot') {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      return od && slotAccepts(od, from.slot) ? 'swap' : 'bad';
    }
    // multiplayer: a swap would put my item into the container (not shared) — refused
    if (this.ctx.isMultiplayer && (from.grid === 'container') !== (target.grid === 'container')) return 'bad';
    return this.canSwap(item, from.grid, other.item, grid) ? 'swap' : 'bad';
  }

  /**
   * Free footprint **closest to (x, y)** for `uid` (living at `from`) inside `gridId`, preferring `rotated`.
   * Null when the item does not fit anywhere.
   *
   * The drag UI uses this for an **equipment slot → grid** drag only: aiming a 4×2 weapon at a grid that has a
   * single small item under the cursor used to refuse the drop outright (red highlight, snap back to the slot and
   * shake), even with half the bag empty. The highlight now retargets to the spot the item really lands on.
   */
  nearestFreeSpot(uid: string, from: ItemLocation, gridId: GridId, x: number, y: number, rotated: boolean): { x: number; y: number; rotated: boolean } | null {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    const grid = this.getGrid(gridId);
    if (!item || !def || !grid) return null;
    const orientations = def.width !== def.height ? [rotated, !rotated] : [rotated];
    let best: { x: number; y: number; rotated: boolean } | null = null;
    let bestD = Infinity;
    for (const rot of orientations) {
      const { w, h } = grid.footprintOf(item, rot);
      for (let gy = 0; gy + h <= grid.rows; gy++) {
        for (let gx = 0; gx + w <= grid.cols; gx++) {
          if (!grid.canPlace(item, gx, gy, rot, uid)) continue;
          // slight bias to the requested orientation so a fitting rotation is not preferred over an equal-distance one
          const d = (gx - x) * (gx - x) + (gy - y) * (gy - y) + (rot === rotated ? 0 : 0.5);
          if (d < bestD) { bestD = d; best = { x: gx, y: gy, rotated: rot }; }
        }
      }
    }
    return best;
  }

  /** Execute a drag-and-drop. Container → player moves go through `guardedTake` (Phase 7). */
  drop(uid: string, from: ItemLocation, target: DropTarget): OpResult {
    if (this.refusesIntoContainer(from, target)) return 'fail';
    const takes = this.isContainerLoc(from) && !(target.kind === 'grid' && target.grid === 'container') && target.kind !== 'quick';
    if (takes) return this.guardedTake(uid, from, null, () => this.dropImpl(uid, from, target));
    if (this.isItemLocked(uid, from)) return 'fail';
    return this.dropImpl(uid, from, target);
  }

  private dropImpl(uid: string, from: ItemLocation, target: DropTarget): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (target.kind === 'weapon') return this.attachFromImpl(uid, from, target.uid, target.loc);
    if (target.kind === 'quick') {
      const pv = this.previewDrop(uid, from, target);
      if (pv === 'bad') return 'fail';
      if (pv === 'noop') return 'noop';
      return this.setQuickSlot(target.index, uid) ? 'ok' : 'fail';
    }
    if (target.kind === 'slot') return this.dropOnSlot(item, def, from, target.slot);

    const grid = this.getGrid(target.grid);
    if (!grid) return 'fail';
    const to: ItemLocation = { kind: 'grid', grid: target.grid };

    if (from.kind === 'grid' && from.grid === target.grid) {
      const p = grid.get(uid);
      if (p && p.x === target.x && p.y === target.y && item.rotated === target.rotated) return 'noop';
    }

    const blockers = grid.blockersAt(item, target.x, target.y, target.rotated, uid);
    if (blockers.includes(OOB)) return 'fail';

    // the equipped bag dragged into the grid: unequip (grid shrinks, bag lands at the target cell if it still exists)
    if (from.kind === 'slot' && from.slot === 'bag') {
      if (target.grid !== 'bag') return 'fail';
      if (blockers.length === 0) return this.changeBag(null, null, 'grid', { x: target.x, y: target.y });
      if (blockers.length !== 1) return 'fail';
      const other = grid.get(blockers[0]);
      const od = other && ITEM_DEF_MAP.get(other.item.defId);
      if (!other || !od || od.category !== 'bag') return 'fail';
      return this.changeBag(other.item, to, 'grid', { x: other.x, y: other.y });
    }

    if (blockers.length === 0) {
      if (from.kind === 'grid' && from.grid === target.grid) {
        if (!grid.moveTo(uid, target.x, target.y, target.rotated)) return 'fail';
        this.afterChange();
        return 'ok';
      }
      this.detach(item, from);
      grid.place(item, target.x, target.y, target.rotated);
      this.afterMove(item, from, to);
      return 'ok';
    }

    if (blockers.length !== 1) return 'fail';
    const other = grid.get(blockers[0]);
    if (!other) return 'fail';
    if (target.grid === 'container' && other.item.searched === false) return 'fail';

    // stack merge
    if (other.item.defId === item.defId && def.stackMax > 1 && other.item.qty < def.stackMax) {
      const moved = grid.mergeInto(item, other.item.uid);
      if (moved <= 0) return 'fail';
      if (item.qty <= 0) {
        // the whole stack merged away: its wheel slot follows the surviving stack
        if (target.grid === 'bag') relinkQuickSlot(this.quickSlots, item.uid, other.item.uid);
        this.detach(item, from);
        this.afterMove(item, from, to, moved);
      } else {
        // partial merge: item stays where it was (qty reduced)
        if (from.kind === 'grid') { const g = this.getGrid(from.grid); if (g) g.version++; }
        if (this.locKind(from) !== this.locKind(to)) this.emitTransfer({ ...item, qty: moved }, def, from, to);
        this.afterChange();
      }
      return 'ok';
    }

    // swap with the single blocking item
    if (from.kind === 'slot') {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      if (!od || !slotAccepts(od, from.slot)) return 'fail';
      grid.remove(other.item.uid);
      this.loadout[from.slot] = other.item;
      grid.place(item, target.x, target.y, target.rotated);
      this.emitTransfer(other.item, od, to, from);
      this.emitTransfer(item, def, from, to);
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    const srcGrid = this.getGrid(from.grid);
    if (!srcGrid) return 'fail';
    if (this.ctx.isMultiplayer && (from.grid === 'container') !== (target.grid === 'container')) return 'fail';
    if (!this.performSwap(item, srcGrid, other.item, grid, target.x, target.y, target.rotated)) return 'fail';
    if (from.grid !== target.grid) {
      const od = ITEM_DEF_MAP.get(other.item.defId);
      if (from.grid === 'container') item.searched = true;
      this.emitTransfer(item, def, from, to);
      if (od) this.emitTransfer(other.item, od, to, from);
    }
    this.afterChange();
    return 'ok';
  }

  /** Right-click quick action: container ↔ bag auto-place; slot → bag (the bag slot shrinks the grid first). */
  quickMove(uid: string, from: ItemLocation): OpResult {
    if (this.isContainerLoc(from)) return this.guardedTake(uid, from, null, () => this.quickMoveImpl(uid, from));
    return this.quickMoveImpl(uid, from);
  }

  private quickMoveImpl(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    if (from.kind === 'slot' && from.slot === 'bag') return this.changeBag(null, null, 'grid');
    let dest: GridId;
    if (from.kind === 'slot') dest = 'bag';
    else if (from.grid === 'container' || from.grid === 'stash') dest = 'bag';
    else if (this.activeContainer) dest = 'container';
    else if (this.hubMode) dest = 'stash';
    else return 'fail';
    if (dest === 'container' && this.ctx.isMultiplayer) return 'fail'; // Phase 7: nothing goes into a shared container
    const grid = this.getGrid(dest);
    if (!grid) return 'fail';
    if (!grid.canAbsorb(item)) {
      if (dest === 'bag') this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return 'fail';
    }
    this.detach(item, from);
    grid.autoPlace(item);
    this.afterMove(item, from, { kind: 'grid', grid: dest });
    return 'ok';
  }

  /** Double-click: weapons / bags equip (`equipTargetFor`), anything else quick-moves. */
  activate(uid: string, from: ItemLocation): OpResult {
    if (this.isContainerLoc(from)) return this.guardedTake(uid, from, null, () => this.activateImpl(uid, from));
    return this.activateImpl(uid, from);
  }

  private activateImpl(uid: string, from: ItemLocation): OpResult {
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return 'fail';
    const slot = this.equipTargetFor(def);
    if (slot) {
      if (from.kind === 'slot') return 'noop';
      return this.dropOnSlot(item, def, from, slot);
    }
    return this.quickMoveImpl(uid, from);
  }

  rotateItem(uid: string, gridId: GridId): OpResult {
    const grid = this.getGrid(gridId);
    const p = grid?.get(uid);
    if (!grid || !p) return 'fail';
    if (gridId === 'container' && p.item.searched === false) return 'fail';
    const def = ITEM_DEF_MAP.get(p.item.defId);
    if (!def || def.width === def.height) return 'noop';
    if (!grid.rotate(uid)) return 'fail';
    this.ctx.bus.emit('inventory:itemRotated', { item: p.item });
    this.afterChange();
    return 'ok';
  }

  /**
   * "모두 가져가기": move every **searched** container item into the bag that fits (largest first). Returns the moved
   * count — on a multiplayer client the number of takes requested (each lands on its `cont taken`).
   */
  takeAll(): number {
    const c = this.activeContainer;
    if (!c) return 0;
    const from: ItemLocation = { kind: 'grid', grid: 'container' };
    const items = c.grid.items().map((p) => p.item).filter((it) => it.searched !== false).sort((a, b) => this.area(b) - this.area(a));
    let moved = 0;
    let fullReported = false;
    for (const item of items) {
      const def = ITEM_DEF_MAP.get(item.defId);
      if (!def) continue;
      if (!this.bag.canAbsorb(item)) {
        if (!fullReported) { fullReported = true; this.ctx.bus.emit('inventory:full', { item, name: def.name }); }
        continue;
      }
      const r = this.guardedTake(item.uid, from, null, () => this.takeOne(item.uid));
      if (r === 'ok' || r === 'pending') moved++;
    }
    return moved;
  }

  /** One container item into the bag (auto-place, `inventory:itemAdded`). */
  private takeOne(uid: string): OpResult {
    const c = this.activeContainer;
    const p = c?.grid.get(uid);
    const def = p && ITEM_DEF_MAP.get(p.item.defId);
    if (!c || !p || !def) return 'fail';
    if (!this.bag.canAbsorb(p.item)) { this.ctx.bus.emit('inventory:full', { item: p.item, name: def.name }); return 'fail'; }
    c.grid.remove(uid);
    p.item.searched = true;
    this.bag.autoPlace(p.item);
    this.ctx.bus.emit('inventory:itemAdded', { item: p.item, name: def.name, rarity: def.rarity });
    this.afterChange();
    return 'ok';
  }

  /* ── sockets (UI drag path) ────────────────────────────────────────────── */

  /** Can attachment `uid` (at `from`) be socketed into weapon `weaponUid` (at `loc`)? */
  previewAttach(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): DropPreview {
    if (this.isItemLocked(uid, from)) return 'bad';
    const att = this.findItem(uid, from);
    const attDef = att && ITEM_DEF_MAP.get(att.defId);
    const weapon = this.findItem(weaponUid, loc);
    if (!att || !attDef?.attachment || !weapon || from.kind !== 'grid') return 'bad';
    if (this.locKind(loc) !== 'player' || !isWeaponItemDef(ITEM_DEF_MAP.get(weapon.defId))) return 'bad';
    if (!this.loot.canAttach(weapon, att)) return 'bad';
    return weapon.sockets?.[attDef.attachment.socket] ? 'swap' : 'ok';
  }

  /**
   * Socket attachment `uid` into weapon `weaponUid`. The previous attachment in that socket returns to the bag
   * (or drops to the ground when nothing fits). Emits `inventory:socketChanged`, `inventory:itemUpdated`.
   */
  attachFrom(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult {
    if (this.isContainerLoc(from)) return this.guardedTake(uid, from, 1, () => this.attachFromImpl(uid, from, weaponUid, loc));
    return this.attachFromImpl(uid, from, weaponUid, loc);
  }

  private attachFromImpl(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult {
    if (this.previewAttach(uid, from, weaponUid, loc) === 'bad' || from.kind !== 'grid') return 'fail';
    const att = this.findItem(uid, from)!;
    const attDef = ITEM_DEF_MAP.get(att.defId)!;
    const weapon = this.findItem(weaponUid, loc)!;
    const socket: SocketSlot = attDef.attachment!.socket;
    const grid = this.getGrid(from.grid);
    if (!grid) return 'fail';
    grid.remove(att.uid);
    if (from.grid === 'container') att.searched = true;
    const prev = setSocket(weapon, socket, att);
    if (from.grid === 'container') this.ctx.bus.emit('inventory:itemAdded', { item: att, name: attDef.name, rarity: attDef.rarity });
    if (prev && !this.bag.autoPlace(prev)) this.throwToWorld(prev, true);
    if (this.bag.has(weapon.uid)) this.bag.version++;
    this.ctx.bus.emit('inventory:socketChanged', { weapon, socket, attachment: att });
    this.afterSocketChange(weapon);
    this.afterChange();
    return 'ok';
  }

  /** After a socket change: a smaller magazine spills its excess rounds into the bag; weapons re-read the instance. */
  private afterSocketChange(weapon: ItemInstance): void {
    const stats = this.loot.getEffectiveStats(weapon);
    if (stats && weapon.ammoInMag !== undefined && weapon.ammoInMag > stats.magSize) {
      const excess = weapon.ammoInMag - stats.magSize;
      weapon.ammoInMag = stats.magSize;
      this.returnRounds(stats.ammoType, excess);
    }
    this.ctx.bus.emit('inventory:itemUpdated', { item: weapon });
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  /**
   * Phase 10 (인게임 커서): the window keeps the **pointer lock** and drives the software cursor instead of handing
   * the OS cursor back — `setCursorMode` is ref-counted by blocker token, so a modeless popup layered on top (which
   * takes no token of its own) cannot steal it. No `exitPointerLock()`, and therefore no relock either.
   */
  private setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    if (open) {
      this.ctx.uiBlockers.add(BLOCKER_TOKEN);
      this.ctx.input.setCursorMode(true, BLOCKER_TOKEN);
    } else {
      this.ctx.uiBlockers.delete(BLOCKER_TOKEN);
      this.ctx.input.setCursorMode(false, BLOCKER_TOKEN);
    }
  }

  private area(it: ItemInstance): number {
    const d = ITEM_DEF_MAP.get(it.defId);
    return d ? d.width * d.height : 0;
  }

  /** 'player' = bag / loadout (HUD counts, sockets); the crate and the stash are 'container'. */
  private locKind(loc: ItemLocation): 'player' | 'container' {
    return loc.kind === 'grid' && loc.grid !== 'bag' ? 'container' : 'player';
  }

  private bagSizeOf(item: ItemInstance | null): BagSize {
    const b = item ? ITEM_DEF_MAP.get(item.defId)?.bag : undefined;
    return b
      ? { cols: b.cols, rows: b.rows, quickSlots: b.quickSlots }
      : { cols: BAG_DEFAULT_COLS, rows: BAG_DEFAULT_ROWS, quickSlots: BAG_DEFAULT_QUICK_SLOTS };
  }

  /** Weapons the player owns (slots + bag), for socket lookups. */
  private *ownedWeapons(): Iterable<ItemInstance> {
    for (const s of WEAPON_SLOT_IDS) { const it = this.loadout[s]; if (it) yield it; }
    for (const p of this.bag.items()) if (isWeaponItemDef(ITEM_DEF_MAP.get(p.item.defId))) yield p.item;
  }

  /**
   * Add `qty` units of `defId` to the bag: merge into existing stacks, then new stacks (chunked by `stackMax`).
   * Returns the stacks that did not fit (never placed anywhere — caller drops or discards them).
   */
  private addUnits(defId: string, qty: number): ItemInstance[] {
    const def = ITEM_DEF_MAP.get(defId);
    const overflow: ItemInstance[] = [];
    if (!def) return overflow;
    let left = Math.max(0, Math.floor(qty));
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      const item = this.loot.createItem(defId, chunk);
      if (this.bag.mergeIntoStacks(item) <= 0) continue;
      if (!this.bag.autoPlace(item)) overflow.push(item);
    }
    return overflow;
  }

  /** Rounds of `type` back into the bag (unload / mag downgrade); what does not fit lands on the ground. */
  private returnRounds(type: EffectiveWeaponStats['ammoType'], rounds: number): void {
    for (const stack of this.addUnits(ammoItemIdFor(type), rounds)) this.throwToWorld(stack, false);
  }

  /** Emit the world drop for `item` (already detached). `owned` → also `inventory:itemRemoved` (HUD counts). */
  private throwToWorld(item: ItemInstance, owned: boolean): void {
    // in the ship an overflowing item (bag swap, socket swap) lands in the stash instead of vanishing
    if (this.ctx.isHubPhase() && this.stash.grid.autoPlace(item)) {
      if (owned) this.ctx.bus.emit('inventory:itemRemoved', { item });
      this.ctx.bus.emit('ui:notify', { text: `${ITEM_DEF_MAP.get(item.defId)?.name ?? item.defId} → 함선 창고`, kind: 'info', duration: 2 });
      return;
    }
    if (owned) this.ctx.bus.emit('inventory:itemRemoved', { item });
    const position = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const player = this.ctx.player;
    if (player) {
      const forward = player.getForward(new THREE.Vector3());
      player.getEyePosition(position);
      position.y -= DROP_EYE_LOWER;
      position.addScaledVector(forward, DROP_FORWARD_OFFSET);
      velocity.copy(forward).multiplyScalar(DROP_FORWARD_SPEED);
      velocity.y += DROP_UP_SPEED;
    }
    this.ctx.bus.emit('inventory:itemDropped', { item, position, velocity });
  }

  /**
   * Equip `next` (null = unequip) as the bag. The grid is resized to the new bag; the displaced bag is placed
   * first (at `hint`, else the new bag's former cells, else the first free slot), everything else is relocated
   * around it and whatever no longer fits is dropped into the world (`inventory:bagChanged.dropped`).
   * Refused (nothing changes) only when the displaced bag itself cannot fit the new grid at all.
   * `from` null with a `next` = a detached instance (catalog drag) that lives in no grid yet.
   */
  private changeBag(next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world', hint?: { x: number; y: number }): OpResult {
    const old = this.loadout.bag;
    if (!next && !old) return 'noop';
    if (next && old && next.uid === old.uid) return 'noop';
    const nextDef = next ? ITEM_DEF_MAP.get(next.defId) : undefined;
    if (next && !nextDef?.bag) return 'fail';

    const snap = this.bag.snapshot();
    const srcGrid = from?.kind === 'grid' ? this.getGrid(from.grid) : null;
    let srcPos: Placement | undefined;
    if (next && from) {
      if (from.kind !== 'grid' || !srcGrid) return 'fail';
      srcPos = srcGrid.get(next.uid);
      if (!srcPos) return 'fail';
      srcGrid.remove(next.uid);
    }
    const size = this.bagSizeOf(next);
    const priority: PriorityPlacement[] = [];
    if (old && oldTo === 'grid') {
      const h = hint ?? (from?.kind === 'grid' && from.grid === 'bag' && srcPos ? { x: srcPos.x, y: srcPos.y } : undefined);
      priority.push({ item: old, x: h?.x, y: h?.y });
    }
    const overflow = this.bag.resize(size.cols, size.rows, priority);
    if (old && oldTo === 'grid' && overflow.includes(old)) {
      this.bag.restore(snap);
      if (next && srcGrid && srcPos) srcGrid.place(next, srcPos.x, srcPos.y, next.rotated);
      return 'fail';
    }
    this.loadout.bag = next;
    if (next && nextDef && from) this.emitTransfer(next, nextDef, from, { kind: 'slot', slot: 'bag' });
    for (const it of overflow) this.throwToWorld(it, true);
    if (old && oldTo === 'world') this.throwToWorld(old, true);
    if (overflow.length > 0) {
      this.ctx.bus.emit('ui:notify', { text: `가방 공간 부족: 아이템 ${overflow.length}개를 바닥에 떨어뜨렸습니다`, kind: 'warning' });
    }
    this.ctx.bus.emit('inventory:bagChanged', { ...size, dropped: overflow });
    this.emitLoadout();
    this.afterChange();
    return 'ok';
  }

  /** Remove an item from wherever it currently lives (no events). Anything leaving a container counts as searched. */
  private detach(item: ItemInstance, from: ItemLocation): void {
    if (from.kind === 'slot') {
      if (this.loadout[from.slot]?.uid === item.uid) this.loadout[from.slot] = null;
    } else {
      this.getGrid(from.grid)?.remove(item.uid);
      if (from.grid === 'container') item.searched = true;
    }
  }

  private emitTransfer(item: ItemInstance, def: ItemDef, from: ItemLocation, to: ItemLocation): void {
    const a = this.locKind(from), b = this.locKind(to);
    if (a === b) return;
    if (b === 'player') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
    else this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  private afterMove(item: ItemInstance, from: ItemLocation, to: ItemLocation, qtyOverride?: number): void {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (def) this.emitTransfer(qtyOverride !== undefined ? { ...item, qty: qtyOverride } : item, def, from, to);
    if (from.kind === 'slot' || to.kind === 'slot') this.emitLoadout();
    this.afterChange();
  }

  private emitLoadout(): void {
    const l = this.loadout;
    this.ctx.bus.emit('loadout:changed', { primary: l.primary, secondary: l.secondary, primary2: l.primary2, bag: l.bag, armor: l.armor ?? null });
    for (const slot of LOADOUT_SLOTS) {
      const uid = l[slot]?.uid ?? null;
      if (this.lastEquipUids[slot] === uid) continue;
      this.lastEquipUids[slot] = uid;
      this.ctx.bus.emit('equip:changed', { slot, item: l[slot] ?? null });
    }
  }

  private afterChange(): void {
    const grenades = this.countWhere((d) => d.category === 'grenade');
    const stims = this.countWhere((d) => d.category === 'stim');
    if (grenades !== this.lastGrenades) { this.lastGrenades = grenades; this.ctx.bus.emit('grenade:countChanged', { count: grenades }); }
    if (stims !== this.lastStims) { this.lastStims = stims; this.ctx.bus.emit('stim:countChanged', { count: stims }); }
    this.syncQuickSlots();
    this.emitWeight();
    this.ctx.bus.emit('inventory:changed', { totalValue: this.bag.totalValue(), itemCount: this.bag.count });
    if (this.stash.grid.version !== this.lastStashVersion) {
      this.lastStashVersion = this.stash.grid.version;
      this.stash.markDirty();
      this.ctx.bus.emit('inventory:stashChanged', { count: this.stash.count });
    }
    // Phase 5: every change made in the ship is persisted (debounced); mission changes wait for game:complete
    if (this.ctx.isHubPhase()) this.loadoutStore.markDirty('hub');
    this.checkLooted();
    this.ui?.refresh();
  }

  private checkLooted(): void {
    if (this.activeContainer) this.checkLootedFor(this.activeContainer);
  }

  private checkLootedFor(c: Container): void {
    if (!c.lootedEmitted && c.grid.isEmpty) {
      c.lootedEmitted = true;
      this.ctx.bus.emit('crate:looted', { crateId: c.id });
    }
  }

  /** Can `current` (being displaced from a weapon slot) be placed where the dragged item came from, or anywhere sensible? */
  private canPlaceDisplaced(current: ItemInstance, from: ItemLocation, draggedUid: string): boolean {
    if (from.kind !== 'grid') return false;
    const srcGrid = this.getGrid(from.grid);
    const src = srcGrid?.get(draggedUid);
    if (!srcGrid || !src) return false;
    const ignore = [draggedUid, current.uid];
    // multiplayer: the displaced gear may not land in a shared container — only the bag can take it
    if (this.ctx.isMultiplayer && from.grid === 'container') return this.bag.findFreeSlot(current) !== null;
    if (srcGrid.canPlace(current, src.x, src.y, current.rotated, ignore)) return true;
    if (srcGrid.canPlace(current, src.x, src.y, !current.rotated, ignore)) return true;
    if (srcGrid.findFreeSlot(current, current.rotated, ignore)) return true;
    return from.grid === 'container' && this.bag.findFreeSlot(current) !== null;
  }

  private dropOnSlot(item: ItemInstance, def: ItemDef, from: ItemLocation, slot: SlotId): OpResult {
    if (!slotAccepts(def, slot)) return 'fail';
    if (from.kind === 'slot') {
      if (from.slot === slot) return 'noop';
      if (slot === 'bag' || from.slot === 'bag' || slot === 'armor' || from.slot === 'armor') return 'fail';
      // 주무기 I ↔ 주무기 II (both slots accept the same category, so the swap is always valid)
      const cur = this.loadout[slot];
      if (cur && !slotAccepts(ITEM_DEF_MAP.get(cur.defId)!, from.slot)) return 'fail';
      this.loadout[slot] = item;
      this.loadout[from.slot] = cur ?? null;
      this.emitLoadout();
      this.afterChange();
      return 'ok';
    }
    if (slot === 'bag') return this.changeBag(item, from, 'grid');
    const srcGrid = this.getGrid(from.grid);
    const src = srcGrid?.get(item.uid);
    if (!srcGrid || !src) return 'fail';
    const current = this.loadout[slot];
    const sx = src.x, sy = src.y, srot = item.rotated;
    srcGrid.remove(item.uid);
    if (from.grid === 'container') item.searched = true;
    if (current) {
      const intoShared = this.ctx.isMultiplayer && from.grid === 'container';
      const placed = intoShared
        ? this.bag.autoPlace(current)
        : srcGrid.place(current, sx, sy, current.rotated) ||
          srcGrid.place(current, sx, sy, !current.rotated) ||
          srcGrid.autoPlace(current) ||
          (from.grid === 'container' && this.bag.autoPlace(current));
      if (!placed) { srcGrid.place(item, sx, sy, srot); return 'fail'; }
      if (from.grid === 'container' && srcGrid.has(current.uid)) {
        const cd = ITEM_DEF_MAP.get(current.defId);
        if (cd) this.emitTransfer(current, cd, { kind: 'slot', slot }, from);
      }
    }
    this.loadout[slot] = item;
    this.emitTransfer(item, def, from, { kind: 'slot', slot });
    this.emitLoadout();
    this.afterChange();
    return 'ok';
  }

  private canSwap(item: ItemInstance, fromGrid: GridId, other: ItemInstance, targetGrid: Grid): boolean {
    const srcGrid = this.getGrid(fromGrid);
    const src = srcGrid?.get(item.uid);
    if (!srcGrid || !src) return false;
    const ignore = [item.uid, other.uid];
    if (srcGrid.canPlace(other, src.x, src.y, other.rotated, ignore)) return true;
    if (srcGrid.canPlace(other, src.x, src.y, !other.rotated, ignore)) return true;
    // same-grid: anything free after both are lifted; cross-grid: any free slot in source grid
    const probe = srcGrid === targetGrid ? ignore : [item.uid];
    return srcGrid.findFreeSlot(other, other.rotated, probe) !== null;
  }

  private performSwap(item: ItemInstance, srcGrid: Grid, other: ItemInstance, dstGrid: Grid, x: number, y: number, rotated: boolean): boolean {
    const src = srcGrid.get(item.uid);
    const dst = dstGrid.get(other.uid);
    if (!src || !dst) return false;
    const sx = src.x, sy = src.y, srot = item.rotated;
    const ox = dst.x, oy = dst.y, orot = other.rotated;
    srcGrid.remove(item.uid);
    dstGrid.remove(other.uid);
    if (!dstGrid.place(item, x, y, rotated)) {
      srcGrid.place(item, sx, sy, srot); dstGrid.place(other, ox, oy, orot); return false;
    }
    const placed =
      srcGrid.place(other, sx, sy, orot) ||
      srcGrid.place(other, sx, sy, !orot) ||
      srcGrid.autoPlace(other);
    if (!placed) {
      dstGrid.remove(item.uid);
      srcGrid.place(item, sx, sy, srot);
      dstGrid.place(other, ox, oy, orot);
      return false;
    }
    return true;
  }
  /* ── Phase 10: 분대원 장비 열람 (발사 준비 패널 → 우클릭) ─────────────────── */

  /**
   * My bag + equip slots + quick slots for `CrewMessage.loadout` — the `captureLoadoutSave()` document without the
   * per-container `searched` flags (a crew card is a public snapshot; `captureRaidState` is the one that keeps them).
   */
  captureCrewLoadout(): unknown {
    const save = this.captureLoadoutSave();
    return { ...save, bag: save.bag.map((sv) => { const { searched: _s, ...rest } = sv as SavedPlacement & { searched?: boolean }; return rest; }) };
  }

  /**
   * Read-only 장비 / 가방 / 빠른 사용 view of another member's `captureCrewLoadout()` document (`ui/CrewLoadoutView.ts`):
   * a throwaway grid, no drag / rotate / socket / drop, no 함선 창고 column and no 크레딧 pill. Null when the document
   * is not a loadout. The popup frame belongs to the caller (`hub/`).
   */
  createCrewLoadoutView(host: HTMLElement, loadout: unknown, opts: CrewLoadoutViewOptions = {}): EmbeddedView | null {
    return CrewLoadoutView.create(this, host, loadout, opts);
  }

}

/** Attachments socketed in `weapon` (socket order) — re-exported for the UI. */
export { attachedItems };
