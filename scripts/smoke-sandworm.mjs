// 땅굴벌레 이벤트 (2026-09-13 — src/enemies/sandworm/Director · models/WormModel · fx/BurrowFx, 등장 판정 개편 2026-09-15) 단독 스모크 — 릴레이 없이 싱글 플레이로 돈다.
// 검사: ⓪ 누적 확률제: 위협 배수 표(SANDWORM_BASE_CHANCE_BY_THREAT) · threat 1 = 어린 개체 · 솔로 0 % · 2명 light 40 m 낮음 · 3명 heavy 20 m 높음 ·
//       유인 가산 · 달리지 않으면 0 · 호스트가 SANDWORM_CHECK_S 마다 검사 · WorldRef.burrowGroundOk (구조물 · 패드 · 둥지 = false, 맨땅 = true)
//       ① 전조: debugSandworm → 전조 상태 · sandworm:warning · 토스트 「지상이변 발생」 · 전조 링 · 전조 중 재호출 거부
//       ② 흔들림이 약하게 시작해 강해진다 ③ SANDWORM_WARN_S 뒤 분출: sandworm:erupted · 최대 체력 2000–3000 굴림 · 플레이어 피해 + 넉백 ·
//       파고 나오는 무리 · 땅굴벌레가 솟아오른다 ④ 버그 뱉기 ⑤ 뱉기 단계가 끝나면 독극물 ⑥ 처치 → enemy:killed · 시체 · 보스급 전리품
//       ⑦ 뱉기 중에 먼저 죽이면 더 뱉지 않는다 ⑧ 리플리카: wormWarn · spawn(em) · wormErupt(hp · spit · ty) · wormSpit 포물선 → 승격해도 최대 체력 · 뱉기 이어감
//       ⑨ 탈출 디펜스 웨이브 제거 ⑩ 위협 1 어린 개체: 체력 750 · 70 % 반경 · 스캐빈저만 · 시체 표 ⑪ 진동 장치 sandworm:summon: 곧장 전조 · 두 번째는 무시.
// Usage: node scripts/smoke-sandworm.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
import { quietViteHmr } from './quiet-hmr.mjs';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

