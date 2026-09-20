# src/tutorial — New-character guidance (`TutorialSystem`)

Guides a new character through **four** tracks, each skippable on its own: ① `raid` (hand-built tutorial planet,
`ctx.missionMode === 'tutorial'`), ② `ship` (first personal-ship visit after completing the raid), ③ `build`
「증축 안내」 (untouched personal ship: housing → crafting → equipping the rifle), ④ `raid2` 「출격 안내」 (cockpit →
launch → the first real raid — 2026-09-18). Publishes `ctx.tutorial` (`TutorialRef`, contract in
`src/shared/tutorial.ts`). Exactly one track runs at a time; progress (`stepIndex` / `stepCount`) counts within it.
Design source: `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」.

Progress is judged only by observing bus events. Order is enforced by other folders calling
`ctx.tutorial?.blockReason()` / `hides()` inside their own "why not" functions — the tutorial never reaches into other
folders, and other folders do not know its steps. When inactive, both always return `null` / `false`.

## Files

| File | Responsibility |
|---|---|
| `TutorialSystem.ts` | `GameSystem` + `TutorialRef`: four-track step machine (`TUTORIAL_TRACKS`), event subscriptions, localStorage save (v2), material grants, raid skip fade, dev console command `tutorial`. |
| `model.ts` | Folder vocabulary, no state: storage key / blocker token / track labels (`TRACK_LABEL_KO`, `BUILD_TRACKS` = the two in-ship tracks `build` · `raid2`), `creditGaugeLabel`, tutorial ids (`furn_bench_gun`, `make_wpn_ar`, `make_ammo_medium`), `TUTORIAL_CRAFT_GRANT`, `TUTORIAL_STASH_WHITELIST`, guide and marker numbers, `StepDef` / `TutorialObjective` types, `visibleObjectives` / `objectiveChain`, control-hint table (`TUTORIAL_CONTROL_HINTS`, `controlHintsFor`, `crouchHints`, `STANCE_HINT_IDS`, `CONTROL_SECTIONS`), `CHECKPOINT_STEP`, `RAID_KILLS_PER_STEP`, `HUD_GEAR_STEP` / `HUD_STAMINA_STEP`, `CORPSE_MARKER_STEPS`, wake-reveal / TIP / skip-fade timings, spotlight constants `SPOT_CRAFT_CLOSE` / `SPOT_NONE`. |
| `Steps.ts` | Step table: title, hint, `objectives`, `allow` (gates), spotlight (`spot`, `spotUnion`, `spotNoDim`, `spotText`), floor guide (`guide`, `arriveObjective`). No progress conditions. `nextStep` / `stepIndexOf` / `stepCountOf` count within the step's track; `normalizeStep` / `isOrderedStep` map retired ids. |
| `parts/Gates.ts` | Pure gate functions `blockReason` / `hides`, HUD reveal (`hudHidden`), stash whitelist. |
| `parts/Spotlight.ts` | UI focus: four dim plates + ring + callout. Plates eat clicks, the hole passes them. Union mode (one rect around every match), no-dim mode (transparent plates, clicks pass). Targets the first *rendered* copy of each selector (`firstShown`). Yields to confirm popups. |
| `parts/Guide.ts` | Floor guide: flowing dashed strip (shader) + target pillar + ring, targeted by `Interactable.id`. Never shown while housing mode (`ctx.housing.shipManageMode` / `housingMode`) is open — `TutorialSystem.refreshVisuals` passes `null` then. |
| `parts/Marker.ts` | 3D target marker (vertical line + bobbing chevron) over the nearest `kind === 'corpse'` interactable during `CORPSE_MARKER_STEPS`. One merged geometry, one basic material, no light. |
| `ui/Panel.ts` | Top-left objective panel: glyph + track name, checkbox objective rows, track progress bar (`setGauge` — the 「출격 안내」 raid step measures carried loot value instead of steps and prints the real number above the bar, `.tut-bar-n`). Holds the next step's rows for `TUTORIAL_STEP_DELAY_S` so the check / strike-through animation shows. Renders key tokens (`renderKeyText`) in both text and strike layers; `setCounts` patches only the `(n/m)` node. |
| `ui/Controls.ts` | Right-side control guide: only the current step's controls, grouped by section. `set(hints)` removes missing rows, adds new ones, relabels survivors (no flicker). Keycaps via `shared/keycap` (`paintKeycap`, token rows via `renderKeyText`). |
| `ui/Tip.ts` | `TIP` toast under the control guide; opacity animated in `update(dt)`. Used once per raid track for crouch-aim. |
| `ui/Popup.ts` | Intro card and skip-confirm card (1 s hold). Modeless. Hides (not closes) for the length of a cutscene — `setHidden`. |
| `tutorial.css` | Styles for panel, controls, tip, popup, spotlight. Reuses `.ui-btn` / `.ui-label` from `ui/styles/base.css`. |
| `index.ts` | Barrel. |

## Public API

- **`ctx.tutorial: TutorialRef`** — `active`, `step`, `stepIndex`, `stepCount`, `track`, `blockReason(gate, id?)`,
  `hides(gate, id?)`, `start()`, `skip()`, `goto(step)`, `isTrackDone(track)`, `startTrack(track)`, `skipTrack(track)`,
  `restartTrack(track)` (clears that track back to not started — `game/parts/Resume` calls it for a tutorial raid abandoned
  from the title, so the next start replays it from the beginning).
  `ui/menus/enterShip` uses `isTrackDone('raid')` to decide whether a new character starts in the tutorial raid.
  The ESC menu calls `skipTrack`.
- **`panelInfo(): TutorialPanelInfo | null`** (2026-09-18) — a read-only snapshot of exactly what the objective panel
  draws (track label · step · `index`/`count` · the **visible** objective rows with `done` and their counts · the
  credit `gauge` on the 「출격 안내」 raid step). `ui/map/QuestPanels` is the only consumer — the map's left column
  draws the same rows above the NPC quest list. Null while no track runs, so the map draws nothing.
- **Emits**: `tutorial:changed {active, step, index, count, track?}` (also re-emitted when stamina is first used, so HUD
  gates re-query), `tutorial:finished {skipped, track}`, `ui:screenFade` (raid skip), `ui:notify`.
- **Consumes** (main ones): `hub:entered`, `hub:left`, `game:newMission`, `world:ready`, `game:phaseChanged`,
  `game:complete`, `game:abort`, `tutorial:checkpoint` (owner `world/tutorial`), `player:introWakeDone`,
  `player:stanceChanged`, `player:aimChanged`, `player:sprintChanged`, `player:staminaDepleted`, `player:fell`,
  `player:stimUsed`, `quick:equipped`, `grenade:exploded`, `enemy:spawned`, `enemy:killed`,
  `extraction:departureStarted`, `extraction:liftoff`, `inventory:opened` / `closed` / `containerOpened` / `changed` /
  `bagChanged`, `loadout:changed`, `craft:completed`, `ui:craftToggled`, `ui:keyGuide`, `housing:*` (manage / mode open and
  close, purpose, facility, craft, selection, placement), `hub:terminalToggled`, `hub:planetChanged`, `hub:travel`,
  `hub:slotChanged`, `progress:statChanged`, `ui:cinematic`, `input:bindingsChanged`.
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
| 13 | `supplyLoot` | bandage from corpse (required), grenade (optional) | bandage held → `inventory:closed`; checkpoint `wall` / `ship` only at full HP |
| 14 | `heal` | equip bandage → (revealed) use it. Skipped silently at full health | `player:stimUsed`; checkpoint `wall` / `ship` only at full HP |

**Heal-safe folding** (`TutorialSystem.healSafeFold`): a checkpoint whose target lies past `heal` never folds past an
unhealed player — below full HP it stops at `supplyLoot` (or stays at `supplyLoot` / `heal`). The extraction fold
(`extraction:departureStarted` / `liftoff` → `extract`) is not guarded. Fall damage now bypasses the armor shield
(player/), so the `drop` actually costs HP.
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

## Track ② `ship` (1 step)

2026-09-16 2nd pass (user decision): `levelUp` left the order too, so the track is the one step `stats` — its four
objectives open one at a time.

| # | id | Objectives (in reveal order) | Advances on |
|---|---|---|---|
| 1 | `stats` | `{INVENTORY} 메뉴 열기` → `캐릭터 탭으로 이동` (both read from the screen state by `poll`) → `능력치 하나 상승` (`progress:statPending`) → `능력치 투자 확정` (hold `포인트 투자 확정`) — last step | `progress:statChanged` ticks the objective; the track ends on `inventory:closed` (or at once if closed; polled in the ship after a reload) |

No new UI: every step spotlights an existing screen. `stats` waits for the inventory to close (`onStatsConfirmed`) so the
build track's intro card, `screenTab` and `stashItem` gates never start over the open character screen; the track stays
`active` meanwhile, so Raven stays blocked. The messenger is hidden for the whole ship and build tracks (no ordered step
allows `community`). `ravenQuest` (2026-09-15) and `messenger` (2026-09-16) left the order: Raven's first contact arrives
only after the ship track is done **and no track is running** (`meta/parts/NpcQuests.tutorialBlocks` reads
`ctx.tutorial.active` / `isTrackDone('ship')`). A saved `messenger` / `ravenQuest` step loads as "ship track done"
(`Steps.retiredTrackEnd`). `isTrackDone('ship')` answers
`false` while `pendingShip` is set (raid just completed, ship track about to start) so that meta's `hub:entered`
handler cannot read the track as done before this system starts it.

## Track ③ `build` 「증축 안내」 (5 steps)

2026-09-17 (user decision): the old 17 steps are grouped into 7; each step reveals its objectives one at a time.
2026-09-18 (user decision): the last two of those seven (`terminal` · `raid`) left for their own track — see ④ below. Focus
(spotlight · floor guide · arrive check) follows the **current objective** = first visible, not-done required row
(`model.currentObjective`); a row's own `spot` / `spotText` / `spotUnion` / `spotNoDim` / `guide` / `arrive` / `allow`
override the step's. Gates a row adds (`allow`) open from the moment the row is visible (`model.mergedAllow` →
`Gates.blockReason(…, allowTable)`).

| # | id | Objectives (in reveal order) | Advances on |
|---|---|---|---|
| 1 | `intro` | intro card | card's start button |
| 2 | `manage` | `{MAP} 시설 관리 열기` → `발전기 가동` (only while the generator is Lv.0 — `objectivesFor` drops the row on new ships) → `빈 방을 작업실로 증축` | `housing:roomPurposeChanged {purpose:'workshop'}` |
| 3 | `bench` | `총기 작업대 제작` (centre modal hold button `.sm-craft .sm-craft-ok`, fallback card) → `가구 창고 탭으로 이동` (polled `.sm-tab[data-tab="store"].is-on`, or picking from the store) → `가구 배치` → `{INVENTORY} 하우징 모드 닫기` | `housing:shipManageChanged` / `modeChanged {active:false}` after placing; already closed → `pollBuild` advances |
| 4 | `craftGun` | `작업실로 이동` (arrive, guide bench) → `총기 작업대 작동` → `돌격소총 제작` → `준중량탄 제작` (materials topped up when the rifle is made) → `제작창 닫기` | `ui:craftToggled {open:false}` after the ammo (or `pollBuild` when the window is already closed) |
| 5 | `equipGun` | `{INVENTORY} 인벤토리 열기` (only `inventory:opened` or the next-frame poll — never the step-entry `isOpen`, which is still true while the bench's close is closing the window) → `돌격소총 장착` (union focus, **no dim**) | rifle equipped → waits silently for `inventory:closed` (no objective row); focus off once equipped. **the track's last step** — finishing it ends 「증축 안내」 and starts 「출격 안내」 at once (`pendingRaid2`). **Skipped silently** (`equipGunMoot` → `equipGunSkipIfMoot`) when a primary slot already holds an assault rifle (family `TUTORIAL_GUN_FAMILY` or class `AR` from `weapons.csv`, any grade, not unique) or both primary slots are occupied — asked **on entry and at the moment the inventory opens** — and at no other time: a per-frame check while the window sits open would make the 2026-09-17 rule above unreachable, because dropping the rifle into 주무기 II fills the last primary slot (2026-09-18; entry alone was not enough either — it reads a loadout the closing bench window has not settled yet) |

Retired build ids stay in `TutorialStepId` and the `Steps.ts` table. `normalizeStep` maps them to the step that absorbed
them and `load()` pre-fills the rows already done there (`Steps.retiredObjectives`): `generator` / `workshop` → `manage`,
`benchPlace` / `manageDone` → `bench`, `craftAmmo` / `openCraft` / `openBag` → `craftGun`, `stowAmmo` / `planet` /
`travel` / `board` → `terminal`. `messenger` / `ravenQuest` (ship) still load as a finished ship track (`retiredTrackEnd`).
(`terminal` and the ids folded into it now live in ④ `raid2`; `normalizeStep` is unchanged — only the owning track moved.)
While **either** in-ship track runs (`model.BUILD_TRACKS` = `build` · `raid2`) the terminal's `시뮬레이션 훈련장` button and the
ready-time launch warnings are hidden (`training` · `launchWarn`) and the stash shows only `TUTORIAL_STASH_WHITELIST`
(`stashItem`). The floor guide is hidden whenever housing mode is open. Finishing a track shows **no toast**
(2026-09-17); skipping still does.

## Track ④ `raid2` 「출격 안내」 (2 steps)

2026-09-18 (user decision): the cockpit → launch → first raid half of the old build track is its **own** track — its own
objective panel, its own ESC-menu skip and its own saved progress. The step ids did not change (`terminal` · `raid`), only
the track that owns them, so `Steps.ts`, `normalizeStep` and every objective row are untouched.

| # | id | Objectives (in reveal order) | Advances on |
|---|---|---|---|
| 1 | `terminal` | `조종석으로 이동` (guide terminal) → `조종석 터미널 작동` → `목표 행성 지정` → *(warp; `travelDone` is an unlisted id)* → `발사 슬롯으로 이동` (`revealOn: 'travelDone'`, guide pod, opens `board`) → `발사 슬롯 탑승` → `{JUMP:hold} 를 길게 눌러 시작 준비` (polled `HubRef.launchReady`) | `game:newMission` (not tutorial / training) |
| 2 | `raid` | `행성에서 가치 1,000 C 이상 아이템을 획득한 후 무사히 탈출 (n / 1,000 C)` — n = sell value (`sellPriceOf`) of carried `raidFound` items, polled every `RAID_VALUE_POLL_FRAMES`, recounted at `extraction:liftoff {aboard}` | **one attempt**: `game:complete` / `game:over` end the track (`onBuildRaidEnd`); ticked only when extracted with ≥ `TUTORIAL_RAID_EXTRACT_VALUE_C`. A `hub:entered` while still on `raid` (abandon, reload) also ends it |

- **Starts by itself** right after 「증축 안내」 is **completed** — `finish('build')` writes `pendingRaid2` and `autoStart`
  reads it in the same call, so the player presses nothing. **Skipping** 「증축 안내」 does not chain into it (the same
  rule as `pendingShip`: the skip card promises the remaining guidance will not come back), and a save that has no
  `pendingRaid2` — every profile that finished the old 7-step build track — is marked done without ever showing it.
- **Old saves**: a saved `build` step of `terminal` / `raid` (or a retired id that maps to one, e.g. `board`) is **moved**
  into `raid2` by `load()`, and `build` is written as done — the player resumes exactly where they stood. The row pre-fill
  (`Steps.retiredObjectives`) travels with it.
- The bar of the `raid` step measures the **objective, not the steps**: carried `raidFound` sell value against
  `TUTORIAL_RAID_EXTRACT_VALUE_C`, with the real number printed above it (`1,400 C / 1,000 C` — the fill clamps, the text
  does not; `model.creditGaugeLabel` → `shared/formatCredits`).

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
| `manageExit` | (allow flag in `Steps.ts`; no caller asks it) | closing housing mode — allowed from `bench` on |
| `craft` | `inventory/parts/Crafting`, `inventory/ui/CraftPanel` | only the step's recipes |
| `terminal` | `hub/parts/Interior` | terminal before its step |
| `planet` | `hub/parts/Planet`, `hub/ui/HubMenu` | only `PLANET_IDS[0]`; hides planet arrows |
| `board` | `hub/parts/Pods` | launch slot until the `terminal` step's `발사 슬롯으로 이동` row is visible |
| `training` | `hub/ui/HubMenu` | hide-only: `시뮬레이션 훈련장` button row, whole `build` **and** `raid2` track (`BUILD_TRACKS`) |
| `launchWarn` | `hub/parts/Pods.toggleReady` | hide-only: launch warning popup (no contract / no armor …), whole `build` **and** `raid2` track |
| `screenTab` | `inventory/ui/parts/Screens` | tabs other than inventory (inventory always open) |
| `matchmaking` | `hub/ui/HubMenu` | the terminal's `매칭` tab, always hidden while active |
| `community` | `ui/hud/Community` | hidden while any track runs (no ordered step allows it since 2026-09-16) |
| `stashItem` | `inventory/ui/InventoryUI`, `inventory/ui/GridView` | stash items outside `TUTORIAL_STASH_WHITELIST` — in-ship tracks only (`BUILD_TRACKS`) |
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
- Raid track: `shoot` = move/sprint | fire/aim; from `advance2` (bugs dead) a `재장전` row sits under fire / aim (also in the
  crawl's fire/aim block).
- In-ship tracks: `equipGun` (`build`) = `Tab 가방 · 장비`; `terminal` (`raid2`) clears it; `raid` (「출격 안내」's raid only) = `M 지도 / Q 전술 임플란트 /
  G(hold) 함선 지원 / V 구르기 / X 시점 변경` ─ `] 조작 가이드 숨김` (section `meta`). `Keys.GUIDE_TOGGLE` (default `]`) folds it into
  one line `] 조작 가이드 표시` in the same box (`ui/Controls.setFolded`, `.tut-controls.is-folded`); read only in
  `FOLDABLE_CONTROL_STEPS` while `isGameplayActive()`. Toasts keep starting below `.tut-controls` (folded or not).
- Hold keys use `.keycap.kc-hold`; do not invent a modifier that collides with a HUD widget class.

## Start, save, restart

- **Auto start** on `hub:entered {ship:'personal'}` (`autoStart`): ① raid marked done (being in the ship means it is
  behind); ② ship track only if `pendingShip`, else done; ③ build track only if `shipUntouched()` (no placed furniture
  besides cockpit defaults, no room purposes), else done; ④ `raid2` only if `pendingRaid2` (written by `finish` when the
  build track was **completed**, not skipped), else done. A profile with no save that does not `looksFresh()` (level 1,
  untouched ship) is marked all-done. Finishing a track in the ship calls `autoStart` again.
- **Save** `scav.tutorial` (slot-prefixed), `TutorialSave` v2: `tracks {raid, ship, build, raid2: {step, done}}`, plus
  `granted`, `benchUid`, `pendingShip`, `pendingRaid2`, `learned`, `objectives`, `topped`. A step saved under a track that
  no longer owns it is **moved** to its real track and the old one is written done (`load`) — that is how yesterday's
  `build: terminal` becomes today's `raid2: terminal`. Written on every step change. v1 (top-level
  `step` / `done`) migrates into `tracks.build` and marks raid / ship done. `isTrackDone` with no record answers
  `!looksFresh()`. Each character slot has its own save (slot-prefixed key).
- **Skip**: `skipTrack(track)` ends only that track. Intro card skip uses a 1 s hold (`SKIP_HOLD_TIME`).
- **Console**: `tutorial [start|skip|step <id>|track <raid|ship|build|raid2>|status]`.

## Material grants

`craftGun` grants `TUTORIAL_CRAFT_GRANT` once (`granted`). On entering `craftGun` (rifle recipe) and when the rifle is
crafted (ammo recipe), `ensureMaterials(recipeId)` tops up `required − owned` per ingredient, read from the recipe in `ctx.loot` (bag first, then stash). Idempotent, so
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
- Other smokes must seed `scav.s1.tutorial` as v2 with **all four** tracks done (2026-09-18: `raid2` joined), or the
  tutorial auto-starts and locks the actions they drive:
  `{version:2, tracks:{raid:{step:null,done:true}, ship:{step:null,done:true}, build:{step:null,done:true}, raid2:{step:null,done:true}}}`.
  A seed that leaves `raid2` out still works — `autoStart` marks it done because no `pendingRaid2` is set — but naming it is clearer.
- The popup **hides, never closes, while a cutscene owns the screen** (docking · warp · liftoff — `shared/cutsceneHide`):
  closing it is what advances the step, so the ship's 「모든 UI 닫기」 would let a dock skip the guide. Hiding drops the
  blocker · cursor · hold gauge too and puts them back afterwards. — `ui/Popup.ts` (`suspended`), `TutorialSystem.init`
- `stashItem` hiding applies to the in-ship tracks only (`model.BUILD_TRACKS` = `build` · `raid2`) — the ship track must
  not hide loot brought back from the raid. — `parts/Gates.ts` (`stashItemBlock`)
- A step whose **required objectives are all done** points at nothing: `refreshVisuals` clears the floor guide and the
  spotlight instead of falling back to the step's own `guide` / `spot`. Without it the launch slot's readiness hold left a
  floor line to the cockpit for the ~3 s until the pod fired — 「걸어가라」 over a player who is already strapped in. —
  `TutorialSystem.refreshVisuals` (`nothingLeft`)
- The `equipGun` skip is asked **only at transitions** — step entry, `inventory:opened` (plus the one poll frame that
  stands in for a missed open event) and `inventory:closed`: a check that runs *while* the window is open ends the step
  the instant the rifle lands in 주무기 II, which is exactly the moment 2026-09-17 decided **not** to move the objective
  behind the player's back. The close-time ask is what keeps someone who equipped a different-grade AR inside the open
  window (so `equipSlot` never ticked) from being stuck. — `TutorialSystem.pollBuild` (`equipGun`),
  `onInventoryClosed`, `equipGunSkipIfMoot`
- A counted objective's `(n/m)` text is written in **one** place (`shared/tutorial.tutorialCountLabel`), because two
  screens draw the same row — the panel and the map's left column. Writing it twice drifted once already
  (`1,000 / 1,000 C` vs `1000 / 1000 C`). The panel adds the brackets; the map's NPC quest rows keep their own `p / t`.
  — `ui/Panel.countText`, `ui/map/QuestPanels`
- Track names are not step names: anything that used to read `trackOf(step) === 'build'` must ask `BUILD_TRACKS`, because
  the steps that need it (`terminal`'s training button and launch warning) moved to `raid2` on 2026-09-18. —
  `parts/Gates.ts` (`buildOnlyHidden`)
- The floating objective panel **hides while the tactical map is open** (`ui:mapToggled` → `mapOpen`): the map's left
  column draws the same rows from the same `panelInfo()` snapshot, and the panel sits at z-index 79 over the map's 40, so
  both were on screen at once. Only the panel hides — the spotlight and the floor guide are behind the map anyway. —
  `TutorialSystem.refreshVisuals` (`mapOpen`)

Smokes: `scripts/smoke-tutorial.mjs` (build track — grouped objectives, gates, old-save mapping, raid step rows / fold / end — + the track contract, **four** tracks since 2026-09-18), `smoke-tutorial-raid.mjs`,
`smoke-tutorial-ship.mjs`, `smoke-intro-wake.mjs`.

## Recent changes

Last 5 only — older: `git log -- src/tutorial`.
- 2026-09-20 — Code comments in `*.css` translated to English (`docs/TODO.md` B-65 — the file type §4.1's pass had filtered out; 1,335 lines in 34 stylesheets tree-wide). Korean on-screen labels, csv names and decision headings kept verbatim; no selector, class name, custom property or `content:` string touched, proved by stripping every comment from both sides and comparing the whole text.
- 2026-09-19 — (B-44 · B-45) Comments realigned with the code: four tracks, not three; 「증축 안내」's last raid renamed 「출격 안내」's raid everywhere; retired steps (`openBag` · `benchPlace` · `levelUp`) described as the rows that absorbed them; the dangling 「wakes up on low HP」 line removed; pointers fixed (`TUTORIAL_CONTROL_HINTS`, `setFolded`, `bar(angle)`, `openCraft` → `craftGun`); the `TUTORIAL_STEP_DELAY_S` and panel-width numbers taken out of prose. README: ship track is 1 step.
- 2026-09-19 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels, the four track names and decision headings kept verbatim in backticks / 「」, no string literal touched.
- 2026-09-18 — 「증축 안내」 split in two: `build` now ends at `equipGun` (5 steps) and the new 4th track `raid2` 「출격 안내」 (`terminal` · `raid`) starts by itself the moment it is completed (`pendingRaid2`); old saves standing on `terminal` / `raid` are moved into it by `load()`; `training` · `launchWarn` · `stashItem` now key off `BUILD_TRACKS`.
- 2026-09-18 — `equipGun` is skipped at the moment the **inventory opens** too, not only on entry (`equipGunSkipIfMoot`; asked at those transitions only — a per-frame check ended the step as soon as 주무기 II was filled, which killed 2026-09-17's 「wait for the window to close」); a step with every required objective done clears its floor guide and spotlight (the launch-slot wait no longer points back at the cockpit); the 「출격 안내」 raid step's progress bar measures carried `raidFound` value with the real number above it (`1,400 C / 1,000 C`, `.tut-bar-n`); `panelInfo()` lets the tactical map draw the same objectives (`ui/map/QuestPanels`, counts through the shared `tutorialCountLabel`) and the floating panel hides while the map is open.
