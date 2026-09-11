import type { BuffMessage } from './net';

/* ────────────────────────────────────────────────────────────────────────────
 * 받는 쪽 버프 상한 (2026-09-11, E-4 — docs/plans/net-social-trust.md §5 (a)(b)).
 *
 * `buff` (heal · boost · revive · cloak) goes peer → peer with no host in between. The receiver is the only place that
 * can refuse a forged one, and two folders receive them (implants: heal · boost, gadgets: revive · cloak), so the rules
 * live here. Each receiving folder keeps **one `BuffGuard`** for the local player and asks it before applying.
 *
 * Checks, in order: the sender is a connected member of my lobby · the sender's last snapshot position is within the
 * buff's range + `BUFF_RANGE_SLACK` · `amount` / `duration` are clamped to what the real effect can produce · `heal`
 * passes a per-receiver token bucket (sum of every sender) sized from the real heal rates × a margin.
 * No receiver-side line-of-sight test (snapshot lag would bounce legitimate heals at door frames) — the wall case is
 * fixed on the **sender** (`world.raycast` chest → chest before sending).
 *
 * Owner: shared/ (contract) — the body is implemented by the E-4 agent (⑤). Pure except the guard's own bucket state.
 * ──────────────────────────────────────────────────────────────────────────── */

export type BuffKind = BuffMessage['kind'];

/** What the receiver knows about the sender at the moment the buff arrives. */
export interface BuffSender {
  /** Sender is a connected member of my lobby (not merely any relay peer). */
  inSquad: boolean;
  /** Distance (m) from the sender's last snapshot position to me; null = no snapshot yet. */
  distance: number | null;
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

/**
 * Contract placeholder: accepts everything unchanged (today's behaviour) until ⑤ fills in the limits from
 * `data/constants.csv` (`BUFF_RANGE_SLACK`, `BUFF_HEAL_RATE_MARGIN`, the overcharge / spray / defib / cloak numbers).
 */
export function createBuffGuard(): BuffGuard {
  return {
    check(msg: BuffMessage): BuffVerdict {
      const amount = Number.isFinite(msg.amount) ? msg.amount : 0;
      const duration = Number.isFinite(msg.duration) ? msg.duration : 0;
      return { ok: true, amount, duration };
    },
    reset(): void { /* no state yet */ },
  };
}
