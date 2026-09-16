/**
 * src/allies/parts/Roam.ts — **자유 탐색** (2026-09-16 사용자 결정 「하네스 안에서는 분대장 뒤만 졸졸 따라오지 말고
 * 자유롭게 탐색한다」). 하네스 **밖**이면 `Fsm.follow` 가 뛰어서 돌아가고, **안**이면 이 상태다 —
 * 둘은 같은 서열(`PRIO.follow` ≡ `PRIO.roam`)이라 `Fsm.decide` 가 매 프레임 **둘 중 하나만** 제안한다.
 * 전투 · 명령 · 구조 · 루팅은 전부 이보다 위라 그대로 이긴다.
 *
 * 돌아다니는 방식은 **섞어 쓴다** (사용자 결정):
 *  ① **관심 지점** — 하네스 안의 구조물 · 폐허, 없으면 큰 엄폐물 하나를 골라 그 둘레 `ALLY_ROAM_POI_RADIUS_M` 안을 돈다.
 *  ② 그 지점 `ALLY_ROAM_POI_TAKEN_M` 안에 **다른 분대원 · 안드로이드가 이미 있으면 포기**하고 하네스 안 무작위 순찰로 바꾼다
 *     (셋이 같은 건물에 몰리면 「자유 탐색」으로 읽히지 않는다).
 * 관심 지점은 `POI_PICK_S` 마다만 다시 고른다 — 월드 질의는 싸지 않다 (`Loot.LOOT_SCAN_S` 와 같은 얼개, 주기는 `Fsm` 이 깎는다).
 *
 * 와이어는 없다: `roam` 은 기존 `ally` 스냅샷의 상태 하나일 뿐이고 판단은 전부 권위에서만 돈다.
 */
import * as THREE from 'three';
import {
  ALLY_FOLLOW_NEAR_M, ALLY_MOVE_ARRIVE_M, ALLY_ROAM_MIN_STEP_M, ALLY_ROAM_PAUSE_MAX_S, ALLY_ROAM_PAUSE_MIN_S,
  ALLY_ROAM_POI_RADIUS_M, ALLY_ROAM_POI_TAKEN_M, ALLY_WALK_SPEED, PLAYER_RADIUS,
} from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { dist2D, forwardOf, yawToward } from '../model';
import * as Nav from './Nav';

/** 관심 지점을 다시 고르는 주기 (s) — 배치값이다 (`Loot` 의 상자 훑기와 같은 이유). */
const POI_PICK_S = 6;
/** 관심 지점으로 칠 만한 장애물의 최소 크기 (m) — 균형 수치가 아니라 「무엇을 지형지물로 보는가」의 정의다. */
const POI_MIN_RADIUS_M = 1;
const POI_MIN_HEIGHT_M = 1.2;
/** 순찰 지점 후보를 이만큼 뽑아 보고 다 떨어지면 이번 프레임은 포기한다 (다음 프레임에 다시 뽑는다). */
const PICK_TRIES = 6;
/** `resolveCollision` 이 이보다 멀리 밀어내면 그 자리는 소품 속이다 — 걸어갈 자리가 못 된다 (m). */
const BLOCKED_SLACK_M = 0.35;
/** 둘러볼 때 시선 점을 몸에서 이만큼 앞에 둔다 (m — `yawToward` 는 XZ 만 보므로 거리 자체는 방향을 바꾸지 않는다). */
const LOOK_DIST_M = 10;
/** 한 번에 고개를 돌리는 각도 범위 (rad) 와, 다 돌았다고 보는 오차 (rad). */
const LOOK_TURN_MIN_RAD = 0.6;
const LOOK_TURN_MAX_RAD = 2.2;
const LOOK_DONE_RAD = 0.15;

/** Roam 전용 스크래치 — `model` 의 공용 스크래치는 부르는 쪽이 쓰고 있을 수 있다. */
const _r1 = new THREE.Vector3();
const _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3();
const _r4 = new THREE.Vector3();

export function onEnter(sys: AllySystem, a: Ally): void {
  a.hasRoamDest = false;
  a.roamPauseT = 0;
  a.roamPoiT = 0;                 // 들어오자마자 한 번 훑는다
  a.lookAt = null;
  void sys;
}

