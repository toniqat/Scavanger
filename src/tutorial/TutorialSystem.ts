import './tutorial.css';
import type * as THREE from 'three';
import type {
  GameContext, GameSystem, ItemInstance, Stance, TutorialGate, TutorialGaugeInfo, TutorialObjectiveInfo,
  TutorialPanelInfo, TutorialRef, TutorialSave, TutorialStepId, TutorialTrack, TutorialTrackSave,
} from '@/shared';
import {
  COCKPIT_DECOR_FURNITURE, COCKPIT_DEFAULT_FURNITURE, COCKPIT_ROOM_INDEX, Keys, SHIP_ROOM_COUNT,
  TUTORIAL_CRAWL_AIM_HINT_FRAC, TUTORIAL_INTRO_WAKE_S, TUTORIAL_RAID_EXTRACT_VALUE_C, TUTORIAL_STEPS, TUTORIAL_TRACKS, TUTORIAL_TRACK_STEPS,
  isRaidFound, raidFoundSeed, sellPriceOf, slotKey, watchCutsceneHide,
} from '@/shared';
import {
  BUILD_TRACKS, CHECKPOINT_STEP, CORPSE_MARKER_STEPS, CROUCH_AIM_TIP_KO, CROUCH_TIP_STEPS, GUIDE_ARRIVE,
  MARKER_RETARGET_FRAMES, OPTIONAL_PREFIX_KO, RAID_KILLS_PER_STEP, creditGaugeLabel,
  SKIP_FADE_IN_S, SKIP_FADE_OUT_S, SKIP_HOLD_TIME, STANCE_HINT_IDS, TRACK_LABEL_KO,
  TUTORIAL_AMMO_RECIPE, TUTORIAL_BENCH_DEF, TUTORIAL_CONTROL_HINTS, TUTORIAL_CRAFT_GRANT,
  TUTORIAL_GUN_DEF, TUTORIAL_GUN_FAMILY, TUTORIAL_GUN_RECIPE, TUTORIAL_ROOM_PURPOSE, TUTORIAL_SAVE_VERSION, TUTORIAL_STORAGE_KEY,
  SPOT_CRAFT_CLOSE, SPOT_NONE, SPOT_STATS_CONFIRM, SPOT_STATS_RAISE, SPOT_STATS_TAB,
  STATS_CONFIRM_TEXT, STATS_RAISE_TEXT, STATS_TAB_TEXT, WAKE_REVEAL_DELAY_S, WAKE_REVEAL_MOVE_M,
  controlHintsFor, currentObjective, mergedAllow, objectiveChain, objectivesOf, visibleObjectives,
  CONTROLS_FOLDED_TEXT, FOLDABLE_CONTROL_STEPS, RAID_VALUE_POLL_FRAMES,
  type ControlHint, type HudRevealState, type StepDef, type TutorialObjective,
} from './model';
import { nextStep, normalizeStep, retiredObjectives, stepCountOf, stepDef, stepIndexOf, trackOf } from './Steps';
import { retiredTrackEnd } from './Steps';   // 2026-09-16: the out-of-order track end (`messenger` · `ravenQuest`)
import * as Gates from './parts/Gates';
import { Guide } from './parts/Guide';
import { ObjectiveMarker } from './parts/Marker';
import { Spotlight } from './parts/Spotlight';
import { TutorialControls } from './ui/Controls';
import { TutorialPanel } from './ui/Panel';
import { TutorialPopup } from './ui/Popup';
import { TutorialTip } from './ui/Tip';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/TutorialSystem.ts — new-character guidance (2026-09-08). Publishes `ctx.tutorial`.
 *
 * **Observation by default, enforcement through the contract.** Progress is judged entirely by watching bus events
 * (room purpose · furniture placed · craft completed · equipped · terminal · planet · boarding · mission start).
 * It never looks inside another folder. Enforcement (an out-of-order action blocked) is each folder calling
 * `ctx.tutorial.blockReason()` once in its own refusal-reason function — off, it is always null and nothing changes.
 *
 * **Start condition**: no save (= a new profile) and the first entry into the personal ship. The step reached stays
 * in localStorage across a reload; once over (finished or skipped) it never restarts (dev console `tutorial` reopens
 * it).
 *
 * **Materials**: the starter grant is all spent by the generator · the workshop · the workbench, so
 * `TUTORIAL_CRAFT_GRANT` is handed over once on entering the `craftGun` step (the floor, once per tutorial, written
 * into the save). On top of that, **top-up** (2026-09-09): on entering a craft step (`craftGun` · `craftAmmo`)
 * `ensureMaterials(recipeId)` walks that recipe's materials one by one and gives only `required − owned` — that is
 * why the rifle eating 6 scrap metal never leaves the medium-heavy ammo's 5 scrap metal short. The amounts are read
 * from the recipe, so no number lives in code, and it is idempotent — a reload refills only the gap (`topped` records
 * which step did).
 *
 * **Display timing** (2026-09-09): when the step changes the objective panel's text changes at once, but the
 * spotlight and the floor guide appear `TUTORIAL_STEP_DELAY_S` later — `parts/Spotlight` · `parts/Guide` count that
 * beat themselves (the side that looks for the target must count it, so a late target is handled in one place).
 * Nothing waits here.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The save shape **v2** (2026-09-14, 3 tracks then; `raid2` joined on 2026-09-18 — `TUTORIAL_TRACKS` is the count,
 * never a number written here). `tracks` is optional in the contract (`TutorialSave`) but is always
 * filled inside this folder, so it is narrowed to required here. v1 (top-level `step` · `done`) is grafted on by
 * `load()`.
 */
interface SaveV2 extends TutorialSave {
  version: number;
  tracks: Partial<Record<TutorialTrack, TutorialTrackSave>>;
  /** `TUTORIAL_CRAFT_GRANT` (the floor) has been handed over — exactly once. */
  granted?: boolean;
  benchUid?: string;
  /**
   * The steps `ensureMaterials` ran on (2026-09-09). A record only — top-up is idempotent, so re-entering gives just
   * the gap again.
   */
  topped?: TutorialStepId[];
  /**
   * The raid track was **run to the end** — the ship track follows on the next personal-ship entry (2026-09-14). It
   * is not set for someone who skipped: 「knows the controls, new to building out」 is not handed the ship track too.
   */
  pendingShip?: boolean;
  /**
   * The build track was **run to the end** (2026-09-18) — 「출격 안내」(`raid2`) follows at once. The same trick as
   * `pendingShip`, for the same reason: it is not set for someone who skipped (they do not want the guidance that
   * follows either), and it is **a field old saves lack**, so 「출격 안내」 never appears on a profile that already built
   * out (`autoStart` writes it done).
   */
  pendingRaid2?: boolean;
  /** The rows gathered in the right-side control guide (`ControlHint.id`) — they survive a reload. */
  learned?: string[];
  /**
   * The objective ids marked done **in the current step** (2026-09-14 2nd pass). All it does is keep the check from
   * disappearing when an optional objective was done and the page reloaded — it is cleared when the step advances.
   */
  objectives?: string[];
}

const freshSave = (): SaveV2 => ({ version: TUTORIAL_SAVE_VERSION, tracks: {} });

/** The answer for a step with no counted objective (2026-09-15 2nd pass) — no new object every frame. */
const EMPTY_COUNTS: Readonly<Record<string, number>> = Object.freeze({});

/*
 * 2026-09-14 2nd pass (user's decision) — **the tutorial starts at full HP and revives at full HP.** The 1st pass's
 * 「wakes up on low HP」 (`applyLowHp`, re-applying `TUTORIAL_START_HP` 4 on every spawn · revive · wake) was removed.
 * The tension is made by **fall damage** now — the HP actually lost in the `drop` step is put back by the `heal`
 * step's bandage, which is the one line 「fall damage noticed → healed」; at full HP `heal` passes silently.
 */

export class TutorialSystem implements GameSystem, TutorialRef {
  readonly name = 'tutorial';
  private ctx!: GameContext;
  private save: SaveV2 = freshSave();
  private unsubs: Array<() => void> = [];

  private panel!: TutorialPanel;
  private popup!: TutorialPopup;
  private spotlight!: Spotlight;
  private guide!: Guide;
  /** The 3D target marker — it stands over `corpseLoot`'s target corpse (2026-09-14 3rd pass). */
  private marker!: ObjectiveMarker;
  /** The right-side control guide — the controls used in the current stretch (raid track). */
  private controls!: TutorialControls;
  /** The TIP toast right under the control guide (2026-09-15). */
  private tip!: TutorialTip;
  /** The crouched-aim TIP has already been shown in this raid track (exactly once). */
  private crouchTipShown = false;
  /**
   * In `corpseLoot` **the window was closed without the gun** (2026-09-15, user's decision) — the focus is released.
   * Opening the corpse again brings it back; walking on, the `bugs` checkpoint · the bug spawn fold to the next step
   * (required rows never block).
   */
  private corpseFocusOff = false;
  /** Time left on the raid-track skip fade to black (s). 0 = not fading (2026-09-15). */
  private skipFadeT = 0;
  /** This system raised the black plate — clearing it is its own responsibility too. */
  private skipFadeOwned = false;
  /** The observed state `hides('hud', …)` reads (what a table cannot decide). */
  private readonly hudState: HudRevealState = { staminaUsed: false };
  /** Enemies killed in the `shoot` step (counted inside the raid track only). */
  private kills = 0;
  /** The objective ids marked done in the current step (a live copy of `save.objectives`). */
  private done = new Set<string>();
  /*
   * ── the intro wake (2026-09-14 4th pass) ────────────────────────────────
   * `PlayerRef.playIntroWake` is called **on the next frame of `update()`**. ⚠ It must not be called while
   * `game:newMission` is being handled — `PlayerSystem`, a later handler of that emit, silently wipes it with
   * `cancelIntroWake` (inside `world:ready` is out for the same reason: it is emitted synchronously there).
   * `TutorialWorld.placeShip` already defers one frame for the same reason; here a one-slot booking does that job.
   */
  /**
   * Start the intro wake on the next frame (only while `step === 'wake'` — it must not run for someone who resumed).
   */
  private pendingWake = false;
  /** Time left after the cutscene ends before the guidance is shown (s). 0 = no grace. */
  private wakeHoldT = 0;
  /** The origin for the movement distance that shortens that grace (where the cutscene ended). */
  private wakeFromX = 0;
  private wakeFromZ = 0;
  /** The inventory screen is open — the right-side control guide folds while it is (2026-09-14 2nd pass). */
  private invOpen = false;
  /**
   * The current stance (2026-09-14 3rd pass) — the `crouch` step's control-guide labels follow it
   * (standing → `앉기`/`포복`, crouched → C = `일어서기`, prone → Z = `일어서기`).
   */
  private stance: Stance = 'stand';
  /** The ids of the rows currently up in the control guide (a step absent from the table keeps this list). */
  private controlIds: string[] = [];
  /**
   * Frames left until the target marker looks for its target again (it does not sweep `interactables` every frame).
   */
  private retarget = 0;

  /** Interactable id of the bench the player placed (guide target for the craft steps). */
  private benchInteractable: string | null = null;
  /** true while the skip-confirm card is up (the intro card uses the same popup). */
  private confirmingSkip = false;
  /**
   * The gun workbench is held on the cursor waiting to be placed (what folds the spotlight in the `bench` step —
   * 2026-09-17: the old `benchPlace` step became that step's 「가구 배치」 row).
   */
  private benchArmed = false;
  /**
   * The craft column is open (`ui:craftToggled`) — `craftGun`'s last row 「제작창 닫기」 judges "closed" by it
   * (`pollBuild`), and `equipGun`'s spotlight splits on it (`stepView`).
   */
  private craftOpen = false;
  /**
   * The character sheet's pre-confirm ＋ point total (`progress:statPending`, 2026-09-16 2nd pass) — it picks the
   * `stats` focus.
   */
  private statPending = 0;
  /** The focus `stats` is showing right now (`statsFocus`) — `poll` redraws the screen only when it changes. */
  private statsFocusKey = -1;
  /**
   * The ship track ended **with the menu open** — the next track (build) starts when the menu closes (2026-09-16 2nd
   * pass, `finish` · `onInventoryClosed`). Meanwhile `isTrackDone('ship')` is false, so Raven's first contact never
   * cuts in ahead of the build track. It is not saved — after a reload `autoStart` on `hub:entered` does the same
   * thing.
   */
  private autoStartOnClose = false;
  /**
   * The liftoff cinematic took the screen (`ui:cinematic`, 2026-09-16 user's decision — 「all remaining HUD
   * disappears」). While it holds, the objective panel · control guide · TIP · spotlight · floor guide · target marker
   * are not drawn (`refreshVisuals`). It pairs with ui/'s HUD fade — ui/ does not know this folder's DOM, so it folds
   * itself. Released on: `ui:cinematic false` · `game:abort` · `game:newMission` · `hub:entered`.
   */
  private cinematic = false;
  /**
   * The tactical map is open (`ui:mapToggled`, 2026-09-18 user's decision — 「the tutorial objectives at the map's top
   * left」). While it is, only the floating objective panel folds — the map draws the same objectives in its own left
   * column, so two copies overlapped. The spotlight · the floor guide are untouched: the map covers the screen
   * anyway.
   */
  private mapOpen = false;
  /**
   * `TUTORIAL_CRAWL_AIM_HINT_FRAC` of the collapsed passage is behind (2026-09-16, user's decision) — fire · aim down
   * sights join the crawl stretch's control guide. Once up they stay when the player backs off (no flicker); a step
   * outside the crawl stretch releases them (`setStep`).
   */
  private crawlHalf = false;
  /** The quick-use item in hand is a healing item (`quick:equipped`) — `heal`'s `길게 눌러 사용` row (2026-09-16). */
  private handStim = false;
  /**
   * In 「출격 안내」's raid (`raid`) the **summed sell value of this raid's loot** carried right now (2026-09-17; the
   * step moved into `raid2` on 2026-09-18).
   * `poll` counts it every few frames and liftoff (`extraction:liftoff {aboard}`) counts it once more — by the time
   * the result screen is up inventory may already have wiped the marks (`inventory/parts/RaidFound.stripRaidMarks`
   * runs on `game:complete`).
   */
  private raidValue = 0;
  private raidValueTick = 0;
  /**
   * The value counted at the moment of liftoff (-1 = has not lifted off yet) — the extraction check reads this first.
   */
  private liftoffValue = -1;
  /** The right-side control guide of 「출격 안내」's raid is folded (`Keys.GUIDE_TOGGLE`, 2026-09-17). Not saved. */
  private controlsFolded = false;

  /* ── lifecycle ─────────────────────────────────────────────────────────── */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.tutorial = this;
    this.save = this.load();
    if (this.save.benchUid) this.benchInteractable = `hub_furn_${this.save.benchUid}`;

    this.done = new Set(this.save.objectives ?? []);

