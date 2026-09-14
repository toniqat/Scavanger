# 2026-09-14 3차 묶음 — 퀘스트 대화 · 튜토리얼 레이드 개편 · UI

사용자 결정 원본. 구현 중 이 문서와 코드가 어긋나면 **이 문서가 맞다**.

## 0. 확정한 것 (AskUserQuestion)

| 질문 | 결정 |
|---|---|
| NPC 대화 흐름 개편 범위 | **첫 연락만, NPC 10명 전부.** 짧은 인사 1–3마디 → PC 선택지 → 본론(`introAfter`) → 퀘스트 카드. 2번째 퀘스트부터는 지금처럼 `offer` 대사 → 카드 |
| 퀘스트 목록 | **`active` + `complete` 만.** `offered` 는 내부 상태로만 남아 대화창 카드로 뜬다. `deferred` · `defer()` · `decline`/`brief` 대사는 **은퇴**(계약에는 남는다) |
| 튜토리얼 통로 폭 | `CORRIDOR_PROFILE` **만** −30 % (전투 22 → 15.4 · 통과 11 → 7.7). 포복 틈 2.1 · 무너진 벽 틈 2.5 · 함선 외피는 그대로 |
| 메신저 타이핑 연출 | **새로 도착하는 말풍선만** `...` → 본문. 기존 기록을 다시 열면 즉시 전부 표시 |
| 튜토리얼 전용 적 | `data/enemies.csv` 에 **전용 타입 추가** + `data/loot_*` 에 고정 드롭 표. `world/tutorial` 은 type 만 바꾼다 |
| 새 연락 조건 저장 | `MetaSave.npc.flags` + `data/npcs.csv` 의 `reqFlag` 열 (계약 = `NpcRequirement.flags` · `NpcFlag`) |
| 함선 튜토리얼 목표 세분화 | **목표 줄만 순차 공개.** 단계(StepDef) 수는 그대로 |
| 장착 튜토리얼 포커싱 | 작업대(제작 창)가 열려 있으면 **먼저 「제작 창을 닫는다」 목표**, 닫힌 뒤에 장비칸+가방 포커싱 |
| 조작 가이드 | **단계마다 교체**(누적 아님). 기상 직후 `move` 단계에 이동·달리기·점프 세 줄을 한꺼번에 |
| 신뢰도 Radial 게이지 | **퀘스트 탭 상세 + 대화창 머리 초상 둘 다.** 초상 테두리 radial + 우하단 레벨 배지 |
| 회복(heal) 선택 목표 | **순차 공개 3줄** (휠에서 고른다 → 손에 든다 → 길게 눌러 쓴다) |
| 튜토리얼 맵 길이 | **구간만 재배치하고 전체 길이는 늘린다** (`Z_END` −129 → 약 −165) |

## 1. 계약 (2026-09-14 3차, 리드가 이미 넣었다 — 추가만)

- `shared/npc.ts`
  - `NPC_FLAGS` = `['gathered', 'raidReturned']` · `NpcFlag`
  - `NpcRequirement.flags?: { flag: NpcFlag; count: number }[]` ← csv `reqFlag` = `"플래그:횟수"` 를 `|` 로
  - `NpcDef.introAfter?: string[]` ← csv `introAfter`. **있으면 선택지에 답하기 전에는 퀘스트를 제안하지 않는다**
  - `NpcSave.flags?: Partial<Record<NpcFlag, number>>`
  - `NpcQuestRef.flagOf(flag)` · `bumpFlag(flag, delta?)` — **구현 완료** (`gather:collected` → `gathered`, `game:complete` → `raidReturned`)
  - 은퇴 표시: `NpcQuestState 'deferred'` · `NpcQuestRef.defer` · `NPC_REPLY_KO.decline`/`brief` · `NpcQuestDef.lines.decline`/`brief`
- `shared/extraction.ts` — `ExtractionRef.holdFire?(): boolean` (적이 **바라보되 쏘지 않는다**, 튜토리얼 이륙 전용)
- `shared/types.ts` — `PlayerRef.setSceneLock?(on)` (입력 잠금 + 모든 피해 무시, 카메라는 안 건드린다)

