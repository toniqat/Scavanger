# src/enemies — Terminid-style bug swarms, rogue gunners, gimmick bugs, lootable corpses

Owner system: `EnemySystem` (publishes `ctx.enemies`, implements `EnemyManagerRef`). Ten enemy types in two **factions**
(`bug` / `rogue`) with procedural models/animation, per-type AI, ambient patrol spawning, extraction waves, rogue crate
guards, hit detection (incl. armour plate + interceptable shells), gore FX and lootable corpses.
No asset files: every bug is built from primitives with vertex-colored chitin; rogues are a vertex-coloured humanoid rig.

**Multiplayer (host-authoritative).** The same system runs in two modes, decided per mission from `ctx.isMultiplayer` /
`ctx.isAuthority` at `world:ready` / `game:newMission` (cached for the mission — host migration only takes effect between
missions):
- **Authority** (single-player, or the lobby host): full AI hunting *every* player through `Targets.ts` (and enemies of the
  other faction through `Enemy.asTarget`); in a session it also streams `EnemySnapshot`s (10 Hz) + `EnemyEvent`s to the
  other clients and serves their `hit` / `explode` / `intq` requests.
- **Replica** (joined client): no AI / spawner / waves / damage. `net/Replica.ts` buffers host snapshots and renders the
  interpolated enemies through the same `Enemy` pools, so `raycast`, `getEnemies`, gore FX, map and HUD keep working.
  `Enemy.takeDamage` becomes an optimistic hit flash + `HitRequest`; `applyExplosion` sends an `ExplodeRequest`; a shell
  shot down locally sends `intq`.
Single-player behaviour is unchanged: only the `'local'` target exists and nothing is sent.

## Enemy types

| Type | Faction | hp | Role | Gimmick / hitboxes |
|---|---|---|---|---|
| `scavenger` | bug | 60 | swarm melee | head ×2 |
| `hunter` | bug | 180 | flanker, leap 5–9 m | head ×2 |
| `warrior` | bug | 320 | heavy melee | head ×2 |
| `spewer` | bug | 260 | acid globs 8–22 m, death burst | head ×2 |
| `charger` | bug | 900 | wind-up + rush 7–30 m | rear ×2.5, front ×0.5 |
| `rogue` | rogue | 140 | humanoid gunner guarding crates | head ×2; rifle hitscan `ROGUE_DAMAGE`, `ROGUE_BURST` rounds |
| `rogue_boss` | rogue | 140 × `ROGUE_BOSS_HP_MUL` | `ROGUE_BOSS_SCALE`× rogue with pauldron + red visor, `ROGUE_BOSS_ESCORTS` escorts | 6-round burst, damage ×1.6 |
| `artillery` | bug | 420 | stand-off mortar at `ARTILLERY_RANGE` | never melees; lobs interceptable shells every 6–9 s; rear ×1.5 |
| `toxic` | bug | 70 | fast suicide runner | swells 0.6 s within `TOXIC_TRIGGER_DIST`, bursts `TOXIC_DAMAGE` in `TOXIC_RADIUS` (friendly fire); no stagger |
| `behemoth` | bug | 1400 | `BEHEMOTH_SCALE`× warrior (6.4 m) | **front plate** = armoured hitbox (`EnemyHit.armored`, front ×0.35), rear ×2; wind-up + line charge with knockback |

Gameplay numbers live in `EnemyTypes.ts` (`ENEMY_STATS`, `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`,
`ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`); world-level constants (`CORPSE_*`, `ROGUE_*`, `ARTILLERY_RANGE`, `SHELL_*`,
`TOXIC_*`, `BEHEMOTH_*`) come from `@/shared/constants`.

