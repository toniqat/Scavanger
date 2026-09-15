import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  ABYSS_CUT_Z0, ABYSS_DRAW_BOTTOM_Y, ABYSS_EDGE_Z, ABYSS_FADE_TOP_Y, ABYSS_RUN_M, ABYSS_WALL_DROP_L, ABYSS_WALL_DROP_R,
  ABYSS_WALL_STEP_M, CHASM, CHASM_EDGE,
  CHASM_FLOOR_Y, CHASM_GAP_Z, CHASM_NEAR_Z, CHASM_TILT, CORRIDOR_MAX_HALF_X, CORRIDOR_OUTER_X, CORRIDOR_PROFILE, DECKS,
  DECK_LOWER_Y, DECK_TILE_M, DECK_UPPER_Y, PIT, PIT_DEPTH, PIT_FLOOR_Y, PIT_RAMP_OVERLAP, PIT_RAMP_RUN, PIT_RAMP_TOE_X,
  PIT_WALLS, SHIP_HILL_RISE, SHIP_HILL_Y, SHIP_SLOPE, SHIP_SLOPE_RUN, TILE_OVERLAP, VOID_Y, WALL_DESCENT_FROM_Z,
  WALL_DESCENT_RATE_L, WALL_DESCENT_RATE_R, WALL_DESCENT_STEP_M, WALL_MIN_ABOVE_WALK_M, WALL_PLAIN_FROM_Z, WALL_T, WALL_TOP_Y,
  Z_START, box, chasmFarZAt, chasmNearZAt, growRect, rectBox, shipHillSurfaceY, tileRect, type Rect,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 행성의 **땅** — 협곡 바닥 · 데크 · 양옆 절벽 벽 · 뒤쪽 막다른 끝 · 함선 앞의 끝없는 절벽(2026-09-15) ·
 * 마지막 구간의 **안드로이드 웅덩이 + 벽**(2026-09-15 2차 · 3차, `buildPit`) · **철조망 너머의 절벽 구멍**(3차, `model.ts` 의 `ABYSS_CUTS` —
 * 땅은 `DECKS` 의 아래 데크 조각들이 비워 두는 것으로 생기고 여기서는 그 조각들의 절벽 면을 그린다).
 *
 * 2026-09-15 3차 — **아래 데크 조각 · 웅덩이 벽 · 구멍 곁의 옆 벽은 전부 절벽 면을 가질 수 있다**: 돌결 몸통을 `ABYSS_FADE_TOP_Y`
 * 부터 그리고 그 밑을 어두워지는 띠(`pushCliff` → `this.fade`)로 잇는다 — 함선 앞 가장자리에만 붙이던 절벽 판(옛 `buildAbyss` ①)을
 * 모든 아래 조각으로 일반화한 것이라 구멍이 어느 방향으로 뚫려도 −100 에서 뚝 끊기는 바위 밑면이 보이지 않는다.
 *
 * 2026-09-16 (사용자 결정) — 철조망 너머는 **길 · 함선 언덕 · 웅덩이 섬** 말고 전부 절벽이다: 방벽 먼 면을 따라 1 m 계단으로 끝나는 통로 조각들
 * (`model.ts` 의 `DECKS` · `ABYSS_CUTS`), 함선이 서는 **0.9 m 언덕**과 거기로 오르는 오르막(`buildShipSlope`), 철조망 끝부터 **낮아지는 옆 벽**
 * (왼쪽이 빠르고 오른쪽이 완만하다 — `addDescentWall`, 가장자리 너머 `buildAbyss` 가 그 높이에서 이어 내려간다).
 *
 * 콜라이더와 그림이 갈라져 있다:
 *   - **콜라이더**는 `DECK_TILE_M` 짜리 사각 타일 (`SpatialHash.addBox`). 한 장으로 넣으면 외접원이 85 m 가 되어
 *     `maxRadius` 가 그만큼 커지고 **모든** 해시 질의가 한 프레임마다 수백 칸을 훑는다.
 *   - **그림**은 데크 사각형마다 상자 하나 + 윗면 판 하나. 타일 경계마다 메시를 나눌 이유가 없다.
 * 광원은 **하나도 만들지 않는다** (`CLAUDE.md`: 씬의 광원 개수를 플레이 중에 바꾸지 않는다) — 전부 emissive 다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 협곡 바닥 판이 덮는 반폭. 2026-09-15 `CORRIDOR_OUTER_X + 6` → **벽 바깥 면까지만**: 함선 앞 끝없는 절벽에서는 옆 벽이
 * 낮아지므로, 벽 바깥으로 삐져나온 6 m 띠가 그 너머로 **떠 있는 바닥 조각**처럼 보였다. 벽 몸통이 `VOID_Y` 까지 내려가므로
 * 덮을 곳이 줄지 않는다.
 */
const FLOOR_HALF_X = CORRIDOR_OUTER_X;
/**
 * 옆 벽이 낮아지는 마지막 구간(`WALL_DESCENT_FROM_Z` 부터)의 윗면 — z 는 그 조각의 **앞 끝**(가장 낮은 쪽). 속도 · 바닥값 근거는 `model.ts` 의
 * `WALL_DESCENT_*` · `WALL_MIN_ABOVE_WALK_M` 주석. `jitter` 는 계단이 너무 반듯하지 않게 빼는 높이이고, 왼쪽은 **그 뒤에** 바닥값으로 자른다
 * (길 · 언덕 곁에서 올라설 수 없어야 한다). 가장자리 너머(`buildAbyss`)는 jitter 0 인 가장자리 값에서 이어 내려간다.
 */
function descentTop(sx: number, z: number, jitter = 0): number {
  const run = Math.max(0, WALL_DESCENT_FROM_Z - z);
  if (sx < 0) return Math.max(WALL_TOP_Y - WALL_DESCENT_RATE_L * run - jitter, SHIP_HILL_Y + WALL_MIN_ABOVE_WALK_M);
  return WALL_TOP_Y - WALL_DESCENT_RATE_R * run - jitter;
}
/** 가장자리 너머 벽 조각마다 안쪽 면이 바깥으로 벌어지는 폭 (m) — 협곡이 끝나 트이는 모습. 마지막 조각 안쪽 면 17.9. */
const ABYSS_WALL_FLARE_M = 0.5;
/**
 * 절벽 면 그라데이션을 나누는 높이 — 정점 색이 `((y − 바닥) / 폭)^2.2` 곡선을 **꺾은선으로** 따라가게 한다. 상자 한 장은
 * 윗면 · 밑면 정점뿐이라 380 m 를 한 장으로 그리면 그라데이션이 직선이 되어, 가장자리에서 내려다보이는 60 m 안에서는
 * 거의 어두워지지 않는다. (−90 에서 0.73 · −160 에서 0.43 · −260 에서 0.15 · 바닥 0)
 */
