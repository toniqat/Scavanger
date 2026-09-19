// 2026-09-18: the digit grouping of an objective line's `(n/m)` is one shared notation (`tutorialCountLabel` — the panel and the map both use it).
import { groupDigits } from './numberFormat';

/* ────────────────────────────────────────────────────────────────────────────
 * The tutorial (2026-09-08). Owner: `tutorial/TutorialSystem` publishes `ctx.tutorial`.
 *
 * It starts on its own the first time a new profile enters the personal ship, walks one lap through
 * **housing → crafting → launch** inside the ship, and ends once the raid starts. The step reached stays in
 * localStorage and survives a reload.
 *
 * This contract does only two things.
 *   1. **Gating** — the tutorial enforces the order strictly. Each folder calls
 *      `ctx.tutorial?.blockReason(gate, id)` once inside its own refusal-reason function and, when it is not null,
 *      uses that Korean reason as it is. With the tutorial off it is always null, so normal behaviour does not
 *      change by one character.
 *   2. **Hiding** — anything that must not be visible during the tutorial is asked about with `hides(gate, id?)`
 *      and **not drawn at all**. (2026-09-08) Showing only what can be done right now is far less confusing than
 *      leaving a locked entry in place with a "not during the tutorial" reason — room purposes · furniture cards ·
 *      recipes · screen tabs · the planet pager all use this rule.
 *
 * The objective panel · the spotlight · the floor guide line are all drawn by `tutorial/` itself — no other folder knows them.
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── appended (2026-09-14, the tutorial rework — `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ────────────────────────────
 *
 * The guide split into **three tracks**, each skipped on its own (user's decision).
 *
 *   ① `raid`  — the tutorial raid. Once a character is made they wake up on a hand-built tutorial planet
 *               **without passing through the ship**, learn moving · sprinting · jumping · looting · shooting ·
 *               crouching · healing · grenades, and extract to an abandoned ship.
 *   ② `ship`  — the first ship entry. Level-up · committing the stat point investment (2026-09-15: Raven's quest
 *               step · 2026-09-16: the open-the-messenger step were dropped).
 *   ③ `build` — facility extension · workbenches · crafting · launch. **The existing 17 steps are exactly this
 *               track** (ids and order unchanged).
 *
 * Other than the tracks splitting, the design is unchanged — progress is watched through bus events, and the order
 * is enforced by one `blockReason` line in each folder.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────────── */

/* ── appended (2026-09-18, user's decision — the extension guide split in two) ────────────────────────────────
 *
 * ④ `raid2` 「출격 안내」 — the last two steps of the old `build` track (`terminal` · `raid`) became **a track of
 *   their own**. 「증축 안내」 ends where the crafted rifle is equipped (`equipGun`), and the cockpit · the launch ·
 *   the first raid are a separate guide that starts right after it — building the ship and going out to a planet
 *   are different things to learn and different things to fail at, and each track has to be skippable on its own
 *   so that someone who knows the extension but has never launched exists (the same reasoning that split the 3
 *   tracks). Not one step id changed (`terminal` · `raid` only moved track) — an old save is grafted onto that
 *   track by `tutorial/TutorialSystem.load`.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

/** A guide track. Each has its own objective panel · its own skip · its own save. */
export type TutorialTrack = 'raid' | 'ship' | 'build' | 'raid2';

export const TUTORIAL_TRACKS: readonly TutorialTrack[] = ['raid', 'ship', 'build', 'raid2'];

