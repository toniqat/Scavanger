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
| B-20 | **`src/world` 주석 영문화(2026-09-18) 중 드러난 서류 결함 7건** — 번역은 원문을 그대로 옮겼으니 내용 자체를 고쳐야 한다. ① `src/world/README.md` 의 「광맥」 규칙 4번과 `Gather.ts:193` 의 `Spot.vein` doc 이 둘 다 「`GatherNodeKind` 에 vein 값이 없어 `'sample'` 을 쓰고 `gather:collected` 를 내지 않는다」고 하지만, 2026-09-16 부터 `GatherNodeKind` 에 `'mineral'` 이 있고 `Gather.collect` 는 `kind:'mineral'` 로 `gather:collected` 를 낸다(대신 `addSkillXp` 를 안 부른다). ② `Fog.ts` 머리 주석은 토스트가 탈출 콘솔 · 둥지 둘뿐이라고 하지만 바로 아래 `TOAST` 에는 `outpost`(폐허)까지 셋이다. ③ `tutorial/model.ts` 의 `BARRIER` 검산 표 · `PIT_WALL_H` · `PIT_NORTH_RIM_H` 가 옷 울타리 높이 1.35 로 계산돼 있다 — 2026-09-17 에 `fenceHeight` 가 2.025 가 되어 「수평 투척 꼭대기 1.805 는 넘는다」는 전제가 깨졌다(결론은 그대로). ④ `tutorial/parts/Dressing.ts` 의 `buildBarrier` doc 이 2026-09-15 3차에 폐기된 `BACKSTOP`(뒤쪽 콘크리트 방벽)을 아직 설명한다. ⑤ `tutorial/TutorialWorld.pollSafeGround` doc 은 「세 가지를 매 프레임 본다」면서 ①–④ 넷을 적고 접지를 「다섯째」라 부른다. ⑥ `structures/parts/Containers.ts:123` 의 블록 주석이 바로 아래 `positionOf` 가 아니라 몇 줄 밑 `markOpened` 를 설명한다. ⑦ `rails/model.ts` 의 `TramInst.consolePos` doc 이 폐기된 객실 컨테이너 설명으로 시작해 그 필드의 문서처럼 읽힌다 | `src/world/README.md` · `Gather.ts:193` · `Fog.ts:10` · `tutorial/model.ts` · `tutorial/parts/Dressing.ts` · `tutorial/TutorialWorld.ts` · `structures/parts/Containers.ts:123` · `rails/model.ts` |
| B-21 | **`src/world` 코드 잔손질 4건** — 주석 전용 커밋이라 손대지 않았다. ① `Hazard.debugPlanFor` 가 `HAZARD_FORK` 대신 `'hazard'` 를 하드코딩한다 — 그 상수의 주석이 「모든 호출자가 같은 이름을 써야 한다」고 적어 둔 바로 그 자리다(지금은 스모크 경로만 써서 깨진 것은 없으나 rename 한 번이면 조용히 갈린다). ② `rails/parts/Platform.ts:160` 의 `const total = …; void total;` 는 계산 후 버려진다(`buildStairFlight` 는 `topY`/`bottomY` 를 받는다). ③ `rails/parts/Tram.ts:239` 의 `updateTramHit(…, dt)` 는 `void dt;` 로 시작한다 — 쿨다운이 전부 `ctx.time` 절대 시각이라 dt 가 필요 없는데 호출부 둘은 계속 넘긴다. ④ `Structures.ts:45` 의 `BASEMENT_KEY_DEF` 가 「이 모듈은 더 안 읽고 `world/index.ts` 가 이름을 export 해서 남겨 됐다」고 적혀 있다 — 그 export 가 아직 있는지 확인하고 없으면 지운다 | `src/world/Hazard.ts:547` · `rails/parts/Platform.ts:160` · `rails/parts/Tram.ts:239` · `Structures.ts:45` |
| B-22 | **`smoke-rover` 5번 단언이 알 수 없는 것을 단언한다** (2026-09-18 발견 — `9e6c01d` 와 그 부모 양쪽에서 같이 red 라 그 커밋 탓이 아니다). 로버 옆 13 m 에 `warrior` 하나를 세우고 5초 뒤 「`rover:fired` 가 늘었고 **그 적의** hp 가 줄었다」를 함께 요구하는데, 포탑은 `ROVER_TURRET_RANGE` 안 **가장 가까운** 적을 골라 직접 피해를 준다(`rover/parts/Turret.ts`). 다른 벌레가 더 가깝거나, 순환 중인 로버가 세운 적을 `ROVER_TURRET_AIM_CONE` 밖 · 차폐 뒤에 두면 16~20발을 쏘고도 `hp 213 → 213` 이 되어 29/30 이 된다. 두 조건을 **같은 적**으로 재거나(`rover:fired` 의 대상 · `ts.targetId` 고정) 주변을 먼저 비워야 한다 | `scripts/smoke-rover.mjs:235` · `src/world/rover/parts/Turret.ts:82-116` |
| B-24 | **`src/enemies` 코드 잔손질 4건** — 주석 전용 커밋이라 손대지 않았다. ① 은퇴한 이름을 아직 import 한다 — `parts/Damage.ts` · `parts/Attacks.ts` · `parts/Alerts.ts` 가 `placeRogueGuards`(README 가 「retired no-op」 이라 적은 것)를 import 해 두고 부르지 않는다. `named/Director.ts` 머리 주석도 그 은퇴한 `RogueGuards` 를 근거로 든다. ② `parts/Damage.ts` · `parts/Attacks.ts` · `parts/Alerts.ts` 가 `EnemySystem.ts` 의 import 블록을 통째로 복사해 두고 대부분을 안 쓴다 (`model.ts` + `parts/*` 분할의 표류). ③ `ai/named/Sniper.ts` 의 `DRONE_PHASE_RETURN = 2` 는 `ai/named/ScanDrone.ts` 의 private `PHASE_RETURN = 2` 를 손으로 베낌 것이라 ScanDrone 의 단계 번호가 바뀌면 조용히 어긋난다. ④ `ai/GimmickAI.ts:10` 의 import 태그가 아직 「한 번만 소환」이라 적혀 있다 — 2026-09-18 에 그 제한은 없어졌고 같은 파일 본문 주석은 그렇게 적고 있다 | `src/enemies/parts/*.ts` · `named/Director.ts` · `ai/named/Sniper.ts` · `ai/GimmickAI.ts:10` |
| B-25 | **주석 안에 csv 수치를 베껴 놓은 자리 3곳** (CLAUDE.md §4.1 「코드에 숫자 없기」의 서류판 위험). `named/Director.ts` 머리의 「threat 1 = 0 · 2 = 25 % · 3 = 50 %」(살아 있는 값은 `data/tables.csv` 의 `NAMED_ROGUE_CHANCE_BY_THREAT`), `ai/named/Sniper.ts` 머리의 「150 피해」(`NAMED_SNIPER.damage`), `ai/named/Hammer.ts` 머리의 「초당 50」과 「일반 로그의 10배 체력」 — 마지막 것은 2026-09-17 전체 체력 ÷3 개편 이전 숫자라 지금도 맞는지 확인이 필요하다 | `src/enemies/named/Director.ts` · `ai/named/Sniper.ts` · `ai/named/Hammer.ts` |

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
