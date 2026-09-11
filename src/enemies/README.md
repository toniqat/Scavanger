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
| `model.ts` | 폴더 공용 어휘 — 상수 · 타입 · 스크래치 벡터. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. **2026-09-11**: 적 타입별 소리 표 `stepSound` · `meleeHitSound` · `hurtSound` 와 발소리 방출 `emitEnemyStep`(C-51 · C-23 · C-22), 리플리카 넉백 요청 상한 `MAX_REQUEST_KNOCKBACK`(C-1) |
| `ai/Ride.ts` | **2026-09-11 (C-18)**: 적 · 적 시체의 차량 탑승. 플레이어와 같은 `shared/ride.ts` 규약 — 진입만 `getStandingObstacle` 의 `velocity` 발판, 유지는 차량 OBB + 헤드룸(`rideContains`), 이동은 지난 프레임 자리를 차량 로컬로 적어 두었다가(`rideRecord`) 이번 프레임 차량의 **지금** 변환으로 풀어 차이만 더한다(`rideCarry`). `carryCorpse` = 시체(땅에 닿은 몸만, 벗어나면 `deathLanded` 를 풀어 떨어뜨림). `replicaRidePredict` = 리플리카가 보간 지연 × 차량 속도만큼 앞당겨 그린다(`rideBlend` 로 섞음) |
| `parts/Damage.ts` | **적이 피해를 입는 모든 경로.** 히트스캔 · 폭발 · 광역 · 리플리카의 `hit` 요청이 전부 여기로 모여 `applyDamage` 하나로 수렴하고, 죽으면 시체 등록(`registerCorpse`, `CORPSE_LOOT_CHANCE` 추첨)까지 이어진다. 배리어 판정(`resolveBarrier` / `absorbedByShield`)도 여기 있다 — 방패는 **적을 막는 벽**이자 정면 근접을 대신 받는 면이라 피해 경로의 일부다. |
| `parts/Attacks.ts` | **적이 하는 공격.** 산성 침 · 로그의 총 · 포병 포탄(요격 가능) · 로그 수류탄 · 독성 자폭. 전부 **호스트에서만** 결정되고 결과가 `ee` 이벤트로 나가며, 각 클라이언트는 `parts/RemoteFx.ts` 에서 연출만 재생한다. **2026-09-10**: `fireShell` 이 `boolean` 을 돌려준다 — 풀이 꽉 찼거나 새 `shellArcBlocked` 가 궤적을 막힌 것으로 읽으면 `false`(발사도 `sid` 소모도 없다). `shellArcBlocked(world, from, target, flight)` 는 궤적의 앞쪽 `SHELL_ARC_CHECK_FRAC`(0.75)를 `SHELL_ARC_SAMPLES`(4)개의 현으로 나눠 `world.raycast` 한다: 현은 포물선 **아래**를 지나므로 검사는 보수적이고(뚫린 것을 막혔다고 볼 수는 있어도 그 반대는 없다), 마지막 하강 구간은 조준점이 땅이라 무조건 걸리므로 일부러 보지 않는다. 발사 시점(포 하나가 6~9초에 한 번)에만 도는 4회 레이캐스트라 핫 패스가 아니다. **2026-09-11**: 로그의 총알이 첫 표면인 **창문 유리**(`Obstacle.fragile`)를 깬다. |
| `parts/Alerts.ts` | **적이 무엇을 눈치채는가.** 소리(총성 · 유인탄) · 시야 · 팩션 충돌 · 그리고 Phase 12 의 **총알 추적**: 감지 범위 밖에서 날아온 총알의 발사 지점을 향해 돌아서서(`alertShot`) 그 방향 감지를 넓히고, 못 찾으면 전진한다. 표적 선택(`pickTarget`)과 도주(`fleeFrom`)도 같은 인지 계통이다. |
| `parts/Status.ts` | **상태이상: 화상 · 전소 · 감전 · 둔화, 그리고 정찰 스캔의 x-ray 실루엣.** 호스트가 상태를 소유하고 `EnemyWire.sb` 비트로 리플리카에 미러링한다. 리플리카는 직접 걸 수 없으므로 `hit {dmg:0, st, dur}` 로 **요청**한다(`requestStatus`). DoT 처치의 킬 크레딧은 불을 놓은 사람에게 간다. |
| `parts/Pool.ts` | **적 인스턴스 풀.** 적은 생성/파괴하지 않고 고정 풀에서 빌려 쓴다(`acquire` / `release`) — 프레임당 할당을 피하려는 것이고, 그래서 id 재사용 규칙(`find`)과 용량 확장(`ensureCapacity`)이 한곳에 있어야 한다. 미션 리셋(`reset`)과 지오메트리 dispose(`disposePools`)도 이 파일의 책임이다. |
| `parts/RemoteFx.ts` | **리플리카에서 재생하는 연출.** 비호스트 클라이언트는 AI 를 돌리지 않는다. 호스트가 보낸 `ee` 이벤트(피격 · 산성 · 포탄 · 돌진 · 시체 · 수류탄)를 받아 여기서 **그림과 소리만** 만든다. 게임 상태는 하나도 바꾸지 않는 것이 이 파일의 계약이다. |
| `Targets.ts` | `CombatTarget { id: PeerId \| 'local' \| 'ai'; position; velocity; isDead; downed; isDeadOrDowned; present; yaw; eyeHeight; enemy; suspended; getEyePosition/getForward/getChest/dist2D; bodyRadius/bodyHeight }` — a stable object per player, plus one per enemy (`Enemy.asTarget`, `id 'ai'`, `enemy` set, synced by the system). `TargetList.refresh(ctx)` rebuilds `all` / `alive` each frame from `ctx.player` plus `ctx.net.getRemotePlayers()` filtered to `connected && !(stale && !suspended) && !DROPPING` (Phase 7: a **suspended** member — socket down, slot kept — stays a target; its position / hp / downed / dead come from the host's ghost through the same ref, `CombatTarget.suspended` routes damage to `ghost:damage`); `downed` = `player.isDowned` / `r.isDowned \|\| flags & DOWNED`. `alive` = present && !dead && !downed (the only players the AI may target or damage); `all` also holds downed and dead bodies (separation, `minDist`, spawn-distance checks). Enemy proxies are **not** in the list — `EnemySystem.pickTarget` scans `active` instead. Queries: `nearestAlive`, `nearestAliveWithin`, `minDist`, `distToLocal`, `randomAlive`, `randomPresent`, `local`, `anyAlive`. |
| `Enemy.ts` | Entity implementing `EnemyRef` (`faction` getter, `isRogue`, `isCombatant`). Holds gameplay state (hp, state machine fields, timers, charge/leap/spit phases, cached obstacles), `target: CombatTarget \| null` + `targetTimer` + `distToTarget`, `lastDamager` (kill credit), `lastLocalHit` / `netBuf` (replica), Phase 4 memory (`roguePhase`, `guardPos`/`leash`/`escortOf`, `coverPos`, burst timers, `weaponId`; `shellTimer`/`dug`; `toxicPhase`/`swellTimer`; `chargeSeq`/`chargeEnd`/`chargeVictims`/`hitByCharge`; `corpseLife`) and the rig (`EnemyRig = BugRig \| RogueRig`) + `BugAnim`. `takeDamage(amount, hitPoint?, hitDir?, attacker = 'local')` classifies the hit (`head` / `rear` / `front`; behemoth `isFrontPlate(point)` → `front`), applies per-type multipliers, hit-flash/flinch, stagger (never for a swelling toxic), death; a popped-out rogue that gets hit ducks (`hitCrouchTimer`); on a replica it stops after the visuals and calls `host.requestHit`. `muzzle(out)` = rifle tip (rogues). `animate()` syncs the rig every frame (`fade` over the last 3 s of `corpseLife`; Phase 7 blends `anim.reload` / `anim.throwing` from `reloadTimer` / `throwTimer`). Phase 7 rogue memory: `magRounds`, `reloadTimer`, `grenadeCd` (staggered at reset), `noLosHold`, `throwTimer`, `grenadeTarget`, `popPos` / `hasPop`; `enterStagger` / `kill` drop a wind-up. `EnemyHost` interface lives here (`throwGrenade` appended). **Phase 10**: `kill(countKill, dir?)` carries the live `vy` into `deathVy` **before** clearing `airborne` (clamped to `CORPSE_FALL_MAX_SPEED`), picks `deathDir` from its own seeded stream (`rollDeathDir`, `worldSeed ^ id·0x85ebca6b`) unless the wire supplies one, and decides `deathLanded` on the spot (a normal ground kill lands in the same frame, so its corpse still registers immediately); `lootable` / `corpsePending` are the Phase 10 corpse fields and `animate` drives `BugAnim.deathFall` from `deathTimer / DEATH_FALL_TIME`. **2026-09-10**: `EnemyHost.fireShell` 이 `boolean` 이 되었고(거절 = 궤적이 막혔다), 총구 사선 캐시 5개(`fireLineAt` / `fireLineClear` / `fireLineGap` / `fireBlockTimer` / `fireStrafeSign`)가 붙었다 — `reset` 에서 초기화되고 `fireStrafeSign` 은 무작위라 한 분대가 전부 같은 쪽으로 비켜서지 않는다. |
| `EnemyTypes.ts` | `ENEMY_STATS` table (with `faction`) plus ability tuning `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`, `ROGUE_AI`, `ARTILLERY_AI`, `TOXIC_AI`, `BEHEMOTH_AI`; `BugType` (rig type), `isRogueType`. |
| `RayTests.ts` | Allocation-free `raySphere`, `rayCapsule`, `rayStandingCapsule` shared by hit detection, rogue shots and shell interception. 2026-09-11 (C-55): `raySegmentCapsule` (any-orientation capsule — the prone sniper's lying body) + `closestOnSegment` (its hit normal). |
| `SpatialGrid.ts` | Allocation-free uniform XZ hash grid, rebuilt per frame, used for separation queries. |
| `Spawner.ts` | `AmbientSpawner` (threat 0..1 → cap `12 + 24·threat`, patrol every 12–25 s from nests 60–140 m around a random alive player — or a random present body via `randomPresent` when everyone is downed — initial population on `world:ready`; from threat 0.5 `maybeArtillery` digs one in 80–120 m out, ≤ `MAX_ARTILLERY` alive), spawn helpers `findSpawnCenter`, `isVisibleToAnyPlayer`, `spawnGroup`, compositions `ambientGroup` (toxics from threat 0.4) / `waveGroup` (toxics from wave 2, a behemoth from wave 3), and the `SpawnHost` interface (`targets`, `countAlive`). Phase 7: `resume()` restarts the trickle mid-mission after a host promotion with a normal-length gap. **Phase 11**: `AmbientSpawner.eco` (the 목표 행성's `PlanetEcosystem`) — `cap` is `ambientCap` (`× eco.pressure`), the artillery ceiling is `maxArtilleryOf` and a planet whose `eco.bugs` has no artillery digs none in; `ambientGroup(threat, eco)` / `waveGroup(index, count, eco)` keep the whole ladder (same rolls, same probabilities, same gates in `AMBIENT_GATE` / `WAVE_GATE`) and only draw each slot's silhouette from `eco.bugs` inside its power tier (`TIER_FILLER` / `MEDIUM` / `HEAVY` / `RUNNER`). `eco === null` → every helper returns the pre-Phase-11 answer verbatim. **2026-09-09**: `needsSpawnClearance(type)` / `spawnBlocked(world, type, x, z)` (exported) + the private `placeMember` — a body of radius ≥ `ENEMY_BIG_RADIUS` re-rolls its offset (up to `ENEMY_SPAWN_RETRIES`, widening the ring each try) while `world.obstacleCoverage(x, z, radius × ENEMY_SPAWN_CLEARANCE_MUL)` exceeds `ENEMY_SPAWN_BLOCK_RATIO`, and is **skipped entirely** if none works (never downgraded to a smaller type). `spawnGroup` is the single funnel for ambient / wave / nest groups; `maybeArtillery` repeats the check because it calls `host.spawn` directly. |
| `RogueGuards.ts` | `placeRogueGuards(host, seed)` on `world:ready` (authority): squads of 2–4 rogues 6–12 m around every tier-3/4 crate and 30 % of tier-2 crates (> 45 m from the player spawn), ≤ `MAX_GUARDS` (16) in total; one random tier-3/4 crate gets the `rogue_boss` + `ROGUE_BOSS_ESCORTS` escorts (leash to the boss). Seeded by the world seed; rifles from `ROGUE_AI.weapons` (boss `ROGUE_AI.bossWeapon`). `RogueSpawnHost.spawnRogue`. Guards are not waves and are never recycled by `ensureCapacity`. **Phase 11**: `placeRogueGuards(host, seed, eco)` — `guardCap` = `MAX_GUARDS × eco.rogues` (0 = a planet with no raiders, placed without touching the rng), the tier-2 share is `0.3 × eco.rogues`, and on an `eco.boss === false` planet the boss squad only appears when the seed rolls `ECO_BOSS_CHANCE`. Still fully seeded: same seed + same planet = same placement. |
| `WaveDirector.ts` | Extraction waves: first wave 3 s after activation, then every 14 s → 9 s; size 6, 8, 10 … (≤ 22) **× `WAVE_SQUAD_SCALE[분대 인원 − 1]`, 최소 2마리** (2026-09-10 — 표는 4인 분대 기준이고 `squadSize(host)` 가 `RogueDrop` 과 같은 계산으로 인원을 센다), split into 1–3 groups spawned 45–90 m from the target, facing the nearest alive player; pauses while nobody is alive. A behemoth over the cap becomes a warrior (**Phase 11**: the cap is `maxBehemothOf(eco)` — 0 on a planet with none — and the count now includes behemoths rolled earlier in the same wave; `WaveDirector.eco` also feeds `waveGroup`). Emits `enemy:waveStarted`. Alive cap 60. Authority only. Phase 7: `prime(index)` — the next `start` (re-requested by extraction/ after a host promotion) continues the escalation from that wave index with a ≤ 6 s gap instead of restarting at wave 0. |
| `RogueDrop.ts` | **로그 강하** (2026-09-09). `RogueDropDirector` — `structure:investigated` 를 받아 **호스트만** 구역당 1회 `ROGUE_DROP_CHANCE` 를 굴리고(`worldSeed ^ hash(zoneId)` 시드 스트림이라 호스트가 바뀌어도 같은 답), 성공하면 `callRogueDrop(dropId, position)` 이 분대 인원표(`ROGUE_DROP_COUNT_MIN/MAX` · `ROGUE_DROP_BOSS_CHANCE`, index 0 = 1명)로 인원 · 보스를 뽑아 `world.scatterPoints(position, ROGUE_DROP_RADIUS, count, 4.5, seed)` 에 포드를 떨어뜨린다. 예고 → `ROGUE_DROP_ETA_S` → 착지: `rogueDrop:incoming` / `landed` + `rdrop incoming` / `landed`. **2026-09-10 — 알림 · 소리는 이 파일이 내지 않는다**: 포드마다의 착지 충격음 `rogue_pod_impact`(아군 `hellpod_impact` 가 아니다)만 `impactFx` 에 남고, 무전 경보(`rogue_drop_alarm`)와 대기를 찢는 낙하 굉음(`rogue_pod_fall`)은 `audio/AudioSystem` 이 `rogueDrop:incoming` 을 받아 낸다 — 둘 다 **인지력이 아니라 전용 반경 `ROGUE_DROP_ALERT_RADIUS`(260 m)** 로 게이트하고 그 안에서 거리에 따라 줄어들며(원격 발소리와 같은 곡선), 굉음은 착지 `ROGUE_DROP_FALL_LEAD_S` 초 전에 나간다. 화면은 `ui/hud/RaidAlerts` 의 토스트와 `ui/hud/DangerIndicators` 의 위험 표시(화면 안 = 머리 마커 · 밖 = 방향 호, 같은 반경). 착지에서 `host.spawnRogue` 로 `rogue` / `rogue_boss` 를 세우고(`guardPos` = 트리거 지점, `ee spawn` 은 기존 스폰 경로가 낸다) `beginInvestigation(e, 트리거 지점)` 으로 **구조물까지 진격**시킨다 — 도착하면 그 자리를 지키는 기존 가드 순찰로 넘어간다. 구역당 1회 기록은 자체 `used` 집합(리플리카가 받은 `rdrop incoming` 도 넣으므로 승격된 호스트가 다시 굴리지 않는다) ∪ `WorldRef.getStructures()` 의 `StructureDef.rogueDropUsed`; `Pool.reset` 이 레이드마다 비운다. 비호스트는 `rdrop` 을 받아 같은 이벤트를 내고 **포드 연출만** 그린다(적은 기존 `es` / `ee` 리플리카 경로). 포드는 외부 에셋 없이 여기서 절차 생성한 붉은 육각 캡슐(공유 지오메트리 · 머티리얼, `disposeRogueDropAssets`), 낙하 연기 · 착지 `groundBlast` / `dust` / `sparks` 는 `@/core/fx`. `ctx.isTraining()` 훈련장에서는 전부 no-op. |
| `named/Director.ts` | **네임드 로그 스폰 디렉터** (2026-09-11). `NamedRogueDirector` — `world:ready` 권한 분기에서 가드 배치 뒤 `roll(planet)` 한 번: 시드 스트림 `worldSeed ^ hash('named')` 에서 등장(`NAMED_ROGUE_CHANCE_BY_RANK[planetTier − 1]`) → 종류(3종 균등) → 자리를 차례로 뽑는다. 자리는 전부 스폰에서 `NAMED_ROGUE_MIN_SPAWN_DIST` 이상 · 맵 안 · 선로 회랑(`RAIL_CLEARANCE_M` + 4 m) 밖 · 구조물 발자국 밖 · `obstacleCoverage` 로 막히지 않은 곳: 로든 = 개활 · 구조물에서 멀고 둘레보다 높은 후보(스폰을 바라본다), 타길라 = 스폰에서 먼 구조물 둘레 `NAMED_HAMMER.structureRadius` 안 엄폐가 가장 많은 자리(`guardPos` = 구조물), 헤비 = 먼 구조물 · 상자(폐허) 곁 + SMG 호위 `NAMED_HEAVY_ESCORTS_BY_SQUAD[분대 인원 − 1]` 명(`escortOf` = 헤비, `escortRadius` 안). 스폰은 `spawnRogue`(무기 `sr` / `u_minigun` / 없음, 호위 `smg`) → `ee spawn` 그대로. `enemy:namedSpawned` 는 권한이면 스폰 직후, 리플리카면 `enemy:spawned` 에서 id 당 한 번. `reset()` 은 `Pool.reset`. 디버그 `EnemySystem.debugSpawnNamed(type, at?)` · `debugNamedRoll()`. |
| `Corpses.ts` | `Corpse` (`Interactable` `corpse:<enemyId>`, `CORPSE_INTERACT_RADIUS`, `holdTime` 0.6, prompt `시체 수색` → `수색 완료`; `canInteract` = `ctx.isGameplayActive()` && player alive & not downed && `ctx.inventory.openContainerItems` exists; `interact()` rolls once via `ctx.loot.rollCorpse(type, new Random(seed ^ id·φ), weaponId)` and calls `ctx.inventory.openContainerItems(id, items, position, '시체')`; an empty roll counts as searched; **2026-09-08** the first `interact()` also sets the appended `Interactable.hidePillar`, so `ui/hud/Detection` stops drawing this body's 빛기둥 while it stays searchable — deliberately **not** synced, another player looting the same corpse leaves our pillar up and ours never clears theirs) and `CorpseManager` (`add` → `corpse:spawned`, `remove` → `corpse:removed`, `markLooted(containerId)` from `crate:looted`, own `CORPSE_LIFETIME` safety timer, `clear`). Contents are per-client like crates. **Phase 10**: `rollCorpseLootable(seed, enemyId, type)` decides whether a body can be searched at all from `CORPSE_LOOT_CHANCE` on an **independent** seeded stream (`worldSeed ^ (enemyId · 0x9e3779b1)`) — never on the `rng` that feeds `rollCorpse`, whose exact output `src/inventory/__selftest__.ts` pins for `warrior` / `rogue` / `rogue_boss` at seeds 5 / 11 / 3. `add(…, opts?: CorpseWireOpts)` takes the host's `lootable` / `deathDir` (`ee corpse.lt / .dd`) over the local roll, **returns null and registers no interactable** when the roll fails, and emits `corpse:spawned { lootable, deathDir }` either way (so a listener can tell "a body is here" from "loot is here"). |
| `ai/EnemyAI.ts` | State machine per bug: `idle` → `wander` → `alert` → `chase` → `attack` → `stagger`, plus `dead`/`flee`. Everything target-relative reads `e.target` (`acquireTarget` each tick). Rogues branch to `RogueAI.updateRogue` after perception; artillery / toxic / behemoth chase & attack dispatch to `GimmickAI`. Charger rush contact and hunter leap landing hit the nearest alive (not downed) player in range; melee / spit fire only while `!e.target.isDeadOrDowned`. **2026-09-10 (총구 사선)**: 스퓨어의 원거리 침(`startSpit`)에 `ai/FireLine.hasFireLine` 가 붙었다 — 눈에는 보여도 **입**(산탄이 나가는 `headCenter + 0.1`) 사선이 막혔으면 뱉지 않고, `d ≤ SPEWER_SPIT.maxDist` 가지에서는 `fireLineStrafe` 로 옆으로 돈다(이 가지만 `hasMoveTarget = false` 로 굳어 있어서 벽에 침을 뱉던 그림이 나왔다). 후퇴 가지(6.5–9 m)는 어차피 자리가 바뀌므로 사격만 막는다. 연막 속 추정 사격(`suspicion`)은 원래 맹목 사격이라 검사하지 않는다. `integrate()` (exported) handles steering, separation, obstacle avoidance (a charging body that deviates → `stumble` with the type's cooldown; behemoth shakes the camera), terrain snapping, gait, footsteps, yaw, slope. **Phase 10**: `integrateDeathFall(e, dt, world)` (exported, called from the `state === 'dead'` early-return here **and** from `net/Replica.update`) integrates `deathVy` under `GRAVITY` and snaps to `world.getHeightAt` → `deathLanded`, so a body killed mid-leap falls instead of freezing in the air. |
| `ai/RogueAI.ts` | Humanoid gunner: guards idle / patrol 6–12 m around `guardPos` (escorts 3–6 m around the boss, `guardPos` follows it), `alert` = `ROGUE_REACTION` delay with the rifle raised, then the **cover cycle** in `chase` via `roguePhase`: 0 pick cover (`ai/RogueCover.ts`, Phase 7: LOS-validated + flank scored, also yields the **pop-out spot** `popPos`) → 1 move there (snap shots while relocating) → 2 crouch-hold 2–4 s (hint 6; boss ×0.6; target < 6 m pops out early; a running reload extends the hold) → 3 **step out to `popPos`** (≤ 2.5 s, no LOS penalty while stepping), stand and fire `ROGUE_BURST` rounds 0.12 s apart (hint 5) with aim error `ROGUE_AIM_ERROR` → `ROGUE_AIM_ERROR_SETTLED` over 1.2 s standing; no LOS for 1.2 s → new cover; after the burst `ROGUE_RUSH_CHANCE` → 4 **rush** to ~8 m firing from the hip every 0.28 s (hint 7, error ×1.6, ≤ 6 s) else back to 0. Leash: never farther than `leash` (45 m; escorts 18 m) from `guardPos` unless rushing or the target is visible within 30 m. Every shot goes through `shoot()` → `host.fireGun` and spends one of `ROGUE_MAG_ROUNDS` (`Enemy.magRounds`); an empty magazine starts a `ROGUE_RELOAD_TIME` **reload** in any phase (`reloadTimer`: crouched, rifle down, no shots, `reload` audio at the rogue, hint 12; a burst caught mid-reload ducks back to phase 2; `popOut` never loads more rounds than the mag holds). **Grenade** (`maybeStartThrow`, not while rushing): target hidden (`noLosHold` ≥ `ROGUE_GRENADE_HOLD_S`), `ROGUE_GRENADE_RADIUS + 1.5` < distance ≤ `ROGUE_GRENADE_RANGE`, `grenadeCd` ≤ 0, no reload → walk to `popPos` (≤ 2 s) then `ROGUE_GRENADE_WINDUP` throw pose (hint 13, sphere in the off hand) → `host.throwGrenade(e, grenadeTarget)`; success arms `ROGUE_GRENADE_COOLDOWN` (boss ×0.7, ±10 %), a refused launch (rock in the face) retries in 2 s; then back to phase 0. The boss and its escorts throw too. Stagger drops a wind-up (cooldown unspent). **2026-09-10 (총구 사선)**: `canShoot` 에 `ai/FireLine.hasFireLine` 가 붙어 **총구**가 막혀 있으면 어느 단계에서도 방아쇠가 당겨지지 않는다 (단계 1 의 스냅 샷은 `Math.random()` 을 먼저 보고 나서 검사한다 — 총구 월드 행렬 갱신이 공짜가 아니다). 단계 3 에서 `hasLOS` 는 참인데 사선만 막혔으면(= 바위 · 벽에 몸을 붙였다) 서 있지 않고 `fireLineStrafe` 로 옆으로 비켜서고, 한 다리를 다 걸어도 못 뚫으면 `roguePhase = 0` 으로 **새 엄폐물**을 고른다. `popPos` 로 걸어 나가는 중(`stepping`)에는 원래 자리가 막힌 게 정상이라 건드리지 않는다. 단계 4(돌격)는 **사격만** 멈추고 계속 달린다. |
| `ai/RogueCover.ts` | Phase 7 cover selection. Candidates keep the Phase 4 filters (within `COVER_SEARCH_RADIUS` 16 m, not behind the rogue, inside the map, 4 m … 90 % of the rifle range from the target, inside the leash); a candidate's point is the obstacle's far side. **2026-09-08**: every one of those geometric numbers reads the cylinder *rays stop at* — `blockRadius(o)` / `blockHeight(o)`, i.e. `shotRadius` / `shotHeight` when the prop declares them — not the movement collider. Since the 바위 엄폐 fix the two differ on purpose (the collider is narrower and taller than the rock it draws), and offsetting by `o.radius` alone put both the cover point and the pop-out spot **inside** the rock as far as `world.raycast` was concerned: `findPopSpot` read both flanks as 'still hidden' and rejected every candidate, so a rogue near wide rocks took no cover at all. The `≥ 0.5` / `≥ 0.8` size filters use the same measure, so a rock the crouched-eye line now passes over is never a candidate in the first place. Score = `distance + ROGUE_COVER_FLANK_WEIGHT × (1 − \|sin θ\|)` (`flankCost`: θ between `target.getForward()` and target → candidate, so flanks are free and the target's front / back cost the full weight) + 6 when it is the rock we stand at / just left + `max(0, toTarget − 35) × 0.5`. Cheap terms first, then two raycasts only for candidates that beat the best so far: `coverBlocksLine` from a **crouched** eye (0.9 m) at the point to the target's chest must be blocked, and `findPopSpot` must find a flank of the obstacle (perpendicular to the target line, `radius + 0.9` out, pulled 35 % back) from which a **standing** eye (1.45 m) sees the chest — cover you cannot fight from is skipped (otherwise rogues hide forever). Writes `coverPos / hasCover / popPos / hasPop`. |
| `ai/GimmickAI.ts` | `chaseArtillery` (retreat when < 60 m, approach when > 125 m, otherwise dig in over 1.2 s — `dug`, hint 8 — and `host.fireShell` every 6–9 s at ≤ 140 m; never melees; **2026-09-10** `fireShell` 가 `false` 를 돌려주면 = 낮아진 궤적이 언덕 · 나무 · 벽에 막혔다 → `artilleryRelocate` 로 굴착을 풀고 표적 수직 방향으로 `ARTILLERY_RELOCATE_M`(7 m) 옮겨 다시 판다. 방향은 매번 뒤집고 `Enemy.fireBlockTimer`(= `ENEMY_FIRE_STRAFE_S`) 동안 걷는다 — 같은 자리에서 6~9초마다 제 발치에 쏘지 않게), `chaseToxic` / `attackToxic` (weaving runner; within `TOXIC_TRIGGER_DIST` of its target or any alive player → swell 0.6 s, hint 9, then `kill(false)` → burst), `chaseBehemoth` / `attackBehemoth` (approach to 18 m; wind-up `BEHEMOTH_WINDUP` with roar, hint 10; then a straight line at `BEHEMOTH_CHARGE_SPEED` toward the target's position at wind-up end + 6 m, hint 11; players within radius + 0.85 m → `host.chargeHit` once per charge with a sideways knock direction; enemies of either faction in the path → 160 damage `'ai'` + shove + stagger; end / 3.2 s / obstacle → stumble, cooldown 4 s; melee like a warrior in between). |
| `ai/FireLine.ts` | **총구 사선 (2026-09-10).** `ai/Perception.hasLineOfSight` 는 **눈** → 가슴 레이라, 벽에 몸을 붙인 적은 그 검사를 통과하면서 총구는 벽 안에 박혀 있다 — 벽에 대고 쏘던 그림의 뿌리다. `fireOrigin(e)` 가 **총알/침이 실제로 나가는 지점**(로그 = `Enemy.muzzle` 소총 끝, 스퓨어 = `headCenter + 0.1`)을 주고, `hasFireLine(e, host, t)` 가 거기서 표적 가슴까지 `world.raycast` 한다. 두 가지가 규약이다: ① 레이는 총구에서 `ENEMY_WALL_STANDOFF` **뒤**(제 몸 안 — 적은 월드 장애물이 아니다)에서 출발한다. 총구가 이미 벽 안이면 총구에서 밖으로 쏜 레이는 벽을 만나지 못해 "뚫렸다" 가 되기 때문이고, 이것이 "벽과 최소 거리를 둔다" 규칙의 실체다. ② 결과는 적별로 `ENEMY_FIRE_LOS_S`(0.25 s) 캐시(`Enemy.fireLineAt` / `fireLineClear` / `fireLineGap`) — 매 프레임 · 매 발 레이캐스트를 쏘지 않는다. 표적이 바뀌면 `acquireTarget` 이 캐시를 버린다. 막혔을 때의 답은 `fireLineStrafe` — 표적을 보면서 수직으로 `FIRE_STRAFE_STEP` 옆으로 조향 목표를 잡고(총구가 물체 안이면 `fireLineGap` 을 보고 뒤로도 조금), `ENEMY_FIRE_STRAFE_S` 한 다리를 다 걸을 때까지 `true` 를 돌려준다. **사격만 보류하고 이동은 절대 막지 않는다** — 문 · 틈을 지나느라 한순간 막히는 것은 정상이라 AI 가 굳으면 훨씬 나쁘다. 지형 · 장애물만 본다(아군 오사는 보지 않는다). 포병의 곡사 궤적은 직선이 아니라 `parts/Attacks.shellArcBlocked` 가 맡는다. |
| `ai/Common.ts` | `lookAtTarget`, `startMelee`, `stumble(e, cooldown, duration)`, `AttackResult` shared by the three AI modules. |
| `ai/Steering.ts` | `seek`, `separate` (mass-weighted positional correction via the grid + push-out from every alive `CombatTarget`), `avoidObstacles`, `turnToward`, `yawTo`. |
| `ai/Perception.ts` | `acquireTarget`: `host.pickTarget(e)` (players and hostile enemies), re-evaluated every 0.5–0.9 s or when the target dies / goes down / leaves; hysteresis (switch only when another is < 0.6× / 0.75× as far, with/without LOS). Staggered 0.3 s perception tick: sight `sightRadius` (bugs 40, rogues 60, artillery 130) with LOS to the target's chest, target loss after 10 s unseen & > 60 m — skipped for `relentless`, artillery, and rogues with a target inside 80 m. `becomeAlert` emits `enemy:alerted`, screech audio (rogues stay silent), propagates 20 m within the same faction. |
| `net/HostSync.ts` | Host encoding: `encodeSnapshot(active, time, cache, force?)` → `EnemySnapshot { seq, full, e: EnemyWire[], gone? }` with p 2 dp / yaw 3 dp / hp 1 dp, `a` hint (1 charger windup, 2 rush, 3 spewer windup, 4 hunter airborne, **5 rogue shooting, 6 rogue in cover, 7 rogue rushing, 8 artillery dug in, 9 toxic swelling, 10 behemoth windup, 11 behemoth rush**, Phase 7: **12 rogue reloading, 13 rogue throwing** — both outrank the cover phases, 전소 / stagger outrank them) and `w` (rogue rifle id), `sb` status bits (`statusBits`, Phase 6). Corpses leave the snapshot 1.5 s after death (replicas keep them from their own corpse timer). **Phase 9 — `es` is a delta stream**: `SnapshotCache` remembers the rounded fields last sent per id (plus `seenSeq`), holds the monotonic `seq` and the `forceFull` flag, and `reset(seqBase?)` clears it + forces the next keyframe (a promoted host passes the last seq it saw as a replica so its counter cannot be confused with the old host's). A **keyframe** — `force`, `cache.forceFull`, or every `KEYFRAME_EVERY` = `NET_ENEMY_KEYFRAME_S × NET_ENEMY_SNAPSHOT_HZ` snapshots — carries every field of every eligible enemy with `full: true` (`a` / `sb` omitted when 0, which a keyframe reads as 0). A **delta** carries only enemies whose rounded fields changed, and only those fields; an id the cache does not hold gets the full set (`ty` / `w` included) so a replica can build it, and `a` / `sb` falling back to 0 are written explicitly because an omitted delta field means "unchanged". `gone` lists ids the cache held that are no longer eligible. A keyframe is ~90 B per enemy as JSON; a delta over an idle swarm is a few bytes per moving enemy. |
| `net/Replica.ts` | Client replica: `ReplicaBuffer` (8-sample ring per enemy) with lerp / shortest-arc yaw / ≤ 0.25 s extrapolation; `EnemyReplica.onSnapshot` (get-or-create by host id; ids missing from a `full` snapshot → release, **except dead bodies**), `onEvent` (`spawn`, `kill` + kill credit when `killer === localId` (2026-09-11 E-4: another member's `killer` → `enemy:squadKill`), `despawn`, `damaged`, `attack`, `acid`, `wave`; Phase 4: `shoot` → tracer/flash/audio + `enemy:shot`, `shell` → visual shell, `intercept` → pop, `shellHit` → landing FX (skipped when the local copy already landed), `charge` → `enemy:chargeStarted`, `toxic` → green burst FX + `enemy:toxicBurst`, `corpse` / `corpseGone` → `CorpseManager`; Phase 7: `grenade` → `ReplicaHost.grenadeVisual` (visual copy flown from the wire position / velocity / fuse), `grenadeHit` → `grenadeHitRemote` (pops the local copy in place, or just the FX)), `update` renders at `ctx.time − NET_INTERP_DELAY`, clamps y to terrain unless airborne, drives `BugAnim` (gait from displacement; shake/abdomen/crouch/aim/mandible from state + hint — hint 12 crouch + reload pose, 13 throw pose via the held `reloadTimer` / `throwTimer`; head tracking; slope) and mirrors `sb` into the status timers (`applyStatusBits`, Phase 6). Phase 7 host migration: `adopt(e, now)` seeds a demoted enemy's ring buffer with its current pose so it keeps rendering until the new host's first snapshot; `latestOf(e)` hands the promotion the newest wire sample. **Phase 9 delta intake**: `seq` comes from `msg.seq` (the host's counter, `lastSeq` feeds a promotion); `ReplicaBuffer.applyWire(now, w, keyframe)` lays a partial wire over the newest sample as a new sample (absent fields keep their value; in a keyframe an absent `a` / `sb` is 0) while `push` stays the seeding path for `ee spawn` / `adopt`; an enemy absent from a **delta** gets `hold(now)` (the newest sample repeated) so the interpolator sees it standing still instead of extrapolating past the stop; an unknown id **without** `ty` / `p` is ignored and counted in `ignoredUnknown` (`ee spawn` or the next keyframe brings it); the sweep that releases unseen replicas runs on **keyframes only**; `gone` releases at once except bodies whose newest sample is `dead` (the corpse timer owns those). **Phase 10**: a dead body runs `integrateDeathFall` here (the host drops corpses from `es` after 1.5 s, so the client must fall on its own), `ee kill.dd` / `ee corpse.dd` are handed to `Enemy.kill(false, dir)` / `corpseSpawnedRemote` so the host's fall direction and lootable roll win. |
| `fx/RogueGrenade.ts` | Phase 7: 8 pooled rogue grenades (small dark spheres, ember emissive, `NO_RAYCAST`). `throw(owner, from, vel, fuse, authority)`; `launchVelocity(from, target, flight, out)` (ballistic solve, `GRAVITY`); `update` integrates gravity, spins, tests obstacles / terrain along each step (`world.raycast`, height field) — **one bounce** (normal × 0.3, tangent × 0.3) then a damped roll (× 0.5 per contact) to rest below 0.8 m/s, out-of-bounds rests too; fuse → `explode` → blast FX (fireball / sparks / ground blast / smoke / flash, no lights) + `GrenadeHost.onGrenadeExploded(p, authority, owner)`. `explodeNear(p)` (replica `grenadeHit`) pops the nearest still-flying local copy within 4 m or plays the FX alone; `setAuthorityAll` flips in-flight grenades on host migration; `findByOwner` / `count` for debugging. **2026-09-11**: 걸음마다 `breakFragileAlong` — 창문 유리에서 튕기지 않고 깨고 지나간다. |
| `ai/Investigate.ts` | **Phase 12 (총알 추적)**: the investigate state an enemy enters when `EnemySystem.reportShot` decides it noticed a bullet it cannot attribute to anyone. Rides on the shared machine as `state = 'alert'` with `aware = false` (`Enemy.investigating`), so the wire needs nothing new (a replica reads `alert` as the raised-rifle / crouched pose it already has). `beginInvestigation(e, origin)` starts it (false = already running, only the origin moved), `updateInvestigate` runs one tick instead of the state switch, `endInvestigation` restores the previous behaviour. Phases: **0 watch** — face the origin, stand still, `ENEMY_SHOT_ALERT_WATCH_S`; **1 advance** — bugs walk straight at it, rogues leg cover-to-cover (`pickApproachCover`, a `COVER_HOLD_MIN..MAX` crouched hold at each rock = wire hint 6, `OPEN_LEG_S` straight ahead when no rock qualifies, `COVER_LEG_TIMEOUT` per leg) until within `SHOT_ALERT_ARRIVE` (8 m) or past the rogue's leash; **2 arrived** — a last `ARRIVE_HOLD_S` look, then stand down. `ENEMY_SHOT_ALERT_GIVE_UP_S` ends it wherever it is. Perceiving anyone (the cone in `ai/Perception.ts`) flips `aware` and `EnemyAI` drops straight into the ordinary alert → chase (rogues open fire); a hit, a barrier bump, a stagger or `flee` cancels it. |
| `fx/Xray.ts` | **Phase 12 (정찰 x-ray)**: `EnemyXray` — the red through-wall silhouette behind `EnemyManagerRef.setXray`. One overlay `THREE.Mesh` per body mesh under `Enemy.object`, **parented to that mesh** so it inherits the animated part transform for free (no per-frame matrix copy), all sharing ONE `MeshBasicMaterial` (`DETECT_ENEMY_COLOR`, `depthFunc: GreaterDepth`, `depthTest: true`, `depthWrite: false`, `DoubleSide`, `fog: false`, `toneMapped: false`, `NO_RAYCAST`) — the same trick as the player's occlusion silhouette. Opaque rather than translucent, and drawn at `XRAY_ORDER` 1 with the body lifted to `BODY_ORDER` 2: a transparent overlay sorts after the body and would paint the *visible* enemy red wherever a far leg lies behind the torso. Overlays are built lazily once per pooled `Enemy` and only toggled afterwards (`show` extends and never shortens; `remove` on death / despawn, `tick` expires, `clear` on mission reset, `dispose` detaches before the rigs are freed). No per-frame allocation. |
| `models/BugParams.ts` | Per-type visual parameters for the six-legged rig (`BugType`), incl. Phase 4 `mortar` (artillery tube), `frontPlate` (behemoth), `sacSwell` (toxic); `behemoth` = warrior params scaled ×`BEHEMOTH_SCALE`. |
| `models/BugModel.ts` | Shared per-type geometry/material assets, `createBugRig` (`kind: 'bug'`, `baseScale`, optional `mortar` group), `animateBug` (tripod gait, bob/lean/slope, head tracking, mandibles, hit flash, flinch, sac pulse/swell, wind-up shake, leap crouch, mortar recoil, death roll — the body **stays on the ground** and only sinks during `fade`). `BugAnim` adds `fade`, `aim`, `recoil`. **Phase 10**: the canned death roll became **three real directions** — `BugAnim.deathDir` (0 left / 1 right / 2 back, replacing the unseeded `rollSign`) and `deathFall` (blend over `DEATH_FALL_TIME` with one small settle bounce); left / right roll the thorax over and shift it sideways, back rears the bug over onto its abdomen with almost no roll. `curl` (leg fold) and `sink` are unchanged. |
| `models/RogueModel.ts` | Procedural humanoid rig (`kind: 'rogue'`): pelvis/torso/head with emissive visor, arms + rifle block (`gun` group, `muzzle` marker), two legs, and (Phase 7) a small `grenade` sphere at the off hand (shared ember material, hidden unless throwing); boss = same geometry scaled by `ROGUE_BOSS_SCALE` (`baseScale`) with a pauldron and red visor. `animateRogue` from the shared `BugAnim`: walk cycle, cover crouch, low-ready ↔ aimed rifle (`aim`), recoil kick, look/aim from `headYaw/headPitch`, flinch, hit flash, fall + fade; Phase 7 `reload` (rifle tipped down and rolled in, hands jitter at the magazine) and `throwing` (rifle dropped to the hip, grenade rises above / behind the shoulder) blends, both driven by `Enemy.animate` from `reloadTimer` / `throwTimer`. **Phase 10**: the fall is three directions from `BugAnim.deathDir` blended over `DEATH_FALL_TIME` — before, `rollSign > 0` fell backward and `< 0` fell right, and **left did not exist**. |
| `fx/BloodFX.ts` | Pooled `Points` cloud (1600 droplets) and 40 pooled ground splat decals (blood or acid). Particle-only kinds `ember` (burning / 전소, orange) and `spark` (shocked, cyan). |
| `fx/AcidProjectile.ts` | 14 pooled arcing acid globs: `fire(from, target)` aims at the target's predicted position, `fireAt(from, feet)` for replica visuals / enemy targets; hit tests vs every alive player's capsule and `world.raycast`/terrain; damage goes through `AcidHost.damageTargetAcid`. |
| `fx/ShellProjectile.ts` | 10 pooled artillery shells (dark sphere, smoke trail from `FxManager.alpha`, ballistic arc reaching the aim point after `SHELL_FLIGHT_TIME`). Each shell is an `InterceptableRef` (`radius` `SHELL_RADIUS`, `intercept()`); `raycast` = nearest sphere hit for `EnemyManagerRef.raycastInterceptable`; landing (terrain/obstacle raycast, ground, bounds, timeout) → `ShellHost.onShellLanded` (host: `SHELL_DAMAGE` with falloff to players in `SHELL_BLAST_RADIUS` + `explode` on every enemy — friendly fire; everyone: crater dust / fireball / shake / `enemy:shellLanded`); `interceptShell` → pop FX + `ShellHost.onShellIntercepted(sid, p, local)`. Same class renders host and replica shells. **궤적 수식은 여기 없다** — `@/shared/ballistics`(`shellPositionAt` / `shellLaunchVelocity`, 중력은 `SHELL_ARC_GRAVITY`)를 부르고 파일 상단에서 그대로 재수출한다(`ui/hud/ShellMarkers` 가 같은 식을 써야 마커가 포탄에 붙는다). **2026-09-10**: 순간 속도 적분(`s.vel`)도 `GRAVITY` 가 아니라 `SHELL_ARC_GRAVITY` 다 — 위치는 낮은 궤적을 따라가는데 속도만 5배 빨리 아래를 향해 리본 꼬리 방향이 어긋나 있었다. 궤적이 낮아져 지형 · 나무 · 폐허 벽에 걸리면 **그 자리에서 터진다**(단계별 `world.raycast` → 기존 `onShellLanded` 그대로, 새 경로 없음). `HALO_SCALE` 2.4 → 2.9: 포탄이 이제 하늘이 아니라 **지형을 배경으로** 수평선 근처에서 날아오므로 거리에서 읽히는 것은 가산 혼합 헤일로뿐이다. 리본(`TRAIL_*`)은 그대로 — 궤적이 낮아지면서 카메라에 옆면을 길게 보여 오히려 잘 읽힌다. |
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
`bug_screech`, `bug_attack`, `bug_death`, `bug_step` (hunter leap landing only since 2026-09-11),
`bug_hit`, `acid_splash`, `shot_rifle` (rogue shots, pitch 0.9), `hit_flesh` (rogue hit / shot landing on a player),
`player_death` (rogue death), `explosion` (shell landing / interception) — throttled per id.
**2026-09-11 (C-51 · C-23 · C-22)**: 타입마다 흩어져 있던 선택이 `model.ts` 의 표 셋으로 모였다 — `meleeHitSound(type)`
(벌레 `bug_attack` + 타입 피치, 로그 `melee_hit`, 타길라 · 스캔 드론 null), `hurtSound(type)` (벌레 `bug_hit` · 로그
`hit_flesh` · 스캔 드론 `drone_hit`, 호스트와 리플리카가 같은 답), `stepSound(type)` (`stepSound` 가 true 인 타입의 피치 ·
밑값). **적 발소리는 `footstep_<SurfaceMaterial>`** 이다 — 밟은 재질(`WorldRef.getSurfaceMaterial?`, 없으면 `dirt`)의
id 를 위치와 함께 `audio:play` 로 내고(`model.emitEnemyStep`, **적 id 별** 스로틀 `ENEMY_STEP_MIN_GAP`, **카메라** 거리
`ENEMY_STEP_EMIT_RANGE` 게이트), 크기 감쇠는 audio/ 의 `RANGED_SOUNDS` 곡선이 한 번만 건다(볼륨 = 타입 밑값 그대로).
**로그 강하** (2026-09-10): `rogue_pod_impact` 만 여기서 낸다 (포드마다, 착지 지점에서). 경보 `rogue_drop_alarm`
과 낙하 굉음 `rogue_pod_fall` 은 `audio/AudioSystem` 이 `rogueDrop:incoming` 을 보고 직접 낸다 — 크기가
`ROGUE_DROP_ALERT_RADIUS` 기준 거리 감쇠의 함수라 패너 설정(`panOnly`)을 아는 audio/ 안에서만 정할 수 있다.

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

## Shared contract consumed (2026-09-10 — 낮은 곡사 궤적 · 총구 사선)
- `ballistics.ts`: `shellPositionAt` / `shellLaunchVelocity` (`fx/ShellProjectile` 이 부르고 재수출, `parts/Attacks.shellArcBlocked` 가 발사 전 검사에 쓴다 — 수식을 베껴 두지 않는다: `ui/hud/ShellMarkers` 가 같은 함수를 쓴다).
- `constants.ts`: `SHELL_ARC_GRAVITY` (2.6 → **2** 로 확정), 새로 붙인 `ENEMY_WALL_STANDOFF` · `ENEMY_FIRE_LOS_S` · `ENEMY_FIRE_STRAFE_S` (`data/constants.csv` 에 줄이 먼저 있고 `K.num` 한 줄씩만 추가했다 — 이름 변경 · 삭제 없음).
- 폴더 안 코드 상수(csv 대상 아님, `model.ts`): `SHELL_ARC_SAMPLES` · `SHELL_ARC_CHECK_FRAC`; `ai/FireLine` 의 `FIRE_STRAFE_STEP`, `ai/GimmickAI` 의 `ARTILLERY_RELOCATE_M` (그림/알고리즘 수치라 `TRAIL_SAMPLES` 와 같은 부류이고, `model.ts` 에 두면 `ai/*` → `model` → `ai/EnemyAI` 순환이 생겨 각 파일에 둔다).

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
Brief: `docs/DECISIONS.md` Phase 7. Everything below is inside `src/enemies/`; the contract (`ROGUE_MAG_ROUNDS / ROGUE_RELOAD_TIME /
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
Brief: `docs/DECISIONS.md` Phase 9. Contract: `EnemyWire` pose fields optional, `EnemySnapshot.seq / gone?`,
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
Brief: `docs/DECISIONS.md` Phase 10. Contract (read-only): `EnemyDeathDir` / `ENEMY_DEATH_DIRS` / `CORPSE_LOOT_CHANCE`,
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
Brief: `docs/DECISIONS.md` Phase 11. Contract (read-only): `src/shared/planets.ts` (`PlanetEcosystem.bugs` /
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

## 배리어 충돌 · 정면 흡수 · 총알 추적 · 정찰 x-ray (Phase 12, 2026-09-08)

Four contract items land here; `src/shared` was frozen for this lane, so everything below uses the committed signatures.

**배리어 = a wall for enemies.** `ai/EnemyAI.integrate` calls `EnemyHost.resolveBarrier(e)` right after
`world.resolveCollision`, for **every** grounded enemy (bugs and rogues alike — harmless for the latter).
`EnemySystem.resolveBarrier` forwards to `ctx.implants.resolveBarrierCollision(e.position, e.stats.radius)`, which
pushes the body out and names the carrier. On contact the enemy hunts that carrier for `BARRIER_RETARGET_S` (6 s) —
`Enemy.barrierOwner` / `barrierUntil`, honoured at the top of `EnemySystem.pickTarget`, so the hysteresis in
`acquireTarget` cannot pull it back to a nearer player — it wakes up (`becomeAlert`, quietly) and any 총알 추적 ends.
`implant:barrierBumped {owner, enemyId, point}` fires at most every `BARRIER_BUMP_INTERVAL` (0.5 s) **per enemy**, with
the contact point at the body's front toward the carrier. A charging behemoth keeps its own knockback: the shield reads
as a rock, so the deviation test already in `integrate` stumbles it.

**정면 근접공격 흡수.** `applyDamage(..., melee)` — set by `hitTarget` (bite / leap / melee) and `chargeHit`, and
**not** by rifle / shell / acid / grenade damage, which keep their `raycastBarrier` path — consults
`ctx.implants.absorbFrontalAttack(owner, from, amount)` before anything reaches a player. True ends it there: for the
local owner implants already deducted the shield; for a **peer** owner the host sends
`{t:'ee', ev:'barrierHit', id, amount, p}` to that peer alone (no `dmg`, no `ee attack`), and the receiver's
`net/Replica` -> `ReplicaHost.barrierHitRemote` calls `ctx.implants.damageBarrier('local', p, amount)` plus the bite
audio. A suspended member is absorbed on the host without a message (its ghost has no client to tell).

**총알 추적** (`reportShot(origin, dir, range, hit)`, called by weapons for every local shot). A non-host forwards it
as `{t:'shotq', o, d, r, h?}` to the host and does nothing locally (a replica has no AI); the host runs the same
routine for its own shots and for a peer's `shotq` (validated: finite tuples, `r > 0` clamped to `MAX_SHOT_RANGE`, the
direction normalised). The routine walks the simulated enemies and picks those that (a) are alive combatants, unaware,
not `relentless` / staggered, (b) lie within `ENEMY_SHOT_ALERT_DIST` of the **bullet path** (closest approach of the
body centre to `origin -> origin + dir x range`, plus the body radius) or `ENEMY_SHOT_IMPACT_DIST` of the impact, and
(c) could **not** perceive the shooter by the normal rule (`Perception.canPerceive`, no cone — an enemy about to spot
the shooter anyway needs no hint). Those enter `ai/Investigate.ts` and emit `enemy:shotAlerted` **once**; an enemy
already investigating only refreshes its origin, and the perception test is throttled per enemy by
`SHOT_CHECK_INTERVAL` (an SMG reports 10+ shots a second). No-op in a 훈련장.

**The widened cone.** While investigating, `Perception.shotConeFactor` multiplies the acquisition range by
`ENEMY_SHOT_ALERT_CONE_MUL` for targets inside about +-45 degrees of the shot origin, and by 1 outside it — a cone, not
a sphere. It is applied **on top of** `detectionRange`, so the cloak (`target.stealth`) and smoke (`visionClarity`)
factors still scale the widened range and a 은폐 player stays proportionally hard to see. Only the unaware branch of
`updatePerception` uses it; tracking and target loss are untouched.

**정찰 x-ray.** `setXray(ids, seconds)` shows `fx/Xray.ts` silhouettes for those enemies (simulated **or** replica — it
only walks `byId`), extends on a second call, ignores unknown ids and dead bodies, and clears one with
`seconds <= 0`. Expiry runs in the update loop; death, despawn and `reset()` drop a silhouette immediately, and
`disposePools` detaches the overlays before the rigs are disposed.

**실드 배쉬 knockback** (asked for by implants/ after the contract froze): `EnemySystem.pushBack(center, radius, speed,
dir?)` shoves every alive enemy in range away from `center` (or along `dir`) with a linear falloff to 40 % at the rim,
using the same `velocity` nudge an explosion applies — so the existing steering / stumble rules absorb it and a
charging behemoth is skipped, exactly like an explosion. **2026-09-11 (C-1 · X-6)**: it is `EnemyManagerRef.pushBack`
now (no cast), and a **replica** no longer returns 0 — it sends one `HitRequest { dmg: 0, kb }` per enemy in range
(falloff applied, `d` = push direction) and the host's `onHitRequest` applies it (see *C 항목 배치*).

New `Enemy` fields: `investigating` / `shotOrigin` / `shotTimer` / `shotPhase` / `shotHold` / `shotCheckAt` and
`barrierOwner` / `barrierUntil` / `barrierBumpAt`, all cleared in `reset()`, on promotion and by `flee`.

## Known gaps / follow-ups
- Phase 12: an investigation is **host state only** — it rides on the `alert` wire state, so a replica shows the
  raised-rifle / alert pose but no dedicated hint, and a mid-investigation host migration drops it (`promote()` clears
  `investigating`). `reportShot` is per **local** shot: an enemy shot at by another enemy (faction warfare) is never
  alerted this way. The alert routine is O(active enemies) per shot with only cheap maths per enemy and the
  `canPerceive` raycast throttled to `SHOT_CHECK_INTERVAL` per enemy — a full-auto weapon on a 60-enemy map is fine,
  but a future shotgun that reported one call per pellet should report once per trigger pull instead. A `shotq` is
  trusted apart from its shape (a client can make host enemies investigate any point, which is harmless: it wakes
  nobody and deals no damage). The widened cone points **at the origin**, so a shooter who moves 90 degrees off the
  firing line while the enemy walks in is seen no better than before. `resolveBarrierCollision` is called once per
  grounded enemy per frame — the implants side must keep it cheap (it is a no-op when nobody carries a raised shield).
  The frontal absorb runs on the host only, so a peer's shield hp there is whatever `absorbFrontalAttack` says, and
  `ee barrierHit` is fire-and-forget (a peer that never receives it simply keeps its shield hp). The x-ray overlays are
  built on first reveal per pooled enemy and then kept for the life of the pool (about 17 hidden meshes per body), so a
  long mission that revealed many enemies keeps those meshes around until `disposePools`.
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

## Verification (Phase 12, 2026-09-08)
`npm run typecheck` 0 errors (whole tree). New `scripts/smoke-enemy-alert.mjs` (single-player, seed 21, headless Chrome
on the real GPU, sim-time waits, HMR socket parked; `ctx.implants.resolveBarrierCollision` / `absorbFrontalAttack` are
monkeypatched because implants/ owns the real ones) — **42/42**, 0 console errors, on a private `npx vite --port 5302`.
Covered: a rogue 66 m from the shot origin and 142 m from the player (out of every perception range) gets exactly one
`enemy:shotAlerted` from a bullet passing 3 m beside it, turns to the origin inside 1.2 s, does not move for the watch
with the rifle raised, refreshes its origin from a second shot without a second event, advances 3+ m after
`ENEMY_SHOT_ALERT_WATCH_S` while still `alert` / unaware on the wire, and stands down at
`ENEMY_SHOT_ALERT_GIVE_UP_S`; a shot fired from 90 m — outside the rogue's 60 m sight, inside the x2 cone — ends the
investigation into a normal chase with `target 'local'`; a shot far from everyone alerts nobody; a bug alerted by an
impact inside `ENEMY_SHOT_IMPACT_DIST` faces the origin, walks straight at it (30.0 -> 25.8 m) and stops at the ~8 m
arrival; a replica forwards `shotq {o, d, r, h}` to the host and alerts nobody locally, and the host rejects a `shotq`
with `r <= 0` or a malformed `h` while acting on a valid one. Barrier: a scavenger charging a plane 4 m in front of the
player is held there (184 push-outs, 0 bites, hp untouched), `implant:barrierBumped {owner:'local', enemyId}` fires and
stays under 2 Hz (7 in 3.5 s), and the bug retargets the carrier for 6 s; `absorbFrontalAttack('local', from, 8)` is
consulted before the bite and true suppresses both `enemy:attacked` and the damage while false lets the same bite land;
`ee barrierHit` -> `damageBarrier('local', p, 25)`. X-ray: `setXray` builds 17 overlays on a warrior (one per body mesh,
`DETECT_ENEMY_COLOR`, `GreaterDepth`, `depthTest` on, no depth write, bodies lifted to render order 2), a second call
extends and never shortens the reveal, expiry and death both drop it. `reportShot` is a no-op in a 훈련장. Regression on
the same build: `smoke-rogue-v2` **52/52**, `smoke-enemy-delta` **52/52**.
Not covered here (needs a second client): the real `ee barrierHit` round trip and a peer's `shotq` over the relay —
`e2e:mp` territory.

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


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`EnemySystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체). 상태도 클래스 참조도 없다.
   `EnemySystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function applyDamage(sys: EnemySystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 `ctx.*` 를 통한 호출부와
   폴더 안의 `this.foo()` 호출은 **하나도 바뀌지 않았다.**
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   접근 범위는 여전히 이 폴더이고, 외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

`parts/` 에 새 파일을 만들 때는 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고
위 표에 행을 추가한다. 순환 import 를 만들지 않으려면 `parts/` 는 `EnemySystem.ts` 에서 **타입만**
가져와야 한다(`import type { EnemySystem }`) — 값이 필요하면 `model.ts` 로 옮긴다.

## 로그 강하 (2026-09-09)

버려진 **전진기지 · 연구실 · 선로 플랫폼**의 컨테이너를 처음 조사하면 로그 분대가 강하할 수 있다.
구현은 전부 `RogueDrop.ts` 안에 있고, 계약은 `EnemyManagerRef.callRogueDrop` / `getRogueDrops` ·
`rogueDrop:incoming` / `landed` · `rdrop` · `ROGUE_DROP_*` 다.

### 흐름
```
world/  structure:investigated {zoneId, kind, position}
  → (호스트만) 구역당 1회 ROGUE_DROP_CHANCE 굴림
  → callRogueDrop(zoneId, position)
      rogueDrop:incoming + rdrop incoming                    ← 예고 (소리 · 토스트는 audio/ · ui/ 가 낸다)
      ROGUE_DROP_ETA_S 초 동안 포드가 하늘에서 내려온다        ← 모든 클라이언트
      rogueDrop:landed + rdrop landed + spawnRogue × count    ← 착지 (스폰은 호스트만)
      beginInvestigation(e, position)                        ← 구조물로 진격
```

### 규모 = 분대 인원
`data/tables.csv` 의 배열 표를 **index 0 = 분대 1명**으로 읽는다: 1명 2–3 · 2명 4–5 · 3명 5–6 · 4명 6–8,
보스(`rogue_boss`) 확률 0 / 0.5 / 1 / 1. 인원은 `ctx.net.getRemotePlayers()` 중 `connected` 수 + 1 에서 세고
1..4 로 클램프한다 (싱글은 1). **호출자는 인원을 정하지 않는다** — 계약이 그렇게 되어 있다.
자리가 모자라 `scatterPoints` 가 요청보다 적게 돌려주면 그만큼만 내려온다.

### 호스트 권한 · 구역당 1회 · 호스트 이관
굴리는 것은 호스트뿐이고, 굴림 자체는 `worldSeed ^ hash(zoneId)` 시드 스트림이라 **누가 호스트여도 같은 답**이
나온다. "이 구역은 이미 썼다"는 기록은 두 곳의 합집합이다:

1. `RogueDropDirector.used` — 이 클라이언트가 본 모든 `dropId`. 호스트가 굴린 구역(**실패한 굴림 포함** —
   사용자 규칙이 "구역당 1회만 발생"이다)과, **리플리카가 받은 `rdrop incoming`** 이 함께 들어간다.
   그래서 호스트 이관으로 승격된 사람도 이미 쓴 구역을 다시 굴리지 않는다.
2. `WorldRef.getStructures()` 의 `StructureDef.rogueDropUsed` — world/ 가 `struct sync` 로 채워 주는
   구조물별 플래그. 레이드 도중 합류해 `rdrop` 을 한 번도 못 본 사람이 호스트가 되는 경우를 덮는다.
   enemies/ 는 이 값을 **읽기만** 한다 (구조물 상태의 주인은 world/ 다).

`dropId` 는 `structure:investigated.zoneId` 를 그대로 쓴다 — 두 기록이 같은 열쇠를 써야 하기 때문이다.
`used` 는 `Pool.reset` 에서(= `world:ready` / `game:newMission` / `game:abort`) 레이드마다 비워진다.

**남은 구멍**: 호스트가 굴려서 **실패**한 구역은 와이어에 아무 것도 나가지 않으므로, 그 뒤 승격된 새 호스트는
그 구역을 모른다. 실제로는 world/ 가 `structure:investigated` 를 **구역의 첫 조사에만** 내므로 재굴림의 계기
자체가 없고, world/ 가 `rogueDropUsed` 를 조사 시점에 세워 주면 이 구멍도 사라진다.

### 상시 개체수 상한 (`AmbientSpawner.cap`)
강하 병력은 **`ensureCapacity` 를 거치지 않는다** — `host.spawnRogue` 를 직접 부른다. 근거: 상한은 *상시
순찰의 압력 조절* 장치이고, 예고한 8명이 상한에 눌려 2명으로 줄면 연출도 인원 규칙도 무너진다 (포병이
`maybeArtillery` 에서 `cap + 2` 로 스폰하는 것과 같은 성격의 예외다).
반대로 **조용히 회수되지도 않는다**: `ensureCapacity` 의 재활용 패스는 `e.isRogue` 를 건너뛰므로 로그는
애초에 회수 대상이 아니다 (로그 가드가 그렇게 유지되던 규칙 그대로다).
다만 `aliveCount()` 에는 그대로 잡히므로 **강하가 살아 있는 동안 벌레 순찰이 그만큼 덜 나온다** — 의도한
것이다. 로그 분대와 벌레 압박이 같은 자리에서 겹치면 감당이 안 되고, 강하 병력이 정리되면 저절로 원래
압박으로 돌아온다.

### 비호스트 클라이언트
`rdrop incoming` / `landed` 를 받아 같은 버스 이벤트를 내고 **포드 연출만** 그린다. 적 자체는 손대지 않는다 —
기존 `ee spawn` / `es` 리플리카 경로가 처리한다. 착지 지점은 호스트와 같은 시드 · 같은 인자로
`scatterPoints` 를 다시 뽑으므로 포드가 실제로 로그가 서는 자리에 꽂힌다. 예고를 못 본 `rdrop landed` 는
무시한다 (적은 어차피 리플리카 경로로 보인다).

### 진격
새 AI 를 만들지 않았다. Phase 12 의 `ai/Investigate.ts` 를 그대로 쓴다 — 착지한 로그마다
`beginInvestigation(e, 트리거 지점)` 을 걸면 `ENEMY_SHOT_ALERT_WATCH_S` 주시 → 엄폐 이동 전진 →
`SHOT_ALERT_ARRIVE`(8 m) 도착의 기존 사이클이 그대로 돈다. 도중에 누군가를 인지하면 평소의 교전으로
넘어가고, `guardPos` 를 트리거 지점으로 잡아 두었으므로 도착 뒤에는 **기존 로그 가드 순찰**(guardPos 주위
6–12 m)이 이어받아 구조물을 지킨다.

### 포드
외부 에셋 없이 `RogueDrop.ts` 안에서 절차 생성한 붉은 육각 캡슐이다 — `player/Hellpod` 와 `stratagems` 의
구조 포드를 **참고만** 했고 import 하지 않는다 (아군 헬포드와 실루엣이 달라야 한다). 지오메트리 · 머티리얼은
모듈 단위로 공유하고 포드 인스턴스는 풀링하며, `disposeRogueDropAssets()` 가 `Pool.disposePools` 에서 정리한다.
낙하 중 연기 · 착지 `groundBlast` / `dust` / `sparks` · 카메라 흔들림은 전부 `@/core/fx` 의 기존 도구다.
착지한 포드는 30 초 뒤 씬에서 빠진다.

## 네임드 로그 (2026-09-11)

레이드마다 **최대 한 명**, 위험한 행성일수록 자주 나오는 이름 붙은 로그 셋 — 로든(`rogue_sniper`, 개활지 저격수 +
스캔 드론) · 타길라(`rogue_hammer`, 망치 근접, 구조물 곁) · 헤비(`rogue_heavy`, 미니건 + SMG 호위).
계약은 `shared/named.ts` · `EnemyType` 네 줄 · `enemy:namedSpawned` · `NAMED_ROGUE_*` / `NAMED_HEAVY_ESCORTS_BY_SQUAD`,
수치는 `EnemyTypes` 의 `NAMED_*` 블록(`data/enemy_abilities.csv`)이다. 스폰은 `named/Director.ts`, AI 는 `ai/named/*`
(종류마다 한 파일), 겉모습은 `models/named/*`. 담당별 소절이 이 절 아래에 붙는다.

### 스폰 디렉터 (`named/Director.ts`)
```
world:ready (권한 · 훈련장 아님) → 로그 가드 배치 → named.roll(planet)
  rng = Random(worldSeed ^ hash('named'))
  rng.next() < NAMED_ROGUE_CHANCE_BY_RANK[planetTier(planet) − 1] ?   (행성 없음 = 난이도 1 = 4 %)
  → 종류 = NAMED_ROGUE_TYPES[rng.int(0, 2)]
  → 자리 (같은 rng) → spawnRogue(...)  → ee spawn (기존 경로)
  → enemy:namedSpawned {id, type, position}
```
- **레이드당 1회**: 굴림은 `world:ready` 의 권한 분기에서만 일어난다. 호스트 이관(`setAuthority` → `promote`)은
  굴리지 않는다 — 승격된 사람은 리플리카일 때 이미 `ee spawn` 으로 그 네임드를 받았고, 같은 시드라 굴렸어도 같은
  답이다. 결과 · 알림 기록은 `Pool.reset` 이 레이드마다 비운다.
- **자리 공통 필터** (`spotOk`): 맵 가장자리 24 m 안쪽 · 스폰 지점에서 `NAMED_ROGUE_MIN_SPAWN_DIST`(140 m) 이상 ·
  선로 중심선에서 `RAIL_CLEARANCE_M + 4` m 밖 · `structureAt` 이 null(발자국 밖 — 실내 바닥 높이를 믿지 않는다) ·
  자기 반경 × `ENEMY_SPAWN_CLEARANCE_MUL` 원의 `obstacleCoverage` ≤ `ENEMY_SPAWN_BLOCK_RATIO`. 마지막 것은
  `Spawner.spawnBlocked` 와 같은 규칙인데 네임드는 반경이 `ENEMY_BIG_RADIUS` 밑이라 그 함수가 늘 false 라서
  반경으로 직접 부른다. 고른 자리는 `resolveCollision` 후 `getSurfaceY` 로 발을 붙인다.
- **로든**: 무작위 후보 48개 중 점수 최고 — `(높이 − 반경 30 m 링 8점 평균) − 40 × coverage(22 m) + 0.1 ×
  min(구조물 발자국까지 거리, 80)` 에서 맵 반폭 75 % 바깥으로 치우친 만큼 깎는다. 구조물 30 m 안 후보는 버린다.
  `guardPos` = 자기 자리, 스폰 지점을 바라본다. 무기 `sr`.
- **타길라**: 스폰에서 `MIN_SPAWN_DIST` 이상인 구조물을 먼 순으로 정렬해 먼 쪽 절반에서 시작, 발자국 바깥
  1.5 m ~ `min(NAMED_HAMMER.structureRadius, radius + 12)` 링을 16번 표본해 `coverage(10 m)` 최고 자리.
  `guardPos` = 구조물, 구조물을 등지고 선다. 무기 없음(`''`). 구조물이 없는 맵이면 장애물이 가장 빽빽한 후보.
- **헤비**: 같은 방식으로 먼 구조물 → 없으면 등급 2 이상 상자(폐허) → 없으면 무작위 후보. 앵커 발자국 바깥
  6–18 m. `guardPos` = 앵커. 무기 `u_minigun`(아이템 `wpn_u_minigun`). 호위 `rogue` × `NAMED_HEAVY_ESCORTS_BY_SQUAD
  [분대 인원 − 1]`(분대 인원은 `RogueDrop` · `WaveDirector` 와 같은 계산)을 헤비 둘레 `NAMED_HEAVY.escortRadius`
  의 40–100 % 링에 고르게 — 무기 `smg`, `escortOf` = 헤비라 `spawnRogue` 가 리시를 `ROGUE_AI.escortLeash` 로,
  `RogueAI` 가 `guardPos` 를 매 틱 헤비 위치로 옮긴다(보스 호위 규칙 그대로). 헤비가 죽으면 호위는 제자리 가드가 된다.
- **개체수 상한**: 네임드 · 호위는 `ensureCapacity` 를 거치지 않고, 로그 팩션이라 재활용 패스(`e.isRogue`)도
  건드리지 않는다 — 로그 가드 · 로그 강하와 같은 처리라 `Pool.ts` 에는 리셋 한 줄만 붙었다.
- **알림**: 권한은 스폰 직후 `enemy:namedSpawned`. 리플리카는 `Replica.onEvent('spawn')` 이 내는 `enemy:spawned` 에서
  `isNamedRogueType` 이면 id 당 한 번. ⚠ `ee spawn` 을 못 받고 **키프레임으로만** 네임드를 만든 늦은 합류자는
  `enemy:spawned` 자체가 없어서 알림을 받지 못한다 (기존 리플리카 경로의 성질).
- `namedData` · `namedPhase` 등은 건드리지 않는다 — 각 AI 파일이 첫 틱에 스스로 초기화한다. 디렉터가 넣는
  초기값은 `guardPos` · `weaponId` · `escortOf`(호위) 뿐이다.
- 디버그: `debugSpawnNamed(type, {x, z}?)` = 판정 없이 플레이어 앞 40 m(헤비는 호위 포함, 알림은 나가고 굴림 기록은
  그대로), `debugNamedRoll()` = `{rolled, planet, tier, chance, roll, type, placed, id, position, anchor, escorts}`.

### 로든 (`ai/named/Sniper.ts` · `models/named/SniperLook.ts` · `named/SniperShot.ts`)
넓은 개활지에서 엎드려 대물 저격총으로 **머리**를 노리는 저격수. **전조 없는 한 발은 없다** — 모든 발사는
`glintTime` 동안의 조준경 반짝임 뒤에만 나간다.
```
updateSniper (호스트 · namedData = SniperData, 첫 틱에 생성 · aware 는 늘 true)
  경직 · 전소            → 힌트 0 (일반 로그 자세) · 반짝임 취소
  자리 옮기기(relocate)  → 힌트 0 · 서서 coverPos 로 달린다 (≤ 4.5 s)
     조건: 반짝임 중 아님 · relocateCooldown 끝 · (피격 || 플레이어 < closeThreat)
     자리: 위협 반대쪽 옆으로 6–10 m, guardPos(둥지)에서 nestLeash 안
  엎드림(힌트 14)
     반짝임 중 → 힌트 15 · 표적을 따라 돈다 · glintLeft 0 → fire
     아니면 0.3 s 마다 pick (가장 가까운 한 명):
        ① 근거리  detectRange × 은폐 계수 안 · 엎드린 눈 → 머리 사선 열림(연막 포함)
        ② 스캔    드론 done · exposure ≥ exposeNeeded · range 안 · 사선 열림
        proneTurnRate 로 돌아 방향 오차 < 0.12 rad · fireCooldown 끝 · 엎드린 지 0.7 s → startGlint
     드론 없음 · droneCooldown 끝 → detectRange < 거리 ≤ droneRange 의 가장 가까운 플레이어에게 launchScanDrone
```
- **플레이어만 쏜다** (리드 결정): 인자 `t`(`pickTarget` 의 답 — 벌레 · 드론일 수 있다)는 쓰지 않고
  `host.targets.alive` 중 `enemy === null && !isDrone` 에서 직접 고른다. 드론에는 반짝임도 150 피해도 없다.
- **전조**: `startGlint` → 호스트 로컬 `named:sniperGlint {targetLocal}` + `sniper_glint` + (멀티 호스트)
  `ee glint {id, dur, target = PeerId, 호스트 자신은 localId}`. 반짝임 동안 사선을 끊으면(엄폐) 탄은 엄폐물에 박힌다.
- **발사**: 명중 확률 = `lerp(nearAccuracyMax, nearAccuracyMin, 거리 / detectRange)`, 스캔 표적이면
  `max(그것, scannedAccuracy)`. 맞히기로 굴렸으면 머리(`eyeHeight + 0.06`), 빗나가기면 머리 옆 1–2 m 로
  `host.fireGun(e, t, 0, 1, {damage, range, aimAt, fx: false, wire: false, out})` — 가림 · 배리어 · 유리 · 피해는 기존
  경로 그대로다. 그 뒤 `sniperShotFx` + `ee snipe {from, to, hit, target}` + 반동, `fireCooldown = fireInterval`.
  `enemy:shot` 은 `fireGun` 이(리플리카는 `onSniperEvent` 가) 낸다.
- **소염기 매몰** (C-56): `fireGun` 은 리그 총구(몸 ≈ 2.3 m 앞)에서 월드 레이를 쏘는데 월드 레이는 원점이 장애물 안이면
  무충돌이라, 반짝임 동안 돌다 총열이 바위 · 둔덕에 파묻히면 탄이 그대로 통과했다. 발사 직전 **몸 중심(발 + `EYE_UP`)
  → 총구** 선분을 `world.raycast` 하고, 막혔으면 `fireGun` 대신 그 점(섬광은 0.12 m 몸 쪽)까지 `sniperShotFx(hit:false)` +
  `ee snipe(hit:false)` + `enemy:shot(hit:false)` + 쿨다운 — **전조를 띄운 한 발은 쏜다**(자리 옮기기는 넣지 않았다).
  같은 이유로 사선 검사 원점 `EYE_FWD` 를 0.9 → **0.3 m**(몸 반경 0.4 안)로 당겼다.
- **몸통 판정** (C-55): 엎드린 몸은 세로 캡슐이 아니라 **눕힌 캡슐**이다 — `models/named/SniperLook.sniperBodyCapsule`,
  리그 실측으로 뒤 끝 구 중심 (z −0.80, y 0.20) · 앞 끝 (z 0.50, y 0.30) · 반경 0.25 (발끝 −1.05 · 어깨 앞 0.75 · 윗면
  0.55 를 덮는다, 벌린 발끝만 조금 밖). 비율은 **보이는 자세**(`SniperLookState.pose` = smoothstep 한 엎드림)이고 그
  사이는 서 있는 캡슐 끝점 · 반경과 섞으며, 경사(`anim.slopePitch`)는 자세와 같은 규약으로 골반 피벗 둘레로 기울인다.
  `EnemySystem.raycastEx` 가 `models/named.namedBodyRay` 로 묻고(kind 4, 법선 = 명중점 − 축 최근접점) 모든 히트스캔
  경로(무기 · 원격 무기 · 로그 `fireGun` · 대전차포 · 핑)가 그대로 받는다. 광역 반경 R(엎드림 1.68 m)은 캡슐 끝(≤ ≈ 1.35 m)을
  덮는다. 폭발 중심 높이도 `namedBodyCenterY` — 엎드리면 ≈ 0.25 m(`parts/Damage.applyExplosion` 리플리카 가지 · `explode`).
- **드론 수명** (`trackDrone`): `done` 을 보면 `scanWait` 창을 연다(스캔 표적에게 반짝이는 동안은 멈춘다) — 끝까지
  사선이 없으면 포기 → `droneRetry`. `done` 전에 `dead` · `flee` · 사라짐 · `loiterMax + 20 s` → `droneRetry`. 스캔
  표적에게 쐈으면 `droneCooldown`. 세 경우 모두 `resolvedDroneId = 드론 id` · `droneId = null` — 드론이 노출을 풀고
  복귀하는 신호다(`model.ts` 에 적힌 계약).
- **드론 입양** (C-49): `droneId === null` 이면 `trackDrone` 앞에서 `sniperId === 자기 id` 인 **아직 아무도 붙잡지 않은**
  (`!claimed`) 스캔 · 대기 단계 드론을 집어 온다 — 방금 놓아 준 드론(`resolvedDroneId`) · 귀환 중인 드론은 되잡지 않는다.
  호스트 승격으로 넘어온 드론을 `ScanDrone.ts` 가 가장 가까운 로든에게 붙여 주는 짝이다.
- **사격 연출** (`named/SniperShot.ts`, 호스트 · 리플리카 공용): 트레이서 세 겹(심지 · 탄연 · 달려가는 섬광) ·
  `FlashPool` 섬광(광원 세기 0) · 소염기 연기 · 엎드린 자리 흙먼지 · 탄착 먼지 · `sniper_shot` · 스친 탄 흔들림.
  소리의 거리 곡선은 `audio/AudioSystem` 의 `RANGED_SOUNDS` 가 갖고 여기서는 실제 위치로만 낸다.
- **리플리카**: `afterSniperReplica` = 힌트 14/15 에서 웅크림 0 · 조준 0.7/1. `onSniperEvent` — `glint` →
  `holdSniperGlint`(스냅샷 힌트 15 가 오기 전부터 스프라이트) + 소리 + `named:sniperGlint {targetLocal = target ===
  localId}`, `snipe` → 연출 + `clearSniperGlint` + 반동 + `enemy:shot`. 피해는 이미 호스트의 `dmg` 로 왔다.
- **겉모습** (`SniperLook`): 기본 소총 메시(팔 합본)를 숨기고 `rig.gun` 에 팔 + 대물 저격총(개머리 · 뺨받침 · 긴
  총열 · 소염기 · 대형 조준경 · 양각대), `rig.muzzle` 을 소염기 끝으로. 길리 숄 · 등 덮개 · 너덜너덜한 띠(`torso`),
  두건(`head`). 부품은 리그의 `chitin` 을 같이 써 피격 번쩍임이 공짜다. 엎드림 비율(힌트 14/15 → 1)로 `animateRogue`
  **뒤에** 몸을 π/2 눕히고(골반 0.14 m) 머리 · 총을 다시 수평으로 세우며 양각대를 펼친다. 엎드린 채 죽으면 일어서지
  않고 옆으로 늘어진다. 반짝임 = 가산 `THREE.Sprite`(`sizeAttenuation: false` → 화면 크기 일정 = 월드 크기가 거리에
  비례), `onBeforeRender` 에서 조준경이 카메라를 향하는 정도로 opacity, 확대 조준이면 다음 프레임 크기 보정.
  **광원 없음**, 스프라이트 `raycast` 는 끈다. 지오메트리 · 텍스처는 리그마다 만들고 `disposeSniperLook` 이 버린다.
- **머리 판정**: `rig.params` 를 리그별 사본으로 바꿔 끼우고 `head.y / head.z` 를 엎드림 비율로 1.66/0.02 ↔
  0.27/0.84 사이에서 옮긴다 — `Enemy.headCenter`(헤드샷 구) · `lookAtTarget` 이 엎드린 머리를 본다.
- **알려진 한계**: ① 경직 · 전소 · 자리 옮기기 동안은 서 있다. ② `aware` 고정이라 총알 추적에 끌려가지 않는 대신
  `enemy:alerted` 도 내지 않는다. ③ 벌레가 붙어도 쏘지 않는다(플레이어만) — 맞으면 자리만 옮긴다. ④ 근접 판정
  (`weapons/Melee` 원뿔)은 여전히 서 있는 몸 기준이다. ⑤ 매몰 판정은 발사 순간 한 번뿐이라 막힌 자리에서 반짝임을
  다시 시작할 수 있다(이동은 넣지 않는다는 결정).

### 스캔 드론 (`ai/named/ScanDrone.ts` · `models/named/ScanDroneLook.ts` · `fx/ScanPulseFx.ts`)
로든이 먼 플레이어를 노릴 때 띄우는 쿼드콥터(`rogue_scan_drone`, hp 60 · 반경 0.45 · 높이 0.4). **휴머노이드 리그
위에 꾸민다** — `isRogueType` 에 그대로 두고 `rig.body` 를 숨긴 뒤 드론 몸체를 `rig.root` 에 붙인다.
```
launchScanDrone(host, sniper, target)   ← Sniper.ts 가 부른다 (호스트만). 반환 id 를 SniperData.droneId 에 적는 것은 로든 쪽
  이미 떠 있음(droneId 살아 있음 · 같은 sniperId 드론) / 리플리카 / 표적이 플레이어 아님 → null
  spawnRogue('rogue_scan_drone', 저격수 옆 1.3 m · 위 2.4 m) → ee spawn (기존 경로)
  namedData = ScanDroneData { sniperId, targetId, exposure: Map, pulses, done, loiter, claimed, glinting, shotGrace, leave }
updateScanDrone (namedPhase)
  0 스캔   표적 머리 위 altitude (표적 둘레 5 m 느린 원) · 표적 수평 pulseRadius×0.6 안에서 pulseInterval 마다 음파
  1 대기   done 뒤 — 로든이 놓아 주거나(resolvedDroneId = 내 id · droneId ≠ 내 id) · 스캔 저격 뒤 fireInterval+glintTime
           안에 다음 반짝임이 없거나 · loiterMax → 2
  2 귀환   저격수 위 3 m 까지 → flee 퇴장 (최대 45 s)
  3 이탈   저격수 사망 → 3.5 s 솟구친 뒤 flee 퇴장
```
- **비행**: `e.airborne = true` 로 지형 스냅을 끄고 스스로 3D 적분한다 — 수평 속도 지수 블렌드(`ACCEL_RATE`) + 도착
  감속, 수직 속도 클램프, 순항 고도보다 6 m 넘게 낮으면 수평 속도를 줄여 **먼저 오른다**. 바닥은 `getSurfaceY(x, z)`
  (발 높이 없음 = 제일 높은 윗면)를 지금 자리와 0.8 s 앞에서 재 + 3 m — 장애물은 **고도로 넘는다**. 경직(전소)은 지상
  AI 의 stagger 가지가 돌지 않으므로 여기서 `staggerTimer` / `incapTimer` 를 직접 줄이고, 그 동안은 느리게 떠돌며 음파를
  쏘지 않는다. 매 틱 `aware` · `relentless` 를 켜고 `investigating` · 유인 · 구조물 표적을 끈다(총알 추적 · 유인에 끌려
  지상 AI 분기로 새지 않게).
- **음파**: `host.targets.alive` 중 수평 `pulseRadius` 안, 은폐(`stealth < 0.5`) 아님, 드론 밑 → 가슴 `world.raycast`
  가 열린 사람의 `exposure[t.id]++`. 지붕 · 벽 · 언덕 뒤에 숨으면 걸리지 않는다. `scanPulses` 번째에 `done`.
  한 번의 음파가 내는 것: `ScanPulseFx` · `scan_pulse` · `named:scanPulse {exposedLocal}` · (멀티 호스트면)
  `ee scanPulse {id, p, r, n, of = scanPulses, tg = 노출된 PeerId[] — 호스트 자신은 localId}` · 힌트 20 을 0.6 s.
  비행음 `scan_drone_hum` 은 1.8 s 마다(리플리카도 자기 쪽에서).
- **퇴장은 `flee` 경로다**: `state = 'flee'` + `fleeTimer = FLEE_DURATION` 이면 `EnemySystem.update` 가 **같은 프레임**
  AI 루프 뒤에서 `despawn`(+ `ee despawn`)한다 — AI 루프 안에서 `despawn` 을 부르면 배열이 밑에서 바뀐다.
- **격추**: 공중 사망 규칙 그대로 — `Enemy.kill` 이 `vy` 를 `deathVy` 로 넘기고 `integrateDeathFall` 이 떨어뜨린다
  (리플리카는 `afterScanDroneReplica` 가 스냅샷 높이 차분으로 `vy` 를 채워 둔다). 경직이 없다(`takeDamage` 는
  `airborne` 이면 경직을 걸지 않는다). 시체는 `CORPSE_LOOT_CHANCE` 0 이라 수색할 수 없는 잔해로 누운다.
  `raycastEx` 는 `position` 기준 캡슐이라 공중 위치에서 그대로 맞는다 — 발 위 0.45 m 에 중심을 둔 구 + 머리 구(0.2 m),
  겉모습 몸체 중심(`FRAME_Y` 0.42)을 거기 맞췄다.
- **로컬 노출 표시** (`ScanRuntime`, ctx 하나당 하나): 드론 id 별 슬롯 4개에서 최대 카운트를 `named:scanExposure
  {count, total = scanPulses, sniperId}` 로 **바뀔 때만** 낸다(리플리카의 `sniperId` 는 모름 = null). 0 으로 떨어지는
  경우: 드론이 없어짐(격추 · 퇴장) · `SniperData.resolvedDroneId` = 그 드론(호스트) · `named:sniperGlint.targetLocal` 의
  `duration` + 0.15 s 뒤(나를 겨눈 저격 발사, 모든 클라이언트) · 20 s 무갱신 · `world:ready` / `game:newMission` /
  `game:abort`. 드론이 이미 없어진 뒤에도 시간이 흘러야 하므로, 할 일(퍼지는 음파 · 노출 슬롯 · 예약된 해제)이 있는
  동안만 `requestAnimationFrame` 한 줄로 스스로 틱한다(`ctx.time` 기준 · 프레임당 한 번 멱등). 없으면 멈춘다.
- **음파 FX** (`fx/ScanPulseFx.ts`): 풀 4개 × (드론 → 땅 열린 원뿔 셸 — 아래로 흐르는 줄무늬, 지면 높이의 짧은 열린
  원기둥 띠 — 세로 가운데만 밝아 지형과 만나는 곳이 붉은 선). 둘 다 가산 · `depthWrite: false` · `NO_RAYCAST` ·
  logdepth 청크 포함 `ShaderMaterial`, `PULSE_S` 1.15 s 에 반경까지 `easeOut`. **광원 없음.** 메시는 처음 한 번 만들고
  `game:abort` 에서 dispose(다음 음파에서 다시 만든다), 레이드 리셋에서는 숨기기만.
- **겉모습** (`ScanDroneLook`): 허브 · 대각선 팔 4 · 모터 · 날개(회전) · 반투명 날개 원판 · 아래를 향한 스캐너 접시와
  렌즈 · 빨간 LED 4. 본체 · 날개는 `rig.chitin`(피격 섬광 · 화상 발광 공짜), 렌즈 · LED 는 리그마다 emissive 머티리얼.
  비행 방향으로 기울고 떠 있는 채로 까딱이며, 힌트 20 에서 렌즈가 번쩍이며 맥동한다. 죽으면 날개가 멎고 굴러 떨어져
  옆으로 누운 잔해가 된다. 공유 지오메트리는 참조 카운트로 마지막 리그가 dispose 될 때 해제된다.
- **리플리카**: `beforeScanDroneReplica` = 직전 y 기억 + `airborne`(Replica 가 지형 스냅을 건너뛴다),
  `afterScanDroneReplica(e, hint, dt, host)` = `vy` 차분 · 휴머노이드 자세 목표 무시 · 비행음(`host.playAudio`), `onScanDroneEvent` = FX · 소리 ·
  `named:scanPulse` · 로컬 노출(`tg` 에 내 `localId`).
- **호스트 승격** (C-49): 리플리카 시절의 드론에는 `namedData` 가 없다(호스트 전용). 예전에는 첫 틱에 `retire` →
  같은 프레임 despawn 이라 **공중에서 사라졌고**, 로든도 `createData` 의 `LAUNCH_RETRY_S`(3 s) 뒤 새 드론을 스캔 0 부터
  띄웠다. 이제 `adoptOrphan` 이 새 `ScanDroneData` 를 준다 — `sniperId` = 살아 있는 `rogue_sniper` 중 가장 가까운 것
  (없으면 -1 → 이탈 단계가 솟구쳐 치운다), 표적 무효(`'ai'` → 스캔 가지의 대체 로직이 로든 사거리 안 가장 가까운
  플레이어를 고른다), 스캔 0 · 단계 SCAN · **`namedTimer = 0`**(리플리카 훅이 직전 y 를 적어 두어 안 비우면 힌트 20 이
  수십 초 방송된다). 로든 쪽이 `droneId === null` 이면 그 드론을 입양한다(위 `로든` 소절). 디버그 스폰 드론도 같은 길이다.
- **알려진 한계**: ① 격추 시 `parts/Damage.onEnemyKilled` 가 로그 공통으로 `player_death` 소리와 피 튀김을 낸다.
  ② 드론 처치도 `enemy:killed` 로 킬 · 계약 카운트에 들어간다. ③ `Steering.separate` 는 2D 라 드론 바로 밑의 적이 살짝
  밀릴 수 있다(스폰은 그래서 저격수 옆으로 비켜 선다). ④ 승격 순간 진행 중이던 스캔 · 노출은 잃는다(스캔은 0 부터 — 결정).

### 헤비 (`ai/named/Heavy.ts` · `models/named/HeavyLook.ts`)
```
chase (엄폐 사이클 없음)
  발놀림: 안 보이거나 > keepMax → 다가감 · < keepMin → 뒤로 물러섬(드론 표적은 제외) ·
          보이는데 총구 사선만 막힘 → fireLineStrafe · 띠 안 먼 쪽 → creepMul 로 밀고 들어옴
          (총열이 도는 동안은 전부 × spinMoveMul — 사격만 보류하고 이동은 막지 않는다)
  namedPhase: 0 ADVANCE ─사선 + 쿨다운 끝→ 1 SPINUP(힌트 18, minigun_spinup, spinUp s, 끝까지 돌림)
              → 사선 있음 → 2 FIRE(힌트 19, ee spray on, burstTime s)   → 끝 → ee spray off + spindown + burstCooldown
              → 사선 없음 → 3 LINGER(힌트 18, linger s 헛돌기)          ↖ FIRE 중 사선이 끊겨도 여기로 (ee spray off)
              LINGER 안에 사선이 돌아오면 남은 연사를 곧바로 잇는다(ee spray on), 아니면 spindown + 쿨다운 절반
  경직 · 표적 상실로 chase 를 벗어나면 그 자리에서 연사를 끊는다
```
- **발사**: FIRE 틱마다(`1 / rof`, 프레임당 최대 3발) `host.fireGun(e, t, spread, 1, { damage, range, fx:false,
  event:false, wire:false, out })`. 피해 · 가림 · 배리어 · 유리 · 드론 판정은 전부 `fireGun` 이 한다. 몸이 표적에서
  0.35 rad 넘게 돌아가 있으면 총열만 돌고 쏘지 않는다(측면을 잡을 틈). 조준점은 `getChest`(드론이면 몸체 가운데).
- **와이어**: 연사 시작/끝의 `ee spray {id, on}` 두 번뿐 — 발마다 `ee shoot` 을 보내지 않는다. 힌트 18/19 는
  `Enemy.namedHint` 로 스냅샷에 실린다. 헤비가 연사 중 죽으면 `off` 는 나가지 않지만 리플리카는 시체를 `drive` 하지 않아 멈춘다.
- **호스트 연출**: 트레이서 2발에 하나(`fx.tracers`) · 섬광 프레임당 하나(`fx.flashes`, 세기 0 — 광원 개수 불변) ·
  `minigun_fire` 0.1 s 틱(버스로 직접 — `host.playAudio` 의 기본 스로틀 0.12 s 가 틱을 절반으로 깎는다) · 명중 시 `hit_flesh`.
- **리플리카**: `onHeavyEvent(on)` 이 연사 상태만 켜고, `afterHeavyReplica(e, hint, dt, host)` 가 **스스로** 같은 박자로
  트레이서 · 섬광 · 틱을 낸다. `off` 를 놓쳐도 `burstTime + 1.5 s` 또는 힌트가 19 에서 0.5 s 벗어나면 멈춘다. 회전음은
  힌트 18/19 가장자리에서 — `host` 를 `net/Replica.drive` 가 늘 넘기므로 첫 `ee spray` 전의 회전음도 난다(C-54).
- **리플리카 트레이서 방향** (C-50): 와이어에는 `ee spray {on}` 뿐이라 누구를 쏘는지 모른다. `remoteAimPoint` 가 몸 방향
  (`e.yaw`, 스냅샷)에서 `FIRE_FACING_TOL`(0.35 rad — 호스트가 실제로 방아쇠를 당기는 콘. 계획의 ±0.25 대신 이 값을 써서
  호스트가 쏜 발의 표적이 반드시 후보에 든다) · `range` 안의 후보 중 **가장 가까운** 것의 가슴을 고른다 — 플레이어
  (`targets.alive`) ∪ 적이 노리는 드론(`targets.drones`) ∪ 반대 팩션 적(키 × 0.6). 방향 = 총구 → 그 점 + `spread`
  (클램프 없음), 후보가 없으면 예전처럼 yaw 전방 + 머리 피치. 끝점은 `world.raycast`. 연사 중 매 프레임 돌므로 클로저 ·
  배열 없이 모듈 스크래치로 센다.
- **호위**: SMG 로그는 `escortOf` → 기존 `RogueAI` 가드 로직. 헤비는 기다리지 않고, 죽으면 `RogueAI` 가 호위를 풀어 준다.
- **겉모습**: 흉부 · 골반 메시만 넓히고(히트박스 파라미터 불변) 흉갑 · 견갑 · 허리/허벅지/정강이 판 · 헬멧 + 노란 바이저
  (`eyeMat`) · 탄통 백팩 + 탄띠. 기본 소총 메시는 **숨기기만** 하고, 두 어깨 사이 피벗에 미니건 + 그것을 쥔 팔을 붙인다(허리 높이
  약 1.1 m). **`rig.muzzle` 을 미니건 총구로 옮겨 붙여** `Enemy.muzzle` · `FireLine` · `fireGun` 이 거기서 쏜다. 총열 묶음은 힌트
  18/19 에서 댐핑된 속도로 돌고, 19 에서 총 전체가 떨리고 총구 끝(자체 머티리얼 하나)이 달아오른다. 걸음은 보폭 70 % ·
  디딤마다 내려앉기 · 좌우 흔들림. 지오메트리는 리그마다 만들고 `disposeHeavyLook` 이 해제한다.
- 수치: `NAMED_HEAVY` 의 `spinUp` · `rof` · `damage` · `burstTime` · `burstCooldown` · `spread` · `range` 에 이번에
  `keepMin` 15 · `keepMax` 45 · `creepMul` 0.5 · `spinMoveMul` 0.45 · `linger` 1 을 더했다.

### 타길라 (`ai/named/Hammer.ts` · `models/named/HammerLook.ts`)
망치 근접 보스 — hp 2800(일반 로그 × 10), **붙으면 초당 50** (`enemies.csv` attackDamage 50 / attackCooldown 1).
엄폐 사이클 · 사격 · 수류탄이 없다.
```
idle / wander   guardPos(구조물) 둘레 patrolRadius 순찰 · guardPos 에서 patrolRadius × 1.6 밖이면 복귀(wander + phase 3)
alert           ROGUE_REACTION 동안 돌아선다
chase  phase 0  추격 ─ d ≤ 준비 사거리 · attackCd 끝 → attack phase 1
                     ─ d ≤ chargeDist · 준비 사거리 + 2 m 밖 · 사선 · 무릎 높이 길 트임 · chargeCooldown 끝 → phase 2
                     ─ 길을 막은 설치물(structTarget) → 그것부터 휘두른다
chase  phase 2  돌진(힌트 17) chargeSpeed, 표적을 1.1 rad/s 로 따라 꺾음 · 사거리 닿음 → 곧장 휘두르기
                · 지나침 / chargeDist ÷ chargeSpeed × 1.6 s → 끝 · 벽 · 바위 · 배리어에 막힘 → stumble(경직)
attack phase 1  휘두르기 준비(힌트 16, windup s, hammer_swing) — 표적 쪽으로 천천히 밀고 들어간다
       ↓ 타격   사거리 + 0.6 m 안 · 정면 ±70° (1.1 m 안은 방향 무관) · 위아래로 닿음 → host.hitTarget(50) 1회
                늘: 망치 머리 자리 먼지 · 파편 · 불꽃 · 16 m 안 camera:shake · hammer_impact · ee hammer {id, p}
                attackCd = attackCooldown − windup  → 다음 타격이 정확히 attackCooldown 뒤
attack phase 4  0.25 s 회복 → chase
표적이 giveUpDist(60 m) 밖에서 giveUpTime(4 s) 안 보임 → aware 해제 + guardPos 로 복귀
```
- **돌진은 `Enemy.chargePhase = 2` 를 빌린다** — `integrate` 의 직선 이동(velocity 를 직접 씀, 회전 × 0.3)과
  "의도한 자리에서 0.05 m 넘게 밀리면 `stumble`" 판정을 그대로 쓰므로 새 충돌 코드가 없다. 그 경직 길이는
  차저의 `CHARGER_CHARGE.stumble`(1.5 s)이다. 분리(separation)는 `_prev` 기록 전에 밀어서 편차로 세지 않는다.
  돌진 접촉 피해 · 넉백은 **없다** — 간격을 닫는 수단일 뿐이고, 피해는 휘두르기 한 경로로만 나간다(드론에 넉백 경로를 타지 않는다).
- **설치물**: `ai/Structures.refreshStructureTarget` 가 이미 모든 종류에 대해 돌고 있으므로 벌레 근접형과 같은
  규칙(길을 막음 · 물기 거리 안)으로 바리케이드 · 돔 · 포탑을 부순다 — `attackDamage × STRUCT_DAMAGE_MUL`(80). 망치 보스를
  바리케이드 하나로 영원히 묶어 둘 수 없게 한 판단이다.
- **드론 표적**: 지상 드론은 친다(`hitTarget` → `ctx.drones.damageDrone`, 흔들림 0). 표적 밑면이 제 키(2.05 m)보다
  높이 떠 있으면 준비 · 돌진 · 타격 셋 다 하지 않는다(`canReachVertically` — `pickTarget` 의 고도 필터 뒤의 안전망).
- **와이어**: 힌트 16/17 은 `Enemy.namedHint` 로 스냅샷에 실리고, 타격마다 `ee hammer {id, p}`. 리플리카는
  `onHammerEvent` 가 `anim.recoil = 1`(내려찍기 자세) + 같은 FX · 흔들림 · `hammer_impact`, `afterHammerReplica` 가
  조준 자세를 지우고 힌트 16 이 새로 켜질 때 `hammer_swing`(`host` 인자로 — 첫 `ee hammer` 전의 준비음도 난다, C-54).
- **겉모습**: 기본 로그 × 1.12(머리 1.86 · 키 ≈ 2.05, csv 히트박스에 맞춤) + 장갑판으로 폭(반경 0.55)을 채운다 — 가슴 ·
  등 · 옆구리 · 견갑 · 탄부 · 허벅지 · 정강이 · 철판 장화, 용접 마스크 + 방독 필터 2 + **붉은 바이저 틈**(`eyeMat`, 리그마다
  `emissive` 를 붉게). 소총 메시(`rig.gun`, 팔과 한 메시)는 **숨기고** 가슴 피벗에 양손 대형 망치 + 팔을 붙인다(`muzzle` 은
  숨은 채 남는다 — 타길라는 쏘지 않는다). 피벗 X 회전 하나로 자세를 만든다: 경계 전 낮게 늘어뜨림 → 교전 비스듬히 →
  힌트 16 머리 뒤로 들어 올리며 상체 젖힘 → `anim.recoil` 이 튀면 0.1 s 안에 내려찍으며 숙이고 주저앉음 → 천천히 들어
  올림 · 힌트 17 앞으로 기울임 · 경직 늘어뜨림 · 사망 늘어뜨림. 지오메트리는 모듈 공유(참조 수), 머티리얼은 리그의
  `chitin` / `eyeMat` 그대로(피격 번쩍임 · 전소 발광 공짜). **광원 없음.**
- 수치: `NAMED_HAMMER` 의 `windup` · `chargeDist` · `chargeSpeed` · `chargeCooldown`(`structureRadius` 는 디렉터)에 이번에
  `giveUpDist` 60 · `giveUpTime` 4 · `patrolRadius` 10 을 더했다. `enemies.csv` 의 `attackWindup`(0.3)은 **읽지 않는다** —
  준비 시간은 `NAMED_HAMMER.windup` 하나다.
- **알려진 한계**: ③ 준비 중 경직(단발 2240 피해)이면 들어 올린 채 멈췄다가 내려온다. (① 돌진 막힘의 `bug_step` ·
  ② `hitTarget` 의 공용 `bug_attack` 은 2026-09-11 C-51 에서 없어졌다 — `model.stepSound` / `meleeHitSound` 표: 막힘 = 그
  타입의 재질 발소리를 낮은 피치로, 타길라 타격음 = null 이라 `hammer_impact` 하나만 난다.)

## 적 ↔ 드론 (2026-09-11)

플레이어가 조종하는 지상 · 공중 드론(`shared/drones.ts`, **소유자 권한**)을 적이 알아채고 · 노리고 · 때리는 규칙.
드론 자체의 규칙(체력 · 질주 소음 · `aggroable` · 피해 전달)은 `gadgets/drones` 가 갖고, 이 폴더는 **호스트 AI** 쪽만
갖는다. 리플리카 경로는 바뀐 것이 없다 — 드론 표적은 호스트 AI 만의 개념이고 와이어에 새 필드가 없다.

- **표적 프록시** (`Targets.ts`): `TargetList.drones` — 매 프레임 `ctx.drones.getDrones()` 중 `aggroable` · hp > 0
  인 것만. 걷는 지상 드론은 `aggroable` 이 false 라 목록에 없다(= 적이 봐도 무시). **`all` / `alive` 에는 넣지
  않는다** — 스포너 · 웨이브 · 분리(separation) · 포탄/독성/수류탄의 플레이어 루프가 드론을 플레이어로 착각하지 않게.
  프록시는 드론 id 당 하나(`id` 는 `'ai'`, `drone` / `droneId` 필드, `isDrone`)이고 꺼낼 때 한 번만 만든다.
  `position` = 몸체 **밑면**(지상 = 바닥점, 공중 = 중심 − 높이/2)이라 발 기준으로 짜인 `getChest` · `lookAtTarget` ·
  캡슐 판정이 그대로 맞는다. `velocity` 는 위치 차분, `droneAltitude` = 밑면 − `getSurfaceY`. 드론이 사라져도 `drone`
  참조는 남기고 `present` / `isDead` 만 내린다(그 순간 표적으로 들고 있던 적이 `'ai'` 에게 `dmg` 를 보내지 않게).
- **노리기** (`parts/Alerts.pickTarget` → `pickDroneTarget`): 배리어 캐리어 다음, 기존 (플레이어 · 반대 팩션) 규칙
  **앞에서** 드론을 본다. 조건: 플레이어보다 **< 0.6×** 가깝거나 플레이어가 없음 · 반대 팩션 적보다 가깝거나 같음 ·
  `canPerceive`(시야 반경 × 은폐 · 연막, 5 m 근접 또는 사선, 총알 추적 콘) · **근접형**(스퓨어 · 포병 · 로그 — 타길라
  제외 — 가 아닌 전부)은 `droneAltitude ≤ 키 + 공격 사거리` (공중 드론 밑에서 영원히 맴돌지 않게). 레이캐스트는 앞의
  값싼 검사를 통과한 드론에만. 스캔 드론은 드론을 노리지 않고, **버그는 스캔 드론(`rogue_scan_drone`)을 반대 팩션
  표적으로 고르지 않는다**.
- **소리** (`world:noise` → `EnemySystem.onWorldNoise` → `parts/Alerts.onWorldNoise`, 권한만): 총성과 같은 들리는
  거리(`hearingReach`) 안의 **인지 전** 적(웨이브 벌레 · 경직 · 스캔 드론 제외)이 `beginInvestigation(소리 지점)` —
  소리만으로 표적을 주지는 않는다. 조사 중 넓어진 인지 콘에 드론이 보이면 위 규칙으로 표적이 된다.
- **때리기** (`parts/Damage.applyDamage` 의 첫 가지): 표적이 드론이면 `ctx.drones.damageDrone(droneId, amount, from)`
  하나로 끝난다 — `enemy:attacked` · `dmg` · `ee attack` · 배리어 흡수 · 넉백 · 둔화는 없다. 이리로 오는 경로:
  근접(`hitTarget`) · 차저 돌진 접촉 · 헌터 도약 착지 · 독성 팽창 트리거(셋 다 `nearestAliveWithin` — 드론은 **수직으로도**
  반경 안일 때만) · 산성 직격 / 스플래시(`fx/AcidProjectile` 이 드론 몸체도 판정하고 `fire` 가 `bodyHeight` 로 조준을
  보정한다 — 플레이어는 보정 0) · 로그 사격(`parts/Attacks.fireGun` — 드론 캡슐, 납작한 몸체는 중심의 구, 맞으면 불꽃).
  `fireGun` 의 반환값 · `enemy:shot.hit` · `ee shoot.hit` 은 여전히 **플레이어** 명중만 뜻한다.
- **폭발**: 권한 분기에서 한 곳씩 `ctx.drones.applyExplosion(center, radius, damage)` — 로그 수류탄(`onGrenadeExploded`) ·
  포탄 착탄(`onShellLanded`) · 독성 자폭(`toxicBurst`) · 스퓨어 사망 폭발(`acidBurst`). 공용 `explode()` 에는 넣지
  않았다 — 플레이어 · 가젯 폭발(리플리카의 `explode` 요청 포함)도 거기를 지나 이중 적용이 된다.
- **알려진 한계**: ③ 네임드 AI(`ai/named/*`)도 드론을 표적으로 받을 수 있다 — 필요하면 `t.isDrone` 으로 거른다.
  (① 베헤모스 돌진이 드론을 치지 않던 것은 2026-09-11 C-47, ② 드론 · 적 표적 산성이 리플리카에 안 보이던 것은 C-48
  `ee acidAt` 으로 닫혔다 — 아래 *C 항목 배치* 절.)
- 디버그: `debugDroneTargets` = `[{ id, altitude }]`.

## C 항목 배치 — 적(일반) (2026-09-11, 에이전트 4)

`docs/plans/c-batch.md` §8 의 일반 적 항목. 계약(`EnemyManagerRef.pushBack` · `HitRequest.kb` · `Interactable.kind` ·
`SurfaceMaterial` · `shared/ride.ts` · `ee acidAt` · `HAZARD_ENEMY_DPS`)은 리드 커밋이다.

- **C-1 · X-6 배쉬 넉백 (비호스트)** — `parts/Damage.pushBack` 이 역할을 가른다: 권위는 예전처럼 `velocity` 에 더하고,
  리플리카는 범위 안 적마다 `HitRequest { dmg: 0, p: 몸 가운데, d: 밀 방향, kb: 감쇠 적용된 m/s }` 를 호스트로 보내고 보낸
  수를 돌려준다(`applyStatus` 의 `st` 요청과 같은 모양). 호스트 `onHitRequest` 는 `dmg 0 · st 0` 이어도 `kb` 가 있으면 받아
  `d` 의 수평 방향으로 더한다 — 돌진 중(`chargePhase 2`) · 비전투원 제외, `MAX_REQUEST_KNOCKBACK`(20)으로 자름, `dmg 0` 이라
  `hitc` 없음. 기하는 `dmg` · `st` 처럼 검증하지 않는다(E-4 계열 신뢰 경로 +1).
- **C-4** — `Corpse.kind = 'corpse'` (빛기둥 · 정찰 스캔이 접두어를 추측하지 않는다).
- **C-14 재해가 적에게도** — `parts/Status.updateHazardDot`: 권위 · 게임플레이 페이즈에서 `HAZARD_TICK_S` 마다 살아 있는 적 중
  `ctx.world.hazard.isInside` 인 몸에 `HAZARD_ENEMY_DPS × HAZARD_TICK_S`. `Enemy.applyDot(…, 'ai', quiet)` 라 번쩍임 · 피 FX ·
  `bug_hit` · `ee damaged` · 경직 · `aware` · `alertNear` 가 없고, 킬 크레딧도 없다(`'ai'` → `enemy:killed` 없음). 떨어지는 hp 는
  평소 스냅샷이 싣는다. 재해가 `missionTime` 의 함수라 호스트 이관 뒤에도 이어진다. `EnemySystem.hazardTick` 은 `Pool.reset` 이 비운다.
- **C-18 전차 탑승 · 시체 · 강하 목표** — `ai/Ride.ts` (위 파일 표). ① 권위: `integrate` 의 `_prev` 기록 **앞**에서 `rideCarry`,
  표면 재접지 **뒤**에서 `rideRecord` — `velocity` · 보행 · 발소리 · 돌진 이탈 검사는 차량 이동을 보지 않는다. 헌터 도약
  (`airborne`)은 하차. 네임드 AI 도 `integrate` 를 타므로 같이 탄다. ② 리플리카: `net/Replica.drive` 가 가장 새 샘플을 차량
  속도로 앞당겨 차량 부피 안이면 보간 자리에 `속도 × lag`(= 지금 − min(renderT, 샘플 + 추정 한도))를 더하고, 보행 이동량에서 그
  몫을 뺀다. ③ 시체: `EnemySystem.update` 가 죽은 몸마다 `carryCorpse` 를 부르고, 움직였으면(또는 차량에서 흘러 떨어지는 중이면)
  `corpse:<id>` 상호작용 자리를 몸에 맞춘다. `Enemy.kill` 은 탄 채 죽은 몸의 로컬 자리를 다시 적는다(리플리카 예측 오프셋 포함).
  ④ `RogueDrop.dropTargetFor`: `structure:investigated.zoneId` 가 `tram_*`(전차 컨테이너)면 목표를 **가장 가까운 플랫폼**으로 —
  달리던 전차 자리(= 선로 한가운데)에 분대가 떨어지지 않는다. 전차 치임(world/)은 탑승 상태를 묻지 않는다(데크 윗면 −
  `RIDE_FOOT_DROP` 위의 몸은 치지 않는다는 합의). 검사 `scripts/smoke-tram-ride.mjs`.
- **C-23 · X-3 · X-10 적 발소리** — `ai/EnemyAI.footfall(e, ctx, targets, moved)` 하나를 권위(`integrate`)와 리플리카(`drive`,
  한 프레임 2 m 미만 이동만)가 같이 부른다: 반 보폭마다 `model.emitEnemyStep` + 베헤모스는 40 m 안 흔들림(예전엔 30 m 블록
  안이라 30–40 m 에서 안 흔들렸다). 방출부 선형 감쇠 · 로컬 PC **몸** 30 m 게이트 · 전역 id 스로틀이 없어졌다(→ 카메라 60 m ·
  적 id 별 0.12 s · audio/ 곡선). 돌진 막힘 쿵도 같은 함수(× 1.8 크기 · × 0.85 피치).
- **C-24 · X-4 곡사포 재배치** — `ai/GimmickAI.artilleryRelocate`: 거절되면 후보 7곳(좌우 7 · 14 m, 표적 쪽 10 m, 조합) +
  오르막 한 곳을 `parts/Attacks.shellArcBlocked` 로 사전 검사(맵 안 · 후퇴~최대 사거리 · `obstacleCoverage` ≤ 0.25)해
  **가장 가까운 뚫린 자리**로 걷고(`Enemy.shellSpot` — `chase()` 가 `moveTarget` 을 매 프레임 표적으로 덮기 때문에 예전
  재배치는 사실 **표적 쪽으로** 걸었다), 걷는 시간은 거리에서(`walkFor`), 도착하면 바로 다시 판다. 부호 교대 없음. 없으면 표적
  쪽으로 접근. 연속 `ARTILLERY_AI.maxRefusals`(3) 번이면 다른 살아 있는 플레이어로 표적을 바꾸고 `refusalCooldown`(8 s) 쉰다.
- **C-25** — `ai/RogueCover` 의 `COVER_STANDOFF` 0.7 삭제 → `ENEMY_WALL_STANDOFF`(1) — 엄폐 · 사격 자리가 `FireLine` 이
  물러서는 거리와 같다.
- **C-47 베헤모스 돌진 → 드론** — `attackBehemoth` 가 `targets.drones` 도 훑는다(수평 `반경 + 몸체 + 0.4`, 수직 겹침, 한 돌진에
  `Enemy.chargeDrones` 로 드론 id 당 1회 → `chargeHit` → `damageDrone`). `chaseBehemoth` 는 밑면이 제 키보다 높이 뜬 표적(공중
  드론)에게 돌진을 시작하지 않는다(`canBodyReach`, 타길라 `canReachVertically` 와 같은 식).
- **C-48 · X-5 산성** — 드론 · 적 표적(`fireAcid`)과 `fireAcidAt`(연막 반격 · 설치물)이 조준점을 `ee acidAt {id, from, to}` 로
  방송하고 리플리카가 `acidVisualAt` 으로 날린다. `AcidProjectiles` 가 쏜 쪽 팩션을 들고(`fire` / `fireAt` 의 `faction`) **다른
  팩션 적**의 몸통 캡슐 직격 · 스플래시도 판정한다 → `damageTargetAcid(e.asTarget)` → `applyDamage` 적 가지(킬 크레딧 없음).
  **밸런스 변화**: 예전엔 벌레 산성이 로그를 그냥 지나가 버그 ↔ 로그 교전에서 스퓨어가 피해 0 이었다 — 이제 직격 18 · 스플래시 10.
- **C-51 소리 표** — 위 *Audio ids emitted*. `Damage.hitTarget` · `chargeHit` · `barrierHitRemote` · 리플리카 `ee attack` 이
  `meleeHitSound`, `requestHit` · `onEnemyDamaged` · 리플리카 `ee damaged` · 감전 비명이 `hurtSound`. `Attacks.bitePitch` 는 표를 읽는다.

---

## 변경 이력

- **2026-09-11 (E-4 · X-6 — 신뢰 경로, 에이전트 ⑤)** — ① **`enemy:squadKill`**: 호스트는 `parts/Damage.onEnemyKilled` 에서 `ee kill` 과
  **같은 `killer`** 가 분대원이면, 리플리카는 `net/Replica` 의 `case 'kill'` 에서 `killer` 가 내가 아니면 낸다 — 모든 클라이언트가 같은
  분대 킬을 센다 (meta/ 가 계약 분대 몫을 여기서 센다). `enemy:killed`(= 내 킬)의 뜻은 그대로. ② **셈하지 않는 죽음은 킬러도 없다**:
  `kill(false)`(독성 벌레 자폭 · `killAll`)는 `ee kill.killer = null` — `lastDamager` 기본값이 `'local'` 이라 지금까지 "호스트가 죽였다" 로
  나갔다. ③ `EnemySystem` 의 `ee` 는 **로비 호스트에게서만** 받는다(로비 없음 = 하네스, 통과). ④ `onHitRequest`: `p`/`d` 튜플 검사 +
  **보낸 사람별 DPS 버킷**(`HIT_REQUEST_DPS_MAX` 5000/s × `HIT_REQUEST_BURST_S` 2, 벽시계 — 넘치면 깎고 0.5 미만이면 버린다; explode 요청은
  세지 않는다) + **X-6 넉백 기하**: 보낸 사람 스냅샷과 적의 수평 거리 ≤ 배리어 오프셋 + 배쉬 사거리 × 1.5 + 방패 폭/2 + 적 반지름 +
  `HIT_KNOCKBACK_RANGE_SLACK`. 디버그 카운터 `EnemySystem.hitGuardStats {trimmed, dropped, kbRefused}`. 검사: `scripts/smoke-trust.mjs` + `smoke-enemy-delta` 의 C-1 · X-6 절(가짜 보낸 사람에게 적 곁 몸을 주고, 몸 없는 보낸 사람은 거절되는지 1건 추가).

- **2026-09-11 (C 배치 — 일반 적 C-1 · C-4 · C-14 · C-18 · C-23 · C-24 · C-25 · C-47 · C-48 · C-51, 에이전트 4)** — 위 *C 항목
  배치* 절. 새 파일 `ai/Ride.ts`. `Enemy` 필드 추가: `carrier` · `rideLocal` · `rideWorld` · `rideBlend` · `lastCarrier` ·
  `corpseDropped`(탑승) · `stepAt`(발소리 스로틀) · `shellRefusals` · `shellSpot`(곡사포) · `chargeDrones`(베헤모스),
  `applyDot(…, quiet)`. `ReplicaHost.acidVisualAt`, `AcidHost.active` · `find`. 새 수치: `data/enemy_abilities.csv` 의
  `ARTILLERY_AI.maxRefusals` 3 · `refusalCooldown` 8 (코드 상수: `MAX_REQUEST_KNOCKBACK` 20, `ENEMY_STEP_EMIT_RANGE` 60 ·
  `ENEMY_STEP_MIN_GAP` 0.12, 곡사포 후보 거리). 스모크: 새 `scripts/smoke-tram-ride.mjs`(19 체크), `smoke-phase4` +11
  (C-14 · C-51 · C-47 · C-24), `smoke-enemy-delta` +13 (C-1 · C-48 · X-5 · C-51 · C-23).

- **2026-09-11 (C 배치 — 네임드 C-49 · C-50 · C-54 · C-55 · C-56, 에이전트 4N)** — ① C-54: `ai/named/remote.afterNamedReplica`
  의 `host` 를 필수로 하고 네 종류 모두에 넘긴다. 스캔 드론의 `hostOf`(private 필드 캐스트) 삭제, 헤비 `replicaHost` · 타길라
  `replicaAudio` 모듈 전역 캐시 삭제(인자로). ② C-49: 호스트 승격으로 넘어온(= `namedData` 없는) 스캔 드론을 `retire` 대신
  입양 — 가장 가까운 로든 · 스캔 0 · `namedTimer` 0, 로든은 `droneId === null` 이면 미입양 드론을 집어 온다. ③ C-50: 리플리카
  헤비 트레이서가 방위 콘 안 가장 가까운 후보(플레이어 ∪ 드론 ∪ 반대 팩션)의 가슴을 향한다. ④ C-55: `RayTests.raySegmentCapsule`
  · `closestOnSegment` 신규, 엎드린 로든 몸통 = 눕힌 캡슐(`SniperLook.sniperBodyCapsule`, 리그 실측, 보이는 자세 비율 · 경사) →
  `models/named.namedBodyRay / namedBodyNormal / namedBodyCenterY` → `EnemySystem.raycastEx` 몸통 가지(kind 4) · `parts/Damage`
  폭발 중심 두 줄. ⑤ C-56: 로든 사선 원점 `EYE_FWD` 0.9 → 0.3, 발사 직전 몸 → 총구 레이가 막히면 그 점에 박힌다(`hit:false`,
  쿨다운 · 전조 유지). 새 스모크 `scripts/smoke-named.mjs`(32 체크, verify 미등록). 새 수치 없음. 위 네임드 소절들.
- **2026-09-11 (네임드 로그 — 로든)** — `ai/named/Sniper.ts` · `models/named/SniperLook.ts` 스텁을 채우고
  `named/SniperShot.ts`(호스트 · 리플리카 공용 사격 연출) 신규. 둥지 엎드림 → 근거리 사선 저격 / 원거리 스캔 드론 →
  스캔 표적 저격, **모든 발사는 조준경 반짝임 뒤**(힌트 15 · `named:sniperGlint` · `ee glint`). 발사는 `fireGun` opts
  (피해 150 · 사거리 320 · 머리 조준 · 자기 연출 · 와이어 없음) + `ee snipe`. 피격 · 근접 시 둥지 리시 안에서 자리
  옮기기. 플레이어만 쏜다(드론 · 벌레 표적 무시). 겉모습 = 대물 저격총(양각대) + 길리 망토 · 두건 + 엎드림 자세 +
  가산 스프라이트 반짝임(광원 없음), 엎드린 머리 판정(`rig.params` 리그별 사본). `ai/named/model.ts` 의 `SniperData` 에
  드론 신호 `resolvedDroneId` + 내부 필드 추가. `NAMED_SNIPER` 키 5개 추가(`relocateCooldown` · `nestLeash` ·
  `closeThreat` · `scanWait` · `proneTurnRate`, `EnemyTypes` 유니온 + csv). 위 `로든` 소절.

- **2026-09-11 (네임드 로그 — 헤비)** — `ai/named/Heavy.ts` · `models/named/HeavyLook.ts` 스텁을 채웠다. 엄폐 없이
  15–45 m 를 유지하며 걷는 미니건 AI(회전 → 연사 → 헛돌기 → 정지), 발사는 `fireGun` opts 로 와이어 없이, 연사
  시작/끝만 `ee spray`. 리플리카는 그 이벤트로 트레이서 · 섬광 · 소리를 스스로 그린다. 겉모습은 중장갑 + 헬멧 ·
  노란 바이저 + 허리 높이 6연장 미니건(총열 회전 · 열 · 떨림) + 탄통 백팩, `rig.muzzle` 을 미니건 끝으로 옮겼다.
  드론 표적도 쏜다(물러서지 않음). `NAMED_HEAVY` 에 `keepMin` · `keepMax` · `creepMul` · `spinMoveMul` · `linger`
  (`EnemyTypes` 유니온 + csv). 위 `헤비` 소절.

- **2026-09-11 (네임드 로그 — 스캔 드론)** — 계약 스텁 셋을 채웠다. `ai/named/ScanDrone.ts`: `launchScanDrone`
  (저격수 옆 위 스폰, `ScanDroneData`) · 공중 비행 AI(자체 3D 적분, 고도로 장애물 넘기) · 음파(수평 반경 + 사선 노출,
  `named:scanPulse` · `ee scanPulse` · 힌트 20) · 대기 → 귀환/이탈 → `flee` 퇴장 · 리플리카 훅 · 로컬 노출 표시
  런타임(`named:scanExposure`, 드론 없어짐 · 저격 발사 · 20 s 무갱신에서 0). `models/named/ScanDroneLook.ts`: 쿼드콥터
  (휴머노이드 숨김, 회전 날개, emissive 렌즈 · LED, 격추 시 굴러 떨어짐). 신규 `fx/ScanPulseFx.ts`: 풀링된 가산 원뿔 셸
  + 바닥 띠(광원 없음). `ai/named/model.ts` 의 `ScanDroneData` 에 드론 전용 필드 4개 추가(`claimed` · `glinting` ·
  `shotGrace` · `leave`). 새 수치 없음(`NAMED_SCAN_DRONE` · `NAMED_SNIPER` 그대로). 위 `스캔 드론` 소절.

- **2026-09-11 (적 ↔ 드론)** — 적이 `aggroable` 드론을 알아채고 · 노리고 · 때린다. `Targets.ts` 에 별도 목록
  `TargetList.drones`(프록시 = 몸체 밑면, `all` / `alive` 밖) · `nearestAliveWithin` 이 드론을 수직 판정과 함께 본다,
  `pickTarget` 에 드론 후보(< 0.6× 플레이어 · 인지 규칙 · 근접형 고도 제한)와 **버그의 스캔 드론 제외**,
  `world:noise` → 조사(`beginInvestigation`), `applyDamage` 드론 가지 → `ctx.drones.damageDrone`, 로그 사격 · 산성의
  드론 몸체 판정, 적 광역 피해 네 곳의 `ctx.drones.applyExplosion`. 새 수치 없음.

- **2026-09-11 (네임드 로그 — 타길라)** — `ai/named/Hammer.ts` · `models/named/HammerLook.ts` 스텁을 채웠다. 추격 →
  (짧은 돌진, 힌트 17) → 휘두르기 준비(힌트 16) → 1회 타격(`hitTarget` 50) → `attackCooldown − windup` 쿨다운이라
  붙어 있으면 초당 50. 설치물 부수기 · 지상 드론 타격 · 60 m / 4 s 리시 복귀 · 구조물 둘레 순찰. `ee hammer` 연출 ·
  리플리카 자세. 겉모습 = × 1.12 장갑 거구 + 용접 마스크 · 붉은 바이저 + 양손 망치(소총 메시 숨김). 수치 키 3개 추가
  (`NAMED_HAMMER.giveUpDist / giveUpTime / patrolRadius`). 위 `타길라` 소절.
- **2026-09-11 (네임드 로그 — 스폰 디렉터)** — `named/Director.ts` 신규. `world:ready` 권한 분기가 가드 배치 뒤
  `named.roll(planet)` 을 한 번 부른다: 시드 `worldSeed ^ hash('named')` → 등장 확률 `NAMED_ROGUE_CHANCE_BY_RANK
  [planetTier − 1]` → 3종 균등 → 종류별 자리(로든 개활 언덕 · 타길라 구조물 곁 엄폐 · 헤비 먼 구조물/폐허 + SMG
  호위 분대 인원별) → 기존 `spawnRogue` → `enemy:namedSpawned`(리플리카는 `enemy:spawned` 에서). `EnemySystem` 에
  `named` 필드 · `enemy:spawned` 구독 · `debugSpawnNamed` / `debugNamedRoll`, `Pool.reset` 에 `named.reset()`.
  재활용 규칙은 바꾸지 않았다(네임드 · 호위는 로그라 원래 제외). 위 `네임드 로그` 절.
- **2026-09-11** — 로그의 총알 · 수류탄이 구조물 창문 유리를 깬다 (`parts/Attacks.fireGun`, `fx/RogueGrenade`). 적은 사다리를 타지 않는다.
- **2026-09-10 (강하가 조용하지 않다)** — 로그 강하가 소리도 표시도 거의 없이 일어나 플레이어가 알아채지
  못했다. 이 폴더에서 바뀐 것은 둘뿐이다: ① `begin()` 의 `wave_alarm`(벌레 웨이브와 **같은 소리**였다) +
  `hellpod_fall`(아군 헬포드) 을 걷어내고, ② 착지 충격음을 `hellpod_impact` → **`rogue_pod_impact`** 로
  바꿨다. 경보 · 낙하 굉음은 `audio/AudioSystem` 이 `rogueDrop:incoming` 을 받아 낸다 — 크기가
  **인지력이 아닌 전용 반경 `ROGUE_DROP_ALERT_RADIUS`(260 m = 인지력 26 m 의 10배)** 기준 거리 감쇠의
  함수이고, 그 곡선은 패너의 감쇠와 겹치면 안 되므로(`panOnly`) audio/ 안에서만 정할 수 있기 때문이다.
  굉음은 예고가 아니라 착지 `ROGUE_DROP_FALL_LEAD_S` 초 전에 난다. 화면은 `ui/hud/RaidAlerts` 의 토스트
  (원래 있었다)와 `ui/hud/DangerIndicators` 의 위험 표시(화면 안 머리 마커 · 밖 방향 호, 같은 반경) —
  2026-09-09 의 `hud/OffscreenIndicators` 화살표는 그리로 옮겨 갔다. **강하 규칙(구역당 1회 · 분대 인원
  비례 · 호스트 권한)은 한 줄도 건드리지 않았다.**

- **2026-09-10 (곡사포 궤적을 시야 안으로)** — "지금 너무 높은 곳에서 날아와서 날아온지도 모름". 정점 높이는
  `0.5 × SHELL_ARC_GRAVITY × (SHELL_FLIGHT_TIME/2)²` 이고 실제 중력 9.81 로는 **48.7 m** 라 포탄이 화면 밖으로
  솟았다가 머리 위에서 떨어졌다 — 경고가 되지 않는다. 리드가 깔아 둔 임시값 2.6(12.9 m)을 실측해 **2 로 확정**
  (정점 **9.9 m**). 근거: 카메라 수직 화각은 70°(= 수평선 위 35°)이고, 표적에서 올려다본 포탄의 앙각은
  `atan(0.5·g·(T−τ)·T / range)` 라 표준 교전거리 `ARTILLERY_RANGE` 63 m 에서 착탄 3초 전 18° · 1초 전 28° ·
  0.5초 전 30° 로 **내려오는 내내 화면 안**이다 (2.6 은 29→35° 라 마지막 1초가 위로 빠진다). 그러면서도 발사각은
  63 m 에서 32°(최대사거리 98 m 22°, 최소 42 m 43°) 라 여전히 곡사포다 — 1.5 아래로 내리면 직사포로 보인다.
  딸린 정리 셋: ① `fx/ShellProjectile` 의 순간 속도 적분이 아직 `GRAVITY` 였다(위치는 낮은 궤적, 속도만 5배
  가파름 → 리본 꼬리 방향이 어긋남) → `SHELL_ARC_GRAVITY` 로. `GRAVITY` import 는 죽어서 지웠다.
  ② **낮은 궤적은 지형에 걸린다.** 걸리면 그 자리에서 터지는 것은 기존 `onShellLanded` 경로 그대로 두고,
  그 자리가 **제 발치**면 포병이 6~9초마다 자살하므로 쏘기 전에 `parts/Attacks.shellArcBlocked` 가 궤적 앞쪽
  75 % 를 현 4개로 훑는다(현은 포물선 아래를 지나 보수적이다; 마지막 하강은 조준점이 땅이라 일부러 안 본다).
  막히면 `fireShell` 이 `false` → `chaseArtillery` 가 굴착을 풀고 옆으로 7 m 옮겨 다시 판다. ③ `HALO_SCALE`
  2.4 → 2.9 (포탄이 하늘이 아니라 지형을 배경으로 오게 되어 실루엣만으로는 묻힌다). 착탄 예고는 손대지 않았다 —
  `SHELL_FLIGHT_TIME` 이 그대로 6.3 s 라 경고음 · `enemy:shellFired` · `ui/hud/ShellMarkers` 의 여유가 같고,
  마커는 이미 `@/shared/ballistics` 의 같은 식을 쓰므로 낮아진 궤적 위에 그대로 붙는다.

- **2026-09-10 (벽에 딱 붙은 채로 쏘지 않는다)** — 원거리 적이 장애물 바로 뒤/옆에 붙어 **벽에다 대고** 쏘고
  있었다. 뿌리는 인지와 사격이 같은 레이를 쓴 것이다: `ai/Perception.hasLineOfSight` 는 **눈** → 가슴이고
  총알은 총구에서 나간다. 새 `ai/FireLine.ts` 가 `fireOrigin`(로그 = 소총 끝 `Enemy.muzzle`, 스퓨어 =
  `headCenter + 0.1`) → 표적 가슴을 따로 검사한다. 레이는 총구에서 `ENEMY_WALL_STANDOFF`(1 m) **뒤**, 제 몸
  안에서 출발한다 — 총구가 이미 벽 안이면 총구 기준 레이는 벽을 만나지 못해 "뚫렸다" 가 되기 때문이고, 이것이
  "장애물과 최소 거리" 규칙의 실체다. 결과는 적별 `ENEMY_FIRE_LOS_S`(0.25 s) 캐시라 매 프레임 · 매 발
  레이캐스트가 아니고, 표적이 바뀌면 `acquireTarget` 이 버린다. 막히면 **사격만 보류**하고 `fireLineStrafe` 로
  옆(표적 수직) 3.5 m 조향 목표를 잡아 비켜선다: 로그는 한 다리(`ENEMY_FIRE_STRAFE_S` 1.5 s)를 못 뚫으면 새
  엄폐물, 스퓨어는 반대쪽, 포병은 위 ②. **이동은 어디서도 막지 않는다** — 문 · 틈을 지나느라 한순간 막히는 것은
  정상이라 그때 굳으면 훨씬 나쁘다(로그 단계 4 돌격은 사격만 멈추고 계속 달린다). 지형 · 장애물만 본다;
  아군 오사(다른 적 관통)는 보지 않는다.

- **2026-09-10 (탈출 웨이브가 분대 인원을 본다)** — 웨이브 표(`6 + 웨이브×2`, 최대 22)는 4인 분대 기준이었다.
  1인 분대가 세 번째 웨이브에서 점프 사냥꾼을 **두 마리** 한꺼번에 받아 사실상 막을 수 없던 것이 계기다.
  `WaveDirector` 가 `RogueDrop.squadSize` 와 **같은 계산**으로 인원을 세고 `WAVE_SQUAD_SCALE[인원−1]`
  (`data/tables.csv`, 1인 0.45 … 4인 1)을 곱한다 (최소 2마리). 구성은 `waveGroup` 의 슬롯이 남은 마릿수로
  잘리므로 저절로 따라온다 — 사냥꾼 슬롯이 하나로 줄어든다. 상시 개체수(`AmbientSpawner`)와 로그 강하는
  손대지 않았다 (로그 강하는 이미 분대 인원별 표를 쓴다).

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (로그 강하)** — `RogueDrop.ts` 신규. 버려진 전진기지 · 연구실 · 선로 플랫폼의 컨테이너를 처음
  조사하면(`structure:investigated`) **호스트가** 그 구역에 대해 딱 한 번 `ROGUE_DROP_CHANCE` 를 굴리고, 성공하면
  로그 분대가 하늘에서 내려온다: 예고(`rogueDrop:incoming` + `rdrop incoming` + `wave_alarm`) → `ROGUE_DROP_ETA_S`
  초 낙하 → 착지(`rogueDrop:landed` + `rdrop landed`) → 스폰 → **트리거 지점으로 진격**.
  인원 · 보스는 **분대 인원**이 정한다 (`ROGUE_DROP_COUNT_MIN/MAX` · `ROGUE_DROP_BOSS_CHANCE`, index 0 = 1명).
  구역당 1회는 두 기록의 합집합이다 — 자체 `used` 집합(호스트의 굴림 + **리플리카가 받은 `rdrop incoming`**, 그래서
  승격된 새 호스트도 안다)과 world/ 가 `struct sync` 로 채워 주는 `StructureDef.rogueDropUsed`.
  진격은 새 코드가 아니라 Phase 12 의 `ai/Investigate.ts` 를 그대로 쓴다(`beginInvestigation`), 도착하면
  `guardPos` = 구조물이라 기존 로그 가드 순찰로 자연스럽게 넘어간다. `EnemyManagerRef.callRogueDrop` /
  `getRogueDrops` stub 이 채워졌고, 디버그 훅 `debugRogueDrops` / `debugInvestigate` 가 붙었다

- **2026-09-09 (지형지물 위 걷기 · 큰 적의 스폰 자리 · 헤드샷)** — 세 가지.
  ① **접지가 `WorldRef.getSurfaceY` 로 옮겨졌다.** `ai/EnemyAI.integrate` 는 XZ 를 옮긴 **직후** 표면을 잡고
  (`pos.y = getSurfaceY(x, z, pos.y)`) **그 다음에** `resolveCollision` 을 부른다 — 순서가 핵심이다. 표면을
  먼저 잡아야 낮은 바위 위로 발이 올라가고, 그러면 `resolveCollision` 이 같은 `PROP_TOP_MARGIN` 판정으로 그
  바위를 밀어내지 않는다. 반대로 하면 밀려난 뒤라 영원히 못 올라간다. 밀려난 뒤 한 번 더 표면을 잡는다.
  헌터의 착지(`getSurfaceY(x, z, position.y)`), `integrateDeathFall`, `Enemy.kill` 의 착지 판정,
  `net/Replica` 의 높이 클램프도 같은 질의로 바뀌어 **바위 위에서 죽으면 바위 위에 눕는다** (호스트/리플리카
  가 같은 함수를 쓰므로 결정적).
  ② **덩치 큰 적의 스폰 여유**(`Spawner.ts`): `needsSpawnClearance` (반경 ≥ `ENEMY_BIG_RADIUS` 0.9 →
  스퓨어 · 포병 · 차저 · 베헤모스 · 로그 보스) 인 종은 `spawnBlocked` 로 자기 반경 ×
  `ENEMY_SPAWN_CLEARANCE_MUL` 원의 `world.obstacleCoverage` 를 재고 `ENEMY_SPAWN_BLOCK_RATIO` 를 넘으면 자리를
  버린다. 재추첨은 `placeMember` 안에서 최대 `ENEMY_SPAWN_RETRIES` 번, 시도할수록 링을 넓혀 막힌 주머니를
  벗어난다. 앰비언트 · 웨이브 · 둥지 스폰이 전부 `spawnGroup` 한 곳으로 모이므로 여기 하나면 되고,
  `spawnGroup` 을 타지 않는 포병만 `maybeArtillery` 에서 같은 검사를 한다. **전부 실패하면 그 한 마리를
  건너뛴다** — 작은 종으로 바꾸지 않는다(구성표가 밸런스의 원본이라 몰래 바꾸면 웨이브 난이도가 달라진다).
  ③ **`Enemy.classifyHit` 이 머리를 먼저 본다.** 베헤모스의 전면 장갑 캡슐(`plateRadius` = 반경 × 0.5,
  머리보다 `head.z + head.r × 0.9` 앞)이 자기 머리 구를 거의 삼키고 있어서, `raycastEx` 가 이미 `'head'` 로
  판정한 측면 · 상방 사격을 `takeDamage` 가 같은 점으로 다시 분류하며 장갑 `'front'` 로 강등시켰다 —
  즉 베헤모스에게는 헤드샷이 없었다. `data/enemies.csv` 가 `headMul` 을 1 → 2 로 올리면서 드러난 문제다.
  정면 사격은 그대로 장갑(광선이 판을 먼저 맞는다)이고, **실제로 머리 구 안에 떨어진 점만** 헤드샷이 된다.

- **2026-09-09 (수치 csv 이관)** — `EnemyTypes.ts` 에 표가 없다. 적 10종의 기본 스탯은 `data/enemies.csv`,
  특수 능력 블록(`HUNTER_LEAP` · `SPEWER_SPIT` · `CHARGER_CHARGE` · `ROGUE_AI` · `ARTILLERY_AI` · `TOXIC_AI` ·
  `BEHEMOTH_AI`)은 `data/enemy_abilities.csv` 의 `block` 단위 표다. 로그가 드는 무기 목록만 문자열이라
  `ROGUE_AI_TEXT` 블록으로 갈라져 있다 (한 블록은 전부 숫자거나 전부 문자열이어야 한다).
  보스 · 베헤모스처럼 상수에서 파생되던 칸은 `=140*ROGUE_BOSS_HP_MUL` 같은 식으로 남아 `constants.csv` 를 따라간다.
  `ENEMY_STATS` · `ROGUE_AI` 등의 export 이름과 모양은 그대로라 읽는 쪽은 바뀌지 않았다

- **2026-09-08 (main 병합)** — `ai/RogueCover.ts` 의 엄폐/사격 지점 오프셋과 크기 필터가 `shotRadius` / `shotHeight`(총알이 멈추는 원기둥, `blockRadius` · `blockHeight`)를 읽는다. 바위 엄폐 수정으로 이동 콜라이더와 갈라진 뒤로 `findPopSpot` 이 양쪽 측면을 모두 '아직 가려짐' 으로 판정해 로그가 엄폐를 아예 잡지 않던 것을 고쳤다

- **tactical kit** — perception scaled by cloak × smoke (`ai/Perception.ts`), lures (`ai/Lures.ts`, `addDistraction`, gunfire noise), deployable targeting (`ai/Structures.ts`), burning / slow status (`applyStatus`), `queryNear`, `applyAreaDamage`

- **Phase 6** — `applyStatus('incinerated')` 전소 (writhing pose on bugs + rogues, `isIncapacitated`, non-combatant, `enemy:incinerated`) / `'shocked'` (slow + cyan sparks, `enemy:shocked`), replica → host status requests via `hit {dmg:0, st, dur}` (`ENEMY_STATUS_BITS`), `EnemyWire.sb` mirrors burning / slowed / 전소 / shocked on replicas

- **Phase 7** — **rogue AI v2** (`ai/RogueCover.ts`: cover must block LOS, flank-angle scoring, `popPos` step-out; magazine `ROGUE_MAG_ROUNDS` → `ROGUE_RELOAD_TIME` reload hint 12; grenade toss after `ROGUE_GRENADE_HOLD_S` without LOS, `fx/RogueGrenade.ts`, `ee grenade / grenadeHit`, hint 13), behemoth scale 3 + remote knockback `dmg.kb`, suspended members stay targets (`ghost:damage`), **live authority** `setAuthority` (replicas → simulated on promotion, adopt on demotion, from `net:hostChanged`), no spawns in a training

- **Phase 9** — **delta `es`** (`SnapshotCache` in `net/HostSync`: monotonic `seq`, keyframe every `NET_ENEMY_KEYFRAME_S` and right after `flow rejoined / takeover`, changed fields only, `gone` list; `ReplicaBuffer.applyWire` merges onto the latest sample, an unknown id without `ty` is ignored), `Enemy.burnAttacker` (DoT kills credit whoever lit the fire, `applyStatus(..., attacker)`, host fills it from the relay `from`), `enemy:killed.by` + a `hitc` kill marker for the credited peer, enemy fire is stopped by a barrier (`raycastBarrier` + `damageBarrier`)

- **Phase 10** — a body that dies **in the air now falls** (`deathVy` carried over from the live `vy` before `kill()` clears `airborne`, integrated + terrain-snapped in **both** `ai/EnemyAI` and `net/Replica` because a replica never `drive()`s a corpse and corpses leave `es` after 1.5 s, capped by `CORPSE_FALL_MAX_SPEED`, corpse registration deferred to the landing or `CORPSE_LAND_TIMEOUT`), **three death directions** (left / right / **back** for bugs and rogues, blended over `DEATH_FALL_TIME`; `BugAnim.rollSign` replaced by a seeded `EnemyDeathDir` so host and replica finally agree, replicated as `ee kill.dd` / `ee corpse.dd`), and **probabilistic corpse looting** (`CORPSE_LOOT_CHANCE` drawn from an *independent* seeded stream so the existing `rollCorpse` selftest vectors do not shift; a corpse that fails registers **no** interactable, `corpse:spawned.lootable`, `ee corpse.lt`)

- **Phase 11** — `world:ready` 에서 `PlanetEcosystem` 을 스포너 / 웨이브 / 로그 가드에 주입 — 기존 위협 게이트(`AMBIENT_GATE` / `WAVE_GATE`)는 그대로 두고 각 슬롯의 실루엣만 `eco.bugs` 가중 추첨으로 뽑으며, 앰비언트 상한 `× eco.pressure`, `maxArtillery` / `maxBehemoth`, 가드 밀도 `× eco.rogues` (`eco.boss:false` 면 보스는 시드 확률). 호스트 권한 · `es` / `ee` 는 불변

- **Phase 12 (2026-09-08)** — `resolveBarrier` 를 지상 적마다 호출(`ctx.implants.resolveBarrierCollision` → 밀려남 + 6초 캐리어 재타겟 + `implant:barrierBumped` ≤ 2 Hz), 근접 피해는 `absorbFrontalAttack` 을 거쳐(피어 소유면 `dmg` 대신 `ee barrierHit`, 수신 측은 `damageBarrier('local', …)`), `reportShot` / `shotq` → `ai/Investigate.ts`(주시 `ENEMY_SHOT_ALERT_WATCH_S` → 전진: 로그는 `pickApproachCover` 엄폐 이동 · 버그는 직진 → `ENEMY_SHOT_ALERT_GIVE_UP_S` 포기, 인지하면 즉시 정상 교전 — 와이어 무변경), `Perception.shotConeFactor`(원점 방향 ±45° 콘 ×`ENEMY_SHOT_ALERT_CONE_MUL`, 은폐 · 연막 계수 유지), `setXray` = `fx/Xray.ts` 빨간 관통 실루엣(GreaterDepth · 공유 머티리얼 · 풀), 실드 배쉬용 내부 `pushBack`(인터페이스 밖)
