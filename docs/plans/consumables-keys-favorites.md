# 소모품 · 임플란트 · 열쇠 · 드론 스캔 · 즐겨찾기 · 헬스 미니게임 — 설계안 (2026-09-12)

리드가 사용자 결정(AskUserQuestion 7라운드)과 폴더 간 계약을 여기에 고정하고, 폴더별 에이전트 8개가 병렬로 채운다.
구현이 끝나면 결과는 `docs/HISTORY.md` 로 옮긴다.

## 0. 병렬 작업 규칙 (모든 에이전트)

- **같은 작업 트리**에서 동시에 일한다. 남의 폴더 파일을 고치지 않는다 — 아래 §9 소유표에 없는 파일이 꼭 필요하면 보고서에 적는다 (리드가 전달).
- `src/shared` 의 **공용 파일**(`events.ts` · `types.ts` · `constants.ts`)과 `data/constants.csv` 에는 에이전트마다 **자기 표식 블록**이 미리 만들어져 있다
  (`[A1]` … `[E2]`). **자기 블록 안에만** 추가한다 — 다른 자리 · 다른 블록을 고치지 않는다. 기존 선언은 이름 변경 · 삭제 금지(추가만).
  `shared/implants.ts`(B) · `shared/charBuffs.ts`(A1) · `shared/meta.ts` · `shared/itemChip.ts`(E2) · `shared/drones.ts`(D) 는 한 에이전트만 만진다.
- `data/items.csv` · `loot_*.csv` · `corp_stock.csv` 는 A1 과 C 가 함께 만진다 — **자기 줄만** 더하고, Edit 가 "파일이 바뀌었다" 로 실패하면 다시 읽고 다시 한다.
- `npm run typecheck` 는 트리 전체를 본다 — **자기 파일의 오류만** 고친다 (남의 작업 중 오류는 무시하고 나중에 다시 돌린다).
- 스모크는 리드가 띄워 둔 vite(5273) · 릴레이(8787, `SCAV_DEV_ECONOMY=1`)를 쓴다. 러너는 반드시
  `node scripts/verify.mjs --only <스크립트들> --jobs 2 --no-e2e --keep-relay --log-dir scripts/logs/<에이전트>` 로 돌린다
  (`npm run verify` 전체 · `verify:all` 은 리드만). vite 를 끄거나 새로 띄우지 않는다. 남의 폴더 때문에 페이지가 안 뜨면 잠시 뒤 다시 돌린다.
- 수치는 csv 에만 (「수치는 코드에 적지 않는다」). 게임 안 텍스트는 한국어. 설명 글에 툴팁이 이미 보여 주는 숫자를 적지 않는다.
- 끝나면 **자기 폴더 README**(구조 + `변경 이력`)를 갱신한다. `CLAUDE.md` · `docs/HISTORY.md` · `docs/VERIFICATION.md` 는 리드가 쓴다.
- 커밋하지 않는다.

## 1. 소모품 3종 (A1) — 사용자 결정

| 아이템 | 등급 | 사용 | 효과 |
|---|---|---|---|
| 아드레날린 주사 | 일반(common) | 3 초 홀드 | 스태미나 전부 회복 + 15 초간 **지속 소모만 0** (질주 · 사다리 질주 · 호버). 점프 · 구르기 · 근접 · 실드 배쉬 같은 한 번 소모는 그대로. **각성제 효과를 지운다** |
| 각성제 | 고급(uncommon) | 3 초 홀드 | 30 초간 장전 속도 +30 % · 정조준 전환 속도 +40 % · 조준 흔들림 −30 % / 패널티: 스태미나 소모 +50 % (지속 · 한 번 모두). **아드레날린 효과를 지운다** |
| 안정제 | 희귀(rare) | 3 초 홀드 | 장착 전술 임플란트를 전부 충전 + 쿨타임 초기화 (`ImplantsRef.refillAll`). **이미 가득이거나 미장착이어도 사용된다** (사용자 결정) |

