import * as THREE from 'three';
import { Layers } from '@/shared';
import { type BuildCtx, displace, merge, paintGradient, xform } from './build';

/**
 * Terminid-style bug nests: organic mounds with glowing holes, spikes and egg sacs at each nest pad.
 * Mounds are obstacles; hole positions are exposed for enemy spawning.
 */
export class Nests {
  readonly group = new THREE.Group();
  private holes: THREE.Vector3[] = [];
  private meshes: THREE.Mesh[] = [];
  private bodyMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;
  private eggMat: THREE.MeshStandardMaterial | null = null;

  constructor() { this.group.name = 'Nests'; }

  getHolePositions(): readonly THREE.Vector3[] { return this.holes; }

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('nests');
    const noise = ctx.noise;
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x1a0604, emissive: new THREE.Color(0xff6a1a), emissiveIntensity: 1.6, roughness: 0.4 });
    this.eggMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.0, emissive: new THREE.Color(0x6a5020), emissiveIntensity: 0.25 });

    const dark = new THREE.Color(0x2a0e0a), mid = new THREE.Color(0x6a2a1c), light = new THREE.Color(0x9a4a30);
    const eggA = new THREE.Color(0xb8a070), eggB = new THREE.Color(0xe0d0a0);

    for (const pad of ctx.layout.nests) {
      const body: THREE.BufferGeometry[] = [];
      const glow: THREE.BufferGeometry[] = [];
      const eggs: THREE.BufferGeometry[] = [];
      const baseY = pad.height;

      const mounds: { x: number; z: number; r: number; h: number }[] = [];
      mounds.push({ x: pad.x, z: pad.z, r: rng.range(5.5, 7), h: rng.range(3.4, 4.6) });
      const nSmall = rng.int(3, 5);
      for (let i = 0; i < nSmall; i++) {
        const ang = (i / nSmall) * Math.PI * 2 + rng.range(-0.4, 0.4);
        const d = rng.range(9, 14.5);
        mounds.push({ x: pad.x + Math.cos(ang) * d, z: pad.z + Math.sin(ang) * d, r: rng.range(2.2, 3.6), h: rng.range(1.6, 2.6) });
      }

      for (let mi = 0; mi < mounds.length; mi++) {
        const m = mounds[mi];
        const groundY = ctx.terrain.getHeightAt(m.x, m.z);
        // mound body: squashed displaced sphere
        const sph = new THREE.SphereGeometry(1, 20, 14);
        xform(sph, undefined, undefined, { x: m.r, y: m.h, z: m.r * rng.range(0.85, 1.1) });
        displace(sph, noise, 0.35 * m.r * 0.35, 0.35, mi * 11.3);
        xform(sph, { x: m.x, y: groundY - m.h * 0.15, z: m.z }, new THREE.Euler(0, rng.range(0, Math.PI * 2), 0));
        paintGradient(sph, dark, mi === 0 ? light : mid, groundY - m.h * 0.2, groundY + m.h * 0.9);
        body.push(sph);

        // rim + hole at the top
        const topY = groundY - m.h * 0.15 + m.h * 0.92;
        const holeR = m.r * 0.32;
        const rim = new THREE.TorusGeometry(holeR * 1.15, holeR * 0.35, 8, 18);
        xform(rim, { x: m.x, y: topY - 0.1, z: m.z }, new THREE.Euler(Math.PI / 2, 0, 0));
        displace(rim, noise, 0.08, 2, mi * 3.1);
        paintGradient(rim, mid, light);
        body.push(rim);
        const hole = new THREE.CircleGeometry(holeR * 1.05, 18);
        xform(hole, { x: m.x, y: topY - 0.18, z: m.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
        glow.push(hole);
        // Enemies emerge from the hole
        this.holes.push(new THREE.Vector3(m.x, topY, m.z));

        // spikes / protrusions
        const nSpikes = mi === 0 ? rng.int(8, 12) : rng.int(3, 5);
        for (let s = 0; s < nSpikes; s++) {
          const ang = rng.range(0, Math.PI * 2);
          const rr = rng.range(0.4, 0.85) * m.r;
          const len = rng.range(1.2, 2.8) * (mi === 0 ? 1.3 : 0.8);
          const spike = new THREE.ConeGeometry(rng.range(0.18, 0.35), len, 6);
          xform(spike, { x: 0, y: len / 2, z: 0 });
          // surface height approx: ellipse
          const t = Math.min(1, rr / m.r);
          const sy = groundY - m.h * 0.15 + m.h * Math.sqrt(Math.max(0, 1 - t * t)) * 0.95 - 0.2;
          const tilt = rng.range(0.4, 1.0) * t + rng.range(-0.15, 0.15);
          xform(spike, { x: m.x + Math.cos(ang) * rr, y: sy, z: m.z + Math.sin(ang) * rr }, new THREE.Euler(tilt, -ang + Math.PI / 2, 0, 'YXZ'));
          paintGradient(spike, mid, new THREE.Color(0x3a1810));
          body.push(spike);
        }

        // egg sacs around the base
        const nEggs = rng.int(2, 5);
        for (let e = 0; e < nEggs; e++) {
          const ang = rng.range(0, Math.PI * 2);
          const d = m.r * rng.range(0.95, 1.35);
          const er = rng.range(0.35, 0.7);
          const ex = m.x + Math.cos(ang) * d, ez = m.z + Math.sin(ang) * d;
          const egg = new THREE.SphereGeometry(er, 8, 6);
          xform(egg, { x: ex, y: ctx.terrain.getHeightAt(ex, ez) + er * 0.6, z: ez }, undefined, { x: 1, y: 1.2, z: 1 });
          paintGradient(egg, eggA, eggB);
          eggs.push(egg);
        }

        // register obstacle
        ctx.hash.add(new THREE.Vector3(m.x, groundY, m.z), m.r * 0.88, m.h, 'nest');
      }

      // goo tendrils on the ground between mounds (flat dark discs)
      for (let g = 0; g < 6; g++) {
        const ang = rng.range(0, Math.PI * 2), d = rng.range(3, 16);
        const gx = pad.x + Math.cos(ang) * d, gz = pad.z + Math.sin(ang) * d;
        const disc = new THREE.CircleGeometry(rng.range(1.5, 3.5), 10);
        displace(disc, noise, 0.5, 0.8, g * 2.2);
        xform(disc, { x: gx, y: ctx.terrain.getHeightAt(gx, gz) + 0.05, z: gz }, new THREE.Euler(-Math.PI / 2, 0, 0));
        paintGradient(disc, dark, dark);
        body.push(disc);
      }

      const bodyMesh = new THREE.Mesh(merge(body), this.bodyMat);
      bodyMesh.castShadow = true; bodyMesh.receiveShadow = true;
      bodyMesh.layers.enable(Layers.PROP);
      bodyMesh.position.y = 0; bodyMesh.name = 'nest_body';
      const glowMesh = new THREE.Mesh(merge(glow), this.glowMat);
      glowMesh.name = 'nest_glow';
      const eggMesh = new THREE.Mesh(merge(eggs), this.eggMat);
      eggMesh.castShadow = true; eggMesh.name = 'nest_eggs';
      this.meshes.push(bodyMesh, glowMesh, eggMesh);
      this.group.add(bodyMesh, glowMesh, eggMesh);
      void baseY;
    }
    ctx.root.add(this.group);
  }

  update(time: number): void {
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.4 + 0.5 * Math.sin(time * 2.2) + 0.2 * Math.sin(time * 7.1);
  }

  dispose(): void {
    for (const m of this.meshes) { m.geometry.dispose(); this.group.remove(m); }
    this.meshes.length = 0;
    this.holes.length = 0;
    this.bodyMat?.dispose(); this.glowMat?.dispose(); this.eggMat?.dispose();
    this.bodyMat = this.glowMat = this.eggMat = null;
    this.group.removeFromParent();
  }
}
