import * as THREE from 'three';
import {
  IMPLANT_AT_DAMAGE, IMPLANT_AT_RADIUS, IMPLANT_BARRIER_BREAK_LOCKOUT, IMPLANT_BARRIER_HP, IMPLANT_BARRIER_REGEN,
  IMPLANT_DASH_DISTANCE, IMPLANT_GRAPPLE_RANGE,
  IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC, IMPLANT_OVERCHARGE_BUFF_HP_RATIO, IMPLANT_OVERCHARGE_ENERGY,
  IMPLANT_OVERCHARGE_RANGE, IMPLANT_OVERCHARGE_REGEN_TIME, IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC, IMPLANT_OVERCHARGE_SPEED_MUL,
  IMPLANT_SCAN_MAX_PULSES, IMPLANT_SCAN_PULSE_INTERVAL, IMPLANT_SCAN_RADIUS_STEP, IMPLANT_SCAN_REVEAL_TIME,
  Keys, MouseButtons, PLAYER_RADIUS,
  type BuffMessage, type GameContext, type GameSystem, type ImplantDef, type ImplantId, type ImplantMessage,
  type ImplantsRef, type PeerId, type PlayerRef, type PlayerWeaponHost, type RelayTarget,
  type Vec3Tuple,
} from '@/shared';
import { IMPLANT_DEFS, getImplantDef, implantHex, isImplantId } from './ImplantDefs';
import { ImplantDevice } from './devices/ImplantDevice';
import { BarrierField } from './effects/Barrier';
import { GrappleWire } from './effects/Grapple';
import { RocketPool, type RocketImpact } from './effects/AtLauncher';
import { OverchargeBeam, allyPoint, findAlly } from './effects/Overcharge';
import { collectScanTargets } from './effects/Scan';
import { ImplantFx } from './fx/ImplantFx';
import { RemoteImplants } from './RemoteImplants';

type Host = PlayerRef & Partial<PlayerWeaponHost>;

/** Shield hp removed by one blocked hostile projectile. */
const BARRIER_BLOCK_DAMAGE = 30;
/** The shield may be redeployed once it has regenerated this fraction of its hp. */
const BARRIER_MIN_DEPLOY_RATIO = 0.1;
/** Distance in front of the deployer the shield is planted. */
const BARRIER_OFFSET = 2.2;
/** Speed (m/s) of the grapple hook flying to its anchor. */
const GRAPPLE_FLY_SPEED = 90;
/** The pull auto-releases when the player gets this close to the anchor, or after this long. */
const GRAPPLE_ARRIVE_DIST = 2.6;
const GRAPPLE_MAX_TIME = 5;
/** Cooldown / barrier / energy readouts are pushed to the HUD at most this often (plus every discrete change). */
const HUD_EMIT_INTERVAL = 0.1;
/** Overcharge network throttles. */
const HEAL_SEND_INTERVAL = 0.2;
const BOOST_SEND_INTERVAL = 0.5;
/** The buff is refreshed every frame while channelling and lingers this long after the channel ends. */
const BOOST_LINGER = 0.6;
/** Channelling may start only with this much energy (seconds) left. */
const OVERCHARGE_MIN_START = 0.75;
/** Phase 7: `imp beam` refresh period while the overcharge beam is on (on / target change / off go out at once). */
const BEAM_SEND_INTERVAL = 0.25;
/** Blocked hits between two replicated shield-durability updates. */
const BARRIER_SEND_EVERY_HITS = 4;

const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
const _from = new THREE.Vector3(), _muzzle = new THREE.Vector3(), _hitPt = new THREE.Vector3();
const _bp = new THREE.Vector3(), _tmp = new THREE.Vector3();

function tuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}

/**
 * Tactical implants (전술 임플란트). Publishes `ctx.implants`.
 *
 * One implant is equipped in the ship and carried into the raid. **Q** (`Keys.IMPLANT`) drives it in three ways
 * (`ImplantDef.mode`, reworked 2026-09-06):
 *   - `instant` (갈고리 / 대시 / 배리어): the press casts. The grapple fires at the crosshair anchor right away and
 *     a second press cuts the wire; the gun stays in hand throughout.
 *   - `hold` (정찰 / 오버차지): the effect runs while Q is held — scan pulses every second, the overcharge channel
 *     heals the caster slowly (and the ally under the crosshair faster) and drains an energy pool that refills
 *     while released. The gun stays in hand.
 *   - `wielded` (대전차포, the only one left): Q takes the launcher into the hands (weapons holster), LMB fires,
 *     Q — or any weapon key, handled by weapons/ via `stow()` — puts it away.
 *
 * Everything is simulated locally and only *shown* to the other players (`imp` messages); friendly effects on
 * someone else's character travel as `buff`. Cooldowns are multiplied by `ctx.progression?.derived.implantCooldownMul`.
 */
export class ImplantSystem implements GameSystem, ImplantsRef {
  readonly name = 'implants';

  private ctx!: GameContext;
  private fx!: ImplantFx;
  private rockets!: RocketPool;
  private remote!: RemoteImplants;
  private barrier!: BarrierField;
  private wire!: GrappleWire;
  private beam!: OverchargeBeam;

  private equippedId: ImplantId | null = null;
  private device: ImplantDevice | null = null;
  private deviceAttached = false;
  private wieldedFlag = false;
  private holdingFlag = false;

  private chargesLeft = 1;
  private cdRemaining = 0;
  private cdTotal = 0;
  private hudAcc = 0;

  /** Grapple. */
  private grappleState: 'idle' | 'flying' | 'attached' = 'idle';
  private readonly grapplePoint = new THREE.Vector3();
  private readonly grappleTip = new THREE.Vector3();
  private grappleFlown = 0;
  private grappleTimer = 0;
  private grappleTargetValid = false;
  private grappleTargetDist = 0;

  /** Scan. */
  private scanning = false;
  private scanTimer = 0;
  private scanPulses = 0;

