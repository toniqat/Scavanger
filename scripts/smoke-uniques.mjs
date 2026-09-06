// Single-player smoke test for the six unique weapons (Phase 6): 「인페르노」 flamethrower, 「테슬라 코일」 shock gun,
// 「카게」 shuriken + 용검 slash, 「롱혼」 bow, 「해머헤드」 bazooka (+ rocket jump), 「사이클론」 minigun (spin-up / RMB pre-spin).
// Usage: node scripts/smoke-uniques.mjs [http://localhost:5273]   (needs a running vite)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
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
    // never take a real pointer lock in headless mode (Windows ClipCursor trap); the script fakes `pointerLockElement`
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // park the vite HMR socket: another editor's save would full-reload the page mid-run
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.loot, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['weapon:equipped', 'weapon:fired', 'weapon:altFired', 'weapon:beamChanged', 'weapon:chargeChanged', 'weapon:ammoChanged',
      'weapon:durabilityChanged', 'weapon:scopeChanged', 'weapon:hit', 'weapon:dryFire', 'weapon:reloadStarted', 'weapon:reloadFinished',
      'enemy:incinerated', 'enemy:shocked', 'player:slashed', 'player:blastJump', 'melee:swing', 'melee:hit', 'ui:notify', 'ui:hitmarker']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => P((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const clearEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k].length = 0; });
  // keys / mouse: keydown + keyup in ONE evaluate (dt is clamped to 50 ms, any wait reads as a hold); mouse buttons mirror as `Mouse<n>`
  const tap = (code) => P((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const keyDown = (code) => P((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => P((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const mouseDown = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mouseUp = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);
  const click = (b) => P((x) => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true }));
  }, b);
  const look = (dx, dy) => P(([x, y]) => document.body.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true })), [dx, dy]);
  // wait on simulation time, never wall-clock
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const mouseSim = async (b, sec) => { await mouseDown(b); await waitSim(sec); await mouseUp(b); };

  // ── helpers inside the page
  await P(() => {
    const ctx = window.__game.ctx;
    window.__equip = (defId, ammoId, ammoQty) => {
      const inv = ctx.inventory, loot = ctx.loot;
      const prev = inv.getLoadout().primary?.uid ?? null;
      const item = loot.createItem(defId, 1);
      if (!inv.tryAddItem(item)) return { ok: false, why: 'bag full' };
      if (!inv.equip(item.uid, 'primary')) return { ok: false, why: 'equip refused' };
      // the previous primary went back into the bag: drop it so the next unique still fits
      if (prev) inv.dropItem(prev);
      if (ammoId) inv.tryAddItem(loot.createItem(ammoId, ammoQty ?? 50));
      return { ok: true, uid: item.uid };
    };
    // enemies fight back between sections: patch the player up (revive if a swarm downed it)
    window.__heal = () => { const p = ctx.player; if (p.isDowned) p.revive(); p.heal(1000); return { hp: p.hp, downed: p.isDowned, dead: p.isDead }; };
    window.__face = (yaw) => {
      const p = ctx.player;
      const pos = p.position.clone();
      p.teleport(pos, yaw, true);
    };
    window.__spawnAhead = (type, dist, side = 0, chase = false) => {
      const p = ctx.player;
      const f = p.getForward(new p.position.constructor());
      const r = new p.position.constructor(-f.z, 0, f.x);
      const x = p.position.x + f.x * dist + r.x * side, z = p.position.z + f.z * dist + r.z * side;
      const e = window.__sys.debugSpawn(type, { x, z }, chase);
      return e ? { id: e.id, hp: e.hp, x: e.position.x, z: e.position.z } : null;
    };
    window.__enemy = (id) => {
      const e = ctx.enemies.getEnemies().find((x) => x.id === id);
      return e ? { id, hp: e.hp, dead: e.isDead, incap: e.isIncapacitated, pos: [e.position.x, e.position.y, e.position.z] } : null;
    };
    window.__killAll = () => ctx.enemies.killAll();
    window.__loadout = () => { const l = ctx.inventory.getLoadout(); return { p: l.primary?.defId, mag: l.primary?.ammoInMag, dur: l.primary?.durability }; };
  });

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.5);
  await P(() => window.__killAll());
  await P(() => window.__game.ctx.enemies.setThreatLevel(0));
  const yaw0 = await P(() => window.__game.ctx.player.yaw);
  await P((y) => window.__face(y), yaw0);
  await waitSim(0.3);

  /* ───────────── 화염방사기 ───────────── */
  console.log('u_flame');
  await clearEv();
  const eqF = await P(() => window.__equip('wpn_u_flame', 'ammo_fuel', 100));
  ok(eqF.ok, 'wpn_u_flame created + equipped in 주무기 I', JSON.stringify(eqF));
  await waitSim(0.6);
  let eq = await lastEv('weapon:equipped');
  ok(eq && eq.weaponId === 'u_flame' && eq.magSize === 120 && /인페르노/.test(eq.name), 'weapon:equipped u_flame (120 fuel, 「인페르노」)', JSON.stringify(eq));
  let sc = await lastEv('weapon:scopeChanged');
  ok(!sc || sc.zoom === 1, 'altFire unique: no ADS zoom (scope zoom 1)', JSON.stringify(sc));
  const charger = await P(() => window.__spawnAhead('charger', 6));
  ok(!!charger, 'charger spawned 6 m ahead', JSON.stringify(charger));
  await waitSim(0.2);
  await clearEv();
  await mouseDown(0);
  await waitSim(1.0);
  const mid = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), beam: window.__ev['weapon:beamChanged'][0] }), charger.id);
  ok(mid.beam && mid.beam.active === true && mid.beam.mode === 'primary', 'weapon:beamChanged {active, primary} on LMB hold', JSON.stringify(mid.beam));
  ok(mid.e && mid.e.hp < charger.hp, `flame cone damages the charger (${charger.hp} → ${mid.e?.hp?.toFixed(0)})`, JSON.stringify(mid.e));
  ok(mid.lo.mag < 120 && mid.lo.mag > 100, `fuel drains ~12/s (mag ${mid.lo.mag} after 1 s)`);
  await waitSim(2.2);
  await mouseUp(0);
  await waitSim(0.3);
  const after = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), beam: window.__ev['weapon:beamChanged'].slice(-1)[0],
    inc: window.__ev['enemy:incinerated'], fired: window.__ev['weapon:fired'].length, dur: window.__ev['weapon:durabilityChanged'].slice(-1)[0] }), charger.id);
  ok(after.beam && after.beam.active === false, 'beam ends on release', JSON.stringify(after.beam));
  ok(after.inc.length >= 1 && after.inc[0].id === charger.id, `enemy:incinerated after ~2.5 s of flame (${after.inc.length})`, JSON.stringify(after.inc[0]));
  ok(after.e && (after.e.incap || after.e.dead), 'charger isIncapacitated (전소)', JSON.stringify(after.e));
  ok(after.fired >= 20, `weapon:fired ticks at ~10 Hz while spraying (${after.fired})`);
  ok(after.lo.dur <= 1500 - 3 && after.lo.dur >= 1500 - 5, `durability −1 per second of spray (${after.lo.dur})`);
  // RMB jet
  await clearEv();
  await mouseSim(2, 0.5);
  await waitSim(0.2);
  const jet = await P(() => ({ alt: window.__ev['weapon:altFired'].length, beams: window.__ev['weapon:beamChanged'] }));
  ok(jet.alt >= 1 && jet.beams.some((b) => b.active && b.mode === 'alt') && jet.beams.slice(-1)[0].active === false, 'RMB jet: weapon:altFired + beam alt on/off', JSON.stringify(jet));
  await P(() => window.__killAll());
  await waitSim(0.3);
  ok((await P(() => window.__heal())).hp >= 100, 'player patched up after the flame section');

  /* ───────────── 전격총 ───────────── */
  console.log('u_shock');
  await clearEv();
  const eqS = await P(() => window.__equip('wpn_u_shock', 'ammo_cell', 60));
  ok(eqS.ok, 'wpn_u_shock equipped', JSON.stringify(eqS));
  await waitSim(0.6);
  eq = await lastEv('weapon:equipped');
  ok(eq && eq.weaponId === 'u_shock' && eq.magSize === 48, 'weapon:equipped u_shock (48 cells)', JSON.stringify(eq));
  const w1 = await P(() => window.__spawnAhead('warrior', 6, -1.2));
  const w2 = await P(() => window.__spawnAhead('warrior', 7, 1.4));
  await waitSim(0.2);
  await clearEv();
  await mouseSim(0, 1.0);
  await waitSim(0.2);
  const arc = await P(([a, b]) => ({ e1: window.__enemy(a), e2: window.__enemy(b), lo: window.__loadout(), shocked: window.__ev['enemy:shocked'], beams: window.__ev['weapon:beamChanged'] }), [w1.id, w2.id]);
  ok(arc.e1 && arc.e1.hp < w1.hp && arc.e2 && arc.e2.hp < w2.hp, `arc damages both warriors (${w1.hp}→${arc.e1?.hp?.toFixed(0)}, ${w2.hp}→${arc.e2?.hp?.toFixed(0)})`);
  ok(arc.shocked.length >= 2, `enemy:shocked for both targets (${arc.shocked.length})`);
  ok(arc.lo.mag < 48 && arc.lo.mag >= 38, `cells drain ~8/s (mag ${arc.lo.mag})`);
  ok(arc.beams.length >= 2 && arc.beams[0].active && !arc.beams.slice(-1)[0].active, 'arc beamChanged on/off');
  // RMB charge → bolt
  await clearEv();
  const magBefore = (await P(() => window.__loadout())).mag;
  await mouseDown(2);
  await waitSim(0.6);
  const charging = await P(() => window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'charge'));
  ok(charging.length >= 3 && charging.slice(-1)[0].t > 0.3 && charging.slice(-1)[0].t < 1, `chargeChanged kind:'charge' rising while RMB held (t=${charging.slice(-1)[0]?.t?.toFixed(2)})`);
  await waitSim(0.7);
  await mouseUp(2);
  await waitSim(0.2);
  const bolt = await P(() => ({ alt: window.__ev['weapon:altFired'].length, last: window.__ev['weapon:chargeChanged'].slice(-1)[0], hits: window.__ev['weapon:hit'].length, lo: window.__loadout(), fired: window.__ev['weapon:fired'].length }));
  ok(bolt.alt === 1 && bolt.last.t === -1, 'release → weapon:altFired + chargeChanged t:-1', JSON.stringify(bolt));
  ok(bolt.lo.mag === magBefore - 6, `bolt consumes SHOCK_CHARGE_CELLS (${magBefore} → ${bolt.lo.mag})`);
  ok(bolt.hits >= 1, 'charged bolt hits something (weapon:hit)');
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => window.__heal());

  /* ───────────── 표창 + 용검 ───────────── */
  console.log('u_shuriken');
  await clearEv();
  const eqK = await P(() => window.__equip('wpn_u_shuriken', 'ammo_shuriken', 40));
  ok(eqK.ok, 'wpn_u_shuriken equipped', JSON.stringify(eqK));
  await waitSim(0.6);
  const hunter = await P(() => window.__spawnAhead('warrior', 5));
  await waitSim(0.2);
  await clearEv();
  await click(0);
  await waitSim(0.5);
  const one = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), fired: window.__ev['weapon:fired'].length }), hunter.id);
  ok(one.lo.mag === 9 && one.fired === 1, `LMB throws one star (mag 10 → ${one.lo.mag})`);
  ok(one.e && one.e.hp < hunter.hp, `star hits the warrior (${hunter.hp} → ${one.e?.hp?.toFixed(0)})`, JSON.stringify(one.e));
  await clearEv();
  await click(2);
  await waitSim(0.3);
  const three = await P(() => ({ lo: window.__loadout(), alt: window.__ev['weapon:altFired'].length }));
  ok(three.lo.mag === 6 && three.alt === 1, `RMB fans three stars (mag → ${three.lo.mag}, altFired ${three.alt})`);
  // melee tap = light swing
  await waitSim(1.0);
  await clearEv();
  await tap('KeyF');
  await waitSim(0.5);
  const light = await P(() => ({ swing: window.__ev['melee:swing'].length, slashed: window.__ev['player:slashed'].length, charge: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'slash') }));
  ok(light.swing === 1 && light.slashed === 0, 'F tap = normal melee swing (melee:swing, no slash)', JSON.stringify(light));
  ok(light.charge.length >= 1 && light.charge.slice(-1)[0].t === -1, 'slash gauge opens on press and closes at -1 on the tap');
  // melee hold ≥ SLASH_HOLD_TIME → big slash
  await waitSim(1.0);
  await clearEv();
  const stBefore = await P(() => ({ st: window.__game.ctx.player.stamina, max: window.__game.ctx.player.maxStamina }));
  const sl = await P(() => window.__spawnAhead('warrior', 2.6));
  await waitSim(0.15);
  await keyDown('KeyF');
  await waitSim(0.7);
  const holdG = await P(() => window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'slash').slice(-1)[0]);
  ok(holdG && holdG.t === 1, 'slash gauge reaches 1 while F is held', JSON.stringify(holdG));
  await keyUp('KeyF');
  await waitSim(0.1);
  const stAfter = await P(() => ({ st: window.__game.ctx.player.stamina, widen: window.__game.getSystem('player')?.rig?.viewWiden ?? null, meleeing: window.__game.ctx.player.isMeleeing }));
  ok(Math.abs((stBefore.st - stAfter.st) - stBefore.max * 0.5) < 2, `big slash costs 50 % stamina (${stBefore.st.toFixed(0)} → ${stAfter.st.toFixed(0)} of ${stBefore.max})`);
  ok(stAfter.widen === true || stAfter.widen === null, 'setViewWiden(true) during the slash', JSON.stringify(stAfter));
  await waitSim(0.8);
  const slash = await P((id) => ({ slashed: window.__ev['player:slashed'], e: window.__enemy(id), hits: window.__ev['melee:hit'].length, widen: window.__game.getSystem('player')?.rig?.viewWiden ?? null }), sl.id);
  ok(slash.slashed.length === 1 && slash.slashed[0].hits >= 1, `player:slashed with ${slash.slashed[0]?.hits} hit(s)`, JSON.stringify(slash.slashed));
  ok(slash.e && (slash.e.dead || slash.e.hp <= sl.hp - 280 + 1), 'SLASH_DAMAGE 280 landed on the warrior', JSON.stringify(slash.e));
  ok(slash.widen === false || slash.widen === null, 'setViewWiden(false) after SLASH_DURATION');
  // refused when short on stamina
  await clearEv();
  await P(() => { const p = window.__game.ctx.player; p.consumeStamina(p.stamina - 5); });
  await waitSim(1.2);
  await keyDown('KeyF'); await waitSim(0.6); await keyUp('KeyF'); await waitSim(0.2);
  const refused = await P(() => ({ slashed: window.__ev['player:slashed'].length, notify: window.__ev['ui:notify'].some((n) => /스태미나/.test(n.text)) }));
  ok(refused.slashed === 0 && refused.notify, 'slash refused + 스태미나 toast when short', JSON.stringify(refused));
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => window.__heal());

  /* ───────────── 컴포짓 보우 ───────────── */
  console.log('u_bow');
  await waitSim(2.0);
  await clearEv();
  const eqB = await P(() => window.__equip('wpn_u_bow', 'ammo_arrow', 30));
  ok(eqB.ok, 'wpn_u_bow equipped', JSON.stringify(eqB));
  await waitSim(0.6);
  sc = await lastEv('weapon:scopeChanged');
  ok(sc && Math.abs(sc.zoom - 1.6) < 1e-6, 'bow keeps ADS (scopeChanged zoom 1.6)', JSON.stringify(sc));
  const bw = await P(() => window.__spawnAhead('warrior', 8));
  await waitSim(0.2);
  await clearEv();
  await click(0);
  await waitSim(0.6);
  const arrow = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), fired: window.__ev['weapon:fired'].length }), bw.id);
  ok(arrow.fired === 1 && arrow.lo.mag === 11, `LMB looses one arrow (mag 12 → ${arrow.lo.mag})`);
  ok(arrow.e && arrow.e.hp <= bw.hp - 100, `arrow hits for BOW_DAMAGE-ish (${bw.hp} → ${arrow.e?.hp?.toFixed(0)})`, JSON.stringify(arrow.e));
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => window.__heal());

  /* ───────────── 바주카 ───────────── */
  console.log('u_bazooka');
  await clearEv();
  const eqZ = await P(() => window.__equip('wpn_u_bazooka', 'ammo_rocket', 6));
  ok(eqZ.ok, 'wpn_u_bazooka equipped', JSON.stringify(eqZ));
  await waitSim(0.6);
  const bz = await P(() => window.__spawnAhead('warrior', 14));
  const bz2 = await P(() => window.__spawnAhead('scavenger', 15, 2));
  await waitSim(0.2);
  await clearEv();
  const hpBefore = await P(() => window.__game.ctx.player.hp);
  await click(0);
  await waitSim(1.2);
  const rocket = await P(([a, b]) => ({ e: window.__enemy(a), e2: window.__enemy(b), lo: window.__loadout(), hits: window.__ev['weapon:hit'], reload: window.__ev['weapon:reloadStarted'].length, hp: window.__game.ctx.player.hp }), [bz.id, bz2.id]);
  ok(rocket.hits.length >= 1 && rocket.hits.some((h) => h.damage >= 400), 'rocket explodes (weapon:hit with blast damage)', JSON.stringify(rocket.hits.slice(-1)));
  ok(rocket.e && (rocket.e.dead || rocket.e.hp < bz.hp), `blast damages the warrior (${bz.hp} → ${rocket.e?.hp?.toFixed(0)})`, JSON.stringify(rocket.e));
  ok(rocket.e2 && (rocket.e2.dead || rocket.e2.hp < bz2.hp), 'area damage reaches the scavenger 2 m aside');
  ok(rocket.hp === hpBefore, 'no self damage from a far blast');
  ok(rocket.reload >= 1, 'empty tube reloads itself (weapon:reloadStarted)');
  await waitSim(3.5);
  ok((await P(() => window.__loadout())).mag === 1, 'tube reloaded to 1 rocket');
  // rocket jump: airborne, aim at the feet, RMB air-burst
  await clearEv();
  await P(() => window.__heal());
  const hpJump = await P(() => window.__game.ctx.player.hp);
  await P(() => window.__game.ctx.player.applyImpulse(new (window.__game.ctx.player.position.constructor)(0, 7, 0)));
  await waitSim(0.15);
  await look(0, 3000);
  await waitSim(0.05);
  const air = await P(() => ({ grounded: window.__game.ctx.player.isGrounded, vy: window.__game.ctx.player.velocity.y, pitch: window.__game.ctx.player.pitch }));
  await click(2);
  await waitSim(0.6);
  const jump = await P(() => ({ alt: window.__ev['weapon:altFired'].length, blast: window.__ev['player:blastJump'], hp: window.__game.ctx.player.hp, vy: window.__game.ctx.player.velocity.y, hits: window.__ev['weapon:hit'] }));
  ok(!air.grounded && air.pitch < -0.6, `airborne and looking down before the shot (pitch ${air.pitch?.toFixed(2)})`, JSON.stringify(air));
  ok(jump.alt === 1, 'RMB rocket → weapon:altFired');
  ok(jump.blast.length === 1 && jump.blast[0].impulse[1] === 17, 'player:blastJump with BAZOOKA_SUPER_JUMP', JSON.stringify(jump.blast));
  ok(jump.hp <= hpJump - 22 + 0.01, `self damage 22 (hp ${hpJump} → ${jump.hp})`);
  ok(jump.vy > air.vy + 5, `velocity.y raised by the blast (${air.vy.toFixed(1)} → ${jump.vy.toFixed(1)})`);
  await waitSim(3);
  await P((y) => window.__face(y), yaw0);
  await look(0, -3000);
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => window.__heal());

  /* ───────────── 미니건 ───────────── */
  console.log('u_minigun');
  await waitSim(1.0);
  await clearEv();
  const eqM = await P(() => window.__equip('wpn_u_minigun', 'ammo_belt', 150));
  ok(eqM.ok, 'wpn_u_minigun equipped', JSON.stringify(eqM));
  await waitSim(0.6);
  const mg = await P(() => window.__spawnAhead('warrior', 7, 0, true));
  await waitSim(0.2);
  await clearEv();
  await mouseDown(0);
  await waitSim(0.6);
  const spinning = await P(() => ({ fired: window.__ev['weapon:fired'].length, spin: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'spinup') }));
  ok(spinning.fired === 0, 'no shot before MINIGUN_SPINUP_TIME (0.6 s in)');
  ok(spinning.spin.length >= 3 && spinning.spin.slice(-1)[0].t > 0.3 && spinning.spin.slice(-1)[0].t < 1, `chargeChanged kind:'spinup' rising (t=${spinning.spin.slice(-1)[0]?.t?.toFixed(2)})`);
  await waitSim(1.4);
  const firing = await P((id) => ({ fired: window.__ev['weapon:fired'].length, e: window.__enemy(id), lo: window.__loadout(), spin: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'spinup').slice(-1)[0] }), mg.id);
  ok(firing.fired >= 8, `fires after spin-up (${firing.fired} shots in ~0.8 s)`);
  ok(firing.spin && firing.spin.t === 1, 'spin gauge at 1 while firing');
  ok(firing.e && firing.e.hp < mg.hp, `minigun rounds hit the warrior (${mg.hp} → ${firing.e?.hp?.toFixed(0)})`, JSON.stringify(firing.e));
  ok(firing.lo.mag < 150, `belt drains (mag ${firing.lo.mag})`);
  await mouseUp(0);
  await waitSim(1.2);
  const down = await P(() => window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'spinup').slice(-1)[0]);
  ok(down && down.t === -1, 'spin-down ends with chargeChanged t:-1', JSON.stringify(down));
  // RMB = keep spun, no ammo
  await clearEv();
  await mouseDown(2);
  await waitSim(1.6);
  const pre = await P(() => ({ fired: window.__ev['weapon:fired'].length, spin: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'spinup').slice(-1)[0], speed: window.__game.ctx.player.velocity.length() }));
  ok(pre.fired === 0 && pre.spin && pre.spin.t === 1, 'RMB hold keeps the barrels spun without firing', JSON.stringify(pre));
  await mouseDown(0);
  await waitSim(0.25);
  const instant = await P(() => window.__ev['weapon:fired'].length);
  ok(instant >= 3, `LMB fires instantly while pre-spun (${instant} shots in 0.25 s)`);
  await mouseUp(0); await mouseUp(2);
  await waitSim(1.2);
  await P(() => window.__killAll());

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
