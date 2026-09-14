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
| **조준 흔들림** — 무기 계열별 정조준 8자 흔들림의 크기 · 빈도 (자세 · 이동 배수는 `constants.csv` 의 `AIM_SWAY_*`) | [`aim_sway.csv`](aim_sway.csv) |
| 무기 부착물 | [`attachments.csv`](attachments.csv) |
| 탄약 · 가방(격자 · 퀵슬롯 · **내구도**) · 방탄복 | [`ammo.csv`](ammo.csv) · [`bags.csv`](bags.csv) · [`armor.csv`](armor.csv) |
| 일반 아이템 — 수류탄 · 회복 소모품 · **전투 소모품(`boostEffect`·`boostUseTime`)** · 귀중품 · 재료 · 약초 · **작물 · 토양(`soilTag`·`soilUses`) · 준비물(`prepEnv`·`prepShort`)** · 가젯 | [`items.csv`](items.csv) |
| 씨앗 | [`seeds.csv`](seeds.csv) |
| **서재 시리즈** (2026-09-13) — 책 · 비디오 · 레코드의 시리즈 한 줄: 권 수 · 등장 행성 · 효과 줄(전권 값) · 등급 · 대표 숙련. **아이템은 이 표에서 자동으로 만들어진다** (옛 `books.csv` · `discs.csv` · `records.csv` 는 없어졌다) | [`library_series.csv`](library_series.csv) |
| 옛 아이템 id → 새 아이템 id (옛 숙련별 책 · 디스크 · 레코드 → 새 시리즈 1권, 세이브 변환) | [`item_aliases.csv`](item_aliases.csv) |
| **비디오게임** (2026-09-13) — 게임기 · 게임 디스크 (규격 · 능력치 · 미니게임 튜닝 · 테마 색 · 등장 행성) | [`game_consoles.csv`](game_consoles.csv) · [`game_discs.csv`](game_discs.csv) |
| **미확인 표본** — 계열(세포 · 광물 · DNA) · 해석 시간 · 대체 산출물 · 은퇴 (연구실 분석기가 읽는다) | [`samples.csv`](samples.csv) |
| **분석기 결과표** — 계열 × 최소 분석 레벨 × 산출물 × 개수 × 가중치 | [`analysis_results.csv`](analysis_results.csv) |
| **소켓** — 흙 · 배지에 끼우는 영구 강화 (대상 · 효과 · 수치) | [`sockets.csv`](sockets.csv) |
| **요리** — 티어 · 능력치 줄(`effects`) · 은퇴 | [`meals.csv`](meals.csv) |
| **요리 미니게임** — 요리마다 단계(썰기 · 다지기 · 굽기 · 볶기 · 젓기 · 붓기) 순서 · 재료 · 붓는 양 / 굽기 조각이 익는 시간 | [`cook_steps.csv`](cook_steps.csv) · [`cook_grill.csv`](cook_grill.csv) |
| 임플란트 아이템 — 등급별 가격 · 수리 재료 · 전설 퍽 | [`implants_repair.csv`](implants_repair.csv) · [`implants_perks.csv`](implants_perks.csv) |
| **적** 기본 스탯 (벌레 · 로그 · **안드로이드 · 레이더** · 네임드 — `faction` 열) | [`enemies.csv`](enemies.csv) |
| **버그 굴착 스폰 · 지하벌레 이벤트** (2026-09-13) — 파고 나오는 시간 · 흔들림, 등장 확률(행성 threat) · 전조 · 분출 · 뱉기 · 독극물 | [`constants.csv`](constants.csv) 의 `BURROW_*` · `SANDWORM_*`, [`tables.csv`](tables.csv) 의 `SANDWORM_*` |
| 적 특수 능력 — 도약 · 산성 침 · 돌진 · 로그 AI · 포병 · 베헤모스 · **인간형 팩션별 AI · 총 계열(`HUMANOID_WEAPONS`)** | [`enemy_abilities.csv`](enemy_abilities.csv) |
| **행성 threat 별 인간형 적 배치** — 거점 점거 확률 · 그룹 수 · 그룹 크기 · 로그 분대장 · 레이더 강하 확률 · 파도 인원 · 네임드 확률 (`SITE_*` · `RAIDER_DROP_*` · `NAMED_ROGUE_CHANCE_BY_THREAT`) | [`tables.csv`](tables.csv) · [`constants.csv`](constants.csv) |
| **행성 threat 별 벌레 난이도** (2026-09-14) — 벌레 체력 배수 · 대형(차저 · 베헤모스 · 포병) / 중형(전사 · 스퓨어) 비중 배수 · 순찰 베헤모스 · 포병/베헤모스 상한 보너스 (`BUG_HP_MUL_BY_THREAT` · `BIG_BUG_WEIGHT_MUL_BY_THREAT` · `MID_BUG_WEIGHT_MUL_BY_THREAT` · `PATROL_BEHEMOTH_BY_THREAT` · `ARTILLERY_CAP_BONUS_BY_THREAT` · `BEHEMOTH_CAP_BONUS_BY_THREAT`) | [`tables.csv`](tables.csv) |
| **상자 루팅** — 티어 규칙 · 카테고리 가중치 · 확정 픽 · 아이템별 배수 | [`loot_tiers.csv`](loot_tiers.csv) · [`loot_category_weights.csv`](loot_category_weights.csv) · [`loot_guaranteed.csv`](loot_guaranteed.csv) · [`loot_item_weights.csv`](loot_item_weights.csv) |
| **시체 루팅** | [`loot_corpses.csv`](loot_corpses.csv) · [`loot_corpse_rolls.csv`](loot_corpse_rolls.csv) |
| **팩션 시체 루팅** — 안드로이드 · 로그 · 레이더의 총 등급 분포 · 방탄복 · 가방 · 회복 1회 굴림 · 스폰 거점 보너스(연구소 = 씨앗 · 미확인 표본, 전진기지 = 총 등급 교체) | [`loot_factions.csv`](loot_factions.csv) · [`loot_faction_sites.csv`](loot_faction_sites.csv) |
| **네임드 로그 확정 드롭** — 로든 저격소총 · 타길라 방탄복 · 헤비 미니건의 확률 · 등급 분포 | [`loot_named.csv`](loot_named.csv) |
| 제작 레시피 | [`recipes.csv`](recipes.csv) |
| **분해** — 무엇을 뜯으면 무엇이 나오나 (장비는 여기 없다 — 제작 재료에서 자동으로 만든다) | [`salvage.csv`](salvage.csv) |
| 능력치 · 숙련도 | [`stats.csv`](stats.csv) · [`skills.csv`](skills.csv) |
| 기업 · 판매 목록 · 계약 | [`corps.csv`](corps.csv) · [`corp_stock.csv`](corp_stock.csv) · [`contracts.csv`](contracts.csv) |
| **메신저 NPC · NPC 퀘스트** (2026-09-14 — 기업 퀘스트 `quests.csv` 대신. 첫 연락은 `intro` → `introChoices` → `introAfter` 3단이고 조건은 `reqLevel` · `reqRep` · `reqQuests` · `reqFlag`) | [`npcs.csv`](npcs.csv) · [`npc_quests.csv`](npc_quests.csv) · [`npc_objectives.csv`](npc_objectives.csv) |
| 함선 — 방 용도 증축 · 시설 강화 · 가구 | [`room_purposes.csv`](room_purposes.csv) · [`facility_upgrades.csv`](facility_upgrades.csv) · [`furniture.csv`](furniture.csv) · [`furniture_upgrades.csv`](furniture_upgrades.csv) |
| 행성 5곳 — 위협 · 생태 · 하늘 | [`planets.csv`](planets.csv) |
| **행성 진행도별 드롭 곡선** — ① 총기 등급(앞쪽 행성에서 III 이상 봉인) ② **총기가 아닌 것들의 희귀도 배수** | [`planet_loot.csv`](planet_loot.csv) |
| **버려진 구조물 · 선로 플랫폼 · 전차** — 개수 · 크기 · 컨테이너 수 · 지하실 확률 · 상자 티어 가중치 | [`structures.csv`](structures.csv) |
| **환경 재해 4종** — 색 · 입자 밀도 · 벽 높이/두께 (규칙 수치는 `constants.csv`) | [`hazards.csv`](hazards.csv) |
| 함선 호출 (스트라타젬) — **`cooldown` 은 네 호출이 함께 쓰는 하나의 쿨타임**이다 | [`stratagems.csv`](stratagems.csv) |

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
- (2026-09-11) **릴레이의 크레딧 검증 표 `server/economy.gen.json` 이 지금 csv 와 다를 때.** 아이템 가치 · 스택 · 임플란트 수리비 ·
  계약 / 퀘스트 크레딧 보상 · 상점 / 판매 배수 · `CREDITS_MAX` 를 바꾸면 릴레이가 옛 가격으로 `credits:tx` 를 검사하므로 실패한다.
  고치는 법은 한 줄이다:

  ```
  npm run data:check -- --write     # 표를 다시 만들고 → server/economy.gen.json 을 csv 와 함께 커밋한다
  ```

  표는 게임과 같은 모듈에서 만들어지고, 검사 때마다 표의 가격 식이 게임의 구매가 · 판매가 · 수리비와 모든 아이템 × 신뢰도 레벨 ×
  수량에서 같은지도 검산한다 (`scripts/economy-table.mjs`). 적 체력처럼 경제와 무관한 수치는 표를 바꾸지 않는다.

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

### 2026-09-14 (5차) — UI 2차 개편 수치: 제작 재료 절반 · 탄약 · 미니게임 판정 · 보관함 칸 (`recipes.csv` · `furniture.csv` · `salvage.csv` · `tables.csv` · `constants.csv` · `items.csv`)

사용자 결정. 리드가 직접 넣은 값이고, **코드 쪽은 이 표가 그대로여도 이미 관대해진다** — 미니게임의
「완벽 = 창의 1/3」 을 「완벽 = 창 그대로」 로 뒤집은 것이 먼저이고(`src/housing/parts/*Games.ts`), 아래 값은
그 **위에서** 난이도를 마저 내린 것이다.

- **제작 재료 절반** (`recipes.csv` · `furniture.csv` 작업대 9종). **반올림은 올림 · 최소 1**, 다만 **내구도가 있는
  장비**(무기 · 방탄복 · 가방)는 재료 종류당 **2 미만으로 내리지 않는다** — 수리비와 분해 산출이 같은 제작 재료에서
  나오므로(2026-09-10 제작 대개편) 1 이 되면 같은 구간의 `ceil(1 × 수리 배수)` 와 분해 최소 보장이 맞물려
  **재료가 스스로 늘어난다.** 그 불변식은 여전히 `src/items/Salvage.checkSalvageEconomy()` 가 실제 정수로 검산하고
  `npm run data:check` 가 매번 돌린다.
- **합금 판이 비싸졌다**: `refine_alloy` 폐금속 3 → **5**(`refine_weave` 는 천조각 6 → 5, `refine_ingot` 은 합금 판 2 → 1).
  그 대신 **합금 판을 쓰는 모든 레시피의 합금 판 수량이 절반**이다 — 총기 III–V · 부착물 14종 · 가젯 · 방탄복 III ·
  표창 · 로켓 · 코어 추출 · 내열 냉각재. 한 장의 값어치를 올리고 쓰는 양을 줄인 것이라 **한 번 제작에 드는 폐금속
  총량은 거의 그대로**이고, 바뀐 것은 「합금 판 한 장이 얼마나 귀한가」다.
- **탄약** — 재료가 전 계열 **`화약 1 + 폐금속 1`** 로 같아졌다 (중량탄의 합금 판이 폐금속으로 내려왔다).
  한 칸(`tables.csv` `AMMO_STACK_ROUNDS`) / 한 번 제작량은 경량 **60 / 20** · 준중량 **50 / 25** · 산탄 **20 / 10** ·
  중량 **20 / 10** — 한 칸이 제작 2–3회분이다. 분해(`salvage.csv`)는 그 짝으로 **「2회분의 절반」**(예: 경량탄 40발 →
  화약 1)까지 낮췄다. 옛 값(30발 → 화약 4–6)은 새 제작비 아래에서 **뜯을수록 이득**이라 `checkSalvageEconomy()` 가
  잡는다 — 탄약 수치를 다시 만질 때는 제작 · 분해를 **같이** 움직인다.
- **작업대 가구 9종의 제작 재료 절반** (`furniture.csv` 의 `craft`): 총기 · 장비 · 가젯 · 의학 · 가공 · 추출기 ·
  조합대 · 조리대 · 3D 프린터. 시설 가구는 함선의 관문이라 첫 벽이 너무 높았다.
