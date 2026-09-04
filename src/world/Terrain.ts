import * as THREE from 'three';
import { Layers, MAP_SIZE, Random } from '@/shared';
import type { Biome } from './biomes';
import type { WorldLayout } from './layout';
import { Noise, clamp, lerp, smoothstep } from './noise';

/* Grid constants ─────────────────────────────────────────────────────────── */
export const HALF = MAP_SIZE / 2;
/** Terrain extends this far beyond the playable area for the border mountains. */
export const BORDER = 96;
export const EXTENT = HALF + BORDER;            // 416
export const CELL = 2;                          // meters between vertices
export const CHUNKS = 8;
export const CELLS = (EXTENT * 2) / CELL;       // 416 cells per side
export const CHUNK_CELLS = CELLS / CHUNKS;      // 52
export const VERTS = CELLS + 1;                 // 417 verts per side

export const HEIGHT_MIN = -6;
export const HEIGHT_MAX = 40;

/** Heightfield + chunked mesh + fast analytic queries. */
export class Terrain {
  readonly heights = new Float32Array(VERTS * VERTS);
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private material: THREE.MeshStandardMaterial | null = null;
  private textures: THREE.Texture[] = [];
  private nestPositions: { x: number; z: number }[] = [];

  private readonly heightFn = (x: number, z: number) => this.getHeightAt(x, z);

  constructor() {
    this.group.name = 'Terrain';
  }

  /* ── generation ─────────────────────────────────────────────────────── */

  build(layout: WorldLayout, biome: Biome, noise: Noise, rng: Random): void {
    const t0 = performance.now();
    this.nestPositions = layout.nests.map((p) => ({ x: p.x, z: p.z }));
    const raw = this.makeRawHeightFn(layout, noise);

    // Pads take the raw height at their center (clamped to comfortable range)
    for (const p of layout.pads) p.height = clamp(raw(p.x, p.z), -1.5, 26);

    const pads = layout.pads;
    const H = this.heights;
    for (let j = 0; j < VERTS; j++) {
      const z = -EXTENT + j * CELL;
      for (let i = 0; i < VERTS; i++) {
        const x = -EXTENT + i * CELL;
        let h = raw(x, z);
        // pad flattening
        for (let k = 0; k < pads.length; k++) {
          const p = pads[k];
          const dx = x - p.x, dz = z - p.z;
          const r2 = (p.radius + p.blend);
          if (dx * dx + dz * dz > r2 * r2) continue;
          const d = Math.sqrt(dx * dx + dz * dz);
          const t = smoothstep(p.radius, p.radius + p.blend, d);
          h = lerp(p.height, h, t);
        }
        H[j * VERTS + i] = h;
      }
    }
    const t1 = performance.now();
    this.buildMeshes(biome, noise, layout, rng);
    const t2 = performance.now();
    if (import.meta.env?.DEV) console.debug(`[Terrain] heightfield ${(t1 - t0).toFixed(0)} ms, mesh ${(t2 - t1).toFixed(0)} ms`);
  }

