// Single-player smoke test for the developer console (src/console): dev-host gating, ` toggle + blocker, suggestions,
// history, /seed /move /movecheat /items /stat /skill /help /clear, Home move cheat, Esc capture.
// Usage: node scripts/smoke-console.mjs [http://localhost:5273]   (needs `npm run dev`)
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
// Same FNV-1a rule as hub/ui/dom.ts parseSeed and console/commands/seed.ts.
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

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
  // Never let headless Chrome take a real pointer lock (Windows ClipCursor traps the OS cursor in the hidden window).
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    try { localStorage.removeItem('scav.console.history'); } catch { /* ignore */ }
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.console, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    // fake pointer lock so gameplay input is accepted in headless mode
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['console:toggled', 'console:executed', 'cheat:moveCheat', 'cheat:seed', 'game:paused', 'ui:catalogToggled', 'progress:statXp', 'progress:skillProgress']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  // key taps: keydown+keyup in the same evaluate on document.body (dt is clamped to 50 ms, any wait reads as a hold)
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true, cancelable: true }));
  }, code);
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true, cancelable: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true, cancelable: true })), code);
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const type = (text) => page.evaluate((t) => { const i = document.querySelector('.dev-console .dc-input'); i.value = t; i.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  const inputValue = () => page.evaluate(() => document.querySelector('.dev-console .dc-input').value);
  const suggestions = () => page.evaluate(() => Array.from(document.querySelectorAll('.dev-console .dc-sug')).map((d) => ({ text: d.textContent, sel: d.classList.contains('sel') })));
  const lastLine = () => page.evaluate(() => { const l = document.querySelectorAll('.dev-console .dc-line'); const e = l[l.length - 1]; return e ? { text: e.textContent, kind: e.className.replace('dc-line ', '') } : null; });
  const run = (line) => page.evaluate((l) => window.__game.ctx.console.run(l), line);
  const state = () => page.evaluate(() => ({ open: window.__game.ctx.console.isOpen, blocker: window.__game.ctx.uiBlockers.has('console'), hidden: document.querySelector('.dev-console').hidden, focused: document.activeElement === document.querySelector('.dev-console .dc-input'), phase: window.__game.ctx.phase, cursor: window.__game.ctx.input.isCursorMode }));
  const pos = () => page.evaluate(() => { const p = window.__game.ctx.player.position; return [p.x, p.y, p.z]; });

  console.log('dev-host gating');
  const gate = await page.evaluate(async () => {
    const m = await import('/src/shared/console.ts');
    return { enabled: window.__game.ctx.console.enabled, here: m.isDevHost(), example: m.isDevHost('example.com'), lo: m.isDevHost('LOCALHOST'), hosts: m.DEV_HOSTS.length, dom: !!document.querySelector('.dev-console') };
  });
  ok(gate.enabled === true && gate.here === true, 'ctx.console.enabled on localhost', JSON.stringify(gate));
  ok(gate.example === false && gate.lo === true && gate.hosts >= 3, 'isDevHost(example.com) false / LOCALHOST true');
  ok(gate.dom === true && (await state()).hidden === true, '.dev-console exists under #ui-root and starts hidden');
  const cmds = await page.evaluate(() => window.__game.ctx.console.getCommands().map((c) => c.name).sort());
  ok(['clear', 'help', 'items', 'move', 'movecheat', 'pos', 'seed', 'skill', 'stat'].every((n) => cmds.includes(n)), '9 built-in commands registered', cmds.join(','));

  console.log('hub / toggle');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await tap('Backquote');
  let s = await state();
  // Phase 10: the console keeps the pointer lock and turns on the in-game cursor instead of exiting the lock
  ok(s.open && s.blocker && !s.hidden && s.focused && s.cursor, '` opens: isOpen, blocker console, DOM shown, input focused, in-game cursor on', JSON.stringify(s));
  ok((await lastEv('console:toggled'))?.open === true, 'console:toggled {open:true}');
  ok((await inputValue()) === '', 'the ` character did not land in the input');
  await type('mo');
  let sug = await suggestions();
  ok(sug.length === 2 && sug[0].text.startsWith('/move ') && sug[1].text.startsWith('/movecheat') && !sug.some((x) => x.sel), '"mo" → suggestions move + movecheat, no cursor', JSON.stringify(sug));
  await tap('ArrowDown');
  sug = await suggestions();
  ok(sug[0].sel && !sug[1].sel, '↓ selects move');
  await tap('ArrowDown');
  sug = await suggestions();
  ok(!sug[0].sel && sug[1].sel, '↓ selects movecheat');
  await tap('ArrowUp');
  sug = await suggestions();
  ok(sug[0].sel, '↑ back to move');
  await tap('Tab');
  ok((await inputValue()) === 'move ', 'Tab applies the cursor suggestion → "move "', JSON.stringify(await inputValue()));
  await type('/stat s');
  sug = await suggestions();
  ok(sug.some((x) => x.text === 'str') && sug.some((x) => x.text === 'strength'), 'argument completion: /stat s → str, strength', JSON.stringify(sug));
  await tap('Escape');
  s = await state();
  ok(!s.open && !s.blocker && s.hidden && s.phase === 'hub', 'Esc closes the console (blocker removed, still hub)', JSON.stringify(s));
  ok((await lastEv('console:toggled'))?.open === false, 'console:toggled {open:false}');
  await tap('Backquote');
  await tap('Backquote');
  ok((await state()).open === false && (await ev('console:toggled')).length === 4, '` twice: open then close again');

  console.log('commands in the ship');
  await tap('Backquote');
  await run('/move 0,0,0');
  let ln = await lastLine();
  ok(ln.kind === 'error' && /행성/.test(ln.text) && (await lastEv('console:executed')).ok === false, '/move refused in the ship (red line, executed ok:false)', JSON.stringify(ln));
  await run('seed 42');
  ln = await lastLine();
  const hubSeed = await page.evaluate(() => window.__game.ctx.hub.missionSeed);
  ok(ln.kind === 'success' && hubSeed === 42 && (await lastEv('cheat:seed'))?.seed === 42, 'seed 42 → hub.missionSeed 42 + cheat:seed', `${ln.text} seed=${hubSeed}`);
  await run('/seed 붉은 행성');
  ok((await page.evaluate(() => window.__game.ctx.hub.missionSeed)) === fnv('붉은 행성'), '/seed 문구 → FNV-1a uint32 (matches hub parseSeed)');
  await run('/SEED random');
  ok((await page.evaluate(() => window.__game.ctx.hub.missionSeed)) === null && (await lastEv('cheat:seed'))?.seed === null, '/SEED random (case-insensitive) → null');
  await run('/seed');
  ok((await lastLine()).kind === 'error', '/seed without an argument → usage error');
  await run('/foo bar');
  ln = await lastLine();
  ok(ln.kind === 'error' && /알 수 없는 커맨드: foo/.test(ln.text) && (await lastEv('console:executed')).ok === false, 'unknown command → red line', ln.text);
  await run('help');
  const helpEv = await lastEv('console:executed');
  ok(helpEv.ok && /\/move <x>,<y>,<z>/.test(helpEv.output) && /\/movecheat/.test(helpEv.output) && /\/seed/.test(helpEv.output), 'help lists every command with usage', helpEv.output.slice(0, 80));
  await run('help move');
  ok(/행성에서 좌표로/.test((await lastEv('console:executed')).output), 'help move → description');
  await run('pos');
  ok(/페이즈: hub/.test((await lastEv('console:executed')).output) && /위치: \(/.test((await lastEv('console:executed')).output), 'pos prints phase + position');
  // Enter path: typed line submitted from the input
  await type('/pos');
  await tap('Enter');
  ok((await lastEv('console:executed')).line === '/pos' && (await inputValue()) === '', 'Enter submits the typed line and clears the input');
  await run('/movecheat 1');
  ok((await page.evaluate(() => window.__game.ctx.console.moveCheat)) === true && (await lastEv('cheat:moveCheat'))?.enabled === true, '/movecheat 1 → moveCheat + cheat:moveCheat');
  await run('/movecheat x');
  ok((await lastLine()).kind === 'error' && (await page.evaluate(() => window.__game.ctx.console.moveCheat)) === true, '/movecheat x → usage error, state unchanged');

  console.log('mission / move / move cheat');
  await tap('Escape');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 7 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  const mv = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.console.run('/move 10,0,10');
    const p = ctx.player.position;
    return { p: [p.x, p.y, p.z], ground: ctx.world.getHeightAt(10, 10), line: window.__ev['console:executed'].slice(-1)[0] };
  });
  ok(mv.line.ok && Math.abs(mv.p[0] - 10) < 0.5 && Math.abs(mv.p[2] - 10) < 0.5, '/move 10,0,10 on the planet teleports', JSON.stringify(mv));
  ok(mv.p[1] >= mv.ground - 0.05, 'y snapped up to the terrain height', `y=${mv.p[1].toFixed(2)} ground=${mv.ground.toFixed(2)}`);
  const mv2 = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    ctx.console.run('move -20 50 30');
    const p = ctx.player.position;
    return { p: [p.x, p.y, p.z], ground: ctx.world.getHeightAt(-20, 30) };
  });
  ok(Math.abs(mv2.p[0] + 20) < 0.5 && Math.abs(mv2.p[2] - 30) < 0.5 && mv2.p[1] >= Math.max(50, mv2.ground) - 0.05, 'move -20 50 30 (spaces) keeps y above the terrain', JSON.stringify(mv2));
  const before = await pos();
  await run('/move 9999,0,0');
  ln = await lastLine();
  const after = await pos();
  ok(ln.kind === 'error' && /맵 범위를 벗어났습니다 \(±320\)/.test(ln.text) && Math.abs(after[0] - before[0]) < 1, '/move outside the map → range error, no move', ln.text);
  await run('/move 1,2');
  ok((await lastLine()).kind === 'error', '/move with two numbers → error');
  await run('/seed 5');
  ok((await lastLine()).kind === 'error', '/seed refused on the planet');
  await run('/move 0,0,0');
  await waitSim(0.5);
  ok((await state()).open === false, 'console closed before the Home hold (isControlActive)');
  const p0 = await pos();
  const fwd = await page.evaluate(() => { const d = window.__game.ctx.camera.getWorldDirection(new (Object.getPrototypeOf(window.__game.ctx.player.position).constructor)()); return [d.x, d.y, d.z]; });
  await keyDown('Home');
  await waitSim(0.6);
  await keyUp('Home');
  const p1 = await pos();
  const dx = p1[0] - p0[0], dz = p1[2] - p0[2];
  const dist = Math.hypot(dx, dz);
  const dot = (dx * fwd[0] + dz * fwd[2]) / (dist * Math.hypot(fwd[0], fwd[2]) || 1);
  ok(dist > 8, `Home hold 0.6 s moved ${dist.toFixed(1)} m (> 8)`, JSON.stringify({ p0, p1 }));
  ok(dot > 0.9, 'moved along the camera forward', `dot=${dot.toFixed(2)}`);
  await tap('Backquote');
  await run('movecheat 0');
  ok((await page.evaluate(() => window.__game.ctx.console.moveCheat)) === false && (await lastEv('cheat:moveCheat'))?.enabled === false, 'movecheat 0 → off + event');
  await tap('Escape');
  const p2 = await pos();
  await keyDown('Home');
  await waitSim(0.4);
  await keyUp('Home');
  const p3 = await pos();
  ok(Math.hypot(p3[0] - p2[0], p3[2] - p2[2]) < 1, 'Home does nothing while the cheat is off');

  console.log('items / stat / skill');
  await tap('Backquote');
  await run('/items');
  const itemsEv = await lastEv('console:executed');
  const cat = await page.evaluate(() => ({ open: window.__game.ctx.inventory.isCatalogOpen, consoleOpen: window.__game.ctx.console.isOpen }));
  ok(itemsEv.ok && /카탈로그/.test(itemsEv.output) && cat.consoleOpen === false, '/items prints and closes the console first', JSON.stringify({ itemsEv, cat }));
  ok(cat.open === true && (await lastEv('ui:catalogToggled'))?.open === true, '/items → inventory catalog open (isCatalogOpen + ui:catalogToggled)');
  // 2026-09-08: closing the catalog panel leaves the window (and its blocker) up — Escape no longer closes it,
  // Tab does. Shut the whole thing so the checks below see a clean screen.
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; if (inv.isCatalogOpen) inv.closeCatalog(); if (inv.isOpen) inv.closeAll(); });
  await tap('Backquote');
  const statBefore = await page.evaluate(() => window.__game.ctx.progression.getStat('strength'));
  await run('/stat str 100000');
  let ex = await lastEv('console:executed');
  const statAfter = await page.evaluate(() => window.__game.ctx.progression.getStat('strength'));
  ok(ex.ok && /^근력 \d+ \(\d+\/\d+\)$/.test(ex.output) && statAfter > statBefore && statAfter <= 20, `/stat str 100000 → 근력 ${statBefore} → ${statAfter} (≤ STAT_MAX 20)`, ex.output);
  await run('/stat 근력 -999999');
  ex = await lastEv('console:executed');
  const statMin = await page.evaluate(() => window.__game.ctx.progression.getStat('strength'));
  ok(ex.ok && /^근력 1 /.test(ex.output) && statMin === 1, '/stat 근력 -999999 (Korean name) → floor at STAT_MIN 1', `${ex.output} value=${statMin}`);
  await run('/stat strength');
  ok((await lastLine()).kind === 'error', '/stat without xp → usage error');
  await run('/stat bogus 5');
  ok(/알 수 없는 스탯/.test((await lastLine()).text), '/stat bogus → unknown stat');
  await run('/stat dex abc');
  ok(/숫자가 아닙니다/.test((await lastLine()).text), '/stat dex abc → not a number');
  const skBefore = await page.evaluate(() => ({ lv: window.__game.ctx.progression.getSkill('gun_AR'), p: window.__game.ctx.progression.getSkillProgress('gun_AR') }));
  await run('/skill gun_AR 50');
  ex = await lastEv('console:executed');
  const skAfter = await page.evaluate(() => ({ lv: window.__game.ctx.progression.getSkill('gun_AR'), p: window.__game.ctx.progression.getSkillProgress('gun_AR') }));
  ok(ex.ok && /^사격 · 돌격소총 Lv\.\d+ \(\d+ %\)$/.test(ex.output), '/skill gun_AR 50 → ok, prints name Lv.n (progress)', ex.output);
  ok(skAfter.lv > skBefore.lv || skAfter.p > skBefore.p, 'raw skill xp moved gun_AR level / progress', JSON.stringify({ skBefore, skAfter }));
  await run('/skill 사격 · 돌격소총 -10');
  ok((await lastEv('console:executed')).ok, '/skill with a spaced Korean name');
  await run('/skill nope 1');
  ok(/알 수 없는 스킬/.test((await lastLine()).text), '/skill nope → unknown skill');
  const comp = await page.evaluate(() => {
    const c = window.__game.ctx.console.getCommands().find((x) => x.name === 'skill');
    return { gun: c.complete(['gun_'], window.__game.ctx), ko: c.complete(['사격'], window.__game.ctx) };
  });
  ok(comp.gun.length === 5 && comp.gun.includes('gun_AR') && comp.ko.length === 5, 'skill.complete: gun_ → 5 ids, 사격 → 5 names', JSON.stringify(comp));

  console.log('clear / history / Esc capture');
  await run('clear');
  ok((await page.evaluate(() => document.querySelectorAll('.dev-console .dc-line').length)) === 0, 'clear empties the log');
  await run('pos');
  ok((await page.evaluate(() => document.querySelectorAll('.dev-console .dc-line').length)) === 3, 'lines accumulate again after clear (input + 2 output)');
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('scav.console.history')));
  ok(Array.isArray(hist) && hist.slice(-3).join('|') === '/skill nope 1|clear|pos' && hist.includes('/stat str 100000'), 'history persisted in localStorage', JSON.stringify(hist.slice(-4)));
  await type('');
  await tap('ArrowUp');
  ok((await inputValue()) === 'pos', '↑ on empty input recalls the last line');
  await tap('ArrowUp');
  ok((await inputValue()) === 'clear', '↑ again → previous line');
  await tap('ArrowDown');
  ok((await inputValue()) === 'pos', '↓ → newer line');
  await tap('ArrowDown');
  ok((await inputValue()) === '', '↓ past the newest → empty draft');
  await tap('ArrowUp');
  await tap('Enter');
  ok((await lastEv('console:executed')).line === 'pos', 'Enter runs the recalled line');
  const pausedBefore = (await ev('game:paused')).length;
  await tap('Escape');
  s = await state();
  ok(!s.open && s.phase === 'playing' && (await ev('game:paused')).length === pausedBefore, 'Esc closes only the console — game not paused', JSON.stringify(s));
  const relock = await page.evaluate(() => [...window.__game.ctx.uiBlockers]);
  ok(relock.length === 0 && !s.cursor, 'no blocker and no in-game cursor left after closing', JSON.stringify({ relock, cursor: s.cursor }));
  // keys dispatched while the console is open must not move the player
  await tap('Backquote');
  const k0 = await pos();
  await keyDown('KeyW');
  await waitSim(0.4);
  await keyUp('KeyW');
  const k1 = await pos();
  ok(Math.hypot(k1[0] - k0[0], k1[2] - k0[2]) < 0.5, 'W while the console is open does not move the player');
  await tap('Escape');

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected (same rule as smoke-phase4)
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e && e.stack ? e.stack : e}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