- **미니게임 판정 창 25개 완화** (`constants.csv` 의 `GYM_*` · `COOK_*`): 벤치프레스 구역 0.12 → 0.18 · 완벽
  0.035 → 0.1125(= 구역 / 1.6), 커서 속도 0.9 → 0.75(회차 증가 0.12 → 0.08), 호흡 박자 0.6 → 0.8 · 묶음 6 → 5 ·
  「하」 떼기 0.22 → 0.26, 사이클 박자 0.45 → 0.65 · 횟수 24 → 16, 썰기 박자 0.5 → 0.75, 다지기 0.08 / 4.5 / 10 →
  0.1 / 5 / 12, 굽기 판정 호 0.05 / 0.15 → **0.10 / 0.25**(타는 지점 1.5 → 1.7 — 좋음 호가 거기 닿지 않게),
  볶기 박자 0.7 → 0.9, 젓기 5 / 0.9 / 0.4 → 4 / 0.8 / 0.25, 붓기 오차 0.04 / 0.3 → 0.08 / 0.45.
  ⚠ **볶기 창만 0.25 → 0.2 로 내렸다** — 넓히는 방향이 아니라 **반 박자를 넘지 않게** 하는 값이다
  (0.25 × 1.6 = 0.4 가 반 박자 0.45 에 닿아 실패 구간이 사라진다). 박자 게임은 창을 넓히는 대신 **박자를 늦춘다**
  (권장선 `창 × 1.6 ≤ 박자 × 0.32`): 창이 반 박자에 닿으면 좋음이 잘리고 죽은 구간이 0 이 되어 **연타가 최적
  전략**이 된다.
- **새 키 4개**: `GYM_GOOD_OF_PERFECT` 1.6 · `COOK_GOOD_OF_PERFECT` 1.6 (좋음 띠 = 완벽 띠 × 이 값 — 「보이는 것 =
  판정」의 짝) · `COOK_STEP_TIMEOUT_MUL` 3 (판정이 아니라 **멈춤 방지 안전핀**의 배수) · `AUDIO_DEFAULT_BGM` 0.6
  (음악 채널 기본 음량 — **소리는 나지 않는다**, 재생 창의 볼륨 표시가 이 값을 읽는다).
- **보관함 칸** — 책장 `BOOKS_PER_SHELF` 8 → **40**(4층 × 5칸 × 2줄) · 디스크 전시대 6 → **12** · 레코드랙 4 → **8** ·
  게임 디스크 전시대 6 → **12**. 층 수와 한 줄의 칸 수는 코드 계약(`shared/housing` 의 `SHELF_TIERS` ·
  `SHELF_TIER_COLS`)이고 **저장되는 것은 `slot` 하나**라 옛 세이브는 앞 칸이 그대로 남고 빈 칸만 는다 —
  마이그레이션이 없다.
- **실드 충전기 I 이 현장 제작**(`recipes.csv` 의 `make_shield_charger` `station` `ship` → **`field`**) — 레이드 중에
  구동 코어 1 + 전력 케이블 1 로 만든다. `bench medical` 은 그대로라 의학 작업대 창에도 계속 뜬다
  (2026-09-10 「`station: 'field'` + `bench` 는 모순이 아니다」 그대로).
- **연산 코어가 2×1**(`items.csv` 의 `width` 1 → 2) — 통합 채굴 화면의 코어 칸이 가로로 긴 아이템에 맞춰 그려진다.

### 2026-09-14 (4차) — NPC 첫 연락 조건 · 대사 3단 · 튜토리얼 전용 적 (`npcs.csv` · `enemies.csv` · `loot_corpses.csv` · `loot_corpse_rolls.csv` · `constants.csv`)

결정 `docs/DECISIONS.md` 「2026-09-14 — NPC 첫 연락 3단」 (사용자 결정).

- **`npcs.csv`** — 새 열 둘. **`reqFlag`** = `"플래그:횟수"` 를 `|` 로 (`NpcFlag` = `gathered` 채집 · `raidReturned` 레이드 복귀, 계약 `shared/npc.ts`).
  **`introAfter`** = 대사 선택지에 **답한 뒤** 이어지는 말풍선 (`introChoices` 가 있는 줄에만). NPC 10명 전부가 이제
  `intro`(인사 1–3마디) → `introChoices`/`introChoiceReplies` → `introAfter`(본론) 3단이고, `introAfter` 가 있으면 **답하기 전에는 퀘스트 제안이 오지 않는다**.
  첫 연락 조건: 민지후 `gathered:1` · 차유나 `raidReturned:1` · 오세라 `q_nm_s1` · 박도윤 `q_rv_1` (넷 다 `reqLevel` 없음) — 튜토리얼 직후 연락 오는 NPC 는 **레이븐 하나**다.
  `npc_quests.csv` 는 머리 주석만 (`decline` · `brief` 은퇴 표시 — 옛 기록을 풀기 위해 열은 남는다).
- **`enemies.csv`** 4줄 — 튜토리얼 전용 `tut_bug_loot` · `tut_bug`(scavenger 와 같은 수치, hp 120) · `tut_android_loot` · `tut_android`(android 280 의 **절반** 140).
  리그 · 겉모습 · AI · 소리는 바탕 종류의 것을 그대로 쓴다 (`EnemyTypes.baseTypeOf()` — 타입별 표에 줄을 더하지 않는다).
  튜토리얼 행성에는 threat 가 없어 `BUG_HP_MUL_BY_THREAT` 가 곱해지지 않는다 (`hpMul` 1).
- **`loot_corpses.csv`** 5줄 · **`loot_corpse_rolls.csv`** 1줄 — `tut_bug_loot` = 생체 조직 1 · 터미니드 분비선 1 (확률 1),
  `tut_android_loot` = 돌격소총 I · 전력 케이블 · 준중량탄 한 스택 (확률 1 · 내구도 최대), `tut_bug` · `tut_android` = **확률 0 안전핀**
  (표가 없으면 「모르는 적 = 생체 조직 1」 로 떨어진다 — `rogue_scan_drone` 과 같은 요령). 확률이 1 아니면 0 뿐이라 소비하는 draw 가 늘 같고,
  그래서 드론 스캔 미리보기와 실제로 여는 것이 저절로 같다 (`shared/lootRolls`).
- **`constants.csv`** 한 줄 — `TUTORIAL_INTRO_WAKE_S` 4.5 → **9** (오프닝 기상을 절반 속도로 · 밝아지는 데 약 2초).

### 2026-09-14 — 총기 밸런스 · 스탯 모델 · 소켓 규칙 · 확장 총열 (`weapons.csv` · `attachments.csv` · `aim_sway.csv` · `tables.csv` · `tuning.csv` · `recipes.csv`)

사용자 결정. 식 · 근거는 각 csv 머리 주석에 있고 여기는 요약과 **킬 시간 검산**이다.

- **`weapons.csv`** 7열 신규: `fireRateGradeStep`(SMG 0.06 · SG 0.12) · `adsTime`(AR 0.3 · SMG 0.18 · SG 0.2 · DMR 0.25 · SR 0.3 — 옛 전역 0.25) ·
  `bloomPerShot` / `bloomSpread`(옛 전역 0.14 / 1.6 → AR 0.3/1.2 · SMG 0.26/2 · SG 0.6/1 · DMR 0.3/1.6 · SR 0.5/1) · `projectileSpeed` · `bulletGravity` · `sockets`.
  조작감 칸(퍼짐 · 반동 · 조준 시간 · `aim_sway.csv`)은 이제 **등급 V 기준값**이고 등급 I–V 가 `tables.csv` 의 **`WEAPON_GRADE_HANDLING_MUL`**(×1.6 · 1.45 · 1.3 · 1.15 · 1.0)을 곱한다.
- 근거리 치명도 ("기본 피해를 올리고 거리 감소를 가파르게"): SMG 32→40 · 10→35 m ×0.3, SG 22→`=27*1.2`(= 27 × 전 거리 +20 % = 32.4 → 32) · 6→22 m ×0.15,
  DMR 120→130 · 반동 0.9→1.6°, SR 330→360, AR 60 그대로(퍼짐 1.4→1.6 · 정조준 0.3→0.36 · 반동 0.35→0.42 · 40→160 m ×0.45 · 흔들림 0.12→0.16).
- 탄도 (낙차 = ½ · g · (거리 / 속도)²): SMG 220 m/s · g 5.8 (100 m 0.60 m) · SG 180 · 5.2 (0.80) · AR 320 · 7.2 (0.35) · DMR 480 · 5.5 (0.12) · SR 650 · 5.1 (0.06).
- **`attachments.csv`** 4열 신규(`sway` · `falloffRange` · `falloffLoss` · `bulletDrop`), `classes` 정리(제동기 · 보정기 = AR|SMG|DMR|SR, 손잡이 = AR|SMG · 흔들림 ×0.8,
  개머리판 = AR · 흔들림 ×0.65), **`att_barrel_ext` 확장 총열**(희귀 · 총구 · AR|SMG|DMR|SR · 거리 ×1.35 · 손실 ×0.7 · 낙차 ×0.6, 가치 340). `recipes.csv` `make_att_barrel_ext`
  (폐금속 10 + 합금 판 4 + 기계 부품 2, 총기 Lv.3). 상자 · 보스 시체 · 세레스 상점은 부착물 카테고리 규칙으로 저절로 들어간다.
- **`tuning.csv`** `WEAPON_BLOOM_PER_SHOT_DEFAULT` · `WEAPON_BLOOM_SPREAD_DEFAULT` (계열 줄이 없는 유니크 무기용 0.14 / 1.6). `server/economy.gen.json` 재생성.
- 리드 후속: **`weapons.csv` `bloomDecay`** 열(초당 식는 양 — AR · SMG 2.6 · SG 0.45 · DMR 0.8 · SR 0.35, 유니크는 `tuning.csv` `WEAPON_BLOOM_DECAY_DEFAULT` 2.6).
  전역 2.6 이면 산탄 · 지정사수 · 저격의 연사 퍼짐이 한 발 간격 안에 다 식어 `bloomPerShot` 을 올려도 아무 일이 없었다.
  **`weapons_unique.csv` `bulletGravity`** 열 — 미니건 340 m/s · 7.2 (일반 사격 경로라 발사체가 된다, 전에는 속도 칸이 비어 히트스캔이었다).

**킬 시간 검산** — 몸통 명중, 거리 감소 전(근거리), 헤드샷 · 약점 배수 없음. 칸 = 필요한 발 수 (첫 발부터 마지막 발까지 초) · 체력 ×1.4(threat 3 행성) 발 수.
벌레 체력은 `enemies.csv` (스캐빈저 120 · 헌터 360 · 전사 640 · 스퓨어 520 · 차저 1800), threat 배수는 `tables.csv` `BUG_HP_MUL_BY_THREAT`(×1.0 · 1.2 · 1.4).

| 무기 | 한 발 (× 산탄) | rps | 초당 | 스캐빈저 | 헌터 | 전사 | 스퓨어 | 차저 |
|---|---|---|---|---|---|---|---|---|
| AR I | 60 | 10 | 600 | 2 (0.1 s) · 3 | 6 (0.5 s) · 9 | 11 (1.0 s) · 15 | 9 (0.8 s) · 13 | 30 (2.9 s) · 42 |
| AR V | 89 | 10 | 890 | 2 (0.1 s) · 2 | 5 (0.4 s) · 6 | 8 (0.7 s) · 11 | 6 (0.5 s) · 9 | 21 (2.0 s) · 29 |
| SMG I | 40 | 14 | 560 | 3 (0.14 s) · 5 | 9 (0.57 s) · 13 | 16 (1.07 s) · 23 | 13 (0.86 s) · 19 | 45 (3.1 s, 탄창 40) · 63 |
| SMG V | 59 | 17.36 | 1024 | 3 (0.12 s) · 3 | 7 (0.35 s) · 9 | 11 (0.58 s) · 16 | 9 (0.46 s) · 13 | 31 (1.7 s) · 43 |
| SG I | 32 × 8 = 256 | 1.3 | 333 | 1 · 1 | 2 (0.8 s) · 2 | 3 (1.5 s) · 4 | 3 (1.5 s) · 3 | 8 (5.4 s, 탄창 8) · 10 |
| SG V | 48 × 8 = 384 | 1.92 | 737 | 1 · 1 | 1 · 2 | 2 (0.5 s) · 3 | 2 (0.5 s) · 2 | 5 (2.1 s) · 7 |
| DMR I | 130 | 3 | 390 | 1 · 2 | 3 (0.7 s) · 4 | 5 (1.3 s) · 7 | 4 (1.0 s) · 6 | 14 (4.3 s) · 20 |
| DMR V | 192 | 3 | 576 | 1 · 1 | 2 (0.3 s) · 3 | 4 (1.0 s) · 5 | 3 (0.7 s) · 4 | 10 (3.0 s) · 14 |
| SR I | 360 | 0.9 | 324 | 1 · 1 | 1 · 2 | 2 (1.1 s) · 3 | 2 (1.1 s) · 3 | 5 (4.4 s) · 7 |
| SR V | 533 | 0.9 | 480 | 1 · 1 | 1 · 1 | 2 (1.1 s) · 2 | 1 · 2 | 4 (3.3 s) · 5 |

