import * as THREE from 'three';
import { Layers } from '@/shared';
import type { Random } from '@/shared';
import { type BuildCtx, composeMatrix, displace, isSpotFree, merge, paint, paintGradient, scratch, xform } from './build';
import { HALF } from './Terrain';
import { smoothstep } from './noise';
import { propHullOf } from './propHull';

interface Part { geo: THREE.BufferGeometry; mat: THREE.Material; castShadow: boolean; receiveShadow: boolean }
interface Variant {
  parts: Part[];
  meshes: THREE.InstancedMesh[];
  count: number;
  max: number;
}

interface ScatterOpts {
  count: number;              // target attempts (jittered grid)
  limit: number;              // half-extent of scatter region
  clusterFreq: number;        // 0 → uniform
  clusterBias: number;        // higher → more accepted
}

/**
 * Drawn extents of a finished variant geometry, in the units the instance matrix scales: `xz` is the mean of the
 * X and Z half-widths (the mesh is randomly yawed, so neither axis alone is the silhouette a bullet meets) and `y` is
 * **how far the mesh reaches above its own origin**. Used for `Obstacle.shotRadius / shotHeight` — see
 * `WorldSystem.rayCylinder`.
 *
 * 2026-09-09: `y` used to be `max(|min.y|, |max.y|)` — the taller of the two vertical halves. For anything centred
 * that is the same number, but the **pod shell** (a hemisphere rotated nose-down: `min.y ≈ −1`, `max.y ≈ 0.4`) got a
 * cylinder ~1.2 m taller than the drawn shell, i.e. bullets stopped in the air above it. The callers all add this to
 * the instance origin, so the top is what they want.
 *
 * ⚠ 이 값은 **콜라이더가 된다.** 소품 지오메트리를 손보면 튀어나간 정점 하나가 그대로 보이지 않는 벽이 된다
 * (2026-09-09 `noise.ts` 사건). `scripts/smoke-props-collision.mjs` 가 그걸 숫자로 잡는다.
 */
function hullOf(geo: THREE.BufferGeometry): { xz: number; y: number } {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return { xz: 1, y: 1 };
  const hx = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
  const hz = Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z));
  return { xz: (hx + hz) / 2, y: Math.max(0, bb.max.y) };
}

/**
 * Scattered instanced props: boulders, spires, trees, crystals, grass, debris.
 * Collidable props register obstacles in the spatial hash.
 */
export class Props {
  readonly group = new THREE.Group();
  private variants: Variant[] = [];
  private materials: THREE.Material[] = [];
  private crystalMat: THREE.MeshStandardMaterial | null = null;
  private canopyMat: THREE.MeshStandardMaterial | null = null;
  private readonly timeUniform = { value: 0 };

  constructor() { this.group.name = 'Props'; }

  /* ── build ──────────────────────────────────────────────────────────── */

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('props');
    const b = ctx.biome;

