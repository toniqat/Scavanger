// Android squadmate HUD + raid-entry loading gauge smoke (src/ui, 2026-09-15 —
// docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」). The relay socket is parked (parkRelay), never used.
//
// The allies / hub / game folders are still being built, so this smoke runs on **bus events and a fake `ctx.allies`**
// alone: `hud.debugAllies(ref)` (ui/hud/allySource) plants the roster · the bodies, everything else is a `ctx.bus.emit`.
//
//   ship    an android row stands in the ship too (even with no lobby) — the `안드로이드` badge · slot colour · shield bar.
//   raid    in a raid: nameplates · compass ticks · map markers + a legend row, downed / dead marks.
//   ping    `ally:ping` → `.pmarker.remote.android` · a chat callout under the android's name · `ping:placedV3 {owner = the android's id}`.
//   chat    `ally:chat` → one `.chat-line.ally` row, **never relayed** (0 `ctx.net.send` calls).
//   toast   joining · returning to the bay · being evicted · full · downed · destroyed · deposited into the stash.
//   load    the loading gauge: above the black plate (`.screen-fade`) · `squad` progress · `n명 대기 중` · **it spins at dt 0** ·
//           it disappears after `raid:loadReleased`.
// Usage: node scripts/smoke-ally-ui.mjs [http://localhost:5273]   (needs vite; the runner starts it)
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
const near = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) <= eps;
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,720', '--no-sandbox'],
});
const pageErrors = [];
const consoleErrors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.getSystem('hud'), 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const P = (fn, arg) => page.evaluate(fn, arg);

  /* One fake `ctx.allies`. The position vectors are cloned from the THREE.Vector3 the game itself uses. */
  await P(() => {
    const V = () => window.__game.ctx.scene.position.clone();
    window.__mkBody = (o) => ({
      id: o.id, name: o.name, bay: o.bay ?? 0, slot: o.slot ?? 3,
      mode: o.mode ?? 'raid', state: o.state ?? 'follow', pose: o.pose ?? 'stand',
      position: V().set(o.x ?? 0, o.y ?? 0, o.z ?? 0), velocity: V(),
      yaw: o.yaw ?? 0, pitch: 0,
      hp: o.hp ?? 500, maxHp: o.maxHp ?? 500, shield: o.shield ?? 30, maxShield: o.maxShield ?? 60,
      downHp: o.downHp ?? 0, downed: !!o.downed, dead: !!o.dead, hidden: !!o.hidden, flags: 0,
      weaponDefId: 'ar', armorDefId: 'armor_2', bagDefId: 'bag_common', carrying: null, lookAt: null,
      stridePhase: 0, moveBlend: 0,
    });
    window.__setAllies = (entries, bodies) => {
      const list = bodies ?? [];
      window.__alliesRef = {
        roster: entries, simulating: true,
        getBodies: () => list,
        getBody: (id) => list.find((b) => b.id === id) ?? null,
        getCombatBodies: () => list.filter((b) => !b.dead && !b.downed && !b.hidden),
        getLoadout: () => null,
        damage: () => {}, requestRevive: () => false, carrierOf: () => null,
      };
      window.__game.getSystem('hud').debugAllies(window.__alliesRef);
    };
    window.__A0 = 'android:local:0';
    window.__A1 = 'android:local:1';
    window.__entry = (id, bay, slot, name) => ({ id, bay, slot, name, recruitedAt: 1000 + bay, local: true });
  });

  /* ── ship: an android row stands even with no lobby ───────────────────────── */
  console.log('ship: 분대 목록의 안드로이드 행');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => {
    const b = window.__mkBody({ id: window.__A0, name: '안드로이드 알파', bay: 0, slot: 3, mode: 'hub', state: 'hubIdle', shield: 45, maxShield: 60, hp: 500, maxHp: 500 });
    window.__setAllies([window.__entry(window.__A0, 0, 3, '안드로이드 알파')], [b]);
  });
  await waitFor(page, () => window.__game.getSystem('hud').squadRows.some((r) => r.android), '안드로이드 행', 10000);
  const shipRows = await P(() => ({
    rows: window.__game.getSystem('hud').squadRows,
    visible: !document.querySelector('.squad').classList.contains('hidden'),
    sc: (() => { const r = [...document.querySelectorAll('.squad .srow.android')][0]; return r ? { sc: r.style.getPropertyValue('--sc'), sh: getComputedStyle(r.querySelector('.sh')).display, italic: getComputedStyle(r.querySelector('.name')).fontStyle } : null; })(),
  }));
  const a0 = shipRows.rows.find((r) => r.android);
  ok(shipRows.visible && !!a0, '로비가 없어도 분대 목록이 뜨고 안드로이드 행이 있다', JSON.stringify(shipRows.rows));
  ok(a0 && a0.name === '안드로이드 알파' && a0.badge === '안드로이드', '이름 + 안드로이드 배지', JSON.stringify(a0));
  ok(shipRows.sc && shipRows.sc.sc.length > 0 && shipRows.sc.sh === 'block', '슬롯 색 + 실드 바가 보인다', JSON.stringify(shipRows.sc));
  ok(a0 && /scaleX\(0?\.75/.test(a0.shield.replace(/\s/g, '')), `실드 45/60 = 0.75 (${a0 && a0.shield})`);
  const noGhostRow = shipRows.rows.filter((r) => !r.android && r.state === '연결 중').length;
  ok(noGhostRow === 0, '봇이 사람 행(연결 중)으로 그려지지 않는다', String(noGhostRow));

  /* ── raid: nameplates · compass · map ─────────────────────────────────────── */
  console.log('raid: 이름표 · 나침반 눈금 · 지도 마커');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 77 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  // The roster survives the new raid (debugAllies is independent of the phase) — only the bodies are put in
  // front of the player.
  await P(() => {
    const ctx = window.__game.ctx;
    const p = ctx.player.position;
    const dir = ctx.scene.position.clone();
    ctx.camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const mk = (id, name, bay, slot, ahead, extra) => window.__mkBody(Object.assign({
      id, name, bay, slot, mode: 'raid',
      x: p.x + dir.x * ahead, y: p.y, z: p.z + dir.z * ahead,
    }, extra ?? {}));
    window.__bodies = [
      mk(window.__A0, '안드로이드 알파', 0, 3, 7, { shield: 30, maxShield: 60, hp: 250, maxHp: 500 }),
      mk(window.__A1, '안드로이드 베타', 1, 2, 10, { downed: true, downHp: 50 }),
    ];
    window.__setAllies([window.__entry(window.__A0, 0, 3, '안드로이드 알파'), window.__entry(window.__A1, 1, 2, '안드로이드 베타')], window.__bodies);
  });
  await waitFor(page, () => window.__game.getSystem('hud').allyNameplates.filter((p) => p.shown).length >= 1, '안드로이드 이름표', 15000);
  // The squad list only redraws at 10 Hz — this waits until both units stand
  await waitFor(page, () => window.__game.getSystem('hud').squadRows.filter((r) => r.android).length === 2, '안드로이드 행 2줄', 10000);
  const plates = await P(() => ({
    plates: window.__game.getSystem('hud').allyNameplates,
    dom: document.querySelectorAll('.nameplate.ally').length,
    ticks: window.__game.getSystem('hud').compass.allyTickCount,
    rows: window.__game.getSystem('hud').squadRows.filter((r) => r.android),
  }));
  const pa = plates.plates.find((p) => p.id === 'android:local:0');
  const pb = plates.plates.find((p) => p.id === 'android:local:1');
  ok(plates.dom === 2 && pa && pa.name === '안드로이드 알파', `레이드에서 몸마다 이름표 하나 (${plates.dom})`, JSON.stringify(plates.plates));
  ok(pa && /scaleX\(0?\.5/.test(pa.hp.replace(/\s/g, '')), `체력 250/500 = 0.5 (${pa && pa.hp})`);
  ok(pb && pb.tag === '쓰러짐', '쓰러진 기의 꼬리표', JSON.stringify(pb));
  ok(plates.ticks >= 1, `나침반에 안드로이드 눈금 (${plates.ticks})`);
  const downedRow = plates.rows.find((r) => r.id === 'android:local:1');
  ok(downedRow && downedRow.state === '쓰러짐', '분대 행이 쓰러짐을 말한다', JSON.stringify(plates.rows));

  const hud = 'window.__game.getSystem("hud")';
  await page.evaluate(`${hud}.map.open()`);
  await sleep(250);
  const mapInfo = await P(() => ({ open: window.__game.getSystem('hud').isMapOpen, legend: window.__game.getSystem('hud').mapLegendIds }));
  ok(mapInfo.open && mapInfo.legend.includes('ally'), '지도 범례에 안드로이드 줄', JSON.stringify(mapInfo.legend));
  await page.evaluate(`${hud}.map.close()`);
  await sleep(150);

  /* ── ping ─────────────────────────────────────────────────────────────── */
  console.log('ally:ping → 마커 · 콜아웃 · ping:placedV3');
  await P(() => {
    window.__v3 = [];
    window.__game.ctx.bus.on('ping:placedV3', (e) => window.__v3.push({ owner: e.owner, kind: e.kind, label: e.label ?? null, enemyId: e.enemyId ?? null }));
    window.__posts = 0;
    window.__game.ctx.bus.on('chat:post', () => { window.__posts++; });
    const net = window.__game.ctx.net;
    window.__sends = 0;
    if (net) { const s = net.send.bind(net); net.send = (...a) => { window.__sends++; return s(...a); }; }
    const ctx = window.__game.ctx;
    const p = ctx.player.position;
    const at = ctx.scene.position.clone().set(p.x + 4, p.y, p.z + 4);
    ctx.bus.emit('ally:ping', { id: window.__A0, name: '안드로이드 알파', slot: 3, kind: 'crate', position: at, label: '보급 상자 (2등급)' });
  });
  await waitFor(page, () => window.__game.getSystem('hud').pingViews.some((p) => p.owner && p.owner.id === 'android:local:0'), '안드로이드 핑', 10000);
  const ping = await P(() => ({
    views: window.__game.getSystem('hud').pingViews.map((p) => ({ kind: p.kind, owner: p.owner ? p.owner.id : null, android: p.owner ? !!p.owner.android : false, label: p.label })),
    dom: document.querySelectorAll('.pmarker.remote.android').length,
    lbl: document.querySelector('.pmarker.android .lbl') ? document.querySelector('.pmarker.android .lbl').textContent : '',
    v3: window.__v3, posts: window.__posts, sends: window.__sends,
    lines: window.__game.getSystem('hud').chatLines,
  }));
  const pv = ping.views.find((v) => v.owner === 'android:local:0');
  ok(pv && pv.android && pv.kind === 'crate' && pv.label === '보급 상자 (2등급)', '안드로이드가 주인인 핑', JSON.stringify(ping.views));
  ok(ping.dom === 1 && ping.lbl.startsWith('안드로이드 알파 · '), `마커에 안드로이드 이름 (${ping.lbl})`);
  const v3 = ping.v3.find((e) => e.owner === 'android:local:0');
  ok(!!v3 && v3.kind === 'crate' && v3.label === '보급 상자 (2등급)', 'ping:placedV3 의 owner = 안드로이드 id + label', JSON.stringify(ping.v3));
  const callout = ping.lines.filter((l) => l.cls.includes('ally')).pop();
  ok(!!callout && callout.who === '안드로이드 알파:' && /보급 상자 \(2등급\) 여기 \(\d+m\)/.test(callout.text), '콜아웃이 안드로이드 이름으로 한 줄', JSON.stringify(callout));
  ok(ping.posts === 0 && ping.sends === 0, '콜아웃은 chat:post 로도 와이어로도 나가지 않는다', JSON.stringify({ posts: ping.posts, sends: ping.sends }));

  /* ── chat ─────────────────────────────────────────────────────────────── */
  console.log('ally:chat → 안드로이드 색 한 줄, relay 없음');
  await P(() => {
    window.__game.ctx.bus.emit('ally:chat', { id: window.__A1, name: '안드로이드 베타', slot: 2, text: '회복 아이템이 없다' });
  });
  await waitFor(page, () => window.__game.getSystem('hud').chatLines.some((l) => l.text === '회복 아이템이 없다'), '안드로이드 채팅', 10000);
  const chat = await P(() => ({ lines: window.__game.getSystem('hud').chatLines, posts: window.__posts, sends: window.__sends }));
  const cl = chat.lines.find((l) => l.text === '회복 아이템이 없다');
  ok(cl && cl.cls.includes('ally') && cl.who === '안드로이드 베타:', '<이름>: 텍스트 (안드로이드 클래스)', JSON.stringify(cl));
  ok(chat.posts === 0 && chat.sends === 0, 'ally:chat 은 절대 relay 되지 않는다', JSON.stringify({ posts: chat.posts, sends: chat.sends }));

  /* ── toasts ───────────────────────────────────────────────────────────── */
  console.log('토스트: 합류 · 복귀 · 밀려남 · 가득 참 · 쓰러짐 · 사망 · 창고');
  const toastsAfter = async (fn) => {
    await P(() => { const h = window.__game.getSystem('hud'); h.notifs.clear ? h.notifs.clear() : null; });
    await P(fn);
    await sleep(200);
    return P(() => window.__game.getSystem('hud').toastTexts);
  };
  const tJoin = await toastsAfter(() => {
    const e = window.__entry(window.__A0, 0, 3, '안드로이드 알파');
    window.__game.ctx.bus.emit('ally:rosterChanged', { roster: [e], added: [e.id], removed: [], evicted: [] });
  });
  ok(tJoin.some((t) => t.includes('안드로이드 알파가 분대에 합류했다')), '합류 토스트 (조사 「가」)', JSON.stringify(tJoin));
  const tBack = await toastsAfter(() => {
    window.__game.ctx.bus.emit('ally:rosterChanged', { roster: [], added: [], removed: [window.__A0], evicted: [] });
  });
  ok(tBack.some((t) => t.includes('안드로이드 알파가 슬롯으로 돌아갔다') && !t.includes('분대원이 합류해')), '분대장이 돌려보낸 토스트', JSON.stringify(tBack));
  const tEvict = await toastsAfter(() => {
    const e = window.__entry(window.__A0, 0, 3, '안드로이드 알파');
    window.__game.ctx.bus.emit('ally:rosterChanged', { roster: [e], added: [e.id], removed: [], evicted: [] });
    window.__game.ctx.bus.emit('ally:rosterChanged', { roster: [], added: [], removed: [window.__A0], evicted: [window.__A0] });
  });
  ok(tEvict.some((t) => t.includes('분대원이 합류해 안드로이드 알파가 슬롯으로 돌아갔다')), '사람에게 밀려난 토스트', JSON.stringify(tEvict));
  const tFull = await toastsAfter(() => window.__game.ctx.bus.emit('net:androidReturned', { bay: 2, reason: 'full' }));
  ok(tFull.some((t) => t.includes('분대가 가득 차 안드로이드를 들일 수 없다')), '가득 참 토스트', JSON.stringify(tFull));
  const tNoFull = await toastsAfter(() => window.__game.ctx.bus.emit('net:androidReturned', { bay: 2, reason: 'human_joined' }));
  ok(!tNoFull.some((t) => t.includes('가득 차')), 'human_joined 는 여기서 두 번 말하지 않는다', JSON.stringify(tNoFull));
  const tDown = await toastsAfter(() => {
    window.__game.ctx.bus.emit('ally:downed', { id: window.__A1, name: '안드로이드 베타' });
    window.__game.ctx.bus.emit('ally:died', { id: window.__A1, name: '안드로이드 베타' });
  });
  ok(tDown.some((t) => t.includes('안드로이드 베타') && t.includes('전투불능')) && tDown.some((t) => t.includes('파괴됨')), '쓰러짐 · 사망 토스트', JSON.stringify(tDown));
  const tDep = await toastsAfter(() => window.__game.ctx.bus.emit('ally:deposited', { id: window.__A0, name: '안드로이드 알파', count: 5, lost: 2 }));
  ok(tDep.some((t) => t.includes('안드로이드 알파가 전리품 5개를 창고에 넣었다') && t.includes('2개 유실')), '창고 입고 토스트 (+유실)', JSON.stringify(tDep));
  // With no name sent, it is found from the roster · the id
  const tNoName = await toastsAfter(() => window.__game.ctx.bus.emit('ally:downed', { id: 'android:local:2', name: '' }));
  ok(tNoName.some((t) => t.includes('안드로이드 감마')), 'id 꼬리의 bay 로 이름을 되찾는다', JSON.stringify(tNoName));

  /* ── the loading gauge ────────────────────────────────────────────────── */
  console.log('레이드 진입 로딩 게이지');
  await P(() => {
    const b = window.__game.ctx.bus;
    b.emit('ui:screenFade', { opacity: 1, durationS: 0 });
    b.emit('raid:loadBegin', {});
    b.emit('raid:loadProgress', { local: 1, squad: 0.4, waiting: 2, remainingS: 40 });
  });
  await waitFor(page, () => window.__game.getSystem('hud').loadingGaugeState.on, '로딩 게이지', 10000);
  await sleep(300);
  const gauge = await P(() => {
    const g = document.querySelector('.ldg');
    const fade = document.querySelector('.screen-fade');
    return {
      st: window.__game.getSystem('hud').loadingGaugeState,
      z: Number(getComputedStyle(g).zIndex), fadeZ: Number(getComputedStyle(fade).zIndex),
      pe: getComputedStyle(g).pointerEvents,
      p: g.querySelector('.ldg-ring').style.getPropertyValue('--p'),
      pct: g.querySelector('.ldg-pct').textContent,
      wait: g.querySelector('.ldg-wait').hidden ? '' : g.querySelector('.ldg-wait').textContent,
      label: g.querySelector('.ldg-label').textContent,
      right: g.getBoundingClientRect().right, bottom: g.getBoundingClientRect().bottom,
    };
  });
  ok(gauge.st.on && gauge.st.opacity > 0.9, '게이지가 떠 있다', JSON.stringify(gauge.st));
  ok(gauge.z === 87 && gauge.z > gauge.fadeZ, `암전(z ${gauge.fadeZ}) 위에 그린다 (z ${gauge.z})`);
  ok(gauge.pe === 'none', '연출이지 화면이 아니다 (포인터를 먹지 않는다)', gauge.pe);
  ok(near(Number(gauge.p), 0.4, 0.01) && gauge.pct === '40 %', `채움 = squad 0.4 (${gauge.p} · ${gauge.pct})`);
  ok(gauge.wait === '2명 대기 중' && gauge.label === '로딩 중', '로딩 중 · n명 대기 중', JSON.stringify({ w: gauge.wait, l: gauge.label }));
  ok(gauge.right > 1280 * 0.6 && gauge.bottom > 720 * 0.6, '우측 하단', JSON.stringify({ r: gauge.right, b: gauge.bottom }));

  /* dt 0: the loading gate holds the engine with `ctx.shaders.holdFor` and **hands every system a dt of 0**. The same
   * result is made here with `ctx.timeScale = 0` (`Engine.frame`: sdt = dt × timeScale → 0, and `missionTime` stops
   * too). The gauge spins off `performance.now()`, so it must keep moving all the same. */
  const frozen0 = await P(() => {
    window.__game.ctx.timeScale = 0;
    const hud = window.__game.getSystem('hud');
    return { mt: window.__game.ctx.missionTime, spin: hud.loadingGaugeState.spin };
  });
  await sleep(450);
  const frozen1 = await P(() => {
    const hud = window.__game.getSystem('hud');
    const out = { mt: window.__game.ctx.missionTime, spin: hud.loadingGaugeState.spin };
    window.__game.ctx.timeScale = 1;
    return out;
  });
  ok(near(frozen1.mt, frozen0.mt, 1e-6), `dt 0 동안 시뮬레이션 시계가 멈춘다 (${frozen0.mt} → ${frozen1.mt})`);
  ok(frozen1.spin !== frozen0.spin, `dt 0 에서도 게이지가 돈다 (${frozen0.spin}° → ${frozen1.spin}°)`);

  await P(() => {
    window.__game.ctx.bus.emit('raid:loadProgress', { local: 1, squad: 1, waiting: 0, remainingS: 0 });
    window.__game.ctx.bus.emit('raid:loadReleased', { timedOut: false });
  });
  await sleep(1500);   // RAID_LOAD_MIN_BLACK_S + the disappearance
  const gone = await P(() => ({ st: window.__game.getSystem('hud').loadingGaugeState, hidden: document.querySelector('.ldg').hidden }));
  ok(!gone.st.on && gone.hidden, 'raid:loadReleased 뒤 사라진다', JSON.stringify(gone));
  await P(() => window.__game.ctx.bus.emit('ui:screenFade', { opacity: 0, durationS: 0 }));

  // Back in the ship the gauge is taken down unconditionally
  await P(() => {
    window.__game.ctx.bus.emit('raid:loadBegin', {});
    window.__game.ctx.bus.emit('hub:entered', { ship: 'personal' });
  });
  await sleep(200);
  const afterHub = await P(() => window.__game.getSystem('hud').loadingGaugeState.on);
  ok(!afterHub, 'hub:entered 는 게이지를 조건 없이 걷는다');

  await P(() => window.__game.getSystem('hud').debugAllies(null));
  await sleep(400);   // the squad list redraws at 10 Hz
  const back = await P(() => ({ rows: window.__game.getSystem('hud').squadRows.filter((r) => r.android), real: (window.__game.ctx.allies?.roster ?? []).length }));
  ok(back.rows.length === back.real, `debugAllies(null) 이면 진짜 ctx.allies 로 돌아간다 (${back.rows.length} / ${back.real})`, JSON.stringify(back));

  ok(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 5).join(' | '));
  if (consoleErrors.length) console.log(`  note ${consoleErrors.length} console error line(s): ${consoleErrors.slice(0, 3).join(' | ')}`);
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log([...pageErrors, ...consoleErrors].slice(0, 10).join('\n'));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
