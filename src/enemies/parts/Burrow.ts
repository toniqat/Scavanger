/**
 * src/enemies/parts/Burrow.ts — **the FX, the shake and the sound of a burrow spawn** (2026-09-13).
 *
 * The question this file answers: *what this client sees · feels · hears when a bug comes up out of the ground.*
 *
 * The authority (`Pool.spawn(…, emerge)`) and a replica (`ee spawn.em` → `EnemySystem.emergeSpawned`) call the **same functions**.
 * It changes no game state — the emerge time itself is held by `Enemy.startEmerge`, and `ai/Burrow` is what blocks attack and movement.
 *
 * - **Shakes do not overlap**: only while the local player is within `BURROW_SHAKE_RADIUS`, and only once `BURROW_SHAKE_GAP_S` has
 *   passed since the last one that **actually shook** (`EnemySystem.burrowShakeAt`). Eight spat bugs coming up in one frame shake once.
 * - 2026-09-16: the sound `burrow_emerge` plays **per bug** at that body (before, `playAudio`'s 0.12 s id throttle folded a whole
 *   batch into one sound). Two layers keep a big batch from being loud: ① here, the k-th sound within `BURROW_EMERGE_BATCH_S` × 1/√k
 *   (`emergeSound`), ② audio/'s `VOICE_CAP.burrow_emerge` (`BURROW_EMERGE_VOICE_CAP`) keeps only the loudest (nearest) ones.
 */
import * as THREE from 'three';
import { BURROW_EMERGE_BATCH_S, BURROW_SHAKE_GAP_S, BURROW_SHAKE_INTENSITY, BURROW_SHAKE_RADIUS } from '@/shared';
import type { Enemy } from '../Enemy';
import type { EnemySystem } from '../EnemySystem';
import { isWormType } from '../EnemyTypes';

/** Body size → the FX scale (scavenger ≈ 0.75, warrior ≈ 1.3, behemoth 3). */
function burrowScale(e: Enemy): number {
  return THREE.MathUtils.clamp(e.stats.radius / 0.6, 0.7, 3);
}

/** One body started digging its way out (authority and replica alike). The sandworm's director plays its own eruption FX instead. */
export function emergeFx(sys: EnemySystem, e: Enemy): void {
  if (isWormType(e.type)) return;
  const ctx = sys.ctx;
  const scale = burrowScale(e);
  sys.burrowFx?.emerge(e.position, scale, e.emergeDur, ctx.world, ctx.time);
  emergeSound(sys, e.position, Math.min(1.1, 0.7 + 0.15 * scale), 1.12 - 0.12 * Math.min(2, scale));
  burrowShake(sys, e.position, BURROW_SHAKE_INTENSITY * Math.min(1.5, Math.sqrt(scale)));
}

/** A spat bug landed (authority and replica alike): a puff of dust at its feet and a small thud. */
export function spatLandedFx(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  sys.burrowFx?.puff(e.position, burrowScale(e), ctx.world);
  emergeSound(sys, e.position, 0.45, 1.35);
}

/* 2026-09-16: the current batch's start time and how many emerge sounds it has played. Module state because there is only one
 * EnemySystem and this is FX only (not game state). When `ctx.time` rewinds on a new mission (`now < emergeBatchAt`) it counts as a new batch. */
let emergeBatchAt = -Infinity;
let emergeBatchN = 0;

/**
 * One body's emerge sound (2026-09-16). **The batch window does not slide** — once `BURROW_EMERGE_BATCH_S` has passed since the first
 * sound it is a new batch (one body coming up every 0.3 s does not make the sound quieter and quieter forever). The k-th × 1/√k: the
 * energy of an eight-body batch ≈ 2.7 × one body's. It does not go through `playAudio`'s id throttle — it plays per body.
 */
function emergeSound(sys: EnemySystem, p: THREE.Vector3, volume: number, pitch: number): void {
  const now = sys.ctx.time;
  if (now < emergeBatchAt || now - emergeBatchAt >= BURROW_EMERGE_BATCH_S) { emergeBatchAt = now; emergeBatchN = 0; }
  emergeBatchN++;
  sys.ctx.bus.emit('audio:play', { id: 'burrow_emerge', position: p, volume: volume / Math.sqrt(emergeBatchN), pitch });
}

/**
 * A light screen shake — only while the local player is inside the radius and `BURROW_SHAKE_GAP_S` has passed since the last
 * burrow shake. True when it shook.
 */
export function burrowShake(sys: EnemySystem, p: THREE.Vector3, intensity: number): boolean {
  const now = sys.ctx.time;
  if (now - sys.burrowShakeAt < BURROW_SHAKE_GAP_S) return false;
  const d = sys.targets.distToLocal(p);
  if (!(d < BURROW_SHAKE_RADIUS)) return false;
  sys.burrowShakeAt = now;
  sys.burrowShakes++;
  sys.ctx.bus.emit('camera:shake', { intensity: intensity * (1 - d / BURROW_SHAKE_RADIUS), duration: 0.3 });
  return true;
}
