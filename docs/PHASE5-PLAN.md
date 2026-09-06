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
7. 회귀: `npm run verify:all` (typecheck + build + net:selftest + 스모크 8종 병렬 + e2e:mp, `docs/VERIFICATION.md` 참조). 새 `smoke-phase5.mjs` 는 `scripts/verify.mjs` 의 `SMOKES` 표에 담당 폴더와 함께 등록한다.

## 7. 미결 (다음 세션 시작 시 확인)
- 스탯 5종의 효과 수치(제안: 체력 +4 HP/pt, 스태미나 +4/pt, 운반 5pt 당 가방 +1행, 정비 내구도 소모 −2 %/pt, 사격 반동 −2 %/pt) — 이번엔 적립만.
- 크레딧 초기값(제안 500), 귀중품 판매를 컴퓨터에서만 허용할지.
- 창고 용량 상한(제안 200칸 자동 배치, 초과 시 이관 거부).
- 프로필을 서버(릴레이)로 옮길지 여부는 이후 판단.

---

## 8. 실행 브리프 (2026-09-06 세션 — 미구현분 착수)

### 8-0. 현황과 사용자 결정
| 항목 | 상태 / 결정 |
|---|---|
| 5-a 창고 | **구현됨** (`inventory/Stash.ts`, 함선 Tab 3열 화면, `scav.stash`). **로드아웃 영속화(5절)는 미구현 → 이번에 구현** (inventory). |
| 5-b XP/레벨 | **구현됨** (`progression/`). 결과 화면 XP 정산 줄·타이틀 레벨은 없음 → 이번에 구현 (ui). **레벨당 스탯 1 포인트**, `XP_BASE` 120 (`120·n^1.35`) — 계약 커밋에서 변경 완료. |
| 스탯 5종 효과 | 사용자 정의 = 기존 `DerivedStats` 그대로: 근력(적재량·근접·점프·투척 사거리) · 지구력(스태미나 회복/최대) · 인지력(감지 반경·적 인디케이터 반경) · 지능(스킬 상승 속도) · 재주(소모품 사용 속도·상호작용 속도). 빠져 있던 소비처(수류탄 투척 거리, 퀵 사용 쿨다운, 모든 홀드 상호작용)는 계약 커밋에서 리드가 연결. **스킬 북은 이번엔 제외.** |
| 5-c 기업·계약·퀘스트·상점·크레딧·컴퓨터 | **전부 미구현 → 이번에 구현** (meta / hub / ui / inventory). |
| 크레딧 초기값 | 500 (`CREDITS_INITIAL`). 판매는 컴퓨터(기업 화면)에서만. |
| 창고 용량 상한 | **그리드가 곧 상한** (10×24, 창고 시설로 최대 60행). 칸이 없으면 이관·구매·보상 거부. 별도 200칸 카운트 없음. |
| 프로필 서버 | 계속 localStorage. 서버 저장은 이후 판단. |

계약(`src/shared`)은 **이미 커밋됨**: `shared/meta.ts` 와 `types / events / constants / net / GameContext / index` 의 `Phase 5` 구역, 요약은 `src/shared/README.md` 마지막 절. 스켈레톤 `src/meta/MetaSystem.ts` 가 `main.ts` 에 등록되어 있고 (`InventorySystem` 다음), `InventorySystem` 에는 4개 스텁(`findItemAnywhere / tryAddToStash / tryAddItemAnywhere / takeItem`) 이 있으며, `GameFlowSystem.awardMissionXp` 가 `ctx.meta.settleMission(stats)` 를 부르고 `stats.rewards` 를 채운다.

