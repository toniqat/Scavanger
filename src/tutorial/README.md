# src/tutorial — New-character guidance (`TutorialSystem`)

Guides a new character through three tracks, each skippable on its own: ① `raid` (hand-built tutorial planet,
`ctx.missionMode === 'tutorial'`), ② `ship` (first personal-ship visit after completing the raid), ③ `build` (untouched
personal ship: housing → crafting → launch). Publishes `ctx.tutorial` (`TutorialRef`, contract in
`src/shared/tutorial.ts`). Exactly one track runs at a time; progress (`stepIndex` / `stepCount`) counts within it.
Design source: `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」.

Progress is judged only by observing bus events. Order is enforced by other folders calling
`ctx.tutorial?.blockReason()` / `hides()` inside their own "why not" functions — the tutorial never reaches into other
folders, and other folders do not know its steps. When inactive, both always return `null` / `false`.

## Files

| File | Responsibility |
|---|---|
| `TutorialSystem.ts` | `GameSystem` + `TutorialRef`: three-track step machine, event subscriptions, localStorage save (v2), material grants, raid skip fade, dev console command `tutorial`. |
| `model.ts` | Folder vocabulary, no state: storage key / blocker token / track labels, tutorial ids (`furn_bench_gun`, `make_wpn_ar`, `make_ammo_medium`, `npc_raven`), `TUTORIAL_CRAFT_GRANT`, `TUTORIAL_STASH_WHITELIST`, guide and marker numbers, `StepDef` / `TutorialObjective` types, `visibleObjectives` / `objectiveChain`, control-hint table (`TUTORIAL_CONTROL_HINTS`, `controlHintsFor`, `crouchHints`, `STANCE_HINT_IDS`, `CONTROL_SECTIONS`), `CHECKPOINT_STEP`, `RAID_KILLS_PER_STEP`, `HUD_GEAR_STEP` / `HUD_STAMINA_STEP`, `CORPSE_MARKER_STEPS`, wake-reveal / TIP / skip-fade timings, spotlight constants `SPOT_CRAFT_CLOSE` / `SPOT_NONE`. |
| `Steps.ts` | Step table: title, hint, `objectives`, `allow` (gates), spotlight (`spot`, `spotUnion`, `spotNoDim`, `spotText`), floor guide (`guide`, `arriveObjective`). No progress conditions. `nextStep` / `stepIndexOf` / `stepCountOf` count within the step's track; `normalizeStep` / `isOrderedStep` map retired ids. |
| `parts/Gates.ts` | Pure gate functions `blockReason` / `hides`, HUD reveal (`hudHidden`), stash whitelist. |
| `parts/Spotlight.ts` | UI focus: four dim plates + ring + callout. Plates eat clicks, the hole passes them. Union mode (one rect around every match), no-dim mode (transparent plates, clicks pass). Targets the first *rendered* copy of each selector (`firstShown`). Yields to confirm popups. |
| `parts/Guide.ts` | Floor guide: flowing dashed strip (shader) + target pillar + ring, targeted by `Interactable.id`. |
| `parts/Marker.ts` | 3D target marker (vertical line + bobbing chevron) over the nearest `kind === 'corpse'` interactable during `CORPSE_MARKER_STEPS`. One merged geometry, one basic material, no light. |
| `ui/Panel.ts` | Top-left objective panel: glyph + track name, checkbox objective rows, track progress bar. Holds the next step's rows for `TUTORIAL_STEP_DELAY_S` so the check / strike-through animation shows. Renders key tokens (`renderKeyText`) in both text and strike layers; `setCounts` patches only the `(n/m)` node. |
| `ui/Controls.ts` | Right-side control guide: only the current step's controls, grouped by section. `set(hints)` removes missing rows, adds new ones, relabels survivors (no flicker). Keycaps via `shared/keycap` (`paintKeycap`, token rows via `renderKeyText`). |
| `ui/Tip.ts` | `TIP` toast under the control guide; opacity animated in `update(dt)`. Used once per raid track for crouch-aim. |
| `ui/Popup.ts` | Intro card and skip-confirm card (1 s hold). Modeless. |
| `tutorial.css` | Styles for panel, controls, tip, popup, spotlight. Reuses `.ui-btn` / `.ui-label` from `ui/styles/base.css`. |
| `index.ts` | Barrel. |

## Public API

- **`ctx.tutorial: TutorialRef`** — `active`, `step`, `stepIndex`, `stepCount`, `track`, `blockReason(gate, id?)`,
  `hides(gate, id?)`, `start()`, `skip()`, `goto(step)`, `isTrackDone(track)`, `startTrack(track)`, `skipTrack(track)`.
  `ui/menus/enterShip` uses `isTrackDone('raid')` to decide whether a new character starts in the tutorial raid.
  The ESC menu calls `skipTrack`.
- **Emits**: `tutorial:changed {active, step, index, count, track?}` (also re-emitted when stamina is first used, so HUD
  gates re-query), `tutorial:finished {skipped, track}`, `ui:screenFade` (raid skip), `ui:notify`.
- **Consumes** (main ones): `hub:entered`, `hub:left`, `game:newMission`, `world:ready`, `game:phaseChanged`,
  `game:complete`, `game:abort`, `tutorial:checkpoint` (owner `world/tutorial`), `player:introWakeDone`,
  `player:stanceChanged`, `player:aimChanged`, `player:sprintChanged`, `player:staminaDepleted`, `player:fell`,
  `player:stimUsed`, `quick:equipped`, `grenade:exploded`, `enemy:spawned`, `enemy:killed`,
  `extraction:departureStarted`, `extraction:liftoff`, `inventory:opened` / `closed` / `containerOpened` / `changed` /
  `bagChanged`, `loadout:changed`, `craft:completed`, `ui:craftToggled`, `ui:keyGuide`, `housing:*` (manage, purpose,
  facility, craft, selection, placement), `hub:terminalToggled`, `hub:planetChanged`, `hub:travel`, `hub:slotChanged`,
  `progress:statChanged`, `ui:messengerToggled`, `npc:message`, `npc:questChanged`, `input:bindingsChanged`.
- **Calls out**: `PlayerRef.playIntroWake`, `PlayerRef.setSceneLock`, `ExtractionRef.skipToComplete` /
  `skipToLiftoff`, `ctx.inventory` item grants, `ctx.console.register`.

## Track ① `raid` (16 steps)

The backbone is checkpoints (`tutorial:checkpoint`). A checkpoint is a section *entrance*, so `onCheckpoint` folds the
track **forward only** to `CHECKPOINT_STEP[id]` (`foldRaid`). Action-driven steps usually finish first; a late
checkpoint is ignored. Skipping any section never dead-ends: required objectives gate finishing *by action*, not folding.

| # | id | Objective | Advances on |
|---|---|---|---|
| 1 | `wake` | none — intro wake animation; panel and guide hidden | `player:introWakeDone` |
| 2 | `move` | `앞으로 이동` (revealed after `WAKE_REVEAL_DELAY_S` or `WAKE_REVEAL_MOVE_M`) | checkpoint `cliff` |
| 3 | `sprintJump` | sprint-jump the gap | checkpoint `corpse` |
| 4 | `corpseOpen` | interact with the corpse | `inventory:containerOpened` with `corpse:` id |
| 5 | `corpseLoot` | equip SMG as primary (required); bag, ammo (optional). No-dim focus on corpse grid → primary / armor slots; focus turns off once the gun is equipped or the window closes without it | gun equipped → `inventory:closed`; checkpoint `bugs`; `enemy:spawned` → `shoot` |
| 6 | `advance1` | `앞으로 이동` | `enemy:spawned` (ambush bug emerges); fallback checkpoint `crawl` |
| 7 | `shoot` | `벌레 처치 (n/m)` | `enemy:killed` × `RAID_KILLS_PER_STEP`; checkpoint `crawl` |
| 8 | `advance2` | `앞으로 이동` | checkpoint `crawl` |
| 9 | `crouch` | crouch / prone through the low gap | `player:stanceChanged` (not stand); checkpoint `android` |
| 10 | `crouchAim` | `안드로이드 처치 (n/m)`; first crouched aim shows the TIP | kills × 2; checkpoint `drop` |
| 11 | `advance3` | `앞으로 이동` | checkpoint `drop` |
| 12 | `drop` | jump down | `player:fell {damage > 0}`; checkpoint `supply` |
| 13 | `supplyLoot` | bandage from corpse (required), grenade (optional) | bandage held → `inventory:closed`; checkpoint `wall` (→ `grenade`, skipping `heal`) |
| 14 | `heal` | equip bandage → (revealed) use it. Skipped silently at full health | `player:stimUsed`; checkpoint `wall` |
| 15 | `grenade` | `앞으로 이동` (required); equip + throw a grenade (optional, any explosion counts) | checkpoint `ship` |
| 16 | `extract` | hold-interact the ship switch | `extraction:departureStarted` / `extraction:liftoff` |

- **Start**: `game:newMission {mode:'tutorial'}` or, after reload, `world:ready` with tutorial mode — both call
  `startRaidTrack()`, which returns early if the raid track already runs (the saved step is kept, the wake is not
  replayed). Completing the raid sets `pendingShip`; skipping does not.
- **Objective counts** come from `RAID_KILLS_PER_STEP` and `TutorialSystem.kills`; `onKill` updates the count before
  checking the threshold, so the last kill shows `(2/2)` before the strike-through.
- **Raid skip** (`skipTrack('raid')` inside the tutorial raid): `finish(true)` → `beginSkipFade` emits
  `ui:screenFade {1, SKIP_FADE_OUT_S, hold: true}` and scene-locks the player; when fully black
  (`updateSkipFade`, runs before the active check) → `ExtractionRef.skipToComplete()`; fallback `skipToLiftoff()` +
  fade in; last resort unlock + `game:returnToShip`. The black plate stays over the result screen; it is cleared by
  `clearSkipFade(0)` on `hub:entered` (with `game:abort` and `ui/HudSystem` as backups).

## Track ② `ship` (4 steps)

| # | id | Objective | Advances on |
|---|---|---|---|
| 1 | `levelUp` | open the inventory screen | `inventory:opened` (or a non-inventory screen tab already showing — polled) |
| 2 | `stats` | invest a point → hold `포인트 투자 확정` | `progress:statChanged` |
| 3 | `messenger` | open the messenger (`.community.show` button) | `ui:messengerToggled {open:true}` |
| 4 | `ravenQuest` | answer Raven (`npc:message` choice by `TUTORIAL_RAVEN_NPC`) → accept the quest | `npc:questChanged {state:'active'}` |

No new UI: every step spotlights an existing screen.

## Track ③ `build` (16 steps)

| # | id | Objective | Advances on |
|---|---|---|---|
| 1 | `intro` | intro card | card's start button |
| 2 | `manage` | open ship management (`.ship-hint`) | `housing:shipManageChanged {active:true}` / `housing:modeChanged` |
| 3 | `generator` | run the generator — silently skipped when already ≥ Lv.1 (always, on new ships) | `housing:facilityUpgraded {id:'generator'}` |
| 4 | `workshop` | empty room → workshop | `housing:roomPurposeChanged {purpose:'workshop'}` |
| 5 | `bench` | craft the gun bench | `housing:changed {reason:'craft'}` + `furn_bench_gun` stored |
| 6 | `benchPlace` | pick from furniture storage → place in workshop (spotlight folds once picked) | `housing:selectionChanged` → `housing:furniturePlaced` |
| 7 | `craftGun` | walk to workshop → use bench → craft assault rifle | `craft:completed {recipeId:'make_wpn_ar'}` |
| 8 | `craftAmmo` | craft medium ammo in the same window | `craft:completed {recipeId:'make_ammo_medium'}` |
| 9 | `openBag` | close the craft window | `ui:craftToggled {open:false}` / `inventory:opened` without craft column |
| 10 | `equipGun` | close craft window (if open) → equip rifle in primary I or II (union focus: slots + stash/bag panel) | `loadout:changed` with `wpn_ar` |
| 11 | `stowAmmo` | move ammo into the bag | `inventory:changed` with `ammo_medium` in bag |
| 12 | `terminal` | walk to cockpit → open terminal | `hub:terminalToggled {open:true}` |
| 13 | `planet` | pick the target planet | `hub:planetChanged` / `hub:travel {start}` |
| 14 | `travel` | wait for warp | `hub:travel {stage:'end'}` |
| 15 | `board` | walk to launch slot → board | `hub:slotChanged` (local) / `game:newMission` |
| 16 | `raid` | find the extraction marker | 6 s after `world:ready` |

`openCraft` and `manageDone` stay in `TutorialStepId` and the `Steps.ts` table but not in `TUTORIAL_STEPS`;
`normalizeStep` maps old saves (`openCraft` → `craftAmmo`, `manageDone` → `craftGun`) and `setStep` passes through
`manageDone` if set externally. "Walk to X" rows are ticked by `arriveObjective` when the player enters the guide
target's interaction range (polled; no coordinates in this folder).

## Objectives

- Each step has `objectives` (required + `optional`). Required rows are all ticked when the step advances
  (`completeRequired`); optional rows only when actually done (`markObjective`). Text is a short noun phrase with key
  tokens (`{QUICK:hold}`), redrawn on `input:bindingsChanged`. Only completed rows are greyed.
- Sequential reveal: `reveal: true` shows a row only after the previous one is done; `revealOn: '<id>'` opens it on an
  outside event. `visibleObjectives` closes every row after the first unopened one. `markObjective` also marks the reveal
  chain before it (`objectiveChain`) so doing a later row first never hides the rest.
- Achieved objective ids of the current step persist in the save (`objectives`), cleared on step change.

## Gates

`Steps.ts` `allow` lists what each step permits; any gate not listed is blocked (strict order). Reasons surface in the
caller's existing UI. Blocked items are **hidden**, not shown locked: `hides(gate, id)` = `blockReason !== null`;
`hides(gate)` without id = "is this gate fully open".

| Gate | Caller | Effect |
|---|---|---|
| `roomPurpose` | `housing/parts/Rooms`, `ui/hud/ShipManage` | only workshop |
| `furniture` | `housing/parts/Furniture`, `ui/hud/ShipManage` | only gun bench craft / place |
| `manageExit` | (allow flag in `Steps.ts`) | closing management |
| `craft` | `inventory/parts/Crafting`, `inventory/ui/CraftPanel` | only the step's recipes |
| `terminal` | `hub/parts/Interior` | terminal before its step |
| `planet` | `hub/parts/Planet`, `hub/ui/HubMenu` | only `PLANET_IDS[0]`; hides planet arrows |
| `board` | `hub/parts/Pods` | launch slot before its step |
| `screenTab` | `inventory/ui/parts/Screens` | tabs other than inventory (inventory always open) |
| `matchmaking` | `hub/ui/HubMenu`, `hub/ui/MatchPanel` | always hidden while active |
| `community` | `ui/hud/Community` | hidden unless the step allows it (ship track messenger) |
| `stashItem` | `inventory/ui/InventoryUI`, `inventory/ui/GridView` | stash items outside `TUTORIAL_STASH_WHITELIST` — build track only |
| `hud` | `ui/hud/Vitals`, `WeaponPanel`, `ImplantWidget`, `StratagemPanel`, `Compass`, `Objective`, `WorldMarkers`, `ui/map/MapScreen`, `inventory/ui/ImplantPanel` | hide-only HUD reveal, raid track only |

HUD reveal (`TutorialHudPart`, `parts/Gates.hudHidden`): `vitals` / `weapon` hidden through `HUD_GEAR_STEP`; `stamina`
until first use (latest after `HUD_STAMINA_STEP`); `implant`, `stratagem`, `shipMarker`, `shipScreenMarker`,
`extractionTimer` hidden for the whole tutorial raid. Widgets hide via `.hud-tut-hidden` (`ui/styles/raidHud.css`).

## Control guide

- `TUTORIAL_CONTROL_HINTS[step]` = every row visible in that step. A step **absent** from the table keeps the previous
  rows (`undefined` = keep, `[]` = clear) — `wake`, `sprintJump`, `drop`.
- Rows hold key action names and tokens only; keycaps are painted from `Keys` at draw time.
- Crouch / prone labels follow the current stance (`crouchHints`) whenever a visible row id is in `STANCE_HINT_IDS`;
  stance is read from `ctx.player.stance`.
- The guide folds while the inventory screen is open. Current row ids persist in `learned`.
- Hold keys use `.keycap.kc-hold`; do not invent a modifier that collides with a HUD widget class.

## Start, save, restart

- **Auto start** on `hub:entered {ship:'personal'}` (`autoStart`): ① raid marked done (being in the ship means it is
  behind); ② ship track only if `pendingShip`, else done; ③ build track only if `shipUntouched()` (no placed furniture
  besides cockpit defaults, no room purposes), else done. A profile with no save that does not `looksFresh()` (level 1,
  untouched ship) is marked all-done. Finishing a track in the ship calls `autoStart` again.
- **Save** `scav.tutorial` (slot-prefixed), `TutorialSave` v2: `tracks {raid, ship, build: {step, done}}`, plus
  `granted`, `benchUid`, `pendingShip`, `learned`, `objectives`, `topped`. Written on every step change. v1 (top-level
  `step` / `done`) migrates into `tracks.build` and marks raid / ship done. `isTrackDone` with no record answers
  `!looksFresh()`. Each character slot has its own save (slot-prefixed key).
- **Skip**: `skipTrack(track)` ends only that track. Intro card skip uses a 1 s hold (`SKIP_HOLD_TIME`).
- **Console**: `tutorial [start|skip|step <id>|track <raid|ship|build>|status]`.

## Material grants

`craftGun` grants `TUTORIAL_CRAFT_GRANT` once (`granted`). On entering `craftGun` / `craftAmmo`, `ensureMaterials(recipeId)`
tops up `required − owned` per ingredient, read from the recipe in `ctx.loot` (bag first, then stash). Idempotent, so
csv recipe changes never break the tutorial.

## Rules

- Call `PlayerRef.playIntroWake` from `update()` via `pendingWake`, never inside the `game:newMission` / `world:ready`
  emit — `PlayerSystem` cancels it later in the same emit. — `TutorialSystem.ts` (`startRaidTrack`, `consumePendingWake`)
- Spotlight selector lists that swap at runtime must be module constants: `Spotlight.set` compares arrays by reference,
  a fresh array every refresh keeps the focus off forever. — `model.ts` (`SPOT_CRAFT_CLOSE`)
- `CHECKPOINT_STEP.bugs` opens `advance1`, not `shoot`; `shoot` opens on the actual spawn. The checkpoint cannot move —
  respawn points must stay outside enemy detection. — `model.ts` (`CHECKPOINT_STEP`)
- Step ids are contract (`src/shared/tutorial.ts`, add-only): retire a step by removing it from the order arrays and
  mapping it in `normalizeStep`, keep its `Steps.ts` entry.
- Other smokes must seed `scav.s1.tutorial` as v2 with **all three** tracks done, or the tutorial auto-starts and locks
  the actions they drive:
  `{version:2, tracks:{raid:{step:null,done:true}, ship:{step:null,done:true}, build:{step:null,done:true}}}`.
- `stashItem` hiding applies to the build track only — the ship track must not hide loot brought back from the raid. —
  `parts/Gates.ts` (`stashItemBlock`)

Smokes: `scripts/smoke-tutorial.mjs` (build track + three-track contract), `smoke-tutorial-raid.mjs`,
`smoke-tutorial-ship.mjs`, `smoke-intro-wake.mjs`.

## Recent changes

Last 5 only — older: `git log -- src/tutorial`.
- 2026-09-15 — Raid skip keeps the black plate (`hold: true`) over the result screen; cleared on `hub:entered`.
- 2026-09-15 — New raid step `corpseOpen` (16 steps); objective counts `(n/m)`; objective panel text ×1.2.
- 2026-09-15 — `supplyLoot` step, per-section skipping, objective noun phrases with key tokens, crouch-aim TIP, raid skip = fade → result screen.
- 2026-09-15 — `grenade` required objective text `앞으로 이동`.
- 2026-09-15 — Ship track fixes found by `smoke-tutorial-ship` (messenger spotlight, Raven choice tick).
