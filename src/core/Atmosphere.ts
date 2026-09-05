import * as THREE from 'three';
import { Sky, SKY_PALETTES, type SkyPalette } from './Sky';
import { Random } from '@/shared';

/**
 * Sun (with player-following shadow frustum), hemisphere fill, exponential fog and the sky dome.
 * `applySeed()` picks a palette per mission so every drop feels like a different planet.
 */
export class Atmosphere {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  readonly fog: THREE.FogExp2;
  palette: SkyPalette = SKY_PALETTES[0];
  /** true while the hub's space / hangar look is active (see `setSpaceMode`). */
  spaceMode = false;
  private readonly scene: THREE.Scene;
  private readonly sunOffset = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Feature folders may not import core/; the hub reaches this instance through the scene so it can
    // flip `setSpaceMode` without a bus round-trip (Engine restores the planet look on the next `world:ready`).
    scene.userData.atmosphere = this;
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sc = this.sun.shadow;
    sc.mapSize.set(2048, 2048);
    sc.camera.near = 1;
    sc.camera.far = 320;
    sc.camera.left = -60; sc.camera.right = 60; sc.camera.top = 60; sc.camera.bottom = -60;
    sc.bias = -0.0006;
    sc.normalBias = 0.03;
    sc.radius = 2;
    this.sun.target.name = 'SunTarget';
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x8fa3c8, 0x5a4636, 1.35); // strong fill so shadowed ground/characters stay readable
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xc99a6c, 0.0042);
    scene.fog = this.fog;

    this.sky = new Sky(900);
    scene.add(this.sky.mesh);

    this.applyPalette(SKY_PALETTES[0]);
  }

  applySeed(seed: number): SkyPalette {
    const rng = new Random(seed).fork('atmosphere');
    const p = rng.pick(SKY_PALETTES);
    this.applyPalette(p);
    return p;
  }

  /**
   * Ship hub / docking look: dark starless-black background, no fog, dim cool key light and a faint blue
   * hemisphere so procedural interiors are lit by their own emissives / point lights. The sky dome is hidden
   * (the hub renders its own starfield). `applySeed` / `applyPalette` (next `world:ready`) restore the planet look.
   */
  setSpaceMode(on: boolean): void {
    if (this.spaceMode === on) return;
    this.spaceMode = on;
    if (!on) { this.applyPalette(this.palette); return; }
    this.sky.mesh.visible = false;
    this.sun.color.setHex(0xa9c4ff);
    this.sun.intensity = 1.1;
    this.hemi.color.setHex(0x2a3a5a);
    this.hemi.groundColor.setHex(0x0b0d12);
    this.hemi.intensity = 0.7;
    this.fog.color.setHex(0x020308);
    this.fog.density = 0;
    this.scene.background = new THREE.Color(0x020308);
    // key light from high and to the side so interior props get a readable rim through viewports
    this.sunOffset.set(0.35, 0.8, 0.5).normalize().multiplyScalar(140);
  }

  applyPalette(p: SkyPalette): void {
    this.palette = p;
    this.spaceMode = false;
    this.sky.mesh.visible = true;
    this.hemi.intensity = 1.35;
    this.sky.applyPalette(p);
    this.sun.color.setHex(p.sun);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.fog.color.setHex(p.fog);
    this.fog.density = p.fogDensity;
    this.scene.background = new THREE.Color(p.fog);
    this.sunOffset.copy(this.sky.sunDir).multiplyScalar(140);
  }

  /** Keep the shadow frustum centred on the player (or camera when no player yet). */
  update(time: number, camera: THREE.Camera, focus: THREE.Vector3 | null): void {
    this.sky.update(time, camera);
    const f = focus ?? camera.position;
    // snap the shadow target to a coarse grid to avoid shimmering as the player walks
    const gx = Math.round(f.x / 2) * 2, gz = Math.round(f.z / 2) * 2;
    this.sun.target.position.set(gx, f.y, gz);
    this.sun.position.set(gx + this.sunOffset.x, f.y + this.sunOffset.y, gz + this.sunOffset.z);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void { this.sky.dispose(); }
}
