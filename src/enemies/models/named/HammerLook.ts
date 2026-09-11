/**
 * src/enemies/models/named/HammerLook.ts — **타길라**(`rogue_hammer`)의 겉모습 (2026-09-11).
 *
 * 휴머노이드 로그 리그 위에: 두꺼운 장갑(가슴 · 등 · 옆구리 · 견갑 · 탄부 · 허벅지 · 정강이), 용접 마스크 + 방독 필터 +
 * **붉은 바이저 틈**, 그리고 **양손 대형 망치**. 기본 소총은 팔과 한 메시(`rig.gun`)라 통째로 숨기고, 망치를 쥔 팔을
 * 가슴 한가운데 피벗(`arms`)에 새로 붙인다 — `animateRogue` 가 `rig.gun` 에 쓰는 자세는 보이지 않을 뿐 그대로 돈다.
 *
 * 크기: 기본 로그(1.8 m) × `HAMMER_SCALE`. 히트박스(`enemies.csv` 반경 0.55 · 높이 2.05, 머리 1.86)에 실루엣을 맞췄다 —
 * 배율로 키를, 장갑판으로 폭을 채운다.
 *
 * 자세 (호스트 AI · 리플리카 모두 같은 입력):
 *  - `e.namedHint` 16 → 망치를 머리 뒤로 들어 올리고 상체를 젖힌다.
 *  - `anim.recoil` 이 튀면(타격 순간 — 호스트는 `Hammer.strike`, 리플리카는 `ee hammer`) → 내려찍으며 숙이고 주저앉는다.
 *  - `e.namedHint` 17 → 돌진: 앞으로 기울인다.
 *
 * 지오메트리는 모듈 공유(참조 수 `users`)이고 머티리얼은 리그의 `chitin`(피격 번쩍임) · `eyeMat`(바이저) 을 그대로 쓴다.
 * ⚠ `RogueModel` 에서는 `import type` 만 (순환 import).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig } from '../RogueModel';
import type { Enemy } from '../../Enemy';

/** 와이어 힌트 (`EnemyWire.a`) — AI(`ai/named/Hammer`)가 쓰고 여기서 읽는다. */
export const HAMMER_HINT_WINDUP = 16;
export const HAMMER_HINT_CHARGE = 17;
/** 내려친 망치 머리가 땅에 닿는 곳: 몸 중심에서 앞으로 m (아래 `POSE_STRIKE` 자세에 맞춘 그림 상수). */
export const HAMMER_IMPACT_FORWARD = 1.0;

/** 기본 로그 대비 배율 — 머리 1.66 × 1.12 = 1.86 (`ROGUE_RIG_PARAMS.rogue_hammer`), 키 ≈ 2.05 m. */
const HAMMER_SCALE = 1.12;
const VISOR_RED = 0xff2a12;
const C = {
  armor: 0x2a2626, plate: 0x3a3432, cloth: 0x1a1818, accent: 0x7a1a14,
  metal: 0x5a5250, dark: 0x242020, rust: 0x6a3a22, wood: 0x3a2c22,
};

/* 망치 팔 피벗의 X 회전(rad). 0 = 망치가 정면 수평, 양수 = 머리가 아래로, 음수 = 위 · 뒤로. */
const POSE_CARRY = 1.1;     // 경계 전: 낮게 늘어뜨림
const POSE_READY = 0.6;     // 교전: 앞으로 비스듬히
const POSE_RAISED = -2.3;   // 휘두르기 준비: 머리 뒤로
const POSE_STRIKE = 0.7;    // 내려친 순간 (상체 숙임과 합쳐 머리가 땅에 닿는다)
const POSE_DEAD = 1.5;
const ARMS_Y = 0.5;
const ARMS_Z = 0.06;

interface HammerLookState {
  kind: 'hammer';
  arms: THREE.Group;
  /** 0..1 부드럽게 따라가는 자세 가중치 */
  raise: number;
  slam: number;
  lean: number;
  ready: number;
  droop: number;
}

