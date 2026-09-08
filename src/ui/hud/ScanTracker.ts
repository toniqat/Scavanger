import * as THREE from 'three';
import type { EnemyRef, GameContext, ScanTarget } from '@/shared';
import { IMPLANT_SCAN_REVEAL_TIME_V2 } from '@/shared';

/** One enemy a 정찰 pulse revealed: followed live through its `object` while the reveal lasts. */
export interface ScannedEnemy {
  /** Enemy id (numeric form of `ScanTarget.id`). */
  id: number;
  position: THREE.Vector3;
  object: THREE.Object3D | null;
  expires: number;
}

const REFRESH_INTERVAL = 0.25;

/**
 * Enemies revealed by a 정찰 pulse (Phase 12): `scan:cast {targets, duration}` — mine or a squadmate's — keeps every
 * `kind: 'enemy'` target for `duration` seconds (15 s, `IMPLANT_SCAN_REVEAL_TIME_V2`) **regardless of distance**, so
 * the compass ticks and the detection arrows can show them after the player walked away. Shared by `hud/Compass` and
 * `hud/Detection` (one instance, owned by `HudSystem`) so the bookkeeping is done once per frame.
 *
 * A revealed enemy follows its `object` (`getWorldPosition` into the stored vector); entries are pruned when they
 * expire or when the enemy has died (looked up in `ctx.enemies.getEnemies()` every `REFRESH_INTERVAL`, not per frame).
 * `implant:scanned` (the pre-Phase-12 pulse event) feeds the same map so an older implants build keeps working.
 */
export class ScanTracker {
  private entries = new Map<number, ScannedEnemy>();
  private list: ScannedEnemy[] = [];
  private dirty = false;
  private nextRefresh = 0;
  private unsubs: Array<() => void> = [];

  bind(ctx: GameContext): void {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('scan:cast', ({ targets, duration }) => this.add(ctx, targets, duration)),
      b.on('implant:scanned', ({ targets, duration }) => this.add(ctx, targets, duration)),
      b.on('detect:clear', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('game:newMission', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
      b.on('player:died', () => this.clear()),
    );
  }

  private add(ctx: GameContext, targets: readonly ScanTarget[] | undefined, duration: number): void {
    if (!targets || targets.length === 0) return;
    const dur = duration > 0 ? duration : IMPLANT_SCAN_REVEAL_TIME_V2;
    const expires = ctx.time + dur;
    for (const t of targets) {
      if (t.kind !== 'enemy') continue;
      const id = Number(t.id);
      if (!Number.isFinite(id)) continue;
      const e = this.entries.get(id);
      if (e) {
        e.expires = Math.max(e.expires, expires);
        e.position.copy(t.position);
        if (t.object) e.object = t.object;
      } else {
        this.entries.set(id, { id, position: t.position.clone(), object: t.object ?? null, expires });
        this.dirty = true;
      }
    }
    this.nextRefresh = 0;
  }

  clear(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.dirty = true;
  }

  /** Number of live reveals (debug). */
  get count(): number { return this.entries.size; }

  /**
   * Prune + follow, once per frame (both consumers call it; the second call in the same frame is a no-op apart from
   * the cheap `getWorldPosition`s). Returns the live list — do not keep the array across frames.
   */
  update(ctx: GameContext): readonly ScannedEnemy[] {
    if (this.entries.size === 0) { if (this.dirty) { this.list.length = 0; this.dirty = false; } return this.list; }
    const t = ctx.time;
    let pruned = false;
    for (const e of this.entries.values()) {
      if (t >= e.expires) { this.entries.delete(e.id); pruned = true; }
    }
    if (t >= this.nextRefresh && this.entries.size > 0) {
      this.nextRefresh = t + REFRESH_INTERVAL;
      const em = ctx.enemies;
      if (em) {
        // drop the dead: one pass over the live list instead of a find() per entry
        const alive = new Set<number>();
        for (const e of em.getEnemies()) if (!e.isDead) alive.add(e.id);
        for (const e of this.entries.values()) {
          if (!alive.has(e.id)) { this.entries.delete(e.id); pruned = true; }
        }
      }
    }
    if (pruned || this.dirty) {
      this.list.length = 0;
      for (const e of this.entries.values()) this.list.push(e);
      this.dirty = false;
    }
    for (const e of this.list) if (e.object) e.object.getWorldPosition(e.position);
    return this.list;
  }

  /** Whether `ref` is currently revealed (so a consumer can skip drawing it twice). */
  has(ref: EnemyRef): boolean { return this.entries.has(ref.id); }

  dispose(): void { for (const u of this.unsubs) u(); this.entries.clear(); this.list.length = 0; }
}
