import * as THREE from 'three';
import type { PlanetDef } from '@/shared';
import { Sky, SKY_PALETTES, type SkyPalette } from './Sky';
import { Random, SUN_SHADOW_HALF_M, INDOOR_LIGHT_AMBIENT_MUL, INDOOR_FOG_MUL, INDOOR_LIGHT_FADE_S } from '@/shared';

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
  /* ── appended (2026-09-09): the atmosphere override (`atmo:override`) — the only path by which a hazard narrows
   * sight ── the values the palette decided are held in `base*` and the override is laid **on top** of them. A new
   * palette re-takes the base while the override stays alive, so a planet change mid-hazard goes nowhere out of
   * step. */
  private baseDensity = 0;
  private readonly baseColor = new THREE.Color(0xffffff);
  private readonly baseBg = new THREE.Color(0xffffff);
  private ovFogMul = 1;
  private ovColor: number | null = null;
  private ovBlend = 0;
  private readonly ovScratch = new THREE.Color();
  /* ── appended (2026-09-21): the indoor correction — a **local view** lift, nothing on the wire ── the hemisphere
   * fill the palette decided is held in `baseHemi`, and `indoor` (0..1) is the crossfade `Engine` steps. It rides on
   * top of the hazard override rather than replacing it (`applyOverride`), so a sandstorm still narrows sight indoors
   * — only less, which is what being under a roof means. **No light is added**: the fill that already exists gets
   * brighter, so the scene's point-light count is untouched (CLAUDE.md §4.5). */
  private baseHemi = 0;
  private indoor = 0;

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
    // The box follows the player (`update`). Its size is the range shadows are **sharp** over, not the map:
    // widening it spreads the same 2048 map thinner and softens every shadow in the raid. `world/Props` reads
    // the same constant so a prop inside this box is never put in its far, non-casting set.
    const half = SUN_SHADOW_HALF_M;
    sc.camera.left = -half; sc.camera.right = half; sc.camera.top = half; sc.camera.bottom = -half;
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

  /* ── appended (2026-09-09): the atmosphere override ─────────────────────────────────────────── */
  /** Remembers whatever `fog` holds right now as "the original sky". Called right after a palette swap. */
  private captureBase(): void {
    this.baseDensity = this.fog.density;
    this.baseColor.copy(this.fog.color);
    this.baseHemi = this.hemi.intensity;
    // a whole new look (planet · hub · space mode) means the old indoor state describes nothing: drop it here rather
    // than fade it out, so the hangar is never lit by the last raid's roof. `Engine` re-probes within a fraction of a
    // second and fades it back in if we really are under one.
    this.indoor = 0;
    if (this.scene.background instanceof THREE.Color) this.baseBg.copy(this.scene.background);
    this.applyOverride();
  }

  /* ── appended (2026-09-21): indoor brightness, 「레이드 실내가 어둡다」 ─────────────────────────────────────── */
  /**
   * Step the indoor crossfade toward `target` (1 = indoors). `Engine` owns the probe and calls this every frame;
   * the fade is **linear over `INDOOR_LIGHT_FADE_S`**, not a damp, because a damp never actually arrives and would
   * rewrite the fog every frame for the rest of the raid. Settled = an early return and zero work.
   */
  stepIndoor(dt: number, target: number): void {
    const t = target > 1 ? 1 : target < 0 ? 0 : target;
    if (this.indoor === t) return;
    const step = INDOOR_LIGHT_FADE_S > 0 ? dt / INDOOR_LIGHT_FADE_S : 1;
    this.indoor = t > this.indoor ? Math.min(t, this.indoor + step) : Math.max(t, this.indoor - step);
    this.applyOverride();
  }

  /** Snap the indoor correction off (a scene teardown — `game:abort`). */
  resetIndoor(): void {
    if (this.indoor === 0) return;
    this.indoor = 0;
    this.applyOverride();
  }

  /**
   * Pushes sky · fog temporarily (the implementation behind the `atmo:override` event). Only the last value received
   * is remembered. `fogMul` = a multiplier on the original fog density, `color` = the colour to mix in (null = leave
   * it alone), `blend` = how much is mixed, 0..1. `{1, null, 0}` goes all the way back to the original.
   */
  setOverride(fogMul: number, color: number | null, blend: number): void {
    this.ovFogMul = Number.isFinite(fogMul) ? Math.max(0, fogMul) : 1;
    this.ovColor = color;
    this.ovBlend = Number.isFinite(blend) ? Math.min(1, Math.max(0, blend)) : 0;
    this.applyOverride();
  }

  /**
   * Writes base + override into the real fog / background.
   *
   * The density is **an interpolation from `base` to `target`**. Why it is not a multiplication (`base × mul`) came
   * out on 2026-09-09: a **clear planet with no fog** (`PlanetDef.fog:false` → `카민 I`) has `baseDensity` 0, so
   * anything multiplied by it stays 0 and sight never narrowed at all inside that planet's sandstorm. Taking `target`
   * from the palette's own `fogDensity` lets that planet rise naturally too, "clear (0) → storm (palette density ×
   * mul)". On a planet that has fog, `lerp(base, base × mul, t)` is **exactly the same value** as the old
   * multiplication.
   */
  private applyOverride(): void {
    const t = this.ovBlend;
    const base = this.baseDensity;
    // a clear planet (base 0) measures from the density the palette already held — multiplying 0 stays 0 forever
    const target = (base > 0 ? base : this.palette.fogDensity) * this.ovFogMul;
    // 2026-09-21: the indoor correction is laid on **after** the hazard override, as a factor on whatever density
    // came out of it. Folding it into the override instead would make a roof cancel a sandstorm outright; this way a
    // storm still darkens the inside, only half as much. Colour and background are left alone — they are the sky.
    const k = this.indoor;
    this.fog.density = (base + (target - base) * t) * (1 + (INDOOR_FOG_MUL - 1) * k);
    this.hemi.intensity = this.baseHemi * (1 + (INDOOR_LIGHT_AMBIENT_MUL - 1) * k);
    this.fog.color.copy(this.baseColor);
    if (this.ovColor !== null && t > 0) this.fog.color.lerp(this.ovScratch.setHex(this.ovColor), t);
    // the background crosses over with it, original colour → fog colour. At t=0 it stays `baseBg`, so a clear
    // planet's horizon background is kept; a planet with fog has `baseBg === baseColor` and follows the fog colour.
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(this.baseBg);
      if (t > 0) this.scene.background.lerp(this.fog.color, t);
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
