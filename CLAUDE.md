# SCAVANGER — Project Command Center

Helldivers 2-inspired third-person extraction shooter in the browser. Three.js + Vite + TypeScript.
Arc Raiders-style minimalist UI, Diablo 2-style grid inventory, procedural maps. The game starts in a walkable
**personal ship** (hub); matchmaking docks the squad into a **shared ship**, and drop pods take it to a raid.
The relay server keeps a per-token **profile store** (credits · meta · stash · loadout · progression · ship) and a
**raid session store**, so a disconnected player can rejoin the raid. Single player without a server runs on localStorage.

> **This file is a navigation hub.** Before any task: ① find the owning folder in the folder map below,
> ② **read that folder's `README.md` first.**

---

## 1. Doc map

| Looking for | Go to |
|---|---|
| **Tune a number (balance)** | [data/README.md](data/README.md) — edit csv only, no code |
| **Which folder to change** | [3. Folder map](#3-folder-map) below |
| **How a folder is built** | that folder's `README.md` (files · public API · rules · last 5 changes) |
| **Why code looks the way it does / what breaks if violated** | the comment right above that code (source of truth); project-wide rules in [4. Stack & conventions](#4-stack--conventions) |
| **Every bug type at a glance** (Korean read-only summary — csv is still the source) | [ENEMY_BUGS.md](ENEMY_BUGS.md) — stats · nest rules · artillery · sandworm · per-planet mix |
| System registration order · mission flow · UI blocker / cursor rules | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Multiplayer topology · wire contract · host authority | [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md) |
| Default key layout · rebinding rules | [docs/CONTROLS.md](docs/CONTROLS.md) |
| Verification procedure · known flaky smokes | [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| What each script checks | [scripts/README.md](scripts/README.md) |
| **When / what / why something changed** | `git log` — **commit messages are the source** (`git log -- src/<folder>`, `git log --grep '<keyword>'`) |
| **Work to do** | [docs/TODO.md](docs/TODO.md) (Korean) — to-do only; an intended limit lives in the owning folder's `README.md` |
| Completed phases | [docs/HISTORY.md](docs/HISTORY.md) |
| What the user chose and what was rejected | [docs/DECISIONS.md](docs/DECISIONS.md) |
| **Investor / publisher wiki** (HTML, no build, public at **https://toniqat.github.io/Scavanger/**) | [docs/pitch/README.md](docs/pitch/README.md) → `docs/pitch/index.html`; page order · file numbers · section numbers come from `TREE` in `docs/pitch/app.js`; `node scripts/smoke-pitch.mjs` catches breakage |

---

## 2. Commands

```
npm run dev        # http://localhost:5273 (single player works without a server)
npm run server     # WebSocket relay (ws://localhost:8787/ws, GET /health)
npm run dev:all    # relay + vite together (vite proxies /ws → 8787)
npm run typecheck  # tsc --noEmit — must pass before finishing (server: typecheck:server)
npm run data:check # data/*.csv schema check; `-- --write` re-bakes server/economy.gen.json after economy changes
npm run build

npm run app:build  # desktop (Electron) build: vite dist/ + main process dist-electron/
npm run app        # run the built desktop app (local http; no address → this PC's start-server.bat relay)
npm run app:dist   # full deploy folder release/SCAVANGER/ (3 entries, no server)
npm run icon       # redraw electron/resources/icon.ico from code (--png = preview)

npm run verify     # after a feature: typecheck + selftest + smokes mapped to touched folders (4 lanes)
node scripts/verify.mjs --dry-run   # what the current change would run, and why — runs nothing
npm run verify:all # end of a work session / before merge: everything + build + e2e:mp (~17 min; --jobs 4 default)
npm run net:selftest   # relay protocol self-test (no browser)
npm run e2e:mp         # two headless Chromes through relay + vite

npm run pitch:webp             # pitch wiki images png → webp
node scripts/shots-pitch.mjs   # pitch screenshots (needs npm run dev)
node scripts/smoke-pitch.mjs   # pitch wiki pages load (links · sidebar · nextnav · card flip)
node scripts/smoke-desktop.mjs # real Electron shell (--hidden · temp userData · window 8820); --release = deploy folder
```

`npm run verify` picks smokes by folder (`node scripts/verify.mjs --list`); a `data/<file>.csv` change picks the folders that
consume it (`scripts/data-owners.mjs`). A **narrow** `src/shared` change (≤ 2 code files and ≤ 3 feature folders) picks the folders
that use the changed exports instead of going full; anything wider, or `src/core` · `main.ts` · `vite.config` · `package.json` ·
`tsconfig`, still selects everything. `--dry-run` prints the selection and its reason without running. Unknown options / `--help`
print help and run nothing. Several runners in one tree: `--log-dir scripts/logs/<name> --keep-relay`.

**Deploy folder** (`npm run app:dist`, ship it zipped): exactly `app/` (Electron build) · `SCAVANGER.exe` (stub launcher,
`electron/launcher.cs`) · `server.txt` (server address, the only file a receiver edits). **Builds ship no server**: a server
runs only from this repo via `start-server.bat`. Receivers enter the host's address in `설정 › 서버 설정` (overrides
`server.txt`); with no address the app connects to this PC's `ws://127.0.0.1:8787/ws`. Details: [electron/README.md](electron/README.md),
[server/README.md](server/README.md).

Hosting (repo root): `start-server.bat` (npm install if needed → `npm run dev:all`) · `start-server.bat relay` (relay only,
0.0.0.0:8787). It prints the LAN address, and its window is the operator console (`server/Console.ts`): `list` · `lobbies` ·
`kick <id> [reason]` · `max <n|off>` · `gc` · `help`. Profiles live in `server/data/` (`--data=` to point elsewhere). The bat file
is saved as **CP949** — UTF-8 + `chcp 65001` breaks cmd label scanning.

---

## 3. Folder map

Each README holds the folder's files · public API · rules · last 5 changes. **Read it before changing the folder.**
Rows state **responsibility only** — no dates or change notes (those go in commit messages). Edit a row only when the
folder's responsibility changes.

### 3.1 Contracts · engine

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`data/`](data/README.md) | — | — | **Single source of game numbers**: csv for damage · hp · prices · chances · cooldowns · weights · recipes · loot · planets · NPC/quest text. `src/` holds no copies |
| [`src/shared/`](src/shared/README.md) | — | `GameContext`, `EventBus`, `Input`, `Random` | **The contract — read first.** Types · events · constants (values from `data/`) · keybinds · csv loaders · every `*Ref` · pure formulas used by 2+ folders (ballistics, explosion falloff, ride math, loot seeds, intel cost) · shared UI bits (keycap, hold confirm, currency chip) · save slots · ESC stack · light pool |
| [`src/core/`](src/core/README.md) | `Engine` | scene / camera / renderer / `ctx.shaders` · `ctx.outline` | Renderer · lights · sky · fog · post-processing · screen-space outline · main loop · resize · system registry · fixed point-light count (`LightBudget`) · shader pre-compile hold (`ShaderWarmup`) |
| [`src/main.ts`](src/main.ts) | — | — | Engine bootstrap + system registration order, cursor-mode ↔ bus bridge, the **only** pointer-lock re-request site |

### 3.2 Player · combat

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`src/player/`](src/player/README.md) | `PlayerSystem` | `ctx.player` | Third-person controller · camera rig (shoulder swap, aim sway) · procedural soldier · hp/shield/stamina/downed · damage sources · fall damage · stance · interaction · ladders · tram/rover riding · drone-control mode · furniture poses · intro wake · scene lock · character buff list · remote avatars · drop pods · face portraits (`snapshotFace`) |
| [`src/weapons/`](src/weapons/README.md) | `WeaponSystem` | — | 2 primary slots · effective stats · durability · ammo · hybrid shot resolution (crosshair line + 3 m muzzle block) · swept projectiles · recoil/spread · grenades · throw arc · melee · quick-use wheel · healing/combat consumables · legendary uniques · remote replay |
| [`src/implants/`](src/implants/README.md) | `ImplantSystem` | `ctx.implants` | 5 tactical implants (grapple · dash · barrier · overcharge · recon), Q key · cooldowns · refunds |
| [`src/gadgets/`](src/gadgets/README.md) | `GadgetSystem` · `DroneSystem` | `ctx.gadgets` · `ctx.drones` | Consumable gadgets — placement preview · mines · remote mines · turret · dome shield · barricade · jump pad · fire zones (host-authoritative) · ground/air drones (owner-authoritative control and scan) |
| [`src/stratagems/`](src/stratagems/README.md) | `StratagemSystem` | `ctx.stratagems` | 4 ship calls — G wheel · top-down aim · shared cooldown · rescue drop (5 per squad); squad calls relayed by the host, denials fully refunded |
| [`src/allies/`](src/allies/README.md) | `AllySystem` | `ctx.allies` | Android squadmates — roster (relay bot members · `/android` cheat) · cockpit bay / pod behaviour in the ship · host-simulated raid AI (reaction-delay FSM, leader harness, cover combat, looting, deliveries, extraction, rescue) · `ally` sync. Builds no meshes (`player/` draws the bodies) |

### 3.3 World · enemies

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`src/world/`](src/world/README.md) | `WorldSystem` | `ctx.world` | Procedural terrain · biomes · props (convex-hull colliders) · collision/ray/surface queries · crates · gather nodes · fog of war · abandoned structures (floors · stairs · roof · locked doors · windows) · rails/trams · rover · hazards · site spawn points · intel layout preview · training range · tutorial planet |
| [`src/enemies/`](src/enemies/README.md) | `EnemySystem` | `ctx.enemies` | Bugs · humanoid factions (android · rogue · raider) AI · spawns/site occupation/drops · named rogues · sandworm · artillery · corpse looting · status effects · enemy explosions · reactions to shots · host/replica sync + request guards · tutorial enemies |
| [`src/extraction/`](src/extraction/README.md) | `ExtractionSystem` | `ctx.extraction` | Extraction console · call countdown · ship landing (hull colliders, enemy entry block) · boarding · non-cancellable grace · liftoff cinematic; host-authoritative |

