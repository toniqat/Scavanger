/**
 * src/gadgets/drones/AirDrone.ts — **공중 드론 몸체** (2026-09-11).
 *
 * `DroneBody` 구현 하나. 조종 전환 · 카메라 적용 · 사거리 · 체력 · 네트워크는 `DroneSystem`(코어)이 하고, 이 파일은
 * 물리 · 절차 모델 · 렌즈 자세 · 광선 판정만 갖는다.
 *
 * ## 좌표 규약
 * - `position` = **몸체 중심**. 아래로 `BODY_BOTTOM`(착륙 스키드 밑), 위로 `BODY_TOP`(탑재판 핀 윗면).
 * - `yaw` 는 **`model.ts` 의 드론 yaw 규약**을 따른다 (두 몸체가 같아야 한다) — 모델의 코 = 로컬 **+Z**,
 *   `root.rotation.y = yaw`, 앞 = `(sin yaw, 0, cos yaw)`, 오른쪽 = `(−cos yaw, 0, sin yaw)`, pitch + = 위.
 *   플레이어 yaw(앞 = −sin, −cos)와는 반대라 꺼낼 때 코어가 `droneYawFromPlayer`(+π)로 바꿔 넘긴다.
 *   그래서 왼쪽 = 로컬 +X 다 (빨강 항법 LED 가 +X 에 있다).
 * - 조종 중 `yaw` 는 입력 yaw 를 **그대로** 받는다 — `getCameraPose` 가 이 yaw 로 시점을 풀기 때문에, 여기서
 *   늦추면 마우스가 늦게 따라온다. 입력 yaw 를 부드럽게 따라가는 것은 **보이는 몸체**(`visualYaw`)다.
 *
 * ## 비행
 * - 수평: 입력 방향 × `DRONE_AIR_SPEED` 로 지수 가감속, 손을 떼면 공기 저항처럼 서서히 멈춘다.
 * - 수직: `input.vertical` × `DRONE_AIR_CLIMB_SPEED`. 입력이 없으면 수직 속도도 0 으로 — **제자리 호버**.
 * - `input === null`(아무도 조종 안 함 · 연결 끊김)이면 속도를 0 으로 감쇠하고 그 자리에 떠 있다.
 *   상하 흔들림은 물리가 아니라 `animate` 의 시각 오프셋(`bobY`)이다 — 와이어 자세가 떨리지 않는다.
 *
 * ## 고도 · 충돌
 * - 바닥 = `getSurfaceY(x, z, 몸 밑 + FLOOR_GRACE − PROP_STEP_UP_MAX)` — 몸 밑보다 낮은(또는 거의 같은) 윗면만
 *   바닥으로 센다. 그래서 지붕 · 나무 위로 넘어가면 그 윗면이 바닥이 되고, 2층 바닥판 **밑**을 날 때는 그 판이
 *   바닥이 되지 않는다. 최소 여유 `HOVER_CLEARANCE`, 최대 바닥 + `DRONE_AIR_MAX_ALTITUDE`(넘으면 서서히 내린다).
 * - 장애물은 `world.resolveCollision` 을 **쓰지 않는다** — 그 함수는 걷는 몸 기준(머리 위 여유 2.1 m · 올라설 수
 *   있는 단 예외)이라, 천장 슬래브 1 m 밑을 나는 드론을 슬래브 발자국 밖으로 순간이동시킨다. 대신
 *   `getObstaclesNear` 목록에 대해 3D 로 푼다: 몸의 높이 구간과 겹치는 장애물만, 옆으로 밀기 · 윗면으로 올리기 ·
 *   (떠 있는 상자 한정) 아래로 내리기 중 **가장 얕은 쪽**. 원기둥 · `Obstacle.box`(+`ramp`) · `Obstacle.hull` 셋 다.
 * - 한 프레임 이동은 `SUBSTEP_LEN` 씩 나눠 푼다 (얇은 벽 터널링 방지). 프레임 이동이 몸 반지름의 절반을 넘으면
 *   `world.raycast` 로 진행 방향을 한 번 더 막는다 (프레임 끊김 · 해시에 없는 훈련장 벽).
 *
 * **광원 없음** (씬 광원 개수 규칙, CLAUDE.md) — LED 는 emissive, 로터 블러는 반투명 원판.
 */
import * as THREE from 'three';
import {
  DRONE_AIR_ACCEL, DRONE_AIR_CLIMB_SPEED, DRONE_AIR_MAX_ALTITUDE, DRONE_AIR_MIN_CLEARANCE, DRONE_AIR_SPEED, DroneFlags, PROP_STEP_UP_MAX,
} from '@/shared';
import type { GameContext, Obstacle, WorldRef } from '@/shared';
import type { DroneBody, DroneInput } from './model';

/* ── 몸체 치수 (모델 실측, m) ─────────────────────────────────────────────────────────────── */
/** 중심 → 탑재판 핀 윗면. */
const BODY_TOP = 0.11;
/** 중심 → 착륙 스키드 밑면. */
const BODY_BOTTOM = 0.15;
/** 수평 반지름 — 축 방향 프롭 가드 바깥(0.43)과 대각 끝(0.54) 사이. 갈고리 · 총알 · 충돌이 같이 쓴다. */
const BODY_RADIUS = 0.5;
/** 탑재판 윗면 (로컬 y). */
const MOUNT_Y = 0.096;
/** 모터 중심의 로컬 |x| = |z|. */
const ROTOR_OFF = 0.26;
const ROTOR_Y = 0.085;
/** 짐벌 볼 중심 (로컬). */
const GIMBAL_Y = -0.095;
const GIMBAL_Z = 0.17;
/** 1인칭 렌즈: 몸체 중심에서 앞으로 / 위아래로. 유리면(0.228)보다 살짝 앞. */
const LENS_FWD = 0.25;
const LENS_Y = GIMBAL_Y;