- 획득: 상자 · 컨테이너 루팅(stim 가중치) · 로그 시체 · 세레스 상점(stim 규칙으로 자동) · **의학 작업대 제작**(`recipes.csv` + 분해 경제 검산 통과).
- 크기 1×1. 스택 · 가치 · 무게는 A1 이 기존 회복제 줄과 어울리게 정한다. 사용 중 이동 감속 · LMB 떼면 취소는 회복제와 같다.
- 효과 상태는 **player 가 든다** (`PlayerRef` A1 블록). 장전 · 정조준 배수는 weapons 가 읽는다. 조준 흔들림 배수는 A2 가 읽는다.
- 캐릭터 버프 목록에 `adrenaline` · `stimulant` 종류를 **추가**한다 (시간 게이지 · 아이템 썸네일, `BuffStrip`).

### 1-1. 새 조준 흔들림 (A2) — 사용자 결정

- **카메라 sway** — 화면(카메라)이 느리게 떠돈다(리사주/8자). 총알은 크로스헤어 선 판정 그대로이므로 보이는 대로 맞는다. 플레이어가 마우스로 보정 가능.
- **정조준 중에만** 생긴다 (`aimBlend` 에 비례). **무기 계열별 크기**(csv), **자세 · 이동**(앉기 · 엎드리기 줄고 이동 중 커진다).
- 스태미나는 요인이 아니다. 각성제가 `ctx.player.aimSwayMul`(A1 소유, 기본 1) 로 줄인다.

## 2. 전술 임플란트 · 함선 호출 (B) — 사용자 결정

- **쿨타임 완료 연출**: 준비되는 순간 **강한 플래시 1회 + 준비된 동안 윤곽 글로우 유지** — 전술 임플란트(`ImplantWidget`)와 함선 호출(`StratagemPanel`) 둘 다.
- 충전형(대시 3회)은 **충전 하나 찰 때마다** 플래시 + 소리 (중간 충전은 약하게, 마지막 충전은 정식).
- **소리**: 임플란트 = 짧고 높은 전자음, 함선 호출 = 무전 톤 두 음 차임 — 서로 다르다. 지금 `implant_ready` 는 `SOUNDS` 에 정의가 없어
  한 번도 안 울렸다 → 정의한다. 함선 호출 준비 소리는 새 id. 거절 환불(`refunded`)로 0 이 된 순간은 소리를 내지 않는다.
- **갈고리**: 쿨타임 12 → **24 초**. 끝났을 때 환급:
  - 붙은 뒤 놓았으면 당겨진 거리 `d`(붙은 순간 → 놓은 순간의 실제 이동, 관성 제외)로 **선형 `0.5 × max(0, 1 − d / 15)`** — 0 m = 50 %, 15 m 이상 0 %.
  - **붙기 전에 끝났으면**(날아가는 중 Q 회수 · 연결 끊김 · 시간 초과) **90 % 환급**, 단 남은 쿨타임은 **최소 3 초**.
  - 환급은 `cdTotal`(실효 쿨타임) 기준 비율이고, 쿨타임 감소를 HUD 에서 **강조**한다(초록 `−N초` 떠오르는 글자 + 게이지 번쩍임).
  - 수치 전부 csv (`IMPLANT_GRAPPLE_REFUND_MAX` 0.5 · `_REFUND_DIST` 15 · `_CANCEL_REFUND` 0.9 · `_CANCEL_MIN_S` 3 같은 이름은 B 가 정한다).
- **대시**: 이동 거리 7.5 → **11.25 m** (1.5 배).
- 안정제용 `ImplantsRef.refillAll()` — 충전 전부 · 쿨타임 0 · 배리어 잠금 해제 + 체력 가득 · 오버차지 에너지 가득 → 이벤트를 다시 내고 **준비 연출 · 소리도 난다**.

## 3. 지하실 열쇠 → 소모형 만능 열쇠 (C) — 사용자 결정

