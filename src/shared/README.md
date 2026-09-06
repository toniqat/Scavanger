# src/shared — Module contract

Everything every feature folder depends on. Append-only: add new events/fields, never rename or remove.

| File | Purpose |
|---|---|
| `constants.ts` | Map size, extraction countdown, player tuning, `Layers`, `Keys` bindings |
| `types.ts` | `GamePhase`, `MissionStats`, item/weapon defs, `*Ref` interfaces (World, Player, EnemyManager, Inventory, Loot), `Interactable`, `GameSystem` |
| `events.ts` | `GameEvents` map: every bus event name → payload type, grouped by owning module |
| `EventBus.ts` | Typed synchronous emitter (`on/once/off/emit`) |
| `Input.ts` | Keyboard/mouse state with per-frame pressed/released sets, pointer lock helpers. `endFrame()` called by Engine |
| `GameContext.ts` | Shared context: bus, input, interactables registry, scene/camera/renderer, module refs, phase, stats, `uiBlockers`, `isGameplayActive()` |
| `Random.ts` | Seeded RNG (mulberry32) with `range/int/pick/weighted/shuffle/fork` |
| `net.ts` | Multiplayer contract: lobby types, client↔server wire protocol (`ClientToServer`/`ServerToClient`), relayed `GameMessage` union (player/enemy snapshots, hit/explode requests, extraction/flow messages), `NetRef` (`ctx.net`), `RemotePlayerRef`/`RemoteAvatarRef`, `PlayerFlags`, tuning constants, slot colours, lobby-code helpers. Shared with the Node server (`server/`) — no runtime deps beyond plain constants |
| `index.ts` | Barrel export — import via `@/shared` |

## Appended contract (2026-09, stance / weapon classes / ping / map)
- `types.ts`: `WeaponClass` (`AR|SMG|SR|DMR|SG|PISTOL`) + optional `WeaponDef.weaponClass/falloffStart/falloffEnd/falloffMin/adsZoom/scope`; `Stance` (`stand|crouch|prone`); `PlayerRef.stance/isDiving/stamina/maxStamina`; `PlayerWeaponHost.setAimZoom(zoom, scope)`.
- `events.ts`: `player:stanceChanged`, `player:dived`, `player:staminaDepleted`, `weapon:scopeChanged`, `ping:placed`, `ping:removed`, `ui:mapToggled`, `input:pointerLockLost`.
- `constants.ts`: `PLAYER_MAX_STAMINA`, `PLAYER_CROUCH_SPEED`, `PLAYER_PRONE_SPEED`, `PING_LIFETIME`; `Keys.CROUCH` is now `KeyC`, plus `Keys.PRONE` (`KeyZ`), `Keys.DIVE` (`AltLeft`), `Keys.MAP` (`KeyM`); `MouseButtons` (`FIRE 0 / PING 1 / AIM 2`).
- `Input.ts`: Alt keydown and middle-click (while locked) are `preventDefault`ed; `lastLockRequest` timestamps the last pointer-lock request so GameFlow can tell a denied re-lock from a real Esc exit.

## Appended contract (2026-09-05, multiplayer)
- `net.ts` (new): see table. Topology = Node WebSocket relay (`server/`) + host-authoritative gameplay. `NetRef.isAuthority` = single-player OR lobby host; `inSession` = a lobby mission is running.
- `GameContext.ts`: `ctx.net: NetRef | null`, `ctx.isAuthority` (getter, true when `net` is null), `ctx.isMultiplayer` (getter).
- `types.ts`: `PlayerRef.pitch / isGrounded / isReloading / isFiring / isDropping / isInShip / stridePhase / moveBlend` (snapshot inputs read by net).
- `events.ts`: `game:paused.freeze?` (false → menu shown but simulation keeps running; Engine + enemies honour it); `net:statusChanged`, `net:error`, `net:lobbyUpdated`, `net:lobbyLeft`, `net:peerJoined`, `net:peerLeft`, `net:gameStarting`, `net:remotePlayerAdded/Removed`, `net:remoteFired`, `net:remoteReloaded`, `net:remoteGrenade`, `net:remoteDied`, `net:remotePing`, `net:chat`, `ui:lobbyToggled`.
- Ownership of `GameMessage` types: `ps` net · `fire/reload/grenade` weapons · `hit/explode/hitc/es/ee` enemies · `dmg` enemies → net (applies it) · `ex/exq` extraction · `flow` game · `ping/chat` ui · `crate` world (reserved, unused yet).
- `main.ts` order: `NetSystem` is registered first (snapshots applied before anyone reads `ctx.net`), `RemotePlayerSystem` right after `PlayerSystem`.

## Appended contract (2026-09-05, ship hub / pings v2 / chat / drop & split / pickups / reconnection)
- `types.ts`: `GamePhase` += `'hub' | 'docking'`; `HubShipKind`, `PingKind` (`ground|enemy|crate|extraction|item|attack|caution`), `ChatKind` (`text|ping|request|system`);
  `InventoryRef.dropItem(uid, qty?)` / `splitItem(uid, qty)`; `PickupRef` / `PickupsRef` (`ctx.pickups`, owner `pickups/`); `InteriorCollider`
  (flat decks + wall/prop colliders + raycast, built by `hub/`, consumed by `player/`); `HubLaunchSlot` / `HubRef` (`ctx.hub`, owner `hub/`);
  `PlayerRef.setInterior / interior / setCameraOverride / spawnStanding / isInPod / setInPod`.
