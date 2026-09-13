import * as THREE from 'three';
import type { FurniturePose, FurniturePoseKind, GameContext, PlacedFurniture } from '@/shared';
import { GYM_CYCLE_BEAT_S } from '@/shared';
import { yawFromForward } from './GeoBatch';
import { roomBox } from './RoomLayout';
import type { FurnitureModel } from './Furniture';
import type { FurnitureRig } from './FurnitureLeisure';

/* ────────────────────────────────────────────────────────────────────────────
 * 가구 자세 연출 (A-3e 흔들의자 · A-3a 헬스장, 2026-09-12).
 *
 * `FurnitureRig`(가구 로컬 좌표)를 월드로 풀어 `PlayerRef.setFurniturePose` 에 넘기고, 운동 세션 동안 기구의 움직이는 부분과
 * 몸의 동작 위상(`setFurniturePoseDrive`)을 **같은 값**으로 돌린다 — 바벨 높이 · 벨트 · 크랭크가 팔 · 걸음 · 무릎과 어긋나지 않게.
 *
 *   housing:gymSession {active:true}  → 원반 표시 · 자세 anchor/yaw · 옆 고정 카메라 → setFurniturePose (false 면 cancelGymSession)
 *   housing:gymBeat                   → 벤치: 완벽/좋음 = 반복 한 번(내렸다 올림), 실패 = 반쯤 밀다 버티다 올림
 *                                        트레드밀: 실패면 잠깐 속도가 떨어진다 · 사이클: 박자마다 크랭크 반 바퀴
 *   housing:gymSession {active:false} → 원반 숨김 · 바를 거치대로 · setFurniturePose(null)
 *   player:furniturePoseEnded (reset) → 세션도 취소 (자세 없이 미니게임만 남지 않게)
 *
 * 조각을 찾을 때는 늘 `find(uid)` 로 다시 찾는다 — 방이 다시 지어지면(`housing:changed` 등) 모델 그룹이 바뀌기 때문이다.
 * 원반의 보임은 `BuildExtra.gymActive` 가 새 모델에도 그대로 옮긴다.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface StagedPiece { item: PlacedFurniture; model: FurnitureModel }

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

/**
 * 트레드밀 걸음 수 (걸음 / 초 — player 의 `run` 위상 0 → 1 이 **한 걸음**, 한 바퀴마다 다음 발) · 벨트가 흐르는 속도 (m/s).
 * 2.8 걸음/초 × 걸음 0.86 m ≈ 2.4 m/s 라 발이 벨트 위에서 미끄러져 보이지 않는다. 연출 값.
 */
const RUN_STRIDE_HZ = 2.8;
const RUN_BELT_SPEED = 2.4;
/**
 * 한 걸음에 벨트가 흐르는 거리 (m) — `RUN_BELT_SPEED / RUN_STRIDE_HZ`. 원격 연출(`RemoteFurnitureStaging`)은 시간이 아니라
 * 누적 걸음 수의 차이로 벨트를 밀므로, 로컬과 같은 비율을 쓰려면 이 값이 필요하다.
 */
export const RUN_STRIDE_LENGTH = RUN_BELT_SPEED / RUN_STRIDE_HZ;
/** 벤치 · 스미스: 거치대 → 가슴 위로 바를 옮기는 시간 (초). */
export const UNRACK_S = 0.6;
/** 흔들의자: 앉아 있는 동안의 흔들림 (rad · rad/s). */
const ROCK_AMPLITUDE = 0.04;
const ROCK_RATE = 1.6;
/** 옆 카메라가 방 벽에서 떨어져야 하는 거리 (m). 2026-09-13: 조리대 카메라(`CookStaging`)도 같은 값을 쓴다. */
export const CAMERA_WALL_MARGIN = 0.45;

/** 조각의 자세 기준점을 월드로: anchor 와 플레이어 yaw 규약(앞 = (−sin, −cos))의 yaw. */
export function worldPoseOf(piece: StagedPiece, rig: FurnitureRig): { anchor: THREE.Vector3; yaw: number } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const anchor = g.localToWorld(rig.anchor.clone());
  _f.set(rig.forward.x, 0, rig.forward.z).transformDirection(g.matrixWorld);
  return { anchor, yaw: yawFromForward(_f.x, _f.z) };
}

