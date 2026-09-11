import * as THREE from 'three';
import {
  RIDE_INERTIA_DAMP, RIDE_INERTIA_S, recordRideLocal, restoreRideLocal, rideContains, type Obstacle, type WorldRef,
} from '@/shared';
import type { Enemy } from '../Enemy';

/* ────────────────────────────────────────────────────────────────────────────
 * 적 · 적 시체의 차량 탑승 (2026-09-11, C-18).
 *
 * 플레이어(`player/PlayerController.updateRide`)와 **같은 규약**이고 수학도 같은 `shared/ride.ts` 다 — CLAUDE.md
 * "탑승은 발판 프레임이 아니라 차량 부피로 판정한다":
 *   ① 진입만 발판 질의 — 서 있는 자리의 `getStandingObstacle` 이 `velocity` 를 가진 발판(전차 바닥)이면 잡는다.
 *   ② 유지는 차량 OBB + 헤드룸 (`rideContains`) — 경사 · 승강구 · 가장자리에서 발판 질의가 한 프레임 빠져도 내리지 않는다.
 *   ③ 이동은 지난 프레임의 자리를 차량 로컬 좌표로 적어 두었다가(`rideRecord`) 이번 프레임에 차량의 **지금** 변환으로
 *      다시 풀어 **차이만** 더한다(`rideCarry`). 스냅샷을 찍지 않고, 그 사이 남이 옮긴 몸(넉백 · 분리)은 지우지 않는다.
 *   ④ (2026-09-11 C-63) 하차하면 그 순간의 차량 속도를 **관성**으로 넘겨받아 `RIDE_INERTIA_S` 동안 `RIDE_INERTIA_DAMP`
 *      로 감쇠시킨다 — 플레이어 `releaseRide(true)` · `applyRideInertia` 와 같은 상수 · 같은 식이다. 위치에만 더하고
 *      `velocity` 에는 넣지 않는다 (조향 · 보행 · 발소리가 흔들린다). 권위 적만 시뮬레이션하고 리플리카는 스냅샷을 따른다.
 * `Enemy.velocity` 는 끝까지 **로컬 속도**다 — 조향 · 보행 애니메이션 · 발소리가 전차 속도로 흔들리지 않는다.
 *
 * 전차 치임(world/ 담당, `rails/parts/Tram.updateTramHit`)은 이 상태를 묻지 않는다: 데크 높이(바닥 −
 * `TRAM_HIT_FLOOR_CLEAR` 위)의 몸은 치지 않고, 그 밑 `RIDE_FOOT_DROP` 띠에서는 **발밑 발판이 그 전차일 때만** 뺀다
 * (C-63 — 선로 발판 위의 적이 탑승 창 안으로 읽혀 면제되던 틈). 여기서 태운 몸은 데크 높이라 저절로 빠진다.
 * ──────────────────────────────────────────────────────────────────────────── */

const _ride = new THREE.Vector3();
const _move = new THREE.Vector3();

/**
 * 권위 `integrate` 의 적분 **앞**: 유지 검사 → (없으면) 진입 → 차량이 이번 프레임에 옮겨 간 만큼 몸을 옮긴다.
 * 진입한 프레임에는 옮기지 않는다 (차량은 이미 제자리다). 타고 있지 않으면 하차 관성을 흘린다. 탑승 중이면 true.
 */
export function rideCarry(e: Enemy, world: WorldRef, dt: number): boolean {
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) rideRelease(e, true);
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (o && o.velocity) {
      e.carrier = o;
      e.rideInertia.set(0, 0, 0);
      e.rideInertiaT = 0;
      rideRecord(e);
      return true;
    }
    applyRideInertia(e, dt);
    return false;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  return true;
}

/** 이번 프레임의 최종 자리를 차량 좌표로 다시 적어 둔다 (적분 · 충돌 · 표면 스냅이 끝난 뒤). */
export function rideRecord(e: Enemy): void {
  const c = e.carrier;
  if (!c) return;
  recordRideLocal(c, e.position, e.rideLocal);
  e.rideWorld.copy(e.position);
}

/**
 * 하차. `keepInertia` 면 그 순간의 차량 속도(XZ)를 관성으로 넘겨받는다 — 차량 부피를 걸어서 벗어난 몸만
 * (`rideCarry`). 도약 · 사망 · 리셋처럼 스스로 궤적을 갖는 경로는 관성 없이 내린다.
 */
export function rideRelease(e: Enemy, keepInertia = false): void {
  const c = e.carrier;
  e.carrier = null;
  if (keepInertia && c && c.velocity) {
    e.rideInertia.set(c.velocity.x, 0, c.velocity.z);
    e.rideInertiaT = RIDE_INERTIA_S;
  } else {
    e.rideInertia.set(0, 0, 0);
    e.rideInertiaT = 0;
  }
}

