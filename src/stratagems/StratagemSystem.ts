import * as THREE from 'three';
import {
  Keys, MouseButtons, Random,
  STRATAGEM_DEFS, STRATAGEM_ORDER, STRATAGEM_WHEEL_HOLD, STRATAGEM_CHARGE_TIME,
  TOPVIEW_HEIGHT, TOPVIEW_RANGE, TOPVIEW_CURSOR_SPEED, GROUND_TARGET_RANGE,
  LASER_DURATION, LASER_RADIUS, LASER_DPS, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE,
  SUPPLY_FALL_TIME, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE, SUPPLY_CRATE_TIER,
  STRUCTURE_COUNT, STRUCTURE_HP, STRUCTURE_SCATTER, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE, STRUCTURE_FALL_TIME,
  type GameContext, type GameSystem, type StratagemsRef, type StratagemId, type StratagemCall, type StratagemStage, type StratagemDef,
  type PlayerRef, type PlayerWeaponHost, type Interactable, type Obstacle, type DestructibleRef, type WorldRef, type Vec3Tuple, type PeerId,
} from '@/shared';
import {
  SharedGeo, TargetRing, CallMarker, Burst, dustBurst, sparkBurst, LaserBeam, Fireball, SupplyCrateMesh, BarricadeMesh, makeRubble, KIND_COLOR,
} from './Visuals';

type Host = PlayerRef & PlayerWeaponHost;

/** Wheel: pointer-locked drag (px) before a sector counts. */
const WHEEL_DRAG_PX = 30;
/** Targeting ring / `stratagem:targeting` re-emit threshold (m). */
const TARGET_EMIT_EPS = 0.2;
/** Laser damage tick (s). */
const LASER_TICK = 0.25;
/** Airstrike FX length (s) before `stratagem:ended`. */
const AIRSTRIKE_FX_TIME = 2.0;
/** Fall heights (m). */
const SUPPLY_DROP_HEIGHT = 120;
const STRUCTURE_DROP_HEIGHT = 60;
const STRUCTURE_STAGGER = 0.15;
const STRUCTURE_MIN_GAP = 2.4;
/** Grenade splash damage against structures (centre value, linear falloff). */
const GRENADE_STRUCTURE_DAMAGE = 250;
/** `camera:shake` reach (m). */
const SHAKE_RANGE = 60;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();

function defOf(id: StratagemId): StratagemDef {
  return STRATAGEM_DEFS.find((d) => d.id === id)!;
}
function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
}

/* ────────────────────────────── runtime records ────────────────────────────── */
class Structure {
  hp = STRUCTURE_HP;
  landed = false;
  destroyed = false;
  remover: (() => void) | null = null;
  rubble: THREE.Group | null = null;
  readonly destructible: DestructibleRef;
  constructor(
    readonly id: string, readonly call: Call, readonly index: number,
    readonly position: THREE.Vector3, readonly landAt: number, readonly mesh: BarricadeMesh,
    onDamage: (s: Structure, amount: number) => void,
  ) {
    const self = this;
    this.destructible = {
      id, get hp() { return self.hp; }, maxHp: STRUCTURE_HP,
      onDamage(amount) { onDamage(self, amount); },
    };
  }
}

class Call implements StratagemCall {
  stage: StratagemStage = 'incoming';
  /** Effect owner: this client called it (enemy damage is applied here only). */
  readonly local: boolean;
  readonly def: StratagemDef;
  marker: CallMarker | null = null;
  /* laser */
  beam: LaserBeam | null = null;
  nextTick = 0;
  /* airstrike */
  fireball: Fireball | null = null;
  /* supply */
  crate: SupplyCrateMesh | null = null;
  interactable: Interactable | null = null;
  obstacleRemover: (() => void) | null = null;
  looted = false;
  /* structures */
  structures: Structure[] = [];
  landedCount = 0;
  audioStarted = false;
  constructor(
    readonly id: string, readonly kind: StratagemId, readonly position: THREE.Vector3,
    readonly landsAt: number, readonly caller: PeerId | null, readonly seed: number, local: boolean,
  ) {
    this.local = local;
    this.def = defOf(kind);
  }
}

/**
 * Ship calls (함선 호출). Publishes `ctx.stratagems`.
 *
 * Input state machine (gameplay only, pointer locked):
 *   idle ──G tap──▶ armed(last)      ──G tap / RMB──▶ idle
 *        ──G hold──▶ wheel ──release──▶ armed(hover)
 *   armed(topview def) ──LMB hold 3 s──▶ topview cursor ──LMB──▶ confirm / ──RMB, Esc──▶ armed
 *   armed(ground def)  = ring on the aim ray ──LMB──▶ confirm
 *   confirm → Call {incoming} → landsAt → effect (active) → done. One shared cooldown.
 * Every client simulates the effect FX + its own player's damage; enemy damage is applied on the caller's client only
 * (replica `applyExplosion` forwards to the host). Structures are placed from the call `seed`, so they match everywhere.
 */