  private makeRawHeightFn(layout: WorldLayout, noise: Noise): (x: number, z: number) => number {
    const craters = layout.craters, basins = layout.basins;
    return (x: number, z: number): number => {
      // domain warp for organic large-scale shapes
      const wx = x + 38 * noise.fbm(x * 0.0042 + 7.1, z * 0.0042 - 2.3, 3);
      const wz = z + 38 * noise.fbm(x * 0.0042 - 4.7, z * 0.0042 + 3.9, 3);
      const base = noise.fbm(wx * 0.0034, wz * 0.0034, 5, 2.05, 0.5) * 13;
      const hills = noise.fbm(x * 0.013 + 31, z * 0.013 - 17, 3) * 2.4;
      const detail = noise.noise2(x * 0.06, z * 0.06) * 0.35;
      const ridgeMask = smoothstep(0.12, 0.62, noise.fbm(x * 0.0026 + 11.3, z * 0.0026 + 5.7, 2) + 0.15);
      const ridge = noise.ridged(wx * 0.0075, wz * 0.0075, 4);
      let h = 7 + base + hills + detail + ridgeMask * ridge * 27;

      // craters: bowl + raised rim
      for (let k = 0; k < craters.length; k++) {
        const c = craters[k];
        const dx = x - c.x, dz = z - c.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const outer = c.radius * 1.5;
        if (d >= outer) continue;
        const inner = 1 - smoothstep(0, c.radius * 0.9, d);
        const bowl = -c.depth * inner * inner;
        const rimT = 1 - Math.abs(d - c.radius) / (c.radius * 0.5);
        const rim = rimT > 0 ? c.depth * 0.38 * rimT * rimT : 0;
        h += bowl + rim;
      }
      // basins: broad gentle depressions
      for (let k = 0; k < basins.length; k++) {
        const b = basins[k];
        const dx = x - b.x, dz = z - b.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= b.radius) continue;
        h -= b.depth * (1 - smoothstep(0, b.radius, d));
      }

      // soft clamp to range
      if (h > HEIGHT_MAX - 6) h = HEIGHT_MAX - 6 + (h - (HEIGHT_MAX - 6)) * 0.35;
      if (h < HEIGHT_MIN + 2) h = HEIGHT_MIN + 2 + (h - (HEIGHT_MIN + 2)) * 0.4;

      // border mountains beyond the playable square
      const cheb = Math.max(Math.abs(x), Math.abs(z));
      const eucl = Math.sqrt(x * x + z * z) * 0.7071;
      const edge = lerp(cheb, eucl, 0.25) - HALF;
      if (edge > -14) {
        const t = smoothstep(-14, 70, edge);
        const wall = t * t * 62 + t * noise.ridged(x * 0.02 + 3, z * 0.02 - 9, 3) * 22 + t * noise.fbm(x * 0.05, z * 0.05, 2) * 4;
        // lift low ground near the wall so the cliff base never dips below the plain
        h = lerp(h, Math.max(h, 4), smoothstep(0, 30, edge)) + wall;
      }
      return h;
    };
  }

  /* ── mesh ──────────────────────────────────────────────────────────── */

  private buildMeshes(biome: Biome, noise: Noise, layout: WorldLayout, rng: Random): void {
    const H = this.heights;
    // normals (central differences)
    const normals = new Float32Array(VERTS * VERTS * 3);
    const inv2 = 1 / (2 * CELL);
    for (let j = 0; j < VERTS; j++) {
      const jm = Math.max(0, j - 1), jp = Math.min(VERTS - 1, j + 1);
      for (let i = 0; i < VERTS; i++) {
        const im = Math.max(0, i - 1), ip = Math.min(VERTS - 1, i + 1);
        const dx = (H[j * VERTS + im] - H[j * VERTS + ip]) * inv2;
        const dz = (H[jm * VERTS + i] - H[jp * VERTS + i]) * inv2;
        const len = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
        const o = (j * VERTS + i) * 3;
        normals[o] = dx * len; normals[o + 1] = len; normals[o + 2] = dz * len;
      }
    }

    // colors
    const colors = new Float32Array(VERTS * VERTS * 3);
    this.computeColors(biome, noise, layout, normals, colors);

    // material with procedural detail textures
    const detail = makeDetailTexture(rng.fork('detail'));
    const detailNormal = makeDetailNormalTexture(rng.fork('detailN'));
    this.textures.push(detail, detailNormal);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
      map: detail,
      normalMap: detailNormal,
      normalScale: new THREE.Vector2(0.45, 0.45),
    });
    this.material = material;

    const n = CHUNK_CELLS + 1;
    const uvScale = 1 / 7;
    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        const i0 = ci * CHUNK_CELLS, j0 = cj * CHUNK_CELLS;
        const pos = new Float32Array(n * n * 3);
        const nor = new Float32Array(n * n * 3);
        const col = new Float32Array(n * n * 3);
        const uv = new Float32Array(n * n * 2);
        let v = 0;
        for (let j = 0; j < n; j++) {
          const gj = j0 + j;
          const z = -EXTENT + gj * CELL;
          for (let i = 0; i < n; i++) {
            const gi = i0 + i;
            const x = -EXTENT + gi * CELL;
            const g = gj * VERTS + gi;
            pos[v * 3] = x; pos[v * 3 + 1] = H[g]; pos[v * 3 + 2] = z;
            nor[v * 3] = normals[g * 3]; nor[v * 3 + 1] = normals[g * 3 + 1]; nor[v * 3 + 2] = normals[g * 3 + 2];
            col[v * 3] = colors[g * 3]; col[v * 3 + 1] = colors[g * 3 + 1]; col[v * 3 + 2] = colors[g * 3 + 2];
            uv[v * 2] = x * uvScale; uv[v * 2 + 1] = z * uvScale;
            v++;
          }
        }
        const idx = new Uint16Array(CHUNK_CELLS * CHUNK_CELLS * 6);
        let q = 0;
        for (let j = 0; j < CHUNK_CELLS; j++) {
          for (let i = 0; i < CHUNK_CELLS; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            // alternate diagonal for a more natural triangulation
            if ((i + j) & 1) {
              idx[q++] = a; idx[q++] = c; idx[q++] = b;
              idx[q++] = b; idx[q++] = c; idx[q++] = d;
            } else {
              idx[q++] = a; idx[q++] = c; idx[q++] = d;
              idx[q++] = a; idx[q++] = d; idx[q++] = b;
            }
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.layers.enable(Layers.TERRAIN);
        mesh.name = `terrain_${ci}_${cj}`;
        this.meshes.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  private computeColors(biome: Biome, noise: Noise, layout: WorldLayout, normals: Float32Array, out: Float32Array): void {
    const H = this.heights;
    const low = biome.low, ground = biome.ground, ground2 = biome.ground2, rock = biome.rock, high = biome.high, cliff = biome.cliff, goo = biome.nestGoo;
    const nests = this.nestPositions;
    const craters = layout.craters;
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < VERTS; j++) {
      const z = -EXTENT + j * CELL;
      const jm = Math.max(0, j - 2), jp = Math.min(VERTS - 1, j + 2);
      for (let i = 0; i < VERTS; i++) {
        const x = -EXTENT + i * CELL;
        const gi = j * VERTS + i;
        const h = H[gi];
        const ny = normals[gi * 3 + 1];
        const slope = 1 - ny;
        const im = Math.max(0, i - 2), ip = Math.min(VERTS - 1, i + 2);
        // local concavity → cheap ambient occlusion
        const avg = (H[j * VERTS + im] + H[j * VERTS + ip] + H[jm * VERTS + i] + H[jp * VERTS + i]) * 0.25;
        const concave = clamp((avg - h) * 0.2, 0, 0.22);

        const n1 = noise.fbm(x * 0.045 + 3, z * 0.045 - 8, 2);       // ground variation
        const n2 = noise.noise2(x * 0.16, z * 0.16);                  // fine speckle

        // base ground with variation
        const gv = smoothstep(-0.25, 0.35, n1);
        r = lerp(ground.r, ground2.r, gv); g = lerp(ground.g, ground2.g, gv); b = lerp(ground.b, ground2.b, gv);

        // low band
        const lowT = 1 - smoothstep(biome.lowLevel - 1.5 + n1 * 1.5, biome.lowLevel + 2.5 + n1 * 1.5, h);
        r = lerp(r, low.r, lowT); g = lerp(g, low.g, lowT); b = lerp(b, low.b, lowT);

        // high band
        const highT = smoothstep(biome.highLevel - 4 + n1 * 3, biome.highLevel + 3 + n1 * 3, h) * (1 - smoothstep(0.35, 0.6, slope));
        r = lerp(r, high.r, highT); g = lerp(g, high.g, highT); b = lerp(b, high.b, highT);

        // rock on slopes
        const rockT = smoothstep(0.18 + n2 * 0.05, 0.42, slope);
        r = lerp(r, rock.r, rockT); g = lerp(g, rock.g, rockT); b = lerp(b, rock.b, rockT);

        // border cliffs
        const cheb = Math.max(Math.abs(x), Math.abs(z));
        const cliffT = smoothstep(HALF - 4, HALF + 40, cheb) * (0.5 + 0.5 * smoothstep(0.1, 0.4, slope));
        r = lerp(r, cliff.r, cliffT); g = lerp(g, cliff.g, cliffT); b = lerp(b, cliff.b, cliffT);

        // crater floors: scorched
        for (let k = 0; k < craters.length; k++) {
          const c = craters[k];
          const dx = x - c.x, dz = z - c.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > c.radius * c.radius) continue;
          const t = (1 - smoothstep(c.radius * 0.35, c.radius, Math.sqrt(d2))) * 0.55;
          r = lerp(r, 0.10, t); g = lerp(g, 0.09, t); b = lerp(b, 0.085, t);
        }
        // nest goo
        for (let k = 0; k < nests.length; k++) {
          const dx = x - nests[k].x, dz = z - nests[k].z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 30 * 30) continue;
          const t = (1 - smoothstep(6, 30, Math.sqrt(d2))) * (0.75 + n2 * 0.25);
          r = lerp(r, goo.r, t); g = lerp(g, goo.g, t); b = lerp(b, goo.b, t);
        }

        // speckle + AO
        const shade = (1 + n2 * 0.07) * (1 - concave);
        out[gi * 3] = clamp(r * shade, 0, 1);
        out[gi * 3 + 1] = clamp(g * shade, 0, 1);
        out[gi * 3 + 2] = clamp(b * shade, 0, 1);
      }
    }
  }

  /* ── queries ───────────────────────────────────────────────────────── */

  getHeightAt(x: number, z: number): number {
    const fx = (x + EXTENT) / CELL, fz = (z + EXTENT) / CELL;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > VERTS - 2) i = VERTS - 2;
    if (j < 0) j = 0; else if (j > VERTS - 2) j = VERTS - 2;
    let tx = fx - i, tz = fz - j;
    if (tx < 0) tx = 0; else if (tx > 1) tx = 1;
    if (tz < 0) tz = 0; else if (tz > 1) tz = 1;
    const H = this.heights;
    const o = j * VERTS + i;
    const h00 = H[o], h10 = H[o + 1], h01 = H[o + VERTS], h11 = H[o + VERTS + 1];
    // match triangulation approximately with bilinear (visually indistinguishable for 2 m cells)
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  getNormalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.6;
    const hl = this.getHeightAt(x - e, z), hr = this.getHeightAt(x + e, z);
    const hd = this.getHeightAt(x, z - e), hu = this.getHeightAt(x, z + e);
    out.set((hl - hr) / (2 * e), 1, (hd - hu) / (2 * e));
    return out.normalize();
  }

  /** Slope as 1 - normal.y (0 flat … 1 vertical). */
  getSlopeAt(x: number, z: number): number {
    const e = 0.8;
    const dx = (this.getHeightAt(x - e, z) - this.getHeightAt(x + e, z)) / (2 * e);
    const dz = (this.getHeightAt(x, z - e) - this.getHeightAt(x, z + e)) / (2 * e);
    return 1 - 1 / Math.sqrt(dx * dx + 1 + dz * dz);
  }

  /**
   * Ray-march against the heightfield. Returns hit distance or -1.
   * Adaptive step proportional to height above ground, refined by bisection.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, heightFn?: (x: number, z: number) => number): number {
    const hAt = heightFn ?? this.heightFn;
    let t = 0;
    let prevT = 0;
    let diff = oy - hAt(ox, oz);
    if (diff <= 0) return -1; // started underground
    // rays going up above the max terrain height can never hit
    if (dy >= 0 && oy > HEIGHT_MAX + 80) return -1;
    let iter = 0;
    while (t < maxDist && iter < 400) {
      iter++;
      let step = diff * 0.7;
      if (step < 0.35) step = 0.35; else if (step > 6) step = 6;
      prevT = t;
      t += step;
      if (t > maxDist) t = maxDist;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      diff = py - hAt(px, pz);
      if (diff <= 0) {
        // bisection refine between prevT (above) and t (below)
        let lo = prevT, hi = t;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = ox + dx * mid, my = oy + dy * mid, mz = oz + dz * mid;
          if (my - hAt(mx, mz) <= 0) hi = mid; else lo = mid;
        }
        return hi;
      }
      if (t >= maxDist) break;
      // early exit: flying upward and already far above the max height
      if (dy > 0 && py > HEIGHT_MAX + 80) return -1;
    }
    return -1;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.length = 0;
    this.material?.dispose();
    this.material = null;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
  }
}

/* ── procedural detail textures ─────────────────────────────────────────── */

