# src/console — 개발자 콘솔 (dev console / cheats, Phase 6)

Owner system: `ConsoleSystem` (`name: 'console'`), publishes `ctx.console` (`ConsoleRef`, `src/shared/console.ts`).
Registered **last** in `src/main.ts` so it reads every other ref's final state for the frame.
Only a **dev client** gets a console: `enabled = isDevHost()` (page hostname in `DEV_HOSTS` — localhost / 127.0.0.1 / ::1).
On any other host no DOM is built, no key listener is installed and `run/print/open/close` are no-ops (`register`/`getCommands` still work).

| File | Role |
|---|---|
| `ConsoleSystem.ts` | DOM (`.dev-console` under `ctx.uiRoot`: log → suggestion list → input row), ` toggle + Esc/↑/↓/Tab/Enter in a **capture-phase** window listener, blocker `'console'` + pointer-lock etiquette, `run()` parser / dispatcher, output log (`CONSOLE_MAX_LINES`), suggestions (`CONSOLE_SUGGESTIONS_MAX`), history (`CONSOLE_HISTORY_KEY`, `CONSOLE_HISTORY_MAX`, localStorage), Home move cheat in `update()` |
| `console.css` | Bottom bar styling (z-index 90, mono font, line colours by `ConsoleLineKind`) |
| `commands/index.ts` | `builtinCommands(host)` — the list below, in `help` order; `BuiltinHost` = what commands need beyond `ConsoleRef` (`clearLog`, `setMoveCheat`, `moveCheat`) |
| `commands/types.ts` | `BuiltinHost`, `CommandFactory`, helpers `err`, `parseNumber`, `fmt` |
| `commands/help.ts` `clear.ts` `seed.ts` `move.ts` `movecheat.ts` `items.ts` `stat.ts` `skill.ts` `gym.ts` `cook.ts` `pos.ts` `colliders.ts` | One built-in each (see table) |
| `ColliderOverlay.ts` | (2026-09-12) `colliders` 명령의 와이어프레임 — `ctx.world.getObstacles()` 중 플레이어(없으면 카메라) 둘레 30 m 를 `LineSegments` 하나에 0.25 초마다 다시 채운다 (원기둥 노랑 · 상자 하늘 · 경사 초록 · 볼록 윤곽 주황 + 총알 층 어두운 주황). 깊이 검사 끔 · 광원 없음 · 게임플레이 페이즈에서만 보인다 · 끄면 dispose |
| `index.ts` | exports `ConsoleSystem` |

## Commands (input accepts `/move …` and `move …`, case-insensitive; unknown → red line; all output 한국어)
| Command | Where | Does |
|---|---|---|
| `help [name]` | anywhere | Sorted list `/usage — description`, or one command's usage + description. `complete` = command names |
| `clear` | anywhere | Empties the log |
| `seed <숫자\|문구\|random>` | `hub` phase only | `ctx.hub.setMissionSeed(seed)`; digits → uint32, other text → FNV-1a (same rule as the hub `parseSeed`, copied into `seed.ts`), `random` → null. Non-host in a lobby → `로비 호스트만 …`. Emits `cheat:seed` |
| `move <x>,<y>,<z>` | gameplay phases only | Commas / spaces both split the numbers. `world.isInsideBounds` false → `맵 범위를 벗어났습니다 (±MAP_SIZE/2)`. y below `getHeightAt` snaps to the terrain. `ctx.player.teleport(pos, undefined, snapped)` |
| `movecheat [0\|1]` | anywhere (moves while `isControlActive()`) | Toggle (no arg = flip; `on/off/true/false` accepted). While on and `Keys.MOVE_CHEAT` (Home) is held, `update()` teleports the player along **camera forward** by `MOVE_CHEAT_SPEED × dt` (planet and ship; inside map bounds, y ≥ terrain on the planet). Emits `cheat:moveCheat` |
| `items` | anywhere | Closes the console, then `ctx.inventory.openCatalog()` (the infinite-crate window is inventory's) |
| `stat <id\|이름> <±xp>` | anywhere | `ctx.progression.addStatXp(id, n)`; id = `str/end/per/int/dex`, full id, or 한국어 (근력 …). Prints `근력 7 (312/1852)` from `getStat` / `getStatProgress` / `statXpToNext`. `complete` = aliases + ids + names |
| `skill <id\|이름> <±xp>` | anywhere | `ctx.progression.addSkillXpRaw(id, n)`; 14 ids (`gun_AR` …, case-insensitive) or 한국어 names (the name may contain spaces — the last token is the xp). Prints `사격 · 돌격소총 Lv.3 (40 %)`. `complete` = ids + names |
| `gym [clear [str\|end] \| <str\|end> <±xp>]` | anywhere | (2026-09-12, A-3a) **공개 `ProgressionRef` API 만** 쓴다 (`profile.trained` · `gymFatigueUntil` 를 직접 만지지 않는다). 인자 없음 → 두 운동 능력치의 `근력 단련 +2 (40/120) · 근육통 23:12:05` (`getTrainedBonus` · `getTrainedProgress` · `trainedXpToNext` · `getGymFatigueUntil`). `<str\|end> <±xp>` → dev 전용 `addTrainedXp(stat, xp)`(디버프 · 함선 게이트 · 세션 상한 없음, 음수는 뺀다) 뒤 `단련 경험치 +50 · 근력 단련 +1` + 상태 줄. `clear [str\|end]` → `clearGymFatigue(stat?)`(생략 = 둘 다) 뒤 상태 줄. 두 dev 메서드는 optional 이라 없으면 `진행 시스템에 addTrainedXp 가 아직 없습니다` 빨간 줄. 스탯 이름은 `stat` 의 `resolveStatId`(str/end · 전체 id · 한국어). `complete` = `clear` / `str` / `end`, `clear ` 뒤에는 `str` / `end` |
| `cook [give <요리 id\|이름> [품질 0-5] [수량]]` | anywhere | (2026-09-13, 요리 미니게임) **공개 ref 만** 쓴다. 인자 없음 → `조리 중: <요리> (단계 n개)`(`ctx.housing.cookSession`) 또는 `조리 중이 아닙니다` + 사용법. `give` → 요리 def(`ItemDef.meal` 이 있는 것 — id 대소문자 무시 · 한국어 이름 · 띄어쓰기를 뺀 이름)를 `ctx.loot.createItem(id, n)` 으로 만들고 `quality`(0 이면 안 붙인다)를 붙여 `ctx.inventory.tryAddItem` — 수량은 `stackMax` 묶음으로 나눠 넣고 자리가 없으면 넣은 만큼만(빨간 줄 `가방에 자리가 모자랍니다: <요리> ★★★☆☆ ×2 / 5`). 이름에 띄어쓰기가 있을 수 있어 **끝의 숫자 토큰**(최대 둘)을 품질 · 수량으로 읽는다. 품질은 0 … `MEAL_QUALITY_MAX` 정수, 수량은 1 … 99. 조리대 요리가 아니면(`cookStepsOf` 빈 배열) 줄 끝에 `· 조리대 요리 아님`. 오류: `알 수 없는 요리` · `요리가 아닙니다`(아이템은 있는데 요리가 아님) · 품질 · 수량 범위. `complete` = `give`, 그 뒤 은퇴하지 않은 요리 id / 이름 |
| `pos` | anywhere | Phase (+ 멀티플레이 / ship / room), feet position, yaw, world seed |
| `worm [뱉기초]` | gameplay phases, authority (not the 훈련장) | (2026-09-13) 지하벌레 이벤트를 **지금** 내 발밑에서 시작한다 — 굴림 · 시각 창 · 레이드당 1회를 무시. `뱉기초` = 이번 분출의 버그 뱉기 단계 길이(초, 0 = 곧장 독극물). enemies/ 를 import 하지 않고 `cheat:sandworm {spitS?}` 버스 명령만 낸다 (`EnemySystem` → `sandworm/Director.debugForce`). `commands/worm.ts` |
| `colliders [0\|1]` | anywhere (draws in gameplay phases) | (2026-09-12) Toggle (no arg = flip) the collider wireframe around the player (`ColliderOverlay`). Prints `콜라이더 표시 켜짐 (n개)`. For hunting "보이지 않는 벽" — the colliders buried inside walls show because depth test is off. `complete` = `0` / `1` |

Other folders add commands with `ctx.console.register({ name, usage, description, run, complete? })` (returns the unregister
function; same name replaces). `run` may return a string (green line), `{ error }` (red line), nothing, or a promise of those;
thrown errors become red lines. `console:executed { line, ok, output }` fires after each run with every printed line joined by `\n`.

## Flow
```
` (Keys.CONSOLE, capture listener) ── not open ──▶ open(): uiBlockers.add('console') → input.setCursorMode(true, 'console')
                                                      (Phase 10: the pointer lock is KEPT) → root shown, input focused,
                                                      console:toggled {open:true}
                                   ── open ──────▶ close(): root hidden, blocker removed, setCursorMode(false, 'console'),
                                                      console:toggled {open:false}  (no re-lock — nothing unlocked)
typing ──▶ 'input' event ──▶ suggestions: no space yet → commands whose name starts with the text (`/usage — description`);
           after `cmd ` → cmd.complete(args) filtered by the current token. Cursor −1 by default.
↑/↓ ──▶ input empty (or already browsing history, or no suggestions) → history (newest first, past the newest = the draft);
        otherwise → suggestion cursor (wraps)
Tab ──▶ apply the cursor suggestion (first when none)        Enter ──▶ apply the cursor suggestion, else submit → run(line)
Esc ──▶ close only the console (stopImmediatePropagation, so GameFlow's pause never sees it)
Home (Keys.MOVE_CHEAT) held + moveCheat + isControlActive() + console closed ──▶ update() teleports along camera forward
```
The ` keydown is `preventDefault`ed so the character never lands in the field; when another text field (chat, terminal name)
has focus the key is left alone. Keys typed into the input stop at the element (never reach `Input`); keys dispatched elsewhere
while the console is open are swallowed in the capture phase so the player does not move.

Events: emits `console:toggled`, `console:executed`, `cheat:moveCheat`, `cheat:seed`. Listens to one bus event (below), otherwise
reads refs directly. Does not close on phase changes — a dev tool stays where it was.

**2026-09-11 (E-4 서버 크레딧 검증)** — `/credits` (meta 가 등록하는 명령) 는 서버 프로필이 있으면 dev 사유 `console` 로 `credits:tx` 를
보낸다. 릴레이는 `SCAV_DEV_ECONOMY=1` 로 띄운 것(스모크 러너가 스스로 띄우는 릴레이)만 그 사유를 받고 **`npm run dev:all` · `npm run server`
는 거절**하므로(사용자 결정), meta 가 크레딧을 되돌리면(`meta:creditsChanged {reason:'revert:console'}`) 콘솔이 빨간 줄 하나를 찍는다 —
`서버가 /credits 를 거절했습니다 — 개발용 크레딧은 SCAV_DEV_ECONOMY=1 로 띄운 릴레이에서만 됩니다`. 오프라인(릴레이 없음)에서는 예전처럼 로컬로 먹는다.

## Verification
`node scripts/smoke-console.mjs` (needs `npm run dev`): dev-host gating (`isDevHost('example.com') === false` via a dynamic import of
`/src/shared/console.ts`), ` open / blocker / Esc close, `mo` → `move` + `movecheat` suggestions with ↑/↓ cursor + Tab, `/move` refused
in the ship, `/seed 42 / random / 문구` (FNV matches), `/movecheat 1` + Home hold → position advances, `/move 10,0,10` on the planet
(y ≥ terrain), `/move 9999,0,0` → range error, `/items` (catalog opens), `/stat` (rise to STAT_MAX / floor at STAT_MIN), `/skill`, `help`, unknown
command, `clear`, history in localStorage + ↑/↓ recall, Esc does not pause, W while open does not move — **63 checks, 0 console errors**
(2026-09-06). Registered in `scripts/verify.mjs` (`smoke-console`). The script parks vite's `vite-hmr` WebSocket in CONNECTING so a
save in another editor cannot full-reload the page mid-run.

