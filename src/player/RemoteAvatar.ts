import * as THREE from 'three';
import {
  NET_SLOT_COLORS, PlayerFlags, ROLL_DURATION, type GameContext, type RemoteAvatarRef, type RemotePlayerRef,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, SOLDIER_DEFAULT_ACCENT, type SoldierPose } from './SoldierModel';

const HEAD_STAND = 1.7;
const HEAD_CROUCH = 1.3;
const HEAD_PRONE = 0.5;
const DEATH_ANIM = 0.9;
/** Seconds between recoil pulses while the FIRING flag is set (≈ a 9 rps rifle). */
const FIRE_PULSE_INTERVAL = 0.11;
/** Melee swing length mirrored from PlayerSystem (MELEE_SWING_TIME); the wire only carries the flag. */
const MELEE_SWING_TIME = 0.45;
/** Opacity of a cloaked remote (matches the local player's own shimmer). */
const CLOAK_FADE = 0.4;
/** Height of the "downed" beacon above the feet. */
const DOWN_MARKER_Y = 0.95;

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Visual stand-in for one remote player: a `SoldierModel` tinted with the peer's slot colour, driven each
 * frame from the interpolated `RemotePlayerRef` that net/NetSystem maintains. Implements `RemoteAvatarRef`
 * (weapons parents a WeaponModel into `weaponSocket`, the HUD reads `getHeadPosition` for nameplates).
 *
 * Nothing here simulates: position/velocity/yaw/pitch/stance/flags come straight from the ref; the avatar
 * only owns the damped animation blends (stance, aim, sprint, airborne, recoil, death) so the pose stays
 * smooth between 20 Hz snapshots. No collision with the local player.
 * Hidden while `DROPPING` (hellpod) or `IN_POD` (hub launch pod); renders in the hub too (refs exist while
 * `ctx.net.inHubSession`). Shows the SoldierModel occlusion silhouette (slot-tinted) while alive & visible.
 * Phase 2: `DOWNED` → prone + crawl cycle (sprint/aim/crouch/dive blends forced off), `HOLDING_ITEM` → one-handed
 * item pose (`SoldierPose.holdItem`).
 */
export class RemoteAvatar implements RemoteAvatarRef {
  readonly model: SoldierModel;
  readonly root: THREE.Group;
  readonly weaponSocket: THREE.Object3D;

  /** Frame stamp used by RemotePlayerSystem to sweep avatars whose ref vanished without an event. */
  seenFrame = 0;