### 3.4 Items · inventory · meta

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`src/items/`](src/items/README.md) | (data) | — (`ctx.loot` is published by inventory) | Item defs (weapons · ammo · attachments · bags · armor · consumables · materials · meals · library media · samples …) · effective weapon stats · loot/corpse tables · craft/salvage/repair economy · item spec text |
| [`src/inventory/`](src/inventory/README.md) | `InventorySystem` | `ctx.inventory` · `ctx.loot` | Grid model · bag/equipment/quick/pouch/implant slots · ship stash · container looting · sockets · craft/salvage/repair UI · favourites · tooltip pin · strip-to-corpse · Tab screen |
| [`src/pickups/`](src/pickups/README.md) | `PickupSystem` | `ctx.pickups` | World-dropped items (throw arc · procedural mesh · host-authoritative sync) |
| [`src/meta/`](src/meta/README.md) | `MetaSystem` | `ctx.meta` | 4 corporations · reputation · credits · shop/trade desk · contracts · implant repair desk · NPC quest engine (messenger) · NPC trust · intel purchase |
| [`src/progression/`](src/progression/README.md) | `ProgressionSystem` | `ctx.progression` | Level/XP · 5 stats · 16 skills · derived stats `derived` (meals · library · training · implants fold in here) · prep/meal lifetimes · implant slot rules · character sheet · per-slot profile persistence |
| [`src/housing/`](src/housing/README.md) | `HousingSystem` | `ctx.housing` | Ship decoration rules · room purposes · generator/storage · furniture placement (access faces) · greenhouse/analyzer/culture tank · cooking minigames · dining-table plates · gym/video games · library series effects · crypto mining · music player state · `ShipState` persistence |

### 3.5 Shell · flow · presentation

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`src/hub/`](src/hub/README.md) | `HubSystem` | `ctx.hub` | Personal/shared ship interiors · hangar · docking cutscene (squad dock countdown · fade) · window warp · launch pods/slot readiness · full-screen terminal (행성 tab: planets · intel · training; 매칭 tab: squad portraits · invites · private/public docking) · furniture models and staging (gym · cooking · games) · ship management mode · light pool |
| [`src/game/`](src/game/README.md) | `GameFlowSystem` | `ctx.phase`, `ctx.corpses`, `ctx.raidResume` | Phase state machine · death/corpses · squad-leader device · raid session save/resume (solo clock defence · tutorial resume · title `이어하기` / `레이드 포기`) · resume gate · ESC policy · voluntary return · result-screen data |
| [`src/ui/`](src/ui/README.md) | `HudSystem` | — | All DOM UI — raid/ship HUD · crosshair · danger indicators · map (fog) · pings · chat · messenger · menus (title · character · ESC · settings) · result screens · key guide · item tooltips · stylesheets · **sole owner of toasts** |
| [`src/audio/`](src/audio/README.md) | `AudioSystem` | `ctx.audio` | Procedural WebAudio SFX + ambience · distance curves · per-surface footsteps · volume persistence (`bgm` channel is storage/display only) |
| [`src/tutorial/`](src/tutorial/README.md) | `TutorialSystem` | `ctx.tutorial` | New-character guide, 4 tracks (raid · ship · build · raid2) — objective panel · spotlight · control guide · order gates · per-track skip |
| [`src/console/`](src/console/README.md) | `ConsoleSystem` | `ctx.console` | Dev console + cheats (**dev hosts only** — no DOM, no key elsewhere) |

