/**
 * src/enemies/ai/named/Heavy.ts — **헤비** (`rogue_heavy`, 2026-09-11). 유니크 미니건을 든 네임드 로그.
 *
 * ── 호스트 (`updateHeavy`) ─────────────────────────────────────────────────────────────────────────────
 * 엄폐 사이클이 없다. 표적과 `keepMin`–`keepMax` 를 유지하며 둔중하게 걷는다 — 멀거나 안 보이면 다가가고, 너무
 * 가까우면 물러서고, 띠 안의 먼 쪽이면 `creepMul` 로 천천히 밀고 들어온다. 눈에는 보이는데 **총구 사선**이 막혔으면
 * (`ai/FireLine`) `fireLineStrafe` 로 옆으로 비켜 선다. 사선이 열리면 상태 기계(`Enemy.namedPhase`):
 *
 *   ADVANCE(0) ─사선 + 쿨다운 끝→ SPINUP(1, 힌트 18, `minigun_spinup`, `spinUp` s, 이동 × `spinMoveMul`)
 *     → 사선 있음 → FIRE(2, 힌트 19, `ee spray on`, 남은 연사 `burstTime`)
 *     → 사선 없음 → LINGER(3, 힌트 18, `linger` s 헛돌기)
 *   FIRE: 발사 틱마다(`1 / rof`) `host.fireGun(e, t, spread, 1, { damage, range, fx:false, event:false, wire:false })`.
 *         몸이 표적에서 `FIRE_FACING_TOL` 넘게 돌아가 있으면 총열만 돌고 쏘지 않는다(측면을 잡을 틈).
 *         연사가 끝나면 `ee spray off` + `minigun_spindown` + `burstCooldown` → ADVANCE.
 *         사선이 끊기면 `ee spray off` → LINGER.
 *   LINGER: 그 안에 사선이 돌아오면 **남은 연사**를 곧바로 잇고(`ee spray on` 다시), 아니면 spindown + 쿨다운 절반.
 * 경직 · 표적 상실로 교전(chase)을 벗어나면 그 자리에서 연사를 끊는다.
 *
 * 와이어는 연사 시작/끝의 `ee spray` 두 번뿐이다 — 발마다 `ee shoot` 을 보내지 않는다. 호스트 화면의 연출
 * (트레이서 `TRACER_EVERY` 발에 하나 · 총구 섬광 · `minigun_fire` 틱)은 이 파일이 `@/core/fx` 풀로 그린다
 * (섬광 광원 세기 0 — 씬 광원 개수는 바뀌지 않는다).
 *
 * ── 리플리카 ─────────────────────────────────────────────────────────────────────────────────────────
 * `onHeavyEvent(spray on)` 이 그 적의 연사 상태를 켜 두면 `afterHeavyReplica` 가 **스스로** 같은 박자로 트레이서
 * (몸 방위 콘 안 가장 가까운 후보의 가슴 + `spread`, 후보가 없으면 yaw 전방 + 머리 피치) · 섬광 · 소리를 낸다.
 * 피해는 호스트가 이미 `dmg` 로 보냈다.
 * `off` 를 놓쳐도 `burstTime + REMOTE_GRACE` 타임아웃, 또는 스냅샷 힌트가 19 에서 벗어난 채 `REMOTE_HINT_MISS`
 * 가 지나면 멈춘다. 총열 회전 · 반동 떨림은 `models/named/HeavyLook` 이 `Enemy.namedHint` 로 양쪽에서 똑같이 그린다.
 *
 * **드론 표적** (2026-09-11): `pickTarget` 이 드론을 줄 수 있고 헤비도 쏜다. 조준점은 `aimAt` 을 넘기지 않으므로 드론을
 * 아는 `CombatTarget.getChest`(몸체 가운데)이고, `lookAtTarget` · `hasFireLine` 도 같은 식이다. 드론에게서는 물러서지 않고
 * (`keepMin` 무시) 살 맞는 소리도 내지 않는다. 리플리카 트레이서는 방위로 표적을 추론하므로(`remoteAimPoint`) 드론 · 벌레도 향한다.
 *
 * 호위 SMG 로그는 기존 가드 로직(`Enemy.escortOf` → `ai/RogueAI`)을 탄다 — 헤비는 그들을 기다리지 않고,
 * 헤비가 죽으면 `RogueAI` 가 호위를 평소 로그로 풀어 준다.
 */
