// Rover smoke (2026-09-13, R2 — src/world/rover).
//
// Why it exists: the flow of the one automated armoured car per raid (the dwell → boarding → the fare → the grace →
// travel → a forced dismount on arrival → the patrol loop → destruction) spans several folders (world's vehicle ·
// player's riding · meta's credits), so one of them slipping quietly becomes 「cannot board / does not go」.
//
// Checks (on the first seed with a rover, solo = this client is the host):
//   1. `ctx.world.rover` · 4–5 stations · the route length · stopped · full hp · targetable
//   2. The boarding interaction's prompt · hold time → boarding: localAboard · player.roverRide · 'local' in riders ·
//      the stations revealed · the destination picker opening
//   3. The fare: in steps of 10 · [150, 600] · the current station refused · paying → the credits taken = the fare ·
//      departing · tripStarted(local)
//   4. `trip` after the grace · the boarding prompt refused while moving · the cheat `arrive` → arrival · a forced
//      dismount · beside the destination
//   5. Departing on the patrol loop (`depart`) · the turret firing at an enemy stood beside it (the surroundings are
//      cleared, and the target at the moment of the shot ties 「it fired」 and 「its hp went down」 to one body)
//   6. Arriving again → boarding → damage → hp 0 → destroyed · the rider dismounts · targetable false · boarding
//      refused
//
// Usage: node scripts/smoke-rover.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEEDS = [21, 7, 1234, 99, 4242, 5, 314, 2718];
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
async function waitFor(page, fn, label, timeout = 90000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}
/** Waits on simulation time rather than the wall clock. */
async function waitSim(page, seconds) {
  const t0 = await page.evaluate(() => window.__game.ctx.time);
  await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${seconds}s`, 120000, t0 + seconds);
}
const events = (page, name) => page.evaluate((n) => window.__rvEv.filter((e) => e.n === n), name);

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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const b = window.__game.ctx.bus;
    window.__rvEv = [];
    const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (x && x.isVector3 ? [x.x, x.y, x.z] : x)));
    for (const n of ['rover:destinationSelect', 'rover:state', 'rover:stationsRevealed', 'rover:boarded', 'rover:tripStarted',
      'rover:departed', 'rover:refused', 'rover:arrived', 'rover:damaged', 'rover:destroyed', 'rover:fired']) {
      b.on(n, (p) => window.__rvEv.push({ n, p: plain(p) }));
    }
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');

  let tested = false;
  for (const seed of SEEDS) {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    const has = await page.evaluate(() => !!window.__game.ctx.world.rover);
    if (!has) { console.log(`seed ${seed}: no rover route — next seed`); continue; }
    console.log(`seed ${seed}`);
    tested = true;

    /* ── 1 ── */
    const s1 = await page.evaluate(() => {
      const rv = window.__game.ctx.world.rover, v = rv.vehicle;
      return {
        stations: rv.route.stations.length, length: rv.route.length, state: v.state, hp: v.hp, maxHp: v.maxHp,
        stationId: v.stationId, targetable: rv.targetable, dims: [rv.halfLength, rv.halfWidth, rv.height],
        ids: rv.route.stations.map((s) => s.id), sOrdered: rv.route.stations.every((s, i, a) => i === 0 || s.s > a[i - 1].s),
      };
    });
    ok(s1.stations >= 4 && s1.stations <= 5, `정류장 4–5곳 (${s1.stations})`, JSON.stringify(s1.ids));
    ok(s1.length > 100 && s1.sOrdered, `경로 길이 ${s1.length.toFixed(0)} m · 정류장 s 오름차순`);
    ok(s1.state === 'stopped' && !!s1.stationId, `처음에는 정류장에 서 있다 (${s1.state} @ ${s1.stationId})`);
    ok(s1.hp === 2000 && s1.maxHp === 2000 && s1.targetable, `체력 ${s1.hp}/${s1.maxHp} · targetable`);

    // Wait until the drop is over and the body is standing, then go over beside the vehicle
    await waitFor(page, () => { const p = window.__game.ctx.player; return p && !p.isDropping && !p.isDead; }, 'player landed', 40000);
    // This function itself runs in the browser — `waitFor` hands it over through `page.evaluate(fn)` (calling
    // `page` inside it raises a ReferenceError that is swallowed silently)
    const tpNear = () => {
      const ctx = window.__game.ctx, rv = ctx.world.rover, v = rv.vehicle, p = ctx.player;
      const c = Math.cos(v.yaw), s = Math.sin(v.yaw), off = rv.halfWidth + 1.8;
      const to = v.position.clone(); to.x += -s * off; to.z += c * off;
      to.y = ctx.world.getSurfaceY(to.x, to.z, v.position.y + 0.6);
      p.teleport(to, 0, true);
      return Math.hypot(p.position.x - to.x, p.position.z - to.z) < 1.5;
    };
    try {
      await waitFor(page, tpNear, 'teleport next to rover', 20000);
    } catch (e) {
      const diag = await page.evaluate(() => {
        const ctx = window.__game.ctx, ps = window.__game.getSystem('player'), p = ctx.player, v = ctx.world.rover.vehicle;
        let tpError = null, after = null, to = null;
        try {
          const rv = ctx.world.rover, c = Math.cos(v.yaw), s = Math.sin(v.yaw), off = rv.halfWidth + 1.8;
          const t = v.position.clone(); t.x += -s * off; t.z += c * off;
          t.y = ctx.world.getSurfaceY(t.x, t.z, v.position.y + 0.6);
          to = [t.x, t.y, t.z].map((n) => +n.toFixed(1));
          p.teleport(t, 0, true);
          after = [p.position.x, p.position.y, p.position.z].map((n) => +n.toFixed(1));
        } catch (err) { tpError = String(err && err.stack || err); }
        return {
          tpError, to, after, roverRide: p.roverRide,
          spawned: ps.spawned, dead: p.isDead, inPod: ps._inPod, pod: ps.hellpod?.state, podActive: ps.hellpod?.isActive,
          dropping: p.isDropping, phase: ctx.phase, pos: [p.position.x, p.position.y, p.position.z].map((n) => +n.toFixed(1)),
          rover: [v.position.x, v.position.y, v.position.z].map((n) => +n.toFixed(1)), yaw: v.yaw,
        };
      });
      console.log('  diag', JSON.stringify(diag));
      throw e;
    }
    await waitSim(page, 0.3);

    /* ── 2 ── */
    const board = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover;
      const it = ctx.interactables.all().find((i) => i.id === 'rover:board');
      if (!it) return null;
      const before = { prompt: it.getPrompt(), hold: it.holdTime, can: it.canInteract(), hidePillar: !!it.hidePillar };
      it.interact();
      return { before, aboard: rv.localAboard, ride: ctx.player.roverRide === true, riders: rv.vehicle.riders.slice(), revealed: rv.stationsRevealed };
    });
    ok(!!board, '탑승 상호작용 rover:board 가 등록돼 있다');
    if (!board) break;
    ok(board.before.prompt === '탐사 차량 탑승' && board.before.hold === 1 && board.before.can && board.before.hidePillar,
      '프롬프트 「탐사 차량 탑승」 · 홀드 1초 · 빛기둥 없음', JSON.stringify(board.before));
    ok(board.aboard && board.ride && board.riders.includes('local'), '탑승: localAboard · player.roverRide · riders 에 local', JSON.stringify(board));
    ok(board.revealed && (await events(page, 'rover:stationsRevealed')).length === 1, '첫 탑승에 모든 정류장이 공개된다 (사건 1회)');
    ok((await events(page, 'rover:destinationSelect')).some((e) => e.p.open === true), '정차 중 탑승 → 목적지 선택 열기');
    ok((await events(page, 'rover:boarded')).some((e) => e.p.local && e.p.aboard), 'rover:boarded (local, aboard)');

    /* ── 3 ── */
    const trip = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover, v = rv.vehicle;
      ctx.meta.addCredits(3000, 'smoke:rover');
      const here = v.stationId;
      const target = rv.route.stations.find((s) => s.id !== here && !rv.isStationSwallowed(s.id));
      const fares = rv.route.stations.filter((s) => s.id !== here).map((s) => rv.fareTo(s.id));
      const credits0 = ctx.meta.credits;
      const fare = rv.fareTo(target.id);
      const dist = rv.tripDistance(target.id);
      const hereBlock = rv.tripBlock(here);
      const block = rv.tripBlock(target.id);
      const res = rv.requestTrip(target.id);
      return {
        here, target: target.id, targetPos: [target.position.x, target.position.z], fares, fare, dist, hereBlock, block, res,
        state: v.state, credits0, credits1: ctx.meta.credits, timer: v.timer, targetId: v.targetId,
      };
    });
    ok(trip.fares.every((f) => Number.isInteger(f) && f % 10 === 0 && f >= 150 && f <= 600), `요금 10 단위 · [150, 600] (${trip.fares.join(', ')})`);
    ok(trip.dist > 0 && trip.hereBlock === '현재 정류장입니다' && trip.block === null, `거리 ${trip.dist?.toFixed(0)} m · 현재 정류장 거절 · 목적지 가능`, JSON.stringify(trip));
    ok(trip.res === null && trip.state === 'departing' && trip.targetId === trip.target, `결제 → departing (${trip.state} → ${trip.targetId})`);
    ok(trip.credits0 - trip.credits1 === trip.fare, `크레딧 차감 = 요금 (${trip.credits0} → ${trip.credits1}, 요금 ${trip.fare})`);
    ok((await events(page, 'rover:tripStarted')).some((e) => e.p.local && e.p.fare === trip.fare && e.p.toId === trip.target), 'rover:tripStarted (local · 요금 · 목적지)');

    /* ── 4 ── */
    await waitSim(page, 5.6);
    const moving = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover;
      const it = ctx.interactables.all().find((i) => i.id === 'rover:board');
      return { state: rv.vehicle.state, prompt: it.getPrompt(), hold: it.holdTime, ride: ctx.player.roverRide === true };
    });
    ok(moving.state === 'trip' && moving.ride, `유예 뒤 trip · 여전히 타 있다 (${moving.state})`);
    ok(moving.prompt === '이동 중에는 탈 수 없습니다' && moving.hold === 0, '이동 중 탑승 프롬프트 거절 · 홀드 0', JSON.stringify(moving));
    ok((await events(page, 'rover:departed')).some((e) => e.p.trip === true), 'rover:departed (trip)');
    await page.evaluate(() => { window.__game.ctx.bus.emit('cheat:rover', { action: 'arrive' }); });
    await waitFor(page, () => window.__game.ctx.world.rover.vehicle.state === 'stopped', 'arrived', 60000);
    await waitSim(page, 0.2);
    const arrived = await page.evaluate((tp) => {
      const ctx = window.__game.ctx, rv = ctx.world.rover, v = rv.vehicle, p = ctx.player;
      return {
        stationId: v.stationId, ride: p.roverRide === true, aboard: rv.localAboard, riders: v.riders.length, timer: v.timer,
        near: Math.hypot(p.position.x - tp[0], p.position.z - tp[1]),
      };
    }, trip.targetPos);
    ok(arrived.stationId === trip.target, `목적지 정류장에 섰다 (${arrived.stationId})`);
    ok(!arrived.ride && !arrived.aboard && arrived.riders === 0, '도착 → 전원 강제 하차', JSON.stringify(arrived));
    ok(arrived.near < 16, `하차 자리가 목적지 곁이다 (${arrived.near.toFixed(1)} m)`);
    ok((await events(page, 'rover:arrived')).some((e) => e.p.trip && e.p.stationId === trip.target), 'rover:arrived (trip)');

    /* ── 5 ── */
    await page.evaluate(() => { window.__game.ctx.bus.emit('cheat:rover', { action: 'depart' }); });
    await waitFor(page, () => window.__game.ctx.world.rover.vehicle.state === 'patrol', 'patrol', 20000);
    // The turret picks the **nearest** enemy inside its range (ROVER_TURRET_RANGE) and hits it directly
    // (src/world/rover/parts/Turret.ts). So reading 「it fired」 (the rover:fired count) and 「this enemy's hp went
    // down」 apart judges two different bodies — with a closer bug around it can fire 20 rounds and the enemy stood
    // here keeps its hp. The two conditions are tied to one body:
    //   ① every other living enemy is cleared away before it is stood up. The patrol loop covers more than 40 m in
    //      5 s, so cutting by 「a radius around the current spot」 is not enough. They are despawned rather than
    //      killed — the shallowest removal, which makes no corpse · loot · death performance. Eggs (isEgg) are left
    //      alone: queryNear filters them out by default, so they never compete for the target.
    //   ② rover:fired names the body the round went to (targetId, 2026-09-21 B-73). Until then the event carried
    //      only from · to, and this check had to reach through the world system into the turret's private state;
    //      now the recorder above already holds every round's target. The authority fires on the line after
    //      takeDamage, so the id on the event is the enemy that took it.
    const cleared = await page.evaluate(() => {
      const es = window.__game.getSystem('enemies');
      const others = es.getEnemies().filter((e) => !e.isDead && !e.isEgg);
      for (const e of others) es.despawn(e);
      return others.length;
    });
    const firedBefore = (await events(page, 'rover:fired')).length;
    const spawn = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover, v = rv.vehicle;
      const es = window.__game.getSystem('enemies');
      const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
      const at = { x: v.position.x - s * 13, z: v.position.z + c * 13 };
      const e = es.debugSpawn('warrior', at, false);
      if (!e) return null;
      e.wanderTimer = 1e9; e.aware = false; e.state = 'idle';
      window.__rvEnemy = e.id;
      return { id: e.id, hp: e.hp };
    });
    await waitSim(page, 5);
    const hurt = await page.evaluate(() => {
      const es = window.__game.getSystem('enemies');
      const e = es.byId.get(window.__rvEnemy);
      const r = { hp: e ? e.hp : null, dead: e ? e.state === 'dead' : true };
      if (e && e.state !== 'dead') e.takeDamage(999999, undefined, undefined, 'ai');
      return r;
    });
    const rounds = (await events(page, 'rover:fired')).slice(firedBefore).map((e) => e.p.targetId);
    const firedAfter = firedBefore + rounds.length;
    const shot = {
      ...hurt,
      mine: rounds.filter((id) => id === spawn?.id).length,
      others: [...new Set(rounds.filter((id) => id !== null && id !== spawn?.id))],
    };
    if (spawn) {
      // Rounds fired at an enemy that surfaced after the clear-out may be mixed in — they are printed as they
      // are, but the judgement uses only the rounds that went to this enemy
      if (shot.others.length) console.log(`  --   포탑이 다른 적도 쐈다 (id ${shot.others.join(', ')})`);
      ok(firedAfter > firedBefore && shot.mine > 0 && (shot.dead || shot.hp < spawn.hp),
        `순환 중 포탑이 곁의 적을 쏜다 (다른 적 ${cleared}마리 치움 · ${firedAfter - firedBefore}발 중 이 적에게 ${shot.mine}발 · hp ${spawn.hp} → ${shot.hp})`,
        JSON.stringify({ id: spawn.id, ...shot }));
    } else console.log('  --   포탑 검사 건너뜀 (적을 세우지 못했다)');

    /* ── 6 ── */
    await page.evaluate(() => { window.__game.ctx.bus.emit('cheat:rover', { action: 'arrive' }); });
    await waitFor(page, () => window.__game.ctx.world.rover.vehicle.state === 'stopped', 'patrol arrived', 60000);
    await waitFor(page, tpNear, 'teleport next to rover again', 20000);
    await waitSim(page, 0.3);
    const again = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover;
      ctx.interactables.all().find((i) => i.id === 'rover:board').interact();
      // The enemy hit during the turret check may have struck the vehicle once out of aggro (enemy ↔ vehicle,
      // which is normal) — the difference this damage makes is read, not the absolute value
      const before = rv.vehicle.hp;
      rv.damage(100);
      return { aboard: rv.localAboard, before, hp: rv.vehicle.hp };
    });
    ok(again.aboard && again.before - again.hp === 100, `다시 탔다 · 피해 100 → 체력 ${again.before} → ${again.hp}`);
    await page.evaluate(() => { window.__game.ctx.bus.emit('cheat:rover', { action: 'hp', value: 0 }); });
    await waitSim(page, 0.3);
    const dead = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover, v = rv.vehicle, p = ctx.player;
      const it = ctx.interactables.all().find((i) => i.id === 'rover:board');
      const refused0 = window.__rvEv.filter((e) => e.n === 'rover:refused').length;
      const prompt = it.getPrompt(), hold = it.holdTime;
      it.interact();
      const refused1 = window.__rvEv.filter((e) => e.n === 'rover:refused').length;
      return {
        state: v.state, targetable: rv.targetable, ride: p.roverRide === true, aboard: rv.localAboard,
        dist: Math.hypot(p.position.x - v.position.x, p.position.z - v.position.z), prompt, hold, refused: refused1 - refused0,
      };
    });
    ok(dead.state === 'destroyed' && !dead.targetable, `체력 0 → destroyed · targetable false (${dead.state})`);
    ok(!dead.ride && !dead.aboard && dead.dist < 10, `파괴 → 탑승자 그 자리 하차 (${dead.dist.toFixed(1)} m)`, JSON.stringify(dead));
    ok(dead.prompt === '파괴된 차량' && dead.hold === 0 && dead.refused === 1 && !dead.aboard, '파괴된 차량은 탑승을 거절한다', JSON.stringify(dead));
    ok((await events(page, 'rover:destroyed')).length === 1, 'rover:destroyed 1회');
    break;
  }
  ok(tested, 'a seed with a rover route was found');
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await closeBrowser(browser);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
