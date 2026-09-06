// Single-player smoke test for Phase 3 ship calls (src/stratagems): G tap/wheel, ground + top-view targeting, effects.
// Usage: node scripts/smoke-stratagems.mjs [http://localhost:5273]   (needs `npm run dev`)
// Registers StratagemSystem at runtime when main.ts has not added it yet.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
// Real GPU through ANGLE D3D11 by default (headless Chrome renders at full speed, CPU stays free). SMOKE_GL=swiftshader falls back to the CPU rasterizer (no GPU / CI).
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
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket (another agent's save would otherwise full-reload the page mid-run and wipe `window.__ev`)
    // AND the game's relay socket (`/ws?t=`): this smoke is single-player and fakes the net layer itself, so a missing
    // relay must not show up as a console error. A socket stuck in CONNECTING is silent.
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(async () => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    if (!window.__game.getSystem('stratagems')) {
      const m = await import('/src/stratagems/index.ts');
      window.__game.addSystem(new m.StratagemSystem());
      window.__addedAtRuntime = true;
    }
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['stratagem:wheelChanged', 'stratagem:armed', 'stratagem:chargeChanged', 'stratagem:targeting', 'stratagem:called', 'stratagem:landed',
      'stratagem:ended', 'stratagem:cooldown', 'structure:damaged', 'structure:destroyed', 'crate:open', 'ui:notify', 'camera:shake']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
  });
  // real key events target the focused element and bubble up to window (capture-phase window listeners see them first)
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true, cancelable: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true, cancelable: true })), code);
  const mouseDown = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mousedown', { button: x })), b);
  const mouseUp = (b) => page.evaluate((x) => window.dispatchEvent(new MouseEvent('mouseup', { button: x })), b);
  const mouseMove = (dx, dy) => page.evaluate(([x, y]) => window.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })), [dx, dy]);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  // tap = keydown + keyup inside one frame (dt is clamped to 50 ms, so any wait between them counts as ≥ 0.05 s of hold)
  const key = async (code) => { await keyDown(code); await keyUp(code); await waitSim(0.15); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const S = (fn, arg) => page.evaluate((a) => { const s = window.__game.getSystem('stratagems'); return (0, eval)(`(${a.fn})`)(s, window.__game.ctx, a.arg); }, { fn: fn.toString(), arg });
  const state = () => S((s) => ({ armed: s.armed, targeting: s.targeting, cooldown: s.cooldown, total: s.cooldownTotal, calls: s.getCalls().length, structures: s.structureCount }));

  console.log('mission');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);
  ok(await P(() => !!window.__game.ctx.stratagems && window.__game.ctx.stratagems.name === 'stratagems'), 'ctx.stratagems published' + (await P(() => window.__addedAtRuntime) ? ' (registered at runtime by the smoke)' : ''));

  console.log('G tap / wheel');
  console.log('  lock/active:', JSON.stringify(await P(() => ({ locked: window.__game.ctx.input.isPointerLocked, gp: window.__game.ctx.isGameplayActive(), cuw: window.__game.ctx.player.canUseWeapons(), downed: window.__game.ctx.player.isDowned }))));
  await key('KeyG');
  let st = await state();
  ok(st.armed === 'orbital_laser', 'G tap arms the first call (orbital_laser)', JSON.stringify(st) + JSON.stringify(await ev('stratagem:armed')));
  ok((await lastEv('stratagem:armed'))?.id === 'orbital_laser', 'stratagem:armed {orbital_laser}');
  await key('KeyG');
  st = await state();
  ok(st.armed === null && (await lastEv('stratagem:armed'))?.id === null, 'G tap again puts the call away');
  await keyDown('KeyG'); await waitSim(0.4);
  ok((await lastEv('stratagem:wheelChanged'))?.open === true, 'G hold opens the wheel');
  await mouseMove(60, 0); await waitSim(0.1);
  ok((await lastEv('stratagem:wheelChanged'))?.hover === 'airstrike', 'drag right → hover E = airstrike', JSON.stringify(await lastEv('stratagem:wheelChanged')));
  await mouseMove(-60, 60); await waitSim(0.1);
  ok((await lastEv('stratagem:wheelChanged'))?.hover === 'supply_drop', 'drag down → hover S = supply_drop');
  await keyUp('KeyG'); await waitSim(0.15);
  st = await state();
  ok(st.armed === 'supply_drop' && (await lastEv('stratagem:wheelChanged'))?.open === false, 'release arms the hovered call, wheel closed', JSON.stringify(st));

  console.log('ground targeting (supply drop)');
  await waitSim(0.2);
  st = await state();
  const tg = await lastEv('stratagem:targeting');
  ok(st.targeting === true && tg?.active === true && tg.kind === 'supply_drop' && Array.isArray(tg.position), 'ground ring active with a position', JSON.stringify(tg));
  const ringWorld = await S((s) => { const r = s.ring; return { vis: r.group.visible, p: r.group.position.toArray() }; });
  ok(ringWorld.vis, 'targeting ring visible', JSON.stringify(ringWorld));
  await mouseDown(0); await waitSim(0.1); await mouseUp(0); await waitSim(0.1);
  st = await state();
  const called = await lastEv('stratagem:called');
  ok(called?.kind === 'supply_drop' && st.calls === 1 && st.armed === null && st.targeting === false, 'LMB confirms: stratagem:called, disarmed, targeting off', JSON.stringify({ st, called }));
  ok(st.cooldown > 59 && st.total === 60 && (await ev('stratagem:cooldown')).length >= 1, 'shared cooldown 60 s started', JSON.stringify(st));
  await key('KeyG');
  ok((await state()).armed === null && (await ev('ui:notify')).some((n) => /재충전/.test(n.text)), 'arming refused while on cooldown (ui:notify)', JSON.stringify(await ev('ui:notify')));
  const p0 = await P(() => window.__game.ctx.player.hp);
  await waitSim(3.5);
  const landed = await lastEv('stratagem:landed');
  ok(landed?.kind === 'supply_drop' && landed.callId === called.callId, 'supply crate landed after the delay');
  const sup = await P(() => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id.startsWith('supply:'));
    if (!it) return null;
    const near = window.__game.ctx.world.getObstaclesNear(it.position.x, it.position.z, 1).length;
    const prompt = it.getPrompt(); it.interact();
    return { id: it.id, prompt, near, can: it.canInteract() };
  });
  ok(sup && sup.prompt === '보급 상자 열기' && sup.can, 'supply interactable registered', JSON.stringify(sup));
  ok(sup && sup.near >= 1, 'supply crate obstacle registered');
  const co = await lastEv('crate:open');
  ok(co && co.crateId === sup.id && co.tier === 5, 'interact → crate:open tier 5', JSON.stringify(co));
  await P((id) => window.__game.ctx.bus.emit('crate:looted', { crateId: id }), sup.id);
  await waitSim(0.1);
  ok((await lastEv('stratagem:ended'))?.callId === called.callId, 'crate:looted → stratagem:ended');
  const p1 = await P(() => window.__game.ctx.player.hp);
  console.log(`  (player hp ${p0} → ${p1}; crate dropped on the aim point)`);

  console.log('airstrike via debugCall');
  const target = await P(() => {
    const es = window.__game.ctx.enemies.getEnemies().filter((e) => !e.isDead);
    const pl = window.__game.ctx.player.position;
    es.sort((a, b) => b.position.distanceTo(pl) - a.position.distanceTo(pl));
    const e = es[0];
    return { id: e.id, hp: e.hp, p: e.position.toArray(), dist: e.position.distanceTo(pl) };
  });
  const airId = await S((s, ctx, t) => s.debugCall('airstrike', new (ctx.player.position.constructor)(t[0], t[1], t[2])), target.p);
  ok(typeof airId === 'string' && (await lastEv('stratagem:called'))?.kind === 'airstrike', 'debugCall creates an airstrike call');
  await waitSim(5.4);
  ok((await lastEv('stratagem:landed'))?.kind === 'airstrike', 'airstrike landed after 5 s');
  const after = await P((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); return e ? { hp: e.hp, dead: e.isDead } : { gone: true }; }, target.id);
  ok(after.gone || after.dead || after.hp < target.hp, `enemy ${target.id} damaged (${target.hp} → ${JSON.stringify(after)})`);
  ok((await ev('camera:shake')).length > 0, 'camera:shake emitted');
  await waitSim(2.2);
  ok((await lastEv('stratagem:ended'))?.callId === airId, 'airstrike FX ended');

  console.log('structure drop via debugCall');
  const sp = await P(() => { const p = window.__game.ctx.player.position; return [p.x + 14, p.y, p.z + 3]; });
  const structId = await S((s, ctx, t) => s.debugCall('structure_drop', new (ctx.player.position.constructor)(t[0], t[1], t[2])), sp);
  await waitSim(4.2);
  st = await state();
  const obs = await P((t) => window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible), sp);
  ok(st.structures === 5, 'structureCount = 5 after the landing', JSON.stringify(st));
  ok(obs.length >= 5, `≥5 destructible obstacles registered (${obs.length})`);
  ok((await lastEv('stratagem:ended'))?.callId === structId, 'structure call ended once all blocks landed');
  const gaps = await P((t) => { const o = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible); let min = 1e9;
    for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) min = Math.min(min, o[i].position.distanceTo(o[j].position)); return min; }, sp);
  ok(gaps >= 2.39, `blocks ≥ 2.4 m apart (min ${gaps.toFixed(2)})`);
  const dmg = await P((t) => { const o = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).filter((o) => o.destructible)[0]; const id = o.destructible.id;
    o.destructible.onDamage(500); const hp1 = o.destructible.hp; o.destructible.onDamage(2000);
    const still = window.__game.ctx.world.getObstaclesNear(t[0], t[2], 12).some((x) => x.destructible && x.destructible.id === id);
    return { id, hp1, still }; }, sp);
  ok(dmg.hp1 === 1500 && (await lastEv('structure:damaged'))?.id === dmg.id, 'onDamage → hp 1500 + structure:damaged');
  ok((await lastEv('structure:destroyed'))?.id === dmg.id && !dmg.still, 'onDamage(2000) → structure:destroyed, obstacle removed');
  ok((await state()).structures === 4, 'structureCount = 4');
  await P((t) => window.__game.ctx.bus.emit('grenade:exploded', { position: new (window.__game.ctx.player.position.constructor)(t[0], t[1], t[2]), radius: 30 }), sp);
  const dmgEv = await ev('structure:damaged');
  ok(dmgEv.length >= 3, 'grenade:exploded damages standing structures');

  console.log('late-join sync (synthetic strat sync / stratq sync through the real NetSystem handlers)');
  await P(() => {
    const net = window.__game.ctx.net;
    window.__sent = [];
    window.__mp = { session: true, host: false };
    Object.defineProperty(net, 'inSession', { get: () => window.__mp.session, configurable: true });
    Object.defineProperty(net, 'isHost', { get: () => window.__mp.host, configurable: true });
    net.send = (msg, to) => window.__sent.push({ msg: JSON.parse(JSON.stringify(msg)), to });
    window.__recv = (msg, from) => { for (const h of net.handlers.get(msg.t) ?? []) h(msg, from); };
  });
  const base = await state();
  const shakes0 = (await ev('camera:shake')).length, landed0 = (await ev('stratagem:landed')).length;
  const syncP = await P(() => { const p = window.__game.ctx.player.position; return [p.x - 18, p.y, p.z - 6]; });
  const sync = await P((sp) => {
    const ctx = window.__game.ctx, s = window.__game.getSystem('stratagems');
    const t0 = ctx.time, hp0 = ctx.player.hp;
    const calls = [
      { callId: 'H-1', kind: 'structure_drop', p: sp, seed: 12345, eta: -5, caller: 'HOST', st: [[0, 900], [1, 0]] },
      { callId: 'H-2', kind: 'supply_drop', p: [sp[0] + 8, sp[1], sp[2]], seed: 777, eta: -3, caller: 'HOST' },
      { callId: 'H-3', kind: 'supply_drop', p: [sp[0] + 8, sp[1], sp[2] + 8], seed: 778, eta: -2, caller: 'HOST', looted: true },
      { callId: 'H-4', kind: 'airstrike', p: [sp[0] - 8, sp[1], sp[2]], seed: 9, eta: 2, caller: 'PEER2' },
    ];
    window.__recv({ t: 'strat', ev: 'sync', calls }, 'HOST');
    // everything below is read in the SAME frame the message arrived in
    const byId = (id) => s.getCalls().find((c) => c.id === id);
    const c1 = byId('H-1'), c2 = byId('H-2'), c3 = byId('H-3'), c4 = byId('H-4');
    const obs = ctx.world.getObstaclesNear(sp[0], sp[2], 14).filter((o) => o.destructible && o.destructible.id.startsWith('H-1:'));
    const it2 = ctx.interactables.all().find((i) => i.id === 'supply:H-2');
    const it3 = ctx.interactables.all().find((i) => i.id === 'supply:H-3');
    return {
      n: s.getCalls().length, structures: s.structureCount, hp: [hp0, ctx.player.hp],
      c1: c1 && { stage: c1.stage, local: c1.local, caller: c1.caller, landed: c1.structures.filter((x) => x.landed).length, destroyed: c1.structures.filter((x) => x.destroyed).length, hp: c1.structures.map((x) => x.hp) },
      obs: obs.map((o) => o.destructible.id).sort(),
      c2: c2 && { stage: c2.stage, looted: c2.looted, it: !!it2, prompt: it2?.getPrompt() ?? null, can: !!it2?.canInteract(), obs: ctx.world.getObstaclesNear(sp[0] + 8, sp[2], 1.5).length },
      c3: c3 && { stage: c3.stage, looted: c3.looted, it: !!it3, prompt: it3?.getPrompt() ?? null },
      c4: c4 && { stage: c4.stage, eta: c4.landsAt - t0, marker: !!c4.marker, local: c4.local, caller: c4.caller },
    };
  }, syncP);
  ok(sync.n === base.calls + 4, `strat sync created 4 unknown calls (${base.calls} → ${sync.n})`, JSON.stringify(sync));
  ok(sync.c1 && sync.c1.landed === 5 && sync.c1.destroyed === 1 && sync.c1.stage === 'done', 'landed structure call (eta −5) fast-forwarded: 5 landed, 1 destroyed by st, stage done', JSON.stringify(sync.c1));
  ok(sync.c1 && sync.c1.hp[0] === 900 && sync.c1.hp[1] === 0 && sync.c1.hp[2] === 2000, 'st = [index, hp] applied: 900 / 0 / untouched 2000', JSON.stringify(sync.c1?.hp));
  ok(sync.c1 && !sync.c1.local && sync.c1.caller === 'HOST', 'synced call is remote (local false, caller kept)');
  ok(sync.obs.length === 4 && !sync.obs.includes('H-1:1'), `4 destructible obstacles registered in the same frame, destroyed one absent (${sync.obs.join(',')})`);
  ok(sync.structures === base.structures + 4, `structureCount ${base.structures} → ${sync.structures}`);
  ok(sync.c2 && sync.c2.stage === 'active' && sync.c2.it && sync.c2.prompt === '보급 상자 열기' && sync.c2.can && sync.c2.obs >= 1, 'landed supply (eta −3): interactable + obstacle exist at once', JSON.stringify(sync.c2));
  ok(sync.c3 && sync.c3.stage === 'done' && sync.c3.looted && sync.c3.it && sync.c3.prompt === null, 'looted supply: crate present, no prompt, call done', JSON.stringify(sync.c3));
  ok(sync.c4 && sync.c4.stage === 'incoming' && sync.c4.eta > 1.9 && sync.c4.eta <= 2.01 && sync.c4.marker && !sync.c4.local && sync.c4.caller === 'PEER2', 'future airstrike (eta 2) stays incoming with a marker', JSON.stringify(sync.c4));
  const silentEv = { landed: (await ev('stratagem:landed')).length - landed0, shakes: (await ev('camera:shake')).length - shakes0, hp: sync.hp };
  ok(silentEv.landed === 3 && silentEv.shakes === 0 && sync.hp[0] === sync.hp[1], 'fast-forward is silent: 3 stratagem:landed, no camera:shake, no player damage', JSON.stringify(silentEv));
  const dup = await P((sp) => {
    const s = window.__game.getSystem('stratagems');
    window.__recv({ t: 'strat', ev: 'sync', calls: [{ callId: 'H-1', kind: 'structure_drop', p: sp, seed: 1, eta: -1, caller: 'HOST' }, { callId: 'H-9', kind: 'nuke', p: sp, seed: 1, eta: 1, caller: 'HOST' }] }, 'HOST');
    return { n: s.getCalls().length, structures: s.structureCount };
  }, syncP);
  ok(dup.n === sync.n && dup.structures === sync.structures, 'known callId and unknown kind are skipped');
  const ans = await P(() => {
    window.__sent.length = 0;
    window.__recv({ t: 'stratq', ev: 'sync' }, 'PEER');
    const asClient = window.__sent.slice();
    window.__mp.host = true; window.__sent.length = 0;
    window.__recv({ t: 'stratq', ev: 'sync' }, 'PEER');
    const a = window.__sent.slice();
    window.__sent.length = 0;
    window.__recv({ t: 'flow', ev: 'rejoined' }, 'PEER');
    const b = window.__sent.slice();
    window.__mp.host = false; window.__sent.length = 0;
    return { asClient, a, b };
  });
  ok(ans.asClient.length === 0, 'a non-host ignores stratq sync');
  const aMsg = ans.a[0]?.msg;
  ok(ans.a.length === 1 && ans.a[0].to === 'PEER' && aMsg?.t === 'strat' && aMsg.ev === 'sync' && Array.isArray(aMsg.calls), 'host answers stratq sync with one strat sync to the requester', JSON.stringify(ans.a));
  const wireIds = (aMsg?.calls ?? []).map((c) => c.callId);
  ok(!wireIds.includes(airId) && wireIds.includes(structId) && wireIds.includes(called.callId) && wireIds.includes('H-1') && wireIds.includes('H-4'), `done airstrike excluded, structures / supply / synced calls included (${wireIds.join(',')})`);
  const w1 = aMsg?.calls.find((c) => c.callId === 'H-1'), wS = aMsg?.calls.find((c) => c.callId === structId), wSup = aMsg?.calls.find((c) => c.callId === called.callId), w4 = aMsg?.calls.find((c) => c.callId === 'H-4');
  ok(w1 && w1.eta < 0 && JSON.stringify(w1.st) === '[[0,900],[1,0]]' && w1.caller === 'HOST' && w1.seed === 12345, 'wire: eta = landsAt − now (< 0), st = damaged structures only, caller / seed kept', JSON.stringify(w1));
  ok(wS && Array.isArray(wS.st) && wS.st.length >= 2 && wS.st.length <= 5 && wS.st.every(([, hp]) => hp < 2000) && wS.st.some(([, hp]) => hp === 0), 'wire: the real structure call lists its damaged / destroyed blocks with hp < STRUCTURE_HP (destroyed = 0)', JSON.stringify(wS?.st));
  ok(wSup && wSup.looted === true && w4 && w4.eta > 0 && w4.eta <= 2 && w4.caller === 'PEER2', 'wire: looted flag on the opened crate, positive eta on the pending airstrike', JSON.stringify({ wSup, w4 }));
  // `flow rejoined` is answered by several host-authoritative systems (pickups / inventory / gadgets / gather / ghosts),
  // so only our own `strat sync` entries are ours to assert on.
  const bStrat = ans.b.filter((s) => s.msg.t === 'strat' && s.msg.ev === 'sync');
  ok(bStrat.length === 1 && bStrat[0].to === 'PEER' && JSON.stringify(bStrat[0].msg.calls.map((c) => c.callId)) === JSON.stringify(wireIds),
    'flow rejoined → the same strat sync to that peer', JSON.stringify(ans.b.map((s) => `${s.msg.t}:${s.msg.ev}→${s.to}`)));
  await waitSim(2.3);
  ok((await ev('stratagem:landed')).some((e) => e.callId === 'H-4' && e.kind === 'airstrike'), 'synced future airstrike lands on its own clock');
  await P(() => { const net = window.__game.ctx.net; delete net.inSession; delete net.isHost; delete net.send; delete window.__recv; });

  console.log('top view (orbital laser)');
  await S((s) => s.debugCooldownReset());
  ok((await lastEv('stratagem:cooldown'))?.remaining === 0 && (await state()).cooldown === 0, 'debugCooldownReset clears the cooldown');
  await key('KeyG');
  st = await state();
  ok(st.armed === 'supply_drop', 'G tap re-arms the last armed call', JSON.stringify(st));
  await keyDown('KeyG'); await waitSim(0.4); await mouseMove(0, -80); await waitSim(0.1); await keyUp('KeyG'); await waitSim(0.15);
  ok((await state()).armed === 'orbital_laser', 'wheel N → orbital_laser');
  await mouseDown(0); await waitSim(1.0);
  const ch = await lastEv('stratagem:chargeChanged');
  ok(ch && ch.t > 0.15 && ch.t < 0.6, `charge progresses (${ch?.t?.toFixed(2)})`);
  await mouseUp(0); await waitSim(0.1);
  ok((await lastEv('stratagem:chargeChanged'))?.t === -1 && !(await state()).targeting, 'early release → charge −1, no top view', JSON.stringify((await ev('stratagem:chargeChanged')).slice(-3)) + JSON.stringify(await state()));
  await mouseDown(0); await waitSim(3.3);
  st = await state();
  const cam = await P(() => window.__game.ctx.camera.position.toArray().map((v) => Math.round(v)));
  const ply = await P(() => window.__game.ctx.player.position.toArray().map((v) => Math.round(v)));
  ok(st.targeting === true && st.armed === 'orbital_laser', 'LMB held 3 s → top view targeting', JSON.stringify(st));
  ok(cam[1] - ply[1] > 60, `camera raised above the player (${cam[1] - ply[1]} m)`);
  const before = await lastEv('stratagem:targeting');
  await mouseUp(0); await mouseMove(100, 0); await waitSim(0.15);
  const afterMove = await lastEv('stratagem:targeting');
  ok(afterMove.position[0] - before.position[0] > 10 && Math.abs(afterMove.position[2] - before.position[2]) < 0.5, `mouse +X moves the cursor +X (${(afterMove.position[0] - before.position[0]).toFixed(1)} m)`);
  await mouseMove(0, 100); await waitSim(0.15);
  const afterDown = await lastEv('stratagem:targeting');
  ok(afterDown.position[2] - afterMove.position[2] > 10, 'mouse down moves the cursor +Z');
  ok(await P(() => window.__game.ctx.player.canUseWeapons() === false), 'controls disabled during the top view');
  await keyDown('Escape'); await keyUp('Escape'); await waitSim(0.15);
  st = await state();
  ok(st.targeting === false && st.armed === 'orbital_laser' && (await lastEv('stratagem:targeting'))?.active === false, 'Esc cancels the top view, call stays armed', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.phase === 'playing' && window.__game.ctx.uiBlockers.size === 0), 'Esc was swallowed (no pause menu)', JSON.stringify(await P(() => ({ phase: window.__game.ctx.phase, blockers: [...window.__game.ctx.uiBlockers] }))));
  await mouseDown(0); await waitSim(3.3);
  ok((await state()).targeting === true, 'top view again');
  await mouseUp(0); await waitSim(0.1); await mouseDown(0); await waitSim(0.1); await mouseUp(0); await waitSim(0.15);
  st = await state();
  const laser = await lastEv('stratagem:called');
  ok(laser?.kind === 'orbital_laser' && st.targeting === false && st.armed === null, 'fresh LMB press confirms the laser', JSON.stringify(st));
  ok(await P(() => window.__game.ctx.player.canUseWeapons() === true), 'controls restored');
  await waitSim(5.4);
  ok((await lastEv('stratagem:landed'))?.kind === 'orbital_laser', 'laser ignited');
  ok(await S((s) => s.getCalls().find((c) => c.kind === 'orbital_laser')?.stage === 'active'), 'laser call stage active');

  console.log('cleanup');
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitSim(0.3);
  st = await state();
  ok(st.calls === 0 && st.structures === 0 && st.armed === null && !st.targeting, 'game:abort clears every call / structure', JSON.stringify(st));
  ok(await P(() => !window.__game.ctx.interactables.all().some((i) => i.id.startsWith('supply:'))), 'supply interactable unregistered');
  ok(await S((s) => s.group.children.length === 1), 'scene group left with only the targeting ring');
} catch (e) {
  fail++; console.log('  FAIL exception', e);
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed, ${errors.length} console errors`);
for (const e of errors.slice(0, 10)) console.log('  console:', e.slice(0, 300));
process.exit(fail || errors.length ? 1 : 0);
