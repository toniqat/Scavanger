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
  /* appended (2026-09-09): 채팅 입력 중 말풍선 — set from `ui:chatToggled`; remotes draw `…` over the head. */
  typing = false;

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
    /*
     * 격납고 (2026-09-08): which ship interior we are standing in. `null` on the shared deck (공유 함선 + 격납고),
     * the owner's PeerId inside a 개인 함선 — remote avatars whose `hs` differs from the receiver's are hidden, so
     * a member touring somebody's ship is only visible to the people in that ship.
     */
    const site = inHub ? (ctx.hub?.hubSite ?? null) : null;
    if (site !== null && site.length > 0) m.hs = site; else delete m.hs;
    // No weapons in the hub: never advertise one so remote avatars are drawn unarmed there.
    m.w = inHub ? null : this.weaponId;
    m.stride = round3(p.stridePhase ?? 0);
    m.move = round3(p.moveBlend ?? 0);
    m.imp = inHub ? null : this.implantId;
    m.ar = this.armorId;
    /* Phase 9: the down pool rides along while DOWNED so a host ghost inherits the real bleed state. */
    if (p.isDowned) m.dhp = Math.round(p.downHp ?? 0);
    else delete m.dhp;

    /*
     * Phase 10: a carrier has a downed squadmate on its shoulder and is therefore UNARMED — the no-gun path below is
     * forced so remote avatars pose two-handed-under-the-body instead of holding a rifle through the victim.
     * `carrying` is a plain string on `PlayerRef` (guarded: an older player impl may not have the member yet).
     */
    const carrying = typeof p.carrying === 'string' && p.carrying.length > 0 ? p.carrying : null;
    if (carrying !== null) m.cr = carrying;
    else delete m.cr;

    /* Phase 7: pose / held item / attachments from weapons' per-frame remote state (guarded: weapons may be absent). */
    const rs = ctx.weapons ? ctx.weapons.remoteState : undefined;
    const holding = this.holdingItem && !inHub && carrying === null;
    if (carrying !== null) m.w = null;
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
    /*
     * Phase 10: the 배리어 is a shield held in hand — `barrierActive` means "raised" and `bhp` rides along so remotes
     * tint the panel and a late joiner needs no `imp shield`. Omitted whenever the shield is down.
     */
    if (ctx.implants?.barrierActive) {
      f |= PlayerFlags.BARRIER;
      const bhp = ctx.implants.barrierHp;
      m.bhp = Number.isFinite(bhp) ? Math.round(bhp) : 0;
    } else delete m.bhp;
    /* appended: Phase 7 */
    if (p.isMeleeHeavy) f |= PlayerFlags.MELEE_HEAVY;
    /* appended (2026-09-09): chat input open → `…` speech bubble on remotes (valid in the hub too). */
    if (this.typing) f |= PlayerFlags.TYPING;
    if (rs && !inHub) {
      if (rs.throwing) f |= PlayerFlags.THROWING;
      if (rs.cooking) f |= PlayerFlags.COOKING;
      if (rs.charging) f |= PlayerFlags.CHARGING;
      if (rs.spraying) f |= PlayerFlags.SPRAYING;
      if (rs.heavy) f |= PlayerFlags.HEAVY;
    }
    /* appended: Phase 10 — 들쳐메기. CARRYING keeps the carrier unarmed; CARRIED marks the body on the shoulder. */
    if (carrying !== null) f |= PlayerFlags.CARRYING;
    if (p.isCarried === true) f |= PlayerFlags.CARRIED;
    // A carrier holds the squadmate with both hands, so it advertises neither HOLDING_ITEM nor HAS_WEAPON (`m.w`
    // was already nulled above) — remote avatars then pose unarmed instead of aiming a rifle through the victim.
    if (carrying === null) {
      if (holding) {
        // a consumable is in hand (Phase 2): no gun is advertised, remote avatars pose one-handed
        f |= PlayerFlags.HOLDING_ITEM;
        m.w = null;
      } else if (m.w !== null) {
        f |= PlayerFlags.HAS_WEAPON;
        if (this.weaponSlot === 'primary' || this.weaponSlot === 'primary2') f |= PlayerFlags.TWO_HANDED;
      }
    }
    m.f = f;
    return m;
  }
}
