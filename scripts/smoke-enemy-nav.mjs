// Enemy pathfinding smoke (TODO A-18 phase 2, 2026-09-21).
//
// Why it exists: `smoke-nav` proves the **graph** (links, fields, gates) with a synthetic walker. This one proves the
// **enemies** on top of it — real pooled bodies with their real AI, chasing a player who stands inside a building. The
// user's decisions it pins (2026-09-21):
//   - everything with a `nav` mask comes in through the doors (scavenger · hunter here), a warrior never does;
//   - only scavengers climb the outer wall to the roof · crawl through windows (breaking a whole pane first);
//   - a chokepoint lets `NAV_GATE_CAPACITY` bodies through at a time.
//
// Checks (one seed with a two-floor building that has a roof ladder):
//   A. player on floor 2, a pack (10 scavengers · 3 hunters · 1 warrior) spawned behind the back wall:
//      1. bodies enter flow mode, and most scavengers reach the player's floor next to him;
//      2. at least one hunter gets up the stairs; the warrior stays outside the footprint the whole time;
//      3. no gate ever holds more than `NAV_GATE_CAPACITY` tokens, and the private-plan rate stays under its cap;
//      4. a special link was performed (the climb hints 26–28 went out), and a window crossed means a pane broken.
//   B. player on the roof, a fresh pack (6 scavengers · 2 hunters):
//      5. scavengers get onto the roof by a `climb` (or the hatch ladder), hunters never do.
//   C. no page errors.
//
// Usage: node scripts/smoke-enemy-nav.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:5273/';
const SEED = 1234;
/** Sim-time budgets (s). The pack starts ~8 m behind the back wall; the way round to the door and up a flight is ~45 m. */
const PHASE_A_S = 60;
const PHASE_B_S = 40;

/** A number out of `data/constants.csv` — balance data is read, never copied. */
const K = (name) => {
  const line = readFileSync(new URL('../data/constants.csv', import.meta.url), 'utf8').split(/\r?\n/).find((l) => l.startsWith(name + ','));
  if (!line) throw new Error(`constants.csv has no ${name}`);
  return Number(line.split(',')[1]);
};
const GATE_CAPACITY = K('NAV_GATE_CAPACITY');
const PLANS_PER_FRAME = K('ENEMY_NAV_PLANS_PER_FRAME');

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
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** In the page: clear the map of enemies, pin the player at `stand`, spawn `types` around `around`, start the watcher. */
function stage({ stand, around, types }) {
  const ctx = window.__game.ctx;
  const s = window.__game.getSystem('enemies');
  for (const e of [...s.active]) s.despawn(e);
  window.__stand = stand;
  if (!window.__held) {
    window.__held = true;
    const pl = window.__game.getSystem('player');
    pl.takeDamage = () => {};
    if (ctx.player !== pl) ctx.player.takeDamage = () => {};
    (function hold() {
      const st = window.__stand;
      if (st) { ctx.player.position.set(st[0], st[1], st[2]); ctx.player.velocity.set(0, 0, 0); }
      requestAnimationFrame(hold);
    })();
  }
  const ids = [];
  types.forEach((ty, i) => {
    const a = (i / types.length) * Math.PI * 2;
    const e = s.debugSpawn(ty, { x: around[0] + Math.cos(a) * 4, y: around[1], z: around[2] + Math.sin(a) * 4 }, true);
    if (e) ids.push([e.id, ty]);
  });
  window.__ids = ids;
  window.__t0 = ctx.time;
  window.__max = { tokens: 0, waiting: 0, flow: 0, path: 0, trav: 0, plans: 0 };
  window.__hints = {};
  window.__travKinds = {};
  window.__inside = {};
  if (!window.__watching) {
    window.__watching = true;
    (function watch() {
      const n = s.debugNav(); const m = window.__max; const fp = window.__footprint;
      m.tokens = Math.max(m.tokens, ...n.tokens, 0); m.waiting = Math.max(m.waiting, n.waiting); m.flow = Math.max(m.flow, n.flow);
      m.path = Math.max(m.path, n.path); m.trav = Math.max(m.trav, n.traversing); m.plans = Math.max(m.plans, n.plansLastSecond);
      for (const e of s.active) {
        const h = s.debugHint(e.id); if (h >= 26) window.__hints[h] = 1;
        const d = s.debugNavOf(e.id); if (d && d.traverse !== 'none') window.__travKinds[e.type + ':' + d.traverse] = 1;
        // inside the building's footprint (its own axes), whatever the floor
        const dx = e.position.x - fp.cx, dz = e.position.z - fp.cz;
        const u = dx * fp.c + dz * fp.s, v = -dx * fp.s + dz * fp.c;
        if (Math.abs(u) < fp.halfW - 0.3 && Math.abs(v) < fp.halfD - 0.3 && e.state !== 'dead') window.__inside[e.type] = 1;
      }
      requestAnimationFrame(watch);
    })();
  }
  return ids.length;
}

