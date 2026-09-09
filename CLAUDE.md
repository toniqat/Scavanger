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
| **투자자 · 퍼블리셔용 소개 문서** (위키형 HTML, 빌드 없음 · 공개본 **https://toniqat.github.io/Scavanger/**) | [docs/pitch/README.md](docs/pitch/README.md) → `docs/pitch/index.html` (페이지 원본은 `docs/pitch/pages/00-intro.html` … `22-controls.html` 23개) |

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
npm run app:dist   # + electron-builder → release/SCAVANGER-<version>-portable.exe

npm run verify     # 기능 하나 끝낸 뒤: typecheck + selftest + 건드린 폴더에 매핑된 스모크만 (4 병렬)
npm run verify:all # 머지 전: 전부 + build + e2e:mp (~10 분)
npm run net:selftest   # 서버 프로토콜 셀프테스트 (브라우저 불필요)
npm run e2e:mp         # 헤드리스 크롬 2대로 릴레이+vite 관통 테스트

npm run pitch:webp # 피칭 문서 배포본 이미지: docs/pitch/assets/*.png → 같은 이름의 .webp (30MB → 2.8MB)
```

개별 스모크 스크립트 30종의 목록과 각각이 검사하는 내용은 **[scripts/README.md](scripts/README.md)** 에 있다.
`npm run verify` 가 폴더 → 스크립트 매핑으로 알아서 고르므로 손으로 하나씩 돌리지 않는다 (`node scripts/verify.mjs --list`).

Windows 원클릭 실행 (프로젝트 루트에서 더블클릭):

```
start-server.bat         # node 확인 → 필요시 npm install → npm run dev:all (릴레이 8787 + vite 5273)
start-server.bat relay   # 릴레이만 (npm run server, 0.0.0.0:8787) — 데스크톱 앱만 쓸 때
```

배너에 이 PC 의 LAN 주소(`ws://<IP>:8787/ws`)를 찍는다 — 데스크톱 앱이 접속할 값이다.
게임 실행은 `SCAVANGER.exe` 또는 `npm run dev`.
`start-server.bat` 은 한국어 메시지를 위해 **CP949(시스템 ANSI)** 로 저장한다 — UTF-8 + `chcp 65001` 조합은 cmd 가 label 을 재탐색할 때 파싱이 깨진다.

---

## 3. 폴더 지도

각 행의 README 가 그 폴더의 파일 구성 · 공개 API · 변경 이력을 갖는다. **폴더 내부를 고치기 전에 그 README 를 읽는다.**

### 3.1 계약 · 엔진

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`data/`](data/README.md) | — | — | **게임 수치의 단일 원본 (csv 35개).** 데미지 · 체력 · 가격 · 확률 · 쿨다운 — `src/` 에는 같은 숫자가 없다 |
| [`src/shared/`](src/shared/README.md) | — | `GameContext`, `EventBus`, `Input`, `Random` | **계약. 제일 먼저 읽는다.** 타입 · 이벤트 · 상수(값은 `data/constants.csv`) · 키바인드 · csv 로더(`data/`) · 각 시스템의 `*Ref` 인터페이스 · **캐릭터 세이브 슬롯(`saveSlot`)** · **캐릭터 생성 규칙(`character`)** · **재화 칩(`currency`)** |
| [`src/core/`](src/core/README.md) | `Engine` | scene / camera / renderer | 렌더러 · 조명 · 하늘 · 포그 · 포스트프로세스 · 메인 루프 · 리사이즈 · 시스템 레지스트리 |
| [`src/main.ts`](src/main.ts) | — | — | Engine 부트스트랩 + 시스템 등록 순서, 커서 모드 ↔ 버스 브리지, 포인터 락 재요청의 **유일한** 지점 |