/* ── 조작감 (게임플레이에 닿는 것은 TODO(csv)) ─────────────────────────────────────────────── */
const MAX_DT = 0.1;
/** 수평 가속 응답 (1/s) — `data/constants.csv` 의 `DRONE_AIR_ACCEL` (2026-09-11 리드가 옮김). */
const ACCEL_K = DRONE_AIR_ACCEL;
/** 조종 중 입력을 뗐을 때의 제동 (1/s). */
const BRAKE_K = 3.2;
/** 아무도 조종하지 않을 때 제자리로 서는 감쇠 (1/s) — 조금 흘러가다 선다. */
const HOVER_BRAKE_K = 2.4;
const CLIMB_K = 6;
const CLIMB_BRAKE_K = 7;
/** 몸 밑과 바닥 사이 최소 여유(m) — `data/constants.csv` 의 `DRONE_AIR_MIN_CLEARANCE` (2026-09-11 리드가 옮김). */
const HOVER_CLEARANCE = DRONE_AIR_MIN_CLEARANCE;
/** 몸 밑보다 이만큼 위에 있는 윗면까지는 바닥으로 센다 (낮은 턱을 스치면 올라탄다). */
const FLOOR_GRACE = 0.25;
/** 고도 상한을 넘었을 때 내려오는 속도 = 상승 속도 × 이 값. */
const OVER_ALT_DESCENT_MUL = 1.5;
const SUBSTEP_LEN = 0.2;
const MAX_SUBSTEPS = 8;
const SWEEP_MIN = BODY_RADIUS * 0.5;
/** 장애물 목록 캐시: 이만큼 움직였거나 이 시간이 지나면 다시 묻는다 (`getObstaclesNear` 는 배열을 새로 만든다). */
const REQUERY_MOVE = 1;
const REQUERY_S = 0.3;
/** 윗면 판정 여유 — 이만큼 파고든 것은 겹침으로 치지 않는다. */
const TOP_SKIN = 0.02;
/** 원기둥 소품은 땅에서 올라온다 — 밑면을 조금 묻는다 (`WorldSystem.rayCylinder` 와 같은 값). */
const CYL_SINK = 0.5;

/* ── 시각 연출 ─────────────────────────────────────────────────────────────────────────────── */
const MAX_TILT = 0.3;
const TILT_K = 6;
const YAW_FOLLOW_K = 10;
const BOB_AMP = 0.025;
const BOB_W = 2.4;
/** 로터 각속도 (rad/s) — 공회전 · 조종 중 가산 · 속도 가산. */
const ROTOR_IDLE = 70;
const ROTOR_CTRL = 18;
const ROTOR_MOVE = 30;
const ROTOR_SPIN_K = 2.5;
/** 블레이드 메시가 실제로 도는 최대 속도 — 그 이상은 스트로보처럼 보이므로 블러 원판이 대신한다. */
const BLADE_VIS_MAX = 22;
const BLUR_START = 25;
const BLUR_FULL = 80;
const BLUR_MAX_OPACITY = 0.32;
const GIMBAL_REST = -0.18;
const GIMBAL_MIN = -1.35;
const GIMBAL_MAX = 0.4;
const GIMBAL_K = 10;
const REMOTE_VEL_K = 8;
const NAV_CYCLE = 1.4;
const LED_ON = 1.4;
const LED_FLASH = 4;
const STATUS_IDLE = 0x3a7bff;
const STATUS_CONTROLLED = 0x33e6ff;
const STATUS_LOST = 0xffa21a;

/* ── 소리 ──────────────────────────────────────────────────────────────────────────────────── */
const ROTOR_SFX_SLOW = 0.55;
const ROTOR_SFX_FAST = 0.3;
/** 조종하지 않아도 이 속도 비율 이상으로 움직이면 로터 소리를 낸다. */
const SFX_MOVE_FRAC = 0.15;

/** 모터 배치 순서 (앞왼 · 앞오 · 뒤오 · 뒤왼, 코 = +Z · 왼쪽 = +X) 와 회전 방향 — 대각끼리 같은 방향. */
const ROTOR_SIGN_X = [1, -1, -1, 1] as const;
const ROTOR_SIGN_Z = [1, 1, -1, -1] as const;
const ROTOR_DIR = [1, -1, 1, -1] as const;

/** world 가 해시 엔트리에 붙이는 내부 플래그 (계약 밖) — 깨진 창틀은 작은 몸이 지나간다. */
type PassFlags = { passSmall?: boolean };

/* ── 모듈 스크래치 (핫 패스 할당 없음) ─────────────────────────────────────────────────────── */
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler();
/** 수평 밀어내기 결과: 변위 벡터와 깊이. */
const H = { x: 0, z: 0, depth: 0 };

