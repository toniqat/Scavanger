# SCAVANGER — 앞으로 해야 할 작업 목록

이 프로젝트의 **유일한 할 일 목록**이다. Phase 0–12 는 전부 구현 완료라(→ [HISTORY.md](HISTORY.md) 의 `완료된 단계`),
여기 남은 것이 아직 안 된 전부다. 2026-09-08 에 `docs/` 전체를 읽고 **`src/` · `server/` · `electron/` 코드와 대조**해서 뽑았다.

읽는 법:

- **묶음 1–5** = 다음 페이즈 후보. 하나가 한 번의 작업 사이클이다 (소유 폴더를 각 묶음 머리에 적었다).
- **묶음 6–7** = 페이즈로 묶지 않고 다른 작업에 얹어서 처리하는 상시 항목.
- **참고 절** = 지금 할 일이 아니라 "바꾸려면 결정이 먼저"인 것들.
- 각 행의 **근거**는 감사에서 직접 확인한 코드 위치다. `grep 0` 이면 그 이름의 구현이 저장소에 아예 없다는 뜻.
- **`A-1` 같은 항목 ID 는 고정이다** — [DECISIONS.md](DECISIONS.md) 와 폴더 README 들이 이 번호로 가리킨다. 재사용하지 않는다.
- 출처 약어: `HISTORY` = [HISTORY.md](HISTORY.md) 의 미해결 항목, `DEC` = [DECISIONS.md](DECISIONS.md).

작업 방식은 Phase 5 이후 계속 같다: **리드가 `src/shared` 계약을 먼저 작성 · 커밋** → 폴더별 병렬 에이전트가
자기 폴더만 소유 → `npm run verify:all`.

한 항목을 끝내면 **이 파일에서 그 행을 지우고** 해당 폴더 `README.md` 의 `변경 이력` 과 [HISTORY.md](HISTORY.md) 에 남긴다.

---

## 묶음 1 — 함선 콘텐츠

함선 10개 방 중 5개가 껍데기다. 지금 가장 눈에 띄는 빈칸.
소유 폴더: `housing` · `hub` · `items` · `inventory` · `ui`.
계약: `shared/housing.ts` 의 `ROOM_PURPOSES_ACTIVE` 확장 + 방별 상태 스키마.

| ID | 항목 | 근거 (2026-09-08 확인) |
|---|---|---|
| A-3 | **함선 방 5종의 기능**. 용도 지정 · 장식만 되고 메커니즘이 없다 | `src/shared/housing.ts:88` `ROOM_PURPOSES_ACTIVE = ['empty','workshop','range','greenhouse','library']` — 나머지 5종은 설명이 전부 `(다음 업데이트)` (`housing.ts:42–48`), UI 는 배지만 (`src/housing/ui/ShipView.ts:136`, `src/ui/hud/ShipManage.ts:503`) |
| A-3a | · 헬스장 — 미니게임, 쿨타임, 근육통 디버프 | 위와 동일 |
| A-3b | · 연구실 — 배양기 · 생체 프린터(토양 · 씨앗 · 배양고기). **씨앗은 지금 레시피가 없어 루팅/상점 전용**이라 연구실이 곧 씨앗 공급처가 된다 | 위와 동일 + HISTORY Phase 8 ("연구실 still cannot make them") |
| A-3c | · 주방 — 요리로 다음 레이드 버프, 공유 함선 테이블 | 위와 동일 |
| A-3d | · 채굴 — 그래픽카드, 코인 차트 | 위와 동일 |
| A-3e | · 휴식 공간 — TV/스피커로 비디오 · Vinyl 재생 | 위와 동일 |
| A-4 | **가구 구매 · 루팅 가구**. 가구는 제작만 되고 상점 · 드랍이 없다 | `grep -rn "가구 구매\|buyFurniture\|furnitureShop" src/` → 0 hit · HISTORY Phase 6 |
| A-5 | **상위 개인 함선** (함선 티어 업그레이드) | `grep -rn "shipTier\|shipUpgrade\|상위 함선" src/` → 0 hit |
| B-9 | **시설 관리의 발전기 행이 빈 방 picker 안에서만 보인다**. 용도가 이미 있는 방은 여전히 Tab 함선 탭으로 가야 한다 | HISTORY Phase 12 |

