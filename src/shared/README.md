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
