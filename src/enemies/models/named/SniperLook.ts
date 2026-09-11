/**
 * src/enemies/models/named/SniperLook.ts — **로든(`rogue_sniper`)의 겉모습** (2026-09-11).
 *
 * 기본 휴머노이드 로그 리그 위에:
 *  - **대물 저격총** — 기본 소총 메시(`rig.gun` 의 팔 + 소총 합본)를 숨기고, 같은 `rig.gun` 에 팔 + 긴 총열 · 소염기 ·
 *    대형 조준경 · 양각대(엎드리면 펼친다)를 붙인다. `rig.muzzle` 은 소염기 끝으로 옮긴다 → `Enemy.muzzle` 과
 *    `fireGun` 이 그 자리에서 쏜다.
 *  - **길리 망토** — 어깨 · 등에 천과 너덜너덜한 띠, 머리에 두건.
 *  - **엎드림 자세** — `e.namedHint` 14 / 15 에서 `animateRogue` 가 잡은 자세를 덮어써 `rig.body` 를 앞으로 눕힌다.
 *    엎드린 채 죽으면 일어서지 않고 그 자리에서 옆으로 늘어진다.
 *  - **조준경 반짝임** — 가산 혼합 `THREE.Sprite` (광원 아님). `sizeAttenuation: false` 라 **화면 크기가 거리와
 *    무관**하다 = 월드 크기가 거리에 비례한다(200 m 밖에서도 읽힌다). 힌트 15(또는 리플리카가 받은 `ee glint`)에서만
 *    켜지고, 조준경이 카메라를 향할수록 밝다(`onBeforeRender` 에서 그 한 번의 그리기에만 opacity 를 정한다).
 *    확대 조준(FOV 축소)에서는 크기를 되돌려 화면을 덮지 않게 한다.
 *
 * 머리 판정: 엎드린 머리는 서 있을 때(1.66 m)가 아니라 0.27 m 높이 · 0.84 m 앞에 있다. 그래서 이 리그는
 * `rig.params` 를 **리그별 사본**으로 바꿔 끼우고 매 프레임 자세 비율로 `head.y / head.z` 를 옮긴다 —
 * `Enemy.headCenter`(헤드샷 구체) · `lookAtTarget` 이 그 값을 읽는다. 공유 `ROGUE_RIG_PARAMS` 는 건드리지 않는다.
 *
 * 순환 import: `RogueModel` 에서는 `import type` 만. 지오메트리 · 텍스처는 리그마다 만들고 `disposeSniperLook` 이 버린다
 * (레이드당 로든은 최대 한 명이라 공유 캐시를 둘 이유가 없다). 부품 메시는 리그의 `chitin`(피격 번쩍임)을 같이 쓴다.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig, RogueRigParams } from '../RogueModel';
import type { Enemy } from '../../Enemy';
import { NAMED_SNIPER } from '../../EnemyTypes';

/* ── 색 (그림 상수) ─────────────────────────────────────────────────────── */
const C_CLOTH = 0x2e2c22;
const C_ARMOR = 0x4a4636;
const C_METAL = 0x3a3b37;
const C_DARK = 0x1c1d1b;
const C_FURN = 0x5a5238;
const C_LENS = 0x0c1418;
const GILLIE = [0x4f5a34, 0x5e5236, 0x3c4428, 0x6b6440] as const;

/* ── 총 치수 (rig.gun 좌표: 원점 = 오른쪽 어깨, +Z = 총구 방향) ─────────── */
const RX = -0.05;
const RY = -0.08;
const SCOPE_Y = RY + 0.13;
const MUZZLE_Z = 1.66;

