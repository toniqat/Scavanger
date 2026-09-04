import * as THREE from 'three';

/**
 * Fixed-capacity CPU-simulated point particle pool rendered with one `THREE.Points`.
 * Two flavours are used by the game: additive (sparks/fire/glow) and alpha (dust/smoke).
 * Alive particles are kept packed at the front of the buffers (swap-remove), and only the
 * alive range is drawn.
 */
export interface ParticleSpawn {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** seconds */
  life: number;
  /** world-ish size (meters at 1 m from camera scale) */
  size: number;
  /** size multiplier at end of life (1 = constant) */
  sizeEnd?: number;
  /** color at spawn */
  r: number; g: number; b: number;
  /** color at death (defaults to spawn color) */
  rEnd?: number; gEnd?: number; bEnd?: number;
  gravity?: number;
  /** velocity damping per second (0 = none) */
  drag?: number;
  /** alpha at spawn (0..1) */
  alpha?: number;
  /** if true particle stops on ground plane `groundY` (set by caller) */
  groundY?: number;
}

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  uniform float uMaxSize;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.5, -mv.z);
    gl_PointSize = clamp(aSize * uScale / dist, 1.0, uMaxSize);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_SOFT = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = smoothstep(1.0, 0.25, d);
    a *= a;
    gl_FragColor = vec4(vColor, a * vAlpha);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

const FRAG_HARD = /* glsl */`
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = smoothstep(1.0, 0.6, d);
    gl_FragColor = vec4(vColor, a * vAlpha);
    if (gl_FragColor.a < 0.004) discard;
  }
`;

export class ParticlePool {
  readonly points: THREE.Points;
  readonly capacity: number;
  private alive = 0;

  private readonly geometry: BufferGeometryWithAttrs;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly siz: Float32Array;
  private readonly alp: Float32Array;

  // simulation state (not uploaded)
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly col0: Float32Array;
  private readonly col1: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly ground: Float32Array;

  private readonly material: THREE.ShaderMaterial;

  constructor(capacity: number, opts: { additive: boolean; hard?: boolean }) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.siz = new Float32Array(capacity);
    this.alp = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.col0 = new Float32Array(capacity * 3);
    this.col1 = new Float32Array(capacity * 3);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.ground = new Float32Array(capacity);

    const g = new THREE.BufferGeometry() as BufferGeometryWithAttrs;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alp, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: opts.hard ? FRAG_HARD : FRAG_SOFT,
      uniforms: { uScale: { value: 400 }, uMaxSize: { value: 96 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.additive ? 20 : 10;
    this.points.matrixAutoUpdate = false;
  }

  get aliveCount(): number { return this.alive; }

  /** Adjust point scale for viewport height so sizes stay in world-ish units. */
  setViewportHeight(h: number): void {
    this.material.uniforms.uScale.value = h * 0.55;
    // cap on-screen size (px) so close-range dust never turns into giant blobs
    this.material.uniforms.uMaxSize.value = Math.max(48, h * 0.085);
  }

  spawn(p: ParticleSpawn): void {
    let i: number;
    if (this.alive < this.capacity) { i = this.alive++; }
    else { i = (Math.random() * this.capacity) | 0; } // overwrite random one when full
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx; this.vel[i3 + 1] = p.vy; this.vel[i3 + 2] = p.vz;
    this.life[i] = p.life; this.maxLife[i] = p.life;
    this.size0[i] = p.size; this.size1[i] = p.size * (p.sizeEnd ?? 1);
    this.col0[i3] = p.r; this.col0[i3 + 1] = p.g; this.col0[i3 + 2] = p.b;
    this.col1[i3] = p.rEnd ?? p.r; this.col1[i3 + 1] = p.gEnd ?? p.g; this.col1[i3 + 2] = p.bEnd ?? p.b;
    this.grav[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.alpha0[i] = p.alpha ?? 1;
    this.ground[i] = p.groundY ?? -1e9;
    this.col[i3] = p.r; this.col[i3 + 1] = p.g; this.col[i3 + 2] = p.b;
    this.siz[i] = p.size; this.alp[i] = this.alpha0[i];
  }

  clear(): void { this.alive = 0; this.geometry.setDrawRange(0, 0); }

  update(dt: number): void {
    if (this.alive === 0) return;
    const pos = this.pos, vel = this.vel, life = this.life;
    let n = this.alive;
    for (let i = 0; i < n;) {
      life[i] -= dt;
      if (life[i] <= 0) { this.swapRemove(i, n - 1); n--; continue; }
      const i3 = i * 3;
      const dragF = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      vel[i3 + 1] -= this.grav[i] * dt;
      vel[i3] *= dragF; vel[i3 + 1] *= dragF; vel[i3 + 2] *= dragF;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const gy = this.ground[i];
      if (pos[i3 + 1] < gy) { pos[i3 + 1] = gy; vel[i3 + 1] = 0; vel[i3] *= 0.6; vel[i3 + 2] *= 0.6; }
      const t = 1 - life[i] / this.maxLife[i]; // 0..1 age
      this.siz[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      // alpha: quick in, ease out
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      this.alp[i] = this.alpha0[i] * fade * fade;
      this.col[i3] = this.col0[i3] + (this.col1[i3] - this.col0[i3]) * t;
      this.col[i3 + 1] = this.col0[i3 + 1] + (this.col1[i3 + 1] - this.col0[i3 + 1]) * t;
      this.col[i3 + 2] = this.col0[i3 + 2] + (this.col1[i3 + 2] - this.col0[i3 + 2]) * t;
      i++;
    }
    this.alive = n;
    this.geometry.setDrawRange(0, n);
    const g = this.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }

  private swapRemove(i: number, last: number): void {
    if (i === last) return;
    const a = i * 3, b = last * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[a + k] = this.pos[b + k];
      this.vel[a + k] = this.vel[b + k];
      this.col0[a + k] = this.col0[b + k];
      this.col1[a + k] = this.col1[b + k];
      this.col[a + k] = this.col[b + k];
    }
    this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last]; this.size1[i] = this.size1[last];
    this.grav[i] = this.grav[last]; this.drag[i] = this.drag[last];
    this.alpha0[i] = this.alpha0[last]; this.ground[i] = this.ground[last];
    this.siz[i] = this.siz[last]; this.alp[i] = this.alp[last];
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

type BufferGeometryWithAttrs = THREE.BufferGeometry & {
  attributes: { position: THREE.BufferAttribute; aColor: THREE.BufferAttribute; aSize: THREE.BufferAttribute; aAlpha: THREE.BufferAttribute };
};