interface HammerAssets {
  chest: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  mask: THREE.BufferGeometry;
  slit: THREE.BufferGeometry;
  arms: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
}

let assets: HammerAssets | null = null;
let users = 0;

const _col = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const smooth = (x: number): number => x * x * (3 - 2 * x);

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

/** Cylinder from `a` to `b`. */
function limb(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * 0.85, r, len, 8, 1);
  g.translate(0, len / 2, 0);
  _dir.subVectors(_b, _a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] hammer mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}

function build(): HammerAssets {
  // 상체 (torso 피벗 기준 — 기본 가슴은 0.42 × 0.5 × 0.26, 중심 y 0.3)
  const chest = merge([
    box(0.5, 0.4, 0.12, 0, 0.35, 0.15, C.plate),       // 두꺼운 가슴판
    box(0.3, 0.05, 0.13, 0, 0.47, 0.16, C.accent),     // 붉은 띠
    box(0.06, 0.06, 0.06, 0.15, 0.33, 0.22, C.metal),  // 볼트
    box(0.06, 0.06, 0.06, -0.15, 0.33, 0.22, C.metal),
    box(0.44, 0.15, 0.1, 0, 0.1, 0.14, C.armor),       // 복부판
    box(0.46, 0.42, 0.12, 0, 0.32, -0.2, C.armor),     // 등판
    box(0.08, 0.36, 0.26, 0.25, 0.3, 0, C.armor),      // 옆구리판
    box(0.08, 0.36, 0.26, -0.25, 0.3, 0, C.armor),
    box(0.34, 0.1, 0.32, 0, 0.62, 0, C.dark),          // 목 보호대
    box(0.22, 0.16, 0.3, 0.34, 0.56, 0, C.metal),      // 견갑
    box(0.24, 0.04, 0.32, 0.34, 0.65, 0, C.rust),
    box(0.22, 0.16, 0.3, -0.34, 0.56, 0, C.metal),
    box(0.24, 0.04, 0.32, -0.34, 0.65, 0, C.rust),
  ]);
  // 골반 (hip 피벗 기준)
  const pelvis = merge([
    box(0.4, 0.08, 0.3, 0, 0.08, 0, C.dark),           // 넓은 벨트
    box(0.08, 0.06, 0.06, 0, 0.08, 0.16, C.rust),      // 버클
    box(0.16, 0.22, 0.06, 0.12, -0.14, 0.15, C.armor), // 앞 탄부판
    box(0.16, 0.22, 0.06, -0.12, -0.14, 0.15, C.armor),
    box(0.36, 0.2, 0.06, 0, -0.12, -0.15, C.armor),    // 뒤
  ]);
  // 머리 (head 피벗 기준 — 기본 머리 구 r 0.135, 기본 바이저는 z 0.125 에서 마스크 판 뒤로 가려진다)
  const mask = merge([
    box(0.27, 0.26, 0.06, 0, -0.01, 0.13, C.dark),     // 용접 마스크 판
    box(0.29, 0.05, 0.09, 0, 0.12, 0.12, C.metal),     // 이마 턱
    box(0.22, 0.03, 0.03, 0, 0.066, 0.168, C.metal),   // 바이저 틈 위 테
    box(0.22, 0.03, 0.03, 0, 0.004, 0.168, C.metal),   // 아래 테
    box(0.05, 0.05, 0.05, 0.15, 0.08, 0.06, C.metal),  // 경첩
    box(0.05, 0.05, 0.05, -0.15, 0.08, 0.06, C.metal),
    limb(0.07, -0.1, 0.15, 0.13, -0.15, 0.24, 0.042, C.metal),    // 방독 필터
    limb(-0.07, -0.1, 0.15, -0.13, -0.15, 0.24, 0.042, C.metal),
    box(0.075, 0.075, 0.03, 0.135, -0.155, 0.245, C.accent),
    box(0.075, 0.075, 0.03, -0.135, -0.155, 0.245, C.accent),
    box(0.32, 0.07, 0.32, 0, 0.15, -0.01, C.armor),    // 헬멧 캡
    box(0.3, 0.18, 0.06, 0, 0, -0.14, C.armor),        // 뒷목 가리개
  ]);
  const slit = new THREE.BoxGeometry(0.2, 0.03, 0.02);  // 붉게 빛나는 틈 (eyeMat — 정점 색 없음)
  slit.translate(0, 0.035, 0.172);
  // 망치 팔 (가슴 피벗 기준, 자세 0 = 팔을 앞으로 뻗고 망치 자루가 +Z)
  const arms = merge([
    limb(0.26, 0, -0.02, 0.21, -0.13, 0.2, 0.07, C.cloth),        // 오른 위팔
    limb(0.21, -0.13, 0.2, 0.05, -0.06, 0.42, 0.064, C.armor),    // 오른 아래팔 → 손잡이
    limb(-0.26, 0, -0.02, -0.21, -0.12, 0.26, 0.07, C.cloth),     // 왼 위팔
    limb(-0.21, -0.12, 0.26, -0.03, -0.06, 0.62, 0.064, C.armor), // 왼 아래팔 → 손잡이 앞쪽
    box(0.11, 0.11, 0.11, 0.21, -0.13, 0.2, C.metal),             // 팔꿈치
    box(0.11, 0.11, 0.11, -0.21, -0.12, 0.26, C.metal),
    box(0.13, 0.13, 0.13, 0.05, -0.06, 0.42, C.dark),             // 건틀릿
    box(0.13, 0.13, 0.13, -0.03, -0.06, 0.62, C.dark),
    limb(0, -0.06, 0.12, 0, -0.06, 1.2, 0.036, C.wood),           // 자루
    box(0.085, 0.085, 0.36, 0, -0.06, 0.52, C.cloth),             // 손잡이 감개
    box(0.13, 0.15, 0.14, 0, -0.06, 1.12, C.metal),               // 머리 목
    box(0.26, 0.56, 0.3, 0, -0.06, 1.3, C.metal),                 // 망치 머리 (긴 축 Y, 타격면 −Y)
    box(0.28, 0.1, 0.32, 0, -0.06, 1.3, C.rust),                  // 녹슨 띠
    box(0.3, 0.07, 0.34, 0, -0.37, 1.3, C.dark),                  // 타격면
    box(0.3, 0.07, 0.34, 0, 0.25, 1.3, C.dark),                   // 반대면
  ]);
  const thigh = merge([
    box(0.18, 0.26, 0.1, 0, -0.2, 0.08, C.armor),
    box(0.19, 0.04, 0.11, 0, -0.12, 0.08, C.rust),
  ]);
  const shin = merge([
    box(0.16, 0.15, 0.09, 0, -0.02, 0.09, C.metal),    // 무릎 보호대
    box(0.14, 0.28, 0.06, 0, -0.24, 0.09, C.armor),    // 정강이판
    box(0.16, 0.1, 0.3, 0, -0.46, 0.06, C.dark),       // 철판 장화
  ]);
  return { chest, pelvis, mask, slit, arms, thigh, shin };
}

