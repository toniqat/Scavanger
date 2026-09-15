# scripts/ — run, verify, build and ship helpers

Node scripts for running and verifying the game. None of them is part of the game build. Smokes are driven by `verify.mjs`,
which picks them from the `SMOKES` map (folder → smoke); `node scripts/verify.mjs --list` prints the map. Per-script detail lives in
each script's header comment — read it before editing a smoke.

## Tools (not smokes)

| File | Role |
|---|---|
| `verify.mjs` | **Verification runner** — `npm run verify` (smokes mapped to changed folders) / `npm run verify:all`. Runs typecheck (client + server) · `net:selftest` · `data:check` in parallel, starts vite 5273 + relay 8787 when needed, runs smokes on GPU lanes, `e2e-mp` alone last, writes `scripts/logs/last-run.json` and a `docs line:` for the commit's `검증:` line. Changes to `src/shared` · `src/core` · `main.ts` · `package.json` select everything; `EXTRA_PATHS` maps `docs/pitch/` and `electron/` |
| `data-check.mjs` | `npm run data:check` — loads `data/*.csv` through the game's own loaders in headless vite and prints `dataIssues()` as `data/file:line [col] — reason`; runs the salvage-economy check; `-- --write` regenerates `server/economy.gen.json` |
| `data-owners.mjs` | Which modules load / consume each csv (`DATA_OWNERS`, `CSV_FOLDERS`, `CSV_WIDE`) — shared by `data-check` and `verify` |
| `economy-table.mjs` | Builds, checks and staleness-tests `server/economy.gen.json` (item values, contract/quest rewards, price multipliers, repair, crypto, intel) |
| `check-planet-loot.mjs` | Manual: per-planet weapon-grade and rarity drop tables from `data/planet_loot.csv`, rolled through the real loot code |
| `quiet-hmr.mjs` | Smoke helper `quietViteHmr(page, { parkRelay?, logSockets? })` — parks the `vite-hmr` WebSocket (see Rules) |
| `dev-all.mjs` | `npm run dev:all` — relay + vite with prefixed output; forwards the terminal's input lines to the relay (operator console) |
| `lan-address.mjs` | Prints the LAN IPv4 for `start-server.bat` (`--all`, `--url`) |
| `pack-release.mjs` | Last step of `npm run app:dist` — assembles `release/SCAVANGER/` with exactly three entries (`app/` · stub `SCAVANGER.exe` · `server.txt`); no server |
| `make-icon.mjs` | `npm run icon` — draws `electron/resources/icon.ico` in code (`--png` preview) |
| `pitch-webp.mjs` | `npm run pitch:webp` — writes `<name>.webp` next to each `docs/pitch/assets/<name>.png` via local Chrome (`--force`, `--quality`) |
| `shots-pitch.mjs` | Pitch-wiki screenshots into `docs/pitch/assets/` (needs `npm run dev`; staging dir outside the repo, retry per shot; raids start from `game:newMission`, never `hub.setPlanet`) |
| `shots-factions.mjs` | Humanoid faction look check → `scripts/logs/factions-look*.png` |
| `shots-uiux.mjs` | Screenshots of character / craft / corporation screens → `scripts/shots/uiux-*.png` |
| `logs/`, `shots/` | Runner output and screenshots (git-ignored) |

## Smokes

Folders = the `SMOKES` mapping in `verify.mjs` (what makes the runner pick the script). Flags: **S** standalone (no vite/relay),
**X** exclusive (runs alone), **R** fresh relay.

