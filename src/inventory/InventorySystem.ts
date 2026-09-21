import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, EffectiveWeaponStats, GameContext, GameSystem,
  InventoryRef, ItemCategory, ItemDef, ItemInstance, LaunchWarning, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot,
  WeightInfo, LoadoutPreset, WorkbenchKind, EmbeddedView, TradeGridsViewOptions,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, LootService, ammoItemIdFor, isWeaponItemDef, itemWeight } from '@/items';
import { bagCapacityBonus, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from './Gear';
import { Grid } from './Grid';
import { Container, ContainerStore } from './Container';
import { attachedItems, findSocketed } from './Sockets';
import {
  createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, mergeIntoQuick, quickSlotOf, quickSlotsSignature,
  type QuickSlotItems,
} from './QuickSlots';
/* appended (2026-09-10): where a stack displaced by a wheel swap goes — preview and execution read the same rule */
import { applyQuickSwap, type QuickSwapCell, type QuickSwapPlan } from './QuickSwap';
import { InventoryUI, type ScreenTab } from './ui/InventoryUI';
export type { ScreenTab } from './ui/InventoryUI';
import { TradeGrids, type TradeGridsOptions } from './ui/TradeGrids';
import { buildTileContent } from './ui/GridView';
import { CELL } from './ui/labels';
import { Stash, starterGrantState } from './Stash';
import { LoadoutStore, type LoadoutSave } from './Loadout';
import { type SavedPlacement } from './Serialize';
/* appended (Phase 10): viewing a squadmate's loadout */
import type { CrewLoadoutViewOptions } from '@/shared';
import { COMMUNITY_BLOCKER, HUB_READY_BLOCKER, MENU_BLOCKER } from '@/shared';
import { CrewLoadoutView } from './ui/CrewLoadoutView';

import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED, LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT,
  SEARCH_EMIT_INTERVAL, SEARCH_START_DELAY, WEAPON_SLOT_IDS, type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow,
  type CraftJob, type DropPreview, type DropTarget, type GridId, type ItemLocation, type MissionOutcome, type OpResult, type PendingTake,
  type RepairInfo, type SlotId, type UiSfx,
} from './model';
/** The folder's shared vocabulary lives in `model.ts` — re-exported verbatim so existing import paths keep working. */
export * from './model';

/* The split implementation modules — a delegate of the same name calls the function inside. See the folder README's `Files`. */
import * as Life from './parts/Lifecycle';
import * as CNet from './parts/ContainerNet';
import * as Docs from './parts/ProfileDocs';
import * as Craft from './parts/Crafting';
import * as Cat from './parts/Catalog';
import * as StashOps from './parts/StashOps';
import * as Drop from './parts/DropResolver';
import * as Dur from './parts/Durability';
import * as SockOut from './parts/SocketDetach';   // 2026-09-14: pulling one socket out of the pinned tooltip
import * as Launch from './parts/LaunchCheck';
/* appended (2026-09-09): death → the corpse container */
import * as Corpse from './parts/CorpseLoot';
/* appended (2026-09-11, A-15): the pouch — one more container drawing the line the quick slots drew */
import * as Pouch from './parts/Pouch';
import * as SortOps from './parts/Sort';
/* appended (2026-09-12, the drone scan): looking inside a container without opening it */
import * as Peek from './parts/Peek';
/* appended (2026-09-12, E1): item favourites */
import * as Fav from './parts/Favorites';
/* appended (2026-09-12): item recovery contracts — the "found in this raid" mark (the rules are `shared/raidFound.ts`) */
import * as RaidMarks from './parts/RaidFound';
import type { RaidFoundScope } from '@/shared';
import { canStackTogether } from './Grid';
import { copyRaidFoundMark, mergeRaidFoundMark } from '@/shared';
import { setRecoveryScope } from './ui/GridView';
/* appended (2026-09-13): meal quality — stack · split · dining-table queries (the rules are `shared/cooking.ts`) */
import * as Meal from './parts/MealQuality';
/* appended (2026-09-14): auto-seating a consumable on the wheel (game-wide) — the three "picked it up" sites read one rule */
import * as AutoQuick from './parts/AutoQuick';
/* appended (2026-09-13): library series — the ribbon on media not yet shelved (the rule is `HousingRef.isShelfItemWanted`) */
import * as ShelfWanted from './parts/ShelfWanted';
/* appended (2026-09-15): android squadmates — bag · weight · container takes · requests · stash deposits (`parts/Allies.ts`) */
import * as Allies from './parts/Allies';
import type { AllyBagRef } from '@/shared';

/* ── 2026-09-14 (launch-pod UI rework): ready = the loadout is read-only ─────────────────────────────────────
   The reason sentence of `readOnlyReason()` and the debounce of its refusal toast. Neither is a balance number —
   screen text and a UI debounce — so both live in code (`ui/model.ts`'s `DRAG_THRESHOLD` · `CLICK_SUPPRESS_MS` spot). */
const READY_LOCK_TEXT = '준비 상태에서는 장비를 바꿀 수 없습니다';
/** Seconds between two refusal toasts (a drag over a locked grid asks many times per second). */
const READY_LOCK_TOAST_S = 1.5;

