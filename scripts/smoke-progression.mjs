// Single-player smoke test for the progression folder's stat XP (2026-09-06): addStatXp raise / clamp at STAT_MAX /
// lower to STAT_MIN / carry-over, addSkillXpRaw down to level 0, profile migration + reload persistence, character sheet DOM.
// Phase 7 (2026-09-06): 감정 XP from `container:itemRevealed` (not `inventory:itemAdded`), training = gun_* only,
// server profile document (save → `profile.set('progression')`, `net:profileLoaded` replace + progress:* re-emit).
// Phase 12 (2026-09-08): 임플란트 items — slots by level (4 / 5 / 10), the 46 defs + repair costs + HEAL_SPRAY_GAUGE, loot rules
// (broken-only, boss legendaries, tier 4 only), equip / unequip / refusals / derived + perks, raid lock, 캐릭터 sheet block +
// picker DOM, reload + server-document round-trip. 119 checks.
// A-3a (2026-09-12): 헬스장 — applyGymSession formula / carry-over / cap / debuff gating (xp 0, no extension) / refusals (raid,
// non-hub, non-gym stat), derived includes 단련 (carryCapacity · maxStamina), sheet `(+n 단련)` + progress line + live countdown,
// reload keeps the three fields, migrate clamps junk, server document round-trip, reset clears.
// Usage: node scripts/smoke-progression.mjs [http://localhost:5273]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket (another agent's save would full-reload the page) AND the relay socket (`/ws?t=`): this is a
  // single-player script — a relay that happens to run on 8787 would otherwise hand the page a server profile and
  // make credits / documents server-owned mid-run. `ctx.net.profile.available` stays false, as documented.
  await quietViteHmr(page, { parkRelay: true });
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
      for (const n of ['progress:statXp', 'progress:statChanged', 'progress:skillUp', 'progress:skillProgress', 'ui:statsToggled', 'progress:loaded', 'progress:xpGained', 'progress:implantsChanged', 'progress:trainedChanged', 'progress:gymFatigue', 'progress:mealChanged']) {
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
    // 2026-09-11 (E-6): the persisted profile write queue (`scav.s1.profileQueue`) holds a copy of the progression document
    // too — match the profile save itself (top-level `stats` + `statProgress`), not any key that merely contains the text.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      try { const v = JSON.parse(localStorage.getItem(k) ?? 'null'); if (v && typeof v === 'object' && v.stats && 'statProgress' in v) return k; } catch { /* not JSON */ }
    }
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
      local: JSON.parse(localStorage.getItem('scav.s1.profile') ?? localStorage.getItem(Object.keys(localStorage).find((k) => (localStorage.getItem(k) ?? '').includes('"statProgress"')) ?? '') ?? 'null')?.level };
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

  /* ── 2026-09-13: ＋/－ pend → 1 s hold confirm, derived preview, tooltips + linked rows, leave warning, reset popup ── */
  console.log('캐릭터 시트 (2026-09-13): 배분 확정 · 툴팁 · 떠나기 경고 · 초기화 팝업');
  const P = (fn, arg) => page.evaluate(fn, arg);
  const clickSel = (sel) => P((s) => { const b = document.querySelector(s); if (b) b.click(); return !!b; }, sel);
  const holdSel = (sel) => P((s) => { const b = document.querySelector(s); b?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })); return !!b; }, sel);
  const levelUp = (n) => P((k) => { const p = window.__game.ctx.progression; for (let i = 0; i < k; i++) p.addXp(Math.max(1, p.xpToNext - p.xp)); return p.statPoints; }, n);
  await P(() => window.__game.ctx.progression.resetProfile());
  await levelUp(3);
  await P(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: true }));
  await sleep(200);
  const S0 = await P(() => {
    const p = window.__game.ctx.progression, root = document.querySelector('.char-sheet');
    return { pts: p.statPoints, str: p.getStat('strength'), dex: p.getStat('dexterity'), end: p.getStat('endurance'), per: p.getStat('perception'), carry: p.derived.carryCapacity,
      desc: root.querySelectorAll('.cs-stat .d').length, hint: root.querySelectorAll('.cs-col > .hint').length,
      titles: [...root.querySelectorAll('.cs-skill')].filter((r) => r.hasAttribute('title')).length,
      confirmDisabled: root.querySelector('.pg-confirm').disabled, revertDisabled: root.querySelector('.pg-revert').disabled, imps: !!root.querySelector('.pg-imps'),
      empty: !root.querySelector('.pg-imps-empty').hidden, slots: root.querySelector('.pg-imps-slots').textContent };
  });
  ok(S0.pts === 3 && S0.desc === 0 && S0.hint === 0 && S0.titles === 0, 'sheet: no stat description text, no hint label under the panels, no native title on skills', JSON.stringify(S0));
  ok(S0.confirmDisabled && S0.revertDisabled && S0.imps && S0.empty && S0.slots === '0 / 4 슬롯', 'nothing pending → 되돌리기 / 포인트 투자 확정 dimmed; implant block empty `0 / 4 슬롯`', JSON.stringify(S0));

  const readPend = () => P(() => {
    const p = window.__game.ctx.progression, root = document.querySelector('.char-sheet');
    const row = (id) => root.querySelector(`.cs-stat[data-stat="${id}"]`);
    const cell = root.querySelector('.cs-derived .cell[data-key="carryCapacity"]');
    return { str: p.getStat('strength'), pts: p.statPoints, carry: p.derived.carryCapacity,
      pa: row('strength').querySelector('.pa').textContent, paHidden: row('strength').querySelector('.pa').hidden,
      minusDisabled: row('strength').querySelector('.minus').disabled, plusDisabled: row('strength').querySelector('.plus').disabled,
      tag: root.querySelector('.cs-level .pts').textContent, preview: cell.classList.contains('pg-preview'),
      cur: cell.querySelector('.pg-cur')?.textContent ?? null, next: cell.querySelector('.pg-next')?.textContent ?? null,
      want: `${p.previewDerived({ strength: 2 }).carryCapacity.toFixed(1)} kg`, now: `${p.derived.carryCapacity.toFixed(1)} kg`,
      previews: root.querySelectorAll('.cs-derived .cell.pg-preview').length,
      confirmDisabled: root.querySelector('.pg-confirm').disabled };
  });
  await clickSel('.char-sheet .cs-stat[data-stat="strength"] .plus');
  await clickSel('.char-sheet .cs-stat[data-stat="strength"] .plus');
  let pd = await readPend();
  ok(pd.str === S0.str && pd.pts === 3 && pd.carry === S0.carry && pd.pa === '+2' && !pd.paHidden && pd.tag === '잔여 포인트 1' && !pd.minusDisabled && !pd.confirmDisabled,
    '＋ ×2 only pends: stat / points / derived unchanged, `+2` shown, 잔여 포인트 1, － and 확정 enabled', JSON.stringify(pd));
  ok(pd.preview && pd.cur === pd.now && pd.next === pd.want && pd.next !== pd.cur && pd.previews === 3,
    'derived preview `현재 → 확정 후` on the 근력 rows only (carry · melee · throw), computed by previewDerived', JSON.stringify(pd));
  await P(() => window.__game.ctx.progression.addSkillXpRaw('carry', 1.5));   // level change → full refreshSheets
  pd = await readPend();
  ok(pd.pa === '+2' && pd.tag === '잔여 포인트 1', 'pending survives a sheet refresh (skill level-up repaint)', JSON.stringify(pd));
  await clickSel('.char-sheet .cs-stat[data-stat="strength"] .minus');
  pd = await readPend();
  ok(pd.pa === '+1' && pd.tag === '잔여 포인트 2' && pd.str === S0.str, '－ takes back one pending point', JSON.stringify(pd));
  await clickSel('.char-sheet .pg-revert');
  pd = await readPend();
  ok(pd.paHidden && pd.previews === 0 && pd.confirmDisabled && pd.tag === '잔여 포인트 3' && pd.minusDisabled, '되돌리기 clears every pending point', JSON.stringify(pd));

  await clickSel('.char-sheet .cs-stat[data-stat="strength"] .plus');
  await clickSel('.char-sheet .cs-stat[data-stat="strength"] .plus');
  await clickSel('.char-sheet .cs-stat[data-stat="dexterity"] .plus');
  await clickSel('.char-sheet .pg-confirm');                                   // a click never confirms
  await holdSel('.char-sheet .pg-confirm');
  await sleep(350);
  const holding = await P(() => document.querySelector('.char-sheet .pg-confirm').classList.contains('is-holding'));
  await P(() => window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true })));   // early release
  await sleep(1100);
  pd = await readPend();
  ok(holding && pd.str === S0.str && pd.pts === 3 && pd.pa === '+2', 'click and an early release do not invest (gauge was running)', JSON.stringify({ holding, pd }));
  const sc0 = await P(() => window.__ev['progress:statChanged'].length);
  await holdSel('.char-sheet .pg-confirm');
  await sleep(1600);
  const done = await P((n0) => {
    const p = window.__game.ctx.progression, root = document.querySelector('.char-sheet');
    return { str: p.getStat('strength'), dex: p.getStat('dexterity'), pts: p.statPoints, ev: window.__ev['progress:statChanged'].slice(n0).map((e) => e.id),
      stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null')?.stats, pending: root.querySelectorAll('.cs-stat.has-pending').length,
      previews: root.querySelectorAll('.cs-derived .cell.pg-preview').length, tagHidden: root.querySelector('.cs-level .pts').hidden };
  }, sc0);
  ok(done.str === S0.str + 2 && done.dex === S0.dex + 1 && done.pts === 0 && done.pending === 0 && done.previews === 0 && done.tagHidden,
    'holding 포인트 투자 확정 1 s invests everything at once (근력 +2, 재주 +1, points 0)', JSON.stringify(done));
  ok(JSON.stringify(done.ev.sort()) === '["dexterity","strength"]' && done.stored?.strength === S0.str + 2 && done.stored?.dexterity === S0.dex + 1,
    'one progress:statChanged per changed stat, saved immediately', JSON.stringify(done));

  const tips = await P(() => {
    const over = (sel) => {
      const n = document.querySelector(sel); const r = n.getBoundingClientRect();
      n.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
      const tip = document.querySelector('.pg-tip[data-variant="overlay"]');
      const out = { shown: !!tip && !tip.hidden, text: tip?.textContent ?? '',
        skills: [...document.querySelectorAll('.char-sheet .cs-skill.pg-linked')].map((e) => e.dataset.skill),
        derived: [...document.querySelectorAll('.char-sheet .cs-derived .cell.pg-linked')].map((e) => e.dataset.key) };
      n.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
      out.hiddenAfter = !tip || tip.hidden;
      out.linkedAfter = document.querySelectorAll('.char-sheet .pg-linked').length;
      return out;
    };
    return { int: over('.char-sheet .cs-stat[data-stat="intelligence"] .n'), gun: over('.char-sheet .cs-skill[data-skill="gun_AR"] .n'), carry: over('.char-sheet .cs-skill[data-skill="carry"] .n') };
  });
  ok(tips.int.shown && /모든 숙련 성장 \+6%\/pt/.test(tips.int.text) && tips.int.text.includes('관련 숙련') && tips.int.skills.includes('medicine') && tips.int.skills.includes('gardening')
    && !tips.int.skills.includes('carry') && JSON.stringify(tips.int.derived) === '["skillGainMul"]', '지능 name tooltip: effect, 관련 숙련, `모든 숙련 성장 +6%/pt`; links its skills + 숙련 상승', JSON.stringify(tips.int));
  ok(tips.int.hiddenAfter && tips.int.linkedAfter === 0, 'pointerout hides the tooltip and clears the outline');
  ok(tips.gun.shown && /반동 −\d+% · 장전 \+\d+%/.test(tips.gun.text) && tips.gun.text.includes('관련 능력치') && tips.gun.derived.length === 0,
    'gun_AR tooltip shows recoil / reload numbers and highlights no derived row', JSON.stringify(tips.gun));
  ok(tips.carry.shown && JSON.stringify(tips.carry.derived) === '["carryReliefFactor"]', '운반 tooltip links 운반 부담 경감', JSON.stringify(tips.carry));

  const api = await P(() => {
    const ctx = window.__game.ctx, p = ctx.progression;
    p.addXp(Math.max(1, p.xpToNext - p.xp));
    const pts = p.statPoints, s = p.getStat('strength');
    const r = { none: p.spendStatPoints({}), frac: p.spendStatPoints({ strength: 0.5 }), neg: p.spendStatPoints({ strength: -1 }), unknown: p.spendStatPoints({ luck: 1 }),
      over: p.spendStatPoints({ strength: pts + 1 }) };
    const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    try { r.raid = p.spendStatPoints({ strength: 1 }); } finally { ctx.isRaidActive = real; }
    r.unchanged = p.statPoints === pts && p.getStat('strength') === s;
    r.pts = pts;
    return r;
  });
  ok(api.pts === 1 && !api.none && !api.frac && !api.neg && !api.unknown && !api.over && !api.raid && api.unchanged, 'spendStatPoints refuses empty / fractional / negative / unknown / over-budget / raid — nothing changes', JSON.stringify(api));

  // leave warning on the overlay: Tab / Escape ask, Escape = 돌아가기, 버리고 이동 closes and keeps the points
  await clickSel('.char-sheet .cs-stat[data-stat="endurance"] .plus');
  await tap('Tab');
  await sleep(150);
  const readLeave = () => P(() => ({ open: !document.querySelector('.char-sheet').hidden, ask: !!document.querySelector('.sh-ask[data-ask="character-leave"]'),
    anyAsk: document.querySelectorAll('.sh-ask').length, pa: document.querySelector('.char-sheet .cs-stat[data-stat="endurance"] .pa').textContent,
    pts: window.__game.ctx.progression.statPoints, end: window.__game.ctx.progression.getStat('endurance'), stats: window.__game.ctx.uiBlockers.has('stats'),
    cancelFocused: document.activeElement?.hasAttribute?.('data-cancel') ?? false }));
  let lv = await readLeave();
  ok(lv.open && lv.ask && lv.cancelFocused, 'overlay: Tab with pending points → 떠나기 경고, sheet stays open, focus on 돌아가기', JSON.stringify(lv));
  await tap('Escape');
  await sleep(300);
  lv = await readLeave();
  ok(lv.open && lv.anyAsk === 0 && lv.pa === '+1', 'Escape = 돌아가기: popup closes, sheet + pending stay', JSON.stringify(lv));
  await tap('Escape');
  await sleep(300);
  lv = await readLeave();
  ok(lv.open && lv.ask, 'Escape on the sheet with pending → the warning again', JSON.stringify(lv));
  await clickSel('.sh-ask[data-ask="character-leave"] .sh-ask-btn.danger');
  await sleep(150);
  lv = await readLeave();
  ok(!lv.open && lv.anyAsk === 0 && lv.pts === 1 && lv.end === S0.end && !lv.stats, '버리고 이동 → sheet closed, pending discarded, the point is still unspent', JSON.stringify(lv));

  // 캐릭터 초기화: warning popup, a click does nothing, a 1 s hold resets
  await P(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: true }));
  await sleep(150);
  await clickSel('.char-sheet .cs-foot .ui-btn.danger');
  await sleep(100);
  const rp0 = await P(() => { const a = document.querySelector('.sh-ask[data-ask="character-reset"]'); return { ask: !!a, danger: a?.classList.contains('is-danger'), hint: a?.querySelector('.sh-ask-hint')?.textContent ?? '', level: window.__game.ctx.progression.level }; });
  ok(rp0.ask && rp0.danger && /1초 동안 누르고/.test(rp0.hint), '캐릭터 초기화 → danger warning popup with the hold hint (no two-click arm)', JSON.stringify(rp0));
  await clickSel('.sh-ask[data-ask="character-reset"] [data-hold]');
  await sleep(100);
  ok(await P(() => !!document.querySelector('.sh-ask[data-ask="character-reset"]') && window.__game.ctx.progression.level > 1), 'a click on 초기화 does not reset');
  await holdSel('.sh-ask[data-ask="character-reset"] [data-hold]');
  await sleep(1600);
  const rp1 = await P(() => ({ ask: document.querySelectorAll('.sh-ask').length, level: window.__game.ctx.progression.level, pts: window.__game.ctx.progression.statPoints, open: !document.querySelector('.char-sheet').hidden }));
  ok(rp1.ask === 0 && rp1.level === 1 && rp1.pts === 0 && rp1.open, 'holding 초기화 1 s resets the character (popup gone, sheet stays)', JSON.stringify(rp1));
  await tap('Tab');
  await sleep(150);
  ok(await P(() => document.querySelector('.char-sheet').hidden), 'Tab closes the sheet at once when nothing is pending');

  // embedded 캐릭터 tab: screen-tab click / Tab / Escape ask; forced close discards silently
  await levelUp(1);
  await P(() => window.__game.ctx.inventory.openScreen('character'));
  await sleep(250);
  const readEmbed = () => P(() => ({ ask: !!document.querySelector('.sh-ask[data-ask="character-leave"]'), anyAsk: document.querySelectorAll('.sh-ask').length,
    tab: window.__game.ctx.inventory.screenTab, open: window.__game.ctx.inventory.isOpen, embed: !!document.querySelector('.cs-embed'),
    pa: document.querySelector('.cs-embed .cs-stat[data-stat="perception"] .pa')?.textContent ?? null, pts: window.__game.ctx.progression.statPoints, per: window.__game.ctx.progression.getStat('perception') }));
  await clickSel('.cs-embed .cs-stat[data-stat="perception"] .plus');
  await P(() => [...document.querySelectorAll('.scr-tab')].find((b) => !b.closest('.char-sheet') && b.textContent.includes('인벤토리'))?.click());
  await sleep(100);
  let em = await readEmbed();
  ok(em.ask && em.tab === 'character' && em.embed && em.pa === '+1', 'embedded: 인벤토리 screen tab with pending → warning, stays on 캐릭터', JSON.stringify(em));
  await clickSel('.sh-ask[data-ask="character-leave"] [data-cancel]');
  await sleep(100);
  em = await readEmbed();
  ok(!em.ask && em.tab === 'character' && em.pa === '+1', '돌아가기 keeps the tab and the pending point', JSON.stringify(em));
  await tap('Tab');
  await sleep(300);
  em = await readEmbed();
  ok(em.ask && em.open, 'embedded: Tab with pending → warning, window stays open', JSON.stringify(em));
  await tap('Tab');
  await sleep(300);
  em = await readEmbed();
  ok(em.anyAsk === 0 && em.open && em.pa === '+1', 'Tab again = 돌아가기', JSON.stringify(em));
  await tap('Escape');
  await sleep(300);
  em = await readEmbed();
  ok(em.ask && em.open, 'embedded: Escape with pending → warning, window stays open', JSON.stringify(em));
  await clickSel('.sh-ask[data-ask="character-leave"] .sh-ask-btn.danger');
  await sleep(300);
  em = await readEmbed();
  ok(!em.open && em.anyAsk === 0 && em.pts === 1 && em.per === S0.per, '버리고 이동 → window closed, the point is still unspent', JSON.stringify(em));
  await P(() => window.__game.ctx.inventory.openScreen('character'));
  await sleep(250);
  await clickSel('.cs-embed .cs-stat[data-stat="perception"] .plus');
  const forced = await P(() => { const ctx = window.__game.ctx; ctx.inventory.closeAll(); return { open: ctx.inventory.isOpen, ask: document.querySelectorAll('.sh-ask').length, pts: ctx.progression.statPoints, per: ctx.progression.getStat('perception') }; });
  ok(!forced.open && forced.ask === 0 && forced.pts === 1 && forced.per === S0.per, 'forced close (closeAll) discards silently — no popup, nothing spent', JSON.stringify(forced));

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
  // 2026-09-13: read-only implant thumbnails under 숙련도 — item card via data-def-id, hover outlines the implant's stat, its skills, its derived rows
  const impThumbs = await page.evaluate(() => {
    const root = document.querySelector('.char-sheet');
    const p = window.__game.ctx.progression;
    const cells = [...root.querySelectorAll('.pg-imps .pg-imp')];
    const out = { n: cells.length, eq: p.getEquippedImplants().length, slots: root.querySelector('.pg-imps-slots').textContent, used: p.implantSlotsUsed, total: p.implantSlots,
      chip: cells[0]?.querySelector('.item-chip')?.dataset.defId ?? null, emptyHidden: root.querySelector('.pg-imps-empty').hidden, buttons: root.querySelectorAll('.pg-imps button').length };
    const c = cells[0];
    if (c) {
      c.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 10, clientY: 10 }));
      out.stats = [...root.querySelectorAll('.cs-stat.pg-linked')].map((e) => e.dataset.stat);
      out.skills = [...root.querySelectorAll('.cs-skill.pg-linked')].map((e) => e.dataset.skill).sort();
      out.derived = [...root.querySelectorAll('.cs-derived .cell.pg-linked')].map((e) => e.dataset.key).sort();
      c.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
      out.after = root.querySelectorAll('.pg-linked').length;
    }
    return out;
  });
  ok(impThumbs.n === 1 && impThumbs.eq === 1 && impThumbs.chip === 'imp_perk_quick_heal' && impThumbs.emptyHidden && impThumbs.buttons === 0
    && impThumbs.slots === `${impThumbs.used} / ${impThumbs.total} 슬롯`, 'sheet: equipped implant as a read-only chip thumbnail + `n / m 슬롯`', JSON.stringify(impThumbs));
  ok(JSON.stringify(impThumbs.stats) === '["dexterity"]' && JSON.stringify(impThumbs.skills) === '["crafting","equipment","gardening"]'
    && JSON.stringify(impThumbs.derived) === '["interactSpeedMul","useSpeedMul"]' && impThumbs.after === 0,
    'hovering 가속 대사 (재주 +1) outlines 재주, its skills and 사용 · 상호작용 속도; pointerout clears', JSON.stringify(impThumbs));
  await tap('Escape');
  await sleep(150);

  console.log('임플란트 items: 인벤토리 장착 장비 칸의 블록 + picker');
  await page.evaluate(() => window.__game.ctx.inventory.toggleBag());
  await sleep(250);
  const blk = await page.evaluate(() => {
    const b = document.querySelector('.inv-equip .inv-implants .inv-impitems');
    // 2026-09-08: 장착한 임플란트는 세로 카드 줄이 아니라 정사각 썸네일 셀(`.inv-impi-cell`)이고, 이름 · 퍽 ·
    //   능력치는 셀의 `data-item-tip` 을 보고 `ui/hud/ItemTip` 이 띄운다 (셀 자체에는 글자가 없다).
    const rows = [...b.querySelectorAll('.inv-impi-cell:not(.inv-impi-add)')];
    return {
      has: !!b, cnt: b.querySelector('.cnt')?.textContent, pips: b.querySelectorAll('.inv-impi-pips i').length, on: b.querySelectorAll('.inv-impi-pips i.on').length,
      rows: rows.map((r) => ({ uid: r.dataset.uid, def: r.dataset.defId, cost: r.querySelector('.cost')?.textContent, tip: r.hasAttribute('data-item-tip'), chip: !!r.querySelector('.item-chip[data-def-id]') })),
      add: !!b.querySelector('.inv-impi-add'),
      popHidden: document.querySelector('.inv-impi-pop')?.hidden,
    };
  });
  ok(blk.has && blk.cnt === '2 / 4칸' && blk.pips === 4 && blk.on === 2 && blk.add, '임플란트 block: `2 / 4칸`, 4 pips (2 lit), + 장착 button', JSON.stringify({ cnt: blk.cnt, pips: blk.pips, on: blk.on }));
  ok(blk.rows.length === 1 && blk.rows[0].def === 'imp_perk_quick_heal' && blk.rows[0].cost === '2' && blk.rows[0].tip && blk.rows[0].chip,
    'equipped cell: 정사각 썸네일 (shared item chip) + 장착칸 2 배지 + data-item-tip', JSON.stringify(blk.rows));
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
    return { used: p.implantSlotsUsed, cnt: b.querySelector('.inv-impitems .cnt').textContent, rows: b.querySelectorAll('.inv-impi-cell:not(.inv-impi-add)').length, opts: document.querySelectorAll('.inv-impi-pop .inv-impi-opt').length, msg: b.querySelector('.inv-impi-msg').textContent };
  });
  ok(picked.used === 4 && picked.cnt === '4 / 4칸' && picked.rows === 2 && picked.opts === 2 && /장착/.test(picked.msg), 'clicking the option equips it: 4 / 4칸, 2 cells, picker re-lists 2, inline `장착` message', JSON.stringify(picked));
  await tap('Escape');
  await sleep(120);
  const escd = await page.evaluate(() => ({ pop: document.querySelector('.inv-impi-pop').hidden, win: document.querySelector('.inv-root').hidden }));
  ok(escd.pop && !escd.win, 'Escape closes the item picker first (the window stays open)', JSON.stringify(escd));
  await page.evaluate((uid) => document.querySelector(`.inv-equip .inv-impi-cell[data-uid="${uid}"]`).click(), uS2);
  await sleep(120);
  const unRow = await page.evaluate(() => { const p = window.__game.ctx.progression; return { used: p.implantSlotsUsed, rows: document.querySelectorAll('.inv-equip .inv-impi-cell:not(.inv-impi-add)').length }; });
  ok(unRow.used === 2 && unRow.rows === 1, 'clicking an equipped thumbnail unequips it (2 / 4, 1 cell)', JSON.stringify(unRow));
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
    return { eq: p.getEquippedImplants().map((e) => e.defId), uid: p.getEquippedImplants()[0]?.uid, used: p.implantSlotsUsed, perk: p.derived.perks.quick_heal, dex: p.getImplantBonus('dexterity'), raw: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null')?.implants?.length };
  }, uQH);
  ok(rt.eq.length === 1 && rt.eq[0] === 'imp_perk_quick_heal' && rt.uid === uQH && rt.used === 2 && rt.perk === true && rt.dex === 1 && rt.raw === 1, 'reload: 가속 대사 still equipped (same uid), perk + bonus re-derived, profile.implants saved', JSON.stringify(rt));
  // an unknown def id in the saved array is dropped silently
  await page.evaluate(() => { const raw = JSON.parse(localStorage.getItem('scav.s1.profile')); raw.implants.push({ uid: 'ghost-1', defId: 'imp_removed_99' }, { bogus: true }, { uid: '', defId: 'imp_strength_1' }); localStorage.setItem('scav.s1.profile', JSON.stringify(raw)); });
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

  /* ══ 헬스장 (A-3a, 2026-09-12): 단련 보너스 · 운동 디버프 ══════════════════════════════════════════════════════
   * data/constants.csv: GYM_SESSION_XP 100 · GYM_TRAIN_XP_BASE 150 · GYM_TRAIN_XP_EXPONENT 1.4 · GYM_TRAINED_MAX 5 ·
   * GYM_FATIGUE_HOURS 24 · GYM_FATIGUE_GAIN_MUL 0. The debuff clock is `ctx.net.serverNow()` — stubbed to a fake epoch here. */
  console.log('헬스장 (A-3a): 단련 보너스 · 운동 디버프');
  const GYM = { xp: 100, base: 150, exp: 1.4, max: 5, hours: 24 };
  const needAt = (n) => Math.max(1, Math.round(GYM.base * Math.pow(n + 1, GYM.exp)));
  const H = 3600e3;
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.setPhase('hub'); ctx.progression.resetProfile(); });
  const g0 = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), next: p.trainedXpToNext('strength'), fat: p.getGymFatigueUntil('strength'),
      per: p.getTrainedBonus('perception'), maps: [p.profile.trained, p.profile.trainedProgress, p.profile.gymFatigueUntil].map((m) => JSON.stringify(m)),
      base: p.getStat('strength'), carry: p.derived.carryCapacity, stam: p.derived.maxStamina, endBase: p.getStat('endurance') };
  });
  ok(g0.tb === 0 && g0.tp === 0 && g0.fat === 0 && g0.per === 0 && g0.maps.every((m) => m === '{}'), 'fresh profile: 단련 0, 진행도 0, 디버프 없음, three empty maps', JSON.stringify(g0));
  ok(g0.next === needAt(0) && g0.next === 150, 'trainedXpToNext at +0 = round(150 × 1^1.4) = 150', `${g0.next}`);

  const refused = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.progression;
    const t0 = window.__ev['progress:trainedChanged'].length, f0 = window.__ev['progress:gymFatigue'].length;
    const r = { per: p.applyGymSession('perception', 1), junk: p.applyGymSession('nope', 1) };
    const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    try { r.raid = p.applyGymSession('strength', 1); } finally { ctx.isRaidActive = real; }
    ctx.setPhase('menu');
    try { r.menu = p.applyGymSession('strength', 1); } finally { ctx.setPhase('hub'); }
    r.after = { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), fat: p.getGymFatigueUntil('strength'),
      tev: window.__ev['progress:trainedChanged'].length - t0, fev: window.__ev['progress:gymFatigue'].length - f0 };
    return r;
  });
  ok(refused.per === null && refused.junk === null, 'applyGymSession refuses a non-gym stat (perception / unknown) with null', JSON.stringify(refused));
  ok(refused.raid === null && refused.menu === null && refused.after.tb === 0 && refused.after.tp === 0 && refused.after.fat === 0 && refused.after.tev === 0 && refused.after.fev === 0,
    'applyGymSession refused while isRaidActive() and outside the hub phase — nothing changed, no events', JSON.stringify(refused));

  // fake relay clock: T is far in the past so every stubbed debuff has expired once the real clock comes back
  await page.evaluate(() => {
    const net = window.__game.ctx.net;
    window.__realServerNow = Object.getOwnPropertyDescriptor(net, 'serverNow') ?? null;
    window.__T = Date.now() - 400 * 3600e3;
    window.__fakeNow = window.__T;
    net.serverNow = () => window.__fakeNow;
  });
  const gym = (id, score, h) => page.evaluate((a) => {
    const p = window.__game.ctx.progression;
    if (a.h !== null) window.__fakeNow = window.__T + a.h * 3600e3;
    const r = p.applyGymSession(a.id, a.score === 'NaN' ? NaN : a.score);
    const tev = window.__ev['progress:trainedChanged'], fev = window.__ev['progress:gymFatigue'];
    return { r, T: window.__T, tb: p.getTrainedBonus(a.id), tp: p.getTrainedProgress(a.id), fat: p.getGymFatigueUntil(a.id),
      eff: p.getStatWithImplants(a.id), base: p.getStat(a.id), carry: p.derived.carryCapacity, stam: p.derived.maxStamina,
      tLast: tev[tev.length - 1], tn: tev.length, fLast: fev[fev.length - 1], fn: fev.length, sc: window.__ev['progress:statChanged'].length,
      stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null') };
  }, { id, score: Number.isNaN(score) ? 'NaN' : score, h });

  // ① score 0.5 → 50 XP, no step, debuff set
  const s1 = await gym('strength', 0.5, 0);
  const T = s1.T;
  ok(s1.r && s1.r.stat === 'strength' && s1.r.score === 0.5 && s1.r.xp === 50 && s1.r.wasFatigued === false && s1.r.trainedBefore === 0 && s1.r.trainedAfter === 0
    && near(s1.r.progress, 50 / 150, 1e-6) && s1.r.capped === false && s1.r.fatigueUntil === T + GYM.hours * H,
  'session 0.5 → GymSessionResult {xp 50, 0 → 0, progress 50/150, fatigueUntil now + 24 h}', JSON.stringify(s1.r));
  ok(s1.tb === 0 && near(s1.tp, 1 / 3, 1e-6) && s1.fat === T + 24 * H, 'getTrainedProgress 1/3, getGymFatigueUntil = now + 24 h', JSON.stringify({ tb: s1.tb, tp: s1.tp, fat: s1.fat }));
  ok(s1.tLast && s1.tLast.id === 'strength' && s1.tLast.value === 0 && near(s1.tLast.progress, 1 / 3, 1e-6) && s1.tLast.delta === 50
    && s1.fLast && s1.fLast.id === 'strength' && s1.fLast.until === T + 24 * H, 'progress:trainedChanged {strength, 0, 1/3, delta 50} + progress:gymFatigue {until}', JSON.stringify({ t: s1.tLast, f: s1.fLast }));
  ok(s1.stored && near(s1.stored.trainedProgress?.strength, 1 / 3, 1e-6) && s1.stored.gymFatigueUntil?.strength === T + 24 * H, 'saved immediately (localStorage carries trainedProgress + gymFatigueUntil)', JSON.stringify(s1.stored?.gymFatigueUntil));

  // ② while fatigued: xp 0, the debuff is not extended, no new gymFatigue event
  const s2 = await gym('strength', 1, 1);
  ok(s2.r && s2.r.wasFatigued === true && s2.r.xp === 0 && s2.r.trainedAfter === 0 && near(s2.r.progress, 1 / 3, 1e-6) && s2.r.fatigueUntil === T + 24 * H,
    'fatigued session (+1 h, score 1) → xp 0, progress unchanged, fatigueUntil not extended', JSON.stringify(s2.r));
  ok(s2.fn === s1.fn && s2.tn === s1.tn + 1 && s2.tLast.delta === 0 && s2.fat === T + 24 * H, 'no progress:gymFatigue while fatigued; progress:trainedChanged still fires with delta 0', JSON.stringify({ fn: [s1.fn, s2.fn], tn: [s1.tn, s2.tn], d: s2.tLast }));
  const expired = await page.evaluate((t) => { window.__fakeNow = t; return window.__game.ctx.progression.getGymFatigueUntil('strength'); }, T + 24 * H);
  ok(expired === 0, 'getGymFatigueUntil is 0 once the clock reaches the stamp', `${expired}`);

  // ③ after expiry: 50 + 100 = 150 = need(0) → 단련 +1, leftover 0, derived follows
  const s3 = await gym('strength', 1, 25);
  ok(s3.r && s3.r.xp === 100 && s3.r.wasFatigued === false && s3.r.trainedBefore === 0 && s3.r.trainedAfter === 1 && s3.r.progress === 0 && s3.r.fatigueUntil === T + 49 * H,
    'session after expiry (+25 h) → 0 → +1 with 0 left, new debuff until +49 h', JSON.stringify(s3.r));
  ok(s3.base === g0.base && s3.eff === g0.base + 1 && near(s3.carry, g0.carry + 2.2, 1e-6), 'getStat stays the base, getStatWithImplants = base + 1, carryCapacity +2.2', JSON.stringify({ base: s3.base, eff: s3.eff, carry: s3.carry, before: g0.carry }));
  ok(s3.sc === s2.sc + 1 && s3.tLast.value === 1 && s3.tLast.delta === 100, 'bonus change → progress:statChanged + trainedChanged {value 1, delta 100}', JSON.stringify({ sc: [s2.sc, s3.sc], t: s3.tLast }));
  ok((await page.evaluate(() => window.__game.ctx.progression.trainedXpToNext('strength'))) === needAt(1), `trainedXpToNext at +1 = ${needAt(1)}`);

  // ④ endurance is independent of the strength debuff; its bonus feeds maxStamina
  const e1 = await gym('endurance', 1, 26);
  ok(e1.r && e1.r.wasFatigued === false && e1.r.xp === 100 && e1.r.trainedAfter === 0 && near(e1.tp, 100 / 150, 1e-6) && e1.fat === T + 50 * H,
    'endurance session during the strength debuff: not fatigued, +100 XP, its own debuff', JSON.stringify(e1.r));
  const e2 = await gym('endurance', 1, 51);
  ok(e2.r && e2.r.trainedAfter === 1 && near(e2.r.progress, 50 / needAt(1), 1e-6) && near(e2.stam, g0.stam + 5, 1e-6),
    `endurance +1 with 50/${needAt(1)} carried over, maxStamina +5`, JSON.stringify({ r: e2.r, stam: e2.stam, before: g0.stam }));

  // ⑤ carry-over into the next step: 단련 +1 at 0.9 → 0.9 × need(1) + 100 − need(1) left of need(2)
  const s4 = await page.evaluate(() => { window.__game.ctx.progression.profile.trainedProgress.strength = 0.9; return true; }).then(() => gym('strength', 1, 50));
  const left4 = 0.9 * needAt(1) + 100 - needAt(1);
  ok(s4.r && s4.r.trainedBefore === 1 && s4.r.trainedAfter === 2 && near(s4.r.progress, left4 / needAt(2), 1e-6) && near(s4.carry, g0.carry + 2.2 * 2, 1e-6),
    `carry-over: +1 @ 90 % + 100 → +2 with ${left4.toFixed(1)}/${needAt(2)}`, JSON.stringify({ r: s4.r, carry: s4.carry }));

  // ⑥ cap: +4 @ 99 % + 100 → +5, progress pinned at 1; a later session adds 0 and stays capped (but still sets the debuff)
  const s5 = await page.evaluate(() => { const p = window.__game.ctx.progression.profile; p.trained.strength = 4; p.trainedProgress.strength = 0.99; return true; }).then(() => gym('strength', 1, 80));
  ok(s5.r && s5.r.trainedAfter === GYM.max && s5.r.capped === true && s5.r.progress === 1 && s5.tp === 1 && s5.eff === g0.base + 5 && near(s5.carry, g0.carry + 2.2 * 5, 1e-6),
    'cap: +4 @ 99 % + 100 → GYM_TRAINED_MAX 5, progress 1, capped, carry +11', JSON.stringify({ r: s5.r, tp: s5.tp, eff: s5.eff, carry: s5.carry }));
  const s6 = await gym('strength', 5, 140);
  ok(s6.r && s6.r.score === 1 && s6.r.xp === 0 && s6.r.trainedAfter === 5 && s6.r.progress === 1 && s6.r.capped && s6.r.wasFatigued === false && s6.r.fatigueUntil === T + 164 * H,
    'score 5 clamps to 1; at the cap xp 0 and progress stays 1, the debuff is still set', JSON.stringify(s6.r));
  const e3 = await gym('endurance', NaN, 200);
  ok(e3.r && e3.r.score === 0 && e3.r.xp === 0 && e3.r.wasFatigued === false && e3.r.fatigueUntil === T + 224 * H && e3.fn === s6.fn + 1 && near(e3.r.progress, 50 / needAt(1), 1e-6),
    'score NaN → 0: xp 0, progress unchanged, a finished session still sets the debuff (+ progress:gymFatigue)', JSON.stringify(e3.r));

  // back to the real clock: one endurance session that leaves a live 24 h debuff for the sheet + reload checks
  await page.evaluate(() => { const net = window.__game.ctx.net; if (window.__realServerNow) Object.defineProperty(net, 'serverNow', window.__realServerNow); else delete net.serverNow; });
  const nowBefore = Date.now();
  const e4 = await gym('endurance', 1, null);
  ok(e4.r && e4.r.xp === 100 && e4.r.trainedAfter === 1 && near(e4.r.progress, 150 / needAt(1), 1e-6) && e4.r.fatigueUntil >= nowBefore + 24 * H - 5000 && e4.r.fatigueUntil <= Date.now() + 24 * H + 5000,
    'real clock: endurance debuff runs until ≈ now + 24 h', JSON.stringify({ r: e4.r, nowBefore }));
  const liveUntil = e4.r?.fatigueUntil ?? 0;

  console.log('헬스장: 캐릭터 시트');
  await page.evaluate(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: true }));
  await sleep(250);
  const readGymSheet = () => page.evaluate(() => {
    const root = document.querySelector('.char-sheet');
    const rows = [...root.querySelectorAll('.cs-stat')];
    const r = (i) => ({ v: rows[i].querySelector('.v').textContent, ib: rows[i].querySelector('.v .ib').textContent, tb: rows[i].querySelector('.v .tb')?.textContent, tbHidden: rows[i].querySelector('.v .tb')?.hidden,
      gtr: rows[i].querySelector('.gy .gtr')?.textContent ?? null, fat: rows[i].querySelector('.gy .fat')?.textContent ?? null, fatHidden: rows[i].querySelector('.gy .fat')?.hidden ?? null });
    return { open: !root.hidden, str: r(0), end: r(1), per: r(2), gyCount: root.querySelectorAll('.cs-stat .gy').length };
  });
  const gs = await readGymSheet();
  ok(gs.open && gs.str.tb === ' (+5 단련)' && !gs.str.tbHidden && gs.str.ib === '' && gs.str.v === `${g0.base} (+5 단련)`, '근력 row: `5 (+5 단련)` in its own span (implant span empty)', JSON.stringify(gs.str));
  ok(gs.end.tb === ' (+1 단련)' && gs.per.tb === '' && gs.per.tbHidden === true && gs.gyCount === 2, '지구력 `(+1 단련)`; 인지력 has no 단련 span text; only 근력 · 지구력 carry the 단련 line', JSON.stringify({ end: gs.end, per: gs.per, gy: gs.gyCount }));
  ok(gs.str.gtr === '단련 최대' && gs.end.gtr === `단련 +1 · ${Math.floor((150 / needAt(1)) * 100)} %`, `progress lines: 근력 \`단련 최대\`, 지구력 \`단련 +1 · ${Math.floor((150 / needAt(1)) * 100)} %\``, JSON.stringify({ s: gs.str.gtr, e: gs.end.gtr }));
  ok(gs.str.fatHidden === true && gs.end.fatHidden === false && /^심폐 피로 · 남은 2[34]:[0-5]\d:[0-5]\d$/.test(gs.end.fat), 'debuff line only on 지구력: `심폐 피로 · 남은 HH:MM:SS` (근력 debuff expired → hidden)', JSON.stringify({ s: gs.str.fat, e: gs.end.fat }));
  await sleep(2100);
  const gs2 = await readGymSheet();
  ok(gs2.end.fat !== gs.end.fat && /^심폐 피로 · 남은 2[34]:[0-5]\d:[0-5]\d$/.test(gs2.end.fat), 'countdown repaints while the sheet is visible', JSON.stringify({ a: gs.end.fat, b: gs2.end.fat }));
  await page.evaluate(() => window.__game.ctx.bus.emit('ui:statsToggled', { open: false }));
  await sleep(150);

  console.log('헬스장: 새로고침 · migrate · 서버 문서 · 초기화');
  await page.reload({ waitUntil: 'load' });
  await boot();
  const rl = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { str: p.getTrainedBonus('strength'), strP: p.getTrainedProgress('strength'), end: p.getTrainedBonus('endurance'), endP: p.getTrainedProgress('endurance'),
      endFat: p.getGymFatigueUntil('endurance'), strFat: p.getGymFatigueUntil('strength'), carry: p.derived.carryCapacity, stam: p.derived.maxStamina };
  });
  ok(rl.str === 5 && rl.strP === 1 && rl.end === 1 && near(rl.endP, 150 / needAt(1), 1e-6) && rl.endFat === liveUntil && rl.strFat === 0,
    'reload keeps 단련 (5 / 1), 진행도 and the live endurance debuff stamp', JSON.stringify({ rl, liveUntil }));
  ok(near(rl.carry, g0.carry + 2.2 * 5, 1e-6) && near(rl.stam, g0.stam + 5, 1e-6), 'derived after reload includes 단련 (carry +11, stamina +5)', JSON.stringify(rl));

  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('scav.s1.profile'));
    raw.trained = { strength: 99.7, endurance: 2.6, perception: 4, bogus: 2 };
    raw.trainedProgress = { strength: 0.4, endurance: 7, perception: 0.5 };
    raw.gymFatigueUntil = { strength: 1000, endurance: 'x', perception: 1e12, dexterity: -5 };
    localStorage.setItem('scav.s1.profile', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'load' });
  await boot();
  const mj = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { trained: p.profile.trained, prog: p.profile.trainedProgress, fat: p.profile.gymFatigueUntil, per: p.getTrainedBonus('perception'),
      strFat: p.getGymFatigueUntil('strength'), endFat: p.getGymFatigueUntil('endurance'), endP: p.getTrainedProgress('endurance') };
  });
  ok(JSON.stringify(mj.trained) === JSON.stringify({ strength: 5, endurance: 3 }) && mj.per === 0, 'migrate: trained clamped + rounded (99.7 → 5, 2.6 → 3), non-gym keys dropped', JSON.stringify(mj));
  ok(mj.prog.strength === 1 && mj.prog.endurance === 0.999999 && Object.keys(mj.prog).length === 2 && mj.endP === 0.999999, 'migrate: progress 1 only at the cap, else clamped to 0.999999; junk keys dropped', JSON.stringify(mj.prog));
  ok(JSON.stringify(mj.fat) === JSON.stringify({ strength: 1000 }) && mj.strFat === 0 && mj.endFat === 0, 'migrate: fatigue keeps only finite > 0 gym stamps; an old stamp reads as no debuff', JSON.stringify(mj.fat));

  const srvGym = await page.evaluate(() => {
    const ctx = window.__game.ctx, net = ctx.net, p = ctx.progression;
    const fake = { available: true, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    const desc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
    try {
      p.save();
      const up = fake.docs.progression && { trained: fake.docs.progression.trained, prog: fake.docs.progression.trainedProgress, fat: fake.docs.progression.gymFatigueUntil };
      const doc = JSON.parse(JSON.stringify(fake.docs.progression));
      const until = Date.now() + 3600e3;
      doc.trained = { strength: 2 }; doc.trainedProgress = { strength: 0.25 }; doc.gymFatigueUntil = { strength: until };
      fake.docs = { progression: doc };
      const t0 = window.__ev['progress:trainedChanged'].length, f0 = window.__ev['progress:gymFatigue'].length;
      ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: fake.docs, updatedAt: 0 }, migrated: false });
      return { up, until, tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), end: p.getTrainedBonus('endurance'), fat: p.getGymFatigueUntil('strength'),
        eff: p.getStatWithImplants('strength'), base: p.getStat('strength'), carry: p.derived.carryCapacity,
        tev: window.__ev['progress:trainedChanged'].length - t0, fev: window.__ev['progress:gymFatigue'].slice(f0) };
    } finally { if (desc) Object.defineProperty(net, 'profile', desc); else delete net.profile; }
  });
  ok(srvGym.up && srvGym.up.trained?.strength === 5 && srvGym.up.prog?.strength === 1 && srvGym.up.fat?.strength === 1000, "save → profile.set('progression') carries trained / trainedProgress / gymFatigueUntil", JSON.stringify(srvGym.up));
  ok(srvGym.tb === 2 && near(srvGym.tp, 0.25) && srvGym.end === 0 && srvGym.fat === srvGym.until && srvGym.eff === srvGym.base + 2 && near(srvGym.carry, 28 + 2.2 * (srvGym.base + 2), 1e-6),
    'net:profileLoaded → server 단련 + debuff replace the local ones, derived re-computed', JSON.stringify(srvGym));
  ok(srvGym.tev === 2 && srvGym.fev.length === 1 && srvGym.fev[0].id === 'strength' && srvGym.fev[0].until === srvGym.until, 'server document re-emits trainedChanged ×2 + gymFatigue for the active debuff', JSON.stringify({ tev: srvGym.tev, fev: srvGym.fev }));

  const rs = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    const t0 = window.__ev['progress:trainedChanged'].length;
    p.resetProfile();
    const tev = window.__ev['progress:trainedChanged'].slice(t0);
    return { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), fat: p.getGymFatigueUntil('strength'),
      maps: [p.profile.trained, p.profile.trainedProgress, p.profile.gymFatigueUntil].map((m) => JSON.stringify(m)), tev,
      stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null')?.gymFatigueUntil };
  });
  ok(rs.tb === 0 && rs.tp === 0 && rs.fat === 0 && rs.maps.every((m) => m === '{}') && JSON.stringify(rs.stored) === '{}', 'resetProfile clears 단련 · 진행도 · 디버프 (memory + storage)', JSON.stringify(rs));
  ok(rs.tev.length === 2 && rs.tev.every((e) => e.value === 0 && e.delta === 0), 'resetProfile re-emits trainedChanged {value 0} for both gym stats', JSON.stringify(rs.tev));

  console.log('헬스장: 콘솔 API addTrainedXp · clearGymFatigue');
  const tx = (id, xp) => page.evaluate((a) => {
    const p = window.__game.ctx.progression;
    const t0 = window.__ev['progress:trainedChanged'].length, s0 = window.__ev['progress:statChanged'].length;
    p.addTrainedXp(a.id, a.xp === 'NaN' ? NaN : a.xp);
    const tev = window.__ev['progress:trainedChanged'];
    return { tb: p.getTrainedBonus(a.id), tp: p.getTrainedProgress(a.id), carry: p.derived.carryCapacity, stam: p.derived.maxStamina,
      tn: tev.length - t0, tLast: tev[tev.length - 1], sn: window.__ev['progress:statChanged'].length - s0,
      stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null') };
  }, { id, xp: Number.isNaN(xp) ? 'NaN' : xp });
  // multi-level carry-over in one call: need(0) + need(1) + need(2) + 50 → +3 with 50 / need(3)
  const multi = needAt(0) + needAt(1) + needAt(2) + 50;
  const a1 = await tx('endurance', multi);
  ok(a1.tb === 3 && near(a1.tp, 50 / needAt(3), 1e-6) && near(a1.stam, g0.stam + 15, 1e-6), `addTrainedXp(endurance, ${multi}) → +3 with 50/${needAt(3)} carried across three steps, maxStamina +15`, JSON.stringify(a1));
  ok(a1.tn === 1 && a1.tLast.value === 3 && a1.tLast.delta === multi && a1.sn === 1 && a1.stored?.trained?.endurance === 3, 'one trainedChanged {value 3, delta xp} + statChanged, saved immediately', JSON.stringify({ t: a1.tLast, sn: a1.sn, stored: a1.stored?.trained }));
  const a2 = await tx('endurance', -100);
  ok(a2.tb === 2 && near(a2.tp, (needAt(2) - 50) / needAt(2), 1e-6) && a2.tLast.delta === -100, `negative: +3 @ 50 − 100 → +2 with ${needAt(2) - 50}/${needAt(2)} (deficit off the lower step)`, JSON.stringify(a2));
  const a3 = await tx('endurance', -1e6);
  ok(a3.tb === 0 && a3.tp === 0 && near(a3.stam, g0.stam, 1e-6) && JSON.stringify(a3.stored?.trained) === '{}', 'addTrainedXp(endurance, −1e6) → floor 0 · 0, stamina back to base, storage emptied', JSON.stringify(a3));
  const a4 = await tx('strength', 1e6);
  ok(a4.tb === GYM.max && a4.tp === 1 && near(a4.carry, g0.carry + 2.2 * 5, 1e-6), 'addTrainedXp(strength, 1e6) → cap 5, progress 1, carry +11', JSON.stringify(a4));
  const a5 = await tx('strength', -100);
  ok(a5.tb === 4 && near(a5.tp, (needAt(4) - 100) / needAt(4), 1e-6), `negative from the cap: 5 − 100 → +4 with ${needAt(4) - 100}/${needAt(4)}`, JSON.stringify(a5));
  const a6 = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.progression;
    const t0 = window.__ev['progress:trainedChanged'].length;
    const before = { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength') };
    p.addTrainedXp('perception', 500); p.addTrainedXp('strength', NaN); p.addTrainedXp('nope', 500);
    const ignored = { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), per: p.getTrainedBonus('perception'), tn: window.__ev['progress:trainedChanged'].length - t0 };
    // no gates: a live debuff, a raid and a non-hub phase do not stop it
    p.profile.gymFatigueUntil.strength = Date.now() + 3600e3;
    const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    const phase = ctx.phase; ctx.setPhase('menu');
    try { p.addTrainedXp('strength', 100); } finally { ctx.isRaidActive = real; ctx.setPhase(phase); }
    return { before, ignored, after: { tb: p.getTrainedBonus('strength'), tp: p.getTrainedProgress('strength'), fat: p.getGymFatigueUntil('strength') } };
  });
  ok(a6.ignored.tb === a6.before.tb && a6.ignored.tp === a6.before.tp && a6.ignored.per === 0 && a6.ignored.tn === 0, 'non-gym stat / unknown id / NaN ignored (no change, no event)', JSON.stringify(a6));
  ok(a6.after.tb === 5 && a6.after.tp === 1 && a6.after.fat > 0, 'addTrainedXp ignores the debuff, the raid gate and the phase (+100 → cap), debuff untouched', JSON.stringify(a6.after));
  const cf = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    p.profile.gymFatigueUntil.endurance = Date.now() + 7200e3;
    const f0 = window.__ev['progress:gymFatigue'].length;
    p.clearGymFatigue('strength');
    const one = { str: p.getGymFatigueUntil('strength'), end: p.getGymFatigueUntil('endurance'), fev: window.__ev['progress:gymFatigue'].slice(f0),
      stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null')?.gymFatigueUntil };
    const f1 = window.__ev['progress:gymFatigue'].length;
    p.clearGymFatigue();
    const both = { str: p.getGymFatigueUntil('strength'), end: p.getGymFatigueUntil('endurance'), fev: window.__ev['progress:gymFatigue'].slice(f1),
      map: JSON.stringify(p.profile.gymFatigueUntil), stored: JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null')?.gymFatigueUntil };
    const f2 = window.__ev['progress:gymFatigue'].length;
    p.clearGymFatigue();
    return { one, both, again: window.__ev['progress:gymFatigue'].length - f2 };
  });
  ok(cf.one.str === 0 && cf.one.end > 0 && cf.one.fev.length === 1 && cf.one.fev[0].id === 'strength' && cf.one.fev[0].until === 0 && !('strength' in (cf.one.stored ?? {})) && 'endurance' in (cf.one.stored ?? {}),
    "clearGymFatigue('strength') clears only strength, emits gymFatigue {strength, until 0}, saved", JSON.stringify(cf.one));
  ok(cf.both.str === 0 && cf.both.end === 0 && cf.both.map === '{}' && JSON.stringify(cf.both.stored) === '{}' && cf.both.fev.length === 1 && cf.both.fev[0].id === 'endurance' && cf.again === 0,
    'clearGymFatigue() clears the rest (one event per cleared stat, none when nothing is left)', JSON.stringify({ both: cf.both, again: cf.again }));

  /* ── 요리 품질 (2026-09-13, docs/plans/cooking-minigames.md §6-3) ─────────────────────────────────────── */
  console.log('요리 품질 (2026-09-13): 보너스 수치 · 교체 규칙 · 출격/종료 · 새로고침 · migrate · 서버 문서');
  const QB = [];
  for (const m of readFileSync(new URL('../data/tables.csv', import.meta.url), 'utf8').matchAll(/^MEAL_QUALITY_BONUS,(\d+),([\d.]+)/gm)) QB[Number(m[1])] = Number(m[2]);
  ok(QB.length === 6 && QB[0] === 0 && QB[5] > QB[1] && QB[1] > 0, 'tables.csv MEAL_QUALITY_BONUS read (quality 0 … 5)', JSON.stringify(QB));
  await page.evaluate(() => { const ctx = window.__game.ctx; ctx.setPhase('hub'); ctx.progression.resetProfile(); });
  const MEAL_FX = `(id) => { const m = window.__game.ctx.loot.getItemDef(id)?.meal; return m ? (Array.isArray(m.effects) && m.effects.length ? m.effects : [{ buff: m.buff, amount: m.amount }]).map((e) => ({ buff: e.buff, amount: e.amount })) : null; }`;
  await page.evaluate((src) => { window.__mealFx = eval(src); window.__pickFx = (d, fx) => Object.fromEntries(fx.map((e) => [e.buff, d[e.buff]])); }, MEAL_FX);

  const qm = await page.evaluate(() => {
    const p = window.__game.ctx.progression, sys = window.__game.getSystem('progression');
    const fx = window.__mealFx('meal_sausage'), lard = window.__mealFx('meal_lard_rice');
    const base = window.__pickFx(p.derived, fx), baseDur = p.derived.durabilityLossMul;
    const byQ = [];
    for (let q = 0; q <= 5; q++) {
      sys._profile.mealActive = 'meal_sausage'; sys._profile.mealActiveQuality = q;
      sys.recompute();
      byQ.push({ q, aq: p.getActiveMealQuality(), got: window.__pickFx(p.derived, fx), preview: window.__pickFx(p.previewDerived({}), fx) });
    }
    sys._profile.mealActive = 'meal_lard_rice'; sys._profile.mealActiveQuality = 5; sys.recompute();
    const lardDur = p.derived.durabilityLossMul;
    sys._profile.mealActive = null; sys._profile.mealActiveQuality = 0; sys.recompute();
    return { fx, lard, base, baseDur, byQ, lardDur, after: window.__pickFx(p.derived, fx), aqNone: p.getActiveMealQuality() };
  });
  ok(Array.isArray(qm.fx) && qm.fx.length === 2, 'meal_sausage has two stat lines', JSON.stringify(qm.fx));
  for (const r of qm.byQ) {
    ok(r.aq === r.q && qm.fx.every((e) => Math.abs(r.got[e.buff] - (qm.base[e.buff] + e.amount * (1 + QB[r.q]))) < 1e-9),
      `quality ${r.q}: every line × (1 + ${QB[r.q]}) folded into derived`, JSON.stringify({ r, base: qm.base }));
    ok(qm.fx.every((e) => Math.abs(r.preview[e.buff] - r.got[e.buff]) < 1e-9), `quality ${r.q}: character-sheet preview uses the same quality`, JSON.stringify(r));
  }
  const lardLine = (qm.lard ?? []).find((e) => e.buff === 'durabilityLossMul');
  ok(lardLine && lardLine.amount < 0 && Math.abs(qm.lardDur - Math.max(0, qm.baseDur + lardLine.amount * (1 + QB[5]))) < 1e-9,
    'negative line (durabilityLossMul) scales by the bonus too, floor 0 kept', JSON.stringify({ lardLine, baseDur: qm.baseDur, lardDur: qm.lardDur }));
  ok(qm.fx.every((e) => Math.abs(qm.after[e.buff] - qm.base[e.buff]) < 1e-9) && qm.aqNone === 0, 'no active meal → base values, active quality 0');

  const qu = await page.evaluate(() => {
    const ctx = window.__game.ctx, p = ctx.progression;
    const evs = window.__ev['progress:mealChanged'];
    const r = {};
    r.first = p.useMeal('meal_sausage', 3); r.firstQ = [p.getMeal(), p.getMealQuality()];
    r.firstEv = evs[evs.length - 1];
    r.sameQ = p.useMeal('meal_sausage', 3);
    r.upQ = p.useMeal('meal_sausage', 5); r.upQv = p.getMealQuality();
    r.omit = p.useMeal('meal_sausage'); r.omitQ = p.getMealQuality();
    r.zeroAgain = p.useMeal('meal_sausage', 0);
    r.frac = p.useMeal('meal_sausage', 4.7); r.fracQ = p.getMealQuality();
    r.clamp = p.useMeal('meal_sausage', 99); r.clampQ = p.getMealQuality();
    r.clampSame = p.useMeal('meal_sausage', 5);
    r.nan = p.useMeal('meal_sausage', NaN); r.nanQ = p.getMealQuality();
    r.other = p.useMeal('meal_dumpling', 0); r.otherQ = [p.getMeal(), p.getMealQuality()];
    const real = ctx.isRaidActive; ctx.isRaidActive = () => true;
    try { r.raid = p.useMeal('meal_dumpling', 4); } finally { ctx.isRaidActive = real; }
    r.afterRaid = [p.getMeal(), p.getMealQuality()];
    const s0 = evs.length;
    p.serveMeal('meal_dumpling', 0); r.serveSameEv = evs.length - s0;
    p.serveMeal('meal_dumpling', 4); r.serveUp = [p.getMeal(), p.getMealQuality(), evs.length - s0];
    r.lastEv = evs[evs.length - 1];
    r.stored = JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null');
    r.activeQ = p.getActiveMealQuality();
    return r;
  });
  ok(qu.first === null && qu.firstQ[0] === 'meal_sausage' && qu.firstQ[1] === 3, 'useMeal(sausage, 3) → loaded with quality 3', JSON.stringify(qu.firstQ));
  ok(qu.firstEv && qu.firstEv.meal === 'meal_sausage' && qu.firstEv.mealQuality === 3 && qu.firstEv.activeQuality === 0, 'progress:mealChanged carries mealQuality · activeQuality', JSON.stringify(qu.firstEv));
  ok(qu.sameQ === '이미 같은 요리를 먹었습니다', 'same meal + same quality → refused', String(qu.sameQ));
  ok(qu.upQ === null && qu.upQv === 5 && qu.omit === null && qu.omitQ === 0 && qu.zeroAgain === '이미 같은 요리를 먹었습니다',
    'same meal, different quality → replaced (3 → 5 → omitted 0); omitted = quality 0 for the same-check', JSON.stringify(qu));
  ok(qu.frac === null && qu.fracQ === 4 && qu.clamp === null && qu.clampQ === 5 && qu.clampSame === '이미 같은 요리를 먹었습니다' && qu.nan === null && qu.nanQ === 0,
    'quality normalised: 4.7 → 4, 99 → 5 (then 5 is the same), NaN → 0', JSON.stringify(qu));
  ok(qu.other === null && qu.otherQ[0] === 'meal_dumpling' && qu.otherQ[1] === 0 && qu.raid === '레이드 중에는 먹을 수 없습니다' && qu.afterRaid[1] === 0,
    'a different meal replaces; raid refusal leaves the quality untouched', JSON.stringify(qu));
  ok(qu.serveSameEv === 0 && qu.serveUp[0] === 'meal_dumpling' && qu.serveUp[1] === 4 && qu.serveUp[2] === 1, 'serveMeal: same meal + quality = no-op, different quality = replace (one event)', JSON.stringify(qu));
  ok(qu.stored?.meal === 'meal_dumpling' && qu.stored?.mealQuality === 4 && qu.activeQ === 0 && qu.lastEv?.mealQuality === 4, 'saved immediately with mealQuality 4, nothing active yet', JSON.stringify({ s: qu.stored && { meal: qu.stored.meal, q: qu.stored.mealQuality }, ev: qu.lastEv }));

  const qa = await page.evaluate(() => {
    const p = window.__game.ctx.progression, evs = window.__ev['progress:mealChanged'];
    const fx = window.__mealFx('meal_dumpling');
    const base = window.__pickFx(p.derived, fx);
    p.armPreps();
    const stored = JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null');
    return { fx, base, meal: p.getMeal(), q: p.getMealQuality(), active: p.getActiveMeal(), aq: p.getActiveMealQuality(), got: window.__pickFx(p.derived, fx),
      ev: evs[evs.length - 1], stored: stored && { meal: stored.meal, mq: stored.mealQuality, active: stored.mealActive, aq: stored.mealActiveQuality } };
  });
  ok(qa.meal === null && qa.q === 0 && qa.active === 'meal_dumpling' && qa.aq === 4, 'armPreps moves the quality with the meal (pending → active)', JSON.stringify(qa));
  ok(qa.fx.every((e) => Math.abs(qa.got[e.buff] - (qa.base[e.buff] + e.amount * (1 + QB[4]))) < 1e-9), 'armed meal buff × (1 + bonus[4]) in derived', JSON.stringify(qa));
  ok(qa.ev && qa.ev.active === 'meal_dumpling' && qa.ev.activeQuality === 4 && qa.ev.mealQuality === 0 && qa.stored?.aq === 4 && qa.stored?.mq === 0 && qa.stored?.meal === null,
    'mealChanged + storage after arming', JSON.stringify({ ev: qa.ev, stored: qa.stored }));

  await page.reload({ waitUntil: 'load' });
  await boot();
  const qr = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { active: p.getActiveMeal(), aq: p.getActiveMealQuality(), regen: p.derived.staminaRegenMul, heal: p.derived.healPowerMul };
  });
  ok(qr.active === 'meal_dumpling' && qr.aq === 4, 'reload keeps the active meal and its quality', JSON.stringify(qr));
  ok(Math.abs(qr.regen - (qa.base.staminaRegenMul + qa.fx.find((e) => e.buff === 'staminaRegenMul').amount * (1 + QB[4]))) < 1e-9
    && Math.abs(qr.heal - (qa.base.healPowerMul + qa.fx.find((e) => e.buff === 'healPowerMul').amount * (1 + QB[4]))) < 1e-9,
    'derived after reload includes the quality bonus', JSON.stringify({ qr, base: qa.base }));
  const qc = await page.evaluate(() => {
    const p = window.__game.ctx.progression, evs = window.__ev['progress:mealChanged'];
    p.clearActivePreps();
    const stored = JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null');
    return { active: p.getActiveMeal(), aq: p.getActiveMealQuality(), regen: p.derived.staminaRegenMul, heal: p.derived.healPowerMul, ev: evs[evs.length - 1], storedAq: stored?.mealActiveQuality, storedActive: stored?.mealActive };
  });
  ok(qc.active === null && qc.aq === 0 && Math.abs(qc.regen - qa.base.staminaRegenMul) < 1e-9 && Math.abs(qc.heal - qa.base.healPowerMul) < 1e-9
    && qc.ev?.activeQuality === 0 && qc.storedAq === 0 && qc.storedActive === null, 'clearActivePreps clears the active meal quality (derived back to base, saved)', JSON.stringify(qc));

  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('scav.s1.profile'));
    raw.meal = null; raw.mealQuality = 3;
    raw.mealActive = 'meal_dumpling'; raw.mealActiveQuality = 9.6;
    localStorage.setItem('scav.s1.profile', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'load' });
  await boot();
  const qg = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    return { mq: p.profile.mealQuality, aq: p.profile.mealActiveQuality, getQ: p.getMealQuality(), getAq: p.getActiveMealQuality() };
  });
  ok(qg.mq === 0 && qg.getQ === 0 && qg.aq === 5 && qg.getAq === 5, 'migrate: a quality without its meal id → 0, 9.6 → clamped 5', JSON.stringify(qg));

  const qs = await page.evaluate(() => {
    const ctx = window.__game.ctx, net = ctx.net, p = ctx.progression;
    const fake = { available: true, credits: 0, docs: {}, sets: [], get(k) { return this.docs[k]; }, set(k, doc) { this.sets.push(k); this.docs[k] = JSON.parse(JSON.stringify(doc)); }, flush() {}, addCredits: async () => ({ ok: true, credits: 0 }) };
    const desc = Object.getOwnPropertyDescriptor(net, 'profile') ?? null;
    Object.defineProperty(net, 'profile', { value: fake, configurable: true, writable: true });
    try {
      p.save();
      const up = fake.docs.progression && { active: fake.docs.progression.mealActive, aq: fake.docs.progression.mealActiveQuality };
      const doc = JSON.parse(JSON.stringify(fake.docs.progression));
      doc.meal = 'meal_sausage'; doc.mealQuality = 2; doc.mealActive = null; doc.mealActiveQuality = 0;
      fake.docs = { progression: doc };
      const e0 = window.__ev['progress:mealChanged'].length;
      ctx.bus.emit('net:profileLoaded', { profile: { credits: 0, docs: fake.docs, updatedAt: 0 }, migrated: false });
      return { up, meal: p.getMeal(), q: p.getMealQuality(), active: p.getActiveMeal(), aq: p.getActiveMealQuality(), evs: window.__ev['progress:mealChanged'].slice(e0) };
    } finally { if (desc) Object.defineProperty(net, 'profile', desc); else delete net.profile; }
  });
  ok(qs.up && qs.up.active === 'meal_dumpling' && qs.up.aq === 5, "save → profile.set('progression') carries mealActiveQuality", JSON.stringify(qs.up));
  ok(qs.meal === 'meal_sausage' && qs.q === 2 && qs.active === null && qs.aq === 0, 'net:profileLoaded → the server meal quality replaces the local one', JSON.stringify(qs));
  ok(qs.evs.length === 1 && qs.evs[0].mealQuality === 2 && qs.evs[0].activeQuality === 0, 'server document re-emits mealChanged with the qualities', JSON.stringify(qs.evs));
  const qz = await page.evaluate(() => { const p = window.__game.ctx.progression; p.resetProfile(); return { q: p.getMealQuality(), mq: p.profile.mealQuality, aq: p.profile.mealActiveQuality }; });
  ok(qz.q === 0 && qz.mq === 0 && qz.aq === 0, 'resetProfile clears both qualities', JSON.stringify(qz));

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
