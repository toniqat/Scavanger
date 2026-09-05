# SCAVANGER — Project Command Center

Helldivers 2-inspired third-person extraction shooter in the browser. Three.js + Vite + TypeScript.
Arc Raiders-style minimalist UI, Diablo 2-style grid inventory, procedural maps, 120 s extraction countdown.
The game starts in a walkable **personal ship** (hub); matchmaking docks you into a **shared ship** where the squad boards launch pods to start a mission.

## Commands
```
npm run dev        # http://localhost:5273 (single-player works without the server)
npm run server     # WebSocket relay server (Node type stripping, `--experimental-strip-types` for Node 22), ws://localhost:8787/ws, GET /health
npm run dev:all    # server + vite together (Vite proxies /ws → 8787)
npm run typecheck  # tsc --noEmit (must pass before you finish); typecheck:server for server/
npm run build
npm run net:selftest   # server protocol self-test (44 checks, no browser)
npm run e2e:mp         # two headless-Chrome clients through a running server+vite (pass the vite URL if not 5273)
npm run smoke:tactical # single-client tactical-kit smoke test (45 checks) against a running vite
```
Windows 원클릭 실행 (프로젝트 루트, 더블클릭):
```
start-server.bat   # node 확인 → 필요시 npm install → npm run dev:all (릴레이 8787 + vite 5273). Ctrl+C 로 종료
start-game.bat     # 5273 이 응답할 때까지 최대 30초 대기 후 기본 브라우저 새 탭으로 게임을 연다. 인자로 다른 URL 지정 가능
```
두 .bat 는 한국어 메시지를 위해 CP949(시스템 ANSI)로 저장한다 — UTF-8 + `chcp 65001` 조합은 cmd 가 goto/label 을 재탐색할 때 파싱이 깨진다.

## Stack & conventions
- Three.js 0.185, TypeScript strict, ES modules, path alias `@/` → `src/`.
- **No external asset files.** Every model (player, bugs, crates, ship, props) is built procedurally from Three.js geometry in code. No GLTF, no textures on disk; use procedural CanvasTexture / shader if needed.
- All HTML UI lives in DOM under `ctx.uiRoot` (`#ui-root`), styled with CSS in `src/ui/styles/`. No React.
- Korean UI text (게임 내 텍스트는 한국어).
- Each feature folder has a `README.md` describing its files. Update it when you change the folder.
- Never edit `src/shared/*` without coordinating — it is the contract every module depends on. If you truly need a new event/field, add it (append only, never rename/remove).
- Use `ctx.bus` events for cross-module communication; use the `*Ref` interfaces on `ctx` for synchronous queries. Never import another feature folder's internals; only `@/shared`.
- Reuse `THREE.Vector3` scratch objects; avoid per-frame allocations in hot paths.
- Dispose geometries/materials you create when a mission is reset (`game:abort`, `game:newMission`).

## Feature → folder map

