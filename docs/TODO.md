# SCAVANGER — 앞으로 해야 할 작업 목록

이 프로젝트의 **유일한 할 일 목록**이다. Phase 0–12 는 전부 구현 완료라(→ [HISTORY.md](HISTORY.md) 의 `완료된 단계`),
여기 남은 것이 아직 안 된 전부다. 2026-09-08 에 `docs/` 전체를 읽고 **`src/` · `server/` · `electron/` 코드와 대조**해서 뽑았다.

읽는 법:

- **묶음 4–5** = 다음 페이즈 후보. 하나가 한 번의 작업 사이클이다 (소유 폴더를 각 묶음 머리에 적었다).
  묶음 1–3 · 6 은 2026-09-14 에 끝났거나 목록에서 빼서 없다 — 폴더 README · DECISIONS · 커밋 메시지가 번호로 가리키므로 번호는 당기지 않는다.
- **묶음 7** = 페이즈로 묶지 않고 다른 작업에 얹어서 처리하는 상시 항목.
- 각 행의 **근거**는 감사에서 직접 확인한 코드 위치다. `grep 0` 이면 그 이름의 구현이 저장소에 아예 없다는 뜻.
- **`A-1` 같은 항목 ID 는 고정이다** — [DECISIONS.md](DECISIONS.md) · 폴더 README · 커밋 메시지가 이 번호로 가리킨다. 재사용하지 않는다.

작업 방식은 Phase 5 이후 계속 같다: **리드가 `src/shared` 계약을 먼저 작성 · 커밋** → 폴더별 병렬 에이전트가
자기 폴더만 소유 → `npm run verify:all`.

한 항목을 끝내면 **이 파일에서 그 행을 지우고** 커밋 메시지에 그 ID 를 적는다 (`git log --grep 'E-4'` 로 찾는다).

---

## 묶음 4 — 배포 · 안정화

