# src/shared — Module contract

Everything every feature folder depends on. Append-only: add new events/fields, never rename or remove.

| File | Purpose |
|---|---|
| `constants.ts` | Map size, extraction countdown, player tuning, `Layers`, `Keys` bindings. **숫자는 여기에 없다** — 이름 · 주석 · 타입만 있고 값은 `data/constants.csv` 에서 읽는다 (`K.num('MAP_SIZE')`) |
| `data/csv.ts` | csv 파서 + 셀 접근자 (`num` · `int` · `bool` · `enum` · `list` · `costList`), `=상수` 식 계산기, 문제 수집(`dataIssues`). **아무것도 import 하지 않는다** — `constants.ts` 가 이것을 쓰므로 무엇을 가져와도 순환이 된다 |
| `data/tables.ts` | `import.meta.glob(..., '?raw')` 로 `data/*.csv` 를 번들에 넣고 표 단위로 꺼내 준다: `csvRows` · `csvGroups` · `keyTable` · `numberMap` · `numberList` · `stringMap` · `stringList` · `costLevels`. `=` 식이 constants → tuning → `표.키` 순으로 이름을 찾도록 해석기를 꽂는다 |
| `planetDefs.ts` | 행성 정의표 (`PLANET_DEFS`, `getPlanet`, `planetIndex`, `planetLabel`, `PLANET_THREAT_LABELS`) — `data/planets.csv` 를 읽으므로 **브라우저 전용**. 릴레이 서버가 Node 에서 직접 실행하는 `planets.ts` 와 갈라 두었다 |
| `types.ts` | `GamePhase`, `MissionStats`, item/weapon defs, `*Ref` interfaces (World, Player, EnemyManager, Inventory, Loot), `Interactable`, `GameSystem` |
| `events.ts` | `GameEvents` map: every bus event name → payload type, grouped by owning module |
| `EventBus.ts` | Typed synchronous emitter (`on/once/off/emit`) |
| `Input.ts` | Keyboard/mouse state with per-frame pressed/released sets, pointer lock helpers. `endFrame()` called by Engine |
| `GameContext.ts` | Shared context: bus, input, interactables registry, scene/camera/renderer, module refs, phase, stats, `uiBlockers`, `isGameplayActive()` |
| `Random.ts` | Seeded RNG (mulberry32) with `range/int/pick/weighted/shuffle/fork` |
| `planets.ts` | 행성 **계약만** (`PlanetId`, `PLANET_IDS`, `isPlanetId`, `PLANET_NONE_LABEL`, `PLANET_STORAGE_KEY`). 서버가 Node 에서 그대로 실행하므로 csv 를 읽지 않는다 — 표는 `planetDefs.ts` |
| `net.ts` | Multiplayer contract: lobby types, client↔server wire protocol (`ClientToServer`/`ServerToClient`), relayed `GameMessage` union (player/enemy snapshots, hit/explode requests, extraction/flow messages), `NetRef` (`ctx.net`), `RemotePlayerRef`/`RemoteAvatarRef`, `PlayerFlags`, tuning constants, slot colours, lobby-code helpers. Shared with the Node server (`server/`) — no runtime deps beyond plain constants |
| `itemChip.ts` | 재료 요구 칩 렌더러 (`buildItemChip` · `renderItemCost`). shared 의 DOM 둘 중 하나 |
| `currency.ts` | **재화** (2026-09-09) — 크레딧 · 경험치 · 기업별 신뢰도의 정의(`CURRENCY_DEFS`, `data/currencies.csv`)와 칩 렌더러 (`buildCurrencyChip` · `appendCurrencyRewards`). 아이템이 아닌 보상을 아이템 칩과 같은 자리 · 같은 크기로, 다른 틀(육각)로 그린다. 호버 카드는 `ui/hud/ItemTip` 의 `.is-currency` |
| `saveSlot.ts` | **캐릭터 세이브 슬롯** (2026-09-09) — `slotKey('scav.profile')` → `scav.s2.profile`. `activeSlot` · `setActiveSlot` · `ensureMigrated`(옛 단일 키 → 슬롯 1) · `readSlotCards` · `deleteSlot` · `markAutoStart`/`takeAutoStart`. 공용 저장(`SHARED_KEYS`: 키 바인딩 · 오디오 · 화면 · 콘솔 기록)은 접두사를 받지 않는다 |
| `character.ts` | **캐릭터 생성 규칙** (2026-09-09) — 능력치 하한 1 · 상한 5 · 합 15(`CREATE_STAT_*`), 배분 검사(`canAdjustStat`) · 주사위(`rollCreateStats` · `rollCallsign`) · 악센트 팔레트 · `makeCharacterProfile` / `createCharacterInSlot` |
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
Brief for the implementing agents: `docs/DECISIONS.md`.
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
Brief for the implementing agents: `docs/DECISIONS.md` Phase 5.
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
Brief for the implementing agents: `docs/DECISIONS.md`.
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
Brief for the implementing agents: `docs/DECISIONS.md`.
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
  `hub/` the full-screen terminal, planet selection, the travel warp (2026-09-09: in-ship 창문 워프, `hub:warpProgress`) and the launch-slot gate · `ui/` the ESC
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

## appended: 2026-09-08 — 임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · UX 정리 (Phase 12)

