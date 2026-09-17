import type { GameContext } from './GameContext';

/* ────────────────────────────────────────────────────────────────────────────
 * 컷씬 중 숨김 (2026-09-17, 사용자 결정 — B-17). Owner: shared/ — 계약이므로 추가만 한다.
 *
 * **연출이 화면을 가져가면 그 위에 남는 UI 는 없다.** 대부분의 화면은 그 전에 닫힌다 —
 * `hub/parts/SquadDock.cancelEverything` 이 포드 · 하우징 · `ctx.escape` 의 모든 화면 · 인벤토리 · 일시정지를 닫는다.
 * 그러나 **닫을 수 없는 팝업**이 있다: 닫는 것이 곧 그 기능의 상태를 깨는 것(튜토리얼 시작 카드 — 닫으면 단계가
 * 흐른다). 그런 팝업은 **닫는 대신 숨는다** — 연출 동안 보이지 않고, 끝나면 그대로 다시 뜬다.
 *
 * 숨김은 DOM 만이 아니다. 팝업은 `ctx.uiBlockers` 와 소프트 커서를 쥐고 있으므로, 화면만 감추고 그것을 든 채 두면
 * 컷씬 위에 커서가 떠 있고 `hub/parts/Transitions.relock` 도 막힌다(`uiBlockers.size > 0`). 가입자는 숨을 때
 * **DOM · 블로커 · 커서 · 진행 중인 홀드 게이지**를 함께 내려놓고, 되살아날 때 전부 되돌린다.
 *
 * 어떤 연출이 컷씬인가 (`CutsceneKind`):
 *   • `docking`  — 도킹 · 도킹 해제 (`hub:docking`, 그 사이 페이즈는 `'docking'`)
 *   • `travel`   — 창문 워프 (`hub:travel`). 카메라를 뺏지는 않지만 함선 모서리 위젯도 이 동안 사라진다
 *                  (`ui/hud/CutsceneWatch`) — 같은 규칙을 따른다.
 *   • `liftoff`  — 이륙 연출 (`ui:cinematic`, extraction 이 낸다)
 *
 * **복귀는 무조건이다** (2026-09-17 사용자 결정): 숨기 전 상태 그대로 다시 뜬다. 가입자가 그 사이에 스스로 닫혔다면
 * 그것은 가입자의 일이고(`setHidden` 은 멱등이다), 이 모듈은 "지금 연출 중인가" 한 줄만 안다.
 *
 * 리셋(`RESET_EVENTS`)이 필요한 이유: 중단된 연출은 짝이 되는 `end` 를 내지 않는다 — 도킹 컷씬이 창문 워프를
 * 삼키면(`cancelTravel`) `hub:travel {end}` 가 없고, 중단된 레이드는 `ui:cinematic {false}` 가 없다. 그 경로들이
 * 내는 것은 `hub:entered` · `hub:left` · `game:abort` · `game:newMission` · `game:complete` · `game:over` 라서,
 * 그 여섯을 「연출은 전부 끝났다」로 읽는다. 그러지 않으면 팝업이 영영 숨은 채로 남는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 화면을 가져가는 연출의 종류. 가입자는 필요한 것만 고를 수 있다 (기본은 전부). */
export type CutsceneKind = 'docking' | 'travel' | 'liftoff';

/** 기본 가입 범위 — 세 연출 전부. */
export const CUTSCENE_KINDS: readonly CutsceneKind[] = ['docking', 'travel', 'liftoff'];

export interface CutsceneHideOpts {
  /** 이 연출들만 본다 (기본 `CUTSCENE_KINDS`). */
  kinds?: readonly CutsceneKind[];
}

/** 어떤 연출도 끝나지 않은 채 사라지는 경로들 — 하나라도 오면 진행 중인 연출을 전부 지운다 (위 주석). */
const RESET_EVENTS = ['hub:entered', 'hub:left', 'game:abort', 'game:newMission', 'game:complete', 'game:over'] as const;

/**
 * 연출이 화면을 가져가는 동안 `onChange(true)`, 끝나면 `onChange(false)` 를 부른다. 값이 **바뀔 때만** 부른다
 * (연출 두 개가 겹쳐도 한 번). 돌려주는 함수를 부르면 구독이 끊긴다 — 끊을 때 숨은 상태였다면 `onChange(false)`
 * 로 되돌려 주므로, teardown 경로에서 블로커가 새지 않는다.
 *
 * 첫 호출은 **지금 상태**로 한 번 한다: 이미 `'docking'` 페이즈이거나 워프 중(`ctx.hub.travelling`)이면 곧장
 * 숨는다 (연출 도중에 생긴 팝업 — 이벤트는 이미 지나갔다).
 */
export function watchCutsceneHide(
  ctx: GameContext,
  onChange: (hidden: boolean) => void,
  opts?: CutsceneHideOpts,
): () => void {
  const kinds = new Set<CutsceneKind>(opts?.kinds ?? CUTSCENE_KINDS);
  const running = new Set<CutsceneKind>();
  let hidden = false;
  const unsubs: Array<() => void> = [];

  const apply = (): void => {
    const next = running.size > 0;
    if (next === hidden) return;
    hidden = next;
    onChange(hidden);
  };
  const set = (kind: CutsceneKind, on: boolean): void => {
    if (!kinds.has(kind)) return;
    if (on) running.add(kind); else running.delete(kind);
    apply();
  };

  const b = ctx.bus;
  unsubs.push(
    b.on('hub:docking', ({ stage }) => set('docking', stage === 'start')),
    b.on('hub:travel', ({ stage }) => set('travel', stage === 'start')),
    b.on('ui:cinematic', ({ active }) => set('liftoff', active)),
  );
  for (const ev of RESET_EVENTS) unsubs.push(b.on(ev, () => { running.clear(); apply(); }));

  // 연출 도중에 생긴 가입자 — 이벤트는 이미 지나갔으므로 상태에서 읽는다 (`CutsceneWatch` 와 같은 보정)
  if (kinds.has('docking') && ctx.phase === 'docking') running.add('docking');
  if (kinds.has('travel') && (ctx.hub?.travelling ?? false)) running.add('travel');
  apply();

  return () => {
    for (const u of unsubs) u();
    unsubs.length = 0;
    running.clear();
    apply();
  };
}
