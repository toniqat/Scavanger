# src/enemies — Terminid-style bug swarms

Owner system: `EnemySystem` (publishes `ctx.enemies`, implements `EnemyManagerRef`). Five bug types with procedural
models/animation, per-type AI, ambient patrol spawning, extraction waves, hit detection and gore FX.
No asset files: every bug is built from primitives with vertex-colored chitin.

**Multiplayer (host-authoritative).** The same system runs in two modes, decided per mission from `ctx.isMultiplayer` /
`ctx.isAuthority` at `world:ready` / `game:newMission` (cached for the mission — host migration only takes effect between
missions):
- **Authority** (single-player, or the lobby host): full AI hunting *every* player through `Targets.ts`; in a session it
  also streams `EnemySnapshot`s (10 Hz) + `EnemyEvent`s to the other clients and serves their `hit` / `explode` requests.
- **Replica** (joined client): no AI / spawner / waves / damage. `net/Replica.ts` buffers host snapshots and renders the
  interpolated bugs through the same `Enemy` pools, so `raycast`, `getEnemies`, gore FX, map and HUD keep working.
  `Enemy.takeDamage` becomes an optimistic hit flash + `HitRequest`; `applyExplosion` sends an `ExplodeRequest`.
Single-player behaviour is unchanged: only the `'local'` target exists and nothing is sent.

