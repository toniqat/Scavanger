/**
 * src/shared/charBuffView.ts — **캐릭터 버프 썸네일 줄을 다른 폴더가 빌려 쓰는 자리** (2026-09-17, 사용자 결정 「캐릭터 탭의 이름 옆에
 * 버프 · 디버프 썸네일, 호버하면 툴팁」).
 *
 * 썸네일 줄의 그림(글리프 · 색 · 시간 게이지 · 요리 별 배지 · 이름 줄)은 `ui/hud/BuffStrip` 하나가 그린다. progression 의 캐릭터
 * 시트도 같은 줄을 써야 하지만 폴더끼리 import 하지 않으므로, ui 가 모듈을 불러올 때 공장 함수를 여기에 **등록**하고
 * (`provideCharBuffStrip`) 다른 폴더는 `createCharBuffStrip` 으로 받는다. 등록 전(ui 가 없는 스모크 · 스켈레톤)이면 null 이다 —
 * 부르는 쪽은 썸네일 없이 그린다.
 *
 * `interactive: true` = 썸네일이 마우스를 받는다 — 칸마다 공용 글 카드 속성(`data-tip-name` · `-sub` · `-desc` · `-color`)이 찍혀
 * `ui/hud/ItemTip` 이 호버 카드를 띄운다. HUD 의 줄(체력바 아래 · 분대 목록)은 기본값 false 그대로 `pointer-events: none` 이다.
 */
import type { GameContext } from './GameContext';
import type { CharBuff } from './charBuffs';

export interface CharBuffStripOptions {
  /** 분대 목록 크기 (14 px). */
  mini?: boolean;
  /** 호버 카드 (위 설명). 기본 false. */
  interactive?: boolean;
}

export interface CharBuffStripView {
  readonly root: HTMLElement;
  /** 새 목록 (같은 참조면 아무것도 안 한다). */
  set(list: readonly CharBuff[] | null | undefined, ctx: GameContext | null): void;
  /** 시간 게이지 — 자주 불러도 된다 (1 초에 한 번만 다시 쓴다). */
  update(ctx: GameContext | null): void;
  readonly count: number;
  dispose(): void;
}

export type CharBuffStripFactory = (parent: HTMLElement, opts?: CharBuffStripOptions) => CharBuffStripView;

let factory: CharBuffStripFactory | null = null;

/** ui 전용: 썸네일 줄 공장을 등록한다 (마지막 등록이 이긴다). */
export function provideCharBuffStrip(f: CharBuffStripFactory): void { factory = f; }

/** 썸네일 줄 하나를 `parent` 안에 만든다. ui 가 아직 등록하지 않았으면 null. */
export function createCharBuffStrip(parent: HTMLElement, opts?: CharBuffStripOptions): CharBuffStripView | null {
  try { return factory ? factory(parent, opts) : null; } catch { return null; }
}
