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
| A-5 | **상위 개인 함선** (함선 티어 업그레이드) | `grep -rn "shipTier\|shipUpgrade\|상위 함선" src/` → 0 hit |
| B-9 | **시설 관리의 발전기 행이 빈 방 picker 안에서만 보인다**. 용도가 이미 있는 방은 여전히 Tab 함선 탭으로 가야 한다 | HISTORY Phase 12 |

## 묶음 2 — 행성 기믹

Phase 5 때부터 "별도 세션"(월드 대공사)으로 미뤄 둔 것.
소유 폴더: `world` (지형 · 콜라이더 · 인터랙터블) · `net` (호스트 권위 동기화) · `ui`.

**2026-09-09 에 이 묶음의 대부분이 들어갔다** — 버려진 구조물 3종(지하실 · 키카드 · 행성 스캔), 선로 · 플랫폼 ·
전차(A-1), 환경 재해 4종, 로그 강하, 행성별 무기 등급 곡선. 남은 것은 아래 한 줄과 그 아래 이월 항목이다.

| ID | 항목 | 근거 |
|---|---|---|
| A-2 | **버려진 화물차** — 행성당 1대, 탈출구 지정 시 이동, 도착 시 6배 크기 상자 개방 | `grep -riE "화물차\|cargo ?truck" src/` → 0 hit |

## 묶음 3 — 소셜 · 멀티 마무리

Phase 11 이 뼈대만 놓고 끝난 부분 + 호스트 검증이 비어 있는 신뢰 경로.
소유 폴더: `server` · `net` · `ui` (신뢰 경로는 `weapons` · `implants` · `meta` · `stratagems` 도).

**2026-09-11 에 B-2 · B-3 · B-4 · B-5 · B-6 · E-4 · E-5 · E-6 (+ B-1 · E-3 · C-57 · C-59) 가 끝났다** — 설계안 `plans/net-social-trust.md` 는
전부 구현돼 지웠고 결과는 [HISTORY.md](HISTORY.md) 16차. 남은 것은 보이스 채팅과 그 배치가 남긴 틈(E-8 · E-9 · B-11 · B-12)이다.

| ID | 항목 | 근거 |
|---|---|---|
| A-6 | **보이스 채팅**. 분대원 행의 볼륨 슬라이더 · 음소거는 아무 것도 하지 않는다 | `src/ui/menus/social/SocialColumn.ts:39–40` "UI only … never read by anyone", `src/shared/constants.ts:875` `SQUAD_VOICE_DEFAULT` |
| E-8 | **신뢰 경로의 남은 틈 (E-4 뒤)** — `explode` 요청(요청당 피해 500 · 반경 20 상한만)과 `HitRequest.st`(상태이상)는 여전히 검증 없이 믿는다. 호스트가 거절한 분대원 함선 호출은 어디에도 서지 않지만 호출자 쿨타임은 이미 돌았다 | `src/enemies/parts/Damage.ts`, `src/stratagems/parts/Targeting.ts` |
| E-9 | **서버 크레딧 검증은 아이템 소유를 보지 않는다** (사용자 수용) — 창고 · 가방 문서가 클라이언트 쓰기라 조작한 창고에서 파는 것은 막지 못한다. 막으려면 서버가 인벤토리 · 루팅 권한을 가져야 한다(페이즈 규모). 가치 1 탄약은 반올림 때문에 1발씩 팔면 묶음 판매의 2배(1 대 0.5)를 받는다 — 거래 하나하나는 정당해 서버가 막지 않는다 | `server/Economy.ts`, `src/shared/meta.ts` `sellPriceOf` |
| B-11 | **차단의 남은 틈** — 차단한 분대원의 입력 중 `…` 말풍선(`TypingBubbles`)은 보인다. 차단당한 사람이 로비 코드로 직접 `lobby:join` 하는 것은 막지 않는다 | `src/ui/hud/TypingBubbles.ts`, `server/RelayServer.ts` |
| B-12 | **합류 알림이 두 줄** — 함선에서 분대원이 들어오면 `ui/hud/Notifications` 의 `<이름> 합류` 와 `hub` 의 `<이름> 함선 합류` 가 같이 뜬다 (2026-09-11 이전부터. 초대 수락 토스트는 그래서 뺐다) | `src/ui/hud/Notifications.ts`, `src/hub/HubSystem.ts` |