### 8-1. `src/meta/` (에이전트 A — 스켈레톤 교체)
- `Storage.ts`: `MetaSave` v1 로드/정규화/저장 (`META_STORAGE_KEY`, 디바운스 350 ms, `pagehide` flush, 모든 접근 try/catch, 이상값 클램프 — `inventory/Stash.ts` 와 같은 패턴). 새 저장: 크레딧 `CREDITS_INITIAL`, 신뢰도 0, 계약 없음, 퀘스트 기록 없음. 퀘스트 상태는 `accepted / complete` 만 저장하고 `locked / available` 은 `QuestDef.requires` 로 매번 계산한다.
- `Rules.ts` (순수 함수): 상점 목록 = `ctx.loot.getAllItemDefs()` 를 `CorpDef.stock` 규칙으로 필터 (무기는 `ctx.loot.getWeaponDef(def.weaponId).weaponClass`, `unique` 제외; 탄약 `ammoType`; 가방 `bag.tactical`; `minRepLevel`), 등급 상한 `SHOP_RARITY_CAP_BY_REP[level]` (가방 +`SHOP_BAG_RARITY_BONUS`), 가격 `buyPriceOf(def.value, level)`, 신뢰도 `repLevelOf`, 계약 수락 조건, 퀘스트 가용성.
- `MetaSystem.ts`:
  - 계약 진척 구독: `enemy:killed` (`type` 이 `rogue | rogue_boss` 면 `kill_rogues`, 아니면 `kill_bugs`), `crate:open` → `open_crates`, `inventory:containerOpened` (`containerId` 가 `corpse:` 로 시작 + `first`) → `loot_corpses` (이벤트가 아직 없으면 `crate:looted` 의 `corpse:` 로 폴백), `stratagem:called` (`caller` 가 null 또는 `ctx.net.localId`) → `use_stratagems`. 각 로컬 히트는 `reportContractHit(goal, n, true)` + 멀티면 `ctx.net.send({t:'meta', ev:'contractHit', corp, goal, amount}, 'others')`; `ctx.net.onMessage('meta', …)` 수신은 같은 기업 계약 중일 때 `reportContractHit(goal, amount, false)` (× `CONTRACT_SQUAD_SHARE`). 진척은 미션 중에만 오른다 (`ctx.isGameplayPhase()`).
  - `game:newMission` 에서 `progressAtStart` 스냅샷. `settleMission(stats)` 규칙은 `MetaRef` 주석대로 (`extract_with_value` 는 `stats.lootValue`; 성공 = `extracted && progress ≥ target` → rep/credits 지급 + 계약 해제, **XP 는 지급하지 않는다** — GameFlow 가 `settlement.xp` 를 `addXp` 에 합산; 탈출·미완 = 진척 유지; 사망 = `progressAtStart` 로 복귀). 반환값을 `meta:contractSettled` 로도 emit.
  - 상점/판매/계약 수락/퀘스트는 **함선에서만** (`ctx.isHubPhase() && !ctx.isRaidActive()`). `buy` → `addCredits(−price)` → `ctx.loot.createItem` → `ctx.inventory.tryAddItemAnywhere` (null 이면 환불 + false). `sell(uid, qty)` → `ctx.inventory.takeItem` 이 돌려준 수량 × `sellPriceOf`. `completeQuest` → 납품은 `countDefAll / consumeDefAll`, 보상 아이템은 `tryAddItemAnywhere` (자리 없으면 실패·소모 없음 — `QuestInfo.blocked` 에 `공간 없음`), `rep` 은 `addRep`, `xp` 는 `ctx.progression.addXp`, `credits` 는 `addCredits`.
  - `hub:entered` / 모든 변경 후 저장. `resetMeta()`.
  - 개발자 콘솔 (`ctx.console?.enabled` 일 때 `update()` 첫 프레임에 `register`): `credits <±n>`, `rep <helix|bastion|nomad|ceres|한국어> <±n>`, `contract list|accept <id>|abandon|hit <goal> <n>`, `quest list|accept <id>|complete <id>`.