const ABYSS_FADE_BANDS: readonly number[] = [ABYSS_FADE_TOP_Y, -90, -160, -260, ABYSS_DRAW_BOTTOM_Y];
/** 그라데이션 윗단의 색 = `cliffTexture` 의 바탕색 (색 관리가 sRGB hex 를 선형으로 옮긴다). 돌결 벽과 이음매가 튀지 않는다. */
const ABYSS_TOP_COLOR = new THREE.Color(0x3a342c);

/** 정점 y 에 따라 어두워지는 정점 색을 단다 (`ABYSS_FADE_BANDS` 주석의 곡선). */
function shadeAbyss(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const span = ABYSS_FADE_TOP_Y - ABYSS_DRAW_BOTTOM_Y;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - ABYSS_DRAW_BOTTOM_Y) / span));
    const k = Math.pow(t, 2.2);
    col[i * 3] = ABYSS_TOP_COLOR.r * k;
    col[i * 3 + 1] = ABYSS_TOP_COLOR.g * k;
    col[i * 3 + 2] = ABYSS_TOP_COLOR.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
/** 곧은 절벽 벽 한 조각의 z 길이 — 이 간격마다 안쪽 면 · 윗면을 흔들어 복도처럼 보이지 않게 한다. */
const WALL_SEG_M = 10;
/** 데크 윗면 판을 띄우는 높이 (콜라이더 윗면과 z-fighting 하지 않게). */
const TOP_LIFT = 0.02;
/**
 * 절벽 1 의 **사선 판** 윗면을 띄우는 높이. 사선 판은 축 정렬 데크와 겹치는데(축 정렬 사각형으로 사선을
 * 담을 수 없어서 — `CHASM_EDGE` 주석), 둘의 윗면 판이 같은 높이면 그 겹친 삼각형에서 z-fighting 이 인다.
 * 3 cm 만 올려 두면 겹친 데서는 사선 판이 이기고(같은 바닥 텍스처라 이음매가 보이지 않는다) 나머지는
 * 그대로다. 걸어 다니는 높이는 **양쪽 콜라이더 모두 `DECK_UPPER_Y`** 라 한 치도 안 바뀐다.
 */
const CHASM_TOP_LIFT = TOP_LIFT + 0.03;
/**
 * 웅덩이 바닥 몸통을 `PIT` 보다 사방 이만큼 크게 그린다 — 옆면이 남은 데크 띠의 옆면과 같은 평면에 놓이지 않게
 * (둘 다 가려지는 자리이지만 z-fighting 의 씨앗을 남기지 않는다). **콜라이더는 `PIT` 그대로**다.
 */
const FLOOR_BURY = 0.05;
/**
 * 웅덩이 오르막 **그림** 상자의 두께 (경사면 법선 방향). 높은 쪽 끝의 밑면이 `DECK_LOWER_Y − T/cos(19.8°)` = −11.28 로
 * 웅덩이 바닥(−10.9)보다 낮아야 옆에서 볼 때 경사면 밑이 비어 보이지 않는다.
 */
const RAMP_T = 1.2;
/** 오르막 **콜라이더**(쐐기)의 밑면이 웅덩이 바닥보다 얼마나 아래인가 — 그 밑으로 지나갈 자리가 없게만 하면 된다. */
const RAMP_COLLIDER_DROP = 1;

function groundTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a5044'; g.fillRect(0, 0, S, S);
  // 돌결 얼룩
  for (let i = 0; i < 220; i++) {
    const x = (i * 71) % S, y = (i * 137) % S, r = 4 + ((i * 29) % 26);
    g.fillStyle = i % 3 === 0 ? 'rgba(110,98,82,0.30)' : 'rgba(58,50,41,0.26)';
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, (i % 7) * 0.45, 0, Math.PI * 2); g.fill();
  }
  // 갈라진 틈
  g.strokeStyle = 'rgba(32,27,22,0.55)'; g.lineWidth = 2;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = (i * 53) % S, y = (i * 97) % S;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += ((i + k) % 5) * 11 - 18; y += ((i * k) % 6) * 9 + 6; g.lineTo(x, y); }
    g.stroke();
  }
  // 잔모래
  g.fillStyle = 'rgba(150,136,112,0.22)';
  for (let i = 0; i < 400; i++) g.fillRect((i * 181) % S, (i * 61) % S, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cliffTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a342c'; g.fillRect(0, 0, S, S);
  // 수평 지층
  for (let y = 0; y < S; y += 9) {
    g.fillStyle = `rgba(${26 + ((y * 7) % 40)},${22 + ((y * 5) % 34)},${18 + ((y * 3) % 28)},0.5)`;
    g.fillRect(0, y, S, 4 + ((y * 11) % 5));
  }
  // 세로 균열
  g.strokeStyle = 'rgba(18,15,12,0.7)'; g.lineWidth = 3;
  for (let i = 0; i < 10; i++) {
    let x = (i * 27) % S;
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y < S; y += 24) { x += ((i + y) % 5) * 4 - 8; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 윗면 판 하나 (`rect` 크기에 맞춰 텍스처를 반복한다).
 * 2026-09-16: 텍스처를 **월드 좌표에 맞춘다** (`offset` = 판의 모서리 / 8 m) — 철조망 너머 계단(`model.ts` 의 `DECKS`)이 1 m 폭 조각으로
 * 나뉘어 있어, 판마다 무늬가 모서리에서 새로 시작하면 이음매마다 줄무늬가 보인다. `PlaneGeometry` 를 눕히면 u 는 +X, v 는 −Z 로 늘어나므로
 * u' = (x − x0)/8 + x0/8 = x/8 · v' = (z0 − z)/8 − z0/8 = −z/8 — 이웃 판과 같은 값이다.
 */
function topPlane(rect: Rect, y: number, tex: THREE.CanvasTexture): THREE.Mesh {
  const mesh = topQuad((rect.x0 + rect.x1) / 2, y, (rect.z0 + rect.z1) / 2, rect.x1 - rect.x0, rect.z0 - rect.z1, 0, tex);
  (mesh.material as THREE.MeshStandardMaterial).map!.offset.set(rect.x0 / 8, -rect.z0 / 8);
  return mesh;
}

/**
 * 윗면 판 하나 — 가운데 · 크기 · `rotateY` 로 (사선 판은 yaw ≠ 0).
 * `tiltZ` 는 Z 축 기울기 (웅덩이 오르막 — 음수면 +X 쪽이 내려간다), `tiltX` 는 X 축 기울기 (함선 언덕 오르막 — 양수면 −Z 쪽이 올라간다).
 */
function topQuad(
  cx: number, y: number, cz: number, w: number, d: number, yaw: number, tex: THREE.CanvasTexture, tiltZ = 0, tiltX = 0,
): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  if (yaw !== 0) geo.rotateY(yaw);
  if (tiltZ !== 0) geo.rotateZ(tiltZ);
  if (tiltX !== 0) geo.rotateX(tiltX);
  geo.translate(cx, y, cz);
  const map = tex.clone();
  map.needsUpdate = true;
  map.repeat.set(w / 8, d / 8);
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0.03, emissive: 0x161310, emissiveIntensity: 0.5 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'tut-deck-top';
  mesh.receiveShadow = true;
  mesh.layers.enable(Layers.TERRAIN);
  mesh.matrixAutoUpdate = false;
  return mesh;
}

export class Ground {
  readonly group = new THREE.Group();
  private entries: ObstacleEntry[] = [];
  private disposables: Array<{ dispose(): void }> = [];
  /** 절벽 면의 어두워지는 띠 (`shadeAbyss`, `vertexColors` + `fog: false`) — `build` 끝에서 한 메시로 합친다. */
  private fade: THREE.BufferGeometry[] = [];

  constructor() { this.group.name = 'TutorialGround'; }

  build(root: THREE.Group, hash: SpatialHash): void {
    root.add(this.group);
    const groundTex = groundTexture();
    const cliffTex = cliffTexture();
    this.disposables.push(groundTex, cliffTex);

    const cliffMap = cliffTex.clone(); cliffMap.needsUpdate = true; cliffMap.repeat.set(6, 4);
    const rockMat = new THREE.MeshStandardMaterial({ map: cliffMap, roughness: 0.96, metalness: 0.04, emissive: 0x0d0b09, emissiveIntensity: 0.6 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x231f1a, roughness: 1, metalness: 0.02, emissive: 0x090807, emissiveIntensity: 0.7 });
    this.disposables.push(cliffMap, rockMat, darkMat);

    /* ── 협곡 바닥 판 (그림) ──
     * 2026-09-15: 높이가 `VOID_Y`(지형, 이제 −100)가 아니라 `CHASM_FLOOR_Y`(−34)이다. 3차: 앞쪽은 **철조망 너머의 첫 절벽 구멍이
     * 시작하는 `ABYSS_CUT_Z0`(−120)에서 끝난다** — 그 앞은 데크 조각 · 웅덩이 · 벽 · 구멍뿐이라 판이 있으면 구멍 밑에 바닥이 보인다
     * (구멍은 함선 앞 가장자리와 같은 끝없는 절벽이어야 한다). 판 아래로 내려가는 데크 몸통 · 벽 몸통은 전부 이 판에 가려진다. */
    const floorGeo = new THREE.PlaneGeometry(FLOOR_HALF_X * 2, Z_START - ABYSS_CUT_Z0);
    floorGeo.rotateX(-Math.PI / 2);
    floorGeo.translate(0, CHASM_FLOOR_Y, (Z_START + ABYSS_CUT_Z0) / 2);
    const floor = new THREE.Mesh(floorGeo, darkMat);
    floor.name = 'tut-void-floor';
    floor.layers.enable(Layers.TERRAIN);
    floor.matrixAutoUpdate = false;
    this.group.add(floor);
    this.disposables.push(floorGeo);
    /* 절벽 1 의 **협곡 바닥 콜라이더** (2026-09-15) — 지형이 −100 으로 내려갔으므로 절벽 1 에 빠진 몸은 이 윗면(−34)에 떨어진다.
     * 사선 틈의 바깥 사각형(`CHASM`)보다 앞뒤로 2 m 넓게 · 벽 바깥 면까지 덮는다. 데크 콜라이더와 겹치는 부분은 데크 윗면
     * 밑이라 걷는 높이에 아무 영향이 없다 (`getSurfaceY` 는 발 높이 창 안의 가장 높은 윗면을 고른다). */
    const chasmFloor: Rect = { x0: -CORRIDOR_OUTER_X, x1: CORRIDOR_OUTER_X, z0: CHASM.z0 + 2, z1: CHASM.z1 - 2 };
    for (const t of tileRect(chasmFloor, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, CHASM_FLOOR_Y, 'tut_deck');

    /* ── 데크: 몸통 상자(그림) + 윗면 판(그림) + 타일 콜라이더 ──
     * 2026-09-15 3차: 아래 데크는 일곱 조각이고(`model.ts` 의 `DECKS` 표) 웅덩이 · 절벽 구멍은 조각들 **사이의 빈 곳**이다 — 파는 코드가 없다.
     * 조각의 옆면이 곧 웅덩이의 턱 · 절벽 면이므로(몸통 상자는 여섯 면을 다 그린다) 턱 메시를 따로 세우지 않고, 콜라이더도 그 조각
     * (`VOID_Y … DECK_LOWER_Y`)이 그대로 턱이다. 아래 조각은 절벽 면을 가질 수 있어 `pushCliff` 로 그린다 (파일 머리 주석). */
    const bodies: THREE.BufferGeometry[] = [];
    for (const d of DECKS) {
      // 2026-09-16: 함선 언덕(`SHIP_HILL_Y`)도 아래 조각이다 — 절벽 면 · 이음매 겹침을 똑같이 받는다
      const lower = d.top < DECK_UPPER_Y;
      if (lower) this.pushCliff(bodies, d.rect, d.top); else bodies.push(rectBox(d.rect, VOID_Y, d.top));
      const top = topPlane(d.rect, d.top + TOP_LIFT, groundTex);
      this.group.add(top);
      this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
      // 아래 조각끼리 맞닿는 이음매는 콜라이더만 `TILE_OVERLAP` 만큼 넓혀 겹친다 (`model.ts` `DECKS` 주석 — 그림은 설계 치수 그대로).
      // 구멍 · 웅덩이 쪽으로도 5 cm 넓어지지만 윗면 판이 그 자리에 없어 보이지 않고, 절벽 가장자리는 5 cm 밖까지 딛을 수 있을 뿐이다.
      const cr = lower ? growRect(d.rect, TILE_OVERLAP) : d.rect;
      for (const t of tileRect(cr, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, d.top, 'tut_deck');
    }
    this.buildPit(hash, bodies, groundTex);
    this.buildShipSlope(hash, bodies, groundTex);
    this.buildChasmEdges(hash, bodies, groundTex);
    this.addMerged(bodies, rockMat, 'tut-deck-body');

    /* ── 양옆 절벽 벽 · 막다른 끝 ──
     * 2026-09-14 2차: 벽의 안쪽 면은 이제 `CORRIDOR_PROFILE` 이 정한다 — 곧은 구간은 예전처럼 `WALL_SEG_M`
     * 마다 끊어 안쪽 면 · 윗면을 흔들고, 폭이 바뀌는 구간은 **비스듬한 판**(회전 OBB) 하나로 잇는다.
     * 구간마다 콜라이더를 따로 넣으므로 **그려진 실루엣이 곧 콜라이더**다 (`CLAUDE.md` 의 소품 규약).
     * 바깥 면은 구간 폭과 무관하게 늘 `CORRIDOR_OUTER_X` 라 좁은 구간의 벽 뒤가 뚫려 보이지 않는다. */
    const walls: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      let seg = 0;
      for (let i = 1; i < CORRIDOR_PROFILE.length; i++) {
        const a = CORRIDOR_PROFILE[i - 1], b = CORRIDOR_PROFILE[i];
        if (a.halfX === b.halfX) {
          const depth = a.z - b.z;
          const n = Math.max(1, Math.ceil(depth / WALL_SEG_M));
          for (let j = 0; j < n; j++, seg++) {
            const z0 = a.z - (depth * j) / n;
            let z1 = a.z - (depth * (j + 1)) / n;
            const k = seg * 7 + (sx > 0 ? 3 : 0);
            // 2026-09-16: 철조망 끝(`WALL_DESCENT_FROM_Z`)을 넘는 조각은 거기서 자르고, 그 뒤는 낮아지는 조각들이 채운다 (`addDescentWall`).
            // 자른 앞부분은 k · 파고듦 · 윗면이 옛 조각 그대로라 방벽 왼쪽 틈의 벽(z −132 … −140, 파고듦 0)이 한 치도 안 바뀐다.
            if (z1 < WALL_DESCENT_FROM_Z) {
              this.addDescentWall(hash, walls, sx, a.halfX, Math.min(z0, WALL_DESCENT_FROM_Z), z1);
              if (z0 <= WALL_DESCENT_FROM_Z) continue;
              z1 = WALL_DESCENT_FROM_Z;
            }
            // 안쪽으로 파고든 깊이 — 좁은 구간에서는 같은 비율로 줄여 통로가 설계보다 좁아지지 않게 한다.
            // 2026-09-15: 함선 · `ship` 체크포인트가 서는 조각부터(`WALL_PLAIN_FROM_Z`)는 0 — 함선 왼쪽 나셀과 벽 사이가 2.27 m 다
            const bite = z0 <= WALL_PLAIN_FROM_Z ? 0 : (k % 5) * 0.55 * (a.halfX / CORRIDOR_MAX_HALF_X);
            const top = WALL_TOP_Y - (k % 4) * 1.6;
            const inner = sx * (a.halfX - bite), outer = sx * CORRIDOR_OUTER_X;
            const rect: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0, z1 };
            // 2026-09-15 3차: 철조망 너머 절벽 구멍 곁의 조각(끝이 `ABYSS_CUT_Z0` 앞)은 구멍으로 떨어지며 안쪽 면이 보이므로 절벽 면으로 그린다
            if (z1 <= ABYSS_CUT_Z0) this.pushCliff(walls, rect, top); else walls.push(rectBox(rect, VOID_Y, top));
            this.addBox(hash, rect, VOID_Y, top, 'tut_wall');
          }
        } else {
          seg++;
          this.addFunnel(hash, walls, sx, a.halfX, a.z, b.halfX, b.z);
        }
      }
    }
    // 2026-09-15: 막다른 벽은 **뒤쪽(`Z_START`) 하나뿐**이다. 앞쪽 캡(옛 `Z_END` −162 … −165)은 이륙하는 함선이 뚫고 날아가던
    // 그 벽이라 걷어 냈고, 그 자리는 끝없는 절벽이다 (`buildAbyss`).
    const cap: Rect = { x0: -CORRIDOR_OUTER_X, x1: CORRIDOR_OUTER_X, z0: Z_START, z1: Z_START - WALL_T };
    walls.push(rectBox(cap, VOID_Y, WALL_TOP_Y));
    for (const t of tileRect(cap, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, WALL_TOP_Y, 'tut_wall');
    this.buildAbyss(hash, walls);
    this.addMerged(walls, rockMat, 'tut-walls');
    const fadeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, fog: false });
    this.disposables.push(fadeMat);
    this.addMerged(this.fade, fadeMat, 'tut-abyss');
    this.fade = [];

    /* ── 절벽 1 의 틈에 부러져 걸린 다리 (그림만 — **데크 윗면보다 아래**라 밟을 수도, 건널 수도 없다) ──
     * 2026-09-14 2차: 절벽 1 은 좁은 구간이라 x 를 12 → 안쪽으로 옮겼다 (벽 속에 묻히면 안 보인다).
     * 2026-09-14 3차: 반폭이 7.7 로 더 줄고 가장자리가 **사선**이 됐으므로, x 는 ±5.6 안쪽 · z 는 그 x 에서의
     * 사선 자리(`chasmNearZAt` · `chasmFarZAt`)에서 뽑는다. */
    const bridge: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) {
      const xa = sx * 5.0, xb = sx * 5.6;
      bridge.push(box(1.1, 0.5, 3.0, xa, DECK_UPPER_Y - 1.1, chasmNearZAt(xa) - 0.6, sx * 0.22));
      bridge.push(box(0.9, 0.4, 3.6, xb, DECK_UPPER_Y - 2.9, chasmNearZAt(xb) - CHASM_GAP_Z / 2, sx * 0.55));
    }
    bridge.push(box(3.2, 0.4, 1.2, -5.2, DECK_UPPER_Y - 4.4, chasmFarZAt(-5.2) + 0.4, 0.3));
    this.addMerged(bridge, darkMat, 'tut-broken-bridge', true);
  }

  /**
   * **끝없는 절벽** (2026-09-15, 사용자 결정 — 함선 앞은 막힌 벽이 아니라 끝이 안 보이는 낭떠러지).
   *
   * 둘을 세운다 (2026-09-15 3차: 옛 ① 「아래 데크의 앞면을 대신 그리는 절벽 판」은 없어졌다 — 아래 데크 조각(2026-09-16 부터 함선 언덕
   * `ship_hill`)의 몸통이 `pushCliff` 로 자기 앞면을 그린다. 구멍이 생기면서 절벽 면이 앞면 하나가 아니게 됐기 때문이다):
   *   ① **가장자리 너머 양옆 벽** — `ABYSS_WALL_STEP_M` 조각 `ABYSS_RUN_M / STEP` 개. 조각마다 윗면이 왼쪽 `ABYSS_WALL_DROP_L` · 오른쪽
   *      `ABYSS_WALL_DROP_R` 내려가고(2026-09-16: 곧은 벽이 가장자리에서 끝난 높이부터 — `descentTop`) 안쪽 면이 `ABYSS_WALL_FLARE_M`
   *      벌어진다 (협곡이 끝나 트인다). 콜라이더는 `VOID_Y` 부터 그 윗면까지 —
   *      떨어지는 몸이 벽을 뚫고 맵 밖으로 나가지 않는다.
   *   ② **바닥이 없다**. 그림은 `ABYSS_FADE_TOP_Y` 위가 돌결 벽(다른 벽과 같은 재질), 그 밑은 `ABYSS_DRAW_BOTTOM_Y`
   *      까지 어두워지는 정점 색(`shadeAbyss`, **`fog: false`**)이다. 안개(FogExp2)는 멀수록 **밝은** 안개색으로 칠하므로
   *      안개를 받으면 깊은 곳이 오히려 밝아지고, 그 아래의 하늘 돔(`core/Sky` 의 지평선 밑 `ground` 색 — 어둡다)과 어긋난다.
   *
   * 광원 0 개. 새 재질 하나(`vertexColors` + `fog: false`, `build` 가 만든다)는 셰이더 변형이 하나 늘 뿐이고 `world:ready` 의 선컴파일이 받는다.
   *
   * **이륙 검산** (함선 `SHIP_POS` · `SHIP_YAW` — `model.ts` 주석): 함선은 기수 쪽(오른쪽 앞)으로 떠오르며 벽 윗면(≤ 18)을 넘기 전에
   * 18.5 m 만 나아가고, 그동안 외피는 x −13.1 … +0.4 안에 머문다 — 벽 안쪽 면(±15.4, 가장자리 너머는 더 벌어진다)에 닿지 않는다.
   */
  private buildAbyss(hash: SpatialHash, rock: THREE.BufferGeometry[]): void {
    const edge = ABYSS_EDGE_Z;

    // ① 가장자리 너머 양옆 벽 — 2026-09-16: 곧은 벽이 가장자리에서 끝난 높이(`descentTop`, 왼쪽 −6.1 · 오른쪽 2.0)에서 이어 내려간다.
    //    한 조각마다 왼쪽 `ABYSS_WALL_DROP_L` · 오른쪽 `ABYSS_WALL_DROP_R` (오른쪽이 완만하다 — 마지막 조각 윗면 왼쪽 −42.1 · 오른쪽 −16)
    const n = Math.max(1, Math.round(ABYSS_RUN_M / ABYSS_WALL_STEP_M));
    for (const sx of [-1, 1]) {
      const start = descentTop(sx, edge);
      const drop = sx < 0 ? ABYSS_WALL_DROP_L : ABYSS_WALL_DROP_R;
      for (let i = 0; i < n; i++) {
        const z0 = edge - ABYSS_WALL_STEP_M * i, z1 = z0 - ABYSS_WALL_STEP_M;
        const flare = ABYSS_WALL_FLARE_M * i;
        const inner = sx * (CORRIDOR_MAX_HALF_X + flare), outer = sx * (CORRIDOR_OUTER_X + flare);
        const r: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0, z1 };
        const top = start - drop * (i + 1);
        this.pushCliff(rock, r, top);
        this.addBox(hash, r, VOID_Y, top, 'tut_wall');
      }
    }
  }

  /**
   * 절벽 면을 가질 수 있는 상자 하나: 돌결 몸통(`ABYSS_FADE_TOP_Y … top`)을 `rock` 에, 그 밑(`ABYSS_DRAW_BOTTOM_Y … ABYSS_FADE_TOP_Y`)을
   * `ABYSS_FADE_BANDS` 띠로 나눠 어두워지는 정점 색(`shadeAbyss`)으로 `this.fade` 에 넣는다. 아래 데크 조각 · 웅덩이 벽 · 구멍 곁의 옆 벽 ·
   * 가장자리 너머 벽이 전부 이것이다. 콜라이더는 호출부가 따로 (`VOID_Y` 부터) 넣는다.
   */
  private pushCliff(rock: THREE.BufferGeometry[], r: Rect, top: number): void {
    rock.push(rectBox(r, ABYSS_FADE_TOP_Y, top));
    for (let i = 1; i < ABYSS_FADE_BANDS.length; i++) this.fade.push(shadeAbyss(rectBox(r, ABYSS_FADE_BANDS[i], ABYSS_FADE_BANDS[i - 1])));
  }

  /**
   * **안드로이드 웅덩이** (2026-09-15 2차 · 3차, 사용자 결정 — 치수 · 근거는 전부 `model.ts` 의 `PIT` · `PIT_DEPTH` · `PIT_WALLS` 주석).
   *
   * 넷을 세운다 (구멍은 `DECKS` 의 아래 조각들이 처음부터 비워 둔 자리다):
   *   ① **바닥** — 몸통 상자(그림) + `DECK_TILE_M` 타일 콜라이더(`VOID_Y … PIT_FLOOR_Y`) + 돌결 윗면 판.
   *      몸통은 `PIT` 보다 사방 `FLOOR_BURY` 만큼 크게 그려 옆면이 데크 조각 · 벽의 옆면과 **같은 평면에 놓이지 않게** 하고,
   *      윗면 판은 오르막 발끝(`PIT_RAMP_TOE_X`) 부터만 깐다 (같은 높이의 판 둘이 맞닿으면 z-fighting).
   *      콜라이더는 `PIT` 그대로다. 사방이 데크 조각 · 벽(둘 다 `ABYSS_DRAW_BOTTOM_Y` 까지 그린다)이라 몸통 밑면은 보이지 않는다.
   *   ② **턱** — 따로 세우지 않는다. 이웃 조각(`VOID_Y … DECK_LOWER_Y`)의 옆면이 곧 0.9 m 턱이고, 그 조각의 콜라이더가 곧 턱 콜라이더다
   *      (서쪽 오르막 위 = `lower_pit_w`, 오르막 남쪽 턱 = 함선 언덕 오르막 `SHIP_SLOPE` 의 몸통, 2026-09-16 부터 북쪽 = `PIT_WALLS` 의 `pit_rim_n`).
   *      수류탄이 굴러 나가지 못하는 근거는 `PIT_DEPTH` 주석.
   *   ④ **벽** (3차) — 동쪽 · 남쪽 `PIT_WALLS` (+ 2026-09-16 북쪽 턱): 절벽 면 상자(`pushCliff`, 바깥 면이 곧 절벽) + 콜라이더 `VOID_Y … 윗면` 한 기둥.
   *      재질 · 발소리는 바위(`tut_wall`)다 — 옛 콘크리트 `BACKSTOP`(`parts/Dressing`)은 없어졌다.
   *   ③ **오르막** — 함선 쪽(−X) 면 전체. 그림은 Z 축으로 기울인 상자 한 장 + 같은 기울기의 윗면 판, 콜라이더는
   *      `SpatialHash.addRamp` 회전 OBB 한 장(로컬 +X = 높은 쪽 = 월드 −X 이므로 `Obstacle.box.yaw` 는 π).
   *      ⚠ 콜라이더만 데크 밑으로 `PIT_RAMP_OVERLAP` 만큼 파고든다 — 정확히 같은 선에서 맞대면 이음매의 점을
   *      두 콜라이더가 모두 놓쳐 발밑이 사라진다 (`CLAUDE.md` 의 「계단은 경사 콜라이더다」). 그 대신 x = `PIT.x0` 에서
   *      오르막 윗면이 데크보다 `PIT_DEPTH × OVERLAP / (RUN + OVERLAP)` = **0.028 m** 낮은데, `getSurfaceY` 가 둘 중
   *      높은 쪽을 고르므로 겹치는 8 cm 에서는 데크가 이긴다 (턱도 계단도 생기지 않는다).
   *
   * 광원 0 개. 새 재질도 없다 (바닥 · 오르막 몸통은 벽과 같은 `rockMat`, 윗면 판은 데크와 같은 돌결 텍스처).
   */
  private buildPit(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    // ① 바닥
    const bury = FLOOR_BURY;
    bodies.push(rectBox({ x0: PIT.x0 - bury, x1: PIT.x1 + bury, z0: PIT.z0 + bury, z1: PIT.z1 - bury }, VOID_Y, PIT_FLOOR_Y));
    for (const t of tileRect(PIT, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, PIT_FLOOR_Y, 'tut_deck');
    // 윗면 판은 **평평한 부분만** 덮는다 — 오르막 쪽까지 깔면 같은 높이의 판 둘이 발끝 선에서 맞닿아 z-fighting 이 인다.
    const floorTop = topPlane({ x0: PIT_RAMP_TOE_X, x1: PIT.x1, z0: PIT.z0, z1: PIT.z1 }, PIT_FLOOR_Y + TOP_LIFT, tex);
    this.group.add(floorTop);
    this.disposables.push(floorTop.geometry, floorTop.material as THREE.Material, (floorTop.material as THREE.MeshStandardMaterial).map!);

    // ④ 벽 (동쪽 · 남쪽) — `model.ts` 의 `PIT_WALLS`
    for (const w of PIT_WALLS) {
      this.pushCliff(bodies, w.rect, w.top);
      for (const t of tileRect(w.rect, DECK_TILE_M)) this.addBox(hash, t, VOID_Y, w.top, 'tut_wall');
    }

    // ③ 오르막 (−X 면 전체)
    const tilt = Math.atan2(PIT_DEPTH, PIT_RAMP_RUN);
    const slopeLen = Math.hypot(PIT_RAMP_RUN, PIT_DEPTH);
    const depth = PIT.z0 - PIT.z1;
    const cx = (PIT.x0 + PIT_RAMP_TOE_X) / 2, cy = (DECK_LOWER_Y + PIT_FLOOR_Y) / 2, cz = (PIT.z0 + PIT.z1) / 2;
    // 기울인 상자: 로컬 +X 가 내리막 방향, 로컬 +Y 가 경사면 법선 (rotateZ(−tilt) 가 +X → (cos, −sin) · +Y → (sin, cos))
    const slab = new THREE.BoxGeometry(slopeLen, RAMP_T, depth);
    slab.rotateZ(-tilt);
    slab.translate(cx - (RAMP_T / 2) * Math.sin(tilt), cy - (RAMP_T / 2) * Math.cos(tilt), cz);
    bodies.push(slab);
    const rampTop = topQuad(cx, cy + TOP_LIFT, cz, slopeLen, depth, 0, tex, -tilt);
    this.group.add(rampTop);
    this.disposables.push(rampTop.geometry, rampTop.material as THREE.Material, (rampTop.material as THREE.MeshStandardMaterial).map!);
    const rx0 = PIT.x0 - PIT_RAMP_OVERLAP;
    const base = PIT_FLOOR_Y - RAMP_COLLIDER_DROP;
    this.entries.push(hash.addRamp(
      new THREE.Vector3((rx0 + PIT_RAMP_TOE_X) / 2, base, cz), (PIT_RAMP_TOE_X - rx0) / 2, depth / 2,
      Math.PI, DECK_LOWER_Y - base, PIT_DEPTH, 'tut_deck',
    ));
  }

  /**
   * **함선 언덕의 오르막** (2026-09-16, 사용자 결정 — 치수 · 근거는 `model.ts` 의 `SHIP_HILL_*` · `SHIP_SLOPE` 주석).
   *   ① **몸통** — `SHIP_SLOPE` 사각형의 절벽 면 상자(`pushCliff`, 윗면 `DECK_LOWER_Y`) + 타일 콜라이더(`VOID_Y … DECK_LOWER_Y`, 이음매는
   *      다른 아래 조각처럼 `TILE_OVERLAP` 만큼 넓힌다). 동쪽 면(x 1.5)이 절벽 구멍 `cut_s` 쪽으로 보이고, x −2 … 1.5 의 북쪽 면이 웅덩이의 남쪽 턱이다.
   *   ② **쐐기** (그림) — 몸통 위의 삼각 기둥. `BoxGeometry` 의 윗면 정점을 그 z 의 경사면 높이로, 밑면 정점을 `DECK_LOWER_Y` 로 옮긴다 —
   *      옆면이 수직이라 동쪽 절벽 면과 한 평면으로 이어진다. 웅덩이 오르막처럼 **기울인 상자를 쓰지 않는 이유**: 기울인 상자의 낮은 끝
   *      밑모서리가 경사 법선만큼 +Z 로 삐져나와(두께 1.2 × sin 11.3° = 0.24 m) 웅덩이 남쪽 턱 면에 턱받이처럼 튀어나온다.
   *   ③ **윗면 판** — X 축으로 기울인 돌결 판 (`topQuad` 의 `tiltX`), 무늬는 길 · 언덕 판과 이어지게 월드 좌표로 민다.
   *   ④ **경사 콜라이더** — `SpatialHash.addRamp` 한 장. 로컬 +X(높은 쪽)가 월드 −Z 라 `Obstacle.box.yaw` = −π/2 (`obb.toLocal` 의 수학 관례
   *      (cos, sin) = (0, −1)). 높은 끝은 언덕 윗면 밑으로 `PIT_RAMP_OVERLAP` 만큼 파고든다 (`CLAUDE.md` 「계단은 경사 콜라이더, 위 판과 0.08 m
   *      겹친다」) — 그래서 z −153.5 에서 경사면이 언덕보다 0.016 m 낮고 `getSurfaceY` 가 높은 쪽(언덕)을 고른다. 낮은 끝(z −149)은 정확히
   *      `DECK_LOWER_Y` 라 길(`lower_pit_w`)과 턱 없이 이어진다.
   * 광원 0 개, 새 재질 없음.
   */
  private buildShipSlope(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    const r = SHIP_SLOPE;
    const w = r.x1 - r.x0, d = r.z0 - r.z1, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    // ① 몸통
    this.pushCliff(bodies, r, DECK_LOWER_Y);
    for (const t of tileRect(growRect(r, TILE_OVERLAP), DECK_TILE_M)) this.addBox(hash, t, VOID_Y, DECK_LOWER_Y, 'tut_deck');
    // ② 쐐기 — 정점 z 는 부동소수로 사각형 경계를 살짝 넘을 수 있어 잘라서 묻는다 (넘으면 `shipHillSurfaceY` 가 null)
    const wedge = new THREE.BoxGeometry(w, 1, d);
    wedge.translate(cx, 0, cz);
    const pos = wedge.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const z = Math.min(r.z0, Math.max(r.z1, pos.getZ(i)));
      pos.setY(i, pos.getY(i) > 0 ? (shipHillSurfaceY(cx, z) ?? DECK_LOWER_Y) : DECK_LOWER_Y);
    }
    wedge.computeVertexNormals();
    bodies.push(wedge);
    // ③ 윗면 판
    const tilt = Math.atan2(SHIP_HILL_RISE, SHIP_SLOPE_RUN);
    const slopeLen = Math.hypot(SHIP_SLOPE_RUN, SHIP_HILL_RISE);
    const top = topQuad(cx, (DECK_LOWER_Y + SHIP_HILL_Y) / 2 + TOP_LIFT, cz, w, slopeLen, 0, tex, 0, tilt);
    (top.material as THREE.MeshStandardMaterial).map!.offset.set(r.x0 / 8, -r.z0 / 8);
    this.group.add(top);
    this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
    // ④ 경사 콜라이더
    const hi = r.z1 - PIT_RAMP_OVERLAP;
    const base = DECK_LOWER_Y - RAMP_COLLIDER_DROP;
    this.entries.push(hash.addRamp(
      new THREE.Vector3(cx, base, (r.z0 + hi) / 2), (r.z0 - hi) / 2, w / 2,
      -Math.PI / 2, SHIP_HILL_Y - base, SHIP_HILL_RISE, 'tut_deck',
    ));
  }

  /**
   * **낮아지는 옆 벽** (2026-09-16, 사용자 결정 — `model.ts` 의 `WALL_DESCENT_*` 주석). `z0 … z1`(z0 > z1)을 `WALL_DESCENT_STEP_M` 조각으로 나누고
   * 조각마다 윗면을 `descentTop` 으로 내린다. 안쪽 면은 파고듦 0 — 함선 왼쪽 나셀과 벽 사이 2.27 m 가 그대로다 (`WALL_PLAIN_FROM_Z`).
   * 조각마다 절벽 면(`pushCliff`) + `VOID_Y … 윗면` 콜라이더 한 기둥이라 계단진 윗면이 곧 콜라이더다.
   */
  private addDescentWall(hash: SpatialHash, walls: THREE.BufferGeometry[], sx: number, halfX: number, z0: number, z1: number): void {
    const n = Math.max(1, Math.ceil((z0 - z1) / WALL_DESCENT_STEP_M - 1e-6));
    for (let i = 0; i < n; i++) {
      const pz0 = z0 - ((z0 - z1) * i) / n, pz1 = z0 - ((z0 - z1) * (i + 1)) / n;
      // 자리 · 쪽에서 뽑은 0 / 0.4 / 0.8 m — 반듯한 계단으로 보이지 않게 (왼쪽은 그 뒤에 바닥값으로 다시 자른다)
      const jitter = ((Math.round(-pz1) * 5 + (sx > 0 ? 2 : 0)) % 3) * 0.4;
      const top = descentTop(sx, pz1, jitter);
      const inner = sx * halfX, outer = sx * CORRIDOR_OUTER_X;
      const rect: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: pz0, z1: pz1 };
      this.pushCliff(walls, rect, top);
      this.addBox(hash, rect, VOID_Y, top, 'tut_wall');
    }
  }

  /**
   * 절벽 1 의 **사선 가장자리** (2026-09-14 3차, 사용자 결정 — 「무너진 절벽」).
   *
   * 축 정렬 사각형으로는 사선을 담을 수 없으므로 `DECKS` 의 `upper_a` · `upper_b` 는 **사선에서 가장 물러난
   * 자리**(85.8 · 74.9)에서 끝내고, 거기서 사선까지의 쐐기를 **회전 OBB 한 장씩**이 마저 채운다. 그래서
   * 옆면이 완전한 벽이고(높이장이 아니다 — `model.ts` 머리 주석) 가장자리를 넘으면 그대로 떨어진다.
   *
   * ⚠ 계단식 타일로 지으면 안 된다: 두 가장자리가 함께 계단을 이루면 **안쪽 모서리**에서 틈이 한 단
   * 높이만큼 좁아져(3.6 − 단) 거기만 걸어서도 넘을 수 있는 지름길이 된다. 회전 OBB 는 모서리가 없다.
   *
   * 판은 데크(윗면 `DECK_UPPER_Y`) 와 겹치지만 **콜라이더 윗면이 같아서** 걷는 데는 아무 차이가 없고,
   * 그림만 `CHASM_TOP_LIFT` 로 갈라 놓는다.
   */
  private buildChasmEdges(hash: SpatialHash, bodies: THREE.BufferGeometry[], tex: THREE.CanvasTexture): void {
    // 메시 `rotateY` 값: 로컬 +X = 사선의 법선(통로 +z 쪽), 로컬 +Z = 사선 방향.
    //   rotateY(θ) 는 로컬 +X → (cos θ, −sin θ) · 로컬 +Z → (sin θ, cos θ) 이므로 θ = tilt − π/2 에서
    //   +X = (sin tilt, cos tilt) = 법선 ✔, +Z = (−cos tilt, sin tilt) = 사선 방향(부호만 반대) ✔
    const yaw = CHASM_TILT - Math.PI / 2;
    const nx = Math.sin(CHASM_TILT), nz = Math.cos(CHASM_TILT);
    const w = CHASM_EDGE.width, len = CHASM_EDGE.halfLen * 2;
    const h = DECK_UPPER_Y - VOID_Y;
    for (const side of [1, -1]) {
      // side +1 = 가까운 쪽(`upper_a`) · −1 = 먼 쪽(`upper_b`). 판은 사선 면에서 데크 쪽으로 `w` 만큼 뻗는다.
      const edgeZ = side > 0 ? CHASM_NEAR_Z : CHASM_NEAR_Z - CHASM_GAP_Z;
      const cx = side * nx * (w / 2);
      const cz = edgeZ + side * nz * (w / 2);
      bodies.push(box(w, h, len, cx, VOID_Y + h / 2, cz, yaw));
      this.addObb(hash, cx, cz, w / 2, len / 2, yaw, VOID_Y, DECK_UPPER_Y, 'tut_deck');
      const top = topQuad(cx, DECK_UPPER_Y + CHASM_TOP_LIFT, cz, w, len, yaw, tex);
      this.group.add(top);
      this.disposables.push(top.geometry, top.material as THREE.Material, (top.material as THREE.MeshStandardMaterial).map!);
    }
  }

  /**
   * 폭이 바뀌는 구간을 잇는 **깔때기** 한쪽(`sx`). 계단 턱을 만들지 않으려고 비스듬한 판 하나로 잇는다 —
   * 좁아지는 쪽에서 턱이 생기면 벽에 붙어 걷던 몸이 z 로 되밀려 「끼었다」로 읽힌다.
   *
   * 두 조각이다: ① 넓은 쪽 면부터 바깥 면까지 채우는 곧은 상자, ② 경사면을 따라 바깥으로 `T` 만큼 뻗은
   * 회전 상자. `T` 는 경사면에서 **(넓은 폭, 좁은 쪽 z)** 모서리까지의 수직 거리 `|Δz·Δw| / L` 에 `WALL_T` 를
   * 더한 값이라 ①②가 겹치면서 쐐기 영역을 빈틈없이 덮는다 (쐐기는 볼록이고 세 꼭짓점이 전부 이 띠 안이다).
   */
  private addFunnel(
    hash: SpatialHash, walls: THREE.BufferGeometry[], sx: number, wA: number, zA: number, wB: number, zB: number,
  ): void {
    const dw = wB - wA, dzv = zB - zA;
    const L = Math.hypot(dw, dzv);
    if (L < 1e-3) return;
    const dx = dw / L, dz = dzv / L;          // +x 쪽 기준 경사 방향 (−x 쪽은 마지막에 되비춘다)
    const nx = -dz, nz = dx;                  // 통로 **바깥**을 향하는 법선
    const wHi = Math.max(wA, wB);

    // ① 바깥 채움
    const inner = sx * wHi, outer = sx * CORRIDOR_OUTER_X;
    const fill: Rect = { x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: zA, z1: zB };
    walls.push(rectBox(fill, VOID_Y, WALL_TOP_Y));
    this.addBox(hash, fill, VOID_Y, WALL_TOP_Y, 'tut_wall');

    // ② 비스듬한 판
    const t = Math.abs(dzv * dw) / L + WALL_T;
    const cx = sx * ((wA + wB) / 2 + (nx * t) / 2);
    const cz = (zA + zB) / 2 + (nz * t) / 2;
    const yaw = sx * Math.atan2(dx, dz);      // 메시 rotateY — 로컬 +Z 가 경사 방향 (되비추면 부호가 뒤집힌다)
    const h = WALL_TOP_Y - VOID_Y;
    const len = L + 0.2;                      // 이음매에 부동소수 슬리버가 남지 않게 살짝 길게
    walls.push(box(t, h, len, cx, VOID_Y + h / 2, cz, yaw));
    this.addObb(hash, cx, cz, t / 2, len / 2, yaw, VOID_Y, WALL_TOP_Y, 'tut_wall');
  }

  private addBox(hash: SpatialHash, r: Rect, y0: number, top: number, kind: string): void {
    const hx = (r.x1 - r.x0) / 2, hz = (r.z0 - r.z1) / 2;
    const pos = new THREE.Vector3((r.x0 + r.x1) / 2, y0, (r.z0 + r.z1) / 2);
    this.entries.push(hash.addBox(pos, hx, hz, 0, top - y0, kind));
  }

  /**
   * 회전한 사각 콜라이더. ⚠ **`meshYaw` 는 메시의 `rotateY` 값이고 `Obstacle.box.yaw` 는 그 부호를 뒤집은
   * 값이다** — three.js 의 rotation.y θ 는 로컬 +X 를 `(cos θ, −sin θ)` 로 보내는데 `world/obb.ts` 의 규약은
   * 수학 관례 `(cos, sin)` 이다 (`extraction/Hull` 이 같은 주석을 달고 같은 일을 한다).
   */
  private addObb(
    hash: SpatialHash, x: number, z: number, halfX: number, halfZ: number, meshYaw: number,
    y0: number, top: number, kind: string,
  ): void {
    this.entries.push(hash.addBox(new THREE.Vector3(x, y0, z), halfX, halfZ, -meshYaw, top - y0, kind));
  }

  /** `cast` 는 기본이 false 다 — 데크 · 절벽 벽은 **땅**이라 그림자를 만들 것이 아니라 받는 것이다. */
  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string, cast = false): void {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.disposables.push(merged);
  }

  dispose(hash: SpatialHash): void {
    for (const e of this.entries) hash.remove(e);
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}