### 3.6 Network · deploy

| Folder | System | Publishes on `ctx` | Responsibility |
|---|---|---|---|
| [`src/net/`](src/net/README.md) | `NetSystem` | `ctx.net` | Relay WebSocket client · session token · lobby · 20 Hz snapshots · profile document sync (revisions · write queue) · social · private chat · group rooms · char-buff wire · crypto quotes · link state · server address |
| [`server/`](server/README.md) | (Node) | — | `ws` relay — lobbies · squads (docked / not yet docked) · 5-min reconnect grace · host transfer · profile/raid/social/room stores (`.bak` · GC) · credit reason validation · crypto market · operator console (`Console.ts`, run by `start-server.bat`) |
| [`electron/`](electron/README.md) | (Electron main) | — | Desktop shell — `dist/` over local http + `/ws` proxy (**no server**; no address = this PC's 8787) (**window port 8790 fixed = save origin**) · deploy folder · stub launcher · icon |

---

## 4. Stack & conventions

Each rule is the short form; the reason lives in the comment at the pointed code. Change a rule here only together with that code.

### 4.1 Code · data · docs

- Three.js 0.185, TypeScript strict, ES modules, alias `@/` → `src/`.
- **No numbers in code.** Damage · hp · prices · chances · cooldowns · weights live in `data/*.csv`; TS only maps them to types. New number → csv row first. csv is inlined at build via `import.meta.glob(..., '?raw')`.
- **No external asset files.** Every model, icon and texture is generated in code (Three.js geometry, CanvasTexture, shaders; icon: `scripts/make-icon.mjs`).
- All HTML UI is DOM under `ctx.uiRoot` (`#ui-root`), styles in `src/ui/styles/`. No React. In-game text is **Korean**.
- **Docs language: English** for `CLAUDE.md`, every folder `README.md` and `docs/*.md` except `docs/TODO.md` (Korean). Code comments and in-game text stay Korean. Keep identifiers, csv keys, event names and Korean UI strings verbatim in backticks.
- `src/shared/*` is add-only (no renames/deletes) — every folder depends on it. Documented exception: `ItemCategory` `'grenade'` was removed on 2026-09-15 (loot rolls use a separate `LootCategory` axis — `src/items/LootTables.ts`).
- Cross-folder: bus events for messages, `ctx.*Ref` for sync queries. **Never import another feature folder's internals — `@/shared` only.** Accepted library-like exceptions (don't add new kinds): engine helpers `@/core/fx` and `@/core/util/MathUtil`; the `@/items` barrel (item data — inventory, weapons, ui); the `@/player` barrel for `SoldierModel` (`game/Corpses.ts`, `ui/menus/SoldierPreview.ts`).
- The same formula in two folders moves to `src/shared` (e.g. `shared/ballistics.ts`, `shared/explosion.ts`, `shared/lootRolls.ts`, `shared/keycap.ts`).
- Big system files split into `model.ts` (vocabulary, no state) + `parts/*.ts` (functions taking the system as `sys`); the class keeps one-line delegates so call sites never change; `parts/` imports only types from the system file.
- Reuse `THREE.Vector3` scratch objects; no per-frame allocation on hot paths. Dispose own geometries/materials on `game:abort` / `game:newMission`.
- CSS class prefixes are unique per folder — `node scripts/check-css-prefixes.mjs` (inside `verify`) fails a build that gives one prefix two folders; a deliberate cross-folder override goes in that script's `SHARED` with its reason. Never reuse a HUD widget class name as a modifier (`.kc-hold`, not `.hold`).
- Removing an item def → add a row to `data/item_aliases.csv` (saves resolve through `resolveItemAlias`). Retiring content → `ItemDef.retired` / `FurnitureDef.retired`, never delete the row (refunds and old saves need it).

### 4.2 Input · screens · UI

- Read keys at use time (`Keys.X`), never cache in module constants — `docs/CONTROLS.md`.
- **Pointer lock:** a lock lost right after acquiring is a bounce, not Escape (`LOCK_BOUNCE_GRACE_MS`); a relock requested during/just after Escape or a user exit is deferred and sent once (`LOCK_ESCAPE_DEFER_MS`, `LOCK_USER_EXIT_COOLDOWN_MS`, `deferredRelock`) — `src/shared/Input.ts`. `src/main.ts` is the only relock site.
- **Escape closes the topmost screen**, else opens pause. Screens `ctx.escape.push(token, close)` next to `uiBlockers.add` — `src/shared/escape.ts`; policy only in `src/game/parts/Phases.ts` (`escapeKey`). Innermost popups swallow Escape in capture. The pause menu itself closes on ESC only in the desktop shell (`isDesktopShell()`).
- A **cutscene owns the screen**: what can be closed is closed before it (`hub/parts/SquadDock.cancelEverything`), and a popup that
  cannot be closed (closing it would move its own state) **hides** instead — DOM · blocker · cursor · hold gauge — and comes back
  unchanged when the cutscene ends. Subscribe with `shared/cutsceneHide.ts` `watchCutsceneHide` (docking · window warp · liftoff).
