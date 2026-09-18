# Code comment translation — remaining plan

Translating every Korean code comment into English so the comments read as documentation for an AI working in this
repo. Started 2026-09-18 on the user's request; the rule itself now lives in **[`CLAUDE.md` §4.1](../CLAUDE.md)** and is
not repeated here. This file only tracks **what is left, in what order, and how to do it safely**.

Delete this file once the queue below is empty.

---

## 1. Status

| | Lines | Files |
|---|---:|---:|
| Done (`src/extraction`, `src/progression`) | 302 | 12 |
| **Remaining** ([§2](#2-queue)) | **26,314** | **735** |

Measured with the script in [§5](#5-measuring). The first estimate in the session that started this work (31,700) was
too high: a naive Hangul grep also counts already-English comments that quote a Korean UI label.

The script still reports one Korean line in a finished folder, `src/progression/ui/SheetBody.ts:709`. That is
intentional — the comment is nothing but quoted UI output (`` `『운반 노하우』 +4.0 %` over `책 · 4 / 5권 · 40 %` ``)
and every token in it is a label. So a raw run over everything prints 26,315 / 736, one more than the queue.

---

## 2. Queue

Largest first, because the big folders set the vocabulary the smaller ones reuse. One commit per folder.

| # | Folder | Lines | Files | Notes |
|---|---|---:|---:|---|
| 1 | `src/shared` | 4,187 | 65 | **Read §4 first** — this one selects every smoke. Contract folder; a comment here is the definition other folders point at, so its wording decides the rest of the queue's vocabulary. |
| 2 | `src/world` | 2,988 | 58 | Dense collision / layout invariants (`getSurfaceY` before `resolveCollision`, hull vs box vs ramp). Precision matters more than style here. |
| 3 | `src/enemies` | 2,300 | 71 | `getEnemies()` vs `queryNear` prop rule, nest leash / refill, host-replica sync guards. |
| 4 | `src/ui` | 2,279 | 87 | Heaviest mix of Korean UI strings and comments — expect many backtick-kept labels. |
| 5 | `src/housing` | 2,215 | 55 | Minigame judge bands, furniture access faces, library effects. |
| 6 | `src/inventory` | 1,703 | 53 | |
| 7 | `src/hub` | 1,569 | 40 | Squad dock / cutscene ordering rules. |
| 8 | `src/tutorial` | 1,278 | 11 | Only 11 files — very long per-file headers. |
| 9 | `src/player` | 949 | 30 | |
| 10 | `src/items` | 612 | 12 | |
| 11 | `src/gadgets` | 573 | 22 | |
| 12 | `src/allies` | 561 | 22 | |
| 13 | `src/game` | 537 | 14 | |
| 14 | `src/meta` | 305 | 15 | |
| 15 | `src/audio` | 273 | 2 | |
| 16 | `src/weapons` | 204 | 17 | |
| 17 | `src/net` | 167 | 14 | |
| 18 | `src/stratagems` | 124 | 7 | |
| 19 | `src/core` | 67 | 5 | |
| 20 | `src/console` | 61 | 11 | |
| 21 | `src/implants` | 43 | 8 | Already mostly English. |
| 22 | `src/pickups` | 31 | 2 | |
| 23 | `src/main.ts` | 7 | 1 | Selects every smoke (see §4) — fold into the `src/shared` commit rather than running the full net twice. |
| 24 | `server/` | 267 | 9 | `RelayServer.ts` 66 · `Lobby.ts` 55 · `selftest.ts` 53 · `Store.ts` 22 · `CryptoMarket.ts` 19 · `Economy.ts` 15 · `Rooms.ts` 14 · `Console.ts` 13 · `index.ts` 10. Verified by `npm run typecheck:server` + `net:selftest`, not by folder smokes. |
| 25 | `electron/` | 52 | 2 | `main.ts` 50 · `wsProxy.ts` 2. Touching `electron/` makes `verify` run `smoke-desktop`. |
| 26 | `scripts/` | 2,962 | 102 | Last on purpose — these are the verification harness. Changing a runner's comments cannot break the game, but a bad edit hides a real failure, so do this only once the game code is done and green. Biggest: `verify.mjs` 199 · `smoke-tutorial.mjs` 185 · `smoke-housing.mjs` 123 · `smoke-inventory-p6.mjs` 121 · `smoke-cooking.mjs` 95. |

`data/*.csv` is **out of scope** — its Korean columns are in-game display text.

---

## 3. Working method

Per folder:

1. **Measure** the folder (§5) and list its files by Korean-comment count, biggest first.
2. **Read** each file's Korean regions before editing. Never translate from the grep line alone — most of these
   comments explain a decision, and the surrounding code is what tells you whether 「걷는다」 means *walks* or
   *is removed*.
3. **Apply** with an exact-string replacement script (Python) written into the scratchpad directory, one batch per
   region of the file. Each replacement asserts its source string is present and exits non-zero on a miss, so a
   silently-skipped block is impossible.
   - Write the script with the **Write tool**, not a Bash heredoc — a heredoc eats one layer of backslashes even with
     a quoted delimiter.
   - `io.open(path, 'w', encoding='utf-8', newline='')`. This writes LF; `core.autocrlf=true` restores CRLF on
     checkout, so the diff shows only the comment lines.
4. **Prove no code changed** before committing:
   ```sh
   git diff -U0 -- src | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
     | sed 's/^[+-]//' | sed 's/^[[:space:]]*//' | grep -vE '^(\*|//|/\*)' | grep -v '^$' | sort -u
   ```
   Every surviving line must be a code line carrying a **trailing** comment, and must appear twice — once per side —
   with identical code. Anything else is a real code edit and has to be reverted.
5. **Verify** (§4), then **commit** (§6).

### What never changes

String literals, csv keys, event names, class names, CSS class names. This includes developer-facing Korean strings
that are not comments — e.g. the `data:check` diagnostic in `src/progression/defs.ts`
(`r.report('derived', '값이 비었다 — …')`). Those are program output, not comments; converting them is a separate
decision nobody has made.

---

## 4. Verification

`npm run verify` picks smokes from the touched folders. Run `node scripts/verify.mjs --dry-run` first to see the
selection.

- **A normal feature folder** costs roughly what the pilot did (16 scripts, ~6 min).
- **`src/shared`, `src/core`, `src/main.ts`** select **everything**. A narrow `src/shared` change (≤ 2 code files and
  ≤ 3 feature folders) narrows the selection, but a comment pass touches far more than that, so budget a full
  `verify:all`-sized run (~17 min) for queue items 1 and 23 — and do them in **one** commit so that run happens once.
- **`server/`** is covered by `npm run typecheck:server` and `npm run net:selftest`.
- **`electron/`** adds `smoke-desktop`.
- **`scripts/`** — a runner's own comments are not covered by any smoke. After that batch, run `npm run verify:all`
  once and confirm the script count and pass totals match the run before it.

A comment-only change that turns a smoke red means the edit was not comment-only. Check §3 step 4 before debugging
anything else.

---

## 5. Measuring

A plain `grep -P '[\x{AC00}-\x{D7A3}]'` over-counts by ~20 %: it also matches English comments quoting a Korean UI
label, and every Korean string literal. Count comment lines that are actually **Korean prose** instead — the comment
is parsed out, and a line counts only when it holds ≥ 4 Hangul syllables *and* Hangul is ≥ 35 % of its letters.

Save as `<scratchpad>/kc.mjs` and run `node kc.mjs src server electron` (add `--files` for a per-file listing):

```js
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = execSync(`git ls-files ${dirs.join(' ')}`, { encoding: 'utf8' })
  .split('\n').filter((f) => /\.(ts|mjs|js|cjs)$/.test(f));

const HAN = /[가-힣]/g;
const per = new Map();

for (const f of files) {
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  let inBlock = false, n = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    let comment = null;
    if (inBlock) {
      comment = line.replace(/^\*+\s?/, '');
      if (line.includes('*/')) inBlock = false;
    } else if (line.startsWith('/*')) {
      comment = line.replace(/^\/\*+\s?/, '');
      if (!line.includes('*/')) inBlock = true;
    } else if (line.startsWith('//')) {
      comment = line.slice(2);
    } else {
      const i = raw.indexOf('//');
      // Trailing comment, but not a URL and not one inside a string literal.
      if (i > 0 && raw[i - 1] !== ':' && !/['"`]/.test(raw.slice(i))) comment = raw.slice(i + 2);
    }
    if (comment == null) continue;
    const han = (comment.match(HAN) || []).length;
    const letters = (comment.match(/[\p{L}\p{N}]/gu) || []).length;
    // A Korean sentence, not an English comment quoting a Korean UI name.
    if (han >= 4 && letters > 0 && han / letters >= 0.35) n++;
  }
  if (n) per.set(f, n);
}

