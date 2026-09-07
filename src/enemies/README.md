# src/enemies — Terminid-style bug swarms, rogue gunners, gimmick bugs, lootable corpses

Owner system: `EnemySystem` (publishes `ctx.enemies`, implements `EnemyManagerRef`). Ten enemy types in two **factions**
(`bug` / `rogue`) with procedural models/animation, per-type AI, ambient patrol spawning, extraction waves, rogue crate
guards, hit detection (incl. armour plate + interceptable shells), gore FX and lootable corpses.
No asset files: every bug is built from primitives with vertex-colored chitin; rogues are a vertex-coloured humanoid rig.

**Multiplayer (host-authoritative).** The same system runs in two modes, decided per mission from `ctx.isMultiplayer` /
`ctx.isAuthority` at `world:ready` / `game:newMission` (`refreshMode`) and switched **live** by `setAuthority` on
`net:hostChanged` (Phase 7 host migration — see "Live authority" below; nothing else caches the flag):
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
| `rogue` | rogue | 140 | humanoid gunner guarding crates | head ×2; rifle hitscan `ROGUE_DAMAGE`, `ROGUE_BURST` rounds, `ROGUE_MAG_ROUNDS` magazine + `ROGUE_RELOAD_TIME` reload, grenade toss (Phase 7) |
| `rogue_boss` | rogue | 140 × `ROGUE_BOSS_HP_MUL` | `ROGUE_BOSS_SCALE`× rogue with pauldron + red visor, `ROGUE_BOSS_ESCORTS` escorts | 6-round burst, damage ×1.6, grenade cooldown ×0.7 |
| `artillery` | bug | 420 | stand-off mortar at `ARTILLERY_RANGE` | never melees; lobs interceptable shells every 6–9 s; rear ×1.5 |
| `toxic` | bug | 70 | fast suicide runner | swells 0.6 s within `TOXIC_TRIGGER_DIST`, bursts `TOXIC_DAMAGE` in `TOXIC_RADIUS` (friendly fire); no stagger |
| `behemoth` | bug | 1400 | `BEHEMOTH_SCALE`× warrior (4.8 m tall / 2.4 m radius since Phase 7's scale 3; every number derives from the constant: `ENEMY_STATS` radius / height / head / attack range, `BugParams.scaled`) | **front plate** = armoured hitbox (`EnemyHit.armored`, front ×0.35), rear ×2; wind-up + line charge with knockback (remote victims get `dmg.kb`) |

Gameplay numbers live in `EnemyTypes.ts` (`ENEMY_STATS`, `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`,
`ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`); world-level constants (`CORPSE_*`, `ROGUE_*`, `ARTILLERY_RANGE`, `SHELL_*`,
`TOXIC_*`, `BEHEMOTH_*`) come from `@/shared/constants`.

| File | Responsibility |
|---|---|
| `EnemySystem.ts` | The `GameSystem`. Pools `Enemy` instances per type (`acquire(id, …)` for both host spawns and replicas; `byId` map), refreshes `TargetList` + spatial grid + every enemy's `asTarget` proxy each frame, ticks AI only on the authority while `ctx.isGameplayPhase()` (visuals always tick), despawns finished corpses (`Enemy.corpseLife` = `CORPSE_LIFETIME`; replicas +1 s) and fled bugs (2 s). Implements `EnemyManagerRef`: `raycast` (analytic ray vs vertical hit capsule + head sphere + behemoth plate capsule → `part: 'front', armored: true`), `raycastInterceptable` (shell spheres), `applyExplosion` (host: linear falloff, returns kills; replica: FX + `explode` request, returns 0), `setThreatLevel`, `startExtractionWaves` / `stopExtractionWaves`, `killAll`, `reset`. Listens: `world:ready` (mode refresh, reset, initial patrols + **rogue guards** on authority → `enemy:bossSpawned`), `game:newMission`/`game:abort`, `game:paused` (pauses only when `freeze !== false`), `weapon:fired` + `net:remoteFired` (hearing 55 m, authority), `grenade:exploded` (80 m), `extraction:activated`, `extraction:liftoff` (stop waves; authority: bugs within 18 m flee), `enemy:waveStarted` (host → `ee wave`), `crate:looted` (corpse searched). Net messages: host handles `hit` (→ `takeDamage(dmg, p, d, from)` → replies `hitc` with actual damage / killed / part; ignores `dmg > 500`), `explode` (→ `hitc` per kill) and `intq` (validates the shell still flies → pop + `ee intercept`); replica handles `es`, `ee`, `hitc` (kill hitmarker). Emits all `enemy:*` / `corpse:*` events, `audio:play`, `camera:shake`, `player:applySlow`. Damage routing `applyDamage`: local target → `ctx.player.takeDamage` + `enemy:attacked`; remote → `dmg` to that peer (+ `ee attack` to the others for melee/leap/charge); **enemy target** (`CombatTarget.enemy`) → `Enemy.takeDamage(…, 'ai')` + `noteClash`. Kill credit: `ctx.stats.kills++` only when `e.lastDamager === 'local'` (Phase 9 tightened this so a credit belonging to another peer never bumps the local stats even in single-player); `enemy:killed {by}` is emitted for **every player-credited** kill — `by` is `'local'` for our own (our peer id is folded back by `normalizeAttacker`, so the payload reads the same online and offline) and the peer id when someone else gets the credit (e.g. a burn lit by a remote peer, `Enemy.burnAttacker`). An AI (faction) kill would be `by: null` and stays **off** the bus; the replica's `ee kill` still emits only for our own credit (`msg.killer === localId` → `by: 'local'`), because a remote killer counts its own kill on its client. ⚠ Consumers must key on `by` (`by === 'local'` = mine; `undefined` = a legacy / synthetic emit): `src/meta/MetaSystem.ts` currently counts every `enemy:killed` toward the contract goal, so a peer-credited kill on the host is counted locally **and** relayed as `meta contractHit` — that handler needs the same `by` filter its `stratagem:called` handler already uses (meta's owner, not this folder). Also the `EnemyHost` (`pickTarget`, `fireGun`, `fireShell`, `chargeHit`, `onChargeStarted`) / `SpawnHost` (`countAlive`) / `RogueSpawnHost` (`spawnRogue`) / `AcidHost` / `ShellHost` / `ReplicaHost` services. Debug: `debugSpawn(type, {x,z}, chase?)`, `debugShell(sid)`, `shellCount`, `bossId`, `corpses`, `active`. **Phase 7**: `setAuthority` (`promote` / `demote`, from its own `net:hostChanged` handler), `throwGrenade` (`EnemyHost`) + `onGrenadeExploded` (`GrenadeHost`) + `grenadeVisual / grenadeHitRemote` (`ReplicaHost`), `applyDamage(…, kbDir, kbSpeed)` with the `suspended` → `ghost:damage` branch, `explode(…, skipFaction)`, `training` gate, `wavesSeen`, debug `grenadeCount / debugGrenade / grenadesThrown / grenadesExploded / lastGrenadeBlast / debugHint / isAuthority / isTrainingWorld`. **Phase 9**: the delta `snapCache` (reset on `reset()` and on promotion with `replicaMgr.lastSeq + PROMOTE_SEQ_GAP`; `flow rejoined / takeover` sets `forceFull` so the next `es` is a keyframe), `applyStatus(id, status, dps, duration, attacker?)` storing `Enemy.burnAttacker`, `applyStatusBits(…, from)` (a replica's status request is credited to the relay `from`), `normalizeAttacker` (folds our own peer id back to `'local'`, also used by `applyAreaDamage`), barrier checks on rogue hitscan / shell blasts / acid (`barrierBlocks`), and debug `debugSnapshot(force?) / debugApplySnapshot(msg) / debugSnapshotState`. **Phase 10**: `onEnemyKilled` no longer registers the corpse itself — a ground kill goes straight to the new `registerCorpse(e)` (same frame as before), a **mid-air** kill only sets `Enemy.corpsePending` and the update loop calls `registerCorpse` once `deathLanded` or `CORPSE_LAND_TIMEOUT`; `registerCorpse` runs the `CORPSE_LOOT_CHANCE` roll (`rollCorpseLootable`), writes `Enemy.lootable` and sends `ee corpse` with `dd` / `lt`. `enemy:killed` carries `deathDir` and `ee kill` carries `dd` (`deathDirIndex`, 0 = `'left'` omitted); `corpseSpawnedRemote(…, opts)` applies the host's `lt` / `dd` to the local body. |
| `Targets.ts` | `CombatTarget { id: PeerId \| 'local' \| 'ai'; position; velocity; isDead; downed; isDeadOrDowned; present; yaw; eyeHeight; enemy; suspended; getEyePosition/getForward/getChest/dist2D; bodyRadius/bodyHeight }` — a stable object per player, plus one per enemy (`Enemy.asTarget`, `id 'ai'`, `enemy` set, synced by the system). `TargetList.refresh(ctx)` rebuilds `all` / `alive` each frame from `ctx.player` plus `ctx.net.getRemotePlayers()` filtered to `connected && !(stale && !suspended) && !DROPPING` (Phase 7: a **suspended** member — socket down, slot kept — stays a target; its position / hp / downed / dead come from the host's ghost through the same ref, `CombatTarget.suspended` routes damage to `ghost:damage`); `downed` = `player.isDowned` / `r.isDowned \|\| flags & DOWNED`. `alive` = present && !dead && !downed (the only players the AI may target or damage); `all` also holds downed and dead bodies (separation, `minDist`, spawn-distance checks). Enemy proxies are **not** in the list — `EnemySystem.pickTarget` scans `active` instead. Queries: `nearestAlive`, `nearestAliveWithin`, `minDist`, `distToLocal`, `randomAlive`, `randomPresent`, `local`, `anyAlive`. |
| `Enemy.ts` | Entity implementing `EnemyRef` (`faction` getter, `isRogue`, `isCombatant`). Holds gameplay state (hp, state machine fields, timers, charge/leap/spit phases, cached obstacles), `target: CombatTarget \| null` + `targetTimer` + `distToTarget`, `lastDamager` (kill credit), `lastLocalHit` / `netBuf` (replica), Phase 4 memory (`roguePhase`, `guardPos`/`leash`/`escortOf`, `coverPos`, burst timers, `weaponId`; `shellTimer`/`dug`; `toxicPhase`/`swellTimer`; `chargeSeq`/`chargeEnd`/`chargeVictims`/`hitByCharge`; `corpseLife`) and the rig (`EnemyRig = BugRig \| RogueRig`) + `BugAnim`. `takeDamage(amount, hitPoint?, hitDir?, attacker = 'local')` classifies the hit (`head` / `rear` / `front`; behemoth `isFrontPlate(point)` → `front`), applies per-type multipliers, hit-flash/flinch, stagger (never for a swelling toxic), death; a popped-out rogue that gets hit ducks (`hitCrouchTimer`); on a replica it stops after the visuals and calls `host.requestHit`. `muzzle(out)` = rifle tip (rogues). `animate()` syncs the rig every frame (`fade` over the last 3 s of `corpseLife`; Phase 7 blends `anim.reload` / `anim.throwing` from `reloadTimer` / `throwTimer`). Phase 7 rogue memory: `magRounds`, `reloadTimer`, `grenadeCd` (staggered at reset), `noLosHold`, `throwTimer`, `grenadeTarget`, `popPos` / `hasPop`; `enterStagger` / `kill` drop a wind-up. `EnemyHost` interface lives here (`throwGrenade` appended). **Phase 10**: `kill(countKill, dir?)` carries the live `vy` into `deathVy` **before** clearing `airborne` (clamped to `CORPSE_FALL_MAX_SPEED`), picks `deathDir` from its own seeded stream (`rollDeathDir`, `worldSeed ^ id·0x85ebca6b`) unless the wire supplies one, and decides `deathLanded` on the spot (a normal ground kill lands in the same frame, so its corpse still registers immediately); `lootable` / `corpsePending` are the Phase 10 corpse fields and `animate` drives `BugAnim.deathFall` from `deathTimer / DEATH_FALL_TIME`. |
| `EnemyTypes.ts` | `ENEMY_STATS` table (with `faction`) plus ability tuning `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`, `ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`; `BugType` (rig type), `isRogueType`. |
| `RayTests.ts` | Allocation-free `raySphere`, `rayCapsule`, `rayStandingCapsule` shared by hit detection, rogue shots and shell interception. |
| `SpatialGrid.ts` | Allocation-free uniform XZ hash grid, rebuilt per frame, used for separation queries. |
| `Spawner.ts` | `AmbientSpawner` (threat 0..1 → cap `12 + 24·threat`, patrol every 12–25 s from nests 60–140 m around a random alive player — or a random present body via `randomPresent` when everyone is downed — initial population on `world:ready`; from threat 0.5 `maybeArtillery` digs one in 80–120 m out, ≤ `MAX_ARTILLERY` alive), spawn helpers `findSpawnCenter`, `isVisibleToAnyPlayer`, `spawnGroup`, compositions `ambientGroup` (toxics from threat 0.4) / `waveGroup` (toxics from wave 2, a behemoth from wave 3), and the `SpawnHost` interface (`targets`, `countAlive`). Phase 7: `resume()` restarts the trickle mid-mission after a host promotion with a normal-length gap. **Phase 11**: `AmbientSpawner.eco` (the 목표 행성's `PlanetEcosystem`) — `cap` is `ambientCap` (`× eco.pressure`), the artillery ceiling is `maxArtilleryOf` and a planet whose `eco.bugs` has no artillery digs none in; `ambientGroup(threat, eco)` / `waveGroup(index, count, eco)` keep the whole ladder (same rolls, same probabilities, same gates in `AMBIENT_GATE` / `WAVE_GATE`) and only draw each slot's silhouette from `eco.bugs` inside its power tier (`TIER_FILLER` / `MEDIUM` / `HEAVY` / `RUNNER`). `eco === null` → every helper returns the pre-Phase-11 answer verbatim. |
| `RogueGuards.ts` | `placeRogueGuards(host, seed)` on `world:ready` (authority): squads of 2–4 rogues 6–12 m around every tier-3/4 crate and 30 % of tier-2 crates (> 45 m from the player spawn), ≤ `MAX_GUARDS` (16) in total; one random tier-3/4 crate gets the `rogue_boss` + `ROGUE_BOSS_ESCORTS` escorts (leash to the boss). Seeded by the world seed; rifles from `ROGUE_AI.weapons` (boss `ROGUE_AI.bossWeapon`). `RogueSpawnHost.spawnRogue`. Guards are not waves and are never recycled by `ensureCapacity`. **Phase 11**: `placeRogueGuards(host, seed, eco)` — `guardCap` = `MAX_GUARDS × eco.rogues` (0 = a planet with no raiders, placed without touching the rng), the tier-2 share is `0.3 × eco.rogues`, and on an `eco.boss === false` planet the boss squad only appears when the seed rolls `ECO_BOSS_CHANCE`. Still fully seeded: same seed + same planet = same placement. |
| `WaveDirector.ts` | Extraction waves: first wave 3 s after activation, then every 14 s → 9 s; size 6, 8, 10 … (≤ 22), split into 1–3 groups spawned 45–90 m from the target, facing the nearest alive player; pauses while nobody is alive. A behemoth over the cap becomes a warrior (**Phase 11**: the cap is `maxBehemothOf(eco)` — 0 on a planet with none — and the count now includes behemoths rolled earlier in the same wave; `WaveDirector.eco` also feeds `waveGroup`). Emits `enemy:waveStarted`. Alive cap 60. Authority only. Phase 7: `prime(index)` — the next `start` (re-requested by extraction/ after a host promotion) continues the escalation from that wave index with a ≤ 6 s gap instead of restarting at wave 0. |
| `Corpses.ts` | `Corpse` (`Interactable` `corpse:<enemyId>`, `CORPSE_INTERACT_RADIUS`, `holdTime` 0.6, prompt `시체 수색` → `수색 완료`; `canInteract` = `ctx.isGameplayActive()` && player alive & not downed && `ctx.inventory.openContainerItems` exists; `interact()` rolls once via `ctx.loot.rollCorpse(type, new Random(seed ^ id·φ), weaponId)` and calls `ctx.inventory.openContainerItems(id, items, position, '시체')`; an empty roll counts as searched) and `CorpseManager` (`add` → `corpse:spawned`, `remove` → `corpse:removed`, `markLooted(containerId)` from `crate:looted`, own `CORPSE_LIFETIME` safety timer, `clear`). Contents are per-client like crates. **Phase 10**: `rollCorpseLootable(seed, enemyId, type)` decides whether a body can be searched at all from `CORPSE_LOOT_CHANCE` on an **independent** seeded stream (`worldSeed ^ (enemyId · 0x9e3779b1)`) — never on the `rng` that feeds `rollCorpse`, whose exact output `src/inventory/__selftest__.ts` pins for `warrior` / `rogue` / `rogue_boss` at seeds 5 / 11 / 3. `add(…, opts?: CorpseWireOpts)` takes the host's `lootable` / `deathDir` (`ee corpse.lt / .dd`) over the local roll, **returns null and registers no interactable** when the roll fails, and emits `corpse:spawned { lootable, deathDir }` either way (so a listener can tell "a body is here" from "loot is here"). |
| `ai/EnemyAI.ts` | State machine per bug: `idle` → `wander` → `alert` → `chase` → `attack` → `stagger`, plus `dead`/`flee`. Everything target-relative reads `e.target` (`acquireTarget` each tick). Rogues branch to `RogueAI.updateRogue` after perception; artillery / toxic / behemoth chase & attack dispatch to `GimmickAI`. Charger rush contact and hunter leap landing hit the nearest alive (not downed) player in range; melee / spit fire only while `!e.target.isDeadOrDowned`. `integrate()` (exported) handles steering, separation, obstacle avoidance (a charging body that deviates → `stumble` with the type's cooldown; behemoth shakes the camera), terrain snapping, gait, footsteps, yaw, slope. **Phase 10**: `integrateDeathFall(e, dt, world)` (exported, called from the `state === 'dead'` early-return here **and** from `net/Replica.update`) integrates `deathVy` under `GRAVITY` and snaps to `world.getHeightAt` → `deathLanded`, so a body killed mid-leap falls instead of freezing in the air. |
| `ai/RogueAI.ts` | Humanoid gunner: guards idle / patrol 6–12 m around `guardPos` (escorts 3–6 m around the boss, `guardPos` follows it), `alert` = `ROGUE_REACTION` delay with the rifle raised, then the **cover cycle** in `chase` via `roguePhase`: 0 pick cover (`ai/RogueCover.ts`, Phase 7: LOS-validated + flank scored, also yields the **pop-out spot** `popPos`) → 1 move there (snap shots while relocating) → 2 crouch-hold 2–4 s (hint 6; boss ×0.6; target < 6 m pops out early; a running reload extends the hold) → 3 **step out to `popPos`** (≤ 2.5 s, no LOS penalty while stepping), stand and fire `ROGUE_BURST` rounds 0.12 s apart (hint 5) with aim error `ROGUE_AIM_ERROR` → `ROGUE_AIM_ERROR_SETTLED` over 1.2 s standing; no LOS for 1.2 s → new cover; after the burst `ROGUE_RUSH_CHANCE` → 4 **rush** to ~8 m firing from the hip every 0.28 s (hint 7, error ×1.6, ≤ 6 s) else back to 0. Leash: never farther than `leash` (45 m; escorts 18 m) from `guardPos` unless rushing or the target is visible within 30 m. Every shot goes through `shoot()` → `host.fireGun` and spends one of `ROGUE_MAG_ROUNDS` (`Enemy.magRounds`); an empty magazine starts a `ROGUE_RELOAD_TIME` **reload** in any phase (`reloadTimer`: crouched, rifle down, no shots, `reload` audio at the rogue, hint 12; a burst caught mid-reload ducks back to phase 2; `popOut` never loads more rounds than the mag holds). **Grenade** (`maybeStartThrow`, not while rushing): target hidden (`noLosHold` ≥ `ROGUE_GRENADE_HOLD_S`), `ROGUE_GRENADE_RADIUS + 1.5` < distance ≤ `ROGUE_GRENADE_RANGE`, `grenadeCd` ≤ 0, no reload → walk to `popPos` (≤ 2 s) then `ROGUE_GRENADE_WINDUP` throw pose (hint 13, sphere in the off hand) → `host.throwGrenade(e, grenadeTarget)`; success arms `ROGUE_GRENADE_COOLDOWN` (boss ×0.7, ±10 %), a refused launch (rock in the face) retries in 2 s; then back to phase 0. The boss and its escorts throw too. Stagger drops a wind-up (cooldown unspent). |
| `ai/RogueCover.ts` | Phase 7 cover selection. Candidates keep the Phase 4 filters (obstacle radius ≥ 0.5 / height ≥ 0.8 within `COVER_SEARCH_RADIUS` 16 m, not behind the rogue, inside the map, 4 m … 90 % of the rifle range from the target, inside the leash); a candidate's point is the obstacle's far side (`radius + 0.7`). Score = `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − \|sin θ\|)` (`flankCost`: θ between `target.getForward()` and target → candidate, so flanks are free and the target's front / back cost the full weight) + 6 when it is the rock we stand at / just left + `max(0, toTarget − 35) × 0.5`. Cheap terms first, then two raycasts only for candidates that beat the best so far: `coverBlocksLine` from a **crouched** eye (0.9 m) at the point to the target's chest must be blocked, and `findPopSpot` must find a flank of the obstacle (perpendicular to the target line, `radius + 0.9` out, pulled 35 % back) from which a **standing** eye (1.45 m) sees the chest — cover you cannot fight from is skipped (otherwise rogues hide forever). Writes `coverPos / hasCover / popPos / hasPop`. |
| `ai/GimmickAI.ts` | `chaseArtillery` (retreat when < 60 m, approach when > 125 m, otherwise dig in over 1.2 s — `dug`, hint 8 — and `host.fireShell` every 6–9 s at ≤ 140 m; never melees), `chaseToxic` / `attackToxic` (weaving runner; within `TOXIC_TRIGGER_DIST` of its target or any alive player → swell 0.6 s, hint 9, then `kill(false)` → burst), `chaseBehemoth` / `attackBehemoth` (approach to 18 m; wind-up `BEHEMOTH_WINDUP` with roar, hint 10; then a straight line at `BEHEMOTH_CHARGE_SPEED` toward the target's position at wind-up end + 6 m, hint 11; players within radius + 0.85 m → `host.chargeHit` once per charge with a sideways knock direction; enemies of either faction in the path → 160 damage `'ai'` + shove + stagger; end / 3.2 s / obstacle → stumble, cooldown 4 s; melee like a warrior in between). |
| `ai/Common.ts` | `lookAtTarget`, `startMelee`, `stumble(e, cooldown, duration)`, `AttackResult` shared by the three AI modules. |
| `ai/Steering.ts` | `seek`, `separate` (mass-weighted positional correction via the grid + push-out from every alive `CombatTarget`), `avoidObstacles`, `turnToward`, `yawTo`. |
| `ai/Perception.ts` | `acquireTarget`: `host.pickTarget(e)` (players and hostile enemies), re-evaluated every 0.5–0.9 s or when the target dies / goes down / leaves; hysteresis (switch only when another is < 0.6× / 0.75× as far, with/without LOS). Staggered 0.3 s perception tick: sight `sightRadius` (bugs 40, rogues 60, artillery 130) with LOS to the target's chest, target loss after 10 s unseen & > 60 m — skipped for `relentless`, artillery, and rogues with a target inside 80 m. `becomeAlert` emits `enemy:alerted`, screech audio (rogues stay silent), propagates 20 m within the same faction. |
| `net/HostSync.ts` | Host encoding: `encodeSnapshot(active, time, cache, force?)` → `EnemySnapshot { seq, full, e: EnemyWire[], gone? }` with p 2 dp / yaw 3 dp / hp 1 dp, `a` hint (1 charger windup, 2 rush, 3 spewer windup, 4 hunter airborne, **5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery dug in, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush**, Phase 7: **12 rogue reloading, 13 rogue throwing** — both outrank the cover phases, 전소 / stagger outrank them) and `w` (rogue rifle id), `sb` status bits (`statusBits`, Phase 6). Corpses leave the snapshot 1.5 s after death (replicas keep them from their own corpse timer). **Phase 9 — `es` is a delta stream**: `SnapshotCache` remembers the rounded fields last sent per id (plus `seenSeq`), holds the monotonic `seq` and the `forceFull` flag, and `reset(seqBase?)` clears it + forces the next keyframe (a promoted host passes the last seq it saw as a replica so its counter cannot be confused with the old host's). A **keyframe** — `force`, `cache.forceFull`, or every `KEYFRAME_EVERY` = `NET_ENEMY_KEYFRAME_S × NET_ENEMY_SNAPSHOT_HZ` snapshots — carries every field of every eligible enemy with `full: true` (`a` / `sb` omitted when 0, which a keyframe reads as 0). A **delta** carries only enemies whose rounded fields changed, and only those fields; an id the cache does not hold gets the full set (`ty` / `w` included) so a replica can build it, and `a` / `sb` falling back to 0 are written explicitly because an omitted delta field means "unchanged". `gone` lists ids the cache held that are no longer eligible. A keyframe is ~90 B per enemy as JSON; a delta over an idle swarm is a few bytes per moving enemy. |
| `net/Replica.ts` | Client replica: `ReplicaBuffer` (8-sample ring per enemy) with lerp / shortest-arc yaw / ≤ 0.25 s extrapolation; `EnemyReplica.onSnapshot` (get-or-create by host id; ids missing from a `full` snapshot → release, **except dead bodies**), `onEvent` (`spawn`, `kill` + kill credit when `killer === localId`, `despawn`, `damaged`, `attack`, `acid`, `wave`; Phase 4: `shoot` → tracer/flash/audio + `enemy:shot`, `shell` → visual shell, `intercept` → pop, `shellHit` → landing FX (skipped when the local copy already landed), `charge` → `enemy:chargeStarted`, `toxic` → green burst FX + `enemy:toxicBurst`, `corpse` / `corpseGone` → `CorpseManager`; Phase 7: `grenade` → `ReplicaHost.grenadeVisual` (visual copy flown from the wire position / velocity / fuse), `grenadeHit` → `grenadeHitRemote` (pops the local copy in place, or just the FX)), `update` renders at `ctx.time − NET_INTERP_DELAY`, clamps y to terrain unless airborne, drives `BugAnim` (gait from displacement; shake/abdomen/crouch/aim/mandible from state + hint — hint 12 crouch + reload pose, 13 throw pose via the held `reloadTimer` / `throwTimer`; head tracking; slope) and mirrors `sb` into the status timers (`applyStatusBits`, Phase 6). Phase 7 host migration: `adopt(e, now)` seeds a demoted enemy's ring buffer with its current pose so it keeps rendering until the new host's first snapshot; `latestOf(e)` hands the promotion the newest wire sample. **Phase 9 delta intake**: `seq` comes from `msg.seq` (the host's counter, `lastSeq` feeds a promotion); `ReplicaBuffer.applyWire(now, w, keyframe)` lays a partial wire over the newest sample as a new sample (absent fields keep their value; in a keyframe an absent `a` / `sb` is 0) while `push` stays the seeding path for `ee spawn` / `adopt`; an enemy absent from a **delta** gets `hold(now)` (the newest sample repeated) so the interpolator sees it standing still instead of extrapolating past the stop; an unknown id **without** `ty` / `p` is ignored and counted in `ignoredUnknown` (`ee spawn` or the next keyframe brings it); the sweep that releases unseen replicas runs on **keyframes only**; `gone` releases at once except bodies whose newest sample is `dead` (the corpse timer owns those). **Phase 10**: a dead body runs `integrateDeathFall` here (the host drops corpses from `es` after 1.5 s, so the client must fall on its own), `ee kill.dd` / `ee corpse.dd` are handed to `Enemy.kill(false, dir)` / `corpseSpawnedRemote` so the host's fall direction and lootable roll win. |
| `fx/RogueGrenade.ts` | Phase 7: 8 pooled rogue grenades (small dark spheres, ember emissive, `NO_RAYCAST`). `throw(owner, from, vel, fuse, authority)`; `launchVelocity(from, target, flight, out)` (ballistic solve, `GRAVITY`); `update` integrates gravity, spins, tests obstacles / terrain along each step (`world.raycast`, height field) — **one bounce** (normal × 0.3, tangent × 0.3) then a damped roll (× 0.5 per contact) to rest below 0.8 m/s, out-of-bounds rests too; fuse → `explode` → blast FX (fireball / sparks / ground blast / smoke / flash, no lights) + `GrenadeHost.onGrenadeExploded(p, authority, owner)`. `explodeNear(p)` (replica `grenadeHit`) pops the nearest still-flying local copy within 4 m or plays the FX alone; `setAuthorityAll` flips in-flight grenades on host migration; `findByOwner` / `count` for debugging. |
| `models/BugParams.ts` | Per-type visual parameters for the six-legged rig (`BugType`), incl. Phase 4 `mortar` (artillery tube), `frontPlate` (behemoth), `sacSwell` (toxic); `behemoth` = warrior params scaled ×`BEHEMOTH_SCALE`. |
| `models/BugModel.ts` | Shared per-type geometry/material assets, `createBugRig` (`kind: 'bug'`, `baseScale`, optional `mortar` group), `animateBug` (tripod gait, bob/lean/slope, head tracking, mandibles, hit flash, flinch, sac pulse/swell, wind-up shake, leap crouch, mortar recoil, death roll — the body **stays on the ground** and only sinks during `fade`). `BugAnim` adds `fade`, `aim`, `recoil`. **Phase 10**: the canned death roll became **three real directions** — `BugAnim.deathDir` (0 left / 1 right / 2 back, replacing the unseeded `rollSign`) and `deathFall` (blend over `DEATH_FALL_TIME` with one small settle bounce); left / right roll the thorax over and shift it sideways, back rears the bug over onto its abdomen with almost no roll. `curl` (leg fold) and `sink` are unchanged. |
| `models/RogueModel.ts` | Procedural humanoid rig (`kind: 'rogue'`): pelvis/torso/head with emissive visor, arms + rifle block (`gun` group, `muzzle` marker), two legs, and (Phase 7) a small `grenade` sphere at the off hand (shared ember material, hidden unless throwing); boss = same geometry scaled by `ROGUE_BOSS_SCALE` (`baseScale`) with a pauldron and red visor. `animateRogue` from the shared `BugAnim`: walk cycle, cover crouch, low-ready ↔ aimed rifle (`aim`), recoil kick, look/aim from `headYaw/headPitch`, flinch, hit flash, fall + fade; Phase 7 `reload` (rifle tipped down and rolled in, hands jitter at the magazine) and `throwing` (rifle dropped to the hip, grenade rises above / behind the shoulder) blends, both driven by `Enemy.animate` from `reloadTimer` / `throwTimer`. **Phase 10**: the fall is three directions from `BugAnim.deathDir` blended over `DEATH_FALL_TIME` — before, `rollSign > 0` fell backward and `< 0` fell right, and **left did not exist**. |
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
Every death (authority) emits `corpse:spawned` at the body's **resting** position and registers `corpse:<id>` there when the
body's `CORPSE_LOOT_CHANCE` roll succeeded (Phase 10 — a trash bug is searchable only 10 % of the time; behemoth / rogue /
boss always). A kill in the air is registered once the body lands (`CORPSE_LAND_TIMEOUT` fallback). Hosts send
`ee corpse {id, ty, p, w, dd?, lt?}` so replicas register the same interactable (`lt: 0` = un-searchable, `dd` = fall
direction); `ee corpseGone` / `corpse:removed` when the body despawns (after `CORPSE_LIFETIME` 45 s, or when recycled by
`ensureCapacity`, `CORPSE_SLACK` 30). Bodies stay visible for the whole lifetime — searchable or not — and sink/fade during
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

## Shared contract consumed (Phase 7)
- `constants.ts`: `ROGUE_MAG_ROUNDS`, `ROGUE_RELOAD_TIME`, `ROGUE_COVER_FLANK_WEIGHT`, `ROGUE_GRENADE_HOLD_S / COOLDOWN / FUSE / DAMAGE / RADIUS / RANGE / WINDUP`, `BEHEMOTH_SCALE` 3.
- `net.ts`: `EnemyWire.a` 12 / 13, `EnemyEvent 'grenade' / 'grenadeHit'`, `DamageMessage.kb`, `RemotePlayerRef.suspended`, `PeerId`.
- `events.ts` (emitted): `ghost:damage`; (consumed): `net:hostChanged`. `types.ts`: `EnemyManagerRef.setAuthority` (implemented), `WorldRef.mode`, `EnemyFaction`.
- `GameContext.ts`: `ctx.isTraining()`, `ctx.missionMode`.
- Audio ids reused: `reload` (rogue reload), `grenade_throw`, `explosion`.

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

## Rogue AI v2 · behemoth knockback · ghost targets · live authority · training (Phase 7, 2026-09-06)
Brief: `docs/PHASE7-PLAN.md` §6. Everything below is inside `src/enemies/`; the contract (`ROGUE_MAG_ROUNDS / ROGUE_RELOAD_TIME /
ROGUE_COVER_FLANK_WEIGHT / ROGUE_GRENADE_*`, `BEHEMOTH_SCALE` 3, `EnemyWire.a` 12 / 13, `ee grenade / grenadeHit`, `DamageMessage.kb`,
`ghost:damage`, `net:hostChanged`, `RemotePlayerRef.suspended`, `EnemyManagerRef.setAuthority`, `WorldRef.mode`, `ctx.isTraining`) was pre-written.

- **Cover that hides and a spot to fight from.** `ai/RogueCover.ts` validates every candidate with a crouched-eye raycast (the rock must
  block the line to the target's chest) and scores it by distance + the flank term, and also finds the obstacle flank a standing rogue
  can shoot from (`popPos`). Phase 3 now *steps out* to that spot before the burst and phase 0 walks back — the old "pop out in place"
  would never have seen the target once cover really blocks LOS (found by the smoke: 0 shots in 90 s).
- **Magazine.** `Enemy.magRounds` starts full, `shoot()` spends one per `fireGun`; 0 → `reloadTimer = ROGUE_RELOAD_TIME`, `reload`
  audio, crouch + `BugAnim.reload` pose, hint 12, no shots in any phase, mag refilled when it ends. The boss's 6-round burst gets two
  bursts per mag. The smoke measured exactly 12 shots → reload ≈ 2.0 s → 12 again.
- **Grenade.** `noLosHold` counts hidden-target time while hunting; `maybeStartThrow` needs `ROGUE_GRENADE_HOLD_S`, range
  `(RADIUS + 1.5, ROGUE_GRENADE_RANGE]`, cooldown 0, no reload. Wind-up = walk to `popPos` (≤ 2 s) then `ROGUE_GRENADE_WINDUP` of the
  throw pose (hint 13, sphere in the off hand) → `EnemySystem.throwGrenade`: launch from the off hand (0.78 × height, 0.8 × radius ahead),
  ±1 m scatter on the target's feet, flight `clamp(dist / 11, 0.8, 1.8)` s solved with `RogueGrenades.launchVelocity`, refused when a
  2.5 m raycast along the launch direction hits (the rock the rogue is hugging — the AI retries after 2 s from elsewhere), `grenade_throw`
  audio, `ee grenade {id, p, v, fuse}`. `RogueGrenades` flies it with one bounce and `ROGUE_GRENADE_FUSE`; `onGrenadeExploded` on the
  authority deals `ROGUE_GRENADE_DAMAGE × clamp(1 − max(0, d − PLAYER_RADIUS) / ROGUE_GRENADE_RADIUS, 0.1, 1)` (d = blast → player
  centre) to every alive player through `applyDamage` (local direct + `enemy:attacked {id: thrower}` + shake + `applyKnockback`, remote
  `dmg {kb}`, suspended `ghost:damage {kb}`; knockback 7 m/s × falloff, lifted 0.35), `explode(…, 'ai', skipFaction 'rogue')` to bugs
  only, `alertHearing` 60 m, `ee grenadeHit {p}`. Every client plays the blast FX / `explosion` audio / shake ≤ 30 m. Replicas fly a
  visual copy from `ee grenade` (`authority` false → no damage) and `grenadeHit` pops the copy in place so the explosion shows once.
  Per-rogue cooldown `ROGUE_GRENADE_COOLDOWN` (boss ×0.7), initial value staggered 25–75 % so a squad never volleys at once.
- **Behemoth.** `BEHEMOTH_SCALE` 3 flows through `ENEMY_STATS` (radius 2.4, height 4.8, head 1.08, attack range 6.6) and
  `BugParams.scaled` (all rig lengths); nothing hard-codes the old 6.4 m. `chargeHit` routes the knock direction through `applyDamage`,
  so a remote victim's `dmg` carries `kb: { d, s: BEHEMOTH_KNOCKBACK }` (net applies `applyKnockback`) and a suspended one gets it in
  `ghost:damage.kb` — the old "remote victims get no knockback" gap is closed.
- **Ghost targets.** `TargetList` keeps `suspended` refs (`!connected || (stale && !suspended) || DROPPING` filter) with
  `CombatTarget.suspended`; `applyDamage` emits `ghost:damage {id, amount, from, kb?}` for them instead of sending `dmg` (the host's
  `RemotePlayerSystem` owns the ghost's hp / bleed / death). `ee attack` announcements still go out so the squad hears the bite.
- **Live authority.** `setAuthority(authority)` is called from the system's own `net:hostChanged` handler with `isLocalHost` (and is
  exposed on `ctx.enemies` for tests / the console). Promotion (`promote`): every live replica is seeded from its newest wire sample
  (`hp`, `aware` = wire state not idle / wander → `chase` else `idle`, target / perception reset so `acquireTarget` runs next tick,
  `guardPos` = current position, escorts freed, full magazine, no wind-up), status holds become real durations (전소 ≥ 1.5 s via
  `incinerate`, burning ≥ 1 s at `FLAME_AFTERBURN_DPS`, slow ≥ 1 s), `lastDamager = 'ai'` (no kill credit for damage the old host
  dealt), corpses stay as registered from `ee corpse` (the new host now sends their `corpseGone`), `nextId = max(id) + 100` and
  `nextShellId += 1000` so late messages from the old host cannot collide, `spawner.resume()` (a normal-length gap, threat unchanged —
  game/ keeps setting it), `waves.prime(wavesSeen)` (the `ee wave` count seen as a replica; extraction/ re-requests
  `startExtractionWaves` and the director continues from that index), snapshots (`es` / `ee`) start on the next frame because
  `hosting` reads the live flag. Demotion (`demote`): waves stop, lures drop, in-flight grenades become visual, every live enemy is
  `adopt`ed into a replica buffer at its current pose and keeps rendering until the new host's first full `es` (ids missing there
  despawn as usual). Outside a ready world only the flag changes; `refreshMode` at `world:ready` / `game:newMission` / `game:abort`
  still seeds it per mission.
- **Training.** `world:ready` sets `training` when `ctx.isTraining()`, `ctx.missionMode === 'training'` or `ctx.world.mode ===
  'training'`: no initial population, no guards, the spawner / wave director never tick and `startExtractionWaves` is ignored.
  `debugSpawn` (console / smoke) still works there on purpose.
- Debug: `grenadeCount`, `debugGrenade(id)`, `grenadesThrown / grenadesExploded`, `lastGrenadeBlast`, `debugHint(id)` (the wire `a`
  hint), `isAuthority`, `isTrainingWorld`.

## Delta snapshots · burn credit · enemy fire vs 배리어 (Phase 9, 2026-09-06)
Brief: `docs/PHASE9-PLAN.md` §6. Contract: `EnemyWire` pose fields optional, `EnemySnapshot.seq / gone?`,
`NET_ENEMY_KEYFRAME_S`, `EnemyManagerRef.applyStatus(..., attacker?)`, `enemy:killed.by?`.

- **`es` is a delta stream.** `SnapshotCache` (in `net/HostSync.ts`) keeps the rounded fields the host last sent per id;
  every `NET_ENEMY_KEYFRAME_S` (and on `flow rejoined` / `flow takeover`, and right after `reset()` / a promotion) the
  next snapshot is a **keyframe** with every field of every eligible enemy, otherwise only the changed enemies and their
  changed fields go out, plus `gone` for ids that dropped out. Replicas apply partial wires over the newest sample
  (`applyWire`), `hold` the ones a delta omitted, ignore a delta for an id they never saw (no `ty` → `ignoredUnknown`,
  the next keyframe or an `ee spawn` fixes it) and sweep unseen replicas **only on keyframes**. A promoted host starts
  its own counter at `replicaMgr.lastSeq + PROMOTE_SEQ_GAP` (1000) so the two hosts' `seq` streams can never overlap.
- **Burn kills credit whoever lit the fire.** `applyStatus(id, status, dps, duration, attacker?)` writes
  `Enemy.burnAttacker` for `burning` / `incinerated` (host side only, cleared with the burn and on reset / respawn); the
  DoT tick in `updateStatuses` uses `burnAttacker ?? lastDamager`, and when that kill belongs to a remote peer the host
  also sends it a `hitc {killed:true}` so the hitmarker lands there. Callers pass `ctx.net?.localId ?? 'local'` and
  `normalizeAttacker` folds our own id back to `'local'`; a replica's status request is credited to the relay `from`.
  The old "burn kills go to the last damager" gap is closed for fire zones (gadgets/) and the 화염방사기 (weapons/).
- **Enemy fire respects a 배리어.** Rogue hitscan (`fireGun`), artillery blasts and spewer acid now query
  `ctx.implants.raycastBarrier(..., true)` — a **pure** query since Phase 9 — before dealing damage; when the line is
  blocked the round stops, no damage is applied and the barrier takes the hit through `ctx.implants.damageBarrier`
  (one raycast per hit, never per tick; `barrierBlocks` is the shared helper).

## 공중 사망 낙하 · 사망 방향 · 확률 루팅 (Phase 10, 2026-09-07)
Brief: `docs/PHASE10-PLAN.md` §3-3. Contract (read-only): `EnemyDeathDir` / `ENEMY_DEATH_DIRS` / `CORPSE_LOOT_CHANCE`,
`EnemyRef.deathDir? / lootable?`, `DEATH_FALL_TIME` / `CORPSE_FALL_MAX_SPEED` / `CORPSE_LAND_TIMEOUT`,
`ee kill.dd?` + `ee corpse.dd? / lt?`, `enemy:killed.deathDir?`, `corpse:spawned.lootable? / deathDir?`.

- **A body that dies in the air falls.** The bug was a three-way interaction: `kill()` cleared `airborne` / `leaping`
  (so the leap integration stopped), `ai/EnemyAI` early-returns for `state === 'dead'` (so `integrate()`'s ground snap
  was never reached) and `onEnemyKilled` registered the corpse **at the mid-air position** — and `GameContext.findBest`
  measures a 3-D distance, so that corpse was unlootable as well as floating. Now `kill()` carries the live `vy` into
  `Enemy.deathVy` (clamped to `CORPSE_FALL_MAX_SPEED`) *before* clearing `airborne`, and the new
  `integrateDeathFall(e, dt, world)` runs in **both** drivers — `ai/EnemyAI`'s dead branch and `net/Replica.update`,
  because a replica never calls `drive()` on a dead body and the host drops corpses from `es` 1.5 s after death, so the
  client has to run the same (deterministic) fall itself. The corpse interactable is **deferred**: `kill()` decides
  `deathLanded` immediately, so a normal ground kill still registers in the same frame, while a mid-air kill sets
  `corpsePending` and `EnemySystem.update` registers it at the landing spot (or after `CORPSE_LAND_TIMEOUT`).
- **Three fall directions.** `Enemy.deathDir` is picked at death from an **independent** seeded stream
  (`worldSeed ^ (id · 0x85ebca6b)`) and replicated as `ee kill.dd` / `ee corpse.dd` (the receiver prefers the wire).
  The old `BugAnim.rollSign` is gone — it was rolled at *spawn* with unseeded `Math.random()` and never re-rolled at
  death, so host and replica already disagreed. `BugAnim.deathDir` (index) + `deathFall` (blend over `DEATH_FALL_TIME`,
  driven by `Enemy.animate`) replace it, following the `incinerated` writhe pattern; `animateBug` and `animateRogue`
  each grew a real 좌 / 우 / 뒤 branch (the rogue had no left at all).
- **Probabilistic corpse looting.** `CORPSE_LOOT_CHANCE` (trash bug 0.1 · 상위 버그 0.35 · behemoth / rogue / boss 1)
  is rolled in `Corpses.rollCorpseLootable` on its **own** seeded stream (`worldSeed ^ (id · 0x9e3779b1)`) — deliberately
  **not** drawn from the `rng` that later feeds `rollCorpse`, because `src/inventory/__selftest__.ts:131-142` asserts the
  exact `rollCorpse` output for `warrior` / `rogue` / `rogue_boss` at seeds 5 / 11 / 3. A body that fails the roll gets
  **no interactable** (the corpse mesh stays, so the world still reads right) and `corpse:spawned` reports
  `lootable: false`. `rollCorpse` and `CORPSE_TABLES` (items/) are untouched.

## 행성 생태계 (Phase 11, 2026-09-07)
Brief: `docs/PHASE11-PLAN.md` §3-5(B). Contract (read-only): `src/shared/planets.ts` (`PlanetEcosystem.bugs` /
`pressure` / `rogues` / `boss` / `maxArtillery` / `maxBehemoth`), `world:ready.planet?`, `WorldRef.planet`.

- **Where it enters.** `EnemySystem`'s `world:ready` handler resolves `getPlanet(planet ?? ctx.world.planet ??
  ctx.missionPlanet)?.eco` into `this.eco` and pushes it into `spawner.eco` / `waves.eco` / `placeRogueGuards`. A
  training and a mission without a planet keep it null, which means **every number is exactly what it was** — this is
  a re-weighting of existing content, not new content.
- **Host only.** The ecosystem changes what the authority *composes*; `es` / `ee`, the replica path and every wire
  type are untouched, so a joined client needs to know nothing about the planet.
- **Composition = same ladder, planet-drawn silhouettes.** The rolls, their probabilities and their gates are
  transcribed unchanged into `AMBIENT_GATE` / `WAVE_GATE`; each slot then draws from `eco.bugs` inside its power tier
  (filler `scavenger` · medium `hunter / warrior / spewer` · heavy `behemoth / charger` · runner `toxic`). A weighted
  type still cannot appear before its gate opens, a type the planet does not list can never appear at all, and a slot
  whose whole tier is missing here is skipped — in a wave the leftover count falls through to the filler, so waves
  keep their size. Artillery is never part of a group (it digs in through `maybeArtillery`) and the ambient gate for
  the behemoth is closed, exactly as before.
- **Ceilings.** `ambientCap(threat, eco)` = `(12 + 24 × threat) × eco.pressure`; `maxArtilleryOf` / `maxBehemothOf`
  replace the module constants (which stay as the no-planet defaults).
- **Guards.** Density scales `MAX_GUARDS` and the tier-2 share; `eco.rogues === 0` places nothing (아무 행성도 아직
  0 은 아니다); `eco.boss === false` (보레아스 IX, 베르단트 III) turns the boss squad into a `ECO_BOSS_CHANCE` seed roll.
- **Determinism.** Guard placement is drawn from the world-seeded `Random` as before, so **same seed + same planet =
  same placement**; the ecology only changes how many draws are taken. Group **composition** is still unseeded
  `Math.random()` — deliberately left as it was (it never was reproducible, and making it seeded would change every
  existing smoke's expectations).
- Debug hooks for the smoke: `debugEcology`, `debugAmbientCap`, `debugAmbientGroup(threat)`,
  `debugWaveGroup(index, count)`, `debugGuardCount()`.

### Known follow-ups (Phase 11)
- A planet that lists a type but caps it at 0 (`tundra` / `mossy` carry `maxArtillery` 1 with no artillery weight,
  `maxBehemoth` 1 with no behemoth weight) gets **none** — `eco.bugs` wins, per the contract's "a type absent from
  the map never spawns". The two numbers can therefore disagree without an error.
- The heavy tier draws behemoth vs charger **by weight**, so 피로스 VII's wave-3 behemoth slot is a charger most of
  the time (charger 3 : behemoth 1) and its charger slot can be a behemoth in return — the cap (`maxBehemoth` 2)
  bounds the outcome, but the exact behemoth cadence is now planetary, not fixed.
- A behemoth over the cap still becomes a **warrior** without consulting the weights (every current planet lists
  warriors, so it never produces a forbidden type — a future planet without warriors would).
- `eco.rogues` scales the guard **cap** and the tier-2 crate share, not the squad size (still `rng.int(2, 4)`), so a
  dense planet mostly means *more squads*, not bigger ones.
- The ecosystem is read once at `world:ready`: a host promoted mid-mission re-reads it from `ctx.world.planet`, but a
  client that never generated the world (impossible today) would have none.
- Ambient / wave composition remains unseeded, so two hosts on the same seed compose different patrols — as before.

## Known gaps / follow-ups
- Phase 10: a **replica** has no real `vy` (it only mirrors the `airborne` hint), so a body that dies mid-leap starts
  its fall from rest on the client and lands a fraction of a second later than on the host — the resting spot is the
  same. A body killed in the air while the gameplay phase is paused does not fall until it resumes (the AI / replica
  drivers are gated on `isGameplayPhase()`), and `CORPSE_LAND_TIMEOUT` then registers the corpse mid-air. A **promoted**
  host inherits no `corpsePending` (the old host never sent `ee corpse` for a body still falling), so such a corpse is
  simply never registered. The lootable roll and the fall direction are per-enemy-id and per-world-seed, so re-entering
  the same seed gives the same answers — deliberate (it is how corpse *contents* already work). A non-lootable corpse
  sends `ee corpse` with `lt: 0` but never a matching `ee corpseGone` (nothing was registered).
- Phase 7: a promoted host does not know the old host's rogue guard anchors / escort links (they re-anchor where they stand) nor its
  lures / suspicion points; the wave index resumes from the `ee wave` count this client saw (a client that joined mid-extraction
  undercounts); the promotion happens on the *next* `es` from us — clients keep extrapolating for up to `NET_HOST_MIGRATE_DELAY_MS`
  meanwhile. `ghost:damage` is one-way (the ghost's revive / death state comes back through the ref, not to enemies/). Replica
  grenade copies match the host's `grenadeHit` by proximity (≤ 4 m), not by id (`ee grenadeHit` carries only `p`). A rogue whose
  every reachable rock has no valid pop-out flank simply crouches in the open; rogues still ignore friendly fire for their grenades
  (bugs are hit, rogues never are). Rogue cover still ignores terrain ridges (obstacle cylinders only).
- Phase 6: the replica's optimistic 전소 lasts the caller's full duration even if the host rejects it (only a `dead` snapshot or the
  missing `sb` bit — clamped to 0.35 s — ends it); status requests are not validated against distance / weapon. `applyStatus`'s Phase 9 `attacker`
  is stored for `burning` / `incinerated` only — a slow / shock that finishes an enemy is still credited to the last damager. Snapshot `sb` adds ~8 B per
  affected enemy.
- `EnemyEvent 'damaged'` carries no damager id; replicas suppress the echoed flash with a 0.4 s window after their own hit.
- `DamageMessage` has no shake field: remote victims of a charger / behemoth get the damage (and, since Phase 7, the behemoth's
  knockback through `dmg.kb`) but no camera shake beyond what net/ adds; charger charges still send no `kb`. Rogue shots at remote
  players send `dmg` without `ee attack`, so other clients see the tracer (`ee shoot`) but no bite audio.
- Acid hits on remote players send only `dmg` (with `slow`), no `ee attack`.
- Phase 9 deltas: a lost delta is only repaired by the next keyframe (`NET_ENEMY_KEYFRAME_S`) — the relay is TCP, so this
  costs latency, not correctness. `gone` is sent on keyframes too (harmless duplication with the sweep). The cache
  compares rounded values only, so sub-precision drift is never re-sent; `a` / `sb` changing back to 0 costs an explicit
  field. Corpses are still dropped from the snapshot after 1.5 s, so a client that joins mid-mission (`rejoinMission`)
  sees no existing bodies / corpse interactables. A burn started by a peer that leaves keeps crediting that id (the
  `hitc` simply goes nowhere).
- Replica shells are simulated locally from `ee shell`; the host's `shellHit` is only used when the local copy is still flying, so a shell
  may land a few cm apart on different clients. The host validates `intq` only by shell id (no distance check).
- Rogues never use the melee path — a bug in their face gets shot point-blank. Rogues ignore friendly fire (a same-faction rogue in
  the line just stops the tracer). Behemoth hitbox for the plate is a round capsule, thicker than the visual plate. Toxic corpses use
  the generic `rollCorpse('toxic')` (items decides what a toxic drops).
- The behemoth is `BEHEMOTH_SCALE` (3 since Phase 7, was 4)× a warrior = 4.8 m tall / 2.4 m radius; the smaller body passes between
  most rock pairs now, but a charge still stumbles on any obstacle it clips (`resolveCollision` deviation > 5 cm).
- Guard placement is host-seeded but the individual rogue ids depend on spawn order after the ambient population; clients only ever
  receive ids from the wire, so this is cosmetic.

## Verification (Phase 11, 2026-09-07)
`npm run typecheck` 0 errors in `src/enemies` / `src/world`. New `scripts/smoke-ecology.mjs` (single-player, private
`npx vite --port 5297`, sim-time waits, HMR + relay sockets parked) — **83/83**, 0 console errors. Enemy side: the
no-planet baseline keeps the old type set (no behemoth in an ambient patrol, behemoth from wave 3, no toxic before
wave 2), the cap is `12 + 24 × threat` and 16 guards + a boss are placed; each of the five planets composes 24
patrols at threat 0.3 / 0.5 / 0.9 and 24 waves per index 0..7 with **no type outside `eco.bugs`**, **no gate broken**,
no artillery in a group, behemoths only where `eco.bugs.behemoth` and `maxBehemoth` allow (피로스 VII 10, everywhere
else 0), the cap scaled by `pressure` (20 / 24 / 28 / 29 / 22 at threat 0.5) and guard counts following `eco.rogues`
(카민 I 26 > 베르단트 III 10, 보레아스 IX / 베르단트 III bossless on this seed); the same seed + planet reproduces the
guard placement exactly. Regressions on the same build: `smoke-rogue-v2` **52/52**, `smoke-enemy-delta` **52/52**,
`smoke-phase4` **49/49**, `smoke-tactical` 63/64 (the miss is the relay socket, not the kit), `smoke-training`
101/109 — those 8 failures are the **hub lane's new launch-pod 목표 행성 gate** (the smoke boards `hub_pod_0` with no
planet selected), not this lane's.

## Fix (2026-09-05): initial population survived only by accident
`WorldSystem` (registered earlier) generates synchronously inside its own `game:newMission` handler and emits `world:ready` **before** `EnemySystem`'s `game:newMission` handler runs, so the old `game:newMission → reset()` wiped the bugs that `initialPopulate` had just spawned. The handler now resets only when `ctx.world` is not ready for that seed. Verified in headless Chrome: 18–20 bugs alive right after deploy (host and client replicas agree on ids/counts).

## Verification (Phase 7, 2026-09-06)
`npm run typecheck` 0 errors. New `scripts/smoke-rogue-v2.mjs` (single-player, seed 21, headless Chrome on the GPU, parks the
`vite-hmr` socket, sim-time waits) — **46/46**, 4 consecutive runs green on a private `npx vite --port 5305`: behemoth stats / rig params
= warrior × 3, front ray → `part 'front', armored`, rear ray → `rear`; a rogue spawned across a rock cluster picks 1–3 cover points in
≤ 40 s and every one blocks the crouched-eye → chest line while staying ≥ 4 m from the player; from 14 m with LOS the rogue fires
exactly 12 rounds, reloads (`magRounds` 0, hint 12, `reload` audio, crouch + reload pose, no shots for ≈ 2.0 s, mag 12 again); with
every long raycast walled off the LOS hold reaches 3.0 s, the wind-up shows hint 13 + the hand sphere, the grenade flies (`grenade_throw`),
explodes within the fuse 1.3–2.4 m from the player for 26–37 damage (`enemy:attacked {id: thrower, type 'rogue'}`), `explosion` audio +
shake, cooldown ≈ 10 s; `setAuthority(false)` keeps 33 enemies as replicas (every live one buffered, a hit leaves hp untouched) and
`setAuthority(true)` keeps 33, restarts them in chase / idle, damage applies again, `debugSpawn` ids continue ≥ max + 100, 33 enemies
steering / targeting after 1.5 s; a `game:newMission {mode: 'training'}` world has 0 enemies and ignores `startExtractionWaves`;
0 console errors. Regression: `smoke-phase4` 46/46 (its behemoth height check updated to 4.8 m), `smoke-tactical` 45/45, `smoke-uniques` 71/71.
Not covered here (needs a second client): `dmg.kb` / `ghost:damage` routing and the replica grenade visuals — `e2e:mp` territory.

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