- **Tab is the universal close key** (consume `Keys.INVENTORY`); open screens publish `ui:keyGuide {owner, keys}` and the guide appends `닫기` itself in its own panel right of the screen's keys (`.kg-panel-close`) — `src/ui/hud/KeyGuide.ts`.
- Irreversible confirms need a 1 s hold (`UI_HOLD_CONFIRM_S`); Enter never confirms; Escape cancels; initial focus `취소`. With nothing to lose (in the ship) title/quit use a tap (`tap` in `src/ui/menus/PauseMenu.ts`).
- Pause menu position is fixed (left half, `.menu.pause`); settings are centred. Hidden `.menu` has `pointer-events: none` so fading screens never eat clicks (`src/ui/styles/base.css`).
- Held keys show a chevron via `.keycap.kc-hold`; every keycap goes through `src/shared/keycap.ts` (`paintKeycap`, text tokens `{ACTION}` / `{ACTION:hold}`; rebind-independent inventory gestures use the fixed tokens `{MOUSE_LEFT}` / `{DOUBLE_CLICK}` — `KEYCAP_FIXED_TOKENS`).
- Rewards are **currencies** (`data/currencies.csv`, `shared/currency.ts`, `buildCurrencyChip`), never fake item defs.
- Toasts are owned by `src/ui` only; other folders emit events. Right-side toasts start below the tutorial control panel while it shows (`ui/hud/Notifications.update`, DOM `.tut-controls`). NPC messenger arrivals never toast — the messenger button's red dot pops (`ui/hud/Community`).
- The ship messenger button (with its `Keys.INVITE` keycap) stays usable over the Tab window and the pause menu; its panel draws above them, and while `COMMUNITY_BLOCKER` is held those menus ignore Tab/Escape — `ui/hud/Community`, `ui/menus/PauseMenu.handleKey`, `InventorySystem.update`.
- Results screens return to the ship with `ui:shipReturn` (fade → loading gauge until the ship compiled → fade in), never a bare `hub:enter`; while it holds the black screen `ui:screenFade` / `game:abort` / `hub:entered` don't clear it — `ui/menus/ShipReturn.ts`.
- Screen projection (`Vector3.project`) happens in `HudSystem.lateUpdate` after `camera.updateMatrixWorld()`.
- Map marker angles: canvas x = world X, canvas y = world **+Z**, never flipped. Math-convention bodies (tram · rover, local +X → `(cos yaw, sin yaw)`) draw with `c.rotate(yaw)`; third-person bodies are converted at the call site (`atan2(-cos yaw, -sin yaw)`) — `ui/map/mapIcons.ts`. Mixing the two silently mirrors the icon.
- Danger HUD: one indicator per hazard — off-screen arc or on-screen marker; colour = owner, `hot` = imminent; no fog gate — `src/ui/hud/DangerIndicators.ts`.
- Story-carrying fades are stepped in code, not CSS transitions (reduced-motion clips transitions to 0.01 ms) — `HudSystem.stepScreenFade`.
- Descriptions never repeat numbers the tooltip already shows (armor shield, bag cells).
- Scrollbar colours: `--sb-*` in `src/ui/styles/base.css` (inventory.css references them with fallbacks).
- Ship Tab is stash | equipment | bag joined into one panel (`--inv-panel-gap` seams; the stash is its own `.inv-layout` card) — `src/inventory/ui/InventoryUI.ts`, `inventory.css`; other folders' screens use `TradeGrids` (stash left, bag right, one card). Every grid pane scrolls/sorts/filters on its own. Bags are 5 wide; the frame is the tallest bag (`BAG_FRAME_ROWS`); padding rows are not drop targets. `모두 창고로 이동` moves bag-grid items only (`StashOps.moveBagToStash`).
- The liftoff cinematic hides **all** remaining HUD: crosshair instantly (`.hud.cinematic`), everything else by a code-stepped `--cine-o` + `filter: opacity()` under `#ui-root.hud-cine` (layers, key guide, item tip, music player, net badge, 3D pillars); tutorial DOM hides itself on `ui:cinematic`; menus, screen fade and loading gauge stay — `ui/HudSystem.setCinematic`, `ui/styles/raidHud.css`.
- Right-click = item menu, double-click = quick move (never silently displaces equipped items — `inventory/parts/DropResolver.tryAutoPlace`). Merge overflow stays on the cursor (`DragState.held`).
- Hold-to-pin screens use the `ui:cursorHold` ring (`src/ui/hud/CursorHoldGauge.ts`) and the escape stack.
- The hub terminal is two tabs (`행성` · `매칭`, `.scr-tabs` look); child screens own their tokens (`hub:trainConfirm`, `hub:invite`, `hub:intel`) and close first — `src/hub/ui/HubMenu.ts`. No lobby codes, links or public/private toggle in the UI.
- The 행성 tab's ◀ ▶ pager is a **preview**; everything that commits (정보 구매 above all) judges the **target** planet (`HubSystem.planet`). So 정보 구매 is disabled until the paged planet *is* the target, and a locked intel row names the target it was judged against — otherwise a row that is open on the planet on screen reads as broken.
- Minigames: the drawn marker size **is** the perfect window from csv; good = ×`GYM_GOOD_OF_PERFECT` / `COOK_GOOD_OF_PERFECT`, clamped to half a beat; widen by slowing beats, not windows; no-input steps end via `maxTime` — `housing/parts/GymGames.judgeBands`, `parts/CookGames.cookJudgeBands`.

### 4.3 Saves · profiles · network trust