읽는 법: 근거리 초당 피해는 SMG V > AR V > SG V 순이지만 SG 는 한 방에 헌터까지 끝낸다(산탄 8알 전부 맞을 때). 거리가 붙으면 SMG 는 35 m, SG 는 22 m 부터 최저치
(×0.3 · ×0.15)라 AR(160 m ×0.45) · DMR · SR 이 이긴다. SMG I 로 차저를 잡으려면 한 탄창을 넘긴다 — 의도(확장 탄창 · 등급이 답).

### 2026-09-14 — 높은 threat 행성의 벌레 난이도 (`tables.csv` 6표)

사용자 결정: 벌레 체력이 행성 threat 로 오른다(×1.0 / 1.2 / 1.4), 「네임드 버그」 는 없으므로 **대형 벌레 비중 증가**로. 로더 `src/enemies/factionTables.ts` 의 `bugThreatTuning`,
적용은 `src/enemies/` (자세한 규칙은 `src/enemies/README.md` 의 *벌레 난이도*). key 0..2 = threat 1..3 이고 **threat 1 칸(× 1 · + 0 · 0)이면 예전과 비트 동일**하다 — 행성 없음 · 훈련장이 그 칸이다.

| 표 | 1 / 2 / 3 | 무엇에 곱하나 |
|---|---|---|
| `BUG_HP_MUL_BY_THREAT` | 1 · 1.2 · 1.4 | 팩션 bug 최대 체력 (전사 640 → 768 → 896). 지하벌레(`SANDWORM_HP_*`) · 인간형 제외. 경직 문턱(`staggerFraction`)도 늘어난 최대 체력 기준 |
| `BIG_BUG_WEIGHT_MUL_BY_THREAT` | 1 · 1.4 · 1.9 | `planets.csv` bugs 의 charger · behemoth · artillery 가중치, 순찰 대형 슬롯 확률(ramp 0.7 에서 8 → 11.2 → 15.2 %), 포병 굴착 확률(0.47 → 0.66 → 0.89) |
| `MID_BUG_WEIGHT_MUL_BY_THREAT` | 1 · 1.15 · 1.3 | warrior · spewer 가중치 — 중형 슬롯에서 헌터보다 조금 더 (지하벌레 뱉기 · 분출 무리도) |
| `PATROL_BEHEMOTH_BY_THREAT` | 0 · 0 · 1 | 1 = 순찰 대형 슬롯이 베헤모스도 뽑는다 (행성 bugs 에 있을 때만 — 지금은 피로스 VII 뿐, 상한을 넘으면 차저). 탈출 웨이브가 없어진 뒤 베헤모스가 나올 길이 없었다 |
| `ARTILLERY_CAP_BONUS_BY_THREAT` | 0 · 1 · 1 | `maxArtillery` + (피로스 VII 3 → 4 · 카민 I 2 → 3). +2 는 포병 5마리 동시 포격이라 체력 ×1.4 와 겹치면 과했다 |
| `BEHEMOTH_CAP_BONUS_BY_THREAT` | 0 · 1 · 1 | `maxBehemoth` + (피로스 VII 2 → 3) |

threat 2 칸의 상한 보너스는 지금 행성(보레아스 IX · 베르단트 III 에 포병 · 베헤모스 가중치가 없다)에서는 효과가 없다 — 가중치가 없는 종류는 여전히 안 나온다.

### 2026-09-13 — 전력 할당 폐지 · 발전기 = 상위 시설의 증축 조건 (`room_purposes.csv` · `facility_upgrades.csv` · `furniture.csv` · `tables.csv` · `tuning.csv` · `constants.csv`)

사용자 결정 「발전기의 전력 할당 시스템 너무 빡세다 — 제거하고 상위 시설을 짓는 조건으로만」. 아래 「암호화폐 채굴 데이터」 · 전력 열을 넣었던 같은 날의 작업을 되돌린다.
- **`room_purposes.csv`**: `power` 열 → **`generator`** 열 = 그 시설을 **증축**하는 데 필요한 발전기 레벨 — 작업실 1 · 온실 2 · 주방 2 · 연구실 3 · 헬스장 4 · 서재 4 · 채굴 시설 5
  (빈 칸 = `tuning.csv` 의 `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL`). 로더 `shared/housing` 의 `ROOM_PURPOSE_GENERATOR_LEVEL` · `purposeGeneratorLevel`.
- **`constants.csv`**: `GENERATOR_MAX_LEVEL` 10 → **5**, 새 줄 **`GENERATOR_START_LEVEL`** 1 (새 함선이 처음부터 그 레벨 — 가동이 없어졌다).
- **`facility_upgrades.csv`**: 발전기 Lv.6–10 줄 삭제, Lv.1 줄은 비움(쓰이지 않지만 표는 1 부터 이어져야 한다), Lv.2–5 를 무겁게 — Lv.2 폐금속 14 · 케이블 4 · 합금 3 /
  Lv.3 합금 10 · 케이블 6 · 회로 3 · 파워 셀 2 / Lv.4 합금 16 · 회로 6 · 파워 셀 4 · 강화합금 잉곳 4 · 축전 모듈 2 / Lv.5 잉곳 10 · 축전 모듈 5 · 회로 10 · 파워 셀 6 · 제어 모듈 3.
  가구 · 창고 강화의 발전기 게이트(Lv.n → 발전기 Lv.n)는 그대로다. 프로세서는 더 이상 발전기에 쓰이지 않는다.
- **`furniture.csv`**: `power` 열 삭제. **`tables.csv`**: `GENERATOR_POWER_BY_LEVEL` 삭제. **`tuning.csv`**: `COMPUTE_CLUSTER_POWER_PER_CORE` · `POWER_AUTO_TOPUP` 삭제,
  `ROOM_PURPOSE_BUILD_GENERATOR_LEVEL` 설명을 「기본값」 으로.

### 2026-09-13 — 서재 시리즈 · 비디오게임 (`library_series.csv` · `item_aliases.csv` · `game_consoles.csv` · `game_discs.csv` 신규, `books.csv` · `discs.csv` · `records.csv` 삭제 — 에이전트 D)

결정 `docs/DECISIONS.md` 「2026-09-13 — 서재 시리즈 · 비디오게임」 (사용자 결정). 효과 · 행성 로더는 `src/shared/library.ts`, 아이템 · 행성 드롭은 `src/items/` (자세한 표는 `src/items/README.md` 의 *서재 시리즈 · 비디오게임*).

- **`library_series.csv`** — 65 시리즈 → 아이템 164개. **책 43 시리즈 / 128권**: 숙련 상승량 16 (숙련 16종마다 하나, 단편 … V, 전권 +10 … +15 %) ·
  파생 8 (적재 +2 kg · 스태미나 +5 · 감지 +1.5 m · 배수 +3 % — 꽂는 즉시 적용이라 아주 작게) · 헬스 4 (기구마다 +0.08) · 요리 4 (썰기 · 다지기 · 굽기 · 볶기 +0.08) ·
  레이드 경험치 2 (+10 %) · 신뢰도 5 (전체 +8 % · 기업별 +15 %) · 레시피 4 (단편). **비디오 12 시리즈 / 26장** (단편 · II · III, 효과 2줄). **레코드 10장** (단편, 효과 3줄,
  threat 2 이상 행성 1–2곳). 책 · 비디오 시리즈는 행성 하나 — 책 amber 9 · tundra 9 · mossy 9 · ashen 8 · crimson 8, 비디오 3 · 3 · 2 · 2 · 2.
  아이템 쪽 열 `rarity`(비디오 · 레코드만 — 책은 등급이 없다) · `skill`(대표 숙련, skillGain 이 없는 시리즈는 필수). 옛 14 숙련은 전부 비디오 · 레코드 중 하나 이상의 효과 줄에 들어 있다.
- **`item_aliases.csv`** 42줄 — `book_<skill>` → 그 숙련 skillGain 책 시리즈 1권, `disc_<skill>` → 그 숙련이 든 비디오 1권(장비 관리 → 감정 · 장비 관리 촬영본), `record_<skill>` → 그 숙련이 든 레코드.
- **`game_consoles.csv`** 3줄 (펄스 스테이션 rare · 레트로 큐브 epic · 홀로 데크 legendary — 규격 `pulse` · `retro` · `holo`) · **`game_discs.csv`** 9줄 (게임기마다 3장, 지능 5 · 인지력 4,
  press · breath · cycle 3장씩, 속도 · 판정 폭 · 횟수 · 패턴 · 색이 전부 다르다). 둘 다 threat 2 이상 행성에서만.
- **`tables.csv`** — `BOOK_VALUE_BY_RARITY` → **`BOOK_VALUE_BY_VOLUME`** (권 1..5: 150 · 240 · 380 · 600 · 950), **`LIBRARY_VOLUME_DROP_WEIGHT`** (I 1 · II 0.45 · III 0.2 · IV 0.08 · V 0.03),
  **`LIBRARY_ITEM_RARITY`** (`book` = uncommon). `DISC_VALUE_BY_RARITY` · `RECORD_VALUE_BY_RARITY` 는 그대로(설명만), `BOOK_RARITY_MUL` 은 `shared/constants` 가 아직 읽어 남겼다(서재 계산에서는 은퇴).
- **`tuning.csv`** — `DISC_VALUE_VOLUME_STEP` 0.35 (비디오 뒤 권의 판매가 단계).
- **`loot_category_weights.csv`** — 책 3/3/2 → **4/4/3** (상점에서 빠진 만큼), 레코드 1/1.5 → **0.12 / 0.18**, 새 `game_disc` 0.15 / 0.15 · `console` 0.05 / 0.06 (티어 3 / 4).
  그 행성에 후보가 없는 카테고리는 추첨에서 빠진다. **실측(threat 2 이상, 상자 한 개당)**: 레코드 T3 0.17 % · T4 0.29 % · 게임 디스크 0.23 % · 0.21 % · 게임기 0.08 % · 0.09 %,
  맵 평균(티어 분포 가중) 0.04 % · 0.04 % · 0.02 % — 구조물 지하실 · 잠긴 방은 티어 3–4 컨테이너라 레이드당 기대치는 이보다 높다. threat 1(아켈론 II)은 셋 다 0.
- **`corp_stock.csv`** — 세레스 `book` · `disc` · `record` 줄 삭제 (게임기 · 게임 디스크도 팔지 않는다).
- **`meals.csv`** 4줄 · **`recipes.csv`** 4줄 · **`cook_steps.csv`** 10줄 — 레시피 책 요리: `meal_meat_pie` 고기 파이 (T2, 조리대 Lv.2) · `meal_bean_curry` 콩 커리 (T2, Lv.2) ·
  `meal_pork_cutlet` 돼지고기 커틀릿 (T3, Lv.3) · `meal_chicken_stirfry` 닭고기 볶음 (T3, Lv.3). 그 레시피 책이 꽂혀 있는 동안만 만든다 (`CraftRecipe.unlockSeries`, csv 열 없음 — 시리즈의 `recipe:` 효과에서 채운다).
- **`recipes.csv`** 3줄 — 3D 프린터 게임기 `print_console_pulse` (Lv.2) · `print_console_retro` (Lv.2) · `print_console_holo` (Lv.3). 게임기 가치는 재료 가치 합보다 조금 낮다.
- **`furniture.csv`** — 새 열 **`low`**(1 = TV 를 가리지 않는 낮은 가구). 새 줄 `furn_game_stand` 게임 디스크 전시대(library · front · multi) · `furn_sofa` 쇼파(any · seat · multi) ·
  `furn_low_table` 좌식 테이블(low) · `furn_rug` 러그(low). `furn_chair` 가 `seat` + multi, 책장 · 디스크 전시대 · 레코드랙 multi 1. 서재 보관함 · 보조 가구 · TV · 3D 프린터 설명을 시리즈 규칙에 맞게 고쳤다 (숫자 없음).
- `server/economy.gen.json` 재생성 (새 아이템 가치 176개, 옛 42개 제거).

### 2026-09-13 — 암호화폐 채굴 데이터: 프로세서 · 연산 코어 (`items.csv` 2줄 · `recipes.csv` · `loot_item_weights.csv` · `loot_corpses.csv` · `facility_upgrades.csv` · `crypto.csv`)

- **`items.csv`**: `mat_processor`(전설 1×1 · 스택 3 · 가치 3000) · `mat_compute_core`(전설 1×1 · 스택 9 = 클러스터 한 대분 · 3200), 제어 모듈 바로 뒤.
- **`recipes.csv`**: `refine_compute_core` = 회로 기판 2 + 프로세서 1 → 연산 코어 1 (가공 작업대 Lv.2, 제작 30).
- **`loot_item_weights.csv`**: 프로세서 티어 1–3 `0` · 티어 4 `2` · 티어 5 `0.5`, 연산 코어 전 티어 `0`. **역산**: 모의 굴림으로 「티어 4 컨테이너 하나당 ≈ 2 %,
  보급 투하 하나당 ≈ 0.5 %」 에 맞췄다(실측 2.2 % · 0.6–0.7 %, 아켈론 II 는 `legMul` 때문에 0.9 %). 희귀도 가중치(`loot_tiers.csv`)나 다른 재료 배수를 바꾸면 이 몫도
  움직인다 — 레이드당 기대치 계산은 `src/items/README.md` 의 *프로세서 · 연산 코어* 절.
