import { Random } from '@/shared';

/**
 * Seeded 2D simplex noise + 3D gradient noise with fBm / ridged / domain-warp helpers.
 * Pure functions on typed arrays — no allocations in the hot path.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 2D gradient set (12 directions on the unit circle + axes), flattened.
const GRAD2 = new Float32Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071,
  0.9239, 0.3827, -0.9239, 0.3827, 0.3827, 0.9239, -0.3827, 0.9239,
]);
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class Noise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(seed: number | string | Random) {
    const rng = seed instanceof Random ? seed : new Random(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** 2D simplex noise in [-1, 1]. */
  noise2(x: number, y: number): number {
    const perm = this.perm, pm12 = this.permMod12;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let tt = 0.5 - x0 * x0 - y0 * y0;
    if (tt > 0) {
      const g = pm12[ii + perm[jj]] * 2; tt *= tt;
      n += tt * tt * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }
    tt = 0.5 - x1 * x1 - y1 * y1;
    if (tt > 0) {
      const g = pm12[ii + i1 + perm[jj + j1]] * 2; tt *= tt;
      n += tt * tt * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }
    tt = 0.5 - x2 * x2 - y2 * y2;
    if (tt > 0) {
      const g = pm12[ii + 1 + perm[jj + 1]] * 2; tt *= tt;
      n += tt * tt * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }
    return 70 * n;
  }

  /** 3D gradient (Perlin-style) noise in roughly [-1, 1]. Used for mesh displacement. */
  noise3(x: number, y: number, z: number): number {
    const perm = this.perm, pm12 = this.permMod12;
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[xi] + yi, AA = perm[A] + zi, AB = perm[A + 1] + zi;
    const B = perm[xi + 1] + yi, BA = perm[B] + zi, BB = perm[B + 1] + zi;
    const g = (h: number, dx: number, dy: number, dz: number) => {
      const k = pm12[h] * 3;
      return GRAD3[k] * dx + GRAD3[k + 1] * dy + GRAD3[k + 2] * dz;
    };
    return lerp(w,
      lerp(v, lerp(u, g(AA, x, y, z), g(BA, x - 1, y, z)), lerp(u, g(AB, x, y - 1, z), g(BB, x - 1, y - 1, z))),
      lerp(v, lerp(u, g(AA + 1, x, y, z - 1), g(BA + 1, x - 1, y, z - 1)), lerp(u, g(AB + 1, x, y - 1, z - 1), g(BB + 1, x - 1, y - 1, z - 1))),
    );
  }

  /** Fractal Brownian motion, normalized to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, fx = 1;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise2(x * fx, y * fx) * amp;
      norm += amp;
      amp *= gain; fx *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] — sharp crests, good for rocky ridges. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2.1, gain = 0.5): number {
    let sum = 0, amp = 0.5, norm = 0, fx = 1, weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.noise2(x * fx, y * fx));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain; fx *= lacunarity;
    }
    return sum / norm;
  }

  /** Billowy noise (|n|) in [0,1]; soft rounded blobs. */
  billow(x: number, y: number, octaves = 3): number {
    let sum = 0, amp = 1, norm = 0, fx = 1;
    for (let o = 0; o < octaves; o++) {
      sum += Math.abs(this.noise2(x * fx, y * fx)) * amp;
      norm += amp; amp *= 0.5; fx *= 2;
    }
    return sum / norm;
  }
}

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