/* ── 엎드림 자세 ─────────────────────────────────────────────────────────── */
/** 엎드렸을 때 골반 피벗 높이 (m). */
const PRONE_Y = 0.14;
/** 몸통을 앞으로 눕히는 각 (rad) — +Y(몸통 위) 를 +Z(정면) 로. */
const PRONE_PITCH = Math.PI / 2;
/** 엎드려 가슴을 살짝 든다 (음수 = 어깨가 들린다). */
const PRONE_TORSO_X = -0.2;
/** 위 두 값으로 계산한 엎드린 머리 중심 (발 기준 높이 · 정면 거리, m) — `rig.params.head` 가 따라간다. */
const PRONE_HEAD_Y = 0.27;
const PRONE_HEAD_Z = 0.84;
/** 엎드렸을 때 총 피벗(어깨) 위치 (몸통 좌표). */
const PRONE_GUN_X = 0.17, PRONE_GUN_Y = 0.52, PRONE_GUN_Z = -0.08;

/* ── 엎드린 몸통 판정 (C-55) ─────────────────────────────────────────────────
 * 리그 실측(2026-09-11, 엎드림 1 · 경사 성분을 되돌린 루트 좌표): 다리 z −1.05…−0.06 · y 0.03…0.36,
 * 골반 y −0.02…0.28, 몸통 + 망토 z 0.12…0.74 · y 0.01…0.60 · |x| ≤ 0.31, 머리 z 0.60…1.01 (머리는 따로 헤드샷 구).
 * → 캡슐 하나: 뒤 끝 구 중심 (z −0.80, y 0.20) · 앞 끝 (z 0.50, y 0.30) · 반경 0.25 — 발끝 −1.05 · 어깨 앞 0.75 ·
 * 윗면 0.55 까지 덮는다. 벌린 발끝(|x| 0.39)만 조금 밖이다(서 있는 캡슐도 팔꿈치가 밖이다). 서 있는 판정은
 * `raycastEx` 의 세로 캡슐(반경 = stats.radius, 발 + r … 키 − r)이고 그 사이는 **보이는 비율**로 끝점 · 반경을 섞는다. */
const BODY_BACK_Z = -0.8, BODY_BACK_Y = 0.2;
const BODY_FRONT_Z = 0.5, BODY_FRONT_Y = 0.3;
const BODY_PRONE_R = 0.25;

/* ── 조준경 반짝임 ───────────────────────────────────────────────────────── */
/** 화면 높이에 대한 스프라이트 크기 (sizeAttenuation 없음 — 뷰 공간 단위 × 깊이). */
const GLINT_SCALE = 0.05;
const TAN_BASE_HALF_FOV = Math.tan((70 * Math.PI) / 360);

interface SniperLookState {
  kind: 'sniperLook';
  /** 이 리그 전용 `rig.params` 사본 (엎드림에 따라 머리 위치가 움직인다). */
  params: RogueRigParams;
  standHeadY: number;
  standHeadZ: number;
  /** 0 서 있음 … 1 엎드림 */
  prone: number;
  /** `prone` 에 smoothstep 을 건 값 — 자세가 실제로 쓰는 **보이는** 엎드림 비율. 몸통 판정이 읽는다(`sniperBodyCapsule`). */
  pose: number;
  /** 0..1 반짝임 켜짐 정도 */
  glint: number;
  /** 반짝임이 켜진 지 몇 s (끝으로 갈수록 크고 밝다). */
  glintAge: number;
  /** 리플리카: `ee glint` 를 받고 스냅샷 힌트가 따라올 때까지 켜 두는 남은 s. */
  glintHold: number;
  /** `onBeforeRender` 가 쓰는 최종 밝기 (방향 계수 곱하기 전). */
  glintOut: number;
  /** 확대 조준 보정 (지난 프레임의 카메라에서, ≤ 1). */
  fovK: number;
  /** 풀에서 다시 빌려 온 첫 프레임을 알아채는 용도. */
  lastId: number;
  age: number;
  bipodLegs: THREE.Object3D[];
  sprite: THREE.Sprite;
  spriteMat: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture | null;
  geos: THREE.BufferGeometry[];
}

function lookOf(rig: RogueRig): SniperLookState | null {
  const s = rig.named as SniperLookState | undefined;
  return s && s.kind === 'sniperLook' ? s : null;
}

