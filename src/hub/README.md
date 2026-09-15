# src/hub — Ship hub (`HubSystem`)

The walkable ship between missions. Solo play happens in the small **personal ship**; joining a lobby plays a
**docking cutscene** into the large **shared ship** (up to 4 players), whose aft **hangar** parks every member's personal
ship for boarding and visits. Players sit in **launch slots**, hold to ready up, and the host (or the solo player)
launches. The full-screen **terminal** picks the target planet (window warp), buys intel and opens matchmaking and the
training arena. The folder also builds every furniture model and the 3D staging of gym, cooking and video-game sessions,
and runs the 3D side of ship management (`시설 관리`). Publishes `ctx.hub` (`HubRef`) and owns phases `hub` and
`docking` (not gameplay: `ctx.world` is null). Everything is procedural Three.js geometry. Import via `@/hub`.

Rules for rooms, furniture, placement and stations live in `ctx.housing` (`src/housing`); this folder renders them and
forwards interactions.

## Files

| File | Responsibility |
|---|---|
| `HubSystem.ts` | `GameSystem` (`name: 'hub'`) + `HubRef`: lifecycle, event wiring, per-frame update, the E close chain, M → ship management, terminal screen text, one-line delegates into `parts/`. Re-exports `model.ts`. |
| `model.ts` | Folder vocabulary: `LOCK_REQUEST_GRACE_MS`, `UNBOARD_GRACE`, `READY_ECHO_GRACE`, `REBOARD_GRACE`, `DockTransition`, `WarpState`, scratch vectors. |
| `parts/Interior.ts` | Build / dispose interiors: pods, terminal, shared-ship computer, stations (`hub_implant_bay`, `hub_dining_table`), `FurnitureLayer` + callbacks into `ctx.housing`, hangar exit, room signs / lights, room tracking, `teardown`. |
| `parts/Transitions.ts` | `enter`, background resume (`tryResume`), docking / undocking cutscene start / finish with destination prebuild, `swapDirect`, bay board / leave, `net:lobbyUpdated` / `net:lobbyLeft` (incl. server `moved`) / `net:resumed`. |
| `parts/Pods.ts` | Launch slots: prompt / availability / refusal reasons, board, ready toggle (with launch warnings), un-board, lobby echo sync, seed resolution (intel seed first), countdown, launch. |
| `parts/Planet.ts` | Target planet: `setPlanet`, `travelBlockReason`, persistence (`PLANET_STORAGE_KEY`), window warp (`startTravel` / `tickTravel` / `finishTravel` / `cancelTravel`, pure `warpSpeedAt`), `applyPlanetLook`. |
| `parts/Crew.ts` | Crew card sending (`crew` / `crewq`), training arena entry (`startTraining`), squad-leader handoff interactables (`lead:<peerId>`). |
| `parts/Hangar.ts` | Hangar bays (`hub_ship_bay_<slot>`): prompts / refusals, bay occupants, ship-layout exchange (`ship` / `shipq`), visit wait, `furnitureSource` for a visited ship, visit status line. |
| `HousingMode.ts` | 3D side of housing / ship management: top-down camera, floor cursor, ghost + footprint + clearance tiles, select / hold-to-move / place / rotate / recover, outlines, grid and cockpit-ceiling visibility, key guide `housing`. |
| `LaunchPod.ts` | Pod mesh, name tag, `hub_pod_<slot>` interactable (hold 0.4 s), door collider blocker for remote occupants, boarded camera shot. |
| `Terminal.ts` | `hub_terminal` interactable → `HubMenu`; `setScreen()` writes the console status lines. |
| `Computer.ts` | Shared-ship `hub_computer` → `ctx.meta.openCorpMenu()` (warning toast on failure). |
| `DockingCutscene.ts` | Exterior dock / undock cutscene 900 m above the origin (undock half duration), chase camera via `setCameraOverride`, `elapsed`, `finishNow()`. |
| `Labels.ts` | `TextPlane`: CanvasTexture text plane, redraws only on change. |
| `hub.css` | Terminal, launch-slot panel (`.hub-ready`, `.hr-*`), crew loadout popup (`.hub-crew-loadout`), launch warning, status line, planet card (`.hub-planet`, `.hp-*`). |
| `intel.css` | Matchmaking popup (`.hm-`), intel panel in the terminal (`.hi-`), intel screen (`.it-`). |
| `ui/HubMenu.ts` | Full-screen terminal (`.menu.hub-menu.fullscreen`): two columns — planet card with hologram (preview stepping, travel button, environment line `.hp-env`) and right column (intel panel → training arena); header `매칭` button; `closeTop()` closes intel → matchmaking → terminal. |
| `ui/MatchPanel.ts` | Matchmaking popup: quick match, code docking, broadcast, lobby code / public toggle / invite link / crew rows / undock. Token `hub:match`. |
| `ui/IntelMenu.ts` | Intel screen: pick phase (map + gimmick rows + total + hold-only `확정`) and confirmed phase (hologram lock-on + map + summary, `지역 재배치` hold → discard + reroll). Token `hub:intel`. |
| `ui/IntelMap.ts` | Pure drawing of `ctx.world.previewLayout(...)` (`MapPreviewLayout`) snapped to a coarse grid and blurred; legend colours from `INTEL_MAP_LEGEND`. Never throws on malformed layouts. |
| `ui/PlanetHologram.ts` | Planet hologram on its own WebGL renderer; cross-slide swap, `attachTo(host)` (lent to the intel screen), `startLockOn` / `clearLockOn`; returns null without a second GL context (`.no-holo`). |
| `ui/ReadyPanel.ts` | Launch-slot panel: 4 cells (portrait top, gear board with 5 thumbnails + carried value, ready hold gauge with `Space` keycap), right-click → crew loadout popup, key guide owner `pod`, blocker `HUB_READY_BLOCKER` only while the local player is boarded. |
| `ui/CrewLoadoutPanel.ts` | Modeless squadmate loadout popup (`ctx.inventory.createCrewLoadoutView`, equip / bag / quick; no stash, no credits). Escape token `hub:crewLoadout`, key guide owner `pod.loadout`. |
| `ui/LaunchWarnPanel.ts` | Launch warning popup before readying (`ctx.inventory.getLaunchWarnings()`), `취소` / `그래도 준비`; the acknowledged signature is not asked again. |
| `ui/HubStatus.ts` | Bottom-centre status line / countdown digits (`pointer-events: none`). |
| `ui/dom.ts` | DOM helpers, `parseSeed`, `randomSeed`, `isolateInput` (keeps field typing out of `Input`; Escape only blurs). |
| `interiors/types.ts` | `ShipInterior`, `PodSlotDef`, `TerminalDef`, `RoomDef`, optional interior hooks (`setGridVisible`, `setCockpitCeilingHidden`, `setPlanetLook`, `setPlanetVisible`, `setWarp`, `updateNear`, `setBayOccupants`). |
| `interiors/RoomLayout.ts` | Single source of personal-ship coordinates: `COCKPIT`, `CORRIDOR`, `AIRLOCK`, `ROOM_BOXES`, `COCKPIT_ROOM_BOX`, `roomBox`, `roomAtWorld`, `editAreaAtWorld`, `roomCellToWorld`, `worldToRoomCell`, `yawToRotation`. |
| `interiors/PersonalShip.ts` | Cockpit (fixed props: viewport + dashboard terminal, pilot seats, launch pod socket; rest is furniture) → corridor → `SHIP_ROOM_COUNT` rooms with doors, strips, signs, grid → airlock. Fading cockpit ceiling group, `LightPool`, `ViewportWarp`. |
| `interiors/SharedShip.ts` | Shared deck: bridge + terminal + viewport, 4 pod sockets, computer, implant bay, fixed dining table, holo table, airlock; aft door to the hangar; `LightPool` (deck + hangar zones); `ViewportWarp`. |
| `interiors/Hangar.ts` | Hangar deck merged into the shared ship's batch and collider: gantries, catwalks, 4 bays, parked personal-ship models (`setOccupants`), light fixtures. |
| `interiors/Furniture.ts` | `buildFurniture(def, level, extra?)` builders for every non-leisure `FurnitureModelKind` (merges kitchen and mining builders); `FurnitureLayer`: per-room pieces, collider blockers, `Lv.n` signs, interactables `hub_furn_<uid>` with access-face checks, rebuild on `housing:*` events, owns `GymStaging` / `CookStaging` / `GameStaging` / `RemoteFurnitureStaging`. |
| `interiors/FurnitureLeisure.ts` | `LEISURE_BUILDERS` (`isLeisureKind`): library media stands, TV with console + hidden game screen rig, record players, gym machines, sofa, chair, low table, rug; moving sub-groups and pose geometry (`FurnitureRig`). |
| `interiors/FurnitureKitchen.ts` | Auto-cooking appliance builders (`KITCHEN_APPLIANCE_BUILDERS`) and the cook-bench tool rig (`cookBenchTools` → `CookRig`, `COOK_TOOL_OF`, `poseCookKnife`, `restCookRig`). |
| `interiors/FurnitureMining.ts` | `MINING_BUILDERS`: compute cluster (lit core slots = `BuildExtra.cores`) and mining computer desk. |
| `interiors/GymStaging.ts` | Pose / camera helpers (`worldPoseOf`, `sitPoseOf`, `gymPoseOf`, `gymCameraOf`, `segmentHits`) and shared rig posers (`poseBenchBar`, `poseBelt`, `poseCrank`, `poseRock`, `restRig`); `GymStaging` drives `housing:gymSession` / `housing:gymBeat`. |
| `interiors/CookStaging.ts` | `cookPoseOf` / `cookCameraOf`; `CookStaging` drives `housing:cookSession` / `cookStep` / `cookBeat` (tools slide in, hand phase). |
| `interiors/GameStaging.ts` | `tvScreenWorld`, `gamePoseOf`, `gameCameraOf`; `GameStaging` drives `housing:gameSession` / `gameBeat` (TV screen emissive tint, in-screen markers, progress bar). |
| `interiors/RemoteFurnitureStaging.ts` | Animates pieces used by remote squadmates in the same `hubSite` from their interpolated cumulative pose phase. |
| `interiors/InteriorCollider.ts` | `BoxInteriorCollider`: walkable AABB rooms + toggleable / removable blocker boxes; `resolveCollision`, `raycast`, `bounds`. |
| `interiors/GeoBatch.ts` | `HUB_MATS` shared palette, `GeoBatch` (merge per material), `disposeMeshes`, `yawFromForward`. |
| `interiors/parts.ts` | `Parts` geometry kit (deck, walls with openings + blockers, glass, ribs, crates, lockers, `consolePedestal`, unused `workbench`, signs), `GLASS_MAT`, `CeilingTarget`. |
| `interiors/stations.ts` | Station geometry: `implantBay`, `diningTable`, `shipComputer` (+ body helpers), unused `repairBench`; `StationDef`, `ComputerStationDef`, `ShipStations`. |
| `interiors/Doors.ts` | `ShipDoors`: animated two-leaf sliding doors (no collider change). |
| `interiors/LightPool.ts` | Re-export of `LightPool` / `LightFixture` from `@/shared`. |
| `interiors/Starfield.ts` | `Starfield` (points) and window `Planet` (`setColors`, `setOpacity`). |
| `interiors/WarpStreaks.ts` | `WarpStreaks` line field and `ViewportWarp`, the shared `setWarp` implementation (stars → streaks, planet fade / re-tint). |
| `interiors/ExteriorShips.ts` | Low-poly exterior ship models for the docking cutscene, `setThrust()`. |
| `index.ts` | Barrel. |