- **`loot_corpses.csv`**: `android,mat_processor,1,1,0.002`.
- **`facility_upgrades.csv`**: 발전기 Lv.9 `+mat_processor:1` · Lv.10 `+mat_processor:2`.
- **`crypto.csv`**: 펄스 `yieldUnits` 20 → 21 · 보이드 16 → 17 — 코어 9개 시간당 벌이(기준 시세)가 열린 코인 1330–1536 · 기업 코인 1799–1997 C 로 목표 1300–2000 안에 든다.
- `quests.csv` 의 채굴 인가 4줄은 그대로 (프로세서를 해금 비용으로 쓰지 않는다).

### 2026-09-13 — 요리 미니게임 · 요리 품질 (`cook_steps.csv` · `cook_grill.csv` 신규 · `constants.csv` `COOK_*` · `tables.csv` 3표 · `furniture.csv` 4줄)

결정 `docs/DECISIONS.md` 「2026-09-13 — 요리 미니게임」 (사용자 결정). 로더는 `src/shared/cooking.ts` 하나다.
- **`cook_steps.csv`**: `meal,order,game,items,liquid,targetMl` — 조리대 요리 17종의 미니게임 순서(간단한 음식 1 · 일반 2 · 상위 티어 3단계).
  `items` 는 도마 · 그릴 · 팬에 오르는 재료(굽기 = 조각 2–3개), 붓기만 `liquid`(water · oil · milk · egg) · `targetMl`. 로더가 게임별 칸 규칙을,
  `data:check` 가 요리 · 재료 참조 · **조리대 레시피 산출물마다 단계가 있는지** · 순서가 1 부터 이어지는지를 본다.
- **`cook_grill.csv`**: `defId,seconds` — 굽기 조각이 0 → 100 % 익는 시간. 없으면 `COOK_GRILL_DEFAULT_S`. 한 판에 속도가 다른 조각이 섞여야 타이밍이 엇갈린다.
- **`constants.csv`** 끝 블록 `COOK_*` 40줄 — 여섯 게임의 판정 창 · 박자 · 채움량 · 온도 · 붓기 램프(사용자 명세 0.3 초) · 완벽/0점 경계.
- **`tables.csv`**: `COOK_AUTO_SCORE_BY_LEVEL`(자동 조리 가구 레벨 → 자동 점수, Lv.1 0 · Lv.2 0.6 · Lv.3 1) · `MEAL_QUALITY_SCORE_MIN`(별 0–5 에 필요한 요리 점수
  0 · .2 · .4 · .6 · .8 · .95) · `MEAL_QUALITY_BONUS`(별별 능력치 수치 보너스 0 … +25 %) — 셋 다 사용자 결정 값이다.
- **`furniture.csv`** · **`furniture_upgrades.csv`**: 주방 자동 조리 가구 4종 `furn_food_processor` · `furn_auto_grill` · `furn_auto_stirrer` · `furn_pour_dispenser`
  (maxLevel 3, 강화비 8줄). 판매가 · 경제 표는 바뀌지 않았다 (품질은 판매가와 무관) — `server/economy.gen.json` 재생성 불필요.

### 2026-09-13 — 행성별 적 팩션: 안드로이드 · 로그 · 레이더 (`enemies.csv` · `tables.csv` · `constants.csv` · `loot_factions.csv` · `loot_faction_sites.csv` 신규)

결정 `docs/DECISIONS.md` 「2026-09-13 — 행성별 적 팩션」. 어떤 인간형 팩션이 나오는지는 **행성 threat**(`planets.csv`)가 정한다 — 1 = 안드로이드 · 2 = 로그 / 레이더 · 3 = 레이더만.

- **`enemies.csv`** — `android`(hp 280) · `raider`(hp 840) 줄, `rogue` hp 280 → 560, 네임드 3종 + 스캔 드론 `faction` = `raider`.
- **`enemy_abilities.csv`** — `HUMANOID_WEAPONS`(팩션별 총 계열: android `ar|smg` · rogue `ar|smg|sg|dmr` · raider `ar|dmr|smg|sg`) + 팩션별 AI 블록.
- **`tables.csv`** 신규 절 — key 0..2 = threat 1..3: `SITE_OCCUPY_CHANCE_STRUCTURE` 1/1/1 · `SITE_OCCUPY_CHANCE_PLATFORM` 0/0.6/0.6 · `SITE_OCCUPY_CHANCE_RUIN` 0/0.2/0.2 (첫 구현 0.5 — 인원 39–44명이 나와 후속 결정으로 내렸다) ·
  `SITE_RAIDER_SHARE_STRUCTURE` 0/0.35/1 · `SITE_RAIDER_SHARE_OUTLYING` 0/0/1 · `SITE_INDOOR_GROUPS` 1/1/1 · `SITE_OUTDOOR_GROUPS_MIN/MAX` 1/1/1 · 2/1/1 ·
  `SITE_GROUP_SIZE_MIN/MAX` 1/3/3 · 2/4/4 (연구소 · 전진기지) · `SITE_OUTLYING_GROUP_SIZE_MIN/MAX` 1/2/2 · 2/3/3 (플랫폼 · 폐허) · `SITE_BOSS_CHANCE` 0/0.4/0 · `RAIDER_DROP_CHANCE_BY_THREAT` 0/0.45/0.45 · `NAMED_ROGUE_CHANCE_BY_THREAT` 0/0.25/0.5.
  key 0..3 = 분대 인원 1..4: `RAIDER_DROP_WAVE1_MIN/MAX` 3,3,3,4 · `RAIDER_DROP_WAVE2_MIN/MAX` 0,2,3,3 / 0,2,3,4.
- **`constants.csv`** 신규 절 — `SITE_BOSS_MAX_PER_RAID` 1 · `SITE_GROUP_MIN_GAP_M` 2.2 · `SITE_GROUP_LEASH_INDOOR_M` 4 · `SITE_GROUP_LEASH_OUTDOOR_M` 30 ·
  `RAIDER_DROP_WAVE_GAP_S` 10 · `RAIDER_DROP_WAVE_MAX` 4.
- **은퇴(줄은 남긴다 — `shared/constants.ts` 가 아직 읽는다)**: `ROGUE_DROP_CHANCE` · `ROGUE_DROP_COUNT_MIN/MAX` · `ROGUE_DROP_BOSS_CHANCE` · `NAMED_ROGUE_CHANCE_BY_RANK`,
  `planets.csv` 의 `rogues` · `boss` 열(계약 필드라 로더는 읽지만 효과 없음).
- **`loot_factions.csv`** (신규) — `type,weaponGrades,armorChance,armorPool,armorRarity,bagChance,bagPool,bagRarity,gearDurMin,gearDurMax,healChance,healPool,healRarity`.
  안드로이드 총 I 95 · II 5, 회복 = 실드 충전기만 35 % · 방탄복 · 가방 없음 / 로그 85 · 14 · 1, 방탄복 5 % · 가방 3 % (최대 고급), 회복 1회 40 % / 레이더 50 · 45 · 4.5 · 0.5,
  방탄복 90 · 9.5 · 0.5. 방탄복 · 가방 내구도 5–15 %. 희귀도 굴림은 chance → `*Rarity`(행성 희귀도 배수) → `*Pool` 에서 균등, 총 등급은 행성 상한을 그대로 받는다.
- **`loot_faction_sites.csv`** (신규) — `type,site,kind(grades|item|seed),target,grades,qtyMin,qtyMax,chance`. 레이더 연구소 = 씨앗(그 행성 `seeds`) · 미확인 세포/광물/DNA,
  레이더 전진기지 = 총 등급 표 교체(30 · 55 · 13 · 2).
- **`loot_corpses.csv`** — 로그의 독립 붕대 · 충전기 · 전투 소모품 · 고폭 수류탄 줄 삭제(수류탄은 **던지지 못하고 남은 것**이 굴림 없이 그대로 들어간다), android 4 · raider 5줄.
  `loot_corpse_rolls.csv` 에 android · raider. 벌레 · 로그 분대장 · 네임드 출력은 비트 동일.
- **`contracts.csv`** — 바스티온 킬 계약 설명 「인간형 적 n명을 처치한다」 (`kill_rogues` 가 인간형 팩션 전부를 센다).

### 2026-09-13 — 환경 재해 세기 · 독성 포자 배치 · 탈출 패드 수 (`constants.csv` · `tables.csv` · `hazards.csv`)

- **`constants.csv`** 재해 절 끝에 14줄 (owner `world/Hazard` · `world/layout`): `HAZARD_DPS_MAX`(5 — 진행도 1 의 초당 피해, `HAZARD_DPS` 에서
  선형), `HAZARD_FOG_RAMP_START/END`(0.5 / 1.25 — `hazards.csv` fogMul 의 (fogMul − 1) 에 곱한다), `HAZARD_PARTICLE_RAMP_START/END`(0.35 / 1 —
  particleCount 에 곱한다), `HAZARD_FRONT_SPAWN_JITTER_RAD`(0.6 — 전선이 강하 지점 쪽 가장자리에서 들어오는 각도 흔들림), `STORM_EYE_START_MARGIN_M`(0 —
  폭풍의 눈 처음 반경 = 가장 먼 맵 꼭짓점까지 + 이 값), 독성 포자 레이드 배치 `SPORE_SPAWN_CENTER_M`(36) · `SPORE_CENTER_RADIUS_M`(170) ·
  `SPORE_GROVE_SPAWN_GAP_M`(80) · `SPORE_CENTER_GROVE_GAP_M`(80) · `EXTRACTION_OUTER_MIN_M`(200) · `EXTRACTION_PADS_SPORES_MIN/MAX`(2 / 3).
  `STORM_EYE_RADIUS_START` 는 이제 **하한**이다 (설명 갱신).
- **`tables.csv`** 배열 표 둘 신규 — `EXTRACTION_PADS_MIN_BY_THREAT` · `EXTRACTION_PADS_MAX_BY_THREAT` (key 0..2 = 행성 threat 1..3 → 2–3 · 2 · 1–2).
- **`hazards.csv`** — 모래 폭풍 · 눈보라 `wallOpacity` 0.34 / 0.30 → 0.5 / 0.46, `wallHeight` 72 → 110 (전선 벽이 멀리서 안 보였다 — 이제 포그도 받지 않는다).

### 2026-09-13 — 버그 굴착 스폰 · 지하벌레: `enemies.csv` 1줄 · `loot_corpses.csv` 1블록 · `constants.csv` `BURROW_*` · `SANDWORM_*` · `tables.csv` 2표

읽는 곳은 `src/shared/constants.ts` 의 같은 이름 export → `src/enemies` (`Pool.spawn` · `parts/Burrow` · `sandworm/Director`). 규칙은 `src/enemies/README.md` 의
`## 굴착 스폰 · 지하벌레`.

- **`enemies.csv`** `sandworm` (팩션 bug) — speed · accel 0 (움직이지 않는다), 반지름 2.2 · 높이 10 = 땅 위 몸통 캡슐, 머리(입) 구 1.5 · `headMul` 1.5,
  `mass` 1000 (다른 벌레가 늘 밀려난다), `staggerFraction` 99 (경직 없음). **`hp` 2500 은 자리표시자다** — 실제 최대 체력은 분출 순간 호스트가
  `SANDWORM_HP_MIN..MAX`(2000–3000, 사용자 결정)에서 굴려 분대에 보낸다.
- **`loot_corpses.csv`** `sandworm` 블록 — 보스급: 생체 조직 6–10 · 분비선 2–4 · 미확인 세포 2–4 (확정) · 광물 1–3 (0.8) · DNA 1–2 (0.6) · 생체 추출물 ·
  외계 유물 · 발광버섯 씨앗. 은퇴 아이템 없음. 경제 표(`server/economy.gen.json`)는 루팅을 보지 않아 다시 굽지 않았다 (`data:check` ok).
- **`constants.csv`** `BURROW_*` 5줄 — 파고 나오는 시간(1 s) · 묻힌 여분 깊이 · 흔들림 반경 · 세기 · **최소 간격**(겹치지 않게). `SANDWORM_*` 27줄 — 시각 창
  (150–420 s, 발동 시각은 앞쪽 절반) · 검사 간격 · 무리 반경(16 m) · 전조 5 s · 흔들림 반경 · 최대 세기 · 분출 반경 12 m · 피해 55 · 넉백 15 m/s · 체력 범위 ·
  솟는 시간 · 분출 무리 링 · 뱉기 단계 30 s · 간격 · 수 · 비행 시간 · 착지 거리 · 생존 상한 · 독극물 사거리 · 간격 · 연발 수.
- **`tables.csv`** `SANDWORM_CHANCE_BY_THREAT` (key = 행성 threat − 1: 0 · 0.25 · 0.7 — threat 1 은 없다) · `SANDWORM_BURST_BY_SQUAD` (분대 1–4명: 4 · 6 · 7 · 8).

### 2026-09-13 — 요리 재료 티어: `samples.csv` 계열 · `sockets.csv` (신규) · `items.csv` 7열 · `meals.csv` `effects` (에이전트 A)

