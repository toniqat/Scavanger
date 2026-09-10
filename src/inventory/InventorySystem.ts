import * as THREE from 'three';
import type {
  ContainerMessage, ContainerRequest, CraftIngredient, CraftRecipe, CraftStation, DurabilityInfo, EffectiveWeaponStats, GameContext, GameSystem, InventoryRef,
  ItemCategory, ItemDef, ItemInstance, LaunchWarning, Loadout, LoadoutSlot, PeerId as NetPeerId, ProfileRecord, SocketSlot, WeaponSlot, WeightInfo, LoadoutPreset, WorkbenchKind,
  EmbeddedView, TradeGridsViewOptions,
} from '@/shared';
import { BAG_DEFAULT_COLS, BAG_DEFAULT_QUICK_SLOTS, BAG_DEFAULT_ROWS, Keys, QUICK_SLOTS, SEARCH_MAX_DISTANCE, SOCKET_SLOTS, isQuickSlotActive } from '@/shared';
import { AMMO_LABEL_KO, ITEM_DEF_MAP, LootService, STARTER_LOADOUT, STARTER_STASH, ammoItemIdFor, getRecipe, isWeaponItemDef, itemWeight } from '@/items';
import { durabilityInfo, gearMultipliers, makeWeightInfo, searchTimeFor, sumWeight } from './Gear';
import { Grid, OOB, type Placement, type PriorityPlacement } from './Grid';
import { Container, ContainerStore } from './Container';
import { attachedItems, clearSocket, findSocketed, setSocket } from './Sockets';
import {
  createQuickSlots, firstFreeQuickSlot, isQuickIndex, isQuickUsable, mergeIntoQuick, quickSlotOf, quickSlotsSignature,
  type QuickSlotItems,
} from './QuickSlots';
/* appended (2026-09-10): 휠 교체에서 밀려난 스택이 갈 자리 — 미리보기와 실행이 같은 규칙을 본다 */
import { applyQuickSwap, type QuickSwapCell, type QuickSwapPlan } from './QuickSwap';
import { InventoryUI, type ScreenTab } from './ui/InventoryUI';
export type { ScreenTab } from './ui/InventoryUI';
import { TradeGrids, type TradeGridsOptions } from './ui/TradeGrids';
import { Stash, setStarterGrantState, starterGrantState } from './Stash';
import { LOADOUT_SAVE_VERSION, LoadoutStore, isEmptyLoadoutSave, loadLoadoutSave, sanitizeLoadoutSave, type LoadoutSave } from './Loadout';
import { reviveItem, savedCell, serializeExtras, serializePlacement, type SavedPlacement } from './Serialize';
/* appended (Phase 10): 분대원 장비 열람 */
import type { CrewLoadoutViewOptions } from '@/shared';
import { HUB_READY_BLOCKER, MENU_BLOCKER } from '@/shared';
import { CrewLoadoutView } from './ui/CrewLoadoutView';

import {
  AUTO_CLOSE_DISTANCE, BLOCKER_TOKEN, CRAFT_MIN_SPEED, DROP_EYE_LOWER, DROP_FORWARD_OFFSET, DROP_FORWARD_SPEED, DROP_UP_SPEED,
  LOADOUT_SLOTS, MOD_CTRL, MOD_SHIFT, SEARCH_EMIT_INTERVAL, SEARCH_START_DELAY, SPRAY_REFILL_COST, TAKE_REQUEST_TIMEOUT, WEAPON_SLOT_IDS,
  isArmorDef, isAttachmentDef, isBagDef, isDisassembleRecipe, isWeaponDef, sameProfileDoc, slotAccepts,
  type ActiveBench, type BagSize, type BenchRecipeRow, type BenchRepairRow, type CraftJob, type DropPreview, type DropTarget,
  type GridId, type ItemLocation, type MissionOutcome, type OpResult, type PendingTake, type RaidInventoryState, type RepairInfo, type SlotId, type UiSfx,
} from './model';
/** 폴더 공용 어휘는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 그대로 재수출한다. */
export * from './model';

/* 분할된 구현 모듈 — 같은 이름의 위임 메서드가 이 안의 함수를 부른다. 폴더 README 의 `파일 구성` 참고. */
import * as Life from './parts/Lifecycle';
import * as CNet from './parts/ContainerNet';
import * as Docs from './parts/ProfileDocs';
import * as Craft from './parts/Crafting';
import * as Cat from './parts/Catalog';
import * as StashOps from './parts/StashOps';
import * as Drop from './parts/DropResolver';
import * as Dur from './parts/Durability';
import * as Launch from './parts/LaunchCheck';
/* appended (2026-09-09): 사망 → 시체 컨테이너 */
import * as Corpse from './parts/CorpseLoot';
export class InventorySystem implements GameSystem, InventoryRef {
  readonly name = 'inventory';

