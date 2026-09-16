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
| `model.ts` | Folder vocabulary: `LOCK_REQUEST_GRACE_MS`, `UNBOARD_GRACE`, `READY_ECHO_GRACE`, `REBOARD_GRACE`, `DockTransition`, `WarpState`, `SquadDockState`, scratch vectors. |
| `parts/SquadDock.ts` | Squads vs the shared ship (2026-09-15): `squadLobby` (the lobby whose shared ship we stand in), `squadLockReason` (personal pod / training locked in an undocked squad), the state rule `reconcile` (own dock → fade → cutscene, others → countdown; undocked lobby in a shared ship → undock), `tick`, `clearDockState`, `cancelEverything` (pod, warp, housing mode, furniture pose, every `ctx.escape` screen, inventory, pause menu + its 설정, dev console; chat / community close on the `docking` phase change). |
| `ui/SquadDockCountdown.ts` | Right-side countdown panel (`.hub-squad-dock`, `.hsd-*`) shown to members after the leader docked; display only, no blocker. |
| `parts/Interior.ts` | Build / dispose interiors: pods, terminal, shared-ship computer, stations (`hub_implant_bay`, `hub_dining_table`), `FurnitureLayer` + callbacks into `ctx.housing`, hangar exit, room signs / lights, room tracking, `teardown`. |
| `parts/Transitions.ts` | `enter`, background resume (`tryResume`), docking / undocking cutscene start / finish with destination prebuild, `swapDirect`, bay board / leave, `net:lobbyUpdated` / `net:lobbyLeft` (incl. server `moved`) / `net:resumed`. |
| `parts/Pods.ts` | Launch slots: prompt / availability / refusal reasons, board, ready toggle (with launch warnings), un-board, lobby echo sync (bot members seated + ready without an avatar), seed resolution (intel seed first), countdown, and the **raid-entry fade** (`beginRaidLoad` / `tickRaidLaunch` / `clearRaidLaunch`) that launches `RAID_LOAD_FADE_OUT_S` after the countdown. |
| `parts/Androids.ts` | 조종실 안드로이드 슬롯: `hub_android_<bay>` interactables (`ALLY_BAY_HOLD_S` hold) → `ctx.net.setAndroidBay`, prompts and refusals (leader / mission / offline / pending), capsule status refresh, `getAndroidBays` / `getPodStandPose` / `buildPodStands`. |
| `parts/Planet.ts` | Target planet: `setPlanet`, `travelBlockReason`, persistence (`PLANET_STORAGE_KEY`), window warp (`startTravel` / `tickTravel` / `finishTravel` / `cancelTravel`, pure `warpSpeedAt`), `applyPlanetLook`. |
| `parts/Crew.ts` | Crew card sending (`crew` / `crewq`), training arena entry (`startTraining`), squad-leader handoff interactables (`lead:<peerId>`). |
| `parts/Hangar.ts` | Hangar bays (`hub_ship_bay_<slot>`): prompts / refusals, bay occupants, ship-layout exchange (`ship` / `shipq`), visit wait, `furnitureSource` for a visited ship, visit status line. |
| `HousingMode.ts` | 3D side of housing / ship management: top-down camera, floor cursor, ghost + footprint + clearance tiles, select / hold-to-move / place / rotate / recover, outlines, grid and cockpit-ceiling visibility, key guide `housing`. |
| `LaunchPod.ts` | Pod mesh, name tag, `hub_pod_<slot>` interactable (hold 0.4 s), door collider blocker for remote occupants, boarded camera shot. |
| `Terminal.ts` | `hub_terminal` interactable → `HubMenu`; `setScreen()` writes the console status lines. |
| `Computer.ts` | Shared-ship `hub_computer` → `ctx.meta.openCorpMenu()` (warning toast on failure). |
| `DockingCutscene.ts` | Exterior dock / undock cutscene 900 m above the origin (undock half duration), chase camera via `setCameraOverride`, `elapsed`, `finishNow()`. |
| `Labels.ts` | `TextPlane`: CanvasTexture text plane, redraws only on change. |
| `hub.css` | Terminal frame / tabs / panes / planet grid / training row above the footer (`.hub-train-row`, `.hub-train`), launch-slot panel (`.hub-ready`, `.hr-*`), crew loadout popup (`.hub-crew-loadout`), launch warning, status line, planet card (`.hub-planet`, `.hp-*`). |
| `intel.css` | Match tab (`.hmt-`), invite modal (`.hinv-`), training confirm (`.htc-`), intel panel in the terminal (`.hi-`), intel screen (`.it-`). |
| `ui/HubMenu.ts` | Full-screen terminal (`.menu.hub-menu.fullscreen`): top tabs `행성` / `매칭` (`nav.scr-tabs.hub-tabs`, always opens on `행성`); planet pane = 3-column grid (empty · centred planet card with hologram, stepping, travel, `.hp-env` · intel panel); the `시뮬레이션 훈련장` button (`.hub-train`, state label `.hub-train-state`) → `TrainingConfirm` sits on its own row above the footer line (`.hub-train-row`, right-aligned, planet tab only); footer right = `닫기 (E)` only; `closeTop()` closes training confirm → invite → intel → terminal. |
| `ui/MatchTab.ts` | 매칭 tab: 4 square face tiles (me first, others by slot, empty = `초대`), `비공개 매칭` / `공개 매칭` → `ctx.net.requestDock`, `도킹 해제` when docked, `분대 떠나기` in an undocked squad; offline: the two matching buttons are replaced by a same-size `다시 연결` and `초대` is dimmed (`.is-offline`) and flashes the hint (`flashHint`) instead of opening the modal. |
| `ui/InviteModal.ts` | Invite modal over the terminal: friends then recent players (name, 아이디, level, presence, `초대` → `social.playWith`, `초대 중 · n초`, `PLAY_BLOCK_LABELS`). Token `hub:invite`, key guide owner `hub.invite`. |
| `ui/TrainingConfirm.ts` | `시뮬레이션 훈련장에 입장하시겠습니까?` tap confirm (`취소` focused, Escape / Tab / E cancel). Token `hub:trainConfirm`. |
| `ui/IntelMenu.ts` | Intel screen: pick phase (map + gimmick rows + total + hold-only `확정`) and confirmed phase (hologram lock-on + map + summary, `지역 재배치` hold → discard + reroll). Token `hub:intel`. |
| `ui/IntelMap.ts` | Pure drawing of `ctx.world.previewLayout(...)` (`MapPreviewLayout`) snapped to a coarse grid and blurred; legend colours from `INTEL_MAP_LEGEND`. Never throws on malformed layouts. |
| `ui/PlanetHologram.ts` | Planet hologram on its own WebGL renderer; cross-slide swap, `attachTo(host)` (lent to the intel screen), `startLockOn` / `clearLockOn`; returns null without a second GL context (`.no-holo`). |
| `ui/ReadyPanel.ts` | Launch-slot panel, up **only while the local player sits in a launch slot** (`sync(cells, boarded)` — visibility and interactivity are one value): 4 cells (portrait top, gear board with 5 thumbnails + carried value, ready hold gauge with `Space` keycap), right-click → crew loadout popup, key guide owner `pod`, blocker `HUB_READY_BLOCKER`. Bot cells draw the same full-body portrait as a human (`PortraitRef.setAndroid` + `armorIdOf`). |
| `ui/CrewLoadoutPanel.ts` | Modeless squadmate loadout popup (`ctx.inventory.createCrewLoadoutView`, equip / bag / quick; no stash, no credits). Escape token `hub:crewLoadout`, key guide owner `pod.loadout`. |
| `ui/LaunchWarnPanel.ts` | Launch warning popup before readying (`ctx.inventory.getLaunchWarnings()`), `취소` / `그래도 준비`; the acknowledged signature is not asked again. |
| `ui/HubStatus.ts` | Bottom-centre status line / countdown digits (`pointer-events: none`). |
| `ui/dom.ts` | DOM helpers, `parseSeed`, `randomSeed`, `isolateInput` (keeps field typing out of `Input`; Escape only blurs). |
| `interiors/types.ts` | `ShipInterior`, `PodSlotDef`, `TerminalDef`, `RoomDef`, optional interior hooks (`setGridVisible`, `setCockpitCeilingHidden`, `setPlanetLook`, `setPlanetVisible`, `setWarp`, `updateNear`, `setBayOccupants`). |
| `interiors/RoomLayout.ts` | Single source of personal-ship coordinates: `COCKPIT`, `CORRIDOR`, `AIRLOCK`, `ROOM_BOXES`, `COCKPIT_ROOM_BOX`, `roomBox`, `roomAtWorld`, `editAreaAtWorld`, `roomCellToWorld`, `worldToRoomCell`, `yawToRotation`. |
| `interiors/PersonalShip.ts` | Cockpit (fixed props: viewport + dashboard terminal, pilot seats, launch pod socket; rest is furniture) → corridor → `SHIP_ROOM_COUNT` rooms with doors, strips, signs, grid → airlock. Fading cockpit ceiling group, `LightPool`, `ViewportWarp`. |
| `interiors/SharedShip.ts` | Shared deck: bridge + terminal + viewport, 4 pod sockets, computer, implant bay, fixed dining table, holo table, airlock; aft door to the hangar; `LightPool` (deck + hangar zones); `ViewportWarp`. |
| `interiors/Hangar.ts` | Hangar deck merged into the shared ship's batch and collider: gantries, catwalks, 4 bays, parked personal-ship models (`setOccupants`), light fixtures. |
| `interiors/AndroidBays.ts` | `AndroidBayRack`: the cockpit's `ANDROID_BAY_COUNT` capsules (shell merged into the ship's batch, per-bay emissive status strip + name tag as own meshes, one solid collider each), `bays` (`HubAndroidBay`), `setState('dormant' \| 'out' \| 'pending')`. No lights. |
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
| `interiors/stations.ts` | Station geometry: `implantBay`, `diningTable` + `diningTablePlateSlots` (`TablePlateSlot`), `shipComputer` (+ body helpers), unused `repairBench`; `StationDef`, `ComputerStationDef`, `ShipStations`. |
| `interiors/TablePlates.ts` | Dining plates (2026-09-16): `addPlateToBatch` (dish + tier-shaped food, gold garnish at max quality, no lights, cached standard materials) used by the `dining_table` furniture builder; `TablePlates` = squad plates + name tags on the shared-ship fixed table (`housing:tablePlatesChanged`, `hub:entered`). |
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
  `travelling`, `hubSite`, `visitingPeer`, `visitReadOnly`, `getShipBays()`, `enterShipBay(slot)`, `returnToHangar()`,
  `getAndroidBays()` (2026-09-15 — the cockpit capsules, a **reused** array, empty outside the shared ship),
  `getPodStandPose(slot)` (where a recruited android stands ready in front of its launch pod, null elsewhere).
