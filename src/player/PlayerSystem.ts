import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, type SoldierPose } from './SoldierModel';
import { CameraRig, type RigInput } from './CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from './PlayerController';
import { Hellpod, type HellpodEvents } from './Hellpod';
import { PlayerGear } from './PlayerGear';

const EYE_STAND = 1.55;
const EYE_CROUCH = 1.15;
const EYE_PRONE = 0.45;
/** Eye height at the top of the tumble (the rig keeps following the pivot). */
const EYE_ROLL = 0.95;

/* ── tactical kit tuning (local; the shared numbers live in shared/constants) ── */
/** Melee swing animation length; must stay below MELEE_COOLDOWN. */
const MELEE_SWING_TIME = 0.45;
/** Cloaked players are drawn semi-transparent for themselves too (remotes use the same value). */
const CLOAK_FADE = 0.4;
/** How often the cloak checks for enemies inside CLOAK_REVEAL_DISTANCE (seconds). */
const CLOAK_PROBE_INTERVAL = 0.25;
/** Burning DoT is applied in ticks so the HUD is not spammed 60×/s. */
const BURN_TICK = 0.5;
/** Stamina drained per second while the tactical bag hovers. */
const HOVER_STAMINA_DRAIN = 10;
/** Fall speed (m/s, negative) that auto-triggers the tactical bag's one free hover (낙사 방지). */
const HOVER_AUTO_FALL = -18;
/** Speed-modifier keys the player owns itself (external callers must not reuse them). */
const SPEEDMOD_WEIGHT = 'weight';
const SPEEDMOD_ARMOR = 'armor';
const INVULN_TIME = 0.15;
const STIM_DURATION = 1.5;
const DEATH_ANIM = 0.9;
/** Minimum upward speed (m/s) a knockback carries so the feet leave the ground and the shove is not eaten by friction. */
const KNOCKBACK_MIN_LIFT = 1.5;

// stamina tuning
const STAMINA_SPRINT_DRAIN = 14;     // per second
const STAMINA_JUMP_COST = 12;
const STAMINA_REGEN_DELAY = 0.8;
const STAMINA_REGEN_MOVING = 16;     // per second
const STAMINA_REGEN_IDLE = 22;
const STAMINA_SPRINT_RECOVER = 20;   // sprint unavailable after depletion until this much
const EXHAUSTED_SLOW_TIME = 1.0;
const EXHAUSTED_SLOW = 0.9;
const STAND_UP_TIME = 0.35;          // prone → stand/crouch transition (no jump/sprint/roll)
const SPAWN_RING_RADIUS = 4;         // multiplayer: per-slot drop offset around the shared spawn (m)
// near-clip body fade: fully visible beyond FADE_FAR m camera->pivot, hidden inside FADE_NEAR
const FADE_FAR = 0.9;
const FADE_NEAR = 0.45;

const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();
const _dir = new THREE.Vector3();

interface WeaponState {
  hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing: boolean; holdingItem: boolean;
  /* unique weapons (2026-09-06): braced charge stance, continuous hip spray, heavy hip carry */
  charging: boolean; spraying: boolean; heavy: boolean;
  /* Phase 7: pin pulled (grenade cooking) — optional hint, remotes get it from the COOKING flag */
  cooking: boolean;
}
/** Melee swing kinds: `light` = the F chop (MELEE_SWING_TIME), `heavy` = the 용검 two-handed slash (SLASH_DURATION). */
type MeleeKind = 'light' | 'heavy';

/** One entry of the multiplicative speed-modifier stack (`setSpeedModifier`). */
interface SpeedMod { mul: number; until: number }

/**
 * Third-person player: controller + camera rig + procedural soldier + health/stims + stamina +
 * stances (C crouch / Z prone / Alt dive) + interaction + hellpod drop + downed / revive / respawn (Phase 2).
 * Publishes itself as `ctx.player` (PlayerRef & PlayerWeaponHost).
 */
export class PlayerSystem implements GameSystem, PlayerRef, PlayerWeaponHost {
  readonly name = 'player';

  private ctx!: GameContext;
  private readonly model = new SoldierModel();
  private readonly controller = new PlayerController();
  private rig!: CameraRig;
  private readonly hellpod = new Hellpod();

  // health
  hp = PLAYER_MAX_HP;
  readonly maxHp = PLAYER_MAX_HP;
  isDead = false;
  private deadTimer = 0;
  private invuln = 0;
  private flinch = 0;
  private healPool = 0;
  private healRate = 0;
  // downed (전투불능): hp 0 but not dead — crawling prone while `downHp` bleeds
  private _downed = false;
  private _downHp = 0;
  private bleedAcc = 0;
  private giveUpHold = 0;

  // stamina
  // stamina (max comes from 지구력 via progression; PLAYER_MAX_STAMINA is the fallback)
  stamina = PLAYER_MAX_STAMINA;
  get maxStamina(): number { return this.ctx?.progression?.derived.maxStamina ?? PLAYER_MAX_STAMINA; }
  private regenDelay = 0;
  private exhausted = false;
  private exhaustedSlow = 0;

  /* ── tactical kit ── */
  private readonly gear = new PlayerGear();
  private rollBlend = 0;
  private rollPhase = 0;
  private rollCooldown = 0;
  private meleeTimer = 0;
  private meleeCooldown = 0;
  /** kind + total length of the swing in progress (pose progress = 1 − meleeTimer / meleeDuration) */
  private meleeKind: MeleeKind = 'light';
  private meleeDuration = MELEE_SWING_TIME;
  /* unique weapon poses (setWeaponState extras), damped blends */
  private chargeBlend = 0;
  private sprayBlend = 0;
  private heavyBlend = 0;
  private cloakTimer = 0;
  private cloakSource: 'gadget' | 'armor' | null = null;
  private cloakBreak = 0;
  private cloakProbe = 0;
  private cloakNearEnemy = false;
  private _cloaked = false;
  private readonly speedMods = new Map<string, SpeedMod>();
  private _overcharged = false;
  private readonly grappleVec = new THREE.Vector3();
  private _grappling = false;
  private _hovering = false;
  private hoverBlend = 0;
  private autoHoverUsed = false;
  private burnDps = 0;
  private burnTimer = 0;
  private burnTick = 0;
  private _burning = false;
  private regenAccum = 0;

  // stance
  private _stance: Stance = 'stand';
  private standUpTimer = 0;