Plan: `docs/DECISIONS.md`. Everything below is append-only; owners in brackets.

### `types.ts`
- `ItemCategory` gains **`'implant'`** [items]. `ItemDef.implant?: ImplantItemDef` — `slots` (1..4 of the character's
  implant slots), `stats` (flat `Partial<Record<StatId, number>>`), `perk?` (`PerkId`, legendary only), `broken?`
  (raid loot; unequippable, no stats), `repairsTo?` + `repairCost?` (what 세레스 바이오 turns it into, and for what).
- `EnemyManagerRef.reportShot(origin, dir, range, hit | null)` [enemies; called by weapons on **every** local shot]:
  an enemy that could not perceive the shooter but sits within `ENEMY_SHOT_ALERT_DIST` of the bullet path (or
  `ENEMY_SHOT_IMPACT_DIST` of the impact) faces the origin with `ENEMY_SHOT_ALERT_CONE_MUL` perception for
  `ENEMY_SHOT_ALERT_WATCH_S`, then advances toward it; gives up after `ENEMY_SHOT_ALERT_GIVE_UP_S`. A non-host forwards
  the report to the host as `shotq`.
- `EnemyManagerRef.setXray(ids, seconds)` [enemies]: red through-wall silhouette for those enemies (정찰 reveal).

### `progression.ts`
- `PerkId` = `auto_revive` (player: 레이드당 1회 자동 기상) · `quick_heal` (weapons: 회복 hold ×0.5) · `kill_stamina`
  (player: 처치 시 스태미나 전량); `PERK_IDS`, `PERK_DEFS` (한국어 이름 · 설명).
- `EquippedImplant {uid, defId, durability?}` — the item instance is held by progression while equipped (out of the grids).
- `PlayerProfile.implants?`, `DerivedStats.perks: Record<PerkId, boolean>` (every key present).
- `ProgressionRef.implantSlots` (= `IMPLANT_SLOTS_BASE + ⌊level / IMPLANT_SLOTS_PER_LEVELS⌋`, ≤ `IMPLANT_SLOTS_MAX`),
  `implantSlotsUsed`, `getEquippedImplants()`, `equipImplant(uid)` / `unequipImplant(uid)` (ship only; the item moves
  via `ctx.inventory.takeItem` / `tryAddToStash`), `getStatWithImplants(id)`, `getImplantBonus(id)`. `getStat` stays
  the **base** value; `derived` is computed from the effective one.

### `implants.ts`
- `ImplantsRef.resolveBarrierCollision(pos, radius) → PeerId | 'local' | null` [implants; enemies call it per simulated
  bug per tick]: pushes the mover out of any raised shield (local or a peer's) and names the carrier.
- `ImplantsRef.absorbFrontalAttack(owner, fromPos, amount) → boolean` [implants; enemies call it on the host before
  enemy melee damage]: true = the carrier's shield faced the attacker and took it (local owner: hp deducted here; peer
  owner: the caller sends `ee barrierHit`).
- `ImplantsRef.bashing` — 실드 배쉬 swing in progress.
- 정찰 `mode` becomes `'instant'`: one wide pulse (`IMPLANT_SCAN_RADIUS`) for `IMPLANT_SCAN_REVEAL_TIME_V2` (15 s),
  shared with the squad over `imp scanCast`; `ScanTarget.kind` unchanged (`'enemy'` + the interactable kinds).

### `net.ts`
- `ShotReport {t:'shotq', o, d, r, h?}` client → host [enemies]. `ee barrierHit {id, amount, p}` host → one peer.
  `imp bash {p, yaw}`, `imp scanCast {p, radius, dur}` any → others [implants]. Joined into the unions as
  `EnemyEventAppended2026_09_08` / `ImplantMessageAppended2026_09_08`.

### `events.ts`
`progress:implantsChanged {equipped, slots, used}` · `implant:bashed {position, yaw, hits}` ·
`implant:barrierBumped {owner, enemyId, point}` · `enemy:shotAlerted {id, position, toward}` ·
`scan:cast {position, radius, duration, targets, byLocal}` (ui draws compass marks / indicators from it) ·
`ui:resumeGate {shown}` (browser-only '좌측 클릭으로 게임 재개') · `inventory:disassembleProgress {uid, t, done}` ·
`item:channelChanged {uid, defId, active, gauge}` (one ticker for a channelled 회복 스프레이).

### `constants.ts` / `labels.ts` / `cursor.ts`
- `IMPLANT_SLOTS_BASE 4 / _PER_LEVELS 5 / _MAX 10`; `IMPLANT_SHIELD_BASH_STAMINA 25 / _DAMAGE 55 / _RANGE 1.6 /
  _COOLDOWN 0.8 / _KNOCKBACK 6 / _SWING_S 0.35`; `IMPLANT_SCAN_RADIUS 70 / IMPLANT_SCAN_REVEAL_TIME_V2 15 /
  IMPLANT_SCAN_COOLDOWN_V2 30`; `ENEMY_SHOT_ALERT_DIST 6 / _IMPACT_DIST 10 / _WATCH_S 3 / _CONE_MUL 2 / _GIVE_UP_S 20`;
  `COMPASS_ENEMY_COLOR`; `RESUME_GATE_BLOCKER 'resumegate'`; **`HEAL_SPRAY_GAUGE` 100 → 200** (an empty can stays at
  durability 0 and is repaired in the ship instead of vanishing).
