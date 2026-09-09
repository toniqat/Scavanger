/**
 * src/world/hazard/parts/Grove.ts — **거대 버섯 군락** (독성 포자의 발생지).
 *
 * 포자가 피어오를 자리에는 지형지물이 서 있어야 한다 (사용자 요구). 멀리서도 "저기가 터진다" 로 읽히도록
 * 갓 밑면 · 밑동 통풍구가 발광하고, 갓은 시간에 따라 천천히 숨쉰다.
 *
 * **콜라이더는 줄기뿐이다.** 갓은 4~9 m 상공에 지름 5~9 m 로 떠 있어서 실루엣 폭으로 원기둥을 잡으면
 * 지면에 보이지 않는 벽이 서고 총알이 허공에서 멈춘다 — `Props.ts` 의 나무가 같은 이유로 줄기 반경만
 * 쓰는 것과 정확히 같은 판단이다 (CLAUDE.md "콜라이더 = 보이는 실루엣").
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

/** 하나의 군락 (발생지 하나에 하나). */
export interface GroveDef {
  id: string;
  position: THREE.Vector3;
  radius: number;
}

/**
 * 군락 전부를 **두 개의 메시**(본체 · 발광)로 세운다. 정적이라 한 번 병합하면 끝이고, 갓 밑면 발광만
 * `update` 에서 맥동한다.
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

  /** `spots` = 포자 발생지 자리. 빈 배열이면 아무것도 만들지 않는다. */
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
        // 첫 하나는 군락 한가운데, 나머지는 고리 안에 흩어진다
        const ang = rng.range(0, Math.PI * 2);
        const d = i === 0 ? 0 : GROVE_RADIUS * Math.sqrt(rng.range(0.08, 1));
        const x = s.x + Math.cos(ang) * d, z = s.z + Math.sin(ang) * d;
        const y = ctx.terrain.getHeightAt(x, z);
        const stemR = rng.range(GROVE_STEM_R_MIN, GROVE_STEM_R_MAX) * (i === 0 ? 1.25 : 1);
        const stemH = rng.range(GROVE_STEM_H_MIN, GROVE_STEM_H_MAX) * (i === 0 ? 1.15 : 1);
        const capR = stemR * rng.range(GROVE_CAP_MUL_MIN, GROVE_CAP_MUL_MAX);
        const lean = rng.range(0, 0.12);
        const leanAng = rng.range(0, Math.PI * 2);

        // 줄기: 밑동이 굵고 위로 갈수록 가늘어진다
        const stalk = new THREE.CylinderGeometry(stemR * 0.72, stemR * 1.15, stemH, 9, 1);
        xform(stalk, { x: 0, y: stemH * 0.5, z: 0 });
        paintGradient(stalk, STALK_LOW, STALK_HIGH);
        body.push(place(stalk, x, y, z, lean, leanAng));

        // 갓: 반구를 눌러 놓은 것 + 테두리 링
        const cap = new THREE.SphereGeometry(capR, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.52);
        xform(cap, { x: 0, y: stemH, z: 0 }, undefined, { x: 1, y: 0.5 + rng.range(0, 0.2), z: 1 });
        paintGradient(cap, CAP_RIM, CAP_TOP);
        body.push(place(cap, x, y, z, lean, leanAng));

        // 갓 밑면(주름) — 발광. 이게 밤에도 군락을 읽히게 하는 실루엣이다.
        const gills = new THREE.CylinderGeometry(capR * 0.94, capR * 0.5, 0.12, 16, 1, true);
        xform(gills, { x: 0, y: stemH - 0.16, z: 0 });
        paint(gills, glowColor);
        glow.push(place(gills, x, y, z, lean, leanAng));

        /* 콜라이더는 **줄기 하나**다 (갓은 공중에 있다 — 파일 머리말 참고). 총알 실린더도 같은 값이라
         * 보이는 줄기 밖에서 탄이 멈추지 않는다. */
        ctx.hash.add(new THREE.Vector3(x, y, z), stemR * 1.05, stemH, 'grove');
      }

      // 밑동의 포자 통풍구: 낮은 원반 몇 장 (콜라이더 없음 — 밟고 지나간다)
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
 * 지오메트리를 군락 자리로 옮기고 살짝 기울인다. 지오메트리의 원점이 밑동이라 **회전 순서는
 * 기울이기(X) → 방향 돌리기(Y)** 다 — 뒤집으면 기우는 방향이 언제나 월드 +X 로 고정된다.
 */
function place(geo: THREE.BufferGeometry, x: number, y: number, z: number, lean: number, leanAng: number): THREE.BufferGeometry {
  if (lean > 0.001) {
    xform(geo, undefined, new THREE.Euler(lean, 0, 0));
    xform(geo, undefined, new THREE.Euler(0, leanAng, 0));
  }
  return xform(geo, { x, y, z });
}
