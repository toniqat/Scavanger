// No layout read inside a frame (CLAUDE.md §4.2), enforced (2026-09-20, `docs/PERF_PLAN.md` Phase B).
//
// Why it exists: the rule 「a HUD widget never reads `clientWidth` / `getBoundingClientRect` on a per-frame path」
// lived only in comments, and nothing failed when it was broken. `hud/ChatLog` broke it for a year — `measure()`
// asked each new row for its `getBoundingClientRect().height` and `stick()` read `scrollHeight`, both from inside
// `Engine.frame` right after `HudSystem.update` had dirtied the HUD. One line cost ~2.7 ms of forced layout; the
// three android callouts of a first contact landed in one frame and cost 8.3 ms of it. `tsc` passes, every other
// smoke passes, and the perf harness only says 「`u:allies` was slow」 — nothing names the line.
//
// What it measures: a **count**, not a time. Every layout-forcing accessor (`offsetWidth` · `clientHeight` ·
// `scrollHeight` · `getBoundingClientRect` · `getComputedStyle` …) is patched to increment a counter **while, and
// only while, `Engine.frame` is on the stack**, together with the call site. A read from a pointer handler, a
// resize or a menu build is outside a frame and is not counted — those pay one layout the browser was going to do
// anyway. A failure prints the file and function that has to change.
//
// **The one allowed idiom** (`KNOWN_IDIOM` below) is the CSS animation restart
// `classList.remove(c); void el.offsetWidth; classList.add(c)`. It is not allowed because it is cheap — measured
// 2026-09-20, a flush inside a dirtied raid frame is **~1–2 ms whether it is style or layout** (`getComputedStyle`
// measured 1.5–2.1 ms against `clientWidth`'s 0.9–1.9) — but because **no read-free replacement works**:
// `getAnimations()` drops an animation that has finished with no `fill`, it does not see one that lives on a
// descendant, and a same-task remove/add (with or without one `requestAnimationFrame`) coalesces into no change.
// Fixing it needs a decision, not a rewrite — `docs/TODO.md` B-68. So the bar here is: **unknown sites 0, and the
// known-idiom file list never grows.**
//
// Checks:
//   1. hub frames (ship HUD · ship management layer) — 0 unexpected reads inside a frame
//   2. raid frames with 60 bugs alive (nameplates · detection arrows · danger · markers · compass) — 0
//   3. the Phase B case itself, run **inside** one frame: three `ally:chat` callouts + an android ping + a notify +
//      squad chat + damage + the hit marker / dry fire / implant flashes — 0 outside the known idiom
//   4. no console errors
//
// Usage: node scripts/smoke-layout-reads.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEED = 7001;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/**
 * Files allowed to force a layout **for the CSS animation restart idiom only** (see the header). Every entry is a
 * `void <el>.offsetWidth` sandwiched between a `classList.remove` and a `classList.add`. The list is a ratchet: it
 * may shrink, never grow. Shrinking it is `docs/TODO.md` B-68.
 */
const KNOWN_IDIOM = [
  'ActionFeedback.ts', 'DamageOverlay.ts', 'DroneHud.ts', 'DroneScanLabels.ts', 'ImplantWidget.ts',
  'NamedScanWarning.ts', 'Reticle.ts', 'RoomLabel.ts', 'ShipManage.ts', 'StratagemPanel.ts',
  'TrainingPanel.ts', 'Vitals.ts', 'WeaponPanel.ts',
];

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * The in-page probe. Serialised by puppeteer, so it may not close over anything out here.
 *
 * It patches the accessors on the prototypes rather than wrapping widgets, so a **new** widget is covered the day it
 * is written — which is the point of the guard. `inFrame` is a depth counter around `Engine.frame`, so a read that a
 * frame causes indirectly (a bus handler, a `lateUpdate`, a `queueMicrotask` drained inside it) counts too.
 */