- 아이템 2종, 둘 다 **1×1 · 스택 안 됨 · 서사(epic)** · 카테고리 `key`:
  - **열쇠** — `key_basement` id 를 그대로 쓴다(옛 세이브 호환), 이름만 「지하실 열쇠」 류로. **버려진 전진기지의 지하실**을 연다.
  - **키카드** — 새 id(예: `keycard_lab`). **버려진 연구소 2층 잠긴 방**을 연다.
  - 만능이다 — 같은 종류면 어느 구조물이든 연다. 문을 열면 연 사람의 것이 **1 개 소모**된다 (지금과 같다).
- 등장처(전부 희귀하게): **일반 상자(높은 티어)** · **구조물 지상층 컨테이너**(전진기지 → 열쇠, 연구소 → 키카드, 확률 · 보장 없음) ·
  **로그 · 네임드 시체** · **노마드 장비 상점 신뢰도 3**. 지금의 「구조물마다 지상층 컨테이너 한 곳 확정」은 **없앤다**.
  `scripts/check-planet-loot.mjs` 의 「키는 절대 안 나온다」 단언도 새 규칙으로 바꾼다. 가치를 바꾸면 `npm run data:check -- --write`.
- **연구소**: 지하실 제거(`basementChance` 0). **2층이 굴려진 연구소에만**(확률 50 % 유지) 2층에 **잠긴 방** 하나 — 좁은 별도 방,
  옥상 사다리 · 해치와 이어지지 않는다. 컨테이너 **2–3 개 · 티어 4 위주**. 문은 키카드 리더.
- **전진기지 지하실**은 그대로(열쇠로).
- **지상드론 개구멍**: 잠긴 문 **바로 옆 벽 하단 환풍구** (지하실 문 옆 · 잠긴 방 문 옆). 문이 열려도 따로 남는다.
  사람은 못 지나가고 지상드론(반지름 0.35 · 높이 0.45)은 지나간다 — 콜리전을 세밀하게. 방법(리드 제안): 구멍 위 인방 상자의 밑면이
  낮으므로 사람(`BOX_HEADROOM` 2.1)은 막히고, 몸 높이를 넘기는 이동체만 그 높이로 헤드룸을 잰다 →
  `WorldRef.resolveCollision(position, radius, height?)` 선택 인자(C 블록에 오버로드로 추가) + `GroundDrone` 이 자기 높이를 넘긴다.
  적 · 플레이어 · 원격은 인자를 안 넘기므로 지금과 같다.
- `smoke-structure-reach` 갱신 + 개구멍(드론 몸은 통과 · 사람 몸은 막힘) 검사.

## 4. 지상드론 스캔 (D) — 사용자 결정

- 지상드론 조종 중 조준(드론 카메라 중심 레이)을 상자 · 컨테이너에 맞추고 **좌클릭 3 초 홀드** → 그 안 **최고 등급**을 알린다.
- 대상: **맵 상자 · 구조물 컨테이너 · 적/플레이어 시체 · 보급품 · 낙하물**.
- 제약: **약 6 m 안 + 조준 유지** — 벗어나거나 멀어지면 게이지 초기화. 소음 없음.
- 결과: 대상 위에 **등급색 월드 라벨이 레이드 내내** + **분대 공유** (+ 채팅 한 줄). 비어 있으면 「비어 있음」.
- 아직 안 연 컨테이너는 **열 때와 같은 결정적 굴림**으로 미리 본다 — 열어서 나오는 것과 스캔 결과가 다르면 안 된다.
  구조물 컨테이너의 열쇠 · 키카드 부가 굴림은 C 가 **`WorldRef.previewContainerItems?(containerId): ItemInstance[] | null`**(C 블록)로
  열 때와 같은 함수에서 내준다 — D 는 그것을 부른다. 이미 연 것은 지금 들어 있는 것으로.
- 수치(`DRONE_SCAN_HOLD_S` 3 · `DRONE_SCAN_RANGE` 6 같은 이름은 D 가 정한다) csv.

## 5. 아이템 즐겨찾기 (E1 · E2) — 사용자 결정

