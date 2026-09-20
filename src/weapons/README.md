# weapons/ — guns, grenades, consumables in hand, legendary uniques, weapon FX

`WeaponSystem` (`name: 'weapons'`) runs the local player's two weapon slots, the quick-use hand (consumables, grenades,
gadgets, the remote-mine detonator, drone controllers), melee hit resolution, legendary unique weapons and every weapon
FX. It publishes `ctx.weapons` (`WeaponsRef`: `getGrenades()`, `remoteState`) and reaches the player through
`ctx.player` narrowed to `PlayerRef & PlayerWeaponHost` (`src/shared/types.ts`). Remote players' weapons are
presentation only (`RemoteWeapons`); enemy damage from other clients goes through the host in enemies/.

## Files

| File | Responsibility |
|---|---|
| `WeaponSystem.ts` | `GameSystem`: init / bus + net subscriptions, per-frame order (holster → gates → melee → quick key → swap → reload / hand / unique / trigger → pose → remote state → throw arc → aim-block marker → laser), `ctx.weapons`, `applyHit` wrapped in `withLocalGunHit`. One-line delegates to `parts/`. Re-exports `model.ts` |
| `model.ts` | Folder vocabulary: `WeaponInstance`, `HitInfo`, `QuickHand` / `QuickKind`, non-csv tuning, `useTimeOf(def)` (hold time of a consumable / gadget), `quickKindOf(def)` (grenade vs gadget vs stim), scratch vectors |
| `WeaponDefaults.ts` | `WEAPON_SLOTS` (`primary`, `primary2`), fallback rifle / pistol defs, `defaultFor`, `statsFromDef`, `shotPitchFor`, `STANCE_ACCURACY`, `isUniqueKind`. `kindOf` (silhouette family) / `shotSoundId` / `WeaponKind` are **delegates to `shared/shotSounds.ts`** — the one table player/ reads for android guns too |
| `parts/Slots.ts` | Slot state: `onLoadout`, effective stats (`resolveStats`), magazine / reserve / durability persistence, socket changes (returns excess rounds), `autoFeed` (bow), swap |
| `parts/Firing.ts` | Trigger → shot: durability, spread (stance × bloom × movement), recoil, hitscan or projectile launch, `applyHit` (barrier bill, shell intercept, armour ricochet, destructible cover), reload, bolt cycle, aim zoom + aim sway hand-off, `recoilMulFor` / `reloadSpeedFor`, hitmarker merge |
| `parts/AimLine.ts` | `ShotResolver` — which line a shot follows (hybrid crosshair / muzzle resolution, below); `updateAimBlock` drives the red marker and `weapon:aimBlocked` |
| `parts/QuickUse.ts` | T tap / hold wheel, equip / leave / drop the item in hand, `useGadget`, remote-mine detonation and the detonator hand, `carryGate` |
| `parts/Healing.ts` | Hold-to-use consumables (heal, shield charger, combat boosts, timed gadgets), heal spray channel, `item:channelChanged`, consumable slow |
| `parts/Defib.ts` | Defibrillator: charge, aim at a downed ally, fire on release (`gadget:defibAim`); a **shouldered** body is aimed through its carrier (`carrierPositionOf`) |
| `parts/AllyHeal.ts` | Right-button use of a heal item / 실드 충전기 **on a squadmate or an android**: what it gives (`allyGiftOf`), aim pick (`pickAllyTarget`), the hold, `buff heal` / `shield` or `AlliesRef.heal` / `chargeShield`, `heal:allyTargetChanged` / `allyHoldChanged` |
| `parts/Throwing.ts` | Grenade hold / cook (R) / overhand or underhand throw, in-hand explosion, `grenade:countChanged` |
| `parts/Services.ts` | `UniqueServices` object — the only way `unique/` reaches the world (mag, drain, hitscan, aim, recoil, feed …) |
| `AimSway.ts` | Per-class sway amplitude / frequency from `data/aim_sway.csv`, handed to `PlayerWeaponHost.setAimSway` (the rig does the motion) |
| `Attachments.ts` | Attachment def ids → `WeaponAttachmentVisuals` for local and remote models; `attachmentIdsOf`, `sameIds` |
| `Blocking.ts` | `raycastBlockers` (implant barriers + solid deployables, pure) and `damageBarrierAt` |
| `Grenade.ts` | `GrenadeManager`: pooled frags (bounce, `getSurfaceY` floor, breaks glass), explosion via `enemies.applyExplosion` + local-player damage with `shared/explosion`, incendiary variant lights a fire zone, `getViews()` |
| `Melee.ts` | `MeleeController`: hit resolution for the light swing (player owns stamina / cooldown / pose via `startMelee`) |
| `Projectile.ts` | `ProjectilePool`: swept projectiles for every gun round and unique body (bullet / shuriken / arrow / rocket), gravity, carried falloff, glass pass-through, instanced streaks, flight trails |
| `RemoteWeapons.ts` | Multiplayer replay: remote weapon models in avatar sockets, replicated fire / reload / grenade / melee FX, unique replays (`onFireMessage`), attachment sync, visual-only projectiles |
| `WeaponModel.ts` | Procedural weapon meshes per family + six unique silhouettes, attachment meshes, laser sight, reload / draw / bolt / bow animations |
| `unique/UniqueHandler.ts` | Contract between the system and a unique: `UniqueHandler`, `UniqueInput`, `UniqueServices`, `coneTargets`, `coneDestructibles` |
| `unique/UniqueFx.ts` | Pooled flame cones and lightning arcs (local + remote owners) |
| `unique/Flamethrower.ts` · `Shockgun.ts` · `Shuriken.ts` · `Bow.ts` · `Bazooka.ts` · `Minigun.ts` | The six handlers (table below); `Bow.ts` exports `bowBallistics` |
| `unique/index.ts` | `createUniqueHandler(kind, services)` + re-exports |
| `fx/WeaponFx.ts` | Muzzle flash (shared `FlashPool`), casings, impacts, ichor, explosions, grenade LED blink, `warmUp` fallback |
| `fx/ThrowArc.ts` | Throw preview: pure parabola ribbon from the release point, cut at `THROW_ARC_PREVIEW_FRACTION`, no collision |
| `fx/AimBlockMarker.ts` | Red ring on the surface where a blocked shot will land |
| `index.ts` | Barrel (also aliases `GRENADE_RADIUS` / `GRENADE_DAMAGE` from shared) |

