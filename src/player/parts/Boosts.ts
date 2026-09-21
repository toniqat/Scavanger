/**
 * src/player/parts/Boosts.ts — **the timed effects of combat consumables**
 * (2026-09-12).
 *
 * `PlayerRef.applyBoost` / `boost` / `aimSwayMul` / `boostReloadSpeedMul` / `adsSpeedMul` / `staminaDrainMul` / `staminaCostMul`
 * are implemented here. The only caller is weapons' `parts/Healing.finishHeal` (after the hold ends and the item
 * is consumed).
 *
 * | kind | effect | duration |
 * |---|---|---|
 * | `adrenaline` | full stamina · exhaustion cleared; **continuous drains** 0 | `BOOST_ADRENALINE_DURATION_S` |
 * | `stimulant` | reload × `_RELOAD_SPEED_MUL` · ADS × `_ADS_SPEED_MUL` · aim sway × `_AIM_SWAY_MUL` / stamina cost × `_STAMINA_COST_MUL` | `BOOST_STIMULANT_DURATION_S` |
 *
 * **One at a time** — a new one clears the previous (the same kind restarts its clock). The duration is measured on
 * `ctx.time` (simulation). The buff thumbnail draws on epoch ms (`buffNow`), so the start · end are stamped on that
 * clock as well, and re-stamped when the two clocks drift apart (by more than `CLOCK_SLACK_MS`), as a pause makes
 * them — re-stamping every tick would raise the list revision every second and make the wire noisy.
 *
 * **Where it is cleared**: `resetTactical` (spawn · rescue revive · standing up in the ship · `game:abort` — a new
 * mission rides `respawnAt` too), death, the ship phase, expiry. It is not carried in the raid session save (30 s at
 * the most, so losing it across a rejoin costs little).
 */
import {
  BOOST_ADRENALINE_DURATION_S, BOOST_STIMULANT_ADS_SPEED_MUL, BOOST_STIMULANT_AIM_SWAY_MUL, BOOST_STIMULANT_DURATION_S,
  BOOST_STIMULANT_RELOAD_SPEED_MUL, BOOST_STIMULANT_STAMINA_COST_MUL,
  type BoostKind,
} from '@/shared';
import { buffNow } from './Buffs';
import type { PlayerSystem } from '../PlayerSystem';

/**
 * When the simulation clock and the buff clock (epoch ms) drift this far apart, the thumbnail times are re-stamped
 * (a UI sync slack, not a balance number).
 */
const CLOCK_SLACK_MS = 1500;

/** Start (or restart) `kind` for its csv duration. Clears the other kind. Ignored while dead / not spawned. */
export function applyBoost(sys: PlayerSystem, kind: BoostKind, defId?: string): void {
  const ctx = sys.ctx;
  if (!ctx || !sys.spawned || sys.isDead) return;
  if (kind !== 'adrenaline' && kind !== 'stimulant') return;
  const duration = kind === 'adrenaline' ? BOOST_ADRENALINE_DURATION_S : BOOST_STIMULANT_DURATION_S;
  sys.boostKind = kind;
  sys.boostDefId = typeof defId === 'string' && defId ? defId : null;
  sys.boostDuration = Math.max(0, duration);
  sys.boostUntil = ctx.time + sys.boostDuration;
  const now = buffNow(ctx);
  sys.boostStartedAt = now;
  sys.boostEndsAt = now + sys.boostDuration * 1000;
  if (kind === 'adrenaline') {
    sys.stamina = sys.maxStamina; sys.regenDelay = 0; sys.exhausted = false; sys.exhaustedSlow = 0;
  }
  sys.buffsDirty = true;
  ctx.bus.emit('audio:play', { id: 'stim', volume: 0.8 });
}

/** Drop the running boost (no-op without one). */
export function clearBoost(sys: PlayerSystem): void {
  if (sys.boostKind === null) return;
  sys.boostKind = null; sys.boostDefId = null;
  sys.boostDuration = 0; sys.boostUntil = 0; sys.boostStartedAt = 0; sys.boostEndsAt = 0;
  sys.buffsDirty = true;
}

/** Per frame (before stamina): expiry · death · ship, and re-stamping the buff clock after a pause. */
export function updateBoost(sys: PlayerSystem): void {
  if (sys.boostKind === null) return;
  const ctx = sys.ctx;
  if (sys.isDead || ctx.isHubPhase() || ctx.time >= sys.boostUntil) { clearBoost(sys); return; }
  const expect = buffNow(ctx) + (sys.boostUntil - ctx.time) * 1000;
  if (Math.abs(expect - sys.boostEndsAt) > CLOCK_SLACK_MS) {
    sys.boostEndsAt = expect;
    sys.boostStartedAt = expect - sys.boostDuration * 1000;
    sys.buffsDirty = true;
  }
}

/** `PlayerRef.boost` — a reused object, null without a boost. */
export function boostState(sys: PlayerSystem): { kind: BoostKind; remaining: number; duration: number; defId: string | null } | null {
  if (sys.boostKind === null || !sys.ctx) return null;
  const v = sys.boostView;
  v.kind = sys.boostKind;
  v.remaining = Math.max(0, sys.boostUntil - sys.ctx.time);
  v.duration = sys.boostDuration;
  v.defId = sys.boostDefId;
  return v;
}

const isStim = (sys: PlayerSystem): boolean => sys.boostKind === 'stimulant';

export const aimSwayMul = (sys: PlayerSystem): number => (isStim(sys) ? BOOST_STIMULANT_AIM_SWAY_MUL : 1);
export const reloadSpeedMul = (sys: PlayerSystem): number => (isStim(sys) ? BOOST_STIMULANT_RELOAD_SPEED_MUL : 1);
export const adsSpeedMul = (sys: PlayerSystem): number => (isStim(sys) ? BOOST_STIMULANT_ADS_SPEED_MUL : 1);
/** Continuous drains (sprint · fast ladder · hover): 0 under adrenaline, the cost multiplier under the stimulant. */
export const staminaDrainMul = (sys: PlayerSystem): number =>
  (sys.boostKind === 'adrenaline' ? 0 : isStim(sys) ? BOOST_STIMULANT_STAMINA_COST_MUL : 1);
/** One-off costs (jump · roll · melee · shield bash · big slash): only the stimulant changes them. */
export const staminaCostMul = (sys: PlayerSystem): number => (isStim(sys) ? BOOST_STIMULANT_STAMINA_COST_MUL : 1);
