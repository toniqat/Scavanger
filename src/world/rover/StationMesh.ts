/**
 * src/world/rover/StationMesh.ts — 탐사 차량 **정류장 표지 기둥** (R1, 2026-09-13).
 *
 * 정류장마다: 강철 기둥(`ROVER_POLE_HEIGHT_M`) · 받침 · 경고 띠 · 꼭대기 캡 + **발광 비콘**(광원 아님 — 레이드 점광원 예산 여분 0) +
 * 흙길을 향한 표지판(앞뒤 두 장, 글자는 정류장 문자 하나 — 전 정류장이 CanvasTexture **아틀라스 한 장**을 나눠 쓴다).
 * 세 덩어리(몸통 · 비콘 · 표지판)로 합쳐 드로우콜이 정류장 수와 무관하게 3이다. 콜라이더는 `Pads` 의 기둥과 같은 모양
 * (낮은 받침 원기둥 — 올라설 수 있다 + 가는 기둥).
 */
import * as THREE from 'three';
import { ROVER_POLE_HEIGHT_M, type RoverStationDef } from '@/shared';
import type { BuildCtx } from '../build';
import { merge, paint, xform } from '../build';

const STEEL = new THREE.Color(0x5d636b);
const DARK = new THREE.Color(0x2c3036);
const FRAME = new THREE.Color(0x3a3f46);
const STRIPE = new THREE.Color(0xc28a2a);
const LETTERS = 'ABCDEFGH';
/** 표지판 크기(m) — 아틀라스 칸의 가로세로비와 같다. */
const SIGN_W = 1.3;
const SIGN_H = 1.0;
/** 표지판이 기둥에서 흙길 쪽으로 나온 거리(m). */
const SIGN_OUT = 0.16;

export interface StationBuild {
  body: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  signs: THREE.BufferGeometry;
  tex: THREE.CanvasTexture;
}

/** 정류장 index → 표시 문자 (`정류장 A`). */
export function stationLetter(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}

export function buildStationGeometry(bctx: BuildCtx, stations: readonly RoverStationDef[]): StationBuild {
  const H = ROVER_POLE_HEIGHT_M;
  const n = Math.max(1, stations.length);
  const body: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  const signs: THREE.BufferGeometry[] = [];
  for (const st of stations) {
    const px = st.polePosition.x, py = st.polePosition.y, pz = st.polePosition.z;
    let dx = st.position.x - px, dz = st.position.z - pz;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    const yaw = Math.atan2(dx, dz);              // PlaneGeometry 의 +Z 법선이 흙길을 본다
    const rot = new THREE.Euler(0, yaw, 0);
    body.push(paint(xform(new THREE.CylinderGeometry(0.1, 0.13, H, 10), { x: px, y: py + H / 2, z: pz }), STEEL));
    body.push(paint(xform(new THREE.BoxGeometry(0.6, 0.35, 0.6), { x: px, y: py + 0.175, z: pz }, rot), DARK));
    body.push(paint(xform(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 10), { x: px, y: py + 1.3, z: pz }), STRIPE));
    body.push(paint(xform(new THREE.CylinderGeometry(0.24, 0.24, 0.08, 10), { x: px, y: py + H + 0.04, z: pz }), DARK));
    const signY = py + H - 1.55;
    body.push(paint(xform(
      new THREE.BoxGeometry(SIGN_W + 0.16, SIGN_H + 0.16, 0.08),
      { x: px + dx * SIGN_OUT, y: signY, z: pz + dz * SIGN_OUT }, rot,
    ), FRAME));
    glow.push(xform(new THREE.CylinderGeometry(0.15, 0.15, 0.34, 10), { x: px, y: py + H + 0.25, z: pz }));
    const u0 = st.index / n, u1 = (st.index + 1) / n;
    for (const side of [1, -1]) {
      const g = new THREE.PlaneGeometry(SIGN_W, SIGN_H);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
      const off = SIGN_OUT + side * 0.045;
      xform(g, { x: px + dx * off, y: signY, z: pz + dz * off }, new THREE.Euler(0, side > 0 ? yaw : yaw + Math.PI, 0));
      signs.push(g);
    }
    // `Pads` 의 신호 기둥과 같은 짝: 올라설 수 있는 낮은 받침 + 가는 기둥
    bctx.hash.add(new THREE.Vector3(px, py, pz), 0.4, 0.35, 'pole');
    bctx.hash.add(new THREE.Vector3(px, py + 0.35, pz), 0.18, H - 0.05, 'pole');
  }
  return { body: merge(body), glow: merge(glow), signs: merge(signs), tex: makeAtlas(stations.length) };
}

/** 정류장 문자 아틀라스 — 칸 하나 = 표지판 하나 (노란 바탕 · 검은 테두리 · 위 띠 「정류장」 · 큰 문자). */
function makeAtlas(count: number): THREE.CanvasTexture {
  const n = Math.max(1, count);
  const cw = 130, ch = 100;
  const canvas = document.createElement('canvas');
  canvas.width = cw * n; canvas.height = ch;
  const c = canvas.getContext('2d')!;
  for (let i = 0; i < n; i++) {
    const x0 = i * cw;
    c.fillStyle = '#d9a531';
    c.fillRect(x0, 0, cw, ch);
    c.fillStyle = '#23262b';
    c.fillRect(x0, 0, cw, 24);
    c.lineWidth = 6;
    c.strokeStyle = '#23262b';
    c.strokeRect(x0 + 3, 3, cw - 6, ch - 6);
    c.fillStyle = '#f2efe6';
    c.font = 'bold 15px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('탐사 차량 정류장', x0 + cw / 2, 13);
    c.fillStyle = '#1b1d21';
    c.font = 'bold 62px sans-serif';
    c.fillText(stationLetter(i), x0 + cw / 2, 62);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
