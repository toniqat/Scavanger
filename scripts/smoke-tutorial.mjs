// Single-player smoke test for the tutorial (src/tutorial, 2026-09-08).
// Covers: auto-start on a fresh profile only, the intro card, the objective panel + progress, the strict gates
// (room purpose / furniture / craft / terminal / planet / pod / screen tabs), the community + matchmaking hiding,
// the spotlight (dark panes + ring on the step's target), the 3D floor guide, the one-time floor grant,
// step persistence across a reload, the 건너뛰기 confirm card and the console command.
// 2026-09-08: + the `generator` step, "hidden rather than locked" (`hides(gate, id)` → room purposes · screen tabs
// drop out of the list), the objective panel staying above the spotlight (`.tut-panel.is-lifted`) and the cursor
// showing under the card.
// 2026-09-14 3rd pass: **16 steps** — `manageDone` (closing the management mode) left the order like `openCraft`
//   (the id stays in the contract).
// 2026-09-15 (user's decision — reversed): **17 steps** — `manageDone` (「하우징 모드 닫기」) came back right before
//   `craftGun`. The 배치 button now advances to `manageDone`, and closing the management mode is what opens
//   `craftGun` — the floor guide's half-beat measurement hangs off that action (`closeShipManage`) too. And **there
//   is no floor guide while ship management is open** (reopening takes it down, closing brings it back).
// 2026-09-09: the bench makes the rifle → the ammo in **one** window (craftGun → craftAmmo → openBag → equipGun → stowAmmo,
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
// 2026-09-10: the big craft rework removed `bulk_ammo_medium` (bulk craft, 90 rounds) from the csv — the ammo step is
// `make_ammo_medium` (6 gunpowder · 2 scrap → 30 rounds). So two more things are nailed down here:
//   • whether that recipe is **shaped so it can appear in a workbench window** (`station: 'field'` · no `bench`).
//   • whether `stowAmmo` **assumes no quantity** — whatever amount was made (= the csv's `outputQty`; no number is
//     written into the smoke), it advances to `terminal` as long as the bag holds some.
// 2026-09-13 (power allocation removed): a new ship's generator is Lv.1 from the start — the `generator` step passes
// silently the moment it is announced (`tutorial:changed`), and opening 시설 관리 goes ship management → the workshop.
// The half-beat focus measurement is taken at that transition (the 시설 관리 hint → the workshop row).
// 2026-09-14 (three tracks): the save is **v2** — split per track. What this smoke checks is **the two tracks that
// run inside the ship**; tracks ① (raid controls) · ② (ship) get their own smokes from the side that implements
// them (world/tutorial · meta/messenger). When a fresh profile enters the ship, raid · ship are written `done`
// silently and build starts (`TutorialSystem.autoStart` — without `pendingShip` the ship track is never turned on).
// 2026-09-18 (user's decision — 증축 안내 · 출격 안내 split apart): **there are four tracks** —
//   `{version:2, tracks:{raid,ship,build,raid2}}`. `build` 「증축 안내」 ends at `equipGun` (**5 steps**) and
//   `raid2` 「출격 안내」 (`terminal` · `raid`, 2 steps) takes over **on its own** — `pendingRaid2` (only on a
//   completion; a skipped or old save is written done silently).
//   Not one step id changed, so `load()` **moves** an old save's `terminal` · `raid` (and the `board` · `planet` ·
//   `travel` that fold into them) to `raid2`.
// 2026-09-17 (user's decision — 「여러 스텝을 하나의 스텝 내 여러 목표로」): the build track was 7 steps (5 + 2 from
//   2026-09-18) — intro · manage (시설 관리 → the workshop) · bench (craft the workbench → the 가구 창고 tab → 배치 →
//   close ship management) · craftGun (walk → open → the rifle → the ammo → close the craft window) · equipGun
//   (Tab → equip, waiting silently until it closes · no-dim focus) · terminal (the cockpit → the terminal → the
//   planet → the warp wait → walk to the pod → board → Space to ready up) · raid (extract carrying 1,000 C or more
//   of value, once). The objective rows are revealed in sequence and the focus follows the row to do now.
//   `stowAmmo` is gone. A missing id in an old save is moved to the grouped step with one row already ticked. There
//   is no track-completion toast.
//   The terminal's training-range button · the launch warning are hidden while this track runs (`training` ·
//   `launchWarn`).
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
      /* The hole the spotlight is cutting right now. **It is never measured off the ring (`.tut-spot-ring`)** — the
         ring carries a slow scale animation (`@keyframes tut-ring`, scale 1 → 1.045), so its `getBoundingClientRect`
         wobbles frame to frame. The rectangle the four dim plates leave has no transform, so it is exactly the
         integer edges `place()` froze. */
      window.__hole = () => {
        const p = [...document.querySelectorAll('.tut-spot-pane')].map((e) => e.getBoundingClientRect());
        if (p.length !== 4) return null;
        const [top, bottom, left, right] = p;
        return { left: left.right, right: right.left, top: top.bottom, bottom: bottom.top };
      };
      /**
       * Whether the spotlight is cutting **exactly the right place** for those selectors. The expected rectangle is
       * built by the same rule as `parts/Spotlight`: the first one found (with `union`, the union of every one
       * found) → widened by `PAD` (6 px) → floor / ceil to integer edges → never outside the viewport.
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
  /* 2026-09-09: the spotlight lights only after counting `TUTORIAL_STEP_DELAY_S` (0.5 s) from its target appearing
     — the new screen shows first and the plates · ring · callout follow (`parts/Spotlight.wait`). So this smoke
     never reads "is it up right now" straight away; it **waits until it lights**: `.tut-spot` shown · the fade
     started (`.tut-spot.is-lit`) · the callout belonging to this step. The timeout is kept short, about thirty times
     the half beat — if the regression where the counter runs past 0 and counts again (the bug fixed on 2026-09-09)
     comes back, it has to fail right here. */
  const waitSpot = (re, label, timeout = 15000) => waitFor(page, (src) => {
    const r = document.querySelector('.tut-spot');
    if (!r || r.hidden || !r.classList.contains('is-lit')) return false;
    return new RegExp(src).test(document.querySelector('.tut-spot-tip')?.textContent ?? '');
  }, label, timeout, re);
  /**
   * Measures inside the page when the **floor guide** is laid down after `window.__tutAct()` advanced the step (the
   * action · the judgement · the measurement all finish inside one evaluate, so the round-trip latency cannot eat
   * the 0.5 s).
   *   • `immediate` — is it laid right after the action (it must not be: the new screen has to show first)
   *   • `ms` — how long it took to be laid (= `TUTORIAL_STEP_DELAY_S`)
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
  /* 2026-09-22 (TODO E-12 ⓒ): the old-save checks used to reload the page — a whole boot each (~5 s) to make
     `TutorialSystem.load` read an edited save. Now: back to the title (`game:abort`, what 「타이틀로」 does), the save
     edited **after** that (so nothing the running tutorial persists on the way out can overwrite it), the tutorial
     re-initialised in place (`debugReinit` = dispose + fresh fields + `init`) and the ship entered from the title as a
     boot does. The one reload kept (section 6) is the persistence check itself. */
  const softReload = async (edit) => {
    await P(() => window.__game.ctx.bus.emit('game:abort', {}));
    await waitFor(page, () => window.__game.ctx.phase === 'menu', 'title phase');
    await P(edit);
    await P(() => window.__game.getSystem('tutorial').debugReinit());
    await enterShip();
    await sleep(300);
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

  /* ── 1. Auto-start + the intro card ──────────────────────────────────── */
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
  // 2026-09-08: the relock raised on entering the ship must not take the cursor away from the card (the buttons
  // could not be pressed)
  ok(intro.cursorOn, '카드가 뜬 채로 마우스 커서가 살아 있다 (body.cursor-on)');
  ok(intro.ev && intro.ev.active === true && intro.ev.step === 'intro' && intro.ev.count === 5, `tutorial:changed {intro, 1/5} (${JSON.stringify(intro.ev)})`);
  const order = await P(() => window.__game.getSystem('tutorial').constructor && null);
  void order;

  /* 2026-09-17 (B-17): when a cutscene takes the screen this card **hides rather than closes**
     (`shared/cutsceneHide`). The 「close every UI」 right before docking cannot close this card (it is outside the
     escape stack), so it used to float over the cutscene. While it hides it has to put the blocker · the cursor down
     too — otherwise the cursor shows over the cutscene and the ship's relock is blocked. It comes back unchanged
     when the cutscene ends. */
  const cine = await P(() => {
    const ctx = window.__game.ctx;
    ctx.bus.emit('hub:docking', { stage: 'start', direction: 'dock' });
    const hidden = {
      popup: document.querySelector('.tut-popup').hidden,
      blocker: ctx.uiBlockers.has('tutorial'),
      cursorOn: document.body.classList.contains('cursor-on'),
    };
    ctx.bus.emit('hub:docking', { stage: 'end', direction: 'dock' });
    return {
      hidden,
      back: {
        popup: !document.querySelector('.tut-popup').hidden,
        blocker: ctx.uiBlockers.has('tutorial'),
        title: document.querySelector('.tut-popup-card .title')?.textContent,
        step: ctx.tutorial.step,
      },
    };
  });
  ok(cine.hidden.popup, '도킹 컷씬이 시작되면 시작 카드가 숨는다', JSON.stringify(cine.hidden));
  ok(!cine.hidden.blocker && !cine.hidden.cursorOn, '숨는 동안 tutorial 블로커 · 소프트 커서도 내려놓는다', JSON.stringify(cine.hidden));
  ok(cine.back.popup && cine.back.blocker && cine.back.title === '튜토리얼' && cine.back.step === 'intro',
    '컷씬이 끝나면 같은 카드가 단계를 그대로 두고 돌아온다', JSON.stringify(cine.back));

  /* 2026-09-14 (three tracks): a fresh profile runs the **build track** first — the raid · ship tracks are written
     done the moment the ship is entered (`autoStart`), and the HUD gates (`hides('hud', …)`) hide nothing, being
     outside the raid track. The control guide on the right does not come up either: the build track has no control
     to teach. */
  const tracks = await P(() => {
    const t = window.__game.ctx.tutorial;
    return {
      track: t.track,
      raid: t.isTrackDone('raid'), ship: t.isTrackDone('ship'), build: t.isTrackDone('build'), raid2: t.isTrackDone('raid2'),
      hud: ['vitals', 'weapon', 'stamina', 'implant', 'stratagem'].map((p) => t.hides('hud', p)),
      controls: document.querySelector('.tut-controls')?.hidden ?? null,
      ev: window.__ev['tutorial:changed'].slice(-1)[0]?.track ?? null,
    };
  });
  ok(tracks.track === 'build' && tracks.ev === 'build', `새 프로필은 증축 트랙부터 돈다 (${JSON.stringify(tracks)})`);
  ok(tracks.raid === true && tracks.ship === true && tracks.build === false && tracks.raid2 === false,
    '레이드 · 함선 트랙은 끝난 것으로, 증축은 도는 중으로, 출격은 아직 시작 전으로 답한다', JSON.stringify(tracks));
  ok(tracks.hud.every((h) => h === false), '증축 트랙에서는 HUD 를 하나도 감추지 않는다', JSON.stringify(tracks.hud));
  ok(tracks.controls === true, '우측 조작 가이드는 증축 트랙에서 뜨지 않는다');

  /* ── 2. The gates enforce the order ─────────────────────────────────── */
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

  /* ── 3. Ship management · the workshop · the workbench ───────────────── */
  console.log('하우징 → 작업실 → 작업대');
  ok(await clickPopup('시작'), '시작 버튼');
  await waitStep('manage');
  /* 2026-09-14 2nd pass: so the tick animation can be seen, the objective panel holds **only the next step's
     objective rows** for `TUTORIAL_STEP_DELAY_S` (0.5 s) (the progress bar · the track name are immediate). The step
     machine has already moved on, so that half beat is waited out here. */
  await sleep(700);
  const afterIntro = await P(() => ({
    popup: document.querySelector('.tut-popup').hidden,
    blocker: window.__game.ctx.uiBlockers.has('tutorial'),
    /* 2026-09-14 2nd pass: the two lines `.tut-title` · `.tut-hint` became a **list of checkbox objective rows**.
       The text is read from `.tut-obj-txt` — `.tut-obj-label` lays the same text down a second time for the
       strike-through, so it appears twice. */
    title: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent).join(' | '),
  }));
  ok(afterIntro.popup && !afterIntro.blocker && /시설 관리 열기/.test(afterIntro.title ?? ''), '카드가 닫히고 목표가 시설 관리 열기로 바뀐다', JSON.stringify(afterIntro));
  /* 2026-09-08: this step has no open screen — what is lit is the `시설 관리` key hint that always sits bottom
     right (`ui/hud/ShipManageHint`, `.ship-hint`). It says where to look in the first place. */
  await waitSpot('시설 관리', 'spotlight (시설 관리 힌트)');
  const manageSpot = await P(() => {
    const r = window.__hole();
    const h = document.querySelector('.ship-hint').getBoundingClientRect();
    return { tip: document.querySelector('.tut-spot-tip')?.textContent ?? '', dx: Math.round(Math.abs(r.left - h.left)), dy: Math.round(Math.abs(r.top - h.top)) };
  });
  ok(/시설 관리/.test(manageSpot.tip) && manageSpot.dx <= 10 && manageSpot.dy <= 10,
    '포커싱이 우측 하단 시설 관리 버튼에 붙는다', JSON.stringify(manageSpot));
  /* ── 3b. The generator step is skipped (2026-09-13, power allocation removed) ─
     A new ship's generator is Lv.1 from the start, so the `generator` step has nothing to do — the moment
     `TutorialSystem.setStep` announces it (`tutorial:changed {generator}`) it hands straight on to `workshop`. There
     is no action anywhere that raises the generator. */
  const genPre = await P(() => ({ level: window.__game.ctx.housing.getFacility('generator').level, n: window.__ev['tutorial:changed'].length, step: window.__game.ctx.tutorial.step }));
  ok(genPre.level === 1 && genPre.step === 'manage', `새 함선의 발전기는 이미 Lv.1 이다 (Lv.${genPre.level}, 단계 ${genPre.step})`);
  // Top the materials up — extending a room into the workshop needs them
  await P(() => {
    const ctx = window.__game.ctx;
    const give = (id, n) => { const max = ctx.loot.getItemDef(id).stackMax ?? 1; let a = 0; while (a < n) { const q = Math.min(max, n - a); if (!ctx.inventory.tryAddItem(ctx.loot.createItem(id, q))) break; a += q; } };
    give('mat_scrap', 40); give('mat_cable', 8); give('mat_alloy', 8);
  });

  /* ── 3b-2. The focus lights half a beat late (2026-09-09) ───────────────
     The moment 시설 관리 opens, the step moves ship management → (the generator) → the workshop and the next target
     (`.sm-purpose[data-purpose="workshop"]`) shows in that same moment. The spotlight still folds away the instant
     the step moves on and lights again at the new place only `TUTORIAL_STEP_DELAY_S` (0.5 s) later — "the new screen
     shows first and the focus follows". As it lights, the dim plates darken over `--tut-dim-fade`
     (= `TUTORIAL_DIM_FADE_S`) (`.tut-spot.is-lit`).
     2026-09-13: the generator → workshop transition is gone, so the measurement moved to this one (the 시설 관리
     hint → the workshop row). */
  const relight = await P(async () => {
    const spot = () => document.querySelector('.tut-spot');
    const lit = () => { const r = spot(); return !!r && !r.hidden && r.classList.contains('is-lit'); };
    const sp = () => window.__game.getSystem('tutorial').spotlight;
    const before = lit();
    const t0 = performance.now();
    window.__game.ctx.housing.openShipManage(0);                       // 2026-09-17: the same step's next row (시설 관리 열기 → 작업실 증축)
    const acted = window.__game.ctx.housing.shipManageMode === true && window.__game.ctx.tutorial.step === 'manage'
      && window.__game.getSystem('tutorial').done.has('manageOpen');
    const immediate = lit();
    let midway = null, ms = -1, sawPending = false;
    while (performance.now() - t0 < 15000) {
      /* `Spotlight.pending` starts counting **only once the target has been found on screen** (`update`'s `timer`
         finds it at the next `RETARGET_INTERVAL`) — so the old assertion, which read `pending` at the single 0.3 s
         point, went red when that first look came late and saw `wait -1` (not counting yet). Whether the half beat
         really ran is judged by **having seen it counting at least once** — the look happens every 8 ms, so a 0.5 s
         countdown cannot be missed. */
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
  /* Both ends are nailed down. The lower one is "it does not light straight away" (≥ 0.3 s), the upper one is "half
     a beat, not some day" (< 2 s — if the 2026-09-09 bug where the counter ran past 0 and counted another 0.5 s
     comes back, it fails here). */
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

  // Any other room purpose is still refused (strictly enforced)
  const wrongPurpose = await P(() => {
    const h = window.__game.ctx.housing;
    return { lounge: h.setRoomPurpose(1, 'lounge'), block: h.purposeBlock(1, 'lounge'), purpose: h.getRoom(1).purpose };
  });
  ok(wrongPurpose.lounge === false && /작업실/.test(wrongPurpose.block ?? '') && wrongPurpose.purpose === 'empty',
    '작업실이 아닌 용도는 거부된다 (사유에 작업실이 나온다)', JSON.stringify(wrongPurpose));
  // The spotlight finds its target and settles half a beat later — wait until the callout changes
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

  /* ── 3c. Crafting → the 가구 창고 → 배치 (2026-09-08) ───────────────── */
  // Crafting only puts the furniture into the **store** — placing it is guided separately (before that the store tab
  // was covered by a dim plate and blocked)
  ok(await step() === 'bench', '작업대를 만들어도 같은 단계다 — 다음 줄(가구 창고 탭)이 열린다');
  const stashed = await P(() => ({
    stored: (window.__game.ctx.housing.getStored() ?? []).filter((s) => s.defId === 'furn_bench_gun').reduce((n, s) => n + s.qty, 0),
    placed: window.__game.ctx.housing.getPlaced().filter((f) => f.room !== 100).length,   // 2026-09-12: 2 cockpit pieces stay
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
  /* 2026-09-09: clicking a store card **only selects** it — it is not a ghost placement. What puts it down is the
     `배치` button on the card's right (`.fcard-place`), and that button drops it straight into the first empty cell
     and emits `housing:furniturePlaced` (the tutorial step advances on that event). */
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
      placed: window.__game.ctx.housing.getPlaced().filter((f) => f.room !== 100).length,   // 2026-09-12: 2 cockpit pieces stay
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

  /* ── 3d. Closing ship management (2026-09-15 — `manageDone` is back in the order) ──── */
  // Once the placement is done it is **`manageDone`**, not `craftGun` — with the management mode open there is no
  // walking to the workshop.
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
  ok(closeStep.step === 'bench' && closeStep.index === 3 && closeStep.count === 5 && closeStep.manage === true,
    '배치 뒤에는 같은 단계의 하우징 모드 닫기 줄 (3/5) — 관리 모드는 아직 열려 있다', JSON.stringify(closeStep));
  // The objective row is `{INVENTORY} 하우징 모드 닫기` — the keycap token is drawn in front, so the textContent is
  // `Tab 하우징 모드 닫기` (only the tail is checked)
  ok(closeStep.objs.length === 4 && closeStep.objs[0] === '총기 작업대 제작' && closeStep.objs[1] === '가구 창고 탭으로 이동'
    && closeStep.objs[2] === '가구 배치' && /하우징 모드 닫기$/.test(closeStep.objs[3]),
    `목표 줄 넷 — 작업대 제작 → 창고 탭 → 배치 → 하우징 모드 닫기 (${closeStep.objs.join(' | ')})`);
  ok(closeStep.spot.exact && /하우징 모드 닫기/.test(closeStep.spot.tip), `키 가이드의 닫기 항목을 밝힌다 ("${closeStep.spot.tip}")`, JSON.stringify(closeStep.spot));
  ok(closeStep.guideLit === false, '하우징 모드가 열려 있는 동안에는 바닥 안내선이 없다');
  ok(closeStep.furnitureOk === null && closeStep.manageExit === false, '작업대 카드는 그대로 허용되고 닫기는 막히지 않는다', JSON.stringify(closeStep));

  /* 2026-09-15: the floor guide's half beat (`TUTORIAL_STEP_DELAY_S`) is armed **the moment the step changes**
     (`TutorialSystem.refreshVisuals` → `Guide.setTarget`; from there it counts down every frame, whatever the screen
     does). The action that advances the step is `closeShipManage()` now, so the measurement hangs off that action
     inside one evaluate (let the round-trip time in between and it stops being a judgement and becomes a race — the
     lesson of the old comment, unchanged). */
  await P(() => {
    window.__tutAct = () => {
      window.__game.ctx.housing.closeShipManage();
      return window.__game.ctx.tutorial.step;   // proof that this action advanced the step
    };
  });
  const guideDelay = await measureGuide();
  ok(guideDelay.acted === 'craftGun' && guideDelay.before === false && guideDelay.immediate === false,
    '하우징 모드를 닫으면 craftGun — 그 직후에는 바닥 안내선이 아직 없다', JSON.stringify(guideDelay));
  ok(guideDelay.ms >= 300 && guideDelay.ms < 2000,
    `바닥 안내선은 스포트라이트와 같은 반 박자 뒤에 깔린다 (${Math.round(guideDelay.ms)} ms)`, JSON.stringify(guideDelay));

  /* 2026-09-15 (user's decision): **reopening** ship management takes the floor guide down (the step stays), and
     closing it brings the guide back half a beat later. */
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

  /* ── 4. The floor grant + the craft gate ──────────────────────────────── */
  console.log('제작');
  // 2026-09-09: in `craftGun` the floor guide points at the workbench
  await waitStep('craftGun');
  const grant = await P(() => ({
    powder: window.__game.ctx.inventory.countDefAll('mat_gunpowder'),
    notify: window.__ev['ui:notify'].map((n) => n.text).filter((t) => /보급/.test(t)).length,
    guide: !!window.__game.getSystem('tutorial'),
  }));
  ok(grant.powder >= 20 && grant.notify >= 1, `제작 재료가 한 번 지급된다 (화약 ${grant.powder})`);
  /* 2026-09-09: crafting is **one visit to the workbench**, so from `craftGun` on **both** the rifle recipe and the
     `준중량탄` recipe are open (a blocked recipe disappears from the list, so if the rifle's row dropped out the
     moment it was made and an ammo row popped in, the list would jump). */
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

  /* ── 4b. The floor guide ──────────────────────────────────────────────── */
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
  // Reaching the target takes the guide down
  const arrived = await P(() => {
    const ctx = window.__game.ctx;
    const bench = ctx.interactables.all().find((i) => i.id.startsWith('hub_furn_'));
    ctx.player.position.set(bench.position.x, ctx.player.position.y, bench.position.z);
    window.__game.getSystem('tutorial').update(0.5, ctx);
    return !!ctx.scene.getObjectByName('TutorialGuide');
  });
  ok(!arrived, '목표에 도착하면 안내선이 걷힌다');

  /* ── 4c. One bench visit: rifle → ammo → close → equip (2026-09-09) ───────
     The craft flow is **one visit to the workbench**: `craftGun` → `craftAmmo` (the same window) → `openBag` (close
     the window) → `equipGun` → `stowAmmo`. That is why `openCraft` (reopening the window from the bag's craft
     button) left the order. The equipment slots hide while crafting, so the weapon that was made is equipped **after
     the craft window closes**, and `equipGun` lights the 주무기 I · II slots and the bag as one **union** (light
     only one and the other end of the drag lies under a dim plate). */
  console.log('작업대: 소총 → 탄약 → 닫기 → 장착');
  await P(() => window.__game.ctx.inventory.openBenchCraft('gun', 1));
  await sleep(300);
  const crafting = await P(() => {
    const css = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'gone'; };
    return {
      isCraft: document.querySelector('.inv-root').classList.contains('is-craft'),
      equip: css('.inv-equip'), quick: css('.inv-quick'), tabs: css('.inv-root .scr-tabs'),
      // 2026-09-18: the bag value row sits in the grid's right-hand column (`.inv-bag-side > .inv-bag-readouts`),
      //   so it is not a direct child of the bag panel
      foot: css('.inv-panel-bag .inv-foot'), craftBtn: css('.inv-bag-craft'),
      // 2026-09-14 (user's decision): `모두 수리` is not in the bench header but at the **far left of the bag's
      //   filter row** (`.inv-repair-open-btn`)
      repairBtn: document.querySelector('.inv-repair-open-btn') ? !document.querySelector('.inv-repair-open-btn').hidden : null,
    };
  });
  ok(crafting.isCraft && crafting.equip === 'none' && crafting.quick === 'none' && crafting.tabs === 'none'
    && crafting.foot === 'none' && crafting.craftBtn === 'none',
    '제작 중에는 장비 · 퀵슬롯 · 화면 탭 · 가방의 제작 버튼/가치가 숨는다', JSON.stringify(crafting));
  ok(crafting.repairBtn === true, '작업대 창에서도 가방 필터 줄의 `모두 수리` 버튼이 보인다');

  /* The rifle's row first. Both recipes are up in the same window and only the spotlight points at "what to make now". */
  await waitSpot('돌격소총', 'spotlight (돌격소총 제작)');
  const gunRow = await P(() => {
    const row = document.querySelector('.inv-craft-cell[data-recipe="make_wpn_ar"]');
    const ammo = document.querySelector('.inv-craft-cell[data-recipe="make_ammo_medium"]');
    return {
      /* 2026-09-15 3rd pass: each recipe is an `.inv-craft-cell`; `.inv-craft-row` is the detail of the chosen one */
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
  /* 2026-09-09 material top-up: once the rifle has eaten the scrap there is not enough left for the `준중량탄` — the
     moment `craftAmmo` is entered, `ensureMaterials` tops up exactly `needed − held` (the numbers come from the
     recipe, so none of them are in the code). */
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

  /* The craft window is closed **only after** the rifle and the ammo are both made (`openBag`). */
  await waitSpot('닫기', 'spotlight (제작 창 닫기)');
  const closeSpot = await P(() => window.__spotOn(['.inv-craft-close', '.inv-panel-craft']));
  ok(closeSpot.exact && closeSpot.sel[0] === '.inv-craft-close',
    `「제작창 닫기」 줄은 제작 창의 닫기를 밝힌다 ("${closeSpot.tip}")`, JSON.stringify(closeSpot));
  await P(() => document.querySelector('.inv-craft-close').click());
  await waitStep('equipGun');
  ok(true, '제작 창을 닫으면 장착 단계로 넘어간다');

  /* 2026-09-16 (the user's report 「작업대 창을 닫았는데 가방이 열린다」, `inventory/parts/Crafting.closeCraftWindow`):
     **a window the bench opened is the bench's window**, so `닫기` does not fold the craft column alone but closes
     the whole window. `equipGun` therefore starts with the window closed, and with no DOM to light the spotlight
     never comes up (`parts/Spotlight` folds itself away when it cannot find its target — it never leaves dim plates
     with nothing pressable under them). The one piece of guidance left is 「the key that reopens the window」, and
     the place that writes it is the control guide on the right (`model.EQUIP_HINTS`). */
  await sleep(900);      // checks nothing comes up past the half beat (`TUTORIAL_STEP_DELAY_S` 0.5 s) — if it does, a ring hangs in mid-air
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
  /* The tutorial always leaves the inventory tab open (`screenTab` in `parts/Gates.blockReason`) — Tab reopens it. */
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

  /* 2026-09-09: `equipGun` lights the 주무기 I · II slots + the bag, not the **whole** equipment column — 보조무기 ·
     방탄복 · the 가방 slot · the implant slots have nothing to do with this step. The hole is always one rectangle,
     so it becomes the smallest rectangle around the three, which `parts/Spotlight.place` widens by `PAD` (6 px) and
     freezes on integer edges. */
  await waitSpot('주무기', 'spotlight (주무기 I · II + 창고·가방 카드)');
  const union = await P(() => {
    /* 2026-09-15 3rd pass (user's decision 「제작품은 함선 창고로」): the rifle that was made is in the stash, so the
       last target is `.inv-panel-bag` → **`.inv-panel-grids`** (stash + bag in one card). The hole is still one
       rectangle. */
    /* 2026-09-16 (user's decision 「창고 | 장비 | 가방」): the stash came out of the bag card (left of the equipment
       column), so the last target is `.inv-panel-stash`. */
    const s = window.__spotOn(['.inv-root .inv-equip .inv-slot-primary', '.inv-root .inv-equip .inv-slot-primary2', '.inv-panel-stash'], true);
    /* Whether the three targets really landed inside the hole. The hole **cannot leave the viewport** (the clamp in
       `Spotlight.place`), so this check also checks "the inventory window stands inside the screen" — on 2026-09-12,
       when `.inv-root` moved from centring vertically to `flex-start + padding-top`, the bag panel of the 1280×760
       ship window dropped to 811 px (the screen is 760) and was caught here as `bag:false` (`.inv-bag-scroll`'s ship
       budget in `inventory.css`). */
    const inside = (sel) => {
      const e = document.querySelector(sel);
      if (!e || !s.hole) return null;
      const b = e.getBoundingClientRect();
      return s.hole.left <= b.left && s.hole.right >= b.right && s.hole.top <= b.top && s.hole.bottom >= b.bottom;
    };
    // What hole the old selectors (the **whole** equipment column + the bag) would have made — it must differ from this one
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
  // 2026-09-17 (user's decision): the equip focus does not dim the whole screen
  const noDim = await P(() => {
    const r = document.querySelector('.tut-spot');
    const pane = document.querySelector('.tut-spot-pane');
    return { nodim: !!r?.classList.contains('is-nodim'), bg: pane ? getComputedStyle(pane).backgroundColor : null, pe: pane ? getComputedStyle(pane).pointerEvents : null };
  });
  ok(noDim.nodim && /rgba\(4, 6, 9, 0\)/.test(noDim.bg ?? '') && noDim.pe === 'none', '장착 포커싱은 딤 없이 (판이 투명하고 클릭이 통과한다)', JSON.stringify(noDim));

  /* 2026-09-09: whether the steps · indices really walked so far match the new order (no `openCraft`). */
  const seq = await P(() => window.__ev['tutorial:changed'].filter((e) => e.active).map((e) => ({ s: e.step, i: e.index, n: e.count })));
  // 2026-09-15: `manageDone` (closing ship management) came back between `benchPlace` and `craftGun` — 17 steps
  // 2026-09-17: 7 steps — there is no step change between the rows inside a grouped step (2026-09-18: the last two
  //   left for `raid2`, so **5 steps**)
  const WANT = ['intro', 'manage', 'bench', 'craftGun', 'equipGun'];
  ok(seq.map((e) => e.s).join(' ') === WANT.join(' '), `밟은 단계가 새 순서 그대로다 (${seq.map((e) => e.s).join(' ')})`);
  ok(seq.every((e, i) => e.i === i + 1 && e.n === 5) && !seq.some((e) => e.s === 'openCraft'),
    '순번은 1..5 / 5 이고 옛 단계 id 는 순서에 없다', JSON.stringify(seq.slice(-3)));

  /* 2026-09-09: whether the four dim plates cover the screen **with no seam**. Each plate used to round its own
     top/height, so a fractional rectangle left a 1 px bright band above and below the hole (most visible at step 8). */
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

  /* 2026-09-09: the objective panel is **always** above the inventory window (.inv-root, z 50 + blur) (it used to be
     only while the focus was up). */
  const zorder = await P(() => ({
    panel: Number(getComputedStyle(document.querySelector('.tut-panel')).zIndex),
    inv: Number(getComputedStyle(document.querySelector('.inv-root')).zIndex),
  }));
  ok(zorder.panel > zorder.inv, `목표 패널이 인벤토리 창 위에 있다 (${zorder.panel} > ${zorder.inv})`, JSON.stringify(zorder));

  /* 2026-09-09: putting it in the 주무기 **II** slot ends the equip step too (`TutorialSystem.onLoadout` — either one). */
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
  // 2026-09-10: the 보조무기 slot is gone, so the starter grant puts the SMG in **주무기 I** — that slot is not
  //   empty the way it used to be.
  // 2026-09-17 (user's decision): even after equipping, the step stays **until the inventory closes** (with no
  //   objective row) — the focus is taken down
  ok(equipped.primary2 === 'wpn_ar' && equipped.step === 'equipGun' && equipped.open && !equipped.spotLit,
    '주무기 II 칸에 장착하면 체크가 그어지고 포커싱이 걷히지만, 창이 열려 있는 동안은 같은 단계다 — 그 장착으로 주무기 두 칸이 다 차도 그렇다 (2026-09-18 의 건너뛰기 판정은 **창이 열리는 순간**만 본다)', JSON.stringify(equipped));
  await P(() => window.__game.ctx.inventory.closeAll());
  await waitStep('terminal');
  ok(true, '인벤토리를 닫으면 조종석 단계다 (탄약을 가방에 넣는 단계는 없다)');
  await sleep(700);

  /* ── 4c. 증축 안내 ends and 출격 안내 chains on by itself (2026-09-18, user's decision) ──────────────
     `equipGun` is the **last** step of the build track now. The moment the inventory closes, that track ends
     (`finish` → `pendingRaid2`) and **inside the same call** `autoStart` opens 「출격 안내」 — the player presses
     nothing. */
  const chain = await P(() => {
    const t = window.__game.ctx.tutorial;
    return {
      track: t.track, step: t.step, index: t.stepIndex, count: t.stepCount,
      label: document.querySelector('.tut-panel .tut-track')?.textContent ?? null,
      objs: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent),
      fin: window.__ev['tutorial:finished'].slice(-1)[0],
      saved: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    };
  });
  ok(chain.fin?.track === 'build' && chain.fin?.skipped === false,
    '장착을 마치고 창을 닫으면 증축 안내가 끝난다 (건너뛴 것이 아니다)', JSON.stringify(chain.fin));
  ok(chain.track === 'raid2' && chain.step === 'terminal' && chain.index === 1 && chain.count === 2 && chain.label === '출격 안내',
    '아무것도 누르지 않아도 출격 안내가 이어진다 (조종석 단계 1/2)', JSON.stringify(chain));
  ok(chain.saved?.tracks?.build?.done === true && chain.saved?.tracks?.build?.step === null
    && chain.saved?.tracks?.raid2?.step === 'terminal' && chain.saved?.tracks?.raid2?.done === false,
    '저장도 두 트랙으로 갈린다 (증축 done · 출격 terminal)', JSON.stringify(chain.saved?.tracks));
  ok(/조종석으로 이동/.test(chain.objs.join(' ')), `출격 안내의 첫 목표는 조종석으로 이동 (${chain.objs.join(' | ')})`);

  /* ── 4c2. Equip passes with nothing to do (2026-09-18, the report 「이미 장착했는데도 장착하라고 한다」) ───────
     ① **both 주무기 slots are full** — there is no empty slot to put one in, so it passes the moment it is entered
        (`equipGunMoot` · `setStep`).
     ② **an assault rifle is already held** — it need not be the rifle that was made (`wpn_ar`): the class · grade
        are what the csv says (`class` in `weapons.csv`). This one is judged not on entering the step but **the
        moment the inventory opens** (right where the player presses Tab to check). */
  const mootFull = await P(() => {
    const ctx = window.__game.ctx;
    const t = ctx.tutorial;
    const l = ctx.inventory.getLoadout();
    t.goto('equipGun');
    return { primary: l.primary?.defId ?? null, primary2: l.primary2?.defId ?? null, step: t.step, track: t.track };
  });
  ok(!!mootFull.primary && !!mootFull.primary2 && mootFull.step === 'terminal' && mootFull.track === 'raid2',
    '주무기 I · II 가 다 차 있으면 장착 단계는 들어서는 즉시 지나간다 (그리고 출격 안내로 이어진다)', JSON.stringify(mootFull));

  const mootAr = await P(async () => {
    const ctx = window.__game.ctx;
    const t = ctx.tutorial;
    const sys = window.__game.getSystem('tutorial');
    ctx.inventory.closeAll();
    // An assault rifle of **another grade**, not the one that was made — the id differs, so `onLoadout` does not
    //   count it as the objective (the judgement is the class)
    const arId = ['ar_g2', 'ar_g3', 'ar_g4', 'ar_g5'].map((w) => `wpn_${w}`).find((id) => ctx.loot.getItemDef(id)) ?? null;
    // Emptying them goes **to the stash** (the bag is nearly full already). ⚠ `moveToStash` is accepted only while
    //   the ship Tab window is open (`hubMode` in `StashOps.moveToStash`) — called with it closed it silently
    //   returns 'fail', both slots stay full, and then the entry judgement (both slots full) fires first and this
    //   passage never stands at all.
    if (!ctx.inventory.isOpen) window.__game.getSystem('inventory').toggleBag();
    const l0 = ctx.inventory.getLoadout();
    if (l0.primary) ctx.inventory.moveToStash(l0.primary.uid, { kind: 'slot', slot: 'primary' });
    if (l0.primary2) ctx.inventory.moveToStash(l0.primary2.uid, { kind: 'slot', slot: 'primary2' });
    ctx.inventory.closeAll();
    t.goto('equipGun');
    const empty = { step: t.step, primary: ctx.inventory.getLoadout().primary?.defId ?? null };
    const it = ctx.loot.createItem(arId, 1);
    ctx.inventory.tryAddItemAnywhere(it);
    ctx.inventory.equip(it.uid, 'primary');
    await new Promise((r) => setTimeout(r, 80));
    const armed = { step: t.step, equipSlot: sys.done.has('equipSlot'), primary: ctx.inventory.getLoadout().primary?.defId ?? null };
    window.__game.getSystem('inventory').toggleBag();
    await new Promise((r) => setTimeout(r, 80));
    const opened = { step: t.step, track: t.track, open: ctx.inventory.isOpen };
    ctx.inventory.closeAll();
    return { arId, empty, armed, opened };
  });
  ok(mootAr.empty.step === 'equipGun' && mootAr.empty.primary === null,
    '주무기를 비우면 장착 단계는 할 일이 있다 (그 자리에 머문다)', JSON.stringify(mootAr.empty));
  ok(!!mootAr.arId && mootAr.armed.step === 'equipGun' && mootAr.armed.equipSlot === false,
    `다른 등급의 돌격소총(${mootAr.arId})은 「돌격소총 장착」 목표로 치지 않는다 (만든 그 소총이 아니다)`, JSON.stringify(mootAr.armed));
  ok(mootAr.opened.step === 'terminal' && mootAr.opened.track === 'raid2' && mootAr.opened.open === true,
    '그 상태로 인벤토리를 여는 순간 장착 단계가 통째로 끝난다 (계열 · 등급 무관)', JSON.stringify(mootAr.opened));

  /* ── 4d. The ammo recipe's shape (2026-09-10 the big craft rework; `stowAmmo` went on 2026-09-17) ──────
     `bulk_ammo_medium` (bulk craft, 90 rounds) left the csv and `make_ammo_medium` (30 rounds) took its place.
     Two things are nailed down — ① whether that recipe is **shaped so it can appear in a bench window**
     (`station: 'field'` · no `bench` → `getRecipes` loads it in bench mode too), ② `stowAmmo` only looks at "is
     there `준중량탄` in the bag", so it is **independent of the quantity** (the amount made is the recipe's
     `outputQty`, and that value is read from the csv here too — no number is written into the smoke). */
  const ammoRecipe = await P(() => {
    const ctx = window.__game.ctx;
    const r = ctx.loot.getAllRecipes().find((x) => x.id === 'make_ammo_medium');
    return r ? { station: r.station, bench: r.bench ?? null, outputQty: r.outputQty, out: r.outputDefId } : null;
  });
  /* 2026-09-10 (user's decision) — opening a workbench shows **only that workbench's recipes**. So a field recipe
     names its own bench in `data/recipes.csv` too: the ammo is `station: field` + `bench: gun`, so it can be made
     anywhere and still appears in the gun workbench's window — the tutorial's "the rifle → the ammo in the same
     window" leans on that. */
  ok(!!ammoRecipe && ammoRecipe.station === 'field' && ammoRecipe.bench === 'gun' && ammoRecipe.out === 'ammo_medium',
    '탄약 레시피는 field 이면서 총기 작업대 소속이다 (어디서든 제작 + 총기 작업대 창에 표시)', JSON.stringify(ammoRecipe));
  /* 2026-09-09: the stash shows only what the tutorial uses (the `stashItem` gate — the data is untouched, it is
     just not drawn) */
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

  /* ── 5. The 건너뛰기 confirm card ─────────────────────────────────────── */
  /* 2026-09-14 2nd pass (user's decision): the panel's `.tut-skip` button is gone and skipping moved to the **ESC
     menu** (`ui/menus/PauseMenu` — while the tutorial runs, the `함선으로 귀환` entry becomes `튜토리얼 건너뛰기`).
     So what is checked here is that the path really ends the track — the confirm is `.pause-ask`'s 1 s hold. */
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
  /* Cancelling leaves the step as it was — nothing is really skipped (6 below keeps using the same save). */
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

  /* ── 6. The progress survives a reload ────────────────────────────────── */
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

  /* 2026-09-09: `openCraft` left the order but its id stays in the contract (`TutorialStepId`) — a save holding that
     step continues at `craftAmmo`, which took its place (`Steps.normalizeStep`). The save does not break and start
     over. */
  await softReload(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.tracks.build.step = 'openCraft';
    localStorage.setItem('scav.s1.tutorial', JSON.stringify(s));
  });
  const stale = await P(() => {
    const t = window.__game.ctx.tutorial;
    return { active: t.active, step: t.step, index: t.stepIndex, count: t.stepCount };
  });
  ok(stale.active && stale.step === 'craftGun' && stale.index === 4 && stale.count === 5,
    'openCraft 를 들고 있던 저장은 craftGun(4/5) 으로 이어진다', JSON.stringify(stale));
  const staleObjs = await P(() => [...window.__game.getSystem('tutorial').done]);
  ok(['craftGunWalk', 'craftGunOpen', 'craftGunMade'].every((id) => staleObjs.includes(id)) && !staleObjs.includes('craftAmmoMade'),
    '그 자리에서 이미 한 줄(이동 · 작동 · 소총)이 채워진다 — 준중량탄부터 이어진다', JSON.stringify(staleObjs));
  // 2026-09-17: and the other ids that vanished into a group — `manageDone` arrives with bench filled to its last row
  await softReload(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.tracks.build.step = 'manageDone';
    localStorage.setItem('scav.s1.tutorial', JSON.stringify(s));
  });
  const staleBench = await P(() => ({ step: window.__game.ctx.tutorial.step, done: [...window.__game.getSystem('tutorial').done] }));
  // The reload left ship management closed → 「하우징 모드 닫기」 has nothing to do, so it goes straight on (the old
  // `manageDone`'s silent pass)
  ok(staleBench.step === 'craftGun', `manageDone 저장은 bench 로 옮겨지고, 관리 모드가 닫혀 있으면 곧장 craftGun 이다 (${staleBench.step})`, JSON.stringify(staleBench));
  /* 2026-09-18 (증축 안내 · 출격 안내 split apart): a saved step became **another track's**. `board` left the old
     order and folds into `terminal`, and that `terminal` now belongs to 「출격 안내」 (`raid2`) — throwing it away
     would lose that player's guidance whole, so `load()` **moves** it to that track and writes the build track it
     already passed as done (it is not run again). The rows already ticked there (`Steps.retiredObjectives`) come
     along too. */
  await softReload(() => {
    const s = JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? '{}');
    s.tracks.build = { step: 'board', done: false };
    delete s.tracks.raid2;
    localStorage.setItem('scav.s1.tutorial', JSON.stringify(s));
  });
  const moved = await P(() => {
    const sys = window.__game.getSystem('tutorial');
    return {
      track: sys.track, step: sys.step, index: sys.stepIndex, count: sys.stepCount,
      tracks: JSON.parse(JSON.stringify(sys.save.tracks)), done: [...sys.done],
    };
  });
  ok(moved.track === 'raid2' && moved.step === 'terminal' && moved.index === 1 && moved.count === 2,
    'board 를 들고 있던 옛 저장은 출격 안내의 terminal(1/2) 로 옮겨진다', JSON.stringify(moved));
  ok(moved.tracks.build?.done === true && moved.tracks.build?.step === null,
    '지나온 증축 트랙은 끝난 것으로 적힌다 (옛 저장이 증축 안내를 다시 하지 않는다)', JSON.stringify(moved.tracks));
  ok(['terminalWalk', 'terminalOpen', 'planetPicked', 'travelDone'].every((id) => moved.done.includes(id)),
    '그 자리에서 이미 한 줄(조종석 · 터미널 · 행성 · 워프)이 함께 옮겨진다', JSON.stringify(moved.done));
  const gotoStale = await P(() => {
    const t = window.__game.ctx.tutorial;
    const ret = t.goto('openCraft');
    const step = t.step;
    t.goto('board');
    return { ret, step, board: t.step, boardTrack: t.track };
  });
  ok(gotoStale.ret === true && gotoStale.step === 'craftGun' && gotoStale.board === 'terminal' && gotoStale.boardTrack === 'raid2',
    'goto("openCraft") 는 craftGun, goto("board") 는 **출격 안내의** terminal 로 접힌다 (콘솔 · 저장 경로가 같은 판정을 쓴다)', JSON.stringify(gotoStale));
  await P(() => window.__game.ctx.tutorial.goto('craftGun'));
  await sleep(150);

  /* ── 7. The console command + the steps left ──────────────────────────── */
  console.log('콘솔 · 남은 단계');
  await P(() => window.__game.ctx.tutorial.goto('planet'));   // 2026-09-17: → terminal (2026-09-18: that step is 출격 안내 now)
  // Only PLANET_IDS[0] = 'amber' is allowed
  const planetGate = await P(() => {
    const hub = window.__game.getSystem('hub');
    return { first: hub.travelBlockReason('amber'), second: hub.travelBlockReason('mossy') };
  });
  ok(planetGate.first === null, `첫 번째 행성은 허용된다 (${JSON.stringify(planetGate.first)})`);
  ok(planetGate.second !== null && /첫 번째/.test(planetGate.second), `그 외 행성은 거부된다 ("${planetGate.second}")`);
  // 2026-09-15: the `matchmaking` gate hides the terminal's **매칭 tab** outright — choosing the tab stays on 행성
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
  /* 2026-09-17: the order holds inside a single step too — the pod opens only once the 「발사 슬롯으로 이동」 row is
     open (`allow` per objective). The training-range button · the ready warning stay hidden for the whole track. */
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
  ok(termGate.training && termGate.warn && termGate.trainRowHidden, '함선 안에서 도는 두 트랙(증축 · 출격) 내내 훈련장 버튼과 출격 준비 경고가 숨는다', JSON.stringify(termGate));
  await P(() => { const sys = window.__game.getSystem('tutorial'); sys.markObjective('planetPicked'); sys.markObjective('travelDone'); });
  const boardOk = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    return { prompt: it?.getPrompt() ?? null, block: window.__game.ctx.tutorial.blockReason('board') };
  });
  ok(boardOk.block === null && !/튜토리얼/.test(boardOk.prompt ?? '튜토리얼'), `워프가 끝나 「발사 슬롯으로 이동」이 열리면 포드가 열린다 ("${boardOk.prompt}")`, JSON.stringify(boardOk));

  /* 2026-09-18 (the report 「발사 슬롯에서 준비를 마치면 바닥 안내선이 딴 데를 가리킨다」): a step whose required
     objectives are **all** done has nowhere to walk to and nothing to light. The step used to fall back to its own
     `guide` (the cockpit) · `spot` once every objective row was done, so someone already aboard the pod and readied
     up had a 「walk to the cockpit」 line lying there until launch. Whether the line is really laid depends on the
     distance between the player and the target (`GUIDE_ARRIVE` in `parts/Guide.update`), so it is judged by **the
     guide's target id**. */
  const doneStep = await P(() => {
    const sys = window.__game.getSystem('tutorial');
    const at = sys.guide.targetId;                 // the 「발사 슬롯으로 이동 · 탑승」 row → the pod
    sys.markObjective('boardWalk');
    sys.markObjective('boardOn');
    const ready = sys.guide.targetId;              // the 「시작 준비」 row → nowhere to walk (`guide: null`)
    sys.markObjective('readyHold');
    return {
      at, ready, after: sys.guide.targetId, step: sys.step, track: sys.track,
      spot: document.querySelector('.tut-spot').hidden,
    };
  });
  ok(doneStep.at === 'hub_pod_0', `발사 슬롯 줄에서는 안내선이 포드를 가리킨다 (${doneStep.at})`);
  ok(doneStep.ready === null, `「시작 준비」 줄에는 걸어갈 곳이 없다 (${doneStep.ready})`);
  ok(doneStep.after === null && doneStep.spot === true && doneStep.step === 'terminal',
    '준비까지 끝나면 안내선도 포커싱도 걷힌다 — 단계의 조종석 안내선으로 되돌아가지 않는다', JSON.stringify(doneStep));

  /* ── 7b. Last raid step (2026-09-17) — objective row · count · guide, ends back in the ship (no completion toast) ──────── */
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

  /* 2026-09-18 (user's decision): this step's progress bar measures **the loot value, not the step count**. The fill
     is clipped at 1 but the number above the bar is the **real value** — writing `1,000 C / 1,000 C` for someone
     carrying 1,400 C reads as if the extra had disappeared. The goal value is read from the csv
     (`TUTORIAL_RAID_EXTRACT_VALUE_C`), so no number is written here. */
  const gauge = await P(() => {
    const sys = window.__game.getSystem('tutorial');
    const ko = (n) => Math.round(n).toLocaleString('ko-KR');     // the grouping commas of `shared/formatCredits`
    const en = (n) => Math.round(n).toLocaleString('en-US');     // the objective row's tag (`ui/Panel.countText`)
    const bar = () => {
      const el = document.querySelector('.tut-panel .tut-bar-n');
      return {
        label: el?.textContent ?? null, hidden: el?.hidden ?? null,
        fill: document.querySelector('.tut-panel .tut-bar i')?.style.transform ?? null,
      };
    };
    const total = sys.panelInfo()?.gauge?.total ?? 0;
    const zero = bar();
    const over = Math.round(total * 1.4);                        // someone carrying past the goal
    sys.raidValue = over;
    sys.panel.setGauge(sys.raidGauge());
    sys.panel.setCounts(sys.objectiveCounts());
    return {
      total, over, zero, full: bar(),
      want: `${ko(over)} C / ${ko(total)} C`, wantZero: `0 C / ${ko(total)} C`, wantRow: ` (${en(total)} / ${en(total)} C)`,
      row: [...document.querySelectorAll('.tut-panel .tut-obj-txt')].map((e) => e.textContent)[0] ?? null,
    };
  });
  ok(gauge.total > 0 && gauge.zero.hidden === false && gauge.zero.label === gauge.wantZero,
    `진행 바 위에 전리품 가치가 적힌다 (${gauge.zero.label})`, JSON.stringify(gauge.zero));
  ok(gauge.full.label === gauge.want, `목표를 넘겨도 **실제 값**을 적는다 (${gauge.full.label} / want ${gauge.want})`);
  ok(/scaleX\(1(\.0+)?\)/.test(gauge.full.fill ?? ''), `바의 채움은 1 에서 잘린다 (${gauge.full.fill})`);
  ok((gauge.row ?? '').endsWith(gauge.wantRow), `목표 줄의 꼬리표는 목표 값에서 멈춘다 (${gauge.row})`);

  /* 2026-09-18 (user's decision — 「튜토리얼 레이드에서는 지도에도 목표를 띄운다」): the same objectives stand **at
     the very top** of the tactical map's left column (the tutorial panel in `ui/map/QuestPanels`, above the NPC quest
     list). There is one source, `ctx.tutorial.panelInfo()`, so the two screens cannot go out of step. The map itself
     only opens with a world (`world.ready` in `MapScreen.open`), so in the ship only that panel is redrawn directly
     and 「the map opened」 is announced over the bus — while it is open the floating objective panel folds away (so
     the same objectives never appear twice). */
  const mapPanel = await P(() => {
    const ctx = window.__game.ctx;
    window.__game.getSystem('hud').map.quests.refresh(true);
    const rows = [...document.querySelectorAll('.mq-tut .mq-obj')].map((r) => ({
      l: r.querySelector('.mq-obj-l')?.textContent ?? '', n: r.querySelector('.mq-obj-n')?.textContent ?? '',
      box: !!r.querySelector('.mq-tut-box'), done: r.classList.contains('is-done'),
    }));
    ctx.bus.emit('ui:mapToggled', { open: true });
    const whileOpen = document.querySelector('.tut-panel').hidden;
    ctx.bus.emit('ui:mapToggled', { open: false });
    return {
      hidden: document.querySelector('.mq-tut').hidden,
      name: document.querySelector('.mq-tut .mq-name')?.textContent ?? null,
      sub: document.querySelector('.mq-tut .mq-npc')?.textContent ?? null,
      count: document.querySelector('.mq-tut .mq-count')?.textContent ?? null,
      gauge: document.querySelector('.mq-tut .mq-tut-n')?.textContent ?? null,
      rows, whileOpen, afterClose: document.querySelector('.tut-panel').hidden,
    };
  });
  ok(!mapPanel.hidden && mapPanel.name === '출격 안내' && mapPanel.sub === '튜토리얼' && mapPanel.count === '2 / 2',
    '지도 좌측 열 맨 위에 도는 트랙의 목표 패널이 선다', JSON.stringify(mapPanel));
  ok(mapPanel.rows.length === 1 && mapPanel.rows[0].box && mapPanel.rows[0].l.includes(gauge.total.toLocaleString('en-US'))
    && mapPanel.rows[0].n === `${gauge.total.toLocaleString('en-US')} / ${gauge.total.toLocaleString('en-US')} C`,
    '목표 줄 · 체크박스 · (n/m) 이 안내 패널과 같다', JSON.stringify(mapPanel.rows));
  ok(mapPanel.gauge === gauge.want, `지도에도 같은 게이지 숫자가 선다 (${mapPanel.gauge})`);
  ok(mapPanel.whileOpen === true && mapPanel.afterClose === false,
    '지도가 열려 있는 동안에는 떠 있는 목표 패널이 접힌다 (같은 목표가 두 벌로 겹치지 않게)', JSON.stringify(mapPanel));
  const nNotify = await P(() => window.__ev['ui:notify'].length);
  // Only the ship-entry handling is called (a fake `hub:entered` on the bus would make every other system think the
  // ship had been entered)
  await P(() => window.__game.getSystem('tutorial').onHubEntered('personal'));
  await sleep(300);
  const raidEnd = await P((n) => ({
    active: window.__game.ctx.tutorial.active, fin: window.__ev['tutorial:finished'].slice(-1)[0],
    toasts: window.__ev['ui:notify'].slice(n).map((t) => t.text),
  }), nNotify);
  ok(!raidEnd.active && raidEnd.fin?.skipped === false && raidEnd.fin?.track === 'raid2', '레이드 단계로 함선에 돌아오면 출격 안내가 끝난다 (한 번뿐)', JSON.stringify(raidEnd));
  ok(!raidEnd.toasts.some((t) => /완료/.test(t)), `트랙 완료 토스트는 뜨지 않는다 (${raidEnd.toasts.join(' | ')})`);
  // For the next section (skipping), the **build** track is turned on again and the launch track is put back to
  // not-yet-started (2026-09-18)
  await P(() => { const t = window.__game.ctx.tutorial; t.start(); t.goto('craftGun'); window.__game.getSystem('tutorial').save.tracks.raid2 = { step: null, done: false }; });
  await sleep(150);

  /* ── 8. Skipping releases every restriction ──────────────────────────── */
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
      track: t.track, fin: window.__ev['tutorial:finished'].slice(-1)[0],
      panel: document.querySelector('.tut-panel').hidden, spot: document.querySelector('.tut-spot').hidden,
      saved: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    };
  });
  ok(!after.active && after.step === null && after.fin && after.fin.skipped === true && after.fin.track === 'build', '건너뛰면 튜토리얼이 끝난다', JSON.stringify(after.fin));
  ok(after.lounge === null && after.corp === null && !after.hides, '모든 게이트가 풀린다', JSON.stringify(after));
  ok(after.panel && after.spot, '목표 패널과 스포트라이트가 사라진다');
  ok(after.saved && after.saved.tracks?.build?.done === true && after.saved.tracks?.build?.step === null,
    '끝났다는 것이 저장된다 (그 트랙만)', JSON.stringify(after.saved));
  ok(after.saved && after.saved.tracks?.raid2?.done === true && after.saved.tracks?.raid2?.step === null && after.track === null,
    '증축 안내를 건너뛰면 출격 안내로 이어지지 않는다 (`pendingRaid2` 는 완주에만 선다)', JSON.stringify(after.saved?.tracks));
  const mapEmpty = await P(() => {
    window.__game.getSystem('hud').map.quests.refresh(true);
    return { hidden: document.querySelector('.mq-tut').hidden, info: window.__game.ctx.tutorial.panelInfo() };
  });
  ok(mapEmpty.hidden === true && mapEmpty.info === null,
    '도는 트랙이 없으면 지도의 목표 패널도 그리지 않는다 (퀘스트 목록과 같은 규칙)', JSON.stringify(mapEmpty));

  /* ── 9. It never turns on for a profile already in play ─────────────── */
  console.log('기존 프로필');
  await softReload(() => { try { localStorage.removeItem('scav.s1.tutorial'); } catch { /* off */ } });
  const existing = await P(() => ({
    step: window.__game.ctx.tutorial.step,
    saved: JSON.parse(localStorage.getItem('scav.s1.tutorial') ?? 'null'),
    rooms: (() => { const h = window.__game.ctx.housing; let n = 0; for (let i = 0; i < 10; i++) if (h.getRoom(i).purpose !== 'empty') n++; return n; })(),
  }));
  ok(existing.rooms > 0 && existing.step === null
    && ['raid', 'ship', 'build', 'raid2'].every((t) => existing.saved?.tracks?.[t]?.done === true),
    '이미 함선을 꾸며 놓은 프로필에서는 넷 트랙 전부 조용히 끝난 것으로 표시한다', JSON.stringify(existing));
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