import * as THREE from 'three';
import { ROGUE_REACTION, type EnemyEvent, type GameContext } from '@/shared';
import { FxManager } from '@/core/fx';
import type { Enemy, EnemyHost, RogueShotOpts } from '../../Enemy';
import { NAMED_HEAVY } from '../../EnemyTypes';
import type { CombatTarget } from '../../Targets';
import type { ReplicaHost } from '../../net/Replica';
import { lookAtTarget } from '../Common';
import { integrate } from '../EnemyAI';
import { fireLineStrafe, hasFireLine } from '../FireLine';

/* 와이어 애니메이션 힌트 (`EnemyWire.a`) */
const HINT_SPIN = 18;
const HINT_FIRE = 19;

/* `Enemy.namedPhase` */
const PH_ADVANCE = 0;
const PH_SPINUP = 1;
const PH_FIRE = 2;
const PH_LINGER = 3;

/* ── 연출 · 알고리즘 상수 — 밸런스 수치가 아니라 csv 대상이 아니다 (밸런스는 `NAMED_HEAVY`) ── */
/** 몇 발에 트레이서 하나. */
const TRACER_EVERY = 2;
/** `minigun_fire` 틱 간격 (s). `host.playAudio` 의 기본 스로틀(0.12 s)보다 짧아서 버스로 직접 낸다. */
const FIRE_AUDIO_TICK = 0.1;
/** 한 프레임에 쏘는 최대 발수 — 프레임이 튀어도 몰아 쏘지 않는다. */
const MAX_SHOTS_PER_FRAME = 3;
/** 몸이 표적에서 이만큼(rad) 넘게 돌아가 있으면 총열만 돌고 쏘지 않는다. */
const FIRE_FACING_TOL = 0.35;
/** 너무 가까울 때 뒤로 물러나는 조향 목표까지의 거리 (m). */
const BACKOFF_STEP = 6;
/** 리플리카: `ee spray on` 뒤 `off` 가 오지 않아도 `burstTime + 이 값` 이 지나면 멈춘다 (s). */
const REMOTE_GRACE = 1.5;
/** 리플리카: 연사 중인데 스냅샷 힌트가 19 가 아닌 채 이만큼 지나면 멈춘다 (s). */
const REMOTE_HINT_MISS = 0.5;
const TRACER_COLOR = 0xffd27a;
const FLASH_COLOR = 0xffc070;
const TWO_PI = Math.PI * 2;

/** `Enemy.namedData` of a `rogue_heavy` — private to this file (host fields and replica fields share one object). */
interface HeavyData {
  kind: 'heavy';
  /** host: seconds of spray left in the current burst (kept through a LINGER so a re-opened line resumes it) */
  burstLeft: number;
  /** host + replica: shots owed by the rof accumulator */
  shotAcc: number;
  /** host + replica: shots fired so far (tracer cadence) */
  shotCount: number;
  /** host + replica: seconds until the next `minigun_fire` tick */
  audioTick: number;
  /** host: an `ee spray on` is out, so an `off` is owed */
  sprayWire: boolean;
  /** replica: spraying per the host's `ee spray` */
  remoteOn: boolean;
  /** replica: safety timeout (s) */
  remoteLeft: number;
  /** replica: seconds the snapshot hint has not been 19 while `remoteOn` */
  remoteHintMiss: number;
  /** replica: last hint seen (spin-up / spin-down audio on the edges) */
  prevHint: number;
}

function heavyData(e: Enemy): HeavyData {
  const d = e.namedData as HeavyData | null;
  if (d && d.kind === 'heavy') return d;
  const n: HeavyData = {
    kind: 'heavy', burstLeft: 0, shotAcc: 0, shotCount: 0, audioTick: 0, sprayWire: false,
    remoteOn: false, remoteLeft: 0, remoteHintMiss: 0, prevHint: 0,
  };
  e.namedData = n;
  return n;
}