/** 흔들의자 앉기 자세 (카메라 없음 · E 로 일어난다). 흔들의자가 아니면 null. */
export function sitPoseOf(piece: StagedPiece): FurniturePose | null {
  const rig = piece.model.rig;
  if (!rig || rig.pose !== 'sit') return null;
  const { anchor, yaw } = worldPoseOf(piece, rig);
  // furnitureUid (2026-09-12, 캐릭터 버프 · 가구 자세 동기화): 방문자 쪽 hub 가 이 uid 로 같은 의자를 흔든다
  return { kind: 'sit', anchor, yaw, camera: null, releaseOnInteract: true, furnitureUid: piece.item.uid };
}

/** 같은 방의 다른 가구 한 점이 차지하는 월드 상자 (콜라이더 blocker 와 같은 치수). 카메라 가림 판정에 쓴다. */
export interface FootBox { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

/** 선분 p → q 가 상자를 지나는가 (슬랩 판정). 세션 시작에 한 번 도는 코드라 할당은 신경 쓰지 않는다. 2026-09-13: 조리대 카메라도 쓴다. */
export function segmentHits(p: THREE.Vector3, q: THREE.Vector3, b: FootBox): boolean {
  let t0 = 0, t1 = 1;
  const axes: ReadonlyArray<readonly [number, number, number, number]> = [
    [p.x, q.x - p.x, b.minX, b.maxX], [p.y, q.y - p.y, b.minY, b.maxY], [p.z, q.z - p.z, b.minZ, b.maxZ],
  ];
  for (const [o, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-9) { if (o < lo || o > hi) return false; continue; }
    let ta = (lo - o) / dd, tb = (hi - o) / dd;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * 운동 기구의 고정 카메라. 기구 둘레 12 방위 × 거리 둘(D · 0.8 D) × 높이 둘(기본 · +0.8 m)의 후보를 점수로 고른다 —
 * **옆에서 볼수록**, 낮을수록, 멀수록 좋고, 방 상자(벽에서 `CAMERA_WALL_MARGIN` 안)를 벗어나거나 몸 · 초점까지의 시선이 같은 방
 * 다른 가구의 상자(`blockers`)를 지나면 크게 깎인다. 자동 배치는 헬스장 기구를 벽을 따라 1.5 – 2 m 간격으로 붙여 놓으므로
 * "옆" 이 곧 이웃 기구 안인 경우가 흔하다 (처음 판은 옆 · 대각선 중 방 안에 드는 첫 후보를 썼고, 카메라가 이웃 스미스 머신 틀 안에서 찍혔다).
 */
export function gymCameraOf(piece: StagedPiece, rig: FurnitureRig, blockers: readonly FootBox[] = []): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const g = piece.model.group;
  g.updateWorldMatrix(true, false);
  const focusLocal = rig.focus ?? rig.anchor;
  const lookAt = g.localToWorld(focusLocal.clone());
  const body = g.localToWorld(rig.anchor.clone());
  body.y += 0.35;
  const D = rig.camDist ?? 2.8, up = rig.camUp ?? 0.5;
  const box = roomBox(piece.item.room);
  const p = new THREE.Vector3();
  let best: THREE.Vector3 | null = null, bestCost = Infinity;
  for (const lift of [0, 0.8]) {
    for (const dist of [D, D * 0.8]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;                                   // 0 = 로컬 −X 옆, π = +X 옆, ±π/2 = 앞 · 뒤
        p.set(focusLocal.x - Math.cos(a) * dist, focusLocal.y + up + lift, focusLocal.z + Math.sin(a) * dist);
        g.localToWorld(p);
        let cost = (1 - Math.abs(Math.cos(a))) * 0.8 + lift * 0.4 + (dist < D ? 0.15 : 0);
        if (box) {
          const minX = box.minX + CAMERA_WALL_MARGIN, maxX = box.maxX - CAMERA_WALL_MARGIN;
          const minZ = box.minZ + CAMERA_WALL_MARGIN, maxZ = box.maxZ - CAMERA_WALL_MARGIN;
          const over = Math.max(0, minX - p.x, p.x - maxX) + Math.max(0, minZ - p.z, p.z - maxZ);
          if (over > 0) {
            cost += 4 + over * 4;
            p.x = THREE.MathUtils.clamp(p.x, minX, maxX);
            p.z = THREE.MathUtils.clamp(p.z, minZ, maxZ);
          }
        }
        for (const b of blockers) {
          if (segmentHits(p, lookAt, b)) cost += 3;
          if (segmentHits(p, body, b)) cost += 3;
        }
        if (cost < bestCost) { bestCost = cost; best = (best ?? new THREE.Vector3()).copy(p); }
      }
    }
  }
  return { position: best ?? lookAt.clone().add(_v.set(0, up, D)), lookAt };
}

/** 운동 자세 한 벌 (anchor · yaw · 고정 카메라). `blockers` = 같은 방 다른 가구의 상자 (카메라 가림 판정). */
export function gymPoseOf(piece: StagedPiece, blockers: readonly FootBox[] = []): FurniturePose | null {
  const rig = piece.model.rig;
  if (!rig || rig.pose === 'sit') return null;
  const { anchor, yaw } = worldPoseOf(piece, rig);
  return { kind: rig.pose, anchor, yaw, camera: gymCameraOf(piece, rig, blockers), releaseOnInteract: false, furnitureUid: piece.item.uid };
}

/* ── 기구 자세 한 벌 — 로컬 `GymStaging` 과 원격 `RemoteFurnitureStaging` 이 같은 식을 쓴다 (2026-09-12) ────────── */

/**
 * 벤치 · 스미스의 바. `unrack` = 거치대 → 누르기 경로 진행(0 … 1, 여기서 smoothstep), `phase` = 누르기 위상(0 = 가슴 · 1 = 팔 다 편
 * 자리, player 의 주먹 경로와 같은 **선형** 보간). 바 · 경로가 없는 rig 는 건드리지 않는다.
 */
export function poseBenchBar(rig: FurnitureRig, unrack: number, phase: number): void {
  if (!rig.bar || !rig.barRest || !rig.barPress) return;
  const u = smooth(unrack);
  const lo = rig.barPress.low, hi = rig.barPress.high;
  const pressY = lo.y + (hi.y - lo.y) * phase, pressZ = lo.z + (hi.z - lo.z) * phase;
  rig.bar.position.set(0, rig.barRest.y + (pressY - rig.barRest.y) * u, rig.barRest.z + (pressZ - rig.barRest.z) * u);
}

/** 트레드밀 벨트 줄무늬를 `offset` (m, 줄무늬 간격으로 감는다)만큼 민다. 음수도 감는다. */
export function poseBelt(rig: FurnitureRig, offset: number): number {
  const s = rig.beltSpacing;
  if (!rig.belt || !s) return offset;
  const wrapped = ((offset % s) + s) % s;
  rig.belt.position.z = wrapped;
  return wrapped;
}

/**
 * 사이클 크랭크 · 페달 · 플라이휠을 `revolutions` 바퀴 자리에. 크랭크는 한 바퀴, 플라이휠(×2.4)은 다섯 바퀴마다 같은 자리라 그 주기로
 * 감아서 넣는다 — 누적 바퀴 수가 커져도 회전값의 정밀도가 무너지지 않는다 (보이는 자리는 감지 않은 값과 같다).
 */
export function poseCrank(rig: FurnitureRig, revolutions: number): void {
  const ang = -Math.PI * 2 * frac(revolutions);
  if (rig.crank) rig.crank.rotation.x = ang;
  if (rig.pedals) for (const pd of rig.pedals) pd.rotation.x = -ang;
  if (rig.flywheel) rig.flywheel.rotation.x = -Math.PI * 2 * (((revolutions % 5) + 5) % 5) * 2.4;
}

/** 흔들의자의 흔들림 (`time` = `ctx.time`). */
export function poseRock(rig: FurnitureRig, time: number): void {
  if (rig.rock) rig.rock.rotation.x = Math.sin(time * ROCK_RATE) * ROCK_AMPLITUDE;
}

/** 쉬는 모습으로: 원반 숨김 · 바는 거치대 · 흔들의자 멈춤 (벨트 · 크랭크는 그 자리에 둔다 — 로컬 세션 끝과 같다). */
export function restRig(rig: FurnitureRig): void {
  if (rig.plates) rig.plates.visible = false;
  if (rig.bar && rig.barRest) rig.bar.position.set(0, rig.barRest.y, rig.barRest.z);
  if (rig.rock) rig.rock.rotation.x = 0;
}

/** 키프레임 (시각, 값) 사이를 smoothstep 으로 잇는다. */
function sampleKeys(keys: ReadonlyArray<readonly [number, number]>, t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) {
      const u = (t - t0) / Math.max(1e-6, t1 - t0);
      return v0 + (v1 - v0) * u * u * (3 - 2 * u);
    }
  }
  return keys[keys.length - 1][1];
}
const smooth = (u: number): number => { const c = THREE.MathUtils.clamp(u, 0, 1); return c * c * (3 - 2 * c); };
const frac = (x: number): number => x - Math.floor(x);

