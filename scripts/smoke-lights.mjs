// 2026-09-10 — watching the scene's light count. three.js skips an invisible branch whole in `projectObject`, so
// a hidden group · a light outside the scene is not counted. If that number changes **while playing**, every
// material in the scene recompiles its shader on that frame — one whole frame stalls (what the 2026-09-10 「ship
// arrival hitch」 really was).
//
// This script runs a session from start to finish, counts on every frame, and **fails the moment the number changes
// even once**. (Second pass, 2026-09-10) load boundaries (building the hub · starting a mission) used to be allowed,
// but `core/LightBudget` now pins the count for the whole session with padding lights, so a boundary is no exception
// either — those boundaries were exactly where docking · the drop stalled for seconds in multiplayer.
// It runs the ship ↔ the docking cutscene ↔ the shared ship · the hangar ↔ a planet, and the squadmate pod drops.
// It also looks at whether the real lights stay inside the budget.
// Caught in this net so far: the extraction ship · the flare · the hellpod · the squad-leader device · remote pods ·
// the ship interior (6).
//
// Usage: node scripts/smoke-lights.mjs [http://localhost:5273]   (needs a running vite)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
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
const ok = (c, l, x = '') => { if (c) { pass++; console.log(`  ok   ${l}`); } else { fail++; console.log(`  FAIL ${l} ${x}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  // C-44 (2026-09-11): publishing the stored display settings once at boot (`SettingsMenu.bind` →
  // `ui:displayChanged`) is not a user action — it used to set `perfChecked`, so the automatic bloom-off (the perf
  // guard) never ran at all.
  const boot = await page.evaluate(() => ({ perfChecked: window.__game.perfChecked, bloom: window.__game.isPostProcessing, t: window.__game.ctx.time }));
  ok(boot.perfChecked === false || !boot.bloom, `부팅 설정 발행이 perf guard 를 끄지 않는다 (perfChecked ${boot.perfChecked}, t ${boot.t.toFixed(1)} s)`);
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__mark = 'boot';
    window.__log = [];
    // exactly what `WebGLRenderer.projectObject` would collect
    window.__count = () => { let n = 0; window.__game.ctx.scene.traverseVisible((o) => { if (o.isLight && !o.isAmbientLight) n++; }); return n; };
    // 2026-09-10 second pass: the moment to count is **the moment of drawing** (`scene.onBeforeRender` — right
    // before three.js gathers the lights). Counting on a timer also catches the gap between a transition (docking
    // starting inside a network message handler, say) and the next frame topping the padding lights back up — a gap
    // in which nothing is drawn at all — and then fails on a number no shader ever saw.
    let prev = -1;
    const scene = window.__game.ctx.scene;
    const prevHook = scene.onBeforeRender;
    scene.onBeforeRender = function (...args) {
      const n = window.__count();
      if (n !== prev) { window.__log.push({ mark: window.__mark, phase: window.__game.ctx.phase, from: prev, to: n }); prev = n; }
      return prevHook.apply(this, args);
    };
    window.__ev = { landed: 0 };
    window.__game.ctx.bus.on('extraction:shipLanded', () => window.__ev.landed++);
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const mark = (m) => P((m) => { window.__mark = m; }, m);
  const waitSim = async (s) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${s}s`, 180000, t0 + s); };

  // The real point lights (padding aside) have to stay inside `SCENE_POINT_LIGHT_BUDGET` for the padding to be
  // able to hold the count
  const budgetOk = async (label) => {
    const b = await P(() => {
      const L = window.__game.lights;
      return L ? { content: L.contentCount(), budget: L.budget, pads: L.padsShown } : null;
    });
    ok(!!b && b.content <= b.budget, `${label}: 진짜 점광원이 예산 안이다 (${b && b.content} ≤ ${b && b.budget}, 여분 ${b && b.pads})`, JSON.stringify(b));
  };

  console.log('세션 한 바퀴를 돌면서 씬의 광원 개수를 감시한다');
  await mark('hub');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitSim(1.0);
  await budgetOk('개인 함선');

  // Docking → the shared ship · the hangar → undocking. It needs a relay (the `npm run verify` runner starts one)
  const online = await waitFor(page, () => window.__game.ctx.net?.connected, 'relay', 10000).then(() => true, () => false);
  if (!online) {
    console.log('  skip 도킹 구간 (릴레이 없음 — 단독 실행)');
  } else {
    await mark('docking');
    await P(() => window.__game.ctx.net.createLobby());
    await waitFor(page, () => window.__game.ctx.phase === 'docking', 'docking', 15000);
    await waitFor(page, () => !!window.__game.getSystem('hub').pendingInterior, 'prebuilt ship', 10000).catch(() => null);
    ok(await P(() => !!window.__game.getSystem('hub').pendingInterior), '도킹 컷씬 도중에 도착할 함선을 미리 짓는다 (pendingInterior)');
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship', 30000);
    ok(await P(() => window.__game.getSystem('hub').pendingInterior === null), '도착하면 미리 지은 함선을 쓰고 비운다');
    await waitSim(1.0);
    await budgetOk('공유 함선');
    await mark('격납고');
    await P(() => { const c = window.__game.ctx; const V = c.player.position.constructor; c.player.teleport(new V(0, 0, 20), Math.PI, true); });
    await waitSim(1.5);
    const zone = await P(() => {
      const pool = window.__game.getSystem('hub').interior.lights;
      return pool.assignment.map((i) => (i >= 0 ? pool.fixtureList[i].zone : null));
    });
    ok(zone.length > 0 && zone.every((z) => z === 1), `격납고에 서면 풀 광원이 전부 격납고 자리에 걸린다 ${JSON.stringify(zone)}`);
    await mark('undock');
    await P(() => window.__game.ctx.net.leaveLobby());
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'personal', 'undock', 30000);
    await waitSim(1.0);
  }

  await mark('mission-start');
  await P(() => { const c = window.__game.ctx; c.missionMode = 'raid'; c.bus.emit('game:newMission', { seed: 77 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  ok(await P(() => window.__game.shaders && window.__game.shaders.holding === false), '강하 셰이더 hold 가 풀렸다');
  await mark('playing');
  await waitSim(3.0);
  await budgetOk('레이드');

  /* ── Display setting toggles (2026-09-11, C-44) ───────────────────────────────────────────────────────
     Bloom changes the render target (the composer ↔ the canvas) and shadows change the program key's
     `shadowMapEnabled`, so both recompile every lit material once. It holds through `holdForScene()` **only when a
     value really changes**, and does nothing when the same value arrives again (boot · fullscreen · resolution). No
     new program appearing over the few frames after the hold is released is what 「the recompile finished inside the
     hold」 means. timeScale is kept at 0 meanwhile so that no spawn cuts in. */
  await mark('화면 설정 토글');
  const disp0 = await P(() => ({ bloom: window.__game.isPostProcessing, shadows: window.__game.hasShadows, holding: window.__game.shaders.holding }));
  await P(() => { window.__game.ctx.timeScale = 0; });
  const emitDisplay = (d) => P((d) => {
    const e = window.__game;
    e.ctx.bus.emit('ui:displayChanged', { fullscreen: false, bloom: d.bloom, shadows: d.shadows, scale: 1 });
    return { holding: e.shaders.holding, bloom: e.isPostProcessing, shadows: e.hasShadows };
  }, d);
  const settle = async (label) => {
    await waitFor(page, () => window.__game.shaders.holding === false, `${label} hold released`, 30000);
    const n0 = await P(() => window.__game.renderer.info.programs.length);
    await waitSim(0.25);
    const n1 = await P(() => window.__game.renderer.info.programs.length);
    ok(n0 === n1, `${label}: 재컴파일이 hold 안에서 끝났다 (hold 뒤 프로그램 ${n0} → ${n1})`);
  };
  const same = await emitDisplay(disp0);
  ok(disp0.holding === false && same.holding === false, '같은 화면 설정이 다시 와도(부팅 · 전체화면 · 해상도) hold 하지 않는다', JSON.stringify({ disp0, same }));
  const sh = await emitDisplay({ bloom: disp0.bloom, shadows: !disp0.shadows });
  ok(sh.holding === true && sh.shadows === !disp0.shadows, `그림자 ${disp0.shadows ? '끄기' : '켜기'} → 그 순간부터 hold`, JSON.stringify(sh));
  await settle('그림자 토글');
  const bl = await emitDisplay({ bloom: !disp0.bloom, shadows: !disp0.shadows });
  ok(bl.holding === true && bl.bloom === !disp0.bloom, `블룸 ${disp0.bloom ? '끄기' : '켜기'} → 그 순간부터 hold`, JSON.stringify(bl));
  await settle('블룸 토글');
  const back = await emitDisplay(disp0);
  ok(back.holding === true && back.bloom === disp0.bloom && back.shadows === disp0.shadows, '원래 값으로 되돌려도 hold', JSON.stringify(back));
  await settle('되돌리기');
  ok(await P(() => window.__game.perfChecked === true), '플레이어가 블룸을 직접 바꾸면 perf guard 는 물러난다 (perfChecked)');

  /* ── The settings screen knows the bloom the perf guard turned off (2026-09-11, C-58) ────────────────
     The guard needs the first 90 s · 240 slow frames, so it never fires by itself in a smoke → the same path is run
     through `debugForcePerfGuard()`. The settings row leaves the stored value (on) alone and shows
     `꺼짐 (성능 자동)`, the toast comes once, the settings' other re-publishes (fullscreen · shadows · resolution =
     `emitDisplay`) do not turn bloom back on, and one press of the row by the player does. Once per boot. */
  if (disp0.bloom) {
    await mark('perf guard 자동 블룸 끄기 (C-58)');
    const g = await P(() => {
      const e = window.__game, s = e.getSystem('hud').settings;
      window.__c58 = { auto: [], notify: [], disp: [] };
      e.ctx.bus.on('render:autoAdjusted', (p) => window.__c58.auto.push(p));
      e.ctx.bus.on('ui:notify', (p) => window.__c58.notify.push(p.text));
      e.ctx.bus.on('ui:displayChanged', (p) => window.__c58.disp.push(p.bloom));
      const fired = e.debugForcePerfGuard();
      return {
        fired, bloom: e.isPostProcessing, holding: e.shaders.holding, auto: window.__c58.auto.slice(),
        autoOff: s.isBloomAutoOff, pill: s.bloomRow.textContent, stored: s.displaySettings.bloom,
        toast: s.bloomAutoOffToast, notify: window.__c58.notify.slice(),
      };
    });
    ok(g.fired && !g.bloom && g.holding, 'guard 가 블룸을 끈다 → 그 순간부터 hold', JSON.stringify(g));
    ok(g.auto.length === 1 && g.auto[0].bloom === false && g.auto[0].reason === 'perf', 'render:autoAdjusted {bloom:false, reason:perf} 1회', JSON.stringify(g.auto));
    ok(g.autoOff && /성능 자동/.test(g.pill) && g.stored === true, `설정 행 = "${g.pill}", 저장값은 켬 그대로`, JSON.stringify(g));
    ok(g.toast === 'shown' && g.notify.filter((t) => /블룸/.test(t)).length === 1, '토스트 1회 (레이드 HUD 가 떠 있으니 곧바로)', JSON.stringify(g.notify));
    await settle('자동 블룸 끄기');
    const re = await P(() => {
      const e = window.__game, s = e.getSystem('hud').settings;
      s.emitDisplay();   // exactly the publish a fullscreen · shadow · resolution change and the boot restore make
      return { bloom: e.isPostProcessing, holding: e.shaders.holding, sent: window.__c58.disp.slice(), autoOff: s.isBloomAutoOff };
    });
    ok(!re.bloom && !re.holding && re.autoOff && re.sent.at(-1) === false, '설정의 다른 재발행은 guard 가 끈 블룸을 되켜지 않는다 (발행 bloom=false)', JSON.stringify(re));
    const on = await P(() => {
      const e = window.__game, s = e.getSystem('hud').settings;
      s.bloomRow.click();   // the player presses the row (꺼짐 → 켜기)
      return { bloom: e.isPostProcessing, holding: e.shaders.holding, autoOff: s.isBloomAutoOff, pill: s.bloomRow.textContent, stored: s.displaySettings.bloom };
    });
    ok(on.bloom && on.holding && !on.autoOff && on.pill === '켬' && on.stored === true, '행을 한 번 누르면 블룸이 켜지고 표시는 평소대로', JSON.stringify(on));
    await settle('블룸 되켜기');
    const again = await P(() => {
      const e = window.__game;
      return { fired: e.debugForcePerfGuard(), bloom: e.isPostProcessing, auto: window.__c58.auto.length, notify: window.__c58.notify.filter((t) => /블룸/.test(t)).length };
    });
    ok(!again.fired && again.bloom && again.auto === 1 && again.notify === 1, '부팅당 1회 — 다시 불러도 끄지 않는다', JSON.stringify(again));
  } else {
    console.log('  skip C-58 (이 브라우저의 블룸이 처음부터 꺼져 있다)');
  }
  await P(() => { window.__game.ctx.timeScale = 1; });

  // The squad-leader device's light has to be planted in the scene in advance, not inside the device
  // (`game/parts/Leader`)
  const led = await P(() => {
    const l = window.__game.ctx.scene.getObjectByName('LeaderDeviceLight');
    return l ? { found: true, intensity: l.intensity } : { found: false };
  });
  ok(led.found && led.intensity === 0, '분대장 기기 광원이 init 때 씬에 심겨 있다 (intensity 0)', JSON.stringify(led));

  // Squadmate pods: a `new Hellpod()` used to enter the scene for every squadmate dropping for the first time
  // and recompile everything (measured 2.7 · 3.1 s)
  await mark('분대원 포드 강하 (새 peer 둘)');
  const podCount = await P(() => {
    const pods = window.__game.getSystem('remotePlayers')?.pods;
    if (!pods) return null;
    const c = window.__game.ctx; const p = c.player.position.clone(); p.x += 10;
    pods.drop(c, 'smoke-peer-1', p, 0, 1);
    p.z += 6;
    pods.drop(c, 'smoke-peer-2', p, 0, 1);
    return pods.count;
  });
  ok(podCount === 2, `분대원 포드 둘이 배정된다 (count ${podCount})`);
  await waitSim(4.0);

  // A rejoin restore → `hellpod.hide()`, then a rescue drop → `hellpod.start()`.
  // Before the fix these two dropped the light count by 1 and raised it by 1 again (= two full shader recompiles).
  await mark('rejoin restoreState (hellpod.hide)');
  await P(() => {
    const c = window.__game.ctx;
    c.player.restoreState({ hp: 80, state: 'alive', position: c.player.position.clone(), yaw: 0 });
  });
  await waitSim(1.5);
  await mark('rescue drop (hellpod.start)');
  await P(() => { const c = window.__game.ctx; const p = c.player.position.clone(); p.x += 6; c.bus.emit('player:respawn', { position: p }); });
  await waitSim(6.0);

  await mark('extraction: 신호탄');
  await P(() => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getExtractionPoints();
    ctx.player.teleport(pts[0].position.clone());
    ctx.interactables.all().find((i) => i.id.startsWith('extract_')).interact();
  });
  await waitSim(0.6);
  await mark('extraction: 함선 접근');
  await P(() => { window.__game.getSystem('extraction').countdown = 12.5; });
  await waitFor(page, () => window.__ev.landed > 0, 'shipLanded', 60000);
  await mark('extraction: 착륙');
  await waitSim(2.0);
  await mark('extraction: 이륙');
  await P(() => {
    const sys = window.__game.getSystem('extraction'), ctx = window.__game.ctx;
    const p = new (sys.ship.root.position.constructor)(0, 0, -2.5).applyMatrix4(sys.ship.root.matrixWorld);
    ctx.player.teleport(p, undefined, false);
  });
  await waitSim(0.6);
  await P(() => window.__game.getSystem('extraction').liftoff());
  await waitSim(5.0);
  await mark('done');
  await waitSim(1.0);

  const log = await P(() => window.__log);
  console.log('  광원 개수가 바뀐 지점:');
  for (const e of log) console.log(`    ${String(e.from).padStart(3)} → ${String(e.to).padStart(3)}   [${e.phase}] ${e.mark}`);
  // Allowed: the first tally (-1) alone. A load boundary is no exception either (2026-09-10 second pass —
  // `core/LightBudget`).
  const bad = log.filter((e) => e.from >= 0);
  ok(bad.length === 0, '세션 내내 씬의 광원 개수가 한 번도 바뀌지 않는다 (함선 · 도킹 · 행성 · 포드 포함)',
    bad.map((e) => `${e.from}→${e.to} @ ${e.mark}`).join(' | '));
  ok(log.length >= 1, '감시 자체가 돌았다 (첫 집계가 잡힌다)', JSON.stringify(log.length));

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