/* ── 지오메트리 도우미 (RogueModel 의 것과 같은 방식 — 순환 import 때문에 여기서 따로 쓴다) ── */
const _col = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _col.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}
function rod(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number, taper = 0.85): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * taper, r, len, 8, 1);
  g.translate(0, len / 2, 0);
  _b.sub(_a).normalize();
  _q.setFromUnitVectors(_up, _b);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // BoxGeometry 는 인덱스가 있고 CylinderGeometry 도 인덱스가 있다 — 둘 다 같은 속성(position/normal/uv/color)
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] sniper mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}
/** 결정적인 0..1 난수 (모양만 흩뜨린다 — 게임 상태가 아니다). */
function hash01(i: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function buildArmsAndRifle(): THREE.BufferGeometry {
  return merge([
    // 팔 — 오른손은 손잡이, 왼손은 총열 덮개
    rod(0, 0, 0, 0.0, -0.17, 0.2, 0.045, C_CLOTH),
    rod(0.0, -0.17, 0.2, RX, -0.17, 0.33, 0.04, C_ARMOR),
    rod(-0.46, 0, 0, -0.34, -0.2, 0.3, 0.045, C_CLOTH),
    rod(-0.34, -0.2, 0.3, RX - 0.02, -0.14, 0.7, 0.04, C_ARMOR),
    // 개머리 · 뺨받침 · 손잡이
    box(0.06, 0.17, 0.05, RX, RY - 0.03, -0.03, C_DARK),
    box(0.05, 0.12, 0.3, RX, RY - 0.02, 0.13, C_FURN),
    box(0.052, 0.05, 0.16, RX, RY + 0.06, 0.1, C_FURN),
    box(0.045, 0.12, 0.06, RX, RY - 0.11, 0.32, C_DARK),
    // 몸통 · 탄창 · 덮개 · 레일
    box(0.08, 0.1, 0.44, RX, RY, 0.5, C_METAL),
    box(0.055, 0.13, 0.1, RX, RY - 0.11, 0.5, C_DARK),
    box(0.075, 0.085, 0.34, RX, RY - 0.005, 0.88, C_FURN),
    box(0.03, 0.02, 0.62, RX, RY + 0.06, 0.5, C_DARK),
    // 긴 총열 + 소염기
    rod(RX, RY, 1.02, RX, RY, 1.56, 0.024, C_METAL, 1),
    box(0.082, 0.066, 0.12, RX, RY, 1.6, C_DARK),
    box(0.088, 0.022, 0.028, RX, RY, 1.575, C_METAL),
    box(0.088, 0.022, 0.028, RX, RY, 1.625, C_METAL),
    // 대형 조준경: 경통 · 대물 렌즈 통 · 접안부 · 다이얼 · 마운트 링 · 렌즈
    rod(RX, SCOPE_Y, 0.3, RX, SCOPE_Y, 0.64, 0.036, C_DARK, 1),
    rod(RX, SCOPE_Y, 0.62, RX, SCOPE_Y, 0.75, 0.054, C_DARK, 0.7),
    rod(RX, SCOPE_Y, 0.23, RX, SCOPE_Y, 0.31, 0.046, C_DARK, 1.15),
    box(0.03, 0.045, 0.04, RX, SCOPE_Y + 0.05, 0.47, C_METAL),
    box(0.045, 0.03, 0.04, RX + 0.048, SCOPE_Y, 0.47, C_METAL),
    box(0.04, 0.07, 0.03, RX, RY + 0.085, 0.38, C_METAL),
    box(0.04, 0.07, 0.03, RX, RY + 0.085, 0.58, C_METAL),
    box(0.08, 0.08, 0.008, RX, SCOPE_Y, 0.752, C_LENS),
  ]);
}

function buildCloak(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.54, 0.1, 0.36, 0, 0.57, -0.02, GILLIE[0]),      // 어깨 숄
    box(0.46, 0.44, 0.06, 0, 0.32, -0.25, GILLIE[1]),     // 등 덮개 (배낭 위)
    box(0.2, 0.12, 0.1, 0, 0.5, -0.3, GILLIE[2]),         // 뭉친 천
  ];
  // 등에서 늘어진 띠 — 엎드리면 등 위로 다리 쪽을 향해 눕는다
  for (let i = 0; i < 11; i++) {
    const len = 0.16 + hash01(i) * 0.32;
    const x = -0.23 + i * 0.046;
    parts.push(box(0.034, len, 0.018, x, 0.52 - len / 2, -0.29 - (i % 2) * 0.016, GILLIE[i % GILLIE.length]));
  }
  // 어깨 끝의 띠
  for (const side of [1, -1]) {
    for (let j = 0; j < 3; j++) {
      const len = 0.14 + hash01(20 + j * 3 + side) * 0.22;
      parts.push(box(0.03, len, 0.03, side * (0.27 + j * 0.012), 0.55 - len / 2, -0.1 + j * 0.09, GILLIE[(j + (side > 0 ? 1 : 2)) % GILLIE.length]));
    }
  }
  return merge(parts);
}