- `GameContext.ts`: `ctx.hub`, `ctx.pickups`, `isHubPhase()`, `isControlActive()` (= gameplay OR hub phase, no blockers — movement/interaction/camera use it; weapons, pings, map, grenades keep `isGameplayActive()`).
- `constants.ts`: `Keys.DROP_ITEM` (`KeyX`), `Keys.CHAT` (`Enter`), `PING_DRAG_THRESHOLD_PX`, `PING_HOLD_MAX`, `CHAT_MAX_LINES`, `PICKUP_LIFETIME`, `PICKUP_MAX`, `HUB_LAUNCH_COUNTDOWN`, `HUB_DOCKING_DURATION`.
- `events.ts`: `hub:enter` (command), `hub:entered`, `hub:left`, `hub:docking`, `hub:slotChanged`, `hub:launchCountdown`, `ui:hubMenuToggled`;
  `inventory:itemDropped`, `inventory:itemSplit`, `pickup:spawned`, `pickup:taken`, `pickup:removed`; `chat:post` (command → ChatLog), `chat:message`, `ui:chatToggled`;
  `ping:placed.kind` / `net:remotePing.kind` widened to `PingKind`; `net:chat.kind?`; `net:reconnecting`, `net:resumed`, `net:matched`.
- `net.ts`: `NET_TOKEN_PARAM/NET_NAME_PARAM` (ws URL query), `NET_TOKEN_LENGTH`, `NET_TOKEN_STORAGE_KEY`, `NET_RECONNECT_GRACE_MS` (5 min), `NET_RECONNECT_BACKOFF_MS`,
  `NET_MISSION_RESUME_TIMEOUT_MS`; `LobbyPlayer.connected`, `LobbyState.isPublic`; error codes `not_started`, `duplicate`;
  `ClientToServer` += `lobby:quickmatch`, `lobby:setPublic`, `lobby:seed`, `lobby:name`; `welcome.lobby?/resumed?`;
  `PlayerFlags.IN_POD / IN_HUB`; `ExtractionMessage` += `ex sync {state: ExtractionSyncState}`, `ExtractionRequest` += `exq sync`; `FlowMessage` += `flow rejoined`;
  `PingMessage.kind: PingKind` + `label?` + `enemyId?`; `ChatMessage.kind?`; new `ItemMessage` (`item drop/take/sync`, host → all) and `ItemRequest` (`itemq drop/take/sync`, client → host);
  `NetRef` += `sessionToken`, `reconnecting`, `missionInProgress`, `ensureConnected()`, `quickMatch()`, `setPublic()`, `setLobbySeed()`, `rejoinMission()`, `inHubSession`.
- Ownership of new `GameMessage` types: `item/itemq` pickups · `ex sync / exq sync` extraction · `flow rejoined` net (sent by `rejoinMission`).
- Phase flow with the hub: `menu` (title) → `hub` (personal ship) → [`docking` → `hub` (shared ship)] → launch slot(s) ready → `game:newMission` → `deploying` … → `complete`/`dead` → result screen → `hub:enter` → `hub`.
  The hub is **not** a gameplay phase; `world` is null while in it. Player snapshots are exchanged in the shared ship (`inHubSession`).

## Appended contract (2026-09-05, weapon package: durability / grades / ammo v2 / 3 weapon slots / sockets / bags)
- `types.ts`: `ItemCategory` += `'attachment' | 'bag'`; `AmmoType` += `'light' | 'medium' | 'heavy' | 'shell'` (v2 calibres — legacy values unused);
  `WeaponGrade` (1..5 ↔ Rarity), `SocketSlot` (`muzzle|grip|mag|stock|sight`), `LoadoutSlot` (`primary|primary2|secondary|bag`), `WeaponSlot`;
  `AttachmentEffects` / `AttachmentDef` (`ItemDef.attachment`), `BagDef` (`ItemDef.bag`), `EffectiveWeaponStats` (graded + socketed numbers weapons fire with);
  `WeaponDef.grade / maxDurability / family`; `ItemInstance.durability / ammoInMag / sockets` (+ `ItemInstanceExtras`);
  `Loadout.primary2 / bag`; `InventoryRef.getBagSize / findItem / updateItem / attachToWeapon / detachAllSockets / unloadWeapon / repairWeapon / equip`;
  `LootRef.createItem(defId, qty?, extras?)` (weapons spawn loaded + full durability), `getEffectiveStats`, `getRepairCost`, `canAttach`;
  `PlayerWeaponHost.setAdsTime(seconds)`.
- `events.ts`: `weapon:equipped.slot: WeaponSlot`; `loadout:changed` += `primary2`, `bag`; `weapon:durabilityChanged`, `weapon:broken`, `weapon:swapStarted`,
  `inventory:itemUpdated`, `inventory:socketChanged`, `inventory:bagChanged`, `hub:workbenchToggled`.
