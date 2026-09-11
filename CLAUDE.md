# SCAVANGER — Project Command Center

Helldivers 2-inspired third-person extraction shooter in the browser. Three.js + Vite + TypeScript.
Arc Raiders-style minimalist UI, Diablo 2-style grid inventory, procedural maps, 60 s extraction countdown.
게임은 걸어 다닐 수 있는 **개인 함선**(허브)에서 시작하고, 매치메이킹으로 **공유 함선**에 도킹해 분대가 발사 포드를 타고 임무로 나간다.
릴레이 서버는 토큰별 **프로필 저장소**(크레딧 · 메타 · 창고 · 로드아웃 · 진행도 · 함선)와 **레이드 세션 저장소**를 함께 들고 있어
중간에 끊긴 플레이어가 레이드로 복귀할 수 있다. 서버 없이 하는 싱글 플레이는 localStorage 로 그대로 동작한다.

> **이 파일은 내비게이션 허브다.** 상세 설명은 전부 아래 링크 대상에 있다.
> 새 작업을 시작하기 전에 ① 이 파일의 폴더 지도에서 담당 폴더를 찾고 ② **그 폴더의 `README.md` 를 먼저 읽는다.**

---

## 1. 문서 지도

| 찾는 것 | 볼 곳 |
|---|---|
| **수치(밸런스)를 조정하고 싶다** | [data/README.md](data/README.md) — csv 만 고치면 된다. 코드는 안 건드린다 |
| **어떤 폴더를 고쳐야 하나** | 아래 [3. 폴더 지도](#3-폴더-지도) |
| **그 폴더가 어떻게 생겼나 · 왜 이렇게 됐나** | 각 폴더의 `README.md` (구조 + 하단 `변경 이력`) |
| 시스템 등록 순서 · 미션 플로우 · UI blocker / 커서 규약 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 멀티플레이 토폴로지 · 와이어 계약 · 호스트 권한 | [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md) |
| 키 바인딩 기본 레이아웃 · 리바인딩 규칙 | [docs/CONTROLS.md](docs/CONTROLS.md) |
| 검증 절차 · 소요 시간 · 테스트 기록 | [docs/VERIFICATION.md](docs/VERIFICATION.md) |
| 스크립트 하나하나가 무엇을 검사하나 | [scripts/README.md](scripts/README.md) |
| 날짜별 작업 기록 · 알려진 한계(미해결 항목) | [docs/HISTORY.md](docs/HISTORY.md) |
| **앞으로 해야 할 작업** | [docs/TODO.md](docs/TODO.md) — 다음 페이즈 후보 묶음 + 항목별 코드 근거 |
| 완료된 단계 목록 | [docs/HISTORY.md](docs/HISTORY.md) 의 `완료된 단계` |
| Phase 5–12 에서 무엇을 결정했나 | [docs/DECISIONS.md](docs/DECISIONS.md) |
| **투자자 · 퍼블리셔용 소개 문서** (위키형 HTML, 빌드 없음 · 공개본 **https://toniqat.github.io/Scavanger/**) | [docs/pitch/README.md](docs/pitch/README.md) → `docs/pitch/index.html` (페이지 원본은 `docs/pitch/pages/00-intro.html` … `30-controls.html` **31개**. 페이지 순서 · 파일 번호 · 절 번호의 원본은 `docs/pitch/app.js` 의 `TREE` 하나이고, 깨지면 `node scripts/smoke-pitch.mjs` 가 잡는다) |

---

## 2. 명령어

```
npm run dev        # http://localhost:5273 (싱글 플레이는 서버 없이 동작)
npm run server     # WebSocket 릴레이 (ws://localhost:8787/ws, GET /health)
npm run dev:all    # 릴레이 + vite 동시 (vite 가 /ws → 8787 프록시)
npm run typecheck  # tsc --noEmit — 끝내기 전에 반드시 통과 (서버는 typecheck:server)
npm run data:check # data/*.csv 스키마 검사 (오타 · 빠진 칸 · 범위 · 모르는 이름) — verify 가 자동으로 돌린다
npm run build

npm run app:build  # 데스크톱(Electron) 빌드: vite dist/ + 메인 프로세스 dist-electron/
npm run app        # 빌드된 데스크톱 앱 실행 (임베디드 릴레이 + 로컬 http, 브라우저 불필요)
npm run app:dist   # 배포 폴더 release/SCAVANGER/ 전체 (아이콘 + app/ + stub exe + server.txt + 서버 exe)
npm run server:dist # 서버만: release/SCAVANGER-Server.exe (Node 없이 도는 단독 exe, 약 86MB)
npm run icon       # 앱 아이콘 electron/resources/icon.ico 를 코드로 다시 그린다 (--png = 미리보기)

npm run verify     # 기능 하나 끝낸 뒤: typecheck + selftest + 건드린 폴더에 매핑된 스모크만 (4 병렬)
npm run verify:all # 머지 전: 전부 + build + e2e:mp (~10 분)
npm run net:selftest   # 서버 프로토콜 셀프테스트 (브라우저 불필요)
npm run e2e:mp         # 헤드리스 크롬 2대로 릴레이+vite 관통 테스트

npm run pitch:webp # 피칭 문서 배포본 이미지: docs/pitch/assets/*.png → 같은 이름의 .webp (30MB → 2.8MB)
node scripts/shots-pitch.mjs  # 피칭 문서 스크린샷 자동 촬영 (npm run dev 가 떠 있어야 한다)
node scripts/smoke-pitch.mjs  # 피칭 문서 31쪽이 뜨는지 (링크 · 사이드바 · nextnav · 카드 넘기기)
node scripts/smoke-desktop.mjs  # 데스크톱 셸을 진짜 Electron 으로 (--hidden · 임시 userData · 창 8820) — --release 는 배포 폴더까지
npm run data:check -- --write  # 경제 수치(아이템 가치 · 계약/퀘스트 보상 · 가격 배수 · 수리비)를 바꿨으면 server/economy.gen.json 을 다시 굽는다
```

개별 스모크 스크립트 46종의 목록과 각각이 검사하는 내용은 **[scripts/README.md](scripts/README.md)** 에 있다.
`npm run verify` 가 폴더 → 스크립트 매핑으로 알아서 고르므로 손으로 하나씩 돌리지 않는다 (`node scripts/verify.mjs --list`).
2026-09-11: `data/<file>.csv` 만 바꿔도 그 수치를 소비하는 폴더의 스모크를 고른다 (`scripts/data-owners.mjs` — `constants.csv` ·
`tables.csv` 는 거의 전부가 읽으므로 `note:` 만 찍는다). 모르는 옵션 · `--help` 는 **아무것도 실행하지 않고** 도움말만 찍는다.
여러 러너를 같은 트리에서 동시에 돌리면 `--log-dir scripts/logs/<이름>` 으로 로그를 가르고 `--keep-relay` 로 공용 릴레이를 지킨다.

### 배포 (2026-09-10)

`npm run app:dist` 가 만드는 것은 exe 하나가 아니라 **그대로 압축해 보낼 폴더**다:

```
release/SCAVANGER/
  app/                    electron 빌드 전부 (SCAVANGER.exe + .pak · dll · locales …)
  SCAVANGER.exe           stub 런처 — app\SCAVANGER.exe 를 띄운다 (electron/launcher.cs, csc.exe 로 굽는다)
  server.txt              접속할 서버 주소 한 줄 — 받는 사람이 고치는 유일한 파일 (구 relay.txt)
  SCAVANGER-Server.exe    서버를 켤 사람만 실행 (server/tool.ts, Node 불필요)
```

서버를 켤 사람은 `SCAVANGER-Server.exe` 를 더블클릭하고 창에 적히는 주소를 알려 주면 된다.
창에 명령을 칠 수 있다 (2026-09-11): `list` · `lobbies` · `kick <아이디> [사유]` · `max <n|off>` · `help` (밴은 없다 —
강퇴당한 사람은 재접속을 멈추고 `server_full` 은 새 접속만 막는다). 프로필 저장소는 `profiles.json.bak` 한 세대를 두고,
읽다 깨지면 원본을 `profiles.corrupt-<시각>.json` 으로 남긴 뒤 `.bak` 에서 복구한다.
받는 사람은 게임 안 **`설정 › 서버 설정`** 에 그 주소를 적는다 (`server.txt` 를 고쳐도 된다 — 게임 안 설정이 우선).
자세한 것은 [electron/README.md](electron/README.md) 의 `배포 폴더` 와 [server/README.md](server/README.md) 의 `배포`.

Windows 원클릭 실행 (프로젝트 루트에서 더블클릭):

```
start-server.bat         # node 확인 → 필요시 npm install → npm run dev:all (릴레이 8787 + vite 5273)
start-server.bat relay   # 릴레이만 (npm run server, 0.0.0.0:8787) — 데스크톱 앱만 쓸 때
```

배너에 이 PC 의 LAN 주소(`ws://<IP>:8787/ws`)를 찍는다 — 데스크톱 앱이 접속할 값이다.
(배포본을 받은 사람에게는 `start-server.bat` 대신 `SCAVANGER-Server.exe` 가 그 역할을 한다.)
게임 실행은 `SCAVANGER.exe` 또는 `npm run dev`.
`start-server.bat` 은 한국어 메시지를 위해 **CP949(시스템 ANSI)** 로 저장한다 — UTF-8 + `chcp 65001` 조합은 cmd 가 label 을 재탐색할 때 파싱이 깨진다.

---

## 3. 폴더 지도

각 행의 README 가 그 폴더의 파일 구성 · 공개 API · 변경 이력을 갖는다. **폴더 내부를 고치기 전에 그 README 를 읽는다.**

### 3.1 계약 · 엔진

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`data/`](data/README.md) | — | — | **게임 수치의 단일 원본 (csv 39개).** 데미지 · 체력 · 가격 · 확률 · 쿨다운 — `src/` 에는 같은 숫자가 없다 |
| [`src/shared/`](src/shared/README.md) | — | `GameContext`, `EventBus`, `Input`, `Random` | **계약. 제일 먼저 읽는다.** 타입 · 이벤트 · 상수(값은 `data/constants.csv`) · 키바인드 · csv 로더(`data/`) · 각 시스템의 `*Ref` 인터페이스 · **캐릭터 세이브 슬롯(`saveSlot`)** · **캐릭터 생성 규칙(`character`)** · **재화 칩(`currency`)** · **ESC 닫기 스택(`escape`)** · **포탄 궤적 닫힌 식(`ballistics` — enemies 와 ui 가 같은 자리를 그린다)** · **셰이더 선컴파일 · 점광원 예산(`render` — `ctx.shaders`)** · **점광원 풀(`lightPool` — 함선 · 구조물 공용)** · **투척물이 창문 유리를 깨는 한 줄(`fragile`)** · **차량 탑승 수학(`ride` — 플레이어 · 적 · 시체 공용)** · **발밑 재질 `SurfaceMaterial`** · **키 설정 로드 리포트(`takeKeybindLoadReport`)** |
| [`src/core/`](src/core/README.md) | `Engine` | scene / camera / renderer / **`ctx.shaders`** | 렌더러 · 조명 · 하늘 · 포그 · 포스트프로세스 · 메인 루프 · 리사이즈 · 시스템 레지스트리 · **점광원 개수 고정(`LightBudget` — intensity 0 여분이 `SCENE_POINT_LIGHT_BUDGET` 을 채운다)** · **셰이더 선컴파일 + hold(`ShaderWarmup` — 새 장면은 컴파일이 끝난 뒤에 그린다)** · **화면 설정 토글(블룸 · 그림자)은 값이 실제로 바뀔 때만 셰이더 hold · perf guard 가 다시 산다)** · **guard 가 스스로 끈 것은 `render:autoAdjusted` 로 알린다 — 설정 행이 `꺼짐 (성능 자동)`, 저장값은 그대로** |
| [`src/main.ts`](src/main.ts) | — | — | Engine 부트스트랩 + 시스템 등록 순서, 커서 모드 ↔ 버스 브리지, 포인터 락 재요청의 **유일한** 지점 |