## 2. 레인 (파일 소유 — 서로 겹치지 않는다)

| 레인 | 소유 파일 |
|---|---|
| **A1 NPC 엔진** | `src/meta/**`, `data/npcs.csv`, `data/npc_quests.csv` |
| **A2 메신저 UI** | `src/ui/menus/messenger/**`, 메신저 CSS |
| **B 튜토리얼 월드** | `src/world/tutorial/**` |
| **C 튜토리얼 시스템** | `src/tutorial/**` |
| **D 적** | `src/enemies/**`, `data/enemies.csv`, `data/loot_*.csv` |
| **E 플레이어 · 탈출 · 인벤 CSS** | `src/player/**`, `src/extraction/**`, `src/inventory/inventory.css` |

`CLAUDE.md` · `data/README.md` · `src/shared/README.md` 는 **리드가 마지막에** 쓴다. 에이전트는 자기 폴더 `README.md` 만 갱신한다.

## 3. 레인별 명세

### A1 — NPC 엔진 · 대사 표

1. **첫 연락 3단**: `intro`(1–3마디, 인사만) → `introChoices`/`introChoiceReplies`(내 대답 2개) → `introAfter`(본론 · 용건 2–3마디).
   NPC 10명 **전부**에 넣는다. 레이븐은 지금 intro 4마디 + 선택지가 있으므로 **재배치**한다 (인사 3마디 → 선택지 → 본론 3마디).
2. `NpcQuests.evaluate()` — `def.introAfter` 가 있고 `choice` 사건이 아직 없으면 **그 NPC 는 offer 하지 않는다**.
3. `getMessages()` — `choice` 사건 뒤에 `introAfter` 말풍선을 푼다.
4. `getQuests()` — `offered` · `deferred` 를 제외한다 (`getQuest(id)` 는 그대로 답한다 — 대화창 카드가 쓴다).
5. `defer()` 는 늘 false. `decline` 로그를 새로 만들지 않는다 (옛 기록은 계속 풀린다).
6. 4기업 NPC 연락 조건 (`data/npcs.csv`):
   - `npc_min_jihoo` — `reqLevel` 비움, `reqFlag=gathered:1`
   - `npc_cha_yuna` — `reqFlag=raidReturned:1`
   - `npc_oh_sera` — `reqLevel` 비움, `reqQuests=q_nm_s1`
   - `npc_park_doyun` — `reqQuests=q_rv_1`
   (레이븐 `reqLevel 1` · 케인 `reqQuests=q_rv_2` 는 그대로)

### A2 — 메신저 UI

- 대화 목록 한 줄: **이름 + 마지막 대사 미리보기**만. `[퀘스트] …` 라벨 · 신뢰도 레벨/게이지 · `NN분` · 소속 라벨 **전부 제거**.
  퀘스트 제안이 마지막 사건이면 퀘스트 `summary` 를 잘라 쓴다 (`레이븐이 새 거래 상대의 솜씨를…`).
- 대화창 머리: 소속 아래 `bio` 한 줄 **제거**. 레벨 · 신뢰도 현황을 **중앙 우측**으로. 초상에 radial 게이지 + 우하단 레벨 배지.
- 대화창 하단 `NPC 에게는 퀘스트 카드로 답합니다` **제거**.
- 퀘스트 카드: `[생각해보지]` 버튼 **제거**, `[수락]` 만.
- 퀘스트 탭: 진행 중 / 완료만 (엔진이 이미 걸러 준다). 상세 카드 NPC 초상에도 radial + 배지.
- **타이핑 연출**: 새로 붙는 말풍선을 한 줄씩, 앞에 `...` 말풍선을 `clamp(본문 길이 × k, 0.5s, 2.0s)` 동안 띄웠다 지운다.
  이미 있던 기록은 즉시 전부. 대화가 바뀌거나 패널이 닫히면 큐를 버리고 전부 즉시 표시한다 (갇히는 길을 만들지 않는다).

### B — 튜토리얼 월드 (`src/world/tutorial/`)