function installLayoutProbe() {
  if (window.__layoutProbe) return 'already installed';
  const g = window.__game;
  const st = { depth: 0, hits: {}, count: 0, frames: 0, queue: [], jobs: [] };
  const site = () => {
    const stack = (new Error().stack || '').split('\n');
    for (let i = 2; i < stack.length; i++) {
      const line = stack[i];
      if (!line || line.includes('layoutProbed') || line.includes('installLayoutProbe')) continue;
      const m = line.match(/at\s+([^\s(]+)?\s*\(?(https?:[^)]+)\)?/);
      if (!m) continue;
      const url = (m[2] || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (url.includes('node_modules') || url.includes('/three')) continue;
      return `${url} ${m[1] || '?'}`;
    }
    return '(unknown site)';
  };
  const bump = (what) => {
    if (st.depth <= 0) return;                        // outside a frame: the browser lays out once anyway
    st.count++;
    const key = `${what} @ ${site()}`;
    st.hits[key] = (st.hits[key] || 0) + 1;
  };
  const patchGet = (proto, name) => {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !d.get) return false;
    const get = d.get;
    Object.defineProperty(proto, name, { ...d, get: function layoutProbed() { bump(name); return get.call(this); } });
    return true;
  };
  const patchFn = (proto, name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return false;
    proto[name] = function layoutProbed(...a) { bump(name); return orig.apply(this, a); };
    return true;
  };
  const watched = [];
  for (const n of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent']) if (patchGet(HTMLElement.prototype, n)) watched.push(n);
  for (const n of ['clientWidth', 'clientHeight', 'clientTop', 'clientLeft', 'scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft']) if (patchGet(Element.prototype, n)) watched.push(n);
  for (const n of ['getBoundingClientRect', 'getClientRects', 'checkVisibility']) if (patchFn(Element.prototype, n)) watched.push(n);
  for (const n of ['innerWidth', 'innerHeight']) if (patchGet(window, n)) watched.push(n);
  if (patchFn(window, 'getComputedStyle')) watched.push('getComputedStyle');

  const rawFrame = g.frame.bind(g);
  g.frame = function probedFrame(now) {
    // jobs run **inside** the frame, which is the whole point: the same event fired from `page.evaluate` would
    // land between frames, where a layout read is not the bug being guarded against.
    while (st.queue.length) {
      const job = st.queue.shift();
      st.depth++;
      try { job.result = job.fn(g, g.ctx); } catch (e) { job.error = String(e); } finally { st.depth--; }
      job.done = true;
    }
    st.depth++;
    st.frames++;
    try { return rawFrame(now); } finally { st.depth--; }
  };

  window.__layoutProbe = {
    watched,
    reset() { st.hits = {}; st.count = 0; st.frames = 0; },
    report() {
      return {
        frames: st.frames, count: st.count,
        sites: Object.entries(st.hits).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `${k} ×${n}`),
      };
    },
    /** Run `code` (the body of `function (g, ctx)`) inside the next frame. */
    queue(code) {
      const job = { fn: new Function('g', 'ctx', code), done: false };
      st.jobs.push(job); st.queue.push(job);
      return st.jobs.length - 1;
    },
    job(i) { const j = st.jobs[i]; return j ? { done: j.done, result: j.result, error: j.error } : null; },
  };
  return `ok (${watched.length} accessors)`;
}

