import * as THREE from 'three';
import type { BoostKind, EnvKind, FurniturePose, FurniturePoseKind, PlayerRestoreState, Rarity, RoverRideBinding } from '@/shared';
import type { PlayerDamageOptions, PlayerDamageSource } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_WALK_SPEED, PLAYER_DOWN_BLEED_PER_SEC,
  PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD, ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME,
  CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST, ROLL_COOLDOWN, ROLL_STAMINA_COST, SLASH_DURATION,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
import { activeSlot, readSlotCard } from '@/shared';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from './SoldierModel';
import { CameraRig, type RigInput } from './CameraRig';
import { PlayerController, type ClimbInput, type MoveInput, type MoveResult, type ShipBounds } from './PlayerController';
import type { LadderDef } from '@/shared';
import { Hellpod, type HellpodEvents } from './Hellpod';
import { PlayerGear } from './PlayerGear';
import type { CarryEndReason, PortraitRef } from '@/shared';
import { PLAYER_CARRY_DROP_S, PLAYER_CARRY_OFFSET, PLAYER_CARRY_PICKUP_S, PLAYER_CARRY_RANGE, PLAYER_CARRY_SPEED_MUL } from '@/shared';
import type { CarryHost } from './Carry';
import { createPortraits } from './Portraits';
import { snapshotAndroidFace as snapshotAndroidFaceImage, snapshotFace as snapshotFaceImage } from './FaceSnapshot';

import { LADDER_STEP_VOLUME, LADDER_STEP_VOLUME_FAST, createFurniturePoseState, type FurniturePoseState } from './model';
import {
  AUTO_REVIVE_DELAY_S, BURN_TICK, CLOAK_FADE, DEATH_ANIM, EXHAUSTED_SLOW, EYE_CROUCH, EYE_PRONE, EYE_ROLL, EYE_STAND,
  FADE_FAR, FADE_NEAR, GIVE_UP_PROGRESS_HZ, MELEE_SWING_TIME, type MeleeKind, SPAWN_RING_RADIUS, STAMINA_JUMP_COST,
  STAMINA_SPRINT_RECOVER, type SpeedMod, type WeaponState, _camLook, _camPos, _q, _up,
} from './model';
  /** The folder's shared vocabulary (constants · types · scratch) is in `model.ts` — re-exported for old imports. */
export * from './model';
import * as Vitals from './parts/Vitals';
import * as Loco from './parts/Locomotion';
import * as Spawn from './parts/Spawn';
import * as Stat from './parts/Statuses';
import * as Shoulder from './parts/Shoulder';
import * as Act from './parts/Interact';
import * as Climb from './parts/Climb';
import * as Drone from './parts/DroneControl';
import * as Pose from './parts/FurniturePose';
import * as Buffs from './parts/Buffs';
import * as Boosts from './parts/Boosts';
import * as RoverRide from './parts/RoverRide';
import * as Fall from './parts/Fall';
import * as IntroWake from './parts/IntroWake';
import type { CharBuff, FurniturePoseState as FurniturePoseWire } from '@/shared';

/**
 * The local character's accent colour (`PlayerProfile.accent`, picked in character creation) as a numeric hex.
 *
 * `SoldierModel` **bakes the accent in its constructor** (the materials are created there). This model, though, is
 * built by field initialisation *before* `init(ctx)`, so it cannot see `ctx.progression` — it therefore reads the
 * active slot's save directly through `shared/saveSlot.readSlotCard` (the profile is read at the same "once at boot"
 * moment the systems use). With no save, or no colour in it, the default helldiver yellow. **Remote avatars keep
 * using the lobby slot colour.**
 */
