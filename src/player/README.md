# player/ — local player, camera, soldier model, remote avatars

`PlayerSystem` (`name: 'player'`) publishes `ctx.player`, which implements `PlayerRef` **and** `PlayerWeaponHost`
(`src/shared/types.ts`). It owns movement, stances, stamina, hp / shield / downed / death, damage sources, fall damage,
interaction, the camera rig, the procedural soldier and every "body mode" (ladder, tram and rover riding, drone control,
furniture poses, intro wake, scene lock, carrying). `RemotePlayerSystem` (`name: 'remotePlayers'`, registered right
after) renders other peers as `RemoteAvatar`s, drops their pods, runs host ghosts of suspended members and offers the
revive / carry interactions. Weapons, implants and gadgets act on the player only through the `ctx.player` contract.

## Files

| File | Responsibility |
|---|---|
| `PlayerSystem.ts` | Orchestrator: input gating, per-frame order, stance / aim / sprint / jump, footsteps, gear refresh, shield sync, bus subscriptions, snapshot getters; one-line delegates to `parts/`. Re-exports `model.ts` |
| `model.ts` | Folder vocabulary: eye heights, stamina / invulnerability / fade constants, furniture-pose helpers shared with `RemoteAvatar`, `BUFF_TICK_S`, scratch |
| `parts/Vitals.ts` | `applyDamage` (single damage entry: shield first, grit, source), downed / bleed / give-up, `die`, `revive`, `applyHeal`, `setHp`, perk `auto_revive` |
| `parts/Locomotion.ts` | Stances (`canStandHere`), roll, stamina, speed-modifier stack, grapple pull, bag hover, `applyImpulse` |
| `parts/Spawn.ts` | Hellpod drop (`startDrop`, `pod drop`), `spawnStanding`, `respawnAt`, `rescueRevive`, `restoreState` / `holdForRestore`, `teleport`, `resetAll` / `resetTactical`, `usesHellpod` |
| `parts/Statuses.ts` | Cloak, burning (with source), armour regen, planet environment tick (`updateEnv`) |
| `parts/Boosts.ts` | Combat consumable effects (`applyBoost`: adrenaline / stimulant) and the multipliers they expose |
| `parts/Buffs.ts` | Character buff list (`buffs`, `buffsRevision`, `player:buffsChanged`) |
| `parts/Shoulder.ts` | Carrying a downed squadmate (F tap), being carried |
| `parts/Interact.ts` | E interaction: best target, tap vs hold, `onHoldProgress` / `onHoldCancel` |
| `parts/Climb.ts` | Ladder grab / input / release, `player:climbChanged`, step smoothing (`bodyOffset`) |
| `parts/Fall.ts` | Fall height → damage (`fallDamageFor`), `player:fell`, shake, `fall` wire, `receiveRemoteFall` checks |
| `parts/DroneControl.ts` | `setDroneControl`: enter / hold rules, forced crouch, `CameraRig.setDroneView` |
| `parts/FurniturePose.ts` | `setFurniturePose` / `setFurniturePoseDrive` / `furniturePoseState`: refusal and hold rules, stand-up E, camera, blends |
| `parts/RoverRide.ts` | `setRoverRide` / `roverBoardBlock` / `roverSafePosition`: hidden seated body, exit hold, orbit camera, forced release |
| `parts/IntroWake.ts` | `playIntroWake`: rewound downed pose, input lock, wake camera and `ui:screenFade` (opening) or plain respawn stand-up |
| `PlayerController.ts` | Kinematic controller: acceleration, jump, roll, slopes, surface + collision, interior / ship-box modes, world ceiling clamp, tram ride state, ladder state machine, fall height, `airCarry` |
| `PlayerGear.ts` | Cached armour / backpack / weight view from inventory + loot (shield max, perks, weight state) |
| `CameraRig.ts` | Over-the-shoulder rig: shoulder swap, collision, aim sway, shake / recoil, cutscene override, drone view, rover orbit mode, `predictPosition` |
| `SoldierModel.ts` | Procedural trooper: pose blends (walk, stances, downed, carry, climb, throw, uniques, furniture IK), armour / glow / grey / fade, occlusion silhouette, `FURN_*` pose geometry, shared geometry cache, `resetForReuse` |
| `SoldierRim.ts` | Shared fresnel rim for soldier materials (`applySoldierRim`, one program, no lights) |
| `SoldierPool.ts` | Parked `SoldierModel`s per accent colour for remote avatars |
| `GearLook.ts` | Procedural armour plates and held-item looks shared by local and remote soldiers |
| `Hellpod.ts` | Procedural drop pod + drop choreography; `group` holds the light, `body` holds the meshes |
| `RemotePods.ts` | Three pre-built pods that replay squadmates' `pod drop` |
| `RemotePlayerSystem.ts` | Remote avatars lifecycle, remote footsteps, revive interactables, carry host, ghosts (host), remote falls, debug hooks |
| `RemoteAvatar.ts` | `RemoteAvatarRef`: pose from snapshot flags, held item, armour, suspended grey look, climb / furniture / rover visibility, per-avatar `weaponSocket` |
| `Carry.ts` | `CarryHost` seam between the two systems (`PlayerSystem.setCarryHost`) |
| `Portraits.ts` | `createPortraits` — separate WebGL canvas for the launch-slot panel portraits (null when no context) |
| `FaceSnapshot.ts` | `snapshotFace` — one lazily created offscreen renderer draws a square face PNG per accent (cached, released after `FACE_SNAPSHOT_IDLE_DISPOSE_MS` idle); `poseFaceModel` / `aimFaceCamera` / `addFaceLights` shared with `ui/menus/SoldierPreview` |
| `index.ts` | Barrel |