- `CORRIDOR_MAX_HALF_X` 22 → **15.4**, `CORRIDOR_PASS_HALF_X` = 그 절반 (**7.7**). `CRAWL.gapHalfX` · `BROKEN_WALL.gapHalfX` · 함선 외피는 그대로.
  `DECKS` 는 늘 `±CORRIDOR_MAX_HALF_X` 규약 유지. **적 6마리 `|x| ≤ 7` 이 여전히 벽 안인지 확인**한다.
- **벌레 구간 연장**: 벌레를 더 멀리 세우고 구간을 늘린다. 뒤 구간이 밀려 `Z_END` 가 길어진다 — `CHECKPOINTS` · `ENEMIES` · `CORPSES` · `FALL_RULES` · `SHIP_POS` · `CORRIDOR_PROFILE` · `TUTORIAL_MAP_SIZE` 를 전부 다시 계산하고,
  `CHECKPOINTS` 주석의 **적까지의 거리 표**를 다시 계산해 감지 반경 12 m 밖임을 보인다.
- **절벽 1(뛰어넘는 구간)을 사선으로**: `CHASM` 과 두 데크의 맞닿는 모서리를 통로 축에 대해 비스듬하게 — 무너진 절벽처럼. 데크는 회전 OBB 또는 계단식 타일로.
  넘는 데 필요한 거리는 지금과 같게 유지한다 (걸어 2.66 m 못 넘음 · 달려 4.56 m 넘음).
- `crawl` 체크포인트를 **포복 구간 바로 앞**으로 (벌레를 처치하고 한참 걸어와야 앉기 안내가 뜬다).
- **포복 구간**: 천장 슬래브를 약간 기울여 무너진 잔해처럼. 천장 아래로 튀어나온 **얇은 기둥 제거**. 바닥에 깔린 콜리전 없는 장식 **제거** (`parts/Dressing`).
- **안드로이드 위치**: 무너진 벽(`BROKEN_WALL.z`) 뒤 두 안드로이드를 **벽에서 더 멀리** 세워, 플레이어가 벽 앞에서 던진 수류탄의 폭발 반경에 들어오게 한다.
- 적 타입을 D 레인이 만드는 튜토리얼 전용 id 로 바꾼다 (아래 D 참조).

### C — 튜토리얼 시스템 (`src/tutorial/`)

1. **목표 순차 공개**: `TutorialObjective.reveal?: true` — 앞 줄을 달성해야 보인다. 패널이 숨긴 줄을 그리지 않는다.
2. **조작 가이드 교체식**: `TUTORIAL_CONTROL_HINTS` 를 「그 단계에 **보일** 줄」로 재해석하고 단계가 바뀌면 갈아 끼운다.
   머리 라벨 `배운 조작` → 현재 안내에 맞는 문구. `move` 단계 = 이동 · 달리기 · 점프 세 줄.
   `crouch` 단계 = 앉기(C) + 포복(Z) 두 줄. **라벨은 자세에 따라 바뀐다** — 서 있으면 `앉기`/`포복`, 앉아 있으면 C = `일어서기` · Z = `포복`, 엎드려 있으면 C = `앉기` · Z = `일어서기` (`player:stanceChanged` 로 다시 그린다).
3. **벌레 단계 진입 시점**: `corpseLoot` 는 **가방을 닫으면** `shoot` 로 넘어간다 (지금은 총 장착 즉시). 조작 가이드도 그때 전투 줄로 바뀐다.
4. **시체 퀘스트 마커**: `corpseLoot` 목표 시체 위에 세로선 + 아래를 가리키는 chevron(하이라이트 주황)을 위아래로 천천히 움직이며 그린다.
5. **회복(heal)**: 선택 목표 3줄 순차 공개 — ① 빠른 사용 휠을 열어 붕대를 고른다 ② 붕대를 손에 든다 ③ 길게 눌러 붕대를 쓴다.
   시체에서 붕대를 **딤 없는 포커싱**으로 가리키고, 더블클릭·드래그로 빈 퀵슬롯에 올리면 ①이 열린다. 체력이 가득이면 단계 전체를 조용히 지나가는 지금 동작은 유지.
6. **함선(build) 목표 세분화** — 예: `craftGun` = `작업실로 이동` → `총기 작업대 작동` → `돌격소총 제작`, `craftAmmo` = `준중량탄 제작`,
   `terminal` = `조종석으로 이동` → `조종석 터미널 작동`. 라벨은 **간략한 동작 문장**으로.
