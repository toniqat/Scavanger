# Code comment translation — remaining plan

Translating every Korean code comment into English so the comments read as documentation for an AI working in this
repo. Started 2026-09-18 on the user's request; the rule itself now lives in **[`CLAUDE.md` §4.1](../CLAUDE.md)** and is
not repeated here. This file only tracks **what is left, in what order, and how to do it safely**.

Delete this file once the queue below is empty.

> **Next session starts here:** queue item **8, `src/tutorial`** ([§2](#2-queue)). Read [§7 Glossary](#7-glossary)
> before picking any wording, then follow [§3](#3-working-method) — in particular **step 4, which is not the check this
> file originally described**; the old one let a deleted `*/` through. `src/tutorial` is a normal feature folder, so its
> `verify` is a folder-sized run, not the full net. It is only **11 files** with very long per-file headers, so the
> `src/hub` split (six bundles by subject) does not fit — cut it by **track** (`조작 안내` · `함선 안내` · `증축 안내` ·
> `출격 안내`) instead, and keep the four track names Korean (`shared/tutorial.ts:381` already does). Its vocabulary is
> already fixed by §7 (track · step · stretch · checkpoint · the control guide · spotlight · sequential reveal) and by
> CLAUDE.md §4.8's two-track `build` / `raid2` paragraph, which is English and is what these comments point at.

---

## 1. Status

| | Lines | Files |
|---|---:|---:|
| Done (`src/extraction`, `src/progression`, `src/shared`, `src/main.ts`, `src/world`, `src/enemies`, `src/ui`, `src/housing`, `src/inventory`, `src/hub`) | 17,550 | 442 |
| **Remaining** ([§2](#2-queue)) | **9,066** | **305** |

Measured with the script in [§5](#5-measuring). The first estimate in the session that started this work (31,700) was
too high: a naive Hangul grep also counts already-English comments that quote a Korean UI label.

**Intended permanent exceptions.** A finished folder still prints 54 lines, because a comment whose entire substance is
a quoted label, a quoted document heading or a verbatim user decision keeps its Korean (§3 rule 2 — the reader has to be
able to grep it against the real string). So a raw run over everything prints 9,120 / 344, fifty-four more than the
queue. `src/ui` alone contributes 24 — which is what "the heaviest mix of Korean on-screen strings" meant in practice —
so its rows are grouped into one line instead of listed file by file:

| Line | What it quotes |
|---|---|
| `progression/ui/SheetBody.ts:709` | UI output (`` `『운반 노하우』 +4.0 %` over `책 · 4 / 5권 · 40 %` ``) |
| `shared/types.ts:142` | the equip-slot labels (`주무기 I` · `가방` · `방탄복`) |
| `shared/types.ts:1935` | a headline string (`주무기가 없습니다`) |
| `shared/allies.ts:3` | a `docs/DECISIONS.md` section heading |
| `shared/npc.ts:111` | a job title (`헬릭스 조달실장`) |
| `shared/tutorial.ts:381` | the four track names (`조작 안내` · `함선 안내` · `증축 안내` · `출격 안내`) |
| `housing/ui/SocketFlow.ts:100` | the socket-replace popup, body and button (`끼운 소켓은 빼낼 수 없습니다 — 교체하면 <이름>은(는) 파괴됩니다`, red `교체`) |
| `world/Gather.ts:779` | the four harvest prompt verbs (`약초 채집` · `고철 해체` · `토양/씨앗 채취` · `표본 수습`) |
| `enemies/EnemySystem.ts:159` | the bug-nest decision heading (`둥지 반경 60 m 리시 · 초기 수 절반 · 재스폰 50/35/15 %`) |
| `enemies/NestDirector.ts:2` | the same heading, plus `둥지의 장식 알을 부술 수 있는 적으로` |
| `inventory/model.ts:42-44` | the equipment-grid diagram, drawn with the real slot labels (`주무기 I` · `방탄복` · `전술 임플란트` · `주머니`) |
| `inventory/ui/InventoryUI.ts:970` · `:1313-1314` and `ui/parts/ContextMenu.ts:76-77` | the equip-slot labels, and the twin `TEXT.menu.*` entry list (`장착` · `가방으로 이동` · `수리` · `버리기` …) |
| `inventory/parts/Allies.ts:3` · `:163` | a `docs/DECISIONS.md` section heading, and a verbatim user's decision |
| `inventory/ui/TradeGrids.ts:82` · `:762` | a verbatim user's decision and a verbatim user's bug report |
| `ui/` — **24 lines in 18 files** | on-screen strings the prose exists to name: chat / ping / toast / badge texts (`hud/Pings.ts`, `hud/Notifications.ts`, `hud/NetBadge.ts` ×2, `hud/MetaToasts.ts`, `hud/ChatLog.ts`, `hud/RoverHud.ts`, `hud/GadgetHandHint.ts`, `hud/StratagemWheel.ts`, `hud/PingWheel.ts`), tab / row / button labels (`hud/ShipManage.ts`, `hud/ItemTip.ts`, `menus/PauseMenu.ts`, `menus/keybindNotice.ts`, `menus/RewardsBlock.ts`, `menus/messenger/QuestCard.ts` ×3, `menus/social/SocialMenu.ts`, `menus/social/socialSource.ts`) and the four `menus/social/SocialColumn.ts` section dividers, each verbatim the `ui-label` drawn two lines below |
| `hub/parts/Pods.ts:384-385` | the verbatim user decision the raid-entry loading sequence was built from |
| `hub/HousingMode.ts:772` | the three placement refusal strings, verbatim from `housing/Rules.ts` (`앞쪽이 벽에 막힙니다` …) |
| `hub/interiors/AndroidBays.ts:11` | a verbatim user decision plus the `docs/DECISIONS.md` section heading |
| `hub/ui/HubMenu.ts:554` | a verbatim user decision (`보는 행성을 목표로 정해야 정보를 살 수 있게`) |
| `hub/ui/IntelMenu.ts:280` | a verbatim user bug report (`보레아스 IX · 베르단트 III 에서 현상 수배가 잠긴다`) |
| `hub/LaunchPod.ts:25` · `hub/ui/ReadyPanel.ts:29` | the pod tag / ready-cell state strings (`준비 완료` · `대기 중` · `연결 끊김` …) |

---

## 2. Queue

Largest first, because the big folders set the vocabulary the smaller ones reuse. One commit per folder.

| # | Folder | Lines | Files | Notes |
|---|---|---:|---:|---|
| ~~1~~ | ~~`src/shared`~~ | 4,187 | 65 | **Done 2026-09-18** (with `src/main.ts`, one commit, full 96-script `verify`). Its vocabulary is now the queue's vocabulary — read that folder's comments before picking words for a new folder. |
| ~~2~~ | ~~`src/world`~~ | 2,988 | 58 | **Done 2026-09-18** (lead + 6 parallel agents, one commit). Dense collision / layout invariants; its wording is now the reference for every world-shaped folder after it. |
| ~~3~~ | ~~`src/enemies`~~ | 2,300 | 71 | **Done 2026-09-18** (lead + 6 parallel agents, one commit). Its anatomy and AI-phase vocabulary is now the reference for every rig- and AI-shaped folder after it. |
| ~~4~~ | ~~`src/ui`~~ | 2,279 | 87 | **Done 2026-09-18** (lead + 6 parallel agents, one commit). Its screen · card · panel · toast vocabulary is now the reference for every UI-shaped folder after it. 24 quoted-label lines stay Korean (§1). |
| ~~5~~ | ~~`src/housing`~~ | 2,215 | 55 | **Done 2026-09-19** (lead + 7 agents, one commit). One quoted-label-only line stays (§1). Its station · minigame · holder · product vocabulary is now the reference for every furniture- and screen-shaped folder after it. |
| ~~6~~ | ~~`src/inventory`~~ | 1,703 | 53 | **Done 2026-09-19** (lead + 7 agents, one commit). 12 quoted-only lines stay (§1). Its grid · cell · pane · stack · crate · search · bucket · salvage vocabulary is now the reference for every item- and screen-shaped folder after it. |
| ~~7~~ | ~~`src/hub`~~ | 1,569 | 40 | **Done 2026-09-19** (lead + 6 agents, one commit). 8 quoted-only lines stay (§1). Its ship · dock · staging · station vocabulary is now the reference for every hub- and furniture-shaped folder after it. |
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
| ~~23~~ | ~~`src/main.ts`~~ | 7 | 1 | **Done 2026-09-18**, folded into the `src/shared` commit as planned. |
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
   - **Validate every pair before writing anything** (count them all in memory, then write). A script that writes as
     it goes leaves the file half-translated when pair 40 misses, and it is then no longer re-runnable: a later pair
     may match text an earlier pair produced.
   - **Keep each file's own line endings.** The tree is legitimately mixed, so there is no folder-wide convention to
     apply: read the bytes, remember whether CRLF was present, normalise for matching, and write the same convention
     back. Never judge this from `git show HEAD:<file>` — that blob is always LF — and never normalise a file you were
     not asked to touch. The reasoning is under **Splitting a folder**, lead check 1.
   - **The commonest way to break code with a "comment-only" edit is to eat the closing `*/`.** It happens when the
     last Korean line of a block and its `*/` are replaced together by English prose that forgot the `*/`. The block
     then swallows the next declaration. `tsc` does **not** catch it (a missing interface field is not a type error),
     and neither did this file's original step 4. Step 4 below does.
4. **Prove no code changed** before committing — **strip every comment from both sides and compare the whole text.**

   The line-by-line filter this file used to prescribe (grep the diff, drop lines starting with `*` · `//` · `/*`,
   expect what is left to appear once per side) leaks in two places, and the `src/shared` pass proved it: a code line
   carrying a **trailing** comment differs on the two sides because its comment changed, and a continuation line of a
   `/* … */` block that has **no `*` gutter** is read as code. Between the two there is enough noise to hide a real
   edit — it hid a deleted `*/` in `src/shared/progression.ts` that had swallowed `miningRarityBonus: number;`.

   Save as `<scratchpad>/proof.mjs` and run it from the repo root. It is comment-position independent, so re-wrapping
   a comment cannot register:

   ```js
   import { execSync } from 'node:child_process';
   import { readFileSync } from 'node:fs';

   const BS = String.fromCharCode(92); // spelled out so no quoting layer can eat it

   function strip(src) {
     let out = '', i = 0; const n = src.length;
     while (i < n) {
       const c = src[i], d = src[i + 1];
       if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
       if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
       if (c === '"' || c === "'" || c === '`') {            // a string is not a comment — keep it verbatim
         const q = c; out += c; i++;
         while (i < n) {
           if (src[i] === BS) { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
           out += src[i]; if (src[i] === q) { i++; break; } i++;
         }
         continue;
       }
       out += c; i++;
     }
     return out.replace(/[ \t]+/g, ' ').replace(/[ \t]*\r?\n[ \t]*/g, '\n').replace(/\n+/g, '\n').trim();
   }

   const files = execSync('git diff --name-only', { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.ts'));
   let bad = 0;
   for (const f of files) {
     const head = strip(execSync('git show HEAD:' + f, { encoding: 'utf8', maxBuffer: 1 << 28 }));
     const work = strip(readFileSync(f, 'utf8'));
     if (head !== work) {
       bad++;
       console.log('CODE CHANGED:', f);
       const a = head.split('\n'), b = work.split('\n');
       for (let i = 0; i < Math.max(a.length, b.length); i++) {
         if (a[i] !== b[i]) { console.log('   HEAD:', a[i]); console.log('   WORK:', b[i]); break; }
       }
     }
   }
   console.log('files checked: ' + files.length + '   code changes: ' + bad);
   ```

   **Anything but `code changes: 0` is a real edit and has to be reverted.** Filter to `.ts` — a `README.md` in the
   same commit is not code and would report a difference. A mis-parse (a regex literal holding `//`) is harmless here:
   the stripper is deterministic, so it mangles both sides the same way and equality still means the code matches.
5. **Verify** (§4), then **commit** (§6).

### What never changes

String literals, csv keys, event names, wire keys, class names, CSS class names. This includes developer-facing Korean
strings that are not comments — e.g. the `data:check` diagnostic in `src/progression/defs.ts`
(`r.report('derived', '값이 비었다 — …')`). Those are program output, not comments; converting them is a separate
decision nobody has made. `src/world` alone holds a dozen more of them (`Structures.ts` `console.warn`, `Rover.ts` ·
`RoverRoad.ts` `console.info`/`warn`, `Hazard.ts:504`, `structures/model.ts` `data:check` reports) — every folder from
here on will hit the same kind, so leave them and do not re-litigate it per folder.

### Splitting a folder across parallel agents

Four folders were done this way on 2026-09-18 — `src/shared` (4,194 lines, 7 agents), `src/world` (2,988, lead + 6),
`src/enemies` (2,300, lead + 6) and `src/ui` (2,279, lead + 6, **no agent died and no bundle needed recovery**) — and it
works, with three conditions:

1. **The lead fixes the glossary first** ([§7](#7-glossary)) and hands it to every agent. Without it each agent coins
   its own words and the folder reads in six voices — the reason this section exists at all.
2. **Bundles must not overlap**, because the agents edit one shared working tree. Give each agent an explicit file
   list and tell it to touch nothing else — not the folder `README.md`, not this file.
3. **Agents do not run `git add` / `commit` / `typecheck` / `verify`.** The lead runs each once, at the end, over
   everything. An agent that commits its own bundle makes the comment-only proof impossible to run as one check.
4. **The scratchpad directory is shared, so every helper script needs an owner-specific name.** In the `src/housing`
   pass two agents and the lead independently wrote `apply.py`; the last write won and the lead's applier vanished
   mid-run. Say so in the brief (`<subject>_apply.py`) — nothing was lost, but it costs a restart.

**How to cut the bundles**, as the `src/world`, `src/enemies` and `src/ui` passes settled it: six agent bundles of
roughly 300–500 lines each, **and a seventh for the lead** — the contract-ish files the rest of the folder points at
(`WorldSystem` · `layout` · `obb` · `hull`; `EnemySystem` · `Enemy` · `model` · `EnemyTypes`; `HudSystem` · `dom` ·
`KeyGuide` · `allySource`). The lead owns the
glossary anyway, and translating the folder's centre is what makes the glossary it hands out measured rather than
guessed. Cut along **subject lines, not file size** (tutorial · rails + rover · hazard + fog · models + FX · AI core):
an agent that owns one subject never has to read another agent's file to know what a word means. A file far larger
than the rest (`world/tutorial/model.ts`, 500 lines) gets a bundle to itself. Both folders finished in one pass with
no agent deaths at this size.

Ask each agent to report: its final count per file, any quoted-label-only line it left, **any term it had to coin**
(fold those into §7), and any comment it could not resolve from the code.

**Two things the lead has to check afterwards, because an agent cannot see them** (the first bit both passes, the
second `src/world`):
1. **Line endings — and what the `src/enemies` pass corrected about this.** (`src/ui` confirmed it: 14 of its 86 changed
   files are LF in the working tree, every agent preserved what it found, and nothing was converted.) `git show HEAD:<file>` is the *normalised*
   blob (always LF with `core.autocrlf=true`, which this repo uses and has no `.gitattributes` to override), so
   comparing against it proves nothing. Read the working-tree bytes:
   `[f for f in changed if b'\r\n' not in open(f,'rb').read()]` lists the LF ones.
   **But do not convert them by reflex.** The working tree is legitimately mixed: a file a tool wrote with LF stays
   LF on disk (`git add` normalises the blob, not the file), so `src/enemies` had ~20 LF files *before* the pass
   began. The commit is unaffected either way — the blob and this file's §3 step-4 proof both normalise line
   endings — so the rule is **preserve whatever each file already had**, and fix only a file an agent actually
   flipped. The `src/world` pass converted eleven files to CRLF before this was understood; it changed nothing in
   the commit, but it was noise.
2. **One thing, two names.** In `src/ui` it was the **lead's own** bundle that broke it: `HudSystem` said *waking
   cutscene* where `Compass` · `Reticle` · `player/README.md` · CLAUDE.md §3.2 all say **intro wake** — three lines,
   found by grepping the finished folder for each coined noun. Do this even when every agent reported cleanly.
   Earlier: two agents independently coined *ghost block* for `tut_fence_ghost`, which
   `world/README.md` and CLAUDE.md §4.6 already call the **ghost band**; another wrote *an old peer* where the folder's
   existing English says *an older peer*. Grep the finished folder for each newly coined noun and make it agree with
   the English already in the READMEs — that, not the glossary hand-out, is what makes the folder read in one voice.

**When an agent dies mid-bundle** — a rate limit will do it — the tree is left half-translated and its applier script
is **not re-runnable** (a later pair may match text an earlier pair already produced). Do not reason from the agent's
last message about what it finished. **Measure the tree** (§5), and translate whatever is left by hand. Three of seven
agents died this way in the `src/shared` pass and the recovery was cheap precisely because the count is authoritative
and the reports are not.

---

## 4. Verification

`npm run verify` picks smokes from the touched folders. Run `node scripts/verify.mjs --dry-run` first to see the
selection.

- **A normal feature folder** costs 16–25 scripts and ~6 min: 16 for the pilot, 25 for `src/world`, 25 for
  `src/enemies` — whose folder map pulls in **`e2e-mp`**, so a red there is a real two-client run, not a unit check.
  Every remaining queue item except `src/core` is one of these.
- **`src/core`** still selects **everything** (~17 min, 96 scripts), as `src/shared` and `src/main.ts` did — those two
  were done together in one commit on 2026-09-18 so that run happened once.
- **`server/`** is covered by `npm run typecheck:server` and `npm run net:selftest`.
- **`electron/`** adds `smoke-desktop`.
- **`scripts/`** — a runner's own comments are not covered by any smoke. After that batch, run `npm run verify:all`
  once and confirm the script count and pass totals match the run before it.

### Reading a red smoke

**Check §3 step 4 first** — if the proof says `code changes: 0`, the edit really was comment-only and the red is
something else. The `src/shared` run went red twice and neither was the change:

| What happened | How to tell | What to do |
|---|---|---|
| **Load flake.** `smoke-stations` 98/99 in the 4-lane run, 99/99 alone. | Re-run it on its own. | `node scripts/verify.mjs --rerun-failed` |
| **A stale vite handed the smoke a second copy of a module you edited.** `smoke-npc-quests` 68/69, reproducible, `enemy:killed.weaponClass` all null. | The smoke does `await import('/src/…')` on a file you touched **and mutates that module's state**. vite stamps an edited file `?t=…` once it is already up, and the stamp survives a page reload, so the smoke's unstamped import is a second evaluation. | Stop vite, let the runner start a fresh one, re-run. Green. Known instances and the real fix are in [`scripts/README.md`](../scripts/README.md) under `import('/src/…')`. |

Both cost about half an hour to diagnose. Neither is a reason to change game code — and a comment pass reaches files
that smokes import by hand, so expect the second one again whenever a folder holds a module a smoke mutates.

**A red that survives a re-run is still not automatically yours.** The `src/world` pass went red three times and none
of the three was the change: `smoke-phase3` was the flake already documented, `smoke-phase4` reproduced twice and then
went green on a third serial run (a *new* flake symptom, now a row in [`docs/VERIFICATION.md`](VERIFICATION.md)), and
`smoke-rover` reproduced every single time. Settle that last kind without reverting anything by **committing first,
then running the one smoke against the parent's copy of the folder**:

```
git checkout HEAD~1 -- src/<folder>
node scripts/verify.mjs --only smoke-<name> --no-typecheck
git checkout HEAD -- src/<folder>
```

`smoke-rover` failed identically at the parent, which turned "my commit broke the rover" into `docs/TODO.md` B-22 (the
assertion asks for two things it cannot tie to one enemy). Committing first is what makes that checkout safe — this
repo does not use `git stash`.

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

### The ratio gate hides mixed lines — finish with a second sweep

`kc.mjs` under-counts a **line that mixes Korean prose with English**: its Hangul ratio can fall under the 35 % gate.
The `src/shared` pass found four such lines that the counter never flagged (`cursor.ts:2` at 33 %, `events.ts:806`
「브라우저 전용 …」, two `housing.ts` field docs). So never close a folder on `kc.mjs` alone.

Run a second pass with **the same script, three lines swapped**: keep the comment parser above, but replace the
counting test with the one below and print `file:line` instead of tallying. It strips what rule 2 lets stay Korean
(backticks, `「」`, `『』`) and then asks for a Korean sentence ending or particle, so only real prose survives:

```js
const stripped = comment.replace(/`[^`]*`/g, '').replace(/「[^」]*」/g, '').replace(/『[^』]*』/g, '');
const PROSE = /(한다|된다|않는다|없다|있다|이다|간다|온다|낸다|한 번|그대로|때문|해야|하면|이고|이며|라서|이라|에서|으로|에게|만큼|처럼|뿐|지만)/;
if ((stripped.match(/[가-힣]/g) || []).length >= 4 && PROSE.test(stripped)) report(file, line);
```

Its remaining false positives are English sentences that quote a Korean label in `'…'` rather than backticks — read
them, do not translate them.

**Two things slip past *both* gates, in every folder — grep for them by hand before closing one** (`src/housing`
found six of the second kind in one bundle alone):

1. A **short Korean divider**: `/* ── 도감 ── */`, `/* ── 헬스장 (A-3a) 끝 ══ */`. Under four Hangul syllables it is
   invisible to `kc.mjs`, and it carries no sentence ending, so the prose sweep skips it too.
2. The word **`한국어` used as a plain adjective** inside an already-English line (`한국어 reason`, `한국어 item
   name`). The Hangul ratio is far under the gate and there is no verb. It is a concept, not a label → **Korean**.

The cheap catch for both is one pass over *every* comment line holding any Hangul at all, with backticks, `「」`,
`『』` and quoted strings stripped first; read the hits rather than counting them (a finished folder still prints a
few hundred, because a Korean **label** inside English prose is correct and stays).

---

## 6. Recording a finished folder

- **Commit** per folder, paths given explicitly (`git add src/<folder>`), with the runner's `docs line:` as the
  `검증:` line. Commit messages stay Korean, like every other commit here.
- **That folder's `README.md`**: one line at the top of `Recent changes`, drop the bottom one — and the same line in
  any sub-folder that has its own README (`world/structures`). Wording used so far:
  > `- 2026-09-18 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched.`
- **Tick the row off** in §2, update §1's totals, and add any new intended exception to §1's table.
- **A new term** you had to coin goes in [§7](#7-glossary) — that is what keeps the folders reading as one voice.
- **A defect the translation uncovered but did not cause** (a doc that contradicts its code, a stale reference, dead
  code, a csv number copied into prose) goes in [`docs/TODO.md`](TODO.md), **not** fixed in the translation commit —
  the commit has to stay provably comment-only. Filed so far: `B-19` (`src/shared`, 3), `B-20` · `B-21` (`src/world`,
  7 + 4), `B-23` · `B-24` · `B-25` (`src/enemies`, 6 + 4 + 3), `B-27` · `B-28` · `B-29` · `B-30` (`src/ui`, 12 + 6 + 1 + 4),
  `B-32` · `B-33` · `B-34` · `B-35` (`src/housing`, 14 + 8 + 5 + 8),
  `B-36` · `B-37` · `B-38` · `B-39` (`src/inventory`, 20 + 8 + 3 + 2).
  Reading a folder this closely is the most productive defect hunt in the project — expect five to ten per folder (`src/ui`
  gave 23 and `src/housing` 35, each with a live bug in it: a member row that is built and never appended, and a stir-fry
  score whose denominator is the number of clicks that were judged), and keep filing rather than fixing.
- **A gap the pass found in the verification net** goes in [`scripts/README.md`](../scripts/README.md).
- Nothing goes in `docs/HISTORY.md` or `docs/DECISIONS.md` — the rule change is already recorded in `CLAUDE.md` §4.1,
  and per-folder progress is this file plus `git log`.

---

## 7. Glossary

Fixed on 2026-09-18 while translating `src/shared`, and binding from here on: the contract folder's wording is the
wording every other folder points at. Prefer the English **`CLAUDE.md` already uses** for anything not listed, and add
what you coin to the bottom table.

### Domain terms

| Korean | English |
|---|---|
| 함선 · 개인 함선 · 공용 함선 | the ship · personal ship · shared ship |
| 격납고 · 조종실 | hangar · cockpit |
| 레이드 · 출격 · 강하 · 탈출 | raid · launch · the drop (drop pod) · extraction |
| 분대 · 분대원 · 분대장 · 도킹 | squad · squadmate · squad leader · docking |
| 호스트 · 권위 · 중계(서버) · 복제 | the host · the authority (`isAuthority`) · the relay · replica |
| 스냅샷 · 프로필 · 프로필 문서 · 슬롯(저장) | snapshot · profile · profile document · save slot |
| 시체 · 사망 · 다운 · 구조 낙하 | corpse · death · downed · rescue drop |
| 벌레 · 둥지 · 알 · 안드로이드 · 인간형 | bug · nest · egg · android · humanoid |
| 네임드 · 모래벌레 · 땅굴벌레 | named (rogue) · the sandworm (both Korean words mean it) |
| 포병 · 포격 · 곡사포탄 · 재해 · 전장의 안개 | artillery · a barrage · artillery shell · hazard · fog of war |
| 월드 · 지형 · 구조물 · 소품 | world · terrain · structure · prop |
| 충돌체 · 충돌 · 경사 · 차폐 | collider · collision · ramp / slope · occlusion |
| 발판 | **floor plate** in `world/structures`, **deck / platform** in `ride.ts` — decide from the code, never the word |
| 전차 · 로버 · 탐사 차량 · 승차 · 탑승 · 사다리 | tram · rover · rover · riding · boarding (a ship) · ladder |
| 상자 · 컨테이너 · 채집 노드 | crate · container · gather node |
| 아이템 · 아이템 정의 · 가방 · 창고 · 장비 칸 | item · item def · bag · stash · equipment slot |
| 퀵 슬롯 · 주머니 · 격자 · 내구도 | quick slot · pouch · grid · durability |
| 등급 · 희귀도 · 대분류 · 소켓 · 부착물 | grade (weapon) · rarity · super category (`SuperCategory`) · socket · attachment |
| 제작 · 해체 · 수리 · 작업대 · 벤치 | craft · salvage · repair · workbench · bench |
| 재료 · 재료 회수 · 환급 · 굴림 | material · the material refund · refund · roll |
| 요리 · 식사 · 식탁 · 접시 | cooking · a meal · the dining table · the plate |
| 온실 · 재배 · 배양조 · 분석기 · 표본 계열 | greenhouse · growing · culture tank · analyzer · sample family |
| 서재 · 도감 · 시리즈 · 권 | library · the media catalogue · series · volume |
| 헬스장 · 단련 · 단련 보너스 · 능력치 경험치 | gym · training · the training bonus · stat XP |
| 채굴 · 크립토 | mining · crypto |
| 가구 · 배치 · 접근면 · 방 용도 · 발전기 · 시설 관리 | furniture · placement · access face · room purpose · generator · ship management |
| 임플란트 · 가젯 · 설치물 · 드론 · 조종기 | implant · gadget · deployable · drone · the controller (the quick-slot item) |
| 함선 지원 · 전략 | ship call (`stratagem`) |
| 수류탄 · 폭발 · 폭풍 피해 · 소이 수류탄 | grenade · explosion · blast damage · incendiary grenade |
| 실드 · 방탄복 · 체력 · 기력 · 은엄폐 | shield · armor · hp · stamina · cover |
| 능력치 · 스킬 · 파생 · 레벨 · 경험치 · 특전 | stat · skill · derived stat · level · XP · perk |
| 준비물 · 계약 · 퀘스트 · 목표 | preparation (`prep`) · contract · quest · objective |
| 기업 · 평판 · 신뢰도 · 정보(상) · 기믹 · 기믹 고정 | corporation · reputation · trust · intel (the intel broker) · gimmick · the fixed gimmicks |
| 크레딧 · 사유 · 재화 · 재화 칩 | credits · the credit reason · currency · the currency chip |
| 행성 · 위협도 · 위협 등급 · 상시 환경 | planet · threat · threat rating · permanent environment |
| 튜토리얼 · 트랙 · 단계 · 구간 · 체크포인트 | tutorial · track · step · stretch · checkpoint |
| 단계 (정보 등급) | **tier** — 단계 is a *step* only in tutorial files |
| 조작 가이드 · 키 가이드 · 스포트라이트 · 순차 공개 | the control guide · the key guide · spotlight · sequential reveal |
| 메신저 · 첫 연락 · 귓속말 · 개인 대화 · 그룹 방 · 방장 | the messenger · first contact · whisper · private chat · group room · the room owner |
| 토스트 · 알림 · 화면 · 창 · 팝업 · 뒤판 | toast · notification · screen · window · popup · the backdrop |
| 가림막 · 홀드 확정 · 꾹 누르기 · 키캡 | blocker (`uiBlockers`) · the hold confirm · hold · keycap |
| 포인터 잠금 · 커서 모드 · 마우스 그림 | pointer lock · cursor mode · the mouse glyph |
| 연출 · 시네마틱 · 암전 · 페이드 | cutscene / cinematic · fade to black · fade |
| 미니게임 · 판정 · 구간(판정) | minigame · the judgement · band |
| 드롭다운 · 트리거 · 껍데기 · 칩 · 썸네일 · 게이지 · 표 줄 | dropdown · trigger · shell · chip · thumbnail · gauge · table row |
| 즐겨찾기 · 말풍선 · 직함 · 명단 · 하네스 | favorite (US spelling, matches `ITEM_CHIP_FAVORITE_CLASS`) · speech bubble · job title · roster · harness |
| 표류 / `drifted` · 재접속 유예 · 링크 상태 | drifting / a drifted member · the reconnect grace · the link state |
| 시드 · 프레임 · 틱 · 상한 · 하한 · 배수 · 반경 · 거리 · 자리 | seed · frame · tick · cap · floor · multiplier · radius · distance · spot |
| 실측 · 해석본 · 축약 표기 · 자리 구분 쉼표 | measured · the resolved form · compact notation · grouping commas |
| N차 (2026-09-14 3차) | Nth pass (3rd pass) |

Stat and skill names follow the pilot's `progression/defs.ts` shape — the Korean name in backticks with an English
gloss beside it (`` `운반` hauling (strength) ``, `` `인내` (grit) ``). A stat word that is only a concept
(지능 · 재주) becomes intelligence · dexterity.

### Phrasing

| Korean | English |
|---|---|
| …만 …한다 · 절대 …하지 않는다 · …해야 한다 | only … · never … · must … |
| 그대로 둔다 · 한 번만 · 없으면 | is left alone · exactly once · with none / when there is no … |
| 판정한다 · 읽는다 / 본다 · 부른다 | judges / decides · reads / looks at · calls |
| 건다 / 걸린다 · 푼다 · 접는다 · 끈다 / 켠다 | raises / is held · releases · folds · turns off / on |
| 밀어낸다 · 뚫지 않는다 · 되돌린다 | pushes out · does not pass through · restores |
| 갈린다 · 어긋난다 · 조용히 …된다 · …가 깨진다 | differs / splits · goes out of step · silently … · … breaks |
| (사용자 결정) · (사용자 요청) | (user's decision) · (user's request) — keep the tag's position |
| 「가장 안쪽 팝업이 Escape 를 삼킨다」 | "the innermost popup swallows Escape" (CLAUDE.md §4.2 wording) |
| 「같은 식이 두 폴더에 있으면 shared 로」 | "the same formula in two folders moves to shared" (§4.1 wording) |

### Style

- Present tense, third person, no "we" / "you". Match the pilot: *"Androids ride the **same flow** as people — no
  second extraction path is created."*
- Keep `—` em dashes, `·` separators, `**bold**`, backticks and the leading `2026-09-xx (…)` date tag exactly where
  the Korean had them, and keep the line count and wrap column (~118) so the diff stays comment-only.
- A quoted rule or decision inside `「…」` is a **quotation**: translate it only if the thing it quotes is now English.
  `credits.ts` keeps one verbatim for exactly that reason.

### Added while translating — extend this table

| Korean | English | Found in |
|---|---|---|
| 절벽 · 협곡 · 끝없는 절벽 · 절벽 구멍 | cliff · chasm · the abyss · abyss cut (`ABYSS_CUTS`) | `world/tutorial` |
| 데크 · 바닥판 · 발판 | deck · floor plate · floor plate (deck/platform only in ride context) | `world` |
| 통로 · 회랑 · 구간 | corridor · the (clearance) corridor · stretch | `world` |
| 사선 | **two words**: *diagonal* (the tutorial barrier) and *line of sight* (the visibility checks). Decide from the code, never the word | `world/tutorial/model.ts` |
| 파고듦 · 파고든다 · 흔든다 | bite · bites inward · jitter (both match the code's own locals) | `world/tutorial/parts/Ground.ts` |
| 쐐기 · 돌결 · 얼룩 · 부스러기 · 잔해 | wedge · rock grain · mottling · rubble · wreckage | `world/tutorial`, `world/surface.ts` |
| 유령 토막 (`tut_fence_ghost`) | the **ghost band** — one name only, the one `world/README.md` and CLAUDE.md §4.6 use | `world/tutorial/parts/Dressing.ts` |
| 살 · 칸 · 콘크리트 턱 · 기둥 | slat · pitch (`SLAT_PITCH`) / bay (`POST_STEP_M`) · sill · post | `world/tutorial` |
| 도움닫기 · 체공 · 볏 · 깨우기 | run-up · airtime · crest · waking | `world/tutorial` |
| 상인방 · 문설주 · 윗대 · 개구멍 · 살창 덮개 | lintel · jamb · head piece · vent · louvred cover | `world/structures` |
| 앞마당 (`OPENING_APPROACH`) · 무너진 틈 · 층계참 | approach · collapsed breach · landing | `world/structures` |
| 격벽 | **partition** for an interior dividing wall, **bulkhead** only in a vehicle | `world/structures`, `world/rails` |
| 옆판 · 나셀 · 기수 | side plate · nacelle · nose | `world/structures`, `world/tutorial` |
| 침목 · 대차 · 승강구 · 무개차 · 받침 | ties · bogies · the doorway · an open car · plinth | `world/rails`, `world/Outposts.ts` |
| 정차 | **docking** (tram) · **dwell** (rover) — the two are not the same event | `world/rails`, `world/rover` |
| 제자리 회전 · 추측 항법 · 부딪힘 | turning on the spot · dead reckoning · ramming | `world/rover` |
| 포탑 받침 · 포구 화염 · 예광탄 · 장갑 치마 · 적재함 | the turret ring · the muzzle flash · tracer · armour skirt · stowage bin | `world/rover` |
| 바퀴자국 · 다져진 흙 · 자갈 원판 · 표지 기둥 | the ruts · packed dirt · the gravel disc · the sign pole | `world/rover` |
| 커튼 · 합집합 · 겹 · 조각 셰이더 | curtain (the hazard wall) · union · layer · fragment shader | `world/hazard` |
| 갓 · 줄기 · 주름 · 피어오른다 | cap · stem · gills · blooms | `world/hazard` |
| 예고 → 시작 · 침투 깊이 · 경계 페더 · 부호거리 | announced → started · penetration depth · the edge feather · signed distance | `world/hazard` |
| 지형지물 · 기각 표집 · 명암 램프 · 반변 | terrain feature · rejection sampling · shading ramp · half-side | `world` |
| 노두 · 등급 순번 · 속성 (토양) | outcrop · rarity index · tag (`SoilTag`) | `world/Gather.ts`, `world/mineral.ts` |
| 부가 결과 · 부가 코어 · 계열의 닻 | bonus result · bonus core (`NodeBonus`) · the family's anchor | `world/Gather.ts` |
| 이삭 · 낟알 · 곁가지 · 포기 · 흙덩이 · 허물 | ear · grain · offshoot · stalk · clod · moult | `world/Gather.ts` |
| 안전핀 · 수법 · 사건 · 굴림 스트림 | pin (a guard outside `data:check`) · trick · incident · draw stream | `world` |
| 옛 피어 | **an older peer** (a client on an older build; the pre-existing English in `biomes.ts` · `WorldSystem.ts` set it) | `world/soil.ts`, `flora.ts`, `Hazard.ts` |
| 겉모습 · 외피 | **the look** — one word for both; 외피 gets no second noun (`AN.shell` is a body panel, `WormModel.SKIN` a colour) | `enemies/models` |
| 전소 | **incinerated** (adj.) · **incineration** (n.) — never the Korean, it is a concept not a label | `enemies` (folder-wide) |
| 총알 추적 · 경직 · 헛물기 | shot tracking · stagger · a missed bite | `enemies/parts` |
| 포병: 준비 · 엎드림 · 쏜 뒤 고정 | the barrage prep (phase 3) · the brace (phase 1) · the post-fire lock (phase 2) — three distinct words, never merged | `enemies/ai/GimmickAI.ts`, `Enemy.ts` |
| 전조 | **the tell** (a pre-shot cue) · **telegraph / a telegraphed shot** (the sniper) · **the omen** (the sandworm's approach) — decide from what it warns of | `enemies/ai`, `enemies/sandworm` |
| 굴착 · 솟아오름 · 뱉기 | the dig-in · emerging · the spit | `enemies/ai/Burrow.ts`, `sandworm` |
| 흙 파임 · 분진 · 흙 폭발 · 흙덩이 | the churned spot · dust · a soil blast · clod | `enemies/fx/BurrowFx.ts` |
| 옆걸음 · 비켜서기 | **sidestep** (noun and verb alike) | `enemies/ai/FireLine.ts`, `RogueAI.ts` |
| 입 사선 · 발판 질의 | the mouth line (the spewer) · the platform query (`getStandingObstacle`) | `enemies/ai` |
| 연사 · 헛돌기 · 총열 회전 | spray (matching the wire key `ee spray`) · spinning empty · barrel spin / spin-up · spin-down | `enemies/ai/named/Heavy.ts` |
| 음파 · 노출 · 입양 | the (scan) pulse · exposure · adopt (`adoptDrone`) | `enemies/ai/named/ScanDrone.ts`, `Sniper.ts` |
| 로든의 둥지 (`nestLeash`) | **nest** — the same word as a bug nest, because the csv field is literally `nestLeash` | `enemies/ai/named/Sniper.ts` |
| 거점 점거 · 매복 · 연쇄 스폰 | site occupation · ambush · chain spawn | `enemies/SiteGroups.ts`, `Tutorial.ts` |
| 낭떠러지 | **drop-off** — kept apart from 절벽 *cliff* and 끝없는 절벽 *the abyss*, which `src/world` fixed | `enemies/Tutorial.ts` |
| 실효 생태계 · 분출 무리 · 개체수 상한 | the effective ecosystem · the eruption pack · the population cap | `enemies/Spawner.ts`, `RogueDrop.ts` |
| 판정 상수 · 알고리즘 상수 · 그림 상수 · 연출 수치 | a judgement constant · an algorithm constant · drawing constants · presentation numbers — four different Korean words, kept apart, each ending "…, not a csv number" | `enemies` |
| 표현용 (값 · 안전핀) | a nominal value / a nominal pin | `enemies/parts/Damage.ts` |
| 파열구 · 노른빛 · 피아 식별 | rupture · the yolk glow · telling friend from foe | `enemies/models` |
| 마디 · 턱 · 목구멍 · 꿀렁임 · 숙임 | segment · jaw · throat · the throat surge · lean | `enemies/models/WormModel.ts`, `sandworm/Pose.ts` |
| 견갑 · 흉갑 / 가슴판 · 탄부판 · 정강이판 | pauldron · breastplate / chest plate (**the Korean itself uses two words — keep both**) · groin plate · shin plate | `enemies/models` |
| 소염기 · 경통 · 기관부 · 급탄 상자 · 길리 망토 | flash hider · scope tube · receiver · feed box · ghillie cloak | `enemies/models/named` |
| 라벨 · 배지 · 카드 · 패널 · 버튼 · 줄 | label · badge · card · panel · button · **row** (a list entry) / **line** (a line of text) — decide from the code | `ui` (folder-wide) |
| 좌측 · 우측 · 상단 · 하단 · 가운데 | left · right · top · bottom · **centre** (British, matching `top-centre` in the READMEs) | `ui` (folder-wide) |
| 층 (HUD 레이어) · 뒤판 · 가림막 | layer · the backdrop · blocker (`uiBlockers`) | `ui/HudSystem.ts` |
| 기상 연출 | **the intro wake** (+ cutscene) — one name only, the one `player/README.md` and CLAUDE.md §3.2 use | `ui/Compass.ts`, `Reticle.ts`, `HudSystem.ts` |
| 로그 강하 · 레이더 강하 | **rogue drop** (the pre-2026-09-10 name, only in historical prose) · **raider drop** (current) — never merged | `ui/OffscreenIndicators.ts`, `HudSystem.ts` |
| 연출 (판 · 게이지) | **presentation** when the point is 「not a screen: no blocker, no escape, eats no pointer」, **cutscene** when it is a timed sequence | `ui/HudSystem.ts`, `ShipReturn.ts` |
| 판 (검은 판) · 판을 쥔다 | the plate (the black full-screen plate) · holds the plate (`ownsPlate`) | `ui/HudSystem.ts`, `ShipReturn.ts` |
| 규약 · 스모크 · 개편 | the contract · the smoke test · the rework | `ui` (folder-wide) |
| 경고 팝업 · 확정 홀드 · 탭 확정 | the warning popup · the hold confirm (the glossary form) · a tap confirm (`Ask.tap`) | `ui/menus` |
| 초상 · 말풍선 (채팅) · 꼬리 · 서랍 · 지문 | avatar (`.ms-av`) · bubble · tail · drawer · fingerprint (a cheap repaint key) | `ui/menus/messenger` |
| 타이핑 연출 · 창구 | the typing reveal · source (`sources.ts` · `allySource.ts`) | `ui/menus/messenger`, `ui/hud` |
| 눈금 · 띠 (나침반) · 범례 · 빗금 · 잔상 | tick · strip · legend · hatching · ghost (`.ghost`) | `ui/hud`, `ui/map` |
| 정찰 · 인지력 | recon (the implant) · perception (`derived.enemyDetectRadius`) | `ui/hud/Detection.ts`, `DangerIndicators.ts` |
| 준비 연출 · 총구 막힘 · 기폭기 손 | the ready presentation · blocked muzzle · the detonator hand | `ui/hud/StratagemPanel.ts`, `Reticle.ts`, `GadgetHandHint.ts` |
| 조리대 · 배지 (배양) · 세포주 · 스캐폴드 | cook bench · medium · strain · scaffold | `ui/hud/ShipManage.ts`, `mealText.ts` |
| 딤드 · 모달리스 · 하위 탭 · 손잡이 (DOM) | dimmed · modeless · sub-tab · handle | `ui/hud/ShipManage.ts`, `ItemTip.ts` |
| 기 (안드로이드 수사) · 빈 자리 | unit · an empty slot | `ui/hud/Squad.ts`, `Nameplates.ts` |
| 보관함 · 책장 · 디스크 전시대 · 레코드랙 · 게임 디스크 전시대 | **holder** (any of them) · bookshelf · disc stand · record rack · game disc stand | `housing` (folder-wide) |
| 도감 | the **catalogue** — a `도감` tab label stays Korean, the concept is English (`분석 도감` → the analysis catalogue) | `housing` (folder-wide) |
| 배지 | **medium** in the culture tank, **badge** in the UI — two different words, decide from the code | `housing/parts/Culture.ts` vs `ui` |
| 흙구멍 (`.gs-pot`) · 관 (배양) · 전시대 | the **pot** · tube · a holder (never "display stand"). `shared/housing.ts:754` still says *soil hole* — align that one word the next time that line is touched, not in a housing commit | `housing/ui/GrowStation.ts`, `CultureTank.ts`, `ProductDrag.ts` |
| 레일 (`StationShell.rail`) · 머리줄 · 껍데기 | the **rail** · the **header row** · shell | `housing/ui` (folder-wide) |
| 산출물 · 배달 · 회수 (완성물) | the **product** · delivery (`parts/Deliver`) · collect | `housing/parts/Deliver.ts`, `ui/ProductDrag.ts` |
| 판정 객체 · 무대 · 판정선 · 예비 박(자) · 헛클릭 · 헛누름 | the **judge object** · the **stage** (`.gym-stage` · `.cook-stage`, never a screen phase) · the judgement line · the **lead-in beat** (`GYM_LEAD_BEATS`) · a stray click · a stray press | `housing/parts/CookGames.ts`, `GymGames.ts`, `ui/gym`, `ui/cook` |
| 안내 링 · 회차 · 구역 · 칸 (`gym-pip`) · 완성 · 끓어오름 · 초록 구간 | the guide ring · rep · zone · pip · doneness · the boiling surge · the green band | `housing/ui/gym`, `ui/cook` |
| 국자 · 비커 · (우상단) 비커 (`cook-jug`) · 자동 조리 가구 · 선택 카드 | ladle · beaker · the jug · an **auto appliance** · the choice card | `housing/ui/cook` |
| 성능 합 · 구간 (채굴) · 따라잡기 · 누적 채굴 · 꽂는다 / 뺀다 | the perf sum · **segment** (never the tutorial's *stretch*) · the catch-up · the mined total · mount / pull (a processor) | `housing/MiningRules.ts`, `parts/Mining.ts` |
| 봉 · 꼬리표 · 눈금 간격 · 시세가 오래됐다 | candle · tag · tick step · a stale quote | `housing/ui/mining/CryptoChart.ts`, `ComputerPages.ts` |
| 권 칸 (`.lib-pip`) · 대표 권 · 층 판 · 단편 · 시리즈 색 | the volume pip · the lead volume · tier plate · one-shot (a single-volume series) · the series tint | `housing/ui/ShelfDrawing.ts`, `BookDex.ts` |
| 기억 열쇠 · 지문 | **fingerprint** — one word for a cheap repaint key, the one `ui/menus/messenger` set | `housing/ui/mining/ClusterPage.ts` |
| 배치 상수 | a **layout constant** — a fourth kind beside the judgement / algorithm / drawing constants of `enemies` | `housing/ui/ShelfDrawing.ts` |
| 정리 (`sanitize`) · 이관 · 멱등 · 지급 · 옛 세이브 · 모양 (검사) | sanitizing · migration · idempotent · the grant · an old save · the shape (check) | `housing/ShipState.ts` |
| 은퇴 · 폐지 | **retired** (`FurnitureDef.retired`) · **dropped** (a feature that was taken out) — kept apart | `housing` (folder-wide) |
| 시술대 · 무한 상자 · 휴식 공간 | implant bay · the infinite box (`/items`) · the lounge | `housing/parts/Furniture.ts`, `ui/Panel.ts`, `ui/ShipView.ts` |
| 한국어 (형용사) | **Korean** — it is under both §5 gates and is everywhere in this folder; sweep for it before closing a folder | `housing` (folder-wide) |
| 도감 (산문 vs 식별자) | **the catalogue** in prose; the identifier stays `sampleDex` · `bookDex` · `dexEntries` in backticks. `src/housing/README.md` writes *dex* in prose — align that README the next time it is touched, not in a translation commit | `housing` (folder-wide) |
| 격자 · 칸 · 타일 | grid · **cell** · tile. A *panel* 칸 (`창고 칸` · `가방 칸`) is a **pane** — `inventory/README.md` already writes *stash pane*; a grid 칸 stays **cell** | `inventory` (folder-wide) |
| **감정** | **the search** (`searchProgress` · `searchTimeFor` · `item.searched`); its on-tile gauge is **the scan gauge** (`.inv-tile-scan`, the README's word). Never *appraisal* — that is the **skill** `감정` (`shared/progression.ts` `'appraisal'`), a different thing. `shared/types.ts:3083` still says *the appraisal state* for the container search — align that one line the next time it is touched, not in an inventory commit | `inventory/Container.ts`, `Gear.ts`, `ui/GridView.ts` |
| **구간** (내구도) | **bucket** (`DurabilityBucketInfo`) — not the minigame's *band*, not mining's *segment*, not the tutorial's *stretch*. Four folders, four words, all kept apart | `inventory/model.ts`, `parts/Durability.ts` |
| **분해** | **salvage** (the `break_*` recipes). The on-screen entry / dialog title `분해` stays Korean, and so do the identifiers `DisassemblePanel` · `disassembleRecipeFor` · `openDisassemble` | `inventory` (folder-wide) |
| **사선 띠** | **the ribbon** (the top-right diagonal ribbon: needed ammo · favourite · not-yet-shelved · recovery contract) — the word `inventory/README.md` uses. `src/shared` (`index.ts:68`, `itemChip.ts:206`, `raidFound.ts:9` · `:94`) still says *diagonal band* for the same thing — align those four the next time they are touched, not in an inventory commit. Kept apart from a plain 띠 = **band** (`AUTO_SCROLL_EDGE_IN`, a px band along an edge) | `inventory/ui/GridView.ts`, `ui/model.ts` |
| 빠른제작 · 작업실 | **quick craft** (the `null` bench) · **workshop** (housing's `FacilityId`) | `inventory/parts/Crafting.ts` |
| 회수 계약 vs 재료 회수 | **recovery contract** (CLAUDE.md §4.7) vs **the material refund** — two different things, never merged | `inventory` (folder-wide) |
| 스택 분류 열쇠 · 밀려난 스택 · 남는 스택 | the **stack key** (`stackKeyOf`) · the **displaced stack** (`QuickSwap`) · the **remainder** held on the cursor (`DragState.held`) | `inventory/Grid.ts`, `QuickSwap.ts` |
| 보폭 (`STEP`) · 칸 사다리 | the one-cell **pitch** (never *stride*) · the **ladder** (`CELL_LADDER`) | `inventory/ui/labels.ts` |
| 머리줄 · 이음매 | the **header row** · **seam** (CLAUDE.md §4.2's `--inv-panel-gap` seams) | `inventory/ui` |
| 표시 전용 사본 | a **display copy** (the README's word — not *display-only copy*, not *drawing copy*): the module-level copies of favourites / needed ammo / recovery scope / shelf-wanted | `inventory/ui/GridView.ts` |
| **즐겨찾기** | **favourite** in prose — the folder's own pre-existing English and `inventory/README.md` both spell it that way; the identifiers stay `favorite` / `isFavorite` / `favoriteDefIds`. The US-spelling row above was matching `ITEM_CHIP_FAVORITE_CLASS`; **do not sed one into the other** | `inventory` (folder-wide) |
| 기본 지급품 · 출격 준비 점검 | **the starter grant** (`tryStarterGrant`) · **the launch readiness check** (`getLaunchWarnings`) | `inventory/parts/Lifecycle.ts`, `LaunchCheck.ts` |
| 획득 티커 | the **item-gained ticker** — already the wording `ui/hud/Notifications.ts` uses for the same `inventory:itemAdded` line, not a new noun | `inventory/parts/Crafting.ts` |
| 무한 상자 | **the infinite box** as a concept; the on-screen title `무한 상자` and the literal `'CHEAT · INFINITE CRATE'` stay untouched. The `/items` panel itself is **the catalog** (`CatalogView`) — kept apart from the library's **catalogue** (`도감`) | `inventory/parts/Catalog.ts`, `ui/CatalogView.ts` |
| 넷 중 하나만 (주머니) | one of the **four** pouches in `data/items.csv` (`pouch_gather` · `pouch_key` · `pouch_medical` · `pouch_valuable`) — `POUCH_SLOTS` is 1, so the "four" is the item count, not a slot count | `inventory/parts/Pouch.ts` |
| 망가진 짝 | **broken twin** — the folder's pre-existing English. CLAUDE.md §4.6 says *broken pairs* for the same thing; one of the two should win the next time either is touched | `inventory/parts/CorpseLoot.ts` |
| 가구 창고 · 조종석 vs furniture storage · cockpit | **both, on purpose** — Korean when the prose names the on-screen tab or room label, English when it names the concept. Exactly the split the folder already runs for `함선 창고` vs *the stash*; do not sed one into the other | `housing` (folder-wide) |
| 받침 · 상판 · 뒷판 · 옆판 | **base** (stand for the TV's panel) · **top plate** · **back panel** · **side plate** (§7, `world/structures`) | `hub/interiors/FurnitureLeisure.ts` |
| 진열장 · 매대 · 진열 턱 · 표찰 | **display cabinet** · **display unit** · **display lip** · **tag** (the 꼬리표 word) | `hub/interiors/FurnitureLeisure.ts` |
| 통 · 칸막이 · 머리판 · 레코드 등 | **bin** (the record bin) · **divider** · **headboard** · **record spine** | `hub/interiors/FurnitureLeisure.ts` |
| 기둥 (가구) | **upright** on a gym machine (J-hook / cage posts), **post** on a chair · treadmill · bike — decide from the piece | `hub/interiors/FurnitureLeisure.ts` |
| 가로대 · 윗가로대 · 레일 | **crossbar** (gym machine) · **top rail** (chair) · **rail** — three words, kept apart | `hub/interiors/FurnitureLeisure.ts` |
| 칸 (가구) | **slot** for a holder slot (matching `SHELF_SLOTS`), **compartment** for a shelf / cabinet opening | `hub/interiors/FurnitureLeisure.ts` |
| 위상 (가구 연출) | **phase** — the 0..1 parameter a pose runs on (the accumulated phase CLAUDE.md §4.8 puts on the wire) | `hub/interiors` (folder-wide) |
| **`data/furniture.csv` 가구 이름** | **kept Korean, verbatim** (`책장` · `조리대` · `식탁` · `추출기` · `3D 프린터` · `흔들의자` …) — the `src/housing` precedent: prose must grep against the csv. So is the csv section heading `공용 시설 가구` (`housing/HousingSystem.ts` · `ShipState.ts` · `ui/hud/ShipManage.ts` all keep it; changing it is a three-folder edit, not a hub one) | `hub/interiors/Furniture.ts` |
| 「씬의 광원 개수를 플레이 중에 바꾸지 않는다」 | "Never change the point-light count at runtime" — **CLAUDE.md §4.5's own wording**, the one string every repetition of this quote uses | `hub/interiors` (folder-wide) |
| 재배층 | **two things**: the csv furniture name `재배층` (`furn_grow_rack`) stays Korean; a *level* of the grow station is the concept and becomes **tier** (`GROW_TIER_Y`, matching `housing/README.md`). A stack 층 (`PlacedFurniture.layer`) is a **layer** | `hub/interiors/Furniture.ts` |
| 칸 (스테이션) | **slot** — `ANALYZER_MAX_SLOTS` · `CULTURE_MAX_SLOTS` · `SHELF_SLOTS` · `GROW_SLOTS_PER_TIER` are literally slots; inventory's grid-`칸` = cell / panel-`칸` = pane split does not reach this folder | `hub/interiors` (folder-wide) |
| 붙박이 · 고정 설비 · 꾸밈 가구 · 운동 기구 | built-in · the built-in fixtures · decorative furniture · gym machine | `hub/interiors/Furniture.ts` |
| 둘러보기 전용 · 회수 대기 | look-around only (drawn and colliding, answering to no E) · waiting to be collected | `hub` (folder-wide) |
| 게임기 · 매체 (서재) · 레코드 플레이어 | **console** (`GameConsoleDef.console`) · **media item** (kept apart from 배지 = medium) · **record player** (a category; the defs are `축음기` · `주크박스` · `턴테이블`) | `hub/interiors/Furniture.ts` |
| 화구 · 후드 · 덕트 · 도마 · 웍 · 계량 비커 | hob (`onHob`) · hood · duct · board · wok · measuring beaker — the rest match the code's own `CookTool` ids | `hub/interiors` (kitchen) |
| 용해로 · 도가니 · 주형 트레이 · 잉곳 · 증류탑 · 응축 코일 · 혼합 드럼 · 교반 축 | smelter · crucible · mould tray · ingot · a still (`증류탑` = still column) · condenser coils · mixing drum · stirrer shaft | `hub/interiors/Furniture.ts` (benches) |
| 챔버 · 조형판 · 갠트리 · 히팅 베드 · 출력 헤드 · 필라멘트 스풀 | chamber · build plate · gantry · heated bed · print head · filament spool | `3D 프린터` |
| 시료 챔버 · 배양관 · 배양액 · 세포 덩어리 · 폭기관 · 급액 라인 · 배지 저장조 | sample chamber · culture tube · culture fluid · cell mass · aeration pipe · feed line · medium reservoir | `분석기` · `배양조` |
| 재배등 · 제어반 · 악센트 · 식탁보 · 수저 · 윗판 | grow light · control panel · accent · tablecloth · cutlery · top slab | `hub/interiors` (stations) |
| 알약 탭 | **pill tabs** (`nav.scr-tabs > button.scr-tab`) — the shape `src/ui` and `src/inventory` already draw for a tab strip | `hub/ui/HubMenu.ts` |
| 장비 줄 vs 장비 판 | **the gear row** (`.hr-gear`, the DOM row of five thumbnails) vs **the gear board** (what a member is carrying — `hub/README.md`'s word). Two things, never merged | `hub/ui/ReadyPanel.ts` |
| 가치 합계 | **the value total** (`.hr-value`, drawn as `장비 가치 <n>`) — never *worth*, never *sum* | `hub/ui/ReadyPanel.ts` |
| 칸 (준비 패널 vs 매칭 탭) | **bot cell** in `ReadyPanel` (`.hr-cell`) · **bot tile** in `MatchTab` (`.hmt-tile`) — decided from the DOM, the way `src/ui` splits row vs line | `hub/ui` |
| 사유 줄 · 상태 줄 · 머리글자 | the **reason line** (`.hmt-hint`) · the **state line** (`.hr-state`) · **initial** (`.hmt-initial`, the letter drawn with no face snapshot) | `hub/ui` |
| 넘김 · 행성 넘김 | **stepping** / **planet stepping** — the code's own `step(dir)`, and the pager is a *preview* (CLAUDE.md §4.2) | `hub/ui/HubMenu.ts` |
| 확인 카드 | **a confirm card** — the card, kept apart from §7's *hold confirm* / *tap confirm*, which are the gestures | `hub/ui/TrainingConfirm.ts` |
| 옛 구현 | **an older implementation** (a `NetRef` without `social.refresh`) — kept apart from 옛 피어 *an older peer* | `hub/ui/MatchTab.ts` |
| 초상 (준비 패널 vs 매칭 탭) | **portrait** in `ReadyPanel` (full body, `createPortraits`) · the **face** tile in `MatchTab` (`snapshotFace`). The Korean uses 초상 for both; the code does not | `hub/ui` |
| 조종실 | **cockpit** in the personal ship. In the **shared** ship the same room is the **bridge** — the word that file's own English and `hub/README.md`:169 use — while the android bays keep the feature name CLAUDE.md §3.2 gives them, *the cockpit bays*. Feature name and place are simply two different things here | `hub/interiors/SharedShip.ts` vs `PersonalShip.ts` |
| 국면 · 후보 지역 · 락온 · 광원 자리 | **phase** (the pick phase / the confirmed phase, README's words) · **candidate area** · **lock-on** · **light place** (kept apart from *fixture*, the `LightFixture` object) | `hub/ui/IntelMenu.ts`, `interiors` |
| 통로 (갑판을 가로지르는 길) | **walk-in line** — the file's own pre-existing English, kept apart from 복도 = *corridor* | `hub/interiors/PersonalShip.ts` |
| 조타 콘솔 · 상태 띠 · 상태등 · 이름표 | the **helm console** · **status strip** · **status light** · **name tag** | `hub/interiors/AndroidBays.ts` |
| 상판 | **three contexts, one Korean word**: **worktop** (kitchen cabinet) · **table top** (dining table) · **bench top** (cook bench) | `hub/interiors` (kitchen) |
| 자루 vs 손잡이 | **handle** vs **grip** — the wok / grill pan have both (the long 자루 is the handle, the 손잡이 at its end the grip); a cabinet-door or pot 손잡이 is a plain handle | `hub/interiors/FurnitureKitchen.ts` |
| 화실 · 철판 · 그릴 쇠살 · 열선 · 구운 자국 · 기름 홈 | firebox · griddle · grill bars · heating element · sear marks · grease channel | `hub/interiors/FurnitureKitchen.ts` |
| 맞물림 링 · 투입구 · 누름대 · S자 칼날 · 인덕션 판 · 날개 · 눈금 비커 | locking ring · feed chute · pusher · S-blade · induction plate · paddle · the **graduated beaker** (the dispenser's — the cook-bench tool is plain **beaker**, §7) | `hub/interiors/FurnitureKitchen.ts` |
| 식기 · 식기 한 벌 · 식기 자리 | **a place setting** · one set of place settings · the **place-setting spots** | `hub/interiors/TablePlates.ts` |
| 위치 이동 상태 · 꾹 눌러 옮기기 · 비워야 하는 칸 · 클릭 인스펙터 | the **move state** · **hold to move** · **clearance cells** · the **click inspector** (`ui/hud/ShipManage`) — all README's own words | `hub/HousingMode.ts` |
| 방 목록 · 가구 카드 바 · 닫기 스택 | the **room list** · the **furniture card bar** · the **escape stack** (CLAUDE.md §4.2's name for `ctx.escape`) | `hub/HousingMode.ts` |
| 함선 관리 vs 시설 관리 | **ship management** for both — nothing in code or csv is called `함선 관리`, and the on-screen name is `시설 관리` | `hub/HousingMode.ts` |
| 원반 · 거치대 · 누르기 경로 · 걸음 · 흔들림 | the **plates** (`rig.plates`) · the **rack** (the barbell rack, kept apart from a server rack and `AndroidBayRack`) · the **press path** · **stride** (`RUN_STRIDE_HZ`) · the **rock** | `hub/interiors/GymStaging.ts` |
| 옆 고정 카메라 · 어깨 너머 카메라 · 슬랩 판정 | the **side fixed camera** · the **over-the-shoulder camera** · a **slab test** | `hub/interiors/GymStaging.ts`, `GameStaging.ts` |
| 표식 · 튀기 · 진행 막대 | the **marker** (`rig.marker`) · **kick** · the **progress bar** | `hub/interiors/GameStaging.ts` |
| 머리 띠 · 본체 · 꼬리 (봉 차트) · 통풍 격자 | the **top band** (deliberately **not** housing's 머리줄 *header row*) · the **tower** (under the desk) · the **wick** (kept apart from 꼬리표 *tag*) · the **vent grille** | `hub/interiors/FurnitureMining.ts` |
| 메인 컴퓨터 | **the main computer** in prose (CLAUDE.md §4.7's word and the csv name `메인 컴퓨터`); `hub/README.md`'s *mining computer desk* names the builder, not the thing | `hub/interiors/FurnitureMining.ts` |
| 받침 | **plinth** for a rack / cluster base (the `world/Outposts` row) but **stand** for a monitor's foot — one Korean word, two objects | `hub/interiors` |
