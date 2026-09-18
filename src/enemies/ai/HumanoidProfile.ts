import type { EnemyFaction } from '@/shared';
import type { Enemy } from '../Enemy';
import { HUMANOID_ANDROID, HUMANOID_RAIDER, HUMANOID_ROGUE, type HumanoidProfile } from '../EnemyTypes';

/* ────────────────────────────────────────────────────────────────────────────
 * 2026-09-13: humanoid faction AI profiles per planet — android · rogue · raider.
 *
 * All three factions run the same rogue state machine (`ai/RogueAI`) and read only their **firing · grenade · cover rhythm** here.
 * The numbers themselves come from the `HUMANOID_*` blocks of `data/enemy_abilities.csv` (there is no number in this file).
 *
 * - Aim error is a **distance curve**: `aimNear` inside `aimNearDist`, `aimFar` beyond `aimFarDist`, smoothstep in between.
 *   A rogue is dangerous up close and barely hits anything far away (0.055 → 0.15 rad); a raider's curve is nearly flat even at range.
 *   Standing and firing for `ROGUE_AI.settleTime` shrinks it by up to `settleMul` (where the old `ROGUE_AIM_ERROR → _SETTLED` sat).
 * - Named rogues (`ai/named/*`) do not use this curve — they hand their own error and damage straight to `fireGun`.
 * - A bug faction never gets here (only humanoids call it), but it is given the rogue table to be safe.
 * ──────────────────────────────────────────────────────────────────────────── */

export type { HumanoidProfile } from '../EnemyTypes';
export const ANDROID_PROFILE = HUMANOID_ANDROID;
export const ROGUE_PROFILE = HUMANOID_ROGUE;
export const RAIDER_PROFILE = HUMANOID_RAIDER;

const BY_FACTION: Readonly<Record<EnemyFaction, HumanoidProfile>> = {
  bug: HUMANOID_ROGUE,
  rogue: HUMANOID_ROGUE,
  android: HUMANOID_ANDROID,
  raider: HUMANOID_RAIDER,
};

/** `e`'s faction profile. */
export function humanoidProfile(e: Enemy): HumanoidProfile {
  return BY_FACTION[e.faction] ?? HUMANOID_ROGUE;
}

/** Profile by faction name (smokes · debug). */
export function profileOfFaction(f: EnemyFaction): HumanoidProfile {
  return BY_FACTION[f] ?? HUMANOID_ROGUE;
}

/**
 * Aim error (rad) at distance `dist` (m). `settle01` = 0 is the first shot right after stepping out, 1 means it stood the whole `settleTime`.
 * `parts/Attacks.fireGun` uses this as the half-width of a triangular distribution (× 1 sideways, × 0.7 vertically).
 */
export function humanoidAimError(p: HumanoidProfile, dist: number, settle01: number): number {
  const span = p.aimFarDist - p.aimNearDist;
  let k = span > 1e-3 ? (dist - p.aimNearDist) / span : dist >= p.aimFarDist ? 1 : 0;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  k = k * k * (3 - 2 * k);
  const base = p.aimNear + (p.aimFar - p.aimNear) * k;
  const s = settle01 < 0 ? 0 : settle01 > 1 ? 1 : settle01;
  return base * (1 + (p.settleMul - 1) * s);
}

/** Rounds in one burst (`burstMin … burstMax`, an integer). */
export function rollBurst(p: HumanoidProfile): number {
  const lo = Math.max(1, Math.round(p.burstMin));
  const hi = Math.max(lo, Math.round(p.burstMax));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** The pause between bursts (±30 %). */
export function rollBurstPause(p: HumanoidProfile): number {
  return p.burstPause * (0.7 + Math.random() * 0.6);
}

/**
 * The grenades handed out at spawn (`parts/Pool.spawnRogue`, authority only). `none` = a type with no throwing AI, like a named rogue or the scan drone.
 * The remainder lives in `Enemy.grenadeCount`, drops by one per throw (`parts/Attacks.throwGrenade`) and goes onto the corpse on death.
 */
export function rollGrenadeLoadout(e: Enemy, none: boolean): void {
  e.grenadeKind = 'frag';
  e.grenadeCount = 0;
  if (none || !e.isHumanoid) return;
  const p = humanoidProfile(e);
  const lo = Math.max(0, Math.round(p.grenadeMin));
  const hi = Math.max(lo, Math.round(p.grenadeMax));
  if (hi <= 0) return;
  e.grenadeCount = lo + Math.floor(Math.random() * (hi - lo + 1));
  e.grenadeKind = Math.random() < p.incendiaryChance ? 'incendiary' : 'frag';
}