### 3.2 플레이어 · 전투

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/player/`](src/player/README.md) | `PlayerSystem` | `ctx.player` | 3인칭 컨트롤러 · 카메라 리그 · 절차 생성 병사 모델 · **강하 포드 동기화(아군 헬포드가 보인다) · 구조선 부활** · **차량 탑승(전차 OBB 안이면 유지 · 로컬 좌표로 이동 · 하차 관성)** · 체력(**100 고정 아님 — getter**)/**실드(방탄복 = 추가 체력, 피해는 실드부터)**/전투불능(**1인 분대는 즉사**)/스태미나 · 자세 · 상호작용 · 실내 충돌 · 원격 아바타(**같은 함선끼리만 보인다** · **병사 모델은 색별 풀 `SoldierPool` + 지오메트리 공유** · **원격 포드 3개 상주**) · 호스트 고스트 · **사다리(`climbingLadder` — E 매달림 · W/S · Shift 스태미나 · Space 도약 · E 놓기 · 꼭대기 올라서기, 매달린 동안 무기 · 상호작용 잠금, 원격은 `CLIMBING`)** · **단차 보간(`bodyOffset` — 모델 · 카메라만)** · **월드 천장 클램프(발 + `BOX_HEADROOM`)** · **드론 조종 모드(`setDroneControl` — 앉은 채 멈춤 · 이동/자세/조준/상호작용 입력 무시 · 무기 불가, 사다리 · 포드 · 들쳐메기 중엔 거부, 드론 시점 카메라는 흔들림 · FOV 가산 없음, 해제는 `setCameraOverride(null, undefined, true)` 하드 컷)** · **탑승 수학은 `shared/ride`** · **초상화 색 변경은 옛 모델을 다음 render 뒤 dispose(재컴파일 없음)** |
| [`src/weapons/`](src/weapons/README.md) | `WeaponSystem` | — | 무기 **2슬롯(주무기 I · II — 2026-09-10 보조무기 제거)** · 실효 스탯 · 내구도 · 탄약 v2 · 히트스캔/발사체 · 빠른 사용 휠 · 수류탄 · 근접 · 유니크 무기 · 원격 재생 · **투척 궤적은 실제 비거리의 50 % 까지만(착지 표시 없음, `THROW_ARC_PREVIEW_FRACTION`)** · **원격 지뢰 = 손에 든 채 우클릭 기폭 · 마지막 C4 를 놓으면 슬롯 없는 기폭기 손(`remoteState.detonator`, `T` 탭으로 다시 잡기)** · **드론 아이템은 꺼낸 뒤에도 손에 남는 조종기(R 은 무기가 먹지 않는다) · 드론 조종 중 무기 전부 정지** |
| [`src/implants/`](src/implants/README.md) | `ImplantSystem` | `ctx.implants` | 전술 임플란트 6종 (갈고리 · 대시 · 배리어 방패 · 오버차지 · 정찰 스캔 · 대전차포), Q 키 구동, 배리어 충돌/흡수/실드 배쉬 · **HUD 는 화면 중앙 하단 가로 썸네일(`ui/hud/ImplantWidget`)** · **갈고리가 공중 드론에 걸린다(움직이는 앵커 — 드론 위치까지 당겨지고 끝) · 드론 조종 중 Q 불가** · **실드 배쉬 넉백 = 계약 `pushBack` 한 줄(비호스트도 넉백)** · **원격 장치는 재생성된 아바타 소켓에 다시 붙는다** |
| [`src/gadgets/`](src/gadgets/README.md) | `GadgetSystem` · **`DroneSystem`** | `ctx.gadgets` · **`ctx.drones`** | 소모품 가젯 **13종** (은폐 · 돔 실드 · 바리케이드 · 수류탄류 · 지뢰 · 포탑 · 제세동기 · 점프대 · **원격 지뢰(C4 — 손에 들고 우클릭 = 내 것 전부 기폭, 한 대상이 여러 발 맞으면 가장 센 한 발만 100 % · 나머지 각 50 %, 마지막 것을 놓으면 손은 기폭기)** · **지상/공중 드론**), 호스트 권한 배치물 · **설치 미리보기(`parts/Preview` — 손에 든 place 가젯은 조준점 고스트 초록/빨강, 대형(바리케이드 · 점프대 · 포탑) = 평평 + 공간, 소형(지뢰 · 원격 지뢰)만 드론 윗면 탑재 · 드론 위 지뢰는 적만 감지)** · **드론(`drones/` — 소유자 권한, 아이템은 조종기로 남고 파괴 시 1개 소모, 손에 들고 R 꾹 = 조종 · PC 는 앉아서 멈춤 · PC 피격 / 사거리(지상 70 · 공중 90 m) 초과 시 끊김, 지상 = 걷기 무소음 · 질주 소리+어그로 · 점프, 공중 = 호버 · Space/C 상승하강 · 갈고리가 걸린다)** |
| [`src/stratagems/`](src/stratagems/README.md) | `StratagemSystem` | `ctx.stratagems` | 함선 호출 4종 (**궤도 폭격 = 호스트 전용** · 보급품 · 트라이포드 · **구조선(분대 공용 5회)**), G 휠 · 상단 시점 조준 · **네 호출이 하나의 쿨타임을 공유(구조선 30 · 보급품/트라이포드 90 · 궤도 폭격 120초) · 쿨타임 중에는 휠이 열리지 않는다** · **분대원 호출은 호스트 경유(`stratq call` → 종류 · 호출자별 쿨타임 · 사거리 검사 → `strat call {by}` 재방송, 받는 쪽은 호스트가 보낸 것만)** |

### 3.3 월드 · 적

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/world/`](src/world/README.md) | `WorldSystem` | `ctx.world` | 절차 지형 · 바이옴 · 소품/장애물(**콜라이더 = 보이는 실루엣** — 바위 · 첨탑은 **땅 위로 보이는 윤곽**에서 잰다(`Props.footprintOf`), 낮은 것은 `getSurfaceY` 로 **올라선다**) · **상자(허허벌판에는 없다 — 폐허 전초 · 구조물 둘레 · 둥지에만)** · 탈출 패드 · 채집 노드(약초 · **고철 더미**) · **전장의 안개(`ctx.world.fog`)** · **버려진 구조물(전진기지 · 연구실 · 불시착 함선 — 들어간다 · 지하실은 잠겨 있고 키카드가 그 안에 있다 · 지상층 바닥에 계단 구멍이 뚫려 있다 · 컴퓨터로 행성 스캔)** · **선로 · 플랫폼 · 전차(선로 방향으로 길쭉한 차체 · **시동 콘솔은 운전실 안** · 플랫폼 안내판 = **호출 콘솔**(부르기만 하고 출발은 안에서 · **「곧 출발합니다」는 전차 곁 `TRAM_DEPART_NOTICE_RANGE` 에만, 부른 사람은 「호출했다」**) · **콘솔류(전차 · 탈출 · 행성 스캔)에는 감지 빛기둥이 없다(`hidePillar`)** · 도착하면 `idle` 로 서고 **자동 재출발 없음** · 최고 속도에서 치이면 피해 + 넉백)** · **선로 회랑(`RAIL_CLEARANCE_M`) 안에는 아무것도 놓지 않는다 — 그래서 선로를 제일 먼저 잡고 나머지가 피한다** · **환경 재해(`ctx.world.hazard` — 모래 폭풍 · 눈보라 · 폭풍의 눈 · 독성 포자. 6–8분에 시작해 맵을 덮는다 = 사실상 강제 탈출, 눈 지형에는 모래 폭풍 대신 눈보라, 폭풍의 눈 안은 앞이 안 보이고 벽만 또렷하다, 포자는 거대 버섯 군락에서 피어오른다)** · 시뮬레이션 훈련장 · 충돌/레이캐스트 질의(**사각 OBB 콜라이더 `Obstacle.box`**) · **볼록 윤곽 콜라이더(`Obstacle.hull` — 바위 · 첨탑 · 크리스탈 · 잔해, 총알은 높이별 층)** · **경사 계단(`Obstacle.ramp` — 보이는 것은 계단, 밟는 것은 경사면)** · **구조물: 층마다 천장 · 무작위 2층(실내 계단) · 옥상(격벽 사다리 `getLadders` · 해치) · 맵 스캐너는 옥상에만 + 맵 끝까지 퍼지는 파동 · 깨지는 창문(총알 · 투척물만 통과) · 지하실 = 방(계단 복도 끝의 서 있는 문) · 컨테이너 있는 방마다 조명(광원 풀 `STRUCTURE_POINT_LIGHTS`)** · **상자 · 컨테이너의 열린 모습 분대 동기화(`crate opened`)** · **발밑 재질 `getSurfaceMaterial`(`surface.ts` — 11종, 발소리가 고른다)** · **폐허 전초 발견 → 지도** · **달리는 전차가 적 · 끊긴 분대원 몸을 친다(면제는 실제로 그 전차를 탄 몸만 — 선로 발판 위는 치인다 · 대상별 쿨다운)** · **고철 더미 부가 코어(시드)** · **폭풍의 눈은 0 m 까지 닫힌다** · **생성 약 197 ms(같은 시드 결과 바이트 동일 — `noise.ts` 머리 주석의 동일성 검사)** |
| [`src/enemies/`](src/enemies/README.md) | `EnemySystem` | `ctx.enemies` | 버그 5종 + 휴머노이드 로그 AI · 포병(**사거리 −30 % · 비행 −50 % · 리본 궤적 · 궤적 높이는 `SHELL_ARC_GRAVITY`(정점 9.9 m) — 화면 안으로 날아온다**) · 베헤모스 · 팩션 · 시체 루팅 · 상태이상 · 총알 추적 · **지형지물 접지(`getSurfaceY`) · 대형 적 스폰 여유** · **로그 강하(구조물 조사 → 구역당 1회 · 분대 인원 비례 · 구조물로 진격)** · **벽에 붙은 채로 쏘지 않는다(`ai/FireLine` — 총구 기준 사선, 막히면 사격만 보류하고 스트레이프)** · **탈출 웨이브도 분대 인원 비례(`WAVE_SQUAD_SCALE`)** · 호스트/리플리카 동기화 · **네임드 로그(레이드당 최대 1명, `named/Director` — 로든 = 개활지 엎드려쏴 · 스캔 드론 음파 5회 → 4회 이상 노출된 플레이어를 저격 150 · 감지 90 m 안은 드론 없이 거리 비례 명중률 · 반드시 조준경 반짝임 전조 · 플레이어만 쏜다 / 타길라 = 구조물 곁 · 망치 초당 50 · 체력 ×10 · 짧은 돌진 / 헤비 = 미니건 + SMG 호위 3–6명 · 사선 열리면 회전 → 연사, 와이어는 `ee spray` on/off 뿐)** · **적 ↔ 드론(`TargetList.drones` — `aggroable` 드론만 노린다 · 걷는 지상 드론은 무시 · `world:noise` 로 조사 · 적 폭발이 드론에 닿는다)** · **적 · 적 시체 전차 탑승(`ai/Ride` — 리플리카는 속도 이력으로 예측)** · **재해 구역 안 적에게 조용한 피해** · **비호스트 넉백 요청(`HitRequest.kb`)** · **곡사포 사전 검사 재배치** · **`ee acidAt` · 산성이 다른 팩션 적에게도** · **타입별 소리 표(`meleeHitSound` · `stepSound`) · 적 발소리 = 재질 · 거리 곡선 · 리플리카도 발소리** · **엎드린 로든 = 눕힌 캡슐 판정(레이 · 근접 공용 `RayTests.nearestOnCapsule`) · 승격 시 스캔 드론 입양** · **적도 전차 하차 관성(플레이어와 같은 상수) · 리플리카 탑승 예측은 차량 속도 이력** · **분대원 킬 `enemy:squadKill`(호스트 권위 킬에서 파생) · `ee` 는 로비 호스트가 보낸 것만 · `hit` 요청 보낸 사람별 DPS 상한 · 넉백은 보낸 사람 거리 검사** |
| [`src/extraction/`](src/extraction/README.md) | `ExtractionSystem` | — | 탈출 콘솔(**평상시 빛기둥 없음 — 활성화 뒤에만 켜진다**) · **60초** 카운트다운(`EXTRACTION_COUNTDOWN`) · 함선 착륙/탑승/이륙(**뒷문 자리는 실제로 뚫려 있고 램프만이 막는다 · 탑승하면 데크 평면을 따라 함선과 함께 실려 올라간다**), 호스트 권한 |

