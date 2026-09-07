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
  - **`WORKSHOP_ROOM_INDEX`** (0) — **deprecated 2026-09-07, no longer enforced.** It used to make room 1 the ship's
    permanent 작업실 (built for free, with the 총기 작업대 + 정비 벤치 already placed). A new ship is now ten 빈 방 with
    no furniture and the 작업실 is an ordinary purpose: any room may take it, one per ship, paid for with
    `ROOM_PURPOSE_BUILD_COST`. The constant stays exported so the contract remains append-only; nothing reads it.
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
  rejoining keeps a parked, non-simulated ghost the host restores on a rejoin inside the window — **2026-09-07**
  raised 120 s → 3600 s, i.e. "for the rest of the raid", matching the relay now keeping their lobby slot that long); `META_HIT_MAX`; `strat sync {calls: StratagemCallWire[]}` + `stratq sync`
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

## Phase 9 UI pass (2026-09-07) — appended contract

Appended, never renamed. Everything below is additive; existing readers are untouched.

- `housing.ts`:
  - `ROOM_PURPOSE_GLYPH` / `ROOM_PURPOSE_COLOR` and `FACILITY_GLYPH` / `FACILITY_COLOR` — the **one** icon + accent
    per room purpose / facility. Every facility row in the game draws this glyph on a `--pc`-tinted thumbnail
    (`housing/ui/dom.facilityThumb`, `ui/hud/ShipManage`'s `.sm-thumb`), so a room reads the same in the 함선 tab
    방 목록, the 시설 관리 room list and its 용도 지정 picker. Procedural — no asset files.
  - `HousingRef.facilityRefund(index)` — every material spent upgrading that room's facility (level 1 comes free with
    the purpose, so a Lv.1 room refunds nothing). Rendered as the cost chips of the 제거 confirmation.
  - `HousingRef.removeRoomFacility(index)` — 시설 제거: placed pieces → furniture storage, upgrade materials → the
    **함선 창고**, purpose → 빈 방. All-or-nothing; returns a 한국어 reason (and changes nothing) when the stash has no
    room or the rules refuse the room (the built-in 작업실, a 책장 whose books do not fit).
- `types.ts`:
  - `InventoryRef.createTradeGrids(host, opts?)` + `TradeGridsViewOptions` — the player's **real 가방 / 함선 창고
    grids** embedded in another folder's screen (the 기업 거래 desk). Read + drag-out only: a tile dragged onto one of
    `dropSelector`'s targets (or double-clicked) calls `onTake`; the view never moves, removes or rearranges anything,
    so the caller stays the only one mutating the inventory. No blocker, no pointer-lock call, no window key listener.
- Ownership: `hub/` cockpit rebuild (terminal on the dashboard, computer on the rear wall, door frames / wainscot) ·
  `housing/` refund + 방 목록 rewrite · `ui/` 시설 관리 hints + sorted 용도 지정 picker · `inventory/` `TradeGrids` ·
  `meta/` the 거래 desk (상점 + 판매 merged into a staged basket).

## Phase 9 UI/UX 개선 pass (2026-09-07) — appended contract

Appended, never renamed. Everything below is additive; existing readers are untouched.

- `housing.ts`:
  - `ROOM_PURPOSE_BUILD_COST` + `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` (1) — a **시설 증축** (giving an empty room a
    purpose) costs materials now and sits behind the same 발전기 gate as every other upgrade. This table is the price
    of the facility's level 1; the `*_UPGRADE_COST` tables still cover levels 2+. 빈 방 costs nothing.
  - `HousingRef.purposeCost(purpose)` — that table, for the pickers' cost chips. `setRoomPurpose` consumes it and
    `purposeBlock` reports a shortage; `facilityRefund` hands it back on 시설 제거 (so a Lv.1 room refunds its build
    price now, where it used to refund nothing).
- `meta.ts`:
  - `SquadContractInfo { peer, id, progress }` + `MetaRef.getSquadContracts()` — every squad member's active contract
    as last broadcast, the local player excluded. Per-mission: cleared at `game:newMission` / `game:abort` /
    `hub:entered` / `net:lobbyLeft`. Read by `ui/hud/ContractPanel`.
