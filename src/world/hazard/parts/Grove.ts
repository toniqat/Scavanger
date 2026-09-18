/**
 * src/world/hazard/parts/Grove.ts — **giant mushroom groves** (the sources of the spores).
 *
 * Where spores will bloom a terrain feature has to be standing (user's request). The cap undersides and the vents
 * at the base glow so it reads as "that is where it bursts" from far off, and the caps breathe slowly over time.
 *
 * **The stem is the only collider.** A cap floats 4~9 m up with a 5~9 m diameter, so taking a cylinder at the
 * silhouette width would stand an invisible wall on the ground and stop bullets in mid-air — exactly the same
 * judgement as `Props.ts`' trees, which use the trunk radius only (CLAUDE.md "colliders match the visible silhouette").
 */
import * as THREE from 'three';
import { Layers, type Random } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from '../../build';
import {
  GROVE_CAPS_MAX, GROVE_CAPS_MIN, GROVE_CAP_MUL_MAX, GROVE_CAP_MUL_MIN,
  GROVE_RADIUS, GROVE_STEM_H_MAX, GROVE_STEM_H_MIN, GROVE_STEM_R_MAX, GROVE_STEM_R_MIN,
  hazardRow,
} from '../model';

const STALK_LOW = new THREE.Color(0x3f4438);
const STALK_HIGH = new THREE.Color(0xc9cbb2);
const CAP_RIM = new THREE.Color(0x2c3b2a);
const CAP_TOP = new THREE.Color(0x6d7f4a);

/** One grove (one per source). */
export interface GroveDef {
  id: string;
  position: THREE.Vector3;
  radius: number;
}

/**
 * Stands every grove up as **two meshes** (body · glow). They are static, so one merge is the end of it; only the
 * cap-underside glow pulses in `update`.
 */
export class Groves {
  readonly group = new THREE.Group();
  private readonly defs: GroveDef[] = [];
  private bodyGeo: THREE.BufferGeometry | null = null;
  private glowGeo: THREE.BufferGeometry | null = null;
  private bodyMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;

  constructor() { this.group.name = 'MushroomGroves'; }

  getDefs(): readonly GroveDef[] { return this.defs; }