    // 2026-09-14 2nd pass: the skip button left the panel — the ESC menu calls `skipTrack(track)`.
    this.panel = new TutorialPanel(ctx.uiRoot);
    this.popup = new TutorialPopup(ctx, () => { /* nothing to restore — the ship keeps running behind it */ });
    this.spotlight = new Spotlight(ctx.uiRoot);
    this.guide = new Guide(ctx);
    this.marker = new ObjectiveMarker(ctx);
    this.controls = new TutorialControls(ctx.uiRoot);
    this.tip = new TutorialTip(ctx.uiRoot);
    this.restoreControls();

    const b = ctx.bus;
    this.unsubs.push(
      // 2026-09-15: the skip fade always clears on entering the ship (once more even if `ui/HudSystem` already
      //   cleared it on the result screen)
      b.on('hub:entered', () => this.clearSkipFade(0)),
      b.on('game:abort', () => { this.skipFadeT = 0; this.skipFadeOwned = false; this.tip.clear(); }),
      /* 2026-09-15 (user's decision — 「the extraction success comes up on a black screen」): the black plate stays
       * even when the phase changes to the result screen (`ui:screenFade.hold`). So **ownership is not dropped here**
       * — the `hub:entered` → `clearSkipFade(0)` above is the one owner that clears it, and that is the reason 「the
       * ship is never left black」. Only the fade clock stops (the result screen is up, so no extraction is left to
       * call). */
      b.on('game:complete', () => { this.skipFadeT = 0; }),
      // 2026-09-16: the tutorial DOM · 3D guidance folds during the liftoff cinematic (`cinematic`) — every reset
      //   path must release it
      b.on('ui:cinematic', ({ active }) => this.onCinematic(active)),
      b.on('game:abort', () => this.onCinematic(false)),
      b.on('game:newMission', () => this.onCinematic(false)),
      b.on('hub:entered', () => this.onCinematic(false)),
      /*
       * 2026-09-17 (B-17, user's decision — 「a popup that cannot be closed hides for a cutscene」): the intro card ·
       * the skip-confirm card are not closable by the 「모든 UI 닫기」 right before docking (outside the escape stack ·
       * closing them advances the step). So they are not closed but **hidden** — gone for docking · the window warp ·
       * the liftoff cinematic and back unchanged when it ends (`shared/cutsceneHide`). Why it is kept apart from
       * `cinematic` above: that one decides 「what is drawn right now」 (`refreshVisuals`), this one only hides the
       * card **without touching its state**.
       */
      watchCutsceneHide(ctx, (hidden) => this.popup.setHidden(hidden)),
      b.on('hub:entered', ({ ship }) => this.onHubEntered(ship)),
      b.on('hub:left', () => this.refreshVisuals()),
      b.on('game:phaseChanged', () => this.refreshVisuals()),

      b.on('housing:shipManageChanged', ({ active }) => this.onManage(active)),
      /*
       * 2026-09-15: housing mode entered from a room console (`enterHousingMode`) emits only `modeChanged
       * {active:false}` when it closes (`shipManageChanged` only for the M screen) — the 「하우징 모드 닫기」 step and the
       * floor-guide hiding watch that path too. Closing the M screen sends both in a row, and `onManage` is
       * idempotent (the second is already on the next step — nothing happens).
       */
      b.on('housing:modeChanged', ({ active }) => this.onManage(active)),
      b.on('housing:facilityUpgraded', ({ id, level }) => { if (id === 'generator' && level >= 1) this.markIf('manage', 'generatorOn'); }),
      b.on('housing:roomPurposeChanged', ({ room, purpose }) => this.onPurpose(room, purpose)),
      // Furniture crafting has no event of its own — after `housing:changed {reason:'craft'}` the storage is looked
      //   at once
      b.on('housing:changed', ({ reason }) => { if (reason === 'craft') this.onFurnitureCrafted(); }),
      b.on('housing:selectionChanged', ({ defId }) => this.onSelection(defId)),
      b.on('housing:furniturePlaced', ({ item }) => this.onFurniture(item.defId, item.uid)),

      b.on('craft:completed', ({ recipeId }) => this.onCrafted(recipeId)),
      // 2026-09-08: the equipment slots come back only once the craft window is closed — that one close is
      //   `craftGun`'s last row 「제작창 닫기」 (2026-09-17: the old `openBag` step was folded into it). For someone who
      //   closed the whole window, `inventory:opened` (= the bag reopened with Tab) counts as the same signal.
      // 2026-09-09: `ui:craftToggled` is emitted by the **bench path** (openBenchCraft / closeBench) only, never by
      //   the bag's `제작` button (the plain craft column) — that path is read through `ui:keyGuide
      //   {owner:'inventory.craft'}`, the row the craft column puts in the key guide (keys ≠ null = open, null =
      //   closed). Both go to one function keeping one `craftOpen`. (The `openCraft` step, which used the open as its
      //   signal, left the order the same day — rifle · ammo are made in one go.)
      b.on('ui:craftToggled', ({ open }) => this.onCraftPanel(open)),
      b.on('ui:keyGuide', ({ owner, keys }) => { if (owner === 'inventory.craft') this.onCraftPanel(keys !== null); }),
      b.on('inventory:opened', () => this.onInventoryOpened()),
      // 2026-09-14 3rd pass (user's decision): `corpseLoot` moves on to the bug stretch **only once the bag is
      //   closed**
      // 2026-09-15: `supplyLoot` too — closing the window after the bandage is held gives `heal`
      b.on('inventory:closed', () => this.onInventoryClosed()),
      // 2026-09-15: the `corpseLoot` focus released by closing without the gun comes back when the corpse is opened
      //   again
      b.on('inventory:containerOpened', ({ containerId }) => this.onContainerOpened(containerId)),
      b.on('loadout:changed', () => this.onLoadout()),
      b.on('inventory:changed', () => this.onInventory()),
      b.on('inventory:bagChanged', () => this.onInventory()),
      // 2026-09-14 2nd pass: the right-side control guide folds while the inventory screen is open (it covers the
      //   screen's right)
      b.on('inventory:opened', () => this.setInventoryOpen(true)),
      b.on('inventory:closed', () => this.setInventoryOpen(false)),

      b.on('hub:terminalToggled', ({ open }) => { if (open) this.markIf('terminal', 'terminalOpen'); }),
      /*
       * 2026-09-09 — the `planet` step advances **when the warp starts**.
       *
       * It used to advance on `hub:planetChanged`, but that event is emitted **right after**
       * `hub/parts/Planet.finishTravel` has **arrived** and sent `hub:travel {end}`. So the order went out of step:
       *   warp starts → (the guidance is still `planet`) → arrival → `travel {end}` (still `planet`, so ignored) →
       *   `planetChanged` → only now does it move to `travel` → **the `travel {end}` it waits for is already gone.**
       * That is why the guidance sat on the `planet` step (14/17 then) with the planet travel long finished.
       * Advancing at the start gives the two steps one side of the warp each. `planetChanged` is left in place
       * (insurance for a path that only sees the arrival); once past it, `advanceIf` quietly does nothing.
       */
      /* 2026-09-17: the `planet` · `travel` · `board` steps became `terminal`'s objective rows — the same signals
         write the rows. The warp's end (`travelDone`) is an id absent from the list; it opens the 「발사 슬롯으로 이동」 row
         (`revealOn`). */
      b.on('hub:planetChanged', () => { this.markIf('terminal', 'planetPicked'); this.markIf('terminal', 'travelDone'); }),
      b.on('hub:travel', ({ stage }) => { this.markIf('terminal', stage === 'start' ? 'planetPicked' : 'travelDone'); }),
      b.on('hub:slotChanged', ({ local, peerId }) => { if (local && peerId) this.markIf('terminal', 'boardOn'); }),
      b.on('game:newMission', ({ mode }) => {
        if (mode === 'tutorial') { this.startRaidTrack(); return; }
        if (mode !== 'training') this.advanceIf('terminal');
      }),
      b.on('world:ready', () => this.onRaid()),
      /* 2026-09-17 (user's decision): 「출격 안내」's raid is **one attempt** — when it ends the track ends whatever
         the result (`onBuildRaidEnd`). The carried value is counted once more at liftoff (by result-screen time the
         marks are wiped). */
      b.on('extraction:liftoff', ({ aboard }) => { if (this.step === 'raid' && aboard !== false) this.liftoffValue = this.carriedRaidValue(); }),
      b.on('game:complete', ({ stats }) => this.onBuildRaidEnd(stats.extracted)),
      b.on('game:over', () => this.onBuildRaidEnd(false)),
      /* ── ① raid track (2026-09-14) — all of it is **watching events that already exist** ──────────────
       * The backbone is `tutorial:checkpoint` (owner: world/tutorial): passing a stretch ends that stretch's step. A
       * step that ends by action (equipping · a kill · crouching · falling · healing · a grenade · liftoff) watches
       * its own event — coming **before** the checkpoint is normal, and a late checkpoint `advanceIf` quietly
       * ignores. */
      b.on('tutorial:checkpoint', ({ id }) => this.onCheckpoint(id)),
      b.on('player:introWakeDone', () => this.advanceIf('wake')),
      b.on('player:stanceChanged', ({ stance }) => this.onStance(stance)),
      // 2026-09-15: one TIP the first time the player aims down sights crouched or prone in the crawl · crouched-aim
      //   stretch
      b.on('player:aimChanged', ({ aiming }) => { if (aiming) this.maybeCrouchTip(true); }),
      // The stamina HUD appears **the first time it is spent** (`hides('hud','stamina')`)
      b.on('player:sprintChanged', ({ sprinting }) => { if (sprinting) this.markStaminaUsed(); }),
      b.on('player:staminaDepleted', () => this.markStaminaUsed()),
      b.on('player:fell', ({ damage }) => { if (damage > 0) this.advanceIf('drop'); }),
      /*
       * 2026-09-14 4th pass (user's decision) — **the moment the bug erupts** is the start of `shoot`. The tutorial
       * bug does not stand there at `world:ready`; it burrows up once the player enters its own detection radius
       * (`enemies/Tutorial.updateTutorialAmbush` → `parts/Pool.spawn` → this event), and that spot is 14 m ahead of
       * the `bugs` checkpoint. So the checkpoint only opens `advance1` and the guidance advances here.
       * ⚠ Missing this event and staying on `advance1` is **not a dead end** — the next checkpoint (`crawl`) folds to
       *   `crouch` (it only skips `shoot`; the guidance never stops).
       * 2026-09-15: someone who walked past the corpse without the gun (still on `corpseLoot`) also goes straight to
       * `shoot` when the bug erupts.
       */
      b.on('enemy:spawned', () => this.onEnemySpawned()),
      b.on('enemy:killed', () => this.onKill()),
      b.on('player:stimUsed', () => { this.markIf('heal', 'healUse'); this.advanceIf('heal'); }),
      /* ── `heal` is two rows (2026-09-14 4th pass) — picked from the wheel **into the hand** · held down to **use**.
       *    「puts it in a quick slot」 left the objectives because auto-registration does it, and the subscription that
       *    watched it went too. 2026-09-15: the two rows are a sequential reveal (`healUse` has `reveal`) — for
       *    someone who pulled it out with Tab, `objectiveChain` writes the row before it too. */
      b.on('quick:equipped', ({ item }) => this.onQuickEquipped(item)),
      // A new raid · an abort starts empty-handed (the in-hand event may not arrive)
      b.on('game:newMission', () => { this.handStim = false; }),
      b.on('game:abort', () => { this.handStim = false; }),
      // The grenade step's **optional** objective is 「pull one and throw it」 — any explosion counts, a kill is not
      //   looked at
      b.on('grenade:exploded', () => this.markIf('grenade', 'grenadeThrow')),
      // Extraction ends the moment the switch is pressed — waiting for the liftoff cinematic lets the result screen
      //   cover the guidance
      b.on('extraction:departureStarted', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),
      b.on('extraction:liftoff', () => { this.foldRaid('extract'); this.advanceIf('extract'); }),

      /* ── ② ship track (2026-09-14) ── */
      /* 2026-09-16 2nd pass (user's decision): `levelUp` left the order, leaving the one step `stats` — opening the
       * menu · the character tab are watched by `poll`, ＋ by `progress:statPending`, the confirm by
       * `progress:statChanged`. The track ends **right where** it is confirmed (`onStatsConfirmed`). */
      b.on('progress:statPending', ({ total }) => this.onStatPending(total)),
      b.on('progress:statChanged', () => this.onStatsConfirmed()),
      /* 2026-09-16 (user's decision): `messenger` (open the messenger) left the order — it left the ship track at
       * `levelUp` → `stats` (the 2nd pass above cut that to the one step), and the `ui:messengerToggled`
       * subscription that advanced it went too. The
       * messenger stays hidden throughout the ship · build tracks (`parts/Gates` — no step opens `community`).
       * Raven's first contact is still after every track (`meta/parts/NpcQuests.tutorialBlocks`). */

      // Rebinding re-reads the keycaps of the control guide · the objective rows (keys are read at use time —
      //   `docs/CONTROLS.md`)
      b.on('input:bindingsChanged', () => { this.controls.relabel(); this.panel.relabel(); }),
      // 2026-09-18: the floating panel folds when the map opens (the map's left column draws the same objectives —
      //   `mapOpen`)
      b.on('ui:mapToggled', ({ open }) => { this.mapOpen = open; this.refreshVisuals(); }),
    );
    this.registerConsole();
    this.refreshVisuals();
  }

  update(dt: number): void {
    // The skip fade runs **after** the track has ended (`skipTrack` calls `finish` first) — so it must come before
    //   the active check
    this.updateSkipFade(dt);
    if (!this.active) return;
    this.tip.update(dt, this.controls.visible ? this.controls.root : null);
    // 2026-09-16: while a key shown on the panel is held, that keycap lights orange
    this.controls.update(this.ctx.input);
    this.pollControlsFold();
    this.pollCrawlHint();
    this.consumePendingWake();
    this.updateWakeHold(dt);
    this.poll();
    // The stamina HUD appears **the first time it drops**. Jumping · ladders spend it too, not only sprinting, so
    //   besides the events it is polled through the raid track (once `staminaUsed` is up it is never looked at
    //   again).
    if (!this.hudState.staminaUsed && this.track === 'raid') {
      const p = this.ctx.player;
      const max = p?.maxStamina ?? 0;
      if (max > 0 && (p?.stamina ?? max) < max - 0.5) this.markStaminaUsed();
    }
    this.guide.update(dt);
    this.marker.update(dt);
    this.spotlight.update(dt);
    // While the focus is on, the objective panel sits above the dim plates — outside the dim, and the skip button
    //   always clicks
    this.panel.setLifted(this.spotlight.visible);
  }

  /**
   * Looks once a frame at the things that have no event (2026-09-14 3rd pass). Every one asks **only about what is
   * not done yet** and is never asked again once done — they are gathered here so as not to invent new events.
   *   ① the 「…으로 이동」 objectives — has the interaction range of the thing the floor guide points at been entered
   *     (`StepDef.arriveObjective`).
   *   ② `stats` — pressing the character tab **with the inventory already open** sends no `inventory:opened` (a
   *      bug). So the screen tab itself is read: a tab other than the inventory being up means the screen is open.
   */
  private poll(): void {
    const step = this.step;
    if (!step) return;
    // The target marker — the corpse is made by `world/tutorial`, so the guidance can stand first. It re-targets on
    //   the floor guide's period.
    if (CORPSE_MARKER_STEPS.includes(step)) {
      this.retarget -= 1;
      if (this.retarget <= 0) { this.retarget = MARKER_RETARGET_FRAMES; this.marker.setTarget(this.nearestCorpse()); }
    }
    if (step === 'stats') {
      // ③ the confirm is written down but the track is still running (an old save of the 2026-09-16 1st pass, when it
      //     ended on close): end it in the ship at once
      if (this.done.has('statsSpent')) { if (this.ctx.isHubPhase()) this.advance(); return; }
      this.pollStats();
    }
    const def = stepDef(step);
    // The 「…으로 이동」 row — the current objective is that row and the floor guide target's interaction range has been
    //   entered (2026-09-17: per-objective `arrive`)
    const cur = currentObjective(this.objectivesFor(def), this.done);
    if (cur && (cur.arrive || cur.id === def.arriveObjective) && this.arrivedAtGuide(this.guideKindOf(def, cur))) this.markObjective(cur.id);
    this.pollBuild(step);
  }

  /**
   * Looks at **what has no event** among the build track's grouped steps (2026-09-17). Every one asks 「only what is
   * not done yet」.
   *   • `bench` — is the furniture storage tab on (`ui/hud/ShipManage`'s tab button `.is-on` — the DOM handle the
   *     spotlight already uses) · placing is finished but housing mode is closed (the old `manageDone`'s silent pass
   *     · reload recovery).
   *   • `craftGun` — the ammo is made too but the craft window is closed (a path that missed the close event · reload
   *     recovery).
   *   • `equipGun` — has the inventory opened · is it equipped and **the inventory closed** (the place it waits with
   *     no objective row, user's decision).
   *   • `terminal` — is the readiness hold over (`HubRef.launchReady`).
   *   • `raid` — the loot value carried (every `RAID_VALUE_POLL_FRAMES`).
   */
  private pollBuild(step: TutorialStepId): void {
    const ctx = this.ctx;
    if (step === 'bench') {
      if (!this.done.has('benchStore') && this.done.has('benchCrafted')
        && document.querySelector('.sm-tabs .sm-tab[data-tab="store"].is-on')) this.markObjective('benchStore');
      if (this.done.has('benchDown') && !this.housingOpen() && ctx.isHubPhase()) this.advance();
      return;
    }
    if (step === 'craftGun') {
      if (this.done.has('craftAmmoMade') && !this.craftOpen && !(ctx.inventory?.isOpen ?? false)) this.advance();
      return;
    }
    if (step === 'equipGun') {
      const open = ctx.inventory?.isOpen ?? false;
      /*
       * 2026-09-18: 「is there nothing left to do」 is asked again only **at the moment the window opens** (insurance
       * for a path that missed `inventory:opened` — this step was entered while the bench window was closing, so it
       * is the one frame where `equipOpen` is not written yet).
       * ⚠ Asking it **the whole time the window is open** breaks the 2026-09-17 decision: dropping the rifle into 주무기
       *   II fills both primary slots, so 「equipped or not, the same step until the window closes」 (the objective
       *   never changes behind the back of someone watching the screen) becomes unreachable — it broke exactly that
       *   way and a smoke caught it (`smoke-tutorial` 「창이 열려 있는 동안은 같은 단계다」).
       */
      if (open && !this.done.has('equipOpen')) {
        if (this.equipGunSkipIfMoot()) return;
        this.markObjective('equipOpen');
      }
      if (this.done.has('equipSlot') && !open) this.advance();
      return;
    }
    if (step === 'terminal') {
      if (!this.done.has('readyHold') && this.done.has('boardOn') && (ctx.hub?.launchReady ?? false)) this.markObjective('readyHold');
      return;
    }
    if (step === 'raid' && ctx.isGameplayPhase()) {
      this.raidValueTick -= 1;
      if (this.raidValueTick > 0) return;
      this.raidValueTick = RAID_VALUE_POLL_FRAMES;
      const v = this.carriedRaidValue();
      if (v === this.raidValue) return;
      this.raidValue = v;
      this.panel.setCounts(this.objectiveCounts());
      // 2026-09-18 (user's decision): this step's progress bar is **the value carried now**, not the step count — it
      //   moves with the row's `(n/m)`
      this.panel.setGauge(this.raidGauge());
    }
  }

  /**
   * The **progress bar** of 「출격 안내」's raid (2026-09-18, user's decision) — every other step · track measures the
   * step count as before, so it is null then. The fill clamps at 1 and the text writes the real value
   * (`model.creditGaugeLabel`).
   */
  private raidGauge(): TutorialGaugeInfo | null {
    if (this.step !== 'raid' || this.track !== 'raid2') return null;
    return {
      at: this.raidValue, total: TUTORIAL_RAID_EXTRACT_VALUE_C,
      label: creditGaugeLabel(this.raidValue, TUTORIAL_RAID_EXTRACT_VALUE_C),
    };
  }

  /**
   * The summed sell value of the items **found in this raid** carried right now (equipment slots · bag · pouches ·
   * wheel, 2026-09-17). The mark rule is `shared/raidFound` alone and the value is the shop sell price
   * (`sellPriceOf`) — ship-brought · crafted items never count.
   */
  private carriedRaidValue(): number {
    const ctx = this.ctx;
    const inv = ctx.inventory;
    const seed = raidFoundSeed(ctx);
    if (!inv || seed === null) return 0;
    let sum = 0;
    try {
      inv.countWhere((d, it) => {
        if (d.value > 0 && isRaidFound(it, seed)) sum += sellPriceOf(d.value, Math.max(1, it.qty));
        return false;
      });
      const l = inv.getLoadout();
      for (const it of Object.values(l)) {
        if (!it || typeof it !== 'object' || !isRaidFound(it, seed)) continue;
        const d = inv.getDef(it.defId);
        if (d && d.value > 0) sum += sellPriceOf(d.value, Math.max(1, it.qty));
      }
    } catch { /* inventory not ready */ }
    return sum;
  }

  /**
   * 「출격 안내」's raid ended (2026-09-17, user's decision — **one attempt**). Extracted with the value at or above
   * the bar draws the check on the objective, and either way the track ends (it is not a skip). The result · death
   * screen is coming up, so the panel folds. A path that missed this event (the raid abandoned from the title · a
   * reload) gets the same done by `onHubEntered` on entering the ship.
   */
  private onBuildRaidEnd(extracted: boolean): void {
    // 2026-09-18: that raid is now the last step of **「출격 안내」** (`raid2`) — the id is still `raid`
    if (this.step !== 'raid' || this.track !== 'raid2') return;
    const value = this.liftoffValue >= 0 ? this.liftoffValue : this.carriedRaidValue();
    if (extracted && value >= TUTORIAL_RAID_EXTRACT_VALUE_C) {
      this.raidValue = value;
      this.panel.setCounts(this.objectiveCounts());
      this.panel.setGauge(this.raidGauge());
      this.markObjective('raidValue');
    }
    this.finish(false);
  }

  /**
   * Folding / unfolding the control guide (2026-09-17, user's decision) — `Keys.GUIDE_TOGGLE` (default `]`) is read
   * only in 「출격 안내」's raid, and never while a cursor screen (inventory · map …) is open (`isGameplayActive` — so
   * it never collides with those screens' keys).
   */
  private pollControlsFold(): void {
    const step = this.step;
    if (!step || !FOLDABLE_CONTROL_STEPS.includes(step)) return;
    if (!this.ctx.isGameplayActive() || !this.ctx.input.wasPressed(Keys.GUIDE_TOGGLE)) return;
    this.controlsFolded = !this.controlsFolded;
    this.controls.setFolded(this.controlsFolded, CONTROLS_FOLDED_TEXT);
    this.ctx.bus.emit('audio:play', { id: 'ui_click' });
  }

  /* ── the intro wake (2026-09-14 4th pass) ────────────────────────────────
   * From the commit that introduced it, `PlayerRef.playIntroWake` was **called nowhere in `src/`**, so neither the 2
   * s fade nor the animation of getting up off the ground ever played. `player:introWakeDone` never arriving was
   * simply not noticed, because the `cliff` checkpoint folds as far as `sprintJump`, so progress is never blocked.
   * ────────────────────────────────────────────────────────────────────── */

  /** Starts the booked intro wake **on the next frame** (see the ⚠ on `pendingWake` above). */
  private consumePendingWake(): void {
    if (!this.pendingWake) return;
    this.pendingWake = false;
    // The cutscene must not run for someone who came back at a mid checkpoint by resuming (`gotoCheckpoint`)
    if (this.step !== 'wake') return;
    this.ctx.player?.playIntroWake?.(TUTORIAL_INTRO_WAKE_S);
  }

  /**
   * The beat after the cutscene ends. Once `WAKE_REVEAL_DELAY_S` has run out or **the player has moved
   * `WAKE_REVEAL_MOVE_M` on their own** (whichever comes first), the objective panel and the control guide appear
   * together.
   */
  private updateWakeHold(dt: number): void {
    if (this.wakeHoldT <= 0) return;
    this.wakeHoldT -= dt;
    const p = this.ctx.player;
    const moved = p ? Math.hypot(p.position.x - this.wakeFromX, p.position.z - this.wakeFromZ) : 0;
    if (this.wakeHoldT > 0 && moved < WAKE_REVEAL_MOVE_M) return;
    this.wakeHoldT = 0;
    this.refreshVisuals();
  }

  /** `wake` has just been left — it counts the beat before the guidance is shown. */
  private beginWakeReveal(): void {
    const p = this.ctx.player;
    this.wakeFromX = p?.position.x ?? 0;
    this.wakeFromZ = p?.position.z ?? 0;
    this.wakeHoldT = WAKE_REVEAL_DELAY_S;
  }

  /**
   * **Nothing is drawn** right now — the intro wake is running (the screen is black) or it is the beat right after
   * it. The objective panel · the control guide · the spotlight · the floor guide all read this one line.
   */
  private get quiet(): boolean { return this.step === 'wake' || this.wakeHoldT > 0; }

  /**
   * Has the **interaction range** of the thing the floor guide points at been entered (`ctx.interactables` gives the
   * position).
   */
  private arrivedAtGuide(kind: 'bench' | 'terminal' | 'pod' | undefined): boolean {
    const id = this.guideTarget(kind);
    const p = this.ctx.player;
    if (!id || !p) return false;
    const it = this.ctx.interactables.all().find((i) => i.id === id);
    if (!it) return false;
    return it.position.distanceTo(p.position) <= Math.max(GUIDE_ARRIVE, it.radius);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs = [];
    this.panel?.dispose();
    this.popup?.dispose();
    this.spotlight?.dispose();
    this.guide?.dispose();
    this.marker?.dispose();
    this.controls?.dispose();
    this.tip?.dispose();
    if (this.ctx) this.ctx.tutorial = null;
  }

  /* ── TutorialRef ───────────────────────────────────────────────────────── */

  /** The track running right now (**exactly one** track holds a step at any time). */
  get track(): TutorialTrack | null {
    for (const t of TUTORIAL_TRACKS) if (this.save.tracks[t]?.step) return t;
    return null;
  }

  get active(): boolean { return this.track !== null; }
  get step(): TutorialStepId | null { const t = this.track; return t ? this.save.tracks[t]!.step : null; }
  get stepIndex(): number { return stepIndexOf(this.step); }
  /**
   * The progress denominator is **the current track's length**. When inactive it answers the build length for old
   * call sites.
   */
  get stepCount(): number { return stepCountOf(this.step) || TUTORIAL_STEPS.length; }

  blockReason(gate: TutorialGate, id?: string): string | null {
    return Gates.blockReason(this.step, gate, id, this.allowTable());
  }

  hides(gate: TutorialGate, id?: string): boolean { return Gates.hides(this.step, gate, id, this.hudState, this.allowTable()); }

  /**
   * The current step's allow table — the gates a visible objective row opens are merged in too (2026-09-17,
   * `model.mergedAllow`).
   */
  private allowTable(): Gates.AllowTable {
    const step = this.step;
    if (!step) return undefined;
    const def = stepDef(step);
    return mergedAllow(def.allow, this.objectivesFor(def), this.done);
  }

  /**
   * The floor guide target while that row is the current objective — the row's own when it states one (`null`
   * included), else the step's.
   */
  private guideKindOf(def: StepDef, cur: TutorialObjective | null): 'bench' | 'terminal' | 'pod' | undefined {
    if (cur && cur.guide !== undefined) return cur.guide ?? undefined;
    return def.guide;
  }

  /**
   * The build track from the beginning (console `tutorial start` · old call sites). Other tracks' state is left
   * alone.
   */
  start(): boolean {
    if (this.active) return false;
    const tracks = { ...this.save.tracks, build: { step: null, done: false } as TutorialTrackSave };
    this.save = freshSave();
    this.save.tracks = tracks;
    this.resetControls();
    this.setStep('intro');
    return true;
  }

  skip(): void {
    const t = this.track;
    if (!t) return;
    this.skipTrack(t);
  }

  goto(step: TutorialStepId): boolean {
    const target = normalizeStep(step);   // `openCraft`, dropped out of the order, maps to `craftAmmo`
    if (!target) return false;
    const track = trackOf(target);
    // Another running track is folded where it stands — it is not marked done (it can start again)
    for (const t of TUTORIAL_TRACKS) { const e = this.save.tracks[t]; if (t !== track && e?.step) e.step = null; }
    const cur = this.save.tracks[track];
    this.save.tracks[track] = { step: cur?.step ?? null, done: false };
    this.setStep(target);
    return true;
  }

  /* ── tracks (2026-09-14; a 4th, `raid2`, split off on
   *    2026-09-18 — `TUTORIAL_TRACKS` is the list) ────────────
   * Each track has its own objective panel · its own skip, and **only the skipped track is released** — because there
   * is someone who knows the controls but has never built out a ship (user's decision). The state is the one
   * `save.tracks`, and one track runs at a time. */

  /**
   * Is that track over (true for both run to the end and skipped).
   *
   * ⚠ The point is **when the save has no record of that track at all** — a new character and a profile played since
   * before the tutorial existed look the same (no `scav.tutorial`). So 「is the ship untouched」 (`looksFresh`)
   * decides: for someone already playing every answer is `true`, so the entry flow (`ui/menus/enterShip`) goes to the
   * ship as before.
   */
  isTrackDone(track: TutorialTrack): boolean {
    // 2026-09-16 2nd pass: the ship track is over but the next track waits for the menu to close
    //   (`autoStartOnClose`) — so Raven cannot cut in meanwhile
    if (track === 'ship' && this.autoStartOnClose) return false;
    const t = this.save.tracks[track];
    if (t) return t.done;
    /*
     * 2026-09-15: for someone coming back **having just run the raid to the end** (`pendingShip`) the ship track is
     * 「not started yet」, not 「never existed」. `looksFresh()` is already false by then (Lv.2 from the raid reward), so
     * left alone another `hub:entered` subscriber (`meta/parts/NpcQuests` — it holds Raven's first contact back until
     * after the ship track) reads this track as over; whether it runs before this system's `autoStart` is
     * registration order, so the answer is corrected here.
     */
    if (track === 'ship' && this.save.pendingShip) return false;
    return !this.looksFresh();
  }

  startTrack(track: TutorialTrack): boolean {
    if (this.active) return false;
    if (this.save.tracks[track]?.done) return false;
    this.save.tracks[track] = { step: null, done: false };
    this.resetControls();
    this.setStep(TUTORIAL_TRACK_STEPS[track][0]);
    return true;
  }

  skipTrack(track: TutorialTrack): void {
    if (this.save.tracks[track]?.done) return;
    if (this.track === track) {
      // Unlike the ship · build tracks, the raid track lives only inside the raid. Already in the ship, only the
      //   guidance turns off.
      const leaveRaid = track === 'raid' && this.inTutorialRaid();
      this.finish(true);
      if (leaveRaid) this.beginSkipFade();
      return;
    }
    this.save.tracks[track] = { step: null, done: true };
    this.persist();
  }

  /**
   * 2026-09-15 (the raid abandoned from the title, user's decision — 「from the beginning again」): wipes that track's
   * progress back to **not started**. It is not written down as over (`done: false`), so for the raid track the next
   * `게임 시작` opens the tutorial raid from the beginning (`ui/menus/enterShip.startTutorialRaid`). The character save
   * is untouched — only this track's step · objectives · control rows go.
   */
  restartTrack(track: TutorialTrack): void {
    if (this.track === track) { this.resetControls(); this.popup.close(); }
    this.save.tracks[track] = { step: null, done: false };
    if (track === 'raid') this.save.pendingShip = false;
    this.persist();
    this.refreshVisuals();
  }

  /** Is the player inside the tutorial raid right now. */
  private inTutorialRaid(): boolean {
    const ctx = this.ctx;
    return !!ctx && ctx.missionMode === 'tutorial' && ctx.isRaidActive();
  }

  /*
   * ── skipping the raid track = fade to black → the result screen (2026-09-15, user's decision) ────────
   * In the 2026-09-14 2nd pass the skip was `skipToLiftoff` (the body stood in the hold and lifted off at once). Now
   * the screen is **covered black** (`ui:screenFade {1, SKIP_FADE_OUT_S}` — drawn by `ui/HudSystem`, stepped in code,
   * so it fades under reduced motion too) and **the moment it is fully black** `ExtractionRef.skipToComplete` is
   * called: the same result screen · settlement · ship acquisition as a normal extraction, with no cutscene of the
   * ship leaving.
   *
   * **The black plate stays over the result screen too** (2026-09-15 2nd pass, user's decision — 「the extraction
   * success comes up on a black screen」). That is why `ui:screenFade` carries `hold: true`: without it
   * `HudSystem.applyVisibility` cleared the plate the moment the phase changed and **the planet showed again behind
   * the result window**. The result window is `.menu.complete` z 84, above the plate (82). The one place that clears
   * it is `clearSkipFade(0)` on `hub:entered`, with `game:abort` and `HudSystem`'s same subscription as spares — no
   * path leaves the ship black.
   *
   * While it is black a **scene lock** (`PlayerRef.setSceneLock`) is held — shot dead inside those 0.6 s, the result
   * screen would read 「미탈출」. player/'s reset paths (revive · ship return · `game:abort`) release it; only the death
   * fallback releases it here.
   *
   * The fallback ladder: `skipToComplete` → (missing or false) `skipToLiftoff` + light again (the liftoff cutscene
   * has to be seen) → (false as well — dead · downed) `game:returnToShip` (death where it stands). A skip means 「stop
   * here」, so a way out comes before being stranded on a planet with neither guidance nor a destination (the
   * 2026-09-14 2nd pass's reasoning unchanged).
   */

  /**
   * Raises the fade to black. With the player already riding the ship away there is nothing to do (that cutscene is
   * the result screen).
   */
  private beginSkipFade(): void {
    const ctx = this.ctx;
    if (this.skipFadeT > 0 || ctx.extraction?.riding) return;
    this.skipFadeT = Math.max(0.001, SKIP_FADE_OUT_S);
    this.skipFadeOwned = true;
    this.tip.clear();
    ctx.player?.setSceneLock?.(true);
    // `hold` = ui does not clear this plate even when the phase changes to the result screen (2026-09-15 —
    //   「extraction success while black」)
    ctx.bus.emit('ui:screenFade', { opacity: 1, durationS: SKIP_FADE_OUT_S, hold: true });
  }

  /**
   * The fade clock — on the frame it is fully black it calls the extraction once. Sim dt, so the same clock as the
   * black plate (`HudSystem`).
   */
  private updateSkipFade(dt: number): void {
    if (this.skipFadeT <= 0) return;
    this.skipFadeT = Math.max(0, this.skipFadeT - Math.max(0, dt));
    if (this.skipFadeT > 0) return;
    this.leaveTutorialRaid();
  }

  /** Fully black — it leaves the raid down the fallback ladder (the block above). */
  private leaveTutorialRaid(): void {
    const ctx = this.ctx;
    if (!this.inTutorialRaid()) { this.clearSkipFade(0); return; }
    const ext = ctx.extraction;
    if (ext?.skipToComplete?.()) return;                                  // the result screen — the plate stays
    if (ext?.skipToLiftoff?.()) { this.clearSkipFade(SKIP_FADE_IN_S); return; }   // the liftoff cutscene must show
    ctx.player?.setSceneLock?.(false);                                    // a lock left on prevents even dying
    this.clearSkipFade(0);
    ctx.bus.emit('game:returnToShip', {});
  }

  /** Clears the black plate this system raised (nothing happens if it did not — the opening fade is left alone). */
  private clearSkipFade(durationS: number): void {
    this.skipFadeT = 0;
    if (!this.skipFadeOwned) return;
    this.skipFadeOwned = false;
    this.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS });
  }

  /* ── step machine ──────────────────────────────────────────────────────── */

  /**
   * A new profile entered the personal ship for the first time → auto start. Already running, only the screen is
   * restored.
   */
  private onHubEntered(ship: string): void {
    /* 2026-09-17 (user's decision — the last raid is one attempt): entering the ship still on `raid` = that raid is
       over (abandoned · a reload · a path that missed the result-screen event). It is written down as over — unlike
       the raid track's `restartTrack` it is not replayed. */
    if (this.step === 'raid' && this.track === 'raid2') { this.finish(false); return; }
    if (ship !== 'personal') { this.refreshVisuals(); return; }
    // An already-crafted workbench · an already-open screen (reload recovery) — since 2026-09-17 it writes rows, not
    //   steps
    const track = this.track;
    if (track && BUILD_TRACKS.includes(track) && this.step) this.syncBuildObjectives(this.step);
    if (this.active) { this.refreshVisuals(); return; }
    // No save on its own does not make a "new character" — a profile played since before the tutorial existed
    //   looks the same. With the ship already decorated or the level raised, **every track** is silently marked
    //   done and never turns on again (`markAllDone` walks `TUTORIAL_TRACKS`, so a new track needs no edit here).
    if (!this.startedAny() && !this.looksFresh()) { this.markAllDone(); this.refreshVisuals(); return; }
    this.autoStart();
    this.refreshVisuals();
  }

  /** Does the save hold any start record at all (= this profile has seen the tutorial). */
  private startedAny(): boolean { return TUTORIAL_TRACKS.some((t) => this.save.tracks[t] !== undefined); }

  private markDone(track: TutorialTrack): void {
    this.save.tracks[track] = { step: null, done: true };
  }

  private markAllDone(): void {
    for (const t of TUTORIAL_TRACKS) this.markDone(t);
    this.save.pendingShip = false;
    this.save.pendingRaid2 = false;
    this.persist();
  }

  /**
   * **Following the tracks on** in the personal ship — raid → ship → build → raid2, in that order. Nothing happens
   * while one is already running.
   *
   * One line per track, and each line rests on a different reason (④ is spelled out at the branch itself, below).
   *   ① raid — **being inside the ship** by itself means that track is behind (run to the end, skipped, or an old
   *      path where the entry flow does not send anyone to the raid yet). So it is silently written down as over.
   *   ② ship — only **the one time the raid was just run to the end** (`pendingShip`). Otherwise someone who
   *      skipped the raid · someone at level 1 gets 「레벨이 올랐습니다」.
   *   ③ build — the rule from 2026-09-08 unchanged: only with **an untouched ship** (`shipUntouched`).
   *   ④ raid2 (2026-09-18) — only **the one time 「증축 안내」 was just run to the end** (`pendingRaid2`).
   */
  private autoStart(): void {
    this.autoStartOnClose = false;
    if (this.active) return;
    if (!this.save.tracks.raid?.done) this.markDone('raid');
    if (!this.save.tracks.ship?.done) {
      if (this.save.pendingShip) {
        this.save.pendingShip = false;
        if (this.startTrack('ship')) return;
      }
      this.markDone('ship');
    }
    if (!this.save.tracks.build?.done && !this.save.tracks.build?.step) {
      // It reads the **ship**, not the level — someone back from the raid is level 2 but the ship is still empty
      if (this.shipUntouched()) { this.startTrack('build'); return; }
      this.markDone('build');
    }
    /*
     * ④ launch (2026-09-18) — only **the one time 「증축 안내」 was just run to the end** (`pendingRaid2`, the same
     *    trick as `pendingShip`). Every save without that mark is 「someone already past it」: neither an old save
     *    (a profile that finished all 7 build steps) nor someone who skipped the build may newly see 「출격 안내」.
     *    So it is silently written down as over.
     */
    if (!this.save.tracks.raid2?.done && !this.save.tracks.raid2?.step) {
      if (this.save.pendingRaid2) {
        this.save.pendingRaid2 = false;
        if (this.startTrack('raid2')) return;
      }
      this.markDone('raid2');
    }
    this.persist();
  }

  /** The tutorial raid has started (`game:newMission {mode:'tutorial'}` · `world:ready`). */
  private startRaidTrack(): void {
    if (this.track === 'raid') return;
    if (this.save.tracks.raid?.done) return;
    // Any other open track is folded — in-ship guidance means nothing the moment the player leaves for a raid
    //   (it is not written down as over)
    for (const t of TUTORIAL_TRACKS) { const e = this.save.tracks[t]; if (e?.step) e.step = null; }
    this.hudState.staminaUsed = false;
    this.kills = 0;
    this.wakeHoldT = 0;
    this.crouchTipShown = false;
    this.corpseFocusOff = false;
    this.tip.clear();
    this.startTrack('raid');
    // The cutscene starts **on the next frame** (`consumePendingWake` — called now, a later handler of this
    //   emit wipes it)
    this.pendingWake = true;
  }

  /** Stamina has dropped at least once — the stamina bar appears at that moment. */
  private markStaminaUsed(): void {
    if (this.hudState.staminaUsed) return;
    this.hudState.staminaUsed = true;
    if (this.track === 'raid') this.emitChanged();   // makes the HUD widgets ask the gate again
  }

  /**
   * A checkpoint was passed (owner: `world/tutorial`). **The end of a stretch = the end of that stretch's step**,
   * so a current step before that checkpoint folds all the way there in one go — walking past the optional step
   * (`grenade`) unused never blocks.
   */
  private onCheckpoint(id: string): void {
    const target = CHECKPOINT_STEP[id];
    if (target) this.foldRaid(this.healSafeFold(target));
  }

  /**
   * 2026-09-16 (a bug — 「the grenade step came up without the bandage being used」): a checkpoint **never skips a
   * hurt player's healing stretch.** Walking past the supply corpse and touching `wall` had `CHECKPOINT_STEP.wall`
   * (= `grenade`) fold `supplyLoot` · `heal` away entirely. Now, when the fold target is **past** `heal`, the
   * current step is at or before `heal` and HP is not full, it folds only that far — to `supplyLoot` when before
   * it, staying put when already on `supplyLoot` · `heal`. At full HP it passes as before (`heal` at full HP is a
   * silently passed step — `setStep`). **The extraction switch's fold (`extraction:*` → `foldRaid('extract')`)
   * does not take this rule** — the raid is ending, so there is nothing to block, and it is also what closes the
   * path where someone who lost the bandage is stuck.
   * (Cause A — the shield eating the fall damage so `heal` passed silently at full HP — was fixed by player/: a
   * fall bypasses the shield.)
   */
  private healSafeFold(target: TutorialStepId): TutorialStepId {
    if (this.track !== 'raid' || this.healthFull()) return target;
    const order = TUTORIAL_TRACK_STEPS.raid;
    const cur = this.step;
    const i = cur ? order.indexOf(cur) : -1;
    const heal = order.indexOf('heal'), supply = order.indexOf('supplyLoot');
    if (i < 0 || heal < 0 || supply < 0 || i > heal || order.indexOf(target) <= heal) return target;
    return i < supply ? 'supplyLoot' : cur!;
  }

  /**
   * Folds the raid track **forward only** to that step (the checkpoints · the extraction switch share it).
   * 2026-09-14 2nd pass — `grenade` became an optional step and so no longer ends on its own signal (its required
   * objective is 「walk on past the wall」), so the extraction switch folds down this path too. Missing one
   * checkpoint never blocks the guidance.
   */
  private foldRaid(target: TutorialStepId): void {
    if (this.track !== 'raid') return;
    const order = TUTORIAL_TRACK_STEPS.raid;
    const cur = this.step;
    if (!cur) return;
    const i = order.indexOf(cur), want = order.indexOf(target);
    if (i < 0 || want < 0 || want <= i) return;
    this.setStep(target);
  }

  /**
   * An enemy was killed — `shoot` advances on two, `crouchAim` on two (the checkpoint is the insurance).
   *
   * 2026-09-14 4th pass — with `grenade`'s optional objective changed from 「a kill」 to 「pull one and throw it」,
   * the **last-hit-kind check** that was read here **is gone** (one `grenade:exploded` line writes that objective).
   */
  private onKill(): void {
    const step = this.step;
    if (this.track !== 'raid') return;
    if (step !== 'shoot' && step !== 'crouchAim') return;
    this.kills++;
    // 2026-09-15 2nd pass: the `(n/m)` after an objective row swaps **only that number node** — the last one too
    //   reads `(2/2)` before the check · the strike-through is drawn (the row stands there while the panel holds
    //   it half a beat).
    this.panel.setCounts(this.objectiveCounts());
    if (this.kills >= RAID_KILLS_PER_STEP) this.advance();
  }

  /**
   * The **progress count** of an objective row (a row with `TutorialObjective.count`, 2026-09-15 2nd pass). The
   * only thing counted now is kills, and the row ids are not written in code but read from that step's table —
   * the target (`count`) comes from `RAID_KILLS_PER_STEP` too.
   */
  private objectiveCounts(): Readonly<Record<string, number>> {
    const step = this.step;
    if (step !== 'shoot' && step !== 'crouchAim' && step !== 'raid') return EMPTY_COUNTS;
    // 2026-09-17: 「출격 안내」's raid counts the loot value carried, not the kills
    const at = step === 'raid' ? this.raidValue : this.kills;
    const out: Record<string, number> = {};
    for (const o of this.objectivesFor(stepDef(step))) {
      if (o.count !== undefined) out[o.id] = Math.min(at, o.count);
    }
    return out;
  }

  /**
   * An enemy erupted (the tutorial bug's burrow spawn). On `advance1` it simply advances to `shoot`, and meeting
   * the bug **having walked straight past the corpse** (still on `corpseOpen` · `corpseLoot`) folds forward to
   * `shoot` (2026-09-15, user's decision — the corpse stretch is skippable too. 2026-09-15 2nd pass: someone who
   * walked past **without even opening it** (`corpseOpen`) takes the same path — a new step must not create a
   * dead end).
   * Why it is narrowed to those three steps: the tutorial's other enemies (the androids) already stand there when
   * the world is built, so `enemy:spawned` in these steps is the ambush bug alone. A spawn in a later step folds
   * nothing.
   */
  private onEnemySpawned(): void {
    if (this.track !== 'raid') return;
    if (this.step === 'advance1') { this.advance(); return; }
    if (this.step === 'corpseOpen' || this.step === 'corpseLoot') this.foldRaid('shoot');
  }

  /**
   * A quick-use item was taken in hand / the gun came back (2026-09-16). A healing item writes `heal`'s first
   * row, and either way `heal`'s control guide is redrawn — `길게 눌러 사용` only stands while the bandage is in
   * hand (a gun · a grenade drops it).
   */
  private onQuickEquipped(item: ItemInstance | null): void {
    this.handStim = this.isStim(item);
    if (this.handStim) this.markIf('heal', 'healHold');
    if (this.step === 'heal') this.applyControls('heal');
  }

  /**
   * Is the collapsed passage of the crawl stretch about half behind (2026-09-16, user's decision) — past it,
   * fire · aim down sights join the control guide under crouch · prone. The passage's coordinates belong to the
   * world alone (`TutorialWorldRef.crawlProgress`); this folder knows only the fraction
   * (`TUTORIAL_CRAWL_AIM_HINT_FRAC`).
   */
  private pollCrawlHint(): void {
    if (this.crawlHalf) return;
    const step = this.step;
    if (step !== 'crouch' && step !== 'crouchAim') return;
    const p = this.ctx.player;
    const progress = p ? this.ctx.world?.tutorial?.crawlProgress?.(p.position) : undefined;
    if (progress === undefined || progress < TUTORIAL_CRAWL_AIM_HINT_FRAC) return;
    this.crawlHalf = true;
    this.applyControls(step);
  }

  /**
   * The crouched-aim TIP (2026-09-15, user's decision) — shown once under the control guide **the first time**
   * the player aims down sights crouched or prone in the crawl · crouched-aim stretch (`CROUCH_TIP_STEPS`). Both
   * the aim event and the stance event call it (whichever is last catches it).
   * @param aiming when `player:aimChanged` calls, that value is trusted (the ref's `isAiming` may not have
   *               changed yet in the same frame).
   */
  private maybeCrouchTip(aiming?: boolean): void {
    if (this.crouchTipShown || this.track !== 'raid') return;
    const step = this.step;
    if (!step || !CROUCH_TIP_STEPS.includes(step)) return;
    const p = this.ctx.player;
    if (!p || p.stance === 'stand' || !(aiming ?? p.isAiming)) return;
    this.crouchTipShown = true;
    this.tip.show(CROUCH_AIM_TIP_KO);
  }

  /**
   * Is the ship untouched. No room purpose · no placed furniture · level 1 is taken for a new character (nothing
   * but the starter grant). One of them off, and it is a profile already being played.
   *
   * ⚠ **The level condition is used only to tell apart 「a profile with no save at all」** (2026-09-14). The build
   * track's start condition is `shipUntouched()` — someone back from the tutorial raid is already level 2 but the
   * ship is still an empty ship, and that is exactly the person 「증축 안내」 is for.
   */
  private looksFresh(): boolean {
    return this.shipUntouched() && (this.ctx.progression?.level ?? 1) <= 1;
  }

  /** A ship with nothing placed and no room built out (= the build track still has something to do). */
  private shipUntouched(): boolean {
    const h = this.ctx.housing;
    if (h) {
      try {
        // 2026-09-12: the cockpit's default shared furniture (`시술대` · `컴퓨터`) always stands in every ship —
        //   that alone is not 「a decorated ship」
        // 2026-09-13: the cockpit decor furniture (bunk · locker · dresser — `COCKPIT_DECOR_FURNITURE`) also
        //   stands in a new ship from the start
        if (h.getPlaced().some((f) => !COCKPIT_DEFAULT_FURNITURE.some((d) => d.defId === f.defId)
          && !(f.room === COCKPIT_ROOM_INDEX && COCKPIT_DECOR_FURNITURE.some((d) => d.defId === f.defId)))) return false;
        for (let i = 0; i < SHIP_ROOM_COUNT; i++) if (h.getRoom(i).purpose !== 'empty') return false;
      } catch { /* housing not ready — unknown yet: taken as untouched (the level condition filters old saves) */ }
    }
    return true;
  }

  /**
   * Housing mode (the M screen · a room console) opened or closed. The open advances `manage`, the close
   * `manageDone` (back in the order on 2026-09-15). Either way the screen is redrawn — **the floor guide is not
   * drawn while management mode is open** (`refreshVisuals` → `housingOpen`): a pillar · dashes laid under the
   * management camera pointed at a place that cannot be walked to.
   */
  private onManage(active: boolean): void {
    // 2026-09-17: opening is `manage`'s first row, closing is the last row of `bench` after placing (the old
    //   `manageDone`) — that is the end of that step
    if (active) this.markIf('manage', 'manageOpen');
    else if (this.step === 'bench' && this.done.has('benchDown')) { this.advance(); return; }
    this.refreshVisuals();
  }

  /**
   * Is housing mode (M's ship management · the room console's room edit) open — `ctx.housing` is read **right
   * now** (events are not counted: the answer has to be right after a reload too). With no housing yet it counts
   * as closed.
   */
  private housingOpen(): boolean {
    const h = this.ctx.housing;
    try { return !!h && ((h.shipManageMode ?? false) || (h.housingMode ?? false)); } catch { return false; }
  }

  private onPurpose(room: number, purpose: string): void {
    if (purpose !== TUTORIAL_ROOM_PURPOSE) return;
    this.save.room = room;
    // 2026-09-17: building the workshop out is the end of `manage` (ship management → workshop) — the rows
    //   before it are drawn along by `completeRequired`
    this.advanceIf('manage');
  }

  /** Is the generator already at Lv.1 or above — whether the `generator` step still has something to do. */
  private generatorReady(): boolean {
    try { return (this.ctx.housing?.getFacility('generator').level ?? 0) >= 1; } catch { return false; }
  }

  /** Has the gun workbench reached the furniture storage — `bench` (the craft) ends here, placing follows. */
  private onFurnitureCrafted(): void {
    if (this.step !== 'bench' || !this.benchStored()) return;
    this.markObjective('benchCrafted');   // 2026-09-17: the next row of the same step (furniture storage tab) opens
  }

  private benchStored(): boolean {
    try {
      for (const s of this.ctx.housing?.getStored() ?? []) if (s.defId === TUTORIAL_BENCH_DEF && s.qty > 0) return true;
    } catch { /* housing not ready */ }
    return false;
  }

  /**
   * The furniture to place was picked up (= it is held on the cursor). While it is, **the spotlight folds** —
   * with the dim plates covering the whole screen the very floor it has to be dropped on cannot be clicked
   * (the 2026-09-08 cannot-progress bug).
   */
  private onSelection(defId: string | null): void {
    const armed = defId === TUTORIAL_BENCH_DEF;
    if (armed === this.benchArmed) return;
    this.benchArmed = armed;
    if (this.step !== 'bench') return;
    if (armed) this.markObjective('benchStore');   // picked from storage = the storage tab was reached (2026-09-17)
    this.refreshVisuals();
  }

  /**
   * The stance changed. The crouch · prone rows **change their label with the current stance** (2026-09-14 3rd
   * pass, user's decision) — someone already crouched is not told 「앉기」. What advances the step is unchanged.
   *
   * 2026-09-15 — the 「the label does not change」 fix. The old code redrew only on `step === 'crouch'`, but
   * `crouch` moves to `crouchAim` **the instant the player crouches**, so both rows stayed frozen on the first
   * stance's label for the whole crawl stretch. The condition is now not the step but **「is there a crouch ·
   * prone row among the rows up right now」** (`STANCE_HINT_IDS`), and an event arriving twice with the same
   * stance is not thrown away either (when a revive · a resume put the stance back to standing with no event,
   * `this.stance` stayed wrong and swallowed the next event).
   */
  private onStance(stance: Stance): void {
    const changed = stance !== this.stance;
    this.stance = stance;
    const step = this.step;
    if (step && this.controlIds.some((id) => STANCE_HINT_IDS.includes(id))) this.applyControls(step, true);
    if (changed && stance !== 'stand') this.advanceIf('crouch');
    if (stance !== 'stand') this.maybeCrouchTip();
  }

  private onFurniture(defId: string, uid: string): void {
    if (defId !== TUTORIAL_BENCH_DEF) return;
    this.save.benchUid = uid;
    this.benchInteractable = `hub_furn_${uid}`;
    this.benchArmed = false;
    if (this.step !== 'bench') return;
    // 2026-09-17: the 「가구 배치」 row (with the chain before it). With housing mode already closed the last row
    //   has nothing to do — `pollBuild` advances it
    this.markObjective('benchDown');
  }

  /**
   * The bag window opened. It writes `equipGun`'s 「{INVENTORY} 인벤토리 열기」 row and asks once more whether the whole
   * step is moot (an assault rifle already equipped · both primary slots full). 2026-09-17: the old `openBag` step —
   * 「open the bag with no craft column up」 — became `craftGun`'s last row 「제작창 닫기」, watched by `onCraftPanel` ·
   * `pollBuild`, so nothing here reads `craftOpen` any more.
   */
  private onInventoryOpened(): void {
    // 2026-09-18 (user report — 「it still says to equip although it is equipped」): whether anything is left is
    //   asked again **at the moment the window opens** too
    if (this.equipGunSkipIfMoot()) return;
    this.markIf('equipGun', 'equipOpen');
  }

  /**
   * The bag window closed. **`corpseLoot` ends here** (2026-09-14 3rd pass, user's decision) — the moment the
   * window is closed after the gun is equipped. Closing without the gun stays on that step (its required
   * objective is still empty). So the HUD reveal (`HUD_GEAR_STEP`) keeps its meaning: **past** this step the
   * HP · weapon HUD is visible.
   */
  private onInventoryClosed(): void {
    const step = this.step;
    if (step === 'corpseLoot') {
      if (this.done.has('corpseGun')) { this.advance(); return; }
      /*
       * 2026-09-15 (user's decision) — **closed straight away** without the gun: the focus is released. Left on,
       * the ring would follow the equipment slots every time the inventory opens after that. An empty required
       * objective is no dead end either — walking on, the `bugs` checkpoint · the bug spawn fold forward
       * (`foldRaid`). Opening the corpse again brings the focus back (`onContainerOpened`).
       */
      if (!this.corpseFocusOff) { this.corpseFocusOff = true; this.refreshVisuals(); }
      return;
    }
    // 2026-09-15: the supply corpse — closing the window once the bandage is held gives the healing step
    if (step === 'supplyLoot' && this.done.has('supplyBandage')) this.advance();
    /* 2026-09-18: 「is there nothing left to do」 is asked once **at the close** too — someone who equipped an
       assault rifle other than the crafted one (a different grade · family) inside the window never lights
       `equipSlot` and is stuck there. The close is exactly the place 2026-09-17 decided 「it may advance」, so this
       one line does not collide with that decision (it passes silently, so no check is drawn on a row not done). */
    if (step === 'equipGun' && !this.done.has('equipSlot') && this.equipGunSkipIfMoot()) return;
    // 2026-09-17 (user's decision): the build track — **closing the inventory** after the rifle is equipped gives
    //   the cockpit step (in between it waits with no objective row)
    if (step === 'equipGun' && this.done.has('equipSlot')) this.advance();
    // 2026-09-16 2nd pass: the ship track ended where it was confirmed — the deferred next track (build) opens
    //   now that the menu is closed (`finish`)
    if (this.autoStartOnClose) {
      this.autoStartOnClose = false;
      if (this.ctx.isHubPhase()) this.autoStart();
      else this.persist();
    }
  }

  /**
   * The stat point investment was confirmed (`progress:statChanged`, 2026-09-16). `stats` became the **last**
   * step of the ship track (`messenger` left the order). Advancing right there would have `finish` → `autoStart`
   * open the build track at once, so the intro card comes up over someone still looking at the character screen
   * (and the build track's `screenTab` · `stashItem` gates hide the tabs · stash items they were reading). So it
   * is the same trick as `corpseLoot`: only the check is drawn on the objective, and it advances **when the
   * inventory screen closes** (`onInventoryClosed`). Confirmed while closed (the console · another path) it
   * advances at once, and if the close was missed (a reload) `poll` advances it in the ship. While it waits the
   * track is still `active`, so Raven's first contact stays blocked (`meta/parts/NpcQuests.tutorialBlocks`).
   */
  private onStatsConfirmed(): void {
    if (this.step !== 'stats') return;
    /* 2026-09-16 2nd pass: `progress:statChanged` arrives when stat XP raises a point too — only a confirm that
     * had ＋ in the sheet counts (the sheet announces the total just before the confirm through
     * `progress:statPending`, then announces 0 **after** the investment — `SheetBody.commitPending`). */
    if (this.statPending <= 0) return;
    this.markObjective('statsSpent');
    // 2026-09-16 2nd pass (user's decision): the focus lifts and the track ends **right where** it is confirmed.
    //   The build track opens when the menu closes (`finish`)
    this.advance();
  }

  /** The sheet's pre-confirm ＋ total changed (`progress:statPending`). 0 → n is 「a stat raised」. */
  private onStatPending(total: number): void {
    this.statPending = Math.max(0, total);
    if (this.step !== 'stats') return;
    if (this.statPending > 0) this.markObjective('statsRaise');
    this.pollStats();
  }

  /**
   * Reads `stats`'s screen state (2026-09-16 2nd pass). The two that have no event — is the menu open · is it the
   * character tab — write their objectives here, and when the focus has to change (tabs switched · a ＋ taken
   * back) the screen is redrawn. Switching only the tab with the inventory window already open sends no
   * `inventory:opened`, so the screen tab is read along with it.
   */
  private pollStats(): void {
    const inv = this.ctx.inventory;
    const tab = inv?.screenTab ?? 'inventory';
    const open = !!inv?.isOpen || tab !== 'inventory';
    if (open && !this.done.has('statsMenu')) this.markObjective('statsMenu');
    if (tab === 'character' && !this.done.has('statsTab')) this.markObjective('statsTab');
    const key = this.statsFocus();
    if (key !== this.statsFocusKey) { this.statsFocusKey = key; this.refreshVisuals(); }
  }

  /** `stats`'s focus: 0 none (menu closed · confirmed) · 1 the character tab · 2 the stat ＋ · 3 the confirm. */
  private statsFocus(): number {
    if (this.done.has('statsSpent')) return 0;
    const inv = this.ctx.inventory;
    const tab = inv?.screenTab ?? 'inventory';
    if (!inv?.isOpen && tab === 'inventory') return 0;
    if (tab !== 'character') return 1;
    return this.statPending > 0 ? 3 : 2;
  }

  /** The liftoff cinematic started / ended (see the `cinematic` comment). */
  private onCinematic(active: boolean): void {
    if (active === this.cinematic) return;
    this.cinematic = active;
    if (active) this.tip.clear();
    this.refreshVisuals();
  }

  /**
   * A container window opened (corpses · crates alike — all that can be opened on the tutorial map is the three
   * hand-placed corpses).
   *   • `corpseOpen` (2026-09-15 2nd pass) — **the corpse's bag opening** is the end of that step. To tell it from
   *     other containers the id prefix `corpse:` is read (the prefix `world/tutorial/parts/Corpses` attaches).
   *   • `corpseLoot` (2026-09-15) — opening the corpse again brings back the focus released by closing with no gun.
   */
  private onContainerOpened(containerId: string): void {
    if (!containerId.startsWith('corpse:')) return;
    // Drawing the check on a required objective is `advance`'s `completeRequired` (nothing is written here)
    if (this.step === 'corpseOpen') { this.advance(); return; }
    if (this.step !== 'corpseLoot' || !this.corpseFocusOff) return;
    this.corpseFocusOff = false;
    this.refreshVisuals();
  }

  /**
   * The craft column opened or closed (both the bench path and the bag button path).
   *
   * Two of `craftGun`'s objective rows hang here (2026-09-14 3rd pass; regrouped 2026-09-17): 「총기 작업대 작동」 (the
   * open) and the step's last row 「제작창 닫기」 (the close — only then do the equipment slots come back, which is why
   * the old `openBag` step was folded into it). The `equipGun` spotlight splits on this state too.
   */
  private onCraftPanel(open: boolean): void {
    const changed = open !== this.craftOpen;
    this.craftOpen = open;
    // 2026-09-17: the open is 「총기 작업대 작동」; closing after the ammo is made too is the end of `craftGun`
    //   (「제작창 닫기」)
    if (open) { this.markIf('craftGun', 'craftGunOpen'); return; }
    if (this.step === 'craftGun' && this.done.has('craftAmmoMade')) { this.advance(); return; }
    if (changed && this.step === 'equipGun') this.refreshVisuals();   // focus: close button ↔ equipment + stash
  }

  private onCrafted(recipeId: string): void {
    if (this.step !== 'craftGun') return;
    if (recipeId === TUTORIAL_GUN_RECIPE) {
      this.markObjective('craftGunMade');
      // The ammo's materials are topped up **now**, reading what the rifle left behind (the same place as the
      //   old `craftAmmo` entry — the same window is still open)
      this.ensureMaterials(TUTORIAL_AMMO_RECIPE, 'craftGun');
    } else if (recipeId === TUTORIAL_AMMO_RECIPE && this.done.has('craftGunMade')) {
      this.markObjective('craftAmmoMade');
    }
  }

  /**
   * The loadout changed.
   *   • `equipGun` (the build track) — done as soon as the crafted rifle lands in 주무기 I or II.
   *   • `corpseLoot` (the raid track, 2026-09-14 2nd pass) — **any primary weapon** in hand marks that objective
   *     (the tutorial raid starts empty-handed, so that gun can only have come out of the corpse — the def id is
   *     `world/tutorial`'s to decide, so it is unknown here).
   *     ⚠ 2026-09-14 3rd pass (user's decision): it **does not advance** right there — the objective would change
   *     behind the back of someone still looking at the inventory screen. The next step is **when the bag closes**
   *     (`onInventoryClosed`). The bag is an **optional** objective of the same step, so only the check is drawn.
   */
  private onLoadout(): void {
    const l = this.ctx.inventory?.getLoadout();
    if (!l) return;
    if (this.step === 'corpseLoot') {
      if (l.bag) this.markObjective('corpseBag');
      if (l.primary || l.primary2) this.markObjective('corpseGun');
      return;
    }
    if (this.step !== 'equipGun') return;
    if (l.primary?.defId !== TUTORIAL_GUN_DEF && l.primary2?.defId !== TUTORIAL_GUN_DEF) return;
    // 2026-09-17 (user's decision): only the check is drawn and it advances **when the inventory closes**
    //   (`onInventoryClosed`). Equipped while the window is closed (the console), it advances at once.
    this.markObjective('equipSlot');
    if (!(this.ctx.inventory?.isOpen ?? false)) this.advance();
  }

  /**
   * Has the medium-heavy ammo reached the bag (+ the raid track's 「loot · pick up」 objectives — ammo · bandage ·
   * grenade).
   */
  private onInventory(): void {
    const inv = this.ctx.inventory;
    if (!inv) return;
    if (this.step === 'corpseLoot') {
      // 2026-09-14 4th pass: healing (`corpseStim`) left the objectives — that corpse holds no healing item
      try { if (inv.countWhere((d) => d.category === 'ammo') > 0) this.markObjective('corpseAmmo'); }
      catch { /* inventory not ready */ }
      return;
    }
    if (this.step === 'supplyLoot') {
      /*
       * 2026-09-15 — 「시체에서 붕대 획득」 · 「(선택) 시체에서 수류탄 획득」. The tutorial raid starts empty-handed and
       * the first corpse holds neither a healing item nor a grenade, so 「it is carried」 means 「it came out of
       * that corpse」. `countWhere` reads the quick slots too, so one auto-registered into the wheel on pickup
       * counts just the same. (The old `heal`'s `healGrenade` moved here.)
       */
      try {
        if (inv.countWhere((d) => d.category === 'stim') > 0) this.markObjective('supplyBandage');
        if (inv.countWhere((d) => d.grenade !== undefined) > 0) this.markObjective('supplyGrenade');
      } catch { /* inventory not ready */ }
      return;
    }
    // (2026-09-17: the `stowAmmo` step — the medium-heavy ammo into the bag — is gone)
  }

  /**
   * The world is built. **In a tutorial raid** it turns the raid track on (coming back from a reload passes here
   * too). In any other raid it is as before — the build track's last step (`raid`) points at the extraction spot
   * once and ends.
   */
  private onRaid(): void {
    if (this.ctx.missionMode === 'tutorial') {
      this.startRaidTrack();
      // Coming back on `wake` after a reload — `startRaidTrack` returns straight away while the track already
      //   runs, so the booking is set once more here. With no cutscene the black screen merely lifts and the
      //   player stands there with no guidance up.
      if (this.step === 'wake') this.pendingWake = true;
      this.refreshVisuals();
      return;
    }
    // 2026-09-18: that raid is the last step of 「출격 안내」 (`raid2`) — 「증축 안내」 ends inside the ship
    if (!this.active || this.track !== 'raid2') return;
    // The training range is not a raid (its button is hidden during this track, but the console · squad-join
    //   paths remain)
    if (this.ctx.isTraining()) return;
    /* 2026-09-17 (user's decision): it used to end 6 s later with a 「튜토리얼 종료」 toast. Now this raid is the
       last step (`raid` — extract carrying loot), and it ends when the raid ends (`onBuildRaidEnd` ·
       `onHubEntered`). */
    if (this.step !== 'raid') this.setStep('raid');
    else this.refreshVisuals();
  }

  /* ── objective rows (2026-09-14 2nd pass) ───────────────────────────────
   * The objective panel became a checkbox list. **Every required objective is marked the moment the step
   * advances** (that is what the step ending means), and **optional objectives are lit one by one** through
   * `markObjective` here. So the marking animation shows, the panel holds the next step's objective rows half a
   * beat (`TUTORIAL_STEP_DELAY_S`) — the step machine does not wait. */

  /**
   * Marks one objective done (idempotent). An objective outside the current step is recorded anyway — it lights
   * when it is drawn.
   *
   * 2026-09-14 3rd pass — **the sequential-reveal chain before it is written too** (`objectiveChain`). For someone
   * who did a later row first (pulling the bandage out with Tab instead of opening the wheel), a row before it
   * that never lights hides everything after it. The panel is told first (`markDone`) so the check animation
   * shows, and the newly opened rows are drawn half a beat later.
   */
  markObjective(id: string): void {
    const step = this.step;
    const ids = step ? objectiveChain(this.objectivesFor(stepDef(step)), id) : [id];
    const fresh = ids.filter((x) => !this.done.has(x));
    if (fresh.length === 0) return;
    for (const x of fresh) this.done.add(x);
    this.save.objectives = [...this.done];
    this.persist();
    this.panel.markDone(fresh);
    this.refreshVisuals();
  }

  /** Writes the objective only in that step — events arrive regardless of the step (`quick:*` comes any time). */
  private markIf(step: TutorialStepId, id: string): void {
    if (this.step === step) this.markObjective(id);
  }

  /** Is it a healing item (the `heal` step's objective check). With the def unknown, false. */
  private isStim(item: ItemInstance | null | undefined): boolean {
    if (!item) return false;
    try { return this.ctx.inventory?.getDef(item.defId)?.category === 'stim'; } catch { return false; }
  }

  /**
   * The current step's objective rows. The only row list that differs from the table is `manage`'s (`manageNoGen`);
   * swapping the **wording · focus** of a row is `stepView`'s job, called from `refreshVisuals`.
   */
  private objectivesFor(def: StepDef): readonly TutorialObjective[] {
    /* 2026-09-17: the 「발전기 가동」 row only stands in a ship whose generator is still Lv.0 — a new ship is Lv.1
       from the start (the old `generator` step's silent pass). With that row gone, the `reveal` of 「작업실 증축」
       takes 「시설 관리 열기」 as the row before it. */
    if (def.id === 'manage' && this.generatorReady()) return this.manageNoGen(def);
    return objectivesOf(def);
  }

  /**
   * `manage`'s objective rows without the generator row — built once (the panel decides from the id list whether
   * to rebuild them).
   */
  private manageNoGenCache: readonly TutorialObjective[] | null = null;
  private manageNoGen(def: StepDef): readonly TutorialObjective[] {
    return this.manageNoGenCache ??= objectivesOf(def).filter((o) => o.id !== 'generatorOn');
  }

  /** Writes every **required** objective of this step as done and lets the panel take the time to animate it. */
  private completeRequired(step: TutorialStepId): void {
    const ids: string[] = [];
    for (const o of this.objectivesFor(stepDef(step))) {
      if (o.optional) { if (this.done.has(o.id)) ids.push(o.id); continue; }
      this.done.add(o.id);
      ids.push(o.id);
    }
    this.panel.markDone(ids);
  }

  private advanceIf(step: TutorialStepId): void {
    if (this.step === step) this.advance();
  }

  /**
   * @param silent a silently passed step (a generator already running · a workbench already crafted · `heal` at
   *               full HP) marks nothing done — a check drawn on something never done, with the half-beat pause,
   *               would read wrong.
   */
  private advance(silent = false): void {
    const cur = this.step;
    if (!cur) return;
    if (!silent) this.completeRequired(cur);
    const next = nextStep(cur);
    if (!next) { this.finish(false); return; }
    if (!silent) this.ctx.bus.emit('audio:play', { id: 'ui_equip' });
    this.setStep(next);
  }

  private setStep(step: TutorialStepId): void {
    const prev = this.step;                       // read **before** it changes, without fail (`quiet`'s basis)
    const track = trackOf(step);
    const entry = this.save.tracks[track] ?? (this.save.tracks[track] = { step: null, done: false });
    const changed = entry.step !== step;
    entry.step = step;
    entry.done = false;
    // The intro wake has just been left — the objective panel · the control guide appear a beat later (or the
    //   moment 1 m has been moved)
    if (prev === 'wake' && step !== 'wake') this.beginWakeReveal();
    // The kill count · the objectives done are counted per step (`shoot` → `crouchAim`)
    this.kills = 0;
    if (changed) { this.done.clear(); this.save.objectives = []; this.corpseFocusOff = false; }
    // Left the crawl stretch — entering it again, fire · aim down sights join at the halfway point once more
    if (step !== 'crouch' && step !== 'crouchAim') this.crawlHalf = false;
    // Swaps the right-side control guide for **this step's rows** (2026-09-14 3rd pass — a step absent from the
    //   table keeps the previous rows)
    this.applyControls(step);
    // Materials: the floor (once) + a top-up of what the rifle recipe is short of (idempotent). The ammo's
    //   materials are filled the moment the rifle is finished (`onCrafted`, 2026-09-17 — the `craftAmmo` step
    //   became a row of `craftGun`). A save that already made the ammo too (the old `craftAmmo` · `openBag`) has
    //   nothing left to fill here.
    if (step === 'craftGun') {
      this.grantMaterials();
      this.ensureMaterials(this.done.has('craftGunMade') ? TUTORIAL_AMMO_RECIPE : TUTORIAL_GUN_RECIPE, step);
    }
    // 「출격 안내」's raid (2026-09-17) — the value is counted from zero again and the control guide starts unfolded
    if (step === 'raid' && changed) {
      this.raidValue = 0; this.raidValueTick = 0; this.liftoffValue = -1;
      this.controlsFolded = false; this.controls.setFolded(false, CONTROLS_FOLDED_TEXT);
    }
    this.persist();
    this.refreshVisuals();
    this.emitChanged();
    if (step === 'intro') this.showIntro();
    /* 2026-09-17: the build track's 「silent pass」 (`generator` · a `bench` already crafted · a `manageDone`
       already closed) became a matter of **objective rows**, not steps — the generator row drops out of the list
       (`objectivesFor`) and the rest are watched by `onStepEntered` · `pollBuild`. */
    // 2026-09-14 2nd pass (user's decision): at full HP the healing step has nothing to do — as with `generator`
    else if (step === 'heal' && this.healthFull()) this.advance(true);
    // 2026-09-17 (user's decision): an AR is already held or 주무기 I · II are both full — the equip step is
    //   skipped and the cockpit follows at once
    else if (step === 'equipGun' && this.equipGunMoot()) this.advance(true);
    else this.onStepEntered(step);
  }

  /**
   * The step was **actually entered** (a silently passed step never reaches here). Objectives already done are
   * written right there so the next row opens at once — their events are past and never come again.
   */
  private onStepEntered(step: TutorialStepId): void {
    // Someone who picked the supplies up first and only then entered the step (2026-09-15) — the bandage · the
    //   grenade are done already, and with the window closed the healing step follows at once
    if (step === 'supplyLoot') {
      this.onInventory();
      if (this.done.has('supplyBandage') && !this.invOpen) this.advance();
      return;
    }
    this.syncBuildObjectives(step);
  }

  /**
   * The build track — writes **the rows already done** (2026-09-17). Called on entering a step and on entering
   * the ship (reload recovery). These are the ones whose event is past and never comes again: management mode
   * already open · a workbench already crafted · an inventory already open · a pod already boarded.
   */
  private syncBuildObjectives(step: TutorialStepId): void {
    if (step === 'manage' && this.housingOpen()) this.markObjective('manageOpen');
    else if (step === 'bench' && this.benchStored()) this.markObjective('benchCrafted');
    /*
     * 2026-09-17 (a bug — 「the bench was closed and `인벤토리 열기` is already checked」): `equipGun`'s
     * 「인벤토리 열기」 is not written here. `craftGun` ends on the `ui:craftToggled {open:false}` that the bench
     * window's close (`inventory/parts/Crafting.closeCraftWindow` → `closeAll`) emits **while the window is
     * closing**, and at that moment `InventoryRef.isOpen` is still true (`closeAll` calls `setOpen(false)` after
     * `closeBench`). So reading `isOpen` right where the step is entered counted a closing bench window as 「an
     * open inventory」. That row is written only by `inventory:opened` (`onInventoryOpened`) and by `pollBuild`
     * **on the next frame** — by then the close is over and the state is the real one (a bench picked inside the
     * Tab window, where only the craft column folds and the window stays, really is open and is written as such).
     */
  }

  /**
   * Is there nothing left to do in `equipGun` (2026-09-17, user's decision) — asked once **at the moment the
   * step is entered** (reload recovery does not ask again).
   *   ① 주무기 I or II already holds the assault-rifle family (`TUTORIAL_GUN_FAMILY`, any grade · uniques excluded).
   *   ② 주무기 I · II are both full — with no empty slot for the crafted rifle, nobody is held back to swap one out.
   * With the loadout unknown (no inventory yet) it is false — the step is shown as usual.
   *
   * 2026-09-18 (user report — 「the rifle was made and Tab pressed, and 「돌격소총을 주무기 칸에 장착」 is still there
   * although it is equipped」): once on entry was not enough. At the moment the step is entered the bench window
   * is **closing**, so there are frames where the loadout cannot be read, and some people equip it straight from
   * the craft window in between. So it is asked again **the moment the inventory opens** (`equipGunSkipIfMoot`).
   */
  private equipGunMoot(): boolean {
    const inv = this.ctx.inventory;
    if (!inv) return false;
    let l;
    try { l = inv.getLoadout(); } catch { return false; }
    if (l.primary && l.primary2) return true;
    return this.isAssaultRifle(l.primary) || this.isAssaultRifle(l.primary2);
  }

  /**
   * On `equipGun` with nothing left to do, it ends that step **whole** (2026-09-18, user's decision — the step,
   * not one objective row). It is `advance(true)`, so no check is drawn on something never done, and being
   * 「증축 안내」's last step the track ends there and 「출격 안내」 follows (`finish` → `autoStart`).
   * @returns true when it ended (the caller returns right there).
   */
  private equipGunSkipIfMoot(): boolean {
    if (this.step !== 'equipGun' || !this.equipGunMoot()) return false;
    this.advance(true);
    return true;
  }

  /**
   * Is it an assault rifle (family `ar` or class AR, any grade). With the def · the weapon def unknown, only the
   * crafted rifle's id is read.
   */
  private isAssaultRifle(item: ItemInstance | null | undefined): boolean {
    if (!item) return false;
    if (item.defId === TUTORIAL_GUN_DEF) return true;
    try {
      const weaponId = this.ctx.inventory?.getDef(item.defId)?.weaponId;
      const w = weaponId ? this.ctx.loot?.getWeaponDef(weaponId) : undefined;
      if (!w || w.unique) return false;
      return (w.family ?? w.id) === TUTORIAL_GUN_FAMILY || w.weaponClass === 'AR';
    } catch { return false; }
  }

  /** Is HP full — whether the `heal` step is passed silently. Unknown (no player yet) → false. */
  private healthFull(): boolean {
    const p = this.ctx.player;
    const max = p?.maxHp ?? 0;
    return max > 0 && (p?.hp ?? 0) >= max - 0.01;
  }

  /** Announces the current state — the widgets that ask the HUD gate (`hides('hud', …)`) redraw on it. */
  private emitChanged(): void {
    const step = this.step, track = this.track;
    this.ctx.bus.emit('tutorial:changed', {
      active: step !== null, step, index: stepIndexOf(step), count: this.stepCount,
      ...(track ? { track } : {}),
    });
  }

  /** Ends **that track alone**. The other tracks stay and start in their own time (user's decision). */
  private finish(skipped: boolean): void {
    const track = this.track;
    if (!track) return;
    const count = this.stepCount;
    this.save.tracks[track] = { step: null, done: true };
    // The ship track follows only when the raid track was **run to the end** — someone who skipped must never
    //   be shown 「레벨이 올랐습니다」
    if (track === 'raid') this.save.pendingShip = !skipped;
    /* 2026-09-18 (user's decision — 「the launch guide right after the equipping」): 「출격 안내」 follows right
       where 「증축 안내」 was **run to the end**. `autoStart` below reads this mark and calls `startTrack('raid2')`
       at once — the player presses nothing. */
    if (track === 'build') this.save.pendingRaid2 = !skipped;
    this.resetControls();
    this.persist();
    this.popup.close();
    this.refreshVisuals();
    this.ctx.bus.emit('tutorial:changed', { active: false, step: null, index: 0, count });
    this.ctx.bus.emit('tutorial:finished', { skipped, track });
    /* 2026-09-17 (user's decision): there is no right-side toast **when a track is finished** (「{트랙 이름} 완료」 ·
       「튜토리얼 완료 — 좋은 사냥 되세요」) — the checks in the objective panel have said it already. The one line on a
       skip stays (it confirms what was pressed in the ESC menu). */
    if (skipped) {
      this.ctx.bus.emit('ui:notify', { text: `${TRACK_LABEL_KO[track]}를 건너뛰었습니다`, kind: 'warning', duration: 4 });
    }
    this.controlsFolded = false;
    this.controls.setFolded(false, CONTROLS_FOLDED_TEXT);
    // A track that ended inside the ship runs straight on into the next one (ship → build)
    /* 2026-09-16 2nd pass: the ship track ends the moment it is confirmed **inside the menu (the character tab)**.
     * Opening the build track right there puts the intro card over the character screen and has the build track's
     * `screenTab` · `stashItem` gates hide the tabs · stash items it was reading — it opens when the menu closes
     * (`onInventoryClosed`). */
    if (this.ctx.isHubPhase()) {
      if (!skipped && track === 'ship' && this.invOpen) this.autoStartOnClose = true;
      else this.autoStart();
    }
  }

  /* ── the right-side control guide ──────────────────────────────────────── */

  /**
   * Swaps the right-side control guide for **this step's rows** (2026-09-14 3rd pass, user's decision — it
   * reversed the old 「accumulate」).
   *
   * ⚠ **A step absent from the table does nothing** — the previous step's rows stay (so the guidance does not
   * flicker on a step with no new key, like `wake` · `sprintJump` · `crouchAim` · `drop`). An empty array and
   * `undefined` do not mean the same thing.
   *
   * @param force when the row list is the same and **only the wording** changed (`crouch`'s per-stance
   *              `앉기` ↔ `일어서기`).
   */
  private applyControls(step: TutorialStepId, force = false): void {
    // The stance is **read right now** (2026-09-15) — a revive · a resume can put it back with no event
    const hints = controlHintsFor(step, {
      stance: this.ctx.player?.stance ?? this.stance, crawlHalf: this.crawlHalf, handStim: this.handStim,
    });
    if (!hints) return;
    const ids = hints.map((h) => h.id);
    if (!force && ids.length === this.controlIds.length && ids.every((x, i) => this.controlIds[i] === x)) return;
    this.controlIds = ids;
    this.save.learned = ids;
    this.controls.set(hints);
  }

  /**
   * Reload recovery — puts the saved rows back up without the highlight (`init`). It sweeps the whole table and
   * finds them by id, so even an accumulated list left in an old save comes up as it is (the next step change
   * swaps it for the current rows), and an id that is gone drops out silently.
   */
  private restoreControls(): void {
    const ids = this.save.learned;
    if (!ids || ids.length === 0) return;
    const hints: ControlHint[] = [];
    for (const list of Object.values(TUTORIAL_CONTROL_HINTS)) {
      for (const h of list ?? []) if (ids.includes(h.id) && !hints.some((x) => x.id === h.id)) hints.push(h);
    }
    if (hints.length === 0) return;
    this.controlIds = hints.map((h) => h.id);
    this.controls.restore(hints);
  }

  private resetControls(): void {
    // A track change ends the wake grace too — left behind, the next track's first guidance comes up that much
    //   later
    this.wakeHoldT = 0;
    this.crawlHalf = false;
    this.save.learned = [];
    this.controlIds = [];
    this.controls.clear();
    this.tip.clear();
    this.done.clear();
    this.save.objectives = [];
  }

  /* ── material grants ───────────────────────────────────────────────────── */

  /**
   * The floor grant — once, on entering `craftGun`. It goes into the bag (into the ship stash when that is full)
   * and what arrived is announced. `granted` is left in the save, so a reload never grants it twice. The real
   * shortfall is `ensureMaterials`'s business.
   */
  private grantMaterials(): void {
    if (this.save.granted) return;
    const inv = this.ctx.inventory, loot = this.ctx.loot;
    if (!inv || !loot) return;
    let given = 0;
    for (const { defId, qty } of TUTORIAL_CRAFT_GRANT) {
      try {
        const item = loot.createItem(defId, qty);
        if (inv.tryAddItemAnywhere(item)) given++;
      } catch { /* def missing / no room — the step still runs, the player just has to find materials */ }
    }
    this.save.granted = true;
    if (given > 0) {
      this.ctx.bus.emit('ui:notify', { text: '보급: 제작 재료가 들어왔습니다', kind: 'success', duration: 4 });
    }
  }

  /**
   * **Top-up** (2026-09-09) — for each material of `recipeId` it gives only `required − owned`. The requirement
   * is read from the recipe (`ctx.loot`) and what is owned from the same place as `canCraft` (the bag,
   * `countWhere`) — crafting uses the bag's materials alone. It fills the bag first and the ship stash when there
   * is no room (`tryAddItemAnywhere`). Idempotent: with nothing short, nothing happens and no toast is shown.
   */
  private ensureMaterials(recipeId: string, step: TutorialStepId): void {
    const inv = this.ctx.inventory, loot = this.ctx.loot;
    if (!inv || !loot) return;
    let recipe: { inputs: readonly { defId: string; qty: number }[] } | undefined;
    try { recipe = loot.getAllRecipes().find((r) => r.id === recipeId); } catch { recipe = undefined; }
    if (!recipe) return;
    const given: string[] = [];
    let toStash = false;
    for (const { defId, qty } of recipe.inputs) {
      let have = 0;
      try { have = inv.countWhere((d) => d.id === defId); } catch { have = 0; }
      let short = qty - have;
      if (short <= 0) continue;
      const def = inv.getDef(defId);
      const max = Math.max(1, def?.stackMax ?? 1);
      let added = 0;
      while (short > 0) {
        const q = Math.min(max, short);
        let where: 'bag' | 'stash' | null = null;
        try { where = inv.tryAddItemAnywhere(loot.createItem(defId, q)); } catch { where = null; }
        if (!where) break;
        if (where === 'stash') toStash = true;
        short -= q; added += q;
      }
      if (added > 0) given.push(`${def?.name ?? defId} ${added}`);
    }
    const topped = this.save.topped ?? (this.save.topped = []);
    if (!topped.includes(step)) topped.push(step);
    if (given.length > 0) {
      this.ctx.bus.emit('ui:notify', {
        text: `보급: ${given.join(' · ')} — ${toStash ? '가방이 차서 일부는 함선 창고에' : '가방에'} 채웠습니다`,
        kind: 'success', duration: 4,
      });
    }
  }

  /* ── screen ────────────────────────────────────────────────────────────── */

  /**
   * Fits the panel · the spotlight · the floor guide to the current step. Where nothing may show (a menu · a
   * cutscene) it folds them all.
   */
  private refreshVisuals(): void {
    if (!this.active) {
      this.panel.hide();
      this.spotlight.set([], '');
      this.guide.setTarget(null);
      this.controls.show(false);
      return;
    }
    this.panel.setLifted(false);        // the next update reads the spotlight state and decides again
    const step = this.step!;
    const track = this.track!;
    const def = stepDef(step);
    // 2026-09-14 4th pass: nothing is drawn during the intro wake · the beat right after it (`quiet`)
    // 2026-09-16: during the liftoff cinematic too (`cinematic`) — the target marker goes with it
    const showable = (this.ctx.isHubPhase() || this.ctx.isGameplayPhase()) && !this.quiet && !this.cinematic;
    if (!showable) {
      this.panel.hide();
      this.spotlight.set([], '');
      this.guide.setTarget(null);
      this.marker.setTarget(null);
      this.controls.show(false);
      return;
    }
    // 2026-09-14 2nd pass: the inventory screen takes the whole right side — the control guide folds meanwhile
    this.controls.show(!this.invOpen);
    // With the furniture picked up there is no UI left to light — all that remains is clicking the 3D floor
    const placing = step === 'bench' && this.benchArmed;
    const view = this.stepView(step, def);
    /*
     * 2026-09-18 (user report — 「for the few seconds between the readiness hold at the launch slot and the pod
     * firing, the floor guide points somewhere else」): a step with **every** required objective done has nowhere
     * to walk and nothing to light. Until now, with no objective row left it fell back to the step's own `guide` ·
     * `spot` (`terminal`'s step value is the cockpit), and that read as 「you are aboard, now go to the cockpit」.
     * This one line closes that path — once the cutscene starts `showable` folds it all anyway, so it stays
     * cleared until the launch.
     */
    const cur = currentObjective(view.objectives, this.done);
    const nothingLeft = cur === null;
    /*
     * 2026-09-18 (user's decision — 「the objectives at the map's top left during the tutorial raid」): while the
     * tactical map is open the floating panel **folds**. The panel is z 79, so it sits over the map (40), and the
     * map draws the same objectives at the same top left (`ui/map/QuestPanels`'s tutorial panel), so two copies
     * were on screen. 「One fact, one place」 — with the map open, the map's copy holds that place. The data comes
     * from the one `panelInfo()`, so the two can never drift.
     */
    if (this.mapOpen) this.panel.hide();
    else this.panel.show({
      track: TRACK_LABEL_KO[track],
      // 2026-09-14 3rd pass: **a row not opened yet is not drawn** (the sequential reveal, `visibleObjectives`)
      objectives: visibleObjectives(view.objectives, this.done),
      done: this.done,
      // A counted objective's `(n/m)` (2026-09-15 2nd pass) — rebuilding the rows keeps the current number
      counts: this.objectiveCounts(),
      index: stepIndexOf(step), count: this.stepCount,
      // 2026-09-18: only 「출격 안내」's raid has **the loot value** as its bar (null elsewhere = the step count)
      gauge: this.raidGauge(),
    });
    // The spotlight is not laid over the intro card while it is up
    this.spotlight.set(
      this.popup.isOpen || placing || nothingLeft ? SPOT_NONE : view.spot, view.spotText, view.union, view.noDim,
    );
    // 2026-09-15 (user's decision): while housing mode is open the floor guide is drawn **in no step at all** —
    //   the pillar · the dashes under the management camera point at a place that cannot be walked to right now.
    //   On the close `onManage` comes back here and lays it half a beat later.
    //   2026-09-17: the target is **the current objective row**'s (`guideKindOf` — the row that walks to the
    //   cockpit takes the terminal, the row that walks to the pod takes the pod).
    this.guide.setTarget(this.housingOpen() || nothingLeft ? null : this.guideTarget(this.guideKindOf(def, cur)));
    // The 3D target marker — the corpse stretch's two steps point at the same corpse (`CORPSE_MARKER_STEPS`)
    this.marker.setTarget(CORPSE_MARKER_STEPS.includes(step) ? this.nearestCorpse() : null);
  }

  /**
   * What that step shows **right now** (2026-09-14 3rd pass). Most of it is the table (`Steps.ts`) as it stands;
   * only the two places that split on screen state are picked here — start writing conditions into the table and
   * the table becomes code.
   *   • `equipGun` + the craft window open → the equipment slots are hidden, so **the close button** first (the
   *     objective row before it is that too).
   *   • `corpseLoot` + the gun already held → **the focus turns off** (2026-09-14 4th pass, user's decision).
   *     There is nothing left to learn in that step and all that remains is the optional objectives and closing
   *     the window, so a ring still round the equipment slots reads as something not done yet.
   *     2026-09-15: it turns off when **the window was closed straight away** without the gun too
   *     (`corpseFocusOff` — opening the corpse again brings it back).
   *   • `heal` now has **no UI to light at all** (auto-registration + the wheel is the fingers, not the screen) —
   *     it goes by the table.
   */
  private stepView(step: TutorialStepId, def: StepDef): {
    objectives: readonly TutorialObjective[]; spot: readonly string[] | undefined;
    spotText: string; union: boolean; noDim: boolean;
  } {
    const objectives = this.objectivesFor(def);
    // 2026-09-17: the rifle is equipped — all that is left is closing the window, so the focus turns off (the
    //   place it waits with no objective row)
    if (step === 'equipGun' && this.done.has('equipSlot')) {
      return { objectives, spot: SPOT_NONE, spotText: '', union: false, noDim: false };
    }
    if (step === 'equipGun' && this.craftOpen) {
      return { objectives, spot: SPOT_CRAFT_CLOSE, spotText: '제작 창 닫기', union: false, noDim: false };
    }
    if (step === 'corpseLoot' && (this.done.has('corpseGun') || this.corpseFocusOff)) {
      return { objectives, spot: SPOT_NONE, spotText: '', union: false, noDim: false };
    }
    // 2026-09-16 2nd pass (user's decision): the ship track's `stats` — as the objectives open, the focus moves
    //   character tab → the ＋ column → the confirm button
    if (step === 'stats') {
      const focus = this.statsFocus();
      const [spot, spotText] = focus === 1 ? [SPOT_STATS_TAB, STATS_TAB_TEXT]
        : focus === 2 ? [SPOT_STATS_RAISE, STATS_RAISE_TEXT]
          : focus === 3 ? [SPOT_STATS_CONFIRM, STATS_CONFIRM_TEXT]
            : [SPOT_NONE, ''];
      return { objectives, spot, spotText, union: false, noDim: false };
    }
    /* 2026-09-17 (the grouped build steps): when **the current objective row** states a focus of its own, it
       wins (`spot: []` = light nothing). With every row done, or none stated, the step's value is used. A row's
       selector array is a constant of the `Steps.ts` table, so the reference is stable (`Spotlight.set` compares
       arrays by reference — `SPOT_CRAFT_CLOSE`'s rule). */
    const cur = currentObjective(objectives, this.done);
    if (cur?.spot !== undefined) {
      return {
        objectives, spot: cur.spot.length > 0 ? cur.spot : SPOT_NONE, spotText: cur.spotText ?? def.spotText ?? def.hint,
        union: cur.spotUnion ?? !!def.spotUnion, noDim: cur.spotNoDim ?? !!def.spotNoDim,
      };
    }
    return {
      objectives, spot: def.spot, spotText: def.spotText ?? def.hint,
      union: !!def.spotUnion, noDim: !!def.spotNoDim,
    };
  }

  /**
   * **The contents of one objective panel** (2026-09-18, user's decision — the same rows stand at the top of the
   * tactical map's left column too). It hands over **the same data** the top-left panel draws, as a read-only
   * snapshot (`ui/map/QuestPanels` is the only consumer) — were the map to work out the sequential reveal · the
   * done marks · the counts itself, the two screens would drift. Inactive it is null, so the map draws nothing.
   */
  panelInfo(): TutorialPanelInfo | null {
    const step = this.step;
    const track = this.track;
    if (!step || !track) return null;
    const view = this.stepView(step, stepDef(step));
    const counts = this.objectiveCounts();
    const objectives: TutorialObjectiveInfo[] = visibleObjectives(view.objectives, this.done).map((o) => ({
      id: o.id,
      // The `(선택) ` prefix is attached here — the rule that makes the wording belongs to this folder
      //   (`OPTIONAL_PREFIX_KO`)
      text: (o.optional ? OPTIONAL_PREFIX_KO : '') + o.text,
      optional: !!o.optional,
      done: this.done.has(o.id),
      count: o.count === undefined ? null
        : { at: Math.max(0, Math.min(o.count, Math.round(counts[o.id] ?? 0))), total: o.count, unit: o.countUnit },
    }));
    return {
      track, label: TRACK_LABEL_KO[track], step,
      index: stepIndexOf(step), count: this.stepCount,
      objectives, gauge: this.raidGauge(),
    };
  }

  /**
   * The spot of **the nearest lootable corpse** right now (`Interactable.kind === 'corpse'`).
   * The point is to write no coordinate into this folder — `world/tutorial` may move the corpse and the marker
   * follows.
   */
  private nearestCorpse(): THREE.Vector3 | null {
    const p = this.ctx.player;
    if (!p) return null;
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const it of this.ctx.interactables.all()) {
      if (it.kind !== 'corpse') continue;
      let ok = false;
      try { ok = it.canInteract(); } catch { ok = false; }
      if (!ok) continue;
      const d = it.position.distanceToSquared(p.position);
      if (d < bestD) { bestD = d; best = it.position; }
    }
    return best;
  }

  /** The inventory screen opens and closes — the right-side control guide hides behind it. */
  private setInventoryOpen(open: boolean): void {
    if (open === this.invOpen) return;
    this.invOpen = open;
    // During the intro wake · the beat right after it, it never comes up whatever happens (`quiet`)
    if (this.active) this.controls.show(!open && !this.quiet);
  }

  private guideTarget(kind: 'bench' | 'terminal' | 'pod' | undefined): string | null {
    if (!kind) return null;
    if (kind === 'bench') return this.benchInteractable;
    if (kind === 'terminal') return 'hub_terminal';
    return 'hub_pod_0';
  }

  private showIntro(): void {
    this.popup.open('튜토리얼', [
      '함선을 한 바퀴 돌며 기본 조작을 익힙니다.',
      '작업실을 짓고 · 총과 탄약을 만들고 · 행성을 정해 출격하는 데까지 안내합니다.',
      '언제든 ESC 메뉴의 튜토리얼 건너뛰기로 그만둘 수 있습니다.',
    ], [
      { label: '건너뛰기', onClick: () => { this.popup.close(); this.askSkip(); } },
      { label: '시작', kind: 'primary', onClick: () => { this.popup.close(); this.advance(); } },
    ]);
    this.refreshVisuals();
  }

  /**
   * The skip confirm — a modeless card. Cancelling returns to where the player was.
   * 2026-09-14: **only the current track** is skipped — the other tracks start again in their own time (one line
   * of the card's body says so).
   */
  private askSkip(): void {
    if (!this.active || this.confirmingSkip) return;
    this.confirmingSkip = true;
    // 2026-09-09: no body — the title and the buttons only. The skip is a red **hold button**
    //   (`SKIP_HOLD_TIME`), so a short press never ends it.
    this.popup.open(`${TRACK_LABEL_KO[this.track!]}를 건너뛸까요?`, [], [
      { label: '계속하기', onClick: () => { this.confirmingSkip = false; this.popup.close(); this.refreshVisuals(); } },
      { label: '건너뛰기', kind: 'danger', hold: SKIP_HOLD_TIME, onClick: () => { this.confirmingSkip = false; this.skip(); } },
    ]);
    this.refreshVisuals();
  }

  /* ── the save ──────────────────────────────────────────────────────────── */

  /**
   * Reads the save. **The v1 → v2 migration is the point** (2026-09-14): v1's `step` · `done` all belonged to
   * today's `build` track, so they are grafted onto it, and such a profile is **taken to have already finished
   * the raid · ship tracks** — otherwise someone already playing is dragged into the tutorial raid on the next
   * connect (`isTrackDone('raid')` decides the entry flow).
   */
  private load(): SaveV2 {
    try {
      const raw = window.localStorage.getItem(slotKey(TUTORIAL_STORAGE_KEY));
      if (!raw) return freshSave();
      const doc = JSON.parse(raw) as Partial<SaveV2>;
      const tracks: Partial<Record<TutorialTrack, TutorialTrackSave>> = {};
      let retiredDone: readonly string[] | null = null;
      /*
       * 2026-09-18 (「증축 안내」 · 「출격 안내」 split apart): a saved step became **another track's** (`terminal` ·
       * `raid` → `raid2`). Throwing it away would wipe that player's guidance whole, so it is grafted onto that
       * track and the track walked past is written down as over. The move happens after the main loop, so the
       * loop cannot overwrite that track behind it.
       */
      const moved: Array<{ step: TutorialStepId; home: TutorialTrack }> = [];
      const src = doc.tracks;
      if (src && typeof src === 'object') {
        for (const t of TUTORIAL_TRACKS) {
          const e = src[t];
          if (!e || typeof e !== 'object') continue;
          // 2026-09-16: a track standing on the last place dropped out of the order (`messenger` ·
          //   `ravenQuest`) is over (`Steps.retiredTrackEnd`)
          const done = !!e.done || retiredTrackEnd(e.step) === t;
          // A step dropped out of the order (`openCraft`) maps to the step that took its place
          const step = normalizeStep(e.step);
          const home = step ? trackOf(step) : null;
          const away = !done && step !== null && home !== null && home !== t;
          if (away) moved.push({ step: step!, home: home! });
          tracks[t] = { step: away || done || !step || home !== t ? null : step, done: done || away };
          // 2026-09-17: a save standing on a build step that was grouped away — the rows that player already
          //   did are pre-filled in the new step (`Steps.retiredObjectives`)
          const pre = tracks[t]!.step || away ? retiredObjectives(e.step) : null;
          if (pre) retiredDone = pre;
        }
      } else {
        const step = doc.done ? null : normalizeStep(doc.step);
        const home = step ? trackOf(step) : null;
        if (step && home && home !== 'build') moved.push({ step, home });
        tracks.build = { step: home === 'build' ? step : null, done: !!doc.done || (!!step && home !== 'build') };
        tracks.raid = { step: null, done: true };
        tracks.ship = { step: null, done: true };
      }
      for (const m of moved) {
        const cur = tracks[m.home];
        if (cur?.step || cur?.done) continue;
        tracks[m.home] = { step: m.step, done: false };
      }
      return {
        version: TUTORIAL_SAVE_VERSION,
        tracks,
        room: typeof doc.room === 'number' ? doc.room : undefined,
        granted: !!doc.granted,
        benchUid: typeof doc.benchUid === 'string' ? doc.benchUid : undefined,
        pendingShip: !!doc.pendingShip,
        // 2026-09-18: a field old saves do not have — which is why 「출격 안내」 never newly appears on a profile
        //   that already finished building out (`autoStart`)
        pendingRaid2: !!doc.pendingRaid2,
        learned: Array.isArray(doc.learned) ? doc.learned.filter((s): s is string => typeof s === 'string') : undefined,
        objectives: retiredDone ? [...retiredDone]
          : Array.isArray(doc.objectives) ? doc.objectives.filter((s): s is string => typeof s === 'string') : undefined,
        topped: Array.isArray(doc.topped)
          ? doc.topped.map((s) => normalizeStep(s as string)).filter((s): s is TutorialStepId => s !== null)
          : undefined,
      };
    } catch { return freshSave(); }
  }

  private persist(): void {
    try { window.localStorage.setItem(slotKey(TUTORIAL_STORAGE_KEY), JSON.stringify(this.save)); } catch { /* storage off */ }
  }

  /* ── dev console ───────────────────────────────────────────────────────── */

  private registerConsole(): void {
    const c = this.ctx.console;
    if (!c || typeof c.register !== 'function') return;
    try {
      c.register({
        name: 'tutorial',
        usage: 'tutorial [start|skip|step <id>|track <raid|ship|build|raid2>|status]',
        description: '튜토리얼 시작 / 건너뛰기 / 특정 단계 · 트랙으로 이동',
        run: (args, _ctx, print) => {
          const sub = args[0] ?? 'status';
          if (sub === 'start') { print(this.start() ? '튜토리얼 시작' : '이미 진행 중입니다', 'info'); return; }
          if (sub === 'skip') { this.skip(); print('트랙 종료', 'info'); return; }
          if (sub === 'track') {
            const t = args[1] as TutorialTrack | undefined;
            if (!t || !TUTORIAL_TRACKS.includes(t)) { print(`트랙: ${TUTORIAL_TRACKS.join(' ')}`, 'error'); return; }
            // The console turns a finished track back on too (`startTrack` refuses — the mark is wiped here)
            this.save.tracks[t] = { step: null, done: false };
            print(this.startTrack(t) ? `→ ${t}` : '이미 다른 트랙이 돌고 있습니다', 'info');
            return;
          }
          if (sub === 'step') {
            const id = args[1] as TutorialStepId | undefined;
            if (!id || !this.goto(id)) {
              for (const t of TUTORIAL_TRACKS) print(`${t}: ${TUTORIAL_TRACK_STEPS[t].join(' ')}`, 'error');
              return;
            }
            print(`→ ${id}`, 'success');
            return;
          }
          print(this.active ? `${this.track} · ${this.step} (${this.stepIndex}/${this.stepCount})` : '비활성', 'info');
        },
      });
    } catch { /* console shape differs — the tutorial works without it */ }
  }
}
