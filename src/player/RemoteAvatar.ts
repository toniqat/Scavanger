import * as THREE from 'three';
import {
  NET_SLOT_COLORS, PlayerFlags, ROLL_DURATION, SLASH_DURATION, type ArmorDef, type GameContext, type RemoteAvatarRef,
  type RemotePlayerRef,
} from '@/shared';
import { LADDER_RUNG_M } from './PlayerController';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, SOLDIER_DEFAULT_ACCENT, type SoldierPose } from './SoldierModel';
import { buildHeldItem, type GearLook } from './GearLook';
import type { SoldierPool } from './SoldierPool';

/* Nameplate anchors for the armoured trooper body (head ≈ 1.7 m standing; the HUD adds +0.35 m). */
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
/**
 * Flags that still mean something while a member is suspended (its last snapshot is frozen, the host's ghost
 * drives hp / downed / dead): everything animated (sprint, aim, fire, melee, …) is masked out.
 */
const SUSPENDED_FLAG_MASK = PlayerFlags.HAS_WEAPON | PlayerFlags.TWO_HANDED | PlayerFlags.DOWNED | PlayerFlags.DEAD
  | PlayerFlags.IN_POD | PlayerFlags.IN_HUB;

/* ── 사다리 (2026-09-11) ── */
/** A snapshot height change bigger than this in one frame is a teleport / stream restart, not climbing. */
const CLIMB_PHASE_MAX_DY = 1;
/** A climbing peer is matched to the ladder whose base is this close (XZ, m) to face its rungs. */
const CLIMB_LADDER_MATCH_M = 1.2;
/** Volume of a remote rung clank (positional; the local climber plays 0.45 / 0.6). */
const REMOTE_RUNG_VOLUME = 0.35;

const _up = new THREE.Vector3(0, 1, 0);
const _wp = new THREE.Vector3();

/** Duck-typed view of the Phase 7 snapshot fields net/ mirrors on its refs (`PlayerSnapshot.h`). */
interface HeldItemSource { heldItemId?: string | null; heldItem?: string | null }

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
 * Phase 2: `DOWNED` → prone + crawl cycle (sprint/aim/crouch/roll blends forced off), `HOLDING_ITEM` → one-handed
 * item pose (`SoldierPose.holdItem`).
 * Phase 7: a `suspended` ref stays visible even while stale — grey tint, no silhouette, downed / dead pose from
 * the ghost-driven `isDowned` / `isDead`; `THROWING` → wind-up, `COOKING` → pin-pull pose, `h` (held def id) →
 * procedural item mesh in the hand (+ `net:remoteHeldItem`), `CHARGING / SPRAYING / HEAVY` → unique-weapon
 * stances, `MELEE_HEAVY` → the 용검 sweep for `SLASH_DURATION`, `ar` → armor plates, `OVERCHARGED` → rim glow.
 */
export class RemoteAvatar implements RemoteAvatarRef {
  readonly model: SoldierModel;
  readonly root: THREE.Group;
  readonly weaponSocket: THREE.Object3D;
  /** Right-shoulder socket a carried squadmate hangs on (Phase 10, `RemoteAvatarRef.shoulderSocket`). */
  readonly shoulderSocket: THREE.Object3D;

  /** Frame stamp used by RemotePlayerSystem to sweep avatars whose ref vanished without an event. */
  seenFrame = 0;
  /** 2026-09-10: where the body goes back on `dispose` (null = dispose it). */
  private readonly pool: SoldierPool | null;
  /** Set by `dispose` — the body may already belong to another avatar, so nothing may touch it afterwards. */
  private disposed = false;
  /**
   * Phase 10: this body is riding on somebody's shoulder socket — its `root` transform is owned by that socket,
   * so the per-frame `position` / `quaternion` writes are skipped. Set by `RemotePlayerSystem` for instant local
   * feedback (the peer's own `flags & CARRIED` only arrives a round-trip later).
   */
  carried = false;

