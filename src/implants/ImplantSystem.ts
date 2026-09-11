import * as THREE from 'three';
import {
  IMPLANT_AT_DAMAGE, IMPLANT_AT_RADIUS, IMPLANT_BARRIER_BLOCK_DAMAGE, IMPLANT_BARRIER_BREAK_LOCKOUT,
  IMPLANT_BARRIER_CARRY_OFFSET, IMPLANT_BARRIER_CARRY_REGEN,
  IMPLANT_BARRIER_CARRY_REGEN_DELAY, IMPLANT_BARRIER_CARRY_SPEED_MUL, IMPLANT_BARRIER_CARRY_WIDTH,
  IMPLANT_BARRIER_HP, IMPLANT_BARRIER_REGEN,
  IMPLANT_DASH_DISTANCE, IMPLANT_GRAPPLE_RANGE,
  IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC, IMPLANT_OVERCHARGE_BUFF_HP_RATIO, IMPLANT_OVERCHARGE_ENERGY,
  IMPLANT_OVERCHARGE_RANGE, IMPLANT_OVERCHARGE_REGEN_TIME, IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC, IMPLANT_OVERCHARGE_SPEED_MUL,
  IMPLANT_SCAN_RADIUS, IMPLANT_SCAN_REVEAL_TIME_V2,
  IMPLANT_SHIELD_BASH_COOLDOWN, IMPLANT_SHIELD_BASH_DAMAGE, IMPLANT_SHIELD_BASH_KNOCKBACK, IMPLANT_SHIELD_BASH_RANGE, IMPLANT_SHIELD_BASH_STAMINA,
  IMPLANT_SHIELD_BASH_SWING_S,
  Keys, MouseButtons, PLAYER_RADIUS,
  type BuffMessage, type EnemyRef, type GameContext, type GameSystem, type ImplantDef, type ImplantId,
  type ImplantMessage, type ImplantsRef, type PeerId, type PlayerRef, type PlayerWeaponHost, type RelayTarget,
  type Vec3Tuple,
} from '@/shared';
import { IMPLANT_DEFS, getImplantDef, implantHex, isImplantId } from './ImplantDefs';
import { ImplantDevice } from './devices/ImplantDevice';
import { BarrierField } from './effects/Barrier';
import { GrappleWire } from './effects/Grapple';
import { RocketPool, type RocketImpact } from './effects/AtLauncher';
import { OverchargeBeam, allyPoint, findAlly } from './effects/Overcharge';
import { revealScan } from './effects/Scan';
import { ImplantFx } from './fx/ImplantFx';
import { RemoteImplants } from './RemoteImplants';

import { ABSORB_RANGE, BARRIER_SEND_EVERY_HITS, BASH_FX_Y, BEAM_SEND_INTERVAL, BOOST_LINGER, BOOST_SEND_INTERVAL, BUMP_FX_INTERVAL, GRAPPLE_ARRIVE_DIST, GRAPPLE_FLY_SPEED, GRAPPLE_MAX_TIME, HEAL_SEND_INTERVAL, HUD_EMIT_INTERVAL, type Host, OVERCHARGE_MIN_START, SCAN_PULSE_FX_S, SHIELD_SPEED_KEY, _bp, _d, _from, _hitPt, _hp, _muzzle, _n, _o, _p, _r, _t, _tmp, tuple } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Barrier from './parts/Barrier';
import * as Dev from './parts/Devices';
import * as Charge from './parts/Charges';
import * as Wield from './parts/Wield';
import * as Wire from './parts/Wire';

export class ImplantSystem implements GameSystem, ImplantsRef {
  readonly name = 'implants';

  ctx!: GameContext;
  fx!: ImplantFx;
  rockets!: RocketPool;
  remote!: RemoteImplants;
  barrier!: BarrierField;
  wire!: GrappleWire;
  beam!: OverchargeBeam;

  equippedId: ImplantId | null = null;
  device: ImplantDevice | null = null;
  deviceAttached = false;
  wieldedFlag = false;
  holdingFlag = false;

  chargesLeft = 1;
  cdRemaining = 0;
  cdTotal = 0;
  hudAcc = 0;