const _shotOut = { from: new THREE.Vector3(), to: new THREE.Vector3() };
const _shot: RogueShotOpts = { damage: 0, range: 0, fx: false, event: false, wire: false, out: _shotOut };
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _side = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _chest = new THREE.Vector3();

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * 호스트
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */

export function updateHeavy(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  const world = host.ctx.world!;
  const s = e.stats;
  const a = e.anim;
  const d = heavyData(e);
  d.remoteOn = false;   // 승격된 호스트: 이제 이 AI 가 미니건을 쥔다 (리플리카 시절의 연사 연출은 끈다)
  if (e.namedCooldown > 0) e.namedCooldown -= dt;

  // 싸울 상대가 없다 → 그 자리를 새 순찰 기점으로 삼고 선다
  if (!targetAlive && e.aware && (e.state === 'chase' || e.state === 'alert')) {
    e.aware = false; e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1.5;
    e.guardPos.copy(e.position);
  }

  let speed = 0;
  let aimT = e.aware ? 0.5 : 0;
  let crouchT = 0;
  let hint = 0;
  e.hasMoveTarget = false;
  e.hasFacePoint = false;

  switch (e.state) {
    case 'idle': {
      e.wanderTimer -= dt;
      a.headYaw = THREE.MathUtils.lerp(a.headYaw, Math.sin(a.time * 0.4) * 0.4, dt * 2);
      a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0, dt * 3);
      if (e.wanderTimer <= 0) {
        const ang = Math.random() * TWO_PI;
        const rad = 3 + Math.random() * 4;
        e.moveTarget.set(e.guardPos.x + Math.cos(ang) * rad, 0, e.guardPos.z + Math.sin(ang) * rad);
        if (!world.isInsideBounds(e.moveTarget.x, e.moveTarget.z)) e.moveTarget.copy(e.guardPos);
        e.state = 'wander'; e.stateTime = 0;
      }
      break;
    }
    case 'wander': {
      e.hasMoveTarget = true;
      speed = s.wanderSpeed;
      const dx = e.moveTarget.x - e.position.x, dz = e.moveTarget.z - e.position.z;
      if (dx * dx + dz * dz < 0.6 || e.stateTime > 10) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 3 + Math.random() * 4; }
      break;
    }
    case 'alert': {
      // 반응 지연: 표적 쪽으로 돌아서며 미니건을 든다
      if (targetAlive) { e.facePoint.copy(t!.position); e.hasFacePoint = true; lookAtTarget(e, t!, dt); }
      aimT = 0.8;
      if (e.stateTime >= ROGUE_REACTION) { e.state = 'chase'; e.stateTime = 0; }
      break;
    }
    case 'chase': {
      if (!targetAlive) { e.state = 'idle'; e.stateTime = 0; e.wanderTimer = 1; break; }
      speed = engage(e, d, dt, host, t!);
      aimT = e.namedPhase === PH_ADVANCE ? 0.7 : 1;
      hint = e.namedPhase === PH_FIRE ? HINT_FIRE : e.namedPhase === PH_ADVANCE ? 0 : HINT_SPIN;
      break;
    }
    case 'stagger': {
      e.staggerTimer -= dt;
      if (e.incapTimer > 0) {
        // 전소: 미니건을 떨군 채 몸부림 (anim.writhe)
        e.incapTimer = Math.max(0, e.incapTimer - dt);
        crouchT = 0.35; aimT = 0;
      } else {
        crouchT = 0.35;
        a.headPitch = THREE.MathUtils.lerp(a.headPitch, 0.3, dt * 6);
      }
      if (e.staggerTimer <= 0 && e.incapTimer <= 0) {
        e.incapTimer = 0;
        e.state = e.aware && targetAlive ? 'chase' : 'idle';
        e.stateTime = 0; e.wanderTimer = 1;
      }
      break;
    }
    default: break;
  }

  // 교전 밖(경직 · 표적 상실 · 순찰)으로 나가면 연사를 그 자리에서 끊고 총열을 세운다
  if (e.state !== 'chase' && e.namedPhase !== PH_ADVANCE) endBurst(e, d, host, NAMED_HEAVY.burstCooldown * 0.5);

  e.namedHint = hint;   // 0 = 일반 로그 힌트(경직 6 등)로 `net/HostSync.animHint` 가 되돌아간다
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 5 : 3));
  a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 7);
  a.shake = Math.max(0, a.shake - dt * 4);
  integrate(e, dt, world, host, speed, false);
}

