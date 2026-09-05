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
