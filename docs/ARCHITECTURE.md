# 시스템 아키텍처 · 미션 플로우

[CLAUDE.md](../CLAUDE.md) 에서 분리했다. 폴더별 상세는 각 폴더의 `README.md` 에 있다.

---

## 1. 시스템 수명주기

```ts
interface GameSystem { name; init(ctx); update(dt, ctx); lateUpdate?(dt, ctx); dispose?() }
```

폴더 간 통신은 **`ctx.bus` 이벤트**(비동기 알림)와 **`ctx` 의 `*Ref` 인터페이스**(동기 질의) 둘뿐이다.
다른 기능 폴더의 내부를 import 하지 않는다 — `@/shared` 만.

### 등록 · 업데이트 순서 (`main.ts`)

```
NetSystem → ProgressionSystem → HousingSystem → WorldSystem → HubSystem → PlayerSystem →
RemotePlayerSystem → ImplantSystem → WeaponSystem → EnemySystem → InventorySystem → MetaSystem →
GadgetSystem → PickupSystem → StratagemSystem → ExtractionSystem → HudSystem → AudioSystem →
GameFlowSystem → TutorialSystem → ConsoleSystem
```

이 순서에는 이유가 있다:

| 위치 | 왜 |
|---|---|
| `NetSystem` 첫 번째 | 아무도 `ctx.net` 을 읽기 전에 이번 프레임의 스냅샷이 적용돼 있어야 한다 |
| `ProgressionSystem` 두 번째 | 거의 모든 시스템이 `ctx.progression.derived` 를 읽는다 |
| `HousingSystem` → 허브 · 인벤토리보다 앞 | 허브가 함선 상태로 내부를 짓고, 인벤토리가 창고 크기를 읽는다 |
| `ImplantSystem` → `WeaponSystem` 앞 | 같은 프레임의 `blocksWeapons` 가 최신이어야 총이 홀스터된다 |
| `GadgetSystem` → `InventorySystem` 뒤 | `use()` 가 아이템을 소모할 수 있어야 한다 |
| `TutorialSystem` → 지켜보는 시스템들 뒤, 콘솔 앞 | 진행을 이벤트로만 판단하므로 순서에 민감하지 않지만, `init` 에서 `ctx.console` 에 `tutorial` 명령을 붙인다 |
| `ConsoleSystem` 마지막 | 치트가 그 프레임의 최종 상태를 본다. dev 호스트가 아니면 아예 동작하지 않는다 |

> **주의**: `WorldSystem` 은 자기 `game:newMission` 핸들러 **안에서 동기적으로** 월드를 생성하므로,
> `world:ready` 는 뒤에 등록된 시스템들의 `game:newMission` 핸들러보다 **먼저** 발생한다.
> 그래서 `world:ready` 에서 무조건 `reset()` 하면 안 된다 — `ctx.world.seed` 를 확인한다.

## 2. 게임 루프 (플레이어 관점, 목표)

게임 시작 → 개인 함선 → 컴퓨터(기업 접촉 · 계약 · 퀘스트) → 공유 함선 호출(큐) → 매칭 → 목표 행성 설정 →
로드아웃 → 준비 → 행성 도착 → 레이드 → 탈출구에서 함선 호출 → 60 초 디펜스 → 탈출 →
정산(경험치 · 계약) → 공유 함선 → 컴퓨터(퀘스트 완료).

## 3. 미션 플로우 (이벤트)

1. `GameFlowSystem` 이 `game:newMission {seed}` 발행 → `WorldSystem` 이 **동기 생성** 후 `world:ready {seed, playerSpawn}`.
2. `world:ready` 에서: 플레이어가 스폰 지점에 강하, 적 리셋 + 앰비언트 스폰 시작,
   인벤토리가 (아무 것도 없을 때만) 최소 킷을 주고 `loadout:changed`,
   탈출 시스템이 `ctx.world.getExtractionPoints()` 에 콘솔을 세운다.
3. 플레이어가 패드 스위치를 누름 → `extraction:activated` → 적의 탈출 웨이브 시작, HUD 카운트다운, 매 프레임 `extraction:tick`.
4. 카운트다운 종료 → `extraction:shipIncoming` → 착륙 → `extraction:shipLanded`; 탑승하면 `extraction:boarded`.
5. 함선 스위치 → `extraction:liftoff` → 문이 닫히고 상승 → `game:complete {stats}`.
6. `player:died` → `game:over {stats}`. 결과 화면이 `hub:enter {ship}` 발행 →
   `HubSystem` 이 (미션 / 결과 페이즈였다면) 먼저 `game:abort` 를 내고 함선을 지은 뒤
   `player.setInterior(collider)` + `spawnStanding`, `setPhase('hub')`, `hub:entered`.
   `game:newMission` 은 허브를 허문다 (`hub:left`). **허브에서는 `ctx.world` 가 null 이다.**