function buildHood(): THREE.BufferGeometry {
  return merge([
    box(0.33, 0.2, 0.34, 0, 0.07, -0.05, GILLIE[0]),
    box(0.36, 0.05, 0.18, 0, 0.13, 0.08, GILLIE[3]),
    box(0.04, 0.24, 0.02, 0.08, -0.07, -0.21, GILLIE[2]),
    box(0.04, 0.2, 0.02, -0.07, -0.05, -0.22, GILLIE[1]),
    box(0.035, 0.16, 0.02, 0.0, -0.03, -0.225, GILLIE[3]),
  ]);
}

/** 가산 혼합 반짝임 텍스처: 흰 심지 + 따뜻한 번짐 + 가로로 긴 줄 · 짧은 세로 줄. */
function makeGlintTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  const rad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rad.addColorStop(0, 'rgba(255,255,255,1)');
  rad.addColorStop(0.1, 'rgba(255,248,225,0.95)');
  rad.addColorStop(0.32, 'rgba(255,205,130,0.3)');
  rad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  const hor = g.createLinearGradient(0, 0, 128, 0);
  hor.addColorStop(0, 'rgba(255,230,190,0)');
  hor.addColorStop(0.5, 'rgba(255,250,235,0.9)');
  hor.addColorStop(1, 'rgba(255,230,190,0)');
  g.fillStyle = hor;
  g.fillRect(0, 62, 128, 4);
  const ver = g.createLinearGradient(0, 22, 0, 106);
  ver.addColorStop(0, 'rgba(255,230,190,0)');
  ver.addColorStop(0.5, 'rgba(255,250,235,0.7)');
  ver.addColorStop(1, 'rgba(255,230,190,0)');
  g.fillStyle = ver;
  g.fillRect(62, 22, 4, 84);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function noRaycast(): void { /* 스프라이트 raycast 는 카메라가 없으면 던진다 — 반짝임은 맞힐 대상이 아니다 */ }

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = THREE.MathUtils.lerp;

