// Single-player smoke test for the progression folder's stat XP (2026-09-06): addStatXp raise / clamp at STAT_MAX /
// lower to STAT_MIN / carry-over, addSkillXpRaw down to level 0, profile migration + reload persistence, character sheet DOM.
// Phase 7 (2026-09-06): 감정 XP from `container:itemRevealed` (not `inventory:itemAdded`), training = gun_* only,
// server profile document (save → `profile.set('progression')`, `net:profileLoaded` replace + progress:* re-emit).
// Phase 12 (2026-09-08): 임플란트 items — slots by level (4 / 5 / 10), the 46 defs + repair costs + HEAL_SPRAY_GAUGE, loot rules
// (broken-only, boss legendaries, tier 4 only), equip / unequip / refusals / derived + perks, raid lock, 캐릭터 sheet block +
// picker DOM, reload + server-document round-trip. 119 checks.
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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
      for (const n of ['progress:statXp', 'progress:statChanged', 'progress:skillUp', 'progress:skillProgress', 'ui:statsToggled', 'progress:loaded', 'progress:xpGained', 'progress:implantsChanged']) {
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

  console.log('housing multiplier (Phase 9: 사격장 × 서재 through one getSkillGainMul)');
  // a fake `ctx.housing.getSkillGainMul` stands in for 사격장 + 서재: the product must scale the skill XP, nothing else
  const mulProbe = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const p = ctx.progression;
    const real = ctx.housing;
    const realMul = real.getSkillGainMul.bind(real);
    real.getSkillGainMul = (id) => (id === 'crafting' ? 1.5 : 1);
    try {
      const mul = p.getSkillGainMul('crafting');
      p.addSkillXpRaw('crafting', -1e6);
      p.addSkillXp('crafting', 0.05);
      const boosted = p.getSkillProgress('crafting');
      real.getSkillGainMul = () => 1;
      p.addSkillXpRaw('crafting', -1e6);
      p.addSkillXp('crafting', 0.05);
      const plain = p.getSkillProgress('crafting');
      return { mul, boosted, plain, other: p.getSkillGainMul('gun_AR') };
    } finally { real.getSkillGainMul = realMul; }
  });
  ok(mulProbe.mul === 1.5 && mulProbe.other === 1, 'getSkillGainMul reads ctx.housing.getSkillGainMul per skill', JSON.stringify(mulProbe));
  ok(mulProbe.plain > 0 && near(mulProbe.boosted / mulProbe.plain, 1.5, 1e-6), 'a fake housing ×1.5 multiplies the skill XP of addSkillXp by 1.5', JSON.stringify(mulProbe));

  console.log('server profile document (Phase 7)');
  // Phase 9: `upload()` calls `profile.set` even while the profile is **offline** (ProfileSync queues it)
  await page.evaluate(() => {
    const net = window.__game.ctx.net;
    const fake = { available: false, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    window.__fakeProfile = fake;
    window.__realProfileDesc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
    window.__game.ctx.progression.addSkillXpRaw('gun_SG', 0.01);
    window.__game.ctx.progression.save();
  });
  ok(await page.evaluate(() => window.__fakeProfile.sets.includes('progression') && !!window.__fakeProfile.docs.progression), "offline profile (available false): save still calls profile.set('progression') — ProfileSync queues it (Phase 9)");
  await page.evaluate(() => { window.__fakeProfile.available = true; window.__fakeProfile.docs = {}; window.__fakeProfile.sets.length = 0; });
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
      cursor: window.__game.ctx.input.isCursorMode,
      rows: rows.length, bars: document.querySelectorAll('.cs-stat .sp .bar i').length,
      xp: rows.map((r) => r.querySelector('.sp .xp')?.textContent ?? ''),
      fill: rows.map((r) => r.querySelector('.sp .bar i')?.style.transform ?? ''),
      bonusHidden: [...document.querySelectorAll('.cs-skill .bonus')].every((b) => b.hidden),
    };
  });
  // Phase 10: the sheet keeps the pointer lock and turns on the in-game cursor instead of exiting the lock
  ok(dom.open && dom.blocker && dom.cursor, 'character sheet opens (blocker stats + in-game cursor)', JSON.stringify({ open: dom.open, blocker: dom.blocker, cursor: dom.cursor }));
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
  // 2026-09-08: Tab closes the sheet (it is the 캐릭터 tab of the same window); Escape is the 일시정지 메뉴
  await tap('Tab');
  await sleep(150);
  const closed = await page.evaluate(() => ({
    hidden: document.querySelector('.char-sheet').hidden, blocker: window.__game.ctx.uiBlockers.has('stats'),
    cursor: window.__game.ctx.input.isCursorMode,
  }));
  ok(closed.hidden && !closed.blocker && !closed.cursor, 'Tab closes the sheet and drops the blocker + the cursor', JSON.stringify(closed));
  const toggled = await lastEv('ui:statsToggled');
  ok(toggled && toggled.open === false, 'ui:statsToggled {open:false}');

  console.log('임플란트 items (Phase 12): slots by level');
  const levelTo = (lv) => page.evaluate((target) => {
    const p = window.__game.ctx.progression;
    for (let i = 0; i < 200 && p.level < target; i++) p.addXp(Math.max(1, p.xpToNext - p.xp));
    return { level: p.level, slots: p.implantSlots, used: p.implantSlotsUsed };
  }, lv);
  await page.evaluate(() => window.__game.ctx.progression.resetProfile());
  let sl = await page.evaluate(() => { const p = window.__game.ctx.progression; return { level: p.level, slots: p.implantSlots, used: p.implantSlotsUsed, eq: p.getEquippedImplants().length }; });
  ok(sl.level === 1 && sl.slots === 4 && sl.used === 0 && sl.eq === 0, 'fresh character: level 1 → 4 implant slots, 0 used, nothing equipped', JSON.stringify(sl));
  sl = await levelTo(5);
  ok(sl.level === 5 && sl.slots === 5, 'level 5 → 5 slots (IMPLANT_SLOTS_BASE 4 + 1 per 5 levels)', JSON.stringify(sl));
  sl = await levelTo(30);
  ok(sl.level === 30 && sl.slots === 10, 'level 30 → 10 slots (capped at IMPLANT_SLOTS_MAX)', JSON.stringify(sl));
  await page.evaluate(() => window.__game.ctx.progression.resetProfile());

  console.log('임플란트 items: defs');
  const defs = await page.evaluate(() => {
    const loot = window.__game.ctx.loot;
    const all = loot.getAllItemDefs().filter((d) => d.category === 'implant');
    const s2 = loot.getItemDef('imp_strength_2'), b2 = loot.getItemDef('imp_broken_strength_2'), qh = loot.getItemDef('imp_perk_quick_heal'), bqh = loot.getItemDef('imp_broken_perk_quick_heal');
    return {
      n: all.length, working: all.filter((d) => !d.implant.broken).length, broken: all.filter((d) => d.implant.broken).length,
      s2: s2 && { name: s2.name, rarity: s2.rarity, slots: s2.implant.slots, stats: s2.implant.stats, w: s2.width, h: s2.height, stack: s2.stackMax },
      b2: b2 && { name: b2.name, rarity: b2.rarity, slots: b2.implant.slots, broken: b2.implant.broken, to: b2.implant.repairsTo, cost: b2.implant.repairCost, stats: b2.implant.stats, value: b2.value, wv: s2.value },
      qh: qh && { name: qh.name, rarity: qh.rarity, slots: qh.implant.slots, perk: qh.implant.perk, stats: qh.implant.stats },
      bqh: bqh && { to: bqh.implant.repairsTo, cost: bqh.implant.repairCost.map((c) => `${c.defId}×${c.qty}`) },
      costsKnown: all.every((d) => !d.implant.repairCost || d.implant.repairCost.every((c) => !!loot.getItemDef(c.defId))),
      spray: loot.getItemDef('heal_spray').durabilityMax,
    };
  });
  ok(defs.n === 46 && defs.working === 23 && defs.broken === 23, '46 implant defs: 23 working (5 stats × I–IV + 3 legendary perks) + 23 broken twins', JSON.stringify({ n: defs.n, w: defs.working, b: defs.broken }));
  ok(defs.s2 && defs.s2.name === '근력 임플란트 II' && defs.s2.rarity === 'uncommon' && defs.s2.slots === 2 && defs.s2.stats.strength === 2 && defs.s2.w === 1 && defs.s2.h === 1 && defs.s2.stack === 1, 'imp_strength_2: 근력 임플란트 II, uncommon, 2 slots, 근력 +2, 1×1, no stacking', JSON.stringify(defs.s2));
  ok(defs.b2 && defs.b2.name === '망가진 근력 임플란트 II' && defs.b2.rarity === 'uncommon' && defs.b2.broken === true && defs.b2.to === 'imp_strength_2' && Object.keys(defs.b2.stats).length === 0 && defs.b2.slots === 2 && defs.b2.value * 4 === defs.b2.wv, 'imp_broken_strength_2: 망가진 twin, same rarity / slots, no stats, repairsTo imp_strength_2, value ¼', JSON.stringify(defs.b2));
  ok(defs.b2 && defs.b2.cost.length === 3 && defs.b2.cost.some((c) => c.defId === 'mat_circuit') && defs.b2.cost.some((c) => c.defId === 'mat_alloy'), 'grade II repair cost: 회로 기판 + 케이블 + 합금 판', JSON.stringify(defs.b2?.cost));
  ok(defs.qh && defs.qh.name === '가속 대사' && defs.qh.rarity === 'legendary' && defs.qh.slots === 2 && defs.qh.perk === 'quick_heal' && defs.qh.stats.dexterity === 1, 'imp_perk_quick_heal: 가속 대사, legendary, 2 slots, perk quick_heal, 재주 +1', JSON.stringify(defs.qh));
  ok(defs.bqh && defs.bqh.to === 'imp_perk_quick_heal' && defs.bqh.cost.length === 4 && defs.bqh.cost.includes('mat_circuit×3'), 'broken legendary repairs to the perk implant for 회로 기판 3 + 케이블 3 + 합금 판 2 + 소독약 1', JSON.stringify(defs.bqh));
  ok(defs.costsKnown, 'every repairCost def id resolves');
  ok(defs.spray === 200, 'heal_spray durabilityMax follows HEAL_SPRAY_GAUGE (200)', `${defs.spray}`);

  console.log('임플란트 items: loot');
  const loot = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const out = { rogue: 0, boss: 0, bossLegend: 0, working: 0, crateBroken: 0, crateWorking: 0, crateLegendT3: 0 };
    for (let i = 0; i < 400; i++) {
      for (const t of ['rogue', 'rogue_boss']) {
        for (const it of ctx.loot.rollCorpse(t)) {
          const d = ctx.loot.getItemDef(it.defId);
          if (d?.category !== 'implant') continue;
          if (!d.implant.broken) out.working++;
          if (t === 'rogue') out.rogue++; else { out.boss++; if (d.rarity === 'legendary') out.bossLegend++; }
        }
      }
    }
    for (let tier = 2; tier <= 4; tier++) {
      for (let i = 0; i < 300; i++) {
        for (const it of ctx.loot.rollCrate(tier, undefined)) {
          const d = ctx.loot.getItemDef(it.defId);
          if (d?.category !== 'implant') continue;
          if (d.implant.broken) out.crateBroken++; else out.crateWorking++;
          if (tier < 4 && d.rarity === 'legendary') out.crateLegendT3++;
        }
      }
    }
    return out;
  });
  ok(loot.rogue > 0 && loot.boss > loot.rogue, `로그 / 보스 시체 drop broken implants (rogue ${loot.rogue} / boss ${loot.boss} of 400)`, JSON.stringify(loot));
  ok(loot.bossLegend > 0, `boss corpses can carry a broken legendary (${loot.bossLegend})`, JSON.stringify(loot));
  ok(loot.working === 0 && loot.crateWorking === 0, 'no working implant ever drops (corpses / crates)', JSON.stringify(loot));
  ok(loot.crateBroken > 0 && loot.crateLegendT3 === 0, `tier 2–4 crates drop broken implants (${loot.crateBroken}), broken legendaries never below tier 4`, JSON.stringify(loot));

  console.log('임플란트 items: equip / unequip in the hub');
  ok(await page.evaluate(() => window.__game.ctx.phase === 'hub'), 'still in the hub');
  const mk = (defId) => page.evaluate((id) => { const ctx = window.__game.ctx; const it = ctx.loot.createItem(id, 1); const okAdd = ctx.inventory.tryAddToStash(it); window.__impUids = window.__impUids ?? []; window.__impUids.push(it.uid); return okAdd ? it.uid : null; }, defId);
  const uS2 = await mk('imp_strength_2');
  const uE4 = await mk('imp_endurance_4');
  const uB1 = await mk('imp_broken_strength_1');
  const uQH = await mk('imp_perk_quick_heal');
  ok(uS2 && uE4 && uB1 && uQH, 'created imp_strength_2 / imp_endurance_4 / imp_broken_strength_1 / imp_perk_quick_heal in the 함선 창고', JSON.stringify({ uS2, uE4, uB1, uQH }));
  const before = await page.evaluate(() => { const p = window.__game.ctx.progression; return { str: p.getStat('strength'), eff: p.getStatWithImplants('strength'), carry: p.derived.carryCapacity, stash: window.__game.ctx.inventory.getStashItems().length }; });
  const eq1 = await page.evaluate((uid) => {
    const ctx = window.__game.ctx; const p = ctx.progression;
    const okEq = p.equipImplant(uid);
    return { okEq, used: p.implantSlotsUsed, slots: p.implantSlots, str: p.getStat('strength'), eff: p.getStatWithImplants('strength'), bonus: p.getImplantBonus('strength'), carry: p.derived.carryCapacity,
      inStash: !!ctx.inventory.findItemAnywhere(uid), eq: p.getEquippedImplants().map((e) => e.defId), melee: p.derived.meleeDamageMul, profile: (p.profile.implants ?? []).length };
  }, uS2);
  ok(eq1.okEq && eq1.used === 2 && eq1.slots === 4, 'equipImplant(imp_strength_2) → true, 2 / 4 slots used', JSON.stringify(eq1));
  ok(eq1.str === before.str && eq1.eff === before.str + 2 && eq1.bonus === 2, 'getStat unchanged (base), getStatWithImplants = base + 2, getImplantBonus 2', JSON.stringify({ before: before.str, eq1 }));
  ok(near(eq1.carry, before.carry + 2.2 * 2, 1e-6) && eq1.melee > 1, 'derived recomputed from the effective stat (carryCapacity +4.4, meleeDamageMul > 1)', JSON.stringify({ before: before.carry, after: eq1.carry, melee: eq1.melee }));
  ok(!eq1.inStash && eq1.eq.length === 1 && eq1.eq[0] === 'imp_strength_2' && eq1.profile === 1, 'the item left the 창고 and lives in profile.implants', JSON.stringify(eq1));
  let ic = await lastEv('progress:implantsChanged');
  ok(ic && ic.used === 2 && ic.slots === 4 && ic.equipped.length === 1 && ic.equipped[0].uid === uS2, 'progress:implantsChanged {equipped, slots 4, used 2}', JSON.stringify(ic));
  const over = await page.evaluate((uid) => { const p = window.__game.ctx.progression; return { okEq: p.equipImplant(uid), used: p.implantSlotsUsed, still: !!window.__game.ctx.inventory.findItemAnywhere(uid) }; }, uE4);
  ok(!over.okEq && over.used === 2 && over.still, 'overfill refused: imp_endurance_4 (3 slots) does not fit in the 2 left — item stays in the 창고', JSON.stringify(over));
  const brk = await page.evaluate((uid) => { const p = window.__game.ctx.progression; return { okEq: p.equipImplant(uid), used: p.implantSlotsUsed, still: !!window.__game.ctx.inventory.findItemAnywhere(uid) }; }, uB1);
  ok(!brk.okEq && brk.used === 2 && brk.still, 'broken implant refused (imp_broken_strength_1, 1 slot free would fit)', JSON.stringify(brk));
  const dup = await page.evaluate((uid) => window.__game.ctx.progression.equipImplant(uid), uS2);
  ok(dup === false, 'equipping an already-equipped uid is refused');
  const unknown = await page.evaluate(() => window.__game.ctx.progression.equipImplant('nope-uid'));
  ok(unknown === false, 'unknown uid refused');
  const eqQ = await page.evaluate((uid) => { const p = window.__game.ctx.progression; return { okEq: p.equipImplant(uid), used: p.implantSlotsUsed, perks: p.derived.perks, dex: p.getImplantBonus('dexterity') }; }, uQH);
  ok(eqQ.okEq && eqQ.used === 4 && eqQ.perks.quick_heal === true && eqQ.perks.auto_revive === false && eqQ.perks.kill_stamina === false && eqQ.dex === 1, 'legendary 가속 대사 equips (4 / 4) → derived.perks.quick_heal true, others false, 재주 +1', JSON.stringify(eqQ));
  const un = await page.evaluate((uid) => {
    const ctx = window.__game.ctx; const p = ctx.progression;
    const okUn = p.unequipImplant(uid);
    const back = ctx.inventory.getStashItems().find((i) => i.uid === uid);
    return { okUn, used: p.implantSlotsUsed, back: !!back, backDef: back?.defId, eff: p.getStatWithImplants('strength'), str: p.getStat('strength'), carry: p.derived.carryCapacity, eq: p.getEquippedImplants().map((e) => e.defId) };
  }, uS2);
  ok(un.okUn && un.used === 2 && un.back && un.backDef === 'imp_strength_2', 'unequipImplant(imp_strength_2) → true, item back in the 창고 with the same uid, 2 / 4 used', JSON.stringify(un));
  ok(un.eff === un.str && near(un.carry, before.carry, 1e-6) && un.eq.length === 1 && un.eq[0] === 'imp_perk_quick_heal', 'bonus gone after unequip (carry back to base), 가속 대사 still equipped', JSON.stringify(un));
  ok((await page.evaluate(() => window.__game.ctx.progression.unequipImplant('nope-uid'))) === false, 'unequip of an unknown uid refused');
  ic = await lastEv('progress:implantsChanged');
  ok(ic && ic.used === 2 && ic.equipped.length === 1, 'progress:implantsChanged after unequip {used 2, 1 equipped}', JSON.stringify(ic));

  console.log('임플란트 items: raid lock');
  const raid = await page.evaluate((uid) => {
    const ctx = window.__game.ctx; const p = ctx.progression;
    const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    try { return { eq: p.equipImplant(uid), un: p.unequipImplant(p.getEquippedImplants()[0].uid), used: p.implantSlotsUsed }; }
    finally { ctx.isRaidActive = real; }
  }, uS2);
  ok(!raid.eq && !raid.un && raid.used === 2, 'equip / unequip refused while isRaidActive() (nothing moved)', JSON.stringify(raid));
  const menuPhase = await page.evaluate((uid) => {
    const ctx = window.__game.ctx; const p = ctx.progression;
    const real = ctx.phase; ctx.setPhase('menu');
    try { return { eq: p.equipImplant(uid), phase: ctx.phase }; } finally { ctx.setPhase(real); }
  }, uS2);
  ok(!menuPhase.eq && menuPhase.phase === 'menu', 'equip refused outside the hub phase', JSON.stringify(menuPhase));

  console.log('임플란트 items: 캐릭터 시트는 능력치 표시만 남는다 (2026-09-08)');
  await page.evaluate(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: true }));
  await sleep(200);
  const sheet = await page.evaluate(() => {
    const root = document.querySelector('.char-sheet');
    const stat = root.querySelector('.cs-stat .v');
    const dexRow = root.querySelectorAll('.cs-stat')[4];
    return {
      stray: root.querySelectorAll('.cs-impitems, .cs-implants, .cs-imp-slot').length,
      strayPop: document.querySelectorAll('.cs-impi-pop-overlay, .cs-imp-pop-overlay').length,
      cols: root.querySelectorAll('.cs-body > .cs-col').length,
      strV: stat?.textContent, dexV: dexRow?.querySelector('.v')?.textContent, dexBonus: dexRow?.querySelector('.ib')?.textContent,
    };
  });
  ok(sheet.stray === 0 && sheet.strayPop === 0 && sheet.cols === 2, '캐릭터 시트에서 임플란트 UI 가 사라지고 2열만 남았다', JSON.stringify(sheet));
  ok(/\(\+1\)/.test(sheet.dexV) && sheet.dexBonus === ' (+1)' && !/\(/.test(sheet.strV), '재주 row shows `base (+1)`, 근력 row shows the base only', JSON.stringify({ dex: sheet.dexV, str: sheet.strV }));
  await tap('Escape');
  await sleep(150);

  console.log('임플란트 items: 인벤토리 장착 장비 칸의 블록 + picker');
  await page.evaluate(() => window.__game.ctx.inventory.toggleBag());
  await sleep(250);
  const blk = await page.evaluate(() => {
    const b = document.querySelector('.inv-equip .inv-implants .inv-impitems');
    const rows = [...b.querySelectorAll('.inv-impi-row')];
    return {
      has: !!b, cnt: b.querySelector('.cnt')?.textContent, pips: b.querySelectorAll('.inv-impi-pips i').length, on: b.querySelectorAll('.inv-impi-pips i.on').length,
      rows: rows.map((r) => ({ uid: r.dataset.uid, def: r.dataset.defId, nm: r.querySelector('.nm')?.textContent, tag: r.querySelector('.tag')?.textContent, meta: r.querySelector('.meta')?.textContent, chip: !!r.querySelector('.item-chip[data-def-id]') })),
      add: !!b.querySelector('.inv-impi-add'),
      popHidden: document.querySelector('.inv-impi-pop')?.hidden,
    };
  });
  ok(blk.has && blk.cnt === '2 / 4칸' && blk.pips === 4 && blk.on === 2 && blk.add, '임플란트 block: `2 / 4칸`, 4 pips (2 lit), + 장착 button', JSON.stringify({ cnt: blk.cnt, pips: blk.pips, on: blk.on }));
  ok(blk.rows.length === 1 && blk.rows[0].def === 'imp_perk_quick_heal' && blk.rows[0].nm === '가속 대사' && blk.rows[0].tag === '장착칸 2' && /재주 \+1/.test(blk.rows[0].meta) && blk.rows[0].chip, 'equipped row: shared item chip (data-def-id) + 가속 대사 · 장착칸 2 · 재주 +1', JSON.stringify(blk.rows));
  ok(blk.popHidden === true, 'item picker exists as a uiRoot child (.inv-impi-pop) and starts hidden');
  await page.evaluate(() => document.querySelector('.inv-equip .inv-impi-add').click());
  await sleep(150);
  const pick = await page.evaluate(() => {
    const pop = document.querySelector('.inv-impi-pop');
    const opts = [...pop.querySelectorAll('.inv-impi-opt')];
    return {
      hidden: pop.hidden, parentIsRoot: pop.parentElement === window.__game.ctx.uiRoot, n: opts.length,
      opts: opts.map((o) => ({ def: o.dataset.defId, dim: o.classList.contains('is-dim'), disabled: o.disabled, why: o.querySelector('.why')?.textContent ?? '', chip: !!o.querySelector('.item-chip[data-def-id]') })),
    };
  });
  const optS2 = pick.opts.find((o) => o.def === 'imp_strength_2'), optE4 = pick.opts.find((o) => o.def === 'imp_endurance_4'), optB1 = pick.opts.find((o) => o.def === 'imp_broken_strength_1');
  ok(!pick.hidden && pick.parentIsRoot && pick.n === 3, '+ 장착 opens the picker (uiRoot child) listing the 3 implant items in the 창고', JSON.stringify({ n: pick.n, opts: pick.opts.map((o) => o.def) }));
  ok(optS2 && !optS2.dim && !optS2.disabled && optS2.chip, 'imp_strength_2 (2 slots, 2 free) listed enabled with the shared chip', JSON.stringify(optS2));
  ok(optE4 && optE4.dim && optE4.disabled && optE4.why === '장착칸 부족', 'imp_endurance_4 (3 slots) dimmed + disabled: 장착칸 부족', JSON.stringify(optE4));
  ok(optB1 && optB1.dim && optB1.disabled && optB1.why === '망가짐 — 세레스 바이오에서 수리', 'broken implant dimmed + disabled: 망가짐 — 세레스 바이오에서 수리', JSON.stringify(optB1));
  await page.evaluate((uid) => document.querySelector(`.inv-impi-pop .inv-impi-opt[data-uid="${uid}"]`).click(), uS2);
  await sleep(150);
  const picked = await page.evaluate(() => {
    const b = document.querySelector('.inv-equip .inv-implants'); const p = window.__game.ctx.progression;
    return { used: p.implantSlotsUsed, cnt: b.querySelector('.inv-impitems .cnt').textContent, rows: b.querySelectorAll('.inv-impi-row').length, opts: document.querySelectorAll('.inv-impi-pop .inv-impi-opt').length, msg: b.querySelector('.inv-impi-msg').textContent };
  });
  ok(picked.used === 4 && picked.cnt === '4 / 4칸' && picked.rows === 2 && picked.opts === 2 && /장착/.test(picked.msg), 'clicking the option equips it: 4 / 4칸, 2 rows, picker re-lists 2, inline `장착` message', JSON.stringify(picked));
  await tap('Escape');
  await sleep(120);
  const escd = await page.evaluate(() => ({ pop: document.querySelector('.inv-impi-pop').hidden, win: document.querySelector('.inv-root').hidden }));
  ok(escd.pop && !escd.win, 'Escape closes the item picker first (the window stays open)', JSON.stringify(escd));
  await page.evaluate((uid) => document.querySelector(`.inv-equip .inv-impi-row[data-uid="${uid}"]`).click(), uS2);
  await sleep(120);
  const unRow = await page.evaluate(() => { const p = window.__game.ctx.progression; return { used: p.implantSlotsUsed, rows: document.querySelectorAll('.inv-equip .inv-impi-row').length }; });
  ok(unRow.used === 2 && unRow.rows === 1, 'clicking an equipped row unequips it (2 / 4, 1 row)', JSON.stringify(unRow));
  const raidUi = await page.evaluate(() => {
    const ctx = window.__game.ctx; const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    try {
      document.querySelector('.inv-equip .inv-impi-add').click();
      const b = document.querySelector('.inv-equip .inv-implants');
      return { msg: b.querySelector('.inv-impi-msg').textContent, hidden: b.querySelector('.inv-impi-msg').hidden, pop: document.querySelector('.inv-impi-pop').hidden, used: ctx.progression.implantSlotsUsed };
    } finally { ctx.isRaidActive = real; }
  });
  ok(raidUi.msg === '레이드 중에는 교체할 수 없습니다' && !raidUi.hidden && raidUi.pop && raidUi.used === 2, 'in a raid the + 장착 button shows the inline `레이드 중에는 교체할 수 없습니다` line instead of the picker', JSON.stringify(raidUi));
  await tap('Escape');
  await sleep(150);

  console.log('임플란트 items: 로드아웃 프리셋 왕복 (2026-09-08)');
  const presetRt = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.progression;
    const cap = inv.captureLoadout();
    const before = p.getEquippedImplants().map((e) => e.defId);
    for (const e of [...p.getEquippedImplants()]) p.unequipImplant(e.uid);
    const cleared = p.getEquippedImplants().length;
    inv.applyLoadout(cap);
    return { capItems: cap.implantItems, before, cleared, after: p.getEquippedImplants().map((e) => e.defId), used: p.implantSlotsUsed };
  });
  ok(Array.isArray(presetRt.capItems) && presetRt.capItems.join(',') === presetRt.before.join(','),
    'captureLoadout()가 장착한 임플란트 아이템 def id 를 담는다', JSON.stringify(presetRt.capItems));
  ok(presetRt.cleared === 0 && presetRt.after.join(',') === presetRt.before.join(',') && presetRt.used === 2,
    'applyLoadout 이 해제된 임플란트를 프리셋대로 다시 장착한다', JSON.stringify(presetRt));
  const presetClear = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory, p = ctx.progression;
    const empty = { ...inv.captureLoadout(), implantItems: [] };
    inv.applyLoadout(empty);
    const cleared = p.getEquippedImplants().length;
    inv.applyLoadout({ ...inv.captureLoadout(), implantItems: undefined });
    return { cleared, afterUndefined: p.getEquippedImplants().length };
  });
  ok(presetClear.cleared === 0 && presetClear.afterUndefined === 0,
    'implantItems: [] 는 전부 해제, undefined 는 지금 장착을 건드리지 않는다', JSON.stringify(presetClear));
  // 다시 장착해 두고 다음 단계(프로필 왕복)로 넘어간다
  await page.evaluate((uid) => window.__game.ctx.progression.equipImplant(uid), uQH);
  ok(await page.evaluate(() => window.__game.ctx.progression.implantSlotsUsed === 2), '가속 대사 재장착 (2 / 4칸)');

  console.log('임플란트 items: profile round-trip (reload)');
  await page.evaluate(() => window.__game.ctx.progression.save());
  await page.reload({ waitUntil: 'load' });
  await boot();
  const rt = await page.evaluate((uid) => {
    const p = window.__game.ctx.progression;
    return { eq: p.getEquippedImplants().map((e) => e.defId), uid: p.getEquippedImplants()[0]?.uid, used: p.implantSlotsUsed, perk: p.derived.perks.quick_heal, dex: p.getImplantBonus('dexterity'), raw: JSON.parse(localStorage.getItem('scav.profile') ?? 'null')?.implants?.length };
  }, uQH);
  ok(rt.eq.length === 1 && rt.eq[0] === 'imp_perk_quick_heal' && rt.uid === uQH && rt.used === 2 && rt.perk === true && rt.dex === 1 && rt.raw === 1, 'reload: 가속 대사 still equipped (same uid), perk + bonus re-derived, profile.implants saved', JSON.stringify(rt));
  // an unknown def id in the saved array is dropped silently
  await page.evaluate(() => { const raw = JSON.parse(localStorage.getItem('scav.profile')); raw.implants.push({ uid: 'ghost-1', defId: 'imp_removed_99' }, { bogus: true }, { uid: '', defId: 'imp_strength_1' }); localStorage.setItem('scav.profile', JSON.stringify(raw)); });
  await page.reload({ waitUntil: 'load' });
  await boot();
  await sleep(100);
  const pruned = await page.evaluate(() => { const p = window.__game.ctx.progression; return { eq: p.getEquippedImplants().map((e) => e.defId), used: p.implantSlotsUsed }; });
  ok(pruned.eq.length === 1 && pruned.eq[0] === 'imp_perk_quick_heal' && pruned.used === 2, 'unknown / malformed entries in profile.implants are dropped on load', JSON.stringify(pruned));
  // server document round-trip through the fake profile: the array travels with `progression`
  const srvImp = await page.evaluate(() => {
    const net = window.__game.ctx.net;
    const fake = { available: true, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    const desc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
    try {
      const p = window.__game.ctx.progression;
      p.save();
      const uploaded = fake.docs.progression?.implants?.length;
      const doc = JSON.parse(JSON.stringify(fake.docs.progression)); doc.implants = [];
      fake.docs = { progression: doc };
      window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: fake.docs, updatedAt: 0 }, migrated: false });
      const afterEmpty = { n: p.getEquippedImplants().length, perk: p.derived.perks.quick_heal, ev: window.__ev['progress:implantsChanged'].length };
      doc.implants = [{ uid: 'srv-1', defId: 'imp_intelligence_3' }];
      window.__game.ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: fake.docs, updatedAt: 0 }, migrated: false });
      return { uploaded, afterEmpty, eq: p.getEquippedImplants().map((e) => e.defId), int: p.getImplantBonus('intelligence'), ev: window.__ev['progress:implantsChanged'].length };
    } finally { if (desc) Object.defineProperty(net, 'profile', desc); else delete net.profile; }
  });
  ok(srvImp.uploaded === 1, "save → profile.set('progression') carries implants (1)", JSON.stringify(srvImp));
  ok(srvImp.afterEmpty.n === 0 && srvImp.afterEmpty.perk === false && srvImp.eq.length === 1 && srvImp.eq[0] === 'imp_intelligence_3' && srvImp.int === 3 && srvImp.ev === srvImp.afterEmpty.ev + 1, 'net:profileLoaded replaces the equipped set (perks / bonus re-derived, progress:implantsChanged re-emitted)', JSON.stringify(srvImp));

  // Clean up: return / remove every implant item this script created so the next script's 창고 is untouched.
  await page.evaluate(() => {
    const ctx = window.__game.ctx; const p = ctx.progression;
    ctx.setPhase('hub');
    for (const e of p.getEquippedImplants().slice()) p.unequipImplant(e.uid);
    for (const it of [...ctx.inventory.getStashItems(), ...ctx.inventory.getAllItems()]) if (ctx.loot.getItemDef(it.defId)?.category === 'implant') ctx.inventory.takeItem(it.uid);
  });
  ok(await page.evaluate(() => window.__game.ctx.inventory.getStashItems().every((i) => window.__game.ctx.loot.getItemDef(i.defId)?.category !== 'implant')), 'cleanup: no implant items left in the 창고');

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