/** In the page: how the staged pack stands. */
function census() {
  const s = window.__game.getSystem('enemies');
  const st = window.__stand;
  const near = {}, level = {}, modes = [];
  for (const [id, ty] of window.__ids) {
    const e = s.byId.get(id);
    if (!e || e.state === 'dead') continue;
    const d = Math.hypot(e.position.x - st[0], e.position.z - st[2]);
    const dy = Math.abs(e.position.y - st[1]);
    if (dy < 1) level[ty] = (level[ty] ?? 0) + 1;
    if (dy < 1 && d < 5) near[ty] = (near[ty] ?? 0) + 1;
    const n = s.debugNavOf(id);
    modes.push(`${ty[0]}${id}:${d.toFixed(0)}m/dy${(e.position.y - st[1]).toFixed(1)}/${n.mode}${n.traverse !== 'none' ? '/' + n.traverse : ''}${n.waitGate >= 0 ? '/wait' : ''}${n.gate >= 0 ? '/tok' : ''}${n.offT > 0 ? '/off' : ''}`);
  }
  return {
    t: +(window.__game.ctx.time - window.__t0).toFixed(1), near, level, max: window.__max, hints: Object.keys(window.__hints),
    trav: Object.keys(window.__travKinds), inside: Object.keys(window.__inside), modes: modes.join(' '),
    broken: window.__game.getSystem('world').structures.glassSet.brokenCount,
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0];
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  // A headless page's rAF can stall; drive the frame from a timer when it does (the same fallback the other smokes use).
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await page.evaluate((s) => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: s }); }, SEED);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'pod landed', 30000);
  await waitFor(page, () => window.__game.ctx.world.nav?.ready, 'nav ready', 60000);

  const spots = await page.evaluate(() => {
    const s = window.__game.getSystem('enemies');
    s.training = true;   // no ambient spawns, no site groups walking in
    const w = window.__game.ctx.world, ws = window.__game.getSystem('world');
    const r = ws.structures.debugNav().find((q) => q.nav.stairTop && w.getLadders().some((l) => l.id.startsWith(`ladder_${q.id}_`)));
    if (!r) return null;
    const nav = r.nav, c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
    window.__footprint = { cx: nav.cx, cz: nav.cz, c, s: sn, halfW: nav.halfW, halfD: nav.halfD };
    const at = (lx, lz) => [nav.cx + lx * c - lz * sn, nav.cz + lx * sn + lz * c];
    const behind = at(0, nav.halfD + 8), up = at(nav.stairTop[0], nav.stairTop[1]);
    const L = w.getLadders().find((l) => l.id.startsWith(`ladder_${r.id}_`));
    return {
      id: r.id, gates: w.nav.gates.length,
      behind: [behind[0], w.getSurfaceY(behind[0], behind[1], nav.levels[0] + 0.5), behind[1]],
      floor2: [up[0], nav.levels[1], up[1]], roof: [L.exit.x, L.topY, L.exit.z],
    };
  });
  ok(!!spots, `seed ${SEED} has a two-floor building with a roof ladder`);
  if (!spots) throw new Error('no building to test');
  console.log(`  building ${spots.id} · ${spots.gates} gates`);

  /* ── A. the player on floor 2 ─────────────────────────────────────────── */
  console.log('A. player on floor 2 — 10 scavengers · 3 hunters · 1 warrior behind the back wall');
  const packA = [...Array(10).fill('scavenger'), 'hunter', 'hunter', 'hunter', 'warrior'];
  const madeA = await page.evaluate(stage, { stand: spots.floor2, around: spots.behind, types: packA });
  ok(madeA === packA.length, `spawned the pack (${madeA}/${packA.length})`);
  let a = null;
  for (;;) {
    await sleep(2500);
    a = await page.evaluate(census);
    if (a.t >= PHASE_A_S || ((a.near.scavenger ?? 0) >= 6 && (a.level.hunter ?? 0) >= 1)) break;
  }
  console.log(`  t=${a.t}s ${a.modes}`);
  console.log(`  max ${JSON.stringify(a.max)} hints [${a.hints}] links [${a.trav}] inside [${a.inside}] broken panes ${a.broken}`);
  ok(a.max.flow >= 6, `bodies read the flow field (max ${a.max.flow} at once)`);
  ok((a.near.scavenger ?? 0) >= 6, `scavengers reached the player on floor 2 (${a.near.scavenger ?? 0}/10 within 5 m)`);
  ok((a.level.hunter ?? 0) >= 1, `a hunter came up the stairs (${a.level.hunter ?? 0}/3 on the floor)`);
  ok(!a.inside.includes('warrior'), 'the warrior never entered the building');
  ok(a.max.tokens <= GATE_CAPACITY, `a gate never held more than ${GATE_CAPACITY} tokens (max ${a.max.tokens})`);
  ok(a.max.tokens >= 1, 'gate tokens were taken at all');
  ok(a.max.plans <= PLANS_PER_FRAME * 70, `private plans stayed rate-limited (${a.max.plans}/s)`);
  ok(a.trav.some((k) => k.startsWith('scavenger:')), `a scavenger performed a special link [${a.trav}]`);
  ok(a.hints.length > 0, `the climb hints went out [${a.hints}]`);
  ok(!a.trav.some((k) => k === 'hunter:climb' || k === 'hunter:window' || k === 'hunter:ladder'), 'no hunter took a special link');
  if (a.trav.includes('scavenger:window')) ok(a.broken >= 1, `a window was crossed, so a pane is broken (${a.broken})`);

  /* ── B. the player on the roof ────────────────────────────────────────── */
  console.log('B. player on the roof — 6 scavengers · 2 hunters');
  const packB = [...Array(6).fill('scavenger'), 'hunter', 'hunter'];
  await page.evaluate(stage, { stand: spots.roof, around: spots.behind, types: packB });
  let b = null;
  for (;;) {
    await sleep(2500);
    b = await page.evaluate(census);
    if (b.t >= PHASE_B_S || (b.level.scavenger ?? 0) >= 4) break;
  }
  console.log(`  t=${b.t}s ${b.modes}`);
  console.log(`  links [${b.trav}]`);
  ok((b.level.scavenger ?? 0) >= 4, `scavengers got onto the roof (${b.level.scavenger ?? 0}/6)`);
  ok(b.trav.includes('scavenger:climb') || b.trav.includes('scavenger:ladder'), `by the wall or the hatch ladder [${b.trav}]`);
  ok((b.level.hunter ?? 0) === 0, 'no hunter on the roof');

  const real = errors.filter((e) => !e.includes('WebSocket') && !e.includes('ERR_CONNECTION'));
  ok(real.length === 0, 'no page errors', JSON.stringify(real.slice(0, 3)));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
