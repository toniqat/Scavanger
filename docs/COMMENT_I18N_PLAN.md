# Code comment translation — remaining plan

Translating every Korean code comment into English so the comments read as documentation for an AI working in this
repo. Started 2026-09-18 on the user's request; the rule itself now lives in **[`CLAUDE.md` §4.1](../CLAUDE.md)** and is
not repeated here. This file only tracks **what is left, in what order, and how to do it safely**.

Delete this file once the queue below is empty.

> **Next session starts here:** queue item **14, `src/meta`** ([§2](#2-queue)). Read [§7 Glossary](#7-glossary)
> before picking any wording, then follow [§3](#3-working-method) — in particular **step 4, which is not the check this
> file originally described**; the old one let a deleted `*/` through, and **§3 step 4b**, which `src/tutorial` added
> after catching a re-typed Korean label. `src/meta` is 305 lines over 15 files: the four corporations · reputation ·
> credits · the shop and trade desk · contracts · the implant repair desk · the NPC quest engine · NPC trust · intel
> purchase. CLAUDE.md §4.7's economy bullets and §4.8's quest bullets settle its wording, and `src/items` (item 10)
> and `src/inventory` (item 6) already fixed the economy nouns it shares with them.

> **The wrap-column check is the lead's, not an agent's.** In `src/game` two of the four agents reported "no comment
> line over 118 columns" and the lead's own ratchet then found **nine** — five in one bundle. The check is cheap and
> it is the one thing an agent consistently gets wrong, because English runs longer than the Korean it replaces and a
> trailing comment on a long code line crosses the column without looking any different. Run it per file **against
> HEAD** (that file's own widest comment line and its own count of lines over 118), never as a tree-wide maximum: this
> folder legitimately holds 13 comment lines over 118 that were already there.

> **§3 step 4b earns its place again.** In `src/items` an agent re-typed the csv item name `강화합금 잉곳` as
> `강화합금 잉고` in **two** `Salvage.ts` comments, and its own report said the audit was clean — it had run the
> audit before its last write. The lead's run over the whole tree, after every agent reported, printed
> `runs not found in HEAD: 2`. Nothing else sees this class: `tsc` passes, every smoke passes, and step 4 strips
> comments before comparing. **Run 4b yourself, last.**

> **Run §3 step 4 yourself — an agent reporting `code changes: 0` is not evidence.** In `src/player` the controller
> bundle's applier deleted two whole declarations, `const LADDER_BOTTOM_GRAB_CLEAR = 0.5;` and
> `private airCarry = false;`: each sat *between* two Korean doc blocks, inside a replaced range. The agent's own
> report said `code changes: 0` — it had run the proof before its last write. The lead's run over the whole tree,
> **after the last agent reported**, printed `code changes: 1`, twice in a row (the second only surfaced once the
> first was fixed), so re-run it after every fix until it prints 0.
> These two would have been caught by `tsc` as well (measured: 7 errors, `TS2304` + `TS2339` — both names were still
> referenced). That is the *lucky* shape. The dangerous one is a declaration **nothing references** — the interface
> field `miningRarityBonus: number;` that `src/shared` lost — which `tsc` passes and only step 4 sees.

> **`src/tutorial` cut by file, not by track.** This file used to say to cut it by track; that does not work, because
> the four tracks are *data* in `Steps.ts` and `TutorialSystem.ts`, not folders — cutting that way puts two agents in
> one file, which §3's rule 2 forbids. The working cut was by file ownership: `TutorialSystem.ts` (490) · `Steps.ts`
> (206) · `ui/` ×4 (174) · `parts/` ×4 (153), with the lead on `model.ts` (255). Read the folder's `README.md` first
> either way — it is already English and it, not §7, is what settles this folder's nouns.

> **`*.css` was invisible to this whole project until 2026-09-20.** Every script in this file filtered on
> `/\.(ts|mjs|js|cjs)$/`, so twelve folders' stylesheets — **1,335 Korean prose comment lines in 34 files**, a
> quarter of everything the queue had left — were never counted, never translated and never checked. `docs/TODO.md`
> B-65 caught it, and the pass is done (§2, row 27). Two things to carry forward: the measuring script now takes
> `.css` (§5), and so does `scripts/check-comment-labels.mjs`, which until then read a stylesheet **whole** as live
> strings — a Korean label mistyped in a CSS comment registered as the real string and justified a near miss anywhere
> else in the tree. The same hole is still open for a `data/*.csv` **comment** line (`docs/TODO.md` B-74).

---

## 1. Status

| | Lines | Files |
|---|---:|---:|
| Done (`src/extraction`, `src/progression`, `src/shared`, `src/main.ts`, `src/world`, `src/enemies`, `src/ui`, `src/housing`, `src/inventory`, `src/hub`, `src/tutorial`, `src/player`, `src/items`, `src/gadgets`, `src/allies`, `src/game`) | 22,060 | 553 |
| Done — `.css`, every folder at once (2026-09-20, B-65) | 1,335 | 34 |
| **Remaining** ([§2](#2-queue)) | **4,564** | **194** |

Measured with the script in [§5](#5-measuring). The first estimate in the session that started this work (31,700) was
too high: a naive Hangul grep also counts already-English comments that quote a Korean UI label.

**Intended permanent exceptions.** A finished folder still prints 76 lines — and the finished stylesheets 14 more — because a comment whose entire substance is
a quoted label, a quoted document heading or a verbatim user decision keeps its Korean (§3 rule 2 — the reader has to be
able to grep it against the real string). So a raw run over everything prints 4,640 / 248, seventy-six more than the
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
| `tutorial/model.ts:626` | the three stance label sets, drawn as the control guide swaps them (`C 앉기` · `Z 포복` · `C 일어서기`) |
| `tutorial/ui/Panel.ts:14-15` | the objective panel's ASCII diagram, drawn with real objective rows (`앞으로 이동`, `(선택) 시체에서 수류탄 획득`). Until 2026-09-19 it drew two rows that had **never existed** (`갈라진 땅까지 걸어간다`, `(선택) 수류탄으로 …`) — the diagram is prose, so nothing checked it; B-46 did |
| `tutorial/TutorialSystem.ts:1430` · `:1772` · `:1814` | an objective row (`제작창 닫기`), a toast (`레벨이 올랐습니다`) and the stance labels (`앉기` ↔ `일어서기`) |
| `player/PlayerSystem.ts:413` | the verbatim user decision the scene lock's `allowDamage` option was built from (`처치하지 않은 안드로이드의 사격을 맞은 채 출발한다 · 죽지 않는다`) |
| `player/RemoteAvatar.ts:611` | a verbatim user decision (`마지막 함선을 탔을 때 PC 가 함선 내부에 실루엣으로 보이지 않도록`) |
| `items/Loot.ts:552` | a verbatim user decision (`잠긴 방은 지금 그대로, 나머지는 서사 이상 절반`) |
| `gadgets/GadgetDefs.ts:205` | a `docs/DECISIONS.md` section heading (`2026-09-15 — 땅굴벌레 · 진동 장치`) |
| `game/parts/Death.ts:191` · `:345` · `:375` | verbatim user decisions: 「부활하면 서 있는 채로 나타나지 않고 쓰러졌다 일어난다」 and, twice, the wipe rule 「사람과 안드로이드가 모두 쓰러지거나 죽어야 레이드 실패」 — the same quote `ui/hud/SpectateOverlay.ts:76` keeps |
| `*.css` — **14 lines in 7 files** | the same shapes, in the stylesheets (2026-09-20): `inventory.css` ×3 and `base.css` ×2 are English sentences whose letters are mostly a quoted label (`Panel order: ship = 창고 · 장비 · 가방 · 제작`) plus the verbatim user bug report the `.item-tip` text-flow pin was built from; `hub.css` ×2 the five equipment-slot labels and the two launch-warning buttons `[취소] / [그래도 준비]`; `mining.css` ×2 a verbatim 2026-09-17 user decision and a divider that is only the three tab labels; `messenger.css` a `docs/DECISIONS.md` heading; `named.css` ×2 and `social.css` ×2 dividers that are nothing but an on-screen string (`스캔에 노출되고 있음`, `대화 기록`) |
| `game/parts/LoadGate.ts:3` | a `docs/DECISIONS.md` section heading (`2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩`), byte-identical to the one `allies/README.md:9` cites |
| `allies/parts/` — **7 lines in 5 files** | verbatim user decisions, each the *whole* substance of its line: `Loot.ts:3` · `:5` (「먹고 있을 때 PC 가 그 상자를 열면 중단」, 「핑이 먼저고, 혼자 주워 담는 것은 한가할 때뿐」), `Rescue.ts:3-4` (the two-line rescue decision), `Commands.ts:271` (「일반 범위의 2배로 각자 일대를 수색, 일정 시간 뒤 자동 해제」), `Contract.ts:4` (the tail of 「계약에 따라 다르나, …」), `Support.ts:3` (the hand-over conditions). This folder is written almost entirely out of quoted decisions, which is why it keeps more than most |

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
| ~~8~~ | ~~`src/tutorial`~~ | 1,278 | 11 | **Done 2026-09-19** (lead + 4 agents, one commit). 6 quoted-only lines stay (§1). Cut **by file**, not by track — see the banner above. Its track · step · stretch · objective-row · control-guide · spotlight vocabulary is now the reference for every guidance-shaped folder after it. |
| ~~9~~ | ~~`src/player`~~ | 949 | 30 | **Done 2026-09-19** (lead + 6 agents, one commit). 2 quoted-only lines stay (§1). Cut **by subject** and it held: controller · vitals / damage · wake + spawn + camera · body modes · soldier model · remote avatars, lead on `PlayerSystem` · `model` · `index`. Its body-mode · stance / pose · scene-lock · intro-wake · shouldering · rig vocabulary is now the reference for every controller- and avatar-shaped folder after it. |
| ~~10~~ | ~~`src/items`~~ | 612 | 12 | **Done 2026-09-19** (lead + 3 agents, one commit). 1 quoted-only line stays (§1). Cut **by subject** and it held: the roll engine (`Loot`) · the csv→table loaders (`LootTables` · `Recipes`) · the craft economy and spec rows (`Salvage` · `ItemSpec` · `WeaponStats`), lead on the item defs (`ItemDefs` · `WeaponDefs` · `ArmorDefs` · `ImplantDefs` · `ItemText` · `index`). Its roll · draw · pick · candidate pool · epic+ gate · bucket · craft-inputs vocabulary is now the reference for every data- and economy-shaped folder after it. |
| ~~11~~ | ~~`src/gadgets`~~ | 573 | 22 | **Done 2026-09-19** (lead + 3 agents, one commit). 1 quoted-only line stays (§1). Cut **by subject** and it held: drone bodies (`AirDrone` · `GroundDrone` · `Lifecycle` · `Scan`) · drone core + mounting (`drones/model` · `DroneSystem` · `Control` · `drones/Wire` · `parts/Mount`) · placement (`Preview` · `Deploy` · `Thumper`), lead on the host-authoritative centre (`GadgetDefs` · `GadgetSystem` · `GadgetVisuals` · `Queries` · `Simulate` · `Remote` · `Wire` · `Deployable` · `model` · `ThrownGadget`). Its deployable · placement-test · footprint · arming · detonation · mounting · drone-body vocabulary is now the reference for every deployable- and vehicle-shaped folder after it. |
| ~~12~~ | ~~`src/allies`~~ | 561 | 22 | **Done 2026-09-19** (lead + 4 agents, one commit, 10 scripts in 1 min 10 s, green first try). 7 quoted-only lines stay (§1) — the most of any folder so far, because the folder *is* a transcription of user decisions. Cut **by subject** and it held: orders · pings · requests · hand-over (`Commands` · `Support` · `Ping` · `Console`) · movement · free search · harness · combat (`Nav` · `Roam` · `Harness` · `Combat`) · bag · looting · objectives · vitals · extraction (`Bag` · `Loot` · `Extract` · `Rescue` · `Contract` · `Vitals`) · roster · ship · raid entry · wire (`Roster` · `Hub` · `Spawn` · `Sync`), lead on the centre (`AllySystem` · `model` · `Body` · `Fsm` · `index`). Its roster · unit · bay · proposal · rank · reaction-delay · harness · free-search · point-of-interest · designation · bound-kit vocabulary is now the reference for every AI-squad- and roster-shaped folder after it. |
| ~~13~~ | ~~`src/game`~~ | 537 | 14 | **Done 2026-09-20** (lead + 4 agents, one commit, 15 scripts + `e2e-mp` in 4 min 11 s). 4 quoted-only lines stay (§1). Cut **by subject** and it held: death · wipe · payout (`Death`) · corpses and their wire (`Corpses` · `CorpseNet`) · the session save, the title offer and the resume gate (`Session` · `Resume` · `SoloRaid` · `ResumeGate`) · raid entry and the two ends of a raid (`LoadGate` · `Leader` · `RaidReport`), lead on the centre (`GameFlowSystem` · `Phases` · `model` · `Wire`). Its phase · render hold · settlement · corpse-sink · title-offer · voluntary-return vocabulary is now the reference for every flow-shaped folder after it. |
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
| 26 | `scripts/` | 2,970 | 102 | Last on purpose — these are the verification harness. Changing a runner's comments cannot break the game, but a bad edit hides a real failure, so do this only once the game code is done and green. Biggest: `verify.mjs` 203 · `smoke-tutorial.mjs` 185 · `smoke-housing.mjs` 123 · `smoke-inventory-p6.mjs` 121 · `smoke-cooking.mjs` 95. |
| ~~27~~ | ~~`src/**/*.css`~~ | 1,335 | 34 | **Done 2026-09-20** (lead + 5 agents, one pass, `docs/TODO.md` B-65). Not a queue folder — a **file type the whole project had been filtering out** (§1 banner). Cut by owning folder, not by size: `base.css` (200) alone · the rest of `src/ui/styles` + `hud/rescuePicker.css` (371) · `inventory.css` (329) · `housing/**` + `game/resume-gate.css` + `ui/styles/fall.css` (238) · `tutorial` + `meta` + `hub` ×2 + `progression/ui` (220). 14 quoted-only lines stay (§1). A stylesheet's nouns are settled by **its own folder's already-English `.ts`**, not by §7 — the CSS has to read as one voice with the code beside it. |

`data/*.csv` is **out of scope** — its Korean columns are in-game display text. Its `#` **comment** lines are a
different thing, and `check-comment-labels.mjs` currently reads them as live strings (`docs/TODO.md` B-74).

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
   - **A one-line `/* … */` divider is just as dangerous**, and less obviously so (2026-09-20, the CSS pass). An
     agent's divider-rewrite helper ate the closing ` */` of `character.css`'s `/* ══ 2026-09-13 … ══ */`, and the
     rest of the file was swallowed into the comment. Step 4 caught it. Treat a divider like a block's last line.
   - **In a stylesheet, steps 4 and 4b are the same checks with the `//` branch removed** — CSS has no line comment,
     and running one over it blanks half a rule or a `url(//…)`. Filter to `.css`, keep the string branch (a
     `content:` value is a live string), and the rest of the method is unchanged.
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
4b. **Prove no retained Korean was re-typed** — a check `src/tutorial` added after catching itself, and the only one
   of these that catches this class at all.

   Rule 2 keeps a Korean label in a comment for exactly one reason: the reader must be able to grep it against the
   real string. Re-typing one syllable wrong destroys that, and **nothing else sees it** — not `tsc`, not a smoke, not
   step 4 (which strips comments before comparing). The `src/tutorial` pass mistyped `틈` as `턈` inside a quoted step
   title, and the earlier `src/shared` pass shipped the same class of error: `shared/tutorial.ts:72` said
   「앉아서 낮은 **픹**을 지나세요」 where the real title is 「… **틈**을 지나세요」 (fixed 2026-09-19 with `docs/TODO.md` B-46).

   The check is one line of reasoning: **every Korean run left in a changed file must appear verbatim in that file at
   HEAD.** Translating only ever *removes* Korean, so a run that is not in the old text is one you typed. Save as
   `<scratchpad>/korean_audit.py` and run it from the repo root:

   ```py
   import re, subprocess
   RUN = re.compile(r'[가-힣][가-힣 ·|/]*[가-힣]|[가-힣]')
   files = [f for f in subprocess.run(['git', 'diff', '--name-only'], capture_output=True,
                                      text=True, encoding='utf-8').stdout.split('\n') if f.endswith('.ts')]
   bad = 0
   for f in files:
       head = subprocess.run(['git', 'show', 'HEAD:' + f], capture_output=True, encoding='utf-8').stdout
       work = open(f, 'rb').read().decode('utf-8')
       runs = {}
       for i, line in enumerate(work.split('\n'), 1):
           for m in RUN.finditer(line):
               r = m.group(0).strip()
               if len(r) >= 2: runs.setdefault(r, i)
       for r, ln in sorted(((r, ln) for r, ln in runs.items() if r not in head), key=lambda x: x[1]):
           bad += 1; print('%s:%d  %s' % (f, ln, r))
   print('files checked: %d   runs not found in HEAD: %d' % (len(files), bad))
   ```

   **Anything but `runs not found in HEAD: 0` is a label you re-typed.** Its false positives are benign and rare: a
   Korean run you legitimately *split* across a re-wrap, or one you newly quoted from a neighbouring file — read those
   two kinds and move on.

   **4b is diff-scoped by design; the tree-wide sweep is a script.** 4b only sees what this pass changed, so a label
   a *previous* pass re-typed stays invisible to it forever. `node scripts/check-comment-labels.mjs --head` is the
   other half (added 2026-09-19 with B-46): it reads every Korean phrase quoted in a comment across the whole tree and
   reports the ones that are **within two edits of a live string but do not match it** — exactly the shape of a
   re-typed label, while prose that merely happens to be quoted has no near neighbour and stays quiet. It is advisory
   (exit 0) because its list still holds templates (`크레딧 n C`) and deliberate historical names, so it is read,
   not gated. Run it once when a folder leaves the queue.

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
   **`src/allies` shows the check earns its keep even when the glossary was handed out and every agent reported
   cleanly**: it caught three, one of them the lead's own. Two agents coined *the designation* for 지목 while the lead
   had written *the marked enemy* (wrong on its own terms — §7 binds 표식 to *the mark*); one wrote *the walk blend* and
   the lead *Look direction* where `shared/allies.ts` already says **movement blend** and **Look / aim point**. The
   pattern is the same every time: the conflicting word is one the *contract file* already names, so grep the contract,
   not only the READMEs.
   **Also expect an agent's applier to stop reproducing its own output.** One `src/allies` agent made three
   English→English polish edits with the Edit tool after running its script, so the script alone no longer rebuilds the
   final bytes. That is fine — the tree is authoritative, the scripts are not — but it means a re-run of an applier is
   never a recovery plan, which is the same reason §3 gives for measuring the tree when an agent dies.

**When an agent dies mid-bundle** — a rate limit will do it — the tree is left half-translated and its applier script
is **not re-runnable** (a later pair may match text an earlier pair already produced). Do not reason from the agent's
last message about what it finished. **Measure the tree** (§5), and translate whatever is left by hand. Three of seven
agents died this way in the `src/shared` pass and the recovery was cheap precisely because the count is authoritative
and the reports are not.

---

## 4. Verification

`npm run verify` picks smokes from the touched folders. Run `node scripts/verify.mjs --dry-run` first to see the
selection.

**Before that, check the column limit** — `awk 'length($0)>118' src/<folder>/**/*.ts`. §7's "wrap column (~118)" is
not an approximation: `src/tutorial` at HEAD had **zero** comment lines over 118 and a maximum of exactly 118, and
English runs longer than the Korean it replaces, so a pass blows through it without noticing (this one did, on 55
lines across two bundles, before the lead caught it). Only pre-existing **code** lines may exceed it. Growing the
line count to stay inside is fine and expected — `src/hub` and `src/tutorial` both did.

**`src/allies` cost 10 scripts and 1 min 10 s**, the cheapest folder-sized run in the queue so far
(`smoke-enemy-allies` · `smoke-allies-core` · `smoke-allies-orders` · `smoke-ally-avatars` · `smoke-ally-ui`, plus the
four static checks and `net-selftest`); `src/tutorial` cost 4 scripts and 1 min 26 s (`smoke-tutorial` ·
`smoke-tutorial-raid` · `smoke-tutorial-ship` · `smoke-intro-wake`). **A folder's smoke map, not its size, sets the
cost** — and not its script count either: `src/allies` runs more than twice as many scripts as `src/tutorial` in less
wall-clock, because four of its five are short and the 4 lanes absorb them.

- **A normal feature folder** costs 16–25 scripts and ~6 min: 16 for the pilot, 25 for `src/world`, 25 for
  `src/enemies` — whose folder map pulls in **`e2e-mp`**, so a red there is a real two-client run, not a unit check.
  `src/player` cost 22 scripts and 5 min 53 s, `e2e-mp` among them (179/179).
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

**One green at the parent proves nothing — `src/items` learned this the hard way.** `smoke-phase4`'s artillery
assertion went red three times at HEAD and **green at the parent on its single run**, which reads exactly like a real
regression. It was not: five serial runs at HEAD then gave red · red · green · red · red, and the failure payload's
`dist` drifts every run (86.90 · 86.96 · 87.24 m) because the sim is frame-timing dependent under swiftshader. The
parent had simply been lucky. Run the parent **more than once** before believing it.

**The decisive check for a comment pass is the compiler, not the smoke.** `tsc` emits with comments stripped, so if the
emit is byte-identical the change cannot alter runtime behaviour at all and any red is environmental — no number of
smoke runs is needed. It is one command per side (a temp dir of the folder's files at each commit):

```
npx tsc --ignoreConfig --removeComments --target es2022 --module esnext --moduleResolution bundler         --skipLibCheck --noResolve --outDir <out> <files>.ts
diff -rq <headjs> <parentjs>
```

`--ignoreConfig` is required (tsc 7 refuses to load `tsconfig.json` alongside file arguments) and `--noResolve`
keeps it from pulling the whole program in. This is a **stronger** statement than §3 step 4, which compares a
hand-rolled strip; reach for it whenever step 4 says `code changes: 0` and a smoke still disagrees.

---

## 5. Measuring

A plain `grep -P '[\x{AC00}-\x{D7A3}]'` over-counts by ~20 %: it also matches English comments quoting a Korean UI
label, and every Korean string literal. Count comment lines that are actually **Korean prose** instead — the comment
is parsed out, and a line counts only when it holds ≥ 4 Hangul syllables *and* Hangul is ≥ 35 % of its letters.

**The filter below is what hid `*.css` for the whole project** (`docs/TODO.md` B-65, fixed 2026-09-20): it takes
`.ts|.mjs|.js|.cjs` only, so 1,335 Korean comment lines in 34 stylesheets were never once counted. When you extend
this script to a new file type, extend the **comment parser** with it — a CSS comment is `/* … */` only, its
continuation lines have no `*` gutter, and there is no `//` branch at all.

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
  `B-36` · `B-37` · `B-38` · `B-39` (`src/inventory`, 20 + 8 + 3 + 2),
  `B-40` · `B-41` · `B-42` · `B-43` (`src/hub`, 20 + 5 + 5 + 4),
  `B-44` · `B-45` · `B-46` (`src/tutorial`, 14 + 2 + 1 — the last one a label **this project itself** mistyped in
  `src/shared`, which is why §3 now has step 4b),
  `B-47` · `B-48` · `B-49` · `B-50` (`src/player`, 9 + 7 + 5 + 6),
  `B-51` · `B-52` · `B-53` · `B-54` (`src/items`, 6 + 9 + 3 + 1 — `B-52` caught **three** counts of the same
  thing disagreeing, one of them in this folder's own `README.md`),
  `B-55` · `B-56` · `B-57` · `B-58` (`src/gadgets`, 11 + 5 + 3 + 3 — `B-58` is the first one that reaches
  **outside** the folder, into `data/constants.csv` and `src/shared/constants.ts`, because the 2026-09-15 fire
  merge left stale prose on both sides of the contract),
  `B-59` · `B-60` · `B-61` · `B-62` (`src/allies`, 14 + 6 + 9 + 2 — the richest folder yet, and `B-61` holds **two
  live bugs**: a crate ping carries the HUD's display label where the code reads a container id, so 「a pinged crate
  first, with no distance limit」 never actually loots, and an `item` ping can never become a pickup task, which in turn
  made a whole `parts/Loot` branch and the guard justifying it unreachable — `B-60`. `B-62` is a second one reaching
  outside the folder: one 2 m-separation decision written three different ways across `parts/Nav.ts`,
  `data/constants.csv` and `docs/DECISIONS.md`, so rule 2's grep chain was already broken for it).
  `B-74` · `B-75` (`src/**/*.css`, 1 + 3 — and far fewer than a folder of the same size gives, because a
  stylesheet's comments describe layout, which the rule below it proves or disproves on the spot. `B-74` is the
  richer one: `housing.css` quotes the analyzer rail tab as `해석 도감` where the drawn string is `분석 도감`, and
  `check-comment-labels.mjs` **cannot see it** because `data/constants.csv`'s own comment says `해석 도감` too and a
  csv is read whole as live strings).
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
| 망가진 짝 | **broken pair** — settled 2026-09-19 (B-50, user's decision): CLAUDE.md §4.6 · `shared/types.ts` won, and the nine *broken twin* spots in `inventory` · `items` · `progression` · `shared` were renamed | `inventory/parts/CorpseLoot.ts` |
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
| **구간** (다섯째 뜻) | **section** — a `ControlSection` group of the control guide. The fifth thing this word means, kept apart from the tutorial's *stretch*, the minigame's *band*, mining's *segment* and durability's *bucket*. In `ui/Controls.ts` the header's 「지금 구간에서 쓰는 조작」 **is** the raid-flow *stretch* (it is contrasted with the key guide's *screen*) while every other 구간 in that file is a *section* — decide from the code, as always | `tutorial/model.ts`, `ui/Controls.ts` |
| 목표 줄 · 지금 할 목표 · 사슬 | the **objective row** · the **current objective** (`currentObjective`) · the **chain** (`objectiveChain`) | `tutorial` (folder-wide) |
| 쌍 · 토큰 문장 줄 · 쌍 줄 | **pair** (`ControlHintPair`) · a **token-text row** (`ControlHint.text`) · a **pair row** (its opposite) | `tutorial/model.ts`, `ui/Controls.ts` |
| 꼬리표 (`(n/m)`) | the **tag** — §7's 꼬리표 row, **not** *tail*: `ui/menus/messenger` already binds *tail* to `.ms-tail` | `tutorial/model.ts`, `ui/Panel.ts` |
| 판 (스포트라이트) · 구멍 · 말풍선 (스포트라이트) | the **dim plates** (four) · the **hole** · the **callout** — never *speech bubble*, which is `ui/menus/messenger`'s 말풍선. Kept apart from the skip fade's **black plate** (`ui/HudSystem`'s word) | `tutorial/parts/Spotlight.ts` |
| 밝힌다 · 포커싱 · 딤 없는 포커싱 | **lights** (what the spotlight does to an element) · the **focus** · **no-dim** focus (`spotNoDim`) | `tutorial` (folder-wide) |
| 바닥 안내선 · 목표 빛기둥 · 목표 마커 · 점선 한 마디 | the **floor guide** · the **target pillar** · the **target marker** · a **dash** of the flowing **strip** | `tutorial/parts/Guide.ts`, `Marker.ts` |
| 걷는다 (안내선 · 검은 판 · 줄) | is **taken down** | `tutorial` (folder-wide) |
| 게이트 판정 · 숨김 전용 · HUD 점진 노출 | the **gate judgement** · **hide-only** · the **gradual HUD reveal** — one name; `README.md` writes the short "HUD reveal (`hudHidden`)" for the same thing | `tutorial/parts/Gates.ts` |
| 기본 지급품 vs 바닥 지급 | the **starter grant** (`기본 지급품`, what a new profile owns) vs the **floor grant** (`TUTORIAL_CRAFT_GRANT`, the floor the craft step tops up from) — two different things, never merged | `tutorial/model.ts`, `TutorialSystem.ts` |
| 흰 목록 · 조용히 지나친다 · 넘어가는 신호 | the **whitelist** (`TUTORIAL_STASH_WHITELIST`) · a **silent pass** / **passes it silently** · the **advance signal** | `tutorial` (folder-wide) |
| 한 박자 · 반 박자 · 기상 유예 | a **beat** · **half a beat** · the **wake grace** | `tutorial/model.ts`, `TutorialSystem.ts` |
| 가구 창고 | the **furniture store** (the DOM's own word, `.sm-tab[data-tab="store"]`) — deliberately **not** *stash*, which §7 reserves for `함선 창고`; both appear in `Steps.ts` | `tutorial/Steps.ts` |
| 무너진 통로 | the **collapsed passage**, and the steps across it the **crawl stretch** — the wording `shared/constants.ts` already uses for `TUTORIAL_CRAWL_AIM_HINT_FRAC` | `tutorial` (folder-wide) |
| 접힌 조작 가이드 · 구간 상자 | the **folded** control guide · a **section box** (`.tut-ctl-sec`) | `tutorial/ui/Controls.ts` |
| 눌림 강조 · 도장 · 새 줄 강조 | the **press highlight** / a **lit keycap** (`LitCap`) · the **stamp** (`data-kc`) · the **new-row highlight** (`is-new`) | `tutorial/ui/Controls.ts` |
| 함선 관리 모드 | **ship management** in prose (§7's `hub` row); the mode itself is named by its identifier `shipManageMode`, never re-worded | `tutorial/parts/Gates.ts` |
| **자세** | **two words, decide from the code**: **stance** for stand / crouch / prone (`setStance`, `canStandHere`) and **pose** for a body pose (`SoldierPose`, 가구 자세 = the **furniture pose**, 대기 자세 = the idle pose). One Korean word, two of this folder's central nouns | `player` (folder-wide) |
| 각본 잠금 · 각본 · 각본된 | the **scene lock** (`setSceneLock`) · the **scripted scene** · **scripted** (a scripted stand-up). 「각본이 몸을 들고 있다」 is *a scripted scene is holding the body* — the sentence `update`'s `scripted` flag is named after | `player` (folder-wide) |
| 기상 연출 · 부활 연출 | **the intro wake** (never *waking cutscene* — §7's `ui` row, `player/README.md`, CLAUDE.md §3.2) · **the respawn wake**, the `playIntroWake(d, {respawn:true})` variant, kept *under* the intro wake rather than given a second name | `player/parts/IntroWake.ts` |
| 들쳐메기 · 업힘 | **shouldering** (a downed squadmate) · **being carried** — `parts/Shoulder.ts`, `README.md`'s own word | `player` (folder-wide) |
| 구조선 | **the rescue drop** (`rescue_drop`, CLAUDE.md §4.6's word) — never *rescue ship*, although the Korean says 선. 구조 포드 is **the rescue pod**, the object | `player/parts/Spawn.ts`, `RemotePods.ts` |
| 전역 낙하 피해 · 낙사 · 치사 낙하 | **global fall damage** (the feature) · **a fatal fall** (§7) · **a lethal fall** — three things, kept apart | `player/parts/Fall.ts`, `PlayerController.ts` |
| 막타 · 출처 · 피격 연출 | the **last hit** (CLAUDE.md §4.8) · the **source** (`PlayerDamageSource`) · the **hit feedback**. `shared/types.ts:3455` still writes *hit shot* for the third — align that one line the next time it is touched, not in a player commit | `player/parts/Vitals.ts` |
| 단차 보간 · 하차 관성 · 천장 클램프 | **step smoothing** (`bodyOffset`) · **exit inertia** (`RIDE_*`) · **the ceiling clamp** — all three are `player/README.md`'s own words | `player/PlayerController.ts` |
| 가로대 · 옥상으로 올라서기 · 머리 위 공간 | **rung** (`LADDER_RUNG_M`) · **the mount** onto the roof (`climbMount`) · **headroom** — one word for both 머리 위 공간 and 헤드룸 | `player/parts/Climb.ts` |
| 남이 띄운 몸 · 면제된 낙하 | **a body something else lifted** · **an exempt fall** (`fallExempt`) — the pair the jump pad / bazooka rule is written in | `player/PlayerController.ts` |
| 병사 · 대역 (총) · 룩 | **the soldier** (`SoldierModel`) · a **stand-in** gun (README's word) · the **look** (`setAndroidLook` = the **android look**) | `player/SoldierModel.ts`, `GearLook.ts` |
| 잠든 슬롯 몸 | **dormant** / a body asleep in its slot (`AllyBodyView.pose === 'dormant'`) — a **third** state, kept apart from **suspended** (the member state that also renders grey) and from the android look | `player/AllyAvatars.ts` |
| 총구 연출 (`ally:fired`) | **shot FX** (muzzle flash + tracer + shot sound) — kept apart from §7's *presentation* / *cutscene* | `player/AllyAvatars.ts` |
| 초상 (얼굴 vs 전신) | the **face portrait** (`snapshotFace`) vs a **portrait** in `Portraits.ts` (full body) — the same split §7's `hub` row draws | `player/FaceSnapshot.ts`, `Portraits.ts` |
| 리그 · 흔들림 · 슬래브 · 위상 | the **rig** (camera rig) · **shake** (camera) · **slab** (a low / roof slab, the `hub` row's word) · **phase** (§7's `hub` row; 걸음 위상 = the **stride phase**, `stridePhase`) | `player` (folder-wide) |
| **armor vs armour** | **armor** in this folder's prose — its own English runs 130 : 2, and §7 binds 방탄복 → armor. `player/README.md` writes *armour* in four rows and `SoldierModel` · `RemoteAvatar` each keep one pre-existing *armoured trooper*; align those the next time they are touched, not in a translation commit | `player` (folder-wide) |
| 굴림 · 추첨 · 확정 픽 · 폴백 픽 | a **roll** · a **draw** · a **guaranteed pick** · a **fallback pick** — four words the `items` README already uses; a *pick* is one result, a *draw* is one consumption of the rng | `items` (folder-wide) |
| 서사 이상 게이트 | the **epic+ gate** — one name (`epicPlusMul`, `keep` in `Loot.ts`), never *epic+ drop-rate gate* even though the Korean says 드롭률 | `items/Loot.ts`, `LootTables.ts` |
| 갈래 (rng) · 본 rng | a **fork** (`rng.fork`) · the **main stream** | `items/Loot.ts` |
| 유령 줄 · 유령 카테고리 | a **phantom row** / **phantom category** (a csv row matching no item) — deliberately **not** *ghost*, which §7 binds to `world`'s ghost band and `ui/map`'s `.ghost` | `items/LootTables.ts`, `Loot.ts` |
| 안전망 vs 안전핀 | a **safety net** (a fallback that rescues a missed case, e.g. alias resolution) vs a **pin** (a guard outside `data:check`) — two different Korean words, kept apart | `items/Loot.ts`, `ItemDefs.ts`, `LootTables.ts` |
| 게임기 | **console** in prose (§7's `hub` row, `GAME_CONSOLE_ITEM_DEFS`) — never *game console*, even in a list beside *game discs* | `items` (folder-wide) |
| 미확인 표본 · 계열 · 해석 · 첫 해석 보너스 | an **unidentified sample** · **family** · **analysis** / analysing · the **first-analysis bonus**. The analyser is the **analyzer** (US spelling — the folder's own English runs 6 : 0) | `items/ItemDefs.ts`, `LootTables.ts` |
| 대표 숙련 · 대표 산출물 | the **lead skill** · the **headline output** — both take §7's `housing` *lead volume* shape | `items/ItemDefs.ts`, `Salvage.ts` |
| 배양 산물 · 특선 요리 · 야생 씨앗 군락 표 · 야전 병기 · 등급 문턱 | **culture product** · **special dish** · the **wild seed pool** (a kind of §7's *seed pool*) · **field ordnance** · the **grade threshold** (`benchLevel`) | `items/LootTables.ts`, `Recipes.ts` |
| 고쳐서 뜯기 · 저울이 기운다 · 대체 기준 · 검산 | **repair-then-salvage** · **tips the balance** · the **fallback baseline** (`fallbackCraftCost`) · the **economy check** (`checkSalvageEconomy`) | `items/Salvage.ts` |
| 대상 판정 · 안전장치 · 조준 계수 · 채널형 스프레이 | the **eligibility test** · a **guard** (kept apart from 안전핀 = *a pin*) · **aim coefficients** · the **channelled spray** | `items/Salvage.ts`, `WeaponStats.ts`, `ItemSpec.ts` |
| 제작 대개편 · 채광 개편 · 총기 밸런스 · 가젯 개편 · 온실 개편 | the **big craft rework** · the **mining rework** · **gun balance** · the **gadget rework** · the **greenhouse rework** — a rework's name is a concept, so it becomes English. `src/items/README.md` still writes `채광 개편` and `「신화 광물 1 → 제작 → 분해」` in Korean; align those the next time that file is touched, not in a translation commit | `items` (folder-wide) |
| 조각 (`SpecSeg`) | a **segment** — a fifth thing beside `enemies`' 마디, mining's 구간, the minigame's 구간 and durability's 구간; here it is literally the type's own name | `items/ItemSpec.ts` |
| 칩 · 재화 카드 vs 격자 카드 | the **chip · currency card** (`ui/hud/ItemTip`) vs the **grid card** (`inventory/ui/Tooltip`) — both tooltips' own pre-existing English | `items/ItemSpec.ts` |
| 전진기지 (레이더) · 수류탄 창고 | the **outpost raider** (site `outpost` in `loot_faction_sites.csv`) · a **grenade stash** | `items/Loot.ts` |
| 등급 (표본 줄) | **tier** when it is the csv `tiers` column (1..6, the rarity index) and **grade** / **rarity** everywhere else — one Korean word, decided from the code as always | `items/LootTables.ts`, `Loot.ts` |
| 배치물 · 설치물 | **deployable** — one word for both, `gadgets/README.md`'s own | `gadgets` (folder-wide) |
| 설치 판정 · 미리보기 · 고스트 · 발자국 | the **placement test** (`computePlacement`) · the **preview** · the **placement ghost** (never a bare *ghost* — §7 binds that to `world`'s ghost band and `ui/map`'s `.ghost`) · the **footprint** (`FOOTPRINTS`), whose ring is the **ghost ring** | `gadgets/parts/Preview.ts`, `GadgetVisuals.ts` |
| 공간 vs 간격 | **space** (obstacles overlapping the footprint) vs **clearance** (`PLACE_CLEARANCE`, the minimum distance between two deployables) — two different tests in one function, never merged. 평탄도 is **flatness** | `gadgets/parts/Preview.ts` |
| 거부 사유 | the **refusal reason** (`reason`, the nine `R_*` strings the HUD prints verbatim — they stay Korean) | `gadgets/parts/Preview.ts` |
| 해체 | **defuse** (`GADGET_DEFUSE_TIME`) — kept apart from `src/items`' 해체 = *salvage*. 회수 stays **recover** | `gadgets` (folder-wide) |
| 무장 · 기폭 · 기폭기 · 불발 | **arming** / **armed** (`armed`) · **detonation** · the **detonator** (§7's *detonator hand*) · a **dud** (a remote mine broken before it fires) | `gadgets/parts/Remote.ts`, `Simulate.ts` |
| 중첩 피해 · 소유자당 상한 · 삑 | **stacked damage** (CLAUDE.md §4.6) · the **per-owner live cap** (`GADGET_REMOTE_MINE_MAX_LIVE`) · the **beep** (`c4_beep`) | `gadgets/parts/Remote.ts` |
| 탑재 · 탑재판 | **mounting** (`Deployable.mount`, the README's word) · the **mount plate** (the drone's top plate; its pins are the **mount plate pins**) | `gadgets/parts/Mount.ts`, `drones/AirDrone.ts` |
| 돔 실드 · 방어막 · 발생기 · 개체 · 펼침 | `돔 실드` when the prose names the csv item, **dome shield** for the concept (the same split `housing` runs for `가구 창고`) · the **shield** · the **emitter** (the code's own `emitter`) · the **unit** · **unfolding** (`DOME_UNFOLD_TIME`) | `gadgets/GadgetDefs.ts`, `GadgetVisuals.ts`, `parts/Deploy.ts` |
| 진동 장치 · 타격 · 땅 판정 · 안내 기둥 · 망치 머리 | the **thumper** (README's word) · a **strike** · the **ground test** (`burrowGroundOk`), whose radius is the **ground-test radius** · the **rails** (`THUMPER_RAIL_H`) · the **hammer head** | `gadgets/parts/Thumper.ts`, `GadgetVisuals.ts` |
| 화염 통합 · 결과 창 개편 | the **fire merge** · the **results screen rework** — two 2026-09-15 decision headings this folder quotes in five files each; one name only | `gadgets` (folder-wide) |
| 칸 (풀 객체) | an **entry** (`sys.fireZonePool` · `fireZoneList`) — a sixth thing 칸 means, kept apart from inventory's grid *cell* / panel *pane* and `hub`'s station *slot* | `gadgets/parts/Queries.ts`, `model.ts` |
| 표현 전용 값 · 기하 분류 | **presentation-only values** (not gameplay numbers — `enemies`' *presentation numbers* in its section-divider form) · **geometry classification** (values that decide "what did the ray hit", not balance) | `gadgets/parts/Remote.ts`, `Preview.ts` |
| 조종자 vs 조종기 | the **controlling player** (the person) vs the **controller** (§7 — the quick-slot item that stays in hand). One Korean pair, two different things the drone files need side by side | `gadgets/drones` (folder-wide) |
| 보이는 몸체 · 제자리 호버 · 고도 상한 | the **visible body** (beside `visualYaw` = the *visual yaw*) · **hovering in place** · the **altitude cap** (README's band is the **altitude band**) | `gadgets/drones/AirDrone.ts` |
| 스키드 · 프롭 가드 · 블러 원판 · 짐벌 · 항법 LED · 경고 띠 | the **landing skids** · the **prop guards** · the **blur disc** · the **gimbal** (yoke · ball · **scope tube** (§7) · glass) · the **navigation LEDs** · the **warning band** | `gadgets/drones/AirDrone.ts`, `GroundDrone.ts` |
| 낮은 턱 | a **low ledge** — the thing `PROP_STEP_UP_MAX` lets a body ride onto. Kept apart from `world/structures`' 콘크리트 턱 = *sill* | `gadgets/drones/AirDrone.ts` |
| 건물 바닥 | a **building floor** (the walkable inside of a structure) — kept apart from `world/structures`' **floor plate**, which names the collider | `gadgets/parts/Preview.ts` |
| 조작감 · 설계안 | **handling feel** (a drone tuning section; `AirDrone` writes the short *Handling*) · the **design note** (`설계안 §3`) | `gadgets/drones` (folder-wide) |
| 명단 · 치트 명단 · 로컬 명단 | the **roster** · the **cheat roster** · the **local roster** — `shared/allies.ts`'s own words | `allies` (folder-wide) |
| 기 (한 기 · 기마다 · 세 기) | **unit** (§7's `ui/hud/Squad.ts` row): one unit · per unit · three units. The **body** is never a unit — `AllyBodyView` is the body | `allies` (folder-wide) |
| 슬롯 (allies) | **bay** wherever it means an android bay (`getAndroidBays` · `dormantIdOf` · `onReturned(bay)`), **slot** only for the lobby slot (`AllyRosterEntry.slot`, colour · launch pod · `getPodStandPose`). One Korean word, two things — decided from the code, as `hub` does for its own 칸 | `allies/parts/Hub.ts`, `Roster.ts` |
| 제안 · 서열 · 전이 · 반응 지연 | a **proposal** / proposes (`Fsm.propose`) · **rank** (the README's word — `PRIO.follow` ≡ `PRIO.roam` *share one rank*) · a **transition** · the **reaction delay** | `allies/parts/Fsm.ts`, `model.ts` |
| 하네스 · 자유 탐색 · 관심 지점 | the **harness** and its radius · the **free search** (`roam`) · a **point of interest** (`roamPoi*`; the identifier stays `POI`) — all three `allies/README.md`'s own words | `allies` (folder-wide) |
| 탈출구 | the **way out** (`shared/allies.ts`'s own word for `seekExtract`), kept apart from the **extraction pad** (the object), the extraction **console** and the **ship bay** (`ExtractionRef.isInShipBay`) | `allies/parts/Extract.ts` |
| 선착순 | **first one wins** for the rule, *the first one that arrived* in prose — both `shared/allies.ts` / `README.md` wording. Kept apart from an **order** (leader-only) and from **agreeing to** a PC's ping: three different things `parts/Commands.ts` needs side by side | `allies` (folder-wide) |
| 가자 · 주의 · 앞장 · 앞장서라 · 탈출 · 탈출하고 싶다 | **kept Korean in backticks / `「」`** — they are comms-wheel and ping labels (CLAUDE.md §4.6 and `allies/README.md` both keep them). Where the Korean had one bare, put it in backticks: `shared/allies.ts` already writes "a `주의` ping" | `allies` (folder-wide) |
| 지목 · 지목된 적 | the **designation** · a **designated enemy** (`AllySystem.preferredEnemyId`) — deliberately **not** *marked*, which §7 binds to 표식 = *the mark*, and not the field's own *preferred* | `allies/parts/Combat.ts`, `Commands.ts`, `AllySystem.ts` |
| 킷 · 기본 킷 · 묶인 물건 | **kit** · the **base kit** (`ANDROID_KIT`) · a **bound thing** — `shared/allies.ts`'s own words, and the rule is stated there in English already: do not coin a second phrasing for it | `allies/parts/Bag.ts`, `Hub.ts`, `Spawn.ts` |
| 배치값 | **a layout constant** (§7's `housing` row), keeping the Korean's closing "…, not a csv number". Two of them are really **judgement** constants by the `enemies` taxonomy (`Commands.PING_PAD_MATCH_M`, whose own sentence calls it a 판정 창) — translated as the Korean claims, filed rather than re-classified | `allies` (folder-wide) |
| 사선 (allies) | **line of sight** for sensing / re-targeting (`hasLineOfSight`) · **line of fire** for the friendly-fire block (`blockedByFriend`) — a third split of the word `world/tutorial` (diagonal) and `enemies` already divided | `allies/parts/Combat.ts` |
| 간격 (allies) | **separation** for `Nav.separate` (the 2 m squad rule) but **spacing** for `Spawn.SPAWN_GAP_M` — `shared/allies.ts` already writes "spawn spacing", so the two never merge | `allies/parts/Nav.ts` vs `Spawn.ts` |
| 옆으로 · 산개 · 조향 · 회피 · 우회 · 칸 (산개) | **sidesteps** (§7) · **spread** (`spreadToward`) · **steering** · **avoidance** (`avoidObstacles`) · **detour** (around a `주의` ping) · a **lane** (the code's own `lane` local: one lane left / right) | `allies/parts/Nav.ts` |
| 짐 · 짐 버리기 · 이관 | the **load** (weight) · **junk dropping** (`dropJunk`) · the **deposit** (`ally deposit`) | `allies` (folder-wide) |
| 건네주기 · 자율 루팅 · 상자 후보 · 내용물 미리보기 | **handing over** / the **hand-over** · **autonomous looting** · the **crate candidates** · the **contents preview** (`peek`) | `allies/parts/Support.ts`, `Loot.ts` |
| 대기 피해 | **atmosphere damage** (the planet-atmosphere tick) — kept apart from a **hazard** tick, which is the other half of `Vitals.update` | `allies/parts/Vitals.ts` |
| 걸음 (블렌드) vs 걸음 (위상) | the **movement blend** (`moveBlend`) vs the **stride phase** (`stridePhase`) — `shared/allies.ts` names both, so neither becomes a *walk blend* | `allies/parts/Nav.ts` |
| 시선 · 시선 점 | the **look point** (`lookVec` · `LOOK_DIST_M`) — `shared/allies.ts` writes "Look / aim point" for `lookAt`, so never a *look direction* | `allies/parts/Body.ts`, `Roam.ts` |
| 연출 동기값 · 질의 창 · 저수지 표본 | a **cutscene sync value** (`Spawn.POD_LAND_S`, which tracks `player/Hellpod.ts`'s cutscene length) · a **query window** (`Nav.OBS_QUERY_M`) · the **reservoir sample** (`Roam.consider`) | `allies/parts` |
| 대체값 · 크루 카드 · 조작된 id | a **stand-in** (`shared/allies.ts` already writes "Stand-in PeerId") · the **crew card** (`NetRef.getCrewCard`) · a **tampered id** | `allies/parts` |
| 한 마디 · 한 줄 말한다 | **says a line** / **one line** — a *spoken* chat line (`Ping.say`), never a comms-wheel entry, which is an **order** | `allies` (folder-wide) |
| 훈련장 · 레이드 실패 (개념 vs 화면) | **the training range** · **raid failure** for the concept; the Korean stays when the prose names the on-screen thing — `시뮬레이션 훈련장` the button (`hub/ui/HubMenu`'s precedent) and `레이드 실패` the death-screen title or its mode (`ui/menus/DeathScreen`, `ui/HudSystem:856`). The same split `housing` runs for `가구 창고`; do not sed one into the other | `game` (folder-wide) |
| 분대 전멸 · 전멸 판정 · 자발적 귀환 | the **squad wipe** · the **all-dead check** (`checkAllDead`) · the **voluntary return** — all three `game/README.md`'s own words. The menu entry stays `함선으로 귀환` | `game/parts/Death.ts` |
| 사망 연출 | the **death animation** — `player/PlayerSystem.ts:1233`'s own words for what runs during the `DEATH_TO_SCREEN` wait. Never a *cutscene* (§7's `ui` row reserves that for a timed sequence that owns the screen) | `game` (folder-wide) |
| 결산 · 정산 · 보상 | **settlement** / settles (`settleMission`) · the **payout** (README's section title) — one word for 결산 and 정산 both | `game` (folder-wide) |
| 결과 화면 · 보상 창 | the **results screen** — **one name**, including inside a quoted user decision that said 보상 창 (`Death.ts:204`, where the next line already said *results screen*). Kept apart from `ui`'s own screens | `game/parts/Death.ts`, `RaidReport.ts` |
| 결과 창의 재료 | **what fills the results screen** — never *the results screen's material*; §7 binds 재료 to the crafting sense and `GameFlowSystem.ts:62` already says *fills* | `game/parts/RaidReport.ts` |
| 원인 줄 | the **death cause row** — `ui/menus/ResultReport.ts` · `results.css` already name it, so never the shorter *cause row* | `game/parts/RaidReport.ts` |
| 게이트 · hold · 원형 게이지 | the **raid-entry loading gate** · a **render hold** (`ctx.shaders.holdFor`) · the **radial gauge** — README's words; the promise's resolve is the **handle** that releases the hold | `game/parts/LoadGate.ts` |
| 타이틀 이어하기 · 레이드 포기 · 내민다 | **title resume** · **abandon** (`abandon()`) · **offers** (`offer`) for the concepts; the buttons `이어하기` / `레이드 포기` / `게임 시작` stay Korean | `game/parts/Resume.ts` |
| 솔로 유예 · 시계 방어 · 오프라인 방어 · 상했다 | the **solo grace** · the **clock defence** (the mechanism, README's word) · the **offline defence** (E-5's *name*, `SoloRaid.ts:150`) · **stale** (`soloRaidBootStatus`) | `game/SoloRaid.ts` |
| 표 vs 표식 (레이드) | **the mark** for `SQUAD_RAID_MARK_KEY` (`shared/raidResume.ts`'s word) vs **the marker** for the loadout's `raidSeed` kit flag (`SoloRaid.ts`'s pre-existing English) — both appear in `parts/Resume.ts`, never merged | `game/parts/Resume.ts` |
| 호스트 이관 | the **host transfer** (CLAUDE.md §4.6) — a third sense, kept apart from `housing`'s 이관 = *migration* and `allies`' 이관 = *the deposit* | `game/parts/Wire.ts`, `Leader.ts` |
| 재개 게이트 · 가라앉기 시계 · 복제 경로 | the **resume gate** (`ResumeGate`; its overlay text `좌측 클릭으로 게임 재개` stays Korean) · the **sink clock** (`emptiedAt` + the mission clock — deliberately not `enemies`' *lifetime*, a different mechanism) · the **duplication path** (the corpse-plus-bag dupe README calls "reload duplicates gear") | `game` (folder-wide) |
| 밟을 수 있는 표면 | the **walkable surface** — already the repo's word (`world/tutorial`, `WorldSystem`, `gadgets/parts/Queries`), kept apart from §7's 발판 = *floor plate / platform* | `game/Corpses.ts`, `parts/CorpseNet.ts` |
| 킬 자리 · 주인 없는 물건 · 계약 스텁 | the **kill site** (where `enemies/` adds `raidXp` into `stats.killXp`) · an **ownerless thing** (the squad-leader device left behind) · a **contract stub** (README's Rules) | `game/parts/Death.ts`, `Leader.ts` |
| 신뢰도 (기업) vs 신뢰도 (NPC) | **reputation** for a corporation (`meta/README.md`, CLAUDE.md §3.4, `rep` · `getRep` · `.corp-rep`) vs **trust** for an NPC (`NpcRules.ts`). The row above binds 신뢰도 → *trust*; that is the NPC sense only. The on-screen label `신뢰도` stays Korean either way |
| 매대 · 구매칸 / 판매칸 · 거래 테이블 | the **stock shelf** · the **buy tray** / **sell tray** (`meta/README.md`'s word) · the **trade table** (the middle column), kept apart from the README's **trade desk** = the whole page |
| 즐겨찾기 (ui) vs 즐겨찾기 (inventory) | **favorite** in `src/ui` (its own English: `ItemFavoriteMenu`, "favorite menu") vs **favourite** in `src/inventory`. Deliberate — do not sed one into the other |
| 전소 / 감전 (지도 표식) | **burn / shock** — the marker classes `.smarker.burn` / `.shock`; kept apart from `enemies`' 전소 → *incinerated*, which is the enemy **state** |
| 준비 연출 · 지지직 · 칸 (휠) | the **ready presentation** (`.is-ready` glow + ring burst) · the **static** around the screen edge (`.dr-static`) · **sectors** (`.csector` / `.psector`), kept apart from a save-slot **empty slot** and the scan-warning **pips** |
| 투명한 막 · 드래그 렉 규약 · 구분막 | a **transparent sheet** (a `pointer-events: none` overlay root) · the **drag-lag convention** (no transitions on a drag target, transform only) · the **divider** |
| 금속 결 · 판정 안내원 · 옆 칸 · 자동 연출 | a **brushed-metal gradient** · the **judgement guide ring** · the **side column** (never inventory's *cell* / *pane*) · the **auto presentation** (the auto-appliance cook) |
| 로제트 · 폴백 배치 플래시 · 아래 균형 칸 · 호스트 (임베드) | the **wheel rose** (never *rosette*) · the **fallback placement flash** · the **balancing box at the bottom** · the **host screen** (the embedding caller), kept apart from the network *host* |
| 재료 요구 칩 · 칩 호버 카드 · 지속 사용 티커 | the **material cost chip** · the **chip hover card** · the **channel ticker** (`ui/README.md`'s own word) |
| 피격 / 전투불능 / 실드 잔상 | the **damage ghost** · the **downed ghost** · the **shield ghost** |
| 장비 판 · 가치 합계 · 초상 (매칭) vs 초상 (준비) | the **gear board** · the **value total** · a **face tile** in `MatchTab` vs a **portrait** in `ReadyPanel` |
| 구간 (`--frac`) | **inside the current level's range** — a seventh sense of 구간 was *not* coined; *band* · *bucket* · *stretch* · *section* · *segment* are all taken |