  /** Grapple. */
  grappleState: 'idle' | 'flying' | 'attached' = 'idle';
  readonly grapplePoint = new THREE.Vector3();
  readonly grappleTip = new THREE.Vector3();
  grappleFlown = 0;
  grappleTimer = 0;
  grappleTargetValid = false;
  grappleTargetDist = 0;
  /**
   * 2026-09-11: the air drone the anchor sits on (null = a static wall / floor anchor). While idle it is the
   * crosshair candidate; while flying / attached the anchor is re-seated every frame at drone position + offset.
   */
  grappleDroneId: string | null = null;
  /** Anchor point relative to the drone's body centre (world axes), captured from the ray hit. */
  readonly grappleDroneOffset = new THREE.Vector3();
  /** Seconds since the last `imp grapple` refresh of a drone anchor. */
  grappleSendAcc = 0;

  /** 실드 배쉬 (Phase 12): seconds left of the swing pose / FX, and of the re-bash cooldown. */
  bashTimer = 0;
  bashCd = 0;
  /** Throttle for the `implant:barrierBumped` spark FX. */
  bumpFxAcc = BUMP_FX_INTERVAL;

  /** Overcharge. */
  ocEnergy = IMPLANT_OVERCHARGE_ENERGY;
  ocActive = false;
  ocTarget: PeerId | null = null;
  ocHealAcc = 0;
  ocSendAcc = 0;
  ocBoostAcc = 0;
  /** Phase 7: last `imp beam` state sent to the squad (on / target / self) + seconds since. */
  beamNetOn = false;
  beamNetTarget: PeerId | null = null;
  beamNetSelf = false;
  beamNetAcc = 0;
  energyEmitAcc = 0;
  lastEnergyEmitted = -1;

  /** Barrier (Phase 10: a shield carried in hand). */
  barrierLocked = false;
  barrierSendAcc = 0;
  barrierEmitAcc = 0;
  /** Seconds since the raised shield last took a hit (gates `IMPLANT_BARRIER_CARRY_REGEN`). */
  barrierSinceHit = IMPLANT_BARRIER_CARRY_REGEN_DELAY;

  profileApplied = false;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  readonly remoteBarriers: BarrierField[] = [];

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
   * Q pressed. Instant implants cast (grapple fires / releases, dash); a wielded implant — the launcher and, since
   * Phase 10, the 배리어 shield — toggles in / out of the hands. Hold implants are driven per frame from `update`
   * (this is a no-op for them).
   *
   * Carrying a downed squadmate takes precedence: the press only drops the body and does nothing else this frame
   * (the player retries naturally on the next press).
   */
  activate(): void {
    const ctx = this.ctx;
    const def = this.def();
    if (!def || !ctx) return;
    const p = ctx.player;
    if (!p || p.isDead || p.isDowned) return;
    if (this.piloting) return;
    if (!ctx.isGameplayActive()) return;
    if (this.dropCarriedFirst(p)) return;
    switch (def.id) {
      case 'grapple': this.castGrapple(); break;
      case 'dash': this.castDash(); break;
      case 'scan': this.castScan(); break;
      case 'barrier':
      case 'atlauncher': if (this.wieldedFlag) this.stow(); else this.wield(); break;
      default: break;
    }
  }

  /**
   * 들쳐메기 gate (Phase 10): while a downed squadmate is on our shoulder every action but running first drops
   * them. `carrying` / `dropCarried` are probed defensively — player/ owns them and may register later.
   */
  private dropCarriedFirst(p: PlayerRef): boolean { return Wield.dropCarriedFirst(this, p); }

  /** Force the wielded implant away and end any channel (weapon swap, death, phase change). */
  stow(): void { return Wield.stow(this); }

  /**
   * 2026-09-11: the local player is looking through a drone — the PC sits still, so Q (and the wielded implants'
   * mouse / melee input) is ignored. `ctx.drones.controlled` is a fallback while player/ has no `droneControl` yet.
   */
  get piloting(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return ctx.player?.droneControl === true || (ctx.drones?.controlled ?? null) !== null;
  }

