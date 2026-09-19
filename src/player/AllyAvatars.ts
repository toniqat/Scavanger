/**
 * src/player/AllyAvatars.ts — **android squadmate bodies** (2026-09-15, contract `shared/allies.ts`).
 *
 * The question this file answers: *how the androids `ctx.allies` talks about look on screen.*
 *
 * allies/ builds no meshes — it owns the roster · the FSM · the sync only, and hands out **read-only body state**
 * through `getBodies()`. That list is read here every frame and one `SoldierModel` (the android look) per unit is
 * matched to it: position · facing · pose · gear look · footsteps · muzzle flash · the interaction that stands a
 * downed unit up. The same body pool (`SoldierPool`) as remote players, so crossing ship ↔ raid rebuilds no body.
 *
 * **The light count is never raised** — the muzzle flash borrows `core/fx`'s fixed-size pool (`FlashPool`), and the
 * android's visor · joints are emissive materials (CLAUDE.md §4.5).
 *
 * The body-state object (`AllyBodyView`) and its vectors are reused by allies/ — **read them now, never store.**
 */
import * as THREE from 'three';
import {
  ALLY_FLAGS, FOOTSTEP_MIN_INTERVAL_S, NET_SLOT_COLORS, PLAYER_REVIVE_HOLD, PLAYER_REVIVE_RANGE,
  type AllyBodyView, type AllyId, type AllyMode, type AllyPose, type AllyStateId, type GameContext,
  type Interactable, type PeerId, type WeaponClass, type WeaponDef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, wrapAngle } from '@/core/util/MathUtil';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from './SoldierModel';
import { buildHeldWeapon, type WeaponLook } from './GearLook';
import { inLeavingShip, resolveArmorDef } from './RemoteAvatar';
import type { SoldierPool } from './SoldierPool';
import { STRIDE_MIN_SPEED } from './PlayerController';

const EMPTY_BODIES: readonly AllyBodyView[] = [];
/** Recoil pulse interval during sustained fire (the same as the remote avatar's `FIRE_PULSE_INTERVAL`). */
const FIRE_PULSE_INTERVAL = 0.11;
/** How long the interactable stays away after a revive hold (until a snapshot carries the stood-up state). */
const REVIVE_DONE_SUPPRESS = 1.5;
/** Muzzle flash intensity · size · life · distance — `weapons/fx/WeaponFx.muzzleFlash`'s own values (same pool). */
const FLASH = { intensity: 7, size: 0.45, life: 0.045, distance: 7 } as const;

const _up = new THREE.Vector3(0, 1, 0);
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spark = new THREE.Vector3();

/**
 * Shot sound id for an android's gun. `weapons/WeaponDefaults.shotSoundId` answers the same question for the player,
 * and weapons/ is another folder's internals, which this folder must not import (CLAUDE.md §4.1) — so this is a
 * **second judgement of the same thing, not a copy of that table** (2026-09-19, B-49, corrected): it reads the
 * `WeaponDef` (`ammoType` · `pellets` · the class) where the weapons side switches on `WeaponKind`, and it knows no
 * unique at all — every legendary lands on `shot_rifle` here, while the weapons side gives the flamethrower and the
 * shockgun `shot_energy`, the bow and the shuriken `melee_swing`, the bazooka `shot_shotgun`.
 * So a new shot sound must be added in **both** places, and the two can drift apart with nothing failing. The cure
 * is one id table in `src/shared` that both folders read; that file is not this folder's to change.
 */
function allyShotSound(def: WeaponDef | null): string {
  if (!def) return 'shot_rifle';
  if (def.ammoType === 'energy') return 'shot_energy';
  if (def.pellets && def.pellets > 1) return 'shot_shotgun';
  switch (weaponClassOfDef(def)) {
    case 'SR': return 'shot_sniper';
    case 'SMG': return 'shot_smg';
    case 'PISTOL': return 'shot_pistol';
    case 'SG': return 'shot_shotgun';
    default: return 'shot_rifle';
  }
}

/** The same one line as `items/WeaponDefs.weaponClassOf` (kept here so that folder is never imported). */
function weaponClassOfDef(def: WeaponDef): WeaponClass {
  return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
}

