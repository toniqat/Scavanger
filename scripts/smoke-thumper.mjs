// Smoke: 진동 장치 (thumper — 2026-09-15 땅굴벌레, docs/DECISIONS.md 「2026-09-15 — 땅굴벌레 · 진동 장치」). Solo raid.
//
// - catalogue: `gad_thumper` → `GadgetId 'thumper'` (place · deployable `thumper` · no recover), listed in `getDefs`, quick-usable,
//   **does not stack** (`stackMax` 1 — 2026-09-16 사용자 결정: 제작법 없는 드랍 전용)
// - placement judgement: only where `world.burrowGroundOk(x, z, THUMPER_GROUND_R)` — the ghost preview (`ctx.gadgets.placement`) and
//   `use()` share it; on a structure roof the preview is red with the burrow reason and `use()` refuses without consuming the item.
//   When world has not published `burrowGroundOk` yet (parallel development) the script stubs it — true on bare terrain, false inside
//   any structure radius — and says so; the gadget side is tested either way.
// - strikes: every THUMPER_INTERVAL_S (1 s) on every client from the deployable's age — `thumper_thump` on the bus, `camera:shake`
//   for the nearby player; the 5th strike emits `sandworm:summon {source:'thumper'}` exactly once at the device; it keeps thumping
//   afterwards (7 strikes → still one summon).
// - not recoverable: no interactable, `recover()` null; one item consumed per placement.
// - `sandworm:erupted` inside its radius destroys it (`gadget:removed destroyed`), outside leaves it; a second one can be placed after.
// - wire: `wireOf(d).age` carries the phase for replicas.
//
// Usage: node scripts/smoke-thumper.mjs [http://localhost:5273/]
// Timing: headless dt is clamped to 50 ms — every wait is on `ctx.time` (sim seconds), never wall time.
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
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};
const note = (label) => console.log(`  --   ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* the burrow reason string of gadgets/parts/Preview (R_BURROW) — the UI prints it verbatim */
const R_BURROW = '땅굴벌레가 파고들 수 없는 땅이다';

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // solo raid: park the relay too so a server profile cannot land mid-run
  await quietViteHmr(page, { parkRelay: true });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game?.ctx?.inventory && !!window.__game.ctx.gadgets, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    // fake pointer lock so gameplay input is accepted
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
  });
  const waitSim = async (sec) => {
    const t0 = await page.evaluate(() => window.__game.ctx.time);
    await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec);
  };

  /* ── catalogue / contract ─────────────────────────────────────────── */
  const cat = await page.evaluate(() => {
    const { loot, gadgets } = window.__game.ctx;
    const item = loot.getItemDef('gad_thumper');
    const def = gadgets.getDef('thumper');
    return {
      item: item ? { gadgetId: item.gadgetId, w: item.width, h: item.height, stack: item.stackMax, quick: item.quickUsable, cat: item.category, rarity: item.rarity } : null,
      def: def ? { use: def.use, dep: def.deployable, recover: def.recoverTime, hp: def.hp, radius: def.radius, name: def.name } : null,
      listed: gadgets.getDefs().some((d) => d.id === 'thumper'),
    };
  });
  ok(cat.item && cat.item.gadgetId === 'thumper' && cat.item.cat === 'gadget' && cat.item.quick === true, `items.csv gad_thumper → gadgetId thumper, quick-usable (${JSON.stringify(cat.item)})`);
  /* 2026-09-16 (사용자 결정): 진동 장치는 **겹치지 않는다** — 제작법이 없는 드랍 전용 물건이라 한 칸에 하나다. */
  ok(cat.item && cat.item.w === 1 && cat.item.h === 2 && cat.item.stack === 1 && cat.item.rarity === 'rare', `1×2, does not stack (${cat.item?.stack}), rare`);
  ok(cat.def && cat.def.use === 'place' && cat.def.dep === 'thumper' && cat.def.recover === 0 && cat.def.hp > 0 && cat.def.radius > 0, `GadgetDef thumper: place · deployable thumper · recoverTime 0 (not recoverable) · hp ${cat.def?.hp} · radius ${cat.def?.radius}`);
  ok(cat.listed && cat.def?.name === '진동 장치', `listed in getDefs as 「${cat.def?.name}」`);
  const GROUND_R = cat.def?.radius ?? 3;   // = THUMPER_GROUND_R (GadgetDef.radius is that value)

  /* ── mission ──────────────────────────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await page.evaluate(() => window.__game.ctx.bus.emit('game:newMission', { seed: 42 }));
  await waitFor(page, () => { const c = window.__game.ctx; return c.world?.ready && c.isGameplayPhase() && c.player?.isDropping === false; }, 'mission + drop-in');
  await waitSim(0.5);

  const realJudge = await page.evaluate(() => {
    const ctx = window.__game.ctx, w = ctx.world;
    window.__ev = { deployed: [], removed: [], summon: [], thump: [], shake: [], erupted: [], notify: [] };
    ctx.bus.on('gadget:deployed', (e) => window.__ev.deployed.push({ id: e.id, kind: e.kind, t: ctx.time, p: [e.position.x, e.position.y, e.position.z] }));
    ctx.bus.on('gadget:removed', (e) => window.__ev.removed.push({ id: e.id, kind: e.kind, reason: e.reason, t: ctx.time }));
    ctx.bus.on('sandworm:summon', (e) => window.__ev.summon.push({ source: e.source, p: [e.position.x, e.position.y, e.position.z], t: ctx.time }));
    ctx.bus.on('sandworm:erupted', (e) => window.__ev.erupted.push({ id: e.id, r: e.radius, t: ctx.time }));
    ctx.bus.on('audio:play', (e) => { if (e.id === 'thumper_thump') window.__ev.thump.push({ t: ctx.time }); });
    ctx.bus.on('camera:shake', (e) => window.__ev.shake.push({ i: e.intensity, t: ctx.time }));
    ctx.bus.on('ui:notify', (n) => window.__ev.notify.push(n.text));
    // the legendary bag carries plenty of quick slots
    const bag = ctx.loot.createItem('bag_legendary', 1);
    ctx.inventory.tryAddItem(bag);
    ctx.inventory.equip(bag.uid, 'bag');
    const real = typeof w.burrowGroundOk === 'function';
    if (!real) {
      // parallel development: world has not published the judgement yet — stand in for it (bare terrain ok, any structure radius not)
      const structs = w.getStructures().map((s) => ({ x: s.position.x, z: s.position.z, r: (s.radius ?? 12) + 2 }));
      w.burrowGroundOk = (x, z, r) => !structs.some((s) => Math.hypot(x - s.x, z - s.z) < s.r + r);
    }
    window.__count = () => ctx.inventory.countDefAll('gad_thumper');
    window.__thumpers = () => window.__game.getSystem('gadgets').deployables.filter((d) => d.kind === 'thumper').map((d) => ({ id: d.id, strikes: d.strikes, summoned: d.summoned, age: d.age, p: [d.position.x, d.position.y, d.position.z] }));
    return real;
  });
  if (realJudge) note('world.burrowGroundOk is published — the real judgement is used');
  else note('world.burrowGroundOk not published yet — stubbed (bare terrain true, inside a structure radius false)');

  /* 겹치지 않는 물건이라 한 번 놓으면 손이 빈다 — 매번 새로 한 개를 빠른 칸에 넣고 다시 든다. */
  const needTake = async () => await page.evaluate(() => window.__game.ctx.weapons.remoteState.heldItemId !== 'gad_thumper' || window.__count() < 1);
  /** Put one thumper into a quick slot and take it into the hand. */
  const takeInHand = async () => {
    const slot = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const it = ctx.loot.createItem('gad_thumper', 1);
      if (!ctx.inventory.tryAddItem(it)) return -2;
      const n = ctx.inventory.getQuickSlots().length;
      for (let i = 0; i < n; i++) if (ctx.inventory.setQuickSlot(i, it.uid)) return i;
      return -1;
    });
    if (slot < 0) return { slot, held: null };
    await waitSim(0.3);
    await page.evaluate((i) => window.__game.getSystem('weapons').equipQuick(i), slot);
    await waitSim(0.5);
    const held = await page.evaluate(() => window.__game.ctx.weapons.remoteState.heldItemId);
    return { slot, held };
  };

  /* ── 1. a spot of bare ground, preview green, placement ───────────── */
  const spot = await page.evaluate((R) => {
    const ctx = window.__game.ctx, w = ctx.world, sp = w.getPlayerSpawn();
    // the preview lands up to 6 m ahead of the feet: ask for a wide disc so the whole reach is burrowable
    for (let r = 0; r <= 80; r += 4) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
        if (!w.isInsideBounds(x, z)) continue;
        if (!w.burrowGroundOk(x, z, R + 7)) continue;
        return { x, z, y: w.getHeightAt(x, z) };
      }
    }
    return null;
  }, GROUND_R);
  ok(!!spot, `found bare ground for the device (${spot ? `${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}` : 'none'})`);
  if (!spot) throw new Error('no burrowable spot near the spawn');
  await page.evaluate((s) => {
    const ctx = window.__game.ctx;
    ctx.player.respawnAt(new (ctx.player.position.constructor)(s.x, s.y, s.z), 0);
    ctx.player.heal(1000);
  }, spot);
  await waitSim(0.6);
  const hand = await takeInHand();
  ok(hand.held === 'gad_thumper', `thumper taken into the hand (slot ${hand.slot}, held ${hand.held})`);
  const before = await page.evaluate(() => window.__count());
  const pv = await page.evaluate(() => { const p = window.__game.ctx.gadgets.placement; return p ? { gadget: p.gadget, kind: p.kind, valid: p.valid, reason: p.reason, mount: p.mount } : null; });
  ok(pv && pv.gadget === 'thumper' && pv.kind === 'thumper', `placement preview is live for the thumper (${JSON.stringify(pv)})`);
  ok(pv && pv.valid === true && pv.reason === null, `preview green on bare ground (${pv?.reason ?? 'ok'})`);
  const placed = await page.evaluate(() => {
    const ctx = window.__game.ctx;
    const n0 = window.__ev.notify.length;
    const t = ctx.time;
    const used = ctx.gadgets.use('thumper', false);
    return { used, t, notes: window.__ev.notify.slice(n0), dep: window.__ev.deployed.filter((d) => d.t >= t) };
  });
  ok(placed.used === true && placed.dep.length === 1 && placed.dep[0].kind === 'thumper', `use('thumper') placed one thumper (${placed.used}; ${placed.notes.join(' / ') || 'no denial'})`);
  const after = await page.evaluate(() => window.__count());
  ok(after === before - 1, `one item consumed on placement (${before} → ${after})`);
  const A = placed.dep[0];
  if (!A) throw new Error('no thumper deployed');
  const dA = Math.hypot(A.p[0] - spot.x, A.p[2] - spot.z);
  ok(dA < 8 && Math.abs(A.p[1] - (await page.evaluate((p) => window.__game.ctx.world.getSurfaceY(p[0], p[2], p[1] + 0.3), A.p))) < 0.1, `device stands on the surface ${dA.toFixed(1)} m from the player`);

  /* ── 2. not recoverable ───────────────────────────────────────────── */
  const rec = await page.evaluate((id) => {
    const ctx = window.__game.ctx;
    return { inter: ctx.interactables.all().some((i) => i.id === `gadget:${id}`), rec: ctx.gadgets.recover(id), still: window.__thumpers().some((d) => d.id === id) };
  }, A.id);
  ok(rec.inter === false && rec.rec === null && rec.still, 'no recover prompt, recover() null, device stays');

  /* ── 3. strikes every second, the 5th summons once, then it keeps going ── */
  await waitSim(5.4);
  const s5 = await page.evaluate((t) => ({ th: window.__thumpers(), thump: window.__ev.thump.filter((e) => e.t >= t).length, shake: window.__ev.shake.filter((e) => e.t >= t && e.i > 0).length, summon: window.__ev.summon.slice() }), placed.t);
  const A5 = s5.th.find((d) => d.id === A.id);
  ok(A5 && A5.strikes >= 5 && A5.strikes <= 6, `5 strikes after 5.4 s (strikes ${A5?.strikes}, age ${A5?.age?.toFixed(2)})`);
  ok(s5.thump >= 5 && s5.thump === (A5?.strikes ?? -1), `thumper_thump once per strike (${s5.thump})`);
  ok(s5.shake >= 5, `camera:shake for the player standing beside it (${s5.shake})`);
  ok(s5.summon.length === 1 && s5.summon[0].source === 'thumper', `sandworm:summon emitted exactly once, source thumper (${s5.summon.length})`);
  if (s5.summon[0]) {
    const dd = Math.hypot(s5.summon[0].p[0] - A.p[0], s5.summon[0].p[2] - A.p[2]);
    ok(dd < 0.01, `summon position is the device (${dd.toFixed(3)} m)`);
    ok(s5.summon[0].t - placed.t >= 4.9 && s5.summon[0].t - placed.t < 5.5, `summon on the 5th strike, ${(s5.summon[0].t - placed.t).toFixed(2)} s after placement`);
  }
  ok(A5?.summoned === true, 'device remembers it summoned');
  await waitSim(2.1);
  const s7 = await page.evaluate(() => ({ th: window.__thumpers(), summon: window.__ev.summon.length, thump: window.__ev.thump.length, erupted: window.__ev.erupted.length, removed: window.__ev.removed.slice() }));
  const A7 = s7.th.find((d) => d.id === A.id);
  const gone = s7.removed.find((r) => r.id === A.id);
  if (A7) ok(A7.strikes >= 7 && s7.summon === 1, `keeps thumping after the summon (strikes ${A7.strikes}), still one summon`);
  else ok(gone && gone.reason === 'destroyed' && s7.erupted > 0, `the real worm erupted (${s7.erupted}) and destroyed the device (${gone?.reason}) — still one summon (${s7.summon})`);

  /* ── 4. eruption destroys only devices inside its radius ──────────── */
  if (A7) {
    const far = await page.evaluate((a) => {
      const ctx = window.__game.ctx, V = ctx.player.position.constructor;
      const t = ctx.time;
      ctx.bus.emit('sandworm:erupted', { id: 0, position: new V(a.p[0] + 40, a.p[1], a.p[2]), radius: 12 });
      return { still: window.__thumpers().some((d) => d.id === a.id), removed: window.__ev.removed.filter((r) => r.t >= t && r.id === a.id) };
    }, A);
    ok(far.still && far.removed.length === 0, 'an eruption 40 m away leaves it');
    const near = await page.evaluate((a) => {
      const ctx = window.__game.ctx, V = ctx.player.position.constructor;
      const t = ctx.time;
      ctx.bus.emit('sandworm:erupted', { id: 0, position: new V(a.p[0] + 3, a.p[1], a.p[2] - 2), radius: 12 });
      return { still: window.__thumpers().some((d) => d.id === a.id), removed: window.__ev.removed.filter((r) => r.t >= t && r.id === a.id) };
    }, A);
    ok(!near.still && near.removed.length === 1 && near.removed[0].reason === 'destroyed', `an eruption 3.6 m away destroys it (${near.removed[0]?.reason})`);
  }

  /* ── 5. placing again after the worm appeared is allowed; wire carries age ── */
  await page.evaluate((s) => {
    const ctx = window.__game.ctx;
    ctx.player.respawnAt(new (ctx.player.position.constructor)(s.x, s.y, s.z), 0);
    ctx.player.heal(1000);
    ctx.player.setBurning?.(0, 0);
  }, spot);
  await waitSim(0.8);
  if (await needTake()) await takeInHand();
  const again = await page.evaluate(() => {
    const ctx = window.__game.ctx, g = window.__game.getSystem('gadgets');
    const t = ctx.time;
    const used = ctx.gadgets.use('thumper', false);
    const d = g.deployables.find((x) => x.kind === 'thumper' && window.__ev.deployed.some((e) => e.id === x.id && e.t >= t));
    const w = d ? g.wireOf(d) : null;
    return { used, wire: w ? { kind: w.kind, age: w.age, hp: w.hp, maxHp: w.maxHp, armed: w.armed, ttl: w.ttl } : null };
  });
  ok(again.used === true && again.wire?.kind === 'thumper', `a second thumper can be placed after the worm was called (${again.used})`);
  ok(again.wire && typeof again.wire.age === 'number' && again.wire.armed === true && again.wire.ttl === 0 && again.wire.maxHp === cat.def.hp, `wire carries age ${again.wire?.age} · armed · no expiry · maxHp ${again.wire?.maxHp}`);

  /* ── 6. refused on a structure roof (preview red with the burrow reason, nothing consumed) ── */
  const roof = await page.evaluate(() => {
    const ctx = window.__game.ctx, w = ctx.world;
    for (const s of w.getStructures()) {
      for (const [ox, oz] of [[1.3, 0.7], [-1.1, 1.4], [0.6, -1.6], [2.2, 0], [0, 0]]) {
        const x = s.position.x + ox, z = s.position.z + oz;
        const terrain = w.getHeightAt(x, z), top = w.getSurfaceY(x, z);
        if (top - terrain < 2.5) continue;
        ctx.player.respawnAt(new (ctx.player.position.constructor)(x, top, z), 0);
        return { kind: s.kind, x, z, top, terrain };
      }
    }
    return null;
  });
  ok(!!roof, `stood on a structure roof (${roof ? `${roof.kind}, roof ${roof.top.toFixed(2)} / terrain ${roof.terrain.toFixed(2)}` : 'none'})`);
  if (roof) {
    await waitSim(0.8);
    if (await needTake()) await takeInHand();
    const pvR = await page.evaluate(() => { const p = window.__game.ctx.gadgets.placement; return p ? { gadget: p.gadget, valid: p.valid, reason: p.reason } : null; });
    ok(pvR && pvR.gadget === 'thumper' && pvR.valid === false, `preview red on the roof (${pvR?.reason})`);
    ok(pvR?.reason === R_BURROW, `refusal reason is the burrow one: 「${pvR?.reason}」`);
    const cnt0 = await page.evaluate(() => window.__count());
    const refused = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const n0 = window.__ev.notify.length, t = ctx.time;
      const used = ctx.gadgets.use('thumper', false);
      return { used, notes: window.__ev.notify.slice(n0), dep: window.__ev.deployed.filter((d) => d.t >= t).length };
    });
    const cnt1 = await page.evaluate(() => window.__count());
    ok(refused.used === false && refused.dep === 0 && cnt1 === cnt0, `use() refused on the roof, nothing consumed (${cnt0} → ${cnt1}; ${refused.notes.join(' / ')})`);
    ok(refused.notes.includes(R_BURROW), 'denial toast carries the same reason');
  }

  ok(errors.length === 0, 'no console errors', errors.slice(0, 6).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  if (errors.length) console.log(`  console errors: ${errors.slice(0, 8).join(' | ')}`);
} finally {
  await closeBrowser(browser);
}
console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
