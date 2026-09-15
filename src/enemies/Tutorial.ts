/**
 * src/enemies/Tutorial.ts — **튜토리얼 전용 적** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」 의 `D` 절).
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
 * 안드로이드의 외피 · 피 대신 불꽃은 **본편 그대로**다.
 *
 * ── 2026-09-14 3차 (`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」) ───────────────────────────────────
 * 1. **전용 적 타입 4종.** 월드 목록이 `tut_bug_loot` · `tut_bug` · `tut_android_loot` · `tut_android` 를 쓴다.
 *    수치는 `data/enemies.csv` 의 자기 줄(안드로이드는 체력 절반)이고, 리그 · AI · 소리는 바탕 종류
 *    (`EnemyTypes.baseTypeOf`)의 것이며, 다른 것은 **고정 드롭**뿐이다 — `_loot` 둘만 100 % 로 정해진 물건을
 *    떨구고 나머지 둘은 빈 시체다 (`data/loot_corpses.csv` · `loot_corpse_rolls.csv` · `CORPSE_LOOT_CHANCE`).
 *    튜토리얼은 굴림이 없으므로 가르치려는 물건만 정확히 나온다.
 * 2. **벌레는 땅에서 솟는다.** 벌레 줄은 `world:ready` 에 세우지 않고 `TutorialPlacement.ambush` 에 담아 두었다가
 *    플레이어가 그 마리의 감지 반경에 들어서면 굴착 스폰으로 꺼낸다 (`updateTutorialAmbush`).
 */
import type * as THREE from 'three';
import { BURROW_EMERGE_S, TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M, type EnemyType, type TutorialEnemySpawn } from '@/shared';
/* appended (2026-09-15): 벌레 연쇄 스폰 · 구간 어그로 해제 · 이륙 사격 창 */
import {
  TUTORIAL_AGGRO_DROP_M, TUTORIAL_BUG_CHAIN_SPAWN_S, TUTORIAL_CHECKPOINTS, TUTORIAL_LIFTOFF_FIRE_RANGE_M, TUTORIAL_LIFTOFF_FIRE_S,
  type TutorialCheckpointId, type TutorialFallRule,
} from '@/shared';
import type { Enemy } from './Enemy';
import { ALL_ENEMY_TYPES, ENEMY_STATS, HUMANOID_WEAPONS, isWormType } from './EnemyTypes';
import type { RogueSpawnHost } from './RogueGuards';

/** 이번 레이드에 세운 튜토리얼 적 (디버그 · 스모크 — `EnemySystem.debugTutorial()`). */
export interface TutorialPlacement {
  /** 실제로 선 마리 수 (땅에서 솟은 벌레도 솟은 뒤에는 여기 센다). */
  spawned: number;
  /** 선 적의 id (선 순서 = 목록 순서, 나중에 솟은 벌레는 뒤에 붙는다). */
  ids: number[];
  /** 목록에 있었지만 세우지 못한 줄 (모르는 종류 · 지하벌레 · 풀 포화). */
  skipped: number;
  /** 아직 땅속에 있는 벌레 (2026-09-14 3차 — `updateTutorialAmbush` 가 하나씩 꺼낸다). */
  ambush: TutorialAmbush[];
  /* ── 2026-09-15 (사용자 결정) ── */
  /** 벌레 연쇄 스폰: 다음 벌레까지 남은 초. **-1 = 연쇄 없음** (첫 벌레가 솟는 순간 `TUTORIAL_BUG_CHAIN_SPAWN_S` 로 선다). */
  chainTimer: number;
  /** 연쇄의 기준점 — 마지막으로 솟은 벌레의 자리 (다음 벌레 = 그 자리에서 가장 가까운 매복). */
  chainX: number;
  chainZ: number;
  /** 이륙 사격 창 남은 초 (-1 = 없음, `onTutorialLiftoff`). */
  liftoffFireT: number;
  /** 이륙 사격 창 동안 감지 반경을 넓혀 준 적 id → 원래 반경 (창이 끝나면 되돌린다). */
  liftoffSense: Map<number, number>;
}

/** `updateTutorialScript` · 체크포인트 · 이륙 훅이 쓰는 호스트 — 적 목록을 훑어야 해서 `RogueSpawnHost` 에 `active` 하나를 더한다. */
export interface TutorialScriptHost extends RogueSpawnHost {
  readonly active: readonly Enemy[];
}

