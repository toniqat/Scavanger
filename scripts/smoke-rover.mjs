// 탐사 차량 스모크 (2026-09-13, R2 — src/world/rover).
//
// 왜 있나: 레이드당 한 대 도는 자동 장갑차의 흐름(정차 → 탑승 → 결제 → 유예 → 이동 → 도착 강제 하차 → 순환 → 파괴)이
// 여러 폴더(world 차량 · player 탑승 · meta 크레딧)에 걸쳐 있어, 하나가 어긋나면 조용히 "못 탄다 / 안 간다" 가 된다.
//
// 검사 (차량이 있는 첫 시드에서, 싱글 = 자기가 호스트):
//   1. `ctx.world.rover` · 정류장 4–5곳 · 경로 길이 · 정차(stopped) · 체력 가득 · targetable
//   2. 탑승 상호작용 프롬프트 · 홀드 시간 → 탑승: localAboard · player.roverRide · riders 'local' · 정류장 공개 · 목적지 선택 열기
//   3. 요금: 10 단위 · [150, 600] · 현재 정류장 거절 · 결제 → 크레딧 차감 = 요금 · departing · tripStarted(local)
//   4. 유예 뒤 trip · 이동 중 탑승 프롬프트 거절 · 치트 arrive → 도착 · 강제 하차 · 목적지 곁
//   5. 순환 출발(depart) · 곁에 세운 적에게 포탑이 쏜다
//   6. 다시 도착 → 탑승 → 피해 → 체력 0 → destroyed · 탑승자 하차 · targetable false · 탑승 거절
//
// Usage: node scripts/smoke-rover.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
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
/** 실시간이 아니라 시뮬레이션 시간으로 기다린다. */
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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

    // 강하가 끝나고 몸이 설 때까지 기다린 뒤 차량 옆으로
    await waitFor(page, () => { const p = window.__game.ctx.player; return p && !p.isDropping && !p.isDead; }, 'player landed', 40000);
    // 브라우저에서 도는 함수 그 자체다 — `waitFor` 가 `page.evaluate(fn)` 으로 넘긴다 (안에서 `page` 를 부르면 ReferenceError 가 조용히 삼켜진다)
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
    const shot = await page.evaluate(() => {
      const es = window.__game.getSystem('enemies');
      const e = es.byId.get(window.__rvEnemy);
      const r = { hp: e ? e.hp : null, dead: e ? e.state === 'dead' : true };
      if (e && e.state !== 'dead') e.takeDamage(999999, undefined, undefined, 'ai');
      return r;
    });
    const firedAfter = (await events(page, 'rover:fired')).length;
    if (spawn) ok(firedAfter > firedBefore && (shot.dead || shot.hp < spawn.hp), `순환 중 포탑이 곁의 적을 쏜다 (${firedAfter - firedBefore}발 · hp ${spawn.hp} → ${shot.hp})`);
    else console.log('  --   포탑 검사 건너뜀 (적을 세우지 못했다)');

    /* ── 6 ── */
    await page.evaluate(() => { window.__game.ctx.bus.emit('cheat:rover', { action: 'arrive' }); });
    await waitFor(page, () => window.__game.ctx.world.rover.vehicle.state === 'stopped', 'patrol arrived', 60000);
    await waitFor(page, tpNear, 'teleport next to rover again', 20000);
    await waitSim(page, 0.3);
    const again = await page.evaluate(() => {
      const ctx = window.__game.ctx, rv = ctx.world.rover;
      ctx.interactables.all().find((i) => i.id === 'rover:board').interact();
      // 포탑 검사에서 맞은 적이 어그로로 차량을 한 번 쳤을 수 있다 (적 ↔ 차량, 정상) — 절대값이 아니라 이번 피해의 차이를 본다
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
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
