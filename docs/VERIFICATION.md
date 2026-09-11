# Verification — procedure and history

This file is the record of what was actually tested, moved out of `CLAUDE.md` on 2026-09-06 so the command center stays
short. **Append new results here** (one dated bullet per package, newest last); `CLAUDE.md` keeps only the procedure.

## Procedure (what to run, in this order)

| Step | Command | Wall time | When |
|---|---|---|---|
| 1. Static | `npm run typecheck` (+ `typecheck:server`) | seconds | after every edit |
| 2. Targeted | `npm run verify` | 1–2 min | after a feature — picks the smokes mapped to the folders touched in the working tree (`node scripts/verify.mjs --list` shows the map); `--folders a,b` / `--only name,…` override |
| 3. Re-check | `node scripts/verify.mjs --rerun-failed` | < 1 min | re-run only what failed in the last run (recorded in `scripts/logs/last-run.json`) |
| 4. Full | `npm run verify:all` | ~2 min | before a merge to `main` or after touching `src/shared` / `src/core` / `main.ts` (the runner does this automatically when those paths changed) |
| 5. Docs | update the folder `README.md`s you touched, the `CLAUDE.md` folder map row, and paste the runner's `docs line:` into the history below | — | last |

Why the runner exists (measured 2026-09-06): the scripts used to render through **swiftshader** (CPU rasterizer, ~5 fps,
`dt` clamped to 50 ms): one smoke script was ~140 s of wall time for 44 checks, the eight scripts 20–30 min one after another,
and parallel lanes gained nothing because the work is CPU-bound (2 lanes: 31 min, machine at 90 %+ CPU). Switching the
launch flags to the real GPU (`--use-angle=d3d11 --enable-gpu`, `GL_ARGS` in every script; headless Chrome reports the
RTX 4080 SUPER) made the same script 18 s and the whole suite **2 min 7 s** with 4 lanes. The runner starts vite / relay
itself, restarts the relay before `e2e:mp` (stale public lobbies from an interrupted run hijack quick match during the 5-min
grace), staggers lane starts 8 s so vite warm-up and Chrome launches never coincide, keeps the console output to one line per
script + the `FAIL` lines (full output in `scripts/logs/<name>.log`), and records failures for `--rerun-failed`.
`SMOKE_GL=swiftshader` restores the CPU path for a machine without a GPU (use `--jobs 1`).

Measured 2026-09-06 (same 9 scripts, all green):

| Setup | Total |
|---|---|
| swiftshader, one script at a time (old practice) | ~25–30 min + reruns |
| swiftshader, 2 lanes | 31 min 26 s |
| GPU (D3D11), 2 lanes | 3 min 6 s |
| GPU (D3D11), 4 lanes | 2 min 7 s |

Cursor trap: headless Chrome honoured the game's `requestPointerLock()` after a trusted puppeteer click, and on Windows a
pointer lock calls ClipCursor — the OS cursor got stuck inside the hidden 960×540 window at the top-left of the screen until
the script ended. Every script now stubs `Element.prototype.requestPointerLock` / `Document.prototype.exitPointerLock` via
`evaluateOnNewDocument` (the fake `pointerLockElement` getter still tells the game it is locked).

Rules that still apply inside the scripts: waits are on simulation time (`ctx.time`, `waitSim`), key taps dispatch
keydown+keyup in one frame on `document.body`, pointer lock is faked (never real), effects timed on `ctx.time` cannot be
accelerated (on the GPU game time ≈ wall time; under swiftshader budget ~0.05 s of game time per frame). A check that fails on a timing window is usually the harness, not the game — read
the log before changing code. Per-check resume is not possible: every script builds game state check by check, so the unit of
re-run is the script.

When you add a smoke script: add it to `SMOKES` in `scripts/verify.mjs` with the folders it covers, and to the Commands block
in `CLAUDE.md`.

## History (what was actually tested)
- 2026-09-12 (24차) UI/UX 묶음 — 기업 화면 · 인벤토리 · 구조물 계단/콜리전 · 하우징 모드 · 가구 화면 (`src/shared/{types,housing,events,constants}.ts` **추가만** · `data/{bags,recipes,furniture,furniture_upgrades,facility_upgrades,tables,constants}.csv` · `src/{inventory,meta,housing,hub,ui,world/structures,console,tutorial}` · 신규 스모크 `smoke-structure-reach` · `smoke-stations`, **에이전트 5개 병렬(같은 작업 트리) + 리드**):
  - 에이전트 각자: `--only <자기 스모크> --keep-relay --no-e2e --jobs 2 --log-dir scripts/logs/fork-<x>` (리드가 vite + `SCAV_DEV_ECONOMY=1` 릴레이를 한 벌 띄워 공유 — 러너가 서로의 서버를 끄지 않게). 끝에 남은 공통 실패는 `smoke-tutorial` 85/86 하나(equipGun 스포트라이트 — 고정 가방 틀이 1280×760 창 밖으로 나감)였고 리드가 CSS 로 고쳤다(측정 스크립트 `scripts/logs/measure-inv.mjs`, 1280×760 · 1366×768 · 1920×1080 × Tab/제작 창).
  - 리드 **`npm run verify:all`** (계약이 `src/shared` 를 열었으므로) → **1 red, 8분 52초**: `smoke-inventory-p6` 150/151 — `the bag box is always 12 rows tall` 이 `h 660 / want 670`. 창 열기 전이(`.inv-layout` scale 0.985)의 한가운데를 `getBoundingClientRect` 로 잰 타이밍 문제였다(단독 재실행 151/151). 검사를 `offsetHeight` 로 바꿨다. 나머지는 전부 green (`smoke-tutorial 86/86` · `e2e-mp 158/158` 포함).
  - `docs line: 2026-09-12: typecheck ok, typecheck-server ok, net-selftest 480/480, data-check ok, build 3,049.43 kB JS / 302.96 kB CSS, smoke-quickslots 101/101, smoke-phase2 57/57, smoke-weapons 136/136, smoke-phase3 33/33, smoke-stratagems 75/75, smoke-ship-rooms 72/72, smoke-phase4 60/60, smoke-tactical 91/91, smoke-inventory-p6 150/151 → 151/151, smoke-controls-hub 153/153, smoke-loadout 69/69, smoke-housing 293/293, smoke-console 63/63, smoke-search 77/77, smoke-progression 123/123, smoke-ui-p6 89/89, smoke-ui-p5 142/142, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-meta 197/197, smoke-training 114/114, smoke-ladder 38/38, smoke-library 128/128, smoke-stations 58/58, smoke-ghost 86/86, smoke-enemy-delta 66/66, smoke-planets 86/86, smoke-ecology 109/109, smoke-props-collision 53/53, smoke-social 209/209, smoke-structure-reach 130/130, smoke-raidflow 84/84, smoke-hazard 47/47, smoke-server-dist 36/36, smoke-structures 144/144, smoke-tutorial 86/86, smoke-named 39/39, smoke-tram-ride 26/26, smoke-pitch 162/162, smoke-lights 30/30, smoke-netlink 48/48, smoke-trust 66/66, smoke-hangar 58/58, smoke-desktop 54/54, e2e-mp 158/158`
- 2026-09-11 (23차) 주방 · 배양조 · 3D 프린터 (A-3c · A-14 · A-15) (`src/shared/{types,housing,progression,labels,events,constants,net}.ts` **추가만** · `data/meals.csv` 신규 + `data/{items,samples,furniture,furniture_upgrades,recipes,constants,tuning,loot_corpses,loot_item_weights}.csv` · `src/{housing,hub,items,pickups,inventory,progression,net,ui}` · 신규 `src/housing/{parts/Culture.ts,parts/Dining.ts,ui/CultureTank.ts,ui/DiningTable.ts}` · `src/inventory/parts/Pouch.ts` · `src/net/parts/Meal.ts` · `src/ui/hud/{MealBadge.ts,mealText.ts}` · 스모크 4종 기댓값, **에이전트 6개 병렬 + 리드**):

  ① `npm run verify` → **3 red, 9분 30초**. 둘은 **스모크의 오래된 기댓값**, 하나는 **진짜 회귀**, 하나는 플레이크:
  - `smoke-housing 265/266` — 가구 목록 카나리아. 온실에 배양조가 늘어 9 → 10 이고 새로 열린 주방이 10(조리대 + 식탁 + 8 any)이다 → 두 값을 새 사실로 (주방 줄을 **추가**해 다음에도 카나리아가 울게 했다).
  - `smoke-loadout`(그리고 `smoke-search` · `smoke-inventory-p6` 의 같은 단언) — `LOADOUT_SAVE_VERSION` 을 2 로 박아 둔 자리 10곳. v3(`pouch`)이 됐고, 크루 카드의 장비 칸도 4 → **5** 다 → 전부 새 값으로. ⚠ `scav.s1.stash` 의 `v: 2` 는 **창고 세이브라 별개**다 — 같이 올리지 않는다.
  - `smoke-quickslots 93/94` — **진짜 회귀**. 「보통 상자는 모양이 그대로다」(C-60)가 깨졌다: `.inv-cont-scroll` 의 `is-scroll`(스크롤바 자리 8 px)이 **앞 컨테이너에서 남아** 상자가 격자보다 8 px 넓었다(`overflow:false · gutter:true`). 원인은 `syncContainerScroll()` 을 **`ResizeObserver` 하나만** 몰고 있던 것 — 행이 늘어난 시체 창을 닫고 **같은 프레임에** 평범한 상자를 열면 콜백이 들어갈 틈이 없다. 이 배치가 `refresh()` 에 일감을 더하면서 간헐적이던 것이 **결정적**으로 바뀌어 드러났다(고치기 전 3회 중 1회 red 였다). 고친 방법: 컨테이너를 (재)구축하는 두 자리(`show()` · `refresh()` 의 컨테이너 교체 가지)에서 `syncContainerScroll()` 을 **직접** 부른다 — `scrollHeight` 읽기가 레이아웃을 동기로 밀어 준다. 옵저버는 창이 서 있는 동안의 변화만 맡는다(지우지 않았다).
  - `smoke-hazard 45/47` — 독성 포자 2차 분출을 세는 두 줄. 재실행에서 **47/47** — `__seek` 이 분출 경계에 정확히 떨어질 때의 플레이크다.

  ② `npm run verify:all`(`src/shared` 를 건드렸으므로) → **1 red, 12분 44초**. `smoke-rogue-v2 43/52` 는 로그가 90 초 동안 **한 발도 안 쏜** 연쇄 실패이고, `--rerun-failed` 에서 **52/52** — 교전 개시 타이밍 플레이크다.
  `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 480/480, data-check ok, build 3,004.01 kB JS / 298.88 kB CSS, smoke-quickslots 94/94, smoke-phase2 57/57, smoke-weapons 136/136, smoke-phase3 33/33, smoke-stratagems 75/75, smoke-ship-rooms 72/72, smoke-phase4 60/60, smoke-tactical 91/91, smoke-inventory-p6 144/144, smoke-controls-hub 153/153, smoke-search 77/77, smoke-console 63/63, smoke-housing 266/266, smoke-progression 123/123, smoke-loadout 69/69, smoke-ui-p5 142/142, smoke-uniques 72/72, smoke-ui-p6 89/89, smoke-resume-gate 62/62, smoke-rogue-drop 30/30, smoke-enemy-alert 42/42, smoke-meta 188/188, smoke-training 114/114, smoke-ladder 38/38, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 66/66, smoke-planets 86/86, smoke-ecology 109/109, smoke-rogue-v2 52/52 (재실행), smoke-social 209/209, smoke-props-collision 53/53, smoke-hazard 47/47, smoke-server-dist 36/36, smoke-tutorial 86/86, smoke-raidflow 84/84, smoke-structures 144/144, smoke-named 39/39, smoke-pitch 162/162, smoke-tram-ride 26/26, smoke-lights 30/30, smoke-netlink 48/48, smoke-trust 66/66, smoke-hangar 58/58, smoke-desktop 54/54, e2e-mp 158/158`

  ⚠ **브라우저에서 손으로 해 본 것은 아니다.** 새 화면 · 흐름 다섯(조리대에서 요리 제작, 식탁에서 먹기 → 출격 → 식사 배지와 파생 수치 상승, **공유 함선 식탁의 「분대에 차리기」 = 유일한 멀티 경로**, 배양조에 배지 붓기 → 세포주 → 수확, 주머니 장착 → 퀵슬롯 아래 격자 → 사망 시 시체행)에는 **전용 스모크가 없다** — 기존 단언이 회귀만 지켜 준다. 특히 `meal serve` 는 `e2e-mp` 가 지나가지 않으므로 **와이어가 한 번도 실제로 흐른 적이 없다.** 다음에 이 부근을 건드리면 그 다섯부터 스모크를 쓰는 편이 낫다.

