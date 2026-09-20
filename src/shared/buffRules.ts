import * as THREE from 'three';
import type { BuffMessage, NetRef, PeerId } from './net';
import { NET_MAX_PLAYERS } from './net';
import type { WorldRef } from './types';
import {
  BUFF_HEAL_BURST_S, BUFF_HEAL_RATE_MARGIN, BUFF_RANGE_SLACK, GADGET_CLOAK_DURATION, GADGET_CLOAK_SHARE_RADIUS, GADGET_DEFIB_RANGE,
  HEAL_ALLY_RANGE_HOLD,
  IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC, IMPLANT_OVERCHARGE_DURATION, IMPLANT_OVERCHARGE_RANGE, IMPLANT_OVERCHARGE_SPEED_MUL,
} from './constants';
import { csvRows, numberList } from './data/tables';

/* ────────────────────────────────────────────────────────────────────────────
 * 받는 쪽 버프 상한 (2026-09-11, E-4 — 커밋 `9bd72ce`(계약) · `b3fc2f0`(구현) (a)(b)).
 *
 * `buff` (heal · boost · revive · cloak) goes peer → peer with no host in between. The receiver is the only place that
 * can refuse a forged one, and two folders receive them (implants: heal · boost, gadgets: revive · cloak), so the rules
 * live here. Each receiving folder keeps **one `BuffGuard`** for the local player and asks it before applying.
 *
 * Checks, in order: the sender is a connected member of my lobby · the sender's last snapshot position is within the
 * buff's range + `BUFF_RANGE_SLACK` · `amount` / `duration` are clamped to what the real effect can produce · `heal`
 * passes a per-receiver token bucket (sum of every sender) sized from the real heal rates × a margin.
 * No receiver-side line-of-sight test (snapshot lag would bounce legitimate heals at door frames) — the wall case is
 * fixed on the **sender** (`buffLineClear`: `world.raycast` chest → chest before sending).
 *
 * Owner: shared/ (contract) — the body is implemented by the E-4 agent (⑤). Pure except the guard's own bucket state.
 *
 * Limits (all from `data/`, nothing hard-coded):
 *   heal    range = max(스프레이 반경, IMPLANT_OVERCHARGE_RANGE) — the wire does not say which one sent it.
 *           rate  = (가장 센 스프레이 초당 치유 + IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC) × BUFF_HEAL_RATE_MARGIN **per sender**
 *                   (when `BuffSender.id` is given) and × (NET_MAX_PLAYERS − 1) for the sum of every sender;
 *                   bucket size = rate × BUFF_HEAL_BURST_S. An over-budget heal is trimmed to what is left.
 *   boost   range = IMPLANT_OVERCHARGE_RANGE · amount ∈ [1, IMPLANT_OVERCHARGE_SPEED_MUL] (a "boost ×0.01" can not
 *           freeze a squad-mate) · duration ≤ IMPLANT_OVERCHARGE_DURATION (0 = the receiver's default).
 *   revive  range = GADGET_DEFIB_RANGE · amount is ignored by the receiver (full hp) · "actually downed" stays the
 *           receiver's own check.
 *   cloak   range = GADGET_CLOAK_SHARE_RADIUS · 0 < duration ≤ GADGET_CLOAK_DURATION.
 *   shield  (appended 2026-09-21, 실드 충전기를 아군에게) range = HEAL_ALLY_RANGE_HOLD — the right-click ally use is the
 *           only sender, and it is the *hold* range because that is the last distance the sender could legally be at.
 *           amount ≤ the biggest `items.csv` `shieldHp`, or exactly **-1** = fill up (`shield_charger_full`), which
 *           costs the same budget as the biggest one. Own token bucket, sized from the fastest charger
 *           (biggest `shieldHp` / shortest `shieldUseTime`) — it must not eat the heal budget, since a squad-mate
 *           may reasonably be healed and charged at the same time.
 * ──────────────────────────────────────────────────────────────────────────── */