const T0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=960,540', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('scav.s1.tutorial', JSON.stringify({
        version: 2,
        tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true }, raid2: { step: null, done: true } },
      }));
    } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    // swiftshader stalls rAF; the smokes drive the frame from a timer when it does (memory: headless smokes).
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  console.log(`probe: ${await page.evaluate(installLayoutProbe)}`);

  /** Split a report's sites into the allowed idiom and everything else. */
  const split = (r) => {
    const known = [], unknown = [];
    for (const s of r.sites) (KNOWN_IDIOM.some((f) => s.includes('/' + f)) ? known : unknown).push(s);
    return { known, unknown };
  };
  const measure = async (label, seconds) => {
    await page.evaluate(() => window.__layoutProbe.reset());
    await sleep(seconds * 1000);
    const r = await page.evaluate(() => window.__layoutProbe.report());
    const { known, unknown } = split(r);
    ok(r.frames > 0 && unknown.length === 0,
      `${label} — ${unknown.length} unexpected layout reads inside ${r.frames} frames`
        + (known.length ? ` (${known.length} known-idiom site${known.length > 1 ? 's' : ''})` : ''),
      unknown.join(' | '));
    return r;
  };

  /* ── 1. the ship ──────────────────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await sleep(1500);
  await measure('hub frames', 3);

  /* ── 2. a raid with a crowd ───────────────────────────────────────────── */
  await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), SEED);
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 60000);
  await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 40000);
  await waitFor(page, () => { const p = window.__game.ctx.player; return p.spawned && !p.isDropping; }, 'landed', 60000);
  const spawned = await page.evaluate(() => {
    const g = window.__game, p = g.ctx.player.position, es = g.getSystem('enemies');
    let made = 0, i = 0;
    for (const [type, n] of [['scavenger', 40], ['warrior', 10], ['hunter', 10]]) {
      for (let k = 0; k < n; k++) {
        const a = (i / 60) * Math.PI * 2, r = 25 + (i % 7) * 2.5; i++;
        if (es.debugSpawn(type, { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r }, false)) made++;
      }
    }
    return made;
  });
  ok(spawned >= 40, `spawned a crowd for the raid frames (${spawned} bugs)`);
  await sleep(1500);
  await measure('raid frames with a crowd', 4);

  /* ── 3. the Phase B case: HUD-feeding events fired from **inside** a frame ─ */
  await page.evaluate(() => window.__layoutProbe.reset());
  const jobIdx = await page.evaluate(() => window.__layoutProbe.queue(`
    const bus = ctx.bus, p = ctx.player;
    // three android callouts + a ping in one frame — exactly what first contact does (PERF_PLAN Phase B)
    for (let i = 0; i < 3; i++) {
      bus.emit('ally:chat', { id: 'android:' + i, name: '안드로이드 ' + i, slot: i, text: '적 발견' });
      bus.emit('ally:ping', { id: 'android:' + i, name: '안드로이드 ' + i, slot: i, kind: 'enemy', position: p.position.clone() });
    }
    bus.emit('chat:post', { text: '분대 채팅 한 줄', kind: 'text' });
    bus.emit('ui:notify', { text: '알림 한 줄' });
    bus.emit('player:damaged', { amount: 7, hp: p.hp });
    bus.emit('ui:damageIndicator', { from: p.position.clone() });
    // the one-shot animation restarts that used to read \`offsetWidth\` (ui/dom \`restartAnim\`)
    bus.emit('ui:hitmarker', { kill: false, headshot: true });
    bus.emit('ui:hitmarker', { kill: true, headshot: false });
    bus.emit('weapon:dryFire', { weaponId: 'rifle_1' });
    bus.emit('implant:activated', { id: 'grapple', position: p.position.clone() });
    bus.emit('implant:ready', { id: 'grapple', charges: 1, maxCharges: 1, full: true, refill: false });
    bus.emit('player:staminaDepleted', {});
    return true;
  `));
  await waitFor(page, (i) => { const j = window.__layoutProbe.job(i); return !!j && j.done; }, 'in-frame job', 30000, jobIdx);
  const job = await page.evaluate((i) => window.__layoutProbe.job(i), jobIdx);
  ok(!job.error, 'the in-frame job ran', String(job.error ?? ''));
  await sleep(700);                                  // let the widgets settle over a few more frames
  const ev = await page.evaluate(() => window.__layoutProbe.report());
  const evSplit = split(ev);
  ok(evSplit.unknown.length === 0,
    `chat · ping · notify · damage · hit marker · dry fire · implant from inside a frame — ${evSplit.unknown.length} unexpected layout reads`,
    evSplit.unknown.join(' | '));
  // the ratchet: the flash paths really did run, and every one of them is on the known list
  ok(evSplit.known.length > 0, `the animation-restart idiom fired and was recognised (${evSplit.known.length} site(s))`,
    'nothing fired — the events above stopped reaching their widgets, so the ratchet below proves nothing');
  const strayFiles = [...new Set(ev.sites.map((x) => (x.match(/\/([A-Za-z0-9_]+\.ts)/) || [])[1]).filter(Boolean))]
    .filter((f) => !KNOWN_IDIOM.includes(f));
  ok(strayFiles.length === 0, `no file outside KNOWN_IDIOM forces a layout in a frame`, strayFiles.join(', '));
  const lines = await page.evaluate(() => document.querySelectorAll('.chat-line').length);
  ok(lines >= 4, `the chat really drew the lines (${lines} rows) — the count above is not an empty test`);

  const gameErrors = errors.filter((e) => !/WebSocket|\/ws\b|ERR_CONNECTION_REFUSED/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String((e && e.stack) || e)}`);
  if (errors.length) console.log(`    page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fail === 0 ? 0 : 1);