| Script | Folders | Checks |
|---|---|---|
| `e2e-multiplayer.mjs` (`e2e-mp`) | net, server, game, extraction, hub, pickups, player, enemies · X R | Two clients: ship → quick match → docking → launch pods (boarding ≠ ready) → mission → pickups → reconnect / ghosts → abort; server profile, credits, social, rooms |
| `smoke-aim-sway.mjs` | player, weapons | Figure-8 camera sway only while aiming, per class/stance/movement, none in the hub |
| `smoke-ally-avatars.mjs` | player, allies | Android bodies from injected `AllyBodyView`s: android look, pose mapping, hidden / dead bodies, held gun + armour, pooled reuse, `revive:ally:<id>` → `requestRevive`, carried by an android, `ally:fired` FX keeps the point-light count, android face portrait, downed-not-dead with an android on the roster |
| `smoke-ally-hooks.mjs` | inventory, pickups, extraction, world, gadgets, stratagems | Android raid hooks: ally bag/weight, container peek == take, item requests, `takeBy`, pads, loot list, hazard safe point, stash deposit |
| `smoke-allies-core.mjs` | allies | Android core loop: the `/android` cheat roster in the personal ship, solo raid pod drop with the bound base kit and ×`ALLY_HP_MUL` hp, follow back into the harness, the harness halving while the leader keeps one heading, sense → enemy ping → burst → `applyAllyHit`, damage → downed → revive, bleed-out → `spawnAllyCorpse` |
| `smoke-allies-orders.mjs` | allies | Android orders: leader move / caution pings, first-request-wins + `ALLY_REQUEST_COOLDOWN_S`, the "I have none" chat line, heal delivery (ping → approach → drop while the requester stands still), crate looting that stops when a player opens the box, extract ping → second call → console press |
| `smoke-ally-ui.mjs` | ui, allies | Android HUD from a fake `ctx.allies` (`hud.debugAllies`) + bus events: squad rows (badge, shield, bots never drawn as human rows), nameplates, compass ticks, map legend, `ally:ping` marker / callout / `ping:placedV3`, `ally:chat` never relayed, the seven toasts, and the raid-entry loading gauge (above the black plate, `squad` fill, spins at dt 0, hides on release) |
| `smoke-android-bays.mjs` | hub | Cockpit android bays without a relay lobby (`HubSystem.debugSharedShip`): 3 capsules (bridge half, facing the deck, one-step `exit`, solid collider), `hub_android_<bay>` with the 3 s hold, recruit / dismiss prompts and the leader refusal shown as the prompt, a bot pod seated and ready with an `is-bot` ready cell (no crew-loadout popup), `getPodStandPose`, the match tab's android tile and crew counts, and the raid-entry fade (`ui:screenFade {1, hold}` + `raid:loadBegin` → launch only after `RAID_LOAD_FADE_OUT_S`, un-readying no longer cancels) |
| `smoke-android-lobby.mjs` | net, server · X (own relay on 8896) | Two clients: `setAndroidBay` recruits bot lobby members (bot · bay · ready · own slot), androids are no peers (no `net:peerJoined`, no remote ref), a human joining evicts the latest one (`net:androidReturned human_joined` — the newcomer too), member `not_host`, a full squad `full` + the notice to the requester only, dismissal, human leave |
| `smoke-ballistics.mjs` | weapons, items | Swept projectiles with drop, no tunnelling, distance falloff, laser sight, extended barrel |
| `smoke-buffs.mjs` | ui, player, net | Buff strip under PC vitals (ship + raid) and squad rows, dimmed pending buffs, `cbuf` sync |
| `smoke-burrow.mjs` | enemies, audio | Bug burrow spawns: emerge time, hittable but inert while rising, shake dedupe, replica `ee spawn.em` |
| `smoke-consumables.mjs` | weapons, player, items | Adrenaline / stimulant / stabilizer: 3 s hold, effects, mutual cancel, recipes and drops |
| `smoke-console.mjs` | console, progression, inventory, player, hub | Dev-host gating, toggle, suggestions, history, commands, Home move cheat, Esc capture |
| `smoke-controls-hub.mjs` | ui, hub, inventory, implants, progression, player, net | Controls diagram + rebinding, hub Tab ship screen, terminal, implant gauge / wielded shield |
| `smoke-cooking.mjs` | housing, inventory, progression, hub, player | Six cooking judges headless, cooking flow, meal quality stacks, dining table, bench screen |
| `smoke-desktop.mjs` | — · S X (via `EXTRA_PATHS`) | Real Electron against a relay it starts itself: boot, no relay code / relay port in the shell, `--relay` · `--local` (this PC's 8787) · `server.txt` targets, save = window port, single instance; `--release` checks the 3-entry release folder and the asar |
| `smoke-drone-scan.mjs` | gadgets, inventory | Ground-drone scan aim, 3 s hold gauge, best-grade label matches the real roll |
| `smoke-ecology.mjs` | world, enemies, items | Per-planet biome, gather weights/density, enemy compositions |
| `smoke-enemy-alert.mjs` | enemies, implants, weapons | Bullet tracking (`reportShot` → watch → advance), `shotq` forwarding, barrier blocking |
| `smoke-enemy-allies.mjs` | enemies, allies | Androids as a side target list, humanoid fire, contact / blast / fire zone, `applyAllyHit` (no kill credit), `ally:fired`, `pickCoverSpot` |
| `smoke-enemy-delta.mjs` | enemies, net | Delta `es` (keyframe / delta / `gone` / seq), replica apply, burn-kill credit |
| `smoke-extraction.mjs` | extraction, game | 20 s call, hull colliders, enemy-only doorway, uncancellable grace, riders vs left-behind reset |
| `smoke-faction-sites.mjs` | enemies, world | Site occupation per threat (android / rogue / raider groups), named chance |
| `smoke-fall-damage.mjs` | player, audio, ui, world | Global fall damage, shake, vignette, landing sound, remote `fall` |
| `smoke-favorite-chips.mjs` | meta, ui, inventory | Favourite menu on item chips and shop tiles, recovery-contract chips |
| `smoke-favorites.mjs` | inventory | `isFavorite` / `toggleFavorite`, right-click menu on every item, band, sort, filter, confirms |
| `smoke-fire-zones.mjs` | gadgets, weapons, items, enemies, audio | Fire grenade and G-10 zones on the real surface, sound, danger indicator, drone damage |
| `smoke-food-chain.mjs` | housing, items, progression | Ingredient tiers: analyzer results, soil/media durability, sockets, scaffolds, saves |
| `smoke-furniture-access.mjs` | housing, hub | Access-side placement rules, sanitize of old saves, interaction direction |
| `smoke-generator.mjs` | housing, ui | Generator as build gate, v13 migration refunds, ship-manage generator row |
| `smoke-ghost.mjs` | player, net, game | `restoreState`, rejoin drop skip, knockback, remote poses from `PlayerFlags` |
| `smoke-gym.mjs` | housing, progression, hub, player | Gym session blocks, three workout judges headless, trained bonus, fatigue |
| `smoke-hangar.mjs` | hub, net, housing, player · X R | Two clients: shared-ship hangar, visiting a squadmate's ship, `ship state` wire, `hs` visibility |
| `smoke-hazard.mjs` | world | Hazard kind/start from seed, progress, danger side, pad counts, spore raid layout |
| `smoke-housing.mjs` | housing, hub, inventory, progression, items, ui | Ship state, purposes, placement, upgrades + generator gating, persistence, panels |
| `smoke-humanoid-ai.mjs` | enemies | Faction grenade loadouts, aim curves, android behaviour, raider flanking |
| `smoke-intel.mjs` | world, meta, enemies, hub · S | Intel pins: deterministic layouts, pins really apply, earlier draws unchanged, `previewLayout` agrees |
| `smoke-intro-wake.mjs` | player, tutorial, ui, inventory | Character confirm card → tutorial wake-up cutscene ends and hands control back |
| `smoke-inventory-p6.mjs` | inventory, housing, items | Infinite crate catalog, stash size, bag + stash materials, loadout presets |
| `smoke-ladder.mjs` | player, net | Ladder grab/climb/leave, step smoothing, world ceiling clamp, remote `CLIMBING` |
| `smoke-library.mjs` | housing, items, hub, inventory | Library series share formula, one-per-kind shelving, storages, game-disc stand |
| `smoke-library-consumers.mjs` | inventory, meta, game, console, ui | "Not shelved" band, library effects at consumers, item aliases (uses `window.__imp`) |
| `smoke-lights.mjs` | extraction, player, game, hub, world, core | Visible point-light count never changes across a full session; budget, prebuilt arrival ship |
| `smoke-loadout.mjs` | inventory | Loadout persistence, corp-shop access methods, container events |
| `smoke-map-quests.mjs` | ui, meta | Map quest panels, legend placement, quest toasts |
| `smoke-messenger.mjs` | ui, meta, net | Messenger panel: unread badge, tabs, mixed conversation list, quest cards, rooms |
| `smoke-meta.mjs` | meta, inventory, hub, ui, game | Credits, trust, shop buy/sell, contracts and settlement, persistence |
| `smoke-mining.mjs` | housing, items, meta | Mining rules, wallet, exchange trades, crypto data |
| `smoke-mining-ui.mjs` | housing, hub | Mining screen tabs, core slots, coin picker, furniture models |
| `smoke-named.mjs` | enemies, weapons | Named rogues: prone capsule, buried muzzle, scan-drone adoption, replica hooks, faction |
| `smoke-netlink.mjs` | net, ui, hub | Link states, anonymous background probe, connection badge, refused links, shell relay source |
| `smoke-npc-quests.mjs` | meta, enemies, world, weapons | NPC quest engine: first contact, offers, objectives commit, delivery, report, saves |
| `smoke-phase2.mjs` | player, weapons, inventory, game, ui | Downed / bleed / give up / respawn, quick-use wheel, heal hold, grenade cooking |
| `smoke-phase3.mjs` | stratagems, world, ui, weapons | Ship-call wheel, cooldown, top-view targeting, effects, off-screen indicators |
| `smoke-phase4.mjs` | enemies, items, world, inventory, weapons, player | Rogues, faction clash, shell interception, toxic burst, behemoth plate, corpses, statuses |
| `smoke-pitch.mjs` | — · S (via `EXTRA_PATHS`) | All pitch pages load: no console errors, sidebar, `.nextnav` targets exist, lightbox card flipping |
| `smoke-planets.mjs` | hub, world, game | Solo planet terminal, hologram stepping, warp, launch-ready hold + warning |
| `smoke-pose.mjs` | player, hub | Furniture poses (sit / bench / run / cycle / cook), IK, release position |
| `smoke-progression.mjs` | progression | Stat XP clamps, skill XP, migration + persistence, character sheet |
| `smoke-props-collision.mjs` | world | Prop colliders never exceed the visible silhouette (hull vs drawn edge) |
| `smoke-quickslots.mjs` | inventory, ui, weapons | Quick-slot container model and real-mouse drag with centred ghost |
| `smoke-raid-loading.mjs` | game, core, hub, ui | Raid-entry loading gate: black hold (mission clock and hellpod frozen), progress to 1, minimum black time, fade-in, `deploying` → `playing`; host waits out an unfinished squadmate (debug hooks); rejoin and training skip it |
| `smoke-raidflow.mjs` | game, extraction, player, inventory, world | Solo death → raid failed, training enter/exit, rejoin restore, voluntary return to ship |
| `smoke-recovery-contract.mjs` | meta, inventory, pickups, game, world, enemies | Recovery contract counts only raid-found items; mark follows the item |
| `smoke-resume-gate.mjs` | game, ui | Browser resume gate (switchable lock stub `window.__lockGrant`), pause-menu layering, ESC close |
| `smoke-rogue-drop.mjs` | enemies, world | Raider drop: warning, ETA landing, waves by squad size |
| `smoke-rogue-v2.mjs` | enemies | Rogue AI v2 cover, reload cycle, grenade toss, authority round-trip |
| `smoke-rooms.mjs` | net | `RoomSync` / `SocialSync` with a recording `send`: room state, lines, acks, history, unread |
| `smoke-rover.mjs` | world, audio, console | Rover stops, boarding, fare payment, trip, turret, destruction |
| `smoke-sandworm.mjs` | enemies, audio, console | Sandworm roll, warning, eruption, spit, death, replica promotion |
| `smoke-search.mjs` | inventory | Container search reveal, gauge, `canFit`, raid state capture/apply |
| `smoke-ship-rooms.mjs` | hub, housing | Personal ship cockpit + rooms, room tracking, 3D housing mode |
| `smoke-site-spawns.mjs` | world, enemies | `getSiteSpawnPoints` / `getRuinSites` return reachable, clear points |
| `smoke-social.mjs` | ui, net | ESC social screen, profile cards, context menu (분대 초대 gate), friends, blocks, private chat |
| `smoke-squad-dock.mjs` | net, hub, server · X (own relay on 8894) | Three clients: invite → undocked squad in personal ships (no hub snapshots), pod / training locks, member dock refused, leader fade vs member countdown → everything closed → dock, lone public join, 도킹 해제 only me, invite into a docked ship, lone private dock |
| `smoke-stations.mjs` | housing, inventory, items | Shared station frame, upgrade modal hold, timers, harvest/delivery |
| `smoke-stratagems.mjs` | stratagems, world | G tap/wheel, ground + top-view targeting, call effects |
| `smoke-structure-reach.mjs` | world | Body-radius flood fill reaches rooms, stairs, upper floor, ladders, basement door |
| `smoke-structures.mjs` | world, items, inventory | Structures, box colliders, basements, rails, trams measured numerically |
| `smoke-tactical.mjs` | implants, gadgets, progression, player, world, enemies, inventory, items, weapons, audio | Implants, gadgets, weight, melee, roll, gathering, field crafting |
| `smoke-tip-pin.mjs` | inventory, ui | Durability gauges, pinned tooltip via hold ring, socket detach from pinned card |
| `smoke-training.mjs` | world, hub, housing, game | Training range from the ship terminal, solo and crew, snapshot restore |
| `smoke-tram-ride.mjs` | enemies, world | Enemies and corpses ride trams in vehicle-local space; replica prediction |
| `smoke-trust.mjs` | stratagems, weapons, implants, gadgets, meta, enemies | Two clients in a private lobby forge wire messages; host guards (ship calls, buffs, contracts, `explode`, `st`, denies) hold |
| `smoke-tutorial.mjs` | tutorial, hub, housing, inventory, ui, items | Build track: gates, spotlight, hides, skip hold |
| `smoke-tutorial-raid.mjs` | tutorial, world, game, extraction, player, enemies | Raid track end to end through the real entry path (teleports between sections, real input for judged actions) |
| `smoke-tutorial-ship.mjs` | tutorial, meta, ui, progression, inventory | Ship track: level-up → stats → messenger → Raven quest with real input |
| `smoke-tv-games.mjs` | hub | TV / console models, seat interaction, game staging (housing stubbed) |
| `smoke-ui-p5.mjs` | ui, meta, game | Title level chip, contract panel, meta toasts, result-screen XP block |
| `smoke-ui-p6.mjs` | ui | Charge gauge, fire-mode lines, status markers, housing hint, give-up bar |
| `smoke-uniques.mjs` | weapons, items, enemies, player, ui | The six unique weapons incl. bow draw and rocket jump |
| `smoke-video-games.mjs` | housing, progression, hub, items | TV seat rules, game session with tuned judges, intelligence/perception gains |
| `smoke-weapons.mjs` | weapons, items, inventory, hub, pickups, audio | Grades, durability, ammo, sockets, bags, repair, remote weapon state, barrier purity |

## Rules every smoke follows

- **Argument and browser**: first argument is the vite URL (default `http://localhost:5273/`). Each script launches its own headless
  Chrome on the **real GPU** (`GL_ARGS`: `--use-angle=d3d11 --enable-gpu`); `SMOKE_GL=swiftshader` switches to the CPU rasterizer
  (~10× slower, use `--jobs 1`).
- **Pointer lock is stubbed**: `Element.prototype.requestPointerLock` resolves without locking (a real lock would trap the OS cursor in
  the hidden window — Windows ClipCursor) and `pointerLockElement` is faked. `smoke-resume-gate` uses a switchable stub (`window.__lockGrant`).
  Real lock timing is not automatable — see `docs/VERIFICATION.md`.
- **Wait on simulation time** (`ctx.time`, e.g. a `waitSim(sec)` helper), never wall-clock sleeps: headless frame rates vary. Key taps are
  keydown + keyup in one frame on `document.body`; holds are keydown → `waitSim` → keyup. `waitFor` defaults to ~60 s so lanes can share
  the machine. Checks build on each other, so the unit of re-run is the whole script.
- **Tutorial opt-out**: smokes boot fresh profiles, so every vite smoke except those that test the tutorial (`smoke-tutorial*`, `smoke-intro-wake`) seeds, inside `evaluateOnNewDocument`,
  `localStorage['scav.s1.tutorial'] = { version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } }`.
  All three tracks must be done — if `raid` is not, the entry flow sends the character into the tutorial raid.
- **`quietViteHmr(page)`** (`quiet-hmr.mjs`) is called **before `page.goto`, once per page**, in every smoke that opens vite: another
  session's file save would otherwise full-reload the page mid-run. `{ parkRelay: true }` also blocks the relay socket for single-player
  smokes (default leaves the relay alone). Not needed by `smoke-desktop` · `smoke-pitch`. If flakes remain, run a
  dedicated `npx vite --port 5299` and pass its URL.
- **Wait for `net:profileLoaded`** before seeding state directly — a server profile arriving later replaces it.
- Two-client smokes join a **private lobby by code**, never quick match (stale public lobbies hijack it). Counters that are never reset
  (e.g. `EnemySystem.hitGuardStats`) are read as before/after deltas.

### `import('/src/…')` returns a different module instance

vite dev stamps invalidated imports (`/src/shared/library.ts?t=…`) once a file changes while the server is up, and the stamp survives a
full page reload. A smoke's hand-written unstamped `import('/src/…')` is then accepted as a **second evaluation of the module**. Reading
constants or pure functions is harmless, but **mutating that copy's state** (inserting into a map, stubbing an export) is invisible to the
app — typically red only on a long-lived dev server. Smokes that mutate module state import **the URL the document actually fetched**:
`smoke-library-consumers.mjs`'s `window.__imp` looks the path up in resource timing (raise the buffer with
`performance.setResourceTimingBufferSize` in `evaluateOnNewDocument`) and falls back to the bare path.

