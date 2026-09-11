/**
 * src/enemies/ai/named/Sniper.ts — **로든** (`rogue_sniper`, 2026-09-11).
 *
 * 넓은 개활지에서 대물 저격총으로 플레이어의 머리를 노리는 저격수. **전조 없는 한 발은 없다** — 모든 사격은
 * `NAMED_SNIPER.glintTime` 동안의 조준경 반짝임(힌트 15 · `named:sniperGlint` · `ee glint`) 뒤에만 나간다.
 * 반짝임 동안 사선을 끊으면(엄폐) 탄은 엄폐물에 박힌다 — `fireGun` 의 월드 레이캐스트가 그대로 막는다.
 *
 * 상태 (`Enemy.namedData` = `SniperData`, 첫 틱에 만든다 — 호스트에서만):
 *  - **엎드림**(힌트 14) — 둥지(`guardPos`)에서 엎드려 조준경으로 천천히 훑는다. `e.aware` 는 늘 true 라
 *    총알 추적(`ai/Investigate`)이나 시야 상실이 둥지에서 끌어내지 않는다.
 *  - **근거리 모드** — `detectRange`(× 은폐 계수) 안의 살아 있는 플레이어 중 **엎드린 눈높이 → 머리** 사선이 열린
 *    가장 가까운 한 명. 몸을 돌려 조준이 맞고 `fireCooldown` 이 끝났으면 반짝임 → 발사. 명중률은 거리에 따라
 *    `nearAccuracyMax` → `nearAccuracyMin` 선형.
 *  - **원거리 모드** — `detectRange` 밖 ~ `droneRange` 안에 플레이어가 있으면 `launchScanDrone` 으로 스캔 드론을
 *    띄운다. 드론이 `done` 이 되면 `exposure ≥ exposeNeeded` 인 표적 중 사선이 열린 가장 가까운 한 명을
 *    `scannedAccuracy` 로 쏜다. `scanWait` 동안 사선이 안 열리면 포기. 드론이 `done` 전에 떨어지면 `droneRetry`,
 *    스캔 표적에게 쐈으면 `droneCooldown`. 어느 쪽이든 `SniperData.resolvedDroneId` 에 드론 id 를 남긴다
 *    (드론이 노출 표시를 풀고 복귀하는 신호).
 *  - **자리 옮기기**(힌트 0 = 서서 달린다) — 피격되었거나 플레이어가 `closeThreat` 안으로 들어오면
 *    `relocateCooldown` 에 한 번, 위협 반대쪽 옆으로 6–10 m 옮긴다(둥지에서 `nestLeash` 이상 벗어나지 않는다).
 *    반짝임 중에는 옮기지 않는다 — 전조를 띄운 한 발은 끝까지 쏜다.
 *  - 경직 · 전소 — 힌트 0 으로 일반 로그 자세(웅크림 · 몸부림)를 쓰고 반짝임은 취소된다.
 *
 * **플레이어만 쏜다** (리드 결정): `t`(= `pickTarget` 의 답, 벌레 · 드론일 수 있다)는 쓰지 않고
 * `host.targets.alive` 에서 직접 고른다. 드론 프록시(`isDrone`) · 적 프록시(`enemy`)는 반짝임도 150 피해도 받지 않는다.
 *
 * 연출(트레이서 · 섬광 · 먼 총성)은 `named/SniperShot` 하나를 호스트와 리플리카가 같이 부른다. 반짝임 스프라이트와
 * 엎드림 자세는 `models/named/SniperLook` 이 `e.namedHint` 에서 그린다.
 */