/** 운동 세션 연출. `FurnitureLayer` 가 자기 함선(방문 중이 아닌)일 때만 만든다. */
export class GymStaging {
  /** 연출 중인 운동 기구 uid, 없으면 null. */
  uid: string | null = null;
  private kind: FurniturePoseKind | null = null;
  private releasing = false;
  private unsubs: Array<() => void> = [];
  // 벤치
  private unrack = 0;
  private barPhase = 1;
  private rep: { t: number; keys: Array<[number, number]>; miss: boolean } | null = null;
  // 트레드밀
  private running = false;
  private pace = 0;
  private dipLeft = 0;
  private stride = 0;
  private beltOffset = 0;
  // 사이클
  private crank = 0;
  private beatIndex = -1;
  private sinceBeat = 0;
  private lastHit = true;

  /**
   * `find` = uid 로 지금의 조각(방이 다시 지어지면 바뀐다), `blockers` = 그 조각과 같은 방의 다른 가구 상자 (카메라 가림).
   */
  constructor(private readonly ctx: GameContext, private readonly find: (uid: string) => StagedPiece | null, private readonly blockers: (uid: string) => readonly FootBox[] = () => []) {
    const b = ctx.bus;
    this.unsubs.push(
      b.on('housing:gymSession', (e) => this.onSession(e.uid, e.active)),
      b.on('housing:gymBeat', (e) => this.onBeat(e.uid, e.quality, e.index)),
      b.on('player:furniturePoseEnded', (e) => {
        // 우리 세션 도중에 자세가 우리 손을 거치지 않고 풀렸다 (페이즈 변경 · 스폰 · hub:left) → 미니게임도 거둔다
        if (!this.uid || this.releasing || e.kind === 'sit') return;
        this.stop(false);
        this.cancelHousing();
      }),
    );
  }

