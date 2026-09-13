/*
 * src/shared/damageSource.ts — **로컬 플레이어 피해의 출처** (2026-09-14, NPC 퀘스트 kill 목표 · docs/plans/messenger-quests.md).
 *
 * 「산탄총으로 레이더 5명 처치」 는 **막타가 그 계열 총기**여야 센다. 그런데 `Enemy.takeDamage` 는 누가 · 무엇으로 때렸는지
 * 모른다(총 · 근접 · 가젯 · 방패 배쉬가 같은 모양으로 부른다). 그래서 weapons/ 가 총알 한 발의 피해를 넣는 **동기 구간**을
 * 이 파일로 감싸고(`withLocalGunHit`), enemies/ 가 그 구간 안에서 들어온 로컬 피해에만 계열을 적는다(`localGunHitClass`).
 * 구간 밖(수류탄 · 가젯 · 근접 · 화상 지속 피해)은 null — 계열 없는 처치다.
 *
 * 상태는 모듈 변수 하나이고 JS 는 한 스레드라 구간이 겹치지 않는다. 구간 안에서 예외가 나도 `finally` 가 되돌린다.
 */
import type { WeaponClass } from './types';

let current: WeaponClass | null = null;

/** `fn` 동안 들어오는 로컬 피해를 `cls` 총기의 피해로 표시한다 (null = 표시 안 함). `fn` 의 반환값을 그대로 돌려준다. */
export function withLocalGunHit<T>(cls: WeaponClass | null | undefined, fn: () => T): T {
  const prev = current;
  current = cls ?? null;
  try { return fn(); } finally { current = prev; }
}

/** 지금 들어오는 로컬 피해가 총기 한 발이면 그 계열, 아니면 null. */
export function localGunHitClass(): WeaponClass | null {
  return current;
}