  /** `spots` = the spore source spots. With an empty array it builds nothing. */
  build(ctx: BuildCtx, rng: Random, spots: ReadonlyArray<{ x: number; z: number }>): void {
    if (spots.length === 0) return;
    const glowColor = new THREE.Color(hazardRow('spores')?.particleColor ?? 0x9dff7a);
    const body: THREE.BufferGeometry[] = [];
    const glow: THREE.BufferGeometry[] = [];

    for (let g = 0; g < spots.length; g++) {
      const s = spots[g];
      const baseY = ctx.terrain.getHeightAt(s.x, s.z);
      this.defs.push({
        id: `grove_${g}`,
        position: new THREE.Vector3(s.x, baseY, s.z),
        radius: GROVE_RADIUS,
      });

      const caps = rng.int(GROVE_CAPS_MIN, GROVE_CAPS_MAX);
      for (let i = 0; i < caps; i++) {
        // The first one stands in the middle of the grove, the rest scatter inside the ring
        const ang = rng.range(0, Math.PI * 2);
        const d = i === 0 ? 0 : GROVE_RADIUS * Math.sqrt(rng.range(0.08, 1));
        const x = s.x + Math.cos(ang) * d, z = s.z + Math.sin(ang) * d;
        const y = ctx.terrain.getHeightAt(x, z);
        const stemR = rng.range(GROVE_STEM_R_MIN, GROVE_STEM_R_MAX) * (i === 0 ? 1.25 : 1);
        const stemH = rng.range(GROVE_STEM_H_MIN, GROVE_STEM_H_MAX) * (i === 0 ? 1.15 : 1);
        const capR = stemR * rng.range(GROVE_CAP_MUL_MIN, GROVE_CAP_MUL_MAX);
        const lean = rng.range(0, 0.12);
        const leanAng = rng.range(0, Math.PI * 2);

        // Stem: thick at the base, thinner toward the top
        const stalk = new THREE.CylinderGeometry(stemR * 0.72, stemR * 1.15, stemH, 9, 1);
        xform(stalk, { x: 0, y: stemH * 0.5, z: 0 });
        paintGradient(stalk, STALK_LOW, STALK_HIGH);
        body.push(place(stalk, x, y, z, lean, leanAng));

        // Cap: a squashed hemisphere + a rim ring
        const cap = new THREE.SphereGeometry(capR, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
        xform(cap, { x: 0, y: stemH, z: 0 }, undefined, { x: 1, y: 0.5 + rng.range(0, 0.2), z: 1 });
        paintGradient(cap, CAP_RIM, CAP_TOP);
        body.push(place(cap, x, y, z, lean, leanAng));

        // Cap underside (the gills) — glowing. This is the silhouette that keeps a grove readable at night.
        const gills = new THREE.CylinderGeometry(capR * 0.94, capR * 0.5, 0.12, 16, 1, true);
        xform(gills, { x: 0, y: stemH - 0.16, z: 0 });
        paint(gills, glowColor);
        glow.push(place(gills, x, y, z, lean, leanAng));

        /* The collider is **one stem** (the cap is in the air — see the file header). The shot cylinder takes the
         * same value, so no bullet stops outside the visible stem. */
        ctx.hash.add(new THREE.Vector3(x, y, z), stemR * 1.05, stemH, 'grove');
      }

      // Spore vents at the base: a few low discs (no collider — they are walked over)
      const vents = rng.int(3, 5);
      for (let v = 0; v < vents; v++) {
        const ang = rng.range(0, Math.PI * 2);
        const d = rng.range(1.5, GROVE_RADIUS);
        const x = s.x + Math.cos(ang) * d, z = s.z + Math.sin(ang) * d;
        const y = ctx.terrain.getHeightAt(x, z);
        const r = rng.range(0.5, 1.2);
        const disc = new THREE.CylinderGeometry(r, r * 1.25, 0.18, 10);
        xform(disc, { x, y: y + 0.09, z });
        paint(disc, glowColor.clone().multiplyScalar(0.55));
        glow.push(disc);
      }
    }

    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    this.glowMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.4, metalness: 0.0, side: THREE.DoubleSide,
      emissive: glowColor.clone(), emissiveIntensity: 1.3,
    });
    this.bodyGeo = merge(body);
    this.glowGeo = merge(glow);
    for (const [geo, mat, name] of [
      [this.bodyGeo, this.bodyMat, 'grove_body'] as const,
      [this.glowGeo, this.glowMat, 'grove_glow'] as const,
    ]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.layers.enable(Layers.PROP);
      this.group.add(mesh);
    }
    ctx.root.add(this.group);
  }

  update(time: number): void {
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.0 + 0.35 * Math.sin(time * 0.9) + 0.1 * Math.sin(time * 2.7);
  }

  dispose(): void {
    this.group.clear();
    this.group.removeFromParent();
    this.bodyGeo?.dispose(); this.bodyGeo = null;
    this.glowGeo?.dispose(); this.glowGeo = null;
    this.bodyMat?.dispose(); this.bodyMat = null;
    this.glowMat?.dispose(); this.glowMat = null;
    this.defs.length = 0;
  }
}

/**
 * Moves a geometry to the grove spot and leans it slightly. The geometry's origin is the base, so **the rotation
 * order is lean (X) → turn (Y)** — reversed, the lean direction is always pinned to world +X.
 */
function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, lean: number, leanAng: number): THREE.BufferGeometry {
  if (lean > 0.001) {
    xform(geo, undefined, new THREE.Euler(lean, 0, 0));
    xform(geo, undefined, new THREE.Euler(0, leanAng, 0));
  }
  return xform(geo, { x, y, z });
}
