#!/usr/bin/env node
/**
 * Per-planet drop-rate tables — `node scripts/check-planet-loot.mjs`.
 *
 * Measures the **two axes** of `data/planet_loot.csv` separately:
 *   ① g1..g5 · uniqueMul — the weapon grade curve
 *   ② rareMul · epicMul · legMul (2026-09-10) — the rarity of everything that is not a gun
 *
 * It starts Vite headless and loads the `src/items/Loot.ts` the game really uses to roll crates (no browser and
 * no GPU needed). Planets 1..5 × crate tiers 1..4 are rolled ROLLS times each; it counts the per-grade
 * probability **per crate** and prints a table weighted by the real map crate tier mix.
 *
 * ── the map crate tier mix (derived from the placement rules in `src/world/Crates.ts` + the counts in
 *    `src/world/layout.ts`)
 *   · tier 2 — 2 per POI (`ring(poi, 2.5, 8.5, 2, 2, 40, true)`). POIs are `rng.int(5, 8)` in `layout.ts`
 *     → 6.5 places on average. 40 attempts inside the ring, so usually both land (≈ 1.9) → about 12.3
 *   · tier 3 — 1 per nest (`ring(nest, 15, 21, 3, 1, 40, true)`). Nests are `rng.int(4, 6)` → 5 on average
 *     → about 4.8
 *   · tier 4 — `rng.int(1, 2)` → 1.5 on average
 *   · tier 1 — filled until the total reaches `rng.int(30, 40)` (35 on average) → 35 − 12.3 − 4.8 − 1.5 ≈ 16.4
 *   (the placement failure rate depends on the terrain, so these are approximations. They are enough to read
 *   the ranking and the order of magnitude.)
 *
 * Targets (settled by the user, weighted average per crate):
 *   planet 1 at most III · P(III) < 5 % / planet 2 at most III · P(III) < 10 %
 *   planet 3 P(V) < 5 % / planet 4 P(V) 5~6 % / planet 5 P(V) < 20 % (10~12 % wanted)
 * Outside that, **fix the weights in `data/planet_loot.csv`** (the csv, not the code).
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLLS = Number(process.env.ROLLS ?? 20000);

/** Expected crate count per tier on one map (the basis is the comment above). */
const TIER_MIX = { 1: 16.4, 2: 12.3, 3: 4.8, 4: 1.5 };
const MIX_TOTAL = Object.values(TIER_MIX).reduce((a, b) => a + b, 0);

