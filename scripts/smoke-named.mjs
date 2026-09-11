// Single-player smoke test for the named rogues' C-batch fixes (2026-09-11, agent 4N):
//   C-55  the prone sniper's body is a lying capsule (air above the back misses, the legs hit, top-down ray lands low,
//         a tiny blast at 0.25 m catches it) — a standing rogue still has the vertical capsule
//   C-56  a buried muzzle (rock between body and muzzle) stops the shot at the rock: `enemy:shot hit:false` near the body,
//         no damage, cooldown still starts
//   C-49  a scan drone that arrives through a host promotion (no `namedData`) is adopted, not retired: alive, pulses 0,
//         `namedTimer` cleared, the sniper claims it
//   C-50  a replica heavy's tracer points at the inferred target (bearing cone) instead of straight along its yaw
//   C-54  replica hooks get the host: the replica heavy's first spin-up and the replica drone's hum play before any `ee`
// Drives `EnemySystem.debugSpawnNamed / debugSnapshot / debugApplySnapshot / setAuthority / replicaMgr.onEvent` — no relay.
// Usage: node scripts/smoke-named.mjs [http://localhost:5273/]   (needs a running vite)
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

/* Mirrored from the code (not contract values): `SniperLook` lying capsule, `Sniper.ts` EYE_UP, `ScanDrone.ts` PULSE_HINT_S. */
const PRONE_PIVOT_Y = 0.14, BACK = { z: -0.8, y: 0.2 }, FRONT = { z: 0.5, y: 0.3 }, PRONE_R = 0.25;
const EYE_UP = 0.32, PULSE_HINT_S = 0.6, HEAVY_TRACER = 0xffd27a;

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
    // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run (window.__game gone).
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['enemy:shot', 'audio:play']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica), 'single-player: enemies run as the authority');

  /* ── C-55: prone sniper hitbox ───────────────────────────────────────── */
  console.log('C-55 prone sniper body capsule');
  const spawned = await P(() => {
    const sys = window.__sys;
    sys.killAll();
    const e = sys.debugSpawnNamed('rogue_sniper');
    window.__sn = e;
    return e ? { id: e.id, type: e.type } : null;
  });
  ok(!!spawned && spawned.type === 'rogue_sniper', `debugSpawnNamed('rogue_sniper') → ${JSON.stringify(spawned)}`);
  await waitSim(0.5);
  // freeze the sniper's decisions: no shot, no drone, no relocation (hurt by the blast test)
  const freeze = () => P(() => { const d = window.__sn.namedData; if (d) { d.fireCooldown = 1e9; d.droneCooldown = 1e9; d.relocateCd = 1e9; d.relocate = 0; } return !!d; });
  ok(await freeze(), 'the sniper made its SniperData on the first tick');
  await waitFor(page, () => window.__sn.rig.named && window.__sn.rig.named.pose === 1, 'sniper prone', 30000);
  await waitSim(0.3);
  const hb = await P((c) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const e = window.__sn;
    const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw), rx = fz, rz = -fx;
    const s = e.anim.slopePitch, cs = Math.cos(s), sn = Math.sin(s);
    // axis height above the feet at local z (lying capsule, slope-rotated about the pelvis pivot) — the code's own model
    const axisAt = (z) => {
      const k = (z - c.BACK.z) / (c.FRONT.z - c.BACK.z);
      const y = c.BACK.y + (c.FRONT.y - c.BACK.y) * k - c.PRONE_PIVOT_Y;
      return { y: c.PRONE_PIVOT_Y + y * cs - z * sn, z: y * sn + z * cs };
    };
    const at = (z, dy, side) => { const a = axisAt(z); return new V(e.position.x + fx * a.z + rx * side, e.position.y + a.y + dy, e.position.z + fz * a.z + rz * side); };
    const lateral = (z, dy) => { const o = at(z, dy, 3); const d = new V(-rx, 0, -rz); return sys.raycast(o, d, 6); };
    const r = { pose: e.rig.named.pose, slope: s };
    const air = lateral(0.2, c.PRONE_R + 0.35);                                // over the back, well under the old 1.8 m capsule
    r.air = air ? { mine: air.enemy === e, part: air.part } : null;
    const leg = lateral(-0.7, 0);                                              // calves: 0.7 m behind the pelvis, outside the old r 0.4
    r.leg = leg ? { mine: leg.enemy === e, part: leg.part, ny: leg.normal.y, nDot: -(leg.normal.x * -rx + leg.normal.z * -rz), dist: leg.distance } : null;
    const top = at(-0.2, 3, 0);
    const down = sys.raycast(top, new V(0, -1, 0), 6);
    r.down = down ? { mine: down.enemy === e, dy: down.point.y - e.position.y, ny: down.normal.y, part: down.part } : null;
    // tiny blast at 0.25 m over the pelvis: reach = 0.15 + r 0.4 — only the lying body centre (≈0.25) is inside
    const hp0 = e.hp;
    sys.applyExplosion(new V(e.position.x, e.position.y + 0.25, e.position.z), 0.15, 5);
    r.blast = { hp0, hp1: e.hp };
    // a standing rogue far to the side keeps the vertical capsule
    const pp = ctx.player.position;
    const g = sys.debugSpawn('rogue', { x: pp.x - 70, z: pp.z + 70 }, false);
    if (g) {
      const o = new V(g.position.x + 3, g.position.y + 0.95, g.position.z);
      const h = sys.raycast(o, new V(-1, 0, 0), 6);
      r.stand = { mine: !!h && h.enemy === g };
      window.__guard = g;
    }
    return r;
  }, { PRONE_PIVOT_Y, BACK, FRONT, PRONE_R });
  ok(hb.pose === 1, `sniper fully prone (pose ${hb.pose}, slope ${hb.slope?.toFixed(3)})`);
  ok(!hb.air || !hb.air.mine, 'lateral ray 0.35 m above the lying back misses the sniper (the old vertical capsule hit it)', JSON.stringify(hb.air));
  ok(hb.leg && hb.leg.mine && hb.leg.part !== 'head', 'lateral ray through the calves (0.7 m behind the pelvis) hits the sniper body', JSON.stringify(hb.leg));
  ok(hb.leg && hb.leg.nDot > 0.8, `leg hit normal faces the shooter (${hb.leg?.nDot?.toFixed(2)})`);
  ok(hb.down && hb.down.mine && hb.down.dy < 0.75 && hb.down.ny > 0.5, `top-down ray lands on the back low and faces up (Δy ${hb.down?.dy?.toFixed(2)}, n.y ${hb.down?.ny?.toFixed(2)})`, JSON.stringify(hb.down));
  ok(hb.blast.hp1 < hb.blast.hp0, `blast at 0.25 m catches the lying body (hp ${hb.blast.hp0} → ${hb.blast.hp1})`);
  ok(hb.stand && hb.stand.mine, 'a standing rogue is still hit at 0.95 m (vertical capsule unchanged)', JSON.stringify(hb.stand));

  /* ── C-56: buried muzzle ─────────────────────────────────────────────── */
  console.log('C-56 buried muzzle');
  await freeze();
  const bur = await P((c) => {
    const ctx = window.__game.ctx; const e = window.__sn; const world = ctx.world; const V = window.__V;
    window.__ev['enemy:shot'].length = 0;
    const real = world.raycast;
    window.__bodyRays = 0;
    // a "rock" 0.8 m in front of the body: only the body → muzzle segment sees it
    world.raycast = function (o, d, max) {
      if (Math.abs(o.x - e.position.x) < 1e-4 && Math.abs(o.z - e.position.z) < 1e-4 && Math.abs(o.y - (e.position.y + c.EYE_UP)) < 1e-4 && max < 4) {
        window.__bodyRays++;
        return { point: new V(o.x + d.x * 0.8, o.y + d.y * 0.8, o.z + d.z * 0.8), normal: new V(-d.x, -d.y, -d.z), distance: 0.8 };
      }
      return real.call(this, o, d, max);
    };
    window.__realRaycast = real;
    const p = ctx.player;
    const d = e.namedData;
    d.aimTargetId = 'local'; d.aimScanned = false; d.glintLeft = 0.05; d.fireCooldown = 0;
    return { hp: p.hp, shield: p.shield ?? 0 };
  }, { EYE_UP });
  await waitFor(page, () => window.__ev['enemy:shot'].some((s) => s.id === window.__sn.id), 'sniper shot', 20000);
  const bur2 = await P(() => {
    const ctx = window.__game.ctx; const e = window.__sn;
    ctx.world.raycast = window.__realRaycast;
    const s = window.__ev['enemy:shot'].find((x) => x.id === e.id);
    const d = e.namedData;
    const dist = (v) => Math.hypot(v[0] - e.position.x, v[2] - e.position.z);
    const r = { hit: s.hit, fromD: dist(s.from), toD: dist(s.to), cd: d.fireCooldown, glint: d.glintLeft, bodyRays: window.__bodyRays, hp: ctx.player.hp, shield: ctx.player.shield ?? 0 };
    d.fireCooldown = 1e9;
    return r;
  });
  ok(bur2.bodyRays >= 1, `fire() checks the body → muzzle segment (${bur2.bodyRays} ray)`);
  ok(bur2.hit === false && bur2.toD < 1.2 && bur2.fromD < 1.2, `a buried muzzle stops the shot at the rock (hit ${bur2.hit}, from ${bur2.fromD.toFixed(2)} m · to ${bur2.toD.toFixed(2)} m from the body — a clear muzzle is ≈2.3 m)`);
  ok(bur2.hp === bur.hp && bur2.shield === bur.shield, `no damage reaches the player (hp ${bur.hp} → ${bur2.hp}, shield ${bur.shield} → ${bur2.shield})`);
  ok(bur2.cd > 3 && bur2.glint <= 0, `the telegraphed shot still spends the glint and starts the cooldown (${bur2.cd.toFixed(2)} s)`);

  /* ── C-49: scan drone adopted through a host promotion ───────────────── */
  console.log('C-49 scan drone adoption on promotion');
  await freeze();
  const key = await P(() => window.__sys.debugSnapshot(true));
  await P(() => window.__sys.setAuthority(false));
  await waitSim(0.2);
  const DRONE_ID = 92001;
  const rep = await P((a) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const e = window.__sn;
    window.__ev['audio:play'].length = 0;
    const live = a.key.e.filter((w) => w.st !== 'dead');
    const y = e.position.y + 24;
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 7000, full: true, e: [...live, { id: a.id, ty: 'rogue_scan_drone', p: [e.position.x + 2, y, e.position.z + 2], yaw: 0, hp: 60, st: 'chase', a: 20 }] });
    const dr = sys.find(a.id);
    return { replica: sys.replica, created: !!dr && dr.active && dr.type === 'rogue_scan_drone', data: dr ? dr.namedData : 'x' };
  }, { key, id: DRONE_ID });
  ok(rep.replica && rep.created, 'replica keyframe creates the scan drone');
  ok(rep.data === null, 'a replica-born drone carries no namedData (host-only)');
  await waitSim(2.1);
  const rep2 = await P((id) => {
    const dr = window.__sys.find(id);
    const hums = window.__ev['audio:play'].filter((x) => x.id === 'scan_drone_hum').length;
    return { timer: dr ? dr.namedTimer : -1, y: dr ? dr.position.y : 0, hums };
  }, DRONE_ID);
  ok(rep2.timer > 5, `the replica hook parks last frame's height in namedTimer (${rep2.timer.toFixed(1)}) — the trap C-49 must clear`);
  ok(rep2.hums >= 1, `C-54: the replica drone hums through the passed host (${rep2.hums} scan_drone_hum)`);
  // a real promotion: the sniper was a replica too → no SniperData either
  await P(() => { window.__sn.namedData = null; window.__sys.setAuthority(true); });
  await waitSim(0.35);
  await freeze();
  const prom = await P((id) => {
    const dr = window.__sys.find(id); const e = window.__sn;
    const d = dr ? dr.namedData : null; const sd = e.namedData;
    return {
      alive: !!dr && dr.active && dr.state !== 'flee' && dr.state !== 'dead', state: dr ? dr.state : '',
      kind: d ? d.kind : null, pulses: d ? d.pulses : -1, sniperId: d ? d.sniperId : null, timer: dr ? dr.namedTimer : -1,
      phase: dr ? dr.namedPhase : -1, snId: e.id, droneId: sd ? sd.droneId : 'none', claimed: d ? d.claimed : null,
    };
  }, DRONE_ID);
  ok(prom.alive, `after promotion the drone is still flying (state ${prom.state})`);
  ok(prom.kind === 'scanDrone' && prom.pulses === 0 && prom.phase === 0, `it was adopted with a fresh scan (kind ${prom.kind}, pulses ${prom.pulses}, phase ${prom.phase})`);
  ok(prom.timer <= PULSE_HINT_S, `namedTimer cleared on adoption (${prom.timer.toFixed(2)} ≤ ${PULSE_HINT_S})`);
  ok(prom.sniperId === prom.snId && prom.droneId === DRONE_ID && prom.claimed === true, `the nearest sniper owns and claims it (sniperId ${prom.sniperId}, SniperData.droneId ${prom.droneId}, claimed ${prom.claimed})`);
  await waitSim(1.5);
  const prom2 = await P((id) => { const dr = window.__sys.find(id); return { alive: !!dr && dr.active && dr.state !== 'flee' && dr.state !== 'dead', hint: dr ? dr.namedHint : -1, pulses: dr && dr.namedData ? dr.namedData.pulses : -1 }; }, DRONE_ID);
  ok(prom2.alive && prom2.pulses <= 1, `1.5 s later it is still out scanning (pulses ${prom2.pulses}, hint ${prom2.hint})`);

  /* ── C-50 / C-54: replica heavy tracer ───────────────────────────────── */
  console.log('C-50 replica heavy tracer · C-54 first spin-up');
  const key2 = await P(() => { const sys = window.__sys; sys.killAll(); return sys.debugSnapshot(true); });
  await P(() => window.__sys.setAuthority(false));
  await waitSim(0.2);
  const HEAVY_ID = 93001, BUG_ID = 93002;
  const setup = await P(async (a) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world;
    const { FxManager } = await import('/src/core/fx/index.ts');
    const fx = FxManager.get();
    window.__tracers = [];
    if (fx && !fx.tracers.__spied) {
      const add = fx.tracers.add.bind(fx.tracers);
      fx.tracers.add = (from, to, color, ...rest) => { if (color === a.color) window.__tracers.push({ from: [from.x, from.y, from.z], to: [to.x, to.y, to.z] }); return add(from, to, color, ...rest); };
      fx.tracers.__spied = true;
    }
    window.__ev['audio:play'].length = 0;
    const pp = ctx.player.position;
    // heavy 20 m east of the player, facing further east (player behind it, outside the cone)
    const hx = pp.x + 20, hz = pp.z;
    const yaw = Math.PI / 2;
    const bear = yaw + 0.25;                        // bug 15 m out, 0.25 rad off the heavy's yaw — inside the fire cone
    const bx = hx + Math.sin(bear) * 15, bz = hz + Math.cos(bear) * 15;
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 8000, full: true, e: [
      { id: a.heavy, ty: 'rogue_heavy', p: [hx, world.getHeightAt(hx, hz), hz], yaw, hp: 1680, st: 'chase', a: 19 },
      { id: a.bug, ty: 'warrior', p: [bx, world.getHeightAt(bx, bz), bz], yaw: yaw + Math.PI, hp: 640, st: 'chase', a: 0 },
    ] });
    const h = sys.find(a.heavy), b = sys.find(a.bug);
    return { fx: !!fx, heavy: !!h && h.type === 'rogue_heavy', bug: !!b && b.faction === 'bug' };
  }, { heavy: HEAVY_ID, bug: BUG_ID, color: HEAVY_TRACER });
  ok(setup.fx && setup.heavy && setup.bug, `replica heavy + bug created, tracer spy on (${JSON.stringify(setup)})`);
  await waitSim(0.4);
  const spin = await P(() => ({ spinups: window.__ev['audio:play'].filter((x) => x.id === 'minigun_spinup').length, tracers: window.__tracers.length }));
  ok(spin.spinups >= 1, `C-54: hint 19 alone (no ee spray yet) plays minigun_spinup on the replica (${spin.spinups})`);
  ok(spin.tracers === 0, `no tracers before ee spray (${spin.tracers})`);
  await P((id) => { window.__tracers.length = 0; window.__sys.replicaMgr.onEvent({ t: 'ee', ev: 'spray', id, on: 1 }); }, HEAVY_ID);
  await waitSim(0.5);
  const aim1 = await P((a) => {
    const sys = window.__sys; const h = sys.find(a.heavy); const b = sys.find(a.bug); const V = window.__V;
    const m = h.muzzle(new V());
    const chest = new V(b.position.x, b.position.y + b.stats.height * 0.6, b.position.z);
    const want = Math.atan2(chest.x - m.x, chest.z - m.z);
    const errs = window.__tracers.map((t) => { const dx = t.to[0] - t.from[0], dz = t.to[2] - t.from[2]; const d = Math.atan2(dx, dz) - want; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); });
    const yawErr = window.__tracers.map((t) => { const d = Math.atan2(t.to[0] - t.from[0], t.to[2] - t.from[2]) - h.yaw; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); });
    return { n: errs.length, maxErr: errs.length ? Math.max(...errs) : -1, meanYawOff: yawErr.length ? yawErr.reduce((s, x) => s + x, 0) / yawErr.length : -1, want, yaw: h.yaw };
  }, { heavy: HEAVY_ID, bug: BUG_ID });
  ok(aim1.n >= 2, `the replica sprays tracers after ee spray on (${aim1.n})`);
  ok(aim1.n >= 2 && aim1.maxErr < 0.13, `tracers point at the inferred bug target (max bearing error ${aim1.maxErr.toFixed(3)} rad, spread 0.07)`);
  ok(aim1.n >= 2 && aim1.meanYawOff > 0.15, `…not straight along the heavy's yaw (mean ${aim1.meanYawOff.toFixed(3)} rad off yaw)`);
  // no candidate in the cone → falls back to the yaw
  await P((a) => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    sys.debugApplySnapshot({ t: 'es', time: ctx.time, seq: 8001, full: false, e: [], gone: [a.bug] });
    const b = sys.find(a.bug); if (b && b.state !== 'dead') b.state = 'dead';
    window.__tracers.length = 0;
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spray', id: a.heavy, on: 1 });
  }, { heavy: HEAVY_ID, bug: BUG_ID });
  await waitSim(0.5);
  const aim2 = await P((id) => {
    const h = window.__sys.find(id);
    const off = window.__tracers.map((t) => { const d = Math.atan2(t.to[0] - t.from[0], t.to[2] - t.from[2]) - h.yaw; return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); });
    return { n: off.length, max: off.length ? Math.max(...off) : -1 };
  }, HEAVY_ID);
  ok(aim2.n >= 2 && aim2.max < 0.12, `with nobody in the cone the tracers follow the yaw (${aim2.n} tracers, max ${aim2.max.toFixed(3)} rad off)`);
  await P((id) => window.__sys.replicaMgr.onEvent({ t: 'ee', ev: 'spray', id, on: 0 }), HEAVY_ID);
  await P(() => window.__sys.setAuthority(true));
  await waitSim(0.2);
  ok(await P(() => window.__sys.isAuthority), 'authority restored');

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