| Folder | Owner system | Publishes on ctx | Responsibility |
|---|---|---|---|
| `src/shared/` | — | `GameContext`, `EventBus`, `Input`, `Random`, types, events, constants, `gear`/`implants`/`gadgets`/`progression` | Contract. Read first. |
| `src/progression/` | `ProgressionSystem` | `ctx.progression` (`ProgressionRef`) | Character sheet: 5 stats (근력/지구력/인지력/지능/재주), 14 skills, level & XP, **every derived number in one place** (`derived: DerivedStats` — never re-derive a formula elsewhere), persistent `PlayerProfile` in localStorage (migration + autosave), skill XP from bus events, `ui/CharacterSheet` (stat points only in the ship) |
| `src/implants/` | `ImplantSystem` | `ctx.implants` (`ImplantsRef`) | 6 tactical implants on **Q**, equipped only in the ship: 갈고리 (wire pull + crosshair validity), 대시 (3 charges, instant teleport), 배리어 (2000 hp forward shield, blocks enemy projectiles only, regenerates while stowed), 오버차지 (LMB heal / RMB speed+fire-rate buff), 정찰 (1 s pulses ×5, growing radius, 10 s reveal), 대전차포 (rocket + big blast). `blocksWeapons` holsters the gun while wielded; `imp`/`buff` messages replicate the FX |
| `src/gadgets/` | `GadgetSystem` | `ctx.gadgets` (`GadgetsRef`) | 10 deployable consumables (은폐 장막 / 돔 실드 / 바리케이드 / 유인 / 연막 / 지뢰 / 포탑 / 화염 / 제세동기 / 점프대), host-authoritative over `gadq`/`gad`, friendly-fire mines·fire zones·turrets, recover & defuse `Interactable`s, and the query API enemies use (`findEnemyTarget`, `findDistraction`, `blocksProjectile`, `visionFactor`, `fireDamageAt`, `jumpPadAt`) |
| `src/core/` | `Engine` | scene/camera/renderer | Renderer setup, lighting, sky, fog, postprocess, main loop, resize, system registry |
| `src/player/` | `PlayerSystem` | `ctx.player` | Third-person controller, camera rig (over-shoulder, no head-bob, ADS zoom/scope pull-in, terrain/interior collision with height sampling, prone-on-slope pivot lift, near fade), procedural soldier model (stand/crouch/prone/dive poses) + **occlusion silhouette** (GreaterDepth black pass, slot-tinted for remotes), health, stims, **stamina**, stances (C crouch / Z prone / Alt dive), interaction (E), hellpod drop-in, **roll** (Alt, replaces dive), **melee** (`startMelee`, weapons resolves the hit), weight effects, armor damage reduction + gear wear, **인내** (grit save, never from DoT), **downed / revive** (multiplayer only), **cloak** (`getStealthFactor`), backpack perks (tactical hover + fall save, jump-pack air dash), grapple pull / impulses / burning, speed-modifier stack, **interiors** (`setInterior(InteriorCollider)`, `spawnStanding`, `setInPod`, `setCameraOverride`) |
| `src/weapons/` | `WeaponSystem` | — | Primary/secondary weapons, hitscan/projectiles, tracers, muzzle flash, impacts, recoil/spread scaled by stance×ADS, distance damage falloff, SR bolt cycle + 4× scope (`setAimZoom`, `weapon:scopeChanged`), reload, **melee resolution** (`MELEE_DAMAGE × WeaponDef.meleeMul × derived.meleeDamageMul`), **weapon durability** (broken → half fire rate), shooting-skill recoil/reload, overcharge fire rate, shield/barricade blocking before every shot, quick-bar grenades & resupply, grenades (no per-grenade lights — constant light count, `WeaponFx.warmUp()` shader precompile), holstered/hidden outside gameplay phases, listens `loadout:changed` |
| `src/world/` | `WorldSystem` | `ctx.world` | Procedural terrain (heightfield), biome palette, props/obstacles, crates (mesh + interactable), extraction pads, bug nests, **gather nodes** (34 herbs, instanced, host-authoritative `harv`/`harvq`), spawn queries, collision, terrain raycast |
| `src/enemies/` | `EnemySystem` | `ctx.enemies` | Terminid-style bugs (5 types), procedural animated models, AI (idle/patrol/alert/chase/attack), **perception scaled by cloak × smoke** (tracking range shrinks with it, so cloak actually breaks pursuit), inaccurate return fire out of smoke, lure aggro, ranged & melee attacks on deployables, burning DoT, ambient spawning, extraction waves, hit reactions, deaths, gore FX |
| `src/items/` | (data) | `ctx.loot` | Item & weapon definitions (classes AR/SMG/SR/DMR/SG/PISTOL, falloff, `WEAPON_CLASS_LABEL_KO`, `meleeMul`, `durabilityMax`), **armor** I~V + uniques (재생/초경량/광학미채), **backpacks** I~V + legendaries (전술 8칸+호버 / 특수 쿨타임 −50 % / 점프), 10 gadget items, 3 herbs + 화약, 15 craft recipes, per-item `weight` (deliberately not proportional to grid size), loot tables, `LootRef` impl |
| `src/inventory/` | `InventorySystem` | `ctx.inventory` | Diablo 2 grid model (multi-cell items, rotation R, stacks), bag UI (Tab), container/loot window, equip slots, emits `loadout:changed`; **drop** (X / drag to backdrop / context menu → `dropItem` → `inventory:itemDropped`), **split** (Shift+drag half, Ctrl+drag one, right-click menu 절반/하나/수량 지정 `SplitDialog`), middle-click item/weapon → `chat:post` request; **gear slots** (armor/backpack — the backpack decides grid size and quick-slot count), **weight** (`getWeight`, 70/90/100 % states), **quick-use bar** (3~0 keys), **field crafting** panel, **durability** display / wear / ship-only repair, appraisal-gated loot reveal |
| `src/pickups/` | `PickupSystem` | `ctx.pickups` | World item pickups for dropped items: toss arc + landing, pooled procedural category meshes with beam, one `Interactable` each (`pickup:<id>`), host-authoritative sync (`item drop/take/sync` ↔ `itemq drop/take/sync`), `findNear` for pings |
| `src/hub/` | `HubSystem` | `ctx.hub` (`HubRef`) | **Ship hub**: procedural personal ship + shared ship interiors (`interiors/`), AABB `InteriorCollider`, terminal → `ui/HubMenu` (tabs 함선 / 임플란트 / 정비: name, seed, 신호 찾기 quick match, 코드로 도킹, 신호 송출, 공개/비공개, 도킹 해제, 타이틀로, **implant loadout**, **gear repair**, 캐릭터 → `ui:statsToggled`), **hydroponics station** (약초 재배, grows on wall-clock time), docking/undocking cutscene (`DockingCutscene`, exterior ships, starfield), 4 launch pods (`LaunchPod`: board = `setReady`, closed door + slot light for remotes, rejoin when `missionInProgress`), launch countdown → host `startGame` / solo `game:newMission`, space mode via `Atmosphere.setSpaceMode` |
| `src/extraction/` | `ExtractionSystem` | — | Extraction switch consoles at pads, 120 s countdown, ship flight-in/landing, boarding volume, ship interior switch, doors close + liftoff |
| `src/ui/` | `HudSystem` | — | Arc Raiders-style HUD in two layers (`.hud.gameplay` gameplay-only; `.hud.social` = chat, squad, nameplates, notifications, prompt — also shown in the hub): health, **stamina**, ammo, compass, objective markers, hitmarkers, damage indicators, stance-aware reticle, `hud/ScopeOverlay`, `hud/Pings` (middle **hold+drag**: ◄ 주의 `caution` / 돌격 `attack` ► / ▼ 탄약 요청; enemy pings track only while visible, `item` pings via `ctx.pickups`, item/attack/caution post chat lines), `hud/ChatLog` (Enter text chat, kinds text/ping/request/system, `chat:post` → `chat` relay), `map/MapScreen` tactical map (M), menus (title `함선 탑승` → `hub:enter`, pause/death/complete `함선으로 귀환`), `styles/base.css`; **implant widget** (cooldown ring, charges, barrier bar), grapple reticle, **quick bar**, **weight bar**, **detection** (pooled fresnel shells in `derived.detectRadius` + off-screen enemy arrows), **scan reveal** (through-wall shells), downed overlay + ally revive prompts, mine indicators, deployable/gather map icons, level-up toasts |
| `src/game/` | `GameFlowSystem` | `ctx.phase` | Phase state machine: menu → **hub** → [docking → hub] → deploying → playing → extracting → shipLanded → liftoff → complete / dead → hub; stats; pause on pointer-lock loss / window blur (`input:pointerLockLost`); mission-end XP award to `ctx.progression`; downed players are not counted as dead by `checkAllDead`; reconnection UX (`net:reconnecting` = toast only, `net:resumed {seamless:false}` → abort → shared ship, `net:lobbyLeft` → abort → personal ship); `checkAllDead` ignores stale / `IN_HUB` refs |
| `src/audio/` | `AudioSystem` | — | Procedural WebAudio SFX (gunfire, hits, bug screeches, UI, ship engines, countdown beeps) & ambient; reacts to bus events |
| `src/net/` | `NetSystem` | `ctx.net` (`NetRef`) | WebSocket client to the relay with a persistent **session token** (`?t=&n=` → stable PeerId), `ensureConnected()`, **auto-reconnect** with backoff (`net:reconnecting` → `net:resumed {seamless}`), lobby ops (create/join/quickMatch/ready/start/leave/setPublic/setLobbySeed, `?lobby=CODE` invite), `rejoinMission()` for a running mission, 20 Hz `PlayerSnapshot` out (also in the shared-ship hub: `inHubSession`, `IN_HUB`/`IN_POD` flags), interpolated `RemotePlayerRef`s in, `send`/`onMessage` for other systems, translates `fire/reload/grenade/died/ping/chat` into `net:*` bus events, applies `dmg`, emits `game:newMission` on `game:start`, deferred session end + `lobby:reset` (mission end never leaves the lobby) |
| `server/` | (Node) | — | `ws` relay: token → stable PeerId, duplicate-tab takeover, lobbies (6-char code, ≤4 slots, `isPublic`, `connected` flags, ready gating ignoring disconnected members, quick match, seed/name/setPublic), **5-min reconnect grace** (slot kept; host kept while `started`, else migrated), opaque `GameMessage` relay (`host/all/others/peerId`), heartbeat, `/health`, `selftest.ts`. Imports only `src/shared/net.ts` |
| `src/main.ts` | — | — | Bootstraps Engine and registers systems in order |

