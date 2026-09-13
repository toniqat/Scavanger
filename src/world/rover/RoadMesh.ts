/**
 * src/world/rover/RoadMesh.ts — 탐사 차량 **흙길 그림** (R1, 2026-09-13). 콜라이더 없음.
 *
 * 중심선 점마다 가로 10개 정점 한 줄: 가장자리(지형 색) → 다져진 흙 → 바퀴자국(어두운 V) → 흙 → … → 가장자리.
 * 정점 높이는 경로의 평활화한 노면이 아니라 **그 자리 지형**(`getHeightAt`) + `ROVER_ROAD_LIFT_M` 이다 — 그림은 땅에 붙어야 하고,
 * 차량(R2)은 경로 `y` 를 탄다. 법선도 지형 법선이라 조명이 지형과 이어진다. 정류장 표지 기둥 밑의 자갈 원판도 같은 메시에 넣는다.
 */
import * as THREE from 'three';
import { ROVER_POLE_OFFSET_M, ROVER_ROAD_HALF_WIDTH_M, ROVER_ROAD_LIFT_M, type RoverStationDef } from '@/shared';
import type { Biome } from '../biomes';
import type { Terrain } from '../Terrain';

/** 자갈 원판의 둘레 분할 수. */
const PAD_SEGS = 14;

export function buildRoadGeometry(
  terrain: Terrain, pts: readonly THREE.Vector3[], stations: readonly RoverStationDef[], biome: Biome,
): THREE.BufferGeometry {
  const W = ROVER_ROAD_HALF_WIDTH_M;
  const lift = ROVER_ROAD_LIFT_M;
  const rut = Math.min(1.1, W * 0.45);
  const OFF = [-W, -W + 0.55, -rut - 0.4, -rut, -rut + 0.36, rut - 0.36, rut, rut + 0.4, W - 0.55, W];
  const edge = biome.ground.clone();
  const dirt = biome.ground.clone().lerp(biome.low, 0.5).multiplyScalar(0.9);
  dirt.r = Math.min(1, dirt.r * 1.04);
  const dark = dirt.clone().multiplyScalar(0.6);
  const gravel = biome.rock.clone().lerp(dirt, 0.35).multiplyScalar(0.95);
  const COL = [edge, dirt, dirt, dark, dirt, dirt, dark, dirt, dirt, edge];
  const L = OFF.length;
  const M = pts.length;
  const padVerts = stations.length * (PAD_SEGS + 1);
  const vCount = M * L + padVerts;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const idx = new Uint32Array(M * (L - 1) * 6 + stations.length * PAD_SEGS * 3);
  const n = new THREE.Vector3();
  let v = 0;
  const put = (x: number, z: number, c: THREE.Color, shade: number, yOff: number): void => {
    pos[v * 3] = x; pos[v * 3 + 1] = terrain.getHeightAt(x, z) + yOff; pos[v * 3 + 2] = z;
    terrain.getNormalAt(x, z, n);
    nor[v * 3] = n.x; nor[v * 3 + 1] = n.y; nor[v * 3 + 2] = n.z;
    col[v * 3] = Math.min(1, c.r * shade); col[v * 3 + 1] = Math.min(1, c.g * shade); col[v * 3 + 2] = Math.min(1, c.b * shade);
    v++;
  };
  for (let i = 0; i < M; i++) {
    const a = pts[(i - 1 + M) % M], b = pts[(i + 1) % M], p = pts[i];
    const tl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / tl, nz = (b.x - a.x) / tl;
    // 결정적 얼룩 — 표본마다 흙 밝기가 조금씩 다르다 (rng 를 소비하지 않는다)
    const shade = 0.94 + 0.12 * fract(Math.sin(i * 12.9898 + 4.1) * 43758.5453);
    for (let j = 0; j < L; j++) put(p.x + nx * OFF[j], p.z + nz * OFF[j], COL[j], j === 0 || j === L - 1 ? 1 : shade, lift);
  }
  let t = 0;
  for (let i = 0; i < M; i++) {
    const r0 = i * L, r1 = ((i + 1) % M) * L;
    for (let j = 0; j < L - 1; j++) {
      idx[t++] = r0 + j; idx[t++] = r1 + j; idx[t++] = r0 + j + 1;
      idx[t++] = r0 + j + 1; idx[t++] = r1 + j; idx[t++] = r1 + j + 1;
    }
  }
  /* 표지 기둥 밑 자갈 원판 — 흙길 가장자리에 닿는 크기 */
  const padR = Math.max(0.8, ROVER_POLE_OFFSET_M - W + 0.25);
  for (const st of stations) {
    const c0 = v;
    put(st.polePosition.x, st.polePosition.z, gravel, 1, lift * 1.5);
    for (let k = 0; k < PAD_SEGS; k++) {
      const ang = (k / PAD_SEGS) * Math.PI * 2;
      put(st.polePosition.x + Math.cos(ang) * padR, st.polePosition.z + Math.sin(ang) * padR, gravel, 0.85, lift * 1.5);
    }
    for (let k = 0; k < PAD_SEGS; k++) {
      idx[t++] = c0; idx[t++] = c0 + 1 + ((k + 1) % PAD_SEGS); idx[t++] = c0 + 1 + k;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

function fract(x: number): number { return x - Math.floor(x); }
