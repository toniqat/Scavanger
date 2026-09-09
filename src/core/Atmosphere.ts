import * as THREE from 'three';
import type { PlanetDef } from '@/shared';
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
  /* ── appended (2026-09-09): 대기 오버라이드 (`atmo:override`) — 환경 재해가 시야를 좁히는 유일한 통로 ──
   * 팔레트가 정한 값을 `base*` 에 떠 두고, 오버라이드를 그 **위에** 얹는다. 팔레트가 바뀌면 base 를 다시 잡고
   * 오버라이드는 그대로 살아 있으므로, 재해 도중에 행성이 바뀌어도 어긋나지 않는다. */
  private baseDensity = 0;
  private readonly baseColor = new THREE.Color(0xffffff);
  private ovFogMul = 1;
  private ovColor: number | null = null;
  private ovBlend = 0;
  private readonly ovScratch = new THREE.Color();

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

  /**
   * Pre-Phase-11 path, and still the fallback whenever a mission has no planet: draw the sky from the seed.
   * `world/biomes.pickBiome` mirrors this draw, which is why both lists must keep exactly 5 entries.
   */
  applySeed(seed: number): SkyPalette {
    const rng = new Random(seed).fork('atmosphere');
    const p = rng.pick(SKY_PALETTES);
    this.applyPalette(p);
    return p;
  }

  /**
   * Phase 11: the sky of a **selected planet**. The palette is named by `PlanetDef.sky` (no more implicit index
   * pairing with the biome list), the fog density is scaled by `fogMul`, and a `fog: false` planet gets no fog at
   * all — its background comes from the sky's own horizon instead of the (now unused) fog colour.
   * Returns the palette so `Engine` can set the tone-mapping exposure exactly as it does for `applySeed`.
   */
  applyPlanet(planet: PlanetDef): SkyPalette {
    const p = SKY_PALETTES.find((s) => s.name === planet.sky) ?? SKY_PALETTES[0];
    this.applyPalette(p);
    if (planet.fog) {
      this.fog.density = p.fogDensity * planet.fogMul;
    } else {
      this.fog.density = 0;
      this.scene.background = new THREE.Color(p.horizon);
    }
    this.captureBase();
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
    this.captureBase();
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
    this.captureBase();
  }

  /* ── appended (2026-09-09): 대기 오버라이드 ───────────────────────────────────────────────────────────── */
  /** 지금 fog 에 들어 있는 값을 "원래 하늘" 로 기억한다. 팔레트를 갈아 끼운 직후에 부른다. */
  private captureBase(): void {
    this.baseDensity = this.fog.density;
    this.baseColor.copy(this.fog.color);
    this.applyOverride();
  }

  /**
   * 하늘 · 포그를 일시적으로 밀어붙인다 (`atmo:override` 이벤트의 구현). 마지막으로 받은 값 하나만 기억한다.
   * `fogMul` = 원래 포그 농도의 배수, `color` = 섞어 넣을 색(null = 그대로), `blend` = 0..1 섞는 정도.
   * `{1, null, 0}` 이면 완전히 원래대로 돌아간다.
   */
  setOverride(fogMul: number, color: number | null, blend: number): void {
    this.ovFogMul = Number.isFinite(fogMul) ? Math.max(0, fogMul) : 1;
    this.ovColor = color;
    this.ovBlend = Number.isFinite(blend) ? Math.min(1, Math.max(0, blend)) : 0;
    this.applyOverride();
  }

  /** base + 오버라이드를 실제 fog / background 에 반영한다. */
  private applyOverride(): void {
    const t = this.ovBlend;
    this.fog.density = this.baseDensity * (1 + (this.ovFogMul - 1) * t);
    this.fog.color.copy(this.baseColor);
    if (this.ovColor !== null && t > 0) this.fog.color.lerp(this.ovScratch.setHex(this.ovColor), t);
    // 배경은 포그 색을 따라간다 (포그 없는 맑은 행성은 `applyPlanet` 이 horizon 을 넣어 뒀으므로 건드리지 않는다)
    if (this.baseDensity > 0 && this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.fog.color);
    }
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
