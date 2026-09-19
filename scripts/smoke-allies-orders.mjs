// Single-player smoke for android orders (src/allies): move / caution pings from the leader, the first-one-wins
// request rule, heal / ammo delivery conditions, the "I have none" chat line, container looting that stops when a
// player opens the box, and the extract ping → confirm → console press chain.
// Parts that need another folder's contract member (ally bag, loot containers, extraction pads) are skipped —
// not failed — while that member is missing, so this stays green during the parallel build.
// Usage: node scripts/smoke-allies-orders.mjs [http://localhost:5273]   (needs `npm run dev`)
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

let pass = 0, fail = 0, skip = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const skipped = (label, why) => { skip++; console.log(`  skip ${label} (${why})`); };
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
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  // A single-player smoke never needs the relay; a refused /ws is the environment, not this folder.
  const relayNoise = (t) => /WebSocket|\/ws\?/.test(String(t));
  page.on('console', (m) => { if (m.type() === 'error' && !relayNoise(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.allies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['ally:ping', 'ally:chat', 'ally:rosterChanged']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__pingId = 1;
    // `label` is the **display string** (`보급 상자 (n등급)`), `containerId` the loot-container id a crate ping
    // carries — allies/ acts on the id alone (2026-09-19, TODO B-61). Passing the id as the label the way this
    // helper used to is what hid the bug from this smoke.
    window.__ping = (kind, x, z, owner = null, label, enemyId, containerId) => {
      const ctx = window.__game.ctx;
      const V = ctx.player.position.constructor;
      const y = ctx.world ? ctx.world.getHeightAt(x, z) : 0;
      ctx.bus.emit('ping:placedV3', { id: window.__pingId++, position: new V(x, y, z), kind, expires: ctx.time + 30, owner, label, enemyId, containerId });
    };
    window.__comms = (id, text) => {
      const ctx = window.__game.ctx;
      ctx.bus.emit('comms:sent', { id, text: text ?? id, by: null, byName: '나', slot: 0, position: ctx.player.position.clone() });
    };
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const ev = (n) => P((k) => window.__ev[k], n);
  const resetEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; });
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const info = (id) => P((i) => window.__game.getSystem('allies').debugInfo(i), id);
  /** Wait until the FSM settled on `state` (a transition costs ALLY_REACT_MIN_S…MAX_S of reaction delay). */
  const waitState = async (id, state, secs = 6) => {
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 4000) {
      const s = await info(id);
      if (s && s.state === state) return true;
      await waitSim(0.3);
    }
    return false;
  };

  const K = await P(async () => {
    const s = await import('/src/shared/index.ts');
    return {
      localId: s.androidIdOf('local', 0), arrive: s.ALLY_MOVE_ARRIVE_M, watchS: s.ALLY_WATCH_S,
      cooldown: s.ALLY_REQUEST_COOLDOWN_S, confirm: s.ALLY_EXTRACT_CONFIRM_S, reach: s.ALLY_LOOT_REACH_M,
      deliverRange: s.ALLY_DELIVER_RANGE_M,
    };
  });

  /* ── setup: one cheat android in a solo raid, no ambient enemies ──────── */
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.allies.devSetAndroid(true));
  await P(() => { const ctx = window.__game.ctx; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: 9137 }); });
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 20000);
  await waitFor(page, (id) => { const b = window.__game.ctx.allies.getBody(id); return !!b && !b.hidden; }, 'ally lands', 30000, K.localId);
  await P(() => { const s = window.__game.getSystem('enemies'); s.training = true; for (const e of [...s.active]) s.despawn(e); });
  const hasBag = await P((id) => { const l = window.__game.ctx.allies.getLoadout(id); return !!l && l.cols > 0; }, K.localId);

  /* ── 1. leader move ping → walks there ───────────────────────────────── */
  console.log('leader pings 저쪽으로 가자 → the android walks there');
  const dest = await P((id) => {
    const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
    const b = ctx.allies.getBody(id);
    const x = b.position.x + 14, z = b.position.z;
    void sys;
    window.__ping('attack', x, z);
    return { x, z, d0: Math.hypot(x - b.position.x, z - b.position.z) };
  }, K.localId);
  ok(await waitState(K.localId, 'moveTo', 6), 'state becomes moveTo after the reaction delay');
  await waitSim(10);
  const arrived = await P((a) => {
    const b = window.__game.ctx.allies.getBody(a.id);
    return Math.hypot(b.position.x - a.x, b.position.z - a.z);
  }, { id: K.localId, x: dest.x, z: dest.z });
  ok(arrived < dest.d0 - 4, `it closed the distance (${dest.d0.toFixed(0)} m → ${arrived.toFixed(0)} m)`);

  /* ── 2. leader caution ping → watch, and it keeps away ───────────────── */
  console.log('leader pings 저쪽 조심해 → watch (looks there, does not go there)');
  const caution = await P((id) => {
    const ctx = window.__game.ctx;
    const b = ctx.allies.getBody(id);
    const x = b.position.x + 10, z = b.position.z + 2;
    window.__ping('caution', x, z);
    return { x, z };
  }, K.localId);
  ok(await waitState(K.localId, 'watch', 6), 'state becomes watch');
  await waitSim(4);
  const keptOut = await P((c) => {
    const b = window.__game.ctx.allies.getBody(c.id);
    return { d: Math.hypot(b.position.x - c.x, b.position.z - c.z), look: !!b.lookAt };
  }, { id: K.localId, x: caution.x, z: caution.z });
  ok(keptOut.look, 'it looks at the caution point');
  ok(keptOut.d > 4, `it does not walk onto it (${keptOut.d.toFixed(1)} m away)`);

  /* ── 3. request with nothing in the bag → one chat line ──────────────── */
  console.log('shield request with no charger → it says so once');
  await P(() => { const s = window.__game.getSystem('allies'); s.watchUntil = -Infinity; s.orderKind = null; s.requestBlockedUntil = -Infinity; });
  await resetEv();
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.bus.emit('inventory:itemRequested', { kind: 'shield', defId: null, ammoType: null, position: ctx.player.position.clone() });
  });
  await waitSim(1.5);
  const chats = await ev('ally:chat');
  ok(chats.some((c) => c.text.includes('실드 충전기가 없다')), 'chat: 실드 충전기가 없다.', JSON.stringify(chats));

  /* ── 4. first request wins, the next is ignored for the cooldown ─────── */
  console.log('first request wins; later ones are ignored for ALLY_REQUEST_COOLDOWN_S');
  await P(() => { const s = window.__game.getSystem('allies'); s.requestBlockedUntil = -Infinity; s.request = null; });
  const both = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
    ctx.bus.emit('inventory:itemRequested', { kind: 'heal', defId: null, ammoType: null, position: ctx.player.position.clone() });
    const first = sys.request ? sys.request.kind : null;
    ctx.bus.emit('inventory:itemRequested', { kind: 'ammo', defId: null, ammoType: null, position: ctx.player.position.clone() });
    const second = sys.request ? sys.request.kind : null;
    return { first, second, blocked: sys.requestBlockedUntil > ctx.time };
  });
  ok(both.first === 'heal', 'the first request is taken', JSON.stringify(both));
  ok(both.second === 'heal' || both.second === null, 'the second request does not replace it', JSON.stringify(both));
  ok(both.blocked, `the squad-wide cooldown (${K.cooldown} s) is armed`);

  /* ── 5. heal delivery: ping → come close → drop while the leader stands still ── */
  console.log('heal request with a found stim → ping, approach, drop');
  if (!hasBag) skipped('heal delivery', 'InventoryRef.createAllyBag not implemented yet');
  else {
    const gave = await P((id) => window.__game.getSystem('allies').debugGive(id, 'heal_bandage', 3), K.localId);
    ok(gave, 'the android carries a raid-found stim');
    await P((id) => {
      const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
      const b = ctx.allies.getBody(id);
      // stand the android a few metres from the player so the walk is short
      sys.debugTeleport(id, ctx.player.position.x + 8, b.position.y, ctx.player.position.z);
      sys.request = null; sys.requestBlockedUntil = -Infinity; sys.watchUntil = -Infinity; sys.orderKind = null;
      window.__pickups0 = ctx.pickups ? ctx.pickups.getPickups().length : 0;
    }, K.localId);
    await resetEv();
    await P(() => {
      const ctx = window.__game.ctx;
      ctx.bus.emit('inventory:itemRequested', { kind: 'heal', defId: null, ammoType: null, position: ctx.player.position.clone() });
    });
    ok(await waitState(K.localId, 'deliver', 8), 'state becomes deliver');
    const itemPing = await waitFor(page, () => window.__ev['ally:ping'].some((p) => p.kind === 'item'), 'item ping', 30000).catch(() => false);
    ok(!!itemPing, 'it pings the item it will hand over');
    await waitSim(14);           // the player never moves, so the "stopped" condition holds
    const after = await P(() => (window.__game.ctx.pickups ? window.__game.ctx.pickups.getPickups().length : 0));
    const dropped = after > (await P(() => window.__pickups0));
    ok(dropped, `it dropped the stim in front of the requester (${after} pickups)`);
    const st = await info(K.localId);
    ok(st.task === null, 'the request is finished', JSON.stringify(st));
  }

  /* ── 6. container looting stops when a player opens the box ──────────── */
  console.log('crate ping → loot; a player opening it stops the android');
  const boxes = await P(() => (window.__game.ctx.world.getLootContainers ? window.__game.ctx.world.getLootContainers().length : -1));
  if (boxes < 0) skipped('container looting', 'WorldRef.getLootContainers not implemented yet');
  else if (boxes === 0) skipped('container looting', 'this map rolled no loot containers');
  else {
    const box = await P((id) => {
      const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
      const b = ctx.allies.getBody(id);
      let best = null;
      for (const c of ctx.world.getLootContainers()) {
        const d = Math.hypot(c.position.x - b.position.x, c.position.z - b.position.z);
        if (!best || d < best.d) best = { id: c.id, tier: c.tier, x: c.position.x, y: c.position.y, z: c.position.z, d };
      }
      if (!best) return null;
      // put the android and the leader next to it so the harness holds and the walk is short
      sys.debugTeleport(id, best.x + 4, best.y, best.z);
      ctx.player.teleport(new ctx.player.position.constructor(best.x + 6, best.y, best.z));
      sys.request = null; sys.requestBlockedUntil = -Infinity; sys.watchUntil = -Infinity; sys.orderKind = null;
      // exactly as `ui/hud/Pings` sends it: a display label, and the container id beside it
      window.__ping('crate', best.x, best.z, null, `보급 상자 (${best.tier}등급)`, undefined, best.id);
      return best;
    }, K.localId);
    if (!box) skipped('container looting', 'no container found near the android');
    else {
      ok(await waitState(K.localId, 'loot', 8), 'state becomes loot');
      const latched = await P((id) => window.__game.getSystem('allies').byId.get(id).lootContainerId, K.localId);
      ok(latched === box.id, 'it latched onto the **pinged** container id', `${latched} vs ${box.id}`);
      await waitSim(6);
      const took = await info(K.localId);
      if (!hasBag) skipped('it takes a stack out of the box', 'ally bag missing');
      else ok(took.items.length > 0, `it took something (${JSON.stringify(took.items)})`);
      await P((id) => window.__game.ctx.bus.emit('inventory:containerViewed', { containerId: id }), box.id);
      await waitSim(3);
      const left = await info(K.localId);
      ok(left.state !== 'loot' || (await P((id) => window.__game.getSystem('allies').byId.get(id).lootContainerId, K.localId)) !== box.id,
        'it stops looting the box a player opened', JSON.stringify(left));
    }
  }

  /* ── 6b. an item ping on the ground becomes a pickup job ───────── */
  // 2026-09-19 (TODO B-61): an `'item'` ping carries no defId, and `canFulfil` used to answer it with `!!defId`,
  // so **every** item ping died on `건넬 만한 물건이 없다.` and the pickup branch in `parts/Loot` was unreachable.
  console.log('item ping on a dropped thing → it walks over and picks it up');
  if (!hasBag) skipped('item ping → pickup', 'InventoryRef.createAllyBag not implemented yet');
  else {
    const drop = await P((id) => {
      const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
      if (!ctx.pickups || !ctx.loot) return null;
      const b = ctx.allies.getBody(id);
      const V = ctx.player.position.constructor;
      // a thing on the ground 6 m from the android, with the leader beside it so the harness holds
      const at = new V(b.position.x + 6, b.position.y, b.position.z);
      at.y = ctx.world ? ctx.world.getSurfaceY(at.x, at.z, b.position.y) : b.position.y;
      const item = ctx.loot.createItem('heal_bandage', 2);
      if (!item) return null;
      ctx.player.teleport(new V(at.x + 3, at.y, at.z));
      sys.request = null; sys.requestBlockedUntil = -Infinity; sys.watchUntil = -Infinity; sys.orderKind = null;
      const before = ctx.allies.getLoadout(id);
      window.__itemsBefore = before ? before.items.length : 0;
      ctx.pickups.spawn(item, at);
      return { x: at.x, y: at.y, z: at.z };
    }, K.localId);
    if (!drop) skipped('item ping → pickup', 'PickupsRef / LootRef not available');
    else {
      await resetEv();
      await P((p) => window.__ping('item', p.x, p.z), drop);
      const became = await waitState(K.localId, 'pickup', 8);
      ok(became, 'state becomes pickup (the ping is a job, not a `건넬 만한 물건이 없다.` line)');
      const refused = await P(() => window.__ev['ally:chat'].some((c) => /건넬 만한/.test(c.text || '')));
      ok(!refused, 'it does not answer an item ping with the 「nothing to hand over」 line');
      await waitSim(10);
      const got = await info(K.localId);
      ok(got.items.length > (await P(() => window.__itemsBefore)), `it picked the thing up (${JSON.stringify(got.items)})`);
      ok(got.task === null, 'the job is finished', JSON.stringify(got));
    }
  }

  /* ── 7. extract ping → confirm → console press ───────────────────────── */
  console.log('탈출하고 싶다 twice → it walks to the pad and presses the console');
  const pads = await P(() => (window.__game.ctx.extraction && window.__game.ctx.extraction.getPads ? window.__game.ctx.extraction.getPads().length : -1));
  if (pads < 0) skipped('extract ping → confirm → activate', 'ExtractionRef.getPads not implemented yet');
  else if (pads === 0) skipped('extract ping → confirm → activate', 'no extraction pads on this map');
  else {
    await P((id) => {
      const ctx = window.__game.ctx; const sys = window.__game.getSystem('allies');
      const pad = ctx.extraction.getPads()[0];
      // stand everyone next to the pad and reveal it (undiscovered = does not exist, fog rule)
      if (ctx.world.fog) ctx.world.fog.reveal(pad.position.x, pad.position.z, 40);
      // right next to the console: the confirm window is ALLY_EXTRACT_CONFIRM_S of real time, and a loaded
      // lane runs the simulation far slower than the wall clock — a long walk would race that window.
      sys.debugTeleport(id, pad.position.x + 3, pad.position.y, pad.position.z);
      ctx.player.teleport(new ctx.player.position.constructor(pad.position.x + 5, pad.position.y, pad.position.z));
      sys.request = null; sys.requestBlockedUntil = -Infinity; sys.watchUntil = -Infinity; sys.orderKind = null;
      // the looted stacks would make it 조금 무거움 and fire the weight-driven extract ping, which is a different rule
      const body = sys.byId.get(id);
      if (body.bag) body.bag.clear();
      body.lightPingDone = true; body.heavyPingArmed = false; body.extractPadId = null;
    }, K.localId);
    await resetEv();
    await P(() => window.__comms('extract', '탈출해야 한다!'));
    const padPing = await waitFor(page, (id) => {
      const s2 = window.__game.getSystem('allies').byId.get(id);
      return !!s2 && !!s2.extractPadId && window.__ev['ally:ping'].some((p) => p.kind === 'extraction');
    }, 'pad ping', 60000, K.localId).catch(() => false);
    ok(!!padPing, 'it pings the extraction pad it found');
    await P(() => { const s = window.__game.getSystem('allies'); s.requestBlockedUntil = -Infinity; });
    await P(() => window.__comms('extract', '탈출해야 한다!'));
    const called = await waitFor(page, () => window.__game.ctx.extraction.stage !== 'idle', 'extraction called', 120000).catch(() => false);
    ok(!!called, `the second call within ${K.confirm} s makes it press the console (stage ${await P(() => window.__game.ctx.extraction.stage)})`);
  }

  ok(errors.length === 0, 'no page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL ${e && e.message ? e.message : e}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} ok, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