- **Emits**: `raid:loadBegin {}` (2026-09-15 — every client, at the end of the launch countdown, with
  `ui:screenFade {1, RAID_LOAD_FADE_OUT_S, hold}`), `hub:entered {ship, spawn}`, `hub:left`, `hub:docking {stage, direction}`, `hub:travel {stage, planet}`,
  `hub:warpProgress {planet, t, speed}`, `hub:planetChanged {planet, by}`, `hub:slotChanged`, `hub:launchCountdown`,
  `hub:readyPanelToggled`, `hub:crewLoadoutToggled`, `hub:terminalToggled` (+ legacy `ui:hubMenuToggled`),
  `hub:roomEntered {room, purpose}`, `hub:shipVisit {peerId, readOnly}`, `leader:transferRequested {peerId}`,
  `housing:modeChanged` / `shipManageChanged` (local exit fallback), `housing:cursorChanged`, `housing:selectionChanged`,
  `housing:furnitureSelected {uid}`, `housing:moveStateChanged`, `housing:moveHold {progress}`, `housing:placeRefused`,
  `game:newMission` (solo launch / training), `game:abort` (entering the hub from a mission phase), `camera:shake`,
  `ui:keyGuide`, `ui:notify`, `audio:play`.
- **Consumes**: `hub:enter`, `game:newMission`, `game:abort`, `net:lobbyUpdated`, `net:lobbyLeft`, `net:resumed`,
  `net:androidReturned`, `net:error` (both only to clear a pending `lobby:android` request), `net:statusChanged`, `net:crewCard`, `meta:creditsChanged`, `meta:loaded`, crew-card triggers (`progress:levelUp`,
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
  `.debugRemoteFurniture(refs)`, `.debugSharedShip(lobby)` (2026-09-15 — stand in the shared ship of a made-up docked
  lobby with no relay; `squadLobby()` answers with it), `.androidPrompt(bay)`, `.androidCanInteract(bay)`,
  `.raidLaunching`; interactables `hub_terminal`, `hub_computer`, `hub_implant_bay`, `hub_dining_table`,
  `hub_pod_<slot>`, `hub_ship_bay_<slot>`, `hub_android_<bay>`, `hub_hangar_exit`, `hub_furn_<uid>`, `lead:<peerId>`.
  Scene names: `PersonalShip`, `room-<i>`, `furn-<defId>`, `HubPlanet` / `HubPlanetBody`, `cockpit-ceiling`.

## Flow

| Trigger | Action |
|---|---|
| `hub:enter {ship}` | Ship coerced (**docked** lobby → `shared`, else `personal`). From a mission / result phase emit `game:abort` first. Build at the origin, spawn, space mode on, `ctx.shaders.holdForScene()`, phase `hub`, `hub:entered`, relock. Personal ship tries to resume a docked lobby in the background (skipped when `net.link.state === 'refused'`). Idempotent. |
| `game:newMission` | `teardown('mission')`: un-board, close menus, dispose interior, release player interior / camera, clear squad-dock state, `hub:left`. |
| `game:abort` | `teardown('menu')` + space mode off. |
| `net:lobbyUpdated` | Captures my own dock (`net.dockPending` inside this event → `dockMine`). A docked lobby during an undock cutscene turns it around. Then `SquadDock.reconcile` (below). During a visit: leave the ship when a raid starts or the owner left. In this squad's shared ship: refresh bays, start a squad warp when `lobby.planet` changed, `syncPods`; elsewhere only pods / terminal text. |
| Squad dock (every hub frame + lobby updates) | `SquadDock.reconcile`: a docked lobby whose shared ship we are not in (`shipLobbyCode`) → **my dock**: cancel everything → `ui:screenFade {1, HUB_DOCK_FADE_S, hold}` → `startTransition('dock')` + fade in; **anyone else's**: right-side countdown `HUB_SQUAD_DOCK_COUNTDOWN_S` (ticks only in `hub`) → same fade → cutscene; `lobby.started` → direct swap. An undocked lobby while in a shared ship / bay ship → undock cutscene. A lobby left / changed cancels the countdown or fades back in. |
| `net:lobbyLeft` | Clears any countdown / fade. `moved` → wait `MOVE_WAIT_MS` for the new lobby; otherwise undock cutscene → personal ship. |
| `net:resumed` | Docked lobby → swap to shared ship; a running raid is re-entered automatically (`rejoinMission()` one microtask later); a running training only toasts. An undocked squad stays in the personal ship. |
| Docking | `startTransition(dir)`: clear squad-dock state, **cancel everything** (`SquadDock.cancelEverything`: pod, warp, housing mode, furniture pose, every `ctx.escape` screen, inventory, pause menu), un-board, close menus, dispose interior, phase `docking` (chat / community close on it), cutscene (`HUB_DOCKING_DURATION`, undock ×0.5). After `PREBUILD_AFTER_S` the destination ship is built and warmed (`pendingInterior`). End: attach, phase `hub`, `hub:docking {end}`, `hub:entered`. |
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

- Squads (2026-09-15): pods, ready flags, crew cards, ship visits, the lobby planet and leader handoff read
  `squadLobby()` — the lobby whose shared ship we stand in — never plain `ctx.net.lobby`. In an **undocked** squad the
  personal pod prompt is `분대 대기 중 — 분대장이 매칭해야 출격할 수 있습니다` (`squadLockReason`, boarding refused with a
  toast) and `startTraining` is refused; ship management, inventory and crafting stay free. — `parts/SquadDock.ts`
- Only the local slot's pod (`ctx.net.localSlot`, 0 solo). Boarding = seated + `setReady(false)`; readiness is a
  `Keys.JUMP` hold for `UI_HOLD_CONFIRM_S` measured by `ReadyPanel` (skipped while any blocker other than its own is up).
  Ready → launch warnings first (`LaunchWarnPanel`), then `setReadyLocal(true)`; holding again un-readies.
- `HubSystem.readyLocal` is the single source; the server `LobbyPlayer.ready` is its echo. No echo within
  `READY_ECHO_GRACE` → `syncPods` clears readiness but keeps the player seated. Reconnect → `resendReady()`.
- `podCanInteract` = availability only (phase, cutscene, travel, boarded, `REBOARD_GRACE`, menus, slot free);
  `podBlockReason` = refusals shown as the prompt (tutorial gate, training running, raid I abandoned, no target planet).
- A running lobby mission turns the pod into a rejoin entrance (`임무 진행 중 — 재투입`) — except for a member who abandoned
  that raid from the title (`driftedFromRaid`: prompt / status `표류`, boarding refused). `Transitions.onResumed` does not
  auto-rejoin a drifted member either.
- Countdown: all connected members ready (and `!lobby.started`) → `HUB_LAUNCH_COUNTDOWN`. At 0 **every** client (host,
  member, solo) fades to black — `ui:screenFade {1, RAID_LOAD_FADE_OUT_S, hold}` + `raid:loadBegin` — and the
  **authority launches `RAID_LOAD_FADE_OUT_S` later** (`parts/Pods.beginRaidLoad`). Host: `net.startGame(seed, 'raid',
  planet, intel)`. Solo: sets `missionMode`, `missionPlanet`, `missionIntel` then emits `game:newMission`. Seed = held
  intel for this planet → lobby seed → `missionSeed` → random. Rejoin and training skip all of this (no countdown).
- 안드로이드 봇 멤버 (2026-09-15): a `LobbyPlayer.bot` occupies the pod of its lobby slot and is **always ready** — the
  pod closes and the ready cell is confirmed with no remote avatar (the body stands in front of the pod, drawn by
  `allies/` at `getPodStandPose(slot)`). Its cell draws the **same full-body portrait as a human** (2026-09-16 —
  `PortraitRef.setAndroid` for the android look, armor from `ctx.allies.getLoadout(id)?.equip.armor` falling back to
  `ANDROID_KIT.armor`), the `ANDROID_KIT` gear board (or `ctx.allies.getLoadout(id)` once that exists) and refuses the
  right-click crew-loadout popup. Bots are filtered out of hangar bays, ship visits, leader handoff, training counts and crew counts.
- Ready panel: visible **only while WE are in a launch slot** (2026-09-16 — a recruited android's cell is `ready` at once,
  which used to put the panel up while the player just walked the shared ship); `parts/Pods.syncPods` passes that as
  `sync(cells, boarded)` and it is both the visibility and the interactivity condition. Portraits come from
  `ctx.player.createPortraits(host, HUB_READY_CELLS)` at `HUB_READY_PORTRAIT_YAW`; members not seated draw no body.
  Local gear thumbnails use real instances (attachment pips); squadmates use the crew card (outline pips only, bag
  unknown `?`). Key guide owner `pod` (`E 내리기`, `Space 준비`), hidden during countdown.

## 조종실 안드로이드 슬롯 (2026-09-15)

- Three capsules stand in the **port corner of the shared ship's bridge** (a row along Z at x ≈ −11.45, z 3.2 / 4.25 /
  5.3, facing +X onto the deck) — clear of the helm console, the pilot seats, the ship computer, the launch pods and
  the armoury, and clear of the x ≈ −8 line `smoke-hangar` walks. Shell geometry is merged into the ship's `GeoBatch`;
  only the per-bay emissive status strip and name tag are own meshes, and **no light is ever created**.