결정 `docs/DECISIONS.md` 「2026-09-13 — 요리 재료 티어」 (사용자 결정). 분석기 결과표 `analysis_results.csv` · `tables.csv` · `tuning.csv` 의 흙/배지 마모 줄 ·
`constants.csv` 의 고철 광물 줄은 리드가 넣었다 — 아래는 그 표가 가리키는 **아이템 쪽**이다.

- **은퇴(`retired`)** 라는 개념이 생겼다 — `samples.csv` · `items.csv` · `meals.csv` 의 선택 bool 열. 은퇴한 아이템은 **정의만 남고**(이미 가진 것은
  사라지지 않는다) 모든 출처에서 빠진다. 상자 · 보급 추첨은 코드의 안전핀(`src/items/LootTables` 의 `isLootableDef`)이 csv 와 상관없이 막고,
  표끼리의 참조는 `npm run data:check` 가 잡는다: **`analysis_results.csv` 의 defId · 레시피 inputs / outputDefId / extraOutputs · `loot_corpses.csv` ·
  `planets.csv` 의 samples · 표본 rewardDefId · 세포주 strainOut / strainScaffoldOut** 이 없는 id 거나 은퇴한 id 면 실패한다.
- **`samples.csv`**: 새 필수 열 `family`(`cell` | `mineral` | `dna`) · 선택 `retired`. `first*` 열은 전부 비웠다 — 첫 해석 보너스가 없어졌고, 채우면
  로더가 잡는다. `analyzeHours` 는 이제 **분석 레벨 1 기준** 시간이다 (`ANALYSIS_TIME_MUL_BY_LEVEL` 이 깎는다), `rewardDefId`/`rewardQty` 는 결과표가
  비었을 때의 대체 산출물. 새 3종 `spec_cell` 미확인 세포(고급, ₩120, 2 h) · `spec_mineral` 미확인 광물(고급, ₩110, 1.5 h) · `spec_dna` 미확인 DNA
  (희귀, ₩260, 4 h). 옛 11종은 `retired 1` + 계열(조직 · 키틴 · 생체막 · 지방조직 · 근조직 = 세포 → 생체 조직 ×3 / 포자낭 · 유전자 시료 · 분비선 · 난포
  = DNA → 생체 추출물 ×1 / 결정 · 수지 = 광물 → 광물 추출물 ×1).
- **`sockets.csv`** (신규, owner items): `id,name,rarity,target,effect,amount,value,description` 14줄 — 토양 · 배지 × 촉진(speed I–III) · 결실/분열(yield
  I–II) · 안정(wear I–II). 분석기 DNA 결과로만 나온다. **`tuning.csv`** 에 `SOCKET_STACK_MAX` 5 · `SOCKET_WEIGHT` 0.05.
- **`items.csv`**: `boostUseTime` 뒤에 7열 — `soilDurability`(토양 필수: 부엽토 100 · 화산재토/동토 이탄/포자 부식토 150 · 광물토/염류 결정토 250) ·
  `mediumDurability`(배지 필수: 기본 100 · 강화 200) · `strainScaffoldOut`/`Qty`/`Hours`(스캐폴드가 든 칸의 산출 — 셋이 함께 있거나 함께 없다) ·
  `scaffold` · `retired`. 토양 설명의 「(수확 n회)」, 배지 설명의 횟수 · 퍼센트를 뺐다. 새 재료 **24줄**(세포주 8 · 고기 페이스트 · 종별 고기 4 · 동물기름 ·
  셀룰로스 · 배양 스캐폴드 · 암염 결정 · 소금 · 난백 단백질 · 카제인 · 유청 · 달걀 · 우유 · 치즈 — 전부 material 1×1). 옛 세포주 5종(`strain_*`)은
  `retired 1` + **strain 칸을 비웠다**(배양조가 받지 않는다), 배양 산물 5종(`cult_*`)도 `retired 1`. 필라멘트 설명을 새 재료에 맞췄다.
- **`meals.csv`**: `buff,amount` → **`effects`**(`버프:수치` 를 `|` 로) + `retired`. `tier` 1–4 이고 **티어 n = 능력치 n 줄**(로더가 검사, 은퇴 요리 제외).
  새 11종 — 페이스트 요리 3(티어 2) · 고기 요리 5(티어 3) · 유제품 요리 3(티어 4). 옛 특선 4종은 `retired 1`(티어 2 · 한 줄 그대로).
- **`recipes.csv`** 141 → 155줄: 옛 특선 조리 4줄 삭제 · `extract_medium_algae`(→ 셀룰로스 3) · 필라멘트 3줄 재료 교체 · 18줄 추가(추출기 소금 · 난백 단백질 ·
  유단백, 조합대 스캐폴드 · 달걀 · 우유 · 치즈, 조리대 11).
- **루팅**: `loot_corpses.csv` 벌레 8종의 표본 줄을 새 셋으로 (세포 대부분 · DNA 드물게 · 광물은 돌격 벌레 · 포병 · 베헤모스) — 줄 수가 바뀐 적은
  `rollCorpse` rng 소비가 밀린다(고정 굴림을 세는 테스트는 벌레 표를 쓰지 않는다). `loot_item_weights.csv` 표본 티어 3–5 = DNA 1 · 광물 0.3 · 세포 0.15
  (옛 표본 줄 삭제), 새 재료 24종 × 티어 1–5 = **0**. `planets.csv` 의 `samples` 는 세포 · 광물만. 상점 규칙(`corp_stock.csv`)은 새 아이템 · 은퇴 아이템
  어느 것도 팔지 않는다 (세레스 `material` 줄은 임플란트 수리 재료만).
- **`furniture.csv`** 설명만: 분석기 · 추출기 · 조합대 · 조리대 · 배양조. `server/economy.gen.json` 재생성 (새 아이템 가치).

### 2026-09-13 — 캐릭터 시트 연관 열 · 조종석 전용 가구 · 재배 속도 · 배지 레시피 · 책장 8칸

- **`stats.csv` · `skills.csv`**: 새 열 `derived` — 그 능력치 · 숙련이 바꾸는 **캐릭터 시트 파생 행의 키**(`|` 구분). 캐릭터 시트 툴팁의
  하이라이트가 이것을 읽고 `progression/defs.ts` 가 `DERIVED_PANEL_KEYS` 로 검사한다(능력치 행이 비면 오류). 총기 숙련은 일부러 비운다 —
  계열별 반동 · 장전은 파생 패널에 행이 없다. `derive.ts` 에 효과를 더하면 이 열도 같이 고친다.
- **`furniture.csv`**: `room` 에 **`cockpit`** 값이 생겼다 — `furn_implant_bay` · `furn_corp_computer` 가 조종석 전용이다(회수 불가).
  신규 `furn_drawer` 서랍장(꾸밈, 2×1, 폐금속 4 + 합금 1). 책장 설명에서 칸 수 「(6권)」 을 뺐다(툴팁이 보여 주는 숫자). 재배 스테이션 설명은
  「층이 늘어난다」 → 성장 속도.
- **`tuning.csv`**: `GROW_STATION_SPEED_PER_LEVEL`(0.15) — 재배 시간 ÷ (1 + 0.15 × (레벨 − 1)). 층은 이제 Lv.1 부터 3개다.
- **`recipes.csv`**: `extract_medium_basic` · `extract_medium_rich` 삭제. 추출기 배지 15줄 — 작물 8종 각 3개 → 기본 배지 1(Lv.1) · 약초 6종 각 3개 →
  기본 배지 2(Lv.1) · `cult_algae` 3개 → 고급 배지 1(Lv.2).
- **`constants.csv`**: `BOOKS_PER_SHELF` 6 → 8 (4층 × 2). 서재 배율 상한(`SHELF_GAIN_MAX`)은 그대로.

### 2026-09-12 — 특정 아이템 회수 계약: `contracts.csv` 의 `itemDefId` 열 + 8줄 (에이전트 E2)

- 새 목표 **`extract_with_items`** — `itemDefId` 아이템을 `target` 개 **몸에 지니고**(가방 격자 + 퀵슬롯 + 주머니, 창고 제외) 탈출하면
  달성. 정산 순간(`game/` 이 `game:complete` 전에 부른다 — 가방은 아직 그대로다)에 센다. `itemDefId` 열은 `desc` 뒤에 붙였고 다른 목표의
  줄은 비워 둔다 (옛 줄은 칸이 모자라도 된다). 빈 칸 · 쓰이지 않는 칸은 로더가, 모르는 id 는 `data-check.mjs` 의 새 참조 검사가 잡는다.
- 기업마다 둘, 아이템은 전부 레이드 루팅 전용(상점 규칙에 안 걸린다), 보상은 같은 신뢰도 레벨의 기존 계약과 같은 폭:

  | id | 기업 | Lv | 아이템 × 개수 | 신뢰도 · XP · 크레딧 |
  |---|---|---|---|---|
  | `helix_cores` | helix | 1 | `data_core` ×2 | 130 · 340 · 280 |
  | `helix_crypto` | helix | 3 | `data_core_encrypted` ×1 | 380 · 1000 · 900 |
  | `bastion_salvage` | bastion | 1 | `salvage_electronics` ×3 | 140 · 360 · 300 |
  | `bastion_parts` | bastion | 2 | `mat_machine_parts` ×8 | 250 · 660 · 540 |
  | `nomad_chips` | nomad | 0 | `cred_chip` ×5 | 60 · 160 · 110 |
  | `nomad_artifact` | nomad | 3 | `alien_artifact` ×1 | 400 · 1050 · 900 |
  | `ceres_samples` | ceres | 1 | `sample_canister` ×2 | 130 · 330 · 260 |
  | `ceres_pure` | ceres | 2 | `sample_canister_pure` ×1 | 250 · 640 · 500 |
- 크레딧 보상은 서버 검증 표에 들어간다 — `npm run data:check -- --write` 후 `server/economy.gen.json` 에 8줄이 늘었다.

### 2026-09-12 — 전투 소모품 3종: `items.csv` 의 `boostEffect`·`boostUseTime` · `constants.csv` `[A1]` 6줄 (에이전트 A1)

- **`items.csv`** 새 선택 열 **`boostEffect`**(`adrenaline` | `stimulant` | `implant_refill`) · **`boostUseTime`**(좌클릭 홀드 초) —
  `mediumSpeed` 뒤에 붙였다. 새 줄 셋, 전부 `category: stim` · 1×1 · 퀵슬롯 · 홀드 3 초: `boost_adrenaline` 아드레날린 주사
  (일반, 스택 3, ₩90, 0.12 kg) · `boost_stimulant` 각성제 (고급, 스택 3, ₩210, 0.12 kg) · `boost_stabilizer` 안정제 (희귀, 스택 2, ₩460, 0.2 kg).
  가치는 붕대 45 · 약초 붕대 130 · 회복주사 260 사이에 맞췄다. 설명 글에는 숫자가 없다 (툴팁이 `BOOST_*` 를 읽어 보여 준다).
- **`constants.csv` `[A1]`**: `BOOST_ADRENALINE_DURATION_S` 15 · `BOOST_STIMULANT_DURATION_S` 30 · `_RELOAD_SPEED_MUL` 1.3 ·
  `_ADS_SPEED_MUL` 1.4 · `_AIM_SWAY_MUL` 0.7 · `_STAMINA_COST_MUL` 1.5 (사용자 결정 수치).
- **`recipes.csv`**: 의학 작업대 `make_boost_adrenaline`(Lv.1, 주사기 1 + 혈근초 2, 의학 15) · `make_boost_stimulant`(Lv.2, 주사기 1 +
  소독약 1 + 잿빛잎 2, 의학 30) · `make_boost_stabilizer`(Lv.3, 주사기 1 + 회로 기판 1 + 발광버섯 1, 의학 40). 분해 줄은 없다.
- **`loot_item_weights.csv`** 7줄 (파일 끝 A1 묶음): 티어 1 아드레날린 0.6 · 각성제 0.4 · 안정제 0, 티어 2 안정제 0.6, 티어 5 셋 다 0.5 / 0.5 / 0.3.
  **`loot_corpses.csv`**: `rogue`(아드레날린 0.1 · 각성제 0.05) · `rogue_boss`(0.4 · 0.25 · 안정제 0.1) · 네임드 3종에 성격대로 (로든 = 각성제 ·
  타길라 = 아드레날린 · 헤비 = 셋). 상점은 `corp_stock.csv` 의 `ceres,stim` 규칙이 그대로 판다 (등급은 신뢰도 상한). `server/economy.gen.json` 재생성.

### 2026-09-12 — 조준 흔들림: `aim_sway.csv` (신규) · `constants.csv` `[A2]` 5줄

