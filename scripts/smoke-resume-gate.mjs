// game/ smoke: the 브라우저 재개 게이트 ('좌측 클릭으로 게임 재개'), the desktop-shell cursor rules and the way the
// 일시정지 메뉴 stacks over an open screen (2026-09-08: ESC = 항상 일시정지).
//
// 2026-09-08: the gate's trigger is a screen closed by **its own key** (Tab / M / E) whose re-lock the browser then
// refuses — Escape does not close screens any more, it opens the 일시정지 메뉴, and that menu's 게임으로 돌아가기
// click is normally the gesture Chrome wants. The gate is what is left for every path where no click arrives.
//
// The pointer lock is stubbed *realistically*: `window.__lockGrant` decides whether `requestPointerLock` resolves (and
// sets `pointerLockElement`) or rejects — a rejection is exactly what Chrome does after an Escape (no user activation),
// and it is what arms `Input.awaitingLockGesture`, the gate's trigger.
// Usage: node scripts/smoke-resume-gate.mjs [http://localhost:5273]   (needs a running vite, no relay)
import puppeteer from 'puppeteer-core';
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
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(50);
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    // Realistic lock stub: grant = lock taken (async `pointerlockchange`, like the real thing); refuse = rejected promise.
    window.__lockCalls = { req: 0, exit: 0, refused: 0 };
    window.__lockEl = null;
    window.__lockGrant = true;
    const plc = () => setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0);
    Element.prototype.requestPointerLock = function () {
      window.__lockCalls.req++;
      if (!window.__lockGrant) { window.__lockCalls.refused++; return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'SecurityError')); }
      window.__lockEl = document.getElementById('game-canvas');
      plc();
      return Promise.resolve();
    };
    Document.prototype.exitPointerLock = function () { window.__lockCalls.exit++; if (window.__lockEl) { window.__lockEl = null; plc(); } };
    // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run.
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
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => window.__lockEl, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['ui:resumeGate', 'game:paused', 'input:cursorModeChanged', 'inventory:closed', 'inventory:opened']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}))); });
    }
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const tap = (code) => P((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => P((k) => window.__ev[k], n);
  const gateEvents = () => ev('ui:resumeGate');
  const grant = (v) => P((g) => { window.__lockGrant = g; }, v);
  const vis = `(e) => !!e && !e.hidden && !e.classList.contains('hidden') && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'`;
  const state = () => P(new Function(`
    const vis = ${vis};
    const ctx = window.__game.ctx;
    const inv = document.querySelector('.inv-root'); const menu = document.querySelector('.menu.pause'); const gate = document.querySelector('.resume-gate');
    return {
      phase: ctx.phase, blockers: [...ctx.uiBlockers], cursor: ctx.input.isCursorMode, locked: ctx.input.isPointerLocked,
      awaiting: ctx.input.awaitingLockGesture, control: ctx.isControlActive(), invOpen: ctx.inventory.isOpen, invVis: vis(inv),
      menuVis: vis(menu), gateVis: vis(gate), gateBlur: gate ? (getComputedStyle(gate).backdropFilter || getComputedStyle(gate).webkitBackdropFilter || '') : '',
      gateZ: gate ? getComputedStyle(gate).zIndex : null, menuZ: menu ? getComputedStyle(menu).zIndex : null, invZ: inv ? getComputedStyle(inv).zIndex : null,
      nocursor: document.body.classList.contains('desktop-nocursor'), lock: { ...window.__lockCalls }, time: ctx.time,
    };`));
  /**
   * Wait until a predicate over the snapshot below holds. `pred` is **source text** (`'(s) => s.gateVis'`): puppeteer
   * serialises evaluate arguments as JSON, so a real function could not be passed through.
   */
  const waitState = (pred, label, timeout = 8000) => waitFor(page, new Function('pred', `const vis = ${vis}; const ctx = window.__game.ctx; const inv = document.querySelector('.inv-root'); const menu = document.querySelector('.menu.pause'); const gate = document.querySelector('.resume-gate');
    const s = { blockers: [...ctx.uiBlockers], cursor: ctx.input.isCursorMode, locked: ctx.input.isPointerLocked, awaiting: ctx.input.awaitingLockGesture, invVis: vis(inv), menuVis: vis(menu), gateVis: vis(gate), nocursor: document.body.classList.contains('desktop-nocursor') };
    return (0, eval)('(' + pred + ')')(s);`), label, timeout, pred);
  const openContainer = (id) => P((cid) => { const ctx = window.__game.ctx; const items = [ctx.loot.createItem('ammo_light', 10), ctx.loot.createItem('heal_bandage', 1)]; ctx.inventory.openContainerItems(cid, items, ctx.player.position.clone(), '테스트 상자'); }, id);
  const clickGate = () => P(() => { const g = document.querySelector('.resume-gate'); g.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 480, clientY: 270 })); g.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, clientX: 480, clientY: 270 })); });

  /* ── boot into a solo raid ─────────────────────────────────────────────── */
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: 11 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
  await waitSim(0.3);
  let s = await state();
  ok(s.locked && !s.cursor && !s.gateVis && s.blockers.length === 0, 'raid baseline: locked, no cursor owner, no gate', JSON.stringify(s));
  ok(!!(await P(() => document.querySelector('.resume-gate'))) && (await P(() => document.querySelector('.resume-gate').parentElement === window.__game.ctx.uiRoot)), 'gate DOM exists under ctx.uiRoot (hidden)');

  /* ── 1. container → Escape → refused re-lock → gate ─────────────────────── */
  console.log('1. Tab closes the container window; the refused re-lock shows the gate');
  await openContainer('test:1');
  await waitSim(0.15);
  s = await state();
  ok(s.invVis && s.cursor && !s.locked && s.blockers.join() === 'inventory' && !s.gateVis, 'container window: cursor mode, lock released, gate hidden', JSON.stringify(s));
  await grant(false);
  const gateN0 = (await gateEvents()).length;
  await tap('Tab');
  await waitState('(s) => s.gateVis', 'gate shown after Tab', 5000);
  s = await state();
  // `InventoryUI.hide()` keeps the root in the DOM for a 180 ms close transition, so `isOpen` is the immediate signal.
  ok(!s.invOpen, 'Tab closed the container window (the key that opens it)', JSON.stringify(s));
  await waitState('(s) => !s.invVis', 'inventory root gone after its close transition', 3000);
  ok(!s.menuVis, 'and did NOT open the 일시정지 메뉴 in the same frame', JSON.stringify(s));
  ok(s.awaiting && !s.locked && !s.cursor, 'lock refused → Input.awaitingLockGesture, no cursor owner', JSON.stringify(s));
  ok(s.gateVis && s.blockers.join() === 'resumegate', 'gate visible with RESUME_GATE_BLOCKER as the only blocker', JSON.stringify(s));
  ok(!s.control, 'gameplay control off while the gate is up (isControlActive false)', JSON.stringify(s));
  ok(/blur/.test(s.gateBlur), 'gate has a backdrop blur', s.gateBlur);
  ok((await P(() => document.querySelector('.resume-gate .rg-title').textContent)) === '좌측 클릭으로 게임 재개', 'gate title 좌측 클릭으로 게임 재개');
  const ge = await gateEvents();
  ok(ge.length === gateN0 + 1 && ge[ge.length - 1].shown === true, 'ui:resumeGate {shown:true} emitted once', JSON.stringify(ge));
  const t0 = s.time; await waitSim(0.5);
  ok((await state()).time > t0 + 0.4, 'the world keeps running behind the gate (ctx.time advances)');
  ok((await state()).gateVis, 'gate persists while nothing re-locks');

  /* ── 2. Escape on the gate = pause menu on top; closing it with Escape brings the gate back ── */
  console.log('2. Escape on the gate opens the 일시정지 메뉴; 게임으로 돌아가기 → gate again (lock still refused)');
  await tap('Escape');
  await waitState('(s) => s.menuVis && !s.gateVis', 'pause over the gate', 5000);
  s = await state();
  ok(s.menuVis && s.cursor && s.blockers.includes('menu') && !s.blockers.includes('resumegate'), 'pause menu open (cursor owner), gate hidden + blocker released', JSON.stringify(s));
  ok((await gateEvents()).slice(-1)[0].shown === false, 'ui:resumeGate {shown:false} on hide');
  ok(Number(s.menuZ) === 85, 'pause menu z-index 85 (computed)', String(s.menuZ));
  ok(Number(s.menuZ) > Number(s.invZ) && Number(s.invZ) === 50, 'pause menu z-index above the inventory root (50)', `${s.menuZ} vs ${s.invZ}`);
  ok(Number(s.gateZ) < Number(s.invZ), 'gate sits under every real screen', `${s.gateZ}`);
  const z = await P(() => ({ settings: getComputedStyle(document.querySelector('.menu.settings-menu')).zIndex, keybind: getComputedStyle(document.querySelector('.menu.keybind-menu')).zIndex }));
  ok(Number(z.settings) > 85 && Number(z.keybind) > Number(z.settings), 'settings (86) and keybind (88) menus stay above the pause', JSON.stringify(z));
  await tap('Escape');
  await waitSim(0.2);
  ok((await state()).menuVis, 'a second Escape is inert — the menu never closes on the key', JSON.stringify(await state()));
  await P(() => [...document.querySelectorAll('.menu.pause button')].find((b) => b.textContent.includes('게임으로 돌아가기')).click());
  await waitState('(s) => s.gateVis && !s.menuVis', 'gate back after 게임으로 돌아가기', 5000);
  s = await state();
  ok(s.gateVis && !s.menuVis && !s.locked, '돌아가기 closes the pause; the still-refused re-lock shows the gate again', JSON.stringify(s));
  ok((await ev('game:paused')).slice(-2).map((e) => e.paused).join() === 'true,false', 'game:paused true → false');

  /* ── 3. left click on the gate = the gesture → lock → gate gone ─────────── */
  console.log('3. click on the gate re-locks');
  await grant(true);
  const reqBefore = (await state()).lock.req;
  await clickGate();
  await waitState('(s) => s.locked && !s.gateVis', 'lock + gate hidden after the click', 5000);
  s = await state();
  ok(s.lock.req === reqBefore + 1, 'the click issued exactly one requestPointerLock', `${s.lock.req} vs ${reqBefore}`);
  ok(s.locked && !s.gateVis && s.blockers.length === 0 && s.control, 'locked, gate hidden, blocker gone, control back', JSON.stringify(s));
  ok((await gateEvents()).slice(-1)[0].shown === false && !s.awaiting, 'ui:resumeGate {shown:false}, no gesture pending');

  /* ── 4. another gesture (the WASD retry) also hides it ──────────────────── */
  console.log('4. the gesture retry path (any key) hides the gate too');
  await grant(false);
  await tap('Tab'); await waitSim(0.15);
  ok((await state()).invVis, 'Tab opens the bag');
  await tap('Tab');
  await waitState('(s) => s.gateVis', 'gate after Tab (bag)', 5000);
  await grant(true);
  await P(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true })); });
  await waitState('(s) => s.locked && !s.gateVis', 'gate hidden after the W retry', 5000);
  s = await state();
  ok(s.locked && !s.gateVis && s.blockers.length === 0, 'W (Input\'s gesture retry) took the lock and the gate left with it', JSON.stringify(s));

  /* ── 5. Tab-close path: re-lock granted at once, no gate ────────────────── */
  console.log('5. a screen closed with its own key never shows the gate');
  const gateN5 = (await gateEvents()).length;
  await tap('Tab'); await waitSim(0.15);
  await tap('Tab');
  await waitState('(s) => s.locked && !s.invVis', 'bag closed + locked', 5000);
  await waitSim(0.3);
  s = await state();
  ok(s.locked && !s.gateVis && (await gateEvents()).length === gateN5, 'Tab → Tab: locked immediately, ui:resumeGate never fired', JSON.stringify(s));

  /* ── 6. window blur behind the gate still pauses (the gate is not a screen) ── */
  console.log('6. window blur behind the gate pauses');
  await grant(false);
  await tap('Tab'); await waitSim(0.15); await tap('Tab');
  await waitState('(s) => s.gateVis', 'gate (6)', 5000);
  await P(() => window.dispatchEvent(new Event('blur')));
  await waitState('(s) => s.menuVis', 'pause on blur', 5000);
  s = await state();
  ok(s.menuVis && !s.gateVis, 'blur with only the gate up → 일시정지 메뉴 (RESUME_GATE_BLOCKER is transparent)', JSON.stringify(s));
  await grant(true);
  await P(() => window.__game.ctx.bus.emit('game:paused', { paused: false }));
  await waitState('(s) => s.locked && !s.menuVis', 'unpaused + locked (6)', 5000);

  /* ── 7. the menu stacks over a container window (2026-09-08) ───────────── */
  console.log('7. 일시정지 메뉴 ↔ 컨테이너 창: the menu stacks, 돌아가기 returns to the window');
  await tap('Escape');
  await waitState('(s) => s.menuVis', 'paused (7)', 5000);
  await openContainer('test:7');
  await waitState('(s) => s.invVis', 'container opened under the menu', 5000);
  s = await state();
  ok(s.invVis && s.menuVis && [...s.blockers].sort().join() === 'inventory,menu',
     'a window opening under the pause leaves both up — the menu no longer yields', JSON.stringify(s));
  await P(() => [...document.querySelectorAll('.menu.pause button')].find((b) => b.textContent.includes('게임으로 돌아가기')).click());
  await waitState('(s) => !s.menuVis && s.invVis', '돌아가기 → back to the container (7)', 5000);
  s = await state();
  ok(s.invVis && !s.menuVis && s.blockers.join() === 'inventory', '돌아가기 returns to the container it stacked over', JSON.stringify(s));
  await tap('Tab');
  await waitState('(s) => !s.invVis && s.locked', 'container closed + locked (7)', 5000);
  s = await state();
  ok(!s.invVis && !s.menuVis && s.locked && s.blockers.length === 0, 'Tab closes the container window; nothing else opens; locked', JSON.stringify(s));
  // a screen that owns the cursor still suppresses the focus-loss pause
  await openContainer('test:7b'); await waitSim(0.1);
  const pausedN = (await ev('game:paused')).length;
  await P(() => window.dispatchEvent(new Event('blur')));
  await waitSim(0.3);
  s = await state();
  ok(s.invVis && !s.menuVis && (await ev('game:paused')).length === pausedN, 'blur while a container is open does not pause (screen owns the cursor)', JSON.stringify(s));
  await tap('Tab');
  await waitState('(s) => !s.invVis && s.locked', 'container closed (7b)', 5000);
  // 게임으로 돌아가기 button path from a plain pause
  await tap('Escape');
  await waitState('(s) => s.menuVis', 'paused (7c)', 5000);
  await P(() => [...document.querySelectorAll('.menu.pause button')].find((b) => b.textContent.includes('게임으로 돌아가기')).click());
  await waitState('(s) => !s.menuVis && s.locked', '게임으로 돌아가기 → locked', 5000);
  ok((await state()).locked && !(await state()).gateVis, '게임으로 돌아가기 (a click) re-locks without a gate');

  /* ── 8. desktop shell: no gate, cursor hidden while no owner ────────────── */
  console.log('8. isDesktopShell(): no gate; body.desktop-nocursor follows cursor mode');
  await P(() => { window.__scavDesktop = true; });
  await waitState('(s) => s.nocursor', 'desktop-nocursor on', 5000);
  s = await state();
  ok(s.nocursor && s.locked, 'desktop: body.desktop-nocursor while nothing owns the cursor', JSON.stringify(s));
  ok((await P(() => getComputedStyle(document.body).cursor)) === 'none', 'computed body cursor is none (beats GameCursor\'s art)', await P(() => getComputedStyle(document.body).cursor));
  await tap('Tab'); await waitSim(0.15);
  s = await state();
  ok(s.invVis && !s.nocursor, 'a screen taking cursor mode shows the cursor again (class off)', JSON.stringify(s));
  await grant(false);
  const gateN8 = (await gateEvents()).length;
  await tap('Tab');
  await waitState('(s) => !s.invVis && s.awaiting', 'bag closed, lock refused (desktop)', 5000);
  await waitSim(0.4);
  s = await state();
  ok(!s.gateVis && (await gateEvents()).length === gateN8 && s.blockers.length === 0, 'desktop: refused re-lock shows NO gate', JSON.stringify(s));
  ok(s.nocursor && !s.locked, 'desktop: cursor hidden even though the lock is missing (no owner)', JSON.stringify(s));
  // the shell's Escape key-up hook (main process runs it with a user gesture)
  ok((await P(() => typeof window.__scavShellRelock === 'function')), 'window.__scavShellRelock hook installed');
  await grant(true);
  await P(() => window.__scavShellRelock());
  await waitState('(s) => s.locked', 'hook re-locked', 5000);
  ok((await state()).locked, '__scavShellRelock re-locks once no screen owns the cursor');
  // Alt 커서 counts as an owner → cursor shown
  await tap('AltLeft'); await waitSim(0.15);
  s = await state();
  ok(s.blockers.includes('cursor') && !s.nocursor, 'Alt 커서 (a cursor owner) shows the OS cursor in the shell', JSON.stringify(s));
  await tap('AltLeft'); await waitState('(s) => s.locked && s.nocursor', 'Alt cursor closed (desktop)', 5000);
  await P(() => { window.__scavDesktop = false; });
  await waitState('(s) => !s.nocursor', 'desktop off', 5000);
  ok(!(await state()).nocursor, 'browser again: class removed');

  /* ── 9. hub: the gate works in the ship too; never on a result screen ───── */
  console.log('9. hub + death guards');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub (9)');
  await waitState('(s) => s.locked && s.blockers.length === 0', 'hub locked', 8000);
  await grant(false);
  await tap('Tab'); await waitSim(0.15);
  ok((await state()).invVis, 'hub Tab screen opens');
  await tap('Tab');
  await waitState('(s) => s.gateVis', 'gate in the hub', 5000);
  ok((await state()).gateVis && (await state()).phase === 'hub', 'gate shows in the ship after a Tab-closed screen');
  await grant(true);
  await clickGate();
  await waitState('(s) => s.locked && !s.gateVis', 'hub gate click', 5000);
  ok((await state()).locked, 'gate click re-locks in the hub');
  // title (menu phase): the gate must not appear even with a refused lock and no owner
  await grant(false);
  await P(() => { window.__game.ctx.bus.emit('game:abort', {}); });
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'title');
  await P(() => { const i = window.__game.ctx.input; i.setCursorMode(false, 'menu'); i.requestPointerLock(); });
  await waitSim(0.5);
  s = await state();
  ok(!s.gateVis, 'no gate on the title screen (phase menu)', JSON.stringify(s));

  const realErrors = errors.filter((e) => !/WebSocket|ws:\/\//.test(e));
  ok(realErrors.length === 0, 'no page errors (relay socket noise excluded)', realErrors.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) { console.log('page errors:'); for (const e of errors.slice(0, 10)) console.log('  ', e); }
} finally {
  await browser.close();
}
process.exit(fail ? 1 : 0);
