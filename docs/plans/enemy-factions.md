# 행성별 적 난이도 — 안드로이드 · 로그 · 레이더 (2026-09-13)

사용자 명세 + AskUserQuestion 인터뷰 결과. 계약(`src/shared`, 적 폴더 배관)은 리드가 먼저 넣었고, 구현은 기능별 에이전트 5개가 병렬로 한다.

## 1. 결정 사항

| 항목 | 결정 |
|---|---|
| 난이도 기준 | `PlanetDef.threat` 1–3 → `planetThreat(id)` (행성 없음 = 1). 아켈론 II = 1 · 보레아스 IX · 베르단트 III = 2 · 피로스 VII · 카민 I = 3 |
| threat 1 | 연구소 · 전진기지마다 **안드로이드** 2–3그룹 확정 (실내 1 + 실외 1–2, 그룹당 1–2명). 로그 · 레이더 · 강하 · 네임드 없음 |
| threat 2 | 연구소 · 전진기지 **항상 점거**: 로그 65 % / 레이더 35 % — 실내 1 + 실외 1 = 2그룹, 그룹 ≥ 3명. 선로 플랫폼 = 로그 1그룹 60 %. 폐허 전초 = 로그 1그룹 50 %. 불시착 함선 = 점거 없음(강하 트리거만). **레이더 강하** = 옛 로그 강하 트리거(구조물 조사) |
| threat 3 | **레이더만** — threat 2 에서 로그가 서던 자리(플랫폼 60 % · 폐허 포함)를 전부 레이더가 차지. 레이더 강하 있음 |
| 인원 조정 (후속 결정) | 첫 구현이 threat 2–3 맵에 인간형 39–44명을 세웠다 → **폐허 점거 50 % → 20 %, 폐허 · 플랫폼 그룹 2–3명** (연구소 · 전진기지 그룹은 3–4명 그대로) |
| 옛 배치 | 상자 경비 폐지. `rogue_boss` = 로그 그룹장, 레이드당 최대 1명 · 40 % (threat 2, 로그 그룹 중 하나) |
| 네임드 | 로든 · 타길라 · 헤비 = 팩션 `raider` (타입 id 유지), 호위도 레이더. 확률 threat 1 = 0 · 2 = 25 % · 3 = 50 % |
| 적대 | 서로 다른 팩션은 전부 적대 (`bug` · `rogue` · `android` · `raider`) |
| 체력 | 안드로이드 280 · 로그 560 (옛 280 × 2) · 레이더 840 (로그 × 1.5) |
| 레이더 강하 인원 | 분대 1인 3 / 2인 3 → 2 / 3인 3 → 3 / 4인 4 → 3–4. 두 번째 파도는 ≈ 10 s 뒤, **한 번에 4명 초과 금지** |
| 외형 | 로그 휴머노이드 리그 공유 + 새 외피. 안드로이드 = 무광 백색 외피 · 단안 바이저 · 관절 발광. 레이더 = 헬멧 · 검은/붉은 전술 장비 |

### AI

| 팩션 | 규칙 |
|---|---|
| 안드로이드 | 로그 AI 기반이되 **엄폐하지 않고 수류탄을 던지지 않는다**. 적극적이지 않고 위협적이지 않은 사격(낮은 명중 · 느린 연사). 버그와 적대 |
| 로그 | 엄폐 · 수류탄 그대로. 사격이 더 위협적: **먼 거리 명중률 매우 낮음, 중–근거리 위협적**(거리 명중 곡선), 연사 적극적 → 버그를 쉽게 정리. 수류탄은 **실제 보유분**(스폰 때 1–3개 + 종류 고폭/소이) · 쿨타임 ≈ 12 s · 남은 것은 시체에 그대로 |
| 레이더 | 로그 AI + 그룹마다 **한 명은 각개 행동**(`squadRole 'flanker'` — 둘이 엄폐 대치하는 동안 빠르게 우회해 푸시). 수류탄 사거리 길고 명중률 높음. 먼 거리에서도 꽤 정확한 조준 |

소이 수류탄은 적도 **진짜 화염 지대**를 만든다 (종류별 투척).

### 전리품 (시체)

| 팩션 | 총기 등급 (I/II/III/IV) | 방탄복 | 가방 | 회복 | 수류탄 |
|---|---|---|---|---|---|
| 안드로이드 | 95 / 5 | 없음 | 없음 | **실드 충전기류만** (+ 전자 재료) | 없음 |
| 로그 | 85 / 14 / 1 (명세 80/14/1 합 95 → 일반에 더함) | 5 %, 최대 고급 | 3 %, 최대 고급 | 다양한 회복(의약품 + 실드 충전), 희귀도는 총기 분포와 같게 | 남은 보유분 (일반–고급) |
| 레이더 | 50 / 45 / 4.5 / 0.5 | 5 %, 90 / 9.5 / 0.5 | 3 %, 최대 고급 | 로그와 같음 | 남은 보유분 |