  /** 동작 위상 (0 … 1) — 세션 중이 아니면 null. 디버그 · 스모크용. */
  get drivePhase(): number | null {
    if (!this.uid) return null;
    return this.kind === 'bench' ? this.barPhase : this.kind === 'run' ? this.stride : frac(this.crank);
  }

  private onSession(uid: string, active: boolean): void {
    if (!active) { if (this.uid === uid) this.stop(true); return; }
    if (this.uid && this.uid !== uid) this.stop(true);
    const piece = this.find(uid);
    const rig = piece?.model.rig;
    if (!piece || !rig || rig.pose === 'sit') { this.cancelHousing(); return; }
    this.uid = uid;
    this.kind = rig.pose;
    this.unrack = 0; this.barPhase = 1; this.rep = null;
    this.running = false; this.pace = 0; this.dipLeft = 0; this.stride = 0;
    this.beatIndex = -1; this.sinceBeat = 0; this.lastHit = true;
    if (rig.plates) rig.plates.visible = true;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function') return;   // player 가 아직 자세를 모른다 — 미니게임은 그대로 둔다
    const pose = gymPoseOf(piece, this.blockers(uid));
    let ok = false;
    try { ok = pose !== null && p.setFurniturePose(pose); } catch (err) { console.warn('[hub] setFurniturePose failed', err); }
    if (!ok) { this.stop(false); this.cancelHousing(); }
  }

