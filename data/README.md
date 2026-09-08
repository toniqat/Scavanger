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
armor_3,방탄복 III,3,uncommon,=ARMOR_DR_BY_TIER.3,...
```

이름은 이 순서로 찾는다:

1. `constants.csv` 의 키 — `=FLAME_DPS`
2. `tuning.csv` 의 키 — `=WEAPON_SALVAGE_BASE`
3. `tables.csv` 의 `표이름.키` — `=ARMOR_DR_BY_TIER.3`

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