- `net.ts`:
  - `MetaMessage` gained `{ t:'meta', ev:'contract', id: string | null, progress: number }` — a member's own contract,
    broadcast on `world:ready`, on every local progress change (deduped) and on accept / abandon, and repeated to a
    peer that asks with `metaq sync`. `id` null clears the sender's row.
- `events.ts`:
  - `'meta:squadContract' { peer, id, progress }` — a squad member's contract changed (or the list was cleared).
- Ownership: `meta/` the broadcast + the per-peer map · `ui/` the 분대 계약 rows, the 빠른 사용 / 임플란트 썸네일
  column, the bottom-left squad column and the 가구 제작 / 가구 창고 tabs · `housing/` the 시설 증축 cost + refund and
  the 함선 tab 증축 popup · `inventory/` the raid window taking the ship layout · `progression/` the implant cards.

## Phase 10 UI 개선 pass (2026-09-07) — appended contract

Appended, never renamed. Everything below is additive; existing readers are untouched. `/* Phase 10 skeleton */`
markers in `implants/` `inventory/` `net/` `player/` exist only to keep `npm run typecheck` green — replace them.

### `cursor.ts` — 마우스 커서 모드  *(rewritten 2026-09-07, see the last section)*
The second (and last) DOM-adjacent file in `shared/`, after `itemChip.ts` — and since the rework it touches no DOM at
all. Phase 10's virtual cursor (a pointer lock kept open while synthesised events drove the UI) is **gone**; what is
left is a ref-counted mode flag. See **마우스 커서 rework** at the end of this file for the current contract.

### `implants.ts` — 배리어 = 들고 다니는 방패
- `ImplantsRef.barrierCarried` + `getBarrierPose(out)`. The def's `mode` becomes `'wielded'`, so Q takes the shield
  into the hands and `blocksWeapons` holsters the gun (the 대전차포 flow). `raycastBarrier` / `damageBarrier` keep
  their signatures — they were always transform-agnostic; `barrierActive` now means "raised in hand".
- `constants.ts`: `IMPLANT_BARRIER_CARRY_WIDTH / _HEIGHT / _OFFSET / _BASE_Y / _SPEED_MUL / _ARC / _REGEN /
  _REGEN_DELAY` and `IMPLANT_BARRIER_BLOCK_DAMAGE`. **`_OFFSET` must stay greater than `PLAYER_RADIUS`** or enemy
  hitscan clamps to the player capsule before the barrier query runs and the shield never blocks.
- `net.ts`: `ImplantMessage` gained `{ t:'imp', ev:'shield', up, hp }` (the transform rides on the sender's own
  snapshot: `p`, `yaw`, `PlayerFlags.BARRIER`); `PlayerSnapshot.bhp`; `RemotePlayerRef.isBarrierUp / barrierHp`.
  `ev:'barrier'` stays parsed for an older peer.
- `events.ts`: `'implant:barrierCarried' { up }`.

### `types.ts` — 적 사망 다각화 · 확률 루팅
- `EnemyDeathDir` (`'left' | 'right' | 'back'`) + `ENEMY_DEATH_DIRS` (wire order) + `CORPSE_LOOT_CHANCE` per
  `EnemyType` (trash bug 0.1 · 상위 버그 0.35 · 보스 / 로그 1). The lootable roll comes from an **independent** seeded
  stream (`worldSeed ^ (enemyId * 0x9e3779b1)`) so it neither shifts the existing `rollCorpse` rolls nor needs a wire
  field. `EnemyRef.deathDir? / lootable?`.
- `constants.ts`: `DEATH_FALL_TIME`, `CORPSE_FALL_MAX_SPEED`, `CORPSE_LAND_TIMEOUT`.
- `net.ts`: `ee kill.dd?` and `ee corpse.dd? / lt?` (index into `ENEMY_DEATH_DIRS`; `lt: 0` = un-searchable).
- `events.ts`: `enemy:killed.deathDir?`, `corpse:spawned.lootable? / deathDir?`.

