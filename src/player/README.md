# src/player — Third-person player

Owner: `PlayerSystem` (`name: 'player'`). Publishes `ctx.player` implementing `PlayerRef` **and** `PlayerWeaponHost` (shared/types.ts).

| File | Purpose |
|---|---|
| `PlayerSystem.ts` | Orchestrator. Input gating (`ctx.isGameplayActive()`, pointer lock on left click, controls flag), aim state (RMB = `MouseButtons.AIM` → `player:aimChanged`, cancelled while diving), **stances** (C crouch toggle, Z prone toggle → `player:stanceChanged {stance, prev}`), **stamina** (sprint drain, jump/dive costs, regen, `player:staminaDepleted`), **dive** (Left Alt → `player:dived`, ends prone), sprint/jump, footsteps (`player:footstep` + dust), health (`takeDamage` with 0.15 s invulnerability → `player:damaged`, `player:healthChanged`, `ui:damageIndicator`, shake, `ctx.stats.damageTaken`; death → `player:died`, death pose, controls off), stims (F: `inventory.consumeWhere(stim)` → heal over 1.5 s, `player:stimUsed`, `stim:countChanged`, "스팀팩 없음" notify; 3 fallback stims without inventory), interaction (E: `ctx.interactables.findBest`, hold progress → `interact:promptChanged`, `interact:performed`), hellpod drop-in on `world:ready` (`player:spawned`, `player:landed {impactSpeed}`), `attachTo` (rides a parent, world position preserved), `setShipInterior` (box-constrained floor), `game:abort` reset. Listens `player:applySlow {duration, factor}` (strongest factor wins, timer refreshed) → `controller.speedMultiplier` (also ×0.5 while standing up from prone, ×0.9 for 1 s after stamina hits 0). Body faces movement dir; faces camera when aiming/firing/reloading/prone; faces the dive direction while diving. Weapon hooks: `getWeaponSocket`, `getAimRay`, `addRecoil`, `setWeaponState`, `canUseWeapons` (false while diving), `setAimZoom(zoom, scope)` → rig. |
| `PlayerController.ts` | Kinematic controller: camera-relative acceleration (ground 34 / decel 26 / air 7 m/s²), speeds by `MoveInput.stance` (walk 4.2 / sprint 7.2 / crouch `PLAYER_CROUCH_SPEED` 2.4 / prone `PLAYER_PRONE_SPEED` 1.3; aiming ×0.8 standing, ×0.85 crouch/prone), gravity, single jump (coyote 0.1 s, stand only), **dive** (`MoveInput.dive` → 7.5 m/s horizontal in the wish dir or camera forward + 3 m/s up, no steering until touchdown or 0.9 s → `MoveResult.diveEnded`, slide bled ×0.35), heightfield ground with snap-down, steep-slope (>50°) sliding, `world.resolveCollision`, ship-interior clamp, `speedMultiplier` for slows. Stride phase drives footsteps and animation (cycle length sprint 1.9 / walk 1.45 / crouch 1.1 / prone crawl 0.8 m). |
| `CameraRig.ts` | Over-the-right-shoulder rig: hip 3.2 m (+0.35 sprint, −0.25 crouch, −0.5 prone, +0.3 dive) / ADS 1.8 m / **scoped ADS 0.7 m**, shoulder 0.55 → ADS 0.42 → scoped 0.35, pitch clamp [−60°, 70°] (min blends to −25° while prone), sensitivity 0.0022 × (currentFov / baseFov) while aiming (4× scope → ¼), spring-damped pivot & distance, terrain collision via `world.raycast` (ray starts 0.35 m higher and min distance rises 0.6 → 1.2 m while prone; pull in instantly, ease out), ship-box slab clamp, trauma-based shake (`camera:shake`), recoil offset with 35 % permanent kick, cutscene override blend (hellpod). FOV: base 70, sprint +3°, ADS = base − 20° when `aimZoom ≤ 1`, else base / `aimZoom`; damp 6. **No head-bob** — nothing in the rig oscillates with the stride phase; the pivot's vertical follow is soft on the ground (damp 7, airborne 30) while horizontal stays tight (30). `getAimRay` origin/direction come from the unshaken rig pose. |
| `SoldierModel.ts` | Procedural armoured trooper (~1.8 m, faces -Z): blue-grey steel plates (0x3a4150) over a dark undersuit (0x22262e), low metalness / roughness ~0.55 so hemisphere fill reads (no env map), bright yellow accents, subtle emissive visor, backpack, 4-segment cape. `update(dt, time, pose)` damps joints toward targets: breathing, walk/run cycle (legs, knees, arm swing, hip bob/roll, torso lean), crouch, jump/fall tuck, low-ready / ADS arm poses with pitch, reload hand motion, recoil jerk, hit flinch, torso twist toward camera, cape trail/flutter, death fall. `SoldierPose.prone` (hips pitched −85°, pelvis at 0.27 m, legs back, elbows planted, forearms up so the weapon points forward, head lifted; crawl cycle from `stridePhase` while moving) and `SoldierPose.dive` (superman: −78°, hips at 0.55 m, arms straight forward, legs straight, cape streaming) blend over the upright pose; the root stays at the feet and nothing sinks below y = 0. `weaponSocket` in the right hand (weapon -Z = along the arm). |
| `Hellpod.ts` | Procedural pod (floor, struts, nose cone, thrusters, 4 petal doors hinged at the floor). Drop choreography: 2.4 s fall from +150 m with thruster particles → impact (ground blast, fireball, sparks, flash) → 0.35 s hold → 0.55 s doors open (ease-out-back) → 0.5 s step-out. `getCameraPose` provides the cutscene camera during fall/impact. Stays in the world as a prop. |
| `index.ts` | Barrel. |

