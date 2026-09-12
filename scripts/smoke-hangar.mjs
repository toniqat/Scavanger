// Two-client smoke test for the 공용 함선 격납고 (hub folder, 2026-09-08):
// the shared ship's aft 자동문, the hangar deck behind it (walkable union, 4 bay markings, parked 개인 함선),
// boarding a bay (own ship = full functionality, a squadmate's = 둘러보기 전용), the `ship state` / `shipq state`
// wire that carries a member's layout, the way back out through the airlock, and the `hs` co-presence rule
// (avatars are only drawn for peers standing in the same ship interior).
// Usage: node scripts/smoke-hangar.mjs [http://localhost:5273]
// Requires `npm run server` and `npm run dev` to be running (or `npm run dev:all`).
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
// One browser per client: separate localStorage → distinct session tokens (and therefore distinct ships).
const browsers = [];
const errors = { A: [], B: [] };
async function open(tag) {
  const browser = await puppeteer.launch(LAUNCH);
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(() => {
    // the tutorial gates rooms / terminal / boarding in order; this script does not test it (smoke-tutorial does)
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // both clients: another editor's save must not full-reload either page mid-run (scripts/quiet-hmr.mjs, C-65)
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net, `${tag} boot`);
  await page.evaluate(() => {
    const bus = window.__game.ctx.bus;
    window.__visits = []; bus.on('hub:shipVisit', (e) => window.__visits.push({ peerId: e.peerId, readOnly: e.readOnly }));
    window.__shipWire = []; bus.on('net:shipVisit', (e) => window.__shipWire.push(e.id));
    window.__notify = []; bus.on('ui:notify', (e) => window.__notify.push(e.text));
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  return page;
}
/** Simulation time, not wall time: headless renders at a few fps and dt is clamped to 50 ms. */
const waitSim = async (page, sec) => {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 120000, t0 + sec);
};
const teleport = (page, x, z, yaw = 0) => page.evaluate(([x, z, yaw]) => {
  const p = window.__game.ctx.player;
  const v = p.position.clone(); v.set(x, 0, z);
  p.spawnStanding(v, yaw);
}, [x, z, yaw]);
/**
 * **Walk** `steps` × 0.1 m along +Z through `resolveCollision`, the way the player actually moves. Teleporting
 * hides the one failure this whole deck can have: two rooms that do not share an edge are not walkable between,
 * and `resolveCollision` then pins the player at `room.maxZ − radius` forever — which is exactly what the first
 * version of the hangar did (its room started at the wall's far face, 0.35 m past the ship's).
 */
const walkNorth = (page, steps) => page.evaluate((n) => {
  const ctx = window.__game.ctx;
  const p = ctx.player, col = p.interior;
  const v = p.position.clone();
  for (let i = 0; i < n; i++) { v.z += 0.1; col.resolveCollision(v, 0.45); }
  return [v.x, v.z];
}, steps);
const bayOf = (page, slot) => page.evaluate((s) => {
  const it = window.__game.ctx.interactables.all().find((i) => i.id === `hub_ship_bay_${s}`);
  return it ? { pos: [it.position.x, it.position.z], radius: it.radius, prompt: it.getPrompt(), can: it.canInteract() } : null;
}, slot);

try {
  console.log('boot two clients');
  const A = await open('A');
  const B = await open('B');

  /* ── 1. both into the shared ship through a quick match ─────────────── */
  console.log('shared ship');
  await A.evaluate(() => { window.__game.ctx.net.setPlayerName('호스트'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(A, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.connected, 'A personal + connected');
  // give A a recognisable ship layout so a visit has something to look at
  const seeded = await A.evaluate(() => {
    const h = window.__game.ctx.housing;
    h.state.rooms[2] = { purpose: 'workshop', level: 1 };
    h.state.rooms[7] = { purpose: 'greenhouse', level: 1 };
    h.state.furniture.push({ uid: 'smoke-bench', defId: 'furn_bench_gun', room: 2, x: 1, y: 1, yaw: 0, level: 1 });
    window.__game.ctx.bus.emit('housing:changed', { reason: 'smoke' });
    return { rooms: h.state.rooms.map((r) => r.purpose).join(','), placed: h.getPlaced(2).length };
  });
  ok(seeded.placed === 1, `A seeded 방 3 = 작업실 with a 총기 작업대 (${seeded.placed} 가구)`);

  // A **private** ship joined by code, never `quickMatch()`: a public lobby left over from an earlier run (the relay
  // keeps one for the reconnect grace) would otherwise pull a stranger's slot into the hangar and skew every count.
  await A.evaluate(() => window.__game.ctx.net.createLobby());
  const code = await waitFor(A, () => window.__game.ctx.net.lobby?.code, 'A lobby code');
  await waitFor(A, () => window.__game.ctx.hub.ship === 'shared', 'A shared ship', 25000);

  await B.evaluate(() => { window.__game.ctx.net.setPlayerName('분대원'); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(B, () => window.__game.ctx.phase === 'hub' && window.__game.ctx.net.connected, 'B personal + connected');
  await B.evaluate((c) => window.__game.ctx.net.joinLobby(c), code);
  const codeB = await waitFor(B, () => window.__game.ctx.net.lobby?.code, 'B lobby code');
  ok(codeB === code, `B joined A's ship by code (${codeB})`);
  await waitFor(B, () => window.__game.ctx.hub.ship === 'shared', 'B shared ship', 25000);
  await waitFor(A, () => window.__game.ctx.net.lobby?.players.length === 2, 'A sees 2 players');
  await waitSim(A, 0.5);
  ok(true, 'both in the shared ship');

  /* ── 2. the hangar deck exists and is walkable ──────────────────────── */
  console.log('hangar deck');
  const deck = await A.evaluate(() => {
    const ctx = window.__game.ctx;
    const col = ctx.player.interior;
    const v = ctx.player.position.clone();
    // a point deep inside the hangar (behind the ship's +Z wall at 7.35) must stay put — it is walkable floor
    v.set(0, 0, 20);
    col.resolveCollision(v, 0.4);
    const inside = Math.abs(v.x) < 0.5 && Math.abs(v.z - 20) < 0.5;
    // the doorway at (0, 7.35) is an open shared edge: a circle standing in it is not pushed out
    const d = ctx.player.position.clone(); d.set(0, 0, 7.35);
    col.resolveCollision(d, 0.4);
    const open = Math.abs(d.x) < 0.5 && Math.abs(d.z - 7.35) < 0.6;
    // the far gate is solid
    const g = ctx.player.position.clone(); g.set(0, 0, 37.0);
    col.resolveCollision(g, 0.4);
    let lights = 0, bayGroups = 0;
    const hangar = ctx.scene.getObjectByName('Hangar');
    hangar?.traverse((o) => { if (o.isPointLight) lights++; if (o.isGroup && /^hangar-bay-\d$/.test(o.name)) bayGroups++; });
    const fixtures = window.__game.getSystem('hub').interior?.hangar?.lightFixtures?.length ?? -1;
    return { inside, open, gateZ: g.z, hangar: !!hangar, lights, fixtures, bayGroups, bounds: [col.bounds.center.z, col.bounds.halfExtents.z] };
  });
  ok(deck.hangar, 'a Hangar group hangs off the shared-ship interior');
  ok(deck.inside, 'the hangar floor is walkable (a circle at (0, 20) stays put)');
  ok(deck.open, 'the aft doorway is an open shared edge (no blocker in it)');
  // the gate blocker's inner face is maxZ − 0.1 = 37.25, so a 0.4 m circle is pushed back to 36.85
  ok(deck.gateZ < 36.9, `the exterior bay gate is solid (pushed back to z ${deck.gateZ.toFixed(2)})`);
  // 2026-09-10: the hangar lists 9 light fixtures and owns no PointLight — the shared ship's `LightPool` lights them
  ok(deck.lights === 0 && deck.fixtures === 9, `hangar has 9 light fixtures and no light of its own (fixtures ${deck.fixtures}, lights ${deck.lights})`);
  ok(deck.bayGroups === 4, `4 bay groups (${deck.bayGroups})`);
  ok(deck.bounds[0] > 10 && deck.bounds[1] > 20, `the collider bounds grew to cover the hangar (centre z ${deck.bounds[0].toFixed(1)}, half ${deck.bounds[1].toFixed(1)})`);

  /* ── 3. the 자동문 opens on approach, and the deck is reachable ON FOOT ── */
  const doorShut = await A.evaluate(() => window.__game.getSystem('hub').interior.doors.openAmount(0));
  ok(doorShut < 0.05, `aft 자동문 closed while nobody is near it (${doorShut.toFixed(2)})`);
  await teleport(A, 0, 6.0);
  await waitSim(A, 1.2);
  const doorOpen = await A.evaluate(() => window.__game.getSystem('hub').interior.doors.openAmount(0));
  ok(doorOpen > 0.9, `aft 자동문 opens when the player walks up to it (${doorOpen.toFixed(2)})`);
  // the whole point: walk from the deck into the hangar through `resolveCollision`, 0.1 m at a time
  await teleport(A, 0, 4.0);
  const walkedIn = await walkNorth(A, 120);
  ok(walkedIn[1] > 14, `walked from the deck into the hangar on foot (z ${walkedIn[1].toFixed(2)}, not stuck at the wall)`);
  // …and the doorway is the ONLY way through: the same walk off to the side hits the aft wall
  await teleport(A, -8.0, 4.0);
  const walkedWall = await walkNorth(A, 120);
  ok(walkedWall[1] < 7.0, `the aft wall still stops a walk beside the doorway (z ${walkedWall[1].toFixed(2)})`);
  // walking back out lands on the deck again
  await teleport(A, 0, 12.0);
  const walkedOut = await A.evaluate(() => {
    const ctx = window.__game.ctx;
    const p = ctx.player, col = p.interior;
    const v = p.position.clone();
    for (let i = 0; i < 120; i++) { v.z -= 0.1; col.resolveCollision(v, 0.45); }
    return [v.x, v.z];
  });
  // stops at the central holo table (collider box to z 2.6) — well past the doorway, which is the point
  ok(walkedOut[1] < 6, `and back out onto the deck (z ${walkedOut[1].toFixed(2)})`);

  /* ── 4. bays: one per lobby slot, parked ships, prompts ─────────────── */
  console.log('bays');
  const bays = await A.evaluate(() => window.__game.ctx.hub.getShipBays().map((b) => ({ slot: b.slot, occupant: b.occupant, x: b.position.x, z: b.position.z, ex: b.entrance.x, ez: b.entrance.z })));
  ok(bays.length === 4, `4 bays reported by ctx.hub.getShipBays() (${bays.length})`);
  ok(bays.every((b) => b.z > 15 && b.z < 30) && bays.every((b) => b.ez < b.z), 'bay markings sit in the hangar with their entrances toward the walkway');
  const filled = bays.filter((b) => b.occupant !== null).length;
  ok(filled === 2, `2 of 4 bays are occupied — one per lobby member (${filled})`);
  const parked = await A.evaluate(() => {
    const h = window.__game.getSystem('hub').interior.hangar;
    return [0, 1, 2, 3].map((i) => h.isParked(i));
  });
  ok(parked.filter(Boolean).length === 2, `2 개인 함선 models parked (${parked.join(',')})`);
  const aSlot = await A.evaluate(() => window.__game.ctx.net.localSlot);
  const bSlot = await B.evaluate(() => window.__game.ctx.net.localSlot);
  ok(aSlot !== bSlot, `A and B hold different slots (${aSlot} / ${bSlot})`);
  const mine = await bayOf(A, aSlot);
  const theirs = await bayOf(A, bSlot);
  const emptySlot = [0, 1, 2, 3].find((s) => s !== aSlot && s !== bSlot);
  const empty = await bayOf(A, emptySlot);
  ok(mine?.prompt === '개인 함선 탑승', `own bay prompt "${mine?.prompt}"`);
  ok(theirs?.prompt === '분대원 의 함선 방문', `squadmate bay prompt "${theirs?.prompt}"`);
  ok(empty?.prompt === null && empty?.can === false, `an empty bay is silent (prompt ${JSON.stringify(empty?.prompt)})`);

  /* ── 5. the layout wire arrived on its own ──────────────────────────── */
  console.log('ship state wire');
  const aId = await A.evaluate(() => window.__game.ctx.net.localId);
  const gotA = await waitFor(B, (id) => {
    const w = window.__game.ctx.net.getShipVisit(id);
    // 2026-09-12: the two cockpit 공용 pieces (room 100) ride the wire on every ship — count the room furniture only
    return w ? { rooms: w.rooms.map((r) => r.purpose).join(','), furn: w.furniture.filter((f) => f.room !== 100).length } : null;
  }, 'B received A ship state', 15000, aId);
  ok(gotA.furn === 1, `B received A's layout without asking (${gotA.furn} 가구)`);
  ok(gotA.rooms.split(',')[2] === 'workshop' && gotA.rooms.split(',')[7] === 'greenhouse', `…including the room purposes (${gotA.rooms})`);
  ok(await B.evaluate((id) => window.__shipWire.includes(id), aId), 'net:shipVisit fired for it');
  ok(await A.evaluate(() => !!window.__game.ctx.net.getShipVisit(window.__game.ctx.net.localId)), 'our own broadcast is snooped back (own bay renders from the same wire)');

  /* ── 6. B visits A's ship (read-only) ───────────────────────────────── */
  console.log('visiting');
  const visitOk = await B.evaluate((s) => {
    const it = window.__game.ctx.interactables.all().find((i) => i.id === `hub_ship_bay_${s}`);
    if (!it || !it.canInteract()) return `bay ${s} unavailable`;
    it.interact();
    return 'ok';
  }, aSlot);
  ok(visitOk === 'ok', `B pressed E on A's bay (${visitOk})`);
  await waitFor(B, () => window.__game.ctx.hub.ship === 'personal', 'B inside a personal ship');
  await waitSim(B, 0.4);
  const inside = await B.evaluate((id) => {
    const ctx = window.__game.ctx;
    const ids = ctx.interactables.all().map((i) => i.id);
    return {
      ship: ctx.hub.ship, site: ctx.hub.hubSite, visiting: ctx.hub.visitingPeer, ro: ctx.hub.visitReadOnly,
      matchesOwner: ctx.hub.hubSite === id,
      lobby: !!ctx.net.lobby, phase: ctx.phase,
      exit: ids.includes('hub_hangar_exit'),
      pods: ids.filter((i) => /^hub_pod_/.test(i)).length,
      stations: ids.filter((i) => i === 'hub_implant_bay' || i === 'hub_terminal' || i === 'hub_computer'),
      furn: ids.filter((i) => /^hub_furn_/.test(i)).length,
      pieces: window.__game.getSystem('hub').furnitureLayer?.count ?? -1,
      // 2026-09-12: every ship also carries its two cockpit fixtures (시술대 · 컴퓨터 — 공용 시설 가구), so count the bench itself
      bench: !!ctx.scene.getObjectByName('furn-furn_bench_gun'),
      manage: window.__game.ctx.hub.hubSite !== null && window.__game.getSystem('hub').openShipManage(),
      z: ctx.player.position.z,
      // 2026-09-12: the corridor grew with the rooms (25 → 45 m), so the airlock plate is wherever `RoomLayout`
      // now puts it — ask the built interior instead of writing the z down.
      airlockZ: window.__game.getSystem('hub').interior?.airlock?.z ?? NaN,
    };
  }, aId);
  ok(inside.ship === 'personal' && inside.lobby && inside.phase === 'hub', 'B is in a personal ship and still in the lobby (no undocking)');
  ok(inside.visiting === aId && inside.ro === true && inside.matchesOwner, `visitingPeer / hubSite = the owner, read-only (${inside.visiting})`);
  ok(inside.bench && inside.pieces >= 1, `A's 총기 작업대 is rendered from the wire (${inside.pieces} pieces incl. cockpit fixtures)`);
  ok(inside.furn === 0, `…but answers to nothing (${inside.furn} furniture interactables)`);
  ok(inside.stations.length === 0, `no terminal / computer / implant bay while visiting (${inside.stations.join(',') || 'none'})`);
  ok(inside.pods === 0, `no launch pod in a visited ship (${inside.pods})`);
  ok(inside.exit, 'hub_hangar_exit registered at the airlock');
  ok(inside.manage === false, '시설 관리 (M) is refused while visiting');
  // `hub/parts/Interior` spawns a bay visitor on the airlock plate and steps them 3 m forward (−Z) so the
  // 격납고로 나가기 prompt (radius 2.2) is not already on screen — i.e. just inboard of the airlock, aft of every room.
  ok(inside.z < inside.airlockZ && inside.z > inside.airlockZ - 5,
    `B walked in at the airlock end of the ship (z ${inside.z.toFixed(1)}, airlock ${inside.airlockZ.toFixed(1)})`);
  const roDeny = await B.evaluate(() => window.__notify.slice(-3).join(' | '));
  ok(/관리할 수 없습니다/.test(roDeny), `…with a Korean reason ("${roDeny}")`);
  const visitEv = await B.evaluate(() => window.__visits.slice(-1)[0]);
  ok(visitEv && visitEv.readOnly === true && visitEv.peerId === aId, `hub:shipVisit {peerId, readOnly:true} emitted (${JSON.stringify(visitEv)})`);

  /* ── 7. co-presence: A cannot see B any more ────────────────────────── */
  console.log('co-presence');
  await waitSim(A, 1.0);
  const seen = await A.evaluate(() => {
    const rp = window.__game.getSystem('remotePlayers');
    const refs = window.__game.ctx.net.getRemotePlayers();
    return refs.map((r) => ({ id: r.id, site: r.hubSite ?? null, shown: rp.getAvatar(r.id)?.isShown ?? null }));
  });
  ok(seen.length === 1 && seen[0].site !== null, `A sees B's ref carrying hubSite (${JSON.stringify(seen[0])})`);
  ok(seen[0].shown === false, 'B\'s avatar is hidden — A is on the shared deck, B is inside a ship');
  ok(await A.evaluate(() => window.__game.ctx.hub.hubSite === null), 'A\'s own hubSite is null on the shared deck');

  // A follows B into the same ship → both visible again
  await A.evaluate((s) => window.__game.ctx.hub.enterShipBay(s), aSlot);
  await waitFor(A, () => window.__game.ctx.hub.ship === 'personal', 'A inside its own ship');
  await waitSim(A, 1.2);
  const together = await A.evaluate(() => {
    const rp = window.__game.getSystem('remotePlayers');
    const refs = window.__game.ctx.net.getRemotePlayers();
    return { site: window.__game.ctx.hub.hubSite, ro: window.__game.ctx.hub.visitReadOnly, peers: refs.map((r) => ({ site: r.hubSite ?? null, shown: rp.getAvatar(r.id)?.isShown ?? null })) };
  });
  ok(together.ro === false, 'A is in its OWN ship — not read-only');
  ok(together.peers.length === 1 && together.peers[0].site === together.site, `A and B report the same hubSite (${together.site})`);
  ok(together.peers[0].shown === true, 'B\'s avatar is drawn again — both are touring the same ship');
  const aStations = await A.evaluate(() => window.__game.ctx.interactables.all().map((i) => i.id));
  ok(aStations.includes('hub_terminal') && aStations.includes('hub_implant_bay'), 'A keeps every station in its own ship');
  ok(aStations.filter((i) => /^hub_pod_/.test(i)).length === 0, 'A gets no launch pod there either (the squad launches from the shared deck)');
  ok(aStations.includes('hub_hangar_exit'), 'A can walk back out too');

  /* ── 8. back out to the hangar ──────────────────────────────────────── */
  console.log('leaving');
  await B.evaluate(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_hangar_exit').interact());
  await waitFor(B, () => window.__game.ctx.hub.ship === 'shared', 'B back in the shared ship');
  await waitSim(B, 0.4);
  const back = await B.evaluate((s) => {
    const ctx = window.__game.ctx;
    const bay = ctx.hub.getShipBays().find((b) => b.slot === s);
    const d = Math.hypot(ctx.player.position.x - bay.entrance.x, ctx.player.position.z - bay.entrance.z);
    return { site: ctx.hub.hubSite, visiting: ctx.hub.visitingPeer, d, ids: ctx.interactables.all().map((i) => i.id) };
  }, aSlot);
  ok(back.site === null && back.visiting === null, 'the visit is over (hubSite null)');
  ok(back.d < 1.0, `B stepped out right in front of the bay it entered (${back.d.toFixed(2)} m)`);
  ok(back.ids.filter((i) => /^hub_ship_bay_/.test(i)).length === 4 && !back.ids.includes('hub_hangar_exit'), 'the bays are back and the exit is gone');
  ok(back.ids.includes('hub_terminal') && back.ids.filter((i) => /^hub_pod_/.test(i)).length === 4, 'the shared deck kept its terminal and 4 launch pods');
  const backEv = await B.evaluate(() => window.__visits.slice(-1)[0]);
  ok(backEv && backEv.peerId === null && backEv.readOnly === false, `hub:shipVisit {peerId:null} on the way out (${JSON.stringify(backEv)})`);

  /* ── 9. leaving the squad from inside a ship undocks properly ───────── */
  console.log('leaving the squad from inside a ship');
  await A.evaluate(() => window.__game.ctx.net.leaveLobby());
  await waitFor(A, () => window.__game.ctx.hub.ship === 'personal' && !window.__game.ctx.net.lobby, 'A undocked to its solo ship', 25000);
  await waitSim(A, 0.4);
  const solo = await A.evaluate(() => {
    const ctx = window.__game.ctx;
    const ids = ctx.interactables.all().map((i) => i.id);
    return { site: ctx.hub.hubSite, bays: ctx.hub.getShipBays().length, pods: ids.filter((i) => /^hub_pod_/.test(i)).length, exit: ids.includes('hub_hangar_exit') };
  });
  ok(solo.site === null && !solo.exit, 'A is in the ordinary solo personal ship (no visit, no hangar exit)');
  ok(solo.pods === 1, `…and its own launch pod is back (${solo.pods})`);
  ok(solo.bays === 0, 'no bays outside the shared ship');

  // leave the squad on both sides so the relay keeps no lobby for the next run
  await B.evaluate(() => window.__game.ctx.net.leaveLobby()).catch(() => {});
  ok(errors.A.length === 0, 'A: no console errors', errors.A.slice(0, 4).join(' | '));
  ok(errors.B.length === 0, 'B: no console errors', errors.B.slice(0, 4).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness: ${e.message}`);
  for (const tag of ['A', 'B']) if (errors[tag].length) console.log(`  ${tag} console errors: ${errors[tag].slice(0, 6).join(' | ')}`);
} finally {
  for (const b of browsers) await b.close();
}

console.log(`\nsmoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