## Multiplayer (host-authoritative, up to 4)
- **Topology**: browser clients ↔ Node WebSocket relay (`server/`). The lobby **host** simulates enemies, waves and extraction; every client simulates its own player only. `ctx.isAuthority` (single-player OR host) gates simulation; `ctx.isMultiplayer` gates networking. All wire types live in `src/shared/net.ts` (also imported by the server).
- **Players**: `PlayerSnapshot` (`ps`, 20 Hz, pos/vel/yaw/pitch/stance/flags/hp/weapon/stride) → `NetSystem` interpolates with a 0.12 s buffer + ≤0.25 s extrapolation → `player/RemotePlayerSystem` drives a slot-coloured `SoldierModel` (`RemoteAvatar`), `weapons/RemoteWeapons` parents a `WeaponModel` and replays fire/reload/grenade FX, `ui/hud/Nameplates` + `Squad` + `MapScreen` show them. Spawn = 4 m ring by slot.
- **Enemies**: host broadcasts `es` (full snapshot, 10 Hz, ~90 B/bug) + `ee` events (spawn/kill/despawn/damaged/attack/acid/wave); clients run replicas (no AI) with interpolation. Client shots hit replica hitboxes locally → replica `takeDamage` sends `hit` to host → host applies damage → `hitc` back (kill hitmarker + kill credit). Explosions → `explode`. AI targets any player (`enemies/Targets.ts` `CombatTarget`); remote victims get `dmg` (+ optional slow) via `ctx.net.send(..., peerId)`.
- **Extraction**: host owns the countdown and broadcasts `ex` (activated/tick 0.5 s/shipIncoming/shipLanded/boarding/liftoff/reset); clients send `exq` (activate/board/liftoff). Liftoff requires every alive connected player boarded (`탑승 대기 중 (n/m)`).
- **Flow**: `game:paused {freeze:false}` in multiplayer (menu only, world keeps running — Engine + enemies honour it). A dead player spectates (`SpectateOverlay`); host sends `flow over` when everyone is dead, `flow abort` when the host aborts → whole squad returns to the lobby (`NetSystem` sends `lobby:reset`). Death/complete screens show `로비로` while a lobby exists.
- **Ship hub & reconnection** (2026-09-05): title `함선 탑승` → `hub:enter personal` (hub calls `ensureConnected`; a token still in a lobby resumes straight into the shared ship). Terminal quick match (`lobby:quickmatch` → public lobby) or code → `docking` cutscene → shared ship at world origin (all clients build identical geometry, so hub snapshots line up). Pod board = `setReady(true)`; all connected members ready → 3 s countdown → host `startGame(seed)`. Socket drop: server keeps the slot 5 min (`connected=false`), client reconnects with backoff; same mission still running → `net:resumed {seamless:true}` (host keeps authority through its own drop); page reload → shared ship, and `missionInProgress` lets a pod `rejoinMission()` (world by seed, enemies from full `es`, `exq sync` → `ex sync`, `itemq sync` → `item sync`). Mission end/abort → everyone back to the shared ship; only `leaveLobby()` (도킹 해제) leaves.
- **Pickups**: host-authoritative (`item`/`itemq`), ids `${peerId}-${n}`, client drop is optimistic and echoed by the host. **Chat**: `chat {text, kind}` relayed to others, also in the hub. **Pings**: `ping {p, kind, label?, enemyId?}` (label/enemyId read via `onMessage('ping')`).
- **Not synced yet**: crates/loot (`crate` message reserved), remote grenades don't damage the local player, mid-mission host **takeover** (a migrated host gets authority only for the next mission; a returning host resumes as authority within the grace window), pickup lifetime expiry is per-client (`PICKUP_LIFETIME` is 0).