- `constants.ts`: `Keys.PRIMARY2` (`Digit2`), `Keys.SECONDARY` is now `Digit3`; `WEAPON_DURABILITY_PER_SHOT`, `WEAPON_DEFAULT_DURABILITY`, `WEAPON_SWAP_TIME_PRIMARY/SECONDARY`,
  `WEAPON_ADS_TIME`, `WEAPON_GRADE_DAMAGE_STEP/DURABILITY_STEP`, `WEAPON_GRADE_ROMAN`, `SOCKET_SLOTS`, `SOCKET_LABEL_KO`, `AMMO_FOR_CLASS`, `AMMO_STACK_ROUNDS`,
  `BAG_DEFAULT_COLS/ROWS/QUICK_SLOTS`, `REPAIR_SCRAP_PER`, `REPAIR_ALLOY_PER`.
- `net.ts`: `PickupWire.ex?: ItemInstanceExtras` (dropped weapons keep durability / rounds / sockets over the wire).
- Ammo model v2: an ammo item's `qty` **is** the round count (`stackMax = AMMO_STACK_ROUNDS[type]`); a weapon's reserve = rounds of its calibre in the bag
  (`countWhere`), reload consumes them (`consumeWhere`), and the loaded magazine lives in `ItemInstance.ammoInMag` so it travels with the item.

## Appended contract (2026-09-05, Phase 2: down / revive / respawn · quick-use wheel · grenade cooking)
- `types.ts`: `PlayerRef.isDowned / downHp / revive() / applyStim(heal) / respawn(position)`; `PlayerWeaponHost.setLookLocked(locked)` and
  `setWeaponState({…, throwing?, holdingItem?})`; `InventoryRef.getQuickSlots / setQuickSlot / getQuickSlotCount / consumeItem`;
  `Interactable.onHoldProgress?(t) / onHoldCancel?()` (called by the player during a hold interaction — the revive interactable relays them).
- `events.ts`: `player:downed`, `player:downHpChanged`, `player:revived`, `player:reviveProgress`, `player:respawn` (command game → player + inventory),
  `game:respawn` (command ui → game), `game:respawnAvailable`, `net:remoteDowned`, `net:remoteRevived`, `inventory:quickSlotsChanged`,
  `quick:wheelChanged`, `quick:equipped`, `quick:used`, `grenade:holdChanged`; `net:remoteGrenade.fuse?`.
- `constants.ts`: `PLAYER_DOWN_HP`, `PLAYER_DOWN_BLEED_PER_SEC`, `PLAYER_DOWN_SPEED_MUL`, `PLAYER_REVIVE_HOLD/RANGE/HP`, `PLAYER_RESPAWN_DELAY`, `PLAYER_GIVE_UP_HOLD`,
  `QUICK_SLOTS`, `QUICK_SLOT_DIRS`, `QUICK_SLOT_LABEL_KO`, `QUICK_USABLE_CATEGORIES`, `QUICK_WHEEL_HOLD`, `QUICK_WHEEL_DRAG_PX`, `GRENADE_FUSE`, `GRENADE_COOK_MAX`,
  `GRENADE_UNDERHAND_SPEED_MUL`; `Keys.QUICK` (F, same key as `STIM`), `Keys.RESPAWN` / `Keys.GIVE_UP` (Space). `Keys.GRENADE` (G) is reserved for Phase 3.
- `net.ts`: `PlayerFlags.DOWNED / HOLDING_ITEM`; `GrenadeMessage.fuse?`; `ReviveMessage` (`revive progress/cancel/done`, reviver → target); `RemotePlayerRef.isDowned`.
- Death flow v2: hp 0 → **downed** (crawl, bleed 1/s from 100, enemies ignore you, teammates revive with a 10 s E hold within 3 m → hp 10) → `downHp` 0 or Space-hold give-up
  → `player:died` → after `PLAYER_RESPAWN_DELAY` (30 s) `game:respawn` re-drops the player at the mission spawn with the starter kit. **No mission failure on death
  any more** (solo or squad); a mission ends by extraction or abort. Solo: phase `dead` + death screen with the countdown; squad: spectate overlay with the countdown.

## Appended contract (2026-09-06, Phase 3: ship calls / stratagems · off-screen indicators)
- `types.ts`: `Obstacle.destructible?: DestructibleRef` (weapons call `onDamage` when a shot hits the obstacle); `WorldRef.addObstacle(obstacle) → remover`;
  `GrenadeView` / `WeaponsRef` (`ctx.weapons.getGrenades()`); `StratagemId` (`orbital_laser | airstrike | supply_drop | structure_drop`), `StratagemStage`,
  `StratagemCall`, `StratagemsRef` (`ctx.stratagems`: `armed`, `targeting`, `cooldown`, `cooldownTotal`, `getCalls()`, `structureCount`).
- `GameContext.ts`: `ctx.weapons`, `ctx.stratagems`.
- `events.ts`: `stratagem:wheelChanged`, `stratagem:armed`, `stratagem:chargeChanged`, `stratagem:targeting`, `stratagem:called`, `stratagem:landed`, `stratagem:ended`,
  `stratagem:cooldown`, `structure:damaged`, `structure:destroyed`.
- `constants.ts`: `Keys.SHIP_CALL` (G), `StratagemDef` + `STRATAGEM_DEFS` / `STRATAGEM_ORDER`, `STRATAGEM_WHEEL_HOLD`, `STRATAGEM_CHARGE_TIME`, `TOPVIEW_*`, `GROUND_TARGET_RANGE`,
  `LASER_*`, `AIRSTRIKE_*`, `SUPPLY_*` (`SUPPLY_CRATE_TIER` 5 = items loot table "보급 투하 상자"), `STRUCTURE_*`, `OFFSCREEN_PING_SECONDS`.