- Character data keys go through `slotKey(KEY)` (`src/shared/saveSlot.ts`); only `SHARED_KEYS` are global. Slot switch = `location.reload()`.
- Desktop saves are bound to the window origin: `electron/main.ts` scans ports from `APP_PORT` (8790) in a fixed order, never random.
- New profile fields that must survive reload go into `Profile.migrate` (its result is the next save) — prep, meal, trained stats all live there.
- Profile documents merge by revision: `profile:set {baseRev, writeId}`, conflict = server wins; persisted write queue; multi-document edits use `ProfileRef.setMany` — `src/net/ProfileSync.ts`. A pending local edit is uploaded, not replaced, when `net:profileLoaded` arrives.
- Raid session saves must capture death: squad force-saves right after `spawnLocalCorpse`; solo calls `clearSoloRaid()` on death; new save paths check `isDead` / `isLocalOut()` — `src/game/parts/Session.ts`.
- A remaining raid stops the boot at the title (`ctx.raidResume`, `game/parts/Resume`): the solo save is never deleted at boot; a squad raid is asked from the relay only when the `SQUAD_RAID_MARK_KEY` marker exists; a reloaded page answers `welcome` with `lobby:mission {false, keep}` so the blob survives; `lobby:abandon` drifts the member (`LobbyPlayer.drifted` — no rescue, no `lobby:mission true`, cleared by start / reset). `ui/menus/enterShip` waits for that check.
- Rejoin must not silently lose separate pools (e.g. shield): send it in snapshot/ghost/restore; omitted = unknown → max; apply after gear reloads (`pendingShield`).
- Server address order: in-game `설정 › 서버 설정` (`scav.relay`) → `--relay=` / `SCAV_RELAY` → `server.txt` → same-origin `/ws` (vite proxy; the desktop shell proxies to this PC's `ws://127.0.0.1:8787/ws` — builds contain no relay). Parse only with `shared/net.ts` `relayUrlFrom`. Connection tests connect without a token.
- A `refused` link never auto-reconnects; automatic callers check `net.link.state` before `ensureConnected()`.
- The relay validates credit reasons (`shared/credits.ts` `formatCreditReason`, `server/Economy.ts`, `server/economy.gen.json`); it does not check item ownership. Dev reasons need a relay with `SCAV_DEV_ECONOMY=1` (only `scripts/verify.mjs` starts one). No client-side credit/sell-price multipliers.
- Messages that affect others are accepted only from the authority (lobby host for `strat call`, `ee`, `crate sync`). Host-bound requests pass shape → sender → distance → rate (`shared/buffRules.ts` `createBuffGuard`); two paths of one ability share a bucket; limits derive from data; flying things may outlive their dead sender.
- Denials return to the sender: `strat deny` → full cooldown refund, accepted only from the host with the caller's own `callId`.
- Dining plates travel as each member's own `plate state` (`net/parts/Plates.ts`, sent while `inHubSession` + `plateq sync` on entry) — no host authority; eating only changes the eater's profile.
- Empty corpses: only the host decides a looted-empty player corpse (`pcorpse emptied`, accepted from the host only); enemy corpses go client `ecorpseq emptied` → host guard → `ee corpseEmptied`. Both are released only once nobody has that corpse's loot window open — clients report `cviewq open|close`, the host keeps viewers per corpse (guard shape → sender → distance → rate; drops leavers / dead / out of range) — `shared/corpseViewers.ts`. Removed corpse ids never re-spawn in that raid (`sync` skips them) — `game/Corpses.ts`, `enemies/parts/CorpseEmpty.ts`.
- **Squad ≠ shared ship.** Only an invite (`social:play`) creates an undocked lobby (`LobbyState.docked === false`); only `lobby:dock` docks it, never back. Undocked lobbies are not quick-matchable, refuse `lobby:ready` / `lobby:start` / `lobby:mission true` (`not_docked`), and lock pods and training; one member + no open invite → dissolved (`pruneLonely`, reached through `closeInvite` / `announceLeave`) — `server/RelayServer.ts`. "Docked?" = `isDockedLobby`; "am I on that squad's deck?" = hub `squadLobby()`; hub snapshots and pings gate on `ctx.net.inHubSession`. Never read plain `ctx.net.lobby` as "in the shared ship".
- Squad invites are the only way in (`playBlockReason(…, iAmMember)` → `in_squad` / `not_leader` / `in_other_squad`); public docking moves only a player on their own, so squads never merge.
- My dock vs the leader's: `NetRef.dockPending`, read inside `net:lobbyUpdated` (kept through `moved`, cleared on `lobby:error`). Mine → fade (`HUB_DOCK_FADE_S`) + cutscene; theirs → `HUB_SQUAD_DOCK_COUNTDOWN_S` first. Decisions live only in `hub/parts/SquadDock.reconcile`; `SquadDock.cancelEverything` runs before every ship transition, so a new screen must be on `ctx.escape` or close on the `docking` phase.

### 4.4 World · collision · movement

- Colliders match the visible silhouette. Props measure only the part above ground (`world/Props.ts` `footprintOf`); terrain features use convex hulls (`Obstacle.hull`); boxes need `radius >= hypot(halfX, halfZ)` (`Obstacle.box`); stairs are ramps (`Obstacle.ramp`, `structures/parts/Stairs.buildStairFlight`, overlap the upper plate by 0.08 m).
- Walking floor = `WorldRef.getSurfaceY(x, z, feetY)`; **query the surface before `resolveCollision`**. Boxes whose top ≤ feet + `PROP_STEP_UP_MAX` are stepped on, not pushed (box branch only).
- World ceiling = feet + `BOX_HEADROOM`. Only bodies that pass `height` measure headroom by it (`resolveCollision(position, radius, height?)` — drone vents).
- Small bodies (`radius < SMALL_BODY_R`) use their own size for headroom; falling objects and ground effects use `getSurfaceY(x, z, top − PROP_STEP_UP_MAX)`, never `getHeightAt`.
- Slope checks apply only when feet are on terrain (`getHeightAt(x, z) >= feet − 0.02`).
- Moving platforms: `Obstacle.velocity` present = platform. Riding enters via the standing query, stays while inside the vehicle OBB + headroom, and re-solves vehicle-local coordinates every frame — `src/shared/ride.ts`. **A vehicle's yaw therefore must not flip with its travel direction** — flipping mirrors every rider across the car. The tram keeps one orientation for the whole raid (`placeTram` reads only the track tangent; `TramDef.dir` still drives `s` · `vel` · knockback · the wire) and so has a driver console at **each** end, both calling the same `applyStart`. Rail deck steps satisfy `RAIL_DECK_STEP/2 × RAIL_MAX_GRADE < TRAM_FLOOR_UP`; `RAIL_DECK_Y` ≤ `PROP_STEP_UP_MAX`.
- Moving interiors: `PlayerRef.setShipInterior(bounds)` holds a reference rewritten every frame; floor height from the deck plane (`Dropship.floorYAt`); attached bodies re-read world transforms in `update` and `lateUpdate`.
- Layout order: rails first, then rover road, then everything else avoids `RAIL_CLEARANCE_M` and `roverClearance` — `world/generateLayout`. Structure placement clears doorway approaches first (`OPENING_APPROACH`, `structures/parts/Build.clearFor`).
- Enterable buildings have one floor plate whose collider top is exactly `y0` (`Build.floorPlate`). Broken windows still block people (`passRays` / `passSmall`); throwables break glass along their path (`shared/fragile.ts`).
- Fog of war: `ctx.world.fog`, painted locally from snapshots (late joiners `fogq sync`); undiscovered objects appear nowhere (`fog.isDiscovered`). Hazards are seed + mission-time functions with no wire (`hzq sync`), fog density only via `atmo:override`. New hazard shapes must be measured over thousands of seeds for "when does it reach the drop point".
- Moving ships have world colliders while landed (`extraction/Hull.ts`); enemy entry is a query (`ctx.extraction.keepEnemyOut`).
- Teleport/dash movement steps the body like walking, never a single ray — `implants/parts/Devices.dashReach`. Thrown grenades sub-step by at most their diameter, surface before `resolveCollision`, and query the wall push with the body lowered by `PROP_TOP_MARGIN − radius` (else the top 7 cm of every wall lets them through) — `weapons/Grenade.ts`.
- Airborne impulses keep horizontal momentum until landing (`PlayerController.airCarry`).
- Skill XP from movement reads `PlayerRef.selfMovedMeters` (self-propelled odometer), never a position delta — ship / vehicle / carried / grapple / dash / impulse movement never counts (`PlayerController.selfMoved`).

### 4.5 Rendering

- **Never change the point-light count at runtime** — adding a light recompiles every material. Keep lights in the scene and set `intensity` to 0; put visibility toggles on non-light groups. `scripts/smoke-lights.mjs` enforces it.
- Every scene keeps `SCENE_POINT_LIGHT_BUDGET` via `core/LightBudget.ts`; hub/structures light only the nearest slots (`HUB_POINT_LIGHTS`, `STRUCTURE_POINT_LIGHTS`, `shared/lightPool.ts`). Raid budget has zero spare lights.
- New scenes compile before drawing, and compilation goes only through `ctx.shaders` (`core/ShaderWarmup.ts`) — the program key depends on the bound render target.
- Face portraits come from `PlayerRef.snapshotFace` (one lazily created offscreen renderer, cached PNGs, null without a second GL context) with framing in `shared/faceFraming.ts`, shared with character creation — never a canvas per tile (`player/FaceSnapshot.ts`).
- Light pillars only on corpses (`ui/hud/pillar.pillarAllowed`); opened containers show an opened model synced by `crate opened` / `crate sync`.

### 4.6 Combat · enemies

- Shots resolve on the crosshair line; the muzzle blocks only within `WEAPON_MUZZLE_BLOCK_RANGE` — use `weapons/parts/AimLine` (`sys.aim.begin` / `resolve`, `aimShot`). Flashes/tracers/wire origin use the real muzzle.
- Bullets are swept projectiles (`ProjectilePool`, `stats.projectileSpeed`, `stats.bulletGravity`, falloff by travelled distance `damageFalloffStats`); new fire paths send one `reportShot` per trigger.
- Aim sway is a camera look offset computed before the aim line is read (`CameraRig`, `data/aim_sway.csv`).
- Weapon handling scales by grade (`WEAPON_GRADE_HANDLING_MUL`); accepted sockets come from `weapons.csv` `sockets` → `stats.sockets`; non-fitting attachments have no effect (`items/WeaponStats.fittingAttachments`). Legendary uniques are outside class rules (`def.unique`).
- Weapons must look and sound fired even with no target; training targets are obstacles, not enemies.
- Damage to the local player carries a source (`PlayerDamageSource`, wire `dmg.src`); new gun damage paths wrap `shared/damageSource.ts` so NPC kill objectives count.
- Enemy line of fire is measured from the muzzle pulled back by `ENEMY_WALL_STANDOFF`; blocked = hold fire only — `enemies/ai/FireLine.ts`.
- Explosions and melee do not pass walls, roofs or floors: blast damage to a body goes through `shared/explosion.blastReachesBody` (rays from feet · chest · head toward the lifted centre; any clear = hit), melee through `meleeReachesBody` from the attacker's head. New blast/melee damage paths call them; damage to the collider itself (destructible cover, structures, deployables) does not.
- **They do not pass a window either, broken or not** — both go through `shared/explosion.lineClear` → `WorldRef.raycastBlast`, the same ray as `raycast` except that a **glass** collider blocks it. The test is the collider's `kind` (`GLASS_OBSTACLE_KIND`, `world/structures/parts/Glass.ts`), never `passRays`: the tutorial's ghost fence band is `passRays` too and must keep letting blasts through. Low cover is untouched (it was never `passRays`, and the head ray still reaches a peeker); bullets, enemy sight lines and thrown gadgets still use `raycast`.
- Bug nest eggs are enemies (`bug_egg`), not scenery: `world/Nests` only publishes where they stand (`WorldRef.getNestEggSpots`; `NestEggSpot.nest` is the **nest pad** index, *not* a `getNestPositions()` index — that one is per hole), `enemies/` owns the body, the look and the drops. A nest gets no crate ring and no crate within `NEST_CRATE_CLEAR_M` of it — the eggs **are** its reward.
- `ctx.enemies` answers two different questions and the answers differ: **`getEnemies()` returns everything** (an egg must stay shootable, blastable and lootable), while **`queryNear` drops props (`isEgg`) by default** because every caller of it is picking a target or asking 「is something dangerous here」 — a nest holds 8–30 eggs, so the safe answer has to be the default, not a filter each caller remembers. A site that **deals damage** (fire zone, C4) passes `includeProps: true`; a site that picks a target, triggers, warns, pings or scans does not. Bullets · melee · grenades · `applyAreaDamage` · `explode` never go through `queryNear`.
- Bugs that came from a nest are leashed to it (`NEST_LEASH_M`, `enemies/ai/NestLeash.ts`); everything else (mid-raid patrols, waves, raider drops, sandworm spit) still chases without limit. A nest refills 1–3 times per raid (`NEST_REFILL_COUNT_CHANCE`, rolled from its own `Random.hash('nest@<seed>')` stream) when its living **mobile** bugs fall to `NEST_REFILL_TRIGGER_FRAC` of its starting garrison. Host-only, no wire — a host change releases the leash by design.
- Humanoid faction = planet threat (1 android · 2 rogue/raider · 3 raider). Use `Enemy.isHumanoid`, not `isRogue`. Corpse loot depends on enemy state (`CorpseLootOpts`) and that state must be on the wire (`ee corpse.si/gc/gk`).
- Bug difficulty multipliers come from `world:ready`, applied in `enemies/parts/Pool.acquire`; no wire.
- Named rogue: at most one per raid (`NAMED_ROGUE_CHANCE_BY_THREAT`, `enemies/named/Director.ts`); per-type AI/model files, shared files hold hooks only. Enemy drone targets are a separate list (`TargetList.drones`).
- Tutorial enemies never step within `TUTORIAL_ENEMY_EDGE_MARGIN_M` of a cliff edge, found by world queries — `enemies/Tutorial.tutorialEdgeGuard`.
- Remote-mine stacking per target: `max + (sum − max) × GADGET_REMOTE_MINE_STACK_MUL`, applied once.
- Placement preview and placement run the same judgement (`gadgets/parts/Preview.ts`). Drones are owner-authoritative; yaw convention nose = model +Z (`drones/model.ts`).
- Remote explosion type is carried by the sender (`GrenadeMessage.fire`); fire zones are read through `getFireZones()`.
- Ship calls share one cooldown (`data/stratagems.csv`); the wheel has exactly 4 slots (`STRATAGEM_ORDER`) and does not open during cooldown; rescue count is host-owned (`RESCUE_DROPS_PER_RAID`, deducted on grant, no refund).
- Full death has no auto-revive: the corpse takes equipment, bag and quick slots (`InventoryRef.stripForCorpse`); squad raids turn implants into broken pairs (`ProgressionRef.stripImplantsForCorpse`), solo loses them. Revival only by rescue drop, empty-handed; a member who abandoned the raid from the title is `drifted` and never a rescue candidate.
- Squad leader changes only via `lobby:transferHost {targetId, claim?}` (host transfer or claim after `lobby:hostDown`); the toast is only in `game/parts/Leader.ts`.
- Every fall damage bypasses the armor shield (`bypassShield`); `player:fell.damage` is HP lost — `player/parts/Fall.ts`. A crouched roll ends crouched; no roll while prone or standing up from prone — `player/parts/Locomotion.roll`.
- A corpse with no items sinks `CORPSE_EMPTY_REMOVE_DELAY_S` after looting ended (empty and the last viewer — local or squadmate — closed its loot window; a spawned-empty corpse counts from spawn) over `CORPSE_EMPTY_SINK_S` and is removed: player / android / tutorial corpses when spawned empty or looted empty, enemy corpses only once opened and emptied (unopened ones keep `CORPSE_LIFETIME`). A sinking corpse can't be interacted with (`enemies/Corpses.sinking`; player / tutorial corpses already refuse once emptied).
- Bug footsteps use their own ids `bug_step_skitter|heavy|giant` (voice group `bug_steps`, cap `BUG_STEP_VOICE_CAP`, emitter 1/√n, `BUG_STEP_RANGE_M`), never `footstep_<mat>`; `VOICE_CAP` is keyed by `VOICE_GROUP` — `audio/AudioSystem.ts`, `enemies/model.emitEnemyStep`.
- `game:returnToShip` during a raid is death (`PlayerRef.die`) and `leaveMission`; never emit `hub:enter` for it. Liftoff extracts only those aboard and alive; the rest keep playing.
- Rover: one per raid, host-authoritative; riders take no damage and are not targets; only enemies and hazards damage it; one payer per trip (`rover:<from>:<to>`) — rules in `shared/types.ts` rover section. New combat input gates check both `droneControl` and `roverRide`.
- Androids are relay **bot members** (`LobbyPlayer.bot`): never host, never relay targets, skipped by presence / prune / grace counts; a human
  joining a full squad evicts the latest recruited android. The authority simulates them (`src/allies`), enemies target them only through
  `ctx.allies.getCombatBodies()` / `damage()`. **A raid fails only when every human *and* every android is down or dead** (a standing android
  comes to revive; a downed one does not count) — `game/parts/Death.checkAllDead`; every other head count still ignores bots. Their base kit is
  bound (never dropped, given, left in a corpse or deposited) and exists **in the ship too** (`Bag.ensureKit`, never while `raidActive`) — only
  `raidFound` items move — `src/shared/allies.ts`.
- Android orders vs. pings: 가자 · 주의 · 앞장 are **leader-only**; a PC's **enemy / extraction ping** is agreed to from any human. Inside the
  harness an android **roams** (`roam`, structure/cover point of interest, dropped when another body holds it), outside it runs back
  (`follow`); bodies keep `ALLY_SEPARATION_M` apart softly and spread when approaching a person. Engage range comes from the weapon
  (`ALLY_ENGAGE_DAMAGE_FRAC` of its falloff), and crates are looted on a ping first, on their own only while idle within `ALLY_IDLE_LOOT_M`.
- Raid entry loading is a hold (`ShaderWarmupRef.holdFor`, `game/parts/LoadGate`): sim dt 0 until every human reported loaded or
  `RAID_LOAD_TIMEOUT_S`; rejoin, training and tutorial never wait.

### 4.7 Items · economy

- An item's worth is decided in `data/recipes.csv`: repair and salvage derive from its materials × durability buckets (`REPAIR_COST_BY_DURABILITY`, `SALVAGE_YIELD_BY_DURABILITY`); `items/Salvage.checkSalvageEconomy()` proves no infinite profit on every `data:check`.
- Halving materials rounds up, minimum 1; durable gear keeps ≥ 2 per material type.
- **Skills never speed up crafting** (2026-09-16), and today they gate nothing either — every `recipes.csv` `skillRequired` is `0`, so bench level is the only live lock. The **gate itself is still wired** (2nd decision the same day): raise a csv number and that recipe becomes a locked cell tagged `제작 20 필요` (workbench) / a `제작 20` badge (cook rail) and refuses to craft — `Crafting.getRecipes` · `cookBlock` · `CraftPanel.lockedReason` · `Cooking.cookRecipeSkillBlock`. A recipe's `skill` only decides the **material refund**: one roll per consumed unit, linear to `CRAFT_REFUND_CHANCE_AT_MAX` (`shared/craftRefund.ts`), rolled in one place for every craft path (`inventory/parts/Crafting.refundAfterCraft`, bag → stash → ground, one `재료 회수` toast). **Durable gear is excluded** (`items/Salvage.isCraftRefundable`) because its repair / salvage tables are its craft materials; `checkSalvageEconomy` measures every craft baseline at max skill. `recipes.csv` `skillRequired` is kept at 0 and unread.
- A recipe's `bench` is the workbench window it appears in (`station: 'field'` + `bench` is valid). Adding a workbench = `WorkbenchKind` + label + `WORKBENCH_ICON` + furniture model/interaction + `furniture.csv` + `recipes.csv` — use `WORKBENCH_KINDS`, never copy the enum.
- Armor is a shield pool (`ARMOR_SHIELD_BY_TIER`), refilled in the ship and in raids only by chargers; `damageReduction` stays 0.
- Quick slots and pouches are containers, not bag grid: weight/count/consume/corpse include them, `getAllItems()` does not; moves that would drop items are refused.
- Recovery contracts count only items found in that raid (`ItemInstance.raidFound`, `shared/raidFound.ts`); mixed stacks lose the mark.
- Meals are not items: a finished cook is the personal ship's one dining plate (`ShipState.plate`, `shared/meals.ts` `getMealDef`); cooking again replaces it after a 1 s hold warning (`housing/ui/cook/PlateAsk`); eating never consumes it (`eatPlate` → `progression.useMeal`); `game:newMission` (not training) clears it. No dining table = no cook bench (`DINING_TABLE_MISSING_REASON`). Cook recipes are excluded from normal crafting; `InventoryRef.consumeCookInputs` only consumes.
- Previewing contents must equal opening (`shared/lootRolls.ts`, inventory `parts/Peek`).
- Epic+ outcomes (items, gun grades IV–V, uniques, corpse rows) are kept with probability `planet_loot.csv` `epicPlusMul`, else downgraded to the best rarity below epic in the same pool — guaranteed and fallback picks included; the lab locked room is exempt (`CrateLootOpts.lockedRoom`, passed by every crate path via `WorldRef.crateLootOpts`), and so are corpse sample rows (`loot_corpse_samples.csv`, `Loot.rollCorpseSamples`) — `items/Loot.ts`.
- Crypto quotes are relay-authoritative; trades are credit reasons `cbuy:` / `csell:` checked against the quote window; trade screens hold `watch()`; unlock quests need `rewardCredits > 0` (`shared/cryptoMarket.ts`).

### 4.8 Ship · progression · quests

- Buffs fold into `DerivedStats` fields (`progression/derive.applyMealBuff`), so consumers need no change. Trained stats are separate from stat points (`PlayerProfile.trained`).
- Ship-bought preparations live in the profile: `prep`/`meal` → armed on launch (`armPreps`) → cleared at raid end (`clearActivePreps`), kept on death.
- Planet environment damages hp but never gates travel (`PlanetDef.env`, `PLANET_ENV_DPS`, soft `noEnvPrep` warning).
- Character buffs are display/sync only (`shared/charBuffs.ts`, collected in `player/parts/Buffs.ts`, wire `cbuf` + revision `bfr`); new kinds are add-only.
- Furniture poses: player owns the body offsets (`SoldierModel` `FURN_*`), hub owns anchors and staging; the wire carries accumulated phase.
- Furniture access faces are judged only by `housing/Rules.placementBlockOf` (manual, move, auto placement, load). Auto placement keeps the door clear (`autoPlaceSpot`).
- Generator levels gate room purposes and upgrades only — no power allocation (`purposeGeneratorLevel`). A satisfied requirement is still returned; blocking is decided by the `*Reason` functions.
- Rooms have no levels; one room per purpose; cockpit-only furniture (`room=cockpit`) cannot be removed. Retired furniture is refunded on the first `HousingSystem.update` (inventory is not registered at load).
- Grow station: soil first, then seed; tier ids never change; station upgrades rescale growing crops (`Garden.rescaleGrowsForUpgrade`).
- Library: each series volume counts once; consumers read `HousingRef.getLibraryEffects()` — `shared/library.ts`, `housing/Rules.ts`. Video games follow gym rules (`applyGymSession`); the TV's E opens the TV screen.
- Stat points are pending until confirmed (`spendStatPoints`); leaving warns via `EmbeddedView.requestLeave`; forced exits discard. Stat/skill relations come from `stats.csv` / `skills.csv` `derived` columns.
- Lab benches and the cooking station give only their own skill XP (`LAB_BENCHES` in progression, `RESEARCH_BENCHES` in inventory).
- Raid-end character XP comes only from kills: `data/enemies.csv` `raidXp` per last-hit kill, summed into `MissionStats.killXp` at both kill sites (`enemies/parts/Damage.onEnemyKilled`, `net/Replica` `kill`), × `XP_DEATH_MUL` when not extracted, × library `raidXp`; contract/quest XP on top — `game/parts/Death.awardMissionXp`.
- The ship-side guide is **two tracks**: `build` 「증축 안내」 ends when the crafted rifle is equipped, then `raid2` 「출격 안내」 (terminal → board → the one raid) starts on its own (`pendingRaid2`, mirroring `pendingShip`; skipping `build` skips both). Its raid step's progress bar measures **carried `raidFound` value against `TUTORIAL_RAID_EXTRACT_VALUE_C`** and prints the real number past the goal (`1,400 C / 1,000 C`), not the step count. Gates that mean 「the ship-side guide」 test `BUILD_TRACKS`, never one track name.
- While the tactical map is open the floating `.tut-panel` hides and the map's left column draws the same objectives from `TutorialRef.panelInfo()` — one fact, one place. A step whose required objectives are all done clears the floor guide **and** the spotlight instead of falling back to the step's own target.
- Tutorial checkpoints never fold past `supplyLoot` / `heal` while HP < max (`TutorialSystem.healSafeFold`). The ship track is one step `stats` (menu → character tab → ＋ → confirm, objectives shown one at a time), ends on confirm (`onStatsConfirmed`), the build track starts when the menu closes (`autoStartOnClose`); saved `messenger` / `ravenQuest` = done, saved `levelUp` → `stats` (`Steps.retiredTrackEnd` / `normalizeStep`). Facility management is blocked and its hint hidden during the ship track (gate `shipManage`).
- Quests come from NPCs via the messenger (`data/npcs.csv`, `npc_quests.csv`, `npc_objectives.csv`, `ctx.meta.npc`); first contact only in the ship; accepted quests cannot be abandoned; quest ids are credit ledger keys (`quest:<id>`). Raid objectives commit instantly; uncommitted progress resets at raid end.
- Private chat and whispers share one store (`PRIVATE_CHAT_LABEL_KO`); group rooms are relay-authoritative and messenger-only.
- Music is state, not sound: the `bgm` channel has nothing connected — `housing/parts/Music.ts`, `ui/hud/MusicPlayer.ts`.

---

## 5. Quality bar

AAA feel in the browser: readable silhouettes, strong lighting (sun + hemisphere + fog + emissive glow), smooth animation
(procedural walk · tweened UI), screen shake, hit feedback, particle FX (instanced/points), 60 fps with ~60 enemies. Clean typecheck.

---

## 6. Verification & recording (details: [docs/VERIFICATION.md](docs/VERIFICATION.md))

- **After every edit**: `npm run typecheck`; `npm run data:check` if `data/*.csv` changed.
- **After a feature**: `npm run verify` (smokes mapped to touched folders, 4 GPU lanes; the runner starts vite/relay). `--dry-run` first if you want to see what it picked.
- **End of a work session, and before merge**: `npm run verify:all` (+ build + `e2e:mp`, ~17 min). Once, not per commit — during the session `verify` is the check. Don't run smokes one by one by hand.
- **Deploy files touched** (`pack-release.mjs`, `electron/`): `verify` runs `smoke-desktop`; run `npm run app:dist` once and check `release/SCAVANGER/` has exactly three entries (`node scripts/smoke-desktop.mjs --release` checks it).
- Debug hooks: `window.__game.ctx`, `window.__game.getSystem('player'|'weapons'|'net'|'enemies'|…)`.
- **When done, record each fact in exactly one place:**
  - What / why changed + verification result → **commit message** (paste the runner's `docs line:` as its `검증:` line).
  - Invariant or reason for a value → **comment right above that code**; cross-folder rules also get a short bullet in §4.
  - Folder structure / public API changed → that folder's `README.md` body; its `Recent changes` keeps the **last 5 one-liners** (add at top, drop the bottom).
  - User's choice and rejected alternatives → [docs/DECISIONS.md](docs/DECISIONS.md) (no implementation narration).
  - New to-do → [docs/TODO.md](docs/TODO.md); a new **intended limit** ("decided to be this way") → the owning folder's `README.md`
    (`## Rules` · `## Notes` · `## Known limits`), never TODO.md; a gap in the verification net → [scripts/README.md](scripts/README.md).
    Edit the folder map row only if the folder's responsibility changed.
  - **Never** write work logs into [docs/HISTORY.md](docs/HISTORY.md) or [docs/VERIFICATION.md](docs/VERIFICATION.md).
  - Write docs in **English** (except `docs/TODO.md`).