/**
 * 2026-09-14 3차 — **땅속에서 기다리는 벌레 한 마리**.
 *
 * 튜토리얼 벌레는 처음부터 서 있지 않고 플레이어가 다가오면 구덩이에서 솟는다 (`docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 * 새 개념을 만들지 않았다 — 이미 있는 **버그 굴착 스폰**(2026-09-13: `Pool.spawn(…, emerge)` → `Enemy.startEmerge` +
 * `parts/Burrow.emergeFx` + `ee spawn.em`)을 그대로 부른다. 솟는 1 초 동안 맞기는 하지만 공격 · 이동하지 않는 것도 그 규칙 그대로다.
 *
 * **좌표는 여기 없다.** 벌레는 목록이 적어 준 **자기 자리**에서 솟고, 방아쇠는 그 마리의 **자기 감지 반경**
 * (`TutorialEnemySpawn.sense`, 기본 `TUTORIAL_ENEMY_SENSE_M`)이다 — 월드가 벌레를 옮겨도 · 구간을 늘려도
 * 이 파일은 한 글자도 안 바뀐다. 체크포인트가 그 반경 **밖**에 놓여 있다는 월드의 규약이 곧 "부활 자리에서는
 * 아직 솟지 않았다" 는 뜻이기도 하다.
 */
export interface TutorialAmbush {
  readonly spawn: TutorialEnemySpawn;
  readonly type: EnemyType;
  /** 솟을 자리 (목록의 값 그대로 — 발밑은 솟는 순간 잡는다). */
  readonly at: THREE.Vector3;
  readonly yaw: number;
  /** 이 거리 안에 플레이어가 들어오면 솟는다 (그 마리의 감지 반경). */
  readonly sense: number;
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
  const out: TutorialPlacement = {
    spawned: 0, ids: [], skipped: 0, ambush: [],
    chainTimer: -1, chainX: 0, chainZ: 0, liftoffFireT: -1, liftoffSense: new Map(),
  };
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
    /* 2026-09-14 3차: **벌레는 아직 세우지 않는다.** 땅속에서 기다렸다가 플레이어가 감지 반경에 들어서면 솟는다
       (`updateTutorialAmbush`). 인간형은 예전처럼 그 자리에 선다 — 엄폐물 뒤 · 앉아쏴가 그림의 절반이라 숨길 이유가 없다. */
    if (ENEMY_STATS[type].faction === 'bug') {
      out.ambush.push({ spawn: s, type, at, yaw, sense: positive(s.sense, TUTORIAL_ENEMY_SENSE_M) });
      continue;
    }
    const e = host.spawnRogue(type, at, yaw, at, weaponFor(type), null, { site: null, squadId: host.allocSquadId(), role: 'member' });
    if (!e) { out.skipped++; continue; }
    applyTutorialTether(e, s);
    out.spawned++;
    out.ids.push(e.id);
  }
  return out;
}

/**
 * 2026-09-14 3차 — **땅속 벌레를 꺼낸다.** 권한 클라이언트가 게임플레이 프레임마다 부른다
 * (`EnemySystem.update`; 튜토리얼이 아니거나 남은 것이 없으면 첫 줄에서 돌아간다).
 *
 * 플레이어(로컬 몸)가 그 마리의 감지 반경 안에 들어오면 **그 자리에서** `BURROW_EMERGE_S` 동안 솟으면서
 * 곧장 쫓기 시작한다 (`chase`) — 솟는 동안은 공격 · 이동이 없다는 것이 `ai/Burrow` 의 규칙이라, "튀어나오고 → 달려든다"
 * 가 저절로 된다. 굴착 연출 · 흔들림 · 소리 · `ee spawn.em` 은 전부 `Pool.spawn` 안에서 본편과 같은 코드가 낸다.
 *
 * 세로 거리는 보지 않는다 — 튜토리얼 통로는 한 층이고, 데크가 갈리는 곳은 구간 자체가 멀다.
 *
 * ── 2026-09-15 (사용자 결정 — 「두 번째 벌레는 첫 벌레가 솟고 **정확히 1초 뒤**」) ──
 * 접근이 방아쇠인 것은 **첫 마리뿐**이다. 첫 마리가 솟는 순간 연쇄 시계(`chainTimer` = `TUTORIAL_BUG_CHAIN_SPAWN_S`)가 서고,
 * 그 뒤로는 남은 매복이 **시계만 따라** 하나씩 솟는다 (다음 = 방금 솟은 자리에서 가장 가까운 매복). 연쇄가 도는 동안
 * 접근은 보지 않는다 — 봤다면 두 번째 벌레 곁으로 뛰어든 사람에게는 1초보다 일찍 솟는다.
 * 플레이어가 그 구간을 지나쳐 버리면(`crawl` 체크포인트) 남은 매복과 시계를 함께 버린다 (`onTutorialCheckpoint`).
 * `dt` 는 게임플레이 프레임의 시뮬레이션 시간이다 (생략 = 0 — 시계가 서지 않는다, 옛 호출부 호환).
 */
