// Single-player smoke test for the progression folder's stat XP (2026-09-06): addStatXp raise / clamp at STAT_MAX /
// lower to STAT_MIN / carry-over, addSkillXpRaw down to level 0, profile migration + reload persistence, character sheet DOM.
// Phase 7 (2026-09-06): 감정 XP from `container:itemRevealed` (not `inventory:itemAdded`), training = gun_* only,
// server profile document (save → `profile.set('progression')`, `net:profileLoaded` replace + progress:* re-emit).
// Usage: node scripts/smoke-progression.mjs [http://localhost:5273]   (needs `npm run dev`)
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
const near = (a, b, eps = 1e-3) => typeof a === 'number' && Math.abs(a - b) <= eps;

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
    // Park vite's HMR socket (another agent's save would full-reload the page) AND the relay socket (`/ws?t=`): this is a
    // single-player script — a relay that happens to run on 8787 would otherwise hand the page a server profile and
    // make credits / documents server-owned mid-run. `ctx.net.profile.available` stays false, as documented.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws(\?|$)/.test(String(args[0]))) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Boot (or re-boot after a reload): frame driver for a hidden tab, fake pointer lock, bus recorder.
  const boot = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.progression, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['progress:statXp', 'progress:statChanged', 'progress:skillUp', 'progress:skillProgress', 'ui:statsToggled', 'progress:loaded', 'progress:xpGained']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p))); });
      }
    });
  };
  // headless software rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  // Key taps: keydown + keyup in the same evaluate (dt is clamped, any wait reads as a hold) on document.body, bubbling to window.
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const stat = (id) => page.evaluate((s) => {
    const p = window.__game.ctx.progression;
    return { value: p.getStat(s), progress: p.getStatProgress(s), next: p.statXpToNext(s), points: p.statPoints, carry: p.derived.carryCapacity };
  }, id);
  const skill = (id) => page.evaluate((s) => {
    const p = window.__game.ctx.progression;
    return { level: p.getSkill(s), progress: p.getSkillProgress(s), mul: p.getSkillGainMul(s) };
  }, id);

  await page.goto(BASE, { waitUntil: 'load' });
  await boot();

  console.log('fresh profile / statXpToNext');
  await page.evaluate(() => window.__game.ctx.progression.resetProfile());
  const fresh = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { str: p.getStat('strength'), prog: p.profile.statProgress, next5: p.statXpToNext('strength'), keys: Object.keys(p.profile.statProgress ?? {}) };
  });
  ok(fresh.str === 5 && fresh.keys.length === 5 && Object.values(fresh.prog).every((v) => v === 0), 'fresh profile: 5 stats at 5, statProgress zeros', JSON.stringify(fresh));
  ok(fresh.next5 === 1118, 'statXpToNext at 5 = round(100 × 5^1.5) = 1118', `${fresh.next5}`);

  console.log('addStatXp raise / clamp');
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 100000));
  let s = await stat('strength');
  ok(s.value === 20 && s.progress === 1, 'addStatXp(strength, 100000) → STAT_MAX 20, progress pinned at 1', JSON.stringify(s));
  ok(near(s.carry, 28 + 2.2 * 20, 1e-6), 'derived recomputed (carryCapacity 72 at 근력 20)', `${s.carry}`);
  ok(s.points === 0, 'level-up points untouched', `${s.points}`);
  let sc = await lastEv('progress:statChanged');
  ok(sc && sc.id === 'strength' && sc.value === 20 && sc.pointsLeft === 0, 'progress:statChanged {strength, 20, pointsLeft 0}', JSON.stringify(sc));
  let sx = await lastEv('progress:statXp');
  ok(sx && sx.id === 'strength' && sx.value === 20 && sx.progress === 1 && sx.delta === 100000, 'progress:statXp {value 20, progress 1, delta 100000}', JSON.stringify(sx));
  ok(s.next === Math.round(100 * Math.pow(20, 1.5)), 'statXpToNext at 20 = 8944', `${s.next}`);
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 500));
  s = await stat('strength');
  ok(s.value === 20 && s.progress === 1, 'more XP at STAT_MAX stays 20 / 1', JSON.stringify(s));
  const changedBefore = (await ev('progress:statChanged')).length;
  ok(changedBefore === 1, 'no statChanged when the value does not move', `${changedBefore}`);

  console.log('addStatXp lower / floor');
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', -1e9));
  s = await stat('strength');
  ok(s.value === 1 && s.progress === 0, 'addStatXp(strength, −1e9) → STAT_MIN 1, progress 0', JSON.stringify(s));
  ok(near(s.carry, 28 + 2.2, 1e-6), 'derived recomputed (carryCapacity 30.2 at 근력 1)', `${s.carry}`);
  sc = await lastEv('progress:statChanged');
  ok(sc && sc.value === 1, 'progress:statChanged value 1', JSON.stringify(sc));
  ok(s.next === 100, 'statXpToNext at 1 = 100', `${s.next}`);
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', -50));
  s = await stat('strength');
  ok(s.value === 1 && s.progress === 0, 'negative XP at STAT_MIN stays 1 / 0', JSON.stringify(s));

  console.log('small steps / carry-over');
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 30));
  s = await stat('strength');
  ok(s.value === 1 && near(s.progress, 0.3), '+30 at value 1 → progress 0.30', JSON.stringify(s));
  sx = await lastEv('progress:statXp');
  ok(sx && near(sx.progress, 0.3) && sx.delta === 30, 'progress:statXp {progress 0.3, delta 30}', JSON.stringify(sx));
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', -10));
  s = await stat('strength');
  ok(s.value === 1 && near(s.progress, 0.2), '−10 → progress 0.20', JSON.stringify(s));
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 90));
  s = await stat('strength');
  // 20 + 90 = 110 raw at value 1 (need 100) → value 2 with 10 raw left over of need(2) = 283
  ok(s.value === 2 && near(s.progress, 10 / 283), '+90 crosses the point → value 2, leftover 10/283 carried over', JSON.stringify(s));
  ok(s.next === 283, 'statXpToNext at 2 = 283', `${s.next}`);
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', -20));
  s = await stat('strength');
  // 10 − 20 = −10 → value 1, deficit taken off need(1) = 100 → 90/100
  ok(s.value === 1 && near(s.progress, 0.9), '−20 below zero → value 1, progress 0.90 (deficit off the new need)', JSON.stringify(s));
  const xpCount = (await ev('progress:statXp')).length;
  ok(xpCount === 8, 'progress:statXp emitted on every call (8)', `${xpCount}`);
  const changedCount = (await ev('progress:statChanged')).length;
  ok(changedCount === 4, 'progress:statChanged only on value changes (4)', `${changedCount}`);
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('nope', 100));
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', NaN));
  ok((await ev('progress:statXp')).length === 8, 'unknown stat / NaN amount ignored');

  console.log('addSkillXpRaw');
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', 50));
  let k = await skill('gun_AR');
  ok(k.level === 50 && k.progress === 0, 'addSkillXpRaw(gun_AR, 50) → level 50 (no scaling)', JSON.stringify(k));
  let su = await lastEv('progress:skillUp');
  ok(su && su.id === 'gun_AR' && su.level === 50, 'progress:skillUp {gun_AR, 50}', JSON.stringify(su));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', 0.5));
  k = await skill('gun_AR');
  ok(k.level === 50 && near(k.progress, 0.5), '+0.5 → progress 0.5 at level 50', JSON.stringify(k));
  let sp = await lastEv('progress:skillProgress');
  ok(sp && sp.id === 'gun_AR' && sp.level === 50 && near(sp.progress, 0.5), 'progress:skillProgress {50, 0.5}', JSON.stringify(sp));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', -1.2));
  k = await skill('gun_AR');
  ok(k.level === 49 && near(k.progress, 0.3), '−1.2 → level 49, progress 0.3', JSON.stringify(k));
  su = await lastEv('progress:skillUp');
  ok(su && su.level === 49, 'progress:skillUp also fires downward (level 49)', JSON.stringify(su));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', -1e6));
  k = await skill('gun_AR');
  ok(k.level === 0 && k.progress === 0, 'addSkillXpRaw(gun_AR, −1e6) → level 0, progress 0', JSON.stringify(k));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', 1e6));
  k = await skill('gun_AR');
  ok(k.level === 100 && k.progress === 0, 'addSkillXpRaw(gun_AR, 1e6) → SKILL_LEVEL_MAX 100', JSON.stringify(k));
  ok(k.mul === 1, 'getSkillGainMul(gun_AR) = 1 with the housing skeleton', `${k.mul}`);
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_AR', -100));

  console.log('감정 XP via container:itemRevealed (Phase 7)');
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('appraisal', -1e6));
  k = await skill('appraisal');
  ok(k.level === 0 && k.progress === 0, 'appraisal reset to 0');
  await page.evaluate(() => { const c = window.__game.ctx; const item = c.loot.createItem('mat_scrap', 1); c.bus.emit('inventory:itemAdded', { item, name: '폐금속', rarity: 'rare' }); });
  k = await skill('appraisal');
  ok(k.level === 0 && k.progress === 0, 'inventory:itemAdded no longer trains 감정');
  await page.evaluate(() => window.__game.ctx.bus.emit('container:itemRevealed', { containerId: 'crate:smoke', uid: 'u-smoke', defId: 'mat_scrap', rarity: 'rare' }));
  k = await skill('appraisal');
  // APPRAISE_XP_BY_RARITY.rare 0.11 × skillGainMul × statFactor (인지력 / 지능 at base → 1) at level 0
  ok(k.level === 0 && k.progress > 0.05 && k.progress < 0.3, 'container:itemRevealed {rare} trains 감정 (≈0.11)', JSON.stringify(k));
  const revealedOnce = k.progress;
  await page.evaluate(() => window.__game.ctx.bus.emit('container:itemRevealed', { containerId: 'crate:smoke', uid: 'u-smoke2', defId: 'mat_scrap', rarity: 'common' }));
  k = await skill('appraisal');
  ok(k.progress > revealedOnce && k.progress - revealedOnce < revealedOnce, 'a common reveal adds less than a rare one', JSON.stringify(k));

  console.log('training: only gun_* skills train (Phase 7)');
  await page.evaluate(() => { const c = window.__game.ctx; window.__origIsTraining = c.isTraining; c.isTraining = () => true; });
  const gardenBefore = await skill('gardening');
  await page.evaluate(() => { const p = window.__game.ctx.progression; p.addSkillXp('gardening', 5); p.addSkillXp('appraisal', 5); p.addSkillXp('carry', 5); });
  const gardenAfter = await skill('gardening');
  ok(gardenAfter.level === gardenBefore.level && gardenAfter.progress === gardenBefore.progress, 'addSkillXp(gardening / appraisal / carry) ignored while isTraining()', JSON.stringify(gardenAfter));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXpRaw('gun_SMG', -1e6));
  await page.evaluate(() => window.__game.ctx.progression.addSkillXp('gun_SMG', 0.5));
  k = await skill('gun_SMG');
  ok(k.level === 0 && k.progress > 0.3 && k.progress <= 0.5, 'addSkillXp(gun_SMG, 0.5) trains in a training (× TRAINING_SKILL_GAIN_MUL 1)', JSON.stringify(k));
  await page.evaluate(() => { const c = window.__game.ctx; if (window.__origIsTraining) c.isTraining = window.__origIsTraining; else delete c.isTraining; });
  ok(await page.evaluate(() => window.__game.ctx.isTraining() === false), 'isTraining restored (false outside a training)');
  await page.evaluate(() => { const p = window.__game.ctx.progression; p.addSkillXpRaw('gun_SMG', -1e6); p.addSkillXpRaw('appraisal', -1e6); });

  console.log('persistence / migration');
  // Leave strength at 1 with progress 0.9 (progress-only change → dirty, flushed by pagehide on reload).
  const key = await page.evaluate(() => {
    window.__game.ctx.progression.save();
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if ((localStorage.getItem(k) ?? '').includes('"statProgress"')) return k; }
    return null;
  });
  ok(!!key, 'profile saved with statProgress in localStorage', `${key}`);
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 5));   // 0.95 — progress only, not flushed yet
  await page.reload({ waitUntil: 'load' });
  await boot();
  s = await stat('strength');
  ok(s.value === 1 && near(s.progress, 0.95), 'reload keeps stats + statProgress (pagehide flush)', JSON.stringify(s));
  k = await skill('gun_AR');
  ok(k.level === 0, 'reload keeps the lowered skill level', JSON.stringify(k));
  // Legacy save: no statProgress, a stat below STAT_MIN and one progress out of range → migrated + clamped.
  await page.evaluate((k) => {
    const raw = JSON.parse(localStorage.getItem(k));
    delete raw.statProgress;
    raw.stats.strength = 0;
    raw.stats.dexterity = 7;
    localStorage.setItem(k, JSON.stringify(raw));
  }, key);
  await page.reload({ waitUntil: 'load' });
  await boot();
  const mig = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { str: p.getStat('strength'), dex: p.getStat('dexterity'), prog: p.profile.statProgress };
  });
  ok(mig.prog && Object.keys(mig.prog).length === 5 && Object.values(mig.prog).every((v) => v === 0), 'legacy save without statProgress migrates to zeros', JSON.stringify(mig));
  ok(mig.str === 1 && mig.dex === 7, 'migrate clamps stats to STAT_MIN..STAT_MAX (0 → 1, 7 kept)', JSON.stringify(mig));
  await page.evaluate((k) => {
    const raw = JSON.parse(localStorage.getItem(k));
    raw.statProgress = { strength: 5, dexterity: -2, perception: 0.4 };
    localStorage.setItem(k, JSON.stringify(raw));
  }, key);
  await page.reload({ waitUntil: 'load' });
  await boot();
  const mig2 = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { str: p.getStatProgress('strength'), dex: p.getStatProgress('dexterity'), per: p.getStatProgress('perception'), int: p.getStatProgress('intelligence') };
  });
  ok(mig2.str < 1 && mig2.str >= 0.999 && mig2.dex === 0 && near(mig2.per, 0.4) && mig2.int === 0, 'migrate clamps statProgress to 0..0.999999', JSON.stringify(mig2));

  console.log('server profile document (Phase 7)');
  await page.evaluate(() => {
    const net = window.__game.ctx.net;
    const fake = { available: true, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    window.__fakeProfile = fake;
    window.__realProfileDesc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
  });
  // save → profile.set('progression'); no document yet → net:profileLoaded uploads the local profile
  const localSnap = await page.evaluate(() => JSON.parse(JSON.stringify(window.__game.ctx.progression.profile)));
  await page.evaluate(() => { window.__game.ctx.progression.addStatXp('dexterity', 1); window.__game.ctx.progression.save(); });
  ok(await page.evaluate(() => window.__fakeProfile.sets.includes('progression') && window.__fakeProfile.docs.progression.stats.dexterity === 7 && window.__fakeProfile.docs.progression.statProgress.dexterity > 0), "save → profile.set('progression', profile)");
  await page.evaluate(() => { window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: {}, updatedAt: 0 }, migrated: true }); });
  const noDoc = await page.evaluate(() => ({ sets: window.__fakeProfile.sets.slice(), level: window.__game.ctx.progression.level, str: window.__game.ctx.progression.getStat('strength') }));
  ok(noDoc.sets.includes('progression') && noDoc.level === localSnap.level && noDoc.str === localSnap.stats.strength, 'no server document → local profile uploaded, nothing replaced', JSON.stringify(noDoc));
  // a server document replaces the profile and re-emits the progress:* events
  const counts0 = await page.evaluate(() => ({ loaded: window.__ev['progress:loaded'].length, xp: window.__ev['progress:xpGained'].length, stat: window.__ev['progress:statChanged'].length, skill: window.__ev['progress:skillProgress'].length }));
  await page.evaluate((snap) => {
    const doc = { ...snap, level: 7, xp: 50, statPoints: 2, stats: { ...snap.stats, strength: 9 }, skills: { ...snap.skills, gun_AR: 12 }, skillProgress: { ...snap.skillProgress, gun_AR: 0.25 } };
    window.__fakeProfile.docs = { progression: doc };
    window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false });
  }, localSnap);
  const srv = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { level: p.level, xp: p.xp, points: p.statPoints, str: p.getStat('strength'), gunAR: p.getSkill('gun_AR'), gunProg: p.getSkillProgress('gun_AR'), carry: p.derived.carryCapacity,
      loaded: window.__ev['progress:loaded'].length, xpEv: window.__ev['progress:xpGained'].length, stat: window.__ev['progress:statChanged'].length, skill: window.__ev['progress:skillProgress'].length,
      local: JSON.parse(localStorage.getItem('scav.profile') ?? localStorage.getItem(Object.keys(localStorage).find((k) => (localStorage.getItem(k) ?? '').includes('"statProgress"')) ?? '') ?? 'null')?.level };
  });
  ok(srv.level === 7 && srv.xp === 50 && srv.points === 2 && srv.str === 9 && srv.gunAR === 12 && near(srv.gunProg, 0.25), 'net:profileLoaded → server document replaces level / xp / points / stats / skills', JSON.stringify(srv));
  ok(near(srv.carry, 28 + 2.2 * 9, 1e-6), 'derived recomputed from the server profile (carry 47.8 at 근력 9)', `${srv.carry}`);
  ok(srv.loaded === counts0.loaded + 1 && srv.xpEv === counts0.xp + 1 && srv.stat === counts0.stat + 5 && srv.skill === counts0.skill + 14, 're-emitted progress:loaded + xpGained + 5 statChanged + 14 skillProgress', JSON.stringify({ before: counts0, after: { loaded: srv.loaded, xp: srv.xpEv, stat: srv.stat, skill: srv.skill } }));
  ok(srv.local === 7, 'localStorage cache updated with the server profile', `${srv.local}`);
  // put the local profile back through the same path so the sheet checks below see the migrated values
  await page.evaluate((snap) => { window.__fakeProfile.docs = { progression: snap }; window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: window.__fakeProfile.docs, updatedAt: 0 }, migrated: false }); }, localSnap);
  ok(await page.evaluate((snap) => window.__game.ctx.progression.level === snap.level && window.__game.ctx.progression.getStat('strength') === snap.stats.strength, localSnap), 'local profile restored through net:profileLoaded');
  await page.evaluate(() => { const net = window.__game.ctx.net; if (window.__realProfileDesc) Object.defineProperty(net, 'profile', window.__realProfileDesc); else delete net.profile; });
  ok(await page.evaluate(() => window.__game.ctx.net.profile.available === false), 'real (offline) profile restored');

  console.log('character sheet');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.5);
  await page.evaluate(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: true }));
  await sleep(200);
  const dom = await page.evaluate(() => {
    const root = document.querySelector('.char-sheet');
    const rows = [...document.querySelectorAll('.cs-stat')];
    return {
      open: !!root && !root.hidden, blocker: window.__game.ctx.uiBlockers.has('stats'),
      rows: rows.length, bars: document.querySelectorAll('.cs-stat .sp .bar i').length,
      xp: rows.map((r) => r.querySelector('.sp .xp')?.textContent ?? ''),
      fill: rows.map((r) => r.querySelector('.sp .bar i')?.style.transform ?? ''),
      bonusHidden: [...document.querySelectorAll('.cs-skill .bonus')].every((b) => b.hidden),
    };
  });
  ok(dom.open && dom.blocker, 'character sheet opens (blocker stats)', JSON.stringify({ open: dom.open, blocker: dom.blocker }));
  ok(dom.rows === 5 && dom.bars === 5, '5 stat rows each carry a stat-XP bar', `${dom.rows}/${dom.bars}`);
  ok(dom.xp.every((t) => / \/ \d+ XP$/.test(t)), 'stat rows show `xp / next XP`', JSON.stringify(dom.xp));
  // strength progress is the migrated 0.999999 → floor(99.9999) = 99 / 100, bar scaleX(1.0000) after toFixed(4)
  ok(/^99 \/ 100 XP$/.test(dom.xp[0]) && /scaleX\((0\.99|1)/.test(dom.fill[0]), '근력 row: 99 / 100 XP, bar ≈ 1', `${dom.xp[0]} ${dom.fill[0]}`);
  ok(/^0 \/ \d+ XP$/.test(dom.xp[4]) && /scaleX\(0(\.0+)?\)/.test(dom.fill[4]), '재주 row: 0 / next XP, empty bar', `${dom.xp[4]} ${dom.fill[4]}`);
  ok(dom.bonusHidden, 'skill facility bonus badges hidden while the multiplier is 1');
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('strength', 1000));
  await sleep(100);
  const live = await page.evaluate(() => {
    const row = document.querySelector('.cs-stat');
    return { v: row.querySelector('.v').textContent, xp: row.querySelector('.sp .xp').textContent };
  });
  // 99.9999 + 1000 raw at value 1 (need 100) → 2 (need 283): 999.99 → 3 (need 520): 716.99 → 4 (need 800): 196.99 left → 근력 4, 196 / 800
  ok(live.v === '4' && live.xp === '196 / 800 XP', 'sheet updates live on addStatXp (근력 4, 196 / 800 XP)', JSON.stringify(live));
  await page.evaluate(() => window.__game.ctx.progression.addStatXp('perception', 1e6));
  await sleep(100);
  const maxed = await page.evaluate(() => {
    const row = document.querySelectorAll('.cs-stat')[2];
    return { cls: row.className, xp: row.querySelector('.sp .xp').textContent, fill: row.querySelector('.sp .bar i').style.transform };
  });
  ok(/maxed/.test(maxed.cls) && maxed.xp === '최대' && /scaleX\(1/.test(maxed.fill), 'maxed stat shows 최대 with a full bar', JSON.stringify(maxed));
  await tap('Escape');
  await sleep(150);
  const closed = await page.evaluate(() => ({ hidden: document.querySelector('.char-sheet').hidden, blocker: window.__game.ctx.uiBlockers.has('stats') }));
  ok(closed.hidden && !closed.blocker, 'Esc closes the sheet and drops the blocker', JSON.stringify(closed));
  const toggled = await lastEv('ui:statsToggled');
  ok(toggled && toggled.open === false, 'ui:statsToggled {open:false}');

  // Clean up so the next script starts from a fresh character.
  await page.evaluate(() => window.__game.ctx.progression.resetProfile());

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, '0 console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