### 3.4 아이템 · 인벤토리 · 메타

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/items/`](src/items/README.md) | (데이터) | `ctx.loot` | 무기 6계열 × 등급 I–V · 탄약 · 부착물 · 가방 · **방탄복(= 실드 20/40/60/80/100)** · 회복 소모품 · **실드 충전기 3종** · 씨앗 · 서적 · 임플란트 아이템 · 루팅 테이블 · **제작(`data/recipes.csv` 94줄 — 상위 재료 5종 · 정제 작업대 · 무기 25종 전부) · 분해/수리(`data/salvage.csv` + 제작 재료 × 내구도 20 % 5구간 배수 — 「제작 → 분해」 무한 이득이 없다는 것을 `data:check` 가 매번 검산한다)** · **가젯 아이템 3종 추가(원격 지뢰 · 지상 드론 · 공중 드론 — 가젯 작업대 Lv.2/2/3, 공중 드론은 상위 재료) · 네임드 확정 드롭(`data/loot_named.csv` — 로든 = 저격소총 III–V 85 %, 타길라 = 방탄복 III–V 85 %, 헤비 = 유니크 미니건 80 %, 내구도 1–5 %, 행성 등급 곡선 무시)** · **가방 내구도(100 · 레이드당 소모 · 0 = 효과 없음, 수리 대상)** · **상위재 상자 비율 T3–5 = 5 · 10 · 15 %** |
| [`src/inventory/`](src/inventory/README.md) | `InventorySystem` | `ctx.inventory` | 디아블로2식 격자 모델 · 가방/장비(**주무기 I · II · 가방 · 방탄복 — 보조무기 칸 없음**)/**임플란트 칸**/**퀵슬롯(= 또 하나의 가방 공간, 올리면 격자에서 사라진다 · 상자 · 창고와 곧장 오간다)** · 함선 창고 · **사망 시 전량 시체로(`stripForCorpse`) · 컨테이너별 격자 크기** · 컨테이너 감정 · 소켓 · 제작(**1초 홀드 · 한 칸 산출물 썸네일 · 제작 수량 ◀▶ · 넣을 자리 없으면 버튼 잠금(가방 → 창고) · 만들 수 있는 항목이 위로 · 작업대 탭 6종(전체/총기/장비/가젯/의학/정제) + 빠른제작 · 작업대를 열면 그 작업대 레시피만**)/**분해 · 수리(둘 다 남은 내구도 20 % 5구간을 탄다 — 팝업이 구간과 배율을 적는다)** · 출격 준비 점검 · Tab 화면(인벤토리/캐릭터/기업/함선) · **무기 툴팁 = 2×2 게이지(대미지 · 연사 · 반동 · 사거리, 소켓 보너스 초록 · 반동 감소 초록 윤곽) + 우상단 탄종 썸네일 + 소켓 썸네일 한 줄**, **탄약 요청은 장착 무기 휠클릭 (`탄약 필요: <탄종>`)** · **사망 시 장착 임플란트의 망가진 짝도 시체로 · 시체 격자는 모자라면 행을 늘리고 컨테이너 창이 세로로 스크롤한다(드래그 가장자리 자동 스크롤 · 잘린 행은 드롭 대상이 아니다)** · **같은 컨테이너 재오픈은 무시** · **툴팁에 내구도 구간 한 줄** |
| [`src/pickups/`](src/pickups/README.md) | `PickupSystem` | `ctx.pickups` | 월드에 떨어진 아이템 (투척 궤적 · 절차 메시 · 호스트 권한 동기화 · **빛기둥 없음 · 착지 = `getSurfaceY`** — 2026-09-11) |
| [`src/meta/`](src/meta/README.md) | `MetaSystem` | `ctx.meta` | 기업 4곳 · 신뢰도(모자란 거래/계약 탭은 잠김) · 크레딧 · 상점/거래대 · 계약 · 퀘스트 · 임플란트 수리 데스크. 화면은 **왼쪽 한 열**(기업 목록 → 신뢰도 게이지 → 페이지 탭 → 크레딧) + 페이지 + **풀 높이 가방/창고/진행 중인 계약**, 보상은 **재화 썸네일** · **`open_crates` 계약 진척은 상자 id 당 레이드 1회** · **크레딧 사유는 `formatCreditReason`(서버가 검증 — 판매는 수량 포함, 거절된 판매는 아이템을 되돌린다) · 분대 킬 목표는 `enemy:squadKill` 로 세고 `contractHit` 은 킬이 아닌 목표만 + 토큰 버킷** |
| [`src/progression/`](src/progression/README.md) | `ProgressionSystem` | `ctx.progression` | 레벨/XP · 능력치 5종 · 숙련도 14종 · 파생 수치(`derived`, **투척 거리는 m 로 표기**) · 임플란트 장착칸 규칙 · 캐릭터 시트(능력치 · 숙련도만 — 임플란트 UI 는 인벤토리) · 프로필 영속화(**슬롯별**, `accent`/`createdAt` 포함) · **사망 전용 `stripImplantsForCorpse`(함선 게이트 우회 · 즉시 저장)** · **감정 XP 는 컨테이너 id 당 레이드 1회** |
| [`src/housing/`](src/housing/README.md) | `HousingSystem` | `ctx.housing` | 함선 꾸미기 규칙 · 방 용도/시설 레벨 · 가구(**자동 배치 `autoPlaceSpot` — 좌측 상단부터 가로줄 우선 · 아래를 향한다 · 문 앞은 비운다**) · 재배 · 서재 · 로드아웃 프리셋 · `ShipState` 영속화 · **자동 배치 2차 패스(문 앞 구역이라도 문 폭 인접 2칸은 비운다)** · **저장 debounce 중 도착한 서버 문서가 로컬 편집을 덮지 않는다** |

### 3.5 셸 · 흐름 · 표현

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/hub/`](src/hub/README.md) | `HubSystem` | `ctx.hub` | 개인/공유 함선 내부 · **격납고(개인 함선 4대 정박 · 방문)** · 도킹 컷씬 · **창문 워프(행성 이동, 조작 유지)** · **목표 행성이 없으면 창밖에 행성이 없다** · 발사 포드(출격 준비 경고) · 전체화면 터미널(**닫기 버튼만 · 키 가이드 없음**) · 행성 선택 · 작업대 · 시설 관리 모드 · **분대원 상호작용 → 분대장 넘기기** · **광원 풀(광원 자리 중 가까운 `HUB_POINT_LIGHTS` 개에만 불을 건다)** · **도킹 컷씬 도중 도착 함선 선빌드 + 선컴파일** · **서버가 옮겨 준 분대 이동(`lobby:left moved`)은 도킹 컷씬 한 번 · 분리 도중 새 로비 → 도킹으로 전환 · 닫힌 터미널의 거절 사유는 토스트 · `refused` 면 함선 진입으로 재접속하지 않는다** |
| [`src/game/`](src/game/README.md) | `GameFlowSystem` | `ctx.phase`, `ctx.corpses` | 페이즈 상태 기계 · **사망/시체(`ctx.corpses`, 자동 부활 없음 — 구조선만)** · **분대장 기기** · 레이드 실패 · **ESC = 맨 위 화면 닫기 → 없으면 일시정지(`escapeKey`)** · 재접속 UX · 레이드 세션 저장/복귀 · 재개 게이트 · **플레이어 시체가 전차에 실려 간다 · 시체 높이 = 밟을 수 있는 표면** · **솔로 사망은 장착 임플란트를 잃는다** · **솔로 레이드 시계 방어(`clockHigh` 역행 감지 · 미래 저장 허용 폭 · 로드아웃 `raidSeed` 표식)** |
| [`src/ui/`](src/ui/README.md) | `HudSystem` | — | 모든 DOM UI — HUD 2계층(**레이드 HUD 2026-09-10 개편: 좌상단 = 임무 시간만 · 우하단 무기 패널 = 가로로 긴 상자(`.wbox`) 안에 등급색 정사각 썸네일 + `24 / 120` + 클래스 태그, 바닥에 내구도 바 · 퀵슬롯 54 px + `T` · 좌하단 = 이름 + 실드 게이지 + 5등분 체력 · 하단 중앙 = 함선 호출 정사각 썸네일(`.scall`) + 전술 임플란트, 둘 다 쿨타임이 아래에서 위로 차오르고 한가운데 남은 초**) · 메뉴(**타이틀 = 워드마크 + 게임 시작/설정/종료**, **캐릭터 선택 3칸 · 캐릭터 생성(3D 프리뷰)**, **ESC = 중앙 왼쪽 고정**, 설정 3분할 · 화면 중앙 · 조작 다이어그램, **경고 팝업의 확정은 1초 홀드**) · 지도(**전장의 안개 — 미탐색은 회색 윤곽, 발견한 것만 마커, 밝혀진 경계에는 또렷한 선, 재해는 안개 위에 빗금으로 덮인다**) · 채팅(**Enter 전송 후 유지 · Tab 닫기**) · **우측 하단 키 가이드(`ui:keyGuide`)** · 소셜(커뮤니티 패널 단일, **고정 크기**) · 크로스헤어(**헤드샷 타격 표시 = 1.6배 X · 소모품을 들면 점 + 수량/내구도 · 함선 안에서도 점(`HubDot`) + 탑승 홀드 링**) · **위험 인디케이터(`ui/hud/DangerIndicators` — 적 곡사포탄 · 수류탄(아군 + 적) · 함선 호출 낙하물. 화면 밖이면 크로스헤어 바깥 방향 호, 화면 안이면 머리 마커, 둘이 겹치지 않는다. 색 = 누구 것인가, `hot` = 임박)** · **핑 v3(함선 안에서도 · 플레이어별 3개 · 관대한 조준 · 확인 핑 = 분대 색 원 · 모든 핑이 채팅 한 줄 · 화면 밖 화살표는 수명 내내 · 2026-09-10 아래 드래그 탄약 요청 제거 — H 의사소통 휠 · 인벤토리 휠클릭으로 대체)** · **입력 중 `…` 말풍선(원격만)** · 굵은 피격 방향 호 · 아이템 툴팁(**크기 줄 없음 · 무게 좌하단 · 가치 우하단**) · 커서 아트 · 스타일시트 · **빛기둥은 시체에만(`hud/pillar.pillarAllowed`, 2026-09-11)** · **드론 조종 HUD(`hud/DroneHud` — `drone-view` 클래스 하나로 무기 · 임플란트 · 함선 호출 · 스태미나를 숨기고 뷰파인더 · 하단 사거리 게이지(스태미나 자리) · 90 % 넘으면 외곽 지지직 · 공중 = 크로스헤어 좌 고도 / 우 Space·C · 지상 = Space·Shift + 소음 배지 · 조종 전환 홀드 링 · 끊김 알림)** · **로든 경고(`hud/NamedScanWarning` — 스캔 노출 배너 n/5 · 노출 음파 가장자리 · 조준경 반짝임 = 내가 표적이면 방향 호 + `저격 조준!`)** · **손에 든 가젯 안내(`hud/GadgetHandHint` — 설치 가능/사유 · `우클릭 기폭 (n)` · 기폭기 · `R 꾹 조종` / `신호 범위 밖`)** · **옛 키 설정 알림(`menus/keybindNotice` — 은퇴 액션 · 새 기본키 겹침)** · **원격 명판 실드 바** · **화면 투영은 `HudSystem.lateUpdate`(카메라 행렬 갱신 뒤)** · **지도에 폐허 전초 · 닫힌 폭풍의 눈** · **서버 연결 배지(`hud/NetBadge` — 함선 · 타이틀 우측 상단, 레이드 숨김, 연결 전이 토스트의 유일한 주인)** · **소셜: 커뮤니티 `초대 중` 배지 · 차단 목록 / 대화 기록 페이지 · 차단한 분대원 채팅 숨김 · 귓속말 pending → 확정 줄 · `/r`** |
| [`src/audio/`](src/audio/README.md) | `AudioSystem` | `ctx.audio` | 절차 WebAudio SFX 전량 + 앰비언트, 버스 이벤트에 반응, 볼륨 영속화 · **발소리(로컬은 늘 같은 크기 · 원격은 거리 감쇠 · 자세별 크기)** · **로그 강하 경보(무전 경보 + 착지 직전 낙하 굉음 — 인지력이 아니라 전용 반경 `ROGUE_DROP_ALERT_RADIUS` 로 게이트하고 거리 감쇠는 남긴다)** · **드론 · C4 · 네임드 SFX 25종(`RANGED_SOUNDS` 거리 곡선 — `sniper_shot` · `scan_pulse` · `sniper_glint` 는 "전조가 들려야 공정하다" 라 멀리까지 최소 크기 보장)** · **재질별 발소리 11종(`footstep_<mat>`, 허브 · 도킹 = 금속)** · **적 발소리 거리 곡선** · **`shield_charge` · `tram_call` · `tram_hit` · `tram_deny`** |
| [`src/tutorial/`](src/tutorial/README.md) | `TutorialSystem` | `ctx.tutorial` | 새 캐릭터 안내 **17단계** — 목표 패널 · UI 스포트라이트(**합집합 포커싱 · 0.5초 늦게 · 딤 페이드인**) · 바닥 안내선, 순서 강제 게이트(`blockReason`) + **잠긴 항목 숨김**(`hides`, **함선 창고 아이템 포함**) · 부족한 재료 top-up · **1초 홀드 건너뛰기** |
| [`src/console/`](src/console/README.md) | `ConsoleSystem` | `ctx.console` | 개발자 콘솔 + 치트 (**dev 호스트에서만** 존재 — 그 외에는 DOM 도 키도 없다) |