## Slots, stats, ammo, durability

- **Slots**: `primary` / `primary2` (`WEAPON_SLOTS`); keys `Keys.PRIMARY` / `Keys.PRIMARY2`. `WeaponSlot` still lists
  `secondary` and `Keys.SECONDARY` still exists (add-only contract), but nothing fills or reads them. If no
  `loadout:changed` arrives within `LOADOUT_FALLBACK_DELAY` of `world:ready`, the built-in rifle is equipped.
- **Effective stats**: `ctx.loot.getEffectiveStats(inst)` (grade + sockets) → `statsFromDef(def)` fallback. Distance
  falloff uses `damageFalloffStats(stats, d)` from `@/items`, not the raw def. Re-read on equip, `loadout:changed` with the
  same uid and `inventory:socketChanged`.
- **Durability**: each trigger pull (a shotgun pull counts once) subtracts `WEAPON_DURABILITY_PER_SHOT` and persists via
  `inventory.updateItem`; at 0 the trigger only emits `weapon:broken` + `dry_fire` + a throttled toast.
- **Ammo**: magazine = `inst.ammoInMag`; reserve = `inventory.countWhere` of ammo items with the weapon's `ammoType`;
  reload consumes rounds at the end of `reloadTime`. `ammoInMag` / `durability` are written on every shot, reload end,
  swap-out, holster and abort.