/* ── 공유 지오메트리 · 머티리얼 (모듈 캐시, 인스턴스가 dispose 하지 않는다) ─────────────────────── */
interface AirGeo {
  hull: THREE.BufferGeometry; shell: THREE.BufferGeometry; plate: THREE.BufferGeometry; pin: THREE.BufferGeometry;
  nose: THREE.BufferGeometry; stripe: THREE.BufferGeometry; arm: THREE.BufferGeometry; motor: THREE.BufferGeometry;
  hub: THREE.BufferGeometry; blade: THREE.BufferGeometry; disc: THREE.BufferGeometry; guard: THREE.BufferGeometry;
  leg: THREE.BufferGeometry; skid: THREE.BufferGeometry; yoke: THREE.BufferGeometry; ball: THREE.BufferGeometry;
  lens: THREE.BufferGeometry; glass: THREE.BufferGeometry; led: THREE.BufferGeometry;
}
let GEO: AirGeo | null = null;
function geo(): AirGeo {
  if (GEO) return GEO;
  GEO = {
    hull: new THREE.BoxGeometry(0.22, 0.09, 0.36),
    shell: new THREE.CylinderGeometry(0.11, 0.15, 0.035, 8),
    plate: new THREE.BoxGeometry(0.16, 0.018, 0.16),
    pin: new THREE.BoxGeometry(0.018, 0.02, 0.018),
    nose: new THREE.BoxGeometry(0.12, 0.05, 0.05),
    stripe: new THREE.BoxGeometry(0.008, 0.028, 0.28),
    arm: new THREE.BoxGeometry(0.034, 0.024, 0.74),
    motor: new THREE.CylinderGeometry(0.034, 0.04, 0.06, 10),
    hub: new THREE.CylinderGeometry(0.014, 0.014, 0.018, 8),
    blade: new THREE.BoxGeometry(0.3, 0.004, 0.026),
    disc: new THREE.CircleGeometry(0.155, 28).rotateX(-Math.PI / 2),
    guard: new THREE.TorusGeometry(0.165, 0.008, 5, 28).rotateX(Math.PI / 2),
    leg: new THREE.BoxGeometry(0.014, 0.095, 0.014),
    skid: new THREE.BoxGeometry(0.016, 0.015, 0.24),
    yoke: new THREE.BoxGeometry(0.07, 0.014, 0.05),
    ball: new THREE.SphereGeometry(0.042, 14, 10),
    lens: new THREE.CylinderGeometry(0.022, 0.026, 0.03, 12).rotateX(Math.PI / 2),
    glass: new THREE.CircleGeometry(0.019, 14),   // 기본 법선 +Z = 코 방향
    led: new THREE.SphereGeometry(0.014, 8, 6),
  };
  return GEO;
}

interface AirMat {
  hull: THREE.Material; shell: THREE.Material; accent: THREE.Material;
  rubber: THREE.Material; blade: THREE.Material; lens: THREE.Material;
}
let MAT: AirMat | null = null;
function mat(): AirMat {
  if (MAT) return MAT;
  MAT = {
    hull: new THREE.MeshStandardMaterial({ color: 0x2a2f35, roughness: 0.5, metalness: 0.55 }),
    shell: new THREE.MeshStandardMaterial({ color: 0x3d444c, roughness: 0.42, metalness: 0.35 }),
    accent: new THREE.MeshStandardMaterial({ color: 0xd8a020, roughness: 0.55, metalness: 0.2 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.9, metalness: 0 }),
    blade: new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.6, metalness: 0.1 }),
    lens: new THREE.MeshStandardMaterial({
      color: 0x04070a, roughness: 0.08, metalness: 0.9, emissive: 0x0b3a48, emissiveIntensity: 0.6,
    }),
  };
  return MAT;
}

function ledMat(hex: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: hex, emissiveIntensity: LED_ON, roughness: 0.4, metalness: 0,
  });
}

/* ── 순수 수학 ─────────────────────────────────────────────────────────────────────────────── */
function clampN(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((((a + Math.PI) % t) + t) % t) - Math.PI;
}

/** 경사 발판 윗면 높이 (`world/obb.rampTopAt` 과 같은 식 — 폴더 import 금지라 계약 필드만 읽어 다시 푼다). */
function rampTopAt(o: Obstacle, x: number, z: number): number {
  const b = o.box!, r = o.ramp!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const lx = clampN((x - o.position.x) * c + (z - o.position.z) * s, -b.halfX, b.halfX);
  const t = b.halfX > 1e-6 ? (lx + b.halfX) / (2 * b.halfX) : 1;
  return o.position.y + o.height - r.rise + r.rise * t;
}

/** 원 vs 원기둥 단면 (총알 실루엣 `shotRadius` 우선 — 날아가는 몸은 보이는 모양에 부딪혀야 한다). */
function pushCircle(o: Obstacle, px: number, pz: number, radius: number): boolean {
  const r = o.shotRadius !== undefined && o.shotRadius > 0 ? o.shotRadius : o.radius;
  let dx = px - o.position.x, dz = pz - o.position.z;
  let d = Math.sqrt(dx * dx + dz * dz);
  const min = radius + r;
  if (d >= min) return false;
  if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
  const push = min - d;
  H.x = (dx / d) * push; H.z = (dz / d) * push; H.depth = push;
  return true;
}