## Public API

- **`ctx.hub: HubRef`** (`src/shared/types.ts`, three `interface HubRef` blocks): `ship`, `active`, `collider`,
  `getLaunchSlots()`, `missionSeed`, `setMissionSeed(seed)` (console `/seed`; lobby host pushes `setLobbySeed`, non-host
  refused), `currentRoom`, `launchReady?` (boarded ∧ ready — `inventory` read-only gate), `planet`, `setPlanet(id)`,
  `travelling`, `hubSite`, `visitingPeer`, `visitReadOnly`, `getShipBays()`, `enterShipBay(slot)`, `returnToHangar()`.
- **Emits**: `hub:entered {ship, spawn}`, `hub:left`, `hub:docking {stage, direction}`, `hub:travel {stage, planet}`,
  `hub:warpProgress {planet, t, speed}`, `hub:planetChanged {planet, by}`, `hub:slotChanged`, `hub:launchCountdown`,
  `hub:readyPanelToggled`, `hub:crewLoadoutToggled`, `hub:terminalToggled` (+ legacy `ui:hubMenuToggled`),
  `hub:roomEntered {room, purpose}`, `hub:shipVisit {peerId, readOnly}`, `leader:transferRequested {peerId}`,
  `housing:modeChanged` / `shipManageChanged` (local exit fallback), `housing:cursorChanged`, `housing:selectionChanged`,
  `housing:furnitureSelected {uid}`, `housing:moveStateChanged`, `housing:moveHold {progress}`, `housing:placeRefused`,
  `game:newMission` (solo launch / training), `game:abort` (entering the hub from a mission phase), `camera:shake`,
  `ui:keyGuide`, `ui:notify`, `audio:play`.
