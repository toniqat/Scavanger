/**
 * src/gadgets/parts/Preview.ts — **손에 든 설치형 가젯을 지금 놓으면 어디에 서고, 설 수 있나?** (2026-09-11)
 *
 * 판정은 `computePlacement` **하나**다. 매 프레임 미리보기(고스트 + `GadgetsRef.placement`)가 그것을 돌리고,
 * 좌클릭(`Deploy.use` 의 place 경로)도 그 순간 같은 함수를 다시 돌린 결과로 설치한다 — 초록이면 서고, 빨강이면
 * 같은 사유로 거부된다. 호스트는 클라이언트의 `gadq place` 를 `resolveRemotePlace` 로 가볍게만 다시 본다
 * (아이템은 이미 클라이언트에서 소모됐으므로 드론이 사라졌으면 그 아래 바닥에 세운다).
 *
 * 조준 광선은 카메라 레티클(`PlayerWeaponHost.getAimRay`)이고, 발에서 수평 `GADGET_PLACE_RANGE` 원을
 * 빠져나가는 지점에서 끊는다. 그 안에서 아무것도 맞지 않았거나 벽을 맞혔으면 그 아래 표면으로 떨어뜨린다.
 */
import * as THREE from 'three';
import {
  GADGET_JUMPPAD_RADIUS, GADGET_PLACE_LARGE_MAX_STEP, GADGET_PLACE_LARGE_MIN_NORMAL_Y, GADGET_PLACE_RANGE,
  GADGET_PLACE_SMALL_MIN_NORMAL_Y, isLargeDeployable, isMountableDeployable,
  type DeployableKind, type GadgetDef, type GadgetId, type GameContext, type Obstacle, type PlacementPreview,
  type PlayerWeaponHost,
} from '@/shared';
import { gadgetDef } from '../GadgetDefs';
import { BARRICADE_HALF } from '../Deployable';
import { PLACE_CLEARANCE, PLACE_VERTICAL_REACH } from '../model';
import type { GadgetSystem } from '../GadgetSystem';

/* ── 거부 사유 (UI 가 그대로 찍는다) ── */
const R_NOWHERE = '설치할 수 없는 곳이다';
const R_FAR = '너무 멀다';
const R_SLOPE = '바닥이 너무 기울었다';
const R_UNEVEN = '바닥이 고르지 않다';
const R_SPACE = '공간이 부족하다';
const R_OVERLAP = '다른 설치물과 겹친다';
const R_DRONE_LARGE = '드론 위에는 올릴 수 없다';
const R_DRONE_TAKEN = '이미 드론에 설치물이 있다';

/* ── 기하 분류 (수치 밸런스가 아니라 "무엇을 맞혔나" 를 가르는 값) ── */
/** 맞힌 면의 법선 y 가 이보다 작으면 바닥이 아니라 벽 · 천장으로 본다 → 한 걸음 물러나 아래 바닥으로 떨어뜨린다. */
const WALL_NORMAL_Y = 0.3;
/** 벽을 맞혔을 때 광선 반대 방향으로 물러나는 수평 거리(m). */
const WALL_BACKOFF = 0.35;
/** 위를 보고 있을 때(발 원 안에서 광선이 끝나지 않을 때) 광선을 쏘는 최대 길이(m). */
const RAY_CAP = 40;
/** 표면을 찾을 때 발 높이 위로 보는 여유(m) — 가슴 높이 상자 윗면까지는 올린다. */
const DROP_FEET_MARGIN = 0.5;
/** 지형 위로 이만큼(m) 떠 있는 표면은 장애물 윗면(건물 바닥 · 상자)이라 법선을 위로 본다. */
const OBSTACLE_TOP_EPS = 0.05;
/** 호스트가 클라의 드론 탑재 요청을 믿는 거리(m) — 복제본 보간 지연만큼 넉넉히. */
const MOUNT_TOLERANCE = 4;
/** 포탑 받침대 + 다리가 차지하는 반경(m) (`GadgetVisuals` 의 포탑 실루엣). */
const TURRET_FOOTPRINT = 0.6;
const TURRET_HEIGHT = 1.15;
/** 소형 설치물(지뢰 · 원격 지뢰)의 반경 · 높이(m). */
const SMALL_FOOTPRINT = 0.3;
const SMALL_HEIGHT = 0.3;
const JUMPPAD_HEIGHT = 0.35;

