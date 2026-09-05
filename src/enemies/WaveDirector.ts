import * as THREE from 'three';
import type { EnemyType } from '@/shared';
import { MAX_BEHEMOTH, findSpawnCenter, spawnGroup, waveGroup, type SpawnHost } from './Spawner';

export const WAVE_ALIVE_CAP = 60;

/**
 * Extraction pressure: escalating waves every 14 s → 9 s until stopped.
 * Bugs spawn 45–90 m from the extraction target, out of every player's view, and hunt relentlessly.
 * Runs only on the authority (host / single-player); waves pause while no player is alive.
 */
export class WaveDirector {
  active = false;
  index = 0;
  private timer = 0;
  private readonly target = new THREE.Vector3();
  private readonly center = new THREE.Vector3();

  start(target: THREE.Vector3): void {
    if (this.active) { this.target.copy(target); return; }
    this.active = true;
    this.index = 0;
    this.timer = 3;               // first wave shortly after the switch is pressed
    this.target.copy(target);
  }

  stop(): void { this.active = false; }

  reset(): void { this.active = false; this.index = 0; this.timer = 0; }

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
    const rolled = waveGroup(this.index, Math.min(size, allowed));
    // per-type cap: a second behemoth becomes a warrior
    const types: EnemyType[] = rolled.map((t) => (t === 'behemoth' && host.countAlive('behemoth') >= MAX_BEHEMOTH ? 'warrior' : t));
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
