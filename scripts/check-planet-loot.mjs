#!/usr/bin/env node
/**
 * 행성별 드롭률 표 — `node scripts/check-planet-loot.mjs`.
 *
 * `data/planet_loot.csv` 의 **두 축**을 각각 잰다:
 *   ① g1..g5 · uniqueMul — 총기 등급 곡선
 *   ② rareMul · epicMul · legMul (2026-09-10) — 총기가 아닌 것들의 희귀도
 *
 * Vite 를 헤드리스로 띄워 게임이 실제로 쓰는 `src/items/Loot.ts` 를 그대로 불러 상자를 굴린다
 * (브라우저도 GPU 도 필요 없다). 행성 1..5 × 상자 티어 1..4 로 각 ROLLS 회 굴려
 * **상자 1개당** 등급별 확률을 세고, 실제 맵의 상자 티어 분포로 가중 평균한 표를 찍는다.
 *
 * ── 맵의 상자 티어 분포 (근거: `src/world/Crates.ts` 의 배치 규칙 + `src/world/layout.ts` 의 개수)
 *   · 티어 2 — POI 마다 2개 (`ring(poi, 2.5, 8.5, 2, 2, 40, true)`). POI 는 `layout.ts` 에서 `rng.int(5, 8)`
 *     → 평균 6.5곳. 링 안에서 40번 시도하므로 대개 두 개 다 놓인다 (≈ 1.9) → 약 12.3개
 *   · 티어 3 — 둥지마다 1개 (`ring(nest, 15, 21, 3, 1, 40, true)`). 둥지는 `rng.int(4, 6)` → 평균 5곳 → 약 4.8개
 *   · 티어 4 — `rng.int(1, 2)` → 평균 1.5개
 *   · 티어 1 — 총 개수가 `rng.int(30, 40)`(평균 35)이 될 때까지 채운다 → 35 − 12.3 − 4.8 − 1.5 ≈ 16.4개
 *   (배치 실패율은 지형에 따라 달라지므로 대략치다. 순위와 자릿수를 보는 데는 충분하다.)
 *
 * 목표 (사용자 확정, 상자 1개당 가중 평균):
 *   1번 최대 III · P(III) < 5 % / 2번 최대 III · P(III) < 10 %
 *   3번 P(V) < 5 % / 4번 P(V) 5~6 % / 5번 P(V) < 20 % (10~12 % 목표)
 * 벗어나면 **`data/planet_loot.csv` 의 가중치를 고친다** (코드가 아니라 csv).
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROLLS = Number(process.env.ROLLS ?? 20000);

/** 맵 한 판의 티어별 상자 기대 개수 (위 주석의 근거). */
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

/** 상자 하나가 등급 g 무기를 담고 있으면 true (유니크는 등급 없음 → 별도로 센다). */
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

/** 행성 × 티어: 상자 1개당 등급별 확률 + 무기가 하나라도 든 상자 비율. */
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
// I · II 는 어느 행성에서도 흔한 물건으로 남는다 — 나온 무기의 4분의 1 이상이 I 이나 II 다.
// (마지막 행성은 P(V) 목표가 무기의 45 % 라 "I+II 가 V 보다 흔하다" 는 산술적으로 불가능하다.)
for (const w of weighted) {
  const low = (w.avg[0] + w.avg[1]) / w.avg.reduce((a, b) => a + b, 0);
  check(low >= 0.25, `${w.rank}번 행성: 나온 무기의 25 % 이상이 I · II — ${(low * 100).toFixed(1)} %`);
}

/* ── 총기가 아닌 것들의 희귀도 (rareMul · epicMul · legMul, 2026-09-10) ──────────
 * 이 축은 g1..g5 와 **별개**다 — 방탄복 · 가방 · 부착물 · 임플란트 · 소모품 · 재료 · 귀중품이 대상이고
 * 총기는 등급 곡선이 그 위를 덮어쓰므로 여기 표에서 아예 뺀다.
 * rank 1 과 rank 2 는 티어 표도 uniqueMul(0)도 같고 **오직 이 배수만 다르므로** 둘의 비가 곧 배수의 효과다. */
console.log('');
console.log('총기가 아닌 것들의 희귀도 (data/planet_loot.csv 의 rareMul · epicMul · legMul)');
console.log('  순번 · 행성        |     일반 |     고급 |     희귀 |     서사 |     전설 | 희귀 이상');