import * as THREE from 'three';
import type { EnemyEvent, PeerId } from '@/shared';
import type { Enemy, EnemyHost, RogueShotOpts } from '../../Enemy';
import { NAMED_SCAN_DRONE, NAMED_SNIPER } from '../../EnemyTypes';
import type { CombatTarget } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { round, tuple } from '../../net/HostSync';
import { clearSniperGlint, holdSniperGlint } from '../../models/named/SniperLook';
import { sniperGlintFx, sniperShotFx, type SniperFxHost } from '../../named/SniperShot';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';
import { visionClarity } from '../Perception';
import { turnToward, yawTo } from '../Steering';
import { launchScanDrone } from './ScanDrone';
import { scanDroneDataOf, sniperDataOf, type ScanDroneData, type SniperData } from './model';

/* ── 와이어 힌트 (`EnemyWire.a`) ── */
const HINT_PRONE = 14;
const HINT_GLINT = 15;

/* ── 알고리즘 · 그림 상수 (밸런스 수치는 NAMED_SNIPER) ── */
/** 표적 고르기(사선 레이캐스트) 주기 s. */
const PICK_INTERVAL_S = 0.3;
/** 엎드린 뒤 자세가 내려앉을 때까지 반짝임을 시작하지 않는다 (s). */
const PRONE_SETTLE_S = 0.7;
/** 몸이 표적을 이 각(rad) 안으로 향해야 반짝임을 시작한다. */
const FACE_TOL = 0.12;
/** 엎드린 눈(조준경) 위치: 발 기준 높이 · 표적 쪽 앞 거리 (m) — `models/named/SniperLook` 의 자세와 맞춘 값. */
const EYE_UP = 0.32;
const EYE_FWD = 0.9;
/** `ai/Perception` 과 같은 연막 기준 — 이 선명도 이하면 사선이 막힌 것으로 본다. */
const SMOKE_BLIND = 0.4;
/** 표적 눈높이 위로 머리 중심까지 (m). */
const HEAD_ABOVE_EYE = 0.06;
/** 빗나가기로 굴렸을 때 머리 옆으로 트는 거리 (m, 사용자 명세 1–2 m). */
const MISS_MIN_M = 1;
const MISS_MAX_M = 2;
/** 자리 옮기기: 한 번에 옮기는 거리 (m) · 최대 달리는 시간 (s). */
const RELOCATE_MIN_M = 6;
const RELOCATE_MAX_M = 10;
const RELOCATE_MAX_S = 4.5;
/** 반짝임이 취소되면(표적이 쓰러짐 · 사라짐) 다음 반짝임까지 최소 s. */
const CANCEL_COOLDOWN_S = 1.2;
/** 드론을 띄우지 못했으면 이만큼 뒤 다시 시도 (s). */
const LAUNCH_RETRY_S = 3;
/** 드론이 응답이 없을 때의 안전장치: `loiterMax` 에 더하는 s. */
const DRONE_TIMEOUT_PAD_S = 20;
/** 할 일이 없을 때 조준경으로 훑는 폭 (rad) · 속도 (rad/s). */
const WATCH_SWEEP = 0.5;
const WATCH_SPEED = 0.23;

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _head = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _shot = { from: new THREE.Vector3(), to: new THREE.Vector3() };
const SHOT_OPTS: RogueShotOpts = { aimAt: _aim, fx: false, wire: false, out: _shot };

function createData(e: Enemy): SniperData {
  return {
    kind: 'sniper',
    droneId: null,
    droneCooldown: LAUNCH_RETRY_S,
    fireCooldown: PRONE_SETTLE_S,
    aimTargetId: null,
    glintLeft: 0,
    aimScanned: false,
    resolvedDroneId: null,
    scanWait: -1,
    droneAge: 0,
    lastHp: e.hp,
    relocate: 0,
    relocateCd: 0,
    proneTime: 0,
    pickId: null,
    pickScanned: false,
    pickAt: 0,
    watchYaw: e.yaw,
  };
}

/** 로든이 쏠 수 있는 표적 = 살아 있는 **플레이어** (드론 · 적 프록시 제외). */
function isPlayerTarget(t: CombatTarget): boolean {
  return t.present && !t.isDeadOrDowned && t.enemy === null && !t.isDrone;
}