7. **`manageDone`(닫기) 단계 제거**: 순서에서 빼고, 플레이어가 임의로 닫으면 그대로 다음 단계로. (단계 id 는 계약이라 표에는 남긴다 — `openCraft` 와 같은 처리.)
8. **`levelUp` 버그**: 인벤토리가 이미 열린 채 캐릭터 탭을 눌러도 넘어가야 한다 — `inventory:opened` 말고 **탭 전환 신호**도 본다.
9. **`equipGun` 포커싱**: 제작 창이 열려 있으면 먼저 `제작 창을 닫는다` 목표를 보이고, 닫힌 뒤에 장비칸+가방을 포커싱한다.

### D — 적 (`src/enemies/`, `data/enemies.csv`, `data/loot_*.csv`)

- **튜토리얼 전용 타입 4종** (id 는 B 레인이 그대로 쓴다):
  - `tut_bug_loot` — 기본 `scavenger` 와 같은 수치. 드롭 **100 %**: 생체조직 1 · 터미니드 분비선 1 (그 밖에는 아무것도)
  - `tut_bug` — `scavenger` 와 같은 수치. 드롭 **0 %**
  - `tut_android_loot` — `android` 의 **체력 절반**. 드롭 **100 %**: 돌격소총 1 · 전력케이블 1 · 준중량탄 1스택
  - `tut_android` — `android` 의 **체력 절반**. 드롭 **0 %**
  - 배치: 벌레 = 왼쪽 `tut_bug_loot` · 오른쪽 `tut_bug`. 앉아쏴 안드로이드 = 오른쪽 `tut_android_loot` · 왼쪽 `tut_android`. 무너진 벽 뒤 둘 = **둘 다 `tut_android`**
- **벌레 스폰 연출**: `shoot` 단계가 시작될 때 두 벌레가 **구덩이에서 튀어나온다**. 이미 있는 버그 굴착 스폰(`ee spawn.em` · 1 s 땅에서 솟기)을 재사용한다.
- `ExtractionRef.holdFire()` 가 true 면 **사격만** 보류한다 (조준 · 바라보기는 그대로 — `ai/FireLine` 이 막힐 때와 같은 처리).

### E — 플레이어 · 탈출 · 인벤 CSS

1. **오프닝**: 검은 화면 → **약 2 초**에 걸쳐 밝아진다. 쓰러진 자세 → 일어서기를 **평소의 절반 속도**로 (`TUTORIAL_INTRO_WAKE_S` 를 `data/constants.csv` 에서 늘리고 `IntroWake` 의 `FADE_*` 를 2 초에 맞춘다).
2. **함선에서 포복 가능**: `PlayerSystem.update` 의 `allowProne` 게이트에서 `hub` 예외를 뺀다.
3. **`PlayerRef.setSceneLock(on)` 구현**: 입력(이동 · 자세 · 점프 · 구르기 · 조준 · 무기 · 상호작용 · 마우스 룩) 잠금 + 들어오는 피해 전부 무시. `game:abort` · `game:newMission` · 함선 복귀가 스스로 푼다.
4. **튜토리얼 탈출선**:
   - 시작할 때 **도착 토스트를 내지 않는다** (`beginPreLanded` 경로).
   - 스위치 → **10초 유예 없이 즉시 이륙** (`missionMode === 'tutorial'` 일 때만).
   - 이륙이 시작되면 `setSceneLock(true)` — 함선에서 나갈 수도, 죽을 수도 없다.
   - `holdFire()` = `missionMode === 'tutorial'` ∧ 이 상태일 때 true.
5. **제작 버튼 너비 고정** (`inventory.css`): `길게 눌러 제작` ↔ `제작 중…` 사이에 버튼 너비가 변하지 않게 한다 (누르는 중 커서가 버튼 밖으로 나가 홀드가 풀리던 것).

## 4. 검증

각 레인: `npm run typecheck` (+ csv 를 만졌으면 `npm run data:check`). 스모크는 **리드가 마지막에 한 번** `npm run verify` 로 돌린다
(같은 워크트리에서 여러 러너를 동시에 돌리지 않는다).
