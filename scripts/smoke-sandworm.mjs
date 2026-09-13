// 지하벌레 이벤트 (2026-09-13 — src/enemies/sandworm/Director · models/WormModel · fx/BurrowFx) 단독 스모크 — 릴레이 없이 싱글 플레이로 돈다.
// 검사: ⓪ 굴림 = 행성 threat 표(SANDWORM_CHANCE_BY_THREAT) · 발동 시각이 창 앞쪽 절반 · 같은 시드 = 같은 굴림 · 행성 없음 = 없음
//       ① 전조: debugSandworm → 전조 상태 · sandworm:warning · 토스트 「지상이변 발생」 · 전조 링 · 전조 중 재호출 거부
//       ② 흔들림이 약하게 시작해 강해진다 ③ SANDWORM_WARN_S 뒤 분출: sandworm:erupted · 최대 체력 2000–3000 굴림 · 플레이어 피해 + 넉백 ·
//       파고 나오는 무리 · 지하벌레가 솟아오른다 ④ 버그 뱉기 ⑤ 뱉기 단계가 끝나면 독극물 ⑥ 처치 → enemy:killed · 시체 · 보스급 전리품
//       ⑦ 뱉기 중에 먼저 죽이면 더 뱉지 않는다 ⑧ 리플리카: wormWarn · spawn(em) · wormErupt(hp · spit) · wormSpit 포물선 → 승격해도 최대 체력 · 뱉기 이어감
//       ⑨ 탈출 디펜스 웨이브 제거: extraction:activated · 호스트 재승격이 웨이브를 켜지 않는다.
// Usage: node scripts/smoke-sandworm.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
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
const CHANCE = table('SANDWORM_CHANCE_BY_THREAT');
const BURST = table('SANDWORM_BURST_BY_SQUAD');
const planetRows = csvLines('planets.csv');
const pHead = planetRows[0].split(',');
const PLANET_BY_THREAT = {};
for (const row of planetRows.slice(1)) { const c = row.split(','); PLANET_BY_THREAT[c[pHead.indexOf('threat')]] ??= c[pHead.indexOf('id')]; }
const WARN = CONST.SANDWORM_WARN_S, RISE = CONST.SANDWORM_RISE_S;
const START = CONST.SANDWORM_WINDOW_START_S, END = CONST.SANDWORM_WINDOW_END_S;
const HP_MIN = CONST.SANDWORM_HP_MIN, HP_MAX = CONST.SANDWORM_HP_MAX;
const SPIT_INTERVAL = CONST.SANDWORM_SPIT_INTERVAL_S, FLIGHT = CONST.SANDWORM_SPIT_FLIGHT_S;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
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
    ctx.bus.on('enemy:spawned', ({ id, type }) => { const e = window.__sys.byId.get(id); window.__ev.spawned.push({ id, type, emergeDur: e ? e.emergeDur : -1 }); });
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

  /* ── 0. 굴림 ───────────────────────────────────────────────────────────── */
  console.log('굴림');
  const plan0 = await P(() => window.__sys.debugSandwormState.plan);
  const rolls = await P((ids) => {
    const sys = window.__sys; const out = {};
    for (const [threat, id] of Object.entries(ids)) {
      sys.sandworm.onWorldReady(id, null, false);
      const a = sys.debugSandwormState.plan;
      sys.sandworm.onWorldReady(id, null, false);
      const b = sys.debugSandwormState.plan;
      out[threat] = { a, same: a.roll === b.roll && a.triggerAt === b.triggerAt };
    }
    sys.sandworm.onWorldReady(window.__game.ctx.missionPlanet ?? null, null, false);
    return out;
  }, PLANET_BY_THREAT);
  const baseThreat = plan0.threat;
  ok(Math.abs(plan0.chance - (CHANCE[baseThreat - 1] ?? 0)) < 1e-9, `이 미션의 확률 = SANDWORM_CHANCE_BY_THREAT[threat ${baseThreat} − 1] (${plan0.chance})`);
  for (const t of ['1', '2', '3']) {
    const r = rolls[t];
    if (!r) { ok(false, `threat ${t} 행성이 planets.csv 에 있다`); continue; }
    ok(r.a.threat === Number(t) && Math.abs(r.a.chance - CHANCE[Number(t) - 1]) < 1e-9, `threat ${t} → 확률 ${CHANCE[Number(t) - 1]} (${r.a.chance})`);
    ok(r.same && r.a.triggerAt >= START && r.a.triggerAt <= START + (END - START) * 0.5 + 1e-6, `같은 시드 = 같은 굴림 · 발동 시각이 창 앞쪽 절반 (${r.a.triggerAt.toFixed(1)}s)`);
    if (t === '1') ok(!r.a.rolled, 'threat 1 에는 지하벌레가 없다');
  }
  ok(CHANCE[2] > CHANCE[1] && CHANCE[1] > 0, `threat 2 는 낮고 threat 3 은 높다 (${CHANCE[1]} < ${CHANCE[2]})`);

  // 이벤트를 재는 스모크다 — 플레이어가 버티게 계속 치료한다 (피해는 enemy:attacked 로 센다)
  await P(() => { window.__heal = setInterval(() => { const p = window.__game.ctx.player; if (p && !p.isDead) p.heal(100); }, 200); });

  /* ── 1. 전조 ───────────────────────────────────────────────────────────── */
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
  ok(!!worm && worm.maxHp >= HP_MIN && worm.maxHp <= HP_MAX && worm.hp === worm.maxHp, `최대 체력 ${HP_MIN}–${HP_MAX} 에서 굴렸다 (${worm && worm.maxHp})`);
  ok(!!worm && worm.emerging && s3.wormSpawn.length === 1 && Math.abs(s3.wormSpawn[0] - RISE) < 1e-6, `지하벌레가 SANDWORM_RISE_S(${RISE}s) 동안 솟아오른다`);
  ok(s3.attacked >= 1, `발밑의 플레이어가 분출 피해를 받는다 (enemy:attacked ×${s3.attacked})`);
  ok(s3.displaced > 1, `넉백으로 밀려났다 (${s3.displaced.toFixed(2)} m)`);
  ok(s3.burst >= Math.min(2, BURST[0]), `분출 무리가 파고 나온다 (${s3.burst} / 표 ${BURST[0]})`);

  /* ── 4. 뱉기 ───────────────────────────────────────────────────────────── */
  console.log('버그 뱉기');
  await P(() => {
    // 착지한 벌레는 치운다 (플레이어를 지키고 생존 상한을 비운다) — 날아가는 몸 · 파고 나오는 몸은 남긴다
    window.__cull = setInterval(() => {
      for (const e of window.__sys.active) if (e.active && e.state !== 'dead' && e.type !== 'sandworm' && e.spatT === 0 && e.emergeT === 0) e.kill(false);
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
    const loot = ctx.loot.rollCorpse('sandworm').map((i) => i.defId);
    return { dead: e.state === 'dead', killed: window.__ev.killed.filter((k) => k.id === id), corpse: !!corpse, loot };
  });
  ok(s6.dead && s6.killed.length === 1 && s6.killed[0].by === 'local', 'enemy:killed (by local) — 킬 · 계약은 기존 경로');
  ok(s6.corpse, '늘 수색되는 시체가 남는다 (CORPSE_LOOT_CHANCE 1)');
  ok(s6.loot.includes('spec_cell') && s6.loot.includes('mat_bio_sample'), `보스급 전리품에 미확인 세포 · 생체 조직 (${s6.loot.join(', ')})`);

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
  await P(() => { clearInterval(window.__cull); for (const e of window.__sys.active) if (e.active && e.state !== 'dead') e.kill(false); });

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
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormErupt', id: 950001, p: [x, y, z], r: 12, hp: 2345, spit: 12 });
    const worm = sys.byId.get(950001);
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'spawn', id: 950002, ty: 'scavenger', p: [x, y + 9, z], yaw: 0 });
    sys.replicaMgr.onEvent({ t: 'ee', ev: 'wormSpit', id: 950001, from: [x, y + 9, z], b: [[950002, x + 8, ctx.world.getHeightAt(x + 8, z), z]], T: 1.1 });
    const bug = sys.byId.get(950002);
    return {
      warned: window.__ev.warning.length - w0, warnEta: warn ? warn.eta : -1, erupted: window.__ev.erupted.length - e0,
      maxHp: worm ? worm.maxHp : -1, spitLeft: worm ? worm.wormSpitUntil - ctx.time : -1, emerging: worm ? worm.emergeT > 0 : false,
      bugSpat: bug ? bug.spatT : -1, time: ctx.time,
    };
  });
  ok(s8.warned === 1 && Math.abs(s8.warnEta - 2) < 0.1, `리플리카 wormWarn → 전조 (eta ${s8.warnEta})`);
  ok(s8.erupted === 1 && s8.maxHp === 2345 && Math.abs(s8.spitLeft - 12) < 0.2 && s8.emerging, `리플리카 wormErupt → 최대 체력 · 뱉기 시간 · 솟아오름 (${s8.maxHp}, ${s8.spitLeft.toFixed(2)})`);
  ok(s8.bugSpat > 1, `리플리카 wormSpit → 뱉어진 몸이 스스로 포물선을 그린다 (spatT ${s8.bugSpat})`);
  await waitSim(1.5);
  const s8b = await P(() => { const b = window.__sys.byId.get(950002); return b ? { t: b.spatT, air: b.airborne } : null; });
  ok(!!s8b && s8b.t === 0 && !s8b.air, '리플리카의 뱉어진 몸이 착지했다');
  const s8c = await P(() => {
    const sys = window.__sys; const v0 = sys.debugSandwormState.spitVolleys;
    sys.setAuthority(true);
    const w = sys.byId.get(950001);
    window.__v0 = v0;
    return { maxHp: w ? w.maxHp : -1, hp: w ? w.hp : -1, spitLeft: w ? w.wormSpitUntil - window.__game.ctx.time : -1 };
  });
  ok(s8c.maxHp === 2345 && s8c.hp <= 2345 && s8c.spitLeft > 8, `승격해도 최대 체력 · 뱉기 시간이 이어진다 (${s8c.maxHp}, ${s8c.spitLeft.toFixed(1)}s)`);
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
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
