// Single-player smoke test for Phase 2: downed / bleed / give-up / respawn, quick-use wheel, stim in hand, grenade cooking.
// Phase 9: `player:giveUpProgress` (rises during the Space hold, a single -1 on release / death).
// Phase 10: the 회복약 (was 스팀) is used with a HEAL_HOLD_S (2 s) LMB hold — a tap only starts / cancels the gauge
// (`heal:holdChanged`).
// Usage: node scripts/smoke-phase2.mjs [http://localhost:5273]   (needs `npm run dev`)
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
    // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run (same trick as smoke-meta).
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
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['player:downed', 'player:downHpChanged', 'player:revived', 'player:died', 'player:respawn', 'player:spawned', 'player:landed',
      'game:respawnAvailable', 'game:phaseChanged', 'game:over', 'inventory:quickSlotsChanged', 'quick:wheelChanged', 'quick:equipped', 'quick:used',
      'grenade:holdChanged', 'grenade:thrown', 'grenade:exploded', 'player:stimUsed', 'weapon:equipped', 'player:giveUpProgress',
      'heal:holdChanged', 'player:carryStarted', 'player:carryEnded']) {
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
  ok(qs.slots.length === 8 && qs.slots[0] === 'grenade_frag' && qs.slots[4] === 'stim', 'starter kit auto-assigns grenade → N, stim → S', JSON.stringify(qs));
  ok(qs.n === 2, 'common bag → 2 usable quick slots (N and S per the unlock order)', `${qs.n}`);
  const qsEv = await ev('inventory:quickSlotsChanged');
  ok(qsEv.length > 0 && qsEv[qsEv.length - 1].active === 2, 'inventory:quickSlotsChanged emitted with active count');
  const setRes = await P(() => { const inv = window.__game.ctx.inventory; const stim = inv.getAllItems().find((i) => i.defId === 'stim'); const gun = inv.getLoadout().primary;
    const lockedRefused = !inv.setQuickSlot(2, stim.uid);
    const moveOk = inv.setQuickSlot(0, stim.uid);
    return { lockedRefused, moveOk, gunRefused: !inv.setQuickSlot(4, gun.uid), slots: inv.getQuickSlots().map((s) => s?.defId ?? null) }; });
  ok(setRes.lockedRefused, 'a locked slot (E with a common bag) refuses assignment');
  ok(setRes.moveOk && setRes.slots[0] === 'stim' && setRes.slots[4] === null, 'setQuickSlot moves the stim S→N (one slot per item)', JSON.stringify(setRes.slots));
  ok(setRes.gunRefused, 'a weapon cannot go into a quick slot');
  await P(() => { const inv = window.__game.ctx.inventory; const stim = inv.getAllItems().find((i) => i.defId === 'stim'); const g = inv.getAllItems().find((i) => i.defId === 'grenade_frag'); inv.setQuickSlot(4, stim.uid); inv.setQuickSlot(0, g.uid); });

  console.log('stim in hand (F tap)');
  await P(() => window.__game.ctx.player.takeDamage(40));
  await waitSim(0.3);
  await key('KeyT', 0.08);
  await waitSim(0.4);
  let qe = await lastEv('quick:equipped');
  ok(qe && qe.item && (qe.item.defId === 'grenade_frag' || qe.item.defId === 'stim'), 'F tap puts a quick item in hand', JSON.stringify(qe));
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
  ok(qe && qe.item && qe.item.defId === 'stim' && qe.index === 4, 'release equips the stim', JSON.stringify(qe));
  const hpBefore = await P(() => window.__game.ctx.player.hp);
  const stimBefore = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'stim'));
  // Phase 10: the 회복약 needs a HEAL_HOLD_S (2 s) LMB hold — a tap must NOT consume it
  await mouseDown(0); await waitSim(0.4); await mouseUp(0);
  await waitSim(0.6);
  const tapped = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'stim'));
  ok(tapped === stimBefore, 'a short LMB tap does not consume the 회복약 (2 s hold)', `${stimBefore} → ${tapped}`);
  const cancelled = await lastEv('heal:holdChanged');
  ok(cancelled && cancelled.holding === false, 'releasing early cancels heal:holdChanged', JSON.stringify(cancelled));
  await mouseDown(0); await waitSim(0.8);
  const holding = await lastEv('heal:holdChanged');
  ok(holding && holding.holding === true && holding.t > 0.1 && holding.t < 1, 'heal:holdChanged rises while LMB is held', JSON.stringify(holding));
  await waitSim(1.8); await mouseUp(0);
  await waitSim(2.0);
  const hpAfter = await P(() => window.__game.ctx.player.hp);
  const stimAfter = await P(() => window.__game.ctx.inventory.countWhere((d) => d.id === 'stim'));
  ok(hpAfter > hpBefore, 'a full 2 s LMB hold uses the 회복약 (hp up)', `${hpBefore} → ${hpAfter}`);
  ok(stimAfter === stimBefore - 1, 'stim stack −1', `${stimBefore} → ${stimAfter}`);
  ok((await ev('quick:used')).length >= 1, 'quick:used emitted');

  console.log('grenade cooking');
  await keyDown('KeyT'); await waitSim(0.5);
  await P(() => { window.__game.ctx.input.mouseDY -= 80; });
  await waitSim(0.2); await keyUp('KeyT'); await waitSim(0.3);
  qe = await lastEv('quick:equipped');
  ok(qe && qe.item && qe.item.defId === 'grenade_frag' && qe.index === 0, 'wheel N → grenade in hand', JSON.stringify(qe));
  const gBefore = await P(() => window.__game.ctx.inventory.countWhere((d) => d.category === 'grenade'));
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
  const gAfter = await P(() => window.__game.ctx.inventory.countWhere((d) => d.category === 'grenade'));
  ok(gAfter === gBefore - 1, 'grenade stack −1', `${gBefore} → ${gAfter}`);
  await waitSim(2.5);
  ok((await ev('grenade:exploded')).length >= 1, 'cooked grenade explodes within its shortened fuse');
  await key('Digit1', 0.08); await waitSim(0.6);
  qe = await lastEv('quick:equipped');
  const weq = await lastEv('weapon:equipped');
  ok(qe && qe.item === null && weq && weq.slot === 'primary', '1 returns to the rifle', JSON.stringify({ qe, weq }));

  console.log('downed / revive');
  await P(() => window.__game.ctx.player.takeDamage(500));
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
    fKey: /T|H/.test(document.querySelector('.vitals .pill .key')?.textContent ?? ''),
  }));
  ok(hud.wheel, 'quick wheel element exists');
  ok(hud.cook, 'cook gauge element exists');
  ok(hud.fKey, 'stim pill shows the T / H key');

  console.log('give up → dead → 레이드 실패 (Phase 7: a solo death fails the raid; the 30 s respawn is squad-only)');
  await waitSim(2.5); // past any post-revive invulnerability
  await P(() => window.__game.ctx.player.takeDamage(500));
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
  st = await P(() => { const inv = window.__game.ctx.inventory; return { phase: window.__game.ctx.phase, primary: inv.getLoadout().primary?.defId, stims: inv.countWhere((d) => d.id === 'stim') }; });
  ok(st.phase === 'hub', 'back in the ship after the failure', st.phase);
  ok(st.primary === 'wpn_ar23' && st.stims === 2, 'starter kit reapplied after the failed raid', JSON.stringify(st));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
