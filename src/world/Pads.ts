import * as THREE from 'three';
import { Layers } from '@/shared';
import { type BuildCtx, merge, paint, paintGradient, xform } from './build';

/** Height of the extraction landing platform above the flattened pad. */
export const PLATFORM_HEIGHT = 0.3;
export const PLATFORM_RADIUS = 12;

/**
 * Extraction landing platforms (concrete disc, hazard ring, edge lights, light poles) and the spawn marker.
 * The switch console + ship are built by the extraction module at getExtractionPoints().
 */
export class Pads {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private edgeLightMat: THREE.MeshStandardMaterial | null = null;
  private lampMat: THREE.MeshStandardMaterial | null = null;
  private spawnBeaconMat: THREE.MeshStandardMaterial | null = null;
  private lights: THREE.PointLight[] = [];

  constructor() { this.group.name = 'Pads'; }

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('pads');
    const concreteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 });
    const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.7 });
    this.edgeLightMat = new THREE.MeshStandardMaterial({ color: 0x0a2030, emissive: new THREE.Color(0x30c8ff), emissiveIntensity: 2.0 });
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x302810, emissive: new THREE.Color(0xffd890), emissiveIntensity: 2.2 });
    this.spawnBeaconMat = new THREE.MeshStandardMaterial({ color: 0x0a2010, emissive: new THREE.Color(0x40ff80), emissiveIntensity: 1.8 });
    this.materials.push(concreteMat, metalMat, this.edgeLightMat, this.lampMat, this.spawnBeaconMat);

    const concrete = new THREE.Color(0x6e6f6a), concreteDark = new THREE.Color(0x4a4b48);
    const yellow = new THREE.Color(0xe8b020), black = new THREE.Color(0x1a1a1a);
    const metal = new THREE.Color(0x50545a);

    for (const pad of ctx.layout.extraction) {
      const y0 = pad.height;
      const parts: THREE.BufferGeometry[] = [];

      // scorch decal that hides the terrain/platform seam
      const scorch = new THREE.CircleGeometry(PLATFORM_RADIUS + 2.2, 40);
      xform(scorch, { x: pad.x, y: y0 + 0.03, z: pad.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
      paint(scorch, new THREE.Color(0x26241f));
      parts.push(scorch);

      // platform disc
      const disc = new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS + 0.9, PLATFORM_HEIGHT, 48, 1);
      xform(disc, { x: pad.x, y: y0 + PLATFORM_HEIGHT / 2, z: pad.z });
      paint(disc, concrete, 0.06, rng);
      parts.push(disc);

      // panel seams: a few thin dark rings & radial lines on top
      for (let r = 3; r < PLATFORM_RADIUS; r += 3) {
        const ring = new THREE.RingGeometry(r - 0.06, r + 0.06, 48);
        xform(ring, { x: pad.x, y: y0 + PLATFORM_HEIGHT + 0.005, z: pad.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
        paint(ring, concreteDark);
        parts.push(ring);
      }
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const line = new THREE.BoxGeometry(PLATFORM_RADIUS - 3.6, 0.01, 0.12);
        xform(line, { x: pad.x + Math.cos(a) * (PLATFORM_RADIUS / 2 + 0.3), y: y0 + PLATFORM_HEIGHT + 0.006, z: pad.z + Math.sin(a) * (PLATFORM_RADIUS / 2 + 0.3) }, new THREE.Euler(0, -a, 0));
        paint(line, concreteDark);
        parts.push(line);
      }

      // hazard ring: alternating yellow / black sectors
      const sectors = 28;
      for (let k = 0; k < sectors; k++) {
        const a0 = (k / sectors) * Math.PI * 2, a1 = ((k + 1) / sectors) * Math.PI * 2;
        const seg = new THREE.RingGeometry(PLATFORM_RADIUS - 1.6, PLATFORM_RADIUS - 0.35, 4, 1, a0, a1 - a0);
        xform(seg, { x: pad.x, y: y0 + PLATFORM_HEIGHT + 0.008, z: pad.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
        paint(seg, k % 2 ? black : yellow);
        parts.push(seg);
      }
      // central landing target ring + H marker
      const target = new THREE.RingGeometry(3.6, 4.1, 40);
      xform(target, { x: pad.x, y: y0 + PLATFORM_HEIGHT + 0.008, z: pad.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
      paint(target, yellow);
      parts.push(target);
      const hBarL = new THREE.BoxGeometry(0.4, 0.01, 3.2), hBarR = new THREE.BoxGeometry(0.4, 0.01, 3.2), hBarM = new THREE.BoxGeometry(1.8, 0.01, 0.4);
      xform(hBarL, { x: -1.1, y: 0, z: 0 }); xform(hBarR, { x: 1.1, y: 0, z: 0 });
      for (const g of [hBarL, hBarR, hBarM]) {
        xform(g, { x: pad.x, y: y0 + PLATFORM_HEIGHT + 0.01, z: pad.z }, new THREE.Euler(0, pad.yaw, 0));
        paint(g, yellow);
        parts.push(g);
      }

      const platform = new THREE.Mesh(merge(parts), concreteMat);
      platform.receiveShadow = true;
      platform.layers.enable(Layers.PROP);
      platform.name = `extraction_platform_${pad.x | 0}_${pad.z | 0}`;
      this.addMesh(platform);

      // edge lights (merged, shared pulsing emissive)
      const lights: THREE.BufferGeometry[] = [];
      const nLights = 20;
      for (let k = 0; k < nLights; k++) {
        const a = (k / nLights) * Math.PI * 2;
        const l = new THREE.BoxGeometry(0.5, 0.18, 0.25);
        xform(l, { x: pad.x + Math.cos(a) * (PLATFORM_RADIUS - 0.15), y: y0 + PLATFORM_HEIGHT + 0.09, z: pad.z + Math.sin(a) * (PLATFORM_RADIUS - 0.15) }, new THREE.Euler(0, -a + Math.PI / 2, 0));
        lights.push(l);
      }
      const lightMesh = new THREE.Mesh(merge(lights), this.edgeLightMat);
      lightMesh.name = 'extraction_edge_lights';
      this.addMesh(lightMesh);

      // light poles just outside the 14 m clear zone
      const poles: THREE.BufferGeometry[] = [];
      const lamps: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const a = pad.yaw + Math.PI / 4 + (k / 4) * Math.PI * 2;
        const px = pad.x + Math.cos(a) * 15.6, pz = pad.z + Math.sin(a) * 15.6;
        const py = ctx.terrain.getHeightAt(px, pz);
        const pole = new THREE.CylinderGeometry(0.12, 0.2, 5.2, 8);
        xform(pole, { x: px, y: py + 2.6, z: pz });
        paint(pole, metal, 0.05, rng);
        poles.push(pole);
        const base = new THREE.CylinderGeometry(0.55, 0.7, 0.35, 10);
        xform(base, { x: px, y: py + 0.15, z: pz });
        paint(base, concreteDark);
        poles.push(base);
        const arm = new THREE.BoxGeometry(1.1, 0.12, 0.12);
        xform(arm, { x: 0.5, y: 0, z: 0 });
        xform(arm, { x: px, y: py + 5.1, z: pz }, new THREE.Euler(0, -a + Math.PI, 0));
        paint(arm, metal);
        poles.push(arm);
        const lamp = new THREE.BoxGeometry(0.5, 0.22, 0.4);
        xform(lamp, { x: 1.0, y: -0.12, z: 0 });
        xform(lamp, { x: px, y: py + 5.1, z: pz }, new THREE.Euler(0, -a + Math.PI, 0));
        lamps.push(lamp);
        /* 2026-09-09 — 실루엣에 맞춘다: 그려진 것은 받침(반지름 0.7 · 높이 0.35)과 그 위의 가는 기둥
         * (0.2 → 0.12)인데, 예전에는 `0.45 × 5.4` 한 덩이라 기둥 옆이 보이지 않는 벽이었고 총알도 먹었다. */
        ctx.hash.add(new THREE.Vector3(px, py, pz), 0.7, 0.35, 'pole');
        ctx.hash.add(new THREE.Vector3(px, py + 0.35, pz), 0.22, 5.05, 'pole');
      }
      const poleMesh = new THREE.Mesh(merge(poles), metalMat);
      poleMesh.castShadow = true; poleMesh.name = 'extraction_poles';
      this.addMesh(poleMesh);
      const lampMesh = new THREE.Mesh(merge(lamps), this.lampMat);
      lampMesh.name = 'extraction_lamps';
      this.addMesh(lampMesh);

      // one warm point light per pad (3 total) — cheap and sells the landing zone at night/fog
      const pl = new THREE.PointLight(0xffd8a0, 18, 34, 1.6);
      pl.position.set(pad.x, y0 + 6, pad.z);
      pl.castShadow = false;
      this.lights.push(pl);
      this.group.add(pl);
    }

    /* Spawn marker: scorched hellpod landing circle + 4 green beacons */
    {
      const sp = ctx.layout.spawn;
      const y0 = sp.height;
      const parts: THREE.BufferGeometry[] = [];
      const scorch = new THREE.CircleGeometry(7, 32);
      xform(scorch, { x: sp.x, y: y0 + 0.03, z: sp.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
      paintGradient(scorch, new THREE.Color(0x1a1814), new THREE.Color(0x1a1814));
      parts.push(scorch);
      const ring = new THREE.RingGeometry(6.4, 7.0, 32);
      xform(ring, { x: sp.x, y: y0 + 0.04, z: sp.z }, new THREE.Euler(-Math.PI / 2, 0, 0));
      paint(ring, new THREE.Color(0x3a4a3a));
      parts.push(ring);
      const spawnMesh = new THREE.Mesh(merge(parts), concreteMat);
      spawnMesh.receiveShadow = true; spawnMesh.name = 'spawn_marker';
      this.addMesh(spawnMesh);

      const beacons: THREE.BufferGeometry[] = [];
      const posts: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k / 4) * Math.PI * 2;
        const bx = sp.x + Math.cos(a) * 8.5, bz = sp.z + Math.sin(a) * 8.5;
        const by = ctx.terrain.getHeightAt(bx, bz);
        const post = new THREE.CylinderGeometry(0.08, 0.12, 1.2, 6);
        xform(post, { x: bx, y: by + 0.6, z: bz });
        paint(post, metal);
        posts.push(post);
        const cap = new THREE.SphereGeometry(0.16, 8, 6);
        xform(cap, { x: bx, y: by + 1.28, z: bz });
        beacons.push(cap);
      }
      const postMesh = new THREE.Mesh(merge(posts), metalMat);
      postMesh.name = 'spawn_posts';
      this.addMesh(postMesh);
      const beaconMesh = new THREE.Mesh(merge(beacons), this.spawnBeaconMat);
      beaconMesh.name = 'spawn_beacons';
      this.addMesh(beaconMesh);
    }

    ctx.root.add(this.group);
  }

  private addMesh(m: THREE.Mesh): void {
    this.meshes.push(m);
    this.group.add(m);
  }

  update(time: number): void {
    if (this.edgeLightMat) this.edgeLightMat.emissiveIntensity = 1.4 + Math.max(0, Math.sin(time * 3.0)) * 1.6;
    if (this.spawnBeaconMat) this.spawnBeaconMat.emissiveIntensity = 1.0 + Math.max(0, Math.sin(time * 4.0)) * 1.5;
  }

  dispose(): void {
    for (const m of this.meshes) { m.geometry.dispose(); this.group.remove(m); }
    this.meshes.length = 0;
    for (const l of this.lights) { this.group.remove(l); l.dispose(); }
    this.lights.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.edgeLightMat = this.lampMat = this.spawnBeaconMat = null;
    this.group.removeFromParent();
  }
}