- `hub_android_<bay>` (radius 2.2, `holdTime: ALLY_BAY_HOLD_S`) sits one step in front of each capsule and is
  registered only in the shared ship. The hold sends `ctx.net.setAndroidBay(bay, !recruited)`; the relay decides
  everything else. Recruited = `androidOnBay(squadLobby(), bay)`.
- Prompts: `<이름> — 분대원으로 들이기` / `<이름> — 슬롯으로 돌려보내기`. **Refusals are the prompt** and the bay stays
  interactable (the launch-pod rule): `요청 처리 중…` → `서버에 연결되어 있지 않습니다` → `분대장만 안드로이드를 들일 수
  있습니다` → `임무 진행 중`. A pending request clears on the next `net:lobbyUpdated` / `net:androidReturned` /
  `net:error` / `net:lobbyLeft` / `net:statusChanged` — no timer, so no number in code.
- Strip colours: cyan = an android is dormant inside, dark = it is out with the squad, amber pulse = waiting for the
  relay. A full squad is the relay's call (`net:androidReturned {reason:'full'}`); ui/ owns that toast.

## Terminal, intel, matchmaking

- Two top tabs (`행성` / `매칭`, same `.scr-tab` look as the Tab screen). The terminal always opens on `행성`; the
  tutorial gate `matchmaking` hides the `매칭` tab. Arrow / A-D stepping only runs on the planet tab with no child screen.
