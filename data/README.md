# data/ — 게임 수치의 원본

**게임 안의 수치는 전부 이 폴더의 csv 에 있다.** 데미지 · 체력 · 가격 · 확률 · 쿨다운 · 무게 · 격자 크기까지
전부. `src/` 의 TypeScript 에는 같은 숫자가 없다 — 코드는 이 표를 읽어 자기 타입의 객체로 옮길 뿐이다.

밸런스를 만지려면 **여기 csv 만 고치면 된다.** Excel · Google Sheets · 메모장 어느 것으로 열어도 되고,
`npm run dev` 가 떠 있으면 저장하는 순간 화면에 반영된다 (Vite HMR).

```
npm run data:check      # 고친 csv 가 말이 되는지 검사 (오타 · 빠진 칸 · 범위 · 모르는 이름)
npm run dev             # csv 를 저장하면 바로 다시 읽는다
```

---

## 1. 파일 지도

| 무엇을 고치고 싶은가 | 파일 |
|---|---|
| **전역 수치** — 플레이어 체력 · 이동 속도 · 중력 · 탈출 카운트다운 · 임플란트 · 가젯 · 스트라타젬 · 훈련장 … | [`constants.csv`](constants.csv) |
| 이름 붙은 숫자 표 — 탄약 스택 · 등급별 감정 시간 · 방어구 등급 감소율 · 신뢰도 표 · 사격 숙련 경험치 … | [`tables.csv`](tables.csv) |
| 기능 폴더 안에서만 쓰는 스칼라 — 아이템 무게 기본값 · 분해 산출량 · 상점 가격 계수 · 경험치 … | [`tuning.csv`](tuning.csv) |
| **무기** 6계열 (등급 I 기준, II–V 는 자동) | [`weapons.csv`](weapons.csv) |
| **전설 유니크 무기** 6종 | [`weapons_unique.csv`](weapons_unique.csv) |
| 무기 부착물 | [`attachments.csv`](attachments.csv) |
| 탄약 · 가방 · 방탄복 | [`ammo.csv`](ammo.csv) · [`bags.csv`](bags.csv) · [`armor.csv`](armor.csv) |
| 일반 아이템 — 수류탄 · 회복 소모품 · 귀중품 · 재료 · 약초 · 가젯 | [`items.csv`](items.csv) |
| 씨앗 · 서적 | [`seeds.csv`](seeds.csv) · [`books.csv`](books.csv) |
| 임플란트 아이템 — 등급별 가격 · 수리 재료 · 전설 퍽 | [`implants_repair.csv`](implants_repair.csv) · [`implants_perks.csv`](implants_perks.csv) |
| **적** 10종 기본 스탯 | [`enemies.csv`](enemies.csv) |
| 적 특수 능력 — 도약 · 산성 침 · 돌진 · 로그 AI · 포병 · 베헤모스 | [`enemy_abilities.csv`](enemy_abilities.csv) |
| **상자 루팅** — 티어 규칙 · 카테고리 가중치 · 확정 픽 · 아이템별 배수 | [`loot_tiers.csv`](loot_tiers.csv) · [`loot_category_weights.csv`](loot_category_weights.csv) · [`loot_guaranteed.csv`](loot_guaranteed.csv) · [`loot_item_weights.csv`](loot_item_weights.csv) |
| **시체 루팅** | [`loot_corpses.csv`](loot_corpses.csv) · [`loot_corpse_rolls.csv`](loot_corpse_rolls.csv) |
| 제작 레시피 | [`recipes.csv`](recipes.csv) |
| 능력치 · 숙련도 | [`stats.csv`](stats.csv) · [`skills.csv`](skills.csv) |
| 기업 · 판매 목록 · 계약 · 퀘스트 | [`corps.csv`](corps.csv) · [`corp_stock.csv`](corp_stock.csv) · [`contracts.csv`](contracts.csv) · [`quests.csv`](quests.csv) |
| 함선 — 방 용도 증축 · 시설 강화 · 가구 | [`room_purposes.csv`](room_purposes.csv) · [`facility_upgrades.csv`](facility_upgrades.csv) · [`furniture.csv`](furniture.csv) · [`furniture_upgrades.csv`](furniture_upgrades.csv) |
| 행성 5곳 — 위협 · 생태 · 하늘 | [`planets.csv`](planets.csv) |
| **행성 진행도별 무기 등급 드롭 곡선** (앞쪽 행성에서 III 이상 봉인) | [`planet_loot.csv`](planet_loot.csv) |
| **버려진 구조물 · 선로 플랫폼 · 전차** — 개수 · 크기 · 컨테이너 수 · 지하실 확률 · 상자 티어 가중치 | [`structures.csv`](structures.csv) |
| **환경 재해 4종** — 색 · 입자 밀도 · 벽 높이/두께 (규칙 수치는 `constants.csv`) | [`hazards.csv`](hazards.csv) |
| 함선 호출 (스트라타젬) | [`stratagems.csv`](stratagems.csv) |