- `ui/CorpMenu.ts` + `meta.css` (`.menu.corp-menu`, `hub/hub.css` 의 `.menu .frame .ui-btn .hub-head .hub-section` 과 `ui/styles/base.css` 재사용): 헤더 `기업 네트워크` + 크레딧 readout; 기업 탭 4개 (`CorpDef.color` 강조, 이름·슬로건, 신뢰도 바 `rep / next` + `Lv.n`); 하위 탭 **상점 / 판매 / 계약 / 퀘스트**. 상점 행: 아이콘·이름(등급색)·가격·`구매`(`blocked` 사유로 disabled + 툴팁). 판매 행: 가방/창고 아이템(수량·판매가)·`판매` (스택은 전량, `전부 판매` 버튼은 귀중품만). 계약 행: 이름·설명·목표 `p / t` 바·보상·`수락 / 포기`. 퀘스트 행: 상태 배지(잠김/가능/진행/완료)·납품 목록 `have / qty`·보상·`수락 / 납품`. 블로커 토큰 `'corp'` 를 **먼저** 넣고 `exitPointerLock()`, 닫을 때 토큰 제거 후 blocker 없고 hub 면 마이크로태스크 재잠금, Esc 는 capture 리스너 (예: `hub/ui/WorkbenchMenu.ts` 를 읽고 같은 예절). `ui:corpToggled {open, corp}`. 패널 안 결과 메시지는 인라인 `.form-msg`; **토스트는 ui 폴더가 이벤트로 띄운다** (meta 는 `ui:notify` 를 쏘지 않는다). `audio:play` `ui_equip` / `ui_deny`.
- 스모크 `scripts/smoke-meta.mjs` (`SMOKES` 등록 `folders: ['meta', 'inventory', 'hub', 'ui', 'game']`): `resetMeta` → 크레딧 500·`getShop('helix')` 빈 배열·`priceOf` null → `addRep('helix', 100)` → `meta:repChanged levelUp`, 레벨 1, 상점에 AR I / SMG I / P-2 / 경량탄 / 준중량탄만(희귀 없음, 유니크 없음), 가격 = `round(value × 1.45)` → `buy` → 크레딧 차감·가방에 인스턴스·`meta:purchase` → 잔액 부족 거부 → `sell`(가방의 `gem_amber`) → +130·아이템 소멸·`meta:sale` (inventory 의 `takeItem` 이 아직 스텁이면 이 체크는 `skip` 으로 출력하고 보고) → 계약 `helix_1` 수락(두 번째 거부, 신뢰도 부족 거부) → `game:newMission` (smoke-phase4 참고) → `enemies.debugSpawn` + 처치 → `meta:contractProgress` → `reportContractHit('kill_bugs', 30, true)` → `settleMission({…ctx.stats, extracted:false})` = 사망 규칙(진척 복귀) → 다시 채우고 `extracted:true` → 성공·rep +60·크레딧 +120·`meta:contractSettled` → 분대 공유 `reportContractHit(goal, 4, false)` = +1 → 퀘스트 `h1`: `createItem('mat_scrap', 10)` → `tryAddItem` → `acceptQuest` → `completeQuest` → 재료 소모·크레딧 +150·rep +150·`h2` available → **페이지 리로드 후** 크레딧/신뢰도/퀘스트 유지 → `openCorpMenu('ceres')` DOM·블로커·탭·Esc. 콘솔 오류 0.
- README (파일 표, 규칙, 이벤트 표, 검증).