- **Consumes**: `hub:enter`, `game:newMission`, `game:abort`, `net:lobbyUpdated`, `net:lobbyLeft`, `net:resumed`,
  `net:statusChanged`, `net:crewCard`, `meta:creditsChanged`, `meta:loaded`, crew-card triggers (`progress:levelUp`,
  `implant:equipped`, `equip:changed`, `loadout:changed`, `inventory:loadoutSaved`), ship-state triggers
  (`housing:changed` / `loaded` / `booksChanged` / `shelfChanged` / `furnitureToggled`), `housing:roomPurposeChanged`,
  `housing:modeChanged`, `housing:shipManageChanged`, `housing:moveRequested`, `housing:furniture*`,
  `housing:analysisChanged`, `housing:cultureChanged`, `housing:clusterChanged`, `housing:tvConsoleChanged`,
  `housing:gymSession` / `gymBeat`, `housing:cookSession` / `cookStep` / `cookBeat`, `housing:gameSession` / `gameBeat`,
  `player:furniturePoseEnded`, `intel:changed`, `tutorial:changed`, `input:bindingsChanged`.
- **Wire** (`src/shared/net.ts`): sends `crew card` (broadcast on arrival in the shared ship + debounced by
  `CREW_CARD_MIN_INTERVAL_S`), answers `crewq sync` and `crewq loadout` (per requester `CREW_LOADOUT_COOLDOWN_S`); sends
  `ship state` (`ShipVisitWire`, debounced `SHIP_VISIT_MIN_INTERVAL_S`), answers `shipq state` (`SHIP_VISIT_COOLDOWN_S`).
  Receiving and storing is `net/`'s. Planet travel has no message: every client warps off its own `lobby:state`.