  private onBeat(uid: string, quality: 'perfect' | 'good' | 'miss', index: number): void {
    if (uid !== this.uid) return;
    const miss = quality === 'miss';
    if (this.kind === 'bench') {
      const cur = this.barPhase;
      this.rep = miss
        ? { t: 0, miss, keys: [[0, cur], [0.4, 0], [0.9, 0.42], [1.25, 0.3], [1.95, 1]] }
        : { t: 0, miss, keys: [[0, cur], [0.45, 0], [1.0, 1]] };
    } else if (this.kind === 'run') {
      this.running = true;
      this.dipLeft = miss ? 1.2 : 0;
    } else if (this.kind === 'cycle') {
      if (index > this.beatIndex) this.beatIndex = index;
      this.sinceBeat = 0;
      this.lastHit = !miss;
    }
  }

  /** 매 프레임 (`FurnitureLayer.update`). */
  update(dt: number): void {
    if (!this.uid) return;
    const piece = this.find(this.uid);
    const rig = piece?.model.rig;
    if (!piece || !rig) { this.stop(true); this.cancelHousing(); return; }   // 세션 도중 기구가 사라졌다
    let drive = 0;
    if (this.kind === 'bench' && rig.bar && rig.barRest && rig.barPress) {
      this.unrack = Math.min(1, this.unrack + dt / UNRACK_S);
      if (this.rep) {
        this.rep.t += dt;
        const keys = this.rep.keys;
        let v = sampleKeys(keys, this.rep.t);
        if (this.rep.miss && this.rep.t > 0.9 && this.rep.t < 1.25) v += Math.sin(this.rep.t * 60) * 0.02;   // 버티는 떨림
        this.barPhase = THREE.MathUtils.clamp(v, 0, 1);
        if (this.rep.t >= keys[keys.length - 1][0]) { this.rep = null; this.barPhase = 1; }
      }
      // player 의 주먹 경로와 같은 선형 보간 (위상 0 = 가슴 · 1 = 팔 다 편 자리) — 원격 연출과 같은 함수
      poseBenchBar(rig, this.unrack, this.barPhase);
      drive = this.barPhase;
    } else if (this.kind === 'run') {
      if (this.dipLeft > 0) this.dipLeft = Math.max(0, this.dipLeft - dt);
      const target = !this.running ? 0 : this.dipLeft > 0 ? 0.5 : 1;
      this.pace += (target - this.pace) * Math.min(1, dt * 2.5);
      this.stride = frac(this.stride + dt * RUN_STRIDE_HZ * this.pace);
      this.beltOffset = poseBelt(rig, this.beltOffset + dt * RUN_BELT_SPEED * this.pace);
      drive = this.stride;
    } else if (this.kind === 'cycle') {
      this.sinceBeat += dt;
      if (this.beatIndex >= 0) {
        // 박자 i 에서 크랭크는 i/2 바퀴에서 출발해 다음 박자까지 반 바퀴를 돈다 — 제때 밟으면 끊김 없이 이어진다
        const push = Math.min(this.sinceBeat / GYM_CYCLE_BEAT_S, 1) * 0.5 * (this.lastHit ? 1 : 0.35);
        const desired = Math.max(this.crank, this.beatIndex * 0.5 + push);
        this.crank += (desired - this.crank) * Math.min(1, dt * 12);
      }
      poseCrank(rig, this.crank);
      drive = frac(this.crank);
    }
    const p = this.ctx.player;
    if (p && typeof p.setFurniturePoseDrive === 'function' && p.furniturePose === this.kind) {
      try { p.setFurniturePoseDrive(drive); } catch { /* player mid-build */ }
    }
  }

  /** 연출을 거둔다: 원반을 숨기고 바를 거치대로. `release` = 플레이어 자세도 푼다. */
  private stop(release: boolean): void {
    const uid = this.uid;
    this.uid = null;
    this.kind = null;
    this.rep = null;
    const rig = uid ? this.find(uid)?.model.rig : undefined;
    if (rig) restRig(rig);
    if (!release) return;
    const p = this.ctx.player;
    if (!p || typeof p.setFurniturePose !== 'function' || p.furniturePose === 'sit') return;
    this.releasing = true;
    try { p.setFurniturePose(null); } catch { /* player mid-build */ } finally { this.releasing = false; }
  }

  private cancelHousing(): void {
    const h = this.ctx.housing;
    if (h && typeof h.cancelGymSession === 'function') {
      try { h.cancelGymSession(); } catch (err) { console.warn('[hub] cancelGymSession failed', err); }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.uid) { this.stop(true); this.cancelHousing(); }
  }
}
