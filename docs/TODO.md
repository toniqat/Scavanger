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
| E-14 | **`smoke-allies-orders` 의 「지시한 일을 끝낸다」가 빨간채로 재현된다 (2026-09-20)** — 안드로이드가 `state: "pickup"` · `task: "item"` 으로 (174, −243) 에 서서 가방에 6종을 담은 채로 끝나지 않는다. 연속 3회 똑같은 상태로 빨간이고, **부모 커밋(`aa04107`)에서도 항목 · 좌표까지 동일하게 빨간다** — 그날의 변경과 무관하다. 같은 날 4레인 전체 실행 두 번에서는 초록이었으니 시드/타이밍에 걸린 것이고, 단독 실행에서 경지는 쪽이 고정되어 있다 — 재현이 쉬우니 그쪽부터 볼 것 | `scripts/smoke-allies-orders.mjs` 「지시한 일」 구간 · `src/allies/parts/` 의 `pickup` 상태 |
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
| B-63 | **발사음 id 표가 두 폴더에 갈라져 있고 답이 다르다 — 유니크 무기를 든 안드로이드가 지금도 소총 소리를 낸다.** `weapons/WeaponDefaults.shotSoundId` 는 `WeaponKind` 로 분기해 유니크까지 덮지만(화염방사기·쇼크건 `shot_energy`, 활·수리검 `melee_swing`, 바주카 `shot_shotgun`), `player/AllyAvatars.allyShotSound` 는 `WeaponDef`(`ammoType`·`pellets`·클래스)로 다시 판정해 유니크를 전혀 모르고 전부 `shot_rifle` 로 떨어진다. 폴더 내부를 import 할 수 없어(§4.1) 베낀 것이고, 그 주석 자신이 「`shared` 로 올리는 것이 TODO 후보」라 적는다. `src/shared` 에 id 표 하나를 두고 두 폴더가 읽게 하면 된다 (2026-09-19 `src/player` 감사가 찾았다) | `src/weapons/WeaponDefaults.ts` · `src/player/AllyAvatars.ts` |
| B-64 | **`RemotePlayerSystem.updateCarries` 의 업힘 해제가 아바타가 사라지면 안 돌아가는 구멍.** `:725` 의 `this.allies?.has(this.myCarrier)` 는 「그 아바타가 아직 존재할 때만」 풀어주는데, 아바타 자체가 사라지면 `has` 가 false 라 해제되지 않는다 — `localId` 가 없는 솔로(= `ALLY_LOCAL_PEER`) 경로는 아래 피어 경로가 `if (!localId) return;` 로 빠져나가므로 아무도 풀어주지 않는다. `README.md` 의 「The body stops carrying us, **or its avatar disappears**」 는 이 경우 거짓이다. 레이드 종료·`game:abort` 가 `clearCarry` 로 먼저 정리해서 오늘은 잠복이다. `has()` 가 「myCarrier 가 안드로이드인가 피어인가」를 가르는 유일한 식별자라 그냥 무조건 해제하면 피어 업힐이 깨진다 — 「안드로이드 carrier 인가」를 별도 플래그로 드는 설계 결정이 필요하다 | `src/player/RemotePlayerSystem.ts` · `src/player/README.md` |
| B-65 | **주석 영문화가 `*.css` 를 통째로 건너뛰었다.** §4.1 패스가 `.ts` 만 훑어 `src/tutorial/tutorial.css:130-131`·`:140` · `src/ui/styles/buffs.css:91-93` 같은 한글 주석이 그대로 남았다 (2026-09-19 `src/tutorial`·`src/ui` 감사가 각각 따로 발견). 폴더별로 몇 줄인지 세고 `docs/COMMENT_I18N_PLAN.md` 큐에 넣을지 정해야 한다 — 양이 적으면 큐 없이 한 번에 턴다 | `src/*/**.css` · `docs/COMMENT_I18N_PLAN.md` |
| B-66 | **죽은 CSS · 검증 안 된 수치 주석 3건** (2026-09-19 감사가 범위 밖으로 남긴 것들). `src/ui/styles/base.css:1483-1487` 의 `.oarrow.grenade*` · `.oarrow.call*`(`airstrike` 포함)은 2026-09-10 에 `DangerIndicators` 로 간 뒤로 붙는 곳이 없다 · `src/hub/interiors/SharedShip.ts:30` 의 「데크 조명 6 + 격납고 9」는 개인 함선 쪽이 상해 있었던 것을 보면 의심스럽고 아무도 세어보지 않았다 · `src/hub/interiors/FurnitureLeisure.ts` 의 `3 × 5 · 1.6`(`bench_rack`) · `3 × 1 · 1.8`(`disc_stand`) 는 B-43 과 같은 csv 발자국 수치 복사인데 목록에 없어 남았다 | `src/ui/styles/base.css` · `src/hub/interiors/` |
| B-67 | **`items/Salvage.DURABILITY_BUCKET_LABELS` 가 버킷 폭 20 을 코드에 박아 둔다.** `i * 20 + 1` 로 라벨을 만들어, 배율 리스트(`DURABILITY_BUCKETS`) 길이가 5 가 아니게 되면 라벨이 조용히 틀어진다. CLAUDE.md §4.1 「수치를 코드에 적지 않는다」의 진짜 위반은 산문이 아니라 여기다 — `100 / DURABILITY_BUCKETS.length` 로 유도하면 끝난다. 2026-09-19 B-52 가 같은 파일의 주석 수치를 턴 때 코드라서 남겨 두었다 | `src/items/Salvage.ts` |
| B-68 | **CSS 애니메이션 재시작 관용구(`classList.remove(c)` → `void el.offsetWidth` → `add(c)`)가 프레임 안에서 UI 전체 레이아웃을 강제한다 — 13곳.** 2026-09-20 에 `ui/dom.restartAnim`(도는 애니메이션을 `currentTime = 0` 으로 되감기)으로 한 번 쓸었다가 **같은 날 되돌렸다**: ① `fill` 없이 끝난 애니메이션은 `getAnimations()` 에서 빠져 되감을 대상이 없고(`ammoFlash` · `stamPulse` · `contractPulse`), ② 애니메이션이 **자식**에 걸린 곳(`.imp-hud.rdy-major .imp-ring` · `.scall.rdy-major .sc-ring` · `.stamina.depleted … .fill`)은 `root.getAnimations()` 가 애초에 빈 배열이라 첫 재생 뒤로는 아무 일도 안 일어났다. `{subtree:true}` 로 넓히면 같은 자식의 **무관한** 애니메이션까지 되감는다. 같은 태스크 안의 remove/add 는 (rAF 를 한 번 끼워도) 합쳐져서 재시작이 안 되고, 플러시를 스타일로 바꿔도 싸지지 않는다 — 더러워진 레이드 프레임에서 `getComputedStyle(...).animationName` 1.5~2.1 ms 대 `clientWidth` 0.9~1.9 ms (측정 2026-09-20). **남은 길은 하나뿐이라 결정이 필요하다**: 각 애니메이션마다 이름만 다른 `@keyframes` 쌍을 만들고 두 클래스를 번갈아 붙이면 읽기 없이 동기 재시작이 된다(= CSS 중복 13곳) — 할 것인가, 아니면 플래시가 뜨는 프레임의 1~2 ms 를 받아들이고 둘 것인가. 현재는 `scripts/smoke-layout-reads.mjs` 의 `KNOWN_IDIOM` 에 13개 파일이 **래칫**(줄어들 수만 있고 늘 수 없다)으로 박혀 있다 | `src/ui/hud/Reticle.ts` · `DamageOverlay.ts` · `WeaponPanel.ts` · `Vitals.ts` · `ImplantWidget.ts` · `StratagemPanel.ts` 외 7곳 · `scripts/smoke-layout-reads.mjs` `KNOWN_IDIOM` |
| B-69 | **`src/ui` 밖의 DOM 화면도 같은 관용구를 쓰는데 `restartAnim` 을 빌려 쓸 수 없다.** `src/housing/ui/` (`CookScreen` · `CookViews` · `CultureTank` · `GymViews` · `Panel`) · `src/hub/ui/` (`HubMenu` · `LaunchWarnPanel` · `MatchTab` · `SquadDockCountdown`) · `src/inventory/ui/CatalogView` 에 `void …offsetWidth` 가 10곳 더 있다. §4.1 상 그 폴더들은 `@/ui/dom` 을 import 할 수 없으므로, B-68 의 답이 헬퍼 형태라면 **`src/shared` 로 올릴지**가 같이 결정돼야 한다. 이쪽은 전부 메뉴·화면이라 프레임 밖에서 돌고(그래서 스모크가 못 본다) 급하지 않다 — B-68 과 **한 번에** 처리할 것 | `src/housing/ui/` · `src/hub/ui/` · `src/inventory/ui/CatalogView.ts` |

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