/** 한 종류가 차지하는 자리. 좌표는 설치물 로컬(yaw 회전 전). */
interface Footprint {
  /** 장애물 겹침 원 `[x, z, r, …]`. */
  circles: readonly number[];
  /** 광역 질의 반경 — 원 전부를 품는다. */
  reach: number;
  /** 이 높이 안에 들어오는 장애물만 "공간을 막는다". */
  height: number;
  /** 평탄도 샘플 `[x, z, …]` (대형만). */
  samples: readonly number[];
  /** 고스트 발자국 링의 반경 (0 = 링 없음). */
  ringX: number;
  ringZ: number;
}

const FOOTPRINTS = new Map<DeployableKind, Footprint>();

function ringSamples(r: number, n: number): number[] {
  const out = [0, 0];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return out;
}

function footprintOf(kind: DeployableKind): Footprint {
  const hit = FOOTPRINTS.get(kind);
  if (hit) return hit;
  let fp: Footprint;
  switch (kind) {
    case 'barricade': {
      const hx = BARRICADE_HALF.x, hz = BARRICADE_HALF.z;
      const cx = hx * 0.66;
      const samples: number[] = [];
      for (const x of [-hx, -hx * 0.5, 0, hx * 0.5, hx]) samples.push(x, -hz, x, 0.5);
      // 받침다리가 +z 로 0.6 m 쯤 뻗는다 (`GadgetVisuals` barricade) → 원 중심을 조금 민다
      fp = { circles: [-cx, 0.1, 0.75, 0, 0.1, 0.75, cx, 0.1, 0.75], reach: hx + 0.4, height: BARRICADE_HALF.y * 2, samples, ringX: hx + 0.2, ringZ: 0.8 };
      break;
    }
    case 'jumpPad': {
      const r = GADGET_JUMPPAD_RADIUS;
      fp = { circles: [0, 0, r], reach: r, height: JUMPPAD_HEIGHT, samples: ringSamples(r * 0.9, 8), ringX: r, ringZ: r };
      break;
    }
    case 'turret':
      fp = { circles: [0, 0, TURRET_FOOTPRINT], reach: TURRET_FOOTPRINT, height: TURRET_HEIGHT, samples: ringSamples(TURRET_FOOTPRINT, 6), ringX: TURRET_FOOTPRINT + 0.1, ringZ: TURRET_FOOTPRINT + 0.1 };
      break;
    default:
      fp = { circles: [0, 0, SMALL_FOOTPRINT], reach: SMALL_FOOTPRINT, height: SMALL_HEIGHT, samples: [], ringX: 0, ringZ: 0 };
      break;
  }
  FOOTPRINTS.set(kind, fp);
  return fp;
}

/* scratch — 이 파일 전용 (model 의 `_a…` 는 호출자(Wire)가 들고 들어온다) */
const _o = new THREE.Vector3(), _dir = new THREE.Vector3(), _n = new THREE.Vector3(), _mp = new THREE.Vector3();

export function createPreview(): PlacementPreview {
  return { gadget: 'barricade', kind: 'barricade', valid: false, reason: null, position: new THREE.Vector3(), yaw: 0, mount: null };
}

/** 마지막으로 `gadget:placementChanged` 에 실어 보낸 값. */
export interface PreviewKey { gadget: GadgetId | null; valid: boolean; reason: string | null; mount: string | null }
export function createPreviewKey(): PreviewKey {
  return { gadget: null, valid: false, reason: null, mount: null };
}

function fail(out: PlacementPreview, reason: string): PlacementPreview {
  out.valid = false;
  out.reason = reason;
  return out;
}

/** 이 드론 위에 이미 올라탄 설치물이 있나. */
export function droneOccupied(sys: GadgetSystem, droneId: string): boolean {
  for (const d of sys.deployables) if (!d.removing && d.mount === droneId) return true;
  return false;
}