### `types.ts` — 부상자 들쳐메기
- `CarryEndReason`; `PlayerRef.carrying / isCarried / carry(id) / dropCarried(reason?) / setCarriedBy(socket)`;
  `PlayerWeaponHost.getShoulderSocket?()`; `RemoteAvatarRef.shoulderSocket?`.
- `net.ts`: `PlayerFlags.CARRYING` (1 << 26) / `CARRIED` (1 << 27), `PlayerSnapshot.cr?`,
  `RemotePlayerRef.carrying? / isCarried? / carriedBy?`, `CarryMessage` (`carry pick|drop`).
- `constants.ts`: `PLAYER_CARRY_RANGE / _PICKUP_S / _DROP_S / _SPEED_MUL / _OFFSET`.
- `events.ts`: `'player:carryStarted'`, `'player:carryEnded'`, `'net:remoteCarryChanged'`.
- `Keybinds.ts`: `KEY_ALIASES.CARRY = 'MELEE'` (+ `KeyBindings.CARRY` / `DEFAULT_KEYS.CARRY = 'KeyF'`). **E-hold
  revive is unchanged** — only the F *tap* is contextual.

### 회복약 (was 스팀)
- `constants.ts`: `HEAL_HOLD_S` (2), `HEAL_HOLD_CANCEL_ON_DAMAGE` (false).
- `events.ts`: `'heal:holdChanged' { holding, t }` — the same shape as `grenade:holdChanged`.
- `labels.ts`: the `stim` category label is **회복약**. The `stim` def id, `ItemCategory 'stim'`, `ItemDef.healAmount`
  and `PlayerRef.applyStim` are **unchanged**, so every existing save / loot table / recipe keeps working.
- `Keybinds.ts`: the `STIM` action is **gone from `KEY_ACTION_DEFS`** (H is retired), exactly the way `GRENADE` was.
  `KeyBindings.STIM` / `DEFAULT_KEYS.STIM` stay for append-only compatibility and are now unread.

### 크레딧 표기 · 재장전 게이지 · 지도 핑 · 컨테이너 실시간 루팅 · 빛기둥
- `meta.ts`: `CREDIT_SUFFIX` (`'C'`), `formatCredits(n, {sign?, suffix?})`, `formatCreditAmount(n)`,
  `itemCreditValue(def, qty?)`. **The one formatter** — the `fmtValue` currency prefix in `inventory/ui/labels.ts` and
  the `cr` suffix in `ui/hud/ItemTip` / `meta/ui/CorpView` both go away. `크레딧` stays a word in sentences; the unit
  is `C`.
- `events.ts`: `'weapon:reloadCancelled' { weaponId }` — genuinely new: `WeaponSystem.cancelReload()` was silent, and
  the bottom-right panel only got away with it because `weapon:equipped` closed its arc.
- `events.ts`: `'ping:requestAt' { position, kind }` — a ping asked for by a surface with no aim ray (map middle-click).
- `events.ts`: `'container:itemTaken' { containerId, idx, uid, qty, remaining, by, byName, byLocal, live }`.
  `cont taken` was **already broadcast to every peer**, so the live sync was only ever a presentation gap; `live`
  separates a real-time take (animate) from a `cont sync` catch-up (silent). `net.ts`: `cont taken.rem? / seq?`.
- `constants.ts`: `CONTAINER_TAKE_ANIM_S / _RISE_PX / _END_SCALE`;
  `INTERACT_PILLAR_HEIGHT / _RADIUS_BOTTOM / _RADIUS_TOP / _OPACITY / _FADE`, `SCAN_PILLAR_HEIGHT`,
  `PICKUP_PILLAR_HEIGHT / _OPACITY`. The light-blue fresnel sphere lives in **`ui/hud/Detection.ts` and
  `ui/hud/ScanReveal.ts`** (not in `pickups/`) — both become fading pillars.

### 발사 준비 패널
- `net.ts`: `CrewCardWire { level, implant, armor, primary?, primary2?, secondary? }`, `CrewMessage`
  (`crew card` / `crew loadout`), `CrewRequest` (`crewq sync` / `crewq loadout`),
  `RemotePlayerRef.crewLevel? / equippedImplant?`, `NetRef.getCrewCard(id) / requestCrewLoadout(id)`.
  Needed because **`PlayerSnapshot.imp` and `.w` are nulled in the hub** and `LobbyPlayer` carries no level;
  `equippedImplant` is the ship choice, `implantId` is the wielded one.