## Key bindings (shared/constants `Keys`)
| Key | Action |
|---|---|
| W A S D | move (camera relative) |
| Shift | sprint (stand only, forward input, needs stamina; while crouched it stands up first) |
| Space | jump (stand only, 12 stamina; while crouched it stands up and jumps; while prone it only stands up) |
| **C** | toggle crouch (stand ↔ crouch; prone → crouch) |
| **Z** | toggle prone (stand/crouch → prone; prone → stand) |
| **Left Alt** | dive: from stand/crouch on the ground, 25 stamina, ends prone |
| RMB | aim (`MouseButtons.AIM`) |
| F / E | stim / interact |

Stance rules: no stance change while airborne, diving or during the 0.35 s prone → upright transition (during which jump/sprint/dive are denied and speed is halved). No dive inside the ship interior; crouch and prone are allowed there.

## Stamina (`ctx.player.stamina` / `maxStamina` = `PLAYER_MAX_STAMINA` 100, polled by the HUD)
- Sprint drains 14/s. Jump costs 12 (denied below 12). Dive costs 25 (allowed from 15, clamps to 0).
- Regenerates after a 0.8 s delay without sprinting/spending: 16/s while moving, 22/s while standing still.
- Reaching 0 emits `player:staminaDepleted`, forces sprint off and keeps it off until stamina ≥ 20 (hysteresis); walk speed ×0.9 for the first second.
- Reset to full on respawn / abort.

## Camera comfort (motion-sickness fixes)
- Head-bob removed entirely (model-only stride motion remains).
- Pivot vertical follow damp 14 → 7 on the ground so stride/terrain bumps stay out of the camera; horizontal follow unchanged (30).
- Sprint FOV kick 8° → 3°, FOV damp 8 → 6.
- Ordinary jump landings barely shake (`min(0.2, (impact − 5) × 0.03)`, i.e. ~0.08 for a normal jump); hellpod / damage / dive (0.15) shakes unchanged.

## Eye heights
stand 1.55 m, crouch 1.15 m, prone 0.45 m, mid-dive 1.0 m (damped at 10/s; the rig pivot follows).

Assumptions
- `WorldSystem` emits `world:ready {playerSpawn}` synchronously after `game:newMission`; `ctx.world.ready` is true before the player moves.
- `ExtractionSystem` calls `attachTo(ship)`, `setShipInterior(bounds)` (the same object may be mutated as the ship moves) and `setControlsEnabled(false)` for liftoff.
- `WeaponSystem` calls `setAimZoom(zoom, scope)` on equip/swap/unequip (default `(1, false)`); the rig never resets it on respawn.
- Audio ids emitted: `player_hurt`, `player_death`, `player_land`, `player_jump` (also for the dive launch, pitch 0.85), `stim`, `interact`, `ui_deny`, `hellpod_fall`, `hellpod_impact`, `hellpod_open`.