    const rockMat = this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.02, flatShading: true }));
    const debrisMat = this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.65 }));
    const trunkMat = this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0 }));
    this.canopyMat = this.mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.75, metalness: 0.0,
      emissive: b.canopyEmissive, emissiveIntensity: 0.5,
    })) as THREE.MeshStandardMaterial;
    this.crystalMat = this.mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.22, metalness: 0.05, flatShading: true,
      emissive: b.crystalEmissive, emissiveIntensity: 0.9,
    })) as THREE.MeshStandardMaterial;
    const grassMat = this.mat(this.makeGrassMaterial());

    /* Boulders — 4 variants, also allowed on the border slopes */
    const boulders = [0, 1, 2, 3].map((k) => {
      const g = new THREE.IcosahedronGeometry(1, 2);
      displace(g, ctx.noise, 0.28 + k * 0.05, 1.1 + k * 0.3, k * 13.7);
      xform(g, undefined, undefined, { x: 1 + k * 0.1, y: 0.68 + k * 0.06, z: 0.9 });
      paintGradient(g, b.boulder.clone().multiplyScalar(0.7), k % 2 ? b.boulder : b.boulder2);
      return g;
    });
    const boulderVar = boulders.map((g) => this.variant([{ geo: g, mat: rockMat, castShadow: true, receiveShadow: true }], 700, 'boulder'));
    this.scatter(ctx, rng, { count: Math.round(1000 * b.boulderDensity), limit: HALF + 70, clusterFreq: 0.012, clusterBias: 0.15 }, (x, z) => {
      const outside = Math.abs(x) > HALF - 6 || Math.abs(z) > HALF - 6;
      const s = outside ? rng.range(2.5, 7.5) : (rng.chance(0.12) ? rng.range(3.2, 5.5) : rng.range(1.0, 2.8));
      if (!isSpotFree(ctx, x, z, s * 0.9, { maxSlope: outside ? 0.85 : 0.5, limit: HALF + 80, padExtra: 3 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - s * 0.28;
      const vi = rng.int(0, boulderVar.length - 1);
      const v = boulderVar[vi];
      const sy = s * rng.range(0.8, 1.15);
      // `composeMatrix` 는 공유 스크래치를 돌려준다 — `place` 는 복사만 하므로 바로 아래 실측에 그대로 쓴다
      const m = composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25), rng.range(-0.25, 0.25), s, sy, s);
      this.place(v, m, rng.range(0.85, 1.1));
      if (!outside || Math.abs(x) < HALF + 6 && Math.abs(z) < HALF + 6) {
        // 2026-09-09 (지형지물 위 걷기): 총알과 발이 같은 원기둥을 본다 — 낮은 바위는 `PROP_STEP_UP_MAX` 안이라
        // 걸어 올라가진다. 2026-09-10: 그 원기둥을 메시 전체(`hullOf`)가 아니라 **땅 위로 보이는 부분**에서 잰다
        // (`footprintOf` — 묻힌 적도 · 경사지 옆구리 · 튀어나온 정점 하나가 보이지 않는 벽을 세우던 것).
        // 2026-09-11: 원 하나(방위 평균 반지름)가 아니라 **볼록 윤곽**이다 (`propHull.ts`) — 길쭉한 바위의 긴 쪽으로
        // 파고들지도, 짧은 쪽에서 앞서 막지도 않는다. 총알은 높이별 층 윤곽을 본다.
        const pc = propHullOf(ctx, boulders[vi], m);
        if (pc) ctx.hash.addHull(new THREE.Vector3(pc.x, y, pc.z), pc.hull, Math.max(0.05, pc.top - y), 'rock');
      }
    });

    /* Rock spires — tall jagged pillars */
    const spires = [0, 1, 2].map((k) => {
      const g = new THREE.ConeGeometry(1, 4.2, 7 + k, 4);
      xform(g, { x: 0, y: 2.1, z: 0 });
      displace(g, ctx.noise, 0.22, 0.9, 5 + k * 7.3);
      paintGradient(g, b.rock.clone().multiplyScalar(0.8), b.boulder2);
      return g;
    });
    const spireVar = spires.map((g) => this.variant([{ geo: g, mat: rockMat, castShadow: true, receiveShadow: true }], 160, 'spire'));
    // A cone's widest ring **is** its base — but the base is buried `0.4 × s`, so the ring you actually walk into is the
    // one where the cone leaves the ground. `footprintOf` measures exactly that (2026-09-10).
    this.scatter(ctx, rng, { count: Math.round(210 * b.spireDensity), limit: HALF - 12, clusterFreq: 0.02, clusterBias: -0.15 }, (x, z) => {
      const s = rng.range(1.4, 3.6);
      if (!isSpotFree(ctx, x, z, s * 0.95, { maxSlope: 0.45, padExtra: 6 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - 0.4 * s;
      const vi = rng.int(0, spireVar.length - 1);
      const v = spireVar[vi];
      const sy = s * rng.range(0.9, 1.5);
      const m = composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12), rng.range(-0.12, 0.12), s, sy, s);
      this.place(v, m, rng.range(0.85, 1.05));
      // 2026-09-09: both cylinders are the measured silhouette. `s * 0.8` was **narrower** than the drawn base, so
      // shots slipped past the visible rock; the old `s * 4.2` collider also ignored the instance's own `sy`.
      // A spire is always ≥ 5 m tall, so it stays a wall — `getSurfaceY` never offers its top as a step.
      // 2026-09-10: measured above the ground (`footprintOf`), not over the whole cone (`hullOf`).
      // 2026-09-11: 볼록 윤곽 + 층 — 위로 좁아지는 원뿔 옆 허공에서 총알이 멈추지 않는다.
      const pc = propHullOf(ctx, spires[vi], m);
      if (pc) ctx.hash.addHull(new THREE.Vector3(pc.x, y, pc.z), pc.hull, Math.max(0.05, pc.top - y), 'rock');
    });

    /* Trees */
    if (b.treeStyle !== 'none') {
      const treeVars: Variant[] = [];
      /**
       * 2026-09-09: the drawn top of each tree variant (max over its parts), so the collider is not ~1 m short of
       * the trunk it draws. The **radius** deliberately stays the trunk's (0.5 × s): a fungal cap is 2 m wide 3.5 m
       * up, and a cylinder that wide would be an invisible wall at ground level and would stop bullets in open air.
       */
      const treeTop: number[] = [];
      for (let k = 0; k < 3; k++) {
        if (b.treeStyle === 'fungal') {
          const trunk = new THREE.CylinderGeometry(0.22 + k * 0.03, 0.5, 3.4 + k * 0.4, 7);
          xform(trunk, { x: 0, y: 1.7 + k * 0.2, z: 0 });
          displace(trunk, ctx.noise, 0.08, 1.5, k * 3);
          paintGradient(trunk, b.trunk.clone().multiplyScalar(0.7), b.trunk);
          const caps: THREE.BufferGeometry[] = [];
          const nCaps = 2 + (k % 2);
          for (let c = 0; c < nCaps; c++) {
            const r = c === 0 ? 1.9 + k * 0.2 : rng.range(0.8, 1.2);
            const cap = new THREE.SphereGeometry(r, 12, 8);
            const ox = c === 0 ? 0 : rng.range(-1.2, 1.2), oz = c === 0 ? 0 : rng.range(-1.2, 1.2);
            const oy = c === 0 ? 3.5 + k * 0.5 : rng.range(2.4, 3.2);
            xform(cap, { x: ox, y: oy, z: oz }, undefined, { x: 1, y: 0.5, z: 1 });
            displace(cap, ctx.noise, 0.06, 1.2, c * 5 + k);
            paintGradient(cap, b.canopy.clone().multiplyScalar(0.55), b.canopy);
            caps.push(cap);
          }
          const capGeo = merge(caps);
          treeTop.push(Math.max(hullOf(trunk).y, hullOf(capGeo).y));
          treeVars.push(this.variant([
            { geo: trunk, mat: trunkMat, castShadow: true, receiveShadow: true },
            { geo: capGeo, mat: this.canopyMat, castShadow: true, receiveShadow: false },
          ], 320, 'tree'));
        } else {
          const parts: THREE.BufferGeometry[] = [];
          const trunk = new THREE.CylinderGeometry(0.14, 0.48, 5.2 + k * 0.6, 6);
          xform(trunk, { x: 0, y: 2.6 + k * 0.3, z: 0 }, new THREE.Euler(rng.range(-0.08, 0.08), 0, rng.range(-0.08, 0.08)));
          displace(trunk, ctx.noise, 0.06, 1.8, k * 2);
          parts.push(trunk);
          const nBranch = 3 + k;
          for (let br = 0; br < nBranch; br++) {
            const len = rng.range(1.4, 2.6);
            const branch = new THREE.CylinderGeometry(0.04, 0.12, len, 5);
            const yaw = rng.range(0, Math.PI * 2), pitch = rng.range(0.6, 1.2);
            const y = rng.range(2.4, 4.6 + k * 0.4);
            xform(branch, { x: 0, y: len / 2, z: 0 });
            xform(branch, { x: 0, y, z: 0 }, new THREE.Euler(pitch, yaw, 0, 'YXZ'));
            parts.push(branch);
          }
          const g = merge(parts);
          paintGradient(g, b.trunk.clone().multiplyScalar(0.7), b.trunk.clone().multiplyScalar(1.15));
          treeTop.push(hullOf(g).y);
          treeVars.push(this.variant([{ geo: g, mat: trunkMat, castShadow: true, receiveShadow: true }], 320, 'tree'));
        }
      }
      this.scatter(ctx, rng, { count: Math.round(560 * b.treeDensity), limit: HALF - 14, clusterFreq: 0.016, clusterBias: 0.05 }, (x, z) => {
        const s = rng.range(0.9, 1.9);
        if (!isSpotFree(ctx, x, z, 0.6 * s, { maxSlope: 0.32, padExtra: 5 })) return;
        const y = ctx.terrain.getHeightAt(x, z) - 0.15;
        const vi = rng.int(0, treeVars.length - 1);
        const v = treeVars[vi];
        const sy = s * rng.range(0.9, 1.2);
        this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.06, 0.06), rng.range(-0.06, 0.06), s, sy, s), rng.range(0.85, 1.1));
        // trunk radius for both cylinders; the height is the instance's real drawn top (was a flat `5 * s`)
        const h = treeTop[vi] * sy;
        ctx.hash.add(new THREE.Vector3(x, y, z), 0.5 * s, h, 'tree', { radius: 0.5 * s, height: h });
      });
    }

    /* Crystal clusters */
    const crystalVars: Variant[] = [];
    const crystalGeos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const parts: THREE.BufferGeometry[] = [];
      const n = 4 + k * 2;
      for (let c = 0; c < n; c++) {
        const oct = new THREE.OctahedronGeometry(1, 0);
        const h = c === 0 ? rng.range(2.0, 2.8) : rng.range(0.8, 2.0);
        const w = rng.range(0.22, 0.42);
        const ang = rng.range(0, Math.PI * 2), rad = c === 0 ? 0 : rng.range(0.3, 0.9);
        xform(oct, { x: 0, y: h * 0.6, z: 0 }, undefined, { x: w, y: h, z: w });
        xform(oct, { x: Math.cos(ang) * rad, y: 0, z: Math.sin(ang) * rad }, new THREE.Euler(rng.range(-0.5, 0.5), ang, rng.range(-0.5, 0.5)));
        parts.push(oct);
      }
      const g = merge(parts);
      paintGradient(g, b.crystal.clone().multiplyScalar(0.35), b.crystal);
      crystalGeos.push(g);
      crystalVars.push(this.variant([{ geo: g, mat: this.crystalMat, castShadow: true, receiveShadow: false }], 200, 'crystal'));
    }
    this.scatter(ctx, rng, { count: Math.round(340 * b.crystalDensity), limit: HALF - 12, clusterFreq: 0.025, clusterBias: -0.12 }, (x, z) => {
      const s = rng.range(0.7, 1.6);
      if (!isSpotFree(ctx, x, z, 0.9 * s, { maxSlope: 0.4, padExtra: 4 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - 0.2;
      const vi = rng.int(0, crystalVars.length - 1);
      const v = crystalVars[vi];
      const m = composeMatrix(x, y, z, rng.range(0, Math.PI * 2), 0, 0, s, s, s);
      this.place(v, m, rng.range(0.9, 1.1));
      // 2026-09-09: measured cluster hull instead of the guessed `0.8 / 2.5`.
      // 2026-09-11: 볼록 윤곽 — 조각 사이로 뻗은 결정 끝을 원 하나로 덮지 않는다. 머리 위로 기운 조각은
      // 이동 윤곽(지면 ~2.2 m)에서 빠지고 총알 층에만 남는다.
      const pc = propHullOf(ctx, crystalGeos[vi], m);
      if (pc) ctx.hash.addHull(new THREE.Vector3(pc.x, y, pc.z), pc.hull, Math.max(0.05, pc.top - y), 'crystal');
    });

    /* Grass tufts (decoration only) */
    const grassGeos = [0, 1].map((k) => this.makeTuft(rng, 5 + k * 3, b.grass, b.grassTip));
    const grassVars = grassGeos.map((g) => this.variant([{ geo: g, mat: grassMat, castShadow: false, receiveShadow: false }], 9000, 'grass'));
    this.scatter(ctx, rng, { count: Math.round(16000 * b.grassDensity), limit: HALF - 4, clusterFreq: 0.03, clusterBias: 0.1 }, (x, z) => {
      if (ctx.terrain.getSlopeAt(x, z) > 0.38) return;
      const h = ctx.terrain.getHeightAt(x, z);
      if (h < b.lowLevel - 1 || h > b.highLevel) return;
      if (ctx.hash.overlaps(x, z, 0.3)) return;
      // keep the pads mostly clean
      const nearPad = ctx.layout.pads.some((p) => (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < (p.radius - 2) * (p.radius - 2));
      if (nearPad) return;
      const s = rng.range(0.7, 1.5);
      const v = grassVars[rng.int(0, grassVars.length - 1)];
      this.place(v, composeMatrix(x, h - 0.05, z, rng.range(0, Math.PI * 2), 0, 0, s, s * rng.range(0.8, 1.3), s), rng.range(0.8, 1.15));
    });

    /* Debris */
    const crateGeo = paint(new THREE.BoxGeometry(1, 1, 1), new THREE.Color(0x4a5048), 0.15, rng);
    const podGeo = (() => {
      const g = new THREE.SphereGeometry(1, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.55);
      xform(g, undefined, new THREE.Euler(Math.PI * 0.9, 0, 0.3));
      return paint(g, new THREE.Color(0x3a3d42), 0.12, rng);
    })();
    const panelGeo = paint(new THREE.BoxGeometry(1.7, 0.08, 1.1), new THREE.Color(0x585c60), 0.1, rng);
    const debrisVars = [
      this.variant([{ geo: crateGeo, mat: debrisMat, castShadow: true, receiveShadow: true }], 70, 'debris'),
      this.variant([{ geo: podGeo, mat: debrisMat, castShadow: true, receiveShadow: true }], 50, 'debris'),
      this.variant([{ geo: panelGeo, mat: debrisMat, castShadow: true, receiveShadow: true }], 80, 'debris'),
    ];
    // 2026-09-09: measured hulls. The crate / pod are low enough that `PROP_STEP_UP_MAX` lets you stand on them,
    // so the cylinder top has to be the **lid**, not a guessed `s`. The crate is randomly yawed, so its XZ radius
    // is the corner sweep (√2 × the half-width) rather than the mean half-width.
    const debrisHull = [hullOf(crateGeo), hullOf(podGeo)];
    this.scatter(ctx, rng, { count: Math.round(170 * b.debrisDensity), limit: HALF - 12, clusterFreq: 0.02, clusterBias: -0.1 }, (x, z) => {
      const kind = rng.int(0, 2);
      const s = kind === 1 ? rng.range(1.2, 2.2) : rng.range(0.8, 1.4);
      const hull = kind === 2 ? null : debrisHull[kind];
      const r = kind === 2 ? 0.4 : hull!.xz * (kind === 0 ? Math.SQRT2 : 1) * s;
      if (!isSpotFree(ctx, x, z, r, { maxSlope: 0.3, padExtra: 2 })) return;
      const lift = kind === 0 ? s * 0.42 : kind === 1 ? -0.3 * s : 0.02;
      const y = ctx.terrain.getHeightAt(x, z) + lift;
      const m = composeMatrix(x, y, z, rng.range(0, Math.PI * 2), kind === 0 ? rng.range(-0.15, 0.15) : rng.range(-0.3, 0.3), kind === 0 ? rng.range(-0.15, 0.15) : rng.range(-0.3, 0.3), s, s, s);
      this.place(debrisVars[kind], m, rng.range(0.85, 1.1));
      if (kind !== 2) {
        // 2026-09-11: 기울어진 상자 · 포드 껍질도 볼록 윤곽 (모서리 스윕 원이 아니다)
        const base = kind === 0 ? y - lift : y;
        const pc = propHullOf(ctx, kind === 0 ? crateGeo : podGeo, m);
        if (pc) ctx.hash.addHull(new THREE.Vector3(pc.x, base, pc.z), pc.hull, Math.max(0.2, pc.top - base), 'debris');
      }
    });

    /* Pebbles — small ground rocks, decoration only */
    const pebbles = [0, 1].map((k) => {
      const g = new THREE.IcosahedronGeometry(1, 1);
      displace(g, ctx.noise, 0.3, 1.6, 40 + k * 9);
      xform(g, undefined, undefined, { x: 1, y: 0.6, z: 0.85 });
      paintGradient(g, b.boulder.clone().multiplyScalar(0.75), k ? b.boulder : b.boulder2);
      return g;
    });
    const pebbleVars = pebbles.map((g) => this.variant([{ geo: g, mat: rockMat, castShadow: false, receiveShadow: true }], 2600, 'pebble'));
    this.scatter(ctx, rng, { count: Math.round(4200 * (0.5 + 0.5 * b.boulderDensity)), limit: HALF + 30, clusterFreq: 0.02, clusterBias: 0.05 }, (x, z) => {
      if (ctx.terrain.getSlopeAt(x, z) > 0.6) return;
      if (ctx.hash.overlaps(x, z, 0.3)) return;
      if (ctx.layout.pads.some((p) => (x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < (p.radius + 1) * (p.radius + 1))) return;
      const s = rng.range(0.15, 0.55);
      const y = ctx.terrain.getHeightAt(x, z) - s * 0.35;
      const v = pebbleVars[rng.int(0, pebbleVars.length - 1)];
      this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.3, 0.3), rng.range(-0.3, 0.3), s, s, s), rng.range(0.8, 1.1));
    });

    this.finalize();
    ctx.root.add(this.group);
  }

  /* ── helpers ────────────────────────────────────────────────────────── */

  private mat<T extends THREE.Material>(m: T): T { this.materials.push(m); return m; }

  private variant(parts: Part[], max: number, name = 'prop'): Variant {
    const v: Variant = { parts, meshes: [], count: 0, max };
    for (const p of parts) {
      const im = new THREE.InstancedMesh(p.geo, p.mat, max);
      im.name = `prop_${name}`;
      im.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      im.castShadow = p.castShadow;
      im.receiveShadow = p.receiveShadow;
      im.layers.enable(Layers.PROP);
      im.frustumCulled = false; // bounds span the map; skip per-frame recompute
      v.meshes.push(im);
    }
    this.variants.push(v);
    return v;
  }

  private place(v: Variant, m: THREE.Matrix4, brightness: number): void {
    if (v.count >= v.max) return;
    scratch.c.setScalar(brightness);
    for (const im of v.meshes) {
      im.setMatrixAt(v.count, m);
      im.setColorAt(v.count, scratch.c);
    }
    v.count++;
  }

  private finalize(): void {
    for (const v of this.variants) {
      for (const im of v.meshes) {
        im.count = v.count;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (v.count > 0) this.group.add(im);
      }
    }
  }

  /** Jittered-grid scatter with optional noise clustering. */
  private scatter(ctx: BuildCtx, rng: Random, o: ScatterOpts, fn: (x: number, z: number) => void): void {
    const side = o.limit * 2;
    const n = Math.max(1, Math.round(Math.sqrt(o.count)));
    const cell = side / n;
    const seedOff = rng.range(0, 1000);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -o.limit + (i + rng.next()) * cell;
        const z = -o.limit + (j + rng.next()) * cell;
        if (o.clusterFreq > 0) {
          const nval = ctx.noise.fbm(x * o.clusterFreq + seedOff, z * o.clusterFreq - seedOff, 2);
          const p = smoothstep(-0.25, 0.45, nval + o.clusterBias);
          if (rng.next() > p) continue;
        }
        fn(x, z);
      }
    }
  }

  private makeTuft(rng: Random, blades: number, base: THREE.Color, tip: THREE.Color): THREE.BufferGeometry {
    const pos = new Float32Array(blades * 9);
    const col = new Float32Array(blades * 9);
    const nor = new Float32Array(blades * 9);
    const uv = new Float32Array(blades * 6);
    for (let k = 0; k < blades; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const r = rng.range(0, 0.22);
      const bx = Math.cos(ang) * r, bz = Math.sin(ang) * r;
      const w = rng.range(0.05, 0.09);
      const h = rng.range(0.45, 0.95);
      const lean = rng.range(0.1, 0.35);
      const lx = Math.cos(ang) * lean, lz = Math.sin(ang) * lean;
      const px = -Math.sin(ang) * w, pz = Math.cos(ang) * w;
      const o = k * 9;
      pos[o] = bx - px; pos[o + 1] = 0; pos[o + 2] = bz - pz;
      pos[o + 3] = bx + px; pos[o + 4] = 0; pos[o + 5] = bz + pz;
      pos[o + 6] = bx + lx; pos[o + 7] = h; pos[o + 8] = bz + lz;
      for (let v = 0; v < 3; v++) {
        const c = v === 2 ? tip : base;
        col[o + v * 3] = c.r; col[o + v * 3 + 1] = c.g; col[o + v * 3 + 2] = c.b;
        nor[o + v * 3] = 0; nor[o + v * 3 + 1] = 1; nor[o + v * 3 + 2] = 0;
      }
      uv[k * 6 + 5] = 1; // tip uv.y = 1 (used by sway shader)
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  }

  private makeGrassMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    const timeUniform = this.timeUniform;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float wphase = instanceMatrix[3][0] * 0.31 + instanceMatrix[3][2] * 0.23;
          #else
            float wphase = 0.0;
          #endif
          float wt = uv.y * uv.y;
          float sway = sin(uTime * 1.8 + wphase) * 0.16 + sin(uTime * 3.1 + wphase * 1.7) * 0.05;
          transformed.x += sway * wt;
          transformed.z += sway * 0.55 * wt;`);
    };
    m.customProgramCacheKey = () => 'world-grass-sway';
    return m;
  }

  /* ── runtime ────────────────────────────────────────────────────────── */

  update(time: number): void {
    this.timeUniform.value = time;
    if (this.crystalMat) this.crystalMat.emissiveIntensity = 0.75 + 0.35 * Math.sin(time * 1.6) + 0.15 * Math.sin(time * 4.3);
  }

  dispose(): void {
    for (const v of this.variants) {
      for (const im of v.meshes) { this.group.remove(im); im.dispose(); }
      for (const p of v.parts) p.geo.dispose();
    }
    this.variants.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.crystalMat = null;
    this.canopyMat = null;
    this.group.removeFromParent();
  }
}
