#!/usr/bin/env node
/**
 * 정보상 기믹 고정의 **결정성 · 효과** 검사 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 정보상」).
 *
 * 브라우저가 필요 없다 — 헤드리스 Vite 로 게임이 실제로 쓰는 모듈(`src/world/preview.ts` · `hazard/parts/Plan.ts`)을
 * 그대로 SSR 로드해 레이아웃을 만든다. 보는 것은 셋이다:
 *
 *  ① **결정성** — 같은 시드 · 같은 행성 · 같은 정보로 두 번 계획하면 결과가 바이트까지 같다 (멀티가 여기 기댄다).
 *  ② **효과** — 산 기믹이 정말 그만큼 붙는가 (탈출 패드 +N · 둥지 +N · 선로 확정 + 플랫폼 +N · 지하 시설 +N ·
 *     탐사 차량 확정 · 재해 지연 +N 초). 네임드는 월드 rng 밖이라 여기서 보지 않는다 (`enemies/named/Director`).
 *  ③ **스트림** — 레이아웃은 **거절 표본 추출**이라 한 자리가 바뀌면 그 뒤에 뽑는 것들도 따라 움직인다.
 *     그래서 「바뀌기 전에 뽑힌 것은 한 글자도 안 바뀐다」를 검사한다 (예: 탈출 패드를 사면 선로 · 강하 지점 ·
 *     흙길이 그대로, 지하 시설을 사면 구조물 말고 전부 그대로). 미리보기가 거짓말을 하지 않는 근거는 이것이
 *     아니라 「미리보기와 진짜 맵이 **같은 함수**를 지난다」는 사실이다 (`preview.planLayoutFor`).
 *
 * 사용: `node scripts/smoke-intel.mjs [--seeds N]`
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

  /** 레이아웃의 한 절을 문자열로 (좌표는 소수 3자리 — 부동소수 잡음이 아니라 진짜 차이만 본다). */
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
  /** 지하 시설을 가질 수 있는 채 (전진기지 · 연구실) — 「+N 개」는 이 수가 느는 것이다. */
  const eligible = (l) => l.structures.filter((s) => s.kind === 'outpost' || s.kind === 'lab').length;

  /* ── ① 결정성 ─────────────────────────────────────────────────────────── */
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

  /* ── ② 효과 + ③ 스트림 ───────────────────────────────────────────────── */
  const BEFORE = {
    // 이 기믹이 건드리는 단계 **앞에서** 뽑히는 절들 — 한 글자도 바뀌면 안 된다
    extraction: ['rail', 'spawn', 'rover'],
    nest: ['rail', 'spawn', 'rover', 'extraction'],
    basement: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins'],
    named: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins', 'structures'],
    hazardDelay: ['rail', 'spawn', 'rover', 'extraction', 'nests', 'pois', 'craters', 'basins', 'structures'],
  };

  for (const [g, tier, check, label] of [
    ['extraction', 2, (base, got) => got.extraction.length === base.extraction.length + 2, '탈출 패드 +2'],
    ['nest', 2, (base, got) => got.nests.length === base.nests.length + 2, '벌레 둥지 +2'],
    /* 「+2 개」 = 반드시 지하 시설을 가진 채가 둘 더 선다 (csv 상한을 넘는 명시적 예외). 자연 굴림이 겹치면 더 많다 —
     * 「base + 2」로는 못 잰다: 구조물 단계는 스트림이 이미 밀려 있어 base 의 자연 굴림 결과가 재현되지 않는다. */
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

  /* 탐사 차량 · 선로가 **평소에 얼마나 나오는가**. 정보상의 「확정」 은 평소 안 나오는 만큼만 값이 있다 —
   * 2026-09-14: 이 실측이 흙길 **100 %** 를 찍어서(= 「탐사 차량 확정」 이 아무것도 못 산다) 사용자 결정으로
   * `ROVER_CHANCE`(0.6)를 넣었다 — 지금은 선로 70 % · 흙길 64 % 쯤이다. 어느 한쪽이 다시 100 % 가 되면
   * 그 줄은 값을 잃는다 (이 note 가 그것을 감시한다). */
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

  /* 재해 지연 — `planHazard` 의 결과 초에 그대로 더해지고, 굴림 수는 그대로다 (종류 · 방향이 안 바뀐다). */
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

  /* 미리보기 평면 데이터가 계획과 같은 것을 말하는가 (화면이 읽는 유일한 형태다). */
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
