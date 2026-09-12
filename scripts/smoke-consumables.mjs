// 전투 소모품 3종 smoke (2026-09-12 — docs/plans/consumables-keys-favorites.md §1, agent A1). Single player, relay parked.
//   data     boost_adrenaline / _stimulant / _stabilizer: category stim · 1×1 · quick-usable · rarity common / uncommon / rare,
//            medical-bench recipes (Lv.1 / 2 / 3), rogue_boss corpse table can drop them.
//   adren.   at full hp the 3 s hold starts (no 회복약 refusal), consumes one, refills stamina, `boost.kind` adrenaline,
//            sprint drains nothing (`staminaDrainMul` 0), a one-off cost (`consumeStamina`) is unchanged, buff list gets
//            `boost` with the item def id + a 15 s timer and the HUD strip draws the item glyph.
//   stim.    replaces adrenaline, aimSwayMul 0.7 · adsSpeedMul 1.4 · boostReloadSpeedMul 1.3 · weapons.reloadSpeedFor ×1.3 ·
//            the real reload duration shrinks · one-off cost ×1.5 · drain ×1.5; expiry clears everything; resetTactical clears.
//   stabil.  consumed at full implant charge, calls ImplantsRef.refillAll exactly once.
// Usage: node scripts/smoke-consumables.mjs [http://localhost:5273]   (needs vite; the runner starts it)
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
const near = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) <= eps;
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
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
    for (const n of ['heal:holdChanged', 'quick:used', 'weapon:reloadStarted', 'weapon:equipped']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const tap = (code) => P((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const keyDown = (code) => P((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => P((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const mDown = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mousedown', { button: x, bubbles: true })), b);
  const mUp = (b) => P((x) => document.body.dispatchEvent(new MouseEvent('mouseup', { button: x, bubbles: true })), b);
  const held = () => P(() => window.__game.ctx.weapons.remoteState.heldItemId);
  /** Quick slot N may already have been adopted into the hand (`onQuickSlotsChanged`) — tap T only when it was not. */
  const ensureHeld = async (defId) => {
    for (let i = 0; i < 3 && (await held()) !== defId; i++) { await tap('KeyT'); await waitSim(0.5); }
    return (await held()) === defId;
  };

  /* ── data ─────────────────────────────────────────────────────────────── */
  console.log('data: item defs · recipes · corpse table');
  const data = await P(() => {
    const loot = window.__game.ctx.loot;
    const ids = ['boost_adrenaline', 'boost_stimulant', 'boost_stabilizer'];
    const defs = ids.map((id) => { const d = loot.getItemDef(id); return d ? { id, cat: d.category, w: d.width, h: d.height, q: d.quickUsable, r: d.rarity, heal: !!d.heal, desc: d.description } : null; });
    const recipes = loot.getAllRecipes().filter((r) => ids.includes(r.outputDefId)).map((r) => ({ out: r.outputDefId, bench: r.bench, lvl: r.benchLevel, station: r.station }));
    const seen = new Set();
    for (let i = 0; i < 400; i++) for (const it of loot.rollCorpse('rogue_boss')) if (ids.includes(it.defId)) seen.add(it.defId);
    return { defs, recipes, corpse: [...seen].sort() };
  });
  const [dA, dS, dB] = data.defs;
  ok(data.defs.every((d) => d && d.cat === 'stim' && d.w === 1 && d.h === 1 && d.q === true && !d.heal), 'three defs: stim · 1×1 · quick-usable · no heal block', JSON.stringify(data.defs));
  ok(dA?.r === 'common' && dS?.r === 'uncommon' && dB?.r === 'rare', 'rarity: 일반 · 고급 · 희귀', JSON.stringify(data.defs.map((d) => d?.r)));
  ok(data.defs.every((d) => d && !/\d/.test(d.desc)), 'descriptions carry no numbers (the tooltip shows them)', JSON.stringify(data.defs.map((d) => d?.desc)));
  const lv = Object.fromEntries(data.recipes.map((r) => [r.out, r]));
  ok(data.recipes.length === 3 && data.recipes.every((r) => r.bench === 'medical' && r.station === 'ship')
    && lv.boost_adrenaline?.lvl === 1 && lv.boost_stimulant?.lvl === 2 && lv.boost_stabilizer?.lvl === 3, 'medical-bench recipes Lv.1 / 2 / 3', JSON.stringify(data.recipes));
  ok(data.corpse.length === 3, 'rogue_boss corpses drop all three over 400 rolls', JSON.stringify(data.corpse));

  /* ── ship → raid ──────────────────────────────────────────────────────── */
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await sleep(1200);
  const prep = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const implantOk = ctx.implants ? ctx.implants.setEquipped('dash') : false;
    const ar = ctx.loot.createItem('wpn_ar');
    const armed = inv.tryAddItem(ar) && inv.equip(ar.uid, 'primary');
    for (const it of inv.getAllItems()) if (it.defId === 'wpn_smg') inv.takeItem(it.uid);
    for (const q of [50, 40]) inv.tryAddItem(ctx.loot.createItem('ammo_medium', q));
    return { implantOk, armed };
  });
  ok(prep.implantOk && prep.armed, 'ship: 대시 implant + 돌격소총 equipped', JSON.stringify(prep));
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 9 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await sleep(300);
  await tap('Digit1');
  await waitSim(0.8);
  const base = await P(() => {
    const w = window.__game.getSystem('weapons'), p = window.__game.ctx.player;
    return { reload: w.reloadSpeedFor('AR'), sway: p.aimSwayMul, ads: p.adsSpeedMul, rel: p.boostReloadSpeedMul, drain: p.staminaDrainMul, cost: p.staminaCostMul, boost: p.boost };
  });
  ok(base.boost === null && base.sway === 1 && base.ads === 1 && base.rel === 1 && base.drain === 1 && base.cost === 1, 'no boost: every multiplier is 1', JSON.stringify(base));

  /* ── adrenaline ───────────────────────────────────────────────────────── */
  console.log('아드레날린 주사');
  const qA = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.player;
    p.heal(1000);
    const it = ctx.loot.createItem('boost_adrenaline', 2); inv.tryAddItem(it);
    const moved = inv.setQuickSlot(0, it.uid);
    p.stamina = 10;
    window.__ev['heal:holdChanged'] = []; window.__ev['quick:used'] = [];
    return { moved, full: p.hp >= p.maxHp };
  });
  ok(qA.moved && qA.full, 'adrenaline in quick slot N, player at full hp', JSON.stringify(qA));
  ok(await ensureHeld('boost_adrenaline'), 'T tap → 아드레날린 주사 in hand');
  await mDown(0);
  await waitSim(0.6);
  const hA = await P(() => ({ first: window.__ev['heal:holdChanged'][0], used: window.__ev['quick:used'].length, speed: window.__game.getSystem('player').controller.speedMultiplier }));
  ok(!!hA.first && hA.first.holding === true && near(hA.first.dur, 3, 1e-6), 'full hp does not refuse it: hold starts with dur 3 s', JSON.stringify(hA.first));
  ok(hA.used === 0 && hA.speed <= 0.55, 'nothing consumed yet · 이동 50 % while holding', JSON.stringify(hA));
  await waitSim(2.8);
  await mUp(0);
  await waitSim(0.2);
  const aDone = await P(() => {
    const p = window.__game.ctx.player;
    return { used: window.__ev['quick:used'].length, stamina: p.stamina, max: p.maxStamina, boost: p.boost && { ...p.boost }, drain: p.staminaDrainMul, cost: p.staminaCostMul, sway: p.aimSwayMul };
  });
  ok(aDone.used === 1, 'hold completes: one consumed', JSON.stringify(aDone));
  ok(near(aDone.stamina, aDone.max, 0.5), `stamina refilled (${aDone.stamina?.toFixed?.(1)} / ${aDone.max})`);
  ok(aDone.boost?.kind === 'adrenaline' && aDone.boost.defId === 'boost_adrenaline' && near(aDone.boost.duration, 15, 1e-6) && aDone.boost.remaining > 13, 'boost = adrenaline, 15 s', JSON.stringify(aDone.boost));
  ok(aDone.drain === 0 && aDone.cost === 1 && aDone.sway === 1, 'adrenaline: drain ×0, one-off cost ×1, sway ×1', JSON.stringify(aDone));

  // sprint for a while: nothing drains
  await keyDown('KeyW'); await keyDown('ShiftLeft');
  let sprinted = false;
  for (let i = 0; i < 12; i++) { await waitSim(0.1); if (await P(() => window.__game.ctx.player.isSprinting)) sprinted = true; }
  const afterSprint = await P(() => ({ s: window.__game.ctx.player.stamina, m: window.__game.ctx.player.maxStamina }));
  await keyUp('ShiftLeft'); await keyUp('KeyW');
  ok(sprinted && afterSprint.s >= afterSprint.m - 0.01, `1.2 s sprint drains nothing (sprinted=${sprinted}, ${afterSprint.s.toFixed(2)})`, JSON.stringify(afterSprint));
  const oneOff = await P(() => { const p = window.__game.ctx.player; p.stamina = p.maxStamina; const okc = p.consumeStamina(20); return { okc, s: p.stamina, m: p.maxStamina }; });
  ok(oneOff.okc && near(oneOff.s, oneOff.m - 20, 1e-6), 'one-off cost unchanged under adrenaline (consumeStamina 20 → −20)', JSON.stringify(oneOff));

  const buffA = await P(() => {
    const p = window.__game.ctx.player; p.recomputeBuffs();
    const b = (p.buffs ?? []).find((x) => x.key === 'boost');
    return b ? { kind: b.kind, defId: b.defId, span: b.endsAt - b.startedAt, state: b.state, debuff: b.debuff } : null;
  });
  ok(buffA && buffA.kind === 'adrenaline' && buffA.defId === 'boost_adrenaline' && near(buffA.span, 15000, 50) && buffA.state === 'active' && !buffA.debuff,
    'buff list: `boost` adrenaline with the item def id and a 15 s timer', JSON.stringify(buffA));
  await waitFor(page, () => (window.__game.getSystem('hud').localBuffs ?? []).some((c) => c.key === 'boost'), 'HUD strip boost cell', 10000);
  const cellA = await P(() => (window.__game.getSystem('hud').localBuffs ?? []).find((c) => c.key === 'boost'));
  ok(cellA && cellA.glyph === '↯' && cellA.title === '아드레날린 주사' && typeof cellA.ratio === 'number' && cellA.ratio > 0.5, 'HUD strip: item glyph · item name · time gauge', JSON.stringify(cellA));

  /* ── stimulant ────────────────────────────────────────────────────────── */
  console.log('각성제');
  await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    const it = ctx.loot.createItem('boost_stimulant', 2); inv.tryAddItem(it);
    inv.setQuickSlot(0, it.uid);
    window.__ev['quick:used'] = [];
  });
  await waitSim(0.6);
  ok(await ensureHeld('boost_stimulant'), 'T tap → 각성제 in hand');
  await mDown(0);
  await waitSim(3.4);
  await mUp(0);
  await waitSim(0.2);
  const sDone = await P(() => {
    const p = window.__game.ctx.player, w = window.__game.getSystem('weapons');
    p.recomputeBuffs();
    return { used: window.__ev['quick:used'].length, boost: p.boost && { ...p.boost }, sway: p.aimSwayMul, ads: p.adsSpeedMul, rel: p.boostReloadSpeedMul,
      drain: p.staminaDrainMul, cost: p.staminaCostMul, reload: w.reloadSpeedFor('AR'), keys: (p.buffs ?? []).filter((b) => b.key === 'boost').map((b) => b.kind) };
  });
  ok(sDone.used === 1 && sDone.boost?.kind === 'stimulant' && near(sDone.boost.duration, 30, 1e-6), 'hold completes: boost = stimulant, 30 s (adrenaline cleared)', JSON.stringify(sDone));
  ok(near(sDone.sway, 0.7, 1e-9) && near(sDone.ads, 1.4, 1e-9) && near(sDone.rel, 1.3, 1e-9), 'aimSwayMul 0.7 · adsSpeedMul 1.4 · boostReloadSpeedMul 1.3', JSON.stringify(sDone));
  ok(near(sDone.reload, base.reload * 1.3, 1e-9), `weapons.reloadSpeedFor('AR') × 1.3 (${base.reload} → ${sDone.reload})`);
  ok(near(sDone.drain, 1.5, 1e-9) && near(sDone.cost, 1.5, 1e-9), 'stamina drain ×1.5 · one-off ×1.5', JSON.stringify(sDone));
  ok(sDone.keys.length === 1 && sDone.keys[0] === 'stimulant', 'buff list: one `boost` entry, now stimulant', JSON.stringify(sDone.keys));
  const costS = await P(() => { const p = window.__game.ctx.player; p.stamina = p.maxStamina; const okc = p.consumeStamina(20); return { okc, s: p.stamina, m: p.maxStamina }; });
  ok(costS.okc && near(costS.s, costS.m - 30, 1e-6), 'one-off cost +50 % (consumeStamina 20 → −30)', JSON.stringify(costS));
  const refuse = await P(() => { const p = window.__game.ctx.player; p.stamina = 25; const okc = p.consumeStamina(20); return { okc, s: p.stamina }; });
  ok(!refuse.okc && near(refuse.s, 25, 1e-6), 'consumeStamina refuses when the scaled cost does not fit (25 < 30)', JSON.stringify(refuse));

  // real reload under stimulant: duration = reloadTime / (skill × 1.3)
  await P(() => { const p = window.__game.ctx.player; p.stamina = p.maxStamina; window.__ev['weapon:reloadStarted'] = []; });
  await tap('Digit1');                       // the stimulant stack (1 left) is still in hand — back to the rifle first
  await waitFor(page, () => window.__game.ctx.weapons.remoteState.heldItemId === null, 'rifle in hand', 10000);
  await waitSim(0.8);
  await mDown(0); await waitSim(0.3); await mUp(0);
  await waitSim(0.3);
  await tap('KeyR');
  await waitSim(0.3);
  const rl = await P(() => {
    const ctx = window.__game.ctx, st = ctx.loot.getEffectiveStats(ctx.inventory.getLoadout().primary);
    return { ev: window.__ev['weapon:reloadStarted'].slice(-1)[0], reloadTime: st.reloadTime };
  });
  ok(!!rl.ev && near(rl.ev.duration, Math.max(0.2, rl.reloadTime / (base.reload * 1.3)), 1e-3), `reload duration shrinks under stimulant (${rl.reloadTime} s → ${rl.ev?.duration?.toFixed?.(3)} s)`, JSON.stringify(rl));
  await waitSim(3);

  // expiry
  await P(() => { const ps = window.__game.getSystem('player'); ps.boostUntil = window.__game.ctx.time + 0.3; });
  await waitSim(0.6);
  const exp = await P(() => { const p = window.__game.ctx.player; p.recomputeBuffs(); return { boost: p.boost, sway: p.aimSwayMul, cost: p.staminaCostMul, boostBuff: (p.buffs ?? []).some((b) => b.key === 'boost') }; });
  ok(exp.boost === null && exp.sway === 1 && exp.cost === 1 && !exp.boostBuff, 'expiry clears the boost, the multipliers and the buff entry', JSON.stringify(exp));
  await waitFor(page, () => !(window.__game.getSystem('hud').localBuffs ?? []).some((c) => c.key === 'boost'), 'HUD strip boost cell gone', 10000);
  ok(true, 'HUD strip drops the boost thumbnail after expiry');

  // mutual exclusion + reset
  const mx = await P(() => {
    const p = window.__game.ctx.player, ps = window.__game.getSystem('player');
    p.applyBoost('stimulant', 'boost_stimulant'); const k1 = p.boost?.kind;
    p.stamina = 5;
    p.applyBoost('adrenaline', 'boost_adrenaline'); const k2 = p.boost?.kind; const s2 = p.stamina;
    p.applyBoost('stimulant', 'boost_stimulant');
    ps.resetTactical(); const k3 = p.boost;
    return { k1, k2, s2, max: p.maxStamina, k3 };
  });
  ok(mx.k1 === 'stimulant' && mx.k2 === 'adrenaline' && near(mx.s2, mx.max, 0.5) && mx.k3 === null, 'adrenaline replaces stimulant (and refills) · resetTactical clears', JSON.stringify(mx));

  /* ── stabilizer ───────────────────────────────────────────────────────── */
  console.log('안정제');
  const qB = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, imp = ctx.implants;
    window.__refills = 0;
    const orig = imp && typeof imp.refillAll === 'function' ? imp.refillAll.bind(imp) : null;
    if (imp) imp.refillAll = function () { window.__refills++; if (orig) orig(); };
    const it = ctx.loot.createItem('boost_stabilizer', 2); inv.tryAddItem(it);
    inv.setQuickSlot(0, it.uid);
    window.__ev['quick:used'] = [];
    return { eq: imp?.equipped ?? null, native: !!orig, uid: it.uid };
  });
  ok(qB.eq === 'dash', 'dash implant still equipped in the raid', JSON.stringify(qB));
  if (!qB.native) console.log('  note ImplantsRef.refillAll is not implemented yet — only the call is checked');
  await waitSim(0.6);
  ok(await ensureHeld('boost_stabilizer'), 'T tap → 안정제 in hand');
  await mDown(0);
  await waitSim(3.4);
  await mUp(0);
  await waitSim(0.2);
  const bDone = await P((uid) => {
    const ctx = window.__game.ctx;
    return { used: window.__ev['quick:used'].length, refills: window.__refills, left: ctx.inventory.findItem(uid)?.qty ?? 0, boost: ctx.player.boost };
  }, qB.uid);
  ok(bDone.used === 1 && bDone.left === 1, 'consumed at full implant charge (qty 2 → 1)', JSON.stringify(bDone));
  ok(bDone.refills === 1 && bDone.boost === null, 'ImplantsRef.refillAll called exactly once · no timed boost', JSON.stringify(bDone));

  ok(errors.length === 0, 'no uncaught page errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