export function onExit(sys: AllySystem, a: Ally): void {
  a.hasRoamDest = false;
  a.roamPauseT = 0;
  a.lookAt = null;
  void sys;
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  a.running = false;              // 탐색은 **걷는다** (뛰는 것은 하네스로 돌아갈 때뿐이다)
  if (!sys.leaderKnown) { Nav.halt(a); return; }
  refreshPoi(sys, a);
  // 분대장이 움직이면 하네스가 통째로 미끄러진다 — 밖으로 빠진 목적지는 버리고 다시 고른다.
  if (a.hasRoamDest && dist2D(a.roamDest, sys.leaderPos) > sys.harness) a.hasRoamDest = false;

  if (a.roamPauseT > 0) {
    a.roamPauseT -= dt;
    Nav.halt(a);
    lookAround(a, dt);
    return;
  }
  if (!a.hasRoamDest && !pickDest(sys, a)) {
    // 갈 곳을 못 찾았다 (사방이 막혔다 · 하네스가 바짝 줄었다) — 매 프레임 월드를 다시 뒤지지 말고 한 박자 쉬고 다시 본다.
    a.roamPauseT = ALLY_ROAM_PAUSE_MIN_S;
    Nav.halt(a);
    lookAround(a, dt);
    return;
  }

  a.lookAt = null;
  const left = Nav.step(sys, a, a.roamDest, ALLY_WALK_SPEED, dt);
  if (left > ALLY_MOVE_ARRIVE_M) return;
  // 도착 — 기마다 다른 난수로 쉰다 (셋이 같은 박자로 서고 같은 박자로 떠나지 않게).
  a.hasRoamDest = false;
  a.roamPauseT = a.rand.range(ALLY_ROAM_PAUSE_MIN_S, ALLY_ROAM_PAUSE_MAX_S);
}

/* ── 관심 지점 ───────────────────────────────────────────────────────────── */

function refreshPoi(sys: AllySystem, a: Ally): void {
  if (a.roamPoiT > 0) return;                    // 주기는 `parts/Fsm` 이 깎는다
  a.roamPoiT = POI_PICK_S;
  const had = a.hasRoamPoi;
  _r4.copy(a.roamPoi);
  a.hasRoamPoi = pickPoi(sys, a);
  // 관심 지점이 실제로 바뀌었을 때만 가던 길을 버린다 (같은 지점이면 계속 그 둘레를 돈다).
  if (a.hasRoamPoi !== had || (a.hasRoamPoi && dist2D(_r4, a.roamPoi) > BLOCKED_SLACK_M)) a.hasRoamDest = false;
}

/** 하네스 안에서 아무도 선점하지 않은 지형지물 하나를 `a.roamPoi` 에 고른다. 없으면 false (= 무작위 순찰). */
function pickPoi(sys: AllySystem, a: Ally): boolean {
  const world = sys.ctx.world;
  if (!world) return false;
  let seen = 0;
  // ① 구조물 · 폐허 전초 — 안드로이드가 「가 볼 만한 곳」의 첫째다 (둘 다 world 가 이미 들고 있는 배열이라 공짜다).
  for (const s of world.getStructures()) seen = consider(sys, a, s.position, seen);
  const ruins = world.getRuinSites?.();
  if (ruins) for (const r of ruins) seen = consider(sys, a, r.position, seen);
  if (seen > 0) return true;
  // ② 구조물이 없으면 큰 엄폐물 — 바위 · 벽 뒤를 둘러본다. (`pickCoverSpot` 은 **위협**이 있어야 도는 식이라 여기서는 못 쓴다.)
  for (const o of world.getObstaclesNear(sys.leaderPos.x, sys.leaderPos.z, sys.harness)) {
    if (o.radius < POI_MIN_RADIUS_M || o.height < POI_MIN_HEIGHT_M) continue;
    seen = consider(sys, a, o.position, seen);
  }
  return seen > 0;
}

/**
 * 후보 한 자리를 본다 — 하네스 안이고 선점되지 않았으면 **저수지 표본**으로 `a.roamPoi` 에 담는다 (배열을 만들지 않고
 * 고르게 하나를 뽑는 방법이다). 지금까지 본 후보 수를 돌려준다.
 */
function consider(sys: AllySystem, a: Ally, p: THREE.Vector3, seen: number): number {
  if (dist2D(p, sys.leaderPos) > sys.harness) return seen;
  if (taken(sys, a, p)) return seen;
  const n = seen + 1;
  if (a.rand.next() < 1 / n) a.roamPoi.copy(p);
  return n;
}