### 3.2 플레이어 · 전투

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/player/`](src/player/README.md) | `PlayerSystem` | `ctx.player` | 3인칭 컨트롤러 · 카메라 리그 · 절차 생성 병사 모델 · **강하 포드 동기화(아군 헬포드가 보인다) · 구조선 부활** · 체력/전투불능(**1인 분대는 즉사**)/스태미나 · 자세 · 상호작용 · 실내 충돌 · 원격 아바타(**같은 함선끼리만 보인다**) · 호스트 고스트 |
| [`src/weapons/`](src/weapons/README.md) | `WeaponSystem` | — | 무기 3슬롯 · 실효 스탯 · 내구도 · 탄약 v2 · 히트스캔/발사체 · 빠른 사용 휠 · 수류탄 · 근접 · 유니크 무기 · 원격 재생 |
| [`src/implants/`](src/implants/README.md) | `ImplantSystem` | `ctx.implants` | 전술 임플란트 6종 (갈고리 · 대시 · 배리어 방패 · 오버차지 · 정찰 스캔 · 대전차포), Q 키 구동, 배리어 충돌/흡수/실드 배쉬 |
| [`src/gadgets/`](src/gadgets/README.md) | `GadgetSystem` | `ctx.gadgets` | 소모품 가젯 10종 (은폐 · 돔 실드 · 바리케이드 · 수류탄류 · 지뢰 · 포탑 · 제세동기 · 점프대), 호스트 권한 배치물 |
| [`src/stratagems/`](src/stratagems/README.md) | `StratagemSystem` | `ctx.stratagems` | 함선 호출 4종 (**궤도 폭격 = 호스트 전용** · 보급품 · 트라이포드 · **구조선(분대 공용 5회)**), G 휠 · 상단 시점 조준 · 공유 쿨다운 |

### 3.3 월드 · 적

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/world/`](src/world/README.md) | `WorldSystem` | `ctx.world` | 절차 지형 · 바이옴 · 소품/장애물(**콜라이더 = 보이는 실루엣**, 낮은 것은 `getSurfaceY` 로 **올라선다**) · 상자 · 탈출 패드 · 채집 노드(약초 · **고철 더미**) · **전장의 안개(`ctx.world.fog`)** · 시뮬레이션 훈련장 · 충돌/레이캐스트 질의 |
| [`src/enemies/`](src/enemies/README.md) | `EnemySystem` | `ctx.enemies` | 버그 5종 + 휴머노이드 로그 AI · 포병 · 베헤모스 · 팩션 · 시체 루팅 · 상태이상 · 총알 추적 · **지형지물 접지(`getSurfaceY`) · 대형 적 스폰 여유** · 호스트/리플리카 동기화 |
| [`src/extraction/`](src/extraction/README.md) | `ExtractionSystem` | — | 탈출 콘솔(**평상시 빛기둥 없음 — 활성화 뒤에만 켜진다**) · **60초** 카운트다운(`EXTRACTION_COUNTDOWN`) · 함선 착륙/탑승/이륙, 호스트 권한 |