export type BuffKind = BuffMessage['kind'];

/** What the receiver knows about the sender at the moment the buff arrives. */
export interface BuffSender {
  /** Sender is a connected member of my lobby (not merely any relay peer). */
  inSquad: boolean;
  /** Distance (m) from the sender's last snapshot position to me; null = no snapshot yet. */
  distance: number | null;
  /**
   * appended (2026-09-11, E-4 ⑤): the sender's PeerId. When present `heal` also passes a **per-sender** bucket, so one
   * forger cannot use the whole squad's budget. Absent = the sum bucket only.
   */
  id?: PeerId;
}

export interface BuffVerdict {
  ok: boolean;
  /** Clamped amount to apply (only meaningful when `ok`). */
  amount: number;
  /** Clamped duration to apply (only meaningful when `ok`). */
  duration: number;
  /** Why it was refused (debug / smoke only — never shown to the player). */
  reason?: 'not_squad' | 'range' | 'rate' | 'invalid';
}

export interface BuffGuard {
  /** `nowS` = a monotonic clock in seconds (e.g. `performance.now() / 1000`). */
  check(msg: BuffMessage, sender: BuffSender, nowS: number): BuffVerdict;
  /** Forget bucket state (mission reset). */
  reset(): void;
}

/* ── limits, derived once from data/ (lazily: the csv registry must be loaded first) ── */
interface BuffLimits {
  healRange: number;
  /** hp/s one sender may pour in (before the margin). */
  healPerSender: number;
  /** appended (2026-09-21): the biggest single 실드 충전기 charge in `items.csv` (a -1 row counts as this much). */
  shieldMax: number;
  /** appended (2026-09-21): shield points/s one sender may pour in (the fastest charger), before the margin. */
  shieldPerSender: number;
}
let LIMITS: BuffLimits | null = null;
function limits(): BuffLimits {
  if (LIMITS) return LIMITS;
  // the strongest 회복 스프레이 in items.csv (sprayHeal per sprayTick) and its radius — the same rows items/ reads
  let sprayRate = 0, sprayRadius = 0;
  for (const r of csvRows('items.csv')) {
    const tick = r.num('sprayTick', { fallback: 0 });
    const heal = r.num('sprayHeal', { fallback: 0 });
    if (!(tick > 0) || !(heal > 0)) continue;
    sprayRate = Math.max(sprayRate, heal / tick);
    const rad = r.num('sprayRadius', { fallback: 0 });
    if (rad > 0) sprayRadius = Math.max(sprayRadius, rad);
  }
  /* appended (2026-09-21): the 실드 충전기 rows of the same file — `shieldHp` with `shieldUseTime` beside it.
   * A `shieldHp` of -1 means 「fill it up」, which is worth the biggest armour pool there is
   * (`ARMOR_SHIELD_BY_TIER` in tables.csv), so the budget it costs is that, not 0. */
  const tierShield = numberList('tables.csv', 'ARMOR_SHIELD_BY_TIER');
  const fullCharge = tierShield.length > 0 ? Math.max(...tierShield) : 0;
  let shieldMax = 0, shieldRate = 0;
  for (const r of csvRows('items.csv')) {
    const hp = r.num('shieldHp', { fallback: 0 });
    if (hp === 0) continue;
    const give = hp < 0 ? fullCharge : hp;
    shieldMax = Math.max(shieldMax, give);
    const use = r.num('shieldUseTime', { fallback: 0 });
    if (use > 0) shieldRate = Math.max(shieldRate, give / use);
  }
  LIMITS = {
    healRange: Math.max(sprayRadius, IMPLANT_OVERCHARGE_RANGE),
    healPerSender: sprayRate + IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC,
    shieldMax,
    shieldPerSender: shieldRate,
  };
  return LIMITS;
}