각 파일의 첫 줄들(`#` 로 시작)이 그 표의 열 하나하나가 무엇인지 설명한다. **파일을 열면 거기부터 읽는다.**

---

## 2. 쓰는 법

### 고쳐도 되는 것 · 안 되는 것

- **value / 숫자 칸은 마음껏 고친다.** 그게 이 폴더의 존재 이유다.
- **id · key · table · category · type 같은 식별자 칸은 바꾸지 않는다.** 코드가 그 이름으로 찾는다.
  이름을 바꾸면 `npm run data:check` 가 "줄이 없다" 로 잡아낸다.
- **줄을 지우거나 더해도 된다** — 아이템 · 적 · 레시피 · 계약처럼 목록인 표라면. 다만 코드가 이름으로 꼭
  집어 쓰는 줄(예: `constants.csv` 의 키, `enemies.csv` 의 10종)은 지우면 안 된다.
- **열 순서는 아무래도 좋다.** 코드는 헤더 이름으로 칸을 찾는다. 열 이름의 오타는 검사에서 잡힌다.

### 형식

- `#` 로 시작하는 줄과 빈 줄은 주석이다. 헤더는 `#` 가 아닌 첫 줄이다.
- 쉼표가 든 값(한국어 설명문 대부분)은 `"따옴표"` 로 감싼다. 따옴표 자체는 `""` 두 번.
- 빈 칸 = "없음". 선택 항목(예: 무기의 `adsZoom`)은 비워 두면 그 필드가 아예 안 붙는다.
- 목록은 `|` 로 나눈다 — `AR|SMG|SG`.
- 재료 · 보상처럼 "무엇을 몇 개" 인 칸은 `아이템id:수량` 을 `|` 로 잇는다 — `mat_scrap:8|mat_cable:2`.
- 숫자는 `1_000` 처럼 밑줄을 넣어도 되고, 색은 `0xffd27a` 16진수로 쓴다.
- 각도는 **도(°)** 로 적는다 (`spreadDeg`, `recoilDeg`). 코드가 라디안으로 바꾼다.

### `=` 식 — 다른 수치를 가리키기

칸이 `=` 로 시작하면 식이다. 이름 · 숫자 · `+ - * / ( )` 를 쓸 수 있다 (그 외에는 안 된다).

```csv
u_flame,인페르노,flamethrower,...,=FLAME_DPS,=FLAME_ALT_DPS,...,=FLAME_CONE_DEG/2
rogue_boss,rogue,=140*ROGUE_BOSS_HP_MUL,...
armor_3,방탄복 III,3,rare,...,=ARMOR_SHIELD_BY_TIER.3,...
```

이름은 이 순서로 찾는다:

1. `constants.csv` 의 키 — `=FLAME_DPS`
2. `tuning.csv` 의 키 — `=WEAPON_SALVAGE_BASE`
3. `tables.csv` 의 `표이름.키` — `=ARMOR_SHIELD_BY_TIER.3`

**왜 이게 필요한가:** 유니크 무기의 화염 피해는 `weapons_unique.csv` 에도 있고 실제 발사 코드에도 있다.
숫자를 양쪽에 베껴 두면 한쪽만 고쳤을 때 조용히 어긋난다. `=FLAME_DPS` 로 적어 두면 `constants.csv` 의
`FLAME_DPS` 한 줄만 고쳐도 표와 동작이 같이 움직인다.

---

## 3. 검사

```
npm run data:check
```

Vite 를 헤드리스로 띄워 **게임이 실제로 쓰는 로더 그대로** 읽는다. 그래서 검사 규칙이 따로 없고,
로더가 선언한 열 이름 · 필수 여부 · 허용값 · 범위가 그대로 검사 기준이다.

잡아내는 것:

- 없는 열, 빈 필수 칸, 숫자가 아닌 칸, 범위를 벗어난 값, 목록에 없는 열거값
- 쉼표가 든 값을 따옴표로 안 감싼 줄
- `=이름` 이 가리키는 상수가 없을 때
- 아무도 읽지 않는 csv 파일, `constants.csv` / `tuning.csv` 에서 아무도 읽지 않는 키

