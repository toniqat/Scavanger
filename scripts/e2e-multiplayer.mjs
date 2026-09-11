// Two-client multiplayer smoke test: headless Chrome ×2 → relay server → personal ship → quick match →
// docking → shared ship → launch pods → mission → pickups sync → reconnect → abort back to the ship.
// Phase 7 additions: server profile (`ctx.net.profile`, credits transaction), suspended peer flags while a squadmate's
// socket is down, and mid-mission HOST MIGRATION (host offline > NET_HOST_MIGRATE_DELAY_MS → the client takes over,
// the returning host resumes demoted; the new host then aborts the mission for everyone).
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
    // 2026-09-08: 이 스크립트는 튜토리얼을 검사하지 않는다. 튜토리얼은 새 프로필에서 자동으로 시작해
    // 방 용도 · 제작 · 터미널 · 탑승을 순서대로 잠그므로, 여기서는 "이미 끝난 것"으로 표시해 둔다
    // (튜토리얼 자체는 scripts/smoke-tutorial.mjs 가 본다).
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net, `${tag} boot`);
  // Phase 7 listeners must be armed before the hub connects (profile arrives with `welcome`).
  await page.evaluate(() => {
    const bus = window.__game.ctx.bus;
    window.__profileLoaded = null; bus.on('net:profileLoaded', (e) => { window.__profileLoaded = e; });
    window.__susp = []; bus.on('net:peerSuspended', (e) => window.__susp.push(e));
    window.__hostChanged = []; bus.on('net:hostChanged', (e) => window.__hostChanged.push(e));
    window.__membership = []; bus.on('net:missionMembership', (e) => window.__membership.push(e));
    window.__resumedEv = []; bus.on('net:resumed', (e) => window.__resumedEv.push(e));
    /* Phase 11: 행성 + 소셜 */
    window.__gameStarting = []; bus.on('net:gameStarting', (e) => window.__gameStarting.push({ seed: e.seed, mode: e.mode, planet: e.planet ?? null }));
    window.__newMission = []; bus.on('game:newMission', (e) => window.__newMission.push({ seed: e.seed, mode: e.mode ?? 'raid', planet: e.planet ?? null }));
    window.__socialUpdated = []; bus.on('social:updated', (e) => window.__socialUpdated.push({ first: e.first, friends: e.snapshot.friends.length, incoming: e.snapshot.incoming.length }));
    window.__whispers = []; bus.on('social:whisper', (e) => window.__whispers.push({ ...e.line }));
    window.__socialPlay = []; bus.on('social:play', (e) => window.__socialPlay.push(e));
    window.__socialErr = []; bus.on('social:error', (e) => window.__socialErr.push({ code: e.code, message: e.message }));
    window.__travel = []; bus.on('hub:travel', (e) => window.__travel.push({ stage: e.stage, planet: e.planet }));
    window.__planetChanged = []; bus.on('hub:planetChanged', (e) => window.__planetChanged.push({ planet: e.planet, by: e.by }));
  });
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
  // 2026-09-08: 출격 준비 경고 (주무기 · 탄약 · 가방 · 방탄복 · 임플란트 · 회복 아이템). 막지는 않으므로 확인하고 탄다.
  const warn = document.querySelector('.launch-warn');
  if (warn && !warn.hidden) [...warn.querySelectorAll('.hub-foot .ui-btn')].find((b) => b.textContent === '그래도 출격').click();
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

  console.log('server profile (Phase 7)');
  await waitFor(A, () => window.__game.ctx.net.profile.available, 'A profile available', 5000);
  const prof = await A.evaluate(() => ({ available: window.__game.ctx.net.profile.available, loaded: !!window.__profileLoaded, migrated: window.__profileLoaded?.migrated, credits: window.__game.ctx.net.profile.credits }));
  ok(prof.available && prof.loaded, `A profile loaded from welcome ${JSON.stringify(prof)}`);
  const tx = await A.evaluate(async () => { try { return await window.__game.ctx.net.profile.addCredits(0, 'e2e:probe'); } catch (e) { return { err: String(e) }; } });
  ok(tx && tx.ok === true && typeof tx.credits === 'number', `A credits transaction round trip ${JSON.stringify(tx)}`);
  const over = await A.evaluate(async () => { try { return await window.__game.ctx.net.profile.addCredits(-9999999, 'e2e:overdraft'); } catch (e) { return { err: String(e) }; } });
  ok(over && over.ok === false && over.reason === '크레딧 부족' && over.credits === tx.credits, `overdraft refused by the server ${JSON.stringify(over)}`);
  ok(await A.evaluate((c) => window.__game.ctx.net.profile.credits === c, tx.credits), 'profile.credits mirrors the server balance');

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

  console.log('implant equip in the ship (Phase 9: overcharge beam is replicated in the mission)');
  const eq = await A.evaluate(() => { const r = window.__game.ctx.implants?.setEquipped?.('overcharge'); return { r, id: window.__game.ctx.implants?.equippedId ?? null }; });
  ok(eq.r === true || eq.id === 'overcharge', `A equipped 오버차지 in the shared ship ${JSON.stringify(eq)}`);

  console.log('hub presence');
  await waitFor(A, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'A hub remote avatar', 10000);
  ok(await A.evaluate(() => (window.__game.ctx.net.getRemotePlayers()[0].flags & (1 << 12)) !== 0), 'remote ref carries IN_HUB flag');
  ok(await A.evaluate(() => window.__game.ctx.net.inHubSession), 'A inHubSession');
  ok(await A.evaluate(() => { const el = document.querySelector('[class*="squad"]'); return !!el && el.textContent.includes('분대원'); }), 'A squad panel lists 분대원 in the hub');

  console.log('crew cards (Phase 10: crew card / crewq loadout / crew loadout)');
  const aIdCrew = await A.evaluate(() => window.__game.ctx.net.localId);
  const bIdCrew = await B.evaluate(() => window.__game.ctx.net.localId);
  await B.evaluate(() => {
    window.__crewCards = []; window.__game.ctx.bus.on('net:crewCard', (e) => window.__crewCards.push({ id: e.id, level: e.card.level, implant: e.card.implant, armor: e.card.armor, primary: e.card.primary ?? null }));
    window.__crewLoadouts = []; window.__game.ctx.bus.on('net:crewLoadout', (e) => window.__crewLoadouts.push({ id: e.id, level: e.card.level, loadout: e.loadout }));
  });
  await A.evaluate(() => {
    window.__crewCards = []; window.__game.ctx.bus.on('net:crewCard', (e) => window.__crewCards.push({ id: e.id, level: e.card.level }));
    window.__crewq = []; window.__game.ctx.net.onMessage('crewq', (m, from) => window.__crewq.push({ ev: m.ev, from }));
    // hub/ owns *sending* the card; drive the wire directly so net's receive path is covered on its own.
    window.__game.ctx.net.send({ t: 'crew', ev: 'card', card: { level: 7, implant: 'overcharge', armor: 'armor_2', primary: 'ar', primary2: null, secondary: 'p9' } }, 'others');
  });
  ok(await A.evaluate((id) => { const c = window.__game.ctx.net.getCrewCard(id); return !!c && c.level === 7 && c.implant === 'overcharge'; }, aIdCrew), 'A getCrewCard(localId) returns its own broadcast card');
  ok(await A.evaluate((id) => window.__crewCards.some((c) => c.id === id && c.level === 7), aIdCrew), 'A emitted net:crewCard for its own card');
  const cardOnB = await waitFor(B, (id) => window.__crewCards.find((c) => c.id === id) ?? null, 'B net:crewCard from A', 6000, aIdCrew).catch(() => null);
  ok(cardOnB && cardOnB.level === 7 && cardOnB.implant === 'overcharge' && cardOnB.armor === 'armor_2' && cardOnB.primary === 'ar', `B received A's crew card ${JSON.stringify(cardOnB)}`);
  ok(await B.evaluate((id) => { const c = window.__game.ctx.net.getCrewCard(id); return !!c && c.level === 7 && c.secondary === 'p9'; }, aIdCrew), 'B getCrewCard(A) mirrors the card');
  ok(await B.evaluate((id) => { const r = window.__game.ctx.net.getRemotePlayer(id); return !!r && r.crewLevel === 7 && r.equippedImplant === 'overcharge'; }, aIdCrew),
    'B remote ref mirrors crewLevel / equippedImplant (distinct from the wielded implantId)');
  ok(await B.evaluate(() => window.__game.ctx.net.getCrewCard('nobody-at-all') === null), 'getCrewCard of an unknown peer is null');
  // A card with junk fields must be clamped, never thrown away. hub/ also broadcasts genuine cards on its own
  // (level up / implant / armor / loadout changes), so anchor on the count instead of first-or-last.
  const cardsBefore = await B.evaluate(() => window.__crewCards.length);
  await A.evaluate(() => window.__game.ctx.net.send({ t: 'crew', ev: 'card', card: { level: 'x', implant: 'not-an-implant', armor: 42 } }, 'others'));
  const clamped = await waitFor(B, (arg) => window.__crewCards.slice(arg.n).find((c) => c.id === arg.id) ?? null,
    'B second card', 6000, { n: cardsBefore, id: aIdCrew }).catch(() => null);
  ok(clamped && clamped.level === 1 && clamped.implant === null && clamped.armor === null, `B clamped a malformed card ${JSON.stringify(clamped)}`);
  // requestCrewLoadout → `crewq loadout` reaches A's onMessage subscriber (hub/ answers there); A answers by hand.
  await B.evaluate((id) => window.__game.ctx.net.requestCrewLoadout(id), aIdCrew);
  const req = await waitFor(A, (bid) => window.__crewq.find((m) => m.ev === 'loadout' && m.from === bid) ?? null, 'A onMessage(crewq loadout)', 6000, bIdCrew).catch(() => null);
  ok(!!req, `B's requestCrewLoadout reached A's crewq subscriber ${JSON.stringify(req)}`);
  ok(await B.evaluate((id) => { window.__game.ctx.net.requestCrewLoadout(window.__game.ctx.net.localId); return true; }, aIdCrew), 'requestCrewLoadout(localId) is a no-op (no self request)');
  await A.evaluate(() => window.__game.ctx.net.send({ t: 'crew', ev: 'loadout', card: { level: 7, implant: 'overcharge', armor: 'armor_2' }, loadout: { probe: 'e2e', slots: 5 } }, 'others'));
  const loadout = await waitFor(B, (id) => {
    const hit = window.__crewLoadouts.filter((l) => l.id === id && l.loadout && l.loadout.probe === 'e2e').pop();
    return hit ?? null;   // hub/ already answered the earlier `crewq loadout` with A's real document
  }, 'B net:crewLoadout', 6000, aIdCrew).catch(() => null);
  ok(loadout && loadout.level === 7 && loadout.loadout && loadout.loadout.probe === 'e2e', `B received A's loadout document verbatim ${JSON.stringify(loadout && loadout.loadout)}`);

  console.log('chat relay (hub)');
  await A.evaluate(() => { window.__chat = null; window.__game.ctx.bus.on('net:chat', (e) => { window.__chat = e; }); });
  await B.evaluate(() => window.__game.ctx.bus.emit('chat:post', { text: '안녕', kind: 'text' }));
  const chat = await waitFor(A, () => window.__chat, 'chat', 5000).catch(() => null);
  ok(chat && chat.text === '안녕' && chat.name === '분대원', `A received chat ${JSON.stringify(chat)}`);
  ok(await A.evaluate(() => !!document.querySelector('.chat') && document.querySelector('.chat').textContent.includes('안녕')), 'A chat log shows the line');

  console.log('social (Phase 11: 아이디 · 친구 요청 → 수락 → 상호 프리즌스 · 귓속말)');
  const socialA = await waitFor(A, () => window.__game.ctx.net.social.available, 'A social available', 6000).catch(() => false);
  const socialB = socialA && await waitFor(B, () => window.__game.ctx.net.social.available, 'B social available', 6000).catch(() => false);
  let aCode = null, bCode = null;
  if (!socialB) {
    console.log('  skip social (this relay has no social store yet — server lane)');
    ok(await A.evaluate(() => { const s = window.__game.ctx.net.social; return s.available === false && s.me === null && s.friends.length === 0 && s.invites.length === 0 && s.whisper('AB3D9KMN', 'x') === false; }),
      'unavailable social is inert (no me, empty lists, whisper false)');
  } else {
    ok(true, 'both clients report ctx.net.social.available');
    aCode = await A.evaluate(() => window.__game.ctx.net.social.me.code);
    bCode = await B.evaluate(() => window.__game.ctx.net.social.me.code);
    ok(/^[A-HJ-NP-Z2-9]{8}$/.test(aCode) && /^[A-HJ-NP-Z2-9]{8}$/.test(bCode) && aCode !== bCode, `distinct 8-char 아이디 A=${aCode} B=${bCode}`);
    ok(await A.evaluate(() => window.__socialUpdated.some((e) => e.first === true)), 'A got social:updated {first:true} from the welcome snapshot');
    ok(await A.evaluate((c) => window.__game.ctx.net.social.playBlock(c) === 'self', aCode), 'playBlock(my own 아이디) is self');
    ok(await A.evaluate(() => window.__game.ctx.net.social.whisper('AB3D9KMN', '   ') === false), 'whisper with empty text is refused locally');
    // Leftovers from an earlier run would answer `already`: unfriend first (a no-op error when they are not friends).
    await A.evaluate((c) => window.__game.ctx.net.social.removeFriend(c), bCode);
    await sleep(400);
    ok(await A.evaluate((c) => !window.__game.ctx.net.social.friends.some((f) => f.code === c), bCode), 'A starts with B not in its friends list');
    ok(await A.evaluate((c) => window.__game.ctx.net.social.recent.some((r) => r.code === c), bCode), 'A has B in 최근 만난 플레이어 (same ship)');
    await A.evaluate((c) => window.__game.ctx.net.social.requestFriend(c), bCode);
    const inc = await waitFor(B, (c) => window.__game.ctx.net.social.incoming.find((p) => p.code === c) ?? null, 'B incoming request', 6000, aCode).catch(() => null);
    ok(inc && inc.name === '호스트' && inc.presence === 'ship', `B received A's friend request ${JSON.stringify(inc && { name: inc.name, presence: inc.presence, squad: inc.squad })}`);
    ok(await B.evaluate(() => window.__game.ctx.net.social.hasNews === true), 'B hasNews (red dot) while a request waits');
    ok(await A.evaluate((c) => window.__game.ctx.net.social.outgoing.some((p) => p.code === c), bCode), 'A lists the request as outgoing');
    await B.evaluate((c) => window.__game.ctx.net.social.respondFriend(c, true), aCode);
    const friendOnA = await waitFor(A, (c) => window.__game.ctx.net.social.friends.find((f) => f.code === c) ?? null, 'A friend row', 6000, bCode).catch(() => null);
    ok(friendOnA && friendOnA.name === '분대원' && friendOnA.presence === 'ship' && friendOnA.squad === 2, `A sees B as a friend in the ship ${JSON.stringify(friendOnA && { name: friendOnA.name, presence: friendOnA.presence, squad: friendOnA.squad })}`);
    ok(await A.evaluate(() => window.__game.ctx.net.social.onlineFriends === 1), 'A onlineFriends = 1 (the community thumbnail count)');
    ok(await waitFor(B, (c) => window.__game.ctx.net.social.friends.some((f) => f.code === c) && window.__game.ctx.net.social.incoming.length === 0 && !window.__game.ctx.net.social.hasNews, 'B mutual friend', 6000, aCode).catch(() => false),
      'B has A as a friend too, the request is gone, hasNews cleared');
    ok(await A.evaluate((c) => !window.__game.ctx.net.social.recent.some((r) => r.code === c), bCode), 'a friend left 최근 만난 플레이어');
    ok(await A.evaluate((c) => window.__game.ctx.net.social.find(c)?.code === c, bCode), 'find(아이디) resolves the row');
    // 귓속말: A → B, with a local echo on the sender.
    const sent = await A.evaluate((c) => window.__game.ctx.net.social.whisper(c, '귓속말 테스트'), bCode);
    ok(sent === true, 'A whisper() accepted');
    ok(await A.evaluate(() => { const w = window.__whispers[window.__whispers.length - 1]; return !!w && w.out === true && w.text === '귓속말 테스트' && w.name === '분대원'; }), 'A rendered its own whisper line (out:true, target name)');
    const got = await waitFor(B, (c) => window.__whispers.find((w) => w.code === c && !w.out) ?? null, 'B whisper line', 6000, aCode).catch(() => null);
    ok(got && got.text === '귓속말 테스트' && got.name === '호스트', `B received the whisper ${JSON.stringify(got && { name: got.name, text: got.text, out: got.out })}`);
    // Unfriend (mutual) so the next run starts clean.
    await B.evaluate((c) => window.__game.ctx.net.social.removeFriend(c), aCode);
    ok(await waitFor(A, (c) => window.__game.ctx.net.social.friends.every((f) => f.code !== c) ? 1 : 0, 'A unfriended', 6000, bCode).catch(() => 0) === 1,
      'removeFriend is mutual (A lost B as well)');
  }

  console.log('목표 행성 (Phase 11: host picks, squad mirrors, guest refused)');
  await A.evaluate(() => window.__game.ctx.net.setLobbyPlanet('tundra'));
  ok(await A.evaluate(() => window.__game.ctx.net.lobbyPlanet === 'tundra' && window.__game.ctx.net.lobby.planet === 'tundra'), 'host setLobbyPlanet mirrors optimistically');
  const planetWire = !!(await waitFor(B, () => window.__game.ctx.net.lobbyPlanet === 'tundra', 'B mirrors lobby.planet', 6000).catch(() => false));
  if (!planetWire) console.log('  skip lobby:planet wire checks (this relay does not handle lobby:planet yet — server lane)');
  else ok(true, 'the guest mirrors the host\'s 목표 행성 through lobby:state');
  await B.evaluate(() => window.__game.ctx.net.setLobbyPlanet('amber'));
  await sleep(400);
  ok(await B.evaluate(() => window.__game.ctx.net.lobbyPlanet !== 'amber'), 'a guest\'s setLobbyPlanet is refused (host only)');
  ok(await A.evaluate(() => { const before = window.__game.ctx.net.lobbyPlanet; window.__game.ctx.net.setLobbyPlanet('not-a-planet'); return window.__game.ctx.net.lobbyPlanet === before; }), 'an unknown planet id is dropped before it is sent');
  const hubPlanetB = await B.evaluate(() => (typeof window.__game.ctx.hub?.setPlanet === 'function' ? window.__game.ctx.hub.setPlanet('amber') : 'missing'));
  if (hubPlanetB === 'missing') console.log('  skip ctx.hub.setPlanet (hub lane has not implemented it yet)');
  else ok(hubPlanetB === false, `a guest's ctx.hub.setPlanet is refused (${hubPlanetB})`);
  if (planetWire) {
    ok(await waitFor(B, () => (window.__game.ctx.hub?.planet ?? null) === 'tundra', 'B hub.planet', 6000).catch(() => false) !== false,
      'ctx.hub.planet follows the squad\'s 목표 행성');
  }
  // The launch slots are gated on a 목표 행성 from here on: pick one (through hub/ when it is ready) and let any
  // travel cutscene finish before boarding.
  const picked = await A.evaluate(() => {
    const ctx = window.__game.ctx;
    if (typeof ctx.hub?.setPlanet === 'function' && ctx.hub.setPlanet('tundra') === true) return 'hub';
    ctx.net.setLobbyPlanet('tundra');
    return 'net';
  });
  console.log(`  planet set through ${picked}`);
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.hub?.travelling, 'A travel finished', 20000).catch(() => null);
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.hub?.travelling, 'B travel finished', 20000).catch(() => null);
  ok(await A.evaluate(() => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.lobbyPlanet === 'tundra'), 'both back in the shared ship with 목표 행성 tundra');

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
  if (planetWire) {
    const startA = await A.evaluate(() => window.__gameStarting[window.__gameStarting.length - 1] ?? null);
    ok(startA && startA.planet === 'tundra' && startA.mode === 'raid', `A net:gameStarting carries the 목표 행성 ${JSON.stringify(startA)}`);
    ok(await A.evaluate(() => { const m = window.__newMission[window.__newMission.length - 1]; return !!m && m.planet === 'tundra'; }), 'A game:newMission carries planet tundra');
    ok(await A.evaluate(() => window.__game.ctx.missionPlanet === 'tundra'), 'A ctx.missionPlanet was set before the mission was emitted');
    const startB = await B.evaluate(() => window.__gameStarting[window.__gameStarting.length - 1] ?? null);
    ok(startB && startB.planet === 'tundra', `B net:gameStarting carries the same planet ${JSON.stringify(startB)}`);
    ok(await B.evaluate(() => window.__game.ctx.missionPlanet === 'tundra'), 'B ctx.missionPlanet = tundra (the squad flew to one planet)');
  }
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

  console.log('carry snapshot plumbing (Phase 10: CARRYING/CARRIED flags, cr, carriedBy)');
  const CARRYING_BIT = 1 << 26, CARRIED_BIT = 1 << 27, HAS_WEAPON_BIT = 1 << 8;
  const aIdCarry = await A.evaluate(() => window.__game.ctx.net.localId);
  const bIdCarry = await B.evaluate(() => window.__game.ctx.net.localId);
  ok(await B.evaluate((id) => { const r = window.__game.ctx.net.getRemotePlayer(id); return !!r && r.carrying === null && r.carriedBy === null && r.isCarried === false; }, aIdCarry),
    'B ref of A starts with carrying / carriedBy null');
  ok(await B.evaluate((id) => (window.__game.ctx.net.getRemotePlayer(id).flags & (1 << 8)) !== 0, aIdCarry), 'B ref of A advertises HAS_WEAPON in the mission');
  await B.evaluate(() => { window.__carry = []; window.__game.ctx.bus.on('net:remoteCarryChanged', (e) => window.__carry.push({ id: e.id, carrying: e.carrying })); });
  // The `carry pick` one-shot is instant feedback ahead of the next 20 Hz snapshot.
  await A.evaluate((bid) => window.__game.ctx.net.send({ t: 'carry', ev: 'pick', target: bid }, 'others'), bIdCarry);
  const pick = await waitFor(B, (arg) => window.__carry.find((c) => c.id === arg.a && c.carrying === arg.b) ?? null, 'B net:remoteCarryChanged (pick)', 6000, { a: aIdCarry, b: bIdCarry }).catch(() => null);
  ok(!!pick, `B got net:remoteCarryChanged from the carry pick one-shot ${JSON.stringify(pick)}`);
  await A.evaluate((bid) => window.__game.ctx.net.send({ t: 'carry', ev: 'drop', target: bid, p: [0, 0, 0] }, 'others'), bIdCarry);
  ok(!!(await waitFor(B, (a) => window.__carry.find((c) => c.id === a && c.carrying === null) ?? null, 'B net:remoteCarryChanged (drop)', 6000, aIdCarry).catch(() => null)),
    'B got net:remoteCarryChanged {carrying:null} from the carry drop one-shot');
  // Steady state: force `ctx.player.carrying` on A (player/ owns the real `carry()`) and read it off the wire on B.
  await A.evaluate((bid) => { Object.defineProperty(window.__game.ctx.player, 'carrying', { get: () => bid, configurable: true }); }, bIdCarry);
  await B.evaluate((bid) => { Object.defineProperty(window.__game.ctx.player, 'isCarried', { get: () => true, configurable: true }); });
  const carried = await waitFor(B, (arg) => {
    const r = window.__game.ctx.net.getRemotePlayer(arg.a);
    if (!r || r.carrying !== arg.b) return null;
    return { carrying: r.carrying, flags: r.flags, weaponId: r.weaponId };
  }, 'B sees A CARRYING', 6000, { a: aIdCarry, b: bIdCarry }).catch(() => null);
  ok(carried && (carried.flags & CARRYING_BIT) !== 0, `B ref of A: CARRYING flag + cr = B ${JSON.stringify(carried && { carrying: carried.carrying, carrying_bit: (carried.flags & CARRYING_BIT) !== 0 })}`);
  ok(carried && (carried.flags & HAS_WEAPON_BIT) === 0 && carried.weaponId === null, `a carrier is unarmed on the wire (no HAS_WEAPON, w null) ${JSON.stringify(carried && { w: carried.weaponId })}`);
  const byA = await waitFor(A, (arg) => { const r = window.__game.ctx.net.getRemotePlayer(arg.b); return r && r.carriedBy === arg.a ? { carriedBy: r.carriedBy, isCarried: r.isCarried, flags: r.flags } : null; }, 'A derives carriedBy for B', 6000, { a: aIdCarry, b: bIdCarry }).catch(() => null);
  ok(!!byA, `A derived carriedBy = A on its ref of B ${JSON.stringify(byA && { carriedBy: byA.carriedBy })}`);
  ok(byA && byA.isCarried === true && (byA.flags & CARRIED_BIT) !== 0, 'A ref of B carries the CARRIED flag (isCarried true)');
  await A.evaluate(() => { delete window.__game.ctx.player.carrying; });
  await B.evaluate(() => { delete window.__game.ctx.player.isCarried; });
  ok(!!(await waitFor(B, (a) => { const r = window.__game.ctx.net.getRemotePlayer(a); return r && r.carrying === null && (r.flags & (1 << 26)) === 0 ? 1 : 0; }, 'B ref of A stops carrying', 6000, aIdCarry).catch(() => 0)),
    'the carry ends on the wire when `ctx.player.carrying` goes back to null');
  ok(!!(await waitFor(A, (b) => { const r = window.__game.ctx.net.getRemotePlayer(b); return r && r.carriedBy === null && !r.isCarried ? 1 : 0; }, 'A clears carriedBy', 6000, bIdCarry).catch(() => 0)),
    'A cleared the derived carriedBy after the last carry ended');
  ok(await B.evaluate((a) => (window.__game.ctx.net.getRemotePlayer(a).flags & (1 << 8)) !== 0, aIdCarry), 'A is armed again on the wire once the carry ends');

  console.log('enemies replication');
  const aAlive = await waitFor(A, () => window.__game.ctx.enemies.getAliveCount() > 0 ? window.__game.ctx.enemies.getAliveCount() : 0, 'A enemies alive');
  const bAlive = await waitFor(B, () => window.__game.ctx.enemies.getEnemies().length > 0 ? window.__game.ctx.enemies.getEnemies().length : 0, 'B replica enemies');
  ok(Math.abs(aAlive - bAlive) <= 3, `enemy counts host=${aAlive} client=${bAlive}`);
  // Phase 9: `es` is a delta stream (keyframe every NET_ENEMY_KEYFRAME_S) — the replica set must still track the host later on.
  await sleep(3000);
  const aAlive2 = await A.evaluate(() => window.__game.ctx.enemies.getAliveCount());
  const bAlive2 = await B.evaluate(() => window.__game.ctx.enemies.getEnemies().filter((e) => !e.isDead).length);
  ok(Math.abs(aAlive2 - bAlive2) <= 3, `enemy counts after 3 s of delta snapshots host=${aAlive2} client=${bAlive2}`);

  console.log('client hit → host damage');
  const target = await B.evaluate(() => { const e = window.__game.ctx.enemies.getEnemies().find((x) => !x.isDead); return e ? { id: e.id, hp: e.hp } : null; });
  ok(!!target, 'B has a live replica to shoot');
  if (target) {
    const hostHpBefore = await A.evaluate((id) => window.__game.ctx.enemies.getEnemies().find((x) => x.id === id)?.hp, target.id);
    await B.evaluate((id) => { const e = window.__game.ctx.enemies.getEnemies().find((x) => x.id === id); const V = e.position.constructor; e.takeDamage(10, e.position.clone().add(new V(0, 0.5, 0)), new V(0, 0, 1)); }, target.id);
    // 2026-09-09: 기준값을 `hp < 60` 으로 박아 두었더니 적 체력이 2배가 된 순간 영영 성립하지 않았다.
    // **맞기 전 체력보다 낮아졌는가**로 재야 밸런스 수치와 무관해진다.
    const hostHpAfter = await waitFor(A, (a) => { const hp = window.__game.ctx.enemies.getEnemies().find((x) => x.id === a.id)?.hp; return hp !== undefined && hp < a.before ? hp : 0; }, 'host applies hit', 5000, { id: target.id, before: hostHpBefore });
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

  console.log('overcharge beam replication (Phase 9 e2e)');
  const aIdBeam = await A.evaluate(() => window.__game.ctx.net.localId);
  const bIdBeam = await B.evaluate(() => window.__game.ctx.net.localId);
  await B.evaluate(() => {
    window.__beams = []; window.__game.ctx.net.onMessage('imp', (m, from) => { if (m.ev === 'beam') window.__beams.push({ target: m.target, self: m.self, from }); });
    window.__beamAudio = 0; window.__game.ctx.bus.on('audio:play', (e) => { if (e.id === 'overcharge_beam') window.__beamAudio++; });
  });
  // ImplantSystem only channels while the pointer is locked: fake the lock on A (the real request is stubbed at open()).
  await A.evaluate(() => { Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => document.querySelector('canvas'), configurable: true }); });
  ok(await A.evaluate(() => window.__game.ctx.input.isPointerLocked), 'A input reports the (faked) pointer lock');
  // B steps 7 m down A's aim ray so `findAlly` locks onto it.
  const aimSpot = await A.evaluate(() => {
    const p = window.__game.ctx.player; const V = p.position.constructor; const o = new V(); const d = new V();
    if (typeof p.getAimRay === 'function') p.getAimRay(o, d); else { p.getEyePosition(o); p.getForward(d); }
    const t = o.clone().addScaledVector(d, 7);
    return [t.x, t.y, t.z];
  });
  await B.evaluate((t) => { const p = window.__game.ctx.player; const V = p.position.constructor; p.teleport(new V(t[0], t[1], t[2]), 0, true); }, aimSpot);
  await waitFor(A, (bx) => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return r && !r.stale && Math.abs(r.position.x - bx) < 1.5 ? 1 : 0; }, 'A sees B at the aim spot', 6000, aimSpot[0]);
  ok(true, 'B stands in front of A');
  await A.evaluate(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q', bubbles: true })); });
  const beamOn = await waitFor(B, (bid) => window.__beams.find((b) => b.target === bid) ?? null, 'B receives imp beam {target: B}', 6000, bIdBeam).catch(() => null);
  ok(beamOn && beamOn.from === aIdBeam, `B received imp beam locked on itself ${JSON.stringify(beamOn)}`);
  ok(await waitFor(B, () => window.__beamAudio > 0, 'overcharge_beam audio on B', 3000).catch(() => false), 'B played audio:play overcharge_beam for the remote channel');
  const dbgOn = await waitFor(B, (aid) => { const s = window.__game.getSystem('implants'); if (!s || typeof s.debugBeam !== 'function') return { missing: true }; const d = s.debugBeam(aid); return d && d.on ? d : null; }, 'debugBeam on', 3000, aIdBeam).catch(() => null);
  if (dbgOn && dbgOn.missing) console.log('  skip debugBeam (implants agent has not exposed it yet)');
  else ok(!!dbgOn && dbgOn.on === true && dbgOn.target === bIdBeam, `RemoteImplants.debugBeam(A) on + target B ${JSON.stringify(dbgOn)}`);
  await A.evaluate(() => { document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q', bubbles: true })); });
  const beamOff = await waitFor(B, () => { const n = window.__beams.length; return n > 0 && window.__beams[n - 1].target === null ? window.__beams[n - 1] : null; }, 'B receives imp beam {target: null}', 6000).catch(() => null);
  ok(!!beamOff && beamOff.self === false, `B received the beam-off message ${JSON.stringify(beamOff)}`);
  if (!(dbgOn && dbgOn.missing)) {
    const dbgOff = await waitFor(B, (aid) => { const d = window.__game.getSystem('implants').debugBeam(aid); return d === null || d.on === false ? (d ?? { on: false }) : null; }, 'debugBeam off', 3000, aIdBeam).catch(() => null);
    ok(!!dbgOff && dbgOff.on === false, `RemoteImplants.debugBeam(A) off after keyup ${JSON.stringify(dbgOff)}`);
  }

  /* 2026-09-11 (C-43): B draws A's wielded 대전차포 in A's avatar hand and re-attaches it when that avatar is rebuilt —
     an avatar hands out a fresh `weaponSocket` each time, and the old "attached once" boolean left the device in the
     dead socket. Equipping is ship-only, so A's implant id is swapped in place for the probe and put back afterwards. */
  console.log('remote implant device follows a rebuilt avatar (2026-09-11 C-43)');
  await A.evaluate(() => { const im = window.__game.getSystem('implants'); window.__impPrev = im.equippedId; im.equippedId = 'atlauncher'; im.activate(); });
  const dev0 = await waitFor(B, (aid) => { const av = window.__game.getSystem('remotePlayers').getAvatar(aid); const s = av?.weaponSocket; return s && s.children.some((c) => c.name === 'Implant:atlauncher') ? { ok: true } : null; }, 'B sees A holding the 대전차포', 6000, aIdBeam).catch(() => null);
  ok(!!dev0, 'B: Implant:atlauncher hangs under A\'s avatar weaponSocket');
  await B.evaluate((aid) => { const sys = window.__game.getSystem('remotePlayers'); window.__oldSock = sys.getAvatar(aid)?.weaponSocket ?? null; sys.remove(aid); }, aIdBeam);
  const dev1 = await waitFor(B, (aid) => {
    const av = window.__game.getSystem('remotePlayers').getAvatar(aid);
    const s = av?.weaponSocket;
    if (!s || s === window.__oldSock) return null;
    const onNew = s.children.some((c) => c.name === 'Implant:atlauncher');
    const onOld = !!window.__oldSock && window.__oldSock.children.some((c) => c.name === 'Implant:atlauncher');
    return onNew ? { onNew, onOld } : null;
  }, 'device re-attached to the rebuilt avatar', 6000, aIdBeam).catch(() => null);
  ok(!!dev1 && dev1.onNew && !dev1.onOld, `B: after the avatar is rebuilt the device moved to the new weaponSocket ${JSON.stringify(dev1)}`);
  await A.evaluate(() => { const im = window.__game.getSystem('implants'); im.stow(); im.equippedId = window.__impPrev ?? 'overcharge'; });

  console.log('container authority (Phase 9 e2e: contq take → cont taken / denied)');
  await B.evaluate(() => {
    window.__searchDone = []; window.__game.ctx.bus.on('container:searchDone', (e) => window.__searchDone.push(e.containerId));
    window.__cont = []; window.__game.ctx.net.onMessage('cont', (m) => window.__cont.push({ ev: m.ev, id: m.id, idx: m.idx, qty: m.qty, by: m.by }));
    window.__notes = []; window.__game.ctx.bus.on('ui:notify', (e) => window.__notes.push(e.text));
  });
  await A.evaluate(() => { window.__searchDone = []; window.__game.ctx.bus.on('container:searchDone', (e) => window.__searchDone.push(e.containerId)); });
  // Open crates on B (teleported within SEARCH_MAX_DISTANCE) until one holds ≥ 2 items (the denial needs a second index).
  const openCrateOn = (page, i) => page.evaluate((k) => {
    const ctx = window.__game.ctx; const crate = ctx.world.getCrates()[k]; if (!crate) return null;
    const V = crate.position.constructor;
    ctx.player.teleport(crate.position.clone().add(new V(1.5, 0, 0)), 0, true);
    ctx.bus.emit('crate:open', { crateId: crate.id, tier: crate.tier, position: crate.position.clone() });
    return { id: crate.id, tier: crate.tier };
  }, i);
  const containerInfo = (page) => page.evaluate(() => {
    const sys = window.__game.getSystem('inventory'); const c = sys.activeContainer; if (!c) return null;
    return { id: c.id, order: c.order.slice(), items: c.order.map((uid) => { const p = c.grid.get(uid); return p ? { uid, defId: p.item.defId, qty: p.item.qty, searched: !!p.item.searched } : null; }) };
  });
  let crateB = null, cinfo = null;
  for (let i = 0; i < 4 && !cinfo; i++) {
    const opened = await openCrateOn(B, i);
    if (!opened) break;
    await waitFor(B, (id) => window.__searchDone.includes(id), `B search done ${opened.id}`, 25000, opened.id).catch(() => null);
    const info = await containerInfo(B);
    if (info && info.order.length >= 2 && info.items.every((it) => it && it.searched)) { crateB = opened; cinfo = info; }
    else await B.evaluate(() => window.__game.getSystem('inventory').closeAll());
  }
  ok(!!cinfo, `B opened + searched crate ${crateB?.id} (${cinfo?.order.length} items)`);
  if (cinfo) {
    const first = cinfo.items[0];
    const bCount0 = await B.evaluate((d) => window.__game.ctx.inventory.countWhere((def) => def.id === d), first.defId);
    const qm = await B.evaluate((uid) => { const sys = window.__game.getSystem('inventory'); const r = sys.quickMove(uid, { kind: 'grid', grid: 'container' }); return { r, pending: [...sys.pendingTakeUids()] }; }, first.uid);
    ok(qm.r === 'pending' && qm.pending.includes(first.uid), `B quickMove on a client → 'pending' + pendingTakeUids ${JSON.stringify(qm)}`);
    const taken = await waitFor(B, (id) => window.__cont.find((m) => m.ev === 'taken' && m.id === id && m.idx === 0) ?? null, 'B cont taken', 8000, crateB.id).catch(() => null);
    ok(taken && taken.qty === first.qty && taken.by === bIdBeam, `host confirmed the take: cont taken ${JSON.stringify(taken)}`);
    const hostCopy = await waitFor(A, (id) => { const c = window.__game.getSystem('inventory').containers.get(id); return c && (c.taken.get(0) ?? 0) > 0 ? { taken: c.taken.get(0), remaining: c.remainingAt(0) } : null; }, 'host container taken', 5000, crateB.id).catch(() => null);
    ok(hostCopy && hostCopy.taken === first.qty && hostCopy.remaining === 0, `host copy records idx 0 taken ${JSON.stringify(hostCopy)}`);
    const bCount1 = await waitFor(B, (arg) => { const n = window.__game.ctx.inventory.countWhere((def) => def.id === arg.d); return n > arg.b ? n : 0; }, 'B bag grows after confirmation', 8000, { d: first.defId, b: bCount0 }).catch(() => -1);
    ok(bCount1 === bCount0 + first.qty, `B received the item after the host's confirmation (${bCount0} → ${bCount1})`);
    ok(await B.evaluate(() => window.__game.getSystem('inventory').pendingTakeUids().size === 0), 'B pendingTakeUids emptied');
    ok(await B.evaluate((uid) => !window.__game.getSystem('inventory').activeContainer?.grid.get(uid), first.uid), 'item left B\'s container copy');
    // Denial: A (host) opens the same crate, takes idx 1 first; B (its copy frozen) asks for the same index → cont denied + toast.
    const second = cinfo.items[1];
    const aOpened = await A.evaluate((k) => {
      const ctx = window.__game.ctx; const crate = ctx.world.getCrates().find((c) => c.id === k); const V = crate.position.constructor;
      ctx.player.teleport(crate.position.clone().add(new V(-1.5, 0, 0)), 0, true);
      ctx.bus.emit('crate:open', { crateId: crate.id, tier: crate.tier, position: crate.position.clone() });
      return crate.id;
    }, crateB.id);
    await waitFor(A, (id) => window.__searchDone.includes(id), 'A search done', 25000, aOpened).catch(() => null);
    const aInfo = await containerInfo(A);
    // contents are deterministic (missionSeed ^ id) but uids are minted per client: compare by index / defId
    ok(aInfo && aInfo.items[1]?.defId === second.defId && aInfo.items[1]?.searched && !aInfo.items[0],
      `host rolled the same container (idx 0 already gone, idx 1 = ${second.defId})`, JSON.stringify(aInfo && aInfo.items.map((it) => it && it.defId)));
    await B.evaluate(() => { const sys = window.__game.getSystem('inventory'); sys.__realApply = sys.applyRemoteTaken; sys.applyRemoteTaken = () => {}; });
    const aTake = await A.evaluate(() => {
      const sys = window.__game.getSystem('inventory');
      return sys.quickMove(sys.activeContainer.uidAt(1), { kind: 'grid', grid: 'container' });
    });
    ok(aTake === 'ok', `host took idx 1 itself (${aTake})`);
    await waitFor(B, (id) => window.__cont.some((m) => m.ev === 'taken' && m.id === id && m.idx === 1), 'B saw the host take', 5000, crateB.id).catch(() => null);
    const qm2 = await B.evaluate((uid) => window.__game.getSystem('inventory').quickMove(uid, { kind: 'grid', grid: 'container' }), second.uid);
    ok(qm2 === 'pending', `B (frozen copy) requests the same index → '${qm2}'`);
    const denied = await waitFor(B, (id) => window.__cont.find((m) => m.ev === 'denied' && m.id === id && m.idx === 1) ?? null, 'B cont denied', 8000, crateB.id).catch(() => null);
    ok(!!denied, `host denied the second take of idx 1 ${JSON.stringify(denied)}`);
    ok(await waitFor(B, () => window.__notes.some((t) => t.includes('먼저 가져갔습니다')), 'denied toast', 3000).catch(() => false), 'B showed the 다른 대원이 먼저 가져갔습니다 toast');
    ok(await B.evaluate(() => window.__game.getSystem('inventory').pendingTakeUids().size === 0), 'B pending request cleared by the denial');
    await B.evaluate(() => { const sys = window.__game.getSystem('inventory'); delete sys.applyRemoteTaken; sys.closeAll(); });
    await A.evaluate(() => window.__game.getSystem('inventory').closeAll());
  }
  await A.evaluate(() => { window.__game.ctx.player.respawnAt ? null : null; });

  console.log('extraction request path');
  const padId = await A.evaluate(() => window.__game.ctx.world.getExtractionPoints()[0].id);
  await B.evaluate((id) => window.__game.ctx.net.send({ t: 'exq', ev: 'activate', padId: id }, 'host'), padId);
  await waitFor(A, () => window.__game.ctx.phase === 'extracting', 'host extracting after client request');
  await waitFor(B, () => window.__game.ctx.phase === 'extracting', 'client mirrors extracting');
  ok(true, 'extraction activated on both via client request');

  console.log('mission membership (Phase 7)');
  ok(await A.evaluate(() => window.__game.ctx.net.lobby.players.every((p) => p.inMission === true) && window.__game.ctx.net.getRemotePlayers()[0].inMission === true), 'raid start marked every member inMission (lobby + remote ref)');
  ok(await A.evaluate(() => window.__game.ctx.net.missionMode === 'raid' && window.__game.ctx.missionMode === 'raid'), 'missionMode raid on net + ctx');

  console.log('client socket drop → seamless resume');
  await A.evaluate(() => { window.__connFlags = []; window.__game.ctx.bus.on('net:lobbyUpdated', ({ lobby }) => window.__connFlags.push(lobby.players.map((p) => p.connected).join(''))); });
  await B.evaluate(() => { window.__resumed = null; window.__game.ctx.bus.on('net:resumed', (e) => { window.__resumed = e; }); window.__game.getSystem('net').client.ws.close(); });
  await waitFor(B, () => window.__game.ctx.net.reconnecting, 'B reconnecting', 5000);
  ok(true, 'B entered reconnecting state');
  await waitFor(A, () => window.__connFlags.some((f) => f.includes('0') || f.includes('false')), 'A sees B disconnected', 5000).catch(() => null);
  const suspEv = await waitFor(A, () => window.__susp.length >= 1 ? window.__susp[0] : null, 'A net:peerSuspended', 5000).catch(() => null);
  ok(suspEv && suspEv.suspended === true && suspEv.name === '분대원', `A got net:peerSuspended {suspended:true} for B ${JSON.stringify(suspEv)}`);
  const resumed = await waitFor(B, () => window.__resumed, 'B resumed', 15000);
  ok(resumed.seamless === true && resumed.lobby.code === code, `B resumed seamlessly ${JSON.stringify({ seamless: resumed.seamless, inProgress: resumed.inProgress })}`);
  ok(await B.evaluate(() => window.__game.ctx.phase === 'extracting' && window.__game.ctx.isMultiplayer), 'B still in the mission after resume');
  await waitFor(A, () => window.__game.ctx.net.lobby.players.every((p) => p.connected), 'A sees B reconnected', 5000);
  ok(true, 'A sees B connected again');
  await waitFor(A, () => window.__susp.length >= 2 && window.__susp[1].suspended === false && !window.__game.ctx.net.getRemotePlayers()[0].suspended, 'A un-suspends B', 5000);
  ok(true, 'A got net:peerSuspended {suspended:false}; remote ref no longer suspended');
  const remRem = await waitFor(B, () => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return r && !r.stale ? 1 : 0; }, 'B remote fresh', 5000).catch(() => 0);
  ok(remRem === 1, 'B gets fresh snapshots from A after resume');

  console.log('host socket drop > NET_HOST_MIGRATE_DELAY_MS → B takes over, A resumes demoted (Phase 7)');
  const aId = await A.evaluate(() => window.__game.ctx.net.localId);
  const bId = await B.evaluate(() => window.__game.ctx.net.localId);
  await B.evaluate(() => { window.__rejoinedFrom = null; window.__game.ctx.net.onMessage('flow', (m, from) => { if (m.ev === 'rejoined') window.__rejoinedFrom = from; }); });
  await A.evaluate(() => {
    // Keep A offline for longer than the migrate delay: point the reconnect at a dead port until B took over.
    const sys = window.__game.getSystem('net');
    window.__realUrl = sys.defaultUrl;
    sys.defaultUrl = () => 'ws://127.0.0.1:1/ws';
    sys.client.ws.close();
  });
  await waitFor(A, () => window.__game.ctx.net.reconnecting, 'A reconnecting', 5000);
  ok(await A.evaluate(() => window.__game.ctx.net.isHost && window.__game.ctx.isAuthority), 'A keeps host/authority while reconnecting (before the delay)');
  const hc = await waitFor(B, () => window.__hostChanged.find((e) => e.isLocalHost) ?? null, 'B net:hostChanged {isLocalHost:true}', 12000);
  ok(hc.hostId === bId && hc.prev === aId, `B promoted: net:hostChanged ${JSON.stringify(hc)}`);
  ok(await B.evaluate(() => window.__game.ctx.net.isHost && window.__game.ctx.net.tookOver && window.__game.ctx.isAuthority && window.__game.ctx.net.inSession), 'B is host + authority + tookOver, still in session');
  ok(await B.evaluate(() => { const r = window.__game.ctx.net.getRemotePlayers()[0]; return !!r && r.suspended === true && r.inMission === true; }), 'B sees A as a suspended mission member (ref kept)');
  await A.evaluate(() => { const sys = window.__game.getSystem('net'); sys.defaultUrl = window.__realUrl; });
  const resumedA = await waitFor(A, () => window.__resumedEv[0] ?? null, 'A resumed', 20000);
  ok(resumedA.seamless === true, `A resumed into the running mission ${JSON.stringify({ seamless: resumedA.seamless, host: resumedA.lobby.hostId === bId })}`);
  const demoted = await waitFor(A, () => window.__hostChanged.find((e) => e.isLocalHost === false) ?? null, 'A net:hostChanged {isLocalHost:false}', 5000);
  ok(demoted.hostId === bId && demoted.prev === aId, `A demoted: net:hostChanged ${JSON.stringify(demoted)}`);
  ok(await A.evaluate(() => !window.__game.ctx.net.isHost && !window.__game.ctx.isAuthority && window.__game.ctx.net.inSession && !window.__game.ctx.net.tookOver), 'A is a client now (no authority), still in session');
  const rejoinedFrom = await waitFor(B, () => window.__rejoinedFrom, 'B flow rejoined from A', 5000).catch(() => null);
  ok(rejoinedFrom === aId, 'returning A announced flow rejoined to the new host');
  await waitFor(B, () => window.__game.ctx.net.lobby.players.every((p) => p.connected) && !window.__game.ctx.net.getRemotePlayers()[0].suspended, 'B un-suspends A', 5000);
  ok(true, 'B sees A connected again, ref no longer suspended');
  // Phase 9: the promoted host's snapshot stream (keyframe after takeover / rejoined, then deltas) keeps A's replicas in step.
  await sleep(3000);
  const hostAlive = await B.evaluate(() => window.__game.ctx.enemies.getAliveCount());
  const clientAlive = await A.evaluate(() => window.__game.ctx.enemies.getEnemies().filter((e) => !e.isDead).length);
  ok(Math.abs(hostAlive - clientAlive) <= 3, `enemy counts after the migration host(B)=${hostAlive} client(A)=${clientAlive}`);

  console.log('new host aborts → squad returns to the shared ship');
  await B.evaluate(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'B shared ship after abort', 10000);
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared', 'A shared ship (flow abort from the new host)', 10000);
  await waitFor(A, () => window.__game.ctx.net.lobby && !window.__game.ctx.net.lobby.started && !window.__game.ctx.net.inSession, 'lobby reset');
  ok(true, 'both back in the shared ship, lobby un-started (new host sent lobby:reset)');
  ok(await A.evaluate(() => !window.__game.ctx.player.isInPod && !window.__game.ctx.net.lobby.players.some((p) => p.ready)), 'pods empty after reset');
  ok(await A.evaluate(() => window.__game.ctx.net.lobby.players.every((p) => p.inMission === false) && window.__game.ctx.net.missionMode === null), 'reset cleared inMission for everyone, missionMode null');

  console.log('training join (Phase 9 e2e: non-host starts, host joins, individual exits, server reset)');
  const aIdT = await A.evaluate(() => window.__game.ctx.net.localId);
  const bIdT = await B.evaluate(() => window.__game.ctx.net.localId);
  await A.evaluate(() => { window.__membership = []; });
  const startedT = await B.evaluate(() => window.__game.ctx.hub.startTraining());
  ok(startedT === true, 'B (non-host) requested a training from the shared ship');
  await waitFor(B, () => window.__game.ctx.net.inSession && window.__game.ctx.missionMode === 'training' && window.__game.ctx.world?.mode === 'training', 'B in the training arena', 20000);
  ok(await B.evaluate(() => window.__game.ctx.net.missionMode === 'training' && window.__game.ctx.hub.ship === null), 'B: missionMode training, world.mode training, hub torn down');
  ok(await B.evaluate(() => window.__game.ctx.missionPlanet === null && (window.__newMission[window.__newMission.length - 1]?.planet ?? null) === null), 'a training carries no 목표 행성 (ctx.missionPlanet null)');
  await waitFor(A, (bid) => window.__game.ctx.net.lobby?.mode === 'training' && window.__game.ctx.net.lobby.players.find((p) => p.id === bid)?.inMission === true, 'A sees the training', 8000, bIdT);
  ok(await A.evaluate((aid) => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'shared' && !window.__game.ctx.net.inSession && window.__game.ctx.net.lobby.players.find((p) => p.id === aid)?.inMission === false && window.__game.ctx.net.missionInProgress, aIdT),
    'A stays in the shared ship: lobby.mode training, only B inMission, missionInProgress');
  ok(await A.evaluate((bid) => window.__membership.some((e) => e.id === bid && e.inMission === true), bIdT), 'A got net:missionMembership {B, inMission:true}');
  const joinedT = await A.evaluate(() => window.__game.ctx.hub.startTraining());
  ok(joinedT === true, 'A (host) joins the running training from the ship (rejoinMission)');
  await waitFor(A, () => window.__game.ctx.net.inSession && window.__game.ctx.world?.mode === 'training', 'A in the training arena', 20000);
  await waitFor(B, (aid) => window.__game.ctx.net.lobby.players.find((p) => p.id === aid)?.inMission === true, 'B sees A inMission', 8000, aIdT);
  ok(await A.evaluate(() => window.__game.ctx.net.lobby.players.every((p) => p.inMission === true)), 'both inMission in the training');
  await waitFor(A, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'A remote avatar in the arena', 10000);
  await waitFor(B, () => window.__game.ctx.net.getRemotePlayers().length === 1 && !!window.__game.ctx.net.getRemotePlayers()[0].avatar, 'B remote avatar in the arena', 10000);
  ok(true, 'each trainee sees one remote avatar');
  await B.evaluate(() => window.__game.ctx.bus.emit('training:exitRequested', {}));
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.net.inSession, 'B back in the ship', 15000);
  ok(await B.evaluate(() => window.__game.ctx.hub.ship === 'shared' && window.__game.ctx.net.missionInProgress), 'B exited the training individually (shared ship, training still running for A)');
  await waitFor(A, (bid) => window.__membership.some((e) => e.id === bid && e.inMission === false) && window.__game.ctx.net.lobby.players.find((p) => p.id === bid)?.inMission === false, 'A sees B leave the training', 8000, bIdT);
  ok(await A.evaluate(() => window.__game.ctx.net.inSession && window.__game.ctx.net.lobby.started), 'A: net:missionMembership {B, false}, training keeps running');
  await A.evaluate(() => window.__game.ctx.bus.emit('training:exitRequested', {}));
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && !window.__game.ctx.net.inSession, 'A back in the ship', 15000);
  await waitFor(A, () => window.__game.ctx.net.lobby && !window.__game.ctx.net.lobby.started, 'lobby reset after the last trainee left', 8000);
  await waitFor(B, () => window.__game.ctx.net.lobby && !window.__game.ctx.net.lobby.started, 'B sees the reset', 8000);
  ok(await A.evaluate(() => window.__game.ctx.net.missionMode === null && window.__game.ctx.net.lobby.players.every((p) => !p.inMission)), 'server reset the training once its last member left (started false, missionMode null)');

  console.log('peer leave → undock');
  await B.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 1, 'A sees B leave');
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.hub.ship === 'personal', 'B back in personal ship', 15000);
  ok(true, 'B undocked to the personal ship, A ship has 1 player');
  // Leave cleanly so the relay does not keep A's slot (5-min reconnect grace) for the next run.
  await A.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.net.lobby === null, 'A left');

  const errA = errors.A.filter((e) => !/favicon|WebGL|GPU|swiftshader|GroupMarker|WebSocket connection/i.test(e));
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
