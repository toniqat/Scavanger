import * as THREE from 'three';

/**
 * Small CPU-simulated point-sprite particle pool (one draw call). Used for the extraction
 * flare/smoke column and the landing dust ring. No textures: soft round sprite drawn in shader.
 */
export interface ParticleOptions {
  capacity: number;
  color: THREE.ColorRepresentation;
  colorEnd?: THREE.ColorRepresentation;
  additive?: boolean;
  gravity?: number;        // m/s² (negative = fall)
  drag?: number;           // per-second velocity damping
  growth?: number;         // size multiplier over life (1 = constant)
  softness?: number;       // 0..1 edge softness
}

const VERT = /* glsl */`
  attribute float aSize;
  attribute float aLife;   // 0..1 remaining
  varying float vLife;
  void main() {
    vLife = aLife;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(0.1, -mv.z);
    gl_PointSize = aSize * (400.0 / dist);
    if (aLife <= 0.0) gl_PointSize = 0.0;
  }
`;
const FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uColorEnd;
  uniform float uSoft;
  uniform float uOpacity;
  varying float vLife;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = smoothstep(1.0, 1.0 - uSoft, d);
    float fade = smoothstep(0.0, 0.25, vLife) * smoothstep(0.0, 0.35, 1.0 - vLife);
    vec3 col = mix(uColorEnd, uColor, vLife);
    gl_FragColor = vec4(col, a * fade * uOpacity);
  }
