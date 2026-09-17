#!/usr/bin/env node
/**
 * SCAVANGER — CSS 클래스 접두사 검사: **한 접두사는 한 폴더** (CLAUDE.md §4.1).
 *
 * 왜 검사가 필요한가 — 이 프로젝트의 스타일시트는 전부 한 번들로 합쳐지는 **전역**이다. 그래서 두 폴더가
 * 같은 접두사를 고르면 한쪽이 선언한 규칙이 다른 쪽 화면에 그대로 걸리는데, 타입체크도 스모크도 그것을 못
 * 본다 — 클래스는 문자열이고, 겹친 규칙은 오류가 아니라 **조용히 어긋난 그림**이기 때문이다. 실제로
 * `hub/intel.css` 가 `ui` 의 아이템 카드와 같은 `.it-` 를 골라 전역 `.it-head { align-items: flex-end }` 를
 * 선언했고, 세로 flex 에서 그것은 곧 「오른쪽 정렬」이라 기업 거래 · 제작 재료칩 · 서재 전시대 · 연산
 * 클러스터에서 카드 이름 · 종류만 오른쪽에 붙었다 (2026-09-17 에 `.his-` · `.itip-` 로 갈라 닫았다 — B-18).
 * 규약(`rg "\.<prefix>-" src` 해보고 고르기)은 사람이 잊으면 끝이라, 그 확인을 여기로 옮긴다.
 *
 * **무엇을 「선언」으로 보는가** — 선택자의 **첫 컴파운드**에 있는 클래스만 본다. 첫 컴파운드는 그 규칙이
 * 스스로 이름을 대는 자리이고, 그 뒤는 남의 이름을 자기 안에서 덮는 **정당한 스코프**다:
 *
 *   .his-row { … }             → hub 가 `his` 를 선언   (검사 대상)
 *   .item-tip .itip-head { … } → ui 가 `item` 을 선언, `itip` 은 그 안으로 스코프됐다 (대상 아님)
 *   .hmt-tile.is-bot { … }     → hub 가 `hmt` 를 선언 — 한 컴파운드에서도 **맨 앞 클래스 하나**만 본다.
 *                                 뒤에 붙은 것(`is-bot` · `in-band` · `no-holo`)은 그 클래스를 **한정**하는
 *                                 modifier 이지 새 이름을 대는 자리가 아니다.
 *
 * 그래서 「남의 카드를 자기 화면 안에서만 손본다」는 멀쩡한 방어는 통과하고, 전역으로 새는 것만 걸린다.
 *
 * 쓰기: `node scripts/check-css-prefixes.mjs` (브라우저도 vite 도 필요 없다 · 0.1 초).
 * `scripts/verify.mjs` 의 선행 검사에 typecheck · data-check 와 나란히 물려 있어 따로 부를 일은 드물다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/**
 * 예외 — 접두사마다 **누가 선언해도 되는지**. 두 종류뿐이다:
 *
 *  - `also` 가 없으면 **공용 틀**이다: 한 폴더가 소유하고 다른 폴더가 자기 클래스에 덧붙여 쓰라고 내놓은
 *    이름이라 어느 폴더에 나와도 충돌이 아니다.
 *  - `also` 가 있으면 **그 폴더만** 같이 선언해도 된다 — 「남의 것을 전역으로 덮는다」가 사고가 아니라
 *    결정인 경우다. 목록에 없는 폴더가 끼면 그대로 빨강이다.
 *
 * 새 이름을 함부로 더하지 말 것 — 하나 더할 때마다 이 검사가 그만큼 눈을 감는다. 더한다면 `why` 를 같이
 * 적고, 그 이유는 덮는 코드 바로 위 주석에도 있어야 한다.
 */
const SHARED = new Map([
  ['ui', { owner: 'ui' }],            // .ui-btn · .ui-label · .ui-panel · .ui-input — base.css 의 위젯 틀
  ['is', { owner: 'ui' }],            // .is-on · .is-locked … 상태 modifier — 보통 자기 클래스에 붙지만 `.hold.is-giveup` 처럼
                                      // 접두사 없는 틀 클래스에 붙기도 한다
  ['has', { owner: 'ui' }],           // .has-contract … 상태 modifier
  ['item', { owner: 'ui' }],          // .item-chip · .item-tip — 아이템 칩 / 카드
  ['scr', { owner: 'ui' }],           // .scr-tabs · .scr-tab — 터미널풍 탭 틀
  ['kc', { owner: 'ui' }],            // 키캡 (`shared/keycap.ts` 가 칠한다)
  ['kcm', { owner: 'ui' }],           // 키캡 마우스 글리프
  ['inv', { owner: 'inventory' }],    // .inv-tile · .inv-screen — 격자 칸 틀 (meta · housing 이 자기 카드 안에서 쓴다)
  ['tg', { owner: 'inventory' }],     // TradeGrids 내부
  ['trade', { owner: 'inventory' }],  // .trade-grids
  ['hub', { owner: 'hub' }],          // .hub-section · .hub-head · .hub-foot — 함선 화면 틀
  ['char', { owner: 'ui', also: ['progression'],
    why: '`char-sheet`(progression) · `char-select` · `char-create`(ui) 는 **화면 루트 이름**이지 접두사 가족이 아니다 — '
       + '셋 다 그 자체로 온전한 이름이고 자식은 각자 다른 접두사(`cs-` · `cc-`)를 쓴다. 새 `.char-*` 를 가족처럼 늘리지 말 것.' }],
  ['cursor', { owner: 'ui', also: ['game'],
    why: '`ui/hud/GameCursor` 가 런타임 <style> 로 칠하는 `body.cursor-ui` 를 `game/resume-gate.css` 가 일부러 이긴다 '
       + '(데스크톱 셸에서 커서 숨김 — 같은 특정도면 나중 것이 이기므로 클래스를 하나 더 얹었다).' }],
  ['facility', { owner: 'ui', also: ['housing'],
    why: '시설 레벨 요구 칩(`shared/itemChip.buildFacilityChip`)의 **보이는 것만** housing 이 덮는다 (2026-09-15 결정): '
       + '칩을 쓰는 네 화면 중 셋이 housing 것이고, base.css 의 정사각형 규칙과 같은 값이라 겹쳐도 그림이 같다.' }],
]);

