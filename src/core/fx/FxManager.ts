import * as THREE from 'three';
import { ParticlePool } from './ParticlePool';
import { TracerPool } from './TracerPool';
import { FlashPool } from './FlashPool';

/**
 * Owner of the shared transient-FX pools. Installed by Engine (added to the scene, updated after
 * lateUpdate). Player/Weapon systems (same owner) obtain it via `FxManager.get()`.
 */
export class FxManager {
  private static instance: FxManager | null = null;
  static install(scene: THREE.Scene): FxManager {
    if (!FxManager.instance) FxManager.instance = new FxManager(scene);
    return FxManager.instance;
  }
  /** Null until the Engine has been constructed. */
  static get(): FxManager | null { return FxManager.instance; }

  /** additive glow particles: sparks, fire, thruster */
  readonly additive: ParticlePool;
  /** alpha-blended particles: dust, smoke, debris */
  readonly alpha: ParticlePool;
  readonly tracers: TracerPool;
  readonly flashes: FlashPool;
  readonly group = new THREE.Group();

  private constructor(scene: THREE.Scene) {
    this.group.name = 'FX';
    this.additive = new ParticlePool(3000, { additive: true });
    this.alpha = new ParticlePool(2500, { additive: false });
    this.tracers = new TracerPool(96);
    this.flashes = new FlashPool(6);
    this.group.add(this.additive.points, this.alpha.points, this.tracers.mesh, this.flashes.group);
    scene.add(this.group);
  }

  setViewport(width: number, height: number): void {
    this.additive.setViewportHeight(height);
    this.alpha.setViewportHeight(height);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.additive.update(dt);
    this.alpha.update(dt);
    this.tracers.update(dt, camera);
    this.flashes.update(dt, camera);
  }

  /** Drop all live effects (mission reset). */
  clear(): void {
    this.additive.clear(); this.alpha.clear(); this.tracers.clear(); this.flashes.clear();
  }
}