const server = await createServer({
  root: ROOT,
  configFile: `${ROOT}/vite.config.ts`,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

const shared = await server.ssrLoadModule('/src/shared/index.ts');
const items = await server.ssrLoadModule('/src/items/index.ts');
const tables = await server.ssrLoadModule('/src/shared/data/tables.ts');

const { Random, PLANET_IDS, planetTier, planetLabel } = shared;
const { LootService, ITEM_DEF_MAP, WEAPON_DEF_MAP, PLANET_GRADE_CURVES, gradeOf, isUniqueWeapon } = items;
const loot = new LootService();

const issues = tables.dataIssues();
await server.close();

if (issues.length) {
  console.error(`data/*.csv 에 문제 ${issues.length}건 — 먼저 \`npm run data:check\` 를 통과시킨다.`);
  process.exit(1);
}

/** True when one crate holds a grade-g weapon (uniques have no grade → they are counted separately). */
function gradesInCrate(crateItems) {
  const out = new Set();
  let unique = false;
  for (const it of crateItems) {
    const def = ITEM_DEF_MAP.get(it.defId);
    const w = def?.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
    if (!w) continue;
    if (isUniqueWeapon(w)) unique = true;
    else out.add(gradeOf(w));
  }
  return { grades: out, unique };
}

/** Planet × tier: the per-grade probability per crate + the share of crates holding any weapon at all. */
function sample(planet, tier) {
  const hits = [0, 0, 0, 0, 0];
  let anyWeapon = 0, uniques = 0;
  for (let i = 0; i < ROLLS; i++) {
    const rolled = loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet);
    const { grades, unique } = gradesInCrate(rolled);
    for (const g of grades) hits[g - 1]++;
    if (grades.size > 0 || unique) anyWeapon++;
    if (unique) uniques++;
  }
  return { p: hits.map((n) => n / ROLLS), anyWeapon: anyWeapon / ROLLS, uniques: uniques / ROLLS };
}

const pct = (v) => `${(v * 100).toFixed(2)} %`.padStart(8);

let failed = 0;
const check = (okv, msg) => { if (!okv) { failed++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

console.log(`행성별 무기 등급 드롭률 (상자 ${ROLLS.toLocaleString()}회/칸, data/planet_loot.csv)\n`);

const weighted = [];
for (const planet of PLANET_IDS) {
  const rank = planetTier(planet);
  console.log(`■ ${rank}번 행성 — ${planetLabel(planet)} (${planet})`);
  console.log(`  티어 |       I |      II |     III |      IV |       V | 무기 든 상자`);
  const avg = [0, 0, 0, 0, 0];
  let avgAny = 0;
  for (const tier of [1, 2, 3, 4]) {
    const s = sample(planet, tier);
    const share = TIER_MIX[tier] / MIX_TOTAL;
    for (let g = 0; g < 5; g++) avg[g] += s.p[g] * share;
    avgAny += s.anyWeapon * share;
    console.log(`   ${tier}   |${s.p.map(pct).join(' |')} | ${pct(s.anyWeapon)}`);
  }
  console.log(`  가중 |${avg.map(pct).join(' |')} | ${pct(avgAny)}   ← 맵 분포 평균 (상자 1개당)\n`);
  weighted.push({ rank, planet, avg });
}

console.log(`맵의 상자 티어 분포: ${Object.entries(TIER_MIX).map(([t, n]) => `티어 ${t} ${(n / MIX_TOTAL * 100).toFixed(1)} %`).join(' · ')}`);
console.log(`(근거는 이 파일 상단 주석 — src/world/Crates.ts 의 배치 규칙과 src/world/layout.ts 의 POI/둥지 개수)\n`);

console.log('목표 대조 (상자 1개당 가중 평균)');
const at = (rank) => weighted.find((w) => w.rank === rank).avg;
check(at(1)[3] === 0 && at(1)[4] === 0, '1번 행성: IV · V 봉인');
check(at(1)[2] > 0 && at(1)[2] < 0.05, `1번 행성: P(III) < 5 % — ${pct(at(1)[2]).trim()}`);
check(at(2)[3] === 0 && at(2)[4] === 0, '2번 행성: IV · V 봉인');
check(at(2)[2] > at(1)[2] && at(2)[2] < 0.10, `2번 행성: P(III) < 10 % 이고 1번보다 높다 — ${pct(at(2)[2]).trim()}`);
check(at(3)[4] > 0 && at(3)[4] < 0.05, `3번 행성: V 해금 · P(V) < 5 % — ${pct(at(3)[4]).trim()}`);
check(at(4)[4] > at(3)[4] && at(4)[4] < 0.08, `4번 행성: P(V) 5~6 % 대 — ${pct(at(4)[4]).trim()}`);
check(at(5)[4] > at(4)[4] && at(5)[4] < 0.20, `5번 행성: P(V) < 20 % — ${pct(at(5)[4]).trim()}`);
// I · II stay common on every planet — at least a quarter of the weapons that come out are I or II.
// (On the last planet the P(V) target is 45 % of the weapons, so "I+II are more common than V" is
// arithmetically impossible.)
for (const w of weighted) {
  const low = (w.avg[0] + w.avg[1]) / w.avg.reduce((a, b) => a + b, 0);
  check(low >= 0.25, `${w.rank}번 행성: 나온 무기의 25 % 이상이 I · II — ${(low * 100).toFixed(1)} %`);
}

/* ── non-gun rarity (rareMul · epicMul · legMul, 2026-09-10) ──────────
 * This axis is **separate** from g1..g5 — it covers 방탄복 · 가방 · attachments · implants · consumables ·
 * materials · 귀중품, and guns are left out of this table entirely because the grade curve overwrites them.
 * rank 1 and rank 2 share the tier table and uniqueMul (0) and differ **in these multipliers only**, so the
 * ratio between the two is exactly what the multipliers do. */
console.log('');
console.log('총기가 아닌 것들의 희귀도 (data/planet_loot.csv 의 rareMul · epicMul · legMul)');
console.log('  순번 · 행성        |     일반 |     고급 |     희귀 |     서사 |     전설 | 희귀 이상');

const HI_RARITIES = new Set(['rare', 'epic', 'legendary']);
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** One planet: the rarity shares of "items that are not guns", weighted by the map tier mix. */
function nonWeaponRarity(planet) {
  const avg = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
  for (const tier of [1, 2, 3, 4]) {
    const n = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
    let total = 0;
    for (let i = 0; i < ROLLS; i++) {
      for (const it of loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet)) {
        const def = ITEM_DEF_MAP.get(it.defId);
        if (!def || (def.weaponId && WEAPON_DEF_MAP.get(def.weaponId))) continue;   // guns belong to the g1..g5 axis
        n[def.rarity]++; total++;
      }
    }
    const share = TIER_MIX[tier] / MIX_TOTAL;
    for (const r of RARITY_ORDER) avg[r] += (n[r] / (total || 1)) * share;
  }
  const sum = RARITY_ORDER.reduce((a, r) => a + avg[r], 0) || 1;
  for (const r of RARITY_ORDER) avg[r] /= sum;
  return avg;
}

const rarityByRank = [];
for (const planet of PLANET_IDS) {
  const rank = planetTier(planet);
  const a = nonWeaponRarity(planet);
  const hi = RARITY_ORDER.filter((r) => HI_RARITIES.has(r)).reduce((s, r) => s + a[r], 0);
  rarityByRank.push({ rank, hi, a });
  console.log(`  ${rank}번 ${planetLabel(planet).padEnd(12)} |${RARITY_ORDER.map((r) => pct(a[r])).join(' |')} |${pct(hi)}`);
}
const hiAt = (rank) => rarityByRank.find((r) => r.rank === rank).hi;
// Planets 1 and 2 share the tier table · uniqueMul and differ only in the multipliers — that ratio is exactly
// what this feature does. Halving the weights still lands the real ratio near 0.6, because the **number of item
// kinds** differs per rarity (see the csv comment).
{
  const ratio = hiAt(1) / hiAt(2);
  check(ratio > 0.45 && ratio < 0.8,
    `1번 행성의 희귀 이상 비율이 2번의 0.45~0.8 배 — ${pct(hiAt(1)).trim()} / ${pct(hiAt(2)).trim()} = ${ratio.toFixed(3)} 배`);
}
// Planets 2~5 must have every multiplier at 1 — at 1 the code skips the adjustment itself, which is what makes
// "nothing changed by a grain from before" hold.
for (const curve of PLANET_GRADE_CURVES) {
  if (curve.rank === 1) continue;
  check(curve.rarityMulIdentity,
    `${curve.rank}번 행성: 희귀도 배수가 전부 1 (예전 결과 그대로) — rare ${curve.rarityMul.rare} · epic ${curve.rarityMul.epic} · leg ${curve.rarityMul.legendary}`);
}

/* ── the weapon grade cap on corpses (rogue · boss) ────────────────── */
console.log('');
console.log('시체 무기 등급 상한 (rollCorpseOn)');
const CORPSE_ROLLS = 3000;
for (const planet of PLANET_IDS) {
  const rank = planetTier(planet);
  let max = 0;
  for (let i = 0; i < CORPSE_ROLLS; i++) {
    for (const it of loot.rollCorpseOn('rogue_boss', new Random((i * 40503 + 7) >>> 0), 'ar', planet)) {
      const def = ITEM_DEF_MAP.get(it.defId);
      const w = def?.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
      if (w && !isUniqueWeapon(w)) max = Math.max(max, gradeOf(w));
    }
  }
  const cap = rank <= 2 ? 3 : 4;   // the boss table itself only draws up to III/IV
  check(max <= cap, `${rank}번 행성: 보스 시체 무기 최대 등급 ${max} ≤ ${cap}`);
}

/* ── legendary unique appearance rates (per planet) ───────────────── */
console.log('');
console.log('전설 유니크 무기 등장률 (data/planet_loot.csv 의 uniqueMul)');
console.log('  순번 · 행성        | 티어4 상자 | 티어5 투하 | 보스 시체 1구당');
const uniqueRates = [];
for (const planet of PLANET_IDS) {
  const rank = planetTier(planet);
  const crateRate = (tier) => {
    let n = 0;
    for (let i = 0; i < ROLLS; i++) {
      if (loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet)
        .some((it) => { const d = ITEM_DEF_MAP.get(it.defId); const w = d?.weaponId ? WEAPON_DEF_MAP.get(d.weaponId) : undefined; return !!w && isUniqueWeapon(w); })) n++;
    }
    return n / ROLLS;
  };
  let boss = 0;
  for (let i = 0; i < 20000; i++) {
    if (loot.rollCorpseOn('rogue_boss', new Random((i * 40503 + 7) >>> 0), 'ar', planet)
      .some((it) => { const d = ITEM_DEF_MAP.get(it.defId); const w = d?.weaponId ? WEAPON_DEF_MAP.get(d.weaponId) : undefined; return !!w && isUniqueWeapon(w); })) boss++;
    }
  const r = { rank, t4: crateRate(4), t5: crateRate(5), boss: boss / 20000 };
  uniqueRates.push(r);
  console.log(`  ${rank}번 ${planetLabel(planet).padEnd(12)} |${pct(r.t4)} |${pct(r.t5)} |${pct(r.boss)}`);
}
const ur = (rank) => uniqueRates.find((r) => r.rank === rank);
check(ur(1).t4 === 0 && ur(1).t5 === 0 && ur(1).boss === 0, '1번 행성: 유니크 봉인 (상자 · 보스 모두 0)');
check(ur(2).t4 === 0 && ur(2).t5 === 0 && ur(2).boss === 0, '2번 행성: 유니크 봉인 (상자 · 보스 모두 0)');
check(ur(3).boss > 0 && ur(3).boss < ur(4).boss && ur(4).boss < ur(5).boss,
  `보스 유니크가 순번에 따라 오른다 — ${[3, 4, 5].map((n) => pct(ur(n).boss).trim()).join(' < ')}`);
const UNIQUE_AMMO_IDS = ['ammo_fuel', 'ammo_cell', 'ammo_shuriken', 'ammo_arrow', 'ammo_rocket', 'ammo_belt'];
// Unique-only ammo is blocked by the same multiplier as its gun. On planets 1 · 2 the guns are 0, so that ammo
// must be 0 too (the one exception is the stack that comes with a unique, and with that gun at 0 the path does
// not exist at all).
for (const rank of [1, 2]) {
  const planet = PLANET_IDS[rank - 1];
  let ammo = 0;
  for (const tier of [4, 5]) {
    for (let i = 0; i < ROLLS; i++) {
      for (const it of loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet)) {
        if (UNIQUE_AMMO_IDS.includes(it.defId)) ammo++;
      }
    }
  }
  check(ammo === 0, `${rank}번 행성: 유니크 전용 탄약도 0회 (티어 4·5 각 ${ROLLS.toLocaleString()}회) — ${ammo}회`);
}
check(ur(3).t4 < ur(5).t4, `티어4 상자 유니크도 순번에 따라 오른다 — 3번 ${pct(ur(3).t4).trim()} < 5번 ${pct(ur(5).t4).trim()}`);