  private bodyYaw: number;
  private sprintBlend = 0;
  private crouchBlend = 0;
  private proneBlend = 0;
  private diveBlend = 0;
  private aimBlend = 0;
  private airBlend = 0;
  private holdItemBlend = 0;
  private recoil = 0;
  private firePulse = 0;
  private deadTimer = 0;
  private wasDead = false;
  private wasDropping: boolean;
  private lastStepIdx = 0;
  private shown = false;
  /* ── tactical kit ── */
  private rollBlend = 0;
  private rollPhase = 0;
  private rollTimer = 0;
  private wasRolling = false;
  private meleeTimer = -1;
  private wasMelee = false;
  private hoverBlend = 0;
  private downedBlend = 0;
  private fadeTarget = 1;
  /** Pulsing beacon shown over a downed team-mate (a 표식 the whole squad can see through the crowd). */
  private downMarker: THREE.Mesh | null = null;
  private downMarkerGeo: THREE.BufferGeometry | null = null;
  private downMarkerMat: THREE.MeshBasicMaterial | null = null;

  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, dive: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
  };

  constructor(readonly ref: RemotePlayerRef, parent: THREE.Object3D) {
    const accent = NET_SLOT_COLORS[ref.slot] ?? SOLDIER_DEFAULT_ACCENT;
    this.model = new SoldierModel(accent);
    this.root = this.model.root;
    this.root.name = `RemoteSoldier:${ref.id}`;
    this.weaponSocket = this.model.weaponSocket;
    this.bodyYaw = ref.yaw;
    this.wasDropping = (ref.flags & PlayerFlags.DROPPING) !== 0;
    this.wasDead = ref.isDead;
    this.lastStepIdx = Math.floor(ref.stridePhase / Math.PI);
    this.root.position.copy(ref.position);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    this.root.visible = false;
    parent.add(this.root);
  }

  /** World-space head position for the current (blended) stance. */
  getHeadPosition(out: THREE.Vector3): THREE.Vector3 {
    const lie = Math.min(1, this.proneBlend + this.diveBlend);
    let h = THREE.MathUtils.lerp(HEAD_STAND, HEAD_CROUCH, this.crouchBlend);
    h = THREE.MathUtils.lerp(h, HEAD_PRONE, lie);
    if (this.pose.dead > 0) h = THREE.MathUtils.lerp(h, HEAD_PRONE, this.pose.dead);
    return out.copy(this.ref.position).setY(this.ref.position.y + h);
  }

  update(dt: number, ctx: GameContext): void {
    const ref = this.ref;
    const flags = ref.flags;
    const dropping = (flags & PlayerFlags.DROPPING) !== 0;
    const inPod = (flags & PlayerFlags.IN_POD) !== 0;   // boarded in a hub launch pod: pod shown closed, body hidden
    const visible = !dropping && !inPod && !ref.stale && ref.connected;

    // ── landing burst: first frame out of the hellpod
    if (this.wasDropping && !dropping && ref.connected) {
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, ref.position, _up, 10, 1.0);
    }
    this.wasDropping = dropping;

    if (visible !== this.shown) { this.shown = visible; this.model.setVisible(visible); }
    // keep the root where the ref is even while hidden (weapon sockets / pings may read it)
    this.root.position.copy(ref.position);
    if (!visible) {
      this.model.setSilhouette(false);
      if (this.downMarker) this.downMarker.visible = false;
      return;
    }
    // ── cloak: the peer shimmers translucent (setFade also suppresses the silhouette)
    const cloaked = ref.isCloaked || (flags & PlayerFlags.CLOAKED) !== 0;
    const wantFade = cloaked && !ref.isDead ? CLOAK_FADE : 1;
    if (wantFade !== this.fadeTarget) { this.fadeTarget = wantFade; this.model.setFade(wantFade); }
    // slot-tinted occlusion silhouette (same GreaterDepth pass as the local soldier); off while dead / cloaked
    this.model.setSilhouette(!ref.isDead && wantFade >= 1);

    // ── death ramp (reset when the peer respawns)
    if (ref.isDead) {
      if (!this.wasDead) this.deadTimer = 0;
      this.deadTimer += dt;
    } else if (this.wasDead) {
      this.deadTimer = 0;
      this.model.resetPose();
    }
    this.wasDead = ref.isDead;

    // ── flags → blends
    const sprinting = (flags & PlayerFlags.SPRINT) !== 0;
    const aiming = (flags & PlayerFlags.AIM) !== 0;
    const diving = (flags & PlayerFlags.DIVE) !== 0;
    const airborne = (flags & PlayerFlags.AIRBORNE) !== 0 && !diving;
    const firing = (flags & PlayerFlags.FIRING) !== 0;
    const reloading = (flags & PlayerFlags.RELOADING) !== 0;
    const hasWeapon = (flags & PlayerFlags.HAS_WEAPON) !== 0;
    const twoHanded = (flags & PlayerFlags.TWO_HANDED) !== 0;
    // downed (전투불능): always lying prone, crawl cycle from stride/moveBlend; weapons hides the gun model itself
    const downed = ref.isDowned || (flags & PlayerFlags.DOWNED) !== 0;
    const holdingItem = (flags & PlayerFlags.HOLDING_ITEM) !== 0 && !downed;
    const prone = ref.stance === 'prone' || downed;
    /* ── tactical kit flags: the DIVE bit now means "rolling"; melee / hover have their own bits ── */
    const rolling = diving && !downed;
    const hovering = (flags & PlayerFlags.HOVER) !== 0;
    const meleeing = (flags & PlayerFlags.MELEE) !== 0;

    // roll: the wire only carries the flag, so the tumble phase is timed locally
    if (rolling) {
      if (!this.wasRolling) this.rollTimer = 0;
      this.rollTimer += dt;
      this.rollPhase = Math.min(1, this.rollTimer / ROLL_DURATION);
    } else if (this.rollBlend < 0.01) {
      this.rollPhase = 0; this.rollTimer = 0;
    }
    this.wasRolling = rolling;
    this.rollBlend = damp(this.rollBlend, rolling ? 1 : 0, 18, dt);

    // melee: one swing per rising edge of the flag, replayed at the local swing length
    if (meleeing && !this.wasMelee) this.meleeTimer = 0;
    this.wasMelee = meleeing;
    if (this.meleeTimer >= 0) {
      this.meleeTimer += dt;
      if (this.meleeTimer >= MELEE_SWING_TIME) this.meleeTimer = -1;
    }

    this.sprintBlend = damp(this.sprintBlend, sprinting && !downed ? 1 : 0, 8, dt);
    this.aimBlend = damp(this.aimBlend, aiming && hasWeapon && !downed ? 1 : 0, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, ref.stance === 'crouch' && !rolling && !downed ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, prone && !rolling ? 1 : 0, 8, dt);
    this.diveBlend = 0;
    this.airBlend = damp(this.airBlend, airborne && !downed && !rolling ? 1 : 0, 12, dt);
    this.holdItemBlend = damp(this.holdItemBlend, holdingItem ? 1 : 0, 10, dt);
    this.hoverBlend = damp(this.hoverBlend, hovering ? 1 : 0, 10, dt);
    this.updateDownMarker(ctx, downed && !ref.isDead);

    // ── recoil pulses while firing
    if (firing && hasWeapon) {
      this.firePulse -= dt;
      if (this.firePulse <= 0) { this.recoil = Math.min(1, this.recoil + 0.8); this.firePulse = FIRE_PULSE_INTERVAL; }
    } else {
      this.firePulse = 0;
    }
    this.recoil = damp(this.recoil, 0, 14, dt);

    // ── body yaw: mirror PlayerSystem — dive direction while diving, camera yaw when aiming/firing/reloading/prone,
    //    otherwise the horizontal velocity direction once actually moving
    const v = ref.velocity;
    const hSpeed = Math.hypot(v.x, v.z);
    if (!ref.isDead) {
      const faceCamera = (aiming || firing || reloading || prone || meleeing) && !rolling;
      if ((diving || rolling) && hSpeed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-v.x, -v.z), 20, dt);
      else if (faceCamera) this.bodyYaw = dampAngle(this.bodyYaw, ref.yaw, prone ? 7 : 18, dt);
      else if (hSpeed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-v.x, -v.z), 12, dt);
    }

    // ── sprint footstep dust (one puff per step boundary)
    const stepIdx = Math.floor(ref.stridePhase / Math.PI);
    if (stepIdx !== this.lastStepIdx) {
      this.lastStepIdx = stepIdx;
      if (sprinting && !airborne && !ref.isDead) {
        const fx = FxManager.get();
        if (fx) ParticleBurst.dust(fx.alpha, ref.position, _up, 1, 0.5);
      }
    }

    // ── pose
    const p = this.pose;
    p.moveBlend = ref.moveBlend;
    p.sprint = this.sprintBlend;
    p.stridePhase = ref.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.dive = this.diveBlend;
    p.aim = this.aimBlend;
    p.aimPitch = ref.pitch;
    p.torsoTwist = wrapAngle(ref.yaw - this.bodyYaw);
    p.airborne = this.airBlend;
    p.verticalVel = v.y;
    p.flinch = 0;
    p.hasWeapon = hasWeapon && !downed;
    p.twoHanded = twoHanded;
    p.reloading = reloading && hasWeapon;
    p.recoil = this.recoil;
    p.throw = 0;   // no wire flag for the wind-up (weapons replays the throw FX)
    p.holdItem = this.holdItemBlend;
    p.roll = this.rollBlend;
    p.rollPhase = this.rollPhase;
    p.melee = this.meleeTimer >= 0 ? Math.min(1, this.meleeTimer / MELEE_SWING_TIME) : 0;
    p.hover = this.hoverBlend;
    p.downed = 0;   // 전투불능 keeps the Phase 2 prone crawl
    p.dead = ref.isDead ? Math.min(1, this.deadTimer / DEATH_ANIM) : 0;
    this.model.update(dt, ctx.time, p);

    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
  }

  /**
   * Pulsing beacon over a downed team-mate. Built lazily (nothing is allocated for peers that never go down),
   * emissive-only so the scene's light count never changes, and disposed with the avatar.
   */
  private updateDownMarker(ctx: GameContext, on: boolean): void {
    if (!on) {
      if (this.downMarker) this.downMarker.visible = false;
      return;
    }
    if (!this.downMarker) {
      this.downMarkerGeo = new THREE.OctahedronGeometry(0.16, 0);
      this.downMarkerMat = new THREE.MeshBasicMaterial({
        color: this.model.accentColor, transparent: true, opacity: 0.9, depthWrite: false, fog: false, toneMapped: false,
      });
      this.downMarker = new THREE.Mesh(this.downMarkerGeo, this.downMarkerMat);
      this.downMarker.renderOrder = 3;
      this.downMarker.castShadow = false;
      this.downMarker.receiveShadow = false;
      // parented to the root, which stays at the peer's feet and only yaws
      this.downMarker.position.set(0, DOWN_MARKER_Y, 0);
      this.root.add(this.downMarker);
    }
    this.downMarker.visible = true;
    const t = ctx.time;
    this.downMarker.position.y = DOWN_MARKER_Y + Math.sin(t * 3) * 0.08;
    this.downMarker.rotation.y = t * 1.6;
    if (this.downMarkerMat) this.downMarkerMat.opacity = 0.55 + Math.sin(t * 6) * 0.35;
  }

  dispose(): void {
    if (this.ref.avatar === this) this.ref.avatar = null;
    this.downMarkerGeo?.dispose();
    this.downMarkerMat?.dispose();
    this.downMarker = null; this.downMarkerGeo = null; this.downMarkerMat = null;
    this.model.dispose(); // also detaches the root (and any weapon model parented into the socket)
  }
}
