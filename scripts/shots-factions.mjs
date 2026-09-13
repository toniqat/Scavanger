// Look check for the humanoid factions (2026-09-13): rogue · rogue_boss · android · raider side by side.
// Starts a raid, spawns the four with `EnemySystem.debugSpawn` ~100 m away from the player (out of sight / hearing),
// puts them on one faction **in this throwaway page only** (every faction pair is hostile — side by side they would
// shoot each other and the hit flash whitens the models), pins them in place facing the camera every frame, and takes
// screenshots through `PlayerRef.setCameraOverride`: close (≈5 m), wide (≈11 m), far (≈50 m — the silhouette-at-range
// check) and a 4× enlargement of the far shot's centre (same pixels, just easier to look at).
// Nothing is asserted — the PNGs are for a human to look at. Errors on the page are printed and fail the exit code.
// Usage: node scripts/shots-factions.mjs [--url http://localhost:5273/]   (needs a running vite)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const urlFlag = argv.findIndex((a) => a === '--url');
const BASE = (urlFlag >= 0 ? argv[urlFlag + 1] : undefined)
  ?? argv.find((a) => a.startsWith('--url='))?.slice(6)
  ?? argv.find((a) => a.startsWith('http'))
  ?? 'http://localhost:5273/';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'logs');
mkdirSync(OUT, { recursive: true });
const SHOTS = {
  close: join(OUT, 'factions-look-close.png'),
  wide: join(OUT, 'factions-look.png'),
  far: join(OUT, 'factions-look-far.png'),
  farZoom: join(OUT, 'factions-look-far-zoom.png'),
};
const TYPES = ['rogue', 'rogue_boss', 'android', 'raider'];
const W = 1280, H = 720;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${W},${H}`, '--no-sandbox'],
});
const errors = [];
let code = 0;
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: W, height: H });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
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
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitSim(0.5);

  const spawned = await P((types) => {
    const ctx = window.__game.ctx;
    const sys = window.__game.getSystem('enemies');
    const V = ctx.camera.position.constructor;
    const pp = ctx.player.position;
    const world = ctx.world;
    const ground = (x, z) => (world.getSurfaceY ? world.getSurfaceY(x, z, world.getHeightAt(x, z) + 1) : world.getHeightAt(x, z));
    // lineup 100 m from the player, toward the map centre (stays on the map, out of every sight / hearing radius)
    const len = Math.hypot(pp.x, pp.z);
    const dir = len > 1 ? new V(-pp.x / len, 0, -pp.z / len) : new V(1, 0, 0);
    const centre = new V(pp.x + dir.x * 100, 0, pp.z + dir.z * 100);
    const right = new V(dir.z, 0, -dir.x);
    const yaw = Math.atan2(-dir.x, -dir.z);   // facing = (sin yaw, cos yaw) → face back toward the camera side
    const pins = [];
    types.forEach((type, i) => {
      const off = (i - (types.length - 1) / 2) * 1.7;
      const x = centre.x + right.x * off, z = centre.z + right.z * off;
      const e = sys.debugSpawn(type, { x, z }, false);
      if (!e) return;
      pins.push({ e, x, z });
      // throwaway page only: one faction, so the four do not open fire on each other (every faction pair is hostile)
      try { e.stats.faction = 'rogue'; } catch { /* frozen stats — they may fight, the shots still come out */ }
    });
    const pin = () => {
      for (const p of pins) {
        p.e.position.set(p.x, ground(p.x, p.z), p.z);
        p.e.yaw = window.__look.yaw;
        if (p.e.velocity?.set) p.e.velocity.set(0, 0, 0);
      }
    };
    window.__look = { centre: [centre.x, ground(centre.x, centre.z), centre.z], dir: [dir.x, 0, dir.z], yaw, cam: null, lookAt: null };
    const orig = sys.update.bind(sys);
    sys.update = (...args) => {   // forward every argument (the engine passes ctx too)
      pin();
      orig(...args);
      pin();
      const L = window.__look;
      if (L.cam) ctx.player.setCameraOverride(new V(...L.cam), new V(...L.lookAt), true);
    };
    window.__lookGround = ground;
    const hud = document.getElementById('ui-root');
    if (hud) hud.style.visibility = 'hidden';
    return pins.map((p) => p.e.type);
  }, TYPES);
  console.log(`spawned: ${spawned.join(', ')}`);
  if (spawned.length !== TYPES.length) { console.log('  FAIL not every type spawned'); code = 1; }

  const place = (dist, height, lookY) => P(({ dist, height, lookY }) => {
    const L = window.__look;
    const ctx = window.__game.ctx;
    const V = ctx.camera.position.constructor;
    const [cx, cy, cz] = L.centre;
    // try bearings around the lineup (the base one first) until the sight line clears props too — a crystal or a
    // spire between the camera and the lineup would otherwise fill the far shot. The lineup turns to face the camera.
    let bx = L.dir[0], bz = L.dir[2];
    if (dist > 20 && ctx.world?.raycast) {
      const base = Math.atan2(L.dir[0], L.dir[2]);
      for (let k = 0; k < 18; k++) {
        const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 9);
        const dx = Math.sin(a), dz = Math.cos(a);
        const ox = cx - dx * dist, oz = cz - dz * dist;
        const o = new V(ox, Math.max(window.__lookGround(ox, oz), cy) + height, oz);
        const t = new V(cx, cy + lookY, cz);
        const d = t.clone().sub(o); const len = d.length(); d.normalize();
        const hit = ctx.world.raycast(o, d, len - 1.5);
        if (!hit) { bx = dx; bz = dz; break; }
      }
    }
    L.yaw = Math.atan2(-bx, -bz);
    const x = cx - bx * dist, z = cz - bz * dist;
    // above the terrain under the camera and the lineup, and high enough that the sight line to the lineup clears
    // every terrain sample in between (a hill between the two must neither bury the camera nor hide the lineup)
    const ty = cy + lookY;
    let y = Math.max(window.__lookGround(x, z), cy) + height;
    for (let i = 1; i < 20; i++) {
      const t = i / 20;
      const g = window.__lookGround(x + (cx - x) * t, z + (cz - z) * t) + 0.6;
      y = Math.max(y, (g - ty * t) / (1 - t));
    }
    L.cam = [x, y, z];
    L.lookAt = [cx, cy + lookY, cz];
  }, { dist, height, lookY });
  const shoot = async (name, dist, height, lookY, clip) => {
    await place(dist, height, lookY);
    await waitSim(1.2);
    await page.screenshot({ path: SHOTS[name], ...(clip ? { clip } : {}) });
    console.log(`  ${name}: ${SHOTS[name]}`);
  };
  await shoot('close', 5.2, 1.3, 0.95);
  await shoot('wide', 11, 1.8, 0.9);
  await shoot('far', 50, 1.8, 0.9);
  await shoot('farZoom', 50, 1.8, 0.9, { x: W / 2 - W / 8, y: H / 2 - H / 8, width: W / 4, height: H / 4, scale: 4 });
} catch (e) {
  console.error(String(e?.stack ?? e));
  code = 1;
} finally {
  if (errors.length) { console.log(`page errors (${errors.length}):`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); code = 1; }
  await browser.close();
}
process.exit(code);
