# 키 바인딩 · 입력 계약

[CLAUDE.md](../CLAUDE.md) 에서 분리했다.
구현: [src/shared/constants.ts](../src/shared/constants.ts) (`Keys`) · [src/shared/Keybinds.ts](../src/shared/Keybinds.ts) ·
[src/ui/menus/KeybindMenu.ts](../src/ui/menus/KeybindMenu.ts) · [src/ui/menus/ControlsPanel.ts](../src/ui/menus/ControlsPanel.ts)

---

## 1. 규칙

- 키는 **가변 `Keys` 테이블**에 있다 (`DEFAULT_KEYS` = 공장 초기값, `MouseButtons` 는 `Keys.FIRE / AIM / PING` 에서 파생).
- `Keybinds.ts` 가 플레이어의 리바인딩을 localStorage `scav.keybinds` 에 저장하고 (`loadKeybinds()` 는 `main.ts` 에서 한 번),
  액션 목록(`KEY_ACTION_DEFS`: 라벨 · 그룹 · 범위 · 마우스 전용)과 충돌 검사, 표시 이름(`keyLabel`)을 갖는다.
- **`Keys.X` 는 항상 사용 시점에 읽는다** — 키나 그 라벨을 모듈 상수로 캐시하지 않는다.
  표시 중인 라벨은 `input:bindingsChanged` 에서 갱신한다.
- `scav.keybinds` 는 **기본값이 아닌 항목만** 저장한다. 그래서 기존 세이브도 새 기본 레이아웃을 그대로 받는다.
- `KEY_IMPLANT` / `KEY_MELEE` / `KEY_THROW_MODE` 는 deprecated 된 기본값 상수다.
- `MENU`(Esc)는 고정이고 리바인딩할 수 없다. 게임패드는 미지원.

## 2. 기본 레이아웃

| 키 | 동작 | 비고 |
|---|---|---|
| `W A S D` | 이동 | |
| `Shift` | 달리기 | 스태미나 소모 |
| `C` / `Z` | 앉기 / 엎드리기 | 함선에서는 엎드리기 불가 |
| **`V`** | **구르기** | 2026-09-07 에 Alt 에서 옮겨 왔다. 함선 · 실내 · 무게 `무거움` 이상에서는 거부 |
| `1` / `2` / `3` | 주무기 I / 주무기 II / 보조무기 | 교체 0.4 s (보조무기 0.1 s) |
| `Q` | **전술 임플란트** | 임플란트마다 즉발 / 홀드 / 손에 들기 — 장착은 Tab 함선 화면 |
| `F` | 근접 공격 | 전투불능 아군이 `PLAYER_CARRY_RANGE` 안이면 **탭 = 들쳐메기 / 내려놓기** (E 홀드 구조는 그대로) |
| `T` | 빠른 사용 | 탭 = 손에 든 아이템, 홀드 = 8방향 휠 (가젯 포함) |
| `E` | 상호작용 | 탭 / 홀드 |
| `R` | 재장전 · 수류탄 핀 뽑기(쿠킹) | |
| `G` | 함선 호출 휠 | |
| `M` | 전술 지도 | `isGameplayActive()` 필요. M 또는 **Tab** 으로 닫는다 (2026-09-09) |
| **`Alt`** | **마우스 커서 표시 / 숨기기** | 화면 없이 커서만 푼다. 캔버스 좌클릭 · Escape 로도 닫힌다 |
| `Tab` | 인벤토리 (함선에서는 4탭 화면) · **열린 화면 닫기** | 2026-09-09: 어떤 화면 · 모드가 열려 있든 Tab 은 그것을 닫는다 (지도 · 채팅 · 커뮤니티 · 터미널 · 작업대 · 시설 관리). 닫은 화면이 Tab 을 consume 하므로 같은 누름으로 인벤토리가 열리지 않는다. 우하단 **키 가이드** (`ui/hud/KeyGuide`) 가 열린 화면의 키와 `Tab 닫기` 를 한 줄로 보여 준다 (일시정지 메뉴 · 채팅 입력 중에는 숨김) |
| `X` | 아이템 버리기 | 인벤토리가 열려 있을 때 |
| `Space` | 포기(전투불능) / 부활(사망) | |
| `Enter` | 채팅 | 2026-09-09: Enter 는 **보내고 입력창을 유지**한다 (빈 Enter 는 무시). 닫기는 **Tab / Esc** — 입력창 오른쪽 끝의 `Tab 키로 닫기` 힌트가 그 키를 가리킨다. Esc 는 빈 귓속말 입력에서 대상만 먼저 해제한다 |
| `Esc` | 일시정지 메뉴 | 다른 화면이 열려 있으면 그 화면이 먼저 닫힌다 |
| 좌클릭 | 발사 · 사용 · 수류탄 들기 | **회복 소모품은 아이템별 시간만큼 홀드** (크로스헤어 링) |
| 우클릭 | 조준(ADS) | 손에 든 가젯 · 수류탄은 언더핸드 토글, 유니크 무기는 **보조 발사**(활 제외, ADS 없음) |
| 휠클릭 | 핑 | 홀드 + 드래그로 주의 / 돌격 / 탄약 요청. 지도 위에서도 놓을 수 있다 |

