# 정보상 · 발사 슬롯 UI · NPC 신뢰도 — 설계안 (2026-09-14)

> 이 문서는 **계약의 원본**이다. `src/shared/intel.ts` 와 이 문서가 다르면 코드가 맞다 —
> 다만 이름 · 필드 · 이벤트 · csv 열 이름을 바꿀 때는 **여기도 같이 고친다.**
> 병렬 작업자는 자기 폴더를 고치기 전에 이 문서의 §2 계약과 §5 담당 표를 먼저 읽는다.

---

## 1. 사용자 결정 (2026-09-14)

| 항목 | 결정 |
|---|---|
| 정보상 NPC | **레이븐 재사용**(`npc_raven`) — `reqLevel` 4 → **1**. 더불어 **모든 NPC 에 개인 신뢰도 신설**(기업과 별개, 같은 0–5 표), 모든 NPC 퀘스트에 그 NPC 신뢰도 보상 추가. **신뢰도별 해금 요소는 지금 정하지 않는다**(적립 · 표시까지만) |
| 멀티 권한 | **분대장만 구매 · 지불**. 분대원은 읽기 전용 (탐사 차량 요금의 「결제자 한 명」 규약과 같다) |
| 지역 재배치 | **전부 폐기 · 환불 없음**. 시드도 기믹 고정도 날아간다 |
| 정보 수명 | **프로필에 저장** — 새로고침 · 재접속을 견디고 그 행성으로 출격해 레이드가 끝나면 소모. 한 번에 **하나만** 보유 |
| 지도 미리보기 | **실제 레이아웃**(같은 시드로 `generateLayout` 만 돌린다 — 메시 없음)을 **격자로 흐릿하게**. 정확한 좌표는 안 보인다 |
| 네임드 지정 | **threat 2 이상 행성에서만** (threat 1 은 그 줄이 잠긴다) |
| 기본 행성 이동 | **무료 유지** — 정보만 유료 |
| 터미널 배치 | 행성 브리핑이 **중앙에서 넓게**, 우측 열 = 위에서부터 **정보상 패널 · 시뮬레이션 훈련장**, 매칭은 **우상단 버튼 → 팝업** |
| 발사 슬롯 패널 | **4칸 가로 유지 · 화면 세로 70 % 로 확대**. 카드 위 55 % 초상 · 아래 45 % 장비 |
| 캐릭터 방향 | 오른쪽 **앞**(카메라 쪽) |
| 준비 | 스페이스 **1초 홀드** → **전원 준비 시 자동 출격**. 다시 눌러 해제 가능 |
| 준비 중 로드아웃 | Tab 은 **열리되 읽기 전용**(드래그 · 장착 · 분해 전부 거절) |
| 출격 경고 | **홀드 완료 후 팝업 → 승인해야 준비** (탑승 시점에서 옮긴다) |
| 가치 표시 | 썸네일 **호버 툴팁** + 카드 하단 **착용 장비 가치 합계** |
| 체력 · 실드 ghost | **둘 다 연한 빨강** (실드 ghost 연출은 신규 구현) |
| 중앙 하단 키 가이드 | 인벤토리의 `.inv-hints` 를 **완전 제거**, 중복 아닌 항목만 우하단 KeyGuide 로 |

---

## 2. 계약 (리드가 이미 써 두었다 — 고치지 말고 쓴다)

### 2.1 `src/shared/intel.ts`