- `labels.ts`: `implant` → `임플란트` / `#e39cff` / `⬡`.
- `cursor.ts`: `isDesktopShell()` — Electron user agent (or `window.__scavDesktop` for tests).

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-08 (폐금속 공급)** — 계약에는 **추가만** 했다.
  `gear.ts` `CraftRecipe.extraOutputs?: CraftIngredient[]` (한 번의 제작이 내는 부가 산출물),
  `types.ts` `GatherNodeDef.kind?: GatherNodeKind` (`'herb' | 'salvage'`) 와 `InventoryRef.craft(recipeId, targetUid?)`,
  `events.ts` `gather:collected` 에 `kind?`,
  `constants.ts` `SALVAGE_NODES_PER_MISSION` (7) · `SALVAGE_INTERACT_TIME` (3).
  전부 선택 필드 / 선택 인자라 기존 호출부와 저장 데이터는 그대로 동작한다.

- **2026-09-08 (커서 되찾기 경합)** — `Input.requestPointerLock()` 이 **우리가 방금 부른 `exitPointerLock()` 이 아직
  착지하지 않은 사이**에 오면 그 요청을 들고 있다가 `pointerlockchange` 에서 다시 쏜다 (`relockPending`).
  브라우저는 `pointerLockElement` 를 **task** 에서 지우는데 화면들의 재락은 **microtask** 라, 한 tick 안에서
  화면이 떴다 사라지면(예: 훈련장 종료가 지나가는 `phase 'menu'` → 타이틀 메뉴가 커서를 잡았다 놓는다)
  요청이 `isPointerLocked === true` 를 보고 조용히 사라졌다 — 함선에 돌아왔는데 카메라가 죽고 Escape(=일시정지)
  말고는 할 수 있는 게 없던 상태의 원인. 판정은 `selfExit && isPointerLocked` 둘 다 볼 때만 미룬다 (동기적으로
  지우는 엔진과 이벤트를 쏘지 않는 헤드리스 스텁은 예전 경로 그대로).

- **Phase 6 (2026-09-06)** — `console.ts` (`ConsoleRef`, `isDevHost`), `housing.ts` (rooms / facilities / `FURNITURE_DEFS` / `HousingRef`), unique-weapon + stat-XP + housing constants — see the last section of `src/shared/README.md`

- **Phase 7** — `profile.ts` (`ProfileRef` = `ctx.net.profile`, `ProfileRecord`, `RaidSessionBlob`), `labels.ts` (rarity / category labels + palette, re-exported by items), `MissionMode` / `ctx.missionMode` / `ctx.rejoinPending` / `isTraining()`, ghost · container · beam wire types, `PlayerFlags` pose bits, `DamageMessage.kb`, `ContractSettlement.outcome`, `furn_sim_hub`, `BEHEMOTH_SCALE` 3 — see the last section of `src/shared/README.md`

- **Phase 8** — `itemChip.ts` (`buildItemChip` / `renderItemCost` — the one 재료 요구 칩 renderer, the only DOM in shared), `EmbeddedView`, `AudioRef` / `AudioSettings` (`ctx.audio`), `ItemCategory 'seed'` + `ItemDef.seed`, `FurnitureDef.stackLimit` / `PlacedFurniture.layer` / `GrowPlot` / 함선 관리 + 재배 members on `HousingRef`, `NetRef.serverNow()`, **`Input.consume(code)`**, `SHIP_STATE_VERSION` 2

- **Phase 8 UI pass** — `itemChip` stamps `data-def-id` (hook for the shared hover card), `WORKSHOP_ROOM_INDEX` 0 (방 1 = 작업실 forever), `HousingRef.purposeBlock`, `openRoomMenu / openFacilityMenu` redirect to 시설 관리, `furn_range_console` renamed **관물대**

- **Phase 9** — `ProfileRecord.docsAt` + `profile:set {at, fresh}` + `ProfileRef.set(key, doc, {fresh?})` (offline sets are queued, never dropped), `PlayerSnapshot.dhp`, delta `EnemyWire` / `EnemySnapshot {seq, gone}` + `NET_ENEMY_KEYFRAME_S`, `NET_GHOST_PARK_S`, `META_HIT_MAX`, `strat sync` / `stratq sync`, `meta sync` / `metaq sync`, `RemotePlayerRef.ghostState / ghostDownHp / downHp`, `ItemCategory 'book'` + `ItemDef.book`, `TrainingMode` / `TrainingRef` (`ctx.world.training`), `ImplantsRef.damageBarrier`, `EnemyManagerRef.applyStatus(..., attacker)`, `enemy:killed.by`, `player:giveUpProgress`, `housing:booksChanged`, 서재 (`furn_bookshelf`, `PlacedBook`, `ShipState.books / bookDex`, book members on `HousingRef`)

- **Phase 9 UI pass** — `ROOM_PURPOSE_GLYPH / ROOM_PURPOSE_COLOR` + `FACILITY_GLYPH / FACILITY_COLOR` (the one icon per facility, drawn everywhere a facility is listed), `HousingRef.facilityRefund / removeRoomFacility` (시설 제거 = 가구 → 가구 창고, 업그레이드 재료 → 함선 창고), `InventoryRef.createTradeGrids` + `TradeGridsViewOptions` (real 가방 / 창고 격자를 다른 폴더 화면에 embed)

