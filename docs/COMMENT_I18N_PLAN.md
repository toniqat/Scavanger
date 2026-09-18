# Code comment translation — remaining plan

Translating every Korean code comment into English so the comments read as documentation for an AI working in this
repo. Started 2026-09-18 on the user's request; the rule itself now lives in **[`CLAUDE.md` §4.1](../CLAUDE.md)** and is
not repeated here. This file only tracks **what is left, in what order, and how to do it safely**.

Delete this file once the queue below is empty.

> **Next session starts here:** queue item **2, `src/world`** ([§2](#2-queue)). Read [§7 Glossary](#7-glossary) before
> picking any wording, then follow [§3](#3-working-method) — in particular **step 4, which is not the check this file
> originally described**; the old one let a deleted `*/` through. `src/world` is a normal feature folder, so its
> `verify` is a folder-sized run, not the full net.

---

## 1. Status

| | Lines | Files |
|---|---:|---:|
| Done (`src/extraction`, `src/progression`, `src/shared`, `src/main.ts`) | 4,496 | 78 |
| **Remaining** ([§2](#2-queue)) | **22,120** | **669** |

Measured with the script in [§5](#5-measuring). The first estimate in the session that started this work (31,700) was
too high: a naive Hangul grep also counts already-English comments that quote a Korean UI label.

**Intended permanent exceptions.** A finished folder still prints 6 lines, because a comment whose entire substance is
a quoted label or a quoted document heading keeps its Korean (§3 rule 2 — the reader has to be able to grep it against
the real string). So a raw run over everything prints 22,126 / 674, six more than the queue:

| Line | What it quotes |
|---|---|
| `progression/ui/SheetBody.ts:709` | UI output (`` `『운반 노하우』 +4.0 %` over `책 · 4 / 5권 · 40 %` ``) |
| `shared/types.ts:142` | the equip-slot labels (`주무기 I` · `가방` · `방탄복`) |
| `shared/types.ts:1935` | a headline string (`주무기가 없습니다`) |
| `shared/allies.ts:3` | a `docs/DECISIONS.md` section heading |
| `shared/npc.ts:111` | a job title (`헬릭스 조달실장`) |
| `shared/tutorial.ts:381` | the four track names (`조작 안내` · `함선 안내` · `증축 안내` · `출격 안내`) |

---

## 2. Queue

Largest first, because the big folders set the vocabulary the smaller ones reuse. One commit per folder.

| # | Folder | Lines | Files | Notes |
|---|---|---:|---:|---|
| ~~1~~ | ~~`src/shared`~~ | 4,187 | 65 | **Done 2026-09-18** (with `src/main.ts`, one commit, full 96-script `verify`). Its vocabulary is now the queue's vocabulary — read that folder's comments before picking words for a new folder. |
| **2** | **`src/world`** | 2,988 | 58 | Dense collision / layout invariants (`getSurfaceY` before `resolveCollision`, hull vs box vs ramp). Precision matters more than style here. |
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
   - **Keep the file's line endings.** Most files here are CRLF in the working tree. Read bytes, remember whether
     `\r\n` was present, normalise to `\n` for matching, and put it back on write. (Writing LF into a CRLF file also
     works — `core.autocrlf=true` normalises on `git add` — but it prints a warning per file and makes the working
     tree inconsistent for the next tool that reads it.)
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
decision nobody has made.

### Splitting a folder across parallel agents

`src/shared` (4,194 lines) was done this way on 2026-09-18 and it works, with three conditions:

1. **The lead fixes the glossary first** ([§7](#7-glossary)) and hands it to every agent. Without it each agent coins
   its own words and the folder reads in six voices — the reason this section exists at all.
2. **Bundles must not overlap**, because the agents edit one shared working tree. Give each agent an explicit file
   list and tell it to touch nothing else — not the folder `README.md`, not this file.
3. **Agents do not run `git add` / `commit` / `typecheck` / `verify`.** The lead runs each once, at the end, over
   everything. An agent that commits its own bundle makes the comment-only proof impossible to run as one check.

Ask each agent to report: its final count per file, any quoted-label-only line it left, **any term it had to coin**
(fold those into §7), and any comment it could not resolve from the code.

**When an agent dies mid-bundle** — a rate limit will do it — the tree is left half-translated and its applier script
is **not re-runnable** (a later pair may match text an earlier pair already produced). Do not reason from the agent's
last message about what it finished. **Measure the tree** (§5), and translate whatever is left by hand. Three of seven
agents died this way in the `src/shared` pass and the recovery was cheap precisely because the count is authoritative
and the reports are not.

---

## 4. Verification

`npm run verify` picks smokes from the touched folders. Run `node scripts/verify.mjs --dry-run` first to see the
selection.

- **A normal feature folder** costs roughly what the pilot did (16 scripts, ~6 min). Every remaining queue item
  except `src/core` is one of these.
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

---

## 6. Recording a finished folder

- **Commit** per folder, paths given explicitly (`git add src/<folder>`), with the runner's `docs line:` as the
  `검증:` line. Commit messages stay Korean, like every other commit here.
- **That folder's `README.md`**: one line at the top of `Recent changes`, drop the bottom one. Wording used so far:
  > `- 2026-09-18 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels kept verbatim in backticks, no string literal touched.`
- **Tick the row off** in §2, update §1's totals, and add any new intended exception to §1's table.
- **A new term** you had to coin goes in [§7](#7-glossary) — that is what keeps the folders reading as one voice.
- **A defect the translation uncovered but did not cause** (a doc that contradicts its code, a stale reference) goes
  in [`docs/TODO.md`](TODO.md), not fixed in the translation commit — the commit has to stay provably comment-only.
  The `src/shared` pass filed three as `B-19`.
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
| (add here as you go) | | |
