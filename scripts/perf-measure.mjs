/**
 * The performance measurement harness (`docs/PERF.md`, perf Phase 0 … the last measurement). **Not a smoke** (`verify.mjs` only runs the files in its
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
 *     --only s1,s3a       scenarios to run (default s1,s2,s3a,s3b,s4; `s5a` · `s5b` need a relay — see below)
 *     --label <name>      log name (default: an ISO timestamp)
 *     --seconds <n>       length of each record window (default 20)
 *     --settle <n>        sim seconds between landing and the window (default 4)
 *     --headless          run headless anyway (the cadence is then not trustworthy)
 *     --keep-open         leave the browser up at the end
 *     --display k=v,…     apply `설정 › 화면 설정` before recording: `bloom` · `shadows` (0/1), `scale` (0.5…1).
 *                         The composer passes and the shadow map are part of the render block, so this is how a run
 *                         answers 「how much of `x:rendererRender` is the scene and how much is the post chain」.
 *     --alloc             count **allocation by owner** during each window. `docs/PERF.md` perf Phase C · B6 — S2
 *                         allocates 63-65 MB/s and its spike frames have everything slow at once, so the question is
 *                         「who makes the garbage」, which is a count, not a timing. The answer comes from the
 *                         **per-mark `performance.memory` delta** (`markAlloc`, and the typed-array census): B6
 *                         showed the V8 sampling heap profiler cannot see this churn at all — it samples what
 *                         **survives**, and reported 0.085 MB/s against the counter's 63. The CDP profile is still
 *                         taken for its call sites, but it is the weaker of the two numbers, not the answer. It also
 *                         costs time: a `--alloc` run's `ms` columns are **not** comparable with a plain one, and the
 *                         「`ms` is not evidence」 rule applies twice over.
 *     --peer-headful      show S5's second client instead of running it headless (debugging the squad flow)
 *     --out <path>        json path (default scripts/logs/perf/<label>.json)
 *
 * Scenarios: S1 idle · S2 60 bugs · S3a a burrow group in one frame · S3b the natural patrol
 * tick · S4 three androids in a fight · S6 (`--only s6`, TODO A-18 phase 2) S2's 60 bugs, spawned chasing, with the player inside a
 * building, so the flow fields · gates · wall climbs are all in use — read it against S2.
 *
 * **S5 (Phase D) — two humans through the relay.** `--only s5a` (idle) · `s5b` (+ 60 bugs) · `s5` (both, one raid).
 * It needs a **relay**: run `npm run dev:all` instead of `npm run dev`. The host is the same headful page every other
 * scenario uses, so its rows stay comparable with them; the second client is a second browser, headless on the same
 * GPU (`--peer-headful` to watch it). The peer's frame ms is **not** comparable with the host's — another window,
 * another presentation path — but its counters are, and the replica questions (A6 `ee spawn` · C1 `SoldierPool` ·
 * C3 `ally state`) are counter questions: how much wire arrives, how big one burst is, how many bodies get built.
 * When S5 is in the run the relay socket is **not** parked on any page, so a solo scenario in the same run has a
 * server profile behind it — run them apart if that matters.
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
/** S5 (Phase D) is the only scenario that uses the relay — and the only one whose page must keep its socket. */
const WANTS_RELAY = ONLY.some((o) => o === 's5' || o === 's5a' || o === 's5b' || o === 's5c');
/**
 * S5c recruits androids into the squad **before** the launch, so it cannot share a raid with S5a / S5b — those two
 * are 「two humans and nothing else」 by definition. Asking for both in one invocation is a mistake, not a choice.
 */