/** 원 vs 회전 상자 단면 (`world/obb.boxPushOut` 과 같은 규약: 중심이 안이면 가장 얕은 면으로). */
function pushBox(o: Obstacle, px: number, pz: number, radius: number): boolean {
  const b = o.box!;
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  const rx = px - o.position.x, rz = pz - o.position.z;
  const lx = rx * c + rz * s, lz = -rx * s + rz * c;
  const qx = clampN(lx, -b.halfX, b.halfX), qz = clampN(lz, -b.halfZ, b.halfZ);
  let ux = lx - qx, uz = lz - qz;
  const d2 = ux * ux + uz * uz;
  if (d2 >= radius * radius) return false;
  let depth: number;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    depth = radius - d;
    ux = (ux / d) * depth; uz = (uz / d) * depth;
  } else {
    const penX = b.halfX - Math.abs(lx), penZ = b.halfZ - Math.abs(lz);
    if (penX <= penZ) { depth = penX + radius; ux = (lx >= 0 ? 1 : -1) * depth; uz = 0; }
    else { depth = penZ + radius; ux = 0; uz = (lz >= 0 ? 1 : -1) * depth; }
  }
  H.x = ux * c - uz * s; H.z = ux * s + uz * c; H.depth = depth;
  return true;
}

/** 원 vs 볼록 윤곽 (`world/hull.hullPushOut` 과 같은 규약, 점은 반시계 `[x0, z0, …]`). */
function pushHull(p: Float32Array, px: number, pz: number, radius: number): boolean {
  const m = p.length >> 1;
  if (m < 3) return false;
  let sMax = -Infinity, nxM = 0, nzM = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-9) continue;
    const nx = dz / len, nz = -dx / len;
    const s = (px - ax) * nx + (pz - az) * nz;
    if (s > sMax) { sMax = s; nxM = nx; nzM = nz; }
  }
  if (sMax === -Infinity || sMax >= radius) return false;
  if (sMax <= 0) {
    const depth = radius - sMax;
    H.x = nxM * depth; H.z = nzM * depth; H.depth = depth;
    return true;
  }
  let best = Infinity, cx = px, cz = pz;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = p[i * 2], az = p[i * 2 + 1];
    const dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? clampN(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (d2 < best) { best = d2; cx = qx; cz = qz; }
  }
  if (best >= radius * radius) return false;
  const d = Math.sqrt(best);
  if (d < 1e-6) { H.x = nxM * radius; H.z = nzM * radius; H.depth = radius; return true; }
  const depth = radius - d;
  H.x = ((px - cx) / d) * depth; H.z = ((pz - cz) / d) * depth; H.depth = depth;
  return true;
}

export class AirDrone implements DroneBody {
  readonly kind = 'air' as const;
  readonly root = new THREE.Group();
  readonly radius = BODY_RADIUS;
  readonly height = BODY_TOP + BODY_BOTTOM;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  readonly sprinting = false;
  readonly airborne = true;

  /** 기울기 · 흔들림을 받는 몸체 (root 는 위치 + 보이는 yaw 만). */
  private readonly tilt = new THREE.Group();
  private readonly gimbal = new THREE.Group();
  /** 소유자 시점에서 렌즈를 가리는 부품. */
  private readonly ownerHidden: THREE.Object3D[] = [];
  private readonly rotors: THREE.Group[] = [];
  private readonly discs: THREE.Mesh[] = [];

  /* 인스턴스 머티리얼 — 드론마다 따로 깜빡이고 흐려진다 (dispose 대상은 이 넷뿐). */
  private readonly blurMat: THREE.MeshBasicMaterial;
  private readonly ledRed: THREE.MeshStandardMaterial;
  private readonly ledGreen: THREE.MeshStandardMaterial;
  private readonly ledStatus: THREE.MeshStandardMaterial;

  private visualYaw = 0;
  private tiltX = 0;
  private tiltZ = 0;
  private appliedTiltX = 0;
  private appliedTiltZ = 0;
  private bobY = 0;
  private rotorSpin = 0;
  private bladeAngle = 0;
  private gimbalPitch = GIMBAL_REST;
  private gimbalTarget = GIMBAL_REST;
  private readonly phase = Math.random() * Math.PI * 2;

  private controlled = false;
  private linkLost = false;
  /** 마지막으로 자세를 받은 경로가 `applyRemote` 다 (속도를 위치 변화로 추정한다). */
  private remote = false;
  private statusMode = -1;
  private readonly remoteVel = new THREE.Vector3();
  private readonly lastAnimPos = new THREE.Vector3();
  private hasAnimPos = false;

  private obstacles: Obstacle[] = [];
  private hasCache = false;
  private cacheX = 0;
  private cacheZ = 0;
  private cacheAge = 0;

  private sfxTimer = 0;
  private disposed = false;