### Runner options (`node scripts/verify.mjs --help`)

- `--only a,b` · `--folders weapons,ui` · `--rerun-failed` (from `last-run.json`) · `--all` · `--list`.
- `--jobs N` (default 4) · `--serial` · `--base <ref>` · `--build` · `--no-typecheck` · `--no-e2e` · `--url` · `--timeout <min>`.
- `--log-dir scripts/logs/<name>` gives each concurrent runner its own logs and `last-run.json`; `--keep-relay` keeps a relay already on 8787.
- Unknown options and `--help` print help and **run nothing**.
- The runner starts its own relay with `SCAV_DEV_ECONOMY=1` so dev credit reasons (`smoke:*` · `e2e:*` · console · `shot`) are accepted.
  **A shared relay started by hand for parallel smokes needs `SCAV_DEV_ECONOMY=1`** — otherwise top-ups are reverted (the runner prints a note
  when `/health.devEconomy` is false).
- `data/<file>.csv` changes select smokes of the consuming folders (`data-owners.mjs`); `constants.csv` / `tables.csv` are wide and only print a note.

## Recent changes

Older: `git log -- scripts` (full previous README: `git show 3949d37:scripts/README.md`).
- 2026-09-15 — `e2e-multiplayer.mjs`: player names are set after both clients join the lobby (profile load was resetting them).
- 2026-09-15 — New `smoke-allies-core` · `smoke-allies-orders` (the android AI itself in allies/).
- 2026-09-15 — New `smoke-ally-ui` (android squad rows / nameplates / map / pings / chat / toasts and the loading gauge in ui/).
- 2026-09-15 — New `smoke-ally-avatars` (android bodies, revive prompt, carry, shot FX in player/).
- 2026-09-15 — New `smoke-ally-hooks` (android raid hooks in inventory / pickups / extraction / world).
- 2026-09-15 — New `smoke-tutorial-raid` · `smoke-tutorial-ship` · `smoke-fall-damage` · `smoke-fire-zones`.
- 2026-09-14 — `smoke-library-consumers.mjs` routes every `/src/…` import through `window.__imp` (module-instance caveat above).
- 2026-09-14 — New `smoke-intel.mjs` (standalone); `economy-table.mjs` bakes and cross-checks the intel section.
- 2026-09-14 — `smoke-planets` / `e2e-mp` / `smoke-trust` follow "boarding ≠ ready" (Space hold → warning → ready); `smoke-training` reads crew rows from the match popup.
