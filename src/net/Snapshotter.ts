import type { GameContext, PlayerSnapshot } from '@/shared';
import type { ImplantId } from '@/shared';
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
  weaponSlot: 'primary' | 'secondary' | null = null;
  /* appended (tactical kit): set by implants / inventory so remotes can render gear. */
  /** Wielded implant id, or null. Set from `implant:wieldChanged`. */
  implantId: ImplantId | null = null;
  /** Equipped armor / backpack def ids. Set from `equip:changed`. */
  armorId: string | null = null;
  backpackId: string | null = null;

  private seq = 0;
  private readonly msg: PlayerSnapshot = {
    t: 'ps', seq: 0, time: 0, p: [0, 0, 0], v: [0, 0, 0], yaw: 0, pitch: 0,
    stance: 'stand', f: 0, hp: 0, w: null, stride: 0, move: 0,
    imp: null, ar: null, bp: null,
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
    m.bp = this.backpackId;

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
    /* appended: tactical kit */
    if (p.isRolling) f |= PlayerFlags.ROLL;
    if (p.isMeleeing) f |= PlayerFlags.MELEE;
    if (p.isCloaked) f |= PlayerFlags.CLOAKED;
    if (p.isDowned) f |= PlayerFlags.DOWNED;
    if (p.isHovering) f |= PlayerFlags.HOVER;
    if (p.isOvercharged) f |= PlayerFlags.OVERCHARGED;
    if (ctx.implants?.barrierActive) f |= PlayerFlags.BARRIER;
    if (m.w !== null) {
      f |= PlayerFlags.HAS_WEAPON;
      if (this.weaponSlot === 'primary') f |= PlayerFlags.TWO_HANDED;
    }
    m.f = f;
    return m;
  }
}