- **The reload is held, not thrown away** (2026-09-21, user's decision). A momentary action that leaves the gun in
  the hands **freezes** the reload where it stood and it continues from that point — the V **roll** (polled every
  frame as `PlayerWeaponHost.isDiving`, so a cancelled roll releases it too) and the 갈고리 wire being out
  (`implant:grappleFired` … `implant:grappleReleased`). `WeaponSystem.reloadPauses` is the reason set,
  `parts/Firing.setReloadPause` the only way in, and `weapon:reloadPaused` / `weapon:reloadResumed` tell the
  crosshair ring apart from a real `weapon:reloadCancelled`. 대시 needs nothing: it is a one-frame teleport, so the
  reload simply runs through it. **Cancels** stay cancels — weapon swap, a consumable taken into the hand, melee,
  loadout change, a wielded 배리어 (`blocksWeapons` → holster) and an 오버차지 channel starting
  (`implant:activated {id:'overcharge'}` — the rising edge, not `implant:overcharge`, which is re-sent on every
  beam target change). **Intended**: drone control and a rover seat neither hold nor cancel it — the reload runs
  on, which is what they always did.
- **Holster**: phases `hub` / `docking` / `menu`, a wielded implant (`ctx.implants.blocksWeapons`) or being downed hide the
  model and force an unarmed pose. A weapon key while an implant is wielded calls `ctx.implants.stow()` then swaps.
- **Input gates** (`usable`): gameplay active + pointer lock + `canUseWeapons()` + not diving + no armed / targeting
  ship call + not latched by drone control or rover ride (`droneLatch` stays until LMB / RMB / R are released).

## Shot resolution (hybrid)

`parts/AimLine.ShotResolver` decides every shot, the red marker and the crosshair warning (same function, so the preview
never lies): the crosshair line starts at muzzle depth (`P0`); if the barrel is inside a wall or the muzzle → aim point
segment is blocked within `WEAPON_MUZZLE_BLOCK_RANGE`, the shot lands there (`near`); if `P0` is not visible from the
muzzle it converges from the muzzle (`converge`); otherwise it follows the crosshair line (`line`). Muzzle flash,
tracers and the `fire` message still use the real muzzle.

Every ordinary gun round is a swept projectile (`stats.projectileSpeed > 0`; `near` hits and speed 0 are instant):
gravity `stats.bulletGravity`, falloff from distance travelled, per-step `raycastAll` (enemies, world, interceptable
shells, barriers / deployables), pellets merged into one hitmarker per pool step (`Firing.flushHitmarker`).

## Quick-use hand

- `Keys.QUICK` tap = last used wheel item (toggle back to the gun), hold ≥ `QUICK_WHEEL_HOLD` = 8-way wheel
  (`quick:wheelChanged`, look locked). `quickKindOf` separates grenades (`ItemDef.grenade`) from gadgets.
- **Grenade**: LMB hold → R pulls the pin (cook, `grenade:holdChanged` with fuse) → release throws, RMB toggles underhand;
  cooking to `GRENADE_COOK_MAX` explodes in hand. Incendiary grenades (`ItemDef.grenadeFire`) use the small blast and,
  on a local explosion only, call `ctx.gadgets.igniteGrenadeFire`.
- **Hold-to-use** (`useTimeOf` > 0: `ItemDef.heal.useTime`, shield chargers, combat boosts, `gadgetUseTime`): LMB hold under
  `CONSUMABLE_SLOW_MUL`, `heal:holdChanged {t, dur}`; finish → `applyHeal` / `chargeShield` / `applyBoost` /
  `ctx.implants.refillAll` / `ctx.gadgets.use`. Perk `quick_heal` halves hold times. Shield chargers do not start when
  the shield is full or absent (`canChargeShield`).
- **Heal spray**: channel with a durability gauge, heals self + allies in radius (batched `buff heal`, line-of-sight
  checked); an empty can is never consumed. `item:channelChanged` always ends with `active:false`.
- **Defibrillator** (`parts/Defib`): charge → keep holding → aim a downed ally (`GADGET_DEFIB_RANGE`, `DEFIB_AIM_CONE_DEG`)
  → release revives through `ctx.gadgets.use('defib')`; releasing without a target consumes nothing. 2026-09-21: a
  **shouldered** body counts — its own snapshot position is stale, so the carrier's stands in, and one on *our* own
  shoulder is aimed outright (`carrierPositionOf`, the twin of gadgets' `findDownedAlly.carrierPositionOf`).
- **Ally heal** (`parts/AllyHeal`, 2026-09-21): with `붕대` · `약초 붕대` · `회복주사` or one of the three
  `실드 충전기` in hand **LMB = on myself** and **RMB = on the squadmate on the crosshair** — smallest angle off the
  aim ray inside `HEAL_ALLY_AIM_CONE_DEG`, start inside `HEAL_ALLY_RANGE_START`, the running hold survives to
  `HEAL_ALLY_RANGE_HOLD` (and past it cancels, consuming nothing). **No `CONSUMABLE_SLOW_MUL`** on the ally use.
  `allyGiftOf` says what the item gives (`'heal'` hp / `'shield'` points, **−1 = fill the pool up**, the same −1 the
  wire and `AlliesRef.chargeShield` use), and a body the gift could do nothing for is not a target at all.
  **Two apply paths**: a person gets one `buff` (`heal` / `shield`) cleared by the receiver's guard
  (`shared/buffRules`, `shield` has its own token bucket) and applied by `implants/parts/Wire.onBuff`; an
  **android** goes through `AlliesRef.heal` / `chargeShield`, which are called **before** `consumeQuick` because
  they return false when there is nothing to do and a refusal must leave the item in the bag. A **downed** body is
  not a target either way (that is the defibrillator's job). With nothing valid on the crosshair the button is
  *shown* unavailable (`heal:allyTargetChanged {name, inHand, kind}` → `ui/hud/HealGauge`'s `.heal-ally` chip),
  never silent; the chip hides entirely only when there is no squadmate and no android at all.
- **Gadgets**: LMB = `ctx.gadgets.use`; RMB toggles throw mode, detonates remote mines (C4) or does nothing for drone
  controllers. Placing the last C4 turns the hand into a detonator (`remoteState.detonator`). Drone items stay in hand.
- **Carry gate**: any weapon input while carrying a squadmate calls `ctx.player.dropCarried('action')` and ends the frame.

## Legendary uniques

A slot whose def has `unique` gets a `UniqueHandler`. RMB is alt fire for all six (never ADS); R still reloads (except
the bow). Uniques get no weapon-class mastery bonus and are not class kills. Numbers: `FLAME_*`, `SHOCK_*`,
`SHURIKEN_*` / `SLASH_*`, `BOW_*`, `BAZOOKA_*`, `MINIGUN_*` in `data/constants.csv`, defs in `data/weapons_unique.csv`.
Uniques reuse existing shot SFX ids (`shared/shotSounds.ts` `shotSoundId`, re-exported here); there are no dedicated
samples, and an android holding a unique plays the same id (player/ reads that table too). Flame and arc never damage
players.

| Handler | LMB | RMB | Notes |
|---|---|---|---|
| `Flamethrower` (`u_flame`) | Cone DPS + burning + burnout → `incinerated` | Long jet | Fuel drain / durability per second; status kills credit the shooter; flame visuals bloom in and breathe |
| `Shockgun` (`u_shock`) | Arcs to nearest enemies in cone + `shocked`; in training also hits destructible targets; empty cone draws fizzle forks | Hold to charge, release = bolt | `weapon:chargeChanged {kind:'charge'}` |
| `Shuriken` (`u_shuriken`) | One star projectile | Three-star fan | Melee key hold ≥ `SLASH_HOLD_TIME` = heavy slash (`startMelee('heavy')`, `player:slashed`) |
| `Bow` (`u_bow`) | Hold = draw, release = arrow; draw → speed / drop / damage via `bowBallistics` | Cancel draw | `autoFeed`: magazine 1 refilled from carried arrows, never reloads; `weapon:chargeChanged {kind:'draw'}` |
| `Bazooka` (`u_bazooka`) | Impact rocket (explosion + destructible cover) | Air-burst rocket | No self damage: knockback; airborne (read before the knockback) with the blast below = rocket jump (`BAZOOKA_SUPER_JUMP` + `BAZOOKA_JUMP_FORWARD`, `player:blastJump`). Throw distance ×`BAZOOKA_KNOCKBACK_DIST_MUL`, knockback ×`BAZOOKA_GROUNDED_DIST_MUL` again when grounded (√ on speeds); a grounded blast never rocket-jumps |
| `Minigun` (`u_minigun`) | Spin up, then regular `fire()` | Hold spin without firing | `setSpeedModifier('minigun', …)` while spinning |

## Public API

- **`ctx.weapons`**: `getGrenades()` (HUD indicators), `remoteState` (held item, throwing / cooking / charging /
  spraying / heavy, attachment ids; mutated in place, read by net's snapshot builder).
- **Emits**: `weapon:equipped`, `ammoChanged`, `fired`, `dryFire`, `reloadStarted`, `reloadFinished`,
  `reloadCancelled`, `reloadPaused`, `reloadResumed`, `hit`, `scopeChanged`, `durabilityChanged`, `broken`,
  `swapStarted`, `chargeChanged`,
  `beamChanged`, `altFired`, `aimBlocked`; `quick:wheelChanged` / `equipped` / `used`; `grenade:holdChanged` /
  `thrown` / `exploded` / `countChanged`; `heal:holdChanged`, `heal:allyTargetChanged`, `heal:allyHoldChanged`;
  `item:channelChanged`; `gadget:defibAim`;
  `gadget:throwModeChanged`; `melee:hit`; `player:slashed`; `player:blastJump`; `ui:hitmarker`; `camera:shake`;
  `audio:play`; `ui:notify`.
- **Consumes**: `loadout:changed`, `inventory:itemUpdated` / `socketChanged` / `changed` / `quickSlotsChanged`,
  `world:ready`, `game:abort`, `game:newMission`, `hub:entered`, `game:phaseChanged`, `player:died`, `player:downed`,
  `melee:swing`, `net:remoteFired` / `remoteReloaded` / `remoteGrenade` / `remotePlayerRemoved`,
  `implant:grappleFired` / `grappleReleased` / `activated` (the reload hold · the 오버차지 cancel).
- **Calls**: `ctx.enemies.reportShot` once per trigger pull (projectiles report their own impact; replays report
  nothing); `ctx.implants.damageBarrier` (via `damageBarrierAt`); `ctx.gadgets.blocksProjectile` (via `raycastAll`).
- **Wire** (`src/shared/net.ts`): sends `fire {w, o, d, m?, c?}` (one per trigger pull; uniques add mode / charge),
  `reload {w}`, `grenade {p, v, fuse, fire?}`, `melee`, `buff heal` (the spray, and the right-button ally use),
  `buff shield` (a 실드 충전기 given to a squadmate; `amount` −1 = fill up). Receives raw `fire` (unique replay)
  and `melee`.

## Rules

- Grenade hitch: never add lights to grenades / FX; flashes go through the shared `FlashPool` (a changing light count recompiles every shader). — `Grenade.ts`, `fx/WeaponFx.ts`
- `WeaponFx.warmUp` runs only when `ctx.shaders` is absent; core shader warm-up owns compilation. — `WeaponSystem.ts` (`update`)
- New shooting code uses `sys.aim.begin` / `resolve` (projectiles: `aimShot`); never raycast from the muzzle directly, or the red marker and the hit disagree. — `parts/AimLine.ts`
- New projectile callers pass `report: false` and call `reportShot` once per trigger pull (pellets would flood the host). — `Projectile.ts`
- Gun damage paths go through `WeaponSystem.applyHit` so `withLocalGunHit` stamps the weapon class for NPC quest class kills; uniques pass `null`. — `WeaponSystem.ts`
- A shot that really stops on a barrier bills it exactly once (`damageBarrierAt`); speculative barrier raycasts are free. — `Blocking.ts`
- Remote grenade explosions hurt the local player; the incendiary type comes from the `grenade` message's `fire` flag, never guessed from snapshots. — `RemoteWeapons.ts` (`onGrenade`)
- Remote replays deal no damage and emit no `weapon:fired` / `weapon:hit`. — `RemoteWeapons.ts`
- Shotgun ADS is camera zoom only: while aiming, spread uses the hip value and the hip stance column (recoil keeps the ADS stance column); decided by class (`WeaponDefaults.adsTightensSpread`). — `parts/Firing.ts`
- Remote weapon models are keyed on the avatar's socket object; a changed socket means rebuild (pooled bodies get a fresh socket per avatar). — `RemoteWeapons.ts`
- Grenades are not hold-to-use items: `useTimeOf` returns 0 for `ItemDef.grenade` (hold = cook). — `model.ts`
- `parts/*` import only types from `WeaponSystem.ts`; shared values go in `model.ts`.
- A reload hold is not a cancel: hold it through `parts/Firing.setReloadPause` (progress kept, `weapon:reloadPaused`), throw it away with `cancelReload` (`weapon:reloadCancelled`). Mixing the two makes the crosshair ring lie. — `parts/Firing.ts`
- **Intended**: shot tracking reports the aim line, not the pellets — a shotgun sends one `reportShot` per trigger pull
  (the rule above), so the host sees one shot. A projectile still in flight when the mission ends never reports its
  impact. — `Projectile.ts`

## Recent changes

Last 5 only — older: `git log -- src/weapons`.
- 2026-09-21 — A reload is **held**, not cancelled, by the roll and the 갈고리 (`reloadPauses` · `setReloadPause` · `weapon:reloadPaused` / `Resumed`); an 오버차지 channel starting cancels it. Right-click gives a heal item or a 실드 충전기 to the squadmate — person or android — on the crosshair (`parts/AllyHeal`, no movement penalty; `buff heal` / `shield` or `AlliesRef.heal` / `chargeShield`). The defibrillator reaches a shouldered body.
- 2026-09-20 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched.
- 2026-09-20 — One shot-sound table (B-63): `WeaponKind` · `kindOf` · `shotSoundId` moved to `shared/shotSounds.ts` and are delegates here, so player/ plays the same ids for android guns (a legendary no longer sounds like a rifle there).
- 2026-09-18 — Melee does not hit through walls/roofs/floors (`meleeReachesBody` from the eye to the enemy's 3 body points; deployables `lineClear`); a grenade behind geometry does not hurt the local player (`blastReachesBody`).
- 2026-09-17 — Player damage cut to 1/3 (data only: `weapons.csv`, unique / melee constants; AR −15 % and range 210 first); shotguns: ADS no longer tightens spread (`adsTightensSpread`; hip spread = old ADS 3.5°).