- **Debug**: `getSystem('hub')` → `.housing` (`HousingMode`), `.furnitureLayer`, `.openShipManage()`,
  `.debugRemoteFurniture(refs)`; interactables `hub_terminal`, `hub_computer`, `hub_implant_bay`, `hub_dining_table`,
  `hub_pod_<slot>`, `hub_ship_bay_<slot>`, `hub_hangar_exit`, `hub_furn_<uid>`, `lead:<peerId>`. Scene names:
  `PersonalShip`, `room-<i>`, `furn-<defId>`, `HubPlanet` / `HubPlanetBody`, `cockpit-ceiling`.

## Flow

| Trigger | Action |
|---|---|
| `hub:enter {ship}` | Ship coerced (lobby → `shared`, else `personal`). From a mission / result phase emit `game:abort` first. Build at the origin, spawn, space mode on, `ctx.shaders.holdForScene()`, phase `hub`, `hub:entered`, relock. Personal ship tries to resume a lobby in the background (skipped when `net.link.state === 'refused'`). Idempotent. |
| `game:newMission` | `teardown('mission')`: un-board, close menus, dispose interior, release player interior / camera, `hub:left`. |
| `game:abort` | `teardown('menu')` + space mode off. |
| `net:lobbyUpdated` | Personal ship + lobby → dock cutscene (`lobby.started` → direct swap). Pending server move → one dock cutscene. During a visit: leave the ship when a raid starts or the owner left. Shared ship: refresh bays, start a squad warp when `lobby.planet` changed, `syncPods`. |
| `net:lobbyLeft` | `moved` → wait `MOVE_WAIT_MS` for the new lobby; otherwise undock cutscene → personal ship. |
| `net:resumed` | Swap to shared ship; a running raid is re-entered automatically (`rejoinMission()` one microtask later); a running training only toasts. |
| Docking | `startTransition(dir)`: un-board, close menus, dispose interior, phase `docking`, cutscene (`HUB_DOCKING_DURATION`, undock ×0.5). After `PREBUILD_AFTER_S` the destination ship is built and warmed (`pendingInterior`). End: attach, phase `hub`, `hub:docking {end}`, `hub:entered`. |
| Terminal E | `HubMenu.open()`: blocker `'hub'` before `setCursorMode(true, 'hub')`, escape token `hub:terminal`. |
| E in `hub` | Closes the top of: launch warning → terminal stack (`closeTop`) → crew loadout popup → un-board (after `UNBOARD_GRACE`). Ignored under `MENU_BLOCKER`. Escape is not read here — `game/` and `ctx.escape`. |
| Tab | `HubMenu.update` closes its top screen (consumed); `HousingMode` leaves the mode. |
| M | No blocker, not boarded → `openShipManage()` → `ctx.housing.openShipManage()` (personal ship only; refused while visiting). |
| Pod E | See Launch slots. |
| Terminal `행성 이동` | `setPlanet(id)`: refused for non-host in a lobby, during cutscene / travel / countdown, outside `hub`, unknown id, current planet. Solo saves `PLANET_STORAGE_KEY`; host calls `ctx.net.setLobbyPlanet`. |
| Window warp | `startTravel`: un-board, close terminal, hide ready panel, cancel countdown, `hub:travel {start}`. Controls, camera and interior stay live for `HUB_TRAVEL_DURATION`; `tickTravel` drives `setWarp(speed)`, `hub:warpProgress`, hull shake (`HUB_WARP_*`). Pods, bays, consoles refuse meanwhile. `finishTravel` → `hub:travel {end}` + `hub:planetChanged`. Interior teardown / swap paths call `cancelTravel()` (no end event). |
| Training | `startTraining()` (terminal, both ships): refused outside `hub`, cutscene, boarded, decorating, raid running. Lobby: join a running training (`rejoinMission`) or `net.startGame(seed, 'training')`. Solo: sets `missionMode = 'training'`, clears `missionPlanet` / `missionIntel`, emits `game:newMission`. |
| Every frame (hub) | Interior update, doors + light pool (`updateNear`), furniture layer, pods, room tracking (`hub:roomEntered`), pending visit, leader handoff interactables, housing mode (owns input while active), E / M, countdown, warp. |

