// Smoke test for the 시뮬레이션 훈련장 (Phase 7 §9, world + hub folders, 2026-09-06):
// personal ship → 사격장 room (room 6, built here — a new ship has no facility rooms) with a real `furn_sim_hub` (placed through `ctx.housing`, holo pedestal + spinning rings)
// → E on the hub → `game:newMission {mode:'training'}` → arena world (flat floor, walls, 12 pop-up targets, exit console,
// no crates / nests / gather / extraction, space-mode "indoor" look, `ui:objective` counter) → arena queries (height /
// bounds / collision clamp / raycast floor + wall + target cylinder) → the real gun knocks target 0 down through the
// destructible-obstacle path → it pops back after TRAINING_TARGET_RESPAWN_S → the exit console emits
// `training:exitRequested` (+ the return to the ship, driven by game/ when implemented, else by the script) → a faked
// lobby checks the shared-ship terminal entry (시작 / 합류 (n명 훈련 중) / 임무 진행 중) and the pod lock while a training runs.
// Phase 9 `target modes`: `ctx.world.training` (TrainingRef), the mode console `training_mode` cycling 고정 → 이동 → 타임 코스
// (`training:modeChanged`), 이동 표적 x sweep + a raycast at the moved x (hash re-bucketed), the timed course (start / `training:scored` /
// `training:courseFinished` completed + timed-out, best in localStorage `scav.training`, `setMode` refused mid-course), the weapon rack
// `training_rack` → `ui:catalogToggled {open:true}` and the catalog-granted weapon gone after the exit restore.
// Usage: node scripts/smoke-training.mjs [http://localhost:5273/]   (needs a vite dev server; no relay needed)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot');
  // Phase 11: a launch slot refuses boarding while the ship has no 목표 행성, so give this profile one up front
  // (the planet itself is `smoke-planets`' business; here it only has to be set so the READY-panel block can board).
  await page.evaluate(() => { try { localStorage.removeItem('scav.ship'); localStorage.removeItem('scav.loadout'); localStorage.removeItem('scav.training'); localStorage.setItem('scav.planet', 'mossy'); } catch {} });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, 'boot (fresh ship state)');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['hub:entered', 'hub:left', 'game:newMission', 'world:ready', 'world:cleared', 'ui:objective', 'training:exitRequested',
      'weapon:hit', 'weapon:fired', 'ui:notify', 'housing:furniturePlaced', 'net:lobbyUpdated',
      'training:modeChanged', 'training:scored', 'training:courseFinished', 'ui:catalogToggled',
      'hub:readyPanelToggled', 'hub:crewLoadoutToggled']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  const mouseDown = (b = 0) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b = 0) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);

  /* ── 1. personal ship: place a real sim hub in a 사격장 room ─────────────── */
  console.log('personal ship · furn_sim_hub');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  const housing = await P(() => {
    const ctx = window.__game.ctx, h = ctx.housing;
    if (!h || typeof h.place !== 'function' || typeof h.craftFurniture !== 'function') return { available: false };
    // materials into the bag (the stash may be empty on a fresh profile)
    for (const [id, n] of [['mat_scrap', 60], ['mat_cable', 12], ['mat_circuit', 12], ['mat_alloy', 12]]) {
      for (let k = 0; k < 3; k++) { try { if (!ctx.inventory.tryAddItem(ctx.loot.createItem(id, n))) break; } catch { break; } }
    }
    let gen = 0; try { while (gen < 3 && h.upgrade('generator')) gen++; } catch {}
    const purpose = h.setRoomPurpose(5, 'range');
    const can = h.canCraftFurniture('furn_sim_hub');
    const crafted = h.craftFurniture('furn_sim_hub');
    const placed = crafted ? h.place(5, 'furn_sim_hub', 3, 3, 0) : null;
    return { available: true, gen, purpose, can, crafted, uid: placed?.uid ?? null };
  });
  const hasHub = housing.available && !!housing.uid;
  ok(housing.available, 'ctx.housing available (real HousingSystem)');
  ok(housing.purpose === true, `room 6 → 사격장 (generator ${housing.gen})`);
  ok(housing.crafted === true, `craftFurniture(furn_sim_hub) ${JSON.stringify(housing.can)}`);
  ok(hasHub, `furn_sim_hub placed in room 6 (${housing.uid})`);
  let simInteractId = null;
  if (hasHub) {
    await waitSim(0.5);
    const model = await P((uid) => {
      const ctx = window.__game.ctx;
      const room = ctx.scene.getObjectByName('room-5');
      const g = room?.getObjectByName('furn-furn_sim_hub') ?? null;
      const spin = g?.getObjectByName('sim-spin') ?? null;
      const inner = g?.getObjectByName('sim-spin-inner') ?? null;
      let meshes = 0, lights = 0; g?.traverse((o) => { if (o.isMesh) meshes++; if (o.isLight) lights++; });
      const it = ctx.interactables.all().find((i) => i.id === `hub_furn_${uid}`) ?? null;
      return { has: !!g, meshes, lights, spinY: spin?.rotation.y ?? 0, innerZ: inner?.rotation.z ?? 0, id: it?.id ?? null, prompt: it?.getPrompt() ?? null, can: it?.canInteract() ?? false };
    }, housing.uid);
    ok(model.has && model.meshes >= 4, `holo pedestal model under room-5 (${model.meshes} meshes)`);
    ok(model.lights === 0, 'sim hub adds no light');
    ok(model.spinY > 0.05 && model.innerZ > 0.05, `rings rotate (spin.y ${model.spinY.toFixed(2)}, inner.z ${model.innerZ.toFixed(2)})`);
    ok(model.id !== null && /시뮬레이션 허브/.test(model.prompt ?? '') && /훈련장/.test(model.prompt ?? ''), `interactable ${model.id} prompt "${model.prompt}"`);
    ok(model.can, 'sim hub usable while walking the ship');
    simInteractId = model.id;
  }

  /* ── 2. enter the training ───────────────────────────────────────────────── */
  console.log('training arena');
  const entered = await P((id) => {
    const ctx = window.__game.ctx;
    if (id) { const it = ctx.interactables.all().find((i) => i.id === id); it.interact(); return 'furniture'; }
    return window.__game.getSystem('hub').startTraining() ? 'startTraining' : 'refused';
  }, simInteractId);
  ok(entered !== 'refused', `entered through ${entered}`);
  const nm = await lastEv('game:newMission');
  ok(nm && nm.mode === 'training', `game:newMission {mode:'training'} (${JSON.stringify(nm)})`);
  const world = await waitFor(page, () => window.__game.ctx.world?.ready && window.__game.ctx.world.mode === 'training', 'training world ready');
  ok(!!world, 'ctx.world.ready with mode training');
  const w0 = await P(() => {
    const ctx = window.__game.ctx, w = ctx.world, ws = window.__game.getSystem('world');
    const arena = ws.trainingArena;
    const ids = ctx.interactables.all().map((i) => i.id);
    const exit = ctx.interactables.all().find((i) => i.id === 'training_exit');
    const modeIt = ctx.interactables.all().find((i) => i.id === 'training_mode');
    const rackIt = ctx.interactables.all().find((i) => i.id === 'training_rack');
    const atmo = ctx.scene.userData.atmosphere;
    let groupMeshes = 0; ctx.scene.getObjectByName('TrainingArena')?.traverse((o) => { if (o.isMesh) groupMeshes++; });
    const sp = w.getPlayerSpawn();
    return {
      missionMode: ctx.missionMode, size: w.size, seed: w.seed,
      extraction: w.getExtractionPoints().length, crates: w.getCrates().length, nests: w.getNestPositions().length, gather: w.getGatherNodes().length,
      spawns: w.getEnemySpawnPoints(sp, 5, 5, 20).length,
      targets: arena?.targetCount ?? -1, obstacles: w.getObstacles().length,
      hubShip: ctx.hub.ship, hasExit: !!exit, exitPrompt: exit?.getPrompt() ?? null, crateIds: ids.filter((i) => /^crate/.test(i)).length,
      modePrompt: modeIt?.getPrompt() ?? null, modeX: modeIt?.position.x ?? null, rackPrompt: rackIt?.getPrompt() ?? null, rackX: rackIt?.position.x ?? null,
      training: w.training ? { mode: w.training.mode, score: w.training.score, hits: w.training.hits, remaining: w.training.remaining, best: w.training.bestTime } : null,
      space: atmo?.spaceMode ?? null, groupMeshes, spawn: [sp.x, sp.y, sp.z],
      h: w.getHeightAt(5, 5), inside: w.isInsideBounds(20, -20), outside: w.isInsideBounds(40, 0),
    };
  });
  ok(w0.missionMode === 'training', `ctx.missionMode training (${w0.missionMode})`);
  ok(w0.size === 64, `world.size = TRAINING_ARENA_SIZE (${w0.size})`);
  ok(w0.extraction === 0 && w0.crates === 0 && w0.nests === 0 && w0.gather === 0, `no extraction / crates / nests / gather (${w0.extraction}/${w0.crates}/${w0.nests}/${w0.gather})`);
  ok(w0.spawns === 0, `no enemy spawn points (${w0.spawns})`);
  ok(w0.targets === 12, `12 pop-up targets (${w0.targets})`);
  ok(w0.obstacles === 15, `15 obstacles = targets + exit / mode / rack consoles (${w0.obstacles})`);
  ok(w0.modePrompt === '표적 모드: 고정 표적' && w0.modeX === 8, `training_mode console at x +8, prompt "${w0.modePrompt}"`);
  ok(w0.rackPrompt === '무기 거치대' && w0.rackX === 14, `training_rack console at x +14, prompt "${w0.rackPrompt}"`);
  ok(!!w0.training && w0.training.mode === 'static' && w0.training.score === 0 && w0.training.remaining === -1 && w0.training.best === null, `ctx.world.training: ${JSON.stringify(w0.training)}`);
  ok(w0.hubShip === null, 'hub torn down (ctx.hub.ship null)');
  ok(w0.hasExit && w0.exitPrompt === '훈련 종료', `training_exit registered, prompt "${w0.exitPrompt}"`);
  ok(w0.crateIds === 0, 'no crate interactables');
  ok(w0.space === true, `atmosphere space mode on (indoor look) (${w0.space})`);
  ok(w0.groupMeshes >= 20, `arena meshes built (${w0.groupMeshes})`);
  ok(Math.abs(w0.spawn[0]) < 0.01 && Math.abs(w0.spawn[2] - 26) < 0.01 && w0.spawn[1] === 0, `spawn at the south end (${w0.spawn.map((n) => n.toFixed(1))})`);
  ok(w0.h === 0 && w0.inside && !w0.outside, 'flat height 0, bounds = arena');
  const obj = await lastEv('ui:objective');
  ok(obj && /시뮬레이션 훈련장/.test(obj.text) && /명중 0/.test(obj.subText ?? '') && /고정 표적/.test(obj.subText ?? ''), `ui:objective "${obj?.text}" / "${obj?.subText}"`);
  const wr = await lastEv('world:ready');
  ok(wr && wr.seed === w0.seed, 'world:ready emitted with the seed');

  // queries
  const q = await P(() => {
    const THREE_V = window.__game.ctx.world.getPlayerSpawn().constructor;
    const w = window.__game.ctx.world;
    const v = (x, y, z) => { const o = new THREE_V(); o.set(x, y, z); return o; };
    const clamp = w.resolveCollision(v(40, 0, 40), 0.45);
    const down = w.raycast(v(3, 3, 3), v(0, -1, 0), 20);
    const wall = w.raycast(v(0, 1, 0), v(1, 0, 0), 100);
    const ceil = w.raycast(v(0, 1, 0), v(0, 1, 0), 100);
    const t0 = window.__game.getSystem('world').trainingArena.getTargetState(0);
    const from = v(t0.position.x, 1.4, t0.position.z + 8);
    const tgt = w.raycast(from, v(0, 0, -1), 60);
    return {
      clamp: [clamp.x, clamp.z],
      down: down ? [down.point.y, down.normal.y, !!down.obstacle] : null,
      wall: wall ? [wall.point.x, wall.normal.x] : null,
      ceil: ceil ? [ceil.point.y, ceil.normal.y] : null,
      tgt: tgt ? { id: tgt.obstacle?.destructible?.id ?? null, hp: tgt.obstacle?.destructible?.hp ?? null, dist: tgt.distance } : null,
      t0: { down: t0.down, hp: t0.hp },
    };
  });
  ok(q.clamp[0] <= 31.55 && q.clamp[1] <= 31.55, `resolveCollision clamps inside the walls (${q.clamp.map((n) => n.toFixed(2))})`);
  ok(q.down && Math.abs(q.down[0]) < 0.01 && q.down[1] === 1 && !q.down[2], `raycast down hits the floor (y ${q.down?.[0]}, n.y ${q.down?.[1]})`);
  ok(q.wall && Math.abs(q.wall[0] - 32) < 0.01 && q.wall[1] === -1, `raycast +X hits the wall at x 32 (n.x −1) (${q.wall})`);
  ok(q.ceil && Math.abs(q.ceil[0] - 7) < 0.01 && q.ceil[1] === -1, `raycast up hits the ceiling at y 7 (${q.ceil})`);
  ok(q.tgt && q.tgt.id === 'training_target_0' && q.tgt.hp === 60, `raycast at target 0 returns its destructible (${JSON.stringify(q.tgt)})`);
  ok(!q.t0.down && q.t0.hp === 60, 'target 0 standing at 60 hp');

  /* ── 3. shoot target 0 with the real gun ───────────────────────────────── */
  console.log('shooting');
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'phase playing (drop-in)');
  await waitSim(0.5);
  // 2026-09-07: the starter kit is 권총 only — take a 돌격소총 + 준중량탄 into the training so the shots below land
  const armed = await P(() => {
    const ctx = window.__game.ctx, inv = ctx.inventory;
    let equipped = true;
    if (!inv.getLoadout().primary) {
      // the furniture-material section above filled the 5×3 bagless grid — clear it, put a 가방 on, then the 돌격소총
      for (const it of [...inv.getAllItems()]) inv.takeItem(it.uid);
      const b = ctx.loot.createItem('bag_common');
      equipped = inv.tryAddItem(b) && inv.equip(b.uid, 'bag');
      const g = ctx.loot.createItem('wpn_ar');
      equipped = equipped && inv.tryAddItem(g) && inv.equip(g.uid, 'primary');
      inv.tryAddItem(ctx.loot.createItem('ammo_medium', 50));
    }
    return { equipped, primary: inv.getLoadout().primary?.defId ?? null };
  });
  ok(armed.equipped && armed.primary === 'wpn_ar', `돌격소총 I equipped for the shooting checks (${JSON.stringify(armed)})`);
  await tap('Digit1');
  await waitSim(1.2);
  // stand 10 m behind target 0 facing −Z, then shift so the over-the-shoulder camera ray passes through the board
  const aim = await P(() => {
    const ctx = window.__game.ctx, p = ctx.player;
    const t0 = window.__game.getSystem('world').trainingArena.getTargetState(0);
    const v = t0.position.clone(); v.set(t0.position.x, 0, t0.position.z + 10);
    p.teleport(v, 0, true);
    return [t0.position.x, t0.position.z];
  });
  await waitSim(0.8);
  const aligned = await P(([tx, tz]) => {
    const ctx = window.__game.ctx, p = ctx.player, cam = ctx.camera;
    const offX = cam.position.x - p.position.x;
    const v = p.position.clone(); v.set(tx - offX, 0, tz + 10);
    p.teleport(v, 0, true);
    return { offX };
  }, aim);
  await waitSim(0.8);
  const camRay = await P(() => {
    const ctx = window.__game.ctx, cam = ctx.camera;
    const dir = cam.position.clone(); cam.getWorldDirection(dir);
    const h = ctx.world.raycast(cam.position, dir, 80);
    return h ? (h.obstacle?.destructible?.id ?? 'env') : 'none';
  });
  ok(camRay === 'training_target_0', `camera ray lands on target 0 (${camRay}, shoulder ${aligned.offX.toFixed(2)})`);
  const hitsBefore = await P(() => window.__game.getSystem('world').trainingArena.hits);
  const fired0 = (await ev('weapon:fired')).length;
  await mouseDown(0);
  await waitSim(0.35);
  await mouseUp(0);
  await waitSim(0.3);
  const shot = await P(() => {
    const a = window.__game.getSystem('world').trainingArena;
    return { hits: a.hits, knock: a.knockdowns, t0: a.getTargetState(0) };
  });
  const firedN = (await ev('weapon:fired')).length - fired0;
  ok(firedN > 0, `gun fired (${firedN} shots)`);
  ok(shot.hits > hitsBefore, `target registered ${shot.hits - hitsBefore} hits through the destructible path`);
  const whit = (await ev('weapon:hit')).filter((h) => h.enemyId === null).length;
  ok(whit > 0, `weapon:hit with enemyId null (${whit})`);
  if (!shot.t0.down) {
    await mouseDown(0); await waitSim(0.8); await mouseUp(0); await waitSim(0.3);
  }
  const knocked = await P(() => {
    const a = window.__game.getSystem('world').trainingArena;
    const ctx = window.__game.ctx;
    const g = ctx.scene.getObjectByName('target-0');
    const board = g?.children.find((c) => c.isGroup);
    const t0 = a.getTargetState(0);
    const from = t0.position.clone(); from.set(t0.position.x, 1.4, t0.position.z + 8);
    const dir = from.clone(); dir.set(0, 0, -1);
    const h = ctx.world.raycast(from, dir, 60);
    return { down: t0.down, hp: t0.hp, knock: a.knockdowns, boardX: board?.rotation.x ?? 0, through: h ? (h.obstacle?.destructible?.id ?? 'env') : 'none', obstacles: ctx.world.getObstacles().length };
  });
  ok(knocked.down && knocked.hp === 0, `target 0 knocked down (hp ${knocked.hp})`);
  ok(knocked.knock >= 1, `knockdown counted (${knocked.knock})`);
  ok(knocked.boardX < -1.2, `board hinged to the floor (rotation.x ${knocked.boardX.toFixed(2)})`);
  ok(knocked.through !== 'training_target_0', `a fallen target no longer blocks the ray (${knocked.through})`);
  ok(knocked.obstacles === 14, `obstacle removed from the hash while down (${knocked.obstacles})`);
  const scored0 = await lastEv('training:scored');
  ok(scored0 && scored0.index === 0 && scored0.score === 1, `training:scored {index 0, score 1} (${JSON.stringify(scored0)})`);
  const objDown = await lastEv('ui:objective');
  ok(objDown && /격추 1/.test(objDown.subText ?? ''), `objective counter updated "${objDown?.subText}"`);
  await waitSim(3.6);   // TRAINING_TARGET_RESPAWN_S 3 + raise animation
  const raised = await P(() => {
    const a = window.__game.getSystem('world').trainingArena;
    const ctx = window.__game.ctx;
    const g = ctx.scene.getObjectByName('target-0');
    const board = g?.children.find((c) => c.isGroup);
    const t0 = a.getTargetState(0);
    const from = t0.position.clone(); from.set(t0.position.x, 1.4, t0.position.z + 8);
    const dir = from.clone(); dir.set(0, 0, -1);
    const h = ctx.world.raycast(from, dir, 60);
    return { down: t0.down, hp: t0.hp, boardX: board?.rotation.x ?? 0, through: h ? (h.obstacle?.destructible?.id ?? 'env') : 'none', obstacles: ctx.world.getObstacles().length };
  });
  ok(!raised.down && raised.hp === 60, `target 0 popped back up after TRAINING_TARGET_RESPAWN_S (hp ${raised.hp})`);
  ok(Math.abs(raised.boardX) < 0.05, `board upright again (rotation.x ${raised.boardX.toFixed(2)})`);
  ok(raised.through === 'training_target_0' && raised.obstacles === 15, 'target back in the hash');

  /* ── 3b. target modes (Phase 9) ─────────────────────────────────────────── */
  console.log('target modes');
  const modeIt = () => P(() => { const it = window.__game.ctx.interactables.all().find((i) => i.id === 'training_mode'); it.interact(); return it.getPrompt(); });
  const tr = (fn, arg) => P(fn, arg);
  const p1 = await modeIt();
  await waitSim(0.1);
  const m1 = await tr(() => ({ mode: window.__game.ctx.world.training.mode, ev: window.__ev['training:modeChanged'].map((e) => e.mode), score: window.__game.ctx.world.training.score }));
  ok(m1.mode === 'moving' && m1.ev.join(',') === 'moving' && p1 === '표적 모드: 이동 표적', `E cycles to 이동 표적 (training:modeChanged ${m1.ev.join(',')}, prompt "${p1}")`);
  ok(m1.score === 0, 'score reset on a mode change');
  const mx0 = await tr(() => window.__game.getSystem('world').trainingArena.getTargetState(0).position.x);
  await waitSim(0.6);
  const mx1 = await tr(() => window.__game.getSystem('world').trainingArena.getTargetState(0).position.x);
  await waitSim(0.6);
  const moved = await tr(() => {
    const ctx = window.__game.ctx, w = ctx.world;
    const t0 = window.__game.getSystem('world').trainingArena.getTargetState(0);
    const root = ctx.scene.getObjectByName('target-0');
    const from = t0.position.clone(); from.set(t0.position.x, 1.4, t0.position.z + 8);
    const dir = from.clone(); dir.set(0, 0, -1);
    const h = w.raycast(from, dir, 60);
    // a ray 3 m to the other side of the lane centre must miss (the target moved in the hash, not only visually)
    const from2 = from.clone(); from2.x = -10 + (t0.position.x < -10 ? 3 : -3);
    const h2 = w.raycast(from2, dir, 60);
    const x3 = window.__game.getSystem('world').trainingArena.getTargetState(3).position.x;
    return { x: t0.position.x, rootX: root.position.x, hit: h ? (h.obstacle?.destructible?.id ?? 'env') : 'none', away: h2 ? (h2.obstacle?.destructible?.id ?? 'env') : 'none', obstacles: w.getObstacles().length, x3 };
  });
  ok(mx1 !== mx0 && moved.x !== mx1, `이동 표적: target 0 x sweeps (${mx0.toFixed(2)} → ${mx1.toFixed(2)} → ${moved.x.toFixed(2)})`);
  ok(Math.abs(moved.rootX - moved.x) < 1e-6, 'mesh root follows the obstacle entry');
  // TRAINING_MOVING_SPAN (3.2) is the HALF width of the sweep; targets 0 and 3 both sit in lane 0 (centre x = −10),
  // and 3.2 + TARGET_RADIUS 0.42 stays inside LANE_HALF_W 4.
  ok(Math.abs(moved.x + 10) <= 3.2 + 1e-6 && Math.abs(moved.x3 + 10) <= 3.2 + 1e-6, `sweep stays within TRAINING_MOVING_SPAN of the lane centre (${moved.x.toFixed(2)}, ${moved.x3.toFixed(2)})`);
  ok(moved.hit === 'training_target_0', `raycast at the moved x hits target 0 (${moved.hit})`);
  ok(moved.away !== 'training_target_0', `ray on the other side of the lane misses it (${moved.away})`);
  ok(moved.obstacles === 15, `no duplicate hash entries after re-bucketing (${moved.obstacles})`);
  const p2 = await modeIt();
  await waitSim(0.1);
  const m2 = await tr(() => ({ mode: window.__game.ctx.world.training.mode, x: window.__game.getSystem('world').trainingArena.getTargetState(0).position.x, ev: window.__ev['training:modeChanged'].map((e) => e.mode) }));
  ok(m2.mode === 'timed' && p2 === '타임 코스 시작', `E cycles to 타임 코스 (prompt "${p2}")`);
  ok(m2.x !== moved.x && Math.abs(m2.x + 10) <= 1.6 + 1e-6, `targets return to their resting x when leaving 이동 표적 (${m2.x.toFixed(2)})`);
  const started = await tr(() => window.__game.ctx.world.training.startCourse());
  ok(started === true, 'startCourse() in 타임 코스 while idle → true');
  await waitSim(0.25);   // let the clock tick: `remaining` is (deadline − arena time) and both are stamped by `update`
  const c0 = await tr(() => {
    const t = window.__game.ctx.world.training;
    const it = window.__game.ctx.interactables.all().find((i) => i.id === 'training_mode');
    const again = t.startCourse();
    const setMoving = t.setMode('moving');
    it.interact();                      // E during a course does nothing
    return { remaining: t.remaining, again, setMoving, mode: t.mode, prompt: it.getPrompt(), score: t.score, hits: t.hits };
  });
  ok(c0.remaining > 59 && c0.remaining < 60, `course running: remaining ${c0.remaining.toFixed(2)} s (counts down from ${60})`);
  ok(c0.again === false && c0.setMoving === false && c0.mode === 'timed', 'startCourse / setMode refused mid-course');
  ok(/타임 코스 진행 중/.test(c0.prompt ?? '') && c0.score === 0 && c0.hits === 0, `console prompt "${c0.prompt}", counters reset`);
  const objRun = await lastEv('ui:objective');
  ok(objRun && /0\/10/.test(objRun.subText ?? '') && /남은/.test(objRun.subText ?? ''), `objective shows the course (${objRun?.subText})`);
  // knock target 1 through the public destructible path
  const scoredN = (await ev('training:scored')).length;
  const k1 = await tr(() => {
    const ctx = window.__game.ctx, w = ctx.world;
    const t1 = window.__game.getSystem('world').trainingArena.getTargetState(1);
    const from = t1.position.clone(); from.set(t1.position.x, 1.4, t1.position.z + 8);
    const dir = from.clone(); dir.set(0, 0, -1);
    const h = w.raycast(from, dir, 60);
    h.obstacle.destructible.onDamage(60, h.point);
    return { score: w.training.score, hits: w.training.hits };
  });
  const sc1 = await lastEv('training:scored');
  ok(k1.score === 1 && k1.hits === 1 && (await ev('training:scored')).length === scoredN + 1 && sc1.index === 1 && sc1.score === 1, `training:scored on a knock-down (${JSON.stringify(sc1)})`);
  // knock 9 more distinct standing targets → the course completes
  const done = await tr(() => {
    const ctx = window.__game.ctx, w = ctx.world, a = window.__game.getSystem('world').trainingArena;
    let knocked = 0;
    for (let i = 0; i < a.targetCount && w.training.remaining >= 0; i++) {
      const t = a.getTargetState(i);
      if (t.down) continue;
      const from = t.position.clone(); from.set(t.position.x, 1.4, t.position.z + 8);
      const dir = from.clone(); dir.set(0, 0, -1);
      const h = w.raycast(from, dir, 60);
      if (!h?.obstacle?.destructible) continue;
      h.obstacle.destructible.onDamage(60, h.point); knocked++;
    }
    let best = null; try { best = JSON.parse(localStorage.getItem('scav.training')).best; } catch {}
    return { knocked, remaining: w.training.remaining, score: w.training.score, best: w.training.bestTime, stored: best };
  });
  const fin = await lastEv('training:courseFinished');
  ok(done.knocked === 9 && done.remaining === -1 && done.score === 10, `10 knock-downs end the course (knocked ${done.knocked}, remaining ${done.remaining})`);
  ok(fin && fin.completed === true && fin.score === 10 && fin.time > 0 && fin.time < 60 && fin.best === fin.time, `training:courseFinished ${JSON.stringify(fin)}`);
  ok(done.best === fin.time && done.stored === fin.time, `best time stored in localStorage scav.training (${done.stored})`);
  await waitSim(0.2);
  const p3 = await tr(() => window.__game.ctx.interactables.all().find((i) => i.id === 'training_mode').getPrompt());
  ok(p3 === '표적 모드: 타임 코스', `after a course the console cycles on (prompt "${p3}")`);
  // second course: cycle around (static → moving → timed), wait out the cooldown, force a timeout
  const p4 = await modeIt(); await waitSim(0.05);
  const p5 = await modeIt(); await waitSim(0.05);
  const p6 = await modeIt(); await waitSim(0.05);
  ok(p4 === '표적 모드: 고정 표적' && p5 === '표적 모드: 이동 표적' && /타임 코스/.test(p6 ?? ''), `cycle 고정 → 이동 → 타임 코스 (${p4} / ${p5} / ${p6})`);
  await waitSim(3.2);   // TRAINING_COURSE_COOLDOWN_S
  const p7 = await modeIt();   // E = start
  await waitSim(0.1);
  const c2 = await tr(() => {
    const a = window.__game.getSystem('world').trainingArena, t = window.__game.ctx.world.training;
    const running = t.remaining > 0;
    a.courseEndAt = window.__game.ctx.time + 0.3;    // smoke shortcut: fast-forward the deadline instead of waiting 60 s
    return { running };
  });
  ok(c2.running && /진행 중/.test(p7 ?? ''), `E started a second course after the cooldown ("${p7}")`);
  await waitSim(0.6);
  const fin2 = await lastEv('training:courseFinished');
  const after2 = await tr(() => ({ remaining: window.__game.ctx.world.training.remaining, best: window.__game.ctx.world.training.bestTime, n: window.__ev['training:courseFinished'].length }));
  ok(after2.n === 2 && fin2.completed === false && fin2.time === 60 && fin2.score === 0 && after2.remaining === -1, `timeout ends the course (${JSON.stringify(fin2)})`);
  ok(after2.best === fin.time, `best time kept after a failed course (${after2.best})`);
  await tr(() => window.__game.ctx.world.training.setMode('static'));
  await waitSim(0.1);
  ok((await tr(() => window.__game.ctx.world.training.mode)) === 'static', 'setMode(static) accepted after the course');
  // weapon rack → 무한 상자 on the 주무기 tab
  const rack = await tr(() => {
    const ctx = window.__game.ctx;
    const n0 = window.__ev['ui:catalogToggled'].length;
    ctx.interactables.all().find((i) => i.id === 'training_rack').interact();
    const evs = window.__ev['ui:catalogToggled'].slice(n0);
    const tab = document.querySelector('.catalog .scr-tabs .active, .catalog-tabs .active, .catalog .tab.active')?.textContent ?? null;
    return { evs, open: !!ctx.inventory.isCatalogOpen, blockers: [...ctx.uiBlockers], tab };
  });
  ok(rack.evs.some((e) => e.open) && rack.open, `training_rack opens the 무한 상자 (ui:catalogToggled ${JSON.stringify(rack.evs)}, blockers ${rack.blockers.join(',')})`);
  if (rack.tab !== null) console.log(`  note catalog tab "${rack.tab}"`);
  // a weapon taken from the rack must not survive the exit restore (game/ snapshot)
  const granted = await tr(() => {
    const ctx = window.__game.ctx;
    const inst = ctx.loot.createItem('wpn_ar_g3', 1);
    const added = ctx.inventory.tryAddItem(inst);
    if (typeof ctx.inventory.closeCatalog === 'function') ctx.inventory.closeCatalog();
    if (ctx.inventory.isOpen) ctx.inventory.toggleBag();
    return { added, uid: inst.uid, count: ctx.inventory.countDefAll('wpn_ar_g3'), blockers: [...ctx.uiBlockers] };
  });
  ok(granted.added && granted.count >= 1 && granted.blockers.length === 0, `rack weapon in the bag for the rest of the training (${granted.count}), catalog closed`);

  /* ── 4. exit console ─────────────────────────────────────────────────────── */
  console.log('exit');
  await P(() => { const it = window.__game.ctx.interactables.all().find((i) => i.id === 'training_exit'); it.interact(); it.interact(); });
  await waitSim(0.2);
  const exits = (await ev('training:exitRequested')).length;
  ok(exits === 1, `training:exitRequested emitted once for a double press (${exits})`);
  let phaseAfter = await P(() => window.__game.ctx.phase);
  let handledByGame = true;
  try { await waitFor(page, () => window.__game.ctx.phase === 'hub', 'game/ returns to the ship', 4000); }
  catch { handledByGame = false; }
  phaseAfter = await P(() => window.__game.ctx.phase);
  if (!handledByGame) {
    console.log(`  note game/ did not return to the ship after training:exitRequested (phase ${phaseAfter}) — aborting + hub:enter from the script`);
    await P(() => { const b = window.__game.ctx.bus; b.emit('game:abort', {}); b.emit('hub:enter', { ship: 'personal' }); });
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub after abort');
  } else ok(true, 'game/ handled training:exitRequested → back in the ship');
  await waitSim(0.3);
  const after = await P(() => {
    const ctx = window.__game.ctx;
    return {
      phase: ctx.phase, ship: ctx.hub.ship, worldReady: ctx.world?.ready ?? false, worldMode: ctx.world?.mode,
      arena: !!ctx.scene.getObjectByName('TrainingArena'), exit: ctx.interactables.all().some((i) => i.id === 'training_exit'),
      space: ctx.scene.userData.atmosphere?.spaceMode, obstacles: ctx.world?.getObstacles().length ?? -1,
      cleared: window.__ev['world:cleared'].length, entered: window.__ev['hub:entered'].length,
    };
  });
  ok(after.phase === 'hub' && after.ship === 'personal', `back in the personal ship directly (phase ${after.phase}, ${after.ship})`);
  ok(!after.worldReady && !after.arena && !after.exit && after.obstacles === 0, 'arena disposed: world not ready, group removed, exit console unregistered, hash empty');
  ok(after.cleared >= 1 && after.entered >= 2, `world:cleared (${after.cleared}) + hub:entered (${after.entered})`);
  ok(after.space === true, 'space mode back on for the ship');
  const restored = await P((uid) => ({ count: window.__game.ctx.inventory.countDefAll('wpn_ar_g3'), item: !!window.__game.ctx.inventory.findItemAnywhere(uid), training: window.__game.ctx.world?.training ?? null }), granted.uid);
  ok(restored.count === 0 && !restored.item, `rack weapon gone after the exit restore (${restored.count})`);
  ok(restored.training === null, 'ctx.world.training null outside the arena');

  /* ── 4b. 발사 준비 패널 (Phase 10, solo personal ship) ────────────────────
     The panel appears as soon as a launch slot is filled, holds `HUB_READY_BLOCKER` + the software cursor **only**
     while WE are boarded (never `exitPointerLock`), right-click opens the modeless 분대원 장비 popup, and E
     closes the popup before it un-boards (2026-09-08: Escape is the 일시정지 메뉴 everywhere). The solo launch countdown is HUB_LAUNCH_COUNTDOWN (3 s), so this block
     un-boards well inside it. */
  console.log('발사 준비 패널');
  const readyHidden = await P(() => ({
    hidden: document.querySelector('.hub-ready')?.hidden ?? null,
    blocker: window.__game.ctx.uiBlockers.has('ready'),
  }));
  ok(readyHidden.hidden === true && !readyHidden.blocker, 'READY panel hidden with every slot empty (no blocker)');
  // 2026-09-08: 출격 준비 경고가 먼저 뜬다 (기본 지급품에는 주무기가 없다) — 확인하고 그대로 탑승한다
  await P(() => {
    window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.interact();
    const warn = document.querySelector('.launch-warn');
    if (warn && !warn.hidden) [...warn.querySelectorAll('.hub-foot .ui-btn')].find((b) => b.textContent === '그래도 출격').click();
  });
  await waitSim(0.15);
  const boarded = await P(() => {
    const root = document.querySelector('.hub-ready');
    const c0 = root?.querySelector('.hr-cell[data-slot="0"]');
    return {
      hidden: root?.hidden ?? null, cells: root?.querySelectorAll('.hr-cell').length ?? 0,
      ready: !!c0?.classList.contains('is-ready'), local: !!c0?.classList.contains('is-local'),
      name: c0?.querySelector('.hr-name')?.textContent ?? '', lv: c0?.querySelector('.hr-lv')?.textContent ?? '',
      state: c0?.querySelector('.hr-state')?.textContent ?? '',
      blocker: window.__game.ctx.uiBlockers.has('ready'), cursor: window.__game.ctx.input.isCursorMode,
      toggled: window.__ev['hub:readyPanelToggled'].slice(-1)[0] ?? null,
      inPod: window.__game.ctx.player.isInPod,
    };
  });
  ok(boarded.hidden === false && boarded.cells === 4, `boarding shows the 4-cell READY panel (${boarded.cells} cells)`);
  ok(boarded.ready && boarded.local && boarded.name.length > 0, `cell 0 is our own ready cell (${boarded.name}, ${boarded.state})`);
  ok(/^Lv\. \d+$/.test(boarded.lv), `cell 0 carries the level chip (${boarded.lv})`);
  ok(boarded.blocker && boarded.cursor === true, `boarded panel holds the 'ready' blocker + the software cursor (cursor ${boarded.cursor})`);
  ok(boarded.toggled?.open === true, 'hub:readyPanelToggled {open:true}');
  const popup = await P(() => {
    const c0 = document.querySelector('.hr-cell[data-slot="0"]');
    c0?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const p = document.querySelector('.hub-crew-loadout');
    return {
      open: p ? !p.hidden : null, name: p?.querySelector('.hcl-name')?.textContent ?? '',
      ev: window.__ev['hub:crewLoadoutToggled'].slice(-1)[0] ?? null,
      stash: !!p?.querySelector('.hcl-body .inv-stash'), credits: (p?.textContent ?? '').includes('CREDITS'),
    };
  });
  ok(popup.open === true && popup.name.length > 0, `right-click opens the 분대원 장비 popup (${popup.name})`);
  ok(popup.ev?.open === true, 'hub:crewLoadoutToggled {open:true}');
  ok(!popup.stash && !popup.credits, 'popup shows no 함선 창고 column and no credits');
  await tap('KeyE');
  await waitSim(0.15);
  const afterEsc = await P(() => ({
    open: !(document.querySelector('.hub-crew-loadout')?.hidden ?? true),
    inPod: window.__game.ctx.player.isInPod,
    ev: window.__ev['hub:crewLoadoutToggled'].slice(-1)[0] ?? null,
  }));
  ok(afterEsc.open === false && afterEsc.ev?.open === false, 'E closes the popup first');
  ok(afterEsc.inPod === true, 'the same E did NOT un-board (the popup ate it)');
  await waitSim(0.7);   // UNBOARD_GRACE: E only un-boards once the boarding press is well past
  await tap('KeyE');
  await waitSim(0.2);
  const off = await P(() => ({
    inPod: window.__game.ctx.player.isInPod, hidden: document.querySelector('.hub-ready')?.hidden ?? null,
    blocker: window.__game.ctx.uiBlockers.has('ready'), cursor: window.__game.ctx.input.isCursorMode,
    phase: window.__game.ctx.phase,
  }));
  ok(off.inPod === false && off.phase === 'hub', 'the next E un-boards (the ready token does not block it)');
  ok(off.hidden === true && !off.blocker && off.cursor === false, 'un-boarding hides the panel and releases the blocker + cursor');

  /* ── 5. shared ship terminal entry + pod lock (faked lobby, no relay) ───── */
  console.log('shared ship (faked lobby)');
  const fake = await P(() => {
    const net = window.__game.getSystem('net');
    if (!net || !('_lobby' in net)) return false;
    net._lobby = { code: 'TRAIN1', hostId: 'peer-a', isPublic: false, started: false, seed: null,
      players: [{ id: 'peer-a', name: '동료', slot: 0, ready: false, isHost: true, connected: true }] };
    window.__game.ctx.bus.emit('hub:enter', { ship: 'shared' });
    return true;
  });
  if (!fake) {
    console.log('  note NetSystem has no _lobby field — shared-ship terminal checks skipped');
  } else {
    await waitFor(page, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'shared ship');
    await waitSim(0.3);
    await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
    await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
    const readMenu = () => P(() => {
      const secs = [...document.querySelectorAll('.menu.hub-menu .hub-section')];
      const sec = secs.find((s) => s.querySelector('.ui-label')?.textContent === '시뮬레이션 훈련장');
      const btn = sec?.querySelector('button');
      const crew = [...document.querySelectorAll('.menu.hub-menu .crew-row .state')].map((n) => n.textContent);
      return { has: !!sec && !sec.hidden, label: btn?.textContent ?? null, disabled: btn?.disabled ?? null, crew };
    });
    const m0 = await readMenu();
    ok(m0.has, 'terminal has a 시뮬레이션 훈련장 section on the shared ship');
    ok(m0.label === '시작' && m0.disabled === false, `idle lobby → "${m0.label}" enabled`);
    // a member is training
    await P(() => {
      const net = window.__game.getSystem('net');
      net._lobby = { ...net._lobby, started: true, mode: 'training', players: [{ ...net._lobby.players[0], inMission: true }] };
      window.__game.ctx.bus.emit('net:lobbyUpdated', { lobby: net._lobby });
    });
    await waitSim(0.2);
    const m1 = await readMenu();
    ok(m1.label === '합류 (1명 훈련 중)' && m1.disabled === false, `training running → "${m1.label}" enabled`);
    ok(m1.crew[0] === '훈련장', `crew row shows 훈련장 (${m1.crew[0]})`);
    await tap('KeyE');   // 2026-09-08: the terminal closes on E
    await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
    await waitSim(0.2);
    const pod = await P(() => {
      const ctx = window.__game.ctx;
      const it = ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
      const n0 = window.__ev['ui:notify'].length;
      const prompt = it?.getPrompt() ?? null;
      it?.interact();
      const notes = window.__ev['ui:notify'].slice(n0).map((n) => n.text);
      return { prompt, notes, inPod: ctx.player.isInPod, status: document.querySelector('.hub-status')?.textContent ?? '' };
    });
    ok(pod.prompt === '훈련 진행 중 — 터미널에서 합류', `pod prompt "${pod.prompt}"`);
    ok(!pod.inPod && pod.notes.some((t) => /훈련 진행 중/.test(t)), `pod refuses boarding with a notice (${pod.notes.join(' | ')})`);
    ok(/훈련 진행 중/.test(pod.status), `status line "${pod.status.trim().slice(0, 40)}"`);
    // a raid is running instead
    await P(() => {
      const net = window.__game.getSystem('net');
      net._lobby = { ...net._lobby, mode: 'raid', players: [{ ...net._lobby.players[0], ready: true }] };
      window.__game.ctx.bus.emit('net:lobbyUpdated', { lobby: net._lobby });
    });
    await waitSim(0.2);
    // Phase 10: a REMOTE member filling a slot shows the panel but must not steal our mouse look — the blocker and
    // the software cursor are only taken while WE are boarded.
    const remoteReady = await P(() => {
      const root = document.querySelector('.hub-ready');
      const c0 = root?.querySelector('.hr-cell[data-slot="0"]');
      return {
        hidden: root?.hidden ?? null, ready: !!c0?.classList.contains('is-ready'),
        local: !!c0?.classList.contains('is-local'), name: c0?.querySelector('.hr-name')?.textContent ?? '',
        interactive: !!root?.classList.contains('interactive'),
        blocker: window.__game.ctx.uiBlockers.has('ready'), cursor: window.__game.ctx.input.isCursorMode,
      };
    });
    ok(remoteReady.hidden === false && remoteReady.ready && !remoteReady.local && remoteReady.name === '동료',
      `a ready squadmate fills their READY cell (${remoteReady.name})`);
    ok(!remoteReady.interactive && !remoteReady.blocker && remoteReady.cursor === false,
      'the panel stays non-interactive while we walk the ship (no blocker, no cursor)');
    await page.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
    await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open (raid)');
    const m2 = await readMenu();
    ok(m2.label === '임무 진행 중' && m2.disabled === true, `raid running → "${m2.label}" disabled`);
    const refused = await P(() => { const n0 = window.__ev['ui:notify'].length; const r = window.__game.getSystem('hub').startTraining(); return { r, notes: window.__ev['ui:notify'].slice(n0).map((n) => n.text) }; });
    ok(refused.r === false && refused.notes.some((t) => /임무 진행 중/.test(t)), `startTraining refused during a raid (${refused.notes.join(' | ')})`);
    await tap('KeyE');
    await P(() => { window.__game.getSystem('net')._lobby = null; });
  }
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}
const realErrors = errors.filter((e) => !/WebSocket/.test(e));
console.log(`\n${pass} passed, ${fail} failed, ${realErrors.length} console errors${errors.length !== realErrors.length ? ` (+${errors.length - realErrors.length} WebSocket/no-relay)` : ''}`);
for (const e of realErrors.slice(0, 10)) console.log('  err', e.slice(0, 300));
process.exit(fail === 0 && realErrors.length === 0 ? 0 : 1);