/** 그 지점 `ALLY_ROAM_POI_TAKEN_M` 안에 다른 분대원 · 안드로이드가 있거나, 이미 다른 기가 찍어 둔 지점인가. */
function taken(sys: AllySystem, a: Ally, p: THREE.Vector3): boolean {
  for (const o of sys.bodies) {
    if (o === a || o.dead || o.hidden || o.mode !== 'raid') continue;
    if (dist2D(o.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
    if (o.hasRoamPoi && dist2D(o.roamPoi, p) < ALLY_ROAM_POI_TAKEN_M) return true;
  }
  const ctx = sys.ctx;
  const me = ctx.player;
  if (me && !me.isDead && dist2D(me.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
  const net = ctx.net;
  if (net) {
    for (const rp of net.getRemotePlayers()) {
      if (rp.isDead) continue;
      if (dist2D(rp.position, p) < ALLY_ROAM_POI_TAKEN_M) return true;
    }
  }
  return false;
}

/* ── 순찰 지점 ───────────────────────────────────────────────────────────── */

/**
 * 다음으로 걸어갈 자리를 `a.roamDest` 에 고른다. 마땅한 자리가 없으면 false.
 *
 * `ALLY_ROAM_MIN_STEP_M` 은 **먼저 노리는 조건**이지 절대 조건이 아니다: 관심 지점 한가운데에 서 있으면
 * 반경(`ALLY_ROAM_POI_RADIUS_M`) 안의 어떤 점도 그만큼 멀지 않아 전부 떨어지고, 그러면 그 자리에 영영 굳는다.
 * 그래서 걸을 수 있는 후보 중 **가장 먼 것**을 남겨 두었다가 차선으로 쓴다.
 */
function pickDest(sys: AllySystem, a: Ally): boolean {
  const center = a.hasRoamPoi ? a.roamPoi : sys.leaderPos;
  const radius = a.hasRoamPoi ? ALLY_ROAM_POI_RADIUS_M : sys.harness;
  let bestD = -1;
  for (let i = 0; i < PICK_TRIES; i++) {
    const ang = a.rand.next() * Math.PI * 2;
    const r = Math.sqrt(a.rand.next()) * radius;          // √ 를 씌워야 원 안에 고르게 흩어진다
    _r1.set(center.x + Math.cos(ang) * r, center.y, center.z + Math.sin(ang) * r);
    Nav.clampToHarness(sys.leaderPos, sys.harness, _r1, _r2);
    if (dist2D(_r2, sys.leaderPos) < ALLY_FOLLOW_NEAR_M) continue;     // 분대장에게 달라붙지 않는다
    if (!walkable(sys, a, _r2)) continue;
    const d = dist2D(_r2, a.position);
    if (d > bestD) { bestD = d; a.roamDest.copy(_r2); }
    if (d >= ALLY_ROAM_MIN_STEP_M) { a.hasRoamDest = true; return true; }   // 제자리 맴돌이가 아니다 — 이걸로 간다
  }
  if (bestD <= ALLY_MOVE_ARRIVE_M) return false;          // 걸어갈 만큼 떨어진 자리를 하나도 못 찾았다
  a.hasRoamDest = true;
  return true;
}

/** 걸어가 설 수 있는 자리인가 — 맞으면 `p` 를 실제로 설 자리(지면 높이)로 고쳐 쓴다. */
function walkable(sys: AllySystem, a: Ally, p: THREE.Vector3): boolean {
  const world = sys.ctx.world;
  if (!world || !world.isInsideBounds(p.x, p.z)) return false;
  // 지면 → 충돌 순서 (CLAUDE.md §4.4 · `Nav.step` 과 같다 — 뒤집으면 낮은 턱 위가 영영 「막힌 자리」로 읽힌다).
  p.y = world.getSurfaceY(p.x, p.z, a.position.y);
  _r3.copy(p);
  world.resolveCollision(_r3, PLAYER_RADIUS);
  if (dist2D(_r3, p) > BLOCKED_SLACK_M) return false;                  // 소품 속이다
  p.copy(_r3);
  p.y = world.getSurfaceY(p.x, p.z, a.position.y);
  return true;
}

/* ── 둘러보기 ────────────────────────────────────────────────────────────── */

/**
 * 도착해 쉬는 동안 **주위를 둘러본다** — 그 자리에 얼어붙는 것보다 천천히 그럴듯한 방향으로 고개를 돌리는 편이
 * 훨씬 사람처럼 읽힌다 (사용자 결정). 다 돌았으면 다음 방향을 고른다.
 */
function lookAround(a: Ally, dt: number): void {
  if (!a.lookAt || turnDone(a)) pickLook(a);
  Nav.face(a, a.lookVec, dt);
}

function turnDone(a: Ally): boolean {
  const diff = yawToward(a.position, a.lookVec) - a.yaw;
  return Math.abs(Math.atan2(Math.sin(diff), Math.cos(diff))) < LOOK_DONE_RAD;
}

function pickLook(a: Ally): void {
  const turn = a.rand.range(LOOK_TURN_MIN_RAD, LOOK_TURN_MAX_RAD) * (a.rand.next() < 0.5 ? -1 : 1);
  forwardOf(a.yaw + turn, _r1);
  a.lookVec.set(a.position.x + _r1.x * LOOK_DIST_M, a.position.y, a.position.z + _r1.z * LOOK_DIST_M);
  a.lookAt = a.lookVec;
}
