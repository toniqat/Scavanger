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
| E-13 | **`smoke-desktop` 이 `verify:all` 안에서만 빨갛다 — 2026-09-17 재현 실패, 원인 미상** — 증상은 `9340/json/version 이 45 초 안에 응답하지 않았다` 이고, 점수 `5/6`(준비 3 + 정리 2)으로 **boot A 의 `attach`** 에서 죽은 것이 확정된다(나머지 45개 검사는 돌지도 못한다). 2026-09-16 실패 3번의 로그는 남아 있지 않다 — 기본 로그 폴더를 그 뒤 단독 재실행(50/50)이 덮었다. 2026-09-17 재조사: 28스레드 기계에서 `verify:all` 1회 **50/50**, 부팅(→ 9340 응답)은 유휴 0.2–0.7 s · 8레인 스모크 부하 중에도 0.3–0.5 s 라 **부하로 느려져 45 s 를 넘는 종류의 실패가 아니다**(원래 측정은 16스레드 기계였다). 재발하면 스스로 설명하도록 실패 경로에 진단을 심었다(`bootDiag`: 포트를 누가 듣는지 · 프로세스 생존 · 마지막 fetch 오류 · 45 s 를 넘겨 120 s 를 더 기다려도 뜨는지)와, 빨간 실행의 로그 사본(`<log-dir>/failed/`)을 남기게 했다. **다음 빨강의 로그를 보고 잇는다** (2026-09-17 추가: 같은 날 E-12 에서 밝힌 teardown 정지 — 죽지 않는 chrome 이 있는 동안 프로세스 열거가 전역으로 멈춘다 — 가 `attach` 의 45초를 먹었을 수 있으므로, 다음 빨강에서는 남은 chrome 프로세스도 같이 본다) | `scripts/smoke-desktop.mjs` `attach` · `bootDiag` · `scripts/verify.mjs` 꼬리의 `failed/` 복사 |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | `scripts/lan-address.mjs` 는 LAN 주소만 찾는다 |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-10 | **document fullscreen 토글**. 이게 있어야 `navigator.keyboard.lock` 경로가 살아나 Escape 후 즉시 복귀가 가능해진다 | `grep -rn "requestFullscreen" src/ electron/` → 0 hit ⇒ `document.fullscreenElement` 는 항상 null, `Input.syncKeyboardLock` 이 죽은 코드 |
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM**. 설정의 오디오 채널 자리만 비워 뒀다 | `src/ui/menus/SettingsMenu.ts:26` "Room is left for a future BGM row … there is no BGM" |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | `src/ui/hud/Notifications.ts` |
| B-22 | **`smoke-rover` 5번 단언이 알 수 없는 것을 단언한다** (2026-09-18 발견 — `9e6c01d` 와 그 부모 양쪽에서 같이 red 라 그 커밋 탓이 아니다). 로버 옆 13 m 에 `warrior` 하나를 세우고 5초 뒤 「`rover:fired` 가 늘었고 **그 적의** hp 가 줄었다」를 함께 요구하는데, 포탑은 `ROVER_TURRET_RANGE` 안 **가장 가까운** 적을 골라 직접 피해를 준다(`rover/parts/Turret.ts`). 다른 벌레가 더 가깝거나, 순환 중인 로버가 세운 적을 `ROVER_TURRET_AIM_CONE` 밖 · 차폐 뒤에 두면 16~20발을 쏘고도 `hp 213 → 213` 이 되어 29/30 이 된다. 두 조건을 **같은 적**으로 재거나(`rover:fired` 의 대상 · `ts.targetId` 고정) 주변을 먼저 비워야 한다 | `scripts/smoke-rover.mjs:235` · `src/world/rover/parts/Turret.ts:82-116` |
| B-26 | **`e2e-mp` 의 분대 패널 단언이 기다리지 않는다** (2026-09-19 전체 선택 `verify`(96개) 에서 178/179, 재실행은 179/179). `e2e-multiplayer.mjs:298` 은 `waitFor` 로 `ctx.net.lobby` 에 바뀐 이름이 들어온 것만 확인하고 바로 `#ui-root .squad` 의 `textContent` 를 읽는다 — HUD 패널은 제 주기로 다시 그리므로 부하가 걸리면 아직 옛 이름이다. 그 구간에서 기다리지 않는 유일한 검사다. `waitFor` 로 감싸면 된다 | `scripts/e2e-multiplayer.mjs:298` · `docs/VERIFICATION.md` 「Known flakes」 |
| B-27 | **`src/ui` 주석이 코드와 어긋난 곳 12군** (2026-09-18 영문화가 드러냈다 — 번역은 그대로 옮기기만 했다). 수가 상한다: `PauseMenu.skipAsk` 「나머지 둘」은 이제 셋(`ship` · `build` · `raid2`) · `SettingsMenu.buildNetwork` 가 한 줄 안에서 `.tm-ask` 를 「둘」과 「셋 중」으로 동시에 읽는다 · `DangerIndicators` 클래스 주석 「대상 셋」 아래 불릿이 다섯개. 라벨이 옆다: `ShipManage:153`·`:1247` 의 `빈 방으로` 는 2026-09-12 부터 `시설 제거` · `HazardHud` 배너 예시 `<이름> 접근` 는 실제로 `<이름>이/가 다가온다`. 가리키는 것이 없다: `mealText` 머리가 사라진 `hud/MealBadge` 를 · `OffscreenIndicators` 가 2026-09-10 에 `DangerIndicators` 로 간 `.oarrow.drop` · `.call.airstrike` 를. 규칙과 어긋난다: `SpectateOverlay:74` 의 「사람이 전원 사망하면 레이드 실패」 는 지금 CLAUDE.md §3.2(사람 **그리고** 안드로이드 전부) 와 다르다. 자리가 틀리다: `Squad:50` 은 `Vitals` 가 「크로스헤어 아래」라고 하지만 좌측 하단(`.hud-bl`) 이다. 더 있다: `TitleMenu.quit` 「같은 다섯 줄」(PauseMenu 쪽이 한 줄 더 길다) · `ChatTab.onShow` 가 「입력칸에 초점」을 적어 두고 `focus()` 를 부르지 않는다 · `Notifications:336` 의 합류 줄 번호 `:83` 은 지금 162 라 번역 때 번호를 떼다 | `git log -- src/ui` 의 2026-09-18 주석 영문화 커밋 |
| B-28 | **`src/ui` 코드 잔손질 6건** (같은 패스가 찾았고 일부러 고치지 않았다 — 커밋은 주석만으로 증명되어야 했다). 동작 버그 하나: `ChatTab:894-901` 에서 단체방 「초대 중 n」 머리는 `list.push` 하면서 그 아래 `.ms-member.is-pending` 행은 만들기만 하고 `list` 에 넣지 않는다 — 머리만 뜨고 아래가 비어 보인다. 나머지는 죽은 코드다: `ShipManage.missingText`(2026-09-15 `craftBlock` 이 고정 문자열로 바뀜 뒤 호출자 0) · `ChatTab.renderRoom` 의 `const main = …; void main;` · `Compass.update` 의 `const yaw = player.yaw; … void yaw;`. 모양만 깨졌다: `DangerIndicators:107` 클래스 주석 안에 ` *` 접두어 없는 빈 줄 하나 | 버그는 `src/ui/menus/messenger/ChatTab.ts:894` |
| B-29 | **`src/ui/map/QuestPanels.ts` 에 날 NUL 바이트 둘**(HEAD 에도 있는 기존 상태). `sig` 사열을 `' '` 이 아니라 진짜 U+0000 두 글자로 들고 있어 git · `grep` · `rg` 가 이 파일을 **바이너리로 분류한다** — 트리 전체를 평범하게 grep 하는 감사가 이 파일만 조용히 건너뛴다. 같은 파일 안 `MapTutorialPanel` 은 같은 「불가능한 서명」을 `' '`(공백)으로 쓴다 — 둘 중 하나로 통일하면서 NUL 을 없앤다 | `src/ui/map/QuestPanels.ts:179`·`:262` (공백은 `:89`·`:125`) |
| B-30 | **주석 속 csv · 상수 수치 4곳** (B-25 와 같은 계열). `StratagemPanel` 클래스 주석이 「구조선 30 · 보급품/트라이포드 90 · 권도 폭격 120」(= `data/stratagems.csv` `cooldown`) 을, `mealText:71` 이 `COOK_STEPS_MAX` 값 3 을, `ItemTip:630` 이 `items.csv` 무게 「표창 0.02 · 탄띄 0.0075」 를, `ShipManage:1126` 이 `purposeGeneratorLevel` 게이트 표를 산문으로 반복한다 — 모두 같은 문장이 이미 출처를 가리키고 있으므로 수치만 빼면 된다 | `git log -- src/ui` 의 2026-09-18 커밋 |
| B-31 | **`smoke-phase3` 의 레이저 구간이 레이드가 끝난 것을 감지하지 않는다** (2026-09-18 측정 — `f23f444` 에서 3회 중 3회 red, 부모 커밋의 `src/ui` 로 되돌려도 같이 red 라 그 커밋 탓이 아니다). 「권도 폭격 톡이 끝났다」를 기다리는 동안 `timeScale 4` 구간에서 플레이어가 죽을 수 있고, 그러면 레이드가 끝나 호출 목록이 비워져 기다리던 이벤트가 영원히 안 온다 — 실측 로그가 `{"phase":"hub","calls":[]}` 로 이미 함선이다. 대기문이 「끝났다」 외에 「레이드가 끝났다(페이즈가 게임플레이를 떠났다)」도 종료 조건으로 받아 **명시적으로 실패/건너뛰기** 하거나, 레이저 구간 전에 주변 적을 지우면 된다. B-22 와 같은 계열(단언이 자기가 재는 것을 묶어 두지 않았다) | `scripts/smoke-phase3.mjs` 의 laser 구간 · `docs/VERIFICATION.md` 「Known flakes」 |
| B-32 | **`src/housing` 주석이 코드와 어긋난 곳 18군** (2026-09-19 영문화가 드러냈다 — 번역은 그대로 옮기기만 했다). 이름이 없다: `parts/Cooking.ts:17`·`:42`·`:201` 이 사라진 인벤토리 메서드 `completeCook` 을 가리킨다(지금은 `consumeCookInputs`) · `parts/Mining.ts:184` 의 `settle` 주석이 만들 수 없는 `−1` 반환을 설명한다(실제 반환은 `{ units, touched }`). 자리가 틀리다: `parts/Cooking.ts:87-90` 블록은 `cookRecipeOf` 를 설명하면서 `cookSkillLabel` 위에 붙어 있고 `cookRecipeOf` 에는 주석이 없다. 옛 모양이다: `ui/cook/CookScreen.ts:10-13` 은 입력을 `.cook-stage` 에서 받는다고 하지만 2026-09-14 부터 오버레이 전체다(같은 파일 `:638` 이 그렇게 적어 뒀다) · `ui/cook/CookStation.ts:178` 은 「레일에서 고른다」지만 레일은 2026-09-15 3차부터 `hidden` 이다 · `ui/StationShell.ts:153` 의 54/46 px 기준은 「카드 셋이 1440 px 에 선다」를 전제하는데 3차에서 창고+가방이 한 카드가 됐다(열두 줄 위 머리말은 이미 둘이라고 적는다). 문장이 끊겼다: `parts/Library.ts` 매체 절 머리의 보조 가구 문장이 술어 없이 끝나 같은 파일 `:549` · README · CLAUDE.md §4.8 과 반대로 읽힌다. 화면마다 이름이 다르다: 같은 게임 디스크가 서재 화면에서는 `호흡 달리기형` · `사이클링형`(`GYM_MINIGAME_LABEL_KO`), TV 화면에서는 `호흡형` · `사이클형`(`GAME_MINIGAME_LABEL_KO`) 이고 `gameMinigameLabel()` 의 폴백은 `형` 도 안 붙인 세 번째 변종이다. 이유가 낡았다: `ui/mining/common.ts:15` 는 채굴 계약 메서드가 전부 옵셔널인 이유를 「병렬로 짓는 폴더가 아직 없을 수 있다」로 적지만 그 이유는 끝났다(옵셔널인 것 자체는 `shared/housing.ts:2061` 에서 여전히 사실이다). 한 머리말 안에서 서로 반대다: `parts/Culture.ts` 머리말의 2026-09-11 문단은 「배지가 0 이 되면 칸이 비워진다」, 여덟 줄 아래 2026-09-13 문단은 「0 이 돼도 비지 않는다」라고 적는다 — 코드는 뒤쪽이고, **같은 옛 문장이 이미 영문화된 `src/shared/housing.ts` 배양조 절에도 있다**(고치려면 두 파일이다). 함수가 더 이상 그 일을 하지 않는다: 같은 파일 `insertStrain` 주석은 「`readyAt` 을 여기서 확정한다」지만 2026-09-17 뒤로 그 함수는 `startedAt` · `readyAt` 을 지우고 `startCulture` 가 확정한다. `ShipState.ts` 넷: `:318` 의 식탁 설명 블록이 `sanitizePlate` 위에 붙어 그 함수는 주석이 둘이고 정작 `isDiningTableDefId` 는 없다 · `:145` 는 새 함선을 「방 **열** 개」라고 하지만 `SHIP_ROOM_COUNT` 는 v8(2026-09-12)부터 8 이고 같은 머리말이 그렇게 적는다 · `:49` 는 「계약의 `SHIP_STATE_VERSION` 은 **이제** 3」이라고 현재형으로 적지만 지금은 14 다 · `loadState` 의 주석(`:1023`)은 반환의 `refund` · `migrated` · `granted` 만 적고 나중에 붙은 `evicted` · `removedByGenerator` 를 적지 않는다 | `git log -- src/housing` 의 2026-09-19 주석 영문화 커밋 |
| B-33 | **`src/housing` 죽은 코드 8건** (같은 패스가 찾았고 일부러 고치지 않았다 — 커밋은 주석만으로 증명되어야 했다). `ui/gym/GymScreen.ts:418`·`:422` 는 바이트까지 같은 줄이라 `ruleText` 의 게임 모드 갈래가 `press` 에서 아무 일도 하지 않는다. `ui/cook/CookScreen.showResult:500` 은 `landed === 'bag' → 가방` · `'stash' → 함선 창고` 를 아직 매핑하지만 2026-09-16 접시 모델 뒤로 `completeCookRun` 은 `'table'` 아니면 `null` 만 넣고 `CookResult.itemUid` 는 생성 지점에서 늘 `null` 이다. `ui/cook/CookStation.rowRank` 의 `locked` · `book` 항은 `refresh` 가 그 줄들을 먼저 걸러 내므로 그 경로에서 죽어 있다. `ui/ShelfDrawing.ts:42` `SHELF_COLS` 는 스스로 「부르는 곳 없음」이라 적은 순수 미사용 export 다(`src/shared` 만 추가 전용이다). `parts/Presets.ts` 의 은퇴 스텁은 `… && false` · `… ? null : null` 로 결과가 무의미한 식을 계산한다. `parts/Mining.ts:279` `ComputeClusterInfo.power` 는 2026-09-13 전력 폐지 뒤 늘 0 이고 읽는 소비처가 없다(세이브 필드가 아니라 은퇴시킬 수 있다). `parts/Lab.ts` `analysisEstimateMs` 는 스스로 「분석 화면의 추정치」라고 광고하지만 `src/` · `server/` · `scripts/` 어디에도 호출자가 없다 — 화면은 `info.remainingS` 로 센다. `ui/GrowStation.ts:527` 의 `if (locked) continue;` 갈래와 `.is-locked` 스타일은 2026-09-13 결정으로 세 층이 Lv.1 부터 전부 열린 뒤로 실플레이에서 닿지 않는다(계약의 `getGrowSlots` 는 아직 `locked` 를 낸다 — 지우기 전에 확인할 것) | 버그 아님 · 정리 대상 |
| B-34 | **`src/housing` 동작이 의심스러운 곳 6건** (같은 패스). 점수가 샌다: `parts/CookGames.StirfryGame.score` 는 `cookJudgeAverage(this.judgements, this.judgements.length)` 라 분모가 **판정된 클릭 수**다(`chop` · `grill` 은 고정 `total`) — 한 번 완벽하게 누르고 `maxTime` 까지 가만히 있으면 1.0 이 나온다. 연출이 빠진다: `GrillGame.onPiece` 는 이미 늦은 조각을 뒤집지 않은 채 집으면 `flipQ = 'miss'` 를 적고 `judge('miss')` 를 하면서 `beat('flip','miss')` 는 내지 않아 허브 손 · 무대가 그 뒤집기를 재생하지 않는다. 전역 상태다: `parts/Deliver.blockedCell` 은 모듈 변수인데 `noRoomReason()` 이 인자 없이 읽는다 — 「바로 뒤에 묻는다」는 규약을 아무도 강제하지 않아 두 패널이 같은 태스크에서 배달하면 서로의 사유를 읽는다(바로 옆 `dropCell` 은 `withDropCell` 의 `finally` 가 강제한다). 답이 어긋난다: `parts/Library.booksBlock` 은 모르는 def 를 2칸, `shelfBlock` 은 같은 상황을 4칸으로 어림해 같은 아이템에 두 사유가 다르다. 같은 문장이 두 번 적혀 있다: `parts/VideoGame.ts:171`·`:184` 이 `게임기를 돌려줄 함선 창고 자리가 없습니다 — 게임기를 먼저 빼세요` 를 상수 없이 인라인으로 두 번 쓴다(옆 폴더의 `BOOKS_BLOCK_REASON` · `SHELF_BLOCK_REASON` 과 다르다). 계약과 구현이 아슬아슬하다: `ShipState.placeCockpitDecor` 는 「하나라도 놓았으면 true」가 계약인데 은퇴하지 않은 꾸밈 가구마다 **놓을지 창고로 보낼지 정하기 전에** `changed = true` 를 세운다 — 지금 옳은 것은 두 갈래가 모두 무언가를 하기 때문뿐이다 | `src/housing/parts/CookGames.ts` · `Deliver.ts` · `Library.ts` · `VideoGame.ts` · `ShipState.ts` |
| B-35 | **`src/housing` 주석 속 수치 · 세션 흔적 9곳** (B-25 · B-30 과 같은 계열). csv 수치를 산문이 베꼈다: `ui/mining/ComputerPages.ts:19` 의 `STALE_MS` 주석이 `(30 s · 10 s → 25 s)` 로 `CRYPTO_QUOTE_WINDOW_S` · `CRYPTO_TICK_S` 값을 적어 둔다(바로 옆 줄이 「수치는 `data/tuning.csv` 에서 온다」고 말한다) · `parts/CookGames.ts:56` 이 허브 국자가 마지막 `stir` 뒤 도는 시간을 `0.45 s` 로 적는다(그 값은 `hub/` 에 있고 여기서 유도하지 않는다) · `parts/Lab.ts` 머리말 ② 가 `ANALYSIS_SAMPLE_LEVEL_FIRST`(+3 %) · `_STEP`(+0.5 %) 을, `ui/GrowStation.ts` 클래스 머리말이 `GROW_STATION_SPEED_PER_LEVEL`(레벨당 +15 %) 을 적는다. 계약에서 유도되는 표를 산문이 베꼈다: `parts/Lab.ts` 머리말의 「Lv.1 = 2 · Lv.2 = 3 · Lv.3 = 4 칸」 과 `parts/Culture.ts` 머리말의 「Lv.1 = 1 … Lv.3 = 3 칸」 은 `shared/housing.ts` 의 `analyzerSlotsForLevel` · `cultureSlotsForLevel` 이 이미 정하고 적어 둔 것이다. 세션 흔적이 남았다: `MiningRules.ts:4-5` 는 파일이 갈라진 이유를 「`Rules.ts` 는 배치 규칙 **에이전트**의 파일이라」로, `ui/mining/common.ts:11` 은 규칙이 「`ctx.housing`(**에이전트 ③**)」에서 온다고 적는다 — 코드 불변식이 아니라 그날의 작업 분담이라 그 세션 밖에서는 뜻이 통하지 않는다. 모양만: `parts/Library.ts` · `parts/Furniture.ts` · `parts/Rooms.ts` 의 `export function` 약 60개가 닫는 괄호를 두 칸 들여 `  }` 로 닫아 중첩이 어긋나 보인다 · `ShipState.ts` 의 v1→v14 버전 이야기가 `const SAVE_DELAY_MS = 350;`(`:103`) 에 두 동강 나 v1…v11 · 상수 · v12…v14 로 읽힌다(상수를 머리말 위로 올리면 한 덩이가 되지만 코드 이동이라 영문화 커밋에서 못 한다) | `git log -- src/housing` 의 2026-09-19 커밋 |

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
