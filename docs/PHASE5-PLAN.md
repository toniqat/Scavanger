# Phase 5 계획서 — 메타 진행 (창고·로드아웃, 경험치/레벨, 기업·계약·퀘스트)

작성 2026-09-06. 다음 세션에서 이 문서를 그대로 계약(`src/shared`) → 폴더 에이전트 순서로 실행한다.
Phase 0–4 는 커밋 `5b6d9b0` 까지 완료(`docs/ROADMAP.md` 참조). 이 문서는 **설계**만 담고 코드 변경은 없다.

## 0. 결정 사항 (2026-09-06 사용자 확인)
- **스탯 효과는 후순위**: 이번 단계에서는 경험치 → 레벨 → 스탯 포인트 *적립*만 구현한다(레벨업 알림, 미배분 포인트 표시). 포인트를 쓰는 UI·효과는 이후 단계.
- **기업 4곳의 이름·판매 목록은 리드가 작성**(아래 3-c). 계약/퀘스트 초안 각 4개.
- **행성 기믹(기차·레일, 버려진 화물차)은 별도 세션**(월드 대공사). 이 문서 범위 밖.
- 영구 저장은 **localStorage**, 키 접두어 `scav.` (기존 `scav.sessionToken` 과 동일 규칙). 서버 저장 없음.

## 1. 범위 요약
| 항목 | 내용 |
|---|---|
| 5-a 창고·로드아웃 | 개인/공유 함선에서 Tab → 3열 UI(좌 창고 / 중 장착 / 우 가방). 탈출 성공 시 가방 → 창고 이관 여부 선택 없음: **가방 내용물은 그대로 유지**되고, 함선에서 창고↔가방 자유 이동. 사망 시 가방·장착 소실(현재 리셋 정책 유지), 창고는 보존. |
| 5-b 경험치·레벨 | 처치/상자/시체 수색/탈출/계약·퀘스트 완료로 XP. 레벨 곡선, 레벨업당 스탯 포인트 3 적립. HUD 미션 결과 화면에 XP 정산. |
| 5-c 기업·신뢰도·계약·퀘스트 | 개인 함선 **컴퓨터** 인터랙터블 → 기업 4곳 화면(상점 / 계약 / 퀘스트). 신뢰도 레벨별 상점 해금·가격, 계약(행동 기반, 탈출 시 정산, 분대 25 % 공유), 퀘스트(아이템 납품 + 선행 조건 연계). |

## 2. 저장 스키마 (`src/meta/Storage.ts`)
```ts
// localStorage 'scav.profile.v1'
interface ProfileSave {
  v: 1;
  xp: number; level: number; statPoints: number;          // 5-b
  stash: SavedItem[];                                      // 5-a (ItemInstance 직렬화: defId, qty, rotated, durability?, ammoInMag?, sockets?)
  loadout: { primary?: SavedItem; primary2?: SavedItem; secondary?: SavedItem; bag?: SavedItem; bagItems: SavedItem[]; quickSlots: (number|null)[] };
  credits: number;                                         // 판매/구매 통화 (귀중품 판매 = value)
  corps: Record<CorpId, { rep: number; repLevel: number; contract: ContractSave | null; quests: Record<string, QuestSave> }>;
  stats: { missions: number; extractions: number; kills: number; deaths: number };
}
```
- 저장 시점: 함선 진입(`hub:entered`), 인벤토리/창고 변경 후 디바운스 1 s, 미션 결과(`game:complete`/`game:over`), 기업 화면 조작 직후.
- 로드 시점: 앱 시작(`MetaSystem.init`), 프로필이 없으면 기본값(창고 비움, 로드아웃 = `STARTER_LOADOUT`, 신뢰도 0).
- 마이그레이션: `v` 검사, 미지의 defId 는 버림(`console.warn`).
- 위험: uid 는 세션 로컬(`nextUid`)이므로 저장 시 uid 를 버리고 로드 시 새로 발급. 소켓 안의 부착물도 재귀 직렬화.

## 3. 계약 초안 (`src/shared`, append-only)