function makeDetailTexture(rng: Random): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const noise = new Noise(rng);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // tileable via 4-corner blend on a torus
      const u = x / size, v = y / size;
      const n = tileableNoise(noise, u, v, 6) * 0.5 + tileableNoise(noise, u, v, 18) * 0.35 + tileableNoise(noise, u, v, 48) * 0.15;
      const val = clamp(0.93 + n * 0.12, 0.7, 1);
      const o = (y * size + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = Math.round(val * 255);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function makeDetailNormalTexture(rng: Random): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const noise = new Noise(rng);
  const hmap = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    hmap[y * size + x] = tileableNoise(noise, u, v, 8) * 0.6 + tileableNoise(noise, u, v, 24) * 0.3 + tileableNoise(noise, u, v, 64) * 0.1;
  }
  const d = img.data;
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = hmap[y * size + ((x - 1 + size) % size)], r = hmap[y * size + ((x + 1) % size)];
      const u = hmap[((y - 1 + size) % size) * size + x], dn = hmap[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      d[o] = Math.round((nx * 0.5 + 0.5) * 255);
      d[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      d[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Sample 2D noise on a torus so the result tiles seamlessly. */
function tileableNoise(noise: Noise, u: number, v: number, freq: number): number {
  const a = u * Math.PI * 2, b = v * Math.PI * 2;
  const r = freq / (Math.PI * 2);
  // 4D torus embedding approximated with two 2D samples
  const nx = Math.cos(a) * r, ny = Math.sin(a) * r, nz = Math.cos(b) * r, nw = Math.sin(b) * r;
  return (noise.noise2(nx + nz * 0.7, ny + nw * 0.7) + noise.noise2(nz - nx * 0.7 + 31, nw - ny * 0.7 - 17)) * 0.5;
}