/* ── consumable master keys (2026-09-12) — rare drops ──────────────
 * Expected (user's decision 「전부 희귀하게」, the numbers settled by agent C):
 *   · crate tiers 1 · 2 · 5 (the supply drop) are 0 — `loot_category_weights.csv` has a `key` row on tiers 3 · 4
 *     only
 *   · tier 3 is above 0 · under 1.5 % per crate (about 0.7 % wanted), tier 4 above 0 · under 3 % (about 1.7 %)
 *   · both keys come out (only one of them means a multiplier row is missing)
 *   · corpses: bugs (warrior · behemoth) 0, rogue above 0 · under 3 %, rogue boss above 0 · under 10 % (both
 *     keys together, `loot_corpses.csv`)
 * A structure ground container's extra roll (`keyChance` in `structures.csv`) is outside the crate roll and is
 * not measured here. */
console.log('');
console.log('열쇠 (key_basement · keycard_lab) — 희귀 드롭');
{
  /* 2026-09-21: 열쇠 · 키카드는 **행성 귀속**이라 종류마다 행성 수만큼(현재 5) 아이템이 있다
   * (`key_basement_amber` …). 그래서 id 를 박아 두지 않고 앞자리(종류)로 모은다 — 행성이 늘어도 이 파일은
   * 그대로다. 총 드롭률은 종류 단위로 봐야 의미가 있으므로 「열쇠가 나온 굴림」은 두 종류를 합쳐 센다. */
  const KEY_FAMILIES = ['key_basement', 'keycard_lab'];
  const familyOf = (id) => KEY_FAMILIES.find((f) => id === f || id.startsWith(`${f}_`)) ?? null;
  const KEYS = [...ITEM_DEF_MAP.keys()].filter((id) => familyOf(id));
  check(KEYS.length === KEY_FAMILIES.length * PLANET_IDS.length,
    `열쇠 아이템 수 = 종류 ${KEY_FAMILIES.length} × 행성 ${PLANET_IDS.length} — ${KEYS.length}개 (${KEYS.join(', ') || '없음'})`);
  for (const id of KEYS) {
    const def = ITEM_DEF_MAP.get(id);
    check(!!def && def.category === 'key' && def.rarity === 'epic' && def.stackMax === 1 && def.width === 1 && def.height === 1,
      `${id}: 정의 = key · 서사 · 1×1 · 스택 1 — ${def ? `${def.name} · ${def.category} · ${def.rarity} · ${def.width}×${def.height} · 스택 ${def.stackMax}` : '(없음)'}`);
  }
  const N = 20000;
  const crateRate = {};
  const seenIds = new Set();
  for (let tier = 1; tier <= 5; tier++) {
    let crates = 0;
    for (let i = 0; i < N; i++) {
      let got = false;
      for (const it of loot.rollCrate(tier, new Random((i * 22695477 + tier) >>> 0))) {
        const fam = familyOf(it.defId);
        if (fam) { got = true; seenIds.add(fam); }
      }
      if (got) crates++;
    }
    crateRate[tier] = crates / N;
  }
  console.log(`  상자 한 개당 열쇠가 든 비율: ${[1, 2, 3, 4, 5].map((t) => `T${t} ${pct(crateRate[t]).trim()}`).join(' · ')}`);
  check(crateRate[1] === 0 && crateRate[2] === 0 && crateRate[5] === 0, `티어 1 · 2 · 5 상자에는 열쇠가 없다`);
  check(crateRate[3] > 0 && crateRate[3] < 0.015, `티어 3 상자: 0 초과 · 1.5 % 미만 — ${pct(crateRate[3]).trim()}`);
  check(crateRate[4] > 0 && crateRate[4] < 0.03, `티어 4 상자: 0 초과 · 3 % 미만 — ${pct(crateRate[4]).trim()}`);
  check(KEY_FAMILIES.every((k) => seenIds.has(k)), `두 열쇠가 모두 상자에서 나온다 — ${[...seenIds].join(', ') || '(없음)'}`);
  const corpseRate = {};
  for (const type of ['warrior', 'behemoth', 'rogue', 'rogue_boss']) {
    let n = 0;
    for (let i = 0; i < 5000; i++) {
      for (const it of loot.rollCorpse(type, new Random((i * 69069 + 1) >>> 0), 'ar')) if (familyOf(it.defId)) { n++; break; }
    }
    corpseRate[type] = n / 5000;
  }
  console.log(`  시체 한 구당: ${Object.entries(corpseRate).map(([t, r]) => `${t} ${pct(r).trim()}`).join(' · ')}`);
  check(corpseRate.warrior === 0 && corpseRate.behemoth === 0, '벌레 시체에는 열쇠가 없다');
  check(corpseRate.rogue > 0 && corpseRate.rogue < 0.03, `로그 시체: 0 초과 · 3 % 미만 — ${pct(corpseRate.rogue).trim()}`);
  check(corpseRate.rogue_boss > 0 && corpseRate.rogue_boss < 0.1, `로그 보스 시체: 0 초과 · 10 % 미만 — ${pct(corpseRate.rogue_boss).trim()}`);
}

