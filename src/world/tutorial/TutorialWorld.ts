import * as THREE from 'three';
import {
  TUTORIAL_CHECKPOINTS,
  type GameContext, type SurfaceMaterial, type TutorialCheckpointId, type TutorialEnemySpawn,
  type TutorialFallRule, type TutorialWorldRef,
} from '@/shared';
import type { SpatialHash } from '../SpatialHash';
import { Ground } from './parts/Ground';
import { Dressing } from './parts/Dressing';
import { TutorialCorpses } from './parts/Corpses';
import {
  CHECKPOINTS, CORRIDOR_OUTER_X, DECK_LOWER_Y, DECK_UPPER_Y, ENEMIES, ENEMY_LEASH, ENEMY_SENSE, FALL_RULES,
  RUINS, SHIP_POS, SHIP_YAW, TUTORIAL_MAP_SIZE, VOID_Y, Z_END, Z_START, type Volume,
} from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 지은 튜토리얼 행성 (2026-09-14, `docs/plans/tutorial-raid.md` A절).
 *
 * `game:newMission {mode:'tutorial'}` 이 오면 `WorldSystem` 이 절차 생성기 대신 이것을 세운다 —
 * `TrainingArena` 와 **똑같은 배선**이고, 안개 · 재해 · 상자 · 채집 · 둥지 · 선로 · 전차 · 탐사 차량은
 * 하나도 없다 (`ctx.world.fog === null` 도 훈련장과 같다).
 *
 * 이 클래스가 갖는 것은 셋이다:
 *   1. **월드** — 협곡 바닥 · 데크 · 절벽 벽(`parts/Ground`), 폐허 · 무너진 통로 · 무너진 벽(`parts/Dressing`),
 *      시체 세 구(`parts/Corpses`). 전부 절차 지오메트리이고 **광원을 하나도 만들지 않는다**.
 *   2. **`TutorialWorldRef`** — 체크포인트 · 낙하 규칙 · 적 자리 (`ctx.world.tutorial`).
 *   3. **버려진 함선** — 메시를 새로 만들지 않고 `ctx.extraction.beginPreLanded` 로 진짜 탈출선을 착륙 상태로
 *      세운다. 그 뒤의 스위치 → 10초 유예 → 이륙 → 정산은 평소 경로 그대로다.
 *
 * ⚠ 함선은 **첫 `update()` 에서** 세운다. `generate()` 는 `game:newMission` emit **안에서** 도는데
 * `ExtractionSystem` 도 같은 이벤트에 `resetMission()` 을 걸어 두었고 시스템 등록 순서가 world(90) →
 * extraction(106) 이라, 생성 중에 세우면 같은 emit 안에서 곧바로 리셋된다. 한 프레임 미루면 그 순서가 끝나 있다.
 * ──────────────────────────────────────────────────────────────────────────── */

const OBJECTIVE_TEXT = '버려진 함선을 찾아 이 행성을 벗어난다';
/** 함선을 세우려고 다시 시도하는 시간 (s). 그 안에 `ctx.extraction` 이 준비되지 않으면 포기하고 경고만 남긴다. */
const SHIP_PLACE_TIMEOUT_S = 5;

function volumeContains(v: Volume, p: THREE.Vector3): boolean {
  return p.x >= v.x0 && p.x <= v.x1 && p.z <= v.z0 && p.z >= v.z1 && p.y >= v.y0 && p.y <= v.y1;
}

export class TutorialWorld implements TutorialWorldRef {
  readonly group = new THREE.Group();
  /** 기상 지점 (`wake` 체크포인트) — `WorldRef.getPlayerSpawn`. */
  readonly spawn = CHECKPOINTS[0].at.clone();
  /** 지도 · 핑이 쓰는 한 변. */
  readonly size = TUTORIAL_MAP_SIZE;

