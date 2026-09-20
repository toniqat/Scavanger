# scripts/ — run, verify, build and ship helpers

Node scripts for running and verifying the game. None of them is part of the game build. Smokes are driven by `verify.mjs`,
which picks them from the `SMOKES` map (folder → smoke); `node scripts/verify.mjs --list` prints the map. Per-script detail lives in
each script's header comment — read it before editing a smoke.

## Tools (not smokes)

| File | Role |
|---|---|
| `verify.mjs` | **Verification runner** — `npm run verify` (smokes mapped to changed folders) / `npm run verify:all`. Runs typecheck (client + server) · `net:selftest` · `data:check` in parallel, starts vite 5273 + relay 8787 when needed, runs smokes on GPU lanes, `e2e-mp` alone last, writes `scripts/logs/last-run.json` and a `docs line:` for the commit's `검증:` line. `src/core` · `main.ts` · `package.json` select everything, `src/shared` only when the change is wide (see the options below); `EXTRA_PATHS` maps `docs/pitch/` and `electron/` |
| `data-check.mjs` | `npm run data:check` — loads `data/*.csv` through the game's own loaders in headless vite and prints `dataIssues()` as `data/file:line [col] — reason`; runs the salvage-economy check; `-- --write` regenerates `server/economy.gen.json` |
| `check-css-prefixes.mjs` | **One prefix, one folder** (CLAUDE.md §4.1) — declares = the first class of a selector's first compound, so scoping into another folder's class (`.item-tip .itip-head`) passes and a global `.it-head` does not. `SHARED` in the file lists the shared frames (`.ui-` · `.is-` · `.inv-` …) and the three documented cross-folder overrides. No browser, no vite; `verify` runs it beside typecheck |
| `check-comment-labels.mjs` | **A Korean label quoted in an English comment must be the real string** (CLAUDE.md §4.1; `docs/TODO.md` B-46) — every phrase a comment quotes in 「」 or backticks is looked up outside comments, and one that is *within two edits* of a live string but does not match it is printed as a probable re-typed label. Nothing else sees this class: `tsc` passes, every smoke passes, and a comment-only diff proves nothing. `--head` reads HEAD (what an audit reads), `--all` also lists phrases with no live match at all. **Advisory (always exit 0)** — its list still holds templates (`크레딧 n C`) and deliberate historical names, so it is read, not gated; `verify` does not run it |
| `data-owners.mjs` | Which modules load / consume each csv (`DATA_OWNERS`, `CSV_FOLDERS`, `CSV_WIDE`) — shared by `data-check` and `verify` |
| `economy-table.mjs` | Builds, checks and staleness-tests `server/economy.gen.json` (item values, contract/quest rewards, price multipliers, repair, crypto, intel) |
| `check-planet-loot.mjs` | Manual: per-planet weapon-grade and rarity drop tables from `data/planet_loot.csv`, rolled through the real loot code |
| `quiet-hmr.mjs` | Smoke helper `quietViteHmr(page, { parkRelay?, logSockets? })` — parks the `vite-hmr` WebSocket (see Rules) |
| `close-browser.mjs` | Smoke helper `closeBrowser(browser)` — kills a launched Chrome's process tree, gives up on `browser.close()` after 5 s and removes the temp profile itself, so the lane never waits on a stuck shutdown (see Rules) |
| `dev-all.mjs` | `npm run dev:all` — relay + vite with prefixed output; forwards the terminal's input lines to the relay (operator console) |
| `lan-address.mjs` | Prints the LAN IPv4 for `start-server.bat` (`--all`, `--url`) |
| `pack-release.mjs` | Last step of `npm run app:dist` — assembles `release/SCAVANGER/` with exactly three entries (`app/` · stub `SCAVANGER.exe` · `server.txt`); no server |
| `make-icon.mjs` | `npm run icon` — draws `electron/resources/icon.ico` in code (`--png` preview) |
| `pitch-webp.mjs` | `npm run pitch:webp` — writes `<name>.webp` next to each `docs/pitch/assets/<name>.png` via local Chrome (`--force`, `--quality`) |
| `shots-pitch.mjs` | Pitch-wiki screenshots into `docs/pitch/assets/` (needs `npm run dev`; staging dir outside the repo, retry per shot; raids start from `game:newMission`, never `hub.setPlanet`) |
| `shots-factions.mjs` | Humanoid faction look check → `scripts/logs/factions-look*.png` |
| `shots-uiux.mjs` | Screenshots of character / craft / corporation screens → `scripts/shots/uiux-*.png` |
| `perf-measure.mjs` | **`docs/PERF_PLAN.md` Phase 0 harness** — plays S1-S4 in a **headful** Chrome (a headless window does not present frames, so its cadence means nothing) and prints frame time, per-system script time, draw calls and heap. Wraps every system's `update` / `lateUpdate`, the render block, the light budget, `AudioSystem.play` and the spawn paths **on the live page** — no `src/` change. `--only s1,s3a` · `--seconds` · `--label` · `--spike` (autopsy threshold) · `--headless` · `--display bloom=0,shadows=0,scale=0.75` (applies `설정 › 화면 설정` before recording — how a run splits the render block into scene · shadow pass · composer, which is what turned the 2026-09-20 ranking over). The report also carries a **draw-call census** — visible drawables and shadow casters per top-level scene group, i.e. which bodies own the render block. Writes `scripts/logs/perf/<label>.json`; re-run it with the same options after each phase for the before/after delta — **twice per side**: on 2026-09-20 two runs of the *same* build differed by 1.6× in spike count, so a single run proves nothing about `ms` (draw calls, scene nodes and triangles do repeat). Asserts nothing, so `verify` never runs it |
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
| `smoke-allies-orders.mjs` | allies | Android orders: leader move / caution pings, first-request-wins + `ALLY_REQUEST_COOLDOWN_S`, the "I have none" chat line, heal delivery (ping → approach → drop while the requester stands still), crate looting by the ping's **`containerId`** that stops when a player opens the box, an item ping → ground pickup, extract ping → second call → console press |
| `smoke-ally-ui.mjs` | ui, allies | Android HUD from a fake `ctx.allies` (`hud.debugAllies`) + bus events: squad rows (badge, shield, bots never drawn as human rows), nameplates, compass ticks, map legend, `ally:ping` marker / callout / `ping:placedV3`, `ally:chat` never relayed, the seven toasts, and the raid-entry loading gauge (above the black plate, `squad` fill, spins at dt 0, hides on release) |
| `smoke-android-bays.mjs` | hub | Cockpit android bays without a relay lobby (`HubSystem.debugSharedShip`): 3 capsules (bridge half, facing the deck, one-step `exit`, solid collider), `hub_android_<bay>` with the 3 s hold, recruit / dismiss prompts and the leader refusal shown as the prompt, a bot pod seated and ready with an `is-bot` ready cell (no crew-loadout popup), `getPodStandPose`, the match tab's android tile and crew counts, and the raid-entry fade (`ui:screenFade {1, hold}` + `raid:loadBegin` → launch only after `RAID_LOAD_FADE_OUT_S`, un-readying no longer cancels) |
| `smoke-android-lobby.mjs` | net, server · X (own relay on 8896) | Two clients: `setAndroidBay` recruits bot lobby members (bot · bay · ready · own slot), androids are no peers (no `net:peerJoined`, no remote ref), a human joining evicts the latest one (`net:androidReturned human_joined` — the newcomer too), member `not_host`, a full squad `full` + the notice to the requester only, dismissal, human leave |
| `smoke-ballistics.mjs` | weapons, items | Swept projectiles with drop, no tunnelling, distance falloff, laser sight, extended barrel |
| `smoke-buffs.mjs` | ui, player, net | Buff strip under PC vitals (ship + raid) and squad rows, dimmed pending buffs, `cbuf` sync |
| `smoke-blast-occlusion.mjs` | enemies, weapons, gadgets, stratagems | Explosions and melee stop at walls, roofs and floors: 3-point body sample on floating boxes, then real paths (enemy `explode`, shell → player, enemy `hitTarget`, player melee) with and without a wall |
| `smoke-burrow.mjs` | enemies, audio | Bug burrow spawns: emerge time, hittable but inert while rising, shake dedupe, replica `ee spawn.em` |
| `smoke-consumables.mjs` | weapons, player, items | Adrenaline / stimulant / stabilizer: 3 s hold, effects, mutual cancel, recipes and drops |
| `smoke-console.mjs` | console, progression, inventory, player, hub | Dev-host gating, toggle, suggestions, history, commands, Home move cheat, Esc capture |
| `smoke-controls-hub.mjs` | ui, hub, inventory, implants, progression, player, net | Controls diagram + rebinding, hub Tab ship screen, terminal, implant gauge / wielded shield |
| `smoke-cooking.mjs` | housing, inventory, progression, hub, player | Six cooking judges headless, cooking flow, dining-table gate, dining plates (replace warning, eat without consuming, shared-table squad plates, launch warning, raid-start clear), bench screen |
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
| `smoke-thumper.mjs` | gadgets, world, enemies, items | Thumper: catalogue, preview ≡ placement (`burrowGroundOk` — bare ground green, roof red), 1 s strikes with sound and shake, 5th strike → one `sandworm:summon`, not recoverable, destroyed only inside an eruption radius, re-placeable, wire `age` (stubs `burrowGroundOk` while world has not published it) |
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
| `smoke-layout-reads.mjs` | ui | **No layout read inside a frame** (CLAUDE.md §4.2), as a count: every layout-forcing accessor (`offsetWidth` · `scrollHeight` · `getBoundingClientRect` · `getComputedStyle` …) is patched on its prototype and counted **only while `Engine.frame` is on the stack**, so a new widget is covered the day it is written and a read from a pointer handler or a resize is not. Ship frames · a 60-bug raid · and the chat / ping / notify / damage / hit-marker / animation-restart events fired **from inside a frame**; the bar is 0 and a failure names the file and function. `hud/ChatLog` broke the rule per chat line for a year (`docs/PERF_PLAN.md` Phase B) |
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
| `smoke-tutorial.mjs` | tutorial, hub, housing, inventory, ui, items | Build track: gates, spotlight, hides, skip hold, the intro card hiding for a cutscene (`hub:docking`) and returning |
| `smoke-tutorial-raid.mjs` | tutorial, world, game, extraction, player, enemies, ui | Raid track end to end through the real entry path (teleports between sections, real input for judged actions) |
| `smoke-tutorial-ship.mjs` | tutorial, meta, ui, progression, inventory | Ship track (2 steps): level-up → stats with real input; the track ends only when the inventory closes (no build intro over the character screen); old `messenger` / `ravenQuest` saves read as done; reload after confirming; Raven writes after the tutorial |
| `smoke-tv-games.mjs` | hub | TV / console models, seat interaction, game staging (housing stubbed) |
| `smoke-ui-p5.mjs` | ui, meta, game | Title level chip, contract panel, meta toasts, result-screen XP block |
| `smoke-ui-p6.mjs` | ui | Charge gauge, fire-mode lines, status markers, housing hint, give-up bar |
| `smoke-uniques.mjs` | weapons, items, enemies, player, ui | The six unique weapons incl. bow draw and rocket jump |
| `smoke-video-games.mjs` | housing, progression, hub, items | TV seat rules, game session with tuned judges, intelligence/perception gains |
| `smoke-weapons.mjs` | weapons, items, inventory, hub, pickups, audio | Grades, durability, ammo, sockets, bags, repair, remote weapon state, barrier purity |

