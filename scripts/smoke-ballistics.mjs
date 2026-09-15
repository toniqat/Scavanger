// Single-player smoke test for 2026-09-14 **모든 총알을 발사체로** (weapons/): every ordinary gun round is a swept
// projectile with drop, plus the laser sight aiming at the crosshair and the 확장 총열 muzzle socket.
// Stats are patched on the live weapon instance (projectileSpeed / bulletGravity / spread 0) so the checks do not depend on
// the balance numbers in data/weapons.csv.
//  - first projectile shot compiles no new program (the streak batch is in the scene from the start)
//  - a round fired at a wall ~150 m out arrives after ≈ d / v and lands ≈ ½·g·t² below the crosshair line
//  - weapon:hit damage = damage × falloff(distance actually flown, effective stats)
//  - a wall inside WEAPON_MUZZLE_BLOCK_RANGE is hit on the spot the same frame (mode near, like the red marker)
//  - a shotgun trigger pull launches every pellet, every pellet hits, one hitmarker, one reportShot
//  - 650 m/s with a forced 50 ms step (32.5 m per step) does not tunnel through a thin post or an enemy
//  - a barrier stops the round: damageBarrier once per round, the enemy behind it untouched
//  - laser sight: aimed at the shot line's end while aiming / right after a shot, back along the barrel otherwise
//  - 확장 총열 (att_barrel_ext): the muzzle socket moves forward
//  - the pool never drops a local round (grows past the soft cap, evicts visual-only replicas first)
//  - stats.bloomPerShot / swayMul are what the gun reads
// Usage: node scripts/smoke-ballistics.mjs [http://localhost:5273]   (needs `npm run dev`)
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

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(80);
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const mDown = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mUp = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);

  console.log('setup');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await sleep(1200);
  const armed = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const ar = ctx.loot.createItem('wpn_ar');
    const added = inv.tryAddItem(ar) && inv.equip(ar.uid, 'primary');
    for (const it of inv.getAllItems()) if (it.defId === 'wpn_smg') inv.takeItem(it.uid);
    inv.tryAddItem(ctx.loot.createItem('ammo_medium', 90));
    return { added, primary: inv.getLoadout().primary?.defId };
  });
  ok(armed.added && armed.primary === 'wpn_ar', 'ship: 돌격소총 I equipped', JSON.stringify(armed));
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitSim(1.5);

  await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const V = ctx.camera.position.constructor;
    ctx.enemies.killAll(); ctx.player.heal(1000);
    window.__B = {
      hits: [], fired: 0, launches: [], markers: 0, markerT: [], reports: 0, removes: [],
      patch(speed, g, extra) {
        const w = ws.slots[ws.active]; if (!w) return null;
        Object.assign(w.stats, { projectileSpeed: speed, bulletGravity: g, spread: 0, adsSpread: 0 }, extra || {});
        w.inst.ammoInMag = w.stats.magSize; ws.cooldown = 0; ws.boltTimer = 0; ws.bloom = 0;
        return w;
      },
      // a look line clear for `dist` m (camera ray), preferring level pitch; the rig is turned onto it
      aimClear(dist, pitch = 0) {
        const rig = window.__game.getSystem('player').rig; const cam = ctx.camera; const d = new V();
        let best = null;
        for (let yi = 0; yi < 72; yi++) {
          const yaw = yi * Math.PI / 36;
          for (const p of [pitch, pitch + 0.02, pitch + 0.05, pitch + 0.1]) {
            const cp = Math.cos(p); d.set(-Math.sin(yaw) * cp, Math.sin(p), -Math.cos(yaw) * cp);
            const r = ctx.world.raycast(cam.position, d, dist);
            const got = r ? r.distance : dist;
            if (!best || got > best.got + 1e-6) best = { yaw, p, got };
            if (!r) break;
          }
          if (best && best.got >= dist) break;
        }
        rig.yaw = best.yaw; rig.pitch = best.p;
        return best;
      },
      post(c, radius, height = 400) { c.y = ctx.world.getHeightAt(c.x, c.z) - 5; const rm = ctx.world.addObstacle({ position: c, radius, height }); window.__B.removes.push(rm); return rm; },
      clearPosts() { for (const rm of window.__B.removes.splice(0)) rm(); },
      fire() { const w = ws.slots[ws.active]; ws.fire(ctx.player, w); return { mode: ws.shot.mode, origin: ws.shot.origin.toArray(), dir: ws.shot.dir.toArray(), end: ws.shot.end.toArray(), t: ctx.time }; },
    };
    ctx.bus.on('weapon:hit', (p) => window.__B.hits.push({ p: [p.point.x, p.point.y, p.point.z], enemyId: p.enemyId, damage: p.damage, t: ctx.time }));
    ctx.bus.on('weapon:fired', () => { window.__B.fired++; });
    ctx.bus.on('ui:hitmarker', () => { window.__B.markers++; window.__B.markerT.push(ctx.time); });
    const pool = ws.projectiles; const origFire = pool.fire.bind(pool);
    pool.fire = (o, d, speed, dmg, range, color, id, visual, opts) => { if (!visual) window.__B.launches.push({ speed, g: opts?.gravity ?? null, report: opts?.report ?? true }); return origFire(o, d, speed, dmg, range, color, id, visual, opts); };
    const em = ctx.enemies; const origRep = em.reportShot.bind(em);
    em.reportShot = (o, d, r, h) => { window.__B.reports++; return origRep(o, d, r, h); };
  });

  /* ── A. 150 m: drop, flight time, falloff, program count ─────────────────────── */
  console.log('150 m: 낙차 · 비행 시간 · 거리 감소');
  await P(() => window.__game.getSystem('player').rig && window.__B.aimClear(175, 0));
  await waitSim(0.6);
  const setupA = await P(() => {
    const ctx = window.__game.ctx; const cam = ctx.camera; const V = cam.position.constructor; const rig = window.__game.getSystem('player').rig;
    const d = new V(); rig.getLookDir(d);
    const D = 150;
    const c = cam.position.clone().addScaledVector(d, D);
    window.__B.post(c, 10);
    const r = ctx.world.raycast(cam.position, d, 400);
    return r && r.obstacle ? { wall: r.point.toArray(), dist: r.distance, look: d.toArray() } : null;
  });
  ok(!!setupA && setupA.dist > 120 && setupA.dist < 160, `a wall on the crosshair line ${setupA?.dist?.toFixed(1)} m out`, JSON.stringify(setupA));
  const G = 3.0, VEL = 320;
  const programs0 = await P(() => window.__game.ctx.renderer.info.programs.length);
  const shotA = await P(([v, g]) => { window.__B.hits.length = 0; window.__B.launches.length = 0; window.__B.reports = 0; const w = window.__B.patch(v, g); return { ...window.__B.fire(), damage: w.stats.damage, fs: w.stats.falloffStart, fe: w.stats.falloffEnd, fm: w.stats.falloffMin }; }, [VEL, G]);
  ok(shotA.mode === 'line', `the round leaves on the crosshair line (mode ${shotA.mode})`);
  const launchA = await P(() => window.__B.launches.slice());
  ok(launchA.length === 1 && launchA[0].speed === VEL && launchA[0].g === G && launchA[0].report === false, 'one projectile launched with the stats speed / gravity, reporting left to fire()', JSON.stringify(launchA));
  ok((await P(() => window.__B.reports)) === 1, 'one reportShot for the trigger pull');
  ok((await P(() => window.__B.hits.length)) === 0, 'no instant weapon:hit — the round is still in flight');
  await waitFor(page, () => window.__B.hits.length > 0, 'round arrives', 20000);
  await waitSim(0.5);
  const hitA = await P(() => window.__B.hits[0]);
  const programs1 = await P(() => window.__game.ctx.renderer.info.programs.length);
  const o = shotA.origin, wp = setupA.wall;
  const flight = Math.hypot(wp[0] - o[0], wp[1] - o[1], wp[2] - o[2]);
  const tExp = flight / VEL, dt = hitA.t - shotA.t;
  ok(Math.abs(dt - tExp) < Math.max(0.06, tExp * 0.15), `arrival after ${dt.toFixed(3)} s ≈ d / v = ${tExp.toFixed(3)} s (${flight.toFixed(1)} m)`);
  const dropExp = 0.5 * G * tExp * tExp;
  const drop = wp[1] - hitA.p[1];
  ok(Math.abs(drop - dropExp) < dropExp * 0.25 + 0.03, `lands ${drop.toFixed(3)} m below the crosshair point ≈ ½·g·t² = ${dropExp.toFixed(3)} m`);
  const lateral = Math.hypot(hitA.p[0] - wp[0], hitA.p[2] - wp[2]);
  ok(lateral < 0.25, `no sideways drift (${lateral.toFixed(3)} m, horizontal)`);
  const fall = (x) => (!(shotA.fe > shotA.fs) || x <= shotA.fs) ? 1 : x >= shotA.fe ? shotA.fm : 1 - ((x - shotA.fs) / (shotA.fe - shotA.fs)) * (1 - shotA.fm);
  const dmgExp = shotA.damage * fall(flight);
  ok(Math.abs(hitA.damage - dmgExp) < Math.max(0.5, dmgExp * 0.02), `damage ${hitA.damage.toFixed(1)} = ${shotA.damage} × falloff(${flight.toFixed(0)} m) ${dmgExp.toFixed(1)}`, JSON.stringify({ fs: shotA.fs, fe: shotA.fe, fm: shotA.fm }));
  ok(programs1 === programs0, `no new shader program on the first projectile shot (${programs0} → ${programs1})`);
  await P(() => window.__B.clearPosts());

  /* ── B. wall inside the muzzle block range: instant, same frame ─────────────── */
  console.log('총구 앞 벽: 즉시 명중 (빨간 원과 같은 자리)');
  const near = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const V = ctx.camera.position.constructor;
    const o = new V(), d = new V(); ctx.player.getAimRay(o, d);
    const w = ws.slots[ws.active]; w.model.muzzle.updateWorldMatrix(true, false);
    const m = new V().setFromMatrixPosition(w.model.muzzle.matrixWorld);
    const depth = new V().subVectors(m, o).dot(d);
    window.__B.post(o.clone().addScaledVector(d, depth + 2.2 + 1.5), 1.5);
    window.__B.hits.length = 0; window.__B.launches.length = 0;
    window.__B.patch(320, 3);
    const s = window.__B.fire();
    return { mode: s.mode, hits: window.__B.hits.length, launches: window.__B.launches.length };
  });
  ok(near.mode === 'near' && near.hits === 1 && near.launches === 0, `near hit resolved in the trigger frame, no projectile (mode ${near.mode}, hits ${near.hits}, launches ${near.launches})`);
  await P(() => window.__B.clearPosts());
  await waitSim(0.3);

  /* ── C. shotgun: every pellet launches and hits ──────────────────────────────── */
  console.log('산탄총: 펠릿 전부');
  const sg = await P(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory;
    const it = ctx.loot.createItem('wpn_sg');
    const ok = inv.tryAddItem(it) && inv.equip(it.uid, 'primary2');
    inv.tryAddItem(ctx.loot.createItem('ammo_shell', 24));
    window.__sgUid = it.uid;
    return ok;
  });
  ok(sg, 'wpn_sg equipped in 주무기 II');
  await P(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: '2', bubbles: true })));
  await P(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit2', key: '2', bubbles: true })));
  await waitSim(1.0);
  await P(() => window.__B.aimClear(40, 0));
  await waitSim(0.4);
  const sgShot = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const rig = window.__game.getSystem('player').rig; const V = ctx.camera.position.constructor;
    const w = ws.slots[ws.active];
    const d = new V(); rig.getLookDir(d);
    window.__B.post(ctx.camera.position.clone().addScaledVector(d, 14 + 8), 8);
    window.__B.patch(180, 1.5, { spread: w.def.spread, adsSpread: w.def.spread });
    window.__B.hits.length = 0; window.__B.launches.length = 0; window.__B.markers = 0; window.__B.markerT.length = 0; window.__B.reports = 0;
    const s = window.__B.fire();
    return { cls: w.stats.weaponClass, pellets: w.def.pellets, launches: window.__B.launches.length, mode: s.mode, mag: w.inst.ammoInMag, magSize: w.stats.magSize };
  });
  ok(sgShot.cls === 'SG' && sgShot.pellets > 1 && sgShot.launches === sgShot.pellets, `${sgShot.pellets} pellets → ${sgShot.launches} projectiles from one trigger pull`, JSON.stringify(sgShot));
  ok(sgShot.mag === sgShot.magSize - 1, 'one shell spent for the pull');
  await waitSim(0.5);
  const sgHits = await P(() => ({ hits: window.__B.hits.length, markers: window.__B.markers, reports: window.__B.reports }));
  ok(sgHits.hits === sgShot.pellets, `every pellet hits the wall (${sgHits.hits} / ${sgShot.pellets} weapon:hit)`);
  ok(sgHits.reports === 1, `one reportShot for the shotgun pull (${sgHits.reports})`);
  await P(() => window.__B.clearPosts());
  // pellets into an enemy: one merged hitmarker per landing step
  const sgE = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const rig = window.__game.getSystem('player').rig; const V = ctx.camera.position.constructor;
    const d = new V(); rig.getLookDir(d); d.y = 0; d.normalize();
    const p = ctx.player.position;
    const e = window.__game.getSystem('enemies').debugSpawn('warrior', { x: p.x + d.x * 5, z: p.z + d.z * 5 }, false);
    return e ? { id: e.id, hp: e.hp } : null;
  });
  ok(!!sgE, 'warrior 5 m ahead');
  await waitSim(0.3);
  await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const e = window.__game.getSystem('enemies').byId.get(window.__sgE?.id);
    void e;
  });
  const sgEnemy = await P((id) => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const rig = window.__game.getSystem('player').rig; const V = ctx.camera.position.constructor;
    const e = window.__game.getSystem('enemies').byId.get(id);
    if (!e) return null;
    // aim the camera at the warrior's chest
    const c = new V(e.position.x, e.position.y + e.height * 0.5, e.position.z);
    const dd = new V().subVectors(c, ctx.camera.position).normalize();
    rig.yaw = Math.atan2(-dd.x, -dd.z); rig.pitch = Math.asin(dd.y);
    return { hp: e.hp };
  }, sgE?.id);
  await waitSim(0.25);
  const sgE2 = await P((id) => {
    const ws = window.__game.getSystem('weapons'); const w = ws.slots[ws.active];
    window.__B.patch(180, 1.5, { spread: w.def.spread * 0.3, adsSpread: w.def.spread * 0.3 });
    window.__B.hits.length = 0; window.__B.markers = 0; window.__B.markerT.length = 0;
    window.__B.fire();
    return id;
  }, sgE?.id);
  await waitSim(0.4);
  const sgE3 = await P((id) => {
    const e = window.__game.getSystem('enemies').byId.get(id);
    const eh = window.__B.hits.filter((h) => h.enemyId === id);
    // 같은 풀 스텝(= 같은 프레임)의 명중은 `ctx.time` 이 정확히 같다 — 서로 다른 t 의 개수 = 이 일제사가 걸친 스텝 수.
    const steps = new Set(eh.map((h) => h.t)).size;
    return { hp: e ? e.hp : null, dead: !e || e.isDead, enemyHits: eh.length, steps, markers: window.__B.markers };
  }, sgE2);
  ok(sgE3.enemyHits >= 2 && (sgE3.dead || sgE3.hp < sgEnemy.hp), `pellets hit the warrior (${sgE3.enemyHits} hits, hp ${sgEnemy?.hp} → ${sgE3.hp})`, JSON.stringify(sgE3));
  /* 2026-09-15 (에이전트 B — 흔들리던 단언 교정): 묶이는 근거는 **풀 한 스텝**이다 (`WeaponSystem.update` 가
     `projectiles.update` 바로 뒤에 `Fire.flushHitmarker` 를 부른다). 옛 단언 `markers <= 2` 는 그 근거가 아니라
     **프레임 박자**를 재고 있었다 — 180 m/s 펠릿이 5 m 를 나는 데 27.8 ms 인데 한 프레임이 16.7 ms 라, 적 캡슐의
     앞뒤면 때문에 벌어지는 명중 거리 차가 프레임 경계에 어떻게 걸리느냐에 따라 스텝이 2 개도 3 개도 된다
     (헤드리스에서 3 회 중 1 회 3 이 나왔다 · 코드 회귀가 아니다). 그래서 계약 그대로 잰다:
       ① `markers === steps` — 스텝마다 **정확히 하나**. 병합을 걷어내면(펠릿마다 emit) steps 1 에 markers 8 로 깨진다.
       ② `markers < enemyHits` — 여덟 발이 여덟 개의 마커가 되는 일은 없다.
     둘 다 프레임 박자와 무관하고, 재는 것은 「같이 도착한 펠릿은 한 마커로 묶인다」 그 자체다. */
  ok(sgE3.markers === sgE3.steps && sgE3.markers < sgE3.enemyHits,
    `pellets landing together merge into one hitmarker per pool step (${sgE3.markers} markers / ${sgE3.steps} steps / ${sgE3.enemyHits} hits)`);
  await P(() => window.__game.ctx.enemies.killAll());
  await P(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit1', key: '1', bubbles: true })));
  await P(() => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit1', key: '1', bubbles: true })));
  await waitSim(1.0);

  /* ── D. no tunnelling at 650 m/s with 50 ms steps ─────────────────────────────── */
  console.log('터널링 없음: 650 m/s · 50 ms 스텝');
  const tun = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const V = ctx.camera.position.constructor; const pool = ws.projectiles;
    const p = ctx.player.position;
    // a level line from the chest clear for 60 m
    const from = new V(p.x, p.y + 1.4, p.z); const d = new V();
    let dir = null;
    for (let i = 0; i < 72; i++) { const a = i * Math.PI / 36; d.set(Math.sin(a), 0, Math.cos(a)); if (!ctx.world.raycast(from, d, 70)) { dir = d.clone(); break; } }
    if (!dir) return null;
    const post = from.clone().addScaledVector(dir, 20); window.__B.post(post, 0.1);
    window.__B.hits.length = 0;
    pool.fire(from.clone().addScaledVector(dir, 1), dir, 650, 50, 700, 0xffffff, 'ar', false, { style: 'bullet', gravity: 0.2, report: false });
    const steps = [];
    for (let k = 0; k < 4 && window.__B.hits.length === 0; k++) { pool.update(0.05); steps.push(k); }
    const h = window.__B.hits[0];
    window.__B.clearPosts();
    return { steps: steps.length, hit: h ? { enemyId: h.enemyId, axis: Math.hypot(h.p[0] - post.x, h.p[2] - post.z) } : null };
  });
  ok(!!tun && !!tun.hit && tun.hit.enemyId === null && tun.hit.axis < 0.2, `a 0.1 m post 19 m out stops the round inside the 32.5 m step (${tun?.hit?.axis?.toFixed(3)} m from its axis, ${tun?.steps} steps)`, JSON.stringify(tun));
  const tunE0 = await P(() => {
    const ctx = window.__game.ctx; const V = ctx.camera.position.constructor; const p = ctx.player.position;
    const from = new V(p.x, p.y + 1.2, p.z); const d = new V();
    for (let i = 0; i < 72; i++) {
      const a = i * Math.PI / 36; d.set(Math.sin(a), 0, Math.cos(a));
      if (ctx.world.raycast(from, d, 60)) continue;
      const e = window.__game.getSystem('enemies').debugSpawn('warrior', { x: p.x + d.x * 45, z: p.z + d.z * 45 }, false);
      return e ? { id: e.id, hp: e.hp, dir: [d.x, d.z] } : null;
    }
    return null;
  });
  ok(!!tunE0, 'warrior 45 m out on a clear line');
  await waitSim(1.5);   // past a burrow emergence
  const tunE = await P((t) => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const V = ctx.camera.position.constructor; const pool = ws.projectiles;
    const e = window.__game.getSystem('enemies').byId.get(t.id);
    if (!e) return null;
    const h0 = e.stats?.height ?? e.height ?? 1.6;
    const c = new V(e.position.x, e.position.y + h0 * 0.5, e.position.z);
    // an approach line into the chest with the terrain ≥ 0.3 m below it at every metre (rolling ground: a level line
    // 0.8 m up is often under a bump the terrain ray skips — the round would rightly land there)
    let from = null;
    for (let i = 0; i < 72 && !from; i++) {
      const a = i * Math.PI / 36;
      for (const rise of [0, 1.5, 3, 5]) {
        const f = new V(c.x - Math.sin(a) * 44, c.y + rise, c.z - Math.cos(a) * 44);
        let clear = true;
        for (let m = 1; m < 43 && clear; m++) { const q = f.clone().lerp(c, m / 44); if (q.y - ctx.world.getHeightAt(q.x, q.z) < 0.3) clear = false; }
        const dd = new V().subVectors(c, f).normalize();
        if (clear && !ctx.world.raycast(f, dd, 43)) { from = f; break; }
      }
    }
    if (!from) return { noLine: true };
    const dir = new V().subVectors(c, from).normalize();
    const eDirect = ctx.enemies.raycast(from, dir, 60);
    const wDirect = ctx.world.raycast(from, dir, 60);
    window.__B.hits.length = 0;
    pool.fire(from, dir, 650, 40, 700, 0xffffff, 'ar', false, { style: 'bullet', gravity: 0.2, report: false });
    const steps = [];
    for (let k = 0; k < 4 && window.__B.hits.length === 0; k++) { pool.update(0.05); steps.push(pool.liveCount); }
    const h = window.__B.hits[0];
    return {
      hitEnemy: h ? h.enemyId : null, hp0: t.hp, hp1: e.hp, dead: e.isDead,
      diag: { state: e.state, active: e.active, y: +e.position.y.toFixed(2), ground: +ctx.world.getHeightAt(e.position.x, e.position.z).toFixed(2), h0, eDirect: eDirect ? +eDirect.distance.toFixed(2) : null, wDirect: wDirect ? +wDirect.distance.toFixed(2) : null, steps, hit: h ?? null },
    };
  }, tunE0);
  ok(!!tunE && tunE.hitEnemy === tunE0.id && (tunE.dead || tunE.hp1 < tunE.hp0), `the step that jumps across the scavenger hits it (hp ${tunE?.hp0} → ${tunE?.hp1})`, JSON.stringify(tunE));
  await P(() => window.__game.ctx.enemies.killAll());
  await waitSim(0.3);

  /* ── E. barrier stops rounds ─────────────────────────────────────────────────── */
  console.log('배리어가 총알을 막는다');
  await P(() => window.__B.aimClear(40, 0));
  await waitSim(0.4);
  const bar0 = await P(() => {
    const ctx = window.__game.ctx; const imp = ctx.implants; const V = ctx.camera.position.constructor; const rig = window.__game.getSystem('player').rig;
    if (!imp) return null;
    const look = new V(); rig.getLookDir(look); look.y = 0; look.normalize();
    const p = ctx.player.position;
    const plane = new V(p.x, 0, p.z).addScaledVector(look, 12);
    window.__barPlane = plane;
    const origRay = imp.raycastBarrier.bind(imp); const origDmg = imp.damageBarrier.bind(imp);
    // a synthetic vertical barrier across the look line, 12 m out, 6 m wide
    imp.raycastBarrier = (o, d, m) => {
      const den = d.x * look.x + d.z * look.z; if (Math.abs(den) < 1e-6) return null;
      const t = ((plane.x - o.x) * look.x + (plane.z - o.z) * look.z) / den;
      if (t < 0 || t > m) return null;
      const q = o.clone().addScaledVector(d, t);
      if (Math.hypot(q.x - plane.x, q.z - plane.z) > 3) return null;
      return { point: q, owner: 'local' };
    };
    window.__barCalls = [];
    imp.damageBarrier = (owner, point) => { window.__barCalls.push([owner, point.x, point.z]); };
    window.__restoreBar = () => { imp.raycastBarrier = origRay; imp.damageBarrier = origDmg; };
    const e = window.__game.getSystem('enemies').debugSpawn('warrior', { x: p.x + look.x * 22, z: p.z + look.z * 22 }, false);
    return e ? { id: e.id, hp: e.hp } : null;
  });
  ok(!!bar0, 'synthetic barrier 12 m out + a warrior behind it at 22 m');
  await waitSim(0.3);
  await P((id) => {
    const ctx = window.__game.ctx; const V = ctx.camera.position.constructor; const rig = window.__game.getSystem('player').rig;
    const e = window.__game.getSystem('enemies').byId.get(id);
    if (e) { const c = new V(e.position.x, e.position.y + e.height * 0.5, e.position.z); const dd = c.sub(ctx.camera.position).normalize(); rig.yaw = Math.atan2(-dd.x, -dd.z); rig.pitch = Math.asin(dd.y); }
  }, bar0?.id);
  await waitSim(0.2);
  for (let i = 0; i < 3; i++) {
    await P(() => { window.__B.patch(320, 3); window.__B.hits.length = 0; window.__B.fire(); });
    await waitSim(0.25);
  }
  const barR = await P((id) => {
    const e = window.__game.getSystem('enemies').byId.get(id);
    const plane = window.__barPlane;
    const r = { calls: window.__barCalls.length, owners: window.__barCalls.map((c) => c[0]), hp: e ? e.hp : null, planeGap: window.__barCalls.map((c) => Math.hypot(c[1] - plane.x, c[2] - plane.z)) };
    window.__restoreBar();
    return r;
  }, bar0?.id);
  ok(barR.calls === 3 && barR.owners.every((o) => o === 'local'), `three rounds → damageBarrier('local') exactly three times (${barR.calls})`, JSON.stringify(barR));
  ok(barR.hp === bar0?.hp, `the warrior behind the barrier is untouched (hp ${bar0?.hp} → ${barR.hp})`);
  await P(() => window.__game.ctx.enemies.killAll());
  await waitSim(0.3);

  /* ── F. laser sight ──────────────────────────────────────────────────────────── */
  console.log('레이저 사이트: 크로스헤어를 향한다');
  await P(() => window.__B.aimClear(30, -0.08));
  const las0 = await P(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const ws = window.__game.getSystem('weapons');
    const l = inv.getLoadout();
    const it = ctx.loot.createItem('att_laser'); inv.tryAddItem(it);
    const attached = inv.attachToWeapon(l.primary.uid, it.uid);
    const w = ws.slots.primary;
    if (!attached || !w.model.hasLaser) w.model.setAttachments({ sight: 'laser' });
    return { attached, hasLaser: w.model.hasLaser };
  });
  ok(las0.hasLaser, `laser sight on the AR (attachToWeapon ${las0.attached})`);
  const laserState = () => P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const V = ctx.camera.position.constructor;
    const w = ws.slots[ws.active]; const beam = w.model.root.getObjectByName('laserBeam'); if (!beam) return null;
    const pivot = beam.parent; pivot.updateWorldMatrix(true, false);
    const pos = new V().setFromMatrixPosition(pivot.matrixWorld);
    const q = pivot.getWorldQuaternion(new pivot.quaternion.constructor());
    const beamDir = new V(0, 0, -1).applyQuaternion(q);
    const toAim = new V().subVectors(ws.aimLine.end, pos).normalize();
    // the barrel direction: the pivot's parent −Z
    const pq = pivot.parent.getWorldQuaternion(new pivot.quaternion.constructor());
    const barrel = new V(0, 0, -1).applyQuaternion(pq);
    const ws2 = new V(); pivot.getWorldScale(ws2);
    return { blend: w.model.laserAimBlend, toAimDeg: beamDir.angleTo(toAim) * 180 / Math.PI, barrelDeg: beamDir.angleTo(barrel) * 180 / Math.PI, len: ws2.z, dist: pos.distanceTo(ws.aimLine.end), valid: ws.aimLineValid };
  });
  await mDown(2);
  await waitSim(1.0);
  const lasAds = await laserState();
  ok(!!lasAds && lasAds.valid && lasAds.blend > 0.95 && lasAds.toAimDeg < 1.5, `ADS: the beam points at the shot line's end (${lasAds?.toAimDeg?.toFixed(2)}°, blend ${lasAds?.blend?.toFixed(2)})`, JSON.stringify(lasAds));
  ok(!!lasAds && Math.abs(lasAds.len - Math.min(40, Math.max(0.3, lasAds.dist))) < Math.max(0.3, lasAds.dist * 0.05), `ADS: the beam reaches the aim point (${lasAds?.len?.toFixed(2)} m of ${lasAds?.dist?.toFixed(2)} m)`);
  await mUp(2);
  await waitSim(1.2);
  const lasRest = await laserState();
  ok(!!lasRest && lasRest.blend < 0.02 && lasRest.barrelDeg < 0.3 && Math.abs(lasRest.len - 1.6) < 0.05, `hip, idle: the beam is back along the barrel (${lasRest?.barrelDeg?.toFixed(2)}°, ${lasRest?.len?.toFixed(2)} m)`, JSON.stringify(lasRest));
  await P(() => { window.__B.patch(320, 3); window.__B.fire(); });
  await waitSim(0.3);
  const lasShot = await laserState();
  ok(!!lasShot && lasShot.blend > 0.9 && lasShot.toAimDeg < 3, `right after a hip shot the beam turns to the aim point (${lasShot?.toAimDeg?.toFixed(2)}°, blend ${lasShot?.blend?.toFixed(2)})`, JSON.stringify(lasShot));
  await waitSim(1.5);

  /* ── G. 확장 총열 ───────────────────────────────────────────────────────────────── */
  console.log('확장 총열: 총구 소켓이 앞으로');
  const barrel = await P(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const ws = window.__game.getSystem('weapons');
    const w = ws.slots.primary; const z0 = w.model.muzzle.position.z;
    const def = ctx.loot.getItemDef('att_barrel_ext');
    let attached = false;
    if (def) { const it = ctx.loot.createItem('att_barrel_ext'); inv.tryAddItem(it); attached = inv.attachToWeapon(inv.getLoadout().primary.uid, it.uid); }
    const w2 = ws.slots.primary;
    if (!attached) w2.model.setAttachments({ muzzle: 'barrel', sight: 'laser' });
    return { def: !!def, attached, z0, z1: w2.model.muzzle.position.z, laser: w2.model.hasLaser, g: w2.stats.bulletGravity, fe: w2.stats.falloffEnd };
  });
  ok(barrel.z0 - barrel.z1 > 0.1, `the muzzle socket moves ${(barrel.z0 - barrel.z1).toFixed(3)} m forward (def ${barrel.def}, attachToWeapon ${barrel.attached})`, JSON.stringify(barrel));
  ok(barrel.laser, 'the laser sight survives the attachment rebuild');

  /* ── H. pool growth / eviction ────────────────────────────────────────────────── */
  console.log('발사체 풀: 로컬 탄은 버리지 않는다');
  const poolR = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const pool = ws.projectiles; const V = ctx.camera.position.constructor;
    pool.clear();
    const up = new V(0, 1, 0); const o = ctx.player.position.clone(); o.y += 300;
    for (let i = 0; i < 300; i++) pool.fire(o, up, 50, 0, 700, 0xffffff, 'ar', true, { style: 'bullet', gravity: 0 });
    for (let i = 0; i < 500; i++) pool.fire(o, up, 50, 1, 700, 0xffffff, 'ar', false, { style: 'bullet', gravity: 0, report: false });
    const local = pool.live.filter((s) => !s.visualOnly).length, visual = pool.live.filter((s) => s.visualOnly).length;
    pool.update(0.016);
    const drawn = pool.streaks?.count ?? null;
    pool.clear();
    return { local, visual, total: local + visual, after: pool.liveCount, drawn };
  });
  ok(poolR.local === 500, `all 500 local rounds alive past the soft cap (visual replicas left: ${poolR.visual})`, JSON.stringify(poolR));
  ok(poolR.visual < 300, 'visual-only replicas were evicted first');
  ok(poolR.after === 0, 'clear() empties the pool');

  /* ── I. bloom / sway from the stats ───────────────────────────────────────────── */
  console.log('stats: bloomPerShot · swayMul');
  const bs = await P(() => {
    const ctx = window.__game.ctx; const ws = window.__game.getSystem('weapons'); const w = ws.slots[ws.active];
    window.__B.patch(320, 3, { bloomPerShot: 0.5, bloomSpread: 2 });
    ws.bloom = 0; window.__B.fire(); const b1 = ws.bloom;
    const calls = []; const p = ctx.player;
    p.setAimSway = (a, f) => calls.push([a, f]);
    w.stats.swayMul = 1; ws.applyAimZoom(w.stats); w.stats.swayMul = 2; ws.applyAimZoom(w.stats);
    delete p.setAimSway;
    ws.applyAimZoom(ws.zoomStatsFor(w));
    return { b1, calls };
  });
  ok(Math.abs(bs.b1 - 0.5) < 1e-6, `bloom += stats.bloomPerShot (${bs.b1})`);
  ok(bs.calls.length === 2 && bs.calls[0][0] > 0 && Math.abs(bs.calls[1][0] - bs.calls[0][0] * 2) < 1e-9 && bs.calls[0][1] === bs.calls[1][1], `setAimSway amplitude × stats.swayMul (${bs.calls.map((c) => c[0].toFixed(3)).join(' → ')})`, JSON.stringify(bs.calls));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
  if (errors.length) console.log('  console errors:', errors.slice(0, 8).join('\n    '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