### 3-a `types.ts`
```ts
export type CorpId = 'helix' | 'bastion' | 'nomad' | 'ceres';
export interface CorpDef { id: CorpId; name: string; tagline: string; sells: ItemCategory[]; color: string }
export type ContractGoalKind = 'kill_bugs' | 'kill_rogues' | 'open_crates' | 'loot_corpses' | 'extract_with_value' | 'use_stratagems';
export interface ContractDef { id: string; corp: CorpId; minRepLevel: number; goal: ContractGoalKind; target: number; repReward: number; xpReward: number; name: string; desc: string }
export interface QuestDef { id: string; corp: CorpId; name: string; desc: string; requires: { repLevel?: number; quests?: string[] }; deliver: { defId: string; qty: number }[]; rewards: { rep: number; xp: number; items?: { defId: string; qty: number }[]; credits?: number } }
export type QuestState = 'locked' | 'available' | 'accepted' | 'complete';
export interface MetaRef {                       // ctx.meta (owner: meta/MetaSystem)
  readonly xp: number; readonly level: number; readonly statPoints: number; readonly credits: number;
  xpForLevel(level: number): number;
  getRep(corp: CorpId): { rep: number; level: number; next: number };
  readonly activeContract: { def: ContractDef; progress: number } | null;
  acceptContract(id: string): boolean; abandonContract(): void;
  getQuestState(id: string): QuestState; acceptQuest(id: string): boolean; completeQuest(id: string): boolean; // 납품 검사 → 아이템 소모 → 보상
  buy(corp: CorpId, defId: string): boolean; sell(uid: string): boolean; priceOf(corp: CorpId, defId: string): number | null;
  // 창고
  getStash(): readonly ItemInstance[]; stashItem(uid: string): boolean /* 가방→창고 */; unstashItem(uid: string): boolean /* 창고→가방 */;
  save(): void;
}
```
- `GameContext`: `meta: MetaRef | null`.
- `InventoryRef` 추가: `getStashGrid?()` 는 두지 않는다 — 창고 그리드는 **inventory 폴더가 렌더**하되 데이터는 `ctx.meta.getStash()`(단순 목록, 그리드 배치는 자동)로 읽는다. 필요 시 `InventoryRef.openStash(): void` / `closeStash()` 를 append(함선에서 Tab).

### 3-b `events.ts`
```ts
'meta:xpGained': { amount: number; source: string; xp: number; level: number }
'meta:levelUp': { level: number; statPoints: number }
'meta:repChanged': { corp: CorpId; rep: number; level: number; delta: number }
'meta:contractProgress': { id: string; progress: number; target: number }
'meta:contractSettled': { id: string; success: boolean; rep: number; xp: number }   // 탈출 정산
'meta:questChanged': { id: string; state: QuestState }
'meta:purchase': { corp: CorpId; defId: string; price: number } / 'meta:sale': { defId: string; qty: number; credits: number }
'meta:stashChanged': { count: number }
'ui:computerToggled': { open: boolean }          // 개인 함선 컴퓨터 (hub)
'ui:stashToggled': { open: boolean }             // 함선 Tab 3열 UI (inventory)
```
### 3-c `constants.ts`
- `XP_TABLE`: 레벨 n→n+1 필요 XP = `round(120 × n^1.35)`, 최대 레벨 50. `STAT_POINTS_PER_LEVEL = 3`.
- XP 지급: 버그 처치 8(behemoth 60, artillery 25, toxic 10) · 로그 15(보스 120) · 상자 12/티어 · 시체 수색 4 · 탈출 150 + 회수 가치/50 · 계약 성공 def.xpReward · 퀘스트 def.rewards.xp.
- `REP_TABLE`: 신뢰도 레벨 L 까지 누적 필요치 `[0, 100, 300, 700, 1500, 3000]`(레벨 0–5). 상점 해금 레벨 1.
- `CONTRACT_SQUAD_SHARE = 0.25`.
- `CORP_DEFS`:
  - `helix` **헬릭스 방산** — 돌격소총·기관단총·경량/준중량탄. "수량이 곧 화력."
  - `bastion` **바스티온 중공업** — 저격소총·지정사수소총·산탄총·중량/산탄탄. "한 발의 무게."
  - `nomad` **노마드 장비** — 가방(일반→전설, 전술 변형은 레벨 3+). "짊어진 만큼 살아 돌아온다."
  - `ceres` **세레스 바이오** — 스팀·수류탄·부착물(레벨 2+). "몸이 먼저다."
- 가격: `value × (1.6 − 0.15 × repLevel)`(최소 ×0.9), 판매가 `value × 0.5`. 판매 등급 상한: 레벨 1 일반·고급, 2 희귀, 3 서사, 4 전설(가방은 레벨+1 등급까지).
- 계약 초안(각 기업 4개, `minRepLevel` 0/1/2/3 로 상향): helix `kill_bugs` 25/60/120/200 · bastion `kill_rogues` 5/12/25/40 · nomad `extract_with_value` 1500/4000/9000/20000 · ceres `loot_corpses` 6/15/30/50 (+ 공용 `open_crates`, `use_stratagems`).
- 퀘스트 초안(연계): helix `h1` 폐금속 10 → `h2` 합금 판 6 → `h3`(레벨 2) 파워 셀 4 → `h4`(h3, 레벨 3) 데이터 코어 1; bastion `b1` 터미니드 분비선 3 → `b2` 정제 샘플 1 → `b3`(레벨 3) 외계 유물 1; nomad `n1` 크레딧 칩 5 → `n2` 회수 전자장비 3; ceres `c1` 생체 조직 12 → `c2` 분비선 5 → `c3`(레벨 2) 고대 성유물 1. 보상: 신뢰도 150–600, XP 200–1500, 아이템(가방/부착물/등급 무기) 1개.

### 3-d `net.ts`
- `ContractShareMessage { t:'meta'; ev:'contractHit'; corp: CorpId; goal: ContractGoalKind; amount: number }` — 계약 목표 행동 발생 시 분대에 송신; 수신자는 **같은 기업** 계약 중일 때만 `amount × CONTRACT_SQUAD_SHARE` 진척.

