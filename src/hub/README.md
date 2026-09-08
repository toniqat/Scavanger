# src/hub — Ship hub (`HubSystem`)

Helldivers 2-style ship interior between missions. The player walks around a small **personal ship** (solo), finds a
signal at the terminal (quick match / code / broadcast), flies a **docking cutscene** into the large **shared ship**
(up to 4 players, remote avatars rendered by `player/RemotePlayerSystem`), walks the deck (and the **격납고** behind its aft 자동문, where every member's 개인 함선 is parked and can be boarded), and boards a **launch pod** to ready up. When
every connected member is boarded the host runs `HUB_LAUNCH_COUNTDOWN` and calls `ctx.net.startGame(seed)`; solo, the
personal pod emits `game:newMission` directly. Publishes `ctx.hub` (`HubRef`). Owns phases `hub` and `docking`
(not gameplay: `ctx.world` is null, no weapons / enemies / pings; movement + interaction use `ctx.isControlActive()`).
Everything is procedural Three.js geometry — no asset files. Import via `@/hub` → `HubSystem`.

| File | Purpose |
|---|---|
| `HubSystem.ts` | `GameSystem` (`name: 'hub'`) + `HubRef`. Enter / build / teardown, docking transitions, pod boarding, lobby → pod sync, launch countdown, Esc / E handling, pointer-lock etiquette (see below). **함선 꾸미기** (2026-09-06): `setMissionSeed` (console `/seed` only; lobby host pushes `setLobbySeed`, non-host refused), `currentRoom` + `hub:roomEntered` (player XZ vs the room boxes, every frame), door-sign refresh on `housing:roomPurposeChanged / changed / loaded`, owns the `FurnitureLayer` and the `HousingMode` controller (debug getters `.housing`, `.furnitureLayer`). **Phase 8**: Esc never opens the terminal any more (game/ owns the hub 일시정지 메뉴) and neither does a lost pointer lock; `Keys.MAP` (M, read live, no blocker / not boarded / personal ship) calls `openShipManage()` → `ctx.housing.openShipManage(currentRoom)` (the HUD calls it **시설 관리**); **Phase 8 UI pass**: the room door consoles (`hub_room_<i>`) and the cockpit facility console (`hub_facility`) are gone, geometry included — rooms / purposes / facilities are managed from the Tab 함선 tab and from 시설 관리; `refreshRoomSign` also drives 방 조명 (`PersonalShip.setRoomLit`); `updateNear` runs the 자동문 + room-light pool every frame; the built-in workbench is optional (shared ship only) and `furn_repair_bench` / `furn_grow_rack` furniture route to `WorkbenchMenu.open()` / `ctx.housing.openGrowMenu(uid)`. **2026-09-08 (격납고)**: `visit` / `visitShip` / `pendingBay` + the `HubRef` members `hubSite` · `visitingPeer` · `visitReadOnly` · `getShipBays()` · `enterShipBay(slot)` · `returnToHangar()`, and the `ship state` broadcast (`bindShipRequests`, the debounced `shipStateDirty` flush in `update`, re-sent on `housing:changed / loaded / booksChanged`). |
| `model.ts` | 폴더 공용 어휘 — `HubSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `HubSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Planet.ts` | **목표 행성 선택과 워프 이동** (Phase 11). 임무는 여전히 무작위 시드로 생성되지만 **어느 행성인지**는 플레이어가 고른다. 로비에서는 **호스트만** 정하고 나머지는 `lobby:state` 로 같은 컷씬을 본다. 이동은 함선 내부를 재생성하지 않는다 — 창밖만 바뀐다. 목표 행성이 없으면 발사 슬롯에 탑승할 수 없다. |
| `parts/Pods.ts` | **발사 포드 · 카운트다운 · 출격**. 포드에 타면 준비 완료가 되고, 접속한 전원이 준비되면 3초 카운트다운 뒤 호스트가 `startGame` 한다. 임무가 진행 중이면 포드는 재합류 입구가 된다. 탑승을 막는 이유(`podBlockReason`)는 프롬프트로 보여 준다 — `canInteract:false` 로 막으면 프롬프트 자체가 사라져 이유를 알 수 없다. |
| `parts/Interior.ts` | **함선 내부 짓기 · 허물기**. 개인 함선(조종석 → 복도 → 방 10개 → 에어락)과 공유 함선의 지오메트리, 스테이션 배치, 가구 배치(`buildHousing`), 방 추적과 표지판. 모든 클라이언트가 같은 지오메트리를 만들어야 공유 함선의 위치 스냅샷이 맞는다. |
| `parts/Transitions.ts` | **함선을 드나드는 전환**. 타이틀 → 개인 함선, 도킹 → 공유 함선, 임무 종료 → 함선, 재접속 복귀. 컷씬을 태울지 바로 바꿔치울지(`swapDirect`)와, 진행 중인 레이드로 자동 재투입할지를 정한다. |
| `parts/Hangar.ts` | **공용 함선 격납고** (2026-09-08). 정박 구역 4곳의 상호작용(`hub_ship_bay_<slot>`)과 프롬프트 · 거절 사유, 개인 함선 배치(`refreshBays`), 그리고 남의 함선을 그리기 위한 배치 정보 교환 (`ship state` / `shipq state`, 크루 카드와 같은 방식 — 도착 시 1회 · 내 함선이 바뀌면 디바운스 · 요청에는 즉시). 레이아웃이 아직 안 왔으면 `SHIP_VISIT_WAIT_S` 동안 기다렸다가(`tickPendingVisit`) 들여보내거나 포기한다. |
| `parts/Crew.ts` | **크루 카드** (Phase 10) 와 훈련장 입장. 허브에서는 `PlayerSnapshot` 의 무기 · 임플란트가 null 이고 `LobbyPlayer` 에는 레벨이 없다. 그래서 발사 준비 패널이 쓸 정보(이름 · 레벨 · 장착 임플란트 · 방어구)를 별도 `crew` 메시지로 주고받는다. 요청이 오면 그 대원의 장비 문서도 보낸다. |
| `HousingMode.ts` | 3D side of housing mode (rules live in `ctx.housing`): reacts to `housing:modeChanged` **and `housing:shipManageChanged`** (함선 관리, Phase 8), controls off + oblique top-down camera over the room, pointer-locked cursor, ghost + footprint frame, LMB / R / X / C / wheel / `[ ]` / **M** (2026-09-08: was Esc — M is the key that entered the mode), `housing:cursorChanged`. See **Housing mode** below. |
| `LaunchPod.ts` | Pod mesh (open cylinder + sliding door with a window, slot-coloured floor ring / rear strip / lamp, CanvasTexture name tag that billboards), `Interactable` `hub_pod_<slot>` (`holdTime` 0.4) in front of the door, toggles the pod-door collider blocker while a *remote* occupant closes the door. `getCameraShot()` = boarded over-shoulder framing. |
| `Terminal.ts` | `Interactable` `hub_terminal` (instant, `함선 터미널`) → opens `HubMenu`; `setScreen()` writes status lines to the console's CanvasTexture. |
| `Workbench.ts` | `Interactable` `hub_workbench` (instant, radius 2.2, `정비 벤치`) in front of the workbench prop → opens `WorkbenchMenu`. Registered / unregistered exactly like the terminal (`build()` / `disposeInterior()`). **Phase 8**: only the **shared** ship still has a built-in bench (`ShipInterior.workbench` is optional); in the personal ship the same `WorkbenchMenu` opens from a placed `furn_repair_bench` (`FurnitureInteraction 'repair_bench'`). |
| `Computer.ts` | **함선 컴퓨터** (Phase 5): `Interactable` `hub_computer` (instant, radius 2.2, prompt `기업 네트워크`) in front of the computer desk → `HubSystem.openCorpMenu()` = `ctx.meta.openCorpMenu()`; when `ctx.meta` is missing / a stub / refuses (the menu is not open afterwards) a `ui:notify` warning `기업 네트워크에 접속할 수 없습니다` is shown instead. Same registration / disposal pattern as `Terminal` / `Workbench`. |
| `DockingCutscene.ts` | Exterior cutscene on a stage 900 m above the origin: personal-ship model flies a bezier into the shared ship's hangar bay (or out, for undock — half duration) with a chase camera via `ctx.player.setCameraOverride`. `finishNow()` skips to the end. | **Phase 11** adds `direction: 'travel'` + `TravelOptions {shared, color, atmo}`: the same stage reused as the **행성 이동 warp** — no bay and no second hull, just our own exterior (personal / shared by `HubRef.ship`) seen from behind, `WarpStreaks` stretched to `HUB_TRAVEL_WARP_STRETCH` through the first `HUB_TRAVEL_WARP_FRACTION`, then the destination `Planet` (in the def's hologram colours) closing in. `place()` forwards to `placeTravel()`; `small` / `big` are null in that mode.
| ~~`GardenStation.ts`~~ | **Deleted in Phase 8** (2026-09-06). 재배 moved to the 온실 room: `furn_grow_rack` furniture → `ctx.housing.openGrowMenu(uid)` (housing owns the plots, the seeds and the panel). The old `scav.hub.garden.v1` localStorage key is abandoned, not migrated. |
| `Labels.ts` | `TextPlane`: CanvasTexture text plane (redraws only when text changes). Used for pod tags, terminal / dashboard screens, slot signs. |
| `hub.css` | **Phase 10** adds `.hub-ready` (the four-cell READY row: portrait canvas layer `.hr-portraits` behind a zero-gap `.hr-row` grid so every cell is exactly ¼ of the row and lines up with its viewport; `.hr-cell{.hr-edge,.hr-top{.hr-name,.hr-lv},.hr-imp{.hr-imp-glyph,.hr-imp-name},.hr-state}` with `.is-ready/.is-empty/.is-off/.is-local`) and `.hub-crew-loadout` (`.hcl-head{.hcl-bar,.hcl-titles{.hcl-eyebrow,.hcl-name},.hcl-close}/.hcl-status/.hcl-body`, centred fixed frame in the shape of `inv-modeless`). `.hub-ready:not([hidden]) ~ .hub-status` lifts the status line above the panel — which is why `HubSystem` constructs `ReadyPanel` **before** `HubStatus`. Then: `.menu.hub-menu` layout (`.hub-head/.hub-section/.hub-code/.hub-crew-name/.hub-crew/.crew-row/.hub-foot`, footer right-aligned since the 캐릭터 button left), `.menu.hub-menu.workbench` (`.wb-mats/.wb-list/.wb-row{.slot,.mid,.name,.tag,.dur{.ok,.warn,.low},.dur-text,.cost{.short}}/.wb-empty`, wider frame, single-column under 720 px) and `.hub-status` (bottom-centre status / countdown). Reuses `.menu .frame .ui-btn .ui-input .ui-label .status-pill .form-msg .keycap` from `ui/styles/base.css`. |
| `ui/HubMenu.ts` | Terminal menu DOM. **승무원 name** — an input on the very first run only: `change` → `setPlayerName` + `nameChosen`, and once `ctx.housing.state.nameLocked` (or the name was set this session) it is the read-only `.hub-crew-name` line with `호출명은 처음 한 번만 정할 수 있습니다.` (Phase 8; housing/ owns persisting `nameLocked`). A read-only `.seed-hint` line (`임무 시드는 개발자 콘솔 /seed 로만 설정합니다. 현재: …` — the seed section was removed on 2026-09-06; `parseSeed` / `randomSeed` stay in `ui/dom.ts`), personal ship: `신호 찾기 (자동 매칭)` → `ensureConnected()` then `quickMatch()`, `코드로 도킹` (`joinLobby`), `신호 송출 (비공개 함선 생성)` (`createLobby`); shared ship: code + `초대 링크 복사` (`getInviteUrl`), host `공개/비공개` (`setPublic`), crew list, `도킹 해제` (`leaveLobby`); **`시뮬레이션 훈련장` section (Phase 7, shared ship only)**: one button → `host.startTraining()` reading `시작` (idle lobby), `합류 (n명 훈련 중)` (training running, n = connected `inMission` members; enabled while we are in the hub) or `임무 진행 중` disabled (raid running); crew rows read `훈련장` / `함선` during a training; footer `닫기`, `타이틀로` (the **캐릭터** button was removed in Phase 8 — 캐릭터 is a Tab-screen tab now). Inline `net:error` / matched / peer messages. | **Phase 11 — full screen** (`.menu.hub-menu.fullscreen`): three columns — **left** 신호 / 공유 함선 (behaviour unchanged), **centre** the 행성 카드 (`ui/PlanetHologram` canvas + `◀ ▶`, name, 지형, 위협 badge, brief, `hp-dots`, 행성 이동), **right (bottom)** 시뮬레이션 훈련장 + `.seed-hint`; footer 닫기 (E) / 타이틀로 (2026-09-08: the terminal closes on E, not Escape). **The 승무원 이름 section is deleted** — the call sign is entered once on the title screen, so `ctx.housing.lockCrewName()` is no longer called from here. Stepping (`◀ ▶`, `←` / `→`, `A` / `D` through a **bubble-phase** window listener, so `isolateInput` fields keep their own keys) only **previews**; 행성 이동 calls `HubMenuHost.travelTo` → `HubRef.setPlanet`. The button reads `현재 목표` (disabled) on the ship's own planet, the `travelBlock()` reason (disabled) when refused, else `<행성>(으)로 이동`. Emits `hub:terminalToggled` next to the legacy `ui:hubMenuToggled`; `update(dt)` also drives the hologram's render loop. `no_planet` added to `errorText`.
| `ui/PlanetHologram.ts` | **행성 홀로그램** (Phase 11): `createPlanetHologram(host)` → a `PLANET_HOLOGRAM_PX` square canvas with its **own** `THREE.WebGLRenderer` / scene / camera / lights — the `player/Portraits` precedent, because `core/Engine` composes the world through an `EffectComposer` and offers no post-render hook. Reuses the hub's `Planet` in the def's `hologram` / `hologramAtmo`, spinning at `PLANET_HOLOGRAM_SPIN`, tilted `PLANET_HOLOGRAM_TILT`, inside a procedural icosahedron wire cage with two additive rings and a drifting scanline grid. `setPlanet(def, dir)` cross-slides over `PLANET_SWAP_TIME` (two slots, the outgoing one fades and leaves the other way); `render(dt)` is a no-op while `setVisible(false)`, so a closed terminal costs nothing. Returns **null** when a second GL context is unavailable → the menu adds `.no-holo` and degrades to the text card. |
| `ui/WorkbenchMenu.ts` | Weapon repair menu (`.menu.hub-menu.workbench`). Header `정비 벤치` + material line `폐금속 n · 합금 판 n` (`countWhere` on `mat_scrap` / `mat_alloy`); one `.wb-row` per weapon — loadout `primary / primary2 / secondary` (`주무기 I / 주무기 II / 보조무기`) then every bag item whose def has a `weaponId` (`가방`): name, durability bar (`ctx.loot.getEffectiveStats(inst).maxDurability`, `inst.durability ?? max`; green > 50 % / amber > 20 % / red, `파손` tag at 0), cost from `ctx.loot.getRepairCost(inst)` as `폐금속 ×n [· 합금 판 ×m]` or `정비 완료`, `수리` (disabled when unaffordable) → `ctx.inventory.repairWeapon(uid)` → `audio:play ui_equip` / `ui_deny` + re-render. `모두 수리` repairs in row order while affordable (`n정 수리 완료 · m정 재료 부족`). Empty state `정비할 무기가 없습니다`. Re-renders on `inventory:itemUpdated` / `inventory:changed` / `loadout:changed` while open. Same `'hub'` blocker + pointer-lock etiquette as `HubMenu`; emits `hub:workbenchToggled {open}`. Every `ctx.inventory` / `ctx.loot` call is null-guarded (`typeof fn === 'function'`, try/catch) so the menu degrades to read-only while those folders are unfinished. |
| `ui/LaunchWarnPanel.ts` | **출격 준비 경고** (2026-09-08, `.menu.hub-menu.launch-warn`). `boardPod` 이 `ctx.inventory.getLaunchWarnings()` 로 받은 사유를 한 줄씩(`!` 표식 + 표제 + 상세) 세우고 **[취소] / [그래도 출격]** 을 준다. 막지 않는다 — 확인하면 그대로 탑승하고, 그 조합(`signatureOf` = id 목록)을 `HubSystem.launchWarnAck` 이 기억해 같은 상태로는 다시 묻지 않는다(경고가 하나도 없는 상태를 지나면 기억이 지워진다). 커서 예절은 `HubMenu` 와 같은 `'hub'` blocker + 소프트 커서(포인터 락 유지). 2026-09-08 ESC 규칙 변경 이후 키보드 취소는 **E** — `HubSystem.update` 의 E 사슬이 첫 분기로 잡는다, `podCanInteract` 는 이 패널이 떠 있는 동안 포드를 잠근다. |
| `ui/ReadyPanel.ts` | **발사 준비 패널** (Phase 10, Helldivers-2 style): four horizontal cells at the bottom of the ship screen, shown as soon as **any** launch slot is filled. One canvas from `ctx.player.createPortraits(host, HUB_READY_CELLS)` (four scissored viewports, owned by `player/`) sits behind the row; `setMember(i, {slot, armorId})` + `setYaw(i, HUB_READY_PORTRAIT_YAW)` fill a cell and **an un-ready member's cell draws no character** (`setMember(i, null)`). A null `PortraitRef` (no second WebGL context) degrades to name-only cells (`.no-portraits`). Cell: slot-coloured top edge, top-left name + `Lv. n` (`ctx.progression.level` locally, `ctx.net.getCrewCard(id)?.level` for a peer), the equipped 전술 임플란트 on the right (glyph + name; the def is read through `ctx.implants.getDef` — `IMPLANT_DEFS` lives in `implants/`, not in shared) and a state line. **Right-click** a cell → `CrewLoadoutPanel`. Takes `HUB_READY_BLOCKER` (`'ready'`) + `ctx.input.setCursorMode(true, …)` — **never** `exitPointerLock()` — only while the **local** player is boarded (`sync(cells, interactive)`), so a squadmate readying up never steals our mouse look. `hub:readyPanelToggled` on every visibility change; `HubSystem.uiBlocked()` ignores the token so E still leaves the pod. |
| `ui/CrewLoadoutPanel.ts` | **분대원 장비** modeless popup behind that right-click: header (slot bar + name + 닫기) around `ctx.inventory.createCrewLoadoutView(body, loadout, {name, slot, blocks:['equip','bag','quick']})` — **no 함선 창고 column and no credits**. Local cell = `ctx.inventory.captureCrewLoadout()` directly; a peer = `ctx.net.requestCrewLoadout(id)` then the first matching `net:crewLoadout` (5 s timeout → `장비 정보를 받지 못했습니다`). No blocker, no pointer-lock call, no window Escape listener (the `EmbeddedView` convention): dismissed by 닫기, an outside pointerdown, the hub's **E** chain (`ReadyPanel.closePopup()`, 2026-09-08: was Esc) or by losing the cursor. Emits `hub:crewLoadoutToggled {open, peerId}`. `inventory/ui/Modeless.ts` could not be reused — it is a child of the inventory window — so the frame lives in `hub.css`. |
| `ui/HubStatus.ts` | `.hub-status` line: `탑승 대기 중 (n/m)`, big countdown digits + progress bar, `임무 진행 중` rejoin hint, docking text. `pointer-events: none`, no blocker. |
| `ui/dom.ts` | Local DOM helpers (`el/setText/toggleClass`), `parseSeed` (blank → null, digits → uint32, else FNV-1a), `randomSeed`, `isolateInput` (stops WASD — and E — reaching `Input`; Esc **blurs only** since 2026-09-08, the `onEscape` callback is no longer passed anywhere). |
| `interiors/types.ts` | `ShipInterior` (root, collider, spawn / airlock, `pods: PodSlotDef[]`, `terminal`, **optional** `workbench` (shared ship only since Phase 8), **`computer: StationDef`** (Phase 5), `stations`, optional `rooms: RoomDef[]` for the personal ship — the `facility` anchor was removed in the Phase 8 UI pass), `PodSlotDef` (position, yaw, `door` direction, `doorBlocker` index), `TerminalDef`, `WorkbenchDef` (interaction anchor + yaw facing the bench), `RoomDef` (index, side, floor box, door `sign` TextPlane, `furnitureGroup`; the door `console` anchor was removed in the Phase 8 UI pass). | **Phase 11**: optional `setPlanetLook(color, atmo)` — both ships re-tint their decorative window `Planet` to the 목표 행성 (called on build and when a travel cutscene ends; the interior is never rebuilt for a planet change).
| `interiors/Doors.ts` | **자동문** (Phase 8): `ShipDoors` — two-leaf sliding doors that can **not** join the merged `GeoBatch` because they animate. `add(x, z, width, height, thickness, axis)` builds two leaf meshes (one shared `BoxGeometry` per door, shared `HUB_MATS.hullLight`); `update(dt, px, pz)` opens a door whose threshold is within `DOOR_OPEN_DISTANCE` of the player and slides at `DOOR_SLIDE_SPEED` (fraction of the travel per second), the leaves disappearing into the wall slab. **No collider is added or toggled** — the doorway stays the open shared collider edge it has always been, so movement is unchanged. `openAmount(i)` / `count` for smokes. |
| `interiors/RoomLayout.ts` | **Single source of the personal-ship coordinates** (table below): `COCKPIT / CORRIDOR / AIRLOCK` boxes, `ROOM_BOXES` (10 × `RoomBox {index, side, minX..maxZ, doorZ}`), `roomAtWorld(x, z)`, `roomCellToWorld(room, x, y, out, cols, rows)` (centre of a footprint whose top-left cell is (x, y)), `worldToRoomCell`, `yawToRotation(yaw)` (= −yaw·π/2; quarter turns clockwise seen from above). Grid `x` runs along world +X, `y` along +Z, cell (0, 0) = the room's min-x / min-z corner. |
| `interiors/Furniture.ts` | Procedural builders for every `FurnitureModelKind` (`buildFurniture(def, level)` → `{group, meshes, w, d}`; centred, bottom at y 0, front toward −Z, merged per material through a `GeoBatch`; benches share `benchBody()` with per-kind top items + a tinted accent, `range_console`, `target_lane`, `locker`, `table`, `shelf`, `crate`, emissive `lamp` (no light), `plant`, `chair`, `bunk`; tinted materials cached per catalogue colour, `GHOST_OK / GHOST_BAD` preview materials). `FurnitureLayer`: renders `ctx.housing.getPlaced(room)` into each `RoomDef.furnitureGroup`, one collider blocker per piece (`addBox` / `removeBlocker`), a `Lv.n` `TextPlane` for upgradeable pieces and an `Interactable` `hub_furn_<uid>` for pieces whose `interaction !== 'none'` (benches → `ctx.inventory.openBenchCraft(kind, level)`, 사격장 콘솔 → `ctx.housing.openPresetMenu()`); rebuilds a room on `housing:furniturePlaced / Moved / Upgraded / Recovered`, everything on `housing:loaded`, and on `housing:changed` only for a `reason` outside `COVERED_CHANGE_REASONS` (place / move / recover / furnitureUpgrade / craft / preset / purpose / facility:* all arrive per piece or touch no piece — so a facility upgrade no longer disposes and rebuilds every piece on the ship); `pieceAt(room, x, y)`. **Phase 7**: `sim_hub` = 시뮬레이션 허브 holo pedestal (base plate, glowing foot ring, ribbed column, dish with three control pads, emitter disc, translucent core beam) + `simHubRings()` — an outer ring with three emitter nodes and a tilted inner ring pair in their own groups (`sim-spin` / `sim-spin-inner`, `FurnitureModel.spin / spinInner`) that `FurnitureLayer.update(time)` rotates every frame (the hub calls it; the ghost preview stays still); `HOLO_RING` / `HOLO_CORE` emissive translucent materials, no light. `FurnitureCallbacks.onSimHub()` → interaction `'sim_hub'` (prompt `시뮬레이션 허브 · 훈련장 입장`) → `HubSystem.startTraining()`. **Phase 8**: two new models — `repair_bench` (the old cockpit `Parts.workbench` silhouette at furniture scale on `benchBody`, → `onRepairBench()` = `WorkbenchMenu.open()`) and `grow_rack` (재배층: four legs, a shallow tray with `GROW_PLOTS_PER_RACK` plot pads on a soil bed and a magenta `stripGrow` strip **under** the tray so a stack reads as a vertical farm; the whole model stays below `GROW_RACK_LAYER_HEIGHT` so layers never intersect, → `onGrowRack(uid)` = `ctx.housing.openGrowMenu(uid)`). `addPiece` offsets a piece by `(item.layer ?? 0) × GROW_RACK_LAYER_HEIGHT` in Y (model, collider blocker and `Lv.n` sign) and, for stackable defs (`stackLimit > 1`), spreads the per-layer interactables along the piece's front edge (`(layer − (stack−1)/2) × width/stack`, radius 1.2, prompt `재배층 n층`) so `findBest` can tell the layers apart; `pieceAt` returns the **top** layer of a stack. **Phase 9**: `buildFurniture(def, level, extra?)` takes a `BuildExtra` (`{books?: (Rarity|null)[]}`) and the **`bookshelf`** builder draws a real 책장 — body, plinth, accent lip, `BOOK_SHELF_ROWS` (3) shelf boards and one upright **spine box + title band per shelved book**, coloured by the book's rarity (`RARITY_COLORS` through a cached `spine()` material, slot 0 = top-left, empty slots stay empty). `FurnitureLayer.shelfBooks(uid)` reads `ctx.housing.getBooks(uid)` (duck-typed, try/caught) and passes it for `def.model === 'bookshelf'` pieces only; `housing:booksChanged {uid}` rebuilds that piece's room, and `'books'` joined `COVERED_CHANGE_REASONS` so the matching `housing:changed` does not rebuild the whole ship. `FurnitureCallbacks.onBookshelf(uid)` → interaction `'bookshelf'` → `ctx.housing.openBookshelfMenu(uid)` (falls back to a `책장을 사용할 수 없습니다` toast). **2026-09-08 (개인 함선 방문)**: the constructor takes an optional `FurnitureSource` (`{getPlaced(room), getBooks(uid)}`). With one, the layer reads **that** instead of `ctx.housing` — a visited member's `ShipVisitWire` — and because such a ship never changes under it, it subscribes to no `housing:*` event and registers **no interactables at all** (둘러보기 전용). |
| `interiors/InteriorCollider.ts` | `BoxInteriorCollider` implements the shared `InteriorCollider`: rooms = walkable AABBs (floor / ceiling), blockers = solid AABBs with an `enabled` flag. `resolveCollision` = clamp into the room union (edges shared with a neighbouring room stay open) + circle-vs-AABB push-out (2 passes); `raycast` = slab test vs blockers + floor / ceiling planes; `bounds`. `removeBlocker(index)` (furniture) disables the slot and recycles it on the next `addBlocker`, so earlier indices stay valid. Only allocates the returned `TerrainHit`. |
| `interiors/GeoBatch.ts` | `HUB_MATS` shared material palette (constant, never disposed; `grid` = the faint self-lit room grid lines), `GeoBatch` (accumulates Box/Cylinder/Plane geometry per material with a `YXZ` yaw-then-tilt transform and merges to one mesh per material via `BufferGeometryUtils.mergeGeometries`), `disposeMeshes`, `yawFromForward(fx, fz)` (player forward = (−sin yaw, −cos yaw)). |
| `interiors/parts.ts` | `Parts`: deck (floor + grate + ceiling + light channels + amber edge strips), `walls()` with openings (viewports / airlock) that also emit collider blockers, `glass()`, ribs / beams, crate stacks, locker rows, `consolePedestal()` (returns the screen transform), `workbench()` (steel table + drawer block + vise + parts tray + wall tool board + cyan lamp strip, one 1.95 × 0.8 m collider box; returns the interaction anchor 0.95 m in front, the yaw looking at it and the transform for the `정비` `TextPlane` sign), sign strips; `fixture()` = constant-count `PointLight`. `GLASS_MAT` transparent viewport glass. |
| `interiors/PersonalShip.ts` | **Cockpit → corridor → 10 rooms → airlock** (2026-09-06, coordinates in `RoomLayout.ts` and the table below). Cockpit 10 × 6 m at −Z: viewport + dashboard + 3 readouts + seats; **terminal on the centre line between the two pilot seats** at (0, −4.55), screen facing **+Z** so it is read walking in from the corridor (anchor (0, 0, −3.55), radius 2.4 — in range at the spawn); −X wall implant bay (−4.05, −4.9) + bunk; +X wall 2 lockers at (4.73, −4.7) (the weapon workbench moved to the 작업실), **ship computer** desk at (4.65, −3.1) facing −X (anchor (3.18, 0, −3.1), `기업 네트워크` screen), pod socket (slot 0 at (4, 0, −1.2), door faces −X); +Z wall 2 lockers (−3.9, −0.3) (the hydroponics rack moved to the 온실), stash cabinet prop (−2.0, −0.3) — the 함선 시설 console was removed in the Phase 8 UI pass. Corridor 3 × 25 m with a rib / beam / wall fill every 5 m; each room: floor + ceiling reaching to the corridor face, 8 × 8 grid lines (`HUB_MATS.grid`), walls with a 1.6 × 2.4 m door on the corridor, trim door frame, **its own** white wall bands + cyan outer-wall band + amber threshold material instances (`setRoomLit` → `ROOM_STRIP_LIT` / `ROOM_STRIP_DIM`), `방 n` / purpose `TextPlane` above the door (corridor side), an empty `furnitureGroup`, and a two-leaf **자동문** in the doorway. Airlock 3 × 2.5 m at +Z with 3 lockers (−X), the 3 supply crates (+X), a decorative door, `에어락` sign + blinking beacon. **13 point lights** (cockpit 4, corridor 5, airlock 1 + the `ROOM_LIGHT_POOL` room lights), never toggled. Spawn (0, 0, −1.8) facing −Z; `airlock` (0, 0, 26) facing −Z. `setRoomLabel(i, text, accent)`, `setRoomLit(i, lit)`, `updateNear(dt, px, pz)` (doors + light pool), debug `isRoomLit(i)` / `roomLightRooms` / `doors`. |
| `interiors/SharedShip.ts` | 26×14×4.2 m hangar deck: bridge dash + 4 readouts + viewport (−X) + terminal (faces +X), **ship computer** in the bridge's forward-port corner against the −Z wall at (−11, −6.65) facing +Z (anchor (−11, 0, −5.18)), **4 pod sockets in a row on the −Z wall** at x −6/−2/2/6 (doors face +Z, slot-numbered signs, separators), armoury (weapon racks, 5 lockers, **workbench** at (2.5, 0, 6.38) facing −Z — anchor (2.5, 0, 5.43), `정비` sign — crate stacks), central holo table, airlock door on +X. Docking arrivals spawn at (11, 0, 0) facing −X; direct enter spawns at (3, 0, 0.5) facing the pods. 6 point lights. **Phase 8**: its hydroponics rack is gone (`ShipStations.garden` removed); it keeps the built-in `hub_workbench`. **2026-09-08 (격납고)**: the middle of the +Z wall is a 4 m opening with a two-leaf **자동문** (`ShipDoors`, `updateNear`) onto the `Hangar` deck, which is built into the **same** batch / collider; the armoury moved aside for it (racks + the 정비 bench to port at x −3.7, lockers at 4.2 and the crate stacks at 7.8 / 10.8 to starboard) and the aft rib at x 0 is skipped. `bays` / `setBayOccupants(names)` expose the four 정박 구역. |
| `interiors/Starfield.ts` | `Starfield` (deterministic `Points` sphere, no size attenuation, slow spin) and `Planet` (lit sphere + additive atmosphere shell, group named `HubPlanet` / body `HubPlanetBody`). **Phase 11**: `Planet` takes a `spin` and a shell opacity, and gained `setColors(color, atmo)` (the window planet follows the 목표 행성 in place — no rebuild) and `setOpacity(0..1)` (the terminal hologram's `PLANET_SWAP_TIME` cross-fade). |
| `interiors/WarpStreaks.ts` | **행성 이동 워프** (Phase 11): one `LineSegments` with two vertices per streak in a cylinder shell around the −Z travel axis. `setStretch(k)` pushes the tail vertex back (a `PointsMaterial` cannot be stretched, which is why this is not `Starfield`) and **quantises** the buffer write by `STRETCH_STEP`, so a 4.5 s cutscene uploads a couple of dozen times instead of once per frame; `setOpacity` fades the layer in only while the warp runs, `update` drifts it past the camera. Deterministic RNG, additive, `frustumCulled = false`. |
| `interiors/Hangar.ts` | **격납고 데크** (2026-09-08). 44 × 30 m, 천장 9 m. 호출자(`SharedShip`)의 `GeoBatch` 와 `BoxInteriorCollider` 에 **그대로 섞여 들어간다** — 드로우콜이 늘지 않고 바닥이 함선의 walkable union 에 맞닿아 출입구가 열린 공유 모서리가 된다. 갠트리 4틀 · 양옆 캣워크 · 닫힌 외부 게이트 · 슬롯 색 정박 구역 4개(점선 윤곽 + 위험 해칭 + 기둥 + 이름 표지판) + **9개 고정 포인트 라이트**(5.6 m 갠트리 높이, 130/30 — 첫 판은 8.2 m 에 6개였고 데크가 새까맸다). `setOccupants(names)` 가 개인 함선 모델 · 착륙 다리 · 램프(`buildGear`)를 켜고 끈다. |
| `interiors/ExteriorShips.ts` | Low-poly exterior models for the cutscene: `buildPersonalExterior()` (~9 m wedge, nacelles, additive engine discs) and `buildSharedExterior()` (~80 m spine, bridge tower, side hangar with an emissive-lined bay mouth at local (16, 0, 4), 4 engines, bay point light). `setThrust()` drives engine glow. |
| `index.ts` | Barrel. |

## Flow (events in → actions → events out)
| Trigger | Action |
|---|---|
| `hub:enter {ship}` | `ship` is coerced: a lobby exists → `shared`, else `personal`. If the phase is a mission / result phase (`deploying`, gameplay, `complete`, `dead`) emit **`game:abort` first** (GameFlow → `menu`, World / Player / etc. reset). Build the interior at the origin, `player.setInterior(collider)`, `player.spawnStanding(spawn, yaw)`, `setControlsEnabled(true)`, atmosphere space mode on, `ctx.setPhase('hub')`, emit `hub:entered {ship, spawn}`, request pointer lock. Personal ship: `ctx.net.ensureConnected()` in the background — a lobby on `welcome` (resume) swaps straight to the shared ship. Idempotent when already in the same ship. |
| `game:newMission` | Teardown (`'mission'`): un-board silently, close the menu, dispose interior / pods / terminal, `player.setInterior(null)` + `setCameraOverride(null)` + `setInPod(false)`, emit `hub:left`. Space mode is restored by Engine on `world:ready`. (World generated and Player respawned already — World is registered before Hub.) |
| `game:abort` (while hub active) | Teardown (`'menu'`) + space mode off. GameFlow sets `menu`. |
| Terminal `E` | `HubMenu.open()`: adds `ctx.uiBlockers` token `'hub'` **before** `ctx.input.setCursorMode(true, 'hub')` (the lock is released; `main.ts` re-locks when the last cursor owner leaves), emits `ui:hubMenuToggled {open:true}`. **Close is `E` again** (2026-09-08 — the footer reads 닫기 (E)) or the button; it removes the token and leaves cursor mode. Typing in the 도킹 코드 field never reaches `Input` (`ui/dom.isolateInput`), and that field's Escape now only **blurs** instead of closing the terminal. |
| Workbench `E` | `WorkbenchMenu.open()` (same token / cursor etiquette as the terminal, emits `hub:workbenchToggled {open:true}`); close → `{open:false}` + re-lock. The terminal, the workbench and the pods are mutually exclusive: none is interactable while either menu is open, during a cutscene or while boarded. Force-closed (no re-lock) on teardown (`game:newMission` / `game:abort` / 타이틀로), docking start and direct swaps. `HubSystem.isWorkbenchOpen` (debug getter). |
| `E` in `hub` (2026-09-08: **was `Esc`**) | steps out one level in the old Escape order: 정비 벤치 menu → 함선 터미널 → **분대원 장비 popup** → un-board the pod (that last one still gated on `UNBOARD_GRACE`). Each branch `consume`s the key. Ignored while `MENU_BLOCKER` is up. `HubSystem` updates **before** `PlayerSystem`, so the E that *opens* one of these is polled here while it is still closed and one tap can never open and close it in the same frame. **Escape is not read here at all any more** — it falls through to `game/` and is the 일시정지 메뉴, which stacks over whatever is open. |
| Pod `E` (hold 0.4 s) | Only the local slot's pod (`ctx.net.localSlot`, 0 solo) while free. `missionInProgress` → `ctx.net.rejoinMission()` (prompt `임무 진행 중 — 재투입`). Else board: `spawnStanding(pod)`, `setInPod(true)`, `setControlsEnabled(false)`, camera override to the pod shot, `ctx.net.setReady(true)`, `audio:play ui_equip`, `hub:slotChanged {slot, peerId: localId ?? 'local', local:true}`. `E` again (after 0.6 s) or Esc → un-board (`setReady(false)`, placed 1.3 m in front of the door, camera released). |
| crew cards (Phase 10) | **Sending only** — receiving / storing / `net:crewCard` is `net/`'s. `hub:entered {ship:'shared'}` → `announceCrew()`: broadcast `crew card` (level / ship implant / armor / 3 weapon slots, read off `ctx.progression` · `ctx.implants` · `ctx.inventory.getEquipped`) to `'others'` **and** send `crewq sync` so everyone answers with theirs. `progress:levelUp` / `implant:equipped` / `equip:changed` / `loadout:changed` / `inventory:loadoutSaved` re-broadcast it, debounced by `CREW_CARD_MIN_INTERVAL_S` (a change inside the window sets `cardDirty` and `update()` sends it when the window expires). Inbound `crewq sync` → our card to that peer (undebounced); inbound `crewq loadout` → `crew loadout {card, loadout: ctx.inventory.captureCrewLoadout()}` to that peer, at most once per `CREW_LOADOUT_COOLDOWN_S` per requester. Nothing is sent without a lobby. |
| `net:lobbyUpdated` | Personal ship + lobby appeared → docking cutscene (`lobby.started` → direct swap, resume case). Shared ship → `syncPods()`: pod occupant = `players[slot].ready && connected` (door closed, ring lit, tag `탑승 완료` / `임무 중` / `대기 중` / `연결 끊김`), `hub:slotChanged` on change; if the server dropped our own `ready` (lobby reset) > 1.5 s after we sent it → step out with `발사 슬롯이 초기화되었습니다`. Terminal screen refreshed. |
| `net:lobbyLeft` | Shared ship (or docking) → undock cutscene → personal ship. |
| `net:resumed {inProgress}` | Hub active → swap to the shared ship without a cutscene. **2026-09-07**: a **running raid** is then re-entered automatically (`진행 중인 임무로 복귀합니다` + `net.rejoinMission()` one microtask later, so the interior `swapDirect` just built is torn down cleanly) — the relay keeps a dropped raider's slot for the whole mission and the host parks their body, so walking to a pod first was busywork. A 훈련장 (individual entry) still only toasts `함선에 재접속했습니다 — 훈련장이 열려 있습니다 (터미널에서 합류)`; no mission → `함선에 재접속했습니다`. Outside the hub GameFlow handles it. |
| `net:peerJoined / peerLeft` | `ui:notify` `{name} 함선 합류 / 이탈` while the hub is active. |
| Docking | `startTransition(dir)`: un-board, close menu, dispose the interior (the player keeps the old collider reference), `setPhase('docking')`, `hub:docking {stage:'start', direction}`, `ui:notify`, cutscene (`HUB_DOCKING_DURATION`, undock ×0.5, `setControlsEnabled(false)`). End: build target (`shared` spawns at the airlock), `setPhase('hub')`, `hub:docking {stage:'end'}`, `hub:entered`, re-lock. A lobby that vanished mid-dock lands back in the personal ship. |
| Launch countdown | Every frame while boarded: `allReady` = solo → boarded; lobby → `!started` and every **connected** member `ready`. Starts `HUB_LAUNCH_COUNTDOWN`; the authority (solo / host) emits `hub:launchCountdown {seconds, ready, total}` on each second and at 0 calls `ctx.net.startGame(seed)` (host, once) or emits `game:newMission {seed}` (solo). Clients mirror the countdown locally for display only. Anyone un-readying cancels (`발사 취소 — 승무원 대기`). Seed = `lobby.seed ?? hub.missionSeed ?? random`. |
| Terminal `◀ ▶` / `행성 이동` (Phase 11) | Stepping is a **preview**: the hologram swaps (`PLANET_SWAP_TIME`) and the labels change, `ctx.hub.planet` does not. `행성 이동` → `HubRef.setPlanet(id)`, refused (false, and the button carries the reason) for a non-host in a lobby (`호스트만 지정할 수 있습니다`), during a cutscene / travel (`이동 중`), during a launch countdown (`발사 카운트다운 중`), outside the `hub` phase, for an unknown id and for the planet we are already at. Solo it writes `PLANET_STORAGE_KEY`; in a lobby the **host** calls `ctx.net.setLobbyPlanet` (which mirrors `lobby.planet` optimistically) and every member's own `lobby:state` starts the same cutscene. |
| 행성 이동 cutscene (Phase 11) | `startTravel(planet, by)`: un-board (`setReady(false)`), close terminal / workbench, hide the READY panel, cancel the countdown, `travelling = true`, `hub:travel {stage:'start', planet}` + a `ui:notify` + `hub_dock_thrusters`, then `DockingCutscene` in `'travel'` mode for `HUB_TRAVEL_DURATION`. **The interior is kept** — no `disposeInterior`, no rebuild, the phase stays `'hub'`; only the view outside changes. End: camera override released, controls back, `setPlanetLook` on the window planet, terminal screen + pods re-synced, `hub:travel {stage:'end'}` + `hub:planetChanged {planet, by}` + `hub_dock_clamp`, re-lock. Every path that disposes a cutscene (`enter`, `teardown`, `startTransition`, `swapDirect`, `finishTransition`) also clears `travelling`. |
| `net:lobbyUpdated` (planet, Phase 11) | Handled **after** the personal→shared docking branch, so joining a lobby only fills the value (`build()` seeds `knownLobbyPlanet` + `applyPlanetLook`, no cutscene). Afterwards a `lobby.planet` different from `knownLobbyPlanet` starts `startTravel(lp, 'squad')` while we are in the hub, not travelling and the lobby has not started; otherwise it just re-tints the window planet. There is **no travel message on the wire** — each client plays its own cutscene off `lobby:state`. |
| Pod `E` gate (Phase 11) | `podCanInteract` is only *availability* (phase / cutscene / **travelling** / boarded / menus / our slot / free). The refusals live in `podBlockReason`, which stays **interactable on purpose**: `ctx.interactables.findBest` skips anything that answers `canInteract() === false`, and the player would then get no prompt and no reason at all. Order: a training runs → `훈련 진행 중 — 터미널에서 합류`; 목표 행성 미지정 → `목표 행성 미지정 — 터미널에서 지정`. `boardPod` refuses both with a `ui:notify` + `ui_deny`. |
| Launch (Phase 11) | `launch()` returns early without a planet (the pod gate caught it, and the server would answer `no_planet`). Lobby host: `ctx.net.startGame(seed, 'raid', planet)`. Solo: `ctx.missionMode = 'raid'` **and `ctx.missionPlanet = planet`** before `game:newMission {seed, mode:'raid', planet}` (the emitter sets both first — `world/` generates inside the emit). `startTraining()` sets `ctx.missionPlanet = null`: the arena has no planet. |
| `타이틀로` | `leaveLobby()` if in one, teardown, `ctx.setPhase('menu')` (title shows because `lobby` is null). |
| `M` in the hub (Phase 8) | `Keys.MAP` (read live) with no blocker, not boarded, no cutscene, not already decorating and only in the **personal** ship → `openShipManage()` → `ctx.housing.openShipManage(currentRoom ?? undefined)`; housing answers with `housing:shipManageChanged` which `HousingMode` turns into the top-down camera. The shared ship / a missing housing ref answer with a `ui:notify` warning. `ui/` draws the `함선 관리 (M)` hint, the 방 목록 and the 가구 카드 바. |
| every frame (personal ship) | `updateNear(dt, playerX, playerZ)`: 자동문 (open within `DOOR_OPEN_DISTANCE`, slide `DOOR_SLIDE_SPEED`, no collider change) + the `ROOM_LIGHT_POOL` room lights (re-anchored to the nearest non-empty rooms, intensity ramped through 0, **never** `visible`-toggled). `trackRoom()`: `roomAtWorld(player.x, player.z)` → `currentRoom`; on change emit `hub:roomEntered {room, purpose}` (`null` in the corridor / cockpit / airlock; also emitted with `null` on teardown). |
| 시뮬레이션 훈련장 (Phase 7) | `HubSystem.startTraining()` (public; the 사격장 `furn_sim_hub` and the shared-ship terminal call it): refused outside `hub`, during a cutscene, while boarded or decorating. **Lobby**: a raid running (`lobby.started`, mode ≠ training) → `ui:notify` `임무 진행 중 — 훈련장을 열 수 없습니다` + `ui_deny`; a training already running (`net.missionMode === 'training'` / `lobby.mode`) and we are in the hub (`missionInProgress`) → `net.rejoinMission()` (join, toast with the member count); otherwise `net.startGame(seed, 'training')` — any member, no ready gating, the server marks only the caller `inMission` and `game:start {mode:'training'}` → net emits `game:newMission` for us → `teardown('mission')`. **Solo**: `ctx.missionMode = 'training'` **before** `game:newMission {seed, mode:'training'}` (contract: the emitter sets the mode first; the pod launch likewise sets `'raid'`). Seed = `resolveSeed()`. Coming back (`game/` handles `training:exitRequested` → `game:abort` + `hub:enter`) builds the ship directly — `enter()` never plays the docking cutscene, so a lobby member lands straight in the shared ship. While a training runs in the lobby: pod prompt `훈련 진행 중 — 터미널에서 합류`, boarding refused with a notice + `ui_deny`, pod tags `훈련 중` / `대기 중` (no door closes for a training), status line `훈련 진행 중 (n명)` / `터미널에서 합류할 수 있습니다`, terminal screen line `훈련장 n명`; the launch countdown never starts because `lobby.started` is true. |
| Furniture `E` | `hub_furn_<uid>`: bench → `ctx.inventory.openBenchCraft(kind, level)`, **관물대** (`furn_range_console`, renamed from 사격장 콘솔 in the Phase 8 UI pass — the only way into the loadout presets) → `ctx.housing.openPresetMenu()`, 시뮬레이션 허브 → `startTraining()` (Phase 7), **정비 벤치 → `WorkbenchMenu.open()`**, **재배층 → `ctx.housing.openGrowMenu(uid)`** (Phase 8; a missing housing ref degrades to a `재배층을 사용할 수 없습니다` toast). |
| Computer `E` (Phase 5) | `hub_computer` → `ctx.meta.openCorpMenu()`; fallback `ui:notify` warning when meta is missing / a stub / the screen did not open. **2026-09-07**: that screen is the Tab window's 기업 tab (`ctx.inventory.openScreen('corp')`), so there is no `'corp'` blocker any more — the window's own `'inventory'` token covers the station gating (`stationUsable()` / `podCanInteract()` already read `ctx.inventory.isOpen`) and the pointer-lock loss. **Esc** is left to inventory/: while `corpMenuOpen()` the hub's whole Escape chain is skipped, and the old one-frame `corpWasOpen` swallow is gone. Terminal status screen gets a 4th line `크레딧 n` (`ctx.meta.credits`, refreshed on `meta:creditsChanged` / `meta:loaded`; omitted while meta is missing). |
| `housing:modeChanged {active:true, room}` | `HousingMode.activate(room)` (see below); `{active:false}` → restore camera / controls. Terminal, pods, stations and furniture are not interactable while active (`stationUsable()` / `podCanInteract()` check `housingMode.active`; the player's own interaction loop is off because controls are disabled). `HubSystem.update` hands the whole input frame to `HousingMode.update()` while active (Esc never reaches the menu toggle). A pointer-lock loss while decorating exits housing mode and re-locks instead of opening the terminal. |
| `housing:furniture* / changed / loaded` | `FurnitureLayer` rebuilds the room (meshes, blockers, `Lv.n` sign, interactable; `changed` only for uncovered reasons); `housing:roomPurposeChanged / changed / loaded` rewrite the door signs. |

## Personal-ship coordinates (`interiors/RoomLayout.ts`, metres, ship at the origin, spawn faces −Z)
| Part | X | Z | Notes |
|---|---|---|---|
| Cockpit | −5 … 5 | −6 … 0 | viewport on −Z, 2.6 m arch to the corridor on +Z (x −1.5 … 1.5) |
| Corridor | −1.5 … 1.5 | 0 … 25 | 5 segments × 5 m, light + rib + beam per segment |
| Room i (0..4, port −X) | −5.8 … −1.8 | 5·i + 0.5 … 5·i + 4.5 | door 1.6 m centred at z 5·i + 2.5 on x −1.8 … −1.5; sign above the door, console at z door + 1.15 |
| Room i (5..9, starboard +X) | 1.8 … 5.8 | 5·(i−5) + 0.5 … 5·(i−5) + 4.5 | mirror image (door on x 1.5 … 1.8) |
| Airlock | −1.5 … 1.5 | 25 … 27.5 | 3 lockers on −X, 3 supply crates on +X (x 0.78 … 1.5, z 25.5 … 27.3), decorative door + beacon on +Z, `airlock` spawn (0, 0, 26) |
| Ship computer (cockpit) | 4.65 (desk centre; collider x 3.83 … 4.98) | −3.1 (collider z −3.87 … −2.33) | `stations.shipComputer`: 1.5 × 0.65 m desk against the +X wall facing −X, chair tucked in front, one collider box (desk + chair), anchor `hub_computer` (3.18, 0, −3.1); shared ship: desk (−11, −6.65) facing +Z, collider x −11.77 … −10.23 / z −7 … −5.85, anchor (−11, 0, −5.18) |
| Walls / ceiling | thickness 0.3 | ceiling 3.2 everywhere | collider rooms: cockpit, corridor, airlock and each room extended through its door wall to the corridor face (shared edge = open doorway) |

Grid: `ROOM_GRID_COLS × ROOM_GRID_ROWS` = 8 × 8 cells of `HOUSING_CELL_SIZE` 0.5 m; cell `x` along +X, `y` along +Z from the room's min corner. A piece with top-left cell (x, y) and rotated footprint (cols, rows) is centred at `(minX + (x + cols/2)·0.5, minZ + (y + rows/2)·0.5)`; `yaw` 0..3 = quarter turns clockwise from above (`rotation.y = −yaw·π/2`), models are built with their front toward −Z.

## Housing mode (`HousingMode.ts`)
- **Entry** (Phase 8 UI pass: 시설 관리 is the only in-game entry — the room door consoles are gone): `ctx.housing.enterHousingMode(room)` (API only, still gated on standing in the room) emits `housing:modeChanged {active:true, room}`, and **함선 관리** (Phase 8) `ctx.housing.openShipManage(room?)` emits `housing:shipManageChanged {active:true, room}` from anywhere in the ship (`HousingMode.manage = true`); `setManageRoom` re-emits it with another room and `activate()` **retargets** — same camera blend, cursor recentred on the new room, a carried piece dropped. Either way the hub then calls `player.setControlsEnabled(false)` and `setCameraOverride(pos, lookAt)` with `pos = (roomCentre**X + 2.2**, 6.6, roomCentreZ)` looking at the room centre — **Phase 10**: the eye is on the room's **+X side looking −X for every room**, not over each room's own door wall (`cx − rb.side · 2.2`), which is what made rooms 6–10 read 180° rotated. A port room therefore keeps its familiar framing (door at the bottom) and a starboard room is now seen from the outer hull toward the corridor (door at the **top**), with the same world→screen mapping in both. The starboard eye (x = 6.0) is inside the outer hull slab in XZ but 6.6 m up, well above `CEIL` 3.2, and the ceiling plane is back-face culled from above — nothing occludes the floor. Tilted ~70° down, blended by the rig (not snapped); nothing hangs under the room ceiling (the light bands sit on the walls), so the whole 8 × 8 floor is visible.
- **Cursor (함선 관리, Phase 8 · Phase 10 · 2026-09-07 rework)**: the manage session takes the `shipmanage` blocker token and then `ctx.input.setCursorMode(true, 'shipmanage')`, which **releases the pointer lock** and hands the real OS cursor back (restyled by `ui/hud/GameCursor`). The floor cursor is a **camera ray onto the deck plane** (`Input.uiX/uiY` → NDC on `ctx.canvas` → y = 0, clamped into the room), so the ghost follows the cursor like an editor. `input.elementUnderCursor()` inside `#ui-root` swallows the LMB placement and the wheel cycle, so clicking a furniture card never drops a piece behind the panel. Because cursor mode leaves `Input`'s gameplay button sets empty (the press belongs to whatever the cursor is over), placement and the selection wheel also read the DOM directly: window `pointerdown` **and** `mousedown` (a Set dedupes the pair a real browser fires; the headless smokes send only `mousedown`) plus `wheel` are collected into a per-frame buffer that `update()` ORs with the native path. The blocker token is what stops `player/`'s click-to-relock fallback (`isControlActive()`); leaving the mode deletes the token, leaves cursor mode and still fires the defensive relock, though `main.ts` normally gets there first. `HousingMode.update` ignores every *other* blocker token as before.
- **Cursor (room console)**: the pointer **stays locked**; `Input.mouseDX / mouseDY` move a continuous floor cursor (`CURSOR_M_PER_PX` 0.012 m/px, clamped to the room). **Phase 10**: screen right = world −Z and screen down = world +X **for every room** (the `× rb.side` factor went with the mirrored camera, so the starboard rooms are no longer inverted). The footprint's top-left cell is `round(cursor/cell − footprint/2)` clamped so the piece fits. (Chosen over an unlocked ray-cast so the hub never has to juggle the pointer-lock etiquette mid-mode; the mouse cannot leave the room anyway.)
- **Ghost**: `buildFurniture` of the selection (`ctx.housing.selectedFurniture` + `selectedYaw`, level = best stored level) with every mesh's material swapped to `GHOST_OK` / `GHOST_BAD` by `canPlace`; rebuilt only when def / yaw / level change. An additive floor frame the size of the footprint follows the cursor (cyan = nothing selected, amber = a placed piece under the cursor, green / red = placement validity).
- **Cursor outside the room (2026-09-07)**: `raycastCursor` still clamps the deck hit into the room box (the ghost needs a defined pose) but now records whether the **raw** hit was inside (`cursorInRoom`). While it is not, `refresh()` hides the frame *and* the ghost, forces `valid` false in `housing:cursorChanged`, and LMB / X do nothing — pointing at the corridor or another room used to leave the cyan highlight stuck on the nearest edge cell and would place there on a click. The locked-delta (room-console) path can never leave the room, so it always reports inside.
- **Keys** (read live from `Keys`): `MouseButtons.FIRE` = `place(room, def, x, y, yaw)` when something is selected; otherwise picks up the piece under the cursor (carried piece is ghosted, `canPlace(…, ignoreUid)`) and the next click puts it down with `move(uid, x, y, yaw)`. `Keys.ROTATE_ITEM` = `rotateSelection()` (or rotates the carried piece). `Keys.DROP_ITEM` = `recover(uid)` of the piece under the cursor / in hand. Mouse wheel or `BracketLeft` / `BracketRight` = cycle `selectFurniture` through `[null, …getStored() defIds]`. `CANCEL_KEY` (fixed **`KeyC`**, Phase 8) = cancel: a carried piece goes back where it was picked up (it was never removed from the state), otherwise `selectFurniture(null)` — and when the cursor holds **nothing** it leaves the mode, exactly like Esc (Phase 8 UI pass). `Keys.MENU` = `closeShipManage()` in 함선 관리, else `exitHousingMode()`; if housing stays silent (stub) the hub leaves locally and emits `housing:modeChanged {active:false}` (+ `housing:shipManageChanged {active:false}`) itself. Input is ignored while `ctx.uiBlockers` is non-empty (console / housing panels).
- **Events out**: `housing:cursorChanged {room, x, y, valid}` on activation and whenever the cell or validity changes (`valid` = `canPlace` with a selection, else "there is a piece under the cursor"). Audio `ui_equip / ui_deny / ui_click` on actions.
- **Carry** (`HousingMode.announceSelection`): picking up a placed piece, rotating it with R, dropping it (`move`) and recovering it with X each emit `housing:selectionChanged` — the carried piece's def + yaw while in hand, the housing selection again afterwards — so the HUD hint (`ui/hud/HousingHint`) never reads `선택 없음` while a piece is being moved.
- **Exit**: `setCameraOverride(null)` + `setControlsEnabled(true)` (only while the phase is still `hub`; teardown handles the rest), ghost disposed, carry dropped (the piece stays where it was), and the `shipmanage` blocker token released + the pointer re-locked. The release is **not** gated on `active` and the `housing:*Changed` handlers must not clear `manage` before calling `deactivate()` — doing so was the Phase 8 bug where Esc gave the camera back but left the token up, so the player had no controls and the 시설 관리(M) hint stayed hidden.

## Notes
- **Atmosphere**: `core/Atmosphere.setSpaceMode(on)` (sky dome hidden, black background, fog 0, cool dim key + hemi). Reached through `ctx.scene.userData.atmosphere` (feature folders may not import `core/`); `applySeed` on the next `world:ready` restores the palette automatically. Each interior renders its own `Starfield` + `Planet` outside the viewports.
- **Lights**: personal ship **13** `PointLight`s (cockpit 4, corridor 5, airlock 1 + `ROOM_LIGHT_POOL` = 3 room lights), shared ship 6; the count is **constant and no light is ever toggled** (toggling `visible` recompiles every shader) — a room light that must follow the player to another room ramps its intensity to 0, is repositioned and ramps back to `ROOM_LIGHT_INTENSITY`. Static geometry is merged per material (personal ≈ 22 renderables + pod + 11 signs, shared ≈ 29 + 4 pods); **Phase 8** adds 3 merged meshes per room for its own strip material instances (white / cyan / amber clones, disposed with the ship) and 2 door-leaf meshes per doorway (11 doors: 10 rooms + the cockpit arch). Each placed furniture piece is 2–5 merged meshes in its room group (+1 `Lv.n` plane for benches). Pod-door colliders are toggled via `BoxInteriorCollider.setBlockerEnabled`, furniture blockers via `removeBlocker`, not by rebuilding the collider.
- **Optional refs**: `ctx.implants` / `ctx.inventory` / `ctx.progression` / `ctx.loot` may all be null (other systems register separately). Every station and page checks them and degrades to a disabled state with a Korean explanation; no formula from progression is re-derived here — only `derived.gatherYieldMul` and `derived.interactSpeedMul` are read.
- **재배 (Phase 8)** is no longer a hub station: the 온실 room's `furn_grow_rack` pieces own the plots and `ctx.housing` owns the timers / seeds / panel. The hub only renders the racks (stacked by `PlacedFurniture.layer`) and forwards `E` to `openGrowMenu(uid)`.
- **Pod cells stay walkable** (rear wall + side lips + toggleable door slab) so a boarded player (r 0.45) is never pushed out by `resolveCollision`; open pods can be walked into.
- Remote players / nameplates / pings in the shared ship are rendered by `player/`, `ui/`; the hub only provides identical geometry on every client (built at the origin) and `getLaunchSlots()`.
- Debug: `__game.ctx.hub` (`.currentRoom`, `.setMissionSeed`, **`.planet` / `.setPlanet(id)` / `.travelling`**), `__game.getSystem('hub')` (`.isWorkbenchOpen`, `.housing` = `HousingMode` with `.active / .manage / .room / .cell`, `.openShipManage()`, `.furnitureLayer` with `.count / .pieceAt`), `__game.ctx.bus.emit('hub:enter', {ship:'personal'})`; interactables `hub_terminal`, `hub_workbench`, `hub_computer`, `hub_implant_bay`, `hub_pod_<slot>`, `hub_furn_<uid>` via `ctx.interactables.all()`. Scene: the ship root is named `PersonalShip`, furniture groups `room-<i>`, ghost group `furn-<defId>`, the window planet `HubPlanet` (its lit sphere `HubPlanetBody`), the travel cutscene `DockingCutscene` with a `HubWarpStreaks` child. The terminal screen's drawn text is `getSystem('hub').terminal.def.screen.last`.
- `ctx.meta` (Phase 5) is optional too: the computer degrades to a warning toast, the credits line disappears from the terminal screen, and every read goes through `corpMenuOpen()` / `credits()` (try/catch, `typeof` guards). The monitor tilt convention: a box frame with `rx = +tilt` and a `TextPlane` with `Euler(−tilt, ry + π, 0, 'YXZ')` lean the same way (top away from the user) — note `consolePedestal` tilts its housing box the opposite way from its screen plane, so do not copy that pair for new screens.
- `ctx.housing` is optional everywhere in this folder (`typeof fn === 'function'` / try-catch); with the skeleton the rooms are all `빈 방`, `getPlaced` is empty and the consoles show a warning toast. Furniture defs are always read from the contract's `FURNITURE_DEF_MAP`, never from `ctx.housing.getFurnitureDef`.
- Workbench materials are read by def id (`mat_scrap`, `mat_alloy`; names come from the item defs, with a Korean fallback). The repair rule itself (`REPAIR_SCRAP_PER` / `REPAIR_ALLOY_PER`) lives in `items/` behind `ctx.loot.getRepairCost`; the hub only renders and calls `ctx.inventory.repairWeapon`.

## Verified (headless Chrome, `scripts`-style puppeteer smoke, no relay server)
`hub:enter personal` → phase `hub`, `ctx.player.interior === ctx.hub.collider`, spawn (0,0,1.2), space mode on, `hub:entered`; collider push-out (+X wall, out-of-room clamp, dashboard blocker, free spot unchanged), raycast −Z → dashboard normal +Z, up → ceiling 3.2; terminal → menu open (`'hub'` blocker, `isControlActive()` false) → Esc close / reopen / 닫기; pod `E` → `isInPod`, slot occupant `local`, status line, `hub:launchCountdown` → `game:newMission` → `deploying`, hub torn down, `player.interior` null, space mode restored; `hub:enter` from the mission → abort → personal ship again; `타이틀로` → `menu`. Shared ship: 4 pods, boarded position not pushed, separators solid. 41/42 checks; the single failure is the browser's WebSocket console error from `ensureConnected()` with no server on 8787. `npm run typecheck` 0 errors.

Workbench (2026-09-05, headless Chrome, hub only): personal ship registers `hub_workbench` (prompt `정비 벤치`, anchor (3.5, 0, −1.85)), bench collider pushes a 0.45 m circle out, E → menu open with the `'hub'` blocker (`isControlActive()` false, terminal not interactable), `hub:workbenchToggled {open:false}` + blocker removed on close, `닫기` click, Esc via `Input`; shared ship registers it too (anchor (2.5, 0, 5.43)); `game:abort` unregisters + closes. With `getRepairCost` / `repairWeapon` mocked on top of the real `getEffectiveStats` (AR-23 max 500, P-2 350, SMG-37 550): rows in loadout → bag order, `120 / 500` + `폐금속 ×4`, `정비 완료` disabled, 수리 consumes materials and re-renders (`500 / 500`), `파손` tag + red cost when broken and unaffordable, `inventory:changed` re-enables `모두 수리`, `모두 수리` with 7 scrap → `1정 수리 완료 · 1정 재료 부족`. 25/25 checks, 0 console errors. Screenshots: bench prop + `정비` sign + `E 정비 벤치` prompt in both ships.

## Tactical kit (merged 2026-09-06)

| File | Role |
|---|---|
| `interiors/stations.ts` | 함선 시설 geometry (Phase 8 deleted `hydroponics()` / `GardenStationDef` / `ShipStations.garden`; `ShipStations.bench` is optional now): `repairBench()` (bench + vise + wall tool board; `withTable=false` decorates an existing bench), `implantBay()` (surgical chair + scanner canopy) and **`shipComputer()`** (Phase 5: steel desk with drawer block + PC tower, keyboard / mouse, two monitors tilted 0.14 rad top-away on stands — right = emissive `M.screen` panel with dark title bar + cyan lines, left = the caller's `TextPlane` at `ComputerStationDef.screenPos / screenRot` reading `기업 네트워크 / 접속 대기` — chair tucked under the front edge, cyan lamp strip on the wall above, one collider box; no lights, no new materials), plus the `StationDef` / `ComputerStationDef` / `ShipStations` types. Everything goes through the interior's `GeoBatch`, so a station adds **no draw call**. Each returns a deck-level interaction anchor in front of itself. |


- The terminal (`ui/HubMenu`) is ship-only again (2026-09-06): the 임플란트 / 정비 tabs and `ui/ImplantPanel` / `ui/RepairPanel` were removed — implants are equipped on the **Tab ship screen** (inventory folder) and repairs live in its right-click menu. The 캐릭터 footer button (`ui:statsToggled`) stays. Both ships carry a hydroponics rack, an implant bay (interactable `hub_implant_bay` → `ctx.inventory.toggleBag()`, i.e. the Tab screen; `stationUsable()` also requires the inventory to be closed) and a repair bench.
- Terminal frame: `overflow: hidden` with the corner brackets kept inside the box and the page (`.hub-page`) scrolling only when the viewport is too short — the old `overflow-y: auto` on the frame plus the −1 px brackets produced permanent scrollbars.

## 함선 꾸미기 (2026-09-06) — verified
`node scripts/smoke-ship-rooms.mjs` **47/47** (headless Chrome on the GPU, real `ctx.housing`): personal ship spawns at
(0, −1.8) with `hub_terminal / hub_implant_bay / hub_pod_0`
registered, exactly 10 point lights and 10 room groups under `PersonalShip`; terminal has no 임무 시드 section and the hint
names `/seed`, `setMissionSeed(1234)` accepted solo; W from the corridor (yaw π/2) walks through room 0's door
(x −5.35 after 2 s), `currentRoom` 0 + `hub:roomEntered {0, empty}`, the outer wall clamps at x ≥ −5.8, leaving emits
`{room:null}`, (3.8, 12.5) is room 7, `hub_room_0` prompt `방 1 · 빈 방`; `enterHousingMode(0)` → controller active,
`housing:modeChanged`, initial `housing:cursorChanged`, camera at y 6.6 over the room, W no longer moves the player, the
door console is not interactable, −160 px of mouse movement emits a new cursor cell; selecting the starter 총기 작업대
shows a green ghost (`furn-furn_bench_gun` under the ship root), R → yaw 1, LMB → `housing:furniturePlaced` at the ghost
cell, 7 merged meshes under `room-0`, `hub_furn_f-1`, centre matches `roomCellToWorld`, `resolveCollision` pushes a 0.45 m
circle out of it; Esc → `{active:false}`, camera back (y 1.76), a player spawned inside the bench is pushed out, prompt
`총기 작업대 Lv.1`, door console `방 1 · 작업실`; re-entering and moving the cursor over the bench + X → `housing:furnitureRecovered`,
0 meshes / 0 interactables; `game:abort` disposes the layer and emits `hub:roomEntered {null}`, re-entering rebuilds
the 10 consoles. 0 console errors. `node scripts/smoke-controls-hub.mjs` still **60/60** with the relay up (59/60 without
it — the single miss is the browser's WebSocket error from `ensureConnected()`). `npm run typecheck` 0 errors.
Screenshots checked: cockpit props in place, corridor with signed doors and consoles, dark self-lit room, top-down housing
view with the ghost + HUD hint, placed bench with its `Lv.1` sign, airlock end.

## 함선 컴퓨터 (Phase 5, 2026-09-06) — verified
`node scripts/smoke-ship-rooms.mjs http://localhost:5303/` **61/61** (headless Chrome on the GPU, real `ctx.meta` corp screen
from the meta agent): `hub_computer` registered in the personal ship (prompt `기업 네트워크`, radius 2.2, instant, anchor
(3.18, −3.10)), the desk + chair collider pushes a 0.45 m circle / a spawned player from the desk's front edge back into the
room (x 3.38), the terminal screen carries `크레딧 500` and follows `meta:creditsChanged` (`크레딧 600`), `findBest` at the
anchor is the computer, E → `ui:corpToggled {open:true, corp:'helix'}` with blocker `corp` and the terminal locked, Esc →
`{open:false}` with **no** terminal menu and no blocker left, the computer usable again, `game:abort` + re-enter re-registers
it. Every earlier room / housing check still passes; 0 console errors. `smoke-controls-hub` and `smoke-housing` re-run
against the same vite for regressions (numbers in `docs/VERIFICATION.md`). `npm run typecheck` 0 errors.

## 시뮬레이션 훈련장 (Phase 7, 2026-09-06) — verified
`node scripts/smoke-training.mjs http://localhost:5308/` **61/61**, 0 console errors (private vite, no relay): a real `furn_sim_hub` crafted and
placed through `ctx.housing` in room 0 (사격장) renders 9 merged meshes under `room-0` with no light, both ring groups rotate, `hub_furn_f-1`
prompts `시뮬레이션 허브 · 훈련장 입장` and is usable; E → `game:newMission {mode:'training'}`, the hub is torn down, the arena world comes up (see
`src/world/README.md`), the exit console emits one `training:exitRequested` per press and `game/` brings the player straight back to the
personal ship (`hub:entered`, space mode on, arena disposed). Faked lobby (`NetSystem._lobby`): the shared-ship terminal shows the
`시뮬레이션 훈련장` section with `시작` enabled, `합류 (1명 훈련 중)` + crew `훈련장` while a member trains, `임무 진행 중` disabled during a raid;
`hub_pod_0` prompt `훈련 진행 중 — 터미널에서 합류`, boarding refused with the notice, status line `훈련 진행 중 (1명)`; `startTraining()` refused
during a raid with `임무 진행 중 — 훈련장을 열 수 없습니다`. `smoke-ship-rooms` 61/61 and `smoke-controls-hub` 60/60 still pass. Screenshot
checked: the holo pedestal with its rings in the 사격장 room. A real two-client training (server `lobby:start {mode:'training'}`, `inMission`,
join via `rejoinMission`) is the net/server agent's `e2e:mp` territory — the hub only calls the contract.

## Phase 8 (2026-09-06) — UI/UX pass, hub section 2.3
- **터미널 to the cockpit centre**: the −X wall `consolePedestal` is gone; the terminal stands on the ship's centre line
  between the two pilot seats at (0, −4.55), screen facing **+Z**, anchor (0, 0, −3.55), same `hub_terminal` id and
  radius 2.4 (so it is already in range at the spawn (0, 0, −1.8)). The shared ship's bridge terminal is unchanged.
- **정비 벤치 out of the cockpit**: `ShipInterior.workbench` is optional and the personal ship no longer sets it —
  `hub_workbench` only exists in the shared ship. A placed `furn_repair_bench` (작업실) opens the same `WorkbenchMenu`.
- **GardenStation deleted** (file, registration, both hydroponics racks, `ShipStations.garden`, `GardenStationDef`,
  `hydroponics()`). `scav.hub.garden.v1` is abandoned — no migration by design.
- **New furniture models** `grow_rack` / `repair_bench` + stacked rendering (`layer × GROW_RACK_LAYER_HEIGHT` on the
  model, the collider blocker and the `Lv.n` sign; one interactable per 층, spread along the front edge).
- **자동문** (`interiors/Doors.ts`): 10 room doorways + the cockpit arch, two leaves each, open within
  `DOOR_OPEN_DISTANCE`, `DOOR_SLIDE_SPEED` per second, **no collider change** (the doorway was and stays an open
  shared edge of the walkable boxes, so movement is exactly what it was).
- **방 조명**: per-room emissive strip material instances (`ROOM_STRIP_DIM` when the purpose is `empty`,
  `ROOM_STRIP_LIT` otherwise, driven by `housing:roomPurposeChanged / changed / loaded`) plus a constant pool of
  `ROOM_LIGHT_POOL` point lights that re-anchor to the nearest non-empty rooms.
- **함선 관리**: `M` (`Keys.MAP`, read live) → `ctx.housing.openShipManage()`; the mode runs **unlocked** with a
  raycast floor cursor and a `shipmanage` blocker token (see Housing mode above); `HousingMode` listens to
  `housing:shipManageChanged`, has no "stand in the room" gate and retargets on `setManageRoom`; `C` cancels the
  selection / a carried piece, `Esc` leaves manage mode.
- **Esc in the hub** no longer opens the terminal (nor does a lost pointer lock) — `game/` opens the 일시정지 메뉴.
  Esc here only closes the corp screen / workbench / terminal menu or steps out of a pod.
- **터미널 메뉴**: the 캐릭터 button is gone and the 승무원 name is a one-time choice (read-only after
  `ShipState.nameLocked`; the hub reads the flag, housing/ persists it).
- Not done here (other folders own them): the `함선 관리 (M)` HUD hint, the 방 목록 / 가구 카드 바 screen and the
  `HousingHint` C line are `ui/`; the pause menu is `game/` + `ui/`; the grow panel, the stacking rules and
  `nameLocked` persistence are `housing/`.

## Phase 9 UI pass (2026-09-07) — cockpit clean-up + housing-mode camera

- `interiors/parts.ts` — `Parts.walls()` splits the waist-high **wainscot band** around a floor-level opening
  (`o.y0 < band`). It used to run the full length of every side, leaving a waist-high slab standing across each room
  doorway and the cockpit arch.
  - **2026-09-07**: the *corridor* wainscot in `PersonalShip.buildLayout` was a separate one-piece trim bar per side and
    was **not** covered by that split, so the 1.05 m amber line still ran straight across all ten room doorways and read
    as a rope barring the door. It is now emitted as the segments **between** the doorways (`rb.doorZ ± DOOR_WIDTH/2`
    plus 12 cm of clearance).
- `interiors/PersonalShip.ts`:
  - the cockpit **console pedestal terminal is gone**; the dashboard's centre monitor *is* `terminal.screen` now (a
    `TextPlane` on the tilted bezel's front face, anchor between the pilot seats). The 항법 / 통신 side readouts went
    with it, so the one screen reads at a glance and nothing stands on the walk-in line;
  - the **함선 컴퓨터** moved from the +X wall — where its 기업 네트워크 prompt fought the launch pod's boarding prompt
    — to the port half of the rear wall, replacing the lockers that overlapped the bunk. The port rear rib went with
    them (it stood inside the desk and hid the monitor);
  - the stash cabinet moved to the starboard half of the rear wall and the bunk sits flush against the −X wall;
  - **door frames** stand in the corridor clear of the wall slab (`face − side · 0.06`); they used to sit 3 cm inside
    the 30 cm door wall and intersected the wall segments around the opening.
- `HousingMode.ts` — switching rooms in 시설 관리 **glides** the camera instead of cutting: the mode keeps its own
  override pose (`camPos` / `lookPos`) and eases it toward the new room's goal every frame (`glideCamera`, rate
  `CAM_GLIDE`). The rig only blends the override *weight*, which is long since 1 by then, so copying the new position
  straight in teleported the camera across the ship in a single frame. `update(dt)` takes the frame time now.

## Phase 9 UI/UX 개선 pass (2026-09-07)

- **훈련장 재접속 fix.** `onResumed` (and `ui/hud/Notifications` / `game/GameFlowSystem` on the same `net:resumed`)
  now read the lobby's mode: a 훈련장 is entered individually and keeps the lobby open, so it is **not** the squad's
  mission. Reconnecting while one runs says `함선에 재접속했습니다 — 훈련장이 열려 있습니다 (터미널에서 합류)` instead
  of `분대가 임무 중입니다 — 발사 슬롯에 탑승하면 재투입됩니다`. The pod prompts, the pod tags and the status line
  already branched on `trainingRunning()`; this closes the last three places that did not.

## Phase 10 UI 개선 pass (2026-09-07)

- **발사 준비 패널** (`ui/ReadyPanel.ts` + `ui/CrewLoadoutPanel.ts` + `hub.css`, see the file table). Four cells at
  the bottom of the ship screen while any launch slot is filled, one portrait canvas from
  `ctx.player.createPortraits`, name + `Lv. n` top-left, the equipped 전술 임플란트 on the right, right-click → the
  modeless 분대원 장비 popup (장비 / 가방 / 빠른 사용, no 함선 창고, no credits). It holds `HUB_READY_BLOCKER` +
  `setCursorMode` only while the **local** player is boarded, and `HubSystem.uiBlocked()` — the shape of
  `HousingMode.blockedByPanel()` — makes the Esc / E un-board paths and `onPointerLockChange` ignore that one token.
- **crew card 송신** in `HubSystem`: `crew card` broadcast on `hub:entered` (shared ship) and on every level /
  implant / equipment change (debounced by `CREW_CARD_MIN_INTERVAL_S`), `crewq sync` sent on arrival, and answers to
  inbound `crewq sync` / `crewq loadout` (the latter rate-limited per requester by `CREW_LOADOUT_COOLDOWN_S`).
  Receiving, storing and `net:crewCard` / `net:crewLoadout` are `net/`'s half of the wire.
- **하우징 카메라, 6~10번 방**: one camera convention for every room (`cx + CAM_TOWARD_DOOR`, the port framing) and
  the matching cursor mapping without the `rb.side` mirror. See **Housing mode** above.
- **커서 이관** (plan §2): `ui/HubMenu`, `ui/WorkbenchMenu` (`'hub'`) and `HousingMode.enterManage`
  (`'shipmanage'`) call `ctx.input.setCursorMode(true, TOKEN)` and never `exitPointerLock()`; `HousingMode`
  reads `input.uiX / uiY` / `elementUnderCursor()` instead of `input.mouseX / mouseY` + `document.elementFromPoint`.
  `ui/dom.isolateInput` now focuses the field on pointerdown, because a synthesised (untrusted) click performs no
  default action and the 승무원 이름 / 도킹 코드 fields would otherwise never take the caret.

### Known follow-ups (Phase 10)
- The READY panel is **visible** whenever a slot is filled but **interactive** only while we are boarded, so a
  squadmate's loadout can only be inspected from inside our own pod. That is deliberate (the alternative steals the
  mouse look from a player walking the ship), but it also means the `'ready'` blocker is up while boarded — and
  `inventory/`'s Tab gate is `ctx.uiBlockers.size === 0`, so **Tab no longer opens the ship screen while boarded**.
  One line in that gate (ignore `HUB_READY_BLOCKER`) would restore it.
- Portrait viewports are assumed to be four equal columns left→right; the row uses `gap: 0` so the cells line up.
  A `PortraitRef` that lays its viewports out differently would drift from the cells.
- A peer's cell shows `Lv. —` (no chip) and no implant until their `crew card` arrives; nothing re-requests it after
  `CREW_LOADOUT_COOLDOWN_S`-throttled or dropped answers except opening the popup again.
- The 분대원 장비 popup renders whatever `createCrewLoadoutView` accepts; a peer running an older build (no
  `crew loadout` answer) shows `장비 정보를 받지 못했습니다` after 5 s.
- `HousingMode` keeps a defensive relock on exit even though the lock is never released, because Chrome drops it on
  every Escape and the software cursor silently falls back to mirroring the real one in that state.
- Rooms 6–10 now read with the door at the **top** while rooms 1–5 keep the door at the **bottom** (both share one
  world→screen mapping, which is what the 180° complaint was about). Flipping the port group instead would need the
  smoke's port-cursor expectations rewritten.

## Phase 11 (2026-09-07) — 행성 선택 · 전체화면 터미널 · 이동 컷씬

The terminal stopped being a 680 px card. It is now the ship's **행성 선택** screen: the matchmaking sections moved
into a left column, the centre is a live **행성 홀로그램**, and 시뮬레이션 훈련장 + the `/seed` hint sit bottom-right
over the 닫기 (Esc) / 타이틀로 footer.

- **`ui/HubMenu` full screen** (`.fullscreen` + a `.hub-grid` of three `.hub-col`s in `hub.css`). Behaviour of every
  existing section is unchanged (that is why `smoke-training`'s `.hub-section` / `.crew-row` selectors still pass).
  The **승무원 이름 section is gone** — `ui/menus/TitleMenu` already owns the one-time call sign, so the terminal no
  longer calls `net.setPlayerName` / `ctx.housing.lockCrewName()`. `hub:terminalToggled` joins `ui:hubMenuToggled`.
  Cursor etiquette is exactly Phase 10's: `'hub'` blocker → `setCursorMode(true, 'hub')`, never `exitPointerLock()`.
- **`ui/PlanetHologram`** — its own `THREE.WebGLRenderer` on a square canvas (`player/Portraits` precedent: the main
  composer has no post-render hook). Procedural only: the hub's `Planet` in the def's hologram colours inside a wire
  cage, two additive rings and a scanline grid. Two slots cross-slide over `PLANET_SWAP_TIME`; the render loop is
  gated on the terminal being open, and a missing second GL context degrades to `.no-holo` + the text card.
- **`HubSystem` planet state.** `HubRef.planet` is a **getter**: `ctx.net.lobbyPlanet` in a lobby, else the local
  pick restored from / saved to `PLANET_STORAGE_KEY`. `setPlanet` + `travelBlockReason` + `startTravel` /
  `finishTravel` / `applyPlanetLook` are described in the Flow table above.
- **`DockingCutscene` `'travel'`** + the new `interiors/WarpStreaks`: our own hull from behind, stars stretched to
  `HUB_TRAVEL_WARP_STRETCH` for `HUB_TRAVEL_WARP_FRACTION` of the run, then the destination sphere resolving. The
  ship interior is never rebuilt for a planet change — `Planet.setColors` re-tints the window planet in place.
- **Launch-slot gate**: no 목표 행성 → the pod prompts `목표 행성 미지정 — 터미널에서 지정` and refuses; the terminal
  screen carries a `목표 <행성>` line (`목표 미지정` / `<행성> 이동 중` while travelling).

### Known follow-ups (Phase 11)
- A **first** pick plays the full `HUB_TRAVEL_DURATION` warp even though the ship was not orbiting anything before
  it, so a brand-new profile spends 4.5 s in a cutscene before its first launch. Deliberate (the warp is the feature),
  but it is also why a fresh profile cannot board a pod until it has visited the terminal once.
- `podBlockReason` keeps `canInteract()` **true** while boarding is refused (training / no planet) so the prompt is
  visible at all — `ctx.interactables.findBest` filters on `canInteract`, and the plan's literal "add `planet !== null`
  to `podCanInteract`" would have hidden the very message it asks for. The refusal itself lives in `boardPod`.
- The travel cutscene keeps the phase at `'hub'` and returns early from `update()`, so the interior's own `update`
  (자동문, room lights, star drift) is frozen for those 4.5 s. Nothing is visible — the camera is on the stage 900 m
  up — but a future in-ship travel shot would need that loop back.
- `WarpStreaks.setStretch` quantises its buffer write (`STRETCH_STEP`), so the stretch ramp is visibly stepped if the
  constant is ever lowered; and the field wraps by its whole span once per cutscene rather than per-streak.
- The hologram is a **second GL context**. With the READY panel's portrait canvas that makes three contexts in the
  ship; browsers cap them (~16), but a machine that refuses one falls back to `.no-holo` silently (console warn only).
- A non-host sees `호스트만 지정할 수 있습니다` on the button but can still step the hologram — that is intentional
  (looking at where the squad is going), yet there is no visual that the preview is not the squad's target beyond the
  green `현재 목표` tag / dot.
- `scripts/smoke-training.mjs` now seeds `localStorage['scav.planet']` at boot; `scripts/e2e-multiplayer.mjs` needs the
  host to pick a planet before `boardPod` for the same reason (owned by the net / server lanes).

## Verified — Phase 11 (2026-09-07, headless Chrome on the GPU, own vite, no relay)
- **`scripts/smoke-planets.mjs` 76/76, 0 console errors** (solo path; the lobby path is `e2e:mp`'s). 목표 미지정 state
  + terminal screen + pod prompt / refusal; the full-screen terminal (three columns, frame = viewport, no scroll
  overflow, 신호 left / 행성 centre / 훈련장 right, **no 승무원 이름**, `.seed-hint` kept, `닫기 (Esc)`, `'hub'`
  blocker + software cursor + lock kept, `hub:terminalToggled`); the hologram canvas (square, own context, no
  `.no-holo`) and its ◀ ▶ / `←` `→` / `A` `D` stepping incl. wrap-around, preview-only and no `hub:travel`;
  행성 이동 → `hub:travel start`, terminal self-closed, phase still `hub`, cutscene + `HubWarpStreaks` + one
  destination sphere, interior **not** rebuilt, status line, pods locked, `setPlanet` refused mid-travel → `hub:travel
  end` + `hub:planetChanged {by:'local'}`, cutscene disposed, controls back, `scav.planet` written, window planet
  re-tinted, terminal screen line, slot opened; refusals (same planet / unknown id) and the reopened terminal showing
  `현재 목표`; reload persistence with **no** cutscene; launch → `game:newMission {planet, mode:'raid'}` with
  `ctx.missionPlanet` already set.
- **`scripts/smoke-training.mjs` 109/109** (one line added at its boot: the profile now needs a 목표 행성 before a pod
  will take it) and **`scripts/smoke-ship-rooms.mjs` 70/71** (the one failure is the no-relay WebSocket console error).
  `scripts/smoke-controls-hub.mjs` 75/77: its two failures are the no-relay console error and
  `mouse LMB / RMB / MMB lit (6)` — `ui/menus/SettingsMenu` now builds a **second** `ControlsPanel`, so that smoke's
  document-wide `.ctl-mouse-svg .btn.bound` selector counts both. Both belong to the `ui/` lane, not here.
- `npm run typecheck` 0 errors.

## 2026-09-07 UI/UX pass — 기업 네트워크가 Tab 창으로

- `hub_computer`(함선 컴퓨터) 의 `E` 는 그대로 `ctx.meta.openCorpMenu()` 를 부르지만, 기업 화면에는 이제 전용
  오버레이도 `'corp'` blocker 도 없다 — meta/ 가 `ctx.inventory.openScreen('corp')` 로 **Tab 창을 기업 탭으로**
  연다. 성공 판정은 예전과 같이 `meta.isMenuOpen`(= 창이 기업 탭을 보여주는 중)이다.
- **Escape**: 기업 화면이 떠 있는 동안 hub/ 는 Escape 를 건드리지 않는다 — 그 창은 inventory/ 의 것이고 blocker 도
  `'inventory'` 하나다. 예전의 `corpWasOpen` 한 프레임 스왈로우 규칙은 삭제했다.
- `stationUsable()` / `onPointerLockChange` 는 이미 `ctx.inventory.isOpen` · `uiBlocked()` 로 같은 상태를 보고
  있어 그대로 둔다.


## 2026-09-08 — the hub stops reading Escape

`HubSystem.update` no longer polls `Keys.MENU` at all. Escape falls straight through to `game/`, which puts the
일시정지 메뉴 over whatever is open (see `game/README.md` for why). Everything here closes on the key that opened it:

- **`Keys.INTERACT` (E)** steps out one level, in the old Escape order: 정비 벤치 menu → 함선 터미널 → 분대원 장비
  popup → un-board the pod. `HubSystem` updates **before** `PlayerSystem`, so the E that *opens* one of these is
  polled here while it is still closed — one tap can never open and close it in the same frame. The un-board branch
  keeps `UNBOARD_GRACE`, so an E aimed at the popup and a following E aimed at the pod need ~0.6 s between them.
  Typing in the terminal's 도킹 코드 field never reaches `Input` (`ui/dom.isolateInput` stops it at the field), and
  that field's Escape now only **blurs** instead of closing the terminal.
- **`Keys.MAP` (M)** both enters 함선 관리 and, in `HousingMode.update`, leaves it (C with an empty cursor still
  leaves too). The `ui/hud/HousingHint` exit chip names M.
- The terminal footer reads **닫기 (E)**.
- E is ignored while `MENU_BLOCKER` is up, so it cannot reach through the pause menu.

## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`HubSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `HubSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: HubSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `HubSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-08 (하우징 모드 취소 = Escape)** — `HousingMode` 가 `Keys.MENU` 를 **먼저 먹고 모드를 빠져나온다**
  (들고 있는 가구 · 고른 가구가 있으면 C 처럼 그것부터 되돌린다). 전역 규칙은 "Escape = 일시정지"지만 예외가
  "가장 안쪽이 먼저 먹는다"이고, 하우징 모드는 카메라와 조작을 통째로 가져간 **모드**라 그 위에 일시정지 메뉴가
  쌓이면 어느 쪽을 닫는 건지 알 수 없었다. `HubSystem` 은 `GameFlowSystem` 보다 먼저 도므로 `input.consume` 이면
  충분하다. 터미널에서 `자동 매칭은 …` · `임무 시드는 …` 안내 두 줄을 지웠다 (당연한 설명은 화면에 두지 않는다).

- **tactical kit** — terminal is ship-only again (2026-09-06: the 임플란트 / 정비 tabs and their panels are gone — implants / repairs live on the Tab ship screen; frame `overflow: hidden`, no scrollbars) + 캐릭터 button (`ui:statsToggled`), hydroponics `GardenStation.ts`, implant bay interactable → `ctx.inventory.toggleBag()`, station geometry in `interiors/stations.ts`

- **Phase 6** — personal ship rebuilt as **cockpit → corridor → 10 rooms → airlock** (`interiors/RoomLayout.ts` single source of coordinates, `roomAtWorld`, `roomCellToWorld`), `currentRoom` + `hub:roomEntered`, room consoles `hub_room_<i>` → `housing.openRoomMenu`, `hub_facility` → `openFacilityMenu`, `interiors/Furniture.ts` procedural furniture per `FurnitureModelKind` + `FurnitureLayer` (collider blockers, `Lv.n` signs, `hub_furn_<uid>` → `inventory.openBenchCraft` / `housing.openPresetMenu`), `HousingMode.ts` (top-down camera, pointer-locked cursor, ghost, LMB place / R rotate / X recover / wheel select / Esc), terminal seed field removed (`setMissionSeed` console-only), 10 constant lights

- **Phase 5** — `Computer.ts` — ship computer desk (`stations.shipComputer`, both ships) with `Interactable` `hub_computer` `기업 네트워크` → `ctx.meta.openCorpMenu()`, stations locked while the corp screen is open, terminal screen `크레딧 n` line

- **Phase 7** — `sim_hub` furniture model (holo pedestal + spinning rings) → `startTraining()` (solo `game:newMission {mode:'training'}`, lobby `net.startGame(seed, 'training')` by any member, join a running training via `rejoinMission`), shared-ship terminal 시뮬레이션 훈련장 section (시작 / 합류 n명 / 임무 진행 중), pods locked with `훈련 진행 중 — 터미널에서 합류`, return from a training without a docking cutscene

- **Phase 8** — terminal moved to the **cockpit centre** (no 캐릭터 button, one-time 승무원 이름), the cockpit 정비 벤치 and 수경 재배 rack are gone (`furn_repair_bench` / `furn_grow_rack` furniture instead), `interiors/Doors.ts` **자동문** (`DOOR_OPEN_DISTANCE` / `DOOR_SLIDE_SPEED`, no colliders), per-room strip materials + a constant `ROOM_LIGHT_POOL` that re-anchors to non-empty rooms (empty rooms stay dark), **M** → `ctx.housing.openShipManage()`, housing mode runs **unlocked** in 함선 관리 (blocker `shipmanage`, camera-ray floor cursor, `#ui-root` clicks swallowed, **C** cancels), Esc no longer opens the terminal and consumes itself

- **Phase 8 UI pass** — the room door consoles (`hub_room_<i>`) and the cockpit 함선 시설 console (`hub_facility`) are removed, geometry included, `HousingMode` releases its `shipmanage` blocker on **every** exit path (the Esc bug: camera back but no controls / no hint) and **C** with an empty cursor leaves the mode like Esc

- **Phase 9** — `bookshelf` furniture model (shelves + one spine per shelved book, colour by rarity, rebuilt on `housing:booksChanged`) and the `onBookshelf` callback → `ctx.housing.openBookshelfMenu(uid)`

- **Phase 9 UI/UX 개선** — `net:resumed` 는 훈련장을 임무로 보고하지 않는다 (재접속 시 `분대가 임무 중` 대신 터미널 합류 안내). **Phase 9 UI pass**: 조종석 정리 — the console-pedestal terminal is gone (the dashboard's centre monitor **is** `terminal.screen`; 항법 / 통신 readouts dropped), the **함선 컴퓨터** moved from the +X wall (pod-prompt clash) to the port rear wall replacing the lockers that overlapped the bunk, the stash cabinet moved starboard, door frames stand clear of the wall slab and `Parts.walls` splits the waist-high wainscot band around every doorway; `HousingMode` **glides** the camera between rooms (`glideCamera`, `update(dt)`)

- **Phase 10** — **발사 준비 패널** (`ui/ReadyPanel.ts` — four horizontal cells shown as soon as a launch slot fills, each drawing that member's character from one `ctx.player.createPortraits` canvas through four viewports at `HUB_READY_PORTRAIT_YAW`; an un-ready member's cell draws no character; name + `Lv. n` top-left, equipped implant on the right; right-click → `ui/CrewLoadoutPanel.ts`, a hub-owned modeless frame hosting `inventory.createCrewLoadoutView` — `HUB_READY_BLOCKER` + cursor mode, and the Esc / E un-board paths plus `onPointerLockChange` now ignore that one token), **crew-card sending** (`crew card` to `others` on `hub:entered` in the shared ship and on level / implant / armor / loadout changes, debounced by `CREW_CARD_MIN_INTERVAL_S`; `crewq sync` on arrival; `crewq loadout` answered with `crew loadout` per `CREW_LOADOUT_COOLDOWN_S`), and the **housing camera fix** — rooms 6–10 no longer flip (the `rb.side` factor is gone from both `camGoal` and the locked-cursor mapping, so every room reads with its door at the top)

- **Phase 11 (2026-09-07)** — the terminal is **full-screen** (`.fullscreen` · 좌 매치메이킹 / 중앙 행성 카드 / 우 훈련장 + 닫기 (Esc), 승무원 이름 섹션 삭제 — 호출명은 타이틀 화면 전용, `hub:terminalToggled`), `ui/PlanetHologram.ts` (자체 `WebGLRenderer` · `Starfield.Planet` 재사용 + 절차적 와이어 케이지 · 링 · 스캔라인, `PLANET_SWAP_TIME` 크로스 슬라이드, 닫히면 렌더 정지), `HubRef.planet / setPlanet / travelling` (로비면 `net.lobbyPlanet`, 솔로면 `PLANET_STORAGE_KEY`; 호스트 전용), `startTravel` → `DockingCutscene` `'travel'` + `interiors/WarpStreaks.ts` (**내부를 재생성하지 않는다** — 창밖만 바뀐다) → `hub:travel` / `hub:planetChanged`, 비호스트는 `net:lobbyUpdated` 로 미러, 발사 슬롯은 `podBlockReason` 으로 `목표 행성 미지정 — 터미널에서 지정` (`canInteract:false` 로 막으면 `findBest` 가 프롬프트 자체를 숨긴다), `launch()` 가 행성을 실어 보낸다

- **2026-09-07 UI/UX pass** — `hub_computer` 의 `E` 는 여전히 `ctx.meta.openCorpMenu()` 지만 그 화면은 이제 Tab 창의 기업 탭이라 `'corp'` blocker 가 없고, 기업 화면이 떠 있는 동안 hub 는 **Escape 를 건드리지 않는다** (`corpWasOpen` 한 프레임 스왈로우 삭제)

- **2026-09-07 (안정화)** — 복도 징두리 트림을 **문마다 끊어서** 그린다(허리 높이 노란 선이 방 문을 가로지르던 문제), `HousingMode` 의 커서가 방 밖을 가리키면 셀 프레임 · 고스트 · 설치/회수를 모두 끈다(`cursorInRoom`), `onResumed` 가 진행 중인 **레이드에 자동 재투입**한다(`rejoinMission()`)

- **2026-09-08 (UI/UX)** — **출격 준비 경고** (`ui/LaunchWarnPanel.ts`): 발사 슬롯에 타기 직전 주무기 · 탄약(구경별 한 세트) · 가방 · 방탄복 · 전술 임플란트 · 회복 아이템을 훑어 걸리는 것을 **전부** 보여주고 확인을 받는다. 판정은 `ctx.inventory.getLaunchWarnings()`(inventory 소유)가 하고 여기서는 그리기만 한다. 경고일 뿐 탑승을 막지 않으며, 한 번 넘긴 조합은 `HubSystem.launchWarnAck` 에 남아 다시 묻지 않는다

- **2026-09-08 (튜토리얼 게이트)** — `parts/Pods.podBlockReason`(탑승) · `parts/Interior`(터미널 `canInteract`) ·
  `parts/Planet.travelBlockReason`(행성)이 `ctx.tutorial?.blockReason()` 을 본다. `travelBlockReason` 은 이제
  **행성 인자를 선택적으로** 받는다 (`travelBlockReason(planet?)`) — 튜토리얼이 첫 번째 행성만 허용하므로
  어느 행성인지 알아야 한다. `ui/HubMenu` 는 미리보기 중인 행성을 넘기고(`travelBlock(d.id)`),
  `ctx.tutorial.hides('matchmaking')` 이면 **신호 · 공유 함선 섹션을 통째로 감춘다**

- **2026-09-08 (ESC = 항상 일시정지)** — 허브는 Escape 를 아예 읽지 않는다. E 가 정비 벤치 → 터미널 → 분대원 장비 popup → 포드 하차를 한 단계씩 되짚고(출격 준비 경고도 E 로 취소), 함선 관리는 M 으로 나간다. Escape 는 `game/` 으로 흘러가 일시정지 메뉴가 그 위에 쌓인다

- **2026-09-08 (커서 · 튜토리얼 숨김)** — `parts/Transitions.enter` 가 `hub:entered` 직후 부르던
  `ctx.input.requestPointerLock()` 을 **`sys.relock()`** 으로 바꿨다: 그 이벤트를 듣고 방금 커서를 잡은 화면
  (튜토리얼 시작 카드)에서 마우스를 도로 빼앗아 **카드를 클릭할 수 없었다**. `relock` 은 blocker 가 있으면
  요청하지 않는다 (`Input` 쪽에도 같은 가드가 생겼다 — `src/shared/README.md`).
  `ui/HubMenu`: `ctx.tutorial.hides('planet')` 이면 행성 **넘김 화살표 · 점을 감추고** 첫 번째 행성을 보여 준
  채로 연다 (`step()` 도 막는다). `tutorial:changed` 로 다시 그린다

- **2026-09-08 (공용 함선 격납고)** — 공유 함선 **뒤쪽 벽 한가운데가 4 m 자동문**이고 그 너머가 44 × 30 m
  **격납고**다. 격납고는 별도 인테리어가 **아니다** — `interiors/Hangar.ts` 가 `SharedShip` 의 같은 `GeoBatch` 와
  같은 `BoxInteriorCollider` 에 지어지므로 드로우콜이 늘지 않고, 바닥이 함선 방과 맞닿아 출입구가 **열린 공유
  모서리**가 된다(원격 아바타가 그대로 걸어 나온다). 바닥에는 로비 슬롯마다 슬롯 색 정박 구역이 네모로 그려져
  있고, 참여한 대원의 **개인 함선**이 착륙 다리를 펴고 한 대씩 서 있다.

  함선 **뒷문(램프)** 앞에서 E → 그 사람의 개인 함선 안으로 들어간다. 컷씬도 없고 **로비도 그대로다**:
  `parts/Transitions.boardShip` 이 인테리어만 `PersonalShip` 으로 갈아 끼우고(`swapDirect` 와 같은 모양),
  `sys.visit` 가 "지금 어느 함선 안인가"를 들고 있다. 나오는 길은 에어락의 `hub_hangar_exit` — 들어간 그 구역
  앞에 다시 선다(`build(..., fromBay)`).

  - **남의 함선은 둘러보기 전용.** `stationUsable()` 이 `visitReadOnly` 면 false 를 돌려주고, 방문 중에는
    **터미널 · 함선 컴퓨터 · 정비대 · 임플란트 시술대를 아예 만들지 않으며**(쓸 수 없는 상호작용이 레지스트리에
    남아 `findBest` 와 프롬프트를 다투는 것도 막는다), 가구는 그려지되 E 에 답하지 않고, 시설 관리(M)는
    한국어 사유와 함께 거절된다. 발사 포드도 없다 — 분대는 공유 함선에서 출격한다.
  - **남의 함선을 그리려면 그 사람의 배치가 필요하다.** 어떤 메시지도 그걸 나르지 않아서 `ship state`
    (`ShipVisitWire`: 방 용도 · 시설 레벨 · 배치 가구 · 꽂힌 책)를 새로 만들었고, 동작은 크루 카드와 **똑같다** —
    공유 함선 도착 시 한 번 뿌리고(+ 나머지에게 `shipq state` 요청), 내 함선이 바뀌면 `SHIP_VISIT_MIN_INTERVAL_S`
    로 디바운스해 다시 뿌리고, 요청에는 `SHIP_VISIT_COOLDOWN_S` 로 답한다. 창고 · 프리셋 · 도감처럼 **그릴 필요가
    없는 것은 보내지 않는다**. 렌더링은 `FurnitureLayer` 의 새 `FurnitureSource` 가 받는다.
  - **같은 함선에 있는 사람만 서로 보인다.** 모든 인테리어가 원점에 지어지므로 서로 다른 함선 안의 두 사람은
    좌표가 겹친다. `HubRef.hubSite`(공유 데크 = null, 그 외 = 함선 주인의 PeerId)가 `PlayerSnapshot.hs` 로 나가고,
    `player/RemoteAvatar` 가 값이 다른 아바타를 숨긴다. 같은 함선을 구경 중인 둘은 서로 보인다.
  - 검증: `scripts/smoke-hangar.mjs` (클라이언트 2대, 55개). `npm run verify` 의 hub · net · housing · player
    매핑에 들어 있다.