- `net.ts`: `StratagemMessage` (`strat call` with `eta` + `seed`, `strat structHp`).
- Rules: while `ctx.stratagems.armed` or `targeting` is set the weapons system neither fires nor swaps on LMB/RMB (the call owns the mouse); the stratagem system uses
  `ctx.player.setCameraOverride` + `setLookLocked` + `setControlsEnabled(false)` for the top view. No new scene lights (emissive meshes only).

## Appended contract (2026-09-06, Phase 4: rogues · enemy gimmicks · corpse looting)
- `types.ts`: `EnemyType` += `rogue | rogue_boss | artillery | toxic | behemoth`; `EnemyFaction` (`bug | rogue`) + `EnemyRef.faction`; `EnemyHit.armored?`
  (behemoth front plate: weapons deal 0 with `ARMOR_IMMUNE_AMMO`, ricochet FX); `InterceptableRef` + `EnemyManagerRef.raycastInterceptable()` (artillery shells can be
  shot down); `InventoryRef.openContainerItems(containerId, items, position, title?)` (loot window with caller-supplied contents — corpses);
  `LootRef.rollCorpse(type, rng?, rogueWeaponId?)`; `PlayerRef.applyKnockback(direction, speed)`.
- `events.ts`: `enemy:shot`, `enemy:shellFired/Intercepted/Landed`, `enemy:chargeStarted`, `enemy:toxicBurst`, `enemy:bossSpawned`, `corpse:spawned`, `corpse:removed`,
  `enemy:factionClash`. Corpses reuse `crate:looted {crateId: 'corpse:<id>'}` when emptied.
- `constants.ts`: `CORPSE_LIFETIME`, `CORPSE_INTERACT_RADIUS`, `ROGUE_*`, `ARTILLERY_RANGE`, `SHELL_*`, `TOXIC_*`, `BEHEMOTH_*`, `ARMOR_IMMUNE_AMMO`.
- `net.ts`: `EnemyEvent` += `shoot`, `shell`, `intercept`, `shellHit`, `charge`, `toxic`, `corpse`, `corpseGone`; `EnemyWire.a` hints 5–11, `EnemyWire.w` (rogue weapon);
  `InterceptRequest` (`intq`, client → host).
- Rules: factions fight on sight (bugs ↔ rogues) — a `CombatTarget`-like list of the other faction lives inside enemies; rogues spawn as guards around tier ≥ 2 crates
  (`ctx.world.getCrates()`); every dead enemy leaves a corpse `Interactable` `corpse:<id>` (`CORPSE_INTERACT_RADIUS`, `CORPSE_LIFETIME`) that opens
  `ctx.inventory.openContainerItems('corpse:<id>', ctx.loot.rollCorpse(type, rng, weaponId), pos, '시체')`; corpse contents are per-client (like crates).

## Appended contract (2026-09-06, key rebinding · implant rework · ship stash)
- `constants.ts`: `Keys` is now a **mutable** `KeyBindings` table (`DEFAULT_KEYS` holds the factory values) with the tactical-kit keys folded in
  (`IMPLANT` Q, `MELEE` F, `THROW_MODE` B) and the three mouse actions (`FIRE` `Mouse0`, `AIM` `Mouse2`, `PING` `Mouse1`). `MouseButtons.FIRE/PING/AIM` are
  getters derived from those (`mouseButtonOf`). `KEY_IMPLANT` / `KEY_MELEE` / `KEY_THROW_MODE` stay exported as deprecated defaults — **read `Keys.X` at use
  time, never cache a key in a module-level constant** (labels included: `keyLabel(Keys.X)`). New: `KEYBINDS_STORAGE_KEY`, `STASH_STORAGE_KEY`, `STASH_COLS` 10 /
  `STASH_ROWS` 24, `IMPLANT_BARRIER_BREAK_LOCKOUT` 10, `IMPLANT_OVERCHARGE_SELF/ALLY_HEAL_PER_SEC`, `IMPLANT_OVERCHARGE_ENERGY` 6 s, `IMPLANT_OVERCHARGE_REGEN_TIME` 12 s,
  `IMPLANT_OVERCHARGE_BUFF_HP_RATIO` 0.9.
- `Keybinds.ts` (new): `KEY_ACTION_DEFS` (label / group / scope / `mouseOnly` / `menuOnly` per action), `KEY_ALIASES` (RESPAWN + GIVE_UP follow JUMP, GRENADE follows
  SHIP_CALL), `loadKeybinds()` (called once by `main.ts`), `setKeybind` / `resetKeybinds` / `saveKeybinds` (localStorage `scav.keybinds`, only non-default entries),
  `canBind` (mouse-only actions take mouse buttons only; Escape is reserved for MENU), `conflictsOf` / `allConflicts` (same key in overlapping scopes: `global` clashes
  with everything, `game` with `game`, `inventory` with `inventory`), `actionsOnKey`, `keyLabel`, `onKeybindsChanged`.
- `Input.ts`: mouse buttons are mirrored as synthetic key codes `Mouse0..4` in the same pressed / down / released sets, so a rebindable action may sit on a mouse button.
- `implants.ts`: `ImplantMode` += `'hold'` (effect runs while Q is held; gun stays in hand). `ImplantsRef` += `holding`, `energy` / `energyMax` (overcharge pool),
  `barrierLockout`.
