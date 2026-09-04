# src/enemies — Terminid-style bug swarms

Owner system: `EnemySystem` (publishes `ctx.enemies`, implements `EnemyManagerRef`). Five bug types with procedural
models/animation, per-type AI, ambient patrol spawning, extraction waves, hit detection and gore FX.
No asset files: every bug is built from primitives with vertex-colored chitin.

| File | Responsibility |
|---|---|
| `EnemySystem.ts` | The `GameSystem`. Pools `Enemy` instances per type, rebuilds the spatial grid each frame, ticks AI only while `ctx.isGameplayPhase()` (visuals always tick), despawns finished corpses (4 s) and fled bugs (2 s). Implements `EnemyManagerRef`: `raycast` (analytic ray vs vertical hit capsule + head sphere, broad-phase by bounding sphere, returns `EnemyHit.part`), `applyExplosion` (linear falloff, returns kills), `setThreatLevel`, `startExtractionWaves` / `stopExtractionWaves`, `killAll` (no stats), `reset`. Listens: `world:ready` (reset + initial patrols), `game:newMission`/`game:abort` (reset; abort also disposes pools & shared geometry), `game:paused`, `weapon:fired` (hearing 55 m), `grenade:exploded` (80 m), `extraction:activated` (idempotent wave start), `extraction:liftoff` (stop waves, bugs within 18 m of the pad flee). Emits all `enemy:*` events, `audio:play`, `camera:shake`, `player:applySlow`. Also the `EnemyHost`/`SpawnHost` services used by the AI and spawners. |
| `Enemy.ts` | Entity implementing `EnemyRef`. Holds gameplay state (hp, state machine fields, timers, charge/leap/spit phases, cached obstacles) and the `BugRig` + `BugAnim`. `takeDamage` classifies the hit (`head` via head sphere, `rear`/`front` via hitDir vs facing) and applies per-type multipliers, hit-flash/flinch, stagger (> 25 % maxHp in one hit), death. `animate()` syncs the rig every frame. `EnemyHost` interface lives here to avoid a circular import. |
| `EnemyTypes.ts` | `ENEMY_STATS` table (hp, speeds, radius/height, melee stats, perception radii, multipliers, mass) plus ability tuning `HUNTER_LEAP`, `SPEWER_SPIT`, `CHARGER_CHARGE`. |
| `SpatialGrid.ts` | Allocation-free uniform XZ hash grid, rebuilt per frame, used for separation queries. |
| `Spawner.ts` | `AmbientSpawner` (threat 0..1 → cap `12 + 24·threat`, patrol every 12–25 s from nests 60–140 m away, initial population on `world:ready`), spawn helpers `findSpawnCenter` (nests → world spawn points → behind player; never < 30 m or in view), `isVisibleToPlayer`, `spawnGroup`, compositions `ambientGroup` / `waveGroup`, and the `SpawnHost` interface. |
| `WaveDirector.ts` | Extraction waves: first wave 3 s after activation, then every 14 s → 9 s; size 6, 8, 10 … (≤ 22), split into 1–3 groups spawned 45–90 m from the target; warriors/spewers from wave 2, a charger at waves 3 and 6+. Emits `enemy:waveStarted`. Alive cap 60 (`WAVE_ALIVE_CAP`). |
| `ai/EnemyAI.ts` | State machine per bug: `idle` → `wander` (near spawn) → `alert` → `chase` → `attack` → `stagger`, plus `dead`/`flee`. Type behaviours: scavenger weave + bite, hunter flanking arc + leap (5–9 m, 22 dmg on landing), warrior heavy claw, spewer keep-distance + arcing acid spit (8–22 m) / melee when close, charger wind-up (0.8 s) → 14 m/s rush (45 dmg, camera shake) → stumble 1.5 s on miss/obstacle. `integrate()` handles steering, separation, obstacle avoidance, `resolveCollision`, terrain snapping, gait phase from distance travelled, footstep audio (warrior/charger), yaw turning, slope conforming. |
| `ai/Steering.ts` | `seek`, `separate` (mass-weighted positional correction via the grid + player push-out), `avoidObstacles` (cached `getObstaclesNear` cylinders), `turnToward`, `yawTo`. |
| `ai/Perception.ts` | Staggered 0.3 s perception tick: sight 40 m with LOS through `ctx.world.raycast`, target loss after 10 s unseen & > 60 m. `becomeAlert` emits `enemy:alerted`, screech audio and propagates to bugs within 20 m. |
| `models/BugParams.ts` | Per-type visual parameters (ellipsoid radii, head/leg dimensions, colours, plates/rings/horns/spikes, stride length). |
| `models/BugModel.ts` | Shared per-type geometry/material assets (created lazily, `disposeBugAssets`). `createBugRig` builds root → body → merged carapace mesh (vertex colours: dark chitin + orange accents), head group (merged head/antennae/horns, emissive eyes, two mandible groups), optional spewer abdomen, six 2-segment legs (hipYaw → hipPitch → knee joints). `animateBug` drives tripod gait, body bob/lean/slope tilt, head tracking, mandible snap, hit flash (per-instance emissive), flinch, spewer abdomen pulse, charger wind-up shake, leap crouch, death roll/leg curl/sink. ~17 meshes per bug (18 spewer); only the body casts shadows. |
| `fx/BloodFX.ts` | Pooled `Points` cloud (1600 green droplets, ring-buffer reuse, gravity + terrain settle) and 40 pooled ground splat decals (radial-gradient `CanvasTexture`, blood or acid) fading over 20 s. |
| `fx/AcidProjectile.ts` | 14 pooled arcing acid globs: ballistic aim at the player's predicted position, hit tests vs player capsule and `world.raycast`/terrain; direct hit 18 dmg + slow, splash 10 dmg; emits `player:applySlow`, `enemy:attacked`, `audio:play('acid_splash')`. |
| `index.ts` | Barrel export. |

## Audio ids emitted
`bug_screech`, `bug_attack`, `bug_death`, `bug_step` (warrior/charger only, ≤ 30 m), `bug_hit`, `acid_splash` — throttled per id.

## Shared contract additions (append-only)
- `types.ts`: `EnemyHit.part?: 'head' | 'body' | 'rear' | 'front'`.
- `events.ts`: `'player:applySlow': { duration: number; factor: number }` (command for the player system; spewer acid).
