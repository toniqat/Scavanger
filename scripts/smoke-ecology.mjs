// Single-player smoke test for Phase 11 §3-5 (world + enemies): 행성 생태계.
// Per planet: `ctx.world.planet` / `world:ready.planet`, the biome named by `PlanetDef.biome` (no longer the seeded
// draw), 채집 herb weights + `gatherDensity` node count, the ambient / wave compositions drawn from `eco.bugs` with
// every pre-Phase-11 threat gate intact, `pressure` on the population cap, `maxArtillery` / `maxBehemoth`, rogue-guard
// density + `eco.boss`, and determinism (same seed + same planet = the same world and the same guard placement).
// No planet (and a training) must behave exactly as before. Drives `window.__game` only — no console, no relay.
// Usage: node scripts/smoke-ecology.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* ── contract mirrored here (src/shared/planets.ts + constants.ts) ─────────────────────────────────────────────── */
const GATHER_NODES_PER_MISSION = 34;
/* 폐금속 공급 (2026-09-08): 고철 더미 — `SALVAGE_NODES_PER_MISSION` 와 같이 유지한다 */
const SALVAGE_NODES_PER_MISSION = 7;
/** Ambient population cap before `pressure`: `12 + 24 × threat`. */
const capBase = (threat) => 12 + 24 * threat;
/* 2026-09-09: `hazards` 도 planets.csv 를 그대로 옮긴 것이다 — 독성 포자가 후보인 행성에만 거대 버섯 군락이 선다. */
const PLANETS = [
  { id: 'amber', biome: 'amber', bugs: { scavenger: 4, hunter: 2, warrior: 1, artillery: 1 }, pressure: 0.85, rogues: 1.4, boss: true, maxArtillery: 1, maxBehemoth: 0, herbs: { herb_ashleaf: 3, herb_bloodroot: 1, herb_glowcap: 0.5 }, gatherDensity: 0.7, hazards: ['sandstorm','storm_eye'] },
  { id: 'tundra', biome: 'tundra', bugs: { scavenger: 3, hunter: 4, charger: 2, warrior: 2 }, pressure: 1, rogues: 0.8, boss: false, maxArtillery: 1, maxBehemoth: 1, herbs: { herb_bloodroot: 2, herb_ashleaf: 2, herb_glowcap: 1 }, gatherDensity: 0.9, hazards: ['blizzard','storm_eye'] },
  { id: 'mossy', biome: 'mossy', bugs: { scavenger: 4, spewer: 3, toxic: 3, warrior: 2, hunter: 1 }, pressure: 1.15, rogues: 0.6, boss: false, maxArtillery: 1, maxBehemoth: 1, herbs: { herb_bloodroot: 3, herb_glowcap: 3, herb_ashleaf: 1 }, gatherDensity: 1.5, hazards: ['spores','storm_eye'] },
  { id: 'ashen', biome: 'ashen', bugs: { scavenger: 3, warrior: 3, charger: 3, behemoth: 1, artillery: 2 }, pressure: 1.2, rogues: 1, boss: true, maxArtillery: 3, maxBehemoth: 2, herbs: { herb_ashleaf: 3, herb_glowcap: 1 }, gatherDensity: 0.6, hazards: ['sandstorm','storm_eye'] },
  { id: 'crimson', biome: 'crimson', bugs: { scavenger: 2, hunter: 3, spewer: 2, warrior: 2, artillery: 2 }, pressure: 0.9, rogues: 1.6, boss: true, maxArtillery: 2, maxBehemoth: 1, herbs: { herb_glowcap: 4, herb_bloodroot: 2 }, gatherDensity: 1, hazards: ['spores','sandstorm'] },
];
/** Types a patrol / wave can be composed of (artillery digs in alone, rogues are guards). */
const GROUP_TYPES = ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'toxic', 'behemoth'];
/** The pre-Phase-11 ambient ladder gates — a weighted draw may never open one. */
const ambientOpen = { scavenger: () => true, hunter: () => true, warrior: (t) => t > 0.25, spewer: (t) => t > 0.3, toxic: (t) => t >= 0.4, charger: (t) => t > 0.5, behemoth: () => false };
const waveOpen = { scavenger: () => true, hunter: () => true, warrior: (i) => i >= 2, spewer: (i) => i >= 2, toxic: (i) => i >= 2, charger: (i) => i >= 3, behemoth: (i) => i >= 3 };

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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket and the relay: another agent's save (or a real profile) must not disturb the run.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws\?/.test(String(args[0]))) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
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
    window.__worldSys = window.__game.getSystem('world');
    window.__ready = [];
    window.__game.ctx.bus.on('world:ready', (p) => window.__ready.push({ seed: p.seed, planet: p.planet === undefined ? '(absent)' : p.planet }));
    /** Generate a mission for `planet` (null = the old seeded draw) exactly as an emitter must: ctx first, then emit. */
    window.__mission = (seed, planet, mode) => {
      const ctx = window.__game.ctx;
      ctx.missionPlanet = planet ?? null;
      ctx.missionMode = mode ?? 'raid';
      const ev = { seed };
      if (mode) ev.mode = mode;
      if (planet) ev.planet = planet;
      ctx.bus.emit('game:newMission', ev);
    };
    /** Everything this lane owns, read straight after a generation. */
    window.__snap = () => {
      const ctx = window.__game.ctx;
      const w = ctx.world;
      // 2026-09-08: 고철 더미(`kind: 'salvage'`)도 같은 목록에 있다 — 생태계 수치는 약초만 센다
      const all = w.getGatherNodes();
      // 2026-09-09: 거대 버섯 군락에 딸린 채집 버섯(`grove_*`)은 재해가 심는 것이라 생태계 밀도와 무관하다.
      const nodes = all.filter((n) => n.kind !== 'salvage' && !n.id.startsWith('grove_'));
      const groveNodes = all.filter((n) => n.id.startsWith('grove_')).length;
      const herbs = {};
      for (const n of nodes) herbs[n.defId] = (herbs[n.defId] ?? 0) + 1;
      return {
        planet: w.planet, mode: w.mode, seed: w.seed,
        biome: window.__worldSys.getBiome() ? window.__worldSys.getBiome().id : null,
        nodes: nodes.length, herbs, groveNodes,
        // 고철만 센다 — `all.length - nodes.length` 로 빼면 군락 버섯까지 고철로 잡힌다 (2026-09-09)
        salvage: all.filter((n) => n.kind === 'salvage').length,
        nodeSig: nodes.map((n) => `${n.id}:${n.defId}:${n.position.x.toFixed(3)},${n.position.z.toFixed(3)}`).join('|'),
        eco: window.__sys.debugEcology,
        guards: window.__sys.debugGuardCount(),
        ready: window.__ready[window.__ready.length - 1] ?? null,
      };
    };
    /** `samples` ambient patrols + waves 0..7, without spawning anything. */
    window.__compose = (samples) => {
      const sys = window.__sys;
      const out = { ambient: {}, wave: {}, byThreat: {} };
      for (const threat of [0.3, 0.5, 0.9]) {
        const seen = {};
        for (let i = 0; i < samples; i++) for (const t of sys.debugAmbientGroup(threat)) seen[t] = (seen[t] ?? 0) + 1;
        out.byThreat[threat] = seen;
        for (const k in seen) out.ambient[k] = (out.ambient[k] ?? 0) + seen[k];
      }
      for (let index = 0; index <= 7; index++) {
        const seen = {};
        for (let i = 0; i < samples; i++) for (const t of sys.debugWaveGroup(index, 14)) seen[t] = (seen[t] ?? 0) + 1;
        out.wave[index] = seen;
      }
      return out;
    };
    window.__caps = (threat) => { window.__game.ctx.enemies.setThreatLevel(threat); return { threat, cap: window.__sys.debugAmbientCap }; };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const gen = async (seed, planet, mode) => {
    await P((a) => window.__mission(a.seed, a.planet, a.mode), { seed, planet: planet ?? null, mode: mode ?? null });
    await waitFor(page, () => window.__game.ctx.phase === 'playing' || window.__game.ctx.phase === 'deploying', 'mission phase', 30000);
    await waitFor(page, () => window.__game.ctx.world && window.__game.ctx.world.ready, 'world ready', 30000);
    await waitSim(0.2);
    return P(() => window.__snap());
  };

  console.log('boot');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  ok(await P(() => window.__sys.isAuthority), 'single-player: enemies run as the authority');

  /* ── baseline: no planet must behave exactly as before ─────────────────── */
  console.log('no planet (pre-Phase-11 behaviour)');
  const base = await gen(21, null);
  ok(base.planet === null && base.ready && base.ready.planet === null, `no planet → ctx.world.planet null and world:ready.planet null (${base.planet} / ${base.ready && base.ready.planet})`, JSON.stringify(base.ready));
  ok(base.biome !== null && PLANETS.some((p) => p.biome === base.biome), `the biome still comes from the seeded draw (${base.biome})`);
  ok(base.eco === null, 'no ecosystem is in force (debugEcology null)');
  ok(base.nodes === GATHER_NODES_PER_MISSION, `herb node count is the plain GATHER_NODES_PER_MISSION (${base.nodes})`);
  // 폐금속 공급 (2026-09-08): 고철 더미는 생태계와 무관하게 행성마다 같은 수로 깔린다
  ok(base.salvage === SALVAGE_NODES_PER_MISSION, `고철 더미 count is SALVAGE_NODES_PER_MISSION (${base.salvage})`);
  const baseCap = await P(() => window.__caps(0.5));
  ok(baseCap.cap === Math.round(capBase(0.5)), `ambient cap is 12 + 24 × threat with no planet (${baseCap.cap} @ ${baseCap.threat})`);
  const baseComp = await P((n) => window.__compose(n), 24);
  const baseAmbient = Object.keys(baseComp.ambient);
  ok(baseAmbient.length > 0 && baseAmbient.every((t) => ['scavenger', 'hunter', 'warrior', 'spewer', 'charger', 'toxic'].includes(t)) && !baseAmbient.includes('behemoth'),
    `ambient patrols keep the old type set, no behemoth (${baseAmbient.join(',')})`);
  ok((baseComp.wave[3].behemoth ?? 0) > 0 && (baseComp.wave[0].behemoth ?? 0) === 0 && (baseComp.wave[1].toxic ?? 0) === 0,
    'wave gates unchanged: behemoth from wave 3, no toxic before wave 2', JSON.stringify({ w0: baseComp.wave[0], w1: baseComp.wave[1], w3: baseComp.wave[3] }));
  ok(base.guards.rogues > 0 && base.guards.boss, `rogue guards + boss placed with no planet (${base.guards.rogues} rogues)`);

  /* ── per planet ────────────────────────────────────────────────────────── */
  const perPlanet = {};
  for (const def of PLANETS) {
    console.log(`planet ${def.id}`);
    const s = await gen(21, def.id);
    perPlanet[def.id] = s;
    ok(s.planet === def.id && s.ready && s.ready.planet === def.id, `${def.id}: echoed on ctx.world.planet and world:ready.planet`, JSON.stringify({ planet: s.planet, ready: s.ready }));
    ok(s.biome === def.biome, `${def.id}: biome is the one PlanetDef names (${s.biome})`);
    const want = Math.max(1, Math.round(GATHER_NODES_PER_MISSION * def.gatherDensity));
    ok(s.nodes === want, `${def.id}: ${want} herb nodes from gatherDensity ${def.gatherDensity} (got ${s.nodes})`);
    /* 2026-09-09: 독성 포자가 후보인 행성에는 거대 버섯 군락이 서고 그 주위에 채집 버섯이 심긴다.
       군락 버섯은 생태계 밀도(위 단언)와 무관한 별도 노드이고 id 가 `grove_` 로 시작한다. */
    const wantsGroves = (def.hazards ?? []).includes('spores');
    ok(wantsGroves ? s.groveNodes > 0 : s.groveNodes === 0,
      `${def.id}: 군락 버섯 ${wantsGroves ? '있음' : '없음'} (${s.groveNodes})`);
    const allowedHerbs = Object.keys(def.herbs).filter((k) => def.herbs[k] > 0);
    const gotHerbs = Object.keys(s.herbs);
    const topHerb = allowedHerbs.slice().sort((a, b) => def.herbs[b] - def.herbs[a])[0];
    ok(gotHerbs.length > 0 && gotHerbs.every((h) => allowedHerbs.includes(h)) && s.herbs[topHerb] > 0,
      `${def.id}: only the planet's herbs grow, the heaviest one is present (${gotHerbs.map((h) => `${h}×${s.herbs[h]}`).join(' ')})`);
    ok(s.eco && s.eco.pressure === def.pressure && s.eco.rogues === def.rogues && s.eco.boss === def.boss
      && s.eco.maxArtillery === def.maxArtillery && s.eco.maxBehemoth === def.maxBehemoth && s.eco.gatherDensity === def.gatherDensity,
      `${def.id}: the ecosystem reached enemies/ intact`, JSON.stringify(s.eco));
    const caps = await P((t) => window.__caps(t), 0.5);
    ok(caps.cap === Math.max(1, Math.round(capBase(0.5) * def.pressure)), `${def.id}: pressure ${def.pressure} scales the ambient cap (${caps.cap})`);
    const comp = await P((n) => window.__compose(n), 24);
    const forbidden = new Set();
    const gateBroken = new Set();
    for (const threat of [0.3, 0.5, 0.9]) {
      for (const t of Object.keys(comp.byThreat[threat])) {
        if (!(def.bugs[t] > 0)) forbidden.add(`ambient@${threat}:${t}`);
        if (!ambientOpen[t] || !ambientOpen[t](Number(threat))) gateBroken.add(`ambient@${threat}:${t}`);
      }
    }
    for (let i = 0; i <= 7; i++) {
      for (const t of Object.keys(comp.wave[i])) {
        if (!(def.bugs[t] > 0)) forbidden.add(`wave${i}:${t}`);
        if (!waveOpen[t] || !waveOpen[t](i)) gateBroken.add(`wave${i}:${t}`);
      }
    }
    ok(forbidden.size === 0, `${def.id}: no type outside eco.bugs is ever composed`, [...forbidden].join(' '));
    ok(gateBroken.size === 0, `${def.id}: every pre-Phase-11 threat / wave gate still holds`, [...gateBroken].join(' '));
    const anyArtillery = Object.keys(comp.ambient).includes('artillery') || Object.keys(comp.wave[7]).includes('artillery');
    ok(!anyArtillery, `${def.id}: artillery is never part of a group (it digs in on its own)`);
    const behemoths = comp.wave[7].behemoth ?? 0;
    ok(def.maxBehemoth > 0 && def.bugs.behemoth > 0 ? behemoths > 0 : behemoths === 0,
      `${def.id}: behemoths in late waves ${def.bugs.behemoth > 0 && def.maxBehemoth > 0 ? 'appear' : 'never appear'} (${behemoths})`);
    const expectRogues = def.rogues > 0;
    ok(expectRogues === (s.guards.rogues > 0), `${def.id}: rogue density ${def.rogues} → ${s.guards.rogues} guards`);
    ok(def.boss ? s.guards.boss : true, `${def.id}: ${def.boss ? 'the boss squad is guaranteed' : 'the boss squad is a seed roll'} (boss ${s.guards.boss})`);
  }
  const guardOrder = PLANETS.map((p) => ({ id: p.id, rogues: p.rogues, got: perPlanet[p.id].guards.rogues }));
  const dense = guardOrder.find((g) => g.id === 'crimson');
  const sparse = guardOrder.find((g) => g.id === 'mossy');
  ok(dense.got > sparse.got, `guard density follows eco.rogues (crimson ${dense.got} > mossy ${sparse.got})`, JSON.stringify(guardOrder));

  /* ── herb weights over several seeds (the weighted draw, not just the id set) ── */
  console.log('herb weights (amber over 3 seeds)');
  const tally = { ...perPlanet.amber.herbs };
  for (const seed of [77, 123]) {
    const s = await gen(seed, 'amber');
    for (const k in s.herbs) tally[k] = (tally[k] ?? 0) + s.herbs[k];
  }
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  ok(total >= 60, `sampled ${total} herb nodes across 3 seeds`);
  ok((tally.herb_ashleaf ?? 0) > (tally.herb_bloodroot ?? 0) && (tally.herb_ashleaf ?? 0) > (tally.herb_glowcap ?? 0),
    `amber's weights (ashleaf 3 / bloodroot 1 / glowcap 0.5) show in the mix (${JSON.stringify(tally)})`);
  ok(Object.keys(tally).every((h) => ['herb_ashleaf', 'herb_bloodroot', 'herb_glowcap'].includes(h)), 'no unknown herb id was placed', JSON.stringify(tally));

  /* ── the plant shape is decoupled from the herb it drops ──────────────── */
  const mossyHerbs = Object.keys(perPlanet.mossy.herbs).length;
  ok(mossyHerbs >= 2, `mossy places more than one herb id although there are only 3 plant shapes (${mossyHerbs} ids)`);
  ok(!('herb_bloodroot' in perPlanet.ashen.herbs), 'ashen (no bloodroot weight) grows no 혈청초 at all', JSON.stringify(perPlanet.ashen.herbs));

  /* ── determinism: same seed + same planet ─────────────────────────────── */
  console.log('determinism');
  const d1 = await gen(404, 'ashen');
  const d2 = await gen(404, 'ashen');
  ok(d1.biome === d2.biome && d1.nodes === d2.nodes, `same seed + planet → same biome / node count (${d1.biome}, ${d1.nodes})`);
  ok(d1.nodeSig === d2.nodeSig && d1.nodeSig.length > 0, 'same seed + planet → identical herb ids and positions');
  ok(d1.guards.rogues === d2.guards.rogues && d1.guards.boss === d2.guards.boss, `same seed + planet → identical guard placement (${d1.guards.rogues} rogues, boss ${d1.guards.boss})`);
  const other = await gen(404, 'mossy');
  ok(other.nodeSig !== d1.nodeSig, 'a different planet on the same seed gives a different herb mix');

  /* ── unknown id + training ────────────────────────────────────────────── */
  console.log('unknown id / training');
  const unknown = await gen(21, 'not-a-planet');
  ok(unknown.planet === null && unknown.eco === null && unknown.nodes === GATHER_NODES_PER_MISSION,
    `an unknown planet id falls back to the seeded draw (${unknown.planet}, ${unknown.nodes} nodes)`);
  const train = await gen(21, 'ashen', 'training');
  ok(train.mode === 'training' && train.planet === null && train.eco === null,
    `a training keeps planet null and no ecosystem (${train.mode} / ${train.planet})`, JSON.stringify(train.ready));
  ok(train.nodes === 0, 'the arena still has no gather nodes');
  ok(train.salvage === 0, 'the arena has no 고철 더미 either');
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
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