  /** Overcharge. */
  private ocEnergy = IMPLANT_OVERCHARGE_ENERGY;
  private ocActive = false;
  private ocTarget: PeerId | null = null;
  private ocHealAcc = 0;
  private ocSendAcc = 0;
  private ocBoostAcc = 0;
  /** Phase 7: last `imp beam` state sent to the squad (on / target / self) + seconds since. */
  private beamNetOn = false;
  private beamNetTarget: PeerId | null = null;
  private beamNetSelf = false;
  private beamNetAcc = 0;
  private energyEmitAcc = 0;
  private lastEnergyEmitted = -1;

  /** Barrier. */
  private barrierLocked = false;
  private barrierSendAcc = 0;
  private barrierEmitAcc = 0;

  private profileApplied = false;
  private netHooked = false;
  private readonly unsubs: Array<() => void> = [];
  private readonly remoteBarriers: BarrierField[] = [];

  /* ═══════════════════════════ ImplantsRef ═══════════════════════════ */
  get equipped(): ImplantId | null { return this.equippedId; }
  get wielded(): boolean { return this.wieldedFlag; }
  get blocksWeapons(): boolean { return this.wieldedFlag; }
  get holding(): boolean { return this.holdingFlag; }
  get cooldownRemaining(): number { return this.cdRemaining; }
  get cooldownTotal(): number { return this.cdTotal || this.effectiveCooldown(); }
  get charges(): number { return this.chargesLeft; }
  get maxCharges(): number { return this.def()?.charges ?? 0; }
  get barrierHp(): number { return this.equippedId === 'barrier' ? this.barrier.hp : 0; }
  get barrierMaxHp(): number { return this.equippedId === 'barrier' ? this.barrier.maxHp : 0; }
  get barrierActive(): boolean { return this.barrier ? this.barrier.active : false; }
  get barrierLockout(): number { return this.equippedId === 'barrier' && this.barrierLocked ? this.cdRemaining : 0; }
  get energy(): number { return this.equippedId === 'overcharge' ? this.ocEnergy : 0; }
  get energyMax(): number { return this.equippedId === 'overcharge' ? IMPLANT_OVERCHARGE_ENERGY : 0; }

  getDef(id: ImplantId): ImplantDef | undefined { return getImplantDef(id); }
  getAllDefs(): readonly ImplantDef[] { return IMPLANT_DEFS; }

  /** Ship only: refuses (and changes nothing) while a raid is running. */
  setEquipped(id: ImplantId | null): boolean {
    if (this.ctx?.isRaidActive()) {
      this.ctx.bus.emit('ui:notify', { text: '레이드 중에는 임플란트를 바꿀 수 없다', kind: 'warning', duration: 2 });
      return false;
    }
    if (id !== null && !isImplantId(id)) return false;
    this.profileApplied = true;
    if (id === this.equippedId) return true;
    this.stow();
    this.equippedId = id;
    this.resetRuntime();
    this.ctx?.bus.emit('implant:equipped', { id });
    this.emitCooldown(true);
    this.emitBarrier();
    this.emitEnergy(true);
    return true;
  }

  /**
   * Q pressed. Instant implants cast (grapple fires / releases, dash, barrier toggle); the wielded launcher toggles
   * in / out of the hands. Hold implants are driven per frame from `update` (this is a no-op for them).
   */
  activate(): void {
    const ctx = this.ctx;
    const def = this.def();
    if (!def || !ctx) return;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return;
    if (!ctx.isGameplayActive()) return;
    switch (def.id) {
      case 'grapple': this.castGrapple(); break;
      case 'dash': this.castDash(); break;
      case 'barrier': this.toggleBarrier(); break;
      case 'atlauncher': if (this.wieldedFlag) this.stow(); else this.wield(); break;
      default: break;
    }
  }

  /** Force the wielded implant away and end any channel (weapon swap, death, phase change). */
  stow(): void {
    this.releaseGrapple(true);
    this.stopScan();
    this.setOvercharge(false);
    if (!this.wieldedFlag) return;
    const id = this.equippedId;
    this.detachDevice();
    this.wieldedFlag = false;
    if (id) {
      this.ctx?.bus.emit('implant:wieldChanged', { id, wielded: false });
      this.send({ t: 'imp', ev: 'wield', id, wielded: false });
    }
  }

  /**
   * Hostile-projectile blocking for the local barrier and every replicated peer barrier.
   * Player shields ignore friendly fire, so `fromEnemy === false` never blocks.
   * **Pure query** (Phase 9): safe for per-tick line-of-sight tests. A caller whose shot really stopped here calls
   * `damageBarrier(owner, point)` once — that is where the local shield loses durability and sparks fly.
   */
  raycastBarrier(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, fromEnemy: boolean): { point: THREE.Vector3; owner: PeerId | 'local' } | null {
    if (!fromEnemy || !this.ctx) return null;
    let best: BarrierField | null = null;
    let bestDist = Infinity;
    if (this.barrier.active && this.barrier.intersect(origin, dir, maxDist, _hitPt)) {
      best = this.barrier; bestDist = _hitPt.distanceToSquared(origin); _bp.copy(_hitPt);
    }
    for (const b of this.remote.getBarriers(this.remoteBarriers)) {
      if (!b.intersect(origin, dir, maxDist, _hitPt)) continue;
      const d = _hitPt.distanceToSquared(origin);
      if (d < bestDist) { bestDist = d; best = b; _bp.copy(_hitPt); }
    }
    if (!best) return null;
    return { point: _bp.clone(), owner: best.owner };
  }

  /**
   * A projectile really stopped at a barrier: the local shield takes `amount` (`BARRIER_BLOCK_DAMAGE` by default) +
   * `implant:barrierHit` (+ collapse / lockout / `imp barrier` sync), a peer's shield only sparks — its owner is
   * authoritative over its hp and broadcasts it.
   */
  damageBarrier(owner: PeerId | 'local', point: THREE.Vector3, amount = BARRIER_BLOCK_DAMAGE): void {
    if (!this.ctx) return;
    if (owner === 'local') { if (this.barrier.active) this.onBarrierBlocked(point, amount); }
    else this.fx.spark(point, implantHex('barrier'), 0.3);
  }

