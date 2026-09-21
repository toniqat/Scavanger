#!/usr/bin/env node
/**
 * **Determinism · effect** checks for the intel broker's fixed gimmicks (2026-09-14, src/meta/README.md Decisions).
 *
 * No browser is needed — a headless Vite SSR-loads the very modules the game uses (`src/world/preview.ts` ·
 * `hazard/parts/Plan.ts`) and builds the layout with them. Three things are checked:
 *
 *  ① **determinism** — planning twice with the same seed · the same planet · the same intel gives a byte-identical
 *     result (multiplayer leans on this).
 *  ② **effect** — does a bought gimmick really add that much (extraction pads +N · nests +N · rails fixed + platforms
 *     +N · basements +N · the rover fixed · hazard delay +N s). A named rogue is outside the world rng, so it is not
 *     judged here (`enemies/named/Director`).
 *  ③ **stream** — the layout is **rejection sampling**, so moving one spot moves everything drawn after it as well.
 *     What is checked is therefore 「whatever was drawn before the change does not move by one character」 (buying an
 *     extraction pad, say, leaves the rails · the drop point · the rover road alone, and buying a basement leaves
 *     everything but the structures alone). What proves the preview does not lie is not this but the fact that
 *     「the preview and the real map go through **the same function**」 (`preview.planLayoutFor`).
 *
 * Usage: `node scripts/smoke-intel.mjs [--seeds N]`
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SEEDS = Math.max(1, Number(argv[argv.indexOf('--seeds') + 1]) || 24);

let pass = 0;
const fails = [];
function assert(ok, what, detail) {
  if (ok) { pass++; console.log(`  ok   ${what}`); return; }
  fails.push(what);
  console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const server = await createServer({
  root: ROOT,
  configFile: `${ROOT}/vite.config.ts`,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const shared = await server.ssrLoadModule('/src/shared/index.ts');
  const preview = await server.ssrLoadModule('/src/world/preview.ts');
  const plan = await server.ssrLoadModule('/src/world/hazard/parts/Plan.ts');
  const { planLayoutFor, previewLayoutFor } = preview;
  const { resolveIntelEffects, Random, PLANET_DEFS } = shared;

  /** One section of the layout as a string (coordinates to 3 decimals — only real differences, not float noise). */
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const padStr = (p) => `${r3(p.x)},${r3(p.z)},${r3(p.radius ?? p.r ?? 0)},${r3(p.yaw ?? 0)}`;
  const sec = (l) => ({
    rail: l.rail ? `${l.rail.kind}:${r3(l.rail.extent)}:${r3(l.rail.angle)}:${l.rail.stops.length}` : '—',
    spawn: padStr(l.spawn),
    rover: l.rover ? l.rover.stations.map((s) => `${r3(s.x)},${r3(s.z)}`).join('|') : '—',
    extraction: l.extraction.map(padStr).join('|'),
    nests: l.nests.map(padStr).join('|'),
    pois: l.pois.map(padStr).join('|'),
    craters: l.craters.map((c) => `${r3(c.x)},${r3(c.z)},${r3(c.radius)}`).join('|'),
    basins: l.basins.map((b) => `${r3(b.x)},${r3(b.z)},${r3(b.radius)}`).join('|'),
    structures: l.structures.map((s) => `${s.kind}:${padStr(s.pad)}:${s.pit ? 1 : 0}:${s.floors}`).join('|'),
  });
  const same = (a, b, keys) => keys.every((k) => a[k] === b[k]);

  const planets = PLANET_DEFS.map((p) => p.id);
  const pick = (g, tier) => resolveIntelEffects([{ g, tier }]);
  const basementCount = (l) => l.structures.filter((s) => (s.kind === 'outpost' && s.pit) || (s.kind === 'lab' && s.floors >= 2)).length;
  /** The structures that can hold a basement (outpost · lab) — 「+N 개」 means this count grows. */
  const eligible = (l) => l.structures.filter((s) => s.kind === 'outpost' || s.kind === 'lab').length;

  /* ── ① determinism ────────────────────────────────────────────────────── */
  {
    let bad = 0;
    for (let i = 0; i < SEEDS; i++) {
      const seed = 1000 + i * 7919;
      const planet = planets[i % planets.length];
      const intel = pick('extraction', 2);
      const a = JSON.stringify(sec(planLayoutFor(seed, planet, intel).layout));
      const b = JSON.stringify(sec(planLayoutFor(seed, planet, intel).layout));
      if (a !== b) bad++;
    }
    assert(bad === 0, `결정성: 같은 시드 · 행성 · 정보로 두 번 계획하면 결과가 같다 (${SEEDS}회)`, { bad });
  }

  /* ── ② effect + ③ stream ─────────────────────────────────────────────── */
  const BEFORE = {
    // The sections drawn **before** the step this gimmick touches — not one character may change
    extraction: ['rail', 'spawn', 'rover'],
    nest: ['rail', 'spawn', 'rover', 'extraction'],
    basement: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins'],
    named: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins', 'structures'],
    hazardDelay: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins', 'structures'],
  };

  for (const [g, tier, check, label] of [
    ['extraction', 2, (base, got) => got.extraction.length === base.extraction.length + 2, '탈출 패드 +2'],
    ['nest', 2, (base, got) => got.nests.length === base.nests.length + 2, '벌레 둥지 +2'],
    /* 「+2 개」 = two more structures with a basement must stand (an explicit exception above the csv cap). A natural
     * roll on top gives more — 「base + 2」 cannot measure it: by the structure step the stream has already shifted, so
     * base's own natural roll is not reproduced. */
    ['basement', 2, (base, got) => basementCount(got) >= 2 && eligible(got) > eligible(base), '지하 시설 +2 (전진기지 지하실 · 연구실 2층 잠긴 방)'],
    ['rail', 1, (base, got) => !!got.rail && got.rail.stops.length === (base.rail ? base.rail.stops.length + 1 : 3), '선로 확정 + 플랫폼 +1'],
    ['rover', 1, (base, got) => !!got.rover, '탐사 차량 확정'],
    ['hazardDelay', 3, () => true, '재해 지연 (아래에서 따로 본다)'],
    ['named', 1, (base, got) => JSON.stringify(sec(got)) === JSON.stringify(sec(base)), '네임드 지정 (레이아웃은 한 글자도 안 바뀐다)'],
  ]) {
    let ok = 0, total = 0, streamBad = 0;
    for (let i = 0; i < SEEDS; i++) {
      const seed = 500_000 + i * 104_729;
      const planet = planets[i % planets.length];
      const base = planLayoutFor(seed, planet, null).layout;
      const got = planLayoutFor(seed, planet, pick(g, tier)).layout;
      total++;
      if (check(base, got)) ok++;
      const keys = BEFORE[g];
      if (keys && !same(sec(base), sec(got), keys)) streamBad++;
    }
    assert(ok === total, `효과: ${label} (${ok}/${total} 시드)`, { g, tier, ok, total });
    if (BEFORE[g]) assert(streamBad === 0, `스트림: ${label} 은 그 앞에서 뽑힌 절(${BEFORE[g].join(' · ')})을 밀지 않는다`, { streamBad });
  }

  /* **How often the rover · the rails turn up on their own**. The intel broker's 「확정」 is worth only as much as they
   * are normally missing — 2026-09-14: this measurement read the rover road at **100 %** (= 「탐사 차량 확정」 buys
   * nothing), so `ROVER_CHANCE` (0.6) went in on the user's decision — it is around 70 % rails · 64 % rover road now.
   * If either one reaches 100 % again that row loses its worth (this note is what watches for it). */
  {
    let rover = 0, rail = 0, fixed = 0, missing = 0;
    const N = SEEDS * 20;
    for (let i = 0; i < N; i++) {
      const seed = (i * 2_654_435_761) >>> 0;
      const planet = planets[i % planets.length];
      const l = planLayoutFor(seed, planet, null).layout;
      if (l.rail) rail++;
      if (l.rover) { rover++; continue; }
      missing++;
      if (planLayoutFor(seed, planet, pick('rover', 1)).layout.rover) fixed++;
    }
    console.log(`  note 평소 배치율 — 흙길 ${rover}/${N} (${(100 * rover / N).toFixed(1)} %) · 선로 ${rail}/${N} (${(100 * rail / N).toFixed(1)} %)`);
    assert(missing === 0 || fixed > 0, `탐사 차량 확정: 평소 실패하는 시드 ${missing}개 중 ${fixed}개를 살렸다 (${N} 시드)`, { missing, fixed });
  }

  /* Hazard delay — it is added straight onto the seconds `planHazard` returns, and the roll count is unchanged
   * (neither the kind nor the direction moves). */
  {
    let bad = 0, delayed = 0;
    for (let i = 0; i < SEEDS; i++) {
      const seed = 31_000 + i * 6_151;
      for (const def of PLANET_DEFS) {
        const cands = def.hazards ?? [];
        if (!cands.length) continue;
        const a = plan.planHazard(new Random(seed).fork('hazard'), cands, [{ x: 40, z: 40 }], def.biome, { x: 200, z: 0 }, 0);
        const b = plan.planHazard(new Random(seed).fork('hazard'), cands, [{ x: 40, z: 40 }], def.biome, { x: 200, z: 0 }, 180);
        if (!a || !b) continue;
        delayed++;
        if (a.kind !== b.kind || r3(a.dirX) !== r3(b.dirX) || r3(a.eyeX) !== r3(b.eyeX) || b.startsAt !== a.startsAt + 180) bad++;
      }
    }
    assert(delayed > 0 && bad === 0, `효과: 재해 지연 +180초는 시작 시각에만 더해진다 (종류 · 전선 · 눈 중심 그대로, ${delayed}건)`, { delayed, bad });
  }

  /* Does the preview's flat data say the same thing as the plan (it is the only shape the screen reads). */
  {
    let bad = 0;
    for (let i = 0; i < SEEDS; i++) {
      const seed = 90_000 + i * 3_571;
      const planet = planets[i % planets.length];
      const intel = pick('extraction', 1);
      const l = planLayoutFor(seed, planet, intel).layout;
      const p = previewLayoutFor(seed, planet, intel);
      if (p.seed !== (seed >>> 0) || p.planet !== planet
        || p.extraction.length !== l.extraction.length || p.nests.length !== l.nests.length
        || p.structures.length !== l.structures.length
        || (!!p.rail) !== (!!l.rail) || (!!p.rover) !== (!!l.rover)
        || JSON.stringify(p) !== JSON.stringify(JSON.parse(JSON.stringify(p)))) bad++;
    }
    assert(bad === 0, `미리보기: previewLayout 이 계획과 같은 것을 말하고 평면 JSON 이다 (${SEEDS} 시드)`, { bad });
  }
} finally {
  await server.close();
}

console.log(`\nsmoke-intel: ${pass}/${pass + fails.length} passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
process.exit(fails.length ? 1 : 0);