| File | Responsibility |
|---|---|
| `EnemySystem.ts` | The `GameSystem`. Pools `Enemy` instances per type (`acquire(id, …)` for both host spawns and replicas; `byId` map), refreshes `TargetList` + spatial grid each frame, ticks AI only on the authority while `ctx.isGameplayPhase()` (visuals always tick), despawns finished corpses (4 s; replicas 5 s fallback) and fled bugs (2 s). Implements `EnemyManagerRef`: `raycast` (analytic ray vs vertical hit capsule + head sphere), `applyExplosion` (host: linear falloff, returns kills; replica: FX + `explode` request, returns 0), `setThreatLevel`, `startExtractionWaves` / `stopExtractionWaves`, `killAll`, `reset`. Listens: `world:ready` (mode refresh, reset, initial patrols on authority), `game:newMission`/`game:abort`, `game:paused` (pauses only when `freeze !== false`), `weapon:fired` + `net:remoteFired` (hearing 55 m, authority), `grenade:exploded` (80 m), `extraction:activated`, `extraction:liftoff` (stop waves; authority: bugs within 18 m flee), `enemy:waveStarted` (host → `ee wave`). Net messages: host handles `hit` (→ `takeDamage(dmg, p, d, from)` → replies `hitc` with actual damage / killed / part; ignores `dmg > 500`) and `explode` (→ `hitc` per kill); replica handles `es`, `ee`, `hitc` (kill hitmarker). Emits all `enemy:*` events, `audio:play`, `camera:shake`, `player:applySlow`. Damage routing `applyDamage`: local target → `ctx.player.takeDamage` + `enemy:attacked`; remote → `dmg` to that peer (+ `ee attack` to the others for melee/leap/charge). Kill credit: `ctx.stats.kills++` / `enemy:killed` only when `e.lastDamager === 'local'` (remote killers get credit from the `kill` event on their client). Also the `EnemyHost` / `SpawnHost` / `AcidHost` / `ReplicaHost` services. |
| `Targets.ts` | `CombatTarget { id: PeerId \| 'local'; position; velocity; isDead; downed; isDeadOrDowned; present; yaw; eyeHeight; getEyePosition/getForward/getChest/dist2D }` — a stable object per player. `TargetList.refresh(ctx)` rebuilds `all` / `alive` each frame from `ctx.player` plus `ctx.net.getRemotePlayers()` filtered to `connected && !stale && !DROPPING`; `downed` = `player.isDowned` / `r.isDowned \|\| flags & DOWNED`. `alive` = present && !dead && !downed (the only players the AI may target or damage); `all` also holds downed and dead bodies (separation, `minDist`, spawn-distance checks). Departed peers get `present = false` so bugs re-target. Queries: `nearestAlive`, `nearestAliveWithin`, `minDist`, `distToLocal` (listener-relative audio/shake), `randomAlive`, `randomPresent` (prefers not-dead, i.e. downed — spawn anchor when nobody is alive), `local`, `anyAlive`. |
| `Enemy.ts` | Entity implementing `EnemyRef`. Holds gameplay state (hp, state machine fields, timers, charge/leap/spit phases, cached obstacles), `target: CombatTarget \| null` + `targetTimer` + `distToTarget`, `lastDamager` (kill credit), `lastLocalHit` / `netBuf` (replica), and the `BugRig` + `BugAnim`. `takeDamage(amount, hitPoint?, hitDir?, attacker = 'local')` classifies the hit (`head` / `rear` / `front`), applies per-type multipliers, hit-flash/flinch, stagger, death; on a replica host it stops after the visuals and calls `host.requestHit`. `animate()` syncs the rig every frame. `EnemyHost` interface lives here. |
| `EnemyTypes.ts` | `ENEMY_STATS` table plus ability tuning `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`. |
| `SpatialGrid.ts` | Allocation-free uniform XZ hash grid, rebuilt per frame, used for separation queries. |
| `Spawner.ts` | `AmbientSpawner` (threat 0..1 → cap `12 + 24·threat`, patrol every 12–25 s from nests 60–140 m around a random alive player — or, when everyone is downed, a random present body via `randomPresent` so patrols keep spawning — initial population on `world:ready`), spawn helpers `findSpawnCenter` (nests → world spawn points → behind the nearest player; never < 30 m from ANY player or in ANY player's view), `isVisibleToAnyPlayer`, `spawnGroup`, compositions `ambientGroup` / `waveGroup`, and the `SpawnHost` interface (`targets`). |
| `WaveDirector.ts` | Extraction waves: first wave 3 s after activation, then every 14 s → 9 s; size 6, 8, 10 … (≤ 22), split into 1–3 groups spawned 45–90 m from the target, facing the nearest alive player; pauses while nobody is alive. Emits `enemy:waveStarted`. Alive cap 60. Authority only. |
| `ai/EnemyAI.ts` | State machine per bug: `idle` → `wander` → `alert` → `chase` → `attack` → `stagger`, plus `dead`/`flee`. Everything player-relative reads `e.target` (`acquireTarget` each tick). Charger rush contact and hunter leap landing hit the nearest alive (not downed) player in range (not only the aimed target); melee / spit fire only while `!e.target.isDeadOrDowned`. `integrate()` handles steering, separation from every present body (`targets.all`, downed included), obstacle avoidance, terrain snapping, gait, footsteps (distance to the local listener), yaw, slope (`applySlope`, shared with the replica driver). `lookAtTarget` exported for replicas. |
| `ai/Steering.ts` | `seek`, `separate` (mass-weighted positional correction via the grid + push-out from every alive `CombatTarget`), `avoidObstacles`, `turnToward`, `yawTo`. |
| `ai/Perception.ts` | `acquireTarget`: nearest alive player, re-evaluated every 0.5–0.9 s or when the target dies / goes down / leaves; hysteresis (switch only when another is < 0.6× / 0.75× as far, with/without LOS). Staggered 0.3 s perception tick: sight 40 m with LOS to the target's chest, target loss after 10 s unseen & > 60 m. `becomeAlert` emits `enemy:alerted`, screech audio, propagates 20 m. |
| `net/HostSync.ts` | Host encoding: `encodeSnapshot(active, time)` → `EnemySnapshot { full: true, e: EnemyWire[] }` with p 2 dp / yaw 3 dp / hp 1 dp and `a` hint (1 charger windup, 2 rush, 3 spewer windup, 4 hunter airborne); `tuple`, `round`, `animHint`. ~90 B per enemy as JSON → 60 bugs ≈ 5.5 kB per snapshot ≈ 55 kB/s per client at 10 Hz. |
| `net/Replica.ts` | Client replica: `ReplicaBuffer` (8-sample ring per enemy, reused across pool cycles) with lerp / shortest-arc yaw / ≤ 0.25 s extrapolation; `EnemyReplica.onSnapshot` (get-or-create by host id, ids missing from a `full` snapshot → release), `onEvent` (`spawn` → `enemy:spawned`; `kill` → `e.kill(false)` + kill credit when `killer === localId`; `despawn`; `damaged` → flash/burst unless it echoes a local hit < 0.4 s ago; `attack` → `bug_attack` audio + `enemy:attacked` when we are the victim; `acid` → visual glob; `wave` → `enemy:waveStarted`), `update` renders at `ctx.time − NET_INTERP_DELAY`, clamps y to terrain unless airborne, and drives `BugAnim` (gait from displacement, shake/abdomen/crouch/mandible from state + hint, head tracking, slope). |
| `models/BugParams.ts` | Per-type visual parameters. |
| `models/BugModel.ts` | Shared per-type geometry/material assets, `createBugRig`, `animateBug` (tripod gait, bob/lean/slope, head tracking, mandibles, hit flash, flinch, abdomen pulse, wind-up shake, leap crouch, death roll/sink). |
| `fx/BloodFX.ts` | Pooled `Points` cloud (1600 droplets) and 40 pooled ground splat decals (blood or acid). |
| `fx/AcidProjectile.ts` | 14 pooled arcing acid globs: `fire(from, target)` aims at the target's predicted position, `fireAt(from, feet)` for replica visuals; hit tests vs every alive player's capsule and `world.raycast`/terrain; damage goes through `AcidHost.damageTargetAcid` (direct 18 + slow, splash 10) — a no-op on replicas. |
| `index.ts` | Barrel export. |

## Audio ids emitted
`bug_screech`, `bug_attack`, `bug_death`, `bug_step` (warrior/charger only, ≤ 30 m from the local player), `bug_hit`, `acid_splash` — throttled per id.

## Downed players (Phase 2, 2026-09-05)
A downed player (`PlayerRef.isDowned` / `RemotePlayerRef.isDowned` or `PlayerFlags.DOWNED`) is a **body, not a target**:
- `TargetList.alive` excludes them, so `nearestAlive*`, `randomAlive`, `anyAlive`, the spawner's visibility cone, wave facing and both
  `AcidProjectile` capsule/splash loops never see them. They stay in `all` for `minDist` (spawn distance / recycling) and `separate()` push-out.
- `acquireTarget` treats a downed current target like a dead one: the bug re-targets the nearest alive player if any, otherwise keeps the
  reference so the existing "nobody left to hunt → aware=false, idle/wander" branch in `EnemyAI.update` runs. `updatePerception` skips it too.
- Damage is impossible: `hitTarget`, `damageTargetAcid` and `applyDamage` (also the spewer death burst path) all return on
  `target.isDeadOrDowned`, and the local branch additionally checks `player.isDowned`.
- Ambient pressure continues: `AmbientSpawner.update` anchors on `randomAlive() ?? randomPresent()` so patrols still spawn while the whole
  squad is downed. `WaveDirector` still pauses while nobody is alive (extraction waves only pressure a squad that can fight back).

## Shared contract additions (append-only)
- `types.ts`: `EnemyHit.part?: 'head' | 'body' | 'rear' | 'front'`; consumed (Phase 2): `PlayerRef.isDowned`, `RemotePlayerRef.isDowned`, `PlayerFlags.DOWNED`.
- `events.ts`: `'player:applySlow': { duration: number; factor: number }`.
- `net.ts` (consumed): `EnemySnapshot`, `EnemyEvent`, `HitRequest`, `ExplodeRequest`, `HitConfirm`, `DamageMessage`, `NET_ENEMY_SNAPSHOT_HZ`, `NET_INTERP_DELAY`.

## Known gaps / follow-ups
- `EnemyEvent 'damaged'` carries no damager id; replicas suppress the echoed flash with a 0.4 s window after their own hit.
- `DamageMessage` has no shake/knockback field: remote victims of a charger get damage but no camera shake (their client may derive it from `amount`).
- Acid hits on remote players send only `dmg` (with `slow`), no `ee attack`, so other clients hear the splash but no bite.
- Snapshots are always `full`; delta snapshots would cut bandwidth ~5× for mostly-idle swarms.

## Fix (2026-09-05): initial population survived only by accident
`WorldSystem` (registered earlier) generates synchronously inside its own `game:newMission` handler and emits `world:ready` **before** `EnemySystem`'s `game:newMission` handler runs, so the old `game:newMission → reset()` wiped the bugs that `initialPopulate` had just spawned. The handler now resets only when `ctx.world` is not ready for that seed. Verified in headless Chrome: 18–20 bugs alive right after deploy (host and client replicas agree on ids/counts).