```ts
export type IntelGimmick = 'extraction' | 'basement' | 'hazardDelay' | 'rail' | 'rover' | 'named' | 'nest';
export interface IntelPick { g: IntelGimmick; tier: number; id?: string }   // id = named 전용 적 타입 id
export interface IntelSpec { planet: PlanetId; seed: number; picks: IntelPick[] }

export interface IntelEffects {          // 소비자는 전부 이것만 읽는다
  extractionBonus: number;               // 탈출 패드 +N
  basementBonus: number;                 // 지하실 있는 구조물 +N (연구실 · 전진기지)
  hazardDelayS: number;                  // 재해 시작 +N 초
  railPlatformBonus: number;             // > 0 이면 선로 확정 + 플랫폼 +N
  roverForce: boolean;                   // 탐사 차량 확정
  namedId: string | null;                // 지정 네임드 적 타입 id
  nestBonus: number;                     // 벌레 둥지 +N
}
export function resolveIntelEffects(picks: readonly IntelPick[] | null | undefined): IntelEffects;
export function intelCost(planetThreat: number, picks: readonly IntelPick[], t: IntelCostTable): number;
export function intelCode(picks: readonly IntelPick[]): string;     // 'x2b1h3' — 크레딧 사유에 실린다
export function parseIntelCode(code: string): IntelPick[] | null;   // 역파싱 (named id 는 복원되지 않는다 — 가격 무관)
export function sanitizeIntelSpec(raw: unknown): IntelSpec | null;
export const INTEL_GIMMICK_CODE: Record<IntelGimmick, string>;      // x b h r v n g
```

- **`ctx.missionIntel: IntelEffects | null`** — `ctx.missionPlanet` 과 **똑같은 규약**: `game:newMission` 을
  **emit 하기 전에** emitter 가 세팅한다. `world/` · `enemies/` 는 동기 핸들러 안에서 이것을 읽는다.
- 소비자는 `IntelPick[]` 를 직접 해석하지 않는다 — **반드시 `resolveIntelEffects`** 를 지난다.

### 2.2 이벤트 (`src/shared/events.ts`)

```
intel:changed    { spec: IntelSpec | null }   보유 정보가 바뀌었다 (구매 · 폐기 · 소모 · 서버 문서 로드)
intel:purchased  { spec: IntelSpec; cost: number }
```

### 2.3 `MetaRef.intel: IntelRef` (`src/shared/meta.ts`)

```ts
export interface IntelRef {
  get(): IntelSpec | null;                                   // 보유 정보
  costOf(planet: PlanetId, picks: readonly IntelPick[]): number;
  maxTierOf(g: IntelGimmick, planet: PlanetId): number;       // 0 = 이 행성에서 잠김 (named · threat 1)
  buy(planet: PlanetId, seed: number, picks: readonly IntelPick[]): IntelSpec | null;  // 크레딧 부족 · 비호스트면 null
  discard(): void;                                            // 지역 재배치 (환불 없음)
  consume(): void;                                            // 레이드가 썼다
  effects(): IntelEffects | null;                             // 보유 정보의 해석본
}
```

### 2.4 와이어 (`src/shared/net.ts`)

```ts
export interface IntelWire { seed: number; picks: IntelPick[] }
// LobbyState.intel?: IntelWire | null          — 분대원이 함선에서 미리 본다
// ClientToServer: { t: 'lobby:intel'; intel: IntelWire | null }   (호스트 전용)
// ClientToServer: { t: 'lobby:start'; …; intel?: IntelWire }
// ServerToClient: { t: 'game:start'; …; intel?: IntelWire }
```
서버는 **모양만 sanitize 하고 그대로 broadcast** 한다 (`planet` 과 같은 취급 — 레이아웃을 계산하지 않는다).

### 2.5 크레딧 사유 (`src/shared/credits.ts`)

```
intel:<planetId>:<code>      delta < 0, 정수, |delta| === intelCost(행성 threat, parseIntelCode(code), 표)
                             프로필당 시간당 CREDIT_INTEL_MAX_PER_HOUR 회. 환불 불가 (원장 debit 없음)
```
`EconomyTable.intel` 절이 `bundleMul` · `threatMul[]` · `tierMul[]` · `options{ baseCost, maxTier }` ·
`planetThreat{}` 를 들고, 릴레이가 **같은 `intelCost` 함수**로 검산한다.

### 2.6 비용 식 (단일 원본 = `intelCost`)