const HI_RARITIES = new Set(['rare', 'epic', 'legendary']);
const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** 행성 하나: 맵 티어 분포로 가중 평균한 "총기가 아닌 아이템" 의 희귀도 비율. */
function nonWeaponRarity(planet) {
  const avg = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
  for (const tier of [1, 2, 3, 4]) {
    const n = Object.fromEntries(RARITY_ORDER.map((r) => [r, 0]));
    let total = 0;
    for (let i = 0; i < ROLLS; i++) {
      for (const it of loot.rollCrateOn(tier, new Random((i * 2654435761 + tier * 7919 + 1) >>> 0), planet)) {
        const def = ITEM_DEF_MAP.get(it.defId);
        if (!def || (def.weaponId && WEAPON_DEF_MAP.get(def.weaponId))) continue;   // 총기는 g1..g5 축이다
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
// 1번과 2번은 티어 표 · uniqueMul 이 같고 배수만 다르다 — 그 비가 곧 이 기능이 하는 일이다.
// 가중치를 절반으로 깎아도 등급마다 아이템 **종 수**가 달라 실제 비율은 0.6 배 언저리가 된다 (csv 주석 참고).
{
  const ratio = hiAt(1) / hiAt(2);
  check(ratio > 0.45 && ratio < 0.8,
    `1번 행성의 희귀 이상 비율이 2번의 0.45~0.8 배 — ${pct(hiAt(1)).trim()} / ${pct(hiAt(2)).trim()} = ${ratio.toFixed(3)} 배`);
}
// 2~5번은 배수가 전부 1 이라야 한다 — 1 이면 코드가 조정 자체를 우회하므로 "예전과 한 톨도 안 바뀐다" 가 성립한다.
for (const curve of PLANET_GRADE_CURVES) {
  if (curve.rank === 1) continue;
  check(curve.rarityMulIdentity,
    `${curve.rank}번 행성: 희귀도 배수가 전부 1 (예전 결과 그대로) — rare ${curve.rarityMul.rare} · epic ${curve.rarityMul.epic} · leg ${curve.rarityMul.legendary}`);
}

/* ── 시체(로그 · 보스)의 무기 등급 상한 ─────────────────────────────────────────── */
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
  const cap = rank <= 2 ? 3 : 4;   // 보스 표 자체가 III/IV 까지만 뽑는다
  check(max <= cap, `${rank}번 행성: 보스 시체 무기 최대 등급 ${max} ≤ ${cap}`);
}

/* ── 전설 유니크 무기 등장률 (행성별) ──────────────────────────────────────────── */
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
// 유니크 전용 탄약은 총과 같은 배수로 막힌다. 1·2번 행성에서는 총이 0 이므로 그 탄약도 0 이어야 한다
// (유니크가 나왔을 때 딸려 나오는 스택이 유일한 예외인데, 그 총이 0 이라 그 경로 자체가 없다).
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

/* ── 소모형 만능 열쇠 (2026-09-12) — 드물게만 나온다 ─────────────────────────────
 * 기대치 (사용자 결정 「전부 희귀하게」, 수치는 에이전트 C 가 정했다):
 *   · 상자 티어 1 · 2 · 5(보급 투하)는 0 — `loot_category_weights.csv` 에 `key` 줄이 티어 3 · 4 에만 있다
 *   · 티어 3 은 상자 한 개당 0 초과 · 1.5 % 미만 (목표 약 0.7 %), 티어 4 는 0 초과 · 3 % 미만 (목표 약 1.7 %)
 *   · 두 열쇠가 둘 다 나온다 (한쪽만 나오면 배수 줄이 빠진 것이다)
 *   · 시체: 벌레(warrior · behemoth) 0, 로그 0 초과 · 3 % 미만, 로그 보스 0 초과 · 10 % 미만 (두 열쇠 합, `loot_corpses.csv`)
 * 구조물 지상 컨테이너의 부가 굴림(`structures.csv` 의 `keyChance`)은 상자 굴림 밖이라 여기서 재지 않는다. */
console.log('');
console.log('열쇠 (key_basement · keycard_lab) — 희귀 드롭');
{
  const KEYS = ['key_basement', 'keycard_lab'];
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
        if (KEYS.includes(it.defId)) { got = true; seenIds.add(it.defId); }
      }
      if (got) crates++;
    }
    crateRate[tier] = crates / N;
  }
  console.log(`  상자 한 개당 열쇠가 든 비율: ${[1, 2, 3, 4, 5].map((t) => `T${t} ${pct(crateRate[t]).trim()}`).join(' · ')}`);
  check(crateRate[1] === 0 && crateRate[2] === 0 && crateRate[5] === 0, `티어 1 · 2 · 5 상자에는 열쇠가 없다`);
  check(crateRate[3] > 0 && crateRate[3] < 0.015, `티어 3 상자: 0 초과 · 1.5 % 미만 — ${pct(crateRate[3]).trim()}`);
  check(crateRate[4] > 0 && crateRate[4] < 0.03, `티어 4 상자: 0 초과 · 3 % 미만 — ${pct(crateRate[4]).trim()}`);
  check(KEYS.every((k) => seenIds.has(k)), `두 열쇠가 모두 상자에서 나온다 — ${[...seenIds].join(', ') || '(없음)'}`);
  const corpseRate = {};
  for (const type of ['warrior', 'behemoth', 'rogue', 'rogue_boss']) {
    let n = 0;
    for (let i = 0; i < 5000; i++) {
      for (const it of loot.rollCorpse(type, new Random((i * 69069 + 1) >>> 0), 'ar')) if (KEYS.includes(it.defId)) { n++; break; }
    }
    corpseRate[type] = n / 5000;
  }
  console.log(`  시체 한 구당: ${Object.entries(corpseRate).map(([t, r]) => `${t} ${pct(r).trim()}`).join(' · ')}`);
  check(corpseRate.warrior === 0 && corpseRate.behemoth === 0, '벌레 시체에는 열쇠가 없다');
  check(corpseRate.rogue > 0 && corpseRate.rogue < 0.03, `로그 시체: 0 초과 · 3 % 미만 — ${pct(corpseRate.rogue).trim()}`);
  check(corpseRate.rogue_boss > 0 && corpseRate.rogue_boss < 0.1, `로그 보스 시체: 0 초과 · 10 % 미만 — ${pct(corpseRate.rogue_boss).trim()}`);
}

