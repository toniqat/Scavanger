import * as THREE from 'three';
import { Layers, type NestEggSpot } from '@/shared';
import { type BuildCtx, displace, merge, paintGradient, xform } from './build';

/**
 * Terminid-style bug nests: organic mounds with glowing holes, spikes and egg sacs at each nest pad.
 * Mounds are obstacles; hole positions are exposed for enemy spawning.
 *
 * 2026-09-18 (사용자 결정 「둥지의 보상은 부술 수 있는 알」) — **알은 더 이상 이 파일이 그리지 않는다.**
 * 알 자루는 장식(병합된 `nest_eggs` 메시)이 아니라 움직이지 못하는 파괴 가능한 적 `bug_egg` 가 됐다.
 * 자리를 정하는 주인은 그대로 여기다 (「어디에 알이 서는가」는 월드의 몫) — 그 자리에 몸을 세우고
 * 부수는 것은 권위(`src/enemies`)다. 그래서 `getEggSpots()` 만 남고 메시 · 재질은 사라졌다.
 *
 * 옛 모습의 수치(새 주인 `enemies/` 의 `bug_egg` 몸이 이것을 그대로 재현한다):
 *   - 세로 그러데이션 `0xb8a070`(밑) → `0xe0d0a0`(위), emissive `0x6a5020` × 0.25
 *   - `SphereGeometry(er, 8, 6)` 를 y 로 ×1.2 늘린 모양, 중심이 지면 + `er × 0.6`
 *   - roughness 0.35 · metalness 0 · `castShadow`
 */
export class Nests {
  readonly group = new THREE.Group();
  private holes: THREE.Vector3[] = [];
  /** 2026-09-18: 알 자리 (둥지 pad 순번 포함) — `WorldRef.getNestEggSpots` 가 그대로 넘긴다. */
  private eggs: NestEggSpot[] = [];
  private meshes: THREE.Mesh[] = [];
  private bodyMat: THREE.MeshStandardMaterial | null = null;
  private glowMat: THREE.MeshStandardMaterial | null = null;

  constructor() { this.group.name = 'Nests'; }

  getHolePositions(): readonly THREE.Vector3[] { return this.holes; }

  /**
   * 2026-09-18: 알 자리. `nest` 는 **둥지 pad 의 순번**(`ctx.layout.nests` 의 인덱스)이다 —
   * `getHolePositions()` 는 pad 하나마다 둔덕(구멍)이 4~6 개라 순번이 다르다. 「둥지별 재스폰」을
   * 묶는 번호라 사람이 「둥지」라 부르는 단위(pad)에 맞췄다. 구멍 자리를 찾으려면 이 번호로
   * `getNestPositions()` 를 색인하면 **안 된다** (섞인다).
   */
  getEggSpots(): readonly NestEggSpot[] { return this.eggs; }

  build(ctx: BuildCtx): void {
    const rng = ctx.rng.fork('nests');
    const noise = ctx.noise;
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
    this.glowMat = new THREE.MeshStandardMaterial({ color: 0x1a0604, emissive: new THREE.Color(0xff6a1a), emissiveIntensity: 1.6, roughness: 0.4 });

    const dark = new THREE.Color(0x2a0e0a), mid = new THREE.Color(0x6a2a1c), light = new THREE.Color(0x9a4a30);

    for (let ni = 0; ni < ctx.layout.nests.length; ni++) {
      const pad = ctx.layout.nests[ni];
      const body: THREE.BufferGeometry[] = [];
      const glow: THREE.BufferGeometry[] = [];
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

        /* 알 자루 — 둔덕 밑동 둘레. 2026-09-18 부터 **자리만 적는다** (메시는 `enemies/` 의 `bug_egg` 가 그린다).
         * rng 를 뽑는 **순서와 횟수는 옛날 그대로**여야 한다 — 같은 시드가 같은 맵이어야 하므로 (`build.ts` 의 fork 규칙).
         * `position` 은 옛 메시의 **중심**이다 (지면 + `er × 0.6`) — 새 주인이 그 점에 구를 놓으면 눈에 보이는 변화가 없다.
         * 알에는 콜라이더가 없었고 지금도 월드는 만들지 않는다 (적의 몸이 곧 히트박스다). */
        const nEggs = rng.int(2, 5);
        for (let e = 0; e < nEggs; e++) {
          const ang = rng.range(0, Math.PI * 2);
          const d = m.r * rng.range(0.95, 1.35);
          const er = rng.range(0.35, 0.7);
          const ex = m.x + Math.cos(ang) * d, ez = m.z + Math.sin(ang) * d;
          this.eggs.push({ position: new THREE.Vector3(ex, ctx.terrain.getHeightAt(ex, ez) + er * 0.6, ez), nest: ni, radius: er });
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
      this.meshes.push(bodyMesh, glowMesh);
      this.group.add(bodyMesh, glowMesh);
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
    this.eggs.length = 0;
    this.bodyMat?.dispose(); this.glowMat?.dispose();
    this.bodyMat = this.glowMat = null;
    this.group.removeFromParent();
  }
}
