# SCAVANGER — 개발 이력

[CLAUDE.md](../CLAUDE.md) 에서 분리한 프로젝트 전체 이력이다. **날짜별 작업 기록**과 **미해결 항목**만 여기 있고,
폴더 하나에만 해당하는 변경은 그 폴더 README 의 `변경 이력` 섹션에 있다.

| 찾는 것 | 볼 곳 |
|---|---|
| 지금 코드가 어떤 구조인가 | [CLAUDE.md](../CLAUDE.md) → 폴더 README |
| 이 폴더가 왜 이렇게 됐나 | 그 폴더의 `README.md` → `변경 이력` |
| 언제 무엇을 했나 | 아래 [작업 기록](#작업-기록) |
| 아직 안 된 것 / 알려진 한계 | 아래 [미해결 항목](#미해결-항목) |
| 앞으로 할 것 | [ROADMAP.md](ROADMAP.md) |
| Phase 별 기획서 | [PHASE5-PLAN.md](PHASE5-PLAN.md) … [PHASE12-PLAN.md](PHASE12-PLAN.md) |
| 검증 결과 기록 | [VERIFICATION.md](VERIFICATION.md) |

---

## 작업 기록

최신순. 새 항목은 이 섹션 맨 위에 추가한다.
- 2026-09-08 (문서 재구성 + 거대 파일 분할 — 동작 무변경): `CLAUDE.md` 가 684줄까지 불어나 매 세션 컨텍스트를
  잡아먹고 있었다. 원인은 두 가지였다 — 폴더맵 표의 각 행이 그 폴더의 **Phase 이력을 전부** 이어 붙인 문단이었고
  (`src/inventory` 한 행이 8,494자), 파일 끝의 `마지막 업데이트` · `Known follow-ups` 가 530줄이었다. 그래서
  **CLAUDE.md 를 내비게이션 허브로** 바꿨다(157줄): 폴더당 한 줄 + README 링크만 남기고, 날짜별 이력과 미해결
  항목은 새 **`docs/HISTORY.md`**, 시스템 등록 순서 · 미션 플로우 · blocker/커서 규약은 **`docs/ARCHITECTURE.md`**,
  멀티플레이 계약은 **`docs/MULTIPLAYER.md`**, 키 레이아웃은 **`docs/CONTROLS.md`** 로 갈랐다(스모크 30종 목록은
  이미 `scripts/README.md` 가 갖고 있어 그쪽을 가리킨다). **폴더별 Phase 이력은 버리지 않고** 각 폴더 README 하단의
  `변경 이력` 절로 옮겨, 폴더를 열면 그 폴더의 맥락이 거기 다 있게 했다.
  이어서 사용자 요청대로 **거대 파일 13개를 실제로 갈랐다** — 시스템 클래스 12개 + `ui/InventoryUI`,
  합계 **18,836 → 7,970줄**(−58 %). 방식은 폴더마다 동일하다: `model.ts` 가 폴더 공용 어휘(타입 · 상수 ·
  스크래치 객체)를 갖고 시스템 파일이 `export *` 로 재수출하며, `parts/*.ts` 가 메서드 묶음을 인스턴스를 첫 인자
  `sys` 로 받는 자유 함수로 갖고 클래스에는 **한 줄 위임 메서드**가 남는다. 그래서 `ctx.*` 호출부도 폴더 안의
  `this.foo()` 도 **한 줄도 바뀌지 않았다**. 순환 import 를 피하려고 `parts/` 는 시스템 파일에서 타입만 가져온다
  (값은 전부 `model.ts`). 가장 큰 감소는 `InventorySystem` 2876 → 1379, `EnemySystem` 1885 → 824,
  `WeaponSystem` 1864 → 726, `PlayerSystem` 1828 → 951, `NetSystem` 1146 → 413, `GadgetSystem` 1046 → 260.
  분할은 손으로 하지 않고 코드모드로 했고(메서드 경계 파싱 → 본문 이동 → 위임자 생성 → `private` 완화 → import
  재작성), 그 과정에서 코드모드가 다섯 번 틀렸다: 파라미터의 `{}` 를 본문 시작으로 오인, `(): { a; b }` 의 `;` 를
  선언 끝으로 오인, `async` 유실, `Extract<T, U>` 의 쉼표를 인자 구분자로 오인(`=>` 때문에 꺾쇠를 안 세다가 생긴
  역회귀 — 지금은 `=` 뒤의 `>` 만 예외로 둔다), 그리고 `this` → `sys` 치환이 **주석 안까지** 바꾼 것(10곳을
  되돌렸다). 마지막 것은 문자열 리터럴도 검사해 안전을 확인했다.
  검증: `verify:all` **전부 통과** (31 스모크 · e2e 156/156 · net-selftest 278/278 · build). 도중에 red 로 나온
  2건은 둘 다 분할과 무관한 **기존 플레이크**였다 — `smoke-ship-rooms` 는 병렬 부하에서만 나오고 단독 71/71,
  `smoke-enemy-delta` 는 HEAD 에서도 12번에 1번 실패했다. 후자는 원인을 잡아 고쳤다: 그 검사는 적을 1 mm 밀고
  "1 cm 미만이니 `p` 는 안 나간다"를 확인하는데, 위치는 `round(v, 2)` 로 양자화되므로 스폰 x 가 센티미터의
  상위 10 %에 떨어지면 1 mm 도 경계를 넘는다(350.4249 → 350.42, +0.001 → 350.43). 넛지 전에 x 를 센티미터 격자에
  스냅해(반올림값은 그대로라 캐시 비교에 영향이 없다) 12/12 로 만들었다.
- 2026-09-08 (Phase 12 — 임플란트 아이템 · 배리어 rework · 정찰 rework · 총알 추적 · UX 정리, `docs/PHASE12-PLAN.md`):
  계약을 먼저 커밋(`e215d36`)하고 8개 병렬 폴더 에이전트(implants / enemies / items+progression / meta /
  weapons+player / ui+housing / inventory / game+electron)가 그 위에서 작업했다. **배리어**는 3.2 m 폭이 되고
  버그가 통과하지 못하는 벽이 되었으며(부딪힌 버그는 6초간 방패를 든 사람을 노린다), 정면 근접공격은 플레이어
  대신 방패가 받고, 방패를 든 채 좌클릭 · 근접키를 누르면 **실드 배쉬**(스태미나 25, 방패 폭만큼의 정면 근접,
  개머리판 보너스 없음, 넉백)가 나간다. **정찰**은 홀드 채널에서 **한 번 누르는 광역 스캔**이 되어 이동 중에도
  쓸 수 있고, 15초 동안 상호작용물 · 적을 자신과 분대에게 인디케이터 · 나침반 · **벽 뒤 적색 실루엣**으로 보여준다
  (`imp scanCast` 로 각 피어가 자기 월드에서 드러낸다). **감지 스탯**은 이제 나침반에 실제로 드러나 반경 안의 적이
  빨간 눈금 + 화면 인디케이터로 뜬다. **새 임플란트 시스템**: 능력치를 올리는 장착 아이템 46종(5능력치 × I–IV +
  전설 퍽 3종, 각각 망가진 쌍둥이)이 생겼고, 캐릭터마다 장착칸이 **기본 4 + 5레벨마다 +1 (상한 10)** 이며 임플란트마다
  차지하는 칸이 다르다(할로우 나이트 부적). 레이드에서는 **망가진 것만** 나오고(로그 시체 6 % · 보스 45 %, 티어 2–4
  상자), **세레스 바이오**가 판매 · 수리(재료 + 수수료 조합)와 희귀 이상 보상 퀘스트 사슬을 맡는다. 전설 퍽 3종
  (재기동 회로 = 전투불능 시 레이드당 1회 자동 기상 · 가속 대사 = 회복 사용 시간 절반 · 아드레날린 펌프 = 처치 시
  스태미나 전량)은 실제로 동작한다. **AI 총알 추적**: 감지 범위 밖에서 총알이 날아오면 로그 · 버그가 발사 지점을
  향해 돌아서서 3초간 그 방향 감지를 2배로 넓히고, 못 찾으면 그쪽으로 전진한다(로그는 엄폐 이동, 버그는 직진).
  **저격 쏠림**의 원인은 무기가 `update` 에서 쏘고 카메라 리그가 `lateUpdate` 에서 움직여 **직전 프레임 카메라
  위치 + 이번 프레임 시선**으로 사격선이 평행 이동해 있던 것이었다(60 px 플릭에서 0.42 m — 거리와 무관한 일정한
  빗나감). `CameraRig.predictPosition()` 으로 조준 원점을 이번 프레임 위치로 예측해 30 m · 139 m 에서 0.000 m.
  **UX**: 일시정지 메뉴가 항상 단 하나의 화면이 되어(다른 창이 열리면 즉시 양보, z-index 85) 아이템 창과 겹쳐
  둘 다 못 끄던 상태가 사라졌고, 브라우저에서 커서 화면을 Escape 로 닫아 재잠금이 거부되면 **좌측 클릭으로 게임
  재개** 게이트가 뜬다(Tab 으로 닫으면 안 뜬다). 데스크톱 셸은 그 게이트가 없고 커서가 필요 없을 때 커서를 숨긴다
  (Alt 예외). `start-game.bat` 을 지우고 실행은 `SCAVANGER.exe` 로 통일했다. 분해에 실시간 가로 게이지가 붙고,
  채집 티커는 아이템 획득 티커 하나로 줄었으며, 회복 스프레이는 틱마다 티커를 띄우지 않고 하나를 유지하고 게이지
  200 에 **0 이 되어도 사라지지 않으며** 함선에서 수리한다. 컷씬 중에는 시설관리 · 커뮤니티 버튼이 숨고, 시설관리는
  빈 방에 용도를 줄 때 재료 썸네일이 붙은 확인 팝업을 띄운다 — 사용자가 본 "재료가 충분한데 증축이 안 됨"의 정체는
  새 함선의 **발전기 Lv.0 게이트가 비활성 버튼의 tooltip 으로만** 표시된 것이었고(포인터 락 아래에서는 보이지
  않는다), 이제 발전기 행이 목록 맨 위에 뜨고 차단 사유가 인라인으로 적히며 기본 지급품이 첫 시설 체인을 전부
  덮도록 폐금속을 24 로 올렸다. 검증: `verify:all` **전부 통과** (31 스모크 · e2e 156/156 · net-selftest 278/278 ·
  build, 9분 8초). 첫 실행의 red 2건은 통합 단계에서 잡았다 — smoke-housing 은 지급량을 올린 리드 변경과 ui
  에이전트가 쓴 옛 기대치의 불일치였고, smoke-tactical 은 **재개 게이트**가 락을 한 번도 잡지 못한 세션(스텁이
  `pointerLockElement` 를 늦게 세운다)에서도 떠서 조작을 막은 것이었다. 후자는 스크립트만의 문제가 아니라 포인터
  락을 거부하는 브라우저에서 나갈 수 없는 오버레이가 되므로, 게이트를 **락을 한 번이라도 잡은 세션**으로 좁혔다.
- 2026-09-07 (스모크 flake 2건 제거 — smoke-tactical · smoke-rogue-v2): 둘 다 게임 버그가 아니라 스크립트가
  월드의 우연에 기대고 있었다. **smoke-tactical**: 던지기 가젯 루프가 화염수류탄을 **제일 먼저** 던지는데 그
  화염지대는 설계대로 피아 구분이 없고 서 있는 플레이어 바로 앞에 깔린다 — 지금 스타터 장비로는 루프 중간에
  플레이어가 전투불능이 되고, 전투불능은 `deny(null)` 로 **조용히** 거부되므로 그 뒤 `use()` 가 전부 false 였다
  (네 번째인 `domeShield` 만 실패로 보였다). 루프 전에 체력을 채우고 화염수류탄을 마지막으로 옮겼다.
  **smoke-rogue-v2** 의 수류탄 구간은 두 가지가 겹쳐 있었다 — (1) 로그가 마지막 목격 지점을 향해 걸어가
  `GRENADE_MIN_DIST`(6 m) 안으로 들어오거나 사거리를 벗어나면 30초 안에 아무것도 던지지 않았고(그러면 그 뒤
  6개 검사가 연쇄로 죽는다), (2) 던지기 자체가 ±1 m 산포 + 한 번 튕김 + 구름이라 폭발 지점이 복불복이다
  (바위 위에 얹히면 수평으로는 2.6 m 라도 가슴까지 3D 거리가 반경 밖이다 — 실패 샘플에서 9.1 m 도 나왔다).
  이제 (1) 와인드업 전까지 로그를 제자리에 고정하고, 던질 자리를 **평평하고 시야가 트인 곳**으로 고르며,
  (2) 최대 3번까지 던져 **실제로 가슴에 닿은 첫 폭발**로 피해를 검증한다(빗나간 시도는 실패 메시지에 남는다).
  검증: 고친 뒤 smoke-rogue-v2 단독 8연속 52/52(한 번은 재시도 경로를 실제로 탔다), `verify:all` 전부 통과.
- 2026-09-07 (좌클릭으로 카메라 복귀): 사용자 보고 2건 — **"메뉴가 아무것도 안 떠 있는데 커서만 활성화되어 있는",
  그리고 "메뉴를 닫아도 커서가 즉시 사라지지 않고 조금 이따가 사라지는"**(M → Esc 함선 관리, Tab → Esc 인벤토리)
  상태. 둘 다 커서 rework 의 구조적 대가다 — 창 모드 Chrome 은 Escape 에 사용자 활성화를 주지 않으므로 화면을
  Esc 로 닫는 순간의 재잠금 요청은 거부되고, 락은 플레이어의 **다음 진짜 입력**(대개 첫 WASD 탭)에서야 돌아온다
  (전체화면이면 `navigator.keyboard.lock(['Escape'])` 가 애초에 락을 깨지 않지만, 이 게임은 아무도
  `requestFullscreen()` 을 부르지 않아 브라우저 F11 · Electron F11 모두 그 경로를 타지 않는다). 그래서 사용자가
  요청한 대로 **좌클릭을 명시적인 복귀 수단**으로 만들었다: `Input.takeLockOnClick` 이 락이 없고 카메라가 락을
  원하는 동안 **캔버스** 위의 좌클릭을 보면 즉시 락을 다시 요청하고 **그 누름을 삼킨다**(예전에도 `PlayerSystem`
  의 폴백과 제스처 재시도가 락을 되찾긴 했지만, 그 클릭이 그대로 발사로도 기록됐다). 그리고 **Alt 커서**는 뒤에
  창이 없는 유일한 커서 소유자이므로 **캔버스 좌클릭으로도 닫히게** 했다(HUD 요소를 누른 클릭은 그대로 그
  요소의 것). 검증: `verify:all` — 새 검사 4개(smoke-controls-hub 99). red 2건은 모두 이 변경과 무관하다:
  smoke-rogue-v2 는 예전부터 알려진 수류탄 타이밍 flake, smoke-tactical 의 `domeShield` 는 **깨끗한 트리에서도**
  같은 실패가 재현되는 이 브랜치의 기존 red 였다 — 뒤이어 원인을 잡았다: 던지기 가젯 루프가 **화염수류탄을
  제일 먼저** 던지는데 그 화염지대는 설계상 피아 구분이 없고 서 있는 플레이어 바로 앞에 깔린다. 지금 스타터
  장비로는 그 화상이 루프 중간에 플레이어를 전투불능으로 만들고, 전투불능은 `deny(null)` 로 **조용히** 거부되므로
  이후 `use()` 가 전부 false 였다(가젯 자체는 멀쩡하다). 스모크가 루프 전에 체력을 채우고 화염수류탄을 **마지막**
  으로 던지게 고쳤다 — smoke-tactical 64/64.
- 2026-09-07 (기본 지급품 지급 조건 · 기본 작업실 폐지): 사용자 보고 2건. **"타이틀에서 이름을 새로 설정해
  캐릭터를 새로 만들었는데 창고가 비어 있다"** — 원인은 두 가지가 겹쳐 있었다. (1) 타이틀의 콜사인은 **표시
  이름**(`scav.playerName`)일 뿐 캐릭터를 새로 만들지 않는다. (2) 기본 지급품은 `Stash.firstRun`, 즉 `scav.stash`
  **파일이 한 번도 없었을 때**만 지급됐다 — 지급 기능이 생기기 전부터 있던 프로필, 그리고 지급 직후 서버의 빈
  `stash` 문서가 로컬을 덮어쓴 프로필은 영원히 조건에서 빠진다. 그래서 지급 조건을 **프로필당 한 번**으로 바꿨다:
  새 localStorage 플래그 `scav.grant`(`none` / `pending` / `done`, 스태시 파일 **밖**에 둬서 서버 문서가 지급을
  매 세션 반복시키지 못하게 한다)를 두고, `tryStarterGrant()` 가 init 에서 한 번, 그리고 서버 문서를 적용한
  **`net:profileLoaded` 직후** 한 번 더 확인한다(그 시점에는 서버 창고가 비었다는 것이 확실하므로 정식 저장으로
  올라간다). 지급하면 `pending`, 이미 뭔가 가진 프로필은 지급 없이 `done` 이므로 추가 지급은 최대 한 번이다. 그리고 사용자의
  의도대로 **타이틀에 `새 캐릭터로 시작`** 버튼을 넣었다 — 확인 카드를 거쳐 `scav.` 접두 키를 전부 지우고(키 설정 ·
  오디오 · 콘솔 기록은 캐릭터가 아니므로 유지) **세션 토큰까지 버려** 릴레이가 새 PeerId · 새 서버 프로필을 발급하게
  한 뒤 페이지를 리로드한다(리로드가 모든 시스템이 저장소를 다시 읽게 하는 유일한 방법이다). **기본 작업실 폐지**:
  Phase 8 UI pass 가 방 1에 무료 작업실 + 총기 작업대 + 정비 벤치를 박아 놓았던 것을 걷어내, 새 함선은 **빈 방 10개 ·
  가구 0** 으로 시작한다. 사용자 선택에 따라 작업실은 방 1 전용이 아니라 **아무 방에나** 짓는 보통 용도가 되었다
  (증축 비용 폐금속 8 + 케이블 2, 발전기 Lv.1 게이트, 사격장처럼 함선당 하나, 시설 제거로 환급). `Rules` 의 방 1
  분기와 `ShipState` 의 room-1 invariant, `ShipView` 의 잠금 표시가 사라지고 `sanitize` 에는 "시설 방은 종류당
  하나"만 남았다(기존 세이브의 작업실은 있던 자리에 그대로 남는다). `WORKSHOP_ROOM_INDEX` 는 계약이 append-only
  라 export 만 남기고 deprecated 로 표시했다. 검증: `verify:all` 통과 — 새 검사 9개
  (smoke-loadout 61 · smoke-housing 176), smoke-weapons / smoke-ship-rooms / smoke-controls-hub 의 작업실 전제는
  상태를 직접 심는 방식으로 바꿨다(그 과정에서 스모크가 **서버 프로필이 함선 상태를 덮어쓰기 전에** 상태를
  건드리면 조용히 되돌아간다는 것을 확인해, 시딩을 프로필 로드 뒤로 옮겼다).
- 2026-09-07 (배포용 릴레이 주소 · 서버 켜기): 사용자가 "서버는 내 PC 에서 따로 켜고, 배포한 exe 는 기본으로 그
  주소에 붙게" 를 요청했다. 지금까지 데스크톱 셸은 **항상** 자기 릴레이를 loopback 에 띄웠기 때문에, 두 사람이
  각자 exe 를 실행하면 서로 보이지 않는 별개의 세계에 있었다(`--relay` 를 손으로 넘겨야만 만났다). 그래서
  `electron/main.ts` 에 주소 해석 사다리를 넣었다 — `--relay` > `SCAV_RELAY` > **exe 옆 `relay.txt`** >
  **빌드에 구운 값** > 아무것도 없으면 예전처럼 자체 릴레이. 구운 값의 출처는 `electron/default-relay.txt` 한 줄이고
  (`build.mjs` 가 `transform.define` 으로 `__SCAV_DEFAULT_RELAY__` 에 박는다 — `define` 을 rolldown 최상위에 두면
  경고만 내고 조용히 무시된다), 같은 파일이 electron-builder `extraFiles` 로 exe 옆에 `relay.txt` 로도 복사되어
  받은 사람이 **재빌드 없이** 주소를 고칠 수 있다. 새 `--local` 은 그 전부를 무시하고 혼자 놀게 한다. 이 과정에서
  잠복 버그를 하나 잡았다: 프록시 모드에서도 로컬 http 서버가 `--port` 기본값 8787 을 먼저 잡으려 했는데, 릴레이가
  같은 PC 의 8787 이면 Windows 가 `127.0.0.1:8787` 바인딩을 허용해 버려 `/ws` 가 **자기 자신으로** 프록시됐다
  (연결은 되고 로비만 영원히 비는 형태) — 프록시 모드는 이제 포트를 명시하지 않으면 빈 포트를 쓴다. 서버 쪽은
  `start-server.bat` 에 반영했다: 인자 없이 = 예전대로 `dev:all`, `relay` = `npm run server` 만, 그리고 두 모드
  모두 배너에 새 `scripts/lan-address.mjs` 가 고른 `ws://<IP>:8787/ws` 를 찍는다(가상 어댑터를 이름으로 강등하고
  192.168 > 172.16-31 > 10 순으로 고른다 — `ipconfig` 순서는 아무 의미가 없다). 검증: typecheck 3종 0, 빌드된 앱을
  CDP 로 4경로(구운 기본값 · `relay.txt` 우선 · `--local` · 포트 회피) 확인, **패키징된 win-unpacked 두 벌을 실제
  LAN IP 로 붙여 15/15** (다른 PeerId → 신호 찾기 → 같은 분대 → 행성 전파 → 같은 시드로 발사 → 양방향 스냅샷).
- 2026-09-07 (마우스 커서 시스템 갈아엎기 — 락 = 시점 / 언락 = 진짜 커서): 사용자가 지적한 두 가지, **"커서가 뜨면
  게임이 일시정지된다"** 와 **"인게임 전용 커서와 실제 마우스의 전환이 부자연스럽다"** 는 같은 뿌리였다. Phase 10 은
  멀티모니터에서 커서가 창 밖으로 새는 것을 막으려고 **포인터 락을 절대 놓지 않고** 가상 커서가 DOM 이벤트를 합성하는
  구조를 택했는데, (a) 합성 이벤트는 untrusted 라 기본 동작이 없어 캐럿 · 드래그 · 슬라이더를 손으로 흉내 내야 했고,
  (b) 화살표를 게임이 직접 그리니 OS 커서의 지연을 절대 따라잡을 수 없었으며, (c) Chrome 은 **Escape 마다 락을 놓기**
  때문에 커서 화면이 Esc 로 닫히면 락이 조용히 사라져 소프트 커서가 실제 커서를 미러링하는 반쪽 상태가 됐다. 그 반쪽
  상태를 감지하려고 넣은 `checkLockLost` 워치독이 "락이 없으면 무조건 ESC 메뉴"였고, 그게 바로 불편의 정체다.
  전제를 뒤집었다. **커서 모드 = 포인터 락 해제**이고, 돌아온 진짜 OS 커서를 `ui/hud/GameCursor` 가 절차 생성한 CSS
  `cursor:` 이미지로 **그 자리에서 다시 칠한다**(캔버스로 그린 화살표 / 포인터 / 잡기 3종 + HiDPI 2×, 데이터 URL).
  어떤 요소가 어떤 모양을 쓰는지는 손으로 나열하지 않고 `mirrorSheetRules()` 가 스타일시트의 `cursor: pointer/grab`
  규칙 40여 개를 런타임에 미러링하므로, 새 패널이 행에 `cursor: pointer` 만 쓰면 게임 커서를 공짜로 얻는다. 화면 쪽
  API(`setCursorMode(active, token)`)는 그대로라 **14개 화면은 한 줄도 안 고쳤다** — 대신 `shared/cursor.ts` 가
  `SoftCursor`(305줄, 이벤트 합성기) → `CursorMode`(63줄, 토큰 ref-count)로 줄고 `hud/SoftCursor.ts` 는 사라졌다.
  **일시정지는 락에서 분리했다**: 워치독과 `pointerlockchange` → pause 를 걷어내고, 이제 **창 포커스를 잃었을 때만**
  (`blur` / `visibilitychange`) 메뉴가 뜬다. 락이 없다는 것은 그냥 "지금 마우스가 커서"라는 뜻이다. **Esc 쿨다운**은
  전체화면에서 `navigator.keyboard.lock(['Escape'])` 로 없앴다 — Escape 가 페이지 키가 되므로 락이 깨지지 않고
  "Esc 로 닫으면 즉시 카메라"가 문자 그대로 성립한다(전체화면 탈출은 Esc 길게 누르기). 창 모드에서는 기존의
  제스처 재시도가 그대로 폴백이다. **일시정지 메뉴도 더는 예외가 아니다** — `MenuBase` 가 같은 `'menu'` 커서 토큰을
  쓰고, 재잠금은 `main.ts` 한 곳이다. 새 **Alt 커서**(화면 없이 마우스만 푼다, 자체 blocker + `ui:freeCursorToggled`,
  Escape 로도 닫힘)를 위해 **구르기를 V 로 옮기고 이전 무기 스왑(V)을 폐기**했다(사용자 결정) — `Keys.SWAP` 은
  키 테이블에서 **삭제된 첫 액션**이다. 검증: `verify:all` 통과, 새 검사 (smoke-controls-hub 95 · smoke-ui-p5 133 ·
  smoke-weapons 103).
- 2026-09-07 (총기 이름 정리 · 회복 소모품 개편 · 기본 지급품): 사용자 요청 3건. **총기**는 종류당 한 자루만
  남기고 이름을 종류명 + 등급으로 바꿨다 — `ar` 돌격소총 · `smg` 기관단총 · `sg` 산탄총 · `dmr` 지정사수소총 ·
  `sr` 저격소총 · `hg` 권총, 표기는 `고급 저격소총 = 저격소총 II` 규칙 그대로다. 중복이던 LAS-16(두 번째 AR)과
  P-19(두 번째 권총) 계열은 삭제했고, 내부 id 도 함께 정리해 로그 무장 목록 · 루팅 가중치 · 기업 퀘스트 보상 ·
  스모크의 id 참조를 모두 새 이름으로 옮겼다(기존 세이브의 옛 무기는 로드에서 사라진다). **회복 소모품**은
  스팀 2종을 버리고 붕대(5초, 5초간 20) · 약초 붕대(5초, 5초간 50) · 회복주사(2초, 1초간 50) · 회복 스프레이
  (게이지 100, 좌클릭 홀드 시 0.1초마다 게이지 1 → 반경 8 m 자신·아군 1 회복) 4종이 되었고, 재세동기는 2개
  스택 · 1초 홀드다. 홀드 시간이 아이템마다 다르므로 `HEAL_HOLD_S` 상수 하나로 돌던 Phase 10 경로를
  `ItemDef.heal`(`useTime` / `amount` / `overTime` / `spray`)로 일반화하고, 크로스헤어 링은 `heal:holdChanged.dur`
  로 실제 초를 센다. **사용 중에는 이동 속도가 절반**(`CONSUMABLE_SLOW_MUL`, `setSpeedModifier`)이고, 회복은
  즉시가 아니라 아이템이 정한 시간에 걸쳐 들어온다(새 `PlayerRef.applyHeal`). 스프레이의 게이지는 인스턴스의
  `durability` 라 창고에 넣었다 빼도 남은 양이 유지되고 기존 내구도 바가 그대로 쓰인다. 재료로 천조각 · 캔 ·
  주사기 · 소독약(캔 + 혈근초, 제작 전용)을 추가하고 의약 레시피 6종을 새로 넣었다. **기본 지급품**은 새
  `STARTER_STASH` 로 첫 실행에 **함선 창고**에 들어간다(탄약 4종 10세트씩 · 총기 5종 · 여분 가방 3 · 방탄복 3 ·
  작업실/작업대 재료 · 재세동기 2세트 · 수류탄 3세트). 그래서 **레이드마다 자동 지급되던 스타터 킷이 사라지고**
  (`world:ready` 는 장비 · 가방 · 창고가 전부 빈 경우에만 최소 킷을 준다), 레이드 실패 · 중단은 들고 간 장비를
  잃고 창고에서 다시 챙기는 흐름이 되었다(`loseKit()`). 이 과정에서 서버의 빈 loadout 문서가 플레이어가 입고 있는
  장비를 지우던 잠복 버그도 고쳤다. 탄약 스택은 한 세트 크기(경 80 · 준중 50 · 중 25 · 산탄 25), 수류탄은 한 칸에
  3개다. 검증: `verify:all` 통과 (29 스모크 · e2e 156/156 · net-selftest 278/278 · build).
- 2026-09-07 (커서 편의성 3건): **ESC 로 일시정지를 풀면 다시 일시정지되던 문제** — 원인은 두 가지가 겹쳐 있었다.
  (1) Chrome 은 **Escape 에 사용자 활성화를 주지 않고**(전체화면 · 포인터 락 탈출용으로 예약된 키) 사용자가 Esc 로
  락을 나온 직후의 재요청도 잠시 거부하는데, 메뉴를 닫는 가장 흔한 방법이 바로 Escape 라 재잠금이 항상 거부됐고,
  0.5 초 뒤 lost-lock 워치독이 메뉴를 다시 띄웠다(마우스로 `계속` 을 눌러야만 빠져나오는 루프). (2) `relock()` 이
  `uiBlockers.size > 0` 이면 재잠금을 아예 건너뛰어, 인벤토리 · 터미널 위에 뜬 메뉴에서는 시도조차 없었다. 이제
  `Input.requestPointerLock()` 이 **거부된 요청의 의도를 보관**해 다음 진짜 제스처(클릭, 또는 Escape 가 아닌 아무 키
  — 실제로는 첫 WASD 입력)에서 재시도하고, `awaitingLockGesture` 동안 워치독은 대기하며, `relock()` 은 일시정지
  메뉴(`menu`)만 예외로 본다. **인게임 커서 가속** — 같은 날 넣었던 자체 가속 곡선(`SOFT_CURSOR_ACCEL` / `_MAX`)을
  걷어내고 `moveBy` 를 **완전 선형**(1 px : 1 px)으로 되돌렸다. 측정해 보니 14 px 짜리 손동작이 27 px 를 갔고,
  그래서 "가속이 붙고 실제 마우스 위치와 다르다"는 감각이 생겼다(Windows 기본값도 1:1 이다). **드래그 중 커서와
  아이템이 따로 노는 문제** — `.inv-ghost` 가 1.04 확대를 개별 `scale:` 속성으로 갖고 있었는데, CSS 개별 변환은
  translate → rotate → scale → `transform` 순으로 적용되므로 **JS 가 쓴 translate 가 1.04 배로 곱해졌다**: 커서가
  오른쪽/아래로 갈수록 그림이 벌어져(x = 1080 에서 42 px) 드래그 중에는 아이템이 커서를 안 따라오다가 놓는 순간
  커서 아래 칸으로 들어가는 것처럼 보였다. 확대를 `positionGhost` 의 `transform` 안으로 옮겨 고쳤다(브라우저에서
  고스트 중심 = 커서 좌표로 확인). 검증: `verify:all` 통과, 새 검사 5개(smoke-quickslots 46, smoke-controls-hub 85).
- 2026-09-07 (데스크톱 스탠드얼론 — Electron): 새 `electron/` 폴더로 브라우저 없이 실행되는 앱을 만들었다. 핵심 결정은 **게임과 릴레이를 고치지 않는 것** — Electron 메인이 `startRelayServer()` 를 같은 프로세스에서 띄우고 그 릴레이의 http 서버 위에 `dist/` 를 얹은 뒤 창을 `http://127.0.0.1:<port>/` 로 보내므로, 렌더러의 same-origin `ws://.../ws` 가 vite 프록시 때와 똑같이 임베디드 릴레이로 떨어진다(`file://` 로드였다면 `location.host` 가 비어 `VITE_WS_URL` 주입이나 preload 가 필요했다). 따라서 프로필 · 레이드 세션 · 소셜 저장소가 오프라인에서도 그대로 살아 있고, 저장 위치만 `%APPDATA%/SCAVANGER/relay-data` 로 옮겨간다. `server/` 는 erasable TS 라 Electron 메인에서 그대로 못 도는 대신 **rolldown**(vite 가 이미 갖고 있다)으로 `dist-electron/main.js` 에 번들한다 — 새 런타임 의존성 0. 창은 메뉴 없이 F11 전체화면 · 크기/위치 기억 · DevTools off 이고, `--lan` 과 `--relay=<ws url>`(raw `/ws` 프록시)로 다른 PC 와도 붙을 수 있다. 배포는 electron-builder **portable 단독** (`npm run app:dist` → `release/SCAVANGER-0.1.0-portable.exe`, 96 MB). 브라우저 흐름(`npm run dev`, 스모크, e2e)은 무변경. 검증: typecheck(client/server/app) 0, `net:selftest` 278/278, 개발 실행과 패키징된 exe 양쪽을 CDP 로 확인 — 실제 GPU (ANGLE D3D11) 렌더, 타이틀 → `함선 탑승` → phase `hub`, 릴레이 `/health` `clients: 1`, 콘솔/페이지 에러 0.
- 2026-09-07 (안정화 pass — 드래그 · UI 고정 · 포인터 락 · 커서 반응성 · 접속 끊김 · 인게임 HUD):
  **인벤토리 드래그**: 드롭 격자를 **엄격 판정 우선**으로 뽑는다 — 포인터가 실제로 들어 있는 격자가 반 칸
  허용치 안에만 걸친 격자를 항상 이긴다(세로로 붙어 있는 가방 / 함선 창고가 서로의 가장자리 줄을 훔치던 원인).
  **장비 칸에서 뺀 무기**를 이미 찬 칸에 놓으면 칸으로 되돌아가며 흔들리던 것을, 가장 가까운 빈 자리
  (`nearestFreeSpot`)로 하이라이트째 재조준해 실제로 들어가게 했다(격자 → 격자는 여전히 "가리킨 칸이 그 칸"인
  디아블로 규칙). 저장은 원래부터 칸 좌표를 그대로 보관한다. **UI 크기 고정**: 힌트 바와 버리기 존이 고정 높이
  `.inv-footer` 를 공유해 드래그 시작에 창이 튀지 않고(함선에서는 0으로 접힌다), `.inv-search-status` 가 고정 폭이라
  감정 완료 시 컨테이너 패널 폭이 41 px 줄며 창 전체가 옆으로 밀리던 것도 사라졌다. **포인터 락**: 새 워치독이
  락이 0.5 초 넘게 없으면 **블로커와 무관하게** ESC 화면을 띄운다 — 커서 화면은 Phase 10 부터 락을 유지하지만
  Chrome 이 Esc 마다 락을 놓고 가끔 돌려주지 않으며, 그때 소프트 커서가 조용히 실제 커서를 미러링해 "게임은
  멀쩡해 보이는데 윈도우 커서가 다른 모니터로 새는" 상태가 됐다. 락을 한 번도 못 잡은 세션(헤드리스 · 거부한
  브라우저)에서는 뜨지 않는다. 같은 맥락으로 **일시정지가 더는 월드를 멈추지 않는다**(싱글 레이드 포함,
  `freeze` 는 항상 false). **인게임 커서 반응성**: 원인은 두 가지였고 둘 다 히트 판정이 아니었다 —
  (1) 락을 `unadjustedMovement:true` 로 잡아 OS 의 포인터 속도 · 정밀도 향상 가속이 **전혀** 없다 → `moveBy` 가
  자체 가속 곡선을 갖는다(느린 이동은 1:1, 빠른 플릭은 최대 2.4배), (2) 스프라이트를 **게임 프레임마다** 그려서
  마우스와 화살표 사이에 3D 렌더 파이프라인이 통째로 끼어 있었다 → `SoftCursor.onMove` 로 입력 이벤트에 바로 그린다.
  **기본 임플란트**는 갈고리. **하우징**: 커서가 방 밖을 가리키면 하늘색 셀 표시 · 고스트 · 설치/회수가 모두 꺼진다.
  **함선**: 복도 징두리 트림이 방 문을 가로지르던 허리 높이 노란 선을 문마다 끊었다. **레이드 접속 끊김**:
  솔로는 새 `game/SoloRaid.ts` 가 5초마다(+`pagehide`) 진행 상황을 localStorage 에 저장해 **5분 안에** 다시 열면
  그대로 이어서 진행하고, 지나면 레이드 실패로 장비를 잃는다. 멀티는 릴레이가 진행 중인 레이드 안에 있던 멤버의
  슬롯을 **레이드가 끝날 때까지** 유지하고(다른 사람이 아직 안에 있는 한, 훈련장 제외), 호스트가 몸을 보관하는
  기간도 2분 → 레이드 전체로 늘렸으며, 재접속하면 공유 함선에 세워 두지 않고 **바로 임무로 재투입**한다.
  **인게임 HUD**: 좌하단 회복약 · 수류탄 알약 제거(체력 + 스태미나만), 우상단 처치수 제거 + 임무 시간을 좌상단
  `임무 목표` 라벨 옆으로, 우측 하단은 임플란트 → **빠른 사용 1칸(2배 크기, 마지막 선택 슬롯)** → 무기 슬롯 →
  탄약 + **무기 썸네일 상자**(인벤토리와 같은 아이콘 + 명칭, 고정 크기) 순. 검증: `verify:all` **전부 통과**
  (29 스모크 · e2e 156/156 · net-selftest 278/278 · build, 4분 59초).
- 2026-09-07 (UI/UX 개선 pass III — 마우스 드래그 · 캐릭터 창 · 제작 화면 · 기업 화면): **드래그**는 아이템이
  커서 **중앙**에 붙고(잡은 지점이 아니라 발자국의 절반을 grab offset 으로 쓴다), 드래그 중에 잠깐 윈도우 시스템
  커서가 나타나던 문제를 고쳤다 — `.inv-root.is-dragging *` 의 `cursor: grabbing !important` 가 소프트 커서의
  `cursor: none !important` 보다 명시도가 높았다(이제 `body:not(.soft-cursor-on)` 로 한정). **캐릭터 창**은
  **능력치 | 숙련도 | 전술 임플란트** 3열이 되고, 임플란트는 카드 6장을 늘어놓는 대신 **장착 칸 하나**를 보여준 뒤
  누르면 **모달리스 팝업**에서 고른다(팝업은 `ctx.uiRoot` 직계 자식 — 임베드 탭의 `scale:` 이 fixed 의 컨테이닝
  블록이 된다). 이 과정에서 **standalone 캐릭터 시트가 임플란트를 하나도 못 보여주던 잠복 버그**를 찾아 고쳤다
  (`ProgressionSystem` 이 `ImplantSystem` 보다 먼저 등록되어 생성자에서 `ctx.implants` 가 아직 없다 → lazy build).
  **제작**은 Phase 8 의 모달리스 팝업을 걷고 다시 **창의 열**이 되어, 좌측에 제작 목록(함선 창고 자리) · 우측에
  가방(위) + 함선 창고(아래)를 놓고, 레이드에서는 창고가 없으므로 `제작 · 장비 · 가방 + 퀵슬롯`이 된다.
  **기업 화면**은 전용 오버레이(`ui/CorpMenu.ts`)와 `'corp'` blocker 를 버리고 **Tab 창의 기업 탭 하나**로 통합됐다
  (함선 컴퓨터 `E` → `ctx.inventory.openScreen('corp')`). 구성은 좌측 세로 **기업 목록 rail**, 우측 메인 패널
  (좌열 = 기업 패널 + 세로 거래/계약/퀘스트, 우측 끝 = 가방/창고가 패널 높이를 전부 사용)이고, 거래는 전부
  **아이템 그리드**가 되어 구매/판매 트레이가 위아래로 쌓인 **가로 5칸**(아이템 최대 폭)이며 기업 재고 · 가방 ·
  함선 창고가 그 칸 크기(40 px)를 함께 쓴다. `귀중품 전부 담기`는 판매 트레이 하단으로 내려갔고, 거래 불가한
  재고도 그리드 형태를 유지한 채 가운데에 `신뢰도 Lv.1 부터 거래 가능` 을 띄운다. 검증: `verify:all` 통과
  (29 스모크 · e2e 156/156 · net-selftest 276/276, 5분 6초; 유일한 red 는 예전부터 알려진 smoke-rogue-v2 의
  로그 수류탄 타이밍 flake — 깨끗한 트리에서도 재현되고 단독 재실행 2회 52/52).
- 2026-09-07 (Phase 11 — 행성 선택 · 소셜, `docs/PHASE11-PLAN.md`): 임무는 여전히 **무작위 시드**로 절차 생성하되
  플레이어가 **목표 행성**을 고른다. 새 `src/shared/planets.ts` 의 5행성(아켈론 II · 보레아스 IX · 베르단트 III ·
  피로스 VII · 카민 I)이 지형 팔레트 · 하늘 팔레트 · **포그 유무** · 생태계(적 종류 가중치 · 압박 · 로그 밀도 ·
  채집물 비율)를 **명시적으로** 짝지어, 시드에서 하늘과 지형을 따로 뽑고 "두 목록 다 5개니까 맞겠지"에 기대던 옛
  방식을 대체한다. **터미널이 전체화면**이 되어 중앙에 3D 홀로그램 행성(자체 WebGL 캔버스)과 좌우 이동 · 행성 이동
  버튼을 놓고, 기존 매치메이킹은 좌측, 훈련장과 닫기(Esc)는 우측으로 갔으며 **승무원 이름 입력은 사라졌다**
  (호출명은 타이틀 화면 전용). 행성을 정하면 도킹 컷씬을 재활용한 **워프 이동**이 재생되고(내부는 재생성하지 않는다),
  공유 함선에서는 **호스트만** 지정하며 나머지는 `lobby:state` 로 같은 컷씬을 본다. **목표 행성이 없으면 발사 슬롯에
  탑승할 수 없다.** — **소셜**: 릴레이가 세션 토큰의 PeerId 에서 8자 **아이디**(`AB3D-9KMN`)를 발급하고
  `ProfileRecord.social` 에 친구 · 요청 · 최근 만난 플레이어를 보관한다(서버가 읽는 유일한 문서). **ESC 는 버튼이
  좌측으로 가고 함선에서만 우측에 소셜 열**이 붙어 분대원(아이디 · 레벨 + 보이스 슬라이더 — **UI 뿐**) · 친구 ·
  최근 플레이어를 2열 카드로 보여주며, 우클릭으로 같이 하기 / 귓속말하기 / 친구 추가 · 삭제(확인 팝업)를 한다.
  **같이 하기**는 상대가 함선에 있으면 그 분대로 합류(도킹 컷씬), 상대가 분대가 없으면 초대가 간다. 함선 우상단에
  **커뮤니티 썸네일**(접속 친구 수 · 요청 레드닷)이 상시 뜨고 그 아래로 **분대 초대 패널**이 쌓여 **P 를 3초 홀드**하면
  참여한다. **귓속말**은 채팅창에 `→ 이름` 칩으로 붙고 로비 밖에서도 오간다. 설정은 좌측 중앙 패널이 되어 오디오와
  키 설정(타이틀과 같은 키보드 · 마우스 다이어그램)을 담는다. 5개 병렬 폴더 에이전트(server / net / hub / ui /
  world+enemies)가 커밋된 계약 `e13f785` 을 상대로 작업했고, core · game · 검증 러너 · 문서는 리드가 맡았다.
  검증: `verify:all` 전부 통과 (29 스모크 · e2e 156/156 · net-selftest 276/276, 5분 0초).
- 2026-09-07 (캐릭터 모델 롤백): Phase 10 의 스플래툰식 3등신 평상복 캐릭터가 반려되어 `src/player/SoldierModel.ts`
  와 `src/player/GearLook.ts` 를 Phase 10 직전 커밋(`666ab86`)의 **헬다이버즈2식 장갑 보병**으로 되돌렸다 —
  헬멧 · 바이저 · 볏 · 어깨 패드 · 등짐 + 캐니스터 · 흉부 강판 · 노란 스트라이프 · 4단 망토, 히프 0.98 m, 긴 팔
  (0.3 + 0.3), `ROLL_PIVOT_Y` 0.55, 그리고 그 몸에 맞는 방어구 플레이트 · 손에 든 아이템 크기. Phase 10 에서 **추가**
  된 것만 옛 비율에 맞춰 이식해 유지한다: `SoldierPose.carry`, `shoulderSocket`(어깨 패드 아래 torso-local
  `(0.12, 0.36, 0.02)`, `+PI/2` yaw), 두 소켓의 렌더 순서 · `resetPose` 처리, 들쳐메기 팔/상체/무릎 블렌드(짧은 팔용
  각도에서 ~0.2 rad 낮춰 재조정). `RemoteAvatar` 의 네임플레이트 앵커도 1.7 / 1.3 / 0.5 · `DOWN_MARKER_Y` 0.95 로
  복귀. 모델 비율에 의존하는 코드는 `src/player/` 밖에 없었으므로(히트박스 · 아이 높이 · `PLAYER_HEIGHT` 는 Phase 10
  에서도 무변경) 변경은 이 세 파일 + `scripts/smoke-ghost.mjs` 의 망토 단언에 한정된다. 롤백이 드러낸 잠복 버그
  하나를 같이 고쳤다: `weapons/fx/WeaponFx.warmUp` 의 `renderer.compileAsync` 는 **살아 있는 씬**에서 모은 머티리얼
  집합을 10 ms 마다 `program.isReady()` 로 폴링하는데, 그 사이 머티리얼이 dispose 되면(원격 아바타 이탈, 기어 룩
  재생성) three 내부 `setTimeout` 안에서 `Cannot read properties of undefined (reading 'isReady')` 가 터진다 —
  우리 `.catch` 가 닿지 않는 자리다. 프라미스를 기다린 적이 없으므로 `renderer.compile()` 로 바꿨다(링크 발행은
  동일하고 드라이버가 백그라운드로 마저 컴파일한다). 검증: `verify:all` 전부 통과.
- 2026-09-07 (Phase 10 UI 개선, `docs/PHASE10-PLAN.md`): 사용자가 요청한 13개 UI/게임플레이 개선을 9개 병렬 폴더
  에이전트로 구현했다. **인게임 마우스 커서**: 커서를 쓰는 화면이 더는 포인터 락을 풀지 않고, 새 `shared/cursor.ts`
  가 가상 좌표에서 **실제 버블링 pointer/mouse 이벤트를 합성**해 `elementFromPoint` 대상에 디스패치한다 — 그래서
  26개 UI 표면의 핸들러를 **하나도 고치지 않았다**. 커서가 다른 모니터로 새지 않고, 락이 없을 때(Esc·헤드리스)는
  합성 없이 실제 커서를 미러링한다. Esc 일시정지 메뉴만 예외. **PC 캐릭터**를 스플래툰식 3등신 평상복으로 전면
  교체했으나 **2026-09-07 롤백**했다(아래 항목 참조 — 모델은 다시 헬다이버즈2식 장갑 보병). **배리어**는 설치형
  패널에서 **손에 드는 방패**가 되어(`mode:'wielded'`) 들면 총이 홀스터되고 정면 각도 안의 적 발사체만 막으며
  카메라를 따라다닌다. **적 사망**: 공중에서 죽으면 이제 **떨어진다**(죽은 몸 전용 중력을 호스트·리플리카 양쪽에
  넣고 착지 후 시체를 등록 — 기존에는 공중에 얼어붙고 3D 거리 판정 때문에 루팅도 불가능했다), 좌/우/뒤 **세 방향**
  으로 쓰러지며(버그·로그 공통, 시드 기반이라 클라이언트 간 일치), 시체 루팅은 **티어별 확률**(잡버그 10 % · 상위
  35 % · 보스/로그 100 %)이 되었다. **루팅 표시**는 하늘색 프레넬 구체를 없애고 위로 갈수록 투명해지는 **빛기둥**
  으로 바꿨다(구체는 `pickups` 가 아니라 `ui/hud/Detection` · `ScanReveal` 에 있었다). **컨테이너**는 같은 가방을
  보는 다른 대원이 아이템을 가져가면 타일이 **위로 스르륵 사라진다**(`cont taken` 은 이미 전원 브로드캐스트였으므로
  연출 + `live` 구분만 추가). **재장전 게이지**를 우측 하단에서 **크로스헤어**로 옮기고(새 `weapon:reloadCancelled`
  로 취소도 닫힌다), **지도에서 휠클릭 핑**을 놓을 수 있게 했다. **발사 준비 패널**: 슬롯이 차면 4칸 가로 패널에
  각 대원의 캐릭터를 우측 사선으로 세워 보여주고(준비 안 된 칸은 비움), 이름 + 레벨 + 장착 임플란트를 표시하며
  **우클릭으로 그 대원의 장비 / 가방 / 빠른 사용**을 모달리스로 연다(함선 창고·크레딧 제외) — 허브에서는 스냅샷의
  `imp` / `w` 가 null 이라 새 `crew` 와이어가 필요했다. **아이템 툴팁**은 하단에 크레딧 바를 얻고, 게임 전체의
  크레딧 표기가 `₩ 100` / `100 cr` 에서 **`100 C`** 로 통일되었다(`formatCredits` 하나). **들쳐메기**: 전투불능
  아군 근처에서 **F 짧은 탭**으로 오른 어깨에 메고(비무장, 달리기만 가능, 다른 행동은 먼저 내려놓는다) E 홀드 구조는
  그대로 유지했다. **스팀 → 회복약**: H 키를 폐기하고 빠른 사용에서 **좌클릭 2초 홀드**로 사용한다(아이템 id 는 유지).
  **하우징**: 6~10번 방 카메라가 돌아가서 1~5번과 구분이 안 되던 문제를 고쳤다(문이 항상 화면 위). 리드가 추가로
  잡은 것: 스모크가 위조하는 포인터 락에서 합성 이벤트가 **이중 입력**이 되던 문제(`Input.cursorOwnsInput`), 합성
  이벤트에는 기본 동작이 없어 텍스트 입력과 슬라이더가 죽던 문제, Esc 후 락 재요청의 단일 지점화, 포드 탑승 중
  Tab 회귀. 검증: `verify:all` 전부 통과 (26 스모크 · e2e 124/124 · net-selftest 194/194, 4분 40초).
- 2026-09-07 (Phase 9 UI/UX 개선 pass II — 인게임 HUD · 가방 · 시설 · 기업): **인게임 HUD** 를 다시 배치했다 —
  우측 하단 무게 표시를 없애고(무게는 인벤토리 전용), 채팅 + **분대 체력바를 좌측 하단**(내 체력바 바로 위)으로
  모으고, **좌측 상단은 계약 전용**이 되어 내 계약 아래에 **분대원 계약 진행바**가 붙는다(새 `meta contract`
  브로드캐스트 + `MetaRef.getSquadContracts()`). 우측 하단은 위에서부터 **전술 임플란트 썸네일 → 빠른 사용 아이템
  썸네일 → 무기 슬롯 → 무기 정보** 순이고, 무기 정보에서 `주무기` · 탄약 종류 표기를 뺐으며, 중앙 하단 스태미나는
  불투명 흰색이 되었다. **가방**: 인게임 창이 함선 레이아웃에서 창고만 뺀 형태가 되고(장비 좌 · 가방 우 · 퀵슬롯
  오른쪽), **전술 임플란트는 캐릭터 탭의 카드**로 옮겨졌다(인벤토리의 슬롯 · 모달리스 picker 삭제). **함선**:
  빈 방에 용도를 주는 **시설 증축이 재료를 소모**하고(발전기 Lv.1 게이트, 제거 시 전액 환급), 시설 관리(M)의 용도
  목록은 설명 대신 **요구 재료 칩**을 보여주며, 가구 패널에 **가구 제작 / 가구 창고 탭**이 생겼다(제작 버튼이 실제로
  `craftFurniture` 를 호출하는 유일한 UI, 창고 탭은 이 방에 놓을 수 있는 가구를 위로). **함선 관리 탭**은 부제를
  없애고 패널 대신 방 목록만 스크롤하며, 빈 방마다 **시설 증축** 버튼 → 중앙 팝업(재료 부족 시 비활성). **기업**:
  제목 · 부제를 없애고 기업 목록을 좌측 상단으로 올렸으며, 패널을 1760 px 로 넓히고 재고 · 구매/판매 칸을 아이템
  그리드(호버 툴팁 포함)로 바꾸고 가방 / 함선 창고 열이 전체 높이를 쓴다. **버그**: 훈련장에 있는 동안 재접속하면
  `분대가 임무 중`이라고 뜨던 문제 수정(훈련장은 개별 입장이라 분대 임무가 아니다).
- 2026-09-07 (Phase 9 UI/UX 개선 pass): **기업 화면**을 타르코프식 거래대로 재작성했다 — 좌측 상단 기업 패널(이름 + 신뢰도, 모토 · 설명 제거), 상점과 판매를 하나의 **거래** 탭으로 통합(좌 기업 재고 · 중앙 구매/판매 거래칸 + 크레딧 차액 + **거래 성사** 일괄 정산 · 우 **실제 가방 · 함선 창고 격자**), 계약은 목록 + 진행 중 계약, 퀘스트는 목록 + 납품 테이블 + 격자. 격자는 inventory 가 소유하는 새 `ui/TradeGrids.ts`(`InventoryRef.createTradeGrids`, 읽기 + 끌어내기 전용)다. **함선 관리 탭**에서 도감 · 용도 드롭다운 · 방 번호 · 가구 수 · 시설 설명문을 걷어내고, 행은 썸네일 + 용도 + 레벨 + 업그레이드 + 빨간 **시설 제거**(확인 카드 → 가구는 가구 창고로, 업그레이드 재료는 **함선 창고**로 전액 환급)로 바뀌었으며 시설 관리(M) 버튼은 별도 하단 바로 내려갔다. **시설 관리 모드**는 하단에 설치 키 힌트만, 우하단에 종료(Esc) 칩을 두고, 다른 방을 고르면 카메라가 **스르륵** 이동하며, 용도 지정 목록은 제작 가능 → 제작 불가 → 이미 제작 순으로 정렬되고 모든 시설 표시가 같은 아이콘(`ROOM_PURPOSE_GLYPH` / `FACILITY_GLYPH`)을 쓴다. **조종석**은 별도 터미널을 없애고 중앙 대시보드 모니터를 터미널로 삼았으며(항법 · 통신 제거), 기업 네트워크 PC 를 발사 슬롯에서 떨어진 후방 좌측 벽(사물함 자리)으로 옮겨 침대 겹침과 프롬프트 충돌을 함께 해결했다. 문틀이 벽 안에 박혀 있던 문제와 문 앞을 가로지르던 허리 높이 징두리 벽도 제거했다.
- 2026-09-07 (Phase 9, `docs/PHASE9-PLAN.md` — Known follow-ups II): **프로필 동기화**가 문서별 타임스탬프로 최신 우선이 되고(`profile:set {at, fresh}` + 서버 `docsAt`, 시계 오차 clamp), `ProfileSync` 가 오프라인 편집을 큐에 보관해 폴더별 자체 큐가 사라졌다. **고스트·호스트**: 스냅샷 `dhp` 로 실제 다운 체력을 물려받고, 임무를 떠난 멤버(페이지 새로고침)의 몸은 `NET_GHOST_PARK_S` 동안 **주차**되며, 레이드 중 호스트는 임무 안에 있는 멤버에게만 넘어간다(아무도 없으면 보류). **늦은 합류**: 진행 중인 함선 호출(`strat sync`), 서 있는 배리어, 분대의 계약 진척(`meta sync`, 검증 포함)이 재합류 클라이언트에 전달되고 픽업·가젯·채집·컨테이너가 호스트 이관에 재동기화된다. **적 스냅샷은 델타**(`seq` · 키프레임 `NET_ENEMY_KEYFRAME_S` · `gone` · 변경 필드만). **서재 책장** 신규 콘텐츠(스킬당 책 1권 14종, 배율 상한, 도감, `ShipState` v3)와 **훈련장 표적 모드**(고정 · 이동 · 타임 코스, 모드 콘솔 · 무기 거치대)를 추가했다. 소규모 정리: 화상 킬이 불을 놓은 사람에게(`applyStatus(..., attacker)`, `enemy:killed.by`), 점프대 플레이어별 재발동, 포기 홀드 HUD 바, `raycastBarrier` 순수 질의 + `damageBarrier`. 9개 병렬 폴더 에이전트가 커밋된 계약 `5ac7031` 을 상대로 작업했다.
- 2026-09-06 (Phase 8 UI/UX 개선 pass): **아이템 툴팁 어디서나** — `src/shared/itemChip.ts` stamps `data-def-id` on every
  재료 요구 칩 and the new `ui/hud/ItemTip` (a direct child of `#ui-root`) turns a hover on any of them into the
  inventory-style item card (시설 업그레이드 · 가구 제작 · 필드/작업대 제작 · 수리 · 퀘스트 · 씨앗 alike). **인벤토리**: the
  전술 임플란트 popup is a centred fixed-size panel with its own scrollbar and the `장착 중` label moved under the
  description; dimmed 제작 rows are dimmed by colour (an `opacity` row let the blurred world bleed through); the Tab
  캐릭터 / 기업 / 함선 screens sit on their own opaque panel. **함선**: the 방 메뉴 (door console `E`) and the 함선 시설
  메뉴 (cockpit console `E`) are gone — consoles, geometry and all — and both entry points redirect to 시설 관리;
  Tab > **함선 관리** is now 기본 시설 (발전기 · 창고) on the left and the 방 목록 on the right (per-room 작업실 / 사격장
  level + upgrade), with a sticky **시설 관리 (M)** button bottom-right that closes the window and enters the mode; the
  corner hint reads **시설 관리** now. **방 1 is permanently the 작업실** (`WORKSHOP_ROOM_INDEX`): a new ship starts with
  the 총기 작업대 + 정비 벤치 already placed in it, older saves migrate and any furniture that no longer fits its room
  goes back to furniture storage. 로드아웃 프리셋 are reached only through the **관물대** (renamed 사격장 콘솔) in a 사격장.
  **하우징(시설 관리) 모드**: the 가구 목록 moved from a bottom bar to a vertical right-hand panel and becomes a
  **용도 지정 picker** while an empty room is selected; Esc / C now always release the `shipmanage` blocker (the bug
  where the camera came back but the player had no controls and no corner hint) and C with an empty cursor leaves the
  mode like Esc.
- 2026-09-06 (Phase 8 UI/UX pass, `docs/PHASE8-PLAN.md`): 캐릭터 / 기업 / 함선 are now **tabs inside the Tab screen** (blurred inventory backdrop, `EmbeddedView` from `progression.createSheetView` / `meta.createCorpView` / `housing.createShipView`) instead of separate popups; the 기업 screen has a **fixed** frame (content scrolls, no per-tab resize) and the 캐릭터 sheet lost its permanent scrollbars; 전술 임플란트 · 필드 제작 · **아이템 분해** (right-click, expected-result dialog) are modeless popups over the window; every material requirement everywhere renders as a **thumbnail + 보유/필요 chip** (`src/shared/itemChip.ts`, dimmed + red when short); the credits pill reads `CREDITS 500`. Ship: the terminal moved to the **cockpit centre** and lost its 캐릭터 button and its 승무원 이름 field (one-time name, `ShipState.nameLocked` + `HousingRef.lockCrewName`), **Esc opens the 일시정지 메뉴** (게임으로 돌아가기 / 설정 = 키 설정 + 오디오 전체·효과음 / 타이틀로), **M opens 함선 관리** (unlocked cursor, 방 목록 left, horizontally scrolling 가구 카드 바 bottom, C or Esc cancels), doorways are **자동문**, and rooms with a purpose are **lit** while empty rooms stay dark (constant `ROOM_LIGHT_POOL` lights, intensity ramped). The 정비 벤치 became **작업실 furniture** (granted free to every profile) and 약초 재배 moved to the **온실 재배층** — a stackable 4-층 rack with `GROW_PLOTS_PER_RACK` plots, planted from new `seed_*` items (raid loot + corp shop) that ripen in **1–6 real hours** off `ctx.net.serverNow()`. 8 parallel folder agents against contract `9b04073`; `Input.consume()` added afterwards to stop Escape double-firing across systems.

- 2026-09-06 (Phase 7, `docs/PHASE7-PLAN.md` — Known follow-ups resolved): `server/` profile + raid session store (credits as a server transaction, host migration mid-mission, training starts, `inMission`); `net/` `ProfileSync`, suspended / ghost / host-change plumbing, pose bits; `player/` host ghosts + `restoreState` + remote poses / held items / armor; `game/` + `extraction/` squad wipe = 레이드 실패, raid save / rejoin restore, training flow; `world/` + `hub/` 시뮬레이션 훈련장 (arena, targets, sim hub, terminal entry); `enemies/` rogue AI v2 (LOS cover + flank, reload, grenades), behemoth 3 + remote knockback, live authority; `inventory/` Tarkov-style container search (감정), host-authoritative takes, `canFit`, raid state, profile docs; `meta/` + `progression/` + `housing/` labels from shared, server credits, `outcome`, profile docs; `weapons/` + `implants/` remoteState, attachments, replica grenade damage, overcharge beam; `ui/` result-screen level-up, 레이드 실패 screen, suspended / badge UI; `audio/` roll double-SFX + auto level-up chime removed. 9 parallel folder agents against the committed contract `64031f7`. Skill books dropped (서재 bookshelf collection instead, see `docs/ROADMAP.md`); furniture stays a non-item.
- 2026-09-06 (Phase 6 audit): `docs/PHASE6-PLAN.md` checked bullet by bullet against the code by 5 explore agents — every item implemented; fixed the deviations: `player` / `weapons` unique RMB no longer enters the ADS state (`setWeaponState.altFire`, appended to the shared signature), `housing` housing mode only inside that room + 작업실 / 사격장 unique per ship (`facilityPurposeOf`), `hub` carried furniture announced to the HUD hint + `FurnitureLayer` rebuilds only for uncovered `housing:changed` reasons, `items` 회로 기판 from tier 2, `smoke-ui-p6` dead skip branch removed, `smoke-housing` +5 checks, `docs/ROADMAP.md` Phase 6 ☑.
- 2026-09-06 (Phase 5 remainder, `docs/PHASE5-PLAN.md` §8): new `src/meta/` (`ctx.meta`: credits 500, 4 corps `CORP_DEFS`, rep levels, corp shop with rarity cap by rep, one active contract with goal counters + squad share over `meta contractHit` + `settleMission` from GameFlow, quest chains, 기업 네트워크 screen, console `credits / rep / contract / quest`); `inventory` loadout persistence (`scav.loadout`) + stash access + 기업 tab; `hub` ship computer `hub_computer`; `ui` result-screen XP / contract settlement, contract HUD panel, meta toasts, title level chip; `game` fills `stats.rewards`; stat effects wired to every consumer (grenade throw range, quick-use cooldown, every hold interaction — applied once in `PlayerSystem`); `STAT_POINTS_PER_LEVEL` 1, `XP_BASE` 120. 4 parallel folder agents (meta, inventory, hub, ui) against the committed contract `3bc09ac`. Skill books deferred.
- 2026-09-06 (Phase 6, `docs/PHASE6-PLAN.md`): new `src/console/` (dev console + cheats, localhost only) and `src/housing/` (ship rooms / facilities / furniture / presets, localStorage `scav.ship`); `hub` personal ship rebuilt with 10 rooms + housing mode + procedural furniture; `items` six unique legendary weapons + dedicated ammo + bench recipes; `weapons` unique fire modes; `enemies` 전소 / 감전 statuses on the wire; `player` teleport / widen / heavy melee; `inventory` 무한 상자 catalog, stash size, presets, bench crafting; `progression` stat XP; `ui` gauges / markers / housing hints. 8 parallel folder agents + weapons in a second wave against a pre-written contract.
- 2026-09-06 (verification runner): `scripts/verify.mjs` (`npm run verify` / `verify:all`: folder-mapped smoke selection, 4 GPU lanes, own vite / relay, fresh relay before e2e, `--rerun-failed`, `scripts/logs/`), smoke scripts on the real GPU (`GL_ARGS`, 142 s → 18 s per script) with `requestPointerLock` stubbed (cursor trap fix) and 60 s `waitFor`, test history moved to `docs/VERIFICATION.md`, new `scripts/README.md`.
- 2026-09-06 (controls / hub screen / implants): `src/shared` `Keys` mutable + `Keybinds.ts` + mouse codes in `Input`; `src/ui` `menus/ControlsPanel` + `menus/KeybindMenu` (title footer + pause menu), `hud/ImplantWidget` crosshair-left gauge, live key labels; `src/implants` grapple instant / scan + overcharge hold (energy) / barrier 10 s lockout / launcher-only wield; `src/weapons` weapon keys stow a wielded implant; `src/inventory` `Stash.ts` + hub Tab ship screen (창고 / 장비 + 임플란트 슬롯 / 가방, right-click 수리, screen tabs); `src/progression` character sheet tabs; `src/hub` terminal without 임플란트 / 정비 tabs (`ImplantPanel` / `RepairPanel` deleted), implant bay → Tab screen, no scrollbars. New smoke `scripts/smoke-controls-hub.mjs`.
- 2026-09-06 (merge of `feature/tactical-kit`, branched before Phase 1): new `src/implants/`, `src/gadgets/`, `src/progression/` + shared `implants.ts` / `gadgets.ts` / `progression.ts` / `gear.ts`; armor slot + weight + crafting in `inventory`; melee / roll / cloak / grapple / hover / burning / grit in `player` (dive → roll, `PlayerController` from the branch); melee + blocking + key layout in `weapons`; lures / structures / stealth perception in `enemies`; gather nodes in `world`; ship stations + terminal tabs in `hub`; new HUD widgets in `ui`; mission XP in `game`. Dropped from the branch: `BackpackDef` catalogue (→ `BagDef`), quick bar (→ Phase 2 wheel), branch downed / bleedout (→ Phase 2), `DownedOverlay`, crate search-reveal (감정 timing), jump / special bag perks (tactical bag = hover + implant cooldown). `docs/TACTICAL_KIT.md` is the original brief — where it disagrees with this file, this file wins.
- 2026-09-06 (Phase 4 of `docs/ROADMAP.md`): `enemies` rogues + boss, artillery/toxic/behemoth, factions, corpses, new wire events; `items` corpse tables + `rollCorpse`; `inventory` `openContainerItems`; `weapons` armour ricochet + shell interception; `player.applyKnockback`. 2 agents (enemies; items+inventory) + lead-owned weapons/player.
- 2026-09-06 (Phase 3 of `docs/ROADMAP.md`): new `src/stratagems/` (ship-call wheel, shared cooldown, top-view / ground targeting, orbital laser, airstrike, supply crate, destructible cover structures, `strat` net sync), `world.addObstacle` + `Obstacle.destructible`, weapons yield to an armed call and damage destructible cover, `ctx.weapons.getGrenades()`, items loot tier 5, `ui` stratagem wheel/panel/charge/targeting HUD + off-screen indicators + `ping:placedV2` now emitted. 2 folder agents + lead-owned world/weapons/items/main wiring.
- 2026-09-06 (Phase 2 of `docs/ROADMAP.md`): downed/revive/respawn (`player`, `net` revive relay + DOWNED/HOLDING_ITEM flags, `game` respawn flow, `enemies` ignore downed targets, `extraction` liftoff gate), quick-use wheel (`inventory` quick slots + compass panel, `weapons` F tap/hold + consumables in hand, `ui` wheel), grenade cooking/underhand (`weapons`, `ui` cook gauge, fuse on the wire). 6 folder-scoped agents (two waves after a session rate limit killed the first attempt) + lead-owned net/game/extraction.
- 2026-09-05 (weapon package, roadmap Phase 0–1 of `docs/ROADMAP.md`): stamina bar bottom-centre / hidden when full, ADS camera shoulder+lift; `items` grades I–V + ammo v2 + attachments + bags + `WeaponStats`; `inventory` 4 equip slots, bag-driven grid with overflow drop, sockets, unload/repair, reset policy; `weapons` 3 slots, effective stats, durability, ammo v2, attachment meshes; `ui` durability bar / slot strip / key hints; `hub` workbench repair menu; `pickups` wire extras; `player.setAdsTime`. Built by 5 parallel folder-scoped agents against a pre-written `src/shared` contract (see `src/shared/README.md`, last section). Phases 2–4 followed (entries above). Phase 5 (meta progression in localStorage: stash/loadout, XP/level, corporations/contracts/quests) is fully specified for the next session in `docs/PHASE5-PLAN.md`; planet gimmicks are deferred after it.
- 2026-09-05 (ship hub): `src/hub/` personal/shared ship interiors + docking cutscene + launch pods + terminal menu, `src/pickups/` dropped-item pickups (host-authoritative), reconnection (session token, 5-min grace, seamless resume, rejoin from a pod), quick match, pings v2 (hold+drag 주의/돌격/탄약, visible-only enemy tracking, item pings), `ui/hud/ChatLog` text chat, inventory drop/split/context menu, camera terrain/interior collision + occlusion silhouette, grenade hitch fix, new SFX. `ui/menus/LobbyMenu` removed (the shared ship replaces it). Built by 7 parallel folder-scoped agents against a pre-written `src/shared` contract.
- 2026-09-05 (multiplayer): `server/` ws relay + `src/net/` (lobby code/invite/ready/start, snapshots + interpolation), `player/RemotePlayerSystem`, `weapons/RemoteWeapons`, host-authoritative enemies (`enemies/Targets.ts`, `enemies/net/`), extraction/game flow sync, `ui/menus/LobbyMenu` + Squad/Nameplates/SpectateOverlay, `shared/net.ts` contract. Built by 6 parallel folder-scoped agents (net+server / player / enemies / weapons / extraction+game / ui) against a pre-written `src/shared` contract. Verified: typecheck 0, build ok, net selftest 44/44, 2-client e2e 34/34.
- 2026-09-05: stamina + stances + dive (player), weapon classes/falloff/SR scope (items, weapons), stamina bar/scope overlay/pings/map (ui, new `src/ui/map/`), pointer-lock pause & re-lock (game, inventory), new SFX (audio). Smoke-tested in Chrome by driving `window.__game.frame()` from a timer (hidden tab): C/Z/Alt/M, sprint drain + regen, SR equip → scope overlay + FOV 17.5, ping, bolt fire, lock loss → pause menu. 0 console errors.


---

## 미해결 항목

각 항목은 그 작업을 한 시점의 알려진 한계다. 최신순.

- 2026-09-08 (Phase 12): **임플란트 아이템** — 보너스는 `STAT_MAX` 로 잘리지 않으므로 20 + 임플란트는 시트의 최대치를
  넘는다(의도). 장착분은 프로필에 살고 그리드 밖에 있으므로 `resetProfile` 은 자리가 없으면 그것들을 **잃는다**.
  임플란트 아이템 id 를 바꾸면 기존 세이브의 장착분은 조용히 사라진다. 수리 수수료 `IMPLANT_REPAIR_FEE` 는 계약이
  얼어 있어 `src/meta/Rules.ts` 에 있다 — 다음에 계약을 열 때 `shared/meta.ts` 로 옮길 것. **배리어** — `pushBack`
  은 `EnemyManagerRef` 밖의 `EnemySystem` 메서드라 implants 가 옵셔널 캐스트로 부른다(인터페이스 승격은 한 줄짜리
  계약 변경). 플레이어는 여전히 방패를 통과하고, 조사(investigate) 상태는 **호스트 전용**이라 호스트 이관 시 사라진다.
  실드 배쉬 피해는 리플리카의 `takeDamage` → `hit` 경로에 기대며 멀티에서 재검증하지 않았다. **총알 추적** — 산탄총은
  조준선 하나만 보고하고(펠릿 각각이 아니다), 비행 중인 발사체는 임무가 끝나면 착탄 보고를 보내지 못한다. `shotq` 는
  형태만 검증한다(피해가 없으므로 무해). **정밀 사격** — `predictPosition` 은 같은 프레임에 새로 생기는 카메라 충돌은
  예측하지 못한다(한두 프레임 몇 cm). **재개 게이트** — 자동화에서 진짜 Escape 경로를 재현할 수 없어(헤드리스 · CDP 의
  Escape 는 사용자 활성화를 갖는다) 스모크는 거부된 락 상태를 직접 만든다. 셸의 Escape 재잠금 훅은 **이득이 실측되지
  않았다** — `--raw-escape` 로 되돌릴 수 있다. `body.desktop-nocursor` 는 `GameCursor` 의 런타임 스타일보다 클래스가
  하나 많아서 이기므로, 그 셀렉터의 명시도가 올라가면 셸 커서가 다시 나타난다. **채널 티커** — 음소거가 플래그 하나라
  스프레이 중에 끝난 붕대도 토스트가 없고, `active:false` 를 놓치면 라인이 남는다. **시설 관리** — 발전기 행은
  **빈 방을 고른 picker 안에서만** 보이므로 용도가 이미 있는 방에서는 여전히 Tab 함선 탭으로 가야 한다.
- 2026-09-07 (좌클릭 카메라 복귀): a click is the fix, not a cure — outside fullscreen there is still **no**
  zero-input instant return after Escape, because Chrome grants Escape no user activation. The clean cure is the
  keyboard-lock path that already exists (`Input.syncKeyboardLock`), but nothing in the game ever calls
  `element.requestFullscreen()`, so `document.fullscreenElement` is always null — browser F11 and the Electron
  shell's F11 (a *window* fullscreen) both miss it. A "전체화면" toggle that actually goes document-fullscreen would
  make Escape instant everywhere. The recapture click is swallowed only when it lands on the **canvas**: a click on
  an interactive HUD element still belongs to that element and does not re-lock (the gesture retry then covers it).
  The Alt 커서's click-to-close listens on `window` for the length of the mode and reads `e.target === ctx.canvas`,
  so a click on a HUD element that happens to be transparent to pointer events *does* close it.
- 2026-09-07 (기본 지급품 · 작업실): the retro grant fires when the 창고 is **empty**, so a veteran who spent
  everything and never had the flag written (a browser profile from before this change) gets one free 기본 지급품 —
  once, and only if the 창고 is empty at that moment. The flag is per **browser profile**, not per account: clearing
  site data or moving to another machine re-grants (there, the server's stash document normally arrives first and
  settles it to `done` without a grant). The re-check happens at `net:profileLoaded` only, so a player who never
  connects stays `pending` and is never re-checked — harmless, because init already granted locally. 새 캐릭터로 시작
  wipes **client** saves and the session token; the old server profile is orphaned, not deleted (its documents stay in
  `profiles.json` under the old token, unreachable). It is a two-step confirm with no typing, and it takes the ship,
  progression, meta and 소셜 아이디 (친구 목록 포함) with it. **작업실**: a new ship has no bench, so nothing can be
  crafted at a 작업대 until the player builds the room (폐금속 8 + 케이블 2, 발전기 Lv.1 → 폐금속 4) and crafts a
  bench — the 기본 지급품 covers those materials, but a player who sells them is stuck with field crafting until the
  next raid. Every room starts dark (the room lights only anchor to rooms with a purpose); the cockpit, corridor and
  airlock are lit as before. Existing saves keep whatever they had, including a room-1 작업실 that is now movable.
- 2026-09-07 (배포용 릴레이 주소): 구운 주소는 **IP 문자열**이라 DHCP 로 주소가 바뀌면 배포된 exe 가 전부 헛다리를
  짚는다 — 서버 PC 의 IP 를 고정하거나 받은 사람이 `relay.txt` 를 고쳐야 한다(그래서 그 파일이 있다). 앱은 릴레이가
  꺼져 있어도 **조용히** 오프라인으로 뜬다: 연결 실패를 알리는 UI 가 없고, `ensureConnected` 는 시작할 때 한 번과
  터미널의 `신호 찾기` 에서만 재시도하므로 서버를 나중에 켜면 그 버튼을 눌러야 한다. `relay.txt` 는 **첫 줄만**
  읽고 검증은 `new URL` 이 전부라, 오타는 실행 시점에 조용한 접속 실패로만 드러난다. 찾는 위치가
  `PORTABLE_EXECUTABLE_DIR` → `execPath` 폴더 → `cwd` 라서, 저장소 루트에 `relay.txt` 를 두면 `npm run app` 도
  그것을 읽는다(테스트용으로는 편하지만 잊고 두면 헷갈린다 — git 에는 없다). LAN 주소 탐지는 휴리스틱이라
  어댑터가 여럿인 PC 에서는 `node scripts/lan-address.mjs --all` 로 확인해야 한다. 그리고 이 모든 것은 여전히
  **같은 LAN 안**의 이야기다 — 인터넷 너머는 포트포워딩 · VPN 메시 · VPS 가 필요하고, 이 PC 는 게이트웨이가
  `172.28.35.254` 인 관리형 네트워크라 포트포워딩이 불가능할 가능성이 높다.
- 2026-09-07 (마우스 커서 rework): the cursor **can leave the game window** again while a screen is open — that is the
  price of the real cursor, and it is what Phase 10 existed to prevent. In fullscreen it cannot; in windowed
  multi-monitor play it can, exactly like any other browser game. There is **no sensitivity setting**: the in-game
  cursor is the desktop cursor, at the OS pointer speed. Where the cursor *appears* when a screen opens is the
  browser's call (Chrome restores it to the pre-lock position, which is normally where the player left it in the last
  screen) — a page cannot warp the OS cursor, so `setCursorPosition` only seeds the tracked coordinates for tests.
  Outside fullscreen, closing a screen with **Escape** still cannot re-lock immediately (Chrome grants Escape no user
  activation and blocks a re-lock right after one), so the cursor stays visible until the player's next click or key —
  usually the first WASD tap, and now harmless because nothing pauses. `navigator.keyboard.lock` needs **document**
  fullscreen: the Electron shell's F11 is a *window* fullscreen, so the desktop build does not get the Escape fix
  unless the page itself goes fullscreen. The generated cursor art is built once (plus one retry on `window.load`), so
  a stylesheet added later is not mirrored, and `body.cursor-ui *` is an `!important` blanket — an element that wants
  the native cursor must be listed next to the text inputs in `ui/hud/GameCursor`. **Alt** is `Keys.CURSOR` now and
  **V** is 구르기. `scav.keybinds` only stores non-default entries, so an existing save normally carries neither and
  picks the new layout up; `loadKeybinds` additionally resets 구르기 to its default if a save put it on the cursor
  key. `Keys.SWAP` was removed from `KeyBindings` outright, so a stale `SWAP` entry in that file is ignored — but a
  player who had rebound **이전 무기** loses that binding with no notice, because the action no longer exists.