export function decorateSniperLook(rig: RogueRig): void {
  const mesh = (g: THREE.BufferGeometry): THREE.Mesh => {
    const m = new THREE.Mesh(g, rig.chitin);
    m.castShadow = true;
    m.layers.enable(Layers.ENEMY);
    return m;
  };
  // 기본 소총(팔 합본)은 숨긴다 — 그 자리에 긴 저격총을 같은 피벗으로 붙인다
  for (const c of rig.gun.children) if ((c as THREE.Mesh).isMesh) c.visible = false;
  const rifleGeo = buildArmsAndRifle();
  rig.gun.add(mesh(rifleGeo));
  rig.muzzle.position.set(RX, RY, MUZZLE_Z + 0.06);

  // 양각대: 서 있으면 총열을 따라 접히고 엎드리면 아래로 펼친다
  const legGeo = merge([box(0.02, 0.27, 0.02, 0, -0.135, 0, C_METAL), box(0.03, 0.02, 0.05, 0, -0.27, 0, C_DARK)]);
  const bipod = new THREE.Group();
  bipod.position.set(RX, RY - 0.045, 1.2);
  const legs: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const leg = mesh(legGeo);
    leg.position.x = side * 0.024;
    leg.userData.side = side;
    bipod.add(leg);
    legs.push(leg);
  }
  rig.gun.add(bipod);

  const cloakGeo = buildCloak();
  rig.torso.add(mesh(cloakGeo));
  const hoodGeo = buildHood();
  rig.head.add(mesh(hoodGeo));

  // 조준경 반짝임 — 광원이 아니라 가산 스프라이트
  const texture = makeGlintTexture();
  const spriteMat = new THREE.SpriteMaterial({
    map: texture, color: 0xfff1d6, blending: THREE.AdditiveBlending, transparent: true,
    depthWrite: false, depthTest: true, sizeAttenuation: false, toneMapped: false, fog: false, opacity: 0,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(RX, SCOPE_Y, 0.8);
  sprite.renderOrder = 31;
  sprite.visible = false;
  sprite.raycast = noRaycast;
  rig.gun.add(sprite);

  const base = rig.params;
  const st: SniperLookState = {
    kind: 'sniperLook',
    params: { head: { r: base.head.r, y: base.head.y, z: base.head.z }, strideLength: base.strideLength },
    standHeadY: base.head.y,
    standHeadZ: base.head.z,
    prone: 0, pose: 0, glint: 0, glintAge: 0, glintHold: 0, glintOut: 0, fovK: 1,
    lastId: -1, age: 0,
    bipodLegs: legs,
    sprite, spriteMat, texture,
    geos: [rifleGeo, legGeo, cloakGeo, hoodGeo],
  };
  rig.params = st.params;   // 리그별 사본 — 공유 ROGUE_RIG_PARAMS 는 그대로
  rig.named = st;

  // 한 번의 그리기에만: 조준경이 카메라를 향할수록 밝게, 확대 조준이면 다음 프레임 크기를 줄이게
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const g = rig.gun.matrixWorld.elements;
    let fx = g[8], fy = g[9], fz = g[10];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const sp = sprite.matrixWorld.elements;
    const cm = camera.matrixWorld.elements;
    let cx = cm[12] - sp[12], cy = cm[13] - sp[13], cz = cm[14] - sp[14];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl; cy /= cl; cz /= cl;
    const f = THREE.MathUtils.smoothstep(fx * cx + fy * cy + fz * cz, 0.25, 0.95);
    spriteMat.opacity = Math.min(1, st.glintOut * (0.12 + 0.88 * f));
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) {
      const k = Math.tan((pc.fov * Math.PI) / 360) / Math.max(1e-3, pc.zoom) / TAN_BASE_HALF_FOV;
      st.fovK = Math.min(1, k * 1.6);
    }
  };
}

/** 리플리카가 `ee glint` 를 받았을 때 — 스냅샷 힌트 15 가 도착하기 전부터 반짝임을 켠다. */
export function holdSniperGlint(rig: RogueRig, duration: number): void {
  const st = lookOf(rig);
  if (st) { st.glintHold = Math.max(0, duration); st.glintAge = 0; }
}

/** 발사(`ee snipe`) — 붙잡아 둔 반짝임을 끈다. */
export function clearSniperGlint(rig: RogueRig): void {
  const st = lookOf(rig);
  if (st) st.glintHold = 0;
}