## Launch slots

- Only the local slot's pod (`ctx.net.localSlot`, 0 solo). Boarding = seated + `setReady(false)`; readiness is a
  `Keys.JUMP` hold for `UI_HOLD_CONFIRM_S` measured by `ReadyPanel` (skipped while any blocker other than its own is up).
  Ready → launch warnings first (`LaunchWarnPanel`), then `setReadyLocal(true)`; holding again un-readies.
- `HubSystem.readyLocal` is the single source; the server `LobbyPlayer.ready` is its echo. No echo within
  `READY_ECHO_GRACE` → `syncPods` clears readiness but keeps the player seated. Reconnect → `resendReady()`.
- `podCanInteract` = availability only (phase, cutscene, travel, boarded, `REBOARD_GRACE`, menus, slot free);
  `podBlockReason` = refusals shown as the prompt (tutorial gate, training running, no target planet).
- A running lobby mission turns the pod into a rejoin entrance (`임무 진행 중 — 재투입`).
- Countdown: all connected members ready (and `!lobby.started`) → `HUB_LAUNCH_COUNTDOWN`; authority (solo / host)
  launches. Host: `net.startGame(seed, 'raid', planet, intel)`. Solo: sets `missionMode`, `missionPlanet`,
  `missionIntel` then emits `game:newMission`. Seed = held intel for this planet → lobby seed → `missionSeed` → random.