- 2026-09-07 (총기 · 회복 · 기본 지급품): 무기 id 를 바꿨으므로 **기존 세이브의 무기는 로드에서 조용히
  사라진다**(창고 · 로드아웃 · 서버 프로필 모두 — `reviveItem` 이 모르는 def 를 버린다); 마이그레이션 표는 넣지
  않았다. 6계열은 예전 8계열의 스탯을 그대로 물려받아 **밸런스를 다시 잡지 않았고**, 레이저 소총이 사라져
  `kindOf` 의 `'energy'` 실루엣 · `shot_energy` 경로는 유니크(화염 · 전격)만 쓴다. 회복 쪽: **회복 스프레이의
  아군 회복은 거리만 본다** — 벽 너머도 회복되고, 힐량은 0.5초마다 `buff heal` 로 몰아 보내므로 받는 쪽에서는
  약간 뭉쳐 들어온다(호스트 검증 없음, 오버차지 빔과 같은 신뢰 모델). 스프레이를 든 채 죽거나 화면이 바뀌면
  남은 게이지는 그대로 유지되지만 **밀린 아군 힐은 버려진다**. `applyHeal` 은 회복 풀 하나를 공유하므로 붕대를
  감는 도중 스프레이를 맞으면 붕대가 더 빨리 들어온다(속도는 둘 중 빠른 쪽). 소모품 감속은 **회복 계열 + 제세동기
  전용**이다 — 수류탄 코킹이나 가젯 설치는 예전처럼 전속력이다. 기본 지급품: `Stash.firstRun` 은 **localStorage
  기준**이라 브라우저 저장소를 지우면 다시 지급되고, 반대로 서버 프로필만 있고 로컬 창고 파일이 있는 기기에서는
  지급되지 않는다(그 프로필은 서버 문서로 살아난다). 창고가 가득 차 있으면 남은 지급품은 경고 로그와 함께
  버려진다. 작업실은 여전히 방 1에 벤치까지 놓인 채로 시작하므로, 지급된 작업실/작업대 재료는 사실상 **다른
  시설(사격장 등)** 증축에 쓰게 된다. 그리고 장비 상실이 실제로 아프기 때문에 **레이드 중 사망 후 부활**
  (멀티에서만 가능)은 여전히 최소 킷(권총 I)을 주며, 그 킷은 무료다.
