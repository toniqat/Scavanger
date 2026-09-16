// Single-player smoke test for the **가구 배치 규칙 — 접근 면** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」, housing `Rules.placementBlockOf` ·
// `ShipState.sanitize` · hub `interiors/Furniture` 상호작용 방향 · `HousingMode` 비워야 하는 칸 타일).
//   0. 옛 배치 → 가구 창고: 규칙을 어기는 조각(앞이 벽인 작업대 · 작업대 앞 줄의 사물함 · 넓은 면이 막힌 재배 스테이션 · 시술대 앞의 사물함)이
//      로드할 때 가구 창고로 가고, 옮겨진 재배 스테이션의 흙 · 심은 씨앗은 함선 창고로 돌아오며, 조종석 전용 시설 두 점은 그대로 선다.
//   1. front: 앞이 벽(yaw 0 · 1 · 2 · 3) 거절 · 앞 줄의 몸체 거절 · 마주보는 작업대가 1칸 통로를 나눠 쓴다 · 옆에 붙는 것은 된다 · 양방향.
//   2. sides: 좁은 끝에 붙는 것은 된다 · 넓은 면 거절 · 넓은 면이 벽이면 된다 (회전해도 같다).
//   3. all: 모서리 칸은 된다 · 네 면 거절 · 남의 네 면 거절. 조종석 고정 소품 자리는 몸체로 센다.
//   4. 자동 배치(`findFreeSpot`)가 새 규칙 아래 자리를 찾고, 찾은 자리는 전부 규칙을 지킨다.
//   5. 상호작용: 작업대는 앞에서만, 재배 스테이션은 넓은 두 면에서만 (`canInteract` · `getPrompt`).
//   6. 시설 관리 고스트의 칸 타일(초록 · 빨강 · 흐린 청록).
// Usage: node scripts/smoke-furniture-access.mjs [http://localhost:5273]   (needs `npm run dev`)
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