export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  ctx!: GameContext;
  loot = new LootService();
  bag!: Grid;
  /**
   * 2026-09-11 (A-15) — the **pouch grid**. `resize`d to the `PouchDef` size of the pouch seated in the `pouch`
   * equipment slot; with no pouch it stays an empty 1×1 that **nobody draws** (`getPouchSize()` returns `{0, 0}`).
   * The full text of 「주머니는 가방 격자가 아니다」 is the head comment of `parts/Pouch.ts`.
   */
  pouch!: Grid;
  /** The gate on `inventory:pouchChanged` (the same role `lastQuickSig` plays). */
  lastPouchSig = '';
  loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null, pouch: null };
  /** Tactical kit: last emitted weight / loadout (gates `inventory:weightChanged` / `equip:changed`), running craft. */
  lastWeight: WeightInfo | null = null;
  lastEquipUids: Partial<Record<LoadoutSlot, string | null>> = {};
  craftJob: CraftJob | null = null;
  containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  /** The ship stash (persisted). Shown only while the window is open in the hub (`hubMode`). */
  stash!: Stash;
  /** Phase 5: loadout save (`scav.loadout`); `announcePending` = a save was restored at init and nobody has been told yet. */
  loadoutStore!: LoadoutStore;
  announcePending = false;
  hubMode = false;
  activeContainer: Container | null = null;
  _open = false;
  missionSeed = 0;
  outcome: MissionOutcome = 'none';
  lastGrenades = -1;
  lastStims = -1;
  /**
   * Quick-use wheel — **its own container** (2026-09-09, user's decision): the stack in each wheel direction lives *here*,
   * not in the bag grid (see `QuickSlots.ts`). It still counts toward the bag weight, the HUD counts and every
   * `countWhere` / `consumeWhere` query. `lastQuickSig` gates the change event.
   */
  quickSlots: QuickSlotItems = createQuickSlots();
  lastQuickSig = '';
  lastStashVersion = 0;
  /* Phase 6: infinite-box window state + the bench the craft panel is showing. */
  catalogOpen = false;
  bench: ActiveBench | null = null;
  /* Phase 7: container search + host authority + net subscriptions. */
  /** `parts/` reaches it (`CorpseLoot.openContainerItemsSized`) — it is not a contract outside the folder. */
  openedIds = new Set<string>();
  /**
   * 2026-09-09: this death handed everything to the corpse through `stripForCorpse()` → **the rescue revival is
   * empty-handed**. It skips the starter-grant branch of `player:respawn` exactly once, then clears itself.
   */
  strippedForCorpse = false;
  /**
   * 2026-09-11 (C-36): the equipped bag has already worn this raid (`Dur.wearBagForRaid`). Cleared at `world:ready`.
   * (C-61): it rides in the raid session state (`captureRaidState` → `RaidInventoryState.bagWorn`) and survives a reload.
   */
  bagWornThisRaid = false;
  /**
   * 2026-09-11 (C-61): the `bagWorn` seed the last `applyRaidState` revived (null when there was none). `Life.onWorldReady`
   * reads it once, so the order where the resume blob lands **before** `world:ready` cannot erase that raid's mark.
   */
  bagWornRestoreSeed: number | null = null;
  pendingTakes: PendingTake[] = [];
  private lastSearchEmit = -1;
  /** Seconds left of the `SEARCH_START_DELAY` grace after the container window opened (0 = the search is ticking). */
  private searchDelay = 0;
  /**
   * Phase 9: no inventory-side offline queue any more — every save goes to `profile.set` (`ProfileSync` stamps it and
   * keeps the newest doc per key while offline). `freshSave` marks the saves made inside `withFreshSave` as defaults
   * (`{fresh:true}`: the server keeps them only while it has no document for that key) — the fresh-browser starter
   * kit and the startup stash resize must never beat a real server profile.
   */
  freshSave = false;
  /**
   * 2026-09-11 (E-6): while `flushSaves` writes the stash + loadout, `uploadProfileDoc` collects the documents here and they
   * go up afterwards as one `ProfileRef.setMany`. null outside that call.
   */
  uploadBatch: Partial<Record<'stash' | 'loadout', { doc: unknown; fresh: boolean }>> | null = null;
  /** 2026-09-11 (E-6): the one debounce timer of both stores (`Docs.scheduleSaves`). */
  saveTimer: number | null = null;
  /** E-6: page hide writes both stores through the merged path (registered before the stores' own listeners). */
  private onSavesPageHide = (): void => {
    this.flushSaves();
    try { this.ctx?.net?.profile?.flush(); } catch { /* net not ready */ }
  };
  /** 2026-09-07: `STARTER_STASH` was granted this session (a brand-new profile) → equip the minimum kit once. */
  firstRunGrant = false;
  ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];
  /**
   * 2026-09-08: **Escape no longer closes the window** — it is the pause menu everywhere, and this window (bag,
   * container, `캐릭터` / `기업` / `함선` tabs alike) closes on the key that opened it, `Keys.INVENTORY`. What Escape still
   * does is cancel the innermost popup: a context menu, a split dialog, a confirm card. Those swallow the key, so
   * a mistyped Escape never throws away a drag or a typed amount; with nothing open it falls through to `game/`.
   */
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
    // 2026-09-16: with the messenger over the window, Escape belongs to that panel (top of `ctx.escape`) — the popups and the drag behind it are untouched
    if (this.ctx.uiBlockers.has(COMMUNITY_BLOCKER)) return;
    // 2026-09-12: a stack held on the cursor after a merge goes back where it came from first (it never left)
    if (this.ui?.drag?.held) { this.ui.cancelDrag(); this.sfx('ui_drop'); e.preventDefault(); e.stopPropagation(); return; }
    if (!this.ui?.closePopups()) return;
    e.preventDefault();
    e.stopPropagation();
  };

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.inventory = this;
    ctx.loot = this.loot;
    this.bag = new Grid(BAG_DEFAULT_COLS, BAG_DEFAULT_ROWS, (id) => ITEM_DEF_MAP.get(id));
    // A-15: before a pouch is seated it is an empty 1×1 — `getPouchSize()` says `{0,0}`, so the UI draws no spot for it
    this.pouch = new Grid(1, 1, (id) => ITEM_DEF_MAP.get(id));
    // 2026-09-11 (E-6): before the stores' own page-hide listeners, so a closing tab writes both as one transaction
    window.addEventListener('pagehide', this.onSavesPageHide);
    window.addEventListener('beforeunload', this.onSavesPageHide);
    this.stash = new Stash((id) => ITEM_DEF_MAP.get(id), this.loot);
    this.stash.onSaved = (file) => this.uploadProfileDoc('stash', file); // Phase 7: mirror to the server profile
    // ship housing: the stash facility decides the stash size. At startup only *grow* to it — a persisted larger grid
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
    // 2026-09-07: the starter grant — handed out once per **profile** (`starterGrantState()`), not once per stash file.
    if (starterGrantState() === 'none') this.tryStarterGrant();
    // Phase 10: a take that arrives through the shared state (`cont sync`, or the pending map applied on the first
    // open) is a catch-up, not something happening in front of the player → `live: false`, no animation.
    this.containers.onTaken = (info) =>
      this.emitItemTaken(info.containerId, info.idx, info.uid, info.qty, info.remaining, null, false);
    // 2026-09-12 (item recovery contracts): stack key for every grid / the wheel / sort + the crate roll's raid-found seed
    RaidMarks.installRaidFoundRules(this);
    // Phase 5: the persisted loadout fills the bag + slots once, here; from now on the session state is the truth.
    this.loadoutStore = new LoadoutStore(() => this.captureLoadoutSave(), (reason, file) => {
      ctx.bus.emit('inventory:loadoutSaved', { reason });
      if (reason !== 'profile') {
        this.uploadProfileDoc('loadout', file); // Phase 7: mirror to the server profile
        Fav.onLoadoutSaved(this);               // 2026-09-12 (E1): the favourite list went up with it
      }
    });
    // E-6: one debounce for both stores (a stash ↔ bag move is one save, one transaction)
    this.stash.schedule = () => Docs.scheduleSaves(this);
    this.loadoutStore.schedule = () => Docs.scheduleSaves(this);
    this.restoreLoadoutSave();
    this.ui = new InventoryUI(this, ctx);
    this.ui.mount();
    // 2026-09-13 (library series): the source of the "not yet shelved" ribbon + the events that clear its cache
    this.offs.push(...ShelfWanted.installShelfWanted(this));

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
      bus.on('game:complete', ({ stats }) => {
        this.outcome = 'complete';
        this.loadoutStore.clearRaid();   // 2026-09-11 (E-5): the solo raid is over — its marker goes before the save
        // 2026-09-11 (C-36): on a successful extraction the equipped bag takes one raid's wear — **before** the save
        if (stats.extracted) this.wearBagForRaid();
        // 2026-09-12 (item recovery contracts): meta settled before this event — the raid-found marks stop meaning anything now
        this.stripRaidMarks();
        this.loadoutStore.saveNow('complete');
      }),
      bus.on('game:over', () => { this.onGameOver(); this.stripRaidMarks(); }),
      bus.on('player:respawn', () => this.onRespawn()),
      bus.on('game:abort', () => { this.onAbort(); this.stripRaidMarks(); }),
      bus.on('game:newMission', () => { this.closeAll(); this.clearContainers(); this.outcome = 'none'; }),
      /* Phase 7: server profile documents + host migration */
      bus.on('net:profileLoaded', ({ profile }) => this.onProfileLoaded(profile)),
      bus.on('net:hostChanged', ({ isLocalHost }) => { if (!isLocalHost) this.requestContainerSync(); }),
      bus.on('hub:entered', () => {
        // 2026-09-07: only the very first run (`STARTER_STASH` was just granted) and a player with nothing anywhere
        // get the kit handed to them — a lost raid is re-equipped from the ship stash, not refilled for free.
        if (this.isCompletelyEmpty() && (this.firstRunGrant || this.stash.count === 0)) {
          this.firstRunGrant = false;
          // a fresh browser: the starter is "no data", not an edit — it goes up as a `fresh` document so a real server profile wins
          this.withFreshSave(() => this.applyStarter());
        } else if (this.announcePending) this.announceLoaded();
        Fav.flushDeferred(this);   // 2026-09-12 (E1): a favourite toggled outside the ship is saved now
        if (this.stripRaidMarks()) this.afterChange();   // 2026-09-12: no raid-found mark survives into the ship
      }),
      bus.on('game:phaseChanged', () => { if (!ctx.isGameplayPhase() && !ctx.isHubPhase()) this.closeAll(); }),
      // 2026-09-15 (android squadmates): an extracted android's loot → the squad leader's (this client's) stash
      bus.on('inventory:allyDeposit', ({ id, name, items }) => Allies.onAllyDeposit(this, id, name, items)),
      bus.on('implant:equipped', () => { if (this._open) this.ui?.refresh(); }),
      // 2026-09-08: the `캐릭터` tab's stat-point red dot follows the level-ups / spends that happen behind it
      bus.on('progress:levelUp', () => { if (this._open) this.ui?.markTab(); }),
      bus.on('progress:statChanged', () => { if (this._open) this.ui?.markTab(); }),
      bus.on('progress:loaded', () => { if (this._open) this.ui?.markTab(); }),
      // 2026-09-17: the `기업` tab appears once any corp reaches `신뢰도` Lv.1 (and hides again on a reset profile) — live
      bus.on('meta:repChanged', () => { if (this._open) this.ui?.onCorpAccessChanged(); }),
      bus.on('meta:loaded', () => { if (this._open) this.ui?.onCorpAccessChanged(); }),
      // 2026-09-08: the implant slots moved into the inventory, so an equip changed from outside (a preset, a repair) repaints here too
      bus.on('progress:implantsChanged', () => { if (this._open) this.ui?.refresh(); }),
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
      // 2026-09-09: a player corpse is one container (`pcorpse:<owner>:<n>`). The container has to be created the
      // moment the wire arrives, so the host can judge a `contq take` on a corpse it has never opened itself.
      const corpseOff = Corpse.hookCorpseWire(this, ctx);
      if (corpseOff) this.offs.push(corpseOff);
    }
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(dt: number, ctx: GameContext): void {
    // 2026-09-12 (item recovery contracts): the ribbon's display copy of the scope (`ui/GridView`) — every open grid repaints on a change
    setRecoveryScope(this.raidFoundScope());
    // Tab: bag window on a mission, the 3-column ship screen (`창고` / `장비` / `가방`) in the hub.
    // Phase 10: the launch-pod READY panel holds its own blocker, and Tab must still work while boarded (as before).
    const onlyReadyBlocked = ctx.uiBlockers.size === 0
      || (ctx.uiBlockers.size === 1 && ctx.uiBlockers.has(HUB_READY_BLOCKER));
    // 2026-09-08: Tab is now also the *close* key, so it must not reach through the pause menu stacked on top.
    // 2026-09-14 (the tutorial opening, user's decision): while the intro wake runs (`PlayerRef.introWaking` — before
    // the camera is all the way back to the back view) Tab **does not open** the bag. Closing an open window is fine.
    const waking = ctx.player?.introWaking ?? false;
    // 2026-09-16: with the messenger (`COMMUNITY_BLOCKER`) over the window, Tab closes only that panel (`ui/hud/Community`) — the window stays.
    if (ctx.input.wasPressed(Keys.INVENTORY) && !ctx.uiBlockers.has(MENU_BLOCKER) && !ctx.uiBlockers.has(COMMUNITY_BLOCKER)
      && (ctx.isGameplayPhase() || ctx.isHubPhase()) && (this._open || (onlyReadyBlocked && !waking))) {
      // 2026-09-09 (Tab closes every screen): like Escape, Tab cancels the **innermost popup** first — `수량 지정` ·
      // the right-click menu · salvage · repair · the implant picker — and closes the window only when nothing is
      // stacked over it. The craft column is a column of the window, not a popup, so it goes with the window.
      if (!(this._open && this.ui?.closePopups())) {
        // 2026-09-13: an embedded screen with unsaved work (unconfirmed points on the `캐릭터` tab) may intercept the close and ask first
        if (!(this._open && this.ui?.screenView?.requestLeave?.(() => this.closeAll()))) this.toggleBag();
      }
    }
    this.updateCraft(dt);
    if (!this._open) return;
    // 2026-09-16: while the messenger is over the window the rotate · drop keys never reach the grid behind it
    const messengerOver = ctx.uiBlockers.has(COMMUNITY_BLOCKER);
    if (!messengerOver && ctx.input.wasPressed(Keys.ROTATE_ITEM)) this.ui?.onRotateKey();
    if (!messengerOver && ctx.input.wasPressed(Keys.DROP_ITEM)) {
      const shift = MOD_SHIFT.some((c) => ctx.input.isDown(c));
      const ctrl = MOD_CTRL.some((c) => ctx.input.isDown(c));
      this.ui?.onDropKey(shift, ctrl);
    }
    const player = ctx.player;
    if (player?.isDead) { this.closeAll(); return; }
    // 2026-09-10: measured against **the current spot**, not the copy taken when it opened — a container in a moving tram closed instantly.
    if (this.activeContainer && player && player.position.distanceTo(this.activeContainer.livePosition) > AUTO_CLOSE_DISTANCE) {
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
    window.removeEventListener('pagehide', this.onSavesPageHide);
    window.removeEventListener('beforeunload', this.onSavesPageHide);
    this.flushSaves();   // E-6: both stores through the merged path before they dispose (and flush) on their own
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
   * per mission any more). Only a player with nothing anywhere (loadout, bag **and** the ship stash) gets the minimum kit
   * so a lost run can never soft-lock the game; otherwise everything is kept and only the events every consumer needs
   * (`loadout:changed`, counts, `inventory:changed`) are re-emitted.
   */
  private onWorldReady(seed: number): void { return Life.onWorldReady(this, seed); }

  /* ── Phase 5: loadout persistence (`Loadout.ts`, localStorage `scav.loadout`) ── */

  /** Snapshot for the save file: slots + bag placements + quick slots as bag indices. */
  captureLoadoutSave(): LoadoutSave { return Life.captureLoadoutSave(this); }

  /* ── 2026-09-12: item recovery contracts (`parts/RaidFound.ts`) ── */
  /** The active recovery-contract scope — only in a real raid with an active `extract_with_items` contract, else null. */
  raidFoundScope(): RaidFoundScope | null { return RaidMarks.raidFoundScope(this); }
  /** The raid ended: strip every "found in this raid" mark off the body and the stash (true when anything changed). */
  stripRaidMarks(): boolean { return RaidMarks.stripRaidMarks(this); }

  /**
   * Fill the slots / bag / quick slots from the save (init only, no events). A missing / empty save leaves
   * everything empty so `hub:entered` hands out the starter kit as before. Unknown defs and items that no longer
   * fit are dropped with a warning; a wrong-category slot entry is ignored.
   */
  private restoreLoadoutSave(): boolean { return Life.restoreLoadoutSave(this); }

  /**
   * Replace the slots / bag / quick slots with `save` (no events — callers announce). Returns the revived bag
   * instances in `save.bag` order (null = dropped) so a raid state can restore per-entry flags.
   */
  applyLoadoutSave(save: LoadoutSave): (ItemInstance | null)[] { return Life.applyLoadoutSave(this, save); }

  /** First `hub:entered` after a restored save: tell every consumer (they subscribed after our init). */
  announceLoaded(): void { return Life.announceLoaded(this); }

  /** Legacy mission failure (Phase 2 death flow no longer emits it): everything carried is lost (2026-09-07). */
  private onGameOver(): void { return Life.onGameOver(this); }

  /** Phase 2 death flow: the hellpod re-drop after `PLAYER_RESPAWN_DELAY` brings the starter kit (mission continues, crates keep their state). */
  private onRespawn(): void { return Life.onRespawn(this); }

  /**
   * `game:abort` after a completed mission is just the hub's mechanical transition (result screen → ship): keep
   * the worn weapons for the workbench. After death the kit was already reset. Any other abort (quit mid-mission,
   * lobby lost, back to title) resets to the starter kit.
   */
  private onAbort(): void { return Life.onAbort(this); }

  isCompletelyEmpty(): boolean { return Life.isCompletelyEmpty(this); }

  /** Nothing to raid with anywhere: no loadout, empty bag **and** an empty ship stash (2026-09-07 safety net). */
  isDestitute(): boolean { return Life.isDestitute(this); }

  /**
   * A failed / abandoned raid: everything the player carried is gone and they re-equip from the ship stash
   * (2026-09-07). Only a player whose stash is empty too falls back to the minimum kit.
   */
  loseKit(): void { return Life.loseKit(this); }

  /**
   * The starter grant, once per profile (2026-09-07 fix). The old condition was `Stash.firstRun` — no `scav.stash`
   * file — which silently skipped every profile that existed before the grant did, and every profile whose stash was emptied
   * by an incoming (empty) server document. The state now lives in its own localStorage key:
   *   `none` → grant here (as a `fresh` document on a true first run, so a real server profile still wins) and mark
   *            `pending`; `pending` → re-checked once at `net:profileLoaded`, where the server's stash is known, and
   *            settled to `done` either way. A player who already owns something is settled without a grant.
   */
  tryStarterGrant(): void { return Life.tryStarterGrant(this); }

  /**
   * `STARTER_STASH` into the ship stash (2026-09-07); the "once per profile" decision is `tryStarterGrant`. `stacks`
   * splits an entry into that many full stacks — one set per grid cell.
   */
  grantStarterStash(): void { return Life.grantStarterStash(this); }

  /** Wipe the bag + slots and apply `STARTER_LOADOUT` (`items[].qty` are units / rounds). */
  applyStarter(): void { return Life.applyStarter(this); }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout { return { ...this.loadout }; }

  getDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }

  /**
   * Bag **grid** stacks only (the corp trade / implant desk / workbench list what is sellable / repairable there);
   * the wheel is `getQuickSlots()` and the pouch is `getGrid('pouch')`. 2026-09-11 (A-15): the pouch draws the same
   * line the wheel did — carried everywhere, but not in the trade / repair lists.
   */
  getAllItems(): ItemInstance[] { return this.bag.items().map((p) => p.item); }

  /** Bag grid + wheel stacks + pouch (all of it is carried). */
  getTotalValue(): number { return this.bag.totalValue() + this.quickTotalValue() + Pouch.pouchTotalValue(this); }

  /* ── A-15 (2026-09-11): the pouch (InventoryRef) ───────────────────────── */

  /** The pouch item equipped right now, or null. */
  getEquippedPouch(): ItemInstance | null { return Pouch.getEquippedPouch(this); }

  /** Grid size of the equipped pouch. `{ cols: 0, rows: 0 }` with no pouch — the whole spot goes undrawn. */
  getPouchSize(): { cols: number; rows: number } { return Pouch.getPouchSize(this); }

  /** Whether the pouch equipped right now accepts this item (`PouchDef.accepts`); false with no pouch. */
  pouchAccepts(def: ItemDef | undefined): boolean { return Pouch.pouchAccepts(this, def); }

  /** The stacks in the pouch grid. */
  pouchItems(): ItemInstance[] { return Pouch.pouchItems(this); }

  /**
   * Swap the pouch (null = take it off). When its contents do not fit in the bag **the move itself is refused** —
   * the full rules are in `parts/Pouch.ts`.
   */
  changePouch(next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world',
    hint?: { x: number; y: number }, dest: GridId = 'bag'): OpResult {
    return Pouch.changePouch(this, next, from, oldTo, hint, dest);
  }

  /** Non-empty wheel stacks (in wheel-direction order). */
  quickItems(): ItemInstance[] { return this.quickSlots.filter((it): it is ItemInstance => it !== null); }

  quickTotalValue(): number {
    let v = 0;
    for (const it of this.quickItems()) { const d = ITEM_DEF_MAP.get(it.defId); if (d) v += d.value * it.qty; }
    return v;
  }

  getBagSize(): BagSize { return this.bagSizeOf(this.loadout.bag); }

  /* ── appended: tactical kit — gear slots / weight / durability / crafting ── */

  getEquipped(slot: LoadoutSlot): ItemInstance | null { return this.loadout[slot] ?? null; }

  consumeDef(defId: string, qty: number): boolean {
    const want = Math.max(0, Math.floor(qty));
    if (want === 0) return true;
    if (this.countDef(defId) < want) return false;
    return this.consumeWhere((d) => d.id === defId, want) === want;
  }

  countDef(defId: string): number {
    return this.countWhere((d) => d.id === defId);
  }

  /** Bag + wheel + equipped gear weight against the character's carry capacity (the `근력` strength stat via `ctx.progression`). */
  getWeight(): WeightInfo {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    // 2026-09-09: the wheel is a separate container but it hangs off the same shoulders — its stacks weigh in too.
    // 2026-09-11 (A-15): so does the pouch (and the pouch item itself comes through `LOADOUT_SLOTS` below).
    let w = sumWeight([...this.bag.items().map((p) => p.item), ...this.quickItems(), ...this.pouchItems()], (id) => ITEM_DEF_MAP.get(id));
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (!it) continue;
      const d = ITEM_DEF_MAP.get(it.defId);
      if (d) w += itemWeight(d, it.qty);
    }
    // bigger bags carry more — `BAG_CAPACITY_PER_CELL` kg per grid cell above the bare-shoulders grid
    // (2026-09-12: the 0.5 used to be written here; 「수치는 코드에 적지 않는다」 moved it to data/tuning.csv,
    //  and the bag tooltip now shows the same number as 「소지 한계 +N kg」 via `bagCapacityBonus`).
    const capacity = mult.carryCapacity + bagCapacityBonus(this.bagSizeOf(this.loadout.bag));
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
  getDurability(uid: string): DurabilityInfo | null { return Dur.getDurability(this, uid); }

  /** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
  damageDurability(uid: string, amount: number): void { return Dur.damageDurability(this, uid, amount); }

  /** 2026-09-11 (C-36): the equipped bag wears by one raid's worth (`BAG_DURABILITY_PER_RAID`) — once per raid. */
  wearBagForRaid(): boolean { return Dur.wearBagForRaid(this); }

  /**
   * Phase 12: refill cost of a `회복 스프레이` (`ItemDef.heal.spray`, gauge = `durability` / `durabilityMax`) — one `캔`
   * + one `소독약` per **full** refill, scaled by the missing fraction (ceil, never below 1 each). null for anything else
   * or a full can. The materials come from the bag, exactly like a weapon repair.
   */
  sprayRepairCost(item: ItemInstance, def: ItemDef): CraftIngredient[] | null { return Dur.sprayRepairCost(this, item, def); }

  /**
   * Materials for a full repair — `getRepairCost` (weapons · armor) is read first, and only when it comes back empty
   * the `회복 스프레이`'s gauge refill (`sprayRepairCost`). Since 2026-09-10 repairing armor costs materials too.
   */
  repairMaterials(item: ItemInstance, def: ItemDef): CraftIngredient[] { return Dur.repairMaterials(this, item, def); }

  /**
   * Ship workbench: weapons go through `repairWeapon` (materials), everything else pays `repairMaterials`
   * (armor = the craft materials × the durability bucket multiplier, `회복 스프레이` = `캔` + `소독약`, everything else free).
   */
  repair(uid: string): boolean { return this.readOnlyBlocked() ? false : Dur.repair(this, uid); }

  /**
   * Context-menu repair readout (hub only): materials still needed (`[]` = free), `short` = which of them the bag
   * lacks, `bucket` = the remaining durability bucket. null when the item is not worn / not repairable.
   */
  repairInfo(uid: string): RepairInfo | null { return Dur.repairInfo(this, uid); }

  /** 'ship' while walking the hub / menus, 'field' on a mission. */
  currentStation(): CraftStation { return Craft.currentStation(this); }

  /**
   * 2026-09-14 (user's decision): **the range craft materials are counted over** — bag + ship stash in the ship, bag
   * only for a field quick craft. `canCraft` · `maxCraftCount` · `consumeFor` · the craft window's held chips read this one.
   */
  craftCountDef(defId: string): number { return Craft.craftCountDef(this, defId); }

  /* ── Phase 6 (2026-09-06): the infinite-box catalog ────────────────────── */

  /**
   * `/items` cheat: open the catalog panel (every item def, infinite stock) inside the inventory window — the ship
   * screen in the hub, the bag window on a mission. Opens the window itself when it is closed (blocker `'inventory'`).
   */
  openCatalog(opts?: { category?: ItemCategory }): void { return Cat.openCatalog(this, opts); }

  /** Close the catalog panel; the rest of the window stays open. */
  closeCatalog(): void { return Cat.closeCatalog(this); }

  get isCatalogOpen(): boolean { return this.catalogOpen; }

  /** Units a catalog drag / double-click creates: a full stack for stackables, one otherwise. */
  catalogQty(def: ItemDef): number { return Cat.catalogQty(this, def); }

  /** Drag preview for a detached (catalog) instance over `target`: grids (free cell / merge) and equipment slots. */
  previewCatalog(item: ItemInstance, target: DropTarget): DropPreview { return this.readOnlyReason() ? 'bad' : Cat.previewCatalog(this, item, target); }

  /**
   * Release a catalog drag: the fresh instance lands in the grid cell (or merges into the stack there) / the slot
   * (displaced gear → bag, else stash in the ship). The catalog tile is untouched. 'fail' → the UI shakes the tile.
   */
  dropFromCatalog(item: ItemInstance, target: DropTarget): OpResult { return this.readOnlyBlocked() ? 'fail' : Cat.dropFromCatalog(this, item, target); }

  /** Catalog double-click: a fresh instance straight into the bag (merge into stacks first). */
  takeFromCatalog(defId: string): OpResult { return this.readOnlyBlocked() ? 'fail' : Cat.takeFromCatalog(this, defId); }

  /** Where displaced gear can go: the bag, else the ship stash (hub only). */
  canStow(item: ItemInstance): boolean { return Cat.canStow(this, item); }

  /** Put a detached item into the bag, else the stash (ship). Returns where it went, null when nothing fits. */
  stow(item: ItemInstance): GridId | null { return Cat.stow(this, item); }

  /* ── Phase 6: stash size (the housing stash facility) ──────────────────── */

  getStashSize(): { cols: number; rows: number } { return StashOps.getStashSize(this); }

  /** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
  setStashSize(cols: number, rows: number): boolean { return StashOps.setStashSize(this, cols, rows); }

  /* ── Phase 6: materials across bag + stash (facility upgrades / furniture) ── */

  countDefAll(defId: string): number { return StashOps.countDefAll(this, defId); }

  stashCountDef(defId: string): number { return StashOps.stashCountDef(this, defId); }

  /** Bag first, then the stash; all-or-nothing. */
  consumeDefAll(defId: string, qty: number): boolean { return StashOps.consumeDefAll(this, defId, qty); }

  /* ── A-13 (2026-09-11): using a preparation in the ship ────────────────── */

  /**
   * Use one preparation (`ItemDef.prep`) **in the ship** so it is armed for the next raid (`ctx.progression.usePrep`).
   * null = armed, a string = the Korean refusal reason (and then the item is **left exactly where it was**).
   *
   * The order is the point — **ask progression first and consume only on success.** Consuming first and then being
   * refused leaves nowhere to put it back (`prep` belongs to progression) and the item would silently vanish. A spot
   * it cannot be taken from (an open crate · an equipment slot) is filtered out before asking.
   */
  usePrepItem(uid: string, from?: ItemLocation): string | null { return this.readOnlyReason() ?? StashOps.usePrepItem(this, uid, from); }

  /* 2026-09-16 (the plate model): the old `useMealItem` (right-click `먹기`) is gone — a meal is not an item but the dining table's plate (housing `eatPlate`). */

  /* ── 2026-09-13: meal quality · cooking (InventoryRef, `parts/MealQuality.ts` · `parts/Crafting.ts`) ────── */

  /** How many `defId` in bag + stash sit at exactly quality `quality` (0 includes "no quality field"). */
  countDefQualityAll(defId: string, quality: number): number { return Meal.countDefQualityAll(this, defId, quality); }
  /** Take `qty` of `defId` at exactly quality `quality`, bag first → stash. All or nothing. */
  consumeDefQualityAll(defId: string, quality: number, qty: number): boolean { return Meal.consumeDefQualityAll(this, defId, quality, qty); }
  /** The meals held, per (def, quality) — the dining-table screen. Sorted tier → name → highest quality. */
  getMealStacks(): { defId: string; quality: number; qty: number }[] { return Meal.getMealStacks(this); }
  /** The Korean reason a cook-bench recipe cannot be run once right now (null = it can). The same gate as a ship workbench craft. */
  cookBlock(recipeId: string, benchLevel: number): string | null { return Craft.cookBlock(this, recipeId, benchLevel); }
  /** Consume one cook's materials (no product — the 2026-09-16 plate model; housing puts it on the table). A Korean reason / null; on failure nothing is consumed. */
  consumeCookInputs(recipeId: string, benchLevel: number): string | null { return Craft.consumeCookInputs(this, recipeId, benchLevel); }

  /* ── Phase 6: loadout presets (the range) ──────────────────────────────── */

  captureLoadout(): LoadoutPreset { return StashOps.captureLoadout(this); }

  /** The launch readiness check (2026-09-08): the warnings raised before boarding a launch pod. Read-only — the rules are in `parts/LaunchCheck`. */
  getLaunchWarnings(): LaunchWarning[] { return Launch.getLaunchWarnings(this); }

  /**
   * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
   * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
   * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
   * Ship only — on a mission nothing changes and the result is empty.
   */
  applyLoadout(preset: LoadoutPreset): { equipped: number; missing: string[] } {
    if (this.readOnlyBlocked()) return { equipped: 0, missing: [] };
    return StashOps.applyLoadout(this, preset);
  }

  /** First instance of `defId` in the bag, then the stash. */
  findStoredByDef(defId: string): { item: ItemInstance; grid: GridId } | null { return StashOps.findStoredByDef(this, defId); }

  /** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
  unequipToStorage(slot: LoadoutSlot): boolean { return this.readOnlyBlocked() ? false : StashOps.unequipToStorage(this, slot); }

  /** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
  equipFromStorage(item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean { return this.readOnlyBlocked() ? false : StashOps.equipFromStorage(this, item, gridId, slot); }

  /* ── Phase 6: workshop bench crafting ──────────────────────────────────── */

  /**
   * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
   * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
   */
  openBenchCraft(bench: WorkbenchKind, level: number): void { return Craft.openBenchCraft(this, bench, level); }

  /** Bench the craft panel is showing (null = the plain `제작` panel). */
  getBench(): ActiveBench | null { return Craft.getBench(this); }

  /**
   * 2026-09-12: swap only the bench inside the already-open craft column (the vertical bench list on the left). It
   * neither opens nor closes the window — `null` = quick craft. `ui/CraftPanel` is its only caller.
   */
  switchBench(bench: WorkbenchKind | null, level = 0): void { return Craft.switchBench(this, bench, level); }

  /** Leave bench mode (the panel's `닫기` / the window closed). The window itself stays open. */
  closeBench(): void { return Craft.closeBench(this); }

  /** 2026-09-16: the craft window's `닫기` — when a workbench opened it, **the whole window** closes. false = there was no bench to close. */
  closeCraftWindow(): boolean { return Craft.closeCraftWindow(this); }

  /** Rows for the craft panel: available recipes, then (bench mode) the bench's recipes above its level as locked. */
  getBenchRecipes(): BenchRecipeRow[] { return Craft.getBenchRecipes(this); }

  /**
   * The gear that can be repaired (equipment slots + bag). 2026-09-12: the bench kind is not read — in the ship it is
   * weapons · armor · bags alike, in a raid an empty array. `wornOnly` (2026-09-08, the repair popup's default) drops full rows.
   */
  benchRepairRows(wornOnly = false): BenchRepairRow[] { return Craft.benchRepairRows(this, wornOnly); }

  /** `모두 수리`: every worn row in order while the materials last. `skip` = uids the popup excluded with ×. */
  benchRepairAll(skip?: ReadonlySet<string>): { done: number; skipped: number } {
    if (this.readOnlyBlocked()) return { done: 0, skipped: 0 };
    return Craft.benchRepairAll(this, skip);
  }

  /**
   * Recipes for a station given the current skills. Field: `station: 'field'` recipes only. Ship: field recipes
   * too; a recipe with `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed
   * bench of that kind at that level (`ctx.housing.getBenchLevel`, 0 without housing).
   */
  getRecipes(station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] { return Craft.getRecipes(this, station, bench, level); }

  /**
   * Phase 8 — the salvage recipe of an item the player owns, or null. A `break_*` recipe whose **only** input is that
   * item's def id counts; the UI turns it into the `분해` context-menu entry and the modeless dialog. Crafting
   * itself is unchanged (`craft()` still accepts these recipes) — they are only hidden from the craft *list*.
   */
  disassembleRecipeFor(uid: string): CraftRecipe | null { return Craft.disassembleRecipeFor(this, uid); }

  /**
   * Open the modeless salvage dialog over the open window (the item context menu's `분해` entry; also a handle for
   * the console / smoke tests). False when the window is closed or the item has no `break_*` recipe.
   */
  openDisassemble(uid: string): boolean { return this.readOnlyBlocked() ? false : Craft.openDisassemble(this, uid); }

  /** Recipes the running station / bench may craft right now. */
  availableRecipes(): readonly CraftRecipe[] { return Craft.availableRecipes(this); }

  /** Workshop material discount (`ctx.housing.getCraftCostMul`, ship only); 1 when nothing applies. */
  craftCostMul(): number { return Craft.craftCostMul(this); }

  /** Inputs of a recipe after the workshop discount (ceil, never below 1). */
  craftCost(recipe: CraftRecipe): CraftIngredient[] { return Craft.craftCost(this, recipe); }

  /** `count` (2026-09-09, the craft count, default 1): every ingredient × count must be owned. */
  canCraft(recipeId: string, count = 1): boolean { return this.readOnlyReason() === null && Craft.canCraft(this, recipeId, count); }

  /** 2026-09-09: the most runs the owned materials pay for (≥ 1 — 1 even when nothing is affordable); the count control's `▶` limit. */
  maxCraftCount(recipeId: string): number { return Craft.maxCraftCount(this, recipeId); }

  /** Seconds the `제작` / `분해` button is held — the same `CRAFT_HOLD_TIME` for every recipe (2026-09-08). */
  craftDuration(recipeId: string): number { return Craft.craftDuration(this, recipeId); }

  /**
   * 2026-09-08: can the bag take this recipe's output (+ `extraOutputs`) right now? The same check `updateCraft`
   * makes when the hold ends — the salvage dialog runs it **first** so an impossible shred never costs the hold.
   */
  craftHasRoom(recipeId: string, count = 1, targetUid?: string): boolean { return Craft.craftHasRoom(this, recipeId, count, targetUid); }

  /** `targetUid` (2026-09-08): the exact stack a salvage shreds — consumed before any other stack of the same def. */
  /** `count` (2026-09-09): the craft count — the recipe runs `count` times in one hold (inputs × count, output × count). */
  craft(recipeId: string, targetUid?: string, count = 1): Promise<ItemInstance | null> {
    if (this.readOnlyBlocked()) return Promise.resolve(null);
    return Craft.craft(this, recipeId, targetUid, count);
  }

  /** Abort the running craft (releasing the hold button, closing the panel, dying). */
  cancelCraft(): boolean { return Craft.cancelCraft(this); }

  /** 0..1 progress of the running craft (null when idle). */
  craftProgress(): { recipeId: string; progress: number } | null { return Craft.craftProgress(this); }

  private updateCraft(dt: number): void { return Craft.updateCraft(this, dt); }

  /**
   * Units in the bag grid, **the pouch and the wheel** matching `pred` (2026-09-09: a stim on the wheel is still
   * carried; 2026-09-11 A-15: so is a herb in the `채집 주머니`).
   */
  countWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean): number {
    let n = 0;
    for (const p of this.bag.items()) {
      const def = ITEM_DEF_MAP.get(p.item.defId);
      if (def && pred(def, p.item)) n += p.item.qty;
    }
    for (const it of this.pouchItems()) {
      const def = ITEM_DEF_MAP.get(it.defId);
      if (def && pred(def, it)) n += it.qty;
    }
    for (const it of this.quickItems()) {
      const def = ITEM_DEF_MAP.get(it.defId);
      if (def && pred(def, it)) n += it.qty;
    }
    return n;
  }

  /**
   * Remove up to `qty` units matching `pred`: bag stacks first (smallest first, so partial stacks disappear before
   * full ones), then the pouch, then the wheel — what the player put away on purpose is the last thing a recipe eats.
   */
  consumeWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean, qty: number): number {
    let left = Math.max(0, Math.floor(qty));
    if (left === 0) return 0;
    let consumed = 0;
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
    if (left > 0) {
      const pouched = this.pouch.items()
        .filter((p) => { const d = ITEM_DEF_MAP.get(p.item.defId); return !!d && pred(d, p.item); })
        .sort((a, b) => a.item.qty - b.item.qty);
      for (const p of pouched) {
        if (left <= 0) break;
        const take = Math.min(left, p.item.qty);
        p.item.qty -= take; left -= take; consumed += take;
        if (p.item.qty <= 0) { this.pouch.remove(p.item.uid); this.ctx.bus.emit('inventory:itemRemoved', { item: p.item }); }
        else this.pouch.version++;
      }
    }
    if (left > 0) {
      const wheel = this.quickSlots
        .map((it, index) => ({ it, index }))
        .filter(({ it }) => { const d = it && ITEM_DEF_MAP.get(it.defId); return !!it && !!d && pred(d, it); })
        .sort((a, b) => a.it!.qty - b.it!.qty);
      for (const { it, index } of wheel) {
        if (left <= 0) break;
        const take = Math.min(left, it!.qty);
        it!.qty -= take; left -= take; consumed += take;
        if (it!.qty <= 0) this.removeEmptyQuick(index);
      }
    }
    if (consumed > 0) this.afterChange();
    return consumed;
  }

  /* ── quick-use wheel (InventoryRef) ────────────────────────────────────── */

  /** The wheel's own stacks (2026-09-09: they live here, not in the bag grid). */
  getQuickSlots(): readonly (ItemInstance | null)[] { return this.quickSlots; }

  /** Usable wheel slots for the equipped bag (clamped to QUICK_SLOTS; tactical legendary bags define 9). */
  getQuickSlotCount(): number {
    return Math.min(QUICK_SLOTS, this.getBagSize().quickSlots);
  }

  /**
   * **Move** bag stack `uid` (stim / grenade / usable gadget) into wheel slot `index`, or empty the slot with null —
   * the wheel is its own container since 2026-09-09, so the stack leaves the bag grid and its cells free up.
   *
   * The displaced occupant (a swap, or the `null` clear) goes back to the bag; when the bag has no room the move is
   * **refused** and nothing changes (`inventory:full` names the item) - a wheel stack is never silently destroyed and
   * never dropped on the floor by a UI click. Locked slots (`!isQuickSlotActive`, unlock order N S E W then the
   * diagonals) can be emptied but not filled. A uid already on the wheel moves between slots without touching the bag.
   */
  setQuickSlot(index: number, uid: string | null): boolean {
    if (this.readOnlyBlocked()) return false;
    if (!isQuickIndex(index)) return false;
    const occupant = this.quickSlots[index];

    if (uid === null) {
      if (!occupant) return true;
      if (!this.returnQuickToBag(occupant)) return false;
      this.quickSlots[index] = null;
      this.afterQuickChange();
      return true;
    }

    if (occupant?.uid === uid) return true;
    if (!isQuickSlotActive(index, this.getQuickSlotCount())) return false;

    // already on the wheel: a pure re-order (swap the two slots, the bag never sees it)
    const at = quickSlotOf(this.quickSlots, uid);
    if (at >= 0) {
      this.quickSlots[index] = this.quickSlots[at];
      this.quickSlots[at] = occupant;
      this.afterQuickChange();
      return true;
    }

    // 2026-09-10: the incoming stack may live in **any** grid — the bag · an open crate · the ship stash. It used to
    // be `this.bag.get(uid)` only, so there was no way from a crate straight onto the wheel. A container source is host-gated by the
    // caller (`drop`/`registerQuick` → `guardedTake`); an unsearched container stack is refused here as everywhere.
    const found = this.locateInGrids(uid);
    const item = found?.item;
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!found || !item || !def || !isQuickUsable(def)) return false;
    if (found.gridId === 'container' && item.searched === false) return false;
    const p = found.grid.get(uid);
    if (!p) return false;
    // the occupant may need the cells the incoming stack is about to free, so take the incoming one out first
    const cell = { x: p.x, y: p.y, rotated: item.rotated };
    found.grid.remove(uid);
    /*
     * 2026-09-10 — `QuickSwap` decides where the displaced stack goes: **the cell the incoming stack emptied** → the
     * bag → the source grid. It used to look at the bag only (`returnQuickToBag`), so **a full bag refused the 1:1
     * swap outright**, though the two only had to trade spots. On failure nothing changes (`place`/`autoPlace` are all-or-nothing).
     */
    const swapped = occupant ? applyQuickSwap(this.quickSwapPlan(occupant, found.grid, found.gridId, cell, uid)) : null;
    if (occupant && !swapped) {
      // put it back exactly where it was and refuse
      if (!found.grid.place(item, cell.x, cell.y, cell.rotated)) found.grid.autoPlace(item);
      const od = ITEM_DEF_MAP.get(occupant.defId);
      if (od) this.ctx.bus.emit('inventory:full', { item: occupant, name: od.name });
      return false;
    }
    if (found.gridId === 'container') item.searched = true;
    this.quickSlots[index] = item;
    this.afterQuickChange();
    // crate / stash → wheel is a location change, so it announces itself like a container → bag take does
    if (found.gridId !== 'bag') this.emitTransfer(item, def, { kind: 'grid', grid: found.gridId }, { kind: 'quick', index });
    // …and the displaced stack leaving the player for that same crate / stash is the mirror of it
    if (occupant && swapped !== 'bag' && found.gridId !== 'bag') {
      const od = ITEM_DEF_MAP.get(occupant.defId);
      if (od) this.emitTransfer(occupant, od, { kind: 'quick', index }, { kind: 'grid', grid: found.gridId });
    }
    return true;
  }

  /**
   * 2026-09-10 — the rule for where a wheel swap's **displaced stack** goes (`QuickSwap.ts`). `previewDrop` reads it
   * through `canQuickSwap` and `setQuickSlot` through `applyQuickSwap` — **the same plan**. One's own things cannot go
   * into multiplayer's shared crate (the reason `refusesIntoContainer` exists), so only then the source grid is dropped.
   */
  quickSwapPlan(occupant: ItemInstance, source: Grid | null, sourceId: GridId | null, cell: QuickSwapCell | null, incomingUid: string): QuickSwapPlan {
    // 2026-09-11 (A-15): when the source grid is the **pouch** it is a candidate only if that pouch accepts the
    // displaced stack — taking a bandage out of a first-aid pouch onto the wheel must not quietly push a grenade in.
    const pouchRefuses = sourceId === 'pouch' && !this.pouchAccepts(ITEM_DEF_MAP.get(occupant.defId));
    const allowSource = !(this.ctx.isMultiplayer && sourceId === 'container') && !pouchRefuses;
    return { occupant, bag: this.bag, source, cell, incomingUid, allowSource };
  }

  /**
   * 2026-09-12 (user's decision) — **the same item merges in the wheel cell.** Dropping 2 bandages from the bag onto
   * a cell holding 3 makes it 5. The overflow **stays where it came from** (only the count drops) and the UI sticks
   * that remainder to the cursor (`Drag.holdRemainder`). Source = bag · stash · crate · pouch grid or **another wheel cell**; false when nothing merges.
   */
  mergeIntoQuickSlot(index: number, uid: string, from: ItemLocation): boolean {
    if (this.readOnlyBlocked()) return false;
    const occupant = isQuickIndex(index) ? this.quickSlots[index] : null;
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    // 2026-09-12 (item recovery contracts): a raid-found contract stack and a brought one never merge (`canStackTogether`)
    if (!occupant || !item || !def || occupant.uid === uid || !canStackTogether(occupant, item) || def.stackMax <= 1) return false;
    if (item.searched === false) return false;
    const moved = Math.min(def.stackMax - occupant.qty, item.qty);
    if (moved <= 0) return false;
    occupant.qty += moved;
    item.qty -= moved;
    mergeRaidFoundMark(occupant, item);
    const to: ItemLocation = { kind: 'quick', index };
    if (this.locKind(from) !== 'player') this.emitTransfer({ ...item, qty: moved }, def, from, to);
    if (item.qty <= 0) {
      this.detach(item, from);
    } else if (from.kind === 'grid') {
      const g = this.getGrid(from.grid);
      if (g) g.version++;
    }
    this.afterQuickChange();
    return true;
  }

  /** 2026-09-12: a Shift / Ctrl split (`qty` units of grid stack `uid`) released over wheel cell `index`. */
  previewQuickPartial(index: number, uid: string, from: ItemLocation, qty: number): DropPreview {
    if (this.readOnlyReason()) return 'bad';
    if (from.kind !== 'grid' || this.isItemLocked(uid, from)) return 'bad';
    if (!isQuickIndex(index) || !isQuickSlotActive(index, this.getQuickSlotCount())) return 'bad';
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    const n = Math.floor(qty);
    if (!item || !def || !isQuickUsable(def) || !Number.isFinite(n) || n < 1 || n >= item.qty) return 'bad';
    const occupant = this.quickSlots[index];
    if (!occupant) return 'ok';
    return canStackTogether(occupant, item) && occupant.qty < def.stackMax ? 'merge' : 'bad';
  }

  /** 2026-09-12: execute `previewQuickPartial` — a new wheel stack in an empty cell, or a merge into the same item. */
  dropQuickPartial(index: number, uid: string, from: ItemLocation, qty: number): OpResult {
    if (this.readOnlyBlocked()) return 'fail';
    const pv = this.previewQuickPartial(index, uid, from, qty);
    if (pv === 'bad' || from.kind !== 'grid') return 'fail';
    const item = this.findItem(uid, from)!;
    const def = ITEM_DEF_MAP.get(item.defId)!;
    const src = this.getGrid(from.grid);
    if (!src) return 'fail';
    const n = Math.floor(qty);
    const to: ItemLocation = { kind: 'quick', index };
    if (pv === 'ok') {
      const created = this.loot.createItem(item.defId, n);
      copyRaidFoundMark(created, item);   // 2026-09-12: a split keeps the raid-found mark
      Meal.copyMealQuality(created, item);   // 2026-09-13: …and the meal quality
      item.qty -= n;
      src.version++;
      this.quickSlots[index] = created;
      if (this.locKind(from) !== 'player') this.emitTransfer(created, def, from, to);
      this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
      this.afterQuickChange();
      return 'ok';
    }
    const occupant = this.quickSlots[index]!;
    const moved = Math.min(def.stackMax - occupant.qty, n);
    if (moved <= 0) return 'fail';
    occupant.qty += moved;
    item.qty -= moved;
    mergeRaidFoundMark(occupant, item);
    src.version++;
    if (this.locKind(from) !== 'player') this.emitTransfer({ ...item, qty: moved }, def, from, to);
    this.afterQuickChange();
    return 'ok';
  }

  /** 2026-09-12: the auto sort (bag · ship stash) — `parts/Sort.ts`. `keep` uids are moved but never merged away. */
  sortGrid(gridId: 'bag' | 'stash', keep?: (uid: string) => boolean): OpResult { return this.readOnlyBlocked() ? 'fail' : SortOps.sortGrid(this, gridId, keep); }

  /** Wheel to bag (merging into stacks first). False when the bag has no room; the caller then refuses the move. */
  private returnQuickToBag(item: ItemInstance): boolean {
    if (this.bag.autoPlace(item)) return true;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (def) this.ctx.bus.emit('inventory:full', { item, name: def.name });
    return false;
  }

  /** A wheel move changed something: the bag tiles, the HUD wheel, the weight and the save file all follow. */
  private afterQuickChange(): void {
    this.bag.version++;
    this.syncQuickSlots();
    this.afterChange();
    this.ui?.refresh();
  }

  /** Slot index holding stack `uid`, or -1 (UI badges / menu state). */
  quickIndexOf(uid: string): number { return quickSlotOf(this.quickSlots, uid); }

  /**
   * Context menu: move the stack into the first free usable slot. 'noop' when it is already on the wheel.
   * 2026-09-10: the stack may sit in the open crate — that path is a take, so it goes through `guardedTake`
   * (host-confirmed in multiplayer) exactly like crate → bag.
   */
  registerQuick(uid: string): OpResult {
    if (this.readOnlyBlocked()) return 'fail';
    if (this.quickIndexOf(uid) >= 0) return 'noop';
    const index = firstFreeQuickSlot(this.quickSlots, this.getQuickSlotCount());
    if (index < 0) return 'fail';
    const found = this.locate(uid);
    if (found && this.isContainerLoc(found.from)) {
      return this.guardedTake(uid, found.from, null, () => (this.setQuickSlot(index, uid) ? 'ok' : 'fail'));
    }
    return this.setQuickSlot(index, uid) ? 'ok' : 'fail';
  }

  /** Wheel slot back into the bag. 'noop' when the slot is empty, 'fail' when the bag is full. */
  unregisterQuick(index: number): OpResult {
    if (this.readOnlyBlocked()) return 'fail';
    if (!isQuickIndex(index) || !this.quickSlots[index]) return 'noop';
    return this.setQuickSlot(index, null) ? 'ok' : 'fail';
  }

  /**
   * Weapons: a stim was injected / a grenade thrown from this exact stack - **wheel first**, since that is where
   * the quick-use hand takes from (`weapons/parts/QuickUse`), then the bag grid for anything else that names a uid.
   * Removes up to `qty` units and returns the count; an emptied stack disappears (`inventory:itemRemoved`) and, on
   * the wheel, clears its slot (`inventory:quickSlotsChanged`).
   */
  consumeItem(uid: string, qty = 1): number {
    const want = Math.max(0, Math.floor(qty));
    if (want <= 0) return 0;

    const qi = quickSlotOf(this.quickSlots, uid);
    if (qi >= 0) {
      const item = this.quickSlots[qi];
      if (!item) return 0;
      const n = Math.min(want, item.qty);
      if (n <= 0) return 0;
      item.qty -= n;
      if (item.qty <= 0) this.removeEmptyQuick(qi);
      else this.syncQuickSlots();
      this.afterChange();
      return n;
    }

    const p = this.bag.get(uid);
    const n = Math.min(want, p?.item.qty ?? 0);
    if (!p || n <= 0) return 0;
    p.item.qty -= n;
    if (p.item.qty <= 0) this.removeEmptyStack(p.item);
    else this.bag.version++;
    this.afterChange();
    return n;
  }

  /** A bag stack hit 0: drop it from the grid and announce. (The wheel is a separate container - see `removeEmptyQuick`.) */
  private removeEmptyStack(item: ItemInstance): void {
    this.bag.remove(item.uid);
    this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  /** A wheel stack hit 0: empty its slot and announce. The slot stays usable, it just holds nothing. */
  private removeEmptyQuick(index: number): void {
    const item = this.quickSlots[index];
    if (!item) return;
    this.quickSlots[index] = null;
    this.syncQuickSlots();
    this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  /** Emit `inventory:quickSlotsChanged` when anything the HUD shows changed (no pruning - the stacks live here). */
  private syncQuickSlots(): void {
    const active = this.getQuickSlotCount();
    const sig = quickSlotsSignature(this.quickSlots, active);
    if (sig === this.lastQuickSig) return;
    this.lastQuickSig = sig;
    this.ctx.bus.emit('inventory:quickSlotsChanged', { slots: [...this.getQuickSlots()], active });
  }

  tryAddItem(item: ItemInstance): boolean {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) return false;
    // 2026-09-09: top the **wheel** stacks up first — picking up a bandage while the wheel holds a partial bandage stack
    // should refill the thing the player actually uses, not start a second stack in the grid.
    if (mergeIntoQuick(this.quickSlots, item, (id) => ITEM_DEF_MAP.get(id)) <= 0) {
      this.syncQuickSlots();
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.afterChange();
      return true;
    }
    /*
     * 2026-09-14 (user's decision — auto-seating a consumable on the wheel, **game-wide**): when what is left after the
     * merge is a kind the wheel takes and a **free cell** exists, it sits there before the bag. The rule is the one set
     * in `parts/AutoQuick`; this stack is in no grid yet, so it goes straight into the cell, not through `setQuickSlot` — still a **move**, not a copy.
     */
    const qi = AutoQuick.autoQuickIndexFor(this, item, def);
    if (qi >= 0) {
      this.quickSlots[qi] = item;
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.afterQuickChange();
      return true;
    }
    if (!this.bag.autoPlace(item)) {
      this.ctx.bus.emit('inventory:full', { item, name: def.name });
      return false;
    }
    this.syncQuickSlots();   // a partial merge changed a wheel qty
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
    if (this.readOnlyBlocked()) return false;
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
    // A-15: the equipped pouch goes through `changePouch` too — its contents must reach the bag first
    if (from.kind === 'slot' && from.slot === 'pouch') return this.changePouch(null, null, 'world') === 'ok';

    let dropped: ItemInstance;
    if (n >= item.qty) {
      this.detach(item, from);
      dropped = item;
    } else {
      dropped = this.loot.createItem(item.defId, n);
      copyRaidFoundMark(dropped, item);   // 2026-09-12: the dropped part keeps the raid-found mark
      Meal.copyMealQuality(dropped, item);   // 2026-09-13: …and the meal quality
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
    if (this.readOnlyBlocked()) return false;
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
    copyRaidFoundMark(created, item);   // 2026-09-12: a split keeps the raid-found mark
    Meal.copyMealQuality(created, item);   // 2026-09-13: …and the meal quality
    const slot = grid.findFreeSlot(created, item.rotated);
    if (!slot || !grid.place(created, slot.x, slot.y, slot.rotated)) return false;
    item.qty -= n;
    this.ctx.bus.emit('inventory:itemSplit', { source: item, created });
    this.afterChange();
    return true;
  }

  /** Any player-owned item: bag → wheel → equipment slots → attachments socketed in an owned weapon. */
  findItem(uid: string, from?: ItemLocation): ItemInstance | null {
    if (from) {
      if (from.kind === 'slot') return this.loadout[from.slot]?.uid === uid ? (this.loadout[from.slot] ?? null) : null;
      // 2026-09-09: the wheel is its own container, so a `quick` location is answered from the slot itself
      if (from.kind === 'quick') {
        const it = this.quickSlots[from.index];
        return it?.uid === uid ? it : null;
      }
      return this.getGrid(from.grid)?.get(uid)?.item ?? null;
    }
    const p = this.bag.get(uid);
    if (p) return p.item;
    const pp = this.pouch.get(uid);   // A-15: the pouch is carried, so a bare uid must find it too
    if (pp) return pp.item;
    const qi = quickSlotOf(this.quickSlots, uid);
    if (qi >= 0) return this.quickSlots[qi];
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
    else if (this.pouch.has(uid)) this.pouch.version++;
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    this.afterChange();
    return true;
  }

  /** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
  attachToWeapon(weaponUid: string, attachmentUid: string): boolean { return this.readOnlyBlocked() ? false : Dur.attachToWeapon(this, weaponUid, attachmentUid); }

  /** Every attachment of weapon `uid` back into the bag (overflow drops to the ground). False when none / not found. */
  detachAllSockets(uid: string): boolean { return this.readOnlyBlocked() ? false : Dur.detachAllSockets(this, uid); }

  /**
   * 2026-09-14 (the pinned tooltip): take one `socket` off weapon `weaponUid` into `target` (a bag · stash · pouch cell,
   * or the ground in a raid) — the mirror of `attachToWeapon` (`parts/SocketDetach`). A blocked cell gives `'fail'` and the attachment stays in its socket.
   */
  detachSocket(weaponUid: string, socket: SocketSlot, target: import('./model').DetachTarget): OpResult { return this.readOnlyBlocked() ? 'fail' : SockOut.detachSocket(this, weaponUid, socket, target); }
  /** The cell highlight while dragging — would `detachSocket` succeed right now (it changes nothing). */
  previewDetach(weaponUid: string, socket: SocketSlot, target: import('./model').DetachTarget): 'ok' | 'bad' { return this.readOnlyReason() ? 'bad' : SockOut.previewDetach(this, weaponUid, socket, target); }
  /** Whether this weapon sits where its sockets can be dragged out (bag · equipment slot · ship stash). False inside a crate or a corpse. */
  canDetachSockets(weaponUid: string): boolean { return SockOut.canDetachSockets(this, weaponUid); }

  /** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
  unloadWeapon(uid: string): boolean { return this.readOnlyBlocked() ? false : Dur.unloadWeapon(this, uid); }

  /** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
  repairWeapon(uid: string): boolean { return this.readOnlyBlocked() ? false : Dur.repairWeapon(this, uid); }

  /** Equip a bag / container item into `slot`, move a weapon between the primary slots, or unequip with null. */
  equip(uid: string | null, slot: LoadoutSlot): boolean {
    if (this.readOnlyBlocked()) return false;
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
  moveToStash(uid: string, from: ItemLocation): OpResult { return this.readOnlyBlocked() ? 'fail' : StashOps.moveToStash(this, uid, from); }

  /** 2026-09-16: `모두 창고로 이동` in the bag header (ship) — the bag **grid** only, largest first; `left` = how many had no room. */
  moveBagToStash(): { moved: number; left: number } { return this.readOnlyBlocked() ? { moved: 0, left: 0 } : StashOps.moveBagToStash(this); }

  /**
   * Quick chat (middle-click / 요청 menu entry): `탄약 필요: <탄종>` for weapons, `<이름> 필요` for anything else
   * (`chat:post`, kind 'request'). 2026-09-09: the weapon's own name left the ammo line — the squad needs the calibre,
   * not the gun. Equipment-slot tiles reach this through the same `Drag.beginPress` middle-button path as grid tiles.
   * 2026-09-15 (user decision): the **equipped** armor while the shield is not full → `실드 충전 필요`
   * (`wantsShieldRecharge`); a full shield or an armor that is not the equipped one stays `<이름> 필요`.
   */
  requestItem(uid: string, from: ItemLocation): boolean {
    if (this.isItemLocked(uid, from)) return false;
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    const stats = this.loot.getEffectiveStats(item);
    const text = stats ? `탄약 필요: ${AMMO_LABEL_KO[stats.ammoType]}`
      : this.wantsShieldRecharge(from) ? '실드 충전 필요'
      : `${def.name} 필요`;
    this.ctx.bus.emit('chat:post', { text, kind: 'request' });
    // 2026-09-15 (android squadmates): the same request also goes out as an event androids can hear (`allyq item` to a remote host)
    Allies.emitItemRequest(this, item, from, stats ? stats.ammoType : null);
    return true;
  }

  /**
   * 2026-09-15 (user's decision): whether requesting the item in this spot asks for a 「실드 충전」 instead — only in the
   * **equipped armor slot** and only while the shield is short. The request text and the menu name read this one function.
   */
  wantsShieldRecharge(from: ItemLocation): boolean {
    if (from.kind !== 'slot' || from.slot !== 'armor') return false;
    const p = this.ctx.player;
    return !!p && p.maxShield > 0 && p.shield < p.maxShield;
  }

  /**
   * 2026-09-11 (C-16) — the window already shows this very container: nothing to do. Structure containers call
   * `openContainerItems` and then emit `crate:open` for the same id, which used to show the window twice (two
   * `inventory:opened`, `ui_open` played twice) and add a `first: false` `inventory:containerOpened`.
   */
  isShowingContainer(containerId: string): boolean {
    return this._open && this.activeContainer?.id === containerId;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    if (this.isShowingContainer(containerId)) return;
    const first = !this.openedIds.has(containerId);
    this.openedIds.add(containerId);
    // 2026-09-16: world answers the roll rules (the locked room is exempt from the epic-plus gate) — the same value peek and the android settle read
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed, this.ctx.missionPlanet,
      this.ctx.world?.crateLootOpts?.(containerId));
    this.showContainer(c);
    this.ctx.bus.emit('inventory:containerOpened', { containerId, first });
  }

  /**
   * Loot window for a container whose contents the caller supplies (corpses: `ctx.loot.rollCorpse`).
   * `items` are placed only on the first open of `containerId` (largest-first on the fixed 6×4 grid,
   * overflow dropped with a warning); a known id shows what is left. Title defaults to `컨테이너`.
   */
  openContainerItems(containerId: string, items: ItemInstance[], position: THREE.Vector3, title?: string): void {
    if (this.isShowingContainer(containerId)) return;
    const first = !this.openedIds.has(containerId);
    this.openedIds.add(containerId);
    const c = this.containers.getOrCreateWithItems(containerId, items, position, title);
    this.showContainer(c);
    this.ctx.bus.emit('inventory:containerOpened', { containerId, first });
  }

  /**
   * 2026-09-09 — the same as `openContainerItems` but the grid size is given (a player corpse asks for
   * `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`). For a known id both `items` and the size are ignored and what is left is shown.
   */
  openContainerItemsSized(containerId: string, items: ItemInstance[], position: THREE.Vector3,
    cols: number, rows: number, title?: string): void {
    return Corpse.openContainerItemsSized(this, containerId, items, position, cols, rows, title);
  }

  /** 2026-09-12 (the drone scan) — what opening it right now would show, without opening it (`parts/Peek`). */
  peekContainerItems(containerId: string, tier?: number): readonly ItemInstance[] | null { return Peek.peekContainerItems(this, containerId, tier); }
  peekSuppliedItems(containerId: string, items: readonly ItemInstance[], cols?: number, rows?: number): readonly ItemInstance[] { return Peek.peekSuppliedItems(this, containerId, items, cols, rows); }

  /**
   * 2026-09-09 — pulls everything held at the moment of death (equipment · bag · quick slots) and empties the local
   * inventory. It is the only way a corpse container is filled, called exactly once from `game/parts/Death`.
   */
  stripForCorpse(): ItemInstance[] { return Corpse.stripForCorpse(this); }

  showContainer(c: Container): void {
    this.activeContainer = c;
    this.searchDelay = SEARCH_START_DELAY;   // 2026-09-08: the search waits out the window's open animation
    this.hubMode = false;
    this.setOpen(true);
    this.ui?.show(c, false);
    this.ctx.bus.emit('inventory:opened', { containerId: c.id });
    // 2026-09-15 (android squadmates): crates · structure containers · corpses — this is the **only way** the window opens, so it is announced here alone
    Allies.emitContainerViewed(this, c.id);
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
   * Open the Tab window in ship mode on a **screen tab** (2026-09-07). The `기업 네트워크` console uses this: the corp
   * screen has no overlay of its own any more, it is the window's `기업` tab. Ship-only (the embedded screens are), and
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
   * Phase 9 UI pass: the player's real bag / ship stash grids embedded in another folder's screen (corp trading).
   * `ui/TradeGrids.ts` is read + drag-out only and mutates nothing — see `InventoryRef.createTradeGrids`.
   */
  createTradeGrids(host: HTMLElement, opts: TradeGridsViewOptions = {}): EmbeddedView {
    return new TradeGrids(this, this.ctx, host, opts as TradeGridsOptions);
  }

  /** 2026-09-12: a standalone grid-look tile for another folder's screen — see `InventoryRef.buildItemTile`. */
  buildItemTile(defId: string, qty: number, opts: { cell?: number; durability?: number } = {}): HTMLElement {
    const el = document.createElement('div');
    const def = this.getDef(defId);
    if (!def) { el.className = 'inv-tile'; return el; }
    const item = this.loot.createItem(defId, Math.max(1, Math.floor(qty)));
    item.qty = Math.max(1, Math.floor(qty));
    if (opts.durability !== undefined) item.durability = opts.durability;
    buildTileContent(el, item, def, def.width, def.height, this.getStats(item), Math.max(16, Math.round(opts.cell ?? CELL)));
    el.classList.add('is-standalone');
    el.dataset.itemTip = '';
    el.dataset.defId = defId;
    return el;
  }

  /* ── 2026-09-12 (E1): item favourites (InventoryRef, `parts/Favorites.ts`) ───────────────────────────── */

  /** Favourite item kinds (def ids). The one table — `ui/GridView` only holds a display copy. */
  favorites = new Set<string>();
  /** A toggle not yet written with a loadout save (set outside the ship, or while the save debounce runs). */
  favoritesDirty = false;
  /** Sorted `favoriteDefIds` snapshot (null = rebuild). */
  favoriteIdsCache: string[] | null = null;

  isFavorite(defId: string): boolean { return Fav.isFavorite(this, defId); }
  toggleFavorite(defId: string, on?: boolean): boolean { return Fav.toggleFavorite(this, defId, on); }
  get favoriteDefIds(): readonly string[] { return Fav.favoriteDefIds(this); }
  /** `LoadoutSave.fav` for `captureLoadoutSave` (undefined when empty). */
  captureFavorites(): string[] | undefined { return Fav.captureFavorites(this); }
  /** Replace the table with a stored list (boot file with `force`, server document without). */
  applySavedFavorites(raw: unknown, force = false): void { return Fav.applySavedFavorites(this, raw, force); }
  /** Where a quick move from `from` would go (null = nowhere). The right-click menu labels 「빠른 이동」 with it. */
  quickMoveDest(from: ItemLocation): GridId | null { return Drop.quickMoveDest(this, from); }

  /* ── Phase 5: corp shop / stash access (InventoryRef) ─────────────────── */

  /** Bag → slots → sockets of owned weapons → stash (incl. sockets of stashed weapons). */
  findItemAnywhere(uid: string): ItemInstance | null { return StashOps.findItemAnywhere(this, uid); }

  /** Auto-place a fresh instance in the stash (merging into stacks first). Persists + `inventory:stashChanged`. */
  tryAddToStash(item: ItemInstance): boolean { return StashOps.tryAddToStash(this, item); }

  /** Bag first (`inventory:itemAdded`), then the stash. No `inventory:full` — the caller (corp shop) reports. */
  tryAddItemAnywhere(item: ItemInstance): 'bag' | 'stash' | null { return StashOps.tryAddItemAnywhere(this, item); }

  /**
   * Remove `qty` units (default: all) of bag / stash stack `uid` without a world drop (corp sale). Equipped gear,
   * socketed attachments and crate contents are refused (0). A bag stack that hits 0 leaves through the usual
   * path (`inventory:itemRemoved`, its wheel slot relinked / cleared); the stash persists through `afterChange`.
   */
  takeItem(uid: string, qty?: number): number {
    // 2026-09-09: a stack on the wheel is carried like any other, so it can be sold / handed over as well
    const qi = quickSlotOf(this.quickSlots, uid);
    if (qi >= 0) {
      const it = this.quickSlots[qi];
      if (!it) return 0;
      const want = qty === undefined ? it.qty : Math.floor(qty);
      if (!Number.isFinite(want) || want < 1) return 0;
      const n = Math.min(want, it.qty);
      it.qty -= n;
      if (it.qty <= 0) this.removeEmptyQuick(qi);
      else this.syncQuickSlots();
      this.afterChange();
      return n;
    }
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
  clearContainers(): void {
    this.containers.clear();
    this.openedIds.clear();
    this.pendingTakes = [];
    this.lastSearchEmit = -1;
    this.searchDelay = 0;
  }

  /* ── Phase 7 (2026-09-06): container search ─────────────────────────────── */

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
    if (this.searchDelay > 0) {
      // the window only just opened — hold the first item's timer for a beat (`SEARCH_START_DELAY`)
      this.searchDelay = Math.max(0, this.searchDelay - Math.max(0, dt));
      this.ui?.setSearchProgress(next.item.uid, 0, true);
      return;
    }
    const item = next.item;
    const def = ITEM_DEF_MAP.get(item.defId);
    if (!def) { item.searched = true; c.grid.version++; return; }
    const inRange = player.position.distanceTo(c.livePosition) <= SEARCH_MAX_DISTANCE;
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

  /* ── 2026-09-14: ready = the loadout is read-only (launch-pod UI rework) ─── */

  /**
   * **Why the loadout cannot be changed right now** (null = it can). While seated in a launch pod and **marked ready**
   * the Tab window still opens (looking at a squadmate's loadout keeps working) but drag · equip · unequip · salvage ·
   * repair · craft · quick-slot changes are all refused. Cancelling ready makes it editable again exactly as before.
   *
   * The gate is **this one place** and the UI reads nothing else — a per-screen judgement of its own would leave one
   * screen out. The state itself belongs to hub (`HubSystem.launchReady`, `boardedSlot >= 0 && readyLocal`) and the
   * contract is `HubRef.launchReady` (an optional field — on the title screen and in a raid `ctx.hub` is null).
   */
  readOnlyReason(): string | null {
    const hub = this.ctx.hub;
    if (hub && hub.active && hub.launchReady === true) return READY_LOCK_TEXT;
    return null;
  }

  /** `ctx.time` of the last refusal toast — a drag over a locked grid must not spam the ticker. */
  private lastReadOnlyToastAt = -Infinity;

  /**
   * true = it is read-only right now, so **refuse and say why**. It is the first line of every mutating entry point;
   * a preview (`previewDrop` and its kind) reads `readOnlyReason()` alone and returns red without a toast.
   */
  private readOnlyBlocked(): boolean {
    const why = this.readOnlyReason();
    if (!why) return false;
    const now = this.ctx.time;
    if (now - this.lastReadOnlyToastAt > READY_LOCK_TOAST_S) {
      this.lastReadOnlyToastAt = now;
      this.ctx.bus.emit('ui:notify', { text: why, kind: 'warning' });
      this.ctx.bus.emit('audio:play', { id: 'ui_deny' });
    }
    return true;
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
  needsTakeRequest(from: ItemLocation): boolean { return CNet.needsTakeRequest(this, from); }

  /** Multiplayer host: applies takes itself and broadcasts them. */
  isNetAuthority(): boolean { return CNet.isNetAuthority(this); }

  isContainerLoc(loc: ItemLocation): boolean { return CNet.isContainerLoc(this, loc); }

  /** Multiplayer: nothing may be put INTO a container (only takes are shared), so container-bound drops are refused. */
  refusesIntoContainer(from: ItemLocation, target: DropTarget): boolean { return CNet.refusesIntoContainer(this, from, target); }

  /**
   * Gate for a container → player move of `qty` units (null = the whole stack) of `uid`: an unsearched item is refused;
   * a multiplayer client sends `contq take` and replays `run` on `cont taken` (`'pending'`); the host / single-player
   * runs it now and — in multiplayer — records + broadcasts what actually left the container.
   */
  guardedTake(uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult { return CNet.guardedTake(this, uid, from, qty, run); }

  requestTake(uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult { return CNet.requestTake(this, uid, from, qty, run); }

  /**
   * Run a container take now (host / single-player). The multiplayer host records + broadcasts the units that left its
   * copy; every local take also reports `container:itemTaken {live: true, byLocal: true}` so the same consumers see
   * my own loot and a squad mate's through one event.
   */
  trackTake(uid: string, from: ItemLocation, run: () => OpResult): OpResult { return CNet.trackTake(this, uid, from, run); }

  announceTake(c: Container, idx: number, qty: number, by?: string): void { return CNet.announceTake(this, c, idx, qty, by); }

  /**
   * Phase 10 — the one place `container:itemTaken` is emitted. `live` separates a real-time take (someone is looting
   * this crate right now → animate) from a `cont sync` / pending catch-up (silent). A live take by **another** member
   * also marks the tile so `GridView.refresh` animates it out instead of deleting it.
   */
  emitItemTaken(containerId: string, idx: number, uid: string | null, qty: number, remaining: number, by: NetPeerId | null, live: boolean): void { return CNet.emitItemTaken(this, containerId, idx, uid, qty, remaining, by, live); }

  /** Uids of container items whose take is waiting for the host (UI pulse). */
  pendingTakeUids(): ReadonlySet<string> { return CNet.pendingTakeUids(this); }

  private expirePendingTakes(): void { return CNet.expirePendingTakes(this); }

  /** Host → all `cont` (taken / denied / sync). Only the lobby host is trusted. */
  private onContainerMessage(msg: ContainerMessage, from: NetPeerId): void { return CNet.onContainerMessage(this, msg, from); }

  /** My `contq take` was confirmed: replay the move (the item may sit in a container whose window closed meanwhile). */
  resolvePendingTake(id: string, idx: number, qty: number): void { return CNet.resolvePendingTake(this, id, idx, qty); }

  /**
   * Someone else's take was confirmed: remove it from my copy (or remember it for a container I have not opened).
   * Phase 10: the uid is read **before** `applyTaken` drops the placement and reported as a live take, so the tile
   * animates out and the HUD can name the looter.
   */
  applyRemoteTaken(id: string, idx: number, qty: number, by: NetPeerId | null, hostRemaining?: number): void { return CNet.applyRemoteTaken(this, id, idx, qty, by, hostRemaining); }

  /** Host: validate a peer's `contq take` against its own copy (rolled on demand for world crates) and broadcast. */
  private onContainerRequest(msg: ContainerRequest, from: NetPeerId): void { return CNet.onContainerRequest(this, msg, from); }

  /** Host: a world crate it never opened can still be rolled (deterministic seed ^ id) to validate a request. */
  materializeCrate(id: string): Container | null { return CNet.materializeCrate(this, id); }

  /** Ask the (new) host for every taken map (host migration, rejoin fallback). */
  private requestContainerSync(): void { return CNet.requestContainerSync(this); }

  /* ── 2026-09-15: android squadmates (`parts/Allies.ts`) ────────────────── */

  /** One bag grid with no DOM (for an android — the same placement · stack rules as the player's bag). */
  createAllyBag(cols: number, rows: number): AllyBagRef { return Allies.createAllyBag(cols, rows); }

  /** **The same weight formula** as a person — `carried` = bag + equipped gear, `bag` = the equipped bag (its capacity bonus). No `운반` hauling skill. */
  weightInfoFor(carried: readonly ItemInstance[], bag: ItemInstance | null): WeightInfo { return Allies.weightInfoFor(this, carried, bag); }

  /**
   * Authority: a body that is not a person (`by` = an android id) takes one `defId` stack out of a container.
   * `containerId` is the inventory container id (= the id in `WorldRef.getLootContainers()`): `crate_<n>` for a map
   * crate, and for structure · platform · tram containers the spec id with the interaction id's `container:` stripped.
   */
  takeContainerItemFor(containerId: string, tier: number, defId: string, by: string): ItemInstance | null {
    return Allies.takeContainerItemFor(this, containerId, tier, defId, by);
  }

  /* ── Phase 7: canFit / raid state (InventoryRef) ───────────────────────── */

  /** Would `qty` units of `defId` fit now? Bag first, then (hub phase) the stash. Non-mutating. */
  canFit(defId: string, qty = 1): 'bag' | 'stash' | null { return StashOps.canFit(this, defId, qty); }

  /** Trial placement of `qty` units (merge into stacks, then new stacks chunked by `stackMax`), rolled back afterwards. */
  gridFits(grid: Grid, def: ItemDef, qty: number): boolean { return StashOps.gridFits(this, grid, def, qty); }

  /** Bag + 5 slots + quick slots with every instance field incl. `searched` (raid session blob / training freeze). */
  captureRaidState(): unknown { return Docs.captureRaidState(this); }

  /** Replace the bag / slots / quick slots with a `captureRaidState()` result and re-announce everything. */
  applyRaidState(state: unknown): boolean { return Docs.applyRaidState(this, state); }

  /* ── Phase 7: server profile documents ─────────────────────────────────── */

  /**
   * Mirror a local save to the server profile. Phase 9: always handed to `profile.set` — offline included (`ProfileSync`
   * stamps it with `serverNow()` and keeps the newest doc per key until the next connection); inside `withFreshSave`
   * the document is sent as a default (`{fresh:true}`, accepted only while the server has none for that key).
   */
  uploadProfileDoc(key: 'stash' | 'loadout', doc: unknown): void { return Docs.uploadProfileDoc(this, key, doc); }

  /** Run `fn` with every save it triggers uploaded as a `fresh` (default) document. */
  withFreshSave(fn: () => void): void { return Docs.withFreshSave(this, fn); }

  /** 2026-09-11 (E-6, `InventoryRef.flushSaves`): write the debounced stash / loadout saves now — both changed → one transaction. */
  flushSaves(): void { return Docs.flushSaves(this); }

  /** 2026-09-11 (E-5, `InventoryRef.soloRaidSeed`): the solo raid the saved kit is out on (local loadout marker), null = none. */
  get soloRaidSeed(): number | null { return this.loadoutStore?.raidSeed ?? null; }

  /** JSON equality of two save documents (`ProfileSync` hands our own pending document back inside the merged record). */

  /**
   * `net:profileLoaded`: the record is already merged newest-wins (Phase 9: `ProfileSync` weighed its pending offline
   * edits against the server's `docsAt` before emitting), so a server document simply replaces the local state — the
   * loadout only outside a raid (mid-mission the raid blob is the truth). A document that is **identical to the current
   * local state** is our own upload coming back through the merge: nothing is applied, nothing is re-saved (Phase 9 —
   * otherwise the starter kit would be re-announced and re-written with reason `profile` on every welcome). A key the
   * server has never seen gets the current local state (stamped, so it becomes the profile); an empty local loadout is
   * not worth uploading (the starter kit follows as a `fresh` document). Grids are rebuilt and announced.
   */
  private onProfileLoaded(profile: ProfileRecord): void { return Docs.onProfileLoaded(this, profile); }

  applyProfileDocs(profile: ProfileRecord): void { return Docs.applyProfileDocs(this, profile); }

  /* ── UI-facing operations ──────────────────────────────────────────────── */

  getGrid(id: GridId): Grid | null {
    if (id === 'bag') return this.bag;
    if (id === 'stash') return this.stash.grid;
    // A-15: the pouch grid exists even without a pouch (1×1, empty) — `getPouchSize()` is what says "do not draw it"
    if (id === 'pouch') return this.pouch;
    return this.activeContainer?.grid ?? null;
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }
  getStats(item: ItemInstance): EffectiveWeaponStats | null { return this.loot.getEffectiveStats(item); }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /**
   * Find an item anywhere (bag → container → stash → **wheel** → equipment slots).
   *
   * 2026-09-09: the wheel had to be added here, not just to `findItem` — `dropItem` (the `버리기` entry) and the repair /
   * stash helpers resolve a bare uid through this, so without it a stack on the wheel could not be thrown away.
   */
  locate(uid: string): { item: ItemInstance; from: ItemLocation } | null {
    const inGrid = this.locateInGrids(uid);
    if (inGrid) return { item: inGrid.item, from: { kind: 'grid', grid: inGrid.gridId } };
    const qi = quickSlotOf(this.quickSlots, uid);
    if (qi >= 0) {
      const it = this.quickSlots[qi];
      if (it) return { item: it, from: { kind: 'quick', index: qi } };
    }
    for (const slot of LOADOUT_SLOTS) {
      const it = this.loadout[slot];
      if (it?.uid === uid) return { item: it, from: { kind: 'slot', slot } };
    }
    return null;
  }

  private locateInGrids(uid: string): { item: ItemInstance; grid: Grid; gridId: GridId } | null {
    for (const gridId of ['bag', 'container', 'stash', 'pouch'] as const) {
      const grid = this.getGrid(gridId);
      const p = grid?.get(uid);
      if (grid && p) return { item: p.item, grid, gridId };
    }
    return null;
  }

  /** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else `주무기 I` (swap). Armor / bags → their slot. */
  equipTargetFor(def: ItemDef): LoadoutSlot | null { return Drop.equipTargetFor(this, def); }

  /** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
  partialQtyFor(item: ItemInstance, mode: 'half' | 'one'): number | null { return Drop.partialQtyFor(this, item, mode); }

  /** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
  previewPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview { return this.readOnlyReason() ? 'bad' : Drop.previewPartial(this, uid, from, qty, target); }

  /**
   * Execute a partial-stack drag: onto a free cell → new stack of `qty` there; onto a same-def stack → merge
   * (capped by `stackMax`); onto the source or anything else → nothing.
   */
  dropPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.dropPartial(this, uid, from, qty, target); }

  dropPartialImpl(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult { return Drop.dropPartialImpl(this, uid, from, qty, target); }

  validatePartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): { item: ItemInstance; def: ItemDef; grid: Grid; blockers: string[] } | null { return Drop.validatePartial(this, uid, from, qty, target); }

  /** Non-mutating classification used for the drag highlight. */
  previewDrop(uid: string, from: ItemLocation, target: DropTarget): DropPreview { return this.readOnlyReason() ? 'bad' : Drop.previewDrop(this, uid, from, target); }

  /**
   * Free footprint **closest to (x, y)** for `uid` (living at `from`) inside `gridId`, preferring `rotated`.
   * Null when the item does not fit anywhere.
   *
   * The drag UI uses this for an **equipment slot → grid** drag only: aiming a 4×2 weapon at a grid that has a
   * single small item under the cursor used to refuse the drop outright (red highlight, snap back to the slot and
   * shake), even with half the bag empty. The highlight now retargets to the spot the item really lands on.
   */
  nearestFreeSpot(uid: string, from: ItemLocation, gridId: GridId, x: number, y: number, rotated: boolean): { x: number; y: number; rotated: boolean } | null { return Drop.nearestFreeSpot(this, uid, from, gridId, x, y, rotated); }

  /** Execute a drag-and-drop. Container → player moves go through `guardedTake` (Phase 7). */
  drop(uid: string, from: ItemLocation, target: DropTarget): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.drop(this, uid, from, target); }

  dropImpl(uid: string, from: ItemLocation, target: DropTarget): OpResult { return Drop.dropImpl(this, uid, from, target); }

  /** Right-click quick action: container ↔ bag auto-place; slot → bag (the bag slot shrinks the grid first). */
  quickMove(uid: string, from: ItemLocation): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.quickMove(this, uid, from); }

  quickMoveImpl(uid: string, from: ItemLocation): OpResult { return Drop.quickMoveImpl(this, uid, from); }

  /**
   * Double-click. **2026-09-14, 2nd pass (user's decision) — regardless of the grid, 「빈 자리가 있으면 곧장 그리로」**:
   * a free equipment slot → a free implant slot → a free quick slot (`Drop.tryAutoPlace`); with none, the old path
   * (bag → `inventory:full`). It fills **empty** slots only, so nothing equipped is silently displaced (what the
   * 2026-09-10 decision protected). Swapping is for a drag and the menu's `장착` (`equip`) — README `Equipment slots`.
   */
  activate(uid: string, from: ItemLocation): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.activate(this, uid, from); }

  activateImpl(uid: string, from: ItemLocation): OpResult { return Drop.activateImpl(this, uid, from); }

  /**
   * Would a double-click right now land in a **free equipment · implant · wheel slot** (it changes nothing). Used only
   * so the right-click menu can decide whether to put the `더블클릭` hint on its 「빠른 이동」 row (2026-09-14, 2nd pass).
   */
  wouldAutoPlace(item: ItemInstance, def: ItemDef, quick = true): boolean { return Drop.wouldAutoPlace(this, item, def, quick); }

  rotateItem(uid: string, gridId: GridId): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.rotateItem(this, uid, gridId); }

  /**
   * "모두 가져가기": move every **searched** container item into the bag that fits (largest first). Returns the moved
   * count — on a multiplayer client the number of takes requested (each lands on its `cont taken`).
   */
  takeAll(): number { return this.readOnlyBlocked() ? 0 : Drop.takeAll(this); }

  /** One container item into the bag (auto-place, `inventory:itemAdded`). */
  takeOne(uid: string): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.takeOne(this, uid); }

  /* ── sockets (UI drag path) ────────────────────────────────────────────── */

  /** Can attachment `uid` (at `from`) be socketed into weapon `weaponUid` (at `loc`)? */
  previewAttach(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): DropPreview { return this.readOnlyReason() ? 'bad' : Drop.previewAttach(this, uid, from, weaponUid, loc); }

  /**
   * Socket attachment `uid` into weapon `weaponUid`. The previous attachment in that socket returns to the bag
   * (or drops to the ground when nothing fits). Emits `inventory:socketChanged`, `inventory:itemUpdated`.
   */
  attachFrom(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.attachFrom(this, uid, from, weaponUid, loc); }

  attachFromImpl(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult { return Drop.attachFromImpl(this, uid, from, weaponUid, loc); }

  /** After a socket change: a smaller magazine spills its excess rounds into the bag; weapons re-read the instance. */
  afterSocketChange(weapon: ItemInstance): void { return Drop.afterSocketChange(this, weapon); }

  /* ── internals ─────────────────────────────────────────────────────────── */

  /**
   * Phase 10 (the in-game cursor): the window keeps the **pointer lock** and drives the software cursor instead of handing
   * the OS cursor back — `setCursorMode` is ref-counted by blocker token, so a modeless popup layered on top (which
   * takes no token of its own) cannot steal it. No `exitPointerLock()`, and therefore no relock either.
   */
  setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    if (open) {
      this.ctx.uiBlockers.add(BLOCKER_TOKEN);
      // 2026-09-09: Escape closes this window too (`shared/escape` — the topmost one, in reverse open order). While a
      // popup is up `escHandler` swallows Escape first, so it never reaches here.
      // 2026-09-13: an intercepted leave (`EmbeddedView.requestLeave` raised its warning) keeps the entry (`false`)
      this.ctx.escape.push(BLOCKER_TOKEN, () => (this.ui?.screenView?.requestLeave?.(() => this.closeAll()) ? false : this.closeAll()));
      this.ctx.input.setCursorMode(true, BLOCKER_TOKEN);
    } else {
      this.ctx.uiBlockers.delete(BLOCKER_TOKEN);
      this.ctx.escape.remove(BLOCKER_TOKEN);
      this.ctx.input.setCursorMode(false, BLOCKER_TOKEN);
    }
  }

  area(it: ItemInstance): number {
    const d = ITEM_DEF_MAP.get(it.defId);
    return d ? d.width * d.height : 0;
  }

  /**
   * 'player' = bag / pouch / loadout (HUD counts, sockets); the crate and the stash are 'container'.
   * 2026-09-11 (A-15): the pouch is carried, so moving something in and out of it is not a transfer.
   */
  locKind(loc: ItemLocation): 'player' | 'container' {
    return loc.kind === 'grid' && loc.grid !== 'bag' && loc.grid !== 'pouch' ? 'container' : 'player';
  }

  bagSizeOf(item: ItemInstance | null): BagSize {
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
  addUnits(defId: string, qty: number): ItemInstance[] {
    const def = ITEM_DEF_MAP.get(defId);
    const overflow: ItemInstance[] = [];
    if (!def) return overflow;
    let left = Math.max(0, Math.floor(qty));
    const beforeSig = this.lastQuickSig;
    while (left > 0) {
      const chunk = Math.min(def.stackMax, left);
      left -= chunk;
      const item = this.loot.createItem(defId, chunk);
      // 2026-09-09: the wheel is a container too — fill its partial stacks before making a new bag stack
      if (mergeIntoQuick(this.quickSlots, item, (id) => ITEM_DEF_MAP.get(id)) <= 0) continue;
      if (this.bag.mergeIntoStacks(item) <= 0) continue;
      if (!this.bag.autoPlace(item)) overflow.push(item);
    }
    if (beforeSig === this.lastQuickSig) this.syncQuickSlots();   // wheel qty may have grown
    return overflow;
  }

  /** Rounds of `type` back into the bag (unload / mag downgrade); what does not fit lands on the ground. */
  returnRounds(type: EffectiveWeaponStats['ammoType'], rounds: number): void {
    for (const stack of this.addUnits(ammoItemIdFor(type), rounds)) this.throwToWorld(stack, false);
  }

  /** Emit the world drop for `item` (already detached). `owned` → also `inventory:itemRemoved` (HUD counts). */
  throwToWorld(item: ItemInstance, owned: boolean): void {
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
  changeBag(next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world', hint?: { x: number; y: number }): OpResult { return this.readOnlyBlocked() ? 'fail' : Drop.changeBag(this, next, from, oldTo, hint); }

  /** Remove an item from wherever it currently lives (no events). Anything leaving a container counts as searched. */
  detach(item: ItemInstance, from: ItemLocation): void {
    if (from.kind === 'slot') {
      if (this.loadout[from.slot]?.uid === item.uid) this.loadout[from.slot] = null;
    } else if (from.kind === 'quick') {
      if (this.quickSlots[from.index]?.uid === item.uid) this.quickSlots[from.index] = null;
    } else {
      this.getGrid(from.grid)?.remove(item.uid);
      if (from.grid === 'container') item.searched = true;
    }
  }

  emitTransfer(item: ItemInstance, def: ItemDef, from: ItemLocation, to: ItemLocation): void {
    const a = this.locKind(from), b = this.locKind(to);
    if (a === b) return;
    // 2026-09-12: ship stash → bag is a move, not a pickup — with `fromStash` set the ui raises no acquisition ticker
    const fromStash = from.kind === 'grid' && from.grid === 'stash';
    if (b === 'player') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity, ...(fromStash ? { fromStash: true } : {}) });
    else this.ctx.bus.emit('inventory:itemRemoved', { item });
  }

  afterMove(item: ItemInstance, from: ItemLocation, to: ItemLocation, qtyOverride?: number): void {
    const def = ITEM_DEF_MAP.get(item.defId);
    if (def) this.emitTransfer(qtyOverride !== undefined ? { ...item, qty: qtyOverride } : item, def, from, to);
    if (from.kind === 'slot' || to.kind === 'slot') this.emitLoadout();
    this.afterChange();
  }

  emitLoadout(): void {
    const l = this.loadout;
    this.ctx.bus.emit('loadout:changed', { primary: l.primary, secondary: l.secondary, primary2: l.primary2, bag: l.bag, armor: l.armor ?? null });
    for (const slot of LOADOUT_SLOTS) {
      const uid = l[slot]?.uid ?? null;
      if (this.lastEquipUids[slot] === uid) continue;
      this.lastEquipUids[slot] = uid;
      this.ctx.bus.emit('equip:changed', { slot, item: l[slot] ?? null });
    }
  }

  afterChange(): void {
    const grenades = this.countWhere((d) => d.grenade !== undefined);
    const stims = this.countWhere((d) => d.category === 'stim');
    if (grenades !== this.lastGrenades) { this.lastGrenades = grenades; this.ctx.bus.emit('grenade:countChanged', { count: grenades }); }
    if (stims !== this.lastStims) { this.lastStims = stims; this.ctx.bus.emit('stim:countChanged', { count: stims }); }
    this.syncQuickSlots();
    Pouch.emitPouchChanged(this);   // A-15: signature-gated, exactly like the wheel's
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

  checkLootedFor(c: Container): void {
    if (!c.lootedEmitted && c.grid.isEmpty) {
      c.lootedEmitted = true;
      this.ctx.bus.emit('crate:looted', { crateId: c.id });
    }
  }

  /** Can `current` (being displaced from a weapon slot) be placed where the dragged item came from, or anywhere sensible? */
  canPlaceDisplaced(current: ItemInstance, from: ItemLocation, draggedUid: string): boolean { return Drop.canPlaceDisplaced(this, current, from, draggedUid); }

  dropOnSlot(item: ItemInstance, def: ItemDef, from: ItemLocation, slot: SlotId): OpResult { return Drop.dropOnSlot(this, item, def, from, slot); }

  canSwap(item: ItemInstance, fromGrid: GridId, other: ItemInstance, targetGrid: Grid): boolean { return Drop.canSwap(this, item, fromGrid, other, targetGrid); }

  performSwap(item: ItemInstance, srcGrid: Grid, other: ItemInstance, dstGrid: Grid, x: number, y: number, rotated: boolean): boolean { return Drop.performSwap(this, item, srcGrid, other, dstGrid, x, y, rotated); }
  /* ── Phase 10: viewing a squadmate's loadout (ready panel → right-click) ── */

  /**
   * My bag + equip slots + quick slots for `CrewMessage.loadout` — the `captureLoadoutSave()` document without the
   * per-container `searched` flags (a crew card is a public snapshot; `captureRaidState` is the one that keeps them).
   */
  captureCrewLoadout(): unknown {
    // 2026-09-12 (E1): a crew card is about the kit — my favourites stay mine
    const { fav: _fav, ...save } = this.captureLoadoutSave();
    return { ...save, bag: save.bag.map((sv) => { const { searched: _s, ...rest } = sv as SavedPlacement & { searched?: boolean }; return rest; }) };
  }

  /**
   * Read-only `장비` / `가방` / `빠른 사용` view of another member's `captureCrewLoadout()` document (`ui/CrewLoadoutView.ts`):
   * a throwaway grid, no drag / rotate / socket / drop, no ship stash column and no credits pill. Null when the document
   * is not a loadout. The popup frame belongs to the caller (`hub/`).
   */
  createCrewLoadoutView(host: HTMLElement, loadout: unknown, opts: CrewLoadoutViewOptions = {}): EmbeddedView | null {
    return CrewLoadoutView.create(this, host, loadout, opts);
  }

}

/** Attachments socketed in `weapon` (socket order) — re-exported for the UI. */
export { attachedItems };
