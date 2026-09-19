/**
 * src/gadgets/parts/Thumper.ts — **when the thumper (`진동 장치`) strikes, summons and breaks**
 * (2026-09-15, the sandworm).
 *
 * - **Strikes are never sent.** Every client counts them from its own replica's `age`
 *   (`floor(age / THUMPER_INTERVAL_S)`) — the host carries the time since placement in `DeployableWire.age`, so a
 *   late joiner keeps the same beat. Every strike: a dust ring · `thumper_thump` · `camera:shake` on a local player
 *   inside `THUMPER_SHAKE_RADIUS` (stronger the closer it is).
 * - **Only the host summons**: on strike `THUMPER_STRIKES` it emits `sandworm:summon {position, source:'thumper'}`
 *   **once** (`Deployable.summoned`). In a raid where the worm is already out the director ignores it, and the
 *   device keeps thumping forever after that (user's decision).
 * - **The eruption breaks it**: the authority that received `sandworm:erupted {position, radius}` calls
 *   `remove(destroyed)` on every thumper inside that radius — replicas break with it through the ordinary
 *   `gad remove`. There is no recovering it (`GadgetDef.recoverTime` 0).
 */
import type * as THREE from 'three';
import { THUMPER_GROUND_R, THUMPER_INTERVAL_S, THUMPER_SHAKE, THUMPER_SHAKE_RADIUS, THUMPER_STRIKES } from '@/shared';
import type { Deployable } from '../Deployable';
import type { GadgetSystem } from '../GadgetSystem';

/* ── presentation-only values (not gameplay numbers — those are `THUMPER_*`) ───────── */
/** The strike dust ring's colour · lifetime (s). */
const DUST_COLOR = '#c9b48a';
const DUST_LIFE = 0.5;
/** The length (s) of the strike shake — its strength is `THUMPER_SHAKE`. */
const SHAKE_S = 0.25;
const THUMP_VOLUME = 0.9;
/** The small shard ring drawn when the eruption breaks it. */
const BREAK_COLOR = '#ffb14a';
const BREAK_RADIUS = 2.5;

/** Progress through this cycle, 0..1 (0 = it has just struck). `GadgetVisuals` draws it as the hammer height. */
export function cyclePhase(d: Deployable): number {
  const k = d.age / THUMPER_INTERVAL_S;
  return k - Math.floor(k);
}

/**
 * Every frame (on every client, from `Simulate.animate`): hands the hammer phase to the visual, and strikes once
 * `age` has passed the next strike time. `age` only rises while `GadgetSystem.update` runs with dt > 0, so a paused
 * game does not thump.
 */
export function tick(sys: GadgetSystem, d: Deployable, dt: number): void {
  d.visual.phase = cyclePhase(d);
  if (dt <= 0 || d.removing) return;
  const due = Math.floor(d.age / THUMPER_INTERVAL_S);
  while (d.strikes < due) {
    d.strikes++;
    strike(sys, d, d.strikes);
  }
}

/** One strike: the FX on every client, the summon only on the authority and only on strike `THUMPER_STRIKES`. */
function strike(sys: GadgetSystem, d: Deployable, n: number): void {
  const ctx = sys.ctx;
  sys.visuals.pulse(d.position, DUST_COLOR, 0.25, THUMPER_GROUND_R, DUST_LIFE);
  ctx.bus.emit('audio:play', { id: 'thumper_thump', position: d.position, volume: THUMP_VOLUME });
  const p = ctx.player;
  if (p && !p.isDead) {
    const k = 1 - p.position.distanceTo(d.position) / THUMPER_SHAKE_RADIUS;
    if (k > 0) ctx.bus.emit('camera:shake', { intensity: THUMPER_SHAKE * k, duration: SHAKE_S });
  }
  if (n === THUMPER_STRIKES && ctx.isAuthority && !d.summoned) {
    d.summoned = true;
    ctx.bus.emit('sandworm:summon', { position: d.position.clone(), source: 'thumper' });
  }
}

/**
 * `sandworm:erupted` (the authority only): breaks every thumper inside the eruption radius — replicas follow through
 * the host's `gad remove {destroyed}`.
 */
export function onErupted(sys: GadgetSystem, position: THREE.Vector3, radius: number): void {
  if (!sys.ctx.isAuthority) return;
  const r2 = radius * radius;
  for (let i = sys.deployables.length - 1; i >= 0; i--) {
    const d = sys.deployables[i];
    if (d.removing || d.kind !== 'thumper') continue;
    const dx = d.position.x - position.x, dz = d.position.z - position.z;
    if (dx * dx + dz * dz > r2) continue;
    sys.visuals.pulse(d.position, BREAK_COLOR, 0.4, BREAK_RADIUS, 0.45);
    sys.remove(d, 'destroyed');
  }
}
