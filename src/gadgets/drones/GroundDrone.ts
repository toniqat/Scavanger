/**
 * src/gadgets/drones/GroundDrone.ts — **지상 드론 몸체** (2026-09-11).
 *
 * 낮은 4륜 로버: 절차 모델(차체 · 바퀴 · 센서 헤드 렌즈 · 안테나 · emissive LED · 윗면 탑재판), 소유자 쪽 물리
 * (중력 · `getSurfaceY` 바닥 · 낮은 턱 오르기 · `resolveCollision` · 천장 · 점프), 1인칭 렌즈 카메라.
 *
 * - 걷기 = `PLAYER_WALK_SPEED × DRONE_GROUND_WALK_MUL` — 조용하다 (조종자에게만 아주 작은 모터음).
 * - 질주 = `PLAYER_SPRINT_SPEED × DRONE_GROUND_SPRINT_MUL` — 스태미나 없음. 질주음(위치 오디오)과 소음은 `DroneSystem` 이 낸다.
 * - 점프 속도 = `sqrt(2 · GRAVITY · DRONE_GROUND_JUMP_HEIGHT)`.
 * - 광원 없음. 할당 없음(생성자 · dispose 제외).
 * - yaw 규약은 `model.ts` (코 = 모델 +Z).
 */
import * as THREE from 'three';
import {
  DRONE_GROUND_JUMP_HEIGHT, DRONE_GROUND_SPRINT_MUL, DRONE_GROUND_WALK_MUL, DroneFlags, GRAVITY,
  PLAYER_SPRINT_SPEED, PLAYER_WALK_SPEED, type GameContext,
} from '@/shared';
import {
  DRONE_GROUND_ACCEL, DRONE_GROUND_AIR_ACCEL, DRONE_GROUND_BRAKE, DRONE_MOVE_SFX_S, UP,
  type DroneBody, type DroneInput,
} from './model';

/* ── 시각 · 기하 (게임플레이 수치 아님) ── */
const WHEEL_R = 0.11;
/** 지형에 붙어 내려가는 최대 낙차 (m/프레임) — `PlayerController.SNAP_DOWN` 과 같은 역할. */
const SNAP_DOWN = 0.35;
const DECK_TOP = 0.295;
const MOUNT_Z = -0.12;
const LENS_Y = 0.345;
/** 렌즈는 몸체 반경 안쪽이어야 벽에 붙었을 때 카메라가 벽을 뚫고 보지 않는다. */
const LENS_Z = 0.2;
const PITCH_MIN = -1.15;
const PITCH_MAX = 1.2;
/** 광선 판정 구 (몸체 중심 높이 · 반경). */
const HIT_Y = 0.22;
const HIT_R = 0.4;
/** 이만큼 아래로 빠지면 지형 위로 되돌린다 (지하실은 지형보다 몇 m 아래라 넉넉히). */
const FALL_RESCUE = 40;

const COLOR_IDLE = new THREE.Color(0x3dffb0);
const COLOR_LIVE = new THREE.Color(0xffb13d);
const COLOR_SPRINT = new THREE.Color(0xff4a3d);

const _o = new THREE.Vector3();

export class GroundDrone implements DroneBody {
  readonly kind = 'ground' as const;
  readonly root = new THREE.Group();
  readonly radius = 0.35;
  readonly height = 0.45;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  sprinting = false;
  airborne = false;

  private readonly chassis = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly ledMat: THREE.MeshStandardMaterial;
  private readonly lensMat: THREE.MeshStandardMaterial;
  private readonly tipMat: THREE.MeshStandardMaterial;
  /** 바퀴 굴린 거리 (앞 +). */
  private travel = 0;
  private lastX = 0;
  private lastZ = 0;
  private moveSfxT = 0;
  private looking = false;
  private remoteFlags = 0;
  /** 소유자 쪽: 이번 프레임 입력이 있었나 (LED 색). */
  private live = false;