export class StratagemSystem implements GameSystem, StratagemsRef {
  readonly name = 'stratagems';
  private ctx!: GameContext;
  private readonly geo = new SharedGeo();
  private readonly group = new THREE.Group();
  private ring!: TargetRing;
  private readonly calls: Call[] = [];
  /** ctx.time at the previous update (pause shift, see `updateCalls`). */
  private lastClock = -1;
  private readonly byId = new Map<string, Call>();
  private readonly bursts: Burst[] = [];
  private seq = 0;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];
  private warnedNoObstacle = false;

  /* ── StratagemsRef state ── */
  private _armed: StratagemId | null = null;
  private lastArmed: StratagemId = STRATAGEM_ORDER[0];
  private _cooldown = 0;
  private _cooldownTotal = 0;
  private cooldownEmitAcc = 0;
  /* wheel */
  private gHeld = false;
  private gHoldT = 0;
  private wheelOpen = false;
  private wheelDX = 0; private wheelDY = 0;
  private wheelHover: StratagemId | null = null;
  /* charge / topview */
  private charge = -1;
  private topview = false;
  private needRelease = false;
  private escRequested = false;
  private readonly cursor = new THREE.Vector3();
  /* ground */
  private groundTargeting = false;
  private readonly lastEmitted = new THREE.Vector3(NaN, NaN, NaN);
  private targetValid = false;

  get armed(): StratagemId | null { return this._armed; }
  get targeting(): boolean { return this.topview || this.groundTargeting; }
  get cooldown(): number { return this._cooldown; }
  get cooldownTotal(): number { return this._cooldownTotal; }
  getCalls(): readonly StratagemCall[] { return this.calls; }
  get structureCount(): number {
    let n = 0;
    for (const c of this.calls) for (const s of c.structures) if (s.landed && !s.destroyed) n++;
    return n;
  }

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.stratagems = this;
    this.ring = new TargetRing(this.geo);
    this.group.add(this.ring.group);
    ctx.scene.add(this.group);
    const b = ctx.bus;
    const clear = () => this.clearAll();
    this.unsubs.push(
      b.on('game:abort', clear),
      b.on('game:newMission', clear),
      b.on('hub:entered', clear),
      b.on('world:cleared', clear),
      b.on('player:died', () => this.putAway()),
      b.on('player:downed', () => this.putAway()),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase !== 'playing' && phase !== 'extracting' && phase !== 'shipLanded' && phase !== 'liftoff') this.putAway();
      }),
      b.on('crate:looted', ({ crateId }) => this.onCrateLooted(crateId)),
      b.on('grenade:exploded', ({ position, radius }) => this.splashStructures(position, radius, GRENADE_STRUCTURE_DAMAGE)),
    );
    this.ensureNetHooks();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    this.tickCooldown(dt);
    this.updateInput(dt);
    this.updateCalls(dt);
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!this.bursts[i].update(dt)) { this.group.remove(this.bursts[i].points); this.bursts[i].dispose(); this.bursts.splice(i, 1); }
    }
    void ctx;
  }

  dispose(): void {
    this.clearAll();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.ring.dispose();
    this.ctx.scene.remove(this.group);
    this.geo.dispose();
    if (this.ctx.stratagems === this) this.ctx.stratagems = null;
  }

  /** Debug: create a call at `position` immediately (no input, no cooldown). Returns the call id. */
  debugCall(kind: StratagemId, position: THREE.Vector3): string {
    const def = defOf(kind);
    const p = position.clone();
    if (this.ctx.world?.ready) p.y = this.ctx.world.getHeightAt(p.x, p.z);
    return this.createCall(kind, p, def.delay, (Math.random() * 0xffffffff) >>> 0, true).id;
  }

  /** Debug: clear the shared cooldown (emits `stratagem:cooldown {remaining: 0}`). */
  debugCooldownReset(): void {
    this._cooldown = 0;
    this.cooldownEmitAcc = 0;
    this.ctx.bus.emit('stratagem:cooldown', { remaining: 0, total: this._cooldownTotal });
  }

  /* ─────────────────────────── helpers ─────────────────────────── */
  private host(): Host | null {
    const p = this.ctx.player;
    if (!p || typeof (p as Partial<PlayerWeaponHost>).getAimRay !== 'function') return null;
    return p as Host;
  }
  private world(): WorldRef | null {
    const w = this.ctx.world;
    return w && w.ready ? w : null;
  }
  /** Gameplay, pointer locked, alive and not downed. */
  private baseActive(): boolean {
    const ctx = this.ctx, p = ctx.player;
    return !!p && ctx.isGameplayActive() && ctx.input.isPointerLocked && !p.isDead && !p.isDowned;
  }
  private audio(id: string, position?: THREE.Vector3, volume = 1): void {
    this.ctx.bus.emit('audio:play', { id, position, volume });
  }
  private shakeFrom(center: THREE.Vector3, base: number): void {
    const p = this.ctx.player; if (!p) return;
    const d = p.position.distanceTo(center);
    const k = THREE.MathUtils.clamp(1 - d / SHAKE_RANGE, 0, 1);
    if (k > 0) this.ctx.bus.emit('camera:shake', { intensity: base * (0.25 + k * 0.75), duration: 0.5 });
  }
  private burst(b: Burst): void { this.bursts.push(b); this.group.add(b.points); }

  /* ─────────────────────────── cooldown ─────────────────────────── */
  private tickCooldown(dt: number): void {
    if (this._cooldown <= 0) return;
    this._cooldown = Math.max(0, this._cooldown - dt);
    this.cooldownEmitAcc += dt;
    if (this._cooldown === 0 || this.cooldownEmitAcc >= 0.5) {
      this.cooldownEmitAcc = 0;
      this.ctx.bus.emit('stratagem:cooldown', { remaining: this._cooldown, total: this._cooldownTotal });
    }
  }
  private startCooldown(seconds: number): void {
    this._cooldown = this._cooldownTotal = seconds;
    this.cooldownEmitAcc = 0;
    this.ctx.bus.emit('stratagem:cooldown', { remaining: seconds, total: seconds });
  }

  /* ─────────────────────────── input ─────────────────────────── */
  private updateInput(dt: number): void {
    const ctx = this.ctx, input = ctx.input;
    const host = this.host();
    const active = this.baseActive();
    if (!active || !host) {
      if (this.topview || this.wheelOpen || this.charge >= 0) this.cancelTargeting();
      if (ctx.player && (ctx.player.isDead || ctx.player.isDowned)) this.putAway();
      this.setGroundTargeting(false);
      this.gHeld = false;
      return;
    }

    if (this.topview) { this.updateTopview(dt, host); return; }

    /* ── G: tap = arm last / put away, hold = wheel ── */
    if (input.wasPressed(Keys.SHIP_CALL)) { this.gHeld = true; this.gHoldT = 0; }
    if (this.gHeld) {
      if (!input.isDown(Keys.SHIP_CALL)) {
        this.gHeld = false;
        if (this.wheelOpen) {
          const hover = this.wheelHover;
          this.closeWheel(host);
          if (hover) this.arm(hover);
        } else if (this._armed) this.disarm();
        else this.arm(this.lastArmed);
      } else {
        this.gHoldT += dt;
        if (!this.wheelOpen && this.gHoldT >= STRATAGEM_WHEEL_HOLD && host.canUseWeapons()) {
          this.wheelOpen = true; this.wheelDX = 0; this.wheelDY = 0; this.wheelHover = null;
          this.cancelCharge();
          host.setLookLocked(true);
          ctx.bus.emit('stratagem:wheelChanged', { open: true, hover: null });
          this.audio('ui_open', undefined, 0.35);
        }
        if (this.wheelOpen) this.updateWheel(input.mouseDX, input.mouseDY);
        return;
      }
    }
    if (this.wheelOpen) return;

    const armed = this._armed;
    if (!armed) { this.setGroundTargeting(false); return; }
    if (!host.canUseWeapons()) { this.cancelCharge(); this.setGroundTargeting(false); return; }
    const def = defOf(armed);

    if (def.targeting === 'ground') {
      this.setGroundTargeting(true);
      this.updateGroundCursor(host);
      if (input.wasMousePressed(MouseButtons.AIM)) { this.disarm(); return; }
      if (input.wasMousePressed(MouseButtons.FIRE) && this.targetValid) this.confirm(def);
      return;
    }

    /* topview def: LMB charge */
    if (input.wasMousePressed(MouseButtons.AIM)) { this.disarm(); return; }
    if (input.isMouseDown(MouseButtons.FIRE)) {
      if (this.charge < 0) this.charge = 0;
      this.charge = Math.min(1, this.charge + dt / STRATAGEM_CHARGE_TIME);
      ctx.bus.emit('stratagem:chargeChanged', { t: this.charge });
      if (this.charge >= 1) { this.charge = -1; ctx.bus.emit('stratagem:chargeChanged', { t: -1 }); this.enterTopview(host); }
    } else if (this.charge >= 0) this.cancelCharge();
  }

  private cancelCharge(): void {
    if (this.charge < 0) return;
    this.charge = -1;
    this.ctx.bus.emit('stratagem:chargeChanged', { t: -1 });
  }

  private updateWheel(dx: number, dy: number): void {
    this.wheelDX += dx; this.wheelDY += dy;
    let hover: StratagemId | null = null;
    if (this.wheelDX * this.wheelDX + this.wheelDY * this.wheelDY >= WHEEL_DRAG_PX * WHEEL_DRAG_PX) {
      // 0 = N (up), clockwise; snapped to the 4 cardinal sectors → STRATAGEM_ORDER (N, E, S, W)
      const ang = Math.atan2(this.wheelDX, -this.wheelDY);
      const idx = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
      hover = STRATAGEM_ORDER[idx];
    }
    if (hover !== this.wheelHover) {
      this.wheelHover = hover;
      this.ctx.bus.emit('stratagem:wheelChanged', { open: true, hover });
      if (hover) this.audio('ui_click', undefined, 0.3);
    }
  }

  private closeWheel(host: Host): void {
    if (!this.wheelOpen) return;
    this.wheelOpen = false; this.wheelHover = null;
    host.setLookLocked(false);
    this.ctx.bus.emit('stratagem:wheelChanged', { open: false, hover: null });
  }

  private arm(id: StratagemId): void {
    if (this._cooldown > 0) {
      this.audio('ui_deny', undefined, 0.6);
      this.ctx.bus.emit('ui:notify', { text: `함선 호출 재충전 중 (${Math.ceil(this._cooldown)}초)`, kind: 'warning', duration: 1.5 });
      return;
    }
    this.cancelCharge();
    this.setGroundTargeting(false);   // re-enabled next frame for ground defs
    this._armed = id; this.lastArmed = id;
    const def = defOf(id);
    this.ring.setKind(id, def.radius);
    this.ctx.bus.emit('stratagem:armed', { id });
    this.audio('ui_equip', undefined, 0.6);
  }

  private disarm(): void {
    this.cancelCharge();
    this.setGroundTargeting(false);
    if (this._armed === null) return;
    this._armed = null;
    this.ctx.bus.emit('stratagem:armed', { id: null });
  }

  /** Leave any targeting and put the call away. */
  private putAway(): void {
    this.cancelTargeting();
    this.disarm();
  }

  /* ─────────────────────────── ground targeting ─────────────────────────── */
  private setGroundTargeting(on: boolean): void {
    if (on === this.groundTargeting) return;
    this.groundTargeting = on;
    this.ring.show(on);
    if (!on) {
      this.lastEmitted.set(NaN, NaN, NaN); this.targetValid = false;
      this.ctx.bus.emit('stratagem:targeting', { active: false, kind: null, position: null });
    }
  }

  private updateGroundCursor(host: Host): void {
    const world = this.world();
    if (!world) { this.targetValid = false; this.ring.show(false); return; }
    host.getAimRay(_a, _dir);
    const hit = world.raycast(_a, _dir, GROUND_TARGET_RANGE);
    if (hit) this.cursor.copy(hit.point);
    else {
      this.cursor.copy(_a).addScaledVector(_dir, GROUND_TARGET_RANGE);
      this.cursor.y = world.getHeightAt(this.cursor.x, this.cursor.z);
    }
    // keep the point within range of the player (a hit far below the horizon can exceed it) and inside the map
    const p = host.position;
    _b.set(this.cursor.x - p.x, 0, this.cursor.z - p.z);
    const d = _b.length();
    if (d > GROUND_TARGET_RANGE) {
      _b.multiplyScalar(GROUND_TARGET_RANGE / d);
      this.cursor.set(p.x + _b.x, 0, p.z + _b.z);
      this.cursor.y = world.getHeightAt(this.cursor.x, this.cursor.z);
    }
    this.targetValid = world.isInsideBounds(this.cursor.x, this.cursor.z);
    this.ring.show(this.targetValid);
    this.ring.animate(this.cursor, this.ctx.time);
    this.emitTargeting();
  }

  private emitTargeting(): void {
    if (!this._armed) return;
    if (this.lastEmitted.distanceToSquared(this.cursor) < TARGET_EMIT_EPS * TARGET_EMIT_EPS) return;
    this.lastEmitted.copy(this.cursor);
    this.ctx.bus.emit('stratagem:targeting', { active: true, kind: this._armed, position: this.cursor });
  }

  /* ─────────────────────────── top view ─────────────────────────── */
  private readonly escHandler = (e: KeyboardEvent): void => {
    if (e.code !== Keys.MENU || !this.topview) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.escRequested = true;
  };

  private enterTopview(host: Host): void {
    if (this.topview || !this._armed) return;
    this.topview = true;
    this.needRelease = true;
    this.escRequested = false;
    host.setControlsEnabled(false);
    host.setLookLocked(true);
    const pos = host.position.clone(); pos.y += TOPVIEW_HEIGHT; pos.z += 0.001;
    host.setCameraOverride(pos, host.position.clone(), false);
    this.cursor.copy(host.position);
    const world = this.world();
    if (world) this.cursor.y = world.getHeightAt(this.cursor.x, this.cursor.z);
    this.ring.show(true);
    this.ring.animate(this.cursor, this.ctx.time);
    window.addEventListener('keydown', this.escHandler, true);
    this.lastEmitted.set(NaN, NaN, NaN);
    this.emitTargeting();
    this.audio('ui_open', undefined, 0.5);
  }

  private updateTopview(_dt: number, host: Host): void {
    const input = this.ctx.input;
    const world = this.world();
    if (!world) { this.cancelTargeting(); return; }
    // cursor: screen right = world +X, screen up = world −Z (camera above the player looking down, up = −Z)
    const dx = input.mouseDX * TOPVIEW_CURSOR_SPEED, dz = input.mouseDY * TOPVIEW_CURSOR_SPEED;
    if (dx !== 0 || dz !== 0) {
      const px = this.cursor.x, pz = this.cursor.z;
      this.cursor.x += dx; this.cursor.z += dz;
      const p = host.position;
      _b.set(this.cursor.x - p.x, 0, this.cursor.z - p.z);
      const d = _b.length();
      if (d > TOPVIEW_RANGE) { _b.multiplyScalar(TOPVIEW_RANGE / d); this.cursor.x = p.x + _b.x; this.cursor.z = p.z + _b.z; }
      if (!world.isInsideBounds(this.cursor.x, this.cursor.z)) { this.cursor.x = px; this.cursor.z = pz; }
      this.cursor.y = world.getHeightAt(this.cursor.x, this.cursor.z);
    }
    this.ring.animate(this.cursor, this.ctx.time);
    this.emitTargeting();

    if (!input.isMouseDown(MouseButtons.FIRE)) this.needRelease = false;
    if (this.escRequested || input.wasMousePressed(MouseButtons.AIM)) { this.escRequested = false; this.cancelTargeting(); return; }
    if (!this.needRelease && input.wasMousePressed(MouseButtons.FIRE) && this._armed) this.confirm(defOf(this._armed));
  }

  /** Leave the top view / wheel / charge, restoring camera + controls. Keeps the armed call. */
  private cancelTargeting(): void {
    const host = this.host();
    this.cancelCharge();
    if (this.wheelOpen && host) this.closeWheel(host);
    else if (this.wheelOpen) { this.wheelOpen = false; this.wheelHover = null; this.ctx.bus.emit('stratagem:wheelChanged', { open: false, hover: null }); }
    if (!this.topview) return;
    this.topview = false;
    this.escRequested = false;
    window.removeEventListener('keydown', this.escHandler, true);
    if (host) {
      host.setCameraOverride(null);
      host.setControlsEnabled(true);
      host.setLookLocked(false);
    }
    this.ring.show(false);
    this.lastEmitted.set(NaN, NaN, NaN);
    this.ctx.bus.emit('stratagem:targeting', { active: false, kind: null, position: null });
  }

  /* ─────────────────────────── confirm / calls ─────────────────────────── */
  private confirm(def: StratagemDef): void {
    const target = this.cursor.clone();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.cancelTargeting();
    this.setGroundTargeting(false);
    this.startCooldown(def.cooldown);
    this._armed = null;
    this.ctx.bus.emit('stratagem:armed', { id: null });
    const call = this.createCall(def.id, target, def.delay, seed, true);
    this.audio('ui_click', undefined, 0.6);
    const net = this.ctx.net;
    if (this.ctx.isMultiplayer && net) {
      net.send({ t: 'strat', ev: 'call', callId: call.id, kind: def.id, p: toTuple(target), eta: def.delay, seed }, 'others');
    }
  }

  private createCall(kind: StratagemId, position: THREE.Vector3, eta: number, seed: number, local: boolean, id?: string, caller?: PeerId | null): Call {
    const ctx = this.ctx;
    const callId = id ?? `${ctx.net?.localId ?? 'sp'}-${++this.seq}`;
    const who = caller !== undefined ? caller : (ctx.net?.localId ?? null);
    const call = new Call(callId, kind, position.clone(), ctx.time + eta, who, seed, local);
    this.calls.push(call);
    this.byId.set(callId, call);
    call.marker = new CallMarker(this.geo, kind, call.def.radius);
    call.marker.group.position.copy(position);
    this.group.add(call.marker.group);
    if (kind === 'supply_drop') this.prepareSupply(call);
    else if (kind === 'structure_drop') this.prepareStructures(call);
    ctx.bus.emit('stratagem:called', { callId, kind, position: call.position, landsAt: call.landsAt, caller: who });
    return call;
  }

  private removeMarker(call: Call): void {
    if (!call.marker) return;
    this.group.remove(call.marker.group);
    call.marker.dispose();
    call.marker = null;
  }

  private landed(call: Call): void {
    this.ctx.bus.emit('stratagem:landed', { callId: call.id, kind: call.kind, position: call.position });
  }
  private ended(call: Call): void {
    if (call.stage === 'done') return;
    call.stage = 'done';
    this.ctx.bus.emit('stratagem:ended', { callId: call.id, kind: call.kind });
  }

  /** Radial damage of an impact: enemies only on the caller's client, the local player everywhere (linear falloff). */
  private impactDamage(call: Call, center: THREE.Vector3, radius: number, damage: number): void {
    const ctx = this.ctx;
    if (call.local && ctx.enemies) ctx.enemies.applyExplosion(center, radius, damage);
    const p = ctx.player;
    if (p && !p.isDead) {
      _a.copy(p.position); _a.y += 0.9;
      const d = _a.distanceTo(center);
      if (d < radius) {
        const dmg = damage * (1 - d / radius);
        if (dmg > 1) p.takeDamage(dmg, center.clone());
      }
    }
  }

  private updateCalls(dt: number): void {
    // Call timing is expressed in ctx.time (unscaled, keeps running while the game is frozen) so the HUD can show ETAs.
    // While the simulation is paused (dt === 0, single-player pause) shift every pending timestamp forward by the wall
    // time that passed, so an incoming call never lands or ticks during a pause.
    const now = this.ctx.time;
    const wall = this.lastClock >= 0 ? now - this.lastClock : 0;
    this.lastClock = now;
    if (dt <= 0 && wall > 0) {
      for (const c of this.calls) {
        (c as { landsAt: number }).landsAt += wall;
        for (const s of c.structures) (s as { landAt: number }).landAt += wall;
      }
      return;
    }
    const t = now;
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (c.marker) {
        const frac = THREE.MathUtils.clamp(1 - (c.landsAt - t) / Math.max(0.01, c.def.delay), 0, 1);
        c.marker.animate(t, frac);
      }
      if (c.stage === 'incoming' && !c.audioStarted && c.landsAt - t <= 2.5) {
        c.audioStarted = true;
        this.audio('hellpod_fall', c.position, 0.8);
      }
      switch (c.kind) {
        case 'orbital_laser': this.updateLaser(c, t, dt); break;
        case 'airstrike': this.updateAirstrike(c, t); break;
        case 'supply_drop': this.updateSupply(c, t); break;
        case 'structure_drop': this.updateStructures(c, t); break;
      }
    }
  }

  /* ─────────────────────────── orbital laser ─────────────────────────── */
  private updateLaser(c: Call, t: number, _dt: number): void {
    if (c.stage === 'incoming') {
      if (t < c.landsAt) return;
      c.stage = 'active';
      this.removeMarker(c);
      c.beam = new LaserBeam(this.geo, LASER_RADIUS);
      c.beam.group.position.copy(c.position);
      this.group.add(c.beam.group);
      c.nextTick = t;
      this.landed(c);
      this.audio('explosion', c.position, 0.7);
      this.shakeFrom(c.position, 0.6);
    }
    if (c.stage !== 'active' || !c.beam) return;
    const since = t - c.landsAt;
    const remaining = LASER_DURATION - since;
    if (remaining <= 0) {
      this.group.remove(c.beam.group); c.beam.dispose(); c.beam = null;
      this.ended(c);
      return;
    }
    c.beam.animate(since, remaining);
    while (t >= c.nextTick) {
      c.nextTick += LASER_TICK;
      this.impactDamage(c, c.position, LASER_RADIUS, LASER_DPS * LASER_TICK);
      this.burst(sparkBurst(c.position, KIND_COLOR.orbital_laser));
      this.shakeFrom(c.position, 0.12);
    }
  }

  /* ─────────────────────────── airstrike ─────────────────────────── */
  private updateAirstrike(c: Call, t: number): void {
    if (c.stage === 'incoming') {
      if (t < c.landsAt) return;
      c.stage = 'active';
      this.removeMarker(c);
      c.fireball = new Fireball(this.geo, AIRSTRIKE_RADIUS);
      c.fireball.group.position.copy(c.position);
      this.group.add(c.fireball.group);
      this.impactDamage(c, c.position, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE);
      this.burst(dustBurst(c.position, AIRSTRIKE_RADIUS));
      this.burst(sparkBurst(c.position, 0xffa040));
      this.shakeFrom(c.position, 1.0);
      this.audio('explosion', c.position, 1);
      this.landed(c);
    }
    if (c.stage !== 'active' || !c.fireball) return;
    if (!c.fireball.animate(t - c.landsAt) || t - c.landsAt >= AIRSTRIKE_FX_TIME) {
      this.group.remove(c.fireball.group); c.fireball.dispose(); c.fireball = null;
      this.ended(c);
    }
  }

  /* ─────────────────────────── supply drop ─────────────────────────── */
  private prepareSupply(c: Call): void {
    c.crate = new SupplyCrateMesh(this.geo);
    c.crate.group.position.set(c.position.x, c.position.y + SUPPLY_DROP_HEIGHT, c.position.z);
    c.crate.group.visible = false;
    c.crate.group.rotation.y = (c.seed % 628) / 100;
    this.group.add(c.crate.group);
  }

  private updateSupply(c: Call, t: number): void {
    if (c.stage === 'incoming') {
      const crate = c.crate!;
      const k = (t - (c.landsAt - SUPPLY_FALL_TIME)) / SUPPLY_FALL_TIME;   // 0 = release, 1 = touchdown
      if (k >= 0 && k < 1) {
        crate.group.visible = true;
        crate.setFalling(true);
        crate.group.position.y = c.position.y + SUPPLY_DROP_HEIGHT * (1 - k * k);
        crate.group.rotation.y += 0.01;
      }
      if (t < c.landsAt) return;
      c.stage = 'active';
      crate.group.visible = true;
      crate.setFalling(false);
      crate.group.position.copy(c.position);
      this.removeMarker(c);
      this.impactDamage(c, c.position, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE);
      this.burst(dustBurst(c.position, SUPPLY_IMPACT_RADIUS));
      this.shakeFrom(c.position, 0.5);
      this.audio('explosion', c.position, 0.5);
      c.obstacleRemover = this.addObstacle({ position: c.position.clone(), radius: 0.8, height: 1.2 });
      const id = 'supply:' + c.id;
      const ctx = this.ctx;
      c.interactable = {
        id, position: c.position, radius: 2.4,
        getPrompt: () => (c.looted ? null : '보급 상자 열기'),
        canInteract: () => !c.looted && c.stage === 'active',
        interact: () => { ctx.bus.emit('crate:open', { crateId: id, tier: SUPPLY_CRATE_TIER, position: c.position }); },
      };
      ctx.interactables.register(c.interactable);
      this.landed(c);
    }
  }

  private onCrateLooted(crateId: string): void {
    if (!crateId.startsWith('supply:')) return;
    const c = this.byId.get(crateId.slice(7));
    if (!c || c.looted) return;
    c.looted = true;
    c.crate?.setLooted();
    this.ended(c);
  }

  /* ─────────────────────────── structures ─────────────────────────── */
  private addObstacle(o: Obstacle): (() => void) | null {
    const w = this.world();
    if (!w) return null;
    if (typeof w.addObstacle !== 'function') {
      if (!this.warnedNoObstacle) { this.warnedNoObstacle = true; console.warn('[stratagems] WorldRef.addObstacle missing — structures have no collision'); }
      return null;
    }
    return w.addObstacle(o);
  }

  private prepareStructures(c: Call): void {
    const world = this.world();
    const rnd = new Random(c.seed);
    const placed: THREE.Vector3[] = [];
    for (let i = 0; i < STRUCTURE_COUNT; i++) {
      let pos: THREE.Vector3 | null = null;
      for (let tries = 0; tries < 24 && !pos; tries++) {
        const a = rnd.next() * Math.PI * 2, r = Math.sqrt(rnd.next()) * STRUCTURE_SCATTER;
        const x = c.position.x + Math.cos(a) * r, z = c.position.z + Math.sin(a) * r;
        if (world && !world.isInsideBounds(x, z)) continue;
        let ok = true;
        for (const q of placed) if ((q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) < STRUCTURE_MIN_GAP * STRUCTURE_MIN_GAP) { ok = false; break; }
        if (!ok) continue;
        pos = new THREE.Vector3(x, world ? world.getHeightAt(x, z) : c.position.y, z);
      }
      if (!pos) pos = new THREE.Vector3(c.position.x + i * STRUCTURE_MIN_GAP, c.position.y, c.position.z);
      placed.push(pos);
      const yaw = rnd.next() * Math.PI * 2;
      const mesh = new BarricadeMesh(this.geo, yaw);
      mesh.group.position.set(pos.x, pos.y + STRUCTURE_DROP_HEIGHT, pos.z);
      mesh.group.visible = false;
      this.group.add(mesh.group);
      const s = new Structure(`${c.id}:${i}`, c, i, pos, c.landsAt + i * STRUCTURE_STAGGER, mesh, (st, amount) => this.damageStructure(st, amount, true));
      c.structures.push(s);
    }
  }

  private updateStructures(c: Call, t: number): void {
    if (c.stage === 'done') return;
    for (const s of c.structures) {
      if (s.landed) continue;
      const k = (t - (s.landAt - STRUCTURE_FALL_TIME)) / STRUCTURE_FALL_TIME;
      if (k < 0) continue;
      if (k < 1) {
        s.mesh.group.visible = true;
        s.mesh.group.position.y = s.position.y + STRUCTURE_DROP_HEIGHT * (1 - k * k);
        continue;
      }
      s.landed = true;
      s.mesh.group.visible = true;
      s.mesh.group.position.copy(s.position);
      this.impactDamage(c, s.position, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE);
      this.burst(dustBurst(s.position, STRUCTURE_IMPACT_RADIUS));
      this.shakeFrom(s.position, 0.45);
      this.audio('explosion', s.position, 0.45);
      s.remover = this.addObstacle({ position: s.position.clone(), radius: 1.35, height: 1.5, destructible: s.destructible });
      if (s.hp <= 0) this.destroyStructure(s);   // destroyed by a `structHp` that arrived before it landed
      if (++c.landedCount === 1) { this.removeMarker(c); c.stage = 'active'; this.landed(c); }
    }
    if (c.landedCount >= c.structures.length) this.ended(c);
  }

  private damageStructure(s: Structure, amount: number, broadcast: boolean): void {
    if (s.destroyed || amount <= 0) return;
    this.setStructureHp(s, s.hp - amount);
    if (broadcast && this.ctx.isMultiplayer && this.ctx.net) {
      this.ctx.net.send({ t: 'strat', ev: 'structHp', callId: s.call.id, index: s.index, hp: Math.max(0, Math.round(s.hp)) }, 'others');
    }
  }

  private setStructureHp(s: Structure, hp: number): void {
    if (s.destroyed) return;
    s.hp = Math.max(0, hp);
    s.mesh.setDamage(1 - s.hp / STRUCTURE_HP);
    this.ctx.bus.emit('structure:damaged', { id: s.id, hp: s.hp, maxHp: STRUCTURE_HP, position: s.position });
    if (s.hp <= 0 && s.landed) this.destroyStructure(s);
  }

  private destroyStructure(s: Structure): void {
    if (s.destroyed) return;
    s.destroyed = true;
    s.remover?.(); s.remover = null;
    this.group.remove(s.mesh.group); s.mesh.dispose();
    s.rubble = makeRubble(this.geo, s.index + s.call.seed % 13);
    s.rubble.position.copy(s.position);
    this.group.add(s.rubble);
    this.burst(dustBurst(s.position, 2.0, true));
    this.shakeFrom(s.position, 0.3);
    this.audio('explosion', s.position, 0.35);
    this.ctx.bus.emit('structure:destroyed', { id: s.id, position: s.position });
  }

  /** Radial damage to standing structures (grenades). */
  private splashStructures(center: THREE.Vector3, radius: number, damage: number): void {
    for (const c of this.calls) for (const s of c.structures) {
      if (!s.landed || s.destroyed) continue;
      const d = s.position.distanceTo(center);
      if (d < radius + 1.3) {
        const dmg = damage * (1 - Math.max(0, d - 1.3) / radius);
        if (dmg > 1) this.damageStructure(s, dmg, true);
      }
    }
  }

  private disposeStructure(s: Structure): void {
    s.remover?.(); s.remover = null;
    if (!s.destroyed) { this.group.remove(s.mesh.group); s.mesh.dispose(); }
    if (s.rubble) {
      this.group.remove(s.rubble);
      (s.rubble.userData.mat as THREE.Material | undefined)?.dispose();
      s.rubble = null;
    }
  }

  /* ─────────────────────────── net ─────────────────────────── */
  private ensureNetHooks(): void {
    if (this.netHooked) return;
    const net = this.ctx.net;
    if (!net) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('strat', (msg, from) => {
        if (msg.ev === 'call') {
          if (this.byId.has(msg.callId)) return;
          const p = new THREE.Vector3(msg.p[0], msg.p[1], msg.p[2]);
          const w = this.world();
          if (w) p.y = w.getHeightAt(p.x, p.z);
          this.createCall(msg.kind, p, msg.eta, msg.seed, false, msg.callId, from);
        } else if (msg.ev === 'structHp') {
          const s = this.byId.get(msg.callId)?.structures[msg.index];
          if (s && !s.destroyed && msg.hp < s.hp) this.setStructureHp(s, msg.hp);
        }
      }),
    );
  }

  /* ─────────────────────────── cleanup ─────────────────────────── */
  private removeCall(c: Call): void {
    this.removeMarker(c);
    if (c.beam) { this.group.remove(c.beam.group); c.beam.dispose(); c.beam = null; }
    if (c.fireball) { this.group.remove(c.fireball.group); c.fireball.dispose(); c.fireball = null; }
    if (c.crate) { this.group.remove(c.crate.group); c.crate.dispose(); c.crate = null; }
    if (c.interactable) { this.ctx.interactables.unregister(c.interactable.id); c.interactable = null; }
    c.obstacleRemover?.(); c.obstacleRemover = null;
    for (const s of c.structures) this.disposeStructure(s);
    c.structures.length = 0;
    this.byId.delete(c.id);
    const i = this.calls.indexOf(c);
    if (i >= 0) this.calls.splice(i, 1);
  }

  private clearAll(): void {
    this.putAway();
    this.gHeld = false;
    for (let i = this.calls.length - 1; i >= 0; i--) this.removeCall(this.calls[i]);
    for (const b of this.bursts) { this.group.remove(b.points); b.dispose(); }
    this.bursts.length = 0;
  }
}
