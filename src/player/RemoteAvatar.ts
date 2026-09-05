import * as THREE from 'three';
import {
  NET_SLOT_COLORS, PlayerFlags, type GameContext, type RemoteAvatarRef, type RemotePlayerRef,
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

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Visual stand-in for one remote player: a `SoldierModel` tinted with the peer's slot colour, driven each
 * frame from the interpolated `RemotePlayerRef` that net/NetSystem maintains. Implements `RemoteAvatarRef`
 * (weapons parents a WeaponModel into `weaponSocket`, the HUD reads `getHeadPosition` for nameplates).
 *
 * Nothing here simulates: position/velocity/yaw/pitch/stance/flags come straight from the ref; the avatar
 * only owns the damped animation blends (stance, aim, sprint, airborne, recoil, death) so the pose stays
 * smooth between 20 Hz snapshots. No collision with the local player.
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
  private recoil = 0;
  private firePulse = 0;
  private deadTimer = 0;
  private wasDead = false;
  private wasDropping: boolean;
  private lastStepIdx = 0;
  private shown = false;

  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, dive: 0,
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
    const visible = !dropping && !ref.stale && ref.connected;

    // ── landing burst: first frame out of the hellpod
    if (this.wasDropping && !dropping && ref.connected) {
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, ref.position, _up, 10, 1.0);
    }
    this.wasDropping = dropping;

    if (visible !== this.shown) { this.shown = visible; this.model.setVisible(visible); }
    // keep the root where the ref is even while hidden (weapon sockets / pings may read it)
    this.root.position.copy(ref.position);
    if (!visible) return;

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
    const prone = ref.stance === 'prone';
    this.sprintBlend = damp(this.sprintBlend, sprinting ? 1 : 0, 8, dt);
    this.aimBlend = damp(this.aimBlend, aiming && hasWeapon ? 1 : 0, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, ref.stance === 'crouch' && !diving ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, prone && !diving ? 1 : 0, 8, dt);
    this.diveBlend = damp(this.diveBlend, diving ? 1 : 0, 14, dt);
    this.airBlend = damp(this.airBlend, airborne ? 1 : 0, 12, dt);

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
      const faceCamera = aiming || firing || reloading || prone;
      if (diving && hSpeed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-v.x, -v.z), 20, dt);
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
    p.hasWeapon = hasWeapon;
    p.twoHanded = twoHanded;
    p.reloading = reloading && hasWeapon;
    p.recoil = this.recoil;
    p.dead = ref.isDead ? Math.min(1, this.deadTimer / DEATH_ANIM) : 0;
    this.model.update(dt, ctx.time, p);

    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
  }

  dispose(): void {
    if (this.ref.avatar === this) this.ref.avatar = null;
    this.model.dispose(); // also detaches the root (and any weapon model parented into the socket)
  }
}