if (process.argv.includes('--files')) {
  for (const [f, n] of [...per].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), f);
  process.exit(0);
}

const byDir = new Map();
for (const [f, n] of per) {
  const d = f.split('/').slice(0, 2).join('/');
  const e = byDir.get(d) || { lines: 0, files: 0 };
  e.lines += n; e.files++; byDir.set(d, e);
}
const rows = [...byDir].sort((a, b) => b[1].lines - a[1].lines);
let tl = 0, tf = 0;
for (const [d, e] of rows) {
  tl += e.lines; tf += e.files;
  console.log(d.padEnd(24), String(e.lines).padStart(6), String(e.files).padStart(5));
}
console.log('-'.repeat(38));
console.log('TOTAL'.padEnd(24), String(tl).padStart(6), String(tf).padStart(5));
```

A folder is done when its count reaches 0, or when every remaining line is quoted-label-only (as in §1).

---

## 6. Recording a finished folder

- **Commit** per folder, paths given explicitly (`git add src/<folder>`), with the runner's `docs line:` as the
  `검증:` line. Commit messages stay Korean, like every other commit here.
- **That folder's `README.md`**: one line at the top of `Recent changes`, drop the bottom one. Wording used so far:
  > `- 2026-09-18 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels kept verbatim in backticks, no string literal touched.`
- **Tick the row off** in §2 and update §1's totals.
- Nothing goes in `docs/HISTORY.md` or `docs/DECISIONS.md` — the rule change is already recorded in `CLAUDE.md` §4.1,
  and per-folder progress is this file plus `git log`.