### 3.4 아이템 · 인벤토리 · 메타

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/items/`](src/items/README.md) | (데이터) | `ctx.loot` | 무기 6계열 × 등급 I–V · 탄약 · 부착물 · 가방 · 방어구 · 회복 소모품 · 씨앗 · 서적 · 임플란트 아이템 · 루팅 테이블 · 레시피(제작 · **고물 분해**) |
| [`src/inventory/`](src/inventory/README.md) | `InventorySystem` | `ctx.inventory` | 디아블로2식 격자 모델 · 가방/장비/**임플란트 칸**/퀵슬롯 · 함선 창고 · **사망 시 전량 시체로(`stripForCorpse`) · 컨테이너별 격자 크기** · 컨테이너 감정 · 소켓 · 제작(**1초 홀드 · 한 칸 산출물 썸네일 · 제작 수량 ◀▶ · 넣을 자리 없으면 버튼 잠금(가방 → 창고)**)/분해/**수리 팝업** · 출격 준비 점검 · Tab 화면(인벤토리/캐릭터/기업/함선) · **무기 툴팁 = 2×2 게이지(대미지 · 연사 · 반동 · 사거리, 소켓 보너스 초록 · 반동 감소 초록 윤곽) + 우상단 탄종 썸네일 + 소켓 썸네일 한 줄**, **탄약 요청은 장착 무기 휠클릭 (`탄약 필요: <탄종>`)** |
| [`src/pickups/`](src/pickups/README.md) | `PickupSystem` | `ctx.pickups` | 월드에 떨어진 아이템 (투척 궤적 · 절차 메시 · 빛기둥 · 호스트 권한 동기화) |
| [`src/meta/`](src/meta/README.md) | `MetaSystem` | `ctx.meta` | 기업 4곳 · 신뢰도(모자란 거래/계약 탭은 잠김) · 크레딧 · 상점/거래대 · 계약 · 퀘스트 · 임플란트 수리 데스크. 화면은 **왼쪽 한 열**(기업 목록 → 신뢰도 게이지 → 페이지 탭 → 크레딧) + 페이지 + **풀 높이 가방/창고/진행 중인 계약**, 보상은 **재화 썸네일** |
| [`src/progression/`](src/progression/README.md) | `ProgressionSystem` | `ctx.progression` | 레벨/XP · 능력치 5종 · 숙련도 14종 · 파생 수치(`derived`) · 임플란트 장착칸 규칙 · 캐릭터 시트(능력치 · 숙련도만 — 임플란트 UI 는 인벤토리) · 프로필 영속화(**슬롯별**, `accent`/`createdAt` 포함) |
| [`src/housing/`](src/housing/README.md) | `HousingSystem` | `ctx.housing` | 함선 꾸미기 규칙 · 방 용도/시설 레벨 · 가구 · 재배 · 서재 · 로드아웃 프리셋 · `ShipState` 영속화 |

### 3.5 셸 · 흐름 · 표현

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/hub/`](src/hub/README.md) | `HubSystem` | `ctx.hub` | 개인/공유 함선 내부 · **격납고(개인 함선 4대 정박 · 방문)** · 도킹 컷씬 · **창문 워프(행성 이동, 조작 유지)** · 발사 포드(출격 준비 경고) · 전체화면 터미널(**닫기 버튼만 · 키 가이드 없음**) · 행성 선택 · 작업대 · 시설 관리 모드 · **분대원 상호작용 → 분대장 넘기기** |
| [`src/game/`](src/game/README.md) | `GameFlowSystem` | `ctx.phase`, `ctx.corpses` | 페이즈 상태 기계 · **사망/시체(`ctx.corpses`, 자동 부활 없음 — 구조선만)** · **분대장 기기** · 레이드 실패 · **일시정지(ESC = 항상 열기, `escapePause`)** · 재접속 UX · 레이드 세션 저장/복귀 · 재개 게이트 |
| [`src/ui/`](src/ui/README.md) | `HudSystem` | — | 모든 DOM UI — HUD 2계층 · 메뉴(**타이틀 = 워드마크 + 게임 시작/설정/종료**, **캐릭터 선택 3칸 · 캐릭터 생성(3D 프리뷰)**, **ESC = 중앙 왼쪽 고정**, 설정 3분할 · 화면 중앙 · 조작 다이어그램, **경고 팝업의 확정은 1초 홀드**) · 지도(**전장의 안개 — 미탐색은 회색 윤곽, 발견한 것만 마커**) · 채팅(**Enter 전송 후 유지 · Tab 닫기**) · **우측 하단 키 가이드(`ui:keyGuide`)** · 소셜(커뮤니티 패널 단일, **고정 크기**) · 크로스헤어(**헤드샷 타격 표시 = 1.6배 X**) · **핑 v3(함선 안에서도 · 플레이어별 3개 · 관대한 조준 · 확인 핑 = 분대 색 원 · 모든 핑이 채팅 한 줄 · 화면 밖 화살표는 수명 내내)** · **입력 중 `…` 말풍선(원격만)** · 굵은 피격 방향 호 · 아이템 툴팁(**크기 줄 없음 · 무게 좌하단 · 가치 우하단**) · 커서 아트 · 스타일시트 |
| [`src/audio/`](src/audio/README.md) | `AudioSystem` | `ctx.audio` | 절차 WebAudio SFX 전량 + 앰비언트, 버스 이벤트에 반응, 볼륨 영속화 |
| [`src/tutorial/`](src/tutorial/README.md) | `TutorialSystem` | `ctx.tutorial` | 새 캐릭터 안내 18단계 — 목표 패널 · UI 스포트라이트(**합집합 포커싱**) · 바닥 안내선, 순서 강제 게이트(`blockReason`) + **잠긴 항목 숨김**(`hides`, **함선 창고 아이템 포함**) · 부족한 재료 top-up · **1초 홀드 건너뛰기** |
| [`src/console/`](src/console/README.md) | `ConsoleSystem` | `ctx.console` | 개발자 콘솔 + 치트 (**dev 호스트에서만** 존재 — 그 외에는 DOM 도 키도 없다) |

