// 행성별 인간형 팩션 — 거점 점거 (src/enemies/SiteGroups.ts) · 네임드 확률 단독 스모크, 릴레이 없이 싱글 플레이로 돈다 (2026-09-13).
// 검사 (행성 threat 1 / 2 / 3 × 시드 여러 개):
//   threat 1 — 연구소 · 전진기지마다 안드로이드 2–3그룹(실내 ≥ 1, 그룹당 1–2명), 플랫폼 · 폐허 비어 있음, 로그 · 레이더 · 분대장 없음
//   threat 2 — 안드로이드 없음, 연구소 · 전진기지 전부 점거(로그 또는 레이더, 실내 1 + 실외 1, 그룹당 ≥ 3명), 플랫폼 · 폐허는 로그,
//              분대장 ≤ 1 (로그 그룹의 leader, 나머지 escortOf = 분대장)
//   threat 3 — 로그 · 안드로이드 없음, 거점은 전부 레이더
//   공통 — 불시착 함선은 거점이 아니다 · 레이더 그룹은 우회조 정확히 한 명 · 다른 그룹은 0 · 분대 id 유일 · 적의 site / squadId / role 이
//          기록과 같다 · **상자 경비가 없다**(시작 인간형은 전부 거점 그룹 또는 네임드 분대) · 같은 시드 + 행성 = 같은 배치 ·
//          네임드 굴림 확률 = NAMED_ROGUE_CHANCE_BY_THREAT (0 / 0.25 / 0.5) · 나온 네임드는 팩션 레이더
// Usage: node scripts/smoke-faction-sites.mjs [http://localhost:5273/]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/* ── 계약 값 (data/planets.csv 의 threat · data/tables.csv) — 브라우저 안 상수를 import 할 수 없어 옮겨 적는다 ── */
const PLANETS = [
  { id: 'amber', threat: 1 },
  { id: 'tundra', threat: 2 },
  { id: 'mossy', threat: 2 },
  { id: 'ashen', threat: 3 },
  { id: 'crimson', threat: 3 },
];
const SEEDS = [21, 404, 77];
const NAMED_CHANCE = { 1: 0, 2: 0.25, 3: 0.5 };
const NAMED_TYPES = ['rogue_sniper', 'rogue_hammer', 'rogue_heavy', 'rogue_scan_drone'];
const SIZE = { 1: [1, 2], 2: [3, 4], 3: [3, 4] };

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const info = (label) => console.log(`  ..   ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.enemies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__sys = window.__game.getSystem('enemies');
    window.__mission = (seed, planet) => {
      const ctx = window.__game.ctx;
      ctx.missionPlanet = planet ?? null;
      ctx.missionMode = 'raid';
      const ev = { seed };
      if (planet) ev.planet = planet;
      ctx.bus.emit('game:newMission', ev);
    };
    window.__snap = () => {
      const ctx = window.__game.ctx; const w = ctx.world; const sys = window.__sys;
      const sites = sys.debugSites();
      const humanoids = sys.active.filter((e) => e.active && e.isHumanoid).map((e) => ({
        id: e.id, type: e.type, faction: e.faction, site: e.site, squadId: e.squadId, role: e.squadRole,
        escortOf: e.escortOf ? e.escortOf.id : null, escortType: e.escortOf ? e.escortOf.type : null,
        inside: (w.structureAt(e.position.x, e.position.z) || { id: null }).id,
      }));
      return {
        seed: w.seed, planet: w.planet, sites, humanoids,
        structures: w.getStructures().map((s) => ({ id: s.id, kind: s.kind })),
        platforms: w.getRailLines().reduce((n, l) => n + l.platforms.length, 0),
        ruins: typeof w.getRuinSites === 'function' ? w.getRuinSites().length : -1,
        named: sys.debugNamedRoll(),
      };
    };
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const gen = async (seed, planet) => {
    await P((a) => window.__mission(a.seed, a.planet), { seed, planet });
    await waitFor(page, (a) => { const c = window.__game.ctx; return (c.phase === 'playing' || c.phase === 'deploying') && c.world && c.world.ready && c.world.seed === a.seed && window.__sys.debugSites() !== null; }, 'mission ready', 30000, { seed });
    await waitSim(0.2);
    return P(() => window.__snap());
  };

  console.log('boot');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  ok(await P(() => window.__sys.isAuthority), 'single-player: enemies run as the authority');

  const agg = { rogueSites: 0, raiderSites: 0, bosses: 0, t2Samples: 0, platformGroups: 0, ruinGroups: 0, source: new Set(), indoorInside: 0, indoorTotal: 0 };
  const sigOf = (s) => JSON.stringify(s.sites.sites.map((x) => [x.siteId, x.faction, x.groups.map((g) => [g.place, g.leader, g.members.map((m) => `${m.type}:${m.role}:${m.weapon}:${m.x.toFixed(2)},${m.z.toFixed(2)}`)])]));
  const firstSig = {};

  for (const def of PLANETS) {
    for (const seed of SEEDS) {
      const tag = `${def.id}#${seed}`;
      console.log(`planet ${tag} (threat ${def.threat})`);
      const s = await gen(seed, def.id);
      if (seed === SEEDS[1]) firstSig[def.id] = sigOf(s);
      const st = s.sites;
      ok(st && st.threat === def.threat, `${tag}: debugSites threat ${st && st.threat}`);
      if (!st) continue;
      agg.source.add(st.source);
      const kindOf = new Map(s.structures.map((x) => [x.id, x.kind]));
      const recs = st.sites;
      const labOut = recs.filter((r) => r.site === 'lab' || r.site === 'outpost');
      const outlying = recs.filter((r) => r.site === 'platform' || r.site === 'ruin');
      const wantLabOut = s.structures.filter((x) => x.kind !== 'wreck').length;
      ok(labOut.length === wantLabOut, `${tag}: 연구소 · 전진기지 ${wantLabOut}곳이 모두 거점 목록에 있다 (${labOut.length})`);
      ok(!recs.some((r) => r.site === 'wreck' || kindOf.get(r.siteId) === 'wreck'), `${tag}: 불시착 함선은 거점이 아니다`);
      ok(labOut.every((r) => r.occupied), `${tag}: 연구소 · 전진기지는 전부 점거돼 있다`, JSON.stringify(labOut.map((r) => [r.siteId, r.occupied])));
      info(`${tag}: ${labOut.length} structures · ${s.platforms} platforms · ${s.ruins} ruins · ${st.humanoids} humanoids · source ${st.source}`);

      const groups = recs.flatMap((r) => r.groups.map((g) => ({ ...g, siteId: r.siteId, site: r.site })));
      const members = groups.flatMap((g) => g.members.map((m) => ({ ...m, squadId: g.squadId, faction: g.faction, siteId: g.siteId, site: g.site, place: g.place })));
      const byId = new Map(s.humanoids.map((h) => [h.id, h]));

      // 적 자체가 기록과 같다
      const mismatch = members.filter((m) => { const h = byId.get(m.id); return !h || h.site !== m.site || h.squadId !== m.squadId || h.role !== m.role || h.type !== m.type; });
      ok(mismatch.length === 0, `${tag}: 거점 멤버의 site · squadId · role · type 이 기록과 같다 (${members.length})`, JSON.stringify(mismatch.slice(0, 3)));
      const ids = groups.map((g) => g.squadId);
      ok(new Set(ids).size === ids.length && ids.every((x) => x > 0), `${tag}: 분대 id 가 유일하다 (${ids.length})`);
      // 상자 경비가 없다: 시작 인간형은 거점 멤버 · 네임드 · 네임드 분대뿐
      const memberIds = new Set(members.map((m) => m.id));
      const stray = s.humanoids.filter((h) => !memberIds.has(h.id) && !NAMED_TYPES.includes(h.type) && !(h.escortType && NAMED_TYPES.includes(h.escortType)));
      ok(stray.length === 0, `${tag}: 상자 경비 · 거점 밖 인간형이 없다`, JSON.stringify(stray.slice(0, 3)));
      // 우회조
      const badFlank = groups.filter((g) => {
        const n = g.members.filter((m) => m.role === 'flanker').length;
        return g.faction === 'raider' ? n !== 1 : n !== 0;
      });
      ok(badFlank.length === 0, `${tag}: 레이더 그룹은 우회조 정확히 한 명 · 다른 그룹은 0`, JSON.stringify(badFlank.map((g) => [g.squadId, g.faction, g.members.map((m) => m.role)])));

      const types = new Set(s.humanoids.map((h) => h.type));
      const allTypes = [...types].join(',');
      if (def.threat === 1) {
        ok(labOut.every((r) => r.faction === 'android'), `${tag}: 거점 팩션 = 안드로이드`);
        ok(labOut.every((r) => r.groups.length >= 2 && r.groups.length <= 3), `${tag}: 거점마다 2–3그룹`, JSON.stringify(labOut.map((r) => r.groups.length)));
        ok(labOut.every((r) => r.groups.some((g) => g.place === 'indoor')), `${tag}: 거점마다 실내 그룹 ≥ 1`);
        ok(groups.every((g) => g.members.length >= 1 && g.members.length <= 2 && g.members.every((m) => m.type === 'android')), `${tag}: 그룹당 안드로이드 1–2명`, JSON.stringify(groups.map((g) => g.members.map((m) => m.type))));
        ok(outlying.every((r) => !r.occupied), `${tag}: 플랫폼 · 폐허는 비어 있다`);
        ok(!types.has('rogue') && !types.has('rogue_boss') && !types.has('raider'), `${tag}: 로그 · 레이더가 없다 (${allTypes})`);
      } else {
        agg.t2Samples += def.threat === 2 ? 1 : 0;
        ok(!types.has('android'), `${tag}: 안드로이드가 없다 (${allTypes})`);
        ok(labOut.every((r) => r.groups.length === 2 && r.groups.filter((g) => g.place === 'indoor').length === 1), `${tag}: 거점마다 실내 1 + 실외 1`, JSON.stringify(labOut.map((r) => r.groups.map((g) => g.place))));
        // 2026-09-13 후속 결정: 플랫폼 · 폐허 그룹은 2–3명 (SITE_OUTLYING_GROUP_SIZE_*), 연구소 · 전진기지는 3–4명 그대로
        const OUTLYING_SIZE = { 1: [1, 2], 2: [2, 3], 3: [2, 3] };
        const rangeOf = (g) => (g.site === 'platform' || g.site === 'ruin' ? OUTLYING_SIZE : SIZE)[def.threat];
        const small = groups.filter((g) => g.members.length < rangeOf(g)[0] || g.members.length > rangeOf(g)[1]);
        ok(small.length === 0, `${tag}: 그룹당 연구소 · 전진기지 ${SIZE[def.threat][0]}–${SIZE[def.threat][1]}명 · 플랫폼 · 폐허 ${OUTLYING_SIZE[def.threat][0]}–${OUTLYING_SIZE[def.threat][1]}명`, JSON.stringify(small.map((g) => [g.siteId, g.site, g.place, g.planned, g.members.length])));
        const badType = members.filter((m) => (m.faction === 'raider' ? m.type !== 'raider' : !(m.type === 'rogue' || m.type === 'rogue_boss')));
        ok(badType.length === 0, `${tag}: 멤버 종류가 그룹 팩션과 같다`, JSON.stringify(badType.slice(0, 3)));
        for (const r of outlying.filter((x) => x.occupied)) {
          if (r.site === 'platform') agg.platformGroups++; else agg.ruinGroups++;
        }
        if (def.threat === 2) {
          ok(labOut.every((r) => r.faction === 'rogue' || r.faction === 'raider'), `${tag}: 거점 팩션 = 로그 또는 레이더`);
          ok(outlying.every((r) => !r.occupied || (r.faction === 'rogue' && r.groups.length === 1)), `${tag}: 점거된 플랫폼 · 폐허 = 로그 1그룹`);
          agg.rogueSites += labOut.filter((r) => r.faction === 'rogue').length;
          agg.raiderSites += labOut.filter((r) => r.faction === 'raider').length;
          const bosses = s.humanoids.filter((h) => h.type === 'rogue_boss');
          ok(bosses.length <= 1, `${tag}: 로그 분대장 ≤ 1 (${bosses.length})`);
          if (bosses.length === 1) {
            agg.bosses++;
            const b = bosses[0];
            const g = groups.find((x) => x.members.some((m) => m.id === b.id));
            ok(!!g && g.faction === 'rogue' && g.leader && b.role === 'leader' && st.bossId === b.id, `${tag}: 분대장은 로그 그룹의 leader`, JSON.stringify({ b, g: g && [g.faction, g.leader] }));
            const others = g ? g.members.filter((m) => m.id !== b.id).map((m) => byId.get(m.id)) : [];
            ok(others.every((h) => h && h.escortOf === b.id), `${tag}: 분대장 그룹의 나머지는 escortOf = 분대장`, JSON.stringify(others));
          } else ok(st.bossId === null, `${tag}: 분대장이 없으면 bossId null`);
        } else {
          ok(labOut.every((r) => r.faction === 'raider') && outlying.every((r) => !r.occupied || r.faction === 'raider'), `${tag}: 모든 거점 = 레이더`);
          ok(!types.has('rogue') && !types.has('rogue_boss'), `${tag}: 로그 · 로그 분대장이 없다 (${allTypes})`);
        }
      }
      // 실내 그룹이 실제로 건물 안에 섰나 (world 질의가 있을 때만 — 대체 경로는 느슨하다)
      for (const g of groups.filter((x) => x.place === 'indoor' && (x.site === 'lab' || x.site === 'outpost'))) {
        agg.indoorTotal++;
        if (g.members.some((m) => (byId.get(m.id) || {}).inside === g.siteId)) agg.indoorInside++;
      }
      // 네임드 굴림
      const n = s.named;
      ok(n && n.rolled && n.threat === def.threat && Math.abs(n.chance - NAMED_CHANCE[def.threat]) < 1e-9, `${tag}: 네임드 확률 = ${NAMED_CHANCE[def.threat]} (threat ${n && n.threat}, chance ${n && n.chance})`);
      if (n && n.placed) {
        const e = s.humanoids.find((h) => h.id === n.id);
        ok(!!e && e.faction === 'raider', `${tag}: 네임드 ${n.type} 은 팩션 레이더 (${e && e.faction})`);
        info(`${tag}: named ${n.type} (roll ${n.roll.toFixed(3)}, escorts ${n.escorts})`);
      } else if (n) ok(!(n.roll < n.chance) || n.type !== null, `${tag}: 굴림이 확률 밖이면 네임드 없음 (roll ${n.roll.toFixed(3)})`);
    }
  }

  console.log('aggregate');
  info(`threat 2 거점 팩션: 로그 ${agg.rogueSites} · 레이더 ${agg.raiderSites} · 분대장 ${agg.bosses}/${agg.t2Samples} 레이드 · 플랫폼 그룹 ${agg.platformGroups} · 폐허 그룹 ${agg.ruinGroups} · 자리 출처 ${[...agg.source].join('/')}`);
  ok(agg.rogueSites > 0 && agg.raiderSites > 0, `threat 2 에서 로그 거점과 레이더 거점이 둘 다 나온다 (로그 ${agg.rogueSites} · 레이더 ${agg.raiderSites})`);
  if (agg.source.has('world')) ok(agg.indoorTotal === 0 || agg.indoorInside >= Math.ceil(agg.indoorTotal * 0.9), `실내 그룹이 건물 발자국 안에 선다 (${agg.indoorInside}/${agg.indoorTotal})`);
  else info(`world.getSiteSpawnPoints 없음 — 대체 경로로 돌았다 (실내 ${agg.indoorInside}/${agg.indoorTotal} 가 발자국 안)`);

  console.log('determinism');
  for (const id of ['tundra', 'ashen']) {
    const again = await gen(SEEDS[1], id);
    ok(sigOf(again) === firstSig[id], `${id}#${SEEDS[1]}: 같은 시드 + 행성 = 같은 거점 배치 (팩션 · 그룹 · 종류 · 역할 · 무기 · 자리)`);
  }
  const noPlanet = await gen(21, null);
  ok(noPlanet.sites && noPlanet.sites.threat === 1 && !noPlanet.humanoids.some((h) => h.type === 'rogue' || h.type === 'raider' || h.type === 'rogue_boss'),
    `행성 없음 = threat 1 — 안드로이드만 (${[...new Set(noPlanet.humanoids.map((h) => h.type))].join(',')})`);

  await P(() => { window.__game.ctx.missionPlanet = null; window.__game.ctx.bus.emit('game:abort', {}); });
  await waitSim(0.2);
  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
