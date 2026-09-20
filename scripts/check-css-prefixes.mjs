#!/usr/bin/env node
/**
 * SCAVANGER — the CSS class prefix check: **one prefix, one folder** (CLAUDE.md §4.1).
 *
 * Why the check is needed — every stylesheet in this project is merged into one bundle, which makes it **global**. So
 * when two folders pick the same prefix, a rule one of them declares lands on the other's screen as it is, and neither
 * the typecheck nor a smoke sees it — a class is a string, and an overlapping rule is not an error but a **silently
 * wrong picture**. It really happened: `hub/intel.css` picked the same `.it-` as `ui`'s item card and declared a global
 * `.it-head { align-items: flex-end }`, which in a vertical flex means 「align right」, so in the corp trade · the craft
 * material chips · the library display stands · the compute cluster only the card's name · kind ended up on the right
 * (closed 2026-09-17 by splitting them into `.his-` · `.itip-` — B-18).
 * The convention (pick one after `rg "\.<prefix>-" src`) ends the moment a person forgets it, so that check moves here.
 *
 * **What counts as a 「declaration」** — only a class in the selector's **first compound**. The first compound is where
 * a rule gives its own name; everything after it is a **legitimate scope** covering someone else's name inside its own:
 *
 *   .his-row { … }             → hub declares `his`   (checked)
 *   .item-tip .itip-head { … } → ui declares `item`, `itip` is scoped inside it (not checked)
 *   .hmt-tile.is-bot { … }     → hub declares `hmt` — even within one compound only the **first class** is looked at.
 *                                 What follows (`is-bot` · `in-band` · `no-holo`) is a modifier that **qualifies**
 *                                 that class, not a place where a new name is given.
 *
 * So the sound defence 「someone else's card is touched only inside my own screen」 passes, and only what leaks globally is caught.
 *
 * Run it: `node scripts/check-css-prefixes.mjs` (no browser and no vite · 0.1 s).
 * It hangs in `scripts/verify.mjs`'s up-front checks beside typecheck · data-check, so calling it on its own is rare.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/**
 * The exceptions — **who may declare** each prefix. There are only two kinds:
 *
 *  - With no `also` it is a **shared frame**: a name one folder owns and puts out for other folders to add to their own
 *    classes, so it is no collision wherever it turns up.
 *  - With `also` it may be declared by **those folders too** — the case where 「covering someone else's globally」 is a
 *    decision and not an accident. A folder that is not on the list joins in and it is red on the spot.
 *
 * Do not add new names lightly — each one added closes this check's eyes by that much. If you add one, write the `why`
 * with it, and that reason has to be in the comment right above the covering code as well.
 */
const SHARED = new Map([
  ['ui', { owner: 'ui' }],            // .ui-btn · .ui-label · .ui-panel · .ui-input — base.css's widget frames
  ['is', { owner: 'ui' }],            // .is-on · .is-locked … state modifiers — usually attached to their own class, but
                                      // also to a prefixless frame class, as in `.hold.is-giveup`
  ['has', { owner: 'ui' }],           // .has-contract … a state modifier
  ['item', { owner: 'ui' }],          // .item-chip · .item-tip — the item chip / card
  ['scr', { owner: 'ui' }],           // .scr-tabs · .scr-tab — the terminal-style tab frame
  ['kc', { owner: 'ui' }],            // keycaps (painted by `shared/keycap.ts`)
  ['kcm', { owner: 'ui' }],           // the keycap mouse glyph
  ['inv', { owner: 'inventory' }],    // .inv-tile · .inv-screen — the grid cell frame (meta · housing use it inside their own cards)
  ['tg', { owner: 'inventory' }],     // inside TradeGrids
  ['trade', { owner: 'inventory' }],  // .trade-grids
  ['hub', { owner: 'hub' }],          // .hub-section · .hub-head · .hub-foot — the ship screen frame
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

/** Just the prefix out of a `.xx-yyy`-shaped class. */
const CLASS_RE = /\.([a-z][a-z0-9]*)-[a-z0-9-]+/g;

/** Every .css under src. */
function cssFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) cssFiles(p, out);
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

/**
 * Cuts out only the **first compound** of a selector list — up to a space · `>` · `+` · `~`. A comma inside
 * parentheses (`:is(a, b)`) does not separate selectors, so the cut counts depth as it goes.
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

/** Yields the rules one by one — it counts `{`/`}` depth, so one inside an `@media` is not missed either. */
function* rules(css) {
  const re = /([^{}]*)([{}])/g;
  let m;
  while ((m = re.exec(css))) {
    const prelude = m[1].trim();
    if (m[2] === '}') continue;
    if (!prelude || prelude.startsWith('@')) continue;   // an at-rule's head is not a selector
    yield { prelude, index: m.index };
  }
}

const decls = new Map();   // prefix → folder → [{file, line, selector}]
let fileCount = 0;

for (const file of cssFiles(SRC)) {
  fileCount++;
  const folder = path.relative(SRC, file).split(path.sep)[0];
  const raw = fs.readFileSync(file, 'utf8');
  // Comments are replaced by spaces of the same length — that way the line numbers do not drift.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  for (const { prelude, index } of rules(css)) {
    const line = css.slice(0, index).split('\n').length;
    for (const compound of firstCompounds(prelude)) {
      const prefix = CLASS_RE.exec(compound)?.[1];   // the first class only — what follows is a modifier
      CLASS_RE.lastIndex = 0;
      const shared = prefix ? SHARED.get(prefix) : undefined;
      if (!prefix || (shared && !shared.also)) continue;
      const byFolder = decls.get(prefix) ?? decls.set(prefix, new Map()).get(prefix);
      const list = byFolder.get(folder) ?? byFolder.set(folder, []).get(folder);
      list.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line, selector: prelude.split('\n')[0].trim() });
    }
  }
}

/** The folders that may declare that prefix (the ones in the exception + its one real owner). */
function allowedFolders(prefix) {
  const s = SHARED.get(prefix);
  return s ? new Set([s.owner, ...(s.also ?? [])]) : null;
}

const bad = [...decls.entries()].filter(([prefix, byFolder]) => {
  const allowed = allowedFolders(prefix);
  // A prefix with an exception is only asked 「did a folder outside the list join in」 — one without, 「is it more than one folder」.
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
