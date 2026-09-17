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
| `Targets.ts` | `CombatTarget` (player / enemy / drone / vehicle / android proxy) and `TargetList` (`all`, `alive`, `drones`, `vehicles`, `allies`, nearest queries, `damageVehicleAt`) |
| `Spawner.ts` | `AmbientSpawner` (initial population, patrols, artillery dig-in), group composition from planet ecosystem, spawn clearance (`spawnBlocked`), `threatEcosystem`, `ambientCap` |
| `SiteGroups.ts` | `placeSiteGroups`: humanoid groups at labs / outposts / rail platforms / ruins by planet threat |
| `RogueDrop.ts` | `RogueDropDirector`: raider drops after structure investigation (two waves, pods, landing spawns) |
| `RogueGuards.ts` | `RogueSpawnHost` contract only; `placeRogueGuards` / `guardCap` / `MAX_GUARDS` are retired no-op names |
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
| `ai/ArtilleryPack.ts` | Artillery escort (`spawnArtilleryEscort`, `escortFollow`), fire condition (`hasBugSupport`), once-per-artillery summon (`maybeSummon`) |
| `ai/Investigate.ts` | Investigation state after an unattributed shot or noise |
| `ai/Structures.ts` | Biting / spitting at player deployables in the way |
| `ai/Lures.ts` | `LureField` noise beacons |
| `ai/Ride.ts` | Enemy / corpse tram riding via `shared/ride.ts`; replica prediction |
| `ai/Burrow.ts` | Emerge / spat-flight gate (no attack or move) |
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
| `scavenger_summon` | bug | Scavenger an artillery summons once at a lone target in range: scavenger stats / rig / AI / sounds (`baseTypeOf`), `CORPSE_LOOT_CHANCE` 0 (no drops) |
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
  16/17 hammer windup/charge · 18/19 heavy spin/fire · 20 scan pulse · 21/22 worm spit/acid · 23/24 hunter flipped falling/lying · 25 artillery braced flat (`net/HostSync.animHint`).
- Debug on `getSystem('enemies')`: `debugSpawn`, `debugSpawnNamed`, `debugNamedRoll`, `debugSites`, `debugEcology`,
  `debugBugTuning`, `debugAmbientGroup`, `debugWaveGroup`, `debugSandworm`, `debugSandwormState`, `debugSandwormChance`,
  `debugSandwormClearOnce`, `debugSpawnBurrow`,
  `debugTutorial`, `debugDroneTargets`, `debugSnapshot`, `debugApplySnapshot`, `debugHint`, `debugGrenade`, `debugShell`,
  `debugXray`, `debugSetDropSquad`, `debugDropWaves`, `debugAllyTargets` / `debugAllyTargetList` / `debugCoverSpot`,
  `debugEmptyCorpse`, `hitGuardStats`, `isAuthority`, `isTrainingWorld`, `isTutorialWorld`.

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
- `world:ready` (authority, not training/tutorial): `AmbientSpawner.initialPopulate` → `placeSiteGroups(seed, threat)` →
  `named.roll(planet)`. The sandworm director rolls on every client. Training: no enemies at all.
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
  `docs/DECISIONS.md` 「2026-09-15 — 땅굴벌레」): **no pre-roll, no time window, at most once per raid**. The host checks
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
- Bugs: `idle → wander → alert → chase → attack → stagger`, `dead` / `flee`; artillery, toxic, behemoth in `GimmickAI`.
- Artillery (2026-09-17, `ai/ArtilleryPack.ts` + `GimmickAI`): `maxArtillery` (+ `ARTILLERY_CAP_BONUS_BY_THREAT`) is a **live** cap —
  every not-dead artillery counts (`Pool.countAlive`), a killed one frees its slot. Dig-in brings `escortMin`–`escortMax` scavengers
  (`escortOf`) that wander around it and run back beyond `escortFollowDist` until they notice a target, then fight normally. It fires
  only when a non-artillery bug stands within `supportRadius` of its target: brace flat `braceTime`, fire, then no movement for
  `postFireLock` (also outside `chase`). A person target in `maxRange` with no bug near it triggers a **once-per-artillery** summon of
  `summonMin`–`summonMax` `scavenger_summon` (relentless, locked on that target). **Intended**: escort links and `summonDone` are host
  memory only — after a host change escorts become plain bugs and a surviving artillery may summon once more.
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
- Bodies are pooled; spawn only through `Pool.acquire` / `spawn` / `spawnRogue` (threat hp multiplier and corpse lifetime are applied there) — `parts/Pool.ts`.
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
  something up in the raid (its base kit is `normal`, the same threshold as a human). — `named/Director.ts`
- Known limits of empty-corpse removal (2026-09-16): an `ecorpseq` request lost during host transfer leaves that corpse on
  the 45 s lifetime; corpses in the ship bay or on the tram sink through the deck; a client that cannot resolve an item id
  in the spawn wire (version mismatch) removes that corpse locally only. — `parts/CorpseEmpty.ts`
- Known limit (2026-09-17): a hunter flipped while riding a tram skips `integrate`, so it does not ride — it stays at its world spot
  until it rights itself. — `ai/HunterFlip.ts`

## Recent changes

Last 5 only — older: `git log -- src/enemies`.
- 2026-09-17 — Artillery: `maxArtillery` stays a live cap but `Pool.countAlive` now counts incapacitated / fleeing bodies (a burning or fleeing artillery let a second dig in); 2–3 scavenger escorts follow it until they notice a target (`ai/ArtilleryPack.ts`, `Enemy.escortOf`, not recycled while it lives); fires only with a non-artillery bug within `supportRadius` of the target; brace flat `braceTime` → fire → `postFireLock` (`Enemy.shellPhase`, `anim.brace`, hint 25); once-per-artillery summon of `scavenger_summon` (new type, 0 % drops) at a lone target in range.
- 2026-09-17 — Global 1/3 rebalance: every `enemies.csv` hp ÷3 floor (raidXp unchanged; `sandworm_weak` raidXp literal 75), `SANDWORM_HP_MIN/MAX` 666/1000, `SANDWORM_WEAK_HP` 250, `TOXIC_DAMAGE` 60; enemy → enemy damage × `ENEMY_CLASH.damageMul` (1/3; hazards exempt), `BEHEMOTH_AI.enemyDamage` 53, `tut_android*` hp 30; toxic on threat 1–2 planets; hunter leap 10–18 m · 1.55 s · cooldown 12 · `arcGravityMul`, red stripes, mid-leap flip (`ai/HunterFlip.ts`, hints 23/24).
- 2026-09-16 — Emptied enemy corpses held while anyone views them (`Enemy.corpseReleased`, `CorpseEmpty.hookCorpseViews` / `updateEmptyCorpses`, `ee corpseEmptied` at release); tutorial enemies never step within `TUTORIAL_ENEMY_EDGE_MARGIN_M` of a cliff (`tutorialEdgeGuard`).
- 2026-09-16 — Emptied corpses sink away: `parts/CorpseEmpty.ts`, `Enemy.corpseEmptied` / `corpseFadeS`, `ee corpseEmptied`, `ecorpseq emptied` host guard (`hitGuardStats.corpseEmptyRefused`), `debugEmptyCorpse`.
- 2026-09-16 — Bug audio: `burrow_emerge` per bug (batch 1/√k, `parts/Burrow.emergeSound`); bug `STEP_VOICES` rows use `bug_step_skitter` / `_heavy` / `_giant` with a short camera gate and 1/√n crowd gain (`model.bugStepCrowd`); shell whistle lives in audio/.