export function animateSniperLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const st = lookOf(rig);
  if (!st) return;
  if (st.lastId !== e.id) { st.lastId = e.id; st.age = 0; st.glintHold = 0; st.glintAge = 0; st.glint = 0; }
  st.age += dt;
  const dying = a.death >= 0;

  /* ── 엎드림 비율 ── */
  const hint = e.namedHint;
  let target = hint === 14 || hint === 15 ? 1 : 0;
  if (dying) target = st.prone >= 0.5 ? 1 : 0;           // 엎드린 채 죽으면 일어서지 않는다
  const rate = st.age < 0.6 ? 40 : target > st.prone ? 3.2 : 4.5;
  st.prone += (target - st.prone) * Math.min(1, dt * rate);
  if (Math.abs(st.prone - target) < 0.001) st.prone = target;
  const p = smooth(THREE.MathUtils.clamp(st.prone, 0, 1));
  st.pose = p;

  st.params.head.y = lerp(st.standHeadY, PRONE_HEAD_Y, p);
  st.params.head.z = lerp(st.standHeadZ, PRONE_HEAD_Z, p);

  // 양각대
  for (let i = 0; i < st.bipodLegs.length; i++) {
    const leg = st.bipodLegs[i];
    const side = leg.userData.side as number;
    leg.rotation.set(lerp(-Math.PI / 2 + 0.08, 0.12, p), 0, side * lerp(0.05, 0.34, p));
  }

  /* ── 조준경 반짝임 ── */
  const glintOn = !dying && (hint === 15 || st.glintHold > 0);
  if (st.glintHold > 0) st.glintHold = Math.max(0, st.glintHold - dt);
  st.glintAge = glintOn ? st.glintAge + dt : 0;
  st.glint += ((glintOn ? 1 : 0) - st.glint) * Math.min(1, dt * (glintOn ? 14 : 8));
  if (st.glint < 0.005 && !glintOn) st.glint = 0;
  const sprite = st.sprite;
  if (st.glint > 0) {
    const ramp = THREE.MathUtils.clamp(st.glintAge / Math.max(0.1, NAMED_SNIPER.glintTime), 0, 1);
    const t = a.time;
    const flicker = 0.78 + 0.22 * Math.sin(t * 27.3) * Math.sin(t * 9.1 + 0.7);
    st.glintOut = st.glint * (0.55 + 0.45 * ramp) * flicker;
    const s = GLINT_SCALE * (0.6 + 0.7 * ramp) * (0.9 + 0.2 * flicker) * st.fovK;
    sprite.scale.set(s, s, 1);
    sprite.material.rotation = t * 0.6;
    if (!sprite.visible) sprite.visible = true;
  } else {
    st.glintOut = 0;
    if (sprite.visible) sprite.visible = false;
  }

  if (p <= 0.001) return;   // 서 있다 — animateRogue 의 자세 그대로

  /* ── 엎드린 자세로 덮어쓰기 (animateRogue 뒤) ── */
  const fall = dying ? smooth(THREE.MathUtils.clamp(a.deathFall, 0, 1)) : 0;
  const side = a.deathDir === 1 ? 1 : a.deathDir === 0 ? -1 : 0;
  const bodyY = PRONE_Y - (dying ? smooth(a.fade) * 0.55 : 0);
  const flx = a.flinch * a.flinchZ * 0.12;
  const flr = a.flinch * a.flinchX * 0.2;
  const body = rig.body;
  body.position.set(lerp(body.position.x, 0, p), lerp(body.position.y, bodyY, p), lerp(body.position.z, 0, p));
  body.rotation.set(
    lerp(body.rotation.x, PRONE_PITCH + a.slopePitch + flx, p),
    lerp(body.rotation.y, a.slopeRoll + flr + side * fall * 0.45, p),   // 엎드리면 몸통 축(로컬 Y)이 정면이라 옆 굴림은 Y 다
    lerp(body.rotation.z, 0, p),
  );

  for (const leg of rig.legs) {
    leg.hip.rotation.x = lerp(leg.hip.rotation.x, 0.05 + fall * 0.05, p);
    leg.hip.rotation.z = lerp(leg.hip.rotation.z, leg.side * 0.2, p);
    leg.knee.rotation.x = lerp(leg.knee.rotation.x, 0.14 - fall * 0.1, p);
  }

  const tx = PRONE_TORSO_X + fall * 0.18;                 // 죽으면 가슴이 땅에 붙는다
  const torso = rig.torso;
  torso.rotation.set(lerp(torso.rotation.x, tx, p), lerp(torso.rotation.y, 0, p), lerp(torso.rotation.z, -a.headYaw * 0.3, p));

  const level = -(PRONE_PITCH + tx);                     // 머리 · 총을 다시 수평으로 세우는 각
  const head = rig.head;
  head.rotation.set(
    lerp(head.rotation.x, level + a.headPitch * 0.6 + fall * 0.7, p),
    lerp(head.rotation.y, a.headYaw * 0.45, p),
    lerp(head.rotation.z, side * fall * 0.4, p),
  );

  const k = a.recoil * a.recoil;
  const gun = rig.gun;
  gun.position.set(
    lerp(gun.position.x, PRONE_GUN_X, p),
    lerp(gun.position.y, PRONE_GUN_Y - k * 0.07, p),      // 몸통 -Y = 엎드린 몸의 뒤쪽 — 반동으로 어깨를 민다
    lerp(gun.position.z, PRONE_GUN_Z, p),
  );
  gun.rotation.set(
    lerp(gun.rotation.x, level + a.headPitch * 0.9 - k * 0.14 + fall * 0.35, p),
    lerp(gun.rotation.y, a.headYaw * 0.5, p),
    lerp(gun.rotation.z, side * fall * 0.7, p),
  );
}

