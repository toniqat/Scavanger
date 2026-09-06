import type { GameContext, ImplantId, PlayerSnapshot, WeaponSlot } from '@/shared';
import { PlayerFlags } from '@/shared';

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/**
 * Builds the local PlayerSnapshot from ctx.player. One reusable message object (tuples included) — the caller
 * JSON-encodes it synchronously, so no per-snapshot allocation happens.
 * Also used in the shared-ship hub (phase 'hub'): `IN_HUB` marks those snapshots, `IN_POD` a boarded launch pod.
 */
export class Snapshotter {
  /** Active weapon def id, cached from `weapon:equipped` (null = none). */
  weaponId: string | null = null;
  /** Slot of the active weapon; 'primary' → TWO_HANDED. */
  weaponSlot: WeaponSlot | null = null;
  /** A stim / grenade is in hand instead of a gun (from `quick:equipped`). */
  holdingItem = false;
  /* appended (tactical kit): set by implants / inventory so remotes can render gear. */
  /** Wielded implant id, or null. Set from `implant:wieldChanged`. */
  implantId: ImplantId | null = null;
  /** Equipped armor def id. Set from `equip:changed`. */
  armorId: string | null = null;

  private seq = 0;
  private readonly msg: PlayerSnapshot = {
    t: 'ps', seq: 0, time: 0, p: [0, 0, 0], v: [0, 0, 0], yaw: 0, pitch: 0,
    stance: 'stand', f: 0, hp: 0, w: null, stride: 0, move: 0,
    imp: null, ar: null, h: null,
  };

  reset(): void { this.seq = 0; }

  /** Returns null when there is no player to sample. */
  build(ctx: GameContext): PlayerSnapshot | null {
    const p = ctx.player;
    if (!p) return null;
    const m = this.msg;
    m.seq = ++this.seq;
    m.time = round3(ctx.time);
    m.p[0] = round3(p.position.x); m.p[1] = round3(p.position.y); m.p[2] = round3(p.position.z);
    m.v[0] = round3(p.velocity.x); m.v[1] = round3(p.velocity.y); m.v[2] = round3(p.velocity.z);
    m.yaw = round3(p.yaw);
    m.pitch = round3(p.pitch ?? 0);
    m.stance = p.stance ?? 'stand';
    m.hp = Math.round(p.hp);
    const inHub = ctx.isHubPhase();
    // No weapons in the hub: never advertise one so remote avatars are drawn unarmed there.
    m.w = inHub ? null : this.weaponId;
    m.stride = round3(p.stridePhase ?? 0);
    m.move = round3(p.moveBlend ?? 0);
    m.imp = inHub ? null : this.implantId;
    m.ar = this.armorId;
    /* Phase 9: the down pool rides along while DOWNED so a host ghost inherits the real bleed state. */
    if (p.isDowned) m.dhp = Math.round(p.downHp ?? 0);
    else delete m.dhp;

    /* Phase 7: pose / held item / attachments from weapons' per-frame remote state (guarded: weapons may be absent). */
    const rs = ctx.weapons ? ctx.weapons.remoteState : undefined;
    const holding = this.holdingItem && !inHub;
    m.h = holding && rs ? rs.heldItemId : null;
    if (!inHub && rs && rs.attachments && rs.attachments.length > 0 && m.w !== null) m.att = rs.attachments as string[];
    else delete m.att;

    let f = 0;
    if (p.isSprinting) f |= PlayerFlags.SPRINT;
    if (p.isAiming) f |= PlayerFlags.AIM;
    if (p.isDiving) f |= PlayerFlags.DIVE;
    if (p.isGrounded === false) f |= PlayerFlags.AIRBORNE;
    if (p.isDead) f |= PlayerFlags.DEAD;
    if (p.isReloading) f |= PlayerFlags.RELOADING;
    if (p.isFiring) f |= PlayerFlags.FIRING;
    if (p.isDropping) f |= PlayerFlags.DROPPING;
    if (p.isInShip) f |= PlayerFlags.IN_SHIP;
    if (inHub) f |= PlayerFlags.IN_HUB;
    if (p.isInPod) f |= PlayerFlags.IN_POD;
    if (p.isDowned) f |= PlayerFlags.DOWNED;
    /* appended: tactical kit (the roll rides on the DIVE bit via `isDiving`) */
    if (p.isMeleeing) f |= PlayerFlags.MELEE;
    if (p.isCloaked) f |= PlayerFlags.CLOAKED;
    if (p.isHovering) f |= PlayerFlags.HOVER;
    if (p.isOvercharged) f |= PlayerFlags.OVERCHARGED;
    if (ctx.implants?.barrierActive) f |= PlayerFlags.BARRIER;
    /* appended: Phase 7 */
    if (p.isMeleeHeavy) f |= PlayerFlags.MELEE_HEAVY;
    if (rs && !inHub) {
      if (rs.throwing) f |= PlayerFlags.THROWING;
      if (rs.cooking) f |= PlayerFlags.COOKING;
      if (rs.charging) f |= PlayerFlags.CHARGING;
      if (rs.spraying) f |= PlayerFlags.SPRAYING;
      if (rs.heavy) f |= PlayerFlags.HEAVY;
    }
    if (holding) {
      // a consumable is in hand (Phase 2): no gun is advertised, remote avatars pose one-handed
      f |= PlayerFlags.HOLDING_ITEM;
      m.w = null;
    } else if (m.w !== null) {
      f |= PlayerFlags.HAS_WEAPON;
      if (this.weaponSlot === 'primary' || this.weaponSlot === 'primary2') f |= PlayerFlags.TWO_HANDED;
    }
    m.f = f;
    return m;
  }
}