  constructor() {
    const g = geo(), m = mat();
    this.root.name = 'AirDrone';
    this.root.add(this.tilt);

    this.blurMat = new THREE.MeshBasicMaterial({
      color: 0xaeb6bf, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    this.ledRed = ledMat(0xff2a1a);
    this.ledGreen = ledMat(0x2aff5a);
    this.ledStatus = ledMat(STATUS_IDLE);

    const add = (
      gg: THREE.BufferGeometry, mm: THREE.Material, x: number, y: number, z: number,
      parent: THREE.Object3D = this.tilt,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(gg, mm);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // 몸통 · 윗면 셸 · 탑재판 (+ 모서리 핀) · 전면 센서 · 측면 경고 띠
    add(g.hull, m.hull, 0, 0, 0).castShadow = true;
    add(g.shell, m.shell, 0, 0.06, -0.01).castShadow = true;
    add(g.plate, m.rubber, 0, 0.0865, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(g.pin, m.accent, sx * 0.07, 0.1, sz * 0.07);
    this.ownerHidden.push(add(g.nose, m.shell, 0, 0.005, 0.19));
    add(g.stripe, m.accent, -0.113, 0, -0.01);
    add(g.stripe, m.accent, 0.113, 0, -0.01);

    // X 암
    add(g.arm, m.hull, 0, 0.02, 0).rotation.y = Math.PI / 4;
    add(g.arm, m.hull, 0, 0.02, 0).rotation.y = -Math.PI / 4;

    // 모터 · 프롭 가드 · 로터(블레이드 + 허브) · 블러 원판
    for (let i = 0; i < 4; i++) {
      const x = ROTOR_SIGN_X[i] * ROTOR_OFF, z = ROTOR_SIGN_Z[i] * ROTOR_OFF;
      add(g.motor, m.hull, x, 0.05, z);
      add(g.guard, m.shell, x, ROTOR_Y, z);
      const rotor = new THREE.Group();
      rotor.position.set(x, ROTOR_Y + 0.004, z);
      rotor.rotation.y = i * 0.7;
      add(g.blade, m.blade, 0, 0, 0, rotor);
      add(g.hub, m.accent, 0, 0.004, 0, rotor);
      this.tilt.add(rotor);
      this.rotors.push(rotor);
      const disc = add(g.disc, this.blurMat, x, ROTOR_Y + 0.007, z);
      disc.renderOrder = 1;
      disc.visible = false;
      this.discs.push(disc);
    }

    // 항법 LED (빨강 = 왼쪽 = +X, 초록 = 오른쪽 = −X, 둘 다 앞 암 끝) · 뒷면(−Z) 상태 LED
    add(g.led, this.ledRed, ROTOR_OFF, 0.012, ROTOR_OFF);
    add(g.led, this.ledGreen, -ROTOR_OFF, 0.012, ROTOR_OFF);
    add(g.led, this.ledStatus, 0, 0.02, -0.182);

    // 착륙 다리 + 스키드
    const legs = new THREE.Group();
    this.tilt.add(legs);
    for (const sx of [-1, 1]) {
      add(g.leg, m.rubber, sx * 0.085, -0.0925, -0.08, legs);
      add(g.leg, m.rubber, sx * 0.085, -0.0925, 0.08, legs);
      add(g.skid, m.rubber, sx * 0.085, -0.1425, 0, legs);
    }
    this.ownerHidden.push(legs);

    // 짐벌: 요크(고정) + 볼 · 경통 · 유리(피치)
    this.ownerHidden.push(add(g.yoke, m.hull, 0, -0.052, GIMBAL_Z));
    this.gimbal.position.set(0, GIMBAL_Y, GIMBAL_Z);
    this.gimbal.rotation.x = -GIMBAL_REST;
    add(g.ball, m.shell, 0, 0, 0, this.gimbal);
    add(g.lens, m.rubber, 0, 0, 0.042, this.gimbal);
    add(g.glass, m.lens, 0, 0, 0.0575, this.gimbal);
    this.tilt.add(this.gimbal);
    this.ownerHidden.push(this.gimbal);
  }

  /* ── DroneBody ───────────────────────────────────────────────────────────────────────────── */

  reset(position: THREE.Vector3, yaw: number, ctx: GameContext): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.visualYaw = yaw;
    this.tiltX = this.tiltZ = this.appliedTiltX = this.appliedTiltZ = 0;
    this.bobY = 0;
    this.rotorSpin = 0;
    this.gimbalPitch = this.gimbalTarget = GIMBAL_REST;
    this.controlled = false;
    this.linkLost = false;
    this.remote = false;
    this.remoteVel.set(0, 0, 0);
    this.hasAnimPos = false;
    this.obstacles = [];
    this.hasCache = false;
    this.cacheAge = 0;
    this.sfxTimer = 0;
    const world = ctx.world;
    if (world && world.ready) this.clampAltitude(world, 0);   // 땅속에서 꺼내지 않게
    this.syncRoot();
  }

  simulate(dt: number, ctx: GameContext, input: DroneInput | null): void {
    if (this.disposed || !(dt > 0)) return;
    if (dt > MAX_DT) dt = MAX_DT;
    this.remote = false;
    this.controlled = input !== null;
    const p = this.position, v = this.velocity;

    // ── 목표 속도
    let tvx = 0, tvy = 0, tvz = 0, kH = HOVER_BRAKE_K, kV = HOVER_BRAKE_K;
    if (input) {
      this.yaw = input.yaw;
      this.gimbalTarget = clampN(input.pitch, GIMBAL_MIN, GIMBAL_MAX);
      const f = clampN(input.forward, -1, 1), r = clampN(input.right, -1, 1);
      const sy = Math.sin(input.yaw), cy = Math.cos(input.yaw);
      // 앞 = (sin, cos) · 오른쪽 = (−cos, sin) — `GroundDrone` 과 같은 식
      let wx = sy * f - cy * r, wz = cy * f + sy * r;
      const wl = Math.sqrt(wx * wx + wz * wz);
      if (wl > 1) { wx /= wl; wz /= wl; }
      tvx = wx * DRONE_AIR_SPEED;
      tvz = wz * DRONE_AIR_SPEED;
      tvy = clampN(input.vertical, -1, 1) * DRONE_AIR_CLIMB_SPEED;
      kH = wl > 0.01 ? ACCEL_K : BRAKE_K;
      kV = tvy !== 0 ? CLIMB_K : CLIMB_BRAKE_K;
    } else {
      this.gimbalTarget = GIMBAL_REST;
    }
    const aH = 1 - Math.exp(-kH * dt);
    v.x += (tvx - v.x) * aH;
    v.z += (tvz - v.z) * aH;
    v.y += (tvy - v.y) * (1 - Math.exp(-kV * dt));
    if (Math.abs(v.x) < 1e-4) v.x = 0;
    if (Math.abs(v.y) < 1e-4) v.y = 0;
    if (Math.abs(v.z) < 1e-4) v.z = 0;

    // ── 이동 (서브스텝) + 충돌 + 고도
    const world = ctx.world && ctx.world.ready ? ctx.world : null;
    let mx = v.x * dt, my = v.y * dt, mz = v.z * dt;
    const dist = Math.sqrt(mx * mx + my * my + mz * mz);
    if (world) {
      this.refreshObstacles(world, dt);
      const scale = this.sweepScale(world, mx, my, mz, dist);
      mx *= scale; my *= scale; mz *= scale;
    }
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.sqrt(mx * mx + my * my + mz * mz) / SUBSTEP_LEN)));
    const sx = mx / steps, sy = my / steps, sz = mz / steps, sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      const px = p.x, pz = p.z;
      p.x += sx; p.y += sy; p.z += sz;
      if (!world) continue;
      if (!world.isInsideBounds(p.x, p.z)) {
        if (world.isInsideBounds(p.x, pz)) { p.z = pz; v.z = 0; }
        else if (world.isInsideBounds(px, p.z)) { p.x = px; v.x = 0; }
        else { p.x = px; p.z = pz; v.x = 0; v.z = 0; }
      }
      this.resolveObstacles(world);
      this.clampAltitude(world, sdt);
    }
    this.syncRoot();

