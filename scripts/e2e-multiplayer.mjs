// Two-client multiplayer smoke test: headless Chrome ×2 → relay server → personal ship → quick match →
// docking → shared ship → launch pods → mission → pickups sync → reconnect → abort back to the ship.
// Usage: node scripts/e2e-multiplayer.mjs [http://localhost:5273]
// Requires `npm run server` and `npm run dev` to be running (or `npm run dev:all`).
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
    '--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--window-size=960,540', '--no-sandbox',
  ],
};
// One browser per client: a second tab in the same window would be hidden and rAF/timer throttled.
// Separate browsers also mean separate localStorage → distinct session tokens.
const browsers = [];
const errors = { A: [], B: [] };
const pages = {};
async function open(tag) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  pages[tag] = page;
  await page.setViewport({ width: 960, height: 540 });
  // Never let headless Chrome take a real pointer lock: on Windows it calls ClipCursor and traps the OS cursor inside the
  // hidden 960×540 window at the top-left of the screen. Scripts fake `pointerLockElement` themselves where they need it.
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
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
const hubShip = (page) => page.evaluate(() => ({ phase: window.__game.ctx.phase, ship: window.__game.ctx.hub?.ship ?? null }));
const boardPod = (page) => page.evaluate(() => {
  const ctx = window.__game.ctx;
  const slot = ctx.net.localSlot;
  const pod = ctx.interactables.all().find((i) => i.id === `hub_pod_${slot}`);
  if (!pod || !pod.canInteract()) return `pod ${slot} unavailable (${ctx.interactables.all().map((i) => i.id).join(',')})`;
  pod.interact();
  return 'ok';
});

