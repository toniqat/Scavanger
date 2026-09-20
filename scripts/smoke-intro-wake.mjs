// Smoke (2026-09-14): the character confirm popup → the tutorial opening (the intro wake).
//
// It runs one **real flow**: open the character creation window on an empty slot → roll the stats → `확정` → check the
// summary card → one click creates nothing → a 1 s hold on `만들기` → `location.reload()` → the auto-start enters the
// tutorial raid → measure during the intro wake and after it.
//
//   ① The confirm popup: no 「정말로 만들겠습니까?」 line · the body line hidden · five stat bars = value / CREATE_STAT_MAX ·
//      a still face thumbnail (data:image, when a preview GL context exists) · the hold hint ·
//      one click does not run it · the progress while the hold is held.
//   ② The black fade **really passes a middle value** — not a CSS transition but the value `HudSystem` painted
//      (`screenFadeShown`). On a PC like this one, where the OS turns animation effects off, a CSS transition
//      is clipped to 0.01 ms and ended in a single frame (that was 「페이드가 안 된다」).
//   ③ The wake **ends** — `player:introWakeDone` · the tutorial leaves `wake` · the override is released. An old
//      bug: on the frame the timer crossed below zero, `endIntroWake` read it as 「no wake is running」 and returned,
//      so the camera stayed at the side seat forever.
//   ④ The camera hand-back is **continuous** — the side camera is far from the back view, and the last wake frame
//      and the first ordinary frame sit right next to each other.
//   ⑤ During the wake the compass opacity is 0 and Tab does not open the bag → once it ends the compass passes
//      between 0 and 1 and reaches 1, and Tab opens it.
//      2026-09-16: the crosshair (`.hud.gameplay .reticle`) is the same — 0 for every wake frame, then through a
//      middle value to 1 once it ends (`TUTORIAL_RETICLE_FADE_S`).
//   ⑥ Throughout the tutorial raid there is no clock top left and no extraction timer top centre (`display: none`).
//
// Usage: node scripts/smoke-intro-wake.mjs [http://localhost:5273/] [shotDir]   (needs `npm run dev`)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SHOTS = process.argv[3] ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,760', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // The storage is cleared **only the first time** — the reload after the character is made has to enter with
    // that character.
    try { if (!sessionStorage.getItem('__introWakeSmoke')) { localStorage.clear(); sessionStorage.setItem('__introWakeSmoke', '1'); } } catch { /* ignore */ }
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  const boot = async () => {
    await waitFor(page, () => !!window.__game?.ctx?.player && !!window.__game.ctx.tutorial && !!window.__game.getSystem('hud'), 'boot');
    await page.evaluate(() => {
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    });
  };

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await boot();

  /* ── ① The confirm popup ─────────────────────────────────────────────── */
  console.log('① 캐릭터 확정 팝업');
  const pop = await page.evaluate(async () => {
    const hud = window.__game.getSystem('hud');
    const title = hud.title;
    title.openCreate(1);
    const cc = title.create;
    await new Promise((r) => setTimeout(r, 700));      // let the preview draw a few frames
    cc.rollStats();
    cc.askConfirm();
    const ask = cc.ask;
    const root = ask.root;
    const stats = [...root.querySelectorAll('.cc-cf-stat')].map((s) => ({
      v: Number(s.querySelector('.v')?.textContent), sx: s.querySelector('.bar i')?.style.transform ?? '',
      row: s.getBoundingClientRect().top,
    }));
    const img = root.querySelector('.cc-cf-face img');
    return {
      open: ask.isOpen, bodyHidden: root.querySelector('.tm-ask-body').hidden, text: root.textContent,
      stats, hasPreview: cc.hasPreview, faceSrc: img ? img.getAttribute('src').slice(0, 22) : null,
      faceBox: img ? (() => { const b = img.parentElement.getBoundingClientRect(); return [b.width, b.height]; })() : null,
      holdCap: !!root.querySelector('.tm-ask-foot .ui-btn .keycap.kc-btn'), max: 5,
    };
  });
  ok(pop.open, '확정 팝업이 열린다');
  ok(!pop.text.includes('정말로'), '「정말로 만들겠습니까?」 줄이 없다');
  ok(pop.bodyHidden, '글 본문 줄은 숨는다 (요약은 카드)');
  ok(pop.stats.length === 5, '능력치 다섯 칸', `(${pop.stats.length})`);
  // 2026-09-15 2nd pass (user's decision): five columns across → **five rows down** (name · gauge · value per row)
  ok(new Set(pop.stats.map((s) => Math.round(s.row))).size === 5, '다섯 칸이 세로 다섯 줄', JSON.stringify(pop.stats.map((s) => Math.round(s.row))));
  // The browser normalises `scaleX(0.2000)` to `scaleX(0.2)` before giving it back, so the comparison is numeric
  const scaleOf = (sx) => Number(/scaleX\(([-\d.]+)\)/.exec(sx)?.[1] ?? NaN);
  ok(pop.stats.every((s) => Math.abs(scaleOf(s.sx) - Math.max(0, Math.min(1, s.v / pop.max))) < 1e-3), '게이지 = 값 / 5', JSON.stringify(pop.stats.map((s) => [s.v, s.sx])));
  if (pop.hasPreview) {
    ok(pop.faceSrc?.startsWith('data:image/png'), '얼굴 정지 썸네일(data:image)', `(${pop.faceSrc})`);
    ok(pop.faceBox && Math.abs(pop.faceBox[0] - pop.faceBox[1]) < 2, '썸네일은 정사각형', JSON.stringify(pop.faceBox));
  } else console.log('  skip 얼굴 썸네일 (미리보기 GL 없음)');
  // 2026-09-15 2nd pass: instead of a 「1초 동안 누르고 있어야」 hint line, **the left-click hold keycap inside the
  // button** (`.keycap.kc-btn`) says it
  ok(pop.holdCap, '만들기 버튼 안에 좌클릭 홀드 키캡');
  await shot(page, 'confirm-popup');

  const click = await page.evaluate(() => {
    const cc = window.__game.getSystem('hud').title.create;
    const btn = cc.ask.root.querySelector('.tm-ask-foot .ui-btn.primary');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { open: cc.ask.isOpen, created: !!localStorage.getItem('scav.s1.profile') };
  });
  ok(click.open && !click.created, '클릭 한 번으로는 만들지 않는다');

  const holdMid = await page.evaluate(async () => {
    const cc = window.__game.getSystem('hud').title.create;
    const btn = cc.ask.root.querySelector('.tm-ask-foot .ui-btn.primary');
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    return { p: cc.ask.holdProgress, open: cc.ask.isOpen };
  });
  ok(holdMid.open && holdMid.p > 0.1 && holdMid.p < 0.9, '홀드 도중 진행도가 찬다', `(${holdMid.p?.toFixed?.(2)})`);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
  ok(true, '홀드가 끝나면 캐릭터를 만들고 새로고침한다');

  /* ── ②–⑥ The tutorial opening ────────────────────────────────────────── */
  await boot();
  await page.evaluate(() => {
    const g = window.__game, ctx = g.ctx, hud = g.getSystem('hud'), pl = g.getSystem('player');
    const w = window.__wk = { frames: [], done: null };
    ctx.bus.on('player:introWakeDone', () => { w.done = ctx.time; });
    const compass = document.querySelector('.compass');
    const reticle = document.querySelector('.hud.gameplay .reticle');
    (function tick() {
      const c = ctx.camera.position, r = pl.rig?.position;
      w.frames.push({
        t: ctx.time, waking: !!ctx.player?.introWaking, cam: [c.x, c.y, c.z], rig: r ? [r.x, r.y, r.z] : null,
        fade: hud.screenFadeShown, comp: compass ? Number(getComputedStyle(compass).opacity) : -1,
        ret: reticle ? Number(getComputedStyle(reticle).opacity) : -1,
      });
      if (w.frames.length > 5000) w.frames.shift();
      requestAnimationFrame(tick);
    })();
  });
  console.log('②–⑥ 튜토리얼 오프닝');
  await waitFor(page, () => window.__game.ctx.missionMode === 'tutorial' && window.__game.ctx.player?.introWaking === true, 'tutorial wake start', 60000);
  ok(true, '새 캐릭터가 튜토리얼 레이드에서 기상 연출로 시작한다');
  await waitFor(page, () => window.__game.getSystem('hud').screenFadeShown < 0.95 && window.__game.ctx.player.introWaking, 'fade moving', 20000).catch(() => null);

  const during = await page.evaluate(() => {
    const ctx = window.__game.ctx, hud = window.__game.getSystem('hud');
    const disp = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).display : null; };
    return {
      waking: !!ctx.player.introWaking, step: ctx.tutorial.step,
      objHidden: hud.objective.hiddenForTutorial, clock: disp('.objective'), timer: disp('.countdown'),
      compass: Number(getComputedStyle(document.querySelector('.compass')).opacity),
      reticle: Number(getComputedStyle(document.querySelector('.hud.gameplay .reticle')).opacity),
    };
  });
  ok(during.waking && during.step === 'wake', '연출 중 · 튜토리얼 wake 단계', JSON.stringify(during));
  ok(during.objHidden && during.clock === 'none', '좌측 상단 시계가 없다', `(${during.clock})`);
  ok(during.timer === 'none', '상단 중앙 탈출 타이머가 없다', `(${during.timer})`);
  ok(during.compass === 0, '연출 중 나침반 opacity 0', `(${during.compass})`);
  ok(during.reticle === 0, '연출 중 크로스헤어 opacity 0', `(${during.reticle})`);
  await shot(page, 'wake-fading');

  const tabDuring = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { open: ctx.inventory.isOpen, waking: !!ctx.player.introWaking };
  });
  ok(tabDuring.waking ? !tabDuring.open : true, '연출 중 Tab 은 가방을 불러오지 않는다', JSON.stringify(tabDuring));

  await waitFor(page, () => window.__wk.done !== null, 'player:introWakeDone', 40000);
  await sleep(2500);
  const after = await page.evaluate(() => {
    const g = window.__game, ctx = g.ctx, pl = g.getSystem('player');
    const f = window.__wk.frames;
    const lastWake = f.map((x) => x.waking).lastIndexOf(true);
    const a = f[lastWake], b = f[lastWake + 1], c = f[Math.min(f.length - 1, lastWake + 5)];
    const d3 = (p, q) => (p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : -1);
    const wakeFrames = f.filter((x) => x.waking && x.rig);
    const maxSide = wakeFrames.reduce((m, x) => Math.max(m, d3(x.cam, x.rig)), 0);
    const post = f.slice(lastWake + 1);
    return {
      step: ctx.tutorial.step, waking: !!ctx.player.introWaking, ow: pl.rig.overrideWeight,
      fadeMid: f.some((x) => x.waking && x.fade > 0.05 && x.fade < 0.95), fadeEnd: f[f.length - 1].fade,
      jump: d3(a?.cam, b?.cam), settled: d3(c?.cam, c?.rig), maxSide,
      compMid: post.some((x) => x.comp > 0.02 && x.comp < 0.98), compEnd: f[f.length - 1].comp,
      compWakeZero: f.filter((x) => x.waking).every((x) => x.comp === 0),
      retWakeZero: f.filter((x) => x.waking).every((x) => x.ret === 0),
      // So a failure names the guilty frame at once (the first 3: which frame · its opacity · waking either side)
      retBad: f.map((x, i) => ({ i, t: x.t, ret: x.ret, wake: x.waking, prevWake: f[i - 1]?.waking ?? null }))
        .filter((x) => x.wake && x.ret !== 0).slice(0, 3),
      wakeFirst: f.findIndex((x) => x.waking), frames: f.length,
      retMid: post.some((x) => x.ret > 0.02 && x.ret < 0.98), retEnd: f[f.length - 1].ret,
      retFirstPost: post[0]?.ret ?? null, reveal: g.getSystem('hud').reticle.revealAmount,
    };
  });
  ok(after.fadeMid, '검은 페이드가 중간값을 지난다 (코드가 칠한다)');
  ok(after.fadeEnd === 0, '페이드가 끝나 화면이 열려 있다', `(${after.fadeEnd})`);
  ok(!after.waking && after.step !== 'wake', '연출이 끝나고 튜토리얼이 wake 를 떠난다', JSON.stringify({ step: after.step }));
  ok(after.ow === 0, '카메라 오버라이드가 풀린다', `(${after.ow})`);
  ok(after.maxSide > 1.0, '연출 초반 카메라는 백뷰와 다른 자리(옆)였다', `(${after.maxSide.toFixed(2)} m)`);
  ok(after.jump >= 0 && after.jump < 0.35, '해제 프레임에서 카메라가 튀지 않는다', `(${after.jump.toFixed(3)} m)`);
  ok(after.settled >= 0 && after.settled < 0.05, '해제 뒤 카메라 = 리그 백뷰', `(${after.settled.toFixed(3)} m)`);
  ok(after.compWakeZero, '연출 프레임 내내 나침반이 보이지 않았다');
  ok(after.compMid, '나침반이 서서히 나타난다 (중간값)');
  ok(after.compEnd === 1, '나침반이 다 나타났다', `(${after.compEnd})`);
  // 2026-09-16 (user's decision): no crosshair until the camera is back at its ordinary view, then it fades in
  ok(after.retWakeZero, '연출 프레임 내내 크로스헤어가 보이지 않았다', JSON.stringify({ bad: after.retBad, wakeFirst: after.wakeFirst, frames: after.frames }));
  ok(after.retFirstPost !== null && after.retFirstPost < 0.5, '연출이 끝난 첫 프레임에 크로스헤어가 한 번에 켜지지 않는다', `(${after.retFirstPost})`);
  ok(after.retMid, '크로스헤어가 서서히 나타난다 (중간값)');
  ok(after.retEnd === 1 && after.reveal === 1, '크로스헤어가 다 나타났다', JSON.stringify({ ret: after.retEnd, reveal: after.reveal }));
  await shot(page, 'wake-done');

  const tabAfter = await page.evaluate(async () => {
    const ctx = window.__game.ctx;
    const tap = () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
    };
    tap();
    await new Promise((r) => setTimeout(r, 300));
    const opened = ctx.inventory.isOpen;
    if (opened) { tap(); await new Promise((r) => setTimeout(r, 300)); }
    return { opened, closed: !ctx.inventory.isOpen };
  });
  ok(tabAfter.opened && tabAfter.closed, '연출이 끝나면 Tab 이 가방을 열고 닫는다', JSON.stringify(tabAfter));
  const clockStill = await page.evaluate(() => getComputedStyle(document.querySelector('.objective')).display);
  ok(clockStill === 'none', '연출 뒤에도 튜토리얼 레이드에는 시계가 없다', `(${clockStill})`);
} catch (e) {
  fail++;
  console.log('  FAIL (exception)', e?.message ?? e);
} finally {
  await closeBrowser(browser);
}
if (errors.length) { console.log('page errors:'); for (const e of errors.slice(0, 10)) console.log('  ', e); }
const fatal = errors.filter((e) => !/favicon|ResizeObserver/.test(e));
if (fatal.length) fail++;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