- **Phase 9 UI/UX 개선** — `ROOM_PURPOSE_BUILD_COST` + `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` + `HousingRef.purposeCost` (시설 증축 비용), `SquadContractInfo` + `MetaRef.getSquadContracts()`, `meta contract` 메시지, `meta:squadContract` 이벤트

- **Phase 10 (2026-09-07)** — new `cursor.ts` (`SoftCursor` — the in-game mouse cursor: keeps the pointer lock and **synthesises** the DOM pointer/mouse events at a virtual position, so no UI surface changed; `isSoftCursorEvent`, faked-lock detection, default-action emulation for text fields / range sliders), `Input.cursor / isCursorMode / cursorOwnsInput / setCursorMode(active, owner) / cursorX·Y / uiX·uiY / elementUnderCursor / setCursorSynthetic`, `EnemyDeathDir` + `ENEMY_DEATH_DIRS` + `CORPSE_LOOT_CHANCE`, `CarryEndReason` + `PlayerRef.carry / dropCarried / setCarriedBy / carrying / isCarried`, `PortraitRef` + `PlayerRef.createPortraits`, `CrewLoadoutViewOptions` + `InventoryRef.captureCrewLoadout / createCrewLoadoutView`, `ImplantsRef.barrierCarried / getBarrierPose`, `PlayerFlags.CARRYING / CARRIED`, `PlayerSnapshot.cr / bhp`, `CarryMessage`, `CrewCardWire` / `CrewMessage` / `CrewRequest` + `NetRef.getCrewCard / requestCrewLoadout`, `imp shield`, `cont taken.rem / seq`, `ee kill.dd` / `ee corpse.dd / lt`, `formatCredits / formatCreditAmount / itemCreditValue / CREDIT_SUFFIX`, `HEAL_HOLD_S`, `PLAYER_CARRY_*`, `IMPLANT_BARRIER_CARRY_*`, `INTERACT_PILLAR_*`, `HUB_READY_*`, `SOFT_CURSOR_*`, the `STIM` key action **retired** and `KEY_ALIASES.CARRY = 'MELEE'`

- **Phase 11 (2026-09-07)** — `planets.ts` (`PlanetId` 5종 + `PLANET_DEFS` — 바이옴 · 하늘 팔레트 · 포그 on/off + `fogMul` · 홀로그램 색 · `PlanetEcosystem`, `getPlanet` / `planetLabel` / `PLANET_STORAGE_KEY`), `social.ts` (`PlayerCode` + `playerCodeFrom` / `formatPlayerCode`, `PresenceState`, `SocialSnapshot` / `SocialPlayer` / `SquadInvite` / `WhisperLine`, `playBlockReason` + `PLAY_BLOCK_LABELS`, `SocialErrorCode`, 캡 상수, 서버 소유 `SocialRecord`, `SocialRef`), `LobbyState.planet` · `LobbyPlayer.code / level` · `lobby:planet` · `no_planet` · `welcome.social` · `social:*` 12종, `NetRef.social / lobbyPlanet / setLobbyPlanet`, `HubRef.planet / setPlanet / travelling`, `WorldRef.planet`, **`ctx.missionPlanet`**, `ChatKind 'whisper'`, `hub:planetChanged / travel / terminalToggled`, `social:*` 이벤트, `ui:communityToggled`, `chat:whisperTo`, `HUB_TRAVEL_*` / `PLANET_HOLOGRAM_*` / `COMMUNITY_BLOCKER` / `SOCIAL_*`, **`Keys.INVITE` = P** (progression 의 문서화되지 않은 P 캐릭터 시트 토글은 폐기)

- **2026-09-07 (총기 이름 · 회복 소모품 · 기본 지급품)** — `ItemDef.heal` + `HealDef` / `SprayDef`, `PlayerRef.applyHeal(amount, seconds, quiet?)`, `CONSUMABLE_SLOW_MUL` / `CONSUMABLE_SLOW_KEY` / `DEFIB_USE_TIME_S` / `HEAL_SPRAY_GAUGE` / `HEAL_SPRAY_RADIUS`, `heal:holdChanged` 에 `dur` · `spray` 추가, **`AMMO_STACK_ROUNDS` 변경**(경 80 · 준중 50 · 중 25 · 산탄 25 = 한 세트), `meta.ts` 퀘스트 보상 무기 id 재지정

- **2026-09-07 UI/UX pass** — `InventoryScreenTab` + `InventoryRef.openScreen(tab)` / `screenTab` (함선 컴퓨터가 Tab 창의 기업 탭을 연다), `TradeGridsViewOptions.cell` (뷰별 그리드 칸 크기)

- **2026-09-07 (안정화 pass)** — `cursor.ts` 의 `SoftCursor.onMove(listener)` (스프라이트가 게임 프레임이 아니라 **입력 이벤트**에 붙는다), `NET_GHOST_PARK_S` 120 → 3600 (레이드가 끝날 때까지)

- **2026-09-07 (커서 편의성)** — `moveBy` 가 다시 **완전 선형**(같은 날 넣었던 `SOFT_CURSOR_ACCEL` / `_MAX` 삭제 — 14 px 손동작이 27 px 를 가서 조준한 곳에 서지 않았다), `Input.requestPointerLock()` 이 **거부된 요청을 기억**해 다음 진짜 제스처(클릭 · Escape 가 아닌 키)에서 재시도하고 `Input.awaitingLockGesture` / `LOCK_GESTURE_RETRY_MS` 를 노출한다