`;

export class ParticlePool {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private vel: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private alive = 0;
  private cursor = 0;
  private opts: Required<ParticleOptions>;

  constructor(opts: ParticleOptions) {
    this.opts = {
      colorEnd: opts.color, additive: false, gravity: 0, drag: 0, growth: 1, softness: 0.6, ...opts,
    };
    const n = opts.capacity;
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.maxLife = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(this.opts.color) },
        uColorEnd: { value: new THREE.Color(this.opts.colorEnd) },
        uSoft: { value: this.opts.softness },
        uOpacity: { value: 1 },
      },
      transparent: true, depthWrite: false,
      blending: this.opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  set opacity(v: number) { this.mat.uniforms.uOpacity.value = v; }

  emit(p: THREE.Vector3, v: THREE.Vector3, life: number, size: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.opts.capacity;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = 1; this.maxLife[i] = life; this.baseSize[i] = size; this.size[i] = size;
    this.alive++;
  }

  update(dt: number): void {
    const { gravity, drag, growth, capacity } = this.opts;
    const damp = Math.max(0, 1 - drag * dt);
    let any = false;
    for (let i = 0; i < capacity; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt / this.maxLife[i];
      if (this.life[i] <= 0) { this.life[i] = 0; this.size[i] = 0; continue; }
      const i3 = i * 3;
      this.vel[i3 + 1] += gravity * dt;
      this.vel[i3] *= damp; this.vel[i3 + 1] *= damp; this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - this.life[i];
      this.size[i] = this.baseSize[i] * (1 + (growth - 1) * t);
    }
    if (any) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    }
    this.points.visible = any;
  }

  clear(): void {
    this.life.fill(0); this.size.fill(0);
    (this.geo.attributes.aLife as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = false;
  }

  dispose(): void {
    this.geo.dispose(); this.mat.dispose();
    this.points.removeFromParent();
  }
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

/** Red signal flare + smoke column that rises from the active pad for the whole countdown. */
export class FlareColumn {
  readonly group = new THREE.Group();
  private smoke: ParticlePool;
  private embers: ParticlePool;
  private glow: THREE.PointLight;
  private core: THREE.Mesh;
  private acc = 0;
  private time = 0;
  active = false;

  constructor() {
    this.smoke = new ParticlePool({ capacity: 320, color: 0xb33a2a, colorEnd: 0x3a2a28, gravity: 0.35, drag: 0.4, growth: 3.2, softness: 0.85 });
    this.embers = new ParticlePool({ capacity: 160, color: 0xffb347, colorEnd: 0xff3b1f, additive: true, gravity: -1.2, drag: 0.8, growth: 0.3, softness: 0.5 });
    this.glow = new THREE.PointLight(0xff5a3c, 0, 26, 1.6);
    this.glow.position.y = 0.6;
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.core.position.y = 0.3;
    this.group.add(this.smoke.points, this.embers.points, this.glow, this.core);
    this.group.visible = false;
  }

  start(position: THREE.Vector3): void {
    this.group.position.copy(position);
    this.group.visible = true;
    this.active = true;
    this.glow.intensity = 40;
  }
  stop(): void { this.active = false; }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    if (this.active) {
      this.acc += dt;
      const flicker = 0.85 + 0.15 * Math.sin(this.time * 23) * Math.sin(this.time * 7.3);
      this.glow.intensity = 40 * flicker;
      (this.core.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.3 * flicker;
      this.core.scale.setScalar(0.9 + 0.2 * flicker);
      while (this.acc > 0.02) {
        this.acc -= 0.02;
        _p.set((Math.random() - 0.5) * 0.4, 0.4, (Math.random() - 0.5) * 0.4).add(this.group.position);
        _v.set((Math.random() - 0.5) * 0.9 + Math.sin(this.time * 0.6) * 0.5, 3.2 + Math.random() * 1.8, (Math.random() - 0.5) * 0.9 + Math.cos(this.time * 0.45) * 0.5);
        this.smoke.emit(_p, _v, 4.5 + Math.random() * 2.5, 1.4 + Math.random() * 0.8);
        if (Math.random() < 0.6) {
          _v.set((Math.random() - 0.5) * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3);
          this.embers.emit(_p, _v, 0.5 + Math.random() * 0.8, 0.25 + Math.random() * 0.2);
        }
      }
    } else {
      this.glow.intensity = Math.max(0, this.glow.intensity - dt * 30);
      (this.core.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (this.core.material as THREE.MeshBasicMaterial).opacity - dt);
    }
    this.smoke.update(dt);
    this.embers.update(dt);
    if (!this.active && !this.smoke.points.visible && !this.embers.points.visible) this.group.visible = false;
  }

  reset(): void {
    this.active = false; this.smoke.clear(); this.embers.clear(); this.group.visible = false; this.glow.intensity = 0;
  }

  dispose(): void {
    this.smoke.dispose(); this.embers.dispose();
    this.core.geometry.dispose(); (this.core.material as THREE.Material).dispose();
    this.group.removeFromParent();
  }
}

/** Ground dust ring blown outward by ship thrust while it descends / lifts off. */
export class DustRing {
  readonly pool: ParticlePool;
  private acc = 0;
  constructor() {
    this.pool = new ParticlePool({ capacity: 600, color: 0xb9a48a, colorEnd: 0x6d6255, gravity: -0.6, drag: 1.4, growth: 2.6, softness: 0.9 });
    this.pool.opacity = 0.55;
  }
  /** `strength` 0..1 controls emission rate and speed. */
  emit(center: THREE.Vector3, groundY: number, strength: number, dt: number): void {
    if (strength <= 0) return;
    this.acc += dt * 220 * strength;
    while (this.acc >= 1) {
      this.acc -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 3;
      _p.set(center.x + Math.cos(a) * r, groundY + 0.2, center.z + Math.sin(a) * r);
      const sp = 6 + Math.random() * 8 * strength;
      _v.set(Math.cos(a) * sp, 1.5 + Math.random() * 2.5, Math.sin(a) * sp);
      this.pool.emit(_p, _v, 1.2 + Math.random() * 1.4, 1.2 + Math.random() * 1.2);
    }
  }
  update(dt: number): void { this.pool.update(dt); }
  reset(): void { this.pool.clear(); }
  dispose(): void { this.pool.dispose(); }
}