### 3.6 네트워크 · 배포

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/net/`](src/net/README.md) | `NetSystem` | `ctx.net` | 릴레이 WebSocket 클라이언트 · 세션 토큰 · 로비 · 20 Hz 스냅샷 · 프로필 동기화 · 소셜 · 크루 카드 · **함선 배치(`ship state`)** · **분대장 지명 이관** · `PlayerFlags.TYPING`(채팅 입력 중) |
| [`server/`](server/README.md) | (Node) | — | `ws` 릴레이 — 로비 · 5분 재접속 유예 · 호스트 이관(**자동 + 지명 `lobby:transferHost`**) · 프로필/레이드/소셜 저장소 · `selftest.ts` |
| [`electron/`](electron/README.md) | (Electron main) | — | 데스크톱 스탠드얼론 셸 — 같은 프로세스에 릴레이 + `dist/` 를 로컬 http 로 서빙(**창 포트 8790 고정 = 세이브 오리진**), `src/`·`server/` 무변경 |

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
  `shared/Input` 이 우리 요청(`lastLockRequest`) 뒤 `LOCK_BOUNCE_GRACE_MS` 안의 락 상실을 걸러 내고
  제스처 재시도만 건다. 이 창 안에서 진짜 Escape 를 놓쳐도 락 없는 Escape 는 진짜 keydown 으로 들어온다.
- **Escape 는 일시정지 메뉴를 열기만 한다** (2026-09-08). 화면은 각자 자기를 연 키로 닫고(Tab · M · P · E),
  메뉴는 그 위에 쌓인다 — 닫는 것은 `게임으로 돌아가기` 클릭뿐이다. 가장 안쪽 팝업만 Escape 를 먼저 먹는다.
  그 예외에 **하우징 모드**(`hub/HousingMode`)가 들어간다 — 화면이 아니라 카메라와 조작을 통째로 가져가는
  **모드**라, Escape 는 C 와 똑같이 모드를 취소한다 (일시정지 메뉴가 그 위에 쌓이지 않는다).
- **Tab 은 모든 화면 · 모드의 공용 닫기 키다** (2026-09-09). 자기를 연 키(E · M …)로도 여전히 닫히지만 Tab 도 닫는다 —
  Tab 을 먹는 화면은 `ctx.input.consume(Keys.INVENTORY)` 로 인벤토리가 같은 키에 열리지 않게 한다. 열린 화면은
  `ui:keyGuide {owner, keys}` 를 내보내 **우측 하단 한 줄 키 가이드**(`ui/hud/KeyGuide`)에 자기 키를 올리고, 닫을 때
  `keys:null` 을 보낸다. `Tab 닫기` 항목은 가이드가 스스로 맨 오른쪽에 붙이므로 `keys` 에 넣지 않는다. ESC 메뉴는 예외(가이드 없음).
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
  **임플란트는 예외로 몸에 남는다** (프로필 소유, 함선에서만 탈착). `PLAYER_RESPAWN_DELAY` ·
  `game:respawn` · `game:respawnAvailable` 은 계약이라 **지우지 않았을 뿐** 아무도 발행하지 않는다.
- **구조선 횟수는 호스트가 들고 있다** (2026-09-09). 분대 공용 `RESCUE_DROPS_PER_RAID`(5)회이고 아무나
  `rescue req` 를 보내면 호스트가 `grant` 하면서 1 차감한다 — **호출 확정 시점**이고 취소해도 환불은 없다.
  착륙 지점은 호스트가 `world.scatterPoints` 로 뽑아 포드끼리 겹치지 않게 정한다. 소진 뒤의 사망자는
  탈출/전멸까지 관전이다.
- **강하 포드는 이제 남에게도 보인다** (2026-09-09). 미션 시작 강하와 구조선 강하 모두 `pod drop` 을 보내고
  `player/RemotePods` 가 원격 헬포드를 떨어뜨린다. 그 전까지 아군은 그냥 자리에 나타났다.
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
- **데스크톱 앱의 세이브는 창 포트에 묶여 있다** (2026-09-09). localStorage 는 오리진 단위이고 앱의
  오리진은 `http://127.0.0.1:<창 포트>` 다. 그래서 `electron/main.ts` 의 창 서버는 **임의 포트를 절대
  쓰지 않는다** — `APP_PORT`(8790)부터 정해진 순서로만 훑고, 릴레이 포트와는 완전히 분리돼 있다.
  포트를 바꾸는 것은 캐릭터를 통째로 새로 시작하는 것과 같다.