/** One tick of the fight while a live target exists: footwork + the spin / fire state machine. Returns the move speed. */
function engage(e: Enemy, d: HeavyData, dt: number, host: EnemyHost, t: CombatTarget): number {
  const s = e.stats;
  const H = NAMED_HEAVY;
  const dist = e.distToTarget;
  lookAtTarget(e, t, dt);
  e.facePoint.copy(t.position); e.hasFacePoint = true;
  // 싼 것부터: 눈(인지 캐시) → 사거리 → 총구 사선(`ENEMY_FIRE_LOS_S` 캐시)
  const line = e.hasLOS && dist <= H.range && hasFireLine(e, host, t);

  /* ── 발놀림 — 사선이 있든 없든 계속 걷는다 (사격만 보류하고 이동은 막지 않는다, FireLine 규약 1) ── */
  const mul = e.namedPhase === PH_ADVANCE ? 1 : H.spinMoveMul;
  let speed = 0;
  if (!e.hasLOS || dist > H.keepMax) {
    // 멀거나 안 보인다: 다가간다
    e.moveTarget.copy(t.position); e.hasMoveTarget = true;
    speed = s.speed * mul;
  } else if (dist < H.keepMin && !t.isDrone) {
    // 너무 가깝다: 표적을 바라본 채 뒤로 물러선다 (맵 밖이면 버틴다). 드론에게서는 물러서지 않고 그 자리에서 쓸어 버린다.
    const dx = e.position.x - t.position.x, dz = e.position.z - t.position.z;
    const l = Math.hypot(dx, dz) || 1;
    const mx = e.position.x + (dx / l) * BACKOFF_STEP, mz = e.position.z + (dz / l) * BACKOFF_STEP;
    if (host.ctx.world!.isInsideBounds(mx, mz)) {
      e.moveTarget.set(mx, 0, mz); e.hasMoveTarget = true;
      speed = s.speed * H.creepMul * mul;
    }
  } else if (!line) {
    // 눈에는 보이는데 총구가 막혔다(벽 · 바위에 몸을 붙였다): 옆으로 비켜 선다. 다리가 끝나면 FireLine 이 반대쪽으로 뒤집는다.
    fireLineStrafe(e, host, t, dt);
    speed = s.speed * mul;
  } else if (dist > (H.keepMin + H.keepMax) * 0.5) {
    // 띠 안의 먼 쪽: 쏘면서도 천천히 밀고 들어온다
    e.moveTarget.copy(t.position); e.hasMoveTarget = true;
    speed = s.speed * H.creepMul * mul;
  }

  /* ── 미니건 ── */
  switch (e.namedPhase) {
    case PH_ADVANCE:
      if (line && e.namedCooldown <= 0) {
        e.namedPhase = PH_SPINUP; e.namedTimer = 0;
        d.burstLeft = H.burstTime;
        host.playAudio('minigun_spinup', e.position, 1, 1);
      }
      break;
    case PH_SPINUP:
      // 한 번 돌리기 시작하면 끝까지 돌린다 — 다 돌았을 때 사선이 없으면 헛돈다
      e.namedTimer += dt;
      if (e.namedTimer >= H.spinUp) {
        if (line) startFire(e, d, host);
        else { e.namedPhase = PH_LINGER; e.namedTimer = H.linger; }
      }
      break;
    case PH_FIRE:
      if (!line) {
        stopWire(e, d, host);
        e.namedPhase = PH_LINGER; e.namedTimer = H.linger; d.shotAcc = 0;
        break;
      }
      d.burstLeft -= dt;
      if (facingError(e, t) <= FIRE_FACING_TOL) fireTick(e, d, host, t, dt);
      if (d.burstLeft <= 0) endBurst(e, d, host, H.burstCooldown);
      break;
    case PH_LINGER:
      e.namedTimer -= dt;
      if (line && d.burstLeft > 0) startFire(e, d, host);
      else if (e.namedTimer <= 0) endBurst(e, d, host, H.burstCooldown * 0.5);
      break;
    default:
      e.namedPhase = PH_ADVANCE;
      break;
  }
  return speed;
}

