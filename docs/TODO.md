# SCAVANGER — 앞으로 해야 할 작업 목록

이 프로젝트의 **유일한 할 일 목록**이다. Phase 0–12 는 전부 구현 완료라(→ [HISTORY.md](HISTORY.md) 의 `완료된 단계`),
여기 남은 것이 아직 안 된 전부다. 2026-09-08 에 `docs/` 전체를 읽고 **`src/` · `server/` · `electron/` 코드와 대조**해서 뽑았고,
**2026-09-21 에 남은 행 전부를 코드와 다시 대조했다** (끝난 행 삭제 · 낡은 근거 정정 · 재현 확인).

읽는 법:

- **묶음 4–5** = 다음 페이즈 후보. 하나가 한 번의 작업 사이클이다 (소유 폴더를 각 묶음 머리에 적었다).
  묶음 1–3 · 6 은 2026-09-14 에 끝났거나 목록에서 빼서 없다 — 폴더 README · DECISIONS · 커밋 메시지가 번호로 가리키므로 번호는 당기지 않는다.
- **묶음 7** = 페이즈로 묶지 않고 다른 작업에 얹어서 처리하는 상시 항목.
- 각 행의 **근거**는 감사에서 직접 확인한 코드 위치다. `grep 0` 이면 그 이름의 구현이 저장소에 아예 없다는 뜻.
- **줄 번호는 적은 날의 것이라 밀린다** — 2026-09-20 주석 영문화처럼 주석을 재배치하는 커밋 하나가 한 파일의 번호를
  통째로 1~20줄 움직인다. 행이 **따옴표로 인용한 문구**가 진짜 표식이니, 번호가 안 맞으면 그 문구로 grep 한다.
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
| E-12 | **`verify:all` 이 ~17분이고 스모크가 늘어날수록 선형으로 길어진다** — 2026-09-16 에 가장 큰 낭비(`browser.close()` 가 레인을 최대 2분씩 붙잡던 멈춤, 실행의 41 %)는 `scripts/close-browser.mjs` 로 없앴다(26분 46초 → 16분 40초). 남은 시간은 스모크가 기다리는 **게임 시간**이다. `--jobs 6` 은 12분 56초지만 페이지가 20 fps 바닥(`Engine.MAX_DT`) 밑으로 더 자주 떨어져 타이밍 빨강 3개(`smoke-ladder` · `smoke-tutorial-raid` · `smoke-rover`)가 났다 — 레인을 올리려면 그 검사들을 프레임 속도에 덜 민감하게 만들거나 페이지당 프레임 비용을 낮춰야 한다. **이 수치는 16스레드 기계 기준이다** — 2026-09-17 에 28스레드(i7-14700K)에서는 9종 풀을 `--jobs 8` 로 돌려도 (`smoke-tutorial-raid` · `smoke-lights` 포함) 빨강이 없었고 `verify:all` 은 18분 54초였다. `--jobs` 는 기계마다 다시 재야 한다. 그 밖에 줄일 곳: 전체 리부트 횟수(`smoke-raidflow` 는 페이지 로드 8번) · 연출 대기 구간 · exclusive 5종이 풀 뒤에 혼자 도는 ~3.5분. **2026-09-17: 4레인 실행에서 「중간 8개만 2~2.3배」의 정체는 teardown 이었다.** `taskkill /T /F` 는 커널 대기에 걸린 chrome 을 회수하지 못해 브라우저당 2개(gpu-process + crashpad-handler)가 살아남고, `browser.close()` 는 그것들을 제한 없이 기다린다 — 그날 4레인 실행 두 번에서 **스모크 8/8 이 마지막 검사를 통과한 뒤 `N passed` 를 못 찍고 멈춘 채 30분을 넘겼고**(러너는 레인이 풀리기만 기다렸다), 그것들이 사는 동안 WMI 프로세스 열거까지 타임아웃했다. `close-browser.mjs` 가 `close()` 를 5초만 기다리고 버리며 임시 프로필을 직접 지우고(남는 것은 러너가 실행 시작에 쓸어낸다) 고친 뒤, 같은 16개 묶음의 중간 8개가 141~157초 → 64~84초(단독값)로 돌아왔다(전체 5분 6초 · 16/16). `verify:all` 은 18분 11초 전부 초록이라 **전체 시간 자체는 이전 측정(18분 54초)과 오차 범위** — 이 수정이 걷어낸 것은 정지가 난 실행의 손실이다. 번들 전환(`vite preview`)은 이미 재보고 버렸다 — 94개 중 33개가 런타임에 `/src/*.ts` 를 직접 import 하고, 이득은 리로드가 많은 소수(`smoke-loadout` 94→31초)에만 있었다. **2026-09-21 (16스레드 · `--jobs 4` · 깨끗한 환경): 16분 6초, 103개 중 `smoke-aim-sway` 하나만 빨강(문서에 적힌 그 플레이크)** — 2026-09-16 의 16분 40초와 오차 범위이고, 그 사이에 늘어난 스모크만큼은 teardown 수정이 벌어 준 셈이다 | `scripts/README.md` 「Why the run takes as long as it does」 · `scripts/verify.mjs` `opts.jobs` 주석 |
| E-14 | **`smoke-allies-orders` 의 「지시한 일을 끝낸다」가 단독 실행에서 고정으로 빨갛다 (2026-09-20, 2026-09-21 재확인)** — 안드로이드가 `state: "pickup"` · `task: "item"` 으로 (174, −243) 에 서서 가방에 6종을 담은 채로 끝나지 않는다. 연속 3회 똑같은 상태로 빨간이고, **부모 커밋(`aa04107`)에서도 항목 · 좌표까지 동일하게 빨간다** — 그날의 변경과 무관하다. **2026-09-21 에 커밋 `3762938` 에서 다시 단독으로 돌려도 좌표(174.02, −243.72) · 가방 6종 · `state` 까지 같은 빨강이고(24 ok / 1 failed), 같은 날 `verify:all` 안에서는 또 초록이었다** — 커밋이 아니라 단독이냐 4레인이냐가 가르는 것이 확실해졌으니, 실행 방식이 무엇을 바꾸는지(프레임 예산 · 시드 · 다른 스모크가 남긴 상태)부터 볼 것 | `scripts/smoke-allies-orders.mjs` 「지시한 일」 구간 · `src/allies/parts/` 의 `pickup` 상태 |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | `scripts/lan-address.mjs` 는 LAN 주소만 찾는다 |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM 이 소리가 아니라 상태다.** 설정의 `음악` 슬라이더도 함선의 음악 플레이어도 2026-09-14 부터 **있지만**, `bgm` 채널에는 연결된 것이 없어 값만 저장 · 표시된다. 트랙을 붙이면 그 두 화면은 그대로 쓸 수 있다 | `src/ui/menus/SettingsMenu.ts` `CHANNELS` 에 `bgm` 이 있다 · `housing/parts/Music.ts` · `ui/hud/MusicPlayer.ts` (CLAUDE.md §4.8 「Music is state, not sound」) |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | `src/ui/hud/Notifications.ts` |
| B-90 | **`server/CryptoMarket.ts` 머리말의 `import.meta` 근거가 낡았다.** 「no `import.meta` (the shipped exe's bundle was CJS)」라고만 적는데, `Economy.ts` 머리말은 같은 규칙에 대해 **2026-09-15 에 그 exe 가 폐기됐다**는 사실까지 적는다. 한 규칙을 두 파일이 다른 시점의 사실로 설명한다 | `server/CryptoMarket.ts` · `server/Economy.ts` |
| B-91 | **스모크 헤더가 제 코드와 어긋난 곳 일곱.** `smoke-tutorial-raid.mjs` 머리말은 레이드 트랙이 **15** 단계라는데 `RAID_STEPS` 는 16 이고 단언은 `RAID_STEPS.length` 를 찍는다 · `smoke-structures.mjs` 검사 3 은 「방 가운데는 안 밀리고 **벽 가운데는 밀린다**」고 약속하지만 `inside` 는 자유 바닥 비율(`centreMove`)과 사격 차단 레이만 잰다 · `smoke-hangar.mjs` 머리말은 공용 함선 후미 `자동문` 을 검사 항목으로 광고하는데 `:171` 은 「2026-09-16 에 없앴다」고 적고 지금은 통로가 열려 있는지만 본다 · `smoke-tv-games.mjs` 머리말 4번은 `housing:gameBeat` → 번쩍임을 약속하지만 `:319` 의 2026-09-14 결정으로 화면 번쩍임은 사라졌고 단언은 `!('flash' in beat.stage)` 다 · `shots-uiux.mjs` 머리말은 캐릭터 화면이 **3열**이라는데 단계 주석과 샷 이름 `02-character-2col` 은 2열이다 · `smoke-training.mjs:96` 구분선은 아직 터미널의 `시뮬레이션 훈련장` **섹션**이라 쓰지만 `:105`·`:109` 는 행성 탭 우하단 **버튼**이라고 한다 · `smoke-housing.mjs` 의 「2026-09-10 정제 작업대」는 `data/furniture.csv` 의 `가공 작업대` 가 맞다 | `scripts/smoke-tutorial-raid.mjs` · `smoke-structures.mjs` · `smoke-hangar.mjs` · `smoke-tv-games.mjs` · `shots-uiux.mjs` · `smoke-training.mjs` · `smoke-housing.mjs` |
| B-92 | **스모크 안의 죽은 값 여섯.** `smoke-hazard.mjs:192` 의 `mid` 는 첫 `evaluate` 가 **늘 `null`** 이라 `??` 가 항상 돌고, 그 값은 `:222` 의 `void mid;` 로 버려진다 (살아 있는 효과는 콜백 안의 `__seek` 뿐) · 같은 파일의 `EDGE_M`(`:29`) · `SPORE_MIN`(`:41`) 은 `void` 로 입막음만 된 `data/constants.csv` 전사본이고 뒤에 검사가 없다 · `smoke-mining-ui.mjs:568` 의 `off.msg` 는 `page.evaluate` 로 DOM 요소를 넘겨 `{}` 로 직렬화되고 아무도 안 읽는다(다음 줄 `offMsg` 가 제대로 다시 읽는다) · `smoke-food-chain.mjs:447` 의 `rows: 0` 은 아무도 안 읽는 상수 필드 · `smoke-blast-occlusion.mjs` 의 `const V = …`(`:136` — 같은 이름이 `:81`·`:158` 에도 있지만 그 둘은 쓰인다) · `const weapons = …`(`:207` — `:219` 의 같은 줄은 쓰인다)은 선언만 되고 안 쓰인다 | `scripts/smoke-hazard.mjs` · `smoke-mining-ui.mjs` · `smoke-food-chain.mjs` · `smoke-blast-occlusion.mjs` |
| B-93 | **살아 있는 출력 문자열의 오타 · 낡은 수치 둘 (주석이 아니라 문자열이라 영문화가 못 건드린다).** `smoke-tutorial-ship.mjs:463` 의 `ok(...)` 문구가 `레이뺈`(→ `레이븐`) · `smoke-tutorial.mjs:516` 의 단언은 `closeStep.count === 5` 인데 라벨은 아직 `… 하우징 모드 닫기 줄 (3/7)`. (2026-09-21: 셋째였던 `smoke-messenger.mjs` 의 `스텸에` 는 영문화가 그 줄을 통째로 옮기면서 사라졌다 — 목록에서 뺐다) | `scripts/smoke-tutorial-ship.mjs` · `smoke-tutorial.mjs` |
| B-94 | **중복 · 낡은 참조 둘.** `smoke-tutorial.mjs:159`·`:164` 에 같은 2026-09-09 `waitSpot` 주석 블록이 마지막 한 문장만 다른 채 **연달아 두 번** 있다(하나는 지워야 한다) · `smoke-social.mjs:820` 의 「리드 통합」은 파일에도 `ui/hud/Notifications` 에도 가리키는 대상이 없다 — 옆줄 `:972` 에 맞춰 「합류·이탈 토스트는 한 줄」로 옮겼으니 원저자 확인이 필요하다 | `scripts/smoke-tutorial.mjs` · `smoke-social.mjs` |
| B-95 | **한 가지를 두 이름으로 — `src/` 쪽에 남은 갈림 넷.** 2026-09-15 태그를 `src/net/NetSystem.ts` 는 *dock matching*, `src/game/parts/Phases.ts` 는 *docking matchmaking* 으로 적는다(`scripts/` 는 각자 소유 폴더를 따라가 둘 다 쓴다) · `온실 개편` 은 *greenhouse rework* 54 : *greenhouse overhaul* 6 · `제작 대개편` 은 *craft rework* 18 : *craft overhaul* 1 (2026-09-21 재집계 — 갈림은 그대로고 맞는 쪽만 늘었다) — §7 이 정한 쪽은 앞의 것이다 · `scripts/smoke-library.mjs` 의 **기존** 영어 줄들(`:1`·`:68`·`:188`·`:194`·`:267`·`:346`·`:410`·`:442`·`:458`·`:463`)은 서재 · 보관함 · 창고 · 가방 · 단편 을 한국어로 두어, 이번에 옮긴 줄들의 *library* · *holder* · *stash* · *bag* · *one-shot* 과 한 파일 안에서 갈린다 | `src/net/NetSystem.ts` · `src/game/parts/Phases.ts` · `src/world/Gather.ts` 외 · `scripts/smoke-library.mjs` |
| B-96 | **서식 셋.** `smoke-ui-p5.mjs:12` 은 C-13 · C-19 · C-36 이 한 줄에 이어 붙은 **372칸** 주석이다(재래핑 대상) · `smoke-loadout.mjs:596` 의 기존 영어가 §7 의 「no we / you」를 어기고 *we* 를 쓴다 · `smoke-phase3.mjs` 는 HEAD 부터 줄바꿈이 섞여 있다(CRLF 290 · LF 27) — 주석 전용 커밋이 아니라 자기 커밋에서 정리해야 한다 | `scripts/smoke-ui-p5.mjs` · `smoke-loadout.mjs` · `smoke-phase3.mjs` |
| B-97 | **파일 분할이 남긴 죽은 import 가 나머지 여덟 폴더에 2,300줄 넘게 남아 있다** (2026-09-21, B-69 를 `src/game` 에서 끝내고 같은 방법으로 전수 측정). `npx tsc --noEmit --noUnusedLocals` 로 센 미사용 선언은 `src/weapons` 474 · `src/enemies` 420 · `src/implants` 364 · `src/meta` 257 · `src/net` 236 · `src/stratagems` 209 · `src/hub` 193 · `src/housing` 111 (그 밖은 한 자리 수). 전부 B-69 와 같은 원인이다 — 시스템 파일을 `model.ts` + `parts/*` 로 쪼갤 때 import 블록을 통째로 복사했고, `tsconfig` 의 `noUnusedLocals` 가 꺼져 있어 `tsc` 가 영영 잡지 못한다. 폴더별로 걷어낸 뒤 `noUnusedLocals` 를 켜는 것이 재발을 막는 유일한 방법이다 (켜면 `GameFlowSystem.onRespawnRequest` 처럼 **의도된** 계약 스텁은 `void` 나 `// eslint`-류가 아니라 README 에 적힌 대로 남겨야 하므로 예외 처리가 필요하다) | `src/**/model.ts` · `src/**/parts/*.ts` · `tsconfig.json` |
| B-98 | **탐사 차량에 폭발물이 안 통한다.** 2026-09-21 에 플레이어의 **총알**만 차량에 길이 열렸다 — 히트스캔 · 스윕 탄환 · 바주카 폭발은 `destructible.onDamage` 를 타지만, 수류탄 · 가젯의 `applyAreaDamage` 계열은 원래 `destructible` 을 건드리지 않아 그대로 무해하다. 「차를 폭파한다」가 안 되는 것이 부자연스럽다 | `src/world/rover/Rover.ts` (`destructible.onDamage`) · `applyAreaDamage` 호출부 |
| B-99 | **비호스트의 차량 피격 보고가 탄 한 발당 한 통이다.** 기관단총이면 초당 14 통 — 가드의 초당 예산이 막고는 있지만 묶어 보내지 않는다. 한 프레임 분을 합쳐 보내면 된다 | `src/world/rover/Rover.ts` `reportHit` |
| B-100 | **천장형 터렛의 발사에 전용 와이어가 없다.** 「꺼짐」은 기존 `struct unlocked` 로 전파되고 피해는 권한자만 적용하지만, 회전 · 조준 레이저 · 경보는 각 클라이언트가 문 잠김 상태 + 20 Hz 위치로 **따로 굴린다**. 복제본이 다른 몸을 고르면 정작 맞는 사람이 예열 경고를 못 볼 수 있다 (피해는 어긋나지 않는다). `StructureMessage` 한 줄(`{ ev:'turret'; id; tg; st }`)이면 끝난다 | `src/world/structures/parts/Turret.ts` · `src/shared/net.ts` |
| B-101 | **함선 모델이 클라이언트의 말이다.** `lobby:look.shipModel` 을 릴레이가 모양만 검사하고 그대로 방송한다. 지금은 살 수 있는 기체가 없어 무해하지만, **상점이 들어오는 순간** `code` · `level` 처럼 릴레이의 프로필 스토어에서 채워야 한다 (구매물을 클라이언트가 자칭하게 두면 안 된다) | `server/RelayServer.ts` `lobby:look` · `server/Lobby.ts` `setShipModel` |

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
