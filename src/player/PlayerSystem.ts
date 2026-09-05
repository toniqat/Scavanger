import * as THREE from 'three';
import {
  ARMOR_DURABILITY_PER_DAMAGE, BACKPACK_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL,
  CLOAK_REVEAL_DISTANCE, DOWNED_BLEEDOUT, GameContext, Keys, MELEE_COOLDOWN, MELEE_STAMINA_COST, MouseButtons,
  PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED, ROLL_COOLDOWN, ROLL_DAMAGE_MUL,
  ROLL_DURATION, ROLL_STAMINA_COST,
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
const INVULN_TIME = 0.15;
const STIM_DURATION = 1.5;
const DEATH_ANIM = 0.9;

/* ── tactical kit tuning (local; the shared numbers live in shared/constants) ── */
/** Melee swing animation length; must stay below MELEE_COOLDOWN. */
const MELEE_SWING_TIME = 0.45;
/** Cloaked players are drawn semi-transparent for themselves too (remotes use the same value). */
const CLOAK_FADE = 0.4;
/** How often the cloak checks for enemies inside CLOAK_REVEAL_DISTANCE (seconds). */
const CLOAK_PROBE_INTERVAL = 0.25;
/** Burning DoT is applied in ticks so the HUD is not spammed 60×/s. */
const BURN_TICK = 0.5;
/** Stamina drained per second while the tactical backpack hovers. */
const HOVER_STAMINA_DRAIN = 10;
/** Fall speed (m/s, negative) that auto-triggers the tactical backpack's one free hover (낙사 방지). */
const HOVER_AUTO_FALL = -18;
/** Jump backpack: forward / upward burst of the mid-air re-jump. */
const JUMPPACK_FORWARD = 12;
const JUMPPACK_UP = 3.2;
const JUMPPACK_COOLDOWN = 12;
/** Fraction of max stamina the jump backpack burst costs. */
const JUMPPACK_STAMINA_FRAC = 0.5;
/** Seconds of bleedout burnt per point of damage taken while downed. */
const DOWNED_DAMAGE_BLEED = 0.12;
/** Speed-modifier keys the player owns itself (external callers must not reuse them). */
const SPEEDMOD_WEIGHT = 'weight';
const SPEEDMOD_ARMOR = 'armor';

// stamina tuning
const STAMINA_SPRINT_DRAIN = 14;     // per second
const STAMINA_JUMP_COST = 12;
const STAMINA_REGEN_DELAY = 0.8;
const STAMINA_REGEN_MOVING = 16;     // per second
const STAMINA_REGEN_IDLE = 22;
const STAMINA_SPRINT_RECOVER = 20;   // sprint unavailable after depletion until this much
const EXHAUSTED_SLOW_TIME = 1.0;
const EXHAUSTED_SLOW = 0.9;
const STAND_UP_TIME = 0.35;          // prone → stand/crouch transition (no jump/sprint/dive)
const SPAWN_RING_RADIUS = 4;         // multiplayer: per-slot drop offset around the shared spawn (m)
// near-clip body fade: fully visible beyond FADE_FAR m camera->pivot, hidden inside FADE_NEAR
const FADE_FAR = 0.9;
const FADE_NEAR = 0.45;

const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();
const _dir = new THREE.Vector3(), _imp = new THREE.Vector3();

interface WeaponState { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean }

/** One entry of the multiplicative speed-modifier stack (`setSpeedModifier`). */
interface SpeedMod { mul: number; until: number }

/**
 * Third-person player: controller + camera rig + procedural soldier + health/stims + stamina +
 * stances (C crouch / Z prone / Alt dive) + interaction + hellpod drop.
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
  private fallbackStims = 3;

  // stamina (max comes from 지구력 via progression; PLAYER_MAX_STAMINA is the fallback)
  stamina = PLAYER_MAX_STAMINA;
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
  private _isDowned = false;
  private bleedout = 0;
  private downedBlend = 0;
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
  private jumpPackCooldown = 0;
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
  private scopeHidden = false;
  private crouchBlend = 0;
  private proneBlend = 0;
  private sprintBlend = 0;
  private bodyYaw = 0;
  private poseRecoil = 0;
  private weaponState: WeaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false };
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

  // scratch
  private readonly moveInput: MoveInput = { x: 0, z: 0, sprint: false, jump: false, stance: 'stand', aiming: false };
  private readonly moveResult: MoveResult = { footstep: false, landed: 0, jumped: false, rollEnded: false };
  private readonly podEvents: HellpodEvents = { impact: false, opened: false, finished: false };
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, dive: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
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
  /** Wire compatibility: the roll replaced the dive, so `isDiving` mirrors `isRolling`. */
  get isDiving(): boolean { return this.controller.rolling; }
  get maxStamina(): number { return this.ctx?.progression?.derived.maxStamina ?? PLAYER_MAX_STAMINA; }
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

  /* ── tactical kit (appended contract) ── */
  get isRolling(): boolean { return this.controller.rolling; }
  get isMeleeing(): boolean { return this.meleeTimer > 0; }
  get isDowned(): boolean { return this._isDowned; }
  get bleedoutRemaining(): number { return this._isDowned ? Math.max(0, this.bleedout) : 0; }
  get isCloaked(): boolean { return this._cloaked; }
  get isHovering(): boolean { return this._hovering; }
  get isOvercharged(): boolean { return this._overcharged; }
  get damageReduction(): number { return this.gear.damageReduction; }
  get isBurning(): boolean { return this._burning; }

  /**
   * Roll (Alt) in `direction` — defaults to the current movement input, else camera forward. Costs
   * ROLL_STAMINA_COST, has a ROLL_COOLDOWN, is denied while airborne / rolling / downed / in a pod, inside the
   * extraction ship box and from '무거움' (90 %) upward. Emits `player:rolled`.
   */
  roll(direction?: THREE.Vector3): boolean {
    const c = this.controller;
    if (!this.canAct() || !c.grounded || c.rolling) return false;
    if (this.rollCooldown > 0) return false;
    if (this.shipBounds && !this._interior) return false;
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
    this.ctx.bus.emit('player:rolled', { position: c.position.clone(), direction: _dir.clone() });
    this.ctx.bus.emit('audio:play', { id: 'roll', position: c.position, volume: 0.7 });
    const fx = FxManager.get();
    if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 4, 0.6);
    return true;
  }

  /**
   * Start a melee swing (F). Costs MELEE_STAMINA_COST and locks out for MELEE_COOLDOWN; the pose plays for
   * MELEE_SWING_TIME. WeaponSystem owns the key binding, the hit resolution and `melee:swing` / `melee:hit`.
   */
  startMelee(): boolean {
    if (!this.canAct() || this.controller.rolling) return false;
    if (this.meleeTimer > 0 || this.meleeCooldown > 0) return false;
    if (this.stamina < MELEE_STAMINA_COST) {
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
      return false;
    }
    this.spendStamina(MELEE_STAMINA_COST);
    this.meleeTimer = MELEE_SWING_TIME;
    this.meleeCooldown = MELEE_COOLDOWN;
    return true;
  }

  /** Revive from downed at full hp (defibrillator). No-op when not downed. */
  revive(by?: string): void {
    if (!this._isDowned) return;
    this._isDowned = false;
    this.bleedout = 0;
    this.hp = this.maxHp;
    this.stamina = Math.max(this.stamina, this.maxStamina * 0.5);
    this.invuln = Math.max(this.invuln, 1.0);
    this.setStance('stand');
    this.controlsEnabled = true;
    this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: this.hp });
    this.ctx.bus.emit('player:revived', { by: by ?? null, hp: this.hp });
    this.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.9 });
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

  /** Tactical backpack hover: slows the fall while held (also auto-engaged once to prevent a fatal fall). */
  setHovering(hovering: boolean): void {
    const want = hovering && !this.isDead && !this._isDowned && !this.controller.grounded;
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
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.resetTactical();
    this.setStance('stand'); this.standUpTimer = 0;
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
   * Single damage path. `dot` (burning / poison) skips the invulnerability window, the shake/audio and — per the
   * spec — the 인내 (grit) save. Armor reduces the amount and wears down, the backpack wears from what got through,
   * and a roll counts as a partial i-frame (ROLL_DAMAGE_MUL).
   */
  private applyDamage(amount: number, from: THREE.Vector3 | undefined, dot: boolean): void {
    if (this.isDead || !(amount > 0) || !this.spawned) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return; // safe inside the pod
    if (this._isDowned) {
      // already bleeding out: further hits only shorten the timer
      this.bleedout = Math.max(0, this.bleedout - amount * DOWNED_DAMAGE_BLEED);
      return;
    }
    if (!dot) {
      if (this.invuln > 0) return;
      this.invuln = INVULN_TIME;
    }
    let raw = amount;
    if (this.controller.rolling) raw *= ROLL_DAMAGE_MUL;
    const dr = this.gear.damageReduction;
    const after = raw * (1 - dr);
    const absorbed = raw - after;
    const dealt = Math.min(this.hp, after);
    this.wearGear(absorbed, dealt);
    this.hp -= dealt;
    this.ctx.stats.damageTaken += dealt;
    const bus = this.ctx.bus;
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

  /** Armor eats `absorbed` damage, the backpack takes wear from whatever reached the body. */
  private wearGear(absorbed: number, dealt: number): void {
    const inv = this.ctx.inventory;
    if (!inv || typeof inv.damageDurability !== 'function') return;
    const gear = this.gear;
    if (gear.armorUid && absorbed > 0) {
      inv.damageDurability(gear.armorUid, absorbed * ARMOR_DURABILITY_PER_DAMAGE);
      gear.markDirty();
    }
    if (gear.backpackUid && dealt > 0) {
      inv.damageDurability(gear.backpackUid, dealt * BACKPACK_DURABILITY_PER_DAMAGE);
      gear.markDirty();
    }
  }

  /**
   * hp hit 0: the 인내 skill may leave 1 hp (never on a DoT tick), otherwise multiplayer players go **downed**
   * (revivable for DOWNED_BLEEDOUT seconds) while single-player dies outright, as before.
   */
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
    if (this.ctx.isMultiplayer && !this._isDowned) { this.enterDowned(); return; }
    this.die();
  }

  private enterDowned(): void {
    this._isDowned = true;
    this.hp = 0;
    this.bleedout = DOWNED_BLEEDOUT;
    this.healPool = 0;
    this.setAiming(false);
    this.setHovering(false);
    this.controller.cancelRoll();
    this.controller.grappleTarget = null; this._grappling = false;
    this.meleeTimer = 0;
    this.controller.velocity.set(0, 0, 0);
    this.controller.sprinting = false;
    this.setStance('prone');
    this.rig.addShake(0.5, 0.4);
    this.ctx.bus.emit('player:downed', { position: this.controller.position.clone(), bleedout: DOWNED_BLEEDOUT });
    this.ctx.bus.emit('audio:play', { id: 'player_hurt', volume: 1 });
  }

  heal(amount: number): void {
    // a downed player is not healed back up — only `revive()` (defibrillator) brings them back
    if (this.isDead || this._isDowned || amount <= 0) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const delta = this.hp - before;
    if (delta > 0) this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta });
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
    this.healPool = 0; this.fallbackStims = 3;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.resetTactical();
    this.setStance('stand'); this.standUpTimer = 0;
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
    return this.spawned && this.controlsEnabled && !this.isDead && !this.controller.rolling
      && !this._isDowned && !this._inPod
      && !(this.hellpod.isActive && this.hellpod.state !== 'exiting');
  }
  setWeaponState(state: WeaponState): void {
    this.weaponState.hasWeapon = state.hasWeapon;
    this.weaponState.reloading = state.reloading;
    this.weaponState.firing = state.firing;
    this.weaponState.twoHanded = state.twoHanded;
    if (!state.hasWeapon) this.setAiming(false);
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
      this.respawnAt(this.resolveSpawn(playerSpawn));
      this.startDrop();
    });
    ctx.bus.on('game:abort', () => this.resetAll());
    // the hub tore its ship down: nothing to walk on any more (world:ready -> respawnAt clears it too)
    ctx.bus.on('hub:left', () => this.setInterior(null));
    ctx.bus.on('camera:shake', ({ intensity, duration }) => this.rig.addShake(intensity, duration));
    ctx.bus.on('player:applySlow', ({ duration, factor }) => {
      // strongest slow wins; refresh the timer
      this.slowFactor = this.slowTimer > 0 ? Math.min(this.slowFactor, factor) : factor;
      this.slowTimer = Math.max(this.slowTimer, duration);
    });
    // ── gear (armor / backpack / weight): re-read the inventory whenever it changed
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
    const locked = input.isPointerLocked;
    const dropping = this.hellpod.isActive && this.hellpod.state !== 'exiting';
    // downed players keep ticking the controller (gravity / ground contact) but get no input
    const moveFrozen = dropping || this._inPod;

    // click-to-relock fallback (also in the hub)
    if (control && !locked && input.wasMousePressed(0)) input.requestPointerLock();

    // ── gear cache (armor / backpack / weight) + derived stat hooks
    this.gear.update(dt, ctx);
    this.applyGearModifiers();
    c.jumpSpeedMul = Math.sqrt(Math.max(0.1, ctx.progression?.derived.jumpHeightMul ?? 1));

    // ── timers
    if (this.invuln > 0) this.invuln -= dt;
    if (this.interactCooldown > 0) this.interactCooldown -= dt;
    if (this.standUpTimer > 0) this.standUpTimer -= dt;
    if (this.exhaustedSlow > 0) this.exhaustedSlow -= dt;
    if (this.rollCooldown > 0) this.rollCooldown -= dt;
    if (this.meleeCooldown > 0) this.meleeCooldown -= dt;
    if (this.meleeTimer > 0) this.meleeTimer = Math.max(0, this.meleeTimer - dt);
    if (this.jumpPackCooldown > 0) this.jumpPackCooldown -= dt;
    if (this.slowTimer > 0) { this.slowTimer -= dt; if (this.slowTimer <= 0) this.slowFactor = 1; }
    let speedMul = this.slowTimer > 0 ? THREE.MathUtils.clamp(this.slowFactor, 0.1, 1) : 1;
    if (this.standUpTimer > 0) speedMul *= 0.5;
    if (this.exhaustedSlow > 0) speedMul *= EXHAUSTED_SLOW;
    speedMul *= this.speedModifierProduct();
    c.speedMultiplier = Math.max(0, speedMul);
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.poseRecoil = damp(this.poseRecoil, 0, 14, dt);
    // ── downed bleedout
    if (this._isDowned) {
      this.bleedout -= dt;
      if (this.bleedout <= 0) { this._isDowned = false; this.bleedout = 0; this.die(); }
    }

    // ── look & aim (aiming is cancelled during a roll / while downed)
    if (active && locked) this.rig.applyLook(input.mouseDX, input.mouseDY, this.aimBlend);
    this.setAiming(active && locked && this.weaponState.hasWeapon && input.isMouseDown(MouseButtons.AIM)
      && !c.rolling && !this._isDowned);

    // ── movement input
    const mi = this.moveInput;
    if (active && !moveFrozen && !this._isDowned) {
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      // jump is allowed on terrain and inside hub interiors (ceiling-clamped), not in the extraction ship box
      const wantsJump = input.wasPressed(Keys.JUMP) && (!this.shipBounds || !!this._interior);
      const wantsSprint = input.isDown(Keys.SPRINT) && mi.z > 0.2;
      this.updateStanceInput(wantsJump, wantsSprint, /* allowProne */ !hub);
      const transitioning = this.standUpTimer > 0;
      mi.sprint = input.isDown(Keys.SPRINT) && !this.exhausted && this.stamina > 0 && !transitioning
        && !this.gear.overloaded;
      mi.jump = wantsJump && this._stance === 'stand' && !transitioning && c.grounded && !c.rolling
        && this.stamina >= STAMINA_JUMP_COST && !this.gear.overloaded;
      mi.aiming = this.isAiming;
      // Alt = roll (replaces the dive); the roll itself validates stamina / weight / cooldown
      if (input.wasPressed(Keys.DIVE) && !transitioning && this._stance !== 'prone') this.roll();
      // backpack perks: hold Space in the air to hover (tactical), tap it again to burst forward (jump pack)
      this.updateBackpackFlight(dt, wantsJump);
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

    // ── stim heal-over-time
    if (this.healPool > 0 && !this.isDead) {
      const h = Math.min(this.healPool, this.healRate * dt);
      this.healPool -= h;
      this.heal(h);
    }
    if (active && !this._isDowned && input.wasPressed(Keys.STIM)) this.useStim();

    // ── interaction
    this.updateInteraction(dt, active && !this._isDowned);

    // ── death anim
    if (this.isDead) this.deadTimer += dt;

    // ── pose blends
    const rolling = c.rolling;
    this.aimBlend = damp(this.aimBlend, this.isAiming ? 1 : 0, 12, dt);
    // scoped ADS: the camera sits at the shoulder, so hide the soldier (and the held weapon) once the blend is in
    const scopeHide = this.rig.scoped && this.aimBlend > 0.85;
    if (scopeHide !== this.scopeHidden) { this.scopeHidden = scopeHide; this.model.setVisible(!scopeHide && !this._inPod); }
    this.crouchBlend = damp(this.crouchBlend, this._stance === 'crouch' && !rolling ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, (this._stance === 'prone' || this._isDowned) && !rolling ? 1 : 0, 8, dt);
    this.rollBlend = damp(this.rollBlend, rolling ? 1 : 0, 18, dt);
    if (rolling) this.rollPhase = c.rollProgress;
    else if (this.rollBlend < 0.01) { this.rollBlend = 0; this.rollPhase = 0; }
    this.downedBlend = damp(this.downedBlend, this._isDowned ? 1 : 0, 6, dt);
    this.hoverBlend = damp(this.hoverBlend, this._hovering ? 1 : 0, 10, dt);
    this.sprintBlend = damp(this.sprintBlend, c.sprinting ? 1 : 0, 8, dt);
    const eyeTarget = rolling ? EYE_ROLL
      : (this._stance === 'prone' || this._isDowned) ? EYE_PRONE
      : this._stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
    this.eyePos.y = damp(this.eyePos.y, eyeTarget, 10, dt);

    // body faces aim when aiming/firing/reloading or prone, the roll direction while rolling, else movement
    const faceCamera = this.isAiming || this.weaponState.firing || this.weaponState.reloading
      || this._stance === 'prone' || this.meleeTimer > 0;
    if (!this.isDead) {
      if (rolling) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.rollDir.x, -c.rollDir.z), 20, dt);
      else if (faceCamera) this.bodyYaw = dampAngle(this.bodyYaw, this.rig.yaw, this._stance === 'prone' ? 7 : 18, dt);
      else if (c.speed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.moveDir.x, -c.moveDir.z), 12, dt);
    }
    const p = this.pose;
    p.moveBlend = Math.min(1.2, c.speed / PLAYER_WALK_SPEED);
    p.sprint = this.sprintBlend;
    p.stridePhase = c.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.dive = 0;                      // the dive was replaced by the roll
    p.roll = this.rollBlend;
    p.rollPhase = this.rollPhase;
    p.melee = this.meleeTimer > 0 ? 1 - this.meleeTimer / MELEE_SWING_TIME : 0;
    p.hover = this.hoverBlend;
    p.downed = this.downedBlend;
    p.aim = this.aimBlend;
    p.aimPitch = this.rig.pitch;
    p.torsoTwist = wrapAngle(this.rig.yaw - this.bodyYaw);
    p.airborne = damp(p.airborne, c.grounded || rolling ? 0 : 1, 12, dt);
    p.verticalVel = c.velocity.y;
    p.flinch = this.flinch;
    p.hasWeapon = this.weaponState.hasWeapon && !this._isDowned;
    p.twoHanded = this.weaponState.twoHanded;
    p.reloading = this.weaponState.reloading;
    p.recoil = this.poseRecoil;
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
    ri.prone = Math.max(this.proneBlend, this.downedBlend);
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

  private die(): void {
    if (this.isDead) return;
    this.isDead = true;
    this._isDowned = false;
    this.bleedout = 0;
    this.deadTimer = 0;
    this.healPool = 0;
    this.hp = 0;
    this.setAiming(false);
    this.setHovering(false);
    this.controller.cancelRoll();
    this.controller.grappleTarget = null; this._grappling = false;
    this.meleeTimer = 0;
    this.controlsEnabled = false;
    this.rig.addShake(0.8, 0.5);
    this.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
    this.ctx.bus.emit('player:died', { position: this.controller.position.clone() });
  }

  /* ─────────────────────── tactical kit internals ─────────────────────── */
  /**
   * Clear every tactical-kit state (roll, melee, downed, cloak, burning, grapple, hover, buffs).
   * Called from `respawnAt`, `spawnStanding` and the `game:abort` reset. The gear cache is only marked dirty —
   * armor and backpack survive a respawn.
   */
  private resetTactical(): void {
    this.controller.cancelRoll();
    this.controller.grappleTarget = null; this._grappling = false;
    this.controller.hovering = false;
    this.rollBlend = 0; this.rollPhase = 0; this.rollCooldown = 0;
    this.meleeTimer = 0; this.meleeCooldown = 0;
    this._isDowned = false; this.bleedout = 0; this.downedBlend = 0;
    this.cloakTimer = 0; this.cloakBreak = 0; this.cloakProbe = 0; this.cloakNearEnemy = false;
    this.cloakSource = null;
    if (this._cloaked) { this._cloaked = false; this.ctx?.bus.emit('player:cloakChanged', { cloaked: false, source: null }); }
    this.speedMods.clear();
    this._overcharged = false;
    this._hovering = false; this.hoverBlend = 0; this.autoHoverUsed = false;
    this.jumpPackCooldown = 0;
    if (this._burning) { this._burning = false; this.ctx?.bus.emit('player:burning', { active: false, dps: 0 }); }
    this.burnDps = 0; this.burnTimer = 0; this.burnTick = 0;
    this.regenAccum = 0;
    this.gear.markDirty();
  }

  /** Common precondition for roll / melee. */
  private canAct(): boolean {
    return this.spawned && this.controlsEnabled && !this.isDead && !this._isDowned && !this._inPod
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
      if (key === 'overcharge' || key.startsWith('overcharge')) over = true;
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
   * Cloak upkeep: firing, sprinting, rolling or an enemy inside CLOAK_REVEAL_DISTANCE reveal the player for
   * CLOAK_BREAK_TIME; once the cause is gone (and the distance opened again) the cloak comes back.
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

  /** Any alive enemy within `radius` (uses `queryNear` when the enemy system provides it). */
  private enemyWithin(ctx: GameContext, radius: number): boolean {
    const em = ctx.enemies;
    if (!em) return false;
    if (typeof em.queryNear === 'function') return em.queryNear(this.controller.position, radius).length > 0;
    const list = em.getEnemies();
    const r2 = radius * radius;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.isDead) continue;
      if (e.position.distanceToSquared(this.controller.position) <= r2) return true;
    }
    return false;
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
    if (rate <= 0 || this.isDead || this._isDowned || this.hp >= this.maxHp) { this.regenAccum = 0; return; }
    if (this.stamina < this.maxStamina - 0.5) { this.regenAccum = 0; return; }
    this.regenAccum += rate * dt;
    if (this.regenAccum >= 1) {
      const whole = Math.floor(this.regenAccum);
      this.regenAccum -= whole;
      this.heal(whole);
    }
  }

  /**
   * Backpack flight perks. Tactical: hold Space in the air to hover (and one automatic hover before a fatal
   * fall). Jump: pressing Space again mid-air bursts forward for half the stamina bar, 12 s cooldown.
   */
  private updateBackpackFlight(dt: number, wantsJump: boolean): void {
    const c = this.controller;
    const perk = this.gear.backpackPerk;
    if (c.grounded) return;
    if (perk === 'tactical') {
      const input = this.ctx.input;
      const hold = input.isDown(Keys.JUMP) && this.stamina > 0;
      if (!this.autoHoverUsed && c.velocity.y < HOVER_AUTO_FALL && this.stamina > 0) {
        this.autoHoverUsed = true;                // 낙사 방지: one free catch per airtime
        this.setHovering(true);
      } else if (hold !== this._hovering) {
        this.setHovering(hold);
      }
    } else if (perk === 'jump') {
      if (!wantsJump || this.jumpPackCooldown > 0) return;
      const cost = this.maxStamina * JUMPPACK_STAMINA_FRAC;
      if (this.stamina < cost) {
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.4 });
        return;
      }
      this.wishDirection(_dir);
      if (_dir.lengthSq() < 1e-6) this.rig.getForward(_dir);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
      _dir.normalize();
      _imp.set(_dir.x * JUMPPACK_FORWARD - c.velocity.x, JUMPPACK_UP - Math.min(0, c.velocity.y), _dir.z * JUMPPACK_FORWARD - c.velocity.z);
      this.spendStamina(cost);
      this.jumpPackCooldown = JUMPPACK_COOLDOWN;
      this.applyImpulse(_imp);
      this.ctx.bus.emit('audio:play', { id: 'player_jump', position: c.position, volume: 0.8, pitch: 1.15 });
    }
  }

  private useStim(): void {
    if (this.healPool > 0) return; // already healing
    let healAmount = 50;
    let count = 0;
    const inv = this.ctx.inventory;
    if (inv) {
      const used = inv.consumeWhere((d) => {
        if (d.category !== 'stim') return false;
        healAmount = d.healAmount ?? 50;
        return true;
      }, 1);
      if (used <= 0) {
        this.ctx.bus.emit('ui:notify', { text: '스팀팩 없음', kind: 'warning', duration: 1.2 });
        this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.6 });
        return;
      }
      count = inv.countWhere((d) => d.category === 'stim');
    } else {
      if (this.fallbackStims <= 0) {
        this.ctx.bus.emit('ui:notify', { text: '스팀팩 없음', kind: 'warning', duration: 1.2 });
        return;
      }
      this.fallbackStims--;
      count = this.fallbackStims;
    }
    this.healPool = healAmount;
    this.healRate = healAmount / STIM_DURATION;
    this.ctx.bus.emit('player:stimUsed', { hp: this.hp });
    this.ctx.bus.emit('stim:countChanged', { count });
    this.ctx.bus.emit('audio:play', { id: 'stim', volume: 0.8 });
  }

  private updateInteraction(dt: number, active: boolean): void {
    const ctx = this.ctx, input = ctx.input;
    let target: Interactable | null = null;
    if (active && this.interactCooldown <= 0) {
      this.rig.getForward(_v);
      target = ctx.interactables.findBest(this.controller.position, _v);
    }
    if (target !== this.interactTarget) { this.interactTarget = target; this.holdProgress = 0; }
    let text: string | null = null;
    if (target) {
      text = target.getPrompt();
      const hold = target.holdTime ?? 0;
      if (hold > 0) {
        if (input.isDown(Keys.INTERACT)) {
          this.holdProgress += dt / hold;
          if (this.holdProgress >= 1) { this.perform(target); this.holdProgress = 0; target = null; text = null; }
        } else {
          this.holdProgress = Math.max(0, this.holdProgress - dt * 2.5);
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
    this.setAiming(false);
    this.setStance('stand'); this.standUpTimer = 0;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.resetTactical();
    this.crouchBlend = 0; this.proneBlend = 0; this.rollBlend = 0;
    this.interactTarget = null; this.holdProgress = 0;
    if (this.lastPromptText !== null) { this.lastPromptText = null; this.lastHoldProgress = 0; this.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
    this.rig.setOverride(null);
  }
}