### 8-2. `src/inventory/` (에이전트 B)
- 스텁 4개 구현: `findItemAnywhere` (가방 → 슬롯 → 소켓 → 창고), `tryAddToStash` (`stash.grid.autoPlace` + `markDirty` + `inventory:stashChanged`), `tryAddItemAnywhere` (가방 → 창고), `takeItem(uid, qty?)` (가방/창고에서 수량 제거·장착품 거부·퀵슬롯 정리·이벤트). `openContainer / openContainerItems` 에서 `inventory:containerOpened {containerId, first}` emit (`containers` 캐시에 없었으면 `first: true`).
- **로드아웃 영속화** `Loadout.ts` (`LOADOUT_STORAGE_KEY`, v1): 장착 5슬롯 + 가방 아이템(위치·회전·`durability / ammoInMag / sockets`) + 퀵슬롯(가방 인덱스). `Stash.ts` 의 직렬화/복원 코드를 `Serialize.ts` 로 추출해 둘이 공유한다. **정책(5절 확정)**: `init` 에서 저장본이 있으면 가방·슬롯을 그것으로 채운다(세션 상태가 진실); 이후 `hub` 페이즈의 모든 `afterChange()` 와 `game:complete`, `pagehide` 에 디바운스 저장 (`inventory:loadoutSaved {reason}`); `applyStarter()` 가 돌 때마다(사망 `game:over`·`player:respawn`·미션 중 abort·빈 함선 진입) **스타터를 저장**해 리로드가 잃어버린 가방을 되살리지 못하게 한다. 저장본이 없거나 비어 있으면 기존대로 `hub:entered` 에서 스타터.
- 함선 Tab 화면(`is-hub`): 헤더에 `크레딧 n` readout (`ctx.meta?.credits`, `meta:creditsChanged` 로 갱신), 공용 탭의 **기업** 을 활성화 → 창을 닫고 `ctx.meta.openCorpMenu()` (meta 가 없으면 `ui:notify` 경고).
- 스모크 `scripts/smoke-loadout.mjs` (`SMOKES` 등록 `folders: ['inventory']`): `localStorage.removeItem('scav.loadout')` → 리로드 → 함선 진입 → 스타터 → `createItem('gem_amber')` 넣기 + `createItem('wpn_smg37')` 를 `primary2` 에 `equip` → `inventory:loadoutSaved` → 리로드 → 가방·슬롯 동일 → `game:newMission` → `player:respawn` → 스타터 → 리로드 → 스타터 유지; `tryAddToStash` / `tryAddItemAnywhere`(가방 가득 → `'stash'`) / `takeItem`(가방·창고·장착품 거부) / `inventory:containerOpened` (`crate:open` 두 번 → first true / false); 기존 `smoke-quickslots`, `smoke-controls-hub`, `smoke-inventory-p6` 회귀 확인.
- README (파일 표 + Reset policy 절 갱신).

### 8-3. `src/hub/` (에이전트 C)
- **함선 컴퓨터** 프롭 (`interiors/stations.ts` 또는 `parts.ts`: 책상 + 모니터 2대 + emissive 화면 `TextPlane` `기업 네트워크`, 라이트 추가 금지) — 개인 함선 조종석(예: −X 벽 터미널과 침상 사이, 또는 +Z 벽) 과 공유 함선 브리지에 각 1대. `ShipInterior.computer: StationDef` (hub 내부 `interiors/types.ts`). `Computer.ts`: `Interactable` `hub_computer` (즉시, 반경 2.2, 프롬프트 `기업 네트워크`) → `ctx.meta?.openCorpMenu()` (없으면 `ui:notify` 경고). `Terminal / Workbench` 와 같은 등록·해제 패턴.
- `stationUsable()` 에 `ctx.meta?.isMenuOpen` 추가; hub 의 Esc 처리는 기업 화면이 열려 있으면 `ctx.meta.closeCorpMenu()` 를 먼저; 포인터락 상실 → 메뉴 열기 로직이 `'corp'` 블로커를 `'housing'` 처럼 무시하게.
- 터미널 화면 상태 줄에 `크레딧 n` 한 줄 (`meta:creditsChanged` 갱신).
- `scripts/smoke-ship-rooms.mjs` 확장: `hub_computer` 등록, E → `ui:corpToggled {open:true}` (meta 가 스텁이면 경고 토스트로 폴백 확인), Esc 로 닫힘, 컴퓨터 콜라이더에 밀려남. README (파일 표·좌표 표·Flow 표).