/** The steps, walked in order. `intro` is the opening popup and `done` is the finished state (= inactive). */
export type TutorialStepId =
  /* ── ① raid (2026-09-14): the tutorial raid ── */
  | 'wake'         // wakes up lying on the ground (`PlayerRef.playIntroWake`) — standing up moves on
  | 'move'         // WASD movement
  | 'sprintJump'   // clears the cliff with a sprint + jump (falling is instant death · a checkpoint)
  /*
   * appended (2026-09-15 2nd pass, user's decision) — **interacting with a corpse.** Before, 「기관단총을 주무기 칸에
   * 장착」 came up the moment the cliff was cleared — telling someone to move what is inside a corpse they have not
   * even opened yet (the same eye that added `supplyLoot`). So standing in front of the corpse is one line first,
   * 「{INTERACT} 시체 상호작용」, and once the bag opens it is `corpseLoot`.
   */
  | 'corpseOpen'
  | 'corpseLoot'   // takes the weapon · bag · ammo out of the corpse and equips them (the hp · weapon HUD appears here)
  /*
   * appended (2026-09-14 4th pass, user's decision) — **three 「앞으로 이동」 stretches.** Before, the next step's
   * guide came up the instant the previous one ended: 「앉아서 낮은 틈을 지나세요」 the moment the bug died,
   * 「아래로 뛰어내리세요」 the moment the android died — with that thing 30 m away and only the guide arriving
   * first. So **between one stretch and the next it is always 「앞으로 이동」**, and the next guide comes up on
   * standing in front of that thing (= the checkpoint).
   *   advance1 = corpse looting → the bugs (the bugs erupt at the `bugs` checkpoint)
   *   advance2 = the bugs → in front of the crawl stretch (`crawl`)
   *   advance3 = the android → in front of cliff 2 (`drop`)
   * All three end at a checkpoint `CHECKPOINT_STEP` (tutorial/model) already knows, so there is no new world trigger.
   */
  | 'advance1'
  | 'shoot'        // kill two bugs — shooting · aiming down sights
  | 'advance2'
  | 'crouch'       // crouches under the pillar to get past
  | 'crouchAim'    // aiming down sights while crouched — the sway settles. Two androids
  | 'advance3'
  | 'drop'         // jumps down from a height (fall damage, hp clamped to 1)
  /*
   * appended (2026-09-15, user's decision) — **looting the supply corpse.** Before, the `supply` checkpoint opened
   * `heal` straight away, so 「붕대를 사용」 came up before a bandage had even been picked up. Now it is `supply`
   * → `supplyLoot` (required: get the bandage from the corpse · optional: get the grenade) → `heal` once the
   * bandage is held and the corpse's bag is **closed**. Walking on to the collapsed wall (`wall`) without picking
   * anything up skips `heal` too and goes to `grenade`.
   */
  | 'supplyLoot'
  | 'heal'        // a healing item · a grenade from the corpse (auto-equipped into the quick slots) → use the heal
  | 'grenade'      // the two androids past the collapsed wall — an **optional step** (going back unused is allowed)
  | 'extract'      // the switch inside the abandoned ship → a 10 s grace → liftoff
  /* ── ② ship (2026-09-14): the first ship entry ── */
  | 'levelUp'      // (out of the order, 2026-09-16) check the level gained as a raid reward — became `stats`'s first objective (open the menu)
  | 'stats'        // open the menu → the character tab → stat ＋ → `포인트 투자 확정` (a 1 s hold) — since 2026-09-16 the ship track's only step
  | 'messenger'    // (out of the order, 2026-09-16) open the messenger — it was the ship track's last step between 2026-09-15 and 09-16
  /*
   * appended (2026-09-15, user's decision) — **dropped out of the order** (the same treatment as `openCraft`: the
   * id stays because it is a contract, it is only missing from `TUTORIAL_TRACK_STEPS.ship`). Raven's first contact
   * now comes **after** the ship track ends (`meta/parts/NpcQuests.tutorialBlocks`) — the guide does not drag the
   * player as far as accepting a quest.
   * 2026-09-16 (user's decision) — `messenger`, which used to follow it, was dropped the same way, leaving the ship
   * track as `levelUp` → `stats`. The 2nd pass the same day dropped `levelUp` too, so today the track is the **one**
   * step `stats` — `TUTORIAL_TRACK_STEPS.ship` below is the answer, never this sentence. An old save's `messenger` ·
   * `ravenQuest` are read by `tutorial/Steps.retiredTrackEnd` as the end of the ship track (there is no step left to
   * join on).
   */
  | 'ravenQuest'   // (out of the order, 2026-09-15) Raven's first contact · picking an answer · accepting the quest
  /* ── ③ build: the existing 17 steps (ids unchanged) ── */
  | 'intro'        // the opening popup — pressing confirm moves on
  | 'manage'       // open ship management with M
  | 'generator'    // start the generator (Lv.1) — the precondition for extending a facility
  | 'workshop'     // extend one empty room into a workshop
  | 'bench'        // craft the gun workbench (it goes into the furniture storage)
  | 'benchPlace'   // furniture storage → pick the workbench and place it on the workshop floor
  | 'manageDone'   // close housing mode (ship management) — dropped in the 2026-09-14 3rd pass, back in the order on 2026-09-15
  | 'craftGun'     // walk to the workshop and craft a weapon at the gun workbench
  | 'openBag'      // close the craft window and open the bag + the equipped gear (the equipment slots are hidden while crafting)
  | 'equipGun'     // equip the crafted weapon in the primary slot
  | 'openCraft'    // (out of the order, 2026-09-09) open the craft window with the craft button at the top right of the bag — dropped when the rifle · ammo became one workbench craft
  | 'craftAmmo'    // craft that weapon's ammo
  | 'stowAmmo'     // put the ammo in the bag
  | 'terminal'     // interact with the cockpit terminal
  | 'planet'       // pick the target planet (planet 1 only)
  | 'travel'       // wait out the planet travel (the window warp)
  | 'board'        // board the launch pod
  | 'raid';        // the raid starts — it highlights the extraction indicator and ends