    // ── 로터 소리 (조종 중 · 움직일 때만)
    const frac = clampN(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) / DRONE_AIR_SPEED, 0, 1);
    if (this.controlled || frac > SFX_MOVE_FRAC) {
      this.sfxTimer -= dt;
      if (this.sfxTimer <= 0) {
        this.sfxTimer = ROTOR_SFX_SLOW + (ROTOR_SFX_FAST - ROTOR_SFX_SLOW) * frac;
        ctx.bus.emit('audio:play', {
          id: 'drone_rotor', position: this.position, volume: 0.3 + 0.4 * frac, pitch: 0.9 + 0.25 * frac,
        });
      }
    } else {
      this.sfxTimer = 0;
    }
  }

  applyRemote(position: THREE.Vector3, yaw: number, flags: number): void {
    this.remote = true;
    this.position.copy(position);
    this.yaw = yaw;
    this.controlled = (flags & DroneFlags.CONTROLLED) !== 0;
    this.linkLost = (flags & DroneFlags.LINK_LOST) !== 0;
    this.gimbalTarget = GIMBAL_REST;
    this.root.position.copy(position);
  }

  animate(dt: number, time: number): void {
    if (this.disposed) return;
    const p = this.position;
    const d = dt > 0 ? Math.min(dt, MAX_DT) : 0;

    // 속도: 소유자는 물리 값, 복제본은 위치 변화에서 추정
    let vx: number, vy: number, vz: number;
    if (this.remote) {
      if (this.hasAnimPos && dt > 1e-4) {
        const a = 1 - Math.exp(-REMOTE_VEL_K * d);
        const cap = DRONE_AIR_SPEED * 2;
        this.remoteVel.x += (clampN((p.x - this.lastAnimPos.x) / dt, -cap, cap) - this.remoteVel.x) * a;
        this.remoteVel.y += (clampN((p.y - this.lastAnimPos.y) / dt, -cap, cap) - this.remoteVel.y) * a;
        this.remoteVel.z += (clampN((p.z - this.lastAnimPos.z) / dt, -cap, cap) - this.remoteVel.z) * a;
      }
      vx = this.remoteVel.x; vy = this.remoteVel.y; vz = this.remoteVel.z;
    } else {
      vx = this.velocity.x; vy = this.velocity.y; vz = this.velocity.z;
    }
    this.lastAnimPos.copy(p);
    this.hasAnimPos = true;
    const frac = clampN(Math.sqrt(vx * vx + vy * vy + vz * vz) / DRONE_AIR_SPEED, 0, 1);

    // 보이는 yaw 가 입력 yaw 를 부드럽게 따라간다
    this.visualYaw = wrapAngle(this.visualYaw + wrapAngle(this.yaw - this.visualYaw) * (1 - Math.exp(-YAW_FOLLOW_K * d)));
    this.root.position.copy(p);
    this.root.rotation.y = this.visualYaw;

    // 진행 방향으로 기울기 (앞으로 가면 기수가 숙여지고, 오른쪽으로 가면 오른쪽이 내려간다) + 공회전 흔들림.
    // Rx(+) 는 +Z(코)를 내리고, Rz(+) 는 −X(오른쪽)를 내린다 — 그래서 둘 다 속도 성분의 부호 그대로다.
    const s = Math.sin(this.visualYaw), c = Math.cos(this.visualYaw);
    const vf = vx * s + vz * c, vr = -vx * c + vz * s;
    const aT = 1 - Math.exp(-TILT_K * d);
    this.tiltX += (clampN(vf / DRONE_AIR_SPEED, -1, 1) * MAX_TILT - this.tiltX) * aT;
    this.tiltZ += (clampN(vr / DRONE_AIR_SPEED, -1, 1) * MAX_TILT - this.tiltZ) * aT;
    const calm = 1 - 0.7 * frac;
    this.appliedTiltX = this.tiltX + Math.sin(time * 1.3 + this.phase) * 0.012 * calm;
    this.appliedTiltZ = this.tiltZ + Math.sin(time * 1.7 + this.phase * 1.3) * 0.015 * calm;
    this.tilt.rotation.set(this.appliedTiltX, 0, this.appliedTiltZ);
    this.bobY = Math.sin(time * BOB_W + this.phase) * BOB_AMP * calm;
    this.tilt.position.y = this.bobY;

    // 로터: 블레이드는 눈에 보이는 속도까지만 돌고, 그 위는 블러 원판이 짙어진다
    const climb = vy > 0 ? (vy / DRONE_AIR_CLIMB_SPEED) * 10 : 0;
    const target = ROTOR_IDLE + (this.controlled ? ROTOR_CTRL : 0) + ROTOR_MOVE * frac + climb;
    this.rotorSpin += (target - this.rotorSpin) * (1 - Math.exp(-ROTOR_SPIN_K * d));
    this.bladeAngle = (this.bladeAngle + Math.min(this.rotorSpin, BLADE_VIS_MAX) * d) % (Math.PI * 2);
    for (let i = 0; i < this.rotors.length; i++) this.rotors[i].rotation.y = this.bladeAngle * ROTOR_DIR[i] + i * 0.7;
    const blur = clampN((this.rotorSpin - BLUR_START) / (BLUR_FULL - BLUR_START), 0, 1) * BLUR_MAX_OPACITY;
    this.blurMat.opacity = blur;
    const showDisc = blur > 0.01;
    for (let i = 0; i < this.discs.length; i++) this.discs[i].visible = showDisc;

    // 짐벌
    this.gimbalPitch += (this.gimbalTarget - this.gimbalPitch) * (1 - Math.exp(-GIMBAL_K * d));
    this.gimbal.rotation.x = -this.gimbalPitch;   // Rx(+) 가 +Z(렌즈)를 내리므로 pitch + = 위는 부호를 뒤집는다

    // 항법 LED: 켜진 채 주기마다 두 번 번쩍
    const cyc = (((time + this.phase) % NAV_CYCLE) + NAV_CYCLE) % NAV_CYCLE;
    const nav = cyc < 0.07 || (cyc > 0.16 && cyc < 0.23) ? LED_FLASH : LED_ON;
    this.ledRed.emissiveIntensity = nav;
    this.ledGreen.emissiveIntensity = nav;

    // 상태 LED: 조종 중 = 청록 · 연결 끊김 = 호박색 점멸 · 대기 = 파랑 느린 맥동
    const mode = this.linkLost ? 2 : this.controlled ? 1 : 0;
    if (mode !== this.statusMode) {
      this.statusMode = mode;
      this.ledStatus.emissive.setHex(mode === 2 ? STATUS_LOST : mode === 1 ? STATUS_CONTROLLED : STATUS_IDLE);
    }
    this.ledStatus.emissiveIntensity = mode === 2
      ? (Math.sin(time * 25) > 0 ? 3 : 0.2)
      : mode === 1
        ? 2.2 + 0.3 * Math.sin(time * 6)
        : 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(time * 2.2 + this.phase));
  }

  getCameraPose(pitch: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    outPos.set(this.position.x + s * LENS_FWD, this.position.y + LENS_Y + this.bobY, this.position.z + c * LENS_FWD);
    const cp = Math.cos(pitch);
    outLook.set(outPos.x + s * cp, outPos.y + Math.sin(pitch), outPos.z + c * cp);
  }

  getMountPoint(out: THREE.Vector3): THREE.Vector3 {
    // root(Ry) × tilt(Rx·Rz) 와 같은 회전 = Euler 'YXZ'
    _euler.set(this.appliedTiltX, this.visualYaw, this.appliedTiltZ, 'YXZ');
    out.set(0, MOUNT_Y, 0).applyEuler(_euler);
    out.x += this.position.x;
    out.y += this.position.y + this.bobY;
    out.z += this.position.z;
    return out;
  }

  /** 납작한 타원체 (수평 반지름 `radius`, 수직 반지름 `height / 2`). 원점이 안에 있으면 −1 (world 규약). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    if (this.disposed || !(maxDist > 0)) return -1;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dl < 1e-8) return -1;
    dx /= dl; dy /= dl; dz /= dl;
    const ry = this.height * 0.5;
    const k = BODY_RADIUS / ry;
    const cy = this.position.y + (BODY_TOP - BODY_BOTTOM) * 0.5;
    const ox = origin.x - this.position.x, oy = (origin.y - cy) * k, oz = origin.z - this.position.z;
    const ey = dy * k;
    const a = dx * dx + ey * ey + dz * dz;
    const b = ox * dx + oy * ey + oz * dz;
    const cc = ox * ox + oy * oy + oz * oz - BODY_RADIUS * BODY_RADIUS;
    if (cc <= 0) return -1;
    const disc = b * b - a * cc;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / a;
    return t >= 0 && t <= maxDist ? t : -1;
  }

  setOwnerView(looking: boolean): void {
    for (let i = 0; i < this.ownerHidden.length; i++) this.ownerHidden[i].visible = !looking;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.blurMat.dispose();
    this.ledRed.dispose();
    this.ledGreen.dispose();
    this.ledStatus.dispose();
    this.obstacles = [];
  }

  /* ── 내부 ────────────────────────────────────────────────────────────────────────────────── */

  private syncRoot(): void {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.visualYaw;
  }

  private refreshObstacles(world: WorldRef, dt: number): void {
    const p = this.position;
    this.cacheAge += dt;
    const dx = p.x - this.cacheX, dz = p.z - this.cacheZ;
    if (this.hasCache && this.cacheAge < REQUERY_S && dx * dx + dz * dz <= REQUERY_MOVE * REQUERY_MOVE) return;
    const reach = BODY_RADIUS + REQUERY_MOVE + Math.max(DRONE_AIR_SPEED, DRONE_AIR_CLIMB_SPEED) * MAX_DT + 0.25;
    this.obstacles = world.getObstaclesNear(p.x, p.z, reach);
    this.cacheX = p.x;
    this.cacheZ = p.z;
    this.cacheAge = 0;
    this.hasCache = true;
  }

  /** 프레임 이동이 길면 진행 방향 레이로 막는다. 이동 배율(0..1)을 돌려주고, 벽으로 향한 속도 성분을 지운다. */
  private sweepScale(world: WorldRef, mx: number, my: number, mz: number, dist: number): number {
    if (dist <= SWEEP_MIN) return 1;
    _dir.set(mx / dist, my / dist, mz / dist);
    const hit = world.raycast(this.position, _dir, dist + BODY_RADIUS);
    if (!hit) return 1;
    if (hit.obstacle && (hit.obstacle as Obstacle & PassFlags).passSmall) return 1;
    const allowed = Math.max(0, hit.distance - BODY_RADIUS);
    if (allowed >= dist) return 1;
    const n = hit.normal, v = this.velocity;
    const vn = v.x * n.x + v.y * n.y + v.z * n.z;
    if (vn < 0) { v.x -= n.x * vn; v.y -= n.y * vn; v.z -= n.z * vn; }
    return allowed / dist;
  }

  /** 몸의 높이 구간과 겹치는 장애물을 옆 · 위 · (떠 있는 상자면) 아래 중 가장 얕은 쪽으로 빼낸다. */
  private resolveObstacles(world: WorldRef): void {
    const list = this.obstacles;
    const p = this.position, v = this.velocity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if ((o as Obstacle & PassFlags).passSmall) continue;
      let base: number, top: number;
      if (o.box) {
        base = o.position.y;
        top = o.ramp ? rampTopAt(o, p.x, p.z) : base + o.height;
      } else if (o.hull) {
        base = o.position.y;
        top = base + o.height;
      } else {
        base = o.position.y - CYL_SINK;
        top = o.position.y + (o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height);
      }
      const yb = p.y - BODY_BOTTOM, yt = p.y + BODY_TOP;
      if (yb >= top - TOP_SKIN || yt <= base) continue;
      const hit = o.box ? pushBox(o, p.x, p.z, BODY_RADIUS)
        : o.hull ? pushHull(o.hull.points, p.x, p.z, BODY_RADIUS)
          : pushCircle(o, p.x, p.z, BODY_RADIUS);
      if (!hit) continue;
      const up = top - yb;
      // 아래로 빼내기는 밑에 드론이 들어갈 틈이 있는 떠 있는 상자(천장 · 2층 바닥판 · 창 윗벽)만
      let down = Infinity;
      if (o.box && base - world.getHeightAt(p.x, p.z) > this.height + HOVER_CLEARANCE + 0.1) down = yt - base;
      if (up <= H.depth && up <= down) {
        p.y += up;
        if (v.y < 0) v.y = 0;
      } else if (down < H.depth) {
        p.y -= down;
        if (v.y > 0) v.y = 0;
      } else {
        p.x += H.x;
        p.z += H.z;
        const inv = H.depth > 1e-6 ? 1 / H.depth : 0;
        const nx = H.x * inv, nz = H.z * inv;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) { v.x -= nx * vn; v.z -= nz * vn; }
      }
    }
  }

  /** 발밑 표면 위 최소 여유 ~ 최대 고도. `dt` 0 = 즉시 (reset). */
  private clampAltitude(world: WorldRef, dt: number): void {
    const p = this.position, v = this.velocity;
    const bottom = p.y - BODY_BOTTOM;
    let floor = world.getSurfaceY(p.x, p.z, bottom + FLOOR_GRACE - PROP_STEP_UP_MAX);
    // 비탈을 향해 날 때 로터가 먼저 박히지 않게 진행 방향 앞쪽 지형도 본다
    const hs = Math.sqrt(v.x * v.x + v.z * v.z);
    if (hs > 0.5) {
      const k = (BODY_RADIUS * 0.8) / hs;
      const lead = world.getHeightAt(p.x + v.x * k, p.z + v.z * k);
      if (lead > floor) floor = lead;
    }
    const minY = floor + BODY_BOTTOM + HOVER_CLEARANCE;
    if (p.y < minY) {
      p.y = minY;
      if (v.y < 0) v.y = 0;
    }
    const maxY = floor + DRONE_AIR_MAX_ALTITUDE;
    if (p.y > maxY) {
      p.y = dt > 0 ? Math.max(maxY, p.y - DRONE_AIR_CLIMB_SPEED * OVER_ALT_DESCENT_MUL * dt) : maxY;
      if (v.y > 0) v.y = 0;
    }
  }
}