function startFire(e: Enemy, d: HeavyData, host: EnemyHost): void {
  e.namedPhase = PH_FIRE; e.namedTimer = 0;
  d.shotAcc = 1;       // 첫 발은 곧바로
  d.audioTick = 0;
  if (!d.sprayWire) { d.sprayWire = true; sendSpray(e, host, 1); }
}

function stopWire(e: Enemy, d: HeavyData, host: EnemyHost): void {
  if (!d.sprayWire) return;
  d.sprayWire = false;
  sendSpray(e, host, 0);
}

/** 연사를 끝내고 총열을 세운다 (spindown 소리는 실제로 돌고 있었을 때만). */
function endBurst(e: Enemy, d: HeavyData, host: EnemyHost, cooldown: number): void {
  stopWire(e, d, host);
  if (e.namedPhase !== PH_ADVANCE) host.playAudio('minigun_spindown', e.position, 1, 1);
  e.namedPhase = PH_ADVANCE; e.namedTimer = 0;
  e.namedCooldown = Math.max(e.namedCooldown, cooldown);
  d.burstLeft = 0; d.shotAcc = 0;
}

function sendSpray(e: Enemy, host: EnemyHost, on: 0 | 1): void {
  const ctx = host.ctx;
  if (host.replica || !ctx.isMultiplayer || !ctx.net) return;
  ctx.net.send({ t: 'ee', ev: 'spray', id: e.id, on }, 'others');
}

/** |표적 방향 − 몸 방향| (rad). */
function facingError(e: Enemy, t: CombatTarget): number {
  const want = Math.atan2(t.position.x - e.position.x, t.position.z - e.position.z);
  const rel = want - e.yaw;
  return Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));
}

/** 이번 프레임 몫의 발사 (호스트). 피해 · 가림 · 배리어 · 유리 파괴는 전부 `fireGun` 이 한다 — 여기는 박자와 연출만. */
function fireTick(e: Enemy, d: HeavyData, host: EnemyHost, t: CombatTarget, dt: number): void {
  const H = NAMED_HEAVY;
  d.shotAcc = Math.min(d.shotAcc + dt * H.rof, MAX_SHOTS_PER_FRAME);
  tickFireAudio(host.ctx, e.position, d, dt);
  if (d.shotAcc < 1) return;
  _shot.damage = H.damage;
  _shot.range = H.range;
  const fx = FxManager.get();
  let hit = false;
  while (d.shotAcc >= 1) {
    d.shotAcc -= 1;
    if (host.fireGun(e, t, H.spread, 1, _shot)) hit = true;
    if (fx && d.shotCount % TRACER_EVERY === 0) fx.tracers.add(_shotOut.from, _shotOut.to, TRACER_COLOR, 0.04, 0.06, 0);
    d.shotCount++;
  }
  // 섬광은 프레임에 하나 (FlashPool 은 모든 적 · 무기가 같이 쓰는 6칸이다). 세기 0 = 광원 기여 없음.
  if (fx) fx.flashes.flash(_shotOut.from, FLASH_COLOR, 0, 0.75, 0.04);
  e.anim.recoil = Math.max(e.anim.recoil, 0.6);
  if (hit && !t.isDrone) host.playAudio('hit_flesh', t.position, 0.5, 0.85);
}