- **종류(def id) 단위** — 같은 아이템은 전부 표시. **캐릭터별 · 서버 동기**: 로드아웃 문서(`inventory` 세이브)에 실린다.
- **우클릭 = 모든 아이템에 메뉴** — 「빠른 이동」 + 「즐겨찾기 켜기/끄기」 (+ 기존 항목). **더블클릭 = 빠른 이동**, 단 예외 유지
  (장비 = 장착 · 가방 속 회복제/수류탄 = 퀵슬롯 등록).
- 표시: 타일 **우측 상단 파란 사선 띠**. 탄약이면서 즐겨찾기면 **파란 띠 아래 노란 띠**(둘 다 보인다).
- 부가 효과(전부): **자동 정렬 시 앞쪽** · **필터 칩 「즐겨찾기」** · **판매 · 분해 시 한 번 더 확인** · **상자 · 시체 창에서 눈에 띄게(테두리 글로우)**.
- 가지고 있지 않은 아이템도 켤 수 있는 곳: **퀘스트 납품 칩 · 제작 재료 칩(작업대 · 가구 · 업그레이드 비용) · 기업 상점 타일 · 계약 아이템 칩(신설)**.
- **새 계약 종류 「특정 아이템 회수」**: 지정 아이템 N 개를 가방에 담고 탈출하면 달성. 기업마다 1–2 개. 계약 행에 그 아이템 칩(즐겨찾기 가능).

### 5-1. 계약 (폴더 간)

- owner **E1** (`InventoryRef` E1 블록 + 이벤트):
  `isFavorite?(defId: string): boolean` · `toggleFavorite?(defId: string, on?: boolean): boolean`(새 상태) · `readonly favoriteDefIds?: readonly string[]`
  · 이벤트 `'inventory:favoritesChanged': { defId: string; favorite: boolean }`.
- owner **E2**: `shared/itemChip.ts` 가 즐겨찾기 표식을 그린다 — 칩은 `ctx` 를 모르므로 모듈 수준 공급자
  (`setItemChipFavoriteSource(fn)` 류)를 두고 ui/ 가 등록한다. 칩 우클릭 메뉴는 **ui/ 한 곳의 위임 리스너**
  (`.item-chip[data-def-id]`, `ui/hud/ItemTip` 이 호버를 위임하는 방식)가 맡고, 바뀌면 DOM 의 칩 클래스를 고친다.
  기업 상점 타일(`meta/ui/TileGrid` · `.inv-tile`)은 E1 의 타일 띠를 그대로 받고 우클릭 메뉴는 E2 가 단다. 판매 경고도 E2(meta).

### 5-2. 아이템 회수 계약: 이번 레이드에서 얻은 아이템만 (후속, 2026-09-12 — 사용자 결정)

- 요청: 「계약에 필요한 아이템은 즐겨찾기처럼 사선 띠 (구분할 수 없어도 되고, 즐겨찾기도 따로 켤 수 있다)」 · 「해당 레이드에서 얻은 아이템만 센다 —
  가져온 아이템과 분리돼 칸에 들어가고, 복귀하면 세지 않으므로 한 레이드 안에서 전부 회수해야 한다」.
- **「이번 레이드에서 얻었다」 = 그 레이드의 루팅 굴림이 만들었다**: 상자 · 구조물/플랫폼/전차 컨테이너(열쇠 부가 포함) · 보급 상자 · 적 시체(네임드 포함) ·
  채집 노드. 표식은 **아이템과 함께 다닌다**(바닥에 버려 분대원이 주워도 센다). 누가 함선에서 가져온 것은 절대 세지 않는다 — 플레이어 시체에 남은
  가져온 장비도. 제작 · 상점 · 기본 지급 · 튜토리얼 · 콘솔은 표식이 없다.
- **분리는 활성 회수 계약의 아이템에만**: 그 아이템의 「이번 레이드」 스택은 가져온 스택과 합쳐지지 않는다(다른 칸). 다른 아이템은 예전처럼 합치고,
  표식이 다른 둘이 합쳐지면 결과는 표식 없음(세탁 금지).
