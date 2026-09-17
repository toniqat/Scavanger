# implants/ — tactical implants (`전술 임플란트`)

`ImplantSystem` publishes `ctx.implants` (`ImplantsRef`, types in `src/shared/implants.ts`). A player equips at most one
of five implants (changeable on the ship only) and drives it with Q (`Keys.IMPLANT`). Every gameplay decision runs on the
caster's client; the squad only sees visuals through `imp` messages, and friendly effects on other players go out as
`buff`. The folder never creates lights and needs no server support.

## Files

| File | Responsibility |
|---|---|
| `ImplantSystem.ts` | `GameSystem` + `ImplantsRef`: input (Q / LMB / melee), per-frame order, bus subscriptions, one-line delegates to `parts/`. Re-exports `model.ts` |
| `model.ts` | Folder vocabulary: tuning constants that are not csv values, types, module scratch vectors |
| `ImplantDefs.ts` | `IMPLANT_DEFS` (5 defs: Korean name / description / icon / colour), `getImplantDef`, `isImplantId`, `implantHex` |
| `parts/Devices.ts` | Grapple (fire, pull, drone anchors, release, `refundGrapple`), dash (`castDash`, `dashReach`), scan (`castScan`), overcharge channel + beam net sync, `debugBeam` |
| `parts/Barrier.ts` | Carried shield: raise / lower / follow, `raycastBarrier`, `damageBarrier`, `resolveBarrierCollision`, `absorbFrontalAttack`, shield bash (`tryBash`), regen, `imp shield` sync |
| `parts/Charges.ts` | Cooldowns, dash charges, overcharge energy, barrier lockout, `implantCooldownMul`, `finishCooldown` / `emitReady`, `refillAll`, HUD events |
| `parts/Wield.ts` | Wielded-implant hand state (`blocksWeapons`, `stow`), carry gate, applying the profile's equipped implant |
| `parts/Wire.ts` | `imp` / `buff` send + receive; received `buff heal/boost` pass `buffGuard` |
| `RemoteImplants.ts` | Peer visuals: hand device (re-parented on socket identity), wire, replicated shield (blocks enemy shots, pushes bugs), `scanCast` reveal, bash streak, beam |
| `devices/ImplantDevice.ts` | Procedural hand devices; -Z = muzzle |
| `effects/Barrier.ts` | `BarrierField`: hex panel, hp, front-arc `intersect`, `pushOut`, `facing`, `contactPoint` |
| `effects/Grapple.ts` | `GrappleWire` beam + harpoon head |
| `effects/Overcharge.ts` | `OverchargeBeam`, `findAlly` (aim cone, skips allies behind walls via `shared/buffLineClear`), `allyPoint` |
| `effects/Scan.ts` | `collectScanTargets` (enemies + `ctx.interactables.all()`), `revealScan` (shared by local cast and `imp scanCast`) |
| `fx/ImplantFx.ts` | Pooled beams, scan shell, streaks, sparks (no lights) |
| `index.ts` | Barrel |

## Implants

Numbers live in `data/constants.csv` under the named keys. Every cooldown is multiplied by
`ctx.progression.derived.implantCooldownMul`.

| id | Mode | Behaviour | Resource |
|---|---|---|---|
| `grapple` | instant | Crosshair anchor each frame → `implant:grappleTargetChanged`. Q fires / Q again releases; attaches to terrain, obstacles or an air drone (moving anchor). Cooldown starts on fire; a non-silent release refunds part of it (`refundGrapple`: attached → by pulled distance `IMPLANT_GRAPPLE_REFUND_*`; before attaching → `IMPLANT_GRAPPLE_CANCEL_*`) | `IMPLANT_GRAPPLE_COOLDOWN` |
| `dash` | instant | Teleports to the farthest spot the body could walk to (`dashReach`: stepped sweep, surface first then `resolveCollision`; windows block, doors / stairs pass) | `IMPLANT_DASH_CHARGES`, `IMPLANT_DASH_COOLDOWN` per charge |
| `barrier` | wielded | Shield in hand (gun holstered, speed × `IMPLANT_BARRIER_CARRY_SPEED_MUL`). Blocks enemy projectiles inside `IMPLANT_BARRIER_CARRY_ARC`, is a wall for bugs, absorbs frontal melee. LMB / melee key = shield bash (`IMPLANT_SHIELD_BASH_*`). Breaks → auto stow + `IMPLANT_BARRIER_BREAK_LOCKOUT` while hp refills to full | shield hp |
| `overcharge` | hold | While Q is held: self heal + `buff heal` to the ally in the aim cone; boost above `IMPLANT_OVERCHARGE_BUFF_HP_RATIO` | `IMPLANT_OVERCHARGE_ENERGY` |
| `scan` | instant | One pulse of `IMPLANT_SCAN_RADIUS`, usable while moving: reveals enemies + interactables for `IMPLANT_SCAN_REVEAL_TIME_V2` (`detect:reveal`, `scan:cast`, `enemies.setXray`) and sends `imp scanCast` | `IMPLANT_SCAN_COOLDOWN_V2` |