## Public API

**`ctx.player`** — full list in `src/shared/types.ts` (`PlayerRef`, `PlayerWeaponHost`, many appended blocks):

- **State / snapshot getters**: position, velocity, yaw, pitch, stance, hp / `maxHp` (getter) / shield / `maxShield`,
  stamina, `isDead`, `isDowned`, `downHp`, `isGrounded`, `isDropping`, `isInShip`, `stridePhase`, `moveBlend`,
  `isReloading`, `isFiring`, `isMeleeHeavy`, `isOvercharged`, `climbingLadder`, `droneControl`, `roverRide`,
  `furniturePoseState`, `introWaking`, `buffs` / `buffsRevision` (read by net's snapshot builder and the HUD).
- **Damage / healing**: `takeDamage(amount, from?, source?, opts?)` (`opts.bypassShield` skips the shield), `heal`,
  `applyStim`, `applyHeal(amount, seconds, quiet?)`, `chargeShield`, `revive`, `die?` (voluntary return), `setHp?`,
  `setBurning(dps, duration, source?)`, `applyKnockback`, `applyImpulse`, `setCloak`, `setSpeedModifier`,
  `setOvercharged`, `applyBoost` + boost multipliers (`aimSwayMul`, `boostReloadSpeedMul`, `adsSpeedMul`, `staminaDrainMul`, `staminaCostMul`).
- **Spawn / placement**: `respawnAt`, `respawn`, `spawnStanding`, `restoreState`, `teleport`, `attachTo`,
  `setShipInterior`, `setInterior` / `interior`, `setInPod`, `setControlsEnabled`, `setCameraOverride(pos, look?, snap?)`.
- **Body modes**: `carry` / `dropCarried` / `setCarriedBy`, `setDroneControl`, `setFurniturePose` / `setFurniturePoseDrive`,
  `setRoverRide` / `roverBoardBlock` / `roverSafePosition`, `playIntroWake(duration, {respawn?})`,
  `setSceneLock(on, {allowDamage?, minHp?})`, `consumeStamina`, `startMelee(kind)`, `setViewWiden`, `setGrappleTarget`, `setHovering`.
- **Weapon host**: `getWeaponSocket`, `getShoulderSocket`, `getAimRay`, `addRecoil`, `setWeaponState`, `canUseWeapons`,
  `setAimZoom`, `setAdsTime`, `setLookLocked`, `setAimSway`. **UI**: `createPortraits(host, cells)`,
  `snapshotFace({accent, size?})` (square PNG data URL, same framing as character creation; null without a GL context).

**`RemotePlayerSystem`** (via `getSystem('remotePlayers')`): `getAvatar(id)`, `getAvatars()`, `getReviveTargets()`,
`getGhosts()` / `getGhost(id)` / `getParkedGhosts()` / `getLastGhostStates()`; debug `debugSpawn`, `debugClear`,
`debugSuspend`, `debugRejoin`, `debugExpireParked`, `debugCarryLocal`.

**Emits**: `player:*` (`spawned`, `landed`, `damaged`, `healthChanged`, `shieldChanged`, `downed`, `downHpChanged`,
`giveUpProgress`, `revived`, `died`, `gritSaved`, `stimUsed`, `stanceChanged`, `aimChanged`, `sprintChanged`, `dived`,
`staminaDepleted`, `footstep`, `launched`, `burning`, `cloakChanged`, `envChanged`, `fell`, `remoteFell`,
`climbChanged`, `carryStarted`, `carryEnded`, `furniturePoseEnded`, `buffsChanged`, `introWakeDone`),
`interact:promptChanged` / `performed`, `remote:footstep`, `net:ghostState`, `net:remoteHeldItem`, `ui:damageIndicator`,
`ui:screenFade`, `camera:shake`, `audio:play`, `ui:notify`.

**Consumes**: `world:ready`, `game:newMission`, `game:abort`, `game:phaseChanged`, `hub:entered`, `hub:left`,
`player:respawn`, `player:applySlow`, `rescue:landed`, `corpse:playerSpawned`, `ladder:grab`, `implant:dashed`,
`enemy:killed` (perk `kill_stamina`), `camera:shake`, gear events (`loadout:changed`, `equip:changed`,
`inventory:changed` / `weightChanged`, `durability:changed` / `broken`, `repair:completed`), buff sources
(`progress:mealChanged` / `prepChanged` / `gymFatigue`, `housing:gymSession` / `cookSession` / `gameSession`), and on
the remote side `net:remotePlayerAdded` / `Removed`, `net:peerSuspended`, `net:missionMembership`, `net:hostChanged`,
`ghost:damage`.

**Wire** (`src/shared/net.ts`): sends `pod drop {who, p, yaw, kind}`, `carry pick` / `drop`, `fall {p, d}`,
`revive progress` / `cancel` / `done`; host sends `ghost state` / `sync` / `restore` / `gone`, clients send
`ghostq sync` / `revive`. Receives `pod`, `fall`, `ghost`, `ghostq`, `flow`.

## Keys

| Key | Action |
|---|---|
| WASD / Shift / Space | Move (camera-relative) / sprint (stand only) / jump |
| C / Z | Toggle crouch / prone (prone also allowed on the ship; standing refused under a low ceiling) |
| V (`Keys.DIVE`) | Roll (`ROLL_STAMINA_COST`; refused on the ship, in interiors, when overweight); `player:dived` is its alias |
| X (`Keys.SHOULDER`) | Swap camera shoulder (session only, not saved) |
| RMB / E | Aim / interact (tap or hold; also ladder grab, stand up from furniture, rover exit hold) |
| F tap | Shoulder / put down a downed squadmate in range (consumed before weapons see it); otherwise weapons' melee |
| Space hold (downed) | Give up (`PLAYER_GIVE_UP_HOLD`) |

## Health, shield, downed

- `applyDamage` is the single entry for damage. Order: rover ride / scene lock gates → invulnerability → shield absorbs
  first (`absorbShield`, wears armour) unless `bypassShield` → hp → grit → downed / death. Shield max = worn armour's
  `ArmorDef.shield` (0 when broken); it refills every frame on the ship and in raids only via shield chargers.
- hp 0 → downed (crawl, `downHp` bleeds `PLAYER_DOWN_BLEED_PER_SEC`, give-up hold); `downHp` 0 → `die`. A solo
  player (no lobby or a one-player squad) dies at once unless `auto_revive` is unspent (`Vitals.onLethal`). Revive →
  `PLAYER_REVIVE_HP`; perk `auto_revive` once per raid.
- The lethal source is kept (`_deathSource`) and sent as `player:died.source`; environment = `{kind:'env'}`, fall =
  `{kind:'fall'}`, burning keeps the strongest fire's source.
- `restoreState` restores alive / downed / dead from a rejoin without a hellpod; an omitted `shield` means full, applied
  on the first frame armour is known (`pendingShield`).
- Planet environment (`updateEnv`): without a matching prep, hp only is reduced every `PLANET_ENV_TICK_S`; not in hub,
  training, downed, pod or before spawn. `player:envChanged` only on change.
- Hellpods are skipped in training and tutorial (`usesHellpod`); rescue revive lands at the host's point, empty-handed.

## Body modes

| Mode | Entered by | Locks | Released by |
|---|---|---|---|
| Ladder (`climbingLadder`) | `ladder:grab` from world's ladder interactable | Gravity / collision / weapons / `canAct`; W/S, Shift, Space jump, E drop | Top mount, bottom step-off, E, jump, death / downed, every reset (`clearClimbState`) |
| Tram ride | Grounded on an obstacle with `velocity` | Nothing; position solved in carrier-local space (`shared/ride`), `vel` stays local | Leaving the carrier OBB + headroom → exit inertia (`RIDE_*`) |
| Rover ride (`roverRide`) | `world/rover` → `setRoverRide(binding)` after `roverBoardBlock()` | Body hidden, feet on seat, all input except camera orbit, **all damage** | E hold exit, `releaseRoverRide` on death / resets / phase change (lands at `roverSafePosition`) |
| Drone control (`droneControl`) | `gadgets/drones` → `setDroneControl(true)` | Movement / aim / weapons / interaction; stands → crouch | Drone side `setDroneControl(false)`; auto on downed / death / spawn / pod / attach / hub (no event — drones must poll) |
| Furniture pose (`furniturePose`) | hub → `setFurniturePose` (hub phase only) | Movement frozen, weapons, interaction (E = stand up) | E, caller, every phase change / reset / downed / death → `player:furniturePoseEnded` once |
| Intro wake (`introWaking`) | tutorial → `playIntroWake(TUTORIAL_INTRO_WAKE_S)`; respawn variant from game/ | Movement, look, aim, weapons, interaction | Ends itself → `player:introWakeDone` (opening only); death / resets cancel silently and clear the fade |
| Scene lock | extraction → `setSceneLock(true, opts)` | Same input as intro wake; damage ignored, or clamped at `minHp` with `allowDamage`; no knockback | `setSceneLock(false)`, abort / new mission / spawns |
| Carry / carried | F tap / peer carries us | Carrier: WASD + sprint only; carried: frozen, follows socket | Any other action (`dropCarried('action')`), revive / death / reset |
| In pod | hub → `setInPod(true)` | Movement / sprint / aim; model hidden | `setInPod(false)`, spawns, abort |

Fall damage (`parts/Fall`): the controller measures fall **height** (`MoveResult.fallHeight`), damage =
`FALL_DAMAGE_*` through `applyDamage`; tutorial zones may override (`ctx.world.tutorial.fallRule`: `kill` / `clamp` /
`normal`). Exempt: grapple, hover, tram deck, ship interiors, ladder release, dash (`exemptFall`), any impulse /
knockback until the next landing, and every mode above.

## Camera rig

- Aim origin: `PlayerSystem.update` fills `rig.sway`, calls `advanceSway(dt)` then `predictPosition` so weapons fired in
  `update` use the camera the frame will render; `lateUpdate` runs `rig.update`.
- Aim sway (ADS only): figure-eight look offset, amplitude from weapons (`setAimSway`) × stance × movement ×
  `aimSwayMul`; `AIM_SWAY_*` in `data/constants.csv`. Off on the ship, in modes and under overrides.
- Collision: world + interior raycast, terrain samples along the boom, bounds clamp, terrain floor; pull-in instant,
  ease-out capped by collision distance; body fades when the camera is near the pivot.
- `setCameraOverride(null, undefined, true)` = hard cut (drones, rover exit); `null` alone blends back.
- Drone view and rover orbit ignore shake / recoil / FOV kicks (`ROVER_CAM_*` for the orbit).

## Furniture poses (`가구 자세`)

Hub builds furniture and anchors around the geometry constants `FURN_SIT`, `FURN_BENCH`, `FURN_CYCLE`, `FURN_COOK` in
`SoldierModel.ts` (all metres from the anchor; "forward" = `(−sin yaw, 0, −cos yaw)`; hands / feet use two-bone IK).

| kind | Anchor | Root faces | Phase (`setFurniturePoseDrive`, cumulative on the wire) |
|---|---|---|---|
| `sit` | Seat top centre | `yaw` | unused |
| `bench` | Pad top at the shoulder blades | `yaw + π` (head toward `yaw`) | 0 = bar at chest … 1 = arms extended |
| `run` | Belt top centre | `yaw` | steps (0 → 1 = one step) |
| `cycle` | Saddle top | `yaw` | crank turns (0 = left pedal top) |
| `cook` | Floor in front of the counter (counter edge at `FURN_COOK.edgeZ`) | `yaw` (toward counter) | hand cycles (knife / stir) |

Remote avatars draw the same pose from `ref.furniturePose` with the shared `model.ts` helpers (`furnitureBodyYaw`,
`stepFurnitureBlend`, `lerpFurnitureRoot`, `writeFurniturePose`); an avatar first seen mid-pose snaps instead of blending.

## Character buffs

`parts/Buffs.ts` collects display-only buffs (`src/shared/charBuffs.ts`): `meal`, `prep` (pending on ship / active in
raid via `ctx.isRaidActive()`), `env_exposed`, `gym_fatigue`, `rest` (sit), `exercise`, `cooking`, `gaming` (seat +
matching `housing.gameSession`), `adrenaline` / `stimulant`. Events only set `buffsDirty`; `update` rebuilds once per
frame plus a `BUFF_TICK_S` tick, and a new array + revision go out only when `sameCharBuffs` says the list changed.

## Remote avatars and ghosts

- `RemotePlayerSystem` never simulates remotes: position / flags come from net's interpolated refs. Avatars are cleared
  wholesale on `game:abort` / `game:newMission` / `hub:entered`; bodies return to `SoldierPool`.
- `RemoteAvatar` hides while `DROPPING`, `IN_POD`, `IN_ROVER` (+ `ROVER_REMOTE_EXIT_HIDE_S`), stale / disconnected
  (unless suspended), or when a player corpse replaces a dead body; suspended members render grey.
- Remote footsteps: `remote:footstep` on stride-phase boundaries (distance falloff is audio's). Remote falls are checked
  for shape, lobby membership, `FALL_REMOTE_SOUND_RANGE` and rate before `player:remoteFell`.
- Revive: every downed ref gets `revive:<peerId>` (`PLAYER_REVIVE_HOLD`, `PLAYER_REVIVE_RANGE`); suspended bodies are
  revived through `ghostq revive`.
- Ghosts (host only): a suspended member's body stays targetable (`ghost:damage` from enemies, bleed, knockback nudge),
  is parked on mission leave for `NET_GHOST_PARK_S`, restored to the member on `flow rejoined` (`ghost restore` →
  `restoreState`), rebuilt from the last wire on host promotion.

## Rules

- Never change the scene light count: hellpod lights live on `group` (always visible), meshes on `body`; remote pods are pre-built. — `Hellpod.ts`, `RemotePods.ts`
- Resolve the walkable surface (`getSurfaceY`) before `resolveCollision`, and apply slope limits only when the feet are on terrain. — `PlayerController.ts`
- World ceiling clamp uses `BOX_HEADROOM`, not `PLAYER_HEIGHT`, and runs before `resolveCollision` while rising. — `PlayerController.ts` (`clampWorldCeiling`)
- A parented body (`attachTo`) re-reads its world position in both `update` and `lateUpdate` (extraction registers after player). — `PlayerSystem.ts`
- The ship-interior bounds object is held by reference and mutated every frame by its owner; do not pass snapshots. — `PlayerController.ts`
- Every damage path goes through `Vitals.applyDamage`; the only bypasses are `Statuses.updateEnv` (hp only) and knockback. New damage paths add a source and respect `roverRide` / scene lock there. — `parts/Vitals.ts`
- `player:climbChanged` and `player:furniturePoseEnded` are emitted from one place each, exactly once per change. — `parts/Climb.ts`, `parts/FurniturePose.ts`
- Drone control auto-release emits nothing; the drone side must poll `ctx.player.droneControl`. — `parts/DroneControl.ts`
- Call `setCameraOverride` for a same-frame camera from `update`, not `lateUpdate` (the rig consumes it in player's `lateUpdate`).
- `playIntroWake` must not be called inside the same `game:newMission` emit (player's own handler cancels it); tutorial defers one frame. — `parts/IntroWake.ts`
- Shared geometry / silhouette materials in `SoldierModel` are never disposed by an instance; body materials are per instance. — `SoldierModel.ts`
- Each `RemoteAvatar` hands out a fresh `weaponSocket` object (pooled bodies), because weapons / implants key their hand models on socket identity. — `RemoteAvatar.ts`
- Changing `FURN_*` requires matching the hub furniture models. — `SoldierModel.ts`
- `parts/*` import only types from `PlayerSystem.ts`; shared values go in `model.ts`.

## Recent changes

Last 5 only — older: `git log -- src/player`.
- 2026-09-15 — `snapshotFace` (`FaceSnapshot.ts`, terminal match-tab portraits) + face helpers shared with character creation.
- 2026-09-15 — `takeDamage` option `bypassShield` (used by spore hazard).
- 2026-09-15 — `playIntroWake(d, {respawn})` for tutorial respawns; `setSceneLock` options `allowDamage` / `minHp`.
- 2026-09-15 — Damage sources on `player:damaged` / `player:died` (`_deathSource`, env / fall / burning sources).
- 2026-09-15 — Fall feedback (shake, `fall` wire, `player:remoteFell`); soldier fresnel rim (`SoldierRim.ts`).