- **인게임 스크롤바는 어두운 UI 색을 쓴다** (2026-09-09). `:root` 의 `--sb-track` · `--sb-thumb` ·
  `--sb-thumb-hover` 가 단일 원본이고 `#ui-root` 아래 모든 스크롤러에 한 규칙으로 걸린다
  (`src/ui/styles/base.css`). `src/inventory/inventory.css` 는 그 스타일시트를 import 하지 않으므로 같은 이름을
  fallback 과 함께 참조한다 — **값은 base.css 에서만 고친다**.

## 5. 품질 기준

브라우저 안에서의 AAA 감각: 읽히는 실루엣, 강한 조명(태양 + 반구광 + 포그 + emissive 글로우), 부드러운 애니메이션(절차 보행 · 트윈 UI),
화면 흔들림, 타격 피드백, 파티클 FX(instanced/points), 적 ~60마리에서 60 fps 목표. 타입체크 클린.

## 6. 검증 (자세히는 [docs/VERIFICATION.md](docs/VERIFICATION.md))

- **매 편집 후**: `npm run typecheck` (수 초). `data/*.csv` 를 만졌으면 `npm run data:check` 도 (수 초).
- **기능 하나 끝낸 뒤**: `npm run verify` — 건드린 폴더에 매핑된 스모크만 GPU 4레인 병렬, vite/릴레이는 러너가 띄운다.
- **머지 전, 또는 `src/shared` · `src/core` · `main.ts` 를 건드렸으면**: `npm run verify:all` (+ build + `e2e:mp`).
  스모크를 손으로 하나씩 돌리지 않는다 — 그게 1시간짜리 검증이었다.
- 디버그 훅: `window.__game.ctx`, `window.__game.getSystem('player'|'weapons'|'net'|'enemies'|…)`.
- **끝나면 문서**: 건드린 폴더의 `README.md`(구조 + `변경 이력`), 이 파일의 폴더 지도 행(한 줄),
  [docs/HISTORY.md](docs/HISTORY.md) 의 작업 기록, 러너가 뱉은 `docs line:` 을 [docs/VERIFICATION.md](docs/VERIFICATION.md) 에.