- `시뮬레이션 훈련장` (its own row above the footer separator, right-aligned, planet tab only) opens `TrainingConfirm` → `startTraining()`. Labels: solo
  `시작`; lobby `합류 (n명 훈련 중)` / `임무 진행 중` (disabled) / `시작`; undocked squad `분대 대기 중` (disabled).
- 매칭 tab (`MatchTab`): tiles are me first, then lobby members by slot, then empty cells. Face =
  `ctx.player.snapshotFace({accent})` with `LobbyPlayer.accent ?? NET_SLOT_COLORS_CSS[slot]`; my own accent comes from
  `readSlotCard(activeSlot()).accent`. A null snapshot leaves the name and initial. Empty cell `초대` is enabled only with
  no lobby, or as host before the start with a free slot. Buttons: `비공개 매칭` / `공개 매칭` → `connectThen` →
  `requestDock(isPublic)`; blocked in order by `dockPending` (`도킹 중…`), non-host (`분대장만 매칭할 수 있습니다`), started,
  connecting (disabled + hint). **Not connected** (and not connecting / busy): both buttons are hidden and a same-size
  `다시 연결` (`.hmt-reconnect`, in `.hmt-actions`) takes their place, hint `서버에 연결되어 있지 않습니다` kept. The empty
  cells' `초대` is then dimmed but clickable (`.is-offline`) and every click flashes the hint (`.is-flash`, `HINT_FLASH_MS`)
  instead of opening the modal. Docked lobby → a single `도킹 해제`; undocked squad → a small `분대 떠나기`. Both call
  `leaveLobby()`. Lobby codes, invite links and the public toggle are not shown.
