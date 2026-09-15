// Tutorial **ship track** smoke (② `ship`: levelUp → stats) — TODO E-12, 2026-09-15.
// 2026-09-15 (사용자 결정): `ravenQuest` 가 순서에서 빠졌다. 레이븐의 첫 연락은 **함선 트랙이 끝난 뒤**, 어느 트랙도
//   돌지 않을 때 온다 (`meta/parts/NpcQuests.tutorialBlocks`) — 5 는 「증축 트랙을 건너뛰면 온다」를 본다.
// 2026-09-16 (사용자 결정): `messenger`(메신저 열기)도 빠졌다 (2 steps). `stats` 가 마지막이고, 확정해도 **인벤토리 화면을 닫을 때**
//   트랙이 끝난다 — 그래야 증축 트랙의 시작 카드가 캐릭터 화면 위로 뜨지 않는다. 옛 저장의 `messenger` · `ravenQuest` 는 「함선 트랙 끝」.
//
// The raid track (①) is driven by its own smoke; this one sets up the moment that track ends for real and drives the rest with
// **real input** wherever the player judges something:
//   0. 레이드 완주 — the tutorial system's own completion path (`extract` → `advance()` → `finish(false)`) leaves `pendingShip`, and
//      the tutorial raid XP (`TUTORIAL_RAID_XP`) lands a fresh Lv.1 character on exactly Lv.2 with one stat point
//      (granted by settlement when that exists, else `ctx.progression.addXp` — the line says which).
//   1. 트랙 순서 — entering the personal ship starts the ship track (raid done, build has no record and waits), 1/3, ship gates.
//   2. levelUp — Tab (synthetic key on document.body) opens the inventory → stats. And the 2026-09-14 4차 bug: with the inventory
//      **already open**, a real click on the 캐릭터 tab advances (no `inventory:opened` comes).
//   3. stats — the spotlight hole is exactly the **visible** stat column (`.cs-col` — the closed overlay copy sits first in the DOM)
//      and holds every ＋ and the confirm button (hit-tested); ＋ by mouse, a short press does nothing, a real 1 s pointer hold on
//      `포인트 투자 확정` spends the point; the profile is saved. The objective is ticked but the track **stays at stats (2/2)**
//      while the inventory is open: no build intro card, the character tab stays, the messenger stays hidden, no contact.
//   4. close — Tab closes the inventory → `tutorial:finished {track:'ship'}` → the build track starts (intro card) in the same ship;
//      the messenger was never opened and stays hidden.
//   6. old saves + reload — `load()` reads a saved `messenger` / `ravenQuest` as "ship track done" (`stats` resumes); a save left at
//      `stats` with the objective done (confirmed, reloaded before closing) ends the ship track on entering the ship → build intro;
//      level and the spent point survive the reload.
//   5. 레이븐 — `skipTrack('build')` leaves no track running → within `NPC_OFFER_CHECK_S` Raven's first contact arrives (only Raven:
//      greeting lines + two choices, no quest card), the button returns with an unread badge.
//
// Usage: node scripts/smoke-tutorial-ship.mjs [http://localhost:5273/]   (needs `npm run dev`; no relay needed)
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const T0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1440,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // single-player: park vite HMR + the relay socket so no server profile lands mid-run (NPC quests run locally)
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  const setup = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing
      && !!window.__game.ctx.tutorial && !!window.__game.ctx.meta && !!window.__game.ctx.progression, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__key = (code, type) => document.body.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
      /** First element of `sel` that is actually drawn — the same rule as `tutorial/parts/Spotlight.firstShown`. */
      window.__shown = (sel) => {
        for (const e of document.querySelectorAll(sel)) {
          if (e.getClientRects().length === 0) continue;
          if (getComputedStyle(e).visibility === 'hidden') continue;
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return e;
        }
        return null;
      };
      window.__lit = () => { const r = document.querySelector('.tut-spot'); return !!r && !r.hidden && r.classList.contains('is-lit'); };
      /* The hole the four dark panes leave (never the ring — it has a scale animation). */
      window.__hole = () => {
        const p = [...document.querySelectorAll('.tut-spot-pane')].map((e) => e.getBoundingClientRect());
        if (p.length !== 4) return null;
        const [top, bottom, left, right] = p;
        return { left: left.right, right: right.left, top: top.bottom, bottom: bottom.top };
      };
      /* The hole `Spotlight.place` cuts for `el`: rect ± PAD(6), floor/ceil, clamped to the viewport. */
      window.__holeIs = (el) => {
        const h = window.__hole();
        if (!h || !el) return false;
        const b = el.getBoundingClientRect();
        const want = {
          left: Math.max(0, Math.floor(b.left - 6)), top: Math.max(0, Math.floor(b.top - 6)),
          right: Math.min(window.innerWidth, Math.ceil(b.right + 6)), bottom: Math.min(window.innerHeight, Math.ceil(b.bottom + 6)),
        };
        const near = (x, y) => Math.abs(x - y) <= 1;
        return near(h.left, want.left) && near(h.top, want.top) && near(h.right, want.right) && near(h.bottom, want.bottom);
      };
      window.__inHole = (el) => {
        const h = window.__hole();
        if (!h || !el) return false;
        const b = el.getBoundingClientRect();
        return h.left <= b.left && h.right >= b.right && h.top <= b.top && h.bottom >= b.bottom;
      };
      /* Where a real click on `el` lands — its centre, and whether the element under it is `el` (not a dark pane). */
      window.__hit = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const under = document.elementFromPoint(x, y);
        return { x, y, ok: !!under && (under === el || el.contains(under)), under: under ? String(under.className) : null };
      };
      window.__objDone = (text) => {
        const row = [...document.querySelectorAll('.tut-panel .tut-obj')].find((r) => r.querySelector('.tut-obj-txt')?.textContent === text);
        return row ? row.classList.contains('is-done') : null;
      };
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['tutorial:changed', 'tutorial:finished', 'ui:notify', 'ui:messengerToggled', 'npc:message', 'npc:questChanged',
        'progress:statChanged', 'inventory:opened']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    });
  };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const step = () => P(() => window.__game.ctx.tutorial.step);
  const waitStep = (s, timeout = 30000) => waitFor(page, (want) => window.__game.ctx.tutorial.step === want, `step ${s}`, timeout, s);
  const waitSpot = (re, label, timeout = 15000) => waitFor(page, (src) => window.__lit()
    && new RegExp(src).test(document.querySelector('.tut-spot-tip')?.textContent ?? ''), label, timeout, re);
  const tapKey = async (code, holdMs = 90) => { await P((c) => window.__key(c, 'keydown'), code); await sleep(holdMs); await P((c) => window.__key(c, 'keyup'), code); };
  const enterShip = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await sleep(400);
  };
  const tutSave = () => P(() => JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'));

  await page.goto(BASE, { waitUntil: 'load' });
  await setup();

  /* ── 0. 레이드 완주 → pendingShip + 레벨 2 ─────────────────────────────── */
  console.log('0. 레이드 완주');
  const raidEnd = await P(() => {
    const t = window.__game.ctx.tutorial;
    const went = t.goto('extract');
    const at = t.step;
    // `extract` is the raid track's last step: its own `advance()` is `finish(false)` — the completion path a real liftoff takes
    window.__game.getSystem('tutorial').advance();
    return {
      went, at, hub: window.__game.ctx.isHubPhase(), active: t.active,
      fin: window.__ev['tutorial:finished'].slice(-1)[0] ?? null,
      save: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    };
  });
  ok(raidEnd.went && raidEnd.at === 'extract' && !raidEnd.hub, '레이드 트랙의 마지막 단계(extract)에 선다 (함선 밖)', JSON.stringify(raidEnd));
  ok(raidEnd.fin?.track === 'raid' && raidEnd.fin?.skipped === false && !raidEnd.active,
    '완주하면 tutorial:finished {raid, skipped:false}', JSON.stringify(raidEnd.fin));
  ok(raidEnd.save?.version === 2 && raidEnd.save?.tracks?.raid?.done === true && raidEnd.save?.pendingShip === true
    && !raidEnd.save?.tracks?.ship && !raidEnd.save?.tracks?.build,
  '완주는 pendingShip 을 남기고 함선 · 증축 트랙은 아직 기록이 없다', JSON.stringify(raidEnd.save));

  const xp = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const prog = window.__game.ctx.progression;
    const before = { level: prog.level, points: prog.statPoints };
    let via = 'settlement';
    if (prog.level <= 1 && prog.statPoints === 0) { prog.addXp(S.TUTORIAL_RAID_XP); via = 'addXp(TUTORIAL_RAID_XP)'; }
    return { before, level: prog.level, points: prog.statPoints, raidXp: S.TUTORIAL_RAID_XP, per: S.STAT_POINTS_PER_LEVEL, via };
  });
  ok(xp.before.level === 1, `새 캐릭터는 Lv.1 에서 레이드를 끝낸다 (${JSON.stringify(xp.before)})`);
  ok(xp.level === 2 && xp.points === xp.per,
    `TUTORIAL_RAID_XP ${xp.raidXp} = 정확히 Lv.2 · 능력치 포인트 ${xp.per} (지급: ${xp.via})`, JSON.stringify(xp));

  /* ── 1. 함선에 들어서면 함선 트랙 — 순서 raid → ship → build ─────────── */
  console.log('1. 트랙 순서');
  await enterShip();
  await waitStep('levelUp');
  await sleep(700);   // 목표 줄은 반 박자 늦게 그려진다 (TUTORIAL_STEP_DELAY_S)
  const s1 = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const t = window.__game.ctx.tutorial;
    const ev = window.__ev['tutorial:changed'].slice(-1)[0] ?? null;
    return {
      order: [...S.TUTORIAL_TRACKS], ship: [...S.TUTORIAL_TRACK_STEPS.ship],
      track: t.track, step: t.step, index: t.stepIndex, count: t.stepCount, ev,
      raidDone: t.isTrackDone('raid'), shipDone: t.isTrackDone('ship'),
      save: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
      hidesCommunity: t.hides('community'), communityShown: document.querySelector('.community')?.classList.contains('show') ?? null,
      charTab: t.blockReason('screenTab', 'character'), corpTab: t.blockReason('screenTab', 'corp'),
      hud: ['vitals', 'weapon', 'stamina', 'implant', 'stratagem'].map((p) => t.hides('hud', p)),
      popup: !(document.querySelector('.tut-popup')?.hidden ?? true),
      panelTrack: document.querySelector('.tut-panel .tut-track')?.textContent ?? '',
      objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
    };
  });
  ok(s1.order.join(' ') === 'raid ship build' && s1.ship.join(' ') === 'levelUp stats',
    `트랙 순서 raid → ship → build, 함선 트랙 ${s1.ship.join(' → ')} (메신저 단계 없음)`, JSON.stringify(s1));
  ok(s1.track === 'ship' && s1.step === 'levelUp' && s1.index === 1 && s1.count === 2
    && s1.ev?.track === 'ship' && s1.ev?.step === 'levelUp' && s1.ev?.index === 1 && s1.ev?.count === 2,
  '함선에 들어서면 함선 트랙 levelUp (1/2) 이 시작된다', JSON.stringify({ track: s1.track, step: s1.step, ev: s1.ev }));
  ok(s1.raidDone === true && s1.shipDone === false, '레이드 트랙은 끝났고 함선 트랙은 도는 중', JSON.stringify(s1));
  ok(s1.save?.tracks?.ship?.step === 'levelUp' && !s1.save?.tracks?.build && s1.save?.pendingShip === false && !s1.popup,
    '증축 트랙은 기록 없이 기다린다 (시작 카드 없음) · pendingShip 은 한 번 쓰고 지워진다', JSON.stringify(s1.save));
  ok(s1.hidesCommunity === true && s1.communityShown === false, 'levelUp 에서는 메신저 버튼을 감춘다 (그 단계의 allow 밖)');
  ok(s1.charTab === null && !!s1.corpTab, '캐릭터 탭만 열리고 나머지 화면 탭은 막힌다', JSON.stringify({ c: s1.charTab, corp: s1.corpTab }));
  ok(s1.hud.every((h) => h === false), '함선 트랙은 HUD 를 하나도 감추지 않는다', JSON.stringify(s1.hud));
  ok(s1.panelTrack.includes('함선 안내') && s1.objs.join('|') === '인벤토리 화면 열기',
    `목표 패널: 함선 안내 · 「인벤토리 화면 열기」 (${s1.panelTrack} / ${s1.objs.join('|')})`);

  /* ── 2. levelUp — Tab 으로 인벤토리 · 이미 열린 창에서 캐릭터 탭 ─────── */
  console.log('2. levelUp');
  await tapKey('Tab');
  await waitStep('stats');
  const s2 = await P(() => ({
    open: window.__game.ctx.inventory.isOpen, tab: window.__game.ctx.inventory.screenTab,
    opened: window.__ev['inventory:opened'].length,
    ev: window.__ev['tutorial:changed'].slice(-1)[0] ?? null,
  }));
  ok(s2.open === true && s2.tab === 'inventory' && s2.opened >= 1 && s2.ev?.step === 'stats' && s2.ev?.index === 2,
    'Tab 으로 인벤토리 화면을 열면 stats (2/2) 로 넘어간다', JSON.stringify(s2));

  // 2026-09-14 4차 bug fix: the inventory is **already open** — switching tabs sends no `inventory:opened`
  await P(() => window.__game.ctx.tutorial.goto('levelUp'));
  await sleep(500);
  const s2b = await P(() => ({ step: window.__game.ctx.tutorial.step, open: window.__game.ctx.inventory.isOpen, tab: window.__game.ctx.inventory.screenTab }));
  ok(s2b.step === 'levelUp' && s2b.open && s2b.tab === 'inventory', '창이 열린 채 levelUp 으로 되돌리면 인벤토리 탭에서는 그대로 머문다', JSON.stringify(s2b));
  await waitSpot('캐릭터', 'spotlight (levelUp 탭 줄)');
  const tabHit = await P(() => {
    const tabs = window.__shown('.inv-root .scr-tabs');
    const b = [...document.querySelectorAll('.inv-root .scr-tab')].find((x) => x.textContent?.includes('캐릭터') && x.getClientRects().length > 0);
    return { exact: window.__holeIs(tabs), hit: window.__hit(b) };
  });
  ok(tabHit.exact && tabHit.hit?.ok, 'levelUp 포커싱은 탭 줄을 뚫고 캐릭터 탭이 실제로 눌린다', JSON.stringify(tabHit));
  if (tabHit.hit) await page.mouse.click(tabHit.hit.x, tabHit.hit.y);
  await waitStep('stats', 10000).catch(() => null);
  const s2c = await P(() => ({ step: window.__game.ctx.tutorial.step, tab: window.__game.ctx.inventory.screenTab, opened: window.__ev['inventory:opened'].length }));
  ok(s2c.step === 'stats' && s2c.tab === 'character' && s2c.opened === s2.opened,
    '이미 열린 인벤토리에서 캐릭터 탭을 누르면 (inventory:opened 없이) stats 로 넘어간다', JSON.stringify(s2c));

  /* ── 3. stats — 보이는 능력치 열 · ＋ · 1초 홀드 ──────────────────────── */
  console.log('3. stats');
  await waitSpot('포인트 투자 확정', 'spotlight (능력치 열)');
  const s3 = await P(() => {
    const col = window.__shown('.cs-col');
    const all = [...document.querySelectorAll('.cs-col')];
    const plus = col ? [...col.querySelectorAll('.cs-stat .plus')] : [];
    const confirm = col?.querySelector('.pg-confirm') ?? null;
    return {
      copies: all.length, firstIsHidden: all[0] ? all[0] !== col : null, statCol: col?.querySelector('.ui-label')?.textContent ?? '',
      exact: window.__holeIs(col), plusN: plus.length, plusIn: plus.every((b) => window.__inHole(b)),
      confirmIn: window.__inHole(confirm), plusHit: window.__hit(plus[0]), confirmHit: window.__hit(confirm),
      tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
    };
  });
  ok(s3.copies >= 4 && s3.firstIsHidden === true && s3.statCol === '능력치',
    '캐릭터 시트 사본이 둘이고 문서 순서상 첫 .cs-col 은 숨은 사본이다 (포커싱은 보이는 쪽을 골라야 한다)', JSON.stringify(s3));
  ok(s3.exact, `포커싱 구멍 = 보이는 능력치 열 (.cs-col) 정확히 ("${s3.tip}")`, JSON.stringify(s3));
  ok(s3.plusN >= 5 && s3.plusIn && s3.confirmIn, `＋ ${s3.plusN}개와 포인트 투자 확정이 전부 구멍 안이다`, JSON.stringify(s3));
  // (the confirm button is `disabled` → `pointer-events: none` until something is pending, so it is hit-tested after ＋)
  ok(s3.plusHit?.ok, '＋ 버튼이 어두운 판에 가리지 않는다 (hit-test)', JSON.stringify(s3.plusHit));

  const pre = await P(() => {
    const prog = window.__game.ctx.progression;
    const col = window.__shown('.cs-col');
    const row = col.querySelector('.cs-stat');
    return { id: row.dataset.stat, base: prog.getStat(row.dataset.stat), points: prog.statPoints };
  });
  for (let i = 0; i < pre.points; i++) {
    const h = await P((id) => window.__hit(window.__shown('.cs-col').querySelector(`.cs-stat[data-stat="${id}"] .plus`)), pre.id);
    await page.mouse.click(h.x, h.y);
    await sleep(120);
  }
  const pend = await P((id) => {
    const col = window.__shown('.cs-col');
    const pa = col.querySelector(`.cs-stat[data-stat="${id}"] .pa`);
    return { pa: pa && !pa.hidden ? pa.textContent : null, points: window.__game.ctx.progression.statPoints, step: window.__game.ctx.tutorial.step };
  }, pre.id);
  ok(pend.pa?.includes(String(pre.points)) && pend.points === pre.points && pend.step === 'stats',
    `＋ 는 미확정으로만 쌓인다 (${pre.id} ${pend.pa}, 포인트 ${pend.points} 그대로, 단계 그대로)`, JSON.stringify(pend));

  const confirmAt = await P(() => window.__hit(window.__shown('.cs-col').querySelector('.pg-confirm')));
  ok(confirmAt?.ok, '미확정 포인트가 생기면 포인트 투자 확정이 구멍 안에서 눌린다 (hit-test)', JSON.stringify(confirmAt));
  await page.mouse.move(confirmAt.x, confirmAt.y);
  await page.mouse.down();
  await sleep(300);
  await page.mouse.up();
  await sleep(250);
  const shortPress = await P(() => ({ points: window.__game.ctx.progression.statPoints, step: window.__game.ctx.tutorial.step }));
  ok(shortPress.points === pre.points && shortPress.step === 'stats', '짧게 누르면 확정되지 않는다 (0.3 s)', JSON.stringify(shortPress));

  const statEv0 = await P(() => window.__ev['progress:statChanged'].length);
  await page.mouse.move(confirmAt.x, confirmAt.y);
  await page.mouse.down();
  await sleep(550);
  const midHold = await P(() => ({
    step: window.__game.ctx.tutorial.step, holding: window.__shown('.cs-col').querySelector('.pg-confirm').classList.contains('is-holding'),
    points: window.__game.ctx.progression.statPoints,
  }));
  await sleep(750);
  await page.mouse.up();
  ok(midHold.step === 'stats' && midHold.holding && midHold.points === pre.points, '누르고 있는 동안은 게이지만 찬다 (0.55 s)', JSON.stringify(midHold));
  // 2026-09-16: `stats` 가 마지막 단계다 — 확정하면 목표에 체크만 들어가고, 화면을 닫을 때 트랙이 끝난다 (`TutorialSystem.onStatsConfirmed`)
  await waitFor(page, () => window.__objDone('능력치 포인트 투자 확정') === true, 'statsSpent ticked', 10000).catch(() => null);
  await sleep(300);
  const s3b = await P((pre) => {
    const prog = window.__game.ctx.progression, t = window.__game.ctx.tutorial;
    const saved = JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null');
    return {
      step: t.step, track: t.track, index: t.stepIndex, count: t.stepCount, points: prog.statPoints, value: prog.getStat(pre.id),
      savedPoints: saved?.statPoints ?? null, savedValue: saved?.stats?.[pre.id] ?? null,
      statEv: window.__ev['progress:statChanged'].length,
      toast: window.__ev['ui:notify'].some((n) => /능력치 포인트 \d+점을 투자했습니다/.test(n.text)),
      fin: window.__ev['tutorial:finished'].filter((f) => f.track === 'ship').length,
      objDone: window.__objDone('능력치 포인트 투자 확정'),
      tut: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    };
  }, pre);
  ok(s3b.step === 'stats' && s3b.track === 'ship' && s3b.index === 2 && s3b.count === 2 && s3b.objDone === true && s3b.fin === 0,
    '1초 홀드로 확정하면 목표에 체크가 들어가지만 화면이 열린 동안 함선 트랙은 stats (2/2) 에 머문다', JSON.stringify(s3b));
  ok(s3b.tut?.tracks?.ship?.step === 'stats' && (s3b.tut?.objectives ?? []).includes('statsSpent'),
    '달성한 목표가 저장에 남는다 (닫기 전에 새로고침해도 이어진다 — 6)', JSON.stringify(s3b.tut));
  ok(s3b.points === 0 && s3b.value === pre.base + pre.points && s3b.statEv > statEv0 && s3b.toast,
    `포인트가 실제로 들어갔다 (${pre.id} ${pre.base} → ${s3b.value}, 남은 포인트 ${s3b.points})`, JSON.stringify(s3b));
  ok(s3b.savedPoints === 0 && s3b.savedValue === pre.base + pre.points, '투자는 즉시 프로필에 저장된다 (scav.s1.profile)', JSON.stringify(s3b));

  /* 인벤토리가 아직 열려 있다 — 증축 트랙이 그 위로 시작하면 안 된다 (시작 카드 · 캐릭터 탭 게이트 · 창고 숨김) */
  await sleep(1200);
  const held = await P(() => {
    const t = window.__game.ctx.tutorial, inv = window.__game.ctx.inventory, npc = window.__game.ctx.meta.npc;
    return {
      step: t.step, open: inv.isOpen, tab: inv.screenTab, charTab: t.blockReason('screenTab', 'character'),
      popup: !(document.querySelector('.tut-popup')?.hidden ?? true),
      build: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null')?.tracks?.build ?? null,
      hidesCommunity: t.hides('community'), shown: document.querySelector('.community')?.classList.contains('show') ?? null,
      contacts: npc.getContacts().length, msgs: window.__ev['npc:message'].length,
    };
  });
  ok(held.step === 'stats' && held.open && held.tab === 'character' && held.charTab === null && !held.popup && held.build === null,
    '화면이 열린 동안에는 증축 트랙의 시작 카드가 뜨지 않고 캐릭터 탭도 그대로다', JSON.stringify(held));
  ok(held.hidesCommunity === true && held.shown === false && held.contacts === 0 && held.msgs === 0,
    '메신저 단계가 없다 — 함선 트랙 내내 메신저 버튼은 감춰지고 아무 NPC 도 연락하지 않는다', JSON.stringify(held));

  /* ── 4. 화면을 닫으면 함선 트랙이 끝나고 증축 트랙이 이어진다 ──────────────── */
  console.log('4. 화면 닫기 → 함선 트랙 끝');
  const n0 = await P(() => window.__ev['tutorial:changed'].length);
  await tapKey('Tab');
  await waitFor(page, () => window.__ev['tutorial:finished'].some((f) => f.track === 'ship'), 'tutorial:finished ship', 10000).catch(() => null);
  await sleep(400);
  const s4b = await P((n0) => {
    const t = window.__game.ctx.tutorial;
    return {
      open: window.__game.ctx.inventory.isOpen,
      toggled: window.__ev['ui:messengerToggled'].filter((e) => e.open).length,
      fin: window.__ev['tutorial:finished'].filter((f) => f.track === 'ship'),
      trail: window.__ev['tutorial:changed'].slice(n0).map((e) => `${e.track ?? '-'}:${e.step}:${e.index}/${e.count}`),
      track: t.track, step: t.step, shipDone: t.isTrackDone('ship'),
      save: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
      popup: !(document.querySelector('.tut-popup')?.hidden ?? true), popupTitle: document.querySelector('.tut-popup-card .title')?.textContent ?? '',
      messengerOpen: !(document.querySelector('.community-panel')?.hidden ?? true), hidesCommunity: t.hides('community'),
      contacts: window.__game.ctx.meta.npc.getContacts().map((c) => c.npc.id),
    };
  }, n0);
  ok(!s4b.open && s4b.fin.length === 1 && s4b.fin[0].skipped === false && s4b.shipDone && s4b.save?.tracks?.ship?.done === true,
    'Tab 으로 화면을 닫으면 함선 트랙이 끝난다 (2/2) — tutorial:finished {ship, skipped:false}', JSON.stringify(s4b));
  ok(s4b.track === 'build' && s4b.step === 'intro' && s4b.popup && s4b.popupTitle === '튜토리얼'
    && s4b.trail.join(' ') === '-:null:0/2 build:intro:1/17',
  `닫힌 뒤에야 같은 함선에서 증축 트랙이 시작된다 (${s4b.trail.join(' → ')})`, JSON.stringify(s4b));
  ok(s4b.toggled === 0 && !s4b.messengerOpen && s4b.hidesCommunity === true,
    '메신저는 한 번도 열리지 않았고 증축 트랙에서도 감춰진다', JSON.stringify(s4b));
  ok(s4b.contacts.length === 0, '증축 트랙이 도는 동안에도 연락은 없다', JSON.stringify(s4b.contacts));

  /* ── 6. 옛 저장 · 확정 뒤 닫기 전에 새로고침 ───────────────────────────────── */
  console.log('6. 옛 저장 · 새로고침');
  const remap = await P(() => {
    const sys = window.__game.getSystem('tutorial');
    const key = 'scav.s1.tutorial';
    const keep = localStorage.getItem(key);
    const read = (step) => {
      localStorage.setItem(key, JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step, done: false } } }));
      return sys.load().tracks.ship ?? null;
    };
    const out = { messenger: read('messenger'), ravenQuest: read('ravenQuest'), stats: read('stats') };
    if (keep !== null) localStorage.setItem(key, keep); else localStorage.removeItem(key);
    return out;
  });
  ok(remap.messenger?.step === null && remap.messenger?.done === true && remap.ravenQuest?.step === null && remap.ravenQuest?.done === true,
    '옛 저장의 messenger · ravenQuest 는 「함선 트랙 끝」으로 읽힌다 (되돌려 붙일 단계가 없다)', JSON.stringify(remap));
  ok(remap.stats?.step === 'stats' && remap.stats?.done === false, 'stats 저장은 그대로 이어진다', JSON.stringify(remap));
  // 확정은 했는데(목표 달성) 화면을 닫기 전에 새로고침한 사람 — 증축 트랙은 아직 기록이 없다
  await P(() => localStorage.setItem('scav.s1.tutorial', JSON.stringify({
    version: 2, tracks: { raid: { step: null, done: true }, ship: { step: 'stats', done: false } }, pendingShip: false, objectives: ['statsSpent'],
  })));
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await waitStep('intro', 20000).catch(() => null);
  await sleep(700);
  const s6 = await P((pre) => {
    const t = window.__game.ctx.tutorial, prog = window.__game.ctx.progression;
    return {
      track: t.track, step: t.step, shipDone: t.isTrackDone('ship'),
      fin: window.__ev['tutorial:finished'].filter((f) => f.track === 'ship').length,
      popup: !(document.querySelector('.tut-popup')?.hidden ?? true),
      points: prog.statPoints, value: prog.getStat(pre.id), level: prog.level,
    };
  }, pre);
  ok(s6.shipDone && s6.fin === 1 && s6.track === 'build' && s6.step === 'intro' && s6.popup,
    '확정 뒤 닫기 전에 새로고침해도, 함선에 들어서면 함선 트랙이 끝나고 증축 트랙이 이어진다', JSON.stringify(s6));
  ok(s6.level === 2 && s6.points === 0 && s6.value === pre.base + pre.points, '투자한 포인트 · 레벨이 새로고침을 견딘다', JSON.stringify(s6));

  /* ── 5. 레이븐 — 튜토리얼이 끝나야 쓴다 ──────────────────────────────── */
  console.log('5. 레이븐 (튜토리얼 뒤)');
  // 증축 트랙을 건너뛰면 어느 트랙도 돌지 않는다 → 다음 평가(`NPC_OFFER_CHECK_S` 주기)에서 레이븐이 첫 연락을 보낸다
  await P(() => window.__game.ctx.tutorial.skipTrack('build'));
  const s5 = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const npc = window.__game.ctx.meta.npc;
    const t0 = performance.now();
    const limit = (S.NPC_OFFER_CHECK_S + 4) * 1000;
    while (performance.now() - t0 < limit && npc.getContacts().length === 0) await new Promise((r) => setTimeout(r, 100));
    const contacts = npc.getContacts();
    const raven = contacts.find((c) => c.npc.id === 'npc_raven');
    const dot = document.querySelector('.community .cm-dot');
    return {
      ms: Math.round(performance.now() - t0), active: window.__game.ctx.tutorial.active,
      ids: contacts.map((c) => c.npc.id), unread: raven?.unread ?? 0,
      log: npc.getMessages('npc_raven').length, introLines: S.NPC_DEF_MAP.get('npc_raven').intro.length,
      choices: npc.getPendingChoices('npc_raven').length, quest: npc.getQuest('q_rv_0'),
      badge: dot && !dot.hidden ? Number(dot.textContent) : 0, shown: document.querySelector('.community')?.classList.contains('show') ?? null,
    };
  });
  ok(!s5.active && s5.ids.join(',') === 'npc_raven' && s5.log === s5.introLines && s5.unread > 0 && s5.choices === 2 && s5.quest === null,
    `튜토리얼이 끝나면 레이븐이 첫 연락을 보낸다 (${s5.ms} ms) — 연락은 레이븐 하나, 인사 ${s5.log}줄 · 선택지 ${s5.choices} · 퀘스트 없음`, JSON.stringify(s5));
  ok(s5.badge > 0 && s5.shown === true, `메신저 버튼이 돌아오고 썸네일 배지에 읽지 않음 ${s5.badge}`, JSON.stringify(s5));

  ok(errors.length === 0, `no console errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fail === 0 ? 0 : 1);