- **2026-09-07 (마우스 커서 rework)** — `cursor.ts` 가 `SoftCursor` → **`CursorMode`** 로 축소되어(토큰 ref-count + 모드 리스너뿐, 이벤트 합성 · 가상 좌표 · 기본동작 에뮬레이션 · `SOFT_CURSOR_FLAG` / `isSoftCursorEvent` 전부 삭제) **커서 모드 = 포인터 락 해제**가 되고, `Input.setCursorMode` 가 락을 놓으며 커서 모드 동안 게임플레이 마우스 입력을 기록하지 않는다, `uiX/uiY/cursorX/cursorY` 는 실제 커서 좌표, `cursorOwnsInput` / `setCursorSynthetic` 삭제, 전체화면이면 `navigator.keyboard.lock(['Escape'])` 로 Escape 가 락을 깨지 않게 하고(`Input.keyboardLocked`), `SOFT_CURSOR_*` 상수 → **`GAME_CURSOR_SIZE`** + **`FREE_CURSOR_BLOCKER`**, **`Keys.DIVE` = V · 새 `Keys.CURSOR` = Alt · `Keys.SWAP`(이전 무기) 삭제**, `events.ts` 에 `ui:freeCursorToggled`

- **2026-09-07 (기본 지급품 · 작업실)** — `WORKSHOP_ROOM_INDEX` 는 **deprecated** — 방 1 = 작업실 규칙이 사라졌고 아무도 읽지 않는다(계약은 append-only 라 export 는 유지) — see the last section of `src/shared/README.md`

- **2026-09-07 (좌클릭 카메라 복귀)** — `Input` 의 `mousedown` 이 커서 모드 분기 바로 뒤에서 `takeLockOnClick(e)` 를 본다 — 락이 없고(`wantLock`) 대상이 **캔버스**인 **좌클릭**이면 포인터 락을 즉시 다시 요청하고 그 누름을 **삼킨다**(게임 입력으로 기록하지 않으므로 카메라를 되찾는 클릭이 총을 쏘지 않는다). Escape 로 화면을 닫았을 때 창 모드 Chrome 이 남기는 상태가 바로 이것이고, 클릭이 Chrome 이 기다리던 제스처다

- **Phase 12 (2026-09-08)** — `ItemCategory 'implant'` + `ItemDef.implant` (`ImplantItemDef` — `slots` · `stats` · `perk?` · `broken?` / `repairsTo` / `repairCost`), `EnemyManagerRef.reportShot` / `setXray`, `ImplantsRef.resolveBarrierCollision` / `absorbFrontalAttack` / `bashing`, progression 의 `PerkId` 3종 + `PERK_DEFS` · `EquippedImplant` · `PlayerProfile.implants` · `DerivedStats.perks` · `implantSlots` 계열, net 의 `shotq` / `ee barrierHit` / `imp bash` / `imp scanCast`, events 의 `progress:implantsChanged` · `implant:bashed` · `implant:barrierBumped` · `enemy:shotAlerted` · `scan:cast` · `ui:resumeGate` · `inventory:disassembleProgress` · `item:channelChanged`, constants 의 `IMPLANT_SLOTS_*` · `IMPLANT_SHIELD_BASH_*` · `IMPLANT_SCAN_RADIUS`/`_V2` · `ENEMY_SHOT_ALERT_*` · `COMPASS_ENEMY_COLOR` · `RESUME_GATE_BLOCKER` · **`HEAL_SPRAY_GAUGE` 200** · `IMPLANT_BARRIER_CARRY_WIDTH` 3.2, `labels.ts` 임플란트, `cursor.ts` 의 `isDesktopShell()`, `meta.ts` 의 `ShopRule.maxRarity` / `implantRepairMaterials`

- **2026-09-08 (UI/UX)** — append-only 추가 둘: `types.ts` 의 `LaunchWarningId` / `LaunchWarning` + `InventoryRef.getLaunchWarnings()` (발사 슬롯 탑승 전 점검 — 판정은 inventory, 표시는 hub), `housing.ts` 의 `LoadoutPreset.implantItems?: readonly string[]` (임플란트 **아이템** def id 배열; `undefined` = 지금 장착을 건드리지 않음, `[]` = 전부 해제). 둘 다 선택 필드/추가 메서드라 옛 세이브와 옛 호출부는 그대로 동작한다

- **2026-09-08 (튜토리얼)** — 새 파일 `tutorial.ts`: `TutorialStepId` 14단계 + `TUTORIAL_STEPS`, `TutorialGate`
  9종, `TutorialSave`, `TutorialRef` (`ctx.tutorial`, `GameContext` 에 필드 추가). 이벤트 둘
  (`tutorial:changed` · `tutorial:finished`). **계약이 하는 일은 게이트 하나**다 — 각 폴더가 자기 거절 사유
  함수에서 `ctx.tutorial?.blockReason(gate, id)` 를 한 번 부르고, 숨겨야 할 셸 요소는 `hides(gate)` 로 묻는다.
  튜토리얼이 꺼져 있으면 둘 다 `null` / `false` 라 평소 동작이 바뀌지 않는다

