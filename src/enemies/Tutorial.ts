/**
 * src/enemies/Tutorial.ts — **튜토리얼 전용 적** (2026-09-14, `docs/plans/tutorial-raid.md` 의 `D` 절).
 *
 * 튜토리얼 레이드(`ctx.missionMode === 'tutorial'`)는 **고정 자리 · 고정 종류**의 적만 세운다:
 * 굴림 없음 · 웨이브 없음 · 순찰 없음 · 스포너 없음 · 지하벌레 없음 · 네임드 없음 · 레이더 강하 없음.
 * 훈련장(`sys.training`)이 전부 끄는 것과 같은 요령이고, 다른 점은 **적이 있다**는 것 하나다.
 *
 * **월드가 자리를, 여기가 몸을 갖는다** — 폴더끼리 import 하지 않으려고 그렇게 갈랐다.
 * `EnemySystem` 이 `world:ready` 에서 `ctx.world.tutorial?.enemySpawns()` 를 **한 번** 읽어 이 파일에 넘긴다.
 * 한 번 처치된 적은 체크포인트 부활로 되살아나지 않으므로 목록은 다시 읽지 않는다.
 * (`ctx.world.tutorial` 은 튜토리얼 월드를 짓는 동안 null 인 스텁이다 — 목록이 비면 적이 0 마리인 채 조용히 끝난다.)
 *
 * 한 마리에만 걸리는 값 둘 (`Enemy.senseRadius` · `Enemy.homeLeash`, 기본값은 csv 의
 * `TUTORIAL_ENEMY_SENSE_M` · `TUTORIAL_ENEMY_LEASH_M`):
 *   - `sense` — 이 반경 밖의 플레이어는 **아예 알아채지 못한다** (시야 · 소리 · 유인 · 무리 전파 전부).
 *     걸리는 자리는 `ai/Perception.senseRadiusOf` 와 `parts/Alerts` 의 반경 계산 네 곳이다.
 *   - `leash` — 자기 자리(`guardPos`)에서 이만큼 벗어나면 추격을 접고 돌아간다 (`ai/EnemyAI` 의 `homeLeash` 가지).
 * 둘 다 **0 이 기본값**이라 이 파일이 채우지 않은 적 — 본편 레이드 · 훈련장의 모든 적 — 은 한 글자도 바뀌지 않는다.
 *
 * 안드로이드의 외피 · 피 대신 불꽃 · 시체 전리품은 **본편 그대로**다 (튜토리얼에서 얻은 전리품은 진짜 보상이다).
 */
import type * as THREE from 'three';
import { TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M, type EnemyType, type TutorialEnemySpawn } from '@/shared';
import type { Enemy } from './Enemy';
import { ALL_ENEMY_TYPES, ENEMY_STATS, HUMANOID_WEAPONS, isWormType } from './EnemyTypes';
import type { RogueSpawnHost } from './RogueGuards';