  ctx!: GameContext;
  loot = new LootService();
  bag!: Grid;
  loadout: Loadout = { primary: null, primary2: null, secondary: null, bag: null, armor: null };
  /** Tactical kit: last emitted weight / loadout (gates `inventory:weightChanged` / `equip:changed`), running craft. */
  lastWeight: WeightInfo | null = null;
  lastEquipUids: Partial<Record<LoadoutSlot, string | null>> = {};
  craftJob: CraftJob | null = null;
  containers = new ContainerStore((id) => ITEM_DEF_MAP.get(id));
  /** 함선 창고 (persisted). Shown only while the window is open in the hub (`hubMode`). */
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
   * Quick-use wheel — **its own container** (2026-09-09, 사용자 결정): the stack in each wheel direction lives *here*,
   * not in the bag grid (see `QuickSlots.ts`). It still counts toward the bag weight, the HUD counts and every
   * `countWhere` / `consumeWhere` query. `lastQuickSig` gates the change event.
   */
  quickSlots: QuickSlotItems = createQuickSlots();
  lastQuickSig = '';
  lastStashVersion = 0;
  /* Phase 6: 무한 상자 window state + the bench the craft panel is showing. */
  catalogOpen = false;
  bench: ActiveBench | null = null;
  /* Phase 7: container search + host authority + net subscriptions. */
  /** `parts/` 가 닿는다 (`CorpseLoot.openContainerItemsSized`) — 폴더 밖 계약은 아니다. */
  openedIds = new Set<string>();
  /**
   * 2026-09-09: 이번 사망에서 `stripForCorpse()` 로 전부 시체에 넘겼다 → **구조선 부활은 빈손**이다.
   * `player:respawn` 의 스타터 지급 분기를 한 번만 건너뛰고 스스로 꺼진다.
   */
  strippedForCorpse = false;
  pendingTakes: PendingTake[] = [];
  private lastSearchEmit = -1;
  /** Seconds left of the `SEARCH_START_DELAY` grace after the container window opened (0 = 감정 ticking). */
  private searchDelay = 0;
  /**
   * Phase 9: no inventory-side offline queue any more — every save goes to `profile.set` (`ProfileSync` stamps it and
   * keeps the newest doc per key while offline). `freshSave` marks the saves made inside `withFreshSave` as defaults
   * (`{fresh:true}`: the server keeps them only while it has no document for that key) — the fresh-browser starter
   * kit and the startup stash resize must never beat a real server profile.
   */
  freshSave = false;
  /** 2026-09-07: `STARTER_STASH` was granted this session (a brand-new profile) → equip the minimum kit once. */
  firstRunGrant = false;
  ui: InventoryUI | null = null;
  private offs: Array<() => void> = [];
  /**
   * 2026-09-08: **Escape no longer closes the window** — it is the 일시정지 메뉴 everywhere, and this window (bag,
   * container, 캐릭터 / 기업 / 함선 tabs alike) closes on the key that opened it, `Keys.INVENTORY`. What Escape still
   * does is cancel the innermost popup: a context menu, a split dialog, a confirm card. Those swallow the key, so
   * a mistyped Escape never throws away a drag or a typed amount; with nothing open it falls through to `game/`.
   */
  private escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this._open) return;
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
      // 2026-09-08: the 캐릭터 tab's 능력치 포인트 red dot follows the level-ups / spends that happen behind it
      bus.on('progress:levelUp', () => { if (this._open) this.ui?.markTab(); }),
      bus.on('progress:statChanged', () => { if (this._open) this.ui?.markTab(); }),
      bus.on('progress:loaded', () => { if (this._open) this.ui?.markTab(); }),
      // 2026-09-08: 임플란트 칸이 인벤토리로 옮겨왔으므로 밖에서 바뀐 장착(프리셋 적용 · 수리)도 여기서 다시 그린다
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
      // 2026-09-09: 플레이어 시체는 컨테이너 하나다 (`pcorpse:<owner>:<n>`). 와이어가 도착하는 즉시 컨테이너를
      // 만들어 두어야 호스트가 한 번도 열어 본 적 없는 시체의 `contq take` 도 심판할 수 있다.
      const corpseOff = Corpse.hookCorpseWire(this, ctx);
      if (corpseOff) this.offs.push(corpseOff);
    }
    // Capture-phase so Escape closes the inventory without also reaching the menu system.
    window.addEventListener('keydown', this.escHandler, true);
  }

  update(dt: number, ctx: GameContext): void {
    // Tab: bag window on a mission, the 3-column ship screen (창고 / 장비 / 가방) in the hub.
    // Phase 10: the launch-pod READY panel holds its own blocker, and Tab must still work while boarded (as before).
    const onlyReadyBlocked = ctx.uiBlockers.size === 0
      || (ctx.uiBlockers.size === 1 && ctx.uiBlockers.has(HUB_READY_BLOCKER));
    // 2026-09-08: Tab is now also the *close* key, so it must not reach through the 일시정지 메뉴 stacked on top.
    if (ctx.input.wasPressed(Keys.INVENTORY) && !ctx.uiBlockers.has(MENU_BLOCKER)
      && (ctx.isGameplayPhase() || ctx.isHubPhase()) && (this._open || onlyReadyBlocked)) {
      // 2026-09-09 (Tab 은 모든 화면을 닫는다): like Escape, Tab cancels the **innermost popup** first — 수량 지정 ·
      // 우클릭 메뉴 · 분해 · 수리 · 임플란트 피커 — and closes the window only when nothing is stacked over it. The
      // 제작 열 is a column of the window, not a popup, so it goes with the window.
      if (!(this._open && this.ui?.closePopups())) this.toggleBag();
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
    // 2026-09-10: 연 순간의 복사본이 아니라 **지금 자리**와 잰다 — 달리는 전차 안의 컨테이너가 곧바로 닫혔다.
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
  private onWorldReady(seed: number): void { return Life.onWorldReady(this, seed); }

  /* ── Phase 5: loadout persistence (`Loadout.ts`, localStorage `scav.loadout`) ── */

  /** Snapshot for the save file: slots + bag placements + quick slots as bag indices. */
  captureLoadoutSave(): LoadoutSave { return Life.captureLoadoutSave(this); }

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

  private hasAnyWeapon(): boolean { return Life.hasAnyWeapon(this); }

  isCompletelyEmpty(): boolean { return Life.isCompletelyEmpty(this); }

  /** Nothing to raid with anywhere: no loadout, empty bag **and** an empty 함선 창고 (2026-09-07 safety net). */
  isDestitute(): boolean { return Life.isDestitute(this); }

  /**
   * A failed / abandoned raid: everything the player carried is gone and they re-equip from the 함선 창고
   * (2026-09-07). Only a player whose stash is empty too falls back to the minimum kit.
   */
  loseKit(): void { return Life.loseKit(this); }

  /**
   * 기본 지급품, once per profile (2026-09-07 fix). The old condition was `Stash.firstRun` — no `scav.stash` file —
   * which silently skipped every profile that existed before the grant did, and every profile whose 창고 was emptied
   * by an incoming (empty) server document. The state now lives in its own localStorage key:
   *   `none` → grant here (as a `fresh` document on a true first run, so a real server profile still wins) and mark
   *            `pending`; `pending` → re-checked once at `net:profileLoaded`, where the server's 창고 is known, and
   *            settled to `done` either way. A player who already owns something is settled without a grant.
   */
  tryStarterGrant(): void { return Life.tryStarterGrant(this); }

  /**
   * `STARTER_STASH` into the 함선 창고 (2026-09-07); the "once per profile" decision is `tryStarterGrant`. `stacks`
   * splits an entry into that many full stacks — one 세트 per grid cell.
   */
  grantStarterStash(): void { return Life.grantStarterStash(this); }

  /** Wipe the bag + slots and apply `STARTER_LOADOUT` (`items[].qty` are units / rounds). */
  applyStarter(): void { return Life.applyStarter(this); }

  /* ── InventoryRef ──────────────────────────────────────────────────────── */

  get isOpen(): boolean { return this._open; }

  getLoadout(): Loadout { return { ...this.loadout }; }

  getDef(defId: string): ItemDef | undefined { return ITEM_DEF_MAP.get(defId); }

  /** Bag **grid** stacks only (the corp trade / implant desk / workbench list what is sellable / repairable there); the wheel is `getQuickSlots()`. */
  getAllItems(): ItemInstance[] { return this.bag.items().map((p) => p.item); }

  /** Bag grid + wheel stacks (the wheel is carried too). */
  getTotalValue(): number { return this.bag.totalValue() + this.quickTotalValue(); }

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

  /** Bag + wheel + equipped gear weight against the character's carry capacity (근력 via `ctx.progression`). */
  getWeight(): WeightInfo {
    const mult = gearMultipliers(this.ctx.progression?.derived);
    // 2026-09-09: the wheel is a separate container but it hangs off the same shoulders — its stacks weigh in too
    let w = sumWeight([...this.bag.items().map((p) => p.item), ...this.quickItems()], (id) => ITEM_DEF_MAP.get(id));
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
  getDurability(uid: string): DurabilityInfo | null { return Dur.getDurability(this, uid); }

  /** Wear on non-weapon gear (armor per absorbed hit). Weapons keep `updateItem` (weapons/ owns that path). */
  damageDurability(uid: string, amount: number): void { return Dur.damageDurability(this, uid, amount); }

  /**
   * Phase 12: refill cost of a 회복 스프레이 (`ItemDef.heal.spray`, gauge = `durability` / `durabilityMax`) — one 캔 +
   * one 소독약 per **full** refill, scaled by the missing fraction (ceil, never below 1 each). null for anything else
   * or a full can. The materials come from the bag, exactly like a weapon repair.
   */
  sprayRepairCost(item: ItemInstance, def: ItemDef): CraftIngredient[] | null { return Dur.sprayRepairCost(this, item, def); }

  /**
   * 완전 수리에 드는 재료 — `getRepairCost` (무기 · 방탄복) 를 먼저 보고, 비었을 때만 회복 스프레이의
   * 게이지 충전(`sprayRepairCost`). 2026-09-10 부터 방탄복 수리도 재료를 쓴다.
   */
  repairMaterials(item: ItemInstance, def: ItemDef): CraftIngredient[] { return Dur.repairMaterials(this, item, def); }

  /**
   * Ship workbench: weapons go through `repairWeapon` (materials), everything else pays `repairMaterials`
   * (방탄복 = 제작 재료 × 내구도 구간 배수, 회복 스프레이 = 캔 + 소독약, 그 밖에는 무료).
   */
  repair(uid: string): boolean { return Dur.repair(this, uid); }

  /**
   * Context-menu repair readout (hub only): materials still needed (`[]` = free), `short` = which of them the bag
   * lacks, `bucket` = 남은 내구도 구간. null when the item is not worn / not repairable.
   */
  repairInfo(uid: string): RepairInfo | null { return Dur.repairInfo(this, uid); }

  /** 'ship' while walking the hub / menus, 'field' on a mission. */
  currentStation(): CraftStation { return Craft.currentStation(this); }

  /* ── Phase 6 (2026-09-06): 무한 상자 catalog ──────────────────────────── */

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
  previewCatalog(item: ItemInstance, target: DropTarget): DropPreview { return Cat.previewCatalog(this, item, target); }

  /**
   * Release a catalog drag: the fresh instance lands in the grid cell (or merges into the stack there) / the slot
   * (displaced gear → bag, else stash in the ship). The catalog tile is untouched. 'fail' → the UI shakes the tile.
   */
  dropFromCatalog(item: ItemInstance, target: DropTarget): OpResult { return Cat.dropFromCatalog(this, item, target); }

  /** Catalog double-click: a fresh instance straight into the bag (merge into stacks first). */
  takeFromCatalog(defId: string): OpResult { return Cat.takeFromCatalog(this, defId); }

  /** Where displaced gear can go: the bag, else the ship stash (hub only). */
  canStow(item: ItemInstance): boolean { return Cat.canStow(this, item); }

  /** Put a detached item into the bag, else the stash (ship). Returns where it went, null when nothing fits. */
  stow(item: ItemInstance): GridId | null { return Cat.stow(this, item); }

  /* ── Phase 6: stash size (housing 창고 facility) ─────────────────────── */

  getStashSize(): { cols: number; rows: number } { return StashOps.getStashSize(this); }

  /** Grow / shrink the stash grid (shrink refused while an item would fall outside). Persists; emits `inventory:stashChanged`. */
  setStashSize(cols: number, rows: number): boolean { return StashOps.setStashSize(this, cols, rows); }

  /* ── Phase 6: materials across bag + stash (facility upgrades / furniture) ── */

  countDefAll(defId: string): number { return StashOps.countDefAll(this, defId); }

  stashCountDef(defId: string): number { return StashOps.stashCountDef(this, defId); }

  /** Bag first, then the stash; all-or-nothing. */
  consumeDefAll(defId: string, qty: number): boolean { return StashOps.consumeDefAll(this, defId, qty); }

  /* ── Phase 6: loadout presets (사격장) ───────────────────────────────── */

  captureLoadout(): LoadoutPreset { return StashOps.captureLoadout(this); }

  /** 출격 준비 점검 (2026-09-08): 발사 슬롯 탑승 전 경고 목록. 읽기 전용 — 자세한 규칙은 `parts/LaunchCheck`. */
  getLaunchWarnings(): LaunchWarning[] { return Launch.getLaunchWarnings(this); }

  /**
   * Equip a preset from the bag (first) and the stash: a slot whose def is found gets the first matching instance
   * (displaced gear → bag, else stash), a def that is nowhere empties the slot and lands in `missing`; `null`
   * entries leave the slot as it is. The implant goes through `ctx.implants.setEquipped` (the Tab screen's path).
   * Ship only — on a mission nothing changes and the result is empty.
   */
  applyLoadout(preset: LoadoutPreset): { equipped: number; missing: string[] } { return StashOps.applyLoadout(this, preset); }

  /** First instance of `defId` in the bag, then the stash. */
  findStoredByDef(defId: string): { item: ItemInstance; grid: GridId } | null { return StashOps.findStoredByDef(this, defId); }

  /** Unequip `slot` into the bag, else the stash (ship). The bag slot shrinks the grid first. */
  unequipToStorage(slot: LoadoutSlot): boolean { return StashOps.unequipToStorage(this, slot); }

  /** Move a bag / stash item into `slot`; the displaced item goes to the bag, else the stash, else the vacated cells. */
  equipFromStorage(item: ItemInstance, gridId: GridId, slot: LoadoutSlot): boolean { return StashOps.equipFromStorage(this, item, gridId, slot); }

  /* ── Phase 6: 작업실 bench crafting ─────────────────────────────────── */

  /**
   * Open the craft panel in bench mode (ship only): recipes of `getRecipes('ship', bench, level)` + locked rows for
   * the bench's higher-level recipes, workshop cost discount, and the repair list of the gear that bench services.
   */
  openBenchCraft(bench: WorkbenchKind, level: number): void { return Craft.openBenchCraft(this, bench, level); }

  /** Bench the craft panel is showing (null = plain 제작 panel). */
  getBench(): ActiveBench | null { return Craft.getBench(this); }

  /** Leave bench mode (panel 닫기 / window closed). The window itself stays open. */
  closeBench(): void { return Craft.closeBench(this); }

  /** Rows for the craft panel: available recipes, then (bench mode) the bench's recipes above its level as locked. */
  getBenchRecipes(): BenchRecipeRow[] { return Craft.getBenchRecipes(this); }

  /**
   * Gear the active bench repairs: gun → weapons (slots + bag), gear → armor + bags, others none. Items without
   * durability are skipped. `wornOnly` (2026-09-08, the 수리 팝업 default) drops the rows already at full durability.
   */
  benchRepairRows(wornOnly = false): BenchRepairRow[] { return Craft.benchRepairRows(this, wornOnly); }

  /** `모두 수리`: every worn row in order while the materials last. `skip` = uids the 팝업 excluded with ×. */
  benchRepairAll(skip?: ReadonlySet<string>): { done: number; skipped: number } { return Craft.benchRepairAll(this, skip); }

  /**
   * Recipes for a station given the current skills. Field: `station: 'field'` recipes only. Ship: field recipes
   * too; a recipe with `bench` needs that bench — at `bench` (given) with `benchLevel ≤ level`, otherwise a placed
   * bench of that kind at that level (`ctx.housing.getBenchLevel`, 0 without housing).
   */
  getRecipes(station: CraftStation, bench?: WorkbenchKind, level = 0): readonly CraftRecipe[] { return Craft.getRecipes(this, station, bench, level); }

  /**
   * Phase 8 — 분해 recipe of an item the player owns, or null. A `break_*` recipe whose **only** input is that
   * item's def id counts; the UI turns it into the `분해` context-menu entry and the modeless dialog. Crafting
   * itself is unchanged (`craft()` still accepts these recipes) — they are only hidden from the craft *list*.
   */
  disassembleRecipeFor(uid: string): CraftRecipe | null { return Craft.disassembleRecipeFor(this, uid); }

  /**
   * Open the modeless 분해 dialog over the open window (the item context menu's `분해` entry; also a handle for
   * the console / smoke tests). False when the window is closed or the item has no `break_*` recipe.
   */
  openDisassemble(uid: string): boolean { return Craft.openDisassemble(this, uid); }

  /** Recipes the running station / bench may craft right now. */
  availableRecipes(): readonly CraftRecipe[] { return Craft.availableRecipes(this); }

  /** Workshop material discount (`ctx.housing.getCraftCostMul`, ship only); 1 when nothing applies. */
  craftCostMul(): number { return Craft.craftCostMul(this); }

  /** Inputs of a recipe after the workshop discount (ceil, never below 1). */
  craftCost(recipe: CraftRecipe): CraftIngredient[] { return Craft.craftCost(this, recipe); }

  /** `count` (2026-09-09, 제작 수량, default 1): every ingredient × count must be owned. */
  canCraft(recipeId: string, count = 1): boolean { return Craft.canCraft(this, recipeId, count); }

  /** 2026-09-09: the most runs the owned materials pay for (≥ 1 — 1 even when nothing is affordable); the count control's `▶` limit. */
  maxCraftCount(recipeId: string): number { return Craft.maxCraftCount(this, recipeId); }

  /** Seconds the 제작 / 분해 button is held — the same `CRAFT_HOLD_TIME` for every recipe (2026-09-08). */
  craftDuration(recipeId: string): number { return Craft.craftDuration(this, recipeId); }

  /**
   * 2026-09-08: can the bag take this recipe's output (+ `extraOutputs`) right now? The same check `updateCraft`
   * makes when the hold ends — the 분해 dialog runs it **first** so an impossible shred never costs the hold.
   */
  craftHasRoom(recipeId: string, count = 1, targetUid?: string): boolean { return Craft.craftHasRoom(this, recipeId, count, targetUid); }

  /** `targetUid` (2026-09-08): the exact stack a 분해 shreds — consumed before any other stack of the same def. */
  /** `count` (2026-09-09): 제작 수량 — the recipe runs `count` times in one hold (inputs × count, output × count). */
  craft(recipeId: string, targetUid?: string, count = 1): Promise<ItemInstance | null> { return Craft.craft(this, recipeId, targetUid, count); }

  /** Abort the running craft (releasing the hold button, closing the panel, dying). */
  cancelCraft(): boolean { return Craft.cancelCraft(this); }

  /** 0..1 progress of the running craft (null when idle). */
  craftProgress(): { recipeId: string; progress: number } | null { return Craft.craftProgress(this); }

  private updateCraft(dt: number): void { return Craft.updateCraft(this, dt); }

  /** Units in the bag grid **and on the wheel** matching `pred` (2026-09-09: a stim on the wheel is still carried). */
  countWhere(pred: (def: ItemDef, inst: ItemInstance) => boolean): number {
    let n = 0;
    for (const p of this.bag.items()) {
      const def = ITEM_DEF_MAP.get(p.item.defId);
      if (def && pred(def, p.item)) n += p.item.qty;
    }
    for (const it of this.quickItems()) {
      const def = ITEM_DEF_MAP.get(it.defId);
      if (def && pred(def, it)) n += it.qty;
    }
    return n;
  }

  /**
   * Remove up to `qty` units matching `pred`: bag stacks first (smallest first, so partial stacks disappear before
   * full ones), then the wheel — what the player put on the wheel on purpose is the last thing a recipe eats.
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

    // 2026-09-10: the incoming stack may live in **any** grid — 가방 · 열어 둔 상자 · 함선 창고. It used to be
    // `this.bag.get(uid)` only, so 상자에서 곧장 휠에 올리는 길이 없었다. A container source is host-gated by the
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
     * 2026-09-10 — 밀려난 스택의 자리는 `QuickSwap` 이 정한다: **들어오는 스택이 비운 그 칸** → 가방 → 출발 격자.
     * 예전에는 가방만 봤고(`returnQuickToBag`), 그래서 **가방이 꽉 차면 1:1 교체 자체가 거절**됐다 — 자리를
     * 맞바꾸기만 하면 되는데도. 실패하면 여기서 아무것도 바뀌지 않는다 (`place`/`autoPlace` 는 전부-아니면-전무).
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
    // 상자/창고 → 휠 is a location change, so it announces itself like a container → bag take does
    if (found.gridId !== 'bag') this.emitTransfer(item, def, { kind: 'grid', grid: found.gridId }, { kind: 'quick', index });
    // …and the displaced stack leaving the player for that same 상자/창고 is the mirror of it
    if (occupant && swapped !== 'bag' && found.gridId !== 'bag') {
      const od = ITEM_DEF_MAP.get(occupant.defId);
      if (od) this.emitTransfer(occupant, od, { kind: 'quick', index }, { kind: 'grid', grid: found.gridId });
    }
    return true;
  }

  /**
   * 2026-09-10 — 휠 교체에서 **밀려난 스택**이 갈 자리 규칙 (`QuickSwap.ts`). `previewDrop` 은 `canQuickSwap` 으로,
   * `setQuickSlot` 은 `applyQuickSwap` 으로 **같은 계획**을 본다. 멀티플레이의 공유 상자에는 내 물건을 넣을 수
   * 없으므로(`refusesIntoContainer` 와 같은 이유) 그때만 출발 격자를 후보에서 뺀다.
   */
  quickSwapPlan(occupant: ItemInstance, source: Grid | null, sourceId: GridId | null, cell: QuickSwapCell | null, incomingUid: string): QuickSwapPlan {
    const allowSource = !(this.ctx.isMultiplayer && sourceId === 'container');
    return { occupant, bag: this.bag, source, cell, incomingUid, allowSource };
  }

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
   * 2026-09-10: the stack may sit in the open 상자 — that path is a take, so it goes through `guardedTake`
   * (host-confirmed in multiplayer) exactly like 상자 → 가방.
   */
  registerQuick(uid: string): OpResult {
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
    // 2026-09-09: top the **wheel** stacks up first — picking up 붕대 while the wheel holds a partial 붕대 stack
    // should refill the thing the player actually uses, not start a second stack in the grid.
    if (mergeIntoQuick(this.quickSlots, item, (id) => ITEM_DEF_MAP.get(id)) <= 0) {
      this.syncQuickSlots();
      this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
      this.afterChange();
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
    this.ctx.bus.emit('inventory:itemUpdated', { item });
    this.afterChange();
    return true;
  }

  /** Socket a bag (or open-container) attachment into a player-owned weapon; see `attachFrom`. */
  attachToWeapon(weaponUid: string, attachmentUid: string): boolean { return Dur.attachToWeapon(this, weaponUid, attachmentUid); }

  /** Every attachment of weapon `uid` back into the bag (overflow drops to the ground). False when none / not found. */
  detachAllSockets(uid: string): boolean { return Dur.detachAllSockets(this, uid); }

  /** Magazine → bag as ammo of the weapon's calibre (merge into stacks, new stacks, overflow drops). */
  unloadWeapon(uid: string): boolean { return Dur.unloadWeapon(this, uid); }

  /** Workbench repair: all materials from `LootRef.getRepairCost` or nothing. */
  repairWeapon(uid: string): boolean { return Dur.repairWeapon(this, uid); }

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
  moveToStash(uid: string, from: ItemLocation): OpResult { return StashOps.moveToStash(this, uid, from); }

  /**
   * Quick chat (middle-click / 요청 menu entry): `탄약 필요: <탄종>` for weapons, `<이름> 필요` for anything else
   * (`chat:post`, kind 'request'). 2026-09-09: the weapon's own name left the ammo line — the squad needs the calibre,
   * not the gun. Equipment-slot tiles reach this through the same `Drag.beginPress` middle-button path as grid tiles.
   */
  requestItem(uid: string, from: ItemLocation): boolean {
    if (this.isItemLocked(uid, from)) return false;
    const item = this.findItem(uid, from);
    const def = item && ITEM_DEF_MAP.get(item.defId);
    if (!item || !def) return false;
    const stats = this.loot.getEffectiveStats(item);
    const text = stats ? `탄약 필요: ${AMMO_LABEL_KO[stats.ammoType]}` : `${def.name} 필요`;
    this.ctx.bus.emit('chat:post', { text, kind: 'request' });
    return true;
  }

  openContainer(containerId: string, tier: number, position: THREE.Vector3): void {
    const first = !this.openedIds.has(containerId);
    this.openedIds.add(containerId);
    const c = this.containers.getOrCreate(containerId, tier, position, this.loot, this.missionSeed, this.ctx.missionPlanet);
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

  /**
   * 2026-09-09 — `openContainerItems` 와 같지만 격자 크기를 지정한다 (플레이어 유해는
   * `PLAYER_CORPSE_COLS × PLAYER_CORPSE_ROWS`). 이미 아는 id 면 `items` · 크기 모두 무시하고 남은 내용물을 보여 준다.
   */
  openContainerItemsSized(containerId: string, items: ItemInstance[], position: THREE.Vector3,
    cols: number, rows: number, title?: string): void {
    return Corpse.openContainerItemsSized(this, containerId, items, position, cols, rows, title);
  }

  /**
   * 2026-09-09 — 사망 시점의 전부(장비 · 가방 · 퀵슬롯)를 뽑고 로컬 인벤토리를 비운다. 시체 컨테이너를
   * 채우는 유일한 입구이고, `game/parts/Death` 의 사망 처리에서 정확히 한 번만 불린다.
   */
  stripForCorpse(): ItemInstance[] { return Corpse.stripForCorpse(this); }

  showContainer(c: Container): void {
    this.activeContainer = c;
    this.searchDelay = SEARCH_START_DELAY;   // 2026-09-08: 감정 waits out the window's open animation
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

  announceTake(c: Container, idx: number, qty: number): void { return CNet.announceTake(this, c, idx, qty); }

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
    return this.activeContainer?.grid ?? null;
  }
  getActiveContainer(): Container | null { return this.activeContainer; }
  getLoot(): LootService { return this.loot; }
  getStats(item: ItemInstance): EffectiveWeaponStats | null { return this.loot.getEffectiveStats(item); }

  sfx(id: UiSfx): void { this.ctx.bus.emit('audio:play', { id }); }

  /**
   * Find an item anywhere (bag → container → stash → **wheel** → equipment slots).
   *
   * 2026-09-09: the wheel had to be added here, not just to `findItem` — `dropItem` (버리기) and the repair /
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
    for (const gridId of ['bag', 'container', 'stash'] as const) {
      const grid = this.getGrid(gridId);
      const p = grid?.get(uid);
      if (grid && p) return { item: p.item, grid, gridId };
    }
    return null;
  }

  /** Slot a double-click / `장착` sends a weapon to: first empty primary slot, else 주무기 I (swap). Armor / bags → their slot. */
  equipTargetFor(def: ItemDef): LoadoutSlot | null { return Drop.equipTargetFor(this, def); }

  /** Split size a Shift (half) / Ctrl (one) drag would carry, or null when the item cannot be split. */
  partialQtyFor(item: ItemInstance, mode: 'half' | 'one'): number | null { return Drop.partialQtyFor(this, item, mode); }

  /** Non-mutating classification of a partial-stack drag (`qty` units of `uid`) onto `target`. */
  previewPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): DropPreview { return Drop.previewPartial(this, uid, from, qty, target); }

  /**
   * Execute a partial-stack drag: onto a free cell → new stack of `qty` there; onto a same-def stack → merge
   * (capped by `stackMax`); onto the source or anything else → nothing.
   */
  dropPartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult { return Drop.dropPartial(this, uid, from, qty, target); }

  dropPartialImpl(uid: string, from: ItemLocation, qty: number, target: DropTarget): OpResult { return Drop.dropPartialImpl(this, uid, from, qty, target); }

  validatePartial(uid: string, from: ItemLocation, qty: number, target: DropTarget): { item: ItemInstance; def: ItemDef; grid: Grid; blockers: string[] } | null { return Drop.validatePartial(this, uid, from, qty, target); }

  /** Non-mutating classification used for the drag highlight. */
  previewDrop(uid: string, from: ItemLocation, target: DropTarget): DropPreview { return Drop.previewDrop(this, uid, from, target); }

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
  drop(uid: string, from: ItemLocation, target: DropTarget): OpResult { return Drop.drop(this, uid, from, target); }

  dropImpl(uid: string, from: ItemLocation, target: DropTarget): OpResult { return Drop.dropImpl(this, uid, from, target); }

  /** Right-click quick action: container ↔ bag auto-place; slot → bag (the bag slot shrinks the grid first). */
  quickMove(uid: string, from: ItemLocation): OpResult { return Drop.quickMove(this, uid, from); }

  quickMoveImpl(uid: string, from: ItemLocation): OpResult { return Drop.quickMoveImpl(this, uid, from); }

  /**
   * Double-click. 가방 · 장비 칸: weapons / bags equip (`equipTargetFor`), anything else quick-moves.
   * 컨테이너(상자 · 시체 · 함선 창고)는 2026-09-10 부터 **언제나 가방이 먼저**이고, 가방이 꽉 찼을 때만
   * `빈 장비 칸 → 임플란트 칸 → 빈 퀵슬롯` 폴백이 돈다 (폴더 README 의 `Equipment slots` 절).
   */
  activate(uid: string, from: ItemLocation): OpResult { return Drop.activate(this, uid, from); }

  activateImpl(uid: string, from: ItemLocation): OpResult { return Drop.activateImpl(this, uid, from); }

  rotateItem(uid: string, gridId: GridId): OpResult { return Drop.rotateItem(this, uid, gridId); }

  /**
   * "모두 가져가기": move every **searched** container item into the bag that fits (largest first). Returns the moved
   * count — on a multiplayer client the number of takes requested (each lands on its `cont taken`).
   */
  takeAll(): number { return Drop.takeAll(this); }

  /** One container item into the bag (auto-place, `inventory:itemAdded`). */
  takeOne(uid: string): OpResult { return Drop.takeOne(this, uid); }

  /* ── sockets (UI drag path) ────────────────────────────────────────────── */

  /** Can attachment `uid` (at `from`) be socketed into weapon `weaponUid` (at `loc`)? */
  previewAttach(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): DropPreview { return Drop.previewAttach(this, uid, from, weaponUid, loc); }

  /**
   * Socket attachment `uid` into weapon `weaponUid`. The previous attachment in that socket returns to the bag
   * (or drops to the ground when nothing fits). Emits `inventory:socketChanged`, `inventory:itemUpdated`.
   */
  attachFrom(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult { return Drop.attachFrom(this, uid, from, weaponUid, loc); }

  attachFromImpl(uid: string, from: ItemLocation, weaponUid: string, loc: ItemLocation): OpResult { return Drop.attachFromImpl(this, uid, from, weaponUid, loc); }

  /** After a socket change: a smaller magazine spills its excess rounds into the bag; weapons re-read the instance. */
  afterSocketChange(weapon: ItemInstance): void { return Drop.afterSocketChange(this, weapon); }

  /* ── internals ─────────────────────────────────────────────────────────── */

  /**
   * Phase 10 (인게임 커서): the window keeps the **pointer lock** and drives the software cursor instead of handing
   * the OS cursor back — `setCursorMode` is ref-counted by blocker token, so a modeless popup layered on top (which
   * takes no token of its own) cannot steal it. No `exitPointerLock()`, and therefore no relock either.
   */
  setOpen(open: boolean): void {
    if (this._open === open) return;
    this._open = open;
    if (open) {
      this.ctx.uiBlockers.add(BLOCKER_TOKEN);
      // 2026-09-09: ESC 도 이 창을 닫는다 (`shared/escape` — 열린 순서의 역순으로 맨 위 하나). 팝업이 떠 있는
      // 동안은 `escHandler` 가 Escape 를 먼저 삼키므로 여기까지 오지 않는다.
      this.ctx.escape.push(BLOCKER_TOKEN, () => this.closeAll());
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

  /** 'player' = bag / loadout (HUD counts, sockets); the crate and the stash are 'container'. */
  locKind(loc: ItemLocation): 'player' | 'container' {
    return loc.kind === 'grid' && loc.grid !== 'bag' ? 'container' : 'player';
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
  changeBag(next: ItemInstance | null, from: ItemLocation | null, oldTo: 'grid' | 'world', hint?: { x: number; y: number }): OpResult { return Drop.changeBag(this, next, from, oldTo, hint); }

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
    if (b === 'player') this.ctx.bus.emit('inventory:itemAdded', { item, name: def.name, rarity: def.rarity });
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