## Phase 10 UI 개선 pass (2026-09-07)

**인게임 커서 (`docs/DECISIONS.md` Phase 10).** `open()` adds the `'console'` blocker and then calls
`ctx.input.setCursorMode(true, 'console')` **without** exiting the pointer lock; `close()` deletes the token and calls
`setCursorMode(false, 'console')`, and the re-lock microtask (`isControlActive()` / `isDead` guarded) is gone —
nothing ever unlocked, so there is nothing to restore. `dispose()` releases both when the console was open.
`setCursorMode` is ref-counted per blocker token, so opening the console over another cursor surface (the inventory,
the corp screen) and closing it again leaves that surface's cursor alone.

No DOM handler changed: the software cursor dispatches real bubbling `pointer*` / `mouse*` / `click` / `wheel`
events at its virtual position, so the suggestion list's mouse wiring and the input field keep working. The folder
polls neither `input.mouseX / mouseY` nor `document.elementFromPoint`, so nothing else needed migrating. The console
is still dev-client only (`isDevHost()`), so this path never runs for a player.

- **2026-09-13 (지하벌레)** — 명령 `worm [뱉기초]` + `commands/worm.ts` (위 표). 콘솔은 `cheat:sandworm` 을 낼 뿐이고(새 이벤트, `shared/events.ts`
  끝에 추가) 검사는 게임플레이 페이즈 · 권위 · 훈련장 아님까지만 — 전조가 이미 돌고 있으면 enemies/ 가 조용히 무시한다. 스모크는 같은 경로의
  `EnemySystem.debugSandworm` 을 직접 부른다 (`scripts/smoke-sandworm.mjs`).