/* ── humanoid faction corpses (2026-09-13) ────────────────────────────────────────────────
 * data/loot_factions.csv · loot_faction_sites.csv.
 * The spec (docs/DECISIONS.md 「2026-09-13 — 행성별 적 팩션」): android guns 95/5 · no 방탄복 · no 가방 / rogue
 * 85/14/1 · 방탄복 5 % · 가방 3 % at most 고급 / raider 50/45/4.5/0.5 · 방탄복 5 % (90/9.5/0.5) · 가방 3 % at
 * most 고급 · one heal roll. The planet maximum grade cap is unchanged.
 * Here it prints the **measured table** per planet and checks only what must not be broken — the cap, the
 * sealed grades and the maximum rarity (the distribution itself has the csv as its source). */
console.log('');
console.log('인간형 팩션 시체 (rollCorpseOn) — 총 등급 I/II/III/IV/V · 방탄복 · 가방 · 회복 1구당');
{
  const FACTION_ROLLS = Number(process.env.FACTION_ROLLS ?? 5000);
  const FAMILIES = { android: ['ar', 'smg'], rogue: ['ar', 'smg', 'sg', 'dmr'], raider: ['ar', 'dmr', 'smg', 'sg'] };
  const RANK_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  for (const [type, site] of [['android', null], ['rogue', null], ['raider', null], ['raider', 'outpost']]) {
    for (const planet of PLANET_IDS) {
      const rank = planetTier(planet);
      const curve = PLANET_GRADE_CURVES.find((c) => c.rank === rank);
      const grades = [0, 0, 0, 0, 0, 0];
      let armor = 0, bag = 0, heal = 0, maxArmorRank = -1, maxBagRank = -1;
      for (let i = 0; i < FACTION_ROLLS; i++) {
        const out = loot.rollCorpseOn(type, new Random((i * 2246822519 + 13) >>> 0), FAMILIES[type][i % FAMILIES[type].length], planet, site ? { site } : undefined);
        let healed = false;
        for (const it of out) {
          const def = ITEM_DEF_MAP.get(it.defId);
          const w = def?.weaponId ? WEAPON_DEF_MAP.get(def.weaponId) : undefined;
          if (w && !isUniqueWeapon(w)) grades[gradeOf(w)]++;
          else if (def?.category === 'armor') { armor++; maxArmorRank = Math.max(maxArmorRank, RANK_ORDER.indexOf(def.rarity)); }
          else if (def?.category === 'bag') { bag++; maxBagRank = Math.max(maxBagRank, RANK_ORDER.indexOf(def.rarity)); }
          else if (def?.category === 'stim') healed = true;
        }
        if (healed) heal++;
      }
      const g = (n) => pct(grades[n] / FACTION_ROLLS).trim();
      console.log(`  ${`${type}${site ? `@${site}` : ''}`.padEnd(15)} ${rank}번 ${planetLabel(planet).padEnd(10)} | ${[1, 2, 3, 4, 5].map(g).join(' / ')} | 방탄복 ${pct(armor / FACTION_ROLLS).trim()} · 가방 ${pct(bag / FACTION_ROLLS).trim()} · 회복 ${pct(heal / FACTION_ROLLS).trim()}`);
      const overCap = [1, 2, 3, 4, 5].filter((n) => n > (curve?.maxGrade ?? 5)).reduce((s, n) => s + grades[n], 0);
      check(overCap === 0, `${type}${site ? `@${site}` : ''} ${rank}번 행성: 총 등급이 행성 최대 등급 ${curve?.maxGrade} 을 넘지 않는다`);
      if (type === 'android') check(armor === 0 && bag === 0, `android ${rank}번 행성: 방탄복 · 가방 없음`);
      else {
        check(maxBagRank <= 1, `${type} ${rank}번 행성: 가방 최대 고급`);
        check(maxArmorRank <= (type === 'rogue' ? 1 : 2), `${type} ${rank}번 행성: 방탄복 최대 ${type === 'rogue' ? '고급' : '희귀'}`);
      }
    }
  }
}