- 2026-09-07 (커서 편의성): the Esc-resume still leaves the **Windows cursor visible until the player's next click or
  key** — the lock genuinely cannot be taken from an Escape, so the retry is the honest best case (usually the first
  WASD tap, i.e. imperceptible; a player who presses Esc and then touches nothing keeps a free cursor until the
  `LOCK_GESTURE_RETRY_MS` window ends and the watchdog puts the menu back). Nothing tells them so — there is no
  "클릭하여 계속" hint. The retry listens on `pointerdown` / `keydown` only, so a bare mouse *move* never re-locks
  (it grants no user activation either). The cursor is linear again, with **no sensitivity setting**: a player whose
  Windows pointer speed is not the default will find the in-game cursor correspondingly slower or faster than their
  desktop one, and the smokes exercise `moveBy` directly (a headless run always takes the `mirror` path). The drag
  ghost's 1.04 lift now lives in JS (`GHOST_SCALE` in `ui/InventoryUI.ts`) — a CSS-only tweak of `.inv-ghost`'s size
  will silently re-introduce the drift; `ui/TradeGrids.ts`'s own ghost is positioned with `left/top` and was never
  affected.
- 데스크톱(Electron, 2026-09-07): 렌더러가 `127.0.0.1` 에서 로드되므로 `isDevHost()` 가 true 다 — **패키징된 앱에서도 백틱 개발자 콘솔과 치트가 열린다**(끄려면 `src/shared/console.ts` 의 `DEV_HOSTS` 판정을 바꿔야 한다). Electron 의 localStorage 는 브라우저와 **별개**라 스태시 · 로드아웃 · 함선 · 키설정 세이브가 공유되지 않는다(서버 프로필도 세션 토큰이 달라 새 아이디가 발급된다). 단일 인스턴스 락 때문에 한 PC 에서 2인 테스트는 여전히 브라우저 탭 쪽이 편하다. 아이콘은 Electron 기본값(에셋 파일 금지 규칙 유지), 코드 서명 없음 — 첫 실행에 SmartScreen 경고가 뜬다. `--relay` 프록시는 바이트 파이프라 릴레이가 죽으면 소켓만 끊기고(클라이언트 재접속이 처리), `--lan` 은 방화벽 허용을 요구한다. 스모크 · e2e 는 전부 vite 를 보므로 데스크톱 셸 자체를 검증하는 자동화는 없다.
- 2026-09-07 (안정화 pass): the **lost-lock watchdog** puts the 일시정지 메뉴 over whatever screen is open (inventory,
  terminal, 함선 관리) rather than closing it first, and it needs a real lock to have been held once — a browser that
  refuses pointer lock outright keeps the old, silent behaviour. Because the pause no longer freezes anything, Escape
  during a solo raid is now a *cost*: enemies, the mission clock and the extraction countdown keep running behind the
  menu. **Cursor acceleration** is a fixed curve, not a setting — there is no sensitivity slider, and the smokes never
  exercise it (they take the `mirror` path). The **drag** fix retargets only an equipment-slot → grid drop; a grid →
  grid drop onto an occupied cell still refuses, by design. `nearestFreeSpot` scans the whole grid per pointer move
  while the exact cell is blocked (fine at 10×24, not free). **UI stability** is fixed at the two reported places only
  (the drag footer and the 감정 status width); nothing enforces it globally, and the reserved 66 px footer is dead
  space in a raid whenever nothing is being dragged. **솔로 레이드 저장** keeps the player's inventory, stats, clock,
  seed and pose — **not** the world's mutable state: enemies, containers already looted, dropped pickups, deployed
  gadgets and live ship calls all come back fresh, exactly as a multiplayer rejoin does. The save is per browser
  profile (localStorage), so it does not follow the token to another machine, and a 5-minute grace measured on the
  **client** clock can be walked forward by changing the system time. The 레이드 실패 on an expired save is delivered
  as a toast at the title screen, with no result screen and no XP. **멀티 슬롯 유지** only holds while another
  *connected* member is still inside the raid — the last one inside dropping still ends the mission — and a squad that
  all disconnects at once behaves exactly as before. The **auto-rejoin** fires from `hub/onResumed`, so it still needs
  the one click that enters the ship from the title.
