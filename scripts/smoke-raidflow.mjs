// Phase 7 game-flow smoke (solo, synthetic net events): solo death → 레이드 실패 (`game:raidFailed` + `game:over`, no respawn,
// auto return to the ship after RAID_FAILED_AUTO_RETURN_S), 훈련장 enter / death-respawn / exit with the inventory snapshot
// restored and no XP / settlement / threat, rejoin restore (`net:raidLoaded` blob + `net:ghostRestore` alive / dead) and the
// `NET_GHOST_RESTORE_TIMEOUT_S` hellpod fallback, extraction consoles absent when the world has no pads.
// 2026-09-09: 자동 부활 폐지 — 죽은 몸으로 복귀해도 카운트다운이 없고 `game:respawn` 은 무력하다 (구조선만이 되살린다).
// Usage: node scripts/smoke-raidflow.mjs [http://localhost:5273]   (needs a running vite)
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    // Never let headless Chrome take a real pointer lock (Windows ClipCursor trap); the script fakes `pointerLockElement`.
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run (same trick as smoke-meta).
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.inventory, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['player:died', 'player:downed', 'player:respawn', 'player:spawned', 'player:landed', 'game:respawnAvailable', 'game:phaseChanged',
      'game:over', 'game:raidFailed', 'game:complete', 'game:abort', 'hub:entered', 'hub:left', 'game:newMission', 'world:ready', 'ui:notify',
      'player:giveUpProgress', 'extraction:shipIncoming', 'extraction:shipLanded', 'extraction:boarded', 'extraction:liftoff']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p ?? {}, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    // spies on the neighbours game/ talks to (their Phase 7 implementations may still be skeletons)
    const ctx = window.__game.ctx;
    window.__spy = { applyRaidState: [], restoreState: [], threat: [], addXp: [], settle: [], saveRaid: [] };
    const inv = ctx.inventory;
    const origApply = inv.applyRaidState.bind(inv);
    inv.applyRaidState = (s) => { window.__spy.applyRaidState.push(s); return origApply(s); };
    const pl = ctx.player;
    const origRestore = pl.restoreState.bind(pl);
    pl.restoreState = (s) => { window.__spy.restoreState.push({ hp: s.hp, state: s.state, pos: [s.position.x, s.position.y, s.position.z] }); return origRestore(s); };
    const en = ctx.enemies;
    if (en) { const o = en.setThreatLevel.bind(en); en.setThreatLevel = (v) => { window.__spy.threat.push(v); return o(v); }; }
    const prog = ctx.progression;
    if (prog) { const o = prog.addXp.bind(prog); prog.addXp = (v) => { window.__spy.addXp.push(v); return o(v); }; }
    const meta = ctx.meta;
    if (meta && typeof meta.settleMission === 'function') { const o = meta.settleMission.bind(meta); meta.settleMission = (s) => { window.__spy.settle.push(s); return o(s); }; }
    const net = ctx.net;
    if (net) { const o = net.saveRaid.bind(net); net.saveRaid = (b) => { window.__spy.saveRaid.push(b); return o(b); }; }
  });
  const keyDown = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true })), code);
  const keyUp = (code) => page.evaluate((c) => document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true })), code);
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => page.evaluate((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const resetEv = () => P(() => { for (const k of Object.keys(window.__ev)) window.__ev[k] = []; });
  const startMission = async (seed, mode) => {
    await P(({ seed, mode }) => { const ctx = window.__game.ctx; ctx.missionMode = mode ?? 'raid'; ctx.bus.emit('game:newMission', mode ? { seed, mode } : { seed }); }, { seed, mode });
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
    await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
    await waitSim(0.3);
  };
  const giveUp = async () => {
    // 2026-09-08: solo lethal damage no longer goes through 전투불능, so the give-up state is entered directly.
    await P(() => window.__game.ctx.player.enterDowned());
    await waitSim(0.3);
    await keyDown('Space'); await waitSim(2.2); await keyUp('Space');
    await waitSim(0.3);
  };

  console.log('solo raid: death = 레이드 실패');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await startMission(11);
  let st = await P(() => { const ctx = window.__game.ctx; return { mode: ctx.missionMode, statsMode: ctx.stats.mode, training: ctx.isTraining(), pads: ctx.interactables.all().filter((i) => i.id.startsWith('extract_')).length, threat: window.__spy.threat.length }; });
  ok(st.mode === 'raid' && st.statsMode === 'raid' && !st.training, 'raid: ctx.missionMode / stats.mode raid, isTraining false', JSON.stringify(st));
  ok(st.pads > 0, 'raid world: extraction consoles registered', `${st.pads}`);
  ok(st.threat > 0, 'threat ramp runs in a raid', `${st.threat}`);
  const xpBefore = await P(() => window.__game.ctx.progression?.xp ?? -1);
  await P(() => { window.__ev['player:giveUpProgress'] = []; });
  await giveUp();
  const gup = await P(() => {
    const a = window.__ev['player:giveUpProgress'].map((e) => e.t);
    const died = window.__ev['player:died'].length;
    let rising = a.length > 1; for (let i = 1; i < a.length - 1; i++) if (a[i] < a[i - 1]) rising = false;
    return { n: a.length, max: Math.max(...a), first: a[0], last: a[a.length - 1], rising, died };
  });
  ok(gup.n >= 3 && gup.max >= 0.5 && gup.max <= 1 && gup.first >= 0 && gup.rising, 'Phase 9: player:giveUpProgress rises while Space is held (≥ 0.5)', JSON.stringify(gup));
  ok(gup.last === -1 && gup.died === 1, 'give-up hold ends with t -1 and player:died', JSON.stringify(gup));
  ok(gup.n <= 48, 'progress events capped near 20 Hz', String(gup.n));
  st = await P(() => ({ dead: window.__game.ctx.player.isDead, phase: window.__game.ctx.phase, over: window.__ev['game:over'].length, failed: window.__ev['game:raidFailed'].length }));
  ok(st.dead && st.over === 0 && st.failed === 0, 'dead: result deferred by the 2.5 s death delay', JSON.stringify(st));
  await waitSim(3.0);
  st = await P(() => { const ctx = window.__game.ctx; const f = window.__ev['game:raidFailed']; const o = window.__ev['game:over']; return { phase: ctx.phase, failed: f.length, over: o.length, failedFirst: f.length && o.length ? true : false, extracted: f[0]?.stats?.extracted, mode: f[0]?.stats?.mode, rewards: !!o[0]?.stats?.rewards, ra: window.__ev['game:respawnAvailable'].length, respawns: window.__ev['player:respawn'].length }; });
  ok(st.phase === 'dead', 'solo death → phase dead', st.phase);
  ok(st.failed === 1 && st.over === 1, 'game:raidFailed + game:over emitted once each', JSON.stringify(st));
  ok(st.extracted === false && st.mode === 'raid', 'raidFailed stats: extracted false, mode raid', JSON.stringify(st));
  ok(st.rewards, 'game:over stats carry rewards (XP banked once)');
  ok(st.ra === 0 && st.respawns === 0, 'no respawn countdown / respawn in a solo raid', JSON.stringify(st));
  await P(() => window.__game.ctx.bus.emit('game:respawn', {}));
  await waitSim(0.3);
  ok((await ev('player:respawn')).length === 0, 'game:respawn refused after a raid failure');
  const xpAfter = await P(() => window.__game.ctx.progression?.xp ?? -1);
  ok(xpBefore < 0 || xpAfter >= xpBefore, 'progression xp not lost on failure', `${xpBefore} → ${xpAfter}`);
  const deathScreen = await P(() => [...document.querySelectorAll('.menu')].some((el) => !el.hidden && getComputedStyle(el).visibility !== 'hidden' && /함선/.test(el.textContent ?? '')));
  ok(deathScreen, 'death screen visible with a 함선 return option');
  // RAID_FAILED_AUTO_RETURN_S (12 s) → automatic hub:enter; fast-forward with the time scale
  await P(() => { window.__game.ctx.timeScale = 8; });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'auto return to the hub', 60000);
  await P(() => { window.__game.ctx.timeScale = 1; });
  st = await P(() => ({ phase: window.__game.ctx.phase, ship: window.__ev['hub:entered'].at(-1)?.ship, aborts: window.__ev['game:abort'].length }));
  ok(st.phase === 'hub' && st.ship === 'personal', 'auto return → personal ship (no lobby)', JSON.stringify(st));
  ok(st.aborts >= 1, 'the return aborted the failed mission');

  console.log('훈련장: enter / death respawn / exit');
  await resetEv();
  await P(() => { for (const k of Object.keys(window.__spy)) window.__spy[k] = []; });
  const hubInv = await P(() => { const inv = window.__game.ctx.inventory; const s = inv.captureRaidState(); return { stims: inv.countWhere((d) => d.id === 'heal_bandage'), snap: s == null ? null : JSON.stringify(s) }; });
  await startMission(5, 'training');
  st = await P(() => { const ctx = window.__game.ctx; return { mode: ctx.missionMode, statsMode: ctx.stats.mode, training: ctx.isTraining(), worldMode: ctx.world?.mode, pads: ctx.interactables.all().filter((i) => i.id.startsWith('extract_')).length, threat: window.__spy.threat.length }; });
  ok(st.mode === 'training' && st.statsMode === 'training' && st.training, 'training: ctx.missionMode / stats.mode / isTraining()', JSON.stringify(st));
  ok(st.threat === 0, 'no threat ramp in a training', `${st.threat}`);
  if (st.worldMode === 'training') ok(st.pads === 0, 'training arena: no extraction consoles', `${st.pads}`);
  else console.log('  skip world mode is not training yet (world/ skeleton) — console check skipped');
  // spend something on the range so the exit refund is observable
  const spent = await P(() => { const inv = window.__game.ctx.inventory; const before = inv.countWhere((d) => d.id === 'heal_bandage'); const c = typeof inv.consumeDef === 'function' ? inv.consumeDef('heal_bandage', 1) : false; return { before, after: inv.countWhere((d) => d.id === 'heal_bandage'), c }; });
  // death on the range: give up while downed → immediate respawn at the arena spawn, no failure
  await giveUp();
  await waitFor(page, () => window.__ev['player:respawn'].length > 0, 'training respawn', 10000);
  st = await P(() => ({ respawns: window.__ev['player:respawn'].length, failed: window.__ev['game:raidFailed'].length, over: window.__ev['game:over'].length, ra: window.__ev['game:respawnAvailable'].length, phase: window.__game.ctx.phase }));
  ok(st.respawns === 1 && st.failed === 0 && st.over === 0, 'training death → immediate player:respawn, no failure', JSON.stringify(st));
  ok(st.ra === 0, 'no respawn countdown in a training');
  ok(st.phase === 'playing' || st.phase === 'deploying', 'phase stays in the mission', st.phase);
  await waitFor(page, () => window.__game.ctx.phase === 'playing' && !window.__game.ctx.player.isDropping && !window.__game.ctx.player.isDead, 'landed again', 60000);
  // exit console → abort + snapshot restore + back to the ship
  await P(() => window.__game.ctx.bus.emit('training:exitRequested', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'back in the hub', 20000);
  st = await P(() => { const ctx = window.__game.ctx; const inv = ctx.inventory; return { phase: ctx.phase, ship: window.__ev['hub:entered'].at(-1)?.ship, aborts: window.__ev['game:abort'].length, applied: window.__spy.applyRaidState.length, appliedSnap: window.__spy.applyRaidState[0] == null ? null : JSON.stringify(window.__spy.applyRaidState[0]), stims: inv.countWhere((d) => d.id === 'heal_bandage'), xp: window.__spy.addXp.length, settle: window.__spy.settle.length, over: window.__ev['game:over'].length, complete: window.__ev['game:complete'].length, training: ctx.isTraining() }; });
  ok(st.phase === 'hub' && st.ship === 'personal' && st.aborts === 1, 'training exit → game:abort → personal ship', JSON.stringify({ phase: st.phase, ship: st.ship, aborts: st.aborts }));
  ok(st.xp === 0 && st.settle === 0 && st.over === 0 && st.complete === 0, 'training: no XP, no contract settlement, no result screen', JSON.stringify({ xp: st.xp, settle: st.settle }));
  ok(!st.training, 'isTraining() false back in the hub');
  if (hubInv.snap == null) {
    console.log('  skip inventory.captureRaidState is still the skeleton (null) — snapshot restore checked by call only');
    ok(st.applied === 0, 'no applyRaidState call without a snapshot');
  } else {
    ok(st.applied === 1 && st.appliedSnap === hubInv.snap, 'applyRaidState called once with the hub snapshot', `${st.applied}`);
    if (spent.c) ok(st.stims === hubInv.stims, 'stim spent on the range is refunded on exit', `${spent.after} → ${st.stims} (hub ${hubInv.stims})`);
  }

  console.log('rejoin: raid blob + ghost restore (synthetic net events, solo)');
  await resetEv();
  await P(() => { for (const k of Object.keys(window.__spy)) window.__spy[k] = []; });
  await P(() => {
    const ctx = window.__game.ctx;
    const stats = { seed: 21, kills: 7, cratesOpened: 2, damageTaken: 33, timeSeconds: 123, lootValue: 0, extracted: false, mode: 'raid' };
    ctx.bus.emit('net:raidLoaded', { blob: { seed: 21, missionTime: 123, stats, inventory: null, savedAt: Date.now() } });
    ctx.missionMode = 'raid';
    ctx.bus.emit('net:gameStarting', { seed: 21, lobby: { code: 'TEST', hostId: 'h', players: [], started: true, seed: 21, isPublic: false }, rejoin: true, mode: 'raid' });
    window.__pendingAtStart = ctx.rejoinPending;
    ctx.bus.emit('game:newMission', { seed: 21, mode: 'raid' });
  });
  await waitFor(page, () => window.__game.ctx.phase === 'deploying', 'deploying (rejoin)', 20000);
  st = await P(() => { const ctx = window.__game.ctx; return { pendingAtStart: window.__pendingAtStart, pending: ctx.rejoinPending, kills: ctx.stats.kills, crates: ctx.stats.cratesOpened, t: ctx.missionTime, phase: ctx.phase }; });
  ok(st.pendingAtStart === true && st.pending === true, 'net:gameStarting {rejoin} → ctx.rejoinPending true before the world', JSON.stringify(st));
  ok(st.kills === 7 && st.crates === 2 && st.t >= 123 && st.t < 130, 'raid blob applied after world:ready (stats + missionTime)', JSON.stringify(st));
  await P(() => {
    const ctx = window.__game.ctx; const THREE_V = ctx.world.getPlayerSpawn().clone(); THREE_V.x += 3;
    ctx.bus.emit('net:ghostRestore', { state: { position: THREE_V, yaw: 1.2, hp: 55, downHp: 100, state: 0 } });
  });
  await waitSim(0.3);
  st = await P(() => { const ctx = window.__game.ctx; return { phase: ctx.phase, pending: ctx.rejoinPending, restored: window.__spy.restoreState.length, hp: window.__spy.restoreState[0]?.hp, respawns: window.__ev['player:respawn'].length, ra: window.__ev['game:respawnAvailable'].length }; });
  ok(st.restored === 1 && st.hp === 55, 'net:ghostRestore → player.restoreState(state)', JSON.stringify(st));
  ok(st.phase === 'playing' && st.pending === false, 'restore → phase playing, rejoinPending cleared', JSON.stringify(st));
  ok(st.ra === 0, 'alive restore: no respawn countdown');
  // the timeout fallback must not fire after a restore
  await waitSim(3.5);
  ok((await ev('player:respawn')).length === 0, 'no fallback respawn after a successful restore');

  console.log('rejoin: dead ghost → respawn flow');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await resetEv();
  await P(() => { for (const k of Object.keys(window.__spy)) window.__spy[k] = []; });
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'raid';
    ctx.bus.emit('net:gameStarting', { seed: 22, lobby: { code: 'TEST', hostId: 'h', players: [], started: true, seed: 22, isPublic: false }, rejoin: true, mode: 'raid' });
    ctx.bus.emit('game:newMission', { seed: 22, mode: 'raid' });
  });
  await waitFor(page, () => window.__game.ctx.phase === 'deploying', 'deploying (rejoin 2)', 20000);
  ok((await P(() => window.__game.ctx.stats.kills)) === 0, 'no blob for this seed → fresh stats');
  await P(() => { const ctx = window.__game.ctx; ctx.bus.emit('net:ghostRestore', { state: { position: ctx.world.getPlayerSpawn().clone(), yaw: 0, hp: 0, downHp: 0, state: 2 } }); });
  await waitSim(0.5);
  st = await P(() => { const ctx = window.__game.ctx; return { phase: ctx.phase, pending: ctx.rejoinPending, restored: window.__spy.restoreState.length, state: window.__spy.restoreState[0]?.state, ra: window.__ev['game:respawnAvailable'].at(-1)?.seconds, failed: window.__ev['game:raidFailed'].length }; });
  ok(st.restored === 1 && st.state === 2 && st.phase === 'playing' && !st.pending, 'dead ghost restored → playing (spectate), rejoinPending cleared', JSON.stringify(st));
  // 2026-09-09: 자동 부활이 사라졌다. 죽은 몸으로 복귀하면 관전 상태에 그대로 머무르고,
  // 30초 카운트다운도 `game:respawn` 도 더는 아무것도 하지 않는다 — 되살아나는 길은 분대원의 구조선뿐이다.
  ok(st.ra === undefined, 'dead ghost → no respawn countdown (자동 부활 폐지)', `${st.ra}`);
  ok(st.failed === 0, 'a dead restore alone is not a raid failure (solo path is bypassed)', `${st.failed}`);
  await P(() => { window.__game.ctx.timeScale = 10; });
  await waitSim(3);
  await P(() => { window.__game.ctx.timeScale = 1; });
  await P(() => window.__game.ctx.bus.emit('game:respawn', {}));
  await waitSim(0.3);
  st = await P(() => ({ ra: window.__ev['game:respawnAvailable'].length, respawns: window.__ev['player:respawn'].length, dead: window.__game.ctx.player.isDead }));
  ok(st.ra === 0 && st.respawns === 0 && st.dead, 'no countdown and game:respawn is inert — the body waits for a 구조선', JSON.stringify(st));

  console.log('rejoin: restore timeout fallback');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await resetEv();
  await P(() => { for (const k of Object.keys(window.__spy)) window.__spy[k] = []; });
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionMode = 'raid';
    ctx.bus.emit('net:gameStarting', { seed: 23, lobby: { code: 'TEST', hostId: 'h', players: [], started: true, seed: 23, isPublic: false }, rejoin: true, mode: 'raid' });
    ctx.bus.emit('game:newMission', { seed: 23, mode: 'raid' });
  });
  await waitFor(page, () => window.__game.ctx.phase === 'deploying', 'deploying (rejoin 3)', 20000);
  const pendingBefore = await P(() => window.__game.ctx.rejoinPending);
  await waitFor(page, () => window.__game.ctx.rejoinPending === false, 'restore timeout', 30000);
  st = await P(() => ({ restored: window.__spy.restoreState.length, t: window.__game.ctx.missionTime }));
  ok(pendingBefore === true && st.restored === 0, 'no ghost restore arrived → fallback path', JSON.stringify(st));
  await waitFor(page, () => window.__game.ctx.phase === 'playing' && !window.__game.ctx.player.isDropping, 'fallback hellpod landed', 60000);
  ok(await P(() => !window.__game.ctx.player.isDead && window.__game.ctx.player.hp > 0), 'fallback: player alive after the hellpod drop');
  ok((await P(() => window.__spy.saveRaid.length)) === 0, 'saveRaid never called outside a multiplayer raid session');

  /* 2026-09-09 (ESC 닫기): Escape closes the **top open screen** and opens the 일시정지 메뉴 only when there is
     nothing to close (`shared/escape` → `game/escapeKey`). The menu itself is unchanged in the browser — it stacks
     over whatever is open and 게임으로 돌아가기 is the only way out of it (the shell also closes it on Escape). */
  console.log('2026-09-09: ESC 닫기 ↔ 일시정지 ↔ 아이템 창 (메뉴는 위에 쌓인다)');
  const screens = () => P(() => {
    const ctx = window.__game.ctx;
    const vis = (e) => !!e && !e.hidden && !e.classList.contains('hidden') && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
    return { blockers: [...ctx.uiBlockers].sort(), invOpen: ctx.inventory.isOpen, menu: vis(document.querySelector('.menu.pause')), cursor: ctx.input.isCursorMode };
  });
  const escTap = async () => { await keyDown('Escape'); await keyUp('Escape'); await waitSim(0.2); };
  const resumeClick = async () => {
    await P(() => { [...document.querySelector('.menu.pause').querySelectorAll('.actions .ui-btn')][0].click(); });
    await waitSim(0.2);
  };
  await startMission(31);
  await escTap();
  let sc = await screens();
  ok(sc.menu && sc.blockers.join() === 'menu', 'Escape in a raid opens the 일시정지 메뉴', JSON.stringify(sc));
  await escTap();
  sc = await screens();
  ok(sc.menu, 'a second Escape is inert — the menu never closes on the key', JSON.stringify(sc));
  await resumeClick();
  sc = await screens();
  ok(!sc.menu && sc.blockers.length === 0, '게임으로 돌아가기 is what closes it', JSON.stringify(sc));

  const openBox = (id) => P((cid) => { const ctx = window.__game.ctx; ctx.inventory.openContainerItems(cid, [ctx.loot.createItem('ammo_light', 10)], ctx.player.position.clone(), '테스트 상자'); }, id);
  await openBox('flow:1');
  await waitSim(0.3);
  await escTap();
  sc = await screens();
  ok(!sc.invOpen && !sc.menu && sc.blockers.length === 0,
     'Escape over an open container **closes it** and opens nothing (2026-09-09)', JSON.stringify(sc));
  // the menu still stacks over a screen — it just is not Escape that puts it there any more
  await openBox('flow:2');
  await waitSim(0.3);
  await P(() => window.__game.ctx.bus.emit('game:paused', { paused: true }));
  await waitSim(0.2);
  sc = await screens();
  ok(sc.invOpen && sc.menu && sc.blockers.join() === 'inventory,menu',
     'the 일시정지 메뉴 stacks over an open container — both blockers held', JSON.stringify(sc));
  await resumeClick();
  sc = await screens();
  ok(sc.invOpen && !sc.menu && sc.blockers.join() === 'inventory',
     '돌아가기 returns to the container it was opened over', JSON.stringify(sc));
  await P(() => window.__game.ctx.inventory.toggleBag());
  await waitSim(0.2);
  sc = await screens();
  ok(!sc.invOpen && !sc.menu && sc.blockers.length === 0 && !sc.cursor, 'closing the container leaves nothing behind', JSON.stringify(sc));

  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort (phase 12 block)', 20000);

  console.log('2026-09-10: 탈출 함선 — 열린 뒷문 · 함께 올라가기 · 조명 개수 고정');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub (extraction)');
  await resetEv();
  await startMission(77);
  await P(() => {
    // Lights three.js would actually upload. An invisible ancestor removes them from the count, and any change
    // in that count recompiles the shader of every material in the scene — the freeze when the ship arrived.
    window.__lights = () => { let n = 0; window.__game.ctx.scene.traverseVisible((o) => { if (o.isLight && !o.isAmbientLight) n++; }); return n; };
  });
  const lights0 = await P(() => window.__lights());
  const activated = await P(() => {
    const ctx = window.__game.ctx;
    const pts = ctx.world.getExtractionPoints();
    if (!pts.length) return false;
    ctx.player.teleport(pts[0].position.clone());
    const it = ctx.interactables.all().find((i) => i.id.startsWith('extract_'));
    if (!it) return false;
    it.interact();
    return true;
  });
  ok(activated, 'extraction console activated');
  await waitSim(0.3);
  ok((await P(() => window.__lights())) === lights0, '신호탄이 붙어도 씬의 조명 개수가 그대로다', `${lights0}`);

  await P(() => { window.__game.getSystem('extraction').countdown = 12.5; });
  await waitFor(page, () => window.__ev['extraction:shipIncoming'].length > 0, 'shipIncoming', 40000);
  await waitSim(0.4);
  ok((await P(() => window.__game.getSystem('extraction').ship.body.visible)), '함선이 나타난다 (body.visible)');
  ok((await P(() => window.__lights())) === lights0, '함선이 나타나도 씬의 조명 개수가 그대로다', `${lights0}`);

  await waitFor(page, () => window.__ev['extraction:shipLanded'].length > 0, 'shipLanded', 60000);
  await waitSim(2.0);   // the ramp opens over 1.5 s
  const blocked = await P(() => {
    // Nothing of the hull may straddle the doorway plane (ship-local z = 0.45) inside the opening — only the ramp,
    // which lives in its own group, ever closes it.
    const ship = window.__game.getSystem('extraction').ship;
    const bad = [];
    for (const o of ship.body.children) {
      if (!o.isMesh || !o.geometry) continue;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox, p = o.position, s = o.scale;
      const min = { x: bb.min.x * s.x + p.x, y: bb.min.y * s.y + p.y, z: bb.min.z * s.z + p.z };
      const max = { x: bb.max.x * s.x + p.x, y: bb.max.y * s.y + p.y, z: bb.max.z * s.z + p.z };
      if (min.z <= 0.45 && max.z >= 0.45 && min.x < 1.4 && max.x > -1.4 && min.y < 2.4 && max.y > 0.15) bad.push(o.geometry.type);
    }
    return bad;
  });
  ok(blocked.length === 0, '뒷문 자리가 뚫려 있다 (램프만이 닫는다)', JSON.stringify(blocked));

  await P(() => {
    const ship = window.__game.getSystem('extraction').ship;
    const p = new (ship.root.position.constructor)(0, 0, -2.5).applyMatrix4(ship.root.matrixWorld);
    window.__game.ctx.player.teleport(p, undefined, false);
  });
  await waitSim(0.5);
  ok(await P(() => window.__ev['extraction:boarded'].length > 0 && window.__game.ctx.player.isInShip), 'player boarded the bay');
  await P(() => {
    window.__ride = [];
    const sys = window.__game.getSystem('extraction'), ctx = window.__game.ctx;
    sys.liftoff();
    const id = setInterval(() => {
      const pos = ctx.player.position;
      window.__ride.push({ shipY: sys.ship.root.position.y, py: pos.y, gap: pos.y - sys.ship.floorYAt(pos.x, pos.z) });
      if (window.__ride.length > 60) clearInterval(id);
    }, 60);
  });
  await waitSim(4.0);
  const ride = await P(() => window.__ride);
  const climb = ride[ride.length - 1].shipY - ride[0].shipY;
  const rider = ride[ride.length - 1].py - ride[0].py;
  const worstGap = Math.max(...ride.map((s) => Math.abs(s.gap)));
  ok(climb > 10, '함선이 실제로 올라간다', `${climb.toFixed(2)} m`);
  ok(Math.abs(rider - climb) < 0.6, '탑승자가 함선과 함께 올라간다', `ship ${climb.toFixed(2)} m vs player ${rider.toFixed(2)} m`);
  ok(worstGap < 0.35, '탑승자가 데크에서 떨어지지 않는다', `worst ${worstGap.toFixed(3)} m`);
  ok((await P(() => window.__lights())) === lights0, '이륙 뒤에도 조명 개수가 그대로다', `${lights0}`);
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'abort (extraction)', 20000);

  // cleanly back to the hub
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub (end)');

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));   // no relay running: the net client's socket error is expected
  ok(gameErrors.length === 0, 'no console errors', gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++; console.log('  FAIL', e.message);
  console.log(errors.slice(0, 10).join('\n'));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
