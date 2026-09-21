# SCAVANGER — 앞으로 해야 할 작업 목록

이 프로젝트의 **유일한 할 일 목록**이다. Phase 0–12 는 전부 구현 완료라(→ [HISTORY.md](HISTORY.md) 의 `완료된 단계`),
여기 남은 것이 아직 안 된 전부다. 2026-09-08 에 `docs/` 전체를 읽고 **`src/` · `server/` · `electron/` 코드와 대조**해서 뽑았고,
**2026-09-21 에 남은 행 전부를 코드와 다시 대조했다** (끝난 행 삭제 · 낡은 근거 정정 · 재현 확인).

읽는 법:

- **묶음 4–5** = 다음 페이즈 후보. 하나가 한 번의 작업 사이클이다 (소유 폴더를 각 묶음 머리에 적었다).
  묶음 1–3 · 6 은 2026-09-14 에 끝났거나 목록에서 빼서 없다 — 폴더 README · 커밋 메시지가 번호로 가리키므로 번호는 당기지 않는다.
- **묶음 7** = 페이즈로 묶지 않고 다른 작업에 얹어서 처리하는 상시 항목.
- 각 행의 **근거**는 감사에서 직접 확인한 코드 위치다. `grep 0` 이면 그 이름의 구현이 저장소에 아예 없다는 뜻.
- **줄 번호는 적은 날의 것이라 밀린다** — 2026-09-20 주석 영문화처럼 주석을 재배치하는 커밋 하나가 한 파일의 번호를
  통째로 1~20줄 움직인다. 행이 **따옴표로 인용한 문구**가 진짜 표식이니, 번호가 안 맞으면 그 문구로 grep 한다.
- **`A-1` 같은 항목 ID 는 고정이다** — 폴더 README · 커밋 메시지가 이 번호로 가리킨다. 재사용하지 않는다.

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
| E-12 | **`verify:all` 남은 단축 여지 (② 스모크 클럭 · ③ 낙하 빨리 감기 · 리로드 제거는 2026-09-21 에 끝났다)** — ⓐ **`--jobs 6` 을 기본값으로 올리기** — 28스레드에서 스모크 클럭으로 전체 초록 1번(14분 6초) · 빨강 14 · 5 · 6개 3번(다른 세션 테스트와 기계 공유, 전부 재실행 초록). 막는 것: `smoke-nav` 의 벽시계 ms 상한(확장 노드 수 같은 카운터로 바꿔야 한다), `smoke-raidflow` 탑승자-데크 간격(20 fps 이하에서 이륙 한 스텝 지연 = 0.35 m 경계), 한 프레임짜리 UI 읽기(`smoke-ui-p5` 재장전 링 · `smoke-tv-games`). 조용한 기계에서 다시 재고 16스레드에서도 잰다. ⓑ **8레인의 다음 한계는 vite** 다: 28스레드에서 `--jobs 8` 은 40개 빨강, 대부분 `page.goto` 30초 네비게이션 타임아웃(부팅당 모듈 요청 ~860개를 8개 페이지가 한꺼번에). 모듈 요청 수를 줄이거나(사전 번들 · `optimizeDeps`) 시작 시차를 두는 방법을 재본다. 번들 전환(`vite preview`)은 33개가 `/src/*.ts` 를 직접 import 해서 이미 버렸다. ⓒ `smoke-tutorial` 의 옛 세이브 리로드 4번(L998 · 1017 · 1036 · 1274)은 `TutorialSystem.load` 를 다시 돌리는 dev 훅이 있어야 없앨 수 있다(~20초, `src/tutorial` 변경). 셰이더 캐시 템플릿 프로필은 재보고 버렸다(홀드 −0.15초, `goto` 6배 느려짐) | `scripts/README.md` 「Why the run takes as long as it does」 · `scripts/verify.mjs` `opts.jobs` 주석 · `src/core/Engine.ts` `SMOKE_MAX_SUBSTEPS` · `SMOKE_DROP_WARP` |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | `scripts/lan-address.mjs` 는 LAN 주소만 찾는다 |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM 이 소리가 아니라 상태다.** 설정의 `음악` 슬라이더도 함선의 음악 플레이어도 2026-09-14 부터 **있지만**, `bgm` 채널에는 연결된 것이 없어 값만 저장 · 표시된다. 트랙을 붙이면 그 두 화면은 그대로 쓸 수 있다 | `src/ui/menus/SettingsMenu.ts` `CHANNELS` 에 `bgm` 이 있다 · `housing/parts/Music.ts` · `ui/hud/MusicPlayer.ts` (CLAUDE.md §4.8 「Music is state, not sound」) |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | `src/ui/hud/Notifications.ts` |
| B-102 | **조사 카메라를 해금 전에도 제작할 수 있다.** 수리 · 분해비가 레시피 재료에서 나오므로 `make_cam_survey_1…5` 가 가젯 작업대 레시피로 있고, 그래서 `q_rv_1` 소포 · `atlas` 신뢰도 등급 제한을 건너뛴다. 막을지(수리 전용 레시피 플래그) 사용자 결정 필요 | `data/recipes.csv` `make_cam_survey_*` · `items/Salvage.checkSalvageEconomy` |
| B-103 | **줌 중 E 를 consume 해도 `isDown` 은 남는다.** 조사 카메라 줌에서 E(축소)를 길게 누르면 근처 홀드 상호작용이 시작될 수 있다 | `src/survey/SurveySystem.ts` input gate · `shared/Input.ts` |

## 묶음 8 — AI 길찾기

지금은 비어 있다 — 2026-09-21 에 A-18 1단계(공용 그래프 `src/world/nav/` · 안드로이드 A\*)와 2단계(적 흐름장 · 길목 통행 제한 ·
스캐빈저의 벽 타기 · 창문 진입)를 끝냈다. 남은 한계는 `src/world/nav/README.md` · `src/enemies/README.md` 의 Known limits 에 있고,
`NEST_LEASH_M` · `STRUCT_DAMAGE_MUL` 재조정은 실플레이 뒤 D-13 으로 잇는다.

## 묶음 7 (상시) — 밸런스 · 튜닝

지금은 비어 있다 — 2026-09-14 에 수치 줄 D-1 … D-6 · D-9 … D-12 는 사용자 결정으로 뺐고, 2026-09-15 에 남은 시각 잔손질
D-7(병사 림) · D-8(드랍쉽 그리블)을 끝냈다. 실플레이 뒤 튜닝 항목이 생기면 D-13 부터 잇는다.

| ID | 항목 | 근거 |
|---|---|---|
| D-14 | **레이드 경험치 · 플레이어 신뢰도 · 조사 수치는 첫 추정치다** (2026-09-21 구현). 실플레이 뒤 `RAID_XP_*` · `PLAYER_TRUST_*` · `PLAYER_TRUST_TABLE` · `survey_subjects.csv` `seconds`/`raidCap` · `survey_cameras.csv` 를 조정 | `data/constants.csv` · `data/tables.csv` · `data/survey_*.csv` |

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
