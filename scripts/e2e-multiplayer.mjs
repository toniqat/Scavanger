// Two-client multiplayer smoke test: headless Chrome ×2 → relay server → lobby → mission.
// Usage: node scripts/e2e-multiplayer.mjs [http://localhost:5173]
// Requires `npm run server` and `npm run dev` to be running (or `npm run dev:all`).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, label, timeout = 15000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* page still loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const LAUNCH = {
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox',
  ],
};
// One browser per client: a second tab in the same window would be hidden and rAF/timer throttled.
const browsers = [];
const errors = { A: [], B: [] };
const pages = {};
async function open(tag) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  pages[tag] = page;
  await page.setViewport({ width: 960, height: 540 });
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net, `${tag} boot`);
  // Background tabs get no requestAnimationFrame in Chrome; drive Engine.frame() from a timer when rAF stalls.
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  return page;
}

try {
  console.log('boot two clients');
  const A = await open('A');
  const B = await open('B');

  console.log('lobby');
  await A.evaluate(async () => { const n = window.__game.ctx.net; n.setPlayerName('호스트'); await n.connect(); n.createLobby(); });
  const code = await waitFor(A, () => window.__game.ctx.net.lobby?.code, 'A lobby code');
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), `lobby code ${code}`);
  ok(await A.evaluate(() => window.__game.ctx.net.isHost), 'A is host');
  ok(await A.evaluate(() => window.__game.ctx.net.getInviteUrl()?.includes('?lobby=')), 'invite url has ?lobby=');
  // Lobby UI should be visible on A (menu class 'lobby', not hidden)
  ok(await A.evaluate(() => { const el = document.querySelector('.menu.lobby'); return !!el && !el.classList.contains('hidden'); }), 'A shows LobbyMenu');

  await B.evaluate(async (c) => { const n = window.__game.ctx.net; n.setPlayerName('분대원'); await n.connect(); n.joinLobby(c); }, code);
  await waitFor(B, () => window.__game.ctx.net.lobby?.players.length === 2, 'B joined');
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A sees 2 players');
  ok(true, 'both see 2 players');
  ok(await A.evaluate(() => document.querySelectorAll('.menu.lobby .slot, .menu.lobby [class*="slot"]').length > 0), 'A lobby renders slot cards');

  // start refused before ready
  await A.evaluate(() => window.__game.ctx.net.startGame(42));
  await sleep(400);
  ok(await A.evaluate(() => window.__game.ctx.phase === 'menu'), 'start refused while not ready');

  await A.evaluate(() => window.__game.ctx.net.setReady(true));
  await B.evaluate(() => window.__game.ctx.net.setReady(true));
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.every((p) => p.ready), 'all ready');
  await A.evaluate(() => window.__game.ctx.net.startGame(42));

  console.log('mission start');
  await waitFor(A, () => window.__game.ctx.phase !== 'menu', 'A left menu');
  await waitFor(B, () => window.__game.ctx.phase !== 'menu', 'B left menu');
  ok(await A.evaluate(() => window.__game.ctx.world?.seed === 42), 'A world seed 42');
  ok(await B.evaluate(() => window.__game.ctx.world?.seed === 42), 'B world seed 42');
  ok(await A.evaluate(() => window.__game.ctx.isAuthority && window.__game.ctx.isMultiplayer), 'A authority + multiplayer');
  ok(await B.evaluate(() => !window.__game.ctx.isAuthority && window.__game.ctx.isMultiplayer), 'B non-authority + multiplayer');

  await waitFor(A, () => window.__game.ctx.phase === 'playing', 'A playing', 20000);
  await waitFor(B, () => window.__game.ctx.phase === 'playing', 'B playing', 20000);
  ok(true, 'both reached playing');

  console.log('remote players');
  await waitFor(A, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'A remote avatar');
  await waitFor(B, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'B remote avatar');
  const aLocal = await A.evaluate(() => { const p = window.__game.ctx.player.position; return [p.x, p.y, p.z]; });
  const bSeesA = await B.evaluate(() => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return { p: [r.position.x, r.position.y, r.position.z], name: r.name, slot: r.slot, stale: r.stale, hp: r.hp }; });
  const dist = Math.hypot(aLocal[0] - bSeesA.p[0], aLocal[2] - bSeesA.p[2]);
  ok(dist < 3, `B sees A within 3 m (d=${dist.toFixed(2)})`);
  ok(bSeesA.name === '호스트' && bSeesA.slot === 0 && !bSeesA.stale && bSeesA.hp === 100, `B remote ref fields ${JSON.stringify(bSeesA)}`);
  const spawnSep = await Promise.all([A, B].map((p) => p.evaluate(() => { const l = window.__game.ctx.player.position, r = window.__game.ctx.net.getRemotePlayers()[0].position; return Math.hypot(l.x - r.x, l.z - r.z); })));
  ok(spawnSep.every((d) => d > 2 && d < 12), `spawn slots separated (${spawnSep.map((d) => d.toFixed(1)).join(', ')} m)`);
  ok(await B.evaluate(() => { const els = document.querySelectorAll('.nameplate, [class*="nameplate"]'); return els.length >= 1; }), 'B renders a nameplate');
  ok(await B.evaluate(() => { const el = document.querySelector('[class*="squad"]'); return !!el && el.textContent.includes('호스트'); }), 'B squad panel lists host');

  console.log('movement interpolation');
  // Teleport A 6 m forward and check B's view follows within ~1 s.
  await A.evaluate(() => { const p = window.__game.ctx.player; p.respawnAt(p.position.clone().add(new (p.position.constructor)(6, 0, 0)), 0); });
  const aNew = await A.evaluate(() => window.__game.ctx.player.position.x);
  const bx = await waitFor(B, (x) => { const bx = window.__game.ctx.net.getRemotePlayers()[0].position.x; return Math.abs(x - bx) < 1.5 ? bx : 0; }, 'interp', 5000, aNew).catch(() => NaN);
  ok(Math.abs(aNew - bx) < 1.5, `B interpolated to A's new x (Δ=${Math.abs(aNew - bx).toFixed(2)})`);

  console.log('enemies replication');
  const aAlive = await waitFor(A, () => window.__game.ctx.enemies.getAliveCount() > 0 ? window.__game.ctx.enemies.getAliveCount() : 0, 'A enemies alive');
  const bAlive = await waitFor(B, () => window.__game.ctx.enemies.getEnemies().length > 0 ? window.__game.ctx.enemies.getEnemies().length : 0, 'B replica enemies');
  ok(Math.abs(aAlive - bAlive) <= 3, `enemy counts host=${aAlive} client=${bAlive}`);
  const idMatch = await Promise.all([A, B].map((p) => p.evaluate(() => window.__game.ctx.enemies.getEnemies().map((e) => e.id).sort((a, b) => a - b).slice(0, 5))));
  ok(JSON.stringify(idMatch[0]) === JSON.stringify(idMatch[1]), `enemy ids match ${JSON.stringify(idMatch[0])} vs ${JSON.stringify(idMatch[1])}`);

  console.log('client hit → host damage');
  const target = await B.evaluate(() => { const e = window.__game.ctx.enemies.getEnemies().find((x) => !x.isDead); return e ? { id: e.id, hp: e.hp } : null; });
  ok(!!target, 'B has a live replica to shoot');
  if (target) {
    const hostHpBefore = await A.evaluate((id) => window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp, target.id);
    await B.evaluate((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); const V = e.position.constructor; e.takeDamage(10, e.position.clone().add(new V(0, 0.5, 0)), new V(0, 0, 1)); }, target.id);
    const hostHpAfter = await waitFor(A, (id) => { const hp = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp; return hp !== undefined && hp < 60 ? hp : 0; }, 'host applies hit', 5000, target.id);
    ok(hostHpAfter !== undefined && hostHpAfter < hostHpBefore, `host applied client hit (${hostHpBefore} → ${hostHpAfter})`);
    const clientHp = await waitFor(B, (id) => { const hp = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp; return hp !== undefined && hp < 60 ? hp : 0; }, 'client mirrors hp', 5000, target.id).catch(() => undefined);
    ok(clientHp !== undefined && Math.abs(clientHp - hostHpAfter) < 1, `client hp mirrors host (${clientHp})`);
  }

  console.log('fire replication');
  await B.evaluate(() => { window.__fired = 0; window.__game.ctx.bus.on('net:remoteFired', () => window.__fired++); });
  await A.evaluate(() => window.__game.ctx.net.send({ t: 'fire', w: 'ar_liberator', o: [0, 2, 0], d: [0, 0, 1] }));
  ok(!!(await waitFor(B, () => window.__fired === 1, 'remoteFired', 5000).catch(() => false)), 'B received net:remoteFired');

  console.log('ping replication');
  await B.evaluate(() => { window.__ping = 0; window.__game.ctx.bus.on('net:remotePing', () => window.__ping++); });
  await A.evaluate(() => window.__game.ctx.net.send({ t: 'ping', p: [1, 0, 1], kind: 'ground' }));
  ok(!!(await waitFor(B, () => window.__ping === 1, 'remotePing', 5000).catch(() => false)), 'B received net:remotePing');

  console.log('extraction request path');
  const padId = await A.evaluate(() => window.__game.ctx.world.getExtractionPoints()[0].id);
  await B.evaluate((id) => window.__game.ctx.net.send({ t: 'exq', ev: 'activate', padId: id }, 'host'), padId);
  await waitFor(A, () => window.__game.ctx.phase === 'extracting', 'host extracting after client request');
  await waitFor(B, () => window.__game.ctx.phase === 'extracting', 'client mirrors extracting');
  ok(true, 'extraction activated on both via client request');
  for (const p of [A, B]) await p.evaluate(() => { window.__rem = -1; window.__game.ctx.bus.on('extraction:tick', ({ remaining }) => { window.__rem = remaining; }); });
  await waitFor(A, () => window.__rem > 0, 'host tick', 5000);
  await waitFor(B, () => window.__rem > 0, 'client tick', 5000);
  const rem = await Promise.all([A, B].map((p) => p.evaluate(() => window.__rem)));
  ok(Math.abs(rem[0] - rem[1]) < 1.5, `countdown mirrored (host ${rem[0].toFixed(1)} / client ${rem[1].toFixed(1)})`);

  console.log('host pause keeps simulating');
  await A.evaluate(() => window.__game.ctx.bus.emit('game:paused', { paused: true, freeze: false }));
  const t1 = await A.evaluate(() => window.__game.ctx.missionTime);
  await sleep(500);
  const t2 = await A.evaluate(() => window.__game.ctx.missionTime);
  ok(t2 > t1, 'missionTime advances during multiplayer pause');
  await A.evaluate(() => window.__game.ctx.bus.emit('game:paused', { paused: false, freeze: false }));

  console.log('host abort → squad returns to lobby');
  await A.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(A, () => window.__game.ctx.phase === 'menu', 'A menu');
  await waitFor(B, () => window.__game.ctx.phase === 'menu', 'B menu (flow abort)');
  await waitFor(A, () => window.__game.ctx.net.lobby && !window.__game.ctx.net.lobby.started && !window.__game.ctx.net.inSession, 'lobby reset');
  ok(true, 'both back in an un-started lobby');
  ok(await B.evaluate(() => window.__game.ctx.net.getRemotePlayers().length === 0), 'B remote players cleared');
  ok(await B.evaluate(() => { const el = document.querySelector('.menu.lobby'); return !!el && !el.classList.contains('hidden'); }), 'B shows LobbyMenu again');

  console.log('peer leave');
  await B.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 1, 'A sees B leave');
  ok(true, 'A lobby has 1 player after B left');

  const errA = errors.A.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarker/i.test(e));
  const errB = errors.B.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarker/i.test(e));
  ok(errA.length === 0, 'A: no console errors', errA.slice(0, 3).join(' | '));
  ok(errB.length === 0, 'B: no console errors', errB.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  for (const [tag, page] of Object.entries(pages)) {
    try { console.log(`  ${tag} state:`, await page.evaluate(() => ({ phase: window.__game.ctx.phase, time: window.__game.ctx.time, hidden: document.hidden, net: window.__game.ctx.net.status, inSession: window.__game.ctx.net.inSession, remotes: window.__game.ctx.net.getRemotePlayers().length }))); } catch { /* ignore */ }
  }
  console.log('  A errors:', errors.A.slice(0, 5));
  console.log('  B errors:', errors.B.slice(0, 5));
} finally {
  await Promise.all(browsers.map((b) => b.close()));
}
console.log(`\ne2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