```
옵션 하나   = baseCost(gimmick) × tierMul[tier-1]
총합        = Σ 옵션
누진        = 총합 × bundleMul^(고정한 옵션 수 − 1)
행성        = × threatMul[threat-1]
최종        = Math.round(…)
```
수치는 전부 `data/intel_options.csv` · `data/tables.csv` 에 있고 **코드에 숫자를 적지 않는다.**

### 2.7 NPC 개인 신뢰도 (`src/shared/npc.ts` · `shared/meta.ts`)

```ts
// NpcSave 에 추가:  trust?: Record<string, number>      // npcId → 누적 신뢰도 점수 (레벨은 REP_TABLE 로 환산)
// NpcQuestDef.rewards 에 추가: npcTrust?: number         // data/npc_quests.csv 의 새 열 `npcTrust`
// MetaRef 에 추가:  npcTrust(npcId): number  ·  npcTrustLevel(npcId): number   (0–5, REP_TABLE 공용)
// NpcRequirement 에 추가: npcRep?: { npc: string; level: number }   // npcs.csv 의 새 열 `reqNpcRep` = "npcId:레벨"
```
지금은 **적립 · 표시까지만** 한다 — 신뢰도로 잠기는 것은 아직 없다(레이븐도 레벨 1부터 전부 열린다).

---

## 3. 기믹 고정이 월드에 닿는 지점

| 기믹 | 코드 | 닿는 곳 |
|---|---|---|
| 탈출 패드 +N | `x` | `world/layout.ts` `extractionPadCount` 결과에 더한다 (`WorldSystem.generate`) |
| 지하 시설 +N | `b` | `world/layout.ts` — **채를 N 개 더 세운다**(전진기지 `ceil(N/2)` · 연구실 `floor(N/2)`). 기존 채의 굴림을 덮는 방식은 자연 확률이 이미 높아(전진기지 0.65 · 연구실 0.5) 돈을 내고도 개수가 그대로인 시드가 **실측으로 나왔다**. ⚠ 연구실은 `basementChance = 0`(2층 잠긴 방으로 대체)이라 지하실을 억지로 파면 깊이 0 · 컨테이너 0 의 빈 구멍이 된다 — 그래서 연구실 몫은 **`floors = 2` 확정**이다. `structures.csv` 의 `maxCount` 를 넘어선다 (**사용자 결정 2026-09-14**: maxCount 는 자연 배치의 상한이지 정보상의 상한이 아니다) |
| 재해 지연 +N 초 | `h` | `world/hazard/parts/Plan.ts` `pickStartSeconds()` 결과에 더한다 (종류 · 전선 · 눈 중심 불변, 고정값 포자에도 적용) |
| 선로 + 플랫폼 +N | `r` | `world/layout.ts` — `rng.chance(RAIL_CHANCE)` draw 소비 후 결과를 true 로, `stopCount += N` |
| 탐사 차량 확정 | `v` | `world/layout.ts` 의 `rng.fork('rover')` — `ROVER_CHANCE` draw 소비 후 결과를 true 로 + `RoadPlan` 의 `forcePlan`(`ROVER_PLAN_ATTEMPTS_INTEL`). ⚠ **2026-09-14 실측**: 그 전까지 흙길 배치율이 **100 %** 라 이 줄은 아무것도 사지 못했다 — 사용자 결정으로 `ROVER_CHANCE`(자연 배치 확률)를 새로 넣어 줄이 값을 갖게 했다 |
| 네임드 지정 | `n` | `enemies/named/Director.ts` `roll()` — 등장 굴림 · 종류 굴림을 **소비한 뒤** 결과를 지정 id 로 덮는다 (자리 굴림 그대로). ⚠ 실제 타입 id 는 **`NAMED_ROGUE_TYPES` = `rogue_sniper`(로든) · `rogue_hammer`(타길라) · `rogue_heavy`(헤비)** — 이 문서 초안의 `rogue_roden` · `rogue_tagilla` 는 **존재하지 않는 이름이었다**. 한국어 이름은 `NAMED_ROGUE_NAME_KO`, 화면은 이 두 상수에서만 뽑는다 |
| 벌레 둥지 +N | `g` | `world/layout.ts` 둥지 수 결과에 더한다. 그 `rng.int(4, 6)` 은 **코드 하드코드였고** 이 배치에서 `data/tables.csv` 의 `NEST_COUNT_MIN` · `NEST_COUNT_MAX` 로 뺐다 |