export function updateTutorialAmbush(host: RogueSpawnHost, placement: TutorialPlacement | null, dt = 0): void {
  const list = placement?.ambush;
  if (!placement || !list) return;
  if (list.length === 0) { placement.chainTimer = -1; return; }
  const ctx = host.ctx;
  if (!ctx.world?.ready) return;
  if (placement.chainTimer >= 0) {
    placement.chainTimer -= Math.max(0, dt);
    if (placement.chainTimer > 0) return;
    const next = list.splice(nearestAmbush(list, placement.chainX, placement.chainZ), 1)[0];
    emergeAmbush(host, placement, next);
    placement.chainTimer = list.length > 0 ? chainDelay() : -1;
    return;
  }
  const p = ctx.player?.position;
  if (!p) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    const dx = p.x - a.at.x, dz = p.z - a.at.z;
    if (dx * dx + dz * dz > a.sense * a.sense) continue;
    list.splice(i, 1);
    emergeAmbush(host, placement, a);
    // 나머지는 연쇄 시계가 꺼낸다 — 한 프레임에 여럿을 꺼내지 않는다
    if (list.length > 0) placement.chainTimer = chainDelay();
    return;
  }
}

/** 매복 한 마리를 그 자리에서 굴착 스폰으로 꺼낸다 (연쇄의 기준점도 여기로 옮긴다). */
function emergeAmbush(host: RogueSpawnHost, placement: TutorialPlacement, a: TutorialAmbush): void {
  placement.chainX = a.at.x;
  placement.chainZ = a.at.z;
  const e = host.spawn(a.type, a.at, a.yaw, true, false, BURROW_EMERGE_S);
  if (!e) { placement.skipped++; return; }
  applyTutorialTether(e, a.spawn);
  placement.spawned++;
  placement.ids.push(e.id);
}

/** 연쇄 간격 (csv). 0 도 받는다 (= 다음 프레임), 음수 · NaN 이면 1 초. */
function chainDelay(): number {
  return Number.isFinite(TUTORIAL_BUG_CHAIN_SPAWN_S) && TUTORIAL_BUG_CHAIN_SPAWN_S >= 0 ? TUTORIAL_BUG_CHAIN_SPAWN_S : 1;
}

function nearestAmbush(list: readonly TutorialAmbush[], x: number, z: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].at.x - x, dz = list[i].at.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * 2026-09-15 — 튜토리얼 적의 **프레임 틱 전부** (`EnemySystem.update` 의 권한 · 게임플레이 가지가 부른다):
 * 매복 · 연쇄 스폰(`updateTutorialAmbush`)과 이륙 사격 창(`onTutorialLiftoff`).
 */
export function updateTutorialScript(host: TutorialScriptHost, placement: TutorialPlacement | null, dt: number): void {
  if (!placement) return;
  updateTutorialAmbush(host, placement, dt);
  updateLiftoffFire(host, placement, dt);
}

