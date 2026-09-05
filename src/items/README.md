# src/items — Item & weapon data, stats, loot rolling (`ctx.loot`)

Pure data + the `LootRef` implementation. No DOM, no Three.js scene objects. Weapon package (2026-09-05): weapon **grades I–V**, **durability**, **ammo v2** (rounds-as-qty), **attachments** (5 sockets), **bags**, and the `EffectiveWeaponStats` helper every other module fires/repairs/attaches with.

| File | Purpose |
|---|---|
| `WeaponDefs.ts` | 8 weapon **families** × 5 grades = 40 `WeaponDef`s built by `buildGrade` (`WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`, `WEAPON_FAMILIES`, `WEAPON_GRADES`, `weaponGradesOf(family)`, `weaponIdForGrade(family, grade)`); `WEAPON_CLASS_LABEL_KO`, `WEAPON_CLASS_SHORT` (`SMG/AR/SG/SR/DMR/HG`), `WEAPON_BASE_DURABILITY` (per class), `weaponClassOf(def)`, `weaponFamilyOf(def)`, `gradeOf(def)`, `damageFalloff(def, distance)` |
| `ItemDefs.ts` | 88 `ItemDef`s (`ITEM_DEFS`, `ITEM_DEF_MAP`, `getItemDef`, `itemDefsByCategory`, `isWeaponItemDef`) — 40 weapon items generated from `WEAPON_DEFS` (`WEAPON_ITEM_DEFS`), `AMMO_ITEM_DEFS`, `ATTACHMENT_ITEM_DEFS`, `BAG_ITEM_DEFS`, consumables, valuables, materials; rarity palette `RARITY_COLORS`, `RARITY_ORDER`, `rarityRank`, `rarityForGrade` / `gradeForRarity`; Korean labels (`RARITY_LABEL_KO`, `CATEGORY_LABEL_KO`, `AMMO_LABEL_KO`); `AMMO_TYPES_V2`, `ammoItemIdFor(type)`, `itemIdForWeapon(weaponId)`, `WEAPON_GRADE_VALUE_STEP`; `STARTER_LOADOUT` + `StarterLoadout` type |
| `WeaponStats.ts` | `computeWeaponStats(def, inst?)` → `EffectiveWeaponStats` (grade already in the def + slot timings + socketed attachments), `baseWeaponStats`, `applyAttachmentEffects`, `socketedAttachments`, `repairCost(def, inst)`, `canAttach(weaponDef, attachmentDef)`, `gradeRoman`, `clampGrade`, `RECOIL_H_RATIO` (0.7), `SECONDARY_ADS_TIME_MUL` (0.5) |
| `LootTables.ts` | Per-tier `TierTable`s (`LOOT_TABLES`, `getTierTable`, `getTierLabel`): item count, rarity weights (= weapon grade weights), category weights incl. `attachment` / `bag`, weapon chance, `ammoFraction`, guaranteed picks, `itemWeightMul` (family-wide for weapons) |
| `Loot.ts` | `LootService implements LootRef` — `rollCrate(tier, rng?)`, `createItem(defId, qty?, extras?)`, `getEffectiveStats`, `getRepairCost`, `canAttach`, def lookups; `nextUid()` |
| `index.ts` | Barrel — import via `@/items` |

## Weapon families & grades

Ids: grade I keeps the family id (`ar23`); grade g ≥ 2 is `${family}_g${g}` (`ar23_g3`). Item id = `wpn_${weaponId}` (`wpn_ar23`, `wpn_ar23_g3`). Name = family name + roman numeral (`AR-23 리버레이터 III`; grade I is `… I`). Every def carries `grade`, `family`, `maxDurability` and the v2 `ammoType` from `AMMO_FOR_CLASS`.

Per grade above I: damage × (1 + 0.12·(g−1)) rounded, max durability × (1 + 0.25·(g−1)) rounded, item value × (1 + 0.6·(g−1)), rarity = grade (I 일반 · II 고급 · III 희귀 · IV 서사 · V 전설).

| family | class | ammo | grid | dmg I → V | dur I → V | rps | mag | reload | falloff start→end (×min) | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| `ar23` AR-23 리버레이터 | AR | medium | 4×2 | 60 → 89 | 500 → 1000 | 10 | 45 | 2.4 s | 60→220 (×0.6) | auto |
| `smg37` SMG-37 디펜더 | SMG | light | 3×2 | 32 → 47 | 550 → 1100 | 14 | 40 | 1.9 s | 15→45 (×0.4) | auto |
| `sg8` SG-8 퍼니셔 | SG | shell | 3×2 | 22×8 → 33×8 | 200 → 400 | 1.3 | 8 | 3.0 s | 8→30 (×0.25) | pellets |
| `r63` R-63 딜리전스 | DMR | heavy | 4×1 | 120 → 178 | 250 → 500 | 3 | 15 | 2.6 s | 120→400 (×0.75) | semi, adsZoom 1.6 |
| `sr9` SR-9 이래디케이터 | SR | heavy | 5×1 | 330 → 488 | 120 → 240 | 0.9 | 5 | 3.4 s | 300→700 (×0.85) | bolt, adsZoom 4, scope |
| `las16` LAS-16 사이드 | AR | medium | 3×2 | 28 → 41 | 500 → 1000 | 16 | 60 | 3.2 s | 60→160 (×0.6) | energy projectile (180 m/s) |
| `p2` P-2 피스메이커 | PISTOL | light | 2×1 | 45 → 67 | 350 → 700 | 6 | 15 | 1.6 s | 20→70 (×0.5) | semi |
| `p19` P-19 리디머 | PISTOL | light | 2×1 | 30 → 44 | 350 → 700 | 18 | 31 | 1.9 s | 15→45 (×0.4) | machine pistol |

