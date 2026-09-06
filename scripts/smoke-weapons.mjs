// Single-player smoke test for the weapon package (grades / durability / ammo v2 / 3 slots / sockets / bags / repair).
// Usage: node scripts/smoke-weapons.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    // fake pointer lock so gameplay input is accepted in headless mode
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['weapon:equipped', 'weapon:durabilityChanged', 'weapon:broken', 'weapon:swapStarted', 'weapon:ammoChanged',
      'inventory:bagChanged', 'inventory:socketChanged', 'inventory:itemUpdated', 'loadout:changed', 'hub:workbenchToggled']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const key = async (code, hold = 60) => {
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c })), code);
    await sleep(hold);
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c })), code);
  };
  const mouse = async (button, hold = 120) => {
    await page.evaluate((b) => window.dispatchEvent(new MouseEvent('mousedown', { button: b })), button);
    await sleep(hold);
    await page.evaluate((b) => window.dispatchEvent(new MouseEvent('mouseup', { button: b })), button);
  };
  // headless software rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const mouseSim = async (button, sec) => { await page.evaluate((b) => window.dispatchEvent(new MouseEvent('mousedown', { button: b })), button); await waitSim(sec); await page.evaluate((b) => window.dispatchEvent(new MouseEvent('mouseup', { button: b })), button); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };

  console.log('hub / workbench');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  const ids = await page.evaluate(() => window.__game.ctx.interactables.all().map((i) => i.id));
  ok(ids.includes('hub_workbench'), 'personal ship registers hub_workbench', ids.join(','));
  ok(ids.includes('hub_terminal'), 'terminal still registered');
  await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_workbench').interact());
  await sleep(200);
  const wb = await lastEv('hub:workbenchToggled');
  ok(wb && wb.open === true, 'workbench menu opens (hub:workbenchToggled)');
  ok(await page.evaluate(() => window.__game.ctx.uiBlockers.has('hub')), 'workbench takes the hub blocker');
  await key('Escape');
  await sleep(200);
  ok((await lastEv('hub:workbenchToggled')).open === false, 'Esc closes the workbench');

  console.log('mission / loadout');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await sleep(300);
  const lo = await page.evaluate(() => {
    const l = window.__game.ctx.inventory.getLoadout();
    return { p: l.primary?.defId, p2: l.primary2?.defId ?? null, s: l.secondary?.defId, bag: l.bag?.defId, size: window.__game.ctx.inventory.getBagSize(),
      dur: l.primary?.durability, mag: l.primary?.ammoInMag };
  });
  ok(lo.p === 'wpn_ar23' && lo.s === 'wpn_p2' && lo.p2 === null, 'starter loadout: AR I / — / P-2', JSON.stringify(lo));
  ok(lo.bag === 'bag_common' && lo.size.cols === 5 && lo.size.rows === 6, 'starter bag_common → 5×6 grid', JSON.stringify(lo.size));
  ok(lo.dur === 500 && lo.mag === 45, 'AR starts at 500 durability, 45 in mag', `dur=${lo.dur} mag=${lo.mag}`);
  const stats = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const l = window.__game.ctx.inventory.getLoadout();
    return { ar: loot.getEffectiveStats(l.primary), g3: loot.getEffectiveStats('ar23_g3'), p2: loot.getEffectiveStats(l.secondary), name3: loot.getWeaponDef('ar23_g3')?.name };
  });
  ok(stats.ar && stats.ar.damage === 60 && stats.ar.maxDurability === 500 && stats.ar.ammoType === 'medium', 'AR I stats (60 dmg, 500 dur, medium)', JSON.stringify(stats.ar));
  ok(stats.g3 && stats.g3.damage === 74 && stats.g3.grade === 3 && /III/.test(stats.name3 ?? ''), 'AR III: +24 % damage, roman numeral in name', `${stats.g3?.damage} ${stats.name3}`);
  ok(stats.p2 && Math.abs(stats.p2.adsTime - stats.ar.adsTime / 2) < 1e-6 && stats.p2.swapTime < stats.ar.swapTime, 'secondary: half ADS time, faster swap');
  const eq = await lastEv('weapon:equipped');
  ok(eq && eq.slot === 'primary' && eq.reserveRounds === 90, 'weapon:equipped primary, reserve = 90 medium rounds in bag', JSON.stringify(eq));

  console.log('fire / durability / ammo');
  await mouseSim(0, 0.35);
  await waitSim(0.3);
  const afterFire = await page.evaluate(() => { const l = window.__game.ctx.inventory.getLoadout(); return { dur: l.primary.durability, mag: l.primary.ammoInMag }; });
  ok(afterFire.mag < 45, 'firing drains the magazine', `mag=${afterFire.mag}`);
  ok(afterFire.dur === 500 - (45 - afterFire.mag), 'durability −1 per shot', `dur=${afterFire.dur}`);
  const de = await lastEv('weapon:durabilityChanged');
  ok(de && de.durability === afterFire.dur && de.max === 500, 'weapon:durabilityChanged emitted');
  await key('KeyR');
  await waitSim(3.2);
  const afterReload = await page.evaluate(() => { const inv = window.__game.ctx.inventory; const l = inv.getLoadout(); return { mag: l.primary.ammoInMag, bag: inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium') }; });
  ok(afterReload.mag === 45, 'reload refills the mag', `mag=${afterReload.mag}`);
  ok(afterReload.bag === 90 - (45 - afterFire.mag), 'reload consumes bag rounds', `bag=${afterReload.bag}`);

  console.log('slots');
  await key('Digit3');
  await waitSim(0.5);
  const eq3 = await lastEv('weapon:equipped');
  ok(eq3 && eq3.slot === 'secondary' && eq3.weaponId === 'p2', '3 → secondary (P-2)', JSON.stringify(eq3));
  const sw = await lastEv('weapon:swapStarted');
  ok(sw && sw.slot === 'secondary' && sw.duration <= 0.11, 'secondary swap ≤ 0.1 s', JSON.stringify(sw));
  await key('Digit2');
  await waitSim(0.3);
  ok((await lastEv('weapon:equipped')).slot === 'secondary', '2 with empty 주무기 II is refused');
  const p2added = await page.evaluate(() => { const ctx = window.__game.ctx; const it = ctx.loot.createItem('wpn_smg37_g2'); const okAdd = ctx.inventory.tryAddItem(it); return okAdd && ctx.inventory.equip(it.uid, 'primary2'); });
  ok(p2added, 'equip SMG II into primary2 via InventoryRef.equip');
  await key('Digit2');
  await waitSim(0.8);
  const eq2 = await lastEv('weapon:equipped');
  ok(eq2 && eq2.slot === 'primary2' && eq2.weaponId === 'smg37_g2', '2 → 주무기 II (SMG II)', JSON.stringify(eq2));
  await key('KeyV');
  await waitSim(0.8);
  ok((await lastEv('weapon:equipped')).slot === 'secondary', 'Q returns to the previous weapon');
  await key('Digit1');
  await waitSim(0.8);
  ok((await lastEv('weapon:equipped')).slot === 'primary', '1 → primary');

  console.log('sockets');
  const sock = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout();
    const brake = ctx.loot.createItem('att_brake'); inv.tryAddItem(brake);
    const choke = ctx.loot.createItem('att_choke'); inv.tryAddItem(choke);
    const r = { canBrake: ctx.loot.canAttach(l.primary, brake), canChoke: ctx.loot.canAttach(l.primary, choke) };
    r.attached = inv.attachToWeapon(l.primary.uid, brake.uid);
    r.chokeRefused = !inv.attachToWeapon(l.primary.uid, choke.uid);
    const st = ctx.loot.getEffectiveStats(l.primary);
    r.recoilV = st.recoilV; r.base = ctx.loot.getEffectiveStats('ar23').recoilV;
    r.socket = l.primary.sockets?.muzzle?.defId ?? null;
    r.inBag = inv.getAllItems().some((i) => i.uid === brake.uid);
    r.detached = inv.detachAllSockets(l.primary.uid);
    r.backInBag = inv.getAllItems().some((i) => i.uid === brake.uid);
    r.emptyAfter = !l.primary.sockets?.muzzle;
    return r;
  });
  ok(sock.canBrake && !sock.canChoke, 'canAttach: brake ok, shotgun choke refused on AR', JSON.stringify(sock));
  ok(sock.attached && sock.socket === 'att_brake' && !sock.inBag, 'attachToWeapon fills the muzzle socket and removes the item from the bag');
  ok(Math.abs(sock.recoilV - sock.base * 0.75) < 1e-6, 'brake: recoilV ×0.75 in effective stats', `${sock.recoilV} vs ${sock.base}`);
  ok(sock.chokeRefused, 'incompatible attachment refused');
  ok(sock.detached && sock.backInBag && sock.emptyAfter, 'detachAllSockets returns the brake to the bag');
  const se = await ev('inventory:socketChanged');
  ok(se.length >= 2, 'inventory:socketChanged emitted for attach + detach', `${se.length}`);

  console.log('unload / repair / broken');
  const un = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout();
    const before = inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium');
    const mag = l.primary.ammoInMag;
    const r = inv.unloadWeapon(l.primary.uid);
    return { r, mag, before, after: inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium'), magAfter: l.primary.ammoInMag };
  });
  ok(un.r && un.magAfter === 0 && un.after === un.before + un.mag, 'unloadWeapon moves the magazine back to the bag', JSON.stringify(un));
  const rep = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout();
    inv.updateItem(l.primary.uid, { durability: 100 });
    const cost = ctx.loot.getRepairCost(l.primary);
    const failed = !inv.repairWeapon(l.primary.uid);
    const scrap = ctx.loot.createItem('mat_scrap', 4); inv.tryAddItem(scrap);
    const fixed = inv.repairWeapon(l.primary.uid);
    return { cost, failed, fixed, dur: l.primary.durability, scrapLeft: inv.countWhere((d) => d.id === 'mat_scrap') };
  });
  ok(rep.cost.length === 1 && rep.cost[0].defId === 'mat_scrap' && rep.cost[0].qty === 4, 'repair cost: 400 missing → 4 폐금속', JSON.stringify(rep.cost));
  ok(rep.failed, 'repair refused without materials');
  ok(rep.fixed && rep.dur === 500 && rep.scrapLeft === 0, 'repair restores durability and consumes the scrap', JSON.stringify(rep));
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; const l = inv.getLoadout(); inv.updateItem(l.primary.uid, { durability: 0, ammoInMag: 45 }); });
  await waitSim(0.2);
  await mouseSim(0, 0.3);
  await waitSim(0.2);
  const broken = await lastEv('weapon:broken');
  const magB = await page.evaluate(() => window.__game.ctx.inventory.getLoadout().primary.ammoInMag);
  ok(broken && broken.weaponId === 'ar23' && magB === 45, 'broken weapon does not fire (weapon:broken)', `mag=${magB}`);
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; const l = inv.getLoadout(); inv.updateItem(l.primary.uid, { durability: 500 }); });

  console.log('bags');
  const bag = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory;
    const big = ctx.loot.createItem('bag_legendary'); inv.tryAddItem(big);
    const eqBig = inv.equip(big.uid, 'bag');
    const sizeBig = inv.getBagSize();
    const small = ctx.loot.createItem('bag_common'); inv.tryAddItem(small);
    let added = 0;
    for (let i = 0; i < 80; i++) { const it = ctx.loot.createItem('gem_quartz'); if (!inv.tryAddItem(it)) break; added++; }
    const eqSmall = inv.equip(small.uid, 'bag');
    const sizeSmall = inv.getBagSize();
    const pickups = ctx.pickups.getPickups().length;
    return { eqBig, sizeBig, added, eqSmall, sizeSmall, pickups, items: inv.getAllItems().length };
  });
  ok(bag.eqBig && bag.sizeBig.cols === 10 && bag.sizeBig.rows === 6, 'legendary bag → 10×6', JSON.stringify(bag.sizeBig));
  ok(bag.added >= 30, 'filled the legendary bag', `${bag.added}`);
  ok(bag.eqSmall && bag.sizeSmall.cols === 5 && bag.sizeSmall.rows === 6, 'common bag → 5×6', JSON.stringify(bag.sizeSmall));
  const bc = await lastEv('inventory:bagChanged');
  ok(bc && bc.cols === 5 && bc.dropped.length > 0 && bag.pickups >= bc.dropped.length, 'shrinking the bag drops the items that no longer fit', JSON.stringify({ dropped: bc?.dropped?.length, pickups: bag.pickups }));
  ok(bag.items <= 30, 'no item remains outside the 5×6 grid', `${bag.items}`);

  console.log('hud');
  const hud = await page.evaluate(() => ({
    stamina: !!document.querySelector('.hud .stamina'),
    staminaFull: document.querySelector('.hud .stamina')?.classList.contains('full'),
    dur: !!document.querySelector('.weapon .dur, .weapon .durability, .weapon [class*="dur"]'),
    slots: document.querySelectorAll('.wslots .wslot').length,
  }));
  ok(hud.stamina && hud.staminaFull, 'stamina bar present and hidden (.full) while idle');
  ok(hud.dur, 'weapon panel has a durability element');
  ok(hud.slots >= 3, 'weapon slot strip has 3 cells', `${hud.slots}`);

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
