/* ════════════════════════════════════════════════════════════════════════════
 * 아이템 설명의 **인라인 마크업** (2026-09-15, 가젯 개편 · 사용자 결정)
 *
 * `data/items.csv` 의 `description` 은 지금까지 통짜 문자열이었고 두 툴팁이 `textContent` 로 그대로 찍었다.
 * 사용자가 아드레날린 주사의 설명에 「강조색상 · 회색색상 · 줄바꿈」을 지정하면서 **글자 단위 색**이 필요해졌다.
 *
 * 새 개념을 만들지 않았다 — `shared/keycap.renderKeyText` 가 이미 쓰는 **중괄호 토큰** 규약 그대로다:
 *
 *   `{em}…{/em}`   강조색 (툴팁마다 자기 강조색을 쓴다: 카드 `--c-accent` · 인벤토리 `--inv-accent`)
 *   `{dim}…{/dim}` 흐린 회색 (`--c-text-dim` · `--inv-muted`)
 *   `{br}`         줄바꿈
 *
 * 파서는 **순수**하다 (`src/items` 는 DOM 을 만들지 않는다) — 줄 단위 조각 목록을 돌려주고, 그림은
 * `ui/hud/ItemTip` 과 `inventory/ui/Tooltip` 이 각자 자기 색으로 그린다 (같은 함수를 부르므로 문장은 하나다).
 * 모르는 토큰(`{foo}`)은 **글자 그대로** 남는다 — 오래된 csv 가 조용히 잘려 나가지 않는다.
 * ════════════════════════════════════════════════════════════════════════════ */

/** 조각의 글자색. `plain` = 그 툴팁의 본문 색. */
export type ItemTextStyle = 'plain' | 'em' | 'dim';

export interface ItemTextSpan {
  readonly text: string;
  readonly style: ItemTextStyle;
}

/** 한 줄 = 조각 목록. `parseItemText` 는 언제나 최소 한 줄을 돌려준다. */
export type ItemTextLine = readonly ItemTextSpan[];

const TOKEN = /\{(\/?)(em|dim|br)\}/g;

/**
 * 설명 문자열 → 줄마다의 조각 목록. 마크업이 하나도 없으면 `[[{ text, style: 'plain' }]]` 이다
 * (그래서 부르는 쪽에 「마크업이 있는가」 분기가 필요 없다).
 */
export function parseItemText(text: string): ItemTextLine[] {
  const lines: ItemTextSpan[][] = [[]];
  let style: ItemTextStyle = 'plain';
  let at = 0;
  const push = (s: string): void => { if (s) lines[lines.length - 1].push({ text: s, style }); };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    if (name === 'br') {
      if (closing) push(m[0]);            // `{/br}` 같은 건 토큰이 아니다 — 글자로 둔다
      else lines.push([]);
    } else if (closing) {
      style = 'plain';
    } else {
      style = name as ItemTextStyle;
    }
  }
  push(text.slice(at));
  return lines.map((l) => l.filter((s) => s.text.length > 0));
}

/** 마크업을 걷어낸 맨 글자 (툴팁 밖에서 설명이 필요한 곳 · 검색 · 스모크용). */
export function plainItemText(text: string): string {
  return parseItemText(text).map((l) => l.map((s) => s.text).join('')).join(' ');
}