### 3.6 네트워크 · 배포

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/net/`](src/net/README.md) | `NetSystem` | `ctx.net` | 릴레이 WebSocket 클라이언트 · 세션 토큰 · 로비 · 20 Hz 스냅샷 · 프로필 동기화 · 소셜 · 크루 카드 · **함선 배치(`ship state`)** · **분대장 지명 이관** · `PlayerFlags.TYPING`(채팅 입력 중) · **접속할 서버 주소(`설정 › 서버 설정` → `defaultUrl`) · 익명 연결 테스트** · **`kicked` · `server_full` 을 받으면 재접속을 멈춘다** · **링크 상태 `ctx.net.link`(접속 타임아웃 6 s · unreachable 이면 익명 배경 프로브 — 함선 · 타이틀에서만 자동 접속, 셸 임베디드 목표는 프로브 안 함)** · **프로필 문서 리비전(`baseRev` · ack · 서버 우선 충돌 · 영속 쓰기 큐 · `setMany` 트랜잭션)** · **소셜 초대 id 응답 · 차단 · 귓속말 ack · 대화 기록(슬롯 localStorage)** |
| [`server/`](server/README.md) | (Node) | — | `ws` 릴레이 — 로비 · 5분 재접속 유예 · 호스트 이관(**자동 + 지명 `lobby:transferHost`**) · 프로필/레이드/소셜 저장소 · `selftest.ts` · **배포용 엔트리 `tool.ts`(단독 exe → `npm run server:dist`)** · **콘솔 `list` · `lobbies` · `kick` · `max` · `gc` · `help`** · **저장소 비동기 쓰기 + fsync + `.bak` 세대 · 손상 파일 보존 · 복구 · `--data`/`SCAV_DATA_DIR`** · **프로필 GC(90일 안 온 프로필 삭제 · 접속자/로비 멤버 보호 · 최근 목록 · 친구 요청 30일 만료 — 시작 시 + 6시간마다)** · **소셜 서버(원자적 이동 `LobbyManager.move` · 초대 표 `Invites.ts` · 네 목록 watch + 250 ms 푸시 합치기 · 조용한 차단 · 귓속말 ack + 친구 오프라인 보관 20줄/7일)** · **문서 리비전(`docsRev` · 전부 또는 전무 `setMany`)** · **크레딧 검증(`Economy.ts` — 사유 해석 + `economy.gen.json` 표 + 원장, migrate 는 `CREDITS_MAX` 까지 1회)** |
| [`electron/`](electron/README.md) | (Electron main) | — | 데스크톱 스탠드얼론 셸 — 같은 프로세스에 릴레이 + `dist/` 를 로컬 http 로 서빙(**창 포트 8790 고정 = 세이브 오리진**), `src/`·`server/` 무변경 · **배포 폴더 = `app/` + stub 런처(`launcher.cs`) + `server.txt`** · 아이콘 · **임베디드 릴레이는 첫 `/ws` 접속 때 켜진다(`--lan`/`--port` 면 즉시)** · **테스트 격리 플래그 `--user-data` · `--hidden` · `--lazy-relay` · `/__scav/relay` 의 `embedded`** |

---

## 4. 스택 & 규약

- Three.js 0.185, TypeScript strict, ES modules, 경로 별칭 `@/` → `src/`.
- **수치는 코드에 적지 않는다.** 데미지 · 체력 · 가격 · 확률 · 쿨다운 · 무게는 전부 `data/*.csv` 에 있고 TS 는
  그 표를 읽어 자기 타입으로 옮기기만 한다 ([data/README.md](data/README.md)). 새 수치를 넣을 때도 csv 에 줄을
  먼저 만든다. csv 는 `import.meta.glob(..., '?raw')` 로 **빌드 시점에** 번들에 인라인된다 — 런타임 fetch 없음.
- **외부 에셋 파일 금지.** 모든 모델(플레이어 · 벌레 · 상자 · 함선 · 소품)은 Three.js 지오메트리로 코드에서 절차 생성한다.
  GLTF 도 디스크 텍스처도 없다. 필요하면 절차 CanvasTexture / 셰이더를 쓴다.
- 모든 HTML UI 는 `ctx.uiRoot` (`#ui-root`) 아래 DOM 이고 스타일은 `src/ui/styles/`. **React 없음.**
- 게임 내 텍스트는 **한국어**.
- 폴더마다 `README.md` 가 파일 구성을 설명한다. **폴더를 고치면 그 README 를 갱신한다.**
- `src/shared/*` 는 조율 없이 고치지 않는다 — 모든 모듈이 의존하는 계약이다.
  새 이벤트/필드가 정말 필요하면 **추가만** 한다(이름 변경 · 삭제 금지).
- 폴더 간 통신은 `ctx.bus` 이벤트, 동기 질의는 `ctx` 의 `*Ref` 인터페이스.
  **다른 기능 폴더의 내부를 import 하지 않는다 — `@/shared` 만.**
- **큰 시스템 파일은 `model.ts` + `parts/` 로 가른다** (2026-09-08). `model.ts` = 폴더 공용 어휘(타입 · 상수 ·
  스크래치, 상태 없음), `parts/*.ts` = 클래스에서 떼어낸 메서드 묶음으로 인스턴스를 첫 인자 `sys` 로 받는다.
  클래스에는 같은 이름의 한 줄 위임 메서드가 남으므로 **호출부는 바뀌지 않는다.** 순환 import 를 피하려면
  `parts/` 는 시스템 파일에서 **타입만** 가져와야 한다 — 값이 필요하면 `model.ts` 로 옮긴다.
  자세한 규약은 각 폴더 README 의 `파일 분할 규약` 절.
- `THREE.Vector3` 스크래치 객체를 재사용하고 핫 패스에서 프레임당 할당을 피한다.
- 미션 리셋(`game:abort`, `game:newMission`) 때 직접 만든 지오메트리/머티리얼을 dispose 한다.
- 키는 **사용 시점에 `Keys.X` 를 읽는다** — 모듈 상수로 캐시하지 않는다 ([docs/CONTROLS.md](docs/CONTROLS.md)).
- **포인터 락이 튕겨 나온 것은 Escape 가 아니다** (2026-09-09). 화면 · 모드가 닫히면 `main.ts` 가 락을 다시
  요청하는데, 전체화면 Chrome 과 데스크톱 셸은 그 락을 넘겨줬다가 곧바로 도로 가져갈 때가 있다. 그것을
  `onUserUnlock` 으로 흘려 보내면 `game/` 이 플레이어의 Escape 로 읽어 **일시정지 메뉴를 혼자 띄운다** —
  하우징 모드를 Tab 으로 닫으면 ESC 메뉴가 뜨던 문제이고, 닫으면서 락을 되찾는 화면 전부가 같은 뿌리였다.
  `shared/Input` 이 락을 **잡은 직후**(`lockAcquiredAt`) `LOCK_BOUNCE_GRACE_MS` 안의 락 상실을 걸러 내고
  제스처 재시도만 건다. 이 창 안에서 진짜 Escape 를 놓쳐도 락 없는 Escape 는 진짜 keydown 으로 들어온다.
- **Escape 직후에는 포인터 락을 요청하지 않는다** (2026-09-10). 데스크톱 앱에서 ESC 로 화면을 닫으면 조작이
  죽고 좌클릭을 해야 살아나던 문제의 뿌리다. Escape 를 처리하는 중에 락을 요청하면 Chromium 이 그것을
  **허가했다가 같은 Escape 로 도로 가져가고**(= 사용자 해제), 그 뒤 **약 1.25초 동안 모든 재요청을 거부한다**
  ("Pointer lock cannot be acquired immediately after the user has exited the lock"). 이 쿨다운은 시간에만
  반응한다 — 클릭도 키도, `electron/main.ts` 가 건네는 user activation 도 앞당기지 못한다(그래서 좌클릭이
  듣는 것처럼 보였다: 클릭할 즈음이면 1.25초가 지나 있었을 뿐이다). 그래서 `shared/Input` 이 요청을 보낼
  시각을 스스로 고른다 — Escape 를 누르고 있는 동안 + 뗀 뒤 `LOCK_ESCAPE_DEFER_MS`, 사용자 해제 뒤
  `LOCK_USER_EXIT_COOLDOWN_MS` 안에 들어온 요청은 **브라우저에 보내지 않고** 의사만 적어 뒀다가
  (`deferredRelock`) `endFrame` 이 풀리는 첫 프레임에 한 번만 보낸다. 겹친 요청은 하나로 합쳐지고
  (`lockInFlight`), 타이밍 때문에 거부되면 `LOCK_RELOCK_RETRIES` 회까지 스스로 다시 보낸다. 새 코드에서
  **락을 다시 잡는 지점은 여전히 `main.ts` 하나**이고, 미루는 일은 전부 `Input` 안에서 끝난다.
- **Escape 는 열려 있는 화면 중 맨 위 하나를 닫는다** (2026-09-09, 2026-09-08 규칙 개정). 닫을 화면이 없을 때만
  일시정지 메뉴가 열린다. 순서는 **열린 순서의 역순**이고 그것을 아는 곳은 `shared/escape` 의 `ctx.escape`
  하나다 — 화면은 `uiBlockers.add` **옆에서** `escape.push(token, () => this.close())`, `delete` 옆에서
  `escape.remove(token)` 한다. 정책은 `game/parts/Phases.escapeKey` 한 곳뿐이다 (폴링으로 흉내내지 않는다 —
  키를 각자 읽으면 닫히는 순서가 `main.ts` 의 시스템 등록 순서로 정해져, 위에 뜬 패널보다 아래 모드가 먼저 닫힌다.
  그래서 **하우징 모드**도 자기 Escape 폴링을 걷어내고 이 스택에 올라갔다 — C 는 그대로다).
  가장 안쪽 팝업(수량 지정 · 우클릭 메뉴 · 경고 팝업 · 설정 · 키 바꾸기 · 채팅 · 콘솔)은 그대로 자기 capture
  핸들러에서 Escape 를 삼켜 `Input` 이 기록조차 못 하게 한다. **일시정지 메뉴 자신은 데스크톱 앱에서만** ESC 로
  닫힌다 (`isDesktopShell()`, `ui/menus/PauseMenu`) — 브라우저에서는 `게임으로 돌아가기` 클릭이 재락에 필요한
  제스처를 겸하므로 그대로다. 2026-09-08 에 닫기를 걷어낸 이유(Escape 에는 user activation 이 없어 재락이
  거부된다)는 이제 양쪽 모두 답이 있다: 앱은 메인 프로세스가 ESC key-up 에 activation 을 만들어 주고
  (`__scavShellRelock`), 브라우저는 `좌측 클릭으로 게임 재개` 게이트가 그 한 클릭을 받는다.
- **Tab 은 모든 화면 · 모드의 공용 닫기 키다** (2026-09-09). 자기를 연 키(E · M …)로도 여전히 닫히지만 Tab 도 닫는다 —
  Tab 을 먹는 화면은 `ctx.input.consume(Keys.INVENTORY)` 로 인벤토리가 같은 키에 열리지 않게 한다. 열린 화면은
  `ui:keyGuide {owner, keys}` 를 내보내 **우측 하단 한 줄 키 가이드**(`ui/hud/KeyGuide`)에 자기 키를 올리고, 닫을 때
  `keys:null` 을 보낸다. `닫기` 항목은 가이드가 스스로 맨 오른쪽에 붙이므로 `keys` 에 넣지 않는다 — 2026-09-09
  부터 그 항목의 keycap 은 **둘**(`Tab` · `Esc`)이다. ESC 메뉴는 예외(가이드 없음).
- **행성 이동은 컷씬이 아니다** (2026-09-09). 함선 창문 밖의 별이 줄기로 늘어나는 **창문 워프**(`hub:warpProgress`)이고
  조작은 그대로 살아 있다 — 이동 중에도 함선 안을 걸어 다닌다. 개인 → 공유 함선 **도킹 컷씬은 그대로**다.
- **캐릭터 세이브는 슬롯별이다** (2026-09-09). 새 캐릭터 데이터를 저장할 때는 반드시 `slotKey(KEY)` 를 통과시킨다
  (`scav.profile` → `scav.s2.profile`, `shared/saveSlot`). `scav.sessionToken` 도 슬롯별이라 릴레이의 서버 프로필까지
  캐릭터마다 갈라진다. 공용으로 남는 것은 `SHARED_KEYS` 뿐 — 키 바인딩 · 오디오 · 화면 설정 · 콘솔 기록.
  시스템은 부팅 때 한 번 저장소를 읽으므로 **슬롯 전환은 언제나 `location.reload()`** 다
  (`setActiveSlot` → `markAutoStart` → reload; 새로고침 뒤 `takeAutoStart()` 가 타이틀을 건너뛴다).
- **보상 단위는 아이템이 아니라 재화다** (2026-09-09). 신뢰도(기업별) · XP · 크레딧은 `data/currencies.csv` +
  `shared/currency.ts` 의 **재화**이고 `buildCurrencyChip` 이 아이템 칩과 같은 크기 · 다른 틀(육각)로 그린다.
  가짜 아이템 정의를 만들지 않는다 — 루팅 · 제작 표에 샌다. 툴팁은 `ui/hud/ItemTip` 의 `.is-currency`.
- **되돌릴 수 없는 확정은 1초 홀드다** (2026-09-09). 파티 떠나기 · 타이틀로 · 게임 종료 · 캐릭터 삭제의 빨간 버튼은
  `UI_HOLD_CONFIRM_S` 동안 눌러야 실행된다(제작 · 분해와 같은 게이지). **Enter 로는 확정되지 않는다** — 먹기만 하고,
  Escape 가 취소이며 초기 포커스는 `취소` 다.
- **일시정지 메뉴는 자리가 고정이다** (2026-09-09). 화면 세로 중앙 · 가로는 **왼쪽 절반**(중심이 약 25vw)에
  CSS 로 못 박혀 있다 (`.menu.pause`). 2026-09-08 의 "메뉴가 커서를 찾아간다"(`parkUnderCursor` · `--menu-dx/dy`)는
  걷어냈다 — 매번 다른 자리보다 늘 같은 자리가 낫다는 사용자 결정. **설정**은 그 위에 **화면 중앙**으로 뜬다.
- **완전한 사망에는 자동 부활이 없다** (2026-09-09). 전투불능은 여전히 제세동기로 살릴 수 있지만, 피가 다 빠져
  `player:died` 가 나면 그 자리에 **레이드가 끝날 때까지 남는 시체**가 서고(`ctx.corpses`) 사망 시점의 장비 ·
  가방 · 퀵슬롯이 전부 그 안으로 옮겨진다(`InventoryRef.stripForCorpse`, 아무나 루팅 가능). 되살아나는 길은
  분대원이 부르는 **구조선 투하**뿐이고 그때도 **빈손**이다 — 자기 시체를 찾아가 되찾아야 한다.
  **장착 임플란트도 몸에 남지 않는다** (2026-09-11 C-12, 사용자 결정 — 2026-09-09 의 "임플란트는 예외" 를 뒤집었다):
  분대 레이드에서는 `ProgressionRef.stripImplantsForCorpse` 가 장착을 전부 풀어 **망가진 짝**(`imp_broken_*`)을
  시체 격자에 넣고(세레스 수리로 되살린다) 즉시 저장한다 — 사망 직후 새로고침으로 되돌릴 수 없다. 시체가 없는
  **솔로 레이드 사망은 짝도 없이 완전히 잃는다** (장비 · 가방과 같다). 함선에서의 탈착 게이트는 그대로다. `PLAYER_RESPAWN_DELAY` ·
  `game:respawn` · `game:respawnAvailable` 은 계약이라 **지우지 않았을 뿐** 아무도 발행하지 않는다.
- **구조선 횟수는 호스트가 들고 있다** (2026-09-09). 분대 공용 `RESCUE_DROPS_PER_RAID`(5)회이고 아무나
  `rescue req` 를 보내면 호스트가 `grant` 하면서 1 차감한다 — **호출 확정 시점**이고 취소해도 환불은 없다.
  착륙 지점은 호스트가 `world.scatterPoints` 로 뽑아 포드끼리 겹치지 않게 정한다. 소진 뒤의 사망자는
  탈출/전멸까지 관전이다.
- **강하 포드는 이제 남에게도 보인다** (2026-09-09). 미션 시작 강하와 구조선 강하 모두 `pod drop` 을 보내고
  `player/RemotePods` 가 원격 헬포드를 떨어뜨린다. 그 전까지 아군은 그냥 자리에 나타났다.
- **함선 호출은 하나의 쿨타임을 공유한다** (2026-09-10, 사용자 결정). `_cooldown` 은 처음부터 네 호출이
  함께 쓰는 값이었고 길이만 새로 정했다 — **구조선 30 · 보급품 90 · 트라이포드 90 · 궤도 폭격 120초**
  (`data/stratagems.csv` 의 `cooldown`, 코드에는 없다). 그래서 **쿨타임 중에는 `G` 홀드로 휠도 열리지 않는다**:
  고를 수 있는 칸이 하나도 없으므로 여는 대신 `denyCooldown` (거부음 + `재충전 n초` 토스트)으로 끝낸다 —
  `arm` 의 거부와 **같은 함수**다. HUD 는 우측 하단 텍스트 패널이 아니라 **전술 임플란트 왼쪽의 정사각
  썸네일**(`ui/hud/StratagemPanel`, `.scall`)이고, 쿨타임 연출이 임플란트와 완전히 같다(딤드 + 아래에서 위로
  차오름 + 한가운데 남은 초). 하단 중앙 줄의 자리 · 크기는 `styles/implant.css` 의 `:root` 변수
  (`--imp-th` · `--imp-tw` · `--imp-bottom` · `--imp-gap`) 하나가 원본이다.
- **함선 호출 휠은 4칸 고정이다** (2026-09-09). `STRATAGEM_ORDER` 가 정확히 4개(N/E/S/W)이고 지금은
  궤도 폭격 · 보급품 · 트라이포드 · 구조선이다. `airstrike` 는 목록에서만 빠졌고 타입 · csv 줄 · 구현은
  남아 있다 — 계약은 **추가만** 한다는 규칙 그대로다. `STRATAGEM_HOST_ONLY` 의 호출은 멀티에서 분대장만 무장한다.
- **분대장은 지명해서 넘긴다** (2026-09-09). 서버의 `lobby:transferHost {targetId, claim?}` 이 유일한 관문이고
  허용은 둘뿐이다 — ① 지금 호스트가 넘긴다(커뮤니티 우클릭 · 함선 안 상호작용), ② 호스트가 `lobby:hostDown` 으로
  사망 표시를 켜 둔 상태에서 누군가 시체 옆 **분대장 기기**를 `LEADER_DEVICE_HOLD_S`(3초) 홀드해 `claim` 한다.
  호스트가 바뀌었다는 **토스트는 `game/parts/Leader` 한 곳만** 띄운다.
- **지도는 처음부터 열려 있지 않다** (2026-09-09). `ctx.world.fog`(`FogRef`)가 `FOG_CELL_M` 격자 하나를 들고,
  분대원 **전원**의 위치 주위 `FOG_REVEAL_RADIUS` 를 `FOG_UPDATE_HZ` 로 칠한다 — 밝힌 칸은 레이드가 끝날 때까지
  유지된다. 평상시 **와이어가 없다**(이미 흐르는 `ps` 스냅샷으로 각자 칠하면 저절로 같아진다); 늦게 합류한
  사람만 `fogq sync` 로 마스크를 받는다. 미탐색 구역은 회색 윤곽만 보이고 **아직 발견하지 않은 오브젝트는
  지도 · 월드 마커 · 나침반 어디에도 뜨지 않는다** (`fog.isDiscovered`). 그래서 탈출 신호소의 빛기둥도
  평상시에는 꺼져 있다 — 탈출이 **활성화된 뒤에만** 켜진다.
- **콜라이더는 보이는 실루엣이고 낮은 것은 올라선다** (2026-09-09). 소품의 이동 · 총알 실린더를 둘 다
  `hullOf` 실측에서 만든다(예외는 나무 줄기와 회전한 잔해 상자 — 코드에 근거가 적혀 있다).
  걷는 바닥은 `getHeightAt` 이 아니라 **`WorldRef.getSurfaceY(x, z, feetY)`** 다: 발 높이에서
  `PROP_STEP_UP_MAX` 안에 있는 장애물 윗면만 잡으므로 낮은 바위에는 올라서고 첨탑은 벽으로 남는다.
  **표면을 먼저 잡고 `resolveCollision` 을 부른다** — 순서를 뒤집으면 옆으로 밀려난 뒤라 영영 못 올라간다.
  플레이어(`PlayerController`) · 적(`EnemyAI` · `Replica`) · 시체가 모두 같은 질의를 쓴다.
- **소품 콜라이더는 지오메트리에서 재고, 그 지오메트리는 믿을 수 있어야 한다** (2026-09-09). `Props.hullOf`
  가 바운딩 박스로 콜라이더를 만드는 이상 **정점 하나만 튀어도 소품 전체가 거대한 보이지 않는 원기둥이
  된다.** 실제로 `world/noise.ts` 의 `noise3` 가 `lerp` 인자를 `(t, a, b)` 로 넣어 `[-1,1]` 대신
  `[-31, +52]` 를 돌려주고 있었고, `build.displace` 가 그만큼 정점을 밀어 첨탑 콜라이더가 반지름 18 m 로
  부풀었다 — 걸어서 못 지나가고 총알이 허공에서 멈추던 그것이다. 소품 지오메트리를 손보면 **콜라이더도
  같이 재는 것**임을 기억한다.
- **땅에 박힌 소품은 땅 위로 보이는 부분에서 잰다** (2026-09-10). 바위 · 첨탑은 일부러 묻어 두는데
  (`s×0.28` · `s×0.4` — 가장 넓은 둘레가 지하다) `hullOf` 는 메시 전체를 재서, 행성마다 바위의 절반이 보이는
  바위보다 0.5 m 이상 앞에서 막았다 — 폭풍 안개 속 "보이지 않는 벽" 보고의 정체다(폭풍의 눈 경계 자체에는
  아무것도 없었다). `Props.footprintOf` 가 지형 위 정점 + 지형 교차점만 모아 **그 윤곽의 중심**에 원기둥을
  세우고(경사지에서는 인스턴스 원점과 몇 m 어긋난다 — `Obstacle.position` XZ 를 원점으로 가정하지 않는다)
  32 방위 최대 거리의 평균을 반지름으로 삼는다. 이동 · 총알 원기둥이 같은 값이다. 검사는 `smoke-props-collision`
  의 4번(내려 쏘는 레이로 보이는 가장자리와 비교)이 한다 — 2번(정점 전부와 비교)은 묻힌 정점을 "그려진 것" 으로
  세서 이것을 못 잡았다.
- **데스크톱 앱의 세이브는 창 포트에 묶여 있다** (2026-09-09). localStorage 는 오리진 단위이고 앱의
  오리진은 `http://127.0.0.1:<창 포트>` 다. 그래서 `electron/main.ts` 의 창 서버는 **임의 포트를 절대
  쓰지 않는다** — `APP_PORT`(8790)부터 정해진 순서로만 훑고, 릴레이 포트와는 완전히 분리돼 있다.
  포트를 바꾸는 것은 캐릭터를 통째로 새로 시작하는 것과 같다.
- **퀵슬롯은 가방 격자가 아니다** (2026-09-09). 휠에 올린 소모품은 **가방에서 사라진다** — 퀵슬롯이 자기
  컨테이너(`InventorySystem.quickSlots: QuickSlotItems`)이고 스택 자체를 들고 있다. 무게 · `countWhere` ·
  `consumeWhere` · 시체(`stripForCorpse`) · 레이드 blob 은 휠을 함께 보지만 `getAllItems()`(거래 · 수리 목록)는
  여전히 가방 격자만이다. `setQuickSlot` 은 **옮기기**이고 밀려난 스택이 가방에 못 들어가면 **이동 자체를
  거절한다** — 휠 아이템을 조용히 버리지 않는다. 세이브는 **v2** 이고 `quick[i]` 가 인덱스가 아니라 스택이다
  (v1 은 `sanitizeLoadoutSave` 가 읽을 때 가방에서 빼내 이관한다). UI 는 휠 칸을 `{ kind: 'quick', index }`
  로 넘긴다 — `BAG_LOC` 으로 넘기면 `findItem` 이 못 찾는다.
- **꾹 누르는 키는 키캡 위에 chevron 을 단다** (2026-09-09). `KeyGuideEntry.hold` 가 true 면 키 가이드가,
  `interact:promptChanged.hold` 면 상호작용 캡션이 같은 `.keycap.kc-hold::before` 화살표를 그린다. 탭하는 키는
  예전 그대로다. **modifier 클래스는 `kc-hold` 이고 그냥 `hold` 가 아니다** (2026-09-10): `.hold` 는 이미
  크로스헤어 홀드 링(`ui/hud/HoldGauge`)이 쓰는 이름이라 키캡이 **120×120 투명 상자**가 되어 통째로 사라졌다
  (여백만 남아 프롬프트가 세로로 길어졌다). **HUD 위젯 클래스와 같은 이름을 modifier 로 쓰지 않는다.**
- **보조무기는 목록에서만 뺐다** (2026-09-10, 사용자 결정). 무기 칸은 주무기 I · II 둘뿐이고 권총 아이템 ·
  판매 규칙 · 확정 드롭 · 3번 키 · 설정의 리바인드 줄이 전부 없어졌다. 그런데 `LoadoutSlot` · `WeaponSlot` ·
  `Loadout.secondary` · `Keys.SECONDARY` **타입은 그대로 남아 있다** — `src/shared` 는 추가만 하는 계약이고
  저장된 프리셋 · 크루 카드 · 로드아웃 세이브가 그 이름을 쓴다 (`airstrike` 와 같은 처리). 칸을 실제로 정하는
  곳은 `inventory/model` 의 `LOADOUT_SLOTS` · `WEAPON_SLOT_IDS`, `weapons/WeaponDefaults` 의 `WEAPON_SLOTS`,
  `hub/ui/WorkbenchMenu` 의 정비 목록 셋뿐이다 (2026-09-11 정정 — 여기 적혀 있던 `ui/hud/SlotStrip` 은 소비자가
  없는 헬퍼였고 C-26 에서 파일째 지웠다).
- **선로는 걸어 올라설 수 있는 높이여야 한다** (2026-09-10). `RAIL_DECK_Y` 는 0.75 m 다 — `PROP_STEP_UP_MAX`
  (0.9) 안이라야 땅에서 선로 위로 올라선다. 예전 1.7 m 처럼 그 사이 높이로 올리면 **올라설 수도, 밑으로
  지날 수도 없는 담**이 된다 (`obb.BOX_HEADROOM` 2.1 밑이라 `resolveCollision` 이 밀어낸다). 2.4 m 위로
  올리면 밑으로 지나갈 수는 있지만 플랫폼 말고는 오를 길이 없다. 발판은 `RAIL_DECK_STEP` 마다 이어 붙인
  얇은 상자 콜라이더이고, 중심선은 **좌우 구간의 지형 최고점을 실측해** 그보다 위로만 끌어올린다.
- **사각 콜라이더는 `Obstacle.box` 다** (2026-09-09). 들어갈 수 있는 건물의 벽을 원기둥으로 흉내낼 수 없어
  2026-09-09 앞 배치의 "OBB 는 버린다" 를 뒤집었다. 다만 **재작성은 하지 않았다** — `SpatialHash.addBox` 가
  **외접원을 `radius` 로 채워** 버킷팅 · `overlaps` · `query` 는 그대로이고, `resolveCollision` · `raycast` ·
  `getSurfaceY` · `getStandingObstacle` 만 `if (o.box)` 가지에서 새 수학으로 간다. 그래서 **원기둥 소품의
  동작은 한 줄도 바뀌지 않는다.** 상자를 만들 때 `radius >= hypot(halfX, halfZ)` 를 반드시 채운다 — 안 채우면
  광역 질의가 그 상자를 놓친다.
- **움직이는 발판은 `Obstacle.velocity` 다** (2026-09-09, 2026-09-11 개정). 전차 데크처럼 스스로 움직이는 장애물은
  `velocity` 를 **갖고 있다는 것 자체로** 움직이는 발판이다(정지한 전차도 0 벡터) — `getStandingObstacle` 은 윗면이
  `PROP_TOP_MARGIN` 창 안에서 겹치면 높이보다 이것을 먼저 고른다 (C-38, 선로 발판과의 동점). 타는 방법은 아래
  "탑승은 차량 부피로" 절이고 그 수학은 **`shared/ride.ts` 하나**다(`recordRideLocal` · `restoreRideLocal` ·
  `rideContains`) — 플레이어(`PlayerController`) · 적(`enemies/ai/Ride`, 리플리카는 보간 지연만큼 앞당겨 그린다) ·
  플레이어 시체(`game/Corpses`) · 적 시체가 전부 같은 식으로 탄다. `velocity` 를 위치에 더하는 곳은 없고
  **하차 관성**에만 쓴다. 달리는 전차는 탑승자가 아닌 적 · 끊긴 분대원 몸을 친다 (`world/rails/parts/Tram`, 대상별 쿨다운).
- **재해는 시드에서 나오고 와이어를 쓰지 않는다** (2026-09-09). 종류 · 시작 시각(6–8분, 30초 단위) · 전선 방향 ·
  눈 중심 · 포자 발생지와 그 순서가 전부 **미션 시드의 함수**이고 진행은 `ctx.missionTime` 의 함수다 — 안개와
  같은 철학이라 평상시 흐르는 메시지가 **없고** 늦게 합류한 사람만 `hzq sync` 를 받는다. 시야 제한은
  `atmo:override` **한 경로로만** 간다 (`core/Atmosphere.setOverride`; `world/` 가 `scene.fog` 를 직접 만지지 않는다).
- **인게임 스크롤바는 어두운 UI 색을 쓴다** (2026-09-09). `:root` 의 `--sb-track` · `--sb-thumb` ·
  `--sb-thumb-hover` 가 단일 원본이고 `#ui-root` 아래 모든 스크롤러에 한 규칙으로 걸린다
  (`src/ui/styles/base.css`). `src/inventory/inventory.css` 는 그 스타일시트를 import 하지 않으므로 같은 이름을
  fallback 과 함께 참조한다 — **값은 base.css 에서만 고친다**.

- **방탄복은 피해를 깎지 않는다 — 실드다** (2026-09-10, 사용자 결정). 들어온 피해는 `PlayerRef.shield` 를
  먼저 비우고 남은 만큼만 `hp` 로 간다. 등급별 20/40/60/80/100 (`ARMOR_SHIELD_BY_TIER`, tier 기준이고
  `data/armor.csv` 의 rarity 를 거기 맞춰 재조정했다), 유니크 3벌은 옛 뎀감률을 `round(DR / 0.3 × 100)`
  으로 환산해 90 / 33 / 27 이다. **`damageReduction` 은 지우지 않았지만 늘 0 이다** — `ArmorDef` 에는
  유니크 환산의 근거로, `PlayerRef` 에는 계약으로 남아 있을 뿐이다 (`airstrike` · `secondary` 와 같은 처리).
  내구도는 그대로여서 실드가 흡수한 만큼 닳고 0 = 파손 = 실드 최대치 0, 함선 작업대 수리로 되살아난다.
  **함선에 있는 동안은 늘 가득**이고 레이드 중 회복은 **실드 충전기**뿐이다 — 레이드 중 방탄복을 갈아
  끼워도 채워 주지 않는다 (여벌 방탄복이 공짜 충전기가 되면 충전기가 의미를 잃는다).
- **재접속으로 돌아온 사람이 조용히 무언가를 잃으면 안 된다** (2026-09-10). 실드처럼 **아이템에서 파생되지
  않는 별도 풀**을 새로 만들면, 그 값이 와이어와 세이브에 없는 한 재접속·이어하기 한 사람만 0 으로 시작한다.
  실드는 `PlayerSnapshot.sh/.shm` → `GhostWire.sh` → `PlayerRestoreState.shield` → `SoloRaidPose.shield`
  까지 `dhp` 와 같은 규약(방탄복을 입었을 때만 실린다)으로 이었다. 두 가지가 규약이다 — ① **생략은 0 이
  아니라 "모른다"** 이고 받는 쪽이 최대치로 복구한다(옛 세이브 · 옛 호스트), ② 복귀 프레임에는 `PlayerGear`
  가 아직 인벤토리를 다시 읽기 전이라 최대치가 0 이므로 값을 `pendingShield` 에 적어 뒀다가 방탄복을 실제로
  읽은 첫 프레임에 한 번만 넣는다.
- **같은 수식을 두 폴더가 쓰면 `shared` 로 뽑는다** (2026-09-10). 포탄 궤적이 `enemies/fx/ShellProjectile`
  과 `ui/hud` 에 **각자 베껴져** 있었다 — 폴더끼리 import 하지 않는다는 규칙을 지키느라 복사한 것인데,
  한쪽만 고치면 HUD 마커가 포탄에서 떨어진다. `shared/ballistics.ts` 가 유일한 원본이고 양쪽이 그것을 부른다.
  중력은 `GRAVITY` 가 아니라 **`SHELL_ARC_GRAVITY`** 다: 정점 높이가 `0.5 × g × (T/2)²` 라 실제 중력으로는
  6.3 s 비행에서 48.7 m 까지 솟아 화면(FOV 70° = 수평선 위 35°) 밖에서 떨어졌다. 2.0(정점 9.9 m)이면
  하강 내내 화면 안이고 발사각 32° 라 여전히 곡사포로 읽힌다.
- **적의 사선은 눈이 아니라 총구에서 잰다** (2026-09-10). `Perception.hasLineOfSight` 는 **눈**에서 레이를
  쏘는데 총알은 **총구**에서 나가므로, 벽 뒤에 붙은 적이 벽에다 대고 쏘고 있었다. `enemies/ai/FireLine` 이
  총구 기준으로 검사하되 **시작점을 `ENEMY_WALL_STANDOFF` 만큼 뒤로 당긴다** — 벽에 박힌 총구에서 그냥 쏘면
  벽 안쪽에서 바깥으로 나가는 레이라 "뚫려 있다" 고 읽힌다. 막히면 **사격만 보류하고 이동은 막지 않는다**:
  문·틈을 지나는 중이라 순간 막히는 것은 정상이고, 거기서 AI 가 굳으면 더 나쁘다.
- **자동 가구 배치는 화면 기준이고 문 앞을 비운다** (2026-09-10). 시설 관리 카메라가 모든 방을 +X 에서
  내려다보므로 **화면 아래 = 격자 x 증가, 화면 오른쪽 = 격자 y 감소** 다 — "좌측 상단부터 가로줄 우선" 은
  `x` 오름차순 바깥 × `y` 내림차순 안쪽이고, "아래를 향한다" 는 **yaw 1**(옛 `AUTO_PLACE_YAWS` 첫 값 yaw 0
  이 사용자가 본 "오른쪽 벽을 본다" 였다). 규칙은 `housing/Rules.autoPlaceSpot` 하나가 갖고 UI 는
  `HousingRef.findFreeSpot` 으로 묻는다. 문 앞 여유는 **자동 배치에만** 있다 — `canPlaceAt` 에 넣으면
  `ShipState.sanitize` 가 이미 문 앞에 가구를 둔 함선에서 그 가구를 창고로 빼앗는다.
- **HUD 위험 표시는 화면 안/밖에 따라 하나만 뜬다** (2026-09-10). `ui/hud/DangerIndicators` 하나가 적
  곡사포탄 · 수류탄(아군 + 적) · 함선 호출 낙하물 · **로그 강하 포드**를 전부 들고, 화면 밖이면 크로스헤어
  바깥 방향 호를, 화면 안이면 머리 마커를 그린다 — 같은 위험물에 둘이 겹치지 않는다. **색이 누구 것인지를,
  `hot` 이 임박을 말한다** (아군 호박 · 적 빨강). 인지력 반경 게이트는 포탄에만 남기되 착탄 지점이
  `DANGER_NEAR_RADIUS` 안이면 무조건 보여 준다. **전장의 안개 게이트는 걸지 않는다** — 지금 벌어지는
  사건이지 발견된 오브젝트가 아니다.

- **한 아이템의 값어치를 정하는 자리는 `data/recipes.csv` 하나다** (2026-09-10, 제작 대개편). 수리비도 분해
  산출도 **그 아이템의 제작 재료**에서 나오고, 곱해지는 것은 `data/tables.csv` 의 남은 내구도 20 % 5구간 배수
  (`REPAIR_COST_BY_DURABILITY` 0.5→0.1 · `SALVAGE_YIELD_BY_DURABILITY` 0.08→0.40)뿐이다. 그래서 세 값이
  **따로 놀 수 없다** — 재료를 고치면 셋이 같이 움직인다. 두 표를 같은 구간에서 더한 값이 1 보다 작아야
  「제작 → 분해 → 제작」이, `분해(4) − 수리(b) ≤ 분해(b)` 여야 「고쳐서 뜯기」가 이득이 되지 않는다.
  `src/items/Salvage.checkSalvageEconomy()` 가 분해 38종 × 5구간 × 재료 종류 전부를 **실제 정수로** 돌려
  `npm run data:check` 가 매번 검산한다 — 값을 고치고 그 검사를 통과하면 그것이 곧 증명이다.
  분해 최소 보장은 **재료당 1 이 아니라 주재료 한 종류에만** 있다: 종류마다 보장하면 등급 IV 총의 「잉곳 2」가
  0 % 구간에서도 1 개 돌아오는데 같은 구간 수리비도 `ceil(2×0.5)=1` 이라 **잉곳이 스스로 늘어난다**.

- **상위 재료의 주 경로는 정제 작업대다** (2026-09-10, 사용자 결정 · 2026-09-11 C-35 정정 — "에서만" 은 사실이
  아니었다: 가중치 표에 줄이 없어 상자에서 T5 재료 픽의 91 % 가 상위재였다. 이제 상자는 재료 픽 중 T1–2 0 · T3 5 ·
  T4 10 · T5 15 % 만 주고(`data/loot_item_weights.csv`), IV–V 장비 분해로도 나온다 — 둘 다 의도). 3계열 × 2단계다 — 금속(합금 판 →
  강화합금 잉곳 · 폐금속+케이블 → 기계 부품) · 전자(구동 코어 → 축전 모듈 · 회로기판+파워셀 → 제어 모듈) ·
  섬유(천조각 → 강화 직조포 · 천조각+생체조직 → 복합 방탄섬유). 등급 IV~V 장비는 전부 그 장비군의 상위
  재료를 요구하므로 **정제 작업대가 후반 제작의 관문**이고, 그것만이 현장 빠른제작이 없는 계열이다.
  `WorkbenchKind` 에 `'refine'` 을 더한 것이 이번 계약 추가의 전부다 (나머지 넷은 한 줄도 안 바뀌었다).

- **`bench` 는 「그 레시피가 속한 작업대」다** (2026-09-10, 사용자 결정). 작업대를 열면 **그 작업대의 레시피만**
  보인다 — 예전에는 `bench` 가 없는 줄을 전부 실어 정제 작업대 Lv.3 에도 붕대 · 탄약이 떴고, 레시피가 94줄로
  늘면서 읽을 수 없어졌다. 그래서 현장 레시피도 자기 작업대를 밝힌다: 탄약 → 총기, 붕대 → 의학, 연막 → 가젯.
  `station: 'field'` + `bench` 는 **모순이 아니다** — "어디서든 만들 수 있고, 그 작업대 창에도 뜬다" 는 뜻이다
  (튜토리얼의 "같은 작업대 창에서 소총 → 탄약" 이 여기 기댄다). 가방 화면의 `빠른제작` 탭은 여전히
  `station` 으로 가른다 — 그 탭의 뜻은 "작업대 없이도 되는 것" 이다.

- **작업대 글리프의 원본은 `shared/WORKBENCH_ICON` 이다** (2026-09-10). 같은 글자가 제작 탭
  (`inventory/ui/labels`)과 가구 카드(`ui/hud/ShipManage`) **두 폴더에 복사돼** 있어 한쪽만 고치면 같은
  작업대가 두 화면에서 다른 그림이 됐다 — 「같은 것을 두 폴더가 쓰면 `shared` 로 뽑는다」 그대로다.

- **좁은 계단은 콜라이더가 벽이 된다** (2026-09-10). `resolveCollision` 의 상자 가지가 발이 윗면
  `PROP_TOP_MARGIN`(0.15) 안일 때만 통과시켜서, 디딤폭이 `PLAYER_RADIUS`(0.45)보다 좁으면 **어느 단에 서
  있든 바로 윗단이 늘 몸에 겹쳐** 매 프레임 아래로 밀렸다 — 지하실 계단에서 미끄러져 떨어지고 다시 올라오지
  못하던 그것이다. 이제 윗면이 `발 높이 + PROP_STEP_UP_MAX` 이하인 상자는 밀어내지 않는다(`getSurfaceY` 의
  천장과 **같은 식**). **원기둥 경로는 한 줄도 안 바뀌었다** — 낮은 바위까지 풀면 옆구리에 몸이 반지름만큼
  파고들고 수류탄 · 아이템이 그것을 넘어간다. 계단 치수도 **단 높이를 고정하고 단수를 거기서 뽑는다**
  (지하실 `STAIR_RISE_MAX` · 플랫폼 `RAIL_STAIR_MAX_RISE`): 데크 높이가 자리마다 다른데 단수를 고정하면
  언덕에서 한 단이 `PROP_STEP_UP_MAX` 를 넘는다.
- **들어가는 건물의 바닥은 한 장이어야 한다** (2026-09-10). 지상층이 *장식 바닥*(발자국 전체, 콜라이더 없음)과
  *천장 슬래브*(구덩이 + `PIT_BLEND` 만큼만, 콜라이더 있음) **두 겹**이라 그 사이 띠에서는 지형을 밟았는데,
  지형 격자(2 m)가 지하실 페더(1.6 m)보다 넓어 벽 안쪽이 최대 3.6 m 파여 있었다 — 문으로 들어서면 그 도랑에
  빠지고 턱을 마주쳐 **점프해야만** 들어갔다. `Build.floorPlate` 하나가 발자국 + `FLOOR_OVERHANG` 까지 덮고
  **콜라이더 윗면이 정확히 `y0`** 다 (그린 윗면만 `FLOOR_LIP` 만큼 띄워 z-fighting 을 피한다).
- **탑승은 발판 프레임이 아니라 차량 부피로 판정한다** (2026-09-10, 사용자 결정). 전차 위에서 조금만 움직여도
  내려지던 것은 `getStandingObstacle(...).velocity` 를 **밟고 있는 프레임에만** 더했기 때문이다 — 점프 · 경사 ·
  승강구 · 데크 가장자리에서 질의가 한 프레임만 빠져도 그만큼 차가 발밑에서 빠져나간다. 진입만 발판 질의를
  쓰고 **유지는 차량 OBB + 헤드룸**, **이동은 차량 로컬 좌표를 매 프레임 차량의 현재 변환으로 다시 푼다**
  (스냅샷을 찍지 않는다 — 함선 실내가 같은 이유로 깨졌다). `vel` 은 끝까지 **로컬 속도**라 2026-09-09 의
  "위치에 직접 더한다" 가 지키려던 것(이동 속도 · 스태미나 · 보행 애니메이션이 안 흔들린다)이 그대로 산다.
  ⚠ 같은 자리에서 `RAIL_DECK_STEP` 을 5 → 3 m 로 줄였다: 발판 상자는 평평한데 선로는 기울어 있어 윗면 오차가
  `step/2 × RAIL_MAX_GRADE` = **정확히 `TRAM_FLOOR_UP`(0.35)** 였고, 최대 경사 구간에서 선로 발판과 전차
  바닥이 같은 높이가 되면 `getStandingObstacle` 이 동점을 임의로 골라 **탑승이 시작조차 안 됐다**.
- **선로는 제일 먼저 잡고 나머지가 피한다** (2026-09-10). `line` 은 원점을 지나는 선분, `loop` 은 원점 중심
  원이라 `RailPlan` 의 자유도는 하나뿐이다 — 패드를 다 뽑은 **뒤에** 선로를 굴리면 비켜 갈 곳이 없다
  (반지름 20 m 원반 하나가 막는 방향 폭이 0.4 rad 라 스무 개면 π 를 넘는다). 그래서 `generateLayout` 이
  선로를 먼저 정하고 구조물 · 전초 · 둥지 · 크레이터 · 소품 · 상자 · 채집물이 `RAIL_CLEARANCE_M` 을 비운다.
  **대가**: 같은 시드의 매크로 레이아웃이 2026-09-09 이전과 다르다 (멀티 결정성은 그대로).

- **강하는 조용히 일어나지 않는다** (2026-09-10). 로그 강하(`enemies/RogueDrop`)는 규칙(구역당 1회 · 분대
  인원 비례 · 호스트 권한)은 그대로이고 **알림만 붙었다**: `rogueDrop:incoming` 하나를 세 폴더가 나눠 받는다 —
  `audio/AudioSystem` 이 무전 경보 `rogue_drop_alarm`(즉시)와 대기를 찢는 `rogue_pod_fall`(착지
  `ROGUE_DROP_FALL_LEAD_S` 초 전)을, `ui/hud/RaidAlerts` 가 토스트를, `ui/hud/DangerIndicators` 가 위험 표시를.
  `enemies/` 에 남은 소리는 포드마다의 `rogue_pod_impact` 뿐이다. **소리도 표시도 인지력 반경을 보지 않는다** —
  대기를 찢는 굉음이라 인지력이 좁아도 알아야 하므로 전용 반경 `ROGUE_DROP_ALERT_RADIUS`(260 m = 인지력의
  10배) **하나를 소리와 표시가 함께** 쓴다("들리는데 안 보인다" 가 없다). 그 대신 **감쇠는 남긴다** — 원격
  발소리와 같은 곡선이라 맵 반대편까지 들리지는 않는다. 소리를 audio/ 가 갖는 이유는 그 곡선이 패너 설정
  (`panOnly`)과 얽혀 있어서다 — 다른 폴더에서 볼륨을 정하면 감쇠가 두 번 곱해진다.

- **씬의 광원 개수를 플레이 중에 바꾸지 않는다** (2026-09-10). three.js 는 `projectObject` 에서 **보이지 않는
  가지를 통째로 건너뛰므로** 숨긴 그룹 밑의 광원은 세지 않는다. 그래서 그 그룹을 보이게 하는 순간
  `numPointLights` 가 늘고, 그러면 **씬에 있는 모든 머티리얼이 셰이더를 다시 컴파일한다** — 프레임 하나가
  통째로 멈춘다. 탈출 함선(광원 3)과 신호탄(광원 1)이 정확히 그 짓을 하고 있었고, 그것이 "함선이 도착할 때
  렉이 심하다" 의 정체였다. **규칙은 `core/fx/FlashPool` 이 처음부터 적어 둔 것 그대로다** — 광원은 씬에
  계속 두고 **`intensity` 만 0 으로 내린다**. 그러려면 표시 토글을 광원이 **아닌** 곳에 둬야 한다:
  `Dropship.root` 는 영영 보이는 채로 광원을 들고 `Dropship.body` 가 메시 전부와 `visible` 을 갖는다
  (`FlareColumn` 은 `group` 대신 `shown` 플래그). 같은 이유로 **헬포드**도 `group`(광원) / `body`(메시)로
  갈라져 있고(재접속 복귀의 `hide()` + 구조선 강하의 `start()` 가 레이드 중에 두 번 바꾸고 있었다),
  **분대장 기기**의 광원은 기기 안이 아니라 `init` 때 씬에 심어 둔 것 하나다(`Leader.installLeaderLight`) —
  광원을 든 오브젝트를 씬에 넣고 빼는 것만으로도 같은 일이 난다. 이 규칙은 **`npm run verify` 가
  `smoke-lights` 로 강제한다**: 세션 한 바퀴(함선 · 도킹 · 공유 함선 · 행성 · 분대원 포드)를 돌며
  `traverseVisible` 로 세어, **숫자가 한 번이라도 바뀌면 실패한다** (아래 2차). 광원을 새로 만드는 코드는 이 규칙을 먼저 읽는다.
- **장면이 바뀌어도 점광원 개수는 같고, 새 장면은 셰이더를 컴파일한 뒤에 그린다** (2026-09-10 2차). 멀티에서
  공유 함선 합류 · 강하 때 수 초씩 멈추던 렉의 정체는 네트워크가 아니라 **셰이더 컴파일**이었다 (같은 시드로 두
  번째 강하 = 2.8 → 0.4초). 셋이 겹쳐 있었다: ① 분대원의 첫 `pod drop` 마다 `new Hellpod()` 가 광원을 씬에
  넣었다(분대원마다 2.7 · 3.1초) — `player/RemotePods` 가 포드 3개를 상주시킨다. ② 개인 함선 27 · 도킹 컷씬 15 ·
  공유 함선 29 · 행성 20 — **장면마다 개수가 달라** 이미 컴파일한 프로그램을 다음 장면이 못 썼다 —
  `core/LightBudget` 이 intensity 0 여분으로 `SCENE_POINT_LIGHT_BUDGET`(23)을 세션 내내 지키고, 함선은 광원
  자리를 그대로 둔 채 **가까운 `HUB_POINT_LIGHTS`(8) 자리에만** 불을 건다(`hub/interiors/LightPool`).
  ③ 첫 프레임이 컴파일을 떠안았다 — **`ctx.shaders`**(`core/ShaderWarmup`)가 `world:ready` · 함선 진입마다 씬을
  컴파일하고 드라이버가 끝낼 때까지 **시뮬레이션 dt 0 + 그리기 생략으로 hold** 하며, 도킹 컷씬은 도착할 함선을
  미리 짓는다. **컴파일은 반드시 `ctx.shaders` 로 한다** — 프로그램 키의 색공간 · 톤매핑이 *바인딩된 렌더
  타깃*에서 오므로 업데이트 도중 `renderer.compile` 을 부르면(타깃 = 캔버스) 쓰이지 않을 변형만 만든다
  (`WeaponFx.warmUp` 이 그랬다). 광원을 더하는 코드는 **상주 광원 15 + 자기 장면 광원 ≤ 예산**인지 본다.
- **함선처럼 움직이는 실내는 박스를 매 프레임 다시 쓴다** (2026-09-10). `PlayerRef.setShipInterior(bounds)` 는
  **참조를 들고 있고** `PlayerController` 가 거기서 바닥 높이와 XZ 클램프를 읽는다 — 탑승 순간 찍어 둔
  스냅샷을 넘기면 함선이 이륙할 때 바닥만 땅에 남아 플레이어가 떨어진다. 바닥 높이는 박스의 상수가 아니라
  **데크 평면**에서 푼다 (`Dropship.floorYAt`): 이륙 상승은 기수를 0.35 rad 들어 올리므로 평평한 높이 하나로는
  화물칸 끝에서 0.9 m 가 어긋난다. 그리고 `attachTo` 로 붙은 몸은 **`update` 와 `lateUpdate` 양쪽에서**
  부모 행렬로부터 월드 좌표를 다시 읽는다 — 태우는 쪽(`extraction`)이 `player` **뒤에** 등록돼 있어서다.
- **접속할 서버 주소는 네 곳에서 오고 순서가 정해져 있다** (2026-09-10). ① 게임 안 `설정 › 서버 설정`
  (localStorage `scav.relay`, **슬롯 공용**) → ② `--relay=` · `SCAV_RELAY` → ③ 배포 폴더의 `server.txt`
  첫 줄 → ④ 같은 오리진 `/ws` (vite 프록시 · 데스크톱 앱의 임베디드 릴레이). ②③④ 를 고르는 곳은
  `electron/main.ts` 하나이고 렌더러에는 **같은 오리진 `/ws`** 로만 보이므로, `src/` 가 갈라지는 지점은
  `net/parts/Socket.defaultUrl()` 의 ① 하나다. 주소 문자열을 해석하는 곳도 **하나뿐**이다 —
  `shared/net.relayUrlFrom` (예전 `electron/main.ts` 의 `toRelayUrl`). 설정 UI · 렌더러 · 셸이 각자
  정규화하면 초록불이 뜬 주소로 앱이 다른 데 붙는다. **연결 테스트는 토큰 없이** 붙는다: 같은 토큰으로
  두 번 붙으면 서버가 중복 세션으로 보고 살아 있는 내 소켓을 끊는다.
- **배포 폴더에는 누를 것만 둔다** (2026-09-10, 사용자 결정). electron 빌드 전부를 `app/` 으로 내리고 루트에는
  stub `SCAVANGER.exe` · `server.txt` · `SCAVANGER-Server.exe` 만 남긴다 (`scripts/pack-release.mjs`).
  그래서 `electron/main.ts` 의 `configDirs()` 는 **`execPath` 의 부모까지** 후보로 본다 — 사람이 고치는
  `server.txt` 는 `app/` 밖에 있다. 서버 exe 의 프로필 저장소도 같은 이유로 `%LOCALAPPDATA%\SCAVANGER\server`
  다 (`--data=` 로 옮긴다). **아이콘도 코드로 그린다** (`scripts/make-icon.mjs` — 외부 에셋 금지는 아이콘에도
  적용된다) 그리고 게임 · stub · 서버 exe 가 같은 `icon.ico` 를 쓴다.

- **지형지물 콜라이더는 볼록 윤곽이다** (2026-09-11, 사용자 결정). 바위 · 첨탑 · 크리스탈 · 잔해는 원 하나가 아니라
  `Obstacle.hull` — 땅 위로 보이는 메시의 2D 볼록 껍질(`world/propHull.ts` → `world/hull.ts`)이고, 이동 · 발판은 몸
  높이까지의 윤곽 하나, 총알 · 시야는 높이별 층(`hull.bands`)을 본다. `radius` 는 계약대로 외접원으로 채운다(해시용).
  원기둥과 같이 **올라설 수 있는 단 예외가 없다**. 콜라이더 반지름으로 소품 크기를 추정하는 코드를 새로 짜지 않는다 —
  `obstacleCoverage` 처럼 윤곽의 넓이를 쓴다.
- **계단은 경사 콜라이더다** (2026-09-11, 사용자 결정 "스르륵"). `Obstacle.ramp`(상자 + 로컬 +X 로 오르는 윗면)이고
  단은 그림뿐이다 — 새 계단은 `world/structures/parts/Stairs.buildStairFlight` 로 만든다. 경사면은 디딤판 한가운데를
  잇고, **위 끝이 위층 바닥판과 0.08 m 겹쳐야 한다**: 정확히 같은 선이면 부동소수 오차로 두 콜라이더가 이음매의 점을
  모두 놓쳐 발밑이 한 층 아래가 된다. 그 밖의 단차는 `player/` 가 모델 · 카메라만 따라가게 한다(`bodyOffset`).
- **작은 몸은 사람 규칙으로 밀지 않는다** (2026-09-11). `resolveCollision(position, radius)` 에서 `radius <
  SMALL_BODY_R`(0.25, 수류탄 · 투척 가젯 · 아이템)이면 뜬 상자의 머리 위 여유가 제 크기(`2r`)뿐이고 "올라설 수 있는 단"
  예외가 없다 — 사람 기준 `BOX_HEADROOM`(2.1)을 그대로 쓰면 실내 수류탄이 천장판에 걸려 **건물 밖으로 밀려 나갔다**.
  그리고 **떨어지는 물건의 바닥은 `getHeightAt` 이 아니라 `getSurfaceY(x, z, 몸 윗면 − PROP_STEP_UP_MAX)`** 다 —
  지형만 보면 2층 바닥판을 뚫고 떨어진다. 새 투척물 · 낙하물도 이 두 규칙을 따른다.
- **월드 천장은 머리가 아니라 발 + `BOX_HEADROOM` 으로 잰다** (2026-09-11). `resolveCollision` 의 상자 가지가 발 + 2.1 m
  가 밑면을 넘는 순간 옆으로 밀어내므로, 점프 클램프(`PlayerController`)가 1.8 m 머리만 막으면 낮은 판 밑에서 몸이 튕겨
  나간다. 두 값은 `data/constants.csv` 의 `BOX_HEADROOM` 하나다.
- **빛기둥은 시체에만 선다** (2026-09-11, 사용자 결정). `ui/hud/pillar.pillarAllowed`(`corpse:` · `pcorpse:`)가
  `Detection` · `ScanReveal` 의 유일한 관문이고 떨어진 아이템 기둥도 껐다. 상자 · 컨테이너는 대신 **열린 모습**이
  조사 여부를 말한다 — 연 사람이 `crate opened` 를 보내고(확정 불필요) 호스트가 `crate sync {ids}` 로 늦게 합류한
  사람에게 준다. 열린 **모습**(`def.opened` / `opened`)과 **내 첫 개봉**(`rolled` — 통계 · 키카드 채우기 ·
  `structure:investigated`)은 따로다: 남이 먼저 열어도 내 컨테이너 캐시에는 키카드가 없다.
- **깨진 창은 사람을 막는다** (2026-09-11, 사용자 결정 "총알 · 투척물만 통과"). 유리 콜라이더는 깨져도 hash 에 남고
  `passRays` · `passSmall`(world 내부 플래그)로 바뀐다. 투척물은 걸음마다 `shared/fragile.breakFragileAlong` 으로
  유리를 깬다 — `resolveCollision` 은 누가 부르는지 모르므로 레이로 훑어야 한다.
- **구조물 방 조명은 광원 풀이다** (2026-09-11, 사용자 결정). 컨테이너가 놓인 방마다 광원 **자리**를 두고 진짜 광원은
  `STRUCTURE_POINT_LIGHTS`(4)개만 가까운 자리에 건다 (`shared/lightPool` — 함선과 같은 코드, 층이 다르면 뒤로 민다).
  풀은 **구조물이 없는 맵에서도** 만든다. 그래서 `SCENE_POINT_LIGHT_BUDGET` 은 23 → **25** (레이드 = 상주 15 + 패드 3 +
  콘솔 3 + 구조물 4) — 레이드에 광원을 더하는 코드는 여분이 **0** 이라는 것을 먼저 안다.
- **맵 스캐너는 전진기지 · 연구실의 옥상에만 있다** (2026-09-11, 사용자 결정). 옥상은 층수와 상관없이 늘 있고 맨 위층의
  격벽 사다리로만 오른다 (적은 사다리를 못 탄다). 불시착 함선에는 스캐너가 없다.
- **드론은 소유자 권한이다** (2026-09-11). 배치물(`gad`, 호스트 권한)과 반대로 드론의 위치 · 체력 · 조종은 **소유자
  클라이언트**가 시뮬레이션하고 `drone state` 로 방송한다 — 조종 입력 지연을 없애려고. 호스트의 적이 때리면
  `ctx.drones.damageDrone` 이 `droneq damage` 로 소유자에게 넘긴다. 드론 아이템은 **꺼내도 소모되지 않고 조종기로
  남으며** 파괴될 때만 1개가 빠진다 · 종류당 1대. 조종 중 PC 는 `PlayerRef.setDroneControl` 로 **앉은 채 멈추고**
  (사용자 결정) 카메라는 매 프레임 `setCameraOverride(pos, look, true)`, 복귀는 `setCameraOverride(null, undefined, true)`
  (하드 컷 — 먼 드론에서 블렌드하면 카메라가 지형을 훑는다). 조종 중 막히는 입력은 폴더마다 `ctx.player.droneControl`
  을 본다(무기 · T · F · Q · G · H). 핑은 `ctx.camera` 기준이라 드론 시점에서 그대로 나간다.
- **드론 yaw 는 「코 = 모델 +Z」 규약이다** (2026-09-11). forward = `(sin yaw, 0, cos yaw)` — 플레이어 카메라
  (`−sin, −cos`)와 반대라 꺼낼 때 `droneYawFromPlayer`(+π) 를 거친다. 두 몸체(`GroundDrone` · `AirDrone`)가 같은 규약을
  써야 `DroneInput.yaw` · 카메라 · 이동이 맞는다 (공중 드론이 한 번 반대 규약으로 만들어졌다가 고쳐졌다 — `drones/model.ts` 주석이 원본).
- **설치 미리보기와 실제 설치는 같은 함수다** (2026-09-11). `gadgets/parts/Preview` 의 판정 하나가 고스트 색 · 거부
  사유 · 드론 탑재를 정하고, 좌클릭은 그 순간 같은 판정을 다시 돌린다 — 초록이면 선다. 대형
  (`LARGE_DEPLOYABLE_KINDS` — 바리케이드 · 점프대 · 포탑)은 평평 + 공간, 소형(`MOUNTABLE_DEPLOYABLE_KINDS`)만 드론
  윗면. 설치 높이는 이제 판정이 준 y(표면 · 2층 바닥 · 드론 윗면)이고 지형으로 덮지 않는다.
- **원격 지뢰 중첩 피해는 대상마다 합산 1회다** (2026-09-11, 사용자 결정). 한 번의 기폭에서 한 대상에 대해 C4 마다의
  피해를 모아 `최대 + (합 − 최대) × GADGET_REMOTE_MINE_STACK_MUL` 을 **한 번만** 적용한다(복리 아님). 그래서 원격 지뢰는
  공용 `applyExplosion` 류를 부르지 않는다 — 드론에도 `damageDrone(합산)` 이다.
- **네임드 로그는 레이드당 최대 한 명이다** (2026-09-11, 사용자 결정). 확률 `NAMED_ROGUE_CHANCE_BY_RANK[planetTier − 1]`
  (4 % … 35 %), 굴림은 `enemies/named/Director` 가 `world:ready` 에서만 한다. AI · 겉모습 · 리플리카 연출은 **종류별
  파일**(`ai/named/*` · `models/named/*`)이 갖고 공용 파일에는 **훅만** 있다 — `Enemy.named*` 필드, `HostSync.animHint`
  의 `namedHint`(14–20), `Replica` 의 before/after/event 훅, `EnemyHost.fireGun` 의 `RogueShotOpts`(생략하면 예전 로그
  사격과 똑같다). 로든의 스캔 저격은 150(실드 100 + 체력 100 이면 산다, 사용자 결정)이고 반드시 조준경 반짝임이 먼저 뜬다.
  네임드 확정 드롭은 **행성 등급 곡선을 무시한다**("최소 희귀부터"), 내구도 1–5 %.
- **적이 드론을 노리는 목록은 `alive` 와 따로다** (2026-09-11). `TargetList.drones` 는 `aggroable` 드론만 담는다 —
  걷는 지상 드론은 절대 안 들어간다. `alive` 에 넣으면 스포너 · 웨이브 · 스플래시가 드론을 플레이어로 착각한다.
  `world:noise` 는 권한에서만 나오고 소리만으로는 표적이 되지 않는다(가서 보고, 보이면 노린다).
- **화면 투영(`Vector3.project`)은 `HudSystem.lateUpdate` 에서 한다** (2026-09-11 C-53 · X-9). `project` 는
  `camera.matrixWorldInverse` 만 읽는데 카메라 리그는 그것을 갱신하지 않으므로, `update` 에서 투영하면 **직전 프레임의
  뷰**로 그린다(월드 마커 · 핑 · 화면 밖 화살표가 한 프레임 늦던 것). `lateUpdate` 첫 줄이 `camera.updateMatrixWorld()` 다.
- **서버 문서가 로컬 편집을 덮지 않는다** (2026-09-11). 편집 뒤 저장 debounce 안에 릴레이 welcome(`net:profileLoaded`)이
  오면 그 문서는 편집보다 **오래된** 것이다 — `housing` 이 그걸로 상태를 갈아 끼우고 대기 중인 저장까지 취소해 방금 놓은
  가구가 사라졌다(부하에서 smoke-training 이 빨갛던 원인). 프로필 문서를 받는 폴더는 **저장 대기 중인 로컬 편집이 있으면
  그 편집을 올리고 교체하지 않는다**. 스모크도 상태를 직접 심기 전에 `net:profileLoaded` 를 기다린다.

- **프로필 문서는 시계가 아니라 리비전으로 병합한다** (2026-09-11 E-6, 사용자 결정 "서버 우선 + 경고"). `profile:set {baseRev, writeId}` 가
  서버 `docsRev[key]` 와 같을 때만 저장되고(`profile:ack`), 다르면 `profile:conflict` 로 **서버 사본이 이긴다**. 쓰기 큐는
  `slotKey(PROFILE_QUEUE_STORAGE_KEY)` 에 영속돼 ack 를 받아야 지워진다 — 오프라인에서 한 진행은 다음 접속 때 `baseRev === 서버 rev` 면
  로컬이 이긴다. **한 편집이 문서 두 개 이상을 걸치면 `ProfileRef.setMany`** 다(창고+로드아웃 · 시체 벗기기 · 퀘스트 완료). `baseRev`
  없는 옛 프레임은 Phase 9 도장 규칙 그대로.
- **서버 크레딧은 사유를 검증한다** (2026-09-11 E-4, 사용자 결정). `credits:tx` 의 `reason` 은 `shared/credits.formatCreditReason` 문법
  (`buy:` · `sell:<id>:<qty>` · `refund:` · `repair:` · `contract:` · `quest:` · `migrate`)이고 릴레이가 `server/economy.gen.json`(csv 에서
  생성 — `data:check` 가 stale 을 잡는다)과 원장으로 금액을 맞춘다. **아이템 소유는 보지 않는다**(창고 문서가 클라이언트 쓰기 — TODO E-9).
  **dev 사유(`/credits` 콘솔 · `smoke:*` · `e2e:*` · `shot`)는 `SCAV_DEV_ECONOMY=1` 릴레이만 받는다** — 켜는 곳은 `scripts/verify.mjs` 가
  스스로 띄우는 릴레이뿐이고 `dev:all` · `start-server.bat` · `npm run server` · 배포 exe · 데스크톱 셸은 끈다(`/health.devEconomy`).
  **공용 릴레이를 손으로 띄워 병렬 스모크에 쓸 때는 `SCAV_DEV_ECONOMY=1` 을 붙인다.**
- **남에게 영향 주는 메시지는 권위에서만 받는다** (2026-09-11 E-4). 함선 호출 `strat call` · 적 이벤트 `ee` · `crate sync` 는 로비 호스트가 보낸
  것만, 분대원 호출은 `stratq call` 로 호스트가 검사해 재방송한다. 피어끼리 가는 `buff` 는 받는 폴더(implants · gadgets)가
  `shared/buffRules.createBuffGuard` 로 로비 멤버 · 스냅샷 거리 · 양 · 빈도를 자르고, 보내는 쪽은 가슴 → 가슴 레이로 벽 뒤에 보내지 않는다.
  분대 계약의 킬 몫은 `enemy:squadKill`(호스트 킬에서 파생)로 센다. "내가 나에게" 치트는 범위 밖이다.
- **링크가 `refused` 면 스스로 다시 붙지 않는다** (2026-09-11 B-1). 추방 · 인원 초과 · 다른 창 접속 뒤에는 배경 프로브도, 함선 진입의
  `tryResume` 도 접속하지 않는다 — `ensureConnected()` 는 명시적 접속이라 `refused` 를 지우므로 **자동으로 부르는 코드는 먼저 `net.link.state` 를 본다.**

## 5. 품질 기준

브라우저 안에서의 AAA 감각: 읽히는 실루엣, 강한 조명(태양 + 반구광 + 포그 + emissive 글로우), 부드러운 애니메이션(절차 보행 · 트윈 UI),
화면 흔들림, 타격 피드백, 파티클 FX(instanced/points), 적 ~60마리에서 60 fps 목표. 타입체크 클린.

## 6. 검증 (자세히는 [docs/VERIFICATION.md](docs/VERIFICATION.md))

- **매 편집 후**: `npm run typecheck` (수 초). `data/*.csv` 를 만졌으면 `npm run data:check` 도 (수 초).
- **기능 하나 끝낸 뒤**: `npm run verify` — 건드린 폴더에 매핑된 스모크만 GPU 4레인 병렬, vite/릴레이는 러너가 띄운다.
- **머지 전, 또는 `src/shared` · `src/core` · `main.ts` 를 건드렸으면**: `npm run verify:all` (+ build + `e2e:mp`).
  스모크를 손으로 하나씩 돌리지 않는다 — 그게 1시간짜리 검증이었다.
- **배포물을 건드렸으면**(`server/tool.ts` · `scripts/build-server.mjs` · `pack-release.mjs` · `electron/`):
  `npm run verify` 가 `smoke-server-dist` 를 자동으로 돌린다(번들 · 부팅 · 주소 규약). 실제 exe · 배포 폴더는
  `npm run app:dist` 를 한 번 돌려 `release/SCAVANGER/` 가 넷으로만 채워지는지 눈으로 본다 — 이건 자동화하지 않았다.
  `electron/` · `pack-release.mjs` 를 건드리면 verify 가 `smoke-desktop` 도 고른다 (약 30 초, 오래된 `dist/` 면 빌드 추가). CDP 키는
  `before-input-event` 를 타지 않으므로 Escape 배선은 메인 프로세스 `sendInputEvent` 로 본다 — 포인터 락 타이밍은 여전히 수동.
- 디버그 훅: `window.__game.ctx`, `window.__game.getSystem('player'|'weapons'|'net'|'enemies'|…)`.
- **끝나면 문서**: 건드린 폴더의 `README.md`(구조 + `변경 이력`), 이 파일의 폴더 지도 행(한 줄),
  [docs/HISTORY.md](docs/HISTORY.md) 의 작업 기록, 러너가 뱉은 `docs line:` 을 [docs/VERIFICATION.md](docs/VERIFICATION.md) 에.
