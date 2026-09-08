import * as THREE from 'three';
import { Layers } from '@/shared';
import type { Random } from '@/shared';
import { type BuildCtx, composeMatrix, displace, isSpotFree, merge, paint, paintGradient, scratch, xform } from './build';
import { HALF } from './Terrain';
import { smoothstep } from './noise';

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
 * Drawn half-extents of a finished variant geometry, in the units the instance matrix scales: `xz` is the mean of the
 * X and Z half-widths (the mesh is randomly yawed, so neither axis alone is the silhouette a bullet meets) and `y` is
 * the taller of the two vertical halves. Used for `Obstacle.shotRadius / shotHeight` — see `WorldSystem.rayCylinder`.
 */
function hullOf(geo: THREE.BufferGeometry): { xz: number; y: number } {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb) return { xz: 1, y: 1 };
  const hx = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x));
  const hz = Math.max(Math.abs(bb.min.z), Math.abs(bb.max.z));
  return { xz: (hx + hz) / 2, y: Math.max(Math.abs(bb.min.y), Math.abs(bb.max.y)) };
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
    // 2026-09-08 (엄폐): the drawn half-extents of each displaced variant, measured once. The collider below stays
    // where it was (0.82 × s — a rock you can hug without an invisible wall), but bullets are stopped by these:
    // the old ray cylinder was ~30 % narrower and ~0.5 m taller than the rock, so shots went through the visible
    // sides and stopped in the air above it. XZ takes the mean of the two axes because the mesh is randomly yawed.
    const boulderHull = boulders.map((g) => hullOf(g));
    this.scatter(ctx, rng, { count: Math.round(1000 * b.boulderDensity), limit: HALF + 70, clusterFreq: 0.012, clusterBias: 0.15 }, (x, z) => {
      const outside = Math.abs(x) > HALF - 6 || Math.abs(z) > HALF - 6;
      const s = outside ? rng.range(2.5, 7.5) : (rng.chance(0.12) ? rng.range(3.2, 5.5) : rng.range(1.0, 2.8));
      if (!isSpotFree(ctx, x, z, s * 0.9, { maxSlope: outside ? 0.85 : 0.5, limit: HALF + 80, padExtra: 3 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - s * 0.28;
      const vi = rng.int(0, boulderVar.length - 1);
      const v = boulderVar[vi];
      const sy = s * rng.range(0.8, 1.15);
      this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.25, 0.25), rng.range(-0.25, 0.25), s, sy, s), rng.range(0.85, 1.1));
      if (!outside || Math.abs(x) < HALF + 6 && Math.abs(z) < HALF + 6) {
        const hull = boulderHull[vi];
        ctx.hash.add(new THREE.Vector3(x, y, z), s * 0.82, s * 1.3, 'rock', { radius: hull.xz * s, height: hull.y * sy });
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
    this.scatter(ctx, rng, { count: Math.round(210 * b.spireDensity), limit: HALF - 12, clusterFreq: 0.02, clusterBias: -0.15 }, (x, z) => {
      const s = rng.range(1.4, 3.6);
      if (!isSpotFree(ctx, x, z, s * 0.95, { maxSlope: 0.45, padExtra: 6 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - 0.4 * s;
      const v = spireVar[rng.int(0, spireVar.length - 1)];
      const sy = s * rng.range(0.9, 1.5);
      this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12), rng.range(-0.12, 0.12), s, sy, s), rng.range(0.85, 1.05));
      // a tall instance (`sy` up to 1.5 × s) drew ~2 m of spire above a 4.2 × s collider — bullets flew straight
      // through the top third. The shot cylinder takes the instance's real height; the base radius is close enough
      // to the cone's lower half, which is the part anyone actually hides behind.
      ctx.hash.add(new THREE.Vector3(x, y, z), s * 0.8, s * 4.2, 'rock', { radius: s * 0.8, height: sy * 4.2 });
    });

    /* Trees */
    if (b.treeStyle !== 'none') {
      const treeVars: Variant[] = [];
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
          treeVars.push(this.variant([
            { geo: trunk, mat: trunkMat, castShadow: true, receiveShadow: true },
            { geo: merge(caps), mat: this.canopyMat, castShadow: true, receiveShadow: false },
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
          treeVars.push(this.variant([{ geo: g, mat: trunkMat, castShadow: true, receiveShadow: true }], 320, 'tree'));
        }
      }
      this.scatter(ctx, rng, { count: Math.round(560 * b.treeDensity), limit: HALF - 14, clusterFreq: 0.016, clusterBias: 0.05 }, (x, z) => {
        const s = rng.range(0.9, 1.9);
        if (!isSpotFree(ctx, x, z, 0.6 * s, { maxSlope: 0.32, padExtra: 5 })) return;
        const y = ctx.terrain.getHeightAt(x, z) - 0.15;
        const v = treeVars[rng.int(0, treeVars.length - 1)];
        this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), rng.range(-0.06, 0.06), rng.range(-0.06, 0.06), s, s * rng.range(0.9, 1.2), s), rng.range(0.85, 1.1));
        ctx.hash.add(new THREE.Vector3(x, y, z), 0.5 * s, 5 * s, 'tree');
      });
    }

    /* Crystal clusters */
    const crystalVars: Variant[] = [];
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
      crystalVars.push(this.variant([{ geo: g, mat: this.crystalMat, castShadow: true, receiveShadow: false }], 200, 'crystal'));
    }
    this.scatter(ctx, rng, { count: Math.round(340 * b.crystalDensity), limit: HALF - 12, clusterFreq: 0.025, clusterBias: -0.12 }, (x, z) => {
      const s = rng.range(0.7, 1.6);
      if (!isSpotFree(ctx, x, z, 0.9 * s, { maxSlope: 0.4, padExtra: 4 })) return;
      const y = ctx.terrain.getHeightAt(x, z) - 0.2;
      const v = crystalVars[rng.int(0, crystalVars.length - 1)];
      this.place(v, composeMatrix(x, y, z, rng.range(0, Math.PI * 2), 0, 0, s, s, s), rng.range(0.9, 1.1));
      ctx.hash.add(new THREE.Vector3(x, y, z), 0.8 * s, 2.5 * s, 'crystal');
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
    this.scatter(ctx, rng, { count: Math.round(170 * b.debrisDensity), limit: HALF - 12, clusterFreq: 0.02, clusterBias: -0.1 }, (x, z) => {
      const kind = rng.int(0, 2);
      const s = kind === 1 ? rng.range(1.2, 2.2) : rng.range(0.8, 1.4);
      const r = kind === 2 ? 0.4 : 0.8 * s;
      if (!isSpotFree(ctx, x, z, r, { maxSlope: 0.3, padExtra: 2 })) return;
      const y = ctx.terrain.getHeightAt(x, z) + (kind === 0 ? s * 0.42 : kind === 1 ? -0.3 * s : 0.02);
      this.place(debrisVars[kind], composeMatrix(x, y, z, rng.range(0, Math.PI * 2), kind === 0 ? rng.range(-0.15, 0.15) : rng.range(-0.3, 0.3), kind === 0 ? rng.range(-0.15, 0.15) : rng.range(-0.3, 0.3), s, s, s), rng.range(0.85, 1.1));
      if (kind !== 2) ctx.hash.add(new THREE.Vector3(x, y - (kind === 0 ? s * 0.42 : 0), z), r, s, 'debris');
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