  private ctx: GameContext | null = null;
  private hash: SpatialHash | null = null;
  private built = false;
  private readonly ground = new Ground();
  private readonly dressing = new Dressing();
  private readonly corpses = new TutorialCorpses();
  private index = 0;
  private readonly spawns: TutorialEnemySpawn[] = [];
  /** 버려진 함선을 세웠는가 (첫 `update()` 에서 한 번). */
  private shipPlaced = false;
  private shipTry = 0;

  constructor() { this.group.name = 'TutorialWorld'; }

  /* ── 생성 ───────────────────────────────────────────────────────────── */

  build(ctx: GameContext, root: THREE.Group, hash: SpatialHash): void {
    this.ctx = ctx;
    this.hash = hash;
    this.index = 0;
    this.shipPlaced = false;
    this.shipTry = 0;
    root.add(this.group);
    this.ground.build(this.group, hash);
    this.dressing.build(this.group, hash);
    this.corpses.build(ctx, this.group);

    this.spawns.length = 0;
    for (const e of ENEMIES) {
      this.spawns.push({
        type: e.type,
        position: new THREE.Vector3(e.x, e.y, e.z),
        yaw: e.yaw,
        sense: ENEMY_SENSE,
        leash: ENEMY_LEASH,
      });
    }

    // 계약(`shared/tutorialWorld`)의 순서와 맵의 순서가 갈라지면 부활 자리가 엉킨다 — 생성할 때 한 번 본다.
    for (let i = 0; i < TUTORIAL_CHECKPOINTS.length; i++) {
      if (CHECKPOINTS[i]?.id !== TUTORIAL_CHECKPOINTS[i]) {
        console.warn(`[TutorialWorld] 체크포인트 순서가 계약과 다르다: ${i} — ${CHECKPOINTS[i]?.id} ≠ ${TUTORIAL_CHECKPOINTS[i]}`);
      }
    }

    this.built = true;
    ctx.bus.emit('ui:objective', { text: OBJECTIVE_TEXT });
  }

  /* ── 프레임 ─────────────────────────────────────────────────────────── */

  update(dt: number): void {
    if (!this.built) return;
    this.placeShip(dt);
    this.pollCheckpoints();
  }

  /**
   * 버려진 함선 = **이미 착륙해 있는 탈출선**. 콘솔도 호출도 없이 그 자리에 서 있고, 안의 스위치를 누르면
   * 평소의 10초 유예 → 이륙 → 결과 · 정산이 그대로 흐른다. `autoDepart: false` 라 무응답 60초 자동 출발은
   * 걸리지 않는다 — 튜토리얼은 둘러볼 시간이 필요하다.
   */
  private placeShip(dt: number): void {
    if (this.shipPlaced) return;
    const ctx = this.ctx;
    const ex = ctx?.extraction;
    this.shipTry += dt;
    if (ex && typeof ex.beginPreLanded === 'function' && ex.beginPreLanded(SHIP_POS, SHIP_YAW, { autoDepart: false })) {
      this.shipPlaced = true;
      return;
    }
    if (this.shipTry > SHIP_PLACE_TIMEOUT_S) {
      this.shipPlaced = true;
      console.warn('[TutorialWorld] 버려진 함선을 세우지 못했다 (ctx.extraction.beginPreLanded)');
    }
  }

  /** 체크포인트 볼륨 — **번호는 되돌아가도 내려가지 않는다**. */
  private pollCheckpoints(): void {
    const ctx = this.ctx;
    const player = ctx?.player;
    if (!ctx || !player || player.isDead) return;
    const p = player.position;
    for (let i = CHECKPOINTS.length - 1; i > this.index; i--) {
      if (!volumeContains(CHECKPOINTS[i].trigger, p)) continue;
      this.setIndex(i, true);
      return;
    }
  }

  private setIndex(i: number, announce: boolean): void {
    this.index = i;
    const spec = CHECKPOINTS[i];
    if (!announce || !this.ctx) return;
    this.ctx.bus.emit('tutorial:checkpoint', { id: spec.id, index: i });
  }

  /* ── TutorialWorldRef ───────────────────────────────────────────────── */

