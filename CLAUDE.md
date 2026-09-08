# SCAVANGER — Project Command Center

Helldivers 2-inspired third-person extraction shooter in the browser. Three.js + Vite + TypeScript.
Arc Raiders-style minimalist UI, Diablo 2-style grid inventory, procedural maps, 120 s extraction countdown.
게임은 걸어 다닐 수 있는 **개인 함선**(허브)에서 시작하고, 매치메이킹으로 **공유 함선**에 도킹해 분대가 발사 포드를 타고 임무로 나간다.
릴레이 서버는 토큰별 **프로필 저장소**(크레딧 · 메타 · 창고 · 로드아웃 · 진행도 · 함선)와 **레이드 세션 저장소**를 함께 들고 있어
중간에 끊긴 플레이어가 레이드로 복귀할 수 있다. 서버 없이 하는 싱글 플레이는 localStorage 로 그대로 동작한다.

> **이 파일은 내비게이션 허브다.** 상세 설명은 전부 아래 링크 대상에 있다.
> 새 작업을 시작하기 전에 ① 이 파일의 폴더 지도에서 담당 폴더를 찾고 ② **그 폴더의 `README.md` 를 먼저 읽는다.**

---

## 1. 문서 지도

| 찾는 것 | 볼 곳 |
|---|---|
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
| [`src/shared/`](src/shared/README.md) | — | `GameContext`, `EventBus`, `Input`, `Random` | **계약. 제일 먼저 읽는다.** 타입 · 이벤트 · 상수 · 키바인드 · 각 시스템의 `*Ref` 인터페이스 |
| [`src/core/`](src/core/README.md) | `Engine` | scene / camera / renderer | 렌더러 · 조명 · 하늘 · 포그 · 포스트프로세스 · 메인 루프 · 리사이즈 · 시스템 레지스트리 |
| [`src/main.ts`](src/main.ts) | — | — | Engine 부트스트랩 + 시스템 등록 순서, 커서 모드 ↔ 버스 브리지, 포인터 락 재요청의 **유일한** 지점 |

### 3.2 플레이어 · 전투

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/player/`](src/player/README.md) | `PlayerSystem` | `ctx.player` | 3인칭 컨트롤러 · 카메라 리그 · 절차 생성 병사 모델 · 체력/전투불능(**1인 분대는 즉사**)/스태미나 · 자세 · 상호작용 · 실내 충돌 · 원격 아바타(**같은 함선끼리만 보인다**) · 호스트 고스트 |
| [`src/weapons/`](src/weapons/README.md) | `WeaponSystem` | — | 무기 3슬롯 · 실효 스탯 · 내구도 · 탄약 v2 · 히트스캔/발사체 · 빠른 사용 휠 · 수류탄 · 근접 · 유니크 무기 · 원격 재생 |
| [`src/implants/`](src/implants/README.md) | `ImplantSystem` | `ctx.implants` | 전술 임플란트 6종 (갈고리 · 대시 · 배리어 방패 · 오버차지 · 정찰 스캔 · 대전차포), Q 키 구동, 배리어 충돌/흡수/실드 배쉬 |
| [`src/gadgets/`](src/gadgets/README.md) | `GadgetSystem` | `ctx.gadgets` | 소모품 가젯 10종 (은폐 · 돔 실드 · 바리케이드 · 수류탄류 · 지뢰 · 포탑 · 제세동기 · 점프대), 호스트 권한 배치물 |
| [`src/stratagems/`](src/stratagems/README.md) | `StratagemSystem` | `ctx.stratagems` | 함선 호출 (궤도 폭격 · 항공 폭탄 · 보급품 · 구조물), G 휠 · 상단 시점 조준 · 공유 쿨다운 |

### 3.3 월드 · 적

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/world/`](src/world/README.md) | `WorldSystem` | `ctx.world` | 절차 지형 · 바이옴 · 소품/장애물(총알은 `shotRadius`/`shotHeight`, 이동은 콜라이더) · 상자 · 탈출 패드 · 채집 노드(약초 · **고철 더미**) · 시뮬레이션 훈련장 · 충돌/레이캐스트 질의 |
| [`src/enemies/`](src/enemies/README.md) | `EnemySystem` | `ctx.enemies` | 버그 5종 + 휴머노이드 로그 AI · 포병 · 베헤모스 · 팩션 · 시체 루팅 · 상태이상 · 총알 추적 · 호스트/리플리카 동기화 |
| [`src/extraction/`](src/extraction/README.md) | `ExtractionSystem` | — | 탈출 콘솔 · 120초 카운트다운 · 함선 착륙/탑승/이륙, 호스트 권한 |

