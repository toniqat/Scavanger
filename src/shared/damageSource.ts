/*
 * src/shared/damageSource.ts — **the source of a local player's damage** (2026-09-14, NPC quest kill objectives · docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 「산탄총으로 레이더 5명 처치」 counts only when the **last hit came from a gun of that class**. But `Enemy.takeDamage`
 * does not know who hit it or with what (a gun · melee · a gadget · a shield bash all call it the same way). So weapons/
 * wraps the **synchronous window** in which one bullet's damage is applied with this file (`withLocalGunHit`), and
 * enemies/ records a class only for local damage that arrived inside that window (`localGunHitClass`).
 * Outside the window (a grenade · a gadget · melee · burn damage over time) it is null — a kill with no class.
 *
 * The state is one module variable, and JS is single-threaded, so the windows never overlap. Even when the window throws, `finally` puts it back.
 */
import type { WeaponClass } from './types';

let current: WeaponClass | null = null;

/** Marks local damage arriving during `fn` as damage from a `cls` gun (null = no mark). Returns `fn`'s return value unchanged. */
export function withLocalGunHit<T>(cls: WeaponClass | null | undefined, fn: () => T): T {
  const prev = current;
  current = cls ?? null;
  try { return fn(); } finally { current = prev; }
}

/** The class, when the local damage arriving right now is one gunshot; otherwise null. */
export function localGunHitClass(): WeaponClass | null {
  return current;
}