- 방탄복 · 가방은 **총기처럼 낮은 내구도**로 떨어진다. 확률은 "짜게 옵션(로그 10/6 · 레이더 20/10)의 절반" 에 레이더도 로그와 같게 맞춘 값 (사용자 결정).
- 행성 무기 등급 **상한**(`planet_loot.csv`, 시체 무기 상한 규칙)은 그대로 적용한다.
- 레이더가 **연구소**에서 스폰했으면 연구소 물품(씨앗 · 미확인 세포/광물/DNA)을 들고 있다. **전진기지**에서 스폰했으면 총기 등급 보너스.

## 2. 계약 (리드, 2026-09-13)

- `shared/types.ts`: `EnemyType` += `android` · `raider`, `EnemyFaction` += `android` · `raider`, `CORPSE_LOOT_CHANCE` 두 줄,
  `ENEMY_FACTION_LABEL_KO`, `EnemySpawnSite`, `EnemySquadRole`, `EnemyGrenadeKind` + `ENEMY_GRENADE_KINDS`(와이어 순서) + `ENEMY_GRENADE_ITEM`,
  `HumanoidSpawnOpts`, `CorpseLootOpts`, `RuinSiteDef`, `SiteSpawnPlace`, `WorldRef.getRuinSites?()` · `getSiteSpawnPoints?()`,
  `LootRef.rollCorpseOn(…, opts?)`.
- `shared/net.ts`: `ee grenade.k?` (종류 인덱스), `ee corpse.si? / gc? / gk?` (거점 · 남은 수류탄).
- `shared/planetDefs.ts`: `planetThreat(id)`.
- `data/enemies.csv`: `android` · `raider` 줄, 로그 hp 560, 네임드 3종 + 스캔 드론 팩션 `raider`.
- `data/enemy_abilities.csv` `HUMANOID_WEAPONS` 블록 → `EnemyTypes.HUMANOID_WEAPONS`.
- `enemies/`: `Enemy.isHumanoid`(= 벌레가 아님 — 옛 `isRogue` 의 쓰임 전부를 옮김, `isRogue` 는 이제 팩션 판정), `Enemy.site` · `squadId` ·
  `squadRole` · `grenadeKind` · `grenadeCount`, `spawnRogue(…, opts?)`, `registerCorpse` → `ee corpse.si/gc/gk` → 리플리카 →
  `Corpse.lootOpts` → `rollCorpseOn(…, opts)` (드론 스캔 미리보기도 같은 값), `RogueModel` 자리표시자 팔레트.

## 3. 에이전트와 파일 소유

| 에이전트 | 소유 파일 | 하는 일 |
|---|---|---|
| **world-sites** | `src/world/**` | `getRuinSites` · `getSiteSpawnPoints` 구현 + 스모크 |
| **humanoid-ai** | `enemies/ai/RogueAI.ts` · `RogueCover.ts` · `FireLine.ts` · `Perception.ts`, `parts/Attacks.ts` · `Alerts.ts` · `RemoteFx.ts`, `fx/RogueGrenade.ts`, `net/Replica.ts`(수류탄 종류), `net/HostSync.ts`, `Enemy.ts`(AI 필드), `EnemyTypes.ts`(능력 블록), `parts/Pool.ts`(수류탄 굴림 줄), `data/enemy_abilities.csv`, `data/constants.csv` 의 `ROGUE_*` · 새 AI 절 | 팩션별 AI 프로필 · 거리 명중 곡선 · 수류탄 보유/종류/소이 화염 · 레이더 우회조 |
| **spawn-director** | `enemies/RogueGuards.ts`(→ 거점 그룹), `RogueDrop.ts`(레이더 강하 · 파도), `named/Director.ts`, `EnemySystem.ts`, `Spawner.ts`, `data/tables.csv`, `data/planets.csv`, `data/constants.csv` 의 새 거점/강하 절 | threat 별 거점 점거 · 그룹 · 그룹장 · 레이더 강하 파도 · 네임드 팩션/확률 |
| **faction-loot** | `src/items/**`, `data/loot_*.csv`(+ 새 표), `scripts/data-check.mjs`, `scripts/check-planet-loot.mjs`, `src/inventory/__selftest__.ts`(시체 벡터) | 팩션 전리품 표 · 거점 보너스 · 남은 수류탄 · 낮은 내구도 방탄복/가방 |
| **faction-presentation** | `enemies/models/RogueModel.ts`, `enemies/model.ts`(소리 표), `src/audio/**`, `src/ui/**`, `src/meta/**`, `data/contracts.csv` | 안드로이드 · 레이더 외피, 금속 피격/발소리, "레이더 강하" 문구, 킬 계약이 인간형 전부를 센다 |

공용 문서(`src/enemies/README.md` · `CLAUDE.md` · `docs/HISTORY.md` · `docs/VERIFICATION.md` · `data/README.md`)는 **리드가 통합한다** —
에이전트는 보고서에 README 에 넣을 내용을 적는다. `data/constants.csv` · `scripts/verify.mjs` 처럼 둘이 만지는 파일은 **자기 절에만,
편집 직전에 다시 읽고** 넣는다.