`npm run verify` 가 typecheck · net:selftest 와 함께 자동으로 돌린다.

> **브라우저에서는 잘못된 칸이 있어도 게임이 뜬다.** 문제를 모아 두고 기본값으로 계속 굴린다 —
> 오타 하나로 게임이 안 켜지면 수치 조정이 오히려 어려워지기 때문이다. 그래서 이 검사기가 있다.

---

## 4. 코드 쪽 구조 (읽는 쪽을 고칠 때만)

| 파일 | 역할 |
|---|---|
| [`src/shared/data/csv.ts`](../src/shared/data/csv.ts) | 파서 + 셀 접근자 (`num` · `str` · `enum` · `list` · `costList`), `=` 식 계산기, 문제 수집 |
| [`src/shared/data/tables.ts`](../src/shared/data/tables.ts) | `import.meta.glob` 로 csv 를 번들에 넣고 표 단위로 꺼내 준다 (`csvRows` · `keyTable` · `numberMap` · `costLevels` …) |

두 파일 모두 **`@/shared` 를 import 하지 않는다** — `shared/constants.ts` 가 이들을 쓰므로 순환이 된다.

csv 는 Vite 의 `import.meta.glob(..., { query: '?raw', eager: true })` 로 **빌드 시점에** 문자열로 인라인된다.
런타임 fetch 도, 배포본에 딸려 나가는 별도 파일도 없다 — 데스크톱(Electron) 빌드에서도 똑같이 동작한다.

### 새 수치를 추가할 때

- **전역 상수**: `constants.csv` 에 줄을 넣고 `src/shared/constants.ts` 에 `export const X = K.num('X');` 한 줄.
- **기능 폴더 스칼라**: `tuning.csv` 에 줄을 넣고 그 폴더에서 `keyTable('tuning.csv').num('X')`.
- **새 표**: `data/새이름.csv` 를 만들면 glob 이 알아서 잡는다. 읽는 코드를 쓰고,
  `scripts/data-check.mjs` 의 `DATA_OWNERS` 에 그 모듈을 더한다 (안 그러면 "고아 파일" 로 잡힌다).

### csv 로 옮기지 않은 것

숫자가 아닌 것들 — 한국어 라벨 · 아이콘 글리프 · 키 바인딩 기본값 · 저장 형식 버전 · `Layers` 같은 열거값 —
은 계속 TS 에 있다. `gadgets/GadgetDefs.ts` 와 `implants/ImplantDefs.ts` 의 표도 TS 에 남는데,
그 설명문이 `constants.csv` 의 상수를 그대로 찍기 때문이다 (csv 로 옮기면 설명문의 숫자가 수치와 따로 논다).
그 표들의 수치 자체는 전부 `constants.csv` 의 `GADGET_*` / `IMPLANT_*` 다.

### 2026-09-10 — 방탄복 = 실드 · 실드 충전기 3종

**방탄복은 이제 피해를 깎지 않고 실드(추가 체력)를 준다.** 피해는 실드를 먼저 비우고 남은 만큼만 체력(100)으로
간다. 실드는 스스로 재생하지 않는다 — 함선 안에서는 늘 가득이고, 레이드에서는 **실드 충전기**로만 채운다.

- **`tables.csv`**: `ARMOR_SHIELD_BY_TIER` (신규, key 0..5 = 0 / 20 / 40 / 60 / 80 / 100). `ARMOR_DR_BY_TIER` 는
  **지우지 않고 남겼다** — 이제 아무 계산에도 안 쓰이고, 유니크 방탄복 실드량을 환산한 근거로만 있다.
- **`armor.csv`**: `shield` 열 신규. 번호 방탄복은 `=ARMOR_SHIELD_BY_TIER.n` 으로 위 표를 가리키고, 유니크 3벌은
  `round(damageReduction / ARMOR_DR_BY_TIER.5 × 100)` 으로 환산한 값을 직접 적었다 — **재생 90 · 초경량 33 ·
  광학미채 27**. `rarity` 도 tier 에 맞춰 다시 맞췄다: `armor_1` 일반 · `_2` 고급 · `_3` 희귀 · `_4` 서사 ·
  `_5` **전설** (예전에는 common,common,uncommon,rare,epic 이라 5등급과 어긋났다). 설명문도 실드 기준으로 고쳤다.