function hosting(host: EnemyHost): boolean {
  const ctx = host.ctx;
  return !host.replica && ctx.isMultiplayer && ctx.isAuthority && !!ctx.net;
}

function peerOf(host: EnemyHost, t: CombatTarget): PeerId | null {
  if (t.isLocal) return host.ctx.net?.localId ?? null;
  return t.id === 'ai' ? null : (t.id as PeerId);
}

function findEnemy(host: EnemyHost, id: number): Enemy | null {
  const list = host.active;
  for (let i = 0; i < list.length; i++) if (list[i].id === id && list[i].active) return list[i];
  return null;
}

function angleDiff(a: number, b: number): number {
  const d = b - a;
  return Math.atan2(Math.sin(d), Math.cos(d));
}

function headOf(t: CombatTarget, out: THREE.Vector3): THREE.Vector3 {
  return out.set(t.position.x, t.position.y + t.eyeHeight + HEAD_ABOVE_EYE, t.position.z);
}

function nearestPlayer(host: EnemyHost, p: THREE.Vector3): CombatTarget | null {
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const d = t.dist2D(p);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/**
 * 엎드린 눈높이 → 표적 머리 사선. 몸 방향과 무관하게 **표적 쪽으로** `EYE_FWD` 앞의 조준경 자리에서 쏜다 —
 * 아직 돌아서지 않은 표적도 고를 수 있어야 해서 리그의 총구(지금 향한 방향)는 쓰지 않는다. 그 자리는 로든의 몸
 * 안이라(적은 월드 장애물이 아니다) `ai/FireLine` 의 "총구 뒤에서 출발" 규약과 같은 효과다. 연막도 막는다.
 */
function lineOpen(e: Enemy, host: EnemyHost, t: CombatTarget, head: THREE.Vector3): boolean {
  const world = host.ctx.world;
  if (!world) return false;
  const dx = head.x - e.position.x, dz = head.z - e.position.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) return true;
  _eye.set(e.position.x + (dx / l) * EYE_FWD, e.position.y + EYE_UP, e.position.z + (dz / l) * EYE_FWD);
  _dir.subVectors(head, _eye);
  const dist = _dir.length();
  if (dist < 0.5) return true;
  _dir.multiplyScalar(1 / dist);
  if (world.raycast(_eye, _dir, dist - 0.35) !== null) return false;
  return visionClarity(e, host, t) > SMOKE_BLIND;
}

/** 지금 드론이 스캔을 마쳤으면 그 데이터 (아니면 null). */
function finishedScan(e: Enemy, d: SniperData, host: EnemyHost): ScanDroneData | null {
  if (d.droneId === null) return null;
  const drone = findEnemy(host, d.droneId);
  const sd = drone ? scanDroneDataOf(drone) : null;
  return sd && sd.done && sd.sniperId === e.id ? sd : null;
}

function resolveDrone(d: SniperData, cooldown: number): void {
  d.resolvedDroneId = d.droneId;
  d.droneId = null;
  d.droneCooldown = cooldown;
  d.scanWait = -1;
  d.droneAge = 0;
}

/** 드론 수명 관리: 스캔 완료 → 사선 대기 창, 완료 전 이탈 · 요격 → `droneRetry`. */
function trackDrone(e: Enemy, d: SniperData, host: EnemyHost, dt: number): void {
  if (d.droneId === null) return;
  if (d.glintLeft > 0 && d.aimScanned) return;          // 스캔 표적에게 반짝이는 중 — 발사가 정리한다
  d.droneAge += dt;
  const drone = findEnemy(host, d.droneId);
  const sd = drone ? scanDroneDataOf(drone) : null;
  const mine = !!sd && sd.sniperId === e.id;
  if (mine && sd!.done) {
    if (d.scanWait < 0) d.scanWait = NAMED_SNIPER.scanWait;
    d.scanWait -= dt;
    if (d.scanWait <= 0) resolveDrone(d, NAMED_SNIPER.droneRetry);   // 사선이 끝내 안 열렸다 — 포기
    return;
  }
  const lost = !mine || drone!.state === 'dead' || drone!.state === 'flee'
    || d.droneAge > NAMED_SCAN_DRONE.loiterMax + DRONE_TIMEOUT_PAD_S;
  if (lost) resolveDrone(d, NAMED_SNIPER.droneRetry);    // 스캔을 마치기 전에 요격 · 이탈
}

