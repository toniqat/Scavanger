import * as THREE from 'three';
import { Layers } from '@/shared';
import { type BuildCtx, displace, merge, paint, paintGradient, xform } from './build';

/** Points of interest: small ruined outposts (walls, pillars, antenna, rubble) on each POI pad. */
export class Outposts {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private beaconMat: THREE.MeshStandardMaterial | null = null;

  constructor() { this.group.name = 'Outposts'; }

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('outposts');
    const structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.15 });
    this.beaconMat = new THREE.MeshStandardMaterial({ color: 0x200404, emissive: new THREE.Color(0xff2020), emissiveIntensity: 2.0 });
    this.materials.push(structMat, this.beaconMat);

    const concrete = new THREE.Color(0x77756e), concreteDark = new THREE.Color(0x4e4c47), rust = new THREE.Color(0x6a4a30), metal = new THREE.Color(0x3e4247);

    for (const pad of ctx.layout.pois) {
      const parts: THREE.BufferGeometry[] = [];
      const beacons: THREE.BufferGeometry[] = [];
      const y0 = pad.height;
      const cx = pad.x, cz = pad.z;
      const yaw = pad.yaw;
      const rot = (lx: number, lz: number): [number, number] => [
        cx + lx * Math.cos(yaw) - lz * Math.sin(yaw),
        cz + lx * Math.sin(yaw) + lz * Math.cos(yaw),
      ];

      // floor slab
      const slabW = rng.range(11, 15), slabD = rng.range(10, 14);
      const slab = new THREE.BoxGeometry(slabW, 0.25, slabD);
      xform(slab, { x: cx, y: y0 + 0.08, z: cz }, new THREE.Euler(0, -yaw, 0));
      paint(slab, concreteDark, 0.08, rng);
      parts.push(slab);

      // wall segments around a rough rectangle, with gaps
      const wallDefs: { lx: number; lz: number; len: number; ang: number }[] = [];
      const hw = slabW / 2 - 0.6, hd = slabD / 2 - 0.6;
      const sides: [number, number, number, number][] = [
        [-hw, -hd, hw, -hd], [hw, -hd, hw, hd], [hw, hd, -hw, hd], [-hw, hd, -hw, -hd],
      ];
      for (const [x0, z0, x1, z1] of sides) {
        const segs = rng.int(1, 3);
        for (let s = 0; s < segs; s++) {
          if (rng.chance(0.3)) continue; // gap
          const t0 = s / segs + rng.range(0.02, 0.1), t1 = (s + 1) / segs - rng.range(0.02, 0.1);
          if (t1 - t0 < 0.15) continue;
          const ax = x0 + (x1 - x0) * t0, az = z0 + (z1 - z0) * t0;
          const bx = x0 + (x1 - x0) * t1, bz = z0 + (z1 - z0) * t1;
          wallDefs.push({ lx: (ax + bx) / 2, lz: (az + bz) / 2, len: Math.hypot(bx - ax, bz - az), ang: Math.atan2(bz - az, bx - ax) });
        }
      }
      for (const w of wallDefs) {
        const h = rng.range(2.2, 3.6);
        const wall = new THREE.BoxGeometry(w.len, h, 0.45);
        const [wx, wz] = rot(w.lx, w.lz);
        const wyaw = -(w.ang + yaw);
        xform(wall, { x: wx, y: y0 + h / 2 + 0.1, z: wz }, new THREE.Euler(rng.range(-0.04, 0.04), wyaw, rng.range(-0.05, 0.05)));
        paintGradient(wall, concreteDark, concrete, y0, y0 + h);
        parts.push(wall);
        // broken top chunk
        if (rng.chance(0.6)) {
          const chunk = new THREE.BoxGeometry(w.len * rng.range(0.25, 0.5), rng.range(0.5, 1.1), 0.5);
          xform(chunk, { x: wx + rng.range(-w.len * 0.2, w.len * 0.2) * Math.cos(-wyaw), y: y0 + h + 0.35, z: wz + rng.range(-w.len * 0.2, w.len * 0.2) * Math.sin(-wyaw) }, new THREE.Euler(0, wyaw + rng.range(-0.1, 0.1), 0));
          paint(chunk, concrete, 0.06, rng);
          parts.push(chunk);
        }
        // obstacles: circles along the wall
        const n = Math.max(1, Math.round(w.len / 1.1));
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (w.len - 0.6);
          const ox = wx + Math.cos(-wyaw) * t, oz = wz + Math.sin(-wyaw) * t;
          ctx.hash.add(new THREE.Vector3(ox, y0, oz), 0.62, h, 'wall');
        }
      }

      // pillars
      const nPillars = rng.int(2, 4);
      for (let p = 0; p < nPillars; p++) {
        const [px, pz] = rot(rng.range(-hw * 0.6, hw * 0.6), rng.range(-hd * 0.6, hd * 0.6));
        const h = rng.range(2.5, 4.5);
        const pillar = new THREE.CylinderGeometry(0.42, 0.5, h, 8);
        xform(pillar, { x: px, y: y0 + h / 2 + 0.1, z: pz }, new THREE.Euler(rng.range(-0.05, 0.05), 0, rng.range(-0.05, 0.05)));
        paintGradient(pillar, rust, concrete, y0, y0 + h);
        parts.push(pillar);
        ctx.hash.add(new THREE.Vector3(px, y0, pz), 0.62, h, 'wall');
      }

      // antenna mast with dish + blinking beacon
      {
        const [ax, az] = rot(hw * rng.range(0.3, 0.7), -hd * rng.range(0.3, 0.7));
        const mastH = rng.range(8, 11);
        const mast = new THREE.CylinderGeometry(0.1, 0.22, mastH, 6);
        xform(mast, { x: ax, y: y0 + mastH / 2 + 0.1, z: az });
        paint(mast, metal);
        parts.push(mast);
        const base = new THREE.BoxGeometry(1.4, 0.7, 1.4);
        xform(base, { x: ax, y: y0 + 0.45, z: az });
        paint(base, metal, 0.05, rng);
        parts.push(base);
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          const strut = new THREE.CylinderGeometry(0.03, 0.03, mastH * 0.65, 4);
          xform(strut, { x: 0, y: mastH * 0.33, z: 0 }, new THREE.Euler(0.16, 0, 0));
          xform(strut, { x: ax, y: y0 + 0.1, z: az }, new THREE.Euler(0, a, 0));
          paint(strut, metal);
          parts.push(strut);
        }
        const dish = new THREE.SphereGeometry(1.1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.4);
        xform(dish, { x: ax + 0.7, y: y0 + mastH * 0.75, z: az }, new THREE.Euler(0, 0, -1.2));
        paint(dish, concrete, 0.05, rng);
        parts.push(dish);
        const beacon = new THREE.SphereGeometry(0.18, 8, 6);
        xform(beacon, { x: ax, y: y0 + mastH + 0.25, z: az });
        beacons.push(beacon);
        ctx.hash.add(new THREE.Vector3(ax, y0, az), 0.8, mastH, 'wall');
      }

      // rubble chunks (decorative)
      const nRubble = rng.int(5, 9);
      for (let r = 0; r < nRubble; r++) {
        const [rx, rz] = rot(rng.range(-hw, hw), rng.range(-hd, hd));
        const s = rng.range(0.25, 0.7);
        const chunk = new THREE.DodecahedronGeometry(s, 0);
        displace(chunk, ctx.noise, 0.15, 2, r * 5);
        xform(chunk, { x: rx, y: y0 + s * 0.6, z: rz }, new THREE.Euler(rng.range(0, 3), rng.range(0, 3), rng.range(0, 3)));
        paint(chunk, rng.chance(0.3) ? rust : concrete, 0.1, rng);
        parts.push(chunk);
      }

      // scattered sandbags / supply barrels near a wall
      const nBarrels = rng.int(1, 3);
      for (let bI = 0; bI < nBarrels; bI++) {
        const [bx, bz] = rot(rng.range(-hw * 0.8, hw * 0.8), rng.range(-hd * 0.8, hd * 0.8));
        const barrel = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 10);
        xform(barrel, { x: bx, y: y0 + 0.65, z: bz }, new THREE.Euler(0, rng.range(0, 3), 0));
        paint(barrel, rng.chance(0.5) ? new THREE.Color(0x6a6a2a) : rust, 0.1, rng);
        parts.push(barrel);
        ctx.hash.add(new THREE.Vector3(bx, y0, bz), 0.5, 1.2, 'wall');
      }

      const mesh = new THREE.Mesh(merge(parts), structMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.layers.enable(Layers.PROP);
      mesh.name = 'outpost';
      this.meshes.push(mesh);
      this.group.add(mesh);
      const beaconMesh = new THREE.Mesh(merge(beacons), this.beaconMat);
      beaconMesh.name = 'outpost_beacon';
      this.meshes.push(beaconMesh);
      this.group.add(beaconMesh);
    }
    ctx.root.add(this.group);
  }

  update(time: number): void {
    if (this.beaconMat) this.beaconMat.emissiveIntensity = (time % 1.6) < 0.15 ? 3.0 : 0.15;
  }

  dispose(): void {
    for (const m of this.meshes) { m.geometry.dispose(); this.group.remove(m); }
    this.meshes.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.beaconMat = null;
    this.group.removeFromParent();
  }
}