/** Range (m, before `BUFF_RANGE_SLACK`) a buff kind can really be sent from. */
export function buffRangeOf(kind: BuffKind): number {
  switch (kind) {
    case 'heal': return limits().healRange;
    case 'boost': return IMPLANT_OVERCHARGE_RANGE;
    case 'revive': return GADGET_DEFIB_RANGE;
    case 'cloak': return GADGET_CLOAK_SHARE_RADIUS;
    // appended (2026-09-21): the ally use's *hold* range — the furthest the sender could legally still have been.
    case 'shield': return HEAL_ALLY_RANGE_HOLD;
    default: return 0;
  }
}

/** Heal budget in hp/s: `perSender` for one squad-mate, `total` for every sender together (both include the margin). */
export function buffHealRate(): { perSender: number; total: number } {
  const per = limits().healPerSender * BUFF_HEAL_RATE_MARGIN;
  return { perSender: per, total: per * Math.max(1, NET_MAX_PLAYERS - 1) };
}

/** appended (2026-09-21): the same for 실드 충전기 points/s — its own budget, separate from the heal one. */
export function buffShieldRate(): { perSender: number; total: number } {
  const per = limits().shieldPerSender * BUFF_HEAL_RATE_MARGIN;
  return { perSender: per, total: per * Math.max(1, NET_MAX_PLAYERS - 1) };
}

interface Bucket { tokens: number; at: number }

function refill(b: Bucket, rate: number, cap: number, nowS: number): void {
  const dt = Math.max(0, nowS - b.at);
  b.tokens = Math.min(cap, b.tokens + dt * rate);
  b.at = nowS;
}

export function createBuffGuard(): BuffGuard {
  let total: Bucket | null = null;
  const perSender = new Map<string, Bucket>();
  /* appended (2026-09-21): the 실드 충전기 budget is a second pair of buckets of exactly the same shape — a squad-mate
   * may be healed and charged at the same moment, so the two must not share tokens. */
  let totalShield: Bucket | null = null;
  const perSenderShield = new Map<string, Bucket>();
  const refuse = (reason: BuffVerdict['reason']): BuffVerdict => ({ ok: false, amount: 0, duration: 0, reason });

  return {
    check(msg: BuffMessage, sender: BuffSender, nowS: number): BuffVerdict {
      if (!msg || typeof msg !== 'object') return refuse('invalid');
      const kind = msg.kind;
      if (kind !== 'heal' && kind !== 'boost' && kind !== 'revive' && kind !== 'cloak' && kind !== 'shield') return refuse('invalid');
      if (!sender.inSquad) return refuse('not_squad');
      if (sender.distance === null || !Number.isFinite(sender.distance)) return refuse('range');
      if (sender.distance > buffRangeOf(kind) + BUFF_RANGE_SLACK) return refuse('range');
      const amount = Number.isFinite(msg.amount) ? msg.amount : 0;
      const duration = Number.isFinite(msg.duration) ? Math.max(0, msg.duration) : 0;
      const now = Number.isFinite(nowS) ? nowS : 0;

      switch (kind) {
        case 'heal': {
          if (!(amount > 0)) return refuse('invalid');
          const rate = buffHealRate();
          const capT = rate.total * BUFF_HEAL_BURST_S;
          const capS = rate.perSender * BUFF_HEAL_BURST_S;
          if (!total) total = { tokens: capT, at: now };
          refill(total, rate.total, capT, now);
          let own: Bucket | null = null;
          if (sender.id) {
            own = perSender.get(sender.id) ?? null;
            if (!own) { own = { tokens: capS, at: now }; perSender.set(sender.id, own); }
            refill(own, rate.perSender, capS, now);
          }
          const left = Math.min(total.tokens, own ? own.tokens : Infinity);
          const give = Math.min(amount, left);
          if (!(give >= 0.1)) return refuse('rate');
          total.tokens -= give;
          if (own) own.tokens -= give;
          return { ok: true, amount: give, duration: 0 };
        }
        case 'boost': {
          const mul = amount > 0 ? Math.min(IMPLANT_OVERCHARGE_SPEED_MUL, Math.max(1, amount)) : IMPLANT_OVERCHARGE_SPEED_MUL;
          return { ok: true, amount: mul, duration: Math.min(IMPLANT_OVERCHARGE_DURATION, duration) };
        }
        case 'revive':
          return { ok: true, amount: Math.max(0, amount), duration: 0 };
        case 'cloak': {
          if (!(duration > 0)) return refuse('invalid');
          return { ok: true, amount: 0, duration: Math.min(GADGET_CLOAK_DURATION, duration) };
        }
        /* appended (2026-09-21, 실드 충전기를 아군에게): the same token-bucket shape as `heal`, on its own pair of
         * buckets. `amount` -1 stays -1 through the verdict (the receiver fills to its own max) and costs the
         * biggest single charge there is, so 「fill up」 cannot be spammed more cheaply than the strongest cartridge. */
        case 'shield': {
          const full = amount === -1;
          if (!full && !(amount > 0)) return refuse('invalid');
          const want = full ? limits().shieldMax : Math.min(amount, limits().shieldMax);
          if (!(want > 0)) return refuse('invalid');
          const rate = buffShieldRate();
          const capT = rate.total * BUFF_HEAL_BURST_S;
          const capS = rate.perSender * BUFF_HEAL_BURST_S;
          if (!totalShield) totalShield = { tokens: capT, at: now };
          refill(totalShield, rate.total, capT, now);
          let own: Bucket | null = null;
          if (sender.id) {
            own = perSenderShield.get(sender.id) ?? null;
            if (!own) { own = { tokens: capS, at: now }; perSenderShield.set(sender.id, own); }
            refill(own, rate.perSender, capS, now);
          }
          const left = Math.min(totalShield.tokens, own ? own.tokens : Infinity);
          // 「Fill up」 is all-or-nothing — a trimmed full charge would silently become a small one.
          if (full ? left < want : !(Math.min(want, left) >= 1)) return refuse('rate');
          const give = full ? want : Math.min(want, left);
          totalShield.tokens -= give;
          if (own) own.tokens -= give;
          return { ok: true, amount: full ? -1 : give, duration: 0 };
        }
      }
      return refuse('invalid');
    },
    reset(): void { total = null; perSender.clear(); totalShield = null; perSenderShield.clear(); },
  };
}

