// Single-player smoke test for Phase 12 (enemies): 총알 추적 (`reportShot` → watch → advance → give up, refresh, far
// shot ignored, replica forwards `shotq`, host handles `shotq`, training no-op), 배리어 충돌 (a bug walking into a
// monkeypatched shield stops at it, `implant:barrierBumped`, retargets the carrier) + 정면 흡수 (a melee absorbed by
// `absorbFrontalAttack` never reaches the player), and the 정찰 x-ray silhouette (`setXray`).
// `ctx.implants.resolveBarrierCollision / absorbFrontalAttack` are monkeypatched: the implants folder owns the real ones.
// Usage: node scripts/smoke-enemy-alert.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
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

// contract values mirrored from src/shared/constants.ts (2026-09-08)
const C = { ALERT_DIST: 6, IMPACT_DIST: 10, WATCH: 3, CONE_MUL: 2, GIVE_UP: 20, ARRIVE: 8 };

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
    for (const n of ['enemy:shotAlerted', 'implant:barrierBumped', 'enemy:attacked', 'enemy:alerted']) {
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

  console.log('mission (seed 21)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 21 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => window.__sys.isAuthority && !window.__sys.replica && typeof window.__sys.reportShot === 'function' && typeof window.__sys.setXray === 'function'), 'authority + reportShot / setXray published on ctx.enemies');

  /* ── layout: player far away, rogue at R, shot origin O 66 m from R toward the player ─────────────────────── */
  // The rogue must be able to perceive nobody: its sight radius is 60 (× ENEMY_SHOT_ALERT_CONE_MUL = 120 while
  // investigating), so the player stands ≥ 140 m away and the origin is an empty spot on the ground.
  console.log('총알 추적: rogue');
  const lay = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    sys.setThreatLevel(0);
    for (const e of sys.active) if (e.active && e.state !== 'dead') e.kill(false);
    const pp = ctx.player.position;
    // pick a direction with 150 m of room inside the map
    let dir = null;
    for (let k = 0; k < 8 && !dir; k++) {
      const ang = k * Math.PI / 4;
      const x = pp.x + Math.cos(ang) * 150, z = pp.z + Math.sin(ang) * 150;
      if (world.isInsideBounds(x, z) && world.isInsideBounds(pp.x + Math.cos(ang) * 76, pp.z + Math.sin(ang) * 76)) dir = { x: Math.cos(ang), z: Math.sin(ang) };
    }
    if (!dir) return null;
    const R = { x: pp.x + dir.x * 142, z: pp.z + dir.z * 142 };
    const O = { x: pp.x + dir.x * 76, z: pp.z + dir.z * 76 };
    O.y = world.getHeightAt(O.x, O.z) + 1.5;
    const r = sys.debugSpawn('rogue', R, false);
    if (!r) return null;
    r.yaw = Math.atan2(dir.x, dir.z);           // facing away from the origin (facing = +sin yaw, +cos yaw)
    r.aware = false; r.state = 'idle'; r.wanderTimer = 999; r.grenadeCd = 999;
    window.__R = r.id; window.__O = O;
    return { id: r.id, dist: Math.hypot(r.position.x - O.x, r.position.z - O.z), toPlayer: Math.hypot(r.position.x - pp.x, r.position.z - pp.z), yaw: r.yaw };
  });
  ok(lay && lay.dist > 60 && lay.dist < 72 && lay.toPlayer > 130, `rogue ${lay?.dist.toFixed(1)} m from the origin, ${lay?.toPlayer.toFixed(1)} m from the player, facing away`, JSON.stringify(lay));

  // a shot that passes 3 m beside the rogue (no impact point)
  const shot = await P(() => {
    const sys = window.__sys; const V = window.__V; const O = window.__O;
    const e = sys.find(window.__R);
    const o = new V(O.x, O.y, O.z);
    const side = new V(-(e.position.z - O.z), 0, e.position.x - O.x).normalize();
    const aim = new V(e.position.x, e.position.y + 1, e.position.z).addScaledVector(side, 3);
    const d = aim.clone().sub(o).normalize();
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(o, d, 100, null);
    const ev = window.__ev['enemy:shotAlerted'].slice(n0);
    return { n: ev.length, ev: ev[0] ?? null, investigating: e.investigating, state: e.state, aware: e.aware, phase: e.shotPhase, origin: [e.shotOrigin.x, e.shotOrigin.z] };
  });
  ok(shot.n === 1 && shot.ev && shot.ev.id === lay.id, `enemy:shotAlerted fired once for the rogue`, JSON.stringify(shot));
  const Ox = await P(() => window.__O.x);
  ok(shot.ev && Math.abs(shot.ev.toward[0] - Ox) < 0.01 && Math.abs(shot.origin[0] - Ox) < 0.01, 'toward = the shot origin (also stored as shotOrigin)');
  ok(shot.investigating && shot.state === 'alert' && !shot.aware && shot.phase === 0, `rogue investigating (state alert, aware false, phase 0 = watch)`, JSON.stringify(shot));

  // yaw turns toward the origin within 1 s, body stays put during the watch
  const watch = await untilSim((id) => {
    const sys = window.__sys; const e = sys.find(id); const O = window.__O;
    const want = Math.atan2(O.x - e.position.x, O.z - e.position.z);
    let rel = want - e.yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    return Math.abs(rel) < 0.25 ? { rel, aim: e.anim.aim, t: window.__game.ctx.time } : null;
  }, 1.2, lay.id);
  ok(watch && typeof watch === 'object', `yaw turned toward the origin within 1.2 s (rel ${watch?.rel?.toFixed(2)})`, JSON.stringify(watch));
  const still = await P((id) => { const e = window.__sys.find(id); return { x: e.position.x, z: e.position.z, phase: e.shotPhase, t: e.shotTimer }; }, lay.id);
  ok(still.phase === 0 && still.t < C.WATCH, `still watching at t=${still.t.toFixed(2)} s`);
  await waitSim(1.0);
  const still2 = await P((id) => { const e = window.__sys.find(id); return { x: e.position.x, z: e.position.z, phase: e.shotPhase, aim: e.anim.aim, hint: window.__sys.debugHint(id) }; }, lay.id);
  ok(Math.hypot(still2.x - still.x, still2.z - still.z) < 0.5 && still2.phase === 0, `does not move during the watch (${Math.hypot(still2.x - still.x, still2.z - still.z).toFixed(2)} m)`, JSON.stringify(still2));
  ok(still2.aim > 0.5, `rifle raised while watching (aim ${still2.aim.toFixed(2)})`);

  // a second shot while investigating only refreshes the origin (no second event)
  const refresh = await P(() => {
    const sys = window.__sys; const V = window.__V; const O = window.__O;
    const e = sys.find(window.__R);
    const o = new V(O.x + 4, O.y, O.z + 4);
    const d = new V(e.position.x - o.x, 0, e.position.z - o.z).normalize();
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(o, d, 100, new V(e.position.x + 2, e.position.y, e.position.z + 2));
    return { events: window.__ev['enemy:shotAlerted'].length - n0, origin: [e.shotOrigin.x, e.shotOrigin.z], o: [o.x, o.z], investigating: e.investigating, timer: e.shotTimer };
  });
  ok(refresh.events === 0 && Math.abs(refresh.origin[0] - refresh.o[0]) < 0.01 && Math.abs(refresh.origin[1] - refresh.o[1]) < 0.01 && refresh.investigating, 'a second shot refreshes the origin without a second event', JSON.stringify(refresh));
  await P(() => { const e = window.__sys.find(window.__R); const O = window.__O; e.shotOrigin.set(O.x, O.y, O.z); });   // back to O for the distance checks

  // after the watch it advances toward the origin
  const d0 = await P((id) => { const e = window.__sys.find(id); const O = window.__O; return Math.hypot(e.position.x - O.x, e.position.z - O.z); }, lay.id);
  const adv = await untilSim((a) => {
    const sys = window.__sys; const e = sys.find(a.id); const O = window.__O;
    const d = Math.hypot(e.position.x - O.x, e.position.z - O.z);
    return (e.shotPhase >= 1 && d < a.d0 - 3) ? { d, phase: e.shotPhase, rphase: e.roguePhase, cover: e.hasCover, t: e.shotTimer, state: e.state, aware: e.aware } : null;
  }, C.WATCH + 8, { id: lay.id, d0 });
  ok(adv && typeof adv === 'object', `rogue advanced ≥ 3 m toward the origin after the watch (${d0.toFixed(1)} → ${adv?.d?.toFixed(1)} m, phase ${adv?.phase}, roguePhase ${adv?.rphase}, cover ${adv?.cover})`, JSON.stringify(adv));
  ok(adv && adv.state === 'alert' && !adv.aware, 'still unaware + alert on the wire while advancing');
  // fast-forward to the give-up and check the stand-down
  await P((a) => { const e = window.__sys.find(a.id); e.shotTimer = a.g - 0.5; }, { id: lay.id, g: C.GIVE_UP });
  await waitSim(1.2);
  const gave = await P((id) => { const e = window.__sys.find(id); return { investigating: e.investigating, state: e.state, aware: e.aware, phase: e.shotPhase }; }, lay.id);
  ok(!gave.investigating && !gave.aware && (gave.state === 'idle' || gave.state === 'wander'), `gave up after ENEMY_SHOT_ALERT_GIVE_UP_S → back to idle / wander`, JSON.stringify(gave));

  /* ── perceiving the shooter ends it: an alerted rogue that now sees the player drops into the normal cycle ─── */
  console.log('총알 추적: perceived → combat');
  const seen = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const world = ctx.world;
    const e = sys.find(window.__R);
    // move the player to 90 m from the rogue with a clear line (inside the 120 m widened cone, outside the 60 m sight)
    const pp = ctx.player.position;
    let placed = null;
    for (let k = 0; k < 16 && !placed; k++) {
      const ang = k * Math.PI / 8;
      const x = e.position.x + Math.cos(ang) * 90, z = e.position.z + Math.sin(ang) * 90;
      if (!world.isInsideBounds(x, z)) continue;
      const y = world.getHeightAt(x, z);
      const o = new V(e.position.x, e.position.y + 1.44, e.position.z);
      const d = new V(x - o.x, (y + 1.17) - o.y, z - o.z); const l = d.length(); d.multiplyScalar(1 / l);
      if (world.raycast(o, d, l - 0.5)) continue;
      ctx.player.spawnStanding(new V(x, y, z), 0);
      placed = { x, z, k };
    }
    if (!placed) return null;
    ctx.player.hp = ctx.player.maxHp;
    e.aware = false; e.state = 'idle'; e.investigating = false; e.target = null; e.targetTimer = 0; e.perceptionTimer = 0;
    // shot from the player's spot, passing beside the rogue
    const P0 = ctx.player.position;
    const o = new V(P0.x, P0.y + 1.5, P0.z);
    const side = new V(-(e.position.z - o.z), 0, e.position.x - o.x).normalize();
    const aim = new V(e.position.x, e.position.y + 1, e.position.z).addScaledVector(side, 2.5);
    const d = aim.clone().sub(o).normalize();
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(o, d, 150, null);
    return { placed, alerted: window.__ev['enemy:shotAlerted'].length - n0, investigating: e.investigating, dist: Math.hypot(P0.x - e.position.x, P0.z - e.position.z) };
  });
  ok(seen && seen.alerted === 1 && seen.investigating, `a shot from ${seen?.dist.toFixed(0)} m (outside sight 60, inside the ×2 cone) alerts the rogue`, JSON.stringify(seen));
  const engaged = await untilSim((id) => { const e = window.__sys.find(id); return e.aware && !e.investigating ? { state: e.state, target: e.target ? e.target.id : null, aware: e.aware } : null; }, 2.5, lay.id);
  ok(engaged && typeof engaged === 'object' && engaged.target === 'local', `widened cone perceived the player → investigation over, normal alert / chase (state ${engaged?.state}, target ${engaged?.target})`, JSON.stringify(engaged));

  /* ── far shot: nobody cares ─────────────────────────────────────────────── */
  console.log('총알 추적: far shot, bug, replica forward, shotq');
  const far = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const e = sys.find(window.__R); if (e) e.kill(false);
    const pp = ctx.player.position;
    const b = sys.debugSpawn('scavenger', { x: pp.x + 40, z: pp.z + 40 }, false);
    if (!b) return null;
    b.aware = false; b.state = 'idle'; b.wanderTimer = 999;
    window.__B = b.id;
    // a shot 40 m to the other side, pointing away from everything
    const o = new V(pp.x - 40, pp.y + 1.5, pp.z - 40);
    const d = new V(-1, 0, -1).normalize();
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(o, d, 60, new V(o.x + d.x * 60, o.y, o.z + d.z * 60));
    return { alerted: window.__ev['enemy:shotAlerted'].length - n0, investigating: b.investigating };
  });
  ok(far && far.alerted === 0 && !far.investigating, 'a shot far from every enemy alerts nobody', JSON.stringify(far));

  // a bug 40 m away + an impact within ENEMY_SHOT_IMPACT_DIST of it: investigates, then walks straight at the origin
  const bug = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V; const world = ctx.world;
    const b = sys.find(window.__B);
    if (!b || !b.active || b.state === 'dead') return null;
    const pp = ctx.player.position;
    // Put the bug out of the player's sight (scavenger sight 40; hearing only reacts to `weapon:fired`, not to
    // `reportShot`). The heading has to be searched: by now the player has been moved twice and may sit near an edge,
    // and the origin (−30 m) and the impact (+6 m) must be in bounds too.
    let bx = 0, bz = 0, found = false;
    for (let k = 0; k < 16 && !found; k++) {
      const ang = k * Math.PI / 8;
      bx = pp.x + Math.cos(ang) * 70; bz = pp.z + Math.sin(ang) * 70;
      found = world.isInsideBounds(bx, bz) && world.isInsideBounds(bx - 30, bz) && world.isInsideBounds(bx, bz + 6);
    }
    if (!found) return null;
    b.position.set(bx, world.getHeightAt(bx, bz), bz); b.spawnPos.copy(b.position);
    b.velocity.set(0, 0, 0);
    b.aware = false; b.state = 'idle'; b.wanderTimer = 999; b.target = null; b.investigating = false; b.perceptionTimer = 0;
    // origin 30 m from the bug (an empty spot), direction pointing well away from it, impact 6 m beside the bug
    const O = { x: bx - 30, z: bz };
    O.y = world.getHeightAt(O.x, O.z) + 1.5;
    const o = new V(O.x, O.y, O.z);
    const d = new V(0, 0, 1);
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(o, d, 100, new V(bx, b.position.y, bz + 6));
    window.__OB = O;
    return { alerted: window.__ev['enemy:shotAlerted'].length - n0, investigating: b.investigating, state: b.state, d0: Math.hypot(b.position.x - O.x, b.position.z - O.z), toPlayer: Math.hypot(bx - pp.x, bz - pp.z) };
  });
  ok(bug && bug.alerted === 1 && bug.investigating && bug.state === 'alert', `an impact within ENEMY_SHOT_IMPACT_DIST alerts the bug (${bug?.toPlayer.toFixed(0)} m from the player)`, JSON.stringify(bug));
  const bugTurn = !bug ? null : await untilSim(() => {
    const e = window.__sys.find(window.__B); const O = window.__OB;
    if (!e || !O) return null;
    const want = Math.atan2(O.x - e.position.x, O.z - e.position.z);
    let rel = want - e.yaw; rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    return Math.abs(rel) < 0.25 ? { rel } : null;
  }, 1.5);
  ok(bugTurn && typeof bugTurn === 'object', `bug faces the origin within 1.5 s (rel ${bugTurn?.rel?.toFixed(2)})`);
  await P(() => { const e = window.__sys.find(window.__B); if (e) e.shotTimer = 2.9; });   // skip the rest of the watch
  const bugAdv = !bug ? null : await untilSim((a) => {
    const e = window.__sys.find(window.__B); const O = window.__OB;
    if (!e || !O) return null;
    const d = Math.hypot(e.position.x - O.x, e.position.z - O.z);
    return (e.shotPhase === 1 && d < a.d0 - 4) ? { d, phase: e.shotPhase, state: e.state, aware: e.aware, moveTarget: e.hasMoveTarget } : null;
  }, 6, { d0: bug?.d0 ?? 0 });
  ok(bugAdv && typeof bugAdv === 'object' && !bugAdv.aware, `bug walked straight toward the origin (${bug?.d0?.toFixed(1)} → ${bugAdv?.d?.toFixed(1)} m)`, JSON.stringify(bugAdv));
  const arrived = !bug ? null : await untilSim(() => { const e = window.__sys.find(window.__B); if (!e) return { gone: true }; return !e.investigating ? { state: e.state, phase: e.shotPhase } : (e.shotPhase === 2 ? { held: true } : null); }, 14);
  ok(arrived && typeof arrived === 'object', `bug reached the ~${C.ARRIVE} m stop and stood down / holds a last look`, JSON.stringify(arrived));

  // replica: reportShot forwards a `shotq` to the host instead of alerting anyone
  const fwd = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const net = ctx.net;
    const sent = [];
    const orig = net.send;
    net.send = (msg, to) => { sent.push({ msg, to }); };
    // pretend a session is running so the client path sends
    const mp = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), 'isMultiplayer');
    let restoreMp = null;
    try { Object.defineProperty(ctx, 'isMultiplayer', { value: true, configurable: true }); restoreMp = () => { delete ctx.isMultiplayer; }; } catch (e) { /* not configurable */ }
    sys.setAuthority(false);
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(new V(0, 1, 0), new V(1, 0, 0), 50, new V(50, 1, 0));
    const r = { sent: sent.filter((s) => s.msg && s.msg.t === 'shotq'), alerted: window.__ev['enemy:shotAlerted'].length - n0, replica: sys.replica, mp: ctx.isMultiplayer };
    net.send = orig;
    if (restoreMp) restoreMp();
    sys.setAuthority(true);          // restore authority with the real isMultiplayer back in place
    r.authAfter = sys.isAuthority;
    return r;
  });
  ok(fwd.replica === true && fwd.authAfter === true && fwd.alerted === 0 && fwd.sent.length === 1 && fwd.sent[0].to === 'host' && Array.isArray(fwd.sent[0].msg.o) && fwd.sent[0].msg.r === 50 && Array.isArray(fwd.sent[0].msg.h), `a replica forwards the report as shotq {o, d, r, h} to the host and alerts nobody locally`, JSON.stringify(fwd));

  // host: a shotq from a peer runs the same routine (validated), credited to that peer
  const hostq = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world;
    const pp = ctx.player.position;
    const b = sys.find(window.__B); if (b) b.kill(false);
    let bx = 0, bz = 0, found = false;
    for (let k = 0; k < 16 && !found; k++) {
      const ang = k * Math.PI / 8 + Math.PI / 16;
      bx = pp.x + Math.cos(ang) * 70; bz = pp.z + Math.sin(ang) * 70;
      found = world.isInsideBounds(bx, bz) && world.isInsideBounds(bx - 30, bz) && world.isInsideBounds(bx, bz + 5);
    }
    if (!found) return { reason: 'no in-bounds heading' };
    const e = sys.debugSpawn('warrior', { x: bx, z: bz }, false);
    if (!e) return { reason: `spawn failed (authority ${sys.isAuthority}, world ${!!ctx.world && ctx.world.ready})` };
    e.aware = false; e.state = 'idle'; e.wanderTimer = 999;
    // `debugShotReport` skips the `hosting` gate (there is no session here) but runs the exact validation + routine
    const n0 = window.__ev['enemy:shotAlerted'].length;
    const bad = { t: 'shotq', o: [bx - 30, e.position.y + 1, bz], d: [0, 0, 1], r: -5 };
    sys.debugShotReport(bad, 'peer-x');
    const afterBad = window.__ev['enemy:shotAlerted'].length - n0;
    const bad2 = { t: 'shotq', o: [bx - 30, e.position.y + 1, bz], d: [0, 0, 1], r: 100, h: [1, 2] };
    sys.debugShotReport(bad2, 'peer-x');
    const afterBad2 = window.__ev['enemy:shotAlerted'].length - n0;
    const good = { t: 'shotq', o: [bx - 30, e.position.y + 1, bz], d: [0, 0, 1], r: 100, h: [bx, e.position.y, bz + 5] };
    sys.debugShotReport(good, 'peer-x');
    const r = { afterBad, afterBad2, alerted: window.__ev['enemy:shotAlerted'].length - n0, investigating: e.investigating, id: e.id };
    e.kill(false);
    return r;
  });
  ok(hostq && hostq.afterBad === 0 && hostq.afterBad2 === 0 && hostq.alerted === 1 && hostq.investigating, `host handles a peer's shotq (bad r / bad h rejected, valid one alerts)`, JSON.stringify(hostq));

  /* ── 배리어 충돌: a bug walking into a (monkeypatched) shield stops at it ─────────────────────────────────── */
  console.log('배리어 충돌 + retarget');
  const imp = await P(() => !!window.__game.ctx.implants && 'resolveBarrierCollision' in window.__game.ctx.implants && 'absorbFrontalAttack' in window.__game.ctx.implants);
  ok(imp, 'ctx.implants exposes resolveBarrierCollision + absorbFrontalAttack (contract)');
  const wall = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const world = ctx.world; const V = window.__V;
    for (const e of sys.active) if (e.active && e.state !== 'dead') e.kill(false);
    // flat spot: player at P, bug 18 m at -x, an invisible plane 4 m before the player on the bug's side
    // Deterministic scan (a random sample used to miss on some player positions): walk a coarse grid over the map and
    // take the first point whose 22 m corridor to the west is flat and free of obstacles.
    const pp = ctx.player.position;
    let spot = null, loose = null;
    const R = 260, STEP = 8;
    for (let ox = -R; ox <= R && !spot; ox += STEP) {
      for (let oz = -R; oz <= R && !spot; oz += STEP) {
        const x = pp.x + ox, z = pp.z + oz;
        if (!world.isInsideBounds(x - 22, z) || !world.isInsideBounds(x + 4, z)) continue;
        const y = world.getHeightAt(x, z);
        let flat = true;
        for (let s = -20; s <= 2 && flat; s += 2) if (Math.abs(world.getHeightAt(x + s, z) - y) > 1.2) flat = false;
        if (!flat) continue;
        if (!loose) loose = { x, y, z };
        if (world.getObstaclesNear(x - 9, z, 12).filter((o) => o.radius >= 0.4).length === 0) spot = { x, y, z };
      }
    }
    spot = spot ?? loose;
    if (!spot) return null;
    ctx.player.spawnStanding(new V(spot.x, spot.y, spot.z), Math.PI / 2);
    ctx.player.hp = ctx.player.maxHp;
    const plane = spot.x - 4;
    const impl = ctx.implants;
    window.__impOrig = { rc: impl.resolveBarrierCollision, ab: impl.absorbFrontalAttack };
    const calls = { rc: 0 };
    impl.resolveBarrierCollision = (pos, r) => { if (pos.x > plane - r && pos.x < spot.x) { pos.x = plane - r; calls.rc++; return 'local'; } return null; };
    window.__calls = calls;
    const b = sys.debugSpawn('scavenger', { x: spot.x - 18, z: spot.z }, true);
    if (!b) return null;
    window.__W = b.id;
    window.__ev['implant:barrierBumped'].length = 0; window.__ev['enemy:attacked'].length = 0;
    return { id: b.id, plane, px: spot.x, radius: b.stats.radius, hp0: ctx.player.hp };
  });
  ok(!!wall, 'flat spot found, player + charging scavenger placed, resolveBarrierCollision monkeypatched (plane 4 m before the player)', JSON.stringify(wall));
  const bumped = !wall ? null : await untilSim(() => window.__ev['implant:barrierBumped'].length >= 1 ? window.__ev['implant:barrierBumped'][0] : null, 14);
  ok(bumped && typeof bumped === 'object' && bumped.owner === 'local' && bumped.enemyId === wall?.id, `implant:barrierBumped {owner local, enemyId} fired when the bug hit the plane`, JSON.stringify(bumped));
  await waitSim(3);
  const held = !wall ? { x: 0, maxX: -1, calls: 0, bumps: 0, attacked: 1, hp: -1, target: null, owner: null, until: 0, t: 1, aware: false, state: '?', dist: 0 } : await P((a) => {
    const ctx = window.__game.ctx; const e = window.__sys.find(a.id);
    const bumps = window.__ev['implant:barrierBumped'].filter((b) => b.enemyId === a.id);
    const att = window.__ev['enemy:attacked'].filter((x) => x.id === a.id);
    return { x: e.position.x, maxX: a.plane - a.radius, calls: window.__calls.rc, bumps: bumps.length, attacked: att.length, hp: ctx.player.hp, target: e.target ? e.target.id : null, owner: e.barrierOwner, until: e.barrierUntil, t: ctx.time, aware: e.aware, state: e.state, dist: Math.hypot(e.position.x - ctx.player.position.x, e.position.z - ctx.player.position.z) };
  }, wall);
  ok(held.x <= held.maxX + 0.05 && held.calls > 5, `the bug is held at the plane (x ${held.x.toFixed(2)} ≤ ${held.maxX.toFixed(2)}, pushed ${held.calls}×)`, JSON.stringify(held));
  ok(held.attacked === 0 && held.hp === wall.hp0, `it never reached the player (0 bites, hp ${held.hp})`);
  ok(held.bumps >= 1 && held.bumps <= 2 * 3.5 + 2, `barrierBumped throttled to ≤ 2 Hz per enemy (${held.bumps} in ~3.5 s)`);
  ok(held.target === 'local' && held.owner === 'local' && held.until > held.t && held.aware, `retargeted onto the carrier for ~6 s (barrierUntil +${(held.until - held.t).toFixed(1)} s)`);

  /* ── 정면 흡수: absorbFrontalAttack true → the melee never lands on the player ─────────────────────────────── */
  console.log('정면 근접공격 흡수');
  const absorbSet = await P(() => {
    const ctx = window.__game.ctx; const impl = ctx.implants;
    impl.resolveBarrierCollision = window.__impOrig.rc;       // drop the wall so the bug can reach the player
    const abs = [];
    impl.absorbFrontalAttack = (owner, from, amount) => { abs.push({ owner, from: [from.x, from.y, from.z], amount }); return true; };
    window.__abs = abs;
    ctx.player.hp = ctx.player.maxHp;
    window.__ev['enemy:attacked'].length = 0;
    return { hp0: ctx.player.hp };
  });
  const absorbed = await untilSim(() => window.__abs.length >= 1 ? { n: window.__abs.length, first: window.__abs[0] } : null, 12);
  const absorbRes = await P((a) => {
    const ctx = window.__game.ctx;
    const att = window.__ev['enemy:attacked'];
    return { abs: window.__abs.length, attacked: att.length, attackedByBug: att.filter((x) => x.id === a.id).length, hp: ctx.player.hp, owner: window.__abs[0] ? window.__abs[0].owner : null, amount: window.__abs[0] ? window.__abs[0].amount : null };
  }, wall);
  ok(absorbed && typeof absorbed === 'object' && absorbRes.owner === 'local' && absorbRes.amount === 8, `absorbFrontalAttack('local', from, 8) consulted before the scavenger's bite`, JSON.stringify(absorbRes));
  ok(absorbRes.attackedByBug === 0 && (absorbRes.attacked > 0 || absorbRes.hp === absorbSet.hp0), `absorbed bite: no enemy:attacked, player hp unchanged (${absorbSet.hp0} → ${absorbRes.hp})`, JSON.stringify(absorbRes));
  // absorb false → the same bite lands
  await P(() => { const impl = window.__game.ctx.implants; impl.absorbFrontalAttack = () => false; window.__ev['enemy:attacked'].length = 0; });
  const landed = await untilSim((id) => window.__ev['enemy:attacked'].filter((x) => x.id === id).length >= 1 ? window.__ev['enemy:attacked'][0] : null, 8, wall.id);
  ok(landed && typeof landed === 'object' && landed.damage === 8, `with absorbFrontalAttack false the bite lands (enemy:attacked damage ${landed?.damage})`, JSON.stringify(landed));
  await P(() => { const ctx = window.__game.ctx; const impl = ctx.implants; impl.absorbFrontalAttack = window.__impOrig.ab; const e = window.__sys.find(window.__W); if (e) e.kill(false); ctx.player.hp = ctx.player.maxHp; });

  /* ── ee barrierHit on a client: damageBarrier('local', p, amount) ───────────────────────────────────────── */
  const bh = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const impl = ctx.implants;
    const calls = [];
    const orig = impl.damageBarrier;
    impl.damageBarrier = (owner, p, amount) => { calls.push({ owner, p: [p.x, p.y, p.z], amount }); };
    sys.barrierHitRemote(4242, new V(1, 2, 3), 25);
    impl.damageBarrier = orig;
    return calls;
  });
  ok(bh.length === 1 && bh[0].owner === 'local' && bh[0].amount === 25 && bh[0].p[1] === 2, `ee barrierHit → ctx.implants.damageBarrier('local', p, amount)`, JSON.stringify(bh));

  /* ── setXray ────────────────────────────────────────────────────────────── */
  console.log('setXray');
  const xr = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const pp = ctx.player.position;
    const e = sys.debugSpawn('warrior', { x: pp.x + 30, z: pp.z }, false);
    if (!e) return null;
    const before = sys.debugXray(e.id);
    sys.setXray([e.id, 999999], 2);
    const after = sys.debugXray(e.id);
    let overlayMeshes = 0, red = 0, greater = 0, bodyOrder = 0, bodies = 0;
    e.object.traverse((o) => {
      if (!o.isMesh) return;
      // THREE.GreaterDepth === 6 (NeverDepth 0 … NotEqualDepth 7)
      if (o.name === 'xray') { overlayMeshes++; if (o.material.color.getHex() === 0xff4d4d) red++; if (o.material.depthFunc === 6 && o.material.depthWrite === false && o.material.depthTest === true) greater++; }
      else { bodies++; if (o.renderOrder === 2) bodyOrder++; }
    });
    // extend
    sys.setXray([e.id], 5);
    const ext = sys.debugXray(e.id);
    window.__X = e.id;
    return { id: e.id, before, after, overlayMeshes, red, greater, bodies, bodyOrder, count: sys.xrayCount, ext, t: ctx.time };
  });
  ok(xr && xr.before.overlays === 0 && xr.after.overlays > 0 && xr.after.visible, `setXray built ${xr?.after.overlays} overlays and shows them (unknown id ignored, count ${xr?.count})`, JSON.stringify(xr));
  ok(xr && xr.overlayMeshes === xr.bodies && xr.red === xr.overlayMeshes && xr.greater === xr.overlayMeshes, `one overlay per body mesh, DETECT_ENEMY_COLOR, GreaterDepth + no depth write (${xr?.overlayMeshes}/${xr?.bodies})`);
  ok(xr && xr.bodyOrder === xr.bodies, 'body meshes lifted to render order 2 (overlay draws before the body)');
  ok(xr && xr.ext.until > xr.after.until && xr.ext.until - xr.t > 4.5, `a second call extends the expiry (+${(xr?.ext.until - xr?.t).toFixed(1)} s)`);
  await P(() => { const sys = window.__sys; const e = sys.find(window.__X); sys.setXray([e.id], 1.0); });   // does not shorten
  await waitSim(1.3);
  const midway = await P(() => window.__sys.debugXray(window.__X));
  ok(midway.visible, 'a shorter re-call never shortens (still visible after 1.3 s of a 5 s reveal)', JSON.stringify(midway));
  await waitSim(4.2);
  const expired = await P(() => ({ st: window.__sys.debugXray(window.__X), count: window.__sys.xrayCount }));
  ok(!expired.st.visible && expired.count === 0, 'the silhouette disappears when the reveal expires', JSON.stringify(expired));
  const dead = await P(() => { const sys = window.__sys; const e = sys.find(window.__X); sys.setXray([e.id], 10); const on = sys.debugXray(e.id).visible; e.kill(false); return { on }; });
  await waitSim(0.2);
  const deadX = await P(() => ({ st: window.__sys.debugXray(window.__X), count: window.__sys.xrayCount }));
  ok(dead.on && !deadX.st.visible && deadX.count === 0, 'death drops the silhouette at once', JSON.stringify(deadX));

  /* ── training: reportShot is a no-op ────────────────────────────────────── */
  console.log('training no-op');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub again', 20000);
  await P(() => { const ctx = window.__game.ctx; ctx.missionMode = 'training'; ctx.bus.emit('game:newMission', { seed: 5, mode: 'training' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing' || window.__game.ctx.phase === 'deploying', 'training mission', 25000);
  await waitSim(0.5);
  const tr = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const pp = ctx.player.position;
    const e = sys.debugSpawn('rogue', { x: pp.x + 20, z: pp.z }, false);
    if (!e) return { spawned: false, training: sys.isTrainingWorld };
    e.aware = false; e.state = 'idle';
    const n0 = window.__ev['enemy:shotAlerted'].length;
    sys.reportShot(new V(pp.x, pp.y + 1.5, pp.z), new V(1, 0, 0.1).normalize(), 60, new V(pp.x + 20, pp.y, pp.z + 3));
    const r = { spawned: true, training: sys.isTrainingWorld, alerted: window.__ev['enemy:shotAlerted'].length - n0, investigating: e.investigating };
    e.kill(false);
    return r;
  });
  ok(tr.training && (!tr.spawned || (tr.alerted === 0 && !tr.investigating)), 'reportShot is a no-op on the 훈련장', JSON.stringify(tr));
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
