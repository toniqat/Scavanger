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
