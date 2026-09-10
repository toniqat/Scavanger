// 소품 콜라이더가 **그려진 실루엣보다 크지 않은지** 재는 스모크 (2026-09-09).
//
// 왜 있나: `Props.hullOf` 는 지오메트리 바운딩 박스로 콜라이더를 만든다. 그래서 정점 하나만 엉뚱한 데로
// 튀어도 소품 전체가 그것을 감싸는 거대한 **보이지 않는 원기둥**이 된다 — 걸어서 못 지나가고 총알이 허공에서
// 멈춘다. 실제로 `world/noise.ts` 의 `noise3` 가 `lerp` 인자 순서를 뒤집어 `[-1,1]` 대신 `[-31,+52]` 를
// 돌려주고 있었고, `build.displace` 가 그만큼 정점을 밀어 첨탑 콜라이더가 반지름 18 m 로 부풀었다.
// 눈으로는 가는 가시 하나라 안 보이고, 스모크는 전부 통과했다. 그래서 **숫자로** 잡는다.
//
// 검사:
//   1. `noise3` 의 실제 출력 범위 (문서가 약속하는 [-1, 1] 안인가)
//   2. 장애물 하나하나를 그 자리에 그려진 인스턴스와 1:1 로 맞춰(인스턴스 행렬의 이동 성분),
//      정점을 전부 훑어 **실측 최대 반지름 · 실측 윗면**과 콜라이더를 비교
//   3. 손으로 적어 둔 콜라이더(탈출 패드 조명 기둥 · 아웃포스트 안테나)가 그려진 굵기 안인가
//   4. (2026-09-10) 바위 · 첨탑 콜라이더가 **땅 위로 보이는** 바위보다 앞에서 막지 않는가 — 2번은 땅에 묻힌
//      정점까지 "그려진 것" 으로 세서 폭풍 안개 속 보이지 않는 벽을 못 잡았다. 내려 쏘는 레이로 잰다.
//      ⚠ 바위 · 첨탑 콜라이더의 중심은 이제 인스턴스 원점이 아니라 **보이는 윤곽의 중심**이다 (`Props.footprintOf`).
//      경사지에서 몇 m 옮겨진 바위는 2번의 XZ 이동 성분 매칭에서 빠지고, 그 바위들은 4번이 본다.
//   5. (2026-09-11) 바위 · 첨탑 · 크리스탈 · 잔해는 **볼록 윤곽**(`Obstacle.hull`)이다 — 4번은 방위마다 윤곽까지의
//      거리로 재고, 윤곽이 보이는 가장자리보다 안쪽으로 **파고들지도** 않는지(p10) 함께 본다.
//
// Usage: node scripts/smoke-props-collision.mjs [http://localhost:5273]
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

/* 콜라이더가 그려진 것보다 이만큼까지 커지는 것은 봐준다 (m).
 * 원기둥으로 울퉁불퉁한 것을 감싸는 근사라 정확히 0 일 수는 없다. 실측(시드 21/7/1234)에서
 * 제일 나쁜 값이 +0.10 m(상자 — 일부러 모서리 스윕을 쓴다)이므로 0.35 면 회귀만 잡는다. */
