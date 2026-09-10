# src/player — Third-person player

Owner: `PlayerSystem` (`name: 'player'`). Publishes `ctx.player` implementing `PlayerRef` **and** `PlayerWeaponHost` (shared/types.ts).
Also owns `RemotePlayerSystem` (`name: 'remotePlayers'`, registered right after PlayerSystem) which renders the other peers of a multiplayer session as `RemoteAvatar`s.

| File | Purpose |
|---|---|
| `PlayerSystem.ts` | Orchestrator. Input gating (`ctx.isControlActive()` = gameplay OR hub phase with no blocker; click-to-relock on left click in both),  aim state (RMB = `MouseButtons.AIM` → `player:aimChanged`, cancelled while diving / downed), **stances** (C crouch toggle, Z prone toggle → `player:stanceChanged {stance, prev}`), **stamina** (sprint drain, jump/dive costs, regen, `player:staminaDepleted`), **roll** (`Keys.DIVE`, V since 2026-09-07 → `player:dived`, ends prone), sprint/jump, footsteps (`player:footstep` + dust), health (`takeDamage` with 0.15 s invulnerability → `player:damaged`, `player:healthChanged`, `ui:damageIndicator`, shake, `ctx.stats.damageTaken`; hp 0 → **downed**, see *Downed / revive / respawn* below; `downHp` 0 or give-up → `player:died`, death pose, controls off), stims (`applyStim(heal)` called by weapons' quick-use after it consumed the item → heal over 1.5 s, `player:stimUsed`; **no F key here any more**), interaction (E: `ctx.interactables.findBest`, hold progress → `interact:promptChanged`, `interact:performed`; hold targets also get `onHoldProgress(t)` every frame while E is held and `onHoldCancel()` once when E is released early / the target changes / the player dies or resets; a completed hold needs a fresh E press before the next one), hellpod drop-in on `world:ready` (`player:spawned`, `player:landed {impactSpeed}`) and on `player:respawn {position}` (`respawn()`), `attachTo` (rides a parent, world position preserved), `setShipInterior` (box-constrained floor), **hub / interiors** (`setInterior`, `interior`, `spawnStanding`, `setInPod` / `isInPod`, `setCameraOverride` — see *Hub & interiors* below), `game:abort` reset (keeps `interior`), `hub:left` → `setInterior(null)`. Drives the model's near-clip fade (`rig.pivotDistance` < 0.9 m → `SoldierModel.setFade`) and the occlusion silhouette (`setSilhouette`, off while dead / hellpod active / in pod / scoped; stays on while downed). Listens `player:applySlow {duration, factor}` (strongest factor wins, timer refreshed) → `controller.speedMultiplier` (also ×0.5 while standing up from prone, ×0.9 for 1 s after stamina hits 0, ×`PLAYER_DOWN_SPEED_MUL` while downed). Body faces movement dir; faces camera when aiming/firing/reloading/throwing/prone; faces the dive direction while diving. Weapon hooks: `getWeaponSocket`, `getAimRay`, `addRecoil`, `setWeaponState({hasWeapon, reloading, firing, twoHanded, throwing?, holdingItem?, charging?, spraying?, heavy?, altFire?})` (throwing → `SoldierPose.throw` wind-up, holdingItem → `SoldierPose.holdItem`, the Phase 6 trio → `charging / spraying / heavyCarry` stances, all damped; `altFire` = RMB is the weapon's alternative fire → `setAiming` is suppressed entirely, so no aim pose / camera facing / `aiming` bit while a unique alt-fires), `setLookLocked(locked)` (quick-use wheel: `rig.applyLook` skipped, movement continues), `canUseWeapons` (false while diving / downed), `setAdsTime`, `setAimZoom(zoom, scope)` → rig. **Multiplayer**: snapshot getters `pitch` (rig pitch, + = up), `isGrounded`, `isReloading` / `isFiring` (weaponState), `isDropping` (hellpod active and not yet `exiting`), `isInShip` (`shipBounds !== null`), `stridePhase`, `moveBlend` (`min(1.2, speed / PLAYER_WALK_SPEED)`, same as the pose), `isDowned` / `downHp` (`stance` reports `prone` while downed) — read by net/NetSystem when building the outgoing `PlayerSnapshot`. `resolveSpawn`: when `ctx.isMultiplayer`, `world:ready`'s spawn is offset per lobby slot (`ctx.net.localSlot`) onto a 4 m ring at angle `slot·π/2 + π/4`, snapped to `getHeightAt`, pushed out with `resolveCollision(PLAYER_RADIUS)`; the hellpod drops onto that point. Single-player unchanged. Network damage arrives through the same `takeDamage` (0.15 s invulnerability). |
| `model.ts` | 폴더 공용 어휘 — 상수(눈높이 · 스태미나 · 화상 …) · 타입 · 스크래치 벡터. `PlayerSystem.ts` 가 재수출한다 |
| `parts/Vitals.ts` | **체력 · 실드 · 전투불능 · 사망 · 회복.** 피해가 들어와서(`applyDamage` — **실드가 먼저 먹고**(2026-09-10, 방어구 감쇄는 사라졌다) · 인내 grit · 넉백) 체력이 0 이 되면 죽는 대신 **전투불능**이 되고(기어다니기, `downHp` 출혈, Space 홀드 포기), 아군의 소생이나 퍽 `auto_revive` 로 일어난다. 회복은 즉시가 아니라 아이템이 정한 시간에 걸쳐 들어온다(`applyHeal`). |
| `parts/Locomotion.ts` | **이동 · 자세 · 스태미나.** 무엇이 얼마나 빠르게 움직이는가: 자세(서기 / 앉기 / 엎드리기), 구르기, 스태미나 소모와 회복, 그리고 여러 출처가 곱해지는 **속도 배율 스택**(`setSpeedModifier` — 무게 · 소모품 · 들쳐메기 · 미니건 · 오버차지가 전부 여기로 들어온다). 갈고리 견인과 가방 부양도 이동의 일부다. |
| `parts/Spawn.ts` | **월드에 들어가고 나오는 모든 방법.** 헬포드 강하(`startDrop`), 함선에서 그냥 서서 시작(`spawnStanding`), 부활(`respawnAt`), 그리고 레이드 재접속 복귀(`restoreState` / `holdForRestore` — 강하 없이 마지막 위치 · 상태로). 미션 리셋에서 전투 상태를 전부 지우는 `resetAll` / `resetTactical` 도 여기 있다. |
| `parts/Statuses.ts` | **플레이어에게 붙는 상태: 은폐 · 화상 · 방어구 재생.** 은폐는 적 인지(`getStealthFactor`)에 직접 곱해지고, 광학 방어구는 영구 은폐다. 화상은 초당 피해를 주는 DoT 이고, 방어구는 전투가 끊기면 조금씩 회복된다. |
| `parts/Shoulder.ts` | **부상자 들쳐메기 (Phase 10).** 전투불능 아군 근처에서 F 를 짧게 누르면 어깨에 메고(비무장 · 걷기/달리기만), 다른 행동을 하면 먼저 내려놓는다. 메인 쪽이 권한이고 업힌 쪽은 캐리어의 어깨 소켓을 따라간다 — 캐리어가 사라지면 몸은 마지막 위치에 그대로 내려진다. |
| `parts/Interact.ts` | **E 상호작용.** 화면 안의 `Interactable` 중 가장 알맞은 것을 고르고, 탭 / 홀드를 구분해 `onHoldProgress` · `onHoldCancel` 을 흘린다(홀드 시간은 능력치의 영향을 여기서 한 번만 받는다). |
| `parts/Climb.ts` | **몸이 수직으로 어떻게 옮겨 가는가: 사다리 · 단차 보간** (2026-09-11). `ladder:grab` → `grabLadder`(규칙 검사 · 서기 · 조준 해제 · 잡는 순간의 XZ 스냅을 `bodyOffset` 으로 미끄러뜨림), `readClimbInput`(W/S · Shift = 스태미나 있을 때 빠르게 · Space = 스태미나 · 무게 규칙 · E = 놓기), `releaseLadder` / `clearClimbState`(리셋 경로), `syncClimb`(`player:climbChanged` 는 여기서만, 값이 바뀔 때 한 번), `updateStepSmoothing`(접지 → 접지 사이 **단차로 보이는** 높이 변화만 `bodyOffset.y` 에 쌓고 `STEP_SMOOTH_RATE` 로 감쇠). 아래 *사다리 · 단차 보간* 절. |
| `RemotePlayerSystem.ts` | `GameSystem 'remotePlayers'`. Each frame — in every phase, so shared-ship hub avatars render while `ctx.net.inHubSession` — iterates `ctx.net?.getRemotePlayers()` (NetSystem has already interpolated them — it updates first), creates a `RemoteAvatar` on first sight (or on `net:remotePlayerAdded`), sets `ref.avatar`, drives it, and ends it on `net:remotePlayerRemoved`, `!ref.connected` (unless `ref.suspended`), a ref vanishing from the list (frame-stamp sweep), and wholesale on `game:abort` / `game:newMission` / `hub:entered` (surviving refs get a fresh avatar next frame from a fresh snapshot, so mission positions never linger in the ship). **2026-09-10**: an ended avatar's body is parked in `soldierPool` (`SoldierPool`) and the next avatar of that slot colour reuses it, so those wholesale clears no longer rebuild meshes / materials; `clearAll` only **hides** the remote pods (`RemotePods.clear`) and `dispose()` is the one place that disposes the pods and the pool. **원격 발소리** (2026-09-10): `emitFootstep` 은 아바타를 돌린 직후 `ref.stridePhase` 의 π 경계마다 `remote:footstep {position, sprinting, peerId}` 를 낸다 — 접지(`!AIRBORNE`) · 구르지 않음(`!DIVE`) · 수평 속도 > `STRIDE_MIN_SPEED` · `av.isShown` · 살아 있음 · `!stale && !suspended` 일 때만이고, peer 당 `FOOTSTEP_MIN_INTERVAL_S` 로 쓰로틀한다. 거리 감쇠는 `audio/` 의 몫이다. **Revive interactable** (Phase 2): every ref with `isDowned && !isDead && (suspended || (connected && !stale))` gets an `Interactable` `revive:<peerId>` (`position` = the ref's own Vector3 instance, radius `PLAYER_REVIVE_RANGE` 3 m, `holdTime` `PLAYER_REVIVE_HOLD` 10 s, prompt `부활: <name>`, `canInteract` = local player alive, not downed, `ctx.isGameplayActive()`); `onHoldProgress` relays `{t:'revive', ev:'progress', target, p}` to that peer at ≤ 4 Hz, `onHoldCancel` → `ev:'cancel'`, completed hold → `ev:'done'` + `ui:notify "<name> 부활"` + `stim` SFX, then the interactable is withheld 1.5 s until the peer's `DOWNED` flag clears. On a **suspended** peer nothing is relayed (socket down) and the completed hold sends `ghostq revive` to `'host'` (or revives the ghost directly when this client is the host). Unregistered when the ref stops being downed / dies / leaves and by every `clearAll` (abort / new mission / hub). `getReviveTargets()` lists the peers currently offering one. Queries: `getAvatar(id)`, `getAvatars()`, `getGhosts()` / `getGhost(id)` / `getLastGhostStates()`. **Ghosts** (Phase 7, host only) — see *Ghosts* below. **Debug**: `debugSpawn({ slot?, id?, name?, stance?, flags?, weaponId?, isDowned?, implantId?, armorId?, heldItemId?, position? })` returns a fully writable `DebugRemoteRef` (fake peer, no NetSystem needed) placed 2 + slot m beside the local player — mutate `flags` / `stance` / `position` / `velocity` / `isDead` / `isDowned` / `stale` / `suspended` / `heldItemId` / `armorId` from the console; `debugClear(id?)` removes them; `debugSuspend(id, on)` flips `suspended` + `stale` and emits `net:peerSuspended` (a ghost is created offline too — `ctx.net.send` is a no-op); `debugRejoin(id)` plays the member's `flow rejoined` (returns the `ghost restore` wire). `window.__game.getSystem('remotePlayers')`. |
| `RemoteAvatar.ts` | Implements `RemoteAvatarRef` (`root`, `weaponSocket` = the model's right-hand socket, **`shoulderSocket`** = its right shoulder, `getHeadPosition(out)` = feet + blended head height stand **1.6** / crouch **1.34** / prone **0.55** — re-anchored on the Phase 10 body — sinks toward the prone value when dead; while the body is carried the anchor comes from the avatar root's **world** position, because `ref.position` is then a stale snapshot). Wraps `new SoldierModel(NET_SLOT_COLORS[slot])`. Per frame from the `RemotePlayerRef`: `root.position = ref.position`; body yaw damped with PlayerSystem's rules (roll → velocity dir, aiming/firing/reloading/throwing/cooking/prone/suspended → `ref.yaw`, else velocity dir when horizontal speed > 0.4); `SoldierPose` from `moveBlend` / `stridePhase` / `pitch` / `velocity.y` and damped blends of `stance` + `PlayerFlags` (SPRINT, AIM, DIVE = rolling, AIRBORNE, HAS_WEAPON, TWO_HANDED, RELOADING; **DOWNED** → prone + crawl cycle with sprint/aim/crouch/roll/airborne forced off — weapons hides the gun model itself; **HOLDING_ITEM** → `SoldierPose.holdItem`); recoil pulses every 0.11 s while FIRING; `dead` ramps 0→1 over 0.9 s after `isDead` (pose reset on respawn); flinch 0. **Phase 7 flags**: `THROWING` → `SoldierPose.throw` wind-up, `COOKING` → `SoldierPose.cooking` (pin-pull, over the item pose), `CHARGING` / `SPRAYING` / `HEAVY` (with `HAS_WEAPON`, never downed) → `charging` / `spraying` / `heavyCarry`, `MELEE` + `MELEE_HEAVY` on the rising edge → the 용검 sweep replayed for `SLASH_DURATION` (`meleeHeavy` 1) instead of the 0.45 s chop, `OVERCHARGED` → `model.setGlow` rim glow. **Held item**: the ref's `heldItemId` (duck-typed — `heldItem` also accepted; net mirrors `PlayerSnapshot.h`) while `HOLDING_ITEM` → `GearLook.buildHeldItem(ctx.loot.getItemDef(id).category)` parented into `weaponSocket` (stim cylinder / grenade sphere / gadget box), rebuilt only on change, `net:remoteHeldItem {id, defId}` on every change (→ null included). **Armor**: `ref.armorId` (`ar`; an `ArmorDef.id` or an item def id with `armorId`, resolved through `ctx.loot` by `resolveArmorDef`) → `model.setArmor` — the same plate look as the local soldier. **Suspended** (`ref.suspended`): stays visible even while `stale` / `!connected`, `model.setGreyed(true)` (flat grey, dim visor), silhouette off, glow off, every animated flag masked (only HAS_WEAPON / TWO_HANDED / DOWNED / DEAD / IN_POD / IN_HUB survive), `moveBlend` 0, pitch 0, body yaw held on `ref.yaw`; the downed / dead pose follows the ghost-driven `isDowned` / `isDead`. Hidden while `flags & DROPPING` (inside their hellpod) — the first visible frame afterwards plays a `ParticleBurst.dust` landing puff; also hidden while `flags & IN_POD` (boarded in a hub launch pod), or `ref.stale` / `!connected` when not suspended. Shows the slot-tinted occlusion silhouette (`model.setSilhouette(!isDead)`) while visible and not suspended / cloaked; no weapon in the hub because the sender clears `HAS_WEAPON`. Sprinting remotes puff dust on every stride-phase π boundary. No collision with the local player. Test queries: `heldItemId`, `armorId`, `isGreyed`, `isShown`, `heavySlashProgress`, `poseView`. `dispose()` clears `ref.avatar`, frees the held-item look and the downed beacon, detaches the avatar's weapon socket and hands the body back to the pool (`SoldierPool.release`; without a pool it calls `SoldierModel.dispose()`). **2026-09-10 (몸 재사용)**: the constructor takes an optional `SoldierPool` and gets its body from `pool.acquire(NET_SLOT_COLORS[slot])`. **`weaponSocket` is a fresh `Object3D` per avatar**, parented at identity inside `model.weaponSocket` — a pooled body may have served another avatar a moment ago, and `weapons/RemoteWeapons` keys its model on socket identity (`e.socket !== socket` → rebuild), so the model's own socket must never be handed out twice; `dispose()` detaches that object and whatever `weapons/` · `implants/` hung on it leaves with it (the same subtree disposing the model used to detach). `shoulderSocket` is still the model's (carried bodies are evacuated before any dispose). A `disposed` guard makes `update` / a second `dispose` no-ops, since the body may already drive someone else. |
| `GearLook.ts` | **Shared procedural gear looks** (Phase 7): `buildArmorPlate(def: ArmorDef)` — chest / back plates + shoulder caps tinted with `ArmorDef.color`, one accent rib per tier I..V on the chest, emissive rim strips for uniques (tier 0); `buildHeldItem(category)` — stim cylinder with a glowing fluid core / grenade sphere with cap + spoon / boxy gadget with a status light (anything else = gadget), oriented -Z along the arm like a weapon. Each returns a `GearLook {group, materials, dispose()}` that owns its geometries / materials (`Layers.NO_RAYCAST`, no lights). `SoldierModel.setArmor` uses the first for both the local soldier (`PlayerGear.armor`) and remote avatars (`ar`), `RemoteAvatar` the second. |
| `PlayerController.ts` | Kinematic controller: camera-relative acceleration (ground 34 / decel 26 / air 7 m/s²), speeds by `MoveInput.stance` (walk 4.2 / sprint 7.2 / crouch `PLAYER_CROUCH_SPEED` 2.4 / prone `PLAYER_PRONE_SPEED` 1.3; aiming ×0.8 standing, ×0.85 crouch/prone), gravity, single jump (coyote 0.1 s, stand only), **dive** (`MoveInput.dive` → 7.5 m/s horizontal in the wish dir or camera forward + 3 m/s up, no steering until touchdown or 0.9 s → `MoveResult.diveEnded`, slide bled ×0.35), heightfield ground with snap-down, steep-slope (>50°) sliding, `world.resolveCollision`, ship-box clamp (`shipBounds`), **`interior: InteriorCollider`** mode (takes precedence: ground = `getFloorAt`, push-out = `resolveCollision`, no slope sliding, no map bounds, `world` may be null; while rising, an upward `raycast` from hips + 0.6 m clamps feet + `PLAYER_HEIGHT` under the ceiling and kills `vel.y`), `speedMultiplier` for slows. Stride phase drives footsteps and animation (cycle length sprint 1.9 / walk 1.45 / crouch 1.1 / prone crawl 0.8 m); the gate is `grounded && speed > STRIDE_MIN_SPEED && !rolling` — **`STRIDE_MIN_SPEED` is exported** (2026-09-10) because `RemotePlayerSystem` applies the same threshold to snapshot velocity when it emits `remote:footstep`. **차량 탑승** (2026-09-10, `updateRide` / `recordRide` / `releaseRide` / `applyRideInertia` + `riding` getter) — 아래 *차량 탑승* 절. |
| `CameraRig.ts` | Over-the-right-shoulder rig: hip 3.2 m (+0.35 sprint, −0.25 crouch, −0.5 prone, +0.3 dive) / ADS 1.8 m / **scoped ADS 0.7 m**, shoulder 0.55 → ADS 0.42 → scoped 0.35, pitch clamp [−60°, 70°] (min blends to −25° while prone, and on to −6° when the ground 1.5 m behind the player is ≥ 1.5 m higher than the feet — the same *rear rise* lifts the pivot by 0.6 × rise), sensitivity 0.0022 × (currentFov / baseFov) while aiming (4× scope → ¼), spring-damped pivot & distance. **Collision** (see *Camera collision* below): `world.raycast` ray (starts 0.35 m higher, min distance 0.6 → 1.2 m while prone) AND `interior.raycast` when set; 4 terrain-height samples along the remaining segment keep the camera ≥ 0.35 m above terrain; slab clamp against `interior.bounds` (hub) or `shipBounds` (dropship); hard floor `getHeightAt + 0.3` at the final position. Pull in instantly, ease out with `min(spring, collisionDist)` so the ease-out can never pop through. `pivotDistance` (actual camera → shoulder pivot, override included) feeds the body fade; `isOverridden`. Trauma-based shake (`camera:shake`), recoil offset with 35 % permanent kick, cutscene override blend (hellpod, hub docking / launch via `PlayerRef.setCameraOverride`). `snapTo` also places the camera behind the new pivot immediately; `jumpTo(pivot, yaw?)` (teleport) carries the camera along by the pivot offset without touching pitch / springs. FOV: base 70, sprint +3°, ADS = base − 20° when `aimZoom ≤ 1`, else base / `aimZoom`, × `fovMul` (→ `SLASH_FOV_MUL` while `viewWiden`); damp 6. **No head-bob** — nothing in the rig oscillates with the stride phase; the pivot's vertical follow is soft on the ground (damp 7, airborne 30) while horizontal stays tight (30). `getAimRay` origin/direction come from the unshaken rig pose. |
| `SoldierModel.ts` | Procedural armoured trooper (~1.8 m, faces -Z): blue-grey steel plates (0x3a4150) over a dark undersuit (0x22262e), low metalness / roughness ~0.55 so hemisphere fill reads (no env map), accent trim (belt, chest stripes, crest, shoulder bars, boot trim, cape hem), subtle emissive visor, backpack, 4-segment cape. `constructor(accentColor = SOLDIER_DEFAULT_ACCENT /* 0xffc23a */)` — the local player keeps the yellow; remote avatars pass `NET_SLOT_COLORS[slot]`, and a non-default accent also tints the visor glow 50 % toward it. `accentColor` is readable on the instance. `update(dt, time, pose)` damps joints toward targets: breathing, walk/run cycle (legs, knees, arm swing, hip bob/roll, torso lean), crouch, jump/fall tuck, low-ready / ADS arm poses with pitch, reload hand motion, recoil jerk, hit flinch, torso twist toward camera, cape trail/flutter, death fall. **전투불능 (2026-09-08)** is its own pose: `p.downed > 0` hands the whole frame to `poseDowned`, which tips the body **backwards** onto its back (`bodyGroup.rotation.x → −1.5 × easeOutCubic(downed)`, a slight z tilt, hips low) and settles into a living shape — one knee drawn up, the right arm clutching the chest, the left flung out, head lolled, a shallow breathing rise — instead of the Phase 2 "prone crawl with a 0.45 rad side roll", which is gone. It takes over the skeleton the way `poseDead` does, so no crawl / aim / weapon blend leaks into it, and `weapons` holsters the gun while downed so the hands are empty. `SoldierPose.prone` (hips pitched −85°, pelvis at 0.27 m, legs back, elbows planted, forearms up so the weapon points forward, head lifted; crawl cycle from `stridePhase` while moving) blends over the upright pose; the root stays at the feet and nothing sinks below y = 0. (The superman dive pose — `SoldierPose.dive`, `dvW` — was deleted in Phase 7: the key rolls instead, and both producers only ever wrote 0.) **Quick-use poses** (Phase 2, arms only, faded out while lying): `SoldierPose.holdItem` (0..1) = one-handed item pose — right upper arm 0.75 rad forward, forearm folded 1.75 rad so the hand (`weaponSocket`) sits in front of the chest, left arm swings like an unarmed walk; `SoldierPose.throw` (0..1) = grenade wind-up — right upper arm swung up and back past vertical (3.35 rad, elbow folded 1.55, hand behind the head), left arm out front, torso leans back 0.14 and twists −0.38 toward the throwing shoulder. Both are plain lerps on the arm targets, so the callers damp the blend values. **Phase 6 poses** (optional fields): `meleeHeavy` turns the `melee` progress into the two-handed 용검 sweep, `charging` / `spraying` / `heavyCarry` are the braced / hip-spray / heavy-carry stances (see *Phase 6* below). **Phase 7**: `cooking` (optional) = pin pulled — item kept in front of the chest, left hand reaching across to it, over `holdItem`; `setArmor(def | null)` parents a `GearLook.buildArmorPlate` into the torso at the body render order (rebuilt only when `def.id` changes, follows fade / grey; `armorId` getter); `setGlow(on)` = overcharge rim (emissive on the steel / armor plate materials, damped 8, pulsing; `glowAmount`); `setGreyed(on)` = suspended-member tint (every body material desaturated to a flat grey from its build colour, visor dimmed; restored exactly when off; `isGreyed`). `weaponSocket` in the right hand (weapon -Z = along the arm). **Occlusion silhouette** (`setSilhouette(on)`, `silhouetteVisible`): every body mesh gets a child `Mesh` named `sil` sharing its geometry with one opaque `MeshBasicMaterial({ depthFunc: GreaterDepth, depthWrite: false, fog: false })` — black for the default accent, slot colour × 0.16 for remotes — `renderOrder` 1 while all body meshes are `renderOrder` 2, so the silhouette's depth test only ever sees the world and the body then overwrites it wherever it is really visible (see *Occlusion silhouette*). `castShadow` false, `Layers.NO_RAYCAST`. Anything parented into `weaponSocket` is lifted to `renderOrder` 2 each `update` (checked per frame, traversed only when a new child appears). **Near fade** `setFade(alpha)` / `fade`: switches the body materials to transparent + opacity only while alpha < 1, hides the body group under 0.02, and suppresses the silhouette while faded. **Phase 10 (모델 롤백 후에도 유지되는 추가분)**: `shoulderSocket` (right shoulder, torso-local `(0.12, 0.36, 0.02)` yawed `+PI/2` so a prone body lies **across** the shoulder pads) is where a carried squadmate's root is parented at `PLAYER_CARRY_OFFSET`; `SoldierPose.carry` blends the fireman-carry pose (right arm up over the shoulder, left arm free, torso forward, knees soft, head tucked); `syncSocketRenderOrder()` lifts the children of **both** sockets to the body render order and `resetPose()` restores both socket rotations. The Splatoon-style 3등신 rewrite that shipped in Phase 10 was reverted on 2026-09-07 — this row describes the pre-Phase-10 body again. **공유 GPU 자원 (2026-09-10)**: 지오메트리 43개는 치수 키(`box:w|h|d` …)로 모듈 캐시 `SHARED_GEOS` 에서, 실루엣 머티리얼은 색 키로 `SHARED_SIL_MATS` 에서 온다 — 로컬 병사 · 원격 아바타 · `game/Corpses` · `Portraits` · `ui/menus/SoldierPreview` 가 전부 같은 객체를 쓰고 **`dispose()` 는 그것들을 건드리지 않는다**(인스턴스 머티리얼 6개와 방탄복 판만 해제; 다른 WebGL 컨텍스트와 공유해도 되는 이유는 three.js 가 GPU 버퍼를 렌더러별로 잡기 때문이다). 몸 머티리얼은 **공유하지 않는다** — `setFade` · `setGreyed` · `setGlow` · 바이저 맥동이 인스턴스마다 값을 바꾼다. `resetForReuse()` 가 생성 직후 상태(방탄복 없음 · 발광 0 · 회색 해제 · 불투명 · 실루엣 끔 · 중립 자세 · 루트 분리)로 되돌린다 — `SoldierPool` 용. 소켓 렌더 순서 동기화는 소켓 자식 **두 단**까지 보고(원격 아바타의 아바타별 소켓 밑에 무기가 달린다) 프레임당 할당이 없다. |
| `SoldierPool.ts` | **원격 아바타 몸 풀** (2026-09-10). `RemotePlayerSystem` 이 들고 `RemoteAvatar` 가 쓴다. `acquire(accent)` = 같은 악센트로 주차된 `SoldierModel` 을 꺼내거나 새로 짓는다, `release(model)` = `resetForReuse()` 후 악센트당 `NET_MAX_PLAYERS − 1` 개까지 주차(넘치면 dispose, 이미 주차된 몸의 이중 반환은 무시), `size`, `dispose()`. 아바타를 **언제** 끝내는지(`hub:entered` · `game:newMission` · `game:abort` · 제거 이벤트)는 그대로이고, 끝날 때 몸을 새로 짓지 않게 됐을 뿐이다. |
| `Portraits.ts` | **`createPortraits(ctx, host, cells)` → `PortraitRef`** (Phase 10, `PlayerRef.createPortraits`, hosted by the hub's 발사 준비 패널). One canvas with its **own** `THREE.WebGLRenderer` + `Scene` + `PerspectiveCamera` (fov 28, 4.3 m back, looking at y 1.0) + 2 `DirectionalLight`s + a `HemisphereLight`, because `core/Engine` renders through the composer at the end of the frame and offers no post-render hook. `cells` cells are drawn one per `setViewport` / `setScissor` / `setScissorTest(true)` pass (the canvas is cleared once, `autoClear` off, `alpha: true` so the panel shows through) with only that cell's model visible. Each cell owns its **own** `SoldierModel` — nothing is shared with the main renderer's avatars (a second GL context would re-upload every geometry and the two `dispose()` paths would fight) — rebuilt when the cell's slot changes, since the accent colour is baked at construction. `setMember(i, {slot, armorId} \| null)` (null = empty cell, nothing drawn), `setYaw(i, yaw)` (`HUB_READY_PORTRAIT_YAW`), `render(dt, time)` (no-op while `!visible`, resizes from the host element), `setVisible`, `dispose()`. Armor is resolved with `RemoteAvatar.resolveArmorDef`; the silhouette pass stays off. Returns **null** when a second WebGL context cannot be created — callers degrade to a name-only cell. |
| `Carry.ts` | The 들쳐메기 seam between the two systems in this folder: `CarryTarget` / `CarryStatus` / **`CarryHost`** (`findCarriable` / `targetOf` / `carryStatus` / `attachCarried` / `detachCarried`). `PlayerSystem` owns the rules but not the bodies; `RemotePlayerSystem` implements the host and installs itself with `PlayerSystem.setCarryHost(this)` in its own `init`. Without a host `carry()` always fails, so single-player is untouched. |
| `Hellpod.ts` | Procedural pod (floor, struts, nose cone, thrusters, 4 petal doors hinged at the floor). Drop choreography: 2.4 s fall from +150 m with thruster particles → impact (ground blast, fireball, sparks, flash) → 0.35 s hold → 0.55 s doors open (ease-out-back) → 0.5 s step-out. `getCameraPose` provides the cutscene camera during fall/impact. Stays in the world as a prop. **`group` = transform + `thrusterLight` and is always visible; `body` = every mesh and carries the visibility toggle** — a light under a hidden group is not counted by three.js, so toggling `group` changed `numPointLights` and recompiled every material in the scene (2026-09-10; `hide()` on a rejoin restore followed by a rescue `start()` did it twice mid-raid). |
| `RemotePods.ts` | **아군의 강하 포드** (2026-09-09). `RemotePlayerSystem` 이 `pod drop` 을 받으면 여기서 같은 `Hellpod` 인스턴스를 떨어뜨린다 — 낙하 · 착지 충격 · 문 열림 + 위치 오디오, 카메라 컷만 없다. 분대원 한 명당 포드 하나를 재사용하고(최대 3), 착륙한 포드는 소품으로 남는다. 아바타를 감추는 일은 하지 않는다 — 강하 중인 본인의 `PlayerFlags.DROPPING` 이 이미 그 일을 한다. **포드 3개는 생성자(= `RemotePlayerSystem.init`)에서 한 번 씬에 들어가 광원 세기 0 · 몸 숨김으로 대기한다** (2026-09-10) — `pod drop` 이 올 때 새로 만들면 추진기 `PointLight` 가 늘어 씬 전체 셰이더가 다시 컴파일됐다(실측 분대원마다 2.7–3.1초 정지). 배정은 `byPeer`, 빈 포드가 없으면 착륙이 끝난 포드를 회수한다. `clear()` 는 **숨기기만**(`Hellpod.hide`) 하고 배정을 잊는다; 씬에서 빼는 `dispose()` 는 시스템 종료 전용이다. 대가: 씬에 광원 3개가 **늘 상주**한다(허브 · 레이드 · 싱글 모두 같은 수라 개수는 바뀌지 않는다). |
| `index.ts` | Barrel (also exports `RemotePlayerSystem`, `RemoteAvatar`, `DebugRemoteRef`, `Ghost`, `SOLDIER_DEFAULT_ACCENT`, `buildArmorPlate` / `buildHeldItem` / `GearLook`, `createPortraits`, `CarryHost` / `CarryStatus` / `CarryTarget`). |

## 2026-09-09 — 강하 포드 동기화 · 구조선 부활 · 시체가 아바타를 대신한다

- **`startDrop(kind)`** (`parts/Spawn`) 이 멀티에서 `pod drop {who, p, yaw, kind}` 을 `'others'` 로 보낸다
  (`kind` 0 = 미션 시작, 1 = 구조선). 받는 쪽은 `RemotePlayerSystem` → `RemotePods`.
- **`rescueRevive(position)`** (`parts/Spawn`) — `rescue:landed {target, position}` 에서 **내가 대상일 때만**
  (`ctx.net.localId`, 싱글은 `'sp'`). 호스트가 정한 착륙 지점에 그대로 서고(분대 스폰 링을 다시 씌우지 않는다),
  체력 `RESCUE_REVIVE_HP`, 인벤토리는 사망 때 시체로 넘어갔으므로 **빈손**, 그리고 `startDrop(1)`.
  페이즈 정리는 `game/parts/Death.onRescueLanded` 가 한다.
- **`corpse:playerSpawned`** 가 내 것이면 로컬 병사 모델을 감춘다 — 같은 자리에 몸이 둘일 이유가 없다
  (부활의 `respawnAt` 이 다시 보이게 한다). 원격도 같다: `RemoteAvatar` 는 `ref.isDead && ctx.corpses.latestOf(id)`
  이면 그리지 않는다 (전투불능은 여전히 아바타다 — 제세동기로 일어난다).
- **자동 부활은 사라졌다** — `player:respawn` 은 이제 훈련장 재시작과 재접속 복귀 fallback 만 탄다.

## Hub & interiors (appended `PlayerRef` members — what the hub may rely on)
- `setInterior(collider | null)` / `interior`: while set, the controller walks on `collider.getFloorAt`, is pushed out by `collider.resolveCollision`, has no slope sliding and no map-bounds clamp, jumps are allowed and ceiling-clamped by `collider.raycast` (straight up from hips + 0.6 m), and the camera collides with `collider.raycast` + is clamped to `collider.bounds`. `ctx.world` may be null — every world read in `PlayerSystem` / `PlayerController` / `CameraRig` is null-safe. Setting a collider snaps the feet onto the deck if they are within 1.5 m of it. Takes precedence over `setShipInterior`. Cleared by `respawnAt` (i.e. every `world:ready`) and on `hub:left`; **not** cleared by `game:abort`, so `setInterior` may be called before or after the abort the hub triggers.
- `spawnStanding(position, yaw)`: hellpod hidden, detached from any parent, ship box cleared, `isInPod = false`, controller reset at `position` (snapped to the interior deck when within 1.5 m), alive, full hp + stamina, stance stand, aim/blends reset, controls enabled, model visible & un-faded, camera snapped behind the player at `yaw`, `player:healthChanged {delta 0}` + `player:spawned`. Does **not** touch `interior` (either call order works) and does **not** release an active camera override — release it with `setCameraOverride(null)`.
- `setCameraOverride(pos, lookAt?, snap?)`: cutscene camera; blends to `pos` looking at `lookAt` (damp 12 in, 4 out); `snap` jumps to full weight; `null` releases back to the rig. Same mechanism the hellpod uses.
- `setInPod(inPod)` / `isInPod`: movement input, sprint and aiming are cut (velocity zeroed) and the local model is hidden; interaction (E) and the camera keep working so a pod can offer an "exit" interactable. Remotes read `PlayerFlags.IN_POD` and hide their avatar. Cleared by `spawnStanding` / `respawnAt` / `game:abort`.
- Gating: movement, stances, jump, sprint, stamina, stims, interaction and the click-to-relock fallback use `ctx.isControlActive()` (gameplay OR `'hub'`, no blockers). In the hub (`ctx.isHubPhase()`) **prone and dive are disabled** (Z is ignored unless already prone, `Keys.DIVE` — V since 2026-09-07 — does nothing); dive is also disabled whenever an `interior` is set. Weapons stay gated by `canUseWeapons()` / the weapons system's own `isGameplayActive()`.

## Downed / revive / respawn (Phase 2, appended `PlayerRef` members)
- **Entering downed**: `takeDamage` that would bring hp to 0 (and the player is not already downed) sets `hp = 0`, `isDowned = true`, `downHp = PLAYER_DOWN_HP` (100), forces stance `prone`, cancels aiming/sprint, shakes the camera, plays `player_hurt` at pitch 0.6 and emits `player:downed {position}`, `player:downHpChanged {downHp, max}`, `player:healthChanged {hp: 0}`. `isDead` stays **false**. The 0.15 s invulnerability window still applies.
- **While downed**: crawl only — WASD moves at `PLAYER_PRONE_SPEED × PLAYER_DOWN_SPEED_MUL` (1.3 × 0.6 m/s), stance is pinned to `prone` (C / Z / Space / Shift / V ignored; `stance` reports `prone` for snapshots), no aiming, `canUseWeapons()` false, `applyStim` returns false, `heal` is a no-op, interaction (E) disabled. `downHp` bleeds `PLAYER_DOWN_BLEED_PER_SEC` (1/s, fractional accumulation, `player:downHpChanged` on each whole point). `takeDamage` while downed subtracts from `downHp` instead (same invulnerability; `player:damaged {hp: 0}` + `player:downHpChanged`, no `player:healthChanged`). `downHp ≤ 0` → `die()` → `player:died`. Holding `Keys.GIVE_UP` (Space) for `PLAYER_GIVE_UP_HOLD` (1.5 s, needs `isControlActive()`) → `die()`. The model plays the prone pose + crawl cycle; the silhouette stays on. Any `takeDamage` arriving through the net (`dmg`) follows the same rules.
- **`revive()`** (net calls it on `revive done`): only while downed → `isDowned = false`, `downHp = 0`, `hp = PLAYER_REVIVE_HP` (10), 0.5 s invulnerability, stance stays `prone` (the player stands up with Z / C / sprint as usual), controls enabled, emits `player:revived {hp}`, `player:healthChanged {delta: hp}`, `audio:play stim`. No-op when not downed or dead.
- **`applyStim(healAmount)`**: starts the 1.5 s heal-over-time (`player:stimUsed {hp}`, `player:healthChanged` per frame, `stim` SFX) and returns true; false when not spawned / dead / downed / hp already full / a stim is still healing. Consuming the item, the F key and `stim:countChanged` belong to weapons (quick-use wheel) now.
- **`applyHeal(amount, seconds, quiet?)`** (2026-09-07): the same pool with the **consumable's own** duration — `applyStim(n)` is now `applyHeal(n, 1.5)`. `seconds ≤ 0.05` is clamped, `quiet` skips the SFX **and** the "already healing" refusal so the 회복 스프레이 can top the pool up 10×/s (each tick adds to `healPool` and raises `healRate` if it is faster). The pool and rate are both cleared when it empties, so a slow bandage after a fast spray still takes its full 5 s.
- **`respawn(position)`** (bus `player:respawn {position}` from game/GameFlowSystem, 30 s after death on request): `respawnAt(resolveSpawn(position))` (multiplayer slot ring) + the hellpod drop → `player:spawned`, then `player:landed`; alive, not downed, full hp / stamina, stance stand, controls back after the doors open. `resetAll` / `spawnStanding` / `respawnAt` clear the downed state (`clearDowned`).
- **Revive interactable** for downed teammates lives in `RemotePlayerSystem` (see the table): hold E `PLAYER_REVIVE_HOLD` s within `PLAYER_REVIVE_RANGE` m → `revive progress/cancel/done` relayed to the peer, whose `NetSystem` calls `ctx.player.revive()`. `Interactable.onHoldProgress / onHoldCancel` are driven by `PlayerSystem.updateInteraction` for every hold interactable.

## 실드 (2026-09-10 — 방탄복이 피해 감소를 대신한다)

**방탄복은 더 이상 피해를 깎지 않는다.** `ArmorDef.shield` 만큼의 **추가 체력 풀**을 주고, 들어온 피해는
그 풀을 먼저 비운 뒤 남은 만큼만 `hp` 로 간다. `PlayerRef.damageReduction` / `PlayerGear.damageReduction` 은
**늘 0** 이고 `parts/Vitals.applyDamage` 의 `raw * (1 - damageReduction)` 경로는 통째로 사라졌다 — 계약이라
지우지 않았을 뿐이다 (`airstrike` · `secondary` 와 같은 처리).

- **상태** (`PlayerSystem`): `shield` / `maxShield`(= `gear.shieldMax`) / `shieldRarity` / `shieldTier`.
  `maxShield` 는 장착한 방탄복의 `ArmorDef.shield` 이고, 방탄복이 없거나 **내구도 0(파손)** 이면 0 이다.
- **피해**: `absorbShield(raw)` 가 실드가 먹은 양을 돌려주고 (`player:shieldChanged` 발행), 나머지가 체력으로
  간다. `wearGear(absorbed)` 가 **실드가 먹은 만큼** 판을 닳게 한다 (`ARMOR_DURABILITY_PER_DAMAGE`, 예전
  뎀감으로 흡수하던 양과 같은 자리). 피격 피드백(흔들림 · 소리 · `player:damaged.amount`)은 `dealt + absorbed`
  를 쓴다 — 실드가 다 막아도 맞은 티는 나야 한다.
- **회복**: 스스로 재생하지 않는다. ① **함선(허브)에서는 늘 가득** — `syncShield()` 가 `ctx.isHubPhase()` 동안
  매 프레임 최대치로 채우므로 장착 · 교체 · 수리가 곧바로 반영되고, 출격하면 그 상태로 나간다.
  ② 레이드 중에는 **실드 충전기 소모품**(`chargeShield(amount)`, `Infinity` = 가득)뿐이다. 방탄복이 없거나
  파손이거나 이미 가득이거나 전투불능/사망이면 **아무것도 하지 않고 false** — 호출자(weapons 퀵 사용)가
  아이템을 소모하기 **전에** 이걸로 묻는다.
  ③ **레이드 중 방탄복 교체는 채워 주지 않는다** — 새 최대치로 자르기만 한다 (여벌 방탄복이 공짜 충전기가
  되면 충전기가 의미를 잃는다).
- **비우기**: `enterDowned` · `die` 가 `clearShield()` 로 0 으로 만든다.
- **이벤트**: 바뀌는 모든 지점에서 `player:shieldChanged {shield, maxShield, delta, rarity, tier}`. 발행은
  `emitShield` 한 곳이고 같은 값을 두 번 보내지 않는다. `syncShield()` 가 `update()` 안 `gear.update` 바로 뒤에서
  돌기 때문에 **스폰 · 리스폰 · 장착 · 해제 · 교체 · 파손 · 수리 · 함선 복귀**가 전부 자동으로 잡힌다 (그
  경로들이 `parts/Spawn` 에 흩어져 있어도 손댈 필요가 없다). 좌하단 게이지 한 칸은 `ARMOR_SHIELD_PER_SEGMENT`(20).
- **체력 최대치**: `maxHp` 가 `readonly maxHp = PLAYER_MAX_HP` 에서 **getter** 가 됐다 —
  `PLAYER_MAX_HP + bonusMaxHp`. 지금은 보너스를 주는 출처가 없어 결과는 그대로 100 이지만, "다른 효과로 늘어날
  수 있다" 는 요구를 위한 자리다. `player:healthChanged.maxHp` 는 계속 이 값을 쓴다.

## Camera collision (hill / prone fix)
The reported "prone on a hill looks into the terrain" came from the single backward ray: it started 0.35 m above the pivot, so the camera placed 0.3 m before the hit could still sit under a slope that rises between the pivot and the hit. `CameraRig.update` now (1) ray-casts against the world AND the interior, (2) samples the terrain height at 4 points along the remaining pivot→camera segment and pulls in to the first point that would dip under `height + 0.35` (linear crossing between samples), (3) slab-clamps to `interior.bounds` / `shipBounds`, (4) hard-clamps the final camera to `getHeightAt(cam) + 0.3` (both the desired and the damped position). While prone the ground 1.5 m behind the player is probed; a rising rear lifts the pivot (0.6 × rise, damped) and narrows the pitch-down limit from −25° toward −6°. Pull-ins stay instant; the ease-out spring is always capped by the live collision distance. When the camera ends up within 0.9 m of the shoulder pivot the soldier fades out (fully hidden at 0.45 m) instead of clipping.

## Occlusion silhouette
A rock, wall or prop between the camera and the soldier shows the hidden part as a flat black silhouette (remotes: slot colour × 0.16), without any postprocessing: per body mesh a child mesh shares the geometry and draws with `GreaterDepth` / no depth write at `renderOrder` 1 — after every default-order opaque object, before the body (`renderOrder` 2). Because the depth buffer then only holds the world, the test is exactly "occluded by the world"; the body draws afterwards and wins wherever it is visible, so self-occlusion (rear arm behind the chest) never paints black on the visible model. The material is opaque on purpose — a transparent one would be sorted after the body and break that guarantee. Cost: ~43 tiny extra draws per soldier sharing one material, no lights, no shadows, `Layers.NO_RAYCAST`. Off while dead, while the hellpod is active (also the step-out), while in a pod, while scoped and while faded. Weapon models parented into `weaponSocket` are lifted to `renderOrder` 2 so the gun in front of the chest never receives black patches.

## Multiplayer notes
- Hub: avatars render in the shared ship as long as `ctx.net` lists remote refs; `IN_POD` hides them; `hub:entered` clears all avatars once so mission positions don't linger.
- `RemotePlayerSystem` never simulates: position, velocity, yaw, pitch, stance, flags and `isDead` come from `ctx.net`'s interpolated refs; the avatar only owns damped animation blends. Nothing collides with remote avatars.
- Other agents' hooks: weapons parents a `WeaponModel` into `ref.avatar.weaponSocket` (weapon -Z = barrel forward, same as the local socket) and must drop it on `net:remotePlayerRemoved` / `game:abort` — disposing the avatar detaches the whole subtree. UI reads `ref.avatar.getHeadPosition(out)` for nameplates.
- Remote hellpods **are** rendered since 2026-09-09 (`RemotePods`, three pods pre-built in the scene since 2026-09-10); the peer's avatar is invisible while `DROPPING` and lands with a dust puff.
- Local death in multiplayer still emits `player:died`; mission flow (respawn countdown, spectate) is game/GameFlowSystem's call. NetSystem sets `PlayerFlags.DOWNED` from `ctx.player.isDowned` and `HOLDING_ITEM` from the weapon state; remotes render `DOWNED` as prone + crawl and get a `revive:<id>` interactable (no remote hp bar for `downHp` — that is the peer's own HUD).
- Phase 7: the throw wind-up (`THROWING`), cooking (`COOKING`), held consumable (`h` → held mesh), unique-weapon stances, heavy slash, armor (`ar`) and overcharge glow are replicated on remote avatars; attachment meshes are weapons/' (`att` → `RemoteWeapons`).

## Key bindings (shared/constants `Keys`)
| Key | Action |
|---|---|
| W A S D | move (camera relative) |
| Shift | sprint (stand only, forward input, needs stamina; while crouched it stands up first) |
| Space | jump (stand only, 12 stamina; while crouched it stands up and jumps; while prone it only stands up) |
| **C** | toggle crouch (stand ↔ crouch; prone → crouch) |
| **Z** | toggle prone (stand/crouch → prone; prone → stand) |
| **V** (`Keys.DIVE`) | roll (구르기, replaced the dive): from stand/crouch on the ground, `ROLL_STAMINA_COST`, denied in the hub / interiors / from 무거움 upward; emits `player:dived` as its alias. **2026-09-07 (커서 rework)**: moved off Left Alt, which is now `Keys.CURSOR` (마우스 커서 표시); V was free because the 이전 무기 swap was retired |
| RMB | aim (`MouseButtons.AIM`; not while downed) |
| E | interact (tap, or hold for `holdTime` targets — e.g. 10 s revive on a downed teammate; not while downed) |
| **Space (held 1.5 s, downed only)** | give up (`Keys.GIVE_UP`) → `player:died`; `player:giveUpProgress {t}` while held (Phase 9) |
| **F (tap, ally in range)** | **Phase 10**: shoulder / put down a downed squadmate within `PLAYER_CARRY_RANGE` (`Keys.MELEE`, aliased `Keys.CARRY`). Consumed with `ctx.input.consume` so weapons never sees it as a melee swing; with nobody in range the tap falls through to the melee |
| **E (사다리 옆)** | 2026-09-11: world 의 사다리 `Interactable` → `ladder:grab` → 매달림. **매달린 동안** W/S = 오르내림 (`LADDER_CLIMB_SPEED`), Shift = 빠르게 (`LADDER_SPRINT_SPEED`, 초당 `LADDER_SPRINT_DRAIN` 스태미나), Space = 놓고 위 + 사다리 너머로 도약 (`STAMINA_JUMP_COST`), E = 그 자리에서 놓기. 발치에서 S = 내려섬, 꼭대기에서 W = 옥상으로 올라섬. 자세 키 · 구르기 · 근접 · 조준 · 무기는 없다 |
| F (otherwise) | **not handled here** — `Keys.MELEE` / `Keys.QUICK` belong to weapons (melee, quick-use wheel → `ctx.player.applyStim`) |

Stance rules: no stance change while airborne, diving or during the 0.35 s prone → upright transition (during which jump/sprint/dive are denied and speed is halved). No dive inside the extraction ship box or any `interior`; crouch and prone are allowed in the ship box; in the hub only crouch (no prone, no dive). Jump: allowed on terrain and in interiors (ceiling-clamped), denied in the extraction ship box.

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
- `WorldSystem` emits `world:ready {playerSpawn}` synchronously after `game:newMission`; `ctx.world.ready` is true before the player moves. In the hub `ctx.world` is null — handled.
- `hub/HubSystem` calls `setInterior(collider)` + `spawnStanding(spawn, yaw)` on `hub:entered` (either order), `setInPod(true/false)` when boarding / leaving a launch pod, `setCameraOverride(...)` for docking / launch cutscenes and releases it with `null`, and `setInterior(null)` (or just emits `hub:left`) when the ship is torn down.
- `ExtractionSystem` calls `attachTo(ship)`, `setShipInterior(bounds)` and `setControlsEnabled(false)` for liftoff. **The bounds object is mutated every frame** and the deck is expected to move: `update` derives `controller.position` from the parent's matrix at the top of the frame, and since 2026-09-10 `lateUpdate` **derives it again** — `extraction` registers after `player`, so the ship's climb lands between the two and the camera would otherwise trail the bay by a whole frame (≈0.4 m at the top of the climb). Both reads are derivations of the same local transform, so running them twice changes nothing else.
- `WeaponSystem` calls `setAimZoom(zoom, scope)` on equip/swap/unequip (default `(1, false)`); the rig never resets it on respawn. It also owns the F key: consumes the stim item then calls `applyStim(heal)`, calls `setLookLocked(true)` while its wheel is open and passes `throwing` / `holdingItem` in `setWeaponState`.
- `net/NetSystem` calls `revive()` on `revive done`, reads `isDowned` for `PlayerFlags.DOWNED`; `game/GameFlowSystem` emits `player:respawn {position}`.
- Audio ids emitted: `player_hurt` (pitch 0.6 on going down, 0.85 while downed), `player_death`, `player_land`, `player_jump` (also for the dive launch, pitch 0.85), `stim` (stim start, revive, remote revive done), `interact`, `hellpod_fall`, `hellpod_impact`, `hellpod_open`.

## Verification (2026-09-06, Phase 2 down / revive / respawn)
Headless Chrome (puppeteer-core + swiftshader, static `vite build` served by `vite preview` so the concurrent agents' HMR reloads could not interrupt; waits on `ctx.time`), 44/44, 0 console errors: `takeDamage(200)` → `isDowned`, hp 0 / `downHp` 100, stance prone, `canUseWeapons` false, `player:downed` once and no `player:died`; C ignored; bleed 3.2 s → `downHp` 96 with a `player:downHpChanged` per point; `applyStim` refused; `takeDamage(30)` → `downHp` 66; crawl speed < 1.6 m/s; `revive()` → hp 10 prone not downed, `player:revived`, second `revive()` no-op; Z stands up; `applyStim(50)` → +50 over 1.5 s + `player:stimUsed`; second down resets `downHp` to 100; `takeDamage(150)` → `player:died`, phase `dead` 2.5 s later (GameFlow); `player:respawn` (after `setPhase('deploying')` like GameFlow) → `isDropping`, alive, full hp, stand → `player:landed`, weapons usable, phase `playing`; Space held 1.8 s while downed → died; `setLookLocked(true)` ignores 400 px of mouse delta, unlock works again; `setWeaponState` with `throwing`/`holdingItem` accepted; test hold interactable: `onHoldProgress` streamed while E held, one `onHoldCancel` on early release, completed hold → `interact()` once with no re-hold while E stayed held; debug remote with `isDowned` → `revive:<id>` registered (prompt `부활: 동료`, hold 10, radius 3, same `position` instance, `canInteract` true), removed when the flag clears and on `debugClear`.

## Verification (2026-09-05, hub / camera / silhouette)
Headless Chrome (puppeteer-core + swiftshader) driving the system pipeline directly (`__game.systems` update/lateUpdate with a synthetic clock, `KeyboardEvent`s for Z/C/W/Space/Alt), 26/26: mission → playing; 43 `sil` meshes for 43 body meshes, `GreaterDepth` + no depth write, render order 1/2, no shadows, `NO_RAYCAST`, 14 weapon meshes lifted to order 2, silhouette visible while playing; a test wall between camera and soldier rendered the black silhouette through it (frame grabbed via `canvas.toDataURL`); 4 slope spots (normal.y 0.7–0.86), prone via Z, 8 yaws × 4 pitches each → camera clearance over terrain min 0.300 m across 128 checks, prone pitch floor −25° respected; standing 32 checks min 0.349 m; override camera on the eye → fade 0.13 + silhouette off, released → fade 1 + silhouette back; debug remote hidden while `IN_POD`, silhouette on when visible; hub: `game:abort` → fake `InteriorCollider` (deck 10, ceiling 12.6, 8×8 room) → `setPhase('hub')`, `setInterior`, `spawnStanding` → on deck, full hp/stamina, `isControlActive`, walked into the wall and stayed inside, camera inside the bounds, Z ignored / C crouches / Alt no dive, jump head max 12.60 = ceiling clamp and landed on the deck, `setInPod` locks + hides + restores, `respawnAt` clears the interior. 0 console errors.

## Phase 4 (2026-09-06)
- `applyKnockback(direction, speed)`: `direction × speed` (normalised, y allowed) through the controller's `applyImpulse` path + a small shake. **Phase 7 fix**: ignored while dead / downed / not spawned / inside the hellpod, cancels an in-flight roll (and the hover), and always carries at least `KNOCKBACK_MIN_LIFT` (1.5 m/s) upward so the feet leave the ground (`grounded` cleared) and the shove is not eaten by ground friction. Emits nothing (`player:launched` stays the jump-pad / rocket-jump event). Used by the behemoth charge and `dmg.kb`.

## Phase 10 — 부상자 들쳐메기 · 준비 패널 초상화 (2026-09-07, `docs/DECISIONS.md` Phase 10)

### Character model — **rolled back** (2026-09-07)
Phase 10 replaced the armoured trooper with a Splatoon-style 3등신 character; the look was rejected and
`SoldierModel.ts` + `GearLook.ts` are **back at their pre-Phase-10 (`666ab86`) content**: helmet + visor, crest,
shoulder pads, backpack + canisters, chest plates and accent stripes, the 4-segment cape, long arms
(`0.3 + 0.3`), hips at 0.98 m and `ROLL_PIVOT_Y` 0.55 — plus the armor plates / held-item props sized for that
body again. Only the Phase 10 **additions** were ported forward onto it: `SoldierPose.carry`, the
`shoulderSocket` (torso-local `(0.12, 0.36, 0.02)`, yawed `+PI/2`, sitting under the shoulder pads at 0.52),
both sockets in `syncSocketRenderOrder()` / `resetPose()`, and the fireman-carry arm / torso / knee blend
(re-tuned ~0.2 rad lower than the short-armed version). `RemoteAvatar`'s nameplate anchors went back to
1.7 / 1.3 / 0.5 with `DOWN_MARKER_Y` 0.95. Nothing outside `src/player/` ever depended on the proportions
(`PLAYER_HEIGHT` / `PLAYER_RADIUS`, the eye heights, the hitboxes and `enemies/Targets.ts` were untouched in
both directions), so the rollback is confined to these three files. Everything still procedural, no assets.

### 부상자 들쳐메기 (appended `PlayerRef` / `PlayerWeaponHost` members)
- **`carry(id)`**: requires a `CarryHost` (installed by `RemotePlayerSystem`), the target inside `PLAYER_CARRY_RANGE`
  (2.2 m), downed + alive + present + not already somebody's load, and ourselves upright and free (`canAct()`, not
  already carrying, not carried). Parents that peer's avatar into `SoldierModel.shoulderSocket` at
  `PLAYER_CARRY_OFFSET`, locks movement for `PLAYER_CARRY_PICKUP_S`, cancels aim / sprint / roll / grapple / melee /
  hold-interaction, forces `stand`, emits `player:carryStarted {id, name}` and sends `carry pick`.
- **While carrying**: `speedMultiplier × PLAYER_CARRY_SPEED_MUL`, a dedicated movement branch that accepts **only**
  WASD + sprint; `SoldierPose.carry` puts the right arm up over the shoulder (torso leaning forward, knees soft).
  Aiming is suppressed and interaction (E) is off. C / Z / Alt / Space / E call `dropCarried('action')` and do nothing
  else that frame; `roll()` and `startMelee()` do the same for external callers. `canUseWeapons()` is deliberately
  **not** changed — `WeaponSystem.carryGate` needs it true to see the input and call `dropCarried('action')` itself.
- **`dropCarried(reason)`**: `'manual'` (the F tap) plays the `PLAYER_CARRY_DROP_S` put-down (movement locked for it);
  every other reason releases immediately so the action that caused it retries next frame. Sends
  `carry drop {target, p}` and emits `player:carryEnded {id, reason}`. Damage never drops a body.
  A per-frame `carryStatus` check ends the carry by itself with `'revived'` / `'died'` / `'reset'`.
- **F-tap precedence**: `PlayerSystem` reads `Keys.MELEE` (`KEY_ALIASES.CARRY`) **before** `WeaponSystem` updates and
  calls `ctx.input.consume(Keys.MELEE)` whenever it acts, so the same tap is never also a melee swing. With nobody in
  range the tap falls through untouched. The E-hold revive is unchanged.
- **`setCarriedBy(socket)` / `isCarried`** (the carried side): the `attachTo` ride-along pattern — the model root is
  parented into the carrier's socket at `PLAYER_CARRY_OFFSET`, the controller position is read back out of the world
  matrix every frame (so the camera, the snapshot and the enemies all follow), movement is frozen and `canAct()` is
  false. `null` re-attaches to the scene and drops the feet onto the interior deck / terrain under the socket.
  `RemotePlayerSystem` calls it when a peer's `carrying` points at `ctx.net.localId` (or via `debugCarryLocal`).
- **`RemotePlayerSystem`**: implements `CarryHost`; per frame `updateCarries` keeps every carried body parented to its
  carrier's `shoulderSocket` (`RemoteAvatar.carried` = instant local flag, OR-ed with the wire's `CARRIED` bit) and
  hands / takes back the local body. `RemoteAvatar` skips its `root.position` / `root.quaternion` writes while riding,
  and drives `SoldierPose.carry` from `PlayerFlags.CARRYING`. `remove()` / `clearAll()` evacuate whatever hangs on a
  shoulder before disposing the avatar (`dispose()` detaches the whole subtree). **`syncRevive` fix**: the revive
  interactable now owns its **own** `Vector3`, refreshed **once per frame** in `syncRevive` from `ref.position` — or
  from the carrier's shoulder-socket world position while the body is carried — so a shouldered squadmate can still be
  revived with E. (It is a per-frame writer, not a `carry()` side effect: right after `carry()` the prompt is one frame
  stale, which is why a test has to let a frame run before reading it back.)