  /** Back to a fresh raid state (mission start / abort / hub). */
  reset(): void {
    this.stow();
    this.resetRuntime();
    this.fx?.clear();
    this.rockets?.clear();
    this.remote?.clear();
    this.emitCooldown(true);
    this.emitBarrier();
    this.emitEnergy(true);
  }

  /* ═══════════════════════════ GameSystem ═══════════════════════════ */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.implants = this;
    this.fx = new ImplantFx(ctx.scene);
    this.rockets = new RocketPool(ctx.scene, this.fx, implantHex('atlauncher'), (h) => this.onRocketImpact(h));
    this.remote = new RemoteImplants(ctx, this.fx, this.rockets);
    this.barrier = new BarrierField(ctx.scene, implantHex('barrier'), 'local');
    this.wire = new GrappleWire(ctx.scene, this.fx, implantHex('grapple'));
    this.beam = new OverchargeBeam(ctx.scene, this.fx, implantHex('overcharge'), implantHex('dash'));

    const b = ctx.bus;
    this.unsubs.push(
      b.on('progress:loaded', ({ profile }) => this.applyProfile(profile.implant)),
      b.on('game:newMission', () => this.reset()),
      b.on('game:abort', () => this.reset()),
      b.on('hub:entered', () => this.reset()),
      b.on('player:died', () => { this.stow(); this.dropBarrier(); }),
      b.on('player:downed', () => { this.stow(); this.dropBarrier(); }),
      b.on('net:remotePlayerRemoved', ({ id }) => this.remote.remove(id)),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase !== 'playing' && phase !== 'extracting' && phase !== 'shipLanded' && phase !== 'liftoff') {
          this.stow();
          this.dropBarrier();
        }
      }),
    );
    this.ensureNetHooks();
    this.emitCooldown(true);
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    this.applyProfileLazily();

    this.fx.update(dt);
    this.rockets.update(dt, ctx);
    this.remote.update(dt);
    this.wire.update(dt);
    this.beam.update(dt);
    this.barrier.update(dt);

    const def = this.def();
    const p = ctx.player;
    const alive = !!p && !p.isDead && !p.isDowned;
    const active = ctx.isGameplayActive() && ctx.input.isPointerLocked && alive;

    if (!ctx.isGameplayPhase() || !alive) {
      this.stow();
      if (this.barrier.active && !alive) this.dropBarrier();
    }

    this.tickCooldown(dt);
    this.tickBarrierRegen(dt, def);
    this.tickEnergy(dt, def);

    // ── Q: press = cast / toggle; hold implants read the key state below
    const qPressed = active && ctx.input.wasPressed(Keys.IMPLANT);
    const qDown = active && ctx.input.isDown(Keys.IMPLANT);
    if (qPressed && def?.mode !== 'hold') this.activate();

    if (this.device) {
      const maxC = Math.max(1, this.maxCharges);
      this.device.update(dt, this.chargesLeft > 0 ? this.chargesLeft / maxC : 0);
      if (!this.deviceAttached) this.attachDevice();
    }

    if (!def) return;
    switch (def.id) {
      case 'grapple': this.updateGrapple(dt, active); break;
      case 'scan': this.updateScan(dt, qDown, qPressed); break;
      case 'overcharge': this.updateOvercharge(dt, qDown, qPressed); break;
      case 'atlauncher': if (this.wieldedFlag) this.updateLauncher(active); break;
      default: break;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.stow();
    this.remote?.dispose();
    this.rockets?.dispose();
    this.wire?.dispose();
    this.beam?.dispose();
    this.barrier?.dispose();
    this.device?.dispose();
    this.fx?.dispose();
    if (this.ctx && (this.ctx.implants as unknown) === this) this.ctx.implants = null;
  }

  /* ═══════════════════════════ equip / wield ═══════════════════════════ */
  private def(): ImplantDef | undefined {
    return this.equippedId ? getImplantDef(this.equippedId) : undefined;
  }

  private applyProfile(id: ImplantId | null): void {
    this.profileApplied = true;
    if (id !== null && !isImplantId(id)) id = null;
    if (id === this.equippedId) return;
    this.stow();
    this.equippedId = id;
    this.resetRuntime();
    this.emitCooldown(true);
    this.emitBarrier();
    this.emitEnergy(true);
  }

  /** progression/ may register after us; pick up its saved implant as soon as it exists. */
  private applyProfileLazily(): void {
    if (this.profileApplied) return;
    const prog = this.ctx.progression;
    if (prog) { this.applyProfile(prog.profile.implant); return; }
    if (this.equippedId === null) {
      // offline / no profile yet: everyone owns all six, so hand out the first one instead of nothing
      this.equippedId = IMPLANT_DEFS[0].id;
      this.resetRuntime();
      this.emitCooldown(true);
    }
  }

  private resetRuntime(): void {
    const def = this.def();
    this.chargesLeft = def?.charges ?? 0;
    this.cdRemaining = 0;
    this.cdTotal = this.effectiveCooldown();
    this.grappleState = 'idle';
    this.grappleFlown = 0;
    this.grappleTimer = 0;
    this.grappleTargetValid = false;
    this.scanning = false;
    this.scanPulses = 0;
    this.wire?.hide();
    this.beam?.hide();
    this.ocActive = false;
    this.ocTarget = null;
    this.ocHealAcc = 0;
    this.ocEnergy = IMPLANT_OVERCHARGE_ENERGY;
    this.holdingFlag = false;
    this.barrierLocked = false;
    if (this.barrier) { this.barrier.stow(); this.barrier.hp = IMPLANT_BARRIER_HP; }
    this.setGrapplePull(null);
  }

  private wield(): void {
    const def = this.def();
    if (!def || def.mode !== 'wielded' || this.wieldedFlag) return;
    this.wieldedFlag = true;
    this.device?.dispose();
    this.device = new ImplantDevice(def.id);
    this.deviceAttached = false;
    this.attachDevice();
    this.ctx.bus.emit('implant:wieldChanged', { id: def.id, wielded: true });
    this.ctx.bus.emit('audio:play', { id: 'implant_wield', volume: 0.6 });
    this.send({ t: 'imp', ev: 'wield', id: def.id, wielded: true });
  }

  private attachDevice(): void {
    if (!this.device || this.deviceAttached) return;
    const socket = this.weaponSocket();
    if (!socket) return;
    socket.add(this.device.root);
    this.deviceAttached = true;
  }

  private detachDevice(): void {
    if (!this.device) return;
    this.device.dispose();
    this.device = null;
    this.deviceAttached = false;
  }

  private weaponSocket(): THREE.Object3D | null {
    const p = this.ctx.player as Host | null;
    if (!p || typeof p.getWeaponSocket !== 'function') return null;
    try { return p.getWeaponSocket(); } catch { return null; }
  }

  /** Aim ray from the reticle; falls back to eye + horizontal forward when the host has no camera ray. */
  private aimRay(origin: THREE.Vector3, dir: THREE.Vector3): boolean {
    const p = this.ctx.player as Host | null;
    if (!p) return false;
    if (typeof p.getAimRay === 'function') { p.getAimRay(origin, dir); return true; }
    p.getEyePosition(origin);
    p.getForward(dir);
    return true;
  }

  /**
   * World position an effect leaves from: the wielded device's muzzle, else the hand (weapon socket) so the
   * grapple wire and the overcharge beam start at the gun, else the eye.
   */
  private muzzle(out: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    if (this.device && this.deviceAttached) {
      this.device.muzzle.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(this.device.muzzle.matrixWorld);
      return out;
    }
    const socket = this.weaponSocket();
    if (socket) {
      socket.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(socket.matrixWorld);
      return out.addScaledVector(dir, 0.35);
    }
    const p = this.ctx.player;
    if (p) { p.getEyePosition(out); out.addScaledVector(dir, 0.45); return out; }
    return out.set(0, 0, 0);
  }

  /* ═══════════════════════════ charges & cooldown ═══════════════════════════ */
  private cooldownMul(): number {
    const mul = this.ctx?.progression?.derived?.implantCooldownMul ?? 1;
    return Number.isFinite(mul) && mul > 0 ? mul : 1;
  }

  private effectiveCooldown(): number {
    const def = this.def();
    if (!def) return 0;
    return def.cooldown * this.cooldownMul();
  }

  private get ready(): boolean { return this.chargesLeft > 0 && this.cdRemainingBlocking() <= 0; }

  /** Charge-based implants may fire while a refill is running; single-charge ones may not. */
  private cdRemainingBlocking(): number {
    const def = this.def();
    if (!def) return 1;
    return def.charges > 1 ? 0 : this.cdRemaining;
  }

  /** Spend one charge. `startCooldown` false = the caller starts it later (scan starts it when the train ends). */
  private useCharge(startCooldown = true): boolean {
    if (!this.ready) { this.deny(); return false; }
    this.chargesLeft--;
    if (startCooldown) this.startCooldown();
    this.emitCooldown(true);
    return true;
  }

  private startCooldown(seconds?: number): void {
    const t = seconds ?? this.effectiveCooldown();
    if (t <= 0) return;
    this.cdRemaining = t;
    this.cdTotal = t;
    this.emitCooldown(true);
  }

  private tickCooldown(dt: number): void {
    if (dt <= 0) return;
    this.hudAcc += dt;
    if (this.cdRemaining <= 0) return;
    this.cdRemaining = Math.max(0, this.cdRemaining - dt);
    if (this.cdRemaining === 0) {
      const def = this.def();
      const max = def?.charges ?? 1;
      if (this.chargesLeft < max) {
        this.chargesLeft++;
        if (this.chargesLeft < max) { this.startCooldown(); return; }
      }
      if (this.barrierLocked) { this.barrierLocked = false; this.barrier.hp = this.barrier.maxHp; this.emitBarrier(); }
      this.emitCooldown(true);
      this.ctx.bus.emit('audio:play', { id: 'implant_ready', volume: 0.4 });
      return;
    }
    if (this.hudAcc >= HUD_EMIT_INTERVAL) this.emitCooldown(false);
  }

  private emitCooldown(force: boolean): void {
    const def = this.def();
    if (!def || !this.ctx) return;
    if (!force && this.hudAcc < HUD_EMIT_INTERVAL) return;
    this.hudAcc = 0;
    this.ctx.bus.emit('implant:cooldownChanged', {
      id: def.id,
      remaining: this.cdRemaining,
      total: this.cdTotal || this.effectiveCooldown(),
      charges: this.chargesLeft,
      maxCharges: def.charges,
    });
  }

  private emitBarrier(): void {
    if (!this.ctx || !this.barrier) return;
    this.ctx.bus.emit('implant:barrierChanged', {
      hp: this.barrier.hp, maxHp: this.barrier.maxHp, active: this.barrier.active,
    });
  }

  private emitEnergy(force: boolean): void {
    if (!this.ctx || this.equippedId !== 'overcharge') return;
    const e = Math.round(this.ocEnergy * 20) / 20;
    if (!force && e === this.lastEnergyEmitted) return;
    this.lastEnergyEmitted = e;
    this.ctx.bus.emit('implant:energyChanged', { energy: this.ocEnergy, max: IMPLANT_OVERCHARGE_ENERGY });
  }

  private deny(): void {
    this.ctx?.bus.emit('audio:play', { id: 'ui_deny', volume: 0.45 });
  }

  private activated(id: ImplantId, position: THREE.Vector3): void {
    this.ctx.bus.emit('implant:activated', { id, position: position.clone() });
  }

  /* ═══════════════════════════ 대시 ═══════════════════════════ */
  private castDash(): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    if (!this.useCharge()) return;

    p.getForward(_d);
    _d.y = 0;
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    _from.copy(p.position);

    let dist = IMPLANT_DASH_DISTANCE;
    _o.copy(p.position); _o.y += 1.0;
    const interior = p.interior;
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const hit = interior ? interior.raycast(_o, _d, dist + PLAYER_RADIUS)
      : world ? world.raycast(_o, _d, dist + PLAYER_RADIUS) : null;
    if (hit) dist = Math.max(0, hit.distance - PLAYER_RADIUS - 0.15);

    _t.copy(p.position).addScaledVector(_d, dist);
    const floor = interior ? interior.getFloorAt(_t.x, _t.z) : world ? world.getHeightAt(_t.x, _t.z) : _t.y;
    if (_t.y < floor) _t.y = floor;
    if (interior) interior.resolveCollision(_t, PLAYER_RADIUS);
    else if (world) {
      world.resolveCollision(_t, PLAYER_RADIUS);
      if (!world.isInsideBounds(_t.x, _t.z)) _t.copy(_from);
    }
    // PlayerRef.position is a stable Vector3 instance — teleport by writing into it.
    p.position.copy(_t);

    _tmp.copy(_from); _tmp.y += 0.9;
    _p.copy(_t); _p.y += 0.9;
    this.fx.streak(_tmp, _p, implantHex('dash'), 0.28, 0.45);
    this.fx.spark(_p, implantHex('dash'), 0.5);
    ctx.bus.emit('camera:shake', { intensity: 0.18, duration: 0.12 });
    ctx.bus.emit('audio:play', { id: 'dash', volume: 0.7 });
    ctx.bus.emit('implant:dashed', { position: _t.clone(), direction: _d.clone() });
    this.activated('dash', _t);
    _p.subVectors(_t, _from);
    this.send({ t: 'imp', ev: 'dash', o: tuple(_from), d: tuple(_p) });
  }

  /* ═══════════════════════════ 배리어 ═══════════════════════════ */
  private toggleBarrier(): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    if (this.barrier.active) { this.dropBarrier(); return; }
    if (this.barrierLocked || this.cdRemaining > 0 || this.chargesLeft <= 0) {
      ctx.bus.emit('ui:notify', { text: '배리어 재충전 중', kind: 'warning', duration: 1.2 });
      this.deny();
      return;
    }
    if (this.barrier.hp < this.barrier.maxHp * BARRIER_MIN_DEPLOY_RATIO) {
      ctx.bus.emit('ui:notify', { text: '배리어 충전 중', kind: 'warning', duration: 1.2 });
      this.deny();
      return;
    }
    p.getForward(_d);
    _d.y = 0;
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    _t.copy(p.position).addScaledVector(_d, BARRIER_OFFSET);
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const interior = p.interior;
    _t.y = interior ? interior.getFloorAt(_t.x, _t.z) : world ? world.getHeightAt(_t.x, _t.z) : p.position.y;
    this.barrier.deploy(_t, p.yaw);
    this.emitBarrier();
    this.activated('barrier', _t);
    ctx.bus.emit('audio:play', { id: 'barrier_deploy', position: _t, volume: 0.8 });
    this.sendBarrier(true);
  }

  /** Fold the shield away (Q again, death, phase change). */
  private dropBarrier(): void {
    if (!this.barrier || !this.barrier.active) return;
    this.barrier.stow();
    this.emitBarrier();
    this.ctx.bus.emit('audio:play', { id: 'barrier_stow', volume: 0.5 });
    this.sendBarrier(false);
  }

  /**
   * Stowed shield regenerates `IMPLANT_BARRIER_REGEN`/s. After a collapse it is locked for
   * `IMPLANT_BARRIER_BREAK_LOCKOUT` (× cooldown mul) and refills from 0 to full over exactly that window,
   * so the HUD durability gauge doubles as the cooldown readout.
   */
  private tickBarrierRegen(dt: number, def: ImplantDef | undefined): void {
    if (def?.id !== 'barrier' || this.barrier.active || this.barrier.hp >= this.barrier.maxHp) return;
    if (this.barrierLocked && this.cdTotal > 0) this.barrier.regen(this.barrier.maxHp / this.cdTotal, dt);
    else this.barrier.regen(IMPLANT_BARRIER_REGEN, dt);
    this.barrierEmitAcc += dt;
    if (this.barrierEmitAcc >= HUD_EMIT_INTERVAL || this.barrier.hp >= this.barrier.maxHp) {
      this.barrierEmitAcc = 0;
      this.emitBarrier();
    }
  }

  private onBarrierBlocked(point: THREE.Vector3, damage: number): void {
    const collapsed = this.barrier.damage(damage);
    this.fx.spark(point, implantHex('barrier'), 0.45);
    this.ctx.bus.emit('implant:barrierHit', { point: point.clone(), damage });
    this.ctx.bus.emit('audio:play', { id: 'barrier_hit', position: point, volume: 0.5 });
    this.emitBarrier();
    if (collapsed) {
      this.chargesLeft = 0;
      this.barrierLocked = true;
      this.startCooldown(IMPLANT_BARRIER_BREAK_LOCKOUT * this.cooldownMul());
      this.fx.blast(point, 2.4, point.y);
      this.ctx.bus.emit('ui:notify', { text: '배리어 파괴됨', kind: 'danger', duration: 1.6 });
      this.ctx.bus.emit('audio:play', { id: 'barrier_break', position: point, volume: 0.9 });
      this.sendBarrier(false);
      return;
    }
    this.barrierSendAcc += 1;
    if (this.barrierSendAcc >= BARRIER_SEND_EVERY_HITS) { this.barrierSendAcc = 0; this.sendBarrier(true); }
  }

  private sendBarrier(active: boolean, to: RelayTarget = 'others'): void {
    this.send({
      t: 'imp', ev: 'barrier', active,
      p: tuple(this.barrier.position), yaw: this.barrier.yaw, hp: Math.round(this.barrier.hp),
    }, to);
  }

  /* ═══════════════════════════ 갈고리 (instant) ═══════════════════════════ */
  /** Q: fire at the anchor under the crosshair when it is hookable; while flying / attached Q cuts the wire. */
  private castGrapple(): void {
    if (this.grappleState !== 'idle') { this.releaseGrapple(false); return; }
    if (!this.grappleTargetValid) { this.deny(); return; }
    this.fireGrapple();
  }

  private updateGrapple(dt: number, active: boolean): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;

    if (this.grappleState === 'idle') {
      // crosshair validity (HUD reticle) — evaluated whenever the grapple is equipped, the gun stays in hand
      let valid = false, distance = 0;
      if (active && this.ready) {
        this.aimRay(_o, _d);
        const interior = p.interior;
        const world = ctx.world && ctx.world.ready ? ctx.world : null;
        const hit = interior ? interior.raycast(_o, _d, IMPLANT_GRAPPLE_RANGE)
          : world ? world.raycast(_o, _d, IMPLANT_GRAPPLE_RANGE) : null;
        if (hit) { valid = true; distance = hit.distance; this.grapplePoint.copy(hit.point); }
      }
      if (valid !== this.grappleTargetValid || Math.abs(distance - this.grappleTargetDist) > 0.75) {
        this.grappleTargetValid = valid;
        this.grappleTargetDist = distance;
        ctx.bus.emit('implant:grappleTargetChanged', { valid, distance });
      }
      return;
    }

    this.grappleTimer += dt;
    this.aimRay(_o, _d);
    this.muzzle(_muzzle, _d);
    if (this.grappleState === 'flying') {
      this.grappleFlown += GRAPPLE_FLY_SPEED * dt;
      const total = _muzzle.distanceTo(this.grapplePoint);
      if (this.grappleFlown >= total) {
        this.grappleState = 'attached';
        this.grappleTip.copy(this.grapplePoint);
        this.setGrapplePull(this.grapplePoint);
        ctx.bus.emit('implant:grappleAttached', { point: this.grapplePoint.clone() });
        ctx.bus.emit('audio:play', { id: 'grapple_attach', position: this.grapplePoint, volume: 0.8 });
        this.fx.spark(this.grapplePoint, implantHex('grapple'), 0.4);
        this.send({ t: 'imp', ev: 'grapple', o: tuple(_muzzle), p: tuple(this.grapplePoint) });
      } else {
        this.grappleTip.copy(this.grapplePoint).sub(_muzzle).normalize().multiplyScalar(this.grappleFlown).add(_muzzle);
      }
    }
    this.wire.set(_muzzle, this.grappleTip, this.grappleState === 'attached');

    if (this.grappleState === 'attached') {
      const arrived = p.position.distanceTo(this.grapplePoint) < GRAPPLE_ARRIVE_DIST;
      if (arrived || this.grappleTimer > GRAPPLE_MAX_TIME || !active) this.releaseGrapple(false);
    }
  }

  private fireGrapple(): void {
    if (!this.useCharge()) return;
    const ctx = this.ctx;
    this.aimRay(_o, _d);
    this.muzzle(_muzzle, _d);
    this.grappleState = 'flying';
    this.grappleFlown = 0;
    this.grappleTimer = 0;
    this.grappleTip.copy(_muzzle);
    ctx.bus.emit('implant:grappleFired', { origin: _muzzle.clone(), direction: _d.clone() });
    ctx.bus.emit('audio:play', { id: 'grapple_fire', volume: 0.8 });
    this.activated('grapple', this.grapplePoint);
    this.grappleTargetValid = false;
    ctx.bus.emit('implant:grappleTargetChanged', { valid: false, distance: 0 });
  }

  /** `silent` = the wire was cut by something else (stow / death), so no release sting is played. */
  private releaseGrapple(silent: boolean): void {
    if (this.grappleState === 'idle') return;
    this.grappleState = 'idle';
    this.grappleFlown = 0;
    this.grappleTimer = 0;
    this.wire.hide();
    this.setGrapplePull(null);
    this.ctx.bus.emit('implant:grappleReleased', {});
    if (!silent) this.ctx.bus.emit('audio:play', { id: 'grapple_release', volume: 0.5 });
    this.aimRay(_o, _d);
    this.muzzle(_muzzle, _d);
    this.send({ t: 'imp', ev: 'grapple', o: tuple(_muzzle), p: null });
  }

  /** `PlayerRef.setGrappleTarget` is part of the tactical-kit contract; player/ may not have it yet. */
  private setGrapplePull(point: THREE.Vector3 | null): void {
    const p = this.ctx?.player;
    if (p && typeof p.setGrappleTarget === 'function') p.setGrappleTarget(point);
  }

  /* ═══════════════════════════ 정찰 (hold Q) ═══════════════════════════ */
  private updateScan(dt: number, qDown: boolean, qPressed: boolean): void {
    if (!this.scanning) {
      if (qPressed) {
        if (!this.useCharge(false)) return;
        this.scanning = true;
        this.holdingFlag = true;
        this.scanPulses = 0;
        this.scanTimer = 0;
        this.doScanPulse();
      }
      return;
    }
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) this.doScanPulse();
    if (!qDown || this.scanPulses >= IMPLANT_SCAN_MAX_PULSES) this.stopScan();
  }

  private doScanPulse(): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    this.scanPulses++;
    this.scanTimer = IMPLANT_SCAN_PULSE_INTERVAL;
    const radius = this.scanPulses * IMPLANT_SCAN_RADIUS_STEP;
    _p.copy(p.position); _p.y += 1.1;
    const targets = collectScanTargets(ctx, _p, radius);
    this.fx.pulse(_p, radius, IMPLANT_SCAN_PULSE_INTERVAL * 1.4, implantHex('scan'), p.position.y);
    ctx.bus.emit('implant:scanned', { pulse: this.scanPulses, radius, duration: IMPLANT_SCAN_REVEAL_TIME, targets });
    ctx.bus.emit('detect:reveal', { targets, duration: IMPLANT_SCAN_REVEAL_TIME });
    ctx.bus.emit('audio:play', { id: 'scan_pulse', volume: 0.6, pitch: 1 + this.scanPulses * 0.06 });
    this.activated('scan', _p);
    this.send({ t: 'imp', ev: 'scan', p: tuple(_p), radius });
  }

  private stopScan(): void {
    if (!this.scanning) return;
    this.scanning = false;
    this.holdingFlag = false;
    this.scanTimer = 0;
    this.startCooldown();
  }

  /* ═══════════════════════════ 오버차지 (hold Q, energy) ═══════════════════════════ */
  /** Energy drains while channelling and refills from empty in IMPLANT_OVERCHARGE_REGEN_TIME while released. */
  private tickEnergy(dt: number, def: ImplantDef | undefined): void {
    if (def?.id !== 'overcharge' || dt <= 0) return;
    if (this.ocActive) return;                       // drained inside updateOvercharge
    if (this.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) return;
    this.ocEnergy = Math.min(IMPLANT_OVERCHARGE_ENERGY, this.ocEnergy + dt * IMPLANT_OVERCHARGE_ENERGY / IMPLANT_OVERCHARGE_REGEN_TIME);
    this.energyEmitAcc += dt;
    if (this.energyEmitAcc >= HUD_EMIT_INTERVAL || this.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) {
      this.energyEmitAcc = 0;
      this.emitEnergy(false);
      if (this.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) this.ctx.bus.emit('audio:play', { id: 'implant_ready', volume: 0.3 });
    }
  }

  private updateOvercharge(dt: number, qDown: boolean, qPressed: boolean): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) { this.setOvercharge(false); return; }

    if (!this.ocActive) {
      if (!qPressed) return;
      if (this.ocEnergy < OVERCHARGE_MIN_START) { this.deny(); ctx.bus.emit('ui:notify', { text: '오버차지 충전 중', kind: 'warning', duration: 1 }); return; }
      this.setOvercharge(true);
    }
    if (!qDown || this.ocEnergy <= 0) { this.setOvercharge(false); return; }

    this.ocEnergy = Math.max(0, this.ocEnergy - dt);
    this.energyEmitAcc += dt;
    if (this.energyEmitAcc >= HUD_EMIT_INTERVAL) { this.energyEmitAcc = 0; this.emitEnergy(false); }

    // ── self: slow heal + the buff while healthy
    if (p.hp < p.maxHp) p.heal(IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC * dt);
    const selfHealthy = p.hp >= p.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
    if (selfHealthy) this.applyBoost(p, IMPLANT_OVERCHARGE_SPEED_MUL, BOOST_LINGER);

    // ── ally under the crosshair: faster heal (+ buff while healthy), beam locks on
    this.aimRay(_o, _d);
    const ally = findAlly(ctx, _o, _d, IMPLANT_OVERCHARGE_RANGE);
    const targetId = ally ? ally.id : null;
    this.syncBeamNet(dt, targetId, !ally);
    if (targetId !== this.ocTarget) {
      this.ocTarget = targetId;
      this.ocHealAcc = 0;
      this.ocSendAcc = HEAL_SEND_INTERVAL;      // first tick sends immediately
      this.ocBoostAcc = BOOST_SEND_INTERVAL;
      ctx.bus.emit('implant:overcharge', { mode: 'heal', target: targetId, active: true });
    }
    if (ally) {
      allyPoint(ally, _t);
      this.muzzle(_muzzle, _d);
      const allyHealthy = ally.maxHp > 0 && ally.hp >= ally.maxHp * IMPLANT_OVERCHARGE_BUFF_HP_RATIO;
      this.beam.set(_muzzle, _t, allyHealthy ? 'boost' : 'heal', ctx.camera);
      this.ocSendAcc += dt;
      this.ocBoostAcc += dt;
      this.ocHealAcc += IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC * dt;
      if (this.ocSendAcc >= HEAL_SEND_INTERVAL && this.ocHealAcc > 0) {
        this.ocSendAcc = 0;
        this.sendBuff({ t: 'buff', kind: 'heal', amount: Math.round(this.ocHealAcc * 10) / 10, duration: 0, by: this.localName() }, ally.id);
        this.ocHealAcc = 0;
      }
      if (allyHealthy && this.ocBoostAcc >= BOOST_SEND_INTERVAL) {
        this.ocBoostAcc = 0;
        this.sendBuff({ t: 'buff', kind: 'boost', amount: IMPLANT_OVERCHARGE_SPEED_MUL, duration: BOOST_SEND_INTERVAL + BOOST_LINGER, by: this.localName() }, ally.id);
      }
    } else {
      this.beam.hide();
    }
  }

  private setOvercharge(on: boolean): void {
    if (on === this.ocActive) return;
    if (this.ocActive) this.ctx.bus.emit('implant:overcharge', { mode: 'heal', target: this.ocTarget, active: false });
    this.ocActive = on;
    this.holdingFlag = on;
    this.ocTarget = null;
    this.ocHealAcc = 0;
    this.ocSendAcc = HEAL_SEND_INTERVAL;
    this.ocBoostAcc = BOOST_SEND_INTERVAL;
    if (on) {
      this.ctx.bus.emit('implant:overcharge', { mode: 'heal', target: null, active: true });
      this.ctx.bus.emit('audio:play', { id: 'overcharge_beam', volume: 0.5 });
      const p = this.ctx.player;
      if (p) this.activated('overcharge', p.position);
    } else {
      this.beam.hide();
      this.sendBeamOff();
    }
    this.emitEnergy(true);
  }

  /**
   * Phase 7: overcharge beam replication. `imp beam {target, self}` goes out when the channel starts, whenever the
   * locked ally changes, and as a refresh at most every `BEAM_SEND_INTERVAL` while on (a late joiner sees the beam on
   * the next refresh); `sendBeamOff` sends `{target: null, self: false}` immediately when the channel ends.
   */
  private syncBeamNet(dt: number, target: PeerId | null, self: boolean): void {
    this.beamNetAcc += dt;
    const changed = !this.beamNetOn || target !== this.beamNetTarget || self !== this.beamNetSelf;
    if (!changed && this.beamNetAcc < BEAM_SEND_INTERVAL) return;
    this.beamNetOn = true; this.beamNetTarget = target; this.beamNetSelf = self; this.beamNetAcc = 0;
    this.send({ t: 'imp', ev: 'beam', target, self });
  }

  private sendBeamOff(): void {
    if (!this.beamNetOn) return;
    this.beamNetOn = false; this.beamNetTarget = null; this.beamNetSelf = false; this.beamNetAcc = 0;
    this.send({ t: 'imp', ev: 'beam', target: null, self: false });
  }

  private localName(): string {
    return this.ctx.net?.playerName ?? '스캐빈저';
  }

  /* ═══════════════════════════ 대전차포 (wielded) ═══════════════════════════ */
  private updateLauncher(active: boolean): void {
    if (!active) return;
    if (!this.ctx.input.wasMousePressed(MouseButtons.FIRE)) return;
    if (!this.useCharge()) return;
    const ctx = this.ctx;
    this.aimRay(_o, _d);
    this.muzzle(_muzzle, _d);
    // aim the rocket at what the reticle is looking at, not straight out of the tube
    const interior = ctx.player?.interior ?? null;
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const hit = interior ? interior.raycast(_o, _d, 400) : world ? world.raycast(_o, _d, 400) : null;
    if (hit && hit.distance > 3) _t.copy(hit.point).sub(_muzzle).normalize();
    else _t.copy(_d);
    this.rockets.fire(_muzzle, _t, false);
    const p = ctx.player as Host | null;
    if (p && typeof p.addRecoil === 'function') p.addRecoil(0.075, (Math.random() - 0.5) * 0.03);
    ctx.bus.emit('camera:shake', { intensity: 0.4, duration: 0.2 });
    ctx.bus.emit('audio:play', { id: 'rocket_fire', volume: 1 });
    this.activated('atlauncher', _muzzle);
    this.send({ t: 'imp', ev: 'rocket', o: tuple(_muzzle), d: tuple(_t) });
  }

  private onRocketImpact(h: RocketImpact): void {
    const ctx = this.ctx;
    _hitPt.copy(h.point);
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    const groundY = world ? world.getHeightAt(_hitPt.x, _hitPt.z) : _hitPt.y;
    this.fx.blast(_hitPt, IMPLANT_AT_RADIUS, groundY);
    ctx.bus.emit('camera:shake', { intensity: 0.65, duration: 0.35 });
    ctx.bus.emit('audio:play', { id: 'rocket_explode', position: _hitPt, volume: 1 });
    ctx.bus.emit('implant:rocketExploded', { position: _hitPt.clone(), radius: IMPLANT_AT_RADIUS, damage: IMPLANT_AT_DAMAGE });

    const enemies = ctx.enemies;
    if (ctx.isAuthority) {
      if (enemies) {
        const area = (enemies as { applyAreaDamage?: unknown }).applyAreaDamage;
        if (typeof area === 'function') enemies.applyAreaDamage(_hitPt, IMPLANT_AT_RADIUS, IMPLANT_AT_DAMAGE, ctx.net?.localId ?? 'local');
        else enemies.applyExplosion(_hitPt, IMPLANT_AT_RADIUS, IMPLANT_AT_DAMAGE);
      }
    } else if (ctx.net) {
      // client: the host owns enemy damage (it answers with `ee damaged` / `ee kill`)
      ctx.net.send({ t: 'explode', p: tuple(_hitPt), r: IMPLANT_AT_RADIUS, dmg: IMPLANT_AT_DAMAGE }, 'host');
    }
    this.send({ t: 'imp', ev: 'rocketHit', p: tuple(_hitPt) });
  }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void {
    const net = this.ctx?.net;
    if (!net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('imp', (m, from) => this.onImplantMessage(m, from)),
      net.onMessage('buff', (m, from) => this.onBuff(m, from)),
      // Phase 9: a late joiner learns about our deployed barrier (the snapshot only carries the BARRIER flag)
      net.onMessage('flow', (m, from) => {
        if (m.ev === 'rejoined' && this.barrier?.active && from !== net.localId) this.sendBarrier(true, from);
      }),
    );
  }

  /** e2e hook: the replicated overcharge beam state of `peerId` as this client sees it (null = unknown peer). */
  debugBeam(peerId: PeerId): { on: boolean; target: PeerId | null; self: boolean; until: number } | null {
    return this.remote?.debugBeam(peerId) ?? null;
  }

  private send(msg: ImplantMessage, to: RelayTarget = 'others'): void {
    const ctx = this.ctx;
    if (!ctx?.isMultiplayer || !ctx.net) return;
    ctx.net.send(msg, to);
  }

  private sendBuff(msg: BuffMessage, to: PeerId): void {
    const ctx = this.ctx;
    if (!ctx?.isMultiplayer || !ctx.net) return;
    ctx.net.send(msg, to);
  }

  private onImplantMessage(m: ImplantMessage, from: PeerId): void {
    if (from === this.ctx.net?.localId) return;
    this.remote.handle(m, from);
  }

  /**
   * Friendly effects aimed at *us* by someone else. Each `buff` kind has exactly one receiver: implants/ applies
   * the overcharge `heal` / `boost`; `revive` (defibrillator) and `cloak` belong to gadgets/ (Phase 9: the duplicate
   * `revive` branch here is gone).
   */
  private onBuff(m: BuffMessage, _from: PeerId): void {
    const p = this.ctx.player;
    if (!p) return;
    switch (m.kind) {
      case 'heal':
        if (p.isDead || p.isDowned) return;
        p.heal(m.amount);
        break;
      case 'boost':
        this.applyBoost(p, m.amount > 0 ? m.amount : IMPLANT_OVERCHARGE_SPEED_MUL, m.duration || BOOST_SEND_INTERVAL + BOOST_LINGER);
        break;
      default:
        break;
    }
  }

  /**
   * Overcharge buff on a player. The `'overcharge'` modifier key is the contract with player/: while it is
   * live the player runs faster and reports `isOvercharged` (weapons reads that for the fire-rate bonus).
   * `setSpeedModifier` is part of the tactical-kit contract, so it is probed defensively.
   */
  private applyBoost(p: PlayerRef, mul: number, duration: number): void {
    if (typeof p.setSpeedModifier === 'function') p.setSpeedModifier('overcharge', mul, duration);
  }
}
