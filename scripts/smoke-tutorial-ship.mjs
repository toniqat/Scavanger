// Tutorial **ship track** smoke (② `ship`: levelUp → stats → messenger → ravenQuest) — TODO E-12, 2026-09-15.
//
// The raid track (①) is driven by its own smoke; this one sets up the moment that track ends for real and drives the rest with
// **real input** wherever the player judges something:
//   0. 레이드 완주 — the tutorial system's own completion path (`extract` → `advance()` → `finish(false)`) leaves `pendingShip`, and
//      the tutorial raid XP (`TUTORIAL_RAID_XP`) lands a fresh Lv.1 character on exactly Lv.2 with one stat point
//      (granted by settlement when that exists, else `ctx.progression.addXp` — the line says which).
//   1. 트랙 순서 — entering the personal ship starts the ship track (raid done, build has no record and waits), 1/4, ship gates.
//   2. levelUp — Tab (synthetic key on document.body) opens the inventory → stats. And the 2026-09-14 4차 bug: with the inventory
//      **already open**, a real click on the 캐릭터 tab advances (no `inventory:opened` comes).
//   3. stats — the spotlight hole is exactly the **visible** stat column (`.cs-col` — the closed overlay copy sits first in the DOM)
//      and holds every ＋ and the confirm button (hit-tested); ＋ by mouse, a short press does nothing, a real 1 s pointer hold on
//      `포인트 투자 확정` spends the point → messenger; the profile is saved.
//   6. reload mid-track (after stats) — v2 save, resumes at `messenger` 3/4, the spent point survives.
//   4. messenger — Raven's first contact is there (only Raven), not blocked by the tutorial, the button is spotlighted, P opens it.
//   5. ravenQuest — the Raven row → greeting + two choices, no quest card yet; a real click on a choice → my line, then (typing
//      animation) reply → `introAfter` → quest card, strictly in that order; 「대답한다」 checks before 「수락」; accept →
//      `tutorial:finished {track:'ship'}` → the build track starts (intro card) in the same ship.
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
  ok(s1.order.join(' ') === 'raid ship build' && s1.ship.join(' ') === 'levelUp stats messenger ravenQuest',
    `트랙 순서 raid → ship → build, 함선 트랙 ${s1.ship.join(' → ')}`, JSON.stringify(s1));
  ok(s1.track === 'ship' && s1.step === 'levelUp' && s1.index === 1 && s1.count === 4
    && s1.ev?.track === 'ship' && s1.ev?.step === 'levelUp' && s1.ev?.index === 1 && s1.ev?.count === 4,
  '함선에 들어서면 함선 트랙 levelUp (1/4) 이 시작된다', JSON.stringify({ track: s1.track, step: s1.step, ev: s1.ev }));
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
    'Tab 으로 인벤토리 화면을 열면 stats (2/4) 로 넘어간다', JSON.stringify(s2));

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
  await waitStep('messenger', 10000).catch(() => null);
  const s3b = await P((pre) => {
    const prog = window.__game.ctx.progression;
    const saved = JSON.parse(localStorage.getItem('scav.s1.profile') ?? 'null');
    return {
      step: window.__game.ctx.tutorial.step, points: prog.statPoints, value: prog.getStat(pre.id),
      savedPoints: saved?.statPoints ?? null, savedValue: saved?.stats?.[pre.id] ?? null,
      statEv: window.__ev['progress:statChanged'].length,
      toast: window.__ev['ui:notify'].some((n) => /능력치 포인트 \d+점을 투자했습니다/.test(n.text)),
      ev: window.__ev['tutorial:changed'].slice(-1)[0] ?? null,
    };
  }, pre);
  ok(s3b.step === 'messenger' && s3b.ev?.index === 3 && s3b.ev?.count === 4, '1초 홀드로 확정하면 messenger (3/4) 로 넘어간다', JSON.stringify(s3b));
  ok(s3b.points === 0 && s3b.value === pre.base + pre.points && s3b.statEv > statEv0 && s3b.toast,
    `포인트가 실제로 들어갔다 (${pre.id} ${pre.base} → ${s3b.value}, 남은 포인트 ${s3b.points})`, JSON.stringify(s3b));
  ok(s3b.savedPoints === 0 && s3b.savedValue === pre.base + pre.points, '투자는 즉시 프로필에 저장된다 (scav.s1.profile)', JSON.stringify(s3b));

  /* 인벤토리가 아직 열려 있다 — 메신저 버튼은 blocker 때문에 투명(opacity 0)이다. 포커싱이 보이지 않는 버튼을 두르면 안 된다. */
  await sleep(1200);
  const ghost = await P(() => ({
    lit: window.__lit(), shown: document.querySelector('.community')?.classList.contains('show') ?? null,
    onBtn: window.__lit() && window.__holeIs(document.querySelector('.community .cm-btn')),
    inv: window.__game.ctx.inventory.isOpen,
  }));
  ok(ghost.inv && ghost.shown === false && !ghost.onBtn,
    '인벤토리가 열린 동안(메신저 버튼이 투명) 포커싱이 보이지 않는 버튼을 두르지 않는다', JSON.stringify(ghost));

  /* ── 6. 새로고침 — v2 저장에서 messenger 로 이어진다 ────────────────── */
  console.log('6. 새로고침');
  const saved = await tutSave();
  ok(saved?.version === 2 && saved?.tracks?.raid?.done === true && saved?.tracks?.ship?.step === 'messenger'
    && saved?.tracks?.ship?.done === false && !saved?.tracks?.build && saved?.pendingShip === false,
  `v2 저장: ship.step = messenger, 증축은 기록 없음 (${JSON.stringify(saved)})`);
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await waitStep('messenger');
  await sleep(700);
  const s6 = await P((pre) => {
    const t = window.__game.ctx.tutorial, prog = window.__game.ctx.progression;
    return {
      track: t.track, step: t.step, index: t.stepIndex, count: t.stepCount, shipDone: t.isTrackDone('ship'),
      points: prog.statPoints, value: prog.getStat(pre.id), level: prog.level,
      objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
      build: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null')?.tracks?.build ?? null,
    };
  }, pre);
  ok(s6.track === 'ship' && s6.step === 'messenger' && s6.index === 3 && s6.count === 4 && !s6.shipDone,
    '새로고침 뒤 함선 트랙 messenger (3/4) 에서 이어진다', JSON.stringify(s6));
  ok(s6.level === 2 && s6.points === 0 && s6.value === pre.base + pre.points, '투자한 포인트 · 레벨이 새로고침을 견딘다', JSON.stringify(s6));
  ok(s6.objs.join('|') === '메신저 열기' && s6.build === null, '목표는 「메신저 열기」 · 증축 트랙은 여전히 기다린다', JSON.stringify(s6));

  /* ── 4. messenger — 레이븐의 첫 연락 · 버튼 포커싱 · P ──────────────── */
  console.log('4. messenger');
  await waitFor(page, () => document.querySelector('.community')?.classList.contains('show'), 'messenger button shown', 15000);
  await waitSpot('메신저', 'spotlight (메신저 버튼)');
  const s4 = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const t = window.__game.ctx.tutorial, npc = window.__game.ctx.meta.npc;
    const contacts = npc.getContacts();
    const raven = contacts.find((c) => c.npc.id === 'npc_raven');
    const dot = document.querySelector('.community .cm-dot');
    return {
      active: t.active, track: t.track, hides: t.hides('community'),
      ids: contacts.map((c) => c.npc.id), unread: raven?.unread ?? 0,
      log: npc.getMessages('npc_raven').length, introLines: S.NPC_DEF_MAP.get('npc_raven').intro.length,
      choices: npc.getPendingChoices('npc_raven').length, quest: npc.getQuest('q_rv_0'),
      badge: dot && !dot.hidden ? Number(dot.textContent) : 0,
      exact: window.__holeIs(document.querySelector('.community .cm-btn')), hit: window.__hit(document.querySelector('.community .cm-btn')),
    };
  });
  ok(s4.active && s4.track === 'ship' && s4.hides === false, 'messenger 단계에서 메신저 버튼이 드러난다 (community 허용)', JSON.stringify(s4));
  ok(s4.ids.join(',') === 'npc_raven' && s4.log === s4.introLines && s4.unread > 0 && s4.choices === 2 && s4.quest === null,
    `튜토리얼 도중에도 레이븐의 첫 연락이 와 있다 — 연락은 레이븐 하나, 인사 ${s4.log}줄 · 선택지 ${s4.choices} · 퀘스트 없음`, JSON.stringify(s4));
  ok(s4.badge > 0, `썸네일 배지에 읽지 않음 ${s4.badge}`);
  ok(s4.exact && s4.hit?.ok, '포커싱이 메신저 버튼을 정확히 두르고 버튼이 눌린다', JSON.stringify(s4));
  await tapKey('KeyP');
  await waitStep('ravenQuest', 10000).catch(() => null);
  const s4b = await P(() => ({
    step: window.__game.ctx.tutorial.step, toggled: window.__ev['ui:messengerToggled'].slice(-1)[0] ?? null,
    panel: !(document.querySelector('.community-panel')?.hidden ?? true),
    ev: window.__ev['tutorial:changed'].slice(-1)[0] ?? null,
  }));
  ok(s4b.step === 'ravenQuest' && s4b.toggled?.open === true && s4b.panel && s4b.ev?.index === 4,
    'P 로 메신저를 열면 ravenQuest (4/4) 로 넘어간다', JSON.stringify(s4b));

  /* ── 5. ravenQuest — 선택지 → introAfter → 퀘스트 카드 → 수락 ─────────── */
  console.log('5. ravenQuest');
  await waitSpot('레이븐', 'spotlight (레이븐의 첫 연락)');
  await sleep(300);
  const s5 = await P(() => {
    const row = document.querySelector('.ms-row[data-key="npc:npc_raven"]');
    return {
      chatPage: window.__holeIs(window.__shown('.ms-page.chat')), frame: window.__holeIs(window.__shown('.ms-frame')),
      rowIn: window.__inHole(row), rowHit: window.__hit(row), card: !!document.querySelector('.ms-qcard'),
      objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
    };
  });
  ok(s5.chatPage, '포커싱 구멍 = 메신저의 대화 페이지 (.ms-page.chat)', JSON.stringify(s5));
  ok(s5.rowIn && s5.rowHit?.ok && !s5.card, '레이븐 대화 줄이 구멍 안에서 눌린다 · 아직 퀘스트 카드는 없다', JSON.stringify(s5));
  ok(s5.objs.join('|') === '레이븐의 연락에 답장|퀘스트 수락', `목표 두 줄 (${s5.objs.join(' | ')})`);
  await page.mouse.click(s5.rowHit.x, s5.rowHit.y);
  /* 2026-09-15 (사용자 결정 — 「확인해야 다음 메시지가 온다」): 대화를 **처음** 열면 안 읽은 인사가 한꺼번에
   * 뜨지 않고 `...`(`.ms-bubble.ms-typing`) 뒤에 하나씩 붙는다. 자동으로 그 연출을 지나는 유일한 경로가
   * 여기다 — 이 단계 전에 레이븐 대화를 여는 곳이 없어 `readAt` 이 0 인 채로 도착한다.
   * 선택지를 기다리는 폴링을 그대로 두면 연출이 있었는지 없었는지 알 수 없으므로, 기다리는 동안 잰다. */
  const s5t = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const lines = S.NPC_DEF_MAP.get('npc_raven').intro.length;
    const bubbles = () => document.querySelectorAll('.ms-tbody .ms-msg.in:not(.typing) .ms-bubble').length;
    const t0 = performance.now();
    const out = { lines, first: bubbles(), typing: false, last: 0, ms: -1 };
    while (performance.now() - t0 < 12000) {
      if (document.querySelector('.ms-bubble.ms-typing')) out.typing = true;
      const n = bubbles();
      if (n > out.last) out.last = n;
      if (document.querySelectorAll('.ms-tbody .ms-choice').length === 2) { out.ms = Math.round(performance.now() - t0); break; }
      await new Promise((r) => setTimeout(r, 30));
    }
    return out;
  });
  ok(s5t.lines >= 2 && s5t.first < s5t.lines && s5t.typing && s5t.last >= s5t.lines,
    `안 읽은 인사가 ... 뒤에 하나씩 도착한다 (첫 ${s5t.first} → ${s5t.last} / ${s5t.lines}줄, ${s5t.ms} ms)`, JSON.stringify(s5t));
  await waitFor(page, () => document.querySelectorAll('.ms-tbody .ms-choice').length === 2, 'Raven choices', 10000);
  const s5a = await P(async () => {
    const S = await import('/src/shared/index.ts');
    const d = S.NPC_DEF_MAP.get('npc_raven');
    const body = document.querySelector('.ms-tbody')?.textContent ?? '';
    const choice = document.querySelector('.ms-tbody .ms-choice[data-choice="0"]');
    return {
      intro: d.intro.every((l) => body.includes(l)), after: d.introAfter.some((l) => body.includes(l)),
      labels: [...document.querySelectorAll('.ms-tbody .ms-choice')].map((b) => b.textContent),
      want: d.introChoices, card: !!document.querySelector('.ms-qcard'), quest: window.__game.ctx.meta.npc.getQuest('q_rv_0'),
      hit: window.__hit(choice),
      talkDone: window.__objDone('레이븐의 연락에 답장'),
      reply: d.introChoiceReplies[0].slice(0, 24), lastAfter: d.introAfter[d.introAfter.length - 1].slice(0, 24),
    };
  });
  ok(s5a.intro && !s5a.after && s5a.labels.join('|') === s5a.want.join('|'),
    '대화를 열면 인사 전부 + 내 대답 버튼 두 개 — 본론(introAfter)은 아직 없다', JSON.stringify(s5a));
  ok(!s5a.card && s5a.quest === null && s5a.talkDone === false, '대답하기 전에는 퀘스트 제안도 카드도 없다 · 목표도 그대로', JSON.stringify(s5a));
  ok(s5a.hit?.ok, '대답 버튼이 어두운 판에 가리지 않는다', JSON.stringify(s5a.hit));

  // real click on the first answer, then watch the thread in-page: reply → introAfter → quest card, with the typing bubble between
  await page.mouse.click(s5a.hit.x, s5a.hit.y);
  const tl = await P(async (want) => {
    const t0 = performance.now();
    const out = { me: -1, reply: -1, after: -1, card: -1, typing: false, afterAtCard: false, offeredAt: null, cardBefore: null };
    const npc = window.__game.ctx.meta.npc;
    out.offeredAt = npc.getQuest('q_rv_0')?.state ?? null;
    out.cardBefore = !!document.querySelector('.ms-qcard');
    while (performance.now() - t0 < 30000) {
      const body = document.querySelector('.ms-tbody');
      const txt = body?.textContent ?? '';
      const now = Math.round(performance.now() - t0);
      if (out.me < 0 && [...(body?.querySelectorAll('.ms-msg.out .ms-bubble') ?? [])].some((b) => b.textContent === want.label)) out.me = now;
      if (out.reply < 0 && txt.includes(want.reply)) out.reply = now;
      if (out.after < 0 && txt.includes(want.lastAfter)) out.after = now;
      if (body?.querySelector('.ms-typing')) out.typing = true;
      if (body?.querySelector('.ms-qcard[data-quest="q_rv_0"]')) { out.card = now; out.afterAtCard = txt.includes(want.lastAfter); break; }
      await new Promise((r) => setTimeout(r, 30));
    }
    out.choicesLeft = document.querySelectorAll('.ms-tbody .ms-choice').length;
    return out;
  }, { label: s5a.want[0], reply: s5a.reply, lastAfter: s5a.lastAfter });
  ok(tl.offeredAt === 'offered' && tl.cardBefore === false, '대답한 그 자리에서 q_rv_0 이 제안되지만 카드는 타이핑 연출 뒤에 온다', JSON.stringify(tl));
  ok(tl.me >= 0 && tl.me < 400 && tl.choicesLeft === 0, `내 대답은 곧바로 붙고 선택지 줄이 사라진다 (${tl.me} ms)`, JSON.stringify(tl));
  ok(tl.typing && tl.reply > tl.me && tl.after > tl.reply && tl.card > tl.after && tl.afterAtCard,
    `답 → 본론(introAfter) → 퀘스트 카드 순서 (${tl.reply} → ${tl.after} → ${tl.card} ms, 사이마다 … 말풍선)`, JSON.stringify(tl));
  await sleep(700);
  const objOrder = await P(() => ({
    talk: window.__objDone('레이븐의 연락에 답장'), accept: window.__objDone('퀘스트 수락'),
    step: window.__game.ctx.tutorial.step,
  }));
  ok(objOrder.talk === true && objOrder.accept === false && objOrder.step === 'ravenQuest',
    '목표는 순서대로 체크된다 — 대답하면 「대답한다」만, 「수락한다」는 아직', JSON.stringify(objOrder));

  // the spotlight re-aims at the card (same step, same tip — `.ms-qcard` is the first selector) and 수락 is clickable
  await waitFor(page, () => window.__lit() && window.__holeIs(window.__shown('.ms-qcard')), 'spotlight on quest card', 8000).catch(() => null);
  const acc = await P(() => {
    const card = window.__shown('.ms-qcard[data-quest="q_rv_0"]');
    const btn = card?.querySelector('[data-act="accept"]') ?? null;
    btn?.scrollIntoView({ block: 'nearest' });
    return { onCard: window.__holeIs(card), hit: window.__hit(btn), acts: [...(card?.querySelectorAll('[data-act]') ?? [])].map((b) => b.dataset.act) };
  });
  ok(acc.onCard && acc.acts.join('|') === 'accept' && acc.hit?.ok, '포커싱이 퀘스트 카드로 옮겨 가고 [수락] 이 눌린다', JSON.stringify(acc));
  const n0 = await P(() => window.__ev['tutorial:changed'].length);
  if (acc.hit) await page.mouse.click(acc.hit.x, acc.hit.y);
  await waitFor(page, () => window.__ev['tutorial:finished'].some((f) => f.track === 'ship'), 'tutorial:finished ship', 10000).catch(() => null);
  await sleep(400);
  const s5z = await P((n0) => {
    const t = window.__game.ctx.tutorial, npc = window.__game.ctx.meta.npc;
    return {
      fin: window.__ev['tutorial:finished'].filter((f) => f.track === 'ship'),
      quest: npc.getQuest('q_rv_0')?.state ?? null,
      qEv: window.__ev['npc:questChanged'].map((e) => `${e.id}:${e.state}`),
      log: window.__ev['npc:message'].filter((m) => m.npc === 'npc_raven').map((m) => m.entry.e),
      trail: window.__ev['tutorial:changed'].slice(n0).map((e) => `${e.track ?? '-'}:${e.step}:${e.index}/${e.count}`),
      track: t.track, step: t.step, shipDone: t.isTrackDone('ship'),
      save: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
      popup: !(document.querySelector('.tut-popup')?.hidden ?? true), popupTitle: document.querySelector('.tut-popup-card .title')?.textContent ?? '',
      messengerOpen: !(document.querySelector('.community-panel')?.hidden ?? true), hidesCommunity: t.hides('community'),
    };
  }, n0);
  ok(s5z.quest === 'active' && s5z.qEv.join(',') === 'q_rv_0:offered,q_rv_0:active' && s5z.log.join(',') === 'choice,offer,accept',
    '[수락] → q_rv_0 active (사건: choice → offer → accept)', JSON.stringify(s5z));
  ok(s5z.fin.length === 1 && s5z.fin[0].skipped === false && s5z.shipDone && s5z.save?.tracks?.ship?.done === true,
    '함선 트랙이 끝난다 — tutorial:finished {ship, skipped:false}', JSON.stringify(s5z.fin));
  ok(s5z.track === 'build' && s5z.step === 'intro' && s5z.popup && s5z.popupTitle === '튜토리얼'
    && s5z.trail.join(' ') === '-:null:0/4 build:intro:1/16',
  `같은 함선에서 곧바로 증축 트랙이 시작된다 (${s5z.trail.join(' → ')})`, JSON.stringify(s5z));
  ok(!s5z.messengerOpen && s5z.hidesCommunity === true,
    '증축 트랙은 메신저를 다시 감추므로 열려 있던 메신저가 닫힌다 (현재 동작)', JSON.stringify(s5z));

  ok(errors.length === 0, `no console errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors (${((Date.now() - T0) / 1000).toFixed(1)} s)`);
process.exit(fail === 0 ? 0 : 1);
