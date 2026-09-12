// Character-buff HUD smoke (src/ui, 2026-09-12 — docs/plans/char-buffs.md §6-D). No relay: the relay socket is parked.
//   ship   the PC vitals block (name · shield · hp) is in the **social** layer and visible in the hub, hp full, the
//          raid-only stamina bar stays in the (hidden) gameplay layer, the chat / squad column sits above the vitals;
//          the three retired badges (meal / env / gym fatigue) are gone from the DOM and from HudSystem.
//   local  `ctx.player.buffs` (when player/ implements it) is what the strip under the hp bar draws; a synthetic list via
//          `hud.debugLocalBuffs(list)` checks order, pending dim, debuff red frame, glyph / colour sources, `charBuffTitle`,
//          the time gauge ratio + `18h` / `42m` / `35s` labels, the 1 s tick, DOM reuse by key, same array = no DOM change,
//          and the `.hud-bl` lift while the strip has thumbnails.
//   squad  `hud.debugRemotes([ref with buffs], lobby)` → a mini strip under that member's hp bar (not on the local row),
//          refreshed after `net:remoteBuffsChanged`, untouched for the same array.
//   raid   vitals / strip / column still in place in a solo mission, and the drone-view shrink reaches the vitals through
//          the sibling selector.
// Usage: node scripts/smoke-buffs.mjs [http://localhost:5273]   (needs vite; the runner starts it)
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
// Real GPU through ANGLE D3D11 by default. SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
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
    '--window-size=1280,720', '--no-sandbox'],
});
const pageErrors = [];
const consoleErrors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); `pointerLockElement` is faked below.
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.getSystem('hud'), 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const P = (fn, arg) => page.evaluate(fn, arg);

  /* ── ship ─────────────────────────────────────────────────────────────── */
  console.log('ship: PC vitals in the social layer');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitFor(page, () => { const s = document.querySelector('.hud.social'); return !!s && !s.classList.contains('hidden'); }, 'social layer up', 20000);
  await sleep(700);   // vitals damping + the column's `bottom` transition
  const layout = () => P(() => {
    const v = document.querySelector('.vitals');
    const soc = document.querySelector('.hud.social'), gp = document.querySelector('.hud.gameplay');
    const bl = document.querySelector('.hud-bl');
    const vr = v.getBoundingClientRect(), br = bl.getBoundingClientRect();
    return {
      phase: window.__game.ctx.phase,
      inSocial: soc.contains(v), socialHidden: soc.classList.contains('hidden'), gameplayHidden: gp.classList.contains('hidden'),
      vis: getComputedStyle(v).visibility, op: Number(getComputedStyle(v).opacity), h: Math.round(vr.height), left: Math.round(vr.left),
      name: v.querySelector('.vt-name').textContent,
      hpFills: [...v.querySelectorAll('.hp-bar .seg .fill')].map((f) => f.style.transform),
      stamInGameplay: gp.contains(document.querySelector('.stamina')), stamInSocial: soc.contains(document.querySelector('.stamina')),
      blAbove: br.bottom <= vr.top + 4, blBottom: getComputedStyle(bl).bottom,
    };
  });
  const ship = await layout();
  ok(ship.inSocial && !ship.socialHidden && ship.vis === 'visible' && ship.op > 0.9 && ship.h > 20, 'PC vitals block is in the social layer and visible in the ship', JSON.stringify(ship));
  ok(ship.gameplayHidden && ship.stamInGameplay && !ship.stamInSocial, 'stamina bar stays in the gameplay layer (hidden in the ship = raid-only)', JSON.stringify(ship));
  // Browsers normalise inline transforms on readback ("scaleX(1.000)" → "scaleX(1)"): compare the number.
  const scaleOf = (t) => Number.parseFloat(String(t).replace(/^scaleX\(/, ''));
  ok(ship.hpFills.length === 5 && ship.hpFills.every((t) => near(scaleOf(t), 1, 1e-3)), 'hp bar full in the ship (5 cells)', JSON.stringify(ship.hpFills));
  ok(ship.name.length > 0, `name line in the ship (${ship.name})`);
  ok(ship.blAbove && ship.blBottom === '122px', 'chat / squad column sits above the vitals in the ship (no more hub drop to 32 px)', JSON.stringify(ship));

  const gone = await P(() => {
    const h = window.__game.getSystem('hud');
    return {
      dom: document.querySelectorAll('.meal-badge, .env-badge, .gfat, .gfat-chip, .hud-badges').length,
      getters: ['envBadgeKind', 'isEnvProtected', 'mealBadgeDefId', 'gymFatigueChips', 'isGymFatigueOn'].filter((k) => k in h),
      hooks: typeof h.debugLocalBuffs === 'function' && typeof h.squadBuffs === 'function' && Array.isArray(h.localBuffs),
    };
  });
  ok(gone.dom === 0 && gone.getters.length === 0, 'retired badges (식사 · 환경 · 운동 디버프) are gone — DOM and HudSystem getters', JSON.stringify(gone));
  ok(gone.hooks, 'HudSystem.localBuffs / squadBuffs / debugLocalBuffs hooks exist', JSON.stringify(gone));

  /* ── local strip ──────────────────────────────────────────────────────── */
  console.log('local strip under the PC hp bar');
  const real = await P(() => {
    const p = window.__game.ctx.player;
    return { has: Array.isArray(p.buffs), keys: (p.buffs ?? []).map((b) => b.key), rev: p.buffsRevision ?? null, strip: window.__game.getSystem('hud').localBuffs.map((c) => c.key) };
  });
  if (real.has) ok(JSON.stringify(real.keys) === JSON.stringify(real.strip), `strip draws ctx.player.buffs (rev ${real.rev}, ${real.keys.length} buffs)`, JSON.stringify(real));
  else console.log('  note ctx.player.buffs is not implemented yet — the strip is driven through hud.debugLocalBuffs only');

  await P(() => {
    const now = Date.now(), H = 3600e3, M = 60e3;
    window.__L1 = [
      { kind: 'env_exposed', key: 'env', debuff: true, state: 'active', env: 'toxin' },
      { kind: 'gym_fatigue', key: 'fatigue:endurance', debuff: true, state: 'active', stat: 'endurance', startedAt: now + 42.5 * M - 24 * H, endsAt: now + 42.5 * M },
      { kind: 'gym_fatigue', key: 'fatigue:strength', debuff: true, state: 'active', stat: 'strength', startedAt: now - 5.5 * H, endsAt: now + 18.5 * H },
      { kind: 'rest', key: 'pose', debuff: false, state: 'active', pose: 'sit' },
      { kind: 'meal', key: 'meal', debuff: false, state: 'pending', defId: 'meal_tuber_stew' },
      { kind: 'prep', key: 'prep:toxin', debuff: false, state: 'pending', defId: 'prep_respirator', env: 'toxin' },
    ];
    window.__game.getSystem('hud').debugLocalBuffs(window.__L1);
  });
  await waitFor(page, () => window.__game.getSystem('hud').localBuffs.length === 6, 'local strip with 6 thumbnails', 10000);
  const loc = await P(() => {
    const hud = window.__game.getSystem('hud');
    const strip = document.querySelector('.vitals .bfs');
    const hpBar = document.querySelector('.vitals .hp-bar');
    const probe = document.createElement('i'); probe.style.color = 'var(--c-danger)'; document.body.appendChild(probe);
    const danger = getComputedStyle(probe).color; probe.remove();
    const cells = {};
    for (const c of strip.querySelectorAll('.bfs-cell')) {
      const cs = getComputedStyle(c);
      cells[c.dataset.key] = {
        op: Number(cs.opacity), border: cs.borderTopColor, reveal: c.querySelector('.bfs-reveal').getBoundingClientRect().height / Math.max(1, c.clientHeight),
        tDisp: getComputedStyle(c.querySelector('.bfs-t')).display, size: Math.round(c.getBoundingClientRect().width),
      };
      c.__tag = c.dataset.key;
    }
    const byKey = Object.fromEntries(hud.localBuffs.map((s) => [s.key, s]));
    return {
      order: hud.localBuffs.map((s) => s.key).join(','), byKey, cells, danger,
      shown: strip.classList.contains('has-items') && getComputedStyle(strip).display === 'flex',
      under: strip.previousElementSibling === hpBar && strip.getBoundingClientRect().top >= hpBar.getBoundingClientRect().bottom - 0.5,
    };
  });
  const K = loc.byKey, C = loc.cells;
  ok(loc.order === 'env,fatigue:endurance,fatigue:strength,pose,meal,prep:toxin', 'thumbnails in list order', loc.order);
  ok(loc.shown && loc.under, 'strip shows right under the hp bar', JSON.stringify({ shown: loc.shown, under: loc.under }));
  ok(Object.values(C).every((c) => c.size === 22), 'PC thumbnails are 22 px squares', JSON.stringify(C));
  ok(K.meal.dim && K['prep:toxin'].dim && C.meal.op < 0.6 && C['prep:toxin'].op < 0.6, 'pending meal / prep are dimmed', JSON.stringify({ meal: C.meal, prep: C['prep:toxin'] }));
  ok(!K.env.dim && !K.pose.dim && C.env.op > 0.95 && C.pose.op > 0.95, 'active buffs are not dimmed', JSON.stringify({ env: C.env, pose: C.pose }));
  ok(K.env.debuff && K['fatigue:strength'].debuff && K['fatigue:endurance'].debuff
    && C.env.border === loc.danger && C['fatigue:strength'].border === loc.danger, 'debuffs wear the red (--c-danger) frame', JSON.stringify({ danger: loc.danger, env: C.env.border }));
  ok(!K.pose.debuff && !K.meal.debuff && C.pose.border !== loc.danger && C.meal.border !== loc.danger, 'buffs have no red frame', JSON.stringify({ pose: C.pose.border, meal: C.meal.border }));
  ok(K.env.glyph === '☣' && K.env.color === '#9fe07a', 'env_exposed glyph / colour from ENV_ICON / ENV_COLOR (toxin)', JSON.stringify(K.env));
  ok(K.meal.glyph === '♨' && K['prep:toxin'].glyph === '⌾' && K.pose.glyph === '☕' && K.pose.color === '#e8a0d0', 'meal / prep glyph from the item def, rest from CHAR_BUFF_GLYPH / COLOR', JSON.stringify({ meal: K.meal.glyph, prep: K['prep:toxin'].glyph, pose: K.pose }));
  ok(K.meal.title === '덩이줄기 스튜 · 다음 레이드' && K['prep:toxin'].title === '여과 호흡기 · 다음 레이드' && K['fatigue:strength'].title === '근육통'
    && K['fatigue:endurance'].title === '심폐 피로' && K.env.title.endsWith('노출') && K.pose.title === '휴식 중', 'titles = charBuffTitle', JSON.stringify(Object.fromEntries(Object.entries(K).map(([k, v]) => [k, v.title]))));
  ok(near(K['fatigue:strength'].ratio, 18.5 / 24, 0.01) && K['fatigue:strength'].time === '18h' && near(C['fatigue:strength'].reveal, 18.5 / 24, 0.08),
    'fatigue 18.5 h of 24 h: gauge ratio 0.77 · label 18h · lit part 77 % tall', JSON.stringify({ s: K['fatigue:strength'], c: C['fatigue:strength'] }));
  ok(near(K['fatigue:endurance'].ratio, 42.5 / 1440, 0.005) && K['fatigue:endurance'].time === '42m', 'fatigue 42.5 min left: ratio ≈ 0.03 · label 42m', JSON.stringify(K['fatigue:endurance']));
  ok(C['fatigue:strength'].tDisp !== 'none' && C.meal.tDisp === 'none', 'time label shown only with a timer', JSON.stringify({ t: C['fatigue:strength'].tDisp, m: C.meal.tDisp }));
  ok(K.meal.ratio === null && K.meal.time === '' && near(C.meal.reveal, 1, 0.05) && K.pose.ratio === null, 'no timer → no gauge (whole face lit, no label)', JSON.stringify({ meal: K.meal, c: C.meal }));

  const lifted = await P(() => getComputedStyle(document.querySelector('.hud-bl')).bottom);
  ok(lifted === '151px', `.hud-bl lifts over the strip (${lifted})`);

  // new array, same keys (minus the pose) and a 35 s timer → same DOM nodes, pose node gone
  await P(() => {
    const now = Date.now();
    const L2 = window.__L1.filter((b) => b.key !== 'pose').map((b) => ({ ...b }));
    const i = L2.findIndex((b) => b.key === 'fatigue:strength');
    L2[i] = { ...L2[i], startedAt: now + 35e3 - 1 - 60e3, endsAt: now + 35e3 - 1 };
    window.__L2 = L2;
    window.__game.getSystem('hud').debugLocalBuffs(L2);
  });
  await waitFor(page, () => window.__game.getSystem('hud').localBuffs.length === 5, 'strip with 5 thumbnails', 10000);
  const reuse = await P(() => {
    const cells = [...document.querySelectorAll('.vitals .bfs .bfs-cell')];
    const st = window.__game.getSystem('hud').localBuffs.find((s) => s.key === 'fatigue:strength');
    return { same: cells.every((c) => c.__tag === c.dataset.key), keys: cells.map((c) => c.dataset.key).join(','), time: st.time, ratio: st.ratio };
  });
  ok(reuse.same && reuse.keys === 'env,fatigue:endurance,fatigue:strength,meal,prep:toxin', 'a new list reuses each key\'s DOM node and drops the missing key', JSON.stringify(reuse));
  ok(/^3[45]s$/.test(reuse.time) && near(reuse.ratio, 35 / 60, 0.03), `35 s timer: label ${reuse.time}, ratio ${reuse.ratio}`, JSON.stringify(reuse));

  await P(() => {
    window.__mut = 0;
    window.__mo = new MutationObserver((list) => { window.__mut += list.length; });
    window.__mo.observe(document.querySelector('.vitals .bfs'), { childList: true });
    window.__game.getSystem('hud').debugLocalBuffs(window.__L2);   // same array
  });
  await sleep(2300);
  const tick = await P(() => {
    window.__mo.disconnect();
    const st = window.__game.getSystem('hud').localBuffs.find((s) => s.key === 'fatigue:strength');
    return { mut: window.__mut, time: st.time, ratio: st.ratio };
  });
  ok(tick.mut === 0, 'same array → no thumbnail added / removed / moved', JSON.stringify(tick));
  ok(Number.parseInt(tick.time, 10) <= Number.parseInt(reuse.time, 10) - 1 && tick.ratio < reuse.ratio, `1 s tick drains the gauge (${reuse.time} → ${tick.time})`, JSON.stringify({ reuse, tick }));

  await P(() => window.__game.getSystem('hud').debugLocalBuffs([]));
  await sleep(700);
  const empty = await P(() => {
    const strip = document.querySelector('.vitals .bfs');
    return { n: window.__game.getSystem('hud').localBuffs.length, cls: strip.className, disp: getComputedStyle(strip).display, bl: getComputedStyle(document.querySelector('.hud-bl')).bottom };
  });
  ok(empty.n === 0 && empty.disp === 'none' && empty.bl === '122px', 'empty list → strip collapses and the column drops back to 122 px', JSON.stringify(empty));

  await P(() => window.__game.getSystem('hud').debugLocalBuffs(null));
  if (real.has) {
    await sleep(300);
    const back = await P(() => ({ keys: (window.__game.ctx.player.buffs ?? []).map((b) => b.key), strip: window.__game.getSystem('hud').localBuffs.map((c) => c.key) }));
    ok(JSON.stringify(back.keys) === JSON.stringify(back.strip), 'debugLocalBuffs(null) hands the strip back to ctx.player.buffs', JSON.stringify(back));
  }

  /* ── squad row strip ──────────────────────────────────────────────────── */
  console.log('squadmate row strip');
  await P(() => {
    const rp = window.__game.getSystem('remotePlayers');
    rp.debugClear();
    const now = Date.now(), H = 3600e3;
    const peer = rp.debugSpawn({ slot: 1, name: '브라보' });
    peer.buffs = [
      { kind: 'gym_fatigue', key: 'fatigue:strength', debuff: true, state: 'active', stat: 'strength', startedAt: now - 12 * H, endsAt: now + 12.5 * H },
      { kind: 'meal', key: 'meal', debuff: false, state: 'active', defId: 'meal_bean_porridge' },
    ];
    peer.buffsRevision = 3;
    window.__peer = peer;
    window.__lobby = {
      code: 'BUFF1', hostId: peer.id, started: false, seed: 1, isPublic: false, mode: 'raid',
      players: [{ id: peer.id, name: '브라보', slot: 1, ready: false, isHost: true, connected: true }],
    };
    window.__game.getSystem('hud').debugRemotes([peer], window.__lobby);
  });
  await waitFor(page, () => window.__game.getSystem('hud').squadBuffs(window.__peer.id)?.length === 2, 'squad row strip', 10000);
  const sq = await P(() => {
    const hud = window.__game.getSystem('hud');
    const row = [...document.querySelectorAll('.squad .srow')].find((r) => !r.hidden && r.querySelector('.name').textContent === '브라보');
    const strip = row.querySelector('.bfs');
    const me = document.querySelector('.squad .srow.me');
    for (const c of strip.querySelectorAll('.bfs-cell')) c.__tag = c.dataset.key;
    return {
      s: hud.squadBuffs(window.__peer.id), mini: strip.classList.contains('is-mini'), shown: strip.classList.contains('has-items'),
      underHp: !!strip.previousElementSibling?.classList.contains('hp'),
      size: Math.round(strip.querySelector('.bfs-cell').getBoundingClientRect().width),
      tDisp: getComputedStyle(strip.querySelector('.bfs-t')).display, rowH: Math.round(row.getBoundingClientRect().height),
      meHas: !!me && !me.hidden, meCells: me ? me.querySelectorAll('.bfs .bfs-cell').length : -1,
    };
  });
  const fat = sq.s.find((b) => b.key === 'fatigue:strength'), meal = sq.s.find((b) => b.key === 'meal');
  ok(sq.mini && sq.shown && sq.underHp && sq.size === 14, 'squadmate row: mini strip (14 px) under its hp bar', JSON.stringify(sq));
  ok(fat && fat.debuff && near(fat.ratio, 12.5 / 24.5, 0.01) && fat.time === '12h' && sq.tDisp === 'none', 'row gauge ratio from the ref\'s timer; the time label is hidden at mini size', JSON.stringify(fat));
  ok(meal && !meal.dim && meal.glyph === '♨' && meal.title === '콩죽', 'row meal thumbnail (active, def glyph, def name)', JSON.stringify(meal));
  ok(sq.rowH > 30, `row grows to fit the strip (${sq.rowH} px)`);
  ok(sq.meHas && sq.meCells === 0, 'the local row has no thumbnails', JSON.stringify({ meHas: sq.meHas, meCells: sq.meCells }));

  await P(() => {
    const peer = window.__peer;
    peer.buffs = [{ kind: 'exercise', key: 'pose', debuff: false, state: 'active', pose: 'run', stat: 'endurance' }];
    peer.buffsRevision = 4;
    window.__game.ctx.bus.emit('net:remoteBuffsChanged', { id: peer.id, buffs: peer.buffs });
  });
  await waitFor(page, () => (window.__game.getSystem('hud').squadBuffs(window.__peer.id) ?? []).map((b) => b.key).join(',') === 'pose', 'row strip updated', 10000);
  const sq2 = await P(() => window.__game.getSystem('hud').squadBuffs(window.__peer.id)[0]);
  ok(sq2.kind === 'exercise' && sq2.glyph === '⚖' && sq2.title === '운동 중' && sq2.ratio === null, 'net:remoteBuffsChanged → the row redraws (운동 중)', JSON.stringify(sq2));

  await P(() => {
    const row = [...document.querySelectorAll('.squad .srow')].find((r) => !r.hidden && r.querySelector('.name').textContent === '브라보');
    window.__smut = 0;
    window.__smo = new MutationObserver((list) => { window.__smut += list.length; });
    window.__smo.observe(row.querySelector('.bfs'), { childList: true, subtree: true, attributes: true });
  });
  await sleep(700);   // ≥ 6 squad refreshes at 10 Hz
  const smut = await P(() => { window.__smo.disconnect(); return window.__smut; });
  ok(smut === 0, 'same array on the ref → 10 Hz refreshes never touch the row strip', String(smut));

  await P(() => { window.__game.getSystem('hud').debugRemotes(null); window.__game.getSystem('remotePlayers').debugClear(); });

  /* ── raid ─────────────────────────────────────────────────────────────── */
  console.log('raid: same block, same strip');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitFor(page, () => !document.querySelector('.hud.gameplay').classList.contains('hidden'), 'gameplay layer up', 15000);
  await sleep(700);
  const raid = await layout();
  ok(raid.inSocial && !raid.socialHidden && !raid.gameplayHidden && raid.vis === 'visible' && raid.op > 0.9 && raid.h > 20, 'raid: vitals visible (social layer) with the gameplay layer up', JSON.stringify(raid));
  ok(raid.stamInGameplay && raid.blAbove && raid.blBottom === '122px' && raid.left === ship.left, 'raid: stamina in the gameplay layer, column above the vitals, same left edge as in the ship', JSON.stringify(raid));
  await P(() => window.__game.getSystem('hud').debugLocalBuffs([{ kind: 'env_exposed', key: 'env', debuff: true, state: 'active', env: 'heat' }]));
  await waitFor(page, () => window.__game.getSystem('hud').localBuffs.length === 1, 'raid strip', 10000);
  const rs = await P(() => ({ s: window.__game.getSystem('hud').localBuffs[0], disp: getComputedStyle(document.querySelector('.vitals .bfs')).display }));
  ok(rs.disp === 'flex' && rs.s.glyph === '♨' && rs.s.color === '#ff8f5c' && rs.s.debuff, 'raid: strip draws under the hp bar (heat exposure)', JSON.stringify(rs));
  await P(() => window.__game.getSystem('hud').debugLocalBuffs(null));
  // The vitals block transitions opacity / transform, so a same-task readback only sees the start value — let it settle.
  await P(() => document.querySelector('.hud.gameplay').classList.add('drone-view'));
  await sleep(900);
  const droneOn = await P(() => { const v = document.querySelector('.vitals'); return { tf: getComputedStyle(v).transform, op: Number(getComputedStyle(v).opacity) }; });
  await P(() => document.querySelector('.hud.gameplay').classList.remove('drone-view'));
  await sleep(900);
  const droneOff = await P(() => getComputedStyle(document.querySelector('.vitals')).transform);
  const drone = { on: droneOn, off: droneOff };
  ok(droneOn.tf.startsWith('matrix(0.8') && near(droneOn.op, 0.55, 0.02) && (droneOff === 'none' || droneOff.startsWith('matrix(1, 0, 0, 1')),
    'drone-view on the gameplay layer still shrinks the vitals (sibling selector)', JSON.stringify(drone));

  ok(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 5).join(' | '));
  if (consoleErrors.length) console.log(`  note ${consoleErrors.length} console error line(s): ${consoleErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log([...pageErrors, ...consoleErrors].slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