/** 광선이 발 중심 수평 반경 `r` 원을 빠져나가는 `t` (광선이 원 안에서 시작한다고 본다). −1 = 원과 만나지 않는다. */
function exitT(ox: number, oz: number, dx: number, dz: number, fx: number, fz: number, r: number): number {
  const px = ox - fx, pz = oz - fz;
  const a = dx * dx + dz * dz;
  const c = px * px + pz * pz - r * r;
  if (a < 1e-8) return c <= 0 ? RAY_CAP : -1;
  const b = 2 * (px * dx + pz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return t > 0 ? Math.min(t, RAY_CAP) : -1;
}

/** 원(월드 XZ)이 장애물 단면과 겹치나 — 사각은 OBB, 볼록 기둥은 윤곽, 나머지는 원기둥. */
function circleHitsObstacle(o: Obstacle, cx: number, cz: number, r: number): boolean {
  const dx = cx - o.position.x, dz = cz - o.position.z;
  if (o.box) {
    const b = o.box;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const qx = lx < -b.halfX ? -b.halfX : lx > b.halfX ? b.halfX : lx;
    const qz = lz < -b.halfZ ? -b.halfZ : lz > b.halfZ ? b.halfZ : lz;
    const ex = lx - qx, ez = lz - qz;
    return ex * ex + ez * ez <= r * r;
  }
  const hull = o.hull;
  if (hull && hull.points.length >= 6) {
    const p = hull.points;
    const m = p.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ax = p[i * 2], az = p[i * 2 + 1];
      const ex = p[j * 2] - ax, ez = p[j * 2 + 1] - az;
      const len = Math.sqrt(ex * ex + ez * ez);
      if (len < 1e-9) continue;
      // 반시계 윤곽: 양수 = 그 변의 바깥
      if (((cx - ax) * ez - (cz - az) * ex) / len > r) return false;
    }
    return true;
  }
  const rr = o.radius + r;
  return dx * dx + dz * dz <= rr * rr;
}

/**
 * **설치 판정 하나.** `def` 를 지금 조준점에 놓으면 어디에(`position` · `yaw` · `mount`) 서고, 설 수 있나(`valid` ·
 * `reason`). `out` 을 채워 돌려준다 — 이벤트도 상태 변경도 없다.
 */