function stateOf(rig: RogueRig): HammerLookState | null {
  const s = rig.named as HammerLookState | undefined;
  return s && s.kind === 'hammer' ? s : null;
}

export function decorateHammerLook(rig: RogueRig): void {
  if (!assets) assets = build();
  users++;
  const A = assets;
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material = rig.chitin): THREE.Mesh => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    x.layers.enable(Layers.ENEMY);
    return x;
  };
  rig.torso.add(mesh(A.chest));
  rig.body.add(mesh(A.pelvis));
  rig.head.add(mesh(A.mask), mesh(A.slit, rig.eyeMat));
  for (const leg of rig.legs) { leg.hip.add(mesh(A.thigh)); leg.knee.add(mesh(A.shin)); }

  const arms = new THREE.Group();
  arms.name = 'hammer_arms';
  arms.position.set(0, ARMS_Y, ARMS_Z);
  arms.rotation.x = POSE_CARRY;
  arms.add(mesh(A.arms));
  rig.torso.add(arms);

  rig.gun.visible = false;                 // 소총 + 소총을 쥔 팔(한 메시) — 망치 팔이 대신한다. `muzzle` 은 그 안에 남는다
  rig.eyeMat.emissive.setHex(VISOR_RED);   // 리그별 복제 머티리얼이라 다른 로그에 번지지 않는다
  rig.baseScale = HAMMER_SCALE;
  rig.root.scale.setScalar(HAMMER_SCALE);
  const state: HammerLookState = { kind: 'hammer', arms, raise: 0, slam: 0, lean: 0, ready: 0, droop: 0 };
  rig.named = state;
}

