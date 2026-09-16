// Single-player smoke test for the six unique weapons (Phase 6): 「인페르노」 flamethrower, 「테슬라 코일」 shock gun,
// 「카게」 shuriken + 용검 slash, 「롱혼」 bow, 「해머헤드」 bazooka (+ rocket jump), 「사이클론」 minigun (spin-up / RMB pre-spin).
// Usage: node scripts/smoke-uniques.mjs [http://localhost:5273]   (needs a running vite)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    // never take a real pointer lock in headless mode (Windows ClipCursor trap); the script fakes `pointerLockElement`
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // park the vite HMR socket: another editor's save would full-reload the page mid-run
  await quietViteHmr(page);
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
  const mid = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), beam: window.__ev['weapon:beamChanged'][0], rs: { ...window.__game.ctx.weapons.remoteState } }), charger.id);
  ok(mid.beam && mid.beam.active === true && mid.beam.mode === 'primary', 'weapon:beamChanged {active, primary} on LMB hold', JSON.stringify(mid.beam));
  ok(mid.rs.spraying === true && mid.rs.charging === false, 'remoteState.spraying while the flame is on (Phase 7)', JSON.stringify(mid.rs));
  ok(mid.e && mid.e.hp < charger.hp, `flame cone damages the charger (${charger.hp} → ${mid.e?.hp?.toFixed(0)})`, JSON.stringify(mid.e));
  ok(mid.lo.mag < 120 && mid.lo.mag > 100, `fuel drains ~12/s (mag ${mid.lo.mag} after 1 s)`);
  await waitSim(2.2);
  await mouseUp(0);
  await waitSim(0.3);
  const after = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), beam: window.__ev['weapon:beamChanged'].slice(-1)[0],
    inc: window.__ev['enemy:incinerated'], fired: window.__ev['weapon:fired'].length, dur: window.__ev['weapon:durabilityChanged'].slice(-1)[0] }), charger.id);
  ok(after.beam && after.beam.active === false, 'beam ends on release', JSON.stringify(after.beam));
  ok((await P(() => window.__game.ctx.weapons.remoteState.spraying)) === false, 'remoteState.spraying clears on release');
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
  const rsC = await P(() => ({ ...window.__game.ctx.weapons.remoteState }));
  ok(rsC.charging === true && rsC.spraying === false, 'remoteState.charging while the bolt charges (Phase 7)', JSON.stringify(rsC));
  await waitSim(0.7);
  await mouseUp(2);
  await waitSim(0.2);
  const bolt = await P(() => ({ alt: window.__ev['weapon:altFired'].length, last: window.__ev['weapon:chargeChanged'].slice(-1)[0], hits: window.__ev['weapon:hit'].length, lo: window.__loadout(), fired: window.__ev['weapon:fired'].length }));
  ok(bolt.alt === 1 && bolt.last.t === -1, 'release → weapon:altFired + chargeChanged t:-1', JSON.stringify(bolt));
  ok((await P(() => window.__game.ctx.weapons.remoteState.charging)) === false, 'remoteState.charging clears after the bolt');
  ok(bolt.lo.mag === magBefore - 6, `bolt consumes SHOCK_CHARGE_CELLS (${magBefore} → ${bolt.lo.mag})`);
  ok(bolt.hits >= 1, 'charged bolt hits something (weapon:hit)');
  // 2026-09-14 (「좌클이 아예 안 나간다」): with nothing in the cone the arc used to draw and sound nothing at all
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => {
    if (!window.__shockAudio) { window.__shockAudio = []; window.__game.ctx.bus.on('audio:play', (a) => { if (window.__shockRec) window.__shockAudio.push(a.id); }); }
    window.__shockAudio.length = 0; window.__shockRec = true;
  });
  await clearEv();
  await mouseDown(0);
  await waitSim(0.5);
  const fizz = await P(() => {
    const a = window.__game.getSystem('weapons').ufx.arcs.find((x) => x.owner === 'local');
    return { visible: !!a && a.glow.visible, count: a?.count ?? 0, sparks: a?.sparks, beam: window.__ev['weapon:beamChanged'][0],
      crackles: window.__shockAudio.filter((id) => id === 'shot_energy').length, hits: window.__ev['ui:hitmarker'].length };
  });
  await mouseUp(0);
  await P(() => { window.__shockRec = false; });
  await waitSim(0.2);
  ok(fizz.beam && fizz.beam.active === true, 'no target: LMB still turns the arc on (weapon:beamChanged)', JSON.stringify(fizz.beam));
  ok(fizz.visible && fizz.count >= 1 && fizz.sparks === false, `no target: forked discharge drawn toward the crosshair (${fizz.count} forks)`, JSON.stringify(fizz));
  ok(fizz.crackles >= 2, `the arc crackles while held (shot_energy ×${fizz.crackles} in 0.5 s)`);
  ok(fizz.hits === 0, 'no hitmarker without a target');
  // third-person offsets: a warrior farther out and well off the crosshair line is still reached
  const far = await P(() => window.__spawnAhead('warrior', 11, 2.5));
  await waitSim(0.2);
  await clearEv();
  await mouseSim(0, 0.8);
  await waitSim(0.2);
  const farR = await P((id) => ({ e: window.__enemy(id), shocked: window.__ev['enemy:shocked'].length }), far.id);
  ok(farR.e && farR.e.hp < far.hp && farR.shocked >= 1, `arc reaches a warrior 11 m ahead, 2.5 m aside (${far.hp} → ${farR.e?.hp?.toFixed(0)})`, JSON.stringify(farR));
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
  // 2026-09-15 장전 없음: the magazine is the one nocked arrow, fed straight from the quiver — ammoInMag + reserveRounds is
  // always the arrows carried, no reload ever starts (R included), no '탄약 없음' toast. Separate watchers: `clearEv` wipes __ev.
  await P(() => {
    const bus = window.__game.ctx.bus;
    window.__bowWatch = { reloads: 0, noAmmo: 0 };
    bus.on('weapon:reloadStarted', () => { window.__bowWatch.reloads++; });
    bus.on('ui:notify', (n) => { if (/탄약 없음/.test(n.text)) window.__bowWatch.noAmmo++; });
    window.__bowAmmo = () => {
      const ws = window.__game.getSystem('weapons'); const w = ws.slots[ws.active];
      const last = window.__ev['weapon:ammoChanged'].slice(-1)[0] ?? null;
      return { mag: ws.magOf(w), res: ws.reserveOf(w), magSize: w.stats.magSize, ev: last ? last.ammoInMag + last.reserveRounds : null, phase: ws.phase };
    };
    // weapon-space pose of the bow model (2026-09-15 가로 파지: limbs ±X, string behind the riser at +Z, muzzle at the arrow tip)
    window.__bowPose = () => {
      const ws = window.__game.getSystem('weapons'); const m = ws.slots[ws.active].model;
      const s0 = m.bowStrings[0], s1 = m.bowStrings[1];
      return { limbX: m.bowLimbs.map((l) => +l.position.x.toFixed(3)), nockX: [s0.position.x, s1.position.x].map((v) => +v.toFixed(3)),
        nockY: +s0.position.y.toFixed(3), stringZ: +s0.position.z.toFixed(3), halfLen: +s0.scale.x.toFixed(3), arrowZ: +m.bowArrow.position.z.toFixed(3),
        arrowBaseZ: +m.bowArrowBase.z.toFixed(3), arrowVis: m.bowArrow.visible, muzzleZ: +m.muzzle.position.z.toFixed(3), flex: +m.bowLimbs[0].rotation.y.toFixed(3) };
    };
  });
  const bowA0 = await P(() => window.__bowAmmo());
  // (the quiver count is relative: how many of the 30 arrows one `createItem` stack holds follows the ammo stack table)
  const res0 = bowA0.res;
  ok(bowA0.magSize === 1 && bowA0.mag === 1 && res0 > 3 && (bowA0.ev === null || bowA0.ev === 1 + res0), `bow: one nocked arrow + a quiver (mag ${bowA0.mag}/${bowA0.magSize}, reserve ${res0})`, JSON.stringify(bowA0));
  const pose0 = await P(() => window.__bowPose());
  ok(pose0.limbX[0] > 0.1 && pose0.limbX[1] < -0.1 && Math.abs(pose0.nockX[0]) > 0.5 && Math.abs(pose0.nockX[1]) > 0.5, 'bow held horizontally: limbs spread along ±X', JSON.stringify(pose0));
  ok(pose0.stringZ > 0 && pose0.arrowZ === pose0.stringZ && pose0.muzzleZ < -0.6 && pose0.arrowVis, 'string behind the riser (+Z) with the arrow tail on it, muzzle at the arrow tip', JSON.stringify(pose0));
  // 2026-09-14 활 시위: LMB hold draws (BOW_DRAW_TIME 0.8 s), release shoots; RMB cancels; no ADS any more
  sc = await lastEv('weapon:scopeChanged');
  ok(!sc || sc.zoom === 1, 'bow no longer aims (scope zoom 1)', JSON.stringify(sc));
  const bw = await P(() => window.__spawnAhead('warrior', 8));
  await waitSim(0.2);
  await clearEv();
  // full draw
  await mouseDown(0);
  await waitSim(0.4);
  const drawMid = await P(() => ({ draw: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'draw'), rs: { ...window.__game.ctx.weapons.remoteState }, fired: window.__ev['weapon:fired'].length }));
  const midT = drawMid.draw.slice(-1)[0]?.t;
  ok(drawMid.draw.length >= 3 && drawMid.draw[0].t === 0 && midT > 0.2 && midT < 0.95, `chargeChanged kind:'draw' rising from 0 while LMB held (t=${midT?.toFixed?.(2)})`, JSON.stringify(drawMid.draw.slice(0, 2)));
  ok(drawMid.fired === 0 && drawMid.rs.charging === true, 'no arrow while drawing + remoteState.charging', JSON.stringify(drawMid));
  const poseMid = await P(() => window.__bowPose());
  ok(poseMid.arrowZ > pose0.arrowZ + 0.04 && poseMid.stringZ >= pose0.stringZ && poseMid.flex < 0, `the draw pulls the string + arrow toward the body (+Z ${pose0.arrowZ} → ${poseMid.arrowZ}), limbs flex`, JSON.stringify(poseMid));
  await waitSim(0.55);
  await mouseUp(0);
  await waitSim(0.5);
  const arrow = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), fired: window.__ev['weapon:fired'].length,
    draw: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'draw'), rs: window.__game.ctx.weapons.remoteState.charging }), bw.id);
  const fullT = arrow.draw.filter((c) => c.t >= 0).slice(-1)[0]?.t;
  const bowA1 = await P(() => window.__bowAmmo());
  ok(arrow.fired === 1 && bowA1.mag === 1 && bowA1.res === res0 - 1 && bowA1.ev === res0,`release looses one arrow, the next is nocked at once (mag ${bowA1.mag}, reserve ${bowA1.res}, HUD total ${bowA1.ev})`, JSON.stringify(bowA1));
  ok(fullT === 1 && arrow.draw.slice(-1)[0].t === -1, `draw reached 1 and closed with t:-1 (last t ${fullT})`);
  ok(arrow.rs === false, 'remoteState.charging clears after the release');
  const fullDmg = arrow.e ? bw.hp - arrow.e.hp : 0;
  ok(arrow.e && fullDmg >= 140, `full-draw arrow hits for BOW_DAMAGE (${bw.hp} → ${arrow.e?.hp?.toFixed(0)})`, JSON.stringify(arrow.e));
  // tap: weak arrow
  await P(() => window.__killAll());
  await waitSim(0.5);
  const bt = await P(() => window.__spawnAhead('warrior', 8));
  await waitSim(0.3);
  await clearEv();
  await click(0);
  await waitSim(0.6);
  const tapA = await P((id) => ({ e: window.__enemy(id), lo: window.__loadout(), fired: window.__ev['weapon:fired'].length,
    draw: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'draw') }), bt.id);
  const tapDmg = tapA.e ? bt.hp - tapA.e.hp : 0;
  const bowA2 = await P(() => window.__bowAmmo());
  ok(tapA.fired === 1 && bowA2.mag === 1 && bowA2.res === res0 - 2 &&tapA.draw.slice(-1)[0]?.t === -1, `tap looses one arrow at once (reserve → ${bowA2.res}, draw closed)`, JSON.stringify({ a: bowA2, d: tapA.draw }));
  ok(tapDmg > 0 && tapDmg < fullDmg * 0.8, `tap arrow is weaker (${tapDmg.toFixed(0)} vs full ${fullDmg.toFixed(0)})`, JSON.stringify(tapA.e));
  // RMB during the draw cancels: no arrow, no ammo
  await waitSim(0.5);
  await clearEv();
  await mouseDown(0);
  await waitSim(0.4);
  await click(2);
  await waitSim(0.15);
  await mouseUp(0);
  await waitSim(0.4);
  const cancel = await P(() => ({ lo: window.__loadout(), fired: window.__ev['weapon:fired'].length, draw: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'draw'),
    sc: window.__ev['weapon:scopeChanged'].slice(-1)[0], aiming: window.__game.ctx.player.isAiming }));
  const bowA3 = await P(() => window.__bowAmmo());
  ok(cancel.fired === 0 && bowA3.mag === 1 && bowA3.res === res0 - 2,`RMB cancels the draw: no arrow, no ammo (reserve ${bowA3.res}, fired ${cancel.fired})`);
  ok(cancel.draw.length >= 2 && cancel.draw.slice(-1)[0].t === -1, 'cancel closes the draw with t:-1', JSON.stringify(cancel.draw.slice(-2)));
  ok(!cancel.aiming && (!cancel.sc || cancel.sc.zoom === 1), 'RMB never enters ADS with the bow', JSON.stringify(cancel));
  // R never reloads the bow
  await tap('KeyR');
  await waitSim(0.4);
  const afterR = await P(() => ({ a: window.__bowAmmo(), w: { ...window.__bowWatch } }));
  ok(afterR.w.reloads === 0 && afterR.a.phase === 'ready' && afterR.a.mag === 1, 'R does nothing with the bow (no reload)', JSON.stringify(afterR));
  // out of arrows: shoot the nocked one, then a press is a dry click — no draw, no reload, no toast
  await P(() => window.__game.ctx.inventory.consumeWhere((d) => d.category === 'ammo' && d.ammoType === 'arrow', 999));
  await waitSim(0.4);
  await click(0);
  await waitSim(0.6);
  await clearEv();
  const emptyA = await P(() => ({ a: window.__bowAmmo(), pose: window.__bowPose() }));
  ok(emptyA.a.mag === 0 && emptyA.a.res === 0 && emptyA.pose.arrowVis === false, 'last arrow shot: string empty, nothing nocked', JSON.stringify(emptyA));
  await mouseDown(0);
  await waitSim(0.4);
  const dry = await P(() => ({ dry: window.__ev['weapon:dryFire'].length, draw: window.__ev['weapon:chargeChanged'].filter((c) => c.kind === 'draw').length, fired: window.__ev['weapon:fired'].length, rs: window.__game.ctx.weapons.remoteState.charging }));
  await mouseUp(0);
  await tap('KeyR');
  await waitSim(0.4);
  const dryW = await P(() => ({ ...window.__bowWatch, phase: window.__game.getSystem('weapons').phase }));
  ok(dry.dry === 1 && dry.draw === 0 && dry.fired === 0 && dry.rs === false, 'no arrows: LMB is a dry click and never draws', JSON.stringify(dry));
  ok(dryW.reloads === 0 && dryW.noAmmo === 0 && dryW.phase === 'ready', 'no arrows: no reload, no 탄약 없음 toast (LMB or R)', JSON.stringify(dryW));
  // picking arrows up re-nocks on its own
  await P(() => window.__game.ctx.inventory.tryAddItem(window.__game.ctx.loot.createItem('ammo_arrow', 5)));
  await waitSim(0.6);
  const refed = await P(() => ({ a: window.__bowAmmo(), pose: window.__bowPose() }));
  ok(refed.a.mag === 1 && refed.a.res === 4 && refed.a.ev === 5 && refed.pose.arrowVis, `picked-up arrows are nocked without a reload (mag ${refed.a.mag}, reserve ${refed.a.res}, HUD total ${refed.a.ev})`, JSON.stringify(refed));
  await P(() => window.__killAll());
  await waitSim(0.3);
  await P(() => window.__heal());

  /* ───────────── 바주카 ───────────── */
  console.log('u_bazooka');
  await clearEv();
  const eqZ = await P(() => window.__equip('wpn_u_bazooka', 'ammo_rocket', 6));
  ok(eqZ.ok, 'wpn_u_bazooka equipped', JSON.stringify(eqZ));
  await waitSim(0.6);
  ok((await P(() => window.__game.ctx.weapons.remoteState.heavy)) === true, 'remoteState.heavy with the bazooka in hand (Phase 7)');
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
  // 2026-09-14: 3-rocket tube at BAZOOKA_FIRE_RATE 2.85 (≈ 0.35 s). One shot leaves 2 and does not reload; the next two
  // clicks 0.5 s apart both fire (the old 1.25 s interval would have eaten the second one).
  ok(rocket.lo.mag === 2 && rocket.reload === 0, `one rocket spent, no reload yet (mag 3 → ${rocket.lo.mag})`, JSON.stringify(rocket));
  await P(() => window.__killAll());
  await clearEv();
  await click(0);
  await waitSim(0.5);
  await click(0);
  await waitSim(0.3);
  const burst = await P(() => ({ fired: window.__ev['weapon:fired'].length, mag: window.__loadout().mag }));
  ok(burst.fired === 2 && burst.mag === 0, `two more rockets 0.5 s apart both fire (fired ${burst.fired}, mag ${burst.mag})`, JSON.stringify(burst));
  // the auto-reload starts a beat after the shot, so sample the event **after** waiting it out (it used to be read
  // at 1.2 s, which raced under a loaded GPU lane)
  await waitSim(3.5);
  const reloaded = await P(() => ({ mag: window.__loadout().mag, reload: window.__ev['weapon:reloadStarted'].length }));
  ok(reloaded.reload >= 1, 'empty tube reloads itself (weapon:reloadStarted)', JSON.stringify(reloaded));
  ok(reloaded.mag === 3, `tube reloaded to 3 rockets (${reloaded.mag})`);
  /* 2026-09-15 (사용자 결정): 넉백 거리 ×BAZOOKA_KNOCKBACK_DIST_MUL 0.5, 지상이면 ×BAZOOKA_GROUNDED_DIST_MUL 0.5 한 번 더 —
     속도에는 제곱근이다 (15 × √0.5 × √0.5 = 7.5). 지상 폭발은 로켓 점프가 아니다 (넉백이 `grounded` 를 먼저 끄던 버그). */
  await P(() => window.__killAll());
  await clearEv();
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'grounded before the feet blast', 30000);
  await P(() => {
    const p = window.__game.ctx.player;
    window.__kb = [];
    window.__origKB = window.__origKB ?? p.applyKnockback.bind(p);
    p.applyKnockback = (d, s) => { window.__kb.push({ s, grounded: p.isGrounded }); return window.__origKB(d, s); };
  });
  await look(0, 3000);
  await waitSim(0.1);
  await click(0);
  await waitSim(0.6);
  const feet = await P(() => ({ blast: window.__ev['player:blastJump'].length, kb: window.__kb.slice(), hits: window.__ev['weapon:hit'].length }));
  ok(feet.hits >= 1 && feet.kb.length === 1 && feet.kb[0].grounded, 'LMB rocket at the feet while grounded knocks the shooter back', JSON.stringify(feet));
  ok(feet.kb[0] && Math.abs(feet.kb[0].s - 15 * Math.SQRT1_2 * Math.SQRT1_2) < 0.01, `grounded knockback speed 15 × √0.5 × √0.5 = 7.5 (${feet.kb[0]?.s?.toFixed(3)})`);
  ok(feet.blast === 0, 'a grounded blast never rocket-jumps (no player:blastJump)', JSON.stringify(feet));
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'feet blast landing', 30000);
  await waitSim(0.5);
  // rocket jump: airborne, aim at the feet, RMB air-burst
  await P(() => window.__killAll());
  await clearEv();
  await P(() => { window.__kb.length = 0; });
  await P(() => window.__heal());
  const hpJump = await P(() => window.__game.ctx.player.hp);
  // 2026-09-09: 이 구간은 원래부터 경합이었다 — 7 m/s 점프의 공중 체류가 GRAVITY 24 에서 0.58 초뿐이라
  // `look` · `click` 의 puppeteer 왕복이 조금만 늦어도 로켓이 터지기 전에 착지해 `!isGrounded` 가 깨진다.
  // 더 세게 뛰면 이번엔 폭발이 BAZOOKA_ALT_RADIUS 밖으로 멀어져 넉백도 로켓 점프도 안 난다(높이가 곧 거리다).
  // 그래서 **점프를 그대로 두고 시간을 늦춘다** — timeScale 0.2 면 같은 왕복이 시뮬 시간을 1/5 만 먹는다.
  await P(() => { window.__game.ctx.timeScale = 0.2; });
  await P(() => window.__game.ctx.player.applyImpulse(new (window.__game.ctx.player.position.constructor)(0, 7, 0)));
  await waitSim(0.15);
  await look(0, 3000);
  await waitSim(0.05);
  const air = await P(() => ({ grounded: window.__game.ctx.player.isGrounded, vy: window.__game.ctx.player.velocity.y, pitch: window.__game.ctx.player.pitch, hs: Math.hypot(window.__game.ctx.player.velocity.x, window.__game.ctx.player.velocity.z) }));
  // 2026-09-12: where the rocket left (hybrid resolver) and where it went off — printed when the jump check fails
  await P(() => {
    const ws = window.__game.getSystem('weapons'); const r2 = (v) => [v.x, v.y, v.z].map((n) => +n.toFixed(2));
    window.__origPH = window.__origPH ?? ws.onProjectileHit.bind(ws); window.__phLog = [];
    ws.onProjectileHit = (h, dmg, id) => { const p = window.__game.ctx.player; window.__phLog.push({ pt: r2(h.point), fused: h.fused, enemy: !!h.enemy, obstacle: h.obstacle, dist: +h.distance.toFixed(2), feet: r2(p.position), grounded: p.isGrounded }); return window.__origPH(h, dmg, id); };
  });
  await click(2);
  await waitSim(0.6);
  const jump = await P(() => {
    const ws = window.__game.getSystem('weapons'); const s = ws.uniqueShot; const r2 = (v) => [v.x, v.y, v.z].map((n) => +n.toFixed(2));
    ws.onProjectileHit = window.__origPH;
    return { alt: window.__ev['weapon:altFired'].length, blast: window.__ev['player:blastJump'], kb: window.__kb.slice(), hp: window.__game.ctx.player.hp, vy: window.__game.ctx.player.velocity.y, grounded: window.__game.ctx.player.isGrounded, hits: window.__ev['weapon:hit'],
      dbg: { mode: s.mode, origin: r2(s.origin), dir: r2(s.dir), target: r2(s.target), ph: window.__phLog.slice() } };
  });
  ok(!air.grounded && air.pitch < -0.6, `airborne and looking down before the shot (pitch ${air.pitch?.toFixed(2)})`, JSON.stringify(air));
  ok(jump.alt === 1, 'RMB rocket → weapon:altFired');
  ok(!jump.grounded, 'still airborne when the rocket went off (the condition the super jump needs)', JSON.stringify({ vy: jump.vy, grounded: jump.grounded }));
  // 2026-09-15 (사용자 결정): 로켓 점프 임펄스도 거리 ×0.5 → 속도 ×√0.5 (BAZOOKA_SUPER_JUMP 17 → 12.02)
  ok(jump.blast.length === 1 && Math.abs(jump.blast[0].impulse[1] - 17 * Math.SQRT1_2) < 0.01, `player:blastJump with BAZOOKA_SUPER_JUMP 17 × √0.5 (${jump.blast[0]?.impulse?.[1]?.toFixed(3)})`, JSON.stringify({ blast: jump.blast, dbg: jump.dbg }));
  ok(jump.kb.length === 1 && !jump.kb[0].grounded && Math.abs(jump.kb[0].s - 15 * Math.SQRT1_2) < 0.01, `airborne knockback speed 15 × √0.5 (${jump.kb[0]?.s?.toFixed(3)})`, JSON.stringify(jump.kb));
  // 2026-09-14: horizontal boost = BAZOOKA_JUMP_FORWARD 8 × √0.5 × min(1, speed / PLAYER_WALK_SPEED 4.2) — this jump is straight up
  const boostH = jump.blast[0] ? Math.hypot(jump.blast[0].impulse[0], jump.blast[0].impulse[2]) : -1;
  ok(boostH >= 0 && boostH <= 8 * Math.SQRT1_2 * Math.min(1, air.hs / 4.2) + 0.05, `no horizontal boost for a (nearly) standing jump (${boostH.toFixed(2)}, speed ${air.hs.toFixed(2)})`);
  ok(jump.hp === hpJump, `no self damage from the own blast (2026-09-14, hp ${hpJump} → ${jump.hp})`);
  ok(jump.vy > air.vy + 5, `velocity.y raised by the blast (${air.vy.toFixed(1)} → ${jump.vy.toFixed(1)})`);
  await P(() => { window.__game.ctx.timeScale = 1; });
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'rocket jump landing', 60000);
  await P(() => { const p = window.__game.ctx.player; if (window.__origKB) { delete p.applyKnockback; window.__origKB = null; } });
  // 2026-09-14: an impulse's horizontal momentum survives air control until landing (`PlayerController.airCarry`) — with no
  // input the old AIR_ACCEL 7 pulled 10 m/s down to ~9 in 0.15 s; now it stays
  await waitSim(0.5);
  await P(() => { window.__game.ctx.timeScale = 0.2; });
  await P(() => { const p = window.__game.ctx.player; p.applyImpulse(new p.position.constructor(10, 8, 0)); });
  await waitSim(0.75);
  const carry = await P(() => { const p = window.__game.ctx.player; return { hs: Math.hypot(p.velocity.x, p.velocity.z), grounded: p.isGrounded }; });
  ok(!carry.grounded && carry.hs >= 9.7, `impulse momentum kept in the air (horizontal ${carry.hs.toFixed(2)} m/s)`, JSON.stringify(carry));
  await P(() => { window.__game.ctx.timeScale = 1; });
  await waitFor(page, () => window.__game.ctx.player.isGrounded, 'carry landing', 60000);
  await waitSim(0.5);
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
  const rsM = await P(() => ({ ...window.__game.ctx.weapons.remoteState }));
  ok(rsM.heavy === true && rsM.charging === true, 'remoteState.heavy + charging while the minigun spins up (Phase 7)', JSON.stringify(rsM));
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
  ok((await P(() => window.__game.ctx.weapons.remoteState.charging)) === false, 'remoteState.charging clears after the spin-down');
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
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
