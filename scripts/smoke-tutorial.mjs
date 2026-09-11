// Single-player smoke test for the tutorial (src/tutorial, 2026-09-08).
// Covers: auto-start on a fresh profile only, the intro card, the objective panel + progress, the strict gates
// (room purpose / furniture / craft / terminal / planet / pod / screen tabs), the community + matchmaking hiding,
// the spotlight (dark panes + ring on the step's target), the 3D floor guide, the one-time material grant,
// step persistence across a reload, the 건너뛰기 confirm card and the console command.
// 2026-09-08: + the 발전기 step, "잠그지 않고 감춘다" (`hides(gate, id)` → 용도 · 화면 탭이 목록에서 빠진다),
// the objective panel staying above the spotlight (`.tut-panel.is-lifted`) and the cursor showing under the card.
// 2026-09-09: 17 steps — the bench makes 소총 → 탄약 in **one** window (craftGun → craftAmmo → openBag → equipGun → stowAmmo,
// `openCraft` left the order and a save holding it maps to craftAmmo), the spotlight + floor guide appear
// `TUTORIAL_STEP_DELAY_S` (0.5 s) **after** the target shows up (so every spotlight assertion here waits instead of
// reading right away), the dim panes fade in over `TUTORIAL_DIM_FADE_S` (`.tut-spot.is-lit`, `--tut-dim-fade`),
// equipGun lights 주무기 I · II + 가방 only and accepts 주무기 II.
//   • the whole craft flow is now **driven for real** (inventory.craft × 2 → close → equip) instead of `goto`, so the
//     recorded `tutorial:changed` trail doubles as the step-order assertion (11 steps, 1..11 / 17, no `openCraft`).
//   • the half-beat is **measured** in-page (lit before → not lit right after the step advances → still counting at
//     0.3 s → lit again ~0.5 s later), bounded on both sides, for the spotlight and the 3D floor guide alike.
//   • spotlight geometry is read off the **four dark panes** (`window.__hole` / `window.__spotOn`), never the ring —
//     the ring has a slow scale animation, so its `getBoundingClientRect` wobbles frame to frame.
// 2026-09-10: 제작 대개편으로 `bulk_ammo_medium`(대량 제작, 90발)이 csv 에서 사라졌다 — 탄약 단계는
// `make_ammo_medium`(화약 6 · 폐금속 2 → 30발)이다. 그래서 여기서 두 가지를 더 못 박는다:
//   • 그 레시피가 **작업대 창에 뜰 수 있는 모양**인가 (`station: 'field'` · `bench` 없음).
//   • `stowAmmo` 가 **수량을 전제하지 않는가** — 만든 양(= csv 의 `outputQty`, 스모크에 숫자를 적지 않는다)이
//     얼마든 가방에 있기만 하면 `terminal` 로 넘어간다.
// Usage: node scripts/smoke-tutorial.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  });
  // single-player: park vite HMR + the relay socket so no server profile lands mid-run
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });

  const setup = async () => {
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.tutorial, 'boot');
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      /* 스포트라이트가 지금 뚫고 있는 구멍. **링(`.tut-spot-ring`)으로 재지 않는다** — 링에는 천천히
         확대-축소하는 애니메이션(`@keyframes tut-ring`, scale 1 → 1.045)이 걸려 있어 `getBoundingClientRect`
         가 프레임마다 흔들린다. 네 판이 남긴 사각형은 변형이 없어 `place()` 가 굳힌 정수 모서리 그대로다. */
      window.__hole = () => {
        const p = [...document.querySelectorAll('.tut-spot-pane')].map((e) => e.getBoundingClientRect());
        if (p.length !== 4) return null;
        const [top, bottom, left, right] = p;
        return { left: left.right, right: right.left, top: top.bottom, bottom: bottom.top };
      };
      /**
       * 그 선택자들에 대해 스포트라이트가 **정확히 옳은 자리**를 뚫고 있나. `parts/Spotlight` 와 같은 규칙으로
       * 기대 사각형을 만든다: 먼저 찾히는 하나(`union` 이면 찾히는 전부의 합집합) → `PAD`(6 px) 만큼 넓힘 →
       * floor / ceil 로 정수 모서리 → 화면 밖으로는 안 나간다.
       */
      window.__spotOn = (selectors, union = false) => {
        const hole = window.__hole();
        const tip = document.querySelector('.tut-spot-tip')?.textContent ?? '';
        if (!hole) return { hole: null, tip };
        const vis = (s) => {
          const e = document.querySelector(s);
          return e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' ? e : null;
        };
        const found = [];
        for (const s of selectors) { const e = vis(s); if (e) { found.push({ s, b: e.getBoundingClientRect() }); if (!union) break; } }
        if (found.length === 0) return { hole, tip, sel: null };
        const b = {
          left: Math.min(...found.map((f) => f.b.left)), top: Math.min(...found.map((f) => f.b.top)),
          right: Math.max(...found.map((f) => f.b.right)), bottom: Math.max(...found.map((f) => f.b.bottom)),
        };
        const want = {
          left: Math.max(0, Math.floor(b.left - 6)), top: Math.max(0, Math.floor(b.top - 6)),
          right: Math.min(window.innerWidth, Math.ceil(b.right + 6)), bottom: Math.min(window.innerHeight, Math.ceil(b.bottom + 6)),
        };
        const near = (x, y) => Math.abs(x - y) <= 1;
        return {
          sel: found.map((f) => f.s), tip, hole, want,
          exact: near(hole.left, want.left) && near(hole.top, want.top) && near(hole.right, want.right) && near(hole.bottom, want.bottom),
        };
      };
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['tutorial:changed', 'tutorial:finished', 'ui:notify', 'housing:roomPurposeChanged', 'housing:furniturePlaced', 'craft:completed']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    });
  };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const step = () => P(() => window.__game.ctx.tutorial.step);
  const waitStep = (s) => waitFor(page, (want) => window.__game.ctx.tutorial.step === want, `step ${s}`, 30000, s);
  /* 2026-09-09: 스포트라이트는 대상이 나타난 뒤 `TUTORIAL_STEP_DELAY_S`(0.5 s) 를 세고서야 켜진다 — 새 화면이 먼저
     보이고 판 · 링 · 말풍선이 뒤따른다 (`parts/Spotlight.wait`). 그래서 이 스모크는 어디서도 "지금 떠 있나"를
     곧바로 읽지 않고 **켜질 때까지 기다린다**: `.tut-spot` 이 보이고 · 페이드가 시작됐고(`.tut-spot.is-lit`) ·
     말풍선이 이 단계의 것일 때. 타임아웃은 그대로 짧게 둬서 정말 안 뜨는 회귀는 여전히 실패한다. */
  /* 2026-09-09: 스포트라이트는 대상이 나타난 뒤 `TUTORIAL_STEP_DELAY_S`(0.5 s) 를 세고서야 켜진다 — 새 화면이
     먼저 보이고 판 · 링 · 말풍선이 뒤따른다 (`parts/Spotlight.wait`). 그래서 이 스모크는 어디서도 "지금 떠
     있나"를 곧바로 읽지 않고 **켜질 때까지 기다린다**: `.tut-spot` 이 보이고 · 페이드가 시작됐고
     (`.tut-spot.is-lit`) · 말풍선이 이 단계의 것일 때. 타임아웃은 반 박자의 서른 배쯤으로 짧게 둔다 — 카운터가
     0 을 지나쳐 다시 세는 회귀(2026-09-09 에 고친 그 버그)가 돌아오면 여기서 곧바로 실패해야 한다. */
  const waitSpot = (re, label, timeout = 15000) => waitFor(page, (src) => {
    const r = document.querySelector('.tut-spot');
    if (!r || r.hidden || !r.classList.contains('is-lit')) return false;
    return new RegExp(src).test(document.querySelector('.tut-spot-tip')?.textContent ?? '');
  }, label, timeout, re);
  /**
   * `window.__tutAct()` 가 단계를 넘긴 뒤 **바닥 안내선**이 언제 깔리는지 페이지 안에서 잰다 (왕복 지연이
   * 0.5 s 를 먹지 않도록 조작 · 판정 · 계측을 한 evaluate 안에서 끝낸다).
   *   • `immediate` — 조작 직후에도 깔려 있나 (있으면 안 된다: 새 화면이 먼저 보여야 한다)
   *   • `ms` — 깔리기까지 걸린 시간 (= `TUTORIAL_STEP_DELAY_S`)
   */
  const measureGuide = () => P(async () => {
    const lit = () => { const g = window.__game.ctx.scene.getObjectByName('TutorialGuide'); return !!g && g.children.length === 3; };
    const before = lit();
    const t0 = performance.now();
    const acted = window.__tutAct();
    const immediate = lit();
    let ms = -1;
    while (performance.now() - t0 < 8000) {
      if (lit()) { ms = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 16));
    }
    return { acted, before, immediate, ms };
  });
  const enterShip = async () => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
    await sleep(400);
  };
  const clickPopup = (label) => P((l) => {
    const b = [...document.querySelectorAll('.tut-popup-card .acts .ui-btn')].find((x) => x.textContent === l);
    if (!b) return false;
    b.click();
    return true;
  }, label);

  await page.goto(BASE, { waitUntil: 'load' });
  await setup();
  await P(() => { try { localStorage.removeItem('scav.s1.tutorial'); } catch { /* off */ } });

  /* ── 1. 자동 시작 + 시작 카드 ────────────────────────────────────────── */
  console.log('자동 시작');
  await enterShip();
  await waitStep('intro');
  const intro = await P(() => ({
    popup: !document.querySelector('.tut-popup')?.hidden,
    title: document.querySelector('.tut-popup-card .title')?.textContent,
    acts: [...document.querySelectorAll('.tut-popup-card .acts .ui-btn')].map((b) => b.textContent),
    blocker: window.__game.ctx.uiBlockers.has('tutorial'),
    cursor: window.__game.ctx.input.isCursorMode,
    panel: !document.querySelector('.tut-panel')?.hidden,
    cursorOn: document.body.classList.contains('cursor-on'),
    ev: window.__ev['tutorial:changed'].slice(-1)[0],
  }));
  ok(intro.popup && intro.title === '튜토리얼' && intro.acts.join(',') === '건너뛰기,시작', '새 프로필로 함선에 들어오면 시작 카드가 뜬다', JSON.stringify(intro.acts));
  ok(intro.blocker && intro.cursor, '시작 카드가 tutorial 블로커 + 소프트 커서를 잡는다', JSON.stringify({ b: intro.blocker, c: intro.cursor }));
  ok(intro.panel, '좌측 상단 목표 패널이 함께 뜬다');
  // 2026-09-08: 함선에 들어서며 걸린 relock 이 카드에서 커서를 빼앗아 가면 안 된다 (버튼을 누를 수가 없다)
  ok(intro.cursorOn, '카드가 뜬 채로 마우스 커서가 살아 있다 (body.cursor-on)');
  ok(intro.ev && intro.ev.active === true && intro.ev.step === 'intro' && intro.ev.count === 17, `tutorial:changed {intro, 1/17} (${JSON.stringify(intro.ev)})`);
  const order = await P(() => window.__game.getSystem('tutorial').constructor && null);
  void order;

  /* ── 2. 게이트가 순서를 강제한다 ────────────────────────────────────── */
  console.log('게이트');
  const gated = await P(() => {
    const t = window.__game.ctx.tutorial;
    return {
      lounge: t.blockReason('roomPurpose', 'lounge'), workshop: t.blockReason('roomPurpose', 'workshop'),
      board: t.blockReason('board'), terminal: t.blockReason('terminal'),
      inv: t.blockReason('screenTab', 'inventory'), corp: t.blockReason('screenTab', 'corp'),
      hidesCommunity: t.hides('community'), hidesNet: t.hides('matchmaking'),
      hidesLounge: t.hides('roomPurpose', 'lounge'), hidesWorkshop: t.hides('roomPurpose', 'workshop'),
      hidesCorp: t.hides('screenTab', 'corp'), hidesInv: t.hides('screenTab', 'inventory'),
      hidesPlanet: t.hides('planet'),
    };
  });
  ok(!!gated.lounge && !!gated.workshop && !!gated.board && !!gated.terminal, 'intro 단계에서는 아무것도 못 한다', JSON.stringify(gated));
  ok(gated.inv === null && !!gated.corp, '인벤토리 탭은 언제나 열려 있고 나머지 탭은 잠긴다', JSON.stringify({ inv: gated.inv, corp: gated.corp }));
  ok(gated.hidesCommunity && gated.hidesNet, '커뮤니티 버튼과 매치메이킹은 숨긴다');
  ok(gated.hidesLounge && gated.hidesCorp && !gated.hidesInv && gated.hidesPlanet,
    '막힌 항목은 숨김 대상이기도 하다 (인벤토리 탭만 예외)', JSON.stringify(gated));
  const podBlocked = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    return { prompt: it?.getPrompt() ?? null, boarded: window.__game.getSystem('hub').boardedSlot };
  });
  ok(/튜토리얼/.test(podBlocked.prompt ?? '') && podBlocked.boarded < 0, `발사 슬롯 프롬프트가 튜토리얼 사유를 보여준다 ("${podBlocked.prompt}")`);
  const termBlocked = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal');
    return { can: it?.canInteract() ?? null, prompt: it?.getPrompt() ?? null };
  });
  ok(termBlocked.can === false && termBlocked.prompt === null, '터미널도 아직 잠겨 있다', JSON.stringify(termBlocked));
  const communityHidden = await P(() => document.querySelector('.community')?.classList.contains('show') ?? null);
  ok(communityHidden === false, '커뮤니티 버튼이 실제로 숨겨진다');

  /* ── 3. 하우징 · 작업실 · 작업대 ─────────────────────────────────────── */
  console.log('하우징 → 작업실 → 작업대');
  ok(await clickPopup('시작'), '시작 버튼');
  await waitStep('manage');
  const afterIntro = await P(() => ({
    popup: document.querySelector('.tut-popup').hidden,
    blocker: window.__game.ctx.uiBlockers.has('tutorial'),
    title: document.querySelector('.tut-panel .tut-title')?.textContent,
  }));
  ok(afterIntro.popup && !afterIntro.blocker && /함선 관리/.test(afterIntro.title ?? ''), '카드가 닫히고 목표가 함선 관리로 바뀐다', JSON.stringify(afterIntro));
  /* 2026-09-08: 이 단계에는 열린 화면이 없다 — 밝힐 것은 우측 하단에 늘 떠 있는 `시설 관리` 키 힌트
     (`ui/hud/ShipManageHint`, `.ship-hint`) 다. 어디를 봐야 하는지부터 알려 준다. */
  await waitSpot('시설 관리', 'spotlight (시설 관리 힌트)');
  const manageSpot = await P(() => {
    const r = window.__hole();
    const h = document.querySelector('.ship-hint').getBoundingClientRect();
    return { tip: document.querySelector('.tut-spot-tip')?.textContent ?? '', dx: Math.round(Math.abs(r.left - h.left)), dy: Math.round(Math.abs(r.top - h.top)) };
  });
  ok(/시설 관리/.test(manageSpot.tip) && manageSpot.dx <= 10 && manageSpot.dy <= 10,
    '포커싱이 우측 하단 시설 관리 버튼에 붙는다', JSON.stringify(manageSpot));
  /* ── 3b. 발전기 단계 (2026-09-08) ──────────────────────────────────── */
  await P(() => window.__game.ctx.housing.openShipManage(0));
  await waitStep('generator');
  // 재료를 채운다 — 발전기 가동과 작업실 증축에 필요하다
  await P(() => {
    const ctx = window.__game.ctx;
    const give = (id, n) => { const max = ctx.loot.getItemDef(id).stackMax ?? 1; let a = 0; while (a < n) { const q = Math.min(max, n - a); if (!ctx.inventory.tryAddItem(ctx.loot.createItem(id, q))) break; a += q; } };
    give('mat_scrap', 40); give('mat_cable', 8); give('mat_alloy', 8);
  });
  // 2026-09-08: `manage` 단계부터 스포트라이트가 이미 떠 있으므로 (우측 하단 시설 관리 힌트) "보이는가"로는
  //   모자란다 — 대상이 발전기로 옮겨 붙을 때까지(`RETARGET_INTERVAL` + 2026-09-09 의 반 박자) 말풍선을 보고 기다린다.
  await waitSpot('발전기', 'spotlight (발전기)');
  const genUi = await P(() => ({
    gen: !!document.querySelector('.sm-gen .sm-gen-btn'),
    purposes: [...document.querySelectorAll('.sm-purposes .sm-purpose')].map((b) => b.dataset.purpose),
    tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
    lifted: document.querySelector('.tut-panel')?.classList.contains('is-lifted') ?? false,
  }));
  ok(genUi.gen, '발전기 행이 있다 (2026-09-12: 용도 목록이 아니라 방 목록 아래)');
  ok(genUi.purposes.length === 1 && genUi.purposes[0] === 'workshop',
    '작업실 외의 용도는 사유가 아니라 아예 목록에서 빠진다', JSON.stringify(genUi.purposes));
  ok(/발전기/.test(genUi.tip), `말풍선이 발전기를 가리킨다 ("${genUi.tip}")`);
  ok(genUi.lifted, '포커싱 중에도 목표 패널은 어두운 판 위에 있다 (건너뛰기 클릭 가능)');

  /* ── 3b-2. 반 박자 늦게 켜지는 포커싱 (2026-09-09) ──────────────────────
     발전기 → 작업실은 **같은 목록 안**의 이동이라 다음 대상(`.sm-purpose[data-purpose="workshop"]`)이 이미
     화면에 있다. 그래도 스포트라이트는 단계가 넘어가는 순간 곧바로 접히고, `TUTORIAL_STEP_DELAY_S`(0.5 s)
     뒤에야 새 자리에서 다시 켜진다 — "새 화면이 먼저 보이고 포커싱이 따라온다". 켜질 때 어두운 판은
     `--tut-dim-fade`(= `TUTORIAL_DIM_FADE_S`) 동안 서서히 어두워진다 (`.tut-spot.is-lit`). */
  const relight = await P(async () => {
    const spot = () => document.querySelector('.tut-spot');
    const lit = () => { const r = spot(); return !!r && !r.hidden && r.classList.contains('is-lit'); };
    const sp = () => window.__game.getSystem('tutorial').spotlight;
    const before = lit();
    const t0 = performance.now();
    const acted = window.__game.ctx.housing.upgrade('generator');     // generator → workshop
    const immediate = lit();
    let midway = null, ms = -1;
    while (performance.now() - t0 < 15000) {
      // 반 박자(0.5 s)의 절반쯤에서 한 번 들여다본다 — `Spotlight.pending` 이 "대상은 보이는데 아직 세고 있다"
      if (!midway && performance.now() - t0 >= 300) midway = { lit: lit(), pending: sp().pending, wait: Math.round(sp().wait * 1000) };
      if (lit()) { ms = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 8));
    }
    return {
      acted, before, immediate, midway, ms,
      tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
      fade: getComputedStyle(spot()).getPropertyValue('--tut-dim-fade').trim(),
    };
  });
  ok(relight.acted === true, '발전기를 가동한다');
  ok(relight.before === true && relight.immediate === false,
    '단계가 넘어가는 순간 포커싱이 곧바로 접힌다 (다음 대상이 이미 화면에 있어도)', JSON.stringify(relight));
  ok(relight.midway && relight.midway.lit === false && relight.midway.pending === true && relight.midway.wait > 0,
    `0.3 s 뒤에도 아직 어둡고 반 박자를 세고 있다 (남은 ${relight.midway?.wait} ms)`, JSON.stringify(relight));
  /* 위아래를 모두 못 박는다. 아래는 "곧바로 켜지지 않는다"(≥ 0.3 s), 위는 "언젠가가 아니라 반 박자"(< 2 s —
     카운터가 0 을 지나쳐 0.5 초를 다시 세던 2026-09-09 의 버그가 돌아오면 여기서 실패한다). */
  ok(relight.ms >= 300 && relight.ms < 2000 && /작업실/.test(relight.tip),
    `반 박자(TUTORIAL_STEP_DELAY_S 0.5 s) 뒤에 새 대상에서 다시 켜진다 (${Math.round(relight.ms)} ms, "${relight.tip}")`, JSON.stringify(relight));
  ok(relight.fade === '0.5s', `어두운 판은 --tut-dim-fade 동안 서서히 어두워진다 ("${relight.fade}")`);
  await waitStep('workshop');

  // 다른 용도는 여전히 거부된다 (엄격 강제)
  const wrongPurpose = await P(() => {
    const h = window.__game.ctx.housing;
    return { lounge: h.setRoomPurpose(1, 'lounge'), block: h.purposeBlock(1, 'lounge'), purpose: h.getRoom(1).purpose };
  });
  ok(wrongPurpose.lounge === false && /작업실/.test(wrongPurpose.block ?? '') && wrongPurpose.purpose === 'empty',
    '작업실이 아닌 용도는 거부된다 (사유에 작업실이 나온다)', JSON.stringify(wrongPurpose));
  // 스포트라이트는 반 박자 뒤에 대상을 찾아 자리를 잡는다 — 말풍선이 바뀔 때까지 기다린다
  await waitSpot('작업실', 'spotlight (작업실)');
  const spot = await P(() => {
    const r = document.querySelector('.tut-spot');
    return {
      shown: r && !r.hidden, panes: document.querySelectorAll('.tut-spot-pane').length,
      ring: !!document.querySelector('.tut-spot-ring'), tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
    };
  });
  ok(spot.shown && spot.panes === 4 && spot.ring, '스포트라이트가 네 판 + 링으로 떠 있다', JSON.stringify(spot));
  ok(/작업실/.test(spot.tip), `말풍선이 할 일을 적는다 ("${spot.tip}")`);
  ok(await P(() => window.__game.ctx.housing.setRoomPurpose(1, 'workshop')), '작업실 증축은 허용된다');
  await waitStep('bench');
  const wrongFurn = await P(() => {
    const h = window.__game.ctx.housing;
    return { locker: h.craftFurniture('furn_locker'), bench: h.craftFurniture('furn_bench_gun') };
  });
  ok(wrongFurn.locker === false && wrongFurn.bench === true, '총기 작업대만 제작할 수 있다', JSON.stringify(wrongFurn));

  /* ── 3c. 제작 → 가구 창고 → 배치 (2026-09-08) ───────────────────────── */
  // 제작은 가구를 **창고**에 넣을 뿐이다 — 배치는 따로 안내한다 (그 전에는 창고 탭이 어두운 판에 덮여 막혔다)
  await waitStep('benchPlace');
  const stashed = await P(() => ({
    stored: (window.__game.ctx.housing.getStored() ?? []).filter((s) => s.defId === 'furn_bench_gun').reduce((n, s) => n + s.qty, 0),
    placed: window.__game.ctx.housing.getPlaced().length,
  }));
  ok(stashed.stored >= 1 && stashed.placed === 0, '제작한 작업대는 가구 창고에 있고 아직 놓이지 않았다', JSON.stringify(stashed));
  await P(() => window.__game.ctx.housing.setManageRoom(1));
  await waitSpot('가구 창고', 'spotlight (가구 창고)');
  const storeTab = await P(() => {
    const b = document.querySelector('.sm-tabs .sm-tab[data-tab="store"]');
    if (!b) return null;
    b.click();
    return true;
  });
  ok(storeTab === true, "스포트라이트가 집을 수 있는 '가구 창고' 탭 버튼이 있다");
  await sleep(150);
  const storeCard = await P(() => !!document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]'));
  ok(storeCard, '가구 창고 탭에 작업대 카드가 있다');
  /* 2026-09-09: 창고 카드 클릭은 **선택만** 한다 — 고스트 배치가 아니다. 놓는 것은 카드 오른쪽의 `배치` 버튼
     (`.fcard-place`)이고, 그 버튼이 첫 빈 칸에 곧바로 내려놓아 `housing:furniturePlaced` 를 낸다 (튜토리얼 단계는 그 이벤트로 넘어간다). */
  await P(() => document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]').click());
  await sleep(150);
  const picked = await P(() => {
    const card = document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]');
    const btn = card?.querySelector('.fcard-place');
    return {
      sel: window.__game.getSystem('housing').selectedFurniture,
      hl: card?.classList.contains('is-sel') ?? null,
      btn: !!btn, enabled: btn ? !btn.disabled : null, note: card?.querySelector('.fcard-note')?.textContent ?? '',
      placed: window.__game.ctx.housing.getPlaced().length,
    };
  });
  ok(picked.sel === null && picked.hl === true && picked.placed === 0,
    '창고 카드 클릭은 카드를 강조만 한다 — 커서에 가구가 올라오지 않는다', JSON.stringify(picked));
  ok(picked.btn && picked.enabled === true && picked.note === '배치 가능',
    "카드 오른쪽에 활성 '배치' 버튼(.fcard-place) + '배치 가능' 표시", JSON.stringify(picked));
  await P(() => document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"] .fcard-place').click());
  await sleep(150);
  const placed = await P(() => ({
    placed: window.__game.ctx.housing.getPlaced(1).filter((f) => f.defId === 'furn_bench_gun').length,
    ev: window.__ev['housing:furniturePlaced'].slice(-1)[0]?.item?.defId ?? null,
    stored: (window.__game.ctx.housing.getStored() ?? []).filter((s) => s.defId === 'furn_bench_gun').reduce((n, s) => n + s.qty, 0),
  }));
  ok(placed.placed === 1 && placed.ev === 'furn_bench_gun' && placed.stored === 0,
    "'배치' 버튼이 작업대를 작업실 첫 빈 칸에 놓고 housing:furniturePlaced 를 낸다", JSON.stringify(placed));
  await waitStep('manageDone');

  /* ── 4. 재료 지급 + 제작 게이트 ───────────────────────────────────────── */
  console.log('제작');
  /* 2026-09-09: 관리 모드를 닫으면 `craftGun` 으로 넘어가고 **바닥 안내선**이 작업대를 가리킨다 — 그 안내선도
     스포트라이트와 같은 반 박자(`TUTORIAL_STEP_DELAY_S`)를 세고 나서야 씬에 깔린다 (`parts/Guide.wait`). */
  await P(() => { window.__tutAct = () => { window.__game.ctx.housing.closeShipManage(); return true; }; });
  const guideDelay = await measureGuide();
  ok(guideDelay.before === false && guideDelay.immediate === false,
    '관리 모드를 닫은 직후에는 바닥 안내선이 아직 없다', JSON.stringify(guideDelay));
  ok(guideDelay.ms >= 300 && guideDelay.ms < 2000,
    `바닥 안내선도 같은 반 박자 뒤에 깔린다 (${Math.round(guideDelay.ms)} ms)`, JSON.stringify(guideDelay));
  await waitStep('craftGun');
  const grant = await P(() => ({
    powder: window.__game.ctx.inventory.countDefAll('mat_gunpowder'),
    notify: window.__ev['ui:notify'].map((n) => n.text).filter((t) => /보급/.test(t)).length,
    guide: !!window.__game.getSystem('tutorial'),
  }));
  ok(grant.powder >= 20 && grant.notify >= 1, `제작 재료가 한 번 지급된다 (화약 ${grant.powder})`);
  /* 2026-09-09: 제작은 **작업대 한 번**이라 `craftGun` 부터 소총 · 준중량탄 레시피가 **둘 다** 열려 있다
     (막힌 레시피는 목록에서 사라지므로, 소총을 만드는 순간 행이 빠지고 탄약 행이 튀어나오면 목록이 흔들린다). */
  const craftGate = await P(() => {
    const inv = window.__game.ctx.inventory, t = window.__game.ctx.tutorial;
    return {
      gun: inv.canCraft('make_wpn_ar'), other: inv.canCraft('make_bandage'),
      gateGun: t.blockReason('craft', 'make_wpn_ar'), gateAmmo: t.blockReason('craft', 'make_ammo_medium'),
      gateOther: t.blockReason('craft', 'make_bandage'), hidesOther: t.hides('craft', 'make_bandage'),
    };
  });
  ok(craftGate.gun === true && craftGate.other === false, '돌격소총은 만들 수 있고 안내 밖의 레시피는 막힌다', JSON.stringify(craftGate));
  ok(craftGate.gateGun === null && craftGate.gateAmmo === null && !!craftGate.gateOther && craftGate.hidesOther,
    '작업대 한 번에 만드므로 소총 · 준중량탄이 둘 다 열려 있고 나머지는 감춘다', JSON.stringify(craftGate));

  /* ── 4b. 바닥 안내선 ──────────────────────────────────────────────────── */
  console.log('안내선');
  const guide = await P(() => {
    const ctx = window.__game.ctx;
    const g = ctx.scene.getObjectByName('TutorialGuide');
    const bench = ctx.interactables.all().find((i) => i.id.startsWith('hub_furn_'));
    return {
      inScene: !!g, children: g ? g.children.length : 0,
      bench: bench ? [bench.position.x, bench.position.z] : null,
      pillar: g ? g.children.map((c) => c.type) : [],
      dist: bench ? Math.hypot(bench.position.x - ctx.player.position.x, bench.position.z - ctx.player.position.z) : -1,
    };
  });
  ok(guide.inScene && guide.children === 3, `작업대로 가는 안내선이 씬에 있다 (점선 + 빛기둥 + 링, ${guide.children})`, JSON.stringify(guide));
  ok(guide.dist > 2.2, `아직 작업대에서 떨어져 있다 (${guide.dist.toFixed(1)} m)`);
  // 목표에 붙으면 안내선을 걷는다
  const arrived = await P(() => {
    const ctx = window.__game.ctx;
    const bench = ctx.interactables.all().find((i) => i.id.startsWith('hub_furn_'));
    ctx.player.position.set(bench.position.x, ctx.player.position.y, bench.position.z);
    window.__game.getSystem('tutorial').update(0.5, ctx);
    return !!ctx.scene.getObjectByName('TutorialGuide');
  });
  ok(!arrived, '목표에 도착하면 안내선이 걷힌다');

  /* ── 4c. 작업대 한 번에: 소총 → 탄약 → 창 닫기 → 장착 (2026-09-09) ────────
     제작 흐름은 **작업대 한 번 방문**이다: `craftGun` → `craftAmmo` (같은 창) → `openBag`(창 닫기) →
     `equipGun` → `stowAmmo`. `openCraft`(가방의 제작 버튼으로 창을 다시 열기)는 그래서 순서에서 빠졌다.
     제작 중에는 장비 칸이 숨으므로 만든 무기는 **제작 창을 닫고** 장착하고, `equipGun` 은 주무기 I · II 칸과
     가방을 **합집합**으로 밝힌다 (하나만 밝히면 드래그의 반대편이 어두운 판에 깔린다). */
  console.log('작업대: 소총 → 탄약 → 닫기 → 장착');
  await P(() => window.__game.ctx.inventory.openBenchCraft('gun', 1));
  await sleep(300);
  const crafting = await P(() => {
    const css = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'gone'; };
    return {
      isCraft: document.querySelector('.inv-root').classList.contains('is-craft'),
      equip: css('.inv-equip'), quick: css('.inv-quick'), tabs: css('.inv-root .scr-tabs'),
      foot: css('.inv-panel-bag > .inv-foot'), craftBtn: css('.inv-bag-craft'),
      repairBtn: document.querySelector('.inv-repair-open') ? !document.querySelector('.inv-repair-open').hidden : null,
    };
  });
  ok(crafting.isCraft && crafting.equip === 'none' && crafting.quick === 'none' && crafting.tabs === 'none'
    && crafting.foot === 'none' && crafting.craftBtn === 'none',
    '제작 중에는 장비 · 퀵슬롯 · 화면 탭 · 가방의 제작 버튼/가치가 숨는다', JSON.stringify(crafting));
  ok(crafting.repairBtn === true, '총기 작업대 헤더에 `모두 수리` 버튼이 있다');

  /* 소총 행부터. 두 레시피가 같은 창에 함께 떠 있고 스포트라이트만 "지금 만들 것"을 가리킨다. */
  await waitSpot('돌격소총', 'spotlight (돌격소총 제작)');
  const gunRow = await P(() => {
    const row = document.querySelector('.inv-craft-row[data-recipe="make_wpn_ar"]');
    const ammo = document.querySelector('.inv-craft-row[data-recipe="make_ammo_medium"]');
    return {
      row: !!row, ammo: !!ammo, rows: document.querySelectorAll('.inv-craft-row').length,
      spot: window.__spotOn(['.inv-craft-row[data-recipe="make_wpn_ar"] .inv-craft-btn', '.inv-craft-row[data-recipe="make_wpn_ar"]', '.inv-panel-craft']),
    };
  });
  ok(gunRow.row && gunRow.ammo, '작업대 한 창에 소총 · 준중량탄 두 행이 함께 있다 (제작은 한 번의 방문)', JSON.stringify(gunRow));
  ok(gunRow.spot.exact, `craftGun 은 돌격소총 제작 버튼을 밝힌다 ("${gunRow.spot.tip}")`, JSON.stringify(gunRow.spot));

  const gunUid = await P(async () => {
    const it = await window.__game.ctx.inventory.craft('make_wpn_ar');
    return it ? it.uid : null;
  });
  ok(!!gunUid, '작업대에서 돌격소총을 만든다');
  await waitStep('craftAmmo');
  /* 2026-09-09 재료 top-up: 소총이 폐금속을 먹고 나면 준중량탄이 모자란다 — `craftAmmo` 에 들어서는 순간
     `ensureMaterials` 가 `필요 − 보유` 만큼만 채운다 (숫자는 레시피에서 읽으므로 코드에 없다). */
  const ammoReady = await P(() => ({
    can: window.__game.ctx.inventory.canCraft('make_ammo_medium'),
    powder: window.__game.ctx.inventory.countWhere((d) => d.id === 'mat_gunpowder'),
    scrap: window.__game.ctx.inventory.countWhere((d) => d.id === 'mat_scrap'),
    craftOpen: !!document.querySelector('.inv-panel-craft') && document.querySelector('.inv-root').classList.contains('is-craft'),
    gun: window.__game.ctx.inventory.countDefAll('wpn_ar'),
  }));
  ok(ammoReady.craftOpen, '탄약 단계는 **같은 작업대 창**이 열린 채로 이어진다 (창을 다시 열지 않는다)', JSON.stringify(ammoReady));
  ok(ammoReady.can && ammoReady.gun >= 1,
    `준중량탄 재료가 채워져 있다 (화약 ${ammoReady.powder} · 폐금속 ${ammoReady.scrap})`, JSON.stringify(ammoReady));
  await waitSpot('준중량탄', 'spotlight (준중량탄 제작)');
  const ammoRow = await P(() => window.__spotOn(['.inv-craft-row[data-recipe="make_ammo_medium"] .inv-craft-btn', '.inv-craft-row[data-recipe="make_ammo_medium"]', '.inv-panel-craft']));
  ok(ammoRow.exact, `포커싱이 같은 창의 준중량탄 행으로 옮겨 간다 ("${ammoRow.tip}")`, JSON.stringify(ammoRow));
  ok(await P(async () => !!(await window.__game.ctx.inventory.craft('make_ammo_medium'))), '같은 창에서 준중량탄을 만든다');
  await waitStep('openBag');

  /* 소총 · 탄약이 다 만들어진 **뒤에야** 제작 창을 닫는다 (`openBag`). */
  await waitSpot('닫기', 'spotlight (제작 창 닫기)');
  const closeSpot = await P(() => window.__spotOn(['.inv-craft-close', '.inv-panel-craft']));
  ok(closeSpot.exact && closeSpot.sel[0] === '.inv-craft-close',
    `openBag 단계는 제작 창의 닫기를 밝힌다 ("${closeSpot.tip}")`, JSON.stringify(closeSpot));
  await P(() => document.querySelector('.inv-craft-close').click());
  await waitStep('equipGun');
  ok(true, '제작 창을 닫으면 장착 단계로 넘어간다');

  /* 2026-09-09: `equipGun` 은 장비 열 **전체**가 아니라 주무기 I · II 칸 + 가방만 밝힌다 — 보조무기 · 방탄복 ·
     가방 칸 · 임플란트 칸은 이 단계와 상관없다. 구멍은 언제나 사각형 하나이므로 셋을 감싸는 최소 사각형이
     되고, `parts/Spotlight.place` 가 `PAD`(6 px)만큼 넓혀 정수 모서리로 굳힌다. */
  await waitSpot('주무기', 'spotlight (주무기 I · II + 가방)');
  const union = await P(() => {
    const s = window.__spotOn(['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-bag'], true);
    const inside = (sel) => {
      const e = document.querySelector(sel);
      if (!e || !s.hole) return null;
      const b = e.getBoundingClientRect();
      return s.hole.left <= b.left && s.hole.right >= b.right && s.hole.top <= b.top && s.hole.bottom >= b.bottom;
    };
    // 예전 선택자(장비 열 **전체** + 가방)로는 어떤 구멍이 됐을지 — 지금 것과 같으면 안 된다
    const old = window.__spotOn(['.inv-root .inv-equip', '.inv-panel-bag'], true);
    return {
      ...s, three: (s.sel ?? []).length, oldWant: old.want, wholeColumn: old.exact,
      primary: inside('.inv-root .inv-equip .inv-slot-primary'), primary2: inside('.inv-root .inv-equip .inv-slot-primary2'),
      bag: inside('.inv-panel-bag'),
    };
  });
  ok(union.exact && union.three === 3 && union.primary && union.primary2 && union.bag,
    'equipGun 은 주무기 I · II 칸 + 가방을 한 구멍으로 밝힌다 (합집합)', JSON.stringify(union));
  ok(union.wholeColumn === false,
    '장비 열 **전체**가 아니다 — 보조무기 · 방탄복 · 가방 칸 · 임플란트 칸은 이 단계와 상관없다', JSON.stringify(union));

  /* 2026-09-09: 여기까지 오는 동안 실제로 밟은 단계 · 순번이 새 순서 그대로인가 (`openCraft` 는 없다). */
  const seq = await P(() => window.__ev['tutorial:changed'].filter((e) => e.active).map((e) => ({ s: e.step, i: e.index, n: e.count })));
  const WANT = ['intro', 'manage', 'generator', 'workshop', 'bench', 'benchPlace', 'manageDone', 'craftGun', 'craftAmmo', 'openBag', 'equipGun'];
  ok(seq.map((e) => e.s).join(' ') === WANT.join(' '), `밟은 단계가 새 순서 그대로다 (${seq.map((e) => e.s).join(' ')})`);
  ok(seq.every((e, i) => e.i === i + 1 && e.n === 17) && !seq.some((e) => e.s === 'openCraft'),
    '순번은 1..11 / 17 이고 openCraft 는 순서에 없다', JSON.stringify(seq.slice(-3)));

  /* 2026-09-09: 어두운 판 네 장이 화면을 **빈틈없이** 덮는가. 예전에는 판마다 top/height 를 따로 반올림해서
     소수점 사각형이면 구멍 위아래에 1 px 짜리 밝은 가로줄이 남았다 (8단계에서 특히 잘 보였다). */
  const tiling = await P(() => {
    const p = [...document.querySelectorAll('.tut-spot-pane')].map((e) => e.getBoundingClientRect());
    if (p.length !== 4) return { ok: false, why: `panes=${p.length}` };
    const [top, bottom, left, right] = p;
    const int = (v) => Math.abs(v - Math.round(v)) < 0.001;
    return {
      ok: int(top.bottom) && int(bottom.top) && int(left.top) && int(left.bottom)
        && left.top === top.bottom && right.top === top.bottom
        && left.bottom === bottom.top && right.bottom === bottom.top,
      seamTop: top.bottom, leftTop: left.top, seamBottom: bottom.top, leftBottom: left.bottom,
    };
  });
  ok(tiling.ok, '스포트라이트 네 판이 정수 모서리로 빈틈없이 맞물린다 (1 px 띠 없음)', JSON.stringify(tiling));

  /* 2026-09-09: 목표 패널은 인벤토리 창(.inv-root, z 50 + 블러) 위에 **언제나** 있다 (예전에는 포커싱 중에만). */
  const zorder = await P(() => ({
    panel: Number(getComputedStyle(document.querySelector('.tut-panel')).zIndex),
    inv: Number(getComputedStyle(document.querySelector('.inv-root')).zIndex),
  }));
  ok(zorder.panel > zorder.inv, `목표 패널이 인벤토리 창 위에 있다 (${zorder.panel} > ${zorder.inv})`, JSON.stringify(zorder));

  /* 2026-09-09: 주무기 **II** 칸에 넣어도 장착 단계는 끝난다 (`TutorialSystem.onLoadout` — I · II 어느 쪽이든). */
  await P((uid) => window.__game.ctx.inventory.equip(uid, 'primary2'), gunUid);
  await waitFor(page, () => ['stowAmmo', 'terminal'].includes(window.__game.ctx.tutorial.step), 'step stowAmmo', 30000);
  const equipped = await P(() => {
    const l = window.__game.ctx.inventory.getLoadout();
    return { step: window.__game.ctx.tutorial.step, primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null };
  });
  // 2026-09-10: 보조무기 칸이 사라져 시작 지급품이 **주무기 I** 에 기관단총을 준다 — 예전처럼 I 칸이 비어 있지 않다.
  ok(equipped.primary2 === 'wpn_ar' && ['stowAmmo', 'terminal'].includes(equipped.step),
    '주무기 II 칸에 장착해도 장착 단계가 끝난다', JSON.stringify(equipped));

  /* ── 4d. 탄약 단계는 수량을 전제하지 않는다 (2026-09-10 제작 대개편) ──────
     `bulk_ammo_medium`(대량 제작, 90발)이 csv 에서 사라져 `make_ammo_medium`(30발)이 그 자리를 잇는다.
     두 가지를 못 박는다 — ① 그 레시피가 **작업대 창에 뜰 수 있는 모양**인가 (`station: 'field'` · `bench` 없음 →
     `getRecipes` 가 bench 모드에서도 싣는다), ② `stowAmmo` 는 "가방에 준중량탄이 있나"만 보므로 **수량과 무관**하다
     (만들어진 양이 곧 레시피의 `outputQty` 이고, 그 값을 여기서도 csv 에서 읽는다 — 스모크에 숫자를 적지 않는다). */
  const ammoRecipe = await P(() => {
    const ctx = window.__game.ctx;
    const r = ctx.loot.getAllRecipes().find((x) => x.id === 'make_ammo_medium');
    return r ? { station: r.station, bench: r.bench ?? null, outputQty: r.outputQty, out: r.outputDefId } : null;
  });
  /* 2026-09-10 (사용자 결정) — 작업대를 열면 **그 작업대의 레시피만** 보인다. 그래서 현장 레시피도
     `data/recipes.csv` 에서 자기 작업대를 밝힌다: 탄약은 `station: field` + `bench: gun` 이라
     어디서든 만들 수 있으면서 총기 작업대 창에도 뜬다 — 튜토리얼의 "같은 창에서 소총 → 탄약" 이 그것에 기댄다. */
  ok(!!ammoRecipe && ammoRecipe.station === 'field' && ammoRecipe.bench === 'gun' && ammoRecipe.out === 'ammo_medium',
    '탄약 레시피는 field 이면서 총기 작업대 소속이다 (어디서든 제작 + 총기 작업대 창에 표시)', JSON.stringify(ammoRecipe));
  const stow = await P(() => {
    const inv = window.__game.ctx.inventory;
    // 만든 탄약이 가방에 못 들어가 창고로 갔으면 그것을 집어 온다 — 그게 `stowAmmo` 단계가 시키는 일이다
    if (inv.countWhere((d) => d.id === 'ammo_medium') === 0) {
      const s = inv.getStashItems().find((it) => it.defId === 'ammo_medium');
      if (s) inv.takeItem(s.uid);
    }
    const rounds = inv.countWhere((d) => d.id === 'ammo_medium');
    if (window.__game.ctx.tutorial.step === 'stowAmmo') inv.afterChange();   // 이미 가방에 있으면 판정을 한 번 깨운다
    return rounds;
  });
  ok(stow >= (ammoRecipe?.outputQty ?? 1), `만든 준중량탄이 가방에 있다 (${stow}발 ≥ outputQty ${ammoRecipe?.outputQty})`);
  await waitFor(page, () => window.__game.ctx.tutorial.step === 'terminal', 'step terminal', 15000);
  ok(await step() === 'terminal', 'stowAmmo 는 수량과 무관하게 넘어간다 (30발이든 90발이든)');

  /* 2026-09-09: 창고에는 튜토리얼이 쓰는 것만 보인다 (`stashItem` 게이트 — 데이터는 그대로, 그리지 않을 뿐) */
  const stashGate = await P(() => {
    const t = window.__game.ctx.tutorial;
    return {
      scrap: t.hides('stashItem', 'mat_scrap'), gun: t.hides('stashItem', 'wpn_ar'),
      ammo: t.hides('stashItem', 'ammo_medium'), other: t.hides('stashItem', 'med_bandage'),
    };
  });
  ok(!stashGate.scrap && !stashGate.gun && !stashGate.ammo && stashGate.other,
    '창고는 튜토리얼 재료 · 소총 · 탄약만 보이고 나머지는 감춘다', JSON.stringify(stashGate));

  await P(() => { window.__game.ctx.inventory.closeAll(); window.__game.ctx.tutorial.goto('craftGun'); });
  await sleep(200);

  /* ── 5. 건너뛰기 확인 카드 ────────────────────────────────────────────── */
  console.log('건너뛰기');
  await P(() => document.querySelector('.tut-panel .tut-skip').click());
  await sleep(150);
  const confirm = await P(() => ({
    open: !document.querySelector('.tut-popup').hidden,
    title: document.querySelector('.tut-popup-card .title')?.textContent,
    acts: [...document.querySelectorAll('.tut-popup-card .acts .ui-btn')].map((b) => b.textContent),
  }));
  ok(confirm.open && /건너뛸까요/.test(confirm.title ?? '') && confirm.acts.join(',') === '계속하기,건너뛰기',
    '건너뛰기 버튼이 확인 카드를 띄운다', JSON.stringify(confirm));

  /* 2026-09-09: 본문 없음 + 건너뛰기는 **채워진 빨간 홀드 버튼** — 짧게 눌러서는 끝나지 않는다. */
  const card = await P(() => {
    const body = document.querySelector('.tut-popup-card .body');
    const skip = [...document.querySelectorAll('.tut-popup-card .acts .ui-btn')].find((b) => b.textContent === '건너뛰기');
    return {
      bodyLines: body ? body.querySelectorAll('p').length : -1,
      bodyShown: body ? getComputedStyle(body).display !== 'none' : true,
      danger: !!skip?.classList.contains('danger'), hold: !!skip?.classList.contains('tut-hold'),
      fill: !!skip?.querySelector('.tut-hold-fill'),
    };
  });
  ok(card.bodyLines === 0 && !card.bodyShown, '확인 카드에 본문이 없다 (빈 칸도 남지 않는다)', JSON.stringify(card));
  ok(card.danger && card.hold && card.fill, '건너뛰기는 빨간 홀드 버튼이다', JSON.stringify(card));

  // 짧게 누르면 아무 일도 없다
  const holdOn = (ms) => P(async (t) => {
    const btn = [...document.querySelectorAll('.tut-popup-card .acts .ui-btn')].find((b) => b.textContent === '건너뛰기');
    btn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerId: 1 }));
    await new Promise((r) => setTimeout(r, t));
    btn.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true, pointerId: 1 }));
  }, ms);
  await holdOn(200);
  await sleep(150);
  ok(await step() === 'craftGun', '짧게 누르면 건너뛰지 않는다');
  ok(await clickPopup('계속하기'), '계속하기');
  await sleep(150);
  ok(await step() === 'craftGun', '취소하면 하던 단계 그대로');

  /* ── 6. 진행이 새로고침을 견딘다 ──────────────────────────────────────── */
  console.log('저장');
  const saved = await P(() => JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'));
  ok(saved && saved.step === 'craftGun' && saved.granted === true, `저장이 남는다 (${JSON.stringify(saved)})`);
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  ok(await step() === 'craftGun', '새로고침 후에도 같은 단계에서 이어진다');

  /* 2026-09-09: `openCraft` 는 순서에서 빠졌지만 id 는 계약(`TutorialStepId`)에 남아 있다 — 그 단계를 들고 있던
     저장은 자리를 이어받은 `craftAmmo` 로 이어진다 (`Steps.normalizeStep`). 저장이 깨져 처음부터 돌지 않는다. */
  await P(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.step = 'openCraft';
    localStorage.setItem('scav.s1.tutorial', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  const stale = await P(() => {
    const t = window.__game.ctx.tutorial;
    return { active: t.active, step: t.step, index: t.stepIndex, count: t.stepCount };
  });
  ok(stale.active && stale.step === 'craftAmmo' && stale.index === 9 && stale.count === 17,
    'openCraft 를 들고 있던 저장은 craftAmmo(9/17) 로 이어진다', JSON.stringify(stale));
  const gotoStale = await P(() => {
    const t = window.__game.ctx.tutorial;
    return { ret: t.goto('openCraft'), step: t.step };
  });
  ok(gotoStale.ret === true && gotoStale.step === 'craftAmmo',
    'goto("openCraft") 도 craftAmmo 로 접힌다 (콘솔 · 저장 경로가 같은 판정을 쓴다)', JSON.stringify(gotoStale));
  await P(() => window.__game.ctx.tutorial.goto('craftGun'));
  await sleep(150);

  /* ── 7. 콘솔 명령 + 남은 단계 ─────────────────────────────────────────── */
  console.log('콘솔 · 남은 단계');
  await P(() => window.__game.ctx.tutorial.goto('planet'));
  // PLANET_IDS[0] = 'amber' 만 허용된다
  const planetGate = await P(() => {
    const hub = window.__game.getSystem('hub');
    return { first: hub.travelBlockReason('amber'), second: hub.travelBlockReason('mossy') };
  });
  ok(planetGate.first === null, `첫 번째 행성은 허용된다 (${JSON.stringify(planetGate.first)})`);
  ok(planetGate.second !== null && /첫 번째/.test(planetGate.second), `그 외 행성은 거부된다 ("${planetGate.second}")`);
  await P(() => window.__game.ctx.tutorial.goto('board'));
  const boardOk = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    return { prompt: it?.getPrompt() ?? null, block: window.__game.getSystem('hub').podBlockReason(0) };
  });
  ok(!/튜토리얼/.test(boardOk.prompt ?? '튜토리얼'), `탑승 단계에서는 포드가 열린다 ("${boardOk.prompt}")`);

  /* ── 8. 건너뛰면 모든 제한이 풀린다 ──────────────────────────────────── */
  await P(() => window.__game.ctx.tutorial.skip());
  await sleep(150);
  const after = await P(() => {
    const t = window.__game.ctx.tutorial;
    const h = window.__game.ctx.housing;
    return {
      active: t.active, step: t.step,
      lounge: t.blockReason('roomPurpose', 'lounge'), corp: t.blockReason('screenTab', 'corp'),
      hides: t.hides('community'),
      housing: h.purposeBlock(2, 'lounge'),
      fin: window.__ev['tutorial:finished'].slice(-1)[0],
      panel: document.querySelector('.tut-panel').hidden, spot: document.querySelector('.tut-spot').hidden,
      saved: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    };
  });
  ok(!after.active && after.step === null && after.fin && after.fin.skipped === true, '건너뛰면 튜토리얼이 끝난다', JSON.stringify(after.fin));
  ok(after.lounge === null && after.corp === null && !after.hides, '모든 게이트가 풀린다', JSON.stringify(after));
  ok(after.panel && after.spot, '목표 패널과 스포트라이트가 사라진다');
  ok(after.saved && after.saved.done === true && after.saved.step === null, '끝났다는 것이 저장된다', JSON.stringify(after.saved));

  /* ── 9. 이미 하던 프로필에는 켜지지 않는다 ──────────────────────────── */
  console.log('기존 프로필');
  await P(() => { try { localStorage.removeItem('scav.s1.tutorial'); } catch { /* off */ } });
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  const existing = await P(() => ({
    step: window.__game.ctx.tutorial.step,
    saved: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    rooms: (() => { const h = window.__game.ctx.housing; let n = 0; for (let i = 0; i < 10; i++) if (h.getRoom(i).purpose !== 'empty') n++; return n; })(),
  }));
  ok(existing.rooms > 0 && existing.step === null && existing.saved?.done === true,
    '이미 함선을 꾸며 놓은 프로필에서는 조용히 끝난 것으로 표시한다', JSON.stringify(existing));
  ok(await P(() => window.__game.ctx.tutorial.start()) === true, 'start() 로는 언제든 다시 켤 수 있다 (콘솔 경로)');
  ok(await step() === 'intro', '다시 intro 부터');

  ok(errors.length === 0, `no console errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
process.exit(fail === 0 ? 0 : 1);