- 2026-09-07 (UI/UX pass III): 제작 열이 열린 상태에서 **레이드 중 상자 패널**은 제작 열의 오른쪽에 남는다(자리만
  `order` 로 옮겼을 뿐 레이아웃을 다시 짜지 않았다). 오른쪽 열은 `calc(100vh - 140px)` 안에서 스크롤하므로 짧은
  창에서는 함선 창고 격자가 먼저 줄어든다. `GridView` 의 칸 크기는 **생성 시점 고정**이라 살아 있는 뷰의 칸을
  바꾸려면 새로 만들어야 한다. 기업 재고 · 거래칸은 아이템 **이름을 그리지 않는다** — 이름은 공용 호버 카드
  (`ui/hud/ItemTip`)에만 있으므로 호버가 없는 입력에서는 아이콘 + 가격뿐이고, 데스크는 여전히 1240 px 아래에서
  우측 가방/창고 열을 숨긴다. `CorpViewOptions.accentTarget / onClose / isVisible` 은 남아 있지만 넘기는 곳이 없다.
  전술 임플란트 picker 는 `ctx.uiRoot` 직계 자식이라 두 shell 의 팝업이 동시에 DOM 에 있다 — 셀렉터를 쓸 때는
  `.cs-imp-pop-embed` / `-overlay` 로 구분해야 한다. 드래그 고스트 중앙 정렬과 소프트 커서 CSS 수정은 **스모크가
  검증하지 않는다**(둘 다 순수 시각 동작).
