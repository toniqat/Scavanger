# allies/ — android squadmates (`AllySystem`, publishes `ctx.allies`)

Android squadmates: the roster (relay bot members of the lobby, or the local `/android` cheat roster), their ship behaviour
(cockpit bays, standing ready at a launch pod), the raid simulation on the authority (FSM with reaction delays, harness
around the squad leader, raider-style cover combat, looting, deliveries, extraction, rescue), and the `ally` / `allyq` sync.
Contract: `src/shared/allies.ts`, the android section at the end of `src/shared/net.ts`, the android events in
`src/shared/events.ts`. This folder builds no meshes — `player/` draws the bodies from `ctx.allies.getBodies()`.

## Files

| File | Responsibility |
|---|---|
| `AllySystem.ts` | `GameSystem` + `AlliesRef` — state, event wiring, one-line delegates, debug hooks for the smokes |
| `model.ts` | Vocabulary, no state: `PRIO` (proposal ranks), request kinds, Korean lines, scratch vectors, yaw convention, reaction-delay formula |
| `parts/Body.ts` | `Ally` — the mutable body implementing `AllyBodyView` plus every sim-only field (bag, task, burst, interpolation) |
| `parts/Roster.ts` | Who is on the squad: lobby bot members vs. the cheat roster, body creation, dormant bay bodies, `ally:rosterChanged`, `getLoadout` |
| `parts/Hub.ts` | Ship poses — dormant inside a bay, `emerge` to the launch-pod stand, `retire` back; the cheat android following in the personal ship |
| `parts/Spawn.ts` | Raid entry: reset, base kit, per-slot spawn offset, `ally:podDrop`, landing timer |
| `parts/Fsm.ts` | One proposal per frame → reaction delay → transition; state dispatch; follow **or** roam (harness in/out); junk dropping |
| `parts/Harness.ts` | Squad leader lookup and the harness radius (halves while the leader keeps one heading, ×`ALLY_LEAD_HARNESS_MUL` while 앞장서라 runs) |
| `parts/Nav.ts` | Steering, obstacle avoidance, **2 m squad separation** (`separate`), **spread toward a person** (`spreadToward`), surface-before-collision movement, stuck sidestep (judged on net travel over a window, so shaking against a wall counts), harness clamp |
| `parts/Roam.ts` | Free search inside the harness (`roam`): pick a structure / cover point of interest, give it up when another body already holds it, random patrol otherwise; walkable destination sampling and the look-around pause |
| `parts/Combat.ts` | Sensing + line of sight (one query per frame), **per-weapon engage range** (`engageRangeOf`), the PC's enemy ping, cover via `pickCoverSpot` (skipped at contact range), bursts, friendly-fire guard, `applyAllyHit` |
| `parts/Vitals.ts` | Shield → hp → downed → dead, hazard and planet-atmosphere ticks, revive, corpse call |
| `parts/Commands.ts` | Pings / comms wheel / item requests → leader orders and the first-one-wins request, agreeing to a PC's enemy / extraction ping, 앞장서라 (`leadUntil`), requester queries |
| `parts/Bag.ts` | Bound base kit (`ensureKit` in the ship · `clearKit` + `equipKit` per raid), weight, gear scoring and swapping, junk dropping, taking items |
| `parts/Loot.ts` | Pinged crates first (no distance limit), autonomous looting only while idle and within `ALLY_IDLE_LOOT_M` (peek == take), ground pickups, **giving up** on a target it stops closing on (`stalled`) |
| `parts/Support.ts` | Handing an item over: ping, approach, wait for "stopped or looking", drop, ping again |
| `parts/Extract.ts` | Pad search → ping → confirm → console press (or run to the **PC's extraction ping** after the 탈출 comms), boarding, the weight-driven extract ping, liftoff deposit |
| `parts/Contract.ts` | Contract / NPC objective search inside the harness |
| `parts/Rescue.ts` | Reviving downed players (defibrillator shortcut) and carrying them out of a hazard |
| `parts/Ping.ts` | Android pings and chat lines — local event + wire, with repeat suppression |
| `parts/Sync.ts` | `ally` / `allyq` wire: host snapshots, bag updates, replica interpolation, host migration, requests |
| `parts/Console.ts` | Dev cheat `/android 1\|0` (`AlliesRef.devSetAndroid`) |
| `index.ts` | Barrel |

## Public API

`ctx.allies` is exactly `AlliesRef` (`src/shared/allies.ts`): `roster`, `simulating`, `getBodies`, `getBody`,
`getCombatBodies`, `getLoadout`, `damage`, `requestRevive`, `carrierOf`, `devSetAndroid`.

Debug hooks on `getSystem('allies')` (smokes only, never called by game code): `debugForceState`, `debugGive`,
`debugLeaderAt`, `debugHarness`, `debugTeleport`, `debugInfo`.

## Rules

- **The authority simulates, replicas interpolate.** `ctx.isAuthority` decides; a replica accepts `ally` only from
  `lobby.hostId` and interpolates by `NET_INTERP_DELAY`. `damage()` is a no-op on a replica.
- **Engagement is for things that fight back.** Androids never shoot a nest egg: `EnemyManagerRef.queryNear` leaves props out by
  default, so sensing, re-targeting, rescue-safety and the contract 「적」 ping never see one, and an 「적」 ping naming an egg is
  refused instead of agreed to. A player who wants the cells shoots the egg themselves. The invariant is written where it can be
  broken: the `parts/Combat.ts` header plus each of its three `queryNear` calls (`sense` · `findTarget` · `enemiesNear` — **never**
  pass `includeProps: true` from that file), `parts/Commands.onEnemyPing` · `tickEnemyPing`, and `shared/types.ts` `queryNear`.
- **The base kit is bound, and it exists in the ship too** (2026-09-16). `Roster.syncBodies` → `Bag.ensureKit` gives a recruited
  android its kit the moment it becomes a squad member, so the body in the ship is armed and `getLoadout` feeds the launch-slot
  card; the raid still starts from a fresh kit (`Spawn` → `clearKit` → `equipKit`), and `ensureKit` is skipped while `raidActive`
  so a mid-raid roster update never mints a bag on a replica (that would lose its loot on host migration). `Ally.kitUids` stays
  the gate on every way out of the body (drop, hand over, corpse, stash); only `raidFound` items move.
- **One proposal per frame.** `Fsm.decide` picks the highest-priority condition (`model.PRIO`) and `propose` waits out the
  reaction delay; a more urgent proposal replaces a pending one. Only `downed` / `dead` / `dormant` / `aboard` are instant.
- **A state whose work is a single act sets `Ally.oneShot`** (extract search, contract search). Without it the act keeps
  re-running during the transition delay and wipes the task a follow-up command just set.
- **No `game:newMission` handler.** `world/` generates inside its own handler, so `world:ready` arrives first — new-mission
  cleanup lives in `Spawn.onWorldReady` (docs/ARCHITECTURE.md gotcha).
- **The ship has no wire.** Every client computes bay / pod poses from the lobby; only the raid is synced.
- Movement queries the surface **before** `resolveCollision` (CLAUDE.md §4.4) and reuses module-local scratch vectors —
  `parts/Nav` keeps its own so a caller may pass a `model` scratch as the destination.
- Never fire when a player or another android is on the line (`Combat.blockedByFriend`).
- **A standing android keeps the raid alive** (2026-09-16): the wipe decision (`game/parts/Death.checkAllDead`) fails the raid only
  when every human **and** every android is down or dead. A downed android does not count — nobody revives it.
- **Inside the harness an android roams, it does not stand still** (`roam`); outside it runs back (`follow`). The two share one rank
  (`PRIO.follow` === `PRIO.roam`), so `Fsm.decide` proposes exactly one of them.
- **Orders vs. pings**: 가자 · 주의 · 앞장 stay leader-only; a PC's **enemy / extraction ping** is agreed to from any human (they are
  requests, not orders). 앞장서라 widens the harness for `ALLY_LEAD_DURATION_S` and then expires by itself.
