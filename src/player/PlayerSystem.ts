import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, type SoldierPose } from './SoldierModel';
import { CameraRig, type RigInput } from './CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from './PlayerController';
import { Hellpod, type HellpodEvents } from './Hellpod';

const EYE_STAND = 1.55;
const EYE_CROUCH = 1.15;
const EYE_PRONE = 0.45;
const EYE_DIVE = 1.0;
const INVULN_TIME = 0.15;
const STIM_DURATION = 1.5;
const DEATH_ANIM = 0.9;

// stamina tuning
const STAMINA_SPRINT_DRAIN = 14;     // per second
const STAMINA_JUMP_COST = 12;
const STAMINA_DIVE_COST = 25;
const STAMINA_DIVE_MIN = 15;         // may dive with at least this much (cost clamps to 0)
const STAMINA_REGEN_DELAY = 0.8;
const STAMINA_REGEN_MOVING = 16;     // per second
const STAMINA_REGEN_IDLE = 22;
const STAMINA_SPRINT_RECOVER = 20;   // sprint unavailable after depletion until this much
const EXHAUSTED_SLOW_TIME = 1.0;
const EXHAUSTED_SLOW = 0.9;
const STAND_UP_TIME = 0.35;          // prone → stand/crouch transition (no jump/sprint/dive)
const SPAWN_RING_RADIUS = 4;         // multiplayer: per-slot drop offset around the shared spawn (m)

const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();