- **`tuning.csv`**: `ARMOR_VALUE_DR_MUL`(4200) → **`ARMOR_VALUE_SHIELD_MUL`(12.6)**. 실드 = 뎀감률 ÷ 0.3 × 100
  이므로 `4200 × 0.3 ÷ 100 = 12.6` 이고 **가격은 한 푼도 안 바뀐다** (방탄복 I 832 … V 2400).
- **`constants.csv`**: `ARMOR_SHIELD_PER_SEGMENT`(20) 신규 — 좌하단 체력 · 실드 게이지 한 칸의 크기. 체력 100 과
  방탄복 V 실드 100 이 똑같이 5칸이 된다.
- **`items.csv`**: `shieldUseTime` · `shieldHp` 열 신규 (**`description` 뒤에 붙였다** — 나머지 줄은 그냥 비어 있다).
  이 두 칸이 채워진 줄이 곧 실드 충전기이고, `shieldHp` 가 **-1 이면 "완전 회복"** 이다. 새 줄 넷:
  `shield_charger` 실드 충전기 (일반, 2초, 실드 20, 스택 5) · `shield_charger_hi` 고출력 (고급, 4초, 40, 스택 5) ·
  `shield_charger_full` 완충 (희귀, 6초, 완전 회복, 스택 2) — 셋 다 `category: 'stim'` 이라 퀵슬롯 · 루팅 카테고리 ·
  손에 든 모습이 회복 소모품과 같은 길을 탄다 — 그리고 재료 `mat_core` **구동 코어** (일반 재료, 스택 10, ₩30).
- **`recipes.csv`**: `make_shield_charger` (코어 1 + 케이블 1) · `_hi` (코어 2 + 케이블 2, 제작 15) · `_full`
  (코어 4 + 케이블 3 + 회로 기판 1, 제작 35) — 전부 `station: field` 라 **레이드 현장에서 맨손으로 만든다**
  (작업대 요구 없음). 분해는 `break_shield_charger_hi` 하나 (→ 코어 1 + 케이블 1).
- **`loot_corpses.csv`**: 로그가 붕대와 함께 완제품을 들고 다닌다 — `rogue` 실드 충전기 26 % · 고출력 6 % ·
  구동 코어 30 %(1–2), `rogue_boss` 70 % · 30 % · 완충 8 % · 코어 80 %(1–3).
  ⚠ 로그 시체 표에 줄이 늘었으므로 `rollCorpse` 의 rng 소비가 예전과 다르다 (고정 벡터를 세는 스모크 주의).
- **`loot_item_weights.csv`**: `mat_core` 티어 1 ×1.5 · 2 ×1.2 · 3 ×1 · 5 ×0, `shield_charger` 티어 1 ×0.5 ·
  2 ×0.8 (붕대 공급을 밀어내지 않게), 고급/완충은 낮은 티어에서 0.

### 2026-09-10 — 보조무기 제거 · 분대 인원별 웨이브 · 전차 가속

- **`weapons.csv`**: 권총 줄(`hg`)이 사라져 무기 계열은 5종이다. 딸려서 `corp_stock.csv` 의
  `helix,secondary,PISTOL` 줄과 `loot_guaranteed.csv` 의 `4,primary|secondary` → `4,primary` 도 바뀌었다.
  게임에 보조무기 칸 자체가 없어졌기 때문이다 (타입은 남아 있다 — `src/shared/README.md` 참고).
- **`tables.csv`**: `WAVE_SQUAD_SCALE` (신규, key 0 = 분대 1명 … 3 = 4명). 탈출 웨이브 규모 표는 4인 분대
  기준이라 1인 분대가 세 번째 웨이브에서 점프 사냥꾼 두 마리를 한꺼번에 받았다 — 인원수만큼 깎는 배수다
  (`ROGUE_DROP_*` 와 같은 "분대 인원별 표" 규약).
- **`constants.csv`**: `TRAM_SPEED` 14 → **11.2**(예전의 0.8배), `TRAM_START_DELAY_S`(1) ·
  `TRAM_ACCEL_S`(3) 신규 — 전차가 시동 즉시 최고 속도로 튀어 나가 데크에 탄 사람이 떨어지던 문제.
- **`hazards.csv`**: `fogMul` 칸 신규 (아래 그 절에 자세히).

### 2026-09-09 — `currencies.csv` (신규)

재화(크레딧 · 경험치 · 기업 신뢰도) 정의표. `src/shared/currency.ts` 가 읽는다. **신뢰도(`rep`)는 템플릿
줄**이라 `corps.csv` 의 기업마다 `rep:<기업id>` 재화가 한 벌씩 생기고 이름 · 색은 그 기업의 것을 쓴다 —
신뢰도는 기업마다 별개의 재화이고 썸네일도 기업 색으로 달라야 하기 때문이다.