- **2026-09-13 (요리 미니게임, 에이전트 cook-misc — docs/plans/cooking-minigames.md §6-5)** — 명령 `cook [give <요리 id|이름> [품질 0-5] [수량]]` +
  `commands/cook.ts` (위 표), `commands/index.ts` 의 `help` 순서에서 `gym` 다음. 품질 붙은 요리를 가방에 넣어 툴팁 별 · 품질 스택 분리 · 식탁 · 버프 별을
  조리 미니게임 없이 확인하려고 만들었다. `ItemInstanceExtras` 에 `quality` 가 없어(계약은 `ItemInstance.quality?` 만 더했다) `createItem` 뒤 인스턴스에 직접 적는다.
- **2026-09-12 (헬스장 A-3a)** — 명령 `gym [clear [str|end] | <str|end> <±xp>]` + `commands/gym.ts` (위 표). **공개 `ProgressionRef` API 만**
  쓴다: 상태는 단련 · 디버프 질의 넷, 경험치는 리드가 계약 끝에 더한 dev 전용 `addTrainedXp?(id, xp)`, 지우기는 `clearGymFatigue?(id?)`
  (둘 다 optional 이라 `typeof` — 없으면 무엇이 없는지 빨간 줄). `applyGymSession` 은 부르지 않는다(세션 상한 · 디버프가 붙는다).
- **2026-09-12** — 명령 `colliders [0|1]` + `ColliderOverlay.ts` (구조물 도달성 작업, `src/world/README.md` 의 `## 2026-09-12`).
  `BuiltinHost` 에 `setColliders` · `colliders` · `colliderCount` 가 붙었고 `update()` 가 이동 치트보다 먼저 오버레이를 돌린다
  (dev 클라이언트에서만 만든다 · `dispose()` 가 정리한다).
- **2026-09-08** — 명령 `tutorial [start|skip|step <id>|status]` 가 붙었다. 등록은 `tutorial/TutorialSystem.init`
  이 `ctx.console.register` 로 하고(콘솔이 없는 호스트에서는 조용히 건너뛴다), 이 폴더는 아무것도 모른다