- `events.ts`: `input:bindingsChanged` (emitted by the key-settings overlay after every change — refresh cached key labels), `ui:keybindsToggled`,
  `implant:energyChanged`, `inventory:stashChanged`.
- Rules: events dispatched **at `window`** run listeners in registration order (Chrome), so overlays that must swallow a key use capture-phase listeners and rely on
  real key events targeting the focused element; test scripts dispatch on `document.body`.

## Appended contract (2026-09-06, Phase 6: dev console · unique weapons · stat XP · ship housing)
Brief for the implementing agents: `docs/PHASE6-PLAN.md`.
- `console.ts` (new): `ConsoleRef` (`ctx.console`: `enabled` = dev client, `isOpen`, `moveCheat`, `register(cmd)`, `getCommands`, `run(line)`, `print`, `open/close`),
  `ConsoleCommand` (`name/usage/description/run(args, ctx, print)/complete?`), `DEV_HOSTS`, `isDevHost(hostname?)` — the console exists only when the page host is localhost.
- `housing.ts` (new): `RoomPurpose` (10, `ROOM_PURPOSES_ACTIVE` = empty/workshop/range this build) + labels, `FacilityId`, `WorkbenchKind` (gun/gear/gadget/medical),
  `FurnitureModelKind`, `FurnitureInteraction`, `FurnitureDef` + **`FURNITURE_DEFS` catalogue** (14 pieces; data lives in the contract like `STRATAGEM_DEFS`),
  `PlacedFurniture`, `StoredFurniture`, `RoomState`, `LoadoutPreset`, `ShipState` (localStorage `SHIP_STORAGE_KEY`), `FacilityInfo`, `HousingRef` (`ctx.housing`),
  helpers `benchKindOf`, `furnitureFootprint`.
- `constants.ts`: `Keys.CONSOLE` (Backquote) / `Keys.MOVE_CHEAT` (Home) + `KEY_ACTION_DEFS` entries; `CONSOLE_*`, `MOVE_CHEAT_SPEED`; `UNIQUE_WEAPON_IDS/LABEL_KO`,
  `FLAME_* / BURNOUT_* / SHOCK_* / SHURIKEN_* / SLASH_* / BOW_* / BAZOOKA_* / MINIGUN_*`, `AMMO_STACK_ROUNDS` += fuel/cell/shuriken/arrow/rocket/belt;
  `STAT_XP_BASE/EXPONENT`, `STAT_MIN`; `SHIP_*`, `ROOM_GRID_*`, `HOUSING_CELL_SIZE`, `*_MAX_LEVEL`, `STASH_ROWS_BY_STORAGE_LEVEL`, `PRESETS_BY_RANGE_LEVEL`,
  `RANGE_SKILL_GAIN_PER_LEVEL`, `WORKSHOP_COST_DISCOUNT_PER_LEVEL`, `*_UPGRADE_COST`.