- `types.ts`: `PortraitRef` + `PlayerRef.createPortraits(host, cells)` (own `THREE.WebGLRenderer` — `core/Engine`
  renders through the composer at the end of the frame and offers no post-render hook, so a portrait cannot share the
  main canvas); `CrewLoadoutViewOptions` + `InventoryRef.captureCrewLoadout() / createCrewLoadoutView(...)`.
- `constants.ts`: `HUB_READY_CELLS`, `HUB_READY_PORTRAIT_YAW`, `HUB_READY_BLOCKER`, `CREW_CARD_MIN_INTERVAL_S`,
  `CREW_LOADOUT_COOLDOWN_S`.
- `events.ts`: `'net:crewCard'`, `'net:crewLoadout'`, `'hub:readyPanelToggled'`, `'hub:crewLoadoutToggled'`.
- Ownership: `player/` the soldier model rewrite (스플래툰 3등신 — **2026-09-07 롤백**) + portraits + carrying · `implants/` the shield ·
  `enemies/` deaths + lootable corpses · `ui/` the crosshair reload gauge, the heal gauge, the map ping, the credit
  bar on both tooltips, the software-cursor sprite and the pillars · `inventory/` the live container sync + the
  foreign loadout view · `weapons/` the 2 s heal hold and the retired H key · `hub/` the READY panel and the housing
  camera · `net/` the crew wire · `meta/` the credit formatter rollout.

## Phase 11 — 행성 선택 · 소셜 (2026-09-07)
Appended, never renamed. `/* Phase 11 skeleton */` markers in `hub/HubSystem.ts`, `net/NetSystem.ts` and
`world/WorldSystem.ts` exist only to keep `npm run typecheck` green — replace them.

### New file: `planets.ts` — 행성
The seed still decides layout / crates / nests / loot; the **planet** decides the look and the wildlife.
- `PlanetId` (`amber | tundra | mossy | ashen | crimson`, one per `world/biomes.ts` entry) + `PLANET_IDS` (terminal
  and wire order), `PLANET_DEFS` (5 × `PlanetDef`), `getPlanet` / `isPlanetId` / `planetIndex` / `planetLabel`,
  `PLANET_NONE_LABEL` (`목표 미지정`), `PLANET_THREAT_LABELS`, `PLANET_STORAGE_KEY` (`scav.planet`).
- `PlanetDef` names its `biome` (`world/biomes.ts`) **and** its `sky` (`core/Sky.ts` `SKY_PALETTES.name`) explicitly.
  Before Phase 11 both were drawn from the seed and matched only because both lists happened to have 5 entries
  (`biomes.pickBiome` mirrored `Atmosphere.applySeed`); with a planet the pairing is data, not luck. **Both hook
  points must be overridden together** — `world/WorldSystem.generate` (`this.biome`) and `core/Engine`'s
  `world:ready` handler (`atmosphere.applySeed`). No planet = the old seeded draw, unchanged.
- `fog: false` (카민 I) is the one planet without fog: core forces `fog.density = 0` and paints the background from
  the sky's horizon instead of the fog colour (`Atmosphere.applyPalette` forces `background = p.fog` today).
  `fogMul` scales the palette's own `fogDensity` for the other four.