- **2026-09-08 (가구 배치 재안내)** — `tutorial.ts` 에 단계 `'benchPlace'` **추가** (`bench` 와 `manageDone`
  사이, `TUTORIAL_STEPS` 15 → **16**). 가구는 제작하면 가구 창고로 들어가는데 `bench` 한 단계가 제작과 배치를
  함께 요구해 진행이 막혔다 — 제작 · 창고에서 집기 · 바닥에 놓기를 각각 안내한다. 타입 · 게이트 · 저장 모양은
  그대로다 (단계 id 하나만 늘었다)
- **2026-09-08 (튜토리얼 UI/UX 수정)** — `tutorial.ts` 에 **append-only** 둘: 단계 `'generator'`(발전기 가동,
  `manage` 와 `workshop` 사이 — 새 함선은 발전기 Lv.0 이라 그 전에는 작업실 증축이 규칙에 막혀 진행이
  불가능했다. `TUTORIAL_STEPS` 14 → **15**), 그리고 `TutorialRef.hides(gate, **id?**)` — 선택 인자라 옛
  호출부(`hides('community')`)는 그대로다. 의미는 "막히는 것은 곧 감춘다": id 를 주면 그 항목 하나를,
  안 주면 "이 게이트가 완전히 열려 있나"를 묻는다.
- **2026-09-08 (커서를 빼앗기지 않는다)** — `Input.requestPointerLock()` 이 **커서 주인이 있으면 요청 자체를
  하지 않고**, 이미 날아간 요청이 화면이 열린 뒤 도착하면 `pointerlockchange` 에서 즉시 락을 놓는다.
  화면을 여는 것과 같은 tick 에 relock 을 부르던 호출부(`hub/parts/Transitions.enter`)가 튜토리얼 시작 카드에서
  마우스를 도로 빼앗아 **카드를 클릭할 수 없던** 버그의 근본 수정이다. 커서 소유권 모델(`cursor.ts`)은 그대로다

- **2026-09-08 (ESC = 항상 일시정지 · 병합 정리)** — `RESUME_GATE_BLOCKER` 는 그대로 남는다. Escape 가 늘 일시정지 메뉴를 열게 된 뒤에도, 메뉴까지 닫힌 뒤 락을 되찾지 못한 마지막 경우(`awaitingLockGesture`)는 여전히 재개 게이트가 받는다 — `game/parts/Phases` 의 `noScreenOpen()` 계열이 이 토큰을 투명하게 취급하는 것도 그대로다

- **2026-09-08 (공용 함선 격납고)** — 전부 **추가만** 했다. `net.ts`: `ShipVisitWire` + `ShipVisitMessage`
  (`ship state`) / `ShipVisitRequest` (`shipq state`)가 `GameMessage` 에 붙고, `PlayerSnapshot.hs` ·
  `RemotePlayerRef.hubSite` · `NetRef.getShipVisit / requestShipVisit` 가 선언 병합으로 붙는다
  (`housing.ts` 의 `PlacedFurniture` / `PlacedBook` / `RoomPurpose` 를 **타입으로만** 가져오므로 Node 서버 쪽은
  그대로다). `types.ts`: `HubShipBay` 와 `HubRef` 의 `hubSite` · `visitingPeer` · `visitReadOnly` ·
  `getShipBays()` · `enterShipBay(slot)` · `returnToHangar()` — `types.ts` 는 `net.ts` 에 **import 되는 쪽**이라
  PeerId 를 못 쓴다, 그래서 `HubLaunchSlot.occupant` 와 같이 평범한 `string` 이다.
  `events.ts`: `net:shipVisit` · `hub:shipVisit`. `constants.ts`: `SHIP_VISIT_MIN_INTERVAL_S` ·
  `SHIP_VISIT_COOLDOWN_S` · `SHIP_VISIT_WAIT_S`.

- **2026-09-08 (격납고 리뷰 수정)** — `SHIP_VISIT_MAX_FURNITURE` 가 `constants.ts` 에 추가됐다. 양쪽이 **같은 수**를
  써야 한다: 보내는 쪽(`hub/parts/Hangar.shipStateWire`)은 프레임이 릴레이의 `MAX_MESSAGE_BYTES`(64 kB)를 넘지 않도록,
  받는 쪽(`net/model.sanitizeShipVisit`)은 이상한 문서가 콜라이더를 수천 개 만들지 못하도록 자른다. 넘는 프레임은
  서버가 **에러 없이 버리고** 보낸 쪽은 디바운스를 이미 올려 놓아 재전송되지 않는다.

## Appended contract (2026-09-09, 수치의 csv 이관)

**게임 수치의 단일 원본이 `data/*.csv` 로 옮겨졌다** ([data/README.md](../../data/README.md)). 이 폴더가 달라진 점:

- `data/csv.ts` · `data/tables.ts` 가 새로 생겼고 `index.ts` 가 `./data/tables` 를 배럴로 내보낸다 —
  기능 폴더는 `import { csvRows, keyTable, numberMap } from '@/shared'` 로 자기 표를 읽는다.
