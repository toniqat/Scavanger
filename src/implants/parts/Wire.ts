/**
 * src/implants/parts/Wire.ts — the **implants' network path** (`imp` / `buff`).
 *
 * Tells the squad about the shield state · the 오버차지 beam · a 실드 배쉬 · a 정찰 scan, and applies what
 * someone else sent into our world. 정찰 sends only **the fact that it was cast** (`imp scanCast`), not the
 * result, and each peer reveals it from its own world.
 */
import {
  IMPLANT_OVERCHARGE_SPEED_MUL,
  buffSenderOf,
  type BuffMessage, type ImplantMessage, type PeerId, type PlayerRef, type RelayTarget,
} from '@/shared';
import { BOOST_LINGER, BOOST_SEND_INTERVAL, _bp, _d, _from, _hitPt, _hp, _muzzle, _n, _o, _p, _r, _t, _tmp } from '../model';
import type { ImplantSystem } from '../ImplantSystem';

/* ═══════════════════════════ networking ═══════════════════════════ */
export function ensureNetHooks(sys: ImplantSystem): void {
  const net = sys.ctx?.net;
  if (!net || sys.netHooked) return;
  sys.netHooked = true;
  sys.unsubs.push(
    net.onMessage('imp', (m, from) => sys.onImplantMessage(m, from)),
    net.onMessage('buff', (m, from) => sys.onBuff(m, from)),
    // Phase 9 / 10: a late joiner learns our shield is raised (the snapshot only carries the BARRIER flag + bhp)
    net.onMessage('flow', (m, from) => {
      if (m.ev === 'rejoined' && sys.barrier?.active && from !== net.localId) sys.sendShield(true, from);
    }),
  );
  }

export function send(sys: ImplantSystem, msg: ImplantMessage, to: RelayTarget = 'others'): void {
  const ctx = sys.ctx;
  if (!ctx?.isMultiplayer || !ctx.net) return;
  ctx.net.send(msg, to);
  }

export function sendBuff(sys: ImplantSystem, msg: BuffMessage, to: PeerId): void {
  const ctx = sys.ctx;
  if (!ctx?.isMultiplayer || !ctx.net) return;
  ctx.net.send(msg, to);
  }

export function onImplantMessage(sys: ImplantSystem, m: ImplantMessage, from: PeerId): void {
  if (from === sys.ctx.net?.localId) return;
  sys.remote.handle(m, from);
  }

/**
 * Friendly effects aimed at *us* by someone else. Each `buff` kind has exactly one receiver: implants/ applies
 * the overcharge `heal` / `boost` and (2026-09-21) the `shield` a squadmate's 실드 충전기 sends; `revive`
 * (defibrillator) and `cloak` belong to gadgets/ (Phase 9: the duplicate `revive` branch here is gone).
 *
 * 2026-09-11 (E-4): a `buff` travels peer → peer with no host in between, so the receiver is the only place that can
 * refuse a forged one. `sys.buffGuard` (`shared/buffRules`) checks that the sender is a connected lobby member within
 * the buff's range of its snapshot, trims `heal` to the real heal budget and clamps the `boost` multiplier / duration.
 * The dead / downed test runs first so a refused heal never spends budget.
 */
export function onBuff(sys: ImplantSystem, m: BuffMessage, from: PeerId): void {
  const p = sys.ctx.player;
  if (!p || !m) return;
  /* 2026-09-21 (실드 충전기를 아군에게): `shield` joins this folder's kinds — the one-owner-per-kind rule puts it
   * next to `heal` / `boost`, not in gadgets. It is refused while downed or dead for the same reason `heal` is:
   * a body on the ground is the defibrillator's business, and filling its shield would hide that. */
  if (m.kind !== 'heal' && m.kind !== 'boost' && m.kind !== 'shield') return;
  if (m.kind !== 'boost' && (p.isDead || p.isDowned)) return;
  const v = sys.buffGuard.check(m, buffSenderOf(sys.ctx.net, from, p.position), performance.now() / 1000);
  sys.lastBuffVerdict = v;
  if (!v.ok) return;
  if (m.kind === 'heal') p.heal(v.amount);
  // `amount` −1 came through the guard untouched and means 「fill it up」; `chargeShield`'s own word for that is
  // `Infinity`. It refuses (false) with no armour or a full pool and spends nothing — the sender already paid.
  else if (m.kind === 'shield') p.chargeShield?.(v.amount === -1 ? Infinity : v.amount);
  else sys.applyBoost(p, v.amount > 0 ? v.amount : IMPLANT_OVERCHARGE_SPEED_MUL, v.duration || BOOST_SEND_INTERVAL + BOOST_LINGER);
  }

/**
 * Overcharge buff on a player: the `'overcharge'` speed modifier **and** `setOvercharged` for the same `duration`
 * (2026-09-11 C-3 — player/ used to infer `isOvercharged` from the modifier key; weapons reads it for the fire-rate
 * bonus, the snapshot for `PlayerFlags.OVERCHARGED`). `setOvercharged` is an optional contract member, so it is probed.
 */
export function applyBoost(sys: ImplantSystem, p: PlayerRef, mul: number, duration: number): void {
  p.setSpeedModifier('overcharge', mul, duration);
  p.setOvercharged?.(duration);
  }
