import type { AlliesRef, AllyBodyView, AllyId, AllyRosterEntry, GameContext } from '@/shared';

/**
 * src/ui/hud/allySource.ts — ui 가 **안드로이드 분대원을 읽는 유일한 창구** (2026-09-15).
 *
 * `menus/social/socialSource` 와 같은 뜻의 파일이다: 분대 목록 · 이름표 · 지도 · 나침반 · 핑 · 토스트가 전부
 * 여기를 지나므로, 스모크가 `HudSystem.debugAllies(ref)` 로 가짜 `AlliesRef` 하나를 꽂으면 allies/ 없이도
 * 모든 그림을 검사할 수 있다. 진짜 세션에서는 `ctx.allies` 그대로다.
 *
 * ⚠ `getBodies()` 가 돌려주는 배열과 그 안의 벡터는 allies/ 가 **재사용**한다 — 읽고 바로 쓰고 보관하지 않는다.
 */
let debugRef: AlliesRef | null = null;

/** 스모크 훅: `ref` 를 `ctx.allies` 대신 쓴다 (null = 진짜 `ctx.allies` 로 되돌린다). */
export function setDebugAllies(ref: AlliesRef | null): void { debugRef = ref; }

/** 지금 ui 가 보는 `AlliesRef` (없으면 null). */
export function alliesOf(ctx: GameContext | null | undefined): AlliesRef | null {
  return debugRef ?? ctx?.allies ?? null;
}

const NO_ROSTER: readonly AllyRosterEntry[] = [];
const NO_BODIES: readonly AllyBodyView[] = [];

/** 내 분대의 안드로이드 명단 (bay 순). allies/ 가 아직 없으면 빈 배열. */
export function allyRoster(ctx: GameContext | null | undefined): readonly AllyRosterEntry[] {
  return alliesOf(ctx)?.roster ?? NO_ROSTER;
}

/** 이 클라이언트가 아는 모든 안드로이드 몸 (재사용 배열). */
export function allyBodies(ctx: GameContext | null | undefined): readonly AllyBodyView[] {
  const ref = alliesOf(ctx);
  // allies/ 가 아직 이 메서드를 구현하지 않은 동안(병렬 작업)에도 ui 는 그냥 비어 있는 것으로 읽는다.
  if (!ref || typeof ref.getBodies !== 'function') return NO_BODIES;
  return ref.getBodies();
}

/** 한 기의 몸 (없으면 null). */
export function allyBody(ctx: GameContext | null | undefined, id: AllyId): AllyBodyView | null {
  const ref = alliesOf(ctx);
  if (!ref || typeof ref.getBody !== 'function') return null;
  return ref.getBody(id);
}
