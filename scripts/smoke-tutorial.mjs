// Single-player smoke test for the tutorial (src/tutorial, 2026-09-08).
// Covers: auto-start on a fresh profile only, the intro card, the objective panel + progress, the strict gates
// (room purpose / furniture / craft / terminal / planet / pod / screen tabs), the community + matchmaking hiding,
// the spotlight (dark panes + ring on the step's target), the 3D floor guide, the one-time material grant,
// step persistence across a reload, the 건너뛰기 confirm card and the console command.
// 2026-09-08: + the 발전기 step, "잠그지 않고 감춘다" (`hides(gate, id)` → 용도 · 화면 탭이 목록에서 빠진다),
// the objective panel staying above the spotlight (`.tut-panel.is-lifted`) and the cursor showing under the card.
// Usage: node scripts/smoke-tutorial.mjs [http://localhost:5273]   (needs `npm run dev`)
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
    // single-player: park vite HMR + the relay socket so no server profile lands mid-run
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws(\?|$)/.test(String(args[0]))) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
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
  await P(() => { try { localStorage.removeItem('scav.tutorial'); } catch { /* off */ } });

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
  ok(intro.ev && intro.ev.active === true && intro.ev.step === 'intro' && intro.ev.count === 16, `tutorial:changed {intro, 1/16} (${JSON.stringify(intro.ev)})`);

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
  await waitFor(page, () => !document.querySelector('.tut-spot')?.hidden, 'spotlight (시설 관리 힌트)');
  const manageSpot = await P(() => {
    const r = document.querySelector('.tut-spot-ring').getBoundingClientRect();
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
  //   모자란다 — 대상이 발전기로 옮겨 붙을 때까지(`RETARGET_INTERVAL`) 말풍선을 보고 기다린다.
  await waitFor(page, () => {
    const r = document.querySelector('.tut-spot');
    return r && !r.hidden && /발전기/.test(document.querySelector('.tut-spot-tip')?.textContent ?? '');
  }, 'spotlight (발전기)');
  const genUi = await P(() => ({
    gen: !!document.querySelector('.sm-gen .sm-gen-btn'),
    purposes: [...document.querySelectorAll('.sm-purposes .sm-purpose')].map((b) => b.dataset.purpose),
    tip: document.querySelector('.tut-spot-tip')?.textContent ?? '',
    lifted: document.querySelector('.tut-panel')?.classList.contains('is-lifted') ?? false,
  }));
  ok(genUi.gen, '용도 목록 맨 위에 발전기 행이 있다');
  ok(genUi.purposes.length === 1 && genUi.purposes[0] === 'workshop',
    '작업실 외의 용도는 사유가 아니라 아예 목록에서 빠진다', JSON.stringify(genUi.purposes));
  ok(/발전기/.test(genUi.tip), `말풍선이 발전기를 가리킨다 ("${genUi.tip}")`);
  ok(genUi.lifted, '포커싱 중에도 목표 패널은 어두운 판 위에 있다 (건너뛰기 클릭 가능)');
  ok(await P(() => window.__game.ctx.housing.upgrade('generator')), '발전기를 가동한다');
  await waitStep('workshop');

  // 다른 용도는 여전히 거부된다 (엄격 강제)
  const wrongPurpose = await P(() => {
    const h = window.__game.ctx.housing;
    return { lounge: h.setRoomPurpose(1, 'lounge'), block: h.purposeBlock(1, 'lounge'), purpose: h.getRoom(1).purpose };
  });
  ok(wrongPurpose.lounge === false && /작업실/.test(wrongPurpose.block ?? '') && wrongPurpose.purpose === 'empty',
    '작업실이 아닌 용도는 거부된다 (사유에 작업실이 나온다)', JSON.stringify(wrongPurpose));
  // 스포트라이트는 다음 프레임에 대상을 찾아 자리를 잡는다 (`RETARGET_INTERVAL`) — 말풍선이 바뀔 때까지 기다린다
  await waitFor(page, () => {
    const r = document.querySelector('.tut-spot');
    return r && !r.hidden && /작업실/.test(document.querySelector('.tut-spot-tip')?.textContent ?? '');
  }, 'spotlight (작업실)');
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
  await waitFor(page, () => {
    const r = document.querySelector('.tut-spot');
    return r && !r.hidden && /가구 창고/.test(document.querySelector('.tut-spot-tip')?.textContent ?? '');
  }, 'spotlight (가구 창고)');
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
  await P(() => document.querySelector('.sm-store .fcard[data-def-id="furn_bench_gun"]').click());
  await sleep(150);
  const armed = await P(() => ({
    sel: window.__game.getSystem('housing').selectedFurniture,
    spot: document.querySelector('.tut-spot')?.hidden ?? null,
    hint: document.querySelector('.tut-panel .tut-hint')?.textContent ?? '',
  }));
  ok(armed.sel === 'furn_bench_gun' && armed.spot === true,
    '가구를 집으면 스포트라이트가 접힌다 (바닥을 클릭할 수 있어야 한다)', JSON.stringify(armed));
  ok(/바닥/.test(armed.hint), `목표 부제가 "바닥에 내려놓기"로 바뀐다 ("${armed.hint}")`);
  const placed = await P(() => window.__game.ctx.housing.place(1, 'furn_bench_gun', 0, 0, 0));
  ok(!!placed, '작업대를 방에 놓는다');
  await waitStep('manageDone');
  await P(() => window.__game.ctx.housing.closeShipManage());
  await sleep(200);

  /* ── 4. 재료 지급 + 제작 게이트 ───────────────────────────────────────── */
  console.log('제작');
  await waitStep('craftGun');
  const grant = await P(() => ({
    powder: window.__game.ctx.inventory.countDefAll('mat_gunpowder'),
    notify: window.__ev['ui:notify'].map((n) => n.text).filter((t) => /보급/.test(t)).length,
    guide: !!window.__game.getSystem('tutorial'),
  }));
  ok(grant.powder >= 20 && grant.notify >= 1, `제작 재료가 한 번 지급된다 (화약 ${grant.powder})`);
  const craftGate = await P(() => {
    const inv = window.__game.ctx.inventory;
    return { gun: inv.canCraft('make_wpn_ar'), ammo: inv.canCraft('bulk_ammo_medium'), other: inv.canCraft('make_bandage') };
  });
  ok(craftGate.gun === true && craftGate.ammo === false && craftGate.other === false,
    '지금 단계의 레시피(돌격소총)만 만들 수 있다', JSON.stringify(craftGate));

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
  ok(await clickPopup('계속하기'), '계속하기');
  await sleep(150);
  ok(await step() === 'craftGun', '취소하면 하던 단계 그대로');

  /* ── 6. 진행이 새로고침을 견딘다 ──────────────────────────────────────── */
  console.log('저장');
  const saved = await P(() => JSON.parse(localStorage.getItem('scav.tutorial') ?? 'null'));
  ok(saved && saved.step === 'craftGun' && saved.granted === true, `저장이 남는다 (${JSON.stringify(saved)})`);
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  ok(await step() === 'craftGun', '새로고침 후에도 같은 단계에서 이어진다');

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
      saved: JSON.parse(localStorage.getItem('scav.tutorial') ?? 'null'),
    };
  });
  ok(!after.active && after.step === null && after.fin && after.fin.skipped === true, '건너뛰면 튜토리얼이 끝난다', JSON.stringify(after.fin));
  ok(after.lounge === null && after.corp === null && !after.hides, '모든 게이트가 풀린다', JSON.stringify(after));
  ok(after.panel && after.spot, '목표 패널과 스포트라이트가 사라진다');
  ok(after.saved && after.saved.done === true && after.saved.step === null, '끝났다는 것이 저장된다', JSON.stringify(after.saved));

  /* ── 9. 이미 하던 프로필에는 켜지지 않는다 ──────────────────────────── */
  console.log('기존 프로필');
  await P(() => { try { localStorage.removeItem('scav.tutorial'); } catch { /* off */ } });
  await page.reload({ waitUntil: 'load' });
  await setup();
  await enterShip();
  await sleep(300);
  const existing = await P(() => ({
    step: window.__game.ctx.tutorial.step,
    saved: JSON.parse(localStorage.getItem('scav.tutorial') ?? 'null'),
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
