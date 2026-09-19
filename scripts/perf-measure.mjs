/**
 * Phase 0 of `docs/PERF_PLAN.md` — the measurement harness. **Not a smoke** (`verify.mjs` only runs the files in its
 * `SMOKES` table), and it asserts nothing: it plays a scenario and prints numbers.
 *
 * Why headful by default: the frame time is the thing being measured, and a headless Chrome does not present frames on
 * a real swap chain — the smokes even have to drive `__game.frame` from a `setInterval` when its rAF stalls. This
 * script never installs that fallback; if rAF is not running it stops and says so.
 *
 * What it measures, without touching a line of `src/`: it wraps, on the live page, every system's `update` /
 * `lateUpdate`, `ShaderWarmup.beforeRender` (where `LightBudget` walks the scene), `Outline.prepare`,
 * `AudioSystem.play`, `EnemySystem.spawn` / `ensureCapacity`, `AmbientSpawner.update`, and `Engine.frame` itself.
 * Frame cadence comes from the rAF timestamps `Engine.frame` is called with; per-frame JS cost from a timer around its
 * body. The `x:` rows are slices *inside* the `u:` rows above them, never additions to them.
 *
 * Usage (needs a vite: `npm run dev`):
 *   node scripts/perf-measure.mjs [http://localhost:5273] [options]
 *     --only s1,s3a       scenarios to run (default s1,s2,s3a,s3b,s4)
 *     --label <name>      log name (default: an ISO timestamp)
 *     --seconds <n>       length of each record window (default 20)
 *     --settle <n>        sim seconds between landing and the window (default 4)
 *     --headless          run headless anyway (the cadence is then not trustworthy)
 *     --keep-open         leave the browser up at the end
 *     --out <path>        json path (default scripts/logs/perf/<label>.json)
 *
 * Scenarios follow the PERF_PLAN table: S1 idle · S2 60 bugs · S3a a burrow group in one frame · S3b the natural patrol
 * tick · S4 three androids in a fight. S5 (relay, two humans) is not here — it needs the e2e harness.
 */
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/* ── options ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const BASE = argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LABEL = opt('--label', STAMP);
const WINDOW_S = Number(opt('--seconds', '20'));
const SETTLE_S = Number(opt('--settle', '4'));
const OUT = opt('--out', `scripts/logs/perf/${LABEL}.json`);
const ONLY = opt('--only', 's1,s2,s3a,s3b,s4').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const HEADLESS = flag('--headless');
const PLANET = opt('--planet', 'tundra');   // threat 2, as PERF_PLAN's S1 asks for
const SEED = Number(opt('--seed', '7001'));
// A frame whose JS runs past one 60 Hz interval is a frame the player can lose — that is what gets an autopsy.
const SPIKE_MS = Number(opt('--spike', '16.7'));

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the in-page probe (serialised by puppeteer — no outer references) ───── */
function installProbe() {
  const g = window.__game;
  if (window.__perf) return 'already installed';
  const state = {
    on: false, frames: [], work: [], marks: {}, counts: {}, worst: {}, calls: [], tris: [],
    lastNow: 0, lastHeap: 0, heapDrops: 0, heapAlloc: 0, heapPeak: 0, frameIndex: 0, jobs: [], queue: [], healer: 0,
    frameMarks: {}, spikes: [], spikeMs: 16.7, spikeCap: 60,
  };
  const addMark = (k, ms) => {
    state.marks[k] = (state.marks[k] || 0) + ms;
    state.counts[k] = (state.counts[k] || 0) + 1;
    // The worst single call matters more than the mean for the things that only fire on a spawn tick.
    if (!(state.worst[k] >= ms)) state.worst[k] = ms;
    state.frameMarks[k] = (state.frameMarks[k] || 0) + ms;
  };
  const wrap = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'function') return false;
    const orig = obj[key].bind(obj);
    obj[key] = function wrapped(...a) {
      if (!state.on) return orig(...a);
      const t = performance.now();
      try { return orig(...a); } finally { addMark(label, performance.now() - t); }
    };
    return true;
  };

  g.ctx.renderer.info.autoReset = false;   // see `measuredFrame` — one reset per frame, not one per pass

  const wrapped = [];
  /*
   * `WorldMarkers.lateUpdate` draws 2-3 extraction diamonds, yet its cost moves 25x with the number of bodies on
   * screen. The only body-count-dependent thing it touches is `ctx.uiRoot.clientWidth` — the first layout read after
   * a frame of HUD style writes, which forces the browser to lay the whole UI out. Reading it here, one line earlier,
   * moves that cost into `x:layoutFlush` if that is what it is.
   */
  const hudSys = g.getSystem('hud');
  if (hudSys && typeof hudSys.lateUpdate === 'function') {
    const rawHudLate = hudSys.lateUpdate.bind(hudSys);
    hudSys.lateUpdate = function layoutProbed(dt, ctx) {
      if (state.on) { const t = performance.now(); void ctx.uiRoot.clientWidth; addMark('x:layoutFlush', performance.now() - t); }
      return rawHudLate(dt, ctx);
    };
  }
  for (const s of g.systems) {
    if (wrap(s, 'update', 'u:' + s.name)) wrapped.push('u:' + s.name);
    if (s.lateUpdate && wrap(s, 'lateUpdate', 'l:' + s.name)) wrapped.push('l:' + s.name);
  }
  // Slices inside the rows above: light budget (B3), outline, audio node building (A5 · B5), the spawn paths (A1 · A3 · A4).
  if (wrap(g.shaders, 'beforeRender', 'x:lightBudget')) wrapped.push('x:lightBudget');
  if (wrap(g.outline, 'prepare', 'x:outlinePrepare')) wrapped.push('x:outlinePrepare');
  const audio = g.getSystem('audio');
  if (wrap(audio, 'play', 'x:audioPlay')) wrapped.push('x:audioPlay');
  const enemies = g.getSystem('enemies');
  if (wrap(enemies, 'spawn', 'x:enemySpawn')) wrapped.push('x:enemySpawn');
  if (wrap(enemies, 'ensureCapacity', 'x:ensureCapacity')) wrapped.push('x:ensureCapacity');
  if (enemies && wrap(enemies.spawner, 'update', 'x:ambientSpawner')) wrapped.push('x:ambientSpawner');
  // The render block: every `renderer.render` of the frame (the direct draw, and one per composer / outline pass).
  // Its sum against the frame's draw-call count is what makes B1 (draw calls) measurable at all.
  if (wrap(g.ctx.renderer, 'render', 'x:rendererRender')) wrapped.push('x:rendererRender');
  if (wrap(g.ctx.renderer, 'compile', 'x:rendererCompile')) wrapped.push('x:rendererCompile');
  // `HudSystem.lateUpdate` is one call in the frame order but a dozen widgets inside it; split them (`h:` rows are
  // slices inside `l:hud`).
  const hud = g.getSystem('hud');
  if (hud) {
    for (const k of ['markers', 'pings', 'offscreen', 'danger', 'statusMarkers', 'scanWarning', 'droneHud',
      'nameplates', 'typing', 'detection', 'scanReveal', 'deployables']) {
      if (wrap(hud[k], 'lateUpdate', 'h:' + k)) wrapped.push('h:' + k);
    }
  }

  const rawFrame = g.frame.bind(g);
  g.frame = function measuredFrame(now) {
    if (!state.on) { rawFrame(now); return; }
    while (state.queue.length) {
      const job = state.queue.shift();
      const t = performance.now();
      try { job.result = job.fn(g, g.ctx); } catch (e) { job.error = String(e); }
      job.ms = performance.now() - t;
      job.frame = state.frameIndex;
      job.done = true;
    }
    if (state.lastNow) state.frames.push(now - state.lastNow);
    state.lastNow = now;
    // `renderer.info` resets itself on every `render()`, and a frame with bloom on is several passes — reading it after
    // the frame would report the last pass alone (1 draw). Reset once per frame instead and read the whole frame's total.
    g.ctx.renderer.info.reset();
    state.frameMarks = {};
    const t0 = performance.now();
    rawFrame(now);
    const ms = performance.now() - t0;
    state.work.push(ms);
    // Spike autopsy: the mark breakdown of the frames that actually overran, which is what the stutter is made of.
    if (ms >= state.spikeMs && state.spikes.length < state.spikeCap) {
      state.spikes.push({ frame: state.frameIndex, ms, marks: state.frameMarks });
    }
    const info = g.ctx.renderer.info.render;
    state.calls.push(info.calls);
    state.tris.push(info.triangles);
    const mem = performance.memory;
    if (mem) {
      const h = mem.usedJSHeapSize;
      if (state.lastHeap) { if (h < state.lastHeap - 1048576) state.heapDrops++; else state.heapAlloc += h - state.lastHeap; }
      state.lastHeap = h;
      if (h > state.heapPeak) state.heapPeak = h;
    }
    state.frameIndex++;
  };

  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  window.__perf = {
    wrapped,
    start(spikeMs) {
      if (spikeMs) state.spikeMs = spikeMs;
      state.frames = []; state.work = []; state.marks = {}; state.counts = {}; state.worst = {}; state.calls = []; state.tris = [];
      state.lastNow = 0; state.lastHeap = 0; state.heapDrops = 0; state.heapAlloc = 0; state.heapPeak = 0;
      state.frameIndex = 0; state.jobs = []; state.queue = []; state.frameMarks = {}; state.spikes = [];
      state.on = true;
      return true;
    },
    stop() { state.on = false; return state.frames.length; },
    /** Run `code` (the body of `function (g, ctx)`) **inside** the next frame, so its cost lands in that frame. */
    queue(name, code) {
      const job = { name, fn: new Function('g', 'ctx', code), done: false };
      state.jobs.push(job); state.queue.push(job);
      return state.jobs.length - 1;
    },
    job(i) {
      const j = state.jobs[i];
      return j ? { name: j.name, done: j.done, ms: j.ms, frame: j.frame, result: j.result, error: j.error } : null;
    },
    /** Heal the player on a timer (outside the frame) — a scenario that ends in a death measures the results screen. */
    keepAlive(on) {
      if (state.healer) { clearInterval(state.healer); state.healer = 0; }
      if (on) state.healer = setInterval(() => { const p = g.ctx.player; if (p && !p.isDead) p.heal(9999); }, 150);
      return !!state.healer;
    },
    report() {
      // Frame 0 of a window carries the window's own setup (the probe's first reset, the queued job), so it is left out
      // of the percentiles. The raw arrays keep it — `jobs[].frame` indexes into them.
      const f = state.frames.slice(1).sort((a, b) => a - b);
      const w = state.work.slice(1).sort((a, b) => a - b);
      const secs = state.frames.reduce((a, b) => a + b, 0) / 1000;
      const marks = Object.entries(state.marks)
        .map(([k, ms]) => ({ key: k, total: ms, perFrame: ms / Math.max(1, state.frameIndex), calls: state.counts[k], worst: state.worst[k] }))
        .sort((a, b) => b.total - a.total);
      const sysTotal = marks.filter((m) => m.key[0] === 'u' || m.key[0] === 'l').reduce((a, m) => a + m.total, 0);
      const workTotal = state.work.reduce((a, b) => a + b, 0);
      const jobs = state.jobs.map((j) => ({
        name: j.name, ms: j.ms, frame: j.frame, error: j.error, result: j.result,
        frameWork: j.frame === undefined ? undefined : state.work[j.frame],
        deltaAfter: j.frame === undefined ? undefined : Math.max(0, ...state.frames.slice(j.frame, j.frame + 3)),
      }));
      const scene = { nodes: 0, pointLights: 0 };
      g.ctx.scene.traverse((o) => { scene.nodes++; if (o.isPointLight) scene.pointLights++; });
      /*
       * Draw-call census: who owns the calls. A mesh is drawn once per pass it appears in, so the scene pass counts
       * every visible mesh and the shadow pass counts the `castShadow` ones — `renderer.info` gives the total but
       * never says which group produced it. Attribution is by the top-level `scene.children` entry, which is how the
       * systems park their content (one group per system / per body pool).
       */
      const census = [];
      for (const child of g.ctx.scene.children) {
        let meshes = 0, shadow = 0, hidden = 0;
        child.traverseVisible((o) => { if (o.isMesh || o.isLine || o.isPoints || o.isSprite) { meshes++; if (o.castShadow) shadow++; } });
        child.traverse((o) => { if ((o.isMesh || o.isLine || o.isPoints || o.isSprite) && !o.visible) hidden++; });
        if (meshes + hidden === 0) continue;
        census.push({ name: child.name || child.type, meshes, shadow, hidden });
      }
      census.sort((a, b) => b.meshes - a.meshes);
      return {
        frames: state.frames.length, seconds: secs, fps: state.frames.length / Math.max(0.001, secs),
        phase: g.ctx.phase,
        frame: {
          p50: pct(f, 0.5), p95: pct(f, 0.95), p99: pct(f, 0.99), max: f[f.length - 1] || 0,
          over50: f.filter((d) => d > 50).length, over33: f.filter((d) => d > 33.4).length,
        },
        work: { p50: pct(w, 0.5), p95: pct(w, 0.95), max: w[w.length - 1] || 0, share: workTotal / Math.max(1, secs * 1000) },
        draw: { calls: Math.round(avg(state.calls)), callsMax: Math.max(0, ...state.calls), triangles: Math.round(avg(state.tris)) },
        heap: { gcDrops: state.heapDrops, allocMBPerS: state.heapAlloc / 1048576 / Math.max(0.001, secs), peakMB: state.heapPeak / 1048576 },
        marks, jobs, census,
        spikes: state.spikes.map((sp) => ({
          frame: sp.frame, ms: sp.ms, delta: state.frames[sp.frame],
          top: Object.entries(sp.marks).filter(([k]) => k[0] !== 'x' && k[0] !== 'h').sort((a, b) => b[1] - a[1]).slice(0, 4)
            .concat(Object.entries(sp.marks).filter(([k]) => k[0] === 'x' || k[0] === 'h').sort((a, b) => b[1] - a[1]).slice(0, 3)),
        })),
        systemsTotalPerFrame: sysTotal / Math.max(1, state.frameIndex),
        restPerFrame: (workTotal - sysTotal) / Math.max(1, state.frameIndex),
        scene,
        // `getEnemies()` returns eggs too (they are enemies — CLAUDE.md §4.6), so count them apart: they are props that
        // stand still, and 8-30 of them per nest would otherwise read as a crowd.
        bodies: {
          enemies: g.ctx.enemies ? g.ctx.enemies.getEnemies().length : 0,
          eggs: g.ctx.enemies ? g.ctx.enemies.getEnemies().filter((e) => e.isEgg).length : 0,
          allies: g.ctx.allies ? g.ctx.allies.roster.length : 0,
        },
        render: { bloom: g.isPostProcessing, shadows: g.hasShadows, pixelRatio: g.ctx.renderer.getPixelRatio() },
        raw: { frames: state.frames, work: state.work },
      };
    },
  };
  return 'ok';
}