- **`aim_sway.csv`** 신규 (owner `src/weapons/AimSway.ts`, 소비 `player/CameraRig`) — `class,amplitudeDeg,frequencyHz`.
  정조준 중 카메라가 좌우 `amplitudeDeg` · 위아래 그 × `AIM_SWAY_PITCH_RATIO` 로 8자를 그린다 (위아래가 두 배 빠르다).
  값: **AR 0.12° @ 0.45 Hz · SMG 0.08° @ 0.6 · SG 0.1° @ 0.5 · DMR 0.2° @ 0.38 · SR 0.3° @ 0.32 · PISTOL 0.09° @ 0.65**.
  근거 — 흔들림은 각도라 조준경 배율이 화면 크기를 키운다: 저격소총(4배율, 세로 FOV 17.5°)의 0.3° 는 화면에서 또렷이 보이고
  100 m 에서 약 0.5 m 지만 최대 각속도가 약 0.6°/s 라 마우스로 따라잡힌다. 기본 정조준(FOV 50°) 무기는 거의 안 보일 만큼 작다.
  유니크는 `weapons_unique.csv` 의 `class` 를 따른다 (RMB 가 대체 사격인 유니크는 정조준이 없어 흔들림도 없다).
- **`constants.csv` `[A2]`**: `AIM_SWAY_PITCH_RATIO` 0.55 · `AIM_SWAY_CROUCH_MUL` 0.6 · `AIM_SWAY_PRONE_MUL` 0.25 (엎드려쏴가 저격의 답) ·
  `AIM_SWAY_MOVE_MUL` 1.8 (걷기 속도에서) · `AIM_SWAY_BLEND_RATE` 6 (크기 변화 감쇠). 스태미나는 요인이 아니다 (사용자 결정).
- `scripts/data-owners.mjs`: `DATA_OWNERS` 에 `/src/weapons/AimSway.ts`, `CSV_FOLDERS` 에 `aim_sway.csv → weapons, player`.

### 2026-09-12 — 소모형 만능 열쇠 · 연구소 잠긴 방 (`structures.csv` 5열 · 열쇠 줄)

결정 `docs/DECISIONS.md` 「2026-09-12 — 전투 소모품」 (사용자 결정, 수치는 에이전트 C).

- **`structures.csv`** — 끝에 5열: `key`(그 종류의 잠긴 문을 여는 아이템 id 이자 지상 컨테이너의 부가 열쇠) · `keyChance`(지상 컨테이너
  **하나마다** 그 열쇠가 부가로 들어 있을 확률 — 보장 없음) · `lockedMin`~`lockedMax`(2층 잠긴 방 컨테이너 수, 0 = 방 없음) ·
  `lockedTiers`(잠긴 방 상자 티어). 전진기지 `key_basement` 0.05 · 방 없음, **연구실 `basementChance` 0**(지하실 없음) ·
  `keycard_lab` 0.05 · 방 2–3 · `4:4|3:1`. 방은 **2층이 올라간 건물에만** 선다 (`upperChance`).
- **`items.csv`** — `key_basement` = **지하실 열쇠**(서사 · 스택 1 · ₩1200 · 0.08 kg · `⚿`), `keycard_lab` = **연구소 보안 키카드**(신규,
  서사 · 스택 1 · ₩1200 · 0.05 kg). 둘 다 만능 · 소모형 (같은 종류면 어느 건물이든 열고, 열면 1 개 사라진다).
- **루팅 (전부 드물게)** — `loot_category_weights.csv` `3,key,0.3` · `4,key,0.6` (상자 한 개당 약 0.5 % · 0.9 %) · `loot_item_weights.csv` 두 열쇠
  티어 3 · 4 `1`, 티어 1 · 2 · 5 `0`(안전핀) · `loot_corpses.csv` 로그 각 0.008 · 로그 보스 각 0.03 · 네임드 3종 각 0.05 ·
  `corp_stock.csv` `nomad,key,…` 신뢰도 3. 기대치 단언은 `scripts/check-planet-loot.mjs` 의 열쇠 절.
- `server/economy.gen.json` 을 다시 구웠다 (`data:check -- --write`, 열쇠 가치).

아래 `2026-09-09 — structures.csv` 절의 「지하실이 있으면 지상층 컨테이너 하나에 키카드가 반드시 들어간다」와
`2026-09-09 — planet_loot.csv · 지하실 키카드` 절의 「티어 1~5 전부 `mul 0`」은 **더 이상 사실이 아니다** (기록으로 남긴다).

### 2026-09-11 — 연구실: `samples.csv` (신규) · `items.csv` 의 `prepEnv`·`prepShort` · 표본 tuning 2줄

- **`samples.csv`** 신규 (표본 6종, owner `items`) — `id,name,rarity,value,analyzeHours,rewardDefId,rewardQty,firstDefId,firstQty,description`.
  `analyzeHours` 는 **도감이 텅 빈 상태에서의 실제 시간**(시간)이고 도감 진척 · 기지식 배수(`constants.csv` 의
  `ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`)가 거기서 깎는다 — 해석 속도를 바꾸고 싶으면 이 열 아니면 그 두 상수다.
  `first*` 는 선택 열이다 (**처음** 해석했을 때만 얹어 준다; 비워 두면 보너스 없음). 읽는 곳은
  `src/items/ItemDefs.ts` 의 `SAMPLE_ITEM_DEFS`(`seeds.csv` 로더와 같은 모양) 하나다.
- **`items.csv`** 새 선택 열 **`prepEnv`**(`heat` | `toxin`) · **`prepShort`**(HUD 배지용 짧은 이름) — 채워진 줄이
  곧 준비물(`category: 'prep'`, `ItemDef.prep`)이다. `soilTag`·`soilUses` 와 같은 선택 열 규약이라 다른 줄은 빈칸이다.
- **`tuning.csv`** 신규 2줄 (owner `items`): `SAMPLE_STACK_MAX` **3** (표본 한 칸에 겹치는 최대 수 — 해석은 한 번에
  하나씩이라 씨앗 5보다 적다) · `SAMPLE_WEIGHT` **0.4** (표본 1개 kg — 손질 안 한 덩어리라 `mat_bio_sample` 0.2 보다 무겁다).
  준비물은 `items.csv` 에 이미 `stackMax` · `weight` 칸이 있어 새 키가 없다.
- **루팅은 전부 csv 다 (코드 변경 0)** — `loot_category_weights.csv` 의 `sample` 티어 3·4·5 = **5 · 7 · 9**(티어 1·2 는
  줄 자체가 없다 = 차단), `loot_item_weights.csv` 가 티어 3 에서 `spec_genome` · `spec_crystal` 을 0 으로, 벌레 8종은
  `loot_corpses.csv`. `prep` 은 어느 루팅 표에도 줄이 없다 (조합대 전용).
- ⚠ 새 아이템 값 8종 때문에 **`server/economy.gen.json` 을 다시 구웠다** (`npm run data:check -- --write`).

### 2026-09-11 — C 항목 배치: 새 수치 · 표 (리드 기록)

- **`constants.csv`** 신규 6줄 (계약 커밋, `@/shared`): `HAZARD_ENEMY_DPS` 2 (재해 구역 안 적이 `HAZARD_TICK_S` 마다 받는
  조용한 초당 피해 — owner enemies), `GATHER_SALVAGE_QTY2_CHANCE` 0.3 · `GATHER_HERB_QTY2_CHANCE` 0.25 (옛 `world/Gather.ts`
  하드코딩 이관 — 값 동일), `GATHER_SALVAGE_CORE_CHANCE` 0.15 · `GATHER_SALVAGE_CORE_QTY` 1 (고철 더미 부가 구동 코어, 생성 때
  `rng.fork('gather_core')` 로 시드 결정 — 기존 난수 흐름을 밀지 않는다), `BAG_DURABILITY_PER_RAID` 10 (아래 절).
  읽는 폴더가 하나뿐인 값도 있지만 `tuning.csv` 키는 `DATA_OWNERS` 모듈에서만 "읽힘" 으로 세어져 병렬 작업 동안 `constants.csv`
  에 모았다.
- **`constants.csv`**: `STORM_EYE_RADIUS_END` 60 → **0** (C-15 — 끝까지 가도 60 m 안전지대가 남아 재해가 강제 탈출이 아니었다).
- **`tables.csv`**: `FOOTSTEP_MATERIAL_GAIN` 신규 (C-22, owner `audio/AudioSystem`) — 발소리 크기에 재질(`SurfaceMaterial` 11종)별로
  곱하는 배수. 음색 · 피치는 코드(`audio/Synth` 의 `footstep_<mat>`)다. `data:check` 가 이 표를 읽도록 `scripts/data-owners.mjs`
  의 `DATA_OWNERS` 에 `/src/audio/AudioSystem.ts` 를 넣었다.
- **`enemy_abilities.csv`**: `ARTILLERY_AI` 에 `maxRefusals` 3 · `refusalCooldown` 8 (C-24 — 궤적이 막혀 연속으로 거절되면 표적을
  바꾸고 쉰다).

### 2026-09-11 — C 항목 배치: 가방 내구도 · 전설 전술 가방 퀵슬롯 · 상위 재료 상자 배수

- **`bags.csv`**: `durabilityMax` 열 신규 (8종 전부 **100** — 등급별로 달리할 근거가 없어 같게 뒀다. 수리비가 이미
  제작 재료를 따라 등급별로 벌어진다). 장착 가방은 **레이드 1회마다** `constants.csv` 의 `BAG_DURABILITY_PER_RAID`(10)
  만큼 닳는다 — 탈출 성공 · 사망 중 먼저 온 쪽에서 한 번 (동작은 `src/inventory`). **0 이어도 격자 · 퀵슬롯은
  그대로**이고 수리비만 크다. 수리 · 분해는 방탄복과 같은 규칙(제작 재료 × 남은 내구도 구간 배수)이다 —
  `src/items/Salvage.ts` 의 `REPAIRABLE` 에 `bag` 이 들어갔고, `checkSalvageEconomy()` 가 가방도 구간 0–4 전부를
  검산하며, **"내구도 + 제작 레시피가 있는데 수리비가 비었다"** 를 새 위반으로 잡는다 (그 구멍이 곧 재료 없는 만피
  수리였다). 옛 세이브의 가방은 `durability` 가 없어 만피로 읽힌다.
  ⚠ 상자에서 나온 가방은 이제 내구도 55–100 % 를 굴린다 (`Loot.rollCrate` 의 `rng.next()` 한 번) — **같은 시드의
  상자에서 가방 뒤에 오는 아이템의 굴림이 밀린다.** 수용한 변화다.
- **`bags.csv`**: `bag_legendary_tac` 의 `quickSlots` 9 → **8** (휠은 8방향 — 9 번째 칸은 원래 없었고 인벤토리가 조용히
  8 로 잘랐다). 로더가 이제 `max: QUICK_SLOTS` 로 9 이상을 거절한다. 설명문 두 곳(`bags.csv` · `recipes.csv`) 도 8.
- **`loot_item_weights.csv`**: 상위 재료 5종(`mat_weave` · `mat_ballistic_fiber` · `mat_capacitor` · `mat_ingot` ·
  `mat_control_module`) × 티어 5 = 25줄 신규. 줄이 없던 때는 배수 1 이라 **상자 재료 픽 중 상위 재료가 티어 1 3.3 % ·
  2 14.3 % · 3 39.1 % · 4 48.5 % · 5 90.9 %** 였다 (티어 5 는 다른 재료가 거의 0 이라 사실상 강화 직조포). 목표는
  **티어 1–2 0 · 3 ≈5 % · 4 ≈10 % · 5 ≈15 %** 이고 결과는 **0 · 0 · 4.99 · 10.01 · 14.97 %** 다.
  **역산 절차** — 한 티어에서 `L` = 상위 재료가 아닌 재료의 `희귀도 가중치(loot_tiers.csv) × 배수` 합,
  `U` = 상위 재료 5종의 희귀도 가중치 합(배수 없이), 목표 비율 `s` 면 5종에 같은 배수 `k = s·L / ((1−s)·U)` 를 건다
  (같은 배수라 5종 사이의 비율은 희귀도 그대로다). 티어 3 `L 256 · U 164 → k 0.082`, 티어 4 `L 175 · U 165 → k 0.118`,
  티어 5 `L 5 · U 50 → k 0.0176`. 행성 희귀도 배수(`planet_loot.csv`)를 걸기 **전** 기준이다.
  **분해로 상위 재료가 나오는 것은 의도다** — 등급 IV–V 장비와 네임드 확정 드롭을 뜯으면 그 제작 재료의 상위 재료가
  돌아온다 (`salvage.csv` 가 아니라 `recipes.csv` 에서 자동 생성). 상자 배수는 "줍기" 경로만 조인다.

### 2026-09-11 — 새 가젯 3종 · 네임드 로그 확정 드롭 (`loot_named.csv` 신규)

- **`items.csv`**: 가젯 3줄 신규 (기존 줄 무변경) — `gad_remote_mine` 원격 지뢰 (rare, 1×1, 스택 4, ₩340, 1.2 kg) ·
  `gad_drone_ground` 지상 드론 (rare, 2×2, **스택 1**, ₩1 150, 4.8 kg) · `gad_drone_air` 공중 드론 (epic, 2×2,
  **스택 1**, ₩2 200, 3.6 kg). 드론은 꺼내도 소모되지 않고 파괴될 때 하나가 준다 (동작은 `src/gadgets`).
