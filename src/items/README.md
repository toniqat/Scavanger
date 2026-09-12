# src/items — Item & weapon data, stats, loot rolling (`ctx.loot`)

Pure data + the `LootRef` implementation. No DOM, no Three.js scene objects. Weapon package (2026-09-05): weapon **grades I–V**, **durability**, **ammo v2** (rounds-as-qty), **attachments** (5 sockets), **bags**, and the `EffectiveWeaponStats` helper every other module fires/repairs/attaches with.

| File | Purpose |
|---|---|
| `WeaponDefs.ts` | 6 weapon **families** (one per class, 2026-09-07) × 5 grades = 30 `WeaponDef`s built by `buildGrade` **+ 6 legendary uniques** (`UNIQUE_WEAPON_DEFS`, `UNIQUE_WEAPON_DEF_MAP`, `isUniqueWeapon(def)`, `isUniqueWeaponId`, `UNIQUE_WEAPON_DURABILITY`, `UNIQUE_WEAPON_MAG`) — all in `WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`; `WEAPON_FAMILIES` (graded families only), `WEAPON_GRADES`, `weaponGradesOf(family)`, `weaponIdForGrade(family, grade)`; `WEAPON_CLASS_LABEL_KO`, `WEAPON_CLASS_SHORT` (`SMG/AR/SG/SR/DMR/HG`), `WEAPON_BASE_DURABILITY` (per class), `weaponClassOf(def)`, `weaponFamilyOf(def)`, `gradeOf(def)`, `damageFalloff(def, distance)` |
| `ImplantDefs.ts` | **Phase 12** (2026-09-08): 46 `ItemDef`s of category `'implant'` — `IMPLANT_WORKING_DEFS` (23: 5 stats × grades I–IV `imp_<stat>_<g>` + 3 legendary perk implants `imp_perk_<perk>`) and `IMPLANT_BROKEN_DEFS` (23 `imp_broken_*` twins: `망가진 …`, `implant.broken`, `repairsTo` / `repairCost`), together `IMPLANT_ITEM_DEFS`; `PERK_IMPLANT_DEFS`, `IMPLANT_GRADES`, `IMPLANT_SLOTS_BY_GRADE`, `IMPLANT_VALUE_BY_RARITY`, `IMPLANT_REPAIR_COST`, `IMPLANT_STAT_NAME_KO`, `implantItemIdFor(stat, grade)`, `perkImplantItemIdFor(perk)`, `brokenImplantIdOf(id)`, `isImplantItemDef`, `isBrokenImplantDef`. See *임플란트 아이템* below. |
| `ItemDefs.ts` | `ItemDef` 전부 (`ITEM_DEFS`, `ITEM_DEF_MAP`, `getItemDef`, `itemDefsByCategory`, `isWeaponItemDef`) — 46 weapon items generated from `WEAPON_DEFS` (`WEAPON_ITEM_DEFS`; uniques use `UNIQUE_WEAPON_META`), `AMMO_ITEM_DEFS` (10), `ATTACHMENT_ITEM_DEFS`, `BAG_ITEM_DEFS`, `SEED_ITEM_DEFS` (**10**, Phase 8 + 2026-09-11 온실 개편 — `SeedDef.soilTag` 포함), **`SAMPLE_ITEM_DEFS` (6, 2026-09-11 연구실 — `data/samples.csv`, `ItemDef.sample`)**, `BOOK_ITEM_DEFS` (14, Phase 9 — `bookItemIdFor`, `BOOK_DEF_BY_SKILL`), **`DISC_ITEM_DEFS` · `RECORD_ITEM_DEFS` (14 + 14, 2026-09-12 A-3e — `data/discs.csv` · `data/records.csv`, `discItemIdFor` · `recordItemIdFor` · `DISC_DEF_BY_SKILL` · `RECORD_DEF_BY_SKILL`, 책 바로 뒤)**, `IMPLANT_ITEM_DEFS` (46, Phase 12 — spread in after the books), consumables, valuables, materials, **약초 6 · 작물 8 · 토양 6 · 준비물 2 (2026-09-11, `ItemDef.soil = {tag, uses}` 는 `items.csv` 의 `soilTag` · `soilUses` 선택 열에서, `ItemDef.prep = {env, short}` 는 `prepEnv` · `prepShort` 선택 열에서 온다)**, **`MEAL_ITEM_DEFS` (10, 2026-09-11 주방 A-3c — `data/meals.csv`, `ItemDef.meal`)**, **주머니 4 · 세포주 5 · 배지 2 · 배양 산물 5 · 필라멘트 3 · 열쇠 1 (2026-09-11 A-14 · A-15 — `items.csv` 의 선택 열 `pouchCols`/`pouchRows`/`pouchAccepts` → `ItemDef.pouch`, `strainOut`/`strainQty`/`strainHours` → `ItemDef.strain`, `mediumUses`/`mediumSpeed` → `ItemDef.medium`)**, `ITEM_CATEGORIES` (`CATEGORY_LABEL_KO` 의 키 — csv 카테고리 목록 칸 검증용); rarity palette `RARITY_COLORS`, `RARITY_ORDER`, `rarityRank`, `rarityForGrade` / `gradeForRarity`; Korean labels (`RARITY_LABEL_KO`, `CATEGORY_LABEL_KO`, `AMMO_LABEL_KO`); `AMMO_TYPES_V2` (10), `UNIQUE_AMMO_TYPES`, `AMMO_ROUND_WEIGHT`, `ammoItemIdFor(type)`, `itemIdForWeapon(weaponId)`, `WEAPON_GRADE_VALUE_STEP`; `STARTER_LOADOUT` + `StarterLoadout` type |
| `WeaponStats.ts` | `computeWeaponStats(def, inst?)` → `EffectiveWeaponStats` (grade already in the def + slot timings + socketed attachments; **uniques return the def numbers untouched**), `baseWeaponStats`, `applyAttachmentEffects`, `socketedAttachments`, `canAttach(weaponDef, attachmentDef)` (false for uniques), `gradeRoman`, `clampGrade`, `RECOIL_H_RATIO` (0.7), `SECONDARY_ADS_TIME_MUL` (0.5). **2026-09-10: `repairCost` 는 여기서 사라졌다** — 수리비는 제작 재료 × 내구도 구간 배수이고 구현은 `Salvage.repairCostFor` 다 |
| `LootTables.ts` | **2026-09-09** `PLANET_GRADE_CURVES` / `getPlanetGradeCurve(rank)` (`data/planet_loot.csv`) — 행성 난이도 순번 1..5 별 무기 등급 곡선(`grades` · `weightOf` · `maxGrade`); **2026-09-10** 같은 표의 둘째 축 `rarityMul` / `rarityMulIdentity` + `planetRarityWeights(base, curve)` (아래 *행성별 희귀도 배수*). Per-tier `TierTable`s (`LOOT_TABLES`, `getTierTable`, `getTierLabel`): item count, rarity weights (= weapon grade weights), category weights incl. `attachment` / `bag`, weapon chance, `ammoFraction`, guaranteed picks, `itemWeightMul` (family-wide for weapons; Phase 6 helpers `uniqueWeapons / uniqueAmmo / gradedFamilies`; Phase 8 `seed` weights at tiers 1–3; Phase 9 `book` weights at tiers 2–4; **Phase 12** `implant` weights at tiers 2–4 with `workingImplants()` zeroed and `brokenImplants({byRarity})` tapering — broken legendaries tier 4 only). Phase 4: per-`EnemyType` `CorpseTable`s (`CORPSE_TABLES`, `CORPSE_TABLE_MAP`, `CorpseDrop`, `CorpseWeapon`, `CorpseUnique`, `DEFAULT_ROGUE_WEAPON_ID`; Phase 8 `BUG_SEEDS` on every bug type; Phase 9 `CorpseBook` on 로그 / 보스; **Phase 12** `CorpseImplant {chance, weights}` on 로그 6 % / 보스 45 %); **2026-09-11** `NAMED_DROPS` / `NAMED_DROP_MAP` / `NamedDrop` / `numberedArmorIdForTier` (`data/loot_named.csv`, 아래 *네임드 로그 확정 드롭*) |
| `Loot.ts` | `LootService implements LootRef` — **2026-09-09** `rollCrateOn(tier, rng, planet)` / `rollCorpseOn(type, rng, rogueWeaponId, planet)` (행성별 무기 등급, 아래 *행성별 무기 등급*; **2026-09-10** 부터 총기가 아닌 것들에는 행성 희귀도 배수도 걸린다 — 아래 *행성별 희귀도 배수*), `rollCrate(tier, rng?)` (a rolled unique brings one stack of its calibre), `rollCorpse(type, rng?, rogueWeaponId?)` (boss unique roll, then the Phase 9 book, then the **Phase 12 broken-implant roll last** — earlier draws never shift), `createItem(defId, qty?, extras?)`, `getEffectiveStats`, `getRepairCost`, `canAttach`, def lookups (`getAllItemDefs` includes uniques / unique ammo / new materials — the cheat catalog lists everything); `nextUid()` |
| `index.ts` | Barrel — import via `@/items` |

## Weapon families & grades

2026-09-07: **one weapon per class**, and the family *is* the class — the branded 8 families (AR-23 리버레이터, SMG-37
디펜더, LAS-16 사이드, P-19 리디머 …) are gone, together with the two duplicates (LAS-16 was a second AR, P-19 a second
pistol). Ids are the class tag (`ar`, `smg`, `sg`, `dmr`, `sr`, `hg`) and the display name is the Korean class label
plus the grade numeral: `돌격소총 III`, `저격소총 I`, `권총 V`.

Ids: grade I keeps the family id (`ar`); grade g ≥ 2 is `${family}_g${g}` (`ar_g3`). Item id = `wpn_${weaponId}`
(`wpn_ar`, `wpn_ar_g3`). Every def carries `grade`, `family`, `maxDurability` and the v2 `ammoType` from `AMMO_FOR_CLASS`.

Per grade above I: damage × (1 + 0.12·(g−1)) rounded, max durability × (1 + 0.25·(g−1)) rounded, item value ×
(1 + 0.6·(g−1)), rarity = grade (I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설).