/** Body state a smoke writes directly (`debugAllyBody`), readable whatever the body's age and pose. */
export interface DebugAllyBody {
  id: AllyId; name: string; bay: number; slot: number;
  mode: AllyMode; state: AllyStateId; pose: AllyPose;
  position: THREE.Vector3; velocity: THREE.Vector3;
  yaw: number; pitch: number;
  hp: number; maxHp: number; shield: number; maxShield: number;
  downHp: number; downed: boolean; dead: boolean; hidden: boolean;
  flags: number;
  weaponDefId: string | null; armorDefId: string | null; bagDefId: string | null;
  carrying: PeerId | null;
  lookAt: THREE.Vector3 | null;
  stridePhase: number; moveBlend: number;
}

/** One revive interactable — it owns its own position vector so it can follow the body. */
interface ReviveEntry { interactable: Interactable; position: THREE.Vector3 }

/**
 * One unit's drawn body. Nothing here simulates — position · flags all come from `AllyBodyView`, and this class
 * owns only the damped blends that smooth the gaps between snapshots (the same shape as a remote avatar).
 */
export class AllyAvatar {
  readonly model: SoldierModel;
  readonly root: THREE.Group;
  /**
   * A **fresh socket object** per avatar, parented inside the hand socket — the body may have come from the pool,
   * and another folder that keys its attachments on socket identity must not believe that what it parented into a
   * now-parked body is still in the hand (the same reason as `RemoteAvatar`).
   */
  readonly weaponSocket: THREE.Object3D;
  seenFrame = 0;

