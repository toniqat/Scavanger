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
  private readonly scene: THREE.Scene;
  private readonly sunOffset = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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

  applyPalette(p: SkyPalette): void {
    this.palette = p;
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