  /**
   * Hostile-projectile blocking for the local barrier and every replicated peer barrier.
   * Player shields ignore friendly fire, so `fromEnemy === false` never blocks.
   * **Pure query** (Phase 9): safe for per-tick line-of-sight tests. A caller whose shot really stopped here calls
   * `damageBarrier(owner, point)` once — that is where the local shield loses durability and sparks fly.
   */
  raycastBarrier(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, fromEnemy: boolean): { point: THREE.Vector3; owner: PeerId | 'local' } | null { return Barrier.raycastBarrier(this, origin, dir, maxDist, fromEnemy); }

  /**
   * A projectile really stopped at a barrier: the local shield takes `amount` (`IMPLANT_BARRIER_BLOCK_DAMAGE` by default) +
   * `implant:barrierHit` (+ collapse / lockout / `imp barrier` sync), a peer's shield only sparks — its owner is
   * authoritative over its hp and broadcasts it.
   */
  damageBarrier(owner: PeerId | 'local', point: THREE.Vector3, amount = IMPLANT_BARRIER_BLOCK_DAMAGE): void { return Barrier.damageBarrier(this, owner, point, amount); }

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
      b.on('player:died', () => this.stow()),
      b.on('player:downed', () => this.stow()),
      b.on('net:remotePlayerRemoved', ({ id }) => this.remote.remove(id)),
      // Phase 12: enemies/ resolved a bug against a raised shield — spark the panel (throttled; it fires per bug per tick)
      b.on('implant:barrierBumped', ({ point }) => this.onBarrierBumped(point)),
      // 2026-09-11: taking a drone's controls puts the wielded implant away and cuts the wire / channel
      b.on('drone:controlChanged', ({ id }) => { if (id !== null) this.stow(); }),
      // 2026-09-11: the drone our hook sits on left the world — cut the wire at once
      b.on('drone:removed', ({ id }) => {
        if (this.grappleState !== 'idle' && this.grappleDroneId === id) this.releaseGrapple(false);
      }),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase !== 'playing' && phase !== 'extracting' && phase !== 'shipLanded' && phase !== 'liftoff') this.stow();
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
    // 2026-09-11: while piloting a drone nothing here reads input (Q, LMB, melee) and the crosshair grapple goes invalid
    const piloting = this.piloting;
    const active = ctx.isGameplayActive() && ctx.input.isPointerLocked && alive && !piloting;

    if (!ctx.isGameplayPhase() || !alive) this.stow();
    else if (piloting && (this.wieldedFlag || this.ocActive || this.grappleState !== 'idle')) this.stow();

    this.tickCooldown(dt);
    this.tickBarrierRegen(dt, def);
    this.tickEnergy(dt, def);
    if (this.bashTimer > 0) this.bashTimer = Math.max(0, this.bashTimer - dt);
    if (this.bashCd > 0) this.bashCd = Math.max(0, this.bashCd - dt);
    this.bumpFxAcc += dt;

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
      case 'overcharge': this.updateOvercharge(dt, qDown, qPressed); break;
      case 'barrier': if (this.wieldedFlag) this.updateShield(active); break;
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
  def(): ImplantDef | undefined {
    return this.equippedId ? getImplantDef(this.equippedId) : undefined;
  }

  applyProfile(id: ImplantId | null): void { return Wield.applyProfile(this, id); }

  /** progression/ may register after us; pick up its saved implant as soon as it exists. */
  private applyProfileLazily(): void { return Wield.applyProfileLazily(this); }

  resetRuntime(): void { return Wield.resetRuntime(this); }

  private wield(): void { return Wield.wield(this); }

  attachDevice(): void { return Wield.attachDevice(this); }

  detachDevice(): void { return Wield.detachDevice(this); }

  weaponSocket(): THREE.Object3D | null { return Wield.weaponSocket(this); }

  /** Aim ray from the reticle; falls back to eye + horizontal forward when the host has no camera ray. */
  aimRay(origin: THREE.Vector3, dir: THREE.Vector3): boolean { return Wield.aimRay(this, origin, dir); }

  /**
   * World position an effect leaves from: the wielded device's muzzle, else the hand (weapon socket) so the
   * grapple wire and the overcharge beam start at the gun, else the eye.
   */
  muzzle(out: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 { return Wield.muzzle(this, out, dir); }

  /* ═══════════════════════════ charges & cooldown ═══════════════════════════ */
  cooldownMul(): number { return Charge.cooldownMul(this); }

  effectiveCooldown(): number { return Charge.effectiveCooldown(this); }

  get ready(): boolean { return this.chargesLeft > 0 && this.cdRemainingBlocking() <= 0; }

  /** Charge-based implants may fire while a refill is running; single-charge ones may not. */
  private cdRemainingBlocking(): number { return Charge.cdRemainingBlocking(this); }

  /**
   * Spend one charge. `startCooldown` false = the caller starts it later (scan starts it when the train ends).
   * A refill already in flight is never restarted — see `parts/Charges.useCharge`.
   */
  useCharge(startCooldown = true): boolean { return Charge.useCharge(this, startCooldown); }

  startCooldown(seconds?: number): void { return Charge.startCooldown(this, seconds); }

  private tickCooldown(dt: number): void { return Charge.tickCooldown(this, dt); }

  emitCooldown(force: boolean): void { return Charge.emitCooldown(this, force); }

  emitBarrier(): void { return Barrier.emitBarrier(this); }

  emitEnergy(force: boolean): void { return Charge.emitEnergy(this, force); }

  deny(): void { return Charge.deny(this); }

  activated(id: ImplantId, position: THREE.Vector3): void { return Charge.activated(this, id, position); }

  /* ═══════════════════════════ 대시 ═══════════════════════════ */
  private castDash(): void { return Dev.castDash(this); }

  /* ═══════════════════════════ 배리어 = 들고 다니는 방패 (Phase 10) ═══════════════════════════ */
  /** Refused while the shield is recharging after a collapse (the lockout doubles as its cooldown). */
  canRaiseShield(): boolean { return Barrier.canRaiseShield(this); }

  /** Q → shield up: the panel appears in front of the carrier and follows them from this frame on. */
  raiseShield(): void { return Barrier.raiseShield(this); }

  /** Q again / weapon key / death / phase change → shield down. */
  lowerShield(): void { return Barrier.lowerShield(this); }

  /**
   * Per frame while raised: keep the panel on the carrier, keep the movement penalty alive, and (Phase 12) read the
   * 실드 배쉬 input — LMB (`Keys.FIRE`) or the melee key. The melee press is consumed afterwards so weapons/ (which
   * runs later in the frame and already holsters while `blocksWeapons`) can never swing its own melee on the same F.
   */
  private updateShield(active: boolean): void { return Barrier.updateShield(this, active); }

  /* ═══════════════════════════ Phase 12: 실드 배쉬 · 충돌 · 정면 흡수 ═══════════════════════════ */
  /** 실드 배쉬 swing in progress (pose + FX). Enemies in the box were already hit when this went true. */
  get bashing(): boolean { return this.bashTimer > 0; }

  /**
   * 실드 배쉬: costs `IMPLANT_SHIELD_BASH_STAMINA`, then strikes every alive enemy inside the box in front of the
   * carrier — the shield's own width (± enemy radius) by `IMPLANT_SHIELD_BASH_RANGE` (+ radius) past the panel
   * plane — for `IMPLANT_SHIELD_BASH_DAMAGE × derived.meleeDamageMul` (no weapon / 개머리판 bonus). The pose is the
   * player's existing heavy swing (`startMelee('heavy')` → MELEE_HEAVY on the wire, so replicas pose for free);
   * the shield itself stays raised. Replica enemies forward the `hit` to the host themselves (`takeDamage`).
   */
  tryBash(): void { return Barrier.tryBash(this); }

  /**
   * Enemy movement vs every raised shield (local + peers' replicas). The first shield overlapping the mover pushes
   * `pos` out to its front face and names its carrier (enemies/ retargets the bug onto them). Pure apart from `pos`;
   * no allocations — called per simulated bug per tick.
   */
  resolveBarrierCollision(pos: THREE.Vector3, radius: number): PeerId | 'local' | null { return Barrier.resolveBarrierCollision(this, pos, radius); }

  /**
   * A melee attack of `amount` from `fromPos` is about to land on `owner`. True when that carrier's raised shield
   * faces the attacker (inside `IMPLANT_BARRIER_CARRY_ARC`, within `ABSORB_RANGE`) and took it instead: the local
   * shield loses `amount` through the normal block path (`implant:barrierHit`, collapse → lockout + `stow()`); a
   * peer's shield only sparks here — the caller sends `ee barrierHit` to that peer, whose `damageBarrier('local', …)`
   * deducts it.
   */
  absorbFrontalAttack(owner: PeerId | 'local', fromPos: THREE.Vector3, amount: number): boolean { return Barrier.absorbFrontalAttack(this, owner, fromPos, amount); }

  barrierOf(owner: PeerId | 'local'): BarrierField | null { return Barrier.barrierOf(this, owner); }

  /** `implant:barrierBumped` from enemies/: a bug pressed against a shield — spark the contact point (throttled). */
  private onBarrierBumped(point: THREE.Vector3): void { return Barrier.onBarrierBumped(this, point); }

  /** Panel plane in front of the player's feet, facing where they face. */
  followShield(): void { return Barrier.followShield(this); }

  applyShieldSpeed(): void { return Barrier.applyShieldSpeed(this); }

  clearShieldSpeed(): void { return Barrier.clearShieldSpeed(this); }

  /**
   * Regeneration. Lowered: `IMPLANT_BARRIER_REGEN`/s. Raised (Phase 10): `IMPLANT_BARRIER_CARRY_REGEN`/s once
   * `IMPLANT_BARRIER_CARRY_REGEN_DELAY` has passed without a block, so holding the shield up is no longer a
   * one-way drain. After a collapse it is locked for `IMPLANT_BARRIER_BREAK_LOCKOUT` (× cooldown mul) and refills
   * from 0 to full over exactly that window, so the HUD durability gauge doubles as the cooldown readout.
   */
  private tickBarrierRegen(dt: number, def: ImplantDef | undefined): void { return Barrier.tickBarrierRegen(this, dt, def); }

  onBarrierBlocked(point: THREE.Vector3, damage: number): void { return Barrier.onBarrierBlocked(this, point, damage); }

  /**
   * Replicated shield state. The transform rides on our own `PlayerSnapshot` (`p`, `yaw`, `PlayerFlags.BARRIER`,
   * `bhp`), so only "up" and the durability travel here: on raise / lower, every `BARRIER_SEND_EVERY_HITS` blocked
   * hits, and unicast to a late joiner on `flow rejoined`.
   */
  sendShield(up: boolean, to: RelayTarget = 'others'): void { return Barrier.sendShield(this, up, to); }

  /* ═══════════════════════════ 갈고리 (instant) ═══════════════════════════ */
  /** Q: fire at the anchor under the crosshair when it is hookable; while flying / attached Q cuts the wire. */
  private castGrapple(): void { return Dev.castGrapple(this); }

  private updateGrapple(dt: number, active: boolean): void { return Dev.updateGrapple(this, dt, active); }

  fireGrapple(): void { return Dev.fireGrapple(this); }

  /** `silent` = the wire was cut by something else (stow / death), so no release sting is played. */
  releaseGrapple(silent: boolean): void { return Dev.releaseGrapple(this, silent); }

  /** `PlayerRef.setGrappleTarget` is part of the tactical-kit contract; player/ may not have it yet. */
  setGrapplePull(point: THREE.Vector3 | null): void { return Dev.setGrapplePull(this, point); }

  /* ═══════════════════════════ 정찰 (instant, Phase 12) ═══════════════════════════ */
  /**
   * Q: one wide pulse (`IMPLANT_SCAN_RADIUS`) around the caster, usable while moving — no hold, no energy. Every
   * interactable + alive enemy inside is revealed for `IMPLANT_SCAN_REVEAL_TIME_V2` to us (`detect:reveal` pillars,
   * `scan:cast` compass marks, `setXray` red silhouettes — all in `revealScan`) and to the squad: `imp scanCast`
   * carries only `p / radius / dur`, each receiver reveals from its own world. `implant:scanned` (pulse 1) stays for
   * the audio hook; `implant:activated` fires once per cast (the implant skill XP hook).
   */
  private castScan(): void { return Dev.castScan(this); }

  /* ═══════════════════════════ 오버차지 (hold Q, energy) ═══════════════════════════ */
  /** Energy drains while channelling and refills from empty in IMPLANT_OVERCHARGE_REGEN_TIME while released. */
  private tickEnergy(dt: number, def: ImplantDef | undefined): void { return Charge.tickEnergy(this, dt, def); }

  private updateOvercharge(dt: number, qDown: boolean, qPressed: boolean): void { return Dev.updateOvercharge(this, dt, qDown, qPressed); }

  setOvercharge(on: boolean): void { return Dev.setOvercharge(this, on); }

  /**
   * Phase 7: overcharge beam replication. `imp beam {target, self}` goes out when the channel starts, whenever the
   * locked ally changes, and as a refresh at most every `BEAM_SEND_INTERVAL` while on (a late joiner sees the beam on
   * the next refresh); `sendBeamOff` sends `{target: null, self: false}` immediately when the channel ends.
   */
  syncBeamNet(dt: number, target: PeerId | null, self: boolean): void { return Dev.syncBeamNet(this, dt, target, self); }

  sendBeamOff(): void { return Dev.sendBeamOff(this); }

  localName(): string { return Wield.localName(this); }

  /* ═══════════════════════════ 대전차포 (wielded) ═══════════════════════════ */
  private updateLauncher(active: boolean): void { return Dev.updateLauncher(this, active); }

  private onRocketImpact(h: RocketImpact): void { return Dev.onRocketImpact(this, h); }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void { return Wire.ensureNetHooks(this); }

  /** e2e hook: the replicated overcharge beam state of `peerId` as this client sees it (null = unknown peer). */
  debugBeam(peerId: PeerId): { on: boolean; target: PeerId | null; self: boolean; until: number } | null { return Dev.debugBeam(this, peerId); }

  send(msg: ImplantMessage, to: RelayTarget = 'others'): void { return Wire.send(this, msg, to); }

  sendBuff(msg: BuffMessage, to: PeerId): void { return Wire.sendBuff(this, msg, to); }

  onImplantMessage(m: ImplantMessage, from: PeerId): void { return Wire.onImplantMessage(this, m, from); }

  /**
   * Friendly effects aimed at *us* by someone else. Each `buff` kind has exactly one receiver: implants/ applies
   * the overcharge `heal` / `boost`; `revive` (defibrillator) and `cloak` belong to gadgets/ (Phase 9: the duplicate
   * `revive` branch here is gone).
   */
  onBuff(m: BuffMessage, _from: PeerId): void { return Wire.onBuff(this, m, _from); }

  /**
   * Overcharge buff on a player: `setSpeedModifier('overcharge', mul, duration)` + `setOvercharged(duration)`
   * (2026-09-11 C-3 — the flag is explicit, no longer inferred from the modifier key by player/).
   */
  applyBoost(p: PlayerRef, mul: number, duration: number): void { return Wire.applyBoost(this, p, mul, duration); }
  /* ══ Phase 10 — 배리어 = 들고 다니는 방패 ══ */
  /** true while the shield is in the hands (mirrors `wielded` for the barrier implant). */
  get barrierCarried(): boolean { return this.wieldedFlag && this.equippedId === 'barrier'; }

  /**
   * Local shield pose for renderers / tests: writes the **panel-bottom centre** into `outPosition` and returns its
   * facing. null while the shield is down (`intersect` measures dy from that y, so the panel spans
   * `y … y + IMPLANT_BARRIER_CARRY_HEIGHT`).
   */
  getBarrierPose(outPosition: THREE.Vector3): { yaw: number } | null { return Barrier.getBarrierPose(this, outPosition); }
}
