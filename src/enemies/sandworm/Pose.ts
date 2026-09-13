/**
 * src/enemies/sandworm/Pose.ts — **지하벌레 자세 힌트** (2026-09-13).
 *
 * 권위(`sandworm/Director` 의 지하벌레 틱)와 리플리카(`net/Replica.drive`)가 **같은 함수**로 와이어 힌트를 자세로 푼다 —
 * 호스트가 보는 입 벌림 · 꿀렁임 · 숙임이 비호스트 화면과 어긋나지 않게. 힌트 값은 `EnemyWire.a` 의 21 · 22
 * (`shared/net.ts` 의 `EnemyEventAppended2026_09_13` 주석). 판정 · 타이머는 없다.
 */
import type { Enemy } from '../Enemy';

/** 버그를 뱉는 중 — 목구멍이 꿀렁이고 입이 크게 벌어진다. */
export const WORM_HINT_SPIT = 21;
/** 독극물 연발 준비 · 발사 — 앞으로 숙이고 입을 벌린다. */
export const WORM_HINT_ACID = 22;

/** `hint` 쪽으로 `e.anim` 의 입 벌림(`mandible`) · 꿀렁임(`abdomen`) · 숙임(`aim`) · 떨림(`shake`)을 부드럽게 옮긴다. */
export function applyWormHint(e: Enemy, hint: number, dt: number): void {
  const a = e.anim;
  const spit = hint === WORM_HINT_SPIT;
  const acid = hint === WORM_HINT_ACID;
  const mandT = spit ? 1 : acid ? 0.75 : 0.15;
  const abdT = spit ? 1 : 0;
  const aimT = acid ? 1 : 0;
  const shakeT = e.emergeT > 0 ? 1 : 0;
  a.mandible += (mandT - a.mandible) * Math.min(1, dt * (mandT > a.mandible ? 6 : 3));
  a.abdomen += (abdT - a.abdomen) * Math.min(1, dt * (abdT > a.abdomen ? 4 : 2));
  a.aim += (aimT - a.aim) * Math.min(1, dt * (aimT > a.aim ? 5 : 2));
  a.shake += (shakeT - a.shake) * Math.min(1, dt * (shakeT > a.shake ? 8 : 2));
  a.speed = 0;
}
