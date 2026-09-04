import * as THREE from 'three';

/**
 * Pooled camera-facing quads for bullet tracers / beams. Each tracer is a bright streak that
 * fades over its lifetime. Geometry is rebuilt on the CPU every frame (few tracers alive).
 */
interface Tracer {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  r: number; g: number; b: number;
  width: number;
  life: number; maxLife: number;
  /** 0..1 how far along the streak the visible head has travelled (for a moving streak) */
  speed: number; // units/sec; 0 = full segment visible
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3(), _toCam = new THREE.Vector3(), _side = new THREE.Vector3();

export class TracerPool {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private readonly tracers: Tracer[] = [];
  private readonly free: Tracer[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(capacity = 96) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 4 * 3);
    this.col = new Float32Array(capacity * 4 * 3);
    const idx = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    this.mesh.matrixAutoUpdate = false;
    for (let i = 0; i < capacity; i++) {
      this.free.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 1, g: 1, b: 1, width: 0.03, life: 0, maxLife: 0.06, speed: 0 });
    }
  }

  /**
   * @param color hex
   * @param life seconds
   * @param speed if > 0 the streak travels from a→b at this speed (m/s) with a fixed streak length; 0 draws the whole segment
   */
  add(a: THREE.Vector3, b: THREE.Vector3, color: number, width = 0.035, life = 0.07, speed = 0): void {
    let t = this.free.pop();
    if (!t) { t = this.tracers.shift()!; }
    t.ax = a.x; t.ay = a.y; t.az = a.z; t.bx = b.x; t.by = b.y; t.bz = b.z;
    t.r = ((color >> 16) & 255) / 255; t.g = ((color >> 8) & 255) / 255; t.b = (color & 255) / 255;
    t.width = width; t.life = life; t.maxLife = life; t.speed = speed;
    this.tracers.push(t);
  }

  clear(): void {
    while (this.tracers.length) this.free.push(this.tracers.pop()!);
    this.geometry.setDrawRange(0, 0);
  }

  update(dt: number, camera: THREE.Camera): void {
    const list = this.tracers;
    let write = 0;
    const camPos = camera.position;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      t.life -= dt;
      if (t.life <= 0) { this.free.push(t); continue; }
      list[write++] = t;
      const age = 1 - t.life / t.maxLife;
      _a.set(t.ax, t.ay, t.az); _b.set(t.bx, t.by, t.bz);
      _dir.subVectors(_b, _a);
      const segLen = _dir.length();
      if (segLen < 1e-4) { _dir.set(0, 0, 1); } else { _dir.multiplyScalar(1 / segLen); }
      if (t.speed > 0) {
        // moving streak: head travels along the segment, tail lags by streak length
        const travelled = (t.maxLife - t.life) * t.speed;
        const head = Math.min(segLen, travelled);
        const tail = Math.max(0, head - Math.min(segLen, 6 + t.speed * 0.02));
        _b.copy(_a).addScaledVector(_dir, head);
        _a.addScaledVector(_dir, tail);
      }
      _toCam.subVectors(camPos, _a);
      _side.crossVectors(_dir, _toCam).normalize();
      const fade = (1 - age) * (1 - age);
      const w = t.width * (0.6 + 0.4 * (1 - age));
      _side.multiplyScalar(w * 0.5);
      const o = (write - 1) * 12;
      const p = this.pos, c = this.col;
      // quad: a-side, a+side, b+side, b-side
      p[o] = _a.x - _side.x; p[o + 1] = _a.y - _side.y; p[o + 2] = _a.z - _side.z;
      p[o + 3] = _a.x + _side.x; p[o + 4] = _a.y + _side.y; p[o + 5] = _a.z + _side.z;
      p[o + 6] = _b.x + _side.x; p[o + 7] = _b.y + _side.y; p[o + 8] = _b.z + _side.z;
      p[o + 9] = _b.x - _side.x; p[o + 10] = _b.y - _side.y; p[o + 11] = _b.z - _side.z;
      // tail dimmer than head for a sense of direction
      const tailF = fade * 0.35, headF = fade * 1.6;
      c[o] = t.r * tailF; c[o + 1] = t.g * tailF; c[o + 2] = t.b * tailF;
      c[o + 3] = t.r * tailF; c[o + 4] = t.g * tailF; c[o + 5] = t.b * tailF;
      c[o + 6] = t.r * headF; c[o + 7] = t.g * headF; c[o + 8] = t.b * headF;
      c[o + 9] = t.r * headF; c[o + 10] = t.g * headF; c[o + 11] = t.b * headF;
    }
    list.length = write;
    this.geometry.setDrawRange(0, write * 6);
    if (write > 0 || this.lastWrite > 0) {
      (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
    this.lastWrite = write;
  }
  private lastWrite = 0;

  dispose(): void { this.geometry.dispose(); this.material.dispose(); }
}