## 4. 입력 게이트 · UI blocker · 커서 규약

- `ctx.isGameplayActive()` — 무기 · 핑 · 지도 · 수류탄의 게이트.
- `ctx.isControlActive()` — 이동 · 자세 · 상호작용 · 카메라의 게이트 (게임플레이 **또는** `hub` 페이즈, blocker 없음).

**UI blocker 토큰**: `menu` · `inventory` · `map` · `chat` · `hub`(터미널) · `ready`(발사 준비 패널 —
허브의 하차 경로는 이 토큰 하나만 무시한다) · `cursor`(Alt 커서) · `housing` · `shipmanage` ·
`COMMUNITY_BLOCKER` · `RESUME_GATE_BLOCKER`.

### 커서 = 포인터 락 해제 (2026-09-07 rework)

UI 화면은 자기 토큰을 추가하고 `ctx.input.setCursorMode(true, TOKEN)` 를 부른다.
그것이 **포인터 락을 놓는다** — 그래서 진짜 OS 커서가 돌아오고, `ui/hud/GameCursor` 가 그 커서를
절차 생성한 CSS 커서 아트로 다시 칠한다. `setCursorMode` 는 토큰별 ref-count 다.

- 화면은 **스스로 `exitPointerLock()` 하지 않고**(`setCursorMode` 가 한다) **스스로 재잠금하지도 않는다**(`main.ts` 가 한다).
- 일시정지 메뉴(`menu`)도 예외가 아니다 — `ui/menus/MenuBase` 가 같은 토큰을 쓴다.
- 커서 모드 **밖에서** 락을 잃는 것(Chrome 이 돌려주지 않는 Escape, 알트탭 복귀)은 그냥 커서가 보이는 상태다.
  게임은 계속 돌고, `Input` 이 다음 진짜 제스처에서 락을 재시도하며, 캔버스 좌클릭이 폴백이다.
  **창 포커스를 잃었을 때만 일시정지된다.**

### ESC 닫기 스택 (2026-09-09)

blocker 토큰과 짝을 이루는 두 번째 등록부다. 화면은 `uiBlockers.add(TOKEN)` **옆에서**
`ctx.escape.push(TOKEN, () => this.close())` 하고, `delete` 옆에서 `ctx.escape.remove(TOKEN)` 한다
(`shared/escape` 의 `EscapeStack`). Escape 한 번은 **열린 순서의 역순으로 맨 위 하나**를 닫고, 스택이 비어
있을 때만 일시정지 메뉴가 열린다 — 정책은 `game/parts/Phases.escapeKey` 한 곳이다.

- 순서를 `shared` 가 아는 이유: Tab 공용 닫기처럼 화면마다 키를 폴링하면 닫히는 순서가 **시스템 등록 순서**로
  정해져(`main.ts`), 위에 뜬 패널보다 아래 모드가 먼저 닫힌다.
- 한 토큰을 여럿이 나눠 쓰는 곳(`hub`)은 `'hub:terminal'` 처럼 자기 key 를 쓴다. 토큰이 아예 없는 팝업도
  자기 key 로 올릴 수 있다 (`'hub:crewLoadout'`).
- 가장 안쪽 팝업(수량 지정 · 우클릭 메뉴 · 경고 팝업 · 설정 · 키 바꾸기 · 채팅 · 콘솔)은 스택에 없다 —
  자기 **window capture** 핸들러에서 Escape 를 삼켜 `Input` 이 기록조차 못 하게 한다.
- 일시정지 메뉴 자신은 **데스크톱 앱에서만** Escape 로 닫힌다(`isDesktopShell()`, `ui/menus/PauseMenu`).
- 닫기 함수가 **`false`** 를 돌려주면 항목이 스택에 남는다 — 화면 안에서 한 걸음만 되돌린 경우
  (하우징 모드가 들고 있던 가구만 내려놓는 것처럼).

키 레이아웃과 커서의 자세한 사정은 [CONTROLS.md](CONTROLS.md).

## 5. `src/main.ts` — 부트스트랩

Engine 을 띄우고 시스템을 위 순서대로 등록한다. 그 외에 두 가지 일을 더 한다:

1. 커서의 `onModeChange` 를 버스의 `input:cursorModeChanged` 로 **중계**한다
   (`shared` 가 커서를 소유하지만 버스는 갖고 있지 않다).
2. 마지막 커서 소유자가 사라졌을 때 **포인터 락을 다시 요청하는 유일한 지점**이다.
   조건은 페이즈뿐이다(`isGameplayPhase()` 또는 `isHubPhase()`, 죽지 않았을 것) — blocker 검사는 없다.
   커서를 쓰는 화면은 전부 커서 모드 소유자이므로, **마지막 소유자가 사라졌다는 사실 자체가 조건**이다.