/** 쏠 표적 고르기 — 근거리(감지 범위 · 사선) 우선, 없으면 스캔 표적(노출 · 사거리 · 사선). 가장 가까운 한 명. */
function pick(e: Enemy, d: SniperData, host: EnemyHost): void {
  d.pickId = null;
  d.pickScanned = false;
  const scan = finishedScan(e, d, host);
  const need = NAMED_SNIPER.exposeNeeded;
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const dist = t.dist2D(e.position);
    const stealth = t.stealth > 0 && t.stealth <= 1 ? t.stealth : 1;
    if (dist > NAMED_SNIPER.detectRange * stealth || dist >= bestD) continue;
    if (!lineOpen(e, host, t, headOf(t, _head))) continue;
    best = t; bestD = dist;
  }
  if (best) {
    d.pickId = best.id;
    d.pickScanned = !!scan && (scan.exposure.get(best.id) ?? 0) >= need;
    return;
  }
  if (!scan) return;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t) || (scan.exposure.get(t.id) ?? 0) < need) continue;
    const dist = t.dist2D(e.position);
    if (dist > NAMED_SNIPER.range || dist >= bestD) continue;
    if (!lineOpen(e, host, t, headOf(t, _head))) continue;
    best = t; bestD = dist;
  }
  if (best) { d.pickId = best.id; d.pickScanned = true; }
}

function cancelGlint(d: SniperData): void {
  d.glintLeft = 0;
  d.aimTargetId = null;
  d.aimScanned = false;
  d.fireCooldown = Math.max(d.fireCooldown, CANCEL_COOLDOWN_S);
  d.pickAt = 0;
}

/** 조준경 반짝임 시작 — 전조. 호스트 로컬 이벤트 + 소리, 멀티면 `ee glint`. */
function startGlint(e: Enemy, d: SniperData, host: EnemyHost, t: CombatTarget, scanned: boolean): void {
  const ctx = host.ctx;
  const dur = NAMED_SNIPER.glintTime;
  d.aimTargetId = t.id;
  d.glintLeft = dur;
  d.aimScanned = scanned;
  ctx.bus.emit('named:sniperGlint', { enemyId: e.id, position: e.position, targetLocal: t.isLocal, duration: dur });
  sniperGlintFx(host, e.position, t.isLocal);
  if (hosting(host)) ctx.net!.send({ t: 'ee', ev: 'glint', id: e.id, dur: round(dur, 2), target: peerOf(host, t) }, 'others');
}