- Phase 11 (2026-09-07): **행성** — 5행성은 기존 5바이옴 · 5하늘 팔레트의 재조합이라 신규 적도 신규 아이템도 없다.
  `eco.bugs` 에 없는 종류는 아예 등장하지 않으므로 보레아스 IX · 베르단트 III 는 `maxArtillery` / `maxBehemoth` 값이
  있어도 포병 · 베헤모스가 나오지 않는다(계약대로 "맵에 없으면 스폰 없음"이 상한보다 우선). 앰비언트 / 웨이브 **구성**은
  예전처럼 `Math.random()` 이라 시드로 재현되지 않는다 — 시드가 보장하는 것은 지형 · 채집 · 로그 가드 배치다.
  첫 행성을 고르면 워프 컷씬이 한 번 재생되므로 새 프로필은 발사 전에 4.5 초를 쓴다. 이동 중에는 함선 내부가 갱신되지
  않고(카메라가 밖에 있다), 창밖 장식 행성만 목적지 색으로 다시 칠해진다. 홀로그램은 **세 번째 GL 컨텍스트**다
  (메인 + 준비 패널 초상화 + 여기). — **소셜** — 아이디는 브라우저의 세션 토큰에 묶여 있어 저장소를 지우거나 기기를
  바꾸면 **다른 사람이 된다**(친구 목록도 프로필과 함께 사라진다). 친구 watcher 인덱스는 **친구만** 커버하므로 최근
  만난 플레이어의 접속 상태는 스냅샷을 다시 받을 때만 갱신된다. `social:play` 의 "상대 로비로 합류" 분기는 원자적이지
  않다(내 로비를 떠난 뒤 상대 로비 참가가 실패할 수 있다). 초대는 fire-and-forget 이라 보낸 쪽은 결과를 모르고
  `SQUAD_INVITE_TTL_S` 뒤 조용히 사라진다. 귓속말은 **기록도 차단도 없다**(오프라인이면 실패 라인만 남는다).
  방문자마다 소셜 레코드가 하나씩 생기고 **GC 가 없다**. 프리즌스 팬아웃은 합쳐 보내지 않는다(연달아 바뀌면 그만큼
  나간다). 분대원 행의 보이스 슬라이더 · 음소거는 **아무 것도 하지 않는다** — 보이스 채팅은 미구현이고 값은 패널
  수명 동안만 유지된다. 소셜 UI 는 **함선 전용**이라 레이드 중 ESC 는 예전처럼 좌측 버튼만 보여준다.