## Known gaps in the net (2026-09-18)

Things today's smokes deliberately do not measure. Each is here so the next reader knows it is a gap, not an oversight.

- **Bug-egg draw-call cost at nests.** A raid now carries 32 (floor) / ~88 (typical) / 240 (absolute worst: 8 pads
  after buying 「벌레 둥지 +2」) `bug_egg` bodies. An intact egg is one draw call and is excluded from AI, `queryNear`
  and every head count, but nothing measures the frame time on a threat-3 planet with the nest intel bought.
- **Nest leash and refill feel.** `smoke-*` can assert that a leashed bug turns back past `NEST_LEASH_M` and that a
  refill fires, but 「적당히 따돌리면 돌아간다」 and whether `NEST_REFILL_TRIGGER_FRAC` 0.34 is the right trigger are
  play-feel questions, not assertions.
- **Eggs on a replica and across a host change.** Egg size is derived deterministically from `WorldRef.getNestEggSpots`
  with no wire field, so host and replica should agree by construction — untested live. A host change releases the
  nest leash by design (`Enemy.nestOf` is host-local).
- **The tutorial credit gauge while actually looting.** `smoke-tutorial` drives `raidValue` directly because a hub-only
  smoke has no raid to loot in; the live 「loot an item → the bar moves」 path is uncovered.