- `types.ts`: `ItemCategory` += `furniture` (+ `ItemDef.furnitureId`); `AmmoType` += the six unique calibres; `UniqueWeaponKind`; `WeaponDef.unique / altFire / altDamage / chargeTime / ammoPerSec`;
  `EnemyRef.isIncapacitated`, `EnemyStatusKind`, `EnemyManagerRef.applyStatus(id, EnemyStatusKind, …)`; `PlayerRef.teleport / setViewWiden / consumeStamina / startMelee(kind?)`;
  `PlayerWeaponHost.setWeaponState({charging?, spraying?, heavy?, altFire?})` (`altFire` appended 2026-09-06 after the Phase 6 audit: RMB is the weapon's alternative fire → the player suppresses its ADS state); `InventoryRef.openCatalog / closeCatalog / isCatalogOpen / getStashSize / setStashSize / countDefAll / consumeDefAll /
  captureLoadout / applyLoadout / openBenchCraft / getRecipes(station, bench?, level?)`; `HubRef.setMissionSeed / currentRoom`.
- `events.ts`: `console:toggled/executed`, `cheat:moveCheat`, `cheat:seed`; `weapon:chargeChanged`, `weapon:beamChanged`, `weapon:altFired`, `player:slashed`, `enemy:incinerated`, `enemy:shocked`,
  `player:blastJump`; `progress:statXp`; `housing:*` (loaded/changed/modeChanged/selectionChanged/roomPurposeChanged/furniturePlaced/Moved/Recovered/Upgraded/facilityUpgraded/stashSizeChanged/presetApplied/cursorChanged),
  `ui:housingToggled`, `hub:roomEntered`, `ui:catalogToggled`.
- `progression.ts`: `PlayerProfile.statProgress?`; `ProgressionRef.getStatProgress / statXpToNext / addStatXp / getSkillProgress / addSkillXpRaw / getSkillGainMul`.
- `gear.ts`: `CraftRecipe.bench? / benchLevel?`. `net.ts`: `FireMessage.m? / c?`, `HitRequest.st? / dur?`, `ENEMY_STATUS_BITS`, `EnemyWire.sb?`.
- `GameContext.ts`: `ctx.console`, `ctx.housing`. `main.ts` order: `… ProgressionSystem → HousingSystem → WorldSystem → …  → GameFlowSystem → ConsoleSystem` (console last).
- Ownership: `console/` cheats · `housing/` rules + DOM · `hub/` ship geometry + housing mode + furniture meshes · `items/` unique defs / ammo / materials / recipes ·
  `weapons/` unique behaviour · `enemies/` 전소/감전 · `player/` teleport / widen / heavy melee · `inventory/` catalog / stash size / presets / bench craft · `progression/` stat XP · `ui/` gauges + hints.

## Appended contract (2026-09-06, Phase 5: corporations · credits · contracts · quests · loadout persistence)
Brief for the implementing agents: `docs/PHASE5-PLAN.md` §8.
- `meta.ts` (new): `CorpId` / `CORP_IDS` / `CorpDef` + **`CORP_DEFS`** (4 corps with `ShopRule[]` stock), `REP_TABLE` / `REP_LEVEL_MAX` / `repLevelOf`,
  `SHOP_UNLOCK_REP_LEVEL` 1, `SHOP_RARITY_CAP_BY_REP` (+ `SHOP_BAG_RARITY_BONUS`), `CREDITS_INITIAL` 500 / `CREDITS_MAX`, `buyPriceOf(value, repLevel)` =
  value × max(0.9, 1.6 − 0.15 × level), `sellPriceOf(value, qty)` = value × 0.5, `ContractGoalKind` + `CONTRACT_GOAL_LABEL_KO`, `ContractDef` + **`CONTRACT_DEFS`**
  (18: 4 per corp on its signature goal + `helix_calls` / `nomad_crates`), `CONTRACT_SQUAD_SHARE` 0.25, `CONTRACT_MAX_ACTIVE` 1, `QuestState`, `QuestDef` + **`QUEST_DEFS`**
  (chains h1–h4 / b1–b3 / n1–n2 / c1–c3), runtime shapes `RepInfo` / `ShopItem` / `ContractInfo` / `QuestInfo` / `ContractSettlement` / `MetaSave`, and
  **`MetaRef`** (`ctx.meta`: credits, `getRep`, `addCredits`, `addRep`, shop `getShop / priceOf / buy / sellPriceOf / sell / getSellable`, contracts
  `getContracts / activeContract / acceptContract / abandonContract / reportContractHit / settleMission`, quests `getQuests / getQuestState / acceptQuest / completeQuest`,
  corp screen `openCorpMenu / closeCorpMenu / isMenuOpen` (blocker `'corp'`), `save / resetMeta`).
- `types.ts`: `MissionRewards` + `MissionStats.rewards?` (filled by game/GameFlowSystem before `game:complete` / `game:over`: XP paid, level before / after,
  xp / xpToNext, contract settlement); `InventoryRef.getStashItems / findItemAnywhere / tryAddToStash / tryAddItemAnywhere / takeItem` (corp shop access; the last
  four are stubs until inventory/ implements them).
- `events.ts`: `meta:loaded / creditsChanged / repChanged / contractAccepted / contractAbandoned / contractProgress / contractSettled / questChanged / purchase / sale`,
  `ui:corpToggled`, `inventory:containerOpened {containerId, first}`, `inventory:loadoutSaved`.
- `constants.ts`: `META_STORAGE_KEY` `scav.meta`, `LOADOUT_STORAGE_KEY` `scav.loadout`; **`STAT_POINTS_PER_LEVEL` 2 → 1**, **`XP_BASE` 240 → 120** (user decision).
- `net.ts`: `MetaMessage {t:'meta', ev:'contractHit', corp, goal, amount}` (relay-opaque; `onMessage('meta')`).
- `GameContext.ts`: `ctx.meta`. `main.ts`: `… InventorySystem → MetaSystem → GadgetSystem …` (meta after inventory so buy / sell / deliveries use the bag + stash).
- Stat effects (lead, same commit): 근력 `throwRangeMul` now scales the grenade throw speed (√, weapons); 재주 `useSpeedMul` divides the quick-use cooldown
  (weapons) and `interactSpeedMul` is applied **once by the player to every hold** (`PlayerSystem` interaction loop) — interactables publish their base `holdTime`
  (gather nodes, the garden and gadget recovery no longer scale it themselves). 지능 stays `skillGainMul` only (skill books were dropped in Phase 7 — the 서재 bookshelf collection replaces them).
- Ownership: `meta/` rules + storage + corp screen DOM · `inventory/` loadout persistence + stash access + 기업 tab · `hub/` ship computer (`hub_computer`) ·
  `ui/` result-screen XP / contract lines, HUD contract panel, title level chip, meta toasts · `game/` (lead) settlement hook.

## Appended contract (2026-09-06, Phase 7: known follow-ups — server profile · raid session · ghosts · host migration · training · container authority · search)
Brief for the implementing agents: `docs/PHASE7-PLAN.md`.
- `profile.ts` (new): `ProfileDocKey` / `PROFILE_DOC_KEYS`, `ProfileRecord {credits|null, docs, updatedAt}`, `RaidSessionBlob {seed, missionTime, stats, inventory, savedAt}`,
  `CreditsTxResult`, **`ProfileRef`** (`ctx.net.profile`: `available`, `credits`, `get / set / flush`, `addCredits(delta, reason)` → server transaction), `PROFILE_SYNC_DEBOUNCE_MS`,
  `PROFILE_DOC_MAX_BYTES`, `RAID_SAVE_INTERVAL_S`, `RAID_BLOB_MAX_BYTES`. The relay server stores these per session token (`server/Store.ts`).
- `labels.ts` (new): `RARITY_ORDER / rarityRank / rarityForGrade / gradeForRarity / RARITY_COLORS / RARITY_LABEL_KO / CATEGORY_LABEL_KO / CATEGORY_COLOR / CATEGORY_ICON`
  moved out of `items/ItemDefs.ts` (which re-exports them) so meta/ and ui/ label items without importing items/.
- `net.ts`: `LobbyPlayer.inMission?`, `LobbyState.mode?`, `LobbyErrorCode` += `too_large | in_mission`; client → server `lobby:start {seed, mode?}` (training: any member),
  `lobby:mission {inMission}`, `profile:get`, `profile:set {key, doc}`, `credits:tx {txId, delta, reason}`, `raid:save {blob}`; server → client `welcome.profile? / raid?`, `game:start.mode?`,
  `profile:docs`, `credits:result`; `NET_HOST_MIGRATE_DELAY_MS` (host migrates mid-mission), `NET_GHOST_STATE_HZ`, `NET_GHOST_RESTORE_TIMEOUT_S`, `SUSPENDED_LABEL_KO`;
  `PlayerFlags` += `THROWING / COOKING / CHARGING / SPRAYING / HEAVY / MELEE_HEAVY`; `PlayerSnapshot.h? / att?`; `DamageMessage.kb?`; `EnemyWire.a` 12 / 13; `ee grenade / grenadeHit`;
  `flow takeover`; `GhostMessage` (`state / sync / restore / gone`) + `GhostRequest` (`sync / revive`); `ContainerMessage` (`taken / denied / sync`) + `ContainerRequest` (`take / sync`);
  `imp beam`; `RemotePlayerRef.suspended / inMission`; `NetRef.profile / raidBlob / saveRaid / missionMode / startGame(seed, mode?) / leaveMission / tookOver`.
- `types.ts`: `MissionMode`, `MissionStats.mode?`, `PlayerRestoreState`, `PlayerRef.restoreState / isMeleeHeavy`, `WeaponRemoteState` + `WeaponsRef.remoteState`,
  `InventoryRef.canFit / captureRaidState / applyRaidState`, `WorldRef.mode`, `EnemyManagerRef.setAuthority`, `ItemInstance.searched?`.
- `events.ts`: `game:newMission.mode?` (widened in place), `net:gameStarting.rejoin? / mode?` (widened in place), `training:exitRequested`, `game:raidFailed`,
  `net:profileLoaded / raidLoaded / hostChanged / peerSuspended / ghostState / ghostRestore / missionMembership`, `container:searchProgress / itemRevealed / searchDone`,
  `ghost:damage`, `net:remoteHeldItem`.
- `meta.ts`: `ContractSettlement.outcome?`. `housing.ts`: `FurnitureModelKind / FurnitureInteraction` += `sim_hub`, `FURNITURE_DEFS` += `furn_sim_hub` (사격장).
- `constants.ts`: `BEHEMOTH_SCALE` 4 → 3, `RAID_FAILED_AUTO_RETURN_S`, `SEARCH_TIME_BY_RARITY`, `SEARCH_MAX_DISTANCE`, `TRAINING_*`, `ROGUE_MAG_ROUNDS / ROGUE_RELOAD_TIME /
  ROGUE_COVER_FLANK_WEIGHT / ROGUE_GRENADE_*`, `GHOST_BLEED_PER_SEC`.
- `GameContext.ts`: `ctx.missionMode` (set by whoever emits `game:newMission`, before emitting), `ctx.rejoinPending`, `isTraining()`.
- Ownership: `server/` + `net/` store · sessions · migration · membership · snapshot fields · ghost / container relay ·· `game/` + `extraction/` wipe · raid save / rejoin · training flow ··
  `player/` restore · host ghosts · remote poses / held item / armor · knockback fix ·· `weapons/` + `implants/` remote state · attachments · remote grenade damage · beam ··
  `enemies/` rogue v2 · behemoth kb · ghost targets · live authority ·· `inventory/` search · container authority · canFit · raid state · profile docs ··
  `meta/` + `progression/` + `housing/` labels · server credits · outcome · profile docs ·· `world/` + `hub/` training arena · sim hub · terminal entry ·· `ui/` result / failure / suspended / badges ·· `audio/` (lead).

## Appended contract (2026-09-06, Phase 8 UI/UX pass: item-chip tooltips · 시설 관리 · 방 1 = 작업실)
- `itemChip.ts`: `buildItemChip` now stamps **`data-def-id`** on every chip whose def resolved, and only sets a native
  `title` when the caller passes one (an unresolved def keeps the placeholder name as its title). `ui/hud/ItemTip` is
  the single reader of that hook — one delegated hover on `#ui-root` gives every cost chip everywhere the same
  inventory-style item card. Nothing else about the markup changed.
- `housing.ts`:
  - **`WORKSHOP_ROOM_INDEX`** (0) — the ship's permanent 작업실. `housing/Rules.purposeChangeReason` refuses any other
    purpose for that room and refuses `workshop` for every other room; `housing/ShipState` enforces it on every load
    (older saves migrate, displaced furniture goes to furniture storage) and `freshState()` places the 총기 작업대 +
    정비 벤치 in it.
  - `HousingRef.purposeBlock(index, purpose)` appended — the 한국어 reason `setRoomPurpose` would refuse, so ui/ can
    render the 시설 관리 purpose picker and the 방 목록 `<select>` disabled states from the same rule.
  - `HousingRef.openRoomMenu / openFacilityMenu` are kept but now **redirect to `openShipManage`** (the standalone
    방 메뉴 / 시설 메뉴 are gone).
  - `FURNITURE_DEFS`: `furn_range_console` renamed 사격장 콘솔 → **관물대** (2×1, model `locker`) — the only entry point
    to the loadout presets now that the 시설 메뉴 and its 프리셋 button are gone. Its id and `interaction` are unchanged,
    so existing saves keep their piece.

## Appended contract (2026-09-06, Phase 9: known follow-ups II — profile timestamps · ghost fields · late-join sync · delta enemy snapshots · 서재 · training modes)
Brief for the implementing agents: `docs/PHASE9-PLAN.md`.
- `profile.ts`: `ProfileRecord.docsAt?` (per-document stamp the server holds), `PROFILE_CLOCK_SKEW_MS`, `ProfileRef.set(key, doc, {fresh?})` — a `set` is **never dropped** any more
  (offline → pending map, stamped `at = serverNow()`, flushed on the next connection; a pending doc older than the server's `docsAt` loses). `fresh` = a default / starter save that is
  accepted only while the server has no document for that key.
- `net.ts`: `profile:set {at?, fresh?}`; `PlayerSnapshot.dhp?` (down pool while DOWNED → host ghosts inherit it); `EnemyWire` pose fields are **optional** (`es` is a delta stream) +
  `EnemySnapshot.seq / gone?`, `NET_ENEMY_KEYFRAME_S` (keyframe cadence, also right after `flow rejoined / takeover`); `NET_GHOST_PARK_S` (a member who left the mission without
  rejoining keeps a parked, non-simulated ghost the host restores on a rejoin inside the window); `META_HIT_MAX`; `strat sync {calls: StratagemCallWire[]}` + `stratq sync`
  (host answers on `world:ready` / `flow rejoined` — the host is the sync authority, calls stay client-simulated); `meta sync {corp, hits}` + `metaq sync` (peer-to-peer, once per requester
  per mission); `RemotePlayerRef.ghostState? / ghostDownHp? / downHp?` (net fills them from `ghost` messages / snapshots; game/ dropped its own map).
- `types.ts`: `ItemCategory 'book'`, `ItemDef.book` / `BookDef {skill}`, `InventoryRef.openCatalog(opts?: {category?})` (widened in place), `EnemyManagerRef.applyStatus(..., attacker?)`
  (burn kills credit the fire's owner), `TrainingMode / TRAINING_MODES / TRAINING_MODE_LABEL_KO`, `TrainingRef` (`ctx.world.training`: mode / score / hits / remaining / bestTime /
  `setMode` / `startCourse` / `resetScore`), `WorldRef.training`.
- `events.ts`: `enemy:killed.by?` (widened in place), `player:giveUpProgress`, `training:modeChanged / scored / courseFinished`, `housing:booksChanged`, `ui:bookshelfToggled`.
- `constants.ts`: `JUMP_PAD_RETRIGGER_S`, `BOOKS_PER_SHELF / BOOK_XP_PER_BOOK / BOOK_RARITY_MUL / BOOK_GAIN_MAX`, `TRAINING_MOVING_* / TRAINING_COURSE_* / TRAINING_BEST_STORAGE_KEY`,
  `SHIP_STATE_VERSION` 3 (`books` / `bookDex`, absent → empty).
- `housing.ts`: `ROOM_PURPOSES_ACTIVE += 'library'`, `FurnitureModelKind / FurnitureInteraction += 'bookshelf'`, `FURNITURE_DEFS += furn_bookshelf` (서재, 2×1, `BOOKS_PER_SHELF` slots),
  `PlacedBook`, `BookSlotInfo`, `ShipState.books? / bookDex?`, `HousingRef.getBooks / placeBook / takeBook / getOwnedBooks / getBookBonus / getBookDex / openBookshelfMenu`
  (the bonus is folded into `getSkillGainMul`, so progression/ is unchanged).
- `implants.ts`: `ImplantsRef.damageBarrier(owner, point, amount?)`; `raycastBarrier` is a **pure** query now (real projectile hits call `damageBarrier` once).
- `labels.ts`: `book` in the three category records. `meta.ts`: 세레스 stock `{category:'book', minRepLevel:2}`.
- Ownership: `server/` + `net/` newest-wins profiles · parked-host migration rule · reload = mission leave · ghost fields · `dhp` · e2e ·· `player/` + `game/` ghost `downHp` inheritance ·
  parked ghosts · give-up progress · wipe check off the ref ·· `stratagems/` + `implants/` + `gadgets/` strat sync · barrier purity / resend · jump-pad retrigger · gadget burn credit ··
  `weapons/` + `pickups/` `damageBarrier` at real hits · flame / shock attacker · pickup re-sync ·· `enemies/` delta snapshots · burn attacker · `enemy:killed.by` · enemy fire vs barriers ··
  `housing/` + `items/` + `progression/` 서재 (books, shelf, codex) ·· `world/` + `hub/` training modes · rack / mode consoles · bookshelf model ·· `inventory/` + `meta/` profile `fresh` ·
  catalog tab · meta sync + validation ·· `ui/` give-up bar · TrainingPanel · ghost bleed bar.