`atlauncher` (retired) stays in the `ImplantId` union only; saves migrate it to `null` (`progression/Profile.migrate`).

## Public API

- **`ctx.implants`** (`ImplantsRef`): read-only state (`equipped`, `wielded`, `blocksWeapons`, cooldown / charges,
  barrier hp / lockout, `holding`, `energy`, `barrierCarried`, `bashing`); `setEquipped` (returns false while
  `ctx.isRaidActive()`), `activate`, `stow`, `reset`, `getBarrierPose`, `refillAll?` (stabilizer consumable, called by
  weapons `parts/Healing`).
- **Shield queries for other folders**: `raycastBarrier(origin, dir, maxDist, fromEnemy)` (pure; `fromEnemy === false`
  always null), `damageBarrier(owner, point, amount?)`, `resolveBarrierCollision(pos, radius)` (enemies, per simulated
  bug per tick), `absorbFrontalAttack(owner, fromPos, amount)` (host enemies, before melee damage; for a peer owner the
  caller sends `ee barrierHit` to that peer).
- **Debug**: `dashReach`, `debugBeam`, `lastBuffVerdict`.
- **Emits**: `implant:*` (`equipped`, `activated`, `cooldownChanged`, `cooldownRefunded`, `ready`, `energyChanged`,
  `wieldChanged`, `grapple*`, `dashed`, `barrierChanged` / `Hit` / `Carried`, `bashed`, `scanned`, `overcharge`),
  `scan:cast`, `detect:reveal`.
- **Consumes**: `progress:loaded`, `game:newMission`, `game:abort`, `hub:entered`, `game:phaseChanged`, `player:died`,
  `player:downed`, `net:remotePlayerRemoved`, `implant:barrierBumped` (from enemies; spark only), `drone:controlChanged`,
  `drone:removed`.
- **Wire** (`src/shared/net.ts` `ImplantMessage`): `imp` events `wield`, `grapple`, `dash`, `shield` (also unicast on
  `flow rejoined`), `beam` (≤ 4 Hz while channelling), `bash`, `scanCast`; legacy `barrier` / `scan` are still read,
  `rocket` / `rocketHit` are ignored. `buff heal` / `boost` are sent and received here. Remote hand devices come from
  `PlayerSnapshot.imp`, shield state from the snapshot's barrier fields.
- `implant_ready` is played by audio/ from `implant:ready`, not sent here. The equip picker is inventory's; the HUD
  (`ui/hud/ImplantWidget`) only reads the getters.

## Rules

- No lights; all glow is emissive / additive and FX are pooled. — `fx/ImplantFx.ts`
- `IMPLANT_BARRIER_CARRY_OFFSET` must stay larger than `PLAYER_RADIUS`, or enemy hitscan reaches the player before the shield. — `parts/Barrier.ts`
- `raycastBarrier` never changes state; only a call site whose shot really stopped calls `damageBarrier`, exactly once. — `parts/Barrier.ts`
- `buff` kinds have one owner each: `heal` / `boost` here, `revive` / `cloak` in gadgets. Handling another folder's kind double-applies it. — `parts/Wire.ts` (`onBuff`)
- An overcharge boost sets `setSpeedModifier('overcharge', …)` and `setOvercharged(duration)` with the same duration; `isOvercharged` is that timer. — `parts/Wire.ts` (`applyBoost`)
- Input is ignored while `piloting` (drone control or rover ride); taking a drone's controls stows. — `ImplantSystem.ts` (`piloting`)
- Silent releases (stow on death / phase change / reset / drone control) never refund grapple cooldown. — `parts/Devices.ts` (`releaseGrapple`)
- `parts/*` import only types from `ImplantSystem.ts`; shared values go in `model.ts` (avoids import cycles).
- **Intended**: a barrier never stops its owner — the player walks through their own shield and cannot shoot it either
  (`fromEnemy=false` passes), and a carried shield blocks only inside `IMPLANT_BARRIER_CARRY_ARC`. — `parts/Barrier.ts`
- **Intended**: implant bonuses are not clamped by `STAT_MAX` (the cap is on spent points, not on gear). `resetProfile`
  loses an equipped implant when the grid has no room for it.

## Recent changes

Last 5 only — older: `git log -- src/implants`.
- 2026-09-15 — Anti-tank launcher (`atlauncher`) retired: def, update code and `effects/AtLauncher.ts` removed; barrier is the only wielded implant.
- 2026-09-14 — Grapple cooldown raised; dash reach is a walking sweep (`dashReach`) so it no longer passes window frames.
- 2026-09-13 — `piloting` also covers rover riding.
- 2026-09-12 — Grapple cooldown refund, `implant:ready` per charge, `refillAll` for the stabilizer.
- 2026-09-11 — Received `buff` passes `createBuffGuard`; overcharge beam skips allies behind walls.