- `PlanetEcosystem` is pure re-weighting of existing content (no new enemy, no new item): `bugs` are relative weights
  for `enemies/Spawner.ts`'s `ambientGroup` / `waveGroup` — **the existing threat gates still apply on top**, so the
  difficulty ramp is unchanged and only the silhouettes differ — plus `pressure` (ambient cap), `rogues` /`boss`
  (`RogueGuards`), `maxArtillery` / `maxBehemoth` (were module constants), `herbs` (weights by herb def id, replacing
  `Gather.resolveHerbIds`'s uniform 1/3) and `gatherDensity`.
- Wire: `LobbyState.planet?`, `lobby:planet` (host, not started), `lobby:start.planet?`, `game:start.planet?`,
  `LobbyErrorCode 'no_planet'`. **There is no travel message** — a planet change broadcasts `lobby:state`, and every
  member starting the cutscene off its own copy is what keeps the squad in sync.
- `types.ts`: `HubRef.planet / setPlanet / travelling`, `WorldRef.planet`. `GameContext.missionPlanet` (the emitter
  of `game:newMission` sets it **before** emitting, exactly like `missionMode`, because `world/` generates inside the
  emit). `events.ts`: `game:newMission.planet?`, `world:ready.planet?`, `net:gameStarting.planet?`,
  `hub:planetChanged`, `hub:travel`, `hub:terminalToggled`.
- `constants.ts`: `HUB_TRAVEL_DURATION` (4.5) / `HUB_TRAVEL_WARP_FRACTION` / `HUB_TRAVEL_WARP_STRETCH`,
  `PLANET_HOLOGRAM_PX` / `_SPIN` / `_TILT`, `PLANET_SWAP_TIME`.

### New file: `social.ts` — 아이디 · 친구 · 최근 만난 플레이어 · 귓속말 · 분대 초대
- **Identity.** `PlayerCode` = 8 chars of `PLAYER_CODE_ALPHABET` (no I/O/0/1), displayed `AB3D-9KMN`
  (`formatPlayerCode`), derived from the relay's stable `PeerId` by the pure `playerCodeFrom(peerId, salt)` — the
  server assigns it once, keeps a code → PeerId index and bumps `salt` on a collision. `normalizePlayerCode` /
  `isValidPlayerCode` for typed input. **Only the code travels**; a client never learns another player's PeerId.
- **Storage.** `SocialRecord` (friends / incoming / outgoing / recent / name / level / code / salt) lives on
  `ProfileRecord.social` — **server-owned and server-readable**, unlike the opaque `docs`, because the relay has to
  cross-reference it. Nothing social is cached client-side: with no relay the whole feature is absent
  (`SocialRef.available === false`).
- **Presence.** `PresenceState` (`offline | ship | raid | training`, `PRESENCE_LABELS`) + `SocialPlayer.squad`
  (0 = 개인 함선). A member inside the 5-minute reconnect grace reads `offline` — they are gone *now*.
- **Rules.** `playBlockReason(target, mySquad, maxSquad, isSelf)` → `PlayBlock | null` with `PLAY_BLOCK_LABELS` is the
  single 같이 하기 gate: the UI greys the button out with it and the server refuses with it. `PlayOutcome`
  (`joined` | `invited`) is how the server reports which branch it took; the **server** decides, not the UI.
- Wire: `social:get / me / request / respond / remove / play / whisper` up, `social:state / invited / whisper / play /
  error` down, `welcome.social?`. Caps in this file: `SOCIAL_RECENT_MAX` 20, `SOCIAL_FRIEND_MAX` 100,
  `SOCIAL_REQUEST_MAX` 50, `SOCIAL_WHISPER_MAX` 200, `SQUAD_INVITE_TTL_S` 90, `SQUAD_INVITE_HOLD_S` 3,
  `SQUAD_INVITE_MAX` 3, `SOCIAL_ME_DEBOUNCE_MS`. `SocialErrorCode` gained `my_squad_full` / `in_squad` after the first
  draft: `playBlockReason` already told those two apart, so collapsing them onto `full` / `already` printed the wrong
  Korean sentence (내 분대 vs 상대 분대).
- `net.ts`: `NetRef.social` (`SocialRef`), `lobbyPlanet`, `setLobbyPlanet`. `events.ts`: `social:updated / invited /
  inviteClosed / whisper / play / error`, `ui:communityToggled`, `chat:whisperTo`. `types.ts`: `ChatKind 'whisper'`.
  `constants.ts`: `COMMUNITY_BLOCKER` (`community`), `SOCIAL_CARDS_PER_ROW` / `SOCIAL_FRIEND_ROWS` /
  `SOCIAL_RECENT_ROWS`, `SQUAD_VOICE_DEFAULT`. `Keybinds.ts` / `constants.ts`: **`Keys.INVITE` = P** (분대 초대 수락
  홀드) — the undocumented `P` character-sheet toggle in `progression/ProgressionSystem` was retired for it (캐릭터 is
  a Tab-screen tab since Phase 8), because both listened with `uiBlockers.size === 0`.
- Voice sliders in the 분대원 panel are **UI only** (`SQUAD_VOICE_DEFAULT`); there is no voice chat.
- Ownership: `server/` the social store + presence fan-out + `lobby:planet` · `net/` `SocialSync` + the planet wire ·
  `hub/` the full-screen terminal, planet selection, the travel cutscene and the launch-slot gate · `ui/` the ESC
  layout (buttons left, social column right), the settings panel, the community icon / invite panels and the whisper
  mode · `world/` planet → biome + herbs · `core/` planet → sky / fog (lead) · `enemies/` the ecosystem.

## appended: 2026-09-07 UI/UX pass (기업 화면 통합 · 그리드 칸 크기)

Two **appended** additions only — nothing was renamed or removed.

- `types.ts`: `InventoryScreenTab` (`'inventory' | 'character' | 'corp' | 'ship'`) and, on `InventoryRef`,
  **`openScreen(tab)`** + **`screenTab`**. The Tab window is the only shell for the embedded screens, so a folder that
  wants to *show* one (meta/ from the 함선 컴퓨터) opens it through this instead of owning an overlay. `openScreen`
  is ship-only and returns whether that tab is what the window ended up showing.
- `types.ts`: `TradeGridsViewOptions.cell` — the grid cell edge in px (default 54). The 기업 거래 desk passes 40 so
  its 가방 / 함선 창고 match the 5-column 구매 / 판매 tray beside them. `inventory/ui/GridView` takes the same number
  at construction; it is fixed for the life of the view.

Not a contract change but worth knowing (**superseded 2026-09-07**): the Phase 10 software cursor hid the native one
with `body.soft-cursor-on * { cursor: none !important }`, which any `cursor` rule could beat on specificity. Both the
class and that hazard are gone — `ui/hud/GameCursor` now *restyles* the real cursor, and it mirrors every stylesheet
`cursor:` affordance automatically, so a new `cursor: pointer` rule needs no coordination at all.


## appended: 2026-09-07 총기 이름 정리 · 회복 소모품 개편 · 기본 지급품

Contract additions (append-only; the one **removal** is the two duplicate weapon families, see below).

- `types.ts`: `ItemDef.heal?: HealDef` and the new `HealDef {useTime, amount, overTime, spray?}` /
  `SprayDef {tick, gaugePerTick, healPerTick, radius}`. `useTime` is the LMB hold in seconds, `amount` / `overTime`
  the hp and the seconds it is spread over, `spray` marks a channelled item whose gauge is the instance's
  `durability` (`ItemDef.durabilityMax`). Owner: items/ declares them, weapons/ executes them.
- `types.ts`: `PlayerRef.applyHeal(amount, seconds, quiet?)` next to `applyStim` — the same heal-over-time pool with
  the consumable's own duration; `quiet` skips the SFX and the "already healing" refusal (회복 스프레이 ticks 10×/s).
- `constants.ts`: `CONSUMABLE_SLOW_MUL` (0.5) + `CONSUMABLE_SLOW_KEY` (`'consumable'`) — the movement penalty while a
  consumable is being used, applied through `PlayerRef.setSpeedModifier`; `DEFIB_USE_TIME_S` (1); `HEAL_SPRAY_GAUGE`
  (100) / `HEAL_SPRAY_RADIUS` (8). `HEAL_HOLD_S` stays as the fallback for a `stim` def with no `heal` block.
- `constants.ts`: **`AMMO_STACK_ROUNDS` changed** — light 120 → **80**, medium 90 → **50**, heavy 30 → **25**,
  shell 24 → **25**. One stack is one 세트 (the 기본 지급품 counts sets). The legacy `rifle/pistol/shotgun/energy`
  entries were moved to match. Anything that assumed a stack size (loot `ammoFraction`, corpse `ammoFraction`, the
  reload reserve display) reads the constant, so nothing else needed a change.
- `events.ts`: `heal:holdChanged` gained **`dur?`** (the item's own use time in seconds) and **`spray?`** (while
  spraying, `t` is the remaining gauge 0..1 instead of progress). Existing readers that only use `{holding, t}`
  keep working.
- **Weapon families are the classes now** (items/, but every folder that named a weapon id is affected): the eight
  branded families collapsed to six — `ar` 돌격소총 · `smg` 기관단총 · `sg` 산탄총 · `dmr` 지정사수소총 · `sr`
  저격소총 · `hg` 권총 — and `las16` (a second AR) / `p19` (a second pistol) are **gone**. Ids: `ar`, `ar_g3`,
  items `wpn_ar`, `wpn_ar_g3`; names are the class label + grade numeral (`돌격소총 III`). Nothing in `src/shared`
  holds a weapon id except the `meta.ts` quest rewards, which were repointed.
- **스팀 / 고급 스팀 are gone** (`stim` / `stim_advanced` def ids), replaced by 붕대 / 약초 붕대 / 회복주사 /
  회복 스프레이 — `ItemCategory 'stim'`, `QUICK_USABLE_CATEGORIES`, `applyStim` and `player:stimUsed` are unchanged.
  `meta.ts`'s quest reward now hands out `heal_syringe`.


## 마우스 커서 rework (2026-09-07)

Phase 10's premise — *never release the pointer lock, drive a virtual cursor, synthesise the DOM events* — is
reversed. **락 = 시점 조작 / 언락 = 진짜 커서.** The public API did not move, so no screen had to change.

- **`cursor.ts` is now `class CursorMode`**: a ref-counted set of blocker tokens plus a mode listener
  (`setMode(active, owner) → changed`, `active`, `owner`, `has(token)`, `clear()`, `emitChange()`). No position, no
  dispatch, no hover bookkeeping, no default-action emulation — the browser does all of that again, because the
  events are real. `SoftCursor`, `SOFT_CURSOR_FLAG` and `isSoftCursorEvent` are **deleted**.
- **`Input.setCursorMode(active, owner)`** (unchanged signature) releases the pointer lock on the first owner and
  clears the gameplay mouse state; the **re-lock on the way out is `main.ts` alone** (one place for every folder).
  While cursor mode is on, `Input` records **no** gameplay mouse presses / wheel — the press belongs to whatever the
  cursor is over, which already got it natively — so a click on a panel can never also fire the gun.
- `uiX` / `uiY` / `cursorX` / `cursorY` are all `mouseX` / `mouseY` now; `elementUnderCursor()` is
  `document.elementFromPoint` at the real position; `setCursorPosition` only seeds the tracked coordinates (the OS
  cursor cannot be warped from a page). `cursorOwnsInput` / `setCursorSynthetic` are gone.
- **`syncKeyboardLock`**: while the document is fullscreen, `navigator.keyboard.lock(['Escape'])` routes Escape to
  the page, so Escape stops breaking the pointer lock and "Esc 로 닫으면 즉시 카메라" is literally true. Leaving
  fullscreen becomes a long Escape press (the browser's own affordance). Outside fullscreen the gesture retry below
  is still the fallback. `Input.keyboardLocked` reports it.
- The **denied-lock gesture retry** (`awaitingLockGesture`, `LOCK_GESTURE_RETRY_MS`) is unchanged and still needed
  outside fullscreen; it now also disarms itself if a screen opened in the meantime.
- **좌클릭으로 카메라 되찾기** (2026-09-07): the `mousedown` handler now checks `takeLockOnClick(e)` right after the
  cursor-mode branch — a **left** click whose target is the **canvas**, while `wantLock` is set and the lock is
  missing, re-requests the lock and **swallows the press** (it is never recorded as a gameplay button, so the click
  that takes the camera back cannot also fire the weapon). That is the state a screen closed with Escape leaves
  behind outside fullscreen; the click is the user gesture Chrome was waiting for. A click on an interactive HUD
  element keeps its own target and is untouched, and the title screen never qualifies (`wantLock` is false there).
- `constants.ts`: `SOFT_CURSOR_SENSITIVITY` / `SOFT_CURSOR_SIZE` / `SOFT_CURSOR_DBLCLICK_MS` are **gone**, replaced by
  `GAME_CURSOR_SIZE` (the drawn art) and `FREE_CURSOR_BLOCKER` (`'cursor'`, the Alt cursor's token).
- **Keys**: `DIVE` moved off Alt onto **V**, the new **`CURSOR`** action took `AltLeft`, and **`SWAP` (이전 무기) was
  removed from `KeyBindings` entirely** — the only key-table *deletion* so far. A stale `SWAP` entry in a saved
  `scav.keybinds` is ignored by `loadKeybinds`.
- `events.ts`: `'ui:freeCursorToggled' { active }` next to `'input:cursorModeChanged'`.
- The 일시정지 메뉴 is **no longer a special case**: `ui/menus/MenuBase` takes the `'menu'` cursor token like every
  other screen, so there is exactly one way to show the mouse in the whole game.


## 2026-09-08 — ESC = 항상 일시정지 (shared)

- **`Input.onUserUnlock(listener)`** + the `selfExit` flag. The browser reserves Escape for leaving the pointer lock
  and **swallows the keydown**, so `pointerlockchange` is the only evidence the key was pressed — this is the hook
  `main.ts` mirrors onto `input:pointerLockLost` and `game/` turns into the 일시정지 메뉴. `exitPointerLock()` marks
  releases the game itself made (a screen taking 커서 모드) so they stay silent; what reaches the listener is a lock
  the player took away while the camera still wanted it. Only one listener (`main.ts`), like `cursor.onModeChange`.
- **`MENU_BLOCKER`** (`'menu'`): the token every `ui/menus/MenuBase` screen holds. Screens whose own key doubles as
  their close key (Tab / M / P / E) test for it so that key does not reach through the 일시정지 메뉴 stacked on top.
- **`COMMUNITY_TAP_MAX_S`** (0.3 s): `Keys.INVITE` (P) is tap = 커뮤니티 패널, hold = 분대 초대 수락.
- **`events.ts`**: appended `ui:displayChanged {fullscreen, bloom, shadows, scale}` — the 화면 설정 section publishes
  it, `main.ts` applies it to the `Engine` (ui/ cannot import core/).
- **`Keybinds.ts`**: the 인터페이스 labels now name both jobs of each key — `INVENTORY` 인벤토리 · 캐릭터 · 기업 ·
  함선 (열기 / 닫기), `MAP` 지도 · 함선 관리 (열기 / 닫기), `MENU` 일시 정지 (메뉴는 게임으로 돌아가기로 닫기),
  `INVITE` 커뮤니티 (길게: 분대 초대 수락). No id changed, so existing saves are unaffected.

### Known follow-ups
- `onUserUnlock` cannot tell an Escape from an alt-tab: both are "a lock we did not release". That is fine — a focus
  loss pauses anyway — but it does mean a lock revoked by the browser for its own reasons also opens the menu.
- The `selfExit` flag is cleared on the next `pointerlockchange` of any kind. A release that never produces one (an
  engine that fires nothing) would leave it set and swallow the *next* genuine Escape.


## 2026-09-08 — 빛기둥 · 엄폐 (types.ts, append-only)

- **`Interactable.hidePillar?: boolean`** — true = `ui/hud/Detection` draws **no** 빛기둥 for this interactable even
  though it is in range and still interactable. Purely local presentation, and deliberately not replicated: a corpse
  sets it the first time *this* client opens it (`enemies/Corpses`), so the pillar goes away for whoever searched the
  body while it stays lit for everyone else. Undefined keeps the old "in range → pillar" behaviour.
- **`Obstacle.shotRadius?: number` / `shotHeight?: number`** — the cylinder `WorldRef.raycast` shoots at, when it
  differs from the movement cylinder. `radius` / `height` are tuned so nobody walks into an invisible wall, which for
  a lumpy rock means they sit *inside* its silhouette — bullets and line-of-sight then went through rock that was
  plainly in the way (엄폐가 통하지 않던 원인), and for a boulder the collider was also ~0.4 m **taller** than the
  rock, stopping shots in mid-air above it. `world/Props.ts` measures the drawn extent of each variant and passes it
  in; every other consumer keeps reading `radius` / `height` unchanged. Undefined = use those two, as before.