export const TUTORIAL_STEPS: readonly TutorialStepId[] = [
  // (the 17 steps before 2026-09-17: intro manage generator workshop bench benchPlace manageDone craftGun craftAmmo openBag equipGun
  //   stowAmmo terminal planet travel board raid)
  // 2026-09-09: the rifle → the ammo are made **in one go** at the gun workbench — `openCraft` dropped out of the order (the id stays because it is a contract).
  // 2026-09-14 3rd pass (user's decision — 「pressing close is taken out of the tutorial steps」): `manageDone` got the same treatment.
  // 2026-09-15 (user's decision — reversed): **`manageDone` came back into the order** — one line, 「하우징 모드 닫기」,
  //   stands right before 「작업실로 이동」. The workshop cannot be walked to while management mode is open, yet the guide was
  //   telling the player to walk there, and the floor guide line was laid under the management camera too. 16 → 17 steps.
  //   (`openCraft` stays out of the order.)
  // 2026-09-17 (user's decision — 「bundle several steps into several objectives inside one step」): **17 → 7 steps.** One step holds several objectives revealed in turn.
  //   manage  = open ship management → (only at generator Lv.0: start the generator) → extend an empty room into a workshop   (absorbs `generator` · `workshop`)
  //   bench   = craft the gun workbench → the furniture storage tab → place the furniture → close housing mode        (absorbs `benchPlace` · `manageDone`)
  //   craftGun= move to the workshop → operate the workbench → assault rifle → medium-heavy ammo → close the craft window (absorbs `craftAmmo` · `openBag`)
  //   equipGun= open the Tab inventory → equip the assault rifle (it waits quietly until the inventory is closed)      (`stowAmmo` is gone)
  //   terminal= move to the cockpit → operate the terminal → the target planet → (wait out the warp) → the launch pod → board → the ready hold (absorbs `planet` · `travel` · `board`)
  //   raid    = extract carrying at least `TUTORIAL_RAID_EXTRACT_VALUE_C` of value — **one raid**; when it ends the track ends whatever the result
  //   A dropped id stays in `TutorialStepId` because it is a contract, and an old save is moved onto the step it was bundled into by `tutorial/Steps.normalizeStep`.
  // 2026-09-18 (user's decision — the extension guide · the launch guide split): the last two steps (`terminal` · `raid`) left for the new track `raid2`. 7 → 5 steps.
  //   The ids are unchanged — only the **track** moved, so neither `TutorialStepId` nor `STEP_DEFS` changes by one character.
  'intro', 'manage', 'bench', 'craftGun', 'equipGun',
];

/**
 * The order per track (2026-09-14). `TUTORIAL_STEPS` is **the same array as the `build` track**, so existing call
 * sites keep working unchanged. Progress (`stepIndex` / `stepCount`) is counted inside the running track alone.
 */