`constants.csv` 에 붙은 줄: `CHARACTER_SLOTS` · `CHAR_STAT_MIN` · `CHAR_STAT_MAX` · `CHAR_STAT_TOTAL` ·
`CHAR_NAME_RANDOM_MAX` (캐릭터 슬롯 · 생성), `UI_HOLD_CONFIRM_S` (위험한 버튼의 홀드 확정).
`HUB_WARP_SHAKE_PEAK` 은 0.28 → **0.14** 로 내렸다.

### 2026-09-09 — `structures.csv` (신규)

**버려진 구조물 · 선로 부속의 구성표.** 한 줄이 종류 하나다 — `outpost` (버려진 전진기지) · `lab`
(버려진 연구실) · `wreck` (불시착한 함선) · `rail_platform` (선로 플랫폼) · `tram` (전차).
`kind` 는 코드가 찾는 값이라 바꾸지 않는다. `src/world/structures/model.ts` 가 읽고
`src/world/Structures.ts` · `src/world/Rails.ts` 가 쓴다.

- `minCount`~`maxCount` — 한 맵에 놓이는 개수. `rail_platform` 은 선로 하나에 딸리는 수, `tram` 은 선로당
  대수다. **선로가 이번 맵에 놓이는지**는 `constants.csv` 의 `RAIL_CHANCE` 가 정한다.
- `halfW` / `halfD` / `wallH` — 바닥 반길이와 벽 높이(m). 지형은 이 크기에 맞춰 부지를 평탄화한다.
- `minGap` — 스폰 · 탈출 패드 · 둥지 · 다른 구조물에서 떨어져야 하는 최소 거리(m). 키우면 배치가 어려워져
  개수가 목표보다 적게 나올 수 있다.
- `containers` / `basementContainers` — 지상층(전차는 객실) · 지하실의 컨테이너 수.
- `basementChance` / `basementDepth` — 지하실이 딸릴 확률과 바닥 깊이(m). 0 이면 지하실이 없는 종류다.
  지하실이 있으면 그 구조물의 **지상층 컨테이너 하나에 키카드가 반드시 들어간다** (위 `key_basement`).
- `tiers` / `basementTiers` — `"상자티어:가중치"` 를 `|` 로 이어 쓴다. 티어 1~4 는 `loot_tiers.csv` 의 그
  티어이고, 이 표는 **어떤 티어의 상자가 몇 개 놓이나**만 정한다 (내용물은 여전히 상자 코드가 굴린다).
  전진기지는 무장 · 탄약 · 의료가 섞인 2티어 위주, 연구실은 감정 가치가 높은 3티어가 조금 더 많고,
  불시착 함선은 귀중품 · 취미품이 나오는 4티어가 유일하게 흔한 자리다. 지하실은 그 구조물의 최상급이다.

건물의 **치수 상수**(벽 두께 · 문 폭 · 계단 구멍 · 슬래브 두께)는 여기 없다 — 밸런스 수치가 아니라 그림의
문제라 `src/world/structures/model.ts` 에 둔다.


### 2026-09-09 — `hazards.csv` (신규) · 환경 재해

**환경 재해 4종의 그림 수치.** 한 줄이 재해 하나다 — `sandstorm` (모래 폭풍) · `blizzard` (눈보라) ·
`storm_eye` (폭풍의 눈) · `spores` (독성 포자). `kind` 는 코드가 찾는 값이라 바꾸지 않는다.
`src/world/hazard/model.ts` 가 읽고 `src/world/Hazard.ts` 가 쓴다.

- `fogColor` — 구역 **안에서** 포그 · 하늘에 섞어 넣을 색. 재해는 `atmo:override` 이벤트 하나로만 시야를
  좁히므로 이 색이 그 이벤트의 `color` 다. ⚠ 포그가 없는 행성(카민 I: `planets.csv` 의 `fog false`)에서는
  포그 농도를 곱해도 0이라 **색 · 시야 제한이 걸리지 않는다** — 그 행성에서 시야를 좁히는 것은 입자뿐이다.
- `particleColor` / `particleCount` / `particleSize` / `particleBox` — 카메라를 따라다니는 입자 구름.
  개수를 줄이면 그대로 성능이 붙고, `particleBox` 를 키우면 같은 개수가 넓게 퍼져 옅어진다.