## 4. 폴더 소유 / 에이전트 분할 (2–3개 동시)
| 폴더 | 작업 |
|---|---|
| **신규 `src/meta/`** (`MetaSystem`, `Storage.ts`, `Corps.ts`(CORP_DEFS/계약/퀘스트 데이터는 constants 또는 여기), `Progress.ts`) | `ctx.meta` 구현: 프로필 로드/저장, XP/레벨, 신뢰도, 계약 진척(버스 이벤트 `enemy:killed`·`crate:looted`·`corpse` 수색·`game:complete`·`stratagem:called` 구독) 및 탈출 시 정산, 퀘스트 상태기계·납품, 상점 `buy/sell`(inventory `tryAddItem`/`consumeItem` 사용), 창고 목록. `main.ts` 등록: `InventorySystem` 다음. |
| `src/hub/` | 개인 함선 **컴퓨터** 프롭 + `hub_computer` 인터랙터블 → `ui/CorpMenu.ts`(기업 탭 4개: 상점 목록·가격·구매, 계약 수락/포기/진척, 퀘스트 목록·납품 버튼, 신뢰도 바). 블로커 `hub`. 공유 함선에도 컴퓨터 1대(동일 메뉴). |
| `src/inventory/` | 함선(hub 페이즈)에서 Tab → **3열 UI**(창고 그리드(스크롤, 자동 배치) / 장착 4슬롯+퀵슬롯 / 가방). 드래그 창고↔가방↔슬롯, 우클릭 `창고로`/`가방으로`, 판매 버튼(컴퓨터 없이도 판매는 불가 — 판매는 컴퓨터에서만). 미션 중 Tab 은 기존 2열 유지. |
| `src/ui/` | 결과 화면(`MissionComplete`/`DeathScreen`)에 XP 정산 줄(획득 XP, 레벨 진행 바, 계약 정산 결과), 레벨업 토스트(`meta:levelUp`), HUD 미니 계약 진척(`meta:contractProgress`, 목표 패널 아래), 타이틀 `콜사인` 옆 레벨 표시. |
| `src/game/` (리드) | `game:complete` 전에 `ctx.meta` 정산 훅 순서 보장(GameFlow → `meta:contractSettled` → 결과 화면). |
| `src/net/` (리드) | `meta contractHit` 릴레이(타입 추가만). |

권장 순서: ① 리드가 계약 + `src/meta/` 골격(타입 컴파일용 stub) ② 에이전트 A `meta`(로직·저장) / B `inventory`(3열 UI) / C `hub`+`ui`(컴퓨터 메뉴·결과 화면) 동시 ③ 리드 통합·스모크.

## 5. 인벤토리 리셋 정책 변경 (5-a 와 함께)
- 현재: 첫 미션/사망/포기 → 스타터, 탈출 성공 → 유지. 
- 변경: **프로필 로드아웃**이 진실. `hub:entered` 시 프로필 로드아웃을 인벤토리에 적용, 함선에서의 변경은 프로필에 저장. 사망/포기 → 프로필 로드아웃·가방 비움 후 **스타터 키트 재지급**(창고 보존). 탈출 성공 → 현재 가방/장착을 프로필에 저장. `player:respawn` → 스타터(현행).
- 스타터 키트는 "기본 지급"이므로 창고에 쌓이지 않게: 리스폰/사망 시에만 지급.

## 6. 검증 계획 (`scripts/smoke-phase5.mjs`)
1. 새 프로필: 레벨 1, 창고 0, 신뢰도 0 → 컴퓨터 상점 잠김(`priceOf` null).
2. `ctx.meta` 에 XP 주입(디버그 `debugGrantXp`) → `meta:levelUp`, `statPoints` 3.
3. 함선 Tab → 3열 UI DOM, 가방 아이템 → 창고 드래그(real mouse) → `getStash()` +1, 새로고침(페이지 reload) 후 창고 유지(localStorage).
4. 계약 수락 → 미션에서 버그 5 처치(`debugSpawn` + `takeDamage`) → 진척 5 → 탈출(기존 e2e 흐름 재사용 or `debugComplete`) → `meta:contractSettled success` → 신뢰도 상승 → 상점 해금 → `buy` 성공(크레딧 차감, 가방에 아이템).
5. 퀘스트 `h1`: 폐금속 10 보유 → `completeQuest` → 아이템 소모 + 보상.
6. 멀티(e2e 확장): 호스트 처치 → 클라이언트가 같은 기업 계약 중일 때 25 % 진척 수신.
7. 회귀: smoke-weapons/phase2/3/4, e2e:mp, net:selftest, build.

## 7. 미결 (다음 세션 시작 시 확인)
- 스탯 5종의 효과 수치(제안: 체력 +4 HP/pt, 스태미나 +4/pt, 운반 5pt 당 가방 +1행, 정비 내구도 소모 −2 %/pt, 사격 반동 −2 %/pt) — 이번엔 적립만.
- 크레딧 초기값(제안 500), 귀중품 판매를 컴퓨터에서만 허용할지.
- 창고 용량 상한(제안 200칸 자동 배치, 초과 시 이관 거부).
- 프로필을 서버(릴레이)로 옮길지 여부는 이후 판단.