interface WeaponState { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean }

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

  // stamina
  stamina = PLAYER_MAX_STAMINA;
  readonly maxStamina = PLAYER_MAX_STAMINA;
  private regenDelay = 0;
  private exhausted = false;
  private exhaustedSlow = 0;

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
  private diveBlend = 0;
  private sprintBlend = 0;
  private bodyYaw = 0;
  private poseRecoil = 0;
  private weaponState: WeaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false };
  private slowTimer = 0;
  private slowFactor = 1;
  private attachedParent: THREE.Object3D | null = null;
  private shipBounds: ShipBounds = null;

  // interaction
  private interactTarget: Interactable | null = null;
  private holdProgress = 0;
  private lastPromptText: string | null = null;
  private lastHoldProgress = -1;
  private interactCooldown = 0;

  // scratch
  private readonly moveInput: MoveInput = { x: 0, z: 0, sprint: false, jump: false, stance: 'stand', dive: false, aiming: false };
  private readonly moveResult: MoveResult = { footstep: false, landed: 0, jumped: false, dived: false, diveEnded: false };
  private readonly podEvents: HellpodEvents = { impact: false, opened: false, finished: false };
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, dive: 0,
  };
  private readonly rigInput: RigInput = {
    pivot: new THREE.Vector3(), aim: 0, sprint: 0, crouch: 0, prone: 0, dive: 0, moveBlend: 0, stridePhase: 0,
    grounded: true, dead: false, world: null, shipBounds: null,
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

  getEyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.controller.position).add(this.eyePos);
  }
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return this.rig ? this.rig.getForward(out) : out.set(0, 0, -1);
  }

  takeDamage(amount: number, from?: THREE.Vector3): void {
    if (this.isDead || amount <= 0 || !this.spawned) return;
    if (this.invuln > 0) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return; // safe inside the pod
    this.invuln = INVULN_TIME;
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    this.ctx.stats.damageTaken += dealt;
    this.flinch = 1;
    const bus = this.ctx.bus;
    bus.emit('player:damaged', { amount: dealt, hp: this.hp, from });
    bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: -dealt });
    bus.emit('ui:damageIndicator', { from: from ?? this.controller.position.clone() });
    const shake = Math.min(0.7, 0.15 + dealt / 60);
    this.rig.addShake(shake, 0.25);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50) });
    if (this.hp <= 0) this.die();
  }

  heal(amount: number): void {
    if (this.isDead || amount <= 0) return;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const delta = this.hp - before;
    if (delta > 0) this.ctx.bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta });
  }

  respawnAt(position: THREE.Vector3, yaw?: number): void {
    const y = yaw ?? Math.atan2(position.x, position.z); // face the map centre by default
    this.attachTo(null);
    this.shipBounds = null;
    this.controller.shipBounds = null;
    this.controller.reset(position);
    this.hp = this.maxHp;
    this.slowTimer = 0; this.slowFactor = 1; this.controller.speedMultiplier = 1;
    this.isDead = false; this.deadTimer = 0; this.invuln = 0; this.flinch = 0;
    this.healPool = 0; this.fallbackStims = 3;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.setStance('stand'); this.standUpTimer = 0;
    this.isAiming = false; this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.diveBlend = 0; this.sprintBlend = 0;
    this.bodyYaw = y;
    this.spawned = true;
    this.controlsEnabled = true;
    this.model.resetPose();
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
    return this.spawned && this.controlsEnabled && !this.isDead && !this.controller.diving
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
    ctx.bus.on('camera:shake', ({ intensity, duration }) => this.rig.addShake(intensity, duration));
    ctx.bus.on('player:applySlow', ({ duration, factor }) => {
      // strongest slow wins; refresh the timer
      this.slowFactor = this.slowTimer > 0 ? Math.min(this.slowFactor, factor) : factor;
      this.slowTimer = Math.max(this.slowTimer, duration);
    });
  }

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    const c = this.controller;
    // ride along with a parent (extraction ship)
    if (this.attachedParent) {
      this.model.root.updateWorldMatrix(true, false);
      c.position.setFromMatrixPosition(this.model.root.matrixWorld);
    }

    const gameplay = ctx.isGameplayActive();
    const active = gameplay && this.controlsEnabled && !this.isDead && this.spawned;
    const locked = input.isPointerLocked;
    const moveFrozen = this.hellpod.isActive && this.hellpod.state !== 'exiting';

    if (gameplay && !locked && input.wasMousePressed(0)) input.requestPointerLock();

    // ── timers
    if (this.invuln > 0) this.invuln -= dt;
    if (this.interactCooldown > 0) this.interactCooldown -= dt;
    if (this.standUpTimer > 0) this.standUpTimer -= dt;
    if (this.exhaustedSlow > 0) this.exhaustedSlow -= dt;
    if (this.slowTimer > 0) { this.slowTimer -= dt; if (this.slowTimer <= 0) this.slowFactor = 1; }
    let speedMul = this.slowTimer > 0 ? THREE.MathUtils.clamp(this.slowFactor, 0.1, 1) : 1;
    if (this.standUpTimer > 0) speedMul *= 0.5;
    if (this.exhaustedSlow > 0) speedMul *= EXHAUSTED_SLOW;
    c.speedMultiplier = speedMul;
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.poseRecoil = damp(this.poseRecoil, 0, 14, dt);

    // ── look & aim (aiming is cancelled during a dive)
    if (active && locked) this.rig.applyLook(input.mouseDX, input.mouseDY, this.aimBlend);
    this.setAiming(active && locked && this.weaponState.hasWeapon && input.isMouseDown(MouseButtons.AIM) && !c.diving);

    // ── movement input
    const mi = this.moveInput;
    if (active && !moveFrozen) {
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      const wantsJump = input.wasPressed(Keys.JUMP) && !this.shipBounds;
      const wantsSprint = input.isDown(Keys.SPRINT) && mi.z > 0.2;
      this.updateStanceInput(wantsJump, wantsSprint);
      const transitioning = this.standUpTimer > 0;
      mi.sprint = input.isDown(Keys.SPRINT) && !this.exhausted && this.stamina > 0 && !transitioning;
      mi.jump = wantsJump && this._stance === 'stand' && !transitioning && c.grounded && !c.diving && this.stamina >= STAMINA_JUMP_COST;
      mi.dive = input.wasPressed(Keys.DIVE) && c.grounded && !c.diving && this._stance !== 'prone'
        && !transitioning && !this.shipBounds && this.stamina >= STAMINA_DIVE_MIN;
      if (mi.dive) { this.spendStamina(STAMINA_DIVE_COST); this.setAiming(false); }
      mi.aiming = this.isAiming;
      // step out of the pod automatically unless the player takes over
      if (this.hellpod.state === 'exiting' && mi.x === 0 && mi.z === 0) { mi.z = 0.7; mi.sprint = false; }
    } else {
      mi.x = 0; mi.z = 0; mi.sprint = false; mi.jump = false; mi.dive = false; mi.aiming = false;
    }
    mi.stance = this._stance;
    const wasSprinting = c.sprinting;
    if (!moveFrozen) {
      c.update(dt, mi, this.rig.yaw, ctx.world, this.moveResult);
    } else {
      this.moveResult.footstep = false; this.moveResult.landed = 0; this.moveResult.jumped = false;
      this.moveResult.dived = false; this.moveResult.diveEnded = false;
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
    if (r.dived) {
      ctx.bus.emit('player:dived', { position: c.position.clone(), direction: c.diveDir.clone() });
      ctx.bus.emit('audio:play', { id: 'player_jump', position: c.position, volume: 0.7, pitch: 0.85 });
    }
    if (r.diveEnded) {
      // touchdown → prone, small thump, dust
      this.setStance('prone');
      this.rig.addShake(0.15, 0.15);
      ctx.bus.emit('audio:play', { id: 'player_land', position: c.position, volume: 0.7 });
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 6, 0.8);
    } else if (r.landed > 0) {
      // ordinary landing: barely any shake for a normal jump, more for real falls
      const impact = r.landed;
      const shake = Math.min(0.2, Math.max(0, impact - 5) * 0.03);
      if (shake > 0.01) this.rig.addShake(shake, 0.12);
      ctx.bus.emit('audio:play', { id: 'player_land', position: c.position, volume: Math.min(1, impact / 10) });
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, c.position, _up, 5, 0.7);
    }

    // ── stamina
    this.updateStamina(dt);

    // ── hellpod choreography
    if (this.hellpod.isActive) this.updateDrop(dt);

    // ── stim heal-over-time
    if (this.healPool > 0 && !this.isDead) {
      const h = Math.min(this.healPool, this.healRate * dt);
      this.healPool -= h;
      this.heal(h);
    }
    if (active && input.wasPressed(Keys.STIM)) this.useStim();

    // ── interaction
    this.updateInteraction(dt, active);

    // ── death anim
    if (this.isDead) this.deadTimer += dt;

    // ── pose blends
    const diving = c.diving;
    this.aimBlend = damp(this.aimBlend, this.isAiming ? 1 : 0, 12, dt);
    // scoped ADS: the camera sits at the shoulder, so hide the soldier (and the held weapon) once the blend is in
    const scopeHide = this.rig.scoped && this.aimBlend > 0.85;
    if (scopeHide !== this.scopeHidden) { this.scopeHidden = scopeHide; this.model.setVisible(!scopeHide); }
    this.crouchBlend = damp(this.crouchBlend, this._stance === 'crouch' && !diving ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, this._stance === 'prone' && !diving ? 1 : 0, 8, dt);
    this.diveBlend = damp(this.diveBlend, diving ? 1 : 0, 14, dt);
    this.sprintBlend = damp(this.sprintBlend, c.sprinting ? 1 : 0, 8, dt);
    const eyeTarget = diving ? EYE_DIVE : this._stance === 'prone' ? EYE_PRONE : this._stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
    this.eyePos.y = damp(this.eyePos.y, eyeTarget, 10, dt);

    // body faces aim when aiming/firing/reloading or prone, the dive direction while diving, else movement
    const faceCamera = this.isAiming || this.weaponState.firing || this.weaponState.reloading || this._stance === 'prone';
    if (!this.isDead) {
      if (diving) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.diveDir.x, -c.diveDir.z), 20, dt);
      else if (faceCamera) this.bodyYaw = dampAngle(this.bodyYaw, this.rig.yaw, this._stance === 'prone' ? 7 : 18, dt);
      else if (c.speed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-c.moveDir.x, -c.moveDir.z), 12, dt);
    }
    const p = this.pose;
    p.moveBlend = Math.min(1.2, c.speed / PLAYER_WALK_SPEED);
    p.sprint = this.sprintBlend;
    p.stridePhase = c.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.dive = this.diveBlend;
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
    ri.dive = this.diveBlend;
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
  private updateStanceInput(wantsJump: boolean, wantsSprint: boolean): void {
    const c = this.controller, input = this.ctx.input;
    if (!c.grounded || c.diving || this.standUpTimer > 0) return;
    if (input.wasPressed(Keys.CROUCH)) {
      this.setStance(this._stance === 'crouch' ? 'stand' : 'crouch');
    } else if (input.wasPressed(Keys.PRONE)) {
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

  private updateStamina(dt: number): void {
    const c = this.controller;
    if (c.sprinting && !this.isDead) {
      this.stamina -= STAMINA_SPRINT_DRAIN * dt;
      this.regenDelay = STAMINA_REGEN_DELAY;
      if (this.stamina <= 0) { this.stamina = 0; this.onStaminaDepleted(); }
    } else if (this.regenDelay > 0) {
      this.regenDelay -= dt;
    } else if (this.stamina < this.maxStamina) {
      const rate = c.speed < 0.3 && !c.diving ? STAMINA_REGEN_IDLE : STAMINA_REGEN_MOVING;
      this.stamina = Math.min(this.maxStamina, this.stamina + rate * dt);
    }
    if (this.exhausted && this.stamina >= STAMINA_SPRINT_RECOVER) this.exhausted = false;
  }

  private die(): void {
    if (this.isDead) return;
    this.isDead = true;
    this.deadTimer = 0;
    this.healPool = 0;
    this.setAiming(false);
    this.controlsEnabled = false;
    this.rig.addShake(0.8, 0.5);
    this.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
    this.ctx.bus.emit('player:died', { position: this.controller.position.clone() });
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
      this.model.setVisible(true);
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
    this.model.setVisible(false);
    this.model.resetPose();
    this.spawned = false;
    this.controlsEnabled = false;
    this.isDead = false; this.deadTimer = 0;
    this.healPool = 0;
    this.setAiming(false);
    this.setStance('stand'); this.standUpTimer = 0;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.crouchBlend = 0; this.proneBlend = 0; this.diveBlend = 0;
    this.interactTarget = null; this.holdProgress = 0;
    if (this.lastPromptText !== null) { this.lastPromptText = null; this.lastHoldProgress = 0; this.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
    this.rig.setOverride(null);
  }
}