- **`recipes.csv`**: 가젯 작업대 3줄 (94 → 97) — `make_remote_mine` Lv.2 (화약 10 + 회로 기판 1 + 케이블 2, 제작 25) ·
  `make_drone_ground` Lv.2 (기계 부품 3 + 회로 기판 2 + 파워 셀 2 + 폐금속 6, 제작 30) · `make_drone_air` **Lv.3**
  (제어 모듈 1 + 축전 모듈 2 + 기계 부품 2 + 회로 기판 2, 제작 40 — 상위 재료라 정제 작업대를 거친다).
  가젯은 분해 · 수리 대상이 아니라 경제 검산에는 안 걸린다.
- **`loot_item_weights.csv`**: 셋 다 티어 1 에서 0. 원격 지뢰 티어 2 ×0.6, 지상 드론 티어 2 ×0.4 · 3 ×0.7,
  공중 드론 티어 2 ×0 · 3 ×0.4 · 4 ×0.8. 세레스 상점은 `gadget` 카테고리 전체를 팔아 따로 줄을 안 넣었다.
- **`loot_named.csv` (신규)**: `type,kind,target,chance,grades,magFracMin,magFracMax,ammoFracMin,ammoFracMax`.
  로든 = 저격소총(`kind weapon`, `target sr`) 85 % · 타길라 = 번호 방탄복(`kind armor`) 85 % — 둘 다
  `grades 3:60|4:33|5:7` (희귀 · 서사 · 전설) · 헤비 = `wpn_u_minigun` (`kind item`) 80 %. **내구도는 이 표에 없다** —
  `constants.csv` 의 `NAMED_LOOT_DURABILITY_MIN/MAX`(1–5 %). ⚠ **행성 곡선(`planet_loot.csv`)은 이 표에 걸리지
  않는다** (등급 상한 · `uniqueMul` · 희귀도 배수 전부) — "최소 희귀 등급부터" 가 사용자 명세다.
  읽는 코드는 `src/items/LootTables.ts` (이미 `DATA_OWNERS` 에 있다).
- **`loot_corpses.csv`**: `rogue_sniper` · `rogue_hammer` · `rogue_heavy` 블록 신규 (보스 수준 회복 · 충전기 · 재료 +
  공중 드론 20 % / 원격 지뢰 35 % / 지상 드론 15 % · 원격 지뢰 20 %), `rogue_scan_drone` 은 확률 0 한 줄 = 빈 결과.
  **`rogue` · `rogue_boss` 줄은 안 건드렸다** (줄이 늘면 rng 소비가 밀려 `inventory/__selftest__` 의 고정 굴림이 바뀐다).
- **`loot_corpse_rolls.csv`**: 네임드 3줄 — 서적 20 % · 망가진 임플란트 45 % (보스와 같은 가중치)만, 총 · 유니크 칸은 비움.

### 2026-09-10 — 점광원 예산 · 셰이더 선컴파일 (`constants.csv` 3줄 신규)

멀티플레이 도킹 · 강하 렉의 정체가 셰이더 컴파일이었고, 장면마다 점광원 개수가 달라 컴파일한 것을 다시 쓰지
못한 것이 절반이었다. 기존 줄은 손대지 않았다.

- **`SCENE_POINT_LIGHT_BUDGET`**(23) — 씬에 늘 보이는 점광원 개수. 모자라면 intensity 0 여분이 채운다
  (`core/LightBudget`). = 상주 광원 15(섬광 풀 6 · 원격 포드 3 · 탈출 함선 3 · 헬포드 · 신호탄 · 분대장 기기)
  + 함선 `HUB_POINT_LIGHTS` 8. 행성은 패드 3 + 콘솔 3 이라 레이드 중 여분은 2 개. **줄이려면 가장 밝은 장면의
  진짜 광원이 그 안에 드는지 먼저 본다** — 넘으면 개수가 흔들려 다시 컴파일되고 `smoke-lights` 가 실패한다.
- **`HUB_POINT_LIGHTS`**(8) — 함선이 한꺼번에 켜는 점광원. 광원 자리는 그대로이고 가까운 자리에만 불이 들어온다.
  6 으로 줄여 보니 격납고 안쪽 벽과 게이트가 어두워졌다 (스크린샷 비교).
- **`SHADER_WARMUP_TIMEOUT_S`**(8) — 새 장면의 셰이더를 기다리며 화면을 멈춰 두는 최대 시간(초).

### 2026-09-10 — 제작 대개편 (`salvage.csv` 신규 · `recipes.csv` 전면 개편)

**제작 · 분해 · 수리가 하나의 축으로 묶였다.** 어떤 장비의 "값어치" 를 정하는 자리는 이제
`recipes.csv` 의 그 줄 하나뿐이다 — 수리비도 분해 산출도 거기서 나온다.

- **`items.csv`**: **상위 재료 5종** 신규 (전부 `category: material`, 1×1, 스택 10) —
  `mat_weave` 강화 직조포(고급, ₩55, 0.35 kg) · `mat_ballistic_fiber` 복합 방탄섬유(희귀, ₩125, 0.95) ·
  `mat_capacitor` 축전 모듈(희귀, ₩140, 1.1) · `mat_ingot` 강화합금 잉곳(희귀, ₩95, 1.7) ·
  `mat_control_module` 제어 모듈(서사, ₩380, 1.5). 셋 다 **정제 작업대에서만** 나온다. 기존 줄은 안 건드렸다.
- **`recipes.csv`**: `group` 열이 사라졌다(분해가 나갔으므로). `bench` 에 **`refine`(정제 작업대)** 이 붙었다.
  줄 수 48 → **94**. 뺀 것: 총탄 대량 제작 4줄(`bulk_ammo_*`) · 분해 6줄. 더한 것: 정제 7 · 무기 25 ·
  방탄복 5 · 가방 8 · 부착물 14 · 가젯 12. 옮긴 것: 실드 충전기 3종이 `field` → **의학 작업대 Lv.1/2/3**,
  지뢰 · 제세동기의 작업대 레벨.
  ⚠ **내구도가 있는 장비 레시피의 재료는 한 종류당 2 이상**이어야 한다 (1 이면 수리비(올림)가 제작비와
  같아진다). `src/items/Salvage.ts` 의 `checkSalvageEconomy()` 가 검사한다.
- **`salvage.csv` (신규)**: `id,inputDefId,qty,outputs,scaleByDurability,duration,skill,skillRequired,description`.
  **손으로 정한 분해만** 여기 있다 (탄약 4 · 기계 부품 · 고출력 충전기 = 6줄). 무기 25 · 방탄복 5 · 가방 8 의
  분해는 `recipes.csv` 의 **제작 재료**에서 코드가 만든다 — 그래서 총을 뜯으면 그 등급이 요구한 상위 재료도 나온다.
  읽는 코드는 `src/items/Salvage.ts` (`scripts/data-check.mjs` 의 `DATA_OWNERS` 에 등록돼 있다).
- **`tables.csv`**: `REPAIR_COST_BY_DURABILITY`(0.5 / 0.4 / 0.3 / 0.2 / 0.1) · `SALVAGE_YIELD_BY_DURABILITY`
  (0.08 / 0.16 / 0.24 / 0.32 / 0.40) 신규 — key 0 = 0~20 % … 4 = 81~100 %. **수리는 제작 재료 × 배수(올림),
  분해는 × 배수(내림)** 이고 둘의 합이 늘 1 보다 작아 무한 이득이 없다. `SALVAGE_CLASS_MUL` 은 삭제
  (총기 종류별 차이는 이제 레시피에 직접 적혀 있다).
- **`tuning.csv`**: `WEAPON_SALVAGE_BASE` · `WEAPON_SALVAGE_PER_GRADE` · `ARMOR_SALVAGE_BASE` ·
  `ARMOR_SALVAGE_PER_TIER` 삭제. 신규 `BAG_SALVAGE_DURATION`(5) · `SALVAGE_MAIN_MIN_YIELD`(1, 주재료 한
  종류만 0 으로 안 떨어진다) · `UNIQUE_REPAIR_MUL`(1.5, 제작 레시피가 없는 유니크의 수리 기준 = 같은 종류
  등급 V × 1.5).
- **`furniture.csv` · `furniture_upgrades.csv`**: `furn_bench_refine` 정제 작업대 (작업실, 4×2,
  `model=bench_refine`, `interaction=workbench_refine`, 제작 폐금속 10 + 합금 2 + 케이블 2, maxLevel 3) 와
  그 강화 비용 2줄.

### 2026-09-10 — 로그 강하 경보

- **`constants.csv`**: 새 블록 6줄 (전부 신규, 기존 줄은 손대지 않았다). 강하는 대기를 찢는 굉음이라
  **평소의 인지력 반경(`DETECT_ENEMY_BASE_RADIUS` 26 m)을 쓰지 않는다** — `ROGUE_DROP_ALERT_RADIUS`(260 m,
  인지력의 10배) 하나가 소리와 HUD 위험 표시를 함께 게이트한다. 그 대신 **감쇠는 남긴다**:
  `ROGUE_DROP_ALERT_FALLOFF_EXP`(1.3, 원격 발소리와 같은 곡선) · `ROGUE_DROP_ALARM_VOLUME`(0.95) ·
  `ROGUE_DROP_FALL_VOLUME`(0.9) · `ROGUE_DROP_MIN_VOLUME`(0.02) · `ROGUE_DROP_FALL_LEAD_S`(4.2 — 착지
  몇 초 전에 낙하 굉음이 시작되는가). `MAP_SIZE` 가 640 이므로 260 m 는 "맵 반대편까지는 안 들린다" 다.

### 2026-09-10 — `planet_loot.csv` 에 희귀도 배수 3열 (`rareMul` · `epicMul` · `legMul`)

**난이도 1 행성(아켈론 II)에서 희귀 이상이 나올 확률을 절반 수준으로 낮췄다.** `planet_loot.csv` 는 이제 축이
둘이다 — 기존 `g1..g5` · `uniqueMul` 은 **총기 등급**, 새 `rareMul` · `epicMul` · `legMul` 은 **총기가 아닌
나머지 전부**(방탄복 · 가방 · 부착물 · 임플란트 · 소모품 · 재료 · 귀중품 …)의 희귀도다. 두 축은 서로 안 움직인다.

- 값: rank 1 = **0.5 / 0.5 / 0.5**, rank 2~5 = 1 / 1 / 1. `uniqueMul` 은 손대지 않았다.
- 규칙: `loot_tiers.csv` 의 `rare` · `epic` · `legendary` 가중치에 배수를 곱하고, **깎인 총량을
  `common` · `uncommon` 의 원래 비율 그대로 되돌려** 준다 — 그래서 **가중치 합이 안 바뀐다**
  (예: 티어 3 `15/30/40/14/1` → `24.17/48.33/20/7/0.5`, 합 100 그대로).
- 배수가 셋 다 1 이면 코드가 조정 자체를 우회하므로 **rank 2~5 는 예전 결과와 비트 단위로 같다**
  (상자 · 시체 2만 회 굴림 서명 일치로 확인).
- ⚠ 배수는 **가중치** 배수라 실제 등장 비율은 등급별 아이템 종 수에 따라 달라진다. 실측(rank 1, 맵 티어
  분포 가중 평균): 희귀 이상 비율 방탄복·가방 22.4 % → **13.7 %**(0.61배) · 총기 제외 전체 18.7 % →
  **12.2 %**(0.65배) · 상자당 희귀 이상 개수 0.70 → **0.46개**(0.67배). 정확히 0.5배까지 내리려면
  배수를 0.37(방탄복·가방 기준) ~ 0.25(개수 기준) 로 더 낮춘다.
- 어디에 걸리나: **상자 전부**(티어 1~5, 보급 투하 포함) 와 **시체의 망가진 임플란트 굴림**
  (`loot_corpse_rolls.csv` 의 `implantWeights`). 시체의 나머지 드랍(`loot_corpses.csv`)은 아이템별 확률이지
  희귀도 추첨이 아니고, 보스 부착물은 등급으로 자른 뒤 균등 추첨이라 배수를 걸 자리가 없다.
- `node scripts/check-planet-loot.mjs` 가 이 축의 표도 같이 찍는다.

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
- `basementChance` / `basementDepth` — 지하실이 딸릴 확률과 **지형을 파는 깊이**(m). 0 이면 지하실이 없는 종류다.
  2026-09-11: 4.4 = 지하실 바닥판 0.3 + 천장 3.6 + 1층 바닥판 0.5. 전진기지 · 연구실의 `wallH` 는 **층의 천장 높이**(3.6 = PC 두 명).
- `upperChance` (2026-09-11) — 2층이 올라갈 확률. 0 = 늘 단층 (불시착 함선 · 선로 부속). 층수와 상관없이 옥상이 있다.
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

