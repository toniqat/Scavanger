// Single-player smoke test for Phase 7 §6 (enemies): rogue AI v2 — LOS-validated cover, magazine + reload cycle,
// grenade toss after the LOS hold — plus the behemoth at BEHEMOTH_SCALE 3, the live authority round-trip
// (setAuthority false / true keeps the enemy count and resumes the AI) and the training gate (no spawning).
// Usage: node scripts/smoke-rogue-v2.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
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
    try { localStorage.setItem('scav.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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
    for (const n of ['enemy:shot', 'enemy:attacked', 'enemy:spawned', 'audio:play', 'camera:shake', 'enemy:waveStarted']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  /** Poll `fn(arg)` every 50 ms of wall time until it returns truthy or `sec` seconds of simulation time pass. */
  const untilSim = async (fn, sec, arg) => {
    const t0 = await P(() => window.__game.ctx.time);
    return waitFor(page, (a) => { const v = (0, eval)(a.src)(a.arg); return v || window.__game.ctx.time >= a.t; }, `poll or sim +${sec}s`, 600000, { src: `(${fn.toString()})`, arg, t: t0 + sec });
  };
  const constants = await P(() => {
    // read the shared constants through the enemy system's imports is not possible; mirror the contract values here
    return { MAG: 12, RELOAD: 2.0, HOLD: 3, WINDUP: 0.6, FUSE: 2.5, RADIUS: 4.5, RANGE: 28, DAMAGE: 45, SCALE: 3, FLANK: 10 };
  });

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica), 'single-player: enemies run as the authority');

  /* ── behemoth at BEHEMOTH_SCALE 3 ─────────────────────────────────────── */
  console.log('behemoth (BEHEMOTH_SCALE 3)');
  const beh = await P((c) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const pp = ctx.player.position;
    const b = sys.debugSpawn('behemoth', { x: pp.x + 40, z: pp.z }, false);
    if (!b) return null;
    b.yaw = Math.atan2(pp.x - b.position.x, pp.z - b.position.z);   // face the player (facing = +sin yaw, +cos yaw)
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    // ray from in front of it (the player's side) travelling against its facing, at plate height
    const o = new V(b.position.x + fx * 20, b.position.y + b.stats.height * 0.55, b.position.z + fz * 20);
    const d = new V(-fx, 0, -fz);
    const front = sys.raycast(o, d, 40);
    // from behind, travelling the way it faces
    const o2 = new V(b.position.x - fx * 20, b.position.y + b.stats.height * 0.5, b.position.z - fz * 20);
    const d2 = new V(fx, 0, fz);
    const rear = sys.raycast(o2, d2, 40);
    const w = sys.debugSpawn('warrior', { x: pp.x + 40, z: pp.z + 10 }, false);
    const r = { id: b.id, radius: b.stats.radius, height: b.stats.height, headR: b.stats.headRadius, scale: b.rig.baseScale, paramHead: b.rig.params.head.r, warriorHead: w ? w.rig.params.head.r : -1, plateR: b.plateRadius,
      front: front ? { part: front.part, armored: !!front.armored, dist: front.distance } : null, rear: rear ? { part: rear.part, armored: !!rear.armored } : null };
    b.kill(false);
    if (w) w.kill(false);
    return r;
  }, constants);
  ok(!!beh, 'behemoth spawned via debugSpawn', JSON.stringify(beh));
  ok(beh && Math.abs(beh.radius - 0.8 * 3) < 1e-6 && Math.abs(beh.height - 1.6 * 3) < 1e-6 && Math.abs(beh.headR - 0.36 * 3) < 1e-6, `stats scale with BEHEMOTH_SCALE 3 (radius ${beh?.radius}, height ${beh?.height}, head ${beh?.headR})`);
  ok(beh && Math.abs(beh.paramHead - beh.warriorHead * 3) < 1e-6, `rig params = warrior × 3 through BugParams (head r ${beh?.paramHead} vs warrior ${beh?.warriorHead}; bug rigs bake the scale, baseScale ${beh?.scale})`);
  ok(beh && beh.front && beh.front.part === 'front' && beh.front.armored, 'front ray hits the armoured plate (part front, armored)', JSON.stringify(beh?.front));
  ok(beh && beh.rear && beh.rear.part === 'rear' && !beh.rear.armored, 'rear ray hits the rear (×2, not armoured)', JSON.stringify(beh?.rear));

  /* ── cover selection: every chosen cover blocks LOS ────────────────────── */
  console.log('rogue cover (LOS-validated, flank scored)');
  /*
   * The cluster is picked at random, so a single draw can land on rocks the rogue genuinely cannot use (too far
   * apart for a 16 m search, outside its leash, no flank with a line to the player). 2026-09-08: try up to three
   * clusters and keep the first that produces a pick — a broken cover cycle still fails all three, so the assertion
   * below is as strong as it was, it just no longer depends on one lucky draw.
   */
  const placeCluster = () => P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    const pp = ctx.player.position;
    // find a rock cluster: an obstacle with >= 2 other usable obstacles within 14 m, at least 60 m from the spawn
    let best = null;
    for (let k = 0; k < 400 && !best; k++) {
      const x = (Math.random() - 0.5) * 300, z = (Math.random() - 0.5) * 300;
      if (!world.isInsideBounds(x, z) || Math.hypot(x - pp.x, z - pp.z) < 60) continue;
      // 2026-09-08: measure the cylinder rays stop at (`shotRadius` / `shotHeight` since the 바위 엄폐 fix),
      // the same one `RogueCover` filters on — the movement collider is narrower and taller than the rock.
      const br = (o) => (o.shotRadius !== undefined && o.shotRadius > o.radius ? o.shotRadius : o.radius);
      const bh = (o) => (o.shotHeight !== undefined && o.shotHeight > 0 ? o.shotHeight : o.height);
      const obs = world.getObstaclesNear(x, z, 14).filter((o) => br(o) >= 0.5 && bh(o) >= 1.2);
      if (obs.length >= 3) best = { x, z, n: obs.length };
    }
    if (!best) return null;
    for (const e of sys.active) if (e.active && e.kind === 'rogue' && e.state !== 'dead') e.kill(false);
    // player on the cluster's edge, rogue 12 m across it
    const py = world.getHeightAt(best.x + 9, best.z);
    ctx.player.spawnStanding(new V(best.x + 9, py, best.z), Math.PI / 2);
    ctx.player.hp = ctx.player.maxHp;
    const r = sys.debugSpawn('rogue', { x: best.x - 8, z: best.z }, false);
    if (!r) return null;
    r.aware = true; r.state = 'chase'; r.stateTime = 0; r.roguePhase = 0; r.grenadeCd = 999;
    for (const e of sys.active) if (e !== r && e.active && e.state !== 'dead') { e.aware = false; }
    return { id: r.id, cluster: best };
  });

  let setup = null;
  const covers = [];
  for (let attempt = 0; attempt < 3 && covers.length === 0; attempt++) {
    setup = await placeCluster();
    if (!setup) break;
    const seen = new Set();
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const s = await P((id) => {
        const e = window.__sys.active.find((x) => x.id === id);
        const ctx = window.__game.ctx;
        ctx.player.hp = ctx.player.maxHp;
        if (!e) return null;
        // Keep it hunting: the cover cycle only runs while the rogue has a live target, and a rogue that loses
        // awareness behind the rocks drops to 'alert' / 'wander' and picks no cover at all for the rest of the window.
        e.aware = true;
        if (e.state !== 'chase' && e.state !== 'attack' && e.state !== 'stagger' && e.state !== 'dead') { e.state = 'chase'; e.stateTime = 0; }
        if (e.coverTimer > 0.6 && e.roguePhase === 2) e.coverTimer = 0.6;   // shorter holds -> more cover picks
        return { has: e.hasCover, x: e.coverPos.x, y: e.coverPos.y, z: e.coverPos.z, phase: e.roguePhase, state: e.state, los: e.hasLOS, t: ctx.time, target: e.target ? e.target.id : null };
      }, setup.id);
      if (!s) break;
      const key = `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
      if (s.has && !seen.has(key)) {
        seen.add(key);
        const check = await P((c) => {
          const ctx = window.__game.ctx; const world = ctx.world; const V = window.__V;
          const pp = ctx.player.position;
          const chest = new V(pp.x, pp.y + 1.8 * 0.65, pp.z);
          const eye = new V(c.x, c.y + 0.9, c.z);
          const d = chest.clone().sub(eye); const l = d.length(); d.multiplyScalar(1 / l);
          const hit = world.raycast(eye, d, l - 0.3);
          // flank angle: |sin theta| between the player's forward and player -> cover
          const fwd = ctx.player.getForward(new V());
          const dx = c.x - pp.x, dz = c.z - pp.z; const n = Math.hypot(dx, dz);
          const sin = Math.abs(fwd.x * (dz / n) - fwd.z * (dx / n));
          return { blocked: !!hit, dist: l, sin, toPlayer: n };
        }, s);
        covers.push({ ...s, ...check });
      }
      if (covers.length >= 3 || s.t - t0 > 20) break;
      await sleep(80);
    }
  }
  ok(!!setup, 'rogue + player placed across a rock cluster', JSON.stringify(setup));
  ok(covers.length >= 1, `rogue picked ${covers.length} cover point(s) in ≤ 40 s sim`, JSON.stringify(covers.map((c) => ({ phase: c.phase, state: c.state, los: c.los, target: c.target }))));
  ok(covers.length >= 1 && covers.every((c) => c.blocked), 'every chosen cover blocks the line to the player\'s chest (crouched eye → chest raycast hits)', JSON.stringify(covers.map((c) => ({ blocked: c.blocked, d: +c.dist.toFixed(1), sin: +c.sin.toFixed(2) }))));
  ok(covers.every((c) => c.toPlayer >= 4 - 0.05), 'cover keeps ≥ 4 m from the target (Phase 4 filter kept)');

  /* ── magazine + reload ────────────────────────────────────────────────── */
  console.log('magazine + reload');
  const rl = await P((id) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    const e = sys.active.find((x) => x.id === id);
    if (!e) return null;
    // clear LOS: put the player 14 m from the rogue on open ground (try 16 headings, take the first unobstructed one)
    const p = e.position;
    for (let k = 0; k < 16; k++) {
      const ang = k * Math.PI / 8;
      const x = p.x + Math.cos(ang) * 14, z = p.z + Math.sin(ang) * 14;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      const o = new V(p.x, p.y + 1.4, p.z);
      const d = new V(x - o.x, (y + 1.2) - o.y, z - o.z); const l = d.length(); d.multiplyScalar(1 / l);
      if (world.raycast(o, d, l - 0.5)) continue;
      ctx.player.spawnStanding(new V(x, y, z), Math.atan2(p.x - x, p.z - z) + Math.PI);
      e.magRounds = 12; e.reloadTimer = 0; e.grenadeCd = 999; e.aware = true; e.state = 'chase'; e.roguePhase = 0; e.stateTime = 0;
      window.__ev['enemy:shot'].length = 0; window.__ev['audio:play'].length = 0;
      return { placed: true, k };
    }
    return { placed: false };
  }, setup?.id);
  ok(rl && rl.placed, 'player placed 14 m from the rogue with LOS', JSON.stringify(rl));
  // poll: record shot count when the reload starts, the reload hint, and the gap in shots across the reload
  const reload = { seen: false, shotsAtStart: 0, hint: -1, mag: -1, crouch: 0, tStart: 0, tEnd: 0, shotsAtEnd: 0, magAfter: -1, audio: 0 };
  {
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const s = await P((id) => {
        const ctx = window.__game.ctx; const sys = window.__sys;
        ctx.player.hp = ctx.player.maxHp;
        const e = sys.active.find((x) => x.id === id);
        if (!e) return null;
        if (e.roguePhase === 2 && e.coverTimer > 0.4 && e.reloadTimer <= 0) e.coverTimer = 0.4;   // speed the cycle up
        return { reloading: e.reloadTimer > 0, mag: e.magRounds, hint: sys.debugHint(id), crouch: e.anim.crouch, shots: window.__ev['enemy:shot'].filter((x) => x.id === id).length, t: ctx.time,
          audio: window.__ev['audio:play'].filter((a) => a.id === 'reload').length, reloadPose: e.anim.reload };
      }, setup?.id);
      if (!s) break;
      if (!reload.seen && s.reloading) { reload.seen = true; reload.shotsAtStart = s.shots; reload.hint = s.hint; reload.mag = s.mag; reload.tStart = s.t; reload.audio = s.audio; }
      if (reload.seen && s.reloading) { reload.crouch = Math.max(reload.crouch, s.crouch); reload.pose = Math.max(reload.pose ?? 0, s.reloadPose); }
      if (reload.seen && !s.reloading) { reload.tEnd = s.t; reload.shotsAtEnd = s.shots; reload.magAfter = s.mag; break; }
      if (s.t - t0 > 90) break;
      await sleep(40);
    }
  }
  ok(reload.seen, `reload started after ${reload.shotsAtStart} shots (≤ 90 s sim)`, JSON.stringify(reload));
  ok(reload.seen && reload.shotsAtStart === constants.MAG, `magazine empties after exactly ROGUE_MAG_ROUNDS (${constants.MAG}) shots (got ${reload.shotsAtStart})`);
  ok(reload.seen && reload.mag === 0, 'magRounds is 0 while reloading');
  ok(reload.seen && reload.hint === 12, `wire hint 12 while reloading (got ${reload.hint})`);
  ok(reload.seen && reload.audio >= 1, `'reload' audio played at the rogue (${reload.audio})`);
  ok(reload.seen && reload.shotsAtEnd === reload.shotsAtStart, `no shots during the reload (${reload.shotsAtStart} → ${reload.shotsAtEnd})`);
  ok(reload.seen && reload.tEnd - reload.tStart >= constants.RELOAD - 0.15, `reload lasted ≈ ROGUE_RELOAD_TIME (${(reload.tEnd - reload.tStart).toFixed(2)} s)`);
  ok(reload.seen && reload.magAfter === constants.MAG, `magazine refilled to ${constants.MAG} (got ${reload.magAfter})`);
  ok(reload.seen && reload.crouch > 0.6 && (reload.pose ?? 0) > 0.5, `crouched (${reload.crouch.toFixed(2)}) with the reload pose (${(reload.pose ?? 0).toFixed(2)}) while reloading`);

  /* ── grenade after the LOS hold ───────────────────────────────────────── */
  console.log('grenade toss');
  const gset = await P((id) => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    const e = sys.active.find((x) => x.id === id);
    if (!e) return null;
    // Player 15 m from the rogue (it may have rushed in during the reload phase); other rogues never throw.
    // The spot is picked so the toss itself is not a lottery (this used to be the script's flakiest assertion):
    // the lob needs a **clear line** — a rock at 5 m deflects the grenade metres wide even though `throwGrenade`
    // only refuses a blocker within 2.5 m — and **flat ground**, or the grenade rolls downhill out of its own
    // blast radius before the fuse ends (measured 9.1 m away on a failing run).
    const p = e.position;
    const y0 = world.getHeightAt(p.x, p.z);
    let spot = null, loose = null;
    for (let k = 0; k < 32; k++) {
      const ang = k * Math.PI / 16;
      const x = p.x + Math.cos(ang) * 15, z = p.z + Math.sin(ang) * 15;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      if (!loose) loose = { x, y, z };
      if (Math.abs(y - y0) > 1.5) continue;                       // flat enough that nothing rolls away
      const dir = new V(x - p.x, 0, z - p.z).normalize();
      if (world.raycast(new V(p.x, y0 + 1.4, p.z), dir, 15)) continue;   // clear lob path (real raycast, wall not up yet)
      spot = { x, y, z }; break;
    }
    const at = spot ?? loose;
    if (at) ctx.player.spawnStanding(new V(at.x, at.y, at.z), Math.atan2(p.x - at.x, p.z - at.z) + Math.PI);
    for (const o of sys.active) if (o !== e && o.isRogue) o.grenadeCd = 999;
    // hide the player from every long ray: LOS / rifle raycasts (≥ 3 m) hit a virtual wall, short grenade steps pass
    window.__rc = world.raycast;
    world.raycast = function (o, d, max) { if (max > 3) return { point: new V(o.x + d.x, o.y + d.y, o.z + d.z), normal: new V(-d.x, -d.y, -d.z), distance: 1 }; return window.__rc.call(world, o, d, max); };
    e.grenadeCd = 0; e.noLosHold = 0; e.aware = true; e.state = 'chase'; e.roguePhase = 0; e.stateTime = 0; e.reloadTimer = 0; e.magRounds = 12; e.throwTimer = 0;
    ctx.player.hp = ctx.player.maxHp;
    window.__ev['enemy:attacked'].length = 0; window.__ev['camera:shake'].length = 0; window.__ev['audio:play'].length = 0;
    const pp = ctx.player.position;
    // The rogue is held at this spot until the wind-up starts (see the poll below).
    window.__anchor = [e.position.x, e.position.y, e.position.z];
    return { dist: Math.hypot(pp.x - e.position.x, pp.z - e.position.z), clear: !!spot, thrown0: sys.grenadesThrown, exploded0: sys.grenadesExploded, hp0: ctx.player.hp };
  }, setup?.id);
  ok(gset && gset.dist > 6 && gset.dist <= constants.RANGE, `player ${gset?.dist.toFixed(1)} m away: inside ROGUE_GRENADE_RANGE, outside the blast${gset?.clear ? '' : ' (no clear+flat spot found — falling back)'}`, JSON.stringify(gset));
  // The toss is a ballistic lob with ±1 m scatter, one bounce and a roll, so **where** it goes off is not
  // deterministic: a grenade that comes to rest on a rock sits metres above the player's chest even when it looks
  // like a direct hit from above, and the damage rule is a 3D distance to the chest. So instead of betting the
  // damage assertion on a single throw, take up to 3 and assert on the first blast that actually reaches
  // (`blast3d < ROGUE_GRENADE_RADIUS + PLAYER_RADIUS`). The wind-up assertions come from the first throw.
  const REACH = constants.RADIUS + 0.4;
  const gre = { windup: false, hint: -1, thrown: false, tThrow: 0, sphere: false, holdAt: 0, inFlight: null };
  let after = null, boom = false;
  const misses = [];
  for (let attempt = 0; attempt < 3 && !after; attempt++) {
    if (attempt > 0) {
      await P((id) => {
        const ctx = window.__game.ctx; const sys = window.__sys;
        const e = sys.active.find((x) => x.id === id);
        if (!e) return null;
        e.grenadeCd = 0; e.noLosHold = 0; e.throwTimer = 0; e.aware = true; e.state = 'chase'; e.roguePhase = 0; e.stateTime = 0; e.reloadTimer = 0; e.magRounds = 12;
        ctx.player.hp = ctx.player.maxHp;
        window.__ev['enemy:attacked'].length = 0; window.__ev['camera:shake'].length = 0; window.__ev['audio:play'].length = 0;
        return true;
      }, setup?.id);
      gre.thrown = false;
    }
    const t0 = await P(() => window.__game.ctx.time);
    for (;;) {
      const s = await P((a) => {
        const ctx = window.__game.ctx; const sys = window.__sys;
        ctx.player.hp = ctx.player.maxHp;
        const e = sys.active.find((x) => x.id === a.id);
        if (!e) return null;
        // Hold the rogue on its mark while it waits out ROGUE_GRENADE_HOLD_S: chasing the player's last known
        // position used to walk it inside GRENADE_MIN_DIST (6 m) or out of range, and then no grenade was ever
        // thrown inside the 30 s window. The wind-up itself is left alone (it steps out to `popPos` on purpose).
        if (e.throwTimer <= 0 && window.__anchor) e.position.set(window.__anchor[0], window.__anchor[1], window.__anchor[2]);
        const g = sys.debugGrenade(a.id);
        return { throwing: e.throwTimer > 0, hint: sys.debugHint(a.id), hold: e.noLosHold, los: e.hasLOS, thrown: e.grenadeCd > 5, t: ctx.time,
          sphere: e.rig.grenade ? e.rig.grenade.visible : null, phase: e.roguePhase, state: e.state, mine: g ? [g.x, g.y, g.z] : null, count: sys.grenadeCount,
          audio: window.__ev['audio:play'].filter((x) => x.id === 'grenade_throw').length };
      }, { id: setup?.id });
      if (!s) break;
      if (s.throwing && !gre.windup) { gre.windup = true; gre.hint = s.hint; gre.holdAt = s.hold; }
      if (s.throwing && s.sphere) gre.sphere = true;
      if (s.thrown) { gre.thrown = true; if (!gre.tThrow) gre.tThrow = s.t - t0; gre.last = s; if (!gre.inFlight) gre.inFlight = s; break; }
      if (s.t - t0 > 30) { gre.last = s; break; }
      await sleep(30);
    }
    if (!gre.thrown) break;
    // wait for the fuse (the virtual wall stays up so no rifle shot lands in the window — every hit below is the blast)
    boom = await untilSim((a) => window.__sys.grenadesExploded > a, constants.FUSE + 3, gset?.exploded0 ?? 0);
    const res = await P((a) => {
      const ctx = window.__game.ctx; const sys = window.__sys;
      const att = window.__ev['enemy:attacked'].filter((x) => x.id === a.id);
      const b = sys.lastGrenadeBlast; const pp = ctx.player.position;
      const e = sys.active.find((x) => x.id === a.id);
      // `blast3d` is what the damage rule actually uses (chest ↔ blast, 3D).
      const chest = { x: pp.x, y: pp.y + 0.9, z: pp.z };
      return { exploded: sys.grenadesExploded - a.exploded0, thrown: sys.grenadesThrown - a.thrown0, count: sys.grenadeCount, hp: +ctx.player.hp.toFixed(1),
        attacked: att.length, dmg: att.map((x) => +x.damage.toFixed(1)), types: att.map((x) => x.type),
        shake: window.__ev['camera:shake'].length, explosion: window.__ev['audio:play'].filter((x) => x.id === 'explosion').length,
        blastDist: +Math.hypot(b.x - pp.x, b.z - pp.z).toFixed(2), blast3d: +Math.hypot(b.x - chest.x, b.y - chest.y, b.z - chest.z).toFixed(2),
        cd: e ? e.grenadeCd : -1 };
    }, { ...gset, id: setup?.id });
    if (res.blast3d < REACH || res.attacked >= 1) after = res;
    else misses.push(`${res.blast3d} m (${res.blastDist} m flat)`);
  }
  await P(() => { const world = window.__game.ctx.world; if (window.__rc) { world.raycast = window.__rc; window.__rc = null; } window.__anchor = null; });
  ok(gre.windup, `throw wind-up started (hint ${gre.hint}, LOS hold ${gre.holdAt.toFixed(2)} s at the start)`, JSON.stringify(gre.last));
  ok(gre.windup && gre.hint === 13, 'wire hint 13 during the wind-up');
  ok(gre.windup && gre.holdAt >= constants.HOLD - 0.1, `hold ≥ ROGUE_GRENADE_HOLD_S (${gre.holdAt.toFixed(2)} ≥ ${constants.HOLD})`);
  ok(gre.sphere, "grenade sphere visible in the rogue's hand during the wind-up");
  ok(gre.thrown, `grenade thrown after ${gre.tThrow.toFixed(1)} s sim (cooldown armed)`);
  ok(gre.inFlight && gre.inFlight.count >= 1 && !!gre.inFlight.mine, `this rogue's grenade in flight (${gre.inFlight?.count} live)`, JSON.stringify(gre.inFlight));
  ok(gre.inFlight && gre.inFlight.audio >= 1, `'grenade_throw' audio (${gre.inFlight?.audio})`);
  after = after ?? { exploded: 0, count: 0, attacked: 0, dmg: [], types: [], shake: 0, explosion: 0, blastDist: -1, blast3d: -1, cd: -1, misses };
  ok(boom === true || after.exploded >= 1, `grenade exploded within the fuse (+${after.exploded}, live ${after.count}, ${after.blastDist} m from the player)`, JSON.stringify(after));
  ok(after.attacked >= 1 && after.dmg.every((d) => d > 0 && d <= constants.DAMAGE + 0.01) && after.types.every((t) => t === 'rogue'),
    `player took blast damage from this rogue with falloff (${JSON.stringify(after.dmg)} ≤ ${constants.DAMAGE})${misses.length ? `, after ${misses.length} throw(s) that landed out of reach: ${misses.join(', ')}` : ''}`, JSON.stringify(after));
  ok(after.explosion >= 1 && after.shake >= 1, `explosion audio (${after.explosion}) + camera shake (${after.shake})`);
  ok(after.cd > 6, `per-rogue grenade cooldown armed (${after.cd.toFixed(1)} s)`);

  /* ── Phase 10: a body killed in the air falls, then becomes lootable ──── */
  console.log('mid-air death → fall → corpse at the landing spot');
  const air = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const p = ctx.player.position;
    const has = (id) => !!ctx.interactables.all().find((it) => it.id === `corpse:${id}`);
    const r = sys.debugSpawn('rogue', { x: p.x + 6, z: p.z + 6 }, false);   // rogue: CORPSE_LOOT_CHANCE 1
    if (!r) return null;
    const ground = ctx.world.getHeightAt(r.position.x, r.position.z);
    r.position.y = ground + 6;
    r.airborne = true; r.vy = 3;            // shot at the top of a leap
    r.takeDamage(5000);
    return { id: r.id, ground: +ground.toFixed(2), y0: +r.position.y.toFixed(2), landed: r.deathLanded, vy: +r.deathVy.toFixed(2),
      corpse0: has(r.id), pending: r.corpsePending, dir: r.deathDir };
  });
  ok(air && air.y0 > air.ground + 5 && air.landed === false && air.pending === true && air.corpse0 === false,
    `a mid-air kill defers its corpse (y ${air?.y0}, ground ${air?.ground})`, JSON.stringify(air));
  ok(air && Math.abs(air.vy - 3) < 0.01, `the leap's vy carries into deathVy (${air?.vy})`);
  ok(air && ['left', 'right', 'back'].includes(air.dir), `the fall direction is picked at death (${air?.dir})`);
  await waitSim(1.6);
  const landed = await P((id) => {
    const sys = window.__sys; const ctx = window.__game.ctx;
    const e = sys.find(id);
    if (!e) return null;
    const it = ctx.interactables.all().find((x) => x.id === `corpse:${id}`);
    const ground = ctx.world.getHeightAt(e.position.x, e.position.z);
    return { landed: e.deathLanded, dy: +(e.position.y - ground).toFixed(3), lootable: e.lootable, pending: e.corpsePending,
      corpse: !!it, cy: it ? +(it.position.y - ground).toFixed(3) : null, dirAnim: e.anim.deathDir, fall: +e.anim.deathFall.toFixed(2) };
  }, air?.id);
  ok(landed && landed.landed === true && Math.abs(landed.dy) < 0.05, `the dead body fell to the terrain (dy ${landed?.dy} m)`, JSON.stringify(landed));
  ok(landed && landed.corpse === true && landed.lootable === true && !landed.pending && Math.abs(landed.cy) < 0.05,
    `the corpse interactable registers at the landing position (dy ${landed?.cy} m)`);
  ok(landed && landed.fall >= 1 && landed.dirAnim >= 0 && landed.dirAnim <= 2,
    `the fall pose blended in over DEATH_FALL_TIME (deathFall ${landed?.fall}, anim dir ${landed?.dirAnim})`);

  /* ── live authority round-trip ────────────────────────────────────────── */
  console.log('setAuthority round-trip');
  const before = await P(() => { const sys = window.__sys; return { n: sys.active.filter((e) => e.active).length, alive: sys.getAliveCount(), maxId: Math.max(...sys.active.map((e) => e.id)), auth: sys.isAuthority }; });
  await P(() => window.__sys.setAuthority(false));
  await waitSim(0.6);
  const demoted = await P(() => { const sys = window.__sys; return { n: sys.active.filter((e) => e.active).length, replica: sys.replica, auth: sys.isAuthority, buffered: sys.active.filter((e) => e.active && e.state !== 'dead' && e.netBuf && e.netBuf.count > 0).length, aliveNonDead: sys.active.filter((e) => e.active && e.state !== 'dead').length }; });
  ok(demoted.replica && !demoted.auth, 'setAuthority(false) → replica mode');
  ok(demoted.n === before.n, `demotion keeps the enemy count (${before.n} → ${demoted.n})`);
  ok(demoted.buffered === demoted.aliveNonDead, `every live enemy has a replica buffer (${demoted.buffered}/${demoted.aliveNonDead})`);
  // a hit on a replica must not change hp (it would be a request to the host)
  const hitRep = await P(() => { const sys = window.__sys; const e = sys.active.find((x) => x.active && x.state !== 'dead'); if (!e) return null; const hp0 = e.hp; e.takeDamage(10); return { hp0, hp1: e.hp }; });
  ok(hitRep && hitRep.hp0 === hitRep.hp1, 'takeDamage on a replica leaves hp untouched (request path)', JSON.stringify(hitRep));
  await P(() => window.__sys.setAuthority(true));
  const promoted = await P(() => { const sys = window.__sys; return { n: sys.active.filter((e) => e.active).length, replica: sys.replica, auth: sys.isAuthority, states: sys.active.filter((e) => e.active && e.state !== 'dead').map((e) => e.state) }; });
  ok(promoted.auth && !promoted.replica, 'setAuthority(true) → authority again');
  ok(promoted.n === before.n, `promotion keeps the enemy count (${before.n} → ${promoted.n})`);
  ok(promoted.states.every((s) => s === 'chase' || s === 'idle' || s === 'stagger'), 'promoted enemies restart in chase / idle', JSON.stringify(promoted.states.slice(0, 10)));
  await waitSim(1.5);
  const resumed = await P((maxId) => {
    const sys = window.__sys; const ctx = window.__game.ctx;
    const moving = sys.active.filter((e) => e.active && e.state !== 'dead' && (e.velocity.lengthSq() > 0.01 || e.hasMoveTarget || e.target)).length;
    const hp0 = sys.active.find((e) => e.active && e.state !== 'dead');
    let dmgOk = null;
    if (hp0) { const h = hp0.hp; hp0.takeDamage(5); dmgOk = hp0.hp < h; }
    const sp = sys.debugSpawn('scavenger', { x: ctx.player.position.x + 60, z: ctx.player.position.z + 60 }, false);
    const newId = sp ? sp.id : -1;
    if (sp) sp.kill(false);
    return { moving, dmgOk, newId, n: sys.active.filter((e) => e.active).length };
  }, before.maxId);
  ok(resumed.dmgOk === true, 'damage applies again after promotion');
  ok(resumed.newId >= before.maxId + 100, `ids after promotion leave headroom (${resumed.newId} ≥ ${before.maxId} + 100)`);
  ok(resumed.moving >= 1, `AI resumed (${resumed.moving} enemies steering / targeting)`);

  /* ── training: no spawning ────────────────────────────────────────────── */
  console.log('training world gate');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub again', 20000);
  const tr = await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'training';
    ctx.bus.emit('game:newMission', { seed: 5, mode: 'training' });
    return { mode: ctx.missionMode };
  });
  await waitFor(page, () => window.__game.ctx.phase === 'playing' || window.__game.ctx.phase === 'deploying', 'training mission', 25000);
  await waitSim(1.0);
  const trained = await P(() => { const sys = window.__sys; const ctx = window.__game.ctx; return { n: sys.active.filter((e) => e.active).length, training: sys.isTrainingWorld, mode: ctx.missionMode, worldMode: ctx.world ? ctx.world.mode : null, spawned: window.__ev['enemy:spawned'].length }; });
  ok(trained.training, `training world recognised (ctx.missionMode ${trained.mode}, world.mode ${trained.worldMode})`, JSON.stringify(tr));
  ok(trained.n === 0, `no enemies in the training world (${trained.n})`);
  await P(() => { window.__game.ctx.enemies.startExtractionWaves(window.__game.ctx.player.position.clone()); });
  await waitSim(4);
  const wv = await P(() => ({ n: window.__sys.active.filter((e) => e.active).length, waves: window.__ev['enemy:waveStarted'].length }));
  ok(wv.n === 0 && wv.waves === 0, `startExtractionWaves is ignored in training (${wv.n} enemies, ${wv.waves} waves)`);
  await P(() => { window.__game.ctx.missionMode = 'raid'; window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'back to hub', 20000);

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
