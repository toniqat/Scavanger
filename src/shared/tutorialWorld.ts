/* ────────────────────────────────────────────────────────────────────────────
 * 튜토리얼 월드 질의 (2026-09-14, `docs/plans/tutorial-raid.md`).
 * Owner: `world/tutorial/` — `ctx.world.tutorial` 로 게시한다 (`ctx.world.training` 과 같은 자리 · 같은 규약).
 *
 * 이 파일이 답하는 질문: *튜토리얼 행성에서만 다른 것은 무엇인가.*
 *
 *   1. **체크포인트** — 튜토리얼에는 레이드 실패가 없다. 죽으면 시체는 평소대로 서고(장비도 그 안에 남는다)
 *      마지막으로 지난 체크포인트에서 다시 선다. 그 자리를 아는 곳은 맵을 지은 `world/tutorial/` 하나뿐이라
 *      `game/parts/Death` 가 여기에 묻는다.
 *   2. **낙하 규칙** — 절벽 1 은 즉사(`kill`), 절벽 2 는 반드시 살아남아야 하므로 체력 1 클램프(`clamp`).
 *      나머지는 전역 낙하 피해 그대로(`normal`). 규칙이 자리마다 다르므로 `player/` 가 착지할 때 묻는다.
 *
 * 튜토리얼 월드가 아니면 `ctx.world.tutorial` 이 null 이고, 호출부는 `?? 'normal'` 로 이어 쓴다 —
 * 본편 동작은 한 글자도 바뀌지 않는다.
 * ──────────────────────────────────────────────────────────────────────────── */
import type * as THREE from 'three';

/**
 * 체크포인트 — 지나는 순서대로. 죽으면 **마지막으로 지난 곳**에서 다시 선다.
 * 이름은 그 구간이 가르치는 것이다: `wake`(기상) · `cliff`(달려서 점프) · `corpse`(시체 루팅) ·
 * `bugs`(사격) · `crawl`(앉아 이동) · `android`(앉아 정조준) · `drop`(낙하) · `supply`(회복 · 수류탄) ·
 * `wall`(무너진 벽 너머) · `ship`(버려진 함선).
 *
 * 배치 규칙: **각 체크포인트는 그 구간 적의 감지 범위 밖에 둔다** — 무기를 잃은 채 부활한 사람이
 * 자기 시체를 주우러 갈 수 있어야 한다.
 */
export type TutorialCheckpointId =
  | 'wake' | 'cliff' | 'corpse' | 'bugs' | 'crawl' | 'android' | 'drop' | 'supply' | 'wall' | 'ship';

export const TUTORIAL_CHECKPOINTS: readonly TutorialCheckpointId[] = [
  'wake', 'cliff', 'corpse', 'bugs', 'crawl', 'android', 'drop', 'supply', 'wall', 'ship',
];

/**
 * 떨어졌을 때의 규칙.
 *   `normal` = 전역 낙하 피해 그대로 (실드 → 체력, 죽을 수 있다)
 *   `kill`   = 즉사 (절벽 1 — 넘지 못하면 떨어져 체크포인트로 돌아간다)
 *   `clamp`  = 피해는 들어가되 체력이 1 밑으로 내려가지 않는다 (절벽 2 — 반드시 살아서 착지한다)
 */
export type TutorialFallRule = 'normal' | 'kill' | 'clamp';

/**
 * 튜토리얼 적 한 마리의 자리 — **월드가 정하고 enemies 가 세운다**. 굴림도 웨이브도 순찰도 없다.
 * `type` 은 `data/enemies.csv` 의 적 타입 id 이고, `sense` · `leash` 는 그 마리에만 걸리는 좁은 값이다
 * (기본은 `TUTORIAL_ENEMY_SENSE_M` · `TUTORIAL_ENEMY_LEASH_M`).
 */
export interface TutorialEnemySpawn {
  type: string;
  position: THREE.Vector3;
  yaw: number;
  /** 감지 반경 (m). 이 구간의 체크포인트보다 짧아야 한다. */
  sense: number;
  /** 자기 자리에서 이만큼 벗어나면 돌아간다 (m). */
  leash: number;
}

export interface TutorialWorldRef {
  /** 마지막으로 지난 체크포인트 (시작은 `'wake'`). */
  readonly checkpoint: TutorialCheckpointId;
  /** 부활 자리 — 발 위치와 바라볼 yaw. 호출할 때마다 새 벡터를 돌려준다 (호출부가 들고 쓴다). */
  respawnPose(): { position: THREE.Vector3; yaw: number };
  /** 떨어진 자리(착지 지점)의 낙하 규칙. 규칙 볼륨 밖이면 `'normal'`. */
  fallRule(position: THREE.Vector3): TutorialFallRule;
  /** dev 콘솔 · 스모크 전용: 그 체크포인트로 순간이동한다. 모르는 id 면 false. */
  gotoCheckpoint(id: TutorialCheckpointId): boolean;
  /**
   * 이 월드가 세워야 할 적 전부 (고정 자리 · 고정 종류). `world:ready` 에서 `enemies/` 가 한 번 읽어 세운다 —
   * **폴더끼리 import 하지 않으려고** 월드가 자리를, 적이 몸을 갖는 것이다.
   * 한 번 처치된 적은 체크포인트 부활로 되살아나지 않으므로 이 목록은 다시 읽지 않는다.
   */
  enemySpawns(): readonly TutorialEnemySpawn[];
}