export function computePlacement(sys: GadgetSystem, def: GadgetDef, out: PlacementPreview): PlacementPreview {
  const ctx = sys.ctx;
  const kind = def.deployable ?? 'mine';
  out.gadget = def.id;
  out.kind = kind;
  out.valid = false;
  out.reason = null;
  out.mount = null;
  const p = ctx.player;
  const world = ctx.world;
  if (!p) return fail(out, R_NOWHERE);
  out.yaw = p.yaw;
  out.position.copy(p.position);
  if (!world || !world.ready) return fail(out, R_NOWHERE);

  const large = isLargeDeployable(kind);
  const feet = p.position;

  // ── 조준 광선 (레티클), 발 수평 반경에서 끊는다 ──
  const host = p as unknown as Partial<PlayerWeaponHost>;
  if (typeof host.getAimRay === 'function') host.getAimRay(_o, _dir);
  else { p.getEyePosition(_o); p.getForward(_dir); }
  if (_dir.lengthSq() < 1e-8) return fail(out, R_NOWHERE);
  _dir.normalize();
  const tMax = exitT(_o.x, _o.z, _dir.x, _dir.z, feet.x, feet.z, GADGET_PLACE_RANGE);
  if (tMax <= 0) return fail(out, R_FAR);

  const hit = world.raycast(_o, _dir, tMax);

  // ── 드론 몸체가 세계보다 가까우면 드론 위 ──
  const drones = ctx.drones;
  const droneHit = drones ? drones.raycast(_o, _dir, hit ? hit.distance : tMax) : null;
  if (droneHit && (!hit || droneHit.distance < hit.distance)) {
    const drone = droneHit.drone;
    drone.getMountPoint(out.position);
    if (large || !isMountableDeployable(kind)) return fail(out, R_DRONE_LARGE);
    out.mount = drone.id;
    if (droneOccupied(sys, drone.id)) return fail(out, R_DRONE_TAKEN);
    out.valid = true;
    return out;
  }

  // ── 바닥 ──
  let drop = false;
  if (hit) {
    out.position.copy(hit.point);
    _n.copy(hit.normal);
    if (_n.y < WALL_NORMAL_Y) {
      // 벽 · 천장 밑면: 광선 반대로 한 걸음 물러나 그 아래 바닥으로
      const flat = Math.hypot(_dir.x, _dir.z);
      if (flat > 1e-4) {
        out.position.x -= (_dir.x / flat) * WALL_BACKOFF;
        out.position.z -= (_dir.z / flat) * WALL_BACKOFF;
      }
      drop = true;
    }
  } else {
    // 반경 안에서 아무것도 맞지 않았다 → 반경 가장자리에서 끊고 그 아래 표면으로
    out.position.copy(_o).addScaledVector(_dir, tMax);
    drop = true;
  }
  const x = out.position.x, z = out.position.z;
  if (!world.isInsideBounds(x, z)) return fail(out, R_NOWHERE);
  if (drop) {
    const probe = Math.min(out.position.y, feet.y + DROP_FEET_MARGIN);
    const y = world.getSurfaceY(x, z, probe);
    out.position.y = y;
    if (y > world.getHeightAt(x, z) + OBSTACLE_TOP_EPS) _n.set(0, 1, 0);
    else world.getNormalAt(x, z, _n);
  }
  const y = out.position.y;
  if (Math.abs(y - feet.y) > PLACE_VERTICAL_REACH) return fail(out, R_FAR);
  // 움직이는 발판(전차 데크) 위에는 세우지 않는다 — 설치물은 발판을 따라가지 않는다
  const standing = world.getStandingObstacle(x, z, y);
  if (standing && standing.velocity) return fail(out, R_NOWHERE);

  // ── 경사 ──
  if (_n.y < (large ? GADGET_PLACE_LARGE_MIN_NORMAL_Y : GADGET_PLACE_SMALL_MIN_NORMAL_Y)) return fail(out, R_SLOPE);

  const fp = footprintOf(kind);
  const cos = Math.cos(out.yaw), sin = Math.sin(out.yaw);

  // ── 평탄도 (대형): 발자국 안 표면 높이의 최고 − 최저 ──
  if (large && fp.samples.length > 0) {
    let lo = y, hi = y;
    for (let i = 0; i < fp.samples.length; i += 2) {
      const lx = fp.samples[i], lz = fp.samples[i + 1];
      const sx = x + lx * cos + lz * sin, sz = z - lx * sin + lz * cos;
      if (!world.isInsideBounds(sx, sz)) return fail(out, R_NOWHERE);
      const sy = world.getSurfaceY(sx, sz, y);
      if (sy < lo) lo = sy;
      if (sy > hi) hi = sy;
      if (hi - lo > GADGET_PLACE_LARGE_MAX_STEP) return fail(out, R_UNEVEN);
    }
  }

  // ── 공간: 발자국 원과 겹치는 장애물 (밟고 선 바닥 · 머리 위 슬래브는 빼고) ──
  const near = world.getObstaclesNear(x, z, fp.reach);
  const floorTop = y + GADGET_PLACE_LARGE_MAX_STEP;
  const ceil = y + fp.height;
  for (let k = 0; k < near.length; k++) {
    const o = near[k];
    if (o.position.y + o.height <= floorTop) continue;
    if (o.position.y >= ceil) continue;
    for (let i = 0; i < fp.circles.length; i += 3) {
      const lx = fp.circles[i], lz = fp.circles[i + 1], r = fp.circles[i + 2];
      const cx = x + lx * cos + lz * sin, cz = z - lx * sin + lz * cos;
      if (circleHitsObstacle(o, cx, cz, r)) return fail(out, R_SPACE);
    }
  }

  // ── 다른 설치물 간격 (지금 `PLACE_CLEARANCE` 규칙, 바리케이드는 두 배) ──
  for (const d of sys.deployables) {
    if (d.removing || d.mount) continue;
    if (d.kind === 'smoke' || d.kind === 'fire' || d.kind === 'domeShield') continue;
    const clearance = d.kind === 'barricade' || kind === 'barricade' ? PLACE_CLEARANCE * 2 : PLACE_CLEARANCE;
    if (d.position.distanceToSquared(out.position) < clearance * clearance) return fail(out, R_OVERLAP);
  }

  out.valid = true;
  return out;
}