- Invite modal (`InviteModal`): friends then recent players; the row button is `초대` / `분대원` (already in my lobby) /
  `초대 중 · n초` (`inviteAt` within `SQUAD_INVITE_TTL_S`) / `PLAY_BLOCK_LABELS[playBlock]`. Rows rebuild on
  `social:updated` / lobby / status changes; `HubMenu.update` ticks the countdown text only.
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
  Without a placed dining table the cook bench / appliance prompt reads `… · 식탁이 없습니다` (`HousingRef.hasDiningTable`).
- Dining plates (2026-09-16): our own ship's **first** dining-table piece is built with `BuildExtra.plate`
  (`HousingRef.getPlate`, smoke hook `FurnitureLayer.diningPlateUid`); `housing:tablePlatesChanged` rebuilds only rooms
  with a dining table. The shared ship's fixed table gets `sys.tablePlates` (`interiors/TablePlates`) in `buildStations`,
  disposed in `disposeInterior` before the interior.
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
- Child screens over the terminal use their own blocker / escape tokens (`hub:trainConfirm`, `hub:invite`, `hub:intel`) so
  closing them does not drop the terminal's cursor. Only one hologram WebGL context exists; the intel screen borrows it
  (`attachTo`), and the terminal hides it while the `매칭` tab is shown. — `ui/HubMenu.ts` (`setTab`)