export const TUTORIAL_TRACK_STEPS: Readonly<Record<TutorialTrack, readonly TutorialStepId[]>> = {
  // 2026-09-14 4th pass: the three 「앞으로 이동」 between stretches (`advance1`·`2`·`3`) came in, so 11 → 14 steps.
  raid: [
    // 2026-09-15 2nd pass: `corpseOpen` (interacting with the corpse) came in before `corpseLoot`, so 16 steps.
    'wake', 'move', 'sprintJump', 'corpseOpen', 'corpseLoot', 'advance1', 'shoot', 'advance2', 'crouch', 'crouchAim',
    // 2026-09-15: `supplyLoot` (looting the supply corpse) came in between `drop` and `heal`.
    'advance3', 'drop', 'supplyLoot', 'heal', 'grenade', 'extract',
  ],
  // 2026-09-15 (user's decision): `ravenQuest` dropped out of the order — Raven's first contact comes after this track ends. 4 → 3 steps.
  // 2026-09-16 (user's decision): `messenger` (open the messenger) dropped out too — the track ends when the screen is closed after the points have been handed out. 3 → 2 steps.
  // 2026-09-16 2nd pass (user's decision): `levelUp` dropped out too — the one step `stats` reveals four objectives in turn (menu → character tab → ＋ → confirm). 2 → 1 step.
  //   An old save's `levelUp` is moved to `stats` by `tutorial/Steps.normalizeStep`.
  ship: ['stats'],
  build: TUTORIAL_STEPS,
  /*
   * 2026-09-18 (user's decision): 「출격 안내」 — pick a planet at the cockpit and launch (`terminal`), then come back
   * with the loot (`raid`). It starts **right** where the last step of 「증축 안내」 (`equipGun`) ends
   * (`TutorialSystem.autoStart` — it only follows on for someone who ran that track to the end, `pendingRaid2`).
   * Both steps keep their old ids, so the `Steps.ts` table and `normalizeStep` are used as they are.
   */
  raid2: ['terminal', 'raid'],
};

/** The track that step belongs to (null for an unknown id). */
export function tutorialTrackOf(step: TutorialStepId): TutorialTrack | null {
  for (const t of TUTORIAL_TRACKS) if (TUTORIAL_TRACK_STEPS[t].includes(step)) return t;
  return null;
}

/**
 * Gate kinds. What `id` means differs per kind:
 *   `roomPurpose` → `RoomPurpose` · `furniture` → a furniture def id · `craft` → a recipe id ·
 *   `planet` → `PlanetId` · the rest do not use `id`.
 */
export type TutorialGate =
  | 'roomPurpose'   // extending a room purpose
  | 'furniture'     // crafting / placing furniture
  | 'manageExit'    // leaving ship management
  | 'craft'         // crafting an item
  | 'terminal'      // opening the terminal
  | 'matchmaking'   // the terminal's matchmaking tab (2026-09-15 — invites · private/public matching; hiding only)
  | 'planet'        // picking a planet
  | 'board'         // boarding the launch pod
  | 'screenTab'     // a screen tab of the Tab window (id = 'character' | 'corp' | 'ship'; the inventory is always open)
  | 'community'     // the community button at the top right (hiding only)
  | 'stashItem'     // an item in the ship stash grid (id = an item def id; hiding only, 2026-09-09 — only the tutorial's materials · outputs are left)
  /**
   * appended (2026-09-14): **gradual HUD reveal** (hiding only). id = `TutorialHudPart` — a HUD piece is not drawn
   * at all before it has been learnt. Hp · the weapon appear after the gear is taken from the corpse, stamina after
   * it is first spent, and implants · ship calls are absent for the whole tutorial raid (there are none to use).
   */
  | 'hud'
  /**
   * appended (2026-09-16, user's decision): **entering facility management (ship management mode)**. It does not use
   * `id`. It is blocked and hidden only while the ship track is running — the bottom-right `시설 관리` key hint
   * (`ui/hud/ShipManageHint`) asks through `hides` and `housing/parts/Furniture.shipManageBlock` through
   * `blockReason`. On any other track (the extension track's `manage` step opens exactly this) it is always open.
   */
  | 'shipManage'
  /**
   * appended (2026-09-17, user's decision): two **hiding-only** gates — true only while the extension track runs
   * (they do not use `id`).
   *   • `training`   the `시뮬레이션 훈련장` button at the bottom right of the ship terminal's planet tab
   *     (`hub/ui/HubMenu`) — so nobody wanders off mid launch-guide.
   *   • `launchWarn` the launch-readiness warning popup raised when readying at the launch pod
   *     (`hub/parts/Pods.toggleReady` — no corp contract · no armor …). A tutorial character is supposed to have
   *     neither, so the warning was cutting the guide off.
   */
  | 'training'
  | 'launchWarn';

