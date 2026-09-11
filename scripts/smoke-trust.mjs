// Two-client smoke for the E-4 trust paths (2026-09-11, docs/plans/net-social-trust.md §5 + C-57 · X-6):
//   (d) 함선 호출 = 호스트 경유 — a non-host `strat call` / `strat sync` is ignored, `stratq call` is validated (kind ·
//       host-only · range · per-caller cooldown · callId owner) and a real non-host call reaches both clients with `by`.
//   (a)(b) 버프 — the receiver's `BuffGuard` clamps a forged boost, trims an over-budget heal, refuses a heal / cloak from a
//       sender out of range; the 스프레이 sender skips a squad-mate behind a wall.
//   (c) 계약 — a relayed kill `contractHit` is ignored, a real squad kill (host ⇄ replica) counts the squad share through
//       `enemy:squadKill`, non-kill hits are rate-limited, a `meta sync` nobody asked for is ignored.
//   C-57 `crate opened` — unknown id / far sender refused, a near sender accepted, the host only re-hands verified ids.
//   X-6 넉백 — a `HitRequest.kb` from a sender far from the enemy is refused; the per-sender DPS budget trims a flood.
// A **private** lobby joined by code (never quick match): a public lobby left by another run would join the squad.
// Usage: node scripts/smoke-trust.mjs [http://localhost:5273]   (needs `npm run dev` + `npm run server`, or the verify runner)
import puppeteer from 'puppeteer-core';
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
async function waitFor(page, fn, label, timeout = 20000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* page still loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const LAUNCH = {
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox',
  ],
};
const browsers = [];
const errors = { A: [], B: [] };
async function open(tag) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket on both clients: another agent's save would otherwise full-reload the page mid-run (C-65).
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net, `${tag} boot`);
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    window.__squad = []; window.__game.ctx.bus.on('enemy:squadKill', (e) => window.__squad.push({ id: e.id, by: e.by, type: e.type }));
    window.__progress = []; window.__game.ctx.bus.on('meta:contractProgress', (e) => window.__progress.push({ goal: e.goal, progress: e.progress, delta: e.delta }));
  });
  return page;
}
const waitSim = async (page, sec) => {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec);
};
const boardPod = (page) => page.evaluate(() => {
  const ctx = window.__game.ctx;
  const pod = ctx.interactables.all().find((i) => i.id === `hub_pod_${ctx.net.localSlot}`);
  if (!pod || !pod.canInteract()) return `pod ${ctx.net.localSlot} unavailable`;
  pod.interact();
  const warn = document.querySelector('.launch-warn');
  if (warn && !warn.hidden) [...warn.querySelectorAll('.hub-foot .ui-btn')].find((b) => b.textContent === '그래도 출격')?.click();
  return 'ok';
});
/** Move a page's player to world XZ (terrain snap) without resetting hp / buffs. */
const moveTo = (page, x, z) => page.evaluate(([x, z]) => {
  const p = window.__game.ctx.player; const V = p.position.constructor; p.teleport(new V(x, 0, z), undefined, true);
}, [x, z]);
const posOf = (page) => page.evaluate(() => { const p = window.__game.ctx.player.position; return [p.x, p.y, p.z]; });
/** Wait until `viewer` sees `peerId` within `tol` m (XZ) of `at`. */
const seesAt = (viewer, peerId, at, tol, label) => waitFor(viewer, ([id, at, tol]) => {
  const r = window.__game.ctx.net.getRemotePlayer(id);
  return !!r && Math.hypot(r.position.x - at[0], r.position.z - at[2]) < tol;
}, label, 15000, [peerId, at, tol]);