## 묶음 2 — 행성 기믹

Phase 5 때부터 "별도 세션"(월드 대공사)으로 미뤄 둔 것. 5행성이 지금은 바이옴 재조합뿐이라, 행성마다 고유한 것이 생긴다.
소유 폴더: `world` (지형 · 콜라이더 · 인터랙터블) · `net` (호스트 권위 동기화) · `ui`.

| ID | 항목 | 근거 |
|---|---|---|
| A-1 | **기차 · 레일** — 맵 외곽 레일, 재료 투입으로 작동, 전/후진, 탑승 이동 | `grep -riE "기차\|레일카\|railcar\|freight" src/` → 0 hit · DEC Phase 5 ("월드 대공사, 별도 세션") |
| A-2 | **버려진 화물차** — 행성당 1대, 탈출구 지정 시 이동, 도착 시 6배 크기 상자 개방 | `grep -riE "화물차\|cargo ?truck" src/` → 0 hit |

## 묶음 3 — 소셜 · 멀티 마무리

Phase 11 이 뼈대만 놓고 끝난 부분 + 호스트 검증이 비어 있는 신뢰 경로.
소유 폴더: `server` · `net` · `ui` (신뢰 경로는 `weapons` · `implants` · `meta` · `stratagems` 도).

| ID | 항목 | 근거 |
|---|---|---|
| A-6 | **보이스 채팅**. 분대원 행의 볼륨 슬라이더 · 음소거는 아무 것도 하지 않는다 | `src/ui/menus/social/SocialColumn.ts:39–40` "UI only … never read by anyone", `src/shared/constants.ts:875` `SQUAD_VOICE_DEFAULT` |
| B-2 | **소셜 레코드 GC 가 없다**. 방문자마다 레코드가 하나씩 쌓이고 아무도 지우지 않는다 | `grep -n "gc\|prune\|purge" server/Store.ts` → 0 hit |
| B-3 | **초대는 fire-and-forget**. 보낸 쪽은 결과를 모르고 `SQUAD_INVITE_TTL_S` 뒤 조용히 사라진다 | HISTORY Phase 11 |
| B-4 | **귓속말은 기록도 차단도 없다**. 오프라인이면 실패 라인만 남는다 | HISTORY Phase 11 |
| B-5 | **프리즌스 팬아웃이 친구만 커버**. 최근 만난 플레이어의 접속 상태는 스냅샷을 다시 받을 때만 갱신되고, 팬아웃은 합쳐 보내지 않는다 | HISTORY Phase 11 |
| B-6 | **`social:play` 의 "상대 로비로 합류" 가 비원자적**. 내 로비를 떠난 뒤 상대 로비 참가가 실패할 수 있다 | HISTORY Phase 11 |
| E-4 | **호스트 검증이 없는 신뢰 경로**: 회복 스프레이의 아군 힐(거리만 보고 벽도 통과), 오버차지 빔, 분대 계약 진척(`meta contract`, 목표치 클램프만), 궤도 레이저/항공 폭탄의 원격 플레이어 피해 | HISTORY 2026-09-07(총기 · 회복), Phase 9 pass II, Phase 3 |
| E-5 | **솔로 레이드 저장의 5분 유예가 클라이언트 시계** — 시스템 시간을 앞으로 돌리면 걸어 넘길 수 있다 | HISTORY 2026-09-07(안정화 pass) |
| E-6 | **프로필 문서 병합이 writer 의 시계 기준**(`PROFILE_CLOCK_SKEW_MS` 로 clamp) — 오프라인 중 앞서간 시계가 그 병합을 이긴다. 한 편집이 `stash` + `loadout` 을 걸치면 소켓이 중간에 죽을 때 반반으로 남을 수 있다 | HISTORY Phase 9 |

## 묶음 4 — 배포 · 안정화