/** 반짝임이 끝났다 — 한 발. 명중을 굴려 머리 또는 머리 옆 1–2 m 로 `fireGun` (피해 · 가림은 호스트가 판정). */
function fire(e: Enemy, d: SniperData, host: EnemyHost, t: CombatTarget): void {
  const dist = t.dist2D(e.position);
  let acc = THREE.MathUtils.lerp(NAMED_SNIPER.nearAccuracyMax, NAMED_SNIPER.nearAccuracyMin,
    THREE.MathUtils.clamp(dist / Math.max(1, NAMED_SNIPER.detectRange), 0, 1));
  if (d.aimScanned) acc = Math.max(acc, NAMED_SNIPER.scannedAccuracy);
  const hitRoll = Math.random() < acc;
  headOf(t, _aim);
  if (!hitRoll) {
    // 빗나감: 머리 옆으로 1–2 m 튼다 (탄은 월드에만 — 스쳐 가는 소리와 흙먼지가 두 번째 경고다)
    const dx = _aim.x - e.position.x, dz = _aim.z - e.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const side = Math.random() < 0.5 ? -1 : 1;
    const off = MISS_MIN_M + Math.random() * (MISS_MAX_M - MISS_MIN_M);
    _aim.x += (-dz / l) * side * off;
    _aim.z += (dx / l) * side * off;
    _aim.y += (Math.random() - 0.35) * 0.6;
  }
  SHOT_OPTS.damage = NAMED_SNIPER.damage;
  SHOT_OPTS.range = NAMED_SNIPER.range;
  const struck = host.fireGun(e, t, 0, 1, SHOT_OPTS);
  e.anim.recoil = 1;
  sniperShotFx(host, _shot.from, _shot.to, struck);
  if (hosting(host)) {
    host.ctx.net!.send({ t: 'ee', ev: 'snipe', id: e.id, from: tuple(_shot.from, 2), to: tuple(_shot.to, 2), hit: struck, target: peerOf(host, t) }, 'others');
  }
  d.glintLeft = 0;
  d.aimTargetId = null;
  d.fireCooldown = NAMED_SNIPER.fireInterval;
  d.pickAt = 0;
  if (d.aimScanned && d.droneId !== null) resolveDrone(d, NAMED_SNIPER.droneCooldown);
  d.aimScanned = false;
}

/** 감지 범위 밖 · 드론 사거리 안의 가장 가까운 플레이어에게 스캔 드론. */
function maybeLaunchDrone(e: Enemy, d: SniperData, host: EnemyHost): void {
  if (d.droneId !== null || d.droneCooldown > 0 || d.proneTime < PRONE_SETTLE_S) return;
  const list = host.targets.alive;
  let best: CombatTarget | null = null;
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!isPlayerTarget(t)) continue;
    const dist = t.dist2D(e.position);
    if (dist <= NAMED_SNIPER.detectRange || dist > NAMED_SNIPER.droneRange || dist >= bestD) continue;
    best = t; bestD = dist;
  }
  if (!best) return;
  const drone = launchScanDrone(host, e, best);
  if (drone) {
    d.droneId = drone.id;
    d.droneAge = 0;
    d.scanWait = -1;
    d.watchYaw = yawTo(e.position, best.position);
  } else d.droneCooldown = LAUNCH_RETRY_S;
}

/** 위협 반대쪽 옆으로 짧게 옮긴다 (둥지 리시 안). 목표는 `Enemy.coverPos` (로든은 엄폐 순환을 쓰지 않는다). */
function startRelocate(e: Enemy, d: SniperData, host: EnemyHost, from: THREE.Vector3 | null): void {
  const world = host.ctx.world!;
  let ax: number, az: number;
  const fl = from ? Math.hypot(e.position.x - from.x, e.position.z - from.z) : 0;
  if (from && fl > 1e-3) { ax = (e.position.x - from.x) / fl; az = (e.position.z - from.z) / fl; }
  else { const ang = Math.random() * Math.PI * 2; ax = Math.cos(ang); az = Math.sin(ang); }
  const side = Math.random() < 0.5 ? -1 : 1;
  let dx = ax * 0.55 - az * side * 0.85;
  let dz = az * 0.55 + ax * side * 0.85;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl; dz /= dl;
  const step = RELOCATE_MIN_M + Math.random() * (RELOCATE_MAX_M - RELOCATE_MIN_M);
  let px = e.position.x + dx * step;
  let pz = e.position.z + dz * step;
  const gx = px - e.guardPos.x, gz = pz - e.guardPos.z;
  const gl = Math.hypot(gx, gz);
  const leash = NAMED_SNIPER.nestLeash;
  if (gl > leash) { px = e.guardPos.x + (gx / gl) * leash; pz = e.guardPos.z + (gz / gl) * leash; }
  if (!world.isInsideBounds(px, pz)) { px = e.guardPos.x; pz = e.guardPos.z; }
  e.coverPos.set(px, 0, pz);
  e.hasCover = true;
  d.relocate = RELOCATE_MAX_S;
  d.relocateCd = NAMED_SNIPER.relocateCooldown;
  d.proneTime = 0;
  d.pickId = null;
  d.pickAt = 0;
}