/** `.xx-yyy` 꼴 클래스에서 접두사만. */
const CLASS_RE = /\.([a-z][a-z0-9]*)-[a-z0-9-]+/g;

/** src 아래 모든 .css. */
function cssFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) cssFiles(p, out);
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/**
 * 선택자 목록에서 **첫 컴파운드**만 잘라낸다 — 공백 · `>` · `+` · `~` 앞까지. 괄호 안(`:is(a, b)`)의
 * 쉼표는 선택자 구분이 아니므로 깊이를 세면서 자른다.
 */
function firstCompounds(selectorList) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of selectorList) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim().split(/[\s>+~]/)[0]).filter(Boolean);
}

/** 규칙 하나하나를 돌려준다 — `{`/`}` 깊이를 세므로 `@media` 안에 든 것도 놓치지 않는다. */
function* rules(css) {
  const re = /([^{}]*)([{}])/g;
  let m;
  while ((m = re.exec(css))) {
    const prelude = m[1].trim();
    if (m[2] === '}') continue;
    if (!prelude || prelude.startsWith('@')) continue;   // at-rule 머리는 선택자가 아니다
    yield { prelude, index: m.index };
  }
}

const decls = new Map();   // prefix → folder → [{file, line, selector}]
let fileCount = 0;

for (const file of cssFiles(SRC)) {
  fileCount++;
  const folder = path.relative(SRC, file).split(path.sep)[0];
  const raw = fs.readFileSync(file, 'utf8');
  // 주석을 같은 길이의 공백으로 바꿔 둔다 — 줄 번호가 어긋나지 않는다.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const { prelude, index } of rules(css)) {
    const line = css.slice(0, index).split('\n').length;
    for (const compound of firstCompounds(prelude)) {
      const prefix = CLASS_RE.exec(compound)?.[1];   // 맨 앞 클래스 하나 — 뒤는 modifier 다
      CLASS_RE.lastIndex = 0;
      const shared = prefix ? SHARED.get(prefix) : undefined;
      if (!prefix || (shared && !shared.also)) continue;
      const byFolder = decls.get(prefix) ?? decls.set(prefix, new Map()).get(prefix);
      const list = byFolder.get(folder) ?? byFolder.set(folder, []).get(folder);
      list.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line, selector: prelude.split('\n')[0].trim() });
    }
  }
}

/** 그 접두사를 선언해도 되는 폴더 (예외에 적힌 것 + 실제 소유자 한 곳). */
function allowedFolders(prefix) {
  const s = SHARED.get(prefix);
  return s ? new Set([s.owner, ...(s.also ?? [])]) : null;
}

const bad = [...decls.entries()].filter(([prefix, byFolder]) => {
  const allowed = allowedFolders(prefix);
  // 예외가 있는 접두사는 「목록 밖의 폴더가 끼었는가」만 본다 — 없으면 「두 폴더 이상인가」.
  return allowed ? [...byFolder.keys()].some((f) => !allowed.has(f)) : byFolder.size > 1;
}).sort();
for (const [prefix, byFolder] of bad) {
  const allowed = allowedFolders(prefix);
  const tail = allowed ? ` — only ${[...allowed].join(' / ')} may (see SHARED in this script)` : ' — one prefix, one folder (CLAUDE.md §4.1)';
  console.log(`  FAIL .${prefix}- is declared by ${byFolder.size} folders${tail}`);
  for (const [folder, list] of byFolder) {
    const shown = list.slice(0, 3).map((d) => `${d.selector} (${d.file}:${d.line})`);
    console.log(`         src/${folder}/: ${list.length} rule${list.length === 1 ? '' : 's'} — ${shown.join(' · ')}${list.length > 3 ? ' …' : ''}`);
  }
}

const prefixes = decls.size;
if (bad.length) {
  console.log(`  ${bad.length} colliding prefix${bad.length === 1 ? '' : 'es'} over ${prefixes} in ${fileCount} stylesheets`);
  console.log('  Fix: rename one side (usually the smaller set) to a prefix `rg "\\.<new>-" src` finds nothing for,');
  console.log('       or, if it really is a shared frame one folder owns, add it to SHARED in this script and say why.');
  process.exit(1);
}
console.log(`  ok   ${prefixes} class prefixes over ${fileCount} stylesheets, each owned by one folder`);