⚠ **draw 를 건너뛰지 않는다.** 결과만 덮어쓴다.

다만 **실측으로 알게 된 한계가 있다** (2026-09-14, `scripts/smoke-intel.mjs`): 레이아웃은 **거절 표본 추출**이라
「그 기믹만 다르고 나머지는 바이트 동일」은 **원리적으로 불가능**하다 — 자리 하나가 바뀌면 그 뒤 배치 루프의
반복 수가 바뀐다. 지킬 수 있는 것은 **「그 기믹보다 앞에서 뽑힌 절은 한 글자도 안 바뀐다」** 이고 그것은 전부 통과한다.
그래서 **미리보기가 거짓말하지 않는 진짜 근거는 스트림 동일성이 아니라 「같은 함수 · 같은 입력」**이다 —
미리보기와 진짜 맵이 둘 다 `world/preview.planLayoutFor` 를 지난다. draw 소비 규칙은 그래도 지킨다
(정보를 안 산 절이 흔들리지 않아야 밸런스 검증이 가능하다).

### 3.1 미리보기 진입점 (2026-09-14 확정)

```ts
ctx.world.previewLayout?(seed, planet, intel?: IntelEffects | null): MapPreviewLayout   // src/shared/types.ts
```
레이드 밖(함선)에서도 부를 수 있다 — 씬도 지형도 만들지 않고 `WorldSystem` 상태를 건드리지 않는다.
`MapPreviewLayout` 은 평면 데이터라 THREE 도 `world/` 타입도 새지 않는다. 화면(`hub/ui/IntelMap.ts`)은
`mapSize` 로 정규화해 격자에 스냅한다.

---

## 4. 화면

### 4.1 터미널 재배치 (`hub/ui/HubMenu.ts` · `hub/hub.css`)
- `.hub-grid` 2열: **중앙(행성, 넓게)** · **우측(정보상 패널 → 시뮬레이션 훈련장)**. 좌측 열은 사라진다.
- 머리(`.hub-head`) **우상단에 `📡 매칭` 버튼** → 팝업 `.menu.hub-menu.hub-match` (`.hm-` 접두사)에
  기존 좌측 열 내용 전부(신호 찾기 · 코드 도킹 · 신호 송출 · 공유 함선 코드 · 승무원 · 도킹 해제)를 옮긴다.
- 우측 정보상 패널 `.hub-intel`(`.hi-` 접두사): 보유 정보가 있으면 요약 + `지역 재배치`,
  없으면 `정보 구매` 버튼 (비호스트는 딤드 + 사유).

### 4.2 정보상 화면 (`hub/ui/IntelMenu.ts` · 새 파일 `src/hub/intel.css`, 접두사 `.it-`)
- 좌 = 행성 지도 격자(`hub/ui/IntelMap.ts` — `generateLayout` 결과를 캔버스에 흐릿한 격자로).
- 우 = 기믹 7줄, 줄마다 단계 `◀ 0 / 1 / 2 ▶`. 잠긴 줄은 딤드 + 사유.
- 우하단 = **총 크레딧 비용 큰 폰트**, 그 아래 왼쪽 `취소` · 오른쪽 `확정`(**1초 홀드**, `UI_HOLD_CONFIRM_S`).
- 확정 → 결제 → **행성 락온 연출**(홀로그램이 돌다가 한 좌표에 락온, `PlanetHologram` 확장) → 우측 패널에 지도.
- 확정 화면 우상단 `지역 재배치` → 경고 팝업 + **1초 홀드** → `discard()` + 시드 재굴림.