  private bodyYaw: number;
  private shown = false;
  private disposed = false;
  private sprintBlend = 0;
  private crouchBlend = 0;
  private proneBlend = 0;
  private downedBlend = 0;
  private aimBlend = 0;
  private carryBlend = 0;
  private recoil = 0;
  private firePulse = 0;
  /** The pose was reset to neutral once while hidden (dead → the corpse stands in for it). */
  private poseReset = false;
  private lastStepIdx = 0;
  private stepAt = -Infinity;
  private weaponLook: WeaponLook | null = null;
  private weaponDefId: string | null = null;
  private armorLookId: string | null = null;
  private greyed = false;

  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };

  constructor(view: AllyBodyView, parent: THREE.Object3D, private readonly pool: SoldierPool) {
    const accent = NET_SLOT_COLORS[view.slot] ?? SOLDIER_DEFAULT_ACCENT;
    this.model = pool.acquire(accent);
    this.model.setAndroidLook(true);
    this.root = this.model.root;
    this.root.name = `AllySoldier:${view.id}`;
    this.weaponSocket = new THREE.Object3D();
    this.weaponSocket.name = 'AllyWeaponSocket';
    this.model.weaponSocket.add(this.weaponSocket);
    this.bodyYaw = view.yaw;
    this.lastStepIdx = Math.floor(view.stridePhase / Math.PI);
    this.root.position.copy(view.position);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    this.root.visible = false;
    parent.add(this.root);
  }

  /** Is this body on camera (smoke tests · nameplates). */
  get isShown(): boolean { return this.shown; }
  get isGreyed(): boolean { return this.greyed; }
  /** The pose values being drawn (smoke tests only, read-only). */
  get poseView(): Readonly<SoldierPose> { return this.pose; }
  /** Def id of the gun in the hand (null = none). */
  get heldWeaponId(): string | null { return this.weaponDefId; }
  /** The shoulder socket a carried body hangs on (`PlayerRef.setCarriedBy`). */
  get shoulderSocket(): THREE.Object3D { return this.model.shoulderSocket; }

  /** World-space head position (nameplates · debug). */
  getHeadPosition(out: THREE.Vector3): THREE.Vector3 {
    const lie = Math.min(1, this.proneBlend);
    let h = THREE.MathUtils.lerp(1.7, 1.3, this.crouchBlend);
    h = THREE.MathUtils.lerp(h, 0.5, lie);
    if (this.pose.dead > 0) h = THREE.MathUtils.lerp(h, 0.5, this.pose.dead);
    return out.copy(this.root.position).setY(this.root.position.y + h);
  }

  /** Writes the muzzle's world position into `out` (false with no gun). */
  muzzleWorld(out: THREE.Vector3): boolean {
    const look = this.weaponLook;
    if (!look || !look.group.parent) return false;
    look.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(look.muzzle.matrixWorld);
    return true;
  }

  update(dt: number, ctx: GameContext, v: AllyBodyView): void {
    if (this.disposed) return;
    // keep the position right even while hidden — sockets · pings read it (the remote avatar's contract)
    this.root.position.copy(v.position);
    const dead = v.dead || v.pose === 'dead';
    const visible = !v.hidden && !dead && (v.flags & ALLY_FLAGS.HIDDEN) === 0;
    if (visible !== this.shown) { this.shown = visible; this.model.setVisible(visible); }
    if (!visible) {
      this.model.setSilhouette(false);
      // dead = the corpse object (`game/Corpses`) stands in — the pose is reset once here so the body can be reused
      if (dead && !this.poseReset) { this.poseReset = true; this.model.resetPose(); }
      return;
    }
    this.poseReset = false;

    /* a body asleep in its slot = powered down — the same grey + dim visor as a suspended remote squadmate */
    const dormant = v.pose === 'dormant';
    if (dormant !== this.greyed) { this.greyed = dormant; this.model.setGreyed(dormant); }
    const downed = v.downed || v.pose === 'downed';
    // 2026-09-17: a body in the leaving extraction ship casts no silhouette through the closed hull (`inLeavingShip`)
    this.model.setSilhouette(!dormant && !inLeavingShip(ctx, v.position));

    this.syncArmor(ctx, v);
    const carry = v.pose === 'carry';
    const wantWeapon = !downed && !dormant && !carry;
    this.syncWeapon(ctx, wantWeapon ? v.weaponDefId : null);

    const flags = v.flags;
    const aiming = (flags & ALLY_FLAGS.AIM) !== 0 && !downed && this.weaponLook !== null;
    const firing = (flags & ALLY_FLAGS.FIRE) !== 0 && !downed;
    const reloading = (flags & ALLY_FLAGS.RELOAD) !== 0 && !downed;
    const sprinting = (flags & ALLY_FLAGS.SPRINT) !== 0 && !downed && !carry;
    const crouching = v.pose === 'crouch' && !downed;

    this.sprintBlend = damp(this.sprintBlend, sprinting ? 1 : 0, 8, dt);
    this.aimBlend = damp(this.aimBlend, aiming ? 1 : 0, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, crouching ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, downed ? 1 : 0, 8, dt);
    this.downedBlend = damp(this.downedBlend, downed ? 1 : 0, 7, dt);
    this.carryBlend = damp(this.carryBlend, carry && !downed ? 1 : 0, 8, dt);

    if (firing && this.weaponLook) {
      this.firePulse -= dt;
      if (this.firePulse <= 0) { this.recoil = Math.min(1, this.recoil + 0.8); this.firePulse = FIRE_PULSE_INTERVAL; }
    } else {
      this.firePulse = 0;
    }
    this.recoil = damp(this.recoil, 0, 14, dt);

    // body facing: aiming · firing · reloading · downed · dormant read `yaw`, everything else reads the actual
    // movement direction (the same rule as the local body)
    const vel = v.velocity;
    const speed = dormant ? 0 : Math.hypot(vel.x, vel.z);
    const faceYaw = aiming || firing || reloading || downed || dormant || carry;
    if (faceYaw || speed <= 0.4) this.bodyYaw = dampAngle(this.bodyYaw, v.yaw, downed ? 7 : 12, dt);
    else this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-vel.x, -vel.z), 12, dt);

    this.emitFootstep(ctx, v, sprinting);

    const p = this.pose;
    p.moveBlend = dormant ? 0 : v.moveBlend;
    p.sprint = this.sprintBlend;
    p.stridePhase = v.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.downed = this.downedBlend;
    p.aim = this.aimBlend;
    p.aimPitch = dormant ? 0 : v.pitch;
    p.torsoTwist = wrapAngle(v.yaw - this.bodyYaw);
    p.airborne = 0;
    p.verticalVel = 0;
    p.flinch = 0;
    p.hasWeapon = this.weaponLook !== null && !downed;
    p.twoHanded = this.weaponLook !== null;
    p.reloading = reloading && this.weaponLook !== null;
    p.recoil = this.recoil;
    p.carry = this.carryBlend;
    p.dead = 0;
    this.model.update(dt, ctx.time, p);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
  }

  /**
   * Footsteps on the **same test** as a remote squadmate (`remote:footstep`): the body is shown · the stride phase
   * crosses a π boundary · it is really moving. The distance falloff is `audio/`'s job.
   */
  private emitFootstep(ctx: GameContext, v: AllyBodyView, sprinting: boolean): void {
    const idx = Math.floor(v.stridePhase / Math.PI);
    if (idx === this.lastStepIdx) return;
    this.lastStepIdx = idx;
    if (!this.shown || v.downed || v.dead || v.mode === 'dormant' || v.pose === 'dormant') return;
    if (Math.hypot(v.velocity.x, v.velocity.z) <= STRIDE_MIN_SPEED) return;
    if (ctx.time - this.stepAt < FOOTSTEP_MIN_INTERVAL_S) return;
    this.stepAt = ctx.time;
    ctx.bus.emit('remote:footstep', { position: v.position, sprinting, peerId: v.id });
  }

  private syncArmor(ctx: GameContext, v: AllyBodyView): void {
    const id = v.armorDefId ?? null;
    if (id === this.armorLookId) return;
    this.armorLookId = id;
    this.model.setArmor(id ? resolveArmorDef(ctx, id) : null);
  }

  private syncWeapon(ctx: GameContext, defId: string | null): void {
    if (defId === this.weaponDefId) return;
    if (this.weaponLook) { this.weaponLook.group.removeFromParent(); this.weaponLook.dispose(); this.weaponLook = null; }
    this.weaponDefId = defId;
    if (!defId) return;
    const def = ctx.loot?.getWeaponDef(defId) ?? ctx.loot?.getWeaponDef(defId.replace(/_g\d+$/, '')) ?? null;
    const look = buildHeldWeapon(def ? weaponClassOfDef(def) : 'AR');
    this.weaponSocket.add(look.group);   // SoldierModel lifts socket children to the body render order
    this.weaponLook = look;
  }

  /** Hands the body back to the pool — everything this avatar hung on the socket comes off first. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.weaponLook) { this.weaponLook.group.removeFromParent(); this.weaponLook.dispose(); this.weaponLook = null; }
    this.weaponDefId = null;
    this.weaponSocket.removeFromParent();
    this.pool.release(this.model);   // `resetForReuse` undoes the android look · grey · pose and detaches the root
  }
}

/**
 * Lifetime manager for every android body (held by `RemotePlayerSystem`): building / returning bodies · the revive
 * interactable on a downed unit · the shot FX · carry-socket queries.
 */