- Ready panel: portraits come from `ctx.player.createPortraits(host, HUB_READY_CELLS)` at `HUB_READY_PORTRAIT_YAW`;
  members not seated draw no body. Local gear thumbnails use real instances (attachment pips); squadmates use the crew
  card (outline pips only, bag unknown `?`). Key guide owner `pod` (`E 내리기`, `Space 준비`), hidden during countdown.

## Terminal, intel, matchmaking

- Planet stepping only previews the hologram; `행성 이동` commits. The environment line (`PlanetDef.env`) warns when
  `ctx.progression.hasEnvPrep(env)` is false but never blocks travel.
- Intel panel: no intel → Raven intro + `정보 구매`; held intel → summary (mismatch warning if for another planet) +
  `정보 확인` / `지역 재배치`. Only the host can buy (`분대장만 정보를 살 수 있습니다`); squadmates read
  `ctx.net.lobbyIntel` with the lobby planet, because `ctx.meta.intel.get()` is local-profile only.
- Intel screen costs and tiers come from `ctx.meta.intel` (`costOf`, `maxTierOf`), falling back to
  `shared/intel.intelCost`. `buy` may be async — the screen locks until it settles. Re-roll = discard, no refund.
- The map must use `ctx.world.previewLayout` (same planner as the real map) so it never lies; without it only the grid
  is drawn.

## Personal-ship layout (`interiors/RoomLayout.ts`)

Metres, ship at the origin, spawn faces −Z. All values derive from csv keys (`SHIP_ROOM_COUNT`, `ROOM_GRID_COLS/ROWS`,
`HOUSING_CELL_SIZE`, `COCKPIT_GRID_COLS/ROWS`) plus `WALL` 0.3, `CEIL` 3.2, `ROOM_GAP` 1, `AIRLOCK_DEPTH` 2.5.

| Part | X | Z |
|---|---|---|
| Cockpit (`COCKPIT_ROOM_INDEX` edit area) | ± cockpit width / 2 | −cockpit depth … 0 |
| Corridor | −1.5 … 1.5 | 0 … `ROOMS_PER_SIDE × SEGMENT` (`SEGMENT = ROOM_DEPTH + ROOM_GAP`) |
| Room i (port, i < `ROOMS_PER_SIDE`) | `CORRIDOR.minX − WALL − ROOM_SIZE` … `CORRIDOR.minX − WALL` | `k·SEGMENT + ROOM_GAP/2` … `+ ROOM_DEPTH` (k = i mod per side), door at the middle |
| Room i (starboard) | `CORRIDOR.maxX + WALL` … `+ ROOM_SIZE` | same as port |
| Airlock | −1.5 … 1.5 | `CORRIDOR.maxZ` … `+ AIRLOCK_DEPTH` |

Grid cell `x` runs along +X, `y` along +Z from the area's min corner; a piece with top-left cell (x, y) and rotated
footprint (cols, rows) is centred by `roomCellToWorld`. `yaw` 0..3 = quarter turns clockwise from above
(`rotation.y = −yaw·π/2`); models face −Z. Collider rooms extend through each door wall to the corridor face, so a
doorway is an open shared edge.