  private bodyYaw: number;
  private sprintBlend = 0;
  private crouchBlend = 0;
  private proneBlend = 0;
  private downedBlend = 0;
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
  private meleeDuration = MELEE_SWING_TIME;
  private meleeHeavy = 0;
  private wasMelee = false;
  private hoverBlend = 0;
  private fadeTarget = 1;
  /* ── Phase 7 ── */
  private throwBlend = 0;
  private cookBlend = 0;
  private chargeBlend = 0;
  private sprayBlend = 0;
  private heavyBlend = 0;
  /** Phase 10: `PlayerFlags.CARRYING` → the fireman-carry arm pose (the load itself is another avatar). */
  private carryBlend = 0;
  /* ── 2026-09-11: `PlayerFlags.CLIMBING` — the wire has only the bit, so the rung phase comes from the snapshot height ── */
  private climbBlend = 0;
  private climbPhase = 0;
  private climbLastY = Number.NaN;
  private climbStepIdx = 0;
  /** Facing of the matched ladder (`atan2(normal.x, normal.z)`); null = not matched yet / not climbing. */
  private climbYaw: number | null = null;
  private heldLook: GearLook | null = null;
  private heldDefId: string | null = null;
  private armorLookId: string | null = null;
  /** Pulsing beacon shown over a downed team-mate (a 표식 the whole squad can see through the crowd). */
  private downMarker: THREE.Mesh | null = null;
  private downMarkerGeo: THREE.BufferGeometry | null = null;
  private downMarkerMat: THREE.MeshBasicMaterial | null = null;

  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };

  /**
   * @param pool 2026-09-10: the body comes from (and goes back to) this pool instead of being built / disposed per
   *   avatar. `null` keeps the old build-and-dispose behaviour.
   */
  constructor(readonly ref: RemotePlayerRef, parent: THREE.Object3D, pool: SoldierPool | null = null) {
    const accent = NET_SLOT_COLORS[ref.slot] ?? SOLDIER_DEFAULT_ACCENT;
    this.pool = pool;
    this.model = pool ? pool.acquire(accent) : new SoldierModel(accent);
    this.root = this.model.root;
    this.root.name = `RemoteSoldier:${ref.id}`;
    /*
     * 2026-09-10: a **fresh socket object per avatar**, parented at identity inside the model's hand socket. The body
     * itself may be a pooled one another avatar used a moment ago; `weapons/RemoteWeapons` (and `implants/`) key their
     * attachments on socket identity (`e.socket !== socket` → rebuild), so handing out the model's own socket again
     * would let them believe a weapon they parented into a now-parked body is still in the hand. `dispose` detaches
     * this object, and whatever other folders hung on it leaves with it — exactly what disposing the model did before.
     */
    this.weaponSocket = new THREE.Object3D();
    this.weaponSocket.name = 'RemoteWeaponSocket';
    this.model.weaponSocket.add(this.weaponSocket);
    this.shoulderSocket = this.model.shoulderSocket;
    this.bodyYaw = ref.yaw;
    this.wasDropping = (ref.flags & PlayerFlags.DROPPING) !== 0;
    this.wasDead = ref.isDead;
    this.lastStepIdx = Math.floor(ref.stridePhase / Math.PI);
    this.root.position.copy(ref.position);
    this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
    this.root.visible = false;
    parent.add(this.root);
  }

  /** true while the body is parented into a carrier's shoulder socket (local flag or the wire's CARRIED bit). */
  private get isRiding(): boolean { return this.carried || this.ref.isCarried === true; }

  /** World-space head position for the current (blended) stance. */
  getHeadPosition(out: THREE.Vector3): THREE.Vector3 {
    const lie = Math.min(1, this.proneBlend);
    let h = THREE.MathUtils.lerp(HEAD_STAND, HEAD_CROUCH, this.crouchBlend);
    h = THREE.MathUtils.lerp(h, HEAD_PRONE, lie);
    if (this.pose.dead > 0) h = THREE.MathUtils.lerp(h, HEAD_PRONE, this.pose.dead);
    // while carried the ref's own position is stale — the body hangs wherever the carrier's socket is
    const base = this.isRiding ? this.root.getWorldPosition(_wp) : this.ref.position;
    return out.copy(base).setY(base.y + h);
  }

  /* ── Phase 7 queries (smoke tests / HUD) ── */
  /** Def id of the consumable / gadget mesh currently in the hand (null = none). */
  get heldItemId(): string | null { return this.heldDefId; }
  /** Armor plate def id shown on the body (null = none). */
  get armorId(): string | null { return this.model.armorId; }
  get isGreyed(): boolean { return this.model.isGreyed; }
  get isShown(): boolean { return this.shown; }
  /** 0..1 of the heavy slash replay (0 = none). */
  get heavySlashProgress(): number { return this.meleeTimer >= 0 && this.meleeHeavy > 0 ? Math.min(1, this.meleeTimer / this.meleeDuration) : 0; }
  /** Current pose values (read-only snapshot for tests). */
  get poseView(): Readonly<SoldierPose> { return this.pose; }

  update(dt: number, ctx: GameContext): void {
    if (this.disposed) return;   // the pooled body may already be driving another avatar
    const ref = this.ref;
    const suspended = ref.suspended === true;
    const rawFlags = ref.flags;
    const flags = suspended ? rawFlags & SUSPENDED_FLAG_MASK : rawFlags;
    const dropping = (flags & PlayerFlags.DROPPING) !== 0;
    const inPod = (flags & PlayerFlags.IN_POD) !== 0;   // boarded in a hub launch pod: pod shown closed, body hidden
    /*
     * 공용 함선 격납고 (2026-09-08): every ship interior is built at the world origin, so two members standing in
     * *different* ships occupy the same coordinates. `hubSite` (`PlayerSnapshot.hs`) says which one each of us is in
     * — null = the shared deck (공유 함선 + 격납고) — and a peer somewhere else is simply not drawn. Two people
     * touring the same 개인 함선 do see each other, which is the whole point.
     */
    const elsewhere = (ref.hubSite ?? null) !== (ctx.hub?.hubSite ?? null);
    /*
     * 2026-09-09: 완전히 사망한 분대원은 **시체 오브젝트**(`ctx.corpses`)가 대신 서 있다. 그 시체가 존재하는
     * 동안 아바타까지 죽은 자세로 누워 있으면 같은 자리에 몸이 둘이므로 아바타를 감춘다. 전투불능(`downed`)은
     * 시체가 아니라 여전히 아바타다 — 제세동기로 일어날 수 있다.
     */
    const replacedByCorpse = ref.isDead && !!ctx.corpses?.latestOf(ref.id);
    // Phase 7: a suspended member stays visible even though its snapshots are stale (the host's ghost owns the body)
    const visible = !dropping && !inPod && !elsewhere && !replacedByCorpse && (suspended || (!ref.stale && ref.connected));

    // ── landing burst: first frame out of the hellpod
    if (this.wasDropping && !dropping && ref.connected) {
      const fx = FxManager.get();
      if (fx) ParticleBurst.dust(fx.alpha, ref.position, _up, 10, 1.0);
    }
    this.wasDropping = dropping;

    const riding = this.isRiding;
    if (visible !== this.shown) { this.shown = visible; this.model.setVisible(visible); }
    // keep the root where the ref is even while hidden (weapon sockets / pings may read it) — unless the body is
    // riding on a carrier's shoulder socket, which owns the transform (Phase 10)
    if (!riding) this.root.position.copy(ref.position);
    if (!visible) {
      this.model.setSilhouette(false);
      if (this.downMarker) this.downMarker.visible = false;
      return;
    }
    // ── suspended: flat grey, no silhouette, no glow
    this.model.setGreyed(suspended);
    // ── cloak: the peer shimmers translucent (setFade also suppresses the silhouette)
    const cloaked = !suspended && (ref.isCloaked || (flags & PlayerFlags.CLOAKED) !== 0);
    const wantFade = cloaked && !ref.isDead ? CLOAK_FADE : 1;
    if (wantFade !== this.fadeTarget) { this.fadeTarget = wantFade; this.model.setFade(wantFade); }
    // slot-tinted occlusion silhouette (same GreaterDepth pass as the local soldier); off while dead / cloaked / suspended
    this.model.setSilhouette(!ref.isDead && wantFade >= 1 && !suspended);
    // overcharge buff → rim glow
    this.model.setGlow((flags & PlayerFlags.OVERCHARGED) !== 0 && !ref.isDead);
    // gear looks: armor plates from `ar`, held consumable from `h`
    this.syncArmor(ctx);
    const holdingItemFlag = (flags & PlayerFlags.HOLDING_ITEM) !== 0;
    this.syncHeldItem(ctx, holdingItemFlag && !ref.isDead);

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
    const holdingItem = holdingItemFlag && !downed;
    const throwing = (flags & PlayerFlags.THROWING) !== 0 && !downed;
    const cooking = (flags & PlayerFlags.COOKING) !== 0 && !downed && !throwing;
    const prone = ref.stance === 'prone' || downed;
    /* ── tactical kit flags: the DIVE bit now means "rolling"; melee / hover have their own bits ── */
    const rolling = diving && !downed;
    const hovering = (flags & PlayerFlags.HOVER) !== 0;
    const meleeing = (flags & PlayerFlags.MELEE) !== 0;
    const meleeHeavy = (flags & PlayerFlags.MELEE_HEAVY) !== 0;
    /* ── Phase 7 unique-weapon stances (only with a weapon in hand, never while downed) ── */
    const charging = (flags & PlayerFlags.CHARGING) !== 0 && hasWeapon && !downed;
    const spraying = (flags & PlayerFlags.SPRAYING) !== 0 && hasWeapon && !downed;
    const heavy = (flags & PlayerFlags.HEAVY) !== 0 && hasWeapon && !downed;
    const moveBlend = suspended ? 0 : ref.moveBlend;
    // 사다리 (2026-09-11): 오르기 자세 — 위상은 높이 변화에서, 방향은 가까운 사다리에서
    const climbing = (flags & PlayerFlags.CLIMBING) !== 0 && !downed && !ref.isDead;
    this.updateClimb(ctx, climbing);
    this.climbBlend = damp(this.climbBlend, climbing ? 1 : 0, 12, dt);

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

    // melee: one swing per rising edge of the flag, replayed at the local swing length — MELEE_HEAVY (set together
    // with MELEE) picks the two-handed 용검 sweep at SLASH_DURATION instead of the chop
    if (meleeing && !this.wasMelee) {
      this.meleeTimer = 0;
      this.meleeHeavy = meleeHeavy ? 1 : 0;
      this.meleeDuration = meleeHeavy ? SLASH_DURATION : MELEE_SWING_TIME;
    }
    this.wasMelee = meleeing;
    if (this.meleeTimer >= 0) {
      this.meleeTimer += dt;
      if (this.meleeTimer >= this.meleeDuration) { this.meleeTimer = -1; this.meleeHeavy = 0; }
    }

    this.sprintBlend = damp(this.sprintBlend, sprinting && !downed && !climbing ? 1 : 0, 8, dt);
    this.aimBlend = damp(this.aimBlend, aiming && hasWeapon && !downed ? 1 : 0, 12, dt);
    this.crouchBlend = damp(this.crouchBlend, ref.stance === 'crouch' && !rolling && !downed ? 1 : 0, 10, dt);
    this.proneBlend = damp(this.proneBlend, prone && !rolling ? 1 : 0, 8, dt);
    this.downedBlend = damp(this.downedBlend, downed && !ref.isDead ? 1 : 0, 7, dt);
    // a climber is not grounded on the wire (AIRBORNE) but must not play the jump / fall tuck
    this.airBlend = damp(this.airBlend, airborne && !downed && !rolling && !climbing ? 1 : 0, 12, dt);
    this.holdItemBlend = damp(this.holdItemBlend, holdingItem ? 1 : 0, 10, dt);
    this.throwBlend = damp(this.throwBlend, throwing ? 1 : 0, 12, dt);
    this.cookBlend = damp(this.cookBlend, cooking ? 1 : 0, 10, dt);
    this.chargeBlend = damp(this.chargeBlend, charging ? 1 : 0, 10, dt);
    this.sprayBlend = damp(this.sprayBlend, spraying ? 1 : 0, 12, dt);
    this.heavyBlend = damp(this.heavyBlend, heavy ? 1 : 0, 8, dt);
    this.hoverBlend = damp(this.hoverBlend, hovering ? 1 : 0, 10, dt);
    // Phase 10: carrying a squadmate (the load is that peer's own avatar in `shoulderSocket`)
    const carrying = (flags & PlayerFlags.CARRYING) !== 0 && !downed && !ref.isDead;
    this.carryBlend = damp(this.carryBlend, carrying ? 1 : 0, 8, dt);
    this.updateDownMarker(ctx, downed && !ref.isDead);

    // ── recoil pulses while firing
    if (firing && hasWeapon) {
      this.firePulse -= dt;
      if (this.firePulse <= 0) { this.recoil = Math.min(1, this.recoil + 0.8); this.firePulse = FIRE_PULSE_INTERVAL; }
    } else {
      this.firePulse = 0;
    }
    this.recoil = damp(this.recoil, 0, 14, dt);

    // ── body yaw: mirror PlayerSystem — roll direction while rolling, camera yaw when aiming/firing/reloading/
    //    throwing/prone, otherwise the horizontal velocity direction once actually moving. A suspended body holds.
    const v = ref.velocity;
    const hSpeed = suspended ? 0 : Math.hypot(v.x, v.z);
    if (!ref.isDead) {
      const faceCamera = (aiming || firing || reloading || prone || meleeing || throwing || cooking || suspended) && !rolling;
      // climbing: face the matched ladder's rungs (the snapshot yaw is the camera's); unmatched → hold the facing
      if (climbing) { if (this.climbYaw !== null) this.bodyYaw = dampAngle(this.bodyYaw, this.climbYaw, 18, dt); }
      else if (rolling && hSpeed > 0.4) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(-v.x, -v.z), 20, dt);
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
    p.moveBlend = moveBlend;
    p.sprint = this.sprintBlend;
    p.stridePhase = this.climbBlend > 0.01 ? this.climbPhase : ref.stridePhase;
    p.crouch = this.crouchBlend;
    p.prone = this.proneBlend;
    p.aim = this.aimBlend;
    p.aimPitch = suspended ? 0 : ref.pitch;
    p.torsoTwist = wrapAngle(ref.yaw - this.bodyYaw);
    p.airborne = this.airBlend;
    p.verticalVel = suspended ? 0 : v.y;
    p.flinch = 0;
    p.hasWeapon = hasWeapon && !downed;
    p.twoHanded = twoHanded;
    p.reloading = reloading && hasWeapon;
    p.recoil = this.recoil;
    p.throw = this.throwBlend;
    p.holdItem = this.holdItemBlend;
    p.cooking = this.cookBlend;
    p.roll = this.rollBlend;
    p.rollPhase = this.rollPhase;
    p.melee = this.meleeTimer >= 0 ? Math.min(1, this.meleeTimer / this.meleeDuration) : 0;
    p.meleeHeavy = this.meleeHeavy;
    p.charging = this.chargeBlend;
    p.spraying = this.sprayBlend;
    p.heavyCarry = this.heavyBlend;
    p.hover = this.hoverBlend;
    p.downed = this.downedBlend;   // 2026-09-08: 전투불능 = the backward-fall pose, same as the local player
    p.dead = ref.isDead ? Math.min(1, this.deadTimer / DEATH_ANIM) : 0;
    p.carry = this.carryBlend;
    p.climb = this.climbBlend;
    this.model.update(dt, ctx.time, p);

    if (!riding) this.root.quaternion.setFromAxisAngle(_up, this.bodyYaw);
  }

  /**
   * 사다리 (2026-09-11). The wire carries only `CLIMBING`: the rung phase is accumulated from the interpolated
   * snapshot height (π per `LADDER_RUNG_M`, same rule as the local controller), each rung boundary plays a quiet
   * positional `ladder_step`, and the facing comes from the nearest ladder in `ctx.world.getLadders()`.
   */
  private updateClimb(ctx: GameContext, climbing: boolean): void {
    if (!climbing) { this.climbLastY = Number.NaN; this.climbYaw = null; return; }
    const y = this.ref.position.y;
    if (Number.isFinite(this.climbLastY)) {
      const dy = Math.abs(y - this.climbLastY);
      if (dy < CLIMB_PHASE_MAX_DY) this.climbPhase += dy / LADDER_RUNG_M * Math.PI;
    }
    this.climbLastY = y;
    const idx = Math.floor(this.climbPhase / Math.PI);
    if (idx !== this.climbStepIdx) {
      this.climbStepIdx = idx;
      ctx.bus.emit('audio:play', { id: 'ladder_step', position: this.ref.position, volume: REMOTE_RUNG_VOLUME });
    }
    if (this.climbYaw === null) this.climbYaw = nearestLadderYaw(ctx, this.ref.position);
  }

  /** Test query: 0..1 climb blend. */
  get climbAmount(): number { return this.climbBlend; }

  /* ─────────────────────────── Phase 7 gear looks ─────────────────────────── */
  /**
   * `ar` (armor def id from the snapshot) → the same plate set the local player wears. Accepts either an
   * `ArmorDef.id` or the item def id (`ItemDef.armorId` link); resolved through `ctx.loot`, nothing shown when
   * the def is unknown. Rebuilt only when the id changes.
   */
  private syncArmor(ctx: GameContext): void {
    const id = this.ref.armorId ?? null;
    if (id === this.armorLookId) return;
    this.armorLookId = id;
    this.model.setArmor(id ? resolveArmorDef(ctx, id) : null);
  }

  /**
   * `h` (held def id) → procedural item mesh in the right hand while `HOLDING_ITEM`. The category comes from
   * `ctx.loot.getItemDef(h).category` (stim / grenade / gadget looks). Emits `net:remoteHeldItem` whenever the
   * shown def changes (including → null).
   */
  private syncHeldItem(ctx: GameContext, holding: boolean): void {
    const src = this.ref as unknown as HeldItemSource;
    const raw = src.heldItemId !== undefined ? src.heldItemId : src.heldItem;
    const want = holding && typeof raw === 'string' && raw.length > 0 ? raw : null;
    if (want === this.heldDefId) return;
    if (this.heldLook) { this.heldLook.dispose(); this.heldLook = null; }
    this.heldDefId = want;
    if (want) {
      const def = ctx.loot?.getItemDef(want);
      const look = buildHeldItem(def?.category ?? null);
      this.weaponSocket.add(look.group);   // SoldierModel lifts new socket children to the body render order
      this.heldLook = look;
    }
    ctx.bus.emit('net:remoteHeldItem', { id: this.ref.id, defId: want });
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

  /**
   * Ends this avatar. The body goes back to the pool (2026-09-10) — or is disposed without one — so everything this
   * avatar hung on it has to come off first: the held-item look, the downed beacon, and the per-avatar weapon socket
   * (taking whatever `weapons/` · `implants/` parented into it along, the same subtree disposing the model detached).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ref.avatar === this) this.ref.avatar = null;
    if (this.heldLook) { this.heldLook.group.removeFromParent(); this.heldLook.dispose(); this.heldLook = null; this.heldDefId = null; }
    this.downMarker?.removeFromParent();
    this.downMarkerGeo?.dispose();
    this.downMarkerMat?.dispose();
    this.downMarker = null; this.downMarkerGeo = null; this.downMarkerMat = null;
    this.weaponSocket.removeFromParent();
    if (this.pool) this.pool.release(this.model);   // resets the body and detaches its root
    else this.model.dispose();                      // also detaches the root
  }
}

/** Facing (`atan2(normal.x, normal.z)` = looking along -normal) of the ladder a climbing body at `pos` hangs on, or null. */
function nearestLadderYaw(ctx: GameContext, pos: THREE.Vector3): number | null {
  const world = ctx.world;
  if (!world || typeof world.getLadders !== 'function') return null;
  let best: { normal: THREE.Vector3 } | null = null;
  let bestD = CLIMB_LADDER_MATCH_M * CLIMB_LADDER_MATCH_M;
  for (const l of world.getLadders()) {
    if (pos.y < l.base.y - CLIMB_LADDER_MATCH_M || pos.y > l.topY + CLIMB_LADDER_MATCH_M) continue;
    const dx = l.base.x - pos.x, dz = l.base.z - pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = l; }
  }
  return best ? Math.atan2(best.normal.x, best.normal.z) : null;
}

/** `ar` may be an ArmorDef id or the item def id that links to one (`ItemDef.armorId`). */
export function resolveArmorDef(ctx: GameContext, id: string): ArmorDef | null {
  const loot = ctx.loot;
  if (!loot) return null;
  const direct = loot.getArmorDef(id);
  if (direct) return direct;
  const link = loot.getItemDef(id)?.armorId;
  return link ? loot.getArmorDef(link) ?? null : null;
}