/* ── 인간형 팩션 시체 (2026-09-13) — data/loot_factions.csv · loot_faction_sites.csv ─────────────
 * 명세(docs/DECISIONS.md 「2026-09-13 — 행성별 적 팩션」): 안드로이드 총 95/5 · 방탄복 · 가방 없음 / 로그 85/14/1 · 방탄복 5 % · 가방 3 % 최대 고급 /
 * 레이더 50/45/4.5/0.5 · 방탄복 5 %(90/9.5/0.5) · 가방 3 % 최대 고급 · 회복 1회 굴림. 행성 최대 등급 상한은 그대로.
 * 여기서는 행성별 **실측 표**를 찍고, 상한 · 봉인 · 최대 희귀도처럼 어기면 안 되는 것만 검사한다 (분포 자체는 csv 가 원본이다). */
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

/* ── 서재 매체 · 비디오게임 (2026-09-13) — 행성 고정 드롭 · 권 가중치 · 레코드 / 게임 디스크 / 게임기 확률 ─────────────
 * 사용자 결정 (docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」): 전부 행성 고정. 레코드 · 게임 디스크(· 게임기)는 threat 2 이상 행성에서만,
 * 등장 확률은 **소수점 둘째 자리 %**. 책 권 가중치는 LIBRARY_VOLUME_DROP_WEIGHT (I 흔함 → V 아주 드묾).
 *   · 상자에서 나온 서재 매체 · 게임 아이템은 전부 그 행성의 것이다 (lootPlanetsOf)
 *   · threat 1 행성은 레코드 · 게임 디스크 · 게임기 0
 *   · threat 2 이상은 티어 3 · 4 상자 한 개당 레코드 · 게임 디스크 · 게임기 각각 0 초과 · 1 % 미만
 *   · 책 권별 개수 I > II > III > IV > V
 *   · 로그 시체의 책도 그 행성의 것 */
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

/* ── 서사 이상 드롭률 게이트 (2026-09-16) — data/planet_loot.csv 의 epicPlusMul ─────────────────────────
 * 사용자 결정: 연구실 잠긴 방 컨테이너(`rollCrateOn(…, { lockedRoom: true })`)만 빼고 서사 · 전설이 나오는 비율을 × epicPlusMul.
 * 잠긴 방 규칙은 게이트가 없던 굴림 그대로이므로, 같은 시드 목록으로 굴린 두 결과의 **서사 이상 개수 비**가 곧 게이트의 실측 효과다.
 * (서사 미만 후보가 없는 카테고리 — 열쇠 · 레코드 — 는 픽을 버리고 다시 뽑으므로 비가 epicPlusMul 보다 아주 조금 높다.) */
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