/** `minigun_fire` 틱 — 발마다가 아니라 `FIRE_AUDIO_TICK` 마다 한 번. */
function tickFireAudio(ctx: GameContext, position: THREE.Vector3, d: HeavyData, dt: number): void {
  d.audioTick -= dt;
  if (d.audioTick > 0) return;
  d.audioTick += FIRE_AUDIO_TICK;
  if (d.audioTick <= 0) d.audioTick = FIRE_AUDIO_TICK;
  ctx.bus.emit('audio:play', { id: 'minigun_fire', position, volume: 0.9, pitch: 0.94 + Math.random() * 0.12 });
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════════
 * 리플리카
 * ════════════════════════════════════════════════════════════════════════════════════════════════════ */

export function beforeHeavyReplica(_e: Enemy, _hint: number): void { /* 지상 유닛 — 기본 스냅 그대로 */ }

/** 기본 애니메이션 목표를 댐핑한 뒤: 회전 · 연사 자세, 회전음 가장자리, 그리고 `ee spray` 가 켜 둔 연사 연출. */
export function afterHeavyReplica(e: Enemy, hint: number, dt: number, host: ReplicaHost): void {
  const d = heavyData(e);
  const a = e.anim;
  const spinning = hint === HINT_SPIN || hint === HINT_FIRE;
  const wasSpinning = d.prevHint === HINT_SPIN || d.prevHint === HINT_FIRE;
  d.prevHint = hint;
  if (spinning !== wasSpinning) host.playAudio(spinning ? 'minigun_spinup' : 'minigun_spindown', e.position, 1, 1);

  if (spinning) {
    a.aim += (1 - a.aim) * Math.min(1, dt * 6);
    if (hint === HINT_FIRE) a.recoil = Math.max(a.recoil, 0.45 + Math.random() * 0.2);   // 반동 떨림
  }

  if (!d.remoteOn) return;
  d.remoteLeft -= dt;
  d.remoteHintMiss = hint === HINT_FIRE ? 0 : d.remoteHintMiss + dt;
  if (d.remoteLeft <= 0 || d.remoteHintMiss > REMOTE_HINT_MISS) { d.remoteOn = false; d.shotAcc = 0; return; }
  remoteSpray(e, d, host, dt);
}

/**
 * 리플리카가 헤비의 표적을 **방위로 추론**한다 (C-50) — 와이어에는 `ee spray {on}` 뿐이라 누구를 쏘는지 모른다.
 * 몸 방향(`e.yaw`, 스냅샷)에서 `FIRE_FACING_TOL` 안(= 호스트가 실제로 방아쇠를 당기는 콘) · `range` 안의 후보 중 가장
 * 가까운 것 — 플레이어(`targets.alive`) ∪ 적이 노리는 드론(`targets.drones`) ∪ 반대 팩션 적. 찾으면 그 가슴(`getChest`,
 * 적은 키 × 0.6 = 같은 식)을 `out` 에 적고 true. 예전에는 머리 피치(가까운 **플레이어** 쪽)로 높이를 짐작해 드론 · 벌레를
 * 쏠 때 트레이서가 허공으로 갔다.
 */
function remoteAimPoint(e: Enemy, host: ReplicaHost, out: THREE.Vector3): boolean {
  aim.px = e.position.x; aim.pz = e.position.z;
  aim.fx = Math.sin(e.yaw); aim.fz = Math.cos(e.yaw);
  aim.best = NAMED_HEAVY.range * NAMED_HEAVY.range;
  aim.found = false;
  aim.out = out;
  const targets = host.targets;
  considerTargets(targets.alive);
  considerTargets(targets.drones);
  const active = host.active;
  for (let i = 0; i < active.length; i++) {
    const o = active[i];
    if (o === e || o.faction === e.faction || !o.isCombatant) continue;
    considerAim(o.position.x, o.position.y + o.stats.height * 0.6, o.position.z);
  }
  aim.out = null;
  return aim.found;
}

/* `remoteAimPoint` 의 스크래치 — 연사 중 매 프레임 돌므로 클로저 · 배열을 만들지 않는다. */
const COS_FIRE_TOL = Math.cos(FIRE_FACING_TOL);
const aim = { px: 0, pz: 0, fx: 0, fz: 1, best: 0, found: false, out: null as THREE.Vector3 | null };

function considerTargets(list: readonly CombatTarget[]): void {
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!t.present || t.isDeadOrDowned) continue;
    t.getChest(_chest);
    considerAim(_chest.x, _chest.y, _chest.z);
  }
}