| File | Responsibility |
|---|---|
| `EnemySystem.ts` | The `GameSystem`. Pools `Enemy` instances per type (`acquire(id, …)` for both host spawns and replicas; `byId` map), refreshes `TargetList` + spatial grid + every enemy's `asTarget` proxy each frame, ticks AI only on the authority while `ctx.isGameplayPhase()` (visuals always tick), despawns finished corpses (`Enemy.corpseLife` = `CORPSE_LIFETIME`; replicas +1 s) and fled bugs (2 s). Implements `EnemyManagerRef`: `raycast` (analytic ray vs vertical hit capsule + head sphere + behemoth plate capsule → `part: 'front', armored: true`), `raycastInterceptable` (shell spheres), `applyExplosion` (host: linear falloff, returns kills; replica: FX + `explode` request, returns 0), `setThreatLevel`, `startExtractionWaves` / `stopExtractionWaves`, `killAll`, `reset`. Listens: `world:ready` (mode refresh, reset, initial patrols + **rogue guards** on authority → `enemy:bossSpawned`), `game:newMission`/`game:abort`, `game:paused` (pauses only when `freeze !== false`), `weapon:fired` + `net:remoteFired` (hearing 55 m, authority), `grenade:exploded` (80 m), `extraction:activated`, `extraction:liftoff` (stop waves; authority: bugs within 18 m flee), `enemy:waveStarted` (host → `ee wave`), `crate:looted` (corpse searched). Net messages: host handles `hit` (→ `takeDamage(dmg, p, d, from)` → replies `hitc` with actual damage / killed / part; ignores `dmg > 500`), `explode` (→ `hitc` per kill) and `intq` (validates the shell still flies → pop + `ee intercept`); replica handles `es`, `ee`, `hitc` (kill hitmarker). Emits all `enemy:*` / `corpse:*` events, `audio:play`, `camera:shake`, `player:applySlow`. Damage routing `applyDamage`: local target → `ctx.player.takeDamage` + `enemy:attacked`; remote → `dmg` to that peer (+ `ee attack` to the others for melee/leap/charge); **enemy target** (`CombatTarget.enemy`) → `Enemy.takeDamage(…, 'ai')` + `noteClash`. Kill credit: `ctx.stats.kills++` / `enemy:killed` only when `e.lastDamager === 'local'` (never for `'ai'`; remote killers get credit from the `kill` event on their client). Also the `EnemyHost` (`pickTarget`, `fireGun`, `fireShell`, `chargeHit`, `onChargeStarted`) / `SpawnHost` (`countAlive`) / `RogueSpawnHost` (`spawnRogue`) / `AcidHost` / `ShellHost` / `ReplicaHost` services. Debug: `debugSpawn(type, {x,z}, chase?)`, `debugShell(sid)`, `shellCount`, `bossId`, `corpses`, `active`. |
| `Targets.ts` | `CombatTarget { id: PeerId \| 'local' \| 'ai'; position; velocity; isDead; downed; isDeadOrDowned; present; yaw; eyeHeight; enemy; getEyePosition/getForward/getChest/dist2D; bodyRadius/bodyHeight }` — a stable object per player, plus one per enemy (`Enemy.asTarget`, `id 'ai'`, `enemy` set, synced by the system). `TargetList.refresh(ctx)` rebuilds `all` / `alive` each frame from `ctx.player` plus `ctx.net.getRemotePlayers()` filtered to `connected && !stale && !DROPPING`; `downed` = `player.isDowned` / `r.isDowned \|\| flags & DOWNED`. `alive` = present && !dead && !downed (the only players the AI may target or damage); `all` also holds downed and dead bodies (separation, `minDist`, spawn-distance checks). Enemy proxies are **not** in the list — `EnemySystem.pickTarget` scans `active` instead. Queries: `nearestAlive`, `nearestAliveWithin`, `minDist`, `distToLocal`, `randomAlive`, `randomPresent`, `local`, `anyAlive`. |
| `Enemy.ts` | Entity implementing `EnemyRef` (`faction` getter, `isRogue`, `isCombatant`). Holds gameplay state (hp, state machine fields, timers, charge/leap/spit phases, cached obstacles), `target: CombatTarget \| null` + `targetTimer` + `distToTarget`, `lastDamager` (kill credit), `lastLocalHit` / `netBuf` (replica), Phase 4 memory (`roguePhase`, `guardPos`/`leash`/`escortOf`, `coverPos`, burst timers, `weaponId`; `shellTimer`/`dug`; `toxicPhase`/`swellTimer`; `chargeSeq`/`chargeEnd`/`chargeVictims`/`hitByCharge`; `corpseLife`) and the rig (`EnemyRig = BugRig \| RogueRig`) + `BugAnim`. `takeDamage(amount, hitPoint?, hitDir?, attacker = 'local')` classifies the hit (`head` / `rear` / `front`; behemoth `isFrontPlate(point)` → `front`), applies per-type multipliers, hit-flash/flinch, stagger (never for a swelling toxic), death; a popped-out rogue that gets hit ducks (`hitCrouchTimer`); on a replica it stops after the visuals and calls `host.requestHit`. `muzzle(out)` = rifle tip (rogues). `animate()` syncs the rig every frame (`fade` over the last 3 s of `corpseLife`). `EnemyHost` interface lives here. |
| `EnemyTypes.ts` | `ENEMY_STATS` table (with `faction`) plus ability tuning `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`, `ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`; `BugType` (rig type), `isRogueType`. |
| `RayTests.ts` | Allocation-free `raySphere`, `rayCapsule`, `rayStandingCapsule` shared by hit detection, rogue shots and shell interception. |
| `SpatialGrid.ts` | Allocation-free uniform XZ hash grid, rebuilt per frame, used for separation queries. |
| `Spawner.ts` | `AmbientSpawner` (threat 0..1 → cap `12 + 24·threat`, patrol every 12–25 s from nests 60–140 m around a random alive player — or a random present body via `randomPresent` when everyone is downed — initial population on `world:ready`; from threat 0.5 `maybeArtillery` digs one in 80–120 m out, ≤ `MAX_ARTILLERY` alive), spawn helpers `findSpawnCenter`, `isVisibleToAnyPlayer`, `spawnGroup`, compositions `ambientGroup` (toxics from threat 0.4) / `waveGroup` (toxics from wave 2, a behemoth from wave 3), and the `SpawnHost` interface (`targets`, `countAlive`). |
| `RogueGuards.ts` | `placeRogueGuards(host, seed)` on `world:ready` (authority): squads of 2–4 rogues 6–12 m around every tier-3/4 crate and 30 % of tier-2 crates (> 45 m from the player spawn), ≤ `MAX_GUARDS` (16) in total; one random tier-3/4 crate gets the `rogue_boss` + `ROGUE_BOSS_ESCORTS` escorts (leash to the boss). Seeded by the world seed; rifles from `ROGUE_AI.weapons` (boss `ROGUE_AI.bossWeapon`). `RogueSpawnHost.spawnRogue`. Guards are not waves and are never recycled by `ensureCapacity`. |
| `WaveDirector.ts` | Extraction waves: first wave 3 s after activation, then every 14 s → 9 s; size 6, 8, 10 … (≤ 22), split into 1–3 groups spawned 45–90 m from the target, facing the nearest alive player; pauses while nobody is alive. A second behemoth (`MAX_BEHEMOTH`) becomes a warrior. Emits `enemy:waveStarted`. Alive cap 60. Authority only. |
| `Corpses.ts` | `Corpse` (`Interactable` `corpse:<enemyId>`, `CORPSE_INTERACT_RADIUS`, `holdTime` 0.6, prompt `시체 수색` → `수색 완료`; `canInteract` = `ctx.isGameplayActive()` && player alive & not downed && `ctx.inventory.openContainerItems` exists; `interact()` rolls once via `ctx.loot.rollCorpse(type, new Random(seed ^ id·φ), weaponId)` and calls `ctx.inventory.openContainerItems(id, items, position, '시체')`; an empty roll counts as searched) and `CorpseManager` (`add` → `corpse:spawned`, `remove` → `corpse:removed`, `markLooted(containerId)` from `crate:looted`, own `CORPSE_LIFETIME` safety timer, `clear`). Contents are per-client like crates. |
| `ai/EnemyAI.ts` | State machine per bug: `idle` → `wander` → `alert` → `chase` → `attack` → `stagger`, plus `dead`/`flee`. Everything target-relative reads `e.target` (`acquireTarget` each tick). Rogues branch to `RogueAI.updateRogue` after perception; artillery / toxic / behemoth chase & attack dispatch to `GimmickAI`. Charger rush contact and hunter leap landing hit the nearest alive (not downed) player in range; melee / spit fire only while `!e.target.isDeadOrDowned`. `integrate()` (exported) handles steering, separation, obstacle avoidance (a charging body that deviates → `stumble` with the type's cooldown; behemoth shakes the camera), terrain snapping, gait, footsteps, yaw, slope. |
| `ai/RogueAI.ts` | Humanoid gunner: guards idle / patrol 6–12 m around `guardPos` (escorts 3–6 m around the boss, `guardPos` follows it), `alert` = `ROGUE_REACTION` delay with the rifle raised, then the **cover cycle** in `chase` via `roguePhase`: 0 pick cover (`pickCover`: obstacle ≤ 16 m with radius ≥ 0.5 / height ≥ 0.8 roughly between rogue and target; cover point on the far side, inside the leash) → 1 move there (snap shots while relocating) → 2 crouch-hold 2–4 s (hint 6; boss ×0.6; target < 6 m pops out early) → 3 stand and fire `ROGUE_BURST` rounds 0.12 s apart (hint 5) with aim error `ROGUE_AIM_ERROR` → `ROGUE_AIM_ERROR_SETTLED` over 1.2 s standing; no LOS for 1.2 s → new cover; after the burst `ROGUE_RUSH_CHANCE` → 4 **rush** to ~8 m firing from the hip every 0.28 s (hint 7, error ×1.6, ≤ 6 s) else back to 0. Leash: never farther than `leash` (45 m; escorts 18 m) from `guardPos` unless rushing or the target is visible within 30 m. Shots go through `host.fireGun`. Stagger: crouch, then resume. |
| `ai/GimmickAI.ts` | `chaseArtillery` (retreat when < 60 m, approach when > 125 m, otherwise dig in over 1.2 s — `dug`, hint 8 — and `host.fireShell` every 6–9 s at ≤ 140 m; never melees), `chaseToxic` / `attackToxic` (weaving runner; within `TOXIC_TRIGGER_DIST` of its target or any alive player → swell 0.6 s, hint 9, then `kill(false)` → burst), `chaseBehemoth` / `attackBehemoth` (approach to 18 m; wind-up `BEHEMOTH_WINDUP` with roar, hint 10; then a straight line at `BEHEMOTH_CHARGE_SPEED` toward the target's position at wind-up end + 6 m, hint 11; players within radius + 0.85 m → `host.chargeHit` once per charge with a sideways knock direction; enemies of either faction in the path → 160 damage `'ai'` + shove + stagger; end / 3.2 s / obstacle → stumble, cooldown 4 s; melee like a warrior in between). |
| `ai/Common.ts` | `lookAtTarget`, `startMelee`, `stumble(e, cooldown, duration)`, `AttackResult` shared by the three AI modules. |
| `ai/Steering.ts` | `seek`, `separate` (mass-weighted positional correction via the grid + push-out from every alive `CombatTarget`), `avoidObstacles`, `turnToward`, `yawTo`. |
| `ai/Perception.ts` | `acquireTarget`: `host.pickTarget(e)` (players and hostile enemies), re-evaluated every 0.5–0.9 s or when the target dies / goes down / leaves; hysteresis (switch only when another is < 0.6× / 0.75× as far, with/without LOS). Staggered 0.3 s perception tick: sight `sightRadius` (bugs 40, rogues 60, artillery 130) with LOS to the target's chest, target loss after 10 s unseen & > 60 m — skipped for `relentless`, artillery, and rogues with a target inside 80 m. `becomeAlert` emits `enemy:alerted`, screech audio (rogues stay silent), propagates 20 m within the same faction. |
| `net/HostSync.ts` | Host encoding: `encodeSnapshot(active, time)` → `EnemySnapshot { full: true, e: EnemyWire[] }` with p 2 dp / yaw 3 dp / hp 1 dp, `a` hint (1 charger windup, 2 rush, 3 spewer windup, 4 hunter airborne, **5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery dug in, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush**) and `w` (rogue rifle id), `sb` status bits (`statusBits`, Phase 6). Corpses leave the snapshot 1.5 s after death (replicas keep them from their own corpse timer). ~90 B per enemy as JSON. |
| `net/Replica.ts` | Client replica: `ReplicaBuffer` (8-sample ring per enemy) with lerp / shortest-arc yaw / ≤ 0.25 s extrapolation; `EnemyReplica.onSnapshot` (get-or-create by host id; ids missing from a `full` snapshot → release, **except dead bodies**), `onEvent` (`spawn`, `kill` + kill credit when `killer === localId`, `despawn`, `damaged`, `attack`, `acid`, `wave`; Phase 4: `shoot` → tracer/flash/audio + `enemy:shot`, `shell` → visual shell, `intercept` → pop, `shellHit` → landing FX (skipped when the local copy already landed), `charge` → `enemy:chargeStarted`, `toxic` → green burst FX + `enemy:toxicBurst`, `corpse` / `corpseGone` → `CorpseManager`), `update` renders at `ctx.time − NET_INTERP_DELAY`, clamps y to terrain unless airborne, drives `BugAnim` (gait from displacement; shake/abdomen/crouch/aim/mandible from state + hint; head tracking; slope) and mirrors `sb` into the status timers (`applyStatusBits`, Phase 6). |
| `models/BugParams.ts` | Per-type visual parameters for the six-legged rig (`BugType`), incl. Phase 4 `mortar` (artillery tube), `frontPlate` (behemoth), `sacSwell` (toxic); `behemoth` = warrior params scaled ×`BEHEMOTH_SCALE`. |
| `models/BugModel.ts` | Shared per-type geometry/material assets, `createBugRig` (`kind: 'bug'`, `baseScale`, optional `mortar` group), `animateBug` (tripod gait, bob/lean/slope, head tracking, mandibles, hit flash, flinch, sac pulse/swell, wind-up shake, leap crouch, mortar recoil, death roll — the body **stays on the ground** and only sinks during `fade`). `BugAnim` adds `fade`, `aim`, `recoil`. |
| `models/RogueModel.ts` | Procedural humanoid rig (`kind: 'rogue'`): pelvis/torso/head with emissive visor, arms + rifle block (`gun` group, `muzzle` marker), two legs; boss = same geometry scaled by `ROGUE_BOSS_SCALE` (`baseScale`) with a pauldron and red visor. `animateRogue` from the shared `BugAnim`: walk cycle, cover crouch, low-ready ↔ aimed rifle (`aim`), recoil kick, look/aim from `headYaw/headPitch`, flinch, hit flash, fall + fade. |
| `fx/BloodFX.ts` | Pooled `Points` cloud (1600 droplets) and 40 pooled ground splat decals (blood or acid). Particle-only kinds `ember` (burning / 전소, orange) and `spark` (shocked, cyan). |
| `fx/AcidProjectile.ts` | 14 pooled arcing acid globs: `fire(from, target)` aims at the target's predicted position, `fireAt(from, feet)` for replica visuals / enemy targets; hit tests vs every alive player's capsule and `world.raycast`/terrain; damage goes through `AcidHost.damageTargetAcid`. |
| `fx/ShellProjectile.ts` | 10 pooled artillery shells (dark sphere, smoke trail from `FxManager.alpha`, ballistic arc reaching the aim point after `SHELL_FLIGHT_TIME`). Each shell is an `InterceptableRef` (`radius` `SHELL_RADIUS`, `intercept()`); `raycast` = nearest sphere hit for `EnemyManagerRef.raycastInterceptable`; landing (terrain/obstacle raycast, ground, bounds, timeout) → `ShellHost.onShellLanded` (host: `SHELL_DAMAGE` with falloff to players in `SHELL_BLAST_RADIUS` + `explode` on every enemy — friendly fire; everyone: crater dust / fireball / shake / `enemy:shellLanded`); `interceptShell` → pop FX + `ShellHost.onShellIntercepted(sid, p, local)`. Same class renders host and replica shells. |
| `index.ts` | Barrel export. |

## Faction warfare (Phase 4)
- Every `Enemy` owns a `CombatTarget` proxy (`asTarget`, id `'ai'`, `enemy` back-reference) synced each frame, so the existing
  hunting code (chase / melee / spit / charge / `hitTarget`) works on enemies unchanged.
- `EnemySystem.pickTarget(e)`: **bugs** take the nearest of (alive players, rogues within `sightRadius`) — equal priority;
  **rogues** prefer the nearest alive player within `ROGUE_RANGE` (55 m) unless a bug is within `ROGUE_AI.bugRange` (25 m) and
  clearly closer, else the nearest bug, else the player. Downed players stay excluded (Phase 2 rules untouched).
- Damage between enemies goes through `Enemy.takeDamage(…, 'ai')` — no kill credit, no stats; the `kill` wire event carries
  `killer: null`. `alertNear` propagation stays inside a faction; rogue gunfire wakes bugs through `weapon:fired`-style hearing
  only via their own perception (they see the rogues).
- `enemy:factionClash {position}` fires on the first bug ↔ rogue damage / rogue shot at a bug within 40 m of the local player,
  throttled 15 s (`noteClash`).

## Corpses
Every death (authority) registers `corpse:<id>` at the body and emits `corpse:spawned`; hosts send `ee corpse {id, ty, p, w}`
so replicas register the same interactable; `ee corpseGone` / `corpse:removed` when the body despawns (after `CORPSE_LIFETIME`
45 s, or when recycled by `ensureCapacity`, `CORPSE_SLACK` 30). Bodies stay visible for the whole lifetime and sink/fade during
the last 3 s (`BugAnim.fade`). Toxic bugs leave a corpse too (their loot table is the items folder's call).

## Audio ids emitted
`bug_screech`, `bug_attack`, `bug_death`, `bug_step` (warrior/charger/behemoth/boss only, ≤ 30 m from the local player),
`bug_hit`, `acid_splash`, `shot_rifle` (rogue shots, pitch 0.9), `hit_flesh` (rogue hit / shot landing on a player),
`player_death` (rogue death), `explosion` (shell landing / interception) — throttled per id.

## Downed players (Phase 2, 2026-09-05)
A downed player (`PlayerRef.isDowned` / `RemotePlayerRef.isDowned` or `PlayerFlags.DOWNED`) is a **body, not a target**:
- `TargetList.alive` excludes them, so `nearestAlive*`, `randomAlive`, `anyAlive`, the spawner's visibility cone, wave facing and both
  `AcidProjectile` capsule/splash loops never see them. They stay in `all` for `minDist` (spawn distance / recycling) and `separate()` push-out.
- `acquireTarget` treats a downed current target like a dead one: the bug re-targets the nearest alive player if any, otherwise keeps the
  reference so the existing "nobody left to hunt → aware=false, idle/wander" branch in `EnemyAI.update` runs. `updatePerception` skips it too.
- Damage is impossible: `hitTarget`, `damageTargetAcid`, `applyDamage`, rogue shots (capsule tests use `targets.alive`), shell blasts,
  toxic bursts and behemoth charges all read `targets.alive` / return on `target.isDeadOrDowned`.
- Ambient pressure continues: `AmbientSpawner.update` anchors on `randomAlive() ?? randomPresent()` so patrols still spawn while the whole
  squad is downed. `WaveDirector` still pauses while nobody is alive.

## Shared contract additions (append-only)
- `types.ts` (consumed): `EnemyType` Phase 4 members, `EnemyFaction` + `EnemyRef.faction`, `EnemyHit.part` / `armored`, `InterceptableRef`,
  `EnemyManagerRef.raycastInterceptable`, `InventoryRef.openContainerItems`, `LootRef.rollCorpse`, `PlayerRef.applyKnockback`, `Interactable`,
  `WorldRef.getCrates` / `getObstaclesNear`.
- `events.ts` (emitted): `enemy:shot`, `enemy:shellFired/Intercepted/Landed`, `enemy:chargeStarted`, `enemy:toxicBurst`, `enemy:bossSpawned`,
  `corpse:spawned`, `corpse:removed`, `enemy:factionClash`, `player:applySlow`; consumed: `crate:looted`.
- `net.ts` (consumed): `EnemySnapshot`, `EnemyEvent` (+ `shoot/shell/intercept/shellHit/charge/toxic/corpse/corpseGone`), `EnemyWire.a` 5–11,
  `EnemyWire.w`, `HitRequest`, `ExplodeRequest`, `InterceptRequest`, `HitConfirm`, `DamageMessage`, `NET_ENEMY_SNAPSHOT_HZ`, `NET_INTERP_DELAY`.

## Shared contract consumed (tactical kit)
- `types.ts`: `EnemyManagerRef.queryNear / addDistraction / applyStatus / applyAreaDamage`, `PlayerRef.getStealthFactor`.
- `constants.ts`: `CLOAK_DETECT_MUL`, `CLOAK_REVEAL_DISTANCE`, `GADGET_LURE_RADIUS`.
- `gadgets.ts`: `ctx.gadgets?.visionFactor / findDistraction / findEnemyTarget / blocksProjectile / fireDamageAt`, `DeployableRef.takeDamage`.
- `net.ts`: `PlayerFlags.CLOAKED`.
Every one of these is optional-chained with a neutral default (factor 1, no lure, no structure), so the bugs behave exactly as before while `gadgets/`, `implants/`, `progression/` and the new `player/` members are still landing.

## Status effects: 전소 / 감전 (Phase 6, 2026-09-06)
`EnemyManagerRef.applyStatus(id, status, dps, duration)` now covers all four `EnemyStatusKind`s (`burning` / `slowed` are the
tactical-kit originals):

| Status | Gameplay (authority) | Visual (every client) | Event |
|---|---|---|---|
| `incinerated` 전소 | `Enemy.incinerate(duration)`: rides on the **`stagger`** state (`staggerTimer` is kept ≥ `incapTimer`, `enterStagger` never shortens it) so movement, melee, spits, charges, bursts, toxic swells and rogue shots all stop; `isIncapacitated` true; `isCombatant` false (the other faction drops it as a target, `pickTarget` skips it; players can still shoot it and a kill mid-writhe works — `kill()` clears the timer). The AI stagger case ticks `incapTimer` and, when both timers are out, resumes `chase` / `idle` like a normal stagger. `dps` ignored; `duration` 0 clears it. | `BugAnim.writhe` (damped from `incapTimer` in `Enemy.animate`): bugs twist / buck the thorax, kick all six legs out of phase and snap the mandibles; rogues drop to a half-crouch, buck the pelvis, kick and wave the rifle. Chitin emissive glows orange (`statusEmissive`) and ember puffs come every `INCAP_EMBER_INTERVAL` (0.12 s, 5 particles — the burning pool, no lights). Scream (`bug_screech` pitch 1.35 / rogues `player_hurt`) + 14-ember burst on entry. | `enemy:incinerated {id, position, duration}` once per 전소 (re-applying while it runs only extends it) |
| `shocked` 감전 | Slow: `dps` is the **speed multiplier** (`SHOCK_SLOW_FACTOR` 0.55 → 55 % speed, clamped 0.2…1; strongest wins) for `duration` s via the existing `slowFactor` / `slowTimer`. | `shockTimer` (≤ `SHOCK_SPARK_TIME` 0.6 s per application): `BugAnim.spark` cyan-white emissive strobe + `spark` particle puffs every 0.09 s. | `enemy:shocked {id, position}` once per shock (the arc calls `applyStatus` every frame — only a fresh `shockTimer` emits) |

**Multiplayer.** `HitRequest.st` (bits of `ENEMY_STATUS_BITS`) + `dur` ride on the existing `hit` message: a replica's `applyStatus` keeps its
optimistic local visual (and emits the event) and calls `requestStatus` → `hit {id, dmg: 0, p, d, st, dur}` to the host, throttled to one
request per enemy per `STATUS_REQUEST_INTERVAL` (0.25 s) for repeated bits (flame / arc callers). The host (`onHitRequest`) now accepts
`dmg` 0 when `st` is set, applies the damage first (unchanged `hitc` reply), then `applyStatusBits` with the wire duration clamped to
`MAX_STATUS_DURATION` (10 s); the wire carries no dps, so burning uses `FLAME_AFTERBURN_DPS`, shocked `SHOCK_SLOW_FACTOR`, slowed 0.4.
`EnemyWire.sb` (`HostSync.statusBits`: burning / slowed / incinerated / shocked, omitted when 0) is stored in the replica ring buffer and
`EnemyReplica.applyStatusBits` mirrors it into the same timers the authority uses (`burnTimer` / `slowTimer` / `incapTimer` / `shockTimer`,
held `STATUS_HOLD` 0.35 s per snapshot, clamped down when the bit disappears) — so **burning is no longer host-local** (old follow-up
closed) and a bit that rises with an idle local timer emits `enemy:incinerated` / `enemy:shocked` on the client too. `animHint` returns 0
for an incapacitated rogue so the replica shows the writhe rather than the cover crouch.

## Known gaps / follow-ups
- Phase 6: the replica's optimistic 전소 lasts the caller's full duration even if the host rejects it (only a `dead` snapshot or the
  missing `sb` bit — clamped to 0.35 s — ends it); status requests are not validated against distance / weapon. `applyStatus('shocked')`
  from the host side has no attacker parameter, so a shock-then-burn kill is credited to the last damager. Snapshot `sb` adds ~8 B per
  affected enemy.
- `EnemyEvent 'damaged'` carries no damager id; replicas suppress the echoed flash with a 0.4 s window after their own hit.
- `DamageMessage` has no shake/knockback field: remote victims of a charger / **behemoth charge** get damage but no camera shake or
  knockback (`applyKnockback` is local-only); rogue shots at remote players send `dmg` without `ee attack`, so other clients see the
  tracer (`ee shoot`) but no bite audio.
- Acid hits on remote players send only `dmg` (with `slow`), no `ee attack`.
- Snapshots are always `full`; delta snapshots would cut bandwidth ~5× for mostly-idle swarms. Corpses are dropped from the snapshot after
  1.5 s, so a client that joins mid-mission (`rejoinMission`) sees no existing bodies / corpse interactables.
- Replica shells are simulated locally from `ee shell`; the host's `shellHit` is only used when the local copy is still flying, so a shell
  may land a few cm apart on different clients. The host validates `intq` only by shell id (no distance check).
- Rogue cover selection uses obstacle cylinders only (no terrain ridges); rogues never use the melee path — a bug in their face gets shot
  point-blank. Rogues ignore friendly fire (a same-faction rogue in the line just stops the tracer). Behemoth hitbox for the plate is a
  round capsule, thicker than the visual plate. Toxic corpses use the generic `rollCorpse('toxic')` (items decides what a toxic drops).
- The behemoth is `BEHEMOTH_SCALE` (4)× a warrior = 6.4 m tall / 3.2 m radius: small rocks stop its charge (`resolveCollision`) and it
  cannot pass between close obstacles; tune `BEHEMOTH_SCALE` if it gets stuck on real maps.
- Guard placement is host-seeded but the individual rogue ids depend on spawn order after the ambient population; clients only ever
  receive ids from the wire, so this is cosmetic.

## Fix (2026-09-05): initial population survived only by accident
`WorldSystem` (registered earlier) generates synchronously inside its own `game:newMission` handler and emits `world:ready` **before** `EnemySystem`'s `game:newMission` handler runs, so the old `game:newMission → reset()` wiped the bugs that `initialPopulate` had just spawned. The handler now resets only when `ctx.world` is not ready for that seed. Verified in headless Chrome: 18–20 bugs alive right after deploy (host and client replicas agree on ids/counts).

## Verification (Phase 4, 2026-09-06)
`npm run typecheck` 0 errors. `node scripts/smoke-phase4.mjs` (single-player, seed 21, headless Chrome, sim-time waits): 16 guards placed
around tier ≥ 2 crates + one boss with 3 escorts, a rogue engages the player at 22 m with LOS (`enemy:shot`, burst of 4, hits registered),
warrior spawned beside a rogue → `enemy:factionClash` + hp exchanged, artillery 95 m out digs in and fires (`enemy:shellFired`),
`raycastInterceptable` hits the shell sphere at 5.4 m and misses 5 m aside, `intercept()` → `enemy:shellIntercepted` + pool freed, later
shell lands (`enemy:shellLanded` radius 5), toxic killed by gunfire bursts and takes a neighbouring scavenger from 60 hp to < 1,
behemoth front raycast → `part 'front', armored true` (×0.35), rear → `rear` (×2), corpse `corpse:<id>` registered (hold 0.6, radius 2.4,
prompt 시체 수색 → 수색 완료 after `crate:looted`), `interact()` → `openContainerItems('corpse:<id>', items, pos, '시체')`, bodies stay in
the scene. 0 console errors besides the relay socket (no server running).

## Tactical kit (merged 2026-09-06)

Files added by the tactical-kit branch (their rows were kept out of the main table above so the Phase 4 descriptions stay intact):

| File | Role |
|---|---|
| `ai/Lures.ts` | `LureField`: ≤ 12 noise beacons (`add` merges within 2 m, drops the weakest when full, `prune` expires them). `best(pos, out, now)` returns the strongest 0..1 weight whose radius covers `pos` with a mild distance falloff. Fed by `EnemyManagerRef.addDistraction` (lure grenade) and by gunfire (weight 0.25, 4 s); merged with `ctx.gadgets.findDistraction` (weight 0.85) in `EnemySystem.lureFor`. |
| `ai/Structures.ts` | Deployable targeting. `refreshStructureTarget` (≤ every 0.7 s per bug, one `findEnemyTarget` + one `blocksProjectile` call): melee types take a deployable only when it stands between them and their player (`blocksProjectile(eye, chest, true)`) or is already within biting range; spewers take one whenever the player is hidden, something blocks the line, or the structure is closer. `biteStructure` deals `attackDamage × STRUCT_DAMAGE_MUL` (1.6). |

Perception rework (`ai/Perception.ts`, merged with the Phase 4 artillery / rogue exceptions): `acquireTarget`: nearest alive player, re-evaluated every 0.5–0.9 s or when the target dies/leaves; hysteresis (switch only when another is < 0.6× / 0.75× as far, with/without LOS). Staggered 0.3 s perception tick. **Detection rework (tactical kit)**: `detectionRange = sightRadius × target.stealth × visionClarity`, where `stealth` comes from `PlayerRef.getStealthFactor()` (remote: `CLOAK_DETECT_MUL` when `CLOAKED`) and `visionClarity` from `ctx.gadgets.visionFactor(eye, chest)` (smoke). An alerted bug always sees within `CLOAK_REVEAL_DISTANCE`. Once alerted it tracks up to `min(90 × clarity, max(range × 2.2, CLOAK_REVEAL_DISTANCE))` — ~88 m for a plain target, ~16 m for a cloaked one, 0 through smoke (`clarity ≤ 0.4` blinds it beyond 4 m). Target loss after 10 s past that range. The same tick refreshes the bug's lure (`host.lureFor`) and applies `ctx.gadgets.fireDamageAt` so fire zones burn bugs even if `gadgets/` never calls `applyStatus`. `becomeAlert` emits `enemy:alerted`, screech audio, propagates 20 m.

- `EnemyManagerRef` additions: `queryNear`, `addDistraction` (lure grenade / gunfire noise), `applyStatus` (burning DoT with ember puffs, slow), `applyAreaDamage` (turret / mine / rocket, credited to the caller).
- `Enemy` carries lure / suspicion (smoke return fire) / burning / slow / deployable-target state; `EnemyHost` gained `lureFor`, `fireAcidAt`, `emberBurst`.
  Phase 6 added `incapTimer` (전소), `shockTimer` / `sparkTimer` (spark visual), `statusReqBits` / `statusReqAt` (replica request throttle),
  `incinerate(duration)`, `isIncapacitated`, and `BugAnim.writhe` / `spark` (`models/BugModel.ts`, shared `statusEmissive` used by both rigs).
- Melee bugs bite a barricade / dome that stands between them and their target (`ai/Structures.ts`); spewers spit at deployables and at the last heard shot when the shooter hides in smoke.
- Lures and distractions are authority-only state; a joining client does not learn about an existing lure (it only matters for AI, which the host owns).