- ~~Phase 10 (2026-09-07): the software cursor~~ — **removed 2026-09-07 (마우스 커서 rework)**. Its whole follow-up
  list (untrusted synthetic events performing no default action, no text caret at the click position, `Input`'s empty
  button sets, the faked-lock detector, the Esc menu as the one real-cursor screen) is moot: the real OS cursor is
  back everywhere, so defaults, carets, native drags and future controls all work by themselves. What is left is the
  new trade-off — an unlocked cursor **can** leave the game window on a multi-monitor desktop while a screen is open,
  which is exactly what Phase 10 was built to prevent and what the player asked to get back.
- Phase 10: the **3등신 model is rolled back** (2026-09-07) — `SoldierModel.ts` / `GearLook.ts` are the pre-Phase-10
  armoured trooper again, so the armour-plate / held-prop scaling notes below no longer apply. The **carry** pose lays the (prone) body across the shoulders rather than in a real fireman's
  carry, `canUseWeapons()` deliberately stays true while carrying (so `weapons`' own gate can fire the drop), which
  means the local gun mesh follows the hand into the carry pose for the frame or two before an action drops the body,
  and a carried body's `PlayerSnapshot.position` is ignored rather than suppressed (it keeps being sent). Only the
  *carrier* is authoritative: if the carrier's socket disappears (suspend / demote) the body is evacuated to the scene
  at its last world position, not at a validated ground point.
- Phase 10: the **carried shield** blocks only inside `IMPLANT_BARRIER_CARRY_ARC` of the carrier's forward, and
  `IMPLANT_BARRIER_CARRY_OFFSET` **must** stay greater than `PLAYER_RADIUS` — below that, enemy hitscan clamps to the
  player capsule before the barrier query runs and the shield silently stops working. A player still cannot shoot their
  own shield (`fromEnemy=false` passes through, by design). A peer's shield hp prefers the snapshot `bhp`; with an
  older peer that sends only `imp shield`, the hp is whatever the last message said.
- Phase 10: **corpse looting** is decided per corpse at death, so a squad can walk past nine unsearchable scavengers in
  a row — the roll is seeded per `worldSeed ^ enemyId`, so it is the same for everyone and the same on every replay of
  that seed. A non-lootable corpse sends `ee corpse {lt:0}` but never a matching `ee corpseGone`. The **mid-air fall**
  is client-simulated on replicas from rest (a replica has no real `vy`), so a mid-leap death settles in the same spot
  slightly later there; a paused gameplay phase stalls the fall, and `CORPSE_LAND_TIMEOUT` can then register a corpse
  that is still in the air. A promoted host inherits no pending corpse registrations.
- Phase 10: the **READY panel** portraits run a **second WebGL context** (the main renderer draws through the composer
  at the end of the frame and offers no post-render hook). That is one extra context for the whole app, only alive
  while the panel is up, but a browser that refuses it degrades the panel to name-only cells. A cell's body is rebuilt
  when the slot colour changes (the accent is baked at construction). The panel shows a member's *card*, which is only
  as fresh as their last `crew card` broadcast (debounced by `CREW_CARD_MIN_INTERVAL_S`), and the 분대원 장비 popup
  shows the loadout the peer answered with — there is no re-request while it is open. A member with no relay (solo /
  offline) has no card at all.
- Phase 10: **live container sync** animates only *another* member's take (a local take already flies into the bag),
  and only while that container's window is open — a viewer whose window is closed reconciles silently, which is
  correct but means the 감정 progress of a vanished tile is dropped without feedback. `cont taken.rem` is used to
  converge a copy that still holds more than the host, removal-only.
- Phase 10: **credit display** is unified on `formatCredits`, but `meta/ui/dom.ts`'s `fmtNum` still groups with
  `en-US` while `formatCredits` uses `ko-KR` — they agree today by accident, not by contract. `ItemDef.value`,
  `buyPriceOf` and `sellPriceOf` were not rebalanced, so the numbers the new `100 C` bars show are the old ones.
- Phase 9 UI/UX 개선 pass II (2026-09-07): **분대 계약** rows trust each member's own broadcast (`meta contract`) —
  nobody validates the progress beyond clamping it to the contract's target, and a member with no relay (offline /
  solo) simply never appears. The panel draws at most three rows. The **빠른 사용 썸네일** strip shows every unlocked
  wheel slot, so an 8-slot bag makes it ~300 px wide on the right edge; it hides only when *every* slot is empty. The
  **임플란트 썸네일** carries no cooldown number (that stays on the crosshair gauge). The raid inventory keeps its
  버리기 존 and key hints, so it is the ship layout *plus* those two — not a pixel-identical copy. **시설 증축**
  refunds at 100 % of the current tables, exactly like the upgrade refund, so re-balancing a cost changes what an
  already-built room hands back; the 발전기 Lv.1 gate means a brand-new save must spend 폐금속 4 before it can assign
  any room. The 함선 tab's 증축 popup and 시설 관리's 용도 지정 picker are two entry points for the same rule set —
  both call `purposeBlock` / `setRoomPurpose`, so they cannot disagree, but they are separate DOM. `.inv-screen.is-ship`
  pins the 함선 tab to `100vh − 130px`, so a very short window scrolls the 방 목록 rather than the page. The 기업 desk
  at 1760 px needs a wide window: below ~1240 px the right-hand grids are still hidden by the existing media query.
