// 버려진 구조물 · 선로 · 전차 스모크 (2026-09-09).
//
// 왜 있나: 이 배치가 world/ 에 **사각(OBB) 콜라이더**(`Obstacle.box`)를 처음 들여왔다. 벽 · 지하실 천장 슬래브 ·
// 플랫폼 데크 · 전차 차체가 전부 상자다. 원기둥 때와 같은 사고 — 콜라이더가 그려진 것보다 커져 보이지 않는
// 벽이 되는 것 (`scripts/smoke-props-collision.mjs` 의 2026-09-09 사건) — 을 **숫자로** 막는다.
//
// 검사:
//   1. 구조물이 시드마다 1개 이상 서고, `structureAt` 이 안/밖을 가른다
//   2. 모든 `box` 콜라이더가 자기 구조물이 **그린 바운딩 박스 안**에 있다 (여유 SLACK_M)
//   3. 실내가 걸어 다닐 수 있다: 방 한가운데는 밀려나지 않고, 벽 한가운데는 밀려난다
//   4. 벽이 총알을 막는다 (`raycast` 가 벽 두께 안에서 멈춘다)
//   5. 지하실: 해치가 잠긴 동안 윗면이 바닥 높이이고(그 위를 걷는다), 천장 슬래브 윗면도 바닥 높이다
//   6. 선로: 플랫폼 데크 윗면 = 전차 바닥 높이 (틈 없이 건너탄다), 계단이 한 단씩 `PROP_STEP_UP_MAX` 안이다
//   7. 전차: 시동을 걸면 데크가 움직이고 `getStandingObstacle(...).velocity` 가 `TRAM_SPEED` 를 가리킨다
//      (player/PlayerController 가 그 값을 위치에 더한다 — 실제로 실려 가는지의 근거)
//
// Usage: node scripts/smoke-structures.mjs [http://localhost:5273]
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const SEEDS = [21, 7, 1234];
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/** 상자 콜라이더가 그려진 실루엣 밖으로 나가도 봐주는 여유(m). */
const SLACK_M = 0.6;

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
/** swiftshader 는 몇 fps 라 실시간을 믿을 수 없다 — 시뮬레이션 시간으로 기다린다. */
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
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
  });
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');

  for (const seed of SEEDS) {
    console.log(`seed ${seed}`);
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(400);

    /* ── 1 · 2. 구조물이 서고, 상자 콜라이더가 그려진 것 안에 있다 ─────────── */
    const r = await page.evaluate((slack) => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const structs = world.getStructures().map((s) => ({
        id: s.id, kind: s.kind, x: s.position.x, y: s.position.y, z: s.position.z,
        radius: s.radius, hasBasement: s.hasBasement,
        door: s.basementDoor ? { x: s.basementDoor.x, y: s.basementDoor.y, z: s.basementDoor.z } : null,
        yaw: s.yaw,
      }));

      // 그려진 바운딩 박스: 이름이 구조물 id 로 시작하는 메시들(본체 · 글로우 · 콘솔 · 해치)의 합
      const drawn = new Map();
      const v = new V3();
      ctx.scene.traverse((n) => {
        if (!n.isMesh || !n.name) return;
        const owner = structs.find((s) => n.name.startsWith(s.id))?.id
          ?? (n.name.startsWith('rail_') || n.name === 'tram' ? 'rail' : null);
        if (!owner) return;
        n.updateWorldMatrix(true, false);
        const pos = n.geometry.getAttribute('position');
        if (!pos) return;
        let b = drawn.get(owner);
        if (!b) { b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, maxY: -Infinity }; drawn.set(owner, b); }
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(n.matrixWorld);
          if (v.x < b.minX) b.minX = v.x; if (v.x > b.maxX) b.maxX = v.x;
          if (v.z < b.minZ) b.minZ = v.z; if (v.z > b.maxZ) b.maxZ = v.z;
          if (v.y > b.maxY) b.maxY = v.y;
        }
      });

      // 상자 콜라이더 하나하나를 그 소유자의 바운딩 박스와 견준다
      let boxes = 0, worst = -Infinity, worstRow = null;
      for (const o of world.getObstacles()) {
        if (!o.box) continue;
        boxes++;
        const owner = ['building', 'slab', 'hatch', 'console'].includes(o.kind)
          ? structs.find((s) => Math.hypot(s.x - o.position.x, s.z - o.position.z) < s.radius + 12)?.id
          : 'rail';
        const b = owner ? drawn.get(owner) : null;
        if (!b) continue;
        const c = Math.cos(o.box.yaw), sn = Math.sin(o.box.yaw);
        let over = -Infinity;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          const lx = sx * o.box.halfX, lz = sz * o.box.halfZ;
          const wx = o.position.x + lx * c - lz * sn, wz = o.position.z + lx * sn + lz * c;
          over = Math.max(over, b.minX - wx, wx - b.maxX, b.minZ - wz, wz - b.maxZ);
        }
        if (over > worst) { worst = over; worstRow = { kind: o.kind, owner, over: +over.toFixed(2) }; }
      }

      // 원기둥 소품은 그대로여야 한다 (box 가 없는 항목이 여전히 대다수)
      const cylinders = world.getObstacles().filter((o) => !o.box).length;
      return { structs, boxes, cylinders, worst, worstRow, slack };
    }, SLACK_M);

    ok(r.structs.length >= 1, `structures placed (${r.structs.length}: ${r.structs.map((s) => s.kind).join(', ')})`);
    ok(r.boxes > 0, `box colliders registered (${r.boxes})`);
    ok(r.cylinders > 200, `cylinder props untouched (${r.cylinders})`);
    ok(r.worst <= SLACK_M, `no box collider reaches outside what its structure draws (worst +${r.worst.toFixed(2)} m)`, JSON.stringify(r.worstRow));

    /* ── 3 · 4 · 5. 실내 이동 · 엄폐 · 지하실 ───────────────────────────── */
    const inside = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const world = ctx.world;
      const V3 = ctx.camera.position.constructor;
      const s = world.getStructures()[0];
      if (!s) return null;
      const y = world.getSurfaceY(s.position.x, s.position.z, s.position.y + 0.5);

      // 방 한가운데(구조물 중심)에서는 밀려나지 않아야 한다 — 벽이 방을 통째로 막으면 여기서 잡힌다
      const p = new V3(s.position.x, y, s.position.z);
      const before = { x: p.x, z: p.z };
      world.resolveCollision(p, 0.4);
      const centreMove = Math.hypot(p.x - before.x, p.z - before.z);

      // 바깥 벽을 향해 쏜다 — 반드시 무언가에 막혀야 한다
      let blocked = 0, tries = 0;
      const o = new V3(s.position.x, y + 1.2, s.position.z), d = new V3();
      for (let a = 0; a < 8; a++) {
        d.set(Math.cos((a / 8) * Math.PI * 2), 0, Math.sin((a / 8) * Math.PI * 2));
        tries++;
        const hit = world.raycast(o, d, s.radius + 6);
        if (hit && hit.distance < s.radius + 2) blocked++;
      }

      // 지하실이 있으면: 잠긴 해치 윗면 = 지상층 바닥 높이
      let hatchTop = null, basementDrop = null;
      const withBase = world.getStructures().find((x) => x.hasBasement);
      if (withBase && withBase.basementDoor) {
        const dpos = withBase.basementDoor;
        hatchTop = world.getSurfaceY(dpos.x, dpos.z, dpos.y + 0.5) - dpos.y;
        basementDrop = dpos.y - world.getHeightAt(dpos.x, dpos.z);   // 구덩이 깊이
      }
      return { centreMove, blocked, tries, hatchTop, basementDrop, structs: world.getStructures().length };
    });

    if (inside) {
      ok(inside.centreMove < 0.01, `a structure's middle is standable (moved ${inside.centreMove.toFixed(3)} m)`);
      ok(inside.blocked >= 6, `walls stop shots from inside (${inside.blocked}/${inside.tries} directions blocked)`);
      if (inside.hatchTop !== null) {
        ok(Math.abs(inside.hatchTop) < 0.2, `locked hatch is walkable at floor level (Δ ${inside.hatchTop.toFixed(2)} m)`);
        ok(inside.basementDrop > 2, `the basement pit is actually dug (${inside.basementDrop.toFixed(1)} m below the floor)`);
      } else {
        console.log('  --   no basement this seed (basementChance)');
      }
    }

    /* ── 6 · 7. 선로 · 플랫폼 · 전차 ─────────────────────────────────── */
    const rail = await page.evaluate(() => {
      const world = window.__game.ctx.world;
      const lines = world.getRailLines();
      if (lines.length === 0) return null;
      const line = lines[0];
      const tram = world.getTrams()[0] ?? null;
      const plat = line.platforms[0];
      const deckTop = world.getSurfaceY(plat.position.x, plat.position.z, plat.position.y + 0.5);
      return {
        kind: line.kind, length: line.length, platforms: line.platforms.length,
        deckDelta: deckTop - plat.position.y,
        tram: tram ? { id: tram.id, s: tram.s, state: tram.state, y: tram.position.y } : null,
        platY: plat.position.y,
      };
    });

    if (!rail) {
      console.log('  --   no rail line this seed (RAIL_CHANCE)');
    } else {
      ok(rail.platforms >= 2, `rail has platforms (${rail.kind}, ${rail.platforms}, ${rail.length.toFixed(0)} m)`);
      ok(Math.abs(rail.deckDelta) < 0.2, `platform deck top is standable at its own height (Δ ${rail.deckDelta.toFixed(2)} m)`);
      ok(rail.tram !== null && rail.tram.state === 'idle', 'the tram waits until a console starts it');

      /* 2026-09-10 — 선로 자체가 **발판**이고 지형 위로 떠 있어야 한다.
       * `getSurfaceY`(발 높이 제한 없이)가 중심선 위에서 레일 상면을 돌려주면 콜라이더가 걸린 것이고,
       * 그 높이가 지형보다 확실히 위면 파묻히지 않은 것이다. */
      const deck = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const line = w.getRailLines()[0];
        const step = Math.max(1, Math.floor(line.points.length / 12));
        const out = [];
        for (let i = 0; i < line.points.length; i += step) {
          const p = line.points[i];
          const ground = w.getHeightAt(p.x, p.z);
          out.push({ deck: +(w.getSurfaceY(p.x, p.z) - ground).toFixed(2), clear: +(p.y - ground).toFixed(2) });
        }
        return out;
      });
      ok(deck.every((d) => d.deck >= d.clear - 0.35), `선로 위에 발판 콜라이더가 있다 (표본 ${deck.length}곳)`, JSON.stringify(deck));
      ok(deck.every((d) => d.clear > 0.4), '선로가 지형에 파묻히지 않는다', JSON.stringify(deck.map((d) => d.clear)));

      // 시동을 걸고 달리는 동안 데크가 발판 속도를 들고 있는지
      await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const id = w.getRailLines()[0].platforms[0].id;
        window.__game.ctx.interactables.all().find((i) => i.id === `rail:${id}:console`)?.interact();
      });
      // 2026-09-10: 출발은 알림 뒤 `TRAM_START_DELAY_S`(1초) 대기 + `TRAM_ACCEL_S`(3초) cubic 가속이다 —
      // 예전처럼 2초만 기다리면 아직 1 m/s 도 안 나온다. 최고 속도까지 간 뒤에 잰다.
      await waitSim(page, 5.5);
      const riding = await page.evaluate(() => {
        const w = window.__game.ctx.world;
        const t = w.getTrams()[0];
        const st = w.getStandingObstacle(t.position.x, t.position.z, t.position.y);
        return {
          state: t.state, s: t.s,
          hasDeck: !!st,
          speed: st && st.velocity ? Math.hypot(st.velocity.x, st.velocity.z) : 0,
          deckTop: w.getSurfaceY(t.position.x, t.position.z, t.position.y + 0.5) - t.position.y,
        };
      });
      ok(riding.state === 'moving' && riding.s !== rail.tram.s, `the tram runs after the console hold (s ${rail.tram.s.toFixed(0)} → ${riding.s.toFixed(0)})`);
      ok(Math.abs(riding.deckTop) < 0.2, `the tram deck is standable at the tram floor (Δ ${riding.deckTop.toFixed(2)} m)`);
      ok(riding.hasDeck && riding.speed > 5, `standing on the deck reports a ride velocity (${riding.speed.toFixed(1)} m/s)`, JSON.stringify(riding));
    }
  }

  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  FAIL harness ${String(e)}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
