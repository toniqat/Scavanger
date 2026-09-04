# src/items — Item & weapon data, loot rolling (`ctx.loot`)

Pure data + the `LootRef` implementation. No DOM, no Three.js scene objects.

| File | Purpose |
|---|---|
| `ItemDefs.ts` | 31 `ItemDef`s (`ITEM_DEFS`, `ITEM_DEF_MAP`, `getItemDef`, `itemDefsByCategory`), rarity palette `RARITY_COLORS`, Korean labels (`RARITY_LABEL_KO`, `CATEGORY_LABEL_KO`, `AMMO_LABEL_KO`), `rarityRank`, `itemIdForWeapon`, and `STARTER_LOADOUT` |
| `WeaponDefs.ts` | 6 `WeaponDef`s (`WEAPON_DEFS`, `WEAPON_DEF_MAP`, `getWeaponDef`) — ballistics consumed by `src/weapons` |
| `LootTables.ts` | Per-tier `TierTable`s (`LOOT_TABLES`, `getTierTable`, `getTierLabel`): item count range, rarity weights, category weights, weapon chance, guaranteed picks |
| `Loot.ts` | `LootService implements LootRef` — `rollCrate(tier, rng?)`, `createItem`, def lookups; `nextUid()` |
| `index.ts` | Barrel — import via `@/items` |

## Ids

**Weapons** (item id → weaponId, grid size): `wpn_ar23`→`ar23` 4×2 · `wpn_sg8`→`sg8` 3×2 · `wpn_r63`→`r63` 4×1 · `wpn_las16`→`las16` 3×2 (primaries); `wpn_p2`→`p2` 2×1 · `wpn_p19`→`p19` 2×1 (secondaries).

**Consumables**: `grenade_frag`, `grenade_incendiary` (1×1, stack 4) · `stim` (+50), `stim_advanced` (+100) (1×1, stack 3) · `ammo_rifle`, `ammo_pistol`, `ammo_shotgun`, `ammo_energy` (2×1, stack 2, `ammoType` set).

**Valuables**: `gem_quartz`, `gem_amber`, `gem_sapphire`, `gem_void`, `cred_chip` (stack 5), `super_earth_medal` (1×1) · `salvage_electronics`, `data_core`, `data_core_encrypted` (2×1) · `sample_canister`, `sample_canister_pure` (3×1) · `terminid_gland` (1×1) · `alien_artifact`, `alien_relic` (2×2).

**Materials** (1×1, stack 10): `mat_scrap`, `mat_bio_sample`, `mat_alloy`, `mat_power_cell`.

`STARTER_LOADOUT = { primary: 'wpn_ar23', secondary: 'wpn_p2', bag: [grenade_frag×4, stim×2, ammo_rifle×1] }`.

## Loot tiers

| Tier | Label | Items | Notes |
|---|---|---|---|
| 1 | 보급 상자 | 2–3 | mostly common consumables/materials |
| 2 | 군수 상자 | 3–4 | guaranteed uncommon+ valuable, 35 % weapon |
| 3 | 귀중품 금고 | 4–5 | guaranteed rare+ valuable, 55 % weapon |
| 4 | 희귀 캐시 | 5–6 | guaranteed epic/legendary valuable **and** a weapon |

`rollCrate` is deterministic for a given `Random`; same-def stackables are merged and the result is sorted largest-first for container placement.