- Phase 9 UI pass (2026-09-07): the 시설 제거 refund is computed from the **current** cost tables, so rebalancing
  `RANGE_UPGRADE_COST` / `WORKSHOP_UPGRADE_COST` changes what an already-built facility hands back — and it refunds at
  100 %, so moving a facility to another room is free (deliberate: there is no other way to move one). The stash
  pre-check is a free-cell estimate, so a fragmented stash can still lose the tail of a refund at the real
  `tryAddToStash` (a warning toast says so). A room's purpose is **assigned** only in 시설 관리 — the 함선 tab levels and
  removes, it never creates. The 기업 거래 basket validates only the balance (`credits + revenue ≥ cost`), not per line:
  a purchase that fails for space mid-settle stops that line and earlier lines stay bought; with server-owned credits
  the summary's counts are the optimistic ones (late per-purchase toasts are swallowed, late failures still toast).
  Staging is whole-stack (no split-on-drag) and the right-hand grids are hidden below 1240 px. `TradeGrids` has no
  tooltip and no rotation preview. The 도감 now lives only on a 책장 in the 서재.
- Phase 9 (2026-09-07): a profile document stamp is the **writer's** clock (`serverNow()`, clamped server-side to `PROFILE_CLOCK_SKEW_MS`), so a client whose clock ran ahead while offline still wins that merge; documents are merged per key, so a single edit that spans `stash` + `loadout` can land half-and-half if the socket dies between the two frames. A parked ghost is dropped after `NET_GHOST_PARK_S` even if the member is still loading. The host role parked mid-raid means a squad whose members are **all** in the hub has no authority until one re-enters (by design — nothing to simulate). `strat sync` fast-forwards a landing that should already have happened, so a very late joiner sees no fall animation; supply-crate contents stay per-client. `meta sync` trusts a peer's own tally (bounded by the contract target) and is answered once per requester per mission. Delta `es`: a replica that misses a keyframe waits up to `NET_ENEMY_KEYFRAME_S` for an unknown id (`ee spawn` normally covers it), and `gone` is redundant with `ee despawn` by design. 서재: books are per-ship (not per-character), the 도감 only records what was **shelved**, and a shelf keeps at most `BOOKS_PER_SHELF` books with no upgrade path. 훈련장 표적 모드 are client-local (a second trainee sees its own mode), and the 무기 거치대 opens the whole 무한 상자 with the weapon tab preselected rather than a weapons-only picker.
- Phase 8 UI pass (2026-09-06): `ui/hud/ItemTip` renders **def-level** data only (a cost chip has no `ItemInstance`), so a
  weapon chip shows no durability / sockets / loaded ammo the way the inventory tile tooltip does; it is a hover card, so
  a touch device gets nothing. `HousingRef.openRoomMenu / openFacilityMenu` are kept only as redirects to 시설 관리 —
  nothing in the game calls them any more, and neither does `enterHousingMode` (the room-presence gate is API-only now).
  The **방 1 = 작업실** migration moves furniture that no longer fits its room into furniture storage rather than trying to
  re-place it, so an older ship whose 작업실 was elsewhere finds its benches boxed up. The 시설 관리 furniture list still
  only shows what the selected room accepts (unchanged), and its 용도 지정 picker offers no 빈 방 entry — the header's
  `빈 방으로` button does that instead. `.inv-screen` is one scroll container, so the sticky 시설 관리 (M) button is the
  only thing pinned; the two columns collapse to one below 1180 px.