- `driftMps` / `riseMps` — 입자가 옆으로 흐르는 · 위로 뜨는 속도(m/s). 눈보라만 `riseMps` 가 음수다(내린다).
- `fogMul` — **2026-09-10 신규.** 구역 한복판에서 포그 농도에 곱하는 배수 = **시야 제한의 세기**
  (경계에서 1 → 이 값으로 오른다). 7 이면 대략 50 m, 24 면 15 m 남짓이다. 예전에는 재해 넷이
  `constants.csv` 의 `HAZARD_FOG_MUL` 하나를 같이 썼는데, **폭풍의 눈**은 "안이 안 보여야 눈이 눈에 띈다"
  라 훨씬 커야 했다 (지금 24, 나머지는 7). `HAZARD_FOG_MUL` 은 줄을 못 찾았을 때의 기본값으로만 남았다.
- `wallColor` / `wallOpacity` / `wallHeight` / `frontBandM` — 경계에 서는 벽. `sandstorm` · `blizzard` 는
  전선을 따라 `frontBandM` 두께로 겹친 커튼, `storm_eye` · `spores` 는 열린 원통이다.
  ⚠ **폭풍의 눈 벽만 포그를 받지 않고 원통 3겹으로 선다** (2026-09-10, `hazard/parts/Visuals`) — `fogMul` 24
  안에서 포그를 먹이면 벽이 통째로 사라져 안전지대가 어느 쪽인지 알 방법이 없어진다.

**규칙 수치는 여기 없다.** 시작 시각(`HAZARD_START_MIN_S` · `MAX` · `STEP_S`) · 예고(`HAZARD_WARN_S`) ·
피해(`HAZARD_DPS` · `HAZARD_TICK_S`) · 봉쇄 시간(`HAZARD_FULL_S`) · 기본 시야 배수(`HAZARD_FOG_MUL`) ·
경계 폭(`HAZARD_EDGE_M`) · 폭풍의 눈 반경(`STORM_EYE_*`) · 포자(`SPORE_*`) 는 전부 `constants.csv` 이고,
**어느 행성에 어떤 재해가 오는지**는 `planets.csv` 의 `hazards` 열이다 (칸을 비우면 재해 없는 행성).

### 2026-09-09 — `planet_loot.csv` (신규) · 지하실 키카드

**행성 진행도에 따른 총기 등급 드롭 곡선.** `rank` 는 `planets.csv` 의 **줄 순번 1..5 = 난이도 순서**이고
(`shared/planetDefs` 의 `planetTier()`), `g1..g5` 가 그 행성에서 무기가 등급 I..V 로 나올 상대 가중치다 —
0 이면 그 행성에서 그 등급은 봉인이다. `uniqueMul` 은 **전설 유니크 무기**(등급이 없어
곡선을 못 탄다) 등장 확률에 곱하는 배수다 — 1·2번 행성 0(봉인) · 3번 0.4 · 4번 0.7 · 5번 1. **유니크 전용 탄약**
(연료통 · 전지 · 표창 · 화살 · 로켓 · 탄띠)도 같은 배수로 막힌다 (유니크 총에 딸려 나오는 한 스택은 예외). `src/items/LootTables.ts` 가 읽고 `Loot.rollCrateOn` /
`rollCorpseOn` 이 쓴다.

**총기 등급만** 여기서 정한다. `loot_tiers.csv` 의 `common..legendary` 열은 그대로 다른 카테고리
(부착물 · 방어구 · 임플란트 · 귀중품 …)의 희귀도를 정한다 — 앞쪽 행성의 총만 짜게 하려고 티어 표를
건드리면 총이 아닌 물건까지 같이 짜지기 때문이다. 상자 티어는 **무기가 얼마나 자주 나오나**
(`weaponChance`: 티어 1 = 0 · 2 = 0.35 · 3 = 0.55 · 4 = 1), 행성은 **나온 무기가 얼마나 좋은가** 를 맡는다.
실제 확률표는 `node scripts/check-planet-loot.mjs` 가 뽑는다.

`items.csv` 에 **`key_basement` 버려진 구조물의 지하실 키카드** (귀중품, 1×1, 스택 1, ₩0) 가 붙었다.
구조물이 자기 컨테이너에 직접 넣는 물건이라 `loot_item_weights.csv` 의 **티어 1~5 전부에 `mul 0`** 을
걸어 무작위 루팅에서 완전히 막아 뒀다. 그 다섯 줄을 지우면 귀중품 굴림에 섞여 나온다.
