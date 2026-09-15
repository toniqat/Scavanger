/**
 * src/enemies/parts/Burrow.ts — **굴착 스폰의 연출 · 흔들림 · 소리** (2026-09-13).
 *
 * 이 파일이 답하는 질문: *버그가 땅에서 올라올 때 이 클라이언트는 무엇을 보고 · 느끼고 · 듣나.*
 *
 * 권위(`Pool.spawn(…, emerge)`)와 리플리카(`ee spawn.em` → `EnemySystem.emergeSpawned`)가 **같은 함수**를 부른다.
 * 게임 상태는 바꾸지 않는다 — 굴착 시간 자체는 `Enemy.startEmerge` 가 들고, 공격 · 이동 금지는 `ai/Burrow` 가 건다.
 *
 * - **흔들림은 겹치지 않는다**: 로컬 플레이어가 `BURROW_SHAKE_RADIUS` 안일 때만, 그리고 마지막으로 **실제로 흔든** 뒤
 *   `BURROW_SHAKE_GAP_S` 가 지났을 때만 한 번 (`EnemySystem.burrowShakeAt`). 분출 무리 여덟 마리가 한 프레임에 올라와도 한 번이다.
 * - 2026-09-16: 소리 `burrow_emerge` 는 **한 마리마다** 그 몸 자리에서 난다 (예전에는 `playAudio` 의 id 스로틀 0.12 s 가 무리를
 *   한 소리로 묶었다). 무리가 커도 시끄럽지 않게 두 겹으로 누른다: ① 여기서 `BURROW_EMERGE_BATCH_S` 안의 k 번째 소리 × 1/√k
 *   (`emergeSound`), ② audio/ 의 `VOICE_CAP.burrow_emerge` (`BURROW_EMERGE_VOICE_CAP`) 가 가장 큰(가까운) 것만 남긴다.
 */
import * as THREE from 'three';
import { BURROW_EMERGE_BATCH_S, BURROW_SHAKE_GAP_S, BURROW_SHAKE_INTENSITY, BURROW_SHAKE_RADIUS } from '@/shared';
import type { Enemy } from '../Enemy';
import type { EnemySystem } from '../EnemySystem';
import { isWormType } from '../EnemyTypes';

/** 몸집 → 연출 배율 (스캐빈저 ≈ 0.75, 전사 ≈ 1.3, 베헤모스 3). */
function burrowScale(e: Enemy): number {
  return THREE.MathUtils.clamp(e.stats.radius / 0.6, 0.7, 3);
}

/** 한 마리가 파고 나오기 시작했다 (권위 · 리플리카 공통). 땅굴벌레는 디렉터가 자기 분출 연출을 따로 낸다. */
export function emergeFx(sys: EnemySystem, e: Enemy): void {
  if (isWormType(e.type)) return;
  const ctx = sys.ctx;
  const scale = burrowScale(e);
  sys.burrowFx?.emerge(e.position, scale, e.emergeDur, ctx.world, ctx.time);
  emergeSound(sys, e.position, Math.min(1.1, 0.7 + 0.15 * scale), 1.12 - 0.12 * Math.min(2, scale));
  burrowShake(sys, e.position, BURROW_SHAKE_INTENSITY * Math.min(1.5, Math.sqrt(scale)));
}

/** 뱉어진 버그가 착지했다 (권위 · 리플리카 공통): 발밑 분진 한 줌 + 작은 쿵. */
export function spatLandedFx(sys: EnemySystem, e: Enemy): void {
  const ctx = sys.ctx;
  sys.burrowFx?.puff(e.position, burrowScale(e), ctx.world);
  emergeSound(sys, e.position, 0.45, 1.35);
}

/* 2026-09-16: 지금 무리의 시작 시각과 그 안에서 난 굴착음 수. 모듈 상태인 이유 — EnemySystem 은 하나뿐이고 연출 전용이다
 * (게임 상태 아님). `ctx.time` 이 새 임무에서 되감기면(`now < emergeBatchAt`) 새 무리로 본다. */
let emergeBatchAt = -Infinity;
let emergeBatchN = 0;

/**
 * 한 마리의 굴착음 (2026-09-16). **무리 창은 미끄러지지 않는다** — 첫 소리에서 `BURROW_EMERGE_BATCH_S` 가 지나면 새 무리다
 * (0.3 s 마다 한 마리씩 올라와도 소리가 끝없이 작아지지 않는다). k 번째 × 1/√k: 여덟 마리 무리의 에너지 합 ≈ 한 마리의 2.7 배.
 * `playAudio` 의 id 스로틀을 타지 않는다 — 한 마리마다 난다.
 */
function emergeSound(sys: EnemySystem, p: THREE.Vector3, volume: number, pitch: number): void {
  const now = sys.ctx.time;
  if (now < emergeBatchAt || now - emergeBatchAt >= BURROW_EMERGE_BATCH_S) { emergeBatchAt = now; emergeBatchN = 0; }
  emergeBatchN++;
  sys.ctx.bus.emit('audio:play', { id: 'burrow_emerge', position: p, volume: volume / Math.sqrt(emergeBatchN), pitch });
}

/**
 * 약한 화면 흔들림 — 로컬 플레이어가 반경 안이고, 마지막 굴착 흔들림에서 `BURROW_SHAKE_GAP_S` 가 지났을 때만.
 * 흔들렸으면 true.
 */
export function burrowShake(sys: EnemySystem, p: THREE.Vector3, intensity: number): boolean {
  const now = sys.ctx.time;
  if (now - sys.burrowShakeAt < BURROW_SHAKE_GAP_S) return false;
  const d = sys.targets.distToLocal(p);
  if (!(d < BURROW_SHAKE_RADIUS)) return false;
  sys.burrowShakeAt = now;
  sys.burrowShakes++;
  sys.ctx.bus.emit('camera:shake', { intensity: intensity * (1 - d / BURROW_SHAKE_RADIUS), duration: 0.3 });
  return true;
}