const R = {
  frontWall: '앞쪽이 벽에 막힙니다',
  front: '앞쪽 1칸을 비워야 합니다',
  sides: '넓은 면 1칸을 비워야 합니다',
  all: '사방 1칸을 비워야 합니다',
  blocksOther: '다른 가구의 접근 공간을 막습니다',
  overlap: '다른 가구와 겹칩니다',
};
const COCKPIT = 100;

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });
  const H = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game, 'engine');

  /* ══ 0. 옛 배치 → 가구 창고 ══════════════════════════════════════════════════ */
  console.log('옛 배치 (v11 세이브) → 가구 창고');
  await H(() => {
    const now = Date.now();
    const rooms = ['workshop', 'greenhouse', 'gym', 'library', 'empty', 'empty', 'empty', 'empty'].map((p) => ({ purpose: p, level: p === 'empty' ? 0 : 1 }));
    const F = (uid, defId, room, x, y, yaw) => ({ uid, defId, room, x, y, yaw, level: 1 });
    const doc = {
      version: 11, rooms, generatorLevel: 5, storageLevel: 0,
      furniture: [
        F('f-1', 'furn_implant_bay', 100, 0, 3, 1),      // 조종석 기본 자리 (앞 = +X, 앞 줄 x 4 · y 3–5)
        F('f-2', 'furn_corp_computer', 100, 2, 9, 0),    // 조종석 기본 자리 (앞 = −Z, 앞 줄 y 8)
        F('f-3', 'furn_locker', 100, 4, 3, 0),           // 시술대 앞 줄 → 가구 창고
        F('f-4', 'furn_bunk', 100, 0, 7, 0),             // 꾸밈 가구 — 그대로
        F('f-10', 'furn_bench_gun', 0, 0, 0, 0),         // 앞(y −1)이 벽 → 가구 창고
        F('f-11', 'furn_bench_gear', 0, 0, 4, 0),        // 그대로 (앞 줄 y 3)
        F('f-12', 'furn_locker', 0, 1, 2, 0),            // 장비 작업대 앞 줄 (1, 3) → 가구 창고
        F('f-20', 'furn_crate', 1, 9, 2, 0),             // 그대로
        F('f-21', 'furn_grow_station', 1, 8, 0, 0),      // 넓은 면(y 2)에 보급 상자 → 가구 창고 (흙 · 씨앗은 함선 창고로)
        F('f-22', 'furn_grow_station', 1, 0, 8, 0),      // 그대로
        F('f-30', 'furn_bench_rack', 2, 0, 0, 0),        // 그대로 (벽 두 면은 된다)
      ],
      furnitureStorage: [], presets: [], plots: [], nameLocked: false, books: [], bookDex: [],
      grows: [
        { uid: 'f-21', tier: 0, slot: 0, soilDefId: 'soil_mineral', soilUsesLeft: 2, seedDefId: 'seed_tuber', plantedAt: now - 60000, readyAt: now + 3600e3 },
        { uid: 'f-22', tier: 0, slot: 1, soilDefId: 'soil_mineral', soilUsesLeft: 2 },
      ],
      analyses: [], sampleDex: [], cultures: [], media: [], mediaDex: [], toggled: [], analysisXp: {}, analysisFound: [],
    };
    localStorage.setItem('scav.s1.ship', JSON.stringify(doc));
    localStorage.removeItem('scav.s1.stash');
    localStorage.removeItem('scav.s1.grant');
  });
  await page.reload({ waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__notify = [];
    window.__game.ctx.bus.on('ui:notify', (p) => window.__notify.push(p.text));
  });

  const loaded = await H(() => {
    const h = window.__game.ctx.housing;
    return {
      placed: h.getPlaced().map((f) => f.uid).sort(),
      stored: Object.fromEntries(h.getStored().map((s) => [s.defId, s.qty])),
      grows: h.state.grows.map((g) => `${g.uid}#${g.tier}#${g.slot}`),
      cockpit: h.getPlaced(100).map((f) => `${f.defId}@${f.x},${f.y},${f.yaw}`),
    };
  });
  const expectPlaced = ['f-1', 'f-11', 'f-2', 'f-20', 'f-22', 'f-30', 'f-4'];
  ok(JSON.stringify(loaded.placed) === JSON.stringify(expectPlaced), `규칙을 지키는 조각만 남는다 (${loaded.placed.join(',')})`, JSON.stringify(loaded));
  ok(loaded.stored.furn_bench_gun === 1 && loaded.stored.furn_locker === 2 && loaded.stored.furn_grow_station === 1,
    `어긴 조각은 가구 창고로 (작업대 1 · 사물함 2 · 재배 스테이션 1) (${JSON.stringify(loaded.stored)})`);
  ok(loaded.cockpit.includes('furn_implant_bay@0,3,1') && loaded.cockpit.includes('furn_corp_computer@2,9,0'),
    `조종석 전용 시설 두 점은 기본 자리에 그대로 (${loaded.cockpit.join(' · ')})`);
  ok(loaded.grows.join() === 'f-22#0#1', `옮겨진 스테이션의 재배 칸은 사라지고 남은 스테이션의 칸은 그대로 (${loaded.grows.join()})`);
  try {
    await waitFor(page, () => {
      const s = window.__game.ctx.inventory.getStashItems();
      return s.some((i) => i.defId === 'soil_mineral') && s.some((i) => i.defId === 'seed_tuber');
    }, 'refund in the stash', 8000);
  } catch { /* reported below */ }
  const refunded = await H(() => {
    const s = window.__game.ctx.inventory.getStashItems();
    const q = (d) => s.filter((i) => i.defId === d).reduce((a, i) => a + i.qty, 0);
    return { soil: q('soil_mineral'), seed: q('seed_tuber') };
  });
  ok(refunded.soil === 1 && refunded.seed === 1, `옮겨진 재배 스테이션의 흙 · 심은 씨앗 → 함선 창고 (${JSON.stringify(refunded)})`);
  await sleep(900);
  const saved = await H(() => { try { return JSON.parse(localStorage.getItem('scav.s1.ship')).furniture.map((f) => f.uid); } catch { return null; } });
  ok(Array.isArray(saved) && !saved.includes('f-10') && !saved.includes('f-21') && saved.includes('f-11'), `옮긴 결과가 곧바로 저장된다 (${saved?.join(',')})`);

  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && !!window.__game.getSystem('hub')?.furnitureLayer, 'hub phase');
  await waitFor(page, () => [...document.querySelectorAll('.menu.hidden')].every((m) => {
    const cs = getComputedStyle(m);
    return cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none';
  }), '숨은 메뉴의 페이드가 끝난다', 5000);

  const pb = (room, defId, x, y, yaw, ignore) => H(({ room, defId, x, y, yaw, ignore }) => window.__game.ctx.housing.placementBlock(room, defId, x, y, yaw, ignore ?? undefined), { room, defId, x, y, yaw, ignore });
  const cp = (room, defId, x, y, yaw) => H(({ room, defId, x, y, yaw }) => window.__game.ctx.housing.canPlace(room, defId, x, y, yaw), { room, defId, x, y, yaw });
  const placeAt = (room, defId, x, y, yaw) => H(({ room, defId, x, y, yaw }) => window.__game.ctx.housing.place(room, defId, x, y, yaw)?.uid ?? null, { room, defId, x, y, yaw });
  await H(() => {
    const h = window.__game.ctx.housing;
    h.state.furnitureStorage.push({ defId: 'furn_crate', level: 1, qty: 8 }, { defId: 'furn_bookshelf', level: 1, qty: 12 }, { defId: 'furn_bench_refine', level: 1, qty: 1 });
  });

  /* ══ 1. front ════════════════════════════════════════════════════════════ */
  console.log('front — 작업대');
  ok(await H(() => window.__game.ctx.housing.recover('f-11')), '장비 작업대를 회수해 방 1 을 비운다');
  ok((await pb(0, 'furn_bench_gun', 0, 0, 0)) === R.frontWall && (await cp(0, 'furn_bench_gun', 0, 0, 0)) === false, 'yaw 0 · y 0 = 앞이 벽 → 거절 (canPlace 도 false)');
  ok((await pb(0, 'furn_bench_gun', 0, 1, 0)) === null && (await cp(0, 'furn_bench_gun', 0, 1, 0)) === true, 'yaw 0 · y 1 = 앞 줄 y 0 이 비었다 → 된다');
  ok((await pb(0, 'furn_bench_gun', 0, 14, 2)) === R.frontWall && (await pb(0, 'furn_bench_gun', 0, 13, 2)) === null, 'yaw 2 (앞 = +y) 도 끝 줄이면 벽');
  ok((await pb(0, 'furn_bench_gun', 14, 0, 1)) === R.frontWall && (await pb(0, 'furn_bench_gun', 0, 0, 3)) === R.frontWall, 'yaw 1 (앞 = +x) · yaw 3 (앞 = −x) 의 벽');
  const A = await placeAt(0, 'furn_bench_gun', 0, 1, 2);            // 몸체 y 1–2, 앞 줄 y 3
  ok(!!A, `총기 작업대 (0,1) yaw 2 배치 (${A})`);
  ok((await pb(0, 'furn_bench_gear', 0, 4, 0)) === null, '마주보는 작업대가 1칸 통로(y 3)를 나눠 쓴다');
  const B = await placeAt(0, 'furn_bench_gear', 0, 4, 0);
  ok(!!B, `장비 작업대 (0,4) yaw 0 배치 (${B})`);
  ok((await pb(0, 'furn_crate', 2, 3, 0)) === R.blocksOther, `통로에 상자 = ${R.blocksOther} (양방향)`);
  ok((await pb(0, 'furn_crate', 4, 1, 0)) === null, '작업대 옆(좁은 면)에 붙는 것은 된다');
  ok((await pb(0, 'furn_crate', 0, 1, 0)) === R.overlap, `몸체끼리 = ${R.overlap}`);
  const crate0 = await placeAt(0, 'furn_crate', 10, 5, 0);
  ok(!!crate0, `상자 (10,5) (${crate0})`);
  ok((await pb(0, 'furn_bench_medical', 8, 6, 0)) === R.front, `앞 줄(y 5)에 상자 = ${R.front}`);
  ok((await pb(0, 'furn_crate', 2, 3, 0, crate0)) === R.blocksOther
    && (await H((u) => window.__game.ctx.housing.move(u, 2, 3, 0), crate0)) === false
    && (await H((u) => { const p = window.__game.ctx.housing.getPlacedByUid(u); return p.x === 10 && p.y === 5; }, crate0)),
  'move 도 같은 규칙 — 상자를 통로로 옮기면 거절되고 제자리');

  /* ══ 2. sides ════════════════════════════════════════════════════════════ */
  console.log('sides — 재배 스테이션');
  ok(!!(await placeAt(1, 'furn_crate', 12, 12, 0)), '상자 (12,12)');
  ok((await pb(1, 'furn_grow_station', 8, 12, 0)) === null, '좁은 끝(x 12)에 상자가 붙어도 된다');
  ok(!!(await placeAt(1, 'furn_crate', 9, 5, 0)), '상자 (9,5)');
  ok((await pb(1, 'furn_grow_station', 8, 6, 0)) === R.sides, `넓은 면(y 5)에 상자 = ${R.sides}`);
  ok((await pb(1, 'furn_grow_station', 4, 14, 0)) === null, '넓은 면(y 16)이 벽이어도 된다');
  ok(!!(await placeAt(1, 'furn_crate', 14, 3, 0)), '상자 (14,3)');
  ok((await pb(1, 'furn_grow_station', 14, 4, 1)) === null, '회전(yaw 1): 넓은 면 x 13 · x 16(벽), 좁은 끝(y 3)의 상자는 괜찮다');
  ok((await pb(1, 'furn_crate', 2, 10, 0)) === R.blocksOther && (await pb(1, 'furn_crate', 4, 8, 0)) === null,
    `f-22 의 넓은 면(y 10)에 상자 = ${R.blocksOther} · 좁은 끝(x 4)은 된다`);

  /* ══ 3. all ══════════════════════════════════════════════════════════════ */
  console.log('all — 헬스 기구');
  ok(!!(await placeAt(2, 'furn_crate', 7, 7, 0)), '상자 (7,7)');
  ok((await pb(2, 'furn_bench_rack', 8, 8, 0)) === null, '모서리 칸(7,7)은 비울 필요가 없다');
  ok(!!(await placeAt(2, 'furn_crate', 11, 9, 0)), '상자 (11,9)');
  ok((await pb(2, 'furn_bench_rack', 8, 8, 0)) === R.all, `옆면(x 11)에 상자 = ${R.all}`);
  ok((await pb(2, 'furn_crate', 3, 2, 0)) === R.blocksOther, `f-30 의 네 면(x 3)에 상자 = ${R.blocksOther}`);

  /* ── 조종석 ── */
  console.log('조종석');
  ok((await pb(COCKPIT, 'furn_locker', 4, 4, 0)) === R.blocksOther, `시술대 앞 줄(x 4)에 사물함 = ${R.blocksOther}`);
  ok((await pb(COCKPIT, 'furn_corp_computer', 4, 3, 0, 'f-2')) === R.front, `앞 줄(y 2)이 계기판 고정 자리 = ${R.front} (고정 소품은 몸체)`);
  ok((await pb(0, 'furn_implant_bay', 0, 8, 0)) === '조종석 전용 시설입니다', '조종석 전용 시설은 방에 놓을 수 없다');

  /* ══ 4. 자동 배치 ════════════════════════════════════════════════════════ */
  console.log('자동 배치');
  const auto = await H(() => {
    const h = window.__game.ctx.housing;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const s = h.findFreeSpot(3, 'furn_bookshelf');
      if (!s) break;
      const p = h.place(3, 'furn_bookshelf', s.x, s.y, s.yaw);
      if (!p) { out.push({ refused: s }); break; }
      out.push({ uid: p.uid, x: s.x, y: s.y, yaw: s.yaw });
    }
    const bad = h.getPlaced(3).map((f) => ({ uid: f.uid, why: h.placementBlock(3, f.defId, f.x, f.y, f.yaw, f.uid) })).filter((r) => r.why);
    return { out, bad };
  });
  ok(auto.out.length === 12 && auto.out.every((o) => o.uid), `서재에 책장 12개를 자동 배치 (${auto.out.length})`, JSON.stringify(auto.out));
  ok(auto.out[0]?.yaw === 1, `첫 자리는 여전히 선호 회전 yaw 1 (${JSON.stringify(auto.out[0])})`);
  ok(auto.bad.length === 0, `자동 배치한 조각은 전부 규칙을 지킨다 (${JSON.stringify(auto.bad)})`);

  /* ══ 5. 상호작용 방향 ═════════════════════════════════════════════════════ */
  console.log('상호작용 — 앞에서만 / 넓은 두 면에서만');
  const probe = (uid) => H((uid) => {
    const ctx = window.__game.ctx;
    const layer = window.__game.getSystem('hub').furnitureLayer;
    const piece = layer?.pieces?.get(uid);
    const it = ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`);
    if (!piece || !it) return { missing: { piece: !!piece, it: !!it } };
    const b = piece.box;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2, hx = (b.maxX - b.minX) / 2, hz = (b.maxZ - b.minZ) / 2;
    const p = ctx.player.position;
    const save = p.clone();
    const at = (x, z) => { p.set(x, save.y, z); const r = { can: it.canInteract(), prompt: it.getPrompt() }; return r; };
    const res = {
      anchorZ: it.position.z - cz, anchorX: it.position.x - cx,
      plusZ: at(cx, cz + hz + 0.6), minusZ: at(cx, cz - hz - 0.6), plusX: at(cx + hx + 0.6, cz), minusX: at(cx - hx - 0.6, cz),
    };
    p.copy(save);
    return res;
  }, uid);
  try { await waitFor(page, (u) => window.__game.ctx.interactables.all().some((i) => i.id === `hub_furn_${u}`), 'bench interactable', 8000, A); } catch { /* reported below */ }
  const pa = await probe(A);
  // A = 총기 작업대 yaw 2 → 앞 = 월드 +Z
  ok(pa.plusZ?.can === true && !!pa.plusZ?.prompt && pa.anchorZ > 0, `작업대: 앞(+Z)에서 E (${JSON.stringify(pa.plusZ)}, anchor dz ${pa.anchorZ?.toFixed?.(2)})`, JSON.stringify(pa));
  ok(pa.minusZ?.can === false && pa.minusZ?.prompt === null, '작업대: 뒤(−Z)에서는 안 된다 (프롬프트도 없다)');
  ok(pa.plusX?.can === false && pa.minusX?.can === false, '작업대: 옆에서도 안 된다');
  const pg = await probe('f-22');
  // f-22 = 재배 스테이션 yaw 0 → 넓은 면 = ±Z
  ok(pg.plusZ?.can === true && pg.minusZ?.can === true, `재배 스테이션: 넓은 두 면(±Z)에서 E (${JSON.stringify({ p: pg.plusZ, m: pg.minusZ })})`, JSON.stringify(pg));
  ok(pg.plusX?.can === false && pg.minusX?.can === false, '재배 스테이션: 좁은 끝(±X)에서는 안 된다');

  /* ══ 6. 고스트 칸 타일 ═══════════════════════════════════════════════════ */
  console.log('시설 관리 — 비워야 하는 칸 타일');
  await H(() => {
    const ctx = window.__game.ctx;
    ctx.housing.openShipManage(0);
    ctx.housing.selectFurniture('furn_bench_refine');
  });
  await sleep(300);
  // 커서를 화면 한가운데(방 한가운데를 내려다본다)에 둔다
  await H(() => {
    const ctx = window.__game.ctx;
    const r = ctx.canvas.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const t of [document, window]) t.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
    try { ctx.input.mouseX = x; ctx.input.mouseY = y; } catch { /* getter only */ }
  });
  try { await waitFor(page, () => { const t = window.__game.getSystem('hub').housing.clearanceTiles; return t.ok + t.bad >= 4; }, 'clearance tiles', 6000); } catch { /* reported below */ }
  const tiles = await H(() => {
    const hm = window.__game.getSystem('hub').housing;
    return { ...hm.clearanceTiles, cell: { ...hm.cell }, sel: window.__game.ctx.housing.selectedFurniture };
  });
  ok(tiles.ok + tiles.bad >= 4, `가공 작업대 고스트의 앞 줄 4칸이 타일로 깔린다 (${JSON.stringify(tiles)})`);
  ok(tiles.other >= 1, `이미 놓인 가구의 비워야 하는 칸도 흐리게 보인다 (${tiles.other})`);
  ok(tiles.bad === 0 || tiles.cell.valid === false, `빨간 칸이 있으면 고스트도 빨갛다 (${JSON.stringify(tiles.cell)})`);
  await H(() => { const h = window.__game.ctx.housing; h.selectFurniture(null); h.closeShipManage(); });
  await sleep(200);
  const tilesOff = await H(() => ({ ...window.__game.getSystem('hub').housing.clearanceTiles }));
  ok(tilesOff.ok + tilesOff.bad + tilesOff.other === 0, `시설 관리를 닫으면 타일이 사라진다 (${JSON.stringify(tilesOff)})`);

  const errs = errors.filter((e) => !/favicon|net::ERR/.test(e));
  ok(errs.length === 0, `page errors: ${errs.length}`, errs.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e?.stack ?? e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-furniture-access: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