/**
 * The id of `hides('hud', id)`. The widget that draws this name asks under its own name.
 *
 * appended (2026-09-14 2nd pass, user's decision) — the tutorial raid's **extraction ship markers** and the **top
 * extraction timer**:
 *   • `shipMarker`       the map marker · the world marker. It does not appear **for the whole tutorial raid**.
 *                        The 2026-09-14 4th pass (user's decision — 「remove the green sphere on the ship switch
 *                        step」) reversed the 2nd pass's 「it is released on entering the `extract` step」: that world
 *                        marker is a `--c-success` green circle (`.wmarker.ship` in `ui/styles/base.css`), so a
 *                        green bead hung on screen during the last step, and with the ship at the end of a
 *                        straight corridor there was no way to miss it and no guiding role either.
 *   • `shipScreenMarker` the screen (compass · off-screen arrow) ship marker. It does not appear **for the whole
 *                        tutorial raid**.
 *   • `extractionTimer`  the top-centre 「자동 출발까지」 · 「도착」 labels (the tutorial ship never arms an
 *                        automatic departure).
 */
export type TutorialHudPart =
  | 'vitals' | 'weapon' | 'stamina' | 'implant' | 'stratagem'
  | 'shipMarker' | 'shipScreenMarker' | 'extractionTimer';

/** The state of one track. */
export interface TutorialTrackSave {
  /** The current step. null once it is over. */
  step: TutorialStepId | null;
  /** It is over (run to the end or skipped) — it does not start again on its own. */
  done: boolean;
}

/**
 * What the tutorial saves.
 *
 * **v2 (2026-09-14)**: split per track. A track that is not in `tracks` has not started yet.
 * A v1 save (`step` · `done` at the top level) is grafted onto `tracks.build` when read — every v1 step belonged to
 * the build track, and such a profile is taken to have **already passed** the raid and ship tracks (otherwise the
 * tutorial would come up again for someone who was playing).
 *
 * ⚠ The shape a smoke plants is v2 too — `{version:2, tracks:{raid:{step:null,done:true}, ship:…, build:…}}`.
 */
export interface TutorialSave {
  version: number;
  /** appended (2026-09-14). */
  tracks?: Partial<Record<TutorialTrack, TutorialTrackSave>>;
  /** v1 — read-only backward compatibility (never written again). */
  step?: TutorialStepId | null;
  /** v1 — read-only backward compatibility (never written again). */
  done?: boolean;
  /** The room number the tutorial made for the player (when there is one). The guide line points at that room. */
  room?: number;
}

export interface TutorialRef {
  /** The tutorial is running. */
  readonly active: boolean;
  /** The current step (null when inactive). */
  readonly step: TutorialStepId | null;
  /** For the progress readout — a 1-based index and the total count. Both 0 when inactive. */
  readonly stepIndex: number;
  readonly stepCount: number;

  /**
   * Whether this action is blocked by the tutorial right now. Blocked = a **Korean reason**, else null.
   * With the tutorial off it is always null, so a call site can carry on with `?? the normal rule`.
   */
  blockReason(gate: TutorialGate, id?: string): string | null;
  /**
   * Whether that element must **not be drawn** right now.
   *   • With an `id` it asks about that one entry — everything `blockReason` blocks is hidden
   *     (room purposes · furniture defs · recipes · screen tabs …).
   *   • Called without an `id` it asks "is this gate **fully** open". When it is not, that UI is narrowed
   *     (the community button · the matchmaking section · the planet pager arrows).
   */
  hides(gate: TutorialGate, id?: string): boolean;

  /** Start from the beginning (nothing happens when it is already running). */
  start(): boolean;
  /** Skip — ends at once and releases every gate. */
  skip(): void;
  /** dev console only: skips to a particular step. */
  goto(step: TutorialStepId): boolean;

