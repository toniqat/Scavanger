// Smoke test for the 2026-09-06 UI / implant package: title controls diagram + key rebinding, the hub Tab ship
// screen (stash persistence, implant slot / picker, right-click repair, screen tabs), the terminal without
// scrollbars, and the reworked implants (crosshair gauge, wielded shield stowed by a weapon key, hold-to-overcharge).
// 2026-09-11 (C-9 · X-8): boots with a legacy `scav.keybinds` blob (`SWAP` retired + `RELOAD=V` vs the new `DIVE=V`) and
// checks the load report, the title's 키 설정 확인 card, the retired line leaving the blob, and the clash in the key menu.
// Usage: node scripts/smoke-controls-hub.mjs [http://localhost:5273/] [--shots]
// Requires `npm run dev` (or `npm run dev:all`). `--shots` writes PNGs to scripts/shots/.
//
// Timing: Engine clamps dt to 50 ms and the frame rate depends on the machine (swiftshader fallback = a few fps), so every wait
// is on simulation time (`waitSim`), never wall-clock. Key taps dispatch keydown+keyup in the same frame.
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
const SHOTS = args.includes('--shots');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];
if (SHOTS) mkdirSync('scripts/shots', { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1680,900', '--no-sandbox',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  // 2026-09-07 (커서 rework): the fake is a *realistic* lock — cursor screens really do release it now and the
  // relock is `main.ts`'s job, so a stub that stayed locked forever would hide both halves of the mechanism.
  await page.evaluateOnNewDocument(() => {
    // 2026-09-08: this script does not check the tutorial. The tutorial starts by itself on a new profile and
    // locks room purposes · crafting · the terminal · boarding in that order, so it is marked "already finished"
    // here (the tutorial itself is what scripts/smoke-tutorial.mjs checks).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    window.__lockCalls = { req: 0, exit: 0 };
    window.__lockEl = null;
    Element.prototype.requestPointerLock = function () {
      window.__lockCalls.req++;
      window.__lockEl = document.getElementById('game-canvas');
      return Promise.resolve();
    };
    Document.prototype.exitPointerLock = function () { window.__lockCalls.exit++; window.__lockEl = null; };
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs, C-65)
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // fresh profile / stash / bindings
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  // C-9 · X-8 (2026-09-11): seeds a versionless **old keybind blob** — `SWAP` (`이전 무기`) is an action that left
  // the list, and `RELOAD=V` clashes with the new default `DIVE=V` (`구르기`). Boot has to collect the report, the
  // title has to notify once, and the retired line then has to go. The clash stays in the blob, so section 2 sees
  // it in the key-settings screen, sweeps it away with `초기화` and carries on with the original checks.
  await page.evaluate(() => { localStorage.removeItem('scav.s1.stash'); localStorage.removeItem('scav.s1.grant'); localStorage.setItem('scav.keybinds', JSON.stringify({ SWAP: 'KeyX', RELOAD: 'KeyV' })); });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__game?.ctx, 'engine boot');

  const install = () => page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    window.__lockEl = canvas;
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => window.__lockEl, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['implant:wieldChanged', 'implant:energyChanged', 'implant:grappleTargetChanged', 'implant:activated', 'input:bindingsChanged', 'inventory:stashChanged', 'ui:statsToggled', 'weapon:swapStarted']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  await install();
  // Dispatch on document.body like a real key press: an event dispatched *at* window runs its listeners in registration
  // order, which would let the game's Input see a key a capture-phase overlay handler meant to swallow.
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  /** keydown + keyup inside one frame (a wait between them would read as a hold). */
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `scripts/shots/${name}.png` }); };
  const click = async (sel) => {
    const el = await page.$(sel);
    if (!el) throw new Error(`no element ${sel}`);
    await el.click();
  };

  /* ── 0. Old keybind report → title notice (C-9 · X-8) ───── */
  await waitFor(page, () => !document.querySelector('.menu.title')?.classList.contains('hidden'), 'title shown');
  const kbn = await page.evaluate(() => {
    const n = window.__game.getSystem('hud').keybindNotice;
    const card = document.querySelector('.menu.title .kb-notice');
    return {
      report: n.report, lines: n.lines, on: n.on,
      cardShown: !!card && !card.hidden && getComputedStyle(card).display !== 'none',
      cardLines: card ? [...card.querySelectorAll('.kbn-line')].map((e) => e.textContent) : [],
      saved: localStorage.getItem('scav.keybinds'),
    };
  });
  ok(!!kbn.report && kbn.report.retired.includes('SWAP'), 'keybind load report lists the retired SWAP entry', JSON.stringify(kbn.report));
  ok(!!kbn.report && kbn.report.conflicts.some((c) => c.action === 'RELOAD' && c.with.includes('DIVE')), 'report: saved RELOAD=V clashes with the new default DIVE=V', JSON.stringify(kbn.report));
  ok(kbn.on && kbn.cardShown, 'title shows the 키 설정 확인 card once at boot', JSON.stringify(kbn));
  ok(kbn.cardLines.includes('같은 키 V: 재장전 · 구르기') && kbn.cardLines.some((l) => l.includes('이전 무기')), `card names the clash and the retired action (${kbn.cardLines.join(' / ')})`);
  ok(kbn.saved === '{"RELOAD":"KeyV"}', `after notifying, saveKeybinds dropped the retired SWAP line but kept RELOAD (${kbn.saved})`);
  await shot('00-keybind-notice');
  await page.evaluate(() => [...document.querySelectorAll('.menu.title .kb-notice .ui-btn')].find((b) => b.textContent === '확인').click());
  ok(await page.evaluate(() => document.querySelector('.menu.title .kb-notice').hidden && !window.__game.getSystem('hud').keybindNotice.on), '확인 closes the card');

  /* ── 1. 설정 → 키 설정: controls diagram ──────────────────────────────
     2026-09-09: the title is nothing but the wordmark + the three buttons `게임 시작` / `설정` / `종료`. The
     controls diagram and `키 설정 변경` moved into the settings menu's `키 설정` section
     (`SettingsMenu.buildKeys`). */
  const home = await page.evaluate(() => ({
    // 2026-09-15: `이어하기` is only shown when there is a raid to resume (`hidden`) — only visible buttons are counted
    buttons: [...document.querySelectorAll('.menu.title .title-actions .ui-btn')].filter((b) => !b.hidden).map((b) => b.textContent),
    noPanel: !document.querySelector('.menu.title .controls-panel'),
    noName: !document.querySelector('.menu.title .ui-input'),
    // 2026-09-09: the frame's scrollWidth is not measured — `.wordmark` offsets the last letter's letter-spacing
    // with a negative right margin, so it reads exactly that much wider than its border box (an overflow on paper
    // that is never seen). The only two things that really matter are **whether the page scrolls horizontally**
    // and whether the frame is inside the screen.
    frame: (() => {
      const f = document.querySelector('.menu.title .frame').getBoundingClientRect();
      const d = document.documentElement;
      return { docSw: d.scrollWidth, docCw: d.clientWidth, left: Math.round(f.left), right: Math.round(f.right), vw: window.innerWidth };
    })(),
  }));
  ok(home.buttons.join(',') === '게임 시작,설정,종료', `title is three buttons (${home.buttons.join(' / ')})`);
  ok(home.noPanel && home.noName, '조작 다이어그램 · 콜사인 입력칸은 타이틀에서 빠졌다');
  ok(home.frame.docSw <= home.frame.docCw && home.frame.left >= 0 && home.frame.right <= home.frame.vw,
    `title fits the viewport with no page scroll (doc ${home.frame.docSw}/${home.frame.docCw}, frame ${home.frame.left}…${home.frame.right} of ${home.frame.vw})`);
  await shot('01-title-home');

  await page.evaluate(() => [...document.querySelectorAll('.menu.title .title-actions .ui-btn')].find((b) => b.textContent === '설정').click());
  await waitFor(page, () => !document.querySelector('.menu.settings-menu')?.hidden, '설정 메뉴 열림');
  await page.evaluate(() => [...document.querySelectorAll('.menu.settings-menu .set-nav .set-nav-btn')].find((b) => b.textContent.includes('키 설정'))?.click());
  const title = await page.evaluate(() => ({
    panel: !!document.querySelector('.set-body.keys .controls-panel'),
    keys: document.querySelectorAll('.set-body.keys .ctl-key').length,
    bound: document.querySelectorAll('.set-body.keys .ctl-key.bound').length,
    mouseBound: document.querySelectorAll('.set-body.keys .ctl-mouse-svg .btn.bound').length,
    wasd: !!document.querySelector('.set-body.keys .ctl-key[data-code="KeyW"].bound') && !!document.querySelector('.set-body.keys .ctl-key[data-code="KeyQ"].bound'),
    rows: [...document.querySelectorAll('.set-body.keys .ctl-fn .fn')].map((n) => n.textContent),
    oldList: !!document.querySelector('.menu.title .controls'),
    btn: [...document.querySelectorAll('.set-body.keys .ui-btn')].some((b) => b.textContent === '키 설정 변경'),
  }));
  ok(title.panel && title.keys >= 60, `설정 · 키 설정 shows the keyboard diagram (${title.keys} keys)`);
  ok(title.bound >= 18 && title.wasd, `${title.bound} bound keys lit (W, Q included)`);
  ok(title.mouseBound === 3, `mouse LMB / RMB / MMB lit (${title.mouseBound})`);
  ok(title.rows.includes('재장전 / (수류탄을 들고 있을 때) 코킹'), 'reload row carries the cook hint');
  ok(title.rows.includes('함선 지원'), 'ship call row is just 함선 지원');
  ok(!title.rows.some((r) => /수류탄:|아이템 버리기|회전/.test(r)), 'no grenade / inventory-internal rows');
  ok(!title.oldList && title.btn, 'old text list gone, 키 설정 변경 button present');
  await shot('01-title-controls');

  /* ── 2. key rebinding overlay ─────────────────────────────────────── */
  await page.evaluate(() => [...document.querySelectorAll('.set-body.keys .ui-btn')].find((b) => b.textContent === '키 설정 변경').click());
  ok(await page.evaluate(() => !document.querySelector('.menu.keybind-menu').hidden), 'key-settings overlay opened');
  // C-9 · X-8: the old blob's clash survives the notice — the key-settings screen paints the same two rows as a
  // clash. `초기화` sweeps it away.
  const legacy = await page.evaluate(() => [...document.querySelectorAll('.kb-row.conflict .kb-label')].map((n) => n.textContent));
  ok(legacy.length === 2 && legacy.some((l) => l.startsWith('재장전')) && legacy.includes('구르기'), `legacy RELOAD=V still flagged against 구르기 in the key menu (${legacy.join(' / ')})`);
  await page.evaluate(() => [...document.querySelectorAll('.kb-foot .ui-btn')].find((b) => b.textContent.includes('초기화')).click());
  ok(await page.evaluate(() => document.querySelectorAll('.kb-row.conflict').length === 0 && !localStorage.getItem('scav.keybinds')), 'reset clears the legacy clash and the blob');
  const rowBtn = (label) => page.evaluateHandle((l) => [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === l)?.querySelector('.kb-key'), label);
  // rebind 앉기 → N
  await (await rowBtn('앉기')).asElement().click();
  ok(await page.evaluate(() => !!document.querySelector('.kb-key.capturing')), 'clicking a key button waits for input');
  await keyDown('KeyN'); await keyUp('KeyN');
  const afterBind = await page.evaluate(() => ({
    label: [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '앉기').querySelector('.kb-key').textContent,
    saved: localStorage.getItem('scav.keybinds'),
    titleN: !!document.querySelector('.set-body.keys .ctl-key[data-code="KeyN"].bound'),
    titleC: !!document.querySelector('.set-body.keys .ctl-key[data-code="KeyC"].bound'),
  }));
  ok(afterBind.label === 'N', `앉기 rebound to N (${afterBind.label})`);
  ok(afterBind.saved && afterBind.saved.includes('"CROUCH":"KeyN"'), 'binding persisted to localStorage');
  ok(afterBind.titleN && !afterBind.titleC, '설정의 조작 다이어그램이 리바인딩을 따라갔다 (N lit, C dark)');
  ok((await ev('input:bindingsChanged')).length >= 1, 'input:bindingsChanged emitted');
  // conflict: 엎드리기 → N as well
  await (await rowBtn('엎드리기')).asElement().click();
  await keyDown('KeyN'); await keyUp('KeyN');
  const conflict = await page.evaluate(() => document.querySelectorAll('.kb-row.conflict').length);
  ok(conflict === 2, `both rows flagged as conflicting (${conflict})`);
  // mouse-only action refuses a keyboard key
  await (await rowBtn('사격 · 사용')).asElement().click();
  await keyDown('KeyK'); await keyUp('KeyK');
  const fireLabel = await page.evaluate(() => [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '사격 · 사용').querySelector('.kb-key').textContent);
  ok(fireLabel === 'LMB', `사격 stays on the mouse after a keyboard press (${fireLabel})`);
  await shot('02-keybinds-conflict');
  // reset
  await page.evaluate(() => [...document.querySelectorAll('.kb-foot .ui-btn')].find((b) => b.textContent.includes('초기화')).click());
  const reset = await page.evaluate(() => ({
    conflicts: document.querySelectorAll('.kb-row.conflict').length,
    crouch: [...document.querySelectorAll('.kb-row')].find((r) => r.querySelector('.kb-label').textContent === '앉기').querySelector('.kb-key').textContent,
    saved: localStorage.getItem('scav.keybinds'),
  }));
  ok(reset.conflicts === 0 && reset.crouch === 'C' && !reset.saved, 'reset restored the defaults and cleared the save');
  await keyDown('Escape'); await keyUp('Escape');
  ok(await page.evaluate(() => document.querySelector('.menu.keybind-menu').hidden && !document.querySelector('.menu.settings-menu').hidden), 'Esc closed the overlay, 설정 still up');
  await keyDown('Escape'); await keyUp('Escape');
  ok(await page.evaluate(() => document.querySelector('.menu.settings-menu').hidden && !document.querySelector('.menu.title').hidden), 'Esc closed 설정, title still up');

  /* ── 2.5 설정 › 서버 설정 — the relay address (2026-09-10) ───────────
     This is the only way into another PC's server from a build. The reconnect is **not run** here — it would cut
     the connection the later sections use, so only the save · the format check · normalisation are read, and the
     save is emptied at the end. */
  await page.evaluate(() => [...document.querySelectorAll('.menu.title .title-actions .ui-btn')].find((b) => b.textContent === '설정').click());
  await waitFor(page, () => !document.querySelector('.menu.settings-menu')?.hidden, '설정 메뉴 열림');
  const navLabels = await page.evaluate(() => [...document.querySelectorAll('.menu.settings-menu .set-nav .set-nav-btn')].map((b) => b.textContent));
  ok(navLabels.join(',') === '화면 설정,오디오 설정,키 설정,서버 설정', `설정은 네 섹션이다 (${navLabels.join(' / ')})`);
  await page.evaluate(() => [...document.querySelectorAll('.menu.settings-menu .set-nav .set-nav-btn')].find((b) => b.textContent.includes('서버 설정'))?.click());
  const net0 = await page.evaluate(() => ({
    shown: !document.querySelector('.set-body.network')?.hidden,
    input: !!document.querySelector('.set-body.network .set-text'),
    buttons: [...document.querySelectorAll('.set-body.network .set-net-foot .ui-btn')].map((b) => b.textContent),
    // with nothing typed in, all three buttons are locked (there is nothing to change).
    locked: [...document.querySelectorAll('.set-body.network .set-net-foot .ui-btn')].every((b) => b.disabled),
    note: document.querySelector('.set-body.network .set-hint')?.textContent ?? '',
    stored: localStorage.getItem('scav.relay'),
  }));
  ok(net0.shown && net0.input, '서버 설정에 주소 입력칸이 있다');
  ok(net0.buttons.join(',') === '연결 테스트,적용하고 다시 접속,기본값으로', `버튼 세 개 (${net0.buttons.join(' / ')})`);
  ok(net0.locked, '빈 칸에서는 세 버튼이 모두 잠겨 있다');
  ok(net0.stored === null, '아직 저장된 주소가 없다');

  // the format check and normalisation are decided by `shared/net.relayUrlFrom` alone (the same function as the
  // shell · server banner).
  const rules = await page.evaluate(() => {
    const net = window.__game.ctx.net;
    const bad = net.setRelayOverride('::::');
    const good = net.setRelayOverride('192.168.0.12');
    return { bad, good, stored: localStorage.getItem('scav.relay'), url: net.relayUrl, override: net.relayOverride };
  });
  ok(rules.bad === false, '형식이 아닌 주소는 거절된다');
  ok(rules.good === true && rules.stored === '192.168.0.12', '주소가 슬롯 접두사 없는 공용 키에 저장된다 (scav.relay)');
  ok(rules.url === 'ws://192.168.0.12:8787/ws', `defaultUrl 이 그 주소로 갈린다 (${rules.url})`);

  // an anonymous probe that does not cut the live connection: an unreachable address comes back as a failure,
  // the current server as a success.
  const probes = await page.evaluate(async () => {
    const net = window.__game.ctx.net;
    // TEST-NET-1 (RFC 5737) — not routed.
    const dead = await net.probeRelay('192.0.2.1');
    net.setRelayOverride('');
    const live = await net.probeRelay();
    return { dead, live, override: net.relayOverride, stored: localStorage.getItem('scav.relay') };
  });
  ok(probes.dead.ok === false && !!probes.dead.error, `닿지 않는 주소는 실패로 돌아온다 (${probes.dead.error})`);
  ok(probes.dead.url === 'ws://192.0.2.1:8787/ws', 'probe 도 같은 정규화를 쓴다');
  ok(probes.live.ok === true && probes.live.ms > 0, `지금 서버는 응답한다 (${probes.live.ms}ms)`);
  ok(probes.override === '' && probes.stored === null, '기본값으로 되돌리면 저장이 지워진다');
  await shot('02b-settings-network');
  await keyDown('Escape'); await keyUp('Escape');
  ok(await page.evaluate(() => document.querySelector('.menu.settings-menu').hidden), 'Esc 로 설정을 닫았다');

  /* ── 3. hub: Tab ship screen ──────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  await tap('Tab');
  try { await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'inventory open in hub', 20000); }
  catch (e) { console.log('  diag', JSON.stringify(await page.evaluate(() => ({ phase: window.__game.ctx.phase, blockers: [...window.__game.ctx.uiBlockers], time: window.__game.ctx.time, down: window.__game.ctx.input.isDown('Tab'), hubMenu: !document.querySelector('.menu.hub-menu').hidden })))); throw e; }
  const hubScreen = await page.evaluate(() => {
    const root = document.querySelector('.inv-root');
    const order = [...root.querySelectorAll('.inv-layout > *')].filter((n) => !n.hidden).map((n) => getComputedStyle(n).order + ':' + n.className.split(' ').pop());
    return {
      hub: root.classList.contains('is-hub'),
      stash: !root.querySelector('.inv-panel-stash').hidden,
      stashCells: root.querySelectorAll('.inv-grid-stash .inv-cell').length,
      tabs: [...root.querySelectorAll('.scr-tab')].map((b) => `${b.textContent}${b.disabled ? '(off)' : ''}${b.classList.contains('is-on') ? '*' : ''}`).join(' '),
      implantSlot: !!root.querySelector('.inv-slot-implant'),
      order,
      // 2026-09-14 (user's decision): the bottom-centre hint pill bar (`.inv-hints`) was deleted — it overlapped
      // the bottom-right key guide.
      hints: !root.querySelector('.inv-hints'),
      quickRight: (() => { const g = root.querySelector('.inv-grid-bag').getBoundingClientRect(); const q = root.querySelector('.inv-quick').getBoundingClientRect(); return q.left >= g.right - 4; })(),
      /* 2026-09-15 3rd pass: 장비 | 창고 | 가방 → 2026-09-16 (user's decision): **창고 | 장비 | 가방** (equipment in
         the middle, the three cards touching). */
      /* ⚠ measured in layout coordinates (`offsetLeft`) — the moment it opens the stash card is mid `inv-slide-in`
         (translateX −14 px), so `getBoundingClientRect` reads the seam as 14 px apart. All three are direct cards
         of `.inv-layout`, so they share one origin. */
      layoutRects: (() => { const r = (q) => { const x = root.querySelector(q); return [x.offsetLeft, x.offsetLeft + x.offsetWidth]; }; return { stash: r('.inv-panel-stash'), equip: r('.inv-equip'), grids: r('.inv-panel-grids') }; })(),
      equipMid: (() => { const r = (q) => { const x = root.querySelector(q); return [x.offsetLeft, x.offsetLeft + x.offsetWidth]; }; const s = r('.inv-panel-stash'), e = r('.inv-equip'), g = r('.inv-panel-grids'); return Math.abs(e[0] - s[1]) <= 2 && Math.abs(g[0] - e[1]) <= 2 && s[0] < e[0] && e[0] < g[0]; })(),
    };
  });
  /* ── 2026-09-09: ESC closes exactly one screen, the topmost ───
     On 2026-09-08 Escape closed no screen at all and only stacked the pause menu on top of it. It was put back on
     2026-09-09 — with a cursor on screen a person tries to close that window with ESC, and the relock afterwards is
     either handed an activation by the shell or caught by the browser's resume gate (`game/escapeKey`,
     `shared/escape`). The menu only opens while the stack is empty. */
  const escOverInv = await page.evaluate(async () => {
    const key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    key('Escape', 'keydown'); key('Escape', 'keyup');
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    const menu = document.querySelector('.menu.pause');
    return {
      paused: !!menu && !menu.classList.contains('hidden'),
      inv: window.__game.ctx.inventory.isOpen,
      blockers: [...window.__game.ctx.uiBlockers].sort(),
      escSize: window.__game.ctx.escape.size,
    };
  });
  ok(!escOverInv.inv, 'ESC 가 열린 가방을 닫는다 (2026-09-09)', JSON.stringify(escOverInv));
  ok(!escOverInv.paused, '그 ESC 로 일시정지 메뉴는 열리지 않는다', JSON.stringify(escOverInv));
  ok(escOverInv.blockers.length === 0 && escOverInv.escSize === 0, 'blocker 도 닫기 스택도 비었다', JSON.stringify(escOverInv));
  // the menu only when there is no screen to close — and the menu still stacks on top of a screen (only the menu
  // half of the 2026-09-08 rule is left).
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'bag re-opened under the menu test');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:paused', { paused: true }));
  await waitSim(0.1);
  const menuOverInv = await page.evaluate(() => {
    const menu = document.querySelector('.menu.pause');
    return { paused: !!menu && !menu.classList.contains('hidden'), inv: window.__game.ctx.inventory.isOpen, blockers: [...window.__game.ctx.uiBlockers].sort() };
  });
  ok(menuOverInv.paused && menuOverInv.inv, '일시정지 메뉴는 열린 가방 위에 쌓인다', JSON.stringify(menuOverInv));
  ok(menuOverInv.blockers.join(',') === 'inventory,menu', 'both blockers are held at once', JSON.stringify(menuOverInv.blockers));
  // Tab must not reach through the menu, and the menu only closes on its own button (browser).
  await tap('Tab');
  await waitSim(0.1);
  ok(await page.evaluate(() => window.__game.ctx.inventory.isOpen), 'Tab does not reach the bag through the menu');
  const backToInv = await page.evaluate(async () => {
    const menu = document.querySelector('.menu.pause');
    [...menu.querySelectorAll('.actions .ui-btn')][0].click();
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    return { paused: !menu.classList.contains('hidden'), inv: window.__game.ctx.inventory.isOpen, blockers: [...window.__game.ctx.uiBlockers] };
  });
  ok(!backToInv.paused && backToInv.inv, '게임으로 돌아가기 returns to the bag it was opened over', JSON.stringify(backToInv));
  ok(backToInv.blockers.join(',') === 'inventory', 'the menu blocker is gone, the bag keeps its own', JSON.stringify(backToInv.blockers));
  await tap('Tab');
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'Tab closes the bag');
  ok(true, 'Tab closes the bag once the menu is out of the way');
  await tap('Tab');
  await waitFor(page, () => window.__game.ctx.inventory.isOpen, 'bag re-opened for the checks below');

  ok(hubScreen.hub && hubScreen.stash, 'hub Tab shows the ship screen with the stash');
  ok(hubScreen.stashCells === 240, `stash grid is 10×24 (${hubScreen.stashCells} cells)`);
  // Phase 8: 함선 joined the strip (시설 업그레이드 inside the Tab screen)
  ok(hubScreen.tabs === '인벤토리* 캐릭터 기업 함선', `screen tabs: ${hubScreen.tabs}` + ' (함선 added in Phase 8)');
  // Phase 9 UI pass: the 전술 임플란트 slot left the 장착 장비 column — it is a section of the 캐릭터 tab now
  // 전술 임플란트 is not a `LOADOUT_SLOTS` equipment slot — since 2026-09-12 it lives inside the equipment grid,
  // but it is still an `.inv-implants` block and there is no `.inv-slot-implant` (`impTab` below checks that spot)
  ok(!hubScreen.implantSlot, '전술 임플란트는 장비칸(`.inv-slot-*`)이 아니다');
  ok(hubScreen.equipMid, 'layout: stash | equipment | bag (joined)', JSON.stringify(hubScreen.layoutRects));
  ok(hubScreen.quickRight, 'quick-use rose sits right of the bag grid (≥ 1600 px)');
  ok(hubScreen.hints, 'inventory hint bar is gone (2026-09-14: 키 가이드로 합쳐졌다)');
  await shot('03-hub-tab-screen');

  /* 2026-09-09 — the wheel is one more bag space: the starter kit's grenade · bandage sit **inside the slots** and
     only the ammo is left in the bag grid. The two checks below (bag → stash move, and dropping in the ship going
     to the stash) need two different stacks, so `unregisterQuick` brings the grenade back into the bag — which is
     a check of the new API in itself. */
  const wheelVsBag = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    const wheel = inv.getQuickSlots().map((q) => q?.defId ?? null);
    const bag = inv.getAllItems().map((i) => i.defId);
    const index = inv.getQuickSlots().findIndex((q) => !!q);
    const unreg = index >= 0 ? inv.unregisterQuick(index) : 'noop';
    return { wheel, bag, index, unreg, bagAfter: inv.getAllItems().map((i) => i.defId) };
  });
  ok(wheelVsBag.wheel[0] === 'grenade_frag' && wheelVsBag.wheel[4] === 'heal_bandage'
    && !wheelVsBag.bag.includes('grenade_frag') && !wheelVsBag.bag.includes('heal_bandage'),
    '함선의 가방 격자에 휠 스택은 없다 (수류탄 N · 붕대 S 는 슬롯 안)', JSON.stringify(wheelVsBag));
  ok(wheelVsBag.unreg === 'ok' && wheelVsBag.bagAfter.includes('grenade_frag'),
    'unregisterQuick(0) 이 수류탄을 가방 격자로 되돌린다', JSON.stringify(wheelVsBag));

  // bag → stash via right-click quick move (API), persistence across reload
  const stashMove = await page.evaluate(() => {
    const inv = window.__game.getSystem('inventory');
    const item = inv.getAllItems().find((i) => i.defId.startsWith('ammo_')) ?? inv.getAllItems()[0];
    const before = inv.getStashItems().length;
    const r = inv.quickMove(item.uid, { kind: 'grid', grid: 'bag' });
    return { r, before, after: inv.getStashItems().length, defId: item.defId, dropRefused: (() => { const it = inv.getAllItems().find((i) => i.defId.startsWith('ammo_')) ?? inv.getAllItems()[0]; const n = inv.getStashItems().length; return inv.dropItem(it.uid) === true && inv.getStashItems().length === n + 1; })() };
  });
  ok(stashMove.r === 'ok' && stashMove.after === stashMove.before + 1, `right-click moved ${stashMove.defId} bag → stash`);
  ok(stashMove.dropRefused, 'dropping in the ship lands in the stash, not the world');
  await sleep(600); // debounced save
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('scav.s1.stash') ?? 'null'));
  ok(saved && saved.items?.length === stashMove.after + 1, `stash saved to localStorage (${saved?.items?.length} stacks)`);

  const toTab = (label) => page.evaluate((l) => {
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent === l);
    b?.click();
    return !!b;
  }, label);

  /* The 캐릭터 tab's red dot (2026-09-08): the tab carries a red dot while there are unspent stat points */
  const dot0 = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent === '캐릭터');
    return { points: window.__game.ctx.progression.statPoints, alert: b.classList.contains('has-alert') };
  });
  ok(dot0.points === 0 && !dot0.alert, '포인트가 없으면 레드닷도 없다', JSON.stringify(dot0));
  const dot1 = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    for (let i = 0; i < 50 && p.statPoints === 0; i++) p.addXp(Math.max(1, p.xpToNext - p.xp));
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent === '캐릭터');
    return { points: p.statPoints, alert: b.classList.contains('has-alert'), data: b.dataset.alert, dot: getComputedStyle(b, '::after').content };
  });
  ok(dot1.points > 0 && dot1.alert && dot1.data === String(dot1.points), '레벨업으로 포인트가 생기면 캐릭터 탭에 레드닷이 붙는다', JSON.stringify(dot1));
  const dot2 = await page.evaluate(() => {
    const p = window.__game.ctx.progression;
    while (p.statPoints > 0 && p.spendStatPoint('strength')) { /* spends them all */ }
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent === '캐릭터');
    return { points: p.statPoints, alert: b.classList.contains('has-alert') };
  });
  ok(dot2.points === 0 && !dot2.alert, '포인트를 다 쓰면 레드닷이 사라진다', JSON.stringify(dot2));

  /* The 캐릭터 tab (2026-09-08): the implant blocks moved out into the inventory, leaving the columns 능력치 | 숙련도 */
  ok(await toTab('캐릭터'), '캐릭터 탭으로 전환');
  await sleep(220);
  const charTab = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.inv-screen .cs-body > .cs-col')];
    return {
      cols: cols.length,
      firstLabel: cols[0]?.querySelector('.ui-label')?.textContent ?? '',
      lastLabel: cols[cols.length - 1]?.querySelector('.ui-label')?.textContent ?? '',
      stray: document.querySelectorAll('.inv-screen .cs-implants, .inv-screen .cs-impitems, .cs-imp-pop-embed').length,
    };
  });
  ok(charTab.cols === 2 && charTab.firstLabel === '능력치' && charTab.lastLabel === '숙련도',
    `본문이 2열 (능력치 | 숙련도) — ${charTab.cols}열`);
  ok(charTab.stray === 0, `캐릭터 탭에 임플란트 UI 가 남아 있지 않다 (${charTab.stray})`);
  ok(await toTab('인벤토리'), '인벤토리 탭으로 복귀');
  await sleep(200);

  /* 전술 임플란트 (2026-09-08 · moved inside the equipment grid on 2026-09-12): pressing the one slot raises the
     card-list popup */
  const impTab = await page.evaluate(() => ({
    cards: document.querySelectorAll('.inv-imp-pop .inv-imp-card').length,
    inEquip: !!document.querySelector('.inv-equip .inv-implants .inv-imp-slot'),
    /* 2026-09-12 (user's decision, option A): the implant slot is not **below** the equipment grid but the
       `implant` slot **inside** it (under 주무기 II · left of the pouch). So the order survives the grid unwrapping
       into one row at a narrow width, it is inserted right before the `pouch` slot in the DOM too
       (`eqGrid.insertBefore` in `ui/InventoryUI`). */
    inGrid: !!document.querySelector('.inv-equip > .inv-equip-grid > .inv-implants'),
    beforePouch: document.querySelector('.inv-equip-grid > .inv-implants')?.nextElementSibling?.classList.contains('inv-slot-pouch') ?? false,
    items: !!document.querySelector('.inv-equip .inv-implants .inv-impitems .inv-impi-add'),
    popHidden: document.querySelector('.inv-imp-pop')?.hidden,
  }));
  // 2026-09-15: the 대전차포 (`atlauncher`) is retired — there are 5 cards and that one must not be in the picker
  ok(impTab.cards === 5 && impTab.inEquip && impTab.popHidden === true,
    `인벤토리 장착 장비 열에 임플란트 칸 + 닫힌 카드 팝업 5종 (${impTab.cards})`);
  ok(await page.evaluate(() => !document.querySelector('.inv-imp-pop .inv-imp-card[data-id="atlauncher"]')
    && !window.__game.ctx.implants.getAllDefs().some((d) => d.id === 'atlauncher')
    && window.__game.ctx.implants.setEquipped('atlauncher') === false),
    '은퇴한 대전차포는 피커 · getAllDefs 에 없고 setEquipped 도 거절한다');
  ok(impTab.inGrid && impTab.beforePouch && impTab.items,
    '임플란트 칸이 장비 격자 **안**(주머니 칸 바로 앞)이고 임플란트 아이템 블록도 함께 있다', JSON.stringify(impTab));
  // pressing the equip slot opens the popup, and picking a card equips it and closes
  await page.evaluate(() => document.querySelector('.inv-equip .inv-implants .inv-imp-slot').click());
  await sleep(120);
  ok(await page.evaluate(() => document.querySelector('.inv-imp-pop').hidden === false), '장착 칸 클릭 → 임플란트 목록 팝업');
  await shot('04-implant-cards');
  await page.evaluate(() => document.querySelector('.inv-imp-pop .inv-imp-card[data-id="overcharge"]').click());
  ok(await page.evaluate(() => document.querySelector('.inv-imp-pop').hidden === true), '카드를 고르면 팝업이 닫힌다');
  ok(await page.evaluate(() => {
    const slot = document.querySelector('.inv-equip .inv-imp-slot');
    return slot.classList.contains('is-filled') && slot.querySelector('.nm').textContent === (window.__game.ctx.implants.getDef('overcharge')?.name ?? '');
  }), '장착 칸이 고른 임플란트를 보여준다');
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === 'overcharge'), 'clicking a card equips it');
  // the 장착 중 label hangs under the description column, not off the right edge of the row
  const tag = await page.evaluate(() => {
    const card = document.querySelector('.inv-imp-pop .inv-imp-card.is-equipped');
    if (!card) return null;
    return { body: getComputedStyle(card.querySelector('.body'), '::after').content,
      row: getComputedStyle(card, '::after').content, desc: !!card.querySelector('.desc') };
  });
  ok(!!tag && /장착 중/.test(tag.body) && !/장착 중/.test(tag.row) && tag.desc, `장착 중 label renders under the description (${tag?.body})`);
  await page.evaluate(() => document.querySelector('.inv-imp-pop .inv-imp-card[data-id="overcharge"]').click());
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === null), 'clicking the equipped card unequips it');
  await page.evaluate(() => document.querySelector('.inv-imp-pop .inv-imp-card[data-id="barrier"]').click());
  ok(await page.evaluate(() => window.__game.ctx.implants.equipped === 'barrier'
    && document.querySelector('.inv-imp-pop .inv-imp-card[data-id="barrier"]').classList.contains('is-equipped')), '배리어 장착 (카드가 켜진다)');
  await sleep(200);

  // right-click repair on a worn equipped weapon
  const repairPrep = await page.evaluate(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    // 2026-09-07: the starter equips no 주무기 — take one out of the 창고 so there is worn gear to repair
    if (!inv.getEquipped('primary')) { const g = ctx.loot.createItem('wpn_ar'); inv.tryAddItem(g); inv.equip(g.uid, 'primary'); }
    const w = inv.getEquipped('primary');
    inv.updateItem(w.uid, { durability: 100 });
    inv.tryAddItem(ctx.loot.createItem('mat_scrap', 10));
    const sys = window.__game.getSystem('inventory');
    // 2026-09-08: the `.inv-slot-meta` sentence is gone — the numbers live inside the slot card
    const card = document.querySelector('.inv-slot-primary .inv-slot-card');
    // 2026-09-14: the `100/300` durability number left the card — the gauge's `data-ratio` (and its colour) carries it now
    const max = inv.getDurability(w.uid)?.max ?? 0;
    return { uid: w.uid, info: sys.repairInfo(w.uid), name: card.querySelector('.inv-slot-name').textContent, ratio: Number(card.querySelector('.inv-slot-dur')?.dataset.ratio ?? NaN),
      expect: max > 0 ? 100 / max : NaN, durNum: !!card.querySelector('.inv-slot-durnum'), ammo: card.querySelector('.inv-slot-ammo').textContent };
  });
  ok(repairPrep.info && repairPrep.info.cost.length > 0 && !repairPrep.info.short, `repair cost listed: ${repairPrep.info?.cost.map((c) => `${c.name}×${c.qty}`).join(',')}`);
  ok(Math.abs(repairPrep.ratio - repairPrep.expect) < 0.002 && !repairPrep.durNum && !!repairPrep.name && /^\d+\/\d+$/.test(repairPrep.ammo),
    `slot card shows name / rounds / durability gauge, no durability number (${repairPrep.name} · ${repairPrep.ammo} · ratio ${repairPrep.ratio})`);
  const slotTile = await page.$('.inv-slot-primary .inv-tile');
  await slotTile.click({ button: 'right' });
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].map((n) => n.textContent));
  ok(menuItems.some((t) => t.startsWith('수리')), `context menu offers 수리: ${menuItems.join(' | ')}`);
  ok(!menuItems.some((t) => t.startsWith('버리기')), 'no 버리기 entry in the ship');
  await shot('05-repair-menu');
  await page.evaluate(() => [...document.querySelectorAll('.inv-menu .inv-menu-item')].find((n) => n.textContent.startsWith('수리')).click());
  const repaired = await page.evaluate((uid) => window.__game.ctx.inventory.getDurability(uid), repairPrep.uid);
  ok(repaired.durability === repaired.max, `repaired to ${repaired.durability}/${repaired.max}`);

  // screen tabs (Phase 8): 캐릭터 / 기업 / 함선 render INSIDE the Tab screen, the window never closes
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '캐릭터').click());
  await waitFor(page, () => !!document.querySelector('.inv-root .inv-screen .cs-embed') && !document.querySelector('.inv-root .inv-screen').hidden && window.__game.ctx.inventory.isOpen, 'character view embedded in the Tab screen');
  ok(true, '캐릭터 tab renders inside the Tab screen without closing it');
  ok(await page.evaluate(() => document.querySelector('.menu.char-sheet')?.hidden !== false), 'the standalone character overlay stays closed');
  await shot('06-character-tabs');
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '함선').click());
  await waitFor(page, () => !!document.querySelector('.inv-root .inv-screen .hs-ship'), '함선 view embedded in the Tab screen');
  ok(true, '함선 tab renders the ship facilities inside the Tab screen');
  // Phase 8 UI pass: the embedded screens sit on their own opaque panel, and the 함선 tab is two columns
  const ship = await page.evaluate(() => {
    const host = document.querySelector('.inv-root .inv-screen');
    const cs = getComputedStyle(host);
    const btn = host.querySelector('.hs-manage-btn');
    return { bg: cs.backgroundImage, border: cs.borderTopWidth, cols: !!host.querySelector('.hs-ship-cols'),
      facilities: [...host.querySelectorAll('.hs-row.facility')].map((r) => r.dataset.facility),
      rooms: host.querySelectorAll('.hs-row.room').length,
      // Phase 9 UI pass: no 용도 드롭다운 in the 방 목록 any more; 2026-09-07: every room starts 빈 방
      pickers: host.querySelectorAll('.hs-row.room .purpose').length,
      room0Name: host.querySelector('.hs-row.room[data-room="0"] .name')?.textContent ?? '',
      room0Del: !host.querySelector('.hs-row.room[data-room="0"] .hs-del')?.hidden,
      thumbs: host.querySelectorAll('.hs-row.room .hs-thumb, .hs-row.facility .hs-thumb').length,
      bar: !!host.querySelector('.hs-ship-bar'),
      // Phase 9 UI pass: the panel itself no longer scrolls (the 방 목록 does), so the bar is a plain bottom strip
      screenScroll: getComputedStyle(host).overflowY,
      roomsScroll: getComputedStyle(host.querySelector('.hs-list.rooms')).overflowY,
      subtitle: !!host.querySelector('.hs-ship .hs-head .subtitle'),
      buildBtns: [...host.querySelectorAll('.hs-row.room .hs-row-acts .ui-btn')].filter((b) => !b.hidden && /시설 증축/.test(b.textContent)).length,
      btn: btn?.textContent ?? null, sticky: btn ? getComputedStyle(btn.parentElement).position : null };
  });
  ok(ship.bg !== 'none' && ship.border !== '0px', `the Tab screen has its own panel background (${ship.border} border)`);
  // 2026-09-12 (user's decision): a default personal ship has 10 → 8 rooms (SHIP_ROOM_COUNT — the cockpit is not
  // in the room list of the Tab screen's 함선 tab)
  ok(ship.cols && ship.facilities.join(',') === 'generator,storage' && ship.rooms === 8, `기본 시설 발전기 · 창고 left, 방 목록 (${ship.rooms}) right (${ship.facilities.join(',')})`);
  ok(ship.pickers === 0 && ship.room0Name === '빈 방', `방 목록 has no 용도 드롭다운, rows read the purpose name ('${ship.room0Name}')`);
  ok(!ship.room0Del, '빈 방 offers no 시설 제거 button (2026-09-07: 방 1 is empty on a new ship)');
  ok(ship.thumbs === 10, `every 시설 / 방 row leads with the shared thumbnail (${ship.thumbs} = 시설 2 + 방 8)`);
  ok(ship.bar && /시설 관리/.test(ship.btn ?? '') && ship.sticky === 'static', `separate bottom bar with the 시설 관리 (M) button on its right (${ship.btn})`);
  ok(ship.screenScroll === 'hidden' && ship.roomsScroll === 'auto' && !ship.subtitle,
    `패널은 스크롤하지 않고 방 목록만 스크롤한다, '용도가 정해진 방' 라벨 없음 (${ship.screenScroll} / ${ship.roomsScroll})`);
  ok(ship.buildBtns === 8, `빈 방 8개가 시설 증축 버튼을 가진다 (${ship.buildBtns})`);
  // 재료 요구 칩 hover card (ui/hud/ItemTip): any cost chip anywhere shows the item's info
  const tip = await page.evaluate(() => {
    const chip = document.querySelector('.inv-root .inv-screen .item-chip[data-def-id]');
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    chip.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
    const tipEl = document.querySelector('#ui-root > .item-tip');
    return { defId: chip.dataset.defId, hidden: tipEl?.hidden ?? true, name: tipEl?.querySelector('.itip-name')?.textContent ?? '',
      rows: tipEl?.querySelectorAll('.itip-stats .k').length ?? 0, labels: [...(tipEl?.querySelectorAll('.itip-stats .k') ?? [])].map((e) => e.textContent),
      bar: tipEl?.querySelector('.itip-value .wt .k')?.textContent ?? '', shown: window.__game.getSystem('hud').itemTipDefId };
  });
  // 2026-09-09: the 크기 / 무게 rows left the stats table (무게 is the bottom bar's left half), so a material card has fewer rows
  ok(tip && !tip.hidden && tip.shown === tip.defId && tip.rows >= 1 && !tip.labels.includes('크기') && !tip.labels.includes('무게') && tip.bar === '무게',
    `hovering a 재료 칩 shows the item card (${tip?.name} · ${tip?.rows} rows, 무게 in the bottom bar)`);
  await page.evaluate(() => {
    const chip = document.querySelector('.inv-root .inv-screen .item-chip[data-def-id]');
    chip.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
  });
  ok(await page.evaluate(() => document.querySelector('#ui-root > .item-tip').hidden && window.__game.getSystem('hud').itemTipDefId === null), 'leaving the chip hides the card');
  await page.evaluate(() => [...document.querySelectorAll('.inv-root .scr-tab')].find((b) => b.textContent === '인벤토리').click());
  await waitFor(page, () => document.querySelector('.inv-root .inv-screen').hidden && !document.querySelector('.inv-root .inv-layout').hidden && window.__game.ctx.inventory.isOpen, 'back to the bag view');
  ok(true, '인벤토리 tab returns to the bag / stash view');
  await keyDown('Tab'); await keyUp('Tab');   // 2026-09-08: Tab closes the window (Escape = 일시정지 메뉴)
  await waitFor(page, () => !window.__game.ctx.inventory.isOpen, 'inventory closed');

  // reload: stash persists, bag resets (policy unchanged)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__game?.ctx, 'engine boot (reload)');
  await install();
  const persisted = await page.evaluate((def) => {
    const sys = window.__game.getSystem('inventory');
    return { n: sys.getStashItems().length, has: sys.getStashItems().some((i) => i.defId === def), implant: window.__game.ctx.progression?.profile.implant };
  }, stashMove.defId);
  ok(persisted.n === stashMove.after + 1 && persisted.has, `stash survived a reload (${persisted.n} stacks, ${stashMove.defId} present)`);

  /* ── 3b. Phase 12: corner widgets hide during cutscenes; 시설 관리 hint is personal-ship only ── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (3b)');
  await page.evaluate(() => { const inv = window.__game.ctx.inventory; if (inv.isOpen) inv.toggleBag(); });
  await waitSim(0.4);
  const corner = () => page.evaluate(() => { const h = window.__game.getSystem('hud'); return { hint: h.isShipHintOn, community: h.isCommunityOn, ship: window.__game.ctx.hub?.ship, phase: window.__game.ctx.phase, blockers: [...window.__game.ctx.uiBlockers],
    hintDom: document.querySelector('.ship-hint').classList.contains('show'), cmDom: document.querySelector('.community').classList.contains('show') }; });
  let cw = await corner();
  ok(cw.hint && cw.community && cw.hintDom && cw.cmDom && cw.ship === 'personal', `personal ship: 시설 관리 hint + 커뮤니티 shown (${JSON.stringify(cw)})`);
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:docking', { stage: 'start', direction: 'dock' }));
  await waitSim(0.2);
  cw = await corner();
  ok(!cw.hint && !cw.community && !cw.hintDom && !cw.cmDom, 'hub:docking start → both corner buttons hidden for the cutscene');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:docking', { stage: 'end', direction: 'dock' }));
  await waitSim(0.2);
  cw = await corner();
  ok(cw.hint && cw.community, 'hub:docking end → both back');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:travel', { stage: 'start', planet: 'amber' }));
  await waitSim(0.2);
  cw = await corner();
  ok(!cw.hint && !cw.community, 'hub:travel start (warp, phase stays hub) → both hidden');
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:travel', { stage: 'end', planet: 'amber' }));
  await waitSim(0.2);
  cw = await corner();
  ok(cw.hint && cw.community, 'hub:travel end → both back');
  // shared ship (faked lobby, as smoke-training does): 커뮤니티 stays, the 시설 관리 hint does not exist there
  const fakedShared = await page.evaluate(() => {
    const net = window.__game.getSystem('net');
    if (!net || !('_lobby' in net)) return false;
    net._lobby = { code: 'HINT01', hostId: 'peer-a', isPublic: false, started: false, seed: null,
      players: [{ id: 'peer-a', name: '동료', slot: 0, ready: false, isHost: true, connected: true }] };
    window.__game.ctx.bus.emit('hub:enter', { ship: 'shared' });
    return true;
  });
  if (!fakedShared) console.log('  note NetSystem has no _lobby field — shared-ship hint check skipped');
  else {
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship (3b)');
    await waitSim(0.4);
    cw = await corner();
    ok(cw.ship === 'shared' && !cw.hint && !cw.hintDom && cw.community, `shared ship: no 시설 관리 hint, 커뮤니티 shown (${JSON.stringify({ hint: cw.hint, community: cw.community, blockers: cw.blockers })})`);

    /* ── 3c. B-6 (2026-09-11): a squad move the server made — shared ship A → B is one docking cutscene ──
       The relay's `lobby:left {reason:'moved', to}` + the new `lobby:state` are fed straight into the net system's
       message handler (the shared relay here runs older code). Then the old relay's plain `lobby:left` → `lobby:state`
       pair, which used to finish its undock into the personal ship with a lobby and never dock (measured before the fix). */
    const lobbyOf = (code, host) => ({ code, hostId: host, isPublic: false, started: false, seed: null,
      players: [{ id: host, name: code, slot: 0, ready: false, isHost: true, connected: true }] });
    const feedMove = (frames) => page.evaluate((fs) => {
      window.__dock = [];
      if (!window.__dockHooked) {
        window.__dockHooked = true;
        window.__game.ctx.bus.on('hub:docking', (e) => window.__dock.push(`${e.stage}:${e.direction}`));
      }
      const net = window.__game.getSystem('net');
      for (const f of fs) net.client.onMessage(f);
    }, frames);
    const hubState = () => page.evaluate(() => { const h = window.__game.getSystem('hub'); return { phase: window.__game.ctx.phase, ship: h.ship, cut: h.cutscene?.direction ?? null, lobby: window.__game.ctx.net.lobby?.code ?? null, dock: window.__dock.slice() }; });
    await page.evaluate((l) => { const net = window.__game.getSystem('net'); net._lobby = l; }, lobbyOf('MOVEAA', 'peer-a'));
    await feedMove([{ t: 'lobby:left', reason: 'moved', to: 'MOVEBB' }, { t: 'lobby:state', lobby: lobbyOf('MOVEBB', 'peer-b') }]);
    let mv = await hubState();
    /* 2026-09-15 (분대 · 도킹 매칭): being moved into a lobby someone else docked (accepting an invite) is not
       immediate but **countdown → fade → docking** (only a dock I pressed myself · `dockPending` is immediate).
       There is still no undock cutscene. */
    ok(mv.cut === null && mv.lobby === 'MOVEBB' && mv.dock.length === 0 && await page.evaluate(() => window.__game.getSystem('hub').squadDockSeconds > 0),
      `moved into a docked lobby: no undock, the squad-dock countdown runs first (${JSON.stringify(mv)})`);
    await waitFor(page, () => window.__game.getSystem('hub').cutscene?.direction === 'dock', 'moved → countdown → docking cutscene', 60000);
    mv = await hubState();
    ok(mv.dock.join(',') === 'start:dock', `moved: one docking cutscene after the countdown (${JSON.stringify(mv)})`);
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.getSystem('hub').ship === 'shared', 'moved → docked into the new shared ship', 120000);
    mv = await hubState();
    ok(mv.ship === 'shared' && mv.lobby === 'MOVEBB' && !mv.dock.includes('start:undock'), `moved: landed in shared ship MOVEBB after ONE docking cutscene (${JSON.stringify(mv.dock)})`);
    await feedMove([{ t: 'lobby:left' }, { t: 'lobby:state', lobby: lobbyOf('MOVECC', 'peer-c') }]);
    mv = await hubState();
    ok(mv.cut === 'dock' && mv.dock.join(',') === 'start:undock,start:dock',
      `old relay (plain lobby:left → lobby:state): the undock turns into a dock instead of stranding us (${JSON.stringify(mv)})`);
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.getSystem('hub').ship === 'shared', 'old-flow → docked', 120000);
    mv = await hubState();
    ok(mv.ship === 'shared' && mv.lobby === 'MOVECC', `old relay: ends in the shared ship of the new lobby, not the personal ship (${JSON.stringify(mv)})`);
    // a `moved` whose lobby:state never comes falls back to an ordinary leave (undock) after the hub's wait
    await feedMove([{ t: 'lobby:left', reason: 'moved', to: 'NEVER1' }]);
    mv = await hubState();
    ok(mv.cut === null && mv.ship === 'shared' && mv.dock.length === 0, `moved without its lobby:state: nothing happens at once (${JSON.stringify(mv)})`);
    await waitFor(page, () => window.__game.getSystem('hub').cutscene?.direction === 'undock' || window.__game.getSystem('hub').ship === 'personal', 'moved fallback → undock', 30000);
    ok(true, 'moved without its lobby:state: the hub gives up and undocks like an ordinary leave');

    await page.evaluate(() => { const net = window.__game.getSystem('net'); net._lobby = null; window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'personal', 'back to the personal ship (3b)');
    await waitSim(0.4);
    cw = await corner();
    ok(cw.hint && cw.community, 'back on the personal ship: hint returns');
  }

  /* ── 4. terminal: no scrollbars, no implant / repair tabs ─────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (2)');
  await waitSim(0.3);
  // Phase 8: Escape in the ship opens the PAUSE menu now, so the terminal is opened through its interactable.
  await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
  await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
  const term = await page.evaluate(() => {
    const f = document.querySelector('.menu.hub-menu .frame');
    return {
      sw: f.scrollWidth, cw: f.clientWidth, sh: f.scrollHeight, ch: f.clientHeight, ov: getComputedStyle(f).overflow, tabs: document.querySelectorAll('.hub-tab').length, panels: document.querySelectorAll('.imp-list, .rep-list').length,
      // 2026-09-15: the top tabs are the same two `.scr-tab` as the inventory Tab screen (행성 / 매칭)
      topTabs: [...document.querySelectorAll('.menu.hub-menu .hub-tabs .scr-tab')].map((b) => b.textContent),
    };
  });
  ok(term.sw <= term.cw && term.sh <= term.ch, `terminal frame has no scroll overflow (${term.sw}/${term.cw} × ${term.sh}/${term.ch})`);
  ok(term.tabs === 0 && term.panels === 0, 'terminal has no 임플란트 / 정비 tabs any more');
  ok(term.topTabs.join(',') === '행성,매칭', `terminal top tabs are 행성 / 매칭 (${term.topTabs.join(',')})`);
  /* 2026-09-07 (커서 rework): a cursor screen **releases** the pointer lock and the real OS cursor comes back,
     restyled by `ui/hud/GameCursor`. The virtual cursor, its sprite and the synthesised events are gone. */
  const termCursor = await page.evaluate(() => ({
    blocker: window.__game.ctx.uiBlockers.has('hub'),
    cursor: window.__game.ctx.input.isCursorMode,
    locked: window.__game.ctx.input.isPointerLocked,
    bodyMode: document.body.classList.contains('cursor-on'),
    bodyArt: document.body.classList.contains('cursor-ui'),
    sprite: document.querySelectorAll('.soft-cursor').length,
  }));
  ok(termCursor.blocker && termCursor.cursor === true, `terminal holds the 'hub' blocker and 커서 모드 (cursor ${termCursor.cursor})`);
  ok(!termCursor.locked, 'the terminal RELEASES the pointer lock — that is how the real cursor comes back');
  ok(termCursor.bodyMode && termCursor.bodyArt && termCursor.sprite === 0,
    'body.cursor-on / .cursor-ui are set and no cursor sprite exists any more', JSON.stringify(termCursor));
  // The generated art: one blanket rule plus a mirror of every `cursor: pointer/grab` rule the stylesheets declare.
  const art = await page.evaluate(() => {
    const style = document.getElementById('game-cursor-style');
    const txt = style ? style.textContent : '';
    const body = getComputedStyle(document.body).cursor;
    return {
      installed: !!style,
      blanket: /body\.cursor-ui \* \{ cursor: image-set\(url\(data:image\/png/.test(txt),
      mirrored: (txt.match(/body\.cursor-ui [^{*][^{]*\{ cursor: image-set/g) || []).length,
      onBody: body.startsWith('image-set') || body.startsWith('url'),
    };
  });
  ok(art.installed && art.blanket, 'the procedural cursor art is generated into a data: image and applied to everything', JSON.stringify(art));
  ok(art.mirrored > 10, `every stylesheet cursor affordance is mirrored onto the game art (${art.mirrored} selectors)`);
  // A click in cursor mode belongs to the UI: it must never reach the gameplay button set (which would fire the gun).
  const clickGate = await page.evaluate(() => {
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 500, clientY: 400 }));
    const seen = window.__game.ctx.input.wasMousePressed(0) || window.__game.ctx.input.isMouseDown(0);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    return seen;
  });
  ok(clickGate === false, 'a click while a screen owns the cursor never reaches gameplay input');
  await shot('07-terminal');
  await tap('KeyE');   // 2026-09-08: the terminal closes on E
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);
  const afterTerm = await page.evaluate(() => ({
    cursor: window.__game.ctx.input.isCursorMode,
    locked: window.__game.ctx.input.isPointerLocked,
    mode: document.body.classList.contains('cursor-on'),
  }));
  ok(afterTerm.cursor === false && afterTerm.mode === false, 'closing the terminal leaves 커서 모드');
  ok(afterTerm.locked, 'the pointer lock is back the moment the last cursor owner leaves (main.ts relock)');

  /* 2026-09-10: the Alt cursor was dropped — Alt makes neither a cursor nor a blocker, and the lock is untouched. */
  const alt = await page.evaluate(async () => {
    const key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    key('AltLeft', 'keydown'); key('AltLeft', 'keyup');
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    const menu = document.querySelector('.menu.pause');
    return {
      cursor: window.__game.ctx.input.isCursorMode,
      blockers: [...window.__game.ctx.uiBlockers],
      locked: window.__game.ctx.input.isPointerLocked,
      paused: !!menu && !menu.classList.contains('hidden'),
    };
  });
  ok(!alt.cursor && alt.blockers.length === 0 && alt.locked && !alt.paused, 'Alt no longer frees the mouse (no cursor mode, no blocker, lock kept, no pause)', JSON.stringify(alt));
  // The menu only closes on 게임으로 돌아가기 (in the browser) — a second Escape is inert on it.
  const pauseEsc = await page.evaluate(async () => {
    const key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    // an Escape on an empty stack opens the menu (the terminal was closed above).
    key('Escape', 'keydown'); key('Escape', 'keyup');
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    key('Escape', 'keydown'); key('Escape', 'keyup');
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    const menu = document.querySelector('.menu.pause');
    const still = !!menu && !menu.classList.contains('hidden');
    [...menu.querySelectorAll('.actions .ui-btn')][0].click();
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    return { still, closed: menu.classList.contains('hidden'), blocker: window.__game.ctx.uiBlockers.has('menu') };
  });
  ok(pauseEsc.still, 'a second Escape does NOT close the 일시정지 메뉴');
  ok(pauseEsc.closed && !pauseEsc.blocker, '게임으로 돌아가기 is what closes it', JSON.stringify(pauseEsc));

  /* 2026-09-08: an unlock we did not ask for **is** the Escape key — the browser eats the keydown to free the
     cursor, so `pointerlockchange` is the only evidence the player pressed it. `Input.onUserUnlock` → `main.ts` →
     `input:pointerLockLost` → the 일시정지 메뉴, in one press. A release *we* made (a screen taking cursor mode) is
     marked and must stay silent. */
  const lost = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const menu = document.querySelector('.menu.pause');
    const up = () => !!menu && !menu.classList.contains('hidden');
    ctx.input.requestPointerLock();
    window.__lockEl = document.getElementById('game-canvas');
    document.dispatchEvent(new Event('pointerlockchange'));
    // our own release: exitPointerLock() marks it, so no menu
    ctx.input.exitPointerLock();
    document.dispatchEvent(new Event('pointerlockchange'));
    for (let i = 0; i < 4; i++) window.__game.frame(performance.now() + i * 20);
    const afterSelf = up();
    /* 2026-09-09 (LOCK_BOUNCE_GRACE_MS): a lock just requested that bounces **straight back** is not the player but
       fullscreen Chrome · the desktop shell (the bug where closing housing mode with Tab raised the ESC menu). No
       menu opens — only a retry waiting for the next gesture is raised. */
    ctx.input.requestPointerLock();
    window.__lockEl = document.getElementById('game-canvas');
    document.dispatchEvent(new Event('pointerlockchange'));
    window.__lockEl = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    await new Promise((r) => setTimeout(r, 60));
    window.__game.frame(performance.now());
    const afterBounce = { paused: up(), retry: ctx.input.awaitingLockGesture };
    // the player's Escape: the same disappearance, but long after the request settled
    ctx.input.requestPointerLock();
    window.__lockEl = document.getElementById('game-canvas');
    document.dispatchEvent(new Event('pointerlockchange'));
    await new Promise((r) => setTimeout(r, 520));
    window.__lockEl = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    return {
      afterSelf, afterBounce, paused: up(),
      blocker: ctx.uiBlockers.has('menu'), phase: ctx.phase,
    };
  });
  ok(!lost.afterSelf, 'a release the game itself made (커서 모드) never opens the menu', JSON.stringify(lost));
  ok(!lost.afterBounce.paused && lost.afterBounce.retry,
    'a lock that bounces straight back out of our own request never opens the menu (2026-09-09)', JSON.stringify(lost.afterBounce));
  ok(lost.paused && lost.blocker, 'a lock the player took away opens the 일시정지 메뉴 in one press', JSON.stringify(lost));
  await page.evaluate(async () => {
    const menu = document.querySelector('.menu.pause');
    [...menu.querySelectorAll('.actions .ui-btn')][0].click();
    await new Promise((r) => setTimeout(r, 120));
    window.__game.frame(performance.now());
    window.__lockEl = document.getElementById('game-canvas');
    window.__game.ctx.input.requestPointerLock();
  });

  /* 2026-09-07: a denied pointer-lock request waits for the next real user gesture. Chrome grants no user activation
     for Escape and refuses a re-lock right after one, so closing the 일시정지 메뉴 with Escape used to leave the
     Windows cursor on screen and the lost-lock watchdog re-opened the menu forever. (Headless: the stubbed
     `requestPointerLock` resolves but never sets `pointerLockElement`, which is exactly the denied case.) */
  const relock = await page.evaluate(async () => {
    const input = window.__game.ctx.input;
    const key = (code, type) => { window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true })); };
    // this script fakes `pointerLockElement` over the canvas — drop it for the length of the check
    const faked = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => null, configurable: true });
    // 2026-09-10: the block above ended with locks the player "took away", and `Input` now holds every request for
    // `LOCK_USER_EXIT_COOLDOWN_MS` after such an exit (Chromium refuses them anyway). Wait it out so the request
    // below really reaches the stub and is really denied — which is what this check is about.
    await new Promise((r) => setTimeout(r, 1500));
    input.exitPointerLock();
    input.requestPointerLock();
    await new Promise((r) => setTimeout(r, 400));
    const armed = input.awaitingLockGesture;
    key('Escape', 'keydown'); key('Escape', 'keyup'); input.consume('Escape');
    const afterEsc = input.awaitingLockGesture;
    const at = input.lastLockRequest;
    // 2026-09-10: …and a request within `LOCK_ESCAPE_DEFER_MS` of an Escape is held too, so the retry the next key
    // triggers lands a moment later instead of in the same tick (the whole point: asking *during* the Escape is
    // what made Chromium hand the lock over and take it straight back).
    await new Promise((r) => setTimeout(r, 250));
    key('KeyJ', 'keydown'); key('KeyJ', 'keyup'); input.consume('KeyJ');
    await new Promise((r) => setTimeout(r, 120));
    const retried = input.lastLockRequest !== at;
    input.exitPointerLock();
    /* 2026-09-10: and a request made while Escape is being handled **never goes out to the browser**. */
    input.exitPointerLock();
    key('Escape', 'keydown');
    const atEsc = input.lastLockRequest;
    input.requestPointerLock();
    const deferredByEsc = input.lastLockRequest === atEsc && input.relockScheduled;
    key('Escape', 'keyup'); input.consume('Escape');
    const out = { armed, afterEsc, retried, deferredByEsc, disarmed: input.awaitingLockGesture };
    Object.defineProperty(Document.prototype, 'pointerLockElement', faked);
    return out;
  });
  ok(relock.armed, 'a denied pointer-lock request arms the gesture retry');
  ok(relock.afterEsc, 'Escape never counts as the gesture (Chrome grants it no user activation)');
  ok(relock.retried && !relock.disarmed, 'any other key retries the lock and disarms the wait', JSON.stringify(relock));
  ok(relock.deferredByEsc, 'Escape 직후의 재요청은 미뤄진다 (Chromium 이 그 락을 곧바로 도로 가져간다)', JSON.stringify(relock));

  /* 2026-09-07: taking the camera back with a left click — a click on the 3D canvas while the camera wants the
     lock but does not have it re-requests it **and is swallowed**, so the recapture click never fires the weapon. */
  const clickBack = await page.evaluate(async () => {
    const input = window.__game.ctx.input;
    const faked = Object.getOwnPropertyDescriptor(Document.prototype, 'pointerLockElement');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => null, configurable: true });
    input.exitPointerLock();
    input.requestPointerLock();                    // the camera wants it; the stub never grants it here
    await new Promise((r) => setTimeout(r, 60));
    const at = input.lastLockRequest;
    const canvas = document.getElementById('game-canvas');
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    const swallowed = !input.isMouseDown(0) && !input.wasMousePressed(0);
    // 2026-09-10: the click still asks for the lock, but `Input` sends **one** request at a time — the one from
    // 60 ms ago has not been answered yet, so this one is held and goes out from `endFrame` as soon as that
    // window (`LOCK_RESULT_CHECK_MS`) passes. Duplicate requests in the same breath are what Chromium's
    // "Too many pointer lock requests in a short window of time" counts.
    await new Promise((r) => setTimeout(r, 400));
    const out = { retried: input.lastLockRequest !== at, swallowed };
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    input.exitPointerLock();
    Object.defineProperty(Document.prototype, 'pointerLockElement', faked);
    return out;
  });
  ok(clickBack.retried, '좌클릭이 잃어버린 포인터 락을 다시 요청한다 (한 번에 하나씩)', JSON.stringify(clickBack));
  ok(clickBack.swallowed, 'and that recapture click is swallowed (no shot behind it)', JSON.stringify(clickBack));

  /* ── 5. mission A: 배리어 wielded → weapon key stows it (2026-09-15: was the retired 대전차포) ─── */
  const startMission = async (seed) => {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.world?.ready === true, 'world ready');
    await waitFor(page, () => window.__game.ctx.isGameplayPhase(), 'gameplay phase');
    await waitFor(page, () => window.__game.ctx.player?.isDropping === false, 'drop-in finished', 90000);
    await waitSim(1.0);
  };
  const backToShip = async () => {
    await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await waitSim(0.3);
  };
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('barrier'));
  // 2026-09-10: the secondary weapon (slot 3) is gone, so "a weapon key stows the implant" is checked on 주무기 II.
  // The 돌격소총 from the stash goes into 주무기 II to make two guns (the starter only gives a 기관단총 in 주무기 I).
  const secondGun = await page.evaluate(() => {
    const inv = window.__game.ctx.inventory, sys = window.__game.getSystem('inventory');
    const it = sys.getStashItems().find((x) => x.defId === 'wpn_ar') ?? sys.getStashItems().find((x) => x.defId === 'wpn_sg');
    if (it) inv.equip(it.uid, 'primary2');
    return inv.getLoadout().primary2?.defId ?? null;
  });
  ok(!!secondGun, `주무기 II 에 두 번째 총을 올렸다 (${secondGun})`);
  await startMission(42);
  /* 2026-09-10: the implant display is not `.implant-gauge` left of the crosshair but `.imp-hud` at the
     **bottom centre** of the screen. */
  ok(await page.evaluate(() => !!document.querySelector('.imp-hud') && !document.querySelector('.imp-hud').hidden && document.querySelector('.imp-hud').dataset.implant === 'barrier'), 'implant hud shown for 배리어');
  const gaugePos = await page.evaluate(() => { const r = document.querySelector('.imp-hud').getBoundingClientRect(); return { cx: r.left + r.width / 2, mid: innerWidth / 2, top: r.top, cy: innerHeight / 2 }; });
  ok(Math.abs(gaugePos.cx - gaugePos.mid) < 40 && gaugePos.top > gaugePos.cy, 'implant hud sits bottom-centre (under the crosshair, below the stamina bar)', JSON.stringify(gaugePos));
  await tap('KeyQ');
  await waitSim(0.2);
  ok(await page.evaluate(() => window.__game.ctx.implants.wielded && window.__game.ctx.implants.blocksWeapons), 'Q wields the shield (weapons holstered)');
  await tap('Digit2');
  await waitSim(0.3);
  const stowed = await page.evaluate(() => ({ wielded: window.__game.ctx.implants.wielded, swaps: window.__ev['weapon:swapStarted'].length }));
  ok(!stowed.wielded, 'pressing 2 stowed the shield (the old bug: keys were ignored while wielded)');
  ok(stowed.swaps >= 1 && (await ev('weapon:swapStarted')).some((s) => s.slot === 'primary2'), 'and drew 주무기 II');
  await shot('08-gauge-barrier');

  /* ── 6. mission B: 오버차지 = hold Q, energy drains / refills ───────── */
  await backToShip();
  ok(await page.evaluate(() => window.__game.ctx.implants.setEquipped('overcharge')), 'overcharge equipped in the ship');
  await startMission(43);
  const e0 = await page.evaluate(() => ({ e: window.__game.ctx.implants.energy, max: window.__game.ctx.implants.energyMax, hp: window.__game.ctx.player.hp }));
  ok(e0.max > 0 && e0.e === e0.max, `overcharge starts with full energy (${e0.e}/${e0.max})`);
  await page.evaluate(() => window.__game.ctx.player.takeDamage(40));
  await keyDown('KeyQ');
  await waitSim(1.5);
  const held = await page.evaluate(() => ({ holding: window.__game.ctx.implants.holding, e: window.__game.ctx.implants.energy, hp: window.__game.ctx.player.hp, wielded: window.__game.ctx.implants.wielded, gaugeHold: document.querySelector('.imp-hud').classList.contains('holding') }));
  ok(held.holding && !held.wielded, 'holding Q channels without holstering the gun');
  ok(held.e < e0.max - 1, `energy drained while held (${held.e.toFixed(2)})`);
  ok(held.hp > 60.5, `self heal ticked (hp 60 → ${held.hp.toFixed(1)})`);
  ok(held.gaugeHold, 'implant hud shows the holding state');
  await shot('09-gauge-overcharge');
  await keyUp('KeyQ');
  // the screenshot above took wall time while Q was still down; sample right after the release, then let it refill
  const eRelease = await page.evaluate(() => window.__game.ctx.implants.energy);
  await waitSim(1.0);
  const released = await page.evaluate(() => ({ holding: window.__game.ctx.implants.holding, e: window.__game.ctx.implants.energy, n: window.__ev['implant:energyChanged'].length }));
  ok(!released.holding && released.e > eRelease + 0.2, `released: channel stopped, energy refilling (${eRelease.toFixed(2)} → ${released.e.toFixed(2)})`);
  ok(released.n >= 3, `implant:energyChanged emitted (${released.n})`);

  /* ── 7. mission C: 대시 = three segments, one refilling ───────────── */
  await backToShip();
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('dash'));
  await startMission(44);
  /*
   * 2026-09-10: charges are no longer three cells (`.seg`) but one **number at the bottom right inside the
   * thumbnail** (`.ib-ch`). Full is drawn plainly (no `accent` · `dim`); spend even one and the accent colour
   * fills in from below (`accent`).
   */
  const dash0 = await page.evaluate(() => { const h = document.querySelector('.imp-hud'); return { ch: h.querySelector('.ib-ch').textContent, accent: h.classList.contains('accent'), dim: h.classList.contains('dim'), charges: window.__game.ctx.implants.charges }; });
  ok(dash0.ch === '3' && dash0.charges === 3 && !dash0.accent && !dash0.dim, `dash hud: 충전 3/3, 평범 표기 (${dash0.ch})`, JSON.stringify(dash0));
  await tap('KeyQ');
  await waitSim(0.6);
  const dash1 = await page.evaluate(() => { const h = document.querySelector('.imp-hud'); return { ch: h.querySelector('.ib-ch').textContent, accent: h.classList.contains('accent'), dim: h.classList.contains('dim'), charges: window.__game.ctx.implants.charges }; });
  ok(dash1.charges === 2 && dash1.ch === '2' && dash1.accent && !dash1.dim, `after a dash: 충전 2, 강조색이 차오름 (charges ${dash1.charges})`, JSON.stringify(dash1));
  await shot('10-gauge-dash');

  /* ── 8. grapple: instant Q, target bracket ────────────────────────── */
  await backToShip();
  await page.evaluate(() => window.__game.ctx.implants.setEquipped('grapple'));
  await startMission(45);
  // look slightly down so the aim ray hits terrain within range
  await page.evaluate(() => { const p = window.__game.ctx.player; if (typeof p.addRecoil === 'function') p.addRecoil(-0.45, 0); });
  await waitSim(0.25);
  const gtarget = await page.evaluate(() => { const a = window.__ev['implant:grappleTargetChanged']; return { last: a[a.length - 1], hook: !document.querySelector('.reticle .hook').hidden, wielded: window.__game.ctx.implants.wielded }; });
  ok(gtarget.last?.valid === true && gtarget.hook && !gtarget.wielded, `grapple target valid without wielding (${gtarget.last?.distance?.toFixed(1)} m), bracket shown`);
  await tap('KeyQ');
  await waitSim(0.3);
  ok((await ev('implant:activated')).some((a) => a.id === 'grapple'), 'Q fired the grapple instantly');

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