혼자 놀 때는 안 보이지만, 남에게 주는 순간 드러나는 것들.
소유 폴더: `electron` · `net` · `server` · `inventory` · `shared/console.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| E-1 | **패키징된 데스크톱 앱에서도 개발자 콘솔과 치트가 열린다**. 렌더러가 `127.0.0.1` 에서 로드되므로 `isDevHost()` 가 true | `src/shared/console.ts:50` `DEV_HOSTS = ['localhost','127.0.0.1','[::1]','::1']` — 끄려면 이 판정을 셸 여부로 바꿔야 한다 |
| E-2 | **배포본의 기본 서버 주소(`server.txt`)가 IP 문자열**이라 서버 PC 의 주소가 DHCP 로 바뀌면 받는 사람마다 `설정 › 서버 설정` 을 고쳐야 한다 — 이름 기반 주소나 자동 탐색이 없다 | `electron/main.ts` `RELAY_FILES` · `src/net/parts/Socket.ts` `defaultUrl` |
| E-10 | **데스크톱 포인터 락 쿨다운 타이밍은 스모크로 못 잰다** — 숨긴 창이 락을 못 잡아 여전히 수동 확인 (실제 배포 폴더 `--release` 는 2026-09-15 에 62/62 로 닫혔다) | `scripts/smoke-desktop.mjs` |
| E-11 | **솔로 레이드 방어의 남은 틈 (E-5 뒤, 사용자 수용 범위)** — 창을 닫고 시계를 되돌려 부팅 없이 5분 안에 켜기 · 오프라인에서 로드아웃 파일의 `raidSeed` 를 지우기 · 온라인에서 로드아웃 파일을 통째로 지우면 서버의 레이드 전 킷이 돌아온다(표식이 로컬 전용). 막으려면 서버 문서 쪽 표식(= 온라인 솔로의 서버 시계 판정)이 필요하다 | `src/game/SoloRaid.ts`, `src/inventory/parts/Lifecycle.ts` |
| E-12 | **`verify:all` 이 ~17분이고 스모크가 늘어날수록 선형으로 길어진다** — 2026-09-16 에 가장 큰 낭비(`browser.close()` 가 레인을 최대 2분씩 붙잡던 멈춤, 실행의 41 %)는 `scripts/close-browser.mjs` 로 없앴다(26분 46초 → 16분 40초). 남은 시간은 스모크가 기다리는 **게임 시간**이다. `--jobs 6` 은 12분 56초지만 페이지가 20 fps 바닥(`Engine.MAX_DT`) 밑으로 더 자주 떨어져 타이밍 빨강 3개(`smoke-ladder` · `smoke-tutorial-raid` · `smoke-rover`)가 났다 — 레인을 올리려면 그 검사들을 프레임 속도에 덜 민감하게 만들거나 페이지당 프레임 비용을 낮춰야 한다. **이 수치는 16스레드 기계 기준이다** — 2026-09-17 에 28스레드(i7-14700K)에서는 9종 풀을 `--jobs 8` 로 돌려도 (`smoke-tutorial-raid` · `smoke-lights` 포함) 빨강이 없었고 `verify:all` 은 18분 54초였다. `--jobs` 는 기계마다 다시 재야 한다. 그 밖에 줄일 곳: 전체 리부트 횟수(`smoke-raidflow` 는 페이지 로드 8번) · 연출 대기 구간 · exclusive 5종이 풀 뒤에 혼자 도는 ~3.5분. **2026-09-17: 4레인 실행에서 「중간 8개만 2~2.3배」의 정체는 teardown 이었다.** `taskkill /T /F` 는 커널 대기에 걸린 chrome 을 회수하지 못해 브라우저당 2개(gpu-process + crashpad-handler)가 살아남고, `browser.close()` 는 그것들을 제한 없이 기다린다 — 그날 4레인 실행 두 번에서 **스모크 8/8 이 마지막 검사를 통과한 뒤 `N passed` 를 못 찍고 멈춘 채 30분을 넘겼고**(러너는 레인이 풀리기만 기다렸다), 그것들이 사는 동안 WMI 프로세스 열거까지 타임아웃했다. `close-browser.mjs` 가 `close()` 를 5초만 기다리고 버리며 임시 프로필을 직접 지우고(남는 것은 러너가 실행 시작에 쓸어낸다) 고친 뒤, 같은 16개 묶음의 중간 8개가 141~157초 → 64~84초(단독값)로 돌아왔다(전체 5분 6초 · 16/16). `verify:all` 은 18분 11초 전부 초록이라 **전체 시간 자체는 이전 측정(18분 54초)과 오차 범위** — 이 수정이 걷어낸 것은 정지가 난 실행의 손실이다. 번들 전환(`vite preview`)은 이미 재보고 버렸다 — 94개 중 33개가 런타임에 `/src/*.ts` 를 직접 import 하고, 이득은 리로드가 많은 소수(`smoke-loadout` 94→31초)에만 있었다 | `scripts/README.md` 「Why the run takes as long as it does」 · `scripts/verify.mjs` `opts.jobs` 주석 |
| E-14 | **`smoke-allies-orders` 의 「지시한 일을 끝낸다」가 빨간채로 재현된다 (2026-09-20)** — 안드로이드가 `state: "pickup"` · `task: "item"` 으로 (174, −243) 에 서서 가방에 6종을 담은 채로 끝나지 않는다. 연속 3회 똑같은 상태로 빨간이고, **부모 커밋(`aa04107`)에서도 항목 · 좌표까지 동일하게 빨간다** — 그날의 변경과 무관하다. 같은 날 4레인 전체 실행 두 번에서는 초록이었으니 시드/타이밍에 걸린 것이고, 단독 실행에서 경지는 쪽이 고정되어 있다 — 재현이 쉬우니 그쪽부터 볼 것 | `scripts/smoke-allies-orders.mjs` 「지시한 일」 구간 · `src/allies/parts/` 의 `pickup` 상태 |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | `scripts/lan-address.mjs` 는 LAN 주소만 찾는다 |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-10 | **document fullscreen 토글**. 이게 있어야 `navigator.keyboard.lock` 경로가 살아나 Escape 후 즉시 복귀가 가능해진다 | `grep -rn "requestFullscreen" src/ electron/` → 0 hit ⇒ `document.fullscreenElement` 는 항상 null, `Input.syncKeyboardLock` 이 죽은 코드 |
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM**. 설정의 오디오 채널 자리만 비워 뒀다 | `src/ui/menus/SettingsMenu.ts:26` "Room is left for a future BGM row … there is no BGM" |
| B-73 | **`rover:fired` 에 표적이 실려 있지 않다** — 그래서 `smoke-rover` 의 포탑 검사가 `getSystem('world').roverSys.turret` 으로 TS `private` 필드를 뚫고 들어가 사건이 오는 순간의 `turret.targetId` 를 읽는다. 값 자체는 정확하다(`updateTurretLogic` 이 `target.takeDamage(...)` 바로 다음 줄에서 `fire()` 를 부르고 버스 emit 은 동기다) — 문제는 「쏜 발」과 「맞은 몸」을 잇는 길이 그것뿐이고 `RoverRef` 에도 사건 페이로드에도 표적이 없다는 것이다. 사건에 `targetId` 를 실으면 그 검사가 공개 API 만으로 선다 (2026-09-20 B-22 가 남겼다) | `src/world/rover/parts/Turret.ts` · `scripts/smoke-rover.mjs` 5번 검사 |
| B-74 | **`check-comment-labels.mjs` 가 csv 주석 줄의 한글을 「살아 있는 문자열」로 등록해, 다른 파일의 진짜 오기를 정당화한다.** csv 는 한글 열이 실제 표시 문자열이라 파일을 통째로 live 집합에 넣는데, 그러면 `#` 주석 줄의 한글까지 들어간다. 실제로 걸린 것: `src/housing/housing.css:308` · `:443` 이 해석기 레일 탭을 `해석 도감` 이라 적지만 그려지는 문자열은 `분석 도감` 이고(`housing/ui/Analyzer.ts:109`), `data/constants.csv:818` · `data/samples.csv:31` 이 산문에서 `해석 도감` 이라 적은 탓에 검사기가 침묵했다. **두 가지가 필요하다** — 라벨 오기 3~4곳을 실제 문자열로 고치는 것, 그리고 csv 의 주석 줄을 데이터 행과 갈라 파싱하는 것. `.css` 자체는 2026-09-20 에 검사기에 들어갔다 (B-65) | `scripts/check-comment-labels.mjs` · `src/housing/housing.css` · `data/constants.csv` |
| B-75 | **CSS 주석 속 낡은 서술 3건** (2026-09-20 B-65 가 드러냈다 — 번역이 만든 것이 아니라 조용히 고치지 않고 그대로 옮겼다). `src/ui/styles/wheels.css` 머리글은 `.pwheel` 을 「좌우 2칸 + 아래 탄약 다리」로 적지만 같은 파일 87–90행이 `▼ 탄약` 다리(`.ammo-leg`)가 2026-09-10 에 없어지고 규칙 블록도 지워졌다고 적는다 · `src/ui/styles/raidHud.css` 머리글의 무기 패널 수치 「썸네일 76 px」는 14줄 아래 `.wthumb` / `.wt-icon` 이 **58px** 이라 틀렸다(2026-09-16 테두리 없는 칩 변경, 탄약 64 px 는 여전히 맞다) · `src/ui/styles/title.css` 의 `.char-create .cc-stats-wrap` 주석이 이 카드를 「가운데 열」이라 부르지만 2026-09-14 개편이 세 열을 둘로 합쳐 지금은 **왼쪽 열**이다(`.cc-main > .cc-stats-wrap`) | `src/ui/styles/` |
| B-77 | **`meta/ui/CorpView.ts` 의 「아직 꽂지 않은」 은 1 edit 오기다.** 실제로 그려지는 문자열은 `아직 꽂지 않음`(`ui/hud/ItemTip.ts:769`, `rows.push(['보관', '아직 꽂지 않음', …])`). 관형형이라 산문에서는 자연스럽지만, 그 때문에 `check-comment-labels --head` 가 1 edit 근접으로 잡고 규칙 2 의 grep 이 빗나간다. HEAD 에도 있던 것이라 번역이 만든 것은 아니다 | `src/meta/ui/CorpView.ts` · `src/ui/hud/ItemTip.ts` |
| B-78 | **`meta/ui/CorpView.ts` 의 주석과 코드가 어긋나는 곳 · 죽은 것 3건** (2026-09-20 영문화 감사, 전부 이미 영문이라 번역이 손댈 이유가 없던 줄들이다). `:656` 의 「함선 창고 \| 가방 — two cards, each its own header + scroll」은 40줄 아래의 2026-09-15 3차 사용자 결정과 정면으로 어긋난다 — `makeInvCards` 는 두 격자를 **한 카드**에 담아 길이 1 의 배열을 돌려준다 · `:2` 의 타입 import `CurrencyReward` · `QuestInfo` · `QuestState` 세 개는 import 문 자신 말고 참조가 없다(2026-09-14 「퀘스트 탭 삭제」가 남긴 것으로 보인다) · `HoldAsk.ts:23` 이 적는 대로 `meta.css` 의 `.cv-ask-hint` 규칙은 2026-09-15 2차 이후 쓰이는 곳이 없다 — 그 주석만이 이 죽은 규칙을 찾을 수 있게 해 준다 | `src/meta/ui/` · `src/meta/meta.css` |
| B-79 | **`meta/ui/TileGrid.ts` 가 같은 화면을 다른 이름으로 부른다.** `:2` · `:146` 은 *the 기업 화면*, `ui/CorpView.ts:17` 은 *the 기업 네트워크 screen*, `meta/README.md` 는 *the corp network screen* 이다. 셋 다 이미 영문이고 한글 주석이 0 줄인 파일이라 2026-09-20 영문화 패스가 건드리지 않았다 | `src/meta/ui/TileGrid.ts` |
| B-80 | **`AudioSystem.cappedVoices` 주석이 한 판 낡았다.** `:304` 는 「`VOICE_CAP` **id** 별 살아 있는 보이스」라 적지만, 2026-09-16 에 상한이 **보이스 무리**로 옮겨간 뒤로 이 `Map` 의 키는 `VOICE_GROUP[id] ?? id` 다 (`play` 의 `const group = …`). 같은 파일 바로 아래 `VOICE_GROUP` 주석과 `audio/README.md` 는 둘 다 옳게 적어 두어서, 틀린 것은 이 한 줄뿐이다. 2026-09-20 영문화 패스가 뜻을 그대로 옮겼다(고치면 주석 전용 증명이 깨진다) | `src/audio/AudioSystem.ts` |
| B-81 | **`RANGED_SOUNDS` 의 `floor` 설명이 2026-09-11 목록에서 멈췄다.** 머리글은 floor 를 가진 것이 「저격 반짝임 · 저격 · 스캔 음파」 셋뿐이라고 단정하지만, 지금 표에는 `minigun_fire` · `sandworm_rumble` · `_erupt` · `_roar` · `_death` · `rover_explode` · `shell_incoming` 까지 **열 개**가 floor 를 가진다. 판단 기준(「전조가 들려야 공정한 소리」)은 그대로 맞고 목록만 낡았다 | `src/audio/AudioSystem.ts` |
| B-82 | **`audio/README.md` 의 소리 id 표에 `thumper_thump` 가 없다.** 2026-09-15 에 진동 장치와 함께 들어온 id 인데 「Gadgets / drones / C4」 줄에 빠졌다 — `SOUNDS` 221개 중 표에 없는 유일한 하나다. `RANGED_SOUNDS` · `Synth.ts` 에는 정상적으로 있다 | `src/audio/README.md` |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | `src/ui/hud/Notifications.ts` |
| B-68 | **`src/game` 주석이 코드와 어긋나는 곳 14군데** (2026-09-20 영문화 감사). 선언이 없는 떠 있는 JSDoc(`GameFlowSystem.ts:328` — 설명하던 술어가 트리에 없다) · `parts/Phases.ts:4` 의 페이즈 나열이 `shipLanded`·`liftoff` 를 빠뜨려 `model.ts:54`·`README.md:60` 과 다르다 · `LoadGate.ts:36` `clamp01` 의 「진행도 한 사람 몫」은 순수 0..1 클램프와 무관 · `Leader.ts:8` 의 「아무나」는 `canInteract` 가 현재 호스트·사망·다운을 막는 것을 빠뜨린다 · `RaidReport.ts:222` `debugTallies()` 는 `src/`·`scripts/` 어디에도 호출자가 없는데 「스모크」라고 적는다 · `Death.ts:172` 의 「체크포인트에서 일어난다」는 12줄 위 4차 블록(그리고 `world/tutorial/TutorialWorld.ts:226`)이 금지한 표현이다 · `Death.ts:499` 의 「옛 공식이 적용된다」는 바로 다음 갈래(`xp = 0`)와 모순 · `Death.ts:87` 은 솔로 자발적 귀환이 `레이드 실패` 화면을 「거치지 않는다」고 하지만 `gameOver()` 가 실제로 띄운다(같은 파일 `:253` 은 맞게 적는다) · `Corpses.ts:6` 헤더는 아직 「수명도 거리 컬링도 없다」인데 2026-09-16 이후 빈 시체는 가라앉아 사라진다 · `:430` 은 `markEmptied` 라 적고 실제로는 `releaseEmptied` 를 부른다(방송 여부가 다르다) · `:540` 의 호출자 목록에 `update` 가 빠졌다 · `Corpses.ts:65` 와 `CorpseNet.ts:56` 의 두 헤더가 컨테이너 생성 시점을 다르게 말한다 · `CorpseNet.ts:146` 은 방송 주체를 호출자로 적어 `isAuthority` 조건을 가린다 · `README.md` 의 튜토리얼 「강제 저장 없음, 세이브 유지」는 파일 주석의 「솔로 가드를 통과시킨다」와 같은 사실의 다른 모양 | `src/game/**` |
| B-69 | **파일 분할이 남긴 죽은 import 89개.** `GameFlowSystem` → `model.ts` + `parts/*` 로 쪼갤 때 import 블록을 통째로 복사해, `model.ts` 24 · `parts/Death.ts` 27 · `parts/Session.ts` 27 · `parts/Phases.ts` 19 · `parts/Wire.ts` 19 개 이름이 그 파일에서 한 번도 쓰이지 않는다. `noUnusedLocals` 가 꺼져 있어 `tsc` 가 영영 잡지 못한다. `import { ResumeGate, installDesktopRelockHook, syncDesktopCursor }` 한 줄은 다섯 파일에 그대로 복사돼 있는데 실제로 쓰는 곳은 `GameFlowSystem.ts` 뿐이고, `model.ts` 가 형제 모듈을 **값**으로 import 하는 것 자체가 CLAUDE.md §4.1 의 `parts/` 규칙과 어긋난다 | `src/game/model.ts` · `src/game/parts/*.ts` |
| B-70 | **csv 수치를 산문에 베껴 둔 곳 5군데** (하나는 스모크에도 있다). `LoadGate.ts:346` 「60 초」(`RAID_LOAD_TIMEOUT_S`, `data/constants.csv:1227`) — 같은 문장이 `scripts/smoke-raid-loading.mjs:135` 에도 있다 · `Leader.ts:216` 「3초 홀드」(`LEADER_DEVICE_HOLD_S`, `:592`) · `Death.ts:79` 「2.5 s」(`model.ts` `DEATH_TO_SCREEN`) · `Death.ts:494` 「`XP_BASE` 와 같은 값이라 정확히 Lv.2」(둘 다 120) · `Corpses.ts:563` 「닫은 뒤 1 초」(`CORPSE_EMPTY_REMOVE_DELAY_S`, `:100`). 전부 오늘은 맞고, csv 를 튜닝하는 순간 거짓이 된다. B-67 과 같은 부류다 | `src/game/**` · `data/constants.csv` |
| B-71 | **`PlayerCorpseManager.netUnsub` 이 한 번도 호출되지 않는다 — `pcorpse` 구독이 두 개인데 해제되는 건 하나뿐.** `Corpses.ts:392` 가 `pcorpse` 를 따로 구독해 `netUnsub` 에 담지만 부르는 곳이 없다: `clear()`(`:597`)는 나머지를 다 비우면서 이것만 남기고, `PlayerCorpseManager` 에는 `dispose()` 가 없다(`:322` 는 `PlayerCorpseObject` 것). `GameFlowSystem.dispose` 가 푸는 것은 `sys.corpseUnsubs`(`parts/CorpseNet.hookCorpseNet`)로 **다른** 구독이다. 게다가 `update`(`:566`)가 `if (!this.netUnsub)` 로만 재훅하므로 `ctx.net` 이 **교체되면** 영영 재구독되지 않는다 — 형제인 `shared/corpseViewers.ts:163` `CorpseViewTracker.hookNet` 은 `hookedNet` 을 들고 새 `NetRef` 에 다시 붙어 정반대로 동작한다. 매니저가 시스템당 하나라 오늘은 잠복이다 | `src/game/Corpses.ts` · `src/shared/corpseViewers.ts` |
| B-72 | **`emptied` 의 호스트 전용 가드에 `from === undefined` 구멍.** `parts/CorpseNet.ts:68` 은 `if (hostId && from !== undefined && from !== hostId) return;` 이라, 로비가 있는데도 `from` 이 없는 `pcorpse emptied` 는 통과해 시체를 치운다(`releaseEmptied`). 바로 위 주석은 「로비가 없으면(스모크) 비교하지 않는다」만 적고 이 경우를 말하지 않는다. CLAUDE.md §4.3 은 빈 시체 판정을 호스트만 하도록 못박는다 | `src/game/parts/CorpseNet.ts` |

## 묶음 7 (상시) — 밸런스 · 튜닝

지금은 비어 있다 — 2026-09-14 에 수치 줄 D-1 … D-6 · D-9 … D-12 는 사용자 결정으로 뺐고, 2026-09-15 에 남은 시각 잔손질
D-7(병사 림) · D-8(드랍쉽 그리블)을 끝냈다. 실플레이 뒤 튜닝 항목이 생기면 D-13 부터 잇는다.

---

## 이 문서를 갱신할 때

```
grep -rn "<이름>" src/ server/ electron/ --include=*.ts     # 구현 존재 확인
grep -rniE "TODO|FIXME|미구현|다음 업데이트" src/ server/     # 코드가 스스로 신고한 구멍
```

**이 문서는 할 일만 담는다.** 새로 생긴 것이 실제로 **할 일**이면 묶음에 행을 넣고, 해결되면 지운다 — 기록은 커밋 메시지가 한다.
"이렇게 하기로 했다"(바꾸려면 결정이 먼저인 의도된 한계)는 여기가 아니라 **그 기능을 가진 폴더의 `README.md`**(`## Rules` · `## Notes` ·
`## Known limits`)에, 수치 · 절차의 이유는 **그 코드 바로 위 주석**에 적는다. 검증 도구 · 스모크의 빈틈은 [`scripts/README.md`](../scripts/README.md) 가 갖는다.
새 항목의 ID 는 그 계열의 다음 번호로 이어 붙인다 (지운 번호는 재사용하지 않는다).