- **띠는 즐겨찾기와 똑같다** (별도 배지 없음, 둘 다면 띠 하나, 탄약 노란 띠 규칙 동일). **레이드 중에만** — 함선 · 훈련장에서는 없다.
- 계약(리드): `ItemInstance.raidFound?: number`(= 레이드 맵 시드) · `PickupWire.rf?` · `CorpseItemWire.rf?` · 새 `shared/raidFound.ts`
  (`raidFoundSeed` · `isRaidFound` · `markRaidFound` · `raidFoundScopeOf` · `raidFoundStackKey` · `mergeRaidFoundMark` · `copyRaidFoundMark` ·
  `countsForRecovery`). inventory `parts/RaidFound.ts` 가 격자 · 휠 · 정렬의 스택 분류 열쇠와 상자 굴림 표식을 걸고, 레이드가 끝나면
  (`game:complete` · `game:over` · `game:abort` · `hub:entered`) 몸 · 창고의 표식을 지운다. 레이드 세션 blob 에만 `rf` 가 실리고 프로필 문서에는 없다.
- 개수(meta): `carriedCount(defId, seed?)` = 몸의 그 아이템 중 표식이 레이드 시드와 같은 단위만. 실시간 진행도 · 정산 · 기업 화면 행이 같은 값이라
  함선의 계약 행은 늘 0 / n 이다. 레이드 밖에서는 저장된 진행도가 0 으로 돌아오고, 미완료 정산도 이 목표는 0 으로 둔다.
- 리드 기본값(묻지 않고 정한 것): 띠만 같고 **상자 · 시체 창 글로우는 즐겨찾기에만** 남겼다. 감정 전 타일은 띠가 없다(정체를 흘리지 않는다).
  검사: `scripts/smoke-recovery-contract.mjs`.

## 6. 헬스 미니게임 (F)

- 증상: 벤치프레스 원 커서가 스르륵 흐르지 않고 **키를 누를 때마다** 끊겨 움직인다. 호흡 · 사이클 노트도 키를 누를 때만 온다.
- 코드상 루프(`GymScreen` 의 `setInterval` 16 ms → `tick` + `paint`)는 맞아 보인다 — **실제 게임(3D 프레임이 도는 상태)에서 재현**해
  원인을 확정하고 고친다. 유력: 무거운 렌더 프레임 사이에서 타이머 태스크가 굶고 입력 이벤트만 끼어든다 · 키 핸들러는 `tick` 만 하고 `paint` 를 안 한다.
- 스모크(`smoke-gym`)가 판정 객체만 몰아 이 경로를 못 잡았다 → **입력 없이 DOM 이 움직이는지**를 실제 화면으로 검사하게 넓힌다.

## 7. 리드 기본값 (묻지 않고 정한 것)

- 소모품 사용 중 감속 · 취소 · 수량 소비 시점은 회복제와 같다. 효과는 레이드 전용(퀵슬롯 사용 경로).
- 안정제는 함선 호출 쿨타임을 건드리지 않는다 (명세대로 임플란트만).
- 드론 스캔은 지상드론만 (공중 드론 제외). 스캔 결과는 늦게 합류한 분대원에게는 안 간다(월드 라벨만 레이드 내 방송) — 필요하면 D 가 `sync` 추가.
- 개구멍은 수류탄 같은 작은 투척물도 지나간다(작은 몸 규칙 그대로).
- 열쇠 · 키카드가 루팅된 시체 · 상자에서 나오는 확률 수치는 C 가 「희귀」 로 정하고 `check-planet-loot` 에 기대치를 적는다.

## 8. 에이전트 목록