  constructor() {
    this.root.name = 'GroundDrone';
    const shell = new THREE.MeshStandardMaterial({ color: 0x3b4148, roughness: 0.55, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.85, metalness: 0.3 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x6f7882, roughness: 0.45, metalness: 0.7 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x111213, roughness: 0.95, metalness: 0 });
    const hazard = new THREE.MeshStandardMaterial({ color: 0xd9a21b, roughness: 0.5, metalness: 0.35 });
    this.lensMat = new THREE.MeshStandardMaterial({ color: 0x071217, emissive: 0x39d7ff, emissiveIntensity: 1.3, roughness: 0.15, metalness: 0.2 });
    this.ledMat = new THREE.MeshStandardMaterial({ color: 0x0c1a14, emissive: COLOR_IDLE, emissiveIntensity: 1.4, roughness: 0.4 });
    this.tipMat = new THREE.MeshStandardMaterial({ color: 0x1a0c0c, emissive: COLOR_SPRINT, emissiveIntensity: 1.2, roughness: 0.4 });

    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = false): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // ── 차체
    this.root.add(this.chassis);
    add(this.chassis, new THREE.BoxGeometry(0.5, 0.14, 0.7), shell, 0, 0.2, 0, true);
    add(this.chassis, new THREE.BoxGeometry(0.56, 0.05, 0.6), dark, 0, 0.135, 0);
    add(this.chassis, new THREE.BoxGeometry(0.36, 0.025, 0.42), plate, 0, DECK_TOP - 0.0125, MOUNT_Z);   // 탑재판
    add(this.chassis, new THREE.BoxGeometry(0.52, 0.022, 0.05), hazard, 0, 0.275, 0.33);                  // 앞 범퍼 줄
    add(this.chassis, new THREE.BoxGeometry(0.52, 0.022, 0.04), hazard, 0, 0.275, -0.33);
    const ledGeo = new THREE.BoxGeometry(0.012, 0.022, 0.07);
    add(this.chassis, ledGeo, this.ledMat, 0.253, 0.22, 0.24);
    add(this.chassis, ledGeo, this.ledMat, -0.253, 0.22, 0.24);
    // 안테나 (뒤 왼쪽)
    add(this.chassis, new THREE.CylinderGeometry(0.006, 0.009, 0.3, 6), dark, -0.17, 0.43, -0.28);
    add(this.chassis, new THREE.SphereGeometry(0.02, 8, 6), this.tipMat, -0.17, 0.59, -0.28);