/* ── output helpers ──────────────────────────────────────────────────────── */
const fmt = (n, d = 1) => (n === undefined || n === null || Number.isNaN(Number(n)) ? '-' : Number(n).toFixed(d));
function printScenario(r) {
  console.log(`  frames ${r.frames} in ${fmt(r.seconds)}s — ${fmt(r.fps)} fps`);
  console.log(`  frame ms  p50 ${fmt(r.frame.p50)} · p95 ${fmt(r.frame.p95)} · p99 ${fmt(r.frame.p99)} · max ${fmt(r.frame.max)} — >50ms ${r.frame.over50}, >33ms ${r.frame.over33}`);
  console.log(`  js/frame  p50 ${fmt(r.work.p50)} · p95 ${fmt(r.work.p95)} · max ${fmt(r.work.max)}  (systems ${fmt(r.systemsTotalPerFrame, 2)} + rest ${fmt(r.restPerFrame, 2)})`);
  if (r.census) {
    console.log(`  draw-call census (visible drawables per top-level group · +shadow pass):`);
    for (const c of r.census.slice(0, 12)) console.log(`    ${String(c.name).padEnd(24)} ${String(c.meshes).padStart(5)} visible · ${String(c.shadow).padStart(4)} cast shadow · ${c.hidden} parked`);
  }
  console.log(`  draw ${r.draw.calls} calls (max ${r.draw.callsMax}) · ${(r.draw.triangles / 1000).toFixed(0)}k tris · scene ${r.scene.nodes} nodes · ${r.scene.pointLights} point lights`);
  console.log(`  bodies ${r.bodies.enemies} enemies (${r.bodies.eggs} eggs) · ${r.bodies.allies} androids · heap ${fmt(r.heap.allocMBPerS)} MB/s, ${r.heap.gcDrops} gc drops, peak ${fmt(r.heap.peakMB)} MB`);
  for (const m of r.marks.filter((x) => x.perFrame >= 0.02).slice(0, 14)) {
    console.log(`    ${m.key.padEnd(22)} ${fmt(m.perFrame, 3).padStart(8)} ms/frame  (worst call ${fmt(m.worst, 2)} ms, ${fmt(m.total, 0)} ms total, ${m.calls} calls)`);
  }
  if (r.spikes && r.spikes.length) {
    console.log(`  spike frames (js over one vsync): ${r.spikes.length}${r.spikes.length >= 60 ? '+ (capped)' : ''}`);
    for (const sp of r.spikes.slice(0, 8)) {
      console.log(`    frame ${sp.frame}: js ${fmt(sp.ms)} ms · rAF delta ${fmt(sp.delta)} ms · ${sp.top.map(([k, v]) => `${k} ${fmt(v, 2)}`).join(' · ')}`);
    }
  }
  for (const j of r.jobs ?? []) {
    if (!j || j.frame === undefined) continue;
    console.log(`    job ${j.name}: ${fmt(j.ms, 2)} ms in-frame · that frame's js ${fmt(j.frameWork, 2)} ms · worst rAF delta after ${fmt(j.deltaAfter)} ms`
      + `${j.error ? ' ERROR ' + j.error : ''}${j.result === undefined ? '' : ' → ' + JSON.stringify(j.result)}`);
  }
}

