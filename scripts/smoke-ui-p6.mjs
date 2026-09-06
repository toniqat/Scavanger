// Phase 6 HUD smoke (src/ui): unique-weapon charge gauge, weapon-panel fire-mode lines, 전소 / 감전 world markers,
// MOVE CHEAT tag, housing hint bar, room label. Enters a solo mission, then feeds synthetic bus events from `page.evaluate`
// and asserts the DOM. Phase 9 additions: the downed 포기 hold bar (`player:giveUpProgress` after a real `takeDamage`
// down) and the 훈련장 panel (`ctx.missionMode = 'training'` + a `TrainingRef` stub on the world instance, then
// `training:modeChanged / scored / courseFinished` + the polled course clock + the completion toast). 72 checks.
// Usage: node scripts/smoke-ui-p6.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); `pointerLockElement` is faked below.
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
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['weapon:equipped']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const emit = (name, payload) => P(([n, p]) => window.__game.ctx.bus.emit(n, p), [name, payload]);
  const q = (sel) => P((s) => { const e = document.querySelector(s); return e ? { cls: e.className, text: e.textContent, op: e.style.opacity, dash: e.style.strokeDasharray } : null; }, sel);

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => !!window.__game.getSystem('hud')), 'hud system reachable');
  // Browsers normalise `stroke-dasharray` on readback ("0.500 1" → "0.5, 1"): compare the first number.
  const dashT = (s) => Number.parseFloat(String(s));
  const layers = await P(() => ({ gameplay: !!document.querySelector('.hud.gameplay .wcharge') && !!document.querySelector('.hud.gameplay .status-markers'),
    social: !!document.querySelector('.hud.social .cheat-tag') && !!document.querySelector('.hud.social .room-label'),
    housing: !!document.querySelector('.hud.housing .housing-hint') }));
  ok(layers.gameplay, 'charge gauge + status markers live in the gameplay layer');
  ok(layers.social, 'MOVE CHEAT tag + room label live in the social layer');
  ok(layers.housing, 'housing hint bar lives in its own .hud.housing layer');

  console.log('weapon charge gauge');
  await emit('weapon:chargeChanged', { weaponId: 'u_shock', kind: 'charge', t: 0.5 });
  let g = await P(() => { const e = document.querySelector('.wcharge'); return { cls: e.className, lbl: e.querySelector('.lbl').textContent, dash: e.querySelector('.fill').style.strokeDasharray, kind: window.__game.getSystem('hud').weaponChargeKind }; });
  ok(/\bshow\b/.test(g.cls) && /\bcharge\b/.test(g.cls) && !/\bspinup\b|\bslash\b/.test(g.cls), 'charge t 0.5 → .wcharge.show.charge', g.cls);
  ok(Math.abs(dashT(g.dash) - 0.5) < 0.01 && g.lbl === '충전 50%' && g.kind === 'charge', 'arc half full, label 충전 50%', `${g.dash} ${g.lbl} ${g.kind}`);
  await emit('weapon:chargeChanged', { weaponId: 'u_minigun', kind: 'spinup', t: 1 });
  g = await P(() => { const e = document.querySelector('.wcharge'); return { cls: e.className, lbl: e.querySelector('.lbl').textContent, dash: e.querySelector('.fill').style.strokeDasharray }; });
  ok(/\bspinup\b/.test(g.cls) && !/\bcharge\b/.test(g.cls) && /\bready\b/.test(g.cls), 'spinup t 1 → class swaps to .spinup + .ready', g.cls);
  ok(Math.abs(dashT(g.dash) - 1) < 0.01 && g.lbl === '사격', 'full arc, ready label 사격', `${g.dash} ${g.lbl}`);
  await emit('weapon:chargeChanged', { weaponId: 'u_shuriken', kind: 'slash', t: 0.25 });
  g = await P(() => { const e = document.querySelector('.wcharge'); return { cls: e.className, lbl: e.querySelector('.lbl').textContent, color: getComputedStyle(e).getPropertyValue('--wc').trim() }; });
  ok(/\bslash\b/.test(g.cls) && !/\bready\b/.test(g.cls) && g.lbl === '용검 25%', 'slash t 0.25 → .slash, label 용검 25%', `${g.cls} ${g.lbl}`);
  ok(g.color.length > 0, 'kind colour variable --wc resolves', g.color);
  await emit('weapon:chargeChanged', { weaponId: 'u_shuriken', kind: 'slash', t: -1 });
  g = await P(() => { const e = document.querySelector('.wcharge'); return { cls: e.className, dash: e.querySelector('.fill').style.strokeDasharray, kind: window.__game.getSystem('hud').weaponChargeKind }; });
  ok(!/\bshow\b/.test(g.cls) && dashT(g.dash) < 0.01 && g.kind === null, 't −1 → hidden, arc reset', `${g.cls} ${g.dash} ${g.kind}`);
  await emit('weapon:chargeChanged', { weaponId: 'u_shock', kind: 'charge', t: 0.8 });
  const eq = await P(() => window.__ev['weapon:equipped'][window.__ev['weapon:equipped'].length - 1]);
  ok(!!eq, 'a real weapon:equipped payload was captured during the drop');
  await emit('weapon:equipped', eq);
  g = await q('.wcharge');
  ok(g && !/\bshow\b/.test(g.cls), 'a weapon swap hides the gauge', g && g.cls);

  console.log('weapon panel fire modes');
  const uniq = await P(() => { const d = window.__game.ctx.loot.getWeaponDef('u_flame'); return d ? { unique: d.unique, altFire: d.altFire, ammo: d.ammoType } : null; });
  if (uniq) {
    await emit('weapon:equipped', { ...eq, weaponId: 'u_flame', name: '인페르노' });
    const m = await P(() => { const w = document.querySelector('.weapon'); const mv = [...w.querySelectorAll('.modes .mv')].map((e) => e.textContent); return { cls: w.className, mv, type: w.querySelector('.type').textContent, has: window.__game.getSystem('hud').hasWeaponModes, disp: getComputedStyle(w.querySelector('.modes')).display }; });
    ok(/\bhas-modes\b/.test(m.cls) && m.has && m.disp === 'flex', 'unique def → .weapon.has-modes, mode block displayed', `${m.cls} ${m.disp}`);
    ok(m.mv[0] === '넓은 화염' && m.mv[1] === '긴 화염 제트', 'flamethrower lines 좌 넓은 화염 / 우 긴 화염 제트', JSON.stringify(m.mv));
    ok(m.type.includes('·') && !m.type.endsWith(uniq.ammo), `ammo label comes from AMMO_LABEL_KO (${uniq.ammo})`, m.type);
    for (const [id, l, r] of [['u_shock', '연쇄 전격', '충전 볼트'], ['u_shuriken', '표창 1개', '표창 3개 (F 길게: 용검)'], ['u_bow', '화살', '정조준'], ['u_bazooka', '착탄 로켓', '공중 폭발 (바닥 우클릭: 로켓 점프)'], ['u_minigun', '예열 후 사격', '—']]) {
      const has = await P((w) => !!window.__game.ctx.loot.getWeaponDef(w), id);
      if (!has) { ok(false, `${id} weapon def exists`); continue; }
      await emit('weapon:equipped', { ...eq, weaponId: id, name: id });
      const mv = await P(() => [...document.querySelectorAll('.weapon .modes .mv')].map((e) => e.textContent));
      ok(mv[0] === l && mv[1] === r, `${id} lines 좌 ${l} / 우 ${r}`, JSON.stringify(mv));
    }
    await emit('weapon:equipped', eq);
    const back = await P(() => ({ cls: document.querySelector('.weapon').className, disp: getComputedStyle(document.querySelector('.weapon .modes')).display }));
    ok(!/\bhas-modes\b/.test(back.cls) && back.disp === 'none', 'graded rifle → mode lines hidden again', `${back.cls} ${back.disp}`);
  } else ok(false, 'u_flame weapon def exists (items Phase 6)');

  console.log('status markers');
  const spot = () => P(() => { const p = window.__game.ctx.player; const f = p.getForward(); return [p.position.x + f.x * 5, p.position.y, p.position.z + f.z * 5]; });
  let s = await spot();
  await P((v) => { const V = window.__game.ctx.player.position.constructor; window.__game.ctx.bus.emit('enemy:incinerated', { id: 1, position: new V(v[0], v[1], v[2]), duration: 6 }); }, s);
  await waitSim(0.15);
  let mk = await P(() => { const e = document.querySelector('.smarker.burn'); return { cls: e ? e.className : '', text: e ? e.textContent : '', op: e ? Number(e.style.opacity) : -1, n: window.__game.getSystem('hud').statusMarkerCount }; });
  ok(/\bshow\b/.test(mk.cls) && mk.text === '🔥 전소' && mk.n === 1, 'enemy:incinerated → 🔥 전소 marker', `${mk.cls} ${mk.text} n=${mk.n}`);
  ok(mk.op > 0.9, 'burn marker projected in front of the camera (opacity ~1)', String(mk.op));
  await waitSim(0.9);
  mk = await P(() => { const e = document.querySelector('.smarker.burn'); return { op: e ? Number(e.style.opacity) : -1 }; });
  ok(mk.op > 0 && mk.op < 0.95, 'burn marker fading after ~1 s (sim time)', String(mk.op));
  await waitSim(0.8);
  mk = await P(() => ({ n: window.__game.getSystem('hud').statusMarkerCount, any: !!document.querySelector('.smarker.burn.show') }));
  ok(mk.n === 0 && !mk.any, 'burn marker released after 1.5 s', JSON.stringify(mk));
  s = await spot();
  await P((v) => { const V = window.__game.ctx.player.position.constructor; const b = window.__game.ctx.bus; for (let i = 0; i < 3; i++) b.emit('enemy:shocked', { id: 10 + i, position: new V(v[0] + i, v[1], v[2]) }); }, s);
  await waitSim(0.15);
  mk = await P(() => ({ n: document.querySelectorAll('.smarker.shock.show').length, text: document.querySelector('.smarker.shock').textContent, count: window.__game.getSystem('hud').statusMarkerCount }));
  ok(mk.n === 3 && mk.text === '⚡' && mk.count === 3, 'three enemy:shocked → three pooled ⚡ sparks', JSON.stringify(mk));
  await waitSim(0.7);
  mk = await P(() => ({ n: document.querySelectorAll('.smarker.shock.show').length, count: window.__game.getSystem('hud').statusMarkerCount }));
  ok(mk.n === 0 && mk.count === 0, 'sparks expire after 0.6 s', JSON.stringify(mk));
  await P((v) => { const V = window.__game.ctx.player.position.constructor; const b = window.__game.ctx.bus; for (let i = 0; i < 14; i++) b.emit('enemy:incinerated', { id: 20 + i, position: new V(v[0], v[1], v[2]), duration: 6 }); }, s);
  mk = await P(() => ({ count: window.__game.getSystem('hud').statusMarkerCount, dom: document.querySelectorAll('.smarker').length }));
  ok(mk.count === 12 && mk.dom === 12, '14 bursts recycle the 12-slot pool (no DOM growth)', JSON.stringify(mk));

  console.log('move cheat tag');
  await emit('cheat:moveCheat', { enabled: true });
  let ct = await P(() => ({ cls: document.querySelector('.cheat-tag').className, text: document.querySelector('.cheat-tag').textContent, on: window.__game.getSystem('hud').isMoveCheatTagOn, op: getComputedStyle(document.querySelector('.cheat-tag')).opacity }));
  ok(/\bshow\b/.test(ct.cls) && ct.text === 'MOVE CHEAT' && ct.on, 'cheat:moveCheat true → MOVE CHEAT tag', JSON.stringify(ct));
  await emit('cheat:moveCheat', { enabled: false });
  ct = await P(() => ({ cls: document.querySelector('.cheat-tag').className, on: window.__game.getSystem('hud').isMoveCheatTagOn }));
  ok(!/\bshow\b/.test(ct.cls) && !ct.on, 'cheat:moveCheat false → tag off', JSON.stringify(ct));

  console.log('housing hint bar');
  await emit('housing:modeChanged', { active: true, room: 0 });
  let hh = await P(() => { const e = document.querySelector('.housing-hint'); return { cls: e.className, name: e.querySelector('.name').textContent, keys: e.querySelector('.keys').textContent, on: window.__game.getSystem('hud').isHousingHintOn, vis: getComputedStyle(e).visibility }; });
  ok(/\bshow\b/.test(hh.cls) && hh.on, 'housing:modeChanged active → bar .show', hh.cls);
  ok(hh.name === '선택 없음 — 휠로 선택', 'no selection text', hh.name);
  // Phase 8: the 함선 관리 mode added C as a cancel key
  ok(hh.keys === 'LMB 설치 · R 회전 · X 회수 · 휠 선택 · C 취소 · Esc 종료', 'key hints from live bindings', hh.keys);
  await emit('housing:selectionChanged', { defId: 'furn_bench_gun', yaw: 1 });
  hh = await P(() => { const e = document.querySelector('.housing-hint'); return { name: e.querySelector('.name').textContent, yaw: e.querySelector('.yaw').textContent, none: e.querySelector('.name').classList.contains('none') }; });
  ok(hh.name !== 'furn_bench_gun' && hh.name !== '선택 없음 — 휠로 선택' && !hh.none, 'selection resolves the furniture name via FURNITURE_DEF_MAP', hh.name);
  ok(hh.yaw === '→ 90°', 'yaw 1 → → 90°', hh.yaw);
  await emit('housing:cursorChanged', { room: 0, x: 2, y: 3, valid: true });
  hh = await P(() => { const e = document.querySelector('.housing-hint'); return { cell: e.querySelector('.cell .v').textContent, valid: e.querySelector('.valid').textContent, cls: e.querySelector('.valid').className }; });
  ok(hh.cell === '2,3' && hh.valid === '설치 가능' && /\bok\b/.test(hh.cls), 'cursor 2,3 valid → 설치 가능 (.ok)', JSON.stringify(hh));
  await emit('housing:cursorChanged', { room: 0, x: 5, y: 1, valid: false });
  hh = await P(() => { const e = document.querySelector('.housing-hint'); return { cell: e.querySelector('.cell .v').textContent, valid: e.querySelector('.valid').textContent, cls: e.querySelector('.valid').className }; });
  ok(hh.cell === '5,1' && hh.valid === '설치 불가' && /\bbad\b/.test(hh.cls), 'cursor 5,1 invalid → 설치 불가 (.bad)', JSON.stringify(hh));
  await emit('housing:selectionChanged', { defId: null, yaw: 0 });
  hh = await P(() => ({ name: document.querySelector('.housing-hint .name').textContent, yaw: document.querySelector('.housing-hint .yaw').textContent }));
  ok(hh.name === '선택 없음 — 휠로 선택' && hh.yaw === '', 'selection null → back to no-selection text', JSON.stringify(hh));
  await emit('housing:modeChanged', { active: false, room: null });
  hh = await P(() => ({ cls: document.querySelector('.housing-hint').className, on: window.__game.getSystem('hud').isHousingHintOn, cell: document.querySelector('.housing-hint .cell .v').textContent }));
  ok(!/\bshow\b/.test(hh.cls) && !hh.on && hh.cell === '—', 'housing:modeChanged inactive → hidden and reset', JSON.stringify(hh));

  console.log('room label');
  await emit('hub:roomEntered', { room: 0, purpose: 'workshop' });
  let rl = await P(() => ({ cls: document.querySelector('.room-label').className, text: document.querySelector('.room-label').textContent, on: window.__game.getSystem('hud').isRoomLabelOn }));
  ok(/\bshow\b/.test(rl.cls) && rl.on, 'hub:roomEntered → .room-label.show', rl.cls);
  ok(rl.text === '방 1·작업실', 'label reads 방 1 · 작업실', rl.text);
  await waitSim(0.8);
  rl = await P(() => window.__game.getSystem('hud').isRoomLabelOn);
  ok(rl === true, 'still up after 0.8 s', String(rl));
  await waitSim(0.9);
  rl = await P(() => ({ cls: document.querySelector('.room-label').className, on: window.__game.getSystem('hud').isRoomLabelOn }));
  ok(!/\bshow\b/.test(rl.cls) && !rl.on, 'fades after 1.5 s of sim time', JSON.stringify(rl));
  await emit('hub:roomEntered', { room: 3, purpose: null });
  rl = await P(() => document.querySelector('.room-label').textContent);
  ok(rl === '방 4·빈 방', 'null purpose → 빈 방', rl);
  await emit('hub:roomEntered', { room: null, purpose: null });
  rl = await P(() => ({ cls: document.querySelector('.room-label').className, on: window.__game.getSystem('hud').isRoomLabelOn }));
  ok(!/\bshow\b/.test(rl.cls) && !rl.on, 'room null → hidden at once', JSON.stringify(rl));

  console.log('give-up bar (Phase 9)');
  // A real down (lethal damage → downed, not dead) so the vitals are in downed mode; the hold itself is player/'s, so it is synthesised.
  await P(() => window.__game.ctx.player.takeDamage(500));
  await waitSim(0.2);
  const giveUp = () => P(() => { const v = document.querySelector('.vitals'); const g = v.querySelector('.giveup'); return { downed: v.classList.contains('downed'), pDowned: window.__game.ctx.player.isDowned, cls: g.className, txt: g.querySelector('.txt').textContent, tf: g.querySelector('.fill').style.transform, disp: getComputedStyle(g).display, color: getComputedStyle(g.querySelector('.fill')).backgroundColor, on: window.__game.getSystem('hud').isGiveUpBarOn }; });
  let gu = await giveUp();
  ok(gu.downed && gu.pDowned, 'lethal damage → vitals in downed mode (player downed, not dead)', JSON.stringify(gu));
  ok(!/\bshow\b/.test(gu.cls) && gu.disp === 'none' && !gu.on, 'give-up bar hidden until the hold starts', JSON.stringify(gu));
  await emit('player:giveUpProgress', { t: 0.5 });
  gu = await giveUp();
  ok(/\bshow\b/.test(gu.cls) && gu.disp === 'flex' && gu.on, 'player:giveUpProgress 0.5 → .giveup.show', JSON.stringify(gu));
  ok(gu.txt === '포기' && gu.tf === 'scaleX(0.5)' && gu.color === 'rgb(255, 77, 77)', 'label 포기, fill scaleX 0.5 in --c-danger', JSON.stringify(gu));
  await emit('player:giveUpProgress', { t: 0.9 });
  gu = await giveUp();
  ok(gu.tf === 'scaleX(0.9)' && gu.on, 't 0.9 → fill scaleX 0.9', gu.tf);
  await emit('player:giveUpProgress', { t: -1 });
  gu = await giveUp();
  ok(!/\bshow\b/.test(gu.cls) && !gu.on && gu.tf === 'scaleX(0)', 't −1 (released) → hidden, fill reset', JSON.stringify(gu));
  await emit('player:giveUpProgress', { t: 0.3 });
  gu = await giveUp();
  ok(gu.on && gu.tf === 'scaleX(0.3)', 'a new hold shows the bar again', JSON.stringify(gu));
  await P(() => window.__game.ctx.player.revive());
  await waitSim(0.2);
  gu = await giveUp();
  ok(!gu.downed && !gu.pDowned && !gu.on && !/\bshow\b/.test(gu.cls), 'revive → downed mode off, give-up bar hidden with it', JSON.stringify(gu));
  await emit('player:giveUpProgress', { t: 0.6 });
  gu = await giveUp();
  ok(!gu.on, 'giveUpProgress while not downed is ignored', JSON.stringify(gu));

  console.log('training panel (Phase 9)');
  const tpanel = () => P(() => { const e = document.querySelector('.training-panel'); const h = window.__game.getSystem('hud'); const timeRow = e.querySelector('.row.time'); const bestRow = e.querySelector('.row.best'); return { cls: e.className, on: h.isTrainingPanelOn, pulsing: h.isTrainingPulsing, mode: h.trainingPanelMode, modeTxt: e.querySelector('.mode').textContent, num: e.querySelector('.row.score .num').textContent, fill: e.querySelector('.bar .fill').style.transform, barDisp: getComputedStyle(e.querySelector('.bar')).display, timeHidden: timeRow.hidden, time: timeRow.querySelector('.num').textContent, urgent: timeRow.classList.contains('urgent'), bestHidden: bestRow.hidden, best: bestRow.querySelector('.num').textContent, inLayer: !!document.querySelector('.hud.gameplay .training-panel') }; });
  let tp = await tpanel();
  ok(tp.inLayer && !tp.on && !/\bshow\b/.test(tp.cls), 'training panel mounted in the gameplay layer, hidden in a raid', JSON.stringify(tp));
  await emit('training:scored', { score: 1, hits: 1, index: 0 });
  tp = await tpanel();
  ok(!tp.on, 'training:scored in a raid does not bring the panel up', JSON.stringify(tp));
  // Fake a training: ctx.missionMode + a TrainingRef stub as an own property of the world instance (shadows the prototype getter).
  const stubbed = await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'training';
    const stub = { mode: 'static', score: 0, hits: 0, remaining: -1, bestTime: null, setMode(m) { this.mode = m; return true; }, startCourse() { return false; }, resetScore() { this.score = 0; this.hits = 0; } };
    try { Object.defineProperty(ctx.world, 'training', { value: stub, configurable: true, writable: true }); } catch (e) { return String(e); }
    window.__tr = stub;
    return ctx.world.training === stub ? true : 'getter not shadowed';
  });
  ok(stubbed === true, 'ctx.world.training stub installed as an own property over the prototype getter', String(stubbed));
  await emit('game:phaseChanged', { phase: 'playing', prev: 'deploying' });
  tp = await tpanel();
  ok(tp.on && /\bshow\b/.test(tp.cls), 'phaseChanged playing while missionMode = training → .training-panel.show', JSON.stringify(tp));
  ok(tp.modeTxt === '고정 표적' && tp.mode === 'static' && tp.num === '0' && tp.barDisp === 'none' && tp.timeHidden && tp.bestHidden, 'initial rows: 고정 표적 chip, 격추 0, no bar / timer / best', JSON.stringify(tp));
  await emit('training:modeChanged', { mode: 'moving' });
  tp = await tpanel();
  ok(tp.modeTxt === '이동 표적' && tp.mode === 'moving' && !/\btimed\b/.test(tp.cls), 'training:modeChanged moving → 이동 표적 chip', JSON.stringify(tp));
  await emit('training:scored', { score: 3, hits: 4, index: 2 });
  tp = await tpanel();
  ok(tp.num === '3' && tp.pulsing && /\bpulse\b/.test(tp.cls), 'training:scored 3 → 격추 3 + pulse', JSON.stringify(tp));
  await waitSim(1.0);
  tp = await tpanel();
  ok(!tp.pulsing && !/\bpulse\b/.test(tp.cls), 'pulse drops after 0.9 s of sim time', JSON.stringify(tp));
  await P(() => { window.__tr.mode = 'timed'; window.__tr.score = 3; });
  await emit('training:modeChanged', { mode: 'timed' });
  tp = await tpanel();
  ok(/\btimed\b/.test(tp.cls) && tp.modeTxt === '타임 코스' && tp.num === '3 / 10' && tp.barDisp === 'block' && tp.fill === 'scaleX(0.3)', 'timed mode → 타임 코스 chip, 3 / 10 with a 30 % bar', JSON.stringify(tp));
  // a running course: the clock is polled from the TrainingRef every frame
  await P(() => { window.__tr.remaining = 42.3; });
  await waitSim(0.15);
  tp = await tpanel();
  ok(!tp.timeHidden && tp.time === '42.3초' && !tp.urgent, 'remaining 42.3 → 남은 시간 42.3초 row', JSON.stringify(tp));
  await P(() => { window.__tr.remaining = 7.9; window.__tr.score = 6; });
  await waitSim(0.15);
  tp = await tpanel();
  ok(tp.time === '7.9초' && tp.urgent && tp.num === '6 / 10', 'remaining 7.9 → .urgent red, polled score 6 / 10', JSON.stringify(tp));
  await P(() => { window.__tr.remaining = -1; window.__tr.score = 10; window.__tr.bestTime = 12.3; });
  await emit('training:courseFinished', { time: 12.3, score: 10, completed: true, best: 12.3 });
  tp = await tpanel();
  ok(tp.num === '10 / 10' && /\bdone\b/.test(tp.cls) && tp.timeHidden && !tp.bestHidden && tp.best === '12.3초' && tp.pulsing, 'courseFinished completed → 10 / 10 .done, timer row gone, 최고 기록 12.3초, pulse', JSON.stringify(tp));
  let tnotifs = await P(() => [...document.querySelectorAll('.notif')].map((e) => e.textContent));
  ok(tnotifs.some((t) => t.includes('타임 코스 완료') && t.includes('12.3초') && t.includes('신기록')), 'toast 타임 코스 완료 12.3초 · 신기록', JSON.stringify(tnotifs.slice(-3)));
  await P(() => { window.__tr.score = 6; });
  await emit('training:courseFinished', { time: 60, score: 6, completed: false, best: 12.3 });
  tp = await tpanel();
  tnotifs = await P(() => [...document.querySelectorAll('.notif')].map((e) => e.textContent));
  ok(tp.num === '6 / 10' && !/\bdone\b/.test(tp.cls) && tp.best === '12.3초', 'timed-out course → 6 / 10, best kept', JSON.stringify(tp));
  ok(tnotifs.some((t) => t.startsWith('시간 초과')), 'toast 시간 초과', JSON.stringify(tnotifs.slice(-3)));
  // back to a raid for the reset section (the panel stays up so the abort below has something to hide)
  await P(() => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; delete ctx.world.training; delete window.__tr; });

  console.log('mission reset');
  s = await spot();
  await P((v) => { const V = window.__game.ctx.player.position.constructor; window.__game.ctx.bus.emit('enemy:incinerated', { id: 99, position: new V(v[0], v[1], v[2]), duration: 6 }); window.__game.ctx.bus.emit('weapon:chargeChanged', { weaponId: 'u_shock', kind: 'charge', t: 0.3 }); window.__game.ctx.bus.emit('housing:modeChanged', { active: true, room: 1 }); window.__game.ctx.bus.emit('hub:roomEntered', { room: 2, purpose: 'range' }); }, s);
  await emit('game:abort', {});
  await waitSim(0.1);
  const reset = await P(() => { const h = window.__game.getSystem('hud'); return { markers: h.statusMarkerCount, charge: h.weaponChargeKind, housing: h.isHousingHintOn, room: h.isRoomLabelOn, training: h.isTrainingPanelOn }; });
  ok(reset.markers === 0 && reset.charge === null && !reset.housing && !reset.room && !reset.training, 'game:abort clears markers, gauge, housing bar, room label and the training panel', JSON.stringify(reset));

  ok(errors.length === 0, 'no console errors', errors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