## Housing mode (`HousingMode.ts`)

- Enters on `housing:shipManageChanged` (ship management, from anywhere in the personal ship) or `housing:modeChanged`
  (room-console path). Controls off; camera on the +X side of every area looking −X at `camSpan` fractions
  (`CAM_TOWARD_FRAC`, `CAM_HEIGHT_FRAC`), gliding between rooms (`CAM_GLIDE`). Grid lines and cockpit-ceiling fade are on
  only while the mode runs.
- Ship management takes blocker + escape token `shipmanage` and `setCursorMode(true)`; the floor cursor is a camera ray
  onto the deck. Clicks over `#ui-root` never place. DOM `pointerdown` / `mousedown` / `wheel` are buffered because
  cursor mode empties `Input`'s gameplay buttons.
- Ship management: LMB selects (`housing:furnitureSelected`); E or LMB held `HOUSING_MOVE_HOLD_S`
  (`housing:moveHold`) enters the move state (`housing:moveStateChanged`), in which LMB places, R rotates, X recovers,
  C / Escape put it back. Refusals emit `housing:placeRefused {reason}` (reason from `ctx.housing.placementBlock`).
  Cockpit-only facilities cannot be recovered. Hover / selected outlines through `ctx.outline`. Clearance tiles show
  cells a ghost needs clear. Room-console path (`manage` false): click picks up / puts down, X recovers, wheel / `[ ]`
  cycle storage.
- Leaves on M, Tab, C with an empty cursor, or the escape stack. Exit always releases the blocker / cursor token, even
  if `active` was already cleared.

## Furniture and staging

- `FurnitureLayer` reads `ctx.housing.getPlaced(room)` (or a `FurnitureSource` for a visited ship — then it subscribes to
  nothing and registers no interactables). Defs always come from `FURNITURE_DEF_MAP`. It rebuilds only the affected
  room on per-piece events and rebuilds everything only for `housing:changed` reasons outside `COVERED_CHANGE_REASONS`.
- Interaction dispatch by `FurnitureDef.interaction`: benches → `ctx.inventory.openBenchCraft(kind, level)`; cook bench
  and cooking appliances → `openCookStation(uid)` (never the craft window); grow station, analyzer, culture tank, dining
  table, shelves, TV menu, compute cluster / mining computer, gym, toggles, seats → the matching `ctx.housing` / player
  call, each duck-typed with a warning toast. Access face (`furnitureAccessOf` / `furnitureFaceDir`) gates prompts.
- Retired kinds (`repair_bench`, `grow_rack`, `range_console`, `target_lane`, `sim_hub`) keep builders and no-op branches
  because the model / interaction unions must be covered; `ShipState.sanitize` removes such pieces on load.
- Staging classes find their piece by uid every frame (safe across room rebuilds), change only material uniforms /
  sub-group transforms, create no lights and allocate nothing per frame. Local and remote staging use the same poser
  functions. Staging only decorates: failing to pose never cancels the housing session; a session is cancelled only when
  the pose we set is ended by someone else or the piece disappears.
- Cook-bench body offsets mirror `player/SoldierModel.FURN_COOK` (source of truth); seat heights mirror player
  `FURN_SIT`.

## Rules

- The scene point-light count must never change: each interior owns exactly `HUB_POINT_LIGHTS` pool lights that move by
  ramping intensity; never toggle `visible` or add / remove lights. — `interiors/LightPool.ts` (`@/shared` `LightPool`)
- Compile a ship before showing it: every build is followed by `ctx.shaders.holdForScene()`; docking prebuilds and warms
  the destination. — `parts/Transitions.ts` (`prebuildTarget`)