- Match-tab faces never get their own canvases: `ctx.player.snapshotFace` renders PNGs through one offscreen renderer
  (browser context limit). — `player/FaceSnapshot.ts`
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
- The raid-entry fade runs on the **wall clock** (`performance.now()`), not the hub's dt: `game/parts/LoadGate` holds
  the engine from `raid:loadBegin` on and every system then gets dt 0, so a dt countdown would never launch. A backup
  `setTimeout` fires the same step in case the hold skips `update` entirely. — `parts/Pods.ts` (`RaidLaunchState`)
- Once the fade started the launch is **committed**: `toggleReady`, the E un-board and the android bays all refuse
  while `HubSystem.raidLaunch` is set. Nothing launching within `RAID_LOAD_FADE_OUT_S + RAID_LOAD_START_GRACE_S`
  (host gone, server refusal) fades back in instead of leaving a black screen. — `parts/Pods.ts` (`tickRaidLaunch`)
- Bot members are lobby members without a socket: never a hangar occupant, a `ship state` target, a leader-handoff
  target, a training head or a 승무원 count. Read `isBotPlayer` / `humanPlayersOf`, never `players.length`.
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
- 2026-09-16 — Sliding 자동문 removed (`interiors/Doors.ts` deleted); arch/doorway trims no longer share planes with wall openings, room door signs clear the ceiling beam.
- 2026-09-16 — Ready panel is up only while the local player is in a launch slot (`sync(cells, boarded)`; a recruited android no longer puts it on screen), and a bot cell draws the same full-body portrait as a human (`PortraitRef.setAndroid`, kit armor via `armorIdOf`) — the `snapshotAndroidFace` path and `.hr-face` are gone from this panel.
- 2026-09-16 — Dining plates in 3D: `interiors/TablePlates.ts` (`addPlateToBatch` on the dining-table furniture, squad plates + name tags on the shared-ship table via `diningTablePlateSlots`); cook bench prompt says `식탁이 없습니다` without a table.
- 2026-09-15 — Raid abandoned from the title (`LobbyPlayer.drifted`): `Pods.driftedFromRaid` blocks the rejoin pod (prompt, status, boarding) and `onResumed` skips the auto-rejoin; terminal error text for `drifted`.
- 2026-09-15 — Terminal: `시뮬레이션 훈련장` on its own row above the footer line (`.hub-train-row`; footer = `닫기 (E)` only); 매칭 tab offline = `다시 연결` replaces the two matching buttons, `초대` dimmed + hint flash (`MatchTab.onInvite` / `flashHint`).