/* ── library media · video games (2026-09-13) ──────────────────────────────────────────
 * Planet-fixed drops · volume weights · record / game disc / console rates.
 * User's decision (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): all planet-fixed. Records · game
 * discs (· consoles) only on planets of threat 2 and above, and the appearance rates are **percentages to two
 * decimals**. Book volume weights come from LIBRARY_VOLUME_DROP_WEIGHT (I common → V very rare).
 *   · every library media · game item a crate rolled belongs to that planet (lootPlanetsOf)
 *   · threat 1 planets give 0 records · game discs · consoles
 *   · threat 2 and above: per tier 3 · 4 crate, records · game discs · consoles are each above 0 · under 1 %
 *   · book counts per volume I > II > III > IV > V
 *   · the books on a rogue corpse belong to that planet too */
console.log('');
console.log('서재 매체 · 비디오게임 — 행성 고정 드롭 (rollCrateOn, 상자 1개당)');
{
  const MEDIA_ROLLS = Number(process.env.MEDIA_ROLLS ?? 20000);
  const CATS = ['book', 'disc', 'record', 'game_disc', 'console'];
  const { lootPlanetsOf } = items;
  let wrong = 0;
  const wrongSamples = [];
  const bookVolumes = [0, 0, 0, 0, 0, 0];
  const rows = [];
  for (const planet of PLANET_IDS) {
    const threat = shared.planetThreat(planet);
    const perTier = {};
    for (const tier of [1, 2, 3, 4]) {
      const hit = Object.fromEntries(CATS.map((c) => [c, 0]));
      for (let i = 0; i < MEDIA_ROLLS; i++) {
        const seen = new Set();
        for (const it of loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet)) {
          const def = ITEM_DEF_MAP.get(it.defId);
          if (!def || !CATS.includes(def.category)) continue;
          seen.add(def.category);
          if (!(lootPlanetsOf(def) ?? []).includes(planet)) { wrong++; if (wrongSamples.length < 5) wrongSamples.push(`${it.defId}@${planet}`); }
          if (def.category === 'book' && def.book?.volume) bookVolumes[def.book.volume]++;
        }
        for (const c of seen) hit[c]++;
      }
      perTier[tier] = Object.fromEntries(CATS.map((c) => [c, hit[c] / MEDIA_ROLLS]));
    }
    const mix = Object.fromEntries(CATS.map((c) => [c, [1, 2, 3, 4].reduce((s, t) => s + perTier[t][c] * TIER_MIX[t] / MIX_TOTAL, 0)]));
    rows.push({ planet, threat, perTier, mix });
    const line = (t) => `레코드 ${pct(perTier[t].record).trim()} · 게임 디스크 ${pct(perTier[t].game_disc).trim()} · 게임기 ${pct(perTier[t].console).trim()}`;
    console.log(`  ${planetLabel(planet).padEnd(10)} threat ${threat} | T3 ${line(3)} | T4 ${line(4)}`);
    console.log(`  ${''.padEnd(10)}          | 책 T2 ${pct(perTier[2].book).trim()} · T3 ${pct(perTier[3].book).trim()} · T4 ${pct(perTier[4].book).trim()} | 비디오 T2 ${pct(perTier[2].disc).trim()} · T3 ${pct(perTier[3].disc).trim()} · T4 ${pct(perTier[4].disc).trim()} | 맵 평균 레코드 ${pct(mix.record).trim()} · 게임 디스크 ${pct(mix.game_disc).trim()} · 게임기 ${pct(mix.console).trim()}`);
  }
  check(wrong === 0, `상자의 서재 매체 · 게임 아이템이 전부 그 행성의 것 — 어긋남 ${wrong}${wrongSamples.length ? ` (${wrongSamples.join(', ')})` : ''}`);
  for (const r of rows) {
    const rare = ['record', 'game_disc', 'console'];
    if (r.threat < 2) {
      check([1, 2, 3, 4].every((t) => rare.every((c) => r.perTier[t][c] === 0)), `${planetLabel(r.planet)} (threat 1): 레코드 · 게임 디스크 · 게임기 0`);
    } else {
      for (const c of rare) for (const t of [3, 4]) {
        check(r.perTier[t][c] > 0 && r.perTier[t][c] < 0.01, `${planetLabel(r.planet)}: 티어 ${t} 상자 ${c} 0 초과 · 1 % 미만 — ${pct(r.perTier[t][c]).trim()}`);
      }
    }
    check(r.perTier[2].book > 0 && r.perTier[3].book > 0, `${planetLabel(r.planet)}: 책이 나온다 (T2 ${pct(r.perTier[2].book).trim()})`);
  }
  console.log(`  책 권별 개수 (모든 행성 · 티어 합): ${[1, 2, 3, 4, 5].map((v) => `${v}권 ${bookVolumes[v]}`).join(' · ')}`);
  check(bookVolumes[1] > bookVolumes[2] && bookVolumes[2] > bookVolumes[3] && bookVolumes[3] > bookVolumes[4] && bookVolumes[4] > bookVolumes[5],
    '책 권 가중치: I > II > III > IV > V');
  let corpseWrong = 0, corpseBooks = 0;
  for (const planet of PLANET_IDS) {
    for (let i = 0; i < 4000; i++) {
      for (const it of loot.rollCorpseOn('rogue_boss', new Random((i * 40503 + 7) >>> 0), 'ar', planet)) {
        const def = ITEM_DEF_MAP.get(it.defId);
        if (def?.category !== 'book') continue;
        corpseBooks++;
        if (!(lootPlanetsOf(def) ?? []).includes(planet)) corpseWrong++;
      }
    }
  }
  check(corpseBooks > 0 && corpseWrong === 0, `로그 보스 시체의 책이 전부 그 행성의 시리즈 — ${corpseBooks}권 중 어긋남 ${corpseWrong}`);
}

