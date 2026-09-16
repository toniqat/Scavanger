// Single-player smoke test for the tutorial (src/tutorial, 2026-09-08).
// Covers: auto-start on a fresh profile only, the intro card, the objective panel + progress, the strict gates
// (room purpose / furniture / craft / terminal / planet / pod / screen tabs), the community + matchmaking hiding,
// the spotlight (dark panes + ring on the step's target), the 3D floor guide, the one-time material grant,
// step persistence across a reload, the 건너뛰기 confirm card and the console command.
// 2026-09-08: + the 발전기 step, "잠그지 않고 감춘다" (`hides(gate, id)` → 용도 · 화면 탭이 목록에서 빠진다),
// the objective panel staying above the spotlight (`.tut-panel.is-lifted`) and the cursor showing under the card.
// 2026-09-14 3차: **16 steps** — `manageDone`(관리 모드 닫기)도 `openCraft` 처럼 순서에서 빠졌다 (id 는 계약에 남는다).
// 2026-09-15 (사용자 결정 — 뒤집음): **17 steps** — `manageDone`(「하우징 모드 닫기」)이 `craftGun` 바로 앞으로 돌아왔다.
//   배치 버튼은 이제 `manageDone` 으로 넘기고, 관리 모드를 닫는 것이 `craftGun` 을 연다 — 바닥 안내선의 반 박자 계측도
//   그 조작(`closeShipManage`)에 붙는다. 그리고 **하우징 모드가 열려 있는 동안에는 안내선이 없다** (다시 열면 걷히고 닫으면 돌아온다).
// 2026-09-09: the bench makes 소총 → 탄약 in **one** window (craftGun → craftAmmo → openBag → equipGun → stowAmmo,
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
// 2026-09-13 (전력 할당 폐지): 새 함선의 발전기는 처음부터 Lv.1 — `generator` 단계는 알려진 즉시(`tutorial:changed`) 조용히 지나가고
// 시설 관리를 여는 순간 함선 관리 → 작업실이다. 반 박자 포커싱 계측은 그 전환(시설 관리 힌트 → 작업실 행)에서 한다.
// 2026-09-14 (3트랙): 저장은 **v2** 다 — `{version:2, tracks:{raid,ship,build}}`. 이 스모크가 검사하는 것은 여전히
// **build 트랙**(17단계)이고, 트랙 ①(레이드 조작) · ②(함선)는 그 트랙을 구현하는 쪽(world/tutorial · meta/messenger)이
// 자기 스모크를 더한다. 새 프로필이 함선에 들어오면 raid · ship 은 조용히 `done` 으로 적히고 build 가 시작된다
// (`TutorialSystem.autoStart` — `pendingShip` 이 없으면 함선 트랙은 켜지지 않는다).
// 2026-09-17 (사용자 결정 — 「여러 스텝을 하나의 스텝 내 여러 목표로」): 증축 트랙은 **7 단계**다 —
//   intro · manage(시설 관리 → 작업실) · bench(작업대 제작 → 창고 탭 → 배치 → 하우징 모드 닫기) · craftGun(이동 → 작동 → 소총 →
//   탄약 → 제작창 닫기) · equipGun(Tab → 장착, 닫을 때까지 조용히 기다림 · 딤 없는 포커싱) · terminal(조종석 → 터미널 → 행성 →
//   워프 대기 → 포드 이동 → 탑승 → Space 준비) · raid(가치 1,000 C 이상 들고 탈출, 한 번). 목표 줄이 순차 공개되고 포커싱은 지금 할
//   줄을 따라간다. `stowAmmo` 는 없어졌다. 옛 저장의 빠진 id 는 묶인 단계로 옮겨지고 이미 한 줄이 채워진다. 트랙 완료 토스트는 없다.
//   터미널의 훈련장 버튼 · 준비 경고는 이 트랙 동안 감춰진다 (`training` · `launchWarn`).
// Usage: node scripts/smoke-tutorial.mjs [http://localhost:5273]   (needs `npm run dev`)
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
  ok(intro.ev && intro.ev.active === true && intro.ev.step === 'intro' && intro.ev.count === 7, `tutorial:changed {intro, 1/7} (${JSON.stringify(intro.ev)})`);
  const order = await P(() => window.__game.getSystem('tutorial').constructor && null);
  void order;

  /* 2026-09-14 (3트랙): 새 프로필은 **증축 트랙**부터 돈다 — 레이드 · 함선 트랙은 함선에 들어선 순간 끝난 것으로
     적히고(`autoStart`), HUD 게이트(`hides('hud', …)`)는 레이드 트랙 밖이라 아무것도 감추지 않는다.
     우측 조작 가이드도 증축 트랙에는 배울 조작이 없어 뜨지 않는다. */
  const tracks = await P(() => {
    const t = window.__game.ctx.tutorial;
    return {
      track: t.track,
      raid: t.isTrackDone('raid'), ship: t.isTrackDone('ship'), build: t.isTrackDone('build'),
      hud: ['vitals', 'weapon', 'stamina', 'implant', 'stratagem'].map((p) => t.hides('hud', p)),
      controls: document.querySelector('.tut-controls')?.hidden ?? null,
      ev: window.__ev['tutorial:changed'].slice(-1)[0]?.track ?? null,
    };
  });
  ok(tracks.track === 'build' && tracks.ev === 'build', `새 프로필은 증축 트랙부터 돈다 (${JSON.stringify(tracks)})`);
  ok(tracks.raid === true && tracks.ship === true && tracks.build === false,
    '레이드 · 함선 트랙은 끝난 것으로, 증축 트랙은 도는 중으로 답한다', JSON.stringify(tracks));
  ok(tracks.hud.every((h) => h === false), '증축 트랙에서는 HUD 를 하나도 감추지 않는다', JSON.stringify(tracks.hud));
  ok(tracks.controls === true, '우측 조작 가이드는 증축 트랙에서 뜨지 않는다');

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
  /* 2026-09-14 2차: 목표 패널은 달성 애니메이션이 보이도록 다음 단계의 **목표 줄만** `TUTORIAL_STEP_DELAY_S`(0.5초)
     동안 붙잡는다 (진행 바 · 트랙 이름은 즉시). 단계 기계는 이미 넘어가 있으므로 여기서 그 반 박자를 기다린다. */
  await sleep(700);
  const afterIntro = await P(() => ({
    popup: document.querySelector('.tut-popup').hidden,
    blocker: window.__game.ctx.uiBlockers.has('tutorial'),
    /* 2026-09-14 2차: `.tut-title` · `.tut-hint` 두 줄이 **체크박스 목표 줄 목록**으로 바뀌었다. 글자는
       `.tut-obj-txt` 에서 읽는다 — `.tut-obj-label` 은 취소선용으로 같은 글자를 한 겹 더 깔고 있어 두 번 나온다. */
    title: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent).join(' | '),
  }));
  ok(afterIntro.popup && !afterIntro.blocker && /시설 관리 열기/.test(afterIntro.title ?? ''), '카드가 닫히고 목표가 시설 관리 열기로 바뀐다', JSON.stringify(afterIntro));
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
  /* ── 3b. 발전기 단계는 건너뛴다 (2026-09-13, 전력 할당 폐지) ──────────────────
     새 함선의 발전기는 처음부터 Lv.1 이라 `generator` 단계에 할 일이 없다 — `TutorialSystem.setStep` 이 그 단계를 알리자마자
     (`tutorial:changed {generator}`) 곧바로 `workshop` 으로 넘긴다. 발전기를 올리는 조작은 어디에도 없다. */
  const genPre = await P(() => ({ level: window.__game.ctx.housing.getFacility('generator').level, n: window.__ev['tutorial:changed'].length, step: window.__game.ctx.tutorial.step }));
  ok(genPre.level === 1 && genPre.step === 'manage', `새 함선의 발전기는 이미 Lv.1 이다 (Lv.${genPre.level}, 단계 ${genPre.step})`);
  // 재료를 채운다 — 작업실 증축에 필요하다
  await P(() => {
    const ctx = window.__game.ctx;
    const give = (id, n) => { const max = ctx.loot.getItemDef(id).stackMax ?? 1; let a = 0; while (a < n) { const q = Math.min(max, n - a); if (!ctx.inventory.tryAddItem(ctx.loot.createItem(id, q))) break; a += q; } };
    give('mat_scrap', 40); give('mat_cable', 8); give('mat_alloy', 8);
  });

  /* ── 3b-2. 반 박자 늦게 켜지는 포커싱 (2026-09-09) ──────────────────────
     시설 관리를 여는 순간 단계가 함선 관리 → (발전기) → 작업실로 넘어가고 다음 대상(`.sm-purpose[data-purpose="workshop"]`)이
     같은 순간 화면에 뜬다. 그래도 스포트라이트는 단계가 넘어가는 순간 곧바로 접히고, `TUTORIAL_STEP_DELAY_S`(0.5 s)
     뒤에야 새 자리에서 다시 켜진다 — "새 화면이 먼저 보이고 포커싱이 따라온다". 켜질 때 어두운 판은
     `--tut-dim-fade`(= `TUTORIAL_DIM_FADE_S`) 동안 서서히 어두워진다 (`.tut-spot.is-lit`).
     2026-09-13: 발전기 → 작업실 전환이 없어져 계측을 이 전환(시설 관리 힌트 → 작업실 행)으로 옮겼다. */
  const relight = await P(async () => {
    const spot = () => document.querySelector('.tut-spot');
    const lit = () => { const r = spot(); return !!r && !r.hidden && r.classList.contains('is-lit'); };
    const sp = () => window.__game.getSystem('tutorial').spotlight;
    const before = lit();
    const t0 = performance.now();
    window.__game.ctx.housing.openShipManage(0);                       // 2026-09-17: 같은 단계의 다음 줄 (시설 관리 열기 → 작업실 증축)
    const acted = window.__game.ctx.housing.shipManageMode === true && window.__game.ctx.tutorial.step === 'manage'
      && window.__game.getSystem('tutorial').done.has('manageOpen');
    const immediate = lit();
    let midway = null, ms = -1, sawPending = false;
    while (performance.now() - t0 < 15000) {
      /* `Spotlight.pending` 은 **대상이 화면에서 찾힌 뒤에야** 세기 시작한다 (`update` 의 `timer` 가 다음
         `RETARGET_INTERVAL` 에 걸려야 찾는다) — 그래서 0.3 s 한 점에서 `pending` 을 읽던 옛 판정은 그 첫
         확인이 늦어지면 `wait -1`(아직 안 셈)을 보고 빨개졌다. 반 박자가 실제로 돌았는지는 **한 번이라도
         세는 중이 보였는가**로 본다 — 8 ms 마다 보므로 0.5 s 짜리 카운트다운을 놓칠 수 없다. */
      if (sp().pending) sawPending = true;
      if (!midway && performance.now() - t0 >= 300) midway = { lit: lit(), pending: sp().pending, wait: Math.round(sp().wait * 1000) };
      if (lit()) { ms = performance.now() - t0; break; }
      await new Promise((r) => setTimeout(r, 8));
    }
    return {
      acted, before, immediate, midway, ms, sawPending,
      tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
      fade: getComputedStyle(spot()).getPropertyValue('--tut-dim-fade').trim(),
    };
  });
  ok(relight.acted === true, '시설 관리를 열자마자 같은 단계의 「작업실 증축」 줄이다 (발전기 줄은 없다)', JSON.stringify(relight));
  ok(relight.before === true && relight.immediate === false,
    '목표 줄이 넘어가는 순간 포커싱이 곧바로 접힌다 (다음 대상이 이미 화면에 있어도)', JSON.stringify(relight));
  ok(relight.midway && relight.midway.lit === false && relight.sawPending === true,
    `0.3 s 뒤에도 아직 어둡고, 켜지기 전에 반 박자를 세는 구간이 있었다 (0.3 s 시점 남은 ${relight.midway?.wait} ms)`, JSON.stringify(relight));
  /* 위아래를 모두 못 박는다. 아래는 "곧바로 켜지지 않는다"(≥ 0.3 s), 위는 "언젠가가 아니라 반 박자"(< 2 s —
     카운터가 0 을 지나쳐 0.5 초를 다시 세던 2026-09-09 의 버그가 돌아오면 여기서 실패한다). */
  ok(relight.ms >= 300 && relight.ms < 2000 && /작업실/.test(relight.tip),
    `반 박자(TUTORIAL_STEP_DELAY_S 0.5 s) 뒤에 새 대상에서 다시 켜진다 (${Math.round(relight.ms)} ms, "${relight.tip}")`, JSON.stringify(relight));
  ok(relight.fade === '0.5s', `어두운 판은 --tut-dim-fade 동안 서서히 어두워진다 ("${relight.fade}")`);
  const skipped = await P((n) => ({
    trail: window.__ev['tutorial:changed'].slice(n).map((e) => e.step),
    objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
    level: window.__game.ctx.housing.getFacility('generator').level,
    gen: !!document.querySelector('.sm-gen .sm-gen-btn'),
    purposes: [...document.querySelectorAll('.sm-purposes .sm-purpose')].map((b) => b.dataset.purpose),
    tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
    lifted: document.querySelector('.tut-panel')?.classList.contains('is-lifted') ?? false,
  }), genPre.n);
  ok(skipped.trail.length === 0 && skipped.level === 1 && skipped.objs.length === 2 && /시설 관리 열기$/.test(skipped.objs[0])
    && skipped.objs[1] === '빈 방을 작업실로 증축' && !skipped.objs.some((t) => /발전기/.test(t)),
    `시설 관리 → 작업실은 한 단계의 두 줄이고 발전기 줄은 없다 (${skipped.objs.join(' | ')})`, JSON.stringify(skipped));
  ok(skipped.gen, '발전기 행은 여전히 있다 (2026-09-12: 용도 목록이 아니라 방 목록 아래)');
  ok(skipped.purposes.length === 1 && skipped.purposes[0] === 'workshop',
    '작업실 외의 용도는 사유가 아니라 아예 목록에서 빠진다', JSON.stringify(skipped.purposes));
  ok(/작업실/.test(skipped.tip) && !/발전기/.test(skipped.tip), `말풍선은 발전기가 아니라 작업실을 가리킨다 ("${skipped.tip}")`);
  ok(skipped.lifted, '포커싱 중에도 목표 패널은 어두운 판 위에 있다 (건너뛰기 클릭 가능)');

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
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('benchCrafted'), 'objective benchCrafted', 15000);

  /* ── 3c. 제작 → 가구 창고 → 배치 (2026-09-08) ───────────────────────── */
  // 제작은 가구를 **창고**에 넣을 뿐이다 — 배치는 따로 안내한다 (그 전에는 창고 탭이 어두운 판에 덮여 막혔다)
  ok(await step() === 'bench', '작업대를 만들어도 같은 단계다 — 다음 줄(가구 창고 탭)이 열린다');
  const stashed = await P(() => ({
    stored: (window.__game.ctx.housing.getStored() ?? []).filter((s) => s.defId === 'furn_bench_gun').reduce((n, s) => n + s.qty, 0),
    placed: window.__game.ctx.housing.getPlaced().filter((f) => f.room !== 100).length,   // 2026-09-12: 조종석 공용 가구 2점은 늘 놓여 있다
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
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('benchStore'), 'objective benchStore', 10000);
  ok(true, '가구 창고 탭을 누르면 「가구 창고 탭으로 이동」 줄이 달성된다');
  await P(() => document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]').click());
  await sleep(150);
  const picked = await P(() => {
    const card = document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]');
    const btn = card?.querySelector('.fcard-place');
    return {
      sel: window.__game.getSystem('housing').selectedFurniture,
      hl: card?.classList.contains('is-sel') ?? null,
      btn: !!btn, enabled: btn ? !btn.disabled : null, note: card?.querySelector('.fcard-note')?.textContent ?? '',
      placed: window.__game.ctx.housing.getPlaced().filter((f) => f.room !== 100).length,   // 2026-09-12: 조종석 공용 가구 2점은 늘 놓여 있다
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

  /* ── 3d. 하우징 모드 닫기 (2026-09-15 — `manageDone` 이 순서로 돌아왔다) ───────────── */
  // 배치가 끝나면 `craftGun` 이 아니라 **`manageDone`** 이다 — 관리 모드가 열린 채로는 작업실로 걸어갈 수 없다.
  await waitSpot('하우징 모드 닫기', 'spotlight (하우징 모드 닫기)');
  const closeStep = await P(() => {
    const t = window.__game.ctx.tutorial, h = window.__game.ctx.housing;
    const guide = window.__game.ctx.scene.getObjectByName('TutorialGuide');
    return {
      step: t.step, index: t.stepIndex, count: t.stepCount, manage: h.shipManageMode,
      objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
      spot: window.__spotOn(['.key-guide .kg-close', '.key-guide']),
      guideLit: !!guide && guide.children.length === 3,
      furnitureOk: t.blockReason('furniture', 'furn_bench_gun'), manageExit: t.hides('manageExit'),
    };
  });
  ok(closeStep.step === 'bench' && closeStep.index === 3 && closeStep.count === 7 && closeStep.manage === true,
    '배치 뒤에는 같은 단계의 하우징 모드 닫기 줄 (3/7) — 관리 모드는 아직 열려 있다', JSON.stringify(closeStep));
  // 목표 줄은 `{INVENTORY} 하우징 모드 닫기` — 키캡 토큰이 앞에 그려지므로 textContent 는 `Tab 하우징 모드 닫기` 다 (끝만 본다)
  ok(closeStep.objs.length === 4 && closeStep.objs[0] === '총기 작업대 제작' && closeStep.objs[1] === '가구 창고 탭으로 이동'
    && closeStep.objs[2] === '가구 배치' && /하우징 모드 닫기$/.test(closeStep.objs[3]),
    `목표 줄 넷 — 작업대 제작 → 창고 탭 → 배치 → 하우징 모드 닫기 (${closeStep.objs.join(' | ')})`);
  ok(closeStep.spot.exact && /하우징 모드 닫기/.test(closeStep.spot.tip), `키 가이드의 닫기 항목을 밝힌다 ("${closeStep.spot.tip}")`, JSON.stringify(closeStep.spot));
  ok(closeStep.guideLit === false, '하우징 모드가 열려 있는 동안에는 바닥 안내선이 없다');
  ok(closeStep.furnitureOk === null && closeStep.manageExit === false, '작업대 카드는 그대로 허용되고 닫기는 막히지 않는다', JSON.stringify(closeStep));

  /* 2026-09-15: 바닥 안내선의 반 박자(`TUTORIAL_STEP_DELAY_S`)는 **단계가 바뀌는 순간** 무장된다
     (`TutorialSystem.refreshVisuals` → `Guide.setTarget`, 그 뒤로는 화면과 무관하게 매 프레임 줄어든다).
     단계를 넘기는 조작은 이제 `closeShipManage()` 라 그 조작에 붙여 한 evaluate 안에서 잰다 (왕복 사이의 시간이
     끼어들면 판정이 아니라 경주가 된다 — 옛 주석의 교훈 그대로). */
  await P(() => {
    window.__tutAct = () => {
      window.__game.ctx.housing.closeShipManage();
      return window.__game.ctx.tutorial.step;   // 이 조작이 단계를 넘겼다는 증거
    };
  });
  const guideDelay = await measureGuide();
  ok(guideDelay.acted === 'craftGun' && guideDelay.before === false && guideDelay.immediate === false,
    '하우징 모드를 닫으면 craftGun — 그 직후에는 바닥 안내선이 아직 없다', JSON.stringify(guideDelay));
  ok(guideDelay.ms >= 300 && guideDelay.ms < 2000,
    `바닥 안내선은 스포트라이트와 같은 반 박자 뒤에 깔린다 (${Math.round(guideDelay.ms)} ms)`, JSON.stringify(guideDelay));

  /* 2026-09-15 (사용자 결정): 하우징 모드를 **다시 열면** 안내선이 걷히고(단계는 그대로), 닫으면 반 박자 뒤에 돌아온다. */
  await P(() => { window.__game.ctx.housing.openShipManage(); });
  await sleep(250);
  const reopened = await P(() => {
    const guide = window.__game.ctx.scene.getObjectByName('TutorialGuide');
    return { step: window.__game.ctx.tutorial.step, manage: window.__game.ctx.housing.shipManageMode, guideLit: !!guide && guide.children.length === 3 };
  });
  ok(reopened.step === 'craftGun' && reopened.manage === true && reopened.guideLit === false,
    'craftGun 에서 하우징 모드를 다시 열면 안내선이 걷힌다 (단계는 그대로)', JSON.stringify(reopened));
  await P(() => { window.__tutAct = () => { window.__game.ctx.housing.closeShipManage(); return window.__game.ctx.tutorial.step; }; });
  const guideBack = await measureGuide();
  ok(guideBack.acted === 'craftGun' && guideBack.before === false && guideBack.ms >= 0 && guideBack.ms < 2000,
    `닫으면 안내선이 돌아온다 (${Math.round(guideBack.ms)} ms)`, JSON.stringify(guideBack));

  /* ── 4. 재료 지급 + 제작 게이트 ───────────────────────────────────────── */
  console.log('제작');
  // 2026-09-09: `craftGun` 에서는 바닥 안내선이 작업대를 가리킨다
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
      // 2026-09-14 (사용자 결정): `모두 수리` 는 작업대 헤더가 아니라 **가방 필터 줄 맨 왼쪽**(`.inv-repair-open-btn`)이다
      repairBtn: document.querySelector('.inv-repair-open-btn') ? !document.querySelector('.inv-repair-open-btn').hidden : null,
    };
  });
  ok(crafting.isCraft && crafting.equip === 'none' && crafting.quick === 'none' && crafting.tabs === 'none'
    && crafting.foot === 'none' && crafting.craftBtn === 'none',
    '제작 중에는 장비 · 퀵슬롯 · 화면 탭 · 가방의 제작 버튼/가치가 숨는다', JSON.stringify(crafting));
  ok(crafting.repairBtn === true, '작업대 창에서도 가방 필터 줄의 `모두 수리` 버튼이 보인다');

  /* 소총 행부터. 두 레시피가 같은 창에 함께 떠 있고 스포트라이트만 "지금 만들 것"을 가리킨다. */
  await waitSpot('돌격소총', 'spotlight (돌격소총 제작)');
  const gunRow = await P(() => {
    const row = document.querySelector('.inv-craft-cell[data-recipe="make_wpn_ar"]');
    const ammo = document.querySelector('.inv-craft-cell[data-recipe="make_ammo_medium"]');
    return {
      /* 2026-09-15 3차: 레시피 하나하나는 `.inv-craft-cell`, `.inv-craft-row` 는 고른 것의 상세다 */
      row: !!row, ammo: !!ammo, rows: document.querySelectorAll('.inv-craft-cell').length,
      spot: window.__spotOn(['.inv-craft-row[data-recipe="make_wpn_ar"] .inv-craft-btn', '.inv-craft-cell[data-recipe="make_wpn_ar"]', '.inv-panel-craft']),
    };
  });
  ok(gunRow.row && gunRow.ammo, '작업대 한 창의 조합 목록에 소총 · 준중량탄 두 칸이 함께 있다 (제작은 한 번의 방문)', JSON.stringify(gunRow));
  ok(gunRow.spot.exact, `craftGun 은 돌격소총 제작 버튼을 밝힌다 ("${gunRow.spot.tip}")`, JSON.stringify(gunRow.spot));

  const gunUid = await P(async () => {
    const it = await window.__game.ctx.inventory.craft('make_wpn_ar');
    return it ? it.uid : null;
  });
  ok(!!gunUid, '작업대에서 돌격소총을 만든다');
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('craftGunMade'), 'objective craftGunMade', 15000);
  ok(await step() === 'craftGun', '소총을 만들어도 같은 단계다 — 준중량탄 줄이 열린다 (2026-09-17)');
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
  const ammoRow = await P(() => window.__spotOn(['.inv-craft-row[data-recipe="make_ammo_medium"] .inv-craft-btn', '.inv-craft-cell[data-recipe="make_ammo_medium"]', '.inv-panel-craft']));
  ok(ammoRow.exact, `포커싱이 같은 창의 준중량탄으로 옮겨 간다 ("${ammoRow.tip}")`, JSON.stringify(ammoRow));
  ok(await P(async () => !!(await window.__game.ctx.inventory.craft('make_ammo_medium'))), '같은 창에서 준중량탄을 만든다');
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('craftAmmoMade'), 'objective craftAmmoMade', 15000);

  /* 소총 · 탄약이 다 만들어진 **뒤에야** 제작 창을 닫는다 (`openBag`). */
  await waitSpot('닫기', 'spotlight (제작 창 닫기)');
  const closeSpot = await P(() => window.__spotOn(['.inv-craft-close', '.inv-panel-craft']));
  ok(closeSpot.exact && closeSpot.sel[0] === '.inv-craft-close',
    `「제작창 닫기」 줄은 제작 창의 닫기를 밝힌다 ("${closeSpot.tip}")`, JSON.stringify(closeSpot));
  await P(() => document.querySelector('.inv-craft-close').click());
  await waitStep('equipGun');
  ok(true, '제작 창을 닫으면 장착 단계로 넘어간다');

  /* 2026-09-16 (사용자 보고 「작업대 창을 닫았는데 가방이 열린다」, `inventory/parts/Crafting.closeCraftWindow`):
     **작업대가 연 창은 작업대 창**이라 `닫기` 는 제작 열만 접는 것이 아니라 창째 닫는다. 그래서 `equipGun` 은
     창이 닫힌 채로 시작하고, 밝힐 DOM 이 없으니 스포트라이트는 뜨지 않는다 (`parts/Spotlight` 는 대상을 못 찾으면
     스스로 접힌다 — 어두운 판만 남아 아무것도 못 누르는 상태를 만들지 않는다). 남은 안내는 「창을 다시 여는 키」
     하나이고, 그것을 적는 자리는 우측 조작 가이드다 (`model.EQUIP_HINTS`). */
  await sleep(900);      // 반 박자(`TUTORIAL_STEP_DELAY_S` 0.5 s)를 넘기고도 안 뜨는지 본다 (뜬다면 허공에 링이 걸린 것)
  const afterClose = await P(() => {
    const spot = document.querySelector('.tut-spot');
    const ctl = document.querySelector('.tut-controls');
    const row = ctl?.querySelector('.tut-ctl[data-hint="bag"]');
    const r = document.querySelector('.inv-root');
    return {
      invOpen: window.__game.ctx.inventory.isOpen, invShown: !!r && !r.hidden && r.getClientRects().length > 0,
      spotLit: !!spot && !spot.hidden && spot.classList.contains('is-lit'),
      panes: [...document.querySelectorAll('.tut-spot-pane')].filter((p) => p.getClientRects().length > 0).length,
      ctlShown: !!ctl && !ctl.hidden, bagRow: row ? row.textContent : null,
      hint: document.querySelector('.tut-hint')?.textContent ?? '',
    };
  });
  ok(!afterClose.invOpen && !afterClose.invShown,
    '작업대 창의 닫기는 창째 닫는다 — 장비 칸도 가방도 화면에 없다', JSON.stringify(afterClose));
  ok(!afterClose.spotLit && afterClose.panes === 0,
    '밝힐 것이 없으면 스포트라이트도 뜨지 않는다 (어두운 판만 남지 않는다)', JSON.stringify(afterClose));
  ok(afterClose.ctlShown && /가방/.test(afterClose.bagRow ?? ''),
    `조작 가이드가 창을 다시 여는 키를 적는다 ("${afterClose.bagRow}")`, JSON.stringify(afterClose));
  /* 튜토리얼은 인벤토리 탭을 언제나 열어 둔다 (`parts/Gates.blockReason` 의 `screenTab`) — Tab 으로 다시 연다. */
  await P(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab', key: 'Tab', bubbles: true }));
  });
  await waitFor(page, () => {
    const r = document.querySelector('.inv-root');
    return window.__game.ctx.inventory.isOpen && !!r && !r.hidden;
  }, 'Tab reopens the inventory window', 10000);
  ok(true, 'Tab 이 장착할 창을 다시 연다 (창이 열리면 조작 가이드는 스스로 접힌다)');
  ok(await P(() => { const c = document.querySelector('.tut-controls'); return !c || c.hidden; }),
    '인벤토리 창이 열려 있는 동안 조작 가이드는 접힌다');
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('equipOpen'), 'objective equipOpen', 10000);
  ok(true, 'Tab 으로 연 것이 「인벤토리 열기」 줄을 적는다');

  /* 2026-09-09: `equipGun` 은 장비 열 **전체**가 아니라 주무기 I · II 칸 + 가방만 밝힌다 — 보조무기 · 방탄복 ·
     가방 칸 · 임플란트 칸은 이 단계와 상관없다. 구멍은 언제나 사각형 하나이므로 셋을 감싸는 최소 사각형이
     되고, `parts/Spotlight.place` 가 `PAD`(6 px)만큼 넓혀 정수 모서리로 굳힌다. */
  await waitSpot('주무기', 'spotlight (주무기 I · II + 창고·가방 카드)');
  const union = await P(() => {
    /* 2026-09-15 3차 (사용자 결정 「제작품은 함선 창고로」): 만든 소총은 창고에 있으므로 마지막 대상이
       `.inv-panel-bag` → **`.inv-panel-grids`**(창고 + 가방 한 카드)다. 구멍은 여전히 사각형 하나다. */
    /* 2026-09-16 (사용자 결정 「창고 | 장비 | 가방」): 창고가 가방 카드 밖(장비 열 왼쪽)으로 나와 마지막 대상이 `.inv-panel-stash` 다. */
    const s = window.__spotOn(['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-stash'], true);
    /* 세 대상이 정말 구멍 안에 들어왔나. 구멍은 **화면 밖으로는 못 나가므로**(`Spotlight.place` 의 clamp) 이
       검사는 "인벤토리 창이 화면 안에 선다" 도 함께 본다 — 2026-09-12 에 `.inv-root` 가 세로 가운데 정렬에서
       `flex-start + padding-top` 으로 바뀌면서 1280×760 함선 창의 가방 패널이 811 px(화면 760)까지 내려가
       여기서 `bag:false` 로 잡혔다 (`inventory.css` 의 `.inv-bag-scroll` 함선 예산). */
    const inside = (sel) => {
      const e = document.querySelector(sel);
      if (!e || !s.hole) return null;
      const b = e.getBoundingClientRect();
      return s.hole.left <= b.left && s.hole.right >= b.right && s.hole.top <= b.top && s.hole.bottom >= b.bottom;
    };
    // 예전 선택자(장비 열 **전체** + 가방)로는 어떤 구멍이 됐을지 — 지금 것과 같으면 안 된다
    const old = window.__spotOn(['.inv-root .inv-equip', '.inv-panel-stash'], true);
    return {
      ...s, three: (s.sel ?? []).length, oldWant: old.want, wholeColumn: old.exact,
      primary: inside('.inv-root .inv-equip .inv-slot-primary'), primary2: inside('.inv-root .inv-equip .inv-slot-primary2'),
      bag: inside('.inv-panel-bag'), stash: inside('.inv-panel-stash'),
    };
  });
  ok(union.exact && union.three === 3 && union.primary && union.primary2 && union.stash,
    'equipGun 은 창고 + 주무기 I · II 칸을 한 구멍으로 밝힌다 (합집합)', JSON.stringify(union));
  ok(union.wholeColumn === false,
    '장비 열 **전체**가 아니다 — 보조무기 · 방탄복 · 가방 칸 · 임플란트 칸은 이 단계와 상관없다', JSON.stringify(union));
  // 2026-09-17 (사용자 결정): 장착 포커싱은 화면 전체를 어둡게 하지 않는다
  const noDim = await P(() => {
    const r = document.querySelector('.tut-spot');
    const pane = document.querySelector('.tut-spot-pane');
    return { nodim: !!r?.classList.contains('is-nodim'), bg: pane ? getComputedStyle(pane).backgroundColor : null, pe: pane ? getComputedStyle(pane).pointerEvents : null };
  });
  ok(noDim.nodim && /rgba\(4, 6, 9, 0\)/.test(noDim.bg ?? '') && noDim.pe === 'none', '장착 포커싱은 딤 없이 (판이 투명하고 클릭이 통과한다)', JSON.stringify(noDim));

  /* 2026-09-09: 여기까지 오는 동안 실제로 밟은 단계 · 순번이 새 순서 그대로인가 (`openCraft` 는 없다). */
  const seq = await P(() => window.__ev['tutorial:changed'].filter((e) => e.active).map((e) => ({ s: e.step, i: e.index, n: e.count })));
  // 2026-09-15: `manageDone`(하우징 모드 닫기)이 `benchPlace` 와 `craftGun` 사이로 돌아왔다 — 17 단계
  // 2026-09-17: 7 단계 — 묶인 단계 안의 줄 사이에는 단계 전환이 없다
  const WANT = ['intro', 'manage', 'bench', 'craftGun', 'equipGun'];
  ok(seq.map((e) => e.s).join(' ') === WANT.join(' '), `밟은 단계가 새 순서 그대로다 (${seq.map((e) => e.s).join(' ')})`);
  ok(seq.every((e, i) => e.i === i + 1 && e.n === 7) && !seq.some((e) => e.s === 'openCraft'),
    '순번은 1..5 / 7 이고 옛 단계 id 는 순서에 없다', JSON.stringify(seq.slice(-3)));

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
  await waitFor(page, () => window.__game.getSystem('tutorial').done.has('equipSlot'), 'objective equipSlot', 30000);
  await sleep(700);
  const equipped = await P(() => {
    const l = window.__game.ctx.inventory.getLoadout();
    const spot = document.querySelector('.tut-spot');
    return {
      step: window.__game.ctx.tutorial.step, primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null,
      open: window.__game.ctx.inventory.isOpen, spotLit: !!spot && !spot.hidden && spot.classList.contains('is-lit'),
    };
  });
  // 2026-09-10: 보조무기 칸이 사라져 시작 지급품이 **주무기 I** 에 기관단총을 준다 — 예전처럼 I 칸이 비어 있지 않다.
  // 2026-09-17 (사용자 결정): 장착해도 **인벤토리를 닫을 때까지** 그 단계에 머문다 (목표 줄 없이) — 포커싱은 걷힌다
  ok(equipped.primary2 === 'wpn_ar' && equipped.step === 'equipGun' && equipped.open && !equipped.spotLit,
    '주무기 II 칸에 장착하면 체크가 그어지고 포커싱이 걷히지만, 창이 열려 있는 동안은 같은 단계다', JSON.stringify(equipped));
  await P(() => window.__game.ctx.inventory.closeAll());
  await waitStep('terminal');
  ok(true, '인벤토리를 닫으면 조종석 단계다 (탄약을 가방에 넣는 단계는 없다)');

  /* ── 4d. 탄약 레시피의 모양 (2026-09-10 제작 대개편; 2026-09-17 `stowAmmo` 단계는 없어졌다) ──────
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
  /* 2026-09-14 2차 (사용자 결정): 패널의 `.tut-skip` 버튼이 없어지고 건너뛰기는 **ESC 메뉴**로 옮겨 갔다
     (`ui/menus/PauseMenu` — 튜토리얼이 돌고 있으면 `함선으로 귀환` 자리가 `튜토리얼 건너뛰기` 가 된다).
     그래서 그 경로가 실제로 트랙을 끝내는지를 여기서 본다 — 확인은 `.pause-ask` 의 1초 홀드다. */
  console.log('건너뛰기 (ESC 메뉴)');
  const pauseSkip = await P(async () => {
    window.__game.ctx.bus.emit('game:paused', { paused: true, freeze: false });
    await new Promise((r) => setTimeout(r, 60));
    const menu = document.querySelector('.menu.pause');
    const btn = [...(menu?.querySelectorAll('.ui-btn') ?? [])].find((b) => b.textContent === '튜토리얼 건너뛰기');
    btn?.click();
    return {
      open: !!menu && !menu.classList.contains('hidden'),
      found: !!btn,
      track: window.__game.ctx.tutorial.track,
    };
  });
  ok(pauseSkip.open && pauseSkip.found, 'ESC 메뉴에 `튜토리얼 건너뛰기` 가 있다', JSON.stringify(pauseSkip));
  await sleep(150);
  const askCard = await P(() => {
    const ask = document.querySelector('.pause-ask');
    const okBtn = document.querySelector('.pause-ask-ok');
    return {
      open: !!ask && !ask.classList.contains('hidden') && getComputedStyle(ask).display !== 'none',
      title: document.querySelector('.pause-ask-title')?.textContent,
      ok: document.querySelector('.pause-ask-ok-t')?.textContent,
      hold: !!document.querySelector('.pause-ask-fill'),
      danger: !!okBtn?.classList.contains('danger'),
    };
  });
  ok(askCard.open && /건너뛰기/.test(askCard.title ?? '') && askCard.hold && askCard.danger,
    '경고 팝업 + 1초 홀드 확인 (Enter 로는 확정되지 않는다)', JSON.stringify(askCard));
  /* 취소하면 하던 단계 그대로다 — 실제로 건너뛰지는 않는다 (아래 6절이 같은 저장을 계속 쓴다). */
  const cancelled = await P(async () => {
    document.querySelector('.pause-ask')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const cancel = [...document.querySelectorAll('.pause-ask-foot .ui-btn')].find((b) => /취소/.test(b.textContent ?? ''));
    cancel?.click();
    await new Promise((r) => setTimeout(r, 120));
    const ask = document.querySelector('.pause-ask');
    window.__game.ctx.bus.emit('game:paused', { paused: false, freeze: false });
    return {
      closed: !ask || ask.classList.contains('hidden') || getComputedStyle(ask).display === 'none',
      track: window.__game.ctx.tutorial.track,
    };
  });
  await sleep(150);
  ok(cancelled.closed && cancelled.track === 'build', '취소하면 하던 트랙 그대로', JSON.stringify(cancelled));
  ok(await step() === 'craftGun', '취소하면 하던 단계 그대로');

  /* ── 6. 진행이 새로고침을 견딘다 ──────────────────────────────────────── */
  console.log('저장');
  const saved = await P(() => JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'));
  ok(saved && saved.version === 2 && saved.tracks?.build?.step === 'craftGun' && saved.granted === true,
    `저장이 남는다 — v2 트랙별 (${JSON.stringify(saved)})`);
  ok(saved && saved.tracks?.raid?.done === true && saved.tracks?.ship?.done === true,
    '레이드 · 함선 트랙은 함선에 들어선 순간 끝난 것으로 적힌다', JSON.stringify(saved.tracks));
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  ok(await step() === 'craftGun', '새로고침 후에도 같은 단계에서 이어진다');

  /* 2026-09-09: `openCraft` 는 순서에서 빠졌지만 id 는 계약(`TutorialStepId`)에 남아 있다 — 그 단계를 들고 있던
     저장은 자리를 이어받은 `craftAmmo` 로 이어진다 (`Steps.normalizeStep`). 저장이 깨져 처음부터 돌지 않는다. */
  await P(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.tracks.build.step = 'openCraft';
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
  ok(stale.active && stale.step === 'craftGun' && stale.index === 4 && stale.count === 7,
    'openCraft 를 들고 있던 저장은 craftGun(4/7) 으로 이어진다', JSON.stringify(stale));
  const staleObjs = await P(() => [...window.__game.getSystem('tutorial').done]);
  ok(['craftGunWalk', 'craftGunOpen', 'craftGunMade'].every((id) => staleObjs.includes(id)) && !staleObjs.includes('craftAmmoMade'),
    '그 자리에서 이미 한 줄(이동 · 작동 · 소총)이 채워진다 — 준중량탄부터 이어진다', JSON.stringify(staleObjs));
  // 2026-09-17: 묶여 없어진 다른 id 도 — `manageDone` 은 bench 의 마지막 줄 앞까지 채워진 채로
  await P(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.tracks.build.step = 'manageDone';
    localStorage.setItem('scav.s1.tutorial', JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  const staleBench = await P(() => ({ step: window.__game.ctx.tutorial.step, done: [...window.__game.getSystem('tutorial').done] }));
  // 하우징 모드는 새로고침으로 닫혀 있다 → 「하우징 모드 닫기」는 할 일이 없어 그대로 다음 단계 (옛 `manageDone` 의 조용히 지나치기)
  ok(staleBench.step === 'craftGun', `manageDone 저장은 bench 로 옮겨지고, 관리 모드가 닫혀 있으면 곧장 craftGun 이다 (${staleBench.step})`, JSON.stringify(staleBench));
  const gotoStale = await P(() => {
    const t = window.__game.ctx.tutorial;
    const ret = t.goto('openCraft');
    const step = t.step;
    t.goto('board');
    return { ret, step, board: t.step };
  });
  ok(gotoStale.ret === true && gotoStale.step === 'craftGun' && gotoStale.board === 'terminal',
    'goto("openCraft") 는 craftGun, goto("board") 는 terminal 로 접힌다 (콘솔 · 저장 경로가 같은 판정을 쓴다)', JSON.stringify(gotoStale));
  await P(() => window.__game.ctx.tutorial.goto('craftGun'));
  await sleep(150);

  /* ── 7. 콘솔 명령 + 남은 단계 ─────────────────────────────────────────── */
  console.log('콘솔 · 남은 단계');
  await P(() => window.__game.ctx.tutorial.goto('planet'));   // 2026-09-17: → terminal
  // PLANET_IDS[0] = 'amber' 만 허용된다
  const planetGate = await P(() => {
    const hub = window.__game.getSystem('hub');
    return { first: hub.travelBlockReason('amber'), second: hub.travelBlockReason('mossy') };
  });
  ok(planetGate.first === null, `첫 번째 행성은 허용된다 (${JSON.stringify(planetGate.first)})`);
  ok(planetGate.second !== null && /첫 번째/.test(planetGate.second), `그 외 행성은 거부된다 ("${planetGate.second}")`);
  // 2026-09-15: 게이트 `matchmaking` 은 터미널의 **매칭 탭**째 감춘다 — 탭을 골라도 행성 탭에 머문다
  const tutTabs = await P(() => {
    const menu = window.__game.getSystem('hub').menu;
    menu.open();
    menu.setTab('match');
    const b = document.querySelector('.menu.hub-menu .hub-tabs .scr-tab[data-tab="match"]');
    const out = { matchHidden: !!b?.hidden, tab: menu.activeTab, matchPane: document.querySelector('.hub-pane-match')?.hidden ?? null, arrowsHidden: !!document.querySelector('.hp-arrow.next')?.hidden };
    menu.close(false);
    return out;
  });
  ok(tutTabs.matchHidden && tutTabs.tab === 'planet' && tutTabs.matchPane === true && tutTabs.arrowsHidden,
    '튜토리얼 중에는 터미널 매칭 탭이 숨고 행성 탭에 머문다 (행성 넘김도 감춘다)', JSON.stringify(tutTabs));
  /* 2026-09-17: 한 단계 안에서도 순서를 지킨다 — 포드는 「발사 슬롯으로 이동」 줄이 열린 뒤에야 열린다 (목표별 `allow`).
     훈련장 버튼 · 준비 경고는 증축 트랙 내내 감춰진다. */
  const termGate = await P(() => {
    const t = window.__game.ctx.tutorial;
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    const menu = window.__game.getSystem('hub').menu;
    menu.open();
    const row = document.querySelector('.menu.hub-menu .hub-train-row');
    const out = {
      step: t.step, prompt: it?.getPrompt() ?? null, board: t.blockReason('board'),
      training: t.hides('training'), warn: t.hides('launchWarn'), trainRowHidden: !!row?.hidden,
    };
    menu.close(false);
    return out;
  });
  ok(termGate.step === 'terminal' && /튜토리얼/.test(termGate.board ?? ''),
    '행성 지정 · 워프 전에는 포드가 잠겨 있다', JSON.stringify(termGate));
  ok(termGate.training && termGate.warn && termGate.trainRowHidden, '증축 안내 동안 훈련장 버튼과 출격 준비 경고가 숨는다', JSON.stringify(termGate));
  await P(() => { const sys = window.__game.getSystem('tutorial'); sys.markObjective('planetPicked'); sys.markObjective('travelDone'); });
  const boardOk = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    return { prompt: it?.getPrompt() ?? null, block: window.__game.ctx.tutorial.blockReason('board') };
  });
  ok(boardOk.block === null && !/튜토리얼/.test(boardOk.prompt ?? '튜토리얼'), `워프가 끝나 「발사 슬롯으로 이동」이 열리면 포드가 열린다 ("${boardOk.prompt}")`, JSON.stringify(boardOk));

  /* ── 7b. 마지막 레이드 단계 (2026-09-17) — 목표 줄 · 진행 수 · 조작 가이드, 그리고 함선으로 돌아오면 끝 (완료 토스트 없음) ── */
  await P(() => window.__game.ctx.tutorial.goto('raid'));
  await sleep(700);
  const raidStep = await P(() => ({
    objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
    rows: [...document.querySelectorAll('.tut-controls .tut-ctl')].map((r) => r.dataset.hint),
  }));
  ok(raidStep.objs.length === 1 && /가치 1,000 C 이상 아이템을 획득한 후 무사히 탈출 \(0 \/ 1,000 C\)$/.test(raidStep.objs[0]),
    `마지막 목표 줄과 진행 수 (${raidStep.objs[0]})`, JSON.stringify(raidStep));
  ok(raidStep.rows.join(' ') === 'rgMap rgImplant rgShipCall rgRoll rgCamera rgFold', `레이드 조작 가이드 여섯 줄 (${raidStep.rows.join(' ')})`);
  const fold = await P(() => {
    const c = window.__game.getSystem('tutorial').controls;
    c.setFolded(true, '{GUIDE_TOGGLE} 조작 가이드 표시');
    const root = document.querySelector('.tut-controls');
    const out = {
      folded: root.classList.contains('is-folded'), list: getComputedStyle(root.querySelector('.tut-ctl-list')).display,
      line: root.querySelector('.tut-ctl-fold')?.textContent ?? null, hidden: root.hidden,
    };
    c.setFolded(false, '{GUIDE_TOGGLE} 조작 가이드 표시');
    return out;
  });
  ok(fold.folded && fold.list === 'none' && /\] ?조작 가이드 표시$/.test(fold.line ?? '') && !fold.hidden,
    `접으면 같은 자리에 「] 조작 가이드 표시」 한 줄만 남는다 ("${fold.line}")`, JSON.stringify(fold));
  const nNotify = await P(() => window.__ev['ui:notify'].length);
  // 함선 진입 처리만 부른다 (가짜 `hub:entered` 를 버스에 흘리면 다른 시스템까지 함선에 들어선 줄 안다)
  await P(() => window.__game.getSystem('tutorial').onHubEntered('personal'));
  await sleep(300);
  const raidEnd = await P((n) => ({
    active: window.__game.ctx.tutorial.active, fin: window.__ev['tutorial:finished'].slice(-1)[0],
    toasts: window.__ev['ui:notify'].slice(n).map((t) => t.text),
  }), nNotify);
  ok(!raidEnd.active && raidEnd.fin?.skipped === false && raidEnd.fin?.track === 'build', '레이드 단계로 함선에 돌아오면 트랙이 끝난다 (한 번뿐)', JSON.stringify(raidEnd));
  ok(!raidEnd.toasts.some((t) => /완료/.test(t)), `트랙 완료 토스트는 뜨지 않는다 (${raidEnd.toasts.join(' | ')})`);
  // 다음 절(건너뛰기)을 위해 트랙을 다시 켠다
  await P(() => { const t = window.__game.ctx.tutorial; t.start(); t.goto('terminal'); });
  await sleep(150);

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
  ok(after.saved && after.saved.tracks?.build?.done === true && after.saved.tracks?.build?.step === null,
    '끝났다는 것이 저장된다 (그 트랙만)', JSON.stringify(after.saved));

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
  ok(existing.rooms > 0 && existing.step === null
    && ['raid', 'ship', 'build'].every((t) => existing.saved?.tracks?.[t]?.done === true),
    '이미 함선을 꾸며 놓은 프로필에서는 세 트랙 전부 조용히 끝난 것으로 표시한다', JSON.stringify(existing));
  ok(await P(() => window.__game.ctx.tutorial.start()) === true, 'start() 로는 언제든 다시 켤 수 있다 (콘솔 경로)');
  ok(await step() === 'intro', '다시 intro 부터');

  ok(errors.length === 0, `no console errors (${errors.length})`, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
process.exit(fail === 0 ? 0 : 1);