/* ═══════════════ 구간 어그로 해제 (2026-09-15, 사용자 결정) ═══════════════════════════════════════════════
 * 튜토리얼은 구간마다 **건너뛸 수 있어야** 한다 — 싸우지 않고 지나간 사람을 뒤 구간의 적이 끝까지 쫓으면 안 된다.
 *   ① 벌레 구간: 플레이어가 `crawl`(낮은 천장 구조물 입구) 체크포인트에 닿으면 **벌레 전부**가 추격을 접는다.
 *      아직 땅속에 있는 매복 · 연쇄 시계도 그 자리에서 버린다 (지나간 뒤에 뒤에서 솟지 않는다).
 *   ② 첫 안드로이드 둘: 플레이어가 **절벽에서 떨어지면**(`player:fell` — 즉사 규칙이 아닌 착지, `drop` 체크포인트 이후)
 *      또는 `supply` 체크포인트에 닿으면, 플레이어의 발보다 `TUTORIAL_AGGRO_DROP_M` 넘게 **위에** 자리를 둔 인간형이
 *      추격 · 사격을 접는다 — 좌표를 적지 않고 「절벽 위에 남은 적」을 고른다 (무너진 벽 뒤 · 함선 곁의 적은 같은 데크라 남는다).
 * 체크포인트는 앞으로만 가므로(`TutorialWorld.setIndex`) 「그 순서 이상」으로 판정한다 — 이어하기의 `gotoCheckpoint` 도 같은 길이다.
 * 해제된 적은 `Enemy.tutorialReleased` 가 서고, `tutorialHold` 가 매 프레임 자기 자리로 돌려보낸다 (다시 달려들지 않는다).
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** 해제된 적의 감지 반경(m) — 0 은 「평소 표」라는 뜻이라 쓸 수 없다. 기하 허용치(사실상 아무것도 못 알아챈다)라 코드에 둔다. */
const RELEASED_SENSE_M = 0.01;

/** `tutorial:checkpoint` (권한). */
export function onTutorialCheckpoint(host: TutorialScriptHost, placement: TutorialPlacement | null, id: TutorialCheckpointId): void {
  if (!placement) return;
  const idx = TUTORIAL_CHECKPOINTS.indexOf(id);
  if (idx < 0) return;
  if (idx >= TUTORIAL_CHECKPOINTS.indexOf('crawl')) releaseBugs(host, placement);
  if (idx >= TUTORIAL_CHECKPOINTS.indexOf('supply')) releaseAbovePlayer(host);
}

/** `player:fell` (권한) — 절벽 2 낙하. 즉사 규칙(절벽 1 협곡 · 바닥 없는 낭떠러지)은 해제 사유가 아니다: 곧 되살아나 다시 올라온다. */
export function onTutorialFell(host: TutorialScriptHost, placement: TutorialPlacement | null, rule: TutorialFallRule): void {
  if (!placement || rule === 'kill') return;
  const player = host.ctx.player;
  if (!player || player.isDead) return;
  const cp = host.ctx.world?.tutorial?.checkpoint;
  if (!cp || TUTORIAL_CHECKPOINTS.indexOf(cp) < TUTORIAL_CHECKPOINTS.indexOf('drop')) return;
  releaseAbovePlayer(host);
}

function releaseBugs(host: TutorialScriptHost, placement: TutorialPlacement): void {
  const left = placement.ambush.filter((a) => ENEMY_STATS[a.type].faction !== 'bug');
  if (left.length !== placement.ambush.length) {
    placement.ambush = left;
    placement.chainTimer = -1;
  }
  for (const e of host.active) if (e.homeLeash > 0 && e.isCombatant && !e.isHumanoid) releaseEnemy(e);
}

function releaseAbovePlayer(host: TutorialScriptHost): void {
  const p = host.ctx.player?.position;
  if (!p) return;
  const margin = Number.isFinite(TUTORIAL_AGGRO_DROP_M) ? Math.max(0, TUTORIAL_AGGRO_DROP_M) : 3;
  for (const e of host.active) {
    if (e.homeLeash <= 0 || !e.isCombatant || !e.isHumanoid) continue;
    if (e.guardPos.y > p.y + margin) releaseEnemy(e);
  }
}

function releaseEnemy(e: Enemy): void {
  if (e.tutorialReleased) return;
  e.tutorialReleased = true;
  e.senseRadius = RELEASED_SENSE_M;
  if (!e.airborne && e.chargePhase === 0 && e.state !== 'stagger') leashHome(e);
}

