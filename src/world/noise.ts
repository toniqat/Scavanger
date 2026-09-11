import { Random } from '@/shared';

/**
 * Seeded 2D simplex noise + 3D gradient noise with fBm / ridged / domain-warp helpers.
 * Pure functions on typed arrays — no allocations in the hot path.
 *
 * 2026-09-11 (C-66): **같은 입력이면 예전과 비트 단위로 같은 값**을 내면서 빨라졌다. 월드 생성의 대부분이 `noise2`
 * (정점마다 20번 안팎)인데, 예전 `noise2` 는 바이트코드가 약 540 바이트라 V8 의 인라인 한도(460)를 넘어 **옥타브마다
 * 진짜 함수 호출**을 했다 (`--trace-turbo-inlining`: "reason 5 = too big"). 그래서
 *   ① 모서리 하나의 기여를 작은 `corner()` 로 떼어 `noise2` 를 약 350 바이트로 줄였고 (이제 호출부에 인라인된다),
 *   ② `fbm` · `ridged` 는 `noise2` 를 부르지 않고 **같은 커널을 루프 안에 풀어 쓴다** — `fbm` 을 품은 큰 함수
 *      (`Terrain` 의 높이 함수)에서 인라인 예산이 바닥나 옥타브마다 다시 호출로 떨어지는 일을 막는다.
 *   ③ 기울기는 `GRAD2[permMod12[k] * 2]` 두 번 건너뛰던 것을 생성자에서 `gx` · `gy`(Float64Array)로 펴 뒀다 —
 *      Float32 값을 double 로 옮겨 적은 것이라 읽히는 값이 같다. `2 * G2` 는 모듈 상수(2 곱은 정확하다).
 * **부동소수 연산의 순서와 피연산자는 한 줄도 바꾸지 않았다.** 커널 세 벌(`noise2` · `fbm` · `ridged`)은 글자까지
 * 같아야 하고, 고칠 때는 셋을 함께 고친 뒤 옛 구현과 비트 비교를 돌린다 (src/world/README.md 의 C-66 절). 예:
 * `x0 - 1 + G2` 를 `x0 + G2 - 1` 로 바꾸면 600만 표본 중 1.6만 개가 1 ulp 씩 달라진다 — 콜라이더 · 레이아웃 · 멀티
 * 결정성이 전부 여기 기댄다.
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
  /** (C-66) `GRAD2[permMod12[k] * 2]` / `[… + 1]` 를 k 로 바로 — 같은 값 (Float32 → double). */
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
    // (C-66) 예전 `x0 - i1 + G2` — i1 = 0 이면 `x0 - 0` 은 x0 그 자체라 `x0 + G2` 와 같은 비트다
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
    /* 2026-09-09 — `lerp` 는 `(a, b, t)` 다. 여기서만 `(t, a, b)` 로 넣고 있어서 세 겹을 거치는 동안
     * `w + (a − w) · b` 가 쌓였고, 결과가 **[-1, 1] 이 아니라 [-31, +52]** 였다 (측정값). 이 값을 쓰는 곳은
     * `build.displace` 하나뿐이라 지형(`noise2` · `fbm` · `ridged`)은 멀쩡했지만, 소품 정점 몇 개가 원점에서
     * 10 units 씩 튕겨 나갔다. 눈에는 가는 가시 하나로 보여서 오래 지나쳤는데, 2026-09-09 에 `Props.hullOf`
     * 가 **바운딩 박스로 콜라이더를 만들기** 시작하면서 그 정점 하나가 소품 전체를 감싸는 반지름 10 m ·
     * 높이 20 m 짜리 보이지 않는 원기둥이 됐다 — 걸어서 못 지나가고 총알이 허공에서 멈추던 그것이다.
     * (C-66) 여기는 손대지 않았다 — 호출 수가 `noise2` 의 1/100 이고, 클로저 `g` 를 모듈 함수로 빼 재 보니
     * 소품 단계가 빨라지지 않았다 (V8 이 이미 이 클로저를 인라인 · escape 분석으로 없앤다). */
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
      // ── noise2(px, py) — 커널 사본 (C-66, 위 머리 주석) ──
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
      // ── noise2(px, py) — 커널 사본 (C-66, 위 머리 주석) ──
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
 * (C-66) simplex 모서리 하나의 기여. 예전 `if (tt > 0) { tt *= tt; n += tt * tt * (…) }` 를 그대로 옮겼고, 기여가
 * 없으면 +0 을 돌려준다 — 받는 쪽 `n` 은 `0 + …` 로 시작해 −0 이 될 수 없으므로 `n += 0` 은 n 을 바꾸지 않는다.
 * `tt > 0` 비교를 그대로 둔 것은 NaN 도 예전처럼 "기여 없음" 으로 가게 하려는 것이다.
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