/** 하차 관성: 위치에 더하고 지수 감쇠시킨다 (`PlayerController.applyRideInertia` 와 같은 식). */
function applyRideInertia(e: Enemy, dt: number): void {
  if (e.rideInertiaT <= 0) return;
  e.rideInertiaT -= dt;
  const pos = e.position;
  pos.x += e.rideInertia.x * dt;
  pos.z += e.rideInertia.z * dt;
  const k = Math.exp(-RIDE_INERTIA_DAMP * dt);
  e.rideInertia.x *= k;
  e.rideInertia.z *= k;
  if (e.rideInertiaT <= 0) { e.rideInertia.set(0, 0, 0); e.rideInertiaT = 0; }
}

/**
 * 시체 실어 나르기 (권위 · 리플리카 공통, `EnemySystem.update` 가 죽은 몸마다 매 프레임). 땅에 닿은(`deathLanded`)
 * 몸만 탄다. 차량 부피 밖으로 벗어나면 내리고 `deathLanded` 를 풀어 `integrateDeathFall` 이 땅까지 떨어뜨린다
 * (달리던 전차가 끝에서 돌아서며 모서리의 시체를 흘린 경우 — 허공에 떠 있지 않게). 몸이 움직였으면 true.
 */
export function carryCorpse(e: Enemy, world: WorldRef): boolean {
  if (!e.deathLanded) { if (e.carrier) rideRelease(e); return false; }
  const pos = e.position;
  if (e.carrier && !rideContains(e.carrier, pos)) {
    rideRelease(e);
    e.deathLanded = false; e.deathVy = 0;
    e.corpseDropped = true;   // the caller keeps the searchable spot on the body until it lands
    return false;
  }
  if (!e.carrier) {
    const o = world.getStandingObstacle(pos.x, pos.z, pos.y);
    if (!o || !o.velocity) return false;
    e.carrier = o;
    rideRecord(e);
    return false;
  }
  restoreRideLocal(e.carrier, e.rideLocal, _ride);
  const moved = Math.abs(_ride.x - e.rideWorld.x) + Math.abs(_ride.y - e.rideWorld.y) + Math.abs(_ride.z - e.rideWorld.z) > 1e-5;
  pos.x += _ride.x - e.rideWorld.x;
  pos.y += _ride.y - e.rideWorld.y;
  pos.z += _ride.z - e.rideWorld.z;
  rideRecord(e);
  return moved;
}

/* ── 리플리카 예측용 차량 이동 이력 (2026-09-11, C-63) ─────────────────────────────────────────────────────
 * C-18 의 예측은 `차량 속도 × lag` — **지금** 속도로 지난 lag 초를 되짚는 선형 식이라 가속 · 제동 순간 어긋났다.
 * 지난 lag 초 동안의 실제 이동은 `v·lag − ½·ā·lag²` 이고(ā = 그 구간의 평균 가속도), 전차는 cubic 가속 뒤 정차 창에서
 * **즉시** 멈추므로(`Rails.checkDock`) 상수 가속도 한 개로는 정차 순간을 못 맞춘다. 그래서 가속도를 따로 추정하지
 * 않고 그 항 전체를 이력에서 읽는다: 차량(발판 `Obstacle`)마다 **지금 자리**를 프레임마다 링 버퍼에 적어 두고,
 * `P(now) − P(now − lag)` 를 보간으로 꺼낸다. 가속 · 즉시 정차 · 곡선 · 클라이언트의 `s` 끌어당김이 전부 들어간다.
 *
 * - 이력은 이 모듈 안의 캐시다 (`Replica.ts` 는 건드리지 않는다 — `replicaRidePredict` 시그니처 그대로).
 *   키는 살아 있는 해시 엔트리(발판 `Obstacle`)이고 `WeakMap` 이라 미션이 바뀌어 엔트리가 버려지면 같이 사라진다.
 * - 한 프레임에 적 여럿이 불러도 같은 `now` 면 한 번만 적는다. `TRACK_GAP_S` 넘게 끊겼으면 비우고 새로 쌓는다.
 * - 이력이 lag 를 다 덮지 못한 앞부분(탑승 직후 · 끊긴 뒤)은 **지금 속도**로 채운다 — 즉 예전 선형 예측으로 돌아간다.
 * - 버퍼는 차량당 한 번만 만든다 (핫 패스 할당 없음).
 */
const TRACK_N = 96;
/** 이력이 이만큼(초) 끊기면 버리고 새로 쌓는다 (차량 곁에 리플리카가 한동안 없었다). */
const TRACK_GAP_S = 0.5;

interface CarrierTrack {
  /** [t, x, z] × TRACK_N, 링 버퍼. `head` = 가장 새 샘플. */
  readonly buf: Float64Array;
  head: number;
  count: number;
}
const _tracks = new WeakMap<Obstacle, CarrierTrack>();

