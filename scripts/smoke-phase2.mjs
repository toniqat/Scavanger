// Single-player smoke test for Phase 2: downed / bleed / give-up / respawn, quick-use wheel, stim in hand, grenade cooking.
// Phase 9: `player:giveUpProgress` (rises during the Space hold, a single -1 on release / death).
// Phase 10: the healing item (once the stim) is used with a HEAL_HOLD_S (2 s) LMB hold — a tap only starts / cancels the gauge
// (`heal:holdChanged`).
// Usage: node scripts/smoke-phase2.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts by itself on a new profile and locks
    // room purposes · crafting · the terminal · boarding in that order, so it is marked "already done" here
    // (the tutorial itself is what scripts/smoke-tutorial.mjs looks at).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run.
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['player:downed', 'player:downHpChanged', 'player:revived', 'player:died', 'player:respawn', 'player:spawned', 'player:landed',
      'game:respawnAvailable', 'game:phaseChanged', 'game:over', 'inventory:quickSlotsChanged', 'quick:wheelChanged', 'quick:equipped', 'quick:used',
      'grenade:holdChanged', 'grenade:thrown', 'grenade:exploded', 'player:stimUsed', 'weapon:equipped', 'player:giveUpProgress',
      'heal:holdChanged', 'player:carryStarted', 'player:carryEnded', 'ping:placed', 'ping:wheelChanged', 'chat:post']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const keyDown = (code) => page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c })), code);
  const keyUp = (code) => page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c })), code);
  const mouseDown = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const key = async (code, sec = 0.08) => { await keyDown(code); await waitSim(sec); await keyUp(code); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn) => page.evaluate(fn);

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);

  console.log('quick slots');
  const qs = await P(() => { const inv = window.__game.ctx.inventory; return { slots: inv.getQuickSlots().map((s) => s?.defId ?? null), n: inv.getQuickSlotCount() }; });
  ok(qs.slots.length === 8 && qs.slots[0] === 'grenade_frag' && qs.slots[4] === 'heal_bandage', 'starter kit auto-assigns grenade → N, 붕대 → S', JSON.stringify(qs));
  ok(qs.n === 2, 'common bag → 2 usable quick slots (N and S per the unlock order)', `${qs.n}`);
  const qsEv = await ev('inventory:quickSlotsChanged');
  ok(qsEv.length > 0 && qsEv[qsEv.length - 1].active === 2, 'inventory:quickSlotsChanged emitted with active count');
  // 2026-09-09 — the wheel is its own container: the starter `붕대` / `수류탄` live in their slots and are **not** in the
  // bag grid, so their uids come from `getQuickSlots()` (`getAllItems()` is the bag grid alone).
  const setRes = await P(() => {
    const inv = window.__game.ctx.inventory;
    const stim = inv.getQuickSlots()[4]?.uid ?? null;   // the `붕대` the starter kit put in S
    const gun = inv.getLoadout().primary;   // 2026-09-10: the secondary weapon slot was removed → checked on the primary
    const inBag = inv.getAllItems().some((i) => i.defId === 'heal_bandage' || i.defId === 'grenade_frag');
    const bagBefore = inv.getAllItems().length;
    const lockedRefused = !inv.setQuickSlot(2, stim);
    const moveOk = inv.setQuickSlot(0, stim);           // a stack already on the wheel → the two slots swap
    return { inBag, lockedRefused, moveOk, bagUntouched: inv.getAllItems().length === bagBefore,
      gunRefused: !inv.setQuickSlot(4, gun.uid), slots: inv.getQuickSlots().map((s) => s?.defId ?? null) };
  });
  ok(setRes.inBag === false, 'the wheel stacks left the bag grid (getAllItems has neither)');
  ok(setRes.lockedRefused, 'a locked slot (E with a common bag) refuses assignment');
  ok(setRes.moveOk && setRes.slots[0] === 'heal_bandage' && setRes.slots[4] === 'grenade_frag' && setRes.bagUntouched,
    'setQuickSlot on a wheel uid swaps the two slots (bag untouched)', JSON.stringify(setRes));
  ok(setRes.gunRefused, 'a weapon cannot go into a quick slot');
  // back to `수류탄` N / `붕대` S for the wheel tests below (a second swap)
  await P(() => { const inv = window.__game.ctx.inventory; inv.setQuickSlot(0, inv.getQuickSlots()[4].uid); });
  const restored = await P(() => window.__game.ctx.inventory.getQuickSlots().map((s) => s?.defId ?? null));
  ok(restored[0] === 'grenade_frag' && restored[4] === 'heal_bandage', 'swapped back: 수류탄 N, 붕대 S', JSON.stringify(restored));

  /* 2026-09-15 (user's decision): the camera does not turn while the ping button is held (the same as the `H` · `T`
     wheels). The lock does not consume `mouseDX`, so the left / right classification must be unchanged, and it releases
     on the release · past `PING_HOLD_MAX` (1.2 s). */
  console.log('ping hold locks the camera');
  const look = () => P(() => ({ locked: window.__game.getSystem('player').lookLocked, yaw: window.__game.ctx.player.yaw }));
  await waitSim(0.4);
  const pl0 = await look();
  ok(pl0.locked === false, 'look unlocked before the ping press', JSON.stringify(pl0));
  await P(() => { window.__ev['ping:placed'].length = 0; window.__ev['ping:wheelChanged'].length = 0; });
  await mouseDown(1);
  await waitSim(0.3);
  const plHeld = await look();
  ok(plHeld.locked === true, 'ping press locks the look (setLookLocked) from the start of the hold', JSON.stringify(plHeld));
  await P(() => { window.__game.ctx.input.mouseDX += 200; });
  await waitSim(0.2);
  const plDrag = await look();
  const pwDrag = await lastEv('ping:wheelChanged');
  ok(plDrag.locked && Math.abs(plDrag.yaw - plHeld.yaw) < 1e-6, `dragging right while held does not turn the camera (yaw ${plHeld.yaw.toFixed(3)} → ${plDrag.yaw.toFixed(3)})`);
  ok(pwDrag && pwDrag.open === true && pwDrag.hover === 'right', 'the drag still classifies — ping wheel open, hover right', JSON.stringify(pwDrag));
  await mouseUp(1);
  await waitSim(0.2);
  const plRel = await look();
  const placedRel = await lastEv('ping:placed');
  ok(plRel.locked === false, 'release unlocks the look', JSON.stringify(plRel));
  ok(placedRel && placedRel.kind === 'attack', 'release places the right-side ping (저쪽으로 가자)', JSON.stringify(placedRel));
  await P(() => { window.__game.ctx.input.mouseDX += 200; });
  await waitSim(0.2);
  const plFree = await look();
  ok(Math.abs(plFree.yaw - plRel.yaw) > 0.01, `unlocked, the same drag turns the camera (yaw ${plRel.yaw.toFixed(3)} → ${plFree.yaw.toFixed(3)})`);
  await waitSim(0.4);   // ping cooldown
  await mouseDown(1);
  await waitSim(0.3);
  const plHeld2 = await look();
  await waitSim(1.2);
  const plTimeout = await look();
  ok(plHeld2.locked === true && plTimeout.locked === false, 'holding past PING_HOLD_MAX releases the look while the button is still down', JSON.stringify({ plHeld2, plTimeout }));
  await mouseUp(1);
  await waitSim(0.2);
  const plAfter = await look();
  const placedT = await lastEv('ping:placed');
  ok(plAfter.locked === false && placedT && placedT.kind !== 'attack' && placedT.kind !== 'caution', 'timed-out hold releases into a plain ping, look stays unlocked', JSON.stringify({ plAfter, placedT }));

  console.log('stim in hand (F tap)');
  await P(() => window.__game.ctx.player.takeDamage(40));
  await waitSim(0.3);
  await key('KeyT', 0.08);
  await waitSim(0.4);
  let qe = await lastEv('quick:equipped');
  ok(qe && qe.item && (qe.item.defId === 'grenade_frag' || qe.item.defId === 'heal_bandage'), 'F tap puts a quick item in hand', JSON.stringify(qe));
  // make sure the stim is in hand: open the wheel and pick S (drag down)
  await keyDown('KeyT');
  await waitSim(0.5);
  let wheel = await lastEv('quick:wheelChanged');
  ok(wheel && wheel.open === true, 'F hold opens the wheel', JSON.stringify(wheel));
  await P(() => { window.__game.ctx.input.mouseDY += 80; });
  await waitSim(0.2);
  wheel = await lastEv('quick:wheelChanged');
  ok(wheel && wheel.hover === 4, 'dragging down hovers the S slot', JSON.stringify(wheel));
  await keyUp('KeyT');
  await waitSim(0.3);
  qe = await lastEv('quick:equipped');
  ok(qe && qe.item && qe.item.defId === 'heal_bandage' && qe.index === 4, 'release equips the stim', JSON.stringify(qe));
  const hpBefore = await P(() => window.__game.ctx.player.hp);
  const stimBefore = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'heal_bandage'));
  // 2026-09-07: the `붕대` is a 5 s hold (`ItemDef.heal.useTime`) — a short tap consumes nothing
  const useTime = await P(() => window.__game.ctx.loot.getItemDef('heal_bandage')?.heal?.useTime ?? null);
  ok(useTime === 5, '붕대 사용 시간 5초 (ItemDef.heal.useTime)', String(useTime));
  await mouseDown(0); await waitSim(0.4); await mouseUp(0);
  await waitSim(0.6);
  const tapped = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'heal_bandage'));
  ok(tapped === stimBefore, 'a short LMB tap does not consume the 붕대 (5 s hold)', `${stimBefore} → ${tapped}`);
  const cancelled = await lastEv('heal:holdChanged');
  ok(cancelled && cancelled.holding === false, 'releasing early cancels heal:holdChanged', JSON.stringify(cancelled));
  await mouseDown(0); await waitSim(0.8);
  const holding = await lastEv('heal:holdChanged');
  ok(holding && holding.holding === true && holding.t > 0.1 && holding.t < 1, 'heal:holdChanged rises while LMB is held', JSON.stringify(holding));
  ok(holding && holding.dur === 5, 'heal:holdChanged carries the item use time (dur 5)', JSON.stringify(holding));
  const slowed = await P(() => window.__game.getSystem('player')?.controller?.speedMultiplier ?? null);
  ok(slowed !== null && slowed <= 0.55, `사용 중 이동 속도 50 % (speedMultiplier=${slowed})`);
  await waitSim(4.6); await mouseUp(0);
  await waitSim(5.5);
  const hpAfter = await P(() => window.__game.ctx.player.hp);
  const stimAfter = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'heal_bandage'));
  ok(hpAfter > hpBefore, 'a full 5 s LMB hold uses the 붕대 (hp up over 5 s)', `${hpBefore} → ${hpAfter}`);
  ok(stimAfter === stimBefore - 1, '붕대 stack −1', `${stimBefore} → ${stimAfter}`);
  const unslowed = await P(() => window.__game.getSystem('player')?.controller?.speedMultiplier ?? null);
  ok(unslowed !== null && unslowed > 0.9, `사용이 끝나면 이동 속도가 돌아온다 (speedMultiplier=${unslowed})`);
  ok((await ev('quick:used')).length >= 1, 'quick:used emitted');

  console.log('grenade cooking');
  await keyDown('KeyT'); await waitSim(0.5);
  await P(() => { window.__game.ctx.input.mouseDY -= 80; });
  await waitSim(0.2); await keyUp('KeyT'); await waitSim(0.3);
  qe = await lastEv('quick:equipped');
  ok(qe && qe.item && qe.item.defId === 'grenade_frag' && qe.index === 0, 'wheel N → grenade in hand', JSON.stringify(qe));
  /* 2026-09-15, 2nd pass (`ItemCategory 'grenade'` dropped): a grenade is `category: 'gadget'` too, so the category cannot count them — `ItemDef.grenade` is what tells them apart. */
  const gBefore = await P(() => window.__game.ctx.inventory.countWhere((d) => d.grenade !== undefined));
  await mouseDown(0);
  await waitSim(0.3);
  let hold = await lastEv('grenade:holdChanged');
  ok(hold && hold.holding && !hold.cooking, 'LMB held → wind-up (holding, not cooking)', JSON.stringify(hold));
  await mouseDown(2); await waitSim(0.1); await mouseUp(2);
  await waitSim(0.2);
  hold = await lastEv('grenade:holdChanged');
  ok(hold && hold.underhand === true, 'RMB toggles underhand', JSON.stringify(hold));
  await key('KeyR', 0.08);
  await waitSim(1.0);
  hold = await lastEv('grenade:holdChanged');
  ok(hold && hold.cooking && hold.cooked >= 0.8 && hold.fuse < 2.3, 'R pulls the pin → cooking, fuse shrinking', JSON.stringify(hold));
  await mouseUp(0);
  await waitSim(0.3);
  const thrown = await lastEv('grenade:thrown');
  hold = await lastEv('grenade:holdChanged');
  ok(!!thrown && hold && !hold.holding, 'release throws the grenade', JSON.stringify(hold));
  const gAfter = await P(() => window.__game.ctx.inventory.countWhere((d) => d.grenade !== undefined));
  ok(gAfter === gBefore - 1, 'grenade stack −1', `${gBefore} → ${gAfter}`);
  await waitSim(2.5);
  ok((await ev('grenade:exploded')).length >= 1, 'cooked grenade explodes within its shortened fuse');
  // 2026-09-10: the secondary weapon is gone, so the starter puts the `기관단총` in `주무기` I — 1 is the key that goes back to the gun
  await key('Digit1', 0.08); await waitSim(0.6);
  qe = await lastEv('quick:equipped');
  const weq = await lastEv('weapon:equipped');
  ok(qe && qe.item === null && weq && weq.slot === 'primary', '1 returns to the 주무기', JSON.stringify({ qe, weq }));

  console.log('downed / revive');
  /* 2026-09-08 — in a one-person squad a lethal hit is death outright (nobody is coming to lift the body), so the downed
     state is made by hand with `enterDowned()`. The instant-death rule itself is confirmed on a fresh mission by the
     `1인 분대: 치명타 = 즉사` section at the end of this script. */
  await P(() => window.__game.ctx.player.enterDowned());
  await waitSim(0.3);
  let st = await P(() => { const p = window.__game.ctx.player; return { downed: p.isDowned, dead: p.isDead, downHp: p.downHp, hp: p.hp, stance: p.stance, canUse: p.canUseWeapons() }; });
  ok(st.downed && !st.dead && st.downHp === 100 && st.hp === 0, 'lethal damage → downed (not dead), downHp 100', JSON.stringify(st));
  ok(st.stance === 'prone' && !st.canUse, 'downed: prone, weapons unusable', JSON.stringify(st));
  ok((await ev('player:downed')).length === 1, 'player:downed emitted');
  await waitSim(3.2);
  st = await P(() => ({ downHp: window.__game.ctx.player.downHp }));
  ok(st.downHp <= 97 && st.downHp >= 95, 'bleeds ~1/s', `${st.downHp}`);
  await P(() => window.__game.ctx.player.takeDamage(30));
  await waitSim(0.3);
  st = await P(() => ({ downHp: window.__game.ctx.player.downHp, dead: window.__game.ctx.player.isDead }));
  ok(st.downHp <= 67 && !st.dead, 'damage while downed hits downHp', JSON.stringify(st));
  const enemiesIgnore = await P(() => { const sys = window.__game.getSystem('enemies'); const t = sys?.targets?.alive ?? sys?.targetList?.alive ?? null; return t === null ? 'n/a' : t.length === 0; });
  ok(enemiesIgnore === true || enemiesIgnore === 'n/a', 'downed player is not an alive enemy target', String(enemiesIgnore));
  await P(() => window.__game.ctx.player.revive());
  await waitSim(0.3);
  st = await P(() => { const p = window.__game.ctx.player; return { downed: p.isDowned, hp: p.hp }; });
  ok(!st.downed && st.hp === 10, 'revive() → up with 10 hp', JSON.stringify(st));
  ok((await ev('player:revived')).length === 1, 'player:revived emitted');

  console.log('hud');
  const hud = await P(() => ({
    wheel: !!document.querySelector('.qwheel'),
    cook: !!document.querySelector('.cook'),
    // 2026-09-07: the `회복약` / `수류탄` pills under the health bar are gone (the counts live in the right-hand column).
    noPills: !document.querySelector('.vitals .pill'),
  }));
  ok(hud.wheel, 'quick wheel element exists');
  ok(hud.cook, 'cook gauge element exists');
  ok(hud.noPills, 'no 회복약 / 수류탄 pills under the health bar any more');

  /* 2026-09-15 (user's decision): requesting the equipped armor (a wheel click · the menu) reads 「실드 충전 필요」 as
     soon as the shield is short by anything; with it full, or on armor that is not equipped, it is the plain
     `<이름> 필요`. The menu entry follows the same condition and reads 「실드 충전 요청」. */
  console.log('armor request → shield recharge');
  const armorReq = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.player;
    const SLOT = { kind: 'slot', slot: 'armor' }, BAG = { kind: 'grid', grid: 'bag' };
    const out = {};
    if (!inv.getLoadout().armor) {
      const a = ctx.loot.createItem('armor_2', 1);
      out.added = inv.tryAddItem(a);
      out.equipped = inv.equip(a.uid, 'armor');
    }
    const spare = ctx.loot.createItem('armor_1', 1);
    out.spareAdded = inv.tryAddItem(spare);
    const worn = inv.getLoadout().armor;
    const posts = window.__ev['chat:post'];
    const ask = (uid, from) => {
      const n = posts.length;
      const done = inv.requestItem(uid, from);
      const item = inv.findItem(uid, from);
      const def = item && ctx.loot.getItemDef(item.defId);
      const labels = item && def && inv.ui ? inv.ui.menuEntries(uid, from, item, def).map((e) => e.label) : [];
      return { done, text: posts.slice(n).find((m) => m.kind === 'request')?.text ?? null, shield: p.shield, max: p.maxShield,
        menu: labels.filter((l) => /요청/.test(l)) };
    };
    out.name = worn ? ctx.loot.getItemDef(worn.defId)?.name : null;
    out.spareName = ctx.loot.getItemDef('armor_1')?.name;
    if (p.shield >= p.maxShield) p.absorbShield(1);
    out.low = worn ? ask(worn.uid, SLOT) : null;
    out.spareLow = ask(spare.uid, BAG);
    out.charged = p.chargeShield(Infinity);
    out.full = worn ? ask(worn.uid, SLOT) : null;
    return out;
  });
  ok(armorReq.low && armorReq.low.max > 0 && armorReq.low.shield < armorReq.low.max, 'equipped armor with a depleted shield', JSON.stringify(armorReq));
  ok(armorReq.low && armorReq.low.done && armorReq.low.text === '실드 충전 필요', `equipped armor + shield not full → 「실드 충전 필요」 (${armorReq.low?.text})`, JSON.stringify(armorReq.low));
  ok(armorReq.low && armorReq.low.menu.length === 1 && armorReq.low.menu[0] === '실드 충전 요청', `menu entry reads 「실드 충전 요청」 (${armorReq.low?.menu})`);
  ok(armorReq.spareLow.text === `${armorReq.spareName} 필요` && armorReq.spareLow.menu[0] === '요청', `armor that is not equipped stays the plain request even with a depleted shield (${armorReq.spareLow.text})`, JSON.stringify(armorReq.spareLow));
  ok(armorReq.full && armorReq.full.shield === armorReq.full.max && armorReq.full.text === `${armorReq.name} 필요` && armorReq.full.menu[0] === '요청',
    `full shield → plain 「${armorReq.name} 필요」 · menu 「요청」 (${armorReq.full?.text})`, JSON.stringify({ charged: armorReq.charged, full: armorReq.full }));

  console.log('give up → dead → 레이드 실패 (Phase 7: a solo death fails the raid; the 30 s respawn is squad-only)');
  await waitSim(2.5); // past any post-revive invulnerability
  await P(() => window.__game.ctx.player.enterDowned());
  await waitSim(0.3);
  const downedAgain = await P(() => window.__game.ctx.player.isDowned);
  ok(downedAgain, 'downed again after the revive');
  // Phase 9: a short hold released early → progress rises, then a single -1, still downed
  await P(() => { window.__ev['player:giveUpProgress'] = []; });
  await keyDown('Space'); await waitSim(0.6); await keyUp('Space');
  await waitSim(0.3);
  const gupRel = await P(() => { const a = window.__ev['player:giveUpProgress'].map((e) => e.t); return { n: a.length, max: Math.max(...a), last: a[a.length - 1], minusOnes: a.filter((t) => t === -1).length, downed: window.__game.ctx.player.isDowned, dead: window.__game.ctx.player.isDead }; });
  ok(gupRel.n >= 2 && gupRel.max >= 0.25 && gupRel.max < 1, 'player:giveUpProgress rises during a short Space hold', JSON.stringify(gupRel));
  ok(gupRel.last === -1 && gupRel.minusOnes === 1 && gupRel.downed && !gupRel.dead, 'releasing Space early → one t -1, still downed', JSON.stringify(gupRel));
  await P(() => { window.__ev['player:giveUpProgress'] = []; });
  await keyDown('Space'); await waitSim(2.2); await keyUp('Space');
  await waitSim(0.3);
  st = await P(() => ({ dead: window.__game.ctx.player.isDead, phase: window.__game.ctx.phase }));
  ok(st.dead, 'holding Space while downed gives up → dead', JSON.stringify(st));
  const gupFull = await P(() => { const a = window.__ev['player:giveUpProgress'].map((e) => e.t); return { n: a.length, max: Math.max(...a), last: a[a.length - 1], died: window.__ev['player:died'].length }; });
  ok(gupFull.max >= 0.5 && gupFull.last === -1 && gupFull.died >= 1, 'full hold: progress ≥ 0.5 then t -1 with player:died', JSON.stringify(gupFull));
  ok((await ev('game:over')).length === 0, 'game:over waits for the death delay');
  await waitSim(3.0);
  st = await P(() => ({ phase: window.__game.ctx.phase, over: window.__ev['game:over'].length, ra: window.__ev['game:respawnAvailable'].length }));
  ok(st.phase === 'dead', 'solo: phase dead (death screen) after the delay', st.phase);
  ok(st.over === 1, 'solo death → game:over (레이드 실패)', `${st.over}`);
  ok(st.ra === 0, 'no respawn countdown in a solo raid', `${st.ra}`);
  const deathScreen = await P(() => [...document.querySelectorAll('.menu')].some((el) => !el.hidden && getComputedStyle(el).visibility !== 'hidden' && /함선/.test(el.textContent ?? '')));
  ok(deathScreen, 'death screen visible');
  await P(() => window.__game.ctx.bus.emit('game:respawn', {}));
  await waitSim(0.3);
  ok((await ev('player:respawn')).length === 0, 'game:respawn refused after a raid failure');
  // the failure screen returns to the ship by itself (RAID_FAILED_AUTO_RETURN_S); fast-forward with the time scale
  await P(() => { window.__game.ctx.timeScale = 8; });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'auto return to the ship', 60000);
  await P(() => { window.__game.ctx.timeScale = 1; });
  st = await P(() => { const inv = window.__game.ctx.inventory; return { phase: window.__game.ctx.phase, primary: inv.getLoadout().primary?.defId, stims: inv.countWhere((d) => d.id === 'heal_bandage') }; });
  ok(st.phase === 'hub', 'back in the ship after the failure', st.phase);
  // 2026-09-07: a failed raid loses the kit — the player re-equips from the ship stash (the starter grant is there)
  ok(st.primary === undefined && st.stims === 0, '레이드 실패 후 장비를 잃는다 (창고에서 재장비)', JSON.stringify(st));

  /* ── a one-person squad: a lethal hit = instant death (2026-09-08) ──
     Downed is the state that gives squadmates time to lift the body. Alone nobody is coming, so all that is left is time
     spent bleeding and crawling, and `player/parts/Vitals.onLethal` goes straight to `die()` (the perk `auto_revive` is
     the only exception). Dying is the point of this mission, so it sits at the very end of the script. */
  console.log('1인 분대: 치명타 = 즉사');
  await P(() => { window.__ev['player:downed'] = []; window.__ev['player:died'] = []; });
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 12 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing (즉사 확인)', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit (즉사 확인)', 10000);
  await waitSim(0.3);
  const solo = await P(() => {
    const p = window.__game.ctx.player, d = window.__game.ctx.progression?.derived;
    if (d?.perks) d.perks.auto_revive = false;    // with `재기동 회로` the body goes down even alone (that is the whole perk)
    if (d) d.gritChance = 0;                      // if `인내` leaves 1 hp it stops being a lethal hit
    p.takeDamage(9999);
    return { downed: p.isDowned, dead: p.isDead, hp: p.hp, downedEv: window.__ev['player:downed'].length, diedEv: window.__ev['player:died'].length };
  });
  ok(!solo.downed && solo.dead, '1인 분대: 치명타는 전투불능 없이 바로 사망', JSON.stringify(solo));
  ok(solo.downedEv === 0 && solo.diedEv === 1, 'player:downed 없이 player:died 하나만', JSON.stringify(solo));
  await P(() => { window.__game.ctx.timeScale = 8; });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'auto return to the ship (즉사 확인)', 60000);
  await P(() => { window.__game.ctx.timeScale = 1; });

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