try {
  console.log('boot two clients');
  const A = await open('A');
  const B = await open('B');

  /* ── setup: private lobby → raid ──────────────────────────────────────── */
  console.log('private lobby → raid');
  await A.evaluate(() => { window.__game.ctx.net.setPlayerName('호스트'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.connected, 'A personal + connected', 30000);
  await A.evaluate(() => window.__game.ctx.net.createLobby());
  const code = await waitFor(A, () => window.__game.ctx.net.lobby?.code, 'A lobby code');
  await waitFor(A, () => window.__game.ctx.hub.ship === 'shared', 'A shared ship', 30000);
  await B.evaluate(() => { window.__game.ctx.net.setPlayerName('분대원'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.connected, 'B personal + connected', 30000);
  await B.evaluate((c) => window.__game.ctx.net.joinLobby(c), code);
  await waitFor(B, () => window.__game.ctx.hub.ship === 'shared', 'B shared ship', 30000);
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A sees 2 players');
  await A.evaluate(() => {
    const ctx = window.__game.ctx;
    if (!(typeof ctx.hub?.setPlanet === 'function' && ctx.hub.setPlanet('tundra') === true)) ctx.net.setLobbyPlanet('tundra');
  });
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.hub?.travelling && window.__game.ctx.net.lobbyPlanet === 'tundra', 'A travel finished', 30000);
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.hub?.travelling && window.__game.ctx.net.lobbyPlanet === 'tundra', 'B travel finished', 30000);
  await A.evaluate(() => window.__game.ctx.net.setLobbySeed(4242));
  await waitFor(B, () => window.__game.ctx.net.lobby?.seed === 4242, 'B sees seed');
  ok((await boardPod(A)) === 'ok', 'A boards pod');
  await waitFor(A, () => window.__game.ctx.player.isInPod, 'A in pod', 10000);
  ok((await boardPod(B)) === 'ok', 'B boards pod');
  await waitFor(A, () => window.__game.ctx.phase === 'playing', 'A playing', 90000);
  await waitFor(B, () => window.__game.ctx.phase === 'playing', 'B playing', 30000);
  await waitFor(A, () => !window.__game.ctx.player.isDropping && window.__game.ctx.world?.ready, 'A landed', 30000);
  await waitFor(B, () => !window.__game.ctx.player.isDropping && window.__game.ctx.world?.ready, 'B landed', 30000);
  const ids = await A.evaluate(() => ({ A: window.__game.ctx.net.localId, host: window.__game.ctx.net.lobby.hostId }));
  const idB = await B.evaluate(() => window.__game.ctx.net.localId);
  ok(ids.A === ids.host && idB && idB !== ids.A, `A hosts, B is a member (${ids.A} / ${idB})`);
  // a quiet field: no ambient spawns, no waves, nothing alive (the host's `training` flag only gates the spawners)
  await A.evaluate(() => { const e = window.__game.getSystem('enemies'); e.training = true; e.killAll(); });
  await waitSim(A, 1.0);

  // B stands 5 m east of A
  const pa = await posOf(A);
  await moveTo(B, pa[0] + 5, pa[2]);
  const pb = await posOf(B);
  await seesAt(A, idB, pb, 1.5, 'A sees B next to it');
  await seesAt(B, ids.A, pa, 1.5, 'B sees A');
  ok(true, 'squad placed (B 5 m from A)');

  /* ── (d) ship calls through the host ──────────────────────────────────── */
  console.log('(d) ship calls through the host');
  const near = [pb[0] + 3, pb[1], pb[2]];
  await B.evaluate(([p]) => {
    const net = window.__game.ctx.net;
    net.send({ t: 'strat', ev: 'call', callId: 'forged-1', kind: 'supply_drop', p, eta: 3, seed: 1 }, 'others');
    net.send({ t: 'strat', ev: 'sync', calls: [{ callId: 'forged-2', kind: 'structure_drop', p, seed: 2, eta: 2, caller: null }] }, 'others');
  }, [near]);
  await waitSim(A, 0.8);
  const forged = await A.evaluate(() => { const s = window.__game.getSystem('stratagems'); return { c1: s.byId.has('forged-1'), c2: s.byId.has('forged-2') }; });
  ok(!forged.c1, 'a non-host `strat call` is ignored (from ≠ hostId)', JSON.stringify(forged));
  ok(!forged.c2, 'a non-host `strat sync` is ignored', JSON.stringify(forged));

  const request = async (callId, kind, p) => {
    await B.evaluate(([callId, kind, p]) => window.__game.ctx.net.send({ t: 'stratq', ev: 'call', callId, kind, p, seed: 7 }, 'host'), [callId, kind, p]);
    await waitSim(A, 0.6);
    return A.evaluate((id) => { const s = window.__game.getSystem('stratagems'); return { has: s.byId.has(id), why: s.lastCallRefusal }; }, callId);
  };
  let r = await request(`${idB}-t1`, 'nuke', near);
  ok(!r.has && r.why === 'kind', `stratq call with an unknown kind refused (${r.why})`);
  r = await request(`${idB}-t2`, 'orbital_laser', near);
  ok(!r.has && r.why === 'host_only', `stratq call of a host-only kind refused (${r.why})`);
  r = await request(`${ids.A}-t3`, 'supply_drop', near);
  ok(!r.has && r.why === 'callId', `stratq call with somebody else's callId refused (${r.why})`);
  const far = await A.evaluate(([bx, bz]) => {
    const w = window.__game.ctx.world;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = bx + Math.cos(a) * 175, z = bz + Math.sin(a) * 175;
      if (w.isInsideBounds(x, z)) return [x, w.getHeightAt(x, z), z];
    }
    return null;
  }, [pb[0], pb[2]]);
  if (far) {
    r = await request(`${idB}-t4`, 'supply_drop', far);
    ok(!r.has && r.why === 'range', `stratq call 175 m from the caller refused (${r.why})`);
  } else console.log('  skip range test (no in-bounds point 175 m away)');

  // a real call: B confirms a supply drop the normal way — it must stand on both clients, owned by B
  await B.evaluate(([p]) => {
    const s = window.__game.getSystem('stratagems');
    s.debugCooldownReset();
    s.cursor.set(p[0], p[1], p[2]);
    s.confirm({ id: 'supply_drop', name: '보급품 투하', cooldown: 90, delay: 3, targeting: 'ground', radius: 2.5, hint: '' });
  }, [near]);
  const bCall = await waitFor(B, (me) => {
    const c = window.__game.getSystem('stratagems').getCalls().find((c) => c.kind === 'supply_drop' && c.caller === me);
    return c ? { id: c.id, local: c.local } : null;
  }, 'B call echoed back from the host', 8000, idB).catch(() => null);
  ok(!!bCall && bCall.local === true, `a non-host call comes back through the host and is B's own (local) ${JSON.stringify(bCall)}`);
  const aCall = bCall ? await A.evaluate((id) => {
    const c = window.__game.getSystem('stratagems').byId.get(id);
    return c ? { caller: c.caller, local: c.local, eta: Math.round((c.landsAt - window.__game.ctx.time) * 10) / 10 } : null;
  }, bCall.id) : null;
  ok(!!aCall && aCall.caller === idB && aCall.local === false && aCall.eta > 1 && aCall.eta <= 3.05, `…and stands on the host as B's remote call ${JSON.stringify(aCall)}`);
  const readyAt = await A.evaluate((id) => { const s = window.__game.getSystem('stratagems'); return (s.callerReadyAt.get(id) ?? 0) - performance.now() / 1000; }, idB);
  ok(readyAt > 80 && readyAt <= 90.5, `the host started B's shared cooldown (${readyAt.toFixed(1)} s)`);
  r = await request(`${idB}-t5`, 'structure_drop', near);
  ok(!r.has && r.why === 'cooldown', `a second call inside B's cooldown refused (${r.why})`);

  /* ── (a)(b) buffs: receiver clamps ────────────────────────────────────── */
  console.log('(a)(b) buffs');
  const sendBuff = (msg) => B.evaluate(([msg, to]) => window.__game.ctx.net.send({ t: 'buff', by: '분대원', ...msg }, to), [msg, ids.A]);
  await sendBuff({ kind: 'boost', amount: 100, duration: 100 });
  await waitSim(A, 0.4);
  let boost = await A.evaluate(() => {
    const m = window.__game.getSystem('player').speedMods.get('overcharge');
    const v = window.__game.getSystem('implants').lastBuffVerdict;
    return { mul: m?.mul ?? null, left: m ? m.until - window.__game.ctx.time : null, v };
  });
  ok(boost.v?.ok && boost.mul !== null && boost.mul <= 1.2801 && boost.mul > 1 && boost.left <= 4.01, `forged boost ×100 / 100 s clamped to the real overcharge ${JSON.stringify(boost)}`);
  await sendBuff({ kind: 'boost', amount: 0.01, duration: 1 });
  await waitSim(A, 0.3);
  boost = await A.evaluate(() => window.__game.getSystem('player').speedMods.get('overcharge')?.mul ?? null);
  ok(boost === 1, `a "boost ×0.01" (slow-down) is lifted to ×1 (${boost})`);

  await A.evaluate(() => { window.__game.getSystem('player').hp = 30; });
  await sendBuff({ kind: 'heal', amount: 20, duration: 0 });
  await waitSim(A, 0.4);
  let hp = await A.evaluate(() => ({ hp: window.__game.ctx.player.hp, v: window.__game.getSystem('implants').lastBuffVerdict }));
  ok(Math.round(hp.hp) === 50 && hp.v?.ok, `a heal from a squad-mate in range lands (30 → ${hp.hp})`);
  await sendBuff({ kind: 'heal', amount: 10000, duration: 0 });
  await waitSim(A, 0.4);
  hp = await A.evaluate(() => ({ hp: window.__game.ctx.player.hp, max: window.__game.ctx.player.maxHp, v: window.__game.getSystem('implants').lastBuffVerdict }));
  ok(hp.v?.ok && hp.v.amount < 200, `a heal of 10000 is trimmed to the heal budget (${hp.v?.amount?.toFixed?.(1)})`, JSON.stringify(hp.v));

  // B walks 70 m away: heal and cloak from there are refused
  await moveTo(B, pa[0] + 70, pa[2]);
  const pbFar = await posOf(B);
  await seesAt(A, idB, pbFar, 2, 'A sees B far');
  await A.evaluate(() => { window.__game.getSystem('player').hp = 30; });
  await sendBuff({ kind: 'heal', amount: 20, duration: 0 });
  await sendBuff({ kind: 'cloak', amount: 0, duration: 12 });
  await waitSim(A, 0.5);
  const farBuff = await A.evaluate(() => ({
    hp: window.__game.ctx.player.hp, heal: window.__game.getSystem('implants').lastBuffVerdict,
    cloak: window.__game.getSystem('gadgets').lastBuffVerdict, cloaked: !!window.__game.ctx.player.isCloaked,
  }));
  ok(Math.round(farBuff.hp) === 30 && farBuff.heal?.reason === 'range', `a heal from 70 m is refused (${farBuff.heal?.reason})`);
  ok(!farBuff.cloaked && farBuff.cloak?.reason === 'range', `a cloak from 70 m is refused (${farBuff.cloak?.reason})`);

  // back next to A; the 스프레이 skips A behind a wall on B's side
  await moveTo(B, pa[0] + 5, pa[2]);
  await seesAt(B, ids.A, pa, 1.5, 'B sees A again');
  await seesAt(A, idB, [pa[0] + 5, 0, pa[2]], 1.5, 'A sees B back');
  const spray = await B.evaluate((aId) => {
    const ctx = window.__game.ctx, w = window.__game.getSystem('weapons');
    const me = ctx.player.position, a = ctx.net.getRemotePlayer(aId).position;
    const V = me.constructor;
    w.sprayOwed.clear(); w.sprayAllies(1, 8);
    const open = w.sprayOwed.has(aId);
    const mid = new V((me.x + a.x) / 2, Math.min(me.y, a.y) - 1, (me.z + a.z) / 2);
    const remove = ctx.world.addObstacle({ position: mid, radius: 1.2, height: 8 });
    w.sprayOwed.clear(); w.sprayAllies(1, 8);
    const walled = w.sprayOwed.has(aId);
    remove();
    w.sprayOwed.clear();
    return { open, walled };
  }, ids.A);
  ok(spray.open, 'the 스프레이 owes a heal to A in the open (positive control)');
  ok(!spray.walled, 'the 스프레이 sends nothing to A behind a wall (sender-side raycast)');

  /* ── (c) contracts ────────────────────────────────────────────────────── */
  console.log('(c) contracts');
  const setContract = (page, id) => page.evaluate((id) => { const m = window.__game.ctx.meta; m.store.data.activeContract = { id, progress: 0 }; window.__progress.length = 0; }, id);
  const progressOf = (page) => page.evaluate(() => window.__game.ctx.meta.activeContract?.progress ?? null);
  await setContract(A, 'helix_1'); await setContract(B, 'helix_1');
  await B.evaluate(() => window.__game.ctx.net.send({ t: 'meta', ev: 'contractHit', corp: 'helix', goal: 'kill_bugs', amount: 5 }, 'others'));
  await waitSim(A, 0.5);
  ok((await progressOf(A)) === 0, 'a relayed kill `contractHit` does not move the host\'s contract');

  // B kills a bug the host spawned → the host counts the squad share from its own death event
  const bugNearB = await A.evaluate(([x, z]) => window.__game.getSystem('enemies').debugSpawn('scavenger', { x, z })?.id ?? null, [pa[0] + 9, pa[2]]);
  ok(bugNearB !== null, `host spawned a bug (${bugNearB})`);
  await waitFor(B, (id) => !!window.__game.getSystem('enemies').byId.get(id), 'B has the replica bug', 10000, bugNearB);
  for (let i = 0; i < 4; i++) {
    const dead = await A.evaluate((id) => { const e = window.__game.getSystem('enemies').byId.get(id); return !e || e.state === 'dead'; }, bugNearB);
    if (dead) break;
    await B.evaluate((id) => { const e = window.__game.getSystem('enemies').byId.get(id); if (e && e.state !== 'dead') e.takeDamage(200); }, bugNearB);
    await waitSim(A, 0.4);
  }
  await waitFor(A, (id) => window.__squad.some((k) => k.id === id), 'A enemy:squadKill', 8000, bugNearB).catch(() => null);
  const killA = await A.evaluate((id) => ({ squad: window.__squad.filter((k) => k.id === id), progress: window.__game.ctx.meta.activeContract?.progress ?? null }), bugNearB);
  ok(killA.squad.length === 1 && killA.squad[0].by === idB, `host emitted enemy:squadKill by B ${JSON.stringify(killA.squad)}`);
  ok(killA.progress > 0 && killA.progress < 1, `the host's kill contract got the squad share only (${killA.progress})`);
  await waitSim(B, 0.5);
  const killB = await B.evaluate(() => ({ progress: window.__game.ctx.meta.activeContract?.progress ?? null, squad: window.__squad.length }));
  ok(killB.progress === 1 && killB.squad === 0, `B counted its own kill once, no squad kill (${JSON.stringify(killB)})`);

  // the host kills one → B (a replica) derives the squad share from `ee kill {killer}`
  const bugByA = await A.evaluate(([x, z]) => {
    const e = window.__game.getSystem('enemies').debugSpawn('scavenger', { x, z });
    return e ? e.id : null;
  }, [pa[0] - 9, pa[2]]);
  await waitFor(B, (id) => !!window.__game.getSystem('enemies').byId.get(id), 'B has the second replica bug', 10000, bugByA);
  await A.evaluate((id) => window.__game.getSystem('enemies').byId.get(id)?.takeDamage(9999, undefined, undefined, 'local'), bugByA);
  await waitFor(B, (id) => window.__squad.some((k) => k.id === id), 'B enemy:squadKill', 8000, bugByA).catch(() => null);
  const killB2 = await B.evaluate((id) => ({ squad: window.__squad.filter((k) => k.id === id), progress: window.__game.ctx.meta.activeContract?.progress ?? null }), bugByA);
  ok(killB2.squad.length === 1 && killB2.squad[0].by === ids.A, `replica emitted enemy:squadKill by the host ${JSON.stringify(killB2.squad)}`);
  ok(killB2.progress > 1 && killB2.progress < 2, `B's kill contract got the squad share of the host's kill (${killB2.progress})`);

  // non-kill hits: rate limited per sender / goal; a `meta sync` nobody asked for is ignored; one that was asked for lands
  const crateContract = await A.evaluate(() => {
    const m = window.__game.getSystem('meta');
    for (const corp of ['helix', 'bastion', 'nomad', 'ceres']) {
      const c = m.getContracts(corp).find((x) => x.def.goal === 'open_crates');
      if (c) return { id: c.def.id, corp: c.def.corp };
    }
    return null;
  });
  if (crateContract) {
    await setContract(A, crateContract.id);
    await B.evaluate((corp) => { for (let i = 0; i < 12; i++) window.__game.ctx.net.send({ t: 'meta', ev: 'contractHit', corp, goal: 'open_crates', amount: 1 }, 'others'); }, crateContract.corp);
    await waitSim(A, 0.6);
    const burst = await progressOf(A);
    ok(burst > 0 && burst <= 1.0001, `12 relayed open_crates hits in a burst → only the bucket's worth counts (${burst})`);
    await B.evaluate((corp) => window.__game.ctx.net.send({ t: 'meta', ev: 'sync', corp, hits: [['open_crates', 20]], rid: 123456 }, 'others'), crateContract.corp);
    await waitSim(A, 0.5);
    ok((await progressOf(A)) === burst, 'a `meta sync` with an id this client never requested is ignored');
    await A.evaluate(() => { const m = window.__game.getSystem('meta'); m.syncRid = 777; m.syncRepliedBy.clear(); });
    await B.evaluate((corp) => window.__game.ctx.net.send({ t: 'meta', ev: 'sync', corp, hits: [['open_crates', 4]], rid: 777 }, 'others'), crateContract.corp);
    await waitSim(A, 0.5);
    const synced = await progressOf(A);
    ok(synced > burst, `…while the answer to our own request (rid 777) lands (${burst} → ${synced})`);
  } else console.log('  skip non-kill contract tests (no open_crates contract def)');

  /* ── C-57 crate opened ────────────────────────────────────────────────── */
  console.log('C-57 crate opened');
  const crate = await A.evaluate(([bx, bz]) => {
    const defs = window.__game.getSystem('world').crates.getDefs();
    const c = defs.filter((d) => !d.opened).sort((a, b) => Math.hypot(b.position.x - bx, b.position.z - bz) - Math.hypot(a.position.x - bx, a.position.z - bz))[0];
    return c ? { id: c.id, p: [c.position.x, c.position.y, c.position.z], d: Math.hypot(c.position.x - bx, c.position.z - bz) } : null;
  }, [pa[0] + 5, pa[2]]);
  const refused0 = await A.evaluate(() => window.__game.getSystem('world').openRefused);
  await B.evaluate(() => window.__game.ctx.net.send({ t: 'crate', ev: 'opened', id: 'crate_does_not_exist' }, 'others'));
  await waitSim(A, 0.4);
  ok((await A.evaluate(() => window.__game.getSystem('world').openRefused)) === refused0 + 1, '`crate opened` with an id this world does not have is refused');
  if (crate && crate.d > 20) {
    await B.evaluate((id) => window.__game.ctx.net.send({ t: 'crate', ev: 'opened', id }, 'others'), crate.id);
    await waitSim(A, 0.4);
    const farOpen = await A.evaluate((id) => ({
      opened: window.__game.getSystem('world').crates.getDefs().find((d) => d.id === id).opened,
      inSync: window.__game.getSystem('world').openedIds.has(id), refused: window.__game.getSystem('world').openRefused,
    }), crate.id);
    ok(!farOpen.opened && !farOpen.inSync && farOpen.refused === refused0 + 2, `a crate ${crate.d.toFixed(0)} m from the sender stays closed and out of the host's sync list ${JSON.stringify(farOpen)}`);
    await moveTo(B, crate.p[0] + 1.5, crate.p[2]);
    const pbc = await posOf(B);
    await seesAt(A, idB, pbc, 1.5, 'A sees B at the crate');
    await B.evaluate((id) => window.__game.ctx.net.send({ t: 'crate', ev: 'opened', id }, 'others'), crate.id);
    await waitSim(A, 0.4);
    const nearOpen = await A.evaluate((id) => ({
      opened: window.__game.getSystem('world').crates.getDefs().find((d) => d.id === id).opened,
      inSync: window.__game.getSystem('world').openedIds.has(id),
    }), crate.id);
    ok(nearOpen.opened && nearOpen.inSync, `the same crate opened by B standing next to it is accepted ${JSON.stringify(nearOpen)}`);
    await moveTo(B, pa[0] + 5, pa[2]);
    await seesAt(A, idB, [pa[0] + 5, 0, pa[2]], 1.5, 'A sees B back at the start');
  } else console.log(`  skip far / near crate test (${crate ? `nearest unopened crate only ${crate.d.toFixed(0)} m` : 'no crates on this map'})`);

  /* ── X-6 knockback geometry ───────────────────────────────────────────── */
  console.log('X-6 knockback + DPS budget');
  const kbTest = async (x, z) => {
    const id = await A.evaluate(([x, z]) => window.__game.getSystem('enemies').debugSpawn('warrior', { x, z })?.id ?? null, [x, z]);
    await waitSim(A, 0.3);
    const before = await A.evaluate(() => window.__game.getSystem('enemies').hitGuardStats.kbRefused);
    const ep = await A.evaluate((id) => { const e = window.__game.getSystem('enemies').byId.get(id); return [e.position.x, e.position.y + 1, e.position.z]; }, id);
    await B.evaluate(([id, p]) => window.__game.ctx.net.send({ t: 'hit', id, dmg: 0, p, d: [1, 0, 0], kb: 6 }, 'host'), [id, ep]);
    await waitSim(A, 0.4);
    const after = await A.evaluate(() => window.__game.getSystem('enemies').hitGuardStats.kbRefused);
    return { id, refused: after - before };
  };
  const kbFar = await kbTest(pa[0] + 5 + 45, pa[2] + 20);
  ok(kbFar.refused === 1, `a shield-bash knockback on an enemy ~50 m from the sender is refused (${kbFar.refused})`);
  const kbNear = await kbTest(pa[0] + 5 + 1.5, pa[2]);
  ok(kbNear.refused === 0, `a knockback on an enemy next to the sender is applied (refused ${kbNear.refused})`);

  const tank = await A.evaluate(([x, z]) => {
    const e = window.__game.getSystem('enemies').debugSpawn('behemoth', { x, z });
    if (!e) return null;
    e.maxHp = 1e6; e.hp = 1e6;
    return e.id;
  }, [pa[0] + 5, pa[2] + 30]);
  await waitSim(A, 0.3);
  const statsBefore = await A.evaluate(() => ({ ...window.__game.getSystem('enemies').hitGuardStats }));
  ok(statsBefore.trimmed === 0 && statsBefore.dropped === 0, `no normal hit was trimmed so far ${JSON.stringify(statsBefore)}`);
  if (tank !== null) {
    const ep = await A.evaluate((id) => { const e = window.__game.getSystem('enemies').byId.get(id); return [e.position.x, e.position.y + 1.5, e.position.z]; }, tank);
    await B.evaluate(([id, p]) => { for (let i = 0; i < 40; i++) window.__game.ctx.net.send({ t: 'hit', id, dmg: 500, p, d: [0, 0, 0] }, 'host'); }, [tank, ep]);
    await waitSim(A, 0.8);
    const flood = await A.evaluate((id) => ({ lost: 1e6 - (window.__game.getSystem('enemies').byId.get(id)?.hp ?? 0), stats: { ...window.__game.getSystem('enemies').hitGuardStats } }), tank);
    ok(flood.stats.dropped + flood.stats.trimmed > 0 && flood.lost < 20000 * 0.8, `a 40 × 500 hit flood is capped by the per-sender DPS budget ${JSON.stringify(flood)}`);
  }

  ok(errors.A.length === 0, 'A: no console errors', errors.A.slice(0, 4).join(' | '));
  ok(errors.B.length === 0, 'B: no console errors', errors.B.slice(0, 4).join(' | '));
  await B.evaluate(() => window.__game.ctx.net.leaveLobby()).catch(() => {});
  await A.evaluate(() => window.__game.ctx.net.leaveLobby()).catch(() => {});
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  for (const tag of ['A', 'B']) if (errors[tag].length) console.log(`  ${tag} console errors: ${errors[tag].slice(0, 6).join(' | ')}`);
} finally {
  for (const b of browsers) await b.close().catch(() => {});
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