export class AllyAvatars {
  private readonly avatars = new Map<AllyId, AllyAvatar>();
  private readonly revives = new Map<AllyId, ReviveEntry>();
  /** id → no revive interactable is re-registered until this time (a hold that just finished). */
  private readonly reviveSuppress = new Map<AllyId, number>();
  private frame = 0;
  /** Smoke-test only: when this list exists it is used instead of `ctx.allies.getBodies()` (`debugAllyBodies`). */
  private debug: DebugAllyBody[] | null = null;
  /** The last `update`'s ctx, kept so `clear()` can unregister the interactables too. */
  private reviveCtx: GameContext | null = null;

  constructor(private readonly scene: THREE.Object3D, private readonly pool: SoldierPool) {}

  /** How many bodies are drawn right now (smoke tests · debug). */
  get size(): number { return this.avatars.size; }
  getAvatar(id: AllyId): AllyAvatar | undefined { return this.avatars.get(id); }
  getAvatars(): ReadonlyMap<AllyId, AllyAvatar> { return this.avatars; }
  /** The units with a revive interactable registered right now (smoke tests). */
  getReviveTargets(): AllyId[] { return [...this.revives.keys()]; }
  has(id: AllyId): boolean { return this.avatars.has(id); }
  /** `id`'s shoulder socket (where a carried local player hangs), or null. */
  socketOf(id: AllyId): THREE.Object3D | null { return this.avatars.get(id)?.shoulderSocket ?? null; }

  /** The bodies to draw this frame — the smoke injection when there is one, else `ctx.allies`. */
  private bodiesOf(ctx: GameContext): readonly AllyBodyView[] {
    if (this.debug) return this.debug as unknown as readonly AllyBodyView[];
    return ctx.allies?.getBodies() ?? EMPTY_BODIES;
  }

