/**
 * src/enemies/ai/ArtilleryPack.ts — **포병의 호위 · 사격 조건 · 제 부대 재소환** (2026-09-17 · 2026-09-18 사용자 결정).
 *
 * 이 파일이 답하는 질문: *포병 곁에는 누가 붙어 다니고, 포병은 언제 쏘며, 언제 무리를 불러내나.*
 *
 * - **호위**: 포병이 굴착 스폰될 때(`Spawner.maybeArtillery`) 스캐빈저 `ARTILLERY_AI.escortMin`–`escortMax` 마리가 함께 파고 나온다
 *   (`spawnArtilleryEscort`). 호위는 `Enemy.escortOf` = 그 포병이고, **표적을 스스로 알아채기 전까지**(`aware` false) 포병 곁을
 *   지킨다 — 거닐 자리의 중심(`spawnPos`)이 포병을 따라가고, `escortFollowDist` 보다 멀어지면 뛰어 돌아온다(`escortFollow`).
 *   알아채면 평범한 스캐빈저처럼 표적에게 달려든다. 포병이 죽으면 `escortOf` 를 놓고 그냥 벌레가 된다.
 * - **사격 조건**: 표적 둘레 `supportRadius` 안에 포병이 아닌 벌레(살아 싸우는 팩션 bug)가 하나라도 있어야 쏜다(`hasBugSupport`).
 *   외톨이 표적은 사거리 안이어도 쏘지 않는다.
 * - **제 부대**(2026-09-18 사용자 결정 — 「그것과 별개로 따로 자기 부대 스캐빈저를 소환. 스캐빈저들이 모두 죽으면 쿨타임 이후 재스폰」):
 *   포병에게 딸린 스캐빈저(굴착 호위 + 소환 무리 = `escortOf` 가 이 포병인 몸)가 **한 마리도 남지 않으면**
 *   `ARTILLERY_AI.squadCooldown` 을 재고, 그 뒤 `summonMin`–`summonMax` 마리를 제 둘레에서 파낸다(`maybeSummon`).
 *   예전의 「평생 한 번」 제한은 없어졌다 — 부대가 죽는 한 계속 채운다. 사거리 안에 사람 표적이 있으면 그 표적에게 보내고
 *   (`relentless`, 그 표적이 쓰러질 때까지 바꾸지 않는다), 없으면 굴착 호위처럼 포병 곁을 지킨다. 종류는 `scavenger_summon`
 *   (드롭 0 % · `raidXp` 0) 이라 반복 소환이 파밍이 되지 않는다.
 *
 * 모든 결정 · 스폰은 권위(호스트 · 싱글)의 AI 틱에서만 일어나고, 리플리카는 `ee spawn` 으로 결과만 본다.
 * 호위 연결(`escortOf`)은 와이어에 없다 — 호스트가 바뀌면 `EnemySystem.promote` 가 풀어 평범한 벌레가 된다 (의도).
 */
import * as THREE from 'three';
import { BURROW_EMERGE_S, type EnemyType, type GameContext } from '@/shared';
import type { Enemy } from '../Enemy';
import { ARTILLERY_AI } from '../EnemyTypes';
import type { CombatTarget } from '../Targets';

/** 호위로 함께 파고 나오는 종류 (사용자 결정: 스캐빈저). */
const ESCORT_TYPE: EnemyType = 'scavenger';
/** 소환 무리 종류 — 드롭 0 % · `raidXp` 0 전용 줄 (`data/enemies.csv`). */
const SUMMON_TYPE: EnemyType = 'scavenger_summon';
const TWO_PI = Math.PI * 2;
/** 무리 한 마리 자리를 다시 뽑는 횟수 (경계 밖이면 다시). 알고리즘 상수. */
const PLACE_TRIES = 4;

const _p = new THREE.Vector3();

/** `SpawnHost` 와 `EnemyHost` 가 둘 다 만족하는 최소 모양. */
export interface PackSpawnHost {
  readonly ctx: GameContext;
  spawn(type: EnemyType, position: THREE.Vector3, yaw: number, chase: boolean, relentless: boolean, emerge?: number): Enemy | null;
}

/** `EnemyHost` 중 사격 조건이 읽는 것. */
export interface PackQueryHost {
  readonly active: readonly Enemy[];
}

