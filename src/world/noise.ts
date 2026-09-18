import { Random } from '@/shared';

/**
 * Seeded 2D simplex noise + 3D gradient noise with fBm / ridged / domain-warp helpers.
 * Pure functions on typed arrays — no allocations in the hot path.
 *
 * 2026-09-11 (C-66): faster while **giving bit-identical values for the same input**. Most of world generation is
 * `noise2` (around 20 calls per vertex), and the old one compiled to ~540 bytes of bytecode — past V8's inlining limit
 * (460), so it made a **real function call per octave** (`--trace-turbo-inlining`: "reason 5 = too big"). So
 *   ① one corner's contribution moved into a small `corner()`, cutting `noise2` to ~350 bytes (it now inlines),
 *   ② `fbm` · `ridged` do not call `noise2` but **unroll the same kernel inside the loop** — a big function holding an
 *      `fbm` (`Terrain`'s height function) would otherwise run out of inlining budget and fall back to a call
 *      per octave,
 *   ③ the gradients, two hops through `GRAD2[permMod12[k] * 2]`, are flattened in the constructor into `gx` · `gy`
 *      (`Float64Array`) — Float32 values copied into doubles, so the value read is the same. `2 * G2` is a module
 *      constant (multiplying by 2 is exact).
 * **Neither the order nor the operands of a floating-point operation changed by one line.** The three kernel copies
 * (`noise2` · `fbm` · `ridged`) must match to the letter: fix all three together, then bit-compare against the old
 * implementation (src/world/README.md `Rules`, C-66). Writing `x0 - 1 + G2` as `x0 + G2 - 1` moves 16,000 of 6,000,000
 * samples by 1 ulp — colliders · layout · multiplayer determinism all rest on this.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const G2x2 = 2 * G2;

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
  /** (C-66) `GRAD2[permMod12[k] * 2]` / `[… + 1]` reached straight by k — the same value (Float32 → double). */
  private readonly gx = new Float64Array(512);
  private readonly gy = new Float64Array(512);

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
      this.gx[i] = GRAD2[this.permMod12[i] * 2];
      this.gy[i] = GRAD2[this.permMod12[i] * 2 + 1];
    }
  }

  /** 2D simplex noise in [-1, 1]. */
  noise2(x: number, y: number): number {
    const perm = this.perm, gx = this.gx, gy = this.gy;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const ii = i & 255, jj = j & 255;
    let n = 0;
    n += corner(gx, gy, ii + perm[jj], x0, y0);
    // (C-66) The old `x0 - i1 + G2` — with i1 = 0, `x0 - 0` is x0 itself, so it is bit-identical to `x0 + G2`
    if (x0 > y0) n += corner(gx, gy, ii + 1 + perm[jj], x0 - 1 + G2, y0 + G2);
    else n += corner(gx, gy, ii + perm[jj + 1], x0 + G2, y0 - 1 + G2);
    n += corner(gx, gy, ii + 1 + perm[jj + 1], x0 - 1 + G2x2, y0 - 1 + G2x2);
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
    /* 2026-09-09 — `lerp` takes `(a, b, t)`. Only here it was fed `(t, a, b)`, so across three levels
     * `w + (a − w) · b` piled up and the result ran **[-31, +52] instead of [-1, 1]** (measured). The one place that
     * reads this value is `build.displace`, so the terrain (`noise2` · `fbm` · `ridged`) was fine, but a few prop
     * vertices were flung 10 units off the origin. It looked like one thin spike and went unnoticed for a long time,
     * until `Props.hullOf` started **building colliders from the bounding box** on 2026-09-09 and that one vertex
     * became an invisible cylinder of radius 10 m · height 20 m around the whole prop — the one nobody could walk
     * past and bullets stopped in mid-air at. (C-66) This was left alone — it is called 1/100 as often as `noise2`,
     * and pulling the closure `g` out into a module function measured no faster (V8 already inlines it away). */
    const g = (h: number, dx: number, dy: number, dz: number) => {
      const k = pm12[h] * 3;
      return GRAD3[k] * dx + GRAD3[k + 1] * dy + GRAD3[k + 2] * dz;
    };
    return lerp(
      lerp(lerp(g(AA, x, y, z), g(BA, x - 1, y, z), u), lerp(g(AB, x, y - 1, z), g(BB, x - 1, y - 1, z), u), v),
      lerp(lerp(g(AA + 1, x, y, z - 1), g(BA + 1, x - 1, y, z - 1), u), lerp(g(AB + 1, x, y - 1, z - 1), g(BB + 1, x - 1, y - 1, z - 1), u), v),
      w,
    );
  }

  /** Fractal Brownian motion, normalized to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    const perm = this.perm, gx = this.gx, gy = this.gy;
    let sum = 0, amp = 1, norm = 0, fx = 1;
    for (let o = 0; o < octaves; o++) {
      const px = x * fx, py = y * fx;
      // ── noise2(px, py) — kernel copy (C-66, the header comment above) ──
      const s = (px + py) * F2;
      const i = Math.floor(px + s), j = Math.floor(py + s);
      const t = (i + j) * G2;
      const x0 = px - (i - t), y0 = py - (j - t);
      const ii = i & 255, jj = j & 255;
      let n = 0;
      n += corner(gx, gy, ii + perm[jj], x0, y0);
      if (x0 > y0) n += corner(gx, gy, ii + 1 + perm[jj], x0 - 1 + G2, y0 + G2);
      else n += corner(gx, gy, ii + perm[jj + 1], x0 + G2, y0 - 1 + G2);
      n += corner(gx, gy, ii + 1 + perm[jj + 1], x0 - 1 + G2x2, y0 - 1 + G2x2);
      // ──
      sum += 70 * n * amp;
      norm += amp;
      amp *= gain; fx *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] — sharp crests, good for rocky ridges. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2.1, gain = 0.5): number {
    const perm = this.perm, gx = this.gx, gy = this.gy;
    let sum = 0, amp = 0.5, norm = 0, fx = 1, weight = 1;
    for (let o = 0; o < octaves; o++) {
      const px = x * fx, py = y * fx;
      // ── noise2(px, py) — kernel copy (C-66, the header comment above) ──
      const s = (px + py) * F2;
      const i = Math.floor(px + s), j = Math.floor(py + s);
      const t = (i + j) * G2;
      const x0 = px - (i - t), y0 = py - (j - t);
      const ii = i & 255, jj = j & 255;
      let c = 0;
      c += corner(gx, gy, ii + perm[jj], x0, y0);
      if (x0 > y0) c += corner(gx, gy, ii + 1 + perm[jj], x0 - 1 + G2, y0 + G2);
      else c += corner(gx, gy, ii + perm[jj + 1], x0 + G2, y0 - 1 + G2);
      c += corner(gx, gy, ii + 1 + perm[jj + 1], x0 - 1 + G2x2, y0 - 1 + G2x2);
      // ──
      let n = 1 - Math.abs(70 * c);
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

/**
 * (C-66) One simplex corner's contribution. The old `if (tt > 0) { tt *= tt; n += tt * tt * (…) }` moved here as it
 * was, returning +0 for no contribution — the receiving `n` starts at `0 + …` and can never be −0, so `n += 0` leaves
 * n alone. The `tt > 0` comparison is kept so that NaN still goes to "no contribution" exactly as before.
 */
function corner(gx: Float64Array, gy: Float64Array, k: number, x: number, y: number): number {
  let tt = 0.5 - x * x - y * y;
  if (tt > 0) {
    tt *= tt;
    return tt * tt * (gx[k] * x + gy[k] * y);
  }
  return 0;
}

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