  update(dt: number, ctx: GameContext): void {
    this.frame++;
    this.reviveCtx = ctx;
    const bodies = this.bodiesOf(ctx);
    let seen = 0;
    for (let i = 0; i < bodies.length; i++) {
      const v = bodies[i];
      if (!v || typeof v.id !== 'string') continue;
      const av = this.ensure(v);
      if (av.seenFrame !== this.frame) seen++;
      av.seenFrame = this.frame;
      av.update(dt, ctx, v);
      this.syncRevive(ctx, v);
    }
    // A body that vanished from the list goes back to the pool. The gate counts the **distinct avatars drawn this
    // frame** (2026-09-19, B-49), not `bodies.length`: a list that skipped an entry (no `id`) or repeated one is as
    // long as before while an avatar has gone stale, and `bodies.length` would never let the sweep run — the body
    // would hang in the scene and never return to `SoldierPool`. `size > seen` can only mean a stale avatar, so the
    // map is still walked (and allocated an iterator) on exactly the frames that need it.
    if (this.avatars.size > seen) {
      for (const [id, av] of this.avatars) if (av.seenFrame !== this.frame) this.remove(id);
    }
  }

  private ensure(v: AllyBodyView): AllyAvatar {
    let av = this.avatars.get(v.id);
    if (!av) {
      av = new AllyAvatar(v, this.scene, this.pool);
      this.avatars.set(v.id, av);
    }
    return av;
  }

  private remove(id: AllyId): void {
    this.unregisterRevive(id);
    const av = this.avatars.get(id);
    if (!av) return;
    this.avatars.delete(id);
    av.dispose();
  }

  /** Mission reset · entering a ship: every body goes back to the pool (rebuilt from the roster next frame). */
  clear(): void {
    for (const id of [...this.revives.keys()]) this.unregisterRevive(id);
    this.reviveSuppress.clear();
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
  }

  /* ─────────────────── the revive interactable ─────────────────── */
  /**
   * Every downed, not dead unit gets `revive:ally:<id>` — the **same hold time · range · progress UI** as a human
   * squadmate. Completing it is one `ctx.allies.requestRevive(id)` line; the authority re-judges distance · state.
   */
  private syncRevive(ctx: GameContext, v: AllyBodyView): void {
    const suppressed = (this.reviveSuppress.get(v.id) ?? 0) > ctx.time;
    const want = v.downed && !v.dead && !v.hidden && v.mode === 'raid' && !suppressed;
    const entry = this.revives.get(v.id);
    if (want && !entry) this.registerRevive(ctx, v);
    else if (!want && entry) this.unregisterRevive(v.id);
    if (!suppressed && this.reviveSuppress.has(v.id)) this.reviveSuppress.delete(v.id);
    const live = this.revives.get(v.id);
    if (live) live.position.copy(v.position);
  }

  private registerRevive(ctx: GameContext, v: AllyBodyView): void {
    const id = v.id;
    const name = v.name;
    const entry: ReviveEntry = { interactable: null as unknown as Interactable, position: v.position.clone() };
    entry.interactable = {
      id: `revive:ally:${id}`,
      position: entry.position,
      radius: PLAYER_REVIVE_RANGE,
      holdTime: PLAYER_REVIVE_HOLD,
      getPrompt: () => `${name} 일으키기`,
      canInteract: () => {
        const me = ctx.player;
        const body = ctx.allies?.getBody(id) ?? this.debugBody(id);
        return !!me && !me.isDead && !me.isDowned && ctx.isGameplayActive() && !!body && body.downed && !body.dead;
      },
      interact: () => {
        ctx.allies?.requestRevive(id);
        ctx.bus.emit('ui:notify', { text: `${name} 부활`, kind: 'success', duration: 2 });
        ctx.bus.emit('audio:play', { id: 'stim', position: entry.position, volume: 0.8 });
        this.reviveSuppress.set(id, ctx.time + REVIVE_DONE_SUPPRESS);
        this.unregisterRevive(id);
      },
    };
    this.revives.set(id, entry);
    ctx.interactables.register(entry.interactable);
  }

  private unregisterRevive(id: AllyId): void {
    const entry = this.revives.get(id);
    if (!entry) return;
    this.revives.delete(id);
    this.reviveCtx?.interactables.unregister(entry.interactable.id);
  }

