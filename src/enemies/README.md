# enemies/ — bugs, humanoid factions, spawning, AI, corpses, host/replica enemy sync

`EnemySystem` publishes `ctx.enemies` (`EnemyManagerRef`, `src/shared/types.ts`). It owns every enemy: pooled bodies,
procedural rigs, per-type AI, spawning (ambient patrols, planet-threat site groups, raider drops, named rogues, the
sandworm event, tutorial placements), hit detection, status effects, explosions against enemies, lootable corpses, and
the enemy half of multiplayer (host snapshots/events, replica rendering, guarded client requests). Numbers live in
`data/enemies.csv`, `data/enemy_abilities.csv`, `data/constants.csv`, `data/tables.csv`; loot tables belong to `items/`.
No asset files — every rig is built from primitives.

## Files
| File | Responsibility |
|---|---|
| `EnemySystem.ts` | `GameSystem` + `EnemyManagerRef`: mode (authority/replica), bus + net subscriptions, update loop (grid, statuses, AI, despawn), `raycast` / `raycastEx`, host services (`EnemyHost`, `SpawnHost`, `RogueSpawnHost` …), debug hooks; delegates to `parts/` |
| `model.ts` | Folder vocabulary: constants, request-guard limits (`MAX_REQUEST_*`, `STATUS_SOURCE_REACH`, `EXPLODE_SOURCE_REACH`), sound tables (`stepSound`, `meleeHitSound`, `hurtSound`, `STEP_VOICES`, `emitEnemyStep`), scratch |
| `Enemy.ts` | Entity (`EnemyRef`): gameplay state, timers, target, kill credit, rig selection (`baseTypeOf`), `takeDamage`, `kill`, `startEmerge`, `animate`, `muzzle`; `EnemyHost` interface |
| `EnemyTypes.ts` | csv loaders: `ENEMY_STATS` (incl. per-kill `raidXp`, `raidXpOf`), ability blocks (`HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`, `ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`, `NAMED_*`, `HUMANOID_*`, `ENEMY_INCENDIARY`), `isRogueType`, `isWormType`, `baseTypeOf` |
| `factionTables.ts` | csv loaders for `SITE_*`, `RAIDER_DROP_*`, `NAMED_ROGUE_CHANCE_BY_THREAT`, bug-threat tables → `bugThreatTuning(threat)` |
| `Targets.ts` | `CombatTarget` (player / enemy / drone / vehicle / android proxy; `navKey` = its flow-field name, empty for a non-person) and `TargetList` (`all`, `alive`, `drones`, `vehicles`, `allies`, nearest queries, `damageVehicleAt`) |
| `Spawner.ts` | `AmbientSpawner` (initial population, patrols, artillery dig-in), group composition from planet ecosystem, spawn clearance (`spawnBlocked`), `threatEcosystem`, `ambientCap`, `findSpawnCenter` (+ `lastSpawnCenterNest`, optional nest-anchor list) |
| `NestDirector.ts` | Bug nests (2026-09-18): one `bug_egg` per `WorldRef.getNestEggSpots()` spot, per-nest anchors (centroid of that pad's egg spots), garrison binding (`Enemy.nestOf`), seeded refill budget (`Random.hash('nest@<seed>')`) and the refill trigger; `applyEggSize` (per-spot radius on both authority and replica) |
| `SiteGroups.ts` | `placeSiteGroups`: humanoid groups at labs / outposts / rail platforms / ruins by planet threat |
| `RogueDrop.ts` | `RogueDropDirector`: raider drops after structure investigation (two waves, pods, landing spawns) |
| `RogueGuards.ts` | `RogueSpawnHost` contract only (`spawnRogue` + `allocSquadId`); the retired crate-guard no-ops were deleted on 2026-09-19 — placement is `SiteGroups.ts` |
| `WaveDirector.ts` | Extraction wave director — kept but never started (extraction defense removed) |
| `Tutorial.ts` | Tutorial enemies: `placeTutorialEnemies`, `tutorialHold`, burrow ambush + chain spawn (`updateTutorialScript`), aggro release (`onTutorialCheckpoint`, `onTutorialFell`), liftoff fire window (`onTutorialLiftoff`), per-spot weapon override (`TutorialSpawnSpec.weapon` — the last pair's `sg` / `dmr`), fall reset (`FALL_RESET_M`: an enemy that dropped off a cliff snaps back to its post) |
| `Corpses.ts` | `Corpse` interactable (`corpse:<id>`, `시체 수색`), `CorpseManager` (lifetime, looted), `rollCorpseLootable` |
| `RayTests.ts` | Allocation-free ray/nearest tests: sphere, standing capsule, segment capsule |
| `SpatialGrid.ts` | Per-frame XZ hash grid for separation |
| `parts/Damage.ts` | Every damage path into and out of enemies: `applyDamage` (player / remote / ghost / drone / vehicle / enemy target), `explode`, `applyAreaDamage`, `pushBack`, barrier checks, `onHitRequest` / `onExplodeRequest` guards, `enemyDamageSource`, `onEnemyKilled`, `registerCorpse` |
| `parts/CorpseEmpty.ts` | Opened-and-emptied corpses: `onCorpseContainerLooted` (`crate:looted`), `applyCorpseEmptied` (shortens `corpseLife`, sink = `corpseFadeS`), `emptyCorpseAuthority` (+ `ee corpseEmptied`), `onCorpseEmptiedRequest` (`ecorpseq` guard) |
| `parts/Attacks.ts` | Host-decided enemy attacks: acid, humanoid gun (`fireGun`), shells (`fireShell`, `shellArcBlocked`), grenades + incendiary fire zones (`onFireZoneTick`), toxic / spewer bursts |
| `parts/Alerts.ts` | Awareness: gunshot hearing, lures, `alertNear`, `pickTarget` (+ drone / vehicle), shot tracking (`reportShot`, `alertShot`, `onShotReport`), `onWorldNoise`, faction clash, `fleeFrom` |
| `parts/Status.ts` | Burning / slowed / incinerated / shocked, replica status requests + bits, hazard DoT (`updateHazardDot`), x-ray (`setXray`) |
| `parts/Pool.ts` | Pools per type: `acquire` / `release`, `spawn`, `spawnRogue` (weapon, grenade loadout, squad), `ensureCapacity`, `reset`, `disposePools` |
| `parts/RemoteFx.ts` | Replica-side visuals/sounds for `ee` events; changes no game state |
| `parts/Burrow.ts` | Burrow emerge / spat-landing FX and the non-overlapping shake |
| `ai/EnemyAI.ts` | Bug state machine, `integrate` (steering, collision, barrier, extraction keep-out, riding, slope), `footfall`, `integrateDeathFall` |
| `ai/Perception.ts` | `acquireTarget`, `detectionRange` (stealth × smoke), `canPerceive`, `shotConeFactor`, sense/hear radii, `becomeAlert` |
| `ai/RogueAI.ts` | Humanoid state machine: cover cycle (rogue / raider), `androidCycle`, reload, grenades, rush, leash |
| `ai/RogueCover.ts` | Cover + pop-out spot selection — the world half is `shared/cover.pickCoverSpot` (androids use the same one); this file supplies the enemy numbers and the score (flank, "not the rock we are at", approach) |
| `ai/HumanoidProfile.ts` | Faction profiles: aim-error curve, bursts, grenade loadout |
| `ai/SquadFlank.ts` | Raider flanker role |
| `ai/FireLine.ts` | Muzzle line-of-fire check with cache and strafe response |
| `ai/GimmickAI.ts` | Artillery (dig in, support-gated fire: brace → fire → post-fire lock, relocate on blocked arc), toxic swell, behemoth wind-up/charge |
| `ai/ArtilleryPack.ts` | Artillery escort (`spawnArtilleryEscort`, `escortFollow`), fire condition (`hasBugSupport`), own-squad bookkeeping and respawn (`hasLivingSquad`, `maybeSummon`) |
| `ai/NestLeash.ts` | `nestLeashHold`: a bug born at a nest (`nestOf >= 0`) drops its target and walks home past `NEST_LEASH_M`; hysteresis via `NEST_LEASH_RETURN_FRAC`. Bugs from anywhere else return on the first line |
| `ai/Investigate.ts` | Investigation state after an unattributed shot or noise |
| `ai/Structures.ts` | Biting / spitting at player deployables in the way |
| `ai/Lures.ts` | `LureField` noise beacons |
| `ai/Ride.ts` | Enemy / corpse tram riding via `shared/ride.ts`; replica prediction |
| `ai/Burrow.ts` | Emerge / spat-flight gate (no attack or move) |
| `ai/NavMove.ts` | **Pathfinding, the steering point** (A-18 phase 2): `navSteer` — the one call in `integrate` that may replace the `seek` point with a nav-graph point (flow field for a chase goal, a rate-limited private `findPath` for everything else), hold the body at a full gate or start a special link; stuck detection; `EnemyNavState` (the host's shared scratch: graph identity, the one `NavFlowStep`, the per-frame A* budget, the gate counters); `describeNav` |
| `ai/Gates.ts` | Chokepoint throttle: `NAV_GATE_CAPACITY` tokens per `NavRef.gates` entry (`gatePass` · `gateMiss` · `releaseGate`), the twice-a-second recount from the living bodies + token ageing + `NavRef.setGateLoad` (`sweepGates`) |
| `ai/Traverse.ts` | Special links performed off the colliders (`updateTraverse`, an atomic gate like the hunter flip): ladder · wall climb · window crawl (breaks a whole pane first) as one six-leg machine; `beginTraverse` · `endTraverse` · `canTraverse` · `atLinkStart` · `linkBusy` |
| `ai/HunterFlip.ts` | Hunter flip gate: a leap that took ≥ `HUNTER_LEAP.flipDamage` (`Enemy.noteLeapDamage`) drops straight down and lies on its back for `flipDuration` s — no move / turn / attack (`updateHunterFlip`) |
| `ai/Steering.ts` · `ai/Common.ts` | Seek / separate / avoid; `lookAtTarget`, `startMelee`, `stumble`, `holdingFire` |
| `ai/named/` | Named AI: `Sniper.ts` (Roden), `ScanDrone.ts`, `Hammer.ts` (Tagilla), `Heavy.ts`; `model.ts` data types, `remote.ts` replica hooks, `index.ts` dispatch |
| `named/Director.ts` · `named/SniperShot.ts` | Named roll + placement; sniper shot / glint FX |
| `sandworm/Director.ts` · `sandworm/Pose.ts` | Sandworm (`땅굴벌레`) event: cumulative per-check appearance chance (host), thumper summon, warn, erupt, spit, acid, resync, adult / weak type by planet threat; hint → pose |
| `net/HostSync.ts` | `animHint`, `statusBits`, `SnapshotCache`, `encodeSnapshot` (delta `es`) |
| `net/Replica.ts` | `ReplicaBuffer`, `EnemyReplica` (snapshots, events, interpolation, adopt on demotion) |
| `models/BugModel.ts` · `BugParams.ts` | Six-legged rig + animation; per-type params |
| `models/RogueModel.ts` · `HumanoidParts.ts` · `FactionLooks.ts` | Humanoid rig + animation; part helpers; android / raider looks |
| `models/WormModel.ts` | Sandworm rig — geometry baked per worm type from its own `enemies.csv` row (`sandworm` · `sandworm_weak`), `baseScale` stays 1 |
| `models/EggModel.ts` | Bug-egg rig — the old decorative egg's look moved here verbatim (squashed sphere, `0xb8a070`→`0xe0d0a0` gradient, `0x6a5020` emissive); per-instance size through `baseScale` (`setEggScale`), damage ruptures that only exist while hurt (`visible` gated → an intact egg is one draw call) |
| `models/named/` | Named looks + `namedBodyRay` (prone sniper capsule) |
| `models/Portrait.ts` | `renderEnemyPortrait` (offscreen renderer, cached data URL), `enemyDisplayNameOf` (Korean names) |
| `fx/` | `BloodFX`, `AcidProjectile`, `ShellProjectile` (uses `shared/ballistics`), `RogueGrenade` (grenades + fire zones), `BurrowFx`, `ScanPulseFx`, `Xray` |
| `index.ts` | Barrel |

## Enemy types
Stats per row in `data/enemies.csv`; abilities in `data/enemy_abilities.csv`. Factions `bug` · `rogue` · `android` · `raider`; every different pair is hostile.

| Type | Faction | Role |
|---|---|---|
| `scavenger` | bug | Swarm melee |
| `hunter` | bug | Flanker with leap (red stripes, `BugParams.stripes`); flipped onto its back when shot hard mid-leap |
| `warrior` | bug | Heavy melee |
| `spewer` | bug | Acid globs, death burst |
| `charger` | bug | Wind-up rush; weak rear |
| `artillery` | bug | Stand-off mortar, interceptable shells, never melees. Digs in with 2–3 scavenger escorts; fires only when another bug is near the target |
| `scavenger_summon` | bug | Scavenger an artillery summons as its own squad: scavenger stats / rig / AI / sounds (`baseTypeOf`), `CORPSE_LOOT_CHANCE` 0 (no drops), `raidXp` 0 (no kill XP) |
| `bug_egg` | bug | **Immobile, harmless nest egg** (2026-09-18). Speed / turn / sight / hearing / attack all 0, stagger- and knockback-immune, no footsteps; its own rig (`models/EggModel`), no AI at all. `Enemy.isCombatant` is false so it never counts as a living fighter. Per-spot size (0.35–0.7 m); drops 생체 조직 + 미확인 세포 (`loot_corpses.csv` · `loot_corpse_samples.csv`) |
| `toxic` | bug | Suicide runner, swells then bursts (friendly fire) |
| `behemoth` | bug | Scaled warrior (`BEHEMOTH_SCALE`), armored front plate, knockback charge |
| `sandworm` | bug | `땅굴벌레` event boss (threat 2–3), rooted: spits bugs then acid (`sandworm/Director`) |
| `sandworm_weak` | bug | `어린 땅굴벌레` (threat 1): same rig / director, hp `SANDWORM_WEAK_HP` fixed, body and eruption radius × `SANDWORM_WEAK_SCALE`, spits scavengers only. Branch on `isWormType`, never `=== 'sandworm'` |
| `rogue` | rogue | Threat-2 site gunner, cover cycle, carried grenades |
| `rogue_boss` | rogue | Site group leader (≤ `SITE_BOSS_MAX_PER_RAID`) |
| `android` | android | Threat-1 site robot: no cover, no grenades, sparks instead of blood |
| `raider` | raider | Threat 2–3 sites and drops: accurate long range, flanker per group |
| `rogue_sniper` | raider | Named "Roden": prone sniper + scan drone |
| `rogue_scan_drone` | raider | Flying scanner, unlootable wreck |
| `rogue_hammer` | raider | Named "Tagilla": hammer melee near structures |
| `rogue_heavy` | raider | Named "Heavy": minigun + SMG escorts |
| `tut_bug_loot` · `tut_bug` | bug | Tutorial scavenger (fixed drop / empty) |
| `tut_android_loot` · `tut_android` | android | Tutorial android, half hp (fixed drop / empty) |

`Enemy.isHumanoid` (faction ≠ bug) gates humanoid AI, sounds and recycling; `Enemy.isRogue` is only the rogue faction check.

## Public API
- `ctx.enemies`: `getEnemies`, `getAliveCount`, `raycast`, `raycastInterceptable`, `applyExplosion`, `applyAreaDamage`,
  `applyStatus`, `queryNear`, `addDistraction`, `setThreatLevel`, `killAll`, `reset`, `setAuthority`, `reportShot`, `setXray`,
  `callRogueDrop`, `getRogueDrops`, `getEnemyGrenades`, `pushBack`, `getFireZones`, `renderPortrait`, `enemyDisplayName`,
  `applyAllyHit`; `startExtractionWaves` / `stopExtractionWaves` exist but nothing calls them.
- Emits: `enemy:spawned|killed|squadKill|damaged|attacked|alerted|shot|shotAlerted|chargeStarted|toxicBurst|shellFired|shellIntercepted|shellLanded|incinerated|shocked|bossSpawned|namedSpawned|factionClash|waveStarted`,
  `corpse:spawned|removed`, `rogueDrop:incoming|landed`, `sandworm:warning|erupted`, `named:sniperGlint|scanPulse|scanExposure`,
  `implant:barrierBumped`, `ghost:damage`, `player:applySlow`, `ui:hitmarker`, `ui:notify`, `camera:shake`, `audio:play`.
  `enemy:killed {by, deathDir, weaponClass}` — `by === 'local'` is our kill; `weaponClass` is set only for our gun kills.
- Listens: `world:ready`, `game:newMission`, `game:abort`, `game:paused`, `weapon:fired`, `net:remoteFired`, `ally:fired`, `grenade:exploded`,
  `extraction:liftoff`, `tutorial:checkpoint`, `player:fell`, `crate:looted`, `world:noise`, `structure:investigated`,
  `net:hostChanged`, `cheat:sandworm {spitS?, weak?}`, `sandworm:summon` (thumper, host only).
- Wire (`src/shared/net.ts`):
  - Host → all: `es` (`EnemySnapshot`, delta), `ee` (`EnemyEvent`: `spawn` · `kill` · `despawn` · `damaged` · `attack` · `acid` ·
    `acidAt` · `wave` · `shoot` · `shell` · `intercept` · `shellHit` · `charge` · `toxic` · `corpse` · `corpseGone` · `corpseEmptied` · `grenade` ·
    `grenadeHit` · `barrierHit` · `glint` · `snipe` · `scanPulse` · `hammer` · `spray` · `wormWarn` · `wormErupt` · `wormSpit`),
    `rdrop incoming|landed`, `dmg` to a victim, `hitc` to a requester.
  - Client → host: `hit` (`HitRequest`: damage, `st` status bits, `kb`), `explode`, `intq` (shell interception), `shotq` (shot report), `ecorpseq emptied` (an enemy corpse emptied on that client).
- Snapshot `a` hints: 1 charger windup · 2 rush · 3 spewer windup · 4 airborne/spat · 5 humanoid shooting · 6 cover/stagger ·
  7 rush · 8 artillery dug in · 9 toxic swell · 10/11 behemoth windup/charge · 12 reload · 13 throw · 14/15 sniper prone/glint ·
  16/17 hammer windup/charge · 18/19 heavy spin/fire · 20 scan pulse · 21/22 worm spit/acid · 23/24 hunter flipped falling/lying · 25 artillery braced flat ·
  26/27/28 on a special link and off the floor — on a wall nose up / on a wall nose down / level (`ai/Traverse`; all three switch a replica's terrain snap, ride and slope off) (`net/HostSync.animHint`).
- Debug on `getSystem('enemies')`: `debugSpawn`, `debugSpawnNamed`, `debugNamedRoll`, `debugSites`, `debugEcology`,
  `debugBugTuning`, `debugAmbientGroup`, `debugWaveGroup`, `debugSandworm`, `debugSandwormState`, `debugSandwormChance`,
  `debugSandwormClearOnce`, `debugSpawnBurrow`,
  `debugNests`, `debugTutorial`, `debugDroneTargets`, `debugSnapshot`, `debugApplySnapshot`, `debugHint`, `debugGrenade`, `debugShell`,
  `debugXray`, `debugSetDropSquad`, `debugDropWaves`, `debugAllyTargets` / `debugAllyTargetList` / `debugCoverSpot`,
  `debugEmptyCorpse`, `debugNav` · `debugNavOf(id)` · `debugTraverse(id, link)` (pathfinding — see **Pathfinding**), `hitGuardStats`, `isAuthority`, `isTrainingWorld`, `isTutorialWorld`.

## Authority and replicas
- Mode is decided per mission (`refreshMode` at `world:ready` / `game:newMission` / `game:abort`) and switched live only by
  `setAuthority` from `net:hostChanged`. Authority = single-player or lobby host: AI, spawning, damage; in a session it
  streams `es` at `NET_ENEMY_SNAPSHOT_HZ` and `ee` events. Replica: no AI/spawner/damage; interpolates host snapshots
  through the same pools so `raycast`, FX, map and HUD work; `takeDamage` becomes a hit flash + `hit` request.
- `es` is a delta stream: keyframe every `NET_ENEMY_KEYFRAME_S`, on `flow rejoined|takeover`, after `reset()` and on
  promotion; deltas carry changed rounded fields only, `gone` lists removed ids. Replicas sweep unseen ids only on
  keyframes, `hold` omitted ones, ignore unknown ids without `ty`. Corpses leave snapshots 1.5 s after death.
- Promotion seeds enemies from the newest wire sample, resets targets, sets `lastDamager = 'ai'`, offsets ids / shell ids /
  `seq` (`PROMOTE_ID_GAP`, `PROMOTE_SEQ_GAP`) and resumes the spawner. Demotion `adopt`s every live enemy into a replica
  buffer. In-flight grenades flip authority.
- Replicas accept `ee` only from the lobby host. Host request guards run shape → sender → distance → rate:
  `hit` damage ≤ `MAX_REQUEST_DAMAGE` and a per-sender DPS bucket (`HIT_REQUEST_DPS_MAX`) shared with `explode`;
  `kb` ≤ `MAX_REQUEST_KNOCKBACK` within reach; `st` bits masked to `ENEMY_STATUS_BITS`, within `STATUS_SOURCE_REACH`, own
  rate budget; `explode` within `EXPLODE_SOURCE_REACH` of the sender (dead senders allowed — grenades outlive throwers).
- Kill credit: `ctx.stats.kills` only for `lastDamager === 'local'`; faction/AI kills (`'ai'`) emit no `enemy:killed`.
  Replicas count their own kill from `ee kill.killer` and emit `enemy:squadKill` for other members.
  Every counted kill also adds the type's `raidXp` (`data/enemies.csv`, `raidXpOf`) to `ctx.stats.killXp` — the only source of
  raid-end character XP (`game/parts/Death.awardMissionXp`). Both sites (`parts/Damage.onEnemyKilled`, `net/Replica` `kill`)
  must keep the same condition as `kills++`, or a kill pays twice / never. Burn/incinerate
  kills credit `Enemy.burnAttacker`.

## Spawning
- `world:ready` (authority, not training/tutorial): `nests.onWorldReady()` → `AmbientSpawner.initialPopulate` →
  `placeSiteGroups(seed, threat)` → `named.roll(planet)`. The sandworm director rolls on every client. Training: no enemies at all.

### Bug nests (`NestDirector.ts` · `ai/NestLeash.ts`, 2026-09-18 — decision 「둥지 반경 60 m 리시 · 초기 수 절반 · 재스폰 50/35/15 %」)
- **Eggs**: one `bug_egg` per `WorldRef.getNestEggSpots()` entry, spawned by the authority before the initial population.
  The spot's `position` is the **drawn sphere centre**, so the body's feet sit `radius × EGG_CENTER_MUL` below it. Size comes
  from the spot's radius and is applied in `Pool.acquire` (`applyEggSize`) on **both** authority and replica — the world is
  identical for a given seed, so no wire field (the same trick as `BUG_HP_MUL_BY_THREAT`). Empty in training / the tutorial.
- **Nest anchor**: `NestEggSpot.nest` is the **pad** index (what a player calls a nest), *not* an index into
  `getNestPositions()` (which lists 4–6 mound holes per pad). The anchor is the centroid of that pad's egg spots.
  `initialPopulate` is handed those anchors and reports the one it landed on (`lastSpawnCenterNest`), so the group standing
  there becomes that nest's **garrison** (`Enemy.nestOf`, `guardPos` = the anchor).
- **Garrison size**: the initial patrol **group count** is × `NEST_INITIAL_GARRISON_MUL` (0.5, min 1). The multiplier never
  touches a group's composition — slicing a group from the front would silently drop its heavies.
- **Leash**: `NEST_LEASH_M` (60 m) from the anchor; a bug past it drops its target and walks home, and while returning it
  cannot re-acquire. It stops returning inside `NEST_LEASH_M × NEST_LEASH_RETURN_FRAC`. Bugs with `nestOf === -1`
  (mid-raid patrols, waves, raider drops, sandworm spit) are untouched.
- **Refills**: per nest, one seeded roll of how many refills this raid allows — `NEST_REFILL_COUNT_CHANCE` (index k = k+1
  refills; 1 → 50 %, 2 → 35 %, 3 → 15 %) from `Random.hash('nest@<seed>')`, a stream of its own so world / named rolls are
  untouched and a promoted host would get the same answer. Every `NEST_REFILL_CHECK_S` the host counts that nest's living
  **mobile** bugs (eggs are not `isCombatant`, so they never count); at or below `garrison × NEST_REFILL_TRIGGER_FRAC` one
  group digs out at the anchor (`BURROW_EMERGE_S`, the ambient path) and one refill is spent. Exhausted = that nest stays empty.
- Host-authoritative with **no new wire**: replicas only see `ee spawn`. `nestOf` is host memory, so a host change releases
  the leash (the same intent as `escortOf`).
- Ambient patrols: cap `ambientCap(threat, eco)`, groups from the planet ecosystem (`src/shared/planets.ts`) within power
  tiers; bugs burrow in (`BURROW_EMERGE_S`). Initial population does not burrow. Large bodies re-roll positions while
  `obstacleCoverage` blocks them and are skipped rather than downgraded (`spawnBlocked`).
- Site groups: threat 1 androids; threat 2 rogues/raiders by `SITE_RAIDER_SHARE_*` at labs/outposts, rogues at platforms
  and ruins; threat 3 raiders. Positions from `WorldRef.getSiteSpawnPoints`; per-site seed `hash('sites:<id>@<seed>')`;
  leash = site radius + `SITE_GROUP_LEASH_INDOOR_M` / `_OUTDOOR_M`; one raider flanker per group; rogue boss leader with escorts.
- Raider drops: on the first `structure:investigated` of a zone the host rolls `RAIDER_DROP_CHANCE_BY_THREAT` once
  (seeded by zone, so any host gets the same answer). Up to two waves sized by squad (`RAIDER_DROP_WAVE1/2_*`,
  ≤ `RAIDER_DROP_WAVE_MAX`); wave 2 is a separate drop `<zoneId>#2` after `RAIDER_DROP_WAVE_GAP_S` (lost on host change).
  Landed raiders investigate toward the structure; tram containers target the nearest platform. Alarms/sounds/HUD for
  `rogueDrop:incoming` are owned by `audio/` and `ui/`; this folder plays only `rogue_pod_impact`.
- Named rogues: at most one per raid, `NAMED_ROGUE_CHANCE_BY_THREAT`, seed `hash('named@<seed>')`; `ctx.missionIntel.namedId`
  (intel broker) forces the type after consuming the rolls so placement is unchanged. Spots avoid rail corridors,
  structure footprints and blocked ground (`named/Director.ts` header).
- Drop and named bodies bypass `ensureCapacity`; humanoids and `relentless` bodies are never recycled.

## Burrow spawns and sandworm (`굴착 스폰 · 땅굴벌레`)
- Burrow: `Pool.spawn(…, emerge)` for bug faction only. `Enemy.startEmerge` lowers only the rig; `position` stays on the
  surface so hits work; `ai/Burrow.updateBurrowGate` blocks attack/move until out; a body killed while emerging keeps
  rising (sandworm excepted). Shake once per `BURROW_SHAKE_GAP_S`. Wire `ee spawn.em`.
- Burrow sound: `burrow_emerge` **per bug** at its body (`parts/Burrow.emergeSound`, not the `playAudio` id throttle);
  within `BURROW_EMERGE_BATCH_S` of a batch's first sound the k-th is × 1/√k, and audio/ caps overlap
  (`BURROW_EMERGE_VOICE_CAP`). Spat-bug landings use the same path. Sandworms keep their own sounds.
- Bug footsteps: `STEP_VOICES` rows with `id` (`bug_step_skitter` / `_heavy` / `_giant`) replace the surface footstep for
  bugs; `emitEnemyStep` gates on the row's `range` (`BUG_STEP_RANGE_M`, behemoth `BUG_STEP_GIANT_RANGE_M`) from the
  camera and divides the volume by √n, n = bugs whose `stepAt` is within `BUG_STEP_CROWD_WINDOW_S` (`bugStepCrowd`).
  Humanoids keep `footstep_<mat>` (+ `layer`). Which types step at all is `enemies.csv` `stepSound`.
- Sandworm `땅굴벌레` (`BURROW_*` / `SANDWORM_*` in `data/constants.csv` + `data/tables.csv`; decision
  in Decisions below): **no pre-roll, no time window, at most once per raid**. The host checks
  every `SANDWORM_CHECK_S`: candidates = living humans (local + remotes in mission) + android squadmates
  (`ctx.allies.getCombatBodies()`); an *eligible* member is sprinting **and** carrying `light` or heavier (local
  `InventoryRef.getWeight()`, remote `RemotePlayerRef.weightState` from `PlayerSnapshot.ws`, android = its loadout kg /
  capacity through the `WEIGHT_*_RATIO` thresholds). The largest cluster of ≥ `SANDWORM_MIN_MEMBERS` eligible members
  within `SANDWORM_GROUP_RADIUS` gives `p = SANDWORM_BASE_CHANCE_BY_THREAT[threat] × min(1, Σ SANDWORM_P_PER_LIGHT|HEAVY)
  × closeness (1 at ≤ SANDWORM_P_NEAR_M mean pairwise distance → SANDWORM_P_FAR_MUL at the radius) + SANDWORM_P_LURE` when
  a lure grenade (`LureField` kind `'lure'` / `ctx.gadgets.findDistraction`) is within `SANDWORM_LURE_RANGE_M`. A lone
  human with no android is 0 %. The per-check table is in the `Director.ts` header. Spot = cluster centre or (with
  `SANDWORM_LURE_SPOT_CHANCE`) the lure, both through `validSpot`: nobody nearby standing ≥ 1.2 m above terrain and
  `WorldRef.burrowGroundOk(x, z, BURROW_GROUND_CHECK_R × scale)` (flat bare ground; a world without it → never).
  `sandworm:summon` (thumper, host) starts the warning at once when the event has not happened yet, bypassing chance and
  ground check. Type by planet threat: 1 → `sandworm_weak`, 2–3 → `sandworm`.
  Flow: warn (`ee wormWarn {r}`, `sandworm:warning`) → erupt (damage + knockback within `r`, other factions, drones,
  max hp rolled / fixed, `ee wormErupt {hp, ty}`) → spit bugs for `SANDWORM_SPIT_PHASE_S` (`ee wormSpit`) → acid volleys.
  Immobile, not recycled, no stagger. `flow rejoined` → `resync()` (live worms with `sy: 1`, or `{id: 0, sy: 1}` = already
  happened) so a promoted host continues and never spawns a second one.

## Bug difficulty by planet threat (`벌레 난이도`)
`bugThreatTuning(threat)` from six `data/tables.csv` tables (`BUG_HP_MUL_BY_THREAT`, `BIG_BUG_WEIGHT_MUL_BY_THREAT`,
`MID_BUG_WEIGHT_MUL_BY_THREAT`, `PATROL_BEHEMOTH_BY_THREAT`, `ARTILLERY_CAP_BONUS_BY_THREAT`, `BEHEMOTH_CAP_BONUS_BY_THREAT`).
Applied at `world:ready` on every client: bug max hp in `Pool.acquire` (not sandworm, not humanoids; no wire field),
`threatEcosystem` weights/caps for patrols, waves and sandworm spit. Threat-1 row = identity; training and tutorial use it.

## AI
- Targets: `pickTarget` order = barrier carrier → rover aggro → drone / noticed rover → people and hostile
  factions (hysteresis in `acquireTarget`).
  Downed, dead and rover-riding players are not `alive` and never targeted or damaged. Drones (`aggroable` only), the
  rover and the androids are separate proxy lists, not in `all` / `alive`.
- **Androids (`ctx.allies`, 2026-09-15)** are people as far as an enemy is concerned: `TargetList.allies` is refilled
  every frame from `AlliesRef.getCombatBodies()`, the proxies carry a player's radius / height / eye heights, and
  `pickTarget` takes the nearer of the nearest player and the nearest android. They are hit by the humanoid rifle, bug
  melee and contact (`nearestAliveWithin`), acid globs and splashes, grenades, shells, fire zones, toxic / spewer
  bursts, the behemoth charge and the sandworm eruption — every path that can hit a player. Damage goes out through
  one branch in `applyDamage` → `ctx.allies.damage` **on the authority only** (no knockback, no slow, no `dmg` wire).
  Exceptions: named sniper Roden shoots players only (`ignoresAllies`), and tutorial worlds have no androids.
  An android's shot is heard exactly like a player's (`ally:fired` → `onGunshot` + `alertShot`), and its bullets reach
  enemies through `applyAllyHit` (authority only; `'ai'` credit, wakes the body and turns it on the shooter).
- Enemy → enemy damage (2026-09-17): every path where an enemy hurts another enemy multiplies by `ENEMY_CLASH.damageMul`
  (`parts/Damage.applyDamage` enemy branch — melee · charge · leap · acid; `parts/Attacks` gun foe · grenade blast · fire-zone burn · shell ·
  toxic burst; `sandworm/Director` eruption). The player / android / drone / vehicle share stays the csv number. Exceptions: the
  behemoth charge uses its own vs-enemy value; hazard DoT is not scaled.
- Perception: `detectionRange = sightRadius × target stealth × smoke clarity`; alert propagates within a faction.
- Nest leash (2026-09-18): `ai/NestLeash.nestLeashHold` runs right after `tutorialHold`, before the bug state machine. Only
  `nestOf >= 0` bodies are touched (see **Bug nests**); airborne / charging / staggered bodies finish what they started first.
- Bugs: `idle → wander → alert → chase → attack → stagger`, `dead` / `flee`; artillery, toxic, behemoth in `GimmickAI`.
- Pathfinding (2026-09-21): see **Pathfinding (A-18 phase 2)** below — it only ever changes the *point* `integrate` seeks.
- Artillery (2026-09-17 · 2026-09-18, `ai/ArtilleryPack.ts` + `GimmickAI`): `maxArtillery` (+ `ARTILLERY_CAP_BONUS_BY_THREAT`) is a
  **live** cap — every not-dead artillery counts (`Pool.countAlive`), a killed one frees its slot. Dig-in brings
  `escortMin`–`escortMax` scavengers (`escortOf`) that wander around it and run back beyond `escortFollowDist` until they notice a
  target, then fight normally. It fires only when a non-artillery bug stands within `supportRadius` of its target (a `bug_egg` is
  **not** one — it is not `isCombatant`).
  - **Fire sequence** (`Enemy.shellPhase`, `anim.brace`, wire hint 25 for all of it — no new hint): **3 = 포격 준비** for
    `prepTime` the first time support appears (screech + `anim.abdomen` throb + the brace pose, all existing assets; the danger
    HUD gains nothing — a shell still has exactly one indicator), then **1 = brace** `braceTime`, fire, **2 = lock**
    `postFireLock`. Losing support / range / the target during prep cancels it and clears `shellPrepDone`, so the next
    engagement preps again; shots after the first prep only brace.
  - **Own squad** (replaces the 2026-09-17 once-per-lifetime summon): when every scavenger whose `escortOf` is this artillery is
    dead, `squadCooldown` starts; when it runs out `summonMin`–`summonMax` `scavenger_summon` dig out around it and are bound with
    `escortOf` too. With a person target in `maxRange` they are sent at it (relentless, target locked), otherwise they guard the
    artillery like the dig-in escort. It runs off `chase` as well (`artilleryOffChase`), so an artillery that lost its target still
    refills. `scavenger_summon` drops nothing and pays 0 raid XP, so repeated squads cannot be farmed.
  - **Intended**: escort links, `shellPrepDone` and `squadCd` are host memory only — after a host change escorts become plain bugs
    and the new host preps and re-summons from scratch.
- Hunter flip (2026-09-17): every hp loss on the authority while `leaping` (crouch → landing) adds to `Enemy.leapDamage` — a replica's `hit`
  request lands in the same `takeDamage`, burn ticks count, the quiet hazard tick does not. At `HUNTER_LEAP.flipDamage` the leap ends:
  horizontal velocity 0, real-gravity fall (`flipFalling`, hint 23), then `flipTimer = flipDuration` on its back (hint 24). The state
  is `stagger` with `staggerTimer` 0, so the ordinary stagger exit resumes the AI. Still damageable and killable. Leap arc uses
  `GRAVITY × arcGravityMul`; flight time is fixed (`flightTime`), so horizontal speed = distance / flightTime.
- Humanoids: `RogueAI` cover cycle (pick cover → move → crouch hold → step out to `popPos` → burst → optional rush),
  magazine reload, carried grenades (`grenadeCount`), faction profile from `HumanoidProfile`; androids use `androidCycle`.
- Fire line: shots and spit are held (never movement) when the muzzle line from `ENEMY_WALL_STANDOFF` behind the muzzle is
  blocked; the AI strafes (`ai/FireLine.ts`). Artillery checks the arc before firing and relocates (`shellArcBlocked`).
- Shot tracking: weapons call `reportShot` once per trigger pull (non-hosts send `shotq`). The host puts unaware enemies
  near the bullet path (clipped at the impact point) or impact into `ai/Investigate` with a widened cone toward the origin.
  `world:noise` (drones) does the same except in the tutorial.
- `holdingFire` (`ctx.extraction.holdFire`) is checked in `FireLine`, `fireGun` and `startMelee`.
- Barrier: `integrate` calls `resolveBarrier`; contact retargets the carrier; frontal melee is absorbed via implants.
- Named: Roden shoots players only, always after a scope glint; scan drone pulses expose players; Heavy sends only
  `ee spray on/off` and replicas simulate tracers; Tagilla's charge borrows `chargePhase 2`. Details in each file header.

### Pathfinding (A-18 phase 2, 2026-09-21 — `ai/NavMove.ts` · `ai/Gates.ts` · `ai/Traverse.ts`; contract `src/shared/nav.ts`)
Enemies **use** the raid's nav graph (`ctx.world.nav`, baked by `world/nav`); they own none of it. Authority only, nothing on the
wire but three pose hints; a host change starts every body from 「no pathfinding」.
- **Who**: `EnemyStats.navCan` (csv `enemies.csv` `nav`). scavenger (+ `scavenger_summon`) = `indoor+ladder+climb+window`, hunter ·
  toxic · Tagilla · Heavy = `indoor`, rogue · rogue_boss · android · raider = `indoor+ladder`. **Everything else is 0 and not one
  character of its steering changed** — `integrate` does not even call `navSteer` for it, so a warrior still stands at the wall.
- **The graph never takes the old behaviour away.** `navSteer` answers 「steer as before」 (circle avoidance on) when there is no graph
  (null in the tutorial · training range · ship) or it is not baked, the body is charging / airborne / leaping / spat / digging out /
  fleeing / riding a tram / a tutorial enemy (`homeLeash > 0`), its target is the rover or a drone in the air, the straight line is
  walkable, the field or the search has no answer, or it got stuck following the graph.
- **The check**: every `ENEMY_NAV_CHECK_S` (staggered by id at spawn; at once when the goal jumped 4 m or the goal's kind changed)
  a *moving* body asks `nav.walkable(position, goal)`. Walkable → mode none. A `moveTarget` written as `set(x, 0, z)` has no height:
  y exactly 0 is read as 「the surface there at my own height」 (`goalOf`).
- **Flow mode** — a *chase goal*: a live **person** target (player or android proxy — `CombatTarget.navKey`, built once, never
  concatenated per frame) with `moveTarget` within 8 m of it (the scavenger weave and the hunter flank offset count). Each tick
  `nav.flowTo(key, target.position, navCan)` → `sample(position, step)` → steer at `step.aim`. One `NavFlowStep` per host
  (`EnemyNavState.step`, re-made when the graph object changes). No answer → the old steering for that tick.
- **Path mode** — a *private goal* (nest return, investigated shot, wander point, cover / pop-out, lure, an **enemy** target):
  `findPath` into the body's own `NavPath` (lazy, kept across pool reuse, re-made for a new graph), planned again every
  `ENEMY_NAV_REPLAN_S` (jittered by id), on a goal jump or a `revision` change, and **at most `ENEMY_NAV_PLANS_PER_FRAME` searches a
  frame for the whole pool** (`EnemyNavState.takePlan`) — a body without a slot keeps its path, or the old steering. Waypoints are
  passed within radius + 0.4 m on the same floor; past the last one the final stretch is straight. Path mode ignores gates.
- **While a graph point steers** `integrate` skips `avoidObstacles` (a wall reads as one huge circle and pushes the body off the
  path — phase 1's lesson) and keeps `separate`; surface → collision order, barrier, extraction keep-out, ride, gait and yaw are
  untouched. The attack logic is untouched too: it keys off `distToTarget`, and the field stops answering within `NAV_FLOW_ARRIVE_M`.
- **Stuck**: following the graph with a net displacement under a quarter of the asked travel over `ENEMY_NAV_STUCK_S` (not while
  attacking, queueing at a gate or holding at a link mouth) → pathfinding off for `ENEMY_NAV_OFF_S`.
- **Gates** (`ai/Gates`, user's decision 「2마리씩」): a flow step that reports `gate >= 0` needs that gate's token — held → go; free
  slot (`NAV_GATE_CAPACITY`) → take it → go; else refused: it walks up to `NAV_GATE_HOLD_M` (field distance) and stands facing the
  gate. **A body already inside a gate never waits.** A token goes back when the flow stops reporting the gate for 0.4 s, when the
  body leaves flow mode / dies / is pooled (`Enemy.clearNav`), or after `NAV_GATE_TOKEN_S` (then it is banned for as long again so
  the queue moves first). Twice a second `sweepGates` **recounts holders and queues from the living bodies** — no path that drops a
  body can leak a token — and reports every changed queue with `nav.setGateLoad`. The queue counts **every refused body** the
  flow still routes through that gate (within `NAV_GATE_LOOK_M`), not only the ones already standing at the hold line: the ones
  behind them are blocked by the ones in front and would never be counted.
- **Special links** (`ai/Traverse`): a flow step or a path waypoint of kind `ladder` / `climb` / `window`, when the mask has the bit
  and the body really stands at the link's start (`atLinkStart` — the flow answers for the *nearest node*, which over a roof hatch
  can be the ladder's foot one floor down), is **performed**: an atomic gate in `updateEnemyAI` right after the hunter flip. Off the
  colliders and the state machine, the ride dropped, still damageable — `kill()` clears the link and decides `deathLanded` from the
  height, so a bug shot on a wall falls; a stagger holds it where it hangs. Legs: 0 to the start · 1 window only, a whole pane →
  one melee wind-up (`stats.attackWindup`, the bite's lunge and `bug_attack`) → `nav.breakWindow` · 2 straight up to `via.y` ·
  3 across to `via` · 4 across to `to` · 5 down onto the floor (`getSurfaceY`). A wall link whose `to` is lower goes **down**: off
  the edge first, then head first down the face. Bugs move at `ENEMY_CLIMB_SPEED` / `ENEMY_WINDOW_CRAWL_SPEED`, humanoids on a
  ladder at `LADDER_CLIMB_SPEED` / their `wanderSpeed`. A link is not a gate, so **one body at a time enters its mouth**
  (`linkBusy`: the next starts once the one ahead is two radii + 0.3 m from the start, 3D) — a column up the wall, a stream
  through the sill. Unknown ladder / 14 s overrun → it ends where it is, seated on whatever is below.
- **Pose + wire**: `Enemy.navAloft` / `navClimbDir` → hints 26 · 27 · 28; a replica writes the same two fields back from the hint,
  and `Enemy.animate` blends `anim.climb` (`models/BugModel`: the body lies along the wall, belly to it) on both sides. A ladder
  is backed down nose up; humanoids get no new pose. A body on a link is exempt from the AI LOD (`navTrav !== 0`), the animation
  LOD (`navAloft` / `anim.climb`) and other bodies' separation push (the test is XZ only).
- **Debug** (`getSystem('enemies')`): `debugNav()` → `{ ready, gates, flow, path, traversing, waiting, off, tokens[], queues[],
  plansLastSecond }` (living bodies; arrays by `NavGate.id`); `debugNavOf(id)` → `{ mode: 'none'|'flow'|'path', traverse:
  'none'|'ladder'|'climb'|'window', phase, aloft, climbDir, gate, waitGate, offT, pathStatus, pathCount, pathIdx, navCan }`;
  `debugTraverse(id, { kind, from?, via?, to, ladderId?, windowId? })` starts a link by hand (no mask check).
- **Known limits**: a window / wall link has no queue on the graph's side, so a crowd at one window is not spread to another
  the way a gate's queue is; bodies walking up behind a body that holds at a link mouth can trip the stuck rule and steer the old
  way for `ENEMY_NAV_OFF_S`; the pane-breaking wind-up has no wire hint (a replica sees the bug stand, then the glass break);
  a bug pushed into an open roof hatch drops to the floor below (`getSurfaceY`) and climbs the ladder back up.

## Damage, statuses, corpses
- Enemy explosion damage uses `shared/explosion.explosionFalloff` (distance to body surface, per-source floors).
- Every enemy hit on a player goes through `parts/Damage.applyDamage` and carries `enemyDamageSource(id, type)` locally or
  `dmg.src` remotely; ghosts (`suspended`) get `ghost:damage`.
- Statuses: host owns timers; replicas mirror `EnemyWire.sb` and request via `hit {dmg: 0, st, dur}`. Hazard zones apply a
  quiet DoT (`HAZARD_ENEMY_DPS`, no credit).
- Corpses: `CORPSE_LOOT_CHANCE` (`src/shared/types.ts`) decides searchability on its own seed stream; loot is rolled on
  interact with `shared/lootRolls.corpseLootRandom` and inputs (`site`, remaining grenades) replicated in `ee corpse`.
  Mid-air kills fall (`integrateDeathFall`) and register on landing. Lifetime = `EnemySystem.corpseLifetime`
  (`CORPSE_LIFETIME`, `Infinity` in the tutorial).
- Emptied corpses (`parts/CorpseEmpty.ts`): a corpse that was **opened and emptied** (`crate:looted corpse:<id>`, including an
  empty roll) gets `corpseLife = deathTimer + CORPSE_EMPTY_REMOVE_DELAY_S + CORPSE_EMPTY_SINK_S` and `corpseFadeS =
  CORPSE_EMPTY_SINK_S`; the normal despawn loop removes it (every raid, tutorial too). The authority applies it at once and
  broadcasts `ee corpseEmptied`; a replica within `CORPSE_EMPTY_REQUEST_REACH_M` sends `ecorpseq emptied` to the host, which
  checks shape → sender → distance → rate (`CORPSE_EMPTY_REQUEST_RATE_MAX` / `_BURST`, refusals in
  `hitGuardStats.corpseEmptyRefused`). Unopened or unlootable corpses keep `CORPSE_LIFETIME`.

## Tutorial enemies
Tutorial raids place only `ctx.world.tutorial.enemySpawns()` (read once; killed enemies stay dead): no rolls, patrols,
sites, drops, named, sandworm. Humanoids spawn at `world:ready`; bugs wait as an ambush and burrow in when the player
enters their own sense radius, then chain-spawn every `TUTORIAL_BUG_CHAIN_SPAWN_S`. Per-enemy `senseRadius`
(`TUTORIAL_ENEMY_SENSE_M`) clips sight, hearing, lures, alert propagation and faction targeting; `homeLeash`
(`TUTORIAL_ENEMY_LEASH_M`) returns them home and stops patrolling. Checkpoints release zones (`crawl` → bugs, `supply` or a
cliff fall → humanoids above the player by `TUTORIAL_AGGRO_DROP_M`). On liftoff there is no flee; humanoids within
`TUTORIAL_LIFTOFF_FIRE_RANGE_M` target the rider for `TUTORIAL_LIFTOFF_FIRE_S`. Both fields are 0 outside the tutorial.

## Rules
- A bug's **6 legs are two `InstancedMesh`** (femur · tibia, 6 instances each) on `rig.body`, not 12 meshes in a group
  chain. `animateBug` composes the matrices itself (`setLegMatrices`), so nothing outside `models/BugModel.ts` may
  expect leg scene nodes; anything that clones a rig's meshes must handle `isInstancedMesh` (`fx/Xray.ts` shares the
  source's `instanceMatrix`). (2026-09-20 — `docs/PERF.md` perf Phase 1.) — `models/BugModel.ts`
- **Mesh detail is a budget, not a per-part choice.** Every sphere a bug body is built from passes through
  `segBudget` → `BUG_MESH_SEGMENTS` (`data/constants.csv`), so the `seg` argument of each `ellipsoid` call says what
  the part *wants* and the csv row says what it gets — raising a `seg` above the budget changes nothing. Bug
  **bodies** only: eggs have their own `EGG_SEG_W` / `EGG_SEG_H`, and `WormModel` · `HumanoidParts` are unbudgeted
  (they were already modest). (2026-09-20 — `docs/PERF.md` perf Phase A.) — `models/BugModel.ts`
- **Humanoid enemies cast shadows the way a soldier does**: trunk · head · legs cast; the visor, the thrown grenade
  and the merged `gunArms` do not — the rifle is a held item and the four arm segments merged into it sit against the
  chest, inside the trunk's own shadow. `mesh(geo, mat, shadow)` in `createRogueRig` is the single switch; a new part
  passes `false` unless it is trunk, head or a leg segment. (2026-09-20 — same phase.) — `models/RogueModel.ts`
- **Animation LOD**: past `ENEMY_ANIM_LOD_HALF_M` a living body re-solves its pose every other frame and past
  `ENEMY_ANIM_LOD_FREEZE_M` not at all (`EnemySystem.poseSkip` → `Enemy.animate(dt, poseSkip)`). Position, facing and
  every timer still run each frame, and a body that is dead, flashing, burning, shocked, flipped or on a wall
  (`navAloft` / `anim.climb`, 2026-09-21) is never skipped.
  Two things a change here has to keep (2026-09-20):
  - **A named rogue is never skipped** (`isNamedAiType`, the same exemption the AI LOD makes). The base bug / rogue
    pose is a function of `anim.time`, which runs every frame anyway, but a **named look file integrates `dt`**
    (`st.age`, `glintHold`, the prone blend, the rotor angle) and carries gameplay: `SniperLook` writes the scope
    glint, the telegraph of a shot the sniper takes out to 320 m. Anything else hung off `animateNamedRig` inherits
    that rule.
  - **The two distances are screen size, not metres.** They were chosen as 「the legs are ~10 cm on screen」, which is
    only true at `CAMERA_BASE_FOV_DEG`, so they are scaled by the camera zoom (`shared/viewZoom.viewZoomK`, one
    `tan` per frame in `update`, clamped to ≤ 1 so a wider-than-base view never pushes the bands out). A scope
    narrows `camera.fov` rather than touching `camera.zoom`. The **AI** LOD is deliberately left in metres — it
    measures what a body can act on, and a scope changes none of that.
  — `EnemySystem.ts`, `Enemy.ts`
- **AI LOD**: past `ENEMY_AI_LOD_HALF_M` a body's whole AI + movement tick runs every other frame and past
  `ENEMY_AI_LOD_QUARTER_M` every fourth (`EnemySystem.aiSkip` → `updateEnemyAI(e, dt + e.aiDebt, this)`). Three
  things make it safe, and a change to any of them has to keep all three:
  - **The distance is to the nearest *anchor*, never to the camera** (`EnemySystem.collectAiAnchors`): the camera
    plus every present player, android, aggroable drone and the rover. A host simulates bugs fighting a squadmate
    200 m from its own camera; a camera-only gate would make that squadmate pay for the LOD.
  - **The skipped frames' `dt` is carried, not dropped** (`Enemy.aiDebt`), so speed, cooldowns, attack cadence and
    every timer come out the same. What a reduced body loses is one tick of reaction — and the near band is wider
    than the longest reach of anything the LOD applies to (`ARTILLERY_AI maxRange` 98 m; `ARTILLERY_RANGE` 63 is
    only the distance it *stands* at, and it fights while approaching out to 88 m), so **a body that can fight
    anyone is never reduced**. The one longer reach in the game is a named sniper's 320 m, and a named rogue is
    excluded outright.
  - **Bodies carry a fixed phase** (`Enemy.aiPhase`, 0..3 handed out per spawn) so the far half of the list spreads
    across the cycle instead of landing on one frame and making its own spike.
  - **A tick has a ceiling** (`ENEMY_AI_LOD_MAX_STEP_S`, tested against the tick a skip would *build* —
    `aiDebt + 2 × dt`). Carrying the `dt` keeps every timer right but not what happens **once per tick** — one
    shot, one steering decision, one gravity step — so the LOD weakens by itself as frames lengthen: the quarter
    band survives at 60 fps, only the half band at 30, and **nothing at the engine's `MAX_DT` of 50 ms**, which is
    where a headless smoke sits (so the smokes exercise the full-rate path and the perf harness exercises this one).

  Never reduced wherever it stands: the tutorial, a corpse still falling, a body in the air (leap · spat · flip), a body
  on a special link (`navTrav !== 0` — it moves by the tick) and a named rogue. — `EnemySystem.ts`, `Enemy.ts`
- **One camera read per frame**: `EnemyHost.camPos` is stamped at the top of `EnemySystem.update` and is the ear and
  the eye for everything in the folder that needs one — the AI LOD, the animation LOD and the footstep range gate
  (`model.emitEnemyStep`, whose host type is `model.StepHost` so a replica satisfies it too). It is valid for the
  current frame only. — `EnemySystem.ts`, `model.ts`, `ai/EnemyAI.footfall`, `net/Replica.ts`
- Bodies are pooled; spawn only through `Pool.acquire` / `spawn` / `spawnRogue` (threat hp multiplier, egg size and corpse lifetime are applied there) — `parts/Pool.ts`.
- `bug_egg` is a **prop with hit points**: `Enemy.isCombatant` is false for it, which is the single switch that keeps it out of
  `Pool.aliveCount` (ambient / wave / sandworm caps), `Pool.ensureCapacity` recycling (plus an explicit `isEgg` guard — an egg's
  spot belongs to the world and must not be reclaimed), `ArtilleryPack.hasBugSupport`, `Targets`' faction scan (`asTarget.isDead`),
  `parts/Alerts` (`alertNear` · `alertShot` · `onWorldNoise` · `pickTarget`), `parts/Damage.pushBack` (= knockback immunity) and the
  nest refill count. `raycastEx` / `explode` gate on `state === 'dead'` only, so it is still shot and blown up. It never becomes
  aware (`takeDamage` / `applyDot` / `becomeAlert` all refuse) and never ticks AI (`updateEnemyAI` returns on the first line).
  New code that counts "living enemies" must use `isCombatant`, not `state !== 'dead'` — `Enemy.ts`.
- Other folders ask two different questions and get two different answers. `getEnemies()` returns **everything**, eggs included
  (they must be shootable and lootable), so a caller reading it as "threats" filters on `EnemyRef.isEgg` itself —
  `ui/hud/Pings`, `ui/hud/Detection` and `allies/parts/Commands` do. `queryNear(pos, radius)` instead **leaves props out by
  default** (`includeProps` opts back in): every one of its callers is picking a target or asking "is something dangerous
  here" (turret targeting, mine contact, android sensing / re-targeting, the ally contract ping, recon reveal, barrier
  contact, compass ticks), so the safe answer is the default one and nobody has to remember. A query whose answer is
  "everything this blast touches" passes `includeProps: true`.
- `bug_egg` is the only type whose `EnemyStats` is a **per-instance copy** (`Enemy` constructor) — nest egg spots vary 0.35–0.7 m
  and the hit capsule must match the drawn body. Never mutate `ENEMY_STATS` rows for any other type.
- `parts/` import only types from `EnemySystem.ts`; shared values go in `model.ts` (circular import).
- Tutorial enemy types reuse the base type's rig/AI/sound tables via `baseTypeOf`; never add rows to those tables — `EnemyTypes.ts`.
- `ai/RemoteFx` and replica hooks must not change game state; only the authority decides damage and spawns.
- Humanoid vs bug checks use `isHumanoid`, not `isRogue` — `Enemy.ts`.
- Keep drones, the rover and the androids out of `TargetList.all` / `alive`; paths that need them read `drones` /
  `vehicles` / `allies` — `Targets.ts`. `alive` is "the humans", and the raid-failure rule counts humans only.
- Every android proxy's `TargetId` is `'ai'` (like drones / the rover): the identity is `CombatTarget.allyId`, so no
  `dmg` message can ever be addressed to one — `Targets.ts`, `parts/Damage.applyDamage`.
- Enemies damage androids only on the authority, only through `ctx.allies.damage` (`parts/Damage.allyDamage` /
  `damageAlliesAt`); replicas apply nothing (the host's `ally state` carries the hp).
- The world half of cover selection lives in `shared/cover.ts` — do not re-implement it here; enemy-only judgements go
  into the score hook of `ai/RogueCover.ts` (module-level function, no per-frame closure).
- Drone blast damage is added at each enemy blast site (`ctx.drones.applyExplosion`), not inside `explode()`: player and
  gadget explosions (and replica `explode` requests) also pass through `explode()` and would hit drones twice — `parts/Attacks.ts`.
- Only enemies and hazards damage the rover: never add a vehicle path to `explode()`, `applyAreaDamage` or `hit`, which
  carry player weapons, gadgets and ship calls — `parts/Damage.ts`, `Targets.ts` (`damageVehicleAt`).
- Rover damage folds to attacker `'ai'`; no `'rover'` id may reach kill credit or contracts — `Enemy.takeDamage`.
- A lootable/fall-direction roll must never draw from the `rollCorpse` rng (`src/inventory/__selftest__.ts` pins it) — `Corpses.ts`.
- Corpse preview (drone scan) and opening must use the same seeded roll and inputs — `shared/lootRolls`, `ee corpse`.
- Visibility-based sight to a vehicle stops short of its own collider (`VEHICLE_RAY_MARGIN`) — `ai/Perception.ts`, `ai/FireLine.ts`.
- No lights on enemies or FX; glows are emissive (`smoke-lights` enforces a constant light count).
- `game:newMission` resets only if the world has not already generated for that seed (world emits `world:ready` first) — `EnemySystem.ts`.
- Sniper fires only after the glint; blocked muzzle before a glint relocates instead — `ai/named/Sniper.ts`.
- **Intended**: the `investigate` state is host-only, so it disappears on host transfer; the promoted host also does not
  inherit corpse registrations that were still pending.
- **Intended**: humanoid squad roles stop at the flanker (`squadRole 'flanker'`) — no low-hp retreat, no boss health HUD,
  no faction-clash HUD.
- **Intended**: corpse lootability is rolled per corpse at the moment of death (seeded), so several unlootable corpses can
  come in a row. — `Corpses.ts`
- **Intended**: tutorial enemies do not know about the cliff holes — their walk only samples `getSurfaceY` and has no fall,
  so crossing an edge teleports them to terrain (−100). `tutorialHold` returns an enemy that dropped 20 m below its spot;
  there is no edge-avoiding steering. — `Tutorial.ts`
- **Intended** (2026-09-15): the sandworm appearance check is the host's cumulative random roll — not seed-reproducible,
  and replicas only receive the result. An android squadmate counts toward the qualifying head count only after it picks
  something up in the raid (its base kit is `normal`, the same threshold as a human). — `sandworm/Director.ts`
- Known limits of empty-corpse removal (2026-09-16): an `ecorpseq` request lost during host transfer leaves that corpse on
  the 45 s lifetime; corpses in the ship bay or on the tram sink through the deck; a client that cannot resolve an item id
  in the spawn wire (version mismatch) removes that corpse locally only. — `parts/CorpseEmpty.ts`
- Known limit (2026-09-17): a hunter flipped while riding a tram skips `integrate`, so it does not ride — it stays at its world spot
  until it rights itself. — `ai/HunterFlip.ts`
- **Intended** (2026-09-18): the nest leash, `Enemy.nestOf` and the artillery's prep / squad state are host memory with no wire, so a
  host change releases them (the same call the escort links already made). The refill **budget** is re-rolled from the world seed by
  whoever is host, so the new host gets the same numbers but not the spent count — a nest can refill more often across a takeover.
- Known limits of the nest eggs (2026-09-18) — `NestDirector.ts`, `models/EggModel.ts`:
  a raid holds one egg body per spot (2–5 per mound × 4–6 mounds × 4–6 pads), so a busy map carries a few dozen extra pooled bodies
  and draw calls — they are excluded from AI and from every head count, and an undamaged egg draws once. The corpse interactable
  still reads 「시체 수색」 (the shared label). Replicas recover an egg's size by looking up the nearest spot of the world they built
  themselves; a client whose world disagrees with the host's would draw a differently sized egg (it cannot, worlds are seeded).
  Environmental hazards deliberately do **not** damage eggs (`parts/Status.updateHazardDot`) so a nest's reward never evaporates
  before the player reaches it; fire zones and other attacker-owned damage still burn them.

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **Rogue AI: no low-HP retreat, no boss HP bar** (Phase 7).
- **Big-enemy spawn clearance by radius** (`ENEMY_BIG_RADIUS`). Rejected: a per-species csv column (new species just work).
- **Humanoid looks = the shared rogue rig + skins.** Rejected: new rigs per faction.
- **Hunter drops on 20 cumulative damage during one leap.** Rejected: a single-hit threshold (an AR bullet is 17).
- **Artillery spawns with its own scavenger escort, re-summoned once all are dead, and shells only after a 포격 준비 beat with a bug
  near the target.** Rejected: joining nearby packs; requiring a scout's shared line of sight (it would almost never fire).
- **Cell drops replace every sample row** of the big bugs. Rejected: replacing cell rows only, adding on top.
- **Nest eggs are immobile enemies** (`bug_egg`) and are the nest's reward; the lost crates are not replaced. Rejected: fewer eggs
  with more HP; one big 알집; raising other crate rings to keep the old count.
- **Nest leash 60 m.** Rejected: 40 m (one cover break would shake them).
- **Sandworm: a cumulative chance checked every 2 s, at most once per raid, never solo; threat 1 gets a weak worm.** Rejected: a
  seeded pre-roll with a time window.
- **Wall climbers and window crawlers = scavengers only** (A-18 phase 2, csv `nav`). Rejected: + toxic, + hunter.
- **Indoor pathing = scavenger · toxic · hunter + every humanoid.** Rejected: warrior · spewer too (they wedge in a 1.7 m stair
  flight, so they stand at the wall as before); a ground-floor-only rule.
- **A chokepoint passes 2 bodies at a time** (`NAV_GATE_CAPACITY`). Rejected: 1, 3.
- **Flow fields for chase goals + rate-limited private A-star for everything else.** Rejected: per-enemy A-star for all (sixty
  searches for one player); flow fields only (a nest, a cover spot, a shot origin are not shared goals).
- **`STRUCT_DAMAGE_MUL` and `NEST_LEASH_M` keep their values** now that bugs come in through doors. Rejected: raising the gnaw
  multiplier; a path-length leash.
- **Enemy AI LOD = distance to the nearest anchor, not the camera; animation LOD scaled by zoom, AI LOD not** (perf,
  `docs/PERF.md`). Rejected: time slicing; freezing the far band; 25 / 50 m animation bands.

## Recent changes

Last 5 only — older: `git log -- src/enemies`.
- 2026-09-21 — TODO A-18 phase 2: enemies **use** the nav graph. `ai/NavMove.navSteer` is one call in front of `integrate`'s `seek` — a chase goal (a person target) reads the target's shared flow field, a private goal (nest · shot origin · wander · cover · lure · enemy target) a private `findPath` capped at `ENEMY_NAV_PLANS_PER_FRAME` for the whole pool; circle avoidance is off while a graph point steers; stuck → off for `ENEMY_NAV_OFF_S`. `ai/Gates`: `NAV_GATE_CAPACITY` tokens per chokepoint, recounted from the living bodies twice a second, queues reported with `setGateLoad`. `ai/Traverse`: ladder · wall climb · window crawl (breaks the pane first) performed off the colliders as an atomic gate after the hunter flip, one body at a time into a link's mouth; hints 26 · 27 · 28 + `anim.climb` lay a bug along the wall on authority and replica. Types with `navCan === 0` (warrior and larger) never reach any of it. Debug: `debugNav` · `debugNavOf` · `debugTraverse`.
- 2026-09-20 — Two side effects of the perf work, both confirmed in a running game before being touched (`scripts/smoke-named.mjs`): the animation LOD **never skips a named rogue** (`poseSkip` → `isNamedAiType`, the exemption `aiSkip` already made) — `animateNamedRig` is only called from `animateRig`, and a named look file integrates `dt`, so past 80 m the sniper's scope glint (the 1.4 s telegraph of a 150-damage shot it takes out to 320 m) was never drawn at all and a replica's `ee glint` hold was never spent; and both LOD distances are **screen size, not metres** — they are scaled by the camera zoom (`shared/viewZoom.viewZoomK`, one `tan` per frame, clamped to ≤ 1), because a scope narrows `camera.fov` and an 8× scope draws a body at 100 m the size it has at ~12 m. `SniperLook` reads the same helper instead of its own copy of 70°. The AI LOD is deliberately left in metres.
- 2026-09-20 — `docs/PERF.md` perf Phase C (finding B4 · B5): AI LOD — a body farther than `ENEMY_AI_LOD_HALF_M` (110 m) from every **anchor** (camera · players · androids · drones · rover, `collectAiAnchors`) ticks every other frame and past `ENEMY_AI_LOD_QUARTER_M` (140 m) every fourth, carrying the skipped `dt` in `Enemy.aiDebt` and spreading over the cycle by `Enemy.aiPhase`, and never building a tick longer than `ENEMY_AI_LOD_MAX_STEP_S` (0.08 s — under a rogue's 0.12 s `shotGap`, so the LOD fades out as frames lengthen and is fully off at the engine's 50 ms `MAX_DT`); never the tutorial, a falling corpse, a body in the air or a named rogue. S2 `u:enemies` 0.99–1.02 → 0.85–0.86 ms/frame, twice per side — and the census that explains the size of that: S2 is **60 bodies at full rate and 100 beyond 140 m**, so the LOD can only ever reach the far third of the cost. Footsteps read `EnemyHost.camPos` instead of a `getWorldPosition` per call (`model.StepHost`).
- 2026-09-20 — `docs/PERF.md` perf Phase A (the first change in that plan to move the render block): every sphere of a bug body passes through `segBudget` → `BUG_MESH_SEGMENTS` (12), so a thorax is 12×8 instead of 18×13 and S2 carries 930k triangles instead of 997k; humanoid enemies cast shadows the soldier's way (trunk · head · legs — not the visor, the grenade or the merged `gunArms`), 9 shadow draws each → 7. S2 `x:rendererRender` 7.29–7.75 → 6.75–6.77 ms and js/frame p50 10.2–10.9 → 9.7–9.9, twice per side.
- 2026-09-20 — A bug's 6 legs are two `InstancedMesh` (femur · tibia) whose matrices `animateBug` composes itself, so a bug is 7–8 draws instead of 17–18 and 30 scene nodes lighter (`models/BugModel.setLegMatrices`; `fx/Xray` clones an instanced source sharing its `instanceMatrix`). Animation LOD: past `ENEMY_ANIM_LOD_HALF_M` (40 m) a living body poses every other frame, past `ENEMY_ANIM_LOD_FREEZE_M` (80 m) not at all — never a dead, flashing, burning, shocked or flipped one (`EnemySystem.poseSkip`).