- 2026-09-11 (22차) 연구실 — 분석기 · 추출기 · 조합대 · 준비물 (A-11 · A-12 · A-13 + B-13) (`src/shared/{types,housing,constants,labels,planetDefs,progression,events}.ts` **추가만** · `data/samples.csv` 신규 + `data/{items,seeds,planets,furniture,furniture_upgrades,recipes,quests,constants,tuning,loot_*}.csv` · `src/{housing,hub,ui,items,world,progression,player,inventory,game,pickups}` · 신규 `src/housing/{parts/Lab.ts,ui/Analyzer.ts,ui/SampleDex.ts}` · `src/world/{flora,specimen}.ts` · `src/ui/hud/EnvBadge.ts` · 스모크 4종 기댓값, **에이전트 6개 병렬 + 리드**): `npm run verify`(변경 폴더 전체 → 스모크 46종 + e2e) → **4 red, 9분 42초**. 넷 다 **스모크의 오래된 기댓값**이었고 코드 쪽 수정은 없었다:
  - `smoke-housing 264/266` · `smoke-library 124/126` — `ShipState` 버전을 4 로 못 박은 단언. `SHIP_STATE_VERSION` 이 5(`analyses` · `sampleDex`)가 됐다 → 두 파일의 상수 · 문구를 5 로.
  - `smoke-inventory-p6 143/144` — 제작 패널 탭을 7개로 못 박은 단언. 추출기 · 조합대가 더해져 9개다(로그가 찍은 실제 탭 목록은 정확했다) → 9 + `extract`/`mixer` 존재 단언으로.
  - `smoke-ecology 105/109` — 행성별 허용 토양을 `planets.csv` 에서 베껴 둔 표. 품종 확장으로 `soil_saline`(아켈론 · 피로스 · 카민) · `soil_spore`(베르단트)가 늘었다 → 표를 새 값으로. (⚠ 이 스모크는 `planets.csv` 를 **복사**해 갖고 있다 — `soils` 열을 고치면 여기도 같이 고친다.)

  `node scripts/verify.mjs --rerun-failed` → **all passed**, 1분 18초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 480/480, data-check ok, smoke-housing 266/266, smoke-library 126/126, smoke-ecology 109/109, smoke-inventory-p6 144/144` (첫 실행의 나머지: smoke-quickslots 94/94, smoke-phase2 57/57, smoke-weapons 136/136, smoke-phase3 33/33, smoke-stratagems 75/75, smoke-ship-rooms 72/72, smoke-phase4 60/60, smoke-tactical 91/91, smoke-controls-hub 153/153, smoke-search 77/77, smoke-console 63/63, smoke-loadout 69/69, smoke-progression 123/123, smoke-ui-p6 89/89, smoke-ui-p5 142/142, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-drop 30/30, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-training 114/114, smoke-meta 188/188, smoke-ladder 38/38, smoke-ghost 86/86, smoke-enemy-delta 66/66, smoke-planets 86/86, smoke-props-collision 53/53, smoke-social 209/209, smoke-hazard 47/47, smoke-server-dist 36/36, smoke-tutorial 86/86, smoke-structures 144/144, smoke-named 39/39, smoke-pitch 162/162, smoke-raidflow 84/84, smoke-tram-ride 26/26, smoke-lights 30/30, smoke-netlink 48/48, smoke-trust 66/66, smoke-hangar 58/58, smoke-desktop 54/54, e2e-mp 158/158).

  ⚠ **브라우저에서 손으로 해 본 것은 아니다.** 새 화면 · 흐름 넷(분석 화면의 표본 드래그 → 해석 → 회수 → 도감, 시설 관리 클릭 인스펙터의 실제 강화, 준비물 우클릭 사용 → 출격 → 환경 배지, 고온 · 유독 행성에서의 체력 감소)은 **전용 스모크가 없다** — `smoke-housing` · `smoke-ui-p6` 의 기존 단언이 회귀만 지켜 준다. 다음에 이 부근을 건드리면 그 넷의 스모크부터 쓰는 편이 낫다.

- 2026-09-11 (21차) 온실 개편 — 재배 스테이션 · 토양 (`src/shared/{housing,types,labels,constants}.ts` 추가만 · `data/{items,seeds,furniture,furniture_upgrades,constants,tuning,tables,planets,recipes,quests,loot_*}.csv` · `src/{housing,hub,items,pickups,world,ui}` · 신규 `src/housing/ui/GrowStation.ts` · `src/world/soil.ts` · 스모크 2종, **에이전트 6개 병렬 + 리드**): `npm run verify`(변경 폴더 housing · hub · items · pickups · world · ui · game · meta · inventory · server → 스모크 38종 + e2e) → **3 red, 8분 17초**. 셋 다 정리됐다(`--only smoke-housing,smoke-library,smoke-rogue-drop` → **all passed**, 1분 24초):
  - `smoke-housing 264/266` · `smoke-library 124/126` 의 red 3건은 **스모크가 `SHIP_STATE_VERSION` 을 3 으로 박아 두었기 때문**이다 (이번에 4 로 올렸다 — `ShipState.grows`). 책 · 도감 자체는 전부 살아남았다(`each book kept its slot` · `도감 survives a reload` 는 같은 실행에서 green). 두 스모크가 그 숫자를 상수로 올려 두도록 고쳤다.
  - `smoke-housing` 의 `removeRoomFacility on a 빈 방 refuses with a reason` 는 **단언이 방 번호를 0 으로 박아 둔 탓**이다 — 이번에 끼워 넣은 세이브 마이그레이션 절이 reload 를 한 번 더 하면서 방 배치가 밀렸다. 「빈 방을 **찾아서**」 부르도록 유도형으로 바꿨다 (16차의 `f-8` uid 와 같은 종류의 부채).
  - `smoke-rogue-drop 29/30`(`전원이 진격 상태로 내린다 1/2`)은 **플레이키**다 — `enemies/` 는 이번에 한 줄도 안 바뀌었고 재실행 **30/30**.
  - `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 480/480, data-check ok, smoke-quickslots 94/94, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-tactical 91/91, smoke-phase4 60/60, smoke-inventory-p6 144/144, smoke-controls-hub 153/153, smoke-console 63/63, smoke-search 77/77, smoke-housing 266/266 (재실행), smoke-loadout 69/69, smoke-ui-p6 89/89, smoke-ui-p5 142/142, smoke-resume-gate 62/62, smoke-rogue-drop 30/30 (재실행), smoke-meta 188/188, smoke-uniques 72/72, smoke-training 114/114, smoke-library 126/126 (재실행), smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 109/109, smoke-social 209/209, smoke-props-collision 53/53, smoke-tutorial 86/86, smoke-hazard 47/47, smoke-server-dist 36/36, smoke-structures 144/144, smoke-tram-ride 26/26, smoke-raidflow 84/84, smoke-lights 30/30, smoke-netlink 48/48, smoke-trust 66/66, smoke-hangar 58/58, e2e-mp 158/158`
  - 새 단언: `smoke-housing` 210 → **266** (재배 스테이션 — 잠긴 층 · 토양 없이 심기 거부 · 궁합 `readyAt` 비가 `(1−SOIL_MATCH_SPEEDUP)/(1+SOIL_MISMATCH_PENALTY)` 와 같다 · 수확마다 `soilUsesLeft` −1 · 고갈하면 칸이 빈다 · Lv.2/Lv.3 이 층을 열되 **층 번호는 안 밀린다** · v3 세이브의 옛 재배층이 사라지고 재료가 창고로 · 토양 · 씨앗 툴팁 줄), `smoke-ecology` 95 → **109** (토양 더미 개수 · 허용 태그 · `soilSig` 결정성 · 약초 수와의 분리).
  - ⚠ **브라우저에서 손으로 해 본 것은 아니다**: 새 재배 화면의 드래그&드롭(창고 → 흙 원 → 씨앗)과 재배 스테이션 3D 모델의 층 개방은 스모크가 시스템 API 로만 확인했다. `verify:all`(build · 전체 스모크)은 `src/shared` 를 열었으므로 머지 전에 한 번 더 필요하다.
- 2026-09-11 (20차) E-8 · E-9 · B-11 · B-12 (`src/shared/{net,events,constants,credits,meta}.ts` · `data/constants.csv` · `src/enemies` · `src/stratagems` · `server` · `src/ui`+`src/hub` · `src/meta` · 스모크 4종, 에이전트 6개 + 리드): **`npm run verify:all`** (계약이 `src/shared` 를 열었으므로) → **3 red, 10분 47초**. 셋 다 재실행으로 정리됐다(`--only smoke-meta,smoke-rogue-v2,smoke-ship-rooms` → **all passed**, 1분 37초):
  - `smoke-meta 186/188` 은 **새 단언 자신의 버그**였다(제품 버그 아님). `tryAddItem` 이 가방에 이미 있는 같은 아이템 스택을 먼저 채우므로 새 인스턴스에는 **나머지만** 남는데(경량탄은 기본 로드아웃에 있다 — 80발을 넣어도 2발만 남았다), `sellPriceOf(uid, q)` 는 `min(inst.qty, q)` 로 자르는 반면 기대값은 넣으려던 80 으로 세고 있었다. 기대값을 **실제로 남은 수량**으로 세도록 고쳐 **188/188**. 판매 `floor` 자체는 `ammo_heavy`(37) · `ammo_medium`(50)에서 처음부터 맞았다.
  - `smoke-rogue-v2 35/52` · `smoke-ship-rooms 69/72` 는 **부하 중 플레이키**로 둘 다 코드 변경과 무관하다 — 전자는 `player placed 14 m from the rogue with LOS {placed:false}`(절차 지형에서 사선 있는 자리를 못 찾았다)가 뒤 12건을 연쇄로 죽였고, 후자는 16차에도 같은 자리에서 났던 R 키 탭 씹힘이다. 재실행 **52/52 · 72/72**.
  - `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 480/480, data-check ok, build 2,869.01 kB JS / 282.22 kB CSS, smoke-quickslots 94/94, smoke-phase2 57/57, smoke-weapons 136/136, smoke-phase3 33/33, smoke-stratagems 75/75, smoke-ship-rooms 72/72 (재실행), smoke-tactical 91/91, smoke-phase4 60/60, smoke-inventory-p6 144/144, smoke-controls-hub 153/153, smoke-console 63/63, smoke-search 77/77, smoke-housing 210/210, smoke-loadout 69/69, smoke-ui-p6 89/89, smoke-progression 123/123, smoke-ui-p5 142/142, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-uniques 72/72, smoke-resume-gate 62/62, smoke-meta 188/188 (재실행), smoke-training 114/114, smoke-ladder 38/38, smoke-ghost 86/86, smoke-library 126/126, smoke-enemy-delta 66/66, smoke-planets 86/86, smoke-ecology 95/95, smoke-rogue-v2 52/52 (재실행), smoke-social 209/209, smoke-props-collision 53/53, smoke-hazard 47/47, smoke-server-dist 36/36, smoke-raidflow 84/84, smoke-tutorial 86/86, smoke-structures 144/144, smoke-named 39/39, smoke-pitch 162/162, smoke-tram-ride 26/26, smoke-lights 30/30, smoke-netlink 48/48, smoke-trust 66/66, smoke-hangar 58/58, smoke-desktop 54/54, e2e-mp 158/158`
  - 새 단언: `smoke-trust` 41 → **66** (E-8 의 세 갈래 25건 — explode 모양 · 거리 · 요율 · **정당한 폭발은 통과한다**, `st` 비트 마스크 · 사거리 · 요율 · **가까운 상태이상은 통과한다**, 거절 → `deny` → 쿨타임 전액 환불 · 위조 `callId` 무응답 · 남의 `deny` 무시), `smoke-social` 198 → **209** (차단한 분대원 말풍선 · 합류 토스트 한 줄), `smoke-meta` 176 → **188** (판매 `floor` · 0 C 판매), `net-selftest` 473 → **480** (B-11 로비 참가 차단 7건).
  - ⚠ **브라우저에서 손으로 겪어 본 것은 아니다**: E-8 의 세 가드는 전부 `smoke-trust` 의 2클라이언트 위조 요청으로만 확인했고, `explodeSender`(스냅샷이 아예 없는 보낸 사람)에는 단언이 없다 — 살아 있는 2인 로비로는 만들 수 없는 상태다. B-11 의 로비 참가 차단은 릴레이 셀프테스트로만(브라우저 UI 경로 미확인).
- 2026-09-11 (19차) C-67 · C-69 · C-70 · C-72 (`src/ui/menus/SettingsMenu.ts` · `src/enemies/{RayTests,EnemySystem}.ts` · `src/net/ProfileSync.ts` · `src/game/{GameFlowSystem.ts,parts/Death.ts,parts/Session.ts}` · `scripts/smoke-search.mjs`, 에이전트 2개(net · game) + 리드): `npm run verify`(변경 폴더 enemies · game · net · ui → 스모크 30종 + e2e) → 1 red, 8분 53초. `smoke-phase3 18/20` 은 **플레이키** — 트라이포드 표적(플레이어 앞 30 m) 12 m 안에 절차 생성 소품의 파괴 가능 오브젝트가 하나 더 들어와 `destructible === 5` 가 6 이 됐고 그 뒤 단언이 연쇄로 죽었다(stratagems · world 무변경). `--only smoke-phase3,smoke-search` 재실행 → **33/33**, 1분 35초. `smoke-search` 는 인벤토리 폴더 매핑이라 `--changed` 가 고르지 않으므로 같은 실행에 끼워 돌렸다(C-69 새 단언 2건 포함 **77/77**). `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 473/473, data-check ok, smoke-quickslots 94/94, smoke-phase3 33/33 (재실행), smoke-phase2 57/57, smoke-phase4 60/60, smoke-tactical 91/91, smoke-ui-p6 89/89, smoke-uniques 72/72, smoke-ui-p5 142/142, smoke-controls-hub 153/153, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-meta 176/176, smoke-rogue-drop 30/30, smoke-enemy-alert 42/42, smoke-training 114/114, smoke-ladder 38/38, smoke-enemy-delta 66/66, smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 95/95, smoke-server-dist 36/36, smoke-social 198/198, smoke-tutorial 86/86, smoke-named 39/39, smoke-tram-ride 26/26, smoke-lights 30/30, smoke-raidflow 84/84, smoke-trust 41/41, smoke-netlink 48/48, smoke-hangar 58/58, smoke-search 77/77, e2e-mp 158/158`. ⚠ **브라우저에서 실제로 겪어 본 것은 아니다**: C-69 의 전환(옛 프로필 문서 + rev 를 본 적 없는 클라이언트)은 `smoke-search` 의 스텁 릴레이 record 로만, C-70 의 사망 직후 새로고침 복귀는 `smoke-raidflow` 의 기존 단언(사망 · 시체 · 솔로 세션)으로만 확인됐다.
- 2026-09-11 (18차) C-68 · C-71 (`server/selftest.ts` part 7 의 대기 방식 · `scripts/{e2e-multiplayer,shots-uiux,shots-pitch}.mjs` 에 `quietViteHmr`): `node scripts/verify.mjs --only e2e-mp` → 전부 green, 1분 38초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 473/473, data-check ok, e2e-mp 158/158`. `shots-*` 는 수동 도구라 `node --check` 만.
- 2026-09-11 (16차) 소셜 · 신뢰 경로 · 연결 배치 (`src/shared/**` 추가만 + 신규 `credits.ts` · `buffRules.ts` · `server/**`(신규 `Invites.ts` · `Economy.ts` · `economy.gen.json`) · `src/{net,ui,hub,game,inventory,meta,stratagems,weapons,implants,gadgets,enemies,world,console}` · `electron/main.ts` · `scripts/**`(신규 `smoke-trust` · `smoke-netlink` · `smoke-desktop` · `economy-table`), **에이전트 7개 병렬 + 같은 트리에서 다른 세션의 C-58 · C-62 · C-63 · C-66 에이전트**). ① **기준선**(계약 커밋 `9bd72ce` 직후): `npm run verify:all` → **전부 green**, 8분 14초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 349/349, data-check ok, build 2,803.78 kB JS / 276.93 kB CSS, smoke-quickslots 84/84, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-phase4 60/60, smoke-tactical 91/91, smoke-controls-hub 147/147, smoke-inventory-p6 144/144, smoke-housing 210/210, smoke-console 63/63, smoke-search 61/61, smoke-loadout 69/69, smoke-ui-p6 89/89, smoke-progression 123/123, smoke-ui-p5 142/142, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-uniques 72/72, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-meta 176/176, smoke-training 114/114, smoke-ladder 38/38, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 65/65, smoke-ecology 95/95, smoke-planets 86/86, smoke-social 138/138, smoke-props-collision 53/53, smoke-raidflow 74/74, smoke-server-dist 33/33, smoke-hazard 47/47, smoke-tutorial 86/86, smoke-structures 144/144, smoke-pitch 162/162, smoke-named 32/32, smoke-tram-ride 19/19, smoke-lights 21/21, smoke-hangar 58/58, e2e-mp 158/158`. ② **병렬 중** red 는 전부 가려졌다: HMR 새로고침(`Execution context was destroyed`), 작업 중인 남의 새 단언, `net-selftest` part 7 `debounced write happened once` 472/473(부하 중 fsync 타이밍 — TODO C-68). 서버 동작은 공용 릴레이(계약 시점 코드) 대신 selftest 와 에이전트별 포트의 새 릴레이로 봤다. ③ **통합 후**(공용 릴레이를 내리고 러너가 새 코드 + `SCAV_DEV_ECONOMY=1` 로 띄움): `npm run verify:all` → 1 red, 9분 51초. `smoke-ship-rooms 69/72` — 부하 중 R 키 탭 하나가 씹혀 작업대가 다른 회전으로 놓였다(놓인 칸 (3,4), 평소 (2,6)) → `--rerun-failed` **72/72**. 함선 스모크 4종을 병렬로 두 번 더 돌린 스트레스 실행에서 한 번 더 같은 증상 + `smoke-controls-hub` HMR 새로고침(다른 세션 저장) — 입력 타이밍 플레이키로 판단, 코드 무변경. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 473/473, data-check ok, build 2,853.97 kB JS / 281.57 kB CSS, smoke-quickslots 84/84, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-ship-rooms 72/72 (재실행), smoke-tactical 91/91, smoke-phase4 60/60, smoke-inventory-p6 144/144, smoke-controls-hub 153/153, smoke-console 63/63, smoke-search 75/75, smoke-housing 210/210, smoke-loadout 69/69, smoke-ui-p6 89/89, smoke-progression 123/123, smoke-ui-p5 142/142, smoke-rogue-drop 30/30, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-meta 176/176, smoke-training 114/114, smoke-ladder 38/38, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 66/66, smoke-planets 86/86, smoke-ecology 95/95, smoke-props-collision 53/53, smoke-social 198/198, smoke-tutorial 86/86, smoke-hazard 47/47, smoke-structures 144/144, smoke-server-dist 36/36, smoke-named 32/32, smoke-raidflow 81/81, smoke-pitch 162/162, smoke-tram-ride 19/19, smoke-lights 21/21, smoke-trust 41/41, smoke-netlink 48/48, smoke-hangar 58/58, smoke-desktop 54/54, e2e-mp 158/158`. 그 밖: ⑦ 새 서버로 실제 거래 흐름 15건 무거절(스크래치), ⑥ 임시 배포 폴더 `--release-dir` 61/61, ③ 새 릴레이(8880)로 오프라인 진행 보존 · 서버 우선 충돌 · setMany ack 을 실제 브라우저로. ⚠ **수동 확인이 남았다**: `npm run app:dist && node scripts/smoke-desktop.mjs --release`(TODO E-10), 소셜 기능(초대 수락 이동 · 차단 · 귓속말 ack)을 **두 브라우저 + 새 릴레이로 관통한 자동 테스트는 없다** — 서버는 selftest, 클라이언트는 주입한 서버 프레임으로만 검증됐다.
- 2026-09-11 (15차) B-2 프로필 GC (`server/{Store,RelayServer,tool,selftest}.ts` · `src/shared/{profile,social}.ts` 추가만 · `scripts/smoke-server-dist.mjs` 1줄): `npm run verify:all` → 1 red, 8분 10초. `smoke-phase3 27/28`(`timeout waiting for laser ended` — 13차에 기록된 알려진 플레이키, stratagems 무변경)을 `--rerun-failed` → **33/33**, 1분 6초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 349/349, data-check ok, build 2,801.46 kB JS / 276.93 kB CSS, smoke-quickslots 84/84, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase4 60/60, smoke-tactical 91/91, smoke-phase3 33/33 (재실행), smoke-controls-hub 147/147, smoke-ship-rooms 72/72, smoke-inventory-p6 144/144, smoke-housing 210/210, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61, smoke-loadout 69/69, smoke-ui-p6 89/89, smoke-ui-p5 142/142, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-drop 30/30, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-meta 176/176, smoke-training 114/114, smoke-ladder 38/38, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 65/65, smoke-ecology 95/95, smoke-social 138/138, smoke-planets 86/86, smoke-props-collision 53/53, smoke-hazard 47/47, smoke-server-dist 33/33, smoke-raidflow 74/74, smoke-tutorial 86/86, smoke-structures 144/144, smoke-named 32/32, smoke-pitch 162/162, smoke-tram-ride 19/19, smoke-lights 21/21, smoke-hangar 58/58, e2e-mp 158/158`.
- 2026-09-11 (14차) C 항목 배치 — 계약 · 구조 부채 52건 + 새 버그 10건 (`src/shared/**` 추가 · `KEY_*` 삭제, 기능 폴더 거의 전부 · `server/**` · `electron/**` · `scripts/**` · `data/*.csv`, **에이전트 7개가 같은 트리에서 병렬** — 러너에 `--log-dir` 을 넣어 로그를 갈랐다). ① **기준선**(계약 커밋 `36e15e3` 직후, 에이전트 출발 전): `npm run verify:all` → **전부 green**, 9분 39초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,763.99 kB JS / 275.41 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 139/139, smoke-inventory-p6 144/144, smoke-housing 206/206, smoke-console 63/63, smoke-loadout 69/69, smoke-search 61/61, smoke-progression 123/123, smoke-ui-p6 89/89, smoke-ui-p5 136/136, smoke-enemy-alert 42/42, smoke-rogue-v2 52/52, smoke-uniques 72/72, smoke-resume-gate 62/62, smoke-meta 172/172, smoke-training 112/112, smoke-rogue-drop 30/30, smoke-library 126/126, smoke-ladder 38/38, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-ecology 90/90, smoke-planets 86/86, smoke-social 138/138, smoke-props-collision 35/35, smoke-raidflow 59/59, smoke-server-dist ok, smoke-hazard 43/43, smoke-tutorial 86/86, smoke-pitch ok, smoke-structures 115/115, smoke-lights 12/12, smoke-hangar 58/58, e2e-mp 156/156`. ② **병렬 중** 에이전트들의 `--only` 실행에서 난 red 는 셋 다 가려졌다: (a) 한 에이전트가 없는 `verify.mjs --help` 로 전체 검증을 돌려 공용 릴레이가 재시작됨(리드가 중단 → 러너가 모르는 옵션을 거절하게 고침), (b) vite HMR 소켓을 막지 않는 스모크가 남의 저장으로 새로고침돼 `Execution context was destroyed` · `timeout waiting for boot`(재실행 green → TODO C-65), (c) **smoke-training 110/114 가 진짜 버그** — 함선 편집 저장 debounce 안에 늦게 온 welcome 이 가구를 지웠다(`housing/HousingSystem.onProfileLoaded` 수정, smoke-ship-rooms 는 스크립트 시드 경쟁이라 시드 전 `net:profileLoaded` 대기). ③ **통합 후** `npm run verify:all` → **전부 green 한 번에**, 12분 57초 (새 스모크 `smoke-named` · `smoke-tram-ride` 등록 후, 릴레이는 러너가 임시 프로필 폴더로 띄움). `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 331/331, data-check ok, build 2,801.42 kB JS / 276.93 kB CSS, smoke-quickslots 84/84, smoke-phase2 57/57, smoke-weapons 136/136, smoke-phase3 33/33, smoke-stratagems 75/75, smoke-ship-rooms 72/72, smoke-tactical 91/91, smoke-inventory-p6 144/144, smoke-controls-hub 147/147, smoke-phase4 60/60, smoke-console 63/63, smoke-housing 210/210, smoke-progression 123/123, smoke-search 61/61, smoke-ui-p5 142/142, smoke-ui-p6 89/89, smoke-loadout 69/69, smoke-rogue-drop 30/30, smoke-enemy-alert 42/42, smoke-resume-gate 62/62, smoke-uniques 72/72, smoke-rogue-v2 52/52, smoke-meta 176/176, smoke-training 114/114, smoke-ladder 38/38, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 65/65, smoke-ecology 95/95, smoke-social 138/138, smoke-planets 86/86, smoke-props-collision 53/53, smoke-raidflow 71/71, smoke-server-dist 32/32, smoke-hazard 47/47, smoke-tutorial 86/86, smoke-structures 144/144, smoke-pitch 162/162, smoke-named 32/32, smoke-tram-ride 19/19, smoke-lights 21/21, smoke-hangar 58/58, e2e-mp 158/158`. ④ **마무리 중 추가 결정**(솔로 사망 임플란트 완전 손실, `game/parts/Death` + smoke-raidflow 3 단언) 뒤 `node scripts/verify.mjs --only`(game 매핑에서 e2e 제외) → 전부 green, 2분 26초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 331/331, data-check ok, smoke-resume-gate 62/62, smoke-ui-p5 142/142, smoke-phase2 57/57, smoke-meta 176/176, smoke-training 114/114, smoke-raidflow 74/74, smoke-planets 86/86, smoke-ghost 86/86, smoke-lights 21/21`. 그 밖: C-40 월드 생성 행성 8개 × 3회 평균 **319 → 230 ms**(CPU 공유 중이라 오차 큼), 생성 서명(장애물 · 지형 버텍스 · 소품 인스턴스 · 상자 · 채집물) 8개 전부 동일. C-35 상위재 상자 재료 픽 비율 T1–5 **3.31 · 14.26 · 39.05 · 48.53 · 90.91 % → 0 · 0 · 4.99 · 10.01 · 14.97 %**(행성 배수 전). ⚠ **수동 확인이 남았다**: `npm run app:build && npm run app`(C-28 임베디드 릴레이 지연 시작 · 서버 설정 전환 · 게임 먼저 켜고 서버 exe 나중), `npm run app:dist` 1회(C-30 — `pack-release` 의 보안 디렉터리 0 줄 · postject 경고 없음; 임시 폴더 `build-server --out` 으로는 확인), smoke-server-dist 의 Node 22.17 재현(이 PC 는 v24.12 — D: PC).
- 2026-09-11 (13차) 설치 미리보기 · 원격 지뢰 · 지상/공중 드론 · 네임드 로그 3종 (`src/shared/**` 추가만 · `src/gadgets/**`(신규 `drones/`) · `src/enemies/**`(신규 `ai/named/` · `models/named/` · `named/` · `fx/ScanPulseFx`) · `src/player` · `src/weapons` · `src/implants` · `src/stratagems` · `src/items` · `src/audio` · `src/ui` · `src/main.ts` · `data/*.csv` 7개 + 신규 `loot_named.csv`, 에이전트 17개): `npm run verify:all` → 3 red, 7분 59초. `smoke-tactical 86/87` 은 **의도한 변경**(가젯 아이템 10 → 13)이라 단언을 고쳤다. `smoke-phase3 27/28`(궤도 레이저 대기 중 페이즈가 hub 로 빠짐)과 `smoke-rogue-v2 50/52`(재장전 끝 프레임의 사격이 40 ms 폴링 사이에 끼어 12 → 13 · 탄창 11)는 둘 다 이 스크립트들의 알려진 플레이키이고 코드 무변경으로 `--rerun-failed` → **87/87 · 33/33 · 52/52**, 1분 37초. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,762.47 kB JS / 275.41 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase4 49/49, smoke-tactical 87/87 (단언 수정 후 재실행), smoke-ship-rooms 72/72, smoke-phase3 33/33 (재실행), smoke-controls-hub 139/139, smoke-housing 206/206, smoke-inventory-p6 144/144, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61, smoke-ui-p6 89/89, smoke-loadout 69/69, smoke-ui-p5 136/136, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-resume-gate 62/62, smoke-rogue-v2 52/52 (재실행), smoke-meta 172/172, smoke-training 112/112, smoke-library 126/126, smoke-ladder 38/38, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-ecology 90/90, smoke-social 138/138, smoke-planets 86/86, smoke-props-collision 35/35, smoke-raidflow 59/59, smoke-server-dist ok, smoke-hazard 43/43, smoke-tutorial 86/86, smoke-pitch ok, smoke-structures 115/115, smoke-lights 12/12, smoke-hangar 58/58, e2e-mp 156/156`. ⚠ **새 기능 자체를 브라우저에서 조작해 본 스모크는 아직 없다** — 드론 조종 · 설치 미리보기 · 원격 지뢰 기폭 · 네임드 스폰/AI 는 typecheck 와 기존 스모크의 무회귀만 확인됐다.
- 2026-09-11 볼록 콜라이더 · 경사 계단 · 2층 건물 · 창문 · 사다리 · 옥상 스캐너 · 빛기둥은 시체에만 · 투척 궤적 50 % (`src/world/**` · `src/player/**` · `src/shared/**` 추가만 · `src/ui/hud/{pillar,Detection,ScanReveal}` · `src/weapons/{Grenade,fx/ThrowArc}` · `src/gadgets/ThrownGadget` · `src/enemies/{parts/Attacks,fx/RogueGrenade}` · `src/pickups/*` · `src/net/{Snapshotter,RemotePlayer}` · `src/audio/Synth` · `data/constants.csv` · `data/structures.csv` · 스모크 4개 수정 + `smoke-ladder` 신규): `npm run verify:all` → 3 red. `smoke-server-dist` · `smoke-pitch` 는 기존 환경 크래시(`net.ts` 확장자 · `F:\Project` 경로) — `node --experimental-strip-types scripts/smoke-server-dist.mjs` 로 따로 돌리면 **23/23** 이라 바뀐 `net.ts` 계약을 릴레이가 그대로 읽는다. `smoke-ui-p6 87/88` 은 **의도한 변경**(정찰 적 목표에 투시 기둥이 서던 단언 — 이제 시체에만)이라 단언을 고쳤고 `--only smoke-ui-p6` → **89/89**. `docs line: 2026-09-11: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,584.75 kB JS / 259.63 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 139/139, smoke-inventory-p6 144/144, smoke-loadout 69/69, smoke-housing 206/206, smoke-console 63/63, smoke-progression 123/123, smoke-ui-p6 89/89 (단언 수정 후 재실행), smoke-search 61/61, smoke-ui-p5 136/136, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-drop 30/30, smoke-meta 172/172, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-training 112/112, smoke-library 126/126, smoke-ladder 38/38, smoke-enemy-delta 52/52, smoke-planets 86/86, smoke-ghost 86/86, smoke-social 138/138, smoke-ecology 90/90, smoke-props-collision 35/35, smoke-raidflow 59/59, smoke-server-dist exit 1 (기존, strip-types 로 23/23), smoke-pitch exit 1 (기존), smoke-hazard 43/43, smoke-tutorial 86/86, smoke-structures 115/115, smoke-lights 12/12, smoke-hangar 58/58, e2e-mp 156/156`.
- 2026-09-10 바위 · 첨탑 콜라이더 = 땅 위 윤곽 (`src/world/Props.ts` `footprintOf` · `scripts/smoke-props-collision.mjs` 4번 검사 + 옮겨진 바위 매칭): ⚠ 작업 트리는 **다른 세션이 `src/core` · `src/shared` 를 고치는 중이라** 게임이 뜨지 않았다(`SCENE_POINT_LIGHT_BUDGET` export 없음 · typecheck 3 red 전부 그 파일들) — 그래서 **HEAD 워크트리 + 이 두 파일**로 검증했다(워크트리 typecheck 0 error). `node scripts/verify.mjs`(world 매핑) → `smoke-phase3 27/28` 하나 red(레이저 대기 중 페이즈가 hub 로 빠짐, 4레인 부하), `--rerun-failed` → **33/33**, 3분 3초 + 1분 7초. `docs line: 2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-stratagems 75/75, smoke-phase4 49/49, smoke-tactical 87/87, smoke-training 112/112, smoke-rogue-drop 30/30, smoke-phase3 33/33 (재실행), smoke-ecology 90/90, smoke-planets 86/86, smoke-props-collision 29/29, smoke-hazard 43/43, smoke-raidflow 59/59, smoke-structures 67/67, smoke-lights 4/4`. 별도 헤드리스 프로브: **바위 전수 조사**(4 행성 seed 1, 바위마다 16 방위로 내려 쏜 레이의 첫 가시 반지름 vs 콜라이더) 중앙값 0.47 → 0.09 m · p90 0.9 → 0.19 m · 0.5 m 초과 98–215 → 0; **폭풍의 눈 경계 재주행**(베르단트 III · 피로스 VII × 진행도 60/90 % × 16 방위 × 안팎, 달리기) 멈춤 6 → 3 이고 남은 셋은 54° 경사 둘 + 오르막의 1.9 m 잔해 상자 하나(보이는 장애물) — **바위 멈춤 2곳은 사라졌다**; 월드 생성 284–338 ms.
- 2026-09-10 Alt 커서 제거 (`src/game/GameFlowSystem.ts` · `parts/Phases.ts` · `ResumeGate.ts` 주석 · `src/shared/Keybinds.ts` · `constants.ts` 주석 · `scripts/smoke-controls-hub.mjs` · `smoke-resume-gate.mjs`): `npm run verify` → 3 red, 7분 31초. `smoke-server-dist` · `smoke-pitch` 는 위 항목과 같은 기존 환경 크래시(`net.ts` 확장자 · `F:\Project` 경로, 두 스크립트 모두 무변경). `smoke-inventory-p6 143/144` 는 같은 분해 홀드 게이지 표본 플레이키이고 단독 재실행 **144/144**. 바꾼 스모크는 둘 다 통과 — `smoke-controls-hub 139/139`(Alt 단언 6개 삭제 · "Alt 는 커서를 풀지 않는다" 1개 추가로 144 → 139), `smoke-resume-gate 62/62`. ⚠ 러너가 e2e 전에 8787 릴레이를 재시작하면서 **밖에서 띄워 둔 `npm run dev:all` 이 통째로 내려갔다** (`scripts/dev-all.mjs` 는 자식 하나가 끝나면 전부 끈다 — vite 5273 도 같이). `docs line: 2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 139/139, smoke-inventory-p6 144/144 (재실행), smoke-housing 206/206, smoke-loadout 69/69, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61, smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-meta 172/172, smoke-resume-gate 62/62, smoke-training 112/112, smoke-library 126/126, smoke-rogue-v2 52/52, smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-ecology 90/90, smoke-planets 86/86, smoke-social 138/138, smoke-raidflow 59/59, smoke-props-collision 20/20, smoke-server-dist exit 1 (기존), smoke-pitch exit 1 (기존), smoke-tutorial 86/86, smoke-hazard 43/43, smoke-structures 67/67, smoke-lights 4/4, smoke-hangar 58/58, e2e-mp 156/156`.
- 2026-09-10 전차 출발 알림 · 콘솔 빛기둥 · 전차 위 컨테이너 (`src/world/Rails.ts` · `Structures.ts` · `src/extraction/ExtractionSystem.ts` · `src/inventory/Container.ts` · `InventorySystem.ts` · **`src/shared/constants.ts` 추가 1줄** · `data/constants.csv` 1줄): `npm run verify:all` → 4 red, 7분 34초. 판정: **`smoke-server-dist` · `smoke-pitch` 는 변경을 stash 한 깨끗한 트리에서도 같은 크래시**(각각 `node` 가 `src/shared/net.ts` 를 못 읽음 `ERR_UNKNOWN_FILE_EXTENSION`, 스크립트에 박힌 `F:\Project\Scavanger\docs\pitch\pages` 경로 없음) — 이번 변경과 무관한 환경 문제로 남긴다. `smoke-ship-rooms 69/72` · `smoke-inventory-p6 143/144` 는 깨끗한 트리 `--rerun-failed` 에서 72/72 · 144/144, **변경된 트리 `--only` 재실행에서도 72/72 · 144/144** — 4레인 병렬 부하의 타이밍 플레이키(분해 홀드 게이지 표본이 이미 끝난 뒤에 찍힘 · 하우징 커서 픽). 그 밖에 전부 통과: `2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,539.51 kB JS / 259.63 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72 (재실행), smoke-tactical 87/87, smoke-controls-hub 144/144, smoke-inventory-p6 144/144 (재실행), smoke-loadout 69/69, smoke-housing 206/206, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61, smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-rogue-drop 30/30, smoke-meta 172/172, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-library 126/126, smoke-training 112/112, smoke-enemy-delta 52/52, smoke-planets 86/86, smoke-ghost 86/86, smoke-social 138/138, smoke-ecology 90/90, smoke-props-collision 20/20, smoke-raidflow 59/59, smoke-server-dist exit 1 (기존), smoke-pitch exit 1 (기존), smoke-tutorial 86/86, smoke-structures 67/67, smoke-hazard 43/43, smoke-lights 4/4, smoke-hangar 58/58, e2e-mp 156/156`.

  동작 확인은 일회성 헤드리스 프로브(커밋하지 않음, 시드 21): 380 m 떨어진 승강장에서 호출 → 토스트 `전차를 호출했다` 하나뿐 ·
  전차 안에서 시동 → `전차가 곧 출발합니다` · 콘솔류 11개 `hidePillar=true` · 달리는 전차 객실 컨테이너가 2초 넘게
  열린 채 유지(고치기 전 0.4초 만에 `closeAll`). 붕대 5초 홀드 8회(가속 · 곡선 · 정차 · 걸으면서)는 고치기 전에도
  전부 끝까지 갔다 — 회복 끊김은 재현하지 못했다.
- 2026-09-10 피칭 문서 23 → 31 페이지 (`docs/pitch/` · `scripts/shots-pitch.mjs` · 신규 `scripts/smoke-pitch.mjs` — **게임 코드 무변경**): `node scripts/verify.mjs --only smoke-pitch` → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, **smoke-pitch ok** — 49초. 새 스크립트가 31쪽을 전부 열어 JS 오류 0 · 사이드바 31 · `a.active` 각 1 · `.nextnav` 대상 파일 전부 실재 · 카드 넘기기(`1/5 → 2/5 → 되돌아 5/5`, ESC 닫힘, 단독 이미지에는 UI 없음)를 확인했다. `smoke-pitch` · `smoke-server-dist` 에 `standalone: true` 를 붙여 러너가 **쓰지도 않을 vite · 릴레이를 띄우지 않게** 했다(20초 절약, 로그에 `servers skipped`). 스크린샷은 `node scripts/shots-pitch.mjs` 로 20장을 새로 찍고 `npm run pitch:webp` (20.6 MB → 1.85 MB, −91 %). 촬영이 뜻대로 안 되던 셋은 [HISTORY 의 같은 날 6차 절](HISTORY.md)에 적었다.
- 2026-09-10 조명 개수 버그 나머지 (`src/player/Hellpod.ts` · `src/game/parts/Leader.ts` · `GameFlowSystem.init` · 신규 `scripts/smoke-lights.mjs`): `npm run verify` (player + game + extraction 매핑 전체) → `smoke-phase4 48/49` 하나 red, `--rerun-failed` → **49/49** (이 스크립트의 알려진 플레이키 — 6차에서 A/B 교차로 고치기 전 코드에서도 같은 빈도로 재현됨을 확인했다). 그 밖에 **전부 통과**, 7분 30초 + 1분 1초. 새 `smoke-lights 4/4`.

  **새 스모크가 그물이다.** 레이드 한 판을 돌며 `scene.traverseVisible` 로 매 프레임 광원을 세고 로드 경계
  (허브 구축 · 미션 시작)가 아닌 곳에서 숫자가 바뀌면 실패한다. 고친 코드: 변화 2회(`hub` −1→27, `mission-start`
  27→20)뿐이고 플레이 중 0회. **고치기 전 코드에 대고 같은 스크립트를 돌려 2/4 red 로 재현했다** —
  `19 → 18 [playing] rejoin restoreState (hellpod.hide)`, `18 → 19 [playing] rescue drop (hellpod.start)`.
  이것이 헬포드의 실제 트리거다: 포드는 착륙 뒤에도 소품으로 남아 보이므로 **구조선 강하만으로는 안 바뀌고**,
  재접속 복귀가 먼저 숨겨야 한다 (6차 보고에서 "구조선 강하 때마다" 라고 한 것은 과했다). 분대장 기기는
  멀티 호스트 사망이 필요해 솔로 스모크로는 재현할 수 없어 **코드로 확정**했다 (`ctx.scene.add(d.group)` /
  `dispose()` 가 광원을 든 그룹을 넣고 뺐다); 대신 광원이 `init` 때 씬에 `intensity 0` 으로 심겨 있는지를 단언한다.
  영구 비용은 광원 +2 (헬포드 스러스터 · 기기) — 레이드 표본에서 허브 25→27, 레이드 19→20.
- 2026-09-10 탈출 함선 — 열린 뒷문 · 탑승 이동 · 도착 렉 (`src/extraction` · `src/player/PlayerSystem.ts`): `npm run verify` (extraction + player 매핑 전체) → **전부 통과, 6분 59초**. `2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-tactical 87/87, smoke-controls-hub 144/144, smoke-inventory-p6 124/124, smoke-housing 206/206, smoke-console 63/63, smoke-search 61/61, smoke-loadout 69/69, smoke-progression 123/123, smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-rogue-drop 29/29, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-meta 172/172, smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-social 138/138, smoke-ecology 90/90, smoke-props-collision 20/20, smoke-structures 25/25, smoke-server-dist ok, smoke-raidflow 59/59, smoke-hazard 43/43, smoke-tutorial 83/83, smoke-hangar 58/58, e2e-mp 156/156`.

  **`smoke-raidflow` 를 49 → 59 로 늘렸다** — 이 셋이 이번 회귀 가드다: ① 뒷문 평면(함선 로컬 z 0.45, `|x|<1.4`,
  `0.15<y<2.4`)을 가로지르는 외피 메시가 없다, ② 이륙하면 탑승자가 함선과 함께 오른다(30 m 상승에서 차이
  0.6 m 미만 · 데크와의 오차 0.35 m 미만), ③ **씬의 광원 개수가 신호탄 · 함선 등장 · 이륙 뒤에 전부 같다**
  (`scene.traverseVisible` 로 센다 — 이 숫자가 바뀌면 씬의 모든 머티리얼이 셰이더를 다시 컴파일한다).
  고치기 전 같은 검사로 재현했다: 신호탄만으로 **15 → 16** 이 됐다.

  스모크 밖에서 눈과 계측으로 본 것: 착륙한 함선을 뒤에서 찍은 헤드리스 스크린샷(1280×720, 카메라 오버라이드
  7 m · 18 m)에서 **램프가 내려간 뒤 화물칸 내부(리브 · 벤치 · 천장 · 안쪽 벽)가 그대로 보인다**;
  `body` 의 로컬 바운딩 박스가 고치기 전과 **완전히 같다**(−5.3..5.3 / −2..4.9 / −10.15..3, 그림자 캐스터만
  50 → 31); 레이드 400프레임 표본에서 광원 15 → 19 로 늘어도 **p50 프레임 시간 16.7 ms 로 동일**.
  `PlayerSystem.lateUpdate` 의 새 가지가 다른 스모크에 닿지 않는다는 것은 `attachTo` 를 후킹해 확인했다 —
  일반 레이드 8초 동안 **비-null 호출 0회**(`attachedParent` 는 탈출 이륙에서만 세팅된다).
  `smoke-phase4` 는 이 작업 중 간헐적으로 red 였는데 **고치기 전 코드에서도 같은 빈도로 재현**됐다
  (A/B 교차 3회씩: with 2·3·0, base 0·0·3) — 이 스크립트의 알려진 플레이키이고 최종 실행에서는 49/49 다.
- 2026-09-10 함선 호출 썸네일 · 공유 쿨타임 · 탄약 핑 제거 (`src/ui` · `src/stratagems` · `data/stratagems.csv`): `npm run verify` (stratagems + ui 매핑 12종) → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-quickslots 73/73, smoke-phase2 57/57, **smoke-stratagems 75/75** (공유 쿨타임 60 → 90 으로 고치고 **쿨타임 중 G 홀드가 휠을 열지 않는다** 단언 3개 추가), **smoke-phase3 31/33**, smoke-controls-hub 131/131, smoke-ui-p6 88/88, smoke-resume-gate 62/62, **smoke-ui-p5 136/136** (우하단 순서 단언을 `qstrip,wbox` + `.scall` 이 열에 없다로 교체), smoke-meta 172/172, smoke-social 138/138, smoke-uniques 72/72, smoke-tutorial 83/83 — 2분 18초. red 둘은 보급 상자 루팅 구간에서 **테스트 플레이어가 적에게 죽어**(`phase: dead`, hp 0) 그 뒤가 연쇄로 넘어진 것으로, 이 스크립트의 알려진 플레이키다 (같은 날 직전 실행에서는 궤도 레이저 대기에서 타임아웃했다 — 매번 다른 지점이다). `--rerun-failed` → **smoke-phase3 33/33**, 1분 6초. `.strat-panel` → `.scall .sc-thumb` 로 바꾼 존재 검사는 첫 실행에서 이미 green 이었다. 추가로 헤드리스 스크린샷(1600×900, 하단 중앙 클립)으로 평상시 · 무장 중 · 쿨타임 중(41초 · 5.9초) 네 상태를 눈으로 확인했다 — 차오름(`--fill` 0.93)과 중앙 숫자가 임플란트와 같게 그려진다.
- 2026-09-10 레이드 HUD 손보기 3차 (무기 패널 `.wbox` · 퀵슬롯 0.6배 · 흰 구분선 = 내구도 바 — `src/ui` 만): `npm run verify` (ui 매핑 11종) → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-quickslots 73/73, smoke-ui-p6 88/88, smoke-phase2 57/57, smoke-controls-hub 131/131, smoke-ui-p5 136/136, smoke-resume-gate 62/62, smoke-meta 172/172, smoke-uniques 72/72, smoke-social 138/138, **smoke-phase3 27/28**, smoke-tutorial 83/83 — 2분 27초. red 하나는 `timeout waiting for laser ended`(궤도 레이저 지속시간 대기)로 HUD 와 무관한 플레이키였고 `--rerun-failed` 에서 **smoke-phase3 33/33**, 1분 7초. DOM 이 `.wbox` 만큼 깊어졌지만 스모크가 보는 선택자(`.weapon .wthumb` · `.weapon .mag` · `.weapon .reserve` · `.qstrip .qs-cell` · `.weapon` 의 앞 4자식 순서)는 전부 그대로 맞아 **스크립트는 한 줄도 고치지 않았다**. 추가로 헤드리스 스크린샷(1600×900, 미션 진입 후 우하단 클립)으로 총기 모드와 소모품 모드(`.wbox` display:none / `.cons` display:flex)를 눈으로 확인했다.
- 2026-09-10 플레이 피드백 11건 (홀드 키캡 · 퀵슬롯 · **보조무기 제거** · 웨이브 · 재해 · 지도 · 지하실 · 상자 배치 · 선로 · 전차 — `src/shared` 를 건드려 전체): `npm run verify:all` → 4 red (`smoke-phase2` · `smoke-weapons` · `smoke-loadout` · `smoke-tutorial`, 전부 **보조무기 제거로 기대값이 바뀐 단언**) → 스모크를 고치고 `--rerun-failed` 2회 만에 **전부 통과, 6분 34초**. 자세히는 아래 [해당 절](#2026-09-10--플레이-피드백-11건-홀드-키캡--퀵슬롯--보조무기-제거--웨이브--재해--지도--지하실--상자-배치--선로--전차).
- 2026-09-09 UI/UX 정리 7차 (캐릭터 생성 · 튜토리얼 · **퀵슬롯 컨테이너** · 함선 크로스헤어 · 포병 — 에이전트 6개 중 5개가 API 한도로 중도 종료된 뒤 리드가 인수): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,362.05 kB JS / 247.66 kB CSS, **smoke-quickslots 73/73**, **smoke-phase2 57/57**, smoke-weapons 137/137, smoke-stratagems 72/72, smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-tactical 87/87, **smoke-controls-hub 129/129**, smoke-housing 206/206, smoke-inventory-p6 124/124, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61, **smoke-loadout 69/69**, smoke-ui-p6 88/88, smoke-ui-p5 134/134, smoke-resume-gate 59/59, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-v2 52/52, smoke-meta 172/172, smoke-library 126/126, smoke-training 112/112, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-raidflow 49/49, smoke-social 138/138, smoke-ecology 85/85, smoke-props-collision 20/20, **smoke-tutorial 83/83**, smoke-hangar 58/58, e2e-mp 156/156 — **전부 통과, 6분 30초**. 자세히는 아래 [해당 절](#2026-09-09--uiux-정리-7차-퀵슬롯-컨테이너--스포트라이트-반-박자--포병).
- 2026-09-09 ESC 닫기 (`src/shared/escape.ts` 신규 — 계약이라 전체): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,343.01 kB JS / 243.14 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 72/72, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87, **smoke-controls-hub 127/127** (가방 위 ESC 는 가방을 닫고 메뉴를 열지 않는다 · Alt 커서 ESC 는 카메라만 돌려준다 — 옛 규칙 단언 4개를 새 규칙으로 바꾸고 2개 추가), smoke-inventory-p6 124/124, smoke-housing 203/203, smoke-console 63/63, smoke-loadout 62/62, smoke-progression 123/123, smoke-search 61/61, **smoke-ui-p6 88/88** (키 가이드 `닫기` 항목의 keycap 이 `Tab` · `Esc` 둘이라는 단언 1개 추가), smoke-ui-p5 134/134, **smoke-resume-gate 57/57** (§8 ESC 닫기 · LIFO · 게이트, §9 셸에서 메뉴 닫기 — 단언 9개 추가), smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-v2 52/52, smoke-meta 172/172, smoke-library 126/126, smoke-training 112/112, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 85/85, **smoke-raidflow 49/49** (ESC 는 컨테이너를 닫고, 메뉴 쌓기는 `game:paused` 로 확인), **smoke-social 120/137 → `--rerun-failed` 138/138** (커뮤니티 패널 위 ESC 가 패널을 닫으므로 그 뒤 흐름을 고쳤다 — 옛 단언 2개 교체 + 1개 추가), smoke-props-collision 20/20, smoke-tutorial 67/67, smoke-hangar 58/58, e2e-mp 156/156 — **6분 31초** (+ 재실행 41초).
  - red 였던 `smoke-social` 은 2026-09-08 규칙(`ESC 는 커뮤니티 패널 위에 일시정지 메뉴를 쌓는다`)을 그대로 단언하고 있었고, 그 뒤 흐름이 "패널이 열려 있다" 를 전제로 P 탭을 하고 있어 12건이 연쇄로 넘어졌다. 새 규칙(ESC → 패널 닫기 → 한 번 더 → 메뉴)으로 고치니 전부 green.
  - 재검증 (한 걸음만 되돌리는 닫기 함수 = `false` 반환 수정 뒤): `--only smoke-resume-gate,smoke-housing,smoke-ship-rooms,smoke-controls-hub` → **smoke-resume-gate 59/59** (두 단계 닫기 단언 2개 추가) · smoke-housing 203/203 · smoke-ship-rooms 72/72 · smoke-controls-hub 127/127, 1분 15초. 2회차 전체에서 `smoke-ship-rooms 69/72` 가 한 번 red 였으나 재실행 72/72 — 하우징 커서 셀 매핑 3건은 마우스 좌표 · 카메라 타이밍에 걸리는 이 스크립트의 flake다 (코드 변경은 주석뿐이었다).
  - 헤드리스에서 **셸 경로도 검사된다** — `window.__scavDesktop = true` 로 `isDesktopShell()` 을 켜고 ESC 로 일시정지 메뉴가 닫히는지(그리고 `game:paused {paused:false}` 가 나가는지) 본다.
- 2026-09-09 세이브 유실 · 보이지 않는 거대 콜리전 · 로그 피격 · 헤드샷 마커: `npm run verify` (병행 작업이 `src/shared` 를 건드리고 있어 전체 매핑 + e2e-mp) → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 72/72, smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 125/125, smoke-housing 203/203, smoke-inventory-p6 124/124, smoke-console 63/63, smoke-progression 123/123, smoke-loadout 62/62, smoke-search 61/61, smoke-ui-p6 87/87, smoke-ui-p5 134/134, smoke-resume-gate 48/48, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-meta 172/172, smoke-training 112/112, smoke-rogue-v2 52/52, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-ecology 85/85, smoke-raidflow 48/48, smoke-planets 86/86, smoke-social 137/137, **smoke-props-collision 20/20 (신규)**, smoke-tutorial 67/67, smoke-hangar 58/58, e2e-mp 156/156 — **all passed, 6분 26초**. `npm run typecheck:app` ok.
  네 건 모두 스모크가 아니라 **계측 스크립트**로 먼저 수치를 잡았다. 콜리전 쪽은 그대로 두면 또 조용히 재발할 종류라 상설 스모크로 남겼고(`smoke-props-collision.mjs`, `world` 폴더에 매핑), 나머지 셋은 일회용이라 지웠다:
  - **`smoke-props-collision.mjs`** (계측판은 `_tmp-diag-collision.mjs`) — 장애물 988개를 인스턴스 행렬로 그려진 지오메트리와 1:1 매칭해 정점을 전부 훑는다. `noise3` 수정 전/후 시드 21: 바위 콜라이더 최대 반지름 **18.15 → 3.87 m**, 소품 위 여유 높이 **4.64 → 0.51 m**, `shotRadius − 실측 최대 반지름` 최대 **+0.10 → −0.06**(콜라이더가 그려진 것을 넘지 않는다). 첨탑 변형 지오메트리 바운딩 박스 x `[-2.90, 1.29] → [-1.15, 0.97]`.
  - `_tmp-probe-displace.mjs` — 페이지에서 `noise.ts` / `build.ts` 를 직접 import 해 `noise3` 를 20만 번 뽑는다. 범위 **`[-31.209, +52.559]` → `[-0.905, +0.988]`**, 원뿔 정점 중 0.5 units 이상 밀린 것 **2개 → 0개**.
  - `_tmp-diag-rogue.mjs` — 로그 16명에게 3거리 × 8방향 384발. 소품에 막힌 탄 **rock 23 → 1**, wall · pole **12 → 0**. 남은 차단(nest 78 · terrain 14)은 실제로 가려진 경우다.
  그 스모크가 만들자마자 같은 계열의 잔여 결함 하나를 더 잡았다: `hullOf` 의 `y` 가 `max(|min.y|, |max.y|)` 라서, 코를 박고 누운 **탈출 포드 껍데기**(min.y ≈ −1, max.y ≈ 0.4)의 총알 실린더가 그려진 것보다 **1.34 m 높았다**. `bb.max.y` 로 바꿔 0.41 m 로 내려왔다 (가운데가 원점인 나머지 소품은 값이 같아 변화 없음, 반지름을 안 건드리므로 시드별 배치도 그대로).
  - `_tmp-app-origin.mjs` — 데스크톱 앱을 네 번 띄운다(CDP 로 렌더러에 붙어 localStorage 를 읽고 쓴다). 오리진 네 번 모두 `http://127.0.0.1:8790`, **정상 종료 뒤 유지 PASS · 강제 종료(SIGTERM) 뒤에도 유지 PASS**. 수정 전에는 실행마다 오리진이 달라 100 % 유실이었다.
- 2026-09-09 Tab→ESC 메뉴 · 튜토리얼 행성 이동 · 제작 목록 (`src/shared/Input` 포함): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,332.04 kB JS / 238.80 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 72/72, smoke-phase3 33/33, **smoke-phase4 45/49 → `--rerun-failed` 49/49** (텔레포트 · 스태미나 · 근접 · 넉백 4건은 플레이어가 죽은 채로 도는 이 스크립트의 오래된 flake — 재실행으로 green), smoke-ship-rooms 72/72, smoke-tactical 87/87, **smoke-controls-hub 125/125** (락 튕김이 메뉴를 열지 않는다는 단언 1개 추가), **smoke-inventory-p6 124/124** (가방만 꽉 차면 창고가 받는다는 단언 1개 추가 + 만실 문구를 `가방과 함선 창고에 공간이 없습니다` 로), smoke-housing 203/203, smoke-console 63/63, smoke-search 61/61, smoke-loadout 62/62, smoke-progression 123/123, smoke-ui-p6 87/87, smoke-ui-p5 134/134, smoke-resume-gate 48/48, smoke-uniques 72/72, smoke-enemy-alert 42/42, smoke-meta 172/172, smoke-rogue-v2 52/52, smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 85/85, smoke-raidflow 48/48, smoke-social 137/137, smoke-tutorial 67/67, smoke-hangar 58/58, e2e-mp 156/156 — **6분 33초**. 세 건 모두 스모크가 아니라 **일회용 재현 스크립트**로 먼저 잡았다 (락은 `pointerlockchange` 를 실제로 쏘는 충실한 스텁이 있어야 재현된다 — 기존 스모크는 그걸 통째로 스텁해 두고 있다).
- 2026-09-09 UI/UX 정리 · 제작 수량 · 튜토리얼 18단계 (`src/shared` 계약 선커밋): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 278/278, data-check ok, build 2,263.13 kB JS / 223.18 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-ship-rooms 72/72, **smoke-phase4 45/49** (지난 회차부터 red — 클린 트리에서 stash 후 재현해 이번 작업과 무관함을 확인했다: 텔레포트 · 스태미나 · 근접 · 넉백 4건), smoke-tactical 87/87, smoke-controls-hub 121/121, **smoke-housing 203/203** (Tab · M · C 로 시설 관리를 닫아도 일시정지 메뉴가 뜨지 않는다는 회귀 단언 3개 추가), **smoke-inventory-p6 123/123** (제작 수량 · 썸네일 · 창고 숨김 단언 14개 추가), smoke-console 63/63, smoke-progression 123/123, smoke-loadout 61/61, smoke-search 61/61, smoke-ui-p6 87/87, smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-enemy-alert 42/42, smoke-uniques 71/71, smoke-meta 173/173, smoke-training 112/112, smoke-library 126/126, smoke-rogue-v2 52/52, smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-raidflow 48/48, smoke-planets 86/86, smoke-ecology 85/85, **smoke-social 133/136 → 137/137** (옛 규칙 단언 3개를 새 규칙으로: 커서 아래 주차 → 왼쪽 절반 고정, 설정 좌측 레일 → 화면 중앙), **smoke-tutorial 67/67** (18단계 · openCraft · 재료 top-up · 판 타일링 · 패널 z-index · 홀드 건너뛰기 단언 10개 추가), smoke-hangar 58/58, e2e-mp 156/156 — **6분 27초**.

- 2026-09-09 대화 UI · 창문 워프 · 키 가이드 (에이전트 3개 병렬, `src/shared` 계약 선커밋): `npm run verify` (shared 를 건드려 전체 매핑 + e2e-mp) → typecheck ok, typecheck-server ok, net-selftest 278/278, data-check ok, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-controls-hub 121/121, smoke-tactical 87/87, smoke-inventory-p6 109/109, smoke-housing 200/200, smoke-console 63/63, smoke-progression 123/123, smoke-loadout 61/61, smoke-search 61/61, **smoke-ui-p6 87/87** (하우징 힌트 바 단언 5 → 키 가이드 단언 3), smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-enemy-alert 42/42, smoke-uniques 71/71, smoke-meta 173/173, smoke-rogue-v2 52/52, smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, **smoke-planets 86/86** (컷씬 단언 2 → 창문 워프 단언 2), smoke-raidflow 48/48, smoke-social 135/136 → 옛 규칙(`전송 후 입력창 닫힘`) 단언 하나를 고쳐 `--rerun-failed` **136/136**, smoke-ecology 85/85, smoke-tutorial 57/57, smoke-hangar 58/58, e2e-mp 156/156 — **6분 13초**. 에이전트별 자체 스모크(비공개 포트): ui 54/54 · 화면들 46/46 · 워프 38/38.
- 2026-09-09 수치를 csv 로 (게임 안 모든 수치 → `data/*.csv` 35개): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 278/278, **data-check ok** (새 레인), build 2,249.21 kB JS / 220.97 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 121/121, smoke-inventory-p6 109/109, smoke-housing 200/200, smoke-progression 123/123, smoke-console 63/63, smoke-loadout 61/61, smoke-search 61/61, smoke-ui-p6 89/89, smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-uniques 71/71, smoke-meta 173/173, smoke-enemy-alert 42/42, smoke-rogue-v2 52/52, smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, **smoke-planets 86/86**, smoke-raidflow 48/48, smoke-social 136/136, smoke-ecology 85/85, smoke-tutorial 57/57, smoke-hangar 58/58, e2e-mp 156/156 — **5분 52초**, smoke-phase4 하나만 red.
  - **수치 자체는 별도로 대조했다.** 옮기기 전 HEAD 를 워크트리로 떼어 모든 데이터 모듈의 export 를 JSON 으로 덤프해 두고, 표를 하나 옮길 때마다 다시 덤프해 비교했다. 최종 차이는 **의도한 신규 export 3+6건뿐**(무기 아이템 메타 맵 2개 · `WEAPON_CLASSES`, 가젯 리터럴 6개가 상수가 된 것) — 나머지 수치는 전부 이관 전과 값이 같다. 스모크가 못 보는 표(루팅 가중치 · 퀘스트 보상 등)까지 덮으므로 이 대조가 실질적인 회귀 방어선이었다.
  - **smoke-phase4 는 원래 flaky 하다** (이관과 무관). 실패 신호는 언제나 같다 — 곡사포 벌레가 두 번째 포탄을 쏘기 전에 죽어 `enemy:shellLanded` 를 못 받고, 그 뒤 토록/베헤모스/시체 블록이 줄줄이 무너진다 (45/49 또는 17/37). **HEAD 를 그대로 떼어 낸 워크트리에서 4회 돌려 3승 1패(45/49)**, 작업 트리에서 4회 돌려 3승 1패로 **같은 비율 · 같은 점수**였다. 재실행하면 49/49.
  - **smoke-planets 는 단언을 고쳤다.** 재탑승 검사가 `leavePod` 직후 곧바로 다시 타려 하는데, 같은 시기 작업 중이던 발사 슬롯 수정이 들여온 `REBOARD_GRACE`(0.5 s 시뮬레이션 시간)에 걸려 프레임 타이밍에 따라 조용히 거절된다. `waitSim(0.6)` 을 넣어 새 규칙을 지키게 했다 (86/86).
  - **`data-check` 가 빠른 레인에 추가됐다** (typecheck · net-selftest 와 나란히, 수 초). Vite 를 헤드리스로 띄워 게임이 쓰는 로더 그대로 csv 를 읽으므로 검사 규칙이 로더와 어긋날 수 없다. 브라우저에서는 잘못된 칸이 있어도 기본값으로 굴러가므로(의도) 이 레인이 유일한 그물이다.
  - **주의(내 실수 기록).** 대조용 워크트리에 프로젝트 `node_modules` 를 **junction 으로 연결**해 두고 `git worktree remove --force` 를 돌렸더니, 삭제가 junction 을 따라가 프로젝트의 `node_modules/.bin` 과 `@puppeteer` 를 지웠다. 그 상태로 돌던 verify:all 에서 스모크 10개가 `ERR_MODULE_NOT_FOUND` 로 죽었다 (`npm install` 로 복구). 워크트리에는 junction 대신 자기 `npm install` 을 준다.
- 2026-09-08 UI/UX 정리 2차 13건 (무기 교체 링 · 상자 빛기둥 · 저격 탄도 · 분해 3건 · 잠긴 거래 탭 · 커뮤니티 고정 크기 · 분대원 1×4 · 목록 고정 높이 · ESC 메뉴 4건 · 1인 분대 즉사): `npm run verify` (폴더 매핑) → **전부 통과, 5분 15초**; 첫 실행 8 red 는 전부 옛 규칙을 보던 단언이었다. smoke-phase2 53 → **55**, smoke-inventory-p6 100 → **104**, smoke-meta 171 → **173**, smoke-social 130 → **136**. 자세히는 아래 [해당 절](#2026-09-08--uiux-정리-2차-13건-교체-링--상자-빛기둥--저격-탄도--분해--커뮤니티--esc--즉사).
- 2026-09-08 폐금속 공급 (고철 더미 · 기계 부품 · 무기/방탄복 분해): `npm run verify:all` → **전부 통과, 5분 38초**, 첫 실행부터 red 없음. smoke-tactical 85 → **87**, smoke-inventory-p6 93 → **100**, smoke-ecology 83 → **85**. 자세히는 아래 [해당 절](#2026-09-08--폐금속-공급-고철-더미--기계-부품--고물-분해).
- 2026-09-08 UI/UX 정리 12건 (튜토리얼 시설 관리 포커싱 · 하우징 Esc · 일시정지 커서 · 임플란트 칸 · 안내 줄 삭제 · 기업 화면 재배치 · 폐쇄 100 % 환급 · 훈련장 3건 · 포인터 락 재락 경합): `npm run verify:all` → **전부 통과, 6분 0초**. smoke-housing 197 → **200**, smoke-ship-rooms 71 → **72**, smoke-training 110 → **112**, smoke-tutorial 51 → **52**. 자세히는 아래 [해당 절](#2026-09-08--uiux-정리-12건-커서--esc--임플란트--기업-화면--환급--훈련장).
- 2026-09-08 튜토리얼 UI/UX 수정 4건 (시작 카드에 커서가 없던 문제 · `generator` 단계 신설 · 잠긴 항목 숨김 · 포커싱 확대-축소): `npm run verify:all` → e2e-mp 153/154 외 전부 통과, **5 min 41 s**; 그 1건은 검증 도중 내가 소스를 편집해 vite HMR 이 두 클라이언트를 리로드시킨 자가 flake로, `--rerun-failed` **156/156**. smoke-tutorial 39 → **46**. 자세히는 아래 [해당 절](#2026-09-08--튜토리얼-uiux-수정-4건-커서--발전기-단계--숨김--포커싱-연출).
- 2026-09-07 커서 편의성 3건 (ESC 재잠금 · 커서 가속 제거 · 드래그 고스트 중앙): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,033.71 kB JS / 200.61 kB CSS, **smoke-quickslots 46/46**, smoke-weapons 93/93, smoke-phase2 49/49, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63, **smoke-controls-hub 85/85**, smoke-housing 173/173, smoke-console 63/63, smoke-loadout 54/54, smoke-progression 68/68, smoke-search 59/59, smoke-ui-p6 68/68, smoke-ui-p5 132/132, smoke-meta 130/130, smoke-training 109/109, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-rogue-v2 52/52, smoke-social 116/116, smoke-planets 76/76, smoke-raidflow 43/43, smoke-ecology 83/83, e2e-mp 156/156 — **4 min 59 s** on 4 GPU lanes, **all green**, no re-run. New checks: the drag ghost rides centred on the pointer (quickslots +1), the virtual cursor moves 1:1 slow and fast (controls +1), and a denied pointer-lock request arms the gesture retry / Escape never counts / any other key retries (controls +3).
  Diagnosis was done in a **real Chrome tab** first (the extension's window is `visibilityState: hidden`, so a genuine pointer lock is impossible there — the lock was faked over the canvas the way the smokes do, and `Input.lockLooksReal` reset by hand, to exercise the synthesising path). That measured the acceleration (a 14 px delta moved the cursor 27 px) and caught the ghost drift as a hard number: mid-drag the ghost's bounding-box centre sat at x 1122 while the cursor was at 1080. Both are 0 px / 1:1 after the fix.
- Phase 11 — 행성 선택 · 소셜 (전체화면 터미널 · 행성 5종 + 생태계 · 아이디/친구/최근 플레이어 · 귓속말 · 분대 초대, `docs/DECISIONS.md`, 2026-09-07): `npm run verify:all` → **all passed in 5 min 0 s**. typecheck ok, typecheck-server ok, **net-selftest 276/276**, build 2,025.13 kB JS / 196.46 kB CSS, smoke-quickslots 45/45, smoke-weapons 93/93, smoke-phase2 49/49, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-inventory-p6 63/63, smoke-ship-rooms 71/71, smoke-controls-hub 77/77, smoke-housing 173/173, smoke-progression 68/68, smoke-console 63/63, smoke-loadout 54/54, smoke-ui-p6 68/68, smoke-search 59/59, smoke-ui-p5 132/132, smoke-meta 126/126, smoke-uniques 71/71, smoke-training 109/109, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52, **smoke-social 116/116**, smoke-rogue-v2 52/52, smoke-raidflow 43/43, **smoke-planets 76/76**, **smoke-ecology 83/83**, **e2e-mp 156/156**. 5 parallel folder agents (server / net / hub / ui / world+enemies) against the committed contract `e13f785`; core · game · verify.mjs · 문서는 리드 소유.
  - **New scripts**: `smoke-planets` (76: 전체화면 터미널 3열, 홀로그램 좌우 이동은 프리뷰, 행성 이동 → `hub:travel` → `hub:planetChanged`, 창밖 행성 재도색, `PLANET_STORAGE_KEY` 지속, 발사 슬롯 게이트, `game:newMission {planet}`), `smoke-social` (116: ESC 좌측 버튼 + 함선 전용 우측 소셜 열, 프로필 카드 2열, 우클릭 메뉴 4항목의 활성/비활성, 친구 삭제 확인, 커뮤니티 썸네일 접속 수 · 레드닷, 초대 P 홀드 게이지, 귓속말 칩, 설정 측면 패널), `smoke-ecology` (83: 행성별 바이옴 · 채집 가중치 · 노드 수 · 스폰 구성 · 결정성). 셋 다 `scripts/verify.mjs` 에 등록.
  - **Counts that grew**: net-selftest 194 → **276** (+82: 행성 권한 · `no_planet` · `game:start.planet` · 아이디 발급/충돌 · 친구 요청/수락/상호 삭제 · 프리즌스 전이 · 최근 목록 · 귓속말 라우팅 · `social:play` 3분기 · 캡), e2e-mp 124 → **156** (+32: 호스트 행성 미러 · 비호스트 거부 · 양 클라이언트의 `ctx.missionPlanet` · 친구 왕복 · 귓속말), smoke-training 109 유지(포드 게이트 때문에 부팅 시 `scav.planet` 을 심는 한 줄 추가), 나머지는 변화 없음.
  - **레인이 서로에게 남긴 회귀 3건, 전부 수정**: (1) `ui/menus/SettingsMenu` 가 두 번째 `ControlsPanel` 을 만들면서 `smoke-controls-hub` 의 문서 전역 셀렉터(`.ctl-mouse-svg .btn.bound`)가 두 패널을 합산해 마우스 카운트가 깨졌다 — 패널이 둘인 것이 의도이므로 셀렉터를 `.menu.title` 로 한정했다. (2) `hub` 의 발사 슬롯 행성 게이트가 `smoke-training` 의 무행성 탑승을 막았다 — 스모크가 부팅 때 행성을 심는다. (3) `smoke-social` 이 `n/m checks passed` 로 출력해 `verify.mjs` 의 집계 정규식(`n passed, m failed`)에 걸리지 않아 점수가 `ok` 로만 찍혔다.
  - **계약이 부족해 리드가 사후에 넓힌 것 2건** (레인 보고에서 나옴): `SocialErrorCode` 에 `my_squad_full` / `in_squad` 추가 — 내 분대가 가득 찼는데 "상대 분대가 가득 찼습니다", 이미 같은 분대인데 "이미 처리된 요청입니다" 라는 **틀린 한국어**가 나가고 있었다 (`playBlockReason` 은 이미 둘을 구분하고 있었는데 에러 코드가 없어 뭉개졌다). 그리고 `LobbyPlayer.code / level` 추가 + 서버가 `lobbyState()` 한 곳에서 프로필의 아이디·레벨을 실어 보내도록 — 그 전에는 로비 와이어에 이름밖에 없어 ESC 분대원 행이 **이름 매칭**으로 아이디를 추측했고 실패하면 `아이디 미확인` 을 띄웠다 (동명이인이면 오인까지). 스펙이 "분대원은 좌측에 간단 프로필 (아이디, 레벨)" 이라고 못박고 있어 회피가 아니라 수정이 맞다.
  - **스모크가 보지 않는 것**: 행성 홀로그램의 실제 모양 · 워프 컷씬의 연출 · 전체화면 터미널의 3열 비율 · 커뮤니티 썸네일 위치(`.cheat-tag` 가 함선에서 `top: 108px` 로 밀렸다) · 5행성의 하늘/포그 대비, 특히 **포그가 없는 카민 I** 는 배경을 하늘 지평선 색으로 칠하는 새 경로라 눈으로 볼 가치가 있다. 보이스 슬라이더는 **UI 뿐**이라 아무것도 검증하지 않는다.
- 캐릭터 모델 롤백 (Phase 10 의 스플래툰식 3등신 → 헬다이버즈2식 장갑 보병, 2026-09-07): `npm run verify:all` → **all passed in 4 min 40 s**. typecheck ok, typecheck-server ok, net-selftest 194/194, build 1,977.02 kB JS / 184.39 kB CSS, smoke-quickslots 45/45, smoke-weapons 93/93, smoke-phase2 49/49, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63, smoke-controls-hub 77/77, smoke-housing 173/173, smoke-progression 68/68, smoke-console 63/63, smoke-loadout 54/54, smoke-ui-p6 68/68, smoke-search 59/59, smoke-ui-p5 132/132, smoke-meta 126/126, smoke-uniques 71/71, smoke-training 109/109, smoke-library 126/126, **smoke-ghost 86/86**, smoke-enemy-delta 52/52, smoke-rogue-v2 52/52, smoke-raidflow 43/43, **e2e-mp 124/124**. 카운트 변화 없음 (`smoke-ghost` 의 `capeGone` 단언만 `cape` 로 뒤집혔다 — 망토가 돌아왔으므로).
  - **롤백이 드러낸 실제 버그 하나** (테스트 버그가 아니라 소스 버그): 되돌린 모델로 `e2e-mp` 가 재현성 있게 123/124 로 떨어졌다 — `A: no console errors TypeError: Cannot read properties of undefined (reading 'isReady')`, 스택은 `three.module.js` 뿐. 원인은 `weapons/fx/WeaponFx.warmUp` 의 `renderer.compileAsync(scene, camera)`: three 는 **살아 있는 씬**에서 모은 머티리얼 집합을 10 ms 마다 `program.isReady()` 로 폴링하는데, 폴링이 끝나기 전에 그 중 하나가 dispose 되면(원격 아바타 이탈, 기어 룩 재생성, 적 despawn) `properties.get(material).currentProgram` 이 `undefined` 가 되어 three 자신의 `setTimeout` 안에서 throw 한다 — 우리 `.catch` 가 닿지 않는 자리다. 옛 모델이 머티리얼/메시가 더 많아 폴링 창이 넓어지면서 잠복이 드러난 것. 프라미스를 기다린 적이 없으므로 `renderer.compile()` 로 교체했고(링크 발행은 동일, 드라이버가 백그라운드로 마저 컴파일), e2e 가 124/124 로 복귀했다. 격리 실험: `GearLook` 만 Phase 10 으로 되돌려도 실패가 남아 `SoldierModel` 이 방아쇠임을 확인했고, HEAD(롤백 전)에서는 124/124 였다.
  - **스모크가 보지 않는 것**: 되살아난 실루엣(헬멧 · 어깨 패드 · 등짐 · 망토)과 들쳐메기 팔 각도는 여전히 **시각적** 확인이 필요하다 — 어깨 소켓의 위치(`(0.12, 0.36, 0.02)`)는 어깨 패드(torso y 0.52) 아래에 맞춰 기하학적으로 잡았을 뿐 실제로 업고 걸어보지 않았다. 준비 패널 초상화(`CAM_HEIGHT` 1.15 / `LOOK_Y` 1.0)도 새 비율 기준으로 잡힌 값을 그대로 두었으므로 프레이밍을 한 번 볼 가치가 있다.
- Phase 10 — UI 개선 (인게임 커서 · 배리어 방패 · 적 사망/시체 · 들쳐메기 · 회복약 · 크레딧 표기 · 준비 패널, `docs/DECISIONS.md`, 2026-09-07): `npm run verify:all` → **all passed in 4 min 40 s**. typecheck ok, typecheck-server ok, net-selftest 194/194, build 1,976.38 kB JS / 184.39 kB CSS, smoke-quickslots 45/45, **smoke-weapons 93/93**, smoke-phase2 49/49, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, **smoke-tactical 64/64**, smoke-inventory-p6 63/63, smoke-ship-rooms 71/71, smoke-controls-hub 77/77, smoke-housing 173/173, smoke-progression 68/68, smoke-console 63/63, smoke-loadout 54/54, smoke-ui-p6 68/68, smoke-search 59/59, **smoke-ui-p5 132/132**, smoke-meta 126/126, smoke-uniques 71/71, smoke-training 109/109, smoke-library 126/126, **smoke-ghost 86/86**, smoke-enemy-delta 52/52, smoke-rogue-v2 52/52, smoke-raidflow 43/43, **e2e-mp 124/124**. 9 parallel folder agents against the committed contract `89b9bfd`.
  - **Counts that grew**: ui-p5 105 → **132** (crosshair reload + heal rings, map middle-click ping, cursor sprite on the translate channel, tooltip credit bar), ghost 57 → **86** (carry: `findCarriable`, socket parenting, the revive prompt tracking the socket, `setCarriedBy` ride-along), e2e-mp 103 → **124** (crew-card round trip incl. clamping, `crewq loadout`, carry flags / `cr` / derived `carriedBy`), weapons 75 → **93** (회복약 2 s hold, H retired, reload cancel, the barrier block rewritten for the carried shield), training 94 → **109** (READY panel + 분대원 장비 popup), search 51 → **59** (live container takes), loadout 46 → **54** (`captureCrewLoadout` / `createCrewLoadoutView`), tactical 55 → **64** (shield raise / arc gate / follow / lower), rogue-v2 46 → **52** (mid-air death → fall → corpse at the landing spot), phase2 46 → 49, phase4 46 → 49, ship-rooms 67 → 71 (starboard camera + non-mirrored cursor), controls-hub 71 → 77, housing 155 → 173.
  - **Five failures the first full run caught.** (1) `smoke-ui-p5` timed out closing the map: the script dispatched `KeyM` **keydown only**, twice, so the first tap left `KeyM` in `Input.down` and the second was never a fresh press — exactly the pitfall `CLAUDE.md` documents. Fixed with a page-side `tapKey()` that sends keydown + keyup in the same frame. (2)(3) Two `smoke-ghost` carry checks: the **test** had no `waitSim` between `carry()` and the assertions, so no frame ran in between and `syncRevive` — a *per-frame* writer of the revive prompt's position — had never observed `av.carried` (`dRef` was exactly 0 because `entry.position` was still the clone taken at registration; proven with a frame counter showing an identical `ctx.time` at both reads). And `debugCarryLocal` only wired `setCarriedBy` synchronously when there was **no** `localId`, so under `verify:all` — where the relay hands one out — it took the wire path and `updateCarries` had not run yet. (4) Four `e2e-mp` carry checks: `A.evaluate((bid) => …)` was **missing its `bIdCarry` argument**, so the forced `ctx.player.carrying` getter returned `undefined` and no carry ever reached the wire. (5) `e2e-mp`'s loadout and (after that fix) malformed-card checks were ordering assumptions — `hub/` answers `crewq loadout` with the member's **real** document and broadcasts genuine `crew card`s on its own, so `find(...)` picked hub's answer and `.pop()` picked hub's later card. Both are anchored now (a `probe` marker; a slice from a pre-recorded `__crewCards.length`). **Every one of the five was a test bug, not a source bug.**
  - **Two lead-level fixes the lanes' reports forced.** *Faked pointer locks would have doubled every click*: the plan assumed headless smokes fall back to the software cursor's mirror path because `requestPointerLock` is stubbed, but every smoke *also* fakes `document.pointerLockElement` onto the canvas, so `isPointerLocked` is `true` and the cursor would synthesise a second press on top of Puppeteer's real one — clobbering the real-mouse drags in `smoke-quickslots`, `smoke-inventory-p6` and `smoke-controls-hub`. Fixed in `shared/Input` instead of in the scripts: a locked pointer holds `clientX/clientY` constant per spec, so a `mousemove` that claims a lock *and* moves them latches `lockLooksReal = false`, and the new `Input.cursorOwnsInput` (cursor mode **and** a real lock) is what gates synthesis; `mouseDX / mouseDY` stay on `isPointerLocked` alone because the camera-look smokes need the faked lock. *Dropping the per-screen relock microtasks was wrong* (my instruction in the plan): Chrome releases the lock on **every** Escape, so a cursor-mode screen closed with Escape left the player unlocked — rather than restore eight call sites, the single `input:cursorModeChanged` bridge in `main.ts` re-requests the lock once the last cursor owner is gone and no blocker remains (idempotent when the lock survived).
  - **Flake worth remembering**: two mid-run `e2e-mp` failures (`Cannot read properties of undefined` reading `length` / `ctx`, both during a multi-second wait) were **vite full-reloads** — a folder agent was still editing `src/player/` while the run was in flight. Not a code problem; it is the hazard `CLAUDE.md` already warns about, and both vanished once every lane had settled.
  - **Not covered by a smoke**: the new character proportions, the shield grip model, the three death directions, the light pillars and the READY-panel portraits are **visual** and only assert structurally (mesh presence, `getBarrierPose` geometry, the `deathFall` blend, the cursor sprite's `translate`). They want one screenshot pass (`node scripts/smoke-controls-hub.mjs --shots` → `scripts/shots/`); the starboard 시설 관리 camera in particular was reasoned about geometrically (eye at `y 6.6`, well above `CEIL 3.2`, ceiling back-face culled from above) but never looked at. `PortraitRef`'s second WebGL context is exercised only through `createPortraits() !== null`.
- Phase 9 — Known follow-ups II (프로필 타임스탬프 · 고스트/호스트 이관 · 늦은 합류 동기화 · 델타 적 스냅샷 · 서재 책장 · 훈련장 표적 모드 · 소규모 정리, 2026-09-07): `npm run verify:all` → **all passed in 4 min 36 s**. typecheck ok, typecheck-server ok, net-selftest 194/194, build 1,903.00 kB JS / 162.51 kB CSS, smoke-quickslots 45/45, smoke-weapons 75/75, smoke-phase2 46/46, smoke-phase4 46/46, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-tactical 55/55, smoke-inventory-p6 63/63, smoke-ship-rooms 67/67, smoke-housing 155/155, smoke-controls-hub 71/71, smoke-progression 68/68, smoke-loadout 46/46, smoke-console 63/63, smoke-ui-p6 72/72, smoke-search 51/51, smoke-meta 120/120, smoke-ui-p5 96/96, smoke-training 94/94, smoke-uniques 71/71, **smoke-library 126/126**, smoke-ghost 72/72, **smoke-enemy-delta 52/52**, smoke-rogue-v2 46/46, smoke-raidflow 43/43, **e2e-mp 103/103**. No re-run needed — the two long-standing flakes (smoke-rogue-v2's grenade sequence, smoke-uniques' `empty tube reloads itself`) were green first try on a quiet machine.
  - **New scripts**: `smoke-library` (126: book defs + loot sources, 서재 배치, 꽂기/빼기/회수, 배율 + 상한, 도감, v3 저장 · 손상 저장 sanitise, 패널 DOM) and `smoke-enemy-delta` (52: keyframe / delta field omission, `seq`, `gone`, unknown id, `applyWire`, burn-attacker credit). Both registered in `scripts/verify.mjs`.
  - **Counts that grew**: e2e-mp 70 → **103** (container authority, overcharge beam, two-client training join, delta re-checks), net-selftest 165 → **194** (document stamps, parked host migration, reload = mission leave), housing 152 → 155, weapons 56 → 75, ghost 57 → 72, training 61 → 94, ui-p5 89 → 96, ui-p6 48 → 72, progression 65 → 68, tactical 45 → 55, stratagems 51 → 70, search 50 → 51, phase2 43 → 46, raidflow 38 → 43.
  - **Bugs the first full run caught** (13 checks over 7 scripts, all fixed): the `strat sync` fast-forward was **not** silent (a late joiner felt a demolition that had already happened — the synced structure hp was applied outside the silent window); `TrainingPanel` polled `ctx.world.training` every frame and reverted whatever its own bus events had just set (the arena emits from inside its update, one poll ahead of the HUD); `enemy:killed` was emitted only for a *local* credit, so a peer-credited burn kill produced no event at all, and a local kill reported the raw PeerId instead of the normalised `'local'`; `ProfileSync.applyRecord` hands a client its own pending document back, which made the inventory re-apply and re-save the starter kit as a `profile` save; the new book defs shifted the tier-4 loot table and broke a bag-space assumption in `smoke-search`. Assertion-side fixes: an unsorted wire-field string, a same-frame `remaining` sample, a lane-centre mix-up (target 3 is in lane 0), a `flow rejoined` check that assumed only one system answers, and a cross-client uid comparison in the e2e (uids are minted per client; compare by index / defId).
  - **Follow-up the enemies fix forced**: broadening `enemy:killed` to peer-credited kills made `meta/MetaSystem` count a squadmate's kill toward the local contract *and* receive it again as a relayed `meta contractHit` — fixed with a `by` filter matching the one its `stratagem:called` handler already had.


- `npm run typecheck` → 0 errors (TypeScript 7: `tsconfig.json` uses `paths` only, no `baseUrl`).
- `npm run build` → single ~870 kB JS chunk, ~28 kB CSS.
- Headless/headed Chrome smoke tests (puppeteer-core, driving `window.__game` = Engine): title → deploy → hellpod drop → movement + pointer lock → firing/reload/stim/grenade → crate open → container drag/rotate/right-click/take-all → Tab bag → Esc pause → extraction switch → 120 s countdown (fast-forwarded) → ship lands → boarding → interior switch → liftoff → mission complete; death → restart. 0 console errors. ~55 fps at 1600×900 on a laptop GPU.
- Real-mouse test (puppeteer `page.mouse`): title seed input + 임무 배치, pause 계속, inventory drag, death-screen 다시 배치 all clickable. Root cause of an earlier "nothing clickable" bug: the inventory overlay (`.inv-root`, fixed inset:0, z-index 50, pointer-events:auto) was hidden only via the `hidden` attribute, which its own `display:flex` overrode → invisible layer swallowed every click. Fixed with a global `[hidden] { display:none !important }` in `base.css`. Rule: never hide a full-screen layer with opacity alone.
- Debug hooks: `window.__game.ctx` (GameContext), `window.__game.getSystem('extraction'|'player'|'weapons'|'net'|'enemies'|'remotePlayers'|…)`.
- Multiplayer (2026-09-05): `npm run net:selftest` 44/44 (lobby create/join/ready/start gating/relay targets/reset/leave/host migration). `npm run e2e:mp` (puppeteer-core, two separate headless Chrome instances — a second tab in one window is throttled and never reaches `playing`) 34/34: lobby code + invite URL + LobbyMenu, start refused until all ready, both clients seed 42 / authority split, hellpod → playing, remote avatar within 0 m of the true position, spawn slots 5.7 m apart, nameplate + squad panel, teleport interpolated, host 18 / client 18 replica bugs with matching ids, client hit → host hp 60→50 → client mirrors 50, `net:remoteFired` / `net:remotePing` delivered, client console activates extraction on host + countdown mirrored (119.7/119.9), missionTime advances during `freeze:false` pause, host abort → both back in a reset lobby with remotes cleared, peer leave. 0 console errors.
- Fixed while testing: `EnemySystem`'s `game:newMission → reset()` wiped the initial population (pre-existing ordering bug, see enemies README); `Input.requestPointerLock` now swallows the denied-lock promise rejection.
- Ship hub / pings v2 / chat / drop & split / pickups / reconnection (2026-09-05): typecheck 0 (client + server), build ~1083 kB JS / 53 kB CSS, `npm run net:selftest` (token → stable id, duplicate takeover, grace, host kept while started, quick match, seed/name/public, ghost-host migration on join) — see server README for the count. `npm run e2e:mp` rewritten for the hub flow: personal ship → quick match (`net:matched`) → docking → shared ship → hub avatars with `IN_HUB` → chat relay in the hub → start refused → seed via lobby → pods (`IN_POD`) → countdown → mission seed 42 → remote avatar 0.4 m → replica bugs 20/20 → client hit 60→50 → attack ping with label + marker → host drop → client pickup take (4→5) → client socket drop → `net:resumed {seamless:true}` still extracting → host abort → both back in the shared ship, pods empty → peer leave → undock. Per-folder headless smokes: hub 41/42 offline, player 26/26 (camera clearance ≥ 0.30 m over 128 prone/slope checks, silhouette through a wall), inventory 56/56 real-mouse, ui 33/33 + 6/6 enemy-tracking, pickups 18/18, audio 6/6.
- Grenade hitch root cause: per-grenade `PointLight` toggled via `visible` changed the scene light count → every lit shader recompiled on each throw/explosion (~1.1 s, `renderer.info.programs` growing 35→77). Fixed by removing the lights (pooled flash pulses instead) + `WeaponFx.warmUp()`; throw frame now ≤ 5.7 ms. Rule: never toggle light visibility at runtime; keep light counts constant.

- Weapon package (2026-09-05): typecheck 0 (client + server), build 1126 kB JS / 60 kB CSS, `npm run net:selftest` 101/101, `npm run e2e:mp` 52/52 (unchanged flow, pickups now carry `ex`), `node scripts/smoke-weapons.mjs` 44/44: workbench interactable + menu/blocker/Esc, starter loadout AR I / — / P-2 + 일반 가방 5×6, AR I 60 dmg / 500 dur, AR III 74 dmg + numeral, secondary half ADS + faster swap, reserve = 90 bag rounds, fire → mag −n / durability −n / event, R reload refills from the bag, 3/2/Q/1 swaps (empty slot refused, `equip` into 주무기 II), brake attach (recoil ×0.75) / choke refused / detach back to bag, unload → bag rounds, repair cost 4 폐금속 / refused without / restores 500, broken weapon does not fire, legendary 10×6 → common 5×6 drops the overflow as pickups, HUD stamina/durability/slot strip. Screenshots (hip / ADS / side / inventory) checked: rifle renders, soldier sits bottom-left of the reticle while aiming, stamina bar bottom-centre only after sprinting.

- Phase 2 (2026-09-06): typecheck 0 (client + server), build 1161 kB JS / 69 kB CSS, `npm run net:selftest` 101/101, `npm run e2e:mp` 52/52, `node scripts/smoke-weapons.mjs` 44/44, `node scripts/smoke-quickslots.mjs` 45/45, `node scripts/smoke-phase2.mjs` 44/44: starter quick slots N grenade / S stim (2 active with a common bag, locked E refused, weapon refused), F tap → item in hand, F hold → wheel → drag down hovers S → release equips the stim, LMB stim heals + stack −1, wheel N → grenade, LMB hold → wind-up, RMB underhand, R → cooking with shrinking fuse, release → thrown / stack −1 / early explosion, 1 → rifle; lethal damage → downed (prone, weapons off, downHp 100, ~1/s bleed, damage hits downHp), enemies drop the target, `revive()` → 10 hp; Space hold → dead, no `game:over`, phase `dead` + death screen + countdown, early respawn refused, countdown (time-scaled) → `game:respawn` → hellpod → alive at 100 hp with the starter kit. Screenshots: wheel with locked sectors, downed vitals + revive progress, cook arc + 언더핸드 tag. Fixed while testing: a blanket edit had reset the respawn timer inside `enterDeadPhase`.

- Phase 3 (2026-09-06): typecheck 0 (client + server), build 1203 kB JS / 76 kB CSS, `npm run net:selftest` 101/101, `npm run e2e:mp` 52/52 (launch wait raised to 60 s — the extra HUD/stratagem work lowered the headless frame rate), `smoke-phase2` 44/44, `smoke-weapons` 44/44, `smoke-stratagems` 51/51, `smoke-phase3` 32/32: G tap arms / puts away, gun blocked while armed, G hold wheel → drag E → airstrike, LMB charge ~1/3 at 1 s → top view (camera +88 m, controls off) → cursor follows the mouse → RMB cancels and the camera eases back, `debugCall` airstrike lands and damages a bug parked in the blast, structure drop → 5 destructible obstacles, 500 dmg → hp 1500, 5000 → destroyed + removed + `structureCount` 4, supply drop → `supply:*` interactable → `crate:open` tier 5 → loot window, laser active → ended, HUD layers present, 0 console errors. Screenshots: barricades + supply crate, laser beam, top-view targeting frame with edge arrows. Fixed while testing: stratagem timestamps are `ctx.time` based — added a pause shift so a frozen single-player game never lands a call.

- Phase 4 (2026-09-06): typecheck 0 (client + server), `npm run net:selftest` 101/101, `node scripts/smoke-phase4.mjs` (seed 21): rogue guards at tier ≥ 2 crates (≤ 16, boss + escorts once), rogue fires at a player 22 m away with LOS, bug ↔ rogue clash, artillery shell fired → `raycastInterceptable` → `intercept()` → `enemy:shellIntercepted`, shell landing damage, toxic burst hurts a neighbouring bug and kills itself, behemoth frontal raycast is `armored`, corpses register `corpse:<id>` → loot window, wire hints; plus `rollCorpse` rogue/boss tables, `applyKnockback`, `openContainerItems`. Regression after Phase 4: `smoke-phase4` 35/36 (the miss is a 3 s timing window on the rogue burst; relaxed afterwards), `smoke-phase3` 32/32, `smoke-phase2` 44/44, `smoke-weapons` 44/44, `e2e:mp` 52/52 (needs a freshly started relay — public lobbies left by an interrupted run persist for the 5-min grace and hijack quick match), build 1246 kB JS / 76 kB CSS.

- Tactical-kit merge (2026-09-06, `feature/tactical-kit` → `main`): 53 conflicting files resolved with a **main-wins** policy (Phase 1–4 designs kept: `bag_*` bags, quick wheel, Phase 2 downed / revive, weapon durability, workbench) and the kit's non-overlapping systems grafted on top (implants, gadgets, progression, armor, weight, crafting, gather nodes, melee, roll, cloak, lures / smoke perception, ship stations, HUD widgets, SFX). typecheck 0 (client + server), build 1468 kB JS / 102 kB CSS, `npm run net:selftest` 101/101, `npm run e2e:mp` 52/52, `smoke-weapons` 44/44, `smoke-phase2` 44/44 (T/H keys), `smoke-quickslots` 45/45 (after removing the branch's colliding `.inv-quick-cell` CSS), `smoke-phase3` 32/32, `smoke-phase4` 36/36, `smoke-stratagems` 51/51, `smoke:tactical` 45/45 (bags instead of backpacks, `equip(uid, 'armor')`, legendary bag so every gadget fits). 0 console errors with the relay running (without `npm run server` the `/ws` proxy logs one WebSocket error).

- Controls / hub screen / implant package (2026-09-06): typecheck 0, build 1490 kB JS / 108 kB CSS, `npm run smoke:controls` 60/60 (title diagram 60 keys / 25 lit / 3 mouse, rebinding 앉기 → N persisted + diagram follows, conflict rows, mouse-only refusal, reset, Esc; hub Tab screen layout 창고 | 장비 | 가방, 10×24 stash, tabs, bag → stash + reload persistence, implant picker equip / unequip, right-click 수리 (폐금속 4) → 500/500, 캐릭터 tab ↔ 인벤토리 tab, terminal 678/678 × 618/618 no overflow, gauge left of the reticle, launcher wielded → 3 stows it + draws the secondary, overcharge hold drains 6 → 4.5 and heals 60 → 80, release refills, dash 3 segments → 2 ready + 1 refilling, grapple bracket + instant fire), 0 console errors. Fixed while testing: Chrome runs listeners in registration order for events dispatched **at `window`** (capture-phase overlay handlers only win for real key events / `document.body` dispatch), the hub layout was squeezing the equipment column below 1600 px (panels `flex: none`, rose-right and two-column equipment only ≥ 1600 px), and dropping in the ship now lands in the stash.

- Verification runner + GPU smokes (2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 101/101, build 1,490.21 kB JS / 108.36 kB CSS, smoke-weapons 44/44, smoke-quickslots 45/45, smoke-phase2 44/44, smoke-phase4 36/36, smoke-phase3 32/32, smoke-stratagems 51/51, smoke-tactical 45/45, smoke-controls-hub 60/60, e2e-mp 52/52 — **2 min 7 s** total on 4 GPU lanes (was 31 min on 2 swiftshader lanes; one swiftshader script alone 142 s vs 18 s on the GPU). Pointer-lock stub in every script (cursor no longer trapped top-left while a smoke runs). Under swiftshader load two harness-only flakes appeared and vanished on the GPU: smoke-phase2 "F tap puts a quick item in hand" and a headless AudioContext device error counted as a console error by smoke-phase3.

- Phase 6 — dev console · unique weapons · stat XP · ship housing (2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 101/101, build 1,669.01 kB JS / 124.63 kB CSS, smoke-weapons 44/44, smoke-quickslots 45/45, smoke-phase2 44/44, smoke-phase3 32/32, smoke-phase4 46/46 (+10 Phase 6 status / teleport / heavy-melee / FOV checks), smoke-stratagems 51/51, smoke-inventory-p6 63/63, smoke-tactical 45/45, smoke-ship-rooms 47/47, smoke-housing 127/127, smoke-progression 50/50, smoke-console 63/63, smoke-controls-hub 60/60, smoke-ui-p6 48/48, smoke-uniques 64/64, e2e-mp 52/52 — **2 min 57 s** on 4 GPU lanes, 0 console errors. Built by 8 parallel folder agents (console, progression, items, enemies+player, housing, hub, inventory, ui) + weapons in a second wave against the committed `src/shared` contract (`docs/DECISIONS.md`). Harness finding: while several agents edit at once, every non-HMR file write full-reloads the shared vite page and kills smokes mid-run — agents ran on a private `npx vite --port 5299` (HMR off); `smoke-console` stalls the `vite-hmr` WebSocket instead. Design findings kept as behaviour: bazooka self damage is pre-scaled by `1 / (1 − damageReduction)` so the flat 22 lands after armor DR; flame heat only decays once the flame leaves the target (per-frame decay made 전소 unreachable on a moving bug); `shocked` passes the speed multiplier (`SHOCK_SLOW_FACTOR` 0.55) as `dps`.

- Phase 5 remainder — corporations · contracts · quests · credits · loadout persistence (2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 101/101, build 1,727.09 kB JS / 136.12 kB CSS, smoke-weapons 44/44, smoke-quickslots 45/45, smoke-phase2 44/44, smoke-phase3 32/32, smoke-stratagems 51/51, smoke-phase4 46/46, smoke-tactical 45/45, smoke-inventory-p6 63/63, smoke-ship-rooms 61/61 (+14 ship-computer checks), smoke-housing 127/127, smoke-progression 50/50, smoke-controls-hub 60/60, smoke-console 63/63, **smoke-loadout 45/45 (new)**, smoke-ui-p6 48/48, **smoke-ui-p5 52/52 (new)**, **smoke-meta 90/90 (new)**, smoke-uniques 63/64 → 64/64 on `--rerun-failed` (the `empty tube reloads itself` check is a timing window under 4-lane load), e2e-mp 52/52 — **3 min 14 s** on 4 GPU lanes, 0 console errors. Built by 4 parallel folder agents (meta, inventory, hub, ui) on private vite ports 5301–5304 against the committed contract `3bc09ac` (`docs/DECISIONS.md` Phase 5); every new smoke parks the `vite-hmr` socket so other agents' saves cannot reload it. Lead-owned: `src/shared/meta.ts` contract, `GameFlowSystem` settlement hook + `stats.rewards`, stat-effect wiring (grenade throw √`throwRangeMul`, quick-use cooldown ÷ `useSpeedMul`, holds ÷ `interactSpeedMul` once in `PlayerSystem`). Note: smokes on a private vite port need the relay up, otherwise the `/ws` proxy error counts as a console error.
- Phase 6 plan audit (2026-09-06): `docs/DECISIONS.md` compared bullet by bullet against the code by 5 explore agents (console + progression, items + weapons, enemies + player + ui, housing + hub, inventory + lead tasks) — every plan item was already implemented; only deviations were fixed (unique RMB entered the ADS state, housing mode allowed from the corridor, a second 작업실 / 사격장 silently shared the first room's level, the carried piece was invisible to the HUD hint, `FurnitureLayer` rebuilt all 10 rooms on every `housing:changed`, 회로 기판 missing from tier 2, `smoke-ui-p6` dead skip branch). `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 101/101, build 1,727.97 kB JS / 136.12 kB CSS, smoke-weapons 44/44, smoke-quickslots 45/45, smoke-phase2 44/44, smoke-phase4 46/46, smoke-phase3 32/32, smoke-stratagems 51/51, smoke-tactical 45/45, smoke-inventory-p6 63/63, smoke-ship-rooms 61/61, **smoke-housing 131/131** (+4: duplicate facility rooms refused, housing mode refused from the cockpit, `hub.currentRoom` 0 after a teleport into the room, then allowed), smoke-progression 50/50, smoke-console 63/63, smoke-controls-hub 60/60, smoke-loadout 45/45, smoke-ui-p6 48/48, smoke-ui-p5 52/52, smoke-meta 90/90, smoke-uniques 64/64, e2e-mp 52/52 — **3 min 11 s** on 4 GPU lanes, 0 console errors. Left as documented behaviour: 전소 embers share the opaque gore point pool (not additive), replica `SLOWED` bit sets no `slowFactor` (replicas do not move themselves), catalog is its own leftmost panel, startup stash size is grow-only.
- Phase 7 — Known follow-ups resolved (server profile / raid session · ghosts · host migration · training range · container search + authority · rogue AI v2, 2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 165/165, build 1,818.19 kB JS / 138.78 kB CSS, smoke-quickslots 45/45, smoke-weapons 56/56, smoke-phase2 43/43, smoke-phase4 46/46, smoke-stratagems 51/51, smoke-phase3 32/32, smoke-tactical 45/45, smoke-inventory-p6 63/63, smoke-ship-rooms 61/61, smoke-housing 151/151, smoke-controls-hub 60/60, smoke-loadout 45/45, smoke-console 63/63, smoke-progression 65/65, smoke-ui-p6 48/48, smoke-search 50/50 (new), smoke-ui-p5 89/89, smoke-meta 120/120, smoke-training 61/61 (new), smoke-uniques 71/71, smoke-ghost 57/57 (new), smoke-rogue-v2 46/46 (new), smoke-raidflow 40/40 (new), e2e-mp 70/70 — all passed in 4 min 4 s (24 jobs, 4 lanes). 9 parallel folder agents against contract `64031f7`; each agent ran its own smokes on a private vite port first.

- Phase 8 — UI/UX pass (embedded Tab screens · 온실 재배 · 함선 관리 · 자동문 + 방 조명 · 설정 메뉴 · 재료 요구 칩, 2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 165/165, build 1,863.98 kB JS / 151.90 kB CSS, smoke-quickslots 45/45, smoke-weapons 57/57, smoke-phase2 43/43, smoke-phase3 32/32, smoke-phase4 46/46, smoke-stratagems 51/51, smoke-tactical 45/45, smoke-controls-hub 62/62, smoke-ship-rooms 61/61, smoke-inventory-p6 63/63, smoke-loadout 46/46, smoke-search 50/50, smoke-housing 151/151, smoke-console 63/63, smoke-progression 65/65, smoke-ui-p6 48/48, smoke-ui-p5 89/89, smoke-uniques 71/71, smoke-rogue-v2 46/46, smoke-meta 120/120, smoke-training 61/61, smoke-ghost 57/57, smoke-raidflow 40/40, e2e-mp 70/70 — **~1500 smoke checks + 70 e2e + 165 selftest, 0 failed** after re-running two known flakes. Built by 8 parallel folder agents (items, housing, hub, inventory, progression, meta, net+audio, ui+game) against the committed contract `9b04073` (`docs/DECISIONS.md`).
  - Two known flakes needed `--rerun-failed`, both confirmed **not** Phase 8 regressions and both green on the re-run (smoke-ship-rooms 61/61, smoke-uniques 71/71): **smoke-rogue-v2**'s rogue-grenade block (40/46 on a bad run) — `git diff e74073a -- src/enemies` is empty, the folder was never touched this phase, and a clean Phase 7 worktree reproduces the same intermittent 45/46; the six checks are one sequence gated on the rogue holding line-of-sight-blocked for `ROGUE_GRENADE_HOLD_S`, and under 4-lane load that window is missed. And **smoke-uniques**' `empty tube reloads itself` (70/71), already recorded as a load-timing flake in the Phase 5 entry. Both would be worth driving deterministically instead of waiting on the AI / reload clock.
  - **Process note, recorded so it is not repeated**: `scripts/logs/*.log` persists between runs, so reading the individual logs while a run is in flight can return the *previous* run's numbers. Read the runner's own summary / `docs line:` instead. Two overlapping `verify:all` invocations also fight over port 5273 and produce a cascade of `ERR_CONNECTION_REFUSED` failures that mean nothing.
  - **Smoke updates the behaviour changes forced** (lead-owned, `scripts/`): the 캐릭터 / 기업 tabs no longer close the inventory window (they mount an `EmbeddedView` into the `.inv-screen` host, which is *hidden*, never removed), the tab strip gained 함선 and is hidden outside the hub, the credits pill reads `CREDITS 500`, the implant picker lives in a `.inv-modeless-implant` frame (the old `.inv-implant-picker` never carries the hidden state now), the bench craft list no longer lists `break_*` (분해 moved to the right-click menu), repair costs are `.item-chip` elements not text, the cockpit no longer registers `hub_workbench` / `hub_garden` (smoke-weapons places the starter 정비 벤치 in a 작업실 and drives `hub_furn_<uid>`), the personal ship carries **13** constant point lights (10 + `ROOM_LIGHT_POOL`), Escape in the ship opens the pause menu so three smokes now open the terminal through its interactable, fresh saves hold two furniture-storage entries, `FURNITURE_DEFS` is 17 and 작업실 accepts 13 defs, only 6 purposes still show 다음 업데이트, and the housing key line gained `C 취소`.
  - **Two integration bugs found and fixed after the agents finished** (neither folder could see them alone): (1) *Escape double-fire* — systems are polled in registration order, so hub/ closing the terminal (or un-boarding a pod, or leaving 함선 관리) released its blocker and game/'s later poll saw the same unblocked Escape and opened the 일시정지 메뉴 in the same frame. Fixed with a new `Input.consume(code)` / `consumeMouse(button)` in the contract, called by every hub/ Escape branch and by `HousingMode`. (2) *함선 관리 needed an unlocked pointer* — the new 방 목록 / 가구 카드 바 are real DOM, but housing mode drove its floor cursor from pointer-locked deltas (`Input.mouseDX` only accumulates while locked) and a lost lock exited the mode. Manage mode now takes a `shipmanage` blocker, exits the lock, raycasts `Input.mouseX/Y` onto the room floor, and swallows an LMB whose `elementFromPoint` lands inside `#ui-root`.
  - Also lead-owned: `SHIP_STATE_VERSION` bumped 1 → 2 in the contract (housing had defensively computed its own), and `HousingRef.lockCrewName()` added so the one-time 승무원 호출명 actually persists (`ShipState.nameLocked` was written and sanitised but nothing ever set it).

- Phase 8 UI/UX 개선 pass (아이템 칩 호버 카드 · 전술 임플란트 중앙 패널 · 방 메뉴/시설 메뉴 제거 → 시설 관리 통합 · 방 1 = 작업실 · 하우징 모드 우측 리스트 + ESC/C 버그, 2026-09-06): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 165/165, build 1,861.62 kB JS / 157.26 kB CSS, smoke-quickslots 45/45, smoke-weapons 57/57, smoke-phase2 43/43, smoke-phase4 46/46, smoke-stratagems 51/51, smoke-phase3 32/32, smoke-tactical 45/45, smoke-inventory-p6 63/63, **smoke-ship-rooms 67/67**, **smoke-housing 152/152**, **smoke-controls-hub 71/71**, smoke-progression 65/65, smoke-loadout 46/46, smoke-console 63/63, smoke-ui-p6 48/48, smoke-search 50/50, smoke-ui-p5 89/89, smoke-meta 120/120, smoke-training 61/61, smoke-uniques 71/71, smoke-ghost 57/57, smoke-raidflow 40/40, smoke-rogue-v2 46/46, e2e-mp 70/70 — 0 failed in 4 min 38 s + 1 min 36 s for the re-run.
  - The same **two known flakes** as the Phase 8 entry above needed `--rerun-failed` (smoke-rogue-v2's rogue-grenade sequence 40/46, smoke-uniques' `empty tube reloads itself` 70/71); both green on the re-run and neither folder was touched. A private `npx vite --port 5299` was still running during the full pass and made the load worse — kill the screenshot / private server before `verify:all`.
  - **Smoke updates the behaviour changes forced** (`scripts/`): `smoke-ship-rooms` (+6) asserts `hub_facility` and `hub_room_<i>` are **gone**, that room 1 is the built-in 작업실 with both benches placed (it recovers them before the rest of the run, and the recover-event count is now relative), and adds a new **시설 관리 (M)** block — M opens the screen and takes the `shipmanage` blocker, Esc leaves it with the blocker released, controls back, the corner hint back and **no** pause menu, and C with an empty cursor does the same. `smoke-housing` (+1) covers the new fresh state, the room-1 lock (`방 1에만` / `기본 작업실`), the furniture that migrates into storage on a corrupt/old save, and replaces the 방 메뉴 / 시설 메뉴 DOM blocks with the 시설 관리 screen (방 목록 rows, 가구 목록 for an assigned room, the 용도 지정 picker with blocked purposes for an empty one, `openRoomMenu` / `openFacilityMenu` redirecting). `smoke-controls-hub` (+9) covers the centred fixed-size implant panel, the `장착 중` label under the description, the `.inv-screen` panel background, the two-column 함선 tab with the locked room 1 and the sticky 시설 관리 (M) button, and the `.item-chip[data-def-id]` hover card appearing / hiding. `smoke-training` moved its 사격장 to room 6 (room 1 is the 작업실 now) and finds the sim hub by uid instead of "the first `hub_furn_`".
  - Visual pass: nine screenshots at 1680 × 960 (Tab 함선 / 캐릭터, implant panel, craft panel, chip tooltip, 시설 관리 on an assigned and an empty room, the ship with the 시설 관리(M) hint). Caught one layout bug the smokes could not — the narrow left column of the 함선 tab clipped the facility names to a single glyph (`발전기` → `벌`) and stacked the 효과 summary; fixed by letting `.hs-ship .hs-row` wrap, giving `.name` `flex: none`, shrinking the row buttons and making the left column's summary single-column.

- Phase 9 UI/UX 개선 pass (기업 거래대 · 함선 관리 방 목록 + 시설 제거 · 시설 관리 힌트/정렬/카메라 · 조종석 정리, 2026-09-07): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 194/194, build 1,917.07 kB JS / 170.68 kB CSS, smoke-quickslots 45/45, smoke-weapons 75/75, smoke-phase2 46/46, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 46/46, smoke-tactical 55/55, smoke-inventory-p6 63/63, **smoke-ship-rooms 67/67**, **smoke-housing 163/163**, **smoke-controls-hub 73/73**, smoke-progression 68/68, smoke-loadout 46/46, smoke-console 63/63, smoke-search 51/51, **smoke-ui-p6 68/68**, smoke-ui-p5 96/96, **smoke-meta 124/124**, smoke-training 94/94, smoke-uniques 71/71, **smoke-library 126/126**, smoke-ghost 72/72, smoke-enemy-delta 52/52, smoke-rogue-v2 46/46, smoke-raidflow 43/43, e2e-mp 103/103 — **0 failed in 4 min 36 s**, no re-run needed (the two long-standing flakes did not fire this time).
  - **Smoke updates the behaviour changes forced** (`scripts/`): `smoke-housing` (+11) gained a 시설 제거 block at the very end of the run — the built-in 작업실 refuses removal, a Lv.1 room facility refunds nothing, a Lv.2 사격장 lists its upgrade cost, and `removeRoomFacility` empties the room, moves every placed piece into furniture storage and lands the refund in the 함선 창고. It has to run **last**: removing the 사격장 changes `getPresetCount()` and the 용도 지정 picker's blocked count, which earlier DOM assertions depend on. `smoke-controls-hub` asserts the 함선 tab has **no** 용도 드롭다운, that room 1 offers no 제거 button, that all 12 시설/방 rows carry the shared thumbnail and that the 시설 관리 (M) button sits in its own sticky bottom bar. `smoke-ui-p6` rewrote the housing-hint block for the key-line-only bar plus the `.housing-exit` 종료 (Esc) chip. `smoke-library` now asserts the 도감 is **gone** from the 함선 tab (it lives on a 책장 only). `smoke-meta` follows the corp rewrite: `.corp-panel` instead of `.corp-banner`, sub-tabs `trade,contracts,quests`, the 거래 desk (stock rows with no per-row 구매 button, two trays, two embedded grids, 거래 성사 disabled on an empty basket), staging a stock row and settling the basket, and the 퀘스트 page's 납품 table + grids. `smoke-ship-rooms` moved its `hub_computer` anchor / desk-collider probes to the desk's new rear-wall position.
  - **Three bugs the smokes could not see, found in a browser pass** (nine screenshots at 1568 × 710): (1) the dashboard terminal rendered **blank** — the `TextPlane` sat 3 cm *behind* the tilted bezel; it is now placed along the bezel's rotated normal. (2) The 함선 컴퓨터's new rear-wall spot contained the port rear **rib**, which stood inside the desk and hid the 기업 네트워크 monitor; the rib was dropped (the desk fills that corner). (3) The 함선 tab's sticky bottom bar used a gradient-to-transparent background and the last room row bled through it; it is opaque now.
  - Also caught in the browser: with server-owned credits `meta.buy` resolves **asynchronously**, so each purchase's own toast landed after the basket summary and buried it. `CorpView.quietPurchases` now swallows exactly the late toasts a settle expects (a late *failure* still toasts). And the corrupt-save block of `smoke-meta` needed a 600 ms wait after the new 거래 성사 step — the pending debounced meta save was flushing on `pagehide` over the corrupt payload the test plants.

- Phase 9 UI/UX 개선 pass II (인게임 HUD 재배치 · 인게임 가방 = 함선 − 창고 · 전술 임플란트 → 캐릭터 탭 · 시설 증축 비용 + 가구 제작/창고 탭 · 기업 화면 그리드 · 훈련장 재접속 버그, 2026-09-07): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 194/194, build 1,926.31 kB JS / 176.59 kB CSS, smoke-quickslots 45/45, smoke-weapons 75/75, smoke-phase2 46/46, smoke-stratagems 70/70, smoke-phase4 46/46, smoke-phase3 32/32, smoke-tactical 55/55, smoke-inventory-p6 63/63, smoke-ship-rooms 67/67, **smoke-housing 171/171**, **smoke-controls-hub 75/75**, smoke-progression 68/68, smoke-loadout 46/46, smoke-console 63/63, smoke-search 51/51, smoke-ui-p6 68/68, **smoke-ui-p5 105/105**, **smoke-meta 125/125**, smoke-training 94/94, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 72/72, smoke-enemy-delta 52/52, smoke-raidflow 43/43, smoke-rogue-v2 46/46, e2e-mp 103/103 — 4 min 34 s on 4 GPU lanes, plus 1 min 49 s for the re-run. The final pass's three reds were the two long-standing load flakes (**smoke-rogue-v2** 40/46 rogue-grenade sequence, **smoke-training** 93/94 `course running: remaining 59.00 s`) — both green on the re-run and neither folder was touched — and one stale assertion of my own (see the browser pass below).
  - The only failure was the long-standing **smoke-uniques `empty tube reloads itself`** flake (recorded in the Phase 5 and Phase 8 entries). It is **fixed at the source** now rather than re-run: the check sampled `weapon:reloadStarted` 1.2 s after the shot, before the bazooka's auto-reload actually starts under a loaded lane. The sample moved after the existing `waitSim(3.5)` and now reads the magazine and the event from the same snapshot. Green on the re-run and no longer timing-dependent.
  - **Smoke updates the behaviour changes forced** (`scripts/`): `smoke-controls-hub` (+2 net) asserts the 전술 임플란트 slot is **gone** from the 장착 장비 column and drives the new `.cs-imp-card[data-id]` cards on the 캐릭터 tab instead (equip / unequip / 장착 중 label), plus the 함선 tab's non-scrolling panel, its scrolling 방 목록, the missing subtitle and the nine 시설 증축 buttons. `smoke-housing` (+4) covers the 시설 증축 gate and price (`purposeBlock` reports 발전기 first, `purposeCost('gym')` = 폐금속 8, the assignment consumes it), the refund now including that price at Lv.1, and the 시설 관리 side panel's 가구 제작 / 가구 창고 tabs + the cost chips that replaced the 용도 설명. Its material bookkeeping moved: the `room 4 → 헬스장` success case now runs **after** the generator reaches Lv.1, and the later sections top up before assigning a purpose. `smoke-library` pays for the 서재 before assigning it. `smoke-ui-p6`'s weapon-tag check asserts the class alone (no `·`, no calibre). `smoke-ui-p5` (+9) covers the whole HUD re-layout — no `.weightbar`, chat + squad inside `.hud-bl` above the vitals, the weapon panel's `implant-chip,qstrip,wslots` order, the missing 주무기 / 탄약 labels, the 빠른 사용 thumbnails all being `item-chip`s, the 임플란트 chip, the opaque white stamina fill, the squad rows sitting on top of the vitals and the 분대 계약 block staying hidden with an empty `getSquadContracts()`. `smoke-meta` follows the corp header rewrite (no title, four corp tabs in the header) and the stock **grid** (`.ct-cell` + one `item-chip[data-def-id]` per cell).
  - **Four bugs found in a browser pass** (thirteen screenshots at 1680 × 960 driving the ship Tab screens, the
    시설 관리 mode and a raid): (1) `hud/StratagemPanel` sat at a fixed `bottom: 176px`, which the two new right-hand
    strips now occupy — the 함선 호출 준비 line rendered *underneath* the 빠른 사용 thumbnails. It is a child of the
    weapon column now (topmost), so the column measures itself: strat 655–693, chip 703–737, qstrip 745–793,
    wslots 801–820 at 960 px tall, no overlap at any height. (2) The 시설 증축 popup's rows are `.hs-build-row`, not
    `.hs-row`, so they never picked up the shared `.name-line` flex rule and the `다음 업데이트` tag ran straight into
    the room name (`헬스장다음 업데이트`); the popup has its own name-line typography now. (3) The 판매 tray's hint
    broke mid-word — `word-break: keep-all`. (4) The embedded 기업 tab showed the balance twice (the Tab window's
    `CREDITS 500` pill and the corp header's `크레딧 500 cr`); the corp readout is hidden while `.is-embedded`, and the
    standalone overlay — which has no pill — keeps it.
  - **Not covered by a smoke**: the relayed `meta contract` broadcast itself. `getSquadContracts()` is asserted empty solo, and `e2e-mp` exercises the two-client path, but there is no fixture that feeds a synthetic `meta` message into a single client — `NetSystem` exposes no hook for that. Worth adding a `net.debugMessage(msg, from)` hook if more peer-to-peer meta traffic lands.

- 2026-09-07 안정화 pass (인벤토리 드래그 · UI 크기 고정 · 포인터 락 → ESC · 인게임 커서 반응성 · 기본 임플란트 · 하우징 커서 · 문틀 트림 · 레이드 접속 끊김 · 인게임 HUD 정리): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest **278/278**, build 2,032.57 kB JS / 200.63 kB CSS, smoke-quickslots 45/45, smoke-weapons 93/93, **smoke-phase2 49/49**, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-inventory-p6 63/63, smoke-ship-rooms 71/71, smoke-controls-hub 81/81, smoke-housing 173/173, smoke-progression 68/68, smoke-console 63/63, smoke-loadout 54/54, smoke-ui-p6 68/68, smoke-search 59/59, **smoke-ui-p5 132/132**, smoke-meta 130/130, smoke-training 109/109, smoke-uniques 71/71, smoke-library 126/126, **smoke-ghost 86/86**, smoke-enemy-delta 52/52, smoke-rogue-v2 52/52, smoke-planets 76/76, smoke-raidflow 43/43, smoke-social 116/116, smoke-ecology 83/83, e2e-mp 156/156 — **4 min 59 s** on 4 GPU lanes, **all green** (smoke-rogue-v2 included, for once).
  - **Two intermediate reds, both caused by this pass and both fixed**: (1) the new lost-lock watchdog paused the game in every script that stubs `requestPointerLock` **without** faking `document.pointerLockElement` — `smoke-tactical` 40/61 (melee / roll / dash / every gadget dead, because the `menu` blocker kills `isControlActive()`) and `e2e-mp` 151/156 (the early part of the run, before its own fake at line 419). Fixed by arming the watchdog only after a real lock was ever held (`sawPointerLock`), which is also the right product behaviour — a browser that refuses pointer lock outright must not get an unclosable pause menu. (2) `smoke-phase2` / `smoke-ui-p5` asserted the bottom-left 회복약 pill's key line, which this pass deletes; both now assert the pills are **absent** instead.
  - **Server contract change + its selftest** (`server/RelayServer.armGrace`): a member who dropped inside a running **raid** keeps their lobby slot for the whole mission (re-armed grace) instead of being reaped after 5 minutes. The first draft leaked two ways and the selftest caught both: a **훈련장** (`mode:'training'`) never expiring its last trainee (U4 hung waiting for `peer:left`), and a raid whose last in-mission member dropped never ending (I2 hung the same way). The shipped rule is `started && mode !== 'training' && me.inMission && another **connected** member is still inside`. The one affected case ("grace expiry while started") was rewritten: it now waits for `lobby:state` with the migrated host, asserts the slot is kept and no `peer:left` fires, then `lobby:reset` → the next grace tick reaps it (+2 checks, 276 → 278).
  - **Solo raid resume, hand-driven** (no smoke): a scratch Puppeteer script started a solo raid, let the 5 s autosave run, reloaded the tab and read the state back — seed / 목표 행성 / mission clock / stats / inventory / body position all restored, `scav.soloraid` cleared after the resume. Planting a save with `savedAt` 6 minutes old instead landed in `menu` with `복귀가 너무 늦었습니다 — 레이드 실패` and the file dropped. A first attempt at the stale case failed against my own `pagehide` flush (the reload re-saved a fresh stamp before unloading) — worth knowing if anyone tests this by hand.
  - **UI stability, measured** (no smoke): `.inv-layout`'s box was read before / after toggling `.is-dragging` and before / after finishing a container search. The hint↔drop-zone swap moved the window ~13 px up (now 0: one fixed-height `.inv-footer`, collapsed in `.is-hub`), and 감정 중 → 감정 완료 shrank the container panel 417 → 376 px and slid the whole window sideways (now 436 px in both, from a fixed-width `.inv-search-status`).
  - **Not covered by a smoke**: the corridor wainscot split, the housing cursor leaving the room, the weapon thumbnail box, the single-cell 빠른 사용 strip and the cursor acceleration / immediate sprite draw. The first two were checked from screenshots (`scripts/shots/`), the HUD ones from a full-frame raid capture; the cursor feel is not measurable headless (the smokes take the `mirror` path, never `moveBy`).

- 2026-09-07 UI/UX pass III (드래그 커서 중앙 + 시스템 커서 번쩍임 · 캐릭터 3열 + 임플란트 모달리스 picker · 제작 열 재배치 · 기업 화면을 Tab 창의 탭으로 통합 + 그리드화): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest 276/276, build 2,027.55 kB JS / 199.78 kB CSS, smoke-quickslots 45/45, smoke-weapons 93/93, smoke-phase2 49/49, smoke-phase3 32/32, smoke-stratagems 70/70, smoke-phase4 49/49, smoke-tactical 64/64, smoke-inventory-p6 63/63, smoke-ship-rooms 71/71, **smoke-controls-hub 81/81**, smoke-housing 173/173, **smoke-loadout 54/54**, smoke-console 63/63, smoke-progression 68/68, smoke-search 59/59, smoke-ui-p6 68/68, smoke-ui-p5 132/132, **smoke-meta 130/130**, smoke-uniques 71/71, smoke-training 109/109, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-raidflow 43/43, smoke-planets 76/76, smoke-social 116/116, smoke-ecology 83/83, e2e-mp 156/156 — **5 min 6 s** on 4 GPU lanes, 1 red.
  - The single red was the long-standing **smoke-rogue-v2** rogue-grenade / blast-falloff sequence (46/52, then 51/52 on a lone re-run with a *different* failing check). Confirmed not a regression: `git stash` → 52/52 on the clean tree, then 52/52 twice more with the changes applied and the script run alone. Nothing in this pass touches `src/enemies` or `src/player`. It is the same intermittent AI-timing block recorded in the Phase 8 / Phase 9 entries, and it is still worth driving deterministically.
  - **Smoke updates the behaviour changes forced** (`scripts/`): `smoke-controls-hub` (+6) drives the reshaped 캐릭터 tab — three `.cs-body > .cs-col` **scoped to `.inv-screen`**, the 장착 칸 opening `.cs-imp-pop-embed`, a card equipping and closing it, and the slot showing the pick. Every implant-card selector had to be scoped to the embedded picker: both shells' `SheetBody` exist at once (the standalone `CharacterSheet` is built at init and only hidden), so a bare `.cs-imp-card` now matches twelve cards, not six. `smoke-meta` follows the corp integration — `.inv-screen.corp-view` instead of `.menu.corp-menu`, the `'inventory'` blocker instead of `'corp'`, the rail / 기업 패널 + 세로 탭 order / footer-less layout, the locked stock grid keeping `display: grid` with a centred `신뢰도 Lv.1 부터 거래 가능`, `--ct-cell` and the trade grids' `--inv-cell` both 40 px, a 5-column 구매 tray, footprint `span n` stock cells, 귀중품 전부 담기 under the 판매 tray and Escape closing the window. `smoke-loadout`'s "the standalone corp overlay stays out of it" flipped: the 기업 tab **is** the corp screen now (`meta.isMenuOpen` true), it just still has no blocker of its own.
  - **Bug found while re-scoping the smokes** (`src/progression`): the standalone 캐릭터 시트 has **never** shown a single implant. `ProgressionSystem` is registered before `ImplantSystem` (`main.ts`), so `ctx.implants` is still null when `CharacterSheet` builds its `SheetBody`, and the cards were only ever built in the constructor. The old assertion passed because it counted `.cs-implants .cs-imp-card` across *both* shells and the embedded tab supplied all six. `refreshImplants` builds them lazily now.
  - **Four layout bugs found in a browser pass** (`scripts/shots-uiux.mjs`, new — nine screenshots at 1920 × 1080 driving the ship Tab screens, the picker, the corp desk and 제작 in both the ship and a raid): (1) the stacked right column kept the panels' own flex `order`, so 제작 mode put 함선 창고 **above** 가방 — the two orders are re-stated inside `.inv-col-right`. (2) The 전술 임플란트 hint under the slot repeated the slot's own empty-state sentence; it is the raid lock only now. (3) `.tg-block` defaulted to `flex-shrink: 1`, so 내 가방 was squeezed to two rows while 함선 창고 grew — the bag keeps its natural height and only the stash flexes. (4) The stash grid overran the bottom of the viewport in 제작 mode; its scroller is capped at `min(290px, 100vh − 620px)` there.
  - **Not covered by a smoke**: the drag-ghost centring and the `body.soft-cursor-on` cursor fix are both visual — `smoke-loadout` / `smoke-search` only assert that `.inv-root.is-dragging` / `.inv-ghost` exist. A check would need to read `getComputedStyle(tile).cursor` under a faked soft cursor and compare the ghost's `transform` against the pointer position.

- 2026-09-07 데스크톱 스탠드얼론 (Electron, 새 `electron/` 폴더 — `src/` · `server/` 무변경): `npm run typecheck` ok, `npm run typecheck:server` ok, 새 `npm run typecheck:app` (electron/ + server/) ok, `npm run net:selftest` **278/278**, `npm run build` 2,032.57 kB JS / 200.63 kB CSS, `node electron/build.mjs` → `dist-electron/main.js` 87 kB, `npx electron-builder --win portable` → `release/SCAVANGER-0.1.0-portable.exe` **96 MB** (asar 2.3 MB = `dist` + `dist-electron` + `ws` 만).
  - **손으로 돌린 실행 검증 (스모크 없음)**: 개발 실행(`npm run app`)과 **패키징된 portable exe** 양쪽을 `--remote-debugging-port` 로 띄우고 puppeteer-core 로 붙어 확인했다 — 창이 `http://127.0.0.1:8787/`(패키지판은 `--port=8791`)을 로드, `window.__game.ctx` 존재, WebGL 이 **실제 GPU** (`ANGLE (NVIDIA … RTX 4070 SUPER … Direct3D11)`), 타이틀에서 `함선 탑승` 클릭 → phase `menu` → `hub`, 그 시점 릴레이 `/health` 가 `clients: 1` · `profiles: 1` (프로필이 `%APPDATA%/SCAVANGER/relay-data/profiles.json` 에 새로 쓰였다), pageerror / console error **0**, 개인 함선 조종석 스크린샷 정상.
  - **왜 로컬 http 인가**: `file://` 로드는 `location.host` 가 비어 `NetSystem.defaultUrl()` 의 `ws://${location.host}/ws` 가 깨진다 → 빌드 타임 `VITE_WS_URL` 이나 preload 주입이 필요했을 것. 릴레이의 http 서버 위에 `dist/` 를 얹어(`electron/static.ts` 가 기존 `request` 리스너를 앞에서 가로채고 `/health` · 404 는 그대로 넘긴다) 같은 오리진에서 서빙하니 클라이언트 계약이 한 줄도 안 바뀌었다.
  - **번들 이유**: `server/` 는 erasable TS 라 `--experimental-strip-types` 없이는 Electron 메인에서 못 돈다 → **rolldown**(vite 의존성이라 새 패키지 0)으로 메인 + 릴레이를 한 파일로 묶고 `electron` / `ws` 만 external.
  - **자동화 없음**: 스모크 · e2e 는 전부 vite 를 보므로 데스크톱 셸을 검증하는 스크립트는 없다. 위 CDP 절차가 유일한 기록이다.

- 2026-09-07 총기 이름 정리 · 회복 소모품 개편 · 기본 지급품 (`src/items` · `src/inventory` · `src/weapons` · `src/player` · `src/ui` · `src/shared`): `npm run verify:all` → typecheck ok, typecheck-server ok, net-selftest **278/278**, build 2,040.12 kB JS / 200.61 kB CSS, smoke-quickslots 46/46, **smoke-weapons 102/102**, **smoke-phase2 53/53**, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63, smoke-controls-hub 85/85, smoke-housing 173/173, smoke-progression 68/68, smoke-console 63/63, **smoke-loadout 55/55**, smoke-ui-p6 68/68, smoke-search 59/59, **smoke-ui-p5 133/133**, smoke-meta 130/130, **smoke-training 110/110**, smoke-uniques 71/71, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 76/76, smoke-ecology 83/83, smoke-raidflow 42/42, smoke-social 116/116, e2e-mp 156/156 — **5 min 4 s** on 4 GPU lanes, 1 red.
  - The single red was the known **smoke-rogue-v2** grenade / blast-falloff timing block (51/52, then 49/52 with *different* checks failing on a re-run inside a busy lane, then **52/52** when run alone). Same intermittent AI-timing flake recorded in the Phase 8 / 9 and the UI/UX pass III entries; nothing in this package touches `src/enemies`.
  - **New checks written for the new behaviour**: `smoke-weapons` +9 — the 회복주사's own 2 s hold read off `ItemDef.heal.useTime`, `speedMultiplier ≤ 0.55` while a consumable is being used, and a whole 회복 스프레이 section (full 100 gauge in a quick slot, T tap into the hand, 0.6 s of LMB drains the gauge to 94 and heals the user, `heal:holdChanged {spray:true}` carrying the remaining gauge as `t`, and the slow released on release). `smoke-phase2` +4 (붕대 = 5 s from the def, `dur` on the event, the slow on and off). `smoke-ui-p5` +1 (the ring renders a spray channel as `스프레이 40 %`). `smoke-loadout` +1 (the 기본 지급품 inventory in the 창고: 총기 5종 · 여분 가방 3 · 방탄복 3 · 탄약 40세트 · 재세동기 2세트). `smoke-quickslots` (reset() now empties the kit instead of refilling it).
  - **Smoke updates the content change forced**: every weapon id in `scripts/` (`wpn_ar23` → `wpn_ar`, `wpn_p2` → `wpn_hg`, …) and every `stim` def id (→ `heal_bandage`, or `heal_syringe` where a 2 s hold was being timed); `smoke-weapons` / `smoke-training` / `smoke-search` / `smoke-controls-hub` equip a 돌격소총 out of the 창고 first, because the starter kit no longer has a 주무기; `smoke-housing` / `smoke-search` empty the 창고 after the reload so the 기본 지급품 does not skew their material / document counts; `smoke-inventory-p6`'s catalog drag aims at the first **free** stash cell.
  - **Two real bugs the new tests found.** (1) `src/inventory`: `onProfileLoaded` applied the starter kit whenever the server's loadout document was empty and the local one was **not** — with the kit now something the player loses and re-equips, that quietly wiped the bag a second or two after entering the ship (it also made `smoke-quickslots` flaky, since the relay's answer landed mid-test). It now only fires when the player has nothing anywhere. (2) `src/inventory/__selftest__.ts` hard-coded the grenade stack size in four checks (`stackMax` 4 → 3), which `runInventorySelfTest()` reported as 10 failures through `smoke-quickslots`' first assertion.
  - **Not covered by a smoke**: the 회복 스프레이's **ally** heal (it needs two clients — the local half is covered), the 제세동기's new 1 s hold (no downed squadmate in a solo smoke), and the new craft recipes (the craft panel is covered generically by `smoke-inventory-p6`, not per recipe).

- 2026-09-07 (기본 지급품 지급 조건 · 기본 작업실 폐지): `verify:all` 4분 54초 — 30개 중 28개 green,
  두 red 는 재실행에서 전부 통과했다. typecheck ok, typecheck-server ok, net-selftest 278/278,
  build 2,038.28 kB JS / 200.40 kB CSS, smoke-quickslots 46/46, smoke-weapons 103/103, smoke-phase2 53/53,
  smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 71/71,
  smoke-inventory-p6 63/63, smoke-controls-hub 95/95, **smoke-housing 176/176**, smoke-console 63/63,
  smoke-progression 68/68, smoke-search 59/59, smoke-ui-p6 68/68, **smoke-loadout 61/61**, smoke-ui-p5 133/133,
  smoke-meta 130/130, smoke-training 110/110, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 86/86,
  smoke-enemy-delta 52/52, smoke-planets 76/76, smoke-raidflow 42/42, smoke-social 116/116, smoke-ecology 83/83.
  Red 였다가 `--rerun-failed` 에서 통과: **smoke-rogue-v2 51/52 → 52/52** (전부터 알려진 로그 수류탄 · 폭발
  falloff 타이밍 flake) 와 **e2e-mp 12/14 → 156/156** (퀵매치가 앞선 스모크들이 남긴 로비를 잡았다 — 릴레이는
  실행 **처음**에만 재시작되므로 e2e 가 마지막에 도는 이 배치에서 가끔 나온다).
  - **새 검사 9개**: `smoke-loadout` +6 — 지급 플래그(`scav.grant`)가 없고 `scav.stash` 파일만 있는(빈) 프로필이
    **한 번** 지급받고 다음 실행에는 다시 받지 않는 것, 타이틀의 `새 캐릭터로 시작` → 확인 카드 → 초기화가
    캐릭터 저장과 세션 토큰을 버리고 오디오 · 키 설정은 남기며 새로 부팅한 창고에 기본 지급품이 들어 있는 것.
    `smoke-housing` +3 — 새 함선이 **빈 방 10개 · 가구 0**(작업실 시설도 벤치도 없음), 작업실이 아무 방에나
    지어지되 함선당 하나라는 것, 빈 방에는 `removeRoomFacility` 가 이유를 돌려준다는 것.
  - **작업실 전제를 쓰던 스모크 수정**: `smoke-housing` / `smoke-ship-rooms` / `smoke-weapons` 는 이제 방 1을
    작업실로 **직접 심고** 벤치를 가구 창고에 넣어 배치한다(증축 · 가구 제작이 재료를 먹으므로). 그 과정에서
    `smoke-weapons` 가 드러낸 것: 함선 상태를 **서버 프로필이 도착하기 전에** 직접 건드리면 welcome 의 `ship`
    문서(부팅 때 올라간 빈 상태)가 그대로 덮어써서 조용히 되돌아간다 — 시딩을 프로필 로드 뒤로 옮겼다(예전에는
    무료 작업실이 fresh state 에 들어 있어서 이 순서가 문제되지 않았다). `smoke-controls-hub` 는 방 1 행이
    `빈 방`이고 시설 증축 버튼이 10개인 것으로, `smoke-library` 는 메시지만 바꿨다.
  - **스모크 전반**: `scav.stash` 를 지워 새 프로필을 흉내내던 6개 스크립트가 `scav.grant` 도 함께 지운다
    (플래그가 남아 있으면 지급이 다시 일어나지 않는다).
  - `verify:all` 뒤 한 줄 고쳤다: 지급 직후 상태를 `pending` 으로 두는 조건이 "진짜 첫 실행"에 묶여 있어서,
    기존 프로필(= 이 버그의 당사자)이 지급받은 뒤 서버의 빈 창고 문서에 덮이면 재확인이 돌지 않았다 —
    이제 **지급했으면 항상 `pending`**, 이미 가진 경우에만 `done` 이다. 영향을 받는 스모크 8개를 다시 돌려
    전부 green (smoke-inventory-p6 63/63, smoke-housing 176/176, smoke-loadout 61/61, smoke-search 59/59,
    smoke-quickslots 46/46, smoke-weapons 103/103, smoke-controls-hub 95/95, smoke-phase2 53/53).
  - **스모크가 덮지 않는 것**: 서버 프로필이 이미 창고를 가진 채 새 브라우저로 들어오는 경우(플래그가 `done` 으로
    정리되고 지급이 없는 경로 — 릴레이에 실제 프로필을 만들어야 재현된다), 그리고 새 캐릭터 이후 **릴레이가
    새 아이디를 발급하는지**(토큰이 바뀌는 것까지만 확인한다).

- 2026-09-07 (마우스 커서 시스템 갈아엎기 — 락 = 시점 / 언락 = 진짜 커서): `verify:all` **전부 통과**, 6분 45초.
  typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,037.30 kB JS / 200.20 kB CSS, smoke-quickslots
  46/46, smoke-weapons 103/103, smoke-phase2 53/53, smoke-phase3 32/32, smoke-stratagems 70/70, smoke-phase4 49/49,
  smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63, smoke-housing 173/173, smoke-console 63/63,
  smoke-progression 68/68, smoke-ui-p6 68/68, smoke-search 59/59, smoke-controls-hub 95/95, smoke-loadout 55/55,
  smoke-ui-p5 133/133, smoke-meta 130/130, smoke-training 110/110, smoke-uniques 71/71, smoke-ghost 86/86,
  smoke-library 126/126, smoke-raidflow 42/42, smoke-rogue-v2 52/52, smoke-enemy-delta 52/52, smoke-planets 76/76,
  smoke-ecology 83/83, smoke-social 116/116, e2e-mp 156/156.
  New checks: **smoke-controls-hub 85 → 95** (the terminal releases the lock and takes 커서 모드, `body.cursor-on` /
  `.cursor-ui` with no sprite, the generated `#game-cursor-style` blanket arrow + mirrored affordances, a cursor-mode
  click never reaching gameplay input, the relock on close, Alt free-cursor on / off without a pause, and a lost lock
  that no longer forces the menu; the two `moveBy` linearity checks are gone with the virtual cursor),
  **smoke-ui-p5 133** (same count — the sprite assertions became cursor-art / `uiX-uiY` ones) and **smoke-weapons
  102 → 103** (V rolls instead of swapping; 3 draws the 보조무기).
  Also verified by hand in a real browser before the suite (a throwaway puppeteer script, 16/16): the art is installed
  and mirrors 41 selectors, walking the ship keeps the lock, Tab releases it and shows the cursor, a click in cursor
  mode never reaches gameplay, Escape closes and re-locks at once with no pause menu, a lock lost for a second does
  not pause, Alt toggles the free cursor, and the pause menu is a normal cursor owner that gives the mouse straight
  back on Escape. That script was deleted afterwards — its assertions live in smoke-controls-hub now.

- 2026-09-07 (좌클릭으로 카메라 복귀): `verify:all` 5분 27초 — typecheck ok, typecheck-server ok, net-selftest
  278/278, build 2,038.74 kB JS / 200.40 kB CSS, smoke-quickslots 46/46, smoke-weapons 103/103, smoke-phase2 53/53,
  smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-tactical 63/64, smoke-ship-rooms 71/71,
  smoke-inventory-p6 63/63, smoke-controls-hub 99/99, smoke-housing 176/176, smoke-console 63/63,
  smoke-progression 68/68, smoke-ui-p6 68/68, smoke-search 59/59, smoke-loadout 61/61, smoke-ui-p5 133/133,
  smoke-meta 130/130, smoke-training 110/110, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 86/86,
  smoke-enemy-delta 52/52, smoke-raidflow 42/42, smoke-planets 76/76, smoke-social 116/116, smoke-ecology 83/83,
  smoke-rogue-v2 46/52, e2e-mp 156/156.
  New checks: **smoke-controls-hub 95 → 99** — Alt 커서가 캔버스 좌클릭으로 닫히고 락이 돌아온다(2), 락이 없는
  상태의 캔버스 좌클릭이 락을 즉시 다시 요청하고(1) 그 누름이 삼켜진다(1).
  Two reds, neither from this change: **smoke-rogue-v2** is the known 로그 수류탄 타이밍 flake (46/52, then 51/52 on
  the rerun with a different failing line), and **smoke-tactical 63/64** (`domeShield` false in `throwable gadgets
  used`) reproduces **on a clean tree** — a pre-existing red on this branch, unrelated to the cursor.

- 2026-09-07 (smoke-tactical `domeShield` red 해소): `node scripts/verify.mjs --only smoke-tactical` → **64/64**
  (typecheck ok, typecheck-server ok, net-selftest 278/278). 게임 버그가 아니라 스모크의 자충수였다 — 던지기
  가젯 루프가 화염수류탄을 첫 번째로 던지는데, 그 화염지대는 설계대로 피아 구분이 없고 서 있는 플레이어 몇 m
  앞에 깔린다. 지금 스타터 장비로는 그 화상이 루프 중간에 플레이어를 전투불능으로 만들고, `GadgetSystem.use` 는
  전투불능 플레이어를 `deny(null)` 로 **조용히** 거부하므로(토스트도 로그도 없다) 네 번째 `domeShield` 만
  false 로 보였다. 계측(`deny` / `consumeItem` 을 런타임에 감싸 확인)으로 `downed:true` 를 잡고, 루프 전에
  `respawnAt` 로 체력을 채운 뒤 화염수류탄을 **마지막**으로 옮겼다. 루프는 이제 매 던지기의 `hp` · `downed` 도
  함께 기록한다(다음에 같은 일이 생기면 실패 줄에 바로 보이도록).

- 2026-09-07 (smoke-rogue-v2 수류탄 flake 제거): `verify:all` **전부 통과**, 4분 56초 — typecheck ok,
  typecheck-server ok, net-selftest 278/278, build 2,038.74 kB JS / 200.40 kB CSS, smoke-quickslots 46/46,
  smoke-weapons 103/103, smoke-phase2 53/53, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49,
  smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63, smoke-controls-hub 99/99,
  smoke-housing 176/176, smoke-console 63/63, smoke-progression 68/68, smoke-ui-p6 68/68, smoke-loadout 61/61,
  smoke-search 59/59, smoke-ui-p5 133/133, smoke-meta 130/130, smoke-training 110/110, smoke-uniques 71/71,
  smoke-library 126/126, smoke-ghost 86/86, smoke-rogue-v2 52/52, smoke-enemy-delta 52/52, smoke-ecology 83/83,
  smoke-planets 76/76, smoke-social 116/116, smoke-raidflow 42/42, e2e-mp 156/156.
  이 브랜치에서 처음으로 **red 0**. 수류탄 구간의 원인 두 가지: (1) 로그가 마지막 목격 지점으로 걸어가
  `GRENADE_MIN_DIST`(6 m) 안으로 들어오거나 사거리를 벗어나 30초 안에 던지지 않는 경우(그러면 이후 6개 검사가
  연쇄로 실패한다 — 실제 46/52 실행이 그것이었다), (2) 던지기가 ±1 m 산포 + 한 번 튕김 + 구름이라 폭발 지점이
  복불복인 경우(피해 판정은 가슴까지의 **3D** 거리라, 바위 위에 얹히면 수평 2.6 m 여도 반경 밖이다; 실패 샘플에
  9.06 m). 수정: 와인드업 전까지 로그를 제자리에 고정하고, 플레이어 자리를 **평평하고 시야가 트인** 곳으로 고르며,
  최대 3번까지 던져 **실제로 닿은 첫 폭발**로 피해를 검증한다(빗나간 시도는 실패 메시지에 남는다). 고친 뒤
  단독 8연속 52/52 — 그중 한 번은 첫 투척이 6.09 m 로 빗나가 재시도 경로를 실제로 탔다.


## 2026-09-08 — 격납고 코드 리뷰 수정 5건 (걸어 들어갈 수 없던 데크 포함)

`/code-review high` 가 5건을 잡았고 전부 고쳤다. **첫 번째는 기능 자체가 죽어 있었다** — 그런데 스모크는
55/55 로 초록이었다. 그 대비가 이 항목의 요점이다.

`Hangar` 의 walkable room 이 벽 **바깥쪽 면**(7.35)에서 시작해 함선 방(z ≤ 7.0)과 0.35 m 떨어져 있었다.
`BoxInteriorCollider.resolveCollision` 은 두 방이 **공유하는** 모서리만 넘게 해 주므로 문 앞에서
`z = 6.55` 에 영원히 붙잡힌다 — 정박 구역(z ≈ 16)에는 평범한 플레이로는 **절대 닿을 수 없었다**.
스모크가 놓친 이유가 정확히 하나 있다: 모든 위치를 `teleport()` 로 옮겼고, "열린 공유 모서리" 단언조차
이미 7.35 에 서 있는 원이 밀리지 않는다는 것만 봤다 — 그건 **blocker 가 없다는 증명이지 union 이 이어졌다는
증명이 아니다.** 스모크에 `walkNorth()` 를 넣어 0.1 m 씩 `resolveCollision` 을 통과해 **걸어서** 데크로
들어가고(z 15.2), 문 옆으로는 벽에 막히고(z 5.96), 다시 걸어 나오는 것까지 본다 (55 → **58**).

나머지 넷: `announceShip` 이 베이를 드나들 때마다 분대 전원에게 수 kB 재방송을 시키고 그 홍수를 막는
쿨다운까지 지우던 것(→ 없는 문서만 요청), 셀 좌표를 0…63 으로 클램프해 이상한 문서가 방문자 함선 어디에나
— 유일한 출구인 에어락 위에도 — **단단한 콜라이더**를 놓을 수 있던 것(→ 방 격자 8 × 8 로), 64 kB 를 넘는
`ship state` 를 릴레이가 에러 없이 버리는데 보낸 쪽은 디바운스를 올려 놓아 영영 재전송하지 않던 것
(→ `SHIP_VISIT_MAX_FURNITURE` 를 `shared/constants.ts` 로 올려 양쪽이 같은 수를 쓴다), 방문 입장 위치가
출구 반경보다 가까워 들어서자마자 `격납고로 나가기` 가 떠 있던 것(→ 3.0 m 입장 / 반경 2.2 m).

`npm run verify:all` — `smoke-hangar` **58/58**, `e2e-mp` 156/156, 나머지 전부 통과.

**`smoke-phase3` 는 이 머신에서 간헐적으로 red 다 — 이 작업과 무관하다.** 근거 셋: ① 변경분을 stash 한
깨끗한 트리에서도 4번 중 1번 실패했고, ② 임무 중 씬에 격납고 오브젝트가 0개이고 시뮬레이션이 실시간으로
돈다는 것을 애드혹 probe 로 확인했고(10.0 sim-s / 10 wall-s, `Hangar` 0 · 함선 0 · `hub_*` 상호작용 0),
③ **혼자 돌리면 32/32 로 통과한다**. 실패 지점이 매번 달랐고(`supply landed` / `laser ignited` / `laser
ended` / 플레이어 사망) 소요 시간이 47 s ↔ 272 s 로 널뛰었다 — 4레인 병렬 + 다른 세션의 dev 서버 + 남아 있는
헤드리스 크롬 45개가 붙은 GPU 경합이다. 240 s 타임아웃이 sim time 진행에 걸려 있어 프레임이 느려지면 그대로
넘어간다.

## 2026-09-08 — 공용 함선 격납고 (개인 함선 정박 · 방문 · 동석)

`npm run verify:all` (`src/shared` 를 건드렸으므로 전체) — **전부 통과, 6분 22초.**

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,180.07 kB JS / 219.41 kB CSS,
smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-tactical 87/87, smoke-controls-hub 121/121,
smoke-inventory-p6 104/104, smoke-housing 200/200, smoke-console 63/63, smoke-progression 123/123,
smoke-loadout 61/61, smoke-search 61/61, smoke-ui-p6 89/89, smoke-ui-p5 133/133, smoke-resume-gate 48/48,
smoke-enemy-alert 42/42, smoke-uniques 71/71, smoke-meta 173/173, smoke-training 112/112, smoke-library 126/126,
smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-raidflow 48/48, smoke-rogue-v2 52/52, smoke-ecology 85/85,
smoke-social 136/136, smoke-planets 86/86, smoke-tutorial 52/52, **smoke-hangar 55/55**, e2e-mp 156/156

**새 스모크** `scripts/smoke-hangar.mjs` (클라이언트 2대 + 릴레이, 55개). 이 기능은 혼자서는 검증이 안 된다 —
"남의 개인 함선"도 "같은 함선끼리만 보인다"도 상대가 있어야 성립하므로 `e2e-multiplayer.mjs` 의 2브라우저 골격을
그대로 빌렸다. 검사하는 것: 자동문(멀면 닫히고 다가가면 열린다 · 문턱에 blocker 가 없다) · 격납고 데크가 걸어
다닐 수 있고 콜라이더 bounds 가 커졌다 · 외부 게이트는 막혀 있다 · 정박 구역 4개 중 참여 인원만큼만 함선이
선다 · 프롬프트 3종 · `ship state` 가 요청 없이 도착하고 내 방송도 스누핑된다 · 방문(로비 유지 · 가구 1개가
와이어에서 그려지되 상호작용 0 · 콘솔 0 · 포드 0 · 시설 관리 거절 · 에어락 출구) · `hs` 동석 규칙(공유 데크에
있으면 함선 안 아바타가 안 보이고, 같은 함선에 들어가면 다시 보인다) · 들어간 구역 앞으로 복귀 · 함선 안에서
파티를 떠나면 솔로 개인 함선으로 도킹 해제.

**비공개 로비를 코드로 잡는다.** 처음엔 `quickMatch()` 를 썼는데, 릴레이가 재접속 유예 동안 들고 있던 **이전
실행의 공개 로비**에 두 클라이언트가 끌려 들어가 인원이 3–4명이 되고 정박 구역 수 단언이 전부 어긋났다.
`createLobby()` + `joinLobby(code)` 로 바꾸고 끝에서 로비를 떠난다.

**스모크가 잡은 실제 누락 1건** — 방문 중인 함선에 `hub_terminal` · `hub_computer` 가 여전히 등록돼 있었다.
`stationUsable()` 이 false 라 프롬프트도 안 뜨고 눌리지도 않았으므로 기능상으로는 이미 읽기 전용이었지만,
쓸 수 없는 상호작용이 레지스트리에 남아 `findBest` 와 다투는 것은 그냥 쓰레기다 — 방문이면 아예 만들지 않는다.

**시각 확인** (스크립트는 저장소에 넣지 않음). 첫 판의 격납고는 **까맸다**: 8.2 m 천장에 포인트 라이트 6개
(intensity 90)는 공유 함선 데크의 1/3 밝기를 3.6배 넓은 바닥에 뿌리는 것이었다 — `PointLight` 는 거리 제곱으로
감쇠하므로 높이가 곧 밝기다. 5.6 m 갠트리 높이에 9개(130 / distance 30)로 옮겨서야 정비고처럼 읽혔다.
같이 고친 것: 40 m 짜리 통 `stripAmber` 바닥선과 18 × 7 m 게이트 외곽선이 블룸을 먹고 화면을 호박색 판으로
만들던 것(점선 + **비발광** 금색 `trim` 으로 교체 — 발광은 짧은 악센트에만), 정박 구역 표지판이 거꾸로 읽히던
것(`TextPlane` 은 +Z 를 보므로 통로 쪽인 −Z 로 돌렸다), 개인 함선이 바닥 위 1.45 m 에 떠 있던 것(착륙 다리 3개 +
뒤쪽 램프), 그리고 격납고 앞벽이 공유 함선 뒷벽과 **같은 평면에서 z-fighting** 하던 것(앞벽은 함선 폭만큼
비우고 그 위 4.2 → 9 m 띠만 그린다).

## 2026-09-08 — UI/UX 정리 2차 13건 (교체 링 · 상자 빛기둥 · 저격 탄도 · 분해 · 커뮤니티 · ESC · 즉사)

`npm run verify` (`src/shared` 를 건드리지 않아 폴더 매핑으로 충분 — inventory · meta · player · ui · weapons · world)
— **전부 통과, 5분 15초** (첫 실행은 8 red, 전부 아래의 스모크 갱신으로 해소).

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, smoke-quickslots 46/46,
smoke-phase2 55/55, smoke-weapons 137/137, smoke-phase3 32/32, smoke-stratagems 70/70, smoke-inventory-p6 104/104,
smoke-phase4 49/49, smoke-tactical 87/87, smoke-controls-hub 121/121, smoke-console 63/63, smoke-housing 200/200,
smoke-search 61/61, smoke-ui-p6 89/89, smoke-loadout 61/61, smoke-ui-p5 133/133, smoke-resume-gate 48/48,
smoke-meta 173/173, smoke-enemy-alert 42/42, smoke-training 112/112, smoke-uniques 71/71, smoke-library 126/126,
smoke-ghost 86/86, smoke-planets 86/86, smoke-social 136/136, smoke-raidflow 48/48, smoke-ecology 85/85,
smoke-tutorial 52/52, e2e-mp 156/156.

**새 검사 12건**: 분해 버튼이 곧 게이지이고 아래에 두 번째 바도 `1회 분해 · n s` 힌트도 없다 · 가방이 꽉 차면
버튼이 **미리** 잠기고 라벨이 `가방에 공간이 없습니다` 로 바뀐다(칸이 생기면 되돌아온다) · 잠긴 거래 탭이
`disabled` 가 아니라 클릭을 받고 필요한 신뢰도를 토스트로 낸다(페이지는 안 바뀐다) · 커뮤니티 프레임이 목록을
비워도 크기가 그대로다 · 친구 3.5줄(196 px) / 최근 5.5줄(308 px) 고정 상자 · 분대원이 1×4 · 일시정지 메뉴가
제목 없는 버튼 열이고 `게임으로 돌아가기 (Tab)` … `게임 종료` 6개 · 함선에서는 `함선으로 귀환` 과 `파티 떠나기`
가 숨는다 · `타이틀로` 가 경고 팝업을 먼저 띄우고 취소는 아무것도 하지 않는다 · 1인 분대 치명타가 `player:downed`
없이 `player:died` 하나만 낸다.

**첫 실행의 red 8건** — 회귀가 아니라 **단언이 옛 규칙을 보고 있던 것**이고, 대부분 하나의 변경(1인 분대 즉사)에서
갈라져 나왔다.
- `smoke-phase2` / `smoke-weapons` / `smoke-ui-p6` / `smoke-raidflow`: `takeDamage(치명타) → 전투불능` 을 전제하던
  검사 전부. 전투불능 상태 자체는 그대로 있으므로 `ctx.player.enterDowned()` 로 만든다 — 검사 대상(출혈 · 포기
  홀드 · 다운 HUD · 재기동 회로)은 다운 **상태**이지 그 상태로 가는 경로가 아니다. 즉사 규칙 자체는
  `smoke-phase2` 맨 끝에 새 임무를 하나 띄워 확인한다 (죽는 게 목적이라 다른 검사 뒤에 둬야 한다).
- `smoke-phase3`: 스트라타젬 두 절의 `timeScale 4` 긴 대기(보급 투하 240 s · 레이저 300 s) 중에 플레이어가
  적에게 죽으면 페이즈가 `dead` 로 가고 스트라타젬 업데이트가 멈춰 `stratagem:landed` / `ended` 가 영영 안 온다.
  전에는 전투불능으로 100 초를 버텨 그 사이 대기가 끝났다. 적이 필요한 항공 폭탄 절 **다음**부터 필드를 비운다.
- `smoke-meta`: 잠긴 탭의 `disabled` 단언.
- `smoke-social`: 일시정지 메뉴의 제목 · 버튼 목록.
- `smoke-inventory-p6`: 새로 쓴 "가방이 꽉 찼을 때" 검사가 **내 실수**였다 — ⓐ `mat_scrap` 을 1개씩 400번 넣어
  스택 5칸만 먹었고, ⓑ 칸을 채워도 앞 절이 만든 **화약 부분 스택**이 남아 `bag.canAbsorb(화약)` 이 계속 true 였다.
  스택 최대치로 채우고 화약을 먼저 비운다.

두 자리는 **CSS 쪽 함정**이었다 (스모크가 잡아 줬다): `.sc-grid.fixed` 의 `height` 는 부모가
`display:flex; min-height:0` 이면 그냥 줄어든다 — `flex: none` 이 있어야 고정이다. 그리고 `display:none` 인
요소의 `getComputedStyle(...).gridTemplateColumns` 는 사용값이 아니라 `repeat(var(--cols), …)` 문자열이라
칸 수를 세면 3이 나온다 — `--cols` 를 직접 읽는다.

**애드혹 시각 확인** (스크립트는 저장소에 넣지 않음): 무기 교체 시 크로스헤어 링의 `무기 교체` 라벨과 색,
레이드에서 4티어 상자를 연 뒤 빛기둥이 사라지는지, 스코프로 300 m 표적을 맞췄을 때 예광탄이 조준선 위를
지나는지, 공유 함선에서 ESC → 파티 떠나기 → 개인 함선 복귀.

## 2026-09-08 — 폐금속 공급 (고철 더미 · 기계 부품 · 고물 분해)

`npm run verify:all` (`src/shared/gear.ts` · `types.ts` · `events.ts` · `constants.ts` 를 건드렸으므로 전체)
— **전부 통과, 5분 38초. 첫 실행부터 red 없음** (중간 `npm run verify` 에서 잡은 스모크 2건은 아래 참조).

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,159.30 kB JS / 218.85 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-controls-hub 121/121, smoke-tactical 87/87,
smoke-inventory-p6 100/100, smoke-housing 200/200, smoke-console 63/63, smoke-progression 123/123,
smoke-loadout 61/61, smoke-ui-p6 89/89, smoke-search 61/61, smoke-ui-p5 133/133, smoke-resume-gate 48/48,
smoke-enemy-alert 42/42, smoke-uniques 71/71, smoke-meta 171/171, smoke-training 112/112, smoke-rogue-v2 52/52,
smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52, smoke-raidflow 48/48, smoke-planets 86/86,
smoke-ecology 85/85, smoke-social 130/130, smoke-tutorial 52/52, e2e-mp 156/156.

**새 검사 11건** (`smoke-inventory-p6` +7, `smoke-tactical` +2, `smoke-ecology` +2):
기계 부품 분해가 결과물 칩을 **2개** 미리 보여주고 폐금속 3 + 전력 케이블 1 을 한 번에 낸다 ·
똑같은 권총 두 정 중 **클릭한 쪽만** 갈리고 남은 한 정은 그대로다 · 소켓의 총구 제동기가 분해 전에 가방으로
돌아온다 · `break_armor_1` 이 폐금속 3 · `station: 'field'` · 채집 노드가 약초와 고철 더미 두 갈래로 나뉘고
고철은 `mat_scrap` 만 낸다 · 고철 더미 수가 행성과 무관하게 `SALVAGE_NODES_PER_MISSION` 이고 훈련장에는 없다.

**중간 `npm run verify` 에서 red 였던 스모크 2건** — 둘 다 회귀가 아니라 **단언이 옛 세계를 보고 있던 것**이다.
`getGatherNodes()` 가 이제 약초 + 고철 더미를 함께 내주므로 `smoke-ecology` 의 생태계 수치(노드 수 · 허브 id
집합)와 `smoke-tactical` 의 "모든 채집물은 `herb_` 로 시작한다"가 `mat_scrap` 을 보고 넘어졌다. 두 스모크 모두
`kind !== 'salvage'` 로 약초만 세도록 옮기고, 고철 쪽 단언을 따로 추가했다.

새 스모크 블록을 짜다 만난 것 하나: 처음에는 돌격소총 두 정(4×2)을 넣으려고 가방을 통째로 비웠는데, 뒤쪽
`takeFromCatalog on a mission` 이 시작 소지품의 수류탄 3개를 기준선으로 삼고 있어 그게 red 가 됐다.
권총 두 정(2×1)으로 바꿔 시작 소지품을 건드리지 않는다 — 스모크는 앞 절이 남긴 가방 상태를 공유한다.

**애드혹 시각 확인** (스크립트는 저장소에 넣지 않음): 레이드에서 고철 더미의 실루엣(찌그러진 화물통 + 휜 강판 +
파이프, 호박색 절단 표식)이 40 m 에서 식물과 구분되는지, `폐금속 해체 (E)` 프롬프트와 3초 홀드,
지도(M)의 호박색 사각 표식, 분해 다이얼로그의 결과물 칩 2개 배치.

## 2026-09-08 — UI/UX 정리 12건 (커서 · Esc · 임플란트 · 기업 화면 · 환급 · 훈련장)

`npm run verify:all` (`src/shared/Input.ts` 를 건드렸으므로 전체) — **전부 통과, 6분 0초.**

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,155.07 kB JS / 218.83 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-tactical 85/85, smoke-controls-hub 121/121,
smoke-inventory-p6 93/93, smoke-housing 200/200, smoke-console 63/63, smoke-progression 123/123,
smoke-loadout 61/61, smoke-search 61/61, smoke-ui-p6 89/89, smoke-ui-p5 133/133, smoke-resume-gate 48/48,
smoke-enemy-alert 42/42, smoke-uniques 71/71, smoke-meta 171/171, smoke-rogue-v2 52/52, smoke-training 112/112,
smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-social 130/130,
smoke-raidflow 48/48, smoke-ecology 83/83, smoke-tutorial 52/52, e2e-mp 156/156.

**첫 실행의 red 7건과 그 정체** — 6건은 스모크가 **바뀐 UI 를 옛 모습으로 단언**하고 있던 것이라 단언을 옮겼다
(`/seed` 안내 줄 2건, 기업 화면 4건, 임플란트 세로 줄 3건, 일시정지 좌측 정렬 1건). 진짜 회귀는 둘이었다.

- `smoke-controls-hub` 11건 — `Input` 의 재락 미루기 첫 판(`selfExit` 만 보던 것)이 **헤드리스 스텁**을 물었다.
  스텁은 `exitPointerLock()` 에서 `pointerLockElement` 를 곧바로 비우고 `pointerlockchange` 를 **쏘지 않으므로**
  `selfExit` 이 영영 true 로 남아 재락이 전부 보류됐고, 락이 없으니 Alt 커서 · Q 임플란트 검사가 줄줄이 red 였다.
  판정을 `selfExit && isPointerLocked` 로 좁혀(= 요소가 아직 살아 있을 때만 미룬다) 실제 브라우저의 경합만 잡는다.
- `smoke-training` 1건 — 강하를 없애 `'playing'` 이 `world:ready` 와 같은 tick 에 오게 되자 `HudSystem` 의
  기본 목표 줄이 방금 쓴 훈련 카운터를 덮었다. 훈련장의 목표 줄은 `world/TrainingArena.announce()` 가 갖는 것이
  맞으므로 `HudSystem` 은 훈련 ref 가 없는 월드에서만 채운다.

재실행에서 `smoke-tutorial` 이 한 번 red 였던 것도 같은 부류의 **스모크 쪽 문제**다: `manage` 단계부터
스포트라이트가 이미 떠 있으므로 "보이는가"로 기다리면 발전기로 옮겨 붙기 전에 통과해 버린다 — 말풍선 내용을
보고 기다리도록 고쳤다.

**새 검사 6건**: 빈 방으로 → 확인 팝업(환급 칩) → 방은 빈 방 · 폐금속/케이블/합금/회로가 증축 전 수량으로
정확히 복귀 (smoke-housing 2) · Escape 가 시설 관리를 빠져나오고 일시정지 메뉴를 띄우지 않는다
(smoke-ship-rooms 1) · 훈련장 진입이 강하 없이 `'playing'` 이고 계약 패널이 없다 (smoke-training 2) ·
`manage` 포커싱이 `.ship-hint` 사각형에 붙는다 (smoke-tutorial 1). 바뀐 단언 6건: 터미널 `/seed` 줄 없음 ·
`.seed-hint` 없음 · 기업 화면 상단/좌측 구조 + 54 px 칸 · 임플란트 정사각 셀 · 일시정지 버튼이 화면 중앙을 문다.

**애드혹 시각 확인** (스크립트는 저장소에 넣지 않음): 기업 거래 · 퀘스트 화면(상단 기업 줄, 좌측 페이지 탭,
중앙 납품/거래칸, 우측 인벤토리 크기 가방+창고), 인벤토리 임플란트 칸(설명 없는 전술 슬롯 + 정사각 썸네일 줄 +
hover 카드의 장착칸 · 능력치 줄), 일시정지 메뉴(화면 한가운데 점이 `게임으로 돌아가기` 안, 중앙보다 오른쪽),
시설 관리의 `빈 방으로` 확인 팝업(돌려받을 재료 칩 2개).

## 2026-09-08 — 튜토리얼: 가구 제작 → 가구 창고 → 배치 (진행 불가 수정)

`npm run verify` (`src/shared/tutorial.ts` 를 건드렸으므로 러너가 전체를 골랐다) — **red 1건**(smoke-ui-p6,
4레인 병렬 부하 flake) 외 전부 통과, 5분 36초. `smoke-ui-p6` 단독 재실행 **89/89**.

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, smoke-quickslots 46/46,
smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49,
smoke-ship-rooms 71/71, smoke-tactical 85/85, smoke-controls-hub 121/121, smoke-inventory-p6 93/93,
smoke-console 63/63, smoke-housing 197/197, smoke-progression 123/123, smoke-loadout 61/61, smoke-search 61/61,
smoke-ui-p6 0/1 → **89/89 단독**, smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-enemy-alert 42/42,
smoke-uniques 71/71, smoke-meta 170/170, smoke-rogue-v2 52/52, smoke-training 110/110, smoke-library 126/126,
smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 83/83, smoke-raidflow 48/48,
smoke-social 130/130, **smoke-tutorial 51/51** (46 → 51), e2e-mp 156/156.

`smoke-ui-p6` 의 실패는 `timeout waiting for playing` 한 줄뿐이다 — 미션 시작을 기다리다 끊긴 것으로,
이 변경이 닿지 않는 자리(튜토리얼은 `smoke-ui-p6` 에서 `done` 으로 심어 놓고 시작한다)이고 단독 실행은 89/89 다.
`smoke-ship-rooms` 에서 이미 기록된 것과 같은 부류의 4레인 부하 flake로 본다.

새 검사 5건 (`smoke-tutorial` 46 → 51): 제작만으로는 배치가 끝나지 않는다(창고에 1, 놓인 것 0) ·
`data-tab="store"` 탭 버튼을 집을 수 있다 · 그 탭에 `data-def-id` 작업대 카드가 있다 ·
카드를 클릭하면 `selectedFurniture` 가 서고 **스포트라이트가 접힌다**(바닥을 클릭할 수 있어야 한다) ·
목표 부제가 "바닥에 내려놓기"로 바뀐다.

## 2026-09-08 — 튜토리얼 UI/UX 수정 4건 (커서 · 발전기 단계 · 숨김 · 포커싱 연출)

`npm run verify:all` — **red 1건**(e2e-mp 153/154, 자가 유발 flake) 외 전부 통과, 5분 41초.
`src/shared/Input.ts` 를 건드렸으므로 전체를 돌렸다.

```
docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278,
build 2,152.37 kB JS / 218.12 kB CSS, smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137,
smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase4 49/49, smoke-ship-rooms 71/71,
smoke-inventory-p6 93/93, smoke-controls-hub 121/121, smoke-tactical 85/85, smoke-console 63/63,
smoke-housing 197/197, smoke-progression 123/123, smoke-loadout 61/61, smoke-ui-p6 89/89,
smoke-search 61/61, smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-enemy-alert 42/42,
smoke-uniques 71/71, smoke-meta 170/170, smoke-rogue-v2 52/52, smoke-library 126/126,
smoke-training 110/110, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86,
smoke-social 130/130, smoke-tutorial 46/46, smoke-ecology 83/83, smoke-raidflow 48/48,
e2e-mp 153/154 → 재실행 156/156
```

**e2e-mp 153/154 는 내가 만든 flake다.** `timeout waiting for B back in personal ship` 이 떴을 때 두 클라이언트의
상태 덤프가 `phase: 'menu'` · `time: 9.7 s` · `net: 'offline'` 로 **똑같이** 찍혀 있었다 — 테스트 중간에 두 페이지가
함께 처음부터 다시 뜬 것이다. 원인은 코드가 아니라 러너를 돌리는 방식이었다: `verify` 가 이미 떠 있던 내 dev
서버를 재사용했고(`vite already up`), 그 e2e 가 도는 동안 내가 `src/tutorial/parts/Spotlight.ts` 의 주석 위치를
고쳤다. **vite HMR 이 두 클라이언트를 통째로 리로드했다.** `--rerun-failed` 로 편집 없이 다시 돌리니 **156/156**.
교훈은 하나 — 검증이 도는 동안에는 `src/` 를 건드리지 않는다 (러너가 자기 vite 를 띄우지 않고 재사용할 때는 특히).

**`smoke-tutorial` 39 → 46 (+7)**: 시작 카드가 뜬 채 커서가 살아 있는가(`body.cursor-on`), 단계 수 15,
`hides(gate, id)` 의 항목별 판정, 발전기 행 존재, **용도 목록에 작업실 한 줄만 남는가**, 말풍선이 발전기를
가리키는가, 포커싱 중 목표 패널이 딤 위로 올라가는가(`.tut-panel.is-lifted`). 스포트라이트가 대상을 다시
잡는 데 `RETARGET_INTERVAL`(0.25 s)이 걸리므로 단계 전환 뒤에는 **말풍선 문구가 바뀔 때까지** 기다린다 —
`.tut-spot` 이 안 숨겨졌다는 것만으로 기다리면 직전 단계의 말풍선을 읽는다 (처음 작성했을 때 실제로 틀렸다).

**스모크가 보지 않는 것 (눈으로 확인함, 헤드리스 스크린샷 3장)**: 포커싱 링의 **확대-축소 + 에코 링** 움직임
(정지 이미지로는 크기만 보인다), 시설 증축 확인 팝업이 뜨는 순간 스포트라이트가 비켜서는 것,
목표 패널이 딤 위에서 실제로 밝게 읽히는 것. 세 장 다 예상대로였다 (`발전기를 가동하세요 3 / 15` · 용도
목록에 발전기 행 + 작업실 한 줄 · 확인 팝업 전체가 밝고 클릭 가능).

---

## 2026-09-08 — main 병합 (ESC 규칙 통일 · 바위 엄폐 ↔ 로그 엄폐)

`npm run verify:all` — **전부 통과, 7분 7초**. 병합 전 첫 회차는 red 5건이었고, 그 5건이 무엇이었는지가 이
병합에서 볼 만한 내용이다.

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,150.55 kB JS / 217.83 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-ship-rooms 71/71, smoke-controls-hub 121/121, smoke-tactical 85/85, smoke-inventory-p6 93/93,
smoke-console 63/63, smoke-housing 197/197, smoke-progression 123/123, smoke-loadout 61/61, smoke-ui-p6 89/89,
smoke-search 61/61, smoke-ui-p5 133/133, smoke-resume-gate 48/48, smoke-enemy-alert 42/42, smoke-uniques 71/71,
smoke-meta 170/170, smoke-rogue-v2 52/52, smoke-training 110/110, smoke-library 126/126, smoke-enemy-delta 52/52,
smoke-social 130/130, smoke-ghost 86/86, smoke-raidflow 48/48, smoke-planets 86/86, smoke-tutorial 39/39,
smoke-ecology 83/83, e2e-mp 156/156.

**red 5건 중 4건은 스모크가 옛 ESC 규칙을 검사한 것**이었다 — 채택한 규칙이 `main` 쪽("Escape 는 열기만 한다")
이므로 검사도 그쪽으로 옮겼다:

- `smoke-raidflow` (4건) — "창이 일시정지 위에 열리면 일시정지가 물러난다"는 없어진 규칙. 이제 **쌓인다**:
  두 blocker 가 함께 서고, `게임으로 돌아가기` 가 아래 창으로 돌려보내고, Tab 이 그 창을 닫는다.
- `smoke-resume-gate` (crash) — 게이트의 방아쇠가 "Escape 로 닫힌 화면" 이었는데 Escape 가 화면을 닫지 않는다.
  방아쇠를 **제 키(Tab)로 닫은 화면 + 거부된 재잠금** 으로 옮겼다. 게이트 자체는 그대로 살아 있다.
- `smoke-meta` / `smoke-inventory-p6` (각 1건) — 기업 데스크와 인벤토리 창을 Esc 로 닫던 자리를 Tab 으로.

**나머지 1건은 제품 버그였다** (`smoke-enemy-alert` 2건 + 뒤이어 `smoke-rogue-v2` 2건). `main` 이 총알 원기둥을
실제 바위 외형에 맞춰 **넓히고 낮췄는데**(`shotRadius` / `shotHeight`), 두 곳이 여전히 이동 콜라이더를 쟀다:

- `smoke-enemy-alert` — 90 m 떨어진 시야가 뚫린 자리를 16각도 · 단일 반경으로만 찾아 자리를 못 잡고 시나리오가
  통째로 죽었다. 64각도 · 3반경으로 넓혔다 (스모크 쪽 문제).
- `enemy/ai/RogueCover` — 엄폐 지점과 사격 지점이 `o.radius + 0.7` 로 물러서서 **총알 원기둥 안**에 들어갔고,
  `findPopSpot` 이 양쪽 측면을 "아직 가려짐" 으로 읽어 후보를 전부 버렸다. 넓은 바위 근처의 로그가 엄폐를 하나도
  잡지 않는다. 3회 중 2회 재현 → `blockRadius` / `blockHeight` 로 고쳤고, 이후 4회 연속 52/52
  (스모크의 바위 군집 추첨도 최대 3회 재시도로 바꿨다 — 무작위 군집 하나에 결과가 걸리지 않도록).

## 2026-09-08 — 튜토리얼 (새 캐릭터 안내 14단계)

`npm run verify:all` **all passed in 5 min 39 s**.

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,141.81 kB JS / 215.65 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-ship-rooms 71/71, smoke-tactical 85/85, smoke-controls-hub 111/111, smoke-inventory-p6 93/93,
smoke-console 63/63, smoke-housing 197/197, smoke-progression 123/123, smoke-loadout 61/61, smoke-ui-p6 87/87,
smoke-search 61/61, smoke-ui-p5 133/133, smoke-resume-gate 47/47, smoke-enemy-alert 42/42, smoke-uniques 71/71,
smoke-meta 170/170, smoke-training 110/110, smoke-library 126/126, smoke-rogue-v2 52/52, smoke-ghost 86/86,
smoke-enemy-delta 52/52, smoke-planets 86/86, smoke-ecology 83/83, smoke-raidflow 48/48, smoke-social 116/116,
**smoke-tutorial 39/39 (신규)**, e2e-mp 156/156.

신규 스모크 1개: `smoke-tutorial` (39) — 자동 시작이 **새 프로필에서만** 걸리는 것 · 시작 카드와 블로커/커서 ·
목표 패널 · 게이트 전부(용도 · 가구 · 레시피 · 터미널 · 행성 · 탑승 · 화면 탭) · 커뮤니티/매치메이킹 숨김 ·
스포트라이트(네 판 + 링 + 말풍선) · 바닥 안내선(그려지고, 도착하면 걷힌다) · 재료 1회 지급 ·
새로고침을 견디는 단계 · 건너뛰기 확인 카드 · 건너뛴 뒤 모든 게이트 해제. `scripts/verify.mjs` 에 등록했다.

**다른 모든 스모크에 한 줄씩 추가했다** — `evaluateOnNewDocument` 에서 `scav.tutorial` 을 `{done:true}` 로 심는다.
튜토리얼은 새 프로필에서 자동으로 켜져 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 심지 않으면
`smoke-housing` · `smoke-planets` · `smoke-training` · `e2e-mp` 등이 전부 자기 시나리오 앞에서 막힌다.

**한 번 걸린 것**: 스모크가 `waitStep('workshop')` 직후 스포트라이트를 바로 읽어 12번에 2번쯤 실패했다.
스포트라이트는 대상을 프레임 단위(`RETARGET_INTERVAL` 0.25 s)로 다시 찾으므로 아직 자리를 못 잡은 상태였다.
검사를 `waitFor` 로 바꿨다(3연속 39/39). 같은 과정에서 실제 버그도 하나 잡았다 — 대상이 보이는지를
`offsetParent` 로 판정하면 `position: fixed` 조상 아래의 HUD 조각이 언제나 null 이라 스포트라이트가 뜨지 않는다.
`getClientRects().length` 로 바꿨다.


## 2026-09-08 — UI/UX 개선 6건 (기업 탭 잠금 · 감정 지연 · 임플란트 이사 · 레드닷 · 출격 경고)

`npm run verify:all` **all passed in 5 min 39 s**.

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,120.37 kB JS / 212.17 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-ship-rooms 71/71, smoke-inventory-p6 93/93, smoke-controls-hub 111/111, smoke-tactical 85/85,
smoke-console 63/63, smoke-housing 197/197, smoke-progression 123/123, smoke-loadout 61/61, smoke-ui-p6 87/87,
smoke-search 61/61, smoke-ui-p5 133/133, smoke-resume-gate 47/47, smoke-enemy-alert 42/42, smoke-uniques 71/71,
smoke-meta 170/170, smoke-training 110/110, smoke-library 126/126, smoke-rogue-v2 52/52, smoke-ghost 86/86,
smoke-enemy-delta 52/52, smoke-planets 86/86, smoke-raidflow 48/48, smoke-ecology 83/83, smoke-social 116/116,
e2e-mp 156/156.

새 스크립트는 없다. 기존 스모크에 검사를 더했다 (+22): `smoke-meta` 170 (기업 탭 잠금 · 퀘스트 탭으로 열림 ·
잠긴 탭 클릭 무시 · Lv.1 에서 해제), `smoke-search` 61 (감정이 상자를 연 뒤 0.1 s 지나 시작), `smoke-housing` 197
(프리셋의 `implantItems` 저장 · 리로드 · 손상 세이브 정화), `smoke-progression` 123 (캐릭터 시트에 임플란트 UI 가
없다 · 인벤토리 칸에서의 장착/해제/피커 · 프리셋 왕복), `smoke-controls-hub` 111 (캐릭터 탭 2열 · 인벤토리
임플란트 칸 · 레드닷), `smoke-planets` 86 (출격 경고 표시 · 취소 · 그래도 출격 · 재차 묻지 않음).

**세 번 걸린 것** (첫 `verify:all` 은 3개 실패):

1. `smoke-quickslots` 33/42 — 임플란트 칸을 `.inv-equip` 에 넣자 그 열이 **262 → 814 px** 로 벌어져 가방 격자가
   1280 px 뷰포트 **밖으로** 밀려났고, 실제 마우스 드래그가 전부 허공을 짚었다. 원인은 `.inv-panel, .inv-equip
   { flex: none }` — 열 폭이 **max-content** 라 임플란트 설명 한 줄이 그대로 폭이 된다. `.inv-implants` 를
   `width: 0; min-width: 100%` 로 두어 (퍼센트 min-width 는 고유 크기 계산에서 0) 폭은 예전처럼 장비 슬롯이 정하고
   블록은 거기 맞춰 줄바꿈하게 했다. 헤드리스로 실제 사각형을 재서 확인했다.
2. `smoke-training` 101/110 · `e2e-mp` 59/60 — 포드 탑승 경로에 출격 경고가 새로 끼어들어 두 스모크가 그대로
   멈췄다(기본 지급품에는 주무기가 없어 항상 걸린다). 두 스크립트의 탑승 헬퍼가 경고 카드를 확인하고 지나가도록 고쳤다.
3. `smoke-planets` 80/82 — 리로드 뒤 세션이 새로 시작하면 `launchWarnAck` 이 비므로 경고가 다시 뜬다. 이건 의도한
   동작이라 발사 검사 쪽을 고쳤다(리로드 뒤 경고가 다시 뜨는 것 자체를 검사로 만들었다).


## 2026-09-08 — Phase 12 (임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · UX 정리)

`npm run verify:all` **all passed in 9 min 8 s** (계약 커밋 `e215d36`, 구현 `bb1b4c6` + 통합 수정).

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,100.38 kB JS / 210.51 kB CSS,
smoke-quickslots 46/46, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-phase2 53/53, smoke-weapons 137/137,
smoke-ship-rooms 71/71, smoke-controls-hub 106/106, smoke-phase4 49/49, smoke-inventory-p6 93/93, smoke-tactical 85/85,
smoke-console 63/63, smoke-housing 194/194, smoke-progression 119/119, smoke-ui-p6 87/87, smoke-ui-p5 133/133,
smoke-search 59/59, smoke-loadout 61/61, smoke-resume-gate 47/47, smoke-meta 166/166, smoke-enemy-alert 42/42,
smoke-uniques 71/71, smoke-rogue-v2 52/52, smoke-training 110/110, smoke-library 126/126, smoke-enemy-delta 52/52,
smoke-ghost 86/86, smoke-planets 76/76, smoke-social 116/116, smoke-ecology 83/83, smoke-raidflow 48/48, e2e-mp 156/156.

신규 스모크 2개: `smoke-enemy-alert` (42, 총알 추적 · 배리어 충돌 · x-ray) 와 `smoke-resume-gate` (47, 재개 게이트 ·
일시정지 최상위 · ESC 데드락 · 셸 커서). 둘 다 `scripts/verify.mjs` 에 등록했다.

### 첫 실행의 red 2건과 그 원인 (둘 다 통합 단계에서 잡았다)
- **smoke-housing 191/194** — 리드가 기본 지급품의 폐금속을 16 → 24 로 올렸는데(첫 시설 체인이 4 부족했다)
  ui 에이전트가 쓴 검사가 옛 수치를 기대하고 있었다. 검사를 24 · 4 · 3 기준으로 갱신.
- **smoke-tactical 60/85** — 근접 · 구르기 · 대시가 전부 조용히 거부됐다. 원인은 새 **재개 게이트**였다:
  그 스크립트의 포인터 락 스텁은 요청만 resolve 하고 `pointerLockElement` 를 늦게(사격 구간에서) 세우므로,
  게이트가 "락이 없고 재시도 대기 중"으로 보고 `RESUME_GATE_BLOCKER` 를 잡아 조작을 막았다. 이것은 스크립트만의
  문제가 아니다 — 포인터 락을 아예 거부하는 브라우저에서는 나갈 방법이 없는 오버레이가 된다. 그래서 게이트를
  **이번 세션에서 락을 한 번이라도 잡은 경우**로 좁혔다(2026-09-07 이전의 lost-lock 워치독과 같은 규칙).
  고친 뒤 smoke-tactical 85/85, smoke-resume-gate 47/47.

## 2026-09-08 — 문서 재구성 + 거대 파일 분할 (동작 무변경)

`verify:all` **전부 통과**, 5분 38초 (31 스모크 · e2e 156/156 · net-selftest 278/278 · build).

docs line: 2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,114.08 kB JS / 210.51 kB CSS,
smoke-quickslots 46/46, smoke-phase2 53/53, smoke-stratagems 70/70, smoke-weapons 137/137, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-ship-rooms 71/71, smoke-controls-hub 106/106, smoke-inventory-p6 93/93, smoke-tactical 85/85,
smoke-console 63/63, smoke-housing 194/194, smoke-loadout 61/61, smoke-progression 119/119, smoke-search 59/59,
smoke-ui-p6 87/87, smoke-ui-p5 133/133, smoke-resume-gate 47/47, smoke-enemy-alert 42/42, smoke-uniques 71/71,
smoke-meta 166/166, smoke-rogue-v2 52/52, smoke-training 110/110, smoke-library 126/126, smoke-enemy-delta 52/52,
smoke-ghost 86/86, smoke-planets 76/76, smoke-social 116/116, smoke-ecology 83/83, smoke-raidflow 48/48, e2e-mp 156/156

이 변경은 **13개 시스템 파일을 `model.ts` + `parts/` 로 가르는 순수 재배치**였으므로(위임 메서드가 남아 호출부
무변경) 스모크 전체가 그대로 통과하는 것이 성공 기준이었다. 실제로 통과했고, 도중 두 번 나온 red 는 둘 다
분할과 무관한 **기존 플레이크**였다:

- **smoke-ship-rooms 68/71** — 병렬 4레인 부하에서만 나온다(방 좌표 · 가구 픽업 3건). 단독 재실행 71/71.
  이 스크립트가 함선 상태를 심는 시점이 서버 프로필 로드와 경합하는, 이미 알려진 성질이다.
- **smoke-enemy-delta 51/52** — `a turn below the 1 cm step sends only yaw`. **HEAD 에서도 12번에 1번 실패**하는
  것을 격리 워크트리로 확인했다(분할 코드 2/13, HEAD 1/20 — 같은 비율). 원인은 테스트 쪽이다: 위치는
  `round(v, 2)` 로 양자화되는데 검사가 적을 1 mm 밀고 "1 cm 미만이니 `p` 는 안 나간다"를 기대한다. 스폰 x 가
  센티미터의 상위 10 %에 떨어지면 1 mm 도 경계를 넘는다(350.4249 → 350.42, +0.001 → 350.43).
  넛지 전에 x 를 센티미터 격자에 스냅하도록 고쳤다 — 반올림값이 같으므로 캐시 비교에는 영향이 없고,
  격자점에서 0.001 은 다른 값으로 반올림될 수 없다. 고친 뒤 **12/12**.

## 2026-09-08 — ESC = 항상 일시정지 · 설정 3분할 · 소셜 일원화

`verify:all` **전부 통과**, 5분 0초 —
typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,041.76 kB JS / 201.28 kB CSS,
smoke-quickslots 46/46, smoke-weapons 103/103, smoke-phase2 53/53, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 71/71, smoke-inventory-p6 63/63,
smoke-controls-hub 109/109, smoke-housing 176/176, smoke-progression 68/68, smoke-console 63/63,
smoke-loadout 61/61, smoke-ui-p6 68/68, smoke-search 59/59, smoke-ui-p5 133/133, smoke-meta 130/130,
smoke-training 110/110, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52,
smoke-planets 76/76, smoke-raidflow 42/42, smoke-social 130/130, smoke-rogue-v2 52/52, smoke-ecology 83/83,
e2e-mp 156/156. 새 검사 24개(smoke-controls-hub 99 → 109, smoke-social 116 → 130).

**애드혹 실물 확인 (12/12)** — 이 변경의 핵심은 헤드리스 스모크가 검증할 수 없다. 스크립트들은 Windows 에서
진짜 포인터 락이 `ClipCursor` 로 OS 커서를 숨겨진 창에 가두기 때문에 `requestPointerLock` 을 **스텁**하고,
그래서 "브라우저가 Escape 키다운을 삼킨다"는 이 작업의 전제 자체가 재현되지 않는다. 그래서 스텁 없이
헤드리스 Chrome 을 띄우고 캔버스를 **진짜로 클릭해 실제 락을 잡은 뒤** 확인했다(스크립트는 저장소에 넣지
않았다 — 커서 트랩 위험 때문에 `verify.mjs` 에 들어가면 안 된다):
  - 캔버스 클릭으로 실제 포인터 락 획득 (`document.pointerLockElement === #game-canvas`)
  - **Escape 한 번**에 일시정지 메뉴 (`menu` blocker, 제목 `일시 정지`) — 락은 사라진 상태
  - **두 번째 Escape 는 메뉴를 닫지 않는다**
  - `게임으로 돌아가기` 클릭 → 메뉴가 닫히고 **포인터 락이 즉시 복귀** (그 클릭이 브라우저가 요구하는
    engagement gesture 였다)
  - Tab → 가방이 열리고 락이 풀린다(커서 모드) → Escape → 메뉴가 **가방 위에 쌓이고** 가방은 열린 채 남는다
  - 페이지 에러 0
참고로 이 헤드리스 빌드는 락 중에도 Escape 키다운을 페이지에 전달했다(headed Chrome 은 삼킨다). 두 경로가
모두 `escapePause()` 로 모이고 `paused` 면 즉시 반환하므로, 어느 쪽이든 **한 번**이면 충분하다.

두 번째 `verify:all` 에서 `e2e-mp` 가 11/12 로 한 번 떨어졌는데 이 변경과 무관한 **릴레이 드롭 flake** 였다:
두 클라이언트가 도킹 컷씬까지 간 뒤 **동시에** `net: 'offline'` · `phase: 'menu'` 로 떨어졌고(`ctx.time` 도 두
쪽이 소수점 12자리까지 같은 값에서 멈췄다) 이는 소켓이 사라져 `net:lobbyLeft` → `game:abort` 를 탄 모양이다.
단독 재실행 156/156.

## 2026-09-08 — 투척 궤적 · 전투불능 연출 · 홀드 링 · 바위 엄폐 · 장착 슬롯 카드

`npm run verify:all` — **4분 55초**, red 1건:

```
2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,047.48 kB JS / 202.58 kB CSS,
smoke-quickslots 46/46, smoke-weapons 103/103, smoke-phase2 53/53, smoke-stratagems 70/70, smoke-phase3 32/32,
smoke-phase4 49/49, smoke-tactical 64/64, smoke-ship-rooms 68/71, smoke-inventory-p6 63/63,
smoke-controls-hub 109/109, smoke-housing 176/176, smoke-progression 68/68, smoke-console 63/63,
smoke-loadout 61/61, smoke-ui-p6 70/70, smoke-search 59/59, smoke-ui-p5 133/133, smoke-meta 130/130,
smoke-training 110/110, smoke-uniques 71/71, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52,
smoke-rogue-v2 52/52, smoke-planets 76/76, smoke-raidflow 42/42, smoke-social 130/130, smoke-ecology 83/83,
e2e-mp 156/156
```

**smoke-ship-rooms 68/71 은 flake.** 실패한 3건은 전부 하우징 모드의 커서 셀 판정
(`cell → world centre` · `cursor over the bench is a valid pick-up target (2,4; was 4,3)` · `X recovered the bench`)
이고, 커서가 한 칸 옆을 가리켰다 — 방을 고를 때 카메라가 `glideCamera` 로 **스르륵** 움직이므로 4레인 병렬 부하
에서 프레임이 밀리면 아직 도착하지 않은 카메라로 바닥 레이를 쏜다. 이번 변경은 hub / housing 을 건드리지 않았고,
단독 재실행 **3연속 71/71**.

업데이트한 스모크 2건 (설계가 바뀐 자리):
- `smoke-ui-p6` — 포기 홀드가 `.vitals .giveup` 의 가로 바에서 크로스헤어 링(`.hold.is-giveup`)으로 옮겨졌으므로
  캡션(`.giveup.show` + `포기`)과 링(`isHoldGaugeOn` / `holdGaugeProgress` / `isHoldGaugeGiveUp`)을 따로 본다.
  색은 해석된 `stroke` 가 아니라 **`--hc` 커스텀 속성**으로 검사한다 — 헤드리스 Chrome 은 `var()` 에 의존하는
  속성을 클래스 토글 **다음 프레임**에야 다시 해석해서, 같은 태스크 안에서 `getComputedStyle(...).stroke` 를 읽으면
  이전 색이 나온다(인라인 `stroke: red` 조차 무시된다). `--hc` 자체는 즉시 갱신되고, 실제 렌더는 정상이다.
- `smoke-controls-hub` — 장착 슬롯의 `.inv-slot-meta` 문장이 없어졌으므로 카드 안의 이름 · 발수 · 내구도
  (`.inv-slot-name` / `.inv-slot-ammo` / `.inv-slot-durnum`)를 본다.

**애드혹 시각 확인** (스모크가 검증하지 않는 부분, 스크립트는 저장소에 넣지 않음): 함선 Tab 화면(장착 카드 5칸 ·
장비+가방 한 패널 · 용량/가치), 레이드에서 수류탄을 손에 든 궤적 + 착탄 링(`throw-arc` 12점, 착탄 6.3 m — 실제
투척 물리와 일치), 전투불능 자세(등을 대고 누움 · 무장 없음 · 크로스헤어 임플란트 게이지 없음 · 빨간 포기 링).

---

## 2026-09-08 — 제작 UI 정리 (1초 홀드 · 수리 팝업) · 튜토리얼 장착 단계

`npm run verify:all` (`src/shared/tutorial.ts` 를 건드렸으므로 전체).

```
2026-09-08: typecheck ok, typecheck-server ok, net-selftest 278/278, build 2,183.34 kB JS / 220.97 kB CSS,
smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase4 49/49,
smoke-tactical 87/87, smoke-controls-hub 121/121, smoke-ship-rooms 69/72, smoke-inventory-p6 109/109,
smoke-housing 200/200, smoke-loadout 61/61, smoke-progression 123/123, smoke-console 63/63, smoke-search 61/61,
smoke-ui-p6 89/89, smoke-ui-p5 133/133, smoke-uniques 71/71, smoke-enemy-alert 42/42, smoke-meta 173/173,
smoke-resume-gate 48/48, smoke-rogue-v2 52/52, smoke-training 112/112, smoke-library 126/126, smoke-ghost 86/86,
smoke-enemy-delta 52/52, smoke-raidflow 48/48, smoke-phase3 21/22, smoke-planets 86/86, smoke-social 136/136,
smoke-ecology 85/85, smoke-tutorial 57/57, smoke-hangar 58/58, e2e-mp 8/11
```

**red 3건 — 전부 이 변경과 무관하다.** 하나하나 단독 재실행으로 갈랐다.

- `smoke-ship-rooms 69/72` → 단독 **72/72**. 늘 같은 flake다 (하우징 모드의 커서 셀 판정 — `glideCamera` 가
  아직 도착하지 않은 카메라로 바닥 레이를 쏜다). 4레인 부하에서만 난다.
- `e2e-mp 8/11` → 단독 **156/156**. 실패 상태가 `remotes: 3` 이었다 — 앞 레인의 헤드리스 크롬 2대가 아직
  릴레이에 붙어 있어 A 가 자기 로비를 만들지 못하고 남의 공개 함선에 끼어들었다. 넷 코드는 한 줄도 건드리지 않았다.
- `smoke-phase3 21/22` (`궤도 레이저`) → **이건 flake 가 아니라 이미 깨져 있던 것**이다. 단독 재실행에서도
  `timeout waiting for laser ended` 로 같은 자리에서 죽고, **작업 내용을 `git stash` 로 전부 걷어낸 깨끗한
  트리에서도 26/27 로 똑같이 실패한다** (재현 2회). `src/stratagems` 의 미해결 항목이지 이번 패키지의 회귀가 아니다.

업데이트한 스모크 2건 (설계가 바뀐 자리):
- `smoke-inventory-p6` (104 → 109) — 작업대 패널의 하단 수리 목록 검사를 **수리 팝업**으로 옮겼다: `모두 수리` 가
  모달 + 뒤를 덮는 판을 연다 · **닳은 것만** 줄로 뜬다(내구도 막대 + `×`) · 아래에 합계 재료 칩과 `모두 수리 (n)` ·
  `×` 로 뺀 항목은 일괄에서 빠진다 · 닫으면 제외가 초기화된다 · 장비 작업대는 무기를 고치지 않고 가젯 작업대에는
  버튼 자체가 없다. 더해서 `craftDuration` 이 레시피와 무관하게 1 s 이고 행에 시간 칩이 없다는 것.
- `smoke-tutorial` (51 → 57) — 단계 수 16 → 17, 작업대를 열면 장비 열 · 퀵슬롯 · 화면 탭 · 가방의 제작 버튼/가치가
  `display: none` 이라는 것, `openBag` 단계가 제작 창의 `닫기` 를 밝히고 그것을 누르면 `equipGun` 으로 넘어간다는 것,
  `equipGun` 의 **합집합 포커싱**이 그린 링이 `.inv-equip` 과 `.inv-panel-bag` 을 **둘 다 완전히 감싼다**는 것
  (원래 신고된 버그의 회귀 테스트다 — 예전에는 주무기 칸만 밝아 가방이 어두운 판 아래 깔렸다).
  `.scr-tabs` 는 캐릭터 시트도 같은 클래스를 쓰므로 `.inv-root .scr-tabs` 로 좁혀서 본다.


---

## 2026-09-09 — 캐릭터 슬롯 · 타이틀 재구성 · 기업 UI · 재화

`npm run verify:all` (머지 게이트: `src/shared` · `main.ts` 를 건드렸다).

```
2026-09-09: typecheck ok, typecheck-server ok, net-selftest 278/278, data-check ok,
build 2,290.75 kB JS / 236.80 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55,
smoke-weapons 137/137, smoke-stratagems 70/70, smoke-phase3 32/32, smoke-ship-rooms 69/72,
smoke-phase4 45/49, smoke-tactical 87/87, smoke-controls-hub 124/124, smoke-housing 203/203,
smoke-inventory-p6 123/123, smoke-console 63/63, smoke-loadout 62/62, smoke-progression 123/123,
smoke-search 61/61, smoke-ui-p6 87/87, smoke-ui-p5 134/134, smoke-resume-gate 48/48,
smoke-uniques 71/71, smoke-enemy-alert 42/42, smoke-meta 172/172, smoke-training 112/112,
smoke-rogue-v2 52/52, smoke-library 126/126, smoke-ghost 86/86, smoke-enemy-delta 52/52,
smoke-raidflow 48/48, smoke-ecology 85/85, smoke-planets 86/86, smoke-social 137/137,
smoke-tutorial 67/67, smoke-hangar 58/58, e2e-mp 156/156
```

**red 2건 — 둘 다 단독 재실행에서 만점이다.** 4레인 부하에서만 나는 늘 그 자리다.

- `smoke-ship-rooms 69/72` → 단독 **72/72**. 이미 기록된 flake (하우징 모드의 커서 셀 판정 — `glideCamera` 가
  아직 도착하지 않은 카메라로 바닥 레이를 쏜다).
- `smoke-phase4 45/49` → 단독 **49/49**. 실패 상태가 `{"dead":true,"hp":0}` 였다 — 로그 분대의 사격을 받는
  구간에서 플레이어가 죽으면 그 뒤 테스트(텔레포트 · 스태미나 · 근접 · 넉백)가 줄줄이 무너진다. 부하가 걸린
  레인에서 시뮬레이션 스텝이 길어지면 재현된다. 전투 코드는 이번에 한 줄도 건드리지 않았다.
- (앞선 회차에서 본 `smoke-hangar` · `e2e-mp` 의 `timeout waiting for A auto-connected` 는 **내가 겹쳐 돌린**
  두 번째 러너의 헤드리스 크롬이 아직 릴레이에 붙어 있어서다. 같은 회차의 단독 실행에서 58/58 · 156/156.
  `smoke-phase3 26/27` 도 마찬가지로 이전부터 알려진 `궤도 레이저` 실패이지 이번 회귀가 아니다.)

**고친 스모크 5건** (설계가 바뀐 자리 · 세이브 키가 바뀐 자리):

- **세이브 키 접두사** — 스모크 36개가 `localStorage` 를 직접 만진다. 캐릭터 세이브가 슬롯별이 되면서
  `scav.tutorial` · `scav.stash` · `scav.loadout` · `scav.ship` · `scav.grant` · `scav.profile` · `scav.meta` ·
  `scav.training` · `scav.planet` · `scav.sessionToken` 110곳을 `scav.s1.*` 로 옮겼다. 공용 저장
  (`scav.keybinds` · `scav.audio` · `scav.display` · `scav.console.history`)은 그대로다.
- `smoke-controls-hub` (20 → 124) — 조작 다이어그램 검사가 타이틀에서 **설정 → 키 설정**(`.set-body.keys`)으로
  갔다. 타이틀은 버튼 셋(`게임 시작` / `설정` / `종료`)과 사라진 콜사인 · 다이어그램을 본다. 리바인딩이
  설정 안의 다이어그램을 따라가는지, Escape 가 키 오버레이 → 설정 → 타이틀 순으로 한 겹씩 벗겨지는지도 본다.
  가로 넘침 검사는 **프레임의 `scrollWidth` 를 재지 않게 고쳤다** — `.wordmark` 는 마지막 글자의 letter-spacing 을
  음수 오른쪽 마진으로 상쇄하므로 border box 보다 딱 그만큼 넓게 나온다(보이지 않는 장부상의 넘침). 실제로
  문제가 되는 **페이지 가로 스크롤**과 프레임이 뷰포트 안에 있는지를 본다.
- `smoke-ui-p5` (133 → 134) — 타이틀의 `.lv-chip` 이 사라졌으므로 그 자리를 **캐릭터 선택창**이 받는다:
  빈 저장소로 부팅하면 칸 셋이 전부 비어 있고, 슬롯 2 에 프로필을 심고 다시 열면 그 칸이 이름 · 레벨 ·
  능력치 다섯 줄을 세이브에서 읽는다. `progress:loaded` 는 이제 캐릭터 이름을 `net.playerName` 으로 미는 자리다.
- `smoke-loadout` (62) — `새 캐릭터로 시작` → 슬롯 카드의 `삭제`. 무엇이 사라지는지 적힌 **홀드 확정** 팝업이
  뜨는지, **맨 클릭 한 번으로는 지워지지 않는지**, 지운 뒤 그 슬롯의 세이브와 세션 토큰만 사라지고 공용 설정은
  남는지를 본다.
- `smoke-meta` (172) — 기업 열이 `제목 · 기업 목록 · 신뢰도 게이지 · 페이지 탭 · 크레딧` 순이고 상단 행 ·
  기업 패널이 없다는 것, 퀘스트 보상이 목록 아래(`.cq-rewards`)에 **재화 칩(`rep:ceres`) + 아이템 칩** 한 줄로
  선다는 것.
- `smoke-planets` (86) — 단말기 푸터에 `닫기 (E)` 만 있고 `타이틀로` 가 **없다**는 것.

---

## 2026-09-10 — 플레이 피드백 11건 (홀드 키캡 · 퀵슬롯 · 보조무기 제거 · 웨이브 · 재해 · 지도 · 지하실 · 상자 배치 · 선로 · 전차)

`src/shared` (`Keybinds` · `constants`)를 건드렸으므로 처음부터 `npm run verify:all`.

```
2026-09-09: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 135/135, smoke-stratagems 72/72,
smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-phase4 49/49, smoke-tactical 87/87,
smoke-controls-hub 131/131, smoke-inventory-p6 124/124, smoke-housing 206/206,
smoke-progression 123/123, smoke-loadout 69/69, smoke-console 63/63, smoke-search 61/61,
smoke-ui-p6 88/88, smoke-ui-p5 134/134, smoke-uniques 72/72, smoke-rogue-drop 29/29,
smoke-enemy-alert 42/42, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-meta 172/172,
smoke-library 126/126, smoke-training 112/112, smoke-enemy-delta 52/52, smoke-planets 86/86,
smoke-ghost 86/86, smoke-social 138/138, smoke-raidflow 49/49, smoke-ecology 90/90,
smoke-props-collision 20/20, smoke-structures 25/25, smoke-tutorial 83/83, smoke-hazard 43/43,
smoke-hangar 58/58, e2e-mp 156/156
```

**첫 실행의 red 4건은 전부 "기대값이 바뀐 단언" 이었고 제품 결함이 아니었다.**

- `smoke-phase2` · `smoke-loadout` — `inv.getLoadout().secondary.uid` 로 **장착된 무기**를 집던 두 곳이
  null 참조로 죽었다 (보조무기 칸이 사라졌으니 그 칸은 언제나 null 이다). `primary` 로 바꿨다.
- `smoke-loadout` — 크루 로드아웃 뷰의 장비 칸이 5 → **4** (`LOADOUT_SLOTS`).
- `smoke-tutorial` — "주무기 II 칸에 장착해도 장착 단계가 끝난다" 가 `primary === null` 까지 요구했는데,
  최소 지급품이 이제 **주무기 I 에 기관단총**을 준다. 단언에서 그 조건만 뺐다.
- `smoke-weapons` — ① `Digit3` 으로 교체하던 두 절(재장전 취소 · 파손 무기)이 아무 일도 안 하게 됐다 →
  `Digit2`(주무기 II). ② 유니크 무기 절에서 `가방 가득`. 원인은 **자리가 아니라 조각남**이었다: 시작
  지급품의 기관단총이 주무기를 갈아 끼울 때마다 가방에 밀려 들어와 배치가 어긋나, 빈 칸이 13개인데도
  4×2 가 들어갈 **이어진** 자리가 없었다 (실패 시 가방 내용을 찍어 확인). 함선에서 돌격소총으로 갈아
  끼운 직후 그 기관단총을 치우고, 유니크를 넣기 전 부착물 찌꺼기를 비우는 재시도를 넣었다.

**새로 넣은 단언** — `smoke-structures` 의 선로 두 건: 중심선 12곳에서 ⓐ `getSurfaceY` 가 레일 상면을
돌려준다(= 발판 콜라이더가 걸렸다) ⓑ 레일이 지형보다 0.4 m 넘게 떠 있다(= 파묻히지 않았다).
`smoke-hazard` 의 시야 배수 상한은 상수 하나에서 **재해별 표**(`storm_eye` 24, 나머지 7)로 바뀌었다.

**홀드 키캡은 스모크가 아니라 격리 페이지로 잡았다.** `base.css` 만 불러오는 정적 HTML 에 프롬프트 마크업을
그려 `getComputedStyle` 로 실측하니 키캡이 `120×120`, `opacity 0` 이었다 — `.hold`(크로스헤어 홀드 링)와의
클래스 충돌이 원인이라는 직접 증거다. 이 종류는 렌더 결과를 재야만 보이므로 스모크 단언으로 옮기지 않았다.

---

## 2026-09-09 — 핑 v3 · 채팅 IME/말풍선 · 무기 툴팁 게이지 · 탈출 60초 · 버그 근접 피해 절반

`npm run verify` (ui · inventory · net · data 매핑 → 실질적으로 전부, 8분 2초) 뒤 실패 2건을 스모크 수정으로 잡고
`--rerun-failed` 통과:

```
2026-09-09: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
smoke-quickslots 46/46, smoke-phase2 55/55, smoke-weapons 137/137, smoke-stratagems 72/72,
smoke-phase3 33/33, smoke-phase4 49/49, smoke-ship-rooms 72/72, smoke-tactical 87/87,
smoke-controls-hub 125/125, smoke-inventory-p6 124/124, smoke-housing 203/203, smoke-console 63/63,
smoke-progression 123/123, smoke-loadout 62/62, smoke-search 61/61, smoke-ui-p6 87/87,
smoke-ui-p5 134/134, smoke-resume-gate 48/48, smoke-uniques 72/72, smoke-enemy-alert 42/42,
smoke-meta 172/172, smoke-rogue-v2 52/52, smoke-library 126/126, smoke-enemy-delta 52/52,
smoke-training 112/112, smoke-ghost 86/86, smoke-raidflow 48/48, smoke-social 137/137,
smoke-planets 86/86, smoke-ecology 85/85, smoke-props-collision 20/20, smoke-tutorial 67/67,
smoke-hangar 58/58, e2e-mp 156/156
```

**고친 스모크 3건** — 전부 설계가 바뀐 자리이거나 밸런스 수치를 박아 둔 자리다.

- `smoke-ui-p5` (134) — 아이템 카드의 하단 바가 `무게(.wt) · 가치(.val)` 두 쪽이 됐다. 첫 `.k` 를 읽어 `가치` 를
  단정하던 것을 `.val .k` 로 옮겼다.
- `smoke-controls-hub` (124/125 → 125) — 재료 칩 카드의 `rows >= 3` 은 크기 · 무게 줄이 표에 있던 시절의 숫자다.
  이제 `rows >= 1`, 표에 `크기` · `무게` 가 **없고** 하단 바 왼쪽이 `무게` 인지를 본다.
- `smoke-enemy-alert` (40/42 → 42) — **스캐빈저 물기 피해 `8` 이 박혀 있었다.** 버그 근접 피해를 절반으로 내리자
  두 단정이 깨져서 `data/enemies.csv` 의 `attackDamage` 를 읽어 비교한다(`BITE`).

## 2026-09-09 — 사망/시체 · 구조선 · 분대장 · 전장의 안개 · 지형지물 콜리전

`npm run verify:all` **전부 통과** (8분 18초, 4레인 병렬):

```
2026-09-09: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
build 2,329.28 kB JS / 238.46 kB CSS, smoke-quickslots 46/46, smoke-phase2 55/55,
smoke-weapons 137/137, smoke-stratagems 72/72, smoke-phase3 33/33, smoke-phase4 49/49,
smoke-ship-rooms 72/72, smoke-tactical 87/87, smoke-controls-hub 124/124,
smoke-inventory-p6 123/123, smoke-housing 203/203, smoke-console 63/63,
smoke-progression 123/123, smoke-search 61/61, smoke-loadout 62/62, smoke-ui-p6 87/87,
smoke-ui-p5 134/134, smoke-resume-gate 48/48, smoke-meta 172/172, smoke-uniques 72/72,
smoke-enemy-alert 42/42, smoke-rogue-v2 52/52, smoke-library 126/126,
smoke-enemy-delta 52/52, smoke-training 112/112, smoke-ghost 86/86, smoke-raidflow 48/48,
smoke-social 137/137, smoke-planets 86/86, smoke-ecology 85/85, smoke-tutorial 67/67,
smoke-hangar 58/58, e2e-mp 156/156
```

**고친 스모크 6건.** 앞의 넷은 설계가 바뀐 자리이고, **뒤의 둘은 스모크가 밸런스 수치를 박아 두고 있던
자리다** — 기능 회귀가 아니라 테스트의 결함이었고, 이번에 체력을 2배로 올리면서 드러났다.

- `smoke-raidflow` (42 → 48) — 자동 부활 폐지. `죽은 고스트로 복귀 → 30초 카운트다운` 단정을
  **`카운트다운이 없고 game:respawn 이 무력하다`** 로 뒤집었다. 되살아나는 길은 구조선뿐이다.
- `smoke-ui-p5` (134) — 사망 화면에 `부활` 버튼이 **DOM 에서 아예 사라졌다**. `.ui-btn.respawn` 의
  `hidden` 을 읽던 두 곳이 `null.hidden` 으로 터졌다 — 존재 자체를 보는 검사로 바꿨다.
- `smoke-stratagems` (71 → 72) — 호스트의 `stratq sync` 답장에 `rescue count` 가 한 통 더 실린다.
  **보낸 개수**가 아니라 `strat sync` 가 정확히 하나이고 전부 요청자에게만 간다로 재고, 잔여 횟수가
  같이 오는지를 새로 본다.
- `smoke-rogue-v2` (52) — 시체가 내려앉는 바닥은 이제 지형이 아니라 **표면**이다. 낙하 지점을
  `getHeightAt` 으로 재던 것을 `getSurfaceY` 로 바꿨다 (바위 위에 걸친 시체가 몇 m 높은 곳에서
  멈추는 것이 정상이다).
- `e2e-mp` (156) — **`hp < 60` 이 박혀 있었다.** 스캐빈저 체력이 120 이 되는 순간 10 피해로는 영영
  성립하지 않는 조건이라 `host applies hit` 이 타임아웃했다. **맞기 전 체력보다 낮아졌는가**로 고쳤다.
- `smoke-uniques` (71 → 72) — 로켓 점프는 **원래부터 경합이었다.** 7 m/s 점프의 공중 체류가 GRAVITY 24
  에서 0.58초뿐이라 `look` · `click` 의 puppeteer 왕복이 조금만 늦으면 로켓이 터지기 전에 착지해
  `!isGrounded` 가 깨진다. 더 세게 뛰면 이번엔 폭발이 `BAZOOKA_ALT_RADIUS` 밖으로 멀어져(높이가 곧
  거리다) 자해조차 안 난다. 점프는 그대로 두고 **timeScale 0.2 로 시뮬 시간을 늦춰** 왕복 지연을
  흡수했고, `폭발 순간 아직 공중이었나` 단정을 하나 더했다.

**주의 — 소품 배치가 시드 대비 달라졌다.** `isSpotFree` 가 `o.radius` 로 거르는데 이동 콜라이더가
실측으로 넓어졌고, 거절된 자리는 그 콜백의 남은 rng 추첨을 건너뛴다. 멀티 결정성은 그대로다(같은 코드 ·
같은 시드면 모든 클라이언트가 같은 월드) — 다만 "시드 21 이 어제와 똑같이 생겼다"는 더는 아니다.

## 2026-09-09 — UI/UX 정리 7차 (퀵슬롯 컨테이너 · 스포트라이트 반 박자 · 포병)

**첫 실행 8 red → 최종 전부 green.** 실패는 전부 "옛 모델을 보던 단언"이었고, 그 단언들을 고치는 과정에서
**진짜 버그 세 개**가 나왔다. 셋 다 스모크를 느슨하게 고치는 대신 소스를 고쳤다.

### 검증 도중 나온 진짜 버그 3건

1. **`InventorySystem.locate()` 가 휠을 못 봤다.** `findItem` 에만 휠 분기를 넣고 `locate` 를 빠뜨려서
   **퀵슬롯의 스택을 버릴 수 없었다** (`dropItem` 이 uid 를 `locate` 로 푼다). `takeItem`(기업 판매)도 같은
   이유로 못 닿았다. 둘 다 휠 분기를 넣었다. `splitItem` 은 **격자 전용이 맞다** (휠 칸은 한 칸이라 쪼갠 쪽을
   놓을 자리가 없다) — README 에 그렇게 적었다.
2. **`mergeIntoQuick` 이 아무도 안 부르는 함수였다.** README 는 "주움 · 제작이 휠 스택부터 채운다" 고
   적어 놨는데 실제로는 `tryAddItem` · `addUnits` 어디에도 없었다. 둘 다에 넣었다 (부분 병합 뒤
   `syncQuickSlots` 로 HUD 수량이 따라간다).
3. **튜토리얼 스포트라이트가 영영 안 떴다.** 반 박자 지연(`TUTORIAL_STEP_DELAY_S`)의 첫 구현에서 `wait` 이
   음수로 넘어가고, 바로 다음 줄이 그 음수를 `-1`(아직 안 세고 있다) 표식으로 오해해 0.5초를 무한히 다시
   셌다 — `timer = min(RETARGET_INTERVAL, wait)` 가 두 카운터를 같은 값으로 묶어 늘 같은 프레임에 함께
   넘어갔기 때문이다. 계측: 0.5 → 0.0004 → 0.5 → … 무한 반복, 실제 점등까지 **23.7초** 또는 60초 안에
   **끝내 안 뜸**(설계값 0.5초). 고친 뒤 측정값은 **522 ms · 566 ms**. 자세히는
   [tutorial/README.md](../src/tutorial/README.md) 의 변경 이력.

### 스모크 (증가분은 전부 새 규칙을 실제로 검사한다)

- **smoke-quickslots 46 → 73** — 휠이 자기 컨테이너라는 것 전반: 시작 키트가 가방 격자에 **없다**,
  `setQuickSlot` 이 **옮기기**이고 밀려난 스택이 가방으로 돌아간다, 가방이 꽉 차면 `setQuickSlot(i, null)` 이
  **false 로 거절**하고 `inventory:full` 이 뜬다, 휠↔휠은 가방을 안 건드리는 맞바꿈, 휠 스택 `dropItem` ·
  `takeItem` · `splitItem` 거절, `mergeIntoQuick` 톱업(가방 타일이 안 생긴다), 형제 스택 승계가 **없다**,
  가방 타일에 방향 뱃지가 **하나도 없다**.
- **smoke-loadout 62 → 69** — v2 모양 + **v1 → v2 이관 절(8b)** 신설: 손으로 쓴 v1 문서(중복 인덱스 `0,0` ·
  범위 밖 `9` 포함)를 심고 리로드해 ① 가리키던 스택이 휠로 올라가고 ② **가방 격자에서 빠지며**
  ③ 휠 인덱스가 없던 항목은 자기 칸을 지키고 ④ 다시 캡처하면 **v2** 로 쓰이고 ⑤ 가방에 복제되지 않는다.
  (이 절이 뭔가를 검사하게 만들려면 함정 둘을 먼저 치워야 했다 — 부팅 때 **솔로 레이드 blob** 이 로드아웃
  파일을 덮고, `net:profileLoaded` 가 릴레이의 로드아웃 문서로 갈아치운다. 스크립트에 적어 뒀다.)
- **smoke-tutorial 67 → 83** — 17단계 순서 · `openCraft` 부재 · 저장된 `openCraft` 가 `craftAmmo` 로 접힌다,
  반 박자를 **양쪽으로** 단언(직후엔 안 떠 있고 ~0.5초에 뜬다, 300 ms ≤ t < 2000 ms), 딤 페이드 변수,
  구멍을 **어두운 판 4장에서** 재 `Spotlight.place` 규칙과 ±1 px 비교(링은 1→1.045 애니메이션이라 흔들린다),
  `equipGun` 포커싱이 장비 열 전체가 아니라는 것, 주무기 II 장착으로도 완료, 제작 흐름을 `goto` 가 아니라
  **실제로 제작해서** 통과.
- **smoke-controls-hub 125 → 129**, **smoke-phase2 55 → 57**, **smoke-search · smoke-weapons** 는 개수 유지
  (휠 위치를 보도록 단언을 옮겼다).

### 그 밖에

- **`src/ui/hud/KeyGuide.ts` 가 바이너리 파일이 돼 있었다.** 한도로 죽은 에이전트의 쓰기가 템플릿 문자열
  안에 **NUL · 0x01 · 0x02** 를 박아 넣었다 (`${e.key}${...}\x00${e.label}` · `.join('\x01')`). 복구했고,
  레포 전체를 제어문자로 훑어 나머지를 확인했다.
- 그 검사에서 **`scripts/smoke-ui-p5.mjs:203` 의 `/\bready\b/` 가 백스페이스 문자 두 개**로 커밋돼 있는 것도
  나왔다 — 이번 작업과 무관한 **기존 버그**이고 그 단언이 늘 통과한다. 범위 밖이라 고치지 않고
  [TODO.md](TODO.md) **C-13** 으로 남겼다 (고치면 단언이 실제로 검사를 시작하므로 그때 red 가 날 수 있다).
- **smoke-phase4 는 첫 실행에서 45/49** 였다가 최종 49/49 — 언제나 같은 신호(`{"dead":true,"hp":0}`)로 나오는
  이 스크립트의 오래된 flake다 (2026-09-09 기록에 클린 워크트리 4회 3승 1패로 확인해 둔 그것).
- 검증용 릴레이가 죽은 포트를 "already up" 으로 잡는 환경 flake가 한 번 있었다. `smoke-weapons` 만
  `no console errors` 에서 WebSocket 잡음을 안 걸러 내므로 그때 red 로 보인다 — 릴레이가 살아 있으면 통과한다.

---

## 2026-09-09 — 레이드 콘텐츠 (구조물 · 선로/전차 · 재해 · 로그 강하 · 의사소통 휠 · 등급 드롭)

`npm run verify:all` **전부 통과** (6분 40초, 37 스모크 + `e2e-mp` + build).

```
2026-09-09: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
build 2,465.64 kB JS / 254.64 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 137/137,
smoke-stratagems 72/72, smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-phase4 49/49,
smoke-controls-hub 129/129, smoke-tactical 87/87, smoke-housing 206/206, smoke-inventory-p6 124/124,
smoke-loadout 69/69, smoke-progression 123/123, smoke-console 63/63, smoke-search 61/61, smoke-ui-p6 88/88,
smoke-ui-p5 134/134, smoke-uniques 72/72, smoke-rogue-drop 29/29, smoke-enemy-alert 42/42,
smoke-resume-gate 59/59, smoke-meta 172/172, smoke-training 112/112, smoke-library 126/126,
smoke-rogue-v2 52/52, smoke-enemy-delta 52/52, smoke-ghost 86/86, smoke-planets 86/86, smoke-raidflow 49/49,
smoke-ecology 90/90, smoke-social 138/138, smoke-props-collision 20/20, smoke-structures 25/25,
smoke-tutorial 83/83, smoke-hazard 43/43, smoke-hangar 58/58, e2e-mp 156/156
```

새 스모크 3종: `smoke-structures`(25) · `smoke-hazard`(43) · `smoke-rogue-drop`(29),
새 검사기 `scripts/check-planet-loot.mjs`(행성별 등급 · 유니크 등장률 표본).

### 첫 실행에서 red 였던 3건 — 전부 **스모크 쪽** 문제였다

- **`smoke-phase4` 45/49 — "오래된 flake" 가 flake 가 아니었다.** 실패 4건이 전부
  `{"dead":true,"hp":0}` 를 달고 나왔고, 이 파일에 그동안 *"언제나 같은 신호로 나오는 오래된 flake"* 로
  적혀 있던 그것이다. 실제로는 **플레이어가 죽은 채로 플레이어 훅을 검사**하고 있었다 — 스모크는
  `if (pl.isDowned) pl.revive()` 만 했는데, 2026-09-09 에 **완전 사망의 자동 부활을 없앤** 뒤로 죽은 몸은
  그대로 남고 `canAct()` 가 막아 `startMelee` · `applyKnockback` 이 전부 거절된다.
  `if (pl.isDead) pl.respawnAt(...)` 를 더하고, 사망 화면 · 관전 오버레이가 닫히며 `uiBlockers` 가 비는 데
  몇 프레임 걸리므로 정착 시간을 0.6 → 1.2 s 로 늘렸다. 이번 배치의 월드 콘텐츠가 적 배치를 바꿔 죽는
  빈도가 올라가면서 **매번** 걸리게 된 것이고, 원인은 그 전부터 있었다.
  덧붙여 순간이동 단언이 `getHeightAt`(지형만)을 보고 있어 전차 데크(2.05 m)·구조물 슬래브 위에 내리면
  "떠 있다" 로 잡혔다 → 걷는 바닥의 표준인 `getSurfaceY` 로 바꿨다.
- **`smoke-ecology` 83/85 → 90/90.** 생태계 밀도 단언이 **거대 버섯 군락에 딸린 채집 버섯까지** 세고 있었다
  (mossy 51 → 67, crimson 34 → 48 — 정확히 독성 포자가 후보인 두 행성). 군락 버섯은 재해가 심는 것이라
  `PlanetEcosystem.gatherDensity` 와 무관하다. `Gather` 가 그 노드의 id 를 `grove_` 로 매기게 하고(군락 자리는
  `spots` 의 맨 뒤라 **기존 약초 · 고철의 id 는 한 글자도 안 바뀐다**) 스모크가 걸러 세도록 고쳤다.
  ⚠ 첫 시도에서 `variant === GROVE_PICK_VARIANT` 로 갈랐다가 **더 크게 깨졌다** — 그 변종 번호는 평범한 약초도
  쓰는 모양이라 그 모양의 약초가 전부 군락 버섯으로 잡혔다(모든 행성에서 군락 11–13개, 약초 수 반토막).
  **심는 쪽이 `Spot.grove` 로 표시**하는 것이 맞다.
- **`smoke-hazard` 9/10 → 43/43.** 두 갈래였다. ① `WARN_S` · `FULL_S` · `SPORE_INTERVAL` 같은 **Node 스코프
  상수를 `page.evaluate` 콜백 안에서** 참조했다 — 콜백은 브라우저에서 돌아 그 스코프를 못 본다(인자로 넘겨야
  한다). 하나를 고칠 때마다 다음 것이 드러나 네 번에 걸쳐 나왔다. ② 피해 · 시야 절이 아무 이벤트도 못 받았다:
  진단을 찍어 보니 `isInside` 는 **true** 인데 `hazard:insideChanged` 가 빈 배열이었다 — 앞 절이 이미
  `startsAt + FULL_S + 5` 까지 감아 둬서 플레이어가 **이미 구역 안**이었고, `__clear()` 는 기록만 지우지
  Hazard 의 "안에 있었다" 는 내부 에지 상태와 마지막 `atmo:override` 값은 그대로라 **변화가 없어 아무것도
  안 나갔다.** 재해 시작 전으로 한 번 되감아 밖 상태로 가라앉힌 뒤 들어가도록 고쳤다.
  세 번째로, 눈 밖으로 밀어내는 좌표가 맵 밖으로 나갈 수 있어(`center + radius + 90`) `respawnAt` 이
  스폰 지점으로 되돌리는 경우가 있었다 → 맵 안으로 클램프.

### 알아 둘 것

- **같은 시드의 소품 · 상자 · 채집물 배치가 이 배치 전과 다르다.** 구조물 · 선로 · 버섯 군락이 `SpatialHash`
  에 먼저 들어가 `isSpotFree` 가 그 자리를 피하기 때문이다 (2026-09-09 앞 배치의 소품 콜라이더 확대와 같은
  성격). **멀티 결정성은 그대로다** — 모든 클라이언트가 같은 시드로 같은 코드를 돈다.

## 2026-09-10 — 데스크톱 앱: ESC 로 화면을 닫으면 조작이 죽던 문제

`typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, smoke-controls-hub 130/130,
smoke-resume-gate 62/62` (두 스모크는 각각 단독으로 clean, 각 1분 이내).
그 전에 돌린 `verify:all` 은 **6분 46초에 1 failed** — 아래 4건이고, 전부 이 변경으로 계약이 바뀐 스모크
쪽이라 스모크를 고쳤다(코드가 아니라).

### 브라우저를 계측해서 잡았다 (스모크가 아니라)

스모크의 포인터 락은 **스텁**이라 이 버그를 볼 수 없다 — Chromium 이 락을 주고 빼앗는 규칙 자체가 원인이기
때문이다. 그래서 두 단계로 쟀다.

1. **최소 Electron 페이지** (`app.whenReady` → 캔버스 하나) + `webContents.sendInputEvent` 로 **진짜 Escape**.
   `requestPointerLock()` 의 거부 사유를 그대로 읽었다:
   - Escape 처리 **중**에 요청 → 허가됐다가 같은 Escape 로 회수(= 사용자 해제).
   - 그 뒤 200 ms · 400 ms 뒤 요청 → `"Pointer lock cannot be acquired immediately after the user has exited
     the lock."` 사이에 **진짜 키 입력을 넣어도** 같은 거부. 1500 ms 뒤 → 허가.
     → 쿨다운은 **시간에만** 반응한다(≈1.25초). 좌클릭이 듣는 것처럼 보인 이유가 이것이다.
   - Escape 를 **뗀 뒤** 요청 → user activation 없이도 허가, 그대로 유지.
     → `executeJavaScript(..., true)` 의 activation 은 이 문제와 무관했다.
   - 같은 ms 에 두 번 요청 → 두 번째가 `"Pointer lock pending"`, 짧은 구간에 여러 번 → `"Too many pointer
     lock requests in a short window of time"`.
2. **실제 게임을 Electron 창에 띄우고** 같은 방식으로 진짜 키를 넣어(`Tab` · `m` · `Escape`) 카메라가 돌아오는
   시각을 쟀다: **ESC 로 인벤토리 · 지도 닫기 → +245 ms 에 스스로 복귀**(고치기 전에는 클릭 전까지 영영),
   **자기 키(Tab · M)로 닫기 → +0–5 ms**, 스로틀에 걸린 경우도 **클릭 없이 1.35초 뒤** 복구.
   호출부 추적(`new Error().stack`)으로 요청 주체가 `flushDeferredRelock` 하나인 것도 확인했다 —
   고치기 전에는 한 클릭에 `takeLockOnClick` 과 `onLockGesture` 가 같은 ms 에 두 번 요청하고 있었다.

### 스모크 쪽에서 고친 4건 (`smoke-controls-hub`, 전부 계약 변경)

`a denied pointer-lock request arms the gesture retry` 계열 3건과 `좌클릭이 … 다시 요청한다` 1건이
red 였다. **코드가 틀린 게 아니라 검사가 옛 계약을 보고 있었다**:

- 앞 절이 "플레이어가 뺏은 락"을 만들어 두고 곧바로 요청했다 → 이제 그 요청은 쿨다운 동안 **미뤄지므로**
  스텁에 닿지도 않고, 따라서 거부되지도 · 제스처 재시도가 걸리지도 않는다. → 1.5초 기다렸다가 검사한다.
- Escape 를 누른 **직후** 다른 키로 재시도를 확인했다 → 그 요청도 `LOCK_ESCAPE_DEFER_MS` 만큼 미뤄진다
  (그게 이 수정의 요점이다). → 250 ms 뒤에 키를 눌러 검사한다.
- 좌클릭 검사는 **60 ms 전 요청의 결과가 오기 전**이라 이제 요청이 합쳐진다 → 클릭이 낸 의사는 남고
  `endFrame` 이 250 ms 뒤에 보낸다. → 400 ms 뒤에 `lastLockRequest` 를 본다.

새 검사 2종: `Escape 직후의 재요청은 미뤄진다`(`smoke-controls-hub`), 그리고 `smoke-resume-gate` **8b** —
ESC 로 화면을 닫으면 재잠금 요청이 **정확히 한 번**, **Escape 키보다 150 ms 이상 뒤에** 나가고, 게이트는
뜨지 않으며 카메라가 클릭 없이 돌아온다.

### 주의: 마지막 `verify:all` 은 신뢰할 수 없다

이 작업 마지막에 돌린 전체 스위트는 **7 failed** 였지만 전부 환경 문제다 — 같은 저장소를 다른 쪽에서
동시에 편집하고 있어(`src/inventory/*` · `src/weapons/*` · `src/meta/*` · `src/ui/*` 등 30여 파일)
**돌아가는 도중 vite HMR page reload 가 21번** 일어났다. 실패 문구도 그것이다:
`Execution context was destroyed, most likely because of a navigation` · `timeout waiting for playing`.
같은 이유로 이 배치의 스모크 정리는 `smoke-controls-hub` · `smoke-resume-gate` **단독 실행 결과**를 근거로
삼았다. 편집이 멎은 뒤 `npm run verify:all` 을 한 번 다시 돌려야 한다.

---

## 2026-09-10 — 2차 배치 (곡사포 궤적 · 위험 인디케이터 · 발소리 · 벽밀착 사격 · 가구 배치 · 레이드 HUD · 실드)

`npm run verify:all` (7분 11초, 4레인 병렬). 앞 절의 "마지막 verify:all 은 신뢰할 수 없다" 는 이 실행으로
해소됐다 — 편집이 멎은 상태에서 돌렸고 HMR reload 는 없었다.

```
2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
build 2,488.09 kB JS / 256.86 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136,
smoke-stratagems 72/72, smoke-phase4 49/49, smoke-tactical 87/87, smoke-controls-hub 131/131,
smoke-phase3 33/33, smoke-ship-rooms 72/72, smoke-inventory-p6 124/124, smoke-housing 206/206,
smoke-console 63/63, smoke-search 61/61, smoke-loadout 69/69, smoke-progression 123/123,
smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-enemy-alert 42/42, smoke-uniques 72/72,
smoke-rogue-v2 52/52, smoke-rogue-drop 29/29, smoke-resume-gate 62/62, smoke-meta 172/172,
smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52, smoke-ghost 86/86,
smoke-planets 86/86, smoke-raidflow 49/49, smoke-social 138/138, smoke-ecology 90/90,
smoke-structures 25/25, smoke-props-collision 20/20, smoke-hazard 43/43, smoke-tutorial 83/83,
smoke-hangar 58/58, e2e-mp 156/156
```

### 이 배치에서 고친 스모크 (전부 DOM · 계약이 실제로 바뀐 것이지, 테스트를 느슨하게 한 것이 아니다)

- `smoke-tactical` — `ctx.player.damageReduction > 0` → **`maxShield > 0`**. 방탄복은 이제 피해를 깎지
  않으므로 DR 은 늘 0 이다. 방탄복이 실제로 무언가를 준다는 검사는 실드로 옮겼다.
- `smoke-weapons` — `.wslots .wslot ≥ 3` → **`=== 0`** (칸이 없어진 것이 요점) + 새 패널 검사
  (`.wthumb` · `.mag` · `.reserve`).
- `smoke-ui-p5` — 우하단 순서에서 `implant-chip` · `wslots` 제거, 임플란트는 `.imp-hud` 의
  `dataset.implant` 로 검사하고 **이름이 없고 키만 있다**는 것을 새로 단언한다. 목표 문구 블록은
  `.text`/`.sub` 가 **없다**는 것과 시계만 남았다는 것, `ui:objective` 가 no-op 이라 문구가 되살아나지
  않는다는 것으로 다시 썼다.
- `smoke-controls-hub` — `.implant-gauge`(크로스헤어 왼쪽 세로 게이지) → `.imp-hud`(화면 중앙 하단
  가로 썸네일). 위치 단언도 "크로스헤어 왼쪽 · 세로 중앙" 에서 **"가로 중앙 · 화면 아래쪽"** 으로.
  대시의 칸 셋(`.seg`) 검사는 썸네일 안 숫자(`.ib-ch`) + `accent` 클래스 검사로 바뀌었다.
- `smoke-enemy-delta` — 배리어 없이 맞은 총알이 hp 를 깎는지 보던 검사가 **실드가 대신 먹어서**
  실패했다 (hp 100 → 100). 실효 체력 `hp + shield` 로 잰다.

### `smoke-phase3` 는 flaky 다 (이 배치와 무관)

첫 실행에서 `timeout waiting for laser ended` 로 떨어졌다가 단독 재실행에서 33/33 통과했다.
그 파일 자신이 2026-09-09 주석으로 원인을 적어 두고 있다 — 레이저 구간은 `timeScale 4` 로 수십 초를
흘려보내는데 그 사이에 벌레가 플레이어를 죽이면 레이드가 실패해 함선으로 돌아가고 호출 목록이
비워진다. 실패 시 덤프도 정확히 `{"phase":"hub"}` 였다. 주변을 비우는 방어 코드가 이미 있지만
`timeScale 4` × 최대 60 s = 240 s 의 시뮬레이션 동안 새로 스폰되는 것까지는 막지 못한다.

---

## 2026-09-10 — 배포용 서버 툴 · 게임 내 서버 주소 · 배포 폴더 · 아이콘

`src/shared` 를 건드렸으므로 **`npm run verify:all`** (규약대로). 7분 59초, 3건 red → 원인 정리 후 재실행 all green.

```
2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
build 2,493.33 kB JS / 258.23 kB CSS, smoke-quickslots 73/73, smoke-phase2 57/57,
smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase4 49/49, smoke-tactical 87/87,
smoke-controls-hub 144/144, smoke-ship-rooms 72/72, smoke-inventory-p6 124/124,
smoke-housing 206/206, smoke-console 63/63, smoke-search 61/61, smoke-loadout 69/69,
smoke-progression 123/123, smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-uniques 72/72,
smoke-enemy-alert 42/42, smoke-rogue-v2 52/52, smoke-resume-gate 62/62, smoke-rogue-drop 29/29,
smoke-meta 172/172, smoke-training 112/112, smoke-library 126/126, smoke-enemy-delta 52/52,
smoke-ghost 86/86, smoke-raidflow 49/49, smoke-social 138/138, smoke-ecology 90/90,
smoke-planets 86/86, smoke-phase3 33/33, smoke-props-collision 20/20, smoke-structures 25/25,
smoke-server-dist ok (23/23), smoke-hazard 43/43, smoke-tutorial 83/83, smoke-hangar 58/58,
e2e-mp 156/156
```

(`smoke-loadout` · `smoke-social` · `smoke-phase3` 의 숫자는 재실행 결과다 — 아래 참고.)

### 첫 실행의 red 3건

- **`smoke-social 137/138`** — `설정` 의 좌측 레일이 **세 섹션**이라고 단언하고 있었다. 서버 설정이 네
  번째로 붙었으므로 단언을 넷으로 고쳤다. (검사가 제 일을 했다.)
- **`smoke-loadout 68/69`** — 캐릭터 삭제의 홀드 팝업을 `document.querySelector('.tm-ask')` 로 찾는데,
  `설정 › 서버 설정` 이 **자기 `AskPopup`** 을 갖게 되면서 `.tm-ask` 가 문서에 둘이 됐다. 설정 쪽이
  문서 순서상 먼저라 숨어 있는 그것을 집고 `shown:false` 로 떨어졌다. 설정의 팝업에 **`set-ask`**
  표식을 주고 그 스모크는 `:not(.set-ask)` 로 걸러 낸다 (`src/ui/README.md` 에도 적었다). 이건
  **실제 취약점**이었다 — 앞으로 전역 `.tm-ask` 로 타이틀 팝업을 찾는 코드는 같은 함정에 빠진다.
- **`smoke-phase3 26/27`** (`timeout waiting for laser ignited`, 312 s) — 아래 절에 이미 적힌 **알려진
  flaky** 다. 단독 재실행 **33/33**. 이 배치와 무관하다.

### 새 스모크 `smoke-server-dist` (23검사)

`server/` · `src/net/` 에 매핑. 브라우저 · vite · 릴레이 없이 돈다: 번들이 CJS 인지 · top-level await 이
없는지 · `ws` 가 안에 들어갔는지 · `bufferutil` 은 external 인지 → **그 번들로 서버를 켜서** `/health` ·
배너 · `--port` / `--data` · `welcome` · 로비 생성 → `relayUrlFrom` 7검사 · `lanAddresses` 4검사.
**exe 단계(postject, 86 MB)는 굽지 않는다** — 그 앞이 전부 여기서 걸린다. 자기 포트는 8830–8869 에서
고른다 (8787 릴레이 · 8790–8799 창 서버를 피한다).

### `smoke-controls-hub` 에 서버 설정 13검사 추가 (131 → 144)

설정이 네 섹션인지, 주소 칸 · 버튼 셋, 빈 칸에서 버튼 잠금, 형식이 아닌 주소 거절, 저장 키가 **슬롯
접두사 없는 `scav.relay`** 인지, `defaultUrl` 이 그 주소로 갈리는지, 닿지 않는 주소(TEST-NET-1
`192.0.2.1`)가 실패로 돌아오는지, 지금 릴레이가 응답하는지(6 ms), `기본값으로` 가 저장을 지우는지,
Escape 로 닫히는지. 이 블록은 **재접속을 실행하지 않는다** — 뒤 섹션이 쓰는 연결을 끊으므로.

### 손으로 한 것 (자동화하지 않았다)

- `npm run app:dist` 를 끝까지 돌려 `release/SCAVANGER/` 가 `app/` · `SCAVANGER.exe` · `server.txt` ·
  `SCAVANGER-Server.exe` **넷만** 담는지 확인.
- 구워진 `SCAVANGER-Server.exe` 를 **Node 없이** 실행 → 배너 · `GET /health` 확인 (`--port=8797`),
  그리고 번들 단계도 같은 방식으로 (`dist-server/server.cjs`, 8798).
- **`적용하고 다시 접속` 전체 경로**를 브라우저에서 눌러 확인 (일회용 스크립트, 커밋하지 않았다):
  분대 안에서 적용 → 경고 팝업 + `1초` 문구 → **팝업이 떠 있는 동안 저장 없음** → 취소하면 저장도
  분대도 그대로 → 다시 적용 후 0.4초에 39.6 % 채워짐 → 확정 시 저장 + 재접속 + `접속됨 · ws://…`.
  (여기서 **버그 하나를 잡았다**: 원래는 팝업을 띄우기 **전에** 주소를 저장해서, 취소해도 다음 자동
  재접속이 조용히 새 서버로 갔다. 저장을 홀드 확정 뒤로 옮겼다.)
  같은 릴레이를 가리키는 다른 주소(vite 프록시 ↔ 직접)로 옮기면 서버의 재접속 유예가 로비를 되살리므로
  분대가 유지된다 — 경고 문구는 그쪽에서 보수적으로만 틀린다(진짜 다른 서버면 떠난다).
- 아이콘 16 / 32 / 48 / 256 px 시각 확인 (`npm run icon -- --png`), stub exe 의 버전 정보
  (`FileDescription: SCAVANGER`).

**주의**: `smoke-controls-hub` 는 릴레이가 떠 있어야 한다 (원래도 `no console errors` 검사가 그랬다).
단독 실행할 때는 `npm run server` 를 먼저 켠다 — `npm run verify` 는 러너가 알아서 띄운다.

## 2026-09-10 — 플레이 피드백 배치 (실내 · 계단 · 선로 · 전차 · 인벤토리 · 루팅 · 제작 대개편)

`npm run verify:all` — **전부 통과, 9분 21초, 실패 0건.**

```
2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok,
build 2,537.79 kB JS / 259.63 kB CSS, smoke-quickslots 73/73, smoke-weapons 136/136,
smoke-phase2 57/57, smoke-stratagems 75/75, smoke-phase3 33/33, smoke-ship-rooms 72/72,
smoke-phase4 49/49, smoke-tactical 87/87, smoke-controls-hub 144/144, smoke-inventory-p6 144/144,
smoke-housing 206/206, smoke-console 63/63, smoke-progression 123/123, smoke-loadout 69/69,
smoke-search 61/61, smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-enemy-alert 42/42,
smoke-uniques 72/72, smoke-rogue-v2 52/52, smoke-rogue-drop 30/30, smoke-resume-gate 62/62,
smoke-meta 172/172, smoke-library 126/126, smoke-training 112/112, smoke-enemy-delta 52/52,
smoke-ghost 86/86, smoke-planets 86/86, smoke-ecology 90/90, smoke-social 138/138,
smoke-props-collision 20/20, smoke-raidflow 59/59, smoke-server-dist ok, smoke-hazard 43/43,
smoke-structures 67/67, smoke-tutorial 86/86, smoke-pitch ok, smoke-lights 4/4,
smoke-hangar 58/58, e2e-mp 156/156
```

늘어난 검사: `smoke-structures` 51 → **67** (전차 호출 콘솔 8건 × rail 있는 시드 2개),
`smoke-inventory-p6` 104 → **144** (내구도별 분해 · 방탄복 수리 · 구간 표시 · 정제 탭 · 정렬 · 홀드),
`smoke-tutorial` 83 → **86**, `smoke-rogue-drop` 에 강하 토스트 · 위험 인디케이터 2건.

### 검증 도중에 스모크 자체가 틀렸던 것 2건

- **`smoke-phase4` 의 "오래된 flake" 가 flake 가 아니었다** (두 번째로). 2026-09-09 에 한 번
  `if (pl.isDead) pl.respawnAt(...)` 로 고쳤는데 그것으로는 부족했다 — **사후 부활은 레이드 실패를
  되돌리지 못한다.** `player:died` → `game:raidFailed` → `phase 'dead'` + `uiBlockers` 에 `'menu'` 가
  남고, 그 뒤 `canAct()` 가 `isControlActive()` 를 보므로 `startMelee` 가 조용히 거절된다. 몸만 일으켜
  놓고 고정 시간(1.2 s)을 기다리는 방식이라 **얼마를 기다려도 통과하지 못한다**. 로그가 몇 분 동안
  쏘는 그 구간에서 **애초에 죽지 않게** 회복 가드를 걸고(그 뒤 절은 전부 적 쪽만 검사한다), 고정 대기를
  `isControlActive() && !isDead && !isDowned` 조건 대기로 바꿨다.
- **`smoke-housing` 의 가구 개수가 세 자리에 손으로 적혀 있었다.** 정제 작업대가 하나 늘자 5건이 red 가
  됐다 (`FURNITURE_DEFS 18` · `workshop 13` · 카드 13 × 3곳). 카나리아 한 줄만 literal 로 남기고
  화면 검사들은 `getFurnitureFor('workshop').length` 를 그때그때 물어서 쓴다.

### `data:check` 가 이제 경제까지 검산한다

새 csv 는 `data/salvage.csv` 하나지만(csv 39 → 40), 스키마 검사에 더해
`src/items/Salvage.checkSalvageEconomy()` 가 **분해 38종 × 내구도 5구간 × 재료 종류 전부**를 실제 정수로
돌려 네 가지를 확인한다 — ① 분해 ≤ 제작, ② 수리 + 분해 ≤ 제작(한 종류는 엄격히 작다), ③ 분해(구간 4)
− 수리(b) ≤ 분해(b) (「고쳐서 뜯기」가 「지금 뜯기」보다 이득이면 안 된다), ④ 제작에 안 쓰는 재료가
분해에서 나오지 않는다. **최악 비율 0.667** (`wpn_ar_g3` 구간 0 의 합금 판), 위반 0건.
수치를 고치고 이 검사를 통과하면 그것이 곧 증명이다.

### 손으로 하지 않은 것

이번 배치는 배포물(`electron/` · `server/tool.ts` · `scripts/pack-release.mjs`)을 건드리지 않아
`npm run app:dist` 눈 확인은 생략했다 (`smoke-server-dist` 는 러너가 돌렸다).

## 2026-09-10 — 멀티플레이 렉 (셰이더 선컴파일 · 점광원 예산 · 원격 포드 · 아바타 재사용)

`npm run verify:all -- --keep-relay --url http://127.0.0.1:5284/` — **격리 vite(5284) + 격리 인메모리 릴레이(8799)** 로
돌렸다. 같은 작업 트리에서 다른 세션이 vite 5273 · 릴레이 8787(접속 1명)을 쓰고 있어서, 러너가 8787 을 재시작하거나
e2e 빠른 매칭이 남의 로비에 들어가지 않게 했다 (격리 vite 의 `/ws` 프록시만 8799 로 돌린 설정 파일 — 스모크는 전부
같은 오리진 `/ws` 로 붙으므로 이것으로 충분하다). **6분 52초, 5건 실패** → 3건은 이번 계약 변경을 따라 스모크를
고쳐 재실행 통과, 2건은 이번 변경과 무관.

```
2026-09-10: typecheck ok, typecheck-server ok, net-selftest 295/295, data-check ok, build 2,548.83 kB JS / 259.63 kB CSS,
smoke-quickslots 73/73, smoke-phase2 57/57, smoke-weapons 136/136, smoke-stratagems 75/75, smoke-phase3 33/33,
smoke-phase4 49/49, smoke-ship-rooms 71/72, smoke-tactical 87/87, smoke-controls-hub 139/139, smoke-inventory-p6 144/144,
smoke-loadout 69/69, smoke-housing 206/206, smoke-console 63/63, smoke-progression 123/123, smoke-search 61/61,
smoke-ui-p6 88/88, smoke-ui-p5 136/136, smoke-enemy-alert 42/42, smoke-uniques 72/72, smoke-rogue-drop 30/30,
smoke-meta 172/172, smoke-resume-gate 62/62, smoke-rogue-v2 52/52, smoke-library 126/126, smoke-training 112/112,
smoke-enemy-delta 52/52, smoke-planets 86/86, smoke-social 138/138, smoke-ghost 86/86, smoke-ecology 90/90,
smoke-props-collision 29/29, smoke-raidflow 59/59, smoke-server-dist exit 1, smoke-pitch exit 1, smoke-tutorial 86/86,
smoke-hazard 43/43, smoke-structures 67/67, smoke-lights 11/12, smoke-hangar 57/58, e2e-mp 156/156
```

재실행 (`node scripts/verify.mjs --only smoke-lights,smoke-ship-rooms,smoke-hangar --keep-relay --url …5284`):

```
2026-09-10: net-selftest 295/295, data-check ok, smoke-ship-rooms 72/72, smoke-lights 12/12, smoke-hangar 58/58
```

### 계약이 바뀌어 고친 스모크 3건

- **`smoke-ship-rooms`** — "개인 함선 점광원 13" → **광원 풀 크기와 같다** (`interior.lights.size` 를 물어서 쓴다 —
  `smoke-housing` 의 가구 개수 literal 교훈).
- **`smoke-hangar`** — "격납고가 광원 9 개를 가진다" → **광원 자리 9 · 자기 광원 0** (광원은 공유 함선의 풀이 건다).
- **`smoke-lights` 4 → 12** — 로드 경계도 예외 없이 개수 불변 + 도킹 · 공유 함선 · 격납고 · 분대원 포드 구간 + 예산
  초과 · 선빌드 · 격납고 구역 · 강하 hold 해제. 첫 실행의 red 는 **세는 시점**이었다: `setInterval` 이 도킹 시작
  (네트워크 메시지 핸들러 안)과 다음 프레임의 여분 보충 사이 — 아무것도 그리지 않는 틈 — 의 25→18 을 잡았다.
  셰이더가 한 번도 보지 않은 숫자라 `scene.onBeforeRender` 에서 세도록 바꿨다 (three.js 가 광원을 모으기 직전).

### 이번 변경과 무관한 red 2건 (둘 다 커밋 `2908926` 그대로의 스크립트)

- **`smoke-pitch`** — `ROOT = 'F:/Project/Scavanger/docs/pitch'` 가 하드코딩돼 있다. 이 PC 의 저장소는 `D:` 다.
- **`smoke-server-dist`** — `address rules` 절이 `src/shared/net.ts` 를 직접 import 한다. Node 22.17 은
  `--experimental-strip-types` 없이는 `.ts` 를 읽지 못하고 러너는 스모크를 그 플래그 없이 띄운다.
  둘 다 TODO C-45 · C-46.

### 스모크 밖에서 잰 것 (헤드리스 2대 프로파일러, 격리 릴레이 — 저장소에 넣지 않았다)

50 ms 를 넘긴 프레임, 같은 PC · ANGLE D3D11:

| 순간 | 전 | 후 |
|---|---|---|
| 타이틀 → 개인 함선 | 1,649 ms | 104 ms |
| 도킹 시작 | 240 ms | 없음 |
| 공유 함선 도착 | 394 + 788 + 401 ms | 없음 (hold 19 ms) |
| 강하 시작 | 3,488 + 3,437 + 315 ms | 507 + 493 + 70 ms (앞의 둘은 hold 안: 월드 생성 CPU + 씬 컴파일 순회) |
| 분대원 포드 첫 강하 | 2,706 / 3,064 ms | 없음 |

광원 개수: 전 = 개인 27 · 컷씬 15 · 공유 29 · 행성 20 (+ 분대원 포드마다 1) → 후 = 세션 내내 23 (방향광 · 반구광 포함 25).
스크린샷 전후 비교: 개인 함선 복도 · 공유 함선 데크 · 격납고 동일, 격납고 맨 안쪽 오른쪽 벽만 약간 어둡다.