function trackOf(c: Obstacle, now: number): CarrierTrack {
  let tr = _tracks.get(c);
  if (!tr) { tr = { buf: new Float64Array(TRACK_N * 3), head: -1, count: 0 }; _tracks.set(c, tr); }
  const b = tr.buf;
  if (tr.count > 0) {
    const lastT = b[tr.head * 3];
    if (now <= lastT + 1e-6) {
      // 같은 프레임의 두 번째 호출 — 자리만 최신으로 (전차는 이미 이번 프레임 자리다)
      b[tr.head * 3 + 1] = c.position.x; b[tr.head * 3 + 2] = c.position.z;
      return tr;
    }
    if (now - lastT > TRACK_GAP_S) tr.count = 0;
  }
  tr.head = (tr.head + 1) % TRACK_N;
  b[tr.head * 3] = now; b[tr.head * 3 + 1] = c.position.x; b[tr.head * 3 + 2] = c.position.z;
  tr.count = Math.min(TRACK_N, tr.count + 1);
  return tr;
}

/** 차량이 `[now − span, now]` 동안 옮겨 간 수평 변위를 `out` 에 (y = 0). 이력이 모자란 앞부분은 지금 속도로 채운다. */
function carrierDisplacement(c: Obstacle, tr: CarrierTrack, now: number, span: number, out: THREE.Vector3): THREE.Vector3 {
  const b = tr.buf;
  const x0 = c.position.x, z0 = c.position.z;
  const target = now - Math.max(0, span);
  let i = tr.head, n = tr.count;
  let tA = b[i * 3], xA = b[i * 3 + 1], zA = b[i * 3 + 2];
  if (n <= 0 || target >= tA) {
    // 이력이 없거나 창이 가장 새 샘플보다 뒤다 — 지금 속도로
    const v = c.velocity;
    return out.set(v ? v.x * span : 0, 0, v ? v.z * span : 0);
  }
  while (--n > 0) {
    const j = (i - 1 + TRACK_N) % TRACK_N;
    const tB = b[j * 3], xB = b[j * 3 + 1], zB = b[j * 3 + 2];
    if (tB <= target) {
      const f = tA - tB > 1e-9 ? (target - tB) / (tA - tB) : 0;
      return out.set(x0 - (xB + (xA - xB) * f), 0, z0 - (zB + (zA - zB) * f));
    }
    i = j; tA = tB; xA = xB; zA = zB;
  }
  // 가장 오래된 샘플(tA)보다 앞 — 그 앞은 지금 속도로 (선형 예측과 같은 가정)
  const v = c.velocity;
  const rest = tA - target;
  return out.set(x0 - xA + (v ? v.x * rest : 0), 0, z0 - zA + (v ? v.z * rest : 0));
}

/**
 * 리플리카의 탑승 **예측** (C-18 · C-63). 리플리카는 호스트 스냅샷을 `NET_INTERP_DELAY` 뒤에서 보간해 그리는데 전차는
 * 각 클라이언트가 동기화된 `s` 로 **지금** 자리를 굴린다 — 그래서 전차 위 적이 지연 × 전차 속도(최고 11.2 m/s)만큼
 * 뒤처져 데크 뒤로 미끄러져 보였다. `latest`(가장 새 샘플)를 그 뒤 흐른 시간 동안 차량이 옮겨 간 만큼 앞당긴 자리가
 * 차량 부피 안이면 탄 것으로 보고, 보간 자리 `out` 에 **지난 `lag` 초 동안 차량이 실제로 옮겨 간 변위**
 * (`v·lag − ½·ā·lag²`, 이력에서 읽는다 — 위 절)를 더한다. 오르내리며 튀지 않게 `rideBlend` 로 0.15 초 남짓에 걸쳐
 * 섞는다. 반환 = 이번 프레임에 차량이 몸을 옮긴 수평 속도 성분을 빼기 위한 차량 속도(없으면 null).
 */
export function replicaRidePredict(
  e: Enemy, world: WorldRef, latest: { t: number; x: number; y: number; z: number },
  now: number, lag: number, dt: number, out: THREE.Vector3,
): THREE.Vector3 | null {
  let c = e.carrier;
  const since = Math.max(0, now - latest.t);
  if (c && c.velocity) {
    carrierDisplacement(c, trackOf(c, now), now, since, _move);
    _ride.set(latest.x + _move.x, latest.y, latest.z + _move.z);
    if (!rideContains(c, _ride)) c = null;
  }
  if (!c) {
    const o = world.getStandingObstacle(latest.x, latest.z, latest.y);
    c = o && o.velocity ? o : null;
  }
  e.carrier = c;
  const target = c ? 1 : 0;
  e.rideBlend += (target - e.rideBlend) * Math.min(1, dt * 8);
  if (e.rideBlend < 1e-3 && !c) { e.rideBlend = 0; return null; }
  const carrier = c ?? e.lastCarrier;
  if (c) e.lastCarrier = c;
  if (!carrier || !carrier.velocity) return null;
  carrierDisplacement(carrier, trackOf(carrier, now), now, lag, _move);
  out.x += _move.x * e.rideBlend;
  out.z += _move.z * e.rideBlend;
  return c ? carrier.velocity : null;
}