const S5_ANDROIDS = ONLY.includes('s5c');
if (S5_ANDROIDS && ONLY.some((o) => o === 's5' || o === 's5a' || o === 's5b')) {
  console.error('--only s5c cannot be combined with s5 / s5a / s5b: androids are recruited before the launch, so they '
    + 'would be in those windows too. Run `--only s5` and `--only s5c` separately.');
  process.exit(2);
}
const ALLOC = flag('--alloc');
const PLANET = opt('--planet', 'tundra');   // threat 2, as S1 asks for
const SEED = Number(opt('--seed', '7001'));
// A frame whose JS runs past one 60 Hz interval is a frame the player can lose — that is what gets an autopsy.
const SPIKE_MS = Number(opt('--spike', '16.7'));
/** `--display bloom=0,shadows=0,scale=0.75` → `{ bloom: false, shadows: false, scale: 0.75 }`, or null for 「leave it alone」. */
const DISPLAY = (() => {
  const raw = opt('--display', '');
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=');
    if (!k) continue;
    out[k.trim()] = k.trim() === 'scale' ? Number(v) : !(v === '0' || v === 'false' || v === 'off');
  }
  return out;
})();

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
    typedOrig: [], typedRows: new Map(), typedTotal: 0, typedNth: 0, audioBufOrig: null,
    allocByMark: false, markAlloc: {},
    frameMarks: {}, spikes: [], spikeMs: 16.7, spikeCap: 60,
    // Phase D (S5): the wire by message kind, and the remote-body pool. Both are counts, not timings.
    wire: { in: {}, out: {} }, wireWorst: null,
    wireFrame: { inN: 0, inB: 0, outN: 0, outB: 0, keys: {} }, wireFrameLast: null,
    pool: { acquires: 0, builds: 0, releases: 0 },
    /*
     * C1 is not a steady-state cost: a remote body is built when the avatar first appears, which is raid entry — on
     * the far side of the settle, outside every window. So the pool is counted for the page's **whole life** as well,
     * and `poolAll.worstMs` is the answer to 「what does one build cost on the frame it happens」.
     */
    poolAll: { acquires: 0, builds: 0, releases: 0, worstMs: 0 },
  };
  state.wireFrameLast = state.wireFrame;
  const addMark = (k, ms) => {
    state.marks[k] = (state.marks[k] || 0) + ms;
    state.counts[k] = (state.counts[k] || 0) + 1;
    // The worst single call matters more than the mean for the things that only fire on a spawn tick.
    if (!(state.worst[k] >= ms)) state.worst[k] = ms;
    state.frameMarks[k] = (state.frameMarks[k] || 0) + ms;
  };
  /*
   * 2026-09-20 (finding B6): allocation **by mark**, in `--alloc` runs only. The V8 sampling heap profiler keeps only
   * the samples whose object is still alive when the profile is taken, so it cannot see churn — it reported
   * 0.085 MB/s against `performance.memory`'s 64 MB/s on the same window. What can see churn is the same signal the
   * probe's `heap.allocMBPerS` already uses, read around each wrapped call instead of once per frame: a positive
   * `usedJSHeapSize` delta over a call is allocation that happened inside it. It is an upper bound per mark (another
   * mark's garbage can land in the window) and it misses everything under a GC, but summed over ~1 300 frames it is
   * enough to say **which system** makes the garbage — which is the whole question.
   */
  const heapOf = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
  const addAlloc = (k, bytes) => { if (bytes > 0) state.markAlloc[k] = (state.markAlloc[k] || 0) + bytes; };
  const wrap = (obj, key, label) => {
    if (!obj || typeof obj[key] !== 'function') return false;
    const orig = obj[key].bind(obj);
    obj[key] = function wrapped(...a) {
      if (!state.on) return orig(...a);
      const h = state.allocByMark ? heapOf() : 0;
      const t = performance.now();
      try { return orig(...a); } finally {
        addMark(label, performance.now() - t);
        if (state.allocByMark) addAlloc(label, heapOf() - h);
      }
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
  // TODO A-18 phase 2: the nav graph's own frame work — the bake at raid start, the re-measure and the **flow-field
  // builds** (`NAV_FLOW_BUDGET_MS` a frame while a field is due). A slice inside `u:world`. What the enemies spend
  // reading it is inside `u:enemies` and shows as S6 against S2.
  const navGraph = g.getSystem('world')?.navGraph;
  if (navGraph && wrap(navGraph, 'update', 'x:navUpdate')) wrapped.push('x:navUpdate');
  // …and the queries the movers make (enemies and androids — slices of `u:enemies` / `u:allies`): a private A*, the
  // 「can I walk straight there」 test every body asks each `ENEMY_NAV_CHECK_S`, and the field lookup. Each call is
  // microseconds against a 0.1 ms timer, so read them as totals over the window, never as a worst call.
  for (const [k, label] of [['findPath', 'x:navFindPath'], ['walkable', 'x:navWalkable'], ['flowTo', 'x:navFlowTo']]) {
    if (navGraph && wrap(navGraph, k, label)) wrapped.push(label);
  }
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

  /*
   * ── Phase D (S5): the wire, counted — not timed ───────────────────────────────────────────────────────────────
   * A6 asks 「is one `ee spawn` JSON per body a burst」 and C3 asks 「how big is `ally state`」. Both are counts, and
   * this plan's banner exists because a count was once answered with a `ms`. So: every frame the probe sums the
   * messages and bytes that crossed the socket, keyed by `t` (+ `ev`), and the window keeps the totals plus the
   * single worst inbound frame.
   *
   * Outbound goes through `WebSocket.prototype.send`. Inbound does **not** go through `addEventListener` —
   * `net/NetClient.ts` assigns `ws.onmessage` — so the probe replaces the prototype's `onmessage` accessor and wraps
   * whatever is assigned to it. The relay socket is the only live socket on a perf page (vite's HMR socket is parked
   * by `quiet-hmr.mjs`), so nothing has to be filtered out.
   *
   * `o:wireIn` is the one mark in this harness that is **not** inside `Engine.frame`: `onmessage` is a task of its
   * own between frames, so its cost never appears in `js/frame` — it appears as a late rAF. That is exactly the shape
   * a spawn burst has on a replica, which is why it gets a prefix of its own (`u:`/`l:` are systems, `x:`/`h:` are
   * slices inside them, `o:` is outside the frame entirely).
   */
  const wireKeyOf = (raw) => {
    if (typeof raw !== 'string' || raw.charCodeAt(0) !== 123) return 'binary';
    try {
      const m = JSON.parse(raw);
      const d = m && m.t === 'relay' && m.d ? m.d : m;     // the relay envelope is not the message
      if (!d || typeof d.t !== 'string') return '?';
      return typeof d.ev === 'string' ? d.t + ' ' + d.ev : d.t;
    } catch { return '?'; }
  };
  const addWire = (dir, key, bytes) => {
    const side = state.wire[dir];
    const row = side[key] || (side[key] = { n: 0, bytes: 0 });
    row.n++; row.bytes += bytes;
    const f = state.wireFrame;
    if (dir === 'in') { f.inN++; f.inB += bytes; f.keys[key] = (f.keys[key] || 0) + bytes; }
    else { f.outN++; f.outB += bytes; }
  };
  {
    const sendOrig = WebSocket.prototype.send;
    WebSocket.prototype.send = function probedSend(data) {
      if (state.on && typeof data === 'string') addWire('out', wireKeyOf(data), data.length);
      return sendOrig.call(this, data);
    };
    const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    if (desc && desc.set && desc.get) {
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        get() { return desc.get.call(this); },
        set(fn) {
          if (typeof fn !== 'function') { desc.set.call(this, fn); return; }
          desc.set.call(this, function probedMessage(ev) {
            if (!state.on) return fn.call(this, ev);
            const t = performance.now();
            try { return fn.call(this, ev); } finally {
              addMark('o:wireIn', performance.now() - t);
              if (typeof ev.data === 'string') addWire('in', wireKeyOf(ev.data), ev.data.length);
            }
          });
        },
      });
    }
  }
  /*
   * C1 — `SoldierPool.acquire`. The pool has existed since 2026-09-10; what was never measured is how often a raid
   * actually **builds** a body instead of taking a parked one, and what that build costs on the frame it happens.
   * A pop shrinks the pool and a build leaves it alone — that is the whole test, and it needs no change in `src/`.
   */
  const remoteSys = g.getSystem('remotePlayers');
  const pool = remoteSys && remoteSys.soldierPool;
  if (pool && typeof pool.acquire === 'function' && typeof pool.release === 'function') {
    const acqOrig = pool.acquire.bind(pool);
    pool.acquire = function countedAcquire(accent) {
      const parked = pool.size;
      const t = performance.now();
      const body = acqOrig(accent);
      const ms = performance.now() - t;
      const built = pool.size >= parked;               // nothing was popped → this body was built
      state.poolAll.acquires++;
      if (built) state.poolAll.builds++;
      if (ms > state.poolAll.worstMs) state.poolAll.worstMs = ms;
      if (state.on) {
        addMark('x:soldierAcquire', ms);
        state.pool.acquires++;
        if (built) state.pool.builds++;
      }
      return body;
    };
    const relOrig = pool.release.bind(pool);
    pool.release = function countedRelease(m) {
      state.poolAll.releases++;
      if (state.on) state.pool.releases++;
      return relOrig(m);
    };
    wrapped.push('x:soldierAcquire');
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
    // What crossed the socket since the previous frame: on a replica this is the traffic that made *this* frame late.
    const wf = state.wireFrame;
    if (wf.inB > (state.wireWorst ? state.wireWorst.inB : 0)) {
      state.wireWorst = { frame: state.frameIndex, inN: wf.inN, inB: wf.inB, keys: wf.keys };
    }
    state.wireFrameLast = wf;
    state.wireFrame = { inN: 0, inB: 0, outN: 0, outB: 0, keys: {} };
    const t0 = performance.now();
    rawFrame(now);
    const ms = performance.now() - t0;
    state.work.push(ms);
    // Spike autopsy: the mark breakdown of the frames that actually overran, which is what the stutter is made of.
    if (ms >= state.spikeMs && state.spikes.length < state.spikeCap) {
      state.spikes.push({ frame: state.frameIndex, ms, marks: state.frameMarks, wire: state.wireFrameLast });
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
      state.wire = { in: {}, out: {} }; state.wireWorst = null;
      state.wireFrame = { inN: 0, inB: 0, outN: 0, outB: 0, keys: {} }; state.wireFrameLast = state.wireFrame;
      state.pool = { acquires: 0, builds: 0, releases: 0 };
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
    /**
     * Count **typed-array and ArrayBuffer bytes** by owner (--alloc, finding B6). The V8 sampling heap profiler
     * attributes only on-heap size, so a `new Float32Array(100000)` shows up as its ~100-byte JS object and its
     * 400 KB backing store is invisible to it — while `performance.memory.usedJSHeapSize`, which the probe's
     * `heap.allocMBPerS` is built from, does count that store. Anything that reconciles the two has to count the
     * stores, so this wraps the constructors themselves.
     *
     * `new Float32Array(...)` resolves the **global** binding on every evaluation, so replacing the globals with a
     * construct-trapping Proxy catches module code without touching it. The proxy forwards `prototype`, so
     * `instanceof` and `ArrayBuffer.isView` keep working. Stacks are taken every 32nd allocation — a stack per
     * allocation would cost more than the thing being measured — and the reported bytes are the **real** total,
     * with only the attribution sampled.
     */
    allocTyped(on) {
      const NAMES = ['ArrayBuffer', 'Float32Array', 'Float64Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array',
        'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array'];
      if (!on) {
        for (const [name, Orig] of state.typedOrig) window[name] = Orig;
        state.typedOrig.length = 0;
        if (state.audioBufOrig) { AudioContext.prototype.createBuffer = state.audioBufOrig; state.audioBufOrig = null; }
        state.allocByMark = false;
        const rows = [...state.typedRows.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
        const byMark = Object.entries(state.markAlloc).sort((a, b) => b[1] - a[1]).map(([k, bytes]) => ({ mark: k, bytes }));
        return { total: state.typedTotal, rows: rows.map(([site, v]) => ({ site, bytes: v.bytes, calls: v.calls })), byMark };
      }
      state.typedOrig.length = 0; state.typedRows.clear(); state.typedTotal = 0; state.typedNth = 0;
      state.markAlloc = {}; state.allocByMark = true;
      for (const name of NAMES) {
        const Orig = window[name];
        if (typeof Orig !== 'function') continue;
        state.typedOrig.push([name, Orig]);
        window[name] = new Proxy(Orig, {
          construct(target, args, nt) {
            const o = Reflect.construct(target, args, nt);
            const bytes = o.byteLength || 0;
            state.typedTotal += bytes;
            if (bytes >= 1024 && (state.typedNth++ & 31) === 0) {
              // The first frame that is not this trap and not the constructor itself is the owner.
              const lines = String(new Error().stack || '').split(/\r?\n/).slice(2, 8);
              const hit = lines.find((l) => l.includes('/src/')) || lines.find((l) => l.includes('.js')) || lines[0] || '?';
              const site = hit.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+\//, '').replace(/\?[^)]*/, '');
              const row = state.typedRows.get(site) || { bytes: 0, calls: 0 };
              row.bytes += bytes * 32; row.calls += 32;   // one sample stands for 32 allocations
              state.typedRows.set(site, row);
            }
            return o;
          },
        });
      }
      /*
       * WebAudio buffers are off-heap too and are **not** made through any of the constructors above —
       * `createBuffer` hands back storage the audio engine owns, and `getChannelData()` wraps it. `src/audio` builds
       * every sound procedurally, several times a frame, so it is the one other thing that can move
       * `performance.memory` without showing in either counter.
       */
      const origCreate = AudioContext.prototype.createBuffer;
      state.audioBufOrig = origCreate;
      AudioContext.prototype.createBuffer = function (channels, length, rate) {
        const b = origCreate.call(this, channels, length, rate);
        const bytes = channels * length * 4;
        state.typedTotal += bytes;
        if ((state.typedNth++ & 31) === 0) {
          const lines = String(new Error().stack || '').split(/\r?\n/).slice(1, 8);
          const hit = lines.find((l) => l.includes('/src/')) || lines[0] || '?';
          const site = 'createBuffer ← ' + hit.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/]+\//, '').replace(/\?[^)]*/, '');
          const row = state.typedRows.get(site) || { bytes: 0, calls: 0 };
          row.bytes += bytes * 32; row.calls += 32;
          state.typedRows.set(site, row);
        }
        return b;
      };
      return NAMES.length;
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
        /*
         * 2026-09-20 (finding B4): how the AI LOD splits this scenario's list, sampled once at the end of the window.
         * Measured from the camera — in every solo scenario here that is the anchor that decides it
         * (`EnemySystem.collectAiAnchors` also counts players, androids, drones and the rover). The two distances
         * mirror `data/constants.csv` `ENEMY_AI_LOD_HALF_M` / `_QUARTER_M` and have to be kept in step by hand: this
         * file is a measurement harness, not game code, and reads nothing out of `src/`.
         */
        aiLod: (() => {
          const out = { near: 0, half: 0, quarter: 0 };
          if (!g.ctx.enemies) return out;
          const m = g.ctx.camera.matrixWorld.elements;
          for (const e of g.ctx.enemies.getEnemies()) {
            const dx = e.position.x - m[12], dy = e.position.y - m[13], dz = e.position.z - m[14];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 140 * 140) out.quarter++; else if (d2 > 70 * 70) out.half++; else out.near++;
          }
          return out;
        })(),
        /*
         * Phase D: this window's wire, by message kind. The per-second rows are what a squad costs the link; `worstIn`
         * is the single frame that was handed the most (a spawn burst, a keyframe) — A6's two questions exactly.
         */
        wire: (() => {
          const rows = (side) => Object.entries(side).map(([key, v]) => ({ key, n: v.n, bytes: v.bytes }))
            .sort((a, b) => b.bytes - a.bytes);
          const w = state.wireWorst;
          return {
            in: rows(state.wire.in), out: rows(state.wire.out),
            worstIn: w && {
              frame: w.frame, n: w.inN, bytes: w.inB,
              top: Object.entries(w.keys).sort((a, b) => b[1] - a[1]).slice(0, 4),
            },
          };
        })(),
        pool: {
          acquires: state.pool.acquires, builds: state.pool.builds, releases: state.pool.releases,
          parked: pool ? pool.size : -1, life: state.poolAll,
        },
        net: {
          connected: !!(g.ctx.net && g.ctx.net.connected),
          host: !!(g.ctx.net && g.ctx.net.isHost), inSession: !!(g.ctx.net && g.ctx.net.inSession),
          remotes: g.ctx.net ? g.ctx.net.getRemotePlayers().length : 0,
          rttMs: g.ctx.net ? Math.round(g.ctx.net.rttMs || 0) : 0,
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
  if (r.aiLod) console.log(`  ai lod    ${r.aiLod.near} full rate · ${r.aiLod.half} half · ${r.aiLod.quarter} quarter (by camera distance at the end of the window)`);
  if (r.net && r.net.connected) {
    console.log(`  net ${r.net.host ? 'HOST' : 'replica'} · in session ${r.net.inSession} · ${r.net.remotes} remote bodies · rtt ${r.net.rttMs} ms`);
    const L = r.pool.life ?? { acquires: 0, builds: 0, releases: 0, worstMs: 0 };
    console.log(`  soldier pool  in window ${r.pool.acquires} acquired (${r.pool.builds} built) · since boot ${L.acquires} acquired`
      + ` (${L.builds} built, ${L.releases} released, worst build ${fmt(L.worstMs, 2)} ms) · ${r.pool.parked} parked now`);
  }
  if (r.wire && (r.wire.in.length || r.wire.out.length)) {
    const per = Math.max(0.001, r.seconds);
    const kb = (b) => (b / 1024 / per).toFixed(1);
    const sum = (a) => a.reduce((t, x) => t + x.bytes, 0);
    const cnt = (a) => a.reduce((t, x) => t + x.n, 0);
    console.log(`  wire  in ${kb(sum(r.wire.in))} KB/s (${(cnt(r.wire.in) / per).toFixed(0)} msg/s) · out ${kb(sum(r.wire.out))} KB/s (${(cnt(r.wire.out) / per).toFixed(0)} msg/s)`);
    for (const row of r.wire.in.slice(0, 8)) {
      console.log(`    in  ${row.key.padEnd(18)} ${kb(row.bytes).padStart(7)} KB/s · ${String(row.n).padStart(6)} msgs · ${(row.bytes / row.n).toFixed(0)} B each`);
    }
    for (const row of r.wire.out.slice(0, 5)) {
      console.log(`    out ${row.key.padEnd(18)} ${kb(row.bytes).padStart(7)} KB/s · ${String(row.n).padStart(6)} msgs · ${(row.bytes / row.n).toFixed(0)} B each`);
    }
    if (r.wire.worstIn) {
      const w = r.wire.worstIn;
      console.log(`    worst inbound frame (${w.frame}): ${w.n} msgs · ${(w.bytes / 1024).toFixed(1)} KB · ${w.top.map(([k, b]) => `${k} ${(b / 1024).toFixed(1)} KB`).join(' · ')}`);
    }
  }
  for (const m of r.marks.filter((x) => x.perFrame >= 0.02).slice(0, 14)) {
    console.log(`    ${m.key.padEnd(22)} ${fmt(m.perFrame, 3).padStart(8)} ms/frame  (worst call ${fmt(m.worst, 2)} ms, ${fmt(m.total, 0)} ms total, ${m.calls} calls)`);
  }
  if (r.spikes && r.spikes.length) {
    console.log(`  spike frames (js over one vsync): ${r.spikes.length}${r.spikes.length >= 60 ? '+ (capped)' : ''}`);
    for (const sp of r.spikes.slice(0, 8)) {
      const w = sp.wire && sp.wire.inN ? ` · wire in ${sp.wire.inN} msgs / ${(sp.wire.inB / 1024).toFixed(1)} KB` : '';
      console.log(`    frame ${sp.frame}: js ${fmt(sp.ms)} ms · rAF delta ${fmt(sp.delta)} ms · ${sp.top.map(([k, v]) => `${k} ${fmt(v, 2)}`).join(' · ')}${w}`);
    }
  }
  for (const j of r.jobs ?? []) {
    if (!j || j.frame === undefined) continue;
    console.log(`    job ${j.name}: ${fmt(j.ms, 2)} ms in-frame · that frame's js ${fmt(j.frameWork, 2)} ms · worst rAF delta after ${fmt(j.deltaAfter)} ms`
      + `${j.error ? ' ERROR ' + j.error : ''}${j.result === undefined ? '' : ' → ' + JSON.stringify(j.result)}`);
  }
}


/* ── allocation by owner (--alloc, finding B6) ────────────────────────── */
/**
 * Fold a `HeapProfiler.getSamplingProfile` tree into one row per call site, `selfSize` summed. `selfSize` is the
 * sampled byte total attributed to that frame itself, so the rows answer 「which line allocates」 rather than 「which
 * line is on the stack」. Vite serves `src/` over http, so the urls come back as real file paths.
 */
function allocOwners(head) {
  const rows = new Map();
  const walk = (node) => {
    const f = node.callFrame ?? {};
    if (node.selfSize > 0) {
      const url = String(f.url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
      const key = `${f.functionName || '(anonymous)'} @ ${url || '(native)'}:${(f.lineNumber ?? -1) + 1}`;
      rows.set(key, (rows.get(key) || 0) + node.selfSize);
    }
    for (const c of node.children ?? []) walk(c);
  };
  walk(head);
  return [...rows.entries()].sort((a, b) => b[1] - a[1]);
}

/** Print the typed-array / ArrayBuffer byte owners of one window (`__perf.allocTyped`). */
function printTyped(t, seconds) {
  console.log(`  off-heap bytes by owner (typed arrays · WebAudio buffers) — ${(t.total / 1048576).toFixed(1)} MB in ${seconds.toFixed(1)}s (${(t.total / 1048576 / seconds).toFixed(1)} MB/s), attribution sampled 1 in 32:`);
  for (const r of t.rows.slice(0, 15)) {
    console.log(`    ${(r.bytes / 1048576).toFixed(2)} MB  ${String(r.calls).padStart(6)} calls  ${r.site}`);
  }
  if (t.byMark && t.byMark.length) {
    console.log('  heap growth by mark (upper bound — performance.memory read around each wrapped call):');
    for (const r of t.byMark.slice(0, 14)) {
      console.log(`    ${(r.bytes / 1048576 / seconds).toFixed(1).padStart(6)} MB/s  ${r.mark}`);
    }
  }
}

/** Print the top allocation owners of one window, as a share of the window's own total. */
function printAlloc(rows, seconds) {
  const total = rows.reduce((s, r) => s + r[1], 0);
  console.log(`  allocation by owner — ${(total / 1048576).toFixed(1)} MB sampled in ${seconds.toFixed(1)}s (${(total / 1048576 / seconds).toFixed(1)} MB/s):`);
  for (const [key, bytes] of rows.slice(0, 20)) {
    console.log(`    ${(bytes / 1048576).toFixed(2)} MB  ${((bytes / total) * 100).toFixed(1).padStart(4)} %  ${key}`);
  }
}

/* ── driver ──────────────────────────────────────────────────────────────── */
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  // Silence the speakers without changing what is measured: `--mute-audio` mutes Chrome's output stream while the page
  // still builds every WebAudio node, so `x:audioPlay` (A5 burrow · B5 bug footsteps) keeps its real cost. Turning the
  // in-game volume down instead would take those graphs out of the measurement.
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', '--no-sandbox'];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: HEADLESS, args: LAUNCH_ARGS });

/**
 * Everything the driver does to one page before it can be measured — the stubs, the boot wait, the rAF check, and the
 * three closures the scenarios drive it with. S5 needs a second client (Phase D), and a second client needs all of it,
 * so it stopped being inline.
 *
 * `parkRelay` is the one thing that differs by run: a solo scenario parks the relay socket so no server profile can
 * arrive mid-window, and S5 **is** the relay.
 */
async function makeClient(br, tag, { width, height, parkRelay, requireRaf = true }) {
  const page = (await br.pages())[0] ?? await br.newPage();
  await page.setViewport({ width, height });
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
  await quietViteHmr(page, { parkRelay });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitFor = async (fn, label, timeout = 60000, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${tag}: ${label}`);
  };
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
  if (requireRaf && advanced < 0.3) {
    throw new Error(`${tag}: the page is not running frames (ctx.time advanced ${advanced.toFixed(2)}s in 1s) — is the window visible?`);
  }
  return { tag, page, P, waitFor, waitSim, errors, simRate: advanced };
}

const results = [];
let env = {};
let peerBrowser = null;
try {
  const host = await makeClient(browser, 'host', { width: 1280, height: 720, parkRelay: !WANTS_RELAY });
  const { page, P, waitFor, waitSim, errors } = host;

  if (DISPLAY) {
    // `main.ts` is the only place that owns the Engine, and it applies these off the bus — same path the menu uses.
    await P((d) => {
      const g = window.__game;
      const cur = { bloom: g.isPostProcessing, shadows: g.hasShadows, scale: g.ctx.renderer.getPixelRatio() / (window.devicePixelRatio || 1) };
      g.ctx.bus.emit('ui:displayChanged', { ...cur, ...d });
    }, DISPLAY);
    await new Promise((r) => setTimeout(r, 500));
    console.log(`display override: ${JSON.stringify(DISPLAY)}`);
  }

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
  const toShip = async (c = host) => {
    await c.P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await c.waitFor(() => window.__game.ctx.phase === 'hub', 'hub', 120000);
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
  const cdp = ALLOC ? await page.createCDPSession() : null;
  if (cdp) await cdp.send('HeapProfiler.enable');

  /** `extra` = the other clients recorded over the same window (S5's replica) — one result row each. */
  const record = async (id, name, setup, extra = []) => {
    for (const c of [host, ...extra]) await c.P((ms) => window.__perf.start(ms), SPIKE_MS);
    await sleep(600);                    // keep the setup out of frame 0, whose cost is the window's own
    if (setup) await setup();
    // Both counters start **after** the setup so a one-off spawn burst is not charged to the steady state.
    if (cdp) await cdp.send('HeapProfiler.startSampling', { samplingInterval: 8192 });
    if (ALLOC) await P(() => window.__perf.allocTyped(true));
    await sleep(WINDOW_S * 1000);
    let alloc = null, typed = null;
    if (cdp) alloc = allocOwners((await cdp.send('HeapProfiler.stopSampling')).profile.head);
    if (ALLOC) typed = await P(() => window.__perf.allocTyped(false));
    for (const c of [host, ...extra]) await c.P(() => window.__perf.stop());
    const rep = await P(() => window.__perf.report());
    rep.id = id; rep.name = name;
    if (rep.phase !== 'playing') console.log(`  !! the raid ended during the window (phase ${rep.phase}) — these numbers are not the scenario`);
    if (alloc) rep.alloc = alloc.slice(0, 40).map(([site, bytes]) => ({ site, bytes }));
    if (typed) rep.allocTyped = { total: typed.total, rows: typed.rows.slice(0, 40) };
    results.push(rep);
    printScenario(rep);
    if (alloc) printAlloc(alloc, WINDOW_S);
    if (typed) printTyped(typed, WINDOW_S);
    for (const c of extra) {
      const sub = await c.P(() => window.__perf.report());
      sub.id = id; sub.name = `${name} (${c.tag})`; sub.role = c.tag;
      results.push(sub);
      console.log(`  ── ${c.tag} — the same window, seen from the other client ──`);
      printScenario(sub);
    }
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

  /*
   * TODO A-18 phase 2: the pathfinding counters of one window, so S2 and S6 read side by side — flow-field builds in the
   * window (count · avg · max ms, from the graph's cumulative stats diffed at both ends), and, sampled every frame, the
   * most private searches in one second, the most tokens one gate held, the most bodies in flow / path mode at once.
   * The max build ms is the raid's so far (the graph keeps no windowed max); the settle before a window has no bugs, so
   * it is the window's in practice.
   */
  const navWatch = async () => P(() => {
    const es = window.__game.getSystem('enemies'), ws = window.__game.getSystem('world');
    const f0 = ws.debugNav?.debugInfo().flow ?? null;
    const m = { plans: 0, tokens: 0, flow: 0, path: 0, waiting: 0, traversing: 0 };
    window.__navWatch = { f0, m, on: true };
    (function tick() {
      const w = window.__navWatch;
      if (!w || !w.on) return;
      const n = es.debugNav();
      w.m.plans = Math.max(w.m.plans, n.plansLastSecond); w.m.tokens = Math.max(w.m.tokens, 0, ...n.tokens);
      w.m.flow = Math.max(w.m.flow, n.flow); w.m.path = Math.max(w.m.path, n.path);
      w.m.waiting = Math.max(w.m.waiting, n.waiting); w.m.traversing = Math.max(w.m.traversing, n.traversing);
      requestAnimationFrame(tick);
    })();
  });
  const navRead = async (rep) => {
    const nav = await P(() => {
      const w = window.__navWatch; w.on = false;
      const g = window.__game.getSystem('world').debugNav?.debugInfo() ?? null;
      const f1 = g?.flow ?? null, f0 = w.f0;
      const b = f1 && f0 ? f1.builds - f0.builds : 0;
      const sum = f1 && f0 ? f1.avgMs * f1.builds - f0.avgMs * f0.builds : 0;
      return {
        builds: b, buildAvgMs: b > 0 ? sum / b : 0, buildMaxMs: f1?.maxMs ?? 0, lastNodes: f1?.lastNodes ?? 0, lastFrames: f1?.lastFrames ?? 0,
        fieldsLive: f1?.live ?? 0, max: w.m, end: window.__game.getSystem('enemies').debugNav(), graph: g,
      };
    });
    rep.nav = nav;
    console.log(`  nav: flow builds ${nav.builds} (avg ${fmt(nav.buildAvgMs, 2)} ms · max ${fmt(nav.buildMaxMs, 2)} ms · last ${nav.lastNodes} nodes over ${nav.lastFrames} frames) · fields live ${nav.fieldsLive}`);
    console.log(`       max at once: flow ${nav.max.flow} · path ${nav.max.path} · waiting ${nav.max.waiting} · traversing ${nav.max.traversing} · gate tokens ${nav.max.tokens} · private plans ${nav.max.plans}/s`);
  };

  if (ONLY.includes('s2')) {
    console.log('\n=== S2 — solo + 60 bugs in a ring at 25-40 m ===');
    await toShip(); await launch();
    const rep = await record('S2', '60 bugs alive', async () => { await inFrame('ring60', RING60); await waitSim(2); await navWatch(); });
    await navRead(rep);
  }

  /*
   * S6 (TODO A-18 phase 2) — S2's 60 bugs, but the player stands **inside a building** (floor 2 when it has one), so
   * no straight line to him is walkable: every body with a `nav` mask reads a flow field, the gates throttle the
   * doors, scavengers take the walls and windows, and the warriors stand outside as they always did. The row to read
   * it against is S2 — same bodies, same ring, same seed.
   */
  if (ONLY.includes('s6')) {
    console.log('\n=== S6 — solo + 60 bugs, the player inside a building (flow fields · gates in use) ===');
    await toShip(); await launch();
    const stand = await P(() => {
      const w = window.__game.ctx.world, ws = window.__game.getSystem('world');
      const rows = ws.structures.debugNav().filter((q) => q.kind !== 'wreck');
      const r = rows.find((q) => q.nav.stairTop) ?? rows[0];
      if (!r) return null;
      const nav = r.nav, c = Math.cos(nav.yaw), sn = Math.sin(nav.yaw);
      const l = nav.stairTop ?? nav.doorIn, y = nav.stairTop ? nav.levels[1] : nav.levels[0];
      const st = [nav.cx + l[0] * c - l[1] * sn, y, nav.cz + l[0] * sn + l[1] * c];
      const pl = window.__game.ctx.player;
      // The pin stops with the scenario (`__s6Hold = false` below) — a later scenario must not inherit it.
      window.__s6Hold = true;
      (function hold() { if (!window.__s6Hold) return; pl.position.set(st[0], st[1], st[2]); pl.velocity.set(0, 0, 0); requestAnimationFrame(hold); })();
      return { id: r.id, floor2: !!nav.stairTop, gates: w.nav?.gates.length ?? 0 };
    });
    if (!stand) console.log('  !! this seed has no enterable building — S6 skipped');
    else {
      console.log(`  standing in ${stand.id}${stand.floor2 ? ' (floor 2)' : ''} · ${stand.gates} gates`);
      await waitFor(() => window.__game.ctx.world.nav?.ready, 'nav ready', 60000);
      // The pin moved the camera into the building just now: its first frames there are the teleport's (a first look
      // indoors), not the scenario's — let them pass before the window opens.
      await waitSim(2);
      // Spawned already chasing: indoors no bug can see him, so S2's unaware ring would mostly wander and the window would
      // measure strollers, not sixty bodies routing through the doors (measured 2026-09-21: 5 in flow mode at most).
      const rep = await record('S6', '60 bugs chasing, player indoors', async () => { await inFrame('ring60chase', RING60.replace('}, false)', '}, true)')); await waitSim(2); await navWatch(); });
      await navRead(rep);
      await P(() => { window.__s6Hold = false; });
    }
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

  /*
   * ── S5 — two humans through the relay (Phase D) ────────────────────────────────────────────────────────────────
   * The squad is made by code, not by pods: `createLobby` (docked) + `joinLobby(code)` + `setReady` on both, then
   * `startGame`. The relay's own rule is host + everyone ready + a 목표 행성 (`server/RelayServer.ts` `lobby:start`);
   * the pod is only the hub's way of setting `ready`, and driving its hold gauge would measure the harness rather
   * than the game. A join **by code** is also immune to a stale public lobby left behind by an earlier run, which
   * quick match is not (`verify.mjs` restarts the relay for exactly that reason).
   *
   * S5a and S5b share one raid — S5b is S5a's window plus the same 60-bug ring S2 uses, so the two rows differ by
   * the bugs alone, and the `ring60` frame is one host `ee spawn` burst arriving at a replica (A6).
   *
   * S5c is a raid of its own: the leader recruits the cockpit bays into the squad (`setAndroidBay`) while still in the
   * shared ship, so the android bodies exist from the drop and `ally state` (C3) is on the wire. It is S5a's window
   * with androids in it — one comparison, one cost. The relay owns the cap (`NET_MAX_PLAYERS` 4 total, humans win),
   * so two humans leave room for two of the three bays; the run prints what it actually got.
   */
  if (WANTS_RELAY) {
    console.log('\n=== S5 — two humans through the relay ===');
    const health = await fetch('http://localhost:8787/health', { signal: AbortSignal.timeout(2500) })
      .then((r) => r.json()).catch(() => null);
    if (!health) throw new Error('S5 needs a relay on 8787 — run `npm run dev:all` (or `npm run server`) and try again');
    peerBrowser = await puppeteer.launch({ executablePath: CHROME, headless: !flag('--peer-headful'), args: LAUNCH_ARGS });
    const peer = await makeClient(peerBrowser, 'peer', { width: 960, height: 540, parkRelay: false });
    console.log(`  peer up (${flag('--peer-headful') ? 'headful' : 'headless'} 960x540, sim ${fmt(peer.simRate, 2)}x real time)`);
    console.log(`  peer probe: ${await peer.P(installProbe)}`);

    await toShip(host); await toShip(peer);
    await host.P(() => { window.__game.ctx.net.setPlayerName('호스트'); window.__game.ctx.net.ensureConnected(); });
    await peer.P(() => { window.__game.ctx.net.setPlayerName('분대원'); window.__game.ctx.net.ensureConnected(); });
    await host.waitFor(() => window.__game.ctx.net.connected, 'relay connect', 40000);
    await peer.waitFor(() => window.__game.ctx.net.connected, 'relay connect', 40000);

    await host.P(() => window.__game.ctx.net.createLobby());
    const code = await host.waitFor(() => window.__game.ctx.net.lobby?.code, 'lobby code', 20000);
    await host.waitFor(() => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship', 90000);
    await peer.P((c) => window.__game.ctx.net.joinLobby(c), code);
    await peer.waitFor(() => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship', 90000);
    await host.waitFor(() => (window.__game.ctx.net.lobby?.players ?? []).length === 2, 'two in the squad', 30000);
    console.log(`  squad ${code}: 2 humans in the shared ship`);

    await host.P((a) => {
      const ctx = window.__game.ctx;
      if (typeof ctx.hub?.setPlanet === 'function' && ctx.hub.setPlanet(a.planet) === true) return;
      ctx.net.setLobbyPlanet(a.planet);      // the 목표 행성 the relay refuses a raid without
    }, { planet: PLANET });
    await host.waitFor(() => window.__game.ctx.phase === 'hub' && !window.__game.ctx.hub?.travelling, 'travel finished', 60000).catch(() => null);
    if (S5_ANDROIDS) {
      await host.P(() => { for (let bay = 0; bay < 3; bay++) window.__game.ctx.net.setAndroidBay?.(bay, true); });
      await host.waitFor(() => (window.__game.ctx.net.lobby?.players ?? []).some((p) => p.bot), 'an android in the squad', 30000);
      await sleep(1500);                       // the relay answers one `lobby:state` per bay — let the last one land
      const bots = await host.P(() => (window.__game.ctx.net.lobby?.players ?? []).filter((p) => p.bot).length);
      console.log(`  androids recruited: ${bots} (the relay caps the squad at NET_MAX_PLAYERS, humans first)`);
    }
    await host.P((seed) => window.__game.ctx.net.setLobbySeed(seed), SEED);
    await host.P(() => window.__game.ctx.net.setReady(true));
    await peer.P(() => window.__game.ctx.net.setReady(true));
    // Humans only: an android is a relay **bot member** with no socket, so it carries no `ready` and the relay's own
    // `allReady` skips it (`server/Lobby.ts` — it counts connected members). S5c's lobby holds four players, two of them bots.
    await host.waitFor(() => {
      const p = (window.__game.ctx.net.lobby?.players ?? []).filter((x) => x.bot !== true);
      return p.length === 2 && p.every((x) => x.ready);
    }, 'both humans ready', 40000);
    await host.P((a) => window.__game.ctx.net.startGame(a.seed, 'raid', a.planet), { seed: SEED, planet: PLANET });
    for (const c of [host, peer]) {
      await c.waitFor(() => window.__game.ctx.phase === 'playing', 'playing', 180000);
      // Without a pod there is nothing to ride down — the wait is kept so the settle starts on the ground either way.
      await c.waitFor(() => !window.__game.ctx.player.isDropping, 'pod exit', 60000).catch(() => null);
      await c.P(() => window.__perf.keepAlive(true));
    }
    if (S5_ANDROIDS) {
      await host.waitFor(() => {
        const a = window.__game.ctx.allies;
        return a.roster.length > 0 && a.roster.every((e) => { const b = a.getBody(e.id); return !!b && !b.hidden; });
      }, 'androids landed', 90000);
    }
    await waitSim(SETTLE_S);
    const pair = await host.P(() => ({
      host: window.__game.ctx.net.isHost, remotes: window.__game.ctx.net.getRemotePlayers().length,
      seed: window.__game.ctx.world?.seed ?? null,
    }));
    console.log(`  in the raid: isHost ${pair.host} · ${pair.remotes} remote bodies · seed ${pair.seed}`);

    if (ONLY.includes('s5') || ONLY.includes('s5a')) {
      console.log('\n--- S5a — two humans, idle ---');
      await record('S5a', '2 humans, idle', null, [peer]);
    }
    if (ONLY.includes('s5') || ONLY.includes('s5b')) {
      console.log('\n--- S5b — two humans + 60 bugs ---');
      await record('S5b', '2 humans + 60 bugs', async () => { await inFrame('ring60', RING60); await waitSim(2); }, [peer]);
    }
    if (S5_ANDROIDS) {
      console.log('\n--- S5c — two humans + androids, idle (C3: `ally state` on the wire) ---');
      await record('S5c', '2 humans + androids, idle', null, [peer]);
    }
    if (peer.errors.length) { console.log('\npeer page errors:'); for (const e of peer.errors.slice(0, 10)) console.log(`  ${e}`); }
  }

  if (errors.length) { console.log('\npage errors:'); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); }
  if (flag('--keep-open')) { console.log('\n--keep-open: the browser stays up. Ctrl+C to end.'); await sleep(600000); }
} finally {
  if (peerBrowser) await closeBrowser(peerBrowser);
  await closeBrowser(browser);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ label: LABEL, base: BASE, planet: PLANET, seed: SEED, windowS: WINDOW_S, env, results }, null, 1));
console.log(`\nwrote ${OUT}`);

console.log('\n| Scenario | Host p50 / p95 / max ms | Replica p95 ms | Frames > 50 ms | Draw calls | Dominant cost |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  if (r.role) continue;                                   // a replica is a column of its host's row, not a row
  const replica = results.find((x) => x.id === r.id && x.role);
  const top = r.marks.filter((m) => m.key[0] !== 'x').slice(0, 2).map((m) => `${m.key} ${fmt(m.perFrame, 2)}`).join(' · ');
  console.log(`| ${r.id} | ${fmt(r.frame.p50)} / ${fmt(r.frame.p95)} / ${fmt(r.frame.max)} | ${replica ? fmt(replica.frame.p95) : '-'} | ${r.frame.over50} | ${r.draw.calls} | ${top} |`);
}
