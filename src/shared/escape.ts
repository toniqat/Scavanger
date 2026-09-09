/* ────────────────────────────────────────────────────────────────────────────
 * Escape 닫기 스택 (2026-09-09). Owner: shared/ — 계약이므로 추가만 한다.
 *
 * **사람은 커서가 보이면 그 창을 ESC 로 닫으려 한다.** 2026-09-08 에는 그 반대를 골랐다 — `Escape` 는 일시정지
 * 메뉴를 여는 키 하나였고 화면은 자기를 연 키(Tab · M · P · E)로만 닫혔다. 이유는 브라우저였다: Escape 에는
 * user activation 이 없어서 그 키로 화면을 닫으면 `main.ts` 의 재락이 거부되고 커서가 남는다.
 *
 * 그 이유는 이제 절반만 남았다. 데스크톱 셸은 ESC **key-up** 마다 메인 프로세스가 activation 을 만들어
 * `window.__scavShellRelock` 을 부르므로(`electron/main.ts`) 카메라가 즉시 돌아오고, 브라우저에서는 이미 있는
 * `좌측 클릭으로 게임 재개` 게이트(`game/ResumeGate`)가 그 한 클릭을 받는다 — 원래 이 상황을 위해 만든 UI다.
 * 그래서 **ESC 로 화면을 닫는 것은 양쪽 다 허용하고**, 일시정지 메뉴 자체를 ESC 로 닫는 것만 셸 전용으로 둔다
 * (`isDesktopShell()`, `ui/menus/PauseMenu`).
 *
 * 왜 시스템 등록 순서로는 안 되나: Tab 공용 닫기는 각 화면이 자기 `update()` 에서 키를 읽고 `input.consume` 하는
 * 방식인데, 그러면 닫히는 순서가 **시스템 등록 순서**(`main.ts`)로 정해진다. 지도 위에 함선 관리 패널이 떠 있으면
 * 위에 있는 패널이 아니라 먼저 등록된 시스템이 닫힌다. ESC 는 "가장 위 하나만" 이 사용자 결정이라 열린 순서가
 * 필요하고, 그것을 아는 곳은 여기뿐이다 — 화면은 열 때 `push`, 닫을 때 `remove` 하고
 * `game/GameFlowSystem` 이 ESC 를 받으면 `closeTop()` 을 먼저 부른다(false 면 그때 일시정지 메뉴).
 *
 * 커서/블로커와 짝이다: `push` 는 `ctx.uiBlockers.add` 옆에, `remove` 는 `delete` 옆에 둔다. 그러면 teardown
 * 경로가 여러 개인 화면(`close()` · `hide()` · `dispose()` · 페이즈 변경)도 저절로 정리된다.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 한 화면의 Escape 동작. **`false` 를 돌려주면 스택에 그대로 남는다** — 화면 안에서 한 걸음만 되돌린 경우
 * (하우징 모드가 들고 있던 가구만 내려놓고 모드는 유지하는 것처럼). 그 밖의 반환값(보통 `void`)은
 * "이 화면은 닫혔다" 는 뜻이라 항목이 빠진다. 남으려면 **`false` 를 돌려준다** — 다시 `push` 하지 않는다.
 */
type EscapeClose = () => boolean | void;

interface EscapeEntry {
  /** Stable id — the surface's `ctx.uiBlockers` token, or `token:sub` when several surfaces share one token. */
  key: string;
  close: EscapeClose;
}

/**
 * 열려 있는 화면들의 Escape 동작을 열린 순서로 들고 있는 스택. `GameContext.escape` 에 하나만 있다
 * (`uiBlockers` 와 같은 격의 계약이므로 ref 인터페이스 없이 직접 쓴다).
 */
export class EscapeStack {
  private readonly entries: EscapeEntry[] = [];

  /**
   * Register (또는 재등록) `close` 를 이 화면의 Escape 동작으로. 같은 `key` 를 다시 push 하면 **맨 위로 올라온다** —
   * 다시 열린 화면은 늘 가장 새 화면이다.
   */
  push(key: string, close: EscapeClose): void {
    this.remove(key);
    this.entries.push({ key, close });
  }

  /** Idempotent — 화면이 가진 모든 teardown 경로에서 그냥 부르면 된다. */
  remove(key: string): void {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /**
   * 가장 최근에 열린 화면 하나를 닫는다 (LIFO). 등록된 것이 없으면 false — 부른 쪽(`game/`)이 그때 일시정지
   * 메뉴를 연다.
   *
   * 닫기 함수가 `false` 를 돌려주면 항목을 남긴다 (화면 안에서 한 걸음만 되돌린 경우). 그 밖에는 항목을
   * 빼는데, 화면의 `close()` 가 이미 `remove` 를 불렀어도 `remove` 는 idempotent 라 문제가 없다.
   */
  closeTop(): boolean {
    const top = this.entries.at(-1);
    if (!top) return false;
    if (top.close() !== false) this.remove(top.key);
    return true;
  }

  /** 맨 위 화면의 key (진단 · 키 가이드용); 비었으면 null. */
  get topKey(): string | null { return this.entries.at(-1)?.key ?? null; }
  get size(): number { return this.entries.length; }
  has(key: string): boolean { return this.entries.some((e) => e.key === key); }
  /** 전부 버린다 (하드 리셋 — 페이즈 변경 · 사망). 닫기 함수는 **부르지 않는다**. */
  clear(): void { this.entries.length = 0; }
}