function localAccentColor(): number {
  try {
    const hex = readSlotCard(activeSlot()).accent;
    if (hex && /^#[0-9a-fA-F]{6}$/.test(hex)) return Number.parseInt(hex.slice(1), 16);
  } catch { /* storage off — fall back to the default colour */ }
  return SOLDIER_DEFAULT_ACCENT;
}

export class PlayerSystem implements GameSystem, PlayerRef, PlayerWeaponHost {
  readonly name = 'player';

  ctx!: GameContext;
  readonly model = new SoldierModel(localAccentColor());
  readonly controller = new PlayerController();
  rig!: CameraRig;
  readonly hellpod = new Hellpod();

  // health
  hp = PLAYER_MAX_HP;
  /**
   * 2026-09-10 — the hp maximum is no longer nailed to a constant. The base is `PLAYER_MAX_HP` (100) plus
   * **whatever bonus another effect adds**. Nothing grants such a bonus today, so the result is still 100, but the
   * calculation is kept in one place so the HUD reading `player:healthChanged.maxHp` is always right.
   * (The shield is a completely separate pool — see `shield` / `maxShield`.)
   */
  bonusMaxHp = 0;
  get maxHp(): number { return Math.max(1, PLAYER_MAX_HP + this.bonusMaxHp); }
  isDead = false;
  deadTimer = 0;
  invuln = 0;
  flinch = 0;
  healPool = 0;
  healRate = 0;
  // downed: hp 0 but not dead — crawling prone while `downHp` bleeds
  _downed = false;
  _downHp = 0;
  bleedAcc = 0;
  giveUpHold = 0;
  /** Phase 9: last `player:giveUpProgress.t` emitted (-1 = idle) and when. */
  giveUpSent = -1;
  giveUpSentAt = -Infinity;
  /**
   * Phase 12 legendary perk `auto_revive` (`재기동 회로`): once per raid the downed player stands back up by himself
   * after `AUTO_REVIVE_DELAY_S`. `autoReviveTimer` counts down while armed (−1 = not armed), `autoReviveUsed` is
   * reset on `world:ready`.
   */
  autoReviveUsed = false;
  autoReviveTimer = -1;

  // stamina
  // stamina (max comes from `지구력` endurance via progression; PLAYER_MAX_STAMINA is the fallback)
  stamina = PLAYER_MAX_STAMINA;
  get maxStamina(): number { return this.ctx?.progression?.derived.maxStamina ?? PLAYER_MAX_STAMINA; }
  regenDelay = 0;
  exhausted = false;
  exhaustedSlow = 0;

  /* ── tactical kit ── */
  readonly gear = new PlayerGear();
  rollBlend = 0;
  rollPhase = 0;
  rollCooldown = 0;
  meleeTimer = 0;
  meleeCooldown = 0;
  /** kind + total length of the swing in progress (pose progress = 1 − meleeTimer / meleeDuration) */
  meleeKind: MeleeKind = 'light';
  meleeDuration = MELEE_SWING_TIME;
  /* unique weapon poses (setWeaponState extras), damped blends */
  chargeBlend = 0;
  sprayBlend = 0;
  heavyBlend = 0;
  cloakTimer = 0;
  cloakSource: 'gadget' | 'armor' | null = null;
  cloakBreak = 0;
  cloakProbe = 0;
  cloakNearEnemy = false;
  _cloaked = false;
  readonly speedMods = new Map<string, SpeedMod>();
  /** `ctx.time` until which `isOvercharged` is true (2026-09-11 C-3: set by `setOvercharged`, 0 = off). */
  _overchargedUntil = 0;
  readonly grappleVec = new THREE.Vector3();
  _grappling = false;
  _hovering = false;
  hoverBlend = 0;
  autoHoverUsed = false;
  burnDps = 0;
  burnTimer = 0;
  burnTick = 0;
  _burning = false;
  /** 2026-09-15 (results-screen rework): source of the fire burning us — the burn tick puts it on `applyDamage`. */
  burnSource: PlayerDamageSource | undefined = undefined;
  /**
   * 2026-09-15 (results-screen rework): the candidate death cause — the source of the damage that took hp to 0 (while
   * downed, the source that downed us; a last hit landed after that replaces it). `die()` sends it as
   * `player:died.source` and clears it. revive · clearDowned clear it too.
   */
  _deathSource: PlayerDamageSource | undefined = undefined;
  regenAccum = 0;
  /* The planet's permanent environment (A-13, `parts/Statuses.updateEnv`). Folding in whether a preparation on the
   * profile blocks it, `player:envChanged` goes out **only when the state changes**. The preparations themselves live
   * on progression's profile, out of reach of `resetTactical` and the spawns — what is here is the exposure state and
   * the tick accumulator, nothing else. */
  envKind: EnvKind | null = null;
  envProtected = false;
  envTick = 0;

  // stance
  _stance: Stance = 'stand';
  standUpTimer = 0;
  /** 2026-09-16: self-propelled horizontal metres (m) — `PlayerRef.selfMovedMeters`, summed after the controller. */
  private _selfMovedMeters = 0;

  // state
  controlsEnabled = false;
  spawned = false;
  isAiming = false;
  aimBlend = 0;
  /** Damp rate for the ADS blend, derived from the active weapon's aim-in time (`setAdsTime`). */
  private adsRate = 12;
  scopeHidden = false;
  crouchBlend = 0;
  proneBlend = 0;
  /** Downed fall progress 0..1 — drives `SoldierModel.poseDowned` (the backward fall), 2026-09-08. */
  downedBlend = 0;
  sprintBlend = 0;
  throwBlend = 0;
  holdItemBlend = 0;
  cookBlend = 0;
  bodyYaw = 0;
  private poseRecoil = 0;
  /** weapons holds the mouse for its quick-use wheel: camera ignores mouse deltas while true */
  lookLocked = false;
  weaponState: WeaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false, throwing: false, holdingItem: false, charging: false, spraying: false, heavy: false, cooking: false };
  /** RMB is the weapon's alternative fire (unique weapons): never enter the ADS state. */
  private altFireWeapon = false;
  slowTimer = 0;
  slowFactor = 1;
  attachedParent: THREE.Object3D | null = null;
  /* ── Phase 10: shouldering a downed squadmate ── */
  /** Peer id on our right shoulder (null = nobody). */
  _carrying: string | null = null;
  /** Another player's shoulder socket our own body hangs on (null = on our own feet). */
  carriedSocket: THREE.Object3D | null = null;
  /** Damped 0..1 blend driving `SoldierPose.carry`. */
  carryBlend = 0;
  /** Movement lock during the pick-up / put-down animation. */
  carryLock = 0;
  /** Installed by `RemotePlayerSystem.init` (it owns the avatars / refs a carry needs). */
  carryHost: CarryHost | null = null;
  shipBounds: ShipBounds = null;
  _interior: InteriorCollider | null = null;
  _inPod = false;
  /* ── ladder · step smoothing (2026-09-11, `parts/Climb`) ── */
  /** Damped 0..1 blend driving `SoldierPose.climb`. */
  climbBlend = 0;
  /** Last `player:climbChanged.ladderId` emitted (null = on the ground). */
  climbSent: string | null = null;
  /** Per-frame ladder input (W/S · sprint · jump · E), filled by `Climb.readClimbInput`. */
  readonly climbInput: ClimbInput = { z: 0, fast: false, jump: false, drop: false };
  /**
   * Visual-only offset of the model (and the camera pivot) from the physics position: sudden steps (low rocks, box
   * edges, the ground snap) and the ladder grab snap are written here and decay by `STEP_SMOOTH_RATE`.
   */
  readonly bodyOffset = new THREE.Vector3();
  /* ── drone control (2026-09-11, `parts/DroneControl`) ── */
  /** true while the local player looks through a drone — inputs belong to the drone, the body crouches still. */
  _droneControl = false;
  /** Stance before `setDroneControl(true)` (restored on a manual release when it was `stand`). */
  droneStancePrev: Stance | null = null;
  /* ── rover riding (2026-09-13, `parts/RoverRide`) ── */
  /** The world/rover binding while the body sits inside the rover (null = on foot). */
  _roverRide: RoverRideBinding | null = null;
  /** 0..1 progress of the E exit hold, and whether a fresh E press may start one. */
  roverHold = 0;
  roverHoldArmed = true;
  /* ── the intro wake (2026-09-14, `parts/IntroWake`) ── */
  /** Seconds left. **-1 = no cutscene** (0 is not used, it would read as "this frame is the last one"). */
  introWakeT = -1;
  /** Full length of the running cutscene (for the progress calculation). */
  introWakeDur = 0;
  /**
   * 2026-09-15 — the cutscene now running is the **respawn variant** (`playIntroWake(d, {respawn:true})`): pose and
   * input lock only, no fade · dedicated camera · `introWaking` · `player:introWakeDone` (`parts/IntroWake`).
   */
  introWakeRespawn = false;
  /* ── the scene lock (2026-09-14, 3rd pass, `PlayerRef.setSceneLock`) ── */
  /** While true every input is locked and damage ignored. The caller (the liftoff cutscene) holds the camera. */
  _sceneLock = false;
  /**
   * 2026-09-15 — damage **lands** during the scene lock too (`setSceneLock(true, {allowDamage})`); hp never falls
   * below `_sceneLockMinHp`.
   */
  _sceneLockDamage = false;
  _sceneLockMinHp = 1;
  /* ── furniture poses (2026-09-12, `parts/FurniturePose`) ── */
  /** Sit / bench / run / cycle on a piece of ship furniture: logical state, restore spot, drive phase, model blend. */
  readonly furn: FurniturePoseState = createFurniturePoseState();
  /* ── character buffs (2026-09-12, `parts/Buffs`) ── */
  /** Published list (`PlayerRef.buffs`) — replaced by a new array only when it changed. */
  _buffs: readonly CharBuff[] = [];
  _buffsRevision = 0;
  /** Set by the events / pose changes that may change the list; `update` recomputes once per frame. */
  buffsDirty = true;
  /** Seconds toward the next `BUFF_TICK_S` recompute (debuff expiry has no event). */
  buffsTick = 0;
  /** Recompute scratch (pooled `CharBuff` objects, never published). */
  readonly buffScratch: CharBuff[] = [];
  readonly buffPool: CharBuff[] = [];
  /* ── combat consumable effects (2026-09-12, `parts/Boosts`) ── */
  /** Running boost (null = none). Durations in `ctx.time` seconds; `boostStartedAt` / `boostEndsAt` = the buff clock (epoch ms). */
  boostKind: BoostKind | null = null;
  boostDefId: string | null = null;
  boostDuration = 0;
  boostUntil = 0;
  boostStartedAt = 0;
  boostEndsAt = 0;
  /** Reused `PlayerRef.boost` view. */
  readonly boostView: { kind: BoostKind; remaining: number; duration: number; defId: string | null } = { kind: 'adrenaline', remaining: 0, duration: 0, defId: null };

  // interaction
  interactTarget: Interactable | null = null;
  holdProgress = 0;
  lastPromptText: string | null = null;
  lastHoldProgress = -1;
  interactCooldown = 0;
  /** A hold interaction needs a fresh E press after one completed (E kept held does not start the next one). */
  holdArmed = true;

  // scratch
  readonly moveInput: MoveInput = { x: 0, z: 0, sprint: false, jump: false, stance: 'stand', aiming: false };
  private readonly moveResult: MoveResult = { footstep: false, landed: 0, jumped: false, rollEnded: false, rung: false, climbEnded: null, fallHeight: 0 };
  readonly podEvents: HellpodEvents = { impact: false, opened: false, finished: false };
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };
  private readonly rigInput: RigInput = {
    pivot: new THREE.Vector3(), aim: 0, sprint: 0, crouch: 0, prone: 0, dive: 0, moveBlend: 0,
    grounded: true, dead: false, world: null, shipBounds: null, interior: null,
  };
  readonly eyePos = new THREE.Vector3();
  private readonly aimOrigin = new THREE.Vector3();

  /* ─────────────────────────── PlayerRef ─────────────────────────── */
  get position(): THREE.Vector3 { return this.controller.position; }
  get velocity(): THREE.Vector3 { return this.controller.velocity; }
  get yaw(): number { return this.rig ? this.rig.yaw : 0; }
  get isSprinting(): boolean { return this.controller.sprinting; }
  get object(): THREE.Object3D { return this.model.root; }
  get stance(): Stance { return this._stance; }
  get isDiving(): boolean { return this.controller.diving; }
  /* ── multiplayer snapshot inputs (read by net/NetSystem) ── */
  get pitch(): number { return this.rig ? this.rig.pitch : 0; }
  get isGrounded(): boolean { return this.controller.grounded; }
  get isReloading(): boolean { return this.weaponState.reloading; }
  get isFiring(): boolean { return this.weaponState.firing; }
  get isDropping(): boolean { return this.hellpod.isActive && this.hellpod.state !== 'exiting'; }
  /**
   * 2026-09-13 (extraction rework): also true while standing in the **landed** dropship's bay — boarding no longer
   * puts the body on the `shipBounds` box until it rides off (the bay is walked in world mode against the hull
   * colliders), and the readers (`IN_SHIP` snapshot flag, tram-hit and hazard-damage exemptions) mean "in the
   * extraction ship".
   */
  get isInShip(): boolean {
    return this.shipBounds !== null || (this.spawned && (this.ctx.extraction?.isInShipBay(this.controller.position) ?? false));
  }
  get stridePhase(): number { return this.controller.stridePhase; }
  /** Same value the pose uses (0 idle … 1 walk … 1.2 sprint). */
  get moveBlend(): number { return Math.min(1.2, this.controller.speed / PLAYER_WALK_SPEED); }
  /* ── ship hub / interiors (appended contract) ── */
  get interior(): InteriorCollider | null { return this._interior; }
  get isInPod(): boolean { return this._inPod; }
  /* ── down / revive / respawn (Phase 2) ── */
  get isDowned(): boolean { return this._downed; }
  get downHp(): number { return this._downHp; }
  /* ── tactical kit (appended contract) ── */
  /** Alt rolls (replaces the dive); the wire keeps the DIVE flag via `isDiving`. */
  get isRolling(): boolean { return this.controller.rolling; }
  /**
   * 2026-09-16 (the `운반` hauling skill): odometer of self-propelled horizontal metres (m, never decreases) — the
   * contract is `PlayerRef.selfMovedMeters`.
   */
  get selfMovedMeters(): number { return this._selfMovedMeters; }
  get isMeleeing(): boolean { return this.meleeTimer > 0; }
  /* ── Phase 7 (docs/DECISIONS.md Phase 7) ── */
  /** true while the `용검` heavy slash pose plays (`startMelee('heavy')`); net puts MELEE_HEAVY on the wire from it. */
  get isMeleeHeavy(): boolean { return this.meleeTimer > 0 && this.meleeKind === 'heavy'; }
  /* ── ladder (2026-09-11, appended contract `PlayerRef.climbingLadder`) ── */
  /** Id of the ladder we hang on (also while mounting the top), null otherwise. net puts `CLIMBING` on the wire from it. */
  get climbingLadder(): string | null { return this.controller.climbLadder ? this.controller.climbLadder.id : null; }

  /** `ladder:grab` → hang on `ladder` (ignored while dead / downed / carrying / carried / in a pod / dropping / in an interior …). */
  grabLadder(ladder: LadderDef, from: 'bottom' | 'top'): boolean { return Climb.grabLadder(this, ladder, from); }
  /** Let go of the ladder for any reason (the body falls from where it hangs). Emits `player:climbChanged {null}` once. */
  releaseLadder(): void { return Climb.releaseLadder(this); }
  /** Reset paths: release the ladder and drop the visual step / grab offset. */
  clearClimbState(): void { return Climb.clearClimbState(this); }
  syncClimb(): void { return Climb.syncClimb(this); }

  /* ── drone control (2026-09-11, appended contract `PlayerRef.droneControl` / `setDroneControl`) ── */
  get droneControl(): boolean { return this._droneControl; }
  /**
   * true = look through a drone: movement / jump / stance / roll / sprint / aim / E / carry / ladder / weapons off, horizontal
   * velocity 0, `stand` → `crouch` (prone stays prone), mouse look not applied to the rig. Refused silently (stays false)
   * when the body is not free (dead · downed · pod · hellpod · carried · ladder · ship box · attached · interior · hub ·
   * controls off). false = back to the body; restores `stand` if it was forced to crouch. Never touches the camera
   * override — the drone releases it with `setCameraOverride(null)`.
   */
  setDroneControl(active: boolean): void { return Drone.setDroneControl(this, active); }
  /** Internal auto-release (death · downed · resets · pod · ship · hub): no stance restore, camera override cut at once. */
  releaseDroneControl(restoreStance = false, cutCamera = true): void { return Drone.releaseDroneControl(this, restoreStance, cutCamera); }

  /* ── rover riding (2026-09-13, appended contract `PlayerRef.roverRide` / `roverBoardBlock` / `setRoverRide`) ── */
  get roverRide(): boolean { return this._roverRide !== null; }
  /** Korean reason the body cannot board now (dead · downed · carrying · carried · ladder · drone · ship / pod …), null = free. */
  roverBoardBlock(): string | null { return RoverRide.roverBoardBlock(this); }
  /** Board (hidden inside, controls locked, immune, orbit camera) / alight at `exitAt` (surface-snapped, hard cut behind the PC). */
  setRoverRide(binding: RoverRideBinding | null, exitAt?: THREE.Vector3): void { return RoverRide.setRoverRide(this, binding, exitAt); }
  /** While riding: the ground `ROVER_SAFE_SIDE_M` to the vehicle's right (raid saves · forced releases), else null. */
  roverSafePosition(out: THREE.Vector3): THREE.Vector3 | null { return RoverRide.roverSafePosition(this, out); }
  /** Internal release (death · resets · backstop): alight beside the vehicle. No-op when not riding. */
  releaseRoverRide(): void { return RoverRide.releaseRoverRide(this); }

  /* ── the intro wake (2026-09-14, appended contract `PlayerRef.playIntroWake`, `parts/IntroWake`) ── */
  /**
   * While true, movement · stance · weapons · interaction · mouse look are locked and the camera frames the body.
   * 2026-09-14: it is also the contract `PlayerRef.introWaking` — the compass and Tab bag wait for it to go false.
   */
  // 2026-09-15: the respawn variant (`introWakeRespawn`) is not the opening — the compass and Tab do not wait for it
  get introWaking(): boolean { return this.introWakeT >= 0 && !this.introWakeRespawn; }
  /**
   * The tutorial opening — starts in the downed pose and stands up over `durationS` (`TUTORIAL_INTRO_WAKE_S`). While
   * it rises the camera moves to the ordinary third-person back-view spot; at the end the override is released and
   * `player:introWakeDone` goes out. `game:abort` · `game:newMission` · death release it themselves.
   */
  /**
   * 2026-09-15: `opts.respawn` = the tutorial respawn variant (downed pose → stand up + input lock only, no fade ·
   * camera · done signal).
   */
  playIntroWake(durationS: number, opts?: { respawn?: boolean }): void { return IntroWake.playIntroWake(this, durationS, opts); }

  /* ── the scene lock (2026-09-14, 3rd pass, appended contract `PlayerRef.setSceneLock`) ── */
  /**
   * **The scripted scene is holding the body** — movement · stance · jump · roll · aim · weapons · interaction ·
   * mouse look are locked and every incoming damage is ignored (no shield, hp, downed or death happens).
   *
   * No new lock path was created — one more condition was added to **the very places** the intro wake
   * (`introWaking`) · drone control · rover riding already look at (`scripted` in `update`, `canUseWeapons`), and the
   * damage is blocked on the same line as `_roverRide` at the single entry (`parts/Vitals.applyDamage`) and at the
   * only branch that bypasses it (`parts/Statuses.updateEnv`).
   * **The camera is not touched** (its only user today, the extraction liftoff cutscene, already holds it).
   *
   * Released by itself at: `game:abort` (`resetAll`) · `game:newMission` · `spawnStanding` · `respawnAt` — that is,
   * a ship return · a new mission · a revive all pass through one. Turning it off is always safe (one flag).
   */
  /*
   * 2026-09-15 (`opts` — user's decision 「처치하지 않은 안드로이드의 사격을 맞은 채 출발한다 · 죽지 않는다」): with
   * `allowDamage` the input lock stays but damage **lands** (shield → hp, hit feedback · sound · direction arc as
   * usual). Only hp stops at `minHp` (1 by default, at least 1) and there is no downed state and no death —
   * `parts/Vitals.applyDamage` · `parts/Statuses.updateEnv` read these two fields. Knockback is still blocked.
   * The options are rewritten even when the lock is already on (turning it off restores their defaults).
   */
  setSceneLock(on: boolean, opts?: { allowDamage?: boolean; minHp?: number }): void {
    const next = !!on;
    this._sceneLockDamage = next && opts?.allowDamage === true;
    const minHp = opts?.minHp;
    this._sceneLockMinHp = next && typeof minHp === 'number' && Number.isFinite(minHp) ? Math.max(1, minHp) : 1;
    if (this._sceneLock === next) return;
    this._sceneLock = next;
  }

  /* ── furniture poses (2026-09-12, `PlayerRef.furniturePose` / `setFurniturePose` / `setFurniturePoseDrive`) ── */
  get furniturePose(): FurniturePoseKind | null { return this.furn.kind; }
  /**
   * Sit / lie / run / pedal on ship furniture (`null` releases → `player:furniturePoseEnded {reason:'caller'}`). Ship only;
   * refused (false, nothing changed) outside `phase 'hub'` and while dead · downed · drone · ladder · pod · carried / carrying.
   * While posed: no move / jump / stance / roll / aim / weapons / interaction (E stands up when `releaseOnInteract`), the
   * feet are pinned under `anchor`, `camera` blends the rig override in. Release returns to the exact spot / stance.
   */
  setFurniturePose(pose: FurniturePose | null): boolean { return Pose.setFurniturePose(this, pose); }
  /** Exercise phase 0..1 (`bench` bar · `run` step · `cycle` crank). Self-driven until the first call. */
  setFurniturePoseDrive(phase: number): void { return Pose.setFurniturePoseDrive(this, phase); }
  /** Internal release (E · resets). No-op without a pose; emits `player:furniturePoseEnded` once. */
  releaseFurniturePose(reason: Pose.FurniturePoseEndReason): void { return Pose.releaseFurniturePose(this, reason); }
  /**
   * 2026-09-12 (buffs): the pose as net puts it on the wire (`fp` · `fu`) — kind, anchor, yaw, **cumulative** phase
   * (bench 0…1 · run steps · cycle revolutions · sit 0), furniture uid. A reused object; null without a pose.
   */
  get furniturePoseState(): FurniturePoseWire | null { return Pose.poseWireState(this); }

  /* ── character buffs (2026-09-12, contract `PlayerRef.buffs` / `buffsRevision`, `player:buffsChanged`) ── */
  /** Everything on this character (`CHAR_BUFF_ORDER`); a new array only when it changed. See `parts/Buffs`. */
  get buffs(): readonly CharBuff[] { return this._buffs; }
  /** +1 per published change (0 = never had a list). */
  get buffsRevision(): number { return this._buffsRevision; }
  /** Collect the list now; true when it changed (revision bumped, `player:buffsChanged` emitted). Smokes / console. */
  recomputeBuffs(): boolean { return Buffs.recomputeBuffs(this); }

  /* ── combat consumable effects (2026-09-12, appended contract `PlayerRef.applyBoost` …, `parts/Boosts`) ── */
  /** Adrenaline · stimulant — weapons' `Healing.finishHeal` after the item was used. One starts, the other clears. */
  applyBoost(kind: BoostKind, defId?: string): void { return Boosts.applyBoost(this, kind, defId); }
  get boost(): { kind: BoostKind; remaining: number; duration: number; defId: string | null } | null { return Boosts.boostState(this); }
  /** 1 normally, `BOOST_STIMULANT_AIM_SWAY_MUL` under a stimulant (the camera sway multiplies it). */
  get aimSwayMul(): number { return Boosts.aimSwayMul(this); }
  get boostReloadSpeedMul(): number { return Boosts.reloadSpeedMul(this); }
  get adsSpeedMul(): number { return Boosts.adsSpeedMul(this); }
  get staminaDrainMul(): number { return Boosts.staminaDrainMul(this); }
  get staminaCostMul(): number { return Boosts.staminaCostMul(this); }

  /**
   * Rejoin: resume the body exactly as the host's ghost left it — standing at `position` facing `yaw`, no hellpod,
   * `hp`; `state` 1 = downed with `downHp` (prone crawl, bleeding, revivable — `player:downed` so the HUD shows the
   * vitals); `state` 2 = dead (death pose, controls off) WITHOUT `player:died` — game/ runs the respawn flow itself.
   * Emits `player:spawned` for 0 / 1. Clears any interior / ship box / pod state like `respawnAt`.
   */
  restoreState(state: PlayerRestoreState): void { return Spawn.restoreState(this, state); }
  get isCloaked(): boolean { return this._cloaked; }
  get isHovering(): boolean { return this._hovering; }
  /** 2026-09-11 (C-3): an explicit timer set by `setOvercharged` — no longer inferred from an `overcharge*` speed-modifier key. */
  get isOvercharged(): boolean { return this._overchargedUntil > 0 && !!this.ctx && this.ctx.time < this._overchargedUntil; }
  /** Mark overcharged for `duration` s (0 = clear). implants' `applyBoost` calls it next to `setSpeedModifier`. */
  setOvercharged(duration: number): void { this._overchargedUntil = duration > 0 && this.ctx ? this.ctx.time + duration : 0; }
  /**
   * **Always 0 (2026-09-10).** Armor does not reduce damage, it grants a shield (extra hp) — see `shield` below.
   * `PlayerRef.damageReduction` is handled like `airstrike` · `secondary`: **kept only because it is the contract**,
   * and out of the damage calculation (`parts/Vitals.applyDamage`) entirely.
   */
  get damageReduction(): number { return this.gear.damageReduction; }

  /* ── the shield (2026-09-10) ───────────────────────────────────────────────
   * The **extra hp pool** armor grants. Damage empties the shield first and only the remainder reaches `hp`. It never
   * regenerates by itself: it is refilled by the '실드 충전기' consumable and by returning to the ship (hub). The
   * plate's durability wears by whatever the shield absorbed (`wearGear`), and durability 0 = broken = maximum 0 (no
   * charger fills it — it is repaired at the ship's workbench).
   * Every change goes out as `player:shieldChanged` (the bottom-left gauge reads nothing else).
   */
  _shield = 0;
  /**
   * 2026-09-10: the shield a rejoin (`restoreState`) is to give back. `Infinity` = the armor's maximum (an old save,
   * or an older host that sent no shield). `syncShield` applies it exactly once, and only **after the armor has
   * actually been read** (`gear.shieldMax > 0`) — on the rejoin frame `PlayerGear` has not re-read the inventory yet
   * so the maximum is 0, and writing it there would silently cost the returning player his shield.
   */
  pendingShield: number | null = null;
  /** The last value published (the same value is never sent twice). */
  private shieldSent = -1;
  private shieldMaxSent = -1;

  get shield(): number { return this._shield; }
  get maxShield(): number { return this.gear.shieldMax; }
  get shieldRarity(): Rarity | null { return this.gear.shieldRarity; }
  get shieldTier(): number { return this.gear.shieldTier; }

  /**
   * The shield charger: refills by `amount` (`Infinity` = full). With no armor, broken armor or an already full
   * shield it **does nothing and returns false** — the caller (weapons' quick use) asks with this before consuming
   * the item.
   */
  chargeShield(amount: number): boolean {
    if (!this.spawned || this.isDead || this._downed) return false;
    const max = this.maxShield;
    if (max <= 0 || !(amount > 0) || this._shield >= max) return false;
    const before = this._shield;
    this._shield = Math.min(max, this._shield + amount);
    const delta = this._shield - before;
    if (delta <= 0) return false;
    this.emitShield(delta);
    // 2026-09-11 (C-21): its own completion sound (it used to borrow `stim` at pitch 1.25 — defined in audio/Synth)
    this.ctx.bus.emit('audio:play', { id: 'shield_charge', volume: 0.7 });
    return true;
  }

  /**
   * The shield takes the incoming damage first. Returns **how much the shield actually absorbed**; the caller passes
   * the remainder on to hp (`parts/Vitals.applyDamage`). No event goes out when it returns 0.
   */
  absorbShield(amount: number): number {
    if (!(amount > 0) || this._shield <= 0) return 0;
    const took = Math.min(this._shield, amount);
    this._shield -= took;
    this.emitShield(-took);
    return took;
  }

  /**
   * Checks every frame whether the armor changed and whether we are on the ship, and rebuilds the shield when needed.
   * Runs right after `gear.update`.
   *
   * - **Always full on the ship (hub)** — equipping · swapping · repairing fills it to the maximum on the spot, and
   *   the launch goes out in that state.
   * - **Swapping armor mid-raid does not refill it** (the shield held is only clamped to the new maximum) — a spare
   *   armor as a free charger would make chargers pointless. In a raid the only way to refill is a charger.
   * - Taking the armor off or breaking it puts the maximum at 0, so the shield is 0 too.
   */
  syncShield(): void {
    const max = this.gear.shieldMax;
    const before = this.shieldSent < 0 ? 0 : this.shieldSent;
    // always full on the ship; anywhere else only clamped to the new maximum (a mid-raid swap does not refill)
    this._shield = max <= 0 ? 0 : this.ctx.isHubPhase() ? max : Math.min(this._shield, max);
    // the rejoin amount lands exactly once, on the first frame the armor was really read
    // (pointless in the hub — the shield is already full there).
    if (this.pendingShield !== null && max > 0) {
      const want = this.pendingShield;
      this.pendingShield = null;
      this._shield = Math.max(0, Math.min(max, Number.isFinite(want) ? Math.round(want) : max));
    }
    if (this._shield !== this.shieldSent || max !== this.shieldMaxSent) this.emitShield(this._shield - before);
  }

  /** Downed · death: empties the shield outright (`parts/Vitals`). Does nothing when it is already 0. */
  clearShield(): void {
    if (this._shield <= 0) return;
    const delta = -this._shield;
    this._shield = 0;
    this.emitShield(delta);
  }

  /** The one place `player:shieldChanged` is sent. `delta` is this change (negative for a loss). */
  emitShield(delta: number): void {
    const max = this.maxShield;
    this._shield = Math.max(0, Math.min(max, this._shield));
    this.shieldSent = this._shield;
    this.shieldMaxSent = max;
    this.ctx?.bus.emit('player:shieldChanged', {
      shield: this._shield, maxShield: max, delta,
      rarity: this.gear.shieldRarity, tier: this.gear.shieldTier,
    });
  }

  get isBurning(): boolean { return this._burning; }

  /**
   * Roll (Alt) in `direction` — defaults to the current movement input, else camera forward. Costs
   * ROLL_STAMINA_COST, has a ROLL_COOLDOWN, is denied while airborne / rolling / downed / in a pod / in the hub,
   * inside the extraction ship box and from '무거움' (90 %) upward. Emits `player:dived` (wire compatibility).
   */
  roll(direction?: THREE.Vector3): boolean { return Loco.roll(this, direction); }

  /**
   * Start a melee swing (F). `light` (default) costs MELEE_STAMINA_COST and plays for MELEE_SWING_TIME;
   * `heavy` = the `용검` big slash: two-handed wide horizontal swing for SLASH_DURATION (`isMeleeing` stays true
   * meanwhile) — the caller (weapons) has already taken the stamina through `consumeStamina`, so no cost here.
   * Both lock out for MELEE_COOLDOWN (a swing never starts inside another). WeaponSystem owns the key binding,
   * the hit resolution and `melee:swing` / `melee:hit` / `player:slashed`.
   */
  startMelee(kind: MeleeKind = 'light'): boolean {
    if (!this.canAct() || this.controller.rolling) return false;
    if (this._carrying) { this.dropCarried('action'); return false; }
    if (this.meleeTimer > 0 || this.meleeCooldown > 0) return false;
    if (kind !== 'heavy') {
      if (this.stamina < MELEE_STAMINA_COST * this.staminaCostMul) {   // 2026-09-12: a stimulant costs more (spendStamina multiplies it)
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
        return false;
      }
      this.spendStamina(MELEE_STAMINA_COST);
    }
    this.meleeKind = kind;
    this.meleeDuration = kind === 'heavy' ? SLASH_DURATION : MELEE_SWING_TIME;
    this.meleeTimer = this.meleeDuration;
    this.meleeCooldown = Math.max(MELEE_COOLDOWN, this.meleeDuration + 0.1);
    return true;
  }

  /** Apply / refresh a cloak. Optical-camo armor passes `Infinity`; the strongest remaining duration wins. */
  setCloak(duration: number, source: 'gadget' | 'armor'): void { return Stat.setCloak(this, duration, source); }

  /** 0..1 factor an enemy multiplies its detection range by (1 = fully visible). */
  getStealthFactor(): number { return Stat.getStealthFactor(this); }

  /**
   * Multiplicative speed stack so overcharge / ultralight armor / weight / slows never overwrite each other.
   * `mul === 1` with no duration removes the entry. Keys 'weight' and 'armor' are owned by the player.
   */
  setSpeedModifier(key: string, mul: number, duration?: number): void { return Loco.setSpeedModifier(this, key, mul, duration); }

  /** Add to the velocity (jump pad, rocket blast, grapple release). Emits `player:launched`. */
  applyImpulse(impulse: THREE.Vector3): void { return Loco.applyImpulse(this, impulse); }

  /** Grapple: reel the player toward `point` until the implant releases it (null). */
  setGrappleTarget(point: THREE.Vector3 | null): void { return Loco.setGrappleTarget(this, point); }

  /** Tactical bag hover: slows the fall while held (also auto-engaged once to prevent a fatal fall). */
  setHovering(hovering: boolean): void { return Loco.setHovering(this, hovering); }

  /** Fire zone / incendiary: DoT that also suppresses the `인내` (grit) save while it kills. */
  setBurning(dps: number, duration: number, source?: PlayerDamageSource): void { return Stat.setBurning(this, dps, duration, source); }

  /** Teammate finished the revive hold (net → `ctx.player.revive()`): back up with PLAYER_REVIVE_HP, still prone. */
  revive(): void { return Vitals.revive(this); }

  /**
   * Shove (behemoth charge, blasts, `dmg.kb`): `direction × speed` through the controller's `applyImpulse` path —
   * an in-flight roll is cancelled first and the impulse always carries at least a small lift so the feet leave the
   * ground (grounded cleared) and the shove is not eaten by ground friction. Ignored while dead / downed / not
   * spawned / inside the hellpod. No `player:launched` (that is the jump-pad / rocket-jump event).
   */
  applyKnockback(direction: THREE.Vector3, speed: number): void { return Vitals.applyKnockback(this, direction, speed); }

  /** Stim heal-over-time (1.5 s). The caller (weapons quick-use) has already consumed the item. */
  applyStim(healAmount: number): boolean { return Vitals.applyStim(this, healAmount); }

  /**
   * appended (2026-09-07): the consumable's own heal-over-time. `seconds` ≤ 0 lands the whole `amount` on the next
   * frame; `quiet` skips the SFX (the `회복 스프레이` ticks 10×/s). A pool already running is **topped up** rather than
   * refused for a spray tick — a fresh use still refuses while one is running, which is what `applyStim` always did.
   */
  applyHeal(amount: number, seconds: number, quiet = false): boolean { return Vitals.applyHeal(this, amount, seconds, quiet); }

  /** Re-drop at `position` like at mission start (hellpod, full hp, alive, not downed). `player:respawn` → here. */
  respawn(position: THREE.Vector3): void { return Spawn.respawn(this, position); }

  /**
   * Walk inside a ship interior: ground = `collider.getFloorAt`, push-out = `collider.resolveCollision`,
   * ceiling / camera = `collider.raycast`, camera clamp = `collider.bounds`. No slope sliding, no map bounds,
   * `ctx.world` may be null. Takes precedence over `setShipInterior`. Cleared by `respawnAt` (and `hub:left`).
   */
  setInterior(collider: InteriorCollider | null): void {
    if (collider) { this.releaseRoverRide(); this.releaseDroneControl(); this.releaseLadder(); }
    else this.releaseFurniturePose('reset');   // 2026-09-12: no deck (hub:left · respawn) → no furniture to sit on
    this._interior = collider;
    this.controller.interior = collider;
    this.rigInput.interior = collider;
    if (collider) {
      // settle onto the deck right away so the first frame doesn't fall / pop
      const c = this.controller;
      const floor = collider.getFloorAt(c.position.x, c.position.z);
      if (Math.abs(c.position.y - floor) < 1.5) { c.position.y = floor; c.velocity.y = 0; c.grounded = true; }
    }
  }

  /**
   * Cutscene camera (docking, launch, drone view). Blends to `pos` looking at `lookAt`; null releases back to the rig.
   * `snap` = full weight at once; with null (2026-09-11) = hard cut back to the rig instead of the blend-out.
   * Consumed in this system's `lateUpdate`, so a caller registered after the player sets it from its **`update`**.
   */
  setCameraOverride(pos: THREE.Vector3 | null, lookAt?: THREE.Vector3, snap = false): void {
    if (this.rig) this.rig.setOverride(pos, lookAt, snap);
  }

  /**
   * Place the player standing at `position` facing `yaw`: alive, full hp / stamina, stance stand, no hellpod,
   * controls enabled, detached from any parent, camera snapped behind the player, not in a pod. Emits
   * `player:spawned`. Does NOT touch `interior` (call `setInterior` before or after) and does not release an
   * active camera override (the hub owns that via `setCameraOverride(null)`).
   */
  spawnStanding(position: THREE.Vector3, yaw: number): void { return Spawn.spawnStanding(this, position, yaw); }

  /** Boarded in a hub launch pod: movement locked, model hidden (remotes hide via `PlayerFlags.IN_POD`). */
  setInPod(inPod: boolean): void {
    if (inPod === this._inPod) return;
    this._inPod = inPod;
    if (inPod) { this.releaseRoverRide(); this.releaseDroneControl(); this.releaseLadder(); this.releaseFurniturePose('reset'); this.clearCarry('action'); this.setAiming(false); this.controller.velocity.set(0, 0, 0); this.controller.sprinting = false; }
    if (this.spawned && !this.scopeHidden) this.model.setVisible(!inPod);
  }

  getEyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.controller.position).add(this.eyePos);
  }
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return this.rig ? this.rig.getForward(out) : out.set(0, 0, -1);
  }

  takeDamage(amount: number, from?: THREE.Vector3, source?: PlayerDamageSource, opts?: PlayerDamageOptions): void { return Vitals.takeDamage(this, amount, from, source, opts); }

  /**
   * Single damage path. `dot` (burning) skips the invulnerability window, the shake / audio and the `인내` (grit)
   * save. **The shield eats the damage first** and only the remainder reaches hp (2026-09-10 — armor does not reduce
   * damage); the plate wears by what the shield absorbed. A roll counts as a partial i-frame.
   * 2026-09-15: with `opts.bypassShield` (the toxic spore hazard) the shield is skipped and only hp is cut — the
   * branch is inside `Vitals.applyDamage`.
   */
  applyDamage(amount: number, from: THREE.Vector3 | undefined, dot: boolean, source?: PlayerDamageSource, opts?: PlayerDamageOptions): void { return Vitals.applyDamage(this, amount, from, dot, source, opts); }

  /** The armor wears by the `absorbed` the shield ate (durability is inventory's; 0 = broken = shield maximum 0). */
  wearGear(absorbed: number): void {
    const inv = this.ctx.inventory;
    if (!inv || absorbed <= 0 || !this.gear.armorUid) return;
    inv.damageDurability(this.gear.armorUid, absorbed * ARMOR_DURABILITY_PER_DAMAGE);
    this.gear.markDirty();
  }

  /** hp hit 0: the `인내` (grit) skill may leave 1 hp (never on a DoT tick), otherwise the player goes downed. */
  onLethal(dot: boolean): void { return Vitals.onLethal(this, dot); }

  heal(amount: number): void { return Vitals.heal(this, amount); }
  /** 2026-09-14: a scripted scene sets hp outright (the tutorial's 「딱피로 깨어난다」). No hit feedback, no shield. */
  setHp(hp: number): void { return Vitals.setHp(this, hp); }

  /* ── dev console / unique weapons (2026-09-06) ─────────────────────────── */
  /**
   * Instant move without a hellpod (console `/move`, Home move cheat): feet to `position`, velocity / roll / grapple
   * cleared, stance / hp / items / interior untouched, no `player:spawned`. Unless `snap === false` the feet are put
   * on the ground under the target: the interior deck (`interior.getFloorAt`) in the hub, else the terrain
   * (`world.getHeightAt`). Optional `yaw` turns both the camera and the body; the camera follows immediately.
   * Works in the hub and on a mission; ignored while dead, in a pod, or inside the hellpod drop.
   */
  teleport(position: THREE.Vector3, yaw?: number, snap?: boolean): void { return Spawn.teleport(this, position, yaw, snap); }
  /**
   * Wide-angle camera (target FOV × SLASH_FOV_MUL, damped in and out on the rig, composed with the sprint / ADS
   * FOV logic) while true — the `용검` slash wind-up and swing. Cleared by every reset.
   */
  setViewWiden(active: boolean): void { this.rig.viewWiden = !!active; }
  /**
   * Spend stamina (the big slash costs `maxStamina × SLASH_STAMINA_RATIO`). False — and nothing spent — when short
   * or while exhausted (stamina hit 0 and has not recovered to STAMINA_SPRINT_RECOVER yet, same as sprint / roll).
   * Spending goes through the regular path (regen delay, `player:staminaDepleted` at 0).
   */
  consumeStamina(amount: number): boolean { return Loco.consumeStamina(this, amount); }

  respawnAt(position: THREE.Vector3, yaw?: number): void { return Spawn.respawnAt(this, position, yaw); }

  setShipInterior(bounds: ShipBounds): void {
    if (bounds) { this.releaseRoverRide(); this.releaseDroneControl(); this.releaseLadder(); this.releaseFurniturePose('reset'); }
    this.shipBounds = bounds;
    this.controller.shipBounds = bounds;
  }

  setControlsEnabled(enabled: boolean): void {
    this.controlsEnabled = enabled;
    if (!enabled) this.setAiming(false);
  }

  attachTo(parent: THREE.Object3D | null): void {
    if (parent) { this.releaseRoverRide(); this.releaseDroneControl(); this.releaseLadder(); this.releaseFurniturePose('reset'); }
    const target = parent ?? this.ctx.scene;
    if (this.model.root.parent === target) { this.attachedParent = parent; return; }
    this.model.root.updateWorldMatrix(true, false);
    target.attach(this.model.root);
    this.attachedParent = parent;
  }

  /* ─────────────────────────── PlayerWeaponHost ─────────────────────────── */
  getWeaponSocket(): THREE.Object3D { return this.model.weaponSocket; }
  /** Phase 10: right-shoulder socket a carried squadmate's body is parented to. */
  getShoulderSocket(): THREE.Object3D { return this.model.shoulderSocket; }
  getAimRay(origin: THREE.Vector3, direction: THREE.Vector3): void {
    origin.copy(this.aimOrigin);
    this.rig.getLookDir(direction);
  }
  addRecoil(pitch: number, yaw: number): void {
    this.rig.addRecoil(pitch, yaw);
    this.poseRecoil = Math.min(1, this.poseRecoil + 0.8);
  }
  canUseWeapons(): boolean {
    return this.spawned && this.controlsEnabled && !this.isDead && !this._downed && !this.controller.diving
      && !this.controller.climbing   // 2026-09-11: both hands are on the ladder
      && !this._droneControl         // 2026-09-11: the inputs belong to the drone
      && this.furn.kind === null     // 2026-09-12: sitting / lying / running on ship furniture
      && this._roverRide === null    // 2026-09-13: inside the rover (no weapons from the hull)
      && this.introWakeT < 0         // 2026-09-14: the hands are empty during the intro wake
      && !this._sceneLock            // 2026-09-14, 3rd pass: the scene lock (`setSceneLock`) — the tutorial liftoff
      && !(this.hellpod.isActive && this.hellpod.state !== 'exiting');
  }
  setWeaponState(state: { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing?: boolean; holdingItem?: boolean; charging?: boolean; spraying?: boolean; heavy?: boolean; altFire?: boolean; cooking?: boolean }): void {
    this.weaponState.hasWeapon = state.hasWeapon;
    this.weaponState.reloading = state.reloading;
    this.weaponState.firing = state.firing;
    this.weaponState.twoHanded = state.twoHanded;
    this.weaponState.throwing = state.throwing ?? false;
    this.weaponState.holdingItem = state.holdingItem ?? false;
    // Phase 7: optional cooking hint (pin pulled) — the local pose mirrors what remotes see from the COOKING flag
    this.weaponState.cooking = (state.cooking ?? false) && this.weaponState.holdingItem;
    // unique weapons: braced charge stance / continuous hip spray / heavy hip carry (poses only; nothing on the wire)
    this.weaponState.charging = (state.charging ?? false) && state.hasWeapon;
    this.weaponState.spraying = (state.spraying ?? false) && state.hasWeapon;
    this.weaponState.heavy = (state.heavy ?? false) && state.hasWeapon;
    // unique weapons with an alternative fire on RMB: the aim state is suppressed (no aim pose / camera facing / `aiming` bit)
    this.altFireWeapon = (state.altFire ?? false) && state.hasWeapon;
    if (!state.hasWeapon || this.altFireWeapon) this.setAiming(false);
  }
  /** Quick-use wheel open: the camera ignores mouse deltas (movement keeps working). */
  setLookLocked(locked: boolean): void { this.lookLocked = locked; }
  setAdsTime(seconds: number): void {
    // damp() reaches ~95 % after 3/rate seconds
    this.adsRate = 3 / Math.max(0.05, seconds || 0.25);
  }
  setAimZoom(zoom: number, scope: boolean): void {
    if (this.rig) this.rig.setAimZoom(zoom, scope);
  }
  /** 2026-09-12 aim sway: the weapon in hand's class sway (weapons calls it beside `setAimZoom`). */
  setAimSway(amplitudeDeg: number, frequencyHz: number): void {
    if (this.rig) this.rig.setAimSway(amplitudeDeg, frequencyHz);
  }

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.rig = new CameraRig(ctx.camera);
    ctx.player = this;
    ctx.scene.add(this.model.root);
    ctx.scene.add(this.hellpod.group);
    this.model.setVisible(false);
    this.eyePos.set(0, EYE_STAND, 0);
    this.aimOrigin.copy(ctx.camera.position);

    // Phase 12 perk `kill_stamina` (`아드레날린 펌프`): a kill credited to us refills the stamina bar. `by` is `'local'`
    // on the host for our own hits and on a replica for a `hitc` kill marker (enemies/ folds our PeerId back to it).
    ctx.bus.on('enemy:killed', ({ by }) => {
      if (by !== 'local' || !this.spawned || this.isDead || !ctx.progression?.derived.perks?.kill_stamina) return;
      this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    });
    ctx.bus.on('world:ready', ({ playerSpawn }) => {
      this.autoReviveUsed = false; this.autoReviveTimer = -1;
      if (ctx.rejoinPending) {
        // rejoin (Phase 7): the body comes back through `restoreState` (or game/'s fallback `respawn`) — no hellpod.
        // Park the hidden, control-less player at the spawn so the camera has something to frame meanwhile.
        this.holdForRestore(this.resolveSpawn(playerSpawn));
        return;
      }
      this.respawnAt(this.resolveSpawn(playerSpawn));
      // 2026-09-08: the simulated training range is not a planet — there is no sky for a hellpod to fall from, so
      //   the body simply starts standing at the spawn. `game/` (onWorldReady) skips 'deploying' by the same rule.
      // 2026-09-14: the tutorial is the same — the story starts by **waking on that planet** with no ship, so no pod.
      if (Spawn.usesHellpod(ctx)) this.startDrop();
    });
    ctx.bus.on('game:abort', () => this.resetAll());
    // 2026-09-14: a new mission ends the intro wake silently (`game:abort` is released by `resetAll`)
    // 2026-09-14, 3rd pass: the scene lock is released here too — this line is the contract's
    //   "`game:newMission` releases it itself"
    ctx.bus.on('game:newMission', () => { IntroWake.cancelIntroWake(this); this.setSceneLock(false); });
    /*
     * 2026-09-14 (global fall damage): a dash is **not a fall** — it carries the body forward at its own height,
     * so dashing over a ledge would count the fall after it from the feet height before the dash. This fall is
     * exempted, the same treatment the grapple and the bag hover get.
     */
    ctx.bus.on('implant:dashed', () => this.controller.exemptFall());
    // game/GameFlowSystem: training-range restart · the rejoin fallback (since 2026-09-09 there is no auto revive)
    ctx.bus.on('player:respawn', ({ position }) => this.respawn(position));
    /*
     * 2026-09-09 — **the rescue drop revive**. When `stratagems/parts/Rescue` announces the landing only the target
     * itself reacts: a hellpod drop (`kind` 1) · hp `RESCUE_REVIVE_HP` · empty-handed, because the inventory went to
     * the corpse on death. In single player `'sp'` is oneself (the contract).
     */
    ctx.bus.on('rescue:landed', ({ target, position }) => {
      const me = ctx.isMultiplayer ? ctx.net?.localId ?? 'sp' : 'sp';
      if (target !== me) return;
      this.rescueRevive(position);
    });
    /*
     * 2026-09-09 — our own corpse stood up: there is no reason for two bodies in one spot, so the living model is
     * hidden. A revive (`respawnAt`) shows it again.
     */
    ctx.bus.on('corpse:playerSpawned', ({ ownerId }) => {
      const me = ctx.isMultiplayer ? ctx.net?.localId ?? 'sp' : 'sp';
      if (ownerId === me) this.model.setVisible(false);
    });
    // the hub tore its ship down: nothing to walk on any more (world:ready -> respawnAt clears it too)
    ctx.bus.on('hub:left', () => this.setInterior(null));   // (setInterior(null) also releases a furniture pose)
    // 2026-09-12: a furniture pose is ship-only (`hub`) — a phase change always releases it (reason 'reset')
    ctx.bus.on('game:phaseChanged', () => {
      this.releaseFurniturePose('reset');
      // 2026-09-13: the rover is raid gameplay only — a results screen · the ship · a menu alights beside it
      if (!ctx.isGameplayPhase()) this.releaseRoverRide();
    });
    // 2026-09-11: ladder — world's ladder `Interactable` sends it on E. Entering the ship always lets go.
    ctx.bus.on('ladder:grab', ({ ladder, from }) => { this.grabLadder(ladder, from); });
    ctx.bus.on('hub:entered', () => { this.releaseRoverRide(); this.releaseDroneControl(); this.clearClimbState(); });
    ctx.bus.on('camera:shake', ({ intensity, duration }) => this.rig.addShake(intensity, duration));
    ctx.bus.on('player:applySlow', ({ duration, factor }) => {
      // strongest slow wins; refresh the timer
      this.slowFactor = this.slowTimer > 0 ? Math.min(this.slowFactor, factor) : factor;
      this.slowTimer = Math.max(this.slowTimer, duration);
    });
    // ── gear (armor / bag / weight): re-read the inventory whenever it changed
    const dirty = () => this.gear.markDirty();
    ctx.bus.on('equip:changed', dirty);
    ctx.bus.on('loadout:changed', dirty);
    ctx.bus.on('inventory:weightChanged', dirty);
    ctx.bus.on('inventory:changed', dirty);
    ctx.bus.on('durability:changed', dirty);
    ctx.bus.on('durability:broken', dirty);
    ctx.bus.on('repair:completed', dirty);
    ctx.bus.on('hub:entered', dirty);
    // 2026-09-12: char buffs — progression · housing · environment · phase events recollect the list (`parts/Buffs`)
    Buffs.bindBuffs(this, ctx);
  }

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    const c = this.controller;
    // Phase 10: hanging on a squadmate's shoulder — the same ride-along the extraction ship uses, but the local
    // transform is pinned to PLAYER_CARRY_OFFSET instead of being derived from the controller.
    if (this.carriedSocket) {
      const root = this.model.root;
      if (root.parent !== this.carriedSocket) this.carriedSocket.add(root);
      root.position.set(PLAYER_CARRY_OFFSET[0], PLAYER_CARRY_OFFSET[1], PLAYER_CARRY_OFFSET[2]);
      root.quaternion.identity();
      root.updateWorldMatrix(true, false);
      c.position.setFromMatrixPosition(root.matrixWorld);
      c.velocity.set(0, 0, 0);
    } else if (this.attachedParent) {
      // ride along with a parent (extraction ship)
      this.model.root.updateWorldMatrix(true, false);
      c.position.setFromMatrixPosition(this.model.root.matrixWorld);
    }
    // 2026-09-13 rover: a body no longer free leaves the hull (beside it); a rider sits on the seat every frame
    if (this._roverRide && !RoverRide.canHoldRoverRide(this)) this.releaseRoverRide();
    if (this._roverRide) RoverRide.pinToSeat(this);

    // 2026-09-11: a body that stopped being free (dead / downed / pod / carried / attached / interior / ship box /
    // hellpod) cannot keep hanging on a ladder — the explicit reset paths release it too, this is the backstop.
    if (c.climbing && (!this.spawned || this.isDead || this._downed || this._inPod || this.carriedSocket !== null
      || this.attachedParent !== null || this._interior !== null || this.shipBounds !== null
      || (this.hellpod.isActive && this.hellpod.state !== 'exiting'))) this.releaseLadder();
    // 2026-09-11: same backstop for the drone view — the drone (registered after us) sees `droneControl` false this frame
    if (this._droneControl && !Drone.canHoldDroneControl(this)) this.releaseDroneControl();
    // 2026-09-12: same backstop for a furniture pose (left the ship · died · pod …); the explicit reset paths release it too
    if (this.furn.kind !== null && !Pose.canHoldFurniturePose(this)) this.releaseFurniturePose('reset');
    // 2026-09-14: the intro wake — timer · camera (it ends itself when the body can no longer hold the cutscene)
    IntroWake.updateIntroWake(this, dt);
    const posed = this.furn.kind !== null;
    const riding = this._roverRide !== null;   // 2026-09-13 rover (`parts/RoverRide`)
    /*
     * The 2026-09-14 intro wake (`parts/IntroWake`) · the 2026-09-14 3rd-pass scene lock (`setSceneLock`).
     * Both mean "a scripted scene is holding the body", so they were merged under **one name** (every place the old
     * `waking` stood is now `scripted` — no new lock path). The only difference is the camera: the intro wake holds
     * the camera itself, the scene lock does not touch it (the liftoff cutscene already holds it).
     */
    const scripted = this.introWakeT >= 0 || this._sceneLock;

    // movement / stances / interaction / camera run in gameplay AND hub phases (no UI blocker)
    const control = ctx.isControlActive();
    const hub = ctx.isHubPhase();
    const active = control && this.controlsEnabled && !this.isDead && this.spawned;
    const downed = this._downed;
    const locked = input.isPointerLocked;
    const dropping = this.hellpod.isActive && this.hellpod.state !== 'exiting';
    // Phase 10: the pick-up / put-down animation and being carried both freeze movement (the camera keeps working)
    // 2026-09-12: a furniture pose freezes the controller too (no collision resolve — the feet are pinned under the anchor)
    // 2026-09-14: the intro wake freezes here too (the body lies where it is, every input is the cutscene's)
    const moveFrozen = dropping || this._inPod || this.carriedSocket !== null || this.carryLock > 0 || posed || riding || scripted;

    // click-to-relock fallback (also in the hub)
    if (control && !locked && input.wasMousePressed(0)) input.requestPointerLock();

    // ── gear cache (armor / bag / weight) + derived stat hooks (tactical kit)
    this.gear.update(dt, ctx);
    // 2026-09-10: rebuild the shield from whether the armor changed and whether we are on the ship
    //   (equip · unequip · swap · break · repair · ship return)
    this.syncShield();
    this.applyGearModifiers();
    // Phase 7: the worn armor shows on the body (same look remotes get from `ar`); overcharge = rim glow
    this.model.setArmor(this.gear.armor);
    this.model.setGlow(this.isOvercharged && !this.isDead);
    c.jumpSpeedMul = Math.sqrt(Math.max(0.1, ctx.progression?.derived.jumpHeightMul ?? 1));

    // ── timers
    if (this.invuln > 0) this.invuln -= dt;
    if (this.interactCooldown > 0) this.interactCooldown -= dt;
    if (this.standUpTimer > 0) this.standUpTimer -= dt;
    if (this.exhaustedSlow > 0) this.exhaustedSlow -= dt;
    if (this.rollCooldown > 0) this.rollCooldown -= dt;
    if (this.meleeCooldown > 0) this.meleeCooldown -= dt;
    if (this.meleeTimer > 0) this.meleeTimer = Math.max(0, this.meleeTimer - dt);
    if (this.carryLock > 0) this.carryLock = Math.max(0, this.carryLock - dt);
    if (this.slowTimer > 0) { this.slowTimer -= dt; if (this.slowTimer <= 0) this.slowFactor = 1; }
    // Phase 10: the body on the shoulder may have been revived / died / left while we walked
    if (this._carrying) this.validateCarry();
    let speedMul = this.slowTimer > 0 ? THREE.MathUtils.clamp(this.slowFactor, 0.1, 1) : 1;
    if (this.standUpTimer > 0) speedMul *= 0.5;
    if (this.exhaustedSlow > 0) speedMul *= EXHAUSTED_SLOW;
    if (downed) speedMul *= PLAYER_DOWN_SPEED_MUL;   // crawl: prone speed × 0.6
    if (this._carrying) speedMul *= PLAYER_CARRY_SPEED_MUL;
    speedMul *= this.speedModifierProduct();
    c.speedMultiplier = Math.max(0, speedMul);
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.poseRecoil = damp(this.poseRecoil, 0, 14, dt);

    // ── look & aim (aiming is cancelled during a roll / while downed; the quick-use wheel locks the look)
    // 2026-09-11: the drone view owns the mouse too — its own flag, so it never releases the quick wheel's `lookLocked`
    // 2026-09-12: a furniture pose with a fixed camera owns the view too (the rocking chair keeps free look)
    // 2026-09-14: during the intro wake the mouse belongs to the cutscene too — a yaw turned here would make the
    //   hard cut face the wrong way
    if (active && locked && !this.lookLocked && !this._droneControl && !scripted && !(posed && this.furn.hasCamera)) this.rig.applyLook(input.mouseDX, input.mouseDY, this.aimBlend);
    // 2026-09-12 shoulder swap (`Keys.SHOULDER`, X by default): camera to the other shoulder — CameraRig's damping
    // moves it. Cursor screens (inventory's X = drop · ship management's X = collect) already fall out of `active` /
    // `locked`. Not in the drone view or a fixed-camera pose.
    if (active && locked && !this._droneControl && !riding && !scripted && !(posed && this.furn.hasCamera) && input.wasPressed(Keys.SHOULDER)) this.rig.toggleShoulder();
    // 2026-09-12 aim sway (ADS only): this frame's figure-8 offset is fixed *before* the aim origin / `getAimRay`
    // are read, so the shot and the frame `lateUpdate` renders use the same angle. Off on the ship, ladders, drone /
    // furniture / cutscene views.
    const sw = this.rig.sway;
    sw.aim = this.aimBlend;
    sw.on = this.spawned && !this.isDead && !downed && !hub && !this._droneControl && !posed && !riding && !scripted && !c.climbing && !dropping
      && !this._inPod && !this._interior && !this.shipBounds && !this.attachedParent && this.carriedSocket === null && !this.rig.isOverridden;
    sw.crouch = this.crouchBlend; sw.prone = this.proneBlend;
    sw.move = Math.min(1, c.speed / PLAYER_WALK_SPEED);
    sw.mul = this.aimSwayMul ?? 1;   // [A1] a stimulant (0.7)
    this.rig.advanceSway(dt);
    // 2026-09-08: the aim origin for this frame's shots is where the camera *will* be after `lateUpdate` for the look
    // just applied — not where it was last frame (see `CameraRig.predictPosition`). `lateUpdate` overwrites it again
    // with the real position once the rig has moved.
    this.rig.predictPosition(this.aimOrigin);
    this.setAiming(active && locked && !downed && !this._carrying && !this._droneControl && !posed && !riding && !scripted && this.weaponState.hasWeapon && !this.altFireWeapon && input.isMouseDown(MouseButtons.AIM) && !c.rolling);

    // ── carry input (F tap): pick up / put down. Runs before the movement branches so the key is consumed
    //    before WeaponSystem (which updates later) can read it as a melee swing.
    this.updateCarryInput(active && !dropping && !this._inPod && !this._droneControl && !posed && !riding && !scripted);

    // ── movement input
    const mi = this.moveInput;
    const climbing = c.climbing;
    if (climbing) {
      // ladder (2026-09-11): W/S · sprint · jump · E only (`parts/Climb.readClimbInput`). No stance keys, no roll, no
      // bag hover and no aim; with the UI open or the controls off the body just hangs where it is.
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.aiming = false;
      Climb.readClimbInput(this, active && !moveFrozen);
    } else if (this._droneControl) {
      // drone control (2026-09-11, `parts/DroneControl`): WASD · Shift · Space · C · Z · V belong to the drone — the
      // body stops where it is in the stance chosen on entry (crouch / prone). The controller keeps running with
      // input 0, so gravity · grounding · riding work as usual.
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._hovering) this.setHovering(false);
    } else if (riding) {
      // rover (2026-09-13, `parts/RoverRide`): the body is inside the hull — no movement, jump, stance or roll, and
      // the feet are pinned to the seat. The mouse drives the orbit camera (`applyLook` above), the wheel its range.
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._hovering) this.setHovering(false);
      if (active && locked && input.wheelDelta !== 0) this.rig.zoomRoverOrbit(input.wheelDelta);
    } else if (posed) {
      // furniture pose (2026-09-12, `parts/FurniturePose`): no movement, jump, stance key, roll or bag hover, and the
      // feet are pinned on the furniture. With `releaseOnInteract`, E stands up (it swallows the key and raises a
      // cooldown — the same press must not hit the furniture again).
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._hovering) this.setHovering(false);
      Pose.updateFurniturePose(this, dt, active);
    } else if (active && !moveFrozen && downed) {
      // downed: crawl only — no stance changes, no jump / sprint / dive; Space held = give up
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._stance !== 'prone') this.setStance('prone');
      this.standUpTimer = 0;
    } else if (active && !moveFrozen && this._carrying) {
      // carrying a squadmate: walking and sprinting only. Any other key puts the body down first and the owner
      // of that action retries on the next frame (weapons / implants / gadgets do the same from their own paths).
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      mi.sprint = input.isDown(Keys.SPRINT) && mi.z > 0.2 && !this.exhausted && this.stamina > 0 && !this.gear.overloaded;
      mi.jump = false; mi.aiming = false;
      if (this._stance !== 'stand') this.setStance('stand');
      this.standUpTimer = 0;
      if (input.wasPressed(Keys.CROUCH) || input.wasPressed(Keys.PRONE) || input.wasPressed(Keys.DIVE)
        || input.wasPressed(Keys.JUMP) || input.wasPressed(Keys.INTERACT)) this.dropCarried('action');
    } else if (active && !moveFrozen) {
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      // jump is allowed on terrain and inside hub interiors (ceiling-clamped), not in the extraction ship box
      const wantsJump = input.wasPressed(Keys.JUMP) && (!this.shipBounds || !!this._interior);
      const wantsSprint = input.isDown(Keys.SPRINT) && mi.z > 0.2;
      /*
       * 2026-09-14, 3rd pass (user's decision — prone on the ship too): the old `allowProne: !hub` gate was removed.
       * Standing up where the head is blocked is still refused by `Loco.canStandHere` — except that inside a ship
       * interior (`controller.interior`) that function returns true early (a ship ceiling is taller than a person,
       * and a body that cannot stand would never get out again).
       * Not one line of the world branches, where a low ceiling really is a problem, changed.
       */
      this.updateStanceInput(wantsJump, wantsSprint, /* allowProne */ true);
      const transitioning = this.standUpTimer > 0;
      mi.sprint = input.isDown(Keys.SPRINT) && !this.exhausted && this.stamina > 0 && !transitioning && !this.gear.overloaded;
      mi.jump = wantsJump && this._stance === 'stand' && !transitioning && c.grounded && !c.rolling
        && this.stamina >= STAMINA_JUMP_COST * this.staminaCostMul && !this.gear.overloaded;
      mi.aiming = this.isAiming;
      // Alt = roll (replaces the dive); the roll itself validates stamina / weight / cooldown / hub
      if (input.wasPressed(Keys.DIVE) && !transitioning && this._stance !== 'prone') this.roll();
      // tactical bag: hold Space in the air to hover (and one automatic catch before a fatal fall)
      this.updateBagFlight();
      // step out of the pod automatically unless the player takes over
      if (this.hellpod.state === 'exiting' && mi.x === 0 && mi.z === 0) { mi.z = 0.7; mi.sprint = false; }
    } else {
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._hovering) this.setHovering(false);
    }
    mi.stance = this._stance;
    const wasSprinting = c.sprinting;
    const prevX = c.position.x, prevY = c.position.y, prevZ = c.position.z, prevGrounded = c.grounded;
    if (climbing) {
      c.updateClimb(dt, this.climbInput, this.moveResult);
    } else if (!moveFrozen) {
      c.update(dt, mi, this.rig.yaw, ctx.world, this.moveResult);
      /*
       * 2026-09-16 (the `운반` hauling skill bug, user's decision 「제 힘으로 움직인 것만」): a heavy bag was raising
       * hauling while the body rode the extraction liftoff (progression counted a position delta). Now the controller
       * reports only what **the body moved by itself** this frame (`selfMoved` — vehicle deck · grapple · impulse ·
       * interiors are already 0), and this line filters once more, for a body that is not its own even though the
       * controller ran: drone control (the inputs are the drone's) · attached to the extraction ship (`attachTo`) ·
       * the hellpod (including the automatic steps out of it). In a pod · being carried · the shouldering animation ·
       * a furniture pose · the rover · the scene lock are all `moveFrozen` and never reach this line, and the ladder
       * is the branch above.
       */
      if (this.spawned && !this.isDead && !this._droneControl && this.attachedParent === null && !this.hellpod.isActive) {
        this._selfMovedMeters += c.selfMoved;
      }
    } else {
      this.moveResult.footstep = false; this.moveResult.landed = 0; this.moveResult.jumped = false;
      this.moveResult.rollEnded = false; this.moveResult.rung = false; this.moveResult.climbEnded = null;
      this.moveResult.fallHeight = 0;
    }
    // top / bottom / E / jump all end inside the controller — one `player:climbChanged {null}` from here
    this.syncClimb();
    // sudden steps are smoothed on the model only (the physics position has already moved)
    Climb.updateStepSmoothing(this, dt, prevX, prevY, prevZ, prevGrounded);
    const r = this.moveResult;
    if (r.rung) {
      ctx.bus.emit('audio:play', { id: 'ladder_step', position: c.position, volume: c.climbFast ? LADDER_STEP_VOLUME_FAST : LADDER_STEP_VOLUME });
    }
    if (c.sprinting !== wasSprinting) ctx.bus.emit('player:sprintChanged', { sprinting: c.sprinting });
    if (r.footstep) {
      ctx.bus.emit('player:footstep', { position: c.position, sprinting: c.sprinting });
      if (c.sprinting) { const fx = FxManager.get(); if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 1, 0.5); }
    }
    if (r.jumped) {
      this.spendStamina(STAMINA_JUMP_COST);
      ctx.bus.emit('audio:play', { id: 'player_jump', position: c.position, volume: 0.6 });
    }
    if (r.rollEnded) {
      // back on the feet; small puff where the tumble finished
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 4, 0.7);
    }
    if (r.landed > 0) {
      // ordinary landing: barely any shake for a normal jump, more for real falls
      const impact = r.landed;
      const shake = Math.min(0.2, Math.max(0, impact - 5) * 0.03);
      if (shake > 0.01) this.rig.addShake(shake, 0.12);
      ctx.bus.emit('audio:play', { id: 'player_land', position: c.position, volume: Math.min(1, impact / 10) });
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 5, 0.7);
    }
    /*
     * 2026-09-14 (global fall damage): judged by the **height** fallen (`MoveResult.fallHeight` — an exempt fall
     * is 0). It is kept apart from the landing presentation (`r.landed`) for one reason: coming down slowly on the
     * hover or the grapple is still a landing, and conversely a deep fall whose speed an impulse killed cannot tell
     * from speed alone "how far did it fall".
     */
    if (r.fallHeight > 0) Fall.onLanded(this, r.fallHeight);

    if (c.grounded) { this.autoHoverUsed = false; if (this._hovering) this.setHovering(false); }

    // ── combat consumable effects (2026-09-12): expiry · death · the ship — before the stamina multipliers are
    //    read (`parts/Boosts`)
    Boosts.updateBoost(this);
    // ── stamina
    this.updateStamina(dt);
    // ── tactical kit: cloak, burning, armor regen
    this.updateCloak(dt, ctx);
    this.updateBurning(dt);
    this.updateArmorRegen(dt);
    // ── the planet's permanent environment (A-13): with no preparation only hp is cut (the shield is bypassed)
    this.updateEnv(dt, ctx);

    // ── hellpod choreography
    if (this.hellpod.isActive) this.updateDrop(dt);

    // ── stim heal-over-time (started by `applyStim`; weapons owns the F key / quick-use wheel)
    if (this.healPool > 0 && !this.isDead && !downed) {
      const h = Math.min(this.healPool, this.healRate * dt);
      this.healPool -= h;
      this.heal(h);
      if (this.healPool <= 0) { this.healPool = 0; this.healRate = 0; }
    }

    // ── downed: bleed-out + give-up hold
    if (downed && !this.isDead) this.updateDowned(dt, active);

    // ── interaction (a downed player cannot interact; neither can one with a body on the shoulder)
    //    2026-09-11: nor one hanging on a ladder — E belongs to the ladder (let go) while climbing
    //    2026-09-11: nor one looking through a drone (a running hold is cancelled, the prompt clears)
    //    2026-09-12: nor one sitting / lying on furniture — only the `일어나기` caption of a `releaseOnInteract` pose
    if (posed) Pose.updatePosePrompt(this, active && !downed);
    else if (this._roverRide) RoverRide.updateRoverPrompt(this, dt, active && !downed);   // 2026-09-13: E = the exit hold only
    else this.updateInteraction(dt, active && !downed && !this._carrying && !c.climbing && !this._droneControl && !scripted);

    // ── death anim
    if (this.isDead) this.deadTimer += dt;

    // ── pose blends (the roll reuses the old dive plumbing: `diving` = rolling)
    const diving = c.rolling;
    // 2026-09-12: the stimulant's ADS-transition multiplier is applied here — `setAdsTime` only arrives on a weapon
    //   change, so multiplying there would land the effect late
    this.aimBlend = damp(this.aimBlend, this.isAiming ? 1 : 0, this.adsRate * this.adsSpeedMul, dt);
    // scoped ADS: the camera sits at the shoulder, so hide the soldier (and the held weapon) once the blend is in
    const scopeHide = this.rig.scoped && this.aimBlend > 0.85;
    if (scopeHide !== this.scopeHidden) { this.scopeHidden = scopeHide; this.model.setVisible(!scopeHide && !this._inPod && this._roverRide === null); }
    // 2026-09-16 the low roll: the crouch blend is held through a crouched roll — the roll pose lays over it, and
    //   the crouch is back the moment it ends
    this.crouchBlend = damp(this.crouchBlend, this._stance === 'crouch' ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, this._stance === 'prone' && !diving ? 1 : 0, 8, dt);
    this.downedBlend = damp(this.downedBlend, this._downed && !this.isDead ? 1 : 0, 7, dt);
    this.rollBlend = damp(this.rollBlend, diving ? 1 : 0, 18, dt);
    if (diving) this.rollPhase = c.rollProgress;
    else if (this.rollBlend < 0.01) { this.rollBlend = 0; this.rollPhase = 0; }
    this.hoverBlend = damp(this.hoverBlend, this._hovering ? 1 : 0, 10, dt);
    this.sprintBlend = damp(this.sprintBlend, c.sprinting ? 1 : 0, 8, dt);
    this.throwBlend = damp(this.throwBlend, this.weaponState.throwing ? 1 : 0, 12, dt);
    this.holdItemBlend = damp(this.holdItemBlend, this.weaponState.holdingItem ? 1 : 0, 10, dt);
    this.cookBlend = damp(this.cookBlend, this.weaponState.cooking && !this.weaponState.throwing ? 1 : 0, 10, dt);
    this.chargeBlend = damp(this.chargeBlend, this.weaponState.charging ? 1 : 0, 10, dt);
    this.sprayBlend = damp(this.sprayBlend, this.weaponState.spraying ? 1 : 0, 12, dt);
    this.heavyBlend = damp(this.heavyBlend, this.weaponState.heavy ? 1 : 0, 8, dt);
    this.carryBlend = damp(this.carryBlend, this._carrying ? 1 : 0, 8, dt);
    this.climbBlend = damp(this.climbBlend, c.climbing ? 1 : 0, 12, dt);
    Pose.updatePoseBlend(this, dt);
    const poseEye = Pose.poseEyeHeight(this);   // 2026-09-12: seated / lying eye above the pinned feet
    const eyeTarget = poseEye !== null ? poseEye : diving ? EYE_ROLL : this._stance === 'prone' ? EYE_PRONE : this._stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
    this.eyePos.y = damp(this.eyePos.y, eyeTarget, 10, dt);

    // body faces aim when aiming/firing/reloading/throwing/meleeing or prone, the roll direction while rolling, else movement
    const faceCamera = this.isAiming || this.weaponState.firing || this.weaponState.reloading || this.weaponState.throwing
      || this._stance === 'prone' || this.meleeTimer > 0;
    const ladder = c.climbLadder;
    if (!this.isDead) {
      // on a ladder the body faces the rungs (-normal); the camera stays free
      if (Pose.updatePoseYaw(this, dt)) { /* 2026-09-12: furniture pose — the body faces the furniture (on a bench the feet face the other way) */ }
      else if (ladder) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(ladder.normal.x, ladder.normal.z), 18, dt);
      else if (diving) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.rollDir.x, -c.rollDir.z), 20, dt);
      else if (faceCamera) this.bodyYaw = dampAngle(this.bodyYaw, this.rig.yaw, this._stance === 'prone' ? 7 : 18, dt);
      else if (c.speed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.moveDir.x, -c.moveDir.z), 12, dt);
    }
    const p = this.pose;
    p.moveBlend = Math.min(1.2, c.speed / PLAYER_WALK_SPEED);
    p.sprint = this.sprintBlend;
    p.stridePhase = c.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.aim = this.aimBlend;
    p.aimPitch = this.rig.pitch;
    p.torsoTwist = wrapAngle(this.rig.yaw - this.bodyYaw);
    p.airborne = damp(p.airborne, c.grounded || diving || c.climbing ? 0 : 1, 12, dt);
    p.verticalVel = c.velocity.y;
    p.flinch = this.flinch;
    p.hasWeapon = this.weaponState.hasWeapon;
    p.twoHanded = this.weaponState.twoHanded;
    p.reloading = this.weaponState.reloading;
    p.recoil = this.poseRecoil;
    p.throw = this.throwBlend;
    p.holdItem = this.holdItemBlend;
    p.cooking = this.cookBlend;
    p.roll = this.rollBlend;
    p.rollPhase = this.rollPhase;
    p.melee = this.meleeTimer > 0 ? 1 - this.meleeTimer / this.meleeDuration : 0;
    p.meleeHeavy = this.meleeTimer > 0 && this.meleeKind === 'heavy' ? 1 : 0;
    p.charging = this.chargeBlend;
    p.spraying = this.sprayBlend;
    p.heavyCarry = this.heavyBlend;
    p.hover = this.hoverBlend;
    p.carry = this.carryBlend;
    p.climb = this.climbBlend;
    // 2026-09-08: downed is its own backward-fall pose (SoldierModel.poseDowned)
    // 2026-09-14: the intro wake rewinds that same pose 1 → 0 to make "falls, then stands up" (`parts/IntroWake`)
    p.downed = Math.max(this.downedBlend, IntroWake.wakeBlend(this));
    p.dead = this.isDead ? Math.min(1, this.deadTimer / DEATH_ANIM) : 0;
    Pose.applyPoseToSoldier(this, p);   // 2026-09-12: furniture pose blend / kind / phase (`run` rides the walk cycle)
    this.model.update(dt, ctx.time, p);

    // ── write model transform (world → parent local when attached). While carried the transform is owned by the
    //    carrier's shoulder socket (written at the top of `update`), so nothing is written here.
    const root = this.model.root;
    if (this.carriedSocket) {
      /* pinned to the socket */
    } else if (this.attachedParent) {
      root.position.copy(c.position);
      this.attachedParent.worldToLocal(root.position);
      this.attachedParent.getWorldQuaternion(_q).invert();
      root.quaternion.setFromAxisAngle(_up, this.bodyYaw).premultiply(_q);
    } else if (!Pose.placeRoot(this)) {   // 2026-09-12: a furniture pose slides the root onto its anchor
      root.position.copy(c.position).add(this.bodyOffset);   // 2026-09-11: step / ladder-grab smoothing (visual only)
      root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    }

    // ── 2026-09-12: char buffs — this frame's pose · environment · events in one pass (+ a 1 s tick, `parts/Buffs`)
    Buffs.updateBuffs(this, dt);
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const ri = this.rigInput;
    // 2026-09-10: the parent may have moved during *this* frame's updates (the extraction ship registers after
    // us and climbs at ~26 m/s), and the body is already drawn at the new pose because it hangs off that parent.
    // Re-derive the world position here or the camera trails the bay by a whole frame — half a metre of it.
    if (this.attachedParent && !this.carriedSocket) {
      this.model.root.updateWorldMatrix(true, false);
      this.controller.position.setFromMatrixPosition(this.model.root.matrixWorld);
    }
    // the pivot follows the smoothed body (bodyOffset), so a step never slides the soldier inside the frame
    ri.pivot.copy(this.controller.position).add(this.eyePos).add(this.bodyOffset);
    if (this.isDead) ri.pivot.y = this.controller.position.y + 0.9;
    ri.aim = this.aimBlend;
    ri.sprint = this.sprintBlend;
    ri.crouch = this.crouchBlend;
    ri.prone = this.proneBlend;
    ri.dive = this.rollBlend;   // same camera treatment as the old dive (pull back a little)
    ri.moveBlend = Math.min(1, this.controller.speed / PLAYER_WALK_SPEED);
    ri.grounded = this.controller.grounded;
    ri.dead = this.isDead;
    ri.world = ctx.world;
    ri.shipBounds = this.shipBounds;
    if (this.hellpod.isActive && this.hellpod.getCameraPose(_camPos, _camLook)) {
      this.rig.setOverride(_camPos, _camLook);
    }
    this.rig.update(dt, ri);
    this.aimOrigin.copy(this.rig.position);

    // ── near-clip fade: the camera pulled into the body (obstacle behind the back, scoped tuck) -> fade the soldier
    // 2026-09-11: in the drone view `pivotDistance` is drone camera → shoulder — a drone parked beside the body must not
    // fade it out (the pilot has to see his own crouched body). The silhouette stays as usual.
    // 2026-09-12: nor may a fixed furniture camera parked close to the bench fade the body it is there to show
    let alpha = this.spawned && !this.scopeHidden && !this._droneControl && !(this.furn.kind !== null && this.furn.hasCamera) ? smoothstep(FADE_NEAR, FADE_FAR, this.rig.pivotDistance) : 1;
    // cloaked: the local player sees himself shimmer too (remotes get the same treatment in RemoteAvatar)
    if (this._cloaked && !this.isDead) alpha = Math.min(alpha, CLOAK_FADE);
    this.model.setFade(alpha);
    // ── occlusion silhouette (black where the world hides the body); off while dead / dropping / in a pod / faded
    // 2026-09-17 (user's decision): off while riding the extraction ship away too (`ctx.extraction.riding`, the
    //   tutorial included) — a body inside the closed-ramp hull showed through as a silhouette to the liftoff camera.
    const ridingShip = this.ctx.extraction?.riding ?? false;
    this.model.setSilhouette(this.spawned && !this.isDead && !this.hellpod.isActive && !this._inPod && !this.scopeHidden && this._roverRide === null && !ridingShip);
  }

  dispose(): void {
    this.model.dispose();
    this.hellpod.dispose();
  }

  /* ─────────────────────────── internals ─────────────────────────── */
  setAiming(aiming: boolean): void {
    if (aiming === this.isAiming) return;
    this.isAiming = aiming;
    this.ctx.bus.emit('player:aimChanged', { aiming });
  }

  setStance(stance: Stance): void { return Loco.setStance(this, stance); }

  /**
   * C toggles stand↔crouch (prone → crouch). Z toggles prone (prone → stand).
   * Sprint (with forward input) or jump while crouched stands up; from prone they only stand up
   * (0.35 s transition, the jump itself is denied by the caller). Nothing changes while airborne,
   * diving or mid-transition.
   */
  private updateStanceInput(wantsJump: boolean, wantsSprint: boolean, allowProne: boolean): void { return Loco.updateStanceInput(this, wantsJump, wantsSprint, allowProne); }

  spendStamina(cost: number): void { return Loco.spendStamina(this, cost); }

  onStaminaDepleted(): void { return Loco.onStaminaDepleted(this); }

  /**
   * Regen is scaled by `지구력` endurance (`derived.staminaRegenMul`), the carry weight (`WeightInfo.staminaRegenMul`,
   * softened by the `운반` hauling skill inside inventory) and the ultralight-armor perk. Hovering burns stamina.
   */
  private updateStamina(dt: number): void { return Loco.updateStamina(this, dt); }

  /** hp reached 0: downed instead of death — prone crawl, weapons off, `downHp` starts bleeding. */
  enterDowned(): void { return Vitals.enterDowned(this); }

  /** Bleed PLAYER_DOWN_BLEED_PER_SEC (whole points → `player:downHpChanged`), Space held PLAYER_GIVE_UP_HOLD → die. */
  private updateDowned(dt: number, active: boolean): void { return Vitals.updateDowned(this, dt, active); }

  /**
   * Phase 9: `player:giveUpProgress {t}` for the HUD bar — 0..1 while Space is held (≤ GIVE_UP_PROGRESS_HZ, only on
   * change), a single `-1` when the hold is released / the downed state ends. Nothing is sent while idle.
   */
  emitGiveUpProgress(t: number): void { return Vitals.emitGiveUpProgress(this, t); }

  clearDowned(): void { return Vitals.clearDowned(this); }

  die(): void { return Vitals.die(this); }

  /* ─────────────────────── tactical kit internals ─────────────────────── */
  /**
   * Clear every tactical-kit state (roll, melee, cloak, burning, grapple, hover, buffs).
   * Called from `respawnAt`, `spawnStanding` and the `game:abort` reset. The gear cache is only marked dirty —
   * armor survives a respawn.
   */
  resetTactical(): void { Boosts.clearBoost(this); return Spawn.resetTactical(this); }

  /** Common precondition for roll / melee. */
  canAct(): boolean { return Loco.canAct(this); }

  /** Camera-relative horizontal direction of the current movement input (zero vector when idle). */
  wishDirection(out: THREE.Vector3): THREE.Vector3 { return Loco.wishDirection(this, out); }

  /** Product of the live speed-modifier stack (drops expired entries). */
  private speedModifierProduct(): number { return Loco.speedModifierProduct(this); }

  /** Weight state and the ultralight-armor perk feed the same stack as external buffs. */
  private applyGearModifiers(): void { return Loco.applyGearModifiers(this); }

  /**
   * Cloak upkeep: firing, sprinting, rolling, meleeing or an enemy inside CLOAK_REVEAL_DISTANCE reveal the player
   * for CLOAK_BREAK_TIME; once the cause is gone (and the distance opened again) the cloak comes back.
   */
  private updateCloak(dt: number, ctx: GameContext): void { return Stat.updateCloak(this, dt, ctx); }

  /** Any alive enemy within `radius`. */
  enemyWithin(ctx: GameContext, radius: number): boolean { return Stat.enemyWithin(this, ctx, radius); }

  /** Burning DoT (incendiary / fire zone). Applied in BURN_TICK chunks; never triggers the `인내` (grit) save. */
  private updateBurning(dt: number): void { return Stat.updateBurning(this, dt); }

  /** Regenerating armor: 1 hp/s (perkValue) while stamina is full. Healed in whole points to avoid event spam. */
  private updateArmorRegen(dt: number): void { return Stat.updateArmorRegen(this, dt); }

  /** A-13: the planet's permanent environment damage · `player:envChanged` (`parts/Statuses.updateEnv`). */
  private updateEnv(dt: number, ctx: GameContext): void { return Stat.updateEnv(this, dt, ctx); }

  /** Tactical bag: hold Space in the air to hover, plus one automatic hover before a fatal fall. */
  private updateBagFlight(): void { return Loco.updateBagFlight(this); }

  /** Tell a hold interactable that its running hold was released / retargeted before completion. */
  cancelHold(): void { return Act.cancelHold(this); }

  private updateInteraction(dt: number, active: boolean): void { return Act.updateInteraction(this, dt, active); }

  perform(target: Interactable): void { return Act.perform(this, target); }

  /**
   * Multiplayer: every client drops on its own pad around the shared spawn — a ring of radius
   * SPAWN_RING_RADIUS, one slot per quadrant (slot × 90° + 45°), snapped to the terrain and pushed
   * out of obstacles. Single-player uses the world spawn untouched.
   */
  resolveSpawn(playerSpawn: THREE.Vector3): THREE.Vector3 { return Spawn.resolveSpawn(this, playerSpawn); }

  /** Rejoin wait: everything reset like `game:abort`, feet + camera parked at `position`, model hidden, no controls. */
  private holdForRestore(position: THREE.Vector3): void { return Spawn.holdForRestore(this, position); }

  /** The hellpod drop. `kind` 0 = mission start, 1 = a rescue drop — squadmates get `pod drop` (2026-09-09). */
  startDrop(kind: 0 | 1 = 0): void { return Spawn.startDrop(this, kind); }

  /** A rescue pod brought us in (`rescue:landed`): drop again empty-handed with `RESCUE_REVIVE_HP`. */
  rescueRevive(position: THREE.Vector3): void { return Spawn.rescueRevive(this, position); }

  private updateDrop(dt: number): void { return Spawn.updateDrop(this, dt); }

  resetAll(): void { return Spawn.resetAll(this); }
  /* ══ Phase 10 — shouldering a downed squadmate + ready-panel portraits ══════════════════════════════════ */
  /**
   * `RemotePlayerSystem` installs itself here in its own `init` (it owns the avatars / refs a carry needs).
   * Without a host `carry()` always fails, so single-player and the headless tests are unaffected.
   */
  setCarryHost(host: CarryHost | null): void { return Shoulder.setCarryHost(this, host); }

  /** PeerId of the squadmate on our right shoulder, or null. */
  get carrying(): string | null { return this._carrying; }
  /** true while another player carries us (our body hangs on their shoulder socket). */
  get isCarried(): boolean { return this.carriedSocket !== null; }

  /**
   * Shoulder a downed squadmate (the contextual F tap). Requires: a carry host, the target inside
   * `PLAYER_CARRY_RANGE`, the target downed and alive and not already carried, and ourselves upright and free
   * (not downed / dead / in a pod / mid-hellpod / already carrying / being carried). Locks movement for
   * `PLAYER_CARRY_PICKUP_S`, cancels aim / sprint / roll / grapple / melee and drops us back to `stand`.
   */
  carry(id: string): boolean { return Shoulder.carry(this, id); }

  /**
   * Put the carried squadmate down at our feet. Returns true when someone was actually dropped. A deliberate
   * put-down (`'manual'`) plays the `PLAYER_CARRY_DROP_S` animation (movement locked for it); every other reason
   * releases immediately so the action that caused it can retry on the next frame.
   */
  dropCarried(reason: CarryEndReason = 'manual'): boolean { return Shoulder.dropCarried(this, reason); }

  /**
   * Ride along on another player's shoulder socket (`null` detaches). Called on the **carried** side by
   * `RemotePlayerSystem` once the wire says a peer is carrying us; the transform is then pinned to
   * `PLAYER_CARRY_OFFSET` inside that socket and the controller position follows it (the `attachTo` pattern the
   * extraction ship uses). Detaching lands the body on the ground under wherever the socket left it.
   */
  setCarriedBy(socket: THREE.Object3D | null): void { return Shoulder.setCarriedBy(this, socket); }

  /** Build `cells` character portraits into `host` (its own WebGL context; null when one is unavailable). */
  /**
   * 2026-09-15: the face portrait on the terminal's `매칭` tab (framed like the character-creation confirm card) —
   * `FaceSnapshot.ts`.
   */
  snapshotFace(opts: { accent: string; size?: number }): string | null { return snapshotFaceImage(opts); }

  /** 2026-09-15 (android squadmates): the android face in the same framing — `PlayerRef.snapshotAndroidFace`. */
  snapshotAndroidFace(opts: { accent: string; size?: number }): string | null { return snapshotAndroidFaceImage(opts); }

  createPortraits(host: HTMLElement, cells: number): PortraitRef | null {
    return createPortraits(this.ctx, host, cells);
  }

  /* ── carry internals ── */
  /**
   * F tap (`Keys.MELEE`, aliased as `Keys.CARRY`): put the body down while carrying, otherwise shoulder the
   * nearest carriable squadmate. The key is **consumed** in both cases so `WeaponSystem` (which updates later)
   * never reads the same tap as a melee swing; with nobody in range the tap falls through to the melee as usual.
   */
  private updateCarryInput(active: boolean): void { return Shoulder.updateCarryInput(this, active); }

  /** The body on our shoulder may have been revived, bled out or left the session while we walked. */
  private validateCarry(): void { return Shoulder.validateCarry(this); }

  /** Release both sides of a carry without moving anybody (used by every reset path). */
  clearCarry(reason: CarryEndReason): void { return Shoulder.clearCarry(this, reason); }
}