**총기 등급만** 여기서 정한다 (⚠ 2026-09-10 에 `rareMul` · `epicMul` · `legMul` 이 붙어 총기가 **아닌** 것들의
희귀도도 이 파일이 함께 다루게 됐다 — 위 그 절 참고. 여기 적힌 것은 `g1..g5` 축 이야기다).
`loot_tiers.csv` 의 `common..legendary` 열은 그대로 다른 카테고리
(부착물 · 방어구 · 임플란트 · 귀중품 …)의 희귀도를 정한다 — 앞쪽 행성의 총만 짜게 하려고 티어 표를
건드리면 총이 아닌 물건까지 같이 짜지기 때문이다. 상자 티어는 **무기가 얼마나 자주 나오나**
(`weaponChance`: 티어 1 = 0 · 2 = 0.35 · 3 = 0.55 · 4 = 1), 행성은 **나온 무기가 얼마나 좋은가** 를 맡는다.
실제 확률표는 `node scripts/check-planet-loot.mjs` 가 뽑는다.

`items.csv` 에 **`key_basement` 버려진 구조물의 지하실 키카드** (귀중품, 1×1, 스택 1, ₩0) 가 붙었다.
구조물이 자기 컨테이너에 직접 넣는 물건이라 `loot_item_weights.csv` 의 **티어 1~5 전부에 `mul 0`** 을
걸어 무작위 루팅에서 완전히 막아 뒀다. 그 다섯 줄을 지우면 귀중품 굴림에 섞여 나온다.

### 2026-09-14 (3차) — 튜토리얼 개편 · 낙하 피해: `constants.csv` 상수 8 · `npcs.csv` 의 대사 선택지 열 둘

결정 `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」 (리드 계약 커밋 — 수치만 먼저 놓고 구현은 폴더별로 따라온다).

- **`constants.csv` — 낙하 피해 3**: `FALL_DAMAGE_SAFE_M`(5 m 까지 공짜) · `FALL_DAMAGE_PER_M`(넘은 1 m 당 9) ·
  `FALL_DAMAGE_MAX`(260). 이것은 **전역 기능**이다(사용자 결정) — 실드 → 체력 순으로 평소 피해 경로를 그대로 타고 죽을 수 있다.
  안전 높이 5 m 는 함선 데크 · 2층 바닥 · 낮은 바위에서 뛰어내리는 평소 동선을 전부 덮는다.
- **`constants.csv` — 튜토리얼 5**: `TUTORIAL_ENEMY_SENSE_M`(12) · `TUTORIAL_ENEMY_LEASH_M`(22) · `TUTORIAL_RESPAWN_DELAY_S`(2.5) ·
  `TUTORIAL_INTRO_WAKE_S`(4.5) · `TUTORIAL_RAID_XP`(900 — 레벨 2 에 닿는 양). 감지 반경을 짧게 잡는 데는 이유가 있다 —
  체크포인트를 그 거리 **밖**에 두어야 무기를 잃고 부활한 사람이 자기 시체까지 갈 수 있다.
- **`constants.csv` — 자세별 몸 높이 2**: `PLAYER_CROUCH_CLEARANCE_M`(1.3) · `PLAYER_PRONE_CLEARANCE_M`(0.7).
  `WorldRef.resolveCollision(pos, r, height?)` 의 세 번째 인자를 드론만 쓰던 것을 **플레이어도 쓰게** 했다 —
  서 있을 때는 넘기지 않아(= `BOX_HEADROOM` 2.1) 본편 동선은 한 곳도 안 바뀐다. 그 밑에서 일어서는 것은
  `player/parts/Locomotion.canStandHere` 가 따로 막는다. 튜토리얼 포복 구간의 슬래브 밑면(1.6)은 **이 둘 사이**여야 한다.
- **`npcs.csv` — `introChoices` · `introChoiceReplies`**: 첫 연락 말풍선이 끝난 뒤에 뜨는 **내 대답 버튼**과 그 대답에 대한
  NPC 의 답 (둘 다 `|` 구분, **개수가 같아야 한다** — 로더가 검사한다). 비우면 선택지가 없다 (지금까지의 NPC 10명 전부).
  고른 뒤의 대화는 **어느 쪽이든 같다** — 분기 상태를 저장하지 않고 사건 하나(`choice`)만 남는다.
  처음 쓰는 것은 레이븐(`npc_raven`)의 튜토리얼 첫 연락이다 — **그 줄이 채워졌다**(에이전트 F): `intro` 를 **전 함선 주인의 연락책**으로
  다시 쓰고(통성명 없이 통신 코드로만 거래했으므로 주인이 바뀐 것을 눈치채지 못한다) 대답 **2개**(부정 / 수긍)를 달았다.
  부정을 골라도 레이븐은 믿지 않고 통신 보안 걱정으로 흘려 넘기므로 두 답이 **같은 자리로 흐른다** — 그래서 분기가 필요 없다.
  같은 배치에서 `npc_quests.csv` 에 레이븐의 첫 의뢰 `q_rv_0`(「첫 물건」, 크레딧 200 · XP 250 · `heal_syringe:2` · `npcTrust` 80)을
  `q_rv_1` 앞에 끼웠다 — 목표는 `kill 3 bug` + `recover 2 mat_scrap` 둘뿐이고(행성 조건 없음) 튜토리얼 트랙 ② 의 「레이븐의 의뢰를
  받는다」 가 이것을 가리킨다. 줄 순서 제안 규약대로 `q_rv_1` 에 `reqQuests=q_rv_0` 을 달았고, 크레딧 보상이 있으므로
  `npm run data:check -- --write` 로 `server/economy.gen.json` 을 다시 구웠다.

### 2026-09-14 (2차) — NPC 개인 신뢰도: `npc_quests.csv` 의 `npcTrust` · `npcs.csv` 의 `reqNpcRep` · 레이븐 `reqLevel`

결정 `docs/DECISIONS.md` 「2026-09-14 — 정보상」. 기업 신뢰도(`rewardRep`)와 **별개**인, NPC 한 명 한 명에 대한 개인 신뢰도다.
레벨 표는 기업과 **같은** `tables.csv` 의 `REP_TABLE`(0 / 100 / 300 / 700 / 1500 / 3000 = Lv.0–5) — 표를 하나 더 만들지 않았다(사용자 결정).

- **`npc_quests.csv` 새 열 `npcTrust`** — 이 퀘스트를 **낸 NPC** 의 개인 신뢰도 보상. `rewardRep` 과 **함께** 주고 서로를 대신하지 않으므로,
  무소속 NPC(레이븐 · 케인)는 기업 신뢰도가 없는 대신 이것을 넉넉히 받는다. **크레딧이 아니라 서버 검증(`credits:tx`)과 무관하다.**
  값은 체인 초반을 작게 · 후반을 크게 잡아 **그 NPC 의 체인을 다 깨면** 기업 NPC 는 Lv.3(1000–1300), 무소속은 Lv.4(1650)가 되게 했다:
  직원 체인 `100 · 200 · 300 · 400`, 임원 체인 `150 · 200(채굴 인가) · 300 · 450`(세레스 5줄은 `150 · 200 · 250 · 300 · 400`), 무소속 `250 · 350 · 450 · 600`.
- **`npcs.csv` · `npc_quests.csv` 의 `reqNpcRep`** = `npcId:레벨` 을 `|` 로 — NPC 개인 신뢰도 조건. 로더 · 판정(`meta/NpcRules.requirementMet`)은 있지만
  **지금은 어느 줄도 쓰지 않는다**(사용자 결정: 신뢰도별 해금 요소는 아직 정하지 않는다 — 적립 · 표시까지만).
- **`npcs.csv`** 레이븐(`npc_raven`)의 `reqLevel` 4 → **1**. 정보상을 1레벨부터 쓰기 위해서고, 무소속이라 기업 신뢰도 조건도 없어 사실상 처음부터 연락이 온다.
  케인(`npc_kane`)의 `reqQuests`(`q_rv_2`)는 그대로다.

### 2026-09-14 — 메신저 NPC 퀘스트: `npcs.csv` · `npc_quests.csv` · `npc_objectives.csv` (신규) · `quests.csv` 삭제 · `crypto.csv` · `tuning.csv`

결정 `docs/DECISIONS.md` 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」. 로더 `src/shared/npc.ts`(열 모양 · 열거 · 종류별 필수/불필요 열), 표끼리의 참조는 `npm run data:check`.

- **`npcs.csv`** `id,name,title,corp,role,color,glyph,reqLevel,reqRep,reqQuests,intro,bio` — `corp` 비움 = 무소속, `role` executive | staff | independent.
  첫 연락 조건 = `reqLevel` ∧ `reqRep`(`기업:레벨` | …) ∧ `reqQuests`(완료한 퀘스트 id | …). `intro` 는 `|` 로 말풍선을 나눈다.
- **`npc_quests.csv`** `id,npc,name,summary,reqLevel,reqRep,reqQuests,rewardCredits,rewardXp,rewardRep,rewardItems,npcTrust,offer,accept,decline,brief,complete` —
  같은 NPC 의 퀘스트는 **줄 순서대로 하나씩** 제안된다. `rewardRep` = `기업:양` | …, `rewardItems` = `아이템id:수량` | …. id 는 소문자 · 숫자 · `_`(크레딧 사유 `quest:<id>`).
  대사 5종은 `|` 로 말풍선을 나누고, 기록에는 사건만 남으므로 **대사를 고치면 옛 대화도 바뀐다**.
- **`npc_objectives.csv`** `quest,kind,target,item,enemy,weapon,site,interact,planet,chain,label` — 줄 순서 = 표시 순서.
  `kind` deliver(item) | recover(item) | interact(interact) | kill(enemy, weapon?) | discover(site) | search(site). `item` = 아이템 id 또는 `weapon:<AR|SMG|SR|DMR|SG>`.
  `enemy` = humanoid | rogue | raider | android | bug | named | 적 타입 id. `planet` · `chain` 은 레이드 목표만 (deliver 에 쓰면 로더가 잡는다).
  (아래 `2026-09-14 (2차)` 절에 `npcTrust` · `reqNpcRep` 설명이 있다.)
  data:check 가 보는 것: 모르는 NPC · 선행 · 아이템 · 보상 아이템 · 적, **그 행성에 그 적이 나올 수 있나**(안드로이드 threat 1 · 로그 threat 2 · 레이더 · 네임드 threat ≥ 2),
  퀘스트 없는 NPC, 중복 id, 채굴 해금 퀘스트의 `rewardCredits > 0`.
  **콘텐츠 규약** (초기 콘텐츠에서 정했다): 확률로만 서는 기믹을 요구하는 목표는 드물게 둔다 — 전차 · 연구소 잠긴 방 · 지하실 문은 각 퀘스트
  하나이고, 그 문을 여는 열쇠 · 키카드는 앞 퀘스트 보상으로 준다. 이런 목표에는 `chain` 을 걸지 않아 레이드를 넘어 누적된다.
  적 조건은 행성으로 좁힌다 — 안드로이드 = threat 1 · 레이더만 = threat 3 · 네임드 = 행성 조건 없이 후반 퀘스트에만.
- **`crypto.csv`** — `unlockQuest` 가 NPC 퀘스트 id(`q_hx_permit` · `q_bs_permit` · `q_nm_permit` · `q_ce_permit`)로 바뀌었다. 옛 `hx_crypto` 등의 해금 기록은 이어지지 않는다.
- **`tuning.csv`** — `NPC_LOG_MAX` 200 (NPC 한 명의 대화 사건 수) · `NPC_OFFER_CHECK_S` 5 (함선에서 연락 · 제안 조건을 다시 보는 간격).
- ⚠ 퀘스트 크레딧 보상을 고치면 `npm run data:check -- --write` 로 `server/economy.gen.json` 을 다시 굽는다 (릴레이가 `quest:<id>` 금액을 표로 검사한다).

### 2026-09-14 (3차) — `constants.csv` 의 `ROVER_CHANCE` (신규) · `intel_options.csv` 의 `rover` 줄

**탐사 차량 자연 배치가 확률이 됐다 (사용자 결정).** 전에는 `world/layout.ts` 가 굴림 없이 늘 흙길을 계획해
실측 배치율이 **100 %** 였고(`scripts/smoke-intel.mjs` 가 시드 480개로 쟀다), 그러면 정보상(레이븐)의
「탐사 차량 확정」(1000 크레딧)이 아무것도 사지 못한다.

- **`constants.csv` `ROVER_CHANCE` = 0.6** — `RAIL_CHANCE`(0.7) 바로 아래에 둔다. **1.0 이면 정보상의 `rover`
  줄이 값을 잃는다** — 값을 올릴 때 이것을 먼저 본다. 실측 배치율은 약 64 % 다 (`node scripts/smoke-intel.mjs`
  가 매번 `note 평소 배치율 — 흙길 … · 선로 …` 로 찍는다).
- 굴림은 `layout.ts` 가 **탐사 차량 전용 fork 의 첫 draw** 로 언제나 소비하고 결과만 덮는다 (정보상 규약과
  같다 — 건너뛰면 확정으로 산 맵의 정류장이 자연히 선 맵과 달라져 미리보기 지도가 거짓말을 한다).
- **`intel_options.csv`** `rover` 줄의 `note` 가 그 사실을 적는다 (`baseCost` · `maxTier` 는 그대로).