function considerAim(x: number, y: number, z: number): void {
  const dx = x - aim.px, dz = z - aim.pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= aim.best || d2 < 1e-4) return;
  if (dx * aim.fx + dz * aim.fz < COS_FIRE_TOL * Math.sqrt(d2)) return;   // 콘 밖 (뒤쪽 포함)
  aim.best = d2; aim.found = true;
  aim.out!.set(x, y, z);
}

/**
 * 리플리카 연사 연출 — 호스트와 같은 박자(`rof`, `TRACER_EVERY`). 방향은 총구 → 추론한 표적 가슴(`remoteAimPoint`) +
 * `spread`, 후보가 없으면 적 yaw 전방 + 머리 피치로 되돌아간다.
 */
function remoteSpray(e: Enemy, d: HeavyData, host: ReplicaHost, dt: number): void {
  const H = NAMED_HEAVY;
  d.shotAcc = Math.min(d.shotAcc + dt * H.rof, MAX_SHOTS_PER_FRAME);
  tickFireAudio(host.ctx, e.position, d, dt);
  if (d.shotAcc < 1) return;
  const fx = FxManager.get();
  const world = host.ctx.world;
  e.muzzle(_from);
  const aimed = !!fx && !!world && remoteAimPoint(e, host, _aimPt);
  while (d.shotAcc >= 1) {
    d.shotAcc -= 1;
    const tracer = d.shotCount % TRACER_EVERY === 0;
    d.shotCount++;
    if (!tracer || !fx || !world) continue;
    if (aimed && _dir.subVectors(_aimPt, _from).lengthSq() > 1e-4) _dir.normalize();
    // 후보가 없다: 리플리카도 가까운 플레이어를 바라보므로(`lookAtTarget`) 머리 피치가 조준 높이다: pitch = −atan(dy / dist)
    else _dir.set(Math.sin(e.yaw), Math.tan(THREE.MathUtils.clamp(-e.anim.headPitch, -0.6, 0.6)), Math.cos(e.yaw)).normalize();
    // `parts/Attacks.fireGun` 과 같은 삼각 분포 퍼짐
    const ey = (Math.random() + Math.random() - 1) * H.spread;
    const ep = (Math.random() + Math.random() - 1) * H.spread * 0.7;
    _side.set(-_dir.z, 0, _dir.x).normalize();
    _dir.addScaledVector(_side, ey);
    _dir.y += ep;
    _dir.normalize();
    const wh = world.raycast(_from, _dir, H.range);
    _to.copy(_from).addScaledVector(_dir, wh ? wh.distance : H.range);
    fx.tracers.add(_from, _to, TRACER_COLOR, 0.04, 0.06, 0);
  }
  if (fx) fx.flashes.flash(_from, FLASH_COLOR, 0, 0.75, 0.04);
}

/** `ee spray {id, on}` — 연출 상태만 켜고 끈다 (게임 상태는 바꾸지 않는다). */
export function onHeavyEvent(host: ReplicaHost, msg: Extract<EnemyEvent, { ev: 'spray' }>): void {
  const e = host.find(msg.id);
  if (!e || !e.active || e.state === 'dead' || e.type !== 'rogue_heavy') return;
  const d = heavyData(e);
  if (msg.on === 1) {
    if (!d.remoteOn) { d.shotAcc = 1; d.audioTick = 0; }
    d.remoteOn = true;
    d.remoteLeft = NAMED_HEAVY.burstTime + REMOTE_GRACE;
    d.remoteHintMiss = 0;
  } else {
    d.remoteOn = false;
    d.shotAcc = 0;
  }
}