/** [min, max] 정수 균등 (csv 가 소수를 적어도 반올림, 뒤집혀 있으면 min). */
function rollCount(min: number, max: number): number {
  const lo = Math.max(0, Math.round(Number.isFinite(min) ? min : 0));
  const hi = Math.max(lo, Math.round(Number.isFinite(max) ? max : lo));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** `center` 둘레 `packRingMin`–`packRingMax` m 의 땅 위 한 자리 → `_p`. 끝내 경계 밖이면 false. */
function placeAround(ctx: GameContext, center: THREE.Vector3, i: number, n: number): boolean {
  const world = ctx.world;
  if (!world) return false;
  const lo = Math.max(0, ARTILLERY_AI.packRingMin);
  const hi = Math.max(lo, ARTILLERY_AI.packRingMax);
  for (let a = 0; a < PLACE_TRIES; a++) {
    const ang = (i / Math.max(1, n)) * TWO_PI + Math.random() * 0.8 + a * 1.3;
    const rad = lo + Math.random() * (hi - lo);
    _p.set(center.x + Math.cos(ang) * rad, 0, center.z + Math.sin(ang) * rad);
    if (!world.isInsideBounds(_p.x, _p.z)) continue;
    world.resolveCollision(_p, 1.2);          // `Spawner.placeMember` 와 같은 요령 — 바위 속이면 밀어낸다
    _p.y = world.getHeightAt(_p.x, _p.z);
    return true;
  }
  return false;
}

/**
 * 막 파고 나오기 시작한 포병 `arty` 곁에 호위 스캐빈저를 세운다 (권위 전용 — 스폰 경로가 부른다). 호위는 표적을 모르는 채로
 * 포병과 같은 굴착 시간 동안 올라온다. 돌려주는 값 = 세운 수.
 */
export function spawnArtilleryEscort(host: PackSpawnHost, arty: Enemy): number {
  const n = rollCount(ARTILLERY_AI.escortMin, ARTILLERY_AI.escortMax);
  let made = 0;
  for (let i = 0; i < n; i++) {
    if (!placeAround(host.ctx, arty.position, i, n)) continue;
    const e = host.spawn(ESCORT_TYPE, _p, arty.yaw + (Math.random() - 0.5) * 0.8, false, false, BURROW_EMERGE_S);
    if (!e) continue;
    e.escortOf = arty;
    e.spawnPos.copy(arty.position);
    made++;
  }
  return made;
}

/**
 * 호위의 한 틱 (`ai/EnemyAI` 가 벌레 상태 기계 바로 앞에서 부른다). 표적을 알아챈 호위 · 호위가 아닌 벌레는 아무것도 하지 않는다.
 * true = 포병에게서 너무 멀다 — 이번 틱은 `wander` 로 포병 곁까지 **뛰어** 간다(호출자가 추격 속도를 쓴다).
 */
export function escortFollow(e: Enemy): boolean {
  const lead = e.escortOf;
  if (!lead) return false;
  if (!lead.active || lead.state === 'dead') { e.escortOf = null; return false; }   // 포병이 죽었다 → 그냥 벌레
  if (e.aware) return false;                                                         // 교전 중 — 평범한 벌레처럼 달려든다
  e.spawnPos.copy(lead.position);
  if (e.state !== 'idle' && e.state !== 'wander') return false;
  const dx = e.position.x - lead.position.x, dz = e.position.z - lead.position.z;
  const d = Math.hypot(dx, dz);
  if (d <= ARTILLERY_AI.escortFollowDist) return false;
  const back = Math.max(0, ARTILLERY_AI.packRingMin);
  e.state = 'wander'; e.stateTime = 0;   // 거닐기 7 s 제한에 잘리지 않게 매 틱 새로 시작한다
  e.moveTarget.set(lead.position.x + (dx / d) * back, 0, lead.position.z + (dz / d) * back);
  return true;
}

/** 호위가 제자리에서 거닐 자리를 뽑을 때의 반경 상한 (m) — 포병 곁을 떠나 거닐다 끌려오기를 되풀이하지 않게. 호위가 아니면 `rad` 그대로. */
export function escortWanderRadius(e: Enemy, rad: number): number {
  return e.escortOf ? Math.min(rad, Math.max(0, ARTILLERY_AI.escortFollowDist)) : rad;
}

/** 표적 `t` 둘레 `supportRadius` 안에 포병이 아닌 살아 싸우는 벌레가 있나 (포병의 사격 조건). */
export function hasBugSupport(arty: Enemy, host: PackQueryHost, t: CombatTarget): boolean {
  const r = ARTILLERY_AI.supportRadius;
  const r2 = r * r;
  const tx = t.position.x, tz = t.position.z;
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    /* 2026-09-18 (벌레 알): 알은 「곁의 벌레」가 아니다 — 움직이지도 싸우지도 않으므로 둥지 옆에 선 표적에게 포격을 열어 주면 안 된다.
       `isCombatant` 가 이미 false 라 앞 검사에서 빠지지만, **이 조건이 곧 규칙**이라 눈에 보이게 적어 둔다. */
    if (o === arty || o.isEgg || !o.isCombatant || o.faction !== 'bug' || o.type === 'artillery') continue;
    if (t.enemy === o) continue;
    const dx = o.position.x - tx, dz = o.position.z - tz;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

/** 사람 · 안드로이드 분대원 표적 (다른 팩션 적 · 드론 · 차량은 소환 대상이 아니다). */
function isPersonTarget(t: CombatTarget): boolean {
  return !t.isEnemy && !t.isDrone && !t.isVehicle;
}

/** 이 포병에게 딸린 스캐빈저(굴착 호위 + 소환 무리) 중 살아 싸우는 몸이 하나라도 있나. */
export function hasLivingSquad(arty: Enemy, host: PackQueryHost): boolean {
  const list = host.active;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.escortOf === arty && o.isCombatant) return true;
  }
  return false;
}

