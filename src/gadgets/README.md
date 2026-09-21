# gadgets/ — consumable gadgets, deployables and drones

`GadgetSystem` publishes `ctx.gadgets` (`GadgetsRef`, `src/shared/gadgets.ts`) and owns `GADGET_DEFS` (items only point
at gadgets through `ItemDef.gadgetId`). Deployables are **host-authoritative**. `DroneSystem` (`drones/`) publishes
`ctx.drones` (`DronesRef`, `src/shared/drones.ts`); drones are **owner-authoritative**. Registered after inventory /
meta, `DroneSystem` right after `GadgetSystem` (`src/main.ts`). No lights anywhere.

## Files

| File | Responsibility |
|---|---|
| `GadgetSystem.ts` | System + `GadgetsRef`; per-frame order; one-line delegates to `parts/`. Re-exports `model.ts` |
| `model.ts` | Folder vocabulary: `MAX_DEPLOYABLES`, placement / turret tuning, scratch vectors split by purpose |
| `GadgetDefs.ts` | `GADGET_DEFS` (13 item gadgets), `INTERNAL_GADGET_DEFS` (`incendiary` fire zone, no item), `gadgetDef`, `gadgetForKind`, `isInternalGadget`, `deployableIdFor`, `defForWire`, `RECOVERABLE_KINDS`, `ENEMY_TARGET_KINDS`, `SOLID_KINDS` |
| `Deployable.ts` | `Deployable implements DeployableRef`: hp / armed / expiry / per-kind runtime state, `takeDamage` routed to the authority; physical sizes |
| `GadgetVisuals.ts` | Pooled procedural meshes per kind, ring pulses, placement ghosts |
| `ThrownGadget.ts` | Pooled thrown canisters: arc, breaks glass, lands on `getSurfaceY` |
| `parts/Deploy.ts` | `use`, throw / place, `spawnDeployable`, recover interactables, item durability, `igniteGrenadeFire`, `findDownedAlly` |
| `parts/Simulate.ts` | Authority simulation: arming, mines, turret, fire zones, lures, jump pads, player damage |
| `parts/Queries.ts` | Pure queries: `findEnemyTarget`, `findDistraction`, `blocksProjectile`, `visionFactor`, `fireDamageAt`, `jumpPadAt`, `getFireZones`, `groundY` |
| `parts/Remote.ts` | Remote mine (C4): detonation, stacked damage, live cap; `self` / `ally` damage sources |
| `parts/Preview.ts` | `computePlacement` — one function for the ghost preview, left-click placement and the host's re-check (`resolveRemotePlace`) |
| `parts/Mount.ts` | Small deployables riding a drone (`Deployable.mount`); drop to the surface when the drone goes |
| `parts/Thumper.ts` | 진동 장치 (thumper): strikes counted from `age` on every client (`tick` — dust ring · `thumper_thump` · nearby `camera:shake`), the host's one-shot `sandworm:summon` on strike `THUMPER_STRIKES`, `onErupted` (eruption radius destroys them) |
| `parts/Wire.ts` | `gad` / `gadq` / `buff` / `flow` handling, full `gad sync` for late joiners and after host migration |
| `drones/DroneSystem.ts` | Drone state + `DronesRef`; frame: input → simulate / interpolate → range → sound / noise → `state` send → camera |
| `drones/model.ts` | `Drone implements DroneRef`, `DroneBody` / `DroneInput`, **yaw convention** (nose = model +Z, forward `(sin, cos)`; `droneYawFromPlayer` = +π) |
| `drones/GroundDrone.ts` | Wheeled body: walk / sprint / jump, surface-then-collision movement |
| `drones/AirDrone.ts` | Hover body: own obstacle push-out, altitude band |
| `drones/parts/Control.ts` | R hold to take control, `DroneInput`, camera override, link range release |
| `drones/parts/Lifecycle.ts` | Deploy, simulation, noise, damage / destroy, explosions, recover, `raycast` |
| `drones/parts/Scan.ts` | Ground-drone scan: highest rarity inside one of the five `DroneScanTargetKind` targets — map crate (`crate`) · structure container (`container`) · enemy corpse (`corpse`) · squadmate corpse (`playerCorpse`) · supply crate (`supply`) — plus the `drone scan` broadcast |
| `drones/parts/Wire.ts` | `drone` / `droneq` messages, replica interpolation, per-owner sync |
| `index.ts` | Barrel |

## Gadgets