### 3.4 아이템 · 인벤토리 · 메타

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/items/`](src/items/README.md) | (데이터) | `ctx.loot` | 무기 6계열 × 등급 I–V · 탄약 · 부착물 · 가방 · 방어구 · 회복 소모품 · 씨앗 · 서적 · 임플란트 아이템 · 루팅 테이블 · 레시피(제작 · **고물 분해**) |
| [`src/inventory/`](src/inventory/README.md) | `InventorySystem` | `ctx.inventory` | 디아블로2식 격자 모델 · 가방/장비/**임플란트 칸**/퀵슬롯 · 함선 창고 · 컨테이너 감정 · 소켓 · 제작(**1초 홀드 · 제작 중에는 제작만 보인다**)/분해/**수리 팝업** · 출격 준비 점검 · Tab 화면(인벤토리/캐릭터/기업/함선) |
| [`src/pickups/`](src/pickups/README.md) | `PickupSystem` | `ctx.pickups` | 월드에 떨어진 아이템 (투척 궤적 · 절차 메시 · 빛기둥 · 호스트 권한 동기화) |
| [`src/meta/`](src/meta/README.md) | `MetaSystem` | `ctx.meta` | 기업 4곳 · 신뢰도(모자란 거래/계약 탭은 잠김) · 크레딧 · 상점/거래대 · 계약 · 퀘스트 · 임플란트 수리 데스크 |
| [`src/progression/`](src/progression/README.md) | `ProgressionSystem` | `ctx.progression` | 레벨/XP · 능력치 5종 · 숙련도 14종 · 파생 수치(`derived`) · 임플란트 장착칸 규칙 · 캐릭터 시트(능력치 · 숙련도만 — 임플란트 UI 는 인벤토리) |
| [`src/housing/`](src/housing/README.md) | `HousingSystem` | `ctx.housing` | 함선 꾸미기 규칙 · 방 용도/시설 레벨 · 가구 · 재배 · 서재 · 로드아웃 프리셋 · `ShipState` 영속화 |

### 3.5 셸 · 흐름 · 표현

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/hub/`](src/hub/README.md) | `HubSystem` | `ctx.hub` | 개인/공유 함선 내부 · **격납고(개인 함선 4대 정박 · 방문)** · 도킹 & 워프 컷씬 · 발사 포드(출격 준비 경고) · 전체화면 터미널 · 행성 선택 · 작업대 · 시설 관리 모드 |
| [`src/game/`](src/game/README.md) | `GameFlowSystem` | `ctx.phase` | 페이즈 상태 기계 · 사망/부활 · 레이드 실패 · **일시정지(ESC = 항상 열기, `escapePause`)** · 재접속 UX · 레이드 세션 저장/복귀 · 재개 게이트 |
| [`src/ui/`](src/ui/README.md) | `HudSystem` | — | 모든 DOM UI — HUD 2계층 · 메뉴(설정 3분할, **ESC = 경고 팝업 뒤의 파티 떠나기 · 타이틀로 · 게임 종료**) · 지도 · 채팅 · 소셜(커뮤니티 패널 단일, **고정 크기**) · 아이템 툴팁 · 커서 아트 · 스타일시트 |
| [`src/audio/`](src/audio/README.md) | `AudioSystem` | `ctx.audio` | 절차 WebAudio SFX 전량 + 앰비언트, 버스 이벤트에 반응, 볼륨 영속화 |
| [`src/tutorial/`](src/tutorial/README.md) | `TutorialSystem` | `ctx.tutorial` | 새 캐릭터 안내 17단계 — 목표 패널 · UI 스포트라이트(**합집합 포커싱**) · 바닥 안내선, 순서 강제 게이트(`blockReason`) + **잠긴 항목 숨김**(`hides`) |
| [`src/console/`](src/console/README.md) | `ConsoleSystem` | `ctx.console` | 개발자 콘솔 + 치트 (**dev 호스트에서만** 존재 — 그 외에는 DOM 도 키도 없다) |