/* ═══════════════ 이륙 사격 창 (2026-09-15, 사용자 결정 — 「실제 피해 · 죽지 않음」) ═════════════════════════
 * 스위치를 눌러 곧장 뜬 튜토리얼 함선의 탑승자를, 처치하지 않은 인간형 적이 **실제로** 쏜다 (피해는 들어가고 체력은 1 에서
 * 멈춘다 — `PlayerRef.setSceneLock(true, {allowDamage})`, extraction 이 건다). 그런데 튜토리얼 적의 감지 반경은 12 m 라
 * 오르는 함선을 금세 놓치고, 이륙하는 순간 한가운데 있던 몸을 새로 알아채지도 못한다. 그래서 `TUTORIAL_LIFTOFF_FIRE_S` 동안만
 * `TUTORIAL_LIFTOFF_FIRE_RANGE_M` 안의 (해제되지 않은) 인간형이 탑승자를 표적으로 잡고 감지 반경을 그 거리까지 넓힌다.
 * 사격 자체는 평소 AI(`ai/RogueAI` → `ai/FireLine` → `parts/Attacks.fireGun`)가 한다 — 여기서 총을 쏘지 않는다.
 * 창이 끝나거나 탑승자가 없어지면(건너뛰기 · 리셋) 넓혀 준 반경을 되돌린다.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** `extraction:liftoff` (권한, 튜토리얼). */
export function onTutorialLiftoff(placement: TutorialPlacement | null): void {
  if (!placement) return;
  placement.liftoffFireT = Number.isFinite(TUTORIAL_LIFTOFF_FIRE_S) ? Math.max(0, TUTORIAL_LIFTOFF_FIRE_S) : 0;
}

function updateLiftoffFire(host: TutorialScriptHost, placement: TutorialPlacement, dt: number): void {
  if (placement.liftoffFireT < 0) return;
  placement.liftoffFireT -= Math.max(0, dt);
  const ctx = host.ctx;
  const target = host.targets.local();
  const riding = ctx.extraction?.riding === true;
  if (placement.liftoffFireT <= 0 || !riding || !target || target.isDeadOrDowned) {
    endLiftoffFire(host, placement);
    return;
  }
  const range = Number.isFinite(TUTORIAL_LIFTOFF_FIRE_RANGE_M) ? Math.max(0, TUTORIAL_LIFTOFF_FIRE_RANGE_M) : 0;
  const r2 = range * range;
  for (const e of host.active) {
    if (e.homeLeash <= 0 || e.tutorialReleased || !e.isHumanoid || !e.isCombatant) continue;
    if (e.position.distanceToSquared(target.position) > r2) continue;
    if (!placement.liftoffSense.has(e.id)) {
      placement.liftoffSense.set(e.id, e.senseRadius);
      e.senseRadius = Math.max(e.senseRadius, range);
    }
    if (e.target !== target) { e.target = target; e.hasLOS = false; e.perceptionTimer = 0; }
    if (!e.aware) {
      e.aware = true;
      e.lostTimer = 0;
      e.investigating = false;
      if (e.state === 'idle' || e.state === 'wander') { e.state = 'alert'; e.stateTime = 0; e.hasMoveTarget = false; }
    }
  }
}

function endLiftoffFire(host: TutorialScriptHost, placement: TutorialPlacement): void {
  placement.liftoffFireT = -1;
  if (placement.liftoffSense.size === 0) return;
  for (const e of host.active) {
    const prev = placement.liftoffSense.get(e.id);
    if (prev !== undefined && e.homeLeash > 0) e.senseRadius = e.tutorialReleased ? RELEASED_SENSE_M : prev;
  }
  placement.liftoffSense.clear();
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
  /*
   * 2026-09-15 — **어그로를 내려놓은 적** (`onTutorialCheckpoint` · `onTutorialFell`). 리시 안이든 밖이든 싸우지 않는다:
   * 알아챘거나(맞아서 · 소리) 조사 · 추격 · 공격 중이면 그 자리에서 접고 걸어 돌아가고, 자리에 섰으면 순찰도 하지 않는다.
   * 감지 반경이 `RELEASED_SENSE_M` 라 새로 알아채는 일도 사실상 없다 — 여기는 맞아서 깨어난 경우의 보험이다.
   */
  if (e.tutorialReleased) {
    if (e.aware || e.investigating || e.target !== null || (e.state !== 'idle' && e.state !== 'wander')) { leashHome(e); return; }
    if (e.state === 'idle') {
      if (home > HOME_EPS * HOME_EPS) leashHome(e);
      else e.wanderTimer += dt;
    }
    return;
  }
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
