import * as THREE from 'three';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
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
// near-clip body fade: fully visible beyond FADE_FAR m camera->pivot, hidden inside FADE_NEAR
const FADE_FAR = 0.9;
const FADE_NEAR = 0.45;

const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();

interface WeaponState { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing: boolean; holdingItem: boolean }

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
  /** Damp rate for the ADS blend, derived from the active weapon's aim-in time (`setAdsTime`). */
  private adsRate = 12;
  private scopeHidden = false;
  private crouchBlend = 0;
  private proneBlend = 0;
  private diveBlend = 0;
  private sprintBlend = 0;
  private throwBlend = 0;
  private holdItemBlend = 0;
  private bodyYaw = 0;
  private poseRecoil = 0;
  /** weapons holds the mouse for its quick-use wheel: camera ignores mouse deltas while true */
  private lookLocked = false;
  private weaponState: WeaponState = { hasWeapon: false, reloading: false, firing: false, twoHanded: false, throwing: false, holdingItem: false };
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
  private readonly moveInput: MoveInput = { x: 0, z: 0, sprint: false, jump: false, stance: 'stand', dive: false, aiming: false };
  private readonly moveResult: MoveResult = { footstep: false, landed: 0, jumped: false, dived: false, diveEnded: false };
  private readonly podEvents: HellpodEvents = { impact: false, opened: false, finished: false };
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, dive: 0, throw: 0, holdItem: 0,
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
    this.setAiming(false); this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.diveBlend = 0; this.sprintBlend = 0;
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
    if (this.isDead || amount <= 0 || !this.spawned) return;
    if (this.invuln > 0) return;
    if (this.hellpod.isActive && this.hellpod.state !== 'exiting') return; // safe inside the pod
    this.invuln = INVULN_TIME;
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
    const dealt = Math.min(this.hp, amount);
    this.hp -= dealt;
    this.ctx.stats.damageTaken += dealt;
    this.flinch = 1;
    bus.emit('player:damaged', { amount: dealt, hp: this.hp, from });
    bus.emit('player:healthChanged', { hp: this.hp, maxHp: this.maxHp, delta: -dealt });
    bus.emit('ui:damageIndicator', { from: from ?? this.controller.position.clone() });
    const shake = Math.min(0.7, 0.15 + dealt / 60);
    this.rig.addShake(shake, 0.25);
    bus.emit('audio:play', { id: 'player_hurt', volume: Math.min(1, 0.4 + dealt / 50) });
    if (this.hp <= 0) this.enterDowned();
  }

  heal(amount: number): void {
    if (this.isDead || this._downed || amount <= 0) return;
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
    this.healPool = 0;
    this.clearDowned();
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.setStance('stand'); this.standUpTimer = 0;
    this.isAiming = false; this.aimBlend = 0; this.crouchBlend = 0; this.proneBlend = 0; this.diveBlend = 0; this.sprintBlend = 0;
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
  setWeaponState(state: { hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing?: boolean; holdingItem?: boolean }): void {
    this.weaponState.hasWeapon = state.hasWeapon;
    this.weaponState.reloading = state.reloading;
    this.weaponState.firing = state.firing;
    this.weaponState.twoHanded = state.twoHanded;
    this.weaponState.throwing = state.throwing ?? false;
    this.weaponState.holdingItem = state.holdingItem ?? false;
    if (!state.hasWeapon) this.setAiming(false);
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

    // ── timers
    if (this.invuln > 0) this.invuln -= dt;
    if (this.interactCooldown > 0) this.interactCooldown -= dt;
    if (this.standUpTimer > 0) this.standUpTimer -= dt;
    if (this.exhaustedSlow > 0) this.exhaustedSlow -= dt;
    if (this.slowTimer > 0) { this.slowTimer -= dt; if (this.slowTimer <= 0) this.slowFactor = 1; }
    let speedMul = this.slowTimer > 0 ? THREE.MathUtils.clamp(this.slowFactor, 0.1, 1) : 1;
    if (this.standUpTimer > 0) speedMul *= 0.5;
    if (this.exhaustedSlow > 0) speedMul *= EXHAUSTED_SLOW;
    if (downed) speedMul *= PLAYER_DOWN_SPEED_MUL;   // crawl: prone speed × 0.6
    c.speedMultiplier = speedMul;
    this.flinch = damp(this.flinch, 0, 9, dt);
    this.poseRecoil = damp(this.poseRecoil, 0, 14, dt);

    // ── look & aim (aiming is cancelled during a dive / while downed; the quick-use wheel locks the look)
    if (active && locked && !this.lookLocked) this.rig.applyLook(input.mouseDX, input.mouseDY, this.aimBlend);
    this.setAiming(active && locked && !downed && this.weaponState.hasWeapon && input.isMouseDown(MouseButtons.AIM) && !c.diving);

    // ── movement input
    const mi = this.moveInput;
    if (active && !moveFrozen && downed) {
      // downed: crawl only — no stance changes, no jump / sprint / dive; Space held = give up
      mi.x = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
      mi.z = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
      mi.sprint = false; mi.jump = false; mi.dive = false; mi.aiming = false;
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
      mi.sprint = input.isDown(Keys.SPRINT) && !this.exhausted && this.stamina > 0 && !transitioning;
      mi.jump = wantsJump && this._stance === 'stand' && !transitioning && c.grounded && !c.diving && this.stamina >= STAMINA_JUMP_COST;
      // no dive in the hub / inside ship interiors
      mi.dive = input.wasPressed(Keys.DIVE) && c.grounded && !c.diving && this._stance !== 'prone'
        && !transitioning && !this.shipBounds && !this._interior && !hub && this.stamina >= STAMINA_DIVE_MIN;
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

    // ── pose blends
    const diving = c.diving;
    this.aimBlend = damp(this.aimBlend, this.isAiming ? 1 : 0, this.adsRate, dt);
    // scoped ADS: the camera sits at the shoulder, so hide the soldier (and the held weapon) once the blend is in
    const scopeHide = this.rig.scoped && this.aimBlend > 0.85;
    if (scopeHide !== this.scopeHidden) { this.scopeHidden = scopeHide; this.model.setVisible(!scopeHide && !this._inPod); }
    this.crouchBlend = damp(this.crouchBlend, this._stance === 'crouch' && !diving ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, this._stance === 'prone' && !diving ? 1 : 0, 8, dt);
    this.diveBlend = damp(this.diveBlend, diving ? 1 : 0, 14, dt);
    this.sprintBlend = damp(this.sprintBlend, c.sprinting ? 1 : 0, 8, dt);
    this.throwBlend = damp(this.throwBlend, this.weaponState.throwing ? 1 : 0, 12, dt);
    this.holdItemBlend = damp(this.holdItemBlend, this.weaponState.holdingItem ? 1 : 0, 10, dt);
    const eyeTarget = diving ? EYE_DIVE : this._stance === 'prone' ? EYE_PRONE : this._stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
    this.eyePos.y = damp(this.eyePos.y, eyeTarget, 10, dt);

    // body faces aim when aiming/firing/reloading/throwing or prone, the dive direction while diving, else movement
    const faceCamera = this.isAiming || this.weaponState.firing || this.weaponState.reloading || this.weaponState.throwing || this._stance === 'prone';
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
    p.throw = this.throwBlend;
    p.holdItem = this.holdItemBlend;
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

    // ── near-clip fade: the camera pulled into the body (obstacle behind the back, scoped tuck) -> fade the soldier
    const alpha = this.spawned && !this.scopeHidden ? smoothstep(FADE_NEAR, FADE_FAR, this.rig.pivotDistance) : 1;
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
    if (!c.grounded || c.diving || this.standUpTimer > 0) return;
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

  /** hp reached 0: 전투불능 instead of death — prone crawl, weapons off, `downHp` starts bleeding. */
  private enterDowned(): void {
    if (this._downed || this.isDead) return;
    this._downed = true;
    this._downHp = PLAYER_DOWN_HP;
    this.bleedAcc = 0; this.giveUpHold = 0;
    this.hp = 0;
    this.healPool = 0;
    this.setAiming(false);
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
    this.controlsEnabled = false;
    this.cancelHold();
    this.rig.addShake(0.8, 0.5);
    this.ctx.bus.emit('audio:play', { id: 'player_death', volume: 1 });
    this.ctx.bus.emit('player:died', { position: this.controller.position.clone() });
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
      const hold = target.holdTime ?? 0;
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
    this.weaponState.throwing = false; this.weaponState.holdingItem = false; this.throwBlend = 0; this.holdItemBlend = 0;
    this.setAiming(false);
    this.setStance('stand'); this.standUpTimer = 0;
    this.stamina = this.maxStamina; this.regenDelay = 0; this.exhausted = false; this.exhaustedSlow = 0;
    this.crouchBlend = 0; this.proneBlend = 0; this.diveBlend = 0;
    this.cancelHold(); this.interactTarget = null;
    if (this.lastPromptText !== null) { this.lastPromptText = null; this.lastHoldProgress = 0; this.ctx.bus.emit('interact:promptChanged', { text: null, holdProgress: 0 }); }
    this.rig.setOverride(null);
  }
}