- `constants.ts` 의 스칼라 375개가 `K.num('NAME')` / `K.bool('NAME')` 로 바뀌었다. **이름 · 주석 · 타입 ·
  export 는 그대로**라서 읽는 쪽 코드는 한 줄도 바뀌지 않았다. 값만 `data/constants.csv` 로 갔다.
  저장 형식 버전(`PROFILE_VERSION`, `SHIP_STATE_VERSION`)은 리터럴로 남겼다 — csv 오타가 세이브를 깨면 안 된다.
- `constants.ts` 의 표들도 csv 로: `AMMO_STACK_ROUNDS` · `SEARCH_TIME_BY_RARITY` · `SEED_GROW_HOURS_BY_RARITY` ·
  `BOOK_RARITY_MUL` · `ARMOR_DR_BY_TIER` · `STASH_ROWS_BY_STORAGE_LEVEL` · `PRESETS_BY_RANGE_LEVEL` ·
  `QUICK_SLOT_UNLOCK_ORDER` · `PLAYER_CARRY_OFFSET` · `ARMOR_IMMUNE_AMMO` → `data/tables.csv`,
  `STRATAGEM_DEFS` → `data/stratagems.csv`, `*_UPGRADE_COST` 4종 → `data/facility_upgrades.csv`.
- `meta.ts` (`CORP_DEFS` · `CONTRACT_DEFS` · `QUEST_DEFS` · `REP_TABLE` · 가격 계수) 와
  `housing.ts` (`FURNITURE_DEFS` · `ROOM_PURPOSE_BUILD_COST`) 도 csv 를 읽는다.
- **`planets.ts` 가 둘로 갈라졌다.** 서버(`server/RelayServer.ts`)가 `isPlanetId` 하나 때문에 이 파일을 Node 에서
  직접 실행하는데, csv 로더는 Vite 안에서만 산다. 계약(`PlanetId` · `PLANET_IDS` · `isPlanetId`)은 `planets.ts` 에
  남고 표는 `planetDefs.ts` 로 갔다. 배럴이 둘 다 내보내므로 `@/shared` 쓰는 쪽에서는 차이가 없다.
- 같은 이유로 `data/csv.ts` · `data/tables.ts` 는 **`erasableSyntaxOnly` 를 지킨다** (생성자 파라미터 프로퍼티 금지,
  `import.meta.glob` 은 지역 타입으로 좁혀 씀) — 서버 tsconfig 가 이 파일들까지 훑기 때문이다.
- 가젯 정의표에 리터럴로 박혀 있던 여섯 값이 상수가 되었다: `GADGET_BARRICADE_RADIUS` · `GADGET_LURE_HP` ·
  `GADGET_MINE_HP` · `GADGET_DEFIB_RANGE` · `GADGET_JUMPPAD_HP` · `GADGET_JUMPPAD_RADIUS`.

**규칙:** 새 수치는 csv 에 줄을 만들고 여기에는 이름만 낸다. 잘못된 칸은 던지지 않고 기본값으로 굴러가며
(`dataIssues()` 에 쌓인다), `npm run data:check` 가 그 목록을 보고 실패한다.

- **2026-09-09 (키 가이드 · 창문 워프)** — 전부 **추가만** 했다 (`HUB_TRAVEL_WARP_FRACTION` 하나만 지웠다 — 컷씬이 사라져
  아무도 읽지 않는다). `events.ts`: `ui:keyGuide {owner, keys|null}` + `KeyGuideEntry {key, label}` — 열린 화면 · 모드가
  자기 키를 내고 `ui/hud/KeyGuide` 가 우측 하단 한 줄로 그린다, `Tab 닫기` 는 가이드가 스스로 맨 오른쪽에 붙이므로
  `keys` 에 넣지 않는다; **Tab(`Keys.INVENTORY`)이 모든 화면의 공용 닫기 키**라 Tab 을 먹는 화면은
  `ctx.input.consume(Keys.INVENTORY)` 한다. `hub:warpProgress {planet, t, speed}` — 행성 이동이 컷씬에서 함선 안
  창문 워프로 바뀌어 매 프레임 진행도를 낸다(조작은 그대로). `constants.ts`: `HUB_WARP_RAMP_S` · `HUB_WARP_SHAKE_PEAK` ·
  `HUB_WARP_SHAKE_INTERVAL_S` (csv 에 줄 추가), `HUB_TRAVEL_DURATION` 4.5 → 6. `types.ts` 의 `HubRef.setPlanet` /
  `travelling` 주석과 `tutorial.ts` 의 `travel` 단계 주석에서 「컷씬」을 지웠다.