- Debug: `debugCarryLocal(id, on)` fakes "that debug peer shouldered me" — it sets `ref.carrying` **and** calls
  `setCarriedBy` synchronously, so it behaves the same whether or not a relay session (and therefore a `localId`) is
  present; `updateCarries` then finds `mine === myCarrier` and leaves it alone.

### 준비 패널 초상화
`PlayerRef.createPortraits(host, cells)` → `Portraits.ts` (see the file row). `PlayerWeaponHost.getShoulderSocket()`
returns the local model's shoulder socket.

### 회복약
Unchanged here: `applyStim(healAmount)` and `player:stimUsed` keep their names and behaviour. The 2 s LMB hold, the
`heal:holdChanged` event and the retired H key are `weapons/`'.

## Phase 7 — rejoin restore · ghosts · remote poses (2026-09-06, `docs/DECISIONS.md` Phase 7)
- **`isMeleeHeavy`**: true while `startMelee('heavy')`'s sweep plays (`meleeTimer > 0 && meleeKind === 'heavy'`); net puts `MELEE_HEAVY` on the wire from it.
- **`restoreState({position, yaw, hp, downHp, state, shield?})`** (game/ calls it on `net:ghostRestore` after a rejoin's `world:ready`): resets like `respawnAt` (interior / ship box / pod / hellpod cleared, controller reset at `position` — clamped onto the terrain, off-map positions fall back to the slot spawn — camera snapped behind at `yaw`, 0.5 s invulnerability) but **no hellpod**. `state 0` → alive with `hp` (clamped 1..max), `player:healthChanged` + `player:spawned`. **2026-09-10 — 실드**: `shield` 를 `pendingShield` 에 적어 두고 `syncShield` 가 **방탄복을 실제로 읽은 첫 프레임**(`gear.shieldMax > 0`)에 한 번만 넣는다 — 복귀 프레임에는 `PlayerGear` 가 아직 인벤토리를 다시 읽기 전이라 최대치가 0 이고, 그때 바로 넣으면 값이 잘려 사라진다. **생략된 `shield` 는 0 이 아니라 최대치**다 (옛 세이브 · 실드를 모르는 옛 호스트에서 돌아온 사람만 조용히 실드를 잃지 않도록). `state 1` · `state 2` 는 실드 0. `state 1` → 전투불능: hp 0, `isDowned`, `downHp` (1..`PLAYER_DOWN_HP`), stance prone, prone camera; emits `player:spawned`, `player:downed`, `player:downHpChanged`, `player:healthChanged` — bleed / give-up / revive continue as usual. `state 2` → dead: `isDead`, hp 0, controls off, death pose already settled (`deadTimer = DEATH_ANIM`), body visible; **no `player:died`** (and no `player:spawned`) — game/ runs its own respawn / raid-failure flow from the restore.
- **`world:ready` while `ctx.rejoinPending`**: no `respawnAt` / hellpod. `holdForRestore(spawn)` = the `game:abort` reset (model hidden, `spawned` false, controls off, interior cleared) with the feet + camera parked at the slot spawn, so `restoreState` (or game/'s fallback `player.respawn(spawn)` after `NET_GHOST_RESTORE_TIMEOUT_S`) is the first thing that shows the body.
- **`setWeaponState({…, cooking?})`**: optional Phase 7 hint (pin pulled while `holdingItem`) → `cookBlend` → `SoldierPose.cooking`, so the local pose matches what remotes render from `COOKING`. Weapons may ignore it (the throw pose still wins while `throwing`).
- **Local gear look**: every frame after the gear cache, `model.setArmor(gear.armor)` shows the worn 방탄복 plates on the local soldier (same helper as remotes) and `model.setGlow(isOvercharged)` lights the rim while an overcharge buff is up.
- **Dive pose deleted**: `SoldierPose.dive`, the `diveBlend` fields and the `dvW` blends in `SoldierModel` are gone (Alt rolls; both producers only ever wrote 0). The `player:dived` event, the DIVE wire bit, `isDiving` and `RigInput.dive` (the roll's camera pull-back) stay as the roll's aliases.

### Ghosts (host-simulated bodies of suspended members — `RemotePlayerSystem`)
- **Creation**: `net:peerSuspended {suspended:true}` while `ctx.isAuthority` and `ctx.net.inSession` (debug refs need no session) → `Ghost {id, position, yaw, hp, downHp, state}` from the ref's last body: alive → `st 0` with its hp; downed → `st 1` with the member's **own bleed pool** (Phase 9: `ref.downHp` from `PlayerSnapshot.dhp`, clamped `1..PLAYER_DOWN_HP`; unknown → full pool); dead → `st 2`. When this host was just promoted, the remembered wire state wins (see below). The ghost is written back onto the host's own ref (`RemotePlayer.applyGhost(wire)` when net exposes it, else `position` / `hp` / `flags` DOWNED · DEAD directly) so enemies (`Targets.ts`), the revive prompt and the avatar read the live body; `net:ghostState` is emitted locally and `ghost state` broadcast to `'others'`.
- **Damage**: `ghost:damage {id, amount, from?, kb?}` (enemies emit it instead of `dmg` for a suspended victim): `st 0` hp −amount → 0 = `st 1` + `downHp = PLAYER_DOWN_HP`; `st 1` `downHp` −amount → 0 = `st 2`; `kb {direction, speed}` shoves the ghost `min(2 m, speed × 0.12)` horizontally (kept inside the map, snapped to the terrain). Downed ghosts bleed `GHOST_BLEED_PER_SEC` in whole points. Every change broadcasts `ghost state` immediately; otherwise it is refreshed at `NET_GHOST_STATE_HZ` (2 Hz).
- **Messages** (host): `ghostq sync` → `ghost sync` to the asker; `ghostq revive` → `st 1` → `st 0` with `PLAYER_REVIVE_HP` (`downHp` 0); `flow rejoined` from a member with a ghost → `ghost restore {g}` to that peer (→ its `PlayerRef.restoreState`) then the ghost is dropped + `ghost gone` to `'others'`, followed by a `ghost sync` of the remaining ghosts. `net:remotePlayerRemoved` drops the ghost with `gone`. `game:abort` / `game:newMission` / `hub:entered` clear everything silently. The ghost view on the host's own ref (`ghostState` / `ghostDownHp`, Phase 9) is written by `applyToRef` and cleared when the ghost is dropped (`RemotePlayer.clearGhost()` when net exposes it, else the debug ref's fields).
- **Parked ghosts** (Phase 9): `net:missionMembership {inMission:false}` (page reload = mission leave) or `net:peerSuspended {suspended:false}` while a ghost exists (socket back without `flow rejoined`) → the `GhostWire` moves to `parked: Map<id, {wire, until: ctx.time + NET_GHOST_PARK_S, debug}>` and the ghost is dropped with `ghost gone` (not simulated, not targetable, not counted by the wipe check, avatars back to snapshot mode). `flow rejoined` with no active ghost but a parked entry → `ghost restore` from the parked wire, entry forgotten. Expiry in `updateGhosts` (runs while `ghosts` or `parked` is non-empty); a fresh suspension supersedes a parked body; demotion / `clearAll` / `net:remotePlayerRemoved` clear them. `getParkedGhosts()`, `debugExpireParked(id)`, `debugRejoin` (active or parked), `debugSpawn({downHp})`.
- **Host migration**: every client records the last `ghost state` / `sync` / `restore` wire per id (`getLastGhostStates()`). `net:hostChanged {isLocalHost:true}` → for every `suspended` ref (real + debug) without a ghost, rebuild it from that wire (fallback: the ref's body) and broadcast `ghost state` for all. `{isLocalHost:false}` → drop the local ghosts and send `ghostq sync` to the new host so the refs follow its ghosts.
- **Revive**: the `revive:<id>` interactable stays on a suspended downed body; completing the hold sends `ghostq revive` to `'host'` (or applies it locally on the host) instead of `revive done`. `debugSuspend` / `debugRejoin` cover the whole loop offline (`scripts/smoke-ghost.mjs`).
- Not done here: the ghost has no physics beyond the knockback nudge (it stands where the member dropped); a parked body is lost on host migration (the new host only knows `ghost gone`) and after `NET_GHOST_PARK_S`.

### Give-up progress (Phase 9, `PlayerSystem.updateDowned`)
`player:giveUpProgress {t}` for the HUD bar: `t = giveUpHold / PLAYER_GIVE_UP_HOLD` (0..1) while Space is held, emitted only on change and at most `GIVE_UP_PROGRESS_HZ` (20 Hz); releasing the key, a revive / respawn / death (`clearDowned`) sends a single `t: -1`. Nothing is emitted while idle. Checked by `scripts/smoke-phase2.mjs` (short hold → release, full hold → `player:died`) and `scripts/smoke-raidflow.mjs`.

### Verification (2026-09-06, Phase 9)
`node scripts/smoke-ghost.mjs http://localhost:5302/` — **72/72**, 0 console errors: everything below plus Phase 9 — `ref.ghostState / ghostDownHp` mirror, downed ref with `downHp 37` → ghost `downHp 37` (clamped 999 → 100, 0 → 1, unknown → 100), parked ghosts (`net:missionMembership false` → parked wire hp 50 / window 120 s / no broadcasts / `ghost:damage` ignored → `debugRejoin` restores the wire → second rejoin null; `net:peerSuspended false` with a ghost → parked `st 1` → `debugExpireParked` → nothing to restore; demotion and `game:abort` clear parked bodies). `smoke-phase2.mjs` **46/46**, `smoke-raidflow.mjs` **43/43** (give-up progress).

### Verification (2026-09-06, Phase 7)
`node scripts/smoke-ghost.mjs http://localhost:5303/` (private vite, HMR socket parked) — **57/57**, 0 console errors: `isMeleeHeavy` on / off around `SLASH_DURATION`, light swing false, no `dive` pose key; `restoreState` 0 (position / yaw / hp 55 / no hellpod / one `player:spawned`), 1 (downHp 40, prone, `player:downed`, bleeds), 2 (`isDead`, no `player:died`); knockback ignored downed / dead, flat knockback lifts off (`grounded` false, vy 1.5) without `player:launched`, cancels a roll; `game:newMission` with `rejoinPending` → world 22 ready, player parked hidden, then `restoreState` shows it; debug remote THROWING / held grenade mesh + `net:remoteHeldItem`, COOKING + stim mesh, CHARGING / SPRAYING / HEAVY blends, MELEE_HEAVY sweep start / end, `ar armor_2` plate + OVERCHARGED glow + clear, local plate; ghosts: creation (`st 0`, `net:ghostState`), grey visible stale avatar without silhouette, `ghost:damage` → downed + kb nudge + ref mirror + revive prompt + prone avatar, bleed, 2 Hz broadcasts, revive interactable → hp 10, damage → dead + death pose, `debugRejoin` restore wire; downed ref → `st 1`, demotion clears, promotion rebuilds with `downHp` kept, `debugClear`.

## Phase 6 — dev console / unique weapon hooks (2026-09-06, appended `PlayerRef` / `PlayerWeaponHost` members)
- **`teleport(position, yaw?, snap?)`** (console `/move`, Home move cheat): feet to `position` with no hellpod and no `player:spawned`;
  unless `snap === false` the y is replaced by the ground under the target — `interior.getFloorAt` in the hub, else `world.getHeightAt`
  (so `/move x,400,z` lands on the terrain; pass `snap: false` to keep an airborne y). `controller.reset` clears velocity / roll /
  grapple / hover, the stance is preserved (downed stays prone), the model root is written immediately and the camera rig `snapTo`s
  behind the new pivot the same frame. Optional `yaw` turns the camera and the body. Ignored while dead, in a pod or mid hellpod drop;
  hp / stamina / items / `interior` untouched. Works in the hub and on a mission.
- **`setViewWiden(active)`**: `CameraRig.viewWiden` → `fovMul` damped toward `SLASH_FOV_MUL` (1.28, rate 14 in / 7 out) and multiplied
  into whatever the sprint / ADS logic wants (`fov = damp(fov, min(150, targetFov × fovMul))`), so it composes with sprint and ADS.
  Cleared by `resetTactical` (respawn / spawnStanding / abort). ADS sensitivity scaling follows the widened FOV too.
- **`consumeStamina(amount)`**: false (nothing spent) when short, while `exhausted` (stamina hit 0 and not yet back to
  `STAMINA_SPRINT_RECOVER`, same rule as sprint / roll) or while dead / downed / not spawned; otherwise `spendStamina` (regen delay,
  `player:staminaDepleted` at 0) and true. `amount ≤ 0` is a free success.
- **`startMelee(kind = 'light')`**: `'heavy'` = the 용검 big slash — `meleeTimer = SLASH_DURATION` (0.6 s, `isMeleeing` true meanwhile),
  no `MELEE_STAMINA_COST` (weapons already paid `maxStamina × SLASH_STAMINA_RATIO` through `consumeStamina`), cooldown
  `max(MELEE_COOLDOWN, duration + 0.1)`; same preconditions as the light swing (`canAct`, not rolling, no swing / cooldown running).
  Pose: `SoldierPose.melee` is the progress (`1 − meleeTimer / meleeDuration`) and `meleeHeavy` = 1 selects the two-handed sweep in
  `SoldierModel`: both arms straight at chest height on the hilt, shoulders wound far right (torso twist +0.75) over 0..0.32, then a
  smoothstep sweep across to the left (−0.95) over 0.32..0.7 with the elbows nearly locked, legs planted wide and low, pelvis dropped
  0.09 m. Weapons resolves the hits (`SLASH_RANGE` / `SLASH_ARC_DEG` / `SLASH_DAMAGE`) and emits `player:slashed`.
- **`setWeaponState({…, charging, spraying, heavy})`**: three optional pose hints (all only while `hasWeapon`, upright, not
  reloading; damped blends `chargeBlend` 10 / `sprayBlend` 12 / `heavyBlend` 8 → `SoldierPose.charging / spraying / heavyCarry`):
  `charging` = braced stance (shockgun RMB / minigun spin-up — hips 7 cm lower, knees bent, lean 0.14 into the gun, both elbows
  tucked with the stock pulled into the shoulder), `spraying` = continuous hip fire (gun low at the hip, left hand on the fore-grip,
  31 / 47 Hz tremble on both arms, slight lean back), `heavy` = bazooka / minigun hip carry (right hand on the rear grip by the hip,
  left arm forward under the barrel, lean back 0.09, knees soft). None of them reaches the wire — remotes render FIRING / TWO_HANDED
  as before — and `resetTactical` clears them.
- `player:blastJump` is emitted by weapons (bazooka super jump via `applyImpulse`), not here.
- Verified by the Phase 6 block of `scripts/smoke-phase4.mjs` (teleport onto the terrain + camera follow, `consumeStamina` refusal /
  spend, heavy melee `isMeleeing` window, `setViewWiden` FOV rise / fall) and by the weapons agent's `smoke-uniques`.

## Phase 12 (2026-09-08) — 조준 원점 (정밀 사격 쏠림) · `auto_revive` · `kill_stamina`

- **`CameraRig.predictPosition(out)`** and one line in `PlayerSystem.update`: `aimOrigin` is now where the rig **will**
  put the camera this frame for the look just applied, instead of where it was last frame. Weapons fire in `update`,
  the rig moves in `lateUpdate` — so a shot used to leave from the previous frame's camera with this frame's look
  direction, i.e. a ray parallel to (and beside) the one the frame then rendered. Measured lateral error while
  turning: 0.09 m at a 15 px/frame flick, 0.22 m at 30 px, **0.42 m at 60 px**, plus ~0.036 m during the ADS pull-in
  (the shoulder slides 0.55 → 0.35). Because the ray is *shifted*, not rotated, the miss is the same in metres at
  every range — which is why it reads as a small, constant drift on scoped weapons. Standing still there was no error
  (measured 0.000 m at 30 m and 150 m before and after), and the reticle was already exactly on the projected centre
  ray. `predictPosition` reuses the last smoothed pivot / shoulder / collision distance (they damp slowly) and
  re-evaluates only the look basis; during a cutscene override it returns the real camera position, because the
  override — not the rig — owns it. `lateUpdate` still overwrites `aimOrigin` with the actual position afterwards.
- **Perk `auto_revive`** (재기동 회로, `derived.perks.auto_revive`): `enterDowned` arms a one-shot timer
  (`AUTO_REVIVE_DELAY_S` = 1 s) that fires from `updateDowned` — `revive()` (hp `PLAYER_REVIVE_HP`, the usual
  `player:revived` / `player:healthChanged` / SFX) plus `ui:notify` `재기동 회로 작동`. **Once per raid**:
  `autoReviveUsed` is set on use and cleared on `world:ready`. The timer is disarmed by `clearDowned` / a manual
  `revive()`, so a teammate's revive does not spend it. Nothing about the bleed / 포기 path changed — the perk simply
  wins the race for the first second.
- **Perk `kill_stamina`** (아드레날린 펌프): an `enemy:killed` whose `by` is `'local'` (the host credits our own hits
  that way, and a replica's `hitc` kill marker does too — enemies/ folds our PeerId back to `'local'`) refills
  `stamina` to `maxStamina` and clears the regen delay / exhausted state. Ignored while dead / not spawned.

**Verification**: `smoke-weapons` 137/137 (SR ADS lands on the crosshair ray at ~30 m and ~140 m, auto_revive stands
up once within 1.5 s and stays down on the second knock-down, kill_stamina refills only for a `'local'` kill and only
with the perk on), `smoke-phase2` 53/53, `smoke-uniques` 71/71, `smoke-ghost` 86/86.

**Known**: `predictPosition` predicts the *positional* damping the rig is about to do but not a collision that only
this frame's ray-casts would find, so a camera that is being pushed out of a wall in the same frame can still leave a
few cm of error (it damps away in one or two frames, and the world raycast from the camera clamps the shot anyway).
`auto_revive` fires in a 훈련장 too (harmless — the respawn there is instant) and, being client-side, is invisible to
the host's ghost logic: a suspended player's ghost never self-revives. `kill_stamina` reads the bus event, so a kill
credited to a peer that our client never sees (e.g. a DoT death out of range) is simply missed.


## 차량 탑승 (2026-09-10 — 전차 데크에서 내려지지 않는다)

`PlayerController` 안에만 있다 (`carrier` · `rideLocal` · `rideWorld` · `rideInertia`). 새 계약은 없고
`Obstacle.velocity` · `Obstacle.box`(2026-09-09 계약)를 읽을 뿐이며, 수치는 `data/constants.csv` 의
`RIDE_HEADROOM` · `RIDE_FOOT_DROP` · `RIDE_EDGE_MARGIN` · `RIDE_INERTIA_S` · `RIDE_INERTIA_DAMP` 다.

### 왜 상태인가
2026-09-09 판은 매 프레임 `world.getStandingObstacle(x, z, feetY)?.velocity` 를 찾아 그 속도를 위치에
더했다. **발판 질의에서 한 프레임만 빠지면** 그 프레임만큼 차량이 발밑에서 빠져나가고, 그 일은 점프 ·
경사 · 승강구 · 데크 가장자리에서 늘 생긴다 — "조금만 움직여도 전철에서 내려진다" 가 그것이다.
이제 탑승은 **명시적인 상태**다:

| | 조건 |
|---|---|
| **진입** | 접지 상태에서 `getStandingObstacle` 이 `velocity` 를 가진 장애물을 돌려줄 때. **여기서만** 발판 질의를 쓴다 |
| **유지** | 그 차량의 **OBB(+`RIDE_EDGE_MARGIN`) 안**이고 높이가 `[윗면 − RIDE_FOOT_DROP, 윗면 + RIDE_HEADROOM]` 일 때. 발판을 밟았는지는 **보지 않는다** |
| **이탈** | 위 범위를 벗어나는 순간. 그때의 차량 속도를 관성으로 넘겨받는다 |

### 이동은 차량 좌표에서 푼다
지난 프레임의 자리를 차량 로컬 좌표(`rideLocal`, y 는 발판 윗면 기준)로 적어 두고, 이번 프레임에
**차량의 현재 변환으로 다시 푼다**. 직선 속도만이 아니라 **곡선 구간의 회전**까지 정확히 따라가고
프레임 누락이 없다. **스냅샷은 찍지 않는다** — `CLAUDE.md` 의 "함선처럼 움직이는 실내는 박스를 매
프레임 다시 쓴다" 와 같은 이유이고, `Obstacle` 참조는 `SpatialHash` 안의 살아 있는 객체다.
자리를 통째로 덮어쓰지 않고 **차이만 더한다**(`rideWorld`) — 그 사이 남이 몸을 옮겼다면(순간이동 ·
임펄스) 그것을 지우지 않기 위해서다.

### `vel` 은 손대지 않는다 (2026-09-09 규약의 **이유**를 지킨다)
옮기는 것은 **위치뿐**이고 `vel` 은 끝까지 **차량 기준 로컬 속도**다. 그래서 이동 속도 · 스태미나
(`sprinting`) · 보행 애니메이션(`speed` · `stridePhase`)이 전차 속도로 흔들리지 않는다. 점프는 헤드룸
안이라 차량과 **함께 날아가** 같은 자리에 내린다 — 차량 속도를 `vel` 에 실은 것과 결과가 같으면서
스태미나 · 보행이 멀쩡하다.

### 하차 관성
이탈하는 순간의 차량 속도를 `rideInertia` 로 받아 `RIDE_INERTIA_S` 동안 `RIDE_INERTIA_DAMP` 지수
감쇠로 위치에 더한다(여기도 `vel` 이 아니다). 달리는 전차에서 승강구로 뛰어내리면 앞으로 날아간다.

### 실내 모드에는 없다
`interior`(함선 `InteriorCollider`) · `shipBounds`(탈출 함선 박스) 모드에서는 발판이 없으므로 곧바로
하차 처리하고 관성만 흘린다. `reset()` 은 탑승 상태를 지운다.

### 검증 (2026-09-10)
`scripts/smoke-structures.mjs` 가 world/ 쪽(차체 방향 · 콘솔 위치 · 발판 velocity · 계단 단높이)을 본다.
탑승 자체는 일회성 프로브로 확인했다 — 전차 객실에 세우고 시동을 건 뒤 6초: 차 안 로컬 좌표 `(-3, 0)`
유지, 로컬 속도 0.0 m/s, 스태미나 100 그대로, 점프 후에도 같은 자리에 착지, 승강구로 밀어내면 하차.

## 사다리 · 단차 보간 · 월드 천장 (2026-09-11)

계약(`src/shared`, world 담당이 추가): `LadderDef {id, base, topY, normal, exit}` · `WorldRef.getLadders()` ·
`PlayerRef.climbingLadder?` · 이벤트 `ladder:grab {ladder, from}`(명령) / `player:climbChanged {ladderId}`(사실) ·
`PlayerFlags.CLIMBING`. 수치는 `data/constants.csv` 의 `LADDER_*` · `STEP_SMOOTH_*`. world 가 구조물(연구실 ·
전진기지 2층 → 옥상)에 사다리를 세우고 `ladder:<id>:bottom|top` 프롬프트가 E 로 `ladder:grab` 을 낸다.

### 상태 기계 (`PlayerController.climbLadder` 하나)

| 상태 | 들어가는 길 | 하는 일 | 나가는 길 |
|---|---|---|---|
| **걷기** | — | 평소 `update` | `ladder:grab` (죽음 · 전투불능 · 들쳐메기 양쪽 · 포드 · 강하 · 조작 끔 · 함선 실내 · 탈출선 박스 · 부모에 붙음 · 이미 매달림이면 무시) |
| **매달림** | 발치에서 잡기: 발 = `clamp(현재 발, base.y, topY − 0.5)` · 꼭대기에서 잡기: 발 = `max(base.y, topY − 1.1)`, XZ = `base` | `updateClimb`: XZ 고정, `z × 속도 × speedMultiplier` 로 수직 이동만. **중력 · `resolveCollision` · 지면 스냅 · 천장 프로브 없음**(몸이 옥상 슬래브 구멍을 지나간다). 가로대 `LADDER_RUNG_M`(0.35 m)마다 위상 π + `ladder_step` | 발치에서 S → **걷기**(접지) · 발이 `topY − 0.2` 에 닿은 채 W → **올라서기** · E → **낙하**(`normal × LADDER_DROP_PUSH`) · Space → **낙하**(`vel.y = LADDER_JUMP_SPEED × jumpSpeedMul`, 수평 `−normal × LADDER_JUMP_PUSH`, 스태미나 `STAMINA_JUMP_COST`) |
| **올라서기** | 위 | `LADDER_MOUNT_S` 동안 `exit` 로 보간 — 높이는 ease-out(먼저 올라가고), XZ 는 ease-in(나중에 넘어간다) 이라 슬래브 모서리를 긁지 않는다. 입력 무시 | 끝나면 `exit` 에 **접지**로 **걷기** |
| **낙하** | E · 점프 · 사망 · 전투불능 · 리셋 | 평소 `update` (착지 소리 · 먼지는 평소 규칙) | 착지 |

`grounded` 는 매달린 동안 false 다 — 그래서 스냅샷에는 `AIRBORNE` 가 실리고 원격은 `CLIMBING` 이면 그것을 가린다.
로컬 자세의 `airborne` 도 사다리에서는 0 이다. 매달린 동안 `updateInteraction` 은 꺼져 있다 (E 는 사다리 것) —
잡는 E 는 `perform` 의 `interactCooldown`(0.35 s) 뒤에 있어 같은 누름이 곧바로 놓기가 되지 않는다.

**놓기는 한 곳에서 알린다**: `player:climbChanged` 는 `Climb.syncClimb` 만 내고, 컨트롤러 상태와 마지막으로 보낸 값이
다를 때만 보낸다. 그래서 컨트롤러 안의 해제(꼭대기 · 발치 · E · 점프), `Vitals.enterDowned` / `die`,
`parts/Spawn` 의 `respawnAt` · `spawnStanding` · `restoreState` · `teleport` · `resetAll`(`clearClimbState`),
`setInPod(true)` · `attachTo(parent)` · `setInterior(collider)` · `setShipInterior(bounds)` · `hub:entered`,
그리고 `update` 맨 위의 백스톱(몸이 더 이상 자유롭지 않으면 놓는다)이 겹쳐도 **null 은 한 번**이다.

**무기 · 행동**: `canUseWeapons()` 가 매달린 동안 false (무기 · 수류탄 · 퀵 휠 · 함선 호출이 전부 이걸 본다),
`canAct()` 도 false (구르기 · 근접 · 들쳐메기). 총 모델은 weapons/ 것이라 여기서 지우지 않고
`SoldierModel` 이 `climb > CLIMB_HIDE_WEAPON` 동안 **`weaponSocket` 째 숨긴다** (원격 아바타의 소켓도 그 밑이다).
스태미나: `Locomotion.updateStamina` 가 `controller.climbFast` 동안 `LADDER_SPRINT_DRAIN` 을 달리기 자리에서 쓰고
회복을 막는다. 몸 방향은 `atan2(normal.x, normal.z)`(= `-normal` 을 본다), 카메라는 자유다.

**자세** `SoldierPose.climb`: 몸통은 곧게 사다리를 보고(카메라 비틀기 무시, 머리만 카메라 쪽으로 조금), 손은 머리 위에서
번갈아 가로대를 잡고(높은 손은 거의 곧게, 낮은 손은 머리 높이에서 팔꿈치를 굽혀 — 위팔 + 아래팔 ≈ 2.8 rad 라
손이 얼굴 앞에 있다), 무릎은 반대쪽이 번갈아 올라온다. 위상 `0.5 − 0.5·cos(stridePhase)` 의 끝이 가로대 경계(π 배수)라
손이 가로대를 잡는 순간에 소리가 난다.

**원격** (`RemoteAvatar`): 와이어에는 비트뿐이다. 위상은 보간된 `ref.position.y` 의 변화량 누적(한 프레임 1 m 넘는 변화는
순간이동으로 버린다)이고, 가로대마다 조용한 위치 `ladder_step`(0.35)을 낸다. 방향은 `ctx.world.getLadders()` 에서
발치 XZ 가 1.2 m 안인 사다리를 한 번 찾아 그 `normal` 을 본다 (못 찾으면 방향 유지). `AIRBORNE` · 달리기 블렌드는 가린다.
`net/RemotePlayer.applyGhost` 는 고스트에서 `CLIMBING` 을 지운다.

### 단차 보간 (`bodyOffset`)
물리 위치는 지금처럼 **즉시** 옮겨 간다 (충돌 · 스냅샷 · 적 인지가 그 값을 쓴다). 모델 루트와 카메라 피벗만
`controller.position + bodyOffset` 이다. `update` 가 `c.update` 직전의 자리 · 접지를 들고 있다가, **접지 → 접지**이고
탑승 · 사다리 · 부모 붙음 · 업힘이 아닐 때 한 프레임 높이 변화 `|Δy|` 가 `STEP_SMOOTH_MIN`(0.04) 초과 ·
`STEP_SMOOTH_MAX` 이하이면서 **수평 이동의 `STEP_SLOPE_RATIO`(1.5)배를 넘으면** 단차로 보고 `bodyOffset.y −= Δy`.
경사면(최대 50° ≈ 1.19배)은 연속이라 보간하지 않는다 — 보간하면 경사를 걷는 내내 모델이 발밑에서 뜨거나 가라앉는다.
오프셋 전체는 매 프레임 `exp(−STEP_SMOOTH_RATE·dt)` 로 줄고, 사다리를 잡는 순간의 XZ 스냅(최대 `CLIMB_GRAB_OFFSET_MAX`
2 m)도 같은 오프셋으로 미끄러진다. 피벗에도 더하므로 단차에서 병사가 화면 안에서 미끄러지지 않는다 (피벗의 기존 수직
감쇠 7 은 그 위에 그대로 걸린다). 리셋 경로(`clearClimbState`)가 0 으로 지운다. 계단은 world 가 경사 콜라이더를
주므로 여기 걸리지 않는다 — 이것은 낮은 바위 · 상자 모서리 · `SNAP_DOWN` 같은 **나머지** 단차용이다.

### 월드 천장 (`PlayerController.clampWorldCeiling`)
구조물에 3.6 m 천장과 떠 있는 슬래브 상자가 생겼다. 실내(`interior`) 모드에만 있던 천장 프로브를 월드 모드에도 걸었다 —
**`vel.y > 0` 인 프레임에만**, **`resolveCollision` 보다 먼저**, **적분 전 발 높이**의 엉덩이(+`CEIL_PROBE_START`)에서
위로 `world.raycast` 한 번. 발 + **`WORLD_CEIL_HEADROOM`(2.1)** 이 맞은 면을 넘으면 발을 그 아래로 내리고 `vel.y = 0`.
여유가 머리 높이(`PLAYER_HEIGHT` 1.8)가 아니라 2.1 인 이유: `WorldRef.resolveCollision` 의 상자 가지가 **발 + `BOX_HEADROOM`
(2.1)** 이 밑면을 넘는 순간 옆으로 밀어낸다 — 머리만 막으면 1.8~2.1 m 사이에서 여전히 밀려난다(첫 스모크에서 3.3 m 밀림으로
실측). 그래서 이 값은 **`world/obb.ts` 의 `BOX_HEADROOM` 과 같아야** 하고, 아직 `@/shared` 에 없어 로컬에 복사해 뒀다.
순서가 거꾸로면(밀어내기 먼저) 머리가 슬래브에 박힌 채 몸이 옆으로 뱉어진다.

### 검증 (2026-09-11)
`node scripts/smoke-ladder.mjs` — 가짜 `LadderDef` 로 world 없이 돈다 (`scripts/README.md` 행 참고). **38/38**, 콘솔 에러 0:
W 2.40 m/s · Shift+W 4.60 m/s(0.3초에 스태미나 6.6) · 꼭대기 올라서기가 `exit` 에 Δ 0.000 으로 접지 · 꼭대기 잡기 발 `topY − 1.1` ·
E 놓기 vz 0.80 · 점프 vy 7.20 / vz −2.20 / 스태미나 12 · 단차 0.3 m 에서 모델 오프셋 0.24 → 0 · 가짜 월드 2.5 m 판 밑 점프 발 0.40
(자유 1.14), 밀어내기 0회 · 매달린 채 사망 → null 한 번. 첫 실행에서 천장 클램프가 `PLAYER_HEIGHT` 로 재고 있어 2.5 m 판 밑에서
몸이 3.3 m 밀려났다 → `WORLD_CEIL_HEADROOM`(= `BOX_HEADROOM`) 으로 고쳤다. 회귀: `smoke-phase2` 57/57, `smoke-ghost` 86/86.

---

## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`PlayerSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체). 상태도 클래스 참조도 없다.
   `PlayerSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function applyDamage(sys: PlayerSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 `ctx.*` 를 통한 호출부와
   폴더 안의 `this.foo()` 호출은 **하나도 바뀌지 않았다.**
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   접근 범위는 여전히 이 폴더이고, 외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

`parts/` 에 새 파일을 만들 때는 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고
위 표에 행을 추가한다. 순환 import 를 만들지 않으려면 `parts/` 는 `PlayerSystem.ts` 에서 **타입만**
가져와야 한다(`import type { PlayerSystem }`) — 값이 필요하면 `model.ts` 로 옮긴다.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-11 (사다리 · 단차 보간 · 월드 천장)** — 위 *사다리 · 단차 보간 · 월드 천장* 절. ① **사다리**:
  `PlayerController` 에 `climbLadder` 상태(`startClimb` / `updateClimb` / `releaseClimb`, `MoveResult.rung` ·
  `climbEnded`, `LADDER_RUNG_M` export), 새 `parts/Climb.ts`(잡기 규칙 · 입력 · `player:climbChanged` 한 곳 · 리셋),
  `PlayerSystem.climbingLadder` / `grabLadder` / `releaseLadder` / `clearClimbState`, 매달린 동안 상호작용 · 무기
  (`canUseWeapons`) · 구르기 · 근접 · 들쳐메기(`canAct`) 잠금, 스태미나 `LADDER_SPRINT_DRAIN`(`Locomotion`), 리셋 경로
  (`Spawn` · `Vitals`)에서 놓기. `SoldierPose.climb`(손 번갈아 · 무릎 번갈아 · 몸통 정면, `weaponSocket` 숨김) 과
  `RemoteAvatar` 의 `CLIMBING` 재생(높이 변화 → 위상, 가까운 사다리 → 방향, 원격 가로대 소리). 오디오는 `ladder_step`.
  ② **단차 보간**: `bodyOffset` — 모델 · 카메라 피벗만 단차를 `STEP_SMOOTH_RATE` 로 따라간다 (경사면은 제외).
  ③ **월드 천장**: 올라가는 프레임에만 `resolveCollision` 전에 위로 한 번 광선. 계약(`src/shared`) · 수치(`data/`)는
  world 담당이 먼저 추가했고 이 폴더는 읽기만 한다.

- **2026-09-10 (멀티 렉: 원격 포드 광원 · 아바타 재사용)** — 공유 함선 합류 · 분대 강하 때의 정지를 실측한 결과 중
  `player/` 몫 두 가지.
  ① **`RemotePods` 가 광원 개수를 바꿨다.** `pod drop` 을 받은 순간 `new Hellpod()` 을 씬에 넣어 추진기
  `PointLight` 가 하나 늘었고, 그 프레임에 씬의 모든 머티리얼이 셰이더를 다시 컴파일했다 — 분대원마다 한 번,
  실측 2.7 · 3.1초. `clear()` 가 매 미션 포드를 dispose 했으므로 다음 미션에서 똑같이 반복됐다. 이제 포드 3개가
  `init` 때 씬에 들어가 광원 세기 0 으로 대기하고 `clear()` 는 숨기기만 한다. **씬에 광원 3개가 늘 상주한다**
  (허브 · 레이드 · 싱글 모두 같은 수라 개수 변화는 없다 — 광원 개수를 맞추는 작업은 이 3개를 셈에 넣어야 한다).
  ② **원격 아바타를 매번 새로 지었다.** `hub:entered` · `game:newMission` · `game:abort` 가 아바타를 전부 끝내고
  다음 스냅샷이 다시 만드는 규칙은 그대로 두고, 끝난 몸을 **`SoldierPool` 에 주차**해 같은 슬롯 색의 다음 아바타가
  꺼내 쓰게 했다(`SoldierModel.resetForReuse`). 아바타마다 **새 무기 소켓 객체**를 몸의 손 소켓 안에 달아
  `weapons/RemoteWeapons` 의 소켓 동일성 판정이 재사용된 몸에서도 맞게 했다. 그리고 `SoldierModel` 의
  **지오메트리 43개와 실루엣 머티리얼을 모듈 캐시에서 공유**한다(인스턴스 `dispose` 는 건드리지 않는다) —
  몸 머티리얼은 페이드 · 회색 · 발광 · 바이저 맥동이 인스턴스마다 바꾸므로 그대로 인스턴스별이다.
  `syncSocketRenderOrder` 의 프레임당 배열 할당도 없앴다. 겉모습 · 그림자 설정 · 계약(`src/shared`)은 바뀌지 않았다.

- **2026-09-10 (차량 탑승)** — 위 *차량 탑승* 절. `PlayerController` 가 "밟고 있는 발판의 속도를 위치에
  더한다"(2026-09-09) 에서 **탑승 상태 기계**로 바뀌었다: 진입은 여전히 `getStandingObstacle().velocity`
  지만, **유지는 차량 OBB + 헤드룸**이고 이동은 **차량 로컬 좌표를 매 프레임 차량의 현재 변환으로 다시
  푸는** 방식이라 프레임이 누락되지 않고 곡선의 회전까지 따라간다. 하차하면 그때의 차량 속도가
  `RIDE_INERTIA_S` 동안 마찰로 감쇠하는 **관성**으로 남는다. `vel` 은 여전히 **로컬 속도**라 이동 속도 ·
  스태미나 · 보행 애니메이션이 전차 속도로 흔들리지 않는다(2026-09-09 규약의 이유 그대로).
  수치는 `data/constants.csv` 의 `RIDE_*` 5개.

- **2026-09-10 (방탄복 = 실드)** — 위 *실드* 절. `PlayerGear` 가 `shieldMax` / `shieldRarity` / `shieldTier` 를
  내주고 `damageReduction` 은 **늘 0** 을 돌려준다; `PlayerSystem` 이 실드 풀(`_shield`) · `chargeShield` ·
  `absorbShield` · `syncShield` · `clearShield` · `emitShield` 를 갖고, `parts/Vitals.applyDamage` 의
  `raw * (1 - damageReduction)` 이 `absorbShield` 로 바뀌었다. `maxHp` 는 상수에서 **getter**(`PLAYER_MAX_HP +
  bonusMaxHp`)가 됐다 — 지금 값은 그대로 100. `parts/Spawn` 은 **한 줄도 안 고쳤다**: 스폰 · 부활 · 리셋은
  `syncShield()` 가 매 프레임 알아서 잡는다.

- **2026-09-10 (원격 발소리)** — 원격 분대원의 아바타가 걸어도 **소리가 없었다.** `RemotePlayerSystem.emitFootstep`
  이 매 프레임 `ref.stridePhase` 의 π 경계를 보고 `remote:footstep {position, sprinting, peerId}` 를 낸다
  (`shared/events.ts` 의 계약 그대로). 게이트는 **로컬과 같은 기준**이다 — 접지 + 수평 속도
  `STRIDE_MIN_SPEED`(`PlayerController` 가 export, 예전의 하드코딩 0.3) 초과 + 구르는 중이 아님 — 여기에
  `av.isShown` 을 더해 **강하 중 · 포드 안 · 다른 함선(`hubSite`) · 시체로 대체된 몸 · 죽은 몸 · 스냅샷이 끊긴
  몸(`stale` · `suspended`)** 은 조용하다. peer 별 `StepState {idx, t}` 하나로 걸음 인덱스와 마지막 시각을
  들고 있어(`FOOTSTEP_MIN_INTERVAL_S` 쓰로틀) 스냅샷이 튀어도 연발되지 않고, `ref.position` 을 그대로 넘기므로
  **프레임당 할당이 없다**. `remove` · `clearAll` 이 맵을 비운다. **거리는 여기서 재지 않는다** — "멀 수록 작게"
  는 `audio/` 의 `FOOTSTEP_AUDIBLE_RANGE` 곡선이 건다 (`src/audio/README.md`).

- **2026-09-09 (강하 포드 · 구조선 부활)** — 새 `RemotePods.ts` 가 `pod drop` 으로 **아군의 헬포드를 보이게**
  한다(지금까지 원격 분대원은 자리에 그냥 나타났다), `startDrop(kind)` 이 그 메시지를 보내고,
  `rescueRevive()` 가 `rescue:landed` 로 빈손 · `RESCUE_REVIVE_HP` 부활을 처리하며, 시체가 선 분대원의
  아바타는 그리지 않는다(`RemoteAvatar` 의 `replacedByCorpse`).

- **2026-09-09 (예외를 삼키는 E)** — `parts/Interact.perform` 의 `try { target.interact() } catch` 가 콘솔
  한 줄만 남겨서, 상호작용이 예외로 죽으면 화면에는 **프롬프트가 그대로 뜬 채 아무 일도 안 일어나는** 것으로만
  보였다 (발사 슬롯이 안 타진다는 보고의 후보 경로였다). catch 는 유지하고 — 잘못된 `Interactable` 하나가 프레임
  전체를 죽이면 안 된다 — `ui:notify` 로 `상호작용에 실패했습니다` 를 띄운다.

- **2026-09-08 (혼자면 바로 사망)** — `parts/Vitals.onLethal` 이 **1인 분대**(로비 없음, 또는 로비 인원 ≤ 1)
  에서는 `enterDowned()` 대신 `die()` 로 간다. 전투불능은 분대원이 일으켜 세울 시간을 주는 상태인데 혼자면 올 사람이
  없어서, 같은 사망 화면까지 기어다니는 시간만 남았다. 예외는 퍽 **재기동 회로**(`auto_revive`) — 아직 안 썼다면
  전투불능 상태에서만 발동하므로 그때는 종전대로 쓰러진다.

- **2026-09-08 (훈련장 강하 없음)** — `world:ready` 와 `player:respawn` 이 `ctx.missionMode === 'training'` 이면
  `startDrop()` 을 부르지 않는다. 시뮬레이션 방에는 떨어질 하늘이 없다 — 시작 지점에 선 채로 시작한다
  (페이즈는 `game/` 이 곧장 `'playing'` 으로 넘긴다).

- **tactical kit** — **Alt = 구르기** (`roll()`, replaces the dive; the DIVE wire flag now means rolling), **melee swing** (`startMelee`/`isMeleeing`, weapons resolves the hit), **cloak** (`setCloak`/`isCloaked`/`getStealthFactor`, optical armor = permanent), **speed-modifier stack** (`setSpeedModifier`), `applyImpulse`, grapple pull (`setGrappleTarget`), tactical-bag hover (`setHovering`, auto-catch before a fatal fall), `isOvercharged`, **armor** damage reduction + wear (`PlayerGear.ts` caches armor / bag / weight from the inventory), 인내 grit save (`derived.gritChance`), burning DoT (`setBurning`), `maxStamina` / regen from `ctx.progression.derived` and the weight state

- **Phase 6** — `teleport(pos, yaw?, snap?)` (deck/terrain snap, no hellpod), `setViewWiden` (FOV × `SLASH_FOV_MUL`, `CameraRig.fovMul`), `consumeStamina`, `startMelee('heavy')` 용검 sweep pose, `setWeaponState({charging, spraying, heavy, altFire})` poses (`altFire` suppresses ADS entirely — unique RMB)

- **Phase 7** — `restoreState` (rejoin without a hellpod, states alive / downed / dead; `world:ready` holds while `ctx.rejoinPending`), **host ghosts** in `RemotePlayerSystem` (a suspended member's body: `ghost:damage` → downed → bleed → dead, `ghost state / sync / restore / gone`, `ghostq revive`, rebuilt on promotion), `GearLook.ts` armor plates + held-item meshes shared by the local body and `RemoteAvatar` (grey suspended avatars, THROWING / COOKING / CHARGING / SPRAYING / HEAVY / MELEE_HEAVY / OVERCHARGED poses, `h` held item, `ar` armor), `applyKnockback` ignores downed / dead and goes through `applyImpulse`, `isMeleeHeavy`, dead dive pose removed

- **Phase 9** — a ghost inherits the member's real bleed pool (`RemotePlayerRef.downHp` from the snapshot's `dhp`) instead of a full one, **parked ghosts** (a member that leaves the mission without rejoining — page reload → `lobby:mission false` — keeps a non-simulated body for `NET_GHOST_PARK_S` that a rejoin inside the window still restores), `player:giveUpProgress` for the HUD 포기 bar

- **Phase 10** — the Splatoon-style 3-heads-tall `SoldierModel` rewrite was **rolled back on 2026-09-07** — `SoldierModel.ts` / `GearLook.ts` are the pre-Phase-10 armoured trooper again (helmet · visor · shoulder pads · backpack · canisters · chest plates · 4-segment cape, hips 0.98 m, long arms), with only the Phase 10 additions ported onto it: `shoulderSocket` + `SoldierPose.carry`, **부상자 들쳐메기** (`Carry.ts` seam, F tap within `PLAYER_CARRY_RANGE` pre-empts melee with `input.consume(Keys.MELEE)`, walk / sprint only at `PLAYER_CARRY_SPEED_MUL`, every other action drops first, the carried side rides the carrier socket through the `attachTo` path, `RemotePlayerSystem.syncRevive` re-aims the revive interactable at the socket every frame so a shouldered squadmate stays revivable), **`applyHeal(amount, seconds, quiet?)`** (2026-09-07: `applyStim` 은 이제 `applyHeal(n, 1.5)`, `quiet` 는 스프레이용 — SFX 와 "이미 회복 중" 거부를 건너뛴다), and `Portraits.ts` (`createPortraits` — its own `THREE.WebGLRenderer` + scene + lights drawn through scissored viewports, because `core/Engine` renders through the composer and offers no post-render hook)

- **Phase 12 (2026-09-08)** — `CameraRig.predictPosition()` 로 `aimOrigin` 이 **이번 프레임에 렌더될 카메라 위치**가 되어(예전에는 직전 프레임 위치 + 이번 프레임 시선 = 회전 중 최대 0.42 m 평행 이동한 사격선) 정밀 사격 쏠림이 사라졌다, 퍽 `auto_revive`(전투불능 1초 뒤 자동 기상, 레이드당 1회) · `kill_stamina`(로컬 처치 → 스태미나 전량)

- **2026-09-08 (공용 함선 격납고)** — `RemoteAvatar.update` 의 `visible` 에 조건이 하나 늘었다: 상대의
  `RemotePlayerRef.hubSite` 가 우리 `ctx.hub.hubSite` 와 다르면 그리지 않는다. 함선 인테리어는 모두 월드 원점에
  지어지므로 서로 다른 함선 안의 두 사람은 **좌표가 겹친다** — 격납고에서 남의 개인 함선에 들어가면 공유 데크에
  있는 분대원이 발밑에 겹쳐 서 있게 된다. 같은 함선을 구경 중인 둘은 서로 보인다(그게 이 기능의 요점이다).
  값이 양쪽 다 null 인 평소(임무 · 공유 데크)에는 아무것도 달라지지 않는다.

- **2026-09-09 (캐릭터 악센트)** — `PlayerSystem` 의 `readonly model` 이 `new SoldierModel(localAccentColor())` 이 됐다.
  캐릭터 생성창에서 고른 `PlayerProfile.accent` (`#rrggbb`) 가 로컬 병사의 벨트 · 어깨 · 스트라이프 · 부츠 · 바이저에
  들어간다. 색은 `SoldierModel` 생성자에서 **구워지는데** 이 모델은 필드 초기화라 `init(ctx)` 보다 먼저 만들어지므로,
  `ctx.progression` 이 아니라 `shared/saveSlot.readSlotCard(activeSlot()).accent` 로 활성 슬롯의 세이브에서 곧장 읽는다
  (시스템들과 같은 "부팅 때 한 번"). 세이브가 없거나 색이 없으면 `SOLDIER_DEFAULT_ACCENT`.
  **원격 아바타(`RemoteAvatar`)는 그대로 `NET_SLOT_COLORS[slot]`** 을 쓴다 — 분대에서 서로를 가려내는 색이라
  캐릭터 색으로 바꾸지 않았다. `player/Portraits` 도 그대로 슬롯 색이다.

- **2026-09-09 (움직이는 발판)** — `PlayerController` 가 적분 **직전에**
  `world.getStandingObstacle(pos.x, pos.z, pos.y)?.velocity` 를 읽어 그 속도를 **위치에 직접** 더한다
  (`Obstacle.velocity`, 2026-09-09 계약). 전차 데크처럼 스스로 움직이는 발판 위에 서 있으면 함께 실려
  간다. `vel` 에 더하지 않는 이유: 그러면 이동 속도 · 스태미나 · 보행 애니메이션의 `speed` 가 전차
  속도로 흔들린다. 실내(함선 `InteriorCollider`) 모드에는 발판이 없으므로 건너뛴다.
  지형지물 위 걷기(`getSurfaceY` → `resolveCollision` 순서)는 이미 2026-09-09 앞선 배치에서 들어가 있다
  — `world/README.md` 의 "player/PlayerController still calls getHeightAt" 는 낡은 문장이다.
