# src/shared/ — cross-folder contracts

Everything every feature folder depends on: types, bus events, constants (names only — values come from `data/*.csv`),
key bindings, csv loaders, the `*Ref` interfaces other folders publish on `ctx`, and pure formulas that more than one
folder must compute identically. Feature folders import only `@/shared` (`index.ts` re-exports the modules below),
never each other. This folder owns no system and no gameplay state; it must not import any feature folder.

## Files

| File | Contract it holds |
|---|---|
| `index.ts` | Barrel — `import … from '@/shared'`. Every new module is appended here |
| `data/csv.ts` | csv parser + cell accessors (`num` · `int` · `bool` · `enum` · `list` · `costList`), `=CONST` expression evaluator, issue collector (`dataIssues` · `addDataIssue`). Imports nothing (`constants.ts` uses it) |
| `data/tables.ts` | Bundles `data/*.csv` via `import.meta.glob(…, '?raw')`; table helpers `csvRows` · `csvGroups` · `keyTable` · `numberMap` · `numberList` · `stringMap` · `stringList` · `costLevels`; resolves `=` names constants → tuning → `table.KEY` |
| `constants.ts` | Scalar tuning names (`K.num('NAME')` from `data/constants.csv`, tables from `data/tables.csv`), `Layers`, mutable `Keys` table + `DEFAULT_KEYS`, `MouseButtons`, storage keys, save-format versions (`PROFILE_VERSION`, `SHIP_STATE_VERSION` — literals on purpose) |
| `types.ts` | Core game types (`GamePhase`, `MissionStats`, `MissionMode`, items / weapons / enemies / world geometry `Obstacle`) and most `*Ref` interfaces: `WorldRef` (+ `FogRef` · `HazardRef` · `TrainingRef` · `RoverRef`), `PlayerRef`, `EnemyManagerRef` / `EnemyRef`, `InventoryRef`, `LootRef`, `HubRef`, `PickupsRef`, `WeaponsRef`, `StratagemsRef`, `CorpsesRef`, `AudioRef`, `PortraitRef`, `Interactable`, `GameSystem`, `EmbeddedView` |
| `events.ts` | `GameEvents` — every bus event name → payload type, grouped by owner; `KeyGuideEntry` / `KeyGuideKey` |
| `EventBus.ts` | Typed synchronous emitter (`on` / `once` / `off` / `emit`) |
| `GameContext.ts` | `ctx`: bus, input, interactables registry, scene / camera / renderer, every published ref (see below), `phase` + `setPhase`, `missionMode` / `missionPlanet` / `missionIntel`, `uiBlockers`, `escape`, `isGameplayActive` / `isControlActive` / `isHubPhase` / `isRaidActive` / `isTraining`, `isAuthority` / `isMultiplayer` |
| `Input.ts` | Keyboard / mouse state with per-frame pressed / released sets (mouse buttons mirrored as `Mouse0..4` key codes), pointer lock (deferred re-lock, bounce filter, fullscreen keyboard lock, click-to-relock), `setCursorMode`, `onUserUnlock`; `endFrame()` called by Engine |
| `cursor.ts` | `CursorMode` — ref-counted "real OS cursor" flag behind `Input.setCursorMode`; `isDesktopShell()` |
| `escape.ts` | `EscapeStack` (`ctx.escape`) — LIFO of open screens' Escape handlers (`push` / `remove` / `closeTop`); a close returning `false` keeps its entry |
| `cutsceneHide.ts` | `watchCutsceneHide(ctx, onChange, {kinds})` — "a cutscene owns the screen" as one line (`hub:docking` · `hub:travel` · `ui:cinematic`, six reset events); a popup that cannot be closed hides instead of closing. Returns its unsubscribe (restores on teardown) |
| `Keybinds.ts` | `KEY_ACTION_DEFS` (label / group / scope / `mouseOnly` / `menuOnly`), `KEY_ALIASES`, `loadKeybinds` / `setKeybind` / `resetKeybinds` / `saveKeybinds` (`scav.keybinds`, non-defaults only), `canBind`, `conflictsOf` / `allConflicts`, `keyLabel`, `takeKeybindLoadReport` |
| `keycap.ts` | The one keycap renderer: `createKeycap` · `paintKeycap` · `renderKeyText` (tokens `{ACTION}` · `{ACTION:hold}` · `{br}`) · `createHoldButtonCap` (LMB-hold cap inside hold buttons) · mouse L/wheel/R glyphs. Styles in `ui/styles/base.css` (`.keycap`, `.kc-hold`, `.kc-mouse`, `.kc-btn`) |
| `holdAsk.ts` | `openHoldAsk(ctx, spec)` — reusable warning popup: `hold` buttons need `UI_HOLD_CONFIRM_S`, Escape = cancel, Enter swallowed, owns its blocker / cursor / escape entry, injects `.sh-ask*` styles |
| `itemChip.ts` | DOM chips: `buildItemChip` (stamps `data-def-id` for `ui/hud/ItemTip`), `renderItemCost`, `buildFacilityChip`, favourite hooks (`setItemChipFavoriteSource`, `ITEM_FAVORITE_MENU_ATTR`, `ItemFavoriteApi`) |
| `currency.ts` | Non-item rewards (credits · XP · per-corp reputation): `CURRENCY_DEFS` (`data/currencies.csv`), `buildCurrencyChip`, `appendCurrencyRewards`, `groupDigits` |
| `labels.ts` | Rarity order / colours / Korean labels, rarity ↔ weapon grade, category label / colour / icon, env labels |
| `saveSlot.ts` | Character save slots: `slotKey` (`scav.profile` → `scav.s2.profile`), `SHARED_KEYS` (never prefixed), `activeSlot` / `setActiveSlot`, `ensureMigrated`, `readSlotCards`, `deleteSlot`, `markAutoStart` / `takeAutoStart` |
| `raidResume.ts` | Title resume / abandon contract (`ctx.raidResume`, owner game/): `RaidResumeKind`, `RaidResumeMember`, `RaidResumeOffer`, `RaidResumeRef` (`offer`, `checking`, `settled`, `resume`, `abandon`), `SQUAD_RAID_MARK_KEY`. Related: `raid:resumeChanged`, `LobbyPlayer.drifted`, `lobby:abandon`, `lobby:mission.keep`, `RaidSessionBlob.pose`, `TutorialRef.restartTrack` |
| `character.ts` | New-character rules (`CREATE_STAT_*` from `CHAR_STAT_*`), `canAdjustStat`, `rollCreateStats`, `rollCallsign`, accent palette, `makeCharacterProfile`, `createCharacterInSlot` |
| `progression.ts` | `StatId`, `SkillId`, `PlayerProfile`, `DerivedStats`, perks, `EquippedImplant`, gym stats, `ProgressionRef` (`ctx.progression`) |
| `gear.ts` | `ArmorDef` (`shield`), `EquipSlot`, weight state, durability info, `CraftRecipe` / `CraftIngredient` / `CraftStation` (bag and pouch defs live in `types.ts`) |
| `implants.ts` | `ImplantId`, `IMPLANT_IDS` (selectable ones), `ImplantDef` modes (`instant` / `hold` / `wielded`), `ImplantsRef` (`ctx.implants`: barrier queries, bash, energy) |
| `gadgets.ts` | `GadgetId`, `GadgetDef`, `DeployableRef`, `GadgetsRef` (`ctx.gadgets`, incl. `getFireZones`) — deployables are host-authoritative (`gad` / `gadq`) |
| `drones.ts` | `DroneKind`, `DroneRef` / `DronesRef` (`ctx.drones`), drone scan types, `DroneWire` / `DroneMessage` / `DroneRequest` — drones are owner-authoritative |
| `named.ts` | Named rogues: `NamedRogueType`, `NAMED_ROGUE_TYPES`, Korean names |
| `extraction.ts` | `ExtractionStage`, `ExtractionRef` (`ctx.extraction`: `keepEnemyOut`, `holdFire?`, `skipToLiftoff?`, `skipToComplete?`, stage mirrors) |
| `housing.ts` | Ship housing: room purposes, cockpit block (`COCKPIT_ROOM_INDEX`), furniture defs (`data/furniture.csv`), shelves / library media, music player state, mining tabs, analyzer slots, `ShipState`, `HousingRef` (`ctx.housing`) |
| `library.ts` | Library series / media effects / video games: series loader (`data/library_series.csv`), `LibraryEffect`, `librarySeriesFraction`, `resolveItemAlias` (`data/item_aliases.csv`), `GameDiscDef`, `GymGameTuning`, TV seat interactions |
| `meals.ts` | Meal table (`data/meals.csv`): `MEAL_DEFS`, `MEAL_DEF_MAP`, `getMealDef`, `isMealDefId`, `MealItemDef` (ItemDef-shaped display def — meals are **not** items since 2026-09-16) |
| `cooking.ts` | Cooking minigames (`CookGame`), step table `cookStepsOf` (`data/cook_steps.csv`), grill times, `COOK_*` judge values, auto-cook appliances, meal quality (`mealQualityForScore` · `mealQualityBonus` · `normalizeMealQuality`), session / result shapes |
| `charBuffs.ts` | `CharBuff` list shape (display + sync only): kinds, order, labels, `sanitizeCharBuffs`, `sameCharBuffs`, `charBuffTitle` |
| `charBuffView.ts` | Factory slot for the buff thumbnail strip: ui registers `BuffStrip` (`provideCharBuffStrip`), other folders get one with `createCharBuffStrip(parent, {mini, interactive})` (null without ui) |
| `meta.ts` | Corps, reputation table, contracts, shop rules, price helpers, `formatCredits`, `MetaRef` (`ctx.meta`) + `IntelRef`; `QUEST_DEFS` (empty) — all from csv |
| `npc.ts` | Messenger NPCs / NPC quests / objectives loaders (`data/npcs.csv` · `npc_quests.csv` · `npc_objectives.csv`), `NPC_FLAGS`, `NpcSave`, `NpcQuestRef` (`ctx.meta.npc`) |
| `intel.ts` | Intel broker, **relay-shared pure module**: `IntelGimmick`, `IntelPick`, `IntelEffects`, `resolveIntelEffects`, `intelCost`, `intelCode` / `parseIntelCode`, `sanitizeIntelPicks` |
| `intelDefs.ts` | Intel csv loader (`data/intel_options.csv`) — browser side of `intel.ts` |
| `credits.ts` | **Relay-shared pure module**: credit reason grammar (`formatCreditReason` · `parseCreditReason`), `EconomyTable`, price formulas (`buyPriceFrom` · `sellPriceFrom` · `table*`), `CreditLedger`, per-hour caps, `CREDIT_DEV_ENV` |
| `crypto.ts` | Coin defs (`data/crypto.csv`) + mining / trade numbers (browser only) |
| `cryptoMarket.ts` | **Relay-shared pure module**: chart ranges / candle sizes, `CryptoCandle`, `cryptoTradeCredits`, `miningCycleMs`, `formatCryptoUnits` |
| `profile.ts` | **Relay-shared**: `ProfileDocKey`, `ProfileRecord` (docs, `docsRev`, social, ledger), `RaidSessionBlob`, `ProfileRef` (`ctx.net.profile`: `get` / `set` / `setMany` / `flush` / `addCredits`), size caps, `PROFILE_GC_INACTIVE_MS`, `PROFILE_QUEUE_STORAGE_KEY` |
| `social.ts` | **Relay-shared**: player codes (`playerCodeFrom` · `formatPlayerCode`), presence, friends / requests / blocks / private chat (`WhisperLine`, `PRIVATE_CHAT_LABEL_KO`), squad invites, `playBlockReason`, group rooms (`RoomRecord` · `RoomLine` · `RoomsRef` · limits · sanitizers), `SocialRef` |
| `net.ts` | **Relay-shared**: lobby types, `ClientToServer` / `ServerToClient`, relayed `GameMessage` union, `PlayerSnapshot` / `PlayerFlags`, `NetRef` / `RemotePlayerRef` / `RemoteAvatarRef` / `CryptoMarketRef`, net tuning, relay address (`RELAY_STORAGE_KEY` · `relayUrlFrom` · `RelayProbe` · `lanAddresses`), `sanitizePlayerName` |
| `planets.ts` | **Relay-shared** planet ids only (`PlanetId`, `PLANET_IDS`, `isPlanetId`, `PLANET_STORAGE_KEY`) |
| `planetDefs.ts` | Planet table (`data/planets.csv`): `PLANET_DEFS`, `getPlanet`, `planetTier`, `planetThreat`, ecosystem, labels — browser only |
| `buffRules.ts` | Receiver-side buff guard: `createBuffGuard` (token buckets, multiplier / duration caps, ranges), `buffSenderOf`, `buffLineClear` |
| `damageSource.ts` | Local gun-hit window: `withLocalGunHit(cls, fn)` (weapons) / `localGunHitClass()` (enemies) — NPC "kill with weapon class" objectives |
| `raidFound.ts` | "Found in this raid" item mark: `raidFoundSeed`, `markRaidFound`, `mergeRaidFoundMark`, `raidFoundScopeOf`, `countsForRecovery`, `raidFoundStackKey` |
| `lootRolls.ts` | Loot seed formulas `crateLootRandom` · `corpseLootRandom` (open path and preview path share them) |
| `shotSounds.ts` | The one shot-sound table: `WeaponKind` (the six uniques included), `weaponClassOfDef` · `weaponKindOf` · `shotSoundId` · `shotSoundOfDef`. `weapons/WeaponDefaults` and `player/AllyAvatars` are both call sites — they used to judge this separately and the android's copy knew no uniques, so a legendary fired the rifle sample (B-63) |
| `ballistics.ts` | Artillery shell closed form (`shellLaunchVelocity` · `shellPositionAt` · `shellApexHeight`, uses `SHELL_ARC_GRAVITY`) — enemies + HUD |
| `explosion.ts` | Explosion falloff (`explosionFalloff` · `explosionDamage` · `explosionDamageRange` for tooltips): two-step curve from `EXPLOSION_FULL_FRACTION` / `EXPLOSION_OUTER_MUL` — all explosives. Occlusion: `blastReachesBody` (blast centre ↔ body feet · chest · head, any clear ray = hit), `meleeReachesBody` (attacker head ↔ the same 3 points), `lineClear` — all over `WorldRef.raycastBlast` (2026-09-18: the glass-blocking ray, so a broken window no longer lets a blast into a room), numbers `BLAST_LOS_*` / `MELEE_LOS_SLACK_M` |
| `fragile.ts` | `breakFragileAlong(world, from, to)` — thrown objects break window glass on their step segment |
| `ride.ts` | Vehicle ride math (`recordRideLocal` · `restoreRideLocal` · `rideContains`) — player, enemies, corpses |
| `lightPool.ts` | Point-light pool: many `LightFixture` spots, `size` real lights moved to the nearest (intensity only) — hub + structures |
| `render.ts` | `ShaderWarmupRef` (`ctx.shaders`: `warm`, `hold*`, `pointLightBudget`), `OutlineRef` / `OutlineChannel` (`ctx.outline`) |
| `viewZoom.ts` | `viewZoomK(fovDeg, zoom)` · `TAN_BASE_HALF_FOV` — how far the camera is zoomed in as a screen-size factor (1 at `CAMERA_BASE_FOV_DEG`, 1/8 through an 8× scope, which narrows `camera.fov` rather than `camera.zoom`). Anything sized or gated by **how big it looks** corrects with it: the enemy animation LOD, the sniper's scope glint |
| `tutorial.ts` | `TutorialTrack` (`raid` / `ship` / `build` / `raid2`), step ids + per-track order, gates, HUD parts, save shape, `TutorialRef` (`ctx.tutorial`: `blockReason`, `hides`, `panelInfo`), `tutorialCountLabel` (the one `(n/m)` formatter — the objective panel and the map's tutorial rows must print a counted objective identically) |
| `tutorialWorld.ts` | `TutorialWorldRef` (`ctx.world.tutorial`): checkpoints, `TutorialFallRule`, respawn pose |
| `comms.ts` | Comms wheel (H): `CommsId` (wire strings), alive / downed layouts |
| `console.ts` | `ConsoleRef` (`ctx.console`), `ConsoleCommand`, `DEV_HOSTS`, `isDevHost` |
| `Random.ts` | Seeded RNG (mulberry32): `range` / `int` / `pick` / `weighted` / `shuffle` / `fork`, `Random.hash` |

## Public API — `ctx` publications

`GameContext` fields are filled by the owning system's `init` (null until then): `world` (world/), `player` (player/),
`enemies` (enemies/), `inventory` (inventory/), `loot` (items/), `net` (net/), `hub` (hub/), `pickups` (pickups/),
`weapons` (weapons/), `stratagems` (stratagems/), `implants` (implants/), `gadgets` (gadgets/), `drones` (gadgets/drones/),
`progression` (progression/), `housing` (housing/), `meta` (meta/), `tutorial` (tutorial/), `corpses` (game/),
`console` (console/), `audio` (audio/), `extraction` (extraction/), `shaders` + `outline` (core/, set in the Engine
constructor before any `init`). Nested: `ctx.net.profile` / `social` / `rooms` / `crypto`, `ctx.meta.npc` / `intel`,
`ctx.world.fog` / `hazard` / `training` / `tutorial` / `rover`.

## Rules

- **Add-only.** New events, fields, union members and exports are appended; never rename or delete a name that is
  stored in a save, sent over the wire, or read by another folder. Retired names stay with a retirement comment
  (`StratagemId 'airstrike'`, `LoadoutSlot 'secondary'`, `ImplantId 'atlauncher'`, `ArmorDef.damageReduction`,
  `NpcQuestState 'deferred'`, `QUEST_DEFS` = `[]`, the power-allocation names in `housing.ts` / `events.ts`).
  Deletion is allowed only for code-only constants that no save or wire uses (e.g. the `KEY_IMPLANT` trio, C-8).
- **`EnemyManagerRef` answers two different questions.** `getEnemies()` returns every body, including props such as
  `bug_egg` (they must stay shootable, blastable and lootable); `queryNear(pos, radius, includeProps = false)` leaves
  props out **by default**, because every caller of it is picking a target or asking "is something dangerous here" and
  a bug nest holds 8–30 eggs. A caller that deals damage (fire zone, C4) opts back in with `includeProps: true`.
- **Optional means "unknown", not zero.** An omitted wire / restore field (`PlayerRestoreState.shield`, `ui:screenFade.hold`,
  `NpcQuestRef.readAtOf`) must keep the old behaviour on the reader side.
- **No numbers in TS.** Tuning values live in `data/*.csv`; this folder exposes names only. Bad cells do not throw — they
  fall back and land in `dataIssues()`, which `npm run data:check` fails on — `data/csv.ts`.
- **Relay-shared modules have no runtime imports** (no csv loader, no three, no DOM): `net.ts`, `profile.ts`,
  `social.ts`, `credits.ts`, `cryptoMarket.ts`, `intel.ts`, `planets.ts` are executed by Node (`server/`, `electron/`);
  `types.ts` is type-imported there. Their few limits (GC ages, social caps) are TS literals; csv-driven values reach the
  relay through `server/economy.gen.json`. The csv side is split into a browser-only twin (`planetDefs.ts`,
  `intelDefs.ts`, `crypto.ts`, `meta.ts`).
- **Server tsconfig is `erasableSyntaxOnly`** and scans `data/csv.ts` / `data/tables.ts` — no constructor parameter
  properties there.
- **A formula used by two folders lives here** (`ballistics`, `explosion`, `lootRolls`, `ride`, `raidFound`,
  `intel.resolveIntelEffects`, `credits` prices). Do not copy it into a folder.
- **Read `Keys.X` at use time**, never cache a key (or its label) in a module constant — rebinding mutates the table.
- **Mission globals are set before the emit.** Whoever emits `game:newMission` sets `ctx.missionMode`, `missionPlanet`
  and `missionIntel` first — world/ and enemies/ read them inside synchronous handlers — `GameContext.ts`.
- **Screens pair blockers with the Escape stack**: `uiBlockers.add(token)` next to `escape.push(token, close)`, `delete`
  next to `escape.remove(token)`. Only `game/parts/Phases.escapeKey` decides what Escape does when the stack is empty.
- **Re-locking when a cursor screen closes happens in `main.ts` only** (screens just drop their cursor token); every
  request goes through `Input.requestPointerLock`, which decides *when* it reaches the browser (Escape defer, user-exit
  cooldown, bounce grace) — see the comment block above `Input.relockBlockedFor`.
- Overlays that must swallow a key use **capture-phase** listeners; window-dispatched events run in registration order,
  so tests dispatch on `document.body`.
- **Save keys pass `slotKey(...)`** unless they are in `SHARED_KEYS`; `scav.sessionToken` is per slot, so each character
  has its own server profile. Slot switch = `location.reload()` — `saveSlot.ts`.
- `holdAsk.ts`, `itemChip.ts`, `currency.ts`, `keycap.ts` build DOM; keep new DOM helpers equally self-contained (no
  feature-folder CSS dependency beyond `ui/styles/base.css` tokens).
- Explosion floors (`Math.max(floor, explosionFalloff(...))`) stay at the call sites; the shared curve is the multiplier.
- **A popup that cannot be closed hides for the length of a cutscene** and comes back unchanged — `cutsceneHide.ts`.
  Hiding means DOM **and** blocker **and** cursor (a held blocker over a cutscene floats a cursor and blocks the hub's
  re-lock); the popup's own state is never touched, so nothing has to be restored afterwards.

## Recent changes

Last 5 only — older: `git log -- src/shared`.
- 2026-09-21 — `rover:fired` gained `targetId` (add-only, B-73): the turret fires on the line after `takeDamage`, so the shot and the body it hit now travel together instead of having to be matched up afterwards. A replica is handed the impact point alone and sends `null`.
- 2026-09-20 — `shotSounds.ts` added (add-only, B-63): the shot-sound id table plus the archetype it is keyed by. `weapons/WeaponDefaults` branched on `WeaponKind` and covered the uniques while `player/AllyAvatars` judged a `WeaponDef` all over again and knew none of them, so an android holding a legendary fired `shot_rifle`; neither folder could import the other, which is §4.1's "the same formula in two folders moves to `src/shared`". `items/WeaponDefs.weaponClassOf` delegates to `weaponClassOfDef` so the class line exists once too.
- 2026-09-20 — `viewZoom.ts` added (add-only): the camera-zoom correction for anything decided as a screen size. `enemies/EnemySystem.poseSkip` and `enemies/models/named/SniperLook` had the same `tan(fov/2) / zoom / tan(70°/2)` question and the base FOV written out twice; it is one `CAMERA_BASE_FOV_DEG` csv row now, which `player/CameraRig.baseFov` reads too.
- 2026-09-19 — Audit B-27…B-58 (contract half). Add-only: `GAME_MINIGAME_LABEL_KO` · `gameMinigameLabel` (`housing.ts`) — the **game disc**'s minigame name, printed by two folders (housing's TV / library screens, ui's item tooltip), so it could not stay a housing internal; the tooltip had been printing the gym equipment name (`호흡 달리기` instead of `호흡형`). Doc-only corrections: the culture tank **does not empty at 0 uses** (2026-09-13) · `Drone.mountedDeployableId` is **derived, never written** (B-56) · `ComputeClusterInfo.power` marked dead-but-contract · `tutorial.ts` ship track is the **one** step `stats` and the step title it quotes had a one-character typo in it (B-46) · `types.ts` wording settled with `src/player` (B-50): *hit feedback* not *hit shot*, the rover's *exit* not *get off*, and **broken pair** beat *broken twin* (user's decision — nine spots renamed in `inventory` · `items` · `progression` · `shared`).
- 2026-09-19 — Add-only: `PingMessage.containerId` and `ping:placedV3.containerId` — a `'crate'` ping now names its loot container by **id** (`WorldRef.getLootContainers`), because `label` beside it is the display string `보급 상자 (n등급)` that `allies/` had been reading as an id (TODO B-61). `net.ts` `ally state` doc corrected: the ship has no wire, the snapshot is raid-only.
