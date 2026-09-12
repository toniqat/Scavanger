/**
 * src/player/parts/Boosts.ts — **전투 소모품의 시간제 효과** (2026-09-12, `docs/plans/consumables-keys-favorites.md` §1).
 *
 * `PlayerRef.applyBoost` / `boost` / `aimSwayMul` / `boostReloadSpeedMul` / `adsSpeedMul` / `staminaDrainMul` / `staminaCostMul`
 * 의 구현. 부르는 곳은 weapons 의 `parts/Healing.finishHeal`(홀드가 끝나 아이템이 소모된 뒤)뿐이다.
 *
 * | kind | 효과 | 시간 |
 * |---|---|---|
 * | `adrenaline` | 쓰는 순간 스태미나 전량 · 지친 상태 해제, 그동안 **지속 소모**(질주 · 사다리 빠르게 · 가방 부양) 0 | `BOOST_ADRENALINE_DURATION_S` |
 * | `stimulant` | 장전 × `_RELOAD_SPEED_MUL` · 정조준 전환 × `_ADS_SPEED_MUL` · 조준 흔들림 × `_AIM_SWAY_MUL` / 스태미나 소모(지속 · 한 번) × `_STAMINA_COST_MUL` | `BOOST_STIMULANT_DURATION_S` |
 *
 * **한 번에 하나다** — 새로 쓴 것이 앞의 것을 지운다 (같은 종류면 시간을 새로 잰다). 시간은 `ctx.time`(시뮬레이션)으로 잰다.
 * 버프 썸네일은 epoch ms(`buffNow`)로 그리므로 시작 · 끝 시각을 그 시계로도 찍고, 일시정지처럼 두 시계가 벌어지면
 * (`CLOCK_SLACK_MS` 넘게) 다시 찍는다 — 틱마다 다시 찍으면 목록 리비전이 매초 올라 와이어가 시끄러워진다.
 *
 * **지우는 곳**: `resetTactical`(스폰 · 구조선 부활 · 함선에서 서기 · `game:abort` → 새 미션도 `respawnAt` 을 탄다),
 * 사망, 함선 페이즈, 만료. 레이드 세션 세이브에는 싣지 않는다 (길어야 30 초라 재접속 복귀에서 사라져도 잃는 것이 작다).
 */
import {
  BOOST_ADRENALINE_DURATION_S, BOOST_STIMULANT_ADS_SPEED_MUL, BOOST_STIMULANT_AIM_SWAY_MUL, BOOST_STIMULANT_DURATION_S,
  BOOST_STIMULANT_RELOAD_SPEED_MUL, BOOST_STIMULANT_STAMINA_COST_MUL,
  type BoostKind,
} from '@/shared';
import { buffNow } from './Buffs';
import type { PlayerSystem } from '../PlayerSystem';

/** 시뮬레이션 시계와 버프 시계(epoch ms)가 이만큼 벌어지면 썸네일 시각을 다시 찍는다 (UI 동기 여유, 밸런스 아님). */
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
/** Continuous drains (sprint · fast ladder · hover): 0 under 아드레날린, the cost multiplier under 각성제. */
export const staminaDrainMul = (sys: PlayerSystem): number =>
  (sys.boostKind === 'adrenaline' ? 0 : isStim(sys) ? BOOST_STIMULANT_STAMINA_COST_MUL : 1);
/** One-off costs (jump · roll · melee · shield bash · big slash): only 각성제 changes them. */
export const staminaCostMul = (sys: PlayerSystem): number => (isStim(sys) ? BOOST_STIMULANT_STAMINA_COST_MUL : 1);