/** 보이는 엎드림 비율 0..1 (로든 리그가 아니면 0). */
export function sniperPoseOf(e: Enemy): number {
  const rig = e.rig;
  if (rig.kind !== 'rogue') return 0;
  const st = lookOf(rig);
  return st ? st.pose : 0;
}

/**
 * 엎드린(또는 엎드리는 중인) 로든의 몸통 캡슐 — 끝점을 `a` · `b` 에 월드 좌표로 적고 반경을 돌려준다.
 * 서 있으면(비율 ≈ 0) -1 → 호출자는 기존 세로 캡슐을 쓴다. 경사(`anim.slopePitch`)는 자세와 같은 규약으로 골반
 * 피벗(`PRONE_Y`) 둘레로 기울인다 — 내리막을 향해 엎드리면 앞 끝이 내려간다.
 */
export function sniperBodyCapsule(e: Enemy, a: THREE.Vector3, b: THREE.Vector3): number {
  const p = sniperPoseOf(e);
  if (p <= 0.001) return -1;
  const r = e.stats.radius, h = e.stats.height;
  const sp = e.anim.slopePitch * p;
  const cs = Math.cos(sp), sn = Math.sin(sp);
  // 서 있는 캡슐 끝(발 + r · 키 − r, z 0) ↔ 엎드린 끝을 보이는 비율로 섞은 뒤 경사로 돌린다
  bodyEnd(e, lerp(r, BODY_BACK_Y, p), BODY_BACK_Z * p, cs, sn, a);
  bodyEnd(e, lerp(Math.max(r, h - r), BODY_FRONT_Y, p), BODY_FRONT_Z * p, cs, sn, b);
  return lerp(r, BODY_PRONE_R, p);
}

/** 루트 좌표 (y, z) 한 점을 골반 피벗 둘레 경사(cos, sin)로 돌려 월드로. 핫 패스라 클로저를 만들지 않는다. */
function bodyEnd(e: Enemy, y: number, z: number, cs: number, sn: number, out: THREE.Vector3): void {
  const yl = y - PRONE_Y;
  const yy = PRONE_Y + yl * cs - z * sn;
  const zz = yl * sn + z * cs;
  out.set(e.position.x + Math.sin(e.yaw) * zz, e.position.y + yy, e.position.z + Math.cos(e.yaw) * zz);
}

/** 폭발 판정의 몸 중심 높이(발 위, m) — 서 있으면 키의 절반, 엎드리면 캡슐 가운데(≈ 0.25). */
export function sniperBodyCenterY(e: Enemy): number {
  return lerp(e.stats.height * 0.5, (BODY_BACK_Y + BODY_FRONT_Y) * 0.5, sniperPoseOf(e));
}

export function disposeSniperLook(rig: RogueRig): void {
  const st = lookOf(rig);
  if (!st) return;
  for (const g of st.geos) g.dispose();
  st.geos.length = 0;
  st.spriteMat.dispose();
  st.texture?.dispose();
  st.sprite.removeFromParent();
  rig.named = undefined;
}