  // state
  private controlsEnabled = false;
  private spawned = false;
  isAiming = false;
  private aimBlend = 0;
  /** Damp rate for the ADS blend, derived from the active weapon's aim-in time (`setAdsTime`). */
  private adsRate = 12;
  private scopeHidden = false;
  private crouchBlend = 0;
  private proneBlend = 0;
  private sprintBlend = 0;
  private throwBlend = 0;
  private holdItemBlend = 0;
  private cookBlend = 0;
  private bodyYaw = 0;
  private poseRecoil = 0;
  /** weapons holds the mouse for its quick-use wheel: camera ignores mouse deltas while true */
  private lookLocked = false;
  private weaponState: WeaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false, throwing: false, holdingItem: false, charging: false, spraying: false, heavy: false, cooking: false };
  /** RMB is the weapon's alternative fire (unique weapons): never enter the ADS state. */
  private altFireWeapon = false;
  private slowTimer = 0;
  private slowFactor = 1;
  private attachedParent: THREE.Object3D | null = null;
  private shipBounds: ShipBounds = null;
  private _interior: InteriorCollider | null = null;
  private _inPod = false;

  // interaction
  private interactTarget: Interactable | null = null;
  private holdProgress = 0;
  private lastPromptText: string | null = null;
  private lastHoldProgress = -1;
  private interactCooldown = 0;
  /** A hold interaction needs a fresh E press after one completed (E kept held does not start the next one). */
  private holdArmed = true;

  // scratch
  private readonly moveInput: MoveInput = { x: 0, z: 0, sprint: false, jump: false, stance: 'stand', aiming: false };
  private readonly moveResult: MoveResult = { footstep: false, landed: 0, jumped: false, rollEnded: false };
  private readonly podEvents: HellpodEvents = { impact: false, opened: false, finished: false };
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0,
  };
  private readonly rigInput: RigInput = {
    pivot: new THREE.Vector3(), aim: 0, sprint: 0, crouch: 0, prone: 0, dive: 0, moveBlend: 0, stridePhase: 0,
    grounded: true, dead: false, world: null, shipBounds: null, interior: null,
  };
  private readonly eyePos = new THREE.Vector3();
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
  get isInShip(): boolean { return this.shipBounds !== null; }
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
  get isMeleeing(): boolean { return this.meleeTimer > 0; }
  /* ── Phase 7 (docs/PHASE7-PLAN.md §4) ── */
  /** true while the 용검 heavy slash pose plays (`startMelee('heavy')`); net puts MELEE_HEAVY on the wire from it. */
  get isMeleeHeavy(): boolean { return this.meleeTimer > 0 && this.meleeKind === 'heavy'; }

  /**
   * Rejoin: resume the body exactly as the host's ghost left it — standing at `position` facing `yaw`, no hellpod,
   * `hp`; `state` 1 = downed with `downHp` (prone crawl, bleeding, revivable — `player:downed` so the HUD shows the
   * vitals); `state` 2 = dead (death pose, controls off) WITHOUT `player:died` — game/ runs the respawn flow itself.
   * Emits `player:spawned` for 0 / 1. Clears any interior / ship box / pod state like `respawnAt`.
   */
  restoreState(state: PlayerRestoreState): void {
    const bus = this.ctx.bus;
    const yaw = Number.isFinite(state.yaw) ? state.yaw : this.bodyYaw;
    _v.copy(state.position);
    if (this.ctx.world?.ready && !this.ctx.world.isInsideBounds(_v.x, _v.z)) {
      // off the map (bad wire data): fall back to the mission spawn
      _v.copy(this.resolveSpawn(this.ctx.world.getPlayerSpawn()));
    }
    if (this.ctx.world?.ready) _v.y = Math.max(_v.y, this.ctx.world.getHeightAt(_v.x, _v.z));
    this.hellpod.hide();
    this.attachTo(null);
    this.setInterior(null);
    this._inPod = false;
    this.shipBounds = null; this.controller.shipBounds = null;
    this.controller.reset(_v);
    this.slowTimer = 0; this.slowFactor = 1; this.controller.speedMultiplier = 1;
    this.isDead = false; this.deadTimer = 0; this.invuln = 0.5; this.flinch = 0;
    this.healPool = 0;
    this.clearDowned();
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.setStance('stand'); this.standUpTimer = 0;
    this.resetTactical();
    this.setAiming(false); this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.sprintBlend = 0;
    this.bodyYaw = yaw;
    this.spawned = true;
    this.controlsEnabled = true;
    this.model.resetPose();
    this.model.setFade(1);
    this.scopeHidden = false;
    this.model.setVisible(true);
    this.model.root.position.copy(this.controller.position);
    this.model.root.quaternion.setFromAxisAngle(_up, yaw);
    this.eyePos.set(0, EYE_STAND, 0);
    _v.copy(this.controller.position); _v.y += EYE_STAND;
    this.rig.snapTo(_v, yaw);
    this.rig.setOverride(null);
    this.interactTarget = null; this.holdProgress = 0;

    const st = state.state;
    if (st === 2) {
      // dead: lie where the ghost fell; the death anim is already over. No `player:died` — game/ owns the flow.
      this.hp = 0;
      this.isDead = true;
      this.deadTimer = DEATH_ANIM;
      this.controlsEnabled = false;
      this.invuln = 0;
      bus.emit('player:healthChanged', { hp: 0, maxHp: this.maxHp, delta: 0 });
      return;
    }
    if (st === 1) {
      this.hp = 0;
      this._downed = true;
      this._downHp = THREE.MathUtils.clamp(Math.round(Number.isFinite(state.downHp) ? state.downHp : PLAYER_DOWN_HP), 1, PLAYER_DOWN_HP);
      this.bleedAcc = 0; this.giveUpHold = 0;
      this.setStance('prone'); this.standUpTimer = 0;
      this.proneBlend = 1;
      this.eyePos.set(0, EYE_PRONE, 0);
      _v.copy(this.controller.position); _v.y += EYE_PRONE;
      this.rig.snapTo(_v, yaw);
      bus.emit('player:spawned', { position: this.controller.position.clone() });
      bus.emit('player:downed', { position: this.controller.position.clone() });
      bus.emit('player:downHpChanged', { downHp: this._downHp, max: PLAYER_DOWN_HP });
      bus.emit('player:healthChanged', { hp: 0, maxHp: this.maxHp, delta: 0 });
      return;
    }
    this.hp = THREE.MathUtils.clamp(Number.isFinite(state.hp) ? state.hp : this.maxHp, 1, this.maxHp);
    bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: 0 });
    bus.emit('player:spawned', { position: this.controller.position.clone() });
  }
  get isCloaked(): boolean { return this._cloaked; }
  get isHovering(): boolean { return this._hovering; }
  get isOvercharged(): boolean { return this._overcharged; }
  get damageReduction(): number { return this.gear.damageReduction; }
  get isBurning(): boolean { return this._burning; }

  /**
   * Roll (Alt) in `direction` — defaults to the current movement input, else camera forward. Costs
   * ROLL_STAMINA_COST, has a ROLL_COOLDOWN, is denied while airborne / rolling / downed / in a pod / in the hub,
   * inside the extraction ship box and from '무거움' (90 %) upward. Emits `player:dived` (wire compatibility).
   */
  roll(direction?: THREE.Vector3): boolean {
    const c = this.controller;
    if (!this.canAct() || !c.grounded || c.rolling || this.ctx.isHubPhase()) return false;
    if (this.rollCooldown > 0) return false;
    if (this.shipBounds || this._interior) return false;
    if (this.gear.rollBlocked) {
      this.ctx.bus.emit('ui:notify', { text: '너무 무거워 구를 수 없다', kind: 'warning', duration: 1.2 });
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
      return false;
    }
    if (this.stamina < ROLL_STAMINA_COST) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
      return false;
    }
    if (direction && direction.lengthSq() > 1e-6) _dir.copy(direction).setY(0);
    else this.wishDirection(_dir);
    if (_dir.lengthSq() < 1e-6) this.rig.getForward(_dir);
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();

    if (this._stance !== 'stand') this.setStance('stand');
    this.setAiming(false);
    this.setHovering(false);
    this.spendStamina(ROLL_STAMINA_COST);
    this.rollCooldown = ROLL_DURATION + ROLL_COOLDOWN;
    this.rollPhase = 0;
    c.startRoll(_dir);
    this.rig.addShake(0.08, 0.18);
    this.ctx.bus.emit('player:dived', { position: c.position.clone(), direction: _dir.clone() });
    this.ctx.bus.emit('audio:play', { id: 'player_jump', position: c.position, volume: 0.7, pitch: 0.85 });
    const fx = FxManager.get();
    if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 4, 0.6);
    return true;
  }

  /**
   * Start a melee swing (F). `light` (default) costs MELEE_STAMINA_COST and plays for MELEE_SWING_TIME;
   * `heavy` = the 용검 big slash: two-handed wide horizontal swing for SLASH_DURATION (`isMeleeing` stays true
   * meanwhile) — the caller (weapons) has already taken the stamina through `consumeStamina`, so no cost here.
   * Both lock out for MELEE_COOLDOWN (a swing never starts inside another). WeaponSystem owns the key binding,
   * the hit resolution and `melee:swing` / `melee:hit` / `player:slashed`.
   */
  startMelee(kind: MeleeKind = 'light'): boolean {
    if (!this.canAct() || this.controller.rolling) return false;
    if (this.meleeTimer > 0 || this.meleeCooldown > 0) return false;
    if (kind !== 'heavy') {
      if (this.stamina < MELEE_STAMINA_COST) {
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
  setCloak(duration: number, source: 'gadget' | 'armor'): void {
    if (!(duration > 0)) {
      if (this.cloakSource === source) { this.cloakTimer = 0; this.cloakSource = null; }
      return;
    }
    if (duration >= this.cloakTimer || this.cloakSource === null) this.cloakSource = source;
    this.cloakTimer = Math.max(this.cloakTimer, duration);
  }

  /** 0..1 factor an enemy multiplies its detection range by (1 = fully visible). */
  getStealthFactor(): number {
    return this._cloaked ? CLOAK_DETECT_MUL : 1;
  }

  /**
   * Multiplicative speed stack so overcharge / ultralight armor / weight / slows never overwrite each other.
   * `mul === 1` with no duration removes the entry. Keys 'weight' and 'armor' are owned by the player.
   */
  setSpeedModifier(key: string, mul: number, duration?: number): void {
    if (!key) return;
    if (!(mul > 0)) mul = 0;
    if (mul === 1 && duration === undefined) { this.speedMods.delete(key); return; }
    const until = duration !== undefined && duration > 0 ? (this.ctx?.time ?? 0) + duration : Infinity;
    this.speedMods.set(key, { mul, until });
  }

  /** Add to the velocity (jump pad, rocket blast, grapple release). Emits `player:launched`. */
  applyImpulse(impulse: THREE.Vector3): void {
    if (!this.spawned || this.isDead) return;
    this.controller.applyImpulse(impulse);
    if (impulse.y > 0.01) this.autoHoverUsed = false;
    this.ctx.bus.emit('player:launched', { position: this.controller.position.clone(), impulse: impulse.clone() });
  }

  /** Grapple: reel the player toward `point` until the implant releases it (null). */
  setGrappleTarget(point: THREE.Vector3 | null): void {
    if (point) {
      this.grappleVec.copy(point);
      this.controller.grappleTarget = this.grappleVec;
      this._grappling = true;
      this.setHovering(false);
      if (this.controller.rolling) this.controller.cancelRoll();
    } else if (this._grappling) {
      this.controller.grappleTarget = null;
      this._grappling = false;
    }
  }

  /** Tactical bag hover: slows the fall while held (also auto-engaged once to prevent a fatal fall). */
  setHovering(hovering: boolean): void {
    const want = hovering && !this.isDead && !this._downed && !this.controller.grounded;
    this.controller.hovering = want;
    if (want === this._hovering) return;
    this._hovering = want;
  }

  /** Fire zone / incendiary: DoT that also suppresses the 인내 save while it kills. */
  setBurning(dps: number, duration: number): void {
    if (!(dps > 0) || !(duration > 0)) {
      if (this._burning) { this._burning = false; this.burnDps = 0; this.burnTimer = 0; this.ctx.bus.emit('player:burning', { active: false, dps: 0 }); }
      return;
    }
    const wasBurning = this._burning;
    this.burnDps = Math.max(this.burnDps, dps);
    this.burnTimer = Math.max(this.burnTimer, duration);
    this._burning = true;
    if (!wasBurning) {
      this.burnTick = BURN_TICK;
      this.ctx.bus.emit('player:burning', { active: true, dps: this.burnDps });
    }
  }

  /** Teammate finished the revive hold (net → `ctx.player.revive()`): back up with PLAYER_REVIVE_HP, still prone. */
  revive(): void {
    if (!this._downed || this.isDead) return;
    this._downed = false;
    this._downHp = 0;
    this.bleedAcc = 0; this.giveUpHold = 0;
    this.hp = PLAYER_REVIVE_HP;
    this.invuln = Math.max(this.invuln, 0.5);
    this.controlsEnabled = true;
    const bus = this.ctx.bus;
    bus.emit('player:revived', { hp: this.hp });
    bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: this.hp });
    bus.emit('audio:play', { id: 'stim', volume: 0.8 });
  }

  /**
   * Shove (behemoth charge, blasts, `dmg.kb`): `direction × speed` through the controller's `applyImpulse` path —
   * an in-flight roll is cancelled first and the impulse always carries at least a small lift so the feet leave the
   * ground (grounded cleared) and the shove is not eaten by ground friction. Ignored while dead / downed / not
   * spawned / inside the hellpod. No `player:launched` (that is the jump-pad / rocket-jump event).
   */
  applyKnockback(direction: THREE.Vector3, speed: number): void {
    if (this.isDead || this._downed || !this.spawned) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return;
    const len = direction.length();
    if (len < 1e-5 || !(speed > 0)) return;
    const c = this.controller;
    if (c.rolling) c.cancelRoll();
    this.setHovering(false);
    _dir.copy(direction).multiplyScalar(speed / len);
    if (_dir.y < KNOCKBACK_MIN_LIFT) _dir.y = KNOCKBACK_MIN_LIFT;
    c.applyImpulse(_dir);
    c.sprinting = false;
    this.rig.addShake(Math.min(0.6, speed * 0.04), 0.4);
  }

  /** Stim heal-over-time (1.5 s). The caller (weapons quick-use) has already consumed the item. */
  applyStim(healAmount: number): boolean {
    if (!this.spawned || this.isDead || this._downed || this.hp >= this.maxHp || healAmount <= 0) return false;
    if (this.healPool > 0) return false; // already healing
    this.healPool = healAmount;
    this.healRate = healAmount / STIM_DURATION;
    this.ctx.bus.emit('player:stimUsed', { hp: this.hp });
    this.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.8 });
    return true;
  }

  /** Re-drop at `position` like at mission start (hellpod, full hp, alive, not downed). `player:respawn` → here. */
  respawn(position: THREE.Vector3): void {
    this.respawnAt(this.resolveSpawn(position));
    this.startDrop();
  }

  /**
   * Walk inside a ship interior: ground = `collider.getFloorAt`, push-out = `collider.resolveCollision`,
   * ceiling / camera = `collider.raycast`, camera clamp = `collider.bounds`. No slope sliding, no map bounds,
   * `ctx.world` may be null. Takes precedence over `setShipInterior`. Cleared by `respawnAt` (and `hub:left`).
   */
  setInterior(collider: InteriorCollider | null): void {
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

  /** Cutscene camera (docking, launch). Blends to `pos` looking at `lookAt`; null releases back to the rig. */
  setCameraOverride(pos: THREE.Vector3 | null, lookAt?: THREE.Vector3, snap = false): void {
    if (this.rig) this.rig.setOverride(pos, lookAt, snap);
  }

  /**
   * Place the player standing at `position` facing `yaw`: alive, full hp / stamina, stance stand, no hellpod,
   * controls enabled, detached from any parent, camera snapped behind the player, not in a pod. Emits
   * `player:spawned`. Does NOT touch `interior` (call `setInterior` before or after) and does not release an
   * active camera override (the hub owns that via `setCameraOverride(null)`).
   */
  spawnStanding(position: THREE.Vector3, yaw: number): void {
    this.hellpod.hide();
    this.attachTo(null);
    this.shipBounds = null; this.controller.shipBounds = null;
    this._inPod = false;
    this.controller.reset(position);
    if (this._interior) {
      const floor = this._interior.getFloorAt(position.x, position.z);
      if (Math.abs(position.y - floor) < 1.5) this.controller.position.y = floor;
    }
    this.hp = this.maxHp;
    this.slowTimer = 0; this.slowFactor = 1; this.controller.speedMultiplier = 1;
    this.isDead = false; this.deadTimer = 0; this.invuln = 0; this.flinch = 0;
    this.healPool = 0;
    this.clearDowned();
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.setStance('stand'); this.standUpTimer = 0;
    this.resetTactical();
    this.setAiming(false); this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.sprintBlend = 0;
    this.bodyYaw = yaw;
    this.spawned = true;
    this.controlsEnabled = true;
    this.model.resetPose();
    this.model.setFade(1);
    this.scopeHidden = false;
    this.model.setVisible(true);
    this.model.root.position.copy(this.controller.position);
    this.model.root.quaternion.setFromAxisAngle(_up, yaw);
    this.eyePos.set(0, EYE_STAND, 0);
    _v.copy(this.controller.position); _v.y += EYE_STAND;
    this.rig.snapTo(_v, yaw);
    this.interactTarget = null; this.holdProgress = 0;
    this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: 0 });
    this.ctx.bus.emit('player:spawned', { position: this.controller.position.clone() });
  }

  /** Boarded in a hub launch pod: movement locked, model hidden (remotes hide via `PlayerFlags.IN_POD`). */
  setInPod(inPod: boolean): void {
    if (inPod === this._inPod) return;
    this._inPod = inPod;
    if (inPod) { this.setAiming(false); this.controller.velocity.set(0, 0, 0); this.controller.sprinting = false; }
    if (this.spawned && !this.scopeHidden) this.model.setVisible(!inPod);
  }

  getEyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.controller.position).add(this.eyePos);
  }
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return this.rig ? this.rig.getForward(out) : out.set(0, 0, -1);
  }

  takeDamage(amount: number, from?: THREE.Vector3): void {
    this.applyDamage(amount, from, false);
  }

  /**
   * Single damage path. `dot` (burning) skips the invulnerability window, the shake / audio and the 인내 (grit)
   * save. Armor reduces the amount and wears down (tactical kit); a roll counts as a partial i-frame.
   */
  private applyDamage(amount: number, from: THREE.Vector3 | undefined, dot: boolean): void {
    if (this.isDead || !(amount > 0) || !this.spawned) return;
    if (!dot && this.invuln > 0) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return; // safe inside the pod
    if (!dot) this.invuln = INVULN_TIME;
    const bus = this.ctx.bus;
    if (this._downed) {
      // already down: damage eats the bleed-out pool instead
      const dealt = Math.min(this._downHp, amount);
      this._downHp -= dealt;
      this.ctx.stats.damageTaken += dealt;
      this.flinch = 1;
      bus.emit('player:damaged', { amount: dealt, hp: this.hp, from });
      bus.emit('player:downHpChanged', { downHp: Math.max(0, this._downHp), max: PLAYER_DOWN_HP });
      bus.emit('ui:damageIndicator', { from: from ?? this.controller.position.clone() });
      this.rig.addShake(Math.min(0.5, 0.1 + dealt / 80), 0.2);
      bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50), pitch: 0.85 });
      if (this._downHp <= 0) this.die();
      return;
    }
    let raw = amount;
    if (this.controller.rolling) raw *= ROLL_DAMAGE_MUL;
    const after = raw * (1 - this.gear.damageReduction);
    const absorbed = raw - after;
    const dealt = Math.min(this.hp, after);
    this.wearGear(absorbed);
    this.hp -= dealt;
    this.ctx.stats.damageTaken += dealt;
    bus.emit('player:damaged', { amount: dealt, hp: this.hp, from });
    bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: -dealt });
    if (!dot) {
      this.flinch = 1;
      bus.emit('ui:damageIndicator', { from: from ?? this.controller.position.clone() });
      const shake = Math.min(0.7, 0.15 + dealt / 60);
      this.rig.addShake(shake, 0.25);
      bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50) });
    }
    if (this.hp <= 0) this.onLethal(dot);
  }

  /** Armor eats `absorbed` damage and wears down accordingly (inventory owns the durability). */
  private wearGear(absorbed: number): void {
    const inv = this.ctx.inventory;
    if (!inv || absorbed <= 0 || !this.gear.armorUid) return;
    inv.damageDurability(this.gear.armorUid, absorbed * ARMOR_DURABILITY_PER_DAMAGE);
    this.gear.markDirty();
  }

  /** hp hit 0: the 인내 skill may leave 1 hp (never on a DoT tick), otherwise the player goes 전투불능. */
  private onLethal(dot: boolean): void {
    if (!dot) {
      const chance = this.ctx.progression?.derived.gritChance ?? 0;
      if (chance > 0 && Math.random() < chance) {
        this.hp = 1;
        this.ctx.bus.emit('player:gritSaved', { hp: this.hp });
        this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: 1 });
        this.ctx.bus.emit('ui:notify', { text: '인내! 버텨냈다', kind: 'warning', duration: 1.6 });
        return;
      }
    }
    this.enterDowned();
  }

  heal(amount: number): void {
    if (this.isDead || this._downed || amount <= 0) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const delta = this.hp - before;
    if (delta > 0) this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta });
  }

  /* ── dev console / unique weapons (2026-09-06) ─────────────────────────── */
  /**
   * Instant move without a hellpod (console `/move`, Home move cheat): feet to `position`, velocity / roll / grapple
   * cleared, stance / hp / items / interior untouched, no `player:spawned`. Unless `snap === false` the feet are put
   * on the ground under the target: the interior deck (`interior.getFloorAt`) in the hub, else the terrain
   * (`world.getHeightAt`). Optional `yaw` turns both the camera and the body; the camera follows immediately.
   * Works in the hub and on a mission; ignored while dead, in a pod, or inside the hellpod drop.
   */
  teleport(position: THREE.Vector3, yaw?: number, snap?: boolean): void {
    if (!this.spawned || this.isDead || this._inPod) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return;
    _v.copy(position);
    if (snap !== false) {
      if (this._interior) _v.y = this._interior.getFloorAt(_v.x, _v.z);
      else if (this.ctx.world?.ready) _v.y = this.ctx.world.getHeightAt(_v.x, _v.z);
    }
    const c = this.controller;
    const stance = c.stance;
    const wasGrounded = c.grounded;
    c.reset(_v);
    c.stance = stance;                       // reset() forces stand; keep crouch / prone (downed stays prone)
    if (snap === false) c.grounded = wasGrounded;
    this.controller.speedMultiplier = 1;
    this.standUpTimer = 0;
    this.rollBlend = 0; this.rollPhase = 0;
    this._grappling = false;
    if (yaw !== undefined) this.bodyYaw = yaw;
    const root = this.model.root;
    if (!this.attachedParent) { root.position.copy(_v); root.quaternion.setFromAxisAngle(_up, this.bodyYaw); }
    _v.y += this.eyePos.y;
    this.rig.jumpTo(_v, yaw);   // keeps pitch (and yaw unless given) — the move cheat calls this every frame
  }
  /**
   * Wide-angle camera (target FOV × SLASH_FOV_MUL, damped in and out on the rig, composed with the sprint / ADS
   * FOV logic) while true — the 용검 slash wind-up and swing. Cleared by every reset.
   */
  setViewWiden(active: boolean): void { this.rig.viewWiden = !!active; }
  /**
   * Spend stamina (the big slash costs `maxStamina × SLASH_STAMINA_RATIO`). False — and nothing spent — when short
   * or while exhausted (stamina hit 0 and has not recovered to STAMINA_SPRINT_RECOVER yet, same as sprint / roll).
   * Spending goes through the regular path (regen delay, `player:staminaDepleted` at 0).
   */
  consumeStamina(amount: number): boolean {
    if (!(amount > 0)) return true;
    if (!this.spawned || this.isDead || this._downed) return false;
    if (this.exhausted || this.stamina < amount) return false;
    this.spendStamina(amount);
    return true;
  }

  respawnAt(position: THREE.Vector3, yaw?: number): void {
    const y = yaw ?? Math.atan2(position.x, position.z); // face the map centre by default
    this.attachTo(null);
    this.setInterior(null);
    this._inPod = false;
    this.shipBounds = null;
    this.controller.shipBounds = null;
    this.controller.reset(position);
    this.hp = this.maxHp;
    this.slowTimer = 0; this.slowFactor = 1; this.controller.speedMultiplier = 1;
    this.isDead = false; this.deadTimer = 0; this.invuln = 0; this.flinch = 0;
    this.healPool = 0;
    this.clearDowned();
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.setStance('stand'); this.standUpTimer = 0;
    this.resetTactical();
    this.isAiming = false; this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.sprintBlend = 0;
    this.bodyYaw = y;
    this.spawned = true;
    this.controlsEnabled = true;
    this.model.resetPose();
    this.model.setFade(1);
    this.scopeHidden = false;
    this.model.setVisible(true);
    this.model.root.position.copy(position);
    this.model.root.quaternion.setFromAxisAngle(_up, y);
    this.eyePos.set(0, EYE_STAND, 0);
    _v.copy(position); _v.y += EYE_STAND;
    this.rig.snapTo(_v, y);
    this.rig.setOverride(null);
    this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: 0 });
    this.ctx.bus.emit('player:spawned', { position: position.clone() });
  }

  setShipInterior(bounds: ShipBounds): void {
    this.shipBounds = bounds;
    this.controller.shipBounds = bounds;
  }

  setControlsEnabled(enabled: boolean): void {
    this.controlsEnabled = enabled;
    if (!enabled) this.setAiming(false);
  }

  attachTo(parent: THREE.Object3D | null): void {
    const target = parent ?? this.ctx.scene;
    if (this.model.root.parent === target) { this.attachedParent = parent; return; }
    this.model.root.updateWorldMatrix(true, false);
    target.attach(this.model.root);
    this.attachedParent = parent;
  }

  /* ─────────────────────────── PlayerWeaponHost ─────────────────────────── */
  getWeaponSocket(): THREE.Object3D { return this.model.weaponSocket; }
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

    ctx.bus.on('world:ready', ({ playerSpawn }) => {
      if (ctx.rejoinPending) {
        // rejoin (Phase 7): the body comes back through `restoreState` (or game/'s fallback `respawn`) — no hellpod.
        // Park the hidden, control-less player at the spawn so the camera has something to frame meanwhile.
        this.holdForRestore(this.resolveSpawn(playerSpawn));
        return;
      }
      this.respawnAt(this.resolveSpawn(playerSpawn));
      this.startDrop();
    });
    ctx.bus.on('game:abort', () => this.resetAll());
    // game/GameFlowSystem: respawn countdown elapsed and the player asked for it
    ctx.bus.on('player:respawn', ({ position }) => this.respawn(position));
    // the hub tore its ship down: nothing to walk on any more (world:ready -> respawnAt clears it too)
    ctx.bus.on('hub:left', () => this.setInterior(null));
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
  }

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    const c = this.controller;
    // ride along with a parent (extraction ship)
    if (this.attachedParent) {
      this.model.root.updateWorldMatrix(true, false);
      c.position.setFromMatrixPosition(this.model.root.matrixWorld);
    }

    // movement / stances / interaction / camera run in gameplay AND hub phases (no UI blocker)
    const control = ctx.isControlActive();
    const hub = ctx.isHubPhase();
    const active = control && this.controlsEnabled && !this.isDead && this.spawned;
    const downed = this._downed;
    const locked = input.isPointerLocked;
    const dropping = this.hellpod.isActive && this.hellpod.state !== 'exiting';
    const moveFrozen = dropping || this._inPod;

    // click-to-relock fallback (also in the hub)
    if (control && !locked && input.wasMousePressed(0)) input.requestPointerLock();

    // ── gear cache (armor / bag / weight) + derived stat hooks (tactical kit)
    this.gear.update(dt, ctx);
    this.applyGearModifiers();
    // Phase 7: the worn 방탄복 shows on the body (same look remotes get from `ar`); overcharge = rim glow
    this.model.setArmor(this.gear.armor);
    this.model.setGlow(this._overcharged && !this.isDead);
    c.jumpSpeedMul = Math.sqrt(Math.max(0.1, ctx.progression?.derived.jumpHeightMul ?? 1));

    // ── timers
    if (this.invuln > 0) this.invuln -= dt;
    if (this.interactCooldown > 0) this.interactCooldown -= dt;
    if (this.standUpTimer > 0) this.standUpTimer -= dt;
    if (this.exhaustedSlow > 0) this.exhaustedSlow -= dt;
    if (this.rollCooldown > 0) this.rollCooldown -= dt;
    if (this.meleeCooldown > 0) this.meleeCooldown -= dt;
    if (this.meleeTimer > 0) this.meleeTimer = Math.max(0, this.meleeTimer - dt);
    if (this.slowTimer > 0) { this.slowTimer -= dt; if (this.slowTimer <= 0) this.slowFactor = 1; }
    let speedMul = this.slowTimer > 0 ? THREE.MathUtils.clamp(this.slowFactor, 0.1, 1) : 1;
    if (this.standUpTimer > 0) speedMul *= 0.5;
    if (this.exhaustedSlow > 0) speedMul *= EXHAUSTED_SLOW;
    if (downed) speedMul *= PLAYER_DOWN_SPEED_MUL;   // crawl: prone speed × 0.6
    speedMul *= this.speedModifierProduct();
    c.speedMultiplier = Math.max(0, speedMul);
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.poseRecoil = damp(this.poseRecoil, 0, 14, dt);

    // ── look & aim (aiming is cancelled during a roll / while downed; the quick-use wheel locks the look)
    if (active && locked && !this.lookLocked) this.rig.applyLook(input.mouseDX, input.mouseDY, this.aimBlend);
    this.setAiming(active && locked && !downed && this.weaponState.hasWeapon && !this.altFireWeapon && input.isMouseDown(MouseButtons.AIM) && !c.rolling);

    // ── movement input
    const mi = this.moveInput;
    if (active && !moveFrozen && downed) {
      // downed: crawl only — no stance changes, no jump / sprint / dive; Space held = give up
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      mi.sprint = false; mi.jump = false; mi.aiming = false;
      if (this._stance !== 'prone') this.setStance('prone');
      this.standUpTimer = 0;
    } else if (active && !moveFrozen) {
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      // jump is allowed on terrain and inside hub interiors (ceiling-clamped), not in the extraction ship box
      const wantsJump = input.wasPressed(Keys.JUMP) && (!this.shipBounds || !!this._interior);
      const wantsSprint = input.isDown(Keys.SPRINT) && mi.z > 0.2;
      this.updateStanceInput(wantsJump, wantsSprint, /* allowProne */ !hub);
      const transitioning = this.standUpTimer > 0;
      mi.sprint = input.isDown(Keys.SPRINT) && !this.exhausted && this.stamina > 0 && !transitioning && !this.gear.overloaded;
      mi.jump = wantsJump && this._stance === 'stand' && !transitioning && c.grounded && !c.rolling
        && this.stamina >= STAMINA_JUMP_COST && !this.gear.overloaded;
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
    if (!moveFrozen) {
      c.update(dt, mi, this.rig.yaw, ctx.world, this.moveResult);
    } else {
      this.moveResult.footstep = false; this.moveResult.landed = 0; this.moveResult.jumped = false;
      this.moveResult.rollEnded = false;
    }
    const r = this.moveResult;
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

    if (c.grounded) { this.autoHoverUsed = false; if (this._hovering) this.setHovering(false); }

    // ── stamina
    this.updateStamina(dt);
    // ── tactical kit: cloak, burning, armor regen
    this.updateCloak(dt, ctx);
    this.updateBurning(dt);
    this.updateArmorRegen(dt);

    // ── hellpod choreography
    if (this.hellpod.isActive) this.updateDrop(dt);

    // ── stim heal-over-time (started by `applyStim`; weapons owns the F key / quick-use wheel)
    if (this.healPool > 0 && !this.isDead && !downed) {
      const h = Math.min(this.healPool, this.healRate * dt);
      this.healPool -= h;
      this.heal(h);
    }

    // ── downed: bleed-out + give-up hold
    if (downed && !this.isDead) this.updateDowned(dt, active);

    // ── interaction (a downed player cannot interact)
    this.updateInteraction(dt, active && !downed);

    // ── death anim
    if (this.isDead) this.deadTimer += dt;

    // ── pose blends (the roll reuses the old dive plumbing: `diving` = rolling)
    const diving = c.rolling;
    this.aimBlend = damp(this.aimBlend, this.isAiming ? 1 : 0, this.adsRate, dt);
    // scoped ADS: the camera sits at the shoulder, so hide the soldier (and the held weapon) once the blend is in
    const scopeHide = this.rig.scoped && this.aimBlend > 0.85;
    if (scopeHide !== this.scopeHidden) { this.scopeHidden = scopeHide; this.model.setVisible(!scopeHide && !this._inPod); }
    this.crouchBlend = damp(this.crouchBlend, this._stance === 'crouch' && !diving ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, this._stance === 'prone' && !diving ? 1 : 0, 8, dt);
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
    const eyeTarget = diving ? EYE_ROLL : this._stance === 'prone' ? EYE_PRONE : this._stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
    this.eyePos.y = damp(this.eyePos.y, eyeTarget, 10, dt);

    // body faces aim when aiming/firing/reloading/throwing/meleeing or prone, the roll direction while rolling, else movement
    const faceCamera = this.isAiming || this.weaponState.firing || this.weaponState.reloading || this.weaponState.throwing
      || this._stance === 'prone' || this.meleeTimer > 0;
    if (!this.isDead) {
      if (diving) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.rollDir.x, -c.rollDir.z), 20, dt);
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
    p.airborne = damp(p.airborne, c.grounded || diving ? 0 : 1, 12, dt);
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
    p.downed = 0;   // 전투불능 keeps the Phase 2 prone crawl
    p.dead = this.isDead ? Math.min(1, this.deadTimer / DEATH_ANIM) : 0;
    this.model.update(dt, ctx.time, p);

    // ── write model transform (world → parent local when attached)
    const root = this.model.root;
    if (this.attachedParent) {
      root.position.copy(c.position);
      this.attachedParent.worldToLocal(root.position);
      this.attachedParent.getWorldQuaternion(_q).invert();
      root.quaternion.setFromAxisAngle(_up, this.bodyYaw).premultiply(_q);
    } else {
      root.position.copy(c.position);
      root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    }
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    const ri = this.rigInput;
    ri.pivot.copy(this.controller.position).add(this.eyePos);
    if (this.isDead) ri.pivot.y = this.controller.position.y + 0.9;
    ri.aim = this.aimBlend;
    ri.sprint = this.sprintBlend;
    ri.crouch = this.crouchBlend;
    ri.prone = this.proneBlend;
    ri.dive = this.rollBlend;   // same camera treatment as the old dive (pull back a little)
    ri.moveBlend = Math.min(1, this.controller.speed / PLAYER_WALK_SPEED);
    ri.stridePhase = this.controller.stridePhase;
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
    let alpha = this.spawned && !this.scopeHidden ? smoothstep(FADE_NEAR, FADE_FAR, this.rig.pivotDistance) : 1;
    // cloaked: the local player sees himself shimmer too (remotes get the same treatment in RemoteAvatar)
    if (this._cloaked && !this.isDead) alpha = Math.min(alpha, CLOAK_FADE);
    this.model.setFade(alpha);
    // ── occlusion silhouette (black where the world hides the body); off while dead / dropping / in a pod / faded
    this.model.setSilhouette(this.spawned && !this.isDead && !this.hellpod.isActive && !this._inPod && !this.scopeHidden);
  }

  dispose(): void {
    this.model.dispose();
    this.hellpod.dispose();
  }

  /* ─────────────────────────── internals ─────────────────────────── */
  private setAiming(aiming: boolean): void {
    if (aiming === this.isAiming) return;
    this.isAiming = aiming;
    this.ctx.bus.emit('player:aimChanged', { aiming });
  }

  private setStance(stance: Stance): void {
    const prev = this._stance;
    if (stance === prev) return;
    this._stance = stance;
    if (prev === 'prone') this.standUpTimer = STAND_UP_TIME;
    if (this.ctx) this.ctx.bus.emit('player:stanceChanged', { stance, prev });
  }

  /**
   * C toggles stand↔crouch (prone → crouch). Z toggles prone (prone → stand).
   * Sprint (with forward input) or jump while crouched stands up; from prone they only stand up
   * (0.35 s transition, the jump itself is denied by the caller). Nothing changes while airborne,
   * diving or mid-transition.
   */
  private updateStanceInput(wantsJump: boolean, wantsSprint: boolean, allowProne: boolean): void {
    const c = this.controller, input = this.ctx.input;
    if (!c.grounded || c.rolling || this.standUpTimer > 0) return;
    if (input.wasPressed(Keys.CROUCH)) {
      this.setStance(this._stance === 'crouch' ? 'stand' : 'crouch');
    } else if (input.wasPressed(Keys.PRONE) && (allowProne || this._stance === 'prone')) {
      this.setStance(this._stance === 'prone' ? 'stand' : 'prone');
    } else if (this._stance !== 'stand' && (wantsJump || wantsSprint)) {
      this.setStance('stand');
    }
  }

  private spendStamina(cost: number): void {
    this.stamina = Math.max(0, this.stamina - cost);
    this.regenDelay = STAMINA_REGEN_DELAY;
    if (this.stamina <= 0) this.onStaminaDepleted();
  }

  private onStaminaDepleted(): void {
    if (this.exhausted) return;
    this.exhausted = true;
    this.exhaustedSlow = EXHAUSTED_SLOW_TIME;
    this.ctx.bus.emit('player:staminaDepleted', {});
  }

  /**
   * Regen is scaled by 지구력 (`derived.staminaRegenMul`), the carry weight (`WeightInfo.staminaRegenMul`,
   * softened by the 운반 skill inside inventory) and the ultralight-armor perk. Hovering burns stamina.
   */
  private updateStamina(dt: number): void {
    const c = this.controller;
    const max = this.maxStamina;
    if (this.stamina > max) this.stamina = max;
    if (this._hovering && !c.grounded && !this.isDead) {
      this.stamina = Math.max(0, this.stamina - HOVER_STAMINA_DRAIN * dt);
      this.regenDelay = STAMINA_REGEN_DELAY;
      if (this.stamina <= 0) { this.onStaminaDepleted(); this.setHovering(false); }
      return;
    }
    if (c.sprinting && !this.isDead) {
      this.stamina -= STAMINA_SPRINT_DRAIN * dt;
      this.regenDelay = STAMINA_REGEN_DELAY;
      if (this.stamina <= 0) { this.stamina = 0; this.onStaminaDepleted(); }
    } else if (this.regenDelay > 0) {
      this.regenDelay -= dt;
    } else if (this.stamina < max) {
      let rate = c.speed < 0.3 && !c.rolling ? STAMINA_REGEN_IDLE : STAMINA_REGEN_MOVING;
      rate *= this.ctx.progression?.derived.staminaRegenMul ?? 1;
      rate *= this.gear.weight.staminaRegenMul;
      rate *= 1 + this.gear.ultralightBonus;
      this.stamina = Math.min(max, this.stamina + Math.max(0, rate) * dt);
    }
    if (this.exhausted && this.stamina >= STAMINA_SPRINT_RECOVER) this.exhausted = false;
  }

  /** hp reached 0: 전투불능 instead of death — prone crawl, weapons off, `downHp` starts bleeding. */
  private enterDowned(): void {
    if (this._downed || this.isDead) return;
    this._downed = true;
    this._downHp = PLAYER_DOWN_HP;
    this.bleedAcc = 0; this.giveUpHold = 0;
    this.hp = 0;
    this.healPool = 0;
    this.setAiming(false);
    this.setHovering(false);
    this.controller.cancelRoll();
    this.setGrappleTarget(null);
    this.meleeTimer = 0;
    this.controller.sprinting = false;
    this.setStance('prone'); this.standUpTimer = 0;
    this.rig.addShake(0.7, 0.5);
    const bus = this.ctx.bus;
    bus.emit('player:downed', { position: this.controller.position.clone() });
    bus.emit('player:downHpChanged', { downHp: this._downHp, max: PLAYER_DOWN_HP });
    bus.emit('player:healthChanged', { hp: 0, maxHp: this.maxHp, delta: 0 });
    bus.emit('audio:play', { id: 'player_hurt', volume: 1, pitch: 0.6 });
  }

  /** Bleed PLAYER_DOWN_BLEED_PER_SEC (whole points → `player:downHpChanged`), Space held PLAYER_GIVE_UP_HOLD → die. */
  private updateDowned(dt: number, active: boolean): void {
    this.bleedAcc += PLAYER_DOWN_BLEED_PER_SEC * dt;
    const whole = Math.floor(this.bleedAcc);
    if (whole >= 1) {
      this.bleedAcc -= whole;
      this._downHp = Math.max(0, this._downHp - whole);
      this.ctx.bus.emit('player:downHpChanged', { downHp: this._downHp, max: PLAYER_DOWN_HP });
      if (this._downHp <= 0) { this.die(); return; }
    }
    if (active && this.ctx.input.isDown(Keys.GIVE_UP)) {
      this.giveUpHold += dt;
      if (this.giveUpHold >= PLAYER_GIVE_UP_HOLD) { this.giveUpHold = 0; this.die(); }
    } else {
      this.giveUpHold = 0;
    }
  }

  private clearDowned(): void {
    this._downed = false;
    this._downHp = 0;
    this.bleedAcc = 0;
    this.giveUpHold = 0;
  }

  private die(): void {
    if (this.isDead) return;
    this.isDead = true;
    this.deadTimer = 0;
    this.healPool = 0;
    this.clearDowned();
    this.setAiming(false);
    this.setHovering(false);
    this.controller.cancelRoll();
    this.setGrappleTarget(null);
    this.meleeTimer = 0;
    this.controlsEnabled = false;
    this.cancelHold();
    this.rig.addShake(0.8, 0.5);
    this.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
    this.ctx.bus.emit('player:died', { position: this.controller.position.clone() });
  }

  /* ─────────────────────── tactical kit internals ─────────────────────── */
  /**
   * Clear every tactical-kit state (roll, melee, cloak, burning, grapple, hover, buffs).
   * Called from `respawnAt`, `spawnStanding` and the `game:abort` reset. The gear cache is only marked dirty —
   * armor survives a respawn.
   */
  private resetTactical(): void {
    this.controller.cancelRoll();
    this.controller.grappleTarget = null; this._grappling = false;
    this.controller.hovering = false;
    this.rollBlend = 0; this.rollPhase = 0; this.rollCooldown = 0;
    this.meleeTimer = 0; this.meleeCooldown = 0; this.meleeKind = 'light'; this.meleeDuration = MELEE_SWING_TIME;
    this.chargeBlend = 0; this.sprayBlend = 0; this.heavyBlend = 0;
    this.weaponState.charging = false; this.weaponState.spraying = false; this.weaponState.heavy = false;
    if (this.rig) this.rig.viewWiden = false;
    this.cloakTimer = 0; this.cloakBreak = 0; this.cloakProbe = 0; this.cloakNearEnemy = false;
    this.cloakSource = null;
    if (this._cloaked) { this._cloaked = false; this.ctx?.bus.emit('player:cloakChanged', { cloaked: false, source: null }); }
    this.speedMods.clear();
    this._overcharged = false;
    this._hovering = false; this.hoverBlend = 0; this.autoHoverUsed = false;
    if (this._burning) { this._burning = false; this.ctx?.bus.emit('player:burning', { active: false, dps: 0 }); }
    this.burnDps = 0; this.burnTimer = 0; this.burnTick = 0;
    this.regenAccum = 0;
    this.gear.markDirty();
  }

  /** Common precondition for roll / melee. */
  private canAct(): boolean {
    return this.spawned && this.controlsEnabled && !this.isDead && !this._downed && !this._inPod
      && this.ctx.isControlActive()
      && !(this.hellpod.isActive && this.hellpod.state !== 'exiting');
  }

  /** Camera-relative horizontal direction of the current movement input (zero vector when idle). */
  private wishDirection(out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.rig ? this.rig.yaw : 0;
    const mi = this.moveInput;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    out.set(fx * mi.z + rx * mi.x, 0, fz * mi.z + rz * mi.x);
    if (out.lengthSq() > 1e-6) out.normalize();
    return out;
  }

  /** Product of the live speed-modifier stack; also refreshes `isOvercharged`. */
  private speedModifierProduct(): number {
    const now = this.ctx.time;
    let mul = 1;
    let over = false;
    for (const [key, mod] of this.speedMods) {
      if (mod.until <= now) { this.speedMods.delete(key); continue; }
      mul *= mod.mul;
      if (key.startsWith('overcharge')) over = true;
    }
    this._overcharged = over;
    return mul;
  }

  /** Weight state and the ultralight-armor perk feed the same stack as external buffs. */
  private applyGearModifiers(): void {
    const w = this.gear.weight;
    if (w.moveMul >= 0.999) this.speedMods.delete(SPEEDMOD_WEIGHT);
    else this.speedMods.set(SPEEDMOD_WEIGHT, { mul: Math.max(0, w.moveMul), until: Infinity });
    const bonus = this.gear.ultralightBonus;
    if (bonus <= 0) this.speedMods.delete(SPEEDMOD_ARMOR);
    else this.speedMods.set(SPEEDMOD_ARMOR, { mul: 1 + bonus, until: Infinity });
    // 광학미채 방탄복: permanent cloak while it is worn and intact
    if (this.gear.opticalCamo) this.setCloak(Infinity, 'armor');
    else if (this.cloakSource === 'armor' && this.cloakTimer === Infinity) { this.cloakTimer = 0; this.cloakSource = null; }
  }

  /**
   * Cloak upkeep: firing, sprinting, rolling, meleeing or an enemy inside CLOAK_REVEAL_DISTANCE reveal the player
   * for CLOAK_BREAK_TIME; once the cause is gone (and the distance opened again) the cloak comes back.
   */
  private updateCloak(dt: number, ctx: GameContext): void {
    if (this.cloakTimer > 0 && this.cloakTimer !== Infinity) this.cloakTimer = Math.max(0, this.cloakTimer - dt);
    if (this.cloakTimer <= 0) {
      this.cloakBreak = 0;
      this.cloakNearEnemy = false;
      if (this.cloakSource !== null) this.cloakSource = null;
    } else {
      this.cloakProbe -= dt;
      if (this.cloakProbe <= 0) {
        this.cloakProbe = CLOAK_PROBE_INTERVAL;
        this.cloakNearEnemy = this.enemyWithin(ctx, CLOAK_REVEAL_DISTANCE);
      }
      const reveal = this.weaponState.firing || this.controller.sprinting || this.controller.rolling
        || this.meleeTimer > 0 || this.cloakNearEnemy;
      if (reveal) this.cloakBreak = CLOAK_BREAK_TIME;
      else if (this.cloakBreak > 0) this.cloakBreak = Math.max(0, this.cloakBreak - dt);
    }
    const cloaked = this.cloakTimer > 0 && this.cloakBreak <= 0 && !this.isDead;
    if (cloaked !== this._cloaked) {
      this._cloaked = cloaked;
      ctx.bus.emit('player:cloakChanged', { cloaked, source: cloaked ? this.cloakSource : null });
    }
  }

  /** Any alive enemy within `radius`. */
  private enemyWithin(ctx: GameContext, radius: number): boolean {
    const em = ctx.enemies;
    if (!em) return false;
    return em.queryNear(this.controller.position, radius).length > 0;
  }

  /** Burning DoT (incendiary / fire zone). Applied in BURN_TICK chunks; never triggers the 인내 save. */
  private updateBurning(dt: number): void {
    if (!this._burning) return;
    this.burnTimer -= dt;
    this.burnTick -= dt;
    if (this.burnTick <= 0) {
      this.burnTick = BURN_TICK;
      this.applyDamage(this.burnDps * BURN_TICK, undefined, true);
    }
    if (this.burnTimer <= 0) {
      this._burning = false; this.burnDps = 0; this.burnTimer = 0;
      this.ctx.bus.emit('player:burning', { active: false, dps: 0 });
    }
  }

  /** 재생 방탄복: 1 hp/s (perkValue) while stamina is full. Healed in whole points to avoid event spam. */
  private updateArmorRegen(dt: number): void {
    const rate = this.gear.regenPerSecond;
    if (rate <= 0 || this.isDead || this._downed || this.hp >= this.maxHp) { this.regenAccum = 0; return; }
    if (this.stamina < this.maxStamina - 0.5) { this.regenAccum = 0; return; }
    this.regenAccum += rate * dt;
    if (this.regenAccum >= 1) {
      const whole = Math.floor(this.regenAccum);
      this.regenAccum -= whole;
      this.heal(whole);
    }
  }

  /** Tactical bag: hold Space in the air to hover, plus one automatic hover before a fatal fall (낙사 방지). */
  private updateBagFlight(): void {
    const c = this.controller;
    if (c.grounded || !this.gear.tacticalBag) return;
    const hold = this.ctx.input.isDown(Keys.JUMP) && this.stamina > 0;
    if (!this.autoHoverUsed && c.velocity.y < HOVER_AUTO_FALL && this.stamina > 0) {
      this.autoHoverUsed = true;
      this.setHovering(true);
    } else if (hold !== this._hovering) {
      this.setHovering(hold);
    }
  }

  /** Tell a hold interactable that its running hold was released / retargeted before completion. */
  private cancelHold(): void {
    const t = this.interactTarget;
    if (t && this.holdProgress > 0 && t.onHoldCancel) {
      try { t.onHoldCancel(); } catch (e) { console.error('[Player] onHoldCancel threw', e); }
    }
    this.holdProgress = 0;
  }

  private updateInteraction(dt: number, active: boolean): void {
    const ctx = this.ctx, input = ctx.input;
    let target: Interactable | null = null;
    if (active && this.interactCooldown <= 0) {
      this.rig.getForward(_v);
      target = ctx.interactables.findBest(this.controller.position, _v);
    }
    if (target !== this.interactTarget) { this.cancelHold(); this.interactTarget = target; }
    if (!input.isDown(Keys.INTERACT)) this.holdArmed = true;
    let text: string | null = null;
    if (target) {
      text = target.getPrompt();
      // 재주 (Phase 5): every hold interaction runs `derived.interactSpeedMul` times faster — applied here once, so
      // interactables publish their base `holdTime` and never scale it themselves.
      const hold = (target.holdTime ?? 0) / Math.max(0.25, ctx.progression?.derived.interactSpeedMul ?? 1);
      if (hold > 0) {
        if (input.isDown(Keys.INTERACT) && this.holdArmed) {
          this.holdProgress += dt / hold;
          if (this.holdProgress >= 1) {
            this.holdArmed = false;
            this.perform(target); this.holdProgress = 0; target = null; text = null;
          } else if (target.onHoldProgress) {
            try { target.onHoldProgress(this.holdProgress); } catch (e) { console.error('[Player] onHoldProgress threw', e); }
          }
        } else if (this.holdProgress > 0) {
          // released early: the hold decays; a relay-style interactable (revive) is told once
          this.cancelHold();
        }
      } else if (input.wasPressed(Keys.INTERACT)) {
        this.perform(target); target = null; text = null;
      }
    } else {
      this.holdProgress = 0;
    }
    if (text !== this.lastPromptText || this.holdProgress !== this.lastHoldProgress) {
      this.lastPromptText = text; this.lastHoldProgress = this.holdProgress;
      ctx.bus.emit('interact:promptChanged', { text, holdProgress: this.holdProgress });
    }
  }

  private perform(target: Interactable): void {
    this.interactCooldown = 0.35;
    this.interactTarget = null;
    try { target.interact(); } catch (e) { console.error('[Player] interact threw', e); }
    this.ctx.bus.emit('interact:performed', { id: target.id });
    this.ctx.bus.emit('audio:play', { id: 'interact', position: target.position, volume: 0.7 });
  }

  /**
   * Multiplayer: every client drops on its own pad around the shared spawn — a ring of radius
   * SPAWN_RING_RADIUS, one slot per quadrant (slot × 90° + 45°), snapped to the terrain and pushed
   * out of obstacles. Single-player uses the world spawn untouched.
   */
  private resolveSpawn(playerSpawn: THREE.Vector3): THREE.Vector3 {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return playerSpawn;
    const slot = ctx.net.localSlot;
    const angle = slot * (Math.PI / 2) + Math.PI / 4;
    const out = _spawn;
    out.set(playerSpawn.x + Math.cos(angle) * SPAWN_RING_RADIUS, playerSpawn.y, playerSpawn.z + Math.sin(angle) * SPAWN_RING_RADIUS);
    const world = ctx.world;
    if (world && world.ready) {
      out.y = world.getHeightAt(out.x, out.z);
      world.resolveCollision(out, PLAYER_RADIUS);
      out.y = world.getHeightAt(out.x, out.z);
    }
    return out;
  }

  /** Rejoin wait: everything reset like `game:abort`, feet + camera parked at `position`, model hidden, no controls. */
  private holdForRestore(position: THREE.Vector3): void {
    this.resetAll();
    this.setInterior(null);
    this.controller.reset(position);
    this.bodyYaw = Math.atan2(position.x, position.z);
    this.model.root.position.copy(position);
    this.model.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    this.eyePos.set(0, EYE_STAND, 0);
    _v.copy(position); _v.y += EYE_STAND;
    this.rig.snapTo(_v, this.bodyYaw);
  }

  private startDrop(): void {
    const pos = this.controller.position;
    this.controlsEnabled = false;
    this.model.setVisible(false);
    this.hellpod.start(pos, this.bodyYaw);
    if (this.hellpod.getCameraPose(_camPos, _camLook)) this.rig.setOverride(_camPos, _camLook, true);
    this.ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: pos, volume: 1 });
  }

  private updateDrop(dt: number): void {
    const ev = this.podEvents;
    this.hellpod.update(dt, ev);
    if (ev.impact) {
      this.model.setVisible(!this._inPod);
      this.rig.addShake(1.0, 0.7);
      this.ctx.bus.emit('player:landed', { impactSpeed: this.hellpod.impactSpeed });
      this.ctx.bus.emit('camera:shake', { intensity: 0.4, duration: 0.5 });
      this.ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: this.controller.position, volume: 1 });
    }
    if (ev.opened) {
      this.controlsEnabled = true;
      this.rig.setOverride(null);
      this.ctx.bus.emit('audio:play', { id: 'hellpod_open', position: this.controller.position, volume: 0.9 });
    }
    if (this.hellpod.state === 'opening' && this.hellpod.exitProgress === 0) {
      // release the cutscene camera as soon as the doors start moving
      this.rig.setOverride(null);
    }
  }

  private resetAll(): void {
    this.hellpod.hide();
    this.attachTo(null);
    this.shipBounds = null; this.controller.shipBounds = null;
    // `interior` is deliberately kept: the hub may have set it before aborting the mission; respawnAt / hub:left clear it
    this._inPod = false;
    this.model.setSilhouette(false);
    this.model.setFade(1);
    this.scopeHidden = false;
    this.model.setVisible(false);
    this.model.resetPose();
    this.spawned = false;
    this.controlsEnabled = false;
    this.isDead = false; this.deadTimer = 0;
    this.healPool = 0;
    this.clearDowned();
    this.lookLocked = false;
    this.weaponState.throwing = false; this.weaponState.holdingItem = false; this.weaponState.cooking = false;
    this.throwBlend = 0; this.holdItemBlend = 0; this.cookBlend = 0;
    this.setAiming(false);
    this.setStance('stand'); this.standUpTimer = 0;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.resetTactical();
    this.crouchBlend = 0; this.proneBlend = 0;
    this.cancelHold(); this.interactTarget = null;
    if (this.lastPromptText !== null) { this.lastPromptText = null; this.lastHoldProgress = 0; this.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
    this.rig.setOverride(null);
  }
}