  /* ── appended (2026-09-14): 3 tracks ── */
  /** The track running right now (null when inactive). */
  readonly track: TutorialTrack | null;
  /** Whether that track is over — true for both running it to the end and skipping it. false when it has not started yet. */
  isTrackDone(track: TutorialTrack): boolean;
  /** Starts that track from the beginning. false when it is already over or another track is running. */
  startTrack(track: TutorialTrack): boolean;
  /**
   * Skips **that track alone** (the skip button on the objective panel · a 1 s hold). The other tracks stay and
   * start in their own time — because someone knows the controls but has never extended a ship (user's decision).
   */
  skipTrack(track: TutorialTrack): void;
  /**
   * appended (2026-09-15, abandoning a raid from the title): **wipes** that track's progress back to the starting
   * state (it is not written down as over) — a character who abandoned the tutorial raid does the tutorial again
   * from the beginning on the next start. Other tracks are not touched.
   */
  restartTrack?(track: TutorialTrack): void;

  /* ── appended (2026-09-18): the objectives are drawn on **another screen** too ── */
  /**
   * The contents of the running track's objective panel (null when inactive). It is **the same data** the tutorial
   * draws in its own top-left panel — the tactical map draws the same lines at the top of its left column
   * (`ui/map/QuestPanels`, user's decision 2026-09-18). It is a read-only snapshot, so the caller can change
   * nothing, and where it is not implemented (an old call site · a test) it simply is not drawn.
   */
  panelInfo?(): TutorialPanelInfo | null;
}

/**
 * **The progress tag of a counted objective** (2026-09-18) — the `1/2` of `벌레 처치 (1/2)`, the `1,000 / 1,000 C` of a
 * loot objective.
 *
 * Two screens draw the same line: the top-left guide panel (`tutorial/ui/Panel`) and the tactical map's left column
 * (`ui/map/QuestPanels`). Writing the same fact in two places on its own makes them drift — and the map side did
 * drift, writing `1000 / 1000 C`, and a smoke caught it. So the wording is made in this one place (`CLAUDE.md` §4.1
 * 「the same formula in two folders moves to shared」). The digit grouping uses the shared notation
 * (`numberFormat.groupDigits`), and only a line with a unit gets the commas and the spacing — a number with no unit
 * (a kill count) is one or two digits, so `1/2` reads better. The parentheses are added by the caller (only the
 * panel uses them).
 */
export function tutorialCountLabel(at: number, total: number, unit?: string): string {
  return unit ? `${groupDigits(at)} / ${groupDigits(total)} ${unit}` : `${at}/${total}`;
}

/** One objective line of `TutorialPanelInfo` (2026-09-18). */
export interface TutorialObjectiveInfo {
  id: string;
  /**
   * The text to draw. **The keycap tokens are still live** (`{INTERACT}` · `{JUMP:hold}` — resolved with
   * `shared/keycap.renderKeyText`) and an optional objective's `(선택) ` prefix is **already attached** (the rule
   * that makes the wording has to live inside the tutorial folder).
   */
  text: string;
  optional: boolean;
  done: boolean;
  /** For a counted objective the current count · the target count · the unit (`C`), else null. */
  count: { at: number; total: number; unit?: string } | null;
}

/** For when the progress bar measures **the objective itself rather than the step count** (2026-09-18) — the loot value of the 「출격 안내」 raid. */
export interface TutorialGaugeInfo {
  at: number;
  total: number;
  /** The already-written number label — it writes the **real value** even when `at` goes past `total` (`1,400 C / 1,000 C`). */
  label: string;
}

/** The contents of one objective panel (2026-09-18) — the track name · the progress · the visible objective lines. */
export interface TutorialPanelInfo {
  track: TutorialTrack;
  /** The track name (`조작 안내` · `함선 안내` · `증축 안내` · `출격 안내`). */
  label: string;
  step: TutorialStepId;
  /** The 1-based index within the track · the step count. */
  index: number;
  count: number;
  /** Only the lines **visible right now** (the result of the sequential reveal already resolved). */
  objectives: readonly TutorialObjectiveInfo[];
  /** Only when the progress bar measures the objective itself (else null → `index / count` is used). */
  gauge: TutorialGaugeInfo | null;
}