- Every client must build identical geometry at the origin — remote snapshots in the shared ship depend on it.
- The emitter sets `ctx.missionMode`, `ctx.missionPlanet`, `ctx.missionIntel` **before** `game:newMission`; `world/`
  generates inside the emit. — `parts/Pods.ts` (`launch`), `parts/Crew.ts` (`startTraining`)
- Keep refused pods interactable and put the reason in the prompt: `interactables.findBest` skips `canInteract() === false`
  and the player would see nothing. — `parts/Pods.ts` (`podBlockReason`)
- `HubSystem` updates before `PlayerSystem`, so the E that opens a panel cannot also close it that frame. The un-board
  branch deliberately does not consume E; `REBOARD_GRACE` stops the held press from re-boarding.
- `HubSystem.uiBlocked()` ignores `HUB_READY_BLOCKER` — the ready panel must not block E un-board or lock-loss handling.
- Child screens over the terminal use their own blocker / escape tokens (`hub:match`, `hub:intel`) so closing them does
  not drop the terminal's cursor. Only one hologram WebGL context exists; the intel screen borrows it (`attachTo`).
- `.hub-ready .hr-row` must stay `repeat(4, 1fr)` with `gap: 0`: `player/Portraits` slices its canvas into equal columns.
  `--hr-body-h` is a content-height formula (value line `line-height: 14px` is part of it). — `hub.css`
- `.launch-warn` sits above `.hub-ready` (z-index), since the panel is appended later and would eat its clicks.
- A visited ship registers no consoles, pods or furniture interactables; only `hub_hangar_exit`. A personal ship entered
  from a bay has no launch pod (the squad launches from the shared deck). — `parts/Interior.ts` (`build`)
- Pod cells stay walkable (rear wall + side lips + toggleable door slab) so a boarded player is never pushed out by
  `resolveCollision`. — `interiors/PersonalShip.ts`, `LaunchPod.ts`
- Pod doors and furniture change the collider through `setBlockerEnabled` / `removeBlocker` (indices stay valid), never
  a collider rebuild. — `interiors/InteriorCollider.ts`
- New screen tilt: a box frame with `rx = +tilt` and a `TextPlane` with `Euler(−tilt, ry + π, 0, 'YXZ')` lean the same
  way; `consolePedestal` tilts its housing opposite its screen — do not copy that pair.
- `parts/` import only types from `HubSystem.ts`; values go to `model.ts`.

## Notes

- Space look: `core/Atmosphere.setSpaceMode(on)` via `ctx.scene.userData.atmosphere`; the window planet is visible only
  while a target planet is set.
- Optional refs (`ctx.housing`, `ctx.inventory`, `ctx.progression`, `ctx.meta`, `ctx.loot`, `ctx.implants`) are
  duck-typed everywhere and degrade to warning toasts.
- `hub:workbenchToggled` and `.menu.hub-menu.workbench` CSS are leftovers of the removed repair bench; nothing emits or
  uses them. `Parts.workbench`, `stations.repairBench`, `ShipStations.bench?` are kept but never called.
- Join / leave toasts are owned by `ui/hud/Notifications`; this folder shows none.
- Known limits: a visited ship does not show TV consoles or remote video-game staging; a peer's ready cell shows no
  level until their crew card arrives; the exterior docking cutscene carries its own bay `PointLight`.

## Recent changes

Last 5 only — older: `git log -- src/hub`.
- 2026-09-15 — Intel `확정` button: label `확정` + left-click hold keycap (`createHoldButtonCap`); `.it-reason` shows block reasons only.
- 2026-09-15 — Ready hold `Space` keycap built with `shared/keycap.createKeycap` / `paintKeycap`.
- 2026-09-15 — Ship management no longer passes the standing room to `openShipManage` (housing remembers the last room).
- 2026-09-14 — Launch-slot panel sized by content formula, pod keys moved to key guide owner `pod`; launch warning above panel; cook staging never cancels sessions; game staging no screen flash; shared-ship repair bench prop removed.
- 2026-09-14 — Terminal two columns + matchmaking popup + intel panel / screen / map + hologram lock-on; boarding separated from readiness.