Items: `cloakVeil` (self), `domeShield` (throw), `barricade` · `mine` · `remoteMine` · `turret` · `jumpPad` · `thumper` (place),
`lureGrenade` · `smokeGrenade` (throw), `defib` (target), `droneGround` · `droneAir` (drone).
2026-09-15 — **`thumper` (진동 장치, item `gad_thumper`)**: a Dune-style thumper. Placed only where `WorldRef.burrowGroundOk(x, z,
THUMPER_GROUND_R)` is true (preview red + `R_BURROW` otherwise; the host re-checks in `resolveRemotePlace`); strikes the ground every
`THUMPER_INTERVAL_S` on every client (phase from the deployable's `age`, replicas get `DeployableWire.age`); on strike `THUMPER_STRIKES` the
host emits `sandworm:summon {source:'thumper'}` once and the device keeps thumping forever (placement is allowed even after the worm
appeared). Not recoverable (`recoverTime` 0, not in `RECOVERABLE_KINDS`), one use, `THUMPER_HP`; `sandworm:erupted` destroys every
thumper inside its radius. Found only in **amber outpost basement** containers (`structures.csv` `basementBonus*` → `ContainerSpec.bonusDefId`).
2026-09-15 — the defib also raises a **downed android** (`findDownedAlly` scans `ctx.allies.getBodies()` with the same
range and the same aim-ray score as the human squad; `DefibTarget.ally` sends `AlliesRef.requestRevive(id, {defib:true})`
instead of `buff revive`). The crosshair gate lives in `weapons/parts/Defib.hasAimedAlly` and scans the same set.
2026-09-21 — the defib also raises a **shouldered** body. A carried squadmate's own `RemotePlayerRef.position` is a stale
snapshot (the contract says to ignore it while `isCarried`), so `findDownedAlly` stands the **carrier's** position in for it
(`carrierPositionOf`: the local player · another peer · an android through `AlliesRef.carrierOf`), and a body on **our own**
shoulder scores as aimed outright — nobody can put a crosshair on their own back. `useDefib` then puts it down with
`PlayerRef.dropCarried('revived')` before the pulse, so the shoulder pose never flickers waiting for their snapshot.
`weapons/parts/Defib.carrierPositionOf` is the same lookup and must move with this one. The fire zone
(`incendiary`, kind `fire`) has no item: weapons lights it where an incendiary grenade explodes
(`GadgetsRef.igniteGrenadeFire`). Numbers are `GADGET_*` / `GRENADE_INCENDIARY_*` / `DRONE_*` keys in `data/constants.csv`.

## Public API

- **`ctx.gadgets`**: `getDefs`, `getDef`, `getDeployables`, `use(id, underhand?)`, `recover(id)`, `clear`,
  `blocksProjectile(from, to, fromEnemy)` (weapons), `visionFactor` · `findEnemyTarget` · `findDistraction` (enemies),
  `fireDamageAt`, `jumpPadAt`, `placement?` (preview state), `detonateRemoteMines?` · `liveRemoteMineCount?` (weapons'
  detonator hand), `getFireZones?` (HUD danger indicators), `igniteGrenadeFire?`.
- **`ctx.drones`**: `getDrones`, `getDrone`, `getOwnDrone`, `controlled`, `controlHold`, `deploy`, `releaseControl`,
  `raycast`, `damageDrone`, `applyExplosion`, `clear`, `scanHold?`, `scanAim?`, `getScanResults?`.
- **Emits**: `gadget:*` (`used`, `deployed`, `damaged`, `removed`, `recovered`, `detonated`, `placementChanged`,
  `throwModeChanged`), `drone:*` (`deployed`, `damaged`, `removed`, `controlChanged`, `scanned`), `world:noise`,
  `sandworm:summon` (host only, thumper), `camera:shake` (thumper strikes).
- **Consumes**: reset events, `world:ready`, `net:hostChanged`, `net:remotePlayerRemoved`, `player:damaged` / `downed` /
  `died` (drone release), `drone:removed`, `sandworm:erupted` (authority destroys thumpers in the radius).
- **Wire**: `gad` (host → peers: `spawn` / `update` / `remove` / `fire` / `sync`), `gadq` (client → host: `place {hp?}`,
  `damage`, `recover`, `sync`, `detonate`); ids are `${peer}-g${n}`, assigned by the host. `DeployableWire.age` (thumper only)
  carries the strike phase — no per-strike message. `buff` kinds `revive`,
  `cloak`. `drone` (`spawn` / `state` / `remove` / `sync` / `scan`), `droneq` (`damage` / `sync`). Remote players take
  gadget damage as `dmg` with `src`.

## Rules

- Only `ctx.isAuthority` simulates deployables; non-hosts run arming timers for smooth visuals and take values from `gad update`. — `parts/Simulate.ts`
- Enemy queries answer **what fights back**: `enemiesNear` / `enemyById` drop `EnemyRef.isEgg` bodies (nest eggs) unless a caller
  passes `includeProps`, because every gadget that uses them is picking a target or waiting for contact. Known consequence: the
  fire zone's burn and the C4 accumulation share that query, so they do not damage eggs either — eggs are still destroyed by
  bullets, melee, grenades and the mine blast (`damageEnemies` → `applyAreaDamage`, a different path). — `parts/Queries.ts`
- Each client applies fire-zone burning to its own player (`setBurning`); the host sends `dmg` only for remote players. — `parts/Simulate.ts` (`updateLocalEffects`)
- `buff` kinds `revive` / `cloak` are handled here, `heal` / `boost` by implants; both pass `buffGuard`. — `parts/Wire.ts` (`onBuff`)
- Preview and placement are the same function; placement height is the judged surface (floor, roof, drone top), never re-snapped to terrain. — `parts/Preview.ts`
- `LARGE_DEPLOYABLE_KINDS` need flat ground + clearance; only `MOUNTABLE_DEPLOYABLE_KINDS` mount on drones (one each); never on moving platforms.
- The thumper's ground test is world's (`WorldRef.burrowGroundOk`, the same function as the worm director's eruption-site check); missing = refused everywhere. Strikes are never sent — every client counts them from `age`; only the authority emits `sandworm:summon`, once per device. — `parts/Thumper.ts`, `parts/Preview.ts` (`burrowGroundOk`)
- Fire zones and dropped deployables stand on the walkable surface under the impact point (`getSurfaceY`), not on terrain height. — `parts/Queries.ts` (`groundY`)
- Remote mines never trigger by proximity; one detonation applies stacked damage once per target (strongest hit + rest × `GADGET_REMOTE_MINE_STACK_MUL`), so they do not use the shared area-damage helpers. — `parts/Remote.ts`
- `wearsItemDurability` gadgets (dome shield, barricade): max hp is the item's `durabilityMax`, remaining hp returns to the item on recover and a worn item deploys worn; the host clamps `gadq place hp`. — `parts/Deploy.ts`
- `use()` refuses internal gadgets (else free). — `GadgetDefs.ts` (`isInternalGadget`)
- Drone items are not consumed when deployed (the hand stays a controller); destruction consumes one, recovery none; one drone per kind. — `drones/parts/Lifecycle.ts`
- Drone camera: `setCameraOverride(pos, look, true)` every frame from `update`; release with `setCameraOverride(null, undefined, true)` (hard cut). If `ctx.player.droneControl` turns false on its own, release with `'reset'`. — `drones/parts/Control.ts`
- Air drones skip `resolveCollision` (person headroom pops them out from under ceilings). — `drones/AirDrone.ts`
- Drone `applyExplosion` is called once, by whoever owns the damage (non-owned drones forward `droneq damage`).
- Scan preview rolls exactly what opening rolls (`shared/lootRolls`). — `drones/parts/Scan.ts`
- **Intended** (2026-09-15): the thumper's knocking attracts nobody — it emits no `world:noise`, and enemies never
  target the device (outside `ENEMY_TARGET_KINDS`). Changing either needs a decision first. — `parts/Thumper.ts`
- `ENEMY_TARGET_KINDS` · `SOLID_KINDS` (`GadgetDefs.ts`) are **the** lists: `parts/Queries.findEnemyTarget` ·
  `blocksProjectile` test against them (as sets), so adding a kind changes behaviour. A kind added to `SOLID_KINDS`
  still needs its own silhouette branch in `blocksProjectile`, or it blocks nothing. — `parts/Queries.ts`
- `DroneRef.mountedDeployableId` is **derived, never written**: `Drone` (`drones/model.ts`) computes it by scanning
  `GadgetsRef.getDeployables()` for `mount === drone.id`, so setting `Deployable.mount` is the whole write.
  — `parts/Mount.ts`
- Drone noise is host-owned and `Lifecycle.emitNoise` **guards itself** (`ctx.isAuthority` inside), so a new caller
  cannot make every client emit `world:noise`. — `drones/parts/Lifecycle.ts`
- The placement preview's `burrowGroundOk` radius is ours; the worm director uses `BURROW_GROUND_CHECK_R` (6 m). A summon
  skips the ground test, so a mismatch never gives "it placed but nothing came" — only a preview stricter or looser than
  the eruption check. — `parts/Preview.ts`
- **Intended**: a drone scan label never reaches a late joiner — `drone scan` goes out once to `others` at scan time and
  has no sync request. — `drones/parts/Scan.ts`

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **The thumper may be placed after the worm already appeared** (the summon is ignored). Rejected: refusing placement. Not recoverable;
  strikes carry no wire (counted from `age`).

## Recent changes

Last 5 only — older: `git log -- src/gadgets`.
- 2026-09-21 — The defibrillator reaches a **shouldered** downed player: `findDownedAlly` reads the carrier's position for a carried body (`carrierPositionOf`) and treats one on our own shoulder as aimed; `useDefib` drops it with `dropCarried('revived')`.
- 2026-09-19 — Audit B-55 · B-56 · B-57: comments matched to the code (fire merge · `-gf` · `burrowGroundOk` · `CENTER_Y` · mount ownership), `model.PLACE_DISTANCE` and the copied import blocks removed, the dead `setDroneMountId` setter deleted, `Queries` now reads `ENEMY_TARGET_KINDS` / `SOLID_KINDS`, `emitNoise` guards itself, the container scan preview rolls once with the spec id, `GroundDrone.raycast` got `AirDrone`'s `disposed` contract.
- 2026-09-19 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched.
- 2026-09-18 — `enemiesNear` / `enemyById` leave nest eggs out by default (`includeProps` opts back in): a turret no longer burns its ammo on a `bug_egg` and a mine laid at a nest is not tripped by one (`parts/Queries.ts`).
- 2026-09-18 — Mine / remote mine / drone blast damage skips bodies behind walls, roofs and floors (`shared/explosion.blastReachesBody`); deployables are exempt (their body is the collider).