Base item values (grade I): ar23 350 · smg37 480 · sg8 520 · r63 780 · sr9 950 · las16 1250 · p2 140 · p19 260. Hip spreads are deliberately loose (AR 1.4°, SMG 1.9°, SR 4°); `src/weapons` scales them by stance/ADS.

## Ammo v2

Category `ammo`, 1×1, `qty` **is** the round count, `stackMax = AMMO_STACK_ROUNDS[type]`:

| id | name | calibre | stack | classes | value/round |
|---|---|---|---|---|---|
| `ammo_light` | 경량탄 | light | 120 | SMG, PISTOL | 1 |
| `ammo_medium` | 준중량탄 | medium | 90 | AR (incl. las16) | 2 |
| `ammo_heavy` | 중량탄 | heavy | 30 | SR, DMR | 3 |
| `ammo_shell` | 산탄 | shell | 24 | SG | 3 |

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

Category `bag`, 2×2, stack 1, `ItemDef.bag: { cols, rows, quickSlots, tactical? }`.

| id | name | rarity | grid | quick slots |
|---|---|---|---|---|
| `bag_common` | 일반 가방 | common | 5×6 | 2 |
| `bag_uncommon` | 고급 가방 | uncommon | 6×6 | 3 |
| `bag_rare` | 희귀 가방 | rare | 8×6 | 4 |
| `bag_epic` | 서사 가방 | epic | 9×6 | 5 |
| `bag_legendary` | 전설 가방 | legendary | 10×6 | 6 |
| `bag_rare_tac` | 희귀 전술 가방 | rare | 7×6 | 7 (tactical) |
| `bag_epic_tac` | 서사 전술 가방 | epic | 8×6 | 8 (tactical) |
| `bag_legendary_tac` | 전설 전술 가방 | legendary | 9×6 | 9 (tactical) |

## Other items

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack 4) · `stim` (+50), `stim_advanced` (+100) (1×1, stack 3).

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1, stack 10): `mat_scrap` (repair), `mat_bio_sample`, `mat_alloy` (repair, grade ≥ III), `mat_power_cell`.

## Starter loadout

```ts
STARTER_LOADOUT = {
  primary: 'wpn_ar23', primary2: null, secondary: 'wpn_p2', bag: 'bag_common',
  items: [grenade_frag×2, stim×2, ammo_medium×90, ammo_light×60],
}   // as const; `StarterLoadout` is the widened type
```

## Stats & helpers (`WeaponStats.ts`, exposed via `LootRef`)

- `computeWeaponStats(def, inst?)`: starts from the def (damage/magSize/spreads/durability already graded), `recoilV = def.recoil`, `recoilH = recoil × 0.7`, `adsTime = WEAPON_ADS_TIME` (× 0.5 for secondaries), `swapTime = WEAPON_SWAP_TIME_PRIMARY | _SECONDARY`, `adsZoom = def.adsZoom ?? 1`, `scope = !!def.scope`, `laser = false`, `maxDurability = def.maxDurability ?? WEAPON_DEFAULT_DURABILITY`; then folds each attachment in `inst.sockets` in `SOCKET_SLOTS` order — multipliers multiply (`spread` hits hip + ADS, `hipSpread` only hip), `magSize` rounded (min 1), `adsZoom`/`scope`/`laser` override.
- `repairCost(def, inst)`: missing = max − (`inst.durability ?? max`); `ceil(missing / REPAIR_SCRAP_PER)` × `mat_scrap`, plus `ceil(missing / REPAIR_ALLOY_PER)` × `mat_alloy` when grade ≥ III; `[]` when nothing is missing.
- `canAttach(weaponDef, attachmentDef)`: `classes` (via `weaponClassOf`) and `ammoTypes` (def calibre) checks.
- `LootService.createItem(defId, qty?, extras?)`: weapons spawn with `durability = maxDurability` and `ammoInMag = magSize` (extended mag in `extras.sockets` counted) unless `extras` overrides; `sockets` copied from `extras`. `getEffectiveStats` accepts an instance, a weapon def id (`ar23_g3`) or a weapon item id (`wpn_ar23_g3`); returns `null` / `[]` / `false` for non-weapons.

## Loot tiers

| Tier | Label | Items | Weapon | Attachment / bag weight | Ammo roll (× stack) | Notes |
|---|---|---|---|---|---|---|
| 1 | 보급 상자 | 2–3 | — | 6 / — | 25–50 % | mostly common consumables/materials |
| 2 | 군수 상자 | 3–4 | 35 % | 10 / 3 | 35–70 % | guaranteed uncommon+ valuable |
| 3 | 귀중품 금고 | 4–5 | 55 % | 12 / 6 | 50–85 % | guaranteed rare+ valuable |
| 4 | 희귀 캐시 | 5–6 | 100 % | 12 / 8 | 60–100 % | guaranteed epic/legendary valuable **and** a weapon |

Rarity weights double as weapon-grade weights (grade ↔ rarity). `itemWeightMul` keys match an exact item id or, for weapons, the family (`wpn_sr9` or `sr9`) — applied to every grade. At most one bag per crate. `rollCrate` is deterministic for a given `Random`; same-def stackables merge (an ammo overflow becomes a second smaller stack) and the result is sorted largest-first for container placement.
