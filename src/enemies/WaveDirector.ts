import * as THREE from 'three';
import type { EnemyType, PlanetEcosystem } from '@/shared';
import { findSpawnCenter, maxBehemothOf, spawnGroup, waveGroup, type SpawnHost } from './Spawner';

export const WAVE_ALIVE_CAP = 60;

/**
 * Extraction pressure: escalating waves every 14 s → 9 s until stopped.
 * Bugs spawn 45–90 m from the extraction target, out of every player's view, and hunt relentlessly.
 * Runs only on the authority (host / single-player); waves pause while no player is alive.
 */
export class WaveDirector {
  active = false;
  index = 0;
  /** Phase 11: ecosystem of the 목표 행성 (set by `EnemySystem` at `world:ready`); null = the pre-Phase-11 tables. */
  eco: PlanetEcosystem | null = null;
  private timer = 0;
  private readonly target = new THREE.Vector3();
  private readonly center = new THREE.Vector3();

  /** Phase 7: wave index to continue from when `start` is called after a host promotion (−1 = fresh start). */
  private primed = -1;

  start(target: THREE.Vector3): void {
    if (this.active) { this.target.copy(target); return; }
    this.active = true;
    this.target.copy(target);
    if (this.primed >= 0) {
      // resumed on a new host mid-extraction: continue the escalation instead of restarting at wave 0
      this.index = this.primed;
      this.timer = Math.min(this.interval(), 6);
      this.primed = -1;
      return;
    }
    this.index = 0;
    this.timer = 3;               // first wave shortly after the switch is pressed
  }

  stop(): void { this.active = false; }

  reset(): void { this.active = false; this.index = 0; this.timer = 0; this.primed = -1; }

  /**
   * Phase 7 (host promotion): the next `start` (re-requested by extraction/ once we are the authority) continues from
   * `index` — the number of `ee wave`s this client saw as a replica.
   */
  prime(index: number): void { this.primed = Math.max(0, index); }

  private interval(): number { return Math.max(9, 14 - this.index * 0.8); }
  private waveSize(): number { return Math.min(22, 6 + this.index * 2); }

  update(dt: number, host: SpawnHost): void {
    if (!this.active) return;
    const ctx = host.ctx;
    if (!ctx.isGameplayPhase() || !ctx.world?.ready || !host.targets.anyAlive()) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.interval();

    const size = this.waveSize();
    const allowed = host.ensureCapacity(size, WAVE_ALIVE_CAP);
    if (allowed <= 0) { this.timer = 3; return; }   // try again soon
    const rolled = waveGroup(this.index, Math.min(size, allowed), this.eco);
    // per-type cap (Phase 11: `eco.maxBehemoth`, 0 on a planet with none): a behemoth over the cap becomes a warrior
    const behemoths = maxBehemothOf(this.eco);
    let alive = host.countAlive('behemoth');
    const types: EnemyType[] = rolled.map((t) => {
      if (t !== 'behemoth') return t;
      if (alive >= behemoths) return 'warrior';
      alive++;
      return t;
    });
    ctx.bus.emit('enemy:waveStarted', { index: this.index, count: types.length });

    // split big waves into 1–3 groups arriving from different directions
    const groups = types.length >= 14 ? 3 : types.length >= 9 ? 2 : 1;
    const per = Math.ceil(types.length / groups);
    let spawned = 0;
    for (let g = 0; g < groups; g++) {
      const slice = types.slice(g * per, (g + 1) * per);
      if (slice.length === 0) break;
      if (!findSpawnCenter(host, this.target, 45, 90, false, 30, this.center)) {
        const near = host.targets.nearestAlive(this.target);
        if (!near || !findSpawnCenter(host, near.position, 45, 90, false, 30, this.center)) continue;
      }
      const face = host.targets.nearestAlive(this.center);
      spawned += spawnGroup(host, slice, this.center, true, true, face ? face.position : undefined);
    }
    if (spawned > 0) ctx.bus.emit('audio:play', { id: 'bug_screech', position: this.center, volume: 1, pitch: 0.8 });
    this.index++;
  }
}
