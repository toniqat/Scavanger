// 전차 위의 적 · 적 시체 스모크 (2026-09-11, C-18).
//
// 왜 있나: 적은 발판 질의가 없어 달리는 전차 데크 위에서 벽에 밀리거나 바닥에 남겨졌고, 전차 위에서 죽은 적의 시체는
// 사망 지점(허공)에 고정됐다. 이제 적 · 시체가 플레이어와 같은 `shared/ride.ts` 규약으로 탄다 (`enemies/ai/Ride.ts`).
//
// 검사 (선로가 있는 첫 시드에서):
//   1. 데크에 세운 적이 탑승을 잡고(`carrier`), 전차가 수십 m 달리는 동안 **차량 로컬 자리**를 지킨다 · 데크 높이에 서 있다
//   2. 탄 적의 `velocity` 는 로컬 속도다 — 전차 속도로 흔들리지 않는다 (보행 애니메이션 · 발소리) · 전차에 치이지 않는다
//   3. 데크 위에서 죽은 로그의 시체가 전차와 함께 가고, 수색 상호작용(`corpse:<id>`) 자리도 몸을 따라간다
//   4. 로그 강하 목표: 전차 컨테이너 구역(`tram_*`)은 가장 가까운 플랫폼으로 바뀌고, 다른 구역은 그대로다
//   5. 리플리카 탑승 예측: 권한을 내리고(`setAuthority(false)`) 호스트처럼 스냅샷을 먹이면, 보간 지연(0.12 s × 전차 속도)
//      만큼 뒤처지지 않고 데크의 같은 자리에 그려진다
//   6. (C-63, 3 과 4 사이) 달리는 전차에서 차량 부피를 벗어난 적이 하차 관성으로 진행 방향으로 밀려 간다 ·
//      선로 발판 위(데크보다 0.35 m 낮다)에 선 적도 치인다 · 전차 위 분대원 시체의 `pcorpse` 와이어에 `ride` 가 실리고,
//      받는 쪽은 보간 지연만큼 뒤진 `p`(전차 밖) 대신 그 `ride` 로 후미에 타서 따라간다 (리스너 · add 순서 둘 다)
//
// Usage: node scripts/smoke-tram-ride.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEEDS = [21, 7, 1234, 99, 4242];
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
  await quietViteHmr(page);   // another editor's save must not full-reload the page mid-run (scripts/quiet-hmr.mjs)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');

  let tested = false;
  for (const seed of SEEDS) {
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    const hasRail = await page.evaluate(() => window.__game.ctx.world.getTrams().length > 0 && window.__game.ctx.world.getRailLines()[0].platforms.length >= 2);
    if (!hasRail) { console.log(`seed ${seed}: no rail line (RAIL_CHANCE) — next seed`); continue; }
    console.log(`seed ${seed}`);
    tested = true;

    // 플레이어를 전차에서 먼 모서리로 — 세운 적이 플레이어를 보고 달려가지 않게 (hellpod 가 끝날 때까지 다시 시도)
    await waitFor(page, () => {
      const ctx = window.__game.ctx, t = ctx.world.getTrams()[0], p = ctx.player;
      const V3 = ctx.camera.position.constructor;
      const far = new V3(t.position.x > 0 ? -250 : 250, 0, t.position.z > 0 ? -250 : 250);
      p.teleport(far, 0, true);
      return Math.hypot(p.position.x - far.x, p.position.z - far.z) < 2;
    }, 'player teleported away', 30000);

    /* ── 1 · 2 · 3 준비: 정차한 전차 데크 한가운데(승강구 사이 — 캐비닛이 없다)에 전사를 세우고, 조금 앞에 로그를 세워
       곧바로 죽인다 (로그 시체는 늘 수색 가능 = 상호작용이 등록된다). 전사는 제자리에 서 있게 배회 타이머를 막는다. */
    const setup = await page.evaluate(() => {
      const ctx = window.__game.ctx, w = ctx.world;
      const es = window.__game.getSystem('enemies');
      const t = w.getTrams()[0];
      const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
      const at = (lx, lz) => ({ x: t.position.x + lx * c - lz * s, z: t.position.z + lx * s + lz * c });
      const pr = at(0, 0), pv = at(1.1, 0);
      const rider = es.debugSpawn('warrior', pr, false);
      const victim = es.debugSpawn('rogue', pv, false);
      if (!rider || !victim) return null;
      rider.position.set(pr.x, t.position.y, pr.z);
      rider.wanderTimer = 1e9; rider.aware = false; rider.state = 'idle';
      victim.position.set(pv.x, t.position.y, pv.z);
      victim.takeDamage(99999, undefined, undefined, 'ai');
      window.__smokeRide = { rider: rider.id, victim: victim.id };
      return { rider: rider.id, victim: victim.id, state: t.state, dead: victim.state === 'dead', corpse: !!es.corpses.get(victim.id) };
    });
    ok(!!setup && setup.dead && setup.corpse, '데크 위에 전사를 세우고 로그를 죽였다 (시체 수색 자리 등록)', JSON.stringify(setup));
    if (!setup) break;
    await waitSim(page, 0.6);

    const snap = () => page.evaluate(() => {
      const ctx = window.__game.ctx, w = ctx.world;
      const es = window.__game.getSystem('enemies');
      const t = w.getTrams()[0];
      const r = es.byId.get(window.__smokeRide.rider), v = es.byId.get(window.__smokeRide.victim);
      const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
      const local = (p) => { const dx = p.x - t.position.x, dz = p.z - t.position.z; return [dx * c + dz * s, -dx * s + dz * c]; };
      let floor = null;
      for (const o of w.getObstacles()) {
        if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
        if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
      }
      const corpse = es.corpses.get(window.__smokeRide.victim);
      return {
        tram: [t.position.x, t.position.y, t.position.z], state: t.state,
        speed: floor ? Math.hypot(floor.velocity.x, floor.velocity.z) : 0,
        rider: r && r.active ? {
          p: [r.position.x, r.position.y, r.position.z], local: local(r.position), hp: r.hp, state: r.state,
          carrier: !!r.carrier, vel: Math.hypot(r.velocity.x, r.velocity.z), anim: r.anim.speed,
        } : null,
        victim: v && v.active ? { p: [v.position.x, v.position.y, v.position.z], local: local(v.position), dead: v.state === 'dead', carrier: !!v.carrier } : null,
        corpse: corpse ? [corpse.position.x, corpse.position.y, corpse.position.z] : null,
      };
    });
    const before = await snap();
    ok(!!before.rider && before.rider.carrier, '데크에 선 적이 탑승 발판을 잡는다 (carrier)', JSON.stringify(before.rider));
    ok(!!before.victim && before.victim.carrier, '데크 위 시체도 탑승 발판을 잡는다', JSON.stringify(before.victim));

    // 운전실 콘솔로 출발 — 알림 1 s + 가속 3 s 를 지나 최고 속도에서 한동안 달린 뒤 잰다
    await page.evaluate(() => { window.__game.ctx.interactables.all().find((i) => i.id === 'rail:tram_rail_0:console')?.interact(); });
    for (let i = 0; i < 16; i++) {
      await waitSim(page, 0.5);
      await page.evaluate(() => { const r = window.__game.getSystem('enemies').byId.get(window.__smokeRide.rider); if (r) { r.wanderTimer = 1e9; } });
    }
    const after = await snap();
    const moved = Math.hypot(after.tram[0] - before.tram[0], after.tram[2] - before.tram[2]);
    ok(after.state === 'moving' || moved > 20, `전차가 달렸다 (${after.state}, ${moved.toFixed(1)} m, ${after.speed.toFixed(1)} m/s)`);
    ok(moved > 20, `전차가 20 m 넘게 이동했다 (${moved.toFixed(1)} m)`);
    if (after.rider) {
      const dLocal = Math.hypot(after.rider.local[0] - before.rider.local[0], after.rider.local[1] - before.rider.local[1]);
      const dWorld = Math.hypot(after.rider.p[0] - before.rider.p[0], after.rider.p[2] - before.rider.p[2]);
      ok(after.rider.carrier && dLocal < 1.0, `C-18: 탄 적이 데크의 같은 자리를 지킨다 (로컬 Δ ${dLocal.toFixed(2)} m · 월드 ${dWorld.toFixed(1)} m)`, JSON.stringify(after.rider));
      ok(dWorld > moved * 0.8, `C-18: 탄 적이 전차와 함께 실려 갔다 (${dWorld.toFixed(1)} / ${moved.toFixed(1)} m)`);
      ok(Math.abs(after.rider.p[1] - after.tram[1]) < 0.35, `C-18: 데크 높이에 서 있다 (Δ ${(after.rider.p[1] - after.tram[1]).toFixed(2)} m)`);
      ok(after.speed < 5 || (after.rider.vel < 2.5 && after.rider.anim < 0.5),
        `C-18: 적의 velocity 는 로컬 속도 — 전차 속도(${after.speed.toFixed(1)})로 걷지 않는다 (vel ${after.rider.vel.toFixed(2)} · anim ${after.rider.anim.toFixed(2)})`);
      ok(after.rider.hp === before.rider.hp && after.rider.state !== 'dead', `C-18: 탄 적은 전차에 치이지 않는다 (hp ${before.rider.hp} → ${after.rider.hp})`);
    } else ok(false, 'C-18: 탄 적이 살아 있다', JSON.stringify(after));
    if (after.victim && after.corpse) {
      const dLocal = Math.hypot(after.victim.local[0] - before.victim.local[0], after.victim.local[1] - before.victim.local[1]);
      const dWorld = Math.hypot(after.victim.p[0] - before.victim.p[0], after.victim.p[2] - before.victim.p[2]);
      const dCorpse = Math.hypot(after.corpse[0] - after.victim.p[0], after.corpse[1] - after.victim.p[1], after.corpse[2] - after.victim.p[2]);
      ok(after.victim.dead && dLocal < 0.3 && dWorld > moved * 0.8, `C-18: 시체가 전차와 함께 간다 (로컬 Δ ${dLocal.toFixed(2)} m · 월드 ${dWorld.toFixed(1)} m)`, JSON.stringify(after.victim));
      ok(dCorpse < 0.2, `C-18: 수색 상호작용 자리가 시체를 따라간다 (Δ ${dCorpse.toFixed(2)} m)`, JSON.stringify({ corpse: after.corpse, body: after.victim.p }));
    } else ok(false, 'C-18: 시체와 수색 자리가 남아 있다', JSON.stringify(after));

    /* ── C-63 (2026-09-11): 적 하차 관성 · 선로 발판 위 적 치임 · 분대원 시체 와이어 탑승 ─────────────────
       전차가 최고 속도로 달리는 동안만 의미가 있다 (아니면 건너뛴다). 뒤의 4 · 5 가 쓸 주행 시간을 아끼려고 1.3 s 안에 끝낸다. */
    if (after.speed > 8 && after.state === 'moving') {
      const c63a = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world, mgr = ctx.corpses;
        const es = window.__game.getSystem('enemies');
        const t = w.getTrams()[0];
        const R = window.__smokeRide;
        let floor = null;
        for (const o of w.getObstacles()) {
          if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
          if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
        }
        if (!floor) return null;
        R.halfLen = floor.box.halfX; R.halfWid = floor.box.halfZ;
        const V3 = ctx.camera.position.constructor;
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const at = (lx, lz, y) => new V3(t.position.x + lx * c - lz * s, y, t.position.z + lx * s + lz * c);
        const local = (p) => { const dx = p.x - t.position.x, dz = p.z - t.position.z; return [dx * c + dz * s, -dx * s + dz * c]; };
        // 하차 관성용 적: 데크 뒤쪽 가운데 줄 (캐비닛은 옆벽에 붙어 있다)
        const jp = at(-3, 0, t.position.y);
        const jumper = es.debugSpawn('warrior', jp, false);
        if (jumper) { jumper.position.copy(jp); jumper.wanderTimer = 1e9; jumper.aware = false; jumper.state = 'idle'; R.jumper = jumper.id; }
        // 시체 와이어: 보낸 쪽(A)은 후미 끝에서 죽었다. 받는 쪽은 보간 지연만큼 뒤(전차 밖)의 p 를 받는다
        const lx = -R.halfLen + 0.4;
        const a = mgr.add('pcorpse:smokeA:1', 'smokeA', 'A', at(lx, 0, t.position.y), 0.3, ctx.missionTime, [], 0);
        const wire = a.toWire();
        const lag = at(lx - 1.5, 0, t.position.y);
        const p = [lag.x, lag.y, lag.z];
        // B: 리스너가 먼저 (ride 를 적어 두고 add 가 쓴다)
        const wB = { ...wire, id: 'pcorpse:smokeB:1', owner: 'smokeB', p };
        mgr.noteWireRide(wB);
        const b = mgr.add(wB.id, 'smokeB', 'B', lag.clone(), wire.yaw, ctx.missionTime, [], 0);
        // C: 시체가 먼저 서고(p 로는 못 탄다) 리스너가 뒤에 다시 태운다
        const wC = { ...wire, id: 'pcorpse:smokeC:1', owner: 'smokeC', p };
        const cc = mgr.add(wC.id, 'smokeC', 'C', lag.clone(), wire.yaw, ctx.missionTime, [], 0);
        const cBefore = cc.riding;
        mgr.noteWireRide(wC);
        // D: ride 없는 옛 와이어 — 같은 p 로는 전차를 놓친다 (C-63 이전의 틈, 참고용)
        const d = mgr.add('pcorpse:smokeD:1', 'smokeD', 'D', lag.clone(), wire.yaw, ctx.missionTime, [], 0);
        R.corpseLx = lx;
        return {
          jumper: !!jumper, aRiding: a.riding, ride: wire.ride ?? null, bRiding: b.riding, bLocal: local(b.position),
          yawErr: Math.abs(b.yaw - a.yaw), cBefore, cRiding: cc.riding, cLocal: local(cc.position), dRiding: d.riding,
        };
      });
      if (c63a) {
        const lx = -await page.evaluate(() => window.__smokeRide.halfLen) + 0.4;
        ok(c63a.aRiding && !!c63a.ride && c63a.ride.tram === 'tram_rail_0' && Math.abs(c63a.ride.local[0] - lx) < 0.05 && Math.abs(c63a.ride.local[2]) < 0.05,
          'C-63: 전차 위 시체의 와이어에 ride(전차 id · 차량 로컬 좌표)가 실린다', JSON.stringify(c63a.ride));
        ok(c63a.bRiding && Math.abs(c63a.bLocal[0] - lx) < 0.1 && Math.abs(c63a.bLocal[1]) < 0.1 && c63a.yawErr < 1e-3,
          `C-63: 받는 쪽(리스너 먼저)은 지연된 p 대신 ride 로 전차 후미에 탄다 (로컬 ${c63a.bLocal.map((v) => v.toFixed(2)).join(', ')})`);
        ok(!c63a.cBefore && c63a.cRiding && Math.abs(c63a.cLocal[0] - lx) < 0.1,
          `C-63: 받는 쪽(시체 먼저)도 ride 가 도착하면 전차 후미로 옮겨 탄다 (로컬 ${c63a.cLocal.map((v) => v.toFixed(2)).join(', ')})`);
        console.log(`  --   참고: ride 없는 옛 와이어의 같은 p 는 ${c63a.dRiding ? '탔다' : '전차를 놓친다'}`);
      } else ok(false, 'C-63: 준비', 'no tram floor');

      await waitSim(page, 0.3);
      const kick = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const es = window.__game.getSystem('enemies');
        const t = w.getTrams()[0];
        const R = window.__smokeRide;
        const j = es.byId.get(R.jumper);
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const at = (lx, lz) => ({ x: t.position.x + lx * c - lz * s, z: t.position.z + lx * s + lz * c });
        let floor = null;
        for (const o of w.getObstacles()) {
          if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
          if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
        }
        const sp = floor ? Math.hypot(floor.velocity.x, floor.velocity.z) : 0;
        const out = { boarded: !!j && !!j.carrier, speed: sp };
        if (j && sp > 1) {
          // 옆으로 차량 부피(단면 + RIDE_EDGE_MARGIN) 밖 — 걸어서 내린 것과 같다
          const off = at(-3, R.halfWid + 2.5);
          j.position.set(off.x, w.getSurfaceY(off.x, off.z, t.position.y), off.z);
          R.kickFrom = [j.position.x, j.position.z];
          R.kickDir = [floor.velocity.x / sp, floor.velocity.z / sp];
        }
        // 선로 발판 위, 전차 바로 앞 (발이 데크보다 TRAM_HIT_FLOOR_CLEAR … RIDE_FOOT_DROP 아래 띠)
        const ah = at(R.halfLen + 5, 0);
        const y = w.getSurfaceY(ah.x, ah.z, t.position.y - 0.2);
        out.band = t.position.y - y;
        const rail = es.debugSpawn('warrior', ah, false);
        if (rail) {
          rail.position.set(ah.x, y, ah.z);
          rail.wanderTimer = 1e9; rail.aware = false; rail.state = 'idle';
          R.railer = rail.id; R.railHp0 = rail.hp;
        }
        return out;
      });
      ok(kick.boarded, 'C-63: 관성 검사용 적이 데크에서 탑승을 잡았다', JSON.stringify(kick));

      await waitSim(page, 0.4);
      const inertia = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world, mgr = ctx.corpses;
        const es = window.__game.getSystem('enemies');
        const t = w.getTrams()[0];
        const R = window.__smokeRide;
        const j = es.byId.get(R.jumper);
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const local = (p) => { const dx = p.x - t.position.x, dz = p.z - t.position.z; return [dx * c + dz * s, -dx * s + dz * c]; };
        const b = mgr.get('pcorpse:smokeB:1'), cc = mgr.get('pcorpse:smokeC:1');
        return {
          along: j && R.kickFrom ? (j.position.x - R.kickFrom[0]) * R.kickDir[0] + (j.position.z - R.kickFrom[1]) * R.kickDir[1] : null,
          carrier: j ? !!j.carrier : null, inertiaT: j ? j.rideInertiaT : null,
          bLocal: b ? local(b.position) : null, cLocal: cc ? local(cc.position) : null,
        };
      });
      if (kick.speed > 8 && inertia.along !== null) {
        ok(!inertia.carrier && inertia.along > 1.2,
          `C-63: 차량 부피를 벗어난 적이 하차 관성으로 진행 방향으로 밀려 간다 (0.4 s 에 ${inertia.along.toFixed(2)} m, 전차 ${kick.speed.toFixed(1)} m/s)`, JSON.stringify(inertia));
      } else console.log(`  --   하차 관성 검사 건너뜀 (전차 ${kick.speed.toFixed(1)} m/s)`);
      if (c63a) {
        const lx = -await page.evaluate(() => window.__smokeRide.halfLen) + 0.4;
        ok(!!inertia.bLocal && !!inertia.cLocal && Math.abs(inertia.bLocal[0] - lx) < 0.2 && Math.abs(inertia.cLocal[0] - lx) < 0.2,
          'C-63: ride 로 탄 시체가 달리는 전차 후미를 그대로 따라간다', JSON.stringify(inertia));
      }

      await waitSim(page, 0.6);
      const railHit = await page.evaluate(() => {
        const es = window.__game.getSystem('enemies');
        const R = window.__smokeRide;
        const r = es.byId.get(R.railer);
        return { hp0: R.railHp0, hp: r ? r.hp : null, dead: r ? r.state === 'dead' : null };
      });
      if (kick.speed > 8 && kick.band > 0.2 && kick.band < 0.68) {
        ok(railHit.hp !== null && (railHit.hp < railHit.hp0 || railHit.dead),
          `C-63: 선로 발판 위(데크 −${kick.band.toFixed(2)} m)에 선 적도 달리는 전차에 치인다 (hp ${railHit.hp0} → ${railHit.hp})`, JSON.stringify(railHit));
      } else console.log(`  --   선로 발판 치임 검사 건너뜀 (띠 ${kick.band.toFixed(2)} m · 전차 ${kick.speed.toFixed(1)} m/s)`);
    } else console.log(`  --   C-63 검사 건너뜀 (전차 ${after.state}, ${after.speed.toFixed(1)} m/s)`);

    /* ── 4. 로그 강하 목표 ─────────────────────────────────────────── */
    const drop = await page.evaluate(() => {
      const ctx = window.__game.ctx, w = ctx.world;
      const es = window.__game.getSystem('enemies');
      const t = w.getTrams()[0];
      const plats = w.getRailLines().flatMap((l) => l.platforms);
      const got = es.rogueDrops.dropTargetFor(w, 'tram_rail_0', t.position);
      let nearest = null, nd = Infinity;
      for (const p of plats) { const d = Math.hypot(p.position.x - t.position.x, p.position.z - t.position.z); if (d < nd) { nd = d; nearest = p; } }
      const same = es.rogueDrops.dropTargetFor(w, 'structure_0', t.position);
      return {
        isNearestPlatform: !!nearest && got === nearest.position, notTram: Math.hypot(got.x - t.position.x, got.z - t.position.z),
        nearestD: nd, sameForStructure: same === t.position,
      };
    });
    ok(drop.isNearestPlatform, `C-18: 전차 구역 강하 목표 = 가장 가까운 플랫폼 (${drop.nearestD.toFixed(1)} m 떨어진)`, JSON.stringify(drop));
    ok(drop.sameForStructure, 'C-18: 전차가 아닌 구역은 조사 지점 그대로', JSON.stringify(drop));

    /* ── 5. 리플리카 탑승 예측 ─────────────────────────────────────── */
    const repStart = await page.evaluate(() => {
      const ctx = window.__game.ctx, w = ctx.world;
      const es = window.__game.getSystem('enemies');
      const t = w.getTrams()[0];
      const r = es.byId.get(window.__smokeRide.rider);
      if (!r) return null;
      const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
      const dx = r.position.x - t.position.x, dz = r.position.z - t.position.z;
      window.__smokeRide.local = [dx * c + dz * s, -dx * s + dz * c, r.position.y - t.position.y];
      window.__smokeRide.seq = 900000;
      es.setAuthority(false);
      return { replica: !es.isAuthority };
    });
    ok(!!repStart && repStart.replica, '권한을 내려 리플리카 경로로 바꿨다', JSON.stringify(repStart));
    const feed = () => page.evaluate(() => {
      const ctx = window.__game.ctx, w = ctx.world;
      const es = window.__game.getSystem('enemies');
      const t = w.getTrams()[0];
      const [lx, lz, ly] = window.__smokeRide.local;
      const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
      const p = [t.position.x + lx * c - lz * s, t.position.y + ly, t.position.z + lx * s + lz * c];
      es.debugApplySnapshot({ t: 'es', seq: ++window.__smokeRide.seq, full: true, e: [{ id: window.__smokeRide.rider, ty: 'warrior', p, yaw: t.yaw, hp: 640, st: 'idle' }] });
    });
    let worst = 0, rawMin = Infinity, speedMin = Infinity, samples = 0, carrierFrames = 0;
    for (let i = 0; i < 24; i++) {
      await feed();
      await waitSim(page, 0.1);
      if (i < 8) continue;   // 링 버퍼가 차고 블렌드가 올라올 때까지
      const m = await page.evaluate(() => {
        const ctx = window.__game.ctx, w = ctx.world;
        const es = window.__game.getSystem('enemies');
        const t = w.getTrams()[0];
        const r = es.byId.get(window.__smokeRide.rider);
        let floor = null;
        for (const o of w.getObstacles()) {
          if (o.kind !== 'tram' || !o.box || !o.velocity) continue;
          if (!floor || o.box.halfX * o.box.halfZ > floor.box.halfX * floor.box.halfZ) floor = o;
        }
        if (!r) return null;
        const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
        const dx = r.position.x - t.position.x, dz = r.position.z - t.position.z;
        const [lx, lz] = window.__smokeRide.local;
        // 예측 없이 보간만 했다면 그려졌을 자리 (NET_INTERP_DELAY 0.12 — src/shared/net.ts) — 예측이 실제로 일을 하는지의 근거
        const pose = { x: 0, y: 0, z: 0, yaw: 0 };
        r.netBuf.sampleAt(ctx.time - 0.12, pose);
        const rx = pose.x - t.position.x, rz = pose.z - t.position.z;
        return {
          err: Math.hypot(dx * c + dz * s - lx, -dx * s + dz * c - lz),
          raw: Math.hypot(rx * c + rz * s - lx, -rx * s + rz * c - lz),
          speed: floor ? Math.hypot(floor.velocity.x, floor.velocity.z) : 0, carrier: !!r.carrier,
        };
      });
      if (!m) break;
      samples++;
      worst = Math.max(worst, m.err);
      rawMin = Math.min(rawMin, m.raw);
      speedMin = Math.min(speedMin, m.speed);
      if (m.carrier) carrierFrames++;
    }
    if (samples > 0 && speedMin > 5) {
      ok(carrierFrames === samples, `C-18: 리플리카도 탑승을 잡는다 (${carrierFrames}/${samples})`);
      ok(worst < 0.6 && rawMin > 0.8, `C-18: 리플리카가 보간 지연만큼 뒤처지지 않는다 (최대 로컬 오차 ${worst.toFixed(2)} m · 예측 없는 보간 자리는 최소 ${rawMin.toFixed(2)} m 뒤, 전차 ≥ ${speedMin.toFixed(1)} m/s)`);
    } else {
      console.log(`  --   리플리카 예측 검사 건너뜀 (전차가 멈췄다: 최저 ${speedMin.toFixed(1)} m/s, 표본 ${samples})`);
    }
    break;
  }
  ok(tested, 'a seed with a rail line was found');
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