- Phase 8 (2026-09-06): the 재배층 stack is homogeneous and only the **top** 층 can be recovered (a middle piece must be dug out); `GrowPlot` timers are client-computed from `ctx.net.serverNow()` and are **not** server-validated, so an offline profile trusts the local clock; crops keep growing while the player is in a raid but there is no notification when one ripens; seeds have no craft recipe by design (loot + 기업 상점 only) and 연구실 still cannot make them; the 함선 관리 furniture bar lists only what the selected room accepts, so a piece in storage for another purpose is invisible until that room is selected; 함선 관리 takes its own `shipmanage` blocker, which also hides the 함선 관리(M) hint while it is open; the 자동문 are visual only (they never block movement, exactly as the open doorways did before); room lighting re-anchors a 3-light pool, so more than three occupied rooms in view share them; the 설정 menu has no BGM slider because there is no BGM yet (the channel is reserved); `Input.consume()` fixes Escape ordering between hub/ and game/ but any future system polling `Keys.MENU` must call it too.
- Phase 7 (2026-09-06, what is left after Phase 9): a purchase whose `credits:result` never arrives is delivered on the local debit and corrected at the next profile load; a non-host trainee has no `isAuthority` (fine while targets are world-local); the corp screen's 공간 없음 line reflects the bag / stash state at render time only.
- Phase 5: the shared-ship computer corner is dim (no light added); a server-side account beyond the per-token profile (login, multiple devices sharing one profile) is out of scope.
- Phase 6: 헬스장 / 연구실 / 주방 / 채굴 / 휴식 rooms can be assigned and decorated but have no mechanics (온실 landed in Phase 8, 서재 in Phase 9); furniture is deliberately **not** an item — it lives only in the furniture storage (crafted there, no loot / shop furniture yet); ship crafting / repairs at benches still consume bag-only materials (`consumeDefAll` serves facility costs); `applyLoadout` takes the first instance per def id (no grade preference); replica 전소 is optimistic until the host's `sb` bits arrive and status requests are not distance-validated; `hub:roomEntered` / housing only exist on the personal ship; the console's `/seed` is the only seed entry point (no UI); rooms are lit by emissive strips only.
- Controls / hub screen (2026-09-06): rebinding covers keyboard + mouse buttons only (no gamepad); `MENU` is fixed on Esc; the `P` character-sheet shortcut is not in the table. The hub Tab layout needs ≥ 1600 px for the rose-right / two-column equipment arrangement and ≥ ~1230 px to avoid horizontal scrolling of the layout. The implant picker is inline (the equipment column scrolls on short windows). 정찰 / 갈고리 show no hand device by design. The old `KEY_*` constants remain as deprecated defaults until every reader is confirmed migrated.
- Tactical-kit merge: jump-bag dash and the 특수 가방 perk have no bag; tactical bags carry hover + implant cooldown instead. Armor has no repair cost. Gadget items dropped by a bag swap in the hub cannot be picked up there. `derived.carryCapacity` grows with 근력 but bag capacity bonus is a flat +0.5 kg per extra cell. The roll keeps the `player:dived` event / DIVE flag / `ri.dive` camera treatment as aliases (there is no separate dive any more).
- Phase 4: rogue shots at remote players send `dmg` without an `ee attack`; corpses leave host snapshots after 1.5 s so a mid-mission rejoin sees no existing corpses; rogue AI v2 has no squad roles / low-hp retreat (deliberately) and no HUD for boss health or faction clashes (deliberately).
- Phase 3: supply crate contents are rolled per client (deterministic by seed, taken state shared since Phase 7); remote calls snap to the receiver's terrain height; stratagem audio reuses existing SFX ids (no dedicated whistle/beam sounds); the laser/airstrike damage to *remote* players relies on each client's own `takeDamage` (no host validation); off-screen indicators ignore enemies by design.
- Phase 2: a pin-pulled grenade dropped by a forced swap lands at the feet; `bag_legendary_tac` declares 9 quick slots (clamped to 8).
- Weapon package: the laser sight is a mesh only (no HUD dot); grade/socket numbers are first-pass; the ADS framing (`ADS_SHOULDER` 0.68 / `ADS_PIVOT_LIFT` 0.22) may want toning down after real play.
- Soldier armor still reads dark in the mossy/toxic-green palette; consider an env map or rim light.
- Dropship hull is boxy up close; more greebles/panel lines would help.
- Ambient enemy pressure and wave sizes are untuned for a real play session.
- Stamina/falloff/recoil numbers are first-pass; tune with real play. Prone crawl animation is minimal.
- Multiplayer: `RemotePlayerRef` has no lag compensation for client shots (host validates only enemy id/damage cap); remote hellpods are not rendered.
- Hub: launch countdown on clients is a local mirror (no wire message); draw-call counts of the ship interiors are estimated, not measured; docking cutscene is short/low-poly; hub-time `ui:notify` toasts rely on the social HUD layer.
- Tactical kit: the cloak veil shares its cloak over `buff {kind:'cloak'}`, but a *newly joining* client is not told
  about an in-flight cloak. `ImplantsRef.raycastBarrier` damages the barrier as a side effect of reporting a block — a separate `damageBarrier` entry point would be cleaner.
  `PlayerRef.isOvercharged` is inferred from the `'overcharge'` speed-modifier key rather than an explicit setter.
- Tactical kit: Detection highlights are spheres at the object's position,
  not real mesh outlines, because `Interactable` exposes no geometry (`object?` / `kind?` fields would fix that).
  Quick slots have no per-item cooldown readout. Hub hydroponics are per-client (not networked).
- Silhouette is opaque black (a transparent pass would sort after the body); enemies in front of the soldier also trigger it. Pickup lifetime expiry is per-client (fine while `PICKUP_LIFETIME` = 0). Interaction (E) stays active while boarded in a pod.