/** 이번 레이드에 세운 튜토리얼 적 (디버그 · 스모크 — `EnemySystem.debugTutorial()`). */
export interface TutorialPlacement {
  /** 실제로 선 마리 수. */
  spawned: number;
  /** 선 적의 id (선 순서 = 목록 순서). */
  ids: number[];
  /** 목록에 있었지만 세우지 못한 줄 (모르는 종류 · 지하벌레 · 풀 포화). */
  skipped: number;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(ALL_ENEMY_TYPES);

/** `data/enemies.csv` 에 있는 종류면 그것, 아니면 null. 지하벌레는 자기 디렉터가 세우는 이벤트 보스라 여기서는 거절한다. */
function toEnemyType(type: string): EnemyType | null {
  if (!KNOWN_TYPES.has(type)) return null;
  const t = type as EnemyType;
  return isWormType(t) ? null : t;
}

/** 인간형이 드는 총 — 팩션 표의 첫 항목 하나로 고정한다 (튜토리얼에는 굴림이 없다). */
function weaponFor(type: EnemyType): string {
  const faction = ENEMY_STATS[type].faction;
  if (faction === 'bug') return '';
  return HUMANOID_WEAPONS[faction][0] ?? '';
}

/** csv 기본값으로 떨어지는 양수 읽기 (월드가 0 · 음수 · NaN 을 넘겨도 기본값으로 산다). */
function positive(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 월드가 준 목록 그대로 세운다 — **권한 클라이언트에서 `world:ready` 한 번**. 굴림은 하나도 없다
 * (자리 · 종류 · yaw 전부 목록의 값이고, 이 함수는 난수를 한 번도 쓰지 않는다).
 *
 * 벌레는 `spawn`, 인간형은 `spawnRogue`(자기 자리를 `guardPos` 로) 로 세워 **본편과 같은 몸 · 같은 AI** 를 쓴다.
 * 그 위에 이 마리만의 `senseRadius` · `homeLeash` 를 얹는 것이 튜토리얼이 하는 전부다.
 */
export function placeTutorialEnemies(host: RogueSpawnHost, spawns: readonly TutorialEnemySpawn[]): TutorialPlacement {
  const out: TutorialPlacement = { spawned: 0, ids: [], skipped: 0 };
  const world = host.ctx.world;
  if (!world?.ready || spawns.length === 0) {
    out.skipped = spawns.length;
    return out;
  }
  for (const s of spawns) {
    const type = toEnemyType(s.type);
    if (!type || !s.position) { out.skipped++; continue; }
    const yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
    const at = s.position.clone();
    // 발밑을 한 번 잡아 준다 (월드가 준 자리를 옮기지는 않는다 — 높이만 그 자리의 표면으로)
    at.y = world.getSurfaceY(at.x, at.z, at.y);
    const e = ENEMY_STATS[type].faction === 'bug'
      ? host.spawn(type, at, yaw, false, false)
      : host.spawnRogue(type, at, yaw, at, weaponFor(type), null, { site: null, squadId: host.allocSquadId(), role: 'member' });
    if (!e) { out.skipped++; continue; }
    applyTutorialTether(e, s);
    out.spawned++;
    out.ids.push(e.id);
  }
  return out;
}

/**
 * 그 마리에만 걸리는 감지 반경 · 이탈 거리. `guardPos` 는 **선 자리**이고 `spawnPos` 도 거기에 맞춘다
 * (리시를 벗어나 돌아온 적이 자기 자리 둘레를 서성이게 하려고). 인간형은 이미 `leash` 가 같은 뜻이라 둘 다 채운다 —
 * `ai/RogueAI` 의 부드러운 리시(보이면 조금 더 따라간다)와 `ai/EnemyAI` 의 단단한 리시(무조건 돌아간다)가 겹치면
 * 단단한 쪽이 이긴다.
 */
function applyTutorialTether(e: Enemy, s: TutorialEnemySpawn): void {
  e.senseRadius = positive(s.sense, TUTORIAL_ENEMY_SENSE_M);
  e.homeLeash = positive(s.leash, TUTORIAL_ENEMY_LEASH_M);
  e.guardPos.copy(e.position);
  e.spawnPos.copy(e.position);
  e.leash = e.homeLeash;
}

/**
 * 「자기 자리에 섰다」로 보는 거리(m). 평소 `wander` 상태가 도착으로 치는 값(벌레 0.71 · 인간형 0.78)보다 넉넉해
 * 도착 판정과 이 판정이 서로를 되돌리지 않는다. 밸런스가 아니라 **기하 허용치**라 코드에 있다
 * (`ai/RogueAI` 의 `WANDER_LEASH_MARGIN` · `ai/EnemyAI` 의 `LURE_ARRIVE` 와 같은 성격).
 */
const HOME_EPS = 1;

/**
 * 튜토리얼 적의 **자기 자리 지키기** — `ai/EnemyAI.updateEnemyAI` 가 인지 갱신 뒤 매 프레임 부른다.
 * `homeLeash === 0`(본편 · 훈련장의 모든 적)이면 **첫 줄에서 그대로 돌아간다** — 호출부가 볼 것은 그 한 줄뿐이다.
 *
 *   1. 리시 밖    — 무슨 일이 있어도 추격을 접고 자기 자리로 걸어간다 (`leashHome`).
 *   2. 리시 안에서 싸우는 중 — 평소 AI 그대로 (튜토리얼이 가르치려는 전투가 여기서 벌어진다).
 *   3. 싸움이 끝났는데 자리를 벗어나 있다 — 걸어서 돌아간다.
 *   4. 자리에 섰다 — **순찰하지 않는다.** `idle` 이 깎는 만큼 `wanderTimer` 를 도로 채워 영영 만료되지 않게 한다.
 *      그래야 위험 구역이 목록에 적힌 자리 둘레 `sense` 로 **정확히** 고정되고, 월드가 체크포인트를 그 밖에 놓을 수 있다.
 */
export function tutorialHold(e: Enemy, dt: number): void {
  if (e.homeLeash <= 0) return;
  if (e.airborne || e.chargePhase !== 0 || e.state === 'stagger') return;   // 이미 날아간 것 · 돌진 · 경직은 끝나야 끝난다
  const hx = e.position.x - e.guardPos.x, hz = e.position.z - e.guardPos.z;
  const home = hx * hx + hz * hz;
  if (home > e.homeLeash * e.homeLeash) { leashHome(e); return; }
  if (e.aware) return;
  if (e.state !== 'idle') return;                     // `wander` = 걸어서 돌아가는 중이니 그대로 둔다
  if (home > HOME_EPS * HOME_EPS) leashHome(e);
  else e.wanderTimer += dt;
}

/**
 * 추격을 접고 자기 자리로 돌려보낸다. 표적 · 인지 · 유인 · 조사 · 진행 중인 기술을 전부 접고 `wander` 로
 * `guardPos` 를 향하게 한다 — 걸음 · 애니메이션 · 충돌은 평소 상태 기계(벌레 `ai/EnemyAI` · 인간형 `ai/RogueAI`)가
 * 그대로 맡는다. 리시 밖에 있는 동안 매 프레임 `aware` 를 꺼 두므로 **리시 밖에서는 무슨 일이 있어도 다시 달려들지 않는다.**
 */
function leashHome(e: Enemy): void {
  e.aware = false;
  e.lostTimer = 0;
  e.target = null;
  e.hasLOS = false;
  e.investigating = false;
  e.hasLure = false;
  e.lureWeight = 0;
  e.suspicionTimer = 0;
  e.spitPhase = 0;
  e.spitAtPoint = false;
  e.toxicPhase = 0;
  e.roguePhase = 0;
  e.burstLeft = 0;
  e.throwTimer = 0;
  e.leaping = false;            // 호출부가 `airborne` 을 이미 걸렀다 — 아직 웅크리기만 한 도약은 여기서 접는다
  e.structAttack = false;
  e.structBlocking = false;
  e.structTarget = null;
  e.spawnPos.copy(e.guardPos);
  e.state = 'wander';
  e.stateTime = 0;
  e.wanderTimer = 0;
  e.moveTarget.copy(e.guardPos);
  e.hasMoveTarget = true;
  e.hasFacePoint = false;
}