- **Crates are not raced for**: a pinged one first with no distance limit, an unpinged one only while idle and within
  `ALLY_IDLE_LOOT_M`.
- **A ping names its target by id, never by its label.** A `'crate'` ping carries the loot-container id
  (`PingMessage.containerId` → `ping:placedV3.containerId` → `AllyRequest.targetId`); the `label` beside it is the display string
  `보급 상자 (n등급)`. An `'item'` ping carries no id — a pickup is spawned and taken within seconds, so the **spot** is the
  target and one window (`parts/Loot` `PING_ITEM_MATCH_M`) answers both 「can anyone take this job」 (`Commands.canFulfil`) and
  「what is there now」 (`Loot.autoProposal`). A pinged job that cannot be done any more ends through `Commands.finishTask`.
- **No pathfinding, so an unreachable loot target is given up** (2026-09-21, TODO E-14): when the distance to a crate · ground
  item has not closed by `ALLY_JOB_PROGRESS_M` for `ALLY_JOB_GIVEUP_S` (`Loot.stalled`), a pinged job ends through
  `Commands.finishTask` with `CHAT_KO.cantReach`, and an autonomous pick goes silently into `Ally.unreachable` for the raid (a
  fresh ping may still send it there). A crate behind a wall whose door is far away is therefore out of reach by design until
  shared pathfinding exists (TODO A-18).
- Other folders' contract members are called with `?.`; a missing one degrades that behaviour only.
- **Intended limits** (2026-09-16): solo (`/android` cheat, no relay) death still fails the raid at once even with an
  android standing (a real android is a relay bot member, so the wipe check takes the `isMultiplayer` branch); an
  extraction ping is agreed to without checking that the pinger and the human who said H are the same person;
  `Nav.spreadToward` applies to following only, because rescue and hand-over approaches need contact range; `roam`
  points of interest are `WorldRef.getStructures` / `getRuinSites` / large obstacles only, so a structureless map is
  always a random patrol, and at the harness edge `follow` ↔ `roam` can alternate within the reaction delay.
