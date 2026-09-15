# 벌레(터미니드) 종류 정리

`data/enemies.csv` 의 `faction=bug` 9종 + 튜토리얼 전용 2종을 한자리에 모은 **읽기용 요약**이다.
수치의 원본은 항상 csv 이고 이 문서는 사본이다 — 값이 어긋나면 csv 가 맞다.

- 기본 스탯: `data/enemies.csv`
- 특수 능력: `data/enemy_abilities.csv` (`HUNTER_LEAP` · `SPEWER_SPIT` · `CHARGER_CHARGE` · `ARTILLERY_AI` · `TOXIC_AI` · `BEHEMOTH_AI`)
- 상수식(`=0.8*BEHEMOTH_SCALE` 등) · 지하벌레 이벤트: `data/constants.csv` (`BEHEMOTH_SCALE` · `TOXIC_*` · `SANDWORM_*`)
- 행성별 구성: `data/planets.csv` 의 `bugs` 열, 위협도 배수는 `data/tables.csv`
- 한국어 이름: `src/meta/NpcRules.ts` 의 `ENEMY_TYPE_KO`
- 스냅숏 시점: 2026-09-15

---

## 1. 소형 — 수로 압박

| 종류 | type | HP | 속도 | 근접(피해/쿨) | 특징 |
|---|---|---|---|---|---|
| 스캐빈저 | `scavenger` | 120 | 5.5 m/s | 4 / 0.8 s | 기본 잡몹. 다섯 행성 전부에 가장 높은 가중치로 깔린다 |
| 헌터 | `hunter` | 360 | 7.5 m/s | 7 / 1 s | **도약** 5~9 m · 22 피해 · 체공 0.62 s · 명중 반경 2.4 m · 쿨 4 s. 가장 빠르다 |
| 독성 버그 | `toxic` | 140 | 7.2 m/s | 없음(자폭) | 2.2 m 안에 들면 0.6 s 부풀고 반경 5 m · 70 피해로 터진다. `staggerFraction 1.1` = 경직에 안 걸린다 |

## 2. 중형 — 전열

| 종류 | type | HP | 속도 | 근접(피해/쿨) | 특징 |
|---|---|---|---|---|---|
| 워리어 | `warrior` | 640 | 4.5 m/s | 12.5 / 1.2 s | 정직한 근접 탱커. 발소리 있음(`stepSound`) |
| 스퓨어 | `spewer` | 520 | 3.2 m/s | 6 / 1.5 s | **산성 침** 8~22 m · 18 + 스플래시 10 · 둔화 2 s · 예비동작 0.55 s, **사망 폭발** 반경 4 m · 20 |

## 3. 대형 · 특수

| 종류 | type | HP | 속도 | 근접(피해/쿨) | 특징 |
|---|---|---|---|---|---|
| 차저 | `charger` | 1800 | 4 m/s | 15 / 2 s | **돌진** 7~30 m · 예비 0.8 s · 14 m/s · 45 피해 · 최대 3.5 s. 부위 배수 후면 ×2.5 / 정면 ×0.5 — 뒤를 쳐야 한다 |
| 포격 버그 | `artillery` | 840 | 3.4 m/s | 없음 | 땅에 파고들어 **간접 사격**. 사거리 98 m · 6~9 s 간격 · 굴착 1.2 s · 후퇴 42 m / 접근 88 m. 시야 130 m. 궤적이 막히면 자리를 옮기고, 3번 거절되면 8 s 쉰다 |
| 베헤모스 | `behemoth` | 2800 | 3.6 m/s | 22.5 / 2.2 s | 스케일 ×3(`BEHEMOTH_SCALE`) = 반경 2.4 m · 키 4.8 m. 관통 돌진(교전 18 m · 쿨 4 s · 관통 6 m), **다른 팩션 적도 160 피해로 치어버린다**. 후면 ×2 / 정면 ×0.35 |
| 지하벌레 | `sandworm` | 2000~3000 (호스트가 굴림) | 0 (고정) | 없음 | 레이드 이벤트 보스. 아래 4절 |

> `sandworm` 의 csv hp 2500 은 자리표시자다. 실제 최대 체력은 `SANDWORM_HP_MIN..MAX` 에서 호스트가 굴려 분대 전원에 보낸다.

## 4. 지하벌레 이벤트 (`src/enemies/sandworm`)

