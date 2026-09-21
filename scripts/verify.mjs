#!/usr/bin/env node
/**
 * Verification runner — the one command to run after a change.
 *
 *   node scripts/verify.mjs                      # --changed: smokes for the folders touched in the working tree
 *                                                #   (a narrow src/shared change picks the folders that use the changed exports;
 *                                                #    a wide one still goes full — see the comment at GLOBAL_PATHS)
 *   node scripts/verify.mjs --all                # everything (typecheck, build, selftest, every smoke in SMOKES, e2e) — before a merge
 *   node scripts/verify.mjs --folders weapons,ui # smokes mapped to those feature folders
 *   node scripts/verify.mjs --only smoke-weapons,e2e-mp
 *   node scripts/verify.mjs --rerun-failed       # only what failed in the previous run (scripts/logs/last-run.json)
 *   node scripts/verify.mjs --list               # folder → smoke map (+ the path mappings outside src/)
 *   node scripts/verify.mjs --dry-run            # what the current change would run, and why — runs nothing
 *   node scripts/verify.mjs --help               # this text (an unknown option prints it too and runs nothing)
 *
 * Options: --jobs N (parallel Chrome instances, default 4 — 6 is faster but adds timing reds, see the note at `opts.jobs`;
 *          use 1–2 with SMOKE_GL=swiftshader, which is CPU-bound) · --serial · --base <git ref> (diff base for --changed,
 *          default = working tree vs HEAD, falling back to HEAD~1) · --build · --no-typecheck · --no-e2e ·
 *          --keep-relay (do not restart a relay already listening on 8787) · --url http://host:port/ · --timeout <min> ·
 *          --log-dir <dir> (default scripts/logs — give each concurrent runner its own, e.g. scripts/logs/agent-3)
 *
 * What it does:
 *   1. typecheck (client + server), data:check (the data/*.csv schema) and check-css-prefixes (one prefix, one folder) in parallel — seconds. net:selftest (~50 s, its own
 *      random port) runs **alongside the smokes** and is awaited just before the summary.
 *   2. Starts vite (5273) and the relay (8787) if they are not up — **unless every selected script is `standalone`**
 *      (smoke-pitch, smoke-desktop, smoke-intel), which use neither. When e2e-mp is in the set the relay is always
 *      restarted first: public lobbies left by an interrupted run live for the 5-min grace and hijack quick match.
 *   3. Runs the selected smoke scripts concurrently (each owns its own headless Chrome on the real GPU via ANGLE D3D11,
 *      40–90 s each; the lanes' start times share one ~24 s ramp budget, so vite warm-up and Chrome launches never coincide). Output goes to
 *      scripts/logs/<name>.log; only the summary and the FAIL lines are printed. SMOKE_GL=swiftshader (no GPU / CI) is
 *      ~10× slower and CPU-bound: measured 2026-09-06, one script ≈ 140 s alone and 2 lanes gained nothing (31 min total).
 *   4. e2e-mp runs alone at the end (two browsers, 15 s waits — sensitive to CPU contention).
 *   5. Writes scripts/logs/last-run.json and prints a one-line result string ready to paste into the commit message (its `검증:` line).
 *   Servers started here are stopped on exit; servers found running are left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, readdirSync, existsSync, createWriteStream } from 'node:fs';
import { CSV_FOLDERS, CSV_WIDE } from './data-owners.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `--log-dir <dir>` (2026-09-11): so that several agents running in the same tree at once never overwrite each other's logs · last-run.json.
const LOG_ARG = process.argv.indexOf('--log-dir');
const LOG_REL = (LOG_ARG >= 0 && process.argv[LOG_ARG + 1] ? process.argv[LOG_ARG + 1] : 'scripts/logs').replace(/\\/g, '/').replace(/\/$/, '');
const LOG_DIR = resolve(ROOT, LOG_REL);
const LAST_RUN = resolve(LOG_DIR, 'last-run.json');
const isWin = process.platform === 'win32';

// ─── Job catalogue ─────────────────────────────────────────────────────────────────────────────────────────────
// `folders` = feature folders (src/<name>, or `server`) whose changes make this script relevant.
// `standalone: true` = neither vite nor the relay is used, so the runner does not start them.
// When a smoke is added, also add its row to scripts/README.md.
const SMOKES = {
  'smoke-weapons':      { file: 'scripts/smoke-weapons.mjs',      folders: ['weapons', 'items', 'inventory', 'hub', 'pickups', 'audio'] },
  /* 2026-09-14 (every bullet a projectile): a 150 m drop ≈ ½·g·t² · arrival ≈ d/v · falloff by travelled distance · a wall
     right in front of the muzzle is hit at once · every shotgun pellet fired · the hits · one reportShot per trigger · no
     tunnelling at 650 m/s over a 50 ms step (a thin post · an enemy) · the barrier stops it · laser sight aim / return · the
     extended barrel socket · the pool growing · a cloned round evicted first · bloomPerShot / swayMul · no extra shader
     program on the first shot. The stats are overwritten on the instance, so the csv numbers do not come into it. */
  'smoke-ballistics':   { file: 'scripts/smoke-ballistics.mjs',   folders: ['weapons', 'items'] },
  'smoke-phase2':       { file: 'scripts/smoke-phase2.mjs',       folders: ['player', 'weapons', 'inventory', 'game', 'ui'] },
  'smoke-quickslots':   { file: 'scripts/smoke-quickslots.mjs',   folders: ['inventory', 'ui', 'weapons'] },
  'smoke-phase3':       { file: 'scripts/smoke-phase3.mjs',       folders: ['stratagems', 'world', 'ui', 'weapons'] },
  'smoke-stratagems':   { file: 'scripts/smoke-stratagems.mjs',   folders: ['stratagems', 'world'] },
  'smoke-phase4':       { file: 'scripts/smoke-phase4.mjs',       folders: ['enemies', 'items', 'world', 'inventory', 'weapons', 'player'] },
  'smoke-tactical':     { file: 'scripts/smoke-tactical.mjs',     folders: ['implants', 'gadgets', 'progression', 'player', 'world', 'enemies', 'inventory', 'items', 'weapons', 'audio'] },
  /* 2026-09-12 (agent D): the ground-drone scan — aiming · a 3 s hold · aiming away resets it · the grade = the contents when
     opened · the label · the chat line · a left click does not leak into the gun · previewing an enemy corpse / supply crate /
     structure container ≡ opening it · the label disappears on a raid reset. */
  'smoke-drone-scan':   { file: 'scripts/smoke-drone-scan.mjs',   folders: ['gadgets', 'inventory'] },
  'smoke-controls-hub': { file: 'scripts/smoke-controls-hub.mjs', folders: ['ui', 'hub', 'inventory', 'implants', 'progression', 'player', 'net'] },
  'smoke-ship-rooms':   { file: 'scripts/smoke-ship-rooms.mjs',   folders: ['hub', 'housing'] },
  'smoke-inventory-p6': { file: 'scripts/smoke-inventory-p6.mjs', folders: ['inventory', 'housing', 'items'] },
  'smoke-loadout':      { file: 'scripts/smoke-loadout.mjs',      folders: ['inventory'] },
  'smoke-search':       { file: 'scripts/smoke-search.mjs',       folders: ['inventory'] },
  /* 2026-09-11 (the greenhouse rework): `items` added — the grow-station checks use the soil (`soil_*`) · seed (`seed_*`) ·
     crop (`crop_*`) defs directly. `ui` added — this is the only place that asserts the soil's `속성` · `수확` rows and a
     seed's `맞는 토양` row (`ui/hud/ItemTip`). */
  'smoke-housing':      { file: 'scripts/smoke-housing.mjs',      folders: ['housing', 'hub', 'inventory', 'progression', 'items', 'ui'] },
  'smoke-console':      { file: 'scripts/smoke-console.mjs',      folders: ['console', 'progression', 'inventory', 'player', 'hub'] },
  'smoke-progression':  { file: 'scripts/smoke-progression.mjs',  folders: ['progression'] },
  'smoke-ui-p6':        { file: 'scripts/smoke-ui-p6.mjs',        folders: ['ui'] },
  'smoke-ui-p5':        { file: 'scripts/smoke-ui-p5.mjs',        folders: ['ui', 'meta', 'game'] },
  'smoke-uniques':      { file: 'scripts/smoke-uniques.mjs',      folders: ['weapons', 'items', 'enemies', 'player', 'ui'] },
  'smoke-rogue-v2':     { file: 'scripts/smoke-rogue-v2.mjs',     folders: ['enemies'] },
  'smoke-humanoid-ai':  { file: 'scripts/smoke-humanoid-ai.mjs',  folders: ['enemies'] },
  'smoke-enemy-alert':  { file: 'scripts/smoke-enemy-alert.mjs',  folders: ['enemies', 'implants', 'weapons'] },
  /* 2026-09-15 (android squadmates, the enemy side): an injected android body becomes a side target list (outside
     `all`/`alive`) that humanoids aim at and fire on, contact · explosions · fire zones reach it, `applyAllyHit` wakes an enemy
     with no kill credit, `ally:fired` sounds like a shot, and `shared/cover.pickCoverSpot` picks a spot behind a real obstacle.
     It uses only the debug injection, which runs without allies/. */
  'smoke-enemy-allies': { file: 'scripts/smoke-enemy-allies.mjs', folders: ['enemies', 'allies'] },
  'smoke-rogue-drop':   { file: 'scripts/smoke-rogue-drop.mjs',   folders: ['enemies', 'world'] },
  /* 2026-09-13 (per-planet enemy factions · spawn-director): threat 1/2/3 × seed — the site group's faction · the group
     count · the headcount · indoors · a squad leader ≤ 1 · one raider flanker · no crate guards · the same seed = the same
     layout · the named chance · the faction. It goes through world's getSiteSpawnPoints too. */
  'smoke-faction-sites': { file: 'scripts/smoke-faction-sites.mjs', folders: ['enemies', 'world'] },
  'smoke-resume-gate':  { file: 'scripts/smoke-resume-gate.mjs',  folders: ['game', 'ui'] },
  'smoke-meta':         { file: 'scripts/smoke-meta.mjs',         folders: ['meta', 'inventory', 'hub', 'ui', 'game'] },
  /* 2026-09-14 (the messenger · NPC quests): first contact · offers in order · deferred → accepted (brief) · a split
     delivery · the report reward · raid objectives (the last-hit family · a discover+investigate chain · interaction · recovery
     at extraction · the planet condition · the rollback at raid end) · the real plumbing (damageSource →
     enemy:killed.weaponClass) · getQuestState · saving · cleanup. */
  'smoke-npc-quests':   { file: 'scripts/smoke-npc-quests.mjs',   folders: ['meta', 'enemies', 'world', 'weapons'] },
  /* 2026-09-12 (E2): the right-click favourite menu on an item chip (delegation · the ribbon · repainting on an event ·
     Escape) · the corp shop tile opt-in · selling a favourite is confirmed once more (a 1 s hold · Escape cancels · bulk
     staging excepted) · the recovery contract for one item (the chip on the contract row · settling what is carried).
     Stubbed when the E1 API is absent. */
  'smoke-favorite-chips': { file: 'scripts/smoke-favorite-chips.mjs', folders: ['meta', 'ui', 'inventory'] },
  /* 2026-09-12 (§5-2): the item recovery contract — only what was found in this raid counts · it never merges with a stack
     brought along · the same ribbon (only during a raid) · splitting / the ground-pickup wire / the corpse wire / the raid blob
     keep the mark · another item mixed in leaves no mark · the settlement · returning to the ship removes the mark and zeroes
     the progress · the training range carries no mark. */
  'smoke-recovery-contract': { file: 'scripts/smoke-recovery-contract.mjs', folders: ['meta', 'inventory', 'pickups', 'game', 'world', 'enemies'] },
  'smoke-training':     { file: 'scripts/smoke-training.mjs',     folders: ['world', 'hub', 'housing', 'game'] },
  'smoke-ghost':        { file: 'scripts/smoke-ghost.mjs',        folders: ['player', 'net', 'game'] },
  /* 2026-09-11: the ladder (grabbing · W/S · sprint stamina · the mount at the top · E to let go · jumping · stepping off
     at the foot · the weapon lock · the CLIMBING bit) + step smoothing (`bodyOffset`) + the world ceiling clamp. It runs on a
     fake `LadderDef`, so world's ladders need not exist. */
  'smoke-ladder':       { file: 'scripts/smoke-ladder.mjs',       folders: ['player', 'net'] },
  /* 2026-09-12 (A-3a · A-3e): furniture poses — the refusal conditions · the feet pinned · input ignored · standing up with
     E (without hitting the neighbouring furniture's prompt) · the fixed-camera blend · the phase drive (the barbell's hand
     height · the pedal's foot height) · returning to the spot · spawnStanding / the reset on a phase change.
     It runs on anchors alone with no furniture model, so hub's furniture need not exist. */
  'smoke-pose':         { file: 'scripts/smoke-pose.mjs',         folders: ['player', 'hub'] },
  /* 2026-09-12 (A2): aim sway — 0 in the ship and from the hip · the figure-8 while aiming (the table's amount · the sign
     crossings) · the rendered camera === getLookDir · a 0-spread shot fired mid-sway lands on the screen's centre line ·
     recoil · aimSwayMul 0.5 · the crouch / prone / walk multipliers · the shoulder swap · the cutscene camera · release. */
  'smoke-aim-sway':     { file: 'scripts/smoke-aim-sway.mjs',     folders: ['player', 'weapons'] },
  'smoke-raidflow':     { file: 'scripts/smoke-raidflow.mjs',     folders: ['game', 'extraction', 'player', 'inventory', 'world'] },
  /* 2026-09-13 (the extraction rework): the 20 s call · 8 landed hull colliders · the enemy-only doorway block · the switch
     → a 10 s grace (uncancellable · boarding during it) → boarding and liftoff (the cutscene camera · `.hud.cinematic` · the
     result extracted) · left behind by the auto departure → reset → calling again · a corpse in the hold leaves with it. */
  'smoke-extraction':   { file: 'scripts/smoke-extraction.mjs',   folders: ['extraction', 'game'] },
  'smoke-library':      { file: 'scripts/smoke-library.mjs',      folders: ['housing', 'items', 'hub', 'inventory'] },
  /* 2026-09-13 (library series · video games — the hub side): the game disc stand · sofa · low table · rug · chair models
     (0 lights · seated facing −Z) · E on the TV screen · taking a seat · the game session staging (the seated pose · the fixed
     camera · the TV game screen · a refusal → cancelGameSession). The housing methods are stubs. */
  'smoke-tv-games':     { file: 'scripts/smoke-tv-games.mjs',     folders: ['hub'] },
  /* 2026-09-12 (the furniture screen rework): the shared frame of the grow station · analyzer · culture tank · dining
     table · the upgrade modal (a 1 s hold) · HH:MM:SS · right click · double click / drag to harvest, and one drop = one
     refresh. The grid is inventory's TradeGrids. */
  'smoke-stations':     { file: 'scripts/smoke-stations.mjs',     folders: ['housing', 'inventory', 'items'] },
  /* 2026-09-13 (placement rules — access faces): front (a wall · the front row) / sides (the narrow end allowed · the wide
     face refused · a wall on the wide face allowed) / all (a corner allowed) · a shared walkway · both directions · auto
     placement · an old placement → the furniture store + the soil · seeds in it refunded · the cockpit fixtures kept · the
     interaction direction (front / wide face) · the ghost cell tiles. */
  'smoke-furniture-access': { file: 'scripts/smoke-furniture-access.mjs', folders: ['housing', 'hub'] },
  /* 2026-09-13 (ingredient tiers · agent B): the pure rules (the defaults = the old formula · the ratios · the wear · the
     result-table draw) · the analysis is rolled the moment it goes in · collecting → XP · a level-up · the `분석 도감` ·
     soil / medium durability (the slot stays even at 0 · the ratio bonus) · fitting a socket / full / replacing · a scaffold →
     species meat · a retired strain refused · a save round trip · a meal's effects → derived (last, leniently). */
  'smoke-food-chain':   { file: 'scripts/smoke-food-chain.mjs',   folders: ['housing', 'items', 'progression'] },
  /* 2026-09-13 (the generator = the build gate — power allocation was dropped the same day, in place of the old
     smoke-power): no power API · a new ship at v13 · generator Lv.1–5 · the build gate per room purpose (room_purposes.csv
     generator · purposeBlock · purposeRequirements · a real setRoomPurpose + the materials consumed) · the furniture · storage
     upgrade gate · the generator upgrade costs from csv · sanitize (0 → 1 · 8 → 5 · fixtures under the level removed +
     refunded · the furniture store · no power fields) · a cluster with no main computer · the unlock line on the ship
     management generator row · no power row on the station screen · the reload path (the toast · the store refund). */
  'smoke-generator':    { file: 'scripts/smoke-generator.mjs',    folders: ['housing', 'ui'] },
  /* 2026-09-13: the crypto mining rules — the cluster cycle · the wallet · cores · a locked coin · collection refused · save cleanup (housing `parts/Mining` · `MiningRules`, items' processors · compute cores) */
  'smoke-mining':       { file: 'scripts/smoke-mining.mjs',       folders: ['housing', 'items', 'meta'] },
  /* 2026-09-14: pinning a tooltip — the 1 s hold ring (`ui:cursorHold`) → the pinned card + the diamond · released by a
     press outside / the diamond / Escape / closing the window / the item disappearing · a short press = a click · moving past
     the threshold = a drag · only the receiving sockets of a pinned weapon card (the middle) · the socket hover card · dragging
     out into a bag / stash cell (a blocked cell refuses) · a crate weapon hovers only · the durability gauges (every durability
     tile · the colour · no number) · pinning on the corp tab's TradeGrids. */
  'smoke-tip-pin':      { file: 'scripts/smoke-tip-pin.mjs',      folders: ['inventory', 'ui'] },
  /* 2026-09-12 (E1): item favourites — the API · the events · right click = a menu on every item (the grid · an equipment
     slot · the wheel · a corpse window) · double-click quick move · the blue ribbon (bag · stash · equipment slot · TradeGrids ·
     buildItemTile, together with the yellow one when it is needed ammo) · sorted to the front · the 「즐겨찾기」 chip ·
     the 1 s hold on the salvage confirm · the corpse-window glow · the loadout's `fav` saved / reloaded / a server document
     swap + protecting a toggle that was never uploaded. */
  'smoke-favorites':    { file: 'scripts/smoke-favorites.mjs',    folders: ['inventory'] },
  'smoke-library-consumers': { file: 'scripts/smoke-library-consumers.mjs', folders: ['inventory', 'meta', 'game', 'console', 'ui'] },
  /* 2026-09-12 (A-3a): the gym — gymBlock's reasons · the three minigame judgements (with no screen) · the session flow
     (the blocker · ESC · the key guide · Space never reaching Input) · the applyGymSession result + the soreness · 0 XP while
     sore · cancelling · surviving a reload. */
  'smoke-gym':          { file: 'scripts/smoke-gym.mjs',          folders: ['housing', 'progression', 'hub', 'player'] },
  /* 2026-09-13 (video games, H2): the TV seat rule matrix · the judgement tuning · mounting/replacing/collecting a console · the game list · a game session (intelligence · perception) · the debuff · cancelling. */
  'smoke-video-games':  { file: 'scripts/smoke-video-games.mjs',  folders: ['housing', 'progression', 'hub', 'items'] },
  /* 2026-09-13 (the cooking minigame): the six judgements (with no screen) · cookBlock's reasons · the cook bench level
     lock · the cook bench screen (the rail · the step chips) · the session (the blocker · ESC · a real pointerdown chop) ·
     the result = a meal of that quality into the stash · the ingredients taken at the end · two meals of different quality ·
     cancelling = the ingredients untouched · the auto appliances Lv.1/2/3 · the dining table's quality row · surviving a
     reload · the derived bonus of the meal eaten before launch. */
  'smoke-cooking':      { file: 'scripts/smoke-cooking.mjs',      folders: ['housing', 'inventory', 'progression', 'hub', 'player'] },
  /* 2026-09-13 (the crypto mining screens): the compute cluster screen (a 3×3 core grid to drop into · right click / double
     click to pull one · assigning a coin · a 1 s hold warning when there is progress · a locked coin refused · the rail) · the
     main computer (the status · the wallet · the exchange — the chart on stubbed quotes · the hover OHLC · the period ·
     candles/line · watch reference counting · a 1 s hold trade blocked by the quote's reason · a locked coin · the offline
     text) · Tab / Esc to close · the two furniture models · as many lit slots as there are cores · the point-light count
     unchanged. */
  'smoke-mining-ui':    { file: 'scripts/smoke-mining-ui.mjs',    folders: ['housing', 'hub'] },
  /* 2026-09-12 (character buffs): the PC vitals block shows in the ship too · the buff thumbnail row under the hp bar
     (dimmed · the debuff border · the time gauge · the DOM reused by key) · the mini row on a squadmate row (a debug remote
     ref) · the old three badges are gone · shrunk in a raid slot / the drone view. */
  'smoke-buffs':        { file: 'scripts/smoke-buffs.mjs',        folders: ['ui', 'player', 'net'] },
  /* 2026-09-12 (A1): the three combat boosts — `아드레날린` (all the stamina · 0 drain) · `각성제` (reload · aiming · the
     sway multiplier · +50 % drain) · `안정제` (`refillAll`), the hold starts even at full hp · the `boost` buff entry · the HUD
     thumbnail · expiry · they cancel each other · the recipes · a rogue corpse. */
  'smoke-consumables':  { file: 'scripts/smoke-consumables.mjs',  folders: ['weapons', 'player', 'items'] },
  'smoke-enemy-delta':  { file: 'scripts/smoke-enemy-delta.mjs',  folders: ['enemies', 'net'] },
  /* Phase 11 */
  'smoke-planets':      { file: 'scripts/smoke-planets.mjs',      folders: ['hub', 'world', 'game'] },
  'smoke-social':       { file: 'scripts/smoke-social.mjs',       folders: ['ui', 'net'] },
  /* 2026-09-14 (the messenger): the P panel = the conversations (NPC · private chat · group rooms) · friends · quest tabs,
     the unread badge on a thumbnail, a quest card accepted / deferred · delivered · reported, a group room's log · sending ·
     inviting · renaming · removing · leaving (a 1 s hold), the NPC message toast, screenshots at two resolutions. */
  'smoke-messenger':    { file: 'scripts/smoke-messenger.mjs',    folders: ['ui', 'meta', 'net'] },
  'smoke-rooms':        { file: 'scripts/smoke-rooms.mjs',        folders: ['net'] },
  'smoke-ecology':      { file: 'scripts/smoke-ecology.mjs',      folders: ['world', 'enemies', 'items'] },
  /* 2026-09-09: measures **numerically** whether a prop's collider exceeds the silhouette it draws. `Props.hullOf` builds
     the collider from a bounding box, so an accident on the geometry side (→ the order of `noise3`'s lerp arguments) becomes
     an invisible wall. */
  'smoke-props-collision': { file: 'scripts/smoke-props-collision.mjs', folders: ['world'] },
  /* 2026-09-09: abandoned structures · rails · trams. In the same spirit it measures whether the **box (OBB) colliders**
     sit inside the drawn silhouette, and looks at moving indoors · the basement hatch · the platform deck · the tram deck
     speed as well. */
  'smoke-structures':   { file: 'scripts/smoke-structures.mjs',   folders: ['world', 'items', 'inventory'] },
  /* 2026-09-12: structure **reachability** — the spots a person cannot get through although the collider is inside what is
     drawn (a 0.8 m gap at a stair entrance · a door a railing blocks · stairs that open outwards only), measured over several
     seeds by a body-radius flood fill (the real `getSurfaceY` + `resolveCollision`). */
  'smoke-structure-reach': { file: 'scripts/smoke-structure-reach.mjs', folders: ['world'] },
  /* 2026-09-21 (TODO A-18): the shared nav graph — every path **walked** with the movers' own world queries (door ·
     floor 2 · the roof by its ladder · a locked room before and after it opens), `walkable` through a wall, the search
     cost, and an android told to go to floor 2 and to a roof getting there (the second one up the ladder). */
  'smoke-nav':          { file: 'scripts/smoke-nav.mjs',          folders: ['world', 'allies'] },
  /* 2026-09-21 (TODO A-18 phase 2): real enemies on that graph — a pack chasing a player on floor 2 comes in through
     the doors (a warrior never does), scavengers climb to a player on the roof and break a pane to cross a window,
     and no gate ever holds more than `NAV_GATE_CAPACITY` tokens. */
  'smoke-enemy-nav':    { file: 'scripts/smoke-enemy-nav.mjs',    folders: ['enemies', 'world'] },
  /* 2026-09-13 (per-planet enemy factions · world-sites): the site spawn spots — `getSiteSpawnPoints` indoors (on a
     building floor · inside the walls · outside a locked room · walkable from the front door) · outdoors (outside a footprint ·
     outside the rail corridor · no collision) · platforms · ruins · determinism · minGap · an empty answer on the training
     range. */
  'smoke-site-spawns':  { file: 'scripts/smoke-site-spawns.mjs',  folders: ['world', 'enemies'] },
  /* 2026-09-09: hazards — the kind and the start time are functions of the seed, so there is no wire. Seed determinism ·
     the shape conventions · the map being sealed off once it has run its course · the damage per second · atmo:override · the
     giant mushroom cluster, all measured inside the browser. */
  'smoke-hazard':       { file: 'scripts/smoke-hazard.mjs',       folders: ['world'] },
  /* 2026-09-08: the tutorial — its gates sit inside housing / hub / inventory / meta's refusal-reason functions, so
     touching one of those folders runs it too. Every other smoke starts with `scav.s1.tutorial` seeded as done. */
  'smoke-tutorial':     { file: 'scripts/smoke-tutorial.mjs',     folders: ['tutorial', 'hub', 'housing', 'inventory', 'ui', 'items'] },
  /* 2026-09-15 (E-12): the tutorial raid track end to end — checkpoint respawns · the respawn spot after a fatal fall ·
     kill/clamp · immediate liftoff → the settlement (TUTORIAL_RAID_XP) → what the ship gains. smoke-tutorial drives the build
     track only. Between stretches it teleports; only a judged action (a fall · a switch) is real input.
     2026-09-16: the armor shield + a natural fall → hp damage · supplyLoot holds even when the wall is passed hurt · a bandage
     really used → grenade · the crosshair at 0 on every liftoff frame · the code-stepped HUD fade.
     2026-09-17: `ui` added — the crosshair · HUD fade checks on the liftoff frames belong to ui/, so they have to run on a
     ui-only change too. */
  'smoke-tutorial-raid': { file: 'scripts/smoke-tutorial-raid.mjs', folders: ['tutorial', 'world', 'game', 'extraction', 'player', 'enemies', 'ui'] },
  /* 2026-09-15 (E-12): the tutorial ship track — levelUp → stats (＋ · the 1 s hold confirm) · restored after a reload.
     2026-09-16: the messenger step is out — the track ends only once the screen is closed after confirming · an old save with
     messenger / ravenQuest reads as done · Raven comes after the tutorial. */
  'smoke-tutorial-ship': { file: 'scripts/smoke-tutorial-ship.mjs', folders: ['tutorial', 'meta', 'ui', 'progression', 'inventory'] },
  /* 2026-09-15 (E-12 · B-14): global fall damage — the damage formula by height · the safe height · the shield first · a lethal fall · a body something else lifted is exempt + the feedback (the landing sound · the shake · the vignette). */
  'smoke-fall-damage':  { file: 'scripts/smoke-fall-damage.mjs',  folders: ['player', 'audio', 'ui', 'world'] },
  /* 2026-09-15 (B-16 · a user's bug report): fire zones — do the `화염수류탄` · the G-10 incendiary grenade really raise a fire zone · the damage · drone damage · the sound · expiry. */
  'smoke-fire-zones':   { file: 'scripts/smoke-fire-zones.mjs',   folders: ['gadgets', 'weapons', 'items', 'enemies', 'audio'] },
  /* 2026-09-15 (the sandworm · the thumper): the thumper — the catalogue · the preview ≡ placement (bare ground green · a
     roof red, `burrowGroundOk`) · 1 s strikes (the sound · the shake) · one `sandworm:summon` on the fifth strike · not
     recoverable · destroyed only inside an eruption radius · re-placeable · the wire's age. */
  'smoke-thumper':      { file: 'scripts/smoke-thumper.mjs',      folders: ['gadgets', 'world', 'enemies', 'items'] },
  /* 2026-09-15 (android squadmates — the raid hooks): the android bag (placement · merging · overflow on a resize) · the
     same weight formula as a person's · the container preview ≡ what the android takes (the taken state · the opened look ·
     `container:itemTaken.by`) · the four item-request payloads · the container-window event · `takeBy` on a ground item ·
     the extraction pad list / pressing the console / the boarding point · the looting container list ·
     `nearestSafePoint` per hazard shape · depositing into the stash. It calls the contracts directly, with no `ctx.allies`. */
  'smoke-ally-hooks':   { file: 'scripts/smoke-ally-hooks.mjs',   folders: ['inventory', 'pickups', 'extraction', 'world', 'gadgets', 'stratagems'] },
  /* 2026-09-14: the character confirm popup (the summary card · the value/5 gauges · a still face thumbnail · a 1 s hold) →
     a reload → the tutorial opening — the black fade passes through intermediate values in code (under reduced motion too) ·
     the cutscene really **ends** (the negative-timer bug) · the camera carries on into the back view · the compass is 0 and Tab
     is blocked during it → afterwards the compass fades in · Tab opens · no clock and no extraction timer for the whole
     tutorial raid. */
  'smoke-intro-wake':   { file: 'scripts/smoke-intro-wake.mjs',   folders: ['player', 'tutorial', 'ui', 'inventory'] },
  /* 2026-09-08: the shared ship hangar — it needs two clients (visiting a personal ship · the `hs` co-presence rule). It
     uses the relay, so it runs exclusive like e2e. */
  'smoke-hangar':       { file: 'scripts/smoke-hangar.mjs',       folders: ['hub', 'net', 'housing', 'player'], exclusive: true, freshRelay: true },
  /* 2026-09-15 (squads · dock matching): three clients — an invite → an undocked squad (each in their own personal
     ship · no hub snapshots · the squad HUD reading `개인 함선`) · the launch pod / training lock · a member's requestDock
     refused · the leader docking = an immediate fade / the member's countdown on the right → every open screen closed →
     docking · joining a public match alone · undocking moves only me · accepting an invite into a docked squad = the
     countdown · a private match alone. It starts its **own** relay on 8894 (the working tree's server/index.ts) — it does not
     restart the shared 8787, so it is not freshRelay. Three browsers, so exclusive. */
  'smoke-squad-dock':   { file: 'scripts/smoke-squad-dock.mjs',   folders: ['net', 'hub', 'server'], exclusive: true },
  /* 2026-09-15 (android squadmates): the bot lobby member's contract — `setAndroidBay` recruits three units (bot · bay ·
     ready · its own slot) · a bot is no person (`net:peerJoined` · no remote avatar) · a human joining sends the latest
     recruited unit back to its bay (`net:androidReturned` reaches the newcomer too) · a member gets not_host · a full squad
     gets full and the notice goes to the requester only · dismissal · a human leaving. It starts its **own** relay on 8896.
     Two browsers, so exclusive. */
  'smoke-android-lobby': { file: 'scripts/smoke-android-lobby.mjs', folders: ['net', 'server'], exclusive: true },
  /* 2026-09-15 (android squadmates — hub): the three cockpit bays (their places · the yaw facing the deck · `exit` · the
     capsule collider · `hub_android_<bay>` on a 3 s hold) · the prompts (recruit / dismiss · a non-leader is refused through
     the prompt) · the bot launch slot (ready with no avatar · an `is-bot` card · right click refused) · `getPodStandPose` ·
     the match tab's bot tile · the raid-entry fade (the countdown → the fade hold + `raid:loadBegin` → the delayed launch,
     un-readying has no effect). It stands in the shared ship through `HubSystem.debugSharedShip` with no relay lobby — one
     browser. */
  'smoke-android-bays': { file: 'scripts/smoke-android-bays.mjs', folders: ['hub'] },
  /* 2026-09-15 (android squadmates — allies): the cheat roster (`/android 1`) · the bodies in the personal ship · the solo
     raid drop pod · the bound base kit · hp ×ALLY_HP_MUL · coming back into the harness and it halving while the leader holds
     one heading · sensing → the enemy ping → a burst → `applyAllyHit` · damage → downed → revived → bleeding out →
     `spawnAllyCorpse`. A check whose contract member in another folder is missing is the only thing skipped. */
  'smoke-allies-core':  { file: 'scripts/smoke-allies-core.mjs',  folders: ['allies'] },
  /* 2026-09-15 (android squadmates — the allies orders): the leader's move / `주의` pings · first-one-wins requests and the
     cooldown · the chat line for a thing it does not have · a heal request → the ping → approaching → dropping it · crate
     looting, and stopping when a person opens the box · an extract ping → the second call → pressing the console. */
  'smoke-allies-orders': { file: 'scripts/smoke-allies-orders.mjs', folders: ['allies'] },
  /* 2026-09-10: the pitch wiki (`docs/pitch/`) — it has no build, so it stays quiet when it breaks. Using neither vite nor
     the game, it serves `docs/pitch` statically and opens every page (the links · the sidebar · nextnav · card flipping).
     `folders` cannot catch it (it is outside `src/`), so `EXTRA_PATHS` above picks it straight from a `docs/pitch/` change. */
  'smoke-pitch':        { file: 'scripts/smoke-pitch.mjs',        folders: [], standalone: true },
  /* 2026-09-14 (the intel broker): does a bought fixed gimmick really apply that many times · the same seed · does planning
     twice with the intel give the same thing · does a gimmick leave the sections drawn **before** it unmoved · does the
     preview (`WorldRef.previewLayout`) say the same as the plan. It uses no browser — headless vite SSR-loads
     `src/world/preview.ts` and only builds the layout (standalone). */
  'smoke-intel':        { file: 'scripts/smoke-intel.mjs',        folders: ['world', 'meta', 'enemies', 'hub'], standalone: true },
  /* 2026-09-10: the scene's point-light count. Change that number during play and every material in the scene recompiles
     its shader, stalling a frame — the extraction ship · a flare · the hellpod · the squad-leader device have been caught in
     this net so far. It is mapped to every folder that holds a light. */
  'smoke-lights':       { file: 'scripts/smoke-lights.mjs',       folders: ['extraction', 'player', 'game', 'hub', 'world', 'core'] },
  /* 2026-09-11 (the C batch): the named rogue judgements (prone Rodin's laid-down capsule · a buried flash hider · adopting
     the scan drone on promotion · the replica heavy's tracer · the replica hook's host) and enemies on a tram · a corpse riding
     one (+ the replica prediction · the drop target platform). Both run with no relay. */
  'smoke-named':        { file: 'scripts/smoke-named.mjs',        folders: ['enemies', 'weapons'] },
  /* 2026-09-13: bug burrow spawns (the first placement excluded · patrolling · no attacking/moving · no duplicate shakes ·
     the replica's em · the arc of a spat body) and the sandworm event (the threat roll · the warning rumble growing · the
     eruption's damage/knockback · the spit · the toxin · the corpse on a kill · the replica → promotion · the extraction wave
     removed). Both run with no relay. */
  'smoke-burrow':       { file: 'scripts/smoke-burrow.mjs',       folders: ['enemies', 'audio'] },
  /* 2026-09-18 (user's decision): explosions · melee do not pass through a wall · roof · floor — the judging functions
     (boxes in the sky: a wall · low cover · a wall face · a roof · the floor above) and the real paths (an enemy's explode ·
     a shell → the player · an enemy's hitTarget · the player's melee). The call sites are spread over four folders. */
  'smoke-blast-occlusion': { file: 'scripts/smoke-blast-occlusion.mjs', folders: ['enemies', 'weapons', 'gadgets', 'stratagems'] },
  'smoke-sandworm':     { file: 'scripts/smoke-sandworm.mjs',     folders: ['enemies', 'audio', 'console'] },
  'smoke-tram-ride':    { file: 'scripts/smoke-tram-ride.mjs',    folders: ['enemies', 'world'] },
  /* 2026-09-13 (the rover R2): 4–5 stops · the dwell · boarding (the prompt · the hold · riders · the stop revealed ·
     opening the destination picker) · the fare (in steps of 10 · the range) · paying → the credits deducted → a 5 s grace →
     the trip · boarding refused while it moves · forced off on arrival (beside the destination) · the loop departing + the
     turret firing · damage · destruction (riders get off · targetable false · boarding refused). The console `rover` cheat
     (`cheat:rover`) shortens the waits. src/world/rover belongs to the `world` folder. */
  'smoke-rover':        { file: 'scripts/smoke-rover.mjs',        folders: ['world', 'audio', 'console'] },
  /* 2026-09-14 (the messenger · NPC quests E): the tactical map's left column (the header → the quest panel → the legend at
     the bottom left → the row at the foot, the column's height = the canvas) · a fake NpcQuestRef panel · the raid objective
     rows · the gauges · the hover tooltip · updating on an event · scrolling at 6 tracks / hidden at 0 · hidden in
     destination-picking mode · the three quest toasts · a 1280×720 / 1920×1080 frame + screenshots. It runs with no relay. */
  'smoke-map-quests':   { file: 'scripts/smoke-map-quests.mjs',   folders: ['ui', 'meta'] },
  /* 2026-09-11 (E-4 + C-57 · X-6): the trust paths — two clients enter a raid through a **private lobby made by code** (not
     quick match) and measure a forged strat call / stratq call · the buff cap · spraying from behind a wall · the contract kill
     derivation · meta sync's rid · the crate opened distance · the knockback geometry · the hit request's DPS cap. It uses the
     shared relay but its own lobby, so it is not exclusive. */
  'smoke-trust':        { file: 'scripts/smoke-trust.mjs',        folders: ['stratagems', 'weapons', 'implants', 'gadgets', 'meta', 'enemies'] },
  /* 2026-09-11 (B-1): the link states · the anonymous background probe · the connection badge · no probe after a refusal ·
     the shell's target is probed too (2026-09-15). It does not use the shared relay (8787) but 9885 (a relay it starts and
     kills itself) · 9886 (a TCP port that never answers) — which is why it is not exclusive. */
  'smoke-netlink':      { file: 'scripts/smoke-netlink.mjs',      folders: ['net', 'ui', 'hub'] },
  /* 2026-09-11 (E-3): the desktop shell as **a real Electron** (`--hidden --user-data=<temp>`, window 8820 · the second
     window 8822 · the smoke relay 8823 · debugging 9340 · the main inspector 9341; 2026-09-15 the shell ships no server —
     checked through the bundle · the asar · the ports). It uses neither vite nor the shared relay, but it takes the GPU · the
     ports and runs a vite build when `dist/` is stale, so it runs alone. `folders` cannot catch it — `EXTRA_PATHS` picks it
     from `electron/` · `pack-release` · the smoke itself. */
  /* 2026-09-15 (raid-entry loading): launch → the black hold (the mission clock · the drop pod frozen) · progress to 1 ·
     the minimum black time · the fade-in · deploying → playing · with a fake squadmate that never finishes the host waits out
     the cap (debug hooks) · rejoining · the training range does not go through the gate. */
  'smoke-raid-loading': { file: 'scripts/smoke-raid-loading.mjs', folders: ['game', 'core', 'hub', 'ui'] },
  /* 2026-09-15 (android squadmates — the player side): the body is checked through an injected `AllyBodyView` — the android
     look (the head piece swapped) · the pose mapping · a hidden / dead body · the gun in hand · the armor plates · the body
     pool being reused · the `revive:ally:<id>` interaction → `requestRevive` · a PC carried by an android · the point-light
     count unchanged by the `ally:fired` shot FX · the android face portrait · with an android around a solo PC goes down
     rather than dying. It runs without allies/. */
  'smoke-ally-avatars': { file: 'scripts/smoke-ally-avatars.mjs', folders: ['player', 'allies'] },
  /* 2026-09-15 (android squadmates — the ui side): from a fake `ctx.allies` (`hud.debugAllies`) and bus events alone — the
     squad rows (the badge · the shield · a bot is never drawn as a human row) · the nameplates · the compass ticks · the map
     legend · `ally:ping`'s marker / callout / `ping:placedV3` · `ally:chat` is never relayed · the seven toasts · the loading
     gauge (above the black plate · squad progress · it spins even at dt 0 · it hides). */
  'smoke-ally-ui':      { file: 'scripts/smoke-ally-ui.mjs',      folders: ['ui', 'allies'] },
  /* 2026-09-20 (perf Phase B): holds 「no layout read inside a frame」 (CLAUDE.md §4.2) **by counting** — every accessor
     that forces layout is patched, the calls made while `Engine.frame` is on the stack are counted, and anything but 0 prints
     the file · function and fails. Ship frames · a 60-bug raid frame · and the chat/ping/notify/damage/hit-marker/animation-
     restart events fired **from inside** a frame. `hud/ChatLog` forced an 8.3 ms layout per line and stayed that way because
     this smoke did not exist. */
  'smoke-layout-reads': { file: 'scripts/smoke-layout-reads.mjs', folders: ['ui'] },
  'smoke-desktop':      { file: 'scripts/smoke-desktop.mjs',      folders: [], standalone: true, exclusive: true },
  'e2e-mp':             { file: 'scripts/e2e-multiplayer.mjs',    folders: ['net', 'server', 'game', 'extraction', 'hub', 'pickups', 'player', 'enemies'], exclusive: true, freshRelay: true },
};
// Anything under these paths touches the engine / bootstrap → run everything.
const GLOBAL_PATHS = [/^src\/core\//, /^src\/main\.ts$/, /^index\.html$/, /^vite\.config/, /^package\.json$/, /^tsconfig/];

/* 2026-09-16: `src/shared` is judged **by the size of the change**. Any file under shared used to push the run to
   everything (95 kinds · 18–21 min), and since 28 of the last 40 commits touched shared, seven runs in ten were the full one
   even when `verify` was typed to run 「only what is related」. Measured again, that escalation is **mostly right** — a commit
   that touches shared is usually a feature batch and really is wide (144 files · 15 folders → 91/95 smokes even when picked
   by folder alone, with shared left out). The waste was concentrated in the **narrow** commits: the contract commit
   `4e96c64` (6 files · 1 folder) cost 21 minutes. So it narrows by symbol only when the change is narrow. The symbol mapping
   is not used on a wide commit because it does nothing there — the changed exports swell into dozens and the consuming
   folders ran to a median of 17 out of 22 (effectively everything).
   `.md` is not counted: in shared the code and the README always change together, so a README must not sway the judgement. */
const SHARED_RE = /^src\/shared\//;
const SHARED_NARROW_FILES = 2;    // how many shared **code** files changed
const SHARED_NARROW_FOLDERS = 3;  // how many feature folders the same change touched

// Things that live outside `src/` — a folder name cannot catch them, so the smoke is picked straight from the path.
const EXTRA_PATHS = [
  { label: 'docs/pitch/', re: /^docs\/pitch\//, smokes: ['smoke-pitch'] },
  // 2026-09-11 (E-3): the desktop shell · the deploy folder · the smoke itself.
  { label: 'electron/', re: /^electron\//, smokes: ['smoke-desktop'] },
  { label: 'scripts/pack-release.mjs', re: /^scripts\/pack-release\.mjs$/, smokes: ['smoke-desktop'] },
  { label: 'scripts/smoke-desktop.mjs', re: /^scripts\/smoke-desktop\.mjs$/, smokes: ['smoke-desktop'] },
];

/* 2026-09-16: the lane start spacing is a **total budget**, not a **per-lane** one. The old 8 s × lanes threw away 24 s on
   4 lanes and 56 s on 8 — and in a set that finishes in one wave (`--only`, `--changed`) that was most of the run time.
   For its real purpose, keeping vite's warm-up from coinciding with the Chrome launches, 24 s in total is enough, and the
   ramp is the same however many lanes are given. */
const RAMP_BUDGET_MS = 24_000;

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
/* 2026-09-11: an unknown flag · --help prints the header comment and ends, **running nothing**. They used to be ignored
   silently, so `verify.mjs --help` started the argument-less --changed verification (the relay restart and e2e included). */
const KNOWN_FLAGS = new Set(['--all', '--list', '--dry-run', '--rerun-failed', '--serial', '--build', '--no-typecheck', '--no-e2e', '--keep-relay']);
const VALUE_FLAGS = new Set(['--folders', '--only', '--base', '--jobs', '--url', '--timeout', '--log-dir']);
{
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !VALUE_FLAGS.has(a) && !VALUE_FLAGS.has(argv[i - 1]));
  if (unknown.length) {
    const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
    const isHelp = unknown.every((a) => a === '--help' || a === '-h');
    if (!isHelp) console.error(`unknown option(s): ${unknown.join(' ')}\n`);
    console.log(head.split('\n').map((l) => l.replace(/^\s?\*\s?/, '')).join('\n').trim());
    process.exit(isHelp ? 0 : 2);
  }
}
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  all: has('--all'), list: has('--list'), dryRun: has('--dry-run'), rerunFailed: has('--rerun-failed'),
  folders: val('--folders', '').split(',').filter(Boolean),
  only: val('--only', '').split(',').filter(Boolean),
  base: val('--base', null),
  /* 2026-09-16 — 4 lanes by default. Measured twice the same day.
     ① 28 threads · RTX 4070 SUPER: 4 lanes 18 min 30 s → 8 lanes 20 min 00 s — read at the time as "the frame floor
        (`Engine.MAX_DT`, 20 fps)", but that run most likely also carried **the stall where `browser.close()` is held for up
        to 2 minutes** (the header comment of `scripts/close-browser.mjs`); 「a group of smokes finishes in the same second」,
        written down then, is that stall's symptom.
        The more Chromes there are closing the longer it takes, which is what made adding lanes look like a loss.
     ② 7800X3D (8 cores, 16 threads) · RTX 4080 SUPER, after the stall was fixed, `--all`: 4 lanes 16 min 40 s · 6 lanes
        **12 min 56 s**. But on 6 lanes the time under 20 fps grew from 210 s to 292 s, and three timing reds appeared that
        4 lanes never show (`smoke-ladder`'s climb speed · `smoke-tutorial-raid`'s HUD fade value · `smoke-rover`'s turret
        hit). So the default stays 4 — `--jobs 6` if you want it fast and are ready to re-check a red.
     SMOKE_GL=swiftshader is CPU-bound, so give it `--jobs 1–2` by hand. */
  jobs: has('--serial') ? 1 : Math.max(1, Number(val('--jobs', 4)) || 4),
  build: has('--build') || has('--all'),
  typecheck: !has('--no-typecheck'),
  e2e: !has('--no-e2e'),
  keepRelay: has('--keep-relay'),
  url: val('--url', 'http://localhost:5273/'),
  timeoutMs: (Number(val('--timeout', 15)) || 15) * 60_000,
};

if (opts.list) {
  const byFolder = {};
  for (const [name, j] of Object.entries(SMOKES)) for (const f of j.folders) (byFolder[f] ??= []).push(name);
  console.log('folder → smoke scripts');
  for (const f of Object.keys(byFolder).sort()) console.log(`  ${f.padEnd(12)} ${byFolder[f].join(', ')}`);
  console.log(`  ${'(global)'.padEnd(12)} src/core, main.ts, index.html, vite.config, package.json, tsconfig → all`);
  console.log(`  ${'(shared)'.padEnd(12)} src/shared: 코드 ${SHARED_NARROW_FILES}개 이하 + 기능 폴더 ${SHARED_NARROW_FOLDERS}개 이하 → 바뀐 export 를 쓰는 폴더, 그보다 넓으면 all`);
  // What attaches by a path outside `src/` is not in the folder table, so it is printed separately.
  for (const e of EXTRA_PATHS) console.log(`  ${'(path)'.padEnd(12)} ${e.label} → ${e.smokes.join(', ')}`);
  // 2026-09-11: data/*.csv → the consuming folders (`scripts/data-owners.mjs`). The smokes follow the folder table above.
  console.log('\ndata csv → folders (scripts/data-owners.mjs)');
  for (const [csv, fs] of Object.entries(CSV_FOLDERS).sort()) console.log(`  ${csv.padEnd(26)} ${fs.join(', ')}`);
  console.log(`  ${[...CSV_WIDE].join(', ').padEnd(26)} (wide — no smokes picked, a note is printed)`);
  let csvOnDisk = [];
  try { csvOnDisk = readdirSync(resolve(ROOT, 'data')).filter((f) => f.endsWith('.csv')); } catch { /* no data dir */ }
  const unmapped = csvOnDisk.filter((f) => !CSV_WIDE.has(f) && !CSV_FOLDERS[f]);
  if (unmapped.length) console.log(`  ⚠ not mapped (a change to these picks no smokes): ${unmapped.join(', ')}`);
  process.exit(0);
}

// ─── Selection ─────────────────────────────────────────────────────────────────────────────────────────────────
function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''; }
function changedFiles() {
  if (opts.base) return git(['diff', '--name-only', opts.base]).split('\n').filter(Boolean);
  const status = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim()).map((p) => p.includes(' -> ') ? p.split(' -> ')[1] : p);
  if (status.length) return status;
  return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
}
/* 2026-09-16: finds the **feature folders that use the changed exports** in a narrow shared change. It pulls the
   identifiers out of the diff's changed lines, keeps only the names shared exports, and looks those up in the working tree
   as whole words (`git grep -w` — `\b` does not work in this git build). When the changed lines sit inside a function body
   and no export name is caught at all, everything that file exports becomes the candidate set; if that is still empty it
   reports `ok: false` so that everything runs — better to run than to narrow and miss. */