- **2026-09-09 (캐릭터 슬롯 · 재화)** — 전부 **추가만** 했다.
  - `saveSlot.ts` (신규): 세이브 키에 슬롯 접두사를 붙인다. 캐릭터가 셋이 되면서 `scav.profile` 하나로는
    안 되기 때문이다. **`scav.sessionToken` 도 슬롯별**이다 — 릴레이는 토큰으로 서버 프로필을 찾으므로,
    나누지 않으면 슬롯 2로 접속한 순간 슬롯 1의 크레딧 · 창고를 그대로 내려받는다. 세이브를 쓰는 11개
    파일이 `slotKey(...)` 를 통과하도록 바뀌었고(`inventory/Serialize` 의 `readSaveFile`/`writeSaveFile`
    두 함수가 창고 · 로드아웃을 한꺼번에 덮는다), `main.ts` 가 맨 앞에서 `ensureMigrated()` 를 부른다.
  - `character.ts` (신규): 생성창 규칙. **기존 세이브는 손대지 않는다** — `STAT_BASE`(5)는 생성창을 거치지
    않는 프로필의 기본값으로 그대로 남고, 생성창을 거친 캐릭터만 1~5 · 합 15 를 따른다.
  - `currency.ts` (신규) + `data/currencies.csv`: 계약 · 퀘스트 보상의 신뢰도 · XP · 크레딧을 **재화**로
    정의했다. 신뢰도는 `data/corps.csv` 의 기업마다 `rep:<기업id>` 한 벌씩 자동으로 생기고 기업 색을 쓴다.
  - `progression.ts` 의 `PlayerProfile` 에 `accent` · `createdAt` · `playedAt` 추가 (전부 옵션).
  - `constants.ts`: `CHARACTER_SLOTS` · `CHAR_STAT_MIN` · `CHAR_STAT_MAX` · `CHAR_STAT_TOTAL` ·
    `CHAR_NAME_RANDOM_MAX` · `UI_HOLD_CONFIRM_S`. `HUB_WARP_SHAKE_PEAK` 0.28 → **0.14** (워프가 너무 흔들렸다).

### 2026-09-09 — 포인터 락이 튕겨 나온 것을 Escape 로 읽지 않는다

**증상:** 하우징 모드(시설 관리 · 방 꾸미기)를 **Tab 으로 닫으면 ESC 메뉴가 혼자 떴다.** 전체화면 브라우저와
데스크톱 앱(`SCAVANGER.exe`)에서만 났고 창 모드에서는 안 났다.

**뿌리는 하우징이 아니라 `Input` 이다.** 화면 · 모드가 닫히면 `main.ts` 가 락을 다시 요청하는데, 전체화면
Chrome 과 Electron 셸은 그 락을 넘겨줬다가 곧바로 도로 가져갈 때가 있다. 그 두 번째 `pointerlockchange` 는
`selfExit` 가 아니고 `wantLock` 은 켜져 있으므로 `onUserUnlock` → `input:pointerLockLost` → `escapePause()`
경로를 그대로 탔다 — 게임은 그것을 플레이어가 누른 Escape 로 읽었다. 하우징 전용 증상이 아니라 **닫으면서 락을
되찾는 화면 전부**(인벤토리 · 지도 · 터미널 · 정비 벤치 …)가 같은 뿌리를 공유했고, 실제로 인벤토리를 Tab 으로
닫아도 똑같이 재현됐다.

`pointerlockchange` 가 우리 요청(`lastLockRequest`) 뒤 **`LOCK_BOUNCE_GRACE_MS`(400 ms, `data/constants.csv`)**
안에 락이 사라졌다고 알려 오면 그것은 플레이어가 아니다 — 메뉴를 띄우지 않고 이미 있던 제스처 재시도
(`armLockGestureRetry`)만 걸어, 다음 키 · 클릭에서 카메라가 돌아온다. 이 창 안에서 진짜 Escape 를 놓쳐도
손해는 없다: 락이 없는 Escape 는 진짜 keydown 으로 들어와 `GameFlowSystem.update` 가 그대로 메뉴를 연다.
`scripts/smoke-controls-hub.mjs` 에 튕김 케이스가 한 줄 추가됐다.

### 2026-09-09 — 핑 v3 (함선 핑 · 플레이어별 3개 · 확인 핑) · 채팅 입력 말풍선

전부 **추가만** 이다.

- `net.ts` `PingMessage.seq?` — 보낸 쪽의 핑 일련번호. 분대원이 이 번호로 그 핑을 지목해 확인(`알겠다`)할 수 있다.
  없으면(옛 발신자) 확인할 수 없는 핑이다.
- `net.ts` `PingAckMessage { t: 'pingack'; owner; seq }` (GameMessage 유니온에 추가) — 분대원 핑 위에 다시 핑을
  찍은 "알겠다". 받는 쪽은 그 핑에 확인한 사람의 **분대 색 원**을 덧그리고 채팅에는 발신자가 보낸 일반 핑 채팅 줄
  (`<이름>: 알겠다고 확인.`)이 흐른다. 소유자는 `ui/hud/Pings`.
- `events.ts` `ping:acked {id, by, name, slot}` — 로컬 · 원격 확인 모두 발행 (`by: null` = 나).
- `net.ts` `PlayerFlags.TYPING` (1<<28) — 채팅 입력창이 열려 있다. `net/Snapshotter` 가 `ui:chatToggled` 로 켜고 끄며
  원격 아바타 머리 위 `…` 말풍선(`ui/hud/TypingBubbles`)이 이것을 읽는다. 호스트 고스트는 이 비트를 지운다.
- `constants.ts` `PING_MAX_PER_PLAYER`(3) · `PING_AIM_ASSIST_PX`(56) — `data/constants.csv`. 핑 상한이 "내 핑 3개 +
  분대원 1인 1개" 에서 **플레이어별 3개**로 바뀌었고, 핑 조준은 조준점 반경 56 px 안의 적 · 아이템 · 상자 · 분대
  핑을 관대하게 잡는다.
- `data/constants.csv` `EXTRACTION_COUNTDOWN` 120 → **60**. `data/enemies.csv` 버그 근접 `attackDamage` 전부 절반
  (특수 능력 피해는 그대로).