- **발생 창**: 레이드 150~420 s. 멀티는 살아 있는 플레이어 2명 이상이 16 m 안에 모여 있을 때 그 한가운데 발밑에서 일어난다. 조건이 안 맞으면 그 레이드에는 없다.
- **전조** 5 s: 분진 · 흙 파임 · 점점 강해지는 흔들림(반경 180 m) · 토스트.
- **분출**: 반경 12 m · 55 피해(공용 2단 감쇠, 하한 30 %) · 넉백 15 m/s(베헤모스 돌진 12 보다 세다). 실드부터 깎인다. 동시에 6~14 m 링으로 벌레 무리가 파고 나온다.
- **뱉기 단계** 30 s: 다 솟아오르는 데 1.4 s, 그 뒤 4.5 s 마다 벌레 2마리(비행 1.1 s, 착지 7~16 m). 전체 적 생존 상한 48.
- **독극물 단계**: 땅에 박힌 채 48 m 안의 가장 가까운 플레이어에게 2.4 s 간격으로 산성 3발. 한 덩어리 피해는 스퓨어 산성과 같다.
- 몸통 반경 2.2 m · 높이 10 m, 입(머리) 반경 1.5 m(`headMul 1.5`). 경직 면역(`staggerFraction 99`), 질량 1000 이라 다른 벌레가 늘 밀려난다.

## 5. 행성별 구성

`data/planets.csv` 의 `bugs` 열 (`적종류:가중치`).

| 행성 | 위협 | 벌레 구성 | 비고 |
|---|---|---|---|
| 아켈론 II `amber` | 1 | 스캐빈저4 · 헌터2 · 워리어1 · 포격1 | 벌레가 드물다(`pressure 0.85`) |
| 보레아스 IX `tundra` | 2 | 스캐빈저3 · **헌터4** · 차저2 · 워리어2 | 무리 사냥꾼 |
| 베르단트 III `mossy` | 2 | 스캐빈저4 · **스퓨어3 · 독성3** · 워리어2 · 헌터1 | 산성 개체 위주 |
| 피로스 VII `ashen` | 3 | 스캐빈저3 · 워리어3 · **차저3 · 베헤모스1** · 포격2 | 중장갑 + 상시 포격 (`maxArtillery 3` · `maxBehemoth 2`) |
| 카민 I `crimson` | 3 | 스캐빈저2 · 헌터3 · 스퓨어2 · 워리어2 · 포격2 | 포그 없음 = 먼 거리 교전 |

위협도 배수(`data/tables.csv`):

- `BUG_HP_MUL_BY_THREAT` — 체력. `world:ready` 로 전달되어 `enemies/parts/Pool.acquire` 에서 적용된다 (와이어 없음).
- `BIG_BUG_WEIGHT_MUL_BY_THREAT` — 차저 · 베헤모스 · 포격 비중, 순찰 중형 슬롯 확률, 포병 굴착 확률.
- `MID_BUG_WEIGHT_MUL_BY_THREAT` — 워리어 · 스퓨어 비중 (지하벌레 뱉기 · 분출 무리도 같은 가중치).
- `PATROL_BEHEMOTH_BY_THREAT` · `ARTILLERY_CAP_BONUS_BY_THREAT` · `BEHEMOTH_CAP_BONUS_BY_THREAT`.

## 6. 튜토리얼 전용

`world/tutorial` 의 고정 목록만 쓰고 본편 · 훈련장에는 서지 않는다. 수치는 스캐빈저 그대로이고
(`enemies/EnemyTypes.baseTypeOf` 가 리그 · AI · 소리를 스캐빈저로 돌린다) 다른 것은 고정 드롭 하나뿐이다.

| type | 바탕 | 차이 |
|---|---|---|
| `tut_bug` | 스캐빈저 | 없음 |
| `tut_bug_loot` | 스캐빈저 | 생체 조직 · 터미니드 분비선 100 % 확정 드롭 (`loot_corpses.csv` · `loot_corpse_rolls.csv` 의 `tut_*` 줄) |

튜토리얼에는 행성이 없어 `BUG_HP_MUL_BY_THREAT` 는 ×1 이다.

## 7. 벌레가 아닌 것

인간형 팩션은 벌레 취급이 아니다 — 목표 판정 축이 `bug` / `humanoid` 로 갈린다 (`src/meta/NpcRules.ts` `enemyMatches`).

- **안드로이드** `android` (위협 1), **로그** `rogue` · `rogue_boss` (위협 2), **레이더** `raider` (위협 2~3)
- **네임드** `rogue_sniper`(로든) · `rogue_hammer`(타길라) · `rogue_heavy`(헤비) — 레이드당 최대 1명
- **스캔 드론** `rogue_scan_drone` — 로든이 띄우는 공중 유닛, 요격 가능

코드에서 인간형 판정은 `isRogue` 가 아니라 `Enemy.isHumanoid` 를 쓴다.