## 묶음 4 — 배포 · 안정화

혼자 놀 때는 안 보이지만, 남에게 주는 순간 드러나는 것들.
소유 폴더: `electron` · `net` · `server` · `inventory` · `shared/console.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| E-1 | **패키징된 데스크톱 앱에서도 개발자 콘솔과 치트가 열린다**. 렌더러가 `127.0.0.1` 에서 로드되므로 `isDevHost()` 가 true | `src/shared/console.ts:50` `DEV_HOSTS = ['localhost','127.0.0.1','[::1]','::1']` — 끄려면 이 판정을 셸 여부로 바꿔야 한다 |
| E-2 | **배포본에 구운 릴레이 주소가 IP 문자열**이라 DHCP 로 주소가 바뀌면 전부 헛다리 — 받는 쪽이 `relay.txt` 를 고쳐야 한다. 검증은 `new URL` 이 전부라 오타는 조용한 접속 실패로만 드러난다 | HISTORY 2026-09-07(배포용 릴레이 주소) |
| E-10 | **데스크톱 스모크의 `--release` 를 실제 배포 폴더로 돌린 적이 없다** — 2026-09-11 E-3 는 임시로 뽑은 배포 폴더(`--release-dir`)로만 61/61. `npm run app:dist && node scripts/smoke-desktop.mjs --release` 한 번. 포인터 락 쿨다운 타이밍은 숨긴 창이 락을 못 잡아 여전히 수동 | `scripts/smoke-desktop.mjs` |
| E-11 | **솔로 레이드 방어의 남은 틈 (E-5 뒤, 사용자 수용 범위)** — 창을 닫고 시계를 되돌려 부팅 없이 5분 안에 켜기 · 오프라인에서 로드아웃 파일의 `raidSeed` 를 지우기 · 온라인에서 로드아웃 파일을 통째로 지우면 서버의 레이드 전 킷이 돌아온다(표식이 로컬 전용). 막으려면 서버 문서 쪽 표식(= 온라인 솔로의 서버 시계 판정)이 필요하다 | `src/game/SoloRaid.ts`, `src/inventory/parts/Lifecycle.ts` |
| E-7 | **인터넷 너머 플레이 미지원** — 포트포워딩 · VPN 메시 · VPS 가 필요하고, 개발 PC 는 관리형 네트워크라 포트포워딩이 막혀 있을 가능성이 높다 | HISTORY 2026-09-07(배포용 릴레이 주소) |
| A-9 | **세이브 마이그레이션 표**. 무기 id 개편(2026-09-07) · 임플란트 id 변경 때 기존 세이브의 아이템이 로드에서 **조용히 사라진다** | `src/inventory/Serialize.ts:80` `reviveItem` 이 모르는 def 를 `null` 로 버린다 (창고 · 로드아웃 · 서버 프로필 공통) |

## 묶음 5 — 조작 · 편의 · UI 잔손질

소유 폴더: `ui` · `player` · `audio` · `inventory` · `shared/Keybinds.ts`.

| ID | 항목 | 근거 |
|---|---|---|
| A-10 | **document fullscreen 토글**. 이게 있어야 `navigator.keyboard.lock` 경로가 살아나 Escape 후 즉시 복귀가 가능해진다 | `grep -rn "requestFullscreen" src/ electron/` → 0 hit ⇒ `document.fullscreenElement` 는 항상 null, `Input.syncKeyboardLock` 이 죽은 코드 |
| A-8 | **게임패드**. 리바인딩은 키보드 + 마우스 버튼만 | `grep -rni "gamepad" src/` → 0 hit |
| A-7 | **BGM**. 설정의 오디오 채널 자리만 비워 뒀다 | `src/ui/menus/SettingsMenu.ts:26` "Room is left for a future BGM row … there is no BGM" |
| B-10 | **채널 티커의 음소거가 플래그 하나**. 스프레이 도중 끝난 붕대는 토스트가 없고, `active:false` 를 놓치면 라인이 남는다 | HISTORY Phase 12 |

## 묶음 6 (상시) — 계약 · 구조 부채

한 줄짜리지만 `src/shared` 를 열어야 한다. **계약을 여는 페이즈가 있을 때 같이 처리한다.**

| ID | 항목 | 근거 |
|---|---|---|
| C-52 | **키프레임으로만 네임드를 만든 늦은 합류자는 `enemy:namedSpawned` 를 못 받는다** (`ee spawn` 을 놓친 경우). 2026-09-11 대조: 그 이벤트의 **구독자가 0** 이라 지금은 아무 영향이 없다 — 구독하는 코드가 생기면 키프레임 경로(`Replica`)에서도 한 번 발행해야 한다 | `src/enemies/named/Director.ts`, `src/enemies/net/Replica.ts` |
| C-58 | **perf guard 가 블룸을 꺼도 설정 화면에는 `켬` 으로 남는다** — core → ui 로 "guard 가 바꿨다" 를 알리는 계약이 없다 (2026-09-11 C-44 에서 guard 를 되살린 뒤 드러났다) | `src/core/Engine.ts` `perfGuard`, `src/ui/menus/SettingsMenu.ts` |
| C-60 | **행이 늘어난 시체 창에 스크롤이 없다** — 사망 목록이 기본 격자를 넘으면 `fitCorpseGrid` 가 행을 늘리는데 컨테이너 패널이 스크롤되지 않아 작은 화면에서 넘친다 (드묾) | `src/inventory/parts/CorpseLoot.ts`, 컨테이너 패널 |
| C-61 | **가방 레이드 소모의 1회 표시(`bagWornThisRaid`)가 메모리에만 있다** — 사망으로 깎인 뒤 새로고침 → 레이드 복귀 → 자기 가방을 되찾아 탈출하면 한 번 더 깎일 수 있다 | `src/inventory/parts/Durability.ts` |
| C-62 | **로든 판정의 남은 틈** — 근접(`weapons/Melee` 원뿔)은 여전히 서 있는 몸 기준이고, 소염기 매몰은 **발사 순간에만** 판정하므로 막힌 자리에서 반짝임을 다시 시작할 수 있다 (자리 이동은 넣지 않았다) | `src/weapons/Melee.ts`, `src/enemies/ai/named/Sniper.ts` |
| C-63 | **전차 탑승의 남은 틈** — 적은 하차 관성이 없고, 리플리카 탑승 예측은 `차량 속도 × 보간 지연` 선형이라 가속 · 제동 순간에 조금 어긋난다. 원격 클라이언트는 사망 와이어 좌표로 시체의 탑승을 찾으므로 **전차 후미 끝**에서 죽은 시체는 약 1 m 지연 때문에 전차를 놓칠 수 있다. 적이 데크보다 0.35 m 낮은 **선로 발판** 위에 서 있으면 탑승 창 안이라 치이지 않는다 | `src/enemies/ai/Ride.ts`, `src/game/Corpses.ts`, `src/world/rails/parts/Tram.ts` |
| C-64 | **`Store.close()` 의 동기 쓰기와 진행 중인 비동기 rename 사이에 1 syscall 창이 남는다** — 세대 번호로 물러나게 했지만 이론상 종료 순간에만 해당 | `server/Store.ts` |
| C-65 | **vite HMR 소켓을 막지 않는 스모크는 다른 편집의 저장으로 페이지가 새로고침돼 아무 시점에나 깨진다** (`Execution context was destroyed` · `timeout waiting for boot`). 병렬 에이전트 작업에서 반복 관찰 — smoke-tactical · smoke-lights 처럼 `vite-hmr` 를 막는 하네스를 공용으로 | `scripts/smoke-*.mjs` |
| C-67 | **`/__scav/relay` 문자열이 `ui/menus/SettingsMenu` 의 `SHELL_RELAY_ROUTE` 에 따로 적혀 있다** — 원본은 `shared/net.NET_SHELL_RELAY_ROUTE`(2026-09-11), `electron/main.ts` · `net/parts/Socket` 은 이미 그것을 쓴다 | `src/ui/menus/SettingsMenu.ts` |
| C-68 | **`net:selftest` 의 `debounced write happened once`(part 7) 가 부하 중에 가끔 빨갛다** — 80 ms sleep 안에 fsync 가 끝나지 않는 타이밍 단언. 2026-09-11 병렬 에이전트 7개 동안 여러 번 관찰, 단독 재실행은 green | `server/selftest.ts` part 7 |
| C-69 | **프로필 리비전 전환 직후 1회 경고** — 리비전을 한 번도 본 적 없는 클라이언트(base 0)가 새 릴레이에 처음 붙으면, 그 전에 쌓인 대기 편집이 rev 1 로 시드된 문서와 충돌해 서버 사본이 이기고 경고가 뜬다. 같은 슬롯 두 탭은 쓰기 큐 키를 같이 쓴다(서버 중복 접속 차단과 겹치는 드문 경우) | `src/net/ProfileSync.ts`, `server/Store.ts` |
| C-66 | **월드 생성은 여전히 동기 약 230 ms 이고 대부분이 `noise2`(생성당 약 100 ms)** 다 (2026-09-11 C-40 에서 319 → 230 ms, 같은 시드 결과 바이트 동일). 더 줄이려면 잡음 수학이나 비동기 생성 계약을 바꿔야 한다 | `src/world/noise.ts`, `src/world/Terrain.ts` |

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
| D-9 | **드론 · 원격 지뢰 · 네임드 수치 전부 1차값** (2026-09-11) — 드론 사거리 70/90 m · 체력 30/10 · 질주 소음 35 m, 원격 지뢰 260 / 6 m · 중첩 50 %, 네임드 확률 4–35 % · 로든 150 · 헤비 6 × 12발/s · 타길라 초당 50 · 스캔 음파 5회 / 38 m | `data/constants.csv` · `data/enemy_abilities.csv` · `data/tables.csv` |
| D-10 | **네임드 확정 드롭이 행성 등급 곡선을 무시한다** — 난이도 1–2 행성에서도 III+ 저격소총 · 방탄복 · 유니크 미니건이 나온다(사용자 명세 "최소 희귀부터" 를 글자대로). 초반 행성 경제가 흔들리면 `data/loot_named.csv` 에 행성 등급 상한 열을 더한다 | `data/loot_named.csv`, `src/items/Loot.ts` `rollNamedDrop` |
| D-11 | **C 배치(2026-09-11) 수치 전부 1차값** — 재해가 적에게 주는 조용한 피해 `HAZARD_ENEMY_DPS` 2(강제 탈출 압박이 줄지 않게 낮게), 고철 부가 코어 `GATHER_SALVAGE_CORE_CHANCE` 15 %(코어 공급이 늘어 정제 관문이 약해진다), 가방 `durabilityMax` 100 · `BAG_DURABILITY_PER_RAID` 10, 상위재 상자 비율 T3–5 = 5 · 10 · 15 %, 곡사포 `ARTILLERY_AI.maxRefusals` 3 · `refusalCooldown` 8(막힌 자리 대기가 줄어 실발사 빈도가 오를 수 있다), 벌레 산성이 로그에게 직격 18 · 스플래시 10(예전 0 — 버그 ↔ 로그 교전 균형이 바뀐다), 발소리 재질 배수 `FOOTSTEP_MATERIAL_GAIN` | `data/constants.csv`, `data/bags.csv`, `data/loot_item_weights.csv`, `data/enemy_abilities.csv`, `data/tables.csv` |

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
- **가구는 제작으로만 얻는다** — 상점 구매 · 루팅 가구는 넣지 않기로 했다 (2026-09-11 사용자 결정, 옛 A-4).
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