export function updateSniper(e: Enemy, dt: number, host: EnemyHost, _t: CombatTarget | null, _targetAlive: boolean): void {
  const world = host.ctx.world;
  if (!world) return;
  const s = e.stats;
  const a = e.anim;
  let d = sniperDataOf(e);
  if (!d) { d = createData(e); e.namedData = d; }

  e.aware = true;   // 늘 경계 중 — 위 머리말
  if (d.droneCooldown > 0) d.droneCooldown -= dt;
  if (d.fireCooldown > 0) d.fireCooldown -= dt;
  if (d.relocateCd > 0) d.relocateCd -= dt;
  const hurt = e.hp < d.lastHp - 0.01;
  d.lastHp = e.hp;
  trackDrone(e, d, host, dt);

  e.hasMoveTarget = false;
  e.hasFacePoint = false;
  let speed = 0;
  let aimT = 0.7;
  let crouchT = 0;
  let hint = HINT_PRONE;
  let wantYaw: number | null = null;

  if (e.state === 'stagger') {
    // 경직 · 전소: 일반 로그 자세(힌트 0), 반짝임은 취소
    if (d.glintLeft > 0) cancelGlint(d);
    d.relocate = 0;
    d.proneTime = 0;
    hint = 0;
    e.staggerTimer -= dt;
    if (e.incapTimer > 0) { e.incapTimer = Math.max(0, e.incapTimer - dt); crouchT = 0.35; aimT = 0; }
    else { crouchT = 0.5; a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6); }
    if (e.staggerTimer <= 0 && e.incapTimer <= 0) { e.incapTimer = 0; e.state = 'chase'; e.stateTime = 0; }
  } else {
    if (e.state !== 'chase' && e.state !== 'idle') { e.state = 'idle'; e.stateTime = 0; }   // alert · wander → 로든의 두 상태
    const threat = nearestPlayer(host, e.position);
    const threatD = threat ? threat.dist2D(e.position) : Infinity;

    if (d.glintLeft <= 0 && d.relocate <= 0 && d.relocateCd <= 0 && (hurt || threatD < NAMED_SNIPER.closeThreat)) {
      startRelocate(e, d, host, threat && threatD <= NAMED_SNIPER.droneRange ? threat.position : null);
    }

    if (d.relocate > 0) {
      // 자리 옮기기: 일어서서 달린다 (힌트 0 — 리플리카는 기본 로그 보행)
      d.relocate -= dt;
      hint = 0; speed = s.speed; aimT = 0.3;
      e.state = 'chase';
      e.moveTarget.copy(e.coverPos); e.hasMoveTarget = true;
      const dx = e.coverPos.x - e.position.x, dz = e.coverPos.z - e.position.z;
      if (dx * dx + dz * dz < 0.8 || d.relocate <= 0) {
        d.relocate = 0;
        d.proneTime = 0;
        if (threat) d.watchYaw = yawTo(e.position, threat.position);
      }
    } else {
      d.proneTime += dt;
      if (d.glintLeft > 0) {
        // 반짝임 중: 표적을 계속 따라 돌며 끝나면 발사
        e.state = 'chase';
        const tgt = d.aimTargetId !== null ? host.targets.get(d.aimTargetId) : undefined;
        if (!tgt || !isPlayerTarget(tgt)) cancelGlint(d);
        else {
          wantYaw = yawTo(e.position, tgt.position);
          lookAtTarget(e, tgt, dt);
          hint = HINT_GLINT; aimT = 1;
          d.glintLeft -= dt;
          if (d.glintLeft <= 0) { fire(e, d, host, tgt); hint = HINT_PRONE; }
        }
      } else {
        d.pickAt -= dt;
        if (d.pickAt <= 0) { d.pickAt = PICK_INTERVAL_S; pick(e, d, host); }
        const tgt = d.pickId !== null ? host.targets.get(d.pickId) : undefined;
        if (tgt && isPlayerTarget(tgt)) {
          e.state = 'chase';
          wantYaw = yawTo(e.position, tgt.position);
          d.watchYaw = wantYaw;
          lookAtTarget(e, tgt, dt);
          aimT = 0.9;
          if (d.fireCooldown <= 0 && d.proneTime >= PRONE_SETTLE_S && Math.abs(angleDiff(e.yaw, wantYaw)) < FACE_TOL) {
            startGlint(e, d, host, tgt, d.pickScanned);
            hint = HINT_GLINT; aimT = 1;
          }
        } else {
          // 쏠 표적이 없다: 가장 가까운 플레이어 쪽(드론 사거리 안)을 중심으로 조준경을 천천히 훑는다
          if (threat && threatD <= NAMED_SNIPER.droneRange) { d.watchYaw = yawTo(e.position, threat.position); e.state = 'chase'; }
          else e.state = 'idle';
          wantYaw = d.watchYaw + Math.sin(a.time * WATCH_SPEED + e.id) * WATCH_SWEEP;
          a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.5) * 0.25, dt * 2);
          a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.05, dt * 3);
        }
        if (d.glintLeft <= 0) maybeLaunchDrone(e, d, host);
      }
    }
  }

  e.namedHint = hint;
  if (wantYaw !== null && hint !== 0) e.yaw = turnToward(e.yaw, wantYaw, NAMED_SNIPER.proneTurnRate, dt);
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 7 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