/* ── driver ──────────────────────────────────────────────────────────────── */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADLESS,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // Silence the speakers without changing what is measured: `--mute-audio` mutes Chrome's output stream while the page
    // still builds every WebAudio node, so `x:audioPlay` (A5 burrow · B5 bug footsteps) keeps its real cost. Turning the
    // in-game volume down instead would take those graphs out of the measurement.
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--no-sandbox'],
});

const results = [];
let env = {};
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  async function waitFor(fn, label, timeout = 60000, arg) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label}`);
  }
  const waitSim = async (sec) => {
    const t0 = await P(() => window.__game.ctx.time);
    await waitFor((t) => window.__game.ctx.time >= t, `sim +${sec}s`, Math.max(60000, sec * 4000), t0 + sec);
  };

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(() => !!window.__game && !!window.__game.ctx.enemies && !!window.__game.ctx.allies, 'boot', 90000);
  await P(() => {
    const c = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => c, configurable: true });
  });

  // rAF must be what drives the engine — this whole measurement is about frame cadence.
  const advanced = await P(async () => {
    const t0 = window.__game.ctx.time;
    await new Promise((r) => setTimeout(r, 1000));
    return window.__game.ctx.time - t0;
  });
  if (advanced < 0.3) throw new Error(`the page is not running frames (ctx.time advanced ${advanced.toFixed(2)}s in 1s) — is the window visible?`);

  console.log(`probe: ${await P(installProbe)}`);
  env = await P(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      bloom: window.__game.isPostProcessing,
      shadows: window.__game.hasShadows,
      pixelRatio: window.__game.ctx.renderer.getPixelRatio(),
    };
  });
  console.log(`gpu: ${env.gpu}`);
  console.log(`viewport ${env.viewport} · dpr ${env.dpr} · pixelRatio ${fmt(env.pixelRatio, 2)} · bloom ${env.bloom} · shadows ${env.shadows}`);

  /* ── scenario helpers ──────────────────────────────────────────────────── */
  const toShip = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(() => window.__game.ctx.phase === 'hub', 'hub', 120000);
  };
  const launch = async () => {
    await P((a) => {
      window.__game.ctx.missionMode = 'raid';
      window.__game.ctx.missionPlanet = a.planet;
      window.__game.ctx.bus.emit('game:newMission', { seed: a.seed, planet: a.planet });
    }, { seed: SEED, planet: PLANET });
    await waitFor(() => window.__game.ctx.phase === 'playing', 'playing', 150000);
    await waitFor(() => !window.__game.ctx.player.isDropping, 'pod exit', 60000);
    // The player stands still with no input, so anything that reaches it kills it and the window would measure the
    // results screen instead of the scenario.
    await P(() => window.__perf.keepAlive(true));
    await waitSim(SETTLE_S);
  };
  /** Run `code` inside a frame and wait until that frame has passed. */
  const inFrame = async (name, code) => {
    const i = await P((a) => window.__perf.queue(a.name, a.code), { name, code });
    await waitFor((k) => { const j = window.__perf.job(k); return !!j && j.done; }, `job ${name}`, 60000, i);
    return i;
  };
  const record = async (id, name, setup) => {
    await P((ms) => window.__perf.start(ms), SPIKE_MS);
    await sleep(600);                    // keep the setup out of frame 0, whose cost is the window's own
    if (setup) await setup();
    await sleep(WINDOW_S * 1000);
    await P(() => window.__perf.stop());
    const rep = await P(() => window.__perf.report());
    rep.id = id; rep.name = name;
    if (rep.phase !== 'playing') console.log(`  !! the raid ended during the window (phase ${rep.phase}) — these numbers are not the scenario`);
    results.push(rep);
    printScenario(rep);
    return rep;
  };

  const RING60 = `
    const p = ctx.player.position; const es = g.getSystem('enemies');
    const plan = [['scavenger', 40], ['warrior', 10], ['hunter', 10]];
    let i = 0, made = 0; const total = 60;
    for (const [type, n] of plan) for (let k = 0; k < n; k++) {
      const a = (i / total) * Math.PI * 2; const r = 25 + (i % 7) * 2.5; i++;
      if (es.debugSpawn(type, { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r }, false)) made++;
    }
    return made;`;

  const BURROW8 = `
    const p = ctx.player.position; const es = g.getSystem('enemies');
    let made = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2; const r = 14 + (k % 3) * 3;
      if (es.debugSpawnBurrow(k % 4 === 0 ? 'warrior' : 'scavenger', { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r })) made++;
    }
    return made;`;

  if (ONLY.includes('s1')) {
    console.log('\n=== S1 — solo raid, idle, ambient population only ===');
    await toShip(); await launch();
    await record('S1', 'idle, ambient only');
  }

  if (ONLY.includes('s2')) {
    console.log('\n=== S2 — solo + 60 bugs in a ring at 25-40 m ===');
    await toShip(); await launch();
    await record('S2', '60 bugs alive', async () => { await inFrame('ring60', RING60); await waitSim(2); });
  }

  if (ONLY.includes('s3a')) {
    console.log('\n=== S3a — burrow group spawn spike (8 bodies in one frame) ===');
    await toShip(); await launch();
    await record('S3a', 'burrow x8 in one frame', async () => {
      await sleep(3000);                          // quiet frames first, so the spike stands out
      await inFrame('burrow8-cold', BURROW8);     // cold pool: every body is built on this frame (A1)
      await sleep(5000);
      await inFrame('burrow8-warm', BURROW8);     // the pool now has bodies to recycle
    });
  }

  if (ONLY.includes('s3b')) {
    console.log('\n=== S3b — the natural ambient patrol tick (placement search included) ===');
    await toShip(); await launch();
    await record('S3b', 'ambient patrol tick', async () => {
      // `AmbientSpawner.update` returns at once while the population is at its cap (`ambientCap`, 19 on a threat-2
      // planet) — and `world:ready` fills the map to it. Clear the map first, or the tick measures nothing.
      await inFrame('killAll', `g.getSystem('enemies').killAll(); return true;`);
      await sleep(1500);
      for (let k = 0; k < 6; k++) {
        await sleep(2500);
        await inFrame(`patrol${k}`, `
          const es = g.getSystem('enemies');
          const before = es.active.length;
          es.spawner.timer = 0;
          return { before, cap: es.spawner.cap, threat: es.spawner.threat };`);
      }
    });
  }

  if (ONLY.includes('s4')) {
    console.log('\n=== S4 — 3 androids in combat ===');
    await toShip();
    console.log(`  ${(await P(() => [0, 1, 2].map(() => window.__game.ctx.allies.devSetAndroid(true)))).join(' | ')}`);
    await launch();
    await waitFor(() => window.__game.ctx.allies.roster.every((e) => {
      const b = window.__game.ctx.allies.getBody(e.id); return !!b && !b.hidden;
    }), 'androids landed', 90000);
    await record('S4', '3 androids + a pulled group', async () => {
      await inFrame('pull12', `
        const p = ctx.player.position; const es = g.getSystem('enemies');
        let made = 0;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2; const r = 22 + (k % 4) * 2;
          if (es.debugSpawn(k % 3 === 0 ? 'warrior' : 'scavenger', { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r }, true)) made++;
        }
        return made;`);
      await waitSim(2);
    });
  }

  if (errors.length) { console.log('\npage errors:'); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); }
  if (flag('--keep-open')) { console.log('\n--keep-open: the browser stays up. Ctrl+C to end.'); await sleep(600000); }
} finally {
  await closeBrowser(browser);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, base: BASE, planet: PLANET, seed: SEED, windowS: WINDOW_S, env, results }, null, 1));
console.log(`\nwrote ${OUT}`);

console.log('\n| Scenario | Host p50 / p95 / max ms | Frames > 50 ms | Draw calls | Dominant cost |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  const top = r.marks.filter((m) => m.key[0] !== 'x').slice(0, 2).map((m) => `${m.key} ${fmt(m.perFrame, 2)}`).join(' · ');
  console.log(`| ${r.id} | ${fmt(r.frame.p50)} / ${fmt(r.frame.p95)} / ${fmt(r.frame.max)} | ${r.frame.over50} | ${r.draw.calls} | ${top} |`);
}
