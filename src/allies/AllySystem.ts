import type { AlliesRef, AllyBodyView, AllyLoadoutView, AllyRosterEntry, GameContext, GameSystem } from '@/shared';

/**
 * 안드로이드 분대원 (`ctx.allies`, 계약 `shared/allies.ts`).
 *
 * 2026-09-15 계약 커밋의 **빈 껍데기**다 — 명단도 몸도 없는 ref 만 올려, 다른 폴더가 `ctx.allies` 를 읽는 코드를 먼저 쓸 수 있게 한다.
 * allies 에이전트가 명단 · 함선 · 레이드 시뮬레이션 · 동기화로 채운다.
 */
export class AllySystem implements GameSystem {
  readonly name = 'allies';

  init(ctx: GameContext): void {
    const noBodies: readonly AllyBodyView[] = [];
    const noRoster: readonly AllyRosterEntry[] = [];
    const ref: AlliesRef = {
      roster: noRoster,
      simulating: false,
      getBodies: () => noBodies,
      getBody: () => null,
      getCombatBodies: () => noBodies,
      getLoadout: (): AllyLoadoutView | null => null,
      damage: () => {},
      requestRevive: () => false,
      carrierOf: () => null,
    };
    ctx.allies = ref;
  }

  update(): void {}
}
