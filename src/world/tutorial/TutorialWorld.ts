import * as THREE from 'three';
import {
  PLAYER_RADIUS, TUTORIAL_CHECKPOINTS,
  type GameContext, type SurfaceMaterial, type TutorialCheckpointId, type TutorialEnemySpawn,
  type TutorialFallRule, type TutorialWorldRef,
} from '@/shared';
import type { SpatialHash } from '../SpatialHash';
import { Ground } from './parts/Ground';
import { Dressing } from './parts/Dressing';
import { TutorialCorpses } from './parts/Corpses';
import {
  ABYSS_EDGE_Z, ABYSS_SAFE_MARGIN_M, CHASM_RUNUP_M, CHECKPOINTS, CORRIDOR_OUTER_X, DECK_LOWER_Y, DECK_UPPER_Y, ENEMIES,
  ENEMY_LEASH, ENEMY_SENSE, FALL_RULES, RUINS, SHIP_POS, SHIP_YAW, TUTORIAL_MAP_SIZE, VOID_Y, Z_END, Z_START,
  chasmFarZAt, chasmNearZAt, type Volume,
} from './model';

/* ────────────────────────────────────────────────────────────────────────────
 * 손으로 지은 튜토리얼 행성 (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * `game:newMission {mode:'tutorial'}` 이 오면 `WorldSystem` 이 절차 생성기 대신 이것을 세운다 —
 * `TrainingArena` 와 **똑같은 배선**이고, 안개 · 재해 · 상자 · 채집 · 둥지 · 선로 · 전차 · 탐사 차량은
 * 하나도 없다 (`ctx.world.fog === null` 도 훈련장과 같다).
 *
 * 이 클래스가 갖는 것은 셋이다:
 *   1. **월드** — 협곡 바닥 · 데크 · 절벽 벽 · 함선 앞 끝없는 절벽(`parts/Ground`), 폐허 · 무너진 통로 · 사선 방벽과
 *      블라인드 철조망(`parts/Dressing`),
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
/**
 * 「데크 윗면에 서 있다」로 볼 발 높이의 오차. 이 맵에는 경사도 단차도 없고 걸어 다니는 면이 딱 두 높이뿐이라
 * 좁게 잡을 수 있다 — 넓히면 폐허 벽 · 잔해 더미 **위**에 올라선 자리까지 안전한 자리로 적힌다.
 */
const SAFE_DECK_EPS = 0.4;
/**
 * 절벽 1 을 **넘은 뒤**(먼 쪽 가장자리보다 −Z) 안전한 자리로 적기까지의 여유. 좁게 잡는다 —
 * 넘은 사람이 한참을 더 걸어야 기록이 살아나면 그 사이에 죽었을 때 이유 없이 절벽 앞으로 되돌아간다.
 */