## System lifecycle (contract)
```ts
interface GameSystem { name; init(ctx); update(dt, ctx); lateUpdate?(dt, ctx); dispose?() }
```
Registration/update order in `main.ts`:
`NetSystem → ProgressionSystem → WorldSystem → HubSystem → PlayerSystem → RemotePlayerSystem → ImplantSystem → WeaponSystem → EnemySystem → InventorySystem → GadgetSystem → PickupSystem → ExtractionSystem → HudSystem → AudioSystem → GameFlowSystem`
(`NetSystem` first so snapshots are applied before anyone reads `ctx.net`. `ProgressionSystem` second because
nearly every system reads `ctx.progression.derived`. `ImplantSystem` before `WeaponSystem` so the same frame's
`blocksWeapons` is current. `GadgetSystem` after `InventorySystem` so `use()` can consume the item. Because `WorldSystem` generates synchronously inside its `game:newMission` handler, `world:ready` fires **before** later systems' own `game:newMission` handlers — never `reset()` there unconditionally; check `ctx.world.seed`.)

Mission flow via events:
1. `GameFlowSystem` emits `game:newMission {seed}` → `WorldSystem` generates **synchronously** and emits `world:ready {seed, playerSpawn}`.
2. On `world:ready`: Player respawns at spawn (drop-in), Enemies reset & start ambient spawning, Inventory resets to starter loadout and emits `loadout:changed`, Extraction builds consoles at `ctx.world.getExtractionPoints()`.
3. Player presses a pad switch → `extraction:activated` → Enemies `startExtractionWaves`, HUD countdown, `extraction:tick` every frame.
4. Countdown ends → `extraction:shipIncoming` → ship lands → `extraction:shipLanded`; player boards (`extraction:boarded` when inside).
5. Player presses ship switch → `extraction:liftoff` → doors close → ship rises → `game:complete {stats}`.
6. `player:died` → `game:over {stats}`. Result screens emit `hub:enter {ship}`; `HubSystem` emits `game:abort` first when a mission/result phase is active, then builds the ship, `player.setInterior(collider)` + `spawnStanding`, `setPhase('hub')`, `hub:entered`. `game:newMission` tears the hub down (`hub:left`). `ctx.world` is null in the hub.

`ctx.isGameplayActive()` gates weapons/pings/map/grenades; `ctx.isControlActive()` (gameplay OR `hub` phase, no blockers) gates movement, stances, interaction and the camera. UI blocker tokens: `menu`, `inventory`, `map`, `chat`, `hub` (terminal menu). Systems that open UI add their `ctx.uiBlockers` token **before** `ctx.input.exitPointerLock()` and re-request the lock when they close with no blocker left (inventory, map, pause resume). Any other lock loss during gameplay (Esc, alt-tab, cursor leaving to another monitor) is treated as a pause by `GameFlowSystem`; clicking the canvas re-locks as a fallback.

Key bindings live in `Keys` / `MouseButtons` / the `KEY_*` constants (`src/shared/constants.ts`): C crouch, Z prone,
**Alt roll** (구르기, replaces the old dive), M map, X drop item (inventory open), Enter chat, middle mouse ping
(hold+drag for 주의/돌격/탄약 요청). Rebound by the tactical kit (2026-09-05): **Q** = tactical implant (was weapon
swap), **V** = weapon swap, **F** = melee (was stim), **H** = stim, **3~0** = quick-use slots (the first
`BackpackDef.quickSlots` of them), **B** = over/under throw toggle, **P** = character sheet.
Prone/roll are disabled in the hub; ping/map need `isGameplayActive()`. Weapons owns the melee key and only swings
when `ctx.player.startMelee()` accepts (stamina, cooldown, pose live in player/).

## Quality bar
AAA feel within a browser: readable silhouettes, strong lighting (sun + hemisphere + fog + bloom-ish glow via emissive), smooth animation (procedural walk cycles, tweened UI), screen shake, hit feedback, particle FX (instanced/points), 60 fps target with up to ~60 enemies. Type-check clean.

## Verification (what was actually tested)
- `npm run typecheck` → 0 errors (TypeScript 7: `tsconfig.json` uses `paths` only, no `baseUrl`).
- `npm run build` → single ~870 kB JS chunk, ~28 kB CSS.
- Headless/headed Chrome smoke tests (puppeteer-core, driving `window.__game` = Engine): title → deploy → hellpod drop → movement + pointer lock → firing/reload/stim/grenade → crate open → container drag/rotate/right-click/take-all → Tab bag → Esc pause → extraction switch → 120 s countdown (fast-forwarded) → ship lands → boarding → interior switch → liftoff → mission complete; death → restart. 0 console errors. ~55 fps at 1600×900 on a laptop GPU.
- Real-mouse test (puppeteer `page.mouse`): title seed input + 임무 배치, pause 계속, inventory drag, death-screen 다시 배치 all clickable. Root cause of an earlier "nothing clickable" bug: the inventory overlay (`.inv-root`, fixed inset:0, z-index 50, pointer-events:auto) was hidden only via the `hidden` attribute, which its own `display:flex` overrode → invisible layer swallowed every click. Fixed with a global `[hidden] { display:none !important }` in `base.css`. Rule: never hide a full-screen layer with opacity alone.
- Debug hooks: `window.__game.ctx` (GameContext), `window.__game.getSystem('extraction'|'player'|'weapons'|'net'|'enemies'|'remotePlayers'|…)`.
- Multiplayer (2026-09-05): `npm run net:selftest` 44/44 (lobby create/join/ready/start gating/relay targets/reset/leave/host migration). `npm run e2e:mp` (puppeteer-core, two separate headless Chrome instances — a second tab in one window is throttled and never reaches `playing`) 34/34: lobby code + invite URL + LobbyMenu, start refused until all ready, both clients seed 42 / authority split, hellpod → playing, remote avatar within 0 m of the true position, spawn slots 5.7 m apart, nameplate + squad panel, teleport interpolated, host 18 / client 18 replica bugs with matching ids, client hit → host hp 60→50 → client mirrors 50, `net:remoteFired` / `net:remotePing` delivered, client console activates extraction on host + countdown mirrored (119.7/119.9), missionTime advances during `freeze:false` pause, host abort → both back in a reset lobby with remotes cleared, peer leave. 0 console errors.
- Fixed while testing: `EnemySystem`'s `game:newMission → reset()` wiped the initial population (pre-existing ordering bug, see enemies README); `Input.requestPointerLock` now swallows the denied-lock promise rejection.
- Ship hub / pings v2 / chat / drop & split / pickups / reconnection (2026-09-05): typecheck 0 (client + server), build ~1083 kB JS / 53 kB CSS, `npm run net:selftest` (token → stable id, duplicate takeover, grace, host kept while started, quick match, seed/name/public, ghost-host migration on join) — see server README for the count. `npm run e2e:mp` rewritten for the hub flow: personal ship → quick match (`net:matched`) → docking → shared ship → hub avatars with `IN_HUB` → chat relay in the hub → start refused → seed via lobby → pods (`IN_POD`) → countdown → mission seed 42 → remote avatar 0.4 m → replica bugs 20/20 → client hit 60→50 → attack ping with label + marker → host drop → client pickup take (4→5) → client socket drop → `net:resumed {seamless:true}` still extracting → host abort → both back in the shared ship, pods empty → peer leave → undock. Per-folder headless smokes: hub 41/42 offline, player 26/26 (camera clearance ≥ 0.30 m over 128 prone/slope checks, silhouette through a wall), inventory 56/56 real-mouse, ui 33/33 + 6/6 enemy-tracking, pickups 18/18, audio 6/6.
- Grenade hitch root cause: per-grenade `PointLight` toggled via `visible` changed the scene light count → every lit shader recompiled on each throw/explosion (~1.1 s, `renderer.info.programs` growing 35→77). Fixed by removing the lights (pooled flash pulses instead) + `WeaponFx.warmUp()`; throw frame now ≤ 5.7 ms. Rule: never toggle light visibility at runtime; keep light counts constant.

- Tactical kit (2026-09-05): client + server typecheck 0, build ~1330 kB JS / 78 kB CSS, `npm run net:selftest`
  101/101, `npm run e2e:mp` 52/52 (unchanged multiplayer flow), `npm run smoke:tactical` 45/45 — refs published,
  8 armor / 8 backpack defs with all four perks each, 10 gadget items, 15 recipes, 5 stats / 14 skills, implant
  swap refused mid-raid, 34 gather nodes, weight budget, armor DR, roll covering 4.14 m of its 4.2 m arc, dash
  charge + 7.5 m teleport, every throwable and place-type gadget deployed, mine arming and defusable, turret
  recovered as an item, jump pad launching (impulse 13), field craft, HUD widgets, 0 console errors.
  Perf: 5.52 fps under headless swiftshader vs **5.55 fps on `main` in the same harness** — no regression; the low
  absolute number is software rasterisation, not the kit. Shader programs settle at 79 after firing every new FX.
- Two smoke findings that turned out to be correct behaviour, not bugs (documented so they are not "fixed" later):
  place-type gadgets refuse to stack within `PLACE_CLEARANCE`, so a stationary player can only place one; and
  `GadgetSystem.use` has a game-time `USE_COOLDOWN`, so tests must advance `ctx.time`, not wall time.

## 마지막 업데이트
- 2026-09-05 (tactical kit): `src/progression/` (stats/skills/level/profile + character sheet), `src/implants/`
  (6 implants on Q), `src/gadgets/` (10 deployables, host-authoritative), armor & legendary backpacks, weight,
  quick-use bar, field crafting, durability + ship repair, melee (F), roll replacing dive, grit, downed/revive,
  cloak & stealth-aware enemy perception, gather nodes, detection HUD (fresnel + off-screen arrows), 36 new SFX,
  hub implant/repair/hydroponics stations. Key rebinds: Q implant, V swap, F melee, H stim, 3~0 quick slots.
  Built by 9 parallel folder-scoped agents against a pre-written `src/shared` contract (`TACTICAL_KIT.md` is the
  brief they shared); the session hit its usage limit mid-run and every agent was resumed from its own transcript.
- 2026-09-05 (ship hub): `src/hub/` personal/shared ship interiors + docking cutscene + launch pods + terminal menu, `src/pickups/` dropped-item pickups (host-authoritative), reconnection (session token, 5-min grace, seamless resume, rejoin from a pod), quick match, pings v2 (hold+drag 주의/돌격/탄약, visible-only enemy tracking, item pings), `ui/hud/ChatLog` text chat, inventory drop/split/context menu, camera terrain/interior collision + occlusion silhouette, grenade hitch fix, new SFX. `ui/menus/LobbyMenu` removed (the shared ship replaces it). Built by 7 parallel folder-scoped agents against a pre-written `src/shared` contract.
- 2026-09-05 (multiplayer): `server/` ws relay + `src/net/` (lobby code/invite/ready/start, snapshots + interpolation), `player/RemotePlayerSystem`, `weapons/RemoteWeapons`, host-authoritative enemies (`enemies/Targets.ts`, `enemies/net/`), extraction/game flow sync, `ui/menus/LobbyMenu` + Squad/Nameplates/SpectateOverlay, `shared/net.ts` contract. Built by 6 parallel folder-scoped agents (net+server / player / enemies / weapons / extraction+game / ui) against a pre-written `src/shared` contract. Verified: typecheck 0, build ok, net selftest 44/44, 2-client e2e 34/34.
- 2026-09-05: stamina + stances + dive (player), weapon classes/falloff/SR scope (items, weapons), stamina bar/scope overlay/pings/map (ui, new `src/ui/map/`), pointer-lock pause & re-lock (game, inventory), new SFX (audio). Smoke-tested in Chrome by driving `window.__game.frame()` from a timer (hidden tab): C/Z/Alt/M, sprint drain + regen, SR equip → scope overlay + FOV 17.5, ping, bolt fire, lock loss → pause menu. 0 console errors.

## Known follow-ups
- Soldier armor still reads dark in the mossy/toxic-green palette; consider an env map or rim light.
- Dropship hull is boxy up close; more greebles/panel lines would help.
- Ambient enemy pressure and wave sizes are untuned for a real play session.
- Stamina/falloff/recoil numbers are first-pass; tune with real play. Prone crawl animation is minimal.
- Multiplayer: crate/loot state is per-client (`crate` message reserved); remote grenades are visual-only for the local player; enemy snapshots are always full (delta would cut ~5×); no mid-mission host takeover (clients are effectively paused while the host is in its grace window); `RemotePlayerRef` has no lag compensation for client shots (host validates only enemy id/damage cap); remote hellpods are not rendered.
- Hub: launch countdown on clients is a local mirror (no wire message); draw-call counts of the ship interiors are estimated, not measured; docking cutscene is short/low-poly; hub-time `ui:notify` toasts rely on the social HUD layer.
- Tactical kit: the cloak veil shares its cloak over `buff {kind:'cloak'}`, but a *newly joining* client is not told
  about an in-flight cloak. Overcharge has no remote beam visual (no `imp` beam event), and `ImplantsRef.raycastBarrier`
  damages the barrier as a side effect of reporting a block — a separate `damageBarrier` entry point would be cleaner.
  `PlayerRef.isOvercharged` is inferred from the `'overcharge'` speed-modifier key rather than an explicit setter.
- Tactical kit: `EnemyWire` carries no status bits, so burning/slow are host-local visuals; burn kills are credited to
  the enemy's last damager rather than whoever placed the fire. Enemy `applyStatus` has no attacker parameter.
- Tactical kit: the jump pad re-triggers every time the player lands back on it (3 launches in ~2.5 s in the smoke
  test) — a per-player retrigger delay would read better. Detection highlights are spheres at the object's position,
  not real mesh outlines, because `Interactable` exposes no geometry (`object?` / `kind?` fields would fix that).
  Quick slots have no per-item cooldown readout. Hub hydroponics are per-client (not networked).
- Silhouette is opaque black (a transparent pass would sort after the body); enemies in front of the soldier also trigger it. Pickup lifetime expiry is per-client (fine while `PICKUP_LIFETIME` = 0). Interaction (E) stays active while boarded in a pod.