### 3.6 네트워크 · 배포

| 폴더 | 시스템 | `ctx` 게시 | 한 줄 책임 |
|---|---|---|---|
| [`src/net/`](src/net/README.md) | `NetSystem` | `ctx.net` | 릴레이 WebSocket 클라이언트 · 세션 토큰 · 로비 · 20 Hz 스냅샷 · 프로필 동기화 · 소셜 · 크루 카드 · **함선 배치(`ship state`)** |
| [`server/`](server/README.md) | (Node) | — | `ws` 릴레이 — 로비 · 5분 재접속 유예 · 호스트 이관 · 프로필/레이드/소셜 저장소 · `selftest.ts` |
| [`electron/`](electron/README.md) | (Electron main) | — | 데스크톱 스탠드얼론 셸 — 같은 프로세스에 릴레이 + `dist/` 를 로컬 http 로 서빙, `src/`·`server/` 무변경 |

---

## 4. 스택 & 규약

- Three.js 0.185, TypeScript strict, ES modules, 경로 별칭 `@/` → `src/`.
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
- **Escape 는 일시정지 메뉴를 열기만 한다** (2026-09-08). 화면은 각자 자기를 연 키로 닫고(Tab · M · P · E),
  메뉴는 그 위에 쌓인다 — 닫는 것은 `게임으로 돌아가기` 클릭뿐이다. 가장 안쪽 팝업만 Escape 를 먼저 먹는다.
  그 예외에 **하우징 모드**(`hub/HousingMode`)가 들어간다 — 화면이 아니라 카메라와 조작을 통째로 가져가는
  **모드**라, Escape 는 C 와 똑같이 모드를 취소한다 (일시정지 메뉴가 그 위에 쌓이지 않는다).
- **일시정지 메뉴는 커서를 찾아간다** (2026-09-08). 페이지는 OS 커서를 옮길 수 없으므로 메뉴가 움직인다 —
  `ui/menus/PauseMenu` 가 `게임으로 돌아가기` 버튼 안(중앙보다 살짝 오른쪽)에 화면 한가운데가 오도록 자리를 잡는다.

## 5. 품질 기준

브라우저 안에서의 AAA 감각: 읽히는 실루엣, 강한 조명(태양 + 반구광 + 포그 + emissive 글로우), 부드러운 애니메이션(절차 보행 · 트윈 UI),
화면 흔들림, 타격 피드백, 파티클 FX(instanced/points), 적 ~60마리에서 60 fps 목표. 타입체크 클린.

## 6. 검증 (자세히는 [docs/VERIFICATION.md](docs/VERIFICATION.md))

- **매 편집 후**: `npm run typecheck` (수 초).
- **기능 하나 끝낸 뒤**: `npm run verify` — 건드린 폴더에 매핑된 스모크만 GPU 4레인 병렬, vite/릴레이는 러너가 띄운다.
- **머지 전, 또는 `src/shared` · `src/core` · `main.ts` 를 건드렸으면**: `npm run verify:all` (+ build + `e2e:mp`).
  스모크를 손으로 하나씩 돌리지 않는다 — 그게 1시간짜리 검증이었다.
- 디버그 훅: `window.__game.ctx`, `window.__game.getSystem('player'|'weapons'|'net'|'enemies'|…)`.
- **끝나면 문서**: 건드린 폴더의 `README.md`(구조 + `변경 이력`), 이 파일의 폴더 지도 행(한 줄),
  [docs/HISTORY.md](docs/HISTORY.md) 의 작업 기록, 러너가 뱉은 `docs line:` 을 [docs/VERIFICATION.md](docs/VERIFICATION.md) 에.
