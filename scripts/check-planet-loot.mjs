#!/usr/bin/env node
/**
 * 행성별 무기 등급 드롭률 표 — `node scripts/check-planet-loot.mjs`.
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
const { LootService, ITEM_DEF_MAP, WEAPON_DEF_MAP, gradeOf, isUniqueWeapon } = items;
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

/* ── 지하실 키카드는 무작위 루팅에 절대 안 나온다 ─────────────────────────────── */
console.log('');
console.log('키카드 (key_basement) — 무작위 루팅 차단');
{
  const def = ITEM_DEF_MAP.get('key_basement');
  check(!!def, `아이템 정의가 있다 — ${def?.name ?? '(없음)'}`);
  let seen = 0;
  for (let tier = 1; tier <= 5; tier++) {
    for (let i = 0; i < 20000; i++) {
      for (const it of loot.rollCrate(tier, new Random((i * 22695477 + tier) >>> 0))) if (it.defId === 'key_basement') seen++;
    }
  }
  check(seen === 0, `상자 10만 회 (티어 1~5) 에서 0회 — ${seen}회`);
  let corpseSeen = 0;
  for (const type of ['warrior', 'behemoth', 'rogue', 'rogue_boss']) {
    for (let i = 0; i < 5000; i++) {
      for (const it of loot.rollCorpse(type, new Random((i * 69069 + 1) >>> 0), 'ar')) if (it.defId === 'key_basement') corpseSeen++;
    }
  }
  check(corpseSeen === 0, `시체 2만 회에서 0회 — ${corpseSeen}회`);
}

if (failed) {
  console.log(`\ncheck-planet-loot 실패 — ${failed}건. data/planet_loot.csv 의 가중치를 고친다.`);
  process.exit(1);
}
console.log('\ncheck-planet-loot ok');
