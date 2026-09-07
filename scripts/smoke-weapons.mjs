// Single-player smoke test for the weapon package (grades / durability / ammo v2 / 3 slots / sockets / bags / repair)
// + Phase 7 `ctx.weapons.remoteState` (held item / throwing / cooking / attachments) and remote-grenade damage
// + Phase 9 barrier purity (`raycastBarrier` emits nothing, `damageBarrier` once per resolved hit) and status `attacker` from the uniques.
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
    // park the vite HMR socket: another editor's save would full-reload the page mid-run (the relay socket is untouched)
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
      'inventory:bagChanged', 'inventory:socketChanged', 'inventory:itemUpdated', 'loadout:changed', 'hub:workbenchToggled', 'implant:barrierHit']) {
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
  // Phase 8: the cockpit no longer has a built-in bench — place the starter 정비 벤치 in a 작업실 and use that.
  const benchUid = await page.evaluate(() => {
    const h = window.__game.ctx.housing;
    if (!h) return null;
    let room = h.state.rooms.findIndex((r) => r.purpose === 'workshop');
    if (room < 0) { room = 0; h.setRoomPurpose(0, 'workshop'); }
    const placed = h.getPlaced(room).find((f) => f.defId === 'furn_repair_bench');
    if (placed) return placed.uid;
    if (!h.getStored().some((e) => e.defId === 'furn_repair_bench' && e.qty > 0)) h.craftFurniture('furn_repair_bench');
    return h.place(room, 'furn_repair_bench', 0, 0, 0)?.uid ?? null;
  });
  ok(!!benchUid, 'personal ship: 정비 벤치 placed in the 작업실', String(benchUid));
  const ids = await page.evaluate(() => window.__game.ctx.interactables.all().map((i) => i.id));
  ok(ids.includes(`hub_furn_${benchUid}`), 'placed 정비 벤치 registers its interactable', ids.join(','));
  ok(ids.includes('hub_terminal'), 'terminal still registered');
  await page.evaluate((uid) => window.__game.ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`).interact(), benchUid);
  await sleep(200);
  const wb = await lastEv('hub:workbenchToggled');
  ok(wb && wb.open === true, 'workbench menu opens (hub:workbenchToggled)');
  ok(await page.evaluate(() => window.__game.ctx.uiBlockers.has('hub')), 'workbench takes the hub blocker');
  await key('Escape');
  await sleep(200);
  ok((await lastEv('hub:workbenchToggled')).open === false, 'Esc closes the workbench');
  // Phase 9: the 배리어 implant is chosen on the ship (setEquipped is hub-only) and deployed in the mission below
  const eqBar = await page.evaluate(() => { const imp = window.__game.ctx.implants; return imp ? { ok: imp.setEquipped('barrier'), eq: imp.equipped } : null; });
  ok(eqBar && eqBar.ok && eqBar.eq === 'barrier', 'hub: 배리어 implant equipped (setEquipped)', JSON.stringify(eqBar));

  // 2026-09-07: the starter kit is 권총 I / 가방 I / 방탄복 I only — the 돌격소총 and its ammo come out of the
  // 함선 창고 (기본 지급품). Equip them here so the ballistics assertions below have their AR and 90 준중량탄.
  const armed = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const ar = ctx.loot.createItem('wpn_ar');
    const added = inv.tryAddItem(ar) && inv.equip(ar.uid, 'primary');
    for (const q of [50, 40]) inv.tryAddItem(ctx.loot.createItem('ammo_medium', q));
    return { added, primary: inv.getLoadout().primary?.defId, medium: inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium') };
  });
  ok(armed.added && armed.primary === 'wpn_ar' && armed.medium === 90, 'ship: 돌격소총 I + 준중량탄 90발 equipped from the 창고', JSON.stringify(armed));

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
  ok(lo.p === 'wpn_ar' && lo.s === 'wpn_hg' && lo.p2 === null, 'raid loadout kept from the ship: 돌격소총 I / — / 권총 I', JSON.stringify(lo));
  ok(lo.bag === 'bag_common' && lo.size.cols === 5 && lo.size.rows === 6, 'starter bag_common → 5×6 grid', JSON.stringify(lo.size));
  ok(lo.dur === 500 && lo.mag === 45, 'AR starts at 500 durability, 45 in mag', `dur=${lo.dur} mag=${lo.mag}`);
  const stats = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const l = window.__game.ctx.inventory.getLoadout();
    return { ar: loot.getEffectiveStats(l.primary), g3: loot.getEffectiveStats('ar_g3'), p2: loot.getEffectiveStats(l.secondary), name3: loot.getWeaponDef('ar_g3')?.name };
  });
  ok(stats.ar && stats.ar.damage === 60 && stats.ar.maxDurability === 500 && stats.ar.ammoType === 'medium', 'AR I stats (60 dmg, 500 dur, medium)', JSON.stringify(stats.ar));
  ok(stats.g3 && stats.g3.damage === 74 && stats.g3.grade === 3 && stats.name3 === '돌격소총 III', 'AR III: +24 % damage, class name + roman numeral', `${stats.g3?.damage} ${stats.name3}`);
  ok(stats.p2 && Math.abs(stats.p2.adsTime - stats.ar.adsTime / 2) < 1e-6 && stats.p2.swapTime < stats.ar.swapTime, 'secondary: half ADS time, faster swap');
  await key('Digit1');   // 2026-09-07: the raid starts on the 권총 (the only starter weapon) — take the AR out
  await waitSim(0.8);
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
  ok(eq3 && eq3.slot === 'secondary' && eq3.weaponId === 'hg', '3 → secondary (권총 I)', JSON.stringify(eq3));
  const sw = await lastEv('weapon:swapStarted');
  ok(sw && sw.slot === 'secondary' && sw.duration <= 0.11, 'secondary swap ≤ 0.1 s', JSON.stringify(sw));
  await key('Digit2');
  await waitSim(0.3);
  ok((await lastEv('weapon:equipped')).slot === 'secondary', '2 with empty 주무기 II is refused');
  const p2added = await page.evaluate(() => { const ctx = window.__game.ctx; const it = ctx.loot.createItem('wpn_smg_g2'); const okAdd = ctx.inventory.tryAddItem(it); return okAdd && ctx.inventory.equip(it.uid, 'primary2'); });
  ok(p2added, 'equip SMG II into primary2 via InventoryRef.equip');
  await key('Digit2');
  await waitSim(0.8);
  const eq2 = await lastEv('weapon:equipped');
  ok(eq2 && eq2.slot === 'primary2' && eq2.weaponId === 'smg_g2', '2 → 주무기 II (SMG II)', JSON.stringify(eq2));
  // 2026-09-07 (커서 rework): the 이전 무기 key is retired — V is 구르기 now, so a weapon swap is 1 / 2 / 3 only.
  await key('KeyV');
  await waitSim(0.8);
  ok((await lastEv('weapon:equipped')).slot === 'primary2', 'V no longer swaps weapons (it rolls)');
  await key('Digit3');
  await waitSim(0.8);
  ok((await lastEv('weapon:equipped')).slot === 'secondary', '3 → 보조무기');
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
    r.recoilV = st.recoilV; r.base = ctx.loot.getEffectiveStats('ar').recoilV;
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

  console.log('remote state (Phase 7)');
  // keydown + keyup in one frame on document.body (dt is clamped to 50 ms, any wait reads as a hold)
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const mDown = (b) => page.evaluate((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mUp = (b) => page.evaluate((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);
  const rsNow = () => page.evaluate(() => { const rs = window.__game.ctx.weapons.remoteState; return { held: rs.heldItemId, throwing: rs.throwing, cooking: rs.cooking, charging: rs.charging, spraying: rs.spraying, heavy: rs.heavy, att: rs.attachments.slice() }; });
  const rs0 = await rsNow();
  ok(rs0.held === null && !rs0.throwing && !rs0.cooking && !rs0.charging && !rs0.spraying && !rs0.heavy && rs0.att.length === 0, 'remoteState idle: no held item / pose flags / attachments', JSON.stringify(rs0));
  await page.evaluate(() => { const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout(); const b = ctx.loot.createItem('att_brake'); inv.tryAddItem(b); inv.attachToWeapon(l.primary.uid, b.uid); });
  await waitSim(0.2);
  await page.evaluate(() => { window.__rsArr = window.__game.ctx.weapons.remoteState.attachments; });
  const rs1 = await rsNow();
  ok(rs1.att.length === 1 && rs1.att[0] === 'att_brake', 'attachToWeapon → remoteState.attachments [att_brake]', JSON.stringify(rs1.att));
  await waitSim(0.3);
  ok(await page.evaluate(() => window.__game.ctx.weapons.remoteState.attachments === window.__rsArr), 'attachments array instance is stable while the socket set is unchanged');
  await page.evaluate(() => { const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout(); const z = ctx.loot.createItem('att_laser'); inv.tryAddItem(z); inv.attachToWeapon(l.primary.uid, z.uid); });
  await waitSim(0.2);
  const rs2 = await page.evaluate(() => { const rs = window.__game.ctx.weapons.remoteState; return { att: rs.attachments.slice(), fresh: rs.attachments !== window.__rsArr }; });
  ok(rs2.fresh && rs2.att.length === 2 && rs2.att.includes('att_brake') && rs2.att.includes('att_laser'), 'second socket → new array with both ids', JSON.stringify(rs2));
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; inv.detachAllSockets(inv.getLoadout().primary.uid); });
  await waitSim(0.2);
  ok((await rsNow()).att.length === 0, 'detachAllSockets → attachments []');
  // grenade in hand: T tap (starter quick slot N = grenade) → LMB hold = throwing → R = cooking → release
  await tap('KeyT');
  await waitSim(0.4);
  const held = await rsNow();
  ok(held.held === 'grenade_frag', 'T tap → remoteState.heldItemId = grenade_frag', JSON.stringify(held));
  await mDown(0);
  await waitSim(0.3);
  const thr = await rsNow();
  ok(thr.throwing === true && thr.cooking === false, 'LMB held → throwing (not cooking yet)', JSON.stringify(thr));
  await tap('KeyR');
  await waitSim(0.3);
  const cook = await rsNow();
  ok(cook.throwing === true && cook.cooking === true, 'R → cooking', JSON.stringify(cook));
  await mUp(0);
  await waitSim(0.3);
  const rel = await rsNow();
  ok(rel.throwing === false && rel.cooking === false, 'release → throwing / cooking clear', JSON.stringify(rel));
  await tap('Digit1');
  await waitSim(0.8);
  ok((await rsNow()).held === null, '1 → gun back in hand, heldItemId null');
  await waitSim(3.5);
  // remote (visual-only) grenade replicas now damage the local player — same radius / falloff as our own frags
  await page.evaluate(() => { window.__ev['grenade:exploded'] = []; window.__game.ctx.bus.on('grenade:exploded', (p) => window.__ev['grenade:exploded'].push(1)); });
  const hpG = await page.evaluate(() => { const p = window.__game.ctx.player; p.heal(1000); return p.hp; });
  await page.evaluate(() => { const ctx = window.__game.ctx; const g = window.__game.getSystem('weapons').grenades; const p = ctx.player.position; const o = new p.constructor(p.x + 3.0, p.y + 0.5, p.z); g.throw(o, new p.constructor(0, 0, 0), true, 0.05); });
  await waitSim(0.4);
  const rg = await page.evaluate(() => ({ hp: window.__game.ctx.player.hp, exploded: window.__ev['grenade:exploded'].length }));
  ok(rg.hp < hpG - 30, `visual-only replica grenade damages the local player (${hpG} → ${rg.hp.toFixed(0)})`);
  ok(rg.exploded === 0, 'replica explosion emits no grenade:exploded (enemies do not hear it)');
  await page.evaluate(() => { const p = window.__game.ctx.player; if (p.isDowned) p.revive(); p.heal(1000); });
  await waitSim(0.3);

  console.log('회복약 2 s hold / H retired / reload cancel (Phase 10)');
  await page.evaluate(() => {
    const bus = window.__game.ctx.bus;
    for (const n of ['heal:holdChanged', 'quick:used', 'quick:equipped', 'weapon:reloadStarted', 'weapon:reloadCancelled', 'player:stimUsed']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  // H is retired (Keys.STIM has no reader left): nothing goes into the hand
  await tap('KeyH');
  await waitSim(0.3);
  const hKey = await page.evaluate(() => ({ held: window.__game.ctx.weapons.remoteState.heldItemId, eq: window.__ev['quick:equipped'].length }));
  ok(hKey.held === null && hKey.eq === 0, 'H does nothing any more (the Keys.STIM reader is gone)', JSON.stringify(hKey));
  // 회복약 into the hand through the quick slot N + T tap, player damaged so the hold is allowed to start
  // 2026-09-07: each 회복 소모품 has its own hold (`ItemDef.heal.useTime`) — the 회복주사 keeps this section's 2 s.
  const stimReady = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const p = ctx.player;
    p.heal(1000);
    let stim = inv.getAllItems().find((i) => i.defId === 'heal_syringe');
    if (!stim) { stim = ctx.loot.createItem('heal_syringe', 2); inv.tryAddItem(stim); }
    const moved = inv.setQuickSlot(0, stim.uid);
    p.takeDamage(35);
    return { moved, hp: p.hp, max: p.maxHp, qty: stim.qty, useTime: ctx.loot.getItemDef('heal_syringe')?.heal?.useTime };
  });
  ok(stimReady.moved && stimReady.hp < stimReady.max && stimReady.useTime === 2, '회복주사 in quick slot N (useTime 2 s), player below full hp', JSON.stringify(stimReady));
  await tap('KeyT');
  await waitSim(0.4);
  ok((await rsNow()).held === 'heal_syringe', 'T tap → 회복주사 in hand', JSON.stringify(await rsNow()));
  // LMB held: the gauge rises and nothing is consumed before HEAL_HOLD_S (2 s)
  await mDown(0);
  await waitSim(0.6);
  const h1 = await page.evaluate(() => ({ ev: window.__ev['heal:holdChanged'].slice(), used: window.__ev['quick:used'].length }));
  const first = h1.ev[0], last1 = h1.ev[h1.ev.length - 1];
  ok(!!first && first.holding === true && first.t === 0, 'LMB press → heal:holdChanged {holding:true, t:0}', JSON.stringify(first));
  ok(!!last1 && last1.t > 0 && last1.t < 1, `gauge rising after 0.6 s (t=${last1 ? last1.t.toFixed(2) : 'none'})`);
  ok(h1.used === 0, 'nothing is consumed before the 2 s hold completes');
  // 소모품 사용 중 이동 속도 50 % (`CONSUMABLE_SLOW_MUL`), read off the controller the player system writes
  const slowed = await page.evaluate(() => window.__game.getSystem('player')?.controller?.speedMultiplier ?? null);
  ok(slowed !== null && slowed <= 0.55, `사용 중 이동 속도가 절반으로 (speedMultiplier=${slowed})`);
  await mUp(0);
  await waitSim(0.2);
  const cancelEv = await lastEv('heal:holdChanged');
  ok(!!cancelEv && cancelEv.holding === false && cancelEv.t === -1, 'releasing LMB cancels the hold (t: -1)', JSON.stringify(cancelEv));
  // full hold → consume + applyStim
  const hpBefore = await page.evaluate(() => { window.__ev['quick:used'] = []; return window.__game.ctx.player.hp; });
  await waitSim(0.5);   // quick-use cooldown
  await mDown(0);
  await waitSim(2.4);
  const done = await page.evaluate(() => ({ used: window.__ev['quick:used'].slice(), stim: window.__ev['player:stimUsed'].length, hp: window.__game.ctx.player.hp, last: window.__ev['heal:holdChanged'].slice(-1)[0] }));
  await mUp(0);
  ok(done.used.length === 1, `2 s hold consumes the 회복약 exactly once (${done.used.length})`, JSON.stringify(done.used));
  ok(done.stim >= 1 && done.hp > hpBefore, `applyStim ran (${hpBefore.toFixed(0)} → ${done.hp.toFixed(0)}, player:stimUsed ${done.stim})`);
  ok(!!done.last && done.last.holding === false, 'the gauge closes when the hold completes', JSON.stringify(done.last));
  // at full hp the hold is refused outright (the old instant-use rule)
  await page.evaluate(() => { window.__ev['heal:holdChanged'] = []; window.__game.ctx.player.heal(1000); });
  await waitSim(0.7);
  await mDown(0);
  await waitSim(0.4);
  const denied = await ev('heal:holdChanged');
  await mUp(0);
  ok(denied.length === 0, 'full hp refuses to start the hold', JSON.stringify(denied));
  /* ── 회복 스프레이 (2026-09-07): 게이지 채널, 사용 중 이동 50 % ── */
  const sprayReady = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.player;
    const can = ctx.loot.createItem('heal_spray');
    const added = inv.tryAddItem(can);
    const moved = inv.setQuickSlot(0, can.uid);
    p.takeDamage(60);
    return { added, moved, uid: can.uid, gauge: can.durability, max: ctx.loot.getItemDef('heal_spray').durabilityMax, hp: p.hp };
  });
  ok(sprayReady.added && sprayReady.moved && sprayReady.gauge === sprayReady.max && sprayReady.max === 100,
    '회복 스프레이 in quick slot N with a full 100 gauge', JSON.stringify(sprayReady));
  await tap('KeyT');
  await waitSim(0.5);
  ok((await rsNow()).held === 'heal_spray', 'T tap → 회복 스프레이 in hand');
  await mDown(0);
  await waitSim(0.6);
  const sprayed = await page.evaluate((uid) => {
    const ctx = window.__game.ctx;
    return { gauge: ctx.inventory.findItem(uid)?.durability ?? -1, hp: ctx.player.hp,
      last: window.__ev['heal:holdChanged'].slice(-1)[0],
      speed: window.__game.getSystem('player')?.controller?.speedMultiplier ?? null };
  }, sprayReady.uid);
  await mUp(0);
  await waitSim(0.3);
  ok(sprayed.gauge > 0 && sprayed.gauge < 100, `holding LMB drains the gauge (${sprayed.gauge}/100 after 0.6 s)`);
  ok(sprayed.hp > sprayReady.hp, `the spray heals the user while it runs (${sprayReady.hp.toFixed(0)} → ${sprayed.hp.toFixed(0)})`);
  ok(!!sprayed.last && sprayed.last.spray === true && sprayed.last.t > 0 && sprayed.last.t < 1,
    'heal:holdChanged carries {spray:true} and the remaining gauge as t', JSON.stringify(sprayed.last));
  ok(sprayed.speed !== null && sprayed.speed <= 0.55, `사용 중 이동 속도 50 % (speedMultiplier=${sprayed.speed})`);
  const sprayStopped = await page.evaluate(() => ({ last: window.__ev['heal:holdChanged'].slice(-1)[0], speed: window.__game.getSystem('player')?.controller?.speedMultiplier ?? null }));
  ok(sprayStopped.last && sprayStopped.last.holding === false && sprayStopped.speed > 0.9, '릴리스 → 채널 종료 + 감속 해제', JSON.stringify(sprayStopped));
  // put the can away again — the unique-weapon section below needs the bag space back
  await page.evaluate((uid) => window.__game.ctx.inventory.takeItem(uid), sprayReady.uid);

  // back to the gun, then a swap mid-reload → weapon:reloadCancelled (new in Phase 10)
  await tap('Digit1');
  await waitSim(0.8);
  ok((await rsNow()).held === null, '1 → gun back in hand after the 회복약');
  const relSet = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory; const l = inv.getLoadout();
    inv.updateItem(l.primary.uid, { ammoInMag: 10 });
    let res = inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium');
    if (res <= 0) { inv.tryAddItem(ctx.loot.createItem('ammo_medium', 30)); res = inv.countWhere((d) => d.category === 'ammo' && d.ammoType === 'medium'); }
    return { mag: l.primary.ammoInMag, res };
  });
  await tap('KeyR');
  await waitSim(0.2);
  ok((await ev('weapon:reloadStarted')).length >= 1, 'R starts a reload', JSON.stringify(relSet));
  await tap('Digit3');
  await waitSim(0.4);
  const rc = await lastEv('weapon:reloadCancelled');
  ok(!!rc && rc.weaponId === 'ar', 'a swap mid-reload emits weapon:reloadCancelled', JSON.stringify(rc));
  await tap('Digit1');
  await waitSim(0.8);
  ok((await ev('weapon:reloadCancelled')).length === 1, 'no reloadCancelled when nothing was reloading', JSON.stringify(await ev('weapon:reloadCancelled')));

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
  ok(broken && broken.weaponId === 'ar' && magB === 45, 'broken weapon does not fire (weapon:broken)', `mag=${magB}`);
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; const l = inv.getLoadout(); inv.updateItem(l.primary.uid, { durability: 500 }); });

  console.log('barrier shield / blockers (Phase 9 purity + Phase 10 carried shield)');
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.enemies.killAll(); ctx.enemies.setThreatLevel(0); const p = ctx.player; if (p.isDowned) p.revive(); p.heal(1000); });
  const bar0 = await page.evaluate(() => { const imp = window.__game.ctx.implants; if (!imp) return null; if (!imp.barrierActive) imp.activate(); return { eq: imp.equipped, active: imp.barrierActive, carried: imp.barrierCarried, blocks: imp.blocksWeapons, hp: imp.barrierHp, max: imp.barrierMaxHp }; });
  ok(bar0 && bar0.eq === 'barrier' && bar0.active && bar0.hp > 0 && bar0.hp === bar0.max, 'activate() raises the 배리어 방패 in hand at full hp', JSON.stringify(bar0));
  ok(bar0 && bar0.carried && bar0.blocks, 'the raised shield is wielded: barrierCarried and blocksWeapons (the gun is holstered)', JSON.stringify(bar0));
  await waitSim(0.2);
  // Phase 10: the panel travels with the carrier, so probe it from IN FRONT, shooting inward — a shot from behind
  // must pass through (IMPLANT_BARRIER_CARRY_ARC). line-of-sight style queries stay pure: no event, no hp change.
  const q = await page.evaluate(() => {
    const ctx = window.__game.ctx; const imp = ctx.implants; const p = ctx.player; const V = p.position.constructor;
    const pose = new V(); const yaw = imp.getBarrierPose(pose);
    const fwd = p.getForward(new V()); fwd.y = 0; fwd.normalize();
    const o = pose.clone().addScaledVector(fwd, 5); o.y = pose.y + 0.6;   // 5 m in front of the panel, panel height
    const d = fwd.clone().negate();                                        // inward, at the shield's face
    const before = window.__ev['implant:barrierHit'].length; const hp0 = imp.barrierHp;
    const r1 = imp.raycastBarrier(o, d, 10, true);
    const r2 = imp.raycastBarrier(o, d, 10, true);
    const r0 = imp.raycastBarrier(o, d, 10, false);
    // from behind: origin behind the carrier, shooting forward through their back
    const ob = pose.clone().addScaledVector(fwd, -5); ob.y = o.y;
    const rb = imp.raycastBarrier(ob, fwd, 12, true);
    return {
      pose: [pose.x, pose.y, pose.z], yaw: yaw ? yaw.yaw : null, playerYaw: p.yaw,
      hit: !!r1 && r1.owner === 'local', hit2: !!r2, friendly: r0 === null, behind: rb === null,
      events: window.__ev['implant:barrierHit'].length - before, hpSame: imp.barrierHp === hp0,
      point: r1 ? [r1.point.x, r1.point.y, r1.point.z] : null,
    };
  });
  ok(q.hit && q.hit2 && q.point, 'raycastBarrier(fromEnemy=true) reports the carried shield on an inbound frontal ray', JSON.stringify(q));
  ok(q.friendly, 'raycastBarrier(fromEnemy=false): an allied shot passes through (unchanged semantics)');
  ok(q.behind, 'a hostile shot from behind the carrier passes through (IMPLANT_BARRIER_CARRY_ARC front gate)', JSON.stringify(q));
  ok(q.yaw !== null && Math.abs(q.yaw - q.playerYaw) < 0.01, 'getBarrierPose() faces the carrier (yaw matches)', JSON.stringify(q));
  ok(q.events === 0 && q.hpSame, 'pure query: two LOS-style hits emit no implant:barrierHit and leave barrierHp unchanged', JSON.stringify(q));
  const dmgB = await page.evaluate((pt) => {
    const ctx = window.__game.ctx; const imp = ctx.implants; const V = ctx.player.position.constructor;
    const before = window.__ev['implant:barrierHit'].length; const hp0 = imp.barrierHp;
    imp.damageBarrier('local', new V(pt[0], pt[1], pt[2]));
    const evs = window.__ev['implant:barrierHit'].slice(before);
    return { hp0, hp1: imp.barrierHp, events: evs.length, damage: evs[0]?.damage ?? null, active: imp.barrierActive };
  }, q.point);
  ok(dmgB.hp1 < dmgB.hp0 && dmgB.events === 1 && dmgB.damage > 0 && dmgB.hp0 - dmgB.hp1 === dmgB.damage, 'damageBarrier(local, point) lowers barrierHp by the block damage and emits implant:barrierHit once', JSON.stringify(dmgB));
  const fold = await page.evaluate(() => {
    const imp = window.__game.ctx.implants; const V = window.__game.ctx.player.position.constructor;
    if (imp.barrierActive) imp.activate();
    return { active: imp.barrierActive, carried: imp.barrierCarried, blocks: imp.blocksWeapons, pose: imp.getBarrierPose(new V()) };
  });
  ok(fold.active === false && fold.carried === false && fold.pose === null, 'activate() again lowers the shield (getBarrierPose null, weapons free)', JSON.stringify(fold));
  await waitSim(0.8);   // let the gun come back out of the holster
  // real shots: with the shield DOWN the gun is usable again, so stub raycastBarrier into a synthetic hit and spy
  // damageBarrier — every resolved hitscan hit must bill the barrier exactly once (probes and aim rays stay pure).
  const shot0 = await page.evaluate(() => {
    const ctx = window.__game.ctx; const imp = ctx.implants; const inv = ctx.inventory; const p = ctx.player;
    const V = p.position.constructor;
    const origRay = imp.raycastBarrier.bind(imp); const origDmg = imp.damageBarrier.bind(imp);
    const fwd = p.getForward(new V()); fwd.y = 0; fwd.normalize();
    imp.raycastBarrier = (o, _d, _m, _fe) => ({ point: o.clone().addScaledVector(fwd, 3), owner: 'local' });
    window.__dmgCalls = [];
    imp.damageBarrier = (owner, point, amount) => { window.__dmgCalls.push([owner, +point.x.toFixed(2), +point.y.toFixed(2), +point.z.toFixed(2), amount ?? null]); };
    window.__restoreBarrier = () => { imp.raycastBarrier = origRay; imp.damageBarrier = origDmg; };
    window.__barrierEv = window.__ev['implant:barrierHit'].length;
    return { mag: inv.getLoadout().primary.ammoInMag, blocks: imp.blocksWeapons };
  });
  ok(shot0.blocks === false && shot0.mag === 45, 'AR loaded (45) and usable with the shield lowered before the burst', JSON.stringify(shot0));
  await mouseSim(0, 0.25);
  await waitSim(0.3);
  const shotR = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory;
    const r = { mag: inv.getLoadout().primary.ammoInMag, calls: window.__dmgCalls.slice(), losEvents: window.__ev['implant:barrierHit'].length - window.__barrierEv };
    window.__restoreBarrier();
    return r;
  });
  const shots = shot0.mag - shotR.mag;
  ok(shots >= 1, `burst fired ${shots} rounds into the stubbed barrier`);
  ok(shotR.calls.length === shots && shotR.calls.every((c) => c[0] === 'local'), `each resolved hit calls damageBarrier('local', point) exactly once (${shots} shots → ${shotR.calls.length} calls)`, JSON.stringify(shotR.calls.slice(0, 3)));
  ok(shotR.losEvents === 0, 'the raycasts themselves emitted no implant:barrierHit (damage is routed explicitly)');

  console.log('status attacker (Phase 9)');
  const uniq = async (defId, type) => page.evaluate(([id, t]) => {
    const ctx = window.__game.ctx; const inv = ctx.inventory, loot = ctx.loot;
    ctx.enemies.killAll();
    if (!window.__arUid) window.__arUid = inv.getLoadout().primary?.uid ?? null;
    const item = loot.createItem(id, 1);
    if (!inv.tryAddItem(item)) return { ok: false, why: 'bag full' };
    if (!inv.equip(item.uid, 'primary')) return { ok: false, why: 'equip refused' };
    (window.__uniqUids ??= []).push(item.uid);
    if (!window.__origApply) {
      const mgr = ctx.enemies; const orig = mgr.applyStatus.bind(mgr); window.__origApply = orig;
      mgr.applyStatus = (eid, st, dps, dur, by) => { window.__st.push([eid, st, by === undefined ? null : by]); return orig(eid, st, dps, dur, by); };
    }
    window.__st = [];
    const p = ctx.player; const V = p.position.constructor;
    const f = p.getForward(new V()); f.y = 0; f.normalize();
    const e = window.__game.getSystem('enemies').debugSpawn(t, { x: p.position.x + f.x * 5, z: p.position.z + f.z * 5 }, false);
    return { ok: true, enemy: e ? e.id : null, mag: item.ammoInMag, me: ctx.net?.localId ?? 'local' };
  }, [defId, type]);
  const fl = await uniq('wpn_u_flame', 'warrior');
  ok(fl.ok && fl.enemy != null && fl.mag > 0, 'u_flame equipped (loaded) + warrior 5 m ahead', JSON.stringify(fl));
  // the attacker is `ctx.net?.localId ?? 'local'` — the session token's peer id even offline; enemies/ folds it back to 'local'
  const me = fl.me;
  await waitSim(0.8);
  await mouseSim(0, 0.6);
  await waitSim(0.3);
  const stF = await page.evaluate(() => window.__st.slice());
  const burning = stF.filter((x) => x[1] === 'burning');
  ok(typeof me === 'string' && me.length > 0, `attacker id = ctx.net.localId ?? 'local' (${me})`);
  ok(burning.length >= 1 && burning.every((x) => x[2] === me), `flame: applyStatus('burning', …, attacker = me) on every tick (${burning.length})`, JSON.stringify(stF.slice(0, 3)));
  ok(stF.length > 0 && stF.every((x) => x[2] === me), 'no status from the flamethrower is missing its attacker');
  const sh = await uniq('wpn_u_shock', 'warrior');
  ok(sh.ok && sh.enemy != null, 'u_shock equipped + warrior 5 m ahead', JSON.stringify(sh));
  await waitSim(0.8);
  await mouseSim(0, 0.5);
  await waitSim(0.3);
  const stS = await page.evaluate(() => window.__st.slice());
  const shocked = stS.filter((x) => x[1] === 'shocked');
  ok(shocked.length >= 1 && shocked.every((x) => x[2] === me), `shock: applyStatus('shocked', …, attacker = me) (${shocked.length})`, JSON.stringify(stS.slice(0, 3)));
  const restored = await page.evaluate(() => {
    const ctx = window.__game.ctx; const inv = ctx.inventory;
    ctx.enemies.applyStatus = window.__origApply; window.__origApply = null;
    ctx.enemies.killAll();
    const back = window.__arUid ? inv.equip(window.__arUid, 'primary') : false;
    for (const uid of window.__uniqUids ?? []) inv.dropItem(uid);
    return { back, primary: inv.getLoadout().primary?.defId ?? null };
  });
  ok(restored.back && restored.primary === 'wpn_ar', 'AR I back in 주무기 I, uniques dropped', JSON.stringify(restored));
  await waitSim(0.5);

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