- **Artillery prep as a warning.** That 2.5 s of 포격 준비 reads as enough warning before the first shell is a feel
  question; only the state machine is assertable.
- **`smoke-rover`'s turret check asserts more than it can know (found 2026-09-18, red at `9e6c01d` *and* at its parent,
  so it is not that commit).** Step 5 spawns one `warrior` 13 m to the rover's side, waits 5 sim s and requires both
  `rover:fired` to grow **and** that enemy's hp to fall. The turret picks the **nearest living enemy in
  `ROVER_TURRET_RANGE` with line of sight** (`rover/parts/Turret.ts`) and damages it directly, so on a map where
  another bug is nearer — or where the circling rover keeps the spawned one outside `ROVER_TURRET_AIM_CONE` or behind
  cover — the run prints `29/30` with 16–20 shots fired and `hp 213 → 213`. The two halves of the assertion have to be
  measured against the **same** enemy (assert on `rover:fired`'s target, or pin `ts.targetId`), or the check has to
  clear the area first. See `docs/TODO.md` B-22.

- **A wait must accept the end of the run as a terminating condition (fixed 2026-09-19, TODO B-31).** `smoke-phase3`'s
  laser step waited only for `stratagem:ended`. If the raid ended first — at `timeScale 4` a surviving bug can kill the
  player — the call list is emptied and that event can never arrive, so the step sat for its full 60 s and then reported
  `timeout waiting for laser ended`: a failure about the laser that had nothing to do with the laser. A wait that can be
  outlived by its own subject needs the second exit (`!ctx.isGameplayActive()`) and an assertion that names which of the
  two happened. Same shape as B-22: an assertion has to pin down what it measures.

- **A smoke that builds its own event payload can hide a contract bug (found 2026-09-19, TODO B-61).** `smoke-allies-orders`
  emitted its crate ping as `ping:placedV3 {label: <container id>}`, so the android latched on and the step was green for
  three weeks — while the real `ui/hud/Pings` put the **display string** `보급 상자 (n등급)` in that field and no crate
  ping ever got looted in the game. A hand-built payload has to be the one the real producer sends, field for field; where
  it cannot be, the step is measuring the smoke, not the game. (The ping now carries `containerId` and the smoke passes
  both fields as the HUD does, but the shape of the mistake is worth keeping.)

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
- **Close with `closeBrowser(browser)`** (`close-browser.mjs`), never a bare `browser.close()`: on Windows a D3D11 Chrome that exits while
  other Chromes still render keeps its process alive for up to ~2 min after CDP disconnects, and puppeteer waits for it with no limit —
  the smoke is done but its lane is not (measured and explained in the helper's header). Killing the tree is not always enough either
  (2026-09-17): a process stuck in a kernel wait is not reaped, so the helper waits **at most 5 s** for `close()` and then walks away,
  deleting the temp profile itself; `verify.mjs` sweeps profiles older than 2 h at the start of a run.
  `smoke-desktop` keeps its own graceful close: it tests the app's quit.
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

**`smoke-npc-quests.mjs` still has this bug** (found 2026-09-18 by the `src/shared` comment pass). It calls
`await import('/src/shared/damageSource.ts')` and then **mutates that copy's scope state** with `withLocalGunHit`, so
the app's `Enemy.takeDamage` reads the other copy and `enemy:killed.weaponClass` comes back null: `real kill inside
withLocalGunHit(SG)` fails 68/69. It goes red the moment **any** edit to `damageSource.ts` reaches a dev server that
was already up — a comment-only edit is enough — and green against a fresh vite, so it reads as a change breaking the
game when nothing changed. Fix it the way `smoke-library-consumers.mjs` did (`window.__imp`); until then, a red there
after touching `damageSource.ts` is checked by restarting vite, not by debugging the game.
### Known gaps in the net

- `smoke-inventory-p6.mjs` does not call `quietViteHmr(page, { parkRelay: true })`, although it is the same kind of
  single-player smoke (`meta` · `housing` · `ladder`) that `quiet-hmr.mjs` names as 「a server profile must not arrive
  mid-run」. Parking the relay socket makes it a real standalone client and removes that family of flakes (one setting
  line, not an assertion).
- **No smoke covers**: the dining-plate wire with two clients (`plate` / `plateq` — the current smoke only watches the
  `net:squadPlate` event), mineral veins, the removal of a hand-placed tutorial corpse, the squad-abandon flow in a browser
  (relay selftest only), or the 2026-09-16 android behaviours (free roam · ping agreement · 앞장서라 doubling · engage
  range — `smoke-ally-*` checks the older items).
- `check-planet-loot`'s book-volume check (I > … > V) fails by construction: `LIBRARY_VOLUME_DROP_WEIGHT` only has
  volumes 1–3.
- Nothing compares `extraction`'s `GROUND_DRAW_LIFT_MAX` with a world's drawn ground lift (`world/tutorial` `TOP_LIFT`) —
  `smoke-extraction` checks the ship-side inequality only.

### Runner options (`node scripts/verify.mjs --help`)

- `--only a,b` · `--folders weapons,ui` · `--rerun-failed` (from `last-run.json`) · `--all` · `--list` · `--dry-run` (print the selection and why, run nothing).
- `--jobs N` (default 4; 6 is faster but adds timing reds — see “Why the run takes as long as it does” below) · `--serial` · `--base <ref>` · `--build` · `--no-typecheck` · `--no-e2e` · `--url` · `--timeout <min>`.
- `--log-dir scripts/logs/<name>` gives each concurrent runner its own logs and `last-run.json`; `--keep-relay` keeps a relay already on 8787.
- A **red run copies the failing jobs' logs to `<log-dir>/failed/`** (with that run's `last-run.json`). `scripts/logs/<name>.log` is
  overwritten by the next run of that script, so re-running a failure by hand used to destroy the only evidence of it (E-13);
  the copy is replaced only by the next **red** run.
- Unknown options and `--help` print help and **run nothing**.
- The runner starts its own relay with `SCAV_DEV_ECONOMY=1` so dev credit reasons (`smoke:*` · `e2e:*` · console · `shot`) are accepted.
  **A shared relay started by hand for parallel smokes needs `SCAV_DEV_ECONOMY=1`** — otherwise top-ups are reverted (the runner prints a note
  when `/health.devEconomy` is false).
- `data/<file>.csv` changes select smokes of the consuming folders (`data-owners.mjs`); `constants.csv` / `tables.csv` are wide and only print a note.
- **`src/shared` is judged by size, not by being touched.** ≤ `SHARED_NARROW_FILES` (2) changed `.ts` files **and** ≤ `SHARED_NARROW_FOLDERS` (3)
  feature folders → the runner greps the changed exports and adds the folders that use them (`sharedConsumers`); wider → everything, as before.
  `.md` under `src/shared` is ignored, and a change whose diff names no export at all falls back to everything. Raising the two constants trades
  safety for time: measured over the last 40 commits, the full run fires 29× under the old rule, 25× at (2, 3), and 18× at (3, no folder limit) —
  a wide commit selects 91 of 95 smokes through its own folders anyway, so the folder limit mostly buys the last handful.

## Why the run takes as long as it does

Measured 2026-09-16 on a Ryzen 7 7800X3D (8 cores / 16 threads) + RTX 4080 SUPER; the earlier numbers came from a 28-thread i7-14700K / RTX 4070 SUPER.

- **The biggest cost was not the tests.** A D3D11 Chrome closed while other smoke Chromes still render stays alive for up to ~2 min
  after CDP disconnects (0 CPU, threads in `LpcReply`), and `browser.close()` waits for it with no limit. Stuck closes are released
  together in ~120 s steps, which is why whole groups of smokes used to finish in the same second. `verify:all`: **26 min 46 s → 16 min 40 s**
  after `closeBrowser` (smoke process time 5476 s → 3287 s; time after the browser disconnected 2244 s → 17 s). Details in `close-browser.mjs`.
- **The same stall came back as a hang, and it was the “middle group runs at 2×”** (2026-09-17, measured on the 28-thread i7-14700K).
  `taskkill /T /F` does not reap a chrome process sitting in a kernel wait: two per browser (gpu-process + crashpad-handler) survived,
  `browser.close()` waited for them with no limit, and **8 of 8 smokes in two 4-lane runs stopped right after their last check**
  without printing `N passed` — still alive 30 min later, with the runner holding the lanes. While they lived, WMI `Win32_Process`
  enumeration timed out too; killing them released every stuck smoke at once. With the 5 s give-up in `closeBrowser`, the same
  16-script · 4-lane set that ran 89·99·83·89 s → **141–157 s** → 59–64 s now runs 89·82·88·101 s → **64–84 s** → 56–60 s
  (5 min 6 s total, 16/16 green, no chrome process and no temp profile left behind).
- The rest is **simulation time**. Smokes wait on `ctx.time`; pages run at ~55–60 fps on 4 lanes, so game time ≈ wall time.
  `Engine.MAX_DT = 0.05` puts a **20 fps floor** under it: below 20 fps the game clock runs slower than the wall clock.
- **The lane numbers are per machine.** The reds below are from the 8-core/16-thread box. Measured 2026-09-17 on the 28-thread
  i7-14700K: a 9-script pool at `--jobs 8` (`smoke-tutorial-raid` and `smoke-lights` included) passed with two `smoke-desktop`
  runs alongside it. Re-measure `--jobs` on the machine you run on instead of quoting a number from here.
- **Lanes: 4 is the default, 6 is faster but less reliable.** `--jobs 6` = 12 min 56 s, with more time under 20 fps (292 s vs 210 s
  over all pages) and three timing reds that 4 lanes do not show (`smoke-ladder` climb speed, `smoke-tutorial-raid` HUD fade value
  — that one was not a timing limit but a one-frame race in `ui`, fixed 2026-09-17 —,
  `smoke-rover` turret hit). The older "8 lanes is slower" result (18 min 30 s → 20 min 00 s) most likely included the close stall (its "groups finish in the same second" is that symptom),
  which grows with lane count — do not quote it as the frame-rate limit.
- The exclusive scripts run one at a time after the pool (~3.5 min: `smoke-hangar` · `smoke-squad-dock` · `smoke-android-lobby` ·
  `smoke-desktop` · `e2e-mp`).
- Before believing a slow run, re-run it; another app holding the fast cores slows the smoke Chromes for as long as it lasts.
- To make the suite faster from here, cut the simulated seconds a smoke waits through (fewer full reboots — `smoke-raidflow` has 8 page
  loads — and shorter scripted waits), or cut per-frame cost so more lanes stay above the 20 fps floor.

## Recent changes

Older: `git log -- scripts` (full previous README: `git show 3949d37:scripts/README.md`).
- 2026-09-19 — `smoke-allies-orders`: `window.__ping` gained `containerId` (crate pings name their container by id, not by
  the display label), the crate step asserts the android latched onto **that** container, and a new step 6b covers the item
  ping → ground pickup path that had never been exercised (TODO B-61).
- 2026-09-17 — `closeBrowser` no longer waits on a stuck `browser.close()` (5 s, then it deletes the temp profile itself) and `verify.mjs` sweeps stale profiles: the middle group of a 4-lane run no longer runs at 2× (E-12).
- 2026-09-17 — 「Known gaps in the net」 collects what nothing checks (moved out of `docs/TODO.md`); `smoke-tutorial-raid` is mapped to `ui` as well — its liftoff HUD frames are ui's.
- 2026-09-17 — `verify.mjs` keeps a red run's logs in `<log-dir>/failed/`; `smoke-desktop` says **why** a boot timed out (listening
  pids, process alive, last fetch error, and whether the port comes up late at all) and notes any boot slower than 3 s (E-13).
- 2026-09-16 — New `close-browser.mjs`; every smoke and `e2e-mp` closes Chrome through `closeBrowser` (kills the process tree first) — `verify:all` 26 min 46 s → 16 min 40 s on this machine.
- 2026-09-16 — `verify.mjs`: a `src/shared` change no longer selects everything by itself — narrow ones pick the folders that use the changed exports (`sharedConsumers`); new `--dry-run`.
- 2026-09-16 — `verify.mjs`: `net:selftest` now runs alongside the smokes (it used to hold the browsers back ~50 s), and the lane start times share one 24 s ramp budget instead of 8 s per lane; measured why `--jobs` must stay at 4.