function sharedConsumers(sharedTs) {
  const diff = opts.base
    ? git(['diff', '-U0', opts.base, '--', ...sharedTs])
    : (git(['diff', '-U0', 'HEAD', '--', ...sharedTs]) || git(['diff', '-U0', 'HEAD~1', 'HEAD', '--', ...sharedTs]));
  const exported = new Set(
    git(['grep', '-h', '-oE', 'export (const|function|type|interface|class|enum|let) [A-Za-z0-9_]+', '--', 'src/shared'])
      .split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean),
  );
  const ids = new Set();
  for (const line of diff.split('\n')) {
    if (!/^[+-][^+-]/.test(line)) continue;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (exported.has(m[0])) ids.add(m[0]);
  }
  if (!ids.size) {
    for (const f of sharedTs) {
      let text = ''; try { text = readFileSync(resolve(ROOT, f), 'utf8'); } catch { /* a deleted file */ }
      for (const m of text.matchAll(/export (?:const|function|type|interface|class|enum|let) ([A-Za-z0-9_]+)/g)) ids.add(m[1]);
    }
  }
  if (!ids.size) return { syms: 0, consumers: [], ok: false };
  const list = [...ids]; const consumers = new Set();
  // Thrown every name at once, git grep quietly comes back empty-handed — so they go in slices of 15.
  for (let i = 0; i < list.length; i += 15) {
    for (const h of git(['grep', '-l', '-w', '-E', list.slice(i, i + 15).join('|'), '--', 'src']).split('\n')) {
      const m = h.replace(/\\/g, '/').match(/^src\/([^/]+)\//);
      if (m && m[1] !== 'shared') consumers.add(m[1]);
    }
  }
  return { syms: list.length, consumers: [...consumers].sort(), ok: true };
}
function foldersOf(files) {
  const folders = new Set(); const extra = new Set(); const notes = []; const shared = []; let global = false;
  for (const f of files) {
    const p = f.replace(/\\/g, '/');
    if (GLOBAL_PATHS.some((re) => re.test(p))) { global = true; continue; }
    // shared is not a feature folder — it is collected and judged by size after the loop.
    if (SHARED_RE.test(p)) { if (p.endsWith('.ts')) shared.push(p); continue; }
    const m = p.match(/^src\/([^/]+)\//); if (m) folders.add(m[1]);
    if (/^server\//.test(p)) folders.add('server');
    for (const e of EXTRA_PATHS) if (e.re.test(p)) e.smokes.forEach((n) => extra.add(n));
    // 2026-09-11: data/<file>.csv → the folders that consume its numbers (`scripts/data-owners.mjs`). A wide table selects nothing and is only noted.
    const csv = p.match(/^data\/([^/]+\.csv)$/)?.[1];
    if (csv) {
      if (CSV_WIDE.has(csv)) notes.push(`data/${csv} 는 거의 모든 폴더가 읽는다 — 스모크를 고르지 않았다 (--folders 로 직접 주거나 verify:all)`);
      else if (CSV_FOLDERS[csv]) CSV_FOLDERS[csv].forEach((x) => folders.add(x));
      else notes.push(`data/${csv} 가 scripts/data-owners.mjs 의 CSV_FOLDERS 에 없다 — 스모크를 고르지 못했다`);
    }
  }
  if (!global && shared.length) {
    if (shared.length > SHARED_NARROW_FILES || folders.size > SHARED_NARROW_FOLDERS) {
      global = true;
      notes.push(`src/shared 코드 ${shared.length}개 · 기능 폴더 ${folders.size}개 — 넓은 변경이라 전체를 돈다 (좁은 기준: 파일 ${SHARED_NARROW_FILES} 이하 · 폴더 ${SHARED_NARROW_FOLDERS} 이하)`);
    } else {
      const { syms, consumers, ok } = sharedConsumers(shared);
      if (!ok) { global = true; notes.push('src/shared 변경에서 바뀐 export 를 못 찾았다 — 안전하게 전체를 돈다'); }
      else {
        for (const f of consumers) folders.add(f);
        notes.push(`src/shared 좁은 변경 — 바뀐 export ${syms}개를 쓰는 폴더: ${consumers.join(', ') || '(없음)'}`);
      }
    }
  }
  return { folders: [...folders], extra: [...extra], global, notes };
}
function select() {
  const names = Object.keys(SMOKES);
  let picked, reason;
  if (opts.only.length) {
    const bad = opts.only.filter((n) => !SMOKES[n]);
    if (bad.length) { console.error(`unknown script(s): ${bad.join(', ')}. Known: ${names.join(', ')}`); process.exit(2); }
    picked = opts.only; reason = '--only';
  } else if (opts.rerunFailed) {
    if (!existsSync(LAST_RUN)) { console.error(`no previous run recorded (${LOG_REL}/last-run.json)`); process.exit(2); }
    const last = JSON.parse(readFileSync(LAST_RUN, 'utf8'));
    picked = last.results.filter((r) => !r.ok).map((r) => r.name).filter((n) => SMOKES[n]);
    reason = `--rerun-failed (${last.time})`;
  } else if (opts.all) {
    picked = names; reason = '--all';
  } else if (opts.folders.length) {
    picked = names.filter((n) => SMOKES[n].folders.some((f) => opts.folders.includes(f)));
    reason = `--folders ${opts.folders.join(',')}`;
  } else {
    const files = changedFiles();
    const { folders, extra, global, notes } = foldersOf(files);
    for (const n of notes) console.log(`  note: ${n}`);
    if (global) { picked = names; reason = `changed: engine/bootstrap or a wide shared change → all (${files.length} files)`; }
    else {
      // `extra` = what a path outside `src/` picked directly (docs/pitch → smoke-pitch). It is the union with the folder mapping.
      picked = names.filter((n) => extra.includes(n) || SMOKES[n].folders.some((f) => folders.includes(f)));
      reason = `changed folders: ${[...folders, ...extra.map((n) => `(${n})`)].join(', ') || '(none)'}`;
    }
  }
  if (!opts.e2e) picked = picked.filter((n) => n !== 'e2e-mp');
  return { picked, reason };
}

// ─── Process helpers ───────────────────────────────────────────────────────────────────────────────────────────
const children = new Set();
function npmRun(script, logName, extraEnv = {}) {
  const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
  const env = { ...process.env, FORCE_COLOR: '0', ...extraEnv };
  const child = isWin
    ? spawn(`npm.cmd run ${script}`, { shell: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
    : spawn('npm', ['run', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}
function pidsOnPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    return [...new Set(out.split('\n').map((l) => l.match(re)?.[1]).filter((p) => p && p !== '0'))];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean);
}
function killPort(port) {
  for (const pid of pidsOnPort(port)) {
    if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
  }
}
/* 2026-09-17 (E-12): when a chrome caught in a kernel wait survives, neither puppeteer nor `close-browser.mjs` can delete
   that browser's temp profile — 45 of them had piled up in %TEMP% that day. Deleting them is the runner's job. Two hours is
   far longer than the longest smoke (~4 min), so it is a value that cannot touch the profile of a browser **running now**. */
function sweepStaleProfiles(maxAgeMs = 2 * 60 * 60 * 1000) {
  const tmp = os.tmpdir();
  let gone = 0;
  for (const name of readdirSync(tmp).filter((n) => n.startsWith('puppeteer_dev_chrome_profile-'))) {
    const dir = resolve(tmp, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 1 });
      gone++;
    } catch { /* someone still holds it — it is looked at again on the next run */ }
  }
  if (gone) console.log(`  swept ${gone} stale puppeteer profile folder(s) from %TEMP%`);
}
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, label, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await isUp(url)) return true; await sleep(500); }
  throw new Error(`${label} did not come up at ${url} within ${ms / 1000}s (see ${LOG_REL}/)`);
}
/** Run a command, capture everything to a log, return {code, out, seconds}. */
function runCapture(cmd, args, logName, { shell = false, timeoutMs = opts.timeoutMs } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
    let out = '';
    const child = spawn(cmd, args, { shell, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
    children.add(child);
    const onData = (chunk) => { out += chunk; log.write(chunk); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { out += `\n[verify] timeout after ${timeoutMs / 60000} min — killed\n`; killTree(child); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child); log.end();
      done({ code: code ?? (signal ? 1 : 0), out, seconds: Math.round((Date.now() - t0) / 1000) });
    });
    child.on('error', (err) => { clearTimeout(timer); children.delete(child); done({ code: 1, out: String(err), seconds: 0 }); });
  });
}
function summarize(name, r) {
  const m = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const ratio = r.out.match(/(\d+)\/(\d+) passed/); // server selftest prints "selftest: 101/101 passed"
  const passed = m ? Number(m[1]) : ratio ? Number(ratio[1]) : null;
  const failed = m ? Number(m[2]) : ratio ? Number(ratio[2]) - Number(ratio[1]) : null;
  const consoleErrs = r.out.match(/(\d+) console errors/)?.[1];
  const ok = r.code === 0 && (failed === null || failed === 0);
  const fails = r.out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 12);
  const score = passed !== null ? `${passed}/${passed + failed}` : (r.code === 0 ? 'ok' : `exit ${r.code}`);
  return { name, ok, score, passed, failed, consoleErrs: consoleErrs ? Number(consoleErrs) : undefined, seconds: r.seconds, code: r.code, fails, log: `${LOG_REL}/${name}.log` };
}
function report(s) {
  const mark = s.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${s.name.padEnd(20)} ${s.score.padEnd(9)} ${String(s.seconds).padStart(4)} s${s.ok ? '' : `   → ${s.log}`}`);
  for (const f of s.fails) console.log(`      ${f.trim()}`);
  if (!s.ok && !s.fails.length) console.log(`      (no FAIL line — crashed or timed out; tail of ${s.log}:)\n      ${tail(s.log)}`);
}
function tail(logRel, n = 6) {
  try { return readFileSync(resolve(ROOT, logRel), 'utf8').trim().split('\n').slice(-n).join('\n      '); } catch { return ''; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });
const started = { vite: null, relay: null, relayData: null };
const results = [];
const tStart = Date.now();
let exiting = false;
function cleanup() {
  if (exiting) return; exiting = true;
  for (const c of children) killTree(c);
  killTree(started.vite); killTree(started.relay);
  if (started.relayData) { try { rmSync(started.relayData, { recursive: true, force: true }); } catch { /* still locked → stays in %TEMP% */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  const { picked, reason } = select();
  console.log(`verify — ${reason}`);
  console.log(`  smokes: ${picked.length ? picked.join(', ') : '(none)'}   jobs: ${opts.jobs}   cpus: ${os.cpus().length}`);
  /* 2026-09-16: `--dry-run` prints the selection and ends. Whether a shared change escalates to everything is not something to spend 20 minutes finding out. */
  if (opts.dryRun) { console.log(`  (--dry-run: ${picked.length} scripts, nothing run)`); process.exit(0); }

  // 1. Fast static checks, all in parallel.
  const npx = isWin ? 'npx.cmd' : 'npx';
  const fast = [];
  if (opts.typecheck) {
    fast.push(runCapture(npx, ['tsc', '--noEmit'], 'typecheck', { shell: isWin }).then((r) => summarize('typecheck', r)));
    fast.push(runCapture(npx, ['tsc', '--noEmit', '-p', 'server/tsconfig.json'], 'typecheck-server', { shell: isWin }).then((r) => summarize('typecheck-server', r)));
  }
  /* 2026-09-16: net:selftest takes about 50 s, and the smokes only started once all of `fast` had been awaited, so every
     run threw away 50 s with not a single browser up. This check is a **pure Node test that starts its own relay on a random
     port** (the header comment of `server/selftest.ts`), so it touches neither the 8787 relay · vite · the smokes even when
     it overlaps them — it runs alongside the smokes and is awaited only just before the summary. */
  const slow = [runCapture(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/selftest.ts'], 'net-selftest')
    .then((r) => { const s = summarize('net-selftest', r); results.push(s); report(s); return s; })];

  // data/*.csv is the single source of the numbers — a typo does not kill the game but runs quietly on defaults, so it is caught here.
  fast.push(runCapture(process.execPath, ['scripts/data-check.mjs'], 'data-check').then((r) => summarize('data-check', r)));
  /* The CSS class prefixes are a hole of the same kind — two folders picking the same prefix puts a global rule on someone
     else's screen, and neither the typecheck nor a smoke sees it (a class is a string, and the result is not an error but a
     wrong picture — B-18). It takes 0.1 s. */
  fast.push(runCapture(process.execPath, ['scripts/check-css-prefixes.mjs'], 'css-prefixes').then((r) => summarize('css-prefixes', r)));
  if (opts.build) fast.push(runCapture(npx, ['vite', 'build'], 'build', { shell: isWin }).then((r) => {
    const s = summarize('build', r);
    const js = r.out.match(/index-[\w-]+\.js\s+([\d.,]+ kB)/)?.[1]; const css = r.out.match(/index-[\w-]+\.css\s+([\d.,]+ kB)/)?.[1];
    if (js) s.score = `${js} JS${css ? ` / ${css} CSS` : ''}`;
    return s;
  }));
  for (const s of await Promise.all(fast)) { results.push(s); report(s); }

  // `standalone` = this script uses neither vite nor the relay (the deploy build · the pitch wiki).
  // When **every** selected script is standalone, no server is started at all — otherwise tens of seconds go
  // into waiting for a vite nothing will use. If even one of them uses a browser, both start as before.
  const needServers = picked.some((n) => !SMOKES[n].standalone);
  if (picked.length) {
    if (needServers) sweepStaleProfiles();
    // 2. Servers — skipped when every selected script is standalone.
    if (!needServers) console.log('  servers skipped (standalone scripts only)');
    else {
      const relayUrl = 'http://localhost:8787/health';
      const needFreshRelay = picked.some((n) => SMOKES[n].freshRelay) && !opts.keepRelay;
      if (needFreshRelay && pidsOnPort(8787).length) { console.log('  restarting relay (stale lobbies would hijack quick match)'); killPort(8787); await sleep(500); }
      if (!(await isUp(relayUrl))) {
        // C-41 (2026-09-11): the relay the runner starts itself uses a temp profile store — so that the thousands of test
        // profiles a smoke makes never pile up in the dev server/data/profiles.json. A relay already up is left alone.
        started.relayData = mkdtempSync(resolve(os.tmpdir(), 'scav-verify-relay-'));
        // E-4 (2026-09-11): started as a relay that accepts the dev credit reasons the smokes · e2e use (smoke:* · e2e:* · console · shot).
        started.relay = npmRun('server', 'relay', { SCAV_DATA_DIR: started.relayData, SCAV_DEV_ECONOMY: '1' });
        await waitUp(relayUrl, 'relay');
        console.log(`  relay started (8787, profiles in ${started.relayData})`);
      }
      else {
        console.log('  relay already up (8787)');
        // E-4 (2026-09-11): a relay someone started by hand (dev:all · npm run server) refuses the dev credit reasons
        // (`smoke:*` top-ups revert). `/health.devEconomy` is absent on a relay older than the credit validation.
        const h = await fetch(relayUrl, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
        if (h && h.devEconomy === false) console.log('  note: that relay runs WITHOUT SCAV_DEV_ECONOMY — smokes that top up credits with smoke:* reasons see them reverted (restart it with SCAV_DEV_ECONOMY=1, or drop --keep-relay)');
      }
      if (!(await isUp(opts.url))) { started.vite = npmRun('dev', 'vite'); await waitUp(opts.url, 'vite'); console.log(`  vite started (${opts.url})`); }
      else console.log(`  vite already up (${opts.url})`);
    }

    // 3. Smokes in a pool; exclusive jobs afterwards, one at a time.
    const pool = picked.filter((n) => !SMOKES[n].exclusive);
    const solo = picked.filter((n) => SMOKES[n].exclusive);
    const runSmoke = async (name) => {
      const s = summarize(name, await runCapture(process.execPath, [...(SMOKES[name].nodeArgs ?? []), SMOKES[name].file, opts.url], name));
      results.push(s); report(s);
    };
    let next = 0;
    const stagger = Math.max(1_000, Math.round(RAMP_BUDGET_MS / Math.max(1, opts.jobs)));
    const lane = async (i) => { await sleep(i * stagger); while (next < pool.length) await runSmoke(pool[next++]); };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, pool.length) }, (_, i) => lane(i)));
    for (const name of solo) await runSmoke(name);
  }
  await Promise.all(slow);
} catch (err) {
  console.error(`\nverify aborted: ${err.message}`);
  results.push({ name: 'runner', ok: false, score: 'aborted', seconds: 0, fails: [], log: `${LOG_REL}/` });
} finally {
  cleanup();
}

// 4. Summary + record.
const total = Math.round((Date.now() - tStart) / 1000);
const failed = results.filter((r) => !r.ok);
const line = results.map((r) => `${r.name} ${r.score}${r.consoleErrs ? ` (${r.consoleErrs} console errors)` : ''}`).join(', ');
console.log(`\n${failed.length ? `\x1b[31m${failed.length} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} in ${Math.floor(total / 60)} min ${total % 60} s`);
console.log(`docs line: ${new Date().toISOString().slice(0, 10)}: ${line}`);
if (failed.length) console.log('re-run only the failures: node scripts/verify.mjs --rerun-failed');
const record = { time: new Date().toISOString(), totalSeconds: total, results };
writeFileSync(LAST_RUN, JSON.stringify(record, null, 2));
/* 2026-09-17 (E-13): a red job's logs are copied into `failed/`. A failed run's log was always overwritten under the same
   file name by the next run — the 「let me run that one on its own」 one — and when that re-run was green the evidence
   vanished entirely (that is how E-13's three failures of 2026-09-16 were lost). This copy is overwritten only by **the next
   red run**. */
if (failed.length) {
  const dir = resolve(LOG_DIR, 'failed');
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const r of failed) { try { copyFileSync(resolve(ROOT, r.log), resolve(dir, `${r.name}.log`)); } catch { /* a job with no log file (runner) */ } }
    writeFileSync(resolve(dir, 'last-run.json'), JSON.stringify(record, null, 2));
    console.log(`failed logs kept in ${LOG_REL}/failed/ (only the next red run overwrites them)`);
  } catch { /* failing to keep a copy leaves the run's result exactly as it was */ }
}
process.exit(failed.length ? 1 : 0);