/**
 * What a receiver knows about `from` right now: lobby membership (connected, not me) and the distance from the sender's
 * interpolated snapshot position to `me` (null without a live ref). Feed the result to `BuffGuard.check`.
 */
export function buffSenderOf(net: NetRef | null | undefined, from: PeerId, me: THREE.Vector3): BuffSender {
  if (!net || typeof from !== 'string' || from === net.localId) return { inSquad: false, distance: null, id: from };
  const member = net.lobby?.players.find((p) => p.id === from);
  const inSquad = !!member && member.connected !== false;
  const ref = net.getRemotePlayer(from);
  const distance = ref && ref.connected !== false ? ref.position.distanceTo(me) : null;
  return { inSquad, distance, id: from };
}

/**
 * Sender side: is the straight line between two chests free of world geometry (`WorldRef.raycast` — terrain, walls,
 * props, dropped cover)? `sprayAllies` and the overcharge beam call it before a `buff` goes out, so a squad-mate behind a
 * wall is never healed. Without a ready world (hub / tests) it answers true — nothing to block with.
 */
const _dir = new THREE.Vector3();
export function buffLineClear(world: WorldRef | null | undefined, from: THREE.Vector3, to: THREE.Vector3): boolean {
  if (!world || !world.ready || typeof world.raycast !== 'function') return true;
  _dir.subVectors(to, from);
  const d = _dir.length();
  if (d < 0.3) return true;
  _dir.multiplyScalar(1 / d);
  const hit = world.raycast(from, _dir, d);
  return !hit || hit.distance >= d - 0.3;
}
