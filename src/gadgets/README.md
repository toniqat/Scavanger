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
| `GadgetDefs.ts` | `GADGET_DEFS` (12 item gadgets), `INTERNAL_GADGET_DEFS` (`incendiary` fire zone, no item), `gadgetDef`, `gadgetForKind`, `isInternalGadget`, `deployableIdFor`, `defForWire`, `RECOVERABLE_KINDS`, `ENEMY_TARGET_KINDS`, `SOLID_KINDS` |
| `Deployable.ts` | `Deployable implements DeployableRef`: hp / armed / expiry / per-kind runtime state, `takeDamage` routed to the authority; physical sizes |
| `GadgetVisuals.ts` | Pooled procedural meshes per kind, ring pulses, placement ghosts |
| `ThrownGadget.ts` | Pooled thrown canisters: arc, breaks glass, lands on `getSurfaceY` |
| `parts/Deploy.ts` | `use`, throw / place, `spawnDeployable`, recover interactables, item durability, `igniteGrenadeFire`, `findDownedAlly` |
| `parts/Simulate.ts` | Authority simulation: arming, mines, turret, fire zones, lures, jump pads, player damage |
| `parts/Queries.ts` | Pure queries: `findEnemyTarget`, `findDistraction`, `blocksProjectile`, `visionFactor`, `fireDamageAt`, `jumpPadAt`, `getFireZones`, `groundY` |
| `parts/Remote.ts` | Remote mine (C4): detonation, stacked damage, live cap; `self` / `ally` damage sources |
| `parts/Preview.ts` | `computePlacement` — one function for the ghost preview, left-click placement and the host's re-check (`resolveRemotePlace`) |
| `parts/Mount.ts` | Small deployables riding a drone (`Deployable.mount`); drop to the surface when the drone goes |
| `parts/Wire.ts` | `gad` / `gadq` / `buff` / `flow` handling, full `gad sync` for late joiners and after host migration |
| `drones/DroneSystem.ts` | Drone state + `DronesRef`; frame: input → simulate / interpolate → range → sound / noise → `state` send → camera |
| `drones/model.ts` | `Drone implements DroneRef`, `DroneBody` / `DroneInput`, **yaw convention** (nose = model +Z, forward `(sin, cos)`; `droneYawFromPlayer` = +π) |
| `drones/GroundDrone.ts` | Wheeled body: walk / sprint / jump, surface-then-collision movement |
| `drones/AirDrone.ts` | Hover body: own obstacle push-out, altitude band |
| `drones/parts/Control.ts` | R hold to take control, `DroneInput`, camera override, link range release |
| `drones/parts/Lifecycle.ts` | Deploy, simulation, noise, damage / destroy, explosions, recover, `raycast` |
| `drones/parts/Scan.ts` | Ground-drone scan: highest rarity inside a crate / container / corpse, `drone scan` broadcast |
| `drones/parts/Wire.ts` | `drone` / `droneq` messages, replica interpolation, per-owner sync |
| `index.ts` | Barrel |

## Gadgets

Items: `cloakVeil` (self), `domeShield` (throw), `barricade` · `mine` · `remoteMine` · `turret` · `jumpPad` (place),
`lureGrenade` · `smokeGrenade` (throw), `defib` (target), `droneGround` · `droneAir` (drone).
2026-09-15 — the defib also raises a **downed android** (`findDownedAlly` scans `ctx.allies.getBodies()` with the same
range and the same aim-ray score as the human squad; `DefibTarget.ally` sends `AlliesRef.requestRevive(id, {defib:true})`
instead of `buff revive`). The crosshair gate lives in `weapons/parts/Defib.hasAimedAlly` and scans the same set. The fire zone
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
  `throwModeChanged`), `drone:*` (`deployed`, `damaged`, `removed`, `controlChanged`, `scanned`), `world:noise`.
- **Consumes**: reset events, `world:ready`, `net:hostChanged`, `net:remotePlayerRemoved`, `player:damaged` / `downed` /
  `died` (drone release), `drone:removed`.
- **Wire**: `gad` (host → peers: `spawn` / `update` / `remove` / `fire` / `sync`), `gadq` (client → host: `place {hp?}`,
  `damage`, `recover`, `sync`, `detonate`); ids are `${peer}-g${n}`, assigned by the host. `buff` kinds `revive`,
  `cloak`. `drone` (`spawn` / `state` / `remove` / `sync` / `scan`), `droneq` (`damage` / `sync`). Remote players take
  gadget damage as `dmg` with `src`.

## Rules

- Only `ctx.isAuthority` simulates deployables; non-hosts run arming timers for smooth visuals and take values from `gad update`. — `parts/Simulate.ts`
- Each client applies fire-zone burning to its own player (`setBurning`); the host sends `dmg` only for remote players. — `parts/Simulate.ts` (`updateLocalEffects`)
- `buff` kinds `revive` / `cloak` are handled here, `heal` / `boost` by implants; both pass `buffGuard`. — `parts/Wire.ts` (`onBuff`)
- Preview and placement are the same function; placement height is the judged surface (floor, roof, drone top), never re-snapped to terrain. — `parts/Preview.ts`
- `LARGE_DEPLOYABLE_KINDS` need flat ground + clearance; only `MOUNTABLE_DEPLOYABLE_KINDS` mount on drones (one each); never on moving platforms.
- Fire zones and dropped deployables stand on the walkable surface under the impact point (`getSurfaceY`), not on terrain height. — `parts/Queries.ts` (`groundY`)
- Remote mines never trigger by proximity; one detonation applies stacked damage once per target (strongest hit + rest × `GADGET_REMOTE_MINE_STACK_MUL`), so they do not use the shared area-damage helpers. — `parts/Remote.ts`
- `wearsItemDurability` gadgets (dome shield, barricade): max hp is the item's `durabilityMax`, remaining hp returns to the item on recover and a worn item deploys worn; the host clamps `gadq place hp`. — `parts/Deploy.ts`
- `use()` refuses internal gadgets (else free). — `GadgetDefs.ts` (`isInternalGadget`)
- Drone items are not consumed when deployed (the hand stays a controller); destruction consumes one, recovery none; one drone per kind. — `drones/parts/Lifecycle.ts`
- Drone camera: `setCameraOverride(pos, look, true)` every frame from `update`; release with `setCameraOverride(null, undefined, true)` (hard cut). If `ctx.player.droneControl` turns false on its own, release with `'reset'`. — `drones/parts/Control.ts`
- Air drones skip `resolveCollision` (person headroom pops them out from under ceilings). — `drones/AirDrone.ts`
- Drone `applyExplosion` is called once, by whoever owns the damage (non-owned drones forward `droneq damage`).
- Scan preview rolls exactly what opening rolls (`shared/lootRolls`). — `drones/parts/Scan.ts`

## Recent changes

Last 5 only — older: `git log -- src/gadgets`.
- 2026-09-15 — Defib works on downed androids (`DefibTarget.ally` → `AlliesRef.requestRevive({defib:true})`).
- 2026-09-15 — Dome shield recover; dome / barricade carry item durability; fire gadget merged into internal `incendiary`; defib picks the ally nearest the aim ray.
- 2026-09-15 — Explosion damage uses the shared two-step falloff (`shared/explosion`).
- 2026-09-15 — Player damage from deployables carries a `self` / `ally` source.
- 2026-09-15 — Fire zones on the impact surface, `getFireZones`, fire sounds, drone burn damage.
- 2026-09-13 — Preview, drone control and drone deploy blocked while riding a rover.