### 4.3 발사 슬롯 패널 (`hub/ui/ReadyPanel.ts` · `player/Portraits.ts`)
- `.hub-ready` 를 화면 중앙 **세로 70 %** 로. 4칸 가로 · `gap: 0` · 균등 4열 유지
  (초상 캔버스 뷰포트가 그 가정을 쓴다 — `player/Portraits.ts:141-174`).
- 초상 yaw: `HUB_READY_PORTRAIT_YAW` 를 **오른쪽 앞**으로 (`data/constants.csv`).
- 카드 하단 장비 줄: 주무기 I · II(소켓 핍 포함) · 가방 · 방탄복 · 전술 임플란트 썸네일 +
  **착용 장비 가치 합계** 한 줄. 호버 = 기존 아이템 툴팁.
- 준비: `Keys` 의 점프(스페이스)를 포드 안에서 가로채 **1초 홀드**(`ui:cursorHold` 링 재사용 불가 —
  크로스헤어 홀드 링 `ui/hud/HoldGauge` 쪽이 아니라 카드 하단 자체 게이지). 홀드 완료 → 경고 팝업 →
  승인 시 `net.setReady(true)`. 준비 전 **내 카드**가 강한 하이라이트.

---

## 5. 담당 분할 (같은 트리 병렬 · 파일이 겹치지 않게)

| 에이전트 | 폴더 · 파일 |
|---|---|
| **A 발사 슬롯** | `src/hub/ui/ReadyPanel.ts` · `src/hub/ui/LaunchWarnPanel.ts` · `src/hub/parts/Pods.ts` · `src/player/Portraits.ts` · `src/hub/hub.css` 의 **`.hub-ready` / `.hr-` / `.hcl-` 블록만** · `src/inventory/InventorySystem.ts`(읽기 전용 게이트) · `data/constants.csv` |
| **B HUD · 인벤토리 소소** | `src/ui/hud/Vitals.ts` · `src/ui/styles/base.css` · `src/inventory/ui/InventoryUI.ts` · `src/inventory/inventory.css` · `src/inventory/parts/DropResolver.ts` · `src/inventory/ui/parts/Drag.ts` · `src/ui/hud/KeyGuide.ts` |
| **C NPC 신뢰도** | `src/meta/NpcRules.ts` · `src/meta/parts/Npc*.ts` · `src/ui/menus/messenger/**` · `data/npcs.csv` · `data/npc_quests.csv` |
| **D 정보상 엔진** | `src/meta/parts/Intel.ts`(신규) · `src/meta/MetaSystem.ts` · `src/net/parts/Lobby.ts` · `src/hub/parts/Pods.ts` 의 **`launch()` 한 곳만** · `src/world/**` · `src/enemies/named/Director.ts` · `server/**` · `scripts/economy-table.mjs` · `data/intel_options.csv`(신규) · `data/tables.csv` |
| **E 정보상 화면** | `src/hub/ui/HubMenu.ts` · `src/hub/ui/IntelMenu.ts`(신규) · `src/hub/ui/IntelMap.ts`(신규) · `src/hub/ui/PlanetHologram.ts` · `src/hub/intel.css`(신규) · `src/hub/hub.css` 의 **`.hub-grid` / `.hub-col` / `.hub-head` 블록만** · `src/hub/HubSystem.ts` |

- `src/shared/**` 는 **리드가 이미 다 썼다** — 에이전트는 읽기만 한다. 정말 필요하면 리드에게 보고한다.
- `hub.css` · `HubSystem.ts` · `Pods.ts` 는 A · D · E 가 나눠 쓴다 — **`Write` 로 통째 덮지 말고 `Edit` 만** 쓴다.