| id | 범위 |
|---|---|
| A1 | 소모품 3종 — 아이템 · 루팅 · 상점 · 제작, 사용 경로(weapons `Healing`), 효과 상태(player), 스태미나, 장전 · 정조준 배수, 버프 목록 |
| A2 | 새 조준 흔들림 — player 카메라 sway, 무기 계열별 csv, 자세 · 이동, `aimSwayMul` 소비 |
| B | 갈고리 환급 · 쿨 2 배 · 대시 1.5 배 · `refillAll` · 준비 플래시/글로우(임플란트 · 함선 호출) · 준비 소리 2종 |
| C | 열쇠 · 키카드 · 연구소 잠긴 방 · 전진기지 지하실 열쇠 · 개구멍 콜리전 · 루팅 · 노마드 상점 · `previewContainerItems` |
| D | 지상드론 스캔 — 조준 레이 · 3 초 홀드 · 등급 미리보기 · 월드 라벨 · 분대 공유 |
| E1 | 즐겨찾기 코어(inventory) — 저장 · API · 메뉴 · 더블클릭 · 띠 · 정렬 · 필터 · 분해 경고 · 루팅 창 강조 |
| E2 | 즐겨찾기 칩 · 기업 화면(상점 타일 메뉴 · 판매 경고 · 퀘스트 칩) · 새 계약 「특정 아이템 회수」 |
| F | 헬스 미니게임 부드러운 진행 |

## 9. 파일 소유표 (대략 — 여기에 없는 파일이 필요하면 보고)

- A1: `data/items.csv`(자기 줄) · `loot_category_weights/loot_item_weights/loot_corpses.csv`(자기 줄) · `recipes.csv` · `salvage.csv` ·
  `src/items/**` · `src/weapons/parts/Healing.ts` · `QuickUse.ts` · `weapons/model.ts`(useTimeOf) · `weapons/parts/Firing.ts`(장전 배수 줄만) ·
  `src/player/parts/Locomotion.ts` · `player/parts/Buffs.ts` · 새 `player/parts/Boosts.ts` · `PlayerSystem.ts`(boost 필드 · `setAdsTime` 배수) ·
  `src/shared/charBuffs.ts` · `src/ui/hud/BuffStrip.ts` · `src/inventory/ui/Tooltip.ts` · `inventory/ui/labels.ts` · `inventory/parts/LaunchCheck.ts`.
- A2: `src/player/CameraRig.ts` · `data/weapons.csv` 또는 새 `data/aim_sway.csv` · `src/weapons/parts/Firing.ts`(`applyAimZoom` 만) · 필요하면 `weapons/model.ts` 의 새 함수.
- B: `src/implants/**` · `src/shared/implants.ts` · `src/ui/hud/ImplantWidget.ts` · `StratagemPanel.ts` · `src/ui/styles/implant.css` ·
  `src/audio/**` · `src/stratagems/**`(필요시) · `data/constants.csv` B 블록 + 기존 `IMPLANT_GRAPPLE_COOLDOWN` · `IMPLANT_DASH_DISTANCE` 두 줄 값.
- C: `src/world/**` · `data/structures.csv` · `data/items.csv`(열쇠 줄) · 루팅 csv(열쇠 줄) · `data/corp_stock.csv` · `src/gadgets/drones/GroundDrone.ts`(충돌 한 줄) ·
  `src/ui/map/MapScreen.ts`(잠김 표시) · `scripts/check-planet-loot.mjs` · `scripts/smoke-structure-reach.mjs` · 새 스모크.
- D: `src/gadgets/drones/**`(GroundDrone 충돌 줄 제외) · `src/shared/drones.ts` · `src/ui/hud/DroneHud.ts` + 새 `ui/hud/*` 라벨 · `src/ui/styles/drone.css` ·
  `src/net/**`(스캔 방송 메시지만) · `src/inventory` 의 미리보기 질의가 필요하면 E1 과 겹치지 않는 새 part 파일 + `InventoryRef` D 블록.
- E1: `src/inventory/**`(Tooltip · labels · LaunchCheck 제외 — A1 이 짧게 만진다, 겹치면 다시 읽고 편집) · `server/` 무변경.
- E2: `src/shared/itemChip.ts` · `src/shared/meta.ts` · `data/contracts.csv` · `src/meta/**` · `src/ui/hud/ItemTip.ts` 옆 새 위임 파일 · `src/ui/styles/base.css`(칩 표식) ·
  `server/economy.gen.json`(`data:check -- --write`).
- F: `src/housing/ui/gym/**` · `src/housing/parts/GymGames.ts` · `scripts/smoke-gym.mjs`.