const SLACK_R = 0.35;
/** 윗면도 같은 취지. 나무는 줄기 반경만 쓰는 대신 높이를 실측하므로 여유가 더 필요 없다. */
const SLACK_H = 0.6;

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

  /* ── 1. noise3 의 출력 범위 ────────────────────────────────────────────── */
  console.log('noise3 range (used by build.displace — a spike here inflates every collider)');
  const range = await page.evaluate(async () => {
    const { Noise } = await import('/src/world/noise.ts');
    const n = new Noise(21);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 120000; i++) {
      const v = n.noise3(Math.random() * 60 - 30, Math.random() * 60 - 30, Math.random() * 60 - 30);
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    return [lo, hi];
  });
  ok(range[0] > -1.2 && range[1] < 1.2, 'noise3 stays inside [-1.2, 1.2]', `got [${range[0].toFixed(3)}, ${range[1].toFixed(3)}]`);

  /* ── 2. 시드별 콜라이더 vs 실측 실루엣 ─────────────────────────────────── */
  await page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');

  for (const seed of SEEDS) {
    console.log(`seed ${seed}`);
    await page.evaluate((s) => window.__game.ctx.bus.emit('game:newMission', { seed: s }), seed);
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 40000);
    await waitFor(page, () => window.__game.ctx.world.ready, 'world ready', 30000);
    await sleep(500);

    const r = await page.evaluate(() => {
      const ctx = window.__game.ctx;
      const V3 = ctx.camera.position.constructor;
      const M4 = ctx.camera.matrixWorld.constructor;
      const obs = ctx.world.getObstacles();

      // 장애물을 XZ 0.05 m 격자로 색인해 인스턴스 행렬의 이동 성분과 맞춘다 (place() 가 쓴 바로 그 x,z).
      const idx = new Map();
      for (const o of obs) {
        // 사각 콜라이더(구조물 벽 · 문 · 유리 · 선로)는 smoke-structures 가 본다 — 인스턴스 원점과 XZ 가 우연히
        // 겹치는 문짝 · 유리 메시를 벽 조각과 짝지으면 엉뚱한 비교가 된다 (2026-09-11)
        if (o.box) continue;
        const k = `${Math.round(o.position.x * 20)}_${Math.round(o.position.z * 20)}`;
        let a = idx.get(k); if (!a) { a = []; idx.set(k, a); }
        a.push(o);
      }
      const match = (x, z) => {
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const a = idx.get(`${Math.round(x * 20) + dx}_${Math.round(z * 20) + dz}`);
          if (!a) continue;
          for (const o of a) if (Math.abs(o.position.x - x) < 0.08 && Math.abs(o.position.z - z) < 0.08) return o;
        }
        return null;
      };

      const m = new M4(), v = new V3();
      const measured = new Map();
      const measure = (geo, mat, o, name) => {
        const pos = geo.getAttribute('position');
        if (!pos) return;
        let st = measured.get(o);
        if (!st) { st = { name, maxR: 0, topY: -Infinity }; measured.set(o, st); }
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mat);
          const dx = v.x - o.position.x, dz = v.z - o.position.z;
          const rr = Math.sqrt(dx * dx + dz * dz);
          if (rr > st.maxR) st.maxR = rr;
          if (v.y > st.topY) st.topY = v.y;
        }
      };
      /* 2026-09-10: 바위 · 첨탑 콜라이더는 **보이는 윤곽의 중심**에 선다 (`Props.footprintOf`) — 인스턴스 원점과
         XZ 가 몇 cm ~ 몇 m 어긋나므로 위의 0.08 m 매칭에 걸리지 않는다. 그 인스턴스는 4 m 안의 **아직 짝이 없는**
         가장 가까운 `rock` 장애물과 맺는다 (산포가 `isSpotFree` 로 바위끼리 떨어뜨려 두므로 이웃과 헷갈릴 일이 적다). */
      const claimed = new Set();
      const inHull = (o, x, z) => {
        const p = o.hull.points, m = p.length / 2;
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m, ax = p[i * 2], az = p[i * 2 + 1], dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
          if ((x - ax) * dz - (z - az) * dx > 1e-3 * Math.hypot(dx, dz)) return false;
        }
        return true;
      };
      const nearHull = (x, z) => {
        const out = [];
        ctx.world.hash.query(x, z, 0, out);
        for (const o of out) if (o.hull && (o.kind === 'crystal' || o.kind === 'debris') && !claimed.has(o) && inHull(o, x, z)) return o;
        return null;
      };
      const nearRock = (x, z) => {
        const out = [];
        ctx.world.hash.query(x, z, 4, out);
        let best = null, bestD = Infinity;
        for (const o of out) {
          if (o.kind !== 'rock' || claimed.has(o)) continue;
          const d = Math.hypot(o.position.x - x, o.position.z - z);
          if (d < bestD && d < 4) { bestD = d; best = o; }
        }
        return best;
      };
      ctx.scene.traverse((n) => {
        if (n.isInstancedMesh) {
          n.updateWorldMatrix(true, false);
          const rocky = /prop_(boulder|spire)/.test(n.name || '');
          const hully = /prop_(crystal|debris)/.test(n.name || '');
          for (let i = 0; i < n.count; i++) {
            n.getMatrixAt(i, m);
            m.premultiply(n.matrixWorld);
            let hit = match(m.elements[12], m.elements[14]);
            if (!hit && rocky) hit = nearRock(m.elements[12], m.elements[14]);
            if (!hit && hully) hit = nearHull(m.elements[12], m.elements[14]);
            if (hit && (rocky || hully)) claimed.add(hit);
            if (hit) measure(n.geometry, m, hit, n.name);
          }
        } else if (n.isMesh) {
          n.updateWorldMatrix(true, false);
          const hit = match(n.matrixWorld.elements[12], n.matrixWorld.elements[14]);
          if (hit) measure(n.geometry, n.matrixWorld, hit, n.name);
        }
      });

      let matched = 0, worstR = -Infinity, worstH = -Infinity, worstRow = null, worstHRow = null;
      for (const o of obs) {
        const st = measured.get(o);
        if (!st) continue;
        matched++;
        const sr = (o.shotRadius !== undefined && o.shotRadius > 0) ? o.shotRadius : o.radius;
        const sh = (o.shotHeight !== undefined && o.shotHeight > 0) ? o.shotHeight : o.height;
        const dR = Math.max(o.radius, sr) - st.maxR;
        const dH = sh - (st.topY - o.position.y);
        const row = { kind: o.kind, name: st.name, x: +o.position.x.toFixed(1), z: +o.position.z.toFixed(1),
          r: +Math.max(o.radius, sr).toFixed(2), drawnR: +st.maxR.toFixed(2), h: +sh.toFixed(2), dR: +dR.toFixed(2), dH: +dH.toFixed(2) };
        if (dR > worstR) { worstR = dR; worstRow = row; }
        if (dH > worstH) { worstH = dH; worstHRow = row; }
      }
      // 손으로 적어 둔 콜라이더: 그려진 기둥보다 굵으면 안 된다
      const maxPole = Math.max(0, ...obs.filter((o) => o.kind === 'pole').map((o) => o.radius));
      const maxWall = Math.max(0, ...obs.filter((o) => o.kind === 'wall').map((o) => o.radius));
      // 안테나 마스트만 6 m 를 넘는다 (벽 2.2~3.6 · 기둥 2.5~4.5 는 밑에서 따로 본다)
      const tallWall = Math.max(0, ...obs.filter((o) => o.kind === 'wall' && o.height > 6).map((o) => o.radius));
      return { total: obs.length, matched, worstR, worstRow, worstH, worstHRow, maxPole, maxWall, tallWall };
    });

    ok(r.matched > 300, `${r.matched}/${r.total} obstacles matched to a drawn instance`, JSON.stringify({ matched: r.matched }));
    ok(r.worstR <= SLACK_R, `no collider is wider than what it draws (worst +${r.worstR.toFixed(2)} m ≤ ${SLACK_R})`, JSON.stringify(r.worstRow));
    ok(r.worstH <= SLACK_H, `no shot cylinder reaches above what it draws (worst +${r.worstH.toFixed(2)} m ≤ ${SLACK_H})`, JSON.stringify(r.worstHRow));
    // 조명 기둥 · 아웃포스트 마스트: 받침(0.7)이 제일 굵고, 그 위 기둥은 가늘어야 한다
    ok(r.maxPole <= 0.75, `extraction pad poles stay at their drawn footprint (max r ${r.maxPole.toFixed(2)})`);
    ok(r.tallWall <= 0.3, `the antenna mast is as thin as it draws above its base (max r ${r.tallWall.toFixed(2)} for height > 6 m)`);
    ok(r.maxWall <= 0.75, `outpost walls / pillars stay near their drawn thickness (max r ${r.maxWall.toFixed(2)})`);

    /* 2026-09-10 — **땅 위로 보이는 바위보다 앞에서 막지 않는가.** 위 검사는 정점 전부(땅에 묻힌 적도 포함)와
       비교하므로 "메시 전체의 바운딩 박스" 콜라이더를 통과시켰다 — 그런데 행성마다 바위의 절반이 보이는 바위보다
       0.5 m 이상 앞에서 막았다(폭풍 안개 속 보이지 않는 벽). 그래서 **보이는 것**으로 잰다: 바위 콜라이더마다
       16 방위로 테두리에서 안쪽으로 내려 쏘는 레이를 걸어, 지형 위로 올라온 바위 표면을 처음 맞힌 반지름과
       콜라이더 반지름의 차이(방위 평균)를 본다. */
    const fp = await page.evaluate(async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const world = window.__game.getSystem('world');
      const meshes = [];
      world.root.traverse((o) => { if (o.isInstancedMesh && /prop_(boulder|spire)/.test(o.name || '')) meshes.push(o); });
      const rocks = world.hash.getAll().filter((o) => o.kind === 'rock' && Math.abs(o.position.x) < 300 && Math.abs(o.position.z) < 300);
      const ray = new THREE.Raycaster(); ray.far = 400;
      const from = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
      /* 2026-09-11: 콜라이더가 볼록 윤곽이면 방위마다 **윤곽까지의 거리**가 콜라이더 반지름이다 (윤곽의 무게중심에서). */
      const extent = (o, cx, cz, ux, uz) => {
        if (!o.hull) return o.radius;
        const p = o.hull.points, mm = p.length / 2;
        let best = 0;
        for (let i = 0; i < mm; i++) {
          const j = (i + 1) % mm, ax = p[i * 2] - cx, az = p[i * 2 + 1] - cz, bx = p[j * 2] - cx, bz = p[j * 2 + 1] - cz;
          const ex = bx - ax, ez = bz - az, den = ux * ez - uz * ex;
          if (Math.abs(den) < 1e-9) continue;
          const t = (ax * ez - az * ex) / den, s = (ax * uz - az * ux) / den;
          if (t > best && s >= -1e-6 && s <= 1 + 1e-6) best = t;
        }
        return best;
      };
      const margins = [], inner = [];
      let worst = null;
      for (const rk of rocks) {
        let cx = rk.position.x, cz = rk.position.z;
        if (rk.hull) { const p = rk.hull.points; cx = 0; cz = 0; for (let i = 0; i < p.length; i += 2) { cx += p[i]; cz += p[i + 1]; } cx /= p.length / 2; cz /= p.length / 2; }
        let sum = 0, sumIn = 0;
        for (let b = 0; b < 16; b++) {
          const a = (b / 16) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
          const colR = extent(rk, cx, cz, ux, uz);
          let visR = 0;
          for (let rr = colR + 0.6; rr > 0.05; rr -= 0.1) {
            const x = cx + ux * rr, z = cz + uz * rr;
            ray.set(from.set(x, rk.position.y + rk.height + 5, z), down);
            const hit = ray.intersectObjects(meshes, false)[0];
            if (hit && hit.point.y > world.getHeightAt(x, z) + 0.05) { visR = rr; break; }
          }
          sum += Math.max(0, colR - visR);
          sumIn += Math.max(0, visR - colR);
        }
        const m = sum / 16;
        margins.push(m);
        inner.push(sumIn / 16);
        if (!worst || m > worst.m) worst = { m: +m.toFixed(2), hull: !!rk.hull, h: +rk.height.toFixed(2), x: +rk.position.x.toFixed(1), z: +rk.position.z.toFixed(1) };
      }
      margins.sort((a, b) => a - b);
      inner.sort((a, b) => a - b);
      return {
        n: margins.length, hulls: rocks.filter((o) => o.hull).length,
        p90: margins[Math.floor(margins.length * 0.9)] ?? 0, over1: margins.filter((m) => m > 1).length, worst,
        innerP90: inner[Math.floor(inner.length * 0.9)] ?? 0,
      };
    });
    ok(fp.n > 50, `${fp.n} rock colliders probed against the visible rock`);
    ok(fp.hulls === fp.n, `every rock collider is a convex hull (${fp.hulls}/${fp.n})`);
    ok(fp.innerP90 <= 0.35, `rock hulls do not sit inside the visible rock either (p90 of the mean undershoot ${fp.innerP90.toFixed(2)} m ≤ 0.35)`);
    ok(fp.p90 <= 0.35, `rock colliders reach no further than the rock you can see (p90 of the mean overshoot ${fp.p90.toFixed(2)} m ≤ 0.35)`, JSON.stringify(fp.worst));
    ok(fp.over1 === 0, `no rock blocks more than 1 m in front of its visible edge on average (${fp.over1})`, JSON.stringify(fp.worst));
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