/** `animateRogue` 뒤에 매 프레임. 기본 자세가 매 프레임 `set` 되므로 여기서는 더하기만 한다. */
export function animateHammerLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const L = stateOf(rig);
  if (!L) return;
  const dying = a.death >= 0;
  const hint = dying ? 0 : e.namedHint;

  const raiseT = hint === HAMMER_HINT_WINDUP ? 1 : 0;
  L.raise += (raiseT - L.raise) * Math.min(1, dt * (raiseT > 0 ? 10 : 3.5));
  const slamT = !dying && a.recoil > 0.35 ? 1 : 0;
  L.slam += (slamT - L.slam) * Math.min(1, dt * (slamT > 0 ? 30 : 3));
  const leanT = hint === HAMMER_HINT_CHARGE ? 1 : 0;
  L.lean += (leanT - L.lean) * Math.min(1, dt * 6);
  const readyT = e.aware && !dying ? 1 : 0;
  L.ready += (readyT - L.ready) * Math.min(1, dt * 3);
  const droopT = !dying && e.state === 'stagger' ? 1 : 0;
  L.droop += (droopT - L.droop) * Math.min(1, dt * 6);

  const sr = smooth(THREE.MathUtils.clamp(L.raise, 0, 1));
  const ss = smooth(THREE.MathUtils.clamp(L.slam, 0, 1));
  const t = a.time;
  const wr = dying ? 0 : a.writhe;

  let pose = THREE.MathUtils.lerp(POSE_CARRY, POSE_READY, L.ready);
  pose += Math.sin(a.gait) * 0.08 * a.speed * (1 - L.ready * 0.6);   // 걸음에 흔들림
  pose = THREE.MathUtils.lerp(pose, POSE_RAISED + Math.sin(t * 38) * 0.02, sr);
  pose = THREE.MathUtils.lerp(pose, POSE_STRIKE, ss);
  pose += L.droop * 0.4 + L.lean * 0.35 + Math.sin(t * 9.3) * 0.5 * wr;
  if (dying) pose = THREE.MathUtils.lerp(pose, POSE_DEAD, Math.min(1, a.deathFall * 1.5));

  L.arms.rotation.set(pose, a.headYaw * 0.25 * (1 - sr), Math.sin(t * 7.1) * 0.3 * wr);
  L.arms.position.set(0, ARMS_Y + sr * 0.06 - ss * 0.04, ARMS_Z - sr * 0.04 + ss * 0.05);

  if (dying) return;
  // 몸: 준비 = 뒤로 젖힘, 내려치기 = 앞으로 숙이며 주저앉음, 돌진 = 앞으로 기울임 (머리는 반대로 들어 정면을 본다)
  rig.torso.rotation.x += -0.28 * sr + 0.35 * ss + 0.28 * L.lean;
  rig.body.rotation.x += 0.12 * ss + 0.25 * L.lean;
  rig.body.position.y -= 0.1 * ss;
  rig.head.rotation.x += 0.2 * sr - 0.25 * ss - 0.2 * L.lean;
}

export function disposeHammerLook(rig: RogueRig): void {
  const L = stateOf(rig);
  if (!L) return;
  rig.named = undefined;
  L.arms.removeFromParent();
  users--;
  if (users <= 0 && assets) {
    const A = assets;
    A.chest.dispose(); A.pelvis.dispose(); A.mask.dispose(); A.slit.dispose(); A.arms.dispose(); A.thigh.dispose(); A.shin.dispose();
    assets = null;
    users = 0;
  }
}