| family | name | class | ammo | grid | dmg I → V | dur I → V | rps | mag | reload | falloff start→end (×min) | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ar` | 돌격소총 | AR | medium | 4×2 | 60 → 89 | 500 → 1000 | 10 | 45 | 2.4 s | 60→220 (×0.6) | auto |
| `smg` | 기관단총 | SMG | light | 3×2 | 32 → 47 | 550 → 1100 | 14 | 40 | 1.9 s | 15→45 (×0.4) | auto |
| `sg` | 산탄총 | SG | shell | 3×2 | 22×8 → 33×8 | 200 → 400 | 1.3 | 8 | 3.0 s | 8→30 (×0.25) | pellets |
| `dmr` | 지정사수소총 | DMR | heavy | 4×1 | 120 → 178 | 250 → 500 | 3 | 15 | 2.6 s | 120→400 (×0.75) | semi, adsZoom 1.6 |
| `sr` | 저격소총 | SR | heavy | 5×1 | 330 → 488 | 120 → 240 | 0.9 | 5 | 3.4 s | 300→700 (×0.85) | bolt, adsZoom 4, scope |
| `hg` | 권총 | PISTOL | light | 2×1 | 45 → 67 | 350 → 700 | 6 | 15 | 1.6 s | 20→70 (×0.5) | semi, secondary slot |

Base item values (grade I): ar 350 · smg 480 · sg 520 · dmr 780 · sr 950 · hg 140. Hip spreads are deliberately loose
(AR 1.4°, SMG 1.9°, SR 4°); `src/weapons` scales them by stance/ADS. The energy-weapon path (`kindOf` → `'energy'`,
`ammoType 'energy'`) is unused by any def now but kept for the uniques / fallbacks.

## Unique weapons (Phase 6, 2026-09-06)

Six legendary one-offs (`UNIQUE_WEAPON_DEFS`, ids from `UNIQUE_WEAPON_IDS`, items `wpn_u_*`). `WeaponDef.unique` names the behaviour handler in `src/weapons/unique/*`; items only carries data. Every unique: `grade: 5` (legendary rarity, legendary repair cost), **no `family`** (its own family; `buildGrade` never expands it, `WEAPON_FAMILIES` does not list it), a **dedicated `ammoType`** (never `AMMO_FOR_CLASS`), `altFire: true` = **RMB is the alternative fire, no ADS** (only the bow keeps ADS), no attachments (`canAttach` false, `createItem` drops `extras.sockets`), no grade scaling (`computeWeaponStats` returns the def numbers). `weaponClass` only picks the shooting skill. Numbers are the shared `FLAME_* / SHOCK_* / SHURIKEN_* / BOW_* / BAZOOKA_* / MINIGUN_*` constants; magazines / durability have no constant and live in `UNIQUE_WEAPON_MAG` / `UNIQUE_WEAPON_DURABILITY`.

| id | name | kind | class | ammo (stack) | mag | dmg | alt / charge / ammo·s | rate | grid · kg · ₩ | dur |
|---|---|---|---|---|---|---|---|---|---|---|
| `u_flame` | 「인페르노」 화염방사기 | flamethrower | AR | `fuel` 연료통 (200) | 120 | 95 /s (LMB cone 32°) | alt 75 /s (RMB jet 7°) · 12 fuel/s | 10 (tick hint) | 5×2 · 9.5 · 6800 | 1500 |
| `u_shock` | 「테슬라 코일」 전격총 | shockgun | DMR | `cell` 전지 (60) | 48 | 72 /s (LMB arc, ≤ 4 targets) | alt 150 (charged bolt) · charge 1.1 s · 8 cells/s | 1/1.1 | 4×2 · 6.2 · 7200 | 1200 |
| `u_shuriken` | 「카게」 표창 | shuriken | SMG | `shuriken` 표창 (40) | 10 | 58 (projectile 65 m/s) | RMB fan of 3 (`adsSpread` = 7°) | 3.2 | 3×2 · 2.4 · 5400 | 900 |
| `u_bow` | 「롱혼」 컴포짓 보우 | bow | DMR | `arrow` 화살 (30) | 12 | 150 (projectile 115 m/s, no drop) | **ADS 1.6×** (`altFire: false`) | 2.4 | 5×2 · 3.6 · 5900 | 700 |
| `u_bazooka` | 「해머헤드」 바주카 | bazooka | SR | `rocket` 로켓 (6) | 1 | 420 (rocket 48 m/s, impact blast) | alt 260 (air-burst) | 0.8 | 5×2 · 11.8 · 8400 | 320 |
| `u_minigun` | 「사이클론」 미니건 | minigun | AR | `belt` 탄띠 (300) | 150 | 24 (hitscan, spread 2.6°) | charge 1.2 s (spin-up) | 24 | 5×2 · 14.5 · 7600 | 3000 |

Continuous weapons (flame / shock arc): `damage` is **per second**, `fireRate` a tick hint, `ammoPerSec` replaces per-shot ammo; for the flamethrower `spread` is the LMB cone half-angle and `adsSpread` the RMB jet half-angle. Item descriptions spell out the LMB / RMB behaviour in Korean.

**Unique ammo** (`UNIQUE_AMMO_TYPES`, category `ammo`, 1×1, `qty` = units, rarity **rare** so the tier tables can weight it by rarity): `ammo_fuel` 연료통 (200, 0.02 kg/unit, ₩1) · `ammo_cell` 전지 (60, 0.06, ₩4) · `ammo_shuriken` 표창 (40, 0.07, ₩5) · `ammo_arrow` 화살 (30, 0.05, ₩4) · `ammo_rocket` 로켓 (6, **1.2**, ₩60) · `ammo_belt` 탄띠 (300, 0.015, ₩1). `AMMO_TYPES_V2` lists them after the four graded calibres.

**Where they drop** (user decision: 전설 루트 + 치트 상자): tier 4 `itemWeightMul` 0.25 per unique → 6 × 2.5 = 15 of the ≈ 97 legendary weapon weight (≈ 15 % of legendary weapon rolls, ≈ 1.6 % of tier-4 crates in a 1500-seed sample); tier 5 supply drop `weaponChance` 0.03 with every graded family zeroed so the rare weapon pick is always a unique (≈ 2.4 % of drops); tiers 1–3 zero them explicitly (tier 3 has legendary weight 1). A rolled unique always adds one stack of its calibre beyond `count` (`rollCrate`), and the ammo also rolls on its own at tier 4 (≈ 23 % of ammo picks) / tier 5 (low). `CORPSE_TABLES.rogue_boss.unique = { chance: 0.2, durability: [0.5, 0.8] }` → 20 % of boss corpses add one unique (uniform over `UNIQUE_WEAPON_IDS`, rolled **last** so the existing III/IV weapon + attachment draws are unchanged) plus a 30–60 % stack of its calibre. The `/items` cheat catalog gets them through `getAllItemDefs`.

**New materials** (ship facility / furniture costs, `FURNITURE_DEFS` / `*_UPGRADE_COST` in the contract): `mat_cable` 전력 케이블 (common, 1×1, stack 10, 0.3 kg, ₩25; tiers 2–4, ×1.2 at tier 2) · `mat_circuit` 회로 기판 (rare, 1×1, stack 10, 0.15 kg, ₩120; tiers 2–5 — ×0.3 at tier 2, ×0.6 at tier 3, the only material in the tier-5 supply drop, `material: 4`). Furniture item defs are **not** added this session (category `furniture` only has its labels).

## Ammo v2

Category `ammo`, 1×1, `qty` **is** the round count, `stackMax = AMMO_STACK_ROUNDS[type]`:

| id | name | calibre | stack | classes | value/round |
|---|---|---|---|---|---|
| `ammo_light` | 경량탄 | light | 80 | SMG, PISTOL | 1 |
| `ammo_medium` | 준중량탄 | medium | 50 | AR | 2 |
| `ammo_heavy` | 중량탄 | heavy | 25 | SR, DMR | 3 |
| `ammo_shell` | 산탄 | shell | 25 | SG | 3 |

The legacy `ammo_rifle/pistol/shotgun/energy` defs are gone; `AMMO_LABEL_KO` still labels the legacy `AmmoType` members for safety.

## Attachments

Category `attachment`, 1×1, stack 1, `ItemDef.attachment: { socket, classes?, ammoTypes?, effects }`. `classes`/`ammoTypes` undefined = fits everything. "not PISTOL" = `['AR','SMG','SG','SR','DMR']`.

| id | name | socket | rarity | fits | effects |
|---|---|---|---|---|---|
| `att_brake` | 총구 제동기 | muzzle | uncommon | all | recoilV ×0.75, recoilH ×0.75 |
| `att_comp` | 보정기 | muzzle | uncommon | all | spread ×0.85 |
| `att_choke` | 산탄총 초크 | muzzle | uncommon | SG | spread ×0.7 |
| `att_grip_angled` | 앵글 그립 | grip | uncommon | not PISTOL | recoilH ×0.7 |
| `att_grip_vertical` | 수직 그립 | grip | uncommon | not PISTOL | recoilV ×0.7 |
| `att_mag_light` | 확장형 경량 탄창 | mag | rare | ammo light | magSize ×1.4 |
| `att_mag_medium` | 확장형 준중량 탄창 | mag | rare | ammo medium | magSize ×1.4 |
| `att_mag_heavy` | 확장형 중량 탄창 | mag | rare | ammo heavy | magSize ×1.4 |
| `att_mag_shell` | 확장형 산탄 탄창 | mag | rare | ammo shell | magSize ×1.4 |
| `att_stock` | 전술 개머리판 | stock | rare | not PISTOL | spread ×0.9, adsTime ×0.75 |
| `att_laser` | 레이저사이트 | sight | uncommon | all | laser, hipSpread ×0.7 |
| `att_scope4` | 4배 조준경 | sight | rare | AR, SMG, SR, DMR | adsZoom 4, scope |
| `att_scope6` | 6배 조준경 | sight | epic | AR, SMG, SR, DMR | adsZoom 6, scope |
| `att_scope8` | 8배 조준경 | sight | legendary | SR, DMR | adsZoom 8, scope |

## Bags

Category `bag`, 2×2, stack 1, `ItemDef.bag: { cols, rows, quickSlots, tactical? }`, `ItemDef.durabilityMax` (2026-09-11 — 8종 전부 100).
`quickSlots` 는 로더가 `max: QUICK_SLOTS`(8)로 막는다 — 휠은 8방향이다.
**내구도**(C-36): 장착 가방이 레이드 1회마다 `BAG_DURABILITY_PER_RAID`(10) 닳는다 (`inventory/` 가 깎는다). 0 이어도
격자 · 퀵슬롯은 그대로이고 수리비만 크다. 수리 · 분해는 방탄복과 같은 `Salvage.ts` 규칙이다.

| id | name | rarity | grid | quick slots |
|---|---|---|---|---|
| `bag_common` | 일반 가방 | common | 5×6 | 2 |
| `bag_uncommon` | 고급 가방 | uncommon | 6×6 | 3 |
| `bag_rare` | 희귀 가방 | rare | 8×6 | 4 |
| `bag_epic` | 서사 가방 | epic | 9×6 | 5 |
| `bag_legendary` | 전설 가방 | legendary | 10×6 | 6 |
| `bag_rare_tac` | 희귀 전술 가방 | rare | 7×6 | 7 (tactical) |
| `bag_epic_tac` | 서사 전술 가방 | epic | 8×6 | 8 (tactical) |
| `bag_legendary_tac` | 전설 전술 가방 | legendary | 9×6 | 8 (tactical — 2026-09-11 까지 9 였지만 휠에 9번째 칸이 없었다) |

## Other items

**회복 소모품** (2026-09-07, category `stim`, `ItemDef.heal`): 사용 중 이동 속도 50 % (`CONSUMABLE_SLOW_MUL`).

| id | name | rarity | grid · stack | 사용 | 효과 | 제작 |
|---|---|---|---|---|---|---|
| `heal_bandage` | 붕대 | common | 1×1 · 5 | 5 s | 5초에 걸쳐 hp 20 | 천조각 5 (야전) |
| `heal_bandage_herb` | 약초 붕대 | uncommon | 1×1 · 5 | 5 s | 5초에 걸쳐 hp 50 | 천조각 5 + 혈근초 1 (야전) |
| `heal_syringe` | 회복주사 | rare | 1×1 · 3 | 2 s | 1초 만에 hp 50 | 주사기 1 + 소독약 1 (의학 Lv.1) |
| `heal_spray` | 회복 스프레이 | epic | 1×2 · 1 | 채널 | 게이지 100, 0.1 s마다 게이지 1 → 반경 8 m 자신·아군 hp 1 | 캔 1 + 소독약 1 (의학 Lv.2) |

2026-09-10: 같은 `category: 'stim'` 에 **실드 충전기 3종**이 붙었다 — 체력이 아니라 실드를 채운다
(*Body armor* 절의 *실드 충전기*).

The 스프레이's gauge is the instance's `durability` (`durabilityMax` 100), so a half-used can keeps its charge in the
stash and shows the ordinary durability bar. `제세동기` (`gad_defib`, a gadget) is stack 2 and now takes a
`DEFIB_USE_TIME_S` (1 s) hold. 스팀 / 고급 스팀 are **removed** — `ItemCategory 'stim'` and `applyStim` are unchanged.

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack **3** — 한 칸에 3개).

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1, stack 10): `mat_scrap`, `mat_bio_sample`, `mat_alloy`, `mat_power_cell`.
2026-09-10 상위 재료 5종 (`mat_weave` · `mat_ballistic_fiber` · `mat_capacitor` · `mat_ingot` · `mat_control_module`)
은 **정제 작업대에서만** 나온다 — *Recipes* 절의 *재료 등급 축*.
2026-09-07 회복 재료: `mat_cloth` 천조각 (common, stack 20, tiers 1–3), `mat_can` 캔 (common, stack 10, tiers 1–3),
`mat_syringe` 주사기 (uncommon, stack 10, tiers 2–3), `mat_antiseptic` 소독약 (uncommon, **crafted only**: 캔 1 + 혈근초 1).

## Starter loadout & 기본 지급품 (2026-09-07)

The kit is no longer handed out every mission. `STARTER_LOADOUT` is the **minimum kit** — applied only on a brand-new
profile and as the "nothing anywhere" safety net (`InventorySystem.isDestitute`, see `src/inventory/README.md`):

```ts
STARTER_LOADOUT = {
  primary: null, primary2: null, secondary: 'wpn_hg', bag: 'bag_common', armor: 'armor_1',
  items: [ammo_light×80, heal_bandage×2, grenade_frag×3],
}
```

`STARTER_STASH` is the 기본 지급품, written into the 함선 창고 **once** (a profile that has never had a stash).
`qty` is units per stack and `stacks` how many stacks — one 세트 per grid cell:

| entry | 세트 |
|---|---|
| `ammo_light` 80 · `ammo_medium` 50 · `ammo_heavy` 25 · `ammo_shell` 25 | 10 stacks each |
| `wpn_smg` · `wpn_sg` · `wpn_ar` · `wpn_dmr` · `wpn_sr` (grade I) | 1 each (권총 I is equipped instead) |
| `bag_common` · `armor_1` | 3 each (spares) |
| `mat_scrap` 8×2 · `mat_cable` 3 · `mat_alloy` 2 | 작업실 증축 + 총기 작업대 제작 재료 |
| `gad_defib` 2×2 · `grenade_frag` 3×3 | 재세동기 2세트 · 수류탄 3세트 |

Ammo stack sizes are the 세트 sizes (`AMMO_STACK_ROUNDS`: light 80 / medium 50 / heavy 25 / shell 25).

## Stats & helpers (`WeaponStats.ts`, exposed via `LootRef`)

- `computeWeaponStats(def, inst?)`: starts from the def (damage/magSize/spreads/durability already graded), `recoilV = def.recoil`, `recoilH = recoil × 0.7`, `adsTime = WEAPON_ADS_TIME` (× 0.5 for secondaries), `swapTime = WEAPON_SWAP_TIME_PRIMARY | _SECONDARY`, `adsZoom = def.adsZoom ?? 1`, `scope = !!def.scope`, `laser = false`, `maxDurability = def.maxDurability ?? WEAPON_DEFAULT_DURABILITY`; then folds each attachment in `inst.sockets` in `SOCKET_SLOTS` order — multipliers multiply (`spread` hits hip + ADS, `hipSpread` only hip), `magSize` rounded (min 1), `adsZoom`/`scope`/`laser` override.
- `repairCost(def, inst)`: missing = max − (`inst.durability ?? max`); `ceil(missing / REPAIR_SCRAP_PER)` × `mat_scrap`, plus `ceil(missing / REPAIR_ALLOY_PER)` × `mat_alloy` when grade ≥ III; `[]` when nothing is missing.
- `canAttach(weaponDef, attachmentDef)`: `classes` (via `weaponClassOf`) and `ammoTypes` (def calibre) checks.
- `LootService.createItem(defId, qty?, extras?)`: weapons spawn with `durability = maxDurability` and `ammoInMag = magSize` (extended mag in `extras.sockets` counted) unless `extras` overrides; `sockets` copied from `extras`. `getEffectiveStats` accepts an instance, a weapon def id (`ar_g3`) or a weapon item id (`wpn_ar_g3`); returns `null` / `[]` / `false` for non-weapons.

## Loot tiers

| Tier | Label | Items | Weapon | Attachment / bag weight | Ammo roll (× stack) | Notes |
|---|---|---|---|---|---|---|
| 1 | 보급 상자 | 2–3 | — | 6 / — | 25–50 % | mostly common consumables/materials |
| 2 | 군수 상자 | 3–4 | 35 % | 10 / 3 | 35–70 % | guaranteed uncommon+ valuable |
| 3 | 귀중품 금고 | 4–5 | 55 % | 12 / 6 | 50–85 % | guaranteed rare+ valuable |
| 4 | 희귀 캐시 | 5–6 | 100 % | 12 / 8 | 60–100 % | guaranteed epic/legendary valuable **and** a weapon |

Rarity weights double as weapon-grade weights (grade ↔ rarity). `itemWeightMul` keys match an exact item id or, for weapons, the family (`wpn_sr` or `sr`) — applied to every grade (a unique is its own family, so `wpn_u_flame` is the key). At most one bag per crate. `rollCrate` is deterministic for a given `Random`; same-def stackables merge (an ammo overflow becomes a second smaller stack — so a crate can hold fewer instances than `count`) and the result is sorted largest-first for container placement. Phase 6: tier 5 gained `material: 4` (회로 기판 only), `weaponChance` 0.03 (uniques only) and `legendary: 1`; see *Unique weapons* for the unique / unique-ammo weights per tier. Phase 8: tiers 1–3 gained `seed: 4 / 4 / 3`; see *씨앗*. Phase 9: tiers 2–4 gained `book: 3 / 3 / 2`; see *서적*. 2026-09-12: tiers 2–4 gained `disc: 2 / 2 / 1.5` and tiers 3–5 `record: 1 / 1.5 / 1`; see *서재 매체*.

## Phase 3 (2026-09-06)
- Loot tier 5 `보급 투하 상자` (`SUPPLY_CRATE_TIER`): 4–6 consumables only (ammo 45 / stim 30 / grenade 25, guaranteed stim + ammo, no weapons or valuables). Used by the ship-call supply drop.

## Phase 4 (2026-09-06) — corpse tables (`rollCorpse`)

`LootRef.rollCorpse(type, rng = fallback, rogueWeaponId?)` rolls the contents of a dead enemy's corpse (enemies open it via `ctx.inventory.openContainerItems('corpse:<id>', items, pos, '시체')`). Deterministic for a given `Random`; every `CorpseDrop` is `chance` → `qty ∈ [min, max]`; the result is sorted largest-first like `rollCrate`. Unknown types return a single `mat_bio_sample`.

| type | always | chance |
|---|---|---|
| `scavenger` `hunter` `warrior` | `mat_bio_sample` ×1–3 | 25 % `terminid_gland` |
| `spewer` | `mat_bio_sample` ×1–3 | 60 % `terminid_gland` |
| `charger` | `mat_bio_sample` ×1–3 | 25 % `terminid_gland`, 40 % `mat_alloy` ×1–2 |
| `toxic` | `mat_bio_sample` ×1–2 | 35 % `terminid_gland` |
| `artillery` | `mat_bio_sample` ×2–3 | 50 % `mat_power_cell` |
| `behemoth` | `mat_alloy` ×2–4, `terminid_gland` ×1–2 | 30 % `alien_artifact` |
| `rogue` | calibre rounds + **its weapon** (see below) | 30 % `stim`, 20 % `grenade_frag` |
| `rogue_boss` | calibre rounds + **graded weapon** + one `att_*` (rarity ≤ epic, fitting the weapon when any does), `stim` ×1–2 | 20 % one **unique** (`wpn_u_*`, durability 50–80 %, random `ammoInMag`) + a 30–60 % stack of its calibre (Phase 6, rolled last) |
| `rogue_sniper` 로든 (2026-09-11) | 붕대 1–2 | 보스 수준 충전기 · 재료 · 서적 20 % · 임플란트 45 %, 공중 드론 20 % — **+ 확정 드롭**(아래 *네임드 로그 확정 드롭*) |
| `rogue_hammer` 타길라 (2026-09-11) | 붕대 1–2 | 보스 수준 + 회복주사 35 % · 고폭 수류탄 50 % · 합금 판 50 % · 원격 지뢰 35 % — **+ 확정 드롭** |
| `rogue_heavy` 헤비 (2026-09-11) | 붕대 1–2 | 보스 수준 + 화약 60 % (6–14) · 원격 지뢰 20 % · 지상 드론 15 % — **+ 확정 드롭** |
| `rogue_scan_drone` (2026-09-11) | — | 확률 0 한 줄 = 빈 결과 (`CORPSE_LOOT_CHANCE` 0 이라 애초에 수색 불가) |

Phase 10: **whether a corpse can be searched at all** is no longer this folder's call — `CORPSE_LOOT_CHANCE` (shared, per `EnemyType`: 잡버그 0.1 / 상위 버그 0.35 / behemoth · rogue · rogue_boss 1) is rolled by `src/enemies/Corpses.ts` on its own seeded stream, and `rollCorpse` is only ever called **after** that roll succeeded (`CORPSE_TABLES` and `rollCorpse` itself are unchanged, so `src/inventory/__selftest__.ts`'s exact-output assertions still hold).
Phase 8: every **bug** row above also rolls `BUG_SEEDS` (4 % `seed_bloodroot`, 2 % `seed_ashleaf`, 0.6 % `seed_glowcap`, one each) — see *씨앗*. `rogue` / `rogue_boss` do not.
Phase 9: `rogue` (3 %) and `rogue_boss` (20 %) roll one 서적 (`CorpseTable.book`, uniform over `BOOK_ITEM_DEFS`, rolled last) — see *서적*. Bugs do not.

Rogue weapon (`CorpseWeapon`): `rogueWeaponId` is the `WeaponDef` id the rogue carried (`DEFAULT_ROGUE_WEAPON_ID` = `ar` when undefined / unknown). The corpse holds one ammo stack of that calibre (`ammoItemIdFor(def.ammoType)`, 30–60 % of `AMMO_STACK_ROUNDS`) and the weapon item `wpn_<weaponId>` created with `durability = round(max × 0.05–0.15)` (min 1) and `ammoInMag = rng 0..magSize`. Bosses swap the def for the same family at grade III or IV (`weaponIdForGrade`) with durability 40–70 %.

## Tactical kit (merged 2026-09-06)

| File | Role |
|---|---|
| `ArmorDefs.ts` | 8 `ArmorDef`s (`ARMOR_DEFS`, `ARMOR_DEF_MAP`, `getArmorDef`), `armorItemSize(def)` grid footprint (**2026-09-12: 전부 2×2 고정**), `ARMOR_ICON`. 2026-09-10: `ArmorDef.shield` (실드 최대치) 가 실제로 쓰이는 값이고 `damageReduction` 은 환산 근거로만 남았다 |
| `Recipes.ts` | **제작만** — `data/recipes.csv` 94줄을 `CRAFT_RECIPES` 로 옮기고, 아이템 하나를 만드는 데 드는 재료를 `CRAFT_COST_BY_OUTPUT` / `craftCostOf(defId)` 로 색인한다 (`outputQty === 1` 인 레시피만 — 수리비 · 분해 산출의 기준이 이 색인이다) |
| `Salvage.ts` | **분해 · 수리 (2026-09-10 신규)** — 내구도 20 % 5구간(`durabilityBucketOf` · `durabilityBucketInfo` · `bucketOfRatio` · `DURABILITY_BUCKET_LABELS`), `repairCostFor(inst)`, `salvageFor(inst)`, `data/salvage.csv` 손 분해 6줄 + 제작 재료에서 생성한 분해 38줄(`SALVAGE_RECIPES`), `ALL_CRAFT_RECIPES` · `CRAFT_RECIPE_MAP` · `getRecipe`, 그리고 무한 이득 검산 `checkSalvageEconomy()` (`npm run data:check` 가 돌린다). Table in *Recipes* below |

New categories: `armor` (`ItemDef.armorId` → `ArmorDef`, `durabilityMax`), `gadget` (`gadgetId`, behaviour in `src/gadgets`), `herb` (gathered from `WorldRef.getGatherNodes()`); `mat_gunpowder` for the ammo recipes; every def carries a `weight` (kg, `itemWeight(def, qty)`, default `DEFAULT_ITEM_WEIGHT`). The branch's `BackpackDef` catalogue was **not** merged — bags stay the weapon-package `bag_*` items (`BagDef`, `bag.tactical` = hover / faster swap perk). Starter kit adds `armor_2` + one `gad_smoke`. `LootRef` gained `getArmorDef` and `getAllRecipes`; loot tables roll `gadget` / `herb` / `armor` (heavy deployables never in tier 1).

## Body armor (`ArmorDef`) — **실드** (2026-09-10)

**방탄복은 피해를 깎지 않는다.** `ArmorDef.shield` 만큼의 **추가 체력 풀**을 주고, 들어온 피해는 그 풀을 먼저
비운 뒤 남은 만큼만 체력(100)으로 간다. 번호 방탄복 I..V 는 `data/armor.csv` 가 `=ARMOR_SHIELD_BY_TIER.n` 으로
`data/tables.csv` 의 표를 그대로 가리키고, 유니크 3벌은 옛 뎀감률을 `round(damageReduction / ARMOR_DR_BY_TIER.5
× 100)` 으로 환산한 값을 직접 적었다. `ArmorDef.damageReduction` 은 **그 환산의 근거로만 남은 열**이고 코드
어디서도 읽지 않는다 (`PlayerRef.damageReduction` 도 늘 0 — 계약이라 지우지 않았을 뿐).

rarity 는 2026-09-10 에 tier 와 1:1 로 맞췄다 (I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설).

| id | 이름 | rarity | 실드 | kg | 내구도 | 칸 | ₩ | perk |
|---|---|---|---|---|---|---|---|---|
| `armor_1` | 방탄복 I | common | **20** | 3.0 | 200 | 2×2 | 832 | — |
| `armor_2` | 방탄복 II | uncommon | **40** | 3.8 | 280 | 2×2 | 1 196 | — |
| `armor_3` | 방탄복 III | rare | **60** | 4.2 | 380 | 2×3 | 1 588 | — |
| `armor_4` | 방탄복 IV | epic | **80** | 4.5 | 480 | 2×3 | 1 980 | — |
| `armor_5` | 방탄복 V | legendary | **100** | 5.8 | 600 | 2×3 | 2 400 | — |
| `armor_regen` | 재생 방탄복 | legendary | **90** | 6.2 | 520 | 2×3 | 2 162 | `regen`, `perkValue` 1 hp/s while stamina is full |
| `armor_ultralight` | 초경량 방탄복 | legendary | **33** | 1.9 | 300 | 2×2 | 1 136 | `ultralight`, `perkValue` 0.18 (스태미나 회복 + 이동속도) |
| `armor_optical` | 광학미채 방탄복 | legendary | **27** | 2.4 | 260 | 2×2 | 1 004 | `optical` — 상시 은폐 |

가격은 `data/tuning.csv` 의 `ARMOR_VALUE_BASE + shield × ARMOR_VALUE_SHIELD_MUL(12.6) + durabilityMax ×
ARMOR_VALUE_DUR_MUL` 이다 — 12.6 = 옛 `ARMOR_VALUE_DR_MUL`(4200) × 0.3 ÷ 100 이라 값은 그대로다.

**내구도는 그대로 남는다.** 실드가 먹은 피해 × `ARMOR_DURABILITY_PER_DAMAGE`(0.35) 만큼 판이 닳고, 0 이 되면
**파손 = 실드 최대치 0** 이다 (충전기로도 못 채운다). 함선 작업대에서 수리하면 되살아난다.

Perks are **declared here and implemented in `src/player`** (regen tick, ultralight speed/stamina, optical `setCloak(Infinity, 'armor')`).

### 실드 충전기 (2026-09-10, `SHIELD_CHARGE_MAP` / `shieldChargeOf`)

실드를 채우는 소모품 3종. `data/items.csv` 의 `shieldUseTime` · `shieldHp` 칸이 채워진 줄이 곧 충전기이고
(`shieldHp` **-1 = 완전 회복**), `ItemDefs.ts` 가 그것을 `SHIELD_CHARGE_MAP: Map<itemId, {useTime, amount}>` 으로
내준다 — `amount` 가 `Infinity` 면 최대치까지다. **`ItemDef` 에 칸을 새로 열지 않았다**: `src/shared` 는 조율
없이 고치지 않는 계약이라, `weapons/` 와 `inventory/` 가 이미 하고 있는 `@/items` import 로 `shieldChargeOf(defId)`
를 묻는다.

셋 다 `category: 'stim'` 이라 퀵슬롯 · 루팅 카테고리 · 손에 든 모습 · 좌클릭 홀드가 회복 소모품과 같은 길을
탄다. 다른 점은 홀드가 끝났을 때 `PlayerRef.applyHeal` 이 아니라 **`PlayerRef.chargeShield`** 로 간다는 것뿐이다.
방탄복이 없거나 실드가 이미 가득이면 **홀드가 시작조차 되지 않고 아이템도 줄지 않는다**.

| id | 이름 | rarity | 사용 | 효과 | 스택 | kg | ₩ |
|---|---|---|---|---|---|---|---|
| `shield_charger` | 실드 충전기 | common | 2 s | 실드 +20 | 5 | 0.3 | 60 |
| `shield_charger_hi` | 고출력 실드 충전기 | uncommon | 4 s | 실드 +40 | 5 | 0.35 | 170 |
| `shield_charger_full` | 완충 실드 충전기 | rare | 6 s | 실드 **완전 회복** | 2 | 0.5 | 430 |

**어디서 나오나** — 로그가 붕대와 함께 완제품을 들고 다닌다 (`rogue` 26 % / 고출력 6 %, `rogue_boss` 70 % /
30 % / 완충 8 %) 그리고 상자의 `stim` 굴림에 섞인다 (티어 1 ×0.5 · 2 ×0.8, 고급 · 완충은 낮은 티어에서 0).
**필드 제작**은 새 재료 `mat_core` 「구동 코어」(일반 재료, 1×1, 스택 10, 0.25 kg, ₩30 — 로그 시체 30 % 1–2 /
보스 80 % 1–3, 상자 티어 1–3) 와 `mat_cable` 전력 케이블 조합이다:
`make_shield_charger` (코어 1 + 케이블 1, 4 s) · `make_shield_charger_hi` (코어 2 + 케이블 2, 제작 15, 6 s) ·
`make_shield_charger_full` (코어 4 + 케이블 3 + 회로 기판 1, 제작 35, 8 s) — 전부 `station: 'field'` 라 **작업대
없이 레이드 현장에서** 만든다. 분해는 `break_shield_charger_hi` 하나 (→ 코어 1 + 케이블 1).

## Gadget consumables

`category: 'gadget'`, `quickUsable: true`, `gadgetId` pointing at a `GadgetId`. Behaviour lives in `src/gadgets`; items only carry the id.

| id | gadgetId | 칸 | stack | kg |
|---|---|---|---|---|
| `gad_cloak_veil` 은폐 장막 | `cloakVeil` | 1×2 | 2 | 1.1 |
| `gad_dome_shield` 돔 실드 | `domeShield` | 2×2 | 1 | 5.8 |
| `gad_barricade` 바리케이드 | `barricade` | 2×2 | 1 | 7.2 |
| `gad_lure` 유인 수류탄 | `lureGrenade` | 1×1 | 3 | 0.5 |
| `gad_smoke` 연막탄 | `smokeGrenade` | 1×1 | 3 | 0.55 |
| `gad_mine` 지뢰 | `mine` | 1×1 | 4 | 1.1 |
| `gad_turret` 포탑 설치 | `turret` | 2×2 | 1 | 9.5 |
| `gad_incendiary` 화염수류탄 | `incendiary` | 1×1 | 3 | 0.6 |
| `gad_defib` 제세동기 | `defib` | 2×1 | 1 | 2.4 |
| `gad_jumppad` 점프대 | `jumpPad` | 2×2 | 1 | 6.4 |
| `gad_remote_mine` 원격 지뢰 (2026-09-11) | `remoteMine` | 1×1 | 4 | 1.2 |
| `gad_drone_ground` 지상 드론 (2026-09-11) | `droneGround` | 2×2 | 1 | 4.8 |
| `gad_drone_air` 공중 드론 (2026-09-11) | `droneAir` | 2×2 | 1 | 3.6 |

**2026-09-11 새 가젯 3종** — 동작은 `src/gadgets` (원격 지뢰) · `gadgets/drones` (드론) 이고 items/ 는 정의 · 제작 · 루팅만 갖는다.

| id | rarity | ₩ | 제작 (가젯 작업대) | 상자 배수 (티어 1 / 2 / 3 / 4) | 시체 |
|---|---|---|---|---|---|
| `gad_remote_mine` 원격 지뢰 | rare | 340 | Lv.2 · 제작 25 — 화약 10 + 회로 기판 1 + 전력 케이블 2 | 0 / 0.6 / 1 / 1 | 타길라 35 % (1–3) · 헤비 20 % (1–2) |
| `gad_drone_ground` 지상 드론 | rare | 1 150 | Lv.2 · 제작 30 — 기계 부품 3 + 회로 기판 2 + 파워 셀 2 + 폐금속 6 | 0 / 0.4 / 0.7 / 1 | 헤비 15 % |
| `gad_drone_air` 공중 드론 | epic | 2 200 | **Lv.3** · 제작 40 — **제어 모듈 1 + 축전 모듈 2** + 기계 부품 2 + 회로 기판 2 | 0 / 0 / 0.4 / 0.8 | 로든 20 % |

- **드론은 스택 1** 이다 — 꺼내도 아이템이 소모되지 않고 조종기로 남으며, 드론이 파괴될 때 하나가 줄어든다
  (그 규칙은 `gadgets/drones` 가 `ctx.inventory` 로 처리한다). 공중 드론은 상위 재료 두 종류를 요구하므로
  **정제 작업대 Lv.2~3 을 거쳐야** 만든다.
- 가젯은 분해 · 수리 대상 카테고리가 아니어서 `checkSalvageEconomy()` 의 검산에 들어가지 않는다.
- 상자: 티어 5 보급 투하에는 `gadget` 카테고리가 없어 안 나온다. 기업 상점은 세레스(`ceres,gadget`)가 카테고리 전체를
  팔므로 따로 줄을 안 넣어도 신뢰도 등급 상한 안에서 뜬다.
- `rogue` · `rogue_boss` 시체 표에는 **넣지 않았다** — 줄 하나만 늘어도 그 표의 rng 소비가 밀려
  `inventory/__selftest__` 가 고정한 굴림이 바뀐다. 대신 네임드 로그 셋이 들고 다닌다.

## Weight (kg per unit)

`ItemDef.weight`; `itemWeight(def, qty)` falls back to `DEFAULT_ITEM_WEIGHT` (0.1). **Cells and kilograms are deliberately uncorrelated** so the bag is a real packing decision:

- `gem_void` 공허석 — 1×1 but **1.9 kg** (a brick you can pocket)
- `super_earth_medal` 슈퍼 지구 훈장 — 1×1, **0.15 kg**, ₩4 800 (best value per kg in the game)
- `salvage_electronics` — 2×1 but 3.2 kg, heavier than the 2×1 `data_core` (1.2 kg) worth five times more
- `gad_turret` — 2×2 and **9.5 kg**, the heaviest carryable
- `ammo_rifle` — only 2×1 yet 2.2 kg; a full ammo loadout eats the budget
- `cred_chip` — 0.02 kg, stacks to 5

## Herbs & crafting materials

`herb_bloodroot` 혈근초 (common, stack 8) · `herb_ashleaf` 잿빛잎 (uncommon, stack 8) · `herb_glowcap` 발광버섯 (rare, stack 6) — all 1×1, gathered from `WorldRef.getGatherNodes()` **or** harvested from a 온실 재배층 (see *씨앗* below).
2026-09-11 온실 개편의 **온실 전용 약재 3종** — `herb_frostmoss` 서리이끼 (uncommon, stack 8, ₩60) ·
`herb_emberpod` 불씨꼬투리 (uncommon, stack 8, ₩70) · `herb_ironleaf` 철엽초 (rare, stack 6, ₩150). 이 셋은
**채집 노드에도 루팅에도 없고 재배층에서만 나온다** (*작물 · 토양* 절). 소비처는 각각 소독약 · 소이 수류탄 ·
회복 스프레이 레시피 하나씩이다 (*Recipes* 의 작업대 표).
`mat_gunpowder` 화약 (material, 1×1, stack 20, 0.05 kg) is the ammo-conversion currency.

## 씨앗 (Phase 8, 2026-09-06 · 온실 개편 2026-09-11)

`category: 'seed'`, `ItemDef.seed: SeedDef {growHours, yieldDefId, yieldQty, soilTag}`. Planted in a 온실 **재배 스테이션**; `growHours` is **real** wall-clock time and keeps running while the game is closed — `src/housing` owns the plots, the timers (`GROW_SKILL_SPEEDUP` 원예 discount, `derived.gatherYieldMul` on the harvest) and the panel. Items only carry the data.

All of them: 1×1, `stackMax` 5, `weight` 0.05 kg, icon `CATEGORY_ICON.seed` (`⁘`), colour `CATEGORY_COLOR.seed` (`#c8e08a`) — seeds deliberately break the rarity-colour rule so a 씨앗 reads as one at a glance; the rarity ring still separates them. `growHours` comes from the shared `SEED_GROW_HOURS_BY_RARITY` table, never a literal here.

**2026-09-11 (온실 개편): `soilTag` 가 필수 열이다.** 씨앗은 이미 토양이 부어진 칸에만 들어가고, 그 토양의 태그와
같으면 `SOIL_MATCH_SPEEDUP` 만큼 빨리 · 다르면 `SOIL_MISMATCH_PENALTY` 만큼 늦게 자란다 (판정은 `src/housing`).
items/ 는 `r.enum('soilTag', SOIL_TAGS)` 로 옮기기만 하고 **fallback 을 주지 않는다** — 빠진 줄은 `data:check` 가 잡는다.

| id | 이름 | rarity | ₩ | growHours | soilTag | 수확 |
|---|---|---|---|---|---|---|
| `seed_bloodroot` | 혈근초 씨앗 | common | 40 | 1 h | mineral | `herb_bloodroot` ×3 |
| `seed_tuber` | 회색 덩이줄기 씨눈 | common | 35 | 1 h | mineral | `crop_tuber` ×3 |
| `seed_beanpod` | 단백 콩깍지 씨앗 | common | 40 | 1 h | humus | `crop_beanpod` ×3 |
| `seed_leafgreen` | 온실 잎채소 씨앗 | common | 32 | 1 h | humus | `crop_leafgreen` ×3 |
| `seed_ashleaf` | 잿빛잎 씨앗 | uncommon | 90 | 2.5 h | ash | `herb_ashleaf` ×3 |
| `seed_frostmoss` | 서리이끼 씨앗 | uncommon | 95 | 2.5 h | frost | `herb_frostmoss` ×3 |
| `seed_emberpod` | 불씨꼬투리 씨앗 | uncommon | 100 | 2.5 h | ash | `herb_emberpod` ×3 |
| `seed_capfungus` | 식용 갓버섯 균사 | uncommon | 85 | 2.5 h | frost | `crop_capfungus` ×2 |
| `seed_glowcap` | 발광버섯 씨앗 | rare | 220 | 6 h | humus | `herb_glowcap` ×2 |
| `seed_ironleaf` | 철엽초 씨앗 | rare | 240 | 6 h | mineral | `herb_ironleaf` ×2 |

**Where they come from** (design decision: 루팅 + 기업 상점, **제작 불가**): container tiers **1–3** carry `seed` as a modest category (`categoryWeights` **6 / 6 / 5** — 2026-09-11 에 4 / 4 / 3 에서 올렸다: 씨앗 종류가 3 → 10 이라 한 씨앗이 뽑힐 확률이 그만큼 얇아졌다), rolling 1–`maxStackQty` seeds per pick. Tiers 4 / 5 have no `seed` weight at all. **씨앗 픽은 `data/seeds.csv` 의 모든 줄 중에서 등급 가중치로 고른다** (`pickDef` 가 `ITEM_DEFS` 를 카테고리로 거른다) — 하드코딩된 목록이 없으므로 새 씨앗은 줄만 넣으면 저절로 들어오고, 티어 1 의 `rare 2/100` + 행성 rank 1 의 `rareMul 0.5` 가 희귀 씨앗을 초반 행성에서 막는다. Every **bug** corpse table (`scavenger` / `hunter` / `warrior` / `charger`, plus `spewer` / `toxic` / `artillery` / `behemoth`) adds the **original three** — 4 % 혈근초 / 2 % 잿빛잎 / 0.6 % 발광버섯; 2026-09-11 에 새 씨앗을 **여기에는 넣지 않았다** (줄이 늘면 `rollCorpse` 의 rng 소비가 밀려 고정 벡터를 세는 스모크가 흔들린다 — 상자만으로 충분하다). The corp shop reads `ITEM_DEFS` directly, so seeds show up there without extra wiring. **No `CraftRecipe` exists for a seed.**

실측(행성 5 × 티어 1–5 × 6000 상자 + 시체 10종 × 6000): 10종 전부가 등급 순서대로 나온다 —
혈근초 3090 · 콩깍지 1315 · 잎채소 1302 · 덩이줄기 1211 · 잿빛잎 1963 / 불씨꼬투리 865 · 서리이끼 840 · 갓버섯 877 ·
발광버섯 698 · 철엽초 504. (혈근초가 높은 것은 벌레 시체 몫이다.)

## 작물 · 토양 (온실 개편, 2026-09-11)

**작물** `category: 'crop'` — 재배층 수확물이고 추가 필드가 없는 평범한 스택 아이템이다 (1×1, stack 8 / 갓버섯만 6).
`crop_tuber` 회색 덩이줄기 (common ₩30) · `crop_beanpod` 단백 콩깍지 (common ₩35) · `crop_leafgreen` 온실 잎채소
(common ₩28) · `crop_capfungus` 식용 갓버섯 (uncommon ₩55) — **2026-09-11 연구실 계약으로 4종 추가**:
`crop_ashgrain` 잿빛 곡물 (common ₩32) · `crop_saltmelon` 염수박 (uncommon ₩60) · `crop_sporecap` 포자 갓
(uncommon ₩58) · `crop_frostberry` 서리열매 (uncommon ₩62). **주방(요리) 시설은 이번 범위 밖**이라 지금 쓰임새는
**판매 + 세레스 바이오 납품**(`cg1`) 둘뿐이다 — 설명문의 "주방 시설이 열리면 요리 재료가 된다" 는 그 약속이다.

**토양** `category: 'soil'`, `ItemDef.soil: SoilDef {tag, uses}` — 재배층 칸에 **붓는** 물건이고, 씨앗보다 먼저 들어간다.
`uses` 는 한 번 부은 토양이 견디는 수확 횟수이고 등급 곡선은 `SOIL_USES_BY_RARITY`(`data/tables.csv`) 다.
`soil_humus` 부엽토 (common, humus, 2회) · `soil_ash` 화산재토 (uncommon, ash, 3) · `soil_frost` 동토 이탄
(uncommon, frost, 3) · `soil_mineral` 광물토 (rare, mineral, 5) — **2026-09-11 연구실 계약으로 2종 추가**:
`soil_saline` 염류 결정토 (rare, saline, 5) · `soil_spore` 포자 부식토 (uncommon, spore, 3).

**루팅에는 셋 다 없다** (사용자 결정 — 온실 산출물을 레이드에서 주울 수 있으면 재배할 이유가 없다):

- **작물 · 토양** — `data/loot_category_weights.csv` 에 `crop` · `soil` 줄이 **아예 없다.** 상자 굴림은 그 표의
  카테고리 중에서만 고르므로 줄이 없는 것이 곧 차단이다 (확정 픽 `loot_guaranteed.csv` 에도 없다).
  토양은 **바이오별 채집 노드** 전용이다 (`GatherNodeKind 'soil'`, `src/world` 담당).
- **새 약재 3종** (`herb_frostmoss` · `herb_emberpod` · `herb_ironleaf`) — `herb` 는 티어 1–4 의 카테고리라
  줄이 없으면 그냥 나온다. 그래서 `data/loot_item_weights.csv` 에 **티어 1–5 × 3종 = 15줄을 `mul 0`** 으로 박았다
  (`key_basement` 와 같은 방식). 기존 약초 3종은 그대로 채집 · 상자에서 나온다.

검증: 행성 5 × 티어 1–5 × 6000 상자 + 시체 10종 × 6000 = 76만 아이템에서 작물 · 토양 · 새 약재 **0개**.

## 미확인 표본 · 준비물 (연구실 A-12 · A-13, 2026-09-11)

**표본** `category: 'sample'` — `data/samples.csv` **전용 파일**(씨앗 · 서적과 같은 결)이고 `SAMPLE_ITEM_DEFS` 가
한 줄을 `ItemDef` 로 옮긴다. 1×1 · 아이콘 `◍`(`CATEGORY_ICON.sample`) · 색 `CATEGORY_COLOR.sample` ·
스택 `SAMPLE_STACK_MAX`(3) · 무게 `SAMPLE_WEIGHT`(0.4 kg) — 넷 다 `data/tuning.csv` 다. `ItemDef.sample: SampleDef`
`{ analyzeHours, rewardDefId, rewardQty, firstDefId?, firstQty? }` 이고 `first*` 만 선택 열이다 (`optStr`/`optNum` 규약).
`analyzeHours` 는 **도감이 텅 빈 상태에서의 실제 시간**이라 함선을 떠나 있어도 흐르고, 도감 진척 · 기지식으로
깎는 계산(`ANALYZE_DEX_SPEEDUP` · `ANALYZE_KNOWN_SPEEDUP`)은 `housing/Rules` 몫이다 — items 는 표만 옮긴다.

| id | 이름 | rarity | ₩ | 해석 | 매번 | 첫 해석 보너스 |
|---|---|---|---|---|---|---|
| `spec_tissue` | 미확인 생체 조직 | common | 60 | 1 h | `mat_bio_sample` ×4 | `seed_ashgrain` ×2 |
| `spec_spore` | 미확인 포자낭 | uncommon | 110 | 2 h | `mat_extract_bio` ×1 | `seed_sporecap` ×2 |
| `spec_chitin` | 미확인 키틴 조각 | uncommon | 110 | 2 h | `mat_bio_sample` ×6 | `seed_saltmelon` ×2 |
| `spec_resin` | 미확인 수지 덩어리 | rare | 240 | 4 h | `mat_extract_bio` ×2 | `seed_frostberry` ×2 |
| `spec_crystal` | 미확인 결정 표본 | rare | 240 | 4 h | `seed_deeproot` ×1 | `mat_extract_min` ×2 |
| `spec_genome` | 봉인된 유전자 시료 | epic | 480 | 8 h | `seed_lumenpod` ×1 | `mat_control_module` ×1 |

개량 품종 2종이 **매번 보상** 쪽에 있는 것은 의도다 (한 번만 주면 두 번 다시 못 기른다 — `samples.csv` 머리 주석).

**어디서 나오나** — 제작도 상점도 없다. ① **벌레 시체** (`data/loot_corpses.csv`, 로그 · 보스 · 네임드 줄에는
없다 — "로그는 표본에 관심이 없다"), ② **표본 채집지** (`data/planets.csv` 의 `samples`/`sampleNodes`, `src/world` 담당),
③ **티어 3+ 컨테이너** (`loot_category_weights.csv` 의 `sample` 5 / 7 / 9 — 티어 1·2 에는 줄 자체가 없다).
티어 3 에서만 `spec_genome` · `spec_crystal` 이 `loot_item_weights.csv` 로 0 이다. **`Loot.ts` 는 한 줄도 안 바뀌었다** —
카테고리 굴림이 `categoryWeights` 의 키에서만 고르고 `pickDef` 가 `ITEM_DEFS` 를 카테고리로 거르므로, 새 카테고리는
csv 줄이 곧 배선이다.

**준비물** `category: 'prep'` — 표본과 달리 `data/items.csv` 의 평범한 줄이고, 새 **선택 열 `prepEnv` · `prepShort`**
가 채워져 있으면 `ItemDef.prep: PrepDef {env, short}` 가 붙는다 (`soil` 과 같은 선택 열 규약 —
`r.optEnum('prepEnv', ENV_KINDS)` 가 있을 때만). 함선에서 써서 **다음 레이드 1회분**으로 싣고 그 행성 환경 피해를
**완전히** 막는다; 실제 소모 · 면제 · 배지는 `progression` · `player` · `ui` 가 하고 items 는 표만 준다.

| id | 이름 | rarity | ₩ | 칸 · 스택 | env | short |
|---|---|---|---|---|---|---|
| `prep_respirator` | 여과 호흡기 | uncommon | 180 | 1×2 · 2 | `toxin` | 방독 |
| `prep_coolant` | 내열 냉각재 | uncommon | 180 | 1×2 · 2 | `heat` | 내열 |

준비물은 **루팅에 없다** (`loot_category_weights.csv` 에 `prep` 줄이 없다) — 조합대에서만 나온다.
표본 · 준비물 **둘 다 분해 · 수리 대상이 아니다** (`Salvage.REPAIRABLE` 무변경, `checkSalvageEconomy()` 그대로 통과).

`ITEM_DEFS` 조립 순서는 … 약초 → **작물 → 토양 → 요리 → 표본 → 준비물 → 배양 · 프린터 재료 → 주머니 → 열쇠**
→ 씨앗 → 서적 … 이다 (밭에서 나온 것 → 그 산물 → 연구실에서 쓰는 것 → 그 산물, 사슬 순서 그대로).
게임 안 목록 순서가 이 순서다.

## 요리 · 주머니 · 배양 재료 · 열쇠 (주방 · 배양조 · 프린터 A-3c · A-14 · A-15, 2026-09-11)

한 사슬이다: **표본 →(분석기)→ 세포주 → (배지와 함께) 배양조 → 배양 산물 →** ① **조리대 → 요리 → 식탁**,
② **추출기 → 필라멘트 → 프린터 → 상급 가방 · 주머니**. items/ 는 그 사슬의 **정의만** 갖는다 — 배양조 칸 ·
식탁 · 프린터 화면은 `housing` · `inventory` 몫이다.

### 요리 `category: 'meal'` — `data/meals.csv` (새 전용 파일)

`MEAL_ITEM_DEFS` 가 한 줄을 `ItemDef` 로 옮긴다 (`SEED_ITEM_DEFS` · `SAMPLE_ITEM_DEFS` 와 같은 모양).
1×1 고정, **아이콘 · 스택 · 무게 · 가격은 csv 칸 그대로**이고 **색은 등급색**이다 — 씨앗 · 표본처럼
`CATEGORY_COLOR` 로 덮지 **않는다**: 요리는 일반 → 서사가 곧 tier 1 → 2 이라 격자에서 「특선인가」가 색으로 읽혀야 한다.

`ItemDef.meal: MealDef { buff, amount, tier }`. `buff` 는 `MealBuff` = **`DerivedStats` 에 이미 있는 필드 이름**이라
소비자가 한 줄도 안 바뀐다 — 접어 넣는 곳은 `progression/recomputeDerived` 하나다. `amount` 는
`isMealBuffMultiplier(buff)` 면 배수에 가산(0.2 = +20 %), 아니면 단위 그대로(kg · 스태미나 포인트 · m);
`durabilityLossMul` 만 **음수**라 로더가 `min` 을 걸지 않는다. `tier` 1 = 일반(작물만, 조리대 Lv.1) ·
2 = 특선(배양 산물 필요, Lv.2–3).

| id | 이름 | rarity | tier | 버프 | amount | ₩ · kg · 스택 |
|---|---|---|---|---|---|---|
| `meal_tuber_stew` | 덩이줄기 스튜 | common | 1 | `maxStamina` | +15 | 90 · 0.35 · 3 |
| `meal_bean_porridge` | 콩죽 | common | 1 | `carryCapacity` | +6 kg | 95 · 0.35 · 3 |
| `meal_green_salad` | 잎채소 샐러드 | common | 1 | `staminaRegenMul` | +20 % | 90 · 0.3 · 3 |
| `meal_ash_bread` | 잿빛 빵 | common | 1 | `searchSpeedMul` | +25 % | 95 · 0.3 · 3 |
| `meal_mushroom_soup` | 갓버섯 수프 | uncommon | 1 | `healPowerMul` | +20 % | 150 · 0.35 · 3 |
| `meal_berry_compote` | 서리열매 조림 | uncommon | 1 | `gatherYieldMul` | +25 % | 160 · 0.3 · 3 |
| `meal_cultured_steak` | 배양육 스테이크 | rare | 2 | `gritChance` | +10 % | 380 · 0.4 · 3 |
| `meal_protein_omelet` | 유단백 오믈렛 | rare | 2 | `skillGainMul` | +15 % | 360 · 0.35 · 3 |
| `meal_algae_broth` | 미세조류 육수 | epic | 2 | `detectRadius` | +6 m | 620 · 0.3 · 3 |
| `meal_field_ration` | 특제 전투식량 | epic | 2 | `durabilityLossMul` | **−20 %** | 640 · 0.4 · 3 |

⚠ **크레딧 · 판매가를 올리는 버프는 일부러 없다** — 서버가 크레딧을 사유별로 검증하므로(E-4) 클라이언트 배수는
그대로 `credits:tx` 거절이 된다. 보상계는 숙련 XP · 채집량 · 감정 속도로 낸다.

### 배양 재료 `category: 'material'` — `data/items.csv` 의 새 선택 열 4쌍

`soil` · `prep` 과 같은 선택 열 규약이다 (칸이 비어 있으면 필드 자체가 안 붙는다).

- `strainOut` · `strainQty` · `strainHours` → `ItemDef.strain: StrainDef { outputDefId, outputQty, cultureHours }`
- `mediumUses` · `mediumSpeed` → `ItemDef.medium: MediumDef { uses, speedMul }`

`outputDefId` 가 가리키는 아이템이 있는지는 로더가 보지 않는다 — `SampleDef.rewardDefId` 와 같다
(`ITEM_DEF_MAP` 이 아직 없다; 이름 검사는 `npm run data:check` 몫).

| id | 이름 | rarity | ₩ | 무엇 |
|---|---|---|---|---|
| `mat_medium_basic` | 기본 영양 배지 | uncommon | 90 | 수확 2회 · 속도 ×1 |
| `mat_medium_rich` | 강화 영양 배지 | rare | 210 | 수확 4회 · 속도 ×0.7 |
| `strain_algae` | 조류 배양체 | uncommon | 130 | → `cult_algae` ×3, 4 h |
| `strain_myocyte` | 근세포주 | rare | 300 | → `cult_meat` ×2, 8 h |
| `strain_adipocyte` | 지방세포주 | rare | 280 | → `cult_fat` ×2, 6 h |
| `strain_casein` | 유선세포주 | rare | 290 | → `cult_casein` ×2, 7 h |
| `strain_ovum` | 난세포주 | rare | 290 | → `cult_albumen` ×2, 7 h |
| `cult_algae` · `cult_meat` · `cult_fat` · `cult_casein` · `cult_albumen` | 배양 산물 5종 | uncommon~rare | 70~180 | 요리 재료 + 필라멘트 원료 |
| `mat_filament_1` · `_2` · `_3` | 기본 · 고강도 · 복합 필라멘트 | rare · epic · legendary | 320 · 700 · 1500 | 프린터 재료 |

새 표본 5종(`spec_biofilm` · `spec_adipose` · `spec_gland` · `spec_ovule` · `spec_muscle`)이 각각 세포주로 해석된다
(`data/samples.csv`) — **코드 변경 0**, 위 *미확인 표본* 절의 로더가 그대로 읽는다.

### 주머니 `category: 'pouch'` — `pouchCols` · `pouchRows` · `pouchAccepts`

장비칸의 `pouch` 한 칸(고정 1칸)에 끼우면 **퀵슬롯 아래에 자기 격자**가 열린다 — 격자 · 장착 규칙은 `inventory` 몫이고
items 는 `ItemDef.pouch: PouchDef { cols, rows, accepts }` 만 준다. `accepts` 는 `|` 로 이은 `ItemCategory` 목록이라
**`r.enumList` 가 모르는 이름을 스스로 신고한다**; 허용 목록 `ITEM_CATEGORIES` 는 손으로 적지 않고
`CATEGORY_LABEL_KO`(= `Record<ItemCategory, string>`)의 키에서 뽑으므로 카테고리가 늘면 저절로 따라온다.
받는 카테고리가 **하나도 없는** 주머니는 `r.report` 로 걸린다 (빈 격자를 조용히 만들지 않는다).

| id | 이름 | rarity | 격자 | 받는 것 | ₩ · kg |
|---|---|---|---|---|---|
| `pouch_gather` | 채집 주머니 | rare | 2×2 | `herb` `seed` `soil` `crop` `sample` | 420 · 0.45 |
| `pouch_key` | 열쇠 주머니 | rare | 3×1 | `key` | 380 · 0.35 |
| `pouch_medical` | 구급 주머니 | epic | 4×1 | `stim` | 760 · 0.5 |
| `pouch_valuable` | 귀중품 주머니 | epic | 2×2 | `valuable` | 800 · 0.45 |

아이템 자체는 **2×1**(`items.csv` 의 `width`/`height`)이고 **내구도가 없다** — `Salvage.REPAIRABLE` ·
`SALVAGEABLE` 는 한 줄도 안 바뀌었다 (요리 · 세포주 · 배지 · 배양 산물 · 필라멘트도 같다).

### 열쇠 `category: 'key'`

`key_basement` 가 `valuable` 에서 갈라져 나왔다 — **열쇠 주머니가 귀중품과 섞이면 안 되기 때문**이다.
`ItemDef` 에 새 필드는 없고 카테고리만 바뀌었다 (`items.csv` 의 그 한 칸). ~~아래 *지하실 키카드* 절의 성질
(값 0 · 무작위 루팅 차단 · 열면 소비)은 그대로다.~~ → **2026-09-12 에 소모형 만능 열쇠 두 종으로 바뀌었다** (아래 *소모형 만능 열쇠* 절).

### 루팅 — **코드 변경 0**

`meal` · `pouch` 는 `loot_category_weights.csv` 에 **줄이 없다** (`key` 는 2026-09-12 부터 티어 3 · 4 에 줄이 있다 — 아래 *소모형 만능 열쇠*). `Loot.rollCrate` 의 카테고리 굴림은
`Object.keys(table.categoryWeights)` 에서만 고르고 그 표는 csv 줄에서만 채워지므로 **줄이 없는 것이 곧 차단**이다
(작물 · 토양 · 준비물과 같은 근거). `loot_guaranteed.csv` 의 확정 픽도 카테고리를 직접 적으므로 후보가 아니다.
함선 전용 재료 15종(배지 2 · 세포주 5 · 배양 산물 5 · 필라멘트 3)은 `material` 카테고리라 줄만으로는 못 막아
`loot_item_weights.csv` 에 **티어 1–5 × 15줄 = 75줄이 `mul 0`** 으로 들어가 있다. 새 표본 5종은
`loot_corpses.csv`(벌레 8종) · `loot_category_weights.csv` 의 기존 `sample` 줄이 그대로 처리한다.

## 서적 (Phase 9, 2026-09-06)

`category: 'book'`, `ItemDef.book: BookDef {skill}`. **One book per skill** — 14 of them, `BOOK_ITEM_DEFS` in `SKILL_IDS`
order, id `book_<skillId>` (`bookItemIdFor(skill)`, e.g. `book_gun_AR`), plus the lookup `BOOK_DEF_BY_SKILL`
(a `SKILL_IDS` entry without a book logs a console warning at module load). Shelved in a 서재 **책장**
(`furn_bookshelf`, `BOOKS_PER_SHELF` slots) — `src/housing` owns the shelves, the 도감 and the bonus
(`1 + BOOK_XP_PER_BOOK × Σ BOOK_RARITY_MUL[rarity]`, capped at `BOOK_GAIN_MAX`, folded into
`housing.getSkillGainMul`). Items only carry the data.

All 14: **1×2**, `stackMax` 1 (never stack), `weight` 0.6 kg, icon `CATEGORY_ICON.book`, colour `CATEGORY_COLOR.book`
(books break the rarity-colour rule the way 씨앗 do; the rarity ring still separates them), `value` from the local
`BOOK_VALUE_BY_RARITY` table (150 / 320 / 700 / 1500 / 3000). Rarity is per skill and decides its shelf weight:
**common 4** (`carry` 『짐꾼의 요령』, `gardening` 『함선 원예 입문』, `gun_AR` 『사격 교본: 돌격소총』,
`gun_SMG` 『사격 교본: 기관단총』), **uncommon 5** (`appraisal` 『감정사의 눈』, `grit` 『버티는 법』,
`crafting` 『야전 제작 편람』, `gun_SG` 『사격 교본: 산탄총』, `equipment` 『장비 정비 매뉴얼』),
**rare 3** (`medicine` 『전장 의학』, `gun_SR` 『사격 교본: 저격소총』, `gun_DMR` 『사격 교본: 지정사수소총』),
**epic 2** (`cryptography` 『암호 해독 원론』, `implant` 『전술 임플란트 운용 지침』).

**Where they come from** (design decision: 루팅 + 기업 상점, **제작 불가**, never quick-usable): container tiers
**2–4** carry `book` as a small category (`categoryWeights` 3 / 3 / 2); tiers 1 and 5 have none. `CorpseTable.book`
(`CorpseBook {chance}`) adds one book — uniform over `BOOK_ITEM_DEFS` — to **rogue** corpses at 3 % and
`rogue_boss` at 20 %, rolled **after** the unique so every earlier draw is unchanged; bugs never carry one
(they carry `BUG_SEEDS` instead). The 세레스 corp shop stocks `{category:'book', minRepLevel:2}`. No `CraftRecipe`
outputs a book.

## 서재 매체: 디스크 · 레코드 (A-3e, 2026-09-12)

책과 **똑같은 역할**의 아이템 2종. `category: 'disc'` / `'record'`, `ItemDef.disc` / `ItemDef.record` (모양은 `BookDef {skill}`).
숙련 하나에 한 장씩 — 각 14장, id `disc_<skill>` · `record_<skill>` (`discItemIdFor` · `recordItemIdFor`), 조회
`DISC_DEF_BY_SKILL` · `RECORD_DEF_BY_SKILL`. 원본은 **전용 파일** `data/discs.csv` · `data/records.csv` (열은
`books.csv` 와 같다: `skill,name,rarity,description`). 두 파일을 `ItemDefs.shelfMediumDefs` 로더 하나가 읽고,
책 로더와 달리 `skill` · `rarity` 를 열거값으로 읽어 **같은 숙련의 책과 등급이 다르거나 한 숙련이 두 줄이면**
`npm run data:check` 가 잡는다. 디스크는 서재 **디스크 전시대**(`furn_disc_stand`), 레코드는 **레코드랙**
(`furn_record_rack`)에 꽂고 — 매체별 몫 · 상한 · 보조 가구 배율(TV · 레코드 플레이어)은 전부 `housing/` 이 `SHELF_*`
표로 계산한다. items 는 데이터만 갖는다.

| | 디스크 | 레코드 |
|---|---|---|
| 칸 · 스택 | **2×2** · 1 | **3×3** · 1 |
| 무게 (`tuning.csv`) | `DISC_WEIGHT` 0.4 kg | `RECORD_WEIGHT` 0.9 kg |
| 가격 (`tables.csv`, 일반 → 전설) | `DISC_VALUE_BY_RARITY` 210 / 450 / 980 / 2100 / 4200 | `RECORD_VALUE_BY_RARITY` 280 / 600 / 1300 / 2800 / 5600 |
| 아이콘 · 색 | `CATEGORY_ICON.disc` ◉ · `CATEGORY_COLOR.disc` | `CATEGORY_ICON.record` ⊚ · `CATEGORY_COLOR.record` |
| 상자 (`loot_category_weights.csv`) | 티어 2 · 3 · 4 = 2 / 2 / 1.5 (책 3 / 3 / 2 보다 조금 낮게) | 티어 3 · 4 · 5 = 1 / 1.5 / 1 |
| 세레스 상점 (`corp_stock.csv`) | 신뢰도 **3** | 신뢰도 **4** |

가격은 책(150 / 320 / 700 / 1500 / 3000)의 약 1.4 배 · 1.9 배 — 서재 몫이 책 < 디스크 < 레코드 순으로 세다.
등급은 책과 같으므로 상점의 신뢰도 등급 상한(`SHOP_RARITY_CAP_BY_REP` 3 = 서사, 4 = 전설)에 막히는 줄이 없다.
이름 표기로 매체를 가른다 — 책 『…』 · 디스크 〈…〉 · 레코드 《…》. 설명에는 숫자가 없다.
**제작 불가 · 퀵슬롯 불가**, 그리고 로그 시체의 서적 굴림(`CorpseTable.book`)은 **여전히 책만** 준다
(`Loot.rollCorpse` 가 `BOOK_ITEM_DEFS` 에서 고른다 — rng 벡터 불변). 상자 굴림은 카테고리 가중치에서 카테고리를 먼저
뽑고 그 카테고리의 def 를 등급 가중치로 고르는 일반 경로라 코드 변경이 없다.

## Recipes (`getAllRecipes`) — 제작 100 + 분해 44 (2026-09-10 제작 대개편, 2026-09-11 가젯 3줄 · 온실 약재 3줄)

원본은 **`data/recipes.csv`**(제작 97줄)와 **`data/salvage.csv`**(손으로 적은 분해 6줄)다. 나머지 분해 38줄은
`Salvage.ts` 가 **제작 재료에서 생성한다** — 무기 25종 · 방탄복 5벌 · 가방 8종. `ALL_CRAFT_RECIPES` = 제작 + 분해이고
그것이 `ctx.loot.getAllRecipes()` 다. `CRAFT_RECIPE_MAP` / `getRecipe` 는 이제 `Salvage.ts` 에 있다 (배럴 경유라 호출부 무변경).

`station: 'field'` recipes also work on the ship. `station: 'ship'` recipe 는 전부 `bench`(`WorkbenchKind`:
gun 총기 / gear 장비 / gadget 가젯 / medical 의학 / **refine 정제**)와 `benchLevel` 을 갖고,
`inventory.getRecipes('ship', bench, level)` 이 둘 다로 거른다 (`ctx.housing.getBenchLevel`).

### 재료 등급 축 — 3계열 × 2단계

```
금속계  폐금속 ──▶ 합금 판 ──▶ 강화합금 잉곳 mat_ingot          [완벽 상위호환]
        폐금속 + 전력 케이블 ──▶ 기계 부품 mat_machine_parts    [파생 상위]
전자계  구동 코어 ──▶ 축전 모듈 mat_capacitor                   [완벽 상위호환]
        회로 기판 + 파워 셀 ──▶ 제어 모듈 mat_control_module    [파생 상위]
섬유계  천조각 ──▶ 강화 직조포 mat_weave                        [완벽 상위호환]
        천조각 + 생체 조직 ──▶ 복합 방탄섬유 mat_ballistic_fiber [파생 상위]
```

**상위 재료는 정제 작업대(`bench: 'refine'`)에서만 나온다** — 현장 빠른제작이 없다. 장비군별 상위 재료:
총기 = 잉곳 + 기계 부품 · 실드(방탄복) = 축전 모듈 + 제어 모듈 · 가방 = 강화 직조포 + 복합 방탄섬유.
등급 IV~V · 서사/전설 장비는 **반드시** 그 상위 재료를 요구하므로 정제 작업대가 최고급 장비의 관문이다.
"완벽 상위호환" 은 상위를 요구하는 자리에 하위를 못 넣는다는 뜻이고, **대체 투입 규칙은 없다** — 레시피가 적은 id 그대로다.

### 작업대별 배치

| 작업대 | Lv.1 | Lv.2 | Lv.3 |
|---|---|---|---|
| **정제** `refine` (7) | 합금 판 · 강화 직조포 · 기계 부품 | 축전 모듈 · 복합 방탄섬유 | 강화합금 잉곳 · 제어 모듈 |
| **총기** `gun` (45) | AR · SMG · SG 등급 I~II (6) | 전 계열 등급 III (5) + DMR · SR 등급 I~II (4) + 부착물 하위 6 | 전 계열 등급 IV~V (10) + 부착물 상위 8 + 유니크 탄약 6 |
| **장비** `gear` (13) | 방탄복 I~II · 가방 일반/고급 | 방탄복 III · 가방 희귀(전술 포함) | 방탄복 IV~V · 가방 서사/전설(전술 포함) |
| **가젯** `gadget` (16) | 고폭 · 연막 · 소이 수류탄 · **불씨 소이 수류탄** | 유인 · 화염수류탄 · 지뢰 · **원격 지뢰 · 지상 드론** | 바리케이드 · 점프대 · 은폐 장막 · 제세동기 · 돔 실드 · 포탑 · **공중 드론** |
| **의학** `medical` (11) | 소독약 · **저온 소독약** · 회복주사 · 혈근초 · **실드 충전기** | 스프레이 · 붕대 대량 · 발광버섯 · **고출력 충전기** | **철엽 스프레이** · **완충 충전기** |
| **현장** `field` (9) | 탄약 4종 · 연막 · 소이 수류탄 2종 · 붕대 2종 | | |

**온실 약재 3종의 소비처** (2026-09-11 — 값만 있고 쓸 데 없는 아이템은 죽은 데이터다). 셋 다 **새 산출물을 만들지
않고** 기존 아이템의 *대체 경로*이고, 전부 `outputQty ≥ 2` 라 `CRAFT_COST_BY_OUTPUT`(수리 · 분해의 기준)에는
들어가지 않는다 — 기존 레시피가 여전히 그 아이템의 "값어치" 다:

| id | 작업대 | 재료 → 산출 | 뜻 |
|---|---|---|---|
| `make_incendiary_ember` | 가젯 Lv.1 (현장) | 화약 6 + **불씨꼬투리 1** → 소이 수류탄 **2** | 잿빛잎 2 + 화약 8 → 1 보다 낫다 |
| `make_antiseptic_frost` | 의학 Lv.1 (의학 15) | 캔 2 + **서리이끼 1** → 소독약 **2** | 서리이끼 한 줌 = 혈근초 두 뿌리 |
| `make_heal_spray_iron` | 의학 Lv.3 (의학 50) | 캔 1 + 소독약 1 + **철엽초 1** → 회복 스프레이 **2** | 철엽초가 산출을 두 배로 |

**작물 4종에는 레시피가 없다** — 주방 시설이 열릴 때까지 판매 · 납품 전용이다 (사용자 결정).

무기 25종은 **손으로 적었다** (`make_wpn_<family>[_g2..g5]`). 등급 곡선(value ×1.6/등급)과 재료 등급 곡선이
하나의 공식으로 안 맞아 떨어져 — 어떤 공식을 써도 IV 와 V 가 붙거나 등급 I 이 폭발했다 — 그리고 DMR · SR 만
Lv.1 에서 빠지는 예외까지 표로 들어가야 했다. 대신 `checkSalvageEconomy()` 가 **제작 레시피 없는 비유니크
무기 def** 를 잡아 주므로 계열이 늘어나면 `npm run data:check` 가 바로 알려 준다.

폐금속 기준선(등급 I → V): ar 8·11·14·16·18 · smg 10·14·17·20·23 · sg 11·15·19·22·25 · dmr 14·20·24·28·32 ·
sr 15·21·26·30·35. 등급 III 부터 합금 판 + 기계 부품, IV 부터 강화합금 잉곳이 붙는다 (DMR · SR 은 한 단계 더).
재료 총가치는 모든 무기에서 판매가(`value`)보다 낮다 — 만드는 편이 사는 편보다 싸다.

### 내구도 연동 수리 · 분해 (`Salvage.ts`)

기준은 **그 아이템의 제작 재료**다. 남은 내구도를 20 % 단위 다섯 구간으로 나누고
(`durabilityBucketOf` → 0 = 0~20 % … 4 = 81~100 %, 내구도가 없는 아이템은 4) 구간별 배수를 곱한다
(`data/tables.csv` 의 `REPAIR_COST_BY_DURABILITY` · `SALVAGE_YIELD_BY_DURABILITY`). 수리가 되는 카테고리
(`REPAIRABLE`)는 **주무기 · (옛) 보조무기 · 방탄복 · 가방**이다 (2026-09-11 가방 추가):

| 남은 내구도 | 수리 (올림) | 분해 (내림) | 합 |
|---|---|---|---|
| 81~100 % | ×0.10 | ×0.40 | 0.50 |
| 61~80 % | ×0.20 | ×0.32 | 0.52 |
| 41~60 % | ×0.30 | ×0.24 | 0.54 |
| 21~40 % | ×0.40 | ×0.16 | 0.56 |
| 0~20 % | ×0.50 | ×0.08 | 0.58 |

- **반올림** — 수리는 올림, 분해는 내림 (둘 다 플레이어에게 불리한 쪽 = 착취 방지).
  분해는 **재료 종류마다 최소 1 을 보장하지 않는다**: 보장하면 등급 IV 총의 「강화합금 잉곳 2」가 통째로
  돌아와 「제작 → 분해 → 제작」이 이득이 된다. 예외는 **제일 많이 든 재료 한 종류**뿐이고
  (`SALVAGE_MAIN_MIN_YIELD` 1), 그 자리는 언제나 폐금속 · 천조각이 8 이상이라 안전하다.
- **유니크 무기 · 유니크 방탄복은 분해 금지**(제작 레시피가 없으므로 자동으로 빠진다), **수리는 된다** —
  기준을 같은 총기 종류의 **등급 V**(유니크 방탄복은 방탄복 V)에서 빌려 `UNIQUE_REPAIR_MUL`(1.5)을 곱한다.
  옛 공식(빠진 내구도 ÷ `REPAIR_SCRAP_PER`)은 사라졌다 — 유니크 내구도가 320~3000 이라 같은 전설끼리
  수리비가 10배 갈렸고 등급 무기와 다른 축으로 움직여 읽히지 않았다.
- **가방도 이제 내구도가 있다** (2026-09-11, C-36) — 방탄복과 똑같이 구간을 타고 수리비가 든다. 그 전에는 내구도가
  없어 언제나 구간 4(분해 ×0.40 고정, 수리 없음)였다.
- **안전장치 `needsRepairCost(def)`** (2026-09-11): 내구도가 있고 제작 레시피가 있는(회복 스프레이 제외) 아이템은
  닳았을 때 수리비가 **비면 안 된다**. 비면 그것은 무료 수리가 아니라 `REPAIRABLE` 의 구멍이므로
  `inventory/parts/Durability` 의 `repair` · `repairInfo` · 작업대 수리 목록이 거절하고, `checkSalvageEconomy()` 가
  표 전체에 대해 위반으로 잡는다 (방탄복이 2026-09-10 까지, 가방이 C-36 에서 그 구멍으로 새려 했다).
- 예: 돌격소총 IV(제작 폐금속 16 + 합금 판 4 + 기계 부품 3 + 잉곳 2) — 81~100 % 이면 수리 2/1/1/1,
  분해 폐금속 6 + 합금 판 1 + 기계 부품 1; 0~20 % 이면 수리 8/2/2/1, 분해 폐금속 1.

`LootRef` 에 붙은 것(계약 **추가**): `durabilityBucketOf(inst)` · `durabilityBucketInfo(inst)` ·
`getCraftCostOf(defId)` · `getSalvageFor(inst)`. **`getRepairCost(inst)` 는 시그니처가 그대로이고 구현만
바뀌었다** — 이제 방탄복도 값을 돌려준다.

⚠ `getAllRecipes()` 에 실린 생성 분해는 **구간 4 기준**이다. 실제로 소비 · 산출할 때는 반드시
`getSalvageFor(inst)` 가 돌려준 레시피를 써야 한다 (id 는 같고 `outputQty` / `extraOutputs` 만 다르다).

### 분해 표 `data/salvage.csv`

`id,inputDefId,qty,outputs,scaleByDurability,duration,skill,skillRequired,description`.
`outputs` 는 `아이템id:수량` 을 `|` 로 이은 것이고 첫 항목이 대표 산출물, 나머지가 `extraOutputs` 다.
`scaleByDurability` 가 true 면 적힌 값이 100 % 기준이고 구간 배수가 곱해진다 (지금 6줄 모두 false).

| id | 입력 | 산출 |
|---|---|---|
| `break_ammo_light` / `_medium` / `_heavy` / `_shell` | 경량탄 30 / 준중량탄 30 / 중량탄 10 / 산탄 8 | 화약 4 / 6 / 5 / 5 |
| `break_machine_parts` | 기계 부품 1 | 폐금속 3 + 전력 케이블 1 |
| `break_shield_charger_hi` | 고출력 실드 충전기 1 | 구동 코어 1 + 전력 케이블 1 |

생성 분해의 id 는 `break_<아이템id>` — `break_wpn_ar_g3` · `break_armor_2` · `break_bag_epic` …
(`break_wpn_*` · `break_armor_*` 는 예전과 같은 id 라 `inventory` 의 `disassembleRecipeFor` 가 그대로 찾는다).

### 검산 — `checkSalvageEconomy()`

`npm run data:check` 가 돌린다 (`scripts/data-check.mjs`). 모든 생성 분해 × 모든 내구도 구간에서 네 가지를 본다:
① 분해 산출 ≤ 제작 재료 ② 수리 + 분해 ≤ 제작 재료이고 한 종류는 **엄격히 작다** ③ 분해(구간 4) − 수리(구간 b)
≤ 분해(구간 b) — "고쳐서 뜯는" 편이 "지금 뜯는" 것보다 이득이면 안 된다 ④ 제작에 안 쓰는 재료가 분해에서 안 나온다.
손으로 적은 고정 분해도 (제작 레시피가 있으면) 같은 검사를 받는다. 2026-09-11 에 ⑤ **내구도 + 제작 레시피가 있는데
닳은 상태의 수리비가 비었다**(`needsRepairCost`)가 더해졌다 — 가방 8종도 구간 0–4 전부를 본다. 현재 위반 0건, 최악의 `(수리+분해)/제작`
비율은 **0.667** (`wpn_ar_g3` 구간 0 의 합금 판 2/3).

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1, stack 10): `mat_scrap` · `mat_bio_sample` · `mat_alloy` · `mat_power_cell` · `mat_cable` ·
`mat_circuit` · `mat_machine_parts` · `mat_core`, `mat_gunpowder` (stack 20), 2026-09-07 회복 재료
`mat_cloth` (stack 20) · `mat_can` · `mat_syringe` · `mat_antiseptic`, 그리고 **2026-09-10 상위 재료 5종**:

| id | 이름 | rarity | ₩ | kg | 정제 |
|---|---|---|---|---|---|
| `mat_weave` | 강화 직조포 | uncommon | 55 | 0.35 | Lv.1 — 천조각 6 |
| `mat_ballistic_fiber` | 복합 방탄섬유 | rare | 125 | 0.95 | Lv.2 — 천조각 6 + 생체 조직 3 |
| `mat_capacitor` | 축전 모듈 | rare | 140 | 1.1 | Lv.2 — 구동 코어 4 |
| `mat_ingot` | 강화합금 잉곳 | rare | 95 | 1.7 | Lv.3 — 합금 판 2 |
| `mat_control_module` | 제어 모듈 | epic | 380 | 1.5 | Lv.3 — 회로 기판 2 + 파워 셀 1 |

(`mat_alloy` 는 정제 Lv.1 에서 폐금속 3 으로도 나오고, `mat_machine_parts` 는 Lv.1 에서 폐금속 6 + 케이블 2 다 —
분해로 되찾는 폐금속 3 + 케이블 1 이 제작 재료의 딱 절반이라 무한 루프가 없다.)

**상위 재료가 들어오는 길은 셋이다** (2026-09-11, C-35):
1. **정제 작업대** — 본래의 길.
2. **상자** — `data/loot_item_weights.csv` 의 5종 × 티어 25줄이 조인다: 상자 재료 픽 중 상위 재료가 **티어 1–2 0 % ·
   3 ≈5 % · 4 ≈10 % · 5 ≈15 %** (실측 0 · 0 · 4.99 · 10.01 · 14.97 %, 행성 희귀도 배수 전). 줄이 없던 때는 배수 1 이라
   3.3 · 14.3 · 39.1 · 48.5 · **90.9 %** 로 정제 작업대를 우회했다. 역산 절차는 `data/README.md` 의 같은 날 절.
3. **분해 — 의도한 길이다.** 등급 IV–V 장비 · 네임드 확정 드롭(로든 저격소총 III–V · 타길라 방탄복 III–V)을 뜯으면
   그 제작 재료의 상위 재료가 구간 배수만큼 돌아온다 (`SALVAGE_SOURCES` 는 `recipes.csv` 에서 생성). 상자 배수는
   "줍기" 만 조이고 이 길은 막지 않는다 — 고급 장비를 재활용하는 보상이다.


## 임플란트 아이템 (Phase 12, 2026-09-08 — `ImplantDefs.ts`)

Hollow-Knight-charm style equippables of category **`'implant'`** (`ItemDef.implant: ImplantItemDef`), distinct from the
six 전술 임플란트 (Q key). progression/ owns the rules (4 slots + 1 per 5 levels, max 10; equip / unequip on the 캐릭터 tab,
ship only) — items/ only supplies the defs and the loot. 1×1, `stackMax` 1, 0.2 kg, icon `⬡`, colour `CATEGORY_COLOR.implant`
(legendaries use the legendary rarity colour, broken ones a grey-violet `#8c7a99`).

| grade | rarity | slots | bonus | id | name |
|---|---|---|---|---|---|
| I | common | 1 | +1 | `imp_<stat>_1` | `근력 임플란트 I` … |
| II | uncommon | 2 | +2 | `imp_<stat>_2` | `… II` |
| III | rare | 2 | +3 | `imp_<stat>_3` | `… III` |
| IV | epic | 3 | +4 | `imp_<stat>_4` | `… IV` |

`<stat>` ∈ `strength` 근력 · `endurance` 지구력 · `perception` 인지력 · `intelligence` 지능 · `dexterity` 재주 (20 defs).
Three **legendary perk implants** (`implant.perk`, effects read from `derived.perks` by player/ and weapons/; names /
descriptions from `PERK_DEFS` in shared): `imp_perk_auto_revive` 재기동 회로 (slots 3, +1 지구력), `imp_perk_quick_heal`
가속 대사 (slots 2, +1 재주), `imp_perk_kill_stamina` 아드레날린 펌프 (slots 3, +1 근력).

Every one of the 23 has a **broken twin** `imp_broken_<same suffix>` — `망가진 <name>`, same rarity and slot cost,
`implant.broken: true`, `stats: {}`, `repairsTo` = the working id, `repairCost` by rarity (`IMPLANT_REPAIR_COST`):
I 회로 기판 1 + 전력 케이블 1 · II + 합금 판 1 · III 회로 기판 2 + 케이블 2 + 합금 판 1 · IV + 소독약 1 · legendary 회로 기판 3 +
케이블 3 + 합금 판 2 + 소독약 1. `value` by rarity 400 / 900 / 1800 / 3600 / 7500 (`IMPLANT_VALUE_BY_RARITY`), a broken one
¼ of that (`BROKEN_IMPLANT_VALUE_DIV`).

**Loot** — only broken implants ever drop; working ones are 세레스 바이오's (shop + repair desk, meta/) and nothing is craftable:
- `LOOT_TABLES`: category `implant` weight 2 / 3 / 4 at tiers 2 / 3 / 4 (none at 1 / 5). `itemWeightMul` zeroes every
  working def (`workingImplants()`) and scales the broken ones per rarity (`brokenImplants({...})`) — tiers 2–3 taper
  higher grades (0.7 / 0.4 / 0.2 and 1 / 0.7 / 0.4) and forbid legendaries; **tier 4 is the only container tier with a
  broken legendary** (×0.5 on the tier's legendary weight 10).
- `CORPSE_TABLES`: new `CorpseTable.implant: CorpseImplant {chance, weights}` — rogue 6 % (common 55 / uncommon 30 /
  rare 12 / epic 3), rogue_boss 45 % (10 / 25 / 30 / 25 / **legendary 10**). `rollCorpse` rolls it **last**, after the
  book, so every earlier draw (ammo, weapon, attachment, unique, book) is unchanged for a given rng — the
  `smoke-phase4` / `smoke-library` corpse checks needed no update.
- `heal_spray` confirmed: `durabilityMax: HEAL_SPRAY_GAUGE` (200 since Phase 12) — never hard-coded.

Smoke: `scripts/smoke-progression.mjs` covers the def table (46 / 23 / 23, names, slots, stats, repair costs, value ¼),
the loot rules (corpse / crate counts over 400 / 300 rolls, no working implant, no legendary below tier 4) and the spray gauge.

## 행성별 무기 등급 (2026-09-09 — `data/planet_loot.csv`)

앞쪽 행성에서는 좋은 총이 안 나온다. 수치의 원본은 `data/planet_loot.csv` 이고 `rank` 는
`shared/planetDefs` 의 `planetTier()` 가 주는 **난이도 순번 1..5** (= `data/planets.csv` 의 줄 순서)다.

- `rollCrateOn(tier, rng, planet)` — 상자에 무기가 들어가는 것이 정해진 **뒤에** 그 무기의 **등급만**
  행성 곡선으로 다시 뽑는다 (`LootService.regrade`). 계열 추첨(`돌격소총`이냐 `저격소총`이냐)은 그대로다.
  가중치 0 인 등급은 그 행성에서 아예 안 나온다.
- **유니크(전설) 무기는 등급이 없어 곡선을 못 탄다** — 대신 `uniqueMul` 이 등장 확률에 곱해진다.
  `uniqueMul = 0` 이면 `pickDef` 의 후보에서 아예 빠지고 (가중치만 0 으로 두면 티어 5 처럼 등급 무기가
  전부 0 인 표에서 `relaxRarity` 폴백이 도로 집어 온다), 0 과 1 사이면 `regrade` 의 확률 게이트 한 곳에서
  걸러 **평범한 총 한 자루로 바뀐다**. 한 곳에서만 걸어야 티어 4 상자 · 티어 5 투하 · 보스 시체가 같은
  배수로 움직인다 (가중치로 걸면 후보가 유니크뿐인 티어 5 에서 배수가 상쇄된다).
- **유니크 전용 탄약**(`ammo_fuel` … `ammo_belt`)도 같은 배수로 막힌다 — `data/ammo.csv` 기준 그 여섯 구경은
  유니크 총 전용이라(등급 6계열은 light / medium / heavy / shell 만 쓴다) 쓸 총이 없는 행성에서 나오면
  가방 칸만 먹는 죽은 무게다. 탈락하면 평범한 구경 한 종으로 바뀐다. **유니크 총이 실제로 나와서 딸려 나오는
  한 스택은 예외** — 그 경로(`rollCrateWithCurve` 의 Phase 6 패스)는 `regrade` 뒤라 게이트를 안 탄다.
- `rollCorpseOn(type, rng, rogueWeaponId, planet)` — 시체(로그 · 보스)의 무기는 곡선으로 다시 뽑지 않고
  그 행성의 **최대 등급(`maxGrade`)으로 상한**만 받는다. 보스 표의 III/IV 추첨은 그대로라 rng 소모가 같다.
  보스의 유니크 굴림은 `table.unique.chance × uniqueMul` 이다 — `rng.chance` 는 배수와 무관하게
  draw 를 하나 쓰므로 `planet` 이 null 인 경로의 rng 소비가 그대로다.
- **`rollCrate` / `rollCorpse` 는 그대로 남는다.** 내부적으로 `curve = null` / `maxGrade = null` 로 위임하고
  그 경로에서는 rng 를 한 번도 더 쓰지 않으므로 `src/inventory/__selftest__.ts` 의 고정 벡터가 그대로 맞는다.
  `planet` 이 null (훈련장 · 구형 세이브)이면 예전과 완전히 같다.
- **이 곡선은 다른 아이템의 희귀도를 안 건드린다** — `loot_tiers.csv` 의 `common..legendary` 열이 계속 부착물 ·
  방어구 · 임플란트 · 귀중품의 등급을 정한다. 총만 짜게 하려고 티어 표를 내리면 총이 아닌 물건까지 짜진다.
  (2026-09-10 부터 같은 csv 의 **다른 세 열**이 총기가 아닌 것들의 희귀도를 따로 조절한다 — 아래
  *행성별 희귀도 배수*. 두 축은 서로 안 움직인다.)
- 상자 티어는 **무기가 얼마나 자주 나오나**(`weaponChance` 0 / 0.35 / 0.55 / 1), 행성은 **얼마나 좋은가** 를
  맡는다. 그래서 티어 1 상자에서는 어느 행성에서도 총이 안 나온다.

곡선 (csv 그대로) 과 그 결과 — **상자 1개당** 확률은 실제 맵의 상자 티어 분포(티어 1 46.9 % · 2 35.1 % ·
3 13.7 % · 4 4.3 %, 근거는 `scripts/check-planet-loot.mjs` 상단 주석)로 가중 평균한 값이다.
무기가 하나라도 든 상자는 어느 행성에서나 **24.1 %** 다:

| 순번 · 행성 | 가중치 I·II·III·IV·V | P(I) | P(II) | P(III) | P(IV) | P(V) | uniqueMul |
|---|---|---|---|---|---|---|---|
| 1 아켈론 II | 55 · 30 · 15 · 0 · 0 | 13.2 % | 7.0 % | **3.7 %** | — | — | **0** |
| 2 보레아스 IX | 40 · 29 · 31 · 0 · 0 | 9.7 % | 6.8 % | **7.5 %** | — | — | **0** |
| 3 베르단트 III | 26 · 24 · 30 · 10 · 10 | 6.3 % | 5.7 % | 7.0 % | 2.4 % | **2.5 %** | 0.4 |
| 4 피로스 VII | 15 · 18 · 26 · 18 · 23 | 3.6 % | 4.4 % | 6.2 % | 4.2 % | **5.6 %** | 0.7 |
| 5 카민 I | 14 · 14 · 14 · 13 · 45 | 3.4 % | 3.4 % | 3.4 % | 3.1 % | **10.8 %** | 1 |

유니크(전설) 무기 등장률 — 티어 4 상자 / 티어 5 보급 투하 / 보스 시체 1구당 (`uniqueMul` 배수 그대로):

| 순번 | 티어 4 상자 | 티어 5 투하 | 보스 시체 |
|---|---|---|---|
| 1 · 2 | **0 %** | **0 %** | **0 %** |
| 3 | 0.97 % | 1.21 % | 8.2 % |
| 4 | 1.73 % | 2.01 % | 14.4 % |
| 5 | 2.39 % | 2.94 % | 20.5 % |

`node scripts/check-planet-loot.mjs` 가 이 표를 다시 뽑고 목표(1번 P(III) < 5 % · 2번 < 10 % · 3번
P(V) < 5 % · 4번 5~6 % · 5번 < 20 %)와 대조한다. **수치를 고칠 때는 코드가 아니라 csv 를 고친다.**

호출부 (다른 폴더, 한 줄씩): `src/inventory/Container.ts` `ContainerStore.getOrCreate(…, planet = null)` →
`rollCrateOn`, 그 두 호출부 `src/inventory/InventorySystem.ts` · `src/inventory/parts/ContainerNet.ts` 가
`ctx.missionPlanet` 을 넘긴다. `src/enemies/Corpses.ts` 의 `Corpse.interact()` 가 `rollCorpseOn` 을 쓴다.
함선 보급 투하(스트라타젬)도 `crate:open` → `getOrCreate` 로 같은 길을 지난다.

## 행성별 희귀도 배수 (2026-09-10 — `data/planet_loot.csv` 의 `rareMul` · `epicMul` · `legMul`)

같은 csv 의 **둘째 축**이고 위 등급 곡선과 완전히 별개다. 이쪽이 다루는 것은 **총기가 아닌 전부** —
방탄복 · 가방 · 부착물 · 임플란트 · 소모품 · 재료 · 귀중품. 앞쪽 행성에서 좋은 **장비**도 덜 나오게 하려고
넣었다 (사용자 결정, rank 1 = 0.5 / rank 2~5 = 1).

- **규칙은 `LootTables.planetRarityWeights(base, curve)` 하나다.** ① `rare` · `epic` · `legendary` 가중치에
  각각 배수를 곱하고 ② 깎인 총량을 `common` · `uncommon` 이 **원래 가지고 있던 비율 그대로** 나눠 받는다.
  그래서 **가중치 합이 안 바뀐다** — 희귀 이상이 준 만큼 정확히 일반 · 고급이 는다.
  예: 티어 3 `15/30/40/14/1` → `24.17/48.33/20/7/0.5` (합 100 그대로).
- **배수가 셋 다 1 이면 `base` 를 같은 객체로 그대로 돌려준다** (`rarityMulIdentity`). 부동소수 곱셈조차
  하지 않으므로 **rank 2~5 는 이 기능이 없던 때와 비트 단위로 같다** — 상자 · 시체 각 2만 회 굴림의
  내용물 서명이 도입 전후로 일치하는 것으로 확인했다. `curve` 가 null 인 경로(훈련장 · 구형 세이브)도 같다.
- **어디에 걸리나**
  - **상자 전부** — `LootService.pickDef` 한 곳에서 건다. 확정 픽 · 무기 픽 · 카테고리 픽이 모두 이 함수를
    지나므로 티어 1~4 와 **티어 5 보급 투하**가 자동으로 같은 배수를 받는다.
  - **시체의 망가진 임플란트 굴림** — `loot_corpse_rolls.csv` 의 `implantWeights` 도 common..epic 이 다 있는
    **희귀도 표**라 모양이 같다. 안 걸면 앞쪽 행성에서 보스 시체가 희귀 임플란트의 우회로가 된다.
    확률(`chance`) 자체는 그대로다 — 배수는 "무엇이 나오나" 를 정하지 "몇 번 나오나" 를 정하지 않는다.
  - **안 거는 곳**: `loot_corpses.csv` 의 시체 드랍(아이템별 확률이지 희귀도 추첨이 아니다) · 보스 부착물
    (`maxRarity` 로 자른 뒤 **균등** 추첨이라 걸 자리가 없고, 가중 추첨으로 바꾸면 배수 1 인 행성의 결과까지
    바뀐다) · 총기 등급(`regrade` 가 `g1..g5` 로 덮어쓴다).
- **확정 픽(`loot_guaranteed.csv`)의 하한은 못 뚫는다.** "희귀 이상 확정" 줄은 후보가 이미 희귀 이상뿐이라
  셋에 같은 배수가 걸리면 서로 상쇄돼 분포가 그대로다 — 확정은 확정으로 남는다. 반대로 "고급 이상" 줄
  (티어 2 귀중품)은 고급이 되돌려 받는 쪽이라 실제로 고급 쪽으로 기운다.
- `rng` 소비는 어느 쪽이든 그대로다 — `Random.weighted` 는 가중치와 무관하게 `next()` 를 하나만 쓴다.

**실측** (rank 1, 상자 2만 회/칸, 맵 티어 분포 가중 평균, 총기 제외):

| 무엇 | 배수 전 | 배수 0.5 | 배 |
|---|---|---|---|
| 희귀 이상 비율 — 총기 제외 전부 | 18.71 % | **12.19 %** | 0.65 |
| 희귀 이상 비율 — 방탄복 · 가방만 | 22.28 % | **13.37 %** | 0.60 |
| 희귀 이상 비율 — 방탄복 · 가방 · 부착물 | 26.11 % | **15.03 %** | 0.58 |
| 상자 1개당 희귀 이상 아이템 개수 | 0.695개 | **0.463개** | 0.67 |
| 상자 1개당 전체 아이템 개수 | 2.43 / 3.49 / 4.49 / 5.50 (티어 1~4) | 같음 | 1.00 |

⚠ **배수는 "가중치" 배수이지 "확률" 배수가 아니다.** 추첨은 아이템 정의 하나하나를 놓고 하므로 실제 비율은
그 등급에 아이템이 **몇 종** 있느냐에도 달린다 — 희귀 이상 쪽에 정의가 훨씬 많아서 가중치를 정확히 절반으로
깎아도 등장 비율은 0.6배 언저리에서 멈춘다. 정확히 0.5배까지 내리려면 배수를 **0.37**(방탄복·가방 기준) ~
**0.25**(상자당 개수 기준) 로 더 낮춰야 한다 (실측 스윕 결과).

`node scripts/check-planet-loot.mjs` 가 이 표도 같이 뽑고, rank 1 이 rank 2 의 0.45~0.8 배인지와
rank 2~5 의 배수가 전부 1 인지를 대조한다.

## 네임드 로그 확정 드롭 (2026-09-11 — `data/loot_named.csv`)

네임드 로그 셋(`shared/named.ts`)은 일반 전리품 위에 **확정 드롭** 하나를 따로 굴린다. 표는
`LootTables.NAMED_DROPS` / `NAMED_DROP_MAP` 이 읽고 `Loot.rollNamedDrop` 이 `rollCorpse` 의 **맨 마지막**에 굴린다.
**적 종류(`type`)로만 찾고 `rogueWeaponId` 를 보지 않는다** — 네임드 디렉터가 넘기는 값은 로든 `sr` · 타길라 `''`
· 헤비 `u_minigun` 이지만, 네임드 셋의 `loot_corpse_rolls.csv` 줄에는 "들고 있던 총" 굴림이 없으므로 쓰이지 않는다
(굴렸다면 로든이 저격소총을 두 자루 떨구고 타길라가 기본값 돌격소총을 떨군다).

| 적 | 드롭 | 확률 | 등급 분포 | 내구도 | 딸려 오는 것 |
|---|---|---|---|---|---|
| `rogue_sniper` 로든 | 저격소총 (`wpn_sr_g3` / `_g4` / `_g5`) | **85 %** | 희귀 III 60 · 서사 IV 33 · 전설 V **7** | 최대치 × **1–5 %** | 장전 20–100 % · 중량탄 스택 30–60 % |
| `rogue_hammer` 타길라 | 방탄복 (`armor_3` / `_4` / `_5`) | **85 %** | 희귀 III 60 · 서사 IV 33 · 전설 V **7** | 최대치 × **1–5 %** | — |
| `rogue_heavy` 헤비 | 「사이클론」 미니건 **`wpn_u_minigun`** (무기 def `u_minigun`) | **80 %** | 유니크 (등급 없음) | 최대치 × **1–5 %** (3000 → 30–150) | 장전 30–70 % · 탄띠 스택 30–60 % |

- 내구도 범위는 `constants.csv` 의 `NAMED_LOOT_DURABILITY_MIN` · `MAX` (0.01 / 0.05) 하나를 셋이 같이 쓴다. 최소 1.
- 등급은 **III 부터만** 나온다 (`grades` 에 적지 않은 등급은 봉인). 유니크 방탄복(tier 0)은 후보가 아니다.
- ⚠ **행성 곡선을 걸지 않는다.** `planet_loot.csv` 의 등급 상한(`maxGrade`) · `uniqueMul` · 희귀도 배수 전부 —
  "최소 희귀 등급부터" 가 사용자 명세라 난이도 1 행성에서도 III 이상 저격소총 · 방탄복이, 헤비는 유니크가 봉인된
  행성(순번 1 · 2)에서도 미니건이 그대로 나온다. 일반 전리품(서적 · 임플란트)은 기존대로 곡선을 탄다.
- 네임드가 아닌 적은 이 분기에 들어오지도 않으므로 `warrior` / `rogue` / `rogue_boss` 의 rng 벡터는 그대로다.
- 헤비의 호위는 평범한 `rogue` (SMG) 라 기존 `rogue` 표를 그대로 굴린다.

## 소모형 만능 열쇠 (2026-09-12 — 에이전트 C)

사용자 결정(설계안 `docs/plans/consumables-keys-favorites.md` §3). 둘 다 카테고리 `key` · **서사(epic)** · 1×1 · **스택 1** ·
₩1200. 정의는 `data/items.csv` 두 줄뿐이고 items/ 코드는 한 줄도 안 바뀌었다 — 어느 문을 여는지는 `data/structures.csv` 의
`key` 열이, 소모는 `src/world/Structures` 가 한다.

| id | 이름 | 여는 문 |
|---|---|---|
| `key_basement` | 지하실 열쇠 (옛 id 그대로 — 세이브 호환) | 버려진 전진기지 지하실 |
| `keycard_lab` | 연구소 보안 키카드 (신규) | 버려진 연구소 2층 잠긴 방 |

같은 종류면 어느 건물이든 열리고, 열면 연 사람의 것이 1 개 사라진다. 등장처 — 전부 드물게 (실측은 `node scripts/check-planet-loot.mjs`):

| 경로 | 표 | 값 | 실측 (2만 회) |
|---|---|---|---|
| 상자 티어 3 · 4 | `loot_category_weights.csv` 의 `key` 줄 (티어 3 **0.3** · 티어 4 **0.6**, 다른 티어는 줄이 없다) + `loot_item_weights.csv` 두 열쇠 티어 3 · 4 `mul 1` · 티어 1 · 2 · 5 `mul 0` (안전핀) | — | 상자 한 개당 T3 0.50 % · T4 0.90 % |
| 로그 · 네임드 시체 | `loot_corpses.csv` — `rogue` 각 0.008 · `rogue_boss` 각 0.03 · `rogue_sniper/hammer/heavy` 각 0.05 | — | 로그 1.46 % · 로그 보스 5.68 % (두 열쇠 합) |
| 구조물 지상 컨테이너 | `structures.csv` 의 `keyChance` 0.05 (컨테이너 하나마다, 전진기지 → 열쇠 · 연구소 → 키카드) | 부가 굴림 — world | 건물 한 채(8칸)에 하나 이상 ≈ 34 % |
| 노마드 장비 상점 | `corp_stock.csv` `nomad,key,…,minRepLevel 3` — 상점 등급 상한도 Lv.3 에서 서사를 연다 | 가격은 `value` 기준 | — |

`key` 카테고리 안에 서사 두 종뿐이라 행성 희귀도 배수(`epicMul`)는 카테고리 **안** 비율만 바꾸고 빈도는 못 바꾼다 — 빈도는 카테고리 가중치가 정한다.
옛 「무작위 루팅 절대 차단 · 구조물마다 지상 컨테이너 하나에 확정」은 없어졌다. 가치를 바꾸면 `npm run data:check -- --write` (`server/economy.gen.json`).

## 지하실 키카드 (2026-09-09)

> **2026-09-12**: 위 *소모형 만능 열쇠* 로 바뀌었다 (이름 · 등급 · 가치 · 루팅). 이 절은 기록으로 남긴다.

`key_basement` **버려진 구조물의 지하실 키카드** — 카테고리 `valuable`, uncommon, 1×1, 스택 1, ₩0, 0.05 kg,
아이콘 `▨`. 정의는 `data/items.csv` 한 줄뿐이고 **무작위 루팅에는 절대 안 나온다**:
`data/loot_item_weights.csv` 의 티어 1~5 전부에 `key_basement,0` 이 걸려 있어 `pickDef` 의 가중치가 0 이 된다
(확정 픽의 `relaxRarity` 폴백은 양수 후보가 하나도 없을 때만 도는데 `valuable` 은 늘 여럿이라 걸리지 않는다).
시체 표는 아이템 id 를 직접 적으므로 애초에 후보가 아니고, 기업 상점에는 `valuable` 을 파는 줄이 없다.
**구조물이 자기 컨테이너에 직접 넣는다** — 그 배치는 `src/world` 담당이고 items/ 는 정의만 갖는다.

---

## 변경 이력

- **2026-09-12 (소모형 만능 열쇠 — 에이전트 C, items/ 몫은 데이터뿐)** — 위 *소모형 만능 열쇠* 절. `items.csv`: `key_basement` 이름 ·
  등급 · 가치 · 무게 · 아이콘 · 설명 변경, `keycard_lab` 추가. `loot_category_weights.csv` 에 `key` 2줄(티어 3 · 4), `loot_item_weights.csv`
  열쇠 줄 10개(티어 3 · 4 = 1, 나머지 0), `loot_corpses.csv` 로그 · 로그 보스 · 네임드 3종에 두 열쇠씩. 코드 변경 없음.
- **2026-09-12 (전투 소모품 3종, 에이전트 A1 — `docs/plans/consumables-keys-favorites.md` §1)** — `data/items.csv` 에
  `boost_adrenaline` 아드레날린 주사(일반, 스택 3) · `boost_stimulant` 각성제(고급, 스택 3) · `boost_stabilizer` 안정제(희귀, 스택 2),
  전부 `category: 'stim'` · 1×1 · 퀵슬롯. 새 열 `boostEffect`(adrenaline | stimulant | implant_refill) · `boostUseTime`(3 초)을
  `mediumSpeed` 뒤에 붙였고, 실드 충전기와 같은 **옆 표** 규약으로 `ItemDefs.ts` 가 `BOOST_ITEM_MAP` · `boostItemOf(defId)` ·
  `BoostEffect` · `BOOST_EFFECTS` · `BoostItemDef` 를 낸다 (`ItemDef` 무변경). 효과 수치는 `data/constants.csv` 의 `BOOST_*`.
  설명 글에는 숫자가 없다 (툴팁이 보여 준다). 루팅: `loot_item_weights.csv` 7줄(티어 1 아드레날린 0.6 · 각성제 0.4 · 안정제 0,
  티어 2 안정제 0.6, 티어 5 셋 다 줄임), `loot_corpses.csv` 로그 · 로그 보스 · 네임드 3종에 줄 추가. 상점은 `ceres,stim` 규칙이
  그대로 판다(등급은 신뢰도 상한). 제작: `recipes.csv` 의학 작업대 `make_boost_adrenaline`(Lv.1) · `_stimulant`(Lv.2) ·
  `_stabilizer`(Lv.3) — 분해 줄은 없다. 검사: `scripts/smoke-consumables.mjs`.

- **2026-09-12 (서재 매체 A-3e — items/ 몫)** — 새 아이템 **28종**, 위 *서재 매체: 디스크 · 레코드* 절이 표다.
  `data/discs.csv` · `data/records.csv`(각 14줄, 등급 = 같은 숙련의 책) + 로더 `shelfMediumDefs` → `DISC_ITEM_DEFS` ·
  `RECORD_ITEM_DEFS`(`ITEM_DEFS` 에서 책 바로 뒤), `discItemIdFor` · `recordItemIdFor` · `DISC_DEF_BY_SKILL` ·
  `RECORD_DEF_BY_SKILL`. 새 수치 `tables.csv` 의 `DISC_VALUE_BY_RARITY` · `RECORD_VALUE_BY_RARITY`, `tuning.csv` 의
  `DISC_WEIGHT` · `RECORD_WEIGHT`. 루팅은 `loot_category_weights.csv` 7줄(디스크 티어 2–4 · 레코드 티어 3–5), 상점은
  `corp_stock.csv` 세레스 2줄(신뢰도 3 · 4) — 둘 다 카테고리 일반 경로라 `Loot.ts` · `meta/` 코드 무변경. 로그 시체
  서적 굴림은 책만. `scripts/data-owners.mjs` 에 두 파일(→ items · housing), `server/economy.gen.json` 재생성.
  inventory 쪽 최소 줄: 정렬 순서 · 무한 상자 `서재` 탭 · 툴팁 「스킬 / 용도」 두 줄 (inventory README).

- **2026-09-12 (방탄복 전부 2×2, 사용자 결정)** — `ArmorDefs.armorItemSize()` 가 등급 · 퍽을 보지 않고 늘
  `{ width: 2, height: 2 }` 를 돌려준다. 예전에는 초경량 · 광학미채 · I–II 만 2×2 이고 III–V 와 재생은 2×3 이라,
  후반 방탄복 한 벌이 가방 한 줄을 통째로 먹었다 — 등급이 올라갈수록 무거워지는 부담은 `weight`(`data/armor.csv`)
  가 이미 지고 있으므로 자리까지 이중으로 물리지 않는다. **함수는 지우지 않았다**: `ItemDefs.armorItem()` 이
  `width`/`height` 를 채우는 유일한 자리이고, 다시 갈라야 할 때 고칠 곳이 여기 하나로 남는다. 세이브는 격자가
  **작아지는 방향**이라 안전하다 — `parts/Lifecycle` · `Stash` 의 로드는 저장된 칸에 새 크기로 `place` 하므로
  2×3 이 서던 자리에 2×2 는 반드시 서고(회전 저장분도 3×2 → 2×2), 겹침이 새로 생길 수 없다.

- **2026-09-11 (주방 · 배양조 · 프린터 A-3c · A-14 · A-15 — items/ 몫)** — 새 아이템 **34종 + 로더 4개**, 위
  *요리 · 주머니 · 배양 재료 · 열쇠* 절이 표다. ① **요리**: `data/meals.csv` **전용 파일** 로더
  `MEAL_ITEM_DEFS`(10종) — `SEED_ITEM_DEFS` · `SAMPLE_ITEM_DEFS` 와 같은 모양이고, 이 로더가
  `npm run data:check` 의 「아무도 읽지 않는 csv: data/meals.csv」를 없앤다. 색만 다르다 — **등급색을 그대로 쓴다**
  (일반 → 서사가 곧 tier 1 → 2 라 격자에서 「특선인가」가 읽혀야 한다). ② **`items.csv` 선택 열 3묶음** →
  `ItemDef.pouch` · `strain` · `medium` (`soil` · `prep` 파싱과 같은 규약). `pouchAccepts` 는 `r.enumList` 라
  모르는 카테고리를 스스로 신고하고, 허용 목록 `ITEM_CATEGORIES` 는 손으로 적지 않고 `CATEGORY_LABEL_KO` 의
  키에서 뽑는다 (`Record<ItemCategory, …>` 라 카테고리가 늘면 컴파일러가 표를 먼저 막는다). 받는 카테고리가
  하나도 없는 주머니는 `r.report` 로 걸린다. ③ **`ITEM_DEFS` 조립 순서** — 작물 · 토양 뒤에 **요리**, 표본 ·
  준비물 뒤에 **배양 · 프린터 재료 → 주머니 → 열쇠**. 새 재료는 `category: 'material'` 이라 예전 재료와 한
  그룹인데 목록에서는 갈라져야 하므로, 재료 그룹을 **`items.csv` 의 `prep` 줄 경계**에서 가른다
  (`itemGroupBeforePrep` / `itemGroupAfterPrep`) — 파일 순서가 곧 표시 순서라는 `items.csv` 머리 주석 그대로이고
  **아이템 id 를 코드에 적지 않으므로** csv 에 줄을 더하면 제자리에 붙는다. ④ **루팅 코드 변경 0** — `meal` ·
  `pouch` · `key` 는 `loot_category_weights.csv` 에 줄이 없는 것이 곧 차단이고(`rollCrate` 의 카테고리 굴림이
  `Object.keys(categoryWeights)` 에서만 고른다), 함선 전용 재료 15종은 `loot_item_weights.csv` 에 티어 1–5 × 15줄
  `mul 0`, 새 표본 5종은 `loot_corpses.csv` 가 이미 처리한다. ⑤ **분해 · 수리 대상 아님** — 요리 · 주머니 ·
  세포주 · 배지 · 배양 산물 · 필라멘트 전부 내구도가 없어 `Salvage.REPAIRABLE` · `SALVAGEABLE` 무변경.
  ⑥ **가방 6종이 `gear` → `print` 로 옮겨 가고 필라멘트가 재료에 들어갔다** (`data/recipes.csv`, 리드가 커밋).
  「한 아이템의 값어치를 정하는 자리는 `recipes.csv` 하나다」 그대로 **수리비 · 분해 산출이 같이 움직였는데**
  `checkSalvageEconomy()` 는 **그대로 통과한다** — 천조각 · 직조포를 남겨 둔 것이 그 이유다.

- **2026-09-11 (연구실 A-12 · A-13 — items/ 몫)** — ① **표본**: `data/samples.csv` 로더 `SAMPLE_ITEM_DEFS`(6종) 가
  생겼다 — `SEED_ITEM_DEFS` 와 같은 모양이고 `category: 'sample'` · 1×1 · `CATEGORY_ICON.sample`(`◍`) ·
  `CATEGORY_COLOR.sample` · `ItemDef.sample = {analyzeHours, rewardDefId, rewardQty, firstDefId?, firstQty?}` 다.
  이 로더가 `npm run data:check` 의 「아무도 읽지 않는 csv: data/samples.csv」를 없앤다. ② **준비물**:
  `data/items.csv` 의 새 선택 열 `prepEnv` · `prepShort` → `ItemDef.prep = {env, short}` (`soil` 파싱과 같은
  `r.optEnum(...)` 규약, `category: 'prep'` 줄에만 붙는다). ③ **수치는 csv 로** — `data/tuning.csv` 에
  `SAMPLE_STACK_MAX`(3) · `SAMPLE_WEIGHT`(0.4) 두 키를 더했다 (`SEED_STACK_MAX` · `SEED_WEIGHT` 옆). 준비물은
  `items.csv` 에 이미 `stackMax` · `weight` 칸이 있어 새 키가 없다. ④ `ITEM_DEFS` 조립 순서 — 작물 · 토양 뒤에
  **표본 → 준비물**. ⑤ **루팅 코드 변경 0**: `sample` 은 `loot_category_weights.csv`(티어 3·4·5 = 5·7·9) ·
  `loot_item_weights.csv`(티어 3 에서 `spec_genome` · `spec_crystal` 0) · `loot_corpses.csv`(벌레 8종) 가
  다 하고, `Loot.pickDef` 가 원래부터 `ITEM_DEFS` 를 카테고리로 거른다. `prep` 은 표에 줄이 없어 상자에 안 나온다.
  ⑥ **분해 · 수리 대상 아님** — `Salvage.REPAIRABLE` 무변경, `checkSalvageEconomy()` 통과. ⚠ 새 아이템 값 때문에
  **`server/economy.gen.json` 을 다시 구웠다** (`npm run data:check -- --write` — 표본 6 · 준비물 2줄 추가).

- **2026-09-11 (온실 개편 — items/ 몫)** — ① `ItemDefs` 가 `data/seeds.csv` 의 새 **`soilTag`** 열을 `SeedDef.soilTag`
  (필수)로 읽고, `data/items.csv` 의 **`soilTag` · `soilUses`** 선택 열로 `category: 'soil'` 줄에만
  `ItemDef.soil = {tag, uses}` 를 붙인다 (`heal*` · `gadgetId` 와 같은 선택 열 규약). `ITEM_DEFS` 조립 순서에
  약초 바로 뒤로 **`crop` → `soil`** 이 들어갔다. ② **루팅**: 작물 · 토양은 `loot_category_weights.csv` 에 줄이
  없어 상자 굴림의 후보가 아니고(토양은 채집 노드 전용), 새 약재 3종은 `loot_item_weights.csv` 에 티어 1–5
  `mul 0` 15줄로 막았다. 씨앗 카테고리 가중치는 티어 1·2 4 → **6**, 3 3 → **5** (씨앗 종류 3 → 10). **씨앗 픽은
  원래부터 seed def 전부에서 고르므로 새 씨앗 7종은 배선 없이 등급 곡선대로 나온다** — 76만 굴림 실측으로 확인했고,
  작물 · 토양 · 새 약재는 0개였다. 벌레 시체 표(`loot_corpses.csv`)는 **일부러 안 건드렸다** (줄이 늘면
  `rollCorpse` 의 rng 소비가 밀린다). ③ **소비처** `recipes.csv` 3줄 — `make_incendiary_ember`(가젯 Lv.1, 불씨꼬투리)
  · `make_antiseptic_frost`(의학 Lv.1, 서리이끼) · `make_heal_spray_iron`(의학 Lv.3, 철엽초). 셋 다 산출이 기존
  아이템이고 `outputQty ≥ 2` 라 `CRAFT_COST_BY_OUTPUT` = 수리 · 분해 기준이 **하나도 안 움직인다**
  (`checkSalvageEconomy()` 통과). ④ `data/quests.csv` 에 세레스 납품 2줄 — `cg1` 작물 3종 · `cg2` 신규 약재 3종
  (코드 변경 0 — `meta/parts/Contracts` 의 `deliver` 그대로). ⚠ `cg1`·`cg2` 의 크레딧 보상 때문에
  **`server/economy.gen.json` 을 다시 구웠다** (`npm run data:check -- --write`).

- **2026-09-11 (C 항목 배치: C-5 · C-35 · C-36)** — ① **가방 내구도** — `data/bags.csv` 에 `durabilityMax` 열(전부 100),
  `ItemDefs` 가 읽는다. `Salvage.REPAIRABLE` 에 `bag`, 새 export `needsRepairCost(def)`, `checkSalvageEconomy()` 에
  "제작 레시피가 있는데 수리비가 비었다" 검사. 한 묶음인 이유: 열만 넣으면 수리비 `[]` = **재료 없는 만피 수리** +
  분해 구간이 0–4 로 갈라져 "고쳐서 뜯기" 가 이득이 되는데 옛 검산은 `repairable=false` 라 구간 4 만 봤다.
  ⚠ `Loot.rollCrate` 가 상자 가방에 내구도 55–100 % 를 `rng.next()` 로 굴리므로 **같은 시드 상자에서 가방 뒤 아이템이
  달라진다** (수용). ② **전설 전술 가방 퀵슬롯 9 → 8** (`bags.csv` · `recipes.csv` 설명), 로더 `max: QUICK_SLOTS`.
  ③ **상위 재료 상자 배수** — `loot_item_weights.csv` 25줄, 재료 픽 중 0 · 0 · ≈5 · ≈10 · ≈15 %. 분해 경로는 의도로 남겼다.

- **2026-09-11 (새 가젯 3종 · 네임드 확정 드롭)** — ① `data/items.csv` 에 **`gad_remote_mine` 원격 지뢰** (rare, 1×1,
  스택 4) · **`gad_drone_ground` 지상 드론** (rare, 2×2, 스택 1) · **`gad_drone_air` 공중 드론** (epic, 2×2, 스택 1).
  ② `data/recipes.csv` 가젯 작업대 3줄 — `make_remote_mine` (Lv.2) · `make_drone_ground` (Lv.2) · `make_drone_air`
  (Lv.3, 제어 모듈 + 축전 모듈 = 정제 작업대 관문). 94 → 97줄. ③ 상자 배수 (`loot_item_weights.csv`, 티어 1 전부 0)
  와 네임드 시체 표. ④ **새 csv `data/loot_named.csv`** + `LootTables.NAMED_DROPS` / `NAMED_DROP_MAP` /
  `numberedArmorIdForTier` + `Loot.rollNamedDrop` — 로든 저격소총 III~V 85 % · 타길라 방탄복 III~V 85 % · 헤비 미니건
  80 %, 셋 다 내구도 1–5 %, 행성 곡선 미적용. `loot_corpses.csv` · `loot_corpse_rolls.csv` 에 네임드 3종(보스 수준
  일반 전리품 · 서적 · 임플란트) + 스캔 드론 빈 표. `rogue` · `rogue_boss` · 벌레 줄은 한 글자도 안 바뀌었다.

- **2026-09-10 (제작 대개편)** — 제작 · 분해 · 수리를 하나의 축에 묶었다. ① **상위 재료 5종**
  (`mat_weave` · `mat_ballistic_fiber` · `mat_capacitor` · `mat_ingot` · `mat_control_module`) 과 **정제 작업대**
  (`bench: 'refine'`, `furn_bench_refine`, 레시피 7종) — 등급 IV~V 장비는 전부 상위 재료를 요구하므로
  정제 작업대가 최고급 장비의 관문이다. ② **`data/recipes.csv` 전면 개편** — 총탄 대량 제작 4줄 삭제,
  무기 25종 · 방탄복 5벌 · 가방 8종 · 부착물 14종 · 가젯 12종 · 실드 충전기 3종을 전부 적어 94줄이 됐다
  (실드 충전기는 현장 제작에서 **의학 작업대 Lv.1/2/3** 으로 옮겼다). ③ **분해가 `data/salvage.csv` 로 나갔다** —
  `recipes.csv` 의 `group` 열이 사라졌고, `Salvage.ts` 가 손 분해 6줄 + **제작 재료에서 생성한** 38줄을 합쳐
  `SALVAGE_RECIPES` 를 만든다. 그래서 총을 뜯으면 폐금속만이 아니라 그 등급이 요구한 합금 판 · 기계 부품 ·
  강화합금 잉곳도 나온다. ④ **수리 · 분해가 내구도를 탄다** — 20 % 단위 5구간
  (`REPAIR_COST_BY_DURABILITY` 0.5~0.1 · `SALVAGE_YIELD_BY_DURABILITY` 0.08~0.40, `data/tables.csv`),
  수리는 올림 · 분해는 내림, 최소 1 은 **주재료 한 종류에만**. 유니크는 분해 금지 그대로이고 수리는 같은
  종류 등급 V 기준 × `UNIQUE_REPAIR_MUL`(1.5). `LootRef` 에 `durabilityBucketOf` · `durabilityBucketInfo` ·
  `getCraftCostOf` · `getSalvageFor` 를 **추가**했고 `getRepairCost` 는 시그니처 그대로 구현만 바뀌었다
  (이제 방탄복도 비용이 있다). `WeaponStats.repairCost` · `tuning.csv` 의 `WEAPON_SALVAGE_BASE` ·
  `WEAPON_SALVAGE_PER_GRADE` · `ARMOR_SALVAGE_BASE` · `ARMOR_SALVAGE_PER_TIER` · `tables.csv` 의
  `SALVAGE_CLASS_MUL` 은 사라졌다. 무한 이득이 없다는 것은 `checkSalvageEconomy()` 가 모든 아이템 ·
  모든 구간의 실제 숫자로 증명하고 `npm run data:check` 가 매번 돌린다 (현재 0건, 최악 비율 0.667).

- **2026-09-10 (행성별 희귀도 배수)** — `data/planet_loot.csv` 에 **`rareMul` · `epicMul` · `legMul`** 세 열을
  더했다 (rank 1 = 0.5, rank 2~5 = 1). 난이도 1 행성에서 **총기가 아닌 것들**(방탄복 · 가방 · 부착물 ·
  임플란트 · 소모품 · 재료 · 귀중품)의 희귀 이상 등장을 절반 수준으로 낮추고, 깎인 가중치를 일반 · 고급이
  원래 비율대로 되받아 **총합을 유지한다**. 새 코드는 `LootTables.planetRarityWeights` 하나와 그것을 부르는
  `Loot.pickDef` · 임플란트 굴림 두 줄뿐이고, **숫자는 csv 에만 있다**. 배수가 전부 1 이면 함수가 인자를
  그대로 돌려주므로 **rank 2~5 의 결과는 도입 전과 비트 단위로 같다**(2만 회 굴림 서명 일치로 확인).
  총기 등급(`g1..g5`) · `uniqueMul` 은 한 톨도 안 건드렸다. 자세한 것은 위 *행성별 희귀도 배수*.
- **2026-09-10 (방탄복 = 실드)** — 방탄복이 피해 감소 대신 **실드(추가 체력)** 를 준다. `ArmorDef.shield` 를
  `data/armor.csv` 의 새 `shield` 칸에서 읽고 (번호 방탄복은 `data/tables.csv` 의 새 표 `ARMOR_SHIELD_BY_TIER`
  = 20/40/60/80/100, 유니크 3벌은 옛 뎀감률을 비례 환산한 90 / 33 / 27), `damageReduction` 은 **아무도 읽지
  않는 근거 열**로만 남았다. `armor.csv` 의 rarity 를 tier 와 1:1 로 다시 맞췄고 (`armor_5` 가 **전설**),
  아이템 가격 식이 `ARMOR_VALUE_DR_MUL` → **`ARMOR_VALUE_SHIELD_MUL`(12.6)** 로 바뀌었지만 값은 그대로다.
  `armorItemSize` · `ARMOR_SALVAGE_*`(`tier > 0` 기준) 는 손대지 않았으므로 `break_armor_5` 도 그대로 있다.
  새로 붙은 것: **실드 충전기 3종**(`shield_charger` / `_hi` / `_full`, category `stim`, `SHIELD_CHARGE_MAP` ·
  `shieldChargeOf`) · 재료 **`mat_core` 구동 코어** · 필드 레시피 3 + 분해 1 · 로그 시체와 상자 루팅.
  ⚠ 로그 · 보스 시체 표에 줄이 늘어 `rollCorpse` 의 rng 소비가 예전과 다르다 (고정 벡터를 세는 스모크 주의).

- **2026-09-10 (권총 제거 · 최소 지급품)** — `data/weapons.csv` 의 `hg`(권총) 줄이 사라져 무기 계열은 5종이다.
  덩달아 `wpn_hg` 아이템 · `break_wpn_hg` 분해 레시피 · 헬릭스 상점의 `secondary,PISTOL` 줄 ·
  `loot_guaranteed` 의 `primary|secondary` 가 함께 없어졌다. `STARTER_LOADOUT` 은 이제 **주무기 I 에 기관단총**을
  준다 (예전에는 보조무기 칸의 권총 I). `isWeaponItemDef` 는 `secondary` 카테고리도 계속 받아 준다 — 옛 세이브에
  남아 있을 수 있는 정의를 막지 않기 위해서다.

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-09 (행성별 무기 등급 · 지하실 키카드)** — 새 csv **`data/planet_loot.csv`** (행성 난이도 순번
  1..5 × 등급 I..V 가중치, 0 = 봉인) 를 `LootTables.PLANET_GRADE_CURVES` / `getPlanetGradeCurve` 가 읽고,
  계약 stub 이던 **`rollCrateOn` / `rollCorpseOn` 을 실제로 구현**했다. 상자는 무기가 들어간 뒤 **등급만**
  다시 뽑고(계열 · 유니크 불변), 시체는 그 행성의 **최대 등급으로 상한**만 받는다. `rollCrate` / `rollCorpse`
  는 `curve = null` 로 위임할 뿐이라 rng 벡터가 그대로다 (`inventory/__selftest__` 의 고정 벡터 유지).
  호출부는 `inventory/Container.getOrCreate` 에 `planet` 인자 하나(+ 두 호출부)와 `enemies/Corpses.interact`
  한 줄. 결과는 위 *행성별 무기 등급* 표이고 `scripts/check-planet-loot.mjs` 가 매번 다시 검증한다.
  **유니크(전설) 무기**는 등급이 없어 곡선을 못 타므로 csv 의 `uniqueMul` 열(1·2번 0 · 3번 0.4 · 4번 0.7 ·
  5번 1)이 등장 확률에 곱해진다 — 0 이면 픽 후보에서 빠지고, 그 사이 값은 `regrade` 의 확률 게이트 한 곳에서
  걸러 평범한 총으로 바뀐다 (티어 4 상자 · 티어 5 투하 · 보스 시체가 같은 배수로 움직인다).
  같이 들어간 아이템: **`key_basement` 지하실 키카드** — `loot_item_weights.csv` 의 티어 1~5 전부 `mul 0`
  이라 무작위 루팅에 절대 안 나온다.

- **2026-09-09 (산탄 이름)** — `data/ammo.csv` 의 `shell` 이름이 `산탄` → **`산탄총 탄약`**, `data/recipes.csv` 의 세 레시피
  이름(`산탄 분해 · 산탄 제작 · 산탄 대량 제작`)도 `산탄총 탄약 …` 으로. id 는 그대로라 코드 무변경.
- **2026-09-09 (수치 csv 이관)** — 아이템 데이터의 원본이 `data/*.csv` 로 나갔다. `ItemDefs.ts` · `WeaponDefs.ts` ·
  `ArmorDefs.ts` · `ImplantDefs.ts` · `LootTables.ts` · `Recipes.ts` · `WeaponStats.ts` 에 **표가 하나도 없다** —
  csv 줄을 `ItemDef` / `WeaponDef` 로 옮기는 코드와 등급 계단 · 분해 산출량 같은 계산식만 남았다.
  담당 파일: `weapons.csv`(계열 6종, 등급 I) · `weapons_unique.csv`(유니크 6종) · `items.csv`(수류탄 · 회복 · 귀중품 ·
  재료 · 약초 · 가젯) · `ammo.csv` · `attachments.csv` · `bags.csv` · `seeds.csv` · `books.csv` · `armor.csv` ·
  `implants_repair.csv` · `implants_perks.csv` · `loot_*.csv` · `recipes.csv`, 그리고 `tuning.csv` 의 items 절.
  무기의 **아이템 표현(칸 크기 · 아이콘 · 가격 · 무게 · 설명)이 무기 수치와 같은 줄**에 들어가, `WeaponDefs` 가
  `WEAPON_FAMILY_ITEM_META` / `UNIQUE_WEAPON_ITEM_META` 로 내주고 `ItemDefs` 가 그것을 읽는다 (예전 `WEAPON_FAMILY_META`
  / `UNIQUE_WEAPON_META` 는 사라졌다). 유니크 무기는 `=FLAME_DPS` 처럼 `constants.csv` 를 가리켜 발사 코드와
  수치가 갈라지지 않는다. `ITEM_DEFS` 조립 순서는 그대로다 — `itemGroup(category)` 가 `items.csv` 에서
  그 카테고리만 파일 순서대로 뽑는다. 루팅의 `@unique_weapons` · `@broken_implants.<등급>` 같은 묶음 토큰이
  예전 `uniqueWeapons(0)` / `brokenImplants({…})` 헬퍼를 대신한다

- **2026-09-08 (폐금속 공급)** — 화약은 남는데 폐금속이 말라 탄약을 못 만들던 병목. 폐금속이 **상자의 `material`
  롤에서만** 나왔고 (레이드당 기대 ≈ 3개) 화약은 그 위에 탄약 분해까지 얹혀 5배 빨리 쌓였다. items/ 쪽 세 가지:
  ① **`mat_machine_parts` 「기계 부품」** (uncommon, 1×1, stack 10, 1.2 kg, ₩90) — 로그 시체 12 % / 보스 60 %(1–2),
  상자는 티어 2 ×0.6 · 티어 3 ×0.8 · 티어 4 그대로, 티어 1 과 보급 투하는 0.
  ② **`break_machine_parts`** — 기계 부품 1 → **폐금속 3 + 전력 케이블 1**. `CraftRecipe.extraOutputs` 를 쓰는
  유일한 레시피다 (계약에 새로 추가된 선택 필드).
  ③ **무기 · 방탄복 분해** (`SALVAGE_RECIPES`) — `WEAPON_DEFS` / `ARMOR_DEFS` 에서 생성한다. 무기는
  `(2 + 등급−1) × 총기 배수`(권총 0.7 · SMG/AR/SG 1 · DMR/SR 1.3) → 권총 I 1 … 저격소총 V 8, 6초;
  방탄복은 `3 + (티어−1)×2` → I 3 … V 11, 5초. 둘 다 `station: 'field'` 라 레이드 현장에서 된다.
  **유니크 무기와 전설 방탄복은 제외** — 되돌릴 수 없는 유일품이라 실수로 갈 수 없다.
  `break_*` 규약을 지키므로 제작 목록에는 안 뜨고 아이템 우클릭 → `분해` 로만 열린다.

- **tactical kit** — `ArmorDefs.ts` (8 plates, `getArmorDef`), `Recipes.ts` (16 recipes, `getAllRecipes`), categories `armor` / `gadget` / `herb`, `weight` on every def, `mat_gunpowder`, starter `armor_2`

- **Phase 6** — six legendary **unique weapons** `u_flame / u_shock / u_shuriken / u_bow / u_bazooka / u_minigun` (`UNIQUE_WEAPON_DEFS`, `WeaponDef.unique / altFire`, no grades / sockets, `isUniqueWeapon`), dedicated ammo `ammo_fuel/cell/shuriken/arrow/rocket/belt`, materials `mat_cable` / `mat_circuit`, uniques in tier 4 / 5 and `rogue_boss` corpse tables, 40 recipes with `CraftRecipe.bench / benchLevel` (gun / gear / gadget / medical)

- **Phase 7** — rarity / category labels, colours, icons and order now live in `src/shared/labels.ts` (re-exported here)

- **Phase 8** — three 씨앗 (`seed_bloodroot / seed_ashleaf / seed_glowcap`, category `seed`, `ItemDef.seed` = 1 / 2.5 / 6 real hours) from tier 1–3 containers and bug corpses — never craftable

- **Phase 9** — 14 **서적** (`book_<skill>`, category `book`, `ItemDef.book.skill`, one per skill, `BOOK_ITEM_DEFS` / `BOOK_DEF_BY_SKILL`) from tier 2–4 containers and rogue corpses (never craftable)

- **Phase 10** — unchanged — whether a corpse can be searched at all is decided by `CORPSE_LOOT_CHANCE` (shared) **before** `rollCorpse` is ever called; `CORPSE_TABLES` / `rollCorpse` keep their exact vectors

- **2026-09-07** — 스팀 / 고급 스팀 삭제 → **회복 소모품 4종**(`heal_bandage` 붕대 · `heal_bandage_herb` 약초 붕대 · `heal_syringe` 회복주사 · `heal_spray` 회복 스프레이 — `ItemDef.heal`, 스프레이는 `durabilityMax` 100 게이지), 재료 `mat_cloth` / `mat_can` / `mat_syringe` / `mat_antiseptic`(소독약은 제작 전용), 수류탄 스택 3 · 재세동기 스택 2, 탄약 스택 = 한 세트, 의약 레시피 6종, `STARTER_LOADOUT` 은 최소 킷(권총 I · 가방 I · 방탄복 I)이고 새 **`STARTER_STASH`** 가 기본 지급품

- **Phase 12 (2026-09-08)** — `ImplantDefs.ts` — 46개 category `implant` 정의(5능력치 × I–IV + 전설 퍽 3종, 각각 `imp_broken_*` 쌍둥이가 `repairsTo` / `repairCost` 를 갖는다), 루팅은 **망가진 것만**(티어 2–4 가중치, 로그 시체 6 % · 보스 45 %, 전설은 티어 4 / 보스, `rollCorpse` 의 마지막 추첨이라 기존 벡터 불변); `STARTER_STASH` 의 폐금속 24 · 케이블 4 · 합금 3 (발전기 Lv.1 → 작업실 → 총기 작업대 전 과정을 덮는다)

- **2026-09-08** — `Recipes.ts` 에 **`make_wpn_ar`(돌격소총 제작)** — 총기 작업대 Lv.1, 폐금속 6 + 합금 판 1 →
  `wpn_ar`(등급 I), 8초. 그 전에는 작업대 Lv.1 이 대량 탄약밖에 못 만들어 "작업대에서 총을 만든다"는 동작이
  아예 없었다 (기본 지급품에 같은 총이 들어 있으므로 성능을 여는 것이 아니라 동작을 여는 레시피다).
  튜토리얼의 `craftGun` 단계가 이것을 쓴다
