/**
 * src/world/structures/parts/Stairs.ts — **계단 한 줄** (보이는 단 + 경사 콜라이더, 2026-09-11).
 *
 * 사용자 요청: "계단지형을 올라갈때 뚝뚝 끊기지 않고, 스르륵 올라가도록". 예전 계단은 단마다 상자 콜라이더였고
 * 몸은 `getSurfaceY` 로 한 단씩 **튀어** 올랐다. 이제 콜라이더는 **경사면 하나**(`Obstacle.ramp`)이고 단은 그림일
 * 뿐이다. 경사면은 **디딤판 한가운데**를 잇는 선이다 — 단 모서리를 이으면 발이 디딤판 위로 반 단 떠 보이고,
 * 한가운데를 이으면 가장자리에서만 반 단 파묻힌다. 위 · 아래 끝은 정확히 두 층의 바닥 높이와 만난다.
 *
 * 구조물(지하실 · 1→2층)과 선로 플랫폼이 같은 함수를 쓴다.
 */
import * as THREE from 'three';
import type { Random } from '@/shared';
import { type BuildCtx, paintGradient, xform } from '../../build';
import { STAIR_STEP_RISE } from '../model';

export interface StairFlight {
  /** 높은 쪽 끝(위층 바닥과 만나는 가장자리)의 가운데 (월드 XZ). */
  hx: number;
  hz: number;
  /** 높은 쪽 → 낮은 쪽 수평 단위 벡터. */
  ux: number;
  uz: number;
  width: number;
  /** 수평 길이(m). */
  run: number;
  topY: number;
  bottomY: number;
  /** 단 덩어리의 밑면 — 없으면 `bottomY`. 함수면 그 자리의 밑면 (플랫폼 계단은 지형에서 올라온다). */
  solidY?: number | ((x: number, z: number) => number);
  /** 보이는 한 단 높이(m). 없으면 `STAIR_STEP_RISE`. */
  stepRise?: number;
  dark: THREE.Color;
  light: THREE.Color;
  kind: string;
}

/**
 * 계단을 그리고(`parts` 에 조각을 넣는다) 경사 콜라이더를 건다. 단은 전부 밑면에서 올라오는 덩어리라 밑에 틈이 없다.
 */
export function buildStairFlight(ctx: BuildCtx, parts: THREE.BufferGeometry[], _rng: Random, f: StairFlight): void {
  const rise = f.topY - f.bottomY;
  if (rise <= 0.02 || f.run <= 0.05) return;
  const n = Math.max(2, Math.round(rise / Math.max(0.1, f.stepRise ?? STAIR_STEP_RISE)));
  const tread = f.run / n;
  const yaw = Math.atan2(-f.uz, -f.ux);              // 오르는 방향 = 로컬 +X (수학 규약)
  let baseMin = f.bottomY;
  for (let i = 0; i < n; i++) {
    const off = tread * (i + 0.5);
    const px = f.hx + f.ux * off, pz = f.hz + f.uz * off;
    const top = f.topY - (rise * (i + 0.5)) / n;
    const solid = typeof f.solidY === 'function' ? f.solidY(px, pz) : (f.solidY ?? f.bottomY);
    const base = Math.min(solid, top - 0.08);
    if (base < baseMin) baseMin = base;
    const h = Math.max(0.05, top - base);
    const g = new THREE.BoxGeometry(tread + 0.02, h, f.width);
    xform(g, { x: px, y: base + h / 2, z: pz }, new THREE.Euler(0, -yaw, 0));
    paintGradient(g, f.dark, f.light, base, top);
    parts.push(g);
  }
  const cx = f.hx + f.ux * (f.run / 2), cz = f.hz + f.uz * (f.run / 2);
  const baseY = Math.min(baseMin, f.bottomY) - 0.02;
  ctx.hash.addRamp(new THREE.Vector3(cx, baseY, cz), f.run / 2, f.width / 2, yaw, f.topY - baseY, rise, f.kind);
}