try {
  console.log('boot two clients');
  const A = await open('A');
  const B = await open('B');

  console.log('personal ship');
  await A.evaluate(() => { window.__game.ctx.net.setPlayerName('호스트'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub?.ship === 'personal', 'A personal ship');
  ok(await A.evaluate(() => !!window.__game.ctx.hub.collider && !!window.__game.ctx.player.interior), 'A interior collider set on player');
  ok(await A.evaluate(() => window.__game.ctx.world === null || !window.__game.ctx.world.ready), 'A no world in the hub');
  await waitFor(A, () => window.__game.ctx.net.connected, 'A auto-connected');
  ok(await A.evaluate(() => typeof window.__game.ctx.net.sessionToken === 'string' && window.__game.ctx.net.sessionToken.length === 24), 'A has a 24-char session token');

  console.log('quick match → docking → shared ship');
  await A.evaluate(() => { window.__matched = null; window.__game.ctx.bus.on('net:matched', (e) => { window.__matched = e; }); window.__game.ctx.net.quickMatch(); });
  const code = await waitFor(A, () => window.__game.ctx.net.lobby?.code, 'A lobby code');
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), `lobby code ${code}`);
  ok(await A.evaluate(() => window.__game.ctx.net.isHost && window.__game.ctx.net.lobby.isPublic), 'A is host of a public ship');
  ok(!!(await waitFor(A, () => window.__matched && window.__matched.created === true, 'net:matched', 5000).catch(() => false)), 'A got net:matched {created:true}');
  await waitFor(A, () => window.__game.ctx.phase === 'docking', 'A docking cutscene', 8000);
  ok(true, 'A docking cutscene started');
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'A shared ship', 20000);
  ok(true, 'A arrived in the shared ship');

  await B.evaluate(() => { window.__game.ctx.net.setPlayerName('분대원'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.connected, 'B personal + connected');
  await B.evaluate(() => window.__game.ctx.net.quickMatch());
  const codeB = await waitFor(B, () => window.__game.ctx.net.lobby?.code, 'B lobby code');
  ok(codeB === code, `B quick-matched into A's ship (${codeB})`);
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'B shared ship', 20000);
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A sees 2 players');
  ok(true, 'both in the shared ship, 2 players');

  console.log('hub presence');
  await waitFor(A, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'A hub remote avatar', 10000);
  ok(await A.evaluate(() => (window.__game.ctx.net.getRemotePlayers()[0].flags & (1 << 12)) !== 0), 'remote ref carries IN_HUB flag');
  ok(await A.evaluate(() => window.__game.ctx.net.inHubSession), 'A inHubSession');
  ok(await A.evaluate(() => { const el = document.querySelector('[class*="squad"]'); return !!el && el.textContent.includes('분대원'); }), 'A squad panel lists 분대원 in the hub');

  console.log('chat relay (hub)');
  await A.evaluate(() => { window.__chat = null; window.__game.ctx.bus.on('net:chat', (e) => { window.__chat = e; }); });
  await B.evaluate(() => window.__game.ctx.bus.emit('chat:post', { text: '안녕', kind: 'text' }));
  const chat = await waitFor(A, () => window.__chat, 'chat', 5000).catch(() => null);
  ok(chat && chat.text === '안녕' && chat.name === '분대원', `A received chat ${JSON.stringify(chat)}`);
  ok(await A.evaluate(() => !!document.querySelector('.chat') && document.querySelector('.chat').textContent.includes('안녕')), 'A chat log shows the line');

  console.log('launch pods');
  await A.evaluate(() => window.__game.ctx.net.startGame(42));
  await sleep(400);
  ok((await hubShip(A)).phase === 'hub', 'start refused while nobody is in a pod');
  await A.evaluate(() => window.__game.ctx.net.setLobbySeed(42));
  await waitFor(B, () => window.__game.ctx.net.lobby?.seed === 42, 'B sees seed 42');
  ok(true, 'seed shared through the lobby');
  const bA = await boardPod(A);
  ok(bA === 'ok', `A boards pod (${bA})`);
  await waitFor(A, () => window.__game.ctx.player.isInPod && window.__game.ctx.net.lobby.players.find((p) => p.isHost).ready, 'A in pod + ready');
  ok(true, 'A in pod → ready');
  await waitFor(B, () => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return r && (r.flags & (1 << 11)) !== 0; }, 'B sees A IN_POD', 5000);
  ok(true, 'B sees A IN_POD');
  await B.evaluate(() => { window.__cd = []; window.__game.ctx.bus.on('hub:launchCountdown', (e) => window.__cd.push(e.seconds)); });
  const bB = await boardPod(B);
  ok(bB === 'ok', `B boards pod (${bB})`);

  console.log('mission start');
  await waitFor(A, () => window.__game.ctx.phase !== 'hub' && window.__game.ctx.phase !== 'docking', 'A left hub', 60000);
  await waitFor(B, () => window.__game.ctx.phase !== 'hub' && window.__game.ctx.phase !== 'docking', 'B left hub', 15000);
  ok(await B.evaluate(() => window.__cd.length > 0), `B mirrored launch countdown (${await B.evaluate(() => JSON.stringify(window.__cd))})`);
  ok(await A.evaluate(() => window.__game.ctx.hub.ship === null && window.__game.ctx.player.interior === null), 'A hub torn down');
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
  const bSeesA = await waitFor(B, (ax) => { const r = window.__game.ctx.net.getRemotePlayers()[0]; if (!r || Math.abs(r.position.x - ax) > 3) return null; return { p: [r.position.x, r.position.y, r.position.z], name: r.name, slot: r.slot, stale: r.stale, hp: r.hp }; }, 'B converges on A', 8000, aLocal[0]);
  const dist = Math.hypot(aLocal[0] - bSeesA.p[0], aLocal[2] - bSeesA.p[2]);
  ok(dist < 3, `B sees A within 3 m (d=${dist.toFixed(2)})`);
  ok(bSeesA.name === '호스트' && bSeesA.slot === 0 && !bSeesA.stale && bSeesA.hp === 100, `B remote ref fields ${JSON.stringify(bSeesA)}`);
  ok(await B.evaluate(() => document.querySelectorAll('.nameplate, [class*="nameplate"]').length >= 1), 'B renders a nameplate');

  console.log('movement interpolation');
  await A.evaluate(() => { const p = window.__game.ctx.player; p.respawnAt(p.position.clone().add(new (p.position.constructor)(6, 0, 0)), 0); });
  const aNew = await A.evaluate(() => window.__game.ctx.player.position.x);
  const bx = await waitFor(B, (x) => { const bx = window.__game.ctx.net.getRemotePlayers()[0].position.x; return Math.abs(x - bx) < 1.5 ? bx : 0; }, 'interp', 5000, aNew).catch(() => NaN);
  ok(Math.abs(aNew - bx) < 1.5, `B interpolated to A's new x (Δ=${Math.abs(aNew - bx).toFixed(2)})`);

  console.log('enemies replication');
  const aAlive = await waitFor(A, () => window.__game.ctx.enemies.getAliveCount() > 0 ? window.__game.ctx.enemies.getAliveCount() : 0, 'A enemies alive');
  const bAlive = await waitFor(B, () => window.__game.ctx.enemies.getEnemies().length > 0 ? window.__game.ctx.enemies.getEnemies().length : 0, 'B replica enemies');
  ok(Math.abs(aAlive - bAlive) <= 3, `enemy counts host=${aAlive} client=${bAlive}`);

  console.log('client hit → host damage');
  const target = await B.evaluate(() => { const e = window.__game.ctx.enemies.getEnemies().find((x) => !x.isDead); return e ? { id: e.id, hp: e.hp } : null; });
  ok(!!target, 'B has a live replica to shoot');
  if (target) {
    const hostHpBefore = await A.evaluate((id) => window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp, target.id);
    await B.evaluate((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); const V = e.position.constructor; e.takeDamage(10, e.position.clone().add(new V(0, 0.5, 0)), new V(0, 0, 1)); }, target.id);
    const hostHpAfter = await waitFor(A, (id) => { const hp = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp; return hp !== undefined && hp < 60 ? hp : 0; }, 'host applies hit', 5000, target.id);
    ok(hostHpAfter !== undefined && hostHpAfter < hostHpBefore, `host applied client hit (${hostHpBefore} → ${hostHpAfter})`);
  }

  console.log('ping v2 relay');
  await B.evaluate(() => { window.__ping = null; window.__game.ctx.net.onMessage('ping', (m) => { window.__ping = m; }); });
  await A.evaluate(() => window.__game.ctx.net.send({ t: 'ping', p: [1, 0, 1], kind: 'attack', label: '돌격' }));
  const ping = await waitFor(B, () => window.__ping, 'ping', 5000).catch(() => null);
  ok(ping && ping.kind === 'attack' && ping.label === '돌격', `B received attack ping ${JSON.stringify(ping)}`);
  ok(!!(await waitFor(B, () => document.querySelectorAll('.pmarker.attack').length === 1, 'attack marker', 3000).catch(() => false)), 'B renders the remote attack marker');

  console.log('pickup sync (host drop → client take)');
  const dropped = await A.evaluate(() => {
    const ctx = window.__game.ctx;
    const stack = ctx.inventory.getAllItems().find((i) => i.qty >= 2);
    if (!stack) return null;
    ctx.inventory.dropItem(stack.uid, 1);
    return { defId: stack.defId };
  });
  ok(!!dropped, `A dropped one ${dropped?.defId}`);
  const pickupId = await waitFor(B, () => window.__game.ctx.pickups.getPickups()[0]?.id, 'B sees pickup', 8000);
  ok(!!pickupId, `B replicated pickup ${pickupId}`);
  const bBagBefore = await B.evaluate((d) => window.__game.ctx.inventory.countWhere((def) => def.id === d), dropped.defId);
  await B.evaluate((id) => { const it = window.__game.ctx.interactables.all().find((i) => i.id === `pickup:${id}`); it.interact(); }, pickupId);
  const bBagAfter = await waitFor(B, (arg) => { const n = window.__game.ctx.inventory.countWhere((def) => def.id === arg.d); return n > arg.b ? n : 0; }, 'B bag grows', 8000, { d: dropped.defId, b: bBagBefore });
  ok(bBagAfter === bBagBefore + 1, `B took the item (${bBagBefore} → ${bBagAfter})`);
  await waitFor(A, () => window.__game.ctx.pickups.getPickups().length === 0, 'A pickup removed', 8000);
  ok(true, 'host removed the pickup after the client took it');

  console.log('extraction request path');
  const padId = await A.evaluate(() => window.__game.ctx.world.getExtractionPoints()[0].id);
  await B.evaluate((id) => window.__game.ctx.net.send({ t: 'exq', ev: 'activate', padId: id }, 'host'), padId);
  await waitFor(A, () => window.__game.ctx.phase === 'extracting', 'host extracting after client request');
  await waitFor(B, () => window.__game.ctx.phase === 'extracting', 'client mirrors extracting');
  ok(true, 'extraction activated on both via client request');

  console.log('client socket drop → seamless resume');
  await A.evaluate(() => { window.__connFlags = []; window.__game.ctx.bus.on('net:lobbyUpdated', ({ lobby }) => window.__connFlags.push(lobby.players.map((p) => p.connected).join(''))); });
  await B.evaluate(() => { window.__resumed = null; window.__game.ctx.bus.on('net:resumed', (e) => { window.__resumed = e; }); window.__game.getSystem('net').client.ws.close(); });
  await waitFor(B, () => window.__game.ctx.net.reconnecting, 'B reconnecting', 5000);
  ok(true, 'B entered reconnecting state');
  await waitFor(A, () => window.__connFlags.some((f) => f.includes('0') || f.includes('false')), 'A sees B disconnected', 5000).catch(() => null);
  const resumed = await waitFor(B, () => window.__resumed, 'B resumed', 15000);
  ok(resumed.seamless === true && resumed.lobby.code === code, `B resumed seamlessly ${JSON.stringify({ seamless: resumed.seamless, inProgress: resumed.inProgress })}`);
  ok(await B.evaluate(() => window.__game.ctx.phase === 'extracting' && window.__game.ctx.isMultiplayer), 'B still in the mission after resume');
  await waitFor(A, () => window.__game.ctx.net.lobby.players.every((p) => p.connected), 'A sees B reconnected', 5000);
  ok(true, 'A sees B connected again');
  const remRem = await waitFor(B, () => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return r && !r.stale ? 1 : 0; }, 'B remote fresh', 5000).catch(() => 0);
  ok(remRem === 1, 'B gets fresh snapshots from A after resume');

  console.log('host abort → squad returns to the shared ship');
  await A.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'A shared ship after abort', 10000);
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'B shared ship (flow abort)', 10000);
  await waitFor(A, () => window.__game.ctx.net.lobby && !window.__game.ctx.net.lobby.started && !window.__game.ctx.net.inSession, 'lobby reset');
  ok(true, 'both back in the shared ship, lobby un-started');
  ok(await A.evaluate(() => !window.__game.ctx.player.isInPod && !window.__game.ctx.net.lobby.players.some((p) => p.ready)), 'pods empty after reset');

  console.log('peer leave → undock');
  await B.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 1, 'A sees B leave');
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'personal', 'B back in personal ship', 15000);
  ok(true, 'B undocked to the personal ship, A ship has 1 player');
  // Leave cleanly so the relay does not keep A's slot (5-min reconnect grace) for the next run.
  await A.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.net.lobby === null, 'A left');

  const errA = errors.A.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarker/i.test(e));
  const errB = errors.B.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarker|WebSocket connection/i.test(e));
  ok(errA.length === 0, 'A: no console errors', errA.slice(0, 3).join(' | '));
  ok(errB.length === 0, 'B: no console errors (socket-drop noise ignored)', errB.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  for (const [tag, page] of Object.entries(pages)) {
    try { console.log(`  ${tag} state:`, await page.evaluate(() => ({ phase: window.__game.ctx.phase, ship: window.__game.ctx.hub?.ship, time: window.__game.ctx.time, hidden: document.hidden, net: window.__game.ctx.net.status, inSession: window.__game.ctx.net.inSession, lobby: window.__game.ctx.net.lobby?.code, remotes: window.__game.ctx.net.getRemotePlayers().length }))); } catch { /* ignore */ }
  }
  console.log('  A errors:', errors.A.slice(0, 5));
  console.log('  B errors:', errors.B.slice(0, 5));
} finally {
  await Promise.all(browsers.map((b) => b.close()));
}
console.log(`\ne2e: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