- **Known limit** (2026-09-19): the planet-atmosphere tick (`parts/Vitals.update`) has **no counterpart to
  `ProgressionRef.hasEnvPrep`** — a person who bought the matching preparation takes no atmosphere damage at all, an android
  always does. A preparation is a personal profile purchase (CLAUDE.md §4.8) and an android has no profile, so there is nothing
  to read. The other gates of a person's path **are** matched: the exposure gate (`isGameplayPhase()` · not the training range)
  and, for the hazard tick, the spore shield bypass (`HAZARD_SPORES_BYPASS_SHIELD`). An android is not in a rover and has no
  scene lock, so those two branches have no android side.
- **Known limit**: `Extract.onLiftoff` extracts every body in the bay that is **not dead**, a downed one included — the test is
  `a.dead` alone, so a body that was carried in or fell inside goes out with the ship and its loot reaches the stash.

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **Androids live in the shared ship's 3 cockpit bays only** (2026-09-15). Rejected: bays in the personal ship, offline single
  player (the dev `/android` cheat covers testing).
- **A fixed base kit every raid; only `raidFound` items reach the leader's stash.** Rejected: persistent per-bay gear (every raid
  would mint free gear), losing the bag on extraction.
- **Infinite ammo with magazine and reload kept; no throwables or gadgets.** Rejected: real ammo use.
- **Not a rescue-drop target**; androids revive players. **A standing android keeps the raid alive** (2026-09-16). Rejected:
  androids outside the wipe decision (one human + androids ended the moment the human went down).
- **Roaming = a point of interest, switching to patrol when another body holds it** (2026-09-16). Rejected: purely random
  roaming; pure point-of-interest roaming (two androids pile onto one structure).
- **2 m soft separation** — 「2 m 이내에 겹치지 않도록 피해서 가기, 부득이 겹칠 경우 갈 수 있음」 (`Nav.separate`, `ALLY_SEPARATION_M`).
- **앞장서라 expires by itself.** Rejected: an order that never expires.
- **Engage range comes from the weapon's falloff** (~50 % damage point). Rejected: one fixed 45 m; a per-weapon csv table (the
  falloff columns already say it).
- **Looting: a pinged container first, an unpinged one only while idle and close.** Rejected: keeping autonomous looting with a
  priority tweak.
- **A crate ping names its container by id** (`PingMessage.containerId`, 2026-09-19). Rejected: matching by ping position (kept only
  as the fallback for a ping with no id).
- **An unreachable crate / item is given up after `ALLY_JOB_GIVEUP_S` with one line** (`거기까진 못 가겠다.`, 2026-09-21). Rejected:
  giving up silently (the player cannot tell why); sidestepping forever (a wall with no gap still hangs the job). The fix is the
  steering (a windowed stuck test in `Nav.step`), not the map. **Pathfinding is deferred (TODO A-18) and will be one layer for enemies
  too** (A\* per android, a flow field per player) — bugs walking round through doors changes what hiding in a building is worth.
- **Atmosphere damage takes the exposure gate, not the preparation gate.** Rejected: giving an android the leader's preparation (a
  bought prep would protect bodies it was never bought for).

## Recent changes

Last 5 only — older: `git log -- src/allies`.
- 2026-09-21 — TODO E-14: `Nav.step` judges 「stuck」 on net travel over the `STUCK_S` window (per-frame shaking against a wall
  used to read as walking, so the sidestep never fired), and `Loot` gives up a crate · item it stops closing on
  (`ALLY_JOB_GIVEUP_S` · `ALLY_JOB_PROGRESS_M`, line `거기까진 못 가겠다.`); the unused `Ally.lastPos` became `stuckFrom`.
- 2026-09-19 — TODO B-59…B-62: comments matched to the code (instant-state count, `Extract` decision count, `running`, the corpse
  claim in `Loot`, `OBS_QUERY_M`, `Hub.place`, `Roster.refresh`); dead code removed (`Roster.isAlly` · `copyOf` · `snapshotItems` ·
  `myPeer`, `Spawn.localPeer`, `Sync.w2id`, two `void a` params, a false `void dt`); a **crate ping now carries the container id**
  (`PingMessage.containerId`) and an **item ping is a real pickup job**; spores bypass an android's shield, the hazard carry-out
  spends its defibrillator, `agreeToHumanExtract` skips downed bodies, `padNearPing` gained the fog gate, `pickContainer` skips an
  opened container, the atmosphere tick gained the exposure gate, and `Harness.debugOverride` is cleared on every raid boundary.
- 2026-09-19 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); the seven verbatim user decisions inside `「」` and every Korean on-screen / ping label (`가자` · `주의` · `앞장서라` · `탈출하고 싶다` · the weight states) kept verbatim, no string literal touched.
- 2026-09-18 — Androids never engage a nest egg: `queryNear` leaves props out, so sensing / targeting / contract 「적」 pings skip them, and an 「적」 ping that names an egg is refused rather than agreed to (`parts/Commands.onEnemyPing` · `tickEnemyPing`).
- 2026-09-16 — AI pass 2: `roam` free search · 2 m separation · spread · per-weapon engage range · contact-range firing fix ·
  move-ping oscillation fix · agreeing to a PC's enemy / extraction ping · 앞장서라 doubles the harness and expires ·
  pinged crates first · the base kit now exists in the ship.