/* ── 계약 값 — csv 에서 읽는다 ── */
const csvLines = (f) => readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
const CONST = Object.fromEntries(csvLines('constants.csv').map((l) => l.split(',')).filter((c) => c.length >= 2).map((c) => [c[0], Number(c[1])]));
const table = (name) => csvLines('tables.csv').map((l) => l.split(',')).filter((c) => c[0] === name).sort((a, b) => Number(a[1]) - Number(b[1])).map((c) => Number(c[2]));
const BASE_CHANCE = table('SANDWORM_BASE_CHANCE_BY_THREAT');
const BURST = table('SANDWORM_BURST_BY_SQUAD');
const planetRows = csvLines('planets.csv');
const pHead = planetRows[0].split(',');
const PLANET_BY_THREAT = {};
for (const row of planetRows.slice(1)) { const c = row.split(','); PLANET_BY_THREAT[c[pHead.indexOf('threat')]] ??= c[pHead.indexOf('id')]; }
const WARN = CONST.SANDWORM_WARN_S, RISE = CONST.SANDWORM_RISE_S;
const HP_MIN = CONST.SANDWORM_HP_MIN, HP_MAX = CONST.SANDWORM_HP_MAX;
const SPIT_INTERVAL = CONST.SANDWORM_SPIT_INTERVAL_S, FLIGHT = CONST.SANDWORM_SPIT_FLIGHT_S;
const CHECK_S = CONST.SANDWORM_CHECK_S, GROUP_R = CONST.SANDWORM_GROUP_RADIUS;
const P_LIGHT = CONST.SANDWORM_P_PER_LIGHT, P_HEAVY = CONST.SANDWORM_P_PER_HEAVY, P_FAR = CONST.SANDWORM_P_FAR_MUL, P_LURE = CONST.SANDWORM_P_LURE, NEAR_M = CONST.SANDWORM_P_NEAR_M;
const WEAK_HP = CONST.SANDWORM_WEAK_HP, WEAK_SCALE = CONST.SANDWORM_WEAK_SCALE, ERUPT_R = CONST.SANDWORM_ERUPT_RADIUS, GROUND_R = CONST.BURROW_GROUND_CHECK_R;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.enemies, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
    const ctx = window.__game.ctx;
    window.__ev = { warning: [], erupted: [], spawned: [], shake: [], attacked: [], killed: [], wave: 0 };
    ctx.bus.on('sandworm:warning', (p) => window.__ev.warning.push({ eta: p.eta, r: p.radius }));
    ctx.bus.on('sandworm:erupted', (p) => window.__ev.erupted.push({ id: p.id, r: p.radius }));
    ctx.bus.on('enemy:spawned', ({ id, type, position }) => { const e = window.__sys.byId.get(id); window.__ev.spawned.push({ id, type, emergeDur: e ? e.emergeDur : -1, x: position.x, z: position.z }); });
    ctx.bus.on('camera:shake', ({ intensity }) => window.__ev.shake.push({ t: window.__game.ctx.time, i: intensity }));
    ctx.bus.on('enemy:attacked', ({ type, damage }) => window.__ev.attacked.push({ type, damage }));
    ctx.bus.on('enemy:killed', ({ id, type, by }) => window.__ev.killed.push({ id, type, by }));
    ctx.bus.on('enemy:waveStarted', () => { window.__ev.wave++; });
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);

  console.log('mission (seed 41)');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 41 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
  await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
  await waitSim(0.3);

  /* ── 0. 누적 확률제 ────────────────────────────────────────────────────── */
  console.log('누적 확률제 (SANDWORM_BASE_CHANCE_BY_THREAT · 자격 인원 · 거리 · 유인 · 땅 검사)');
  const plan0 = await P(() => window.__sys.debugSandwormState.plan);
  const baseThreat = plan0.threat;
  ok(near(plan0.base, BASE_CHANCE[baseThreat - 1] ?? 0), `이 미션의 위협 배수 = SANDWORM_BASE_CHANCE_BY_THREAT[threat ${baseThreat} − 1] (${plan0.base})`);
  ok(plan0.type === (baseThreat <= 1 ? 'sandworm_weak' : 'sandworm'), `종류는 행성 위협이 정한다 (threat ${baseThreat} → ${plan0.type})`);
  ok(BASE_CHANCE[0] > 0 && BASE_CHANCE[2] >= BASE_CHANCE[1] && BASE_CHANCE[1] >= BASE_CHANCE[0], `threat 1 도 0 보다 크고 위협이 높을수록 크다 (${BASE_CHANCE.join(' · ')})`);
  const perThreat = await P((ids) => {
    const sys = window.__sys; const out = {};
    for (const [threat, id] of Object.entries(ids)) { sys.sandworm.onWorldReady(id, null, false); out[threat] = { ...sys.debugSandwormState.plan }; }
    return out;
  }, PLANET_BY_THREAT);
  for (const t of ['1', '2', '3']) {
    const r = perThreat[t];
    if (!r) { ok(false, `threat ${t} 행성이 planets.csv 에 있다`); continue; }
    ok(r.threat === Number(t) && near(r.base, BASE_CHANCE[Number(t) - 1]) && r.type === (t === '1' ? 'sandworm_weak' : 'sandworm'), `threat ${t} → 배수 ${BASE_CHANCE[Number(t) - 1]} · ${r.type} (${r.base} · ${r.type})`);
  }
  // 검사 한 번의 확률 — 순수 계산 (threat 3 기준)
  const chance = await P(() => {
    const sys = window.__sys; const L = 'light', H = 'heavy';
    const m = (x, z, ws, sprint = true) => ({ x, z, ws, sprint });
    return {
      solo: sys.debugSandwormChance([m(0, 0, H)], false, 3).p,
      soloLure: sys.debugSandwormChance([m(0, 0, H)], true, 3).p,
      twoLightFar: sys.debugSandwormChance([m(0, 0, L), m(40, 0, L)], false, 3),
      twoLightNear: sys.debugSandwormChance([m(0, 0, L), m(10, 0, L)], false, 3).p,
      twoNormal: sys.debugSandwormChance([m(0, 0, 'normal'), m(10, 0, 'normal')], false, 3).p,
      twoLightOneWalking: sys.debugSandwormChance([m(0, 0, L), m(10, 0, L, false)], false, 3).p,
      threeHeavyNear: sys.debugSandwormChance([m(0, 0, H), m(12, 0, H), m(6, 10, H)], false, 3),
      threeHeavyNearT1: sys.debugSandwormChance([m(0, 0, H), m(12, 0, H), m(6, 10, H)], false, 1).p,
      fourHeavyNear: sys.debugSandwormChance([m(0, 0, H), m(12, 0, H), m(6, 10, H), m(6, -10, 'over')], false, 3).p,
      twoLightFarLure: sys.debugSandwormChance([m(0, 0, L), m(40, 0, L)], true, 3).p,
      apart: sys.debugSandwormChance([m(0, 0, H), m(80, 0, H)], false, 3).p,
    };
  });
  const twoLightFarExpected = BASE_CHANCE[2] * 2 * P_LIGHT * P_FAR;
  const threeHeavyExpected = BASE_CHANCE[2] * Math.min(1, 3 * P_HEAVY);
  ok(chance.solo === 0 && chance.soloLure === 0, '혼자(안드로이드 없는 솔로)는 유인이 있어도 0 %');
  ok(chance.twoNormal === 0 && chance.twoLightOneWalking === 0, '무게 normal 이거나 달리지 않으면 자격이 없다 (0 %)');
  ok(chance.apart === 0, `SANDWORM_GROUP_RADIUS(${GROUP_R} m) 밖은 무리가 아니다 (0 %)`);
  ok(chance.twoLightFar.n === 2 && near(chance.twoLightFar.spread, 40) && near(chance.twoLightFar.closeMul, P_FAR) && near(chance.twoLightFar.p, twoLightFarExpected),
    `2명 light · 40 m = 낮은 확률 ${twoLightFarExpected.toFixed(3)}/검사 (${chance.twoLightFar.p.toFixed(3)}, 거리 계수 ${chance.twoLightFar.closeMul})`);
  ok(chance.twoLightNear > chance.twoLightFar.p, `가까울수록 높다 (10 m ${chance.twoLightNear.toFixed(3)} > 40 m ${chance.twoLightFar.p.toFixed(3)})`);
  ok(chance.threeHeavyNear.n === 3 && chance.threeHeavyNear.spread <= NEAR_M && near(chance.threeHeavyNear.p, threeHeavyExpected) && threeHeavyExpected >= 0.7,
    `3명 heavy · 20 m 안 = ${threeHeavyExpected}/검사 → 몇 번 안에 거의 확실 (${chance.threeHeavyNear.p.toFixed(3)})`);
  ok(chance.fourHeavyNear >= chance.threeHeavyNear.p && chance.threeHeavyNearT1 < chance.threeHeavyNear.p, `인원이 많을수록 · 위협이 높을수록 높다 (4명 ${chance.fourHeavyNear} ≥ 3명 ${chance.threeHeavyNear.p} > threat 1 ${chance.threeHeavyNearT1})`);
  ok(near(chance.twoLightFarLure, Math.min(1, twoLightFarExpected + P_LURE)), `유인 수류탄 +${P_LURE} (${chance.twoLightFarLure.toFixed(3)})`);
  // 호스트가 CHECK_S 마다 실제로 검사한다 — 솔로라 p 0, 검사 횟수는 는다
  await P((id) => { window.__sys.sandworm.onWorldReady(id, null, false); }, PLANET_BY_THREAT['3']);
  await waitSim(CHECK_S * 2.5);
  const live = await P(() => window.__sys.debugSandwormState);
  ok(live.plan.checks >= 2 && !!live.plan.last && live.plan.last.candidates === 1 && live.plan.last.p === 0 && !live.done && !live.warning,
    `호스트가 ${CHECK_S} s 마다 검사한다 — 솔로: 후보 1 · p 0 · 전조 없음 (checks ${live.plan.checks})`);
  // 땅 검사
  const ground = await P((r) => {
    const w = window.__game.ctx.world; const pp = window.__game.ctx.player.position;
    const s = w.getStructures()[0]; const pad = w.getExtractionPoints()[0]; const nest = w.getNestPositions()[0];
    let free = 0, tried = 0, firstFree = null;
    for (let dx = -120; dx <= 120 && free < 3; dx += 6) for (let dz = -120; dz <= 120 && free < 3; dz += 6) {
      tried++;
      if (w.burrowGroundOk(pp.x + dx, pp.z + dz, r)) { free++; firstFree ??= [pp.x + dx, pp.z + dz]; }
    }
    const slope = firstFree ? w.getObstaclesNear(firstFree[0], firstFree[1], r).filter((o) => Math.hypot(o.position.x - firstFree[0], o.position.z - firstFree[1]) < o.radius + r).length : -1;
    return {
      structure: s ? w.burrowGroundOk(s.position.x, s.position.z, r) : null,
      pad: pad ? w.burrowGroundOk(pad.position.x, pad.position.z, r) : null,
      nest: nest ? w.burrowGroundOk(nest.x, nest.z, r) : null,
      outside: w.burrowGroundOk(1e5, 1e5, r),
      free, tried, obstaclesAtFree: slope,
    };
  }, GROUND_R);
  ok(ground.structure === false && ground.outside === false, `burrowGroundOk: 구조물 안 · 맵 밖 = false (${ground.structure}, ${ground.outside})`);
  ok(ground.pad !== true && ground.nest !== true, `burrowGroundOk: 탈출 패드 · 둥지 = false (${ground.pad}, ${ground.nest})`);
  ok(ground.free >= 1 && ground.obstaclesAtFree === 0, `burrowGroundOk: 강하 지점 240 m 안에 맨땅이 있고 그 원에는 콜라이더가 없다 (${ground.free}/${ground.tried}, 콜라이더 ${ground.obstaclesAtFree})`);

  // 이벤트를 재는 스모크다 — 플레이어가 버티게 계속 치료한다 (피해는 enemy:attacked 로 센다)
  await P(() => { window.__heal = setInterval(() => { const p = window.__game.ctx.player; if (p && !p.isDead) p.heal(100); }, 200); });

  /* ── 1. 전조 (성체 — threat 3 으로 둔 채) ──────────────────────────────── */
  console.log('전조 (debugSandworm)');
  const f = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    for (const e of sys.active) if (e.active && e.state !== 'dead') e.kill(false);   // 첫 배치가 끼어들지 않게
    window.__spot = [pp.x, pp.z];
    const started = sys.debugSandworm({ spitS: 5 });
    const again = sys.debugSandworm({});
    return { started, again, st: sys.debugSandwormState, ring: sys.burrowFx.ringVisible, time: ctx.time };
  });
  ok(f.started === true, 'debugSandworm 이 전조를 시작한다');
  ok(f.again === false, '전조 중 재호출은 거부된다');
  ok(!!f.st.warning && Math.abs(f.st.warning.eta - WARN) < 0.2 && f.st.done, `전조 eta = SANDWORM_WARN_S(${WARN}s) · 레이드당 1회 표식 (${f.st.warning && f.st.warning.eta.toFixed(2)})`);
  ok(!!f.st.warning && f.st.warning.type === 'sandworm' && near(f.st.warning.r, ERUPT_R), `threat 3 = 성체 · 전조 반경 ${ERUPT_R} (${f.st.warning && f.st.warning.r})`);
  ok(f.ring, '피해 반경 링이 보인다');
  ok((await P(() => window.__ev.warning.length)) === 1, 'sandworm:warning 한 번');
  let toast = false;
  try { toast = await waitFor(page, () => [...document.querySelectorAll('.notif')].some((n) => /지상이변 발생/.test(n.textContent || '')), '토스트', 6000); } catch { toast = false; }
  ok(toast, '우측 토스트 「지상이변 발생」');

  /* ── 2. 흔들림 ─────────────────────────────────────────────────────────── */
  await waitSim(WARN - 0.4);
  const ramp = await P((t0) => window.__ev.shake.filter((s) => s.t >= t0).map((s) => s.i), f.time);
  const head = ramp.slice(0, 5), tail = ramp.slice(-5);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  ok(ramp.length >= 12 && mean(tail) > mean(head) * 2, `흔들림이 약하게 시작해 강해진다 (${ramp.length}회, 처음 ${mean(head).toFixed(3)} → 끝 ${mean(tail).toFixed(3)})`);

  /* ── 3. 분출 ───────────────────────────────────────────────────────────── */
  console.log('분출');
  await waitSim(0.7);
  const s3 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const st = sys.debugSandwormState;
    const sp = window.__spot; const pp = ctx.player.position;
    const burst = window.__ev.spawned.filter((s) => s.type !== 'sandworm' && s.emergeDur > 0).length;
    return {
      erupted: window.__ev.erupted.length, worms: st.worms, warning: st.warning, ring: sys.burrowFx.ringVisible,
      attacked: window.__ev.attacked.filter((a) => a.type === 'sandworm').length,
      displaced: Math.hypot(pp.x - sp[0], pp.z - sp[1]), burst,
      wormSpawn: window.__ev.spawned.filter((s) => s.type === 'sandworm').map((s) => s.emergeDur),
    };
  });
  const worm = s3.worms[0];
  ok(s3.erupted === 1 && !s3.warning && !s3.ring, `sandworm:erupted 한 번 · 전조가 끝났다 (${s3.erupted})`);
  ok(!!worm && worm.type === 'sandworm' && worm.maxHp >= HP_MIN && worm.maxHp <= HP_MAX && worm.hp === worm.maxHp, `성체 최대 체력 ${HP_MIN}–${HP_MAX} 에서 굴렸다 (${worm && worm.maxHp})`);
  ok(!!worm && worm.emerging && s3.wormSpawn.length === 1 && Math.abs(s3.wormSpawn[0] - RISE) < 1e-6, `땅굴벌레가 SANDWORM_RISE_S(${RISE}s) 동안 솟아오른다`);
  ok(s3.attacked >= 1, `발밑의 플레이어가 분출 피해를 받는다 (enemy:attacked ×${s3.attacked})`);
  ok(s3.displaced > 1, `넉백으로 밀려났다 (${s3.displaced.toFixed(2)} m)`);
  ok(s3.burst >= Math.min(2, BURST[0]), `분출 무리가 파고 나온다 (${s3.burst} / 표 ${BURST[0]})`);

  /* ── 4. 뱉기 ───────────────────────────────────────────────────────────── */
  console.log('버그 뱉기');
  await P(() => {
    // 착지한 벌레는 치운다 (플레이어를 지키고 생존 상한을 비운다) — 날아가는 몸 · 파고 나오는 몸은 남긴다
    window.__cull = setInterval(() => {
      for (const e of window.__sys.active) if (e.active && e.state !== 'dead' && e.type !== 'sandworm' && e.type !== 'sandworm_weak' && e.spatT === 0 && e.emergeT === 0) e.kill(false);
    }, 400);
    window.__sp0 = window.__ev.spawned.length;
  });
  await waitSim(RISE + 1.8);
  const s4 = await P(() => {
    const st = window.__sys.debugSandwormState;
    return { spit: st.spitVolleys, emerging: st.worms[0] ? st.worms[0].emerging : null, spawned: window.__ev.spawned.slice(window.__sp0).filter((s) => s.type !== 'sandworm' && s.emergeDur === 0).length };
  });
  ok(s4.emerging === false, '다 솟아올랐다');
  ok(s4.spit >= 1 && s4.spawned >= 1, `입에서 버그를 뱉는다 (volleys ${s4.spit}, 뱉어진 ${s4.spawned})`);

  /* ── 5. 독극물 ─────────────────────────────────────────────────────────── */
  console.log('독극물 단계');
  let acid = 0;
  for (let k = 0; k < 20 && acid === 0; k++) { await waitSim(0.5); acid = await P(() => window.__sys.debugSandwormState.acidVolleys); }
  ok(acid >= 1, `뱉기 단계(5 s)가 끝나면 땅에 박힌 채 독극물을 뱉는다 (volleys ${acid})`);
  const rooted = await P(() => { const e = window.__sys.byId.get(window.__sys.debugSandwormState.worms[0].id); return { moved: Math.hypot(e.position.x - window.__spot[0], e.position.z - window.__spot[1]), state: e.state }; });
  ok(rooted.moved < 0.5, `움직이지 않는다 (${rooted.moved.toFixed(2)} m, ${rooted.state})`);

  /* ── 6. 처치 ───────────────────────────────────────────────────────────── */
  console.log('처치 · 시체');
  const s6 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const id = sys.debugSandwormState.worms[0].id;
    const e = sys.byId.get(id);
    e.takeDamage(1e6, undefined, undefined, 'local');
    const corpse = sys.corpses.get(id);
    const rolled = ctx.loot.rollCorpse('sandworm');
    const loot = rolled.map((i) => i.defId);
    // 2026-09-16: 표본은 3 계열 × 6 등급이므로 id 대신 **등급**을 본다 (`data/loot_corpses.csv` 가 적을 등급별로 나눴다)
    const specs = rolled.filter((i) => !!ctx.loot.getItemDef(i.defId)?.sample).map((i) => ({ id: i.defId, rarity: ctx.loot.getItemDef(i.defId).rarity }));
    return { dead: e.state === 'dead', killed: window.__ev.killed.filter((k) => k.id === id), corpse: !!corpse, loot, specs, name: ctx.enemies.enemyDisplayName('sandworm') };
  });
  ok(s6.dead && s6.killed.length === 1 && s6.killed[0].by === 'local', 'enemy:killed (by local) — 킬 · 계약은 기존 경로');
  ok(s6.corpse, '늘 수색되는 시체가 남는다 (CORPSE_LOOT_CHANCE 1)');
  /* 2026-09-16 (사용자 결정, 표본 전면 개편): 옛 `spec_cell` 은 사라지고 성체 땅굴벌레는 **희귀(III) 표본**을 떨군다 —
     `spec_cell_3` 은 chance 1 로 확정이고 광물 · 유전자도 같은 등급이다. id 목록 대신 「등급이 맞는가」를 본다. */
  ok(s6.loot.includes('mat_bio_sample') && s6.specs.some((s) => s.id === 'spec_cell_3') && s6.specs.length > 0 && s6.specs.every((s) => s.rarity === 'rare'),
    `보스급 전리품: 생체 조직 + 희귀(III) 표본만 (${s6.loot.join(', ')})`);
  ok(s6.name === '땅굴벌레', `표시 이름 「땅굴벌레」 (${s6.name})`);

  /* ── 7. 먼저 죽이면 더 뱉지 않는다 ─────────────────────────────────────── */
  console.log('뱉기 중 처치');
  await P(() => window.__game.ctx.player.heal(200));
  const s7a = await P(() => window.__sys.debugSandworm({ spitS: 30 }));
  ok(s7a === true, '두 번째 강제 전조 (콘솔 · 스모크는 레이드당 1회를 무시한다)');
  await waitSim(WARN + RISE + 0.4);
  const s7 = await P(() => {
    const sys = window.__sys; const st = sys.debugSandwormState;
    const w = st.worms[0];
    if (w) sys.byId.get(w.id).takeDamage(1e6, undefined, undefined, 'local');
    return { had: !!w, spitLeft: w ? w.spitLeft : 0, volleys: sys.debugSandwormState.spitVolleys };
  });
  ok(s7.had && s7.spitLeft > 20, `뱉기 단계 한가운데에서 죽였다 (남은 ${s7.spitLeft.toFixed(1)}s)`);
  await waitSim(SPIT_INTERVAL * 1.6 + FLIGHT);
  const s7b = await P(() => window.__sys.debugSandwormState.spitVolleys);
  ok(s7b === s7.volleys, `죽은 뒤로는 뱉지 않는다 (${s7.volleys} → ${s7b})`);
  await P(() => { for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 10. 위협 1 어린 개체 ──────────────────────────────────────────────── */
  console.log('위협 1 어린 개체 (sandworm_weak)');
  await P(() => window.__game.ctx.player.heal(200));
  const w0 = await P((id) => {
    const sys = window.__sys; sys.sandworm.onWorldReady(id, null, false);
    const plan = { ...sys.debugSandwormState.plan };
    window.__wsp0 = window.__ev.spawned.length; window.__we0 = window.__ev.erupted.length;
    const started = sys.debugSandworm({ spitS: 6 });
    const st = sys.debugSandwormState;
    return { plan, started, warning: st.warning };
  }, PLANET_BY_THREAT['1']);
  ok(w0.plan.type === 'sandworm_weak' && w0.plan.base > 0, `threat 1 행성 = 어린 개체 · 배수 ${w0.plan.base} > 0`);
  ok(w0.started && !!w0.warning && w0.warning.type === 'sandworm_weak' && near(w0.warning.r, ERUPT_R * WEAK_SCALE, 1e-3), `전조 반경 = ${ERUPT_R} × ${WEAK_SCALE} (${w0.warning && w0.warning.r})`);
  await waitSim(WARN + 0.7);
  const w1 = await P(() => {
    const sys = window.__sys; const st = sys.debugSandwormState; const w = st.worms[0];
    const e = w ? sys.byId.get(w.id) : null;
    const adult = sys.constructor ? null : null; void adult;
    return {
      worm: w, erupted: window.__ev.erupted.slice(window.__we0),
      radius: e ? e.stats.radius : -1, height: e ? e.stats.height : -1, rigName: e ? e.rig.root.name : '', rigKind: e ? e.rig.kind : '',
      name: window.__game.ctx.enemies.enemyDisplayName('sandworm_weak'),
    };
  });
  ok(!!w1.worm && w1.worm.type === 'sandworm_weak' && w1.worm.maxHp === WEAK_HP && w1.worm.hp === WEAK_HP, `어린 개체 최대 체력 ${WEAK_HP} 고정 (${w1.worm && w1.worm.maxHp})`);
  ok(w1.erupted.length === 1 && near(w1.erupted[0].r, ERUPT_R * WEAK_SCALE, 1e-3), `분출 반경 ${(ERUPT_R * WEAK_SCALE).toFixed(2)} (${w1.erupted[0] && w1.erupted[0].r})`);
  ok(w1.rigKind === 'worm' && w1.rigName === 'worm_sandworm_weak' && near(w1.radius, 2.2 * WEAK_SCALE, 1e-3) && near(w1.height, 10 * WEAK_SCALE, 1e-3), `자기 리그 · 반지름 · 높이 ${WEAK_SCALE} 배 (${w1.rigName}, r ${w1.radius}, h ${w1.height})`);
  ok(w1.name === '어린 땅굴벌레', `표시 이름 「어린 땅굴벌레」 (${w1.name})`);
  await waitSim(RISE + SPIT_INTERVAL + 1.5);
  const w2 = await P(() => {
    const sys = window.__sys; const st = sys.debugSandwormState;
    const w = st.worms[0];
    const wp = w ? sys.byId.get(w.id).position : window.__game.ctx.player.position;
    // 분출 무리(링 6–14 m) · 뱉어진 몸(입에서) 만 — 멀리서 파고 나오는 상시 순찰은 세지 않는다
    const spawned = window.__ev.spawned.slice(window.__wsp0).filter((s) => s.type !== 'sandworm_weak' && Math.hypot(s.x - wp.x, s.z - wp.z) <= 20);
    const lt = window.__game.ctx.loot;
    const rolled = lt.rollCorpse('sandworm_weak');
    const loot = rolled.map((i) => i.defId);
    const specs = rolled.filter((i) => !!lt.getItemDef(i.defId)?.sample).map((i) => ({ id: i.defId, rarity: lt.getItemDef(i.defId).rarity }));
    if (w) sys.byId.get(w.id).takeDamage(1e6, undefined, undefined, 'local');
    return { spawned: spawned.length, types: [...new Set(spawned.map((s) => s.type))], spit: st.spitVolleys, loot, specs, corpse: w ? !!sys.corpses.get(w.id) : false };
  });
  ok(w2.spawned >= 2 && w2.types.length === 1 && w2.types[0] === 'scavenger', `어린 개체는 분출 무리 · 뱉기 모두 스캐빈저만 (${w2.spawned} 마리: ${w2.types.join(', ')})`);
  // 어린 개체는 한 등급 아래다 — 고급(II) 표본, `spec_cell_2` 는 chance 1 로 확정 (`data/loot_corpses.csv`)
  ok(w2.corpse && w2.loot.includes('mat_bio_sample') && w2.specs.some((s) => s.id === 'spec_cell_2') && w2.specs.length > 0 && w2.specs.every((s) => s.rarity === 'uncommon'),
    `시체 표 sandworm_weak: 생체 조직 + 고급(II) 표본만 (${w2.loot.join(', ')})`);
  await P(() => { clearInterval(window.__cull); for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 11. 진동 장치 sandworm:summon ─────────────────────────────────────── */
  console.log('진동 장치 (sandworm:summon)');
  await P(() => window.__game.ctx.player.heal(200));
  const su = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    const before = sys.debugSandwormState;
    const ignoredWhileDone = (() => { ctx.bus.emit('sandworm:summon', { position: new window.__V(pp.x + 6, pp.y, pp.z), source: 'thumper' }); return sys.debugSandwormState.warnings === before.warnings; })();
    sys.debugSandwormClearOnce();
    const cleared = !sys.debugSandwormState.done;
    ctx.bus.emit('sandworm:summon', { position: new window.__V(pp.x + 6, pp.y, pp.z), source: 'thumper' });
    const st = sys.debugSandwormState;
    ctx.bus.emit('sandworm:summon', { position: new window.__V(pp.x - 6, pp.y, pp.z), source: 'thumper' });
    const st2 = sys.debugSandwormState;
    return { ignoredWhileDone, cleared, warnings: st.warnings - before.warnings, summoned: st.summoned, warning: st.warning, second: st2.warnings - st.warnings, sameSpot: !!st2.warning && Math.abs(st2.warning.x - (pp.x + 6)) < 0.5 };
  });
  ok(su.ignoredWhileDone, '이미 있었던 레이드에서는 부름을 무시한다');
  ok(su.cleared && su.warnings === 1 && su.summoned && !!su.warning && Math.abs(su.warning.eta - WARN) < 0.2, `없었으면 확률 없이 곧장 전조 (eta ${su.warning && su.warning.eta.toFixed(2)})`);
  ok(su.second === 0 && su.sameSpot, '두 번째 부름은 무시된다 (전조 자리 그대로)');
  await waitSim(WARN + 0.7);
  const su2 = await P(() => ({ erupted: window.__ev.erupted.length, worms: window.__sys.debugSandwormState.worms.length }));
  ok(su2.worms === 1, `부른 자리에서 분출했다 (erupted ${su2.erupted})`);
  await P(() => { for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 8. 리플리카 → 승격 ────────────────────────────────────────────────── */
  console.log('리플리카 → 승격');
  const s8 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const pp = ctx.player.position;
    sys.setAuthority(false);
    const x = pp.x + 18, z = pp.z + 4; const y = ctx.world.getHeightAt(x, z);
    const w0 = window.__ev.warning.length, e0 = window.__ev.erupted.length;
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormWarn', p: [x, y, z], eta: 2, r: 12 });
    const warn = sys.debugSandwormState.warning;
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 950001, ty: 'sandworm', p: [x, y, z], yaw: 0, em: 1.4 });
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormErupt', id: 950001, p: [x, y, z], r: 12, hp: 2345, spit: 12, ty: 'sandworm' });
    const worm = sys.byId.get(950001);
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 950002, ty: 'scavenger', p: [x, y + 9, z], yaw: 0 });
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormSpit', id: 950001, from: [x, y + 9, z], b: [[950002, x + 8, ctx.world.getHeightAt(x + 8, z), z]], T: 1.1 });
    const bug = sys.byId.get(950002);
    // 어린 개체도 리플리카가 자기 리그로 세운다 (ee spawn.ty) — 늦은 합류 sync 도 같은 경로
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 950003, ty: 'sandworm_weak', p: [x + 30, ctx.world.getHeightAt(x + 30, z), z], yaw: 0, em: 1.4 });
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormErupt', id: 950003, p: [x + 30, ctx.world.getHeightAt(x + 30, z), z], r: 8.4, hp: 750, spit: 5, sy: 1, ty: 'sandworm_weak' });
    const weak = sys.byId.get(950003);
    return {
      warned: window.__ev.warning.length - w0, warnEta: warn ? warn.eta : -1, erupted: window.__ev.erupted.length - e0,
      maxHp: worm ? worm.maxHp : -1, spitLeft: worm ? worm.wormSpitUntil - ctx.time : -1, emerging: worm ? worm.emergeT > 0 : false,
      bugSpat: bug ? bug.spatT : -1, time: ctx.time,
      weak: weak ? { type: weak.type, maxHp: weak.maxHp, rig: weak.rig.root.name, r: weak.stats.radius } : null,
    };
  });
  ok(s8.warned === 1 && Math.abs(s8.warnEta - 2) < 0.1, `리플리카 wormWarn → 전조 (eta ${s8.warnEta})`);
  ok(s8.erupted === 1 && s8.maxHp === 2345 && Math.abs(s8.spitLeft - 12) < 0.2 && s8.emerging, `리플리카 wormErupt → 최대 체력 · 뱉기 시간 · 솟아오름 (${s8.maxHp}, ${s8.spitLeft.toFixed(2)})`);
  ok(s8.bugSpat > 1, `리플리카 wormSpit → 뱉어진 몸이 스스로 포물선을 그린다 (spatT ${s8.bugSpat})`);
  ok(!!s8.weak && s8.weak.type === 'sandworm_weak' && s8.weak.maxHp === 750 && s8.weak.rig === 'worm_sandworm_weak' && near(s8.weak.r, 2.2 * WEAK_SCALE, 1e-3), `리플리카 어린 개체: ee spawn.ty 로 자기 리그 · wormErupt(sy) 로 체력 750 (${JSON.stringify(s8.weak)})`);
  await waitSim(1.5);
  const s8b = await P(() => { const b = window.__sys.byId.get(950002); return b ? { t: b.spatT, air: b.airborne } : null; });
  ok(!!s8b && s8b.t === 0 && !s8b.air, '리플리카의 뱉어진 몸이 착지했다');
  const s8c = await P(() => {
    const sys = window.__sys; const v0 = sys.debugSandwormState.spitVolleys;
    const weak = sys.byId.get(950003); if (weak) weak.kill(false);
    sys.setAuthority(true);
    const w = sys.byId.get(950001);
    window.__v0 = v0;
    return { maxHp: w ? w.maxHp : -1, hp: w ? w.hp : -1, spitLeft: w ? w.wormSpitUntil - window.__game.ctx.time : -1, done: sys.debugSandwormState.done };
  });
  ok(s8c.maxHp === 2345 && s8c.hp <= 2345 && s8c.spitLeft > 8, `승격해도 최대 체력 · 뱉기 시간이 이어진다 (${s8c.maxHp}, ${s8c.spitLeft.toFixed(1)}s)`);
  ok(s8c.done === true, '승격한 호스트는 「이미 있었다」 표식을 물려받아 두 마리째를 내지 않는다');
  await waitSim(SPIT_INTERVAL + 1.5);
  const s8d = await P(() => window.__sys.debugSandwormState.spitVolleys - window.__v0);
  ok(s8d >= 1, `새 호스트가 이어서 뱉는다 (+${s8d})`);
  await P(() => { for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

  /* ── 9. 탈출 디펜스 웨이브 제거 ────────────────────────────────────────── */
  console.log('탈출 디펜스 웨이브 제거');
  await P(() => { const ctx = window.__game.ctx; window.__wave0 = window.__ev.wave; ctx.bus.emit('extraction:activated', { pointId: 'smoke', position: ctx.player.position.clone(), duration: 60 }); });
  await waitSim(4.5);
  const s9 = await P(() => ({ active: window.__sys.waves.active, waves: window.__ev.wave - window.__wave0 }));
  ok(!s9.active && s9.waves === 0, `extraction:activated 가 웨이브를 부르지 않는다 (${JSON.stringify(s9)})`);
  await P(() => { const sys = window.__sys; sys.setAuthority(false); sys.setAuthority(true); });
  await waitSim(4.5);
  const s9b = await P(() => ({ active: window.__sys.waves.active, waves: window.__ev.wave - window.__wave0 }));
  ok(!s9b.active && s9b.waves === 0, `호스트 재승격도 웨이브를 켜지 않는다 (${JSON.stringify(s9b)})`);

  await P(() => { clearInterval(window.__heal); window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'back to hub', 20000);
  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