  get checkpoint(): TutorialCheckpointId { return CHECKPOINTS[this.index].id; }

  respawnPose(): { position: THREE.Vector3; yaw: number } {
    const spec = CHECKPOINTS[this.index];
    return { position: spec.at.clone(), yaw: spec.yaw };
  }

  fallRule(position: THREE.Vector3): TutorialFallRule {
    for (const v of FALL_RULES) if (volumeContains(v, position)) return v.rule;
    return 'normal';
  }

  gotoCheckpoint(id: TutorialCheckpointId): boolean {
    const i = CHECKPOINTS.findIndex((c) => c.id === id);
    if (i < 0 || !this.built) return false;
    this.setIndex(i, true);
    const spec = CHECKPOINTS[i];
    this.ctx?.player?.teleport(spec.at.clone(), spec.yaw, false);
    return true;
  }

  enemySpawns(): readonly TutorialEnemySpawn[] { return this.spawns; }

  /* ── 월드 질의 (`WorldSystem` 이 `mode === 'tutorial'` 가지에서 부른다) ── */

  /** 지형 높이 = 협곡 바닥 하나. 걸어 다니는 데크는 전부 사각 콜라이더라 `getSurfaceY` 가 답한다. */
  heightAt(): number { return VOID_Y; }

  /** 레이 vs 협곡 바닥 평면. `t` (없으면 −1) 를 돌려주고 법선을 `n` 에 쓴다 — 훈련장의 `raycastShell` 과 같은 자리다. */
  raycastGround(oy: number, dy: number, maxDist: number, n: THREE.Vector3): number {
    if (dy >= -1e-6) return -1;
    const t = (VOID_Y - oy) / dy;
    if (t < 0 || t > maxDist) return -1;
    n.set(0, 1, 0);
    return t;
  }

  isInside(x: number, z: number): boolean {
    return Math.abs(x) <= CORRIDOR_OUTER_X && z <= Z_START && z >= Z_END;
  }

  /**
   * 마지막 방어선 — 벽 콜라이더가 이미 막지만 밀려난 몸이 맵 밖으로 나가지 않게 한다.
   * 기준은 **가장 넓은 구간**(`CORRIDOR_OUTER_X`)이다: 구간별 폭으로 좁히면 좁은 구간의 벽 속으로 밀려난 몸을
   * 통로가 아니라 벽 안쪽 어딘가로 되돌려 놓는다 — 실제 되돌리기는 `resolveCollision` 의 몫이다.
   */
  clampInside(position: THREE.Vector3, radius: number): void {
    const lim = CORRIDOR_OUTER_X - radius;
    if (position.x > lim) position.x = lim; else if (position.x < -lim) position.x = -lim;
    const z0 = Z_START - radius, z1 = Z_END + radius;
    if (position.z > z0) position.z = z0; else if (position.z < z1) position.z = z1;
  }

  /** 발밑 재질 — 폐허 · 무너진 벽 둘레만 콘크리트이고 나머지는 바위다. */
  surfaceMaterial(x: number, z: number): SurfaceMaterial {
    if (z <= RUINS.z0 && z >= RUINS.z1) return 'concrete';
    return 'rock';
  }

  /** 디버그 · 스모크: 데크 높이 두 개와 함선 자리 (스크립트가 좌표를 베끼지 않게). */
  get debugLevels(): { upper: number; lower: number; ship: THREE.Vector3 } {
    return { upper: DECK_UPPER_Y, lower: DECK_LOWER_Y, ship: SHIP_POS.clone() };
  }

  dispose(): void {
    if (!this.built) return;
    this.built = false;
    const hash = this.hash;
    this.corpses.dispose();
    if (hash) { this.dressing.dispose(hash); this.ground.dispose(hash); }
    this.spawns.length = 0;
    this.index = 0;
    this.shipPlaced = false;
    this.group.clear();
    this.group.removeFromParent();
    this.hash = null;
    this.ctx = null;
  }
}