  /* ─────────────────────────── shot FX ─────────────────────────── */
  /**
   * `ally:fired` — muzzle flash · tracer · shot sound. The authority has already applied the damage (this is FX
   * only). The flash borrows the fixed-size pool, so **the scene's point-light count does not change**.
   */
  onFired(ctx: GameContext, id: AllyId, from: THREE.Vector3, to: THREE.Vector3, weaponDefId: string | null): void {
    // allies/ reuses the vectors — copy them first
    _from.copy(from);
    _to.copy(to);
    const av = this.avatars.get(id);
    if (av && av.isShown) av.muzzleWorld(_from);
    const def = weaponDefId ? ctx.loot?.getWeaponDef(weaponDefId) ?? ctx.loot?.getWeaponDef(weaponDefId.replace(/_g\d+$/, '')) ?? null : null;
    const color = def?.tracerColor ?? 0xffd08a;
    _dir.copy(_to).sub(_from);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1); else _dir.normalize();
    const fx = FxManager.get();
    if (fx) {
      const len = _from.distanceTo(_to);
      fx.tracers.add(_from, _to, color, 0.035, len / 420 + 0.045, 420);
      fx.flashes.flash(_from, color, FLASH.intensity, FLASH.size, FLASH.life, FLASH.distance);
      _spark.copy(_from).addScaledVector(_dir, 0.1);
      ParticleBurst.sparks(fx.additive, _spark, _dir, 3, 9, color);
    }
    ctx.bus.emit('audio:play', { id: allyShotSound(def), position: _from, volume: 0.85, pitch: 0.95 + Math.random() * 0.1 });
  }

  /* ──────────────────────── being carried ──────────────────────── */
  /** Id of the android carrying `peer` (null = none). Smoke-injected bodies count too. */
  carrierOf(ctx: GameContext, peer: PeerId): AllyId | null {
    if (this.debug) {
      for (const b of this.debug) if (b.carrying === peer && !b.dead) return b.id;
      return null;
    }
    return ctx.allies?.carrierOf(peer)?.id ?? null;
  }

  /* ───────────────────── debug (smoke tests) ───────────────────── */
  /**
   * Smoke-test only: **swaps** `ctx.allies.getBodies()` for this list (`null` = back to normal). Bodies · poses ·
   * revives · carries can be checked exactly as they are even with no allies/ yet.
   */
  debugAllyBodies(views: DebugAllyBody[] | null): void {
    this.debug = views;
  }

  /** Smoke-test only: puts one body filled with defaults into the injection list and returns it (edit in place). */
  debugAllyBody(opts: Partial<DebugAllyBody> & { id: string }): DebugAllyBody {
    const body: DebugAllyBody = {
      id: opts.id,
      name: opts.name ?? '안드로이드 알파',
      bay: opts.bay ?? 0,
      slot: opts.slot ?? 1,
      mode: opts.mode ?? 'raid',
      state: opts.state ?? 'follow',
      pose: opts.pose ?? 'stand',
      position: opts.position ?? new THREE.Vector3(),
      velocity: opts.velocity ?? new THREE.Vector3(),
      yaw: opts.yaw ?? 0,
      pitch: opts.pitch ?? 0,
      hp: opts.hp ?? 500, maxHp: opts.maxHp ?? 500,
      shield: opts.shield ?? 0, maxShield: opts.maxShield ?? 0,
      downHp: opts.downHp ?? 0,
      downed: opts.downed ?? false,
      dead: opts.dead ?? false,
      hidden: opts.hidden ?? false,
      flags: opts.flags ?? 0,
      weaponDefId: opts.weaponDefId ?? null,
      armorDefId: opts.armorDefId ?? null,
      bagDefId: opts.bagDefId ?? null,
      carrying: opts.carrying ?? null,
      lookAt: opts.lookAt ?? null,
      stridePhase: opts.stridePhase ?? 0,
      moveBlend: opts.moveBlend ?? 0,
    };
    if (!this.debug) this.debug = [];
    this.debug.push(body);
    return body;
  }

  /** Smoke-test only: removes one injected body, or all of them. */
  debugAllyClear(id?: AllyId): void {
    if (!this.debug) return;
    if (id === undefined) { this.debug = null; return; }
    this.debug = this.debug.filter((b) => b.id !== id);
    if (this.debug.length === 0) this.debug = null;
  }

  private debugBody(id: AllyId): AllyBodyView | null {
    if (!this.debug) return null;
    for (const b of this.debug) if (b.id === id) return b as unknown as AllyBodyView;
    return null;
  }
}
