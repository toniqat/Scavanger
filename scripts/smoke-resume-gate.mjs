// game/ smoke: the 브라우저 재개 게이트 ('좌측 클릭으로 게임 재개'), the desktop-shell cursor rules, the way the
// 일시정지 메뉴 stacks over an open screen, and **ESC 닫기** (2026-09-09).
//
// The gate's trigger is a screen whose re-lock the browser refuses — a screen closed by its own key (Tab / M / E)
// re-locks at once because a real key carries activation, while **Escape carries none**. 2026-09-09: ESC closes the
// top open screen again (`ctx.escape` → `game/escapeKey`), so the gate is now the browser's answer for that path
// too; a shell hands the page an activation instead (§9). ESC with nothing open still opens the 일시정지 메뉴, and
// that menu closes on the key **only in the shell** — in the browser its 게임으로 돌아가기 click is the gesture.
//
// The pointer lock is stubbed *realistically*: `window.__lockGrant` decides whether `requestPointerLock` resolves (and
// sets `pointerLockElement`) or rejects — a rejection is exactly what Chrome does after an Escape (no user activation),
// and it is what arms `Input.awaitingLockGesture`, the gate's trigger.
// Usage: node scripts/smoke-resume-gate.mjs [http://localhost:5273]   (needs a running vite, no relay)
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    // Realistic lock stub: grant = lock taken (async `pointerlockchange`, like the real thing); refuse = rejected promise.
    window.__lockCalls = { req: 0, exit: 0, refused: 0, lastReqAt: 0 };
    // 2026-09-10: Escape 가 페이지에 닿은 시각 — 재잠금 요청이 그 키를 피해 갔는지 재는 기준.
    window.__escAt = 0;
    window.addEventListener('keydown', (e) => { if (e.code === 'Escape') window.__escAt = performance.now(); }, true);
    window.__lockEl = null;
    window.__lockGrant = true;
    const plc = () => setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0);
    Element.prototype.requestPointerLock = function () {
      window.__lockCalls.req++;
      window.__lockCalls.lastReqAt = performance.now();
      if (!window.__lockGrant) { window.__lockCalls.refused++; return Promise.reject(new DOMException('The user has exited the lock before this request was completed.', 'SecurityError')); }
      window.__lockEl = document.getElementById('game-canvas');
      plc();
      return Promise.resolve();
    };
    Document.prototype.exitPointerLock = function () { window.__lockCalls.exit++; if (window.__lockEl) { window.__lockEl = null; plc(); } };
  });
  // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run.
  await quietViteHmr(page);
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
      scheduled: ctx.input.relockScheduled, escAt: window.__escAt,
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

  /* ── 8. ESC 닫기: 맨 위 화면 하나 (2026-09-09) ───────────────────────────── */
  console.log('8. ESC 는 열린 화면 중 맨 위 하나를 닫는다 (브라우저도) — 비어 있을 때만 일시정지 메뉴');
  await grant(false);
  await openContainer('test:8');
  await waitState('(s) => s.invVis', 'container for the ESC test', 5000);
  const pausedN8 = (await ev('game:paused')).length;
  await tap('Escape');
  await waitState('(s) => !s.invVis', 'ESC closed the container window', 5000);
  s = await state();
  ok(!s.invOpen && !s.menuVis, 'ESC closed the window and did NOT open the 일시정지 메뉴', JSON.stringify(s));
  ok((await ev('game:paused')).length === pausedN8, 'the ESC that closed a screen emitted no game:paused');
  await waitState('(s) => s.gateVis', 'gate after an ESC-closed screen', 5000);
  ok((await state()).gateVis, '브라우저: ESC 로 닫으면 재개 게이트가 그 클릭을 받는다 (Escape 에는 activation 이 없다)');
  await tap('Escape');
  await waitState('(s) => s.menuVis', 'ESC with an empty stack pauses', 5000);
  ok((await state()).menuVis, '닫을 화면이 없으면 ESC 는 그대로 일시정지 메뉴');
  await grant(true);
  await P(() => [...document.querySelectorAll('.menu.pause button')].find((b) => b.textContent.includes('게임으로 돌아가기')).click());
  await waitState('(s) => !s.menuVis && s.locked', 'resumed (8)', 5000);

  /* ── 8b. ESC 로 닫은 뒤의 재잠금은 그 키를 피해서 나간다 (2026-09-10) ─────────
   * exe 에서 ESC 로 화면을 닫으면 조작이 죽고 좌클릭을 해야 살아나던 문제. Escape 를 처리하는 중에 락을
   * 요청하면 Chromium 이 허가했다가 같은 Escape 로 도로 가져가고(= 사용자 해제) 그 뒤 ~1.25초 동안 모든
   * 재요청을 거부한다 — 어떤 제스처로도 앞당겨지지 않는다. 그래서 `Input` 은 Escape 를 뗀 뒤
   * `LOCK_ESCAPE_DEFER_MS` 가 지나서야 요청을 **한 번** 보낸다. */
  console.log('8b. ESC 로 화면을 닫으면 재잠금 요청이 Escape 를 피해 나가고, 클릭 없이 카메라가 돌아온다');
  await openContainer('test:8b');
  await waitState('(s) => s.invVis && s.cursor', 'container for the deferred-relock test', 5000);
  const req8b = (await state()).lock.req;
  const gateN8b = (await gateEvents()).length;
  await tap('Escape');
  await waitState('(s) => !s.cursor', 'ESC released the cursor', 5000);
  await waitState('(s) => s.locked', 'the camera came back with no click at all', 5000);
  s = await state();
  ok(s.lock.req === req8b + 1, 'ESC 닫기가 낸 재잠금 요청은 정확히 한 번이다', `${s.lock.req} vs ${req8b}`);
  ok(s.lock.lastReqAt - s.escAt >= 150,
    'and it waited out the Escape (≥150 ms after the key) instead of asking during it',
    `${Math.round(s.lock.lastReqAt - s.escAt)} ms`);
  ok((await gateEvents()).length === gateN8b, '재개 게이트는 뜨지도 않았다 (요청이 거부되지 않았으므로)');
  // LIFO: 두 겹으로 열려 있으면 ESC 한 번은 **나중에 열린 것** 하나만 닫는다 (`shared/escape`).
  await P(() => {
    const e = window.__game.ctx.escape;
    window.__esc = [];
    e.push('lo', () => window.__esc.push('lo'));
    e.push('hi', () => window.__esc.push('hi'));
  });
  await tap('Escape'); await waitSim(0.1);
  ok((await P(() => window.__esc.join())) === 'hi' && !(await state()).menuVis,
     'ESC 한 번 = 맨 위 하나만 (메뉴는 열리지 않는다)', await P(() => window.__esc.join()));
  await tap('Escape'); await waitSim(0.1);
  ok((await P(() => window.__esc.join())) === 'hi,lo' && !(await state()).menuVis,
     '두 번째 ESC = 그 아래 하나', await P(() => window.__esc.join()));
  await tap('Escape');
  await waitState('(s) => s.menuVis', 'stack empty → pause (8)', 5000);
  ok((await state()).menuVis && (await P(() => window.__game.ctx.escape.size)) === 0, '스택이 비면 그때 일시정지 메뉴');
  await P(() => [...document.querySelectorAll('.menu.pause button')].find((b) => b.textContent.includes('게임으로 돌아가기')).click());
  await waitState('(s) => !s.menuVis && s.locked', 'resumed after the LIFO check', 5000);
  // 한 걸음만 되돌린 화면은 **스택에 남는다** (`false` 를 돌려준다) — 하우징 모드가 가구만 내려놓는 경우가 그것이다.
  await P(() => {
    const e = window.__game.ctx.escape;
    window.__steps = 0;
    e.push('twostep', () => { window.__steps++; return window.__steps >= 2; });
  });
  await tap('Escape'); await waitSim(0.1);
  let two = await P(() => ({ steps: window.__steps, size: window.__game.ctx.escape.size }));
  ok(two.steps === 1 && two.size === 1 && !(await state()).menuVis,
     'false 를 돌려준 닫기는 스택에 남는다 (한 걸음만 되돌린 화면)', JSON.stringify(two));
  await tap('Escape'); await waitSim(0.1);
  two = await P(() => ({ steps: window.__steps, size: window.__game.ctx.escape.size }));
  ok(two.steps === 2 && two.size === 0, '두 번째 ESC 가 그 화면을 실제로 닫는다', JSON.stringify(two));

  /* ── 9. desktop shell: no gate, cursor hidden while no owner, ESC closes the menu ── */
  console.log('9. isDesktopShell(): no gate; body.desktop-nocursor follows cursor mode; ESC 가 메뉴도 닫는다');
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
  // 2026-09-10: Alt 커서는 제거됐다 — 셸에서 Alt 를 눌러도 커서 소유자가 생기지 않고 커서는 숨은 채다
  await tap('AltLeft'); await waitSim(0.15);
  s = await state();
  ok(s.blockers.length === 0 && s.nocursor && s.locked, 'Alt no longer shows the OS cursor in the shell (no owner, lock kept)', JSON.stringify(s));
  // 2026-09-09 (사용자 결정): 셸에서는 **ESC 가 일시정지 메뉴도 닫는다**. 브라우저는 §2 그대로 클릭 전용이다 —
  // 셸에서만 메인 프로세스가 ESC key-up 에 activation 을 주므로 닫는 즉시 카메라가 돌아온다.
  await tap('Escape');
  await waitState('(s) => s.menuVis', 'pause menu (desktop ESC test)', 5000);
  await tap('Escape');
  await waitState('(s) => !s.menuVis', 'desktop: ESC closed the 일시정지 메뉴', 5000);
  s = await state();
  ok(!s.menuVis, 'desktop shell: ESC closes the 일시정지 메뉴 (browser keeps click-only)', JSON.stringify(s));
  ok((await ev('game:paused')).slice(-1)[0].paused === false, 'the ESC close went through game:paused {paused:false}');
  await waitState('(s) => s.locked', 'desktop: locked again after the ESC close', 5000);
  await P(() => { window.__scavDesktop = false; });
  await waitState('(s) => !s.nocursor', 'desktop off', 5000);
  ok(!(await state()).nocursor, 'browser again: class removed');

  /* ── 10. hub: the gate works in the ship too; never on a result screen ──── */
  console.log('10. hub + death guards');
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