const SAFE_CHASM_MARGIN = 1.5;

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
  /**
   * **마지막으로 땅에 서 있던 자리** (2026-09-14 4차, 사용자 결정 — 튜토리얼 전체). 떨어져 죽었을 때 체크포인트가
   * 아니라 여기로 되돌린다: 절벽 하나를 못 넘었다고 구간의 처음으로 돌려보내면 벌레 · 안드로이드를 다시
   * 지나야 한다. 체크포인트는 **이 기록이 없을 때의 보험**으로 남는다(레이드 시작 · 이어하기 직후 ·
   * 절벽 1 의 도움닫기 구역 — `pollSafeGround` 의 ②가 그 구역을 통째로 비워 두므로 `cliff` 가 받는다).
   */
  private readonly lastSafe = new THREE.Vector3();
  private hasLastSafe = false;
  /** 버려진 함선을 세웠는가 (첫 `update()` 에서 한 번). */
  private shipPlaced = false;
  private shipTry = 0;

  constructor() { this.group.name = 'TutorialWorld'; }

  /* ── 생성 ───────────────────────────────────────────────────────────── */

  build(ctx: GameContext, root: THREE.Group, hash: SpatialHash): void {
    this.ctx = ctx;
    this.hash = hash;
    this.index = 0;
    this.hasLastSafe = false;
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
    this.pollSafeGround();
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

  /**
   * 「지금 서 있는 이 자리에서 다시 시작해도 되는가」 — 매 프레임 세 가지를 본다.
   *   ① **`kill` 볼륨 밖** — 절벽 1 바닥은 「떨어진 자리」라 부활 자리가 아니다. **`clamp`(절벽 2 착지 구역)는
   *      막지 않는다**: 반드시 살아남는 낙하의 착지 자리이고 아래 데크에 두 발로 선 안전한 땅이라, 거기서
   *      기록을 막으면 그 구간에서 죽은 사람이 이유 없이 절벽 위로 올라가 뛰어내리기를 다시 한다.
   *   ② **절벽 1 의 띠 밖 — 이 판정만 비대칭이다.** 접근 쪽(가까운 가장자리보다 +Z)은 `CHASM_RUNUP_M`(12 m)
   *      만큼 넓게 막고, 건너편(먼 가장자리보다 −Z)은 `SAFE_CHASM_MARGIN`(1.5 m)만 막는다. 대칭 마진
   *      (`inChasm`)으로는 안 되는 이유가 이 절벽의 규칙 자체다 — **달려야만 넘는다.** 가장자리 코앞에
   *      되살리면 도움닫기가 없어 「떨어지기 전 자리로 돌려보낸다」가 「다시 떨어지라」가 된다. 반대로 건너편을
   *      똑같이 12 m 막으면, 넘은 사람이 그만큼 더 걸어야 기록이 살아나 그 사이의 죽음이 절벽 앞으로 되돌아간다.
   *   ③ **데크 윗면 근처** — 폐허 벽 · 잔해 더미 위에 올라선 자리를 걸러 낸다 (`SAFE_DECK_EPS`).
   *   ④ **끝없는 절벽 가장자리 띠 밖** (2026-09-15) — 가장자리(`ABYSS_EDGE_Z`)에서 `ABYSS_SAFE_MARGIN_M`(3 m) 안은 적지 않는다.
   *      가장자리에 발끝을 걸친 자리(몸 가운데는 아직 데크 위)에 되살리면 한 걸음에 다시 떨어진다. 그 띠에서 떨어진 사람은
   *      띠 바로 뒤, 즉 가장자리에서 3 m 이상 떨어진 마지막 자리로 돌아온다.
   * 접지(`isGrounded`) 자체가 다섯째 조건이라 뛰는 · 떨어지는 동안의 좌표는 애초에 적히지 않는다
   * (그래서 ① 은 ③ 과 겹치는 이중 안전장치다 — `kill` 볼륨 안에서 접지할 수 있는 곳은 협곡 바닥 · 절벽 아래 지형뿐이다).
   */
  private pollSafeGround(): void {
    const player = this.ctx?.player;
    if (!player || player.isDead || !player.isGrounded) return;
    const p = player.position;
    if (Math.abs(p.y - DECK_UPPER_Y) > SAFE_DECK_EPS && Math.abs(p.y - DECK_LOWER_Y) > SAFE_DECK_EPS) return;
    if (p.z <= chasmNearZAt(p.x) + CHASM_RUNUP_M && p.z >= chasmFarZAt(p.x) - SAFE_CHASM_MARGIN) return;
    if (p.z < ABYSS_EDGE_Z + ABYSS_SAFE_MARGIN_M) return;
    for (const v of FALL_RULES) if (v.rule === 'kill' && volumeContains(v, p)) return;
    this.lastSafe.copy(p);
    this.hasLastSafe = true;
  }

  private setIndex(i: number, announce: boolean): void {
    this.index = i;
    const spec = CHECKPOINTS[i];
    if (!announce || !this.ctx) return;
    this.ctx.bus.emit('tutorial:checkpoint', { id: spec.id, index: i });
  }

  /* ── TutorialWorldRef ───────────────────────────────────────────────── */

  get checkpoint(): TutorialCheckpointId { return CHECKPOINTS[this.index].id; }

  /**
   * 2026-09-14 4차 — **마지막으로 땅에 서 있던 자리**가 있으면 그리로, 없으면 예전처럼 마지막 체크포인트로.
   * 밀려난 몸이 벽에 낀 채로 기록됐을 수도 있으므로 돌려주기 전에 `resolveCollision` 을 한 번 통과시킨다.
   * yaw 는 0(앞) — 죽은 방향을 그대로 물려주면 절벽을 등지고 살아난다.
   */
  respawnPose(): { position: THREE.Vector3; yaw: number } {
    if (this.hasLastSafe) {
      const position = this.lastSafe.clone();
      this.ctx?.world?.resolveCollision(position, PLAYER_RADIUS);
      return { position, yaw: 0 };
    }
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
    // 순간이동이므로 「마지막으로 서 있던 자리」는 무효다 — 안 지우면 이어하기 직후에 죽었을 때
    // 새로고침 전에 서 있던 자리로 되돌아간다 (이어하기는 **체크포인트**로 간다는 규약이 깨진다).
    this.hasLastSafe = false;
    this.setIndex(i, true);
    const spec = CHECKPOINTS[i];
    this.ctx?.player?.teleport(spec.at.clone(), spec.yaw, false);
    return true;
  }

  enemySpawns(): readonly TutorialEnemySpawn[] { return this.spawns; }

  /* ── 월드 질의 (`WorldSystem` 이 `mode === 'tutorial'` 가지에서 부른다) ── */

  /**
   * 지형 높이 = `VOID_Y` 하나. 걸어 다니는 데크 · 절벽 1 의 협곡 바닥(`CHASM_FLOOR_Y`)은 전부 사각 콜라이더라 `getSurfaceY` 가
   * 답한다. 2026-09-15 −34 → −100: 인자가 없는 상수라 끝없는 절벽 밑만 깊게 할 수 없어 통째로 내렸다 (`model.ts` 의 `VOID_Y`).
   */
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

  /** 발밑 재질 — 시작 폐허 둘레만 콘크리트이고 나머지는 바위다. */
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
    this.hasLastSafe = false;
    this.shipPlaced = false;
    this.group.clear();
    this.group.removeFromParent();
    this.hash = null;
    this.ctx = null;
  }
}