    // ── 바퀴 (축 = 로컬 X)
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.09, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.095, 8);
    hubGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[0.29, 0.23], [-0.29, 0.23], [0.29, -0.23], [-0.29, -0.23]] as const) {
      const w = add(this.root, wheelGeo, tire, x, WHEEL_R, z, true);
      add(w, hubGeo, plate, 0, 0, 0);
      this.wheels.push(w);
    }

    // ── 센서 헤드 (렌즈) — 조종자 시점에서는 숨긴다
    this.head.position.set(0, 0.295, LENS_Z);
    this.chassis.add(this.head);
    add(this.head, new THREE.BoxGeometry(0.2, 0.1, 0.13), shell, 0, 0.05, -0.01, true);
    add(this.head, new THREE.BoxGeometry(0.21, 0.02, 0.14), dark, 0, 0.105, -0.01);
    const lens = new THREE.CylinderGeometry(0.036, 0.044, 0.03, 16);
    lens.rotateX(Math.PI / 2);
    add(this.head, lens, this.lensMat, 0, 0.05, 0.065);
  }

  reset(position: THREE.Vector3, yaw: number, _ctx: GameContext): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.sprinting = false;
    this.airborne = false;
    this.lastX = position.x;
    this.lastZ = position.z;
    this.moveSfxT = 0;
    this.writeTransform();
  }

  simulate(dt: number, ctx: GameContext, input: DroneInput | null): void {
    const world = ctx.world;
    if (!world || !world.ready || dt <= 0) return;
    const pos = this.position, vel = this.velocity;
    if (input) this.yaw = input.yaw;
    this.live = !!input;

    // ── 원하는 수평 속도 (드론 시점 기준)
    let wx = 0, wz = 0, wantSprint = false;
    if (input) {
      let f = Math.max(-1, Math.min(1, input.forward));
      let r = Math.max(-1, Math.min(1, input.right));
      const len = Math.hypot(f, r);
      if (len > 1e-3) {
        if (len > 1) { f /= len; r /= len; }
        wantSprint = input.sprint;
        const speed = wantSprint ? PLAYER_SPRINT_SPEED * DRONE_GROUND_SPRINT_MUL : PLAYER_WALK_SPEED * DRONE_GROUND_WALK_MUL;
        const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
        // forward (s, c) · right (−c, s)
        wx = (s * f - c * r) * speed;
        wz = (c * f + s * r) * speed;
      }
    }
    const moving = wx !== 0 || wz !== 0;
    const rate = this.airborne ? DRONE_GROUND_AIR_ACCEL : moving ? DRONE_GROUND_ACCEL : DRONE_GROUND_BRAKE;
    const dx = wx - vel.x, dz = wz - vel.z;
    const dl = Math.hypot(dx, dz), step = rate * dt;
    if (dl <= step) { vel.x = wx; vel.z = wz; } else { vel.x += (dx / dl) * step; vel.z += (dz / dl) * step; }

    // ── 점프 / 중력
    if (input?.jump && !this.airborne) {
      vel.y = Math.sqrt(2 * GRAVITY * DRONE_GROUND_JUMP_HEIGHT);
      this.airborne = true;
      ctx.bus.emit('audio:play', { id: 'drone_jump', position: pos, volume: 0.45 });
    }
    if (this.airborne) vel.y -= GRAVITY * dt;
    else vel.y = Math.max(vel.y, 0);

    // ── 적분
    pos.x += vel.x * dt;
    pos.z += vel.z * dt;
    pos.y += vel.y * dt;

    // ── 천장 (올라가는 동안만): 슬래브에 머리를 박은 채로 `resolveCollision` 에 들어가면 옆으로 밀려난다
    if (vel.y > 0) {
      _o.set(pos.x, pos.y + 0.05, pos.z);
      const hit = world.raycast(_o, UP, this.height);
      if (hit) {
        const maxFeet = _o.y + hit.distance - this.height;
        if (pos.y > maxFeet) { pos.y = maxFeet; vel.y = 0; }
      }
    }

    // ── 표면을 먼저 잡고(낮은 턱은 올라선다) 밀어낸다 — `PlayerController` 와 같은 순서
    if (!this.airborne) {
      const up = world.getSurfaceY(pos.x, pos.z, pos.y);
      if (up > pos.y) pos.y = up;
    }
    world.resolveCollision(pos, this.radius);

    // ── 바닥
    const g = world.getSurfaceY(pos.x, pos.z, pos.y);
    const wasAir = this.airborne;
    if (pos.y <= g + 0.001) {
      if (wasAir && vel.y < -2) ctx.bus.emit('audio:play', { id: 'drone_land', position: pos, volume: Math.min(0.8, 0.25 - vel.y * 0.05) });
      pos.y = g; vel.y = 0; this.airborne = false;
    } else if (!wasAir && vel.y <= 0 && pos.y - g < SNAP_DOWN) {
      pos.y = g; vel.y = 0;
    } else {
      this.airborne = true;
    }
    const terrain = world.getHeightAt(pos.x, pos.z);
    if (pos.y < terrain - FALL_RESCUE) { pos.y = terrain; vel.set(0, 0, 0); this.airborne = false; }

    const hSpeed = Math.hypot(vel.x, vel.z);
    this.sprinting = wantSprint && hSpeed > 0.5;

    // ── 조종자에게만 들리는 아주 작은 모터음 (걷기는 "소리가 나지 않는다" — 위치 없이, 남에게는 안 간다)
    if (input && !this.sprinting && !this.airborne && hSpeed > 0.3) {
      this.moveSfxT -= dt;
      if (this.moveSfxT <= 0) {
        this.moveSfxT = DRONE_MOVE_SFX_S;
        ctx.bus.emit('audio:play', { id: 'drone_move', volume: 0.12 });
      }
    } else this.moveSfxT = 0;

    this.trackTravel();
    this.writeTransform();
  }

  applyRemote(position: THREE.Vector3, yaw: number, flags: number): void {
    this.position.copy(position);
    this.yaw = yaw;
    this.remoteFlags = flags;
    this.sprinting = (flags & DroneFlags.SPRINTING) !== 0;
    this.airborne = (flags & DroneFlags.AIRBORNE) !== 0;
    this.trackTravel();
    this.writeTransform();
  }

  animate(dt: number, time: number): void {
    const spin = this.travel / WHEEL_R;
    for (let i = 0; i < this.wheels.length; i++) this.wheels[i].rotation.x = spin;
    // 굴러갈 때 차체가 아주 조금 떨린다
    this.chassis.position.y = Math.sin(this.travel * 22) * 0.004;
    const controlled = this.looking || this.live || (this.remoteFlags & DroneFlags.CONTROLLED) !== 0;
    const lost = (this.remoteFlags & DroneFlags.LINK_LOST) !== 0;
    this.ledMat.emissive.copy(this.sprinting ? COLOR_SPRINT : controlled ? COLOR_LIVE : COLOR_IDLE);
    this.ledMat.emissiveIntensity = lost ? (Math.sin(time * 14) > 0 ? 1.6 : 0.1) : 1.1 + Math.sin(time * 3) * 0.3;
    this.tipMat.emissiveIntensity = (time * 1.25) % 1 < 0.12 ? 2.2 : 0.15;
    this.lensMat.emissiveIntensity = controlled ? 1.8 : 0.9;
    void dt;
  }

  getCameraPose(pitch: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
    const p = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    outPos.set(this.position.x + s * LENS_Z, this.position.y + LENS_Y + this.chassis.position.y, this.position.z + c * LENS_Z);
    const cp = Math.cos(p);
    outLook.set(outPos.x + s * cp, outPos.y + Math.sin(p), outPos.z + c * cp);
  }

  getMountPoint(out: THREE.Vector3): THREE.Vector3 {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return out.set(this.position.x + s * MOUNT_Z, this.position.y + DECK_TOP, this.position.z + c * MOUNT_Z);
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    const ox = origin.x - this.position.x;
    const oy = origin.y - (this.position.y + HIT_Y);
    const oz = origin.z - this.position.z;
    const b = ox * dir.x + oy * dir.y + oz * dir.z;
    const cc = ox * ox + oy * oy + oz * oz - HIT_R * HIT_R;
    if (cc > 0 && b > 0) return -1;
    const disc = b * b - cc;
    if (disc < 0) return -1;
    const t = Math.max(0, -b - Math.sqrt(disc));
    return t <= maxDist ? t : -1;
  }

  setOwnerView(looking: boolean): void {
    this.looking = looking;
    this.head.visible = !looking;
    if (!looking) this.live = false;
  }

  dispose(): void {
    this.root.removeFromParent();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      geos.add(m.geometry);
      if (Array.isArray(m.material)) m.material.forEach((x) => mats.add(x)); else mats.add(m.material);
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.wheels.length = 0;
  }

  /* ── internals ── */
  private trackTravel(): void {
    const dx = this.position.x - this.lastX, dz = this.position.z - this.lastZ;
    this.lastX = this.position.x;
    this.lastZ = this.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-5 || d > 3) return;   // 순간이동은 굴리지 않는다
    const along = dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw);
    this.travel += along >= 0 ? d : -d;
  }

  private writeTransform(): void {
    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
  }
}