### 8-4. `src/ui/` (에이전트 D)
- `menus/MissionComplete.ts` / `menus/DeathScreen.ts`: `stats.rewards` 가 있으면 **XP 정산 블록** — `획득 XP +n` (카운트업), `Lv. a → b` (레벨업이면 강조 + `audio:play`), XP 바 `xp / xpToNext`; **계약 줄** — 성공 `계약 · <name> 성공 · 신뢰도 +rep · 크레딧 +credits`, 미완 `계약 · <name> p / t · 계속`, 사망 시 `진척 유지 안 됨` 문구. `rewards` 없으면 숨김.
- `hud/ContractPanel.ts` (`.hud.gameplay`, 목표 패널 아래): 미션 시작(`world:ready`) 시 `ctx.meta?.activeContract` 가 있으면 `계약 · <name>` + `p / t` 진행 바; `meta:contractProgress` 로 갱신 + 잠깐 강조; 완료(≥ target) 시 `달성` 배지.
- 토스트 (`hud/Notifications` 또는 `ProgressToasts` 방식): `meta:creditsChanged` → 합산 `+n 크레딧` 칩 (XP 칩처럼 1 s 코얼레싱, 음수는 `−n`), `meta:repChanged {levelUp:true}` → `헬릭스 방산 신뢰도 Lv.2`, `meta:contractSettled` → 성공/실패 큰 토스트, `meta:questChanged {state:'complete'}` → `퀘스트 완료 · <name>`, `meta:purchase / sale` → 짧은 줄.
- `menus/TitleMenu.ts`: 콜사인 옆 `Lv. n` 칩 (`ctx.progression?.level`, `progress:loaded / levelUp` 갱신).
- 스모크 `scripts/smoke-ui-p5.mjs` (`SMOKES` 등록 `folders: ['ui', 'meta', 'game']`): 합성 이벤트 — `game:complete {stats: {…, rewards}}` → 정산 DOM(레벨업/계약 성공), `game:over` + rewards(계약 미완) → DOM, `meta:contractProgress` 만으로 패널이 뜨는지, `meta:contractSettled` / `meta:repChanged` / `meta:creditsChanged` 토스트, 타이틀 `Lv.` 칩. 기존 `smoke-ui-p6`, `smoke-phase2` 회귀.
- README.

### 8-5. 공통 규칙 (Phase 6 §6 과 동일)
1. 읽기 순서: `CLAUDE.md` → 이 문서 §8 → 자기 폴더 `README.md` → `src/shared/README.md` 마지막 절 → `src/shared/meta.ts`. **계약 파일 수정 금지** (필요하면 보고).
2. 다른 폴더 파일은 수정하지 않는다. 다른 시스템은 `ctx.*Ref` 로만 쓰고, 스텁이면 `typeof fn === 'function'` / 옵셔널 체이닝으로 방어한다.
3. 끝내기 전 `npm run typecheck` 0 오류, 자기 스모크 통과, 자기 폴더 README 갱신, `scripts/verify.mjs` `SMOKES` 등록 + `scripts/README.md` 한 줄 + `CLAUDE.md` Commands 블록 한 줄.
4. 스모크: `scripts/smoke-progression.mjs` 머리(GL_ARGS, 포인터락 스텁, `waitFor` 60 s, `waitSim`, `tap`) 를 복사. **여러 에이전트가 동시에 편집하므로 자기 전용 vite 를 띄운다**: A `npx vite --port 5301 --strictPort`, B 5302, C 5303, D 5304 (다른 에이전트의 저장이 페이지를 리로드시키면 스크립트가 죽을 수 있다 — `smoke-console.mjs` 의 `vite-hmr` 소켓 파킹 기법을 복사하거나 재실행). 스크립트 첫 인자로 URL 을 받게 한다. 콘솔 오류 0.
5. 한국어 UI, 절차적 지오메트리만, 라이트 개수 고정, 핫패스 할당 금지, `game:abort` / `game:newMission` 에서 dispose.
6. 커밋하지 않는다. 완료 보고에 **변경 파일 목록 · 스모크 결과 수치 · 남은 이슈** 를 적는다.
