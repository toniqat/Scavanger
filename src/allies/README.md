# allies/ — android squadmates (`AllySystem`, publishes `ctx.allies`)

Android squadmates: the roster (relay bot members of the lobby, or the local `/android` cheat roster), their ship behaviour
(cockpit bays, standing ready at a launch pod), the raid simulation on the authority (FSM with reaction delays, harness
around the squad leader, raider-style cover combat, looting, deliveries, extraction, rescue), and the `ally` / `allyq` sync.
Contract: `src/shared/allies.ts`, the android section at the end of `src/shared/net.ts`, the android events in
`src/shared/events.ts`. This folder builds no meshes — `player/` draws the bodies from `ctx.allies.getBodies()`.

Design record: docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」.

## Files

| File | Responsibility |
|---|---|
| `AllySystem.ts` | `GameSystem` + `AlliesRef` — state, event wiring, one-line delegates, debug hooks for the smokes |
| `model.ts` | Vocabulary, no state: `PRIO` (proposal ranks), request kinds, Korean lines, scratch vectors, yaw convention, reaction-delay formula |
| `parts/Body.ts` | `Ally` — the mutable body implementing `AllyBodyView` plus every sim-only field (bag, task, burst, interpolation) |
| `parts/Roster.ts` | Who is on the squad: lobby bot members vs. the cheat roster, body creation, dormant bay bodies, `ally:rosterChanged`, `getLoadout` |
| `parts/Hub.ts` | Ship poses — dormant inside a bay, `emerge` to the launch-pod stand, `retire` back; the cheat android following in the personal ship |
| `parts/Spawn.ts` | Raid entry: reset, base kit, per-slot spawn offset, `ally:podDrop`, landing timer |
| `parts/Fsm.ts` | One proposal per frame → reaction delay → transition; state dispatch; follow; junk dropping |
| `parts/Harness.ts` | Squad leader lookup and the harness radius (halves while the leader keeps one heading) |
| `parts/Nav.ts` | Steering, obstacle avoidance, surface-before-collision movement, stuck sidestep, harness clamp |
| `parts/Combat.ts` | Sensing + line of sight, enemy ping, cover via `pickCoverSpot`, bursts, friendly-fire guard, `applyAllyHit` |
| `parts/Vitals.ts` | Shield → hp → downed → dead, hazard and planet-atmosphere ticks, revive, corpse call |
| `parts/Commands.ts` | Pings / comms wheel / item requests → leader orders and the first-one-wins request, requester queries |
| `parts/Bag.ts` | Bound base kit, weight, gear scoring and swapping, junk dropping, taking items |
| `parts/Loot.ts` | Autonomous container looting (peek == take), commanded crates, ground pickups |
| `parts/Support.ts` | Handing an item over: ping, approach, wait for "stopped or looking", drop, ping again |
| `parts/Extract.ts` | Pad search → ping → confirm → console press, boarding, the weight-driven extract ping, liftoff deposit |
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
- **The base kit is bound.** `Ally.kitUids` is the gate on every way out of the body (drop, hand over, corpse, stash);
  only `raidFound` items move. Removing that gate mints free gear every raid.
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
- Other folders' contract members are called with `?.`; a missing one degrades that behaviour only.

## Recent changes

Last 5 only — older: `git log -- src/allies`.
- 2026-09-15 — Full implementation: roster · ship poses · raid spawn · FSM · harness · nav · combat · vitals · commands ·
  bag · loot · deliver · extract · contract · rescue · sync · `/android` cheat (replaces the contract stub).
- 2026-09-15 — Folder created with a stub `ctx.allies` (contract commit).