/* ── 리플리카 ─────────────────────────────────────────────────────────────── */

/** 자세는 `afterSniperReplica` 에서만 덮어쓴다 (엎드린 몸은 지형 스냅을 그대로 쓴다). */
export function beforeSniperReplica(_e: Enemy, _hint: number): void { /* 할 일 없음 */ }

/** 힌트 14 / 15: 기본 로그 애니 목표(웅크림 · 반쯤 든 총)를 엎드린 조준으로 덮어쓴다 — 몸은 `SniperLook` 이 눕힌다. */
export function afterSniperReplica(e: Enemy, hint: number, dt: number): void {
  if (hint !== HINT_PRONE && hint !== HINT_GLINT) return;
  const a = e.anim;
  a.crouch += (0 - a.crouch) * Math.min(1, dt * 10);
  const aimT = hint === HINT_GLINT ? 1 : 0.7;
  a.aim += (aimT - a.aim) * Math.min(1, dt * 7);
}

/** `ee glint` → 반짝임 스프라이트 · 소리 · `named:sniperGlint`. `ee snipe` → 트레이서 · 섬광 · 먼 총성 · 반동 (피해는 호스트의 `dmg`). */
export function onSniperEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'glint' | 'snipe' }>): void {
  const ctx = host.ctx;
  const fxHost: SniperFxHost = host;
  const e = host.find(msg.id);
  if (msg.ev === 'glint') {
    if (!e || !e.active) return;
    const localId = ctx.net?.localId ?? null;
    const targetLocal = msg.target !== null && msg.target === localId;
    if (e.rig.kind === 'rogue') holdSniperGlint(e.rig, msg.dur);
    sniperGlintFx(fxHost, e.position, targetLocal);
    ctx.bus.emit('named:sniperGlint', { enemyId: msg.id, position: e.position, targetLocal, duration: msg.dur });
    return;
  }
  _from.set(msg.from[0], msg.from[1], msg.from[2]);
  _to.set(msg.to[0], msg.to[1], msg.to[2]);
  if (e) {
    e.anim.recoil = 1;
    if (e.rig.kind === 'rogue') clearSniperGlint(e.rig);
  }
  sniperShotFx(fxHost, _from, _to, msg.hit);
  ctx.bus.emit('enemy:shot', { id: msg.id, type: e?.type ?? 'rogue_sniper', from: _from.clone(), to: _to.clone(), hit: msg.hit });
}