/**
 * **제 부대 재소환** (2026-09-18 사용자 결정, `GimmickAI.chaseArtillery` 가 추격 틱마다 부른다 — 권위 전용).
 *
 * 포병에게 딸린 스캐빈저가 **전멸**하면 `ARTILLERY_AI.squadCooldown` 을 재고, 다 되면 `summonMin`–`summonMax` 마리를 제
 * 둘레에서 파낸다. 한 마리라도 살아 있으면 쿨타임 시계가 다시 0 으로 돌아간다 (「모두 죽으면 쿨타임 이후」).
 * 사람 · 안드로이드 표적이 사거리 안이면 그 표적에게 보내고(`relentless` + 표적 고정), 아니면 굴착 호위처럼 곁에 둔다.
 * 검사 주기는 호위 · 사격 조건과 같은 `supportCheckS` 다 (프레임마다 활성 목록을 훑지 않는다).
 */
export function maybeSummon(e: Enemy, dt: number, host: PackSpawnHost & PackQueryHost, t: CombatTarget | null): void {
  if (e.squadCd > 0) e.squadCd = Math.max(0, e.squadCd - dt);
  e.supportCheckT -= dt;
  if (e.supportCheckT > 0) return;
  e.supportCheckT = ARTILLERY_AI.supportCheckS;
  if (hasLivingSquad(e, host)) { e.squadCd = ARTILLERY_AI.squadCooldown; return; }
  if (e.squadCd > 0) return;
  // 표적이 있고 사거리 안이면 그 표적에게 보낸다 (없으면 굴착 호위와 같은 「곁을 지키는」 무리)
  const send = t && !t.isDeadOrDowned && isPersonTarget(t) && e.distToTarget <= ARTILLERY_AI.maxRange ? t : null;
  const n = rollCount(ARTILLERY_AI.summonMin, ARTILLERY_AI.summonMax);
  for (let i = 0; i < n; i++) {
    if (!placeAround(host.ctx, e.position, i, n)) continue;
    const yaw = send ? Math.atan2(send.position.x - _p.x, send.position.z - _p.z) : e.yaw + (Math.random() - 0.5) * 0.8;
    const s = host.spawn(SUMMON_TYPE, _p, yaw, send !== null, send !== null, BURROW_EMERGE_S);
    if (!s) continue;
    // 부대 장부는 굴착 호위와 같다 (`escortOf`) — 다음 검사의 「전멸했나」가 이것을 센다
    s.escortOf = e;
    s.spawnPos.copy(e.position);
    if (!send) continue;
    // 그 표적에게 보낸다 — 표적이 쓰러지거나 사라질 때까지 바꾸지 않는다 (`acquireTarget` 은 표적이 무효일 때만 다시 고른다)
    s.target = send;
    s.targetTimer = Number.POSITIVE_INFINITY;
    s.distToTarget = send.dist2D(s.position);
  }
  // 한 마리도 못 세웠어도(자리 없음 · 풀 포화) 쿨타임을 걸어 매 검사마다 다시 시도하지 않는다
  e.squadCd = ARTILLERY_AI.squadCooldown;
}