/**
 * 손이 **기폭기**인가 — 마지막 원격 지뢰를 놓은 뒤 weapons 가 남기는 손(슬롯 없음 · 수량 0). 그동안
 * `heldItemId` 는 C4 def id 로 남으므로 이것으로 가른다. 계약 타입에 없는 필드라 캐스트로 읽는다.
 */
export function isDetonatorHand(ctx: GameContext): boolean {
  return (ctx.weapons?.remoteState as { detonator?: boolean } | undefined)?.detonator === true;
}

/** 지금 손에 든 `place` 가젯, 없으면 null. */
function heldPlaceDef(ctx: GameContext): GadgetDef | null {
  if (!ctx.isGameplayActive()) return null;
  if (isDetonatorHand(ctx)) return null;
  const p = ctx.player;
  if (!p || p.isDead || p.isDowned || p.droneControl) return null;
  const itemId = ctx.weapons?.remoteState?.heldItemId;
  if (!itemId) return null;
  const gid = ctx.loot?.getItemDef(itemId)?.gadgetId as GadgetId | undefined;
  if (!gid) return null;
  const def = gadgetDef(gid);
  return def && def.use === 'place' && def.deployable ? def : null;
}

function emitIfChanged(sys: GadgetSystem): void {
  const sent = sys.previewSent;
  const pv = sys.previewActive ? sys.preview : null;
  const gadget = pv ? pv.gadget : null;
  const valid = pv ? pv.valid : false;
  const reason = pv ? pv.reason : null;
  const mount = pv ? pv.mount : null;
  if (sent.gadget === gadget && sent.valid === valid && sent.reason === reason && sent.mount === mount) return;
  sent.gadget = gadget; sent.valid = valid; sent.reason = reason; sent.mount = mount;
  sys.ctx.bus.emit('gadget:placementChanged', { gadget, valid, reason, mount });
}

/** 매 프레임: 손에 든 설치형 가젯이 있으면 판정 → 고스트 → (바뀌었을 때만) 이벤트. */
export function updatePreview(sys: GadgetSystem, ctx: GameContext): void {
  const def = heldPlaceDef(ctx);
  if (!def || !def.deployable) { resetPreview(sys); return; }
  const pv = computePlacement(sys, def, sys.preview);
  sys.previewActive = true;
  const fp = footprintOf(pv.kind);
  sys.visuals.showGhost(pv.kind, pv.position, pv.yaw, pv.valid, ctx.time, pv.mount ? 0 : fp.ringX, fp.ringZ);
  emitIfChanged(sys);
}

/** 고스트를 숨기고 `placement` 를 null 로 (미션 리셋 · 허브 · 손에서 내려놓음). */
export function resetPreview(sys: GadgetSystem): void {
  sys.previewActive = false;
  sys.visuals.hideGhost();
  emitIfChanged(sys);
}

/**
 * 호스트: 클라이언트의 `gadq place` 를 가볍게 다시 본다. `pos` 를 제자리에서 고친다.
 * 반환 = 탑재할 드론 id, null = 바닥, false = 거부 (맵 밖).
 */
export function resolveRemotePlace(sys: GadgetSystem, def: GadgetDef, pos: THREE.Vector3, mount: string | null): string | null | false {
  const world = sys.ctx.world;
  if (world && world.ready && !world.isInsideBounds(pos.x, pos.z)) return false;
  if (mount && isMountableDeployable(def.deployable)) {
    const drone = sys.ctx.drones?.getDrone(mount) ?? null;
    if (drone && !droneOccupied(sys, mount)) {
      drone.getMountPoint(_mp);
      if (_mp.distanceTo(pos) <= MOUNT_TOLERANCE) { pos.copy(_mp); return mount; }
    }
  }
  // 바닥 (또는 드론이 사라졌을 때 그 아래): 요청 높이 근처에서 올라설 수 있는 표면
  if (world && world.ready) pos.y = world.getSurfaceY(pos.x, pos.z, pos.y + 0.2);
  return null;
}
