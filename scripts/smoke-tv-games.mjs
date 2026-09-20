// 2026-09-13 — the library series · video games: the hub side (src/hub — models · interaction · the game cutscene).
// docs/DECISIONS.md 「2026-09-13 — 서재 시리즈 · 비디오게임」.
// The rules (the seat judgement · the session · the result) are housing's job, so housing methods are replaced with
// **stubs** or events are pushed onto the bus here, and only hub is checked.
//  0. Models: the game disc stand · sofa · low table · rug · chair · TV are built with 0 lights · the sitting
//     direction = forward (−Z, the backrest at +Z) · the seat top at 0.36 · 3 sofa cushions · the rug within 3 cm
//     above the floor grid line · the TV's game screen shows only while gameActive · all four console looks are
//     built · the case = the theme colour.
//  1. A TV · sofa (watching the TV) · chair · game disc stand are placed in the library — the light count is
//     unchanged from start to end.
//  2. E on the TV: with `openTvMenu` present, the prompt `TV 화면` + a call with that uid; without it, the old on/off.
//     E on the game disc stand → `openShelf`. `housing:tvConsoleChanged` → that TV is rebuilt carrying the console.
//  3. E on a seat: sofa · chair · sitting → the sit pose, the sofa taking the cushion nearest the player.
//  4. The game cutscene: `housing:gameSession {active:true}` → sit on the cushion nearest the TV · a yaw facing the
//     TV · the fixed camera behind the seat · the game screen on, `housing:gameBeat` → the flash · the progress bar,
//     `{active:false}` → released (cancel is not called), a refused pose → `cancelGameSession` on the spot, the pose
//     released from outside → `cancelGameSession`.
// Usage: node scripts/smoke-tv-games.mjs [http://localhost:5273]   (needs a running vite)
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
  // single-player: park vite HMR and the relay socket (a relay on 8787 must not replace the ship document mid-run)
  await quietViteHmr(page, { parkRelay: true });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket connection to .*\/ws/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory && !!window.__game.ctx.housing && !!window.__game.ctx.loot, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    // exactly what `WebGLRenderer.projectObject` collects (smoke-lights)
    window.__count = () => { let n = 0; window.__game.ctx.scene.traverseVisible((o) => { if (o.isLight && !o.isAmbientLight) n++; }); return n; };
  });
  const H = (fn, arg) => page.evaluate(fn, arg);
  const waitSim = async (sec) => { const t0 = await H(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  // from the title into the personal ship (the same path smoke-housing takes) — the furniture layer only exists
  // inside the ship
  await H(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub' && !!window.__game.getSystem('hub').furnitureLayer, 'hub phase + furniture layer');

  /* ══ 0. Models ══════════════════════════════════════════════════════════ */
  console.log('0. 절차 모델');
  const models = await H(async () => {
    const F = await import('/src/hub/interiors/Furniture.ts');
    const S = await import('/src/shared/index.ts');
    const stat = (m) => {
      m.group.updateMatrixWorld(true);
      let lights = 0, meshes = 0, verts = 0;
      let minY = Infinity, maxY = -Infinity, minZ = Infinity, top = { y: -Infinity, z: 0 };
      const v = m.group.position.clone();
      m.group.traverse((o) => {
        if (o.isLight) lights++;
        if (!o.isMesh || !o.visible) return;
        let hidden = false; for (let p = o.parent; p; p = p.parent) if (!p.visible) hidden = true;
        if (hidden) return;
        meshes++;
        const pos = o.geometry.attributes.position;
        verts += pos.count;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); minZ = Math.min(minZ, v.z);
          if (v.y > top.y) top = { y: v.y, z: v.z };
        }
      });
      return { lights, meshes, verts, minY, maxY, minZ, top };
    };
    const out = { defs: {}, stat: {} };
    for (const id of ['furn_game_stand', 'furn_sofa', 'furn_low_table', 'furn_rug', 'furn_chair', 'furn_tv', 'furn_rocking_chair']) {
      const d = S.FURNITURE_DEF_MAP.get(id);
      out.defs[id] = d ? { model: d.model, interaction: d.interaction, low: d.low === true, cols: d.cols, rows: d.rows, height: d.height } : null;
    }
    const build = (id, extra) => F.buildFurniture(S.FURNITURE_DEF_MAP.get(id), 1, extra);
    if (out.defs.furn_sofa) {
      const m = build('furn_sofa');
      out.stat.sofa = { ...stat(m), pose: m.rig?.pose, fwd: m.rig?.forward, seats: (m.rig?.seats ?? []).map((s) => [s.x, s.y, s.z]) };
    }
    if (out.defs.furn_chair) { const m = build('furn_chair'); out.stat.chair = { ...stat(m), pose: m.rig?.pose, fwd: m.rig?.forward, anchorY: m.rig?.anchor.y }; }
    if (out.defs.furn_rocking_chair) { const m = build('furn_rocking_chair'); out.stat.rocking = { ...stat(m), pose: m.rig?.pose, fwd: m.rig?.forward }; }
    if (out.defs.furn_rug) out.stat.rug = stat(build('furn_rug'));
    if (out.defs.furn_low_table) out.stat.low = stat(build('furn_low_table'));
    if (out.defs.furn_game_stand) {
      const colors = ['#ff0000', null, '#00ff00', null, null, '#0000ff'];
      const m = build('furn_game_stand', { gameColors: colors, media: ['rare', null, 'rare', null, null, 'rare'] });
      const hexes = new Set();
      m.group.traverse((o) => { if (o.isMesh && o.material?.color) hexes.add(o.material.color.getHex()); });
      const empty = stat(build('furn_game_stand'));
      out.stat.stand = { ...stat(m), red: hexes.has(0xff0000), green: hexes.has(0x00ff00), blue: hexes.has(0x0000ff), emptyVerts: empty.verts };
    }
    if (out.defs.furn_tv) {
      const plain = build('furn_tv', { on: true });
      // a console look's signature = the vertex count per material (a slab and a plain box share a vertex count and
      // differ only in material)
      const sig = (m) => { const per = new Map(); m.group.traverse((o) => { if (o.isMesh) per.set(o.material.uuid, (per.get(o.material.uuid) ?? 0) + o.geometry.attributes.position.count); }); return [...per.entries()].map(([k, n]) => `${k}:${n}`).sort().join('|'); };
      const lookModels = [0, 1, 2, 3].map((k) => build('furn_tv', { on: true, consoleLook: k }));
      const looks = lookModels.map((m) => stat(m).verts);
      out.lookSigs = lookModels.map(sig);
      const live = build('furn_tv', { on: true, gameActive: true });
      out.stat.tv = {
        ...stat(plain), looks, hasRig: !!plain.tv, overlayHidden: plain.tv ? plain.tv.overlay.visible === false : null,
        overlayLive: live.tv ? live.tv.overlay.visible === true && !!live.group.getObjectByName('tv-game-marker') && !!live.group.getObjectByName('tv-game-progress') : null,
        screenZ: plain.tv ? plain.tv.screen.z : null, liveLights: stat(live).lights,
      };
    }
    return out;
  });
  const D = models.defs, T = models.stat;
  ok(D.furn_sofa?.model === 'sofa' && D.furn_sofa.interaction === 'seat' && D.furn_chair?.interaction === 'seat' && D.furn_game_stand?.interaction === 'game_stand'
    && D.furn_low_table?.low && D.furn_rug?.low && D.furn_tv?.model === 'tv', 'data rows: 쇼파 · 의자 = seat, 게임 디스크 전시대 = game_stand, 좌식 테이블 · 러그 = low', JSON.stringify(D));
  const allStats = Object.values(T);
  ok(allStats.length === 7 && allStats.every((s) => s.lights === 0 && s.meshes > 0) && T.tv.liveLights === 0, `all 7 models build with meshes and zero lights (${allStats.map((s) => `${s.meshes}/${s.lights}`).join(' ')})`);
  ok(T.sofa.pose === 'sit' && T.sofa.fwd?.z === -1 && T.sofa.seats.length === (D.furn_sofa.cols * 0.5 >= 1.7 ? 3 : 2) && T.sofa.seats.every(([, y]) => Math.abs(y - 0.36) < 1e-6),
    `쇼파: sit rig facing −Z, ${T.sofa.seats.length} cushions at seat top 0.36`, JSON.stringify(T.sofa.seats));
  ok(T.sofa.top.z > 0.1 && T.chair.top.z > 0.05 && T.rocking.top.z > 0.05, `backrests are behind (+Z) — sitting faces the front −Z (sofa ${T.sofa.top.z.toFixed(2)} · chair ${T.chair.top.z.toFixed(2)} · rocking ${T.rocking.top.z.toFixed(2)})`);
  ok(T.chair.pose === 'sit' && T.chair.fwd?.z === -1 && Math.abs(T.chair.anchorY - 0.36) < 1e-6 && T.rocking.fwd?.z === -1, '의자 · 흔들의자: sit rig facing −Z, chair seat top 0.36');
  ok(T.rug.minY >= 0.009 && T.rug.maxY <= 0.03, `러그 lies 1 … 3 cm above the deck, over the grid lines (y ${T.rug.minY.toFixed(4)} … ${T.rug.maxY.toFixed(4)})`);
  ok(T.low.maxY <= D.furn_low_table.height + 0.12, `좌식 테이블 stays low (top ${T.low.maxY.toFixed(2)} m, def ${D.furn_low_table.height})`);
  ok(T.stand.red && T.stand.green && T.stand.blue && T.stand.verts > T.stand.emptyVerts, '게임 디스크 전시대: cases take the disc theme colours, empty slots draw no case');
  ok(T.tv.hasRig && T.tv.overlayHidden === true && T.tv.overlayLive === true && T.tv.screenZ > 0 && T.tv.minZ < -0.15,
    `TV: game overlay rig hidden unless gameActive, screen faces −Z (screen z ${T.tv.screenZ}, sound bar front ${T.tv.minZ.toFixed(2)})`);
  ok(T.tv.looks.every((n) => n > T.tv.verts) && new Set(models.lookSigs).size === 4, `TV: 4 console looks each add geometry and differ (${T.tv.verts} → ${T.tv.looks.join(' / ')})`);

  /* ══ 1. Placement ═══════════════════════════════════════════════════════ */
  console.log('1. 서재에 TV · 쇼파 · 의자 · 게임 디스크 전시대');
  const lights0 = await H(() => window.__count());
  const placed = await H(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    for (const [id, n] of [['mat_scrap', 80], ['mat_alloy', 30], ['mat_cloth', 20], ['mat_circuit', 20], ['mat_cable', 20], ['mat_power_cell', 10]]) {
      const def = ctx.loot.getItemDef(id); if (!def) continue;
      for (let k = 0; k < n; k += def.stackMax ?? 1) ctx.inventory.tryAddToStash(ctx.loot.createItem(id, Math.min(def.stackMax ?? 1, n - k)));
    }
    // 2026-09-13 (power allocation dropped): a fresh ship is at generator Lv.1 and the library needs generator Lv.4 —
    //   the generator gate is not what this smoke covers, so the state is raised. If the rule path still refuses, the
    //   reason is printed and only the room purpose is written straight into the state — this smoke checks hub.
    if (h.state && (h.state.generatorLevel ?? 1) < 4) h.state.generatorLevel = 4;
    let purposeVia = 'rule';
    let purpose = h.getRoom(3).purpose === 'library' || h.setRoomPurpose(3, 'library') === true;
    if (!purpose && h.state?.rooms?.[3]) {
      purposeVia = `state (${h.purposeBlock?.(3, 'library') ?? '?'})`;
      h.state.rooms[3].purpose = 'library';
      purpose = h.getRoom(3).purpose === 'library';
    }
    const put = (id, x, y, yaw) => {
      h.addToStorage(id, 1);
      const it = h.place(3, id, x, y, yaw);
      if (it) return it.uid;
      const s = h.findFreeSpot(3, id);
      return s ? h.place(3, id, s.x, s.y, s.yaw)?.uid ?? null : null;
    };
    // the TV (3×1) faces grid −y · the sofa (4×2) at yaw 2 faces the TV along grid +y · the chair beside it · the
    // stand on the right-hand wall
    const why = (id, x, y, yaw) => h.placementBlock?.(3, id, x, y, yaw) ?? null;
    const blocks = { tv: why('furn_tv', 6, 12, 0), sofa: why('furn_sofa', 5, 7, 2), chair: why('furn_chair', 11, 7, 2), stand: why('furn_game_stand', 10, 13, 0) };
    return { purpose, purposeVia, blocks, tv: put('furn_tv', 6, 12, 0), sofa: put('furn_sofa', 5, 7, 2), chair: put('furn_chair', 11, 7, 2), stand: put('furn_game_stand', 10, 13, 0) };
  });
  ok(placed.purpose && placed.tv && placed.sofa && placed.chair && placed.stand, `방 4 → 서재, pieces placed (${JSON.stringify(placed)})`);
  const U = placed;
  if (!(U.tv && U.sofa && U.chair && U.stand)) throw new Error('pieces missing — the interaction and staging sections need all four');
  const facing = await H((u) => {
    const h = window.__game.ctx.housing;
    const tv = h.getPlaced(3).find((p) => p.uid === u.tv), sofa = h.getPlaced(3).find((p) => p.uid === u.sofa);
    return { tv: tv && { x: tv.x, y: tv.y, yaw: tv.yaw }, sofa: sofa && { x: sofa.x, y: sofa.y, yaw: sofa.yaw } };
  }, U);
  ok(facing.tv?.yaw === 0 && facing.sofa?.yaw === 2 && facing.sofa.y < facing.tv.y, `쇼파 faces the TV (${JSON.stringify(facing)})`);

  /* ══ 2. TV · disc stand interaction ════════════════════════════════ */
  console.log('2. TV 화면 · 게임 디스크 전시대 · 게임기 모델');
  const tvWire = await H((u) => {
    const ctx = window.__game.ctx, h = ctx.housing, layer = window.__game.getSystem('hub').furnitureLayer;
    const it = (uid) => ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`) ?? null;
    const p = ctx.player.position, save = p.clone();
    const box = (uid) => layer.pieces.get(uid).box;
    const tb = box(u.tv), sb = box(u.stand);
    const calls = [], shelves = [];
    const hadMenu = Object.prototype.hasOwnProperty.call(h, 'openTvMenu'), origMenu = h.openTvMenu;
    const hadShelf = Object.prototype.hasOwnProperty.call(h, 'openShelf'), origShelf = h.openShelf;
    h.openTvMenu = (uid) => { calls.push(uid); };
    h.openShelf = (uid) => { shelves.push(uid); };
    p.set((tb.minX + tb.maxX) / 2, save.y, tb.minZ - 0.6);                      // in front of the TV (−Z)
    const withMenu = it(u.tv)?.getPrompt() ?? null;
    it(u.tv)?.interact();
    h.openTvMenu = undefined;
    const withoutMenu = it(u.tv)?.getPrompt() ?? null;
    if (hadMenu) h.openTvMenu = origMenu; else delete h.openTvMenu;
    p.set((sb.minX + sb.maxX) / 2, save.y, sb.minZ - 0.6);                      // in front of the stand
    const standPrompt = it(u.stand)?.getPrompt() ?? null;
    it(u.stand)?.interact();
    if (hadShelf) h.openShelf = origShelf; else delete h.openShelf;
    p.copy(save);
    return { withMenu, withoutMenu, calls, standPrompt, shelves };
  }, U);
  ok(tvWire.withMenu === 'TV 화면' && tvWire.calls.length === 1 && tvWire.calls[0] === U.tv, `TV E with openTvMenu: prompt 'TV 화면' → openTvMenu(tv) (${JSON.stringify(tvWire)})`);
  ok(/^TV · (켜기|끄기)$/.test(tvWire.withoutMenu ?? ''), `TV without openTvMenu falls back to the toggle prompt (${tvWire.withoutMenu})`);
  ok(tvWire.standPrompt === '게임 디스크 전시대' && tvWire.shelves.length === 1 && tvWire.shelves[0] === U.stand, `게임 디스크 전시대 E → openShelf(stand) (${tvWire.standPrompt})`);
  const consoleSwap = await H((u) => {
    const ctx = window.__game.ctx, h = ctx.housing, layer = window.__game.getSystem('hub').furnitureLayer;
    const verts = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position.count; }); return n; };
    const g0 = layer.objectOf(u.tv), v0 = verts(g0);
    const had = Object.prototype.hasOwnProperty.call(h, 'getTvConsole'), orig = h.getTvConsole;
    h.getTvConsole = (uid) => (uid === u.tv ? 'console_holo' : null);
    ctx.bus.emit('housing:tvConsoleChanged', { uid: u.tv, defId: 'console_holo' });
    const g1 = layer.objectOf(u.tv), v1 = verts(g1);
    if (had) h.getTvConsole = orig; else delete h.getTvConsole;
    ctx.bus.emit('housing:tvConsoleChanged', { uid: u.tv, defId: null });
    const g2 = layer.objectOf(u.tv);
    return { rebuilt: g1 !== g0 && g2 !== g1, v0, v1, v2: verts(g2), holo: !!ctx.loot.getItemDef('console_holo')?.gameConsole };
  }, U);
  ok(consoleSwap.rebuilt && consoleSwap.v1 > consoleSwap.v0 && (consoleSwap.v2 === consoleSwap.v0 || !consoleSwap.holo), `housing:tvConsoleChanged rebuilds the TV with its console (${JSON.stringify(consoleSwap)})`);

  /* ══ 3. Seats ═══════════════════════════════════════════════════════════ */
  console.log('3. 쇼파 · 의자 앉기');
  const seats = await H((u) => {
    const ctx = window.__game.ctx, layer = window.__game.getSystem('hub').furnitureLayer;
    const it = (uid) => ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`) ?? null;
    const p = ctx.player.position, save = p.clone();
    const sofa = layer.pieces.get(u.sofa);
    sofa.model.group.updateWorldMatrix(true, false);
    const cushions = sofa.model.rig.seats.map((s) => sofa.model.group.localToWorld(s.clone()));
    // stands beside the right-most (+X) cushion
    const far = cushions.reduce((a, c) => (c.x > a.x ? c : a), cushions[0]);
    p.set(far.x, save.y, far.z + 1.0);
    const prompt = it(u.sofa)?.getPrompt() ?? null;
    it(u.sofa)?.interact();
    const st = ctx.player.furniturePoseState;
    const sofaPose = { kind: ctx.player.furniturePose, x: st?.anchor.x, y: st?.anchor.y, z: st?.anchor.z, uid: st?.furnitureUid, want: [far.x, far.z] };
    ctx.player.setFurniturePose(null);
    const cb = layer.pieces.get(u.chair).box;
    p.set((cb.minX + cb.maxX) / 2, save.y, (cb.minZ + cb.maxZ) / 2 + 0.9);
    const chairPrompt = it(u.chair)?.getPrompt() ?? null;
    it(u.chair)?.interact();
    const cs = ctx.player.furniturePoseState;
    const chairPose = { kind: ctx.player.furniturePose, y: cs?.anchor.y, uid: cs?.furnitureUid };
    ctx.player.setFurniturePose(null);
    p.copy(save);
    return { prompt, sofaPose, chairPrompt, chairPose };
  }, U);
  ok(seats.prompt === '쇼파 · 앉기' && seats.sofaPose.kind === 'sit' && seats.sofaPose.uid === U.sofa && Math.abs(seats.sofaPose.y - 0.36) < 0.02
    && Math.hypot(seats.sofaPose.x - seats.sofaPose.want[0], seats.sofaPose.z - seats.sofaPose.want[1]) < 0.05, `쇼파 E sits on the nearest cushion (${JSON.stringify(seats.sofaPose)})`);
  ok(seats.chairPrompt === '의자 · 앉기' && seats.chairPose.kind === 'sit' && seats.chairPose.uid === U.chair && Math.abs(seats.chairPose.y - 0.36) < 0.02, `의자 E sits (${JSON.stringify(seats.chairPose)})`);

  /* ══ 4. The game cutscene ═════════════════════════════════════════════ */
  console.log('4. 게임 세션 연출');
  await H(() => {
    const h = window.__game.ctx.housing;
    window.__cancels = 0;
    window.__hadCancel = Object.prototype.hasOwnProperty.call(h, 'cancelGameSession');
    window.__origCancel = h.cancelGameSession;
    h.cancelGameSession = () => { window.__cancels++; };
  });
  const session = (active, extra = {}) => H(({ u, active, extra }) => window.__game.ctx.bus.emit('housing:gameSession', {
    tvUid: u.tv, seatUid: u.sofa, discDefId: 'game_sniper_vr', active, stat: 'perception', minigame: 'press', completed: !active, ...extra,
  }), { u: U, active, extra });
  await session(true);
  const start = await H(async (u) => {
    const ctx = window.__game.ctx, layer = window.__game.getSystem('hub').furnitureLayer;
    const G = await import('/src/hub/interiors/GameStaging.ts');
    const R = await import('/src/hub/interiors/RoomLayout.ts');
    const seat = layer.pieces.get(u.sofa), tv = layer.pieces.get(u.tv);
    const screen = G.tvScreenWorld(tv);
    const pose = G.gamePoseOf(seat, tv, layer.blockersFor(u.sofa));
    const st = ctx.player.furniturePoseState;
    const a = pose.anchor, cam = pose.camera.position;
    const toS = { x: screen.x - a.x, z: screen.z - a.z }, toC = { x: cam.x - a.x, z: cam.z - a.z };
    const fwd = { x: -Math.sin(pose.yaw), z: -Math.cos(pose.yaw) };
    const len = Math.hypot(toS.x, toS.z);
    const room = R.roomBox(3);
    // is it the cushion nearest the TV
    seat.model.group.updateWorldMatrix(true, false);
    const cushions = seat.model.rig.seats.map((s) => seat.model.group.localToWorld(s.clone()));
    const nearest = cushions.reduce((b, c) => (Math.hypot(c.x - screen.x, c.z - screen.z) < Math.hypot(b.x - screen.x, b.z - screen.z) ? c : b), cushions[0]);
    return {
      kind: ctx.player.furniturePose, uid: st?.furnitureUid, anchorMatch: st ? Math.hypot(st.anchor.x - a.x, st.anchor.z - a.z) : null,
      nearest: Math.hypot(nearest.x - a.x, nearest.z - a.z), facing: (fwd.x * toS.x + fwd.z * toS.z) / len,
      behind: (toC.x * toS.x + toC.z * toS.z) / len, camY: cam.y, inRoom: cam.x > room.minX && cam.x < room.maxX && cam.z > room.minZ && cam.z < room.maxZ,
      stage: layer.gameStage, overlay: layer.objectOf(u.tv)?.getObjectByName('tv-game')?.visible === true, cancels: window.__cancels, camWant: [cam.x, cam.y, cam.z],
      lights: window.__count(),
    };
  }, U);
  ok(start.kind === 'sit' && start.uid === U.sofa && start.anchorMatch < 0.01 && start.nearest < 0.01, `session → sit on the 쇼파 cushion nearest the TV (${JSON.stringify({ kind: start.kind, m: start.anchorMatch, n: start.nearest })})`);
  ok(start.facing > 0.8, `the player faces the TV screen (cos ${start.facing.toFixed(3)})`);
  ok(start.behind < 0 && start.camY > 1.3 && start.camY < 2.1 && start.inRoom, `fixed camera behind the seat, head height, inside the room (${JSON.stringify({ behind: start.behind, y: start.camY, room: start.inRoom })})`);
  ok(start.stage?.held === true && start.stage.overlay === true && start.overlay && start.cancels === 0, `game overlay on, pose held, nothing cancelled (${JSON.stringify(start.stage)})`);
  await waitSim(1.2);
  const camNow = await H((want) => { const c = window.__game.ctx.camera.position; return Math.hypot(c.x - want[0], c.y - want[1], c.z - want[2]); }, start.camWant);
  ok(camNow < 0.35, `the camera settles on the fixed shot (${camNow.toFixed(3)} m away)`);
  await H((u) => window.__game.ctx.bus.emit('housing:gameBeat', { tvUid: u.tv, quality: 'perfect', index: 0, total: 4 }), U);
  await waitSim(0.05);
  const beat = await H(() => ({ stage: window.__game.getSystem('hub').furnitureLayer.gameStage, lights: window.__count() }));
  // 2026-09-14 (user's decision): the screen flash on every judgement (`flash` · `SCREEN_FLASH`) is gone — the
  // reaction is told by the marker **inside** the screen (`kick`) and the progress bar, and the screen's glow is only
  // the base intensity + a gentle pulse (`SCREEN_BASE ± SCREEN_PULSE`).
  ok(beat.stage && beat.stage.kick > 0.3 && Math.abs(beat.stage.progress - 0.25) < 1e-6
    && beat.stage.screenIntensity > 0.9 && beat.stage.screenIntensity < 1.4 && !('flash' in beat.stage),
  `gameBeat → 표식 kick + progress 1/4 · 화면은 번쩍이지 않는다 (${JSON.stringify(beat.stage)})`);
  await session(false);
  const ended = await H((u) => {
    const ctx = window.__game.ctx, layer = window.__game.getSystem('hub').furnitureLayer;
    return { pose: ctx.player.furniturePose ?? null, stage: layer.gameStage, overlay: layer.objectOf(u.tv)?.getObjectByName('tv-game')?.visible, cancels: window.__cancels };
  }, U);
  ok(ended.pose === null && ended.stage === null && ended.overlay === false && ended.cancels === 0, `session end → pose released, overlay hidden, no cancel (${JSON.stringify(ended)})`);
  // 2026-09-17 (user's decision): a seatless session (`seatUid` null) = standing with no pose · no camera, only the
  // game screen turns on (it is not cancelled)
  const standing = await H((u) => {
    const ctx = window.__game.ctx, layer = window.__game.getSystem('hub').furnitureLayer;
    const base = { tvUid: u.tv, seatUid: null, discDefId: 'game_sniper_vr', stat: 'perception', minigame: 'press' };
    const before = window.__cancels;
    ctx.bus.emit('housing:gameSession', { ...base, active: true, completed: false });
    const on = { pose: ctx.player.furniturePose ?? null, stage: layer.gameStage, overlay: layer.objectOf(u.tv)?.getObjectByName('tv-game')?.visible === true, cancels: window.__cancels - before };
    ctx.bus.emit('housing:gameSession', { ...base, active: false, completed: false });
    const off = { stage: layer.gameStage, overlay: layer.objectOf(u.tv)?.getObjectByName('tv-game')?.visible === true, cancels: window.__cancels - before };
    return { on, off };
  }, U);
  ok(standing.on.pose === null && standing.on.stage?.seatUid === null && standing.on.stage.held === false && standing.on.overlay && standing.on.cancels === 0,
    `seatUid null → no pose, overlay on, not cancelled (${JSON.stringify(standing.on)})`);
  ok(standing.off.stage === null && !standing.off.overlay && standing.off.cancels === 0, `standing session end → overlay hidden (${JSON.stringify(standing.off)})`);
  // a refused pose → cancelGameSession on the spot
  const refused = await H((u) => {
    const ctx = window.__game.ctx, p = ctx.player;
    const had = Object.prototype.hasOwnProperty.call(p, 'setFurniturePose'), orig = p.setFurniturePose;
    p.setFurniturePose = () => false;
    const before = window.__cancels;
    ctx.bus.emit('housing:gameSession', { tvUid: u.tv, seatUid: u.sofa, discDefId: 'game_sniper_vr', active: true, stat: 'perception', minigame: 'cycle', completed: false });
    const after = window.__cancels;
    if (had) p.setFurniturePose = orig; else delete p.setFurniturePose;
    return { sync: after - before, stage: window.__game.getSystem('hub').furnitureLayer.gameStage };
  }, U);
  ok(refused.sync === 1 && refused.stage === null, `refused pose → cancelGameSession called synchronously (${JSON.stringify(refused)})`);
  // the pose released from outside → cancelGameSession
  await session(true, { minigame: 'breath' });
  const external = await H(() => {
    const ctx = window.__game.ctx, before = window.__cancels;
    const held = window.__game.getSystem('hub').furnitureLayer.gameStage?.held === true;
    ctx.player.setFurniturePose(null);
    return { held, delta: window.__cancels - before, stage: window.__game.getSystem('hub').furnitureLayer.gameStage };
  });
  ok(external.held && external.delta === 1 && external.stage === null, `pose released from outside → cancelGameSession (${JSON.stringify(external)})`);
  await H(() => { const h = window.__game.ctx.housing; if (window.__hadCancel) h.cancelGameSession = window.__origCancel; else delete h.cancelGameSession; });
  const lights1 = await H(() => window.__count());
  ok(lights0 === lights1 && start.lights === lights0 && beat.lights === lights0, `scene point-light count unchanged (${lights0} → placed/session ${start.lights}/${beat.lights} → ${lights1})`);
  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (err) {
  fail++;
  console.log(`  FAIL threw: ${err?.stack ?? err}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke-tv-games: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