### 개발자 전용 (dev 호스트에서만)

| 키 | 동작 |
|---|---|
| `` ` `` (`Keys.CONSOLE`) | 개발자 콘솔 |
| `Home` (`Keys.MOVE_CHEAT`) | `/movecheat 1` 인 동안 시선 방향 고속 이동 |

### 시설 관리 (하우징) 모드

좌클릭 설치 · `R` 회전 · `X` 회수 · 휠 선택 · `C` / `Esc` 취소 · `M` / `Tab` 종료. 키 목록은 하단 중앙 바 대신
우하단 **키 가이드**가 보여 준다 (hub/HousingMode 가 `ui:keyGuide {owner:'housing'}` 를 내고 `ui/hud/KeyGuide` 가
`Tab 닫기` 를 붙여 그린다 — 2026-09-09).

## 3. 폴더 사이의 책임

- **무기 폴더가 근접 키를 소유**하지만, 실제로 휘두르는 것은 `ctx.player.startMelee()` 가 수락했을 때뿐이다
  (스태미나 · 쿨다운 · 포즈는 `src/player/` 의 것).
- 엎드리기와 구르기는 함선에서 비활성이고, 핑과 지도는 `isGameplayActive()` 를 요구한다.
- 미션 시드는 **오직 `/seed` 콘솔 명령**으로만 정한다 (터미널의 시드 입력란은 없어졌다).

## 4. 커서와 포인터 락 (2026-09-07 rework)

커서를 쓰는 화면은 포인터 락을 **놓고** 진짜 OS 커서를 쓴다 — 그 커서는
[`ui/hud/GameCursor`](../src/ui/hud/GameCursor.ts) 가 절차 생성한 CSS 커서 아트로 다시 칠해진다.

**락이 없다는 것만으로는 일시정지가 아니다.** 일시정지는 창 포커스를 잃었을 때뿐이다.
락을 되찾는 경로는 세 가지다 — 마지막 커서 소유자가 사라질 때 `main.ts` 의 재요청, 거부된 요청의
다음 진짜 제스처 재시도(`Input.awaitingLockGesture`), 그리고 **캔버스 좌클릭**(그 클릭은 삼켜지므로
카메라를 되찾는 클릭이 총을 쏘지 않는다).

전체화면에서는 `navigator.keyboard.lock(['Escape'])` 로 Escape 가 락을 깨지 않는다. 창 모드 Chrome 은
Escape 에 사용자 활성화를 주지 않으므로 Escape 로 화면을 닫으면 커서가 다음 입력까지 남고, 재잠금이
거부되면 게임이 **`좌측 클릭으로 게임 재개`** 게이트를 띄운다 (Phase 12, `src/game/ResumeGate.ts`).

UI blocker 토큰과 커서 모드의 전체 규약은 [ARCHITECTURE.md](ARCHITECTURE.md) 3절에 있다.