혼자 놀 때는 안 보이지만, 남에게 주는 순간 드러나는 것들.
소유 폴더: `electron` · `net` · `server` · `inventory` · `shared/console.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| E-1 | **패키징된 데스크톱 앱에서도 개발자 콘솔과 치트가 열린다**. 렌더러가 `127.0.0.1` 에서 로드되므로 `isDevHost()` 가 true | `src/shared/console.ts:50` `DEV_HOSTS = ['localhost','127.0.0.1','[::1]','::1']` — 끄려면 이 판정을 셸 여부로 바꿔야 한다 |
| B-1 | **릴레이 연결 실패를 알리는 UI 가 없다**. 앱은 조용히 오프라인으로 뜨고, `ensureConnected` 재시도는 시작 시 1회 + 터미널 `신호 찾기` 뿐이라 서버를 나중에 켜면 그 버튼을 눌러야 한다 | HISTORY 2026-09-07(배포용 릴레이 주소) |
| E-2 | **배포본에 구운 릴레이 주소가 IP 문자열**이라 DHCP 로 주소가 바뀌면 전부 헛다리 — 받는 쪽이 `relay.txt` 를 고쳐야 한다. 검증은 `new URL` 이 전부라 오타는 조용한 접속 실패로만 드러난다 | HISTORY 2026-09-07(배포용 릴레이 주소) |
| E-3 | **데스크톱 셸 자체를 검증하는 자동화가 없다** — 스모크 · e2e 는 전부 vite 를 본다 | HISTORY Electron |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | HISTORY 2026-09-07(배포용 릴레이 주소) |
| A-9 | **세이브 마이그레이션 표**. 무기 id 개편(2026-09-07) · 임플란트 id 변경 때 기존 세이브의 아이템이 로드에서 **조용히 사라진다** | `src/inventory/Serialize.ts:80` `reviveItem` 이 모르는 def 를 `null` 로 버린다 (창고 · 로드아웃 · 서버 프로필 공통) |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-10 | **document fullscreen 토글**. 이게 있어야 `navigator.keyboard.lock` 경로가 살아나 Escape 후 즉시 복귀가 가능해진다 | `grep -rn "requestFullscreen" src/ electron/` → 0 hit ⇒ `document.fullscreenElement` 는 항상 null, `Input.syncKeyboardLock` 이 죽은 코드 |
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM**. 설정의 오디오 채널 자리만 비워 뒀다 | `src/ui/menus/SettingsMenu.ts:26` "Room is left for a future BGM row … there is no BGM" |
| B-7 | **퀵슬롯에 아이템별 쿨다운 표시가 없다** (임플란트 썸네일도 쿨다운 숫자가 없고 크로스헤어 게이지에만 있다) | HISTORY Tactical kit, Phase 9 pass II |
| B-8 | **기업 재고 · 거래칸이 아이템 이름을 그리지 않는다**. 이름은 공용 호버 카드(`ui/hud/ItemTip`)에만 있으므로 호버가 없는 입력(터치)에서는 아이콘 + 가격뿐 | HISTORY UI/UX pass III |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | HISTORY Phase 12 |

## 묶음 6 (상시) — 계약 · 구조 부채

한 줄짜리지만 `src/shared` 를 열어야 한다. **계약을 여는 페이즈가 있을 때 같이 처리한다.**

| ID | 항목 | 근거 |
|---|---|---|
| C-1 | **`pushBack` 을 `EnemyManagerRef` 로 승격**. 지금은 implants 가 옵셔널 캐스트로 부른다 | `src/implants/parts/Barrier.ts:186–189` |
| C-2 | **`IMPLANT_REPAIR_FEE` 를 `shared/meta.ts` 로 이동**. Phase 12 때 계약이 얼어 있어 meta 안에 남았다 | `src/meta/Rules.ts:142`, `src/meta/README.md:243` |
| C-3 | **`PlayerRef.isOvercharged` 에 명시 setter**. 지금은 `'overcharge'` 속도 수정자 키에서 추론한다 | `src/shared/types.ts:807`, HISTORY Tactical kit |
| C-4 | **`Interactable` 에 `object?` / `kind?`**. 없어서 감지 하이라이트가 실제 메시 아웃라인이 못 되고 오브젝트 위치의 빛기둥으로 남는다 | HISTORY Tactical kit |
| C-5 | **`bag_legendary_tac` 이 퀵슬롯 9 를 선언**하는데 휠은 8 칸이라 클램프된다 | `src/items/ItemDefs.ts:184` |
| C-6 | **`CorpViewOptions.accentTarget / onClose / isVisible` 이 죽은 옵션** — 넘기는 곳이 없다 | HISTORY UI/UX pass III |
| C-7 | **`HousingRef.openRoomMenu / openFacilityMenu` 는 시설 관리로 가는 리다이렉트만** — 게임에서 아무도 부르지 않는다 | HISTORY Phase 8 UI pass |
| C-8 | **옛 `KEY_*` 상수가 deprecated 기본값으로 남아 있다** — 모든 읽는 쪽 이관을 확인하고 제거 | HISTORY Controls |
| C-9 | **`Keys.SWAP` 제거의 후폭풍** — `이전 무기` 를 리바인딩했던 플레이어는 통보 없이 그 바인딩을 잃는다 | HISTORY 2026-09-07(마우스 커서 rework) |
| C-10 | **`meta/ui/dom.ts` 의 `fmtNum` 은 `en-US`, `formatCredits` 는 `ko-KR`** — 오늘 값이 같은 건 우연이다 | `src/meta/ui/dom.ts:24` vs `src/shared/meta.ts:410` |
| C-11 | **`WorldRef` 에 전초기지 접근자가 없다**. `fog:discovered.kind` 는 `'outpost'` 를 받는데 위치를 물을 길이 없어 지도가 전초기지를 아예 그리지 못한다 (안개 이전에도 안 그렸다) | `src/shared/events.ts` `fog:discovered`, `src/world/Outposts.ts` |
| C-13 | **`scripts/smoke-ui-p5.mjs` 의 정규식이 백스페이스 문자다** — 소스에 `\bready\b` 대신 **제어문자 0x08 두 개**가 박혀 있어 (`!/<BS>ready<BS>/.test(hg.cls)`) 그 단언이 **늘 통과한다**. 커밋된 지 오래된 별개 버그이고, 고치면 단언이 실제로 검사를 시작하므로 그때 red 가 날 수 있다 | `scripts/smoke-ui-p5.mjs:203` |
| C-12 | **`ProgressionRef` 에 레이드 중 임플란트 회수 수단이 없다**. `unequipImplant` 가 함선 전용 게이트라 `stripForCorpse` 가 임플란트를 시체로 옮기지 못한다. 지금은 **유지가 의도된 설계**지만(2026-09-09 사용자 결정), 뒤집으려면 `stripImplants()` 가 먼저 필요하다 | `src/progression/ProgressionSystem.ts:117`, `src/shared/types.ts` `stripForCorpse` |

## 묶음 7 (상시) — 밸런스 · 튜닝

전부 1차값이다. 실플레이 뒤에 조정한다.

| ID | 항목 | 출처 |
|---|---|---|
| D-1 | **무기 6계열이 예전 8계열 스탯을 그대로 물려받았다** — 재밸런스 안 함 | HISTORY 2026-09-07(총기) |
| D-2 | **등급 배율 · 소켓 효과 수치** (등급당 대미지 +12 % / 내구도 +25 %, 제동기 −20 % 등) | DEC Phase 5 · Weapon package |
| D-3 | **`ItemDef.value` · `buyPriceOf` · `sellPriceOf` 미조정** — Phase 10 이 명시적으로 범위 밖에 뒀다 | HISTORY Phase 10, DEC Phase 10 |
| D-4 | **앰비언트 적 압박 · 웨이브 크기** 미조정 | HISTORY |
| D-5 | **스태미나 · 감쇠 · 반동** 1차값, 포복 애니메이션 최소 | HISTORY |
| D-6 | **ADS 프레이밍** (`ADS_SHOULDER` 0.68 / `ADS_PIVOT_LIFT` 0.22) 재확인 | HISTORY Weapon package |
| D-7 | **병사 장갑이 이끼/독성 녹색 팔레트에서 어둡게 읽힌다** — env map 또는 림 라이트 검토 | HISTORY |
| D-8 | **드랍쉽 선체가 가까이서 각지다** — 그리블 · 패널 라인 추가 검토 | HISTORY |

---

## 참고 — 의도된 한계 (지금은 할 일이 아니다)

전부 "이렇게 하기로 했다" 로 남은 것들이다. **바꾸려면 결정이 먼저**이므로 위 묶음에 넣지 않았다.

- **배리어** — 플레이어는 자기 방패를 통과하고, 자기 방패를 쏠 수도 없다(`fromEnemy=false` 는 통과). 들고 있는 방패는 `IMPLANT_BARRIER_CARRY_ARC` 안에서만 막고, `IMPLANT_BARRIER_CARRY_OFFSET` 이 `PLAYER_RADIUS` 보다 커야 동작한다.
- **적 조사(investigate) 상태는 호스트 전용** → 호스트 이관 시 사라진다. 승격된 호스트는 대기 중이던 시체 등록도 물려받지 못한다.
- **총알 추적** — 산탄총은 조준선 하나만 보고한다(펠릿 각각이 아니다). 비행 중인 발사체는 임무가 끝나면 착탄 보고를 못 보낸다.
- **임플란트 보너스는 `STAT_MAX` 로 잘리지 않는다**(의도). `resetProfile` 은 그리드에 자리가 없으면 장착 임플란트를 잃는다.
- **로그 AI** — 스쿼드 역할 · 저체력 후퇴 없음, 보스 체력 HUD · 진영 충돌 HUD 없음 (전부 의도).
- **멀티** — 클라이언트 샷에 랙 보정 없음(호스트는 적 id · 피해 상한만 검증), 원격 헬포드 미렌더, 함선 발사 카운트다운은 클라이언트 로컬 미러(와이어 메시지 없음), 신규 합류자에게 진행 중인 은폐(cloak)를 알리지 않는다.
- **행성** — 5행성은 기존 5바이옴의 재조합이라 신규 적 · 신규 아이템이 없고, `eco.bugs` 에 없는 종류는 상한값이 있어도 등장하지 않는다. 앰비언트/웨이브 구성은 `Math.random()` 이라 시드로 재현되지 않는다(시드는 지형 · 채집 · 로그 가드 배치만 보장).
- **시체 루팅**은 사망 시점에 시체별로 결정되므로 못 뒤지는 시체가 연달아 나올 수 있다(시드 고정).
- **레이드 저장은 플레이어 상태만** — 적 · 이미 턴 컨테이너 · 떨어진 픽업 · 배치된 가젯 · 진행 중 함선 호출은 전부 새로 시작한다.
- **커서** — 창모드 멀티모니터에서는 화면이 열려 있는 동안 커서가 게임 창을 벗어날 수 있다(실제 OS 커서를 쓰는 대가). 감도 설정이 없다.
- **서재 책은 캐릭터가 아니라 함선 단위**, 도감은 꽂은 것만 기록, 책장 업그레이드 경로 없음. **훈련장 표적 모드는 클라이언트 로컬**.
- **재배층 스택은 동종이고 맨 위만 회수**할 수 있으며, 작물이 익어도 알림이 없다. 자동문은 시각 전용(막지 않는다).
- **시설 제거 환불이 현재 가격표 기준 100 %** — 리밸런싱하면 이미 지은 시설이 돌려주는 양이 바뀌고, 시설 이동이 사실상 공짜다(의도 — 다른 이동 수단이 없다).
- **UI 폭** — 기업 데스크는 1240 px 아래에서 우측 격자를 숨기고, 함선 Tab 은 1600 px 이상을 원한다.
- **계정** — 토큰별 프로필이 전부다. 로그인 · 여러 기기 공유는 범위 밖(HISTORY Phase 5).

---

## 이 문서를 갱신할 때

```
grep -rn "<이름>" src/ server/ electron/ --include=*.ts     # 구현 존재 확인
grep -rniE "TODO|FIXME|미구현|다음 업데이트" src/ server/     # 코드가 스스로 신고한 구멍
```

새로 생긴 한계는 [HISTORY.md](HISTORY.md) 의 `미해결 항목` 에 쓰고, 실제로 **할 일**이면 여기 묶음에도 한 줄 넣는다.
새 항목의 ID 는 그 계열의 다음 번호로 이어 붙인다 (지운 번호는 재사용하지 않는다).
