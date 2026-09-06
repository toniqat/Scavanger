// Phase 5 HUD / menu smoke (src/ui): title `Lv. n` chip, contract panel under the objective, meta toasts (credits chip,
// reputation level, contract settlement, quest / purchase / sale lines) and the result-screen XP settlement block
// (count-up, level-up highlight + audio, XP bar, contract line). Enters a solo mission, then feeds synthetic bus events
// from `page.evaluate` and asserts the DOM — `ctx.meta` may still be the skeleton.
// Usage: node scripts/smoke-ui-p5.mjs [http://localhost:5273]   (needs `npm run dev`)
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
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); `pointerLockElement` is faked below.
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket: another editor's save would otherwise full-reload the page mid-run (see smoke-console.mjs).
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.progression, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['audio:play']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const emit = (name, payload) => P(([n, p]) => window.__game.ctx.bus.emit(n, p), [name, payload]);
  const texts = (sel) => P((s) => [...document.querySelectorAll(s)].map((e) => e.textContent), sel);
  const hud = (expr) => P((e) => { const h = window.__game.getSystem('hud'); return h[e]; }, expr);

  console.log('title level chip');
  const lvReal = await P(() => window.__game.ctx.progression.level);
  let chip = await P(() => { const e = document.querySelector('.menu.title .lv-chip'); return e ? { text: e.textContent, hidden: e.hidden, phase: window.__game.ctx.phase, inRow: !!e.closest('.field .row') } : null; });
  ok(chip && chip.phase === 'menu' && !chip.hidden && chip.inRow, 'title menu shows the .lv-chip beside the callsign field', JSON.stringify(chip));
  ok(chip && chip.text === `Lv. ${lvReal}`, `chip reads Lv. ${lvReal} (ctx.progression.level)`, chip && chip.text);
  await emit('progress:levelUp', { level: 7, statPoints: 1 });
  chip = await P(() => document.querySelector('.menu.title .lv-chip').textContent);
  ok(chip === 'Lv. 7', 'progress:levelUp {level:7} → Lv. 7', chip);
  await P(() => window.__game.ctx.bus.emit('progress:loaded', { profile: window.__game.ctx.progression.profile }));
  chip = await P(() => document.querySelector('.menu.title .lv-chip').textContent);
  ok(chip === `Lv. ${lvReal}`, 'progress:loaded → chip back to the real level', chip);
  // The synthetic level-up toast above must not leak into the mission (ProgressToasts clears on game:newMission).

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  const layers = await P(() => ({
    panel: !!document.querySelector('.hud.gameplay .contract-panel'),
    afterObjective: (() => { const o = document.querySelector('.hud.gameplay .objective'); const c = document.querySelector('.hud.gameplay .contract-panel'); return !!o && !!c && !!(o.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING); })(),
    toasts: !!document.querySelector('.hud.social .progress-toasts'),
  }));
  ok(layers.panel && layers.afterObjective, 'contract panel lives in the gameplay layer after the objective', JSON.stringify(layers));
  ok(layers.toasts, 'meta toasts share the .progress-toasts column in the social layer');
  const activeAtStart = await P(() => !!(window.__game.ctx.meta && window.__game.ctx.meta.activeContract));
  const shown0 = await hud('isContractPanelOn');
  ok(shown0 === activeAtStart, `panel at world:ready follows ctx.meta.activeContract (${activeAtStart ? 'active' : 'none / skeleton'})`, String(shown0));

  console.log('contract panel');
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 3, target: 25, delta: 1 });
  let cp = await P(() => { const e = document.querySelector('.contract-panel'); return { cls: e.className, name: e.querySelector('.name').textContent, goal: e.querySelector('.goal').textContent, num: e.querySelector('.num').textContent, fill: e.querySelector('.fill').style.transform, on: window.__game.getSystem('hud').isContractPanelOn, pulse: window.__game.getSystem('hud').isContractPulsing, vis: getComputedStyle(e).visibility }; });
  ok(/\bshow\b/.test(cp.cls) && cp.on, 'meta:contractProgress alone brings the panel up (.show)', cp.cls);
  ok(cp.name === '소탕 작전 I' && cp.goal === '터미니드 처치', 'name from CONTRACT_DEFS, goal from CONTRACT_GOAL_LABEL_KO', `${cp.name} / ${cp.goal}`);
  ok(cp.num === '3 / 25' && /scaleX\(0\.12/.test(cp.fill), 'progress 3 / 25, bar 12 %', `${cp.num} ${cp.fill}`);
  ok(/\bpulse\b/.test(cp.cls) && cp.pulse && !/\bdone\b/.test(cp.cls), 'progress pulse on, no 달성 badge yet', cp.cls);
  await waitSim(1.0);
  cp = await P(() => ({ cls: document.querySelector('.contract-panel').className, pulse: window.__game.getSystem('hud').isContractPulsing, op: getComputedStyle(document.querySelector('.contract-panel')).opacity }));
  ok(!/\bpulse\b/.test(cp.cls) && !cp.pulse, 'pulse drops after 0.9 s of sim time', cp.cls);
  ok(cp.op === '1', 'panel fully faded in (opacity 1)', cp.op);
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 25.25, target: 25, delta: 0.25 });
  cp = await P(() => { const e = document.querySelector('.contract-panel'); return { cls: e.className, num: e.querySelector('.num').textContent, badge: getComputedStyle(e.querySelector('.badge')).opacity, fill: e.querySelector('.fill').style.transform }; });
  ok(/\bdone\b/.test(cp.cls) && cp.num === '25 / 25' && /scaleX\(1/.test(cp.fill), 'progress ≥ target → .done, floored 25 / 25, full bar', `${cp.cls} ${cp.num} ${cp.fill}`);
  await sleep(350);
  cp = await P(() => ({ badge: getComputedStyle(document.querySelector('.contract-panel .badge')).opacity, text: document.querySelector('.contract-panel .badge').textContent }));
  ok(Number(cp.badge) > 0.9 && cp.text === '달성', '달성 badge visible', JSON.stringify(cp));
  await emit('meta:contractSettled', { id: 'helix_1', corp: 'helix', name: '소탕 작전 I', success: true, progress: 25, target: 25, rep: 60, xp: 150, credits: 120 });
  cp = await P(() => ({ cls: document.querySelector('.contract-panel').className, on: window.__game.getSystem('hud').isContractPanelOn }));
  ok(!/\bshow\b/.test(cp.cls) && !cp.on, 'meta:contractSettled hides the panel', cp.cls);
  await emit('meta:contractProgress', { id: 'ceres_2', corp: 'ceres', goal: 'loot_corpses', progress: 1, target: 15, delta: 1 });
  cp = await P(() => ({ on: window.__game.getSystem('hud').isContractPanelOn, name: document.querySelector('.contract-panel .name').textContent, goal: document.querySelector('.contract-panel .goal').textContent }));
  ok(cp.on && cp.name === '검체 채취 II' && cp.goal === '시체 수색', 'a new contract re-opens the panel with its own name / goal', JSON.stringify(cp));
  await emit('meta:contractAbandoned', { id: 'ceres_2', corp: 'ceres' });
  ok((await hud('isContractPanelOn')) === false, 'meta:contractAbandoned hides the panel');

  console.log('meta toasts');
  const settledToast = await texts('.ptoast.contract');
  ok(settledToast.length === 1 && settledToast[0].includes('계약 성공') && settledToast[0].includes('소탕 작전 I') && settledToast[0].includes('신뢰도 +60') && settledToast[0].includes('크레딧 +120'), 'meta:contractSettled success → big 계약 성공 toast with rep / credits', JSON.stringify(settledToast));
  await emit('meta:creditsChanged', { credits: 620, delta: 120, reason: 'contract' });
  await emit('meta:creditsChanged', { credits: 650, delta: 30, reason: 'sale' });
  let chips = await texts('.ptoast.credits');
  ok(chips.length === 0, 'credit changes are coalesced (no chip yet)', JSON.stringify(chips));
  await waitSim(1.15);
  chips = await texts('.ptoast.credits');
  ok(chips.length === 1 && chips[0] === '+150 크레딧', 'one +150 크레딧 chip after 1 s', JSON.stringify(chips));
  await emit('meta:creditsChanged', { credits: 650, delta: 0, reason: 'noop' });
  await waitSim(1.15);
  chips = await texts('.ptoast.credits');
  ok(chips.length === 1, 'delta 0 raises no chip', JSON.stringify(chips));
  await emit('meta:creditsChanged', { credits: 610, delta: -40, reason: 'buy' });
  await waitSim(1.15);
  let minus = await P(() => [...document.querySelectorAll('.ptoast.credits.minus')].map((e) => e.textContent));
  ok(minus.length === 1 && minus[0] === '−40 크레딧', 'negative delta → −40 크레딧 (.minus)', JSON.stringify(minus));
  await emit('meta:repChanged', { corp: 'helix', rep: 100, level: 1, delta: 100, levelUp: true });
  let rep = await texts('.ptoast.rep');
  ok(rep.length === 1 && rep[0].includes('헬릭스 방산 신뢰도 Lv.1'), 'meta:repChanged levelUp → 헬릭스 방산 신뢰도 Lv.1', JSON.stringify(rep));
  await emit('meta:repChanged', { corp: 'helix', rep: 130, level: 1, delta: 30, levelUp: false });
  rep = await texts('.ptoast.rep');
  ok(rep.length === 1, 'rep gain without a level-up raises no toast', JSON.stringify(rep));
  await emit('meta:questChanged', { id: 'h1', corp: 'helix', state: 'complete' });
  await emit('meta:questChanged', { id: 'h2', corp: 'helix', state: 'accepted' });
  let notifs = await texts('.notif');
  ok(notifs.some((t) => t.includes('퀘스트') && t.includes('퀘스트 완료 · 고철 납품')) && !notifs.some((t) => t.includes('합금 납품')), 'meta:questChanged complete → 퀘스트 완료 · 고철 납품 (accepted stays silent)', JSON.stringify(notifs));
  await emit('meta:contractAccepted', { id: 'bastion_1', corp: 'bastion' });
  await emit('meta:purchase', { corp: 'helix', defId: 'ammo_light', price: 40, placed: 'stash' });
  await emit('meta:sale', { defId: 'gem_amber', qty: 2, credits: 130 });
  notifs = await texts('.notif');
  const ammoName = await P(() => { const d = window.__game.ctx.loot.getItemDef('ammo_light'); return d ? d.name : 'ammo_light'; });
  const gemName = await P(() => { const d = window.__game.ctx.loot.getItemDef('gem_amber'); return d ? d.name : 'gem_amber'; });
  ok(notifs.some((t) => t.includes('계약 수락 · 용병 제거 I')), 'meta:contractAccepted → 계약 수락 line', JSON.stringify(notifs));
  ok(notifs.some((t) => t.includes(`구매: ${ammoName}`) && t.includes('−40 크레딧') && t.includes('(창고)')), 'meta:purchase → 구매 line with price and 창고', JSON.stringify(notifs));
  ok(notifs.some((t) => t.includes(`판매: ${gemName}`) && t.includes('×2') && t.includes('+130 크레딧')), 'meta:sale → 판매 line with qty and credits', JSON.stringify(notifs));
  await P(() => { window.__game.ctx.stats.extracted = true; });
  await emit('meta:contractSettled', { id: 'nomad_1', corp: 'nomad', name: '회수 임무 I', success: false, progress: 900, target: 1500, rep: 0, xp: 0, credits: 0 });
  const keep = await texts('.ptoast.contract.keep');
  ok(keep.length === 1 && keep[0].includes('계약 미완') && keep[0].includes('900 / 1,500') && keep[0].includes('계속'), 'unfinished settlement while extracted=true (ctx.stats) → 계약 미완 · 계속', JSON.stringify(keep));
  await P(() => { window.__game.ctx.stats.extracted = false; });
  await emit('meta:contractSettled', { id: 'nomad_1', corp: 'nomad', name: '회수 임무 I', success: false, progress: 900, target: 1500, rep: 0, xp: 0, credits: 0 });
  const failT = await texts('.ptoast.contract.fail');
  ok(failT.length === 1 && failT[0].includes('계약 실패') && failT[0].includes('진척 유지 안 됨'), 'unfinished settlement while dead → 계약 실패 · 진척 유지 안 됨', JSON.stringify(failT));
  await P(() => { window.__game.ctx.stats.extracted = false; });
  const live = await hud('metaToastCount');
  ok(live <= 4, `meta toast stack capped at 4 (${live})`);

  console.log('mission complete rewards');
  const base = await P(() => JSON.parse(JSON.stringify(window.__game.ctx.stats)));
  await P(() => { window.__ev['audio:play'].length = 0; });
  await emit('game:complete', { stats: { ...base, extracted: true, lootValue: 900, rewards: { xpEarned: 340, levelBefore: 2, levelAfter: 3, xp: 40, xpToNext: 300, contract: { id: 'helix_1', corp: 'helix', name: '소탕 작전 I', success: true, progress: 25, target: 25, rep: 60, xp: 150, credits: 120 } } } });
  let rw = await P(() => { const m = document.querySelector('.menu.complete'); const r = m.querySelector('.rewards'); return { menu: m.className, hidden: r.hidden, lv: r.querySelector('.lv').textContent, gain: r.querySelector('.xp-gain').textContent, num: r.querySelector('.xp-num').textContent, up: r.classList.contains('up'), badge: r.querySelector('.up-badge').hidden, contract: r.querySelector('.contract-line').textContent, ccls: r.querySelector('.contract-line').className, counting: window.__game.getSystem('hud').completeRewards.isCounting, order: (() => { const s = m.querySelector('.stats'); const a = m.querySelector('.actions'); return !!(s.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(r.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING); })() }; });
  ok(!/\bhidden\b/.test(rw.menu) && !rw.hidden && rw.order, 'game:complete with rewards → .rewards block between stats and actions', `${rw.menu} hidden=${rw.hidden} order=${rw.order}`);
  ok(rw.lv === 'Lv. 2 → 3' && !rw.up && rw.badge && rw.counting, 'Lv. 2 → 3, no highlight before the count-up ends', JSON.stringify(rw));
  ok(rw.num === '40 / 300 XP', 'XP bar numbers 40 / 300 XP', rw.num);
  ok(rw.contract === '계약 · 소탕 작전 I 성공 · 신뢰도 +60 · 크레딧 +120' && /\bsuccess\b/.test(rw.ccls), 'contract success line', `${rw.contract} ${rw.ccls}`);
  await waitSim(0.9);
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { gain: r.querySelector('.xp-gain').textContent, fill: r.querySelector('.xp-bar .fill').style.transform, counting: window.__game.getSystem('hud').completeRewards.isCounting }; });
  const mid = Number(rw.gain.replace(/[^\d]/g, ''));
  ok(mid > 0 && mid < 340 && rw.counting, `count-up in flight (${rw.gain}) with the bar moving`, JSON.stringify(rw));
  await waitSim(1.0);
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { gain: r.querySelector('.xp-gain').textContent, fill: r.querySelector('.xp-bar .fill').style.transform, up: r.classList.contains('up'), badge: r.querySelector('.up-badge').hidden, counting: window.__game.getSystem('hud').completeRewards.isCounting, audio: window.__ev['audio:play'].filter((a) => a.id === 'level_up').length }; });
  ok(rw.gain === '+340' && !rw.counting, 'count-up ends at +340', rw.gain);
  ok(rw.up && !rw.badge, 'level-up highlight (.up + 레벨 업 badge) after the count', JSON.stringify(rw));
  ok(/scaleX\(0\.13/.test(rw.fill), 'bar settles at 40 / 300 (13 %)', rw.fill);
  ok(rw.audio === 1, 'audio:play level_up emitted once by the block', String(rw.audio));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  ok(await P(() => document.querySelector('.menu.complete').classList.contains('hidden')), 'complete screen hides when the phase moves on');

  console.log('death screen rewards');
  await emit('game:over', { stats: { ...base, extracted: false, rewards: { xpEarned: 80, levelBefore: 3, levelAfter: 3, xp: 120, xpToNext: 300, contract: { id: 'helix_2', corp: 'helix', name: '소탕 작전 II', success: false, progress: 12, target: 60, rep: 0, xp: 0, credits: 0 } } } });
  rw = await P(() => { const m = document.querySelector('.menu.death'); const r = m.querySelector('.rewards'); return { menu: m.className, hidden: r.hidden, lv: r.querySelector('.lv').textContent, num: r.querySelector('.xp-num').textContent, fill: r.querySelector('.xp-bar .fill').style.transform, contract: r.querySelector('.contract-line').textContent, ccls: r.querySelector('.contract-line').className, counting: window.__game.getSystem('hud').deathRewards.isCounting }; });
  ok(!/\bhidden\b/.test(rw.menu) && !rw.hidden && rw.counting, 'game:over with rewards → death screen .rewards block', `${rw.menu} hidden=${rw.hidden}`);
  ok(rw.lv === 'Lv. 3' && rw.num === '120 / 300 XP', 'no level-up → Lv. 3, 120 / 300 XP', `${rw.lv} ${rw.num}`);
  ok(/scaleX\(0\.13/.test(rw.fill), 'bar starts at the pre-mission fraction (40 / 300)', rw.fill);
  ok(rw.contract === '계약 · 소탕 작전 II 12 / 60 · 진척 유지 안 됨' && /\blost\b/.test(rw.ccls), 'death contract line: p / t · 진척 유지 안 됨', `${rw.contract} ${rw.ccls}`);
  await waitSim(1.8);
  rw = await P(() => { const r = document.querySelector('.menu.death .rewards'); return { gain: r.querySelector('.xp-gain').textContent, up: r.classList.contains('up'), fill: r.querySelector('.xp-bar .fill').style.transform, counting: window.__game.getSystem('hud').deathRewards.isCounting, audio: window.__ev['audio:play'].filter((a) => a.id === 'level_up').length }; });
  ok(rw.gain === '+80' && !rw.counting && !rw.up && /scaleX\(0\.4/.test(rw.fill) && rw.audio === 1, 'death count-up ends at +80, bar 40 %, no level-up audio', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });

  console.log('rewards hidden without data');
  await emit('game:complete', { stats: { ...base, extracted: true, rewards: { xpEarned: 10, levelBefore: 1, levelAfter: 1, xp: 10, xpToNext: 120, contract: null } } });
  rw = await P(() => { const r = document.querySelector('.menu.complete .rewards'); return { hidden: r.hidden, chidden: r.querySelector('.contract-line').hidden, lv: r.querySelector('.lv').textContent }; });
  ok(!rw.hidden && rw.chidden && rw.lv === 'Lv. 1', 'contract null → block shown, contract line hidden', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  await emit('game:complete', { stats: { ...base, extracted: true } });
  rw = await P(() => { const m = document.querySelector('.menu.complete'); return { menu: m.className, hidden: m.querySelector('.rewards').hidden, counting: window.__game.getSystem('hud').completeRewards.isCounting }; });
  ok(!/\bhidden\b/.test(rw.menu) && rw.hidden && !rw.counting, 'rewards undefined → block hidden (legacy emitter)', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'complete' });
  await emit('game:over', { stats: { ...base, extracted: false } });
  rw = await P(() => ({ hidden: document.querySelector('.menu.death .rewards').hidden }));
  ok(rw.hidden, 'death screen hides the block without rewards too', JSON.stringify(rw));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'dead' });

  console.log('mission reset');
  await emit('meta:contractProgress', { id: 'helix_1', corp: 'helix', goal: 'kill_bugs', progress: 5, target: 25, delta: 1 });
  await emit('meta:creditsChanged', { credits: 700, delta: 90, reason: 'x' });
  await emit('game:abort', {});
  await waitSim(1.2);
  const reset = await P(() => { const h = window.__game.getSystem('hud'); return { panel: h.isContractPanelOn, toasts: h.metaToastCount, chips: document.querySelectorAll('.ptoast.credits').length, phase: window.__game.ctx.phase }; });
  ok(!reset.panel && reset.toasts === 0 && reset.chips === 0, 'game:abort hides the panel and drops pending / live meta toasts', JSON.stringify(reset));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