/* ── the epic+ gate (2026-09-16) — epicPlusMul in data/planet_loot.csv ───────────────────────
 * User's decision: the share of epic · legendary outcomes is × epicPlusMul everywhere except the lab locked-room
 * container (`rollCrateOn(…, { lockedRoom: true })`).
 * The locked-room rule is the roll as it was before the gate, so the **ratio of epic+ counts** between two
 * results rolled from the same seed list is the gate measured effect.
 * (A category with no candidate below epic — 열쇠 · 레코드 — drops the pick and draws again, so the ratio comes
 * out a little above epicPlusMul.) */
console.log('');
console.log('서사 이상 게이트 (epicPlusMul) — 상자 1개당 서사 이상 개수: 보통 / 잠긴 방 규칙');
{
  const GATE_ROLLS = Number(process.env.GATE_ROLLS ?? 8000);
  const isEp = (id) => { const d = ITEM_DEF_MAP.get(id); return !!d && (d.rarity === 'epic' || d.rarity === 'legendary'); };
  for (const planet of PLANET_IDS) {
    const rank = planetTier(planet);
    const target = PLANET_GRADE_CURVES.find((c) => c.rank === rank)?.epicPlusMul ?? 1;
    const cells = [];
    let sumGated = 0, sumOpen = 0;
    for (const tier of [1, 2, 3, 4, 5]) {
      let gated = 0, open = 0;
      for (let i = 0; i < GATE_ROLLS; i++) {
        const seed = (i * 2654435761 + tier * 7919 + 1) >>> 0;
        gated += loot.rollCrateOn(tier, new Random(seed), planet).filter((it) => isEp(it.defId)).length;
        open += loot.rollCrateOn(tier, new Random(seed), planet, { lockedRoom: true }).filter((it) => isEp(it.defId)).length;
      }
      sumGated += gated; sumOpen += open;
      cells.push(`T${tier} ${(gated / GATE_ROLLS).toFixed(3)}/${(open / GATE_ROLLS).toFixed(3)}`);
    }
    const ratio = sumOpen > 0 ? sumGated / sumOpen : 1;
    console.log(`  ${rank}번 ${planetLabel(planet).padEnd(12)} | ${cells.join(' · ')} | 비 ${ratio.toFixed(3)}`);
    check(Math.abs(ratio - target) <= 0.06, `${rank}번 행성: 상자의 서사 이상 개수 비 ≈ epicPlusMul ${target} — ${ratio.toFixed(3)}`);
  }
}

if (failed) {
  console.log(`\ncheck-planet-loot 실패 — ${failed}건. data/planet_loot.csv 의 가중치를 고친다.`);
  process.exit(1);
}
console.log('\ncheck-planet-loot ok');
