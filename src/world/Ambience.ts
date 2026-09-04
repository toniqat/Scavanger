import * as THREE from 'three';
import { type BuildCtx, makeSoftParticleTexture } from './build';
import { HALF } from './Terrain';

const SPORE_COUNT = 900;

/**
 * Additive soft-particle material for spores. World size 0.18 m with perspective attenuation,
 * hard-clamped to [1, 6] device pixels so nothing near the camera blooms into a big disc,
 * and faded out inside ~5 m of the camera. Fog-aware.
 */
function makeSporeMaterial(tex: THREE.Texture, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uColor: { value: color.clone() },
      uTime: { value: 0 },
      uSize: { value: 0.18 },
      uMaxPx: { value: 6.0 },
      fogColor: { value: new THREE.Color(0x000000) },
      fogDensity: { value: 0.0 },
      fogNear: { value: 1 },
      fogFar: { value: 1000 },
    },
    vertexShader: /* glsl */`
      uniform float uSize;
      uniform float uMaxPx;
      uniform float uTime;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float dist = -mvPosition.z;
        float px = uSize * 1100.0 / max(dist, 0.01);   // ~perspective size in device px at 1080p-ish
        gl_PointSize = clamp(px, 1.0, uMaxPx);
        // fade in from 1.5 m to 6 m, fade out far away; twinkle
        float near = smoothstep(1.5, 6.0, dist);
        float far = 1.0 - smoothstep(60.0, 95.0, dist);
        float tw = 0.7 + 0.3 * sin(uTime * 2.3 + position.x * 3.1 + position.z * 1.7);
        vAlpha = near * far * tw;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap;
      uniform vec3 uColor;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float a = texture2D(uMap, gl_PointCoord).a * vAlpha * 0.85;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * a, a);
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}
const SPORE_BOX = 70;       // half-extent of the drifting cloud around the camera
const DUST_COUNT = 14;

/** Cheap animated atmosphere: drifting spores around the camera, slow dust sprites near the ground. */
export class Ambience {
  readonly group = new THREE.Group();
  private spores: THREE.Points | null = null;
  private sporeMat: THREE.ShaderMaterial | null = null;
  private sporeOffsets: Float32Array | null = null;   // local offsets in the cloud box
  private sporePhase: Float32Array | null = null;
  private dust: THREE.Sprite[] = [];
  private dustMats: THREE.SpriteMaterial[] = [];
  private dustBase: Float32Array | null = null;
  private tex: THREE.Texture | null = null;
  private terrainHeight: ((x: number, z: number) => number) | null = null;
  private time = 0;
  private readonly camPos = new THREE.Vector3();

  constructor() { this.group.name = 'Ambience'; }

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('ambience');
    this.tex = makeSoftParticleTexture(64);
    this.terrainHeight = (x, z) => ctx.terrain.getHeightAt(x, z);

    // spores
    const pos = new Float32Array(SPORE_COUNT * 3);
    this.sporeOffsets = new Float32Array(SPORE_COUNT * 3);
    this.sporePhase = new Float32Array(SPORE_COUNT);
    for (let i = 0; i < SPORE_COUNT; i++) {
      this.sporeOffsets[i * 3] = rng.range(-SPORE_BOX, SPORE_BOX);
      this.sporeOffsets[i * 3 + 1] = rng.range(0.3, 14);
      this.sporeOffsets[i * 3 + 2] = rng.range(-SPORE_BOX, SPORE_BOX);
      this.sporePhase[i] = rng.range(0, Math.PI * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.sporeMat = makeSporeMaterial(this.tex, ctx.biome.spore);
    this.spores = new THREE.Points(geo, this.sporeMat);
    this.spores.frustumCulled = false;
    this.spores.name = 'spores';
    this.group.add(this.spores);

    // dust sprites
    this.dustBase = new Float32Array(DUST_COUNT * 3);
    for (let i = 0; i < DUST_COUNT; i++) {
      const m = new THREE.SpriteMaterial({ map: this.tex, color: ctx.biome.dust, transparent: true, opacity: rng.range(0.05, 0.10), depthWrite: false, rotation: rng.range(0, Math.PI * 2) });
      const s = new THREE.Sprite(m);
      const x = rng.range(-HALF + 30, HALF - 30), z = rng.range(-HALF + 30, HALF - 30);
      const size = rng.range(60, 120);
      s.scale.set(size, size * 0.55, 1);
      const y = ctx.terrain.getHeightAt(x, z) + size * 0.12;
      s.position.set(x, y, z);
      this.dustBase[i * 3] = x; this.dustBase[i * 3 + 1] = y; this.dustBase[i * 3 + 2] = z;
      this.dust.push(s);
      this.dustMats.push(m);
      this.group.add(s);
    }
    ctx.root.add(this.group);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    const t = this.time;
    if (this.sporeMat) this.sporeMat.uniforms.uTime.value = t;
    if (this.spores && this.sporeOffsets && this.sporePhase) {
      camera.getWorldPosition(this.camPos);
      const cx = this.camPos.x, cz = this.camPos.z;
      const attr = this.spores.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const off = this.sporeOffsets, ph = this.sporePhase;
      const size = SPORE_BOX * 2;
      const hAt = this.terrainHeight;
      for (let i = 0; i < SPORE_COUNT; i++) {
        const p = ph[i];
        // slow wind drift + individual wobble; wrap in the box around the camera
        let lx = off[i * 3] + t * 0.9 + Math.sin(t * 0.4 + p) * 2.5;
        let lz = off[i * 3 + 2] + t * 0.35 + Math.cos(t * 0.33 + p * 1.3) * 2.0;
        lx = ((lx - cx + SPORE_BOX) % size + size) % size - SPORE_BOX + cx;
        lz = ((lz - cz + SPORE_BOX) % size + size) % size - SPORE_BOX + cz;
        const ly = off[i * 3 + 1] + Math.sin(t * 0.7 + p * 2.1) * 0.8;
        arr[i * 3] = lx;
        arr[i * 3 + 1] = (hAt ? hAt(lx, lz) : 0) + ly;
        arr[i * 3 + 2] = lz;
      }
      attr.needsUpdate = true;
    }
    if (this.dustBase) {
      for (let i = 0; i < this.dust.length; i++) {
        const s = this.dust[i];
        s.position.x = this.dustBase[i * 3] + Math.sin(t * 0.05 + i) * 12;
        s.position.z = this.dustBase[i * 3 + 2] + Math.cos(t * 0.04 + i * 1.7) * 12;
        s.material.rotation += dt * 0.01 * (i % 2 ? 1 : -1);
      }
    }
  }

  dispose(): void {
    if (this.spores) { this.group.remove(this.spores); this.spores.geometry.dispose(); this.spores = null; }
    this.sporeMat?.dispose(); this.sporeMat = null;
    this.sporeOffsets = null; this.sporePhase = null;
    for (const s of this.dust) this.group.remove(s);
    this.dust.length = 0;
    for (const m of this.dustMats) m.dispose();
    this.dustMats.length = 0;
    this.dustBase = null;
    this.tex?.dispose(); this.tex = null;
    this.terrainHeight = null;
    this.group.removeFromParent();
  }
}
