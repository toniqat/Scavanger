// 레이더 강하 (src/enemies/RogueDrop.ts) 단독 스모크 — 릴레이 없이 싱글 플레이로 돈다.
// 검사: callRogueDrop 의 예고 → getRogueDrops → ROGUE_DROP_ETA_S 뒤 착지 → 분대 인원(싱글 = 3명 · 두 번째 파도 없음 · 보스 없음)
//       **레이더** 스폰(site 'drop' · 분대 하나 · 우회조 정확히 한 명) → 트리거 지점(구조물)으로 진격, 같은 dropId 재호출 거부,
//       structure:investigated 의 **구역당 1회**, 상시 개체수 상한이 강하 인원을 깎지 않는 것, 훈련장 게이트.
//       2026-09-10: 강하가 조용하지 않은 것 — 토스트 + 위험 인디케이터 + 착지 충격음(rogue_pod_impact).
//       2026-09-13 (행성별 팩션): 레이드는 threat 2 행성(보레아스 IX)에서 돈다. 파도 — 분대 2 / 3 / 4인이면 두 번째 파도가
//       RAIDER_DROP_WAVE_GAP_S 뒤 `${zone}#2` 로 따로 예고되고(인원 2 / 3 / 3–4), 한 파도는 4명을 넘지 않으며, 파도마다 분대 id 가
//       다르다. threat 1 행성(아켈론 II)에서는 조사해도 굴리지 않는다.
// Usage: node scripts/smoke-rogue-drop.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
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

// 계약 값 (data/constants.csv · data/tables.csv) — 브라우저 안에서 상수를 import 할 수 없으니 여기 옮겨 적는다
const ETA = 8;
const RADIUS = 26;
const SOLO = 3;
const WAVE_GAP = 10;
const WAVE_MAX = 4;
/** 분대 인원 → [첫 파도 lo, hi, 두 번째 파도 lo, hi] (RAIDER_DROP_WAVE1_* · WAVE2_*). */
const WAVES = { 1: [3, 3, 0, 0], 2: [3, 3, 2, 2], 3: [3, 3, 3, 3], 4: [4, 4, 3, 4] };
const WATCH_S = 3;
const PLANET = 'tundra';      // threat 2
const CALM_PLANET = 'amber';  // threat 1

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
    // 이 스크립트는 튜토리얼을 검사하지 않는다 (scripts/smoke-tutorial.mjs 의 몫) — 끝난 것으로 표시해 둔다
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  // Park vite's HMR socket: another agent's save would otherwise full-reload the page mid-run.
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
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['rogueDrop:incoming', 'rogueDrop:landed', 'audio:play', 'enemy:spawned', 'enemy:bossSpawned']) {
      window.__ev[n] = [];
      bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
    }
    window.__sys = window.__game.getSystem('enemies');
    window.__V = window.__game.ctx.camera.position.constructor;
    /** 플레이어에게서 멀리(시야 밖) · 거점(구조물 · 플랫폼 · 폐허)에서도 멀리 떨어진 맵 안 지점 하나. */
    window.__farPoint = (minD) => {
      const ctx = window.__game.ctx; const V = window.__V; const world = ctx.world; const pp = ctx.player.position;
      const sites = [...world.getStructures().map((s) => s.position), ...world.getRailLines().flatMap((l) => l.platforms.map((p) => p.position)),
        ...(typeof world.getRuinSites === 'function' ? world.getRuinSites().map((r) => r.position) : [])];
      for (let k = 0; k < 800; k++) {
        const x = pp.x + (Math.random() - 0.5) * 420, z = pp.z + (Math.random() - 0.5) * 420;
        if (!world.isInsideBounds(x, z) || Math.hypot(x - pp.x, z - pp.z) < minD) continue;
        if (k < 600 && sites.some((s) => Math.hypot(s.x - x, s.z - z) < 75)) continue;
        return new V(x, world.getHeightAt(x, z), z);
      }
      return null;
    };
    /** 거점 그룹을 치운다 — threat 2 행성은 거점마다 로그 · 레이더가 서 있어 강하 병력이 진격 대신 교전에 들어간다. */
    window.__clearHumanoids = () => { for (const e of window.__sys.active) if (e.active && e.isHumanoid && e.state !== 'dead') e.kill(false); };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const startMission = async (seed, planet) => {
    await P((a) => { const ctx = window.__game.ctx; ctx.missionPlanet = a.planet; ctx.missionMode = 'raid'; ctx.bus.emit('game:newMission', { seed: a.seed, planet: a.planet }); }, { seed, planet });
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 25000);
    await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 10000);
    await waitSim(0.3);
  };

  console.log(`mission (seed 41, ${PLANET} = threat 2)`);
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await startMission(41, PLANET);
  ok(await P(() => window.__sys.isAuthority), 'single-player: the drop rolls on the authority');
  ok(await P(() => window.__sys.planetThreatLevel === 2), 'the raid runs on a threat-2 planet');
  ok(await P(() => window.__game.ctx.enemies.getRogueDrops().length === 0), 'no drop is in progress at mission start');

  /* ── 1. 예고 ───────────────────────────────────────────────────────────── */
  console.log('예고 (callRogueDrop)');
  const call = await P(() => {
    const ctx = window.__game.ctx; const p = window.__farPoint(130);
    if (!p) return null;
    window.__clearHumanoids();
    window.__drop = { x: p.x, y: p.y, z: p.z };
    const before = window.__sys.active.filter((e) => e.active && e.isHumanoid).map((e) => e.id);
    const okCall = ctx.enemies.callRogueDrop('smoke_zone', p);
    const again = ctx.enemies.callRogueDrop('smoke_zone', p);
    const views = ctx.enemies.getRogueDrops().map((v) => ({ id: v.id, count: v.count, boss: v.boss, landsAt: v.landsAt, p: [v.position.x, v.position.y, v.position.z] }));
    return { okCall, again, views, before, time: ctx.time, waves: window.__sys.debugDropWaves };
  });
  ok(call && call.okCall === true, 'callRogueDrop returns true on the authority', JSON.stringify(call && call.okCall));
  ok(call && call.again === false, 'the same dropId is refused while it is in progress');
  ok(call && call.views.length === 1, `getRogueDrops lists the pending drop (${call ? call.views.length : -1})`);
  const view = call && call.views[0];
  ok(view && view.id === 'smoke_zone', 'the view carries the dropId');
  ok(view && view.count === SOLO, `1인 분대 → ${SOLO}명 (count ${view && view.count})`);
  ok(view && view.boss === false, `레이더 강하에는 분대장이 없다 (boss ${view && view.boss})`);
  ok(call && call.waves.pending.length === 0, `1인 분대에는 두 번째 파도가 없다 (${JSON.stringify(call && call.waves.pending)})`);
  ok(view && Math.abs(view.landsAt - (call.time + ETA)) < 0.6, `landsAt = ctx.time + ROGUE_DROP_ETA_S (${view && (view.landsAt - call.time).toFixed(2)}s)`);
  const inc = await P(() => window.__ev['rogueDrop:incoming']);
  ok(inc.length === 1 && inc[0].dropId === 'smoke_zone' && inc[0].eta === ETA, `rogueDrop:incoming emitted once (${inc.length})`, JSON.stringify(inc[0]));
  // 2026-09-10: 경보 · 낙하 굉음은 audio/AudioSystem 이 `rogueDrop:incoming` 을 받아 낸다 (전용 반경 · 거리 감쇠).
  // `audio:play` 버스 이벤트가 아니라 AudioSystem 내부 호출이므로 여기서는 DOM 알림 · 위험 인디케이터로 확인한다.
  // 토스트와 인디케이터는 같은 프레임에 뜨지 않으므로(하나는 이벤트 · 하나는 lateUpdate) 폴링하며 누적한다.
  // 2026-09-13: 문구는 ui/ 가 "레이더 강하" 로 바꾸는 중이라 `강하` 만 본다.
  let alerted = { toast: false, danger: 0 };
  const seenAlert = () => {
    const a = window.__alert || (window.__alert = { toast: false, danger: 0 });
    if ([...document.querySelectorAll('.notif')].some((n) => /강하/.test(n.textContent || ''))) a.toast = true;
    a.danger = Math.max(a.danger, document.querySelectorAll('.dgr-head:not([hidden]), .dgr-arc:not([hidden])').length);
    return a.toast && a.danger > 0 ? a : null;
  };
  try { alerted = await waitFor(page, seenAlert, '강하 알림', 6000); }
  catch { alerted = await P(() => window.__alert ?? { toast: false, danger: 0 }); }
  ok(alerted.toast, '강하 토스트가 뜬다');
  ok(alerted.danger > 0, '위험 인디케이터(머리 마커 · 방향 호)가 강하를 가리킨다', JSON.stringify(alerted));

  /* ── 2. 착지 ───────────────────────────────────────────────────────────── */
  console.log(`착지 (+${ETA}s)`);
  await waitSim(ETA + 1.0);
  const landed = await P((a) => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const d = window.__drop;
    const fresh = sys.active.filter((e) => e.active && e.isHumanoid && !a.before.includes(e.id));
    return {
      ev: window.__ev['rogueDrop:landed'],
      pending: ctx.enemies.getRogueDrops().length,
      spawned: fresh.length,
      types: fresh.map((e) => e.type),
      sites: fresh.map((e) => e.site),
      squads: [...new Set(fresh.map((e) => e.squadId))],
      roles: fresh.map((e) => e.squadRole),
      dist: fresh.map((e) => Math.hypot(e.position.x - d.x, e.position.z - d.z)),
      guard: fresh.map((e) => Math.hypot(e.guardPos.x - d.x, e.guardPos.z - d.z)),
      investigating: fresh.filter((e) => e.investigating).length,
      origin: fresh.map((e) => Math.hypot(e.shotOrigin.x - d.x, e.shotOrigin.z - d.z)),
      ids: fresh.map((e) => e.id),
      impact: window.__ev['audio:play'].filter((x) => x.id === 'rogue_pod_impact').length,
      boss: window.__ev['enemy:bossSpawned'].filter((b) => fresh.some((e) => e.id === b.id)).length,
    };
  }, { before: call.before });
  ok(landed.ev.length === 1 && landed.ev[0].dropId === 'smoke_zone', `rogueDrop:landed emitted once (${landed.ev.length})`);
  ok(landed.pending === 0, `착지한 강하는 getRogueDrops 에서 빠진다 (${landed.pending})`);
  ok(landed.spawned === view.count, `예고한 인원 그대로 내려온다 — 상시 상한이 깎지 않는다 (${landed.spawned} / ${view.count})`);
  ok(landed.types.every((t) => t === 'raider'), `강하 병력은 레이더만 (${JSON.stringify(landed.types)})`);
  ok(landed.sites.every((s) => s === 'drop'), `site = 'drop' (${JSON.stringify(landed.sites)})`);
  ok(landed.squads.length === 1 && landed.squads[0] > 0, `파도 하나 = 분대 하나 (${JSON.stringify(landed.squads)})`);
  ok(landed.roles.filter((r) => r === 'flanker').length === 1, `우회조 정확히 한 명 (${JSON.stringify(landed.roles)})`);
  ok(landed.boss === 0, 'enemy:bossSpawned 없음');
  ok(landed.dist.length > 0 && landed.dist.every((d) => d <= RADIUS + 3), `착지 지점이 ROGUE_DROP_RADIUS(${RADIUS} m) 안이다 (${landed.dist.map((d) => d.toFixed(1)).join(', ')})`);
  ok(landed.guard.every((d) => d < 0.01), 'guardPos = 트리거 지점 (진격이 끝나면 구조물을 지킨다)', JSON.stringify(landed.guard));
  ok(landed.investigating === landed.spawned, `전원이 진격(investigate) 상태로 내린다 (${landed.investigating} / ${landed.spawned})`);
  ok(landed.origin.every((d) => d < 0.01), '진격 목표 = 트리거 지점', JSON.stringify(landed.origin));
  ok(landed.impact > 0, `착지 충격음 (rogue_pod_impact ×${landed.impact})`);

  /* ── 3. 진격 ───────────────────────────────────────────────────────────── */
  console.log(`진격 (watch ${WATCH_S}s → advance)`);
  const d0 = landed.dist.slice();
  await waitSim(WATCH_S + 9);
  const adv = await P((ids) => {
    const sys = window.__sys; const d = window.__drop;
    return ids.map((id) => {
      const e = sys.active.find((x) => x.id === id && x.active);
      if (!e || e.state === 'dead') return null;
      return { d: Math.hypot(e.position.x - d.x, e.position.z - d.z), phase: e.shotPhase, inv: e.investigating, aware: e.aware };
    });
  }, landed.ids);
  const moved = adv.filter((a, i) => a && a.d < d0[i] - 1).length;
  const alive = adv.filter((a) => a).length;
  ok(alive > 0 && moved >= Math.ceil(alive / 2), `절반 이상이 구조물 쪽으로 붙었다 (${moved} / ${alive}; ${adv.map((a, i) => a ? `${d0[i].toFixed(0)}→${a.d.toFixed(0)}` : 'x').join(' ')})`);

  /* ── 3b. 파도 (분대 인원) ──────────────────────────────────────────────── */
  console.log('파도 (분대 2 / 3 / 4인)');
  const plan = await P((W) => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const out = {};
    for (const n of [2, 3, 4]) {
      sys.debugSetDropSquad(n);
      const p = window.__farPoint(120);
      const id = `wave_zone_${n}`;
      const okCall = p ? ctx.enemies.callRogueDrop(id, p) : false;
      const view = ctx.enemies.getRogueDrops().find((v) => v.id === id);
      const pending = sys.debugDropWaves.pending.find((w) => w.id === `${id}#2`);
      out[n] = { okCall, count: view ? view.count : -1, pending: pending ? { count: pending.count, dt: pending.at - ctx.time } : null };
      if (n === 4) window.__wave4 = { id, p: p ? { x: p.x, z: p.z } : null, before: sys.active.filter((e) => e.active && e.isHumanoid).map((e) => e.id) };
    }
    return out;
  }, WAVES);
  for (const n of [2, 3, 4]) {
    const r = plan[n]; const [lo1, hi1, lo2, hi2] = WAVES[n];
    ok(r.okCall && r.count >= lo1 && r.count <= hi1 && r.count <= WAVE_MAX, `${n}인 분대: 첫 파도 ${lo1}–${hi1}명 (${r.count})`, JSON.stringify(r));
    ok(r.pending && r.pending.count >= lo2 && r.pending.count <= hi2 && r.pending.count <= WAVE_MAX && Math.abs(r.pending.dt - WAVE_GAP) < 0.6,
      `${n}인 분대: 두 번째 파도 ${lo2}–${hi2}명이 ${WAVE_GAP}초 뒤로 예약된다`, JSON.stringify(r.pending));
  }
  await waitSim(WAVE_GAP + 0.5);
  const w2 = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys;
    const inc = window.__ev['rogueDrop:incoming'].filter((e) => /^wave_zone_\d#2$/.test(e.dropId));
    const views = ctx.enemies.getRogueDrops().filter((v) => /#2$/.test(v.id)).map((v) => ({ id: v.id, count: v.count, boss: v.boss }));
    return { inc: inc.map((e) => ({ id: e.dropId, count: e.count })), views, pending: sys.debugDropWaves.pending.length, all: ctx.enemies.getRogueDrops().map((v) => v.count) };
  });
  ok(w2.inc.length === 3, `두 번째 파도가 각자 rogueDrop:incoming 으로 따로 예고됐다 (${JSON.stringify(w2.inc)})`);
  ok(w2.pending === 0 && w2.views.length === 3 && w2.views.every((v) => v.boss === false), `두 번째 파도가 getRogueDrops 에 올라가고 예약이 비었다 (${JSON.stringify(w2.views)})`);
  ok(w2.all.every((c) => c <= WAVE_MAX), `한 파도는 ${WAVE_MAX}명을 넘지 않는다 (${JSON.stringify(w2.all)})`);
  await waitSim(ETA + 1.0);
  const w4 = await P(() => {
    const sys = window.__sys; const a = window.__wave4;
    const fresh = sys.active.filter((e) => e.active && e.isHumanoid && !a.before.includes(e.id) && e.site === 'drop');
    const bySquad = {};
    for (const e of fresh) (bySquad[e.squadId] ||= []).push(e.squadRole);
    return { n: fresh.length, types: [...new Set(fresh.map((e) => e.type))], bySquad };
  });
  const squads = Object.values(w4.bySquad);
  ok(w4.types.length === 1 && w4.types[0] === 'raider', `파도 병력은 전부 레이더 (${JSON.stringify(w4.types)})`);
  ok(squads.length >= 4 && squads.every((roles) => roles.length <= WAVE_MAX && roles.filter((r) => r === 'flanker').length === 1),
    `파도마다 자기 분대 · 우회조 한 명 (${JSON.stringify(w4.bySquad)})`);

  /* ── 4. 구역당 1회 ─────────────────────────────────────────────────────── */
  console.log('구역당 1회 (structure:investigated)');
  const once = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const V = window.__V;
    sys.debugSetDropSquad(null);
    const pp = ctx.player.position;
    const p = new V(pp.x + 60, ctx.world.getHeightAt(pp.x + 60, pp.z + 60), pp.z + 60);
    const r0 = sys.debugRogueDrops.rolls;
    sys.debugInvestigate('zone_once', p);
    const r1 = sys.debugRogueDrops.rolls;
    sys.debugInvestigate('zone_once', p);
    sys.debugInvestigate('zone_once', p);
    const r2 = sys.debugRogueDrops.rolls;
    return { r0, r1, r2 };
  });
  ok(once.r1 === once.r0 + 1, `첫 조사는 굴린다 (rolls ${once.r0} → ${once.r1})`);
  ok(once.r2 === once.r1, `같은 구역은 다시 굴리지 않는다 — 실패했더라도 (rolls ${once.r2})`);

  // 여러 구역을 조사하면 RAIDER_DROP_CHANCE_BY_THREAT[1](0.45) 로 언젠가는 실제 강하가 뜬다
  const many = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const V = window.__V;
    const pp = ctx.player.position;
    const c0 = sys.debugRogueDrops.calls;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = pp.x + Math.cos(a) * 150, z = pp.z + Math.sin(a) * 150;
      if (!ctx.world.isInsideBounds(x, z)) continue;
      sys.debugInvestigate(`zone_many_${i}`, new V(x, ctx.world.getHeightAt(x, z), z));
    }
    const s = sys.debugRogueDrops;
    return { c0, calls: s.calls, rolls: s.rolls, pending: s.pending.length };
  });
  ok(many.calls > many.c0, `구조물 조사가 실제로 강하를 부른다 (calls ${many.c0} → ${many.calls}, rolls ${many.rolls})`);
  ok(many.pending > 0, `부른 강하가 예고 목록에 올라간다 (${many.pending})`);

  /* ── 5. 미션 리셋 ──────────────────────────────────────────────────────── */
  console.log('미션 리셋');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 20000);
  await P(() => { window.__game.ctx.bus.emit('game:abort', {}); });
  await waitSim(0.3);
  const afterReset = await P(() => ({ pending: window.__game.ctx.enemies.getRogueDrops().length, rolls: window.__sys.debugRogueDrops.rolls, waves: window.__sys.debugDropWaves.pending.length }));
  ok(afterReset.pending === 0 && afterReset.rolls === 0 && afterReset.waves === 0, `미션 리셋이 진행 중인 강하 · 예약 파도 · 굴림 기록을 비운다 (${JSON.stringify(afterReset)})`);

  /* ── 5b. threat 1 행성: 강하 없음 ──────────────────────────────────────── */
  console.log(`threat 1 (${CALM_PLANET})`);
  await startMission(41, CALM_PLANET);
  const calm = await P(() => {
    const sys = window.__sys; const ctx = window.__game.ctx; const V = window.__V;
    const pp = ctx.player.position;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = pp.x + Math.cos(a) * 150, z = pp.z + Math.sin(a) * 150;
      if (!ctx.world.isInsideBounds(x, z)) continue;
      sys.debugInvestigate(`calm_zone_${i}`, new V(x, ctx.world.getHeightAt(x, z), z));
    }
    const s = sys.debugRogueDrops;
    return { threat: sys.planetThreatLevel, rolls: s.rolls, calls: s.calls, pending: s.pending.length };
  });
  ok(calm.threat === 1 && calm.rolls === 0 && calm.calls === 0 && calm.pending === 0, `threat 1 행성에서는 조사해도 굴리지 않는다 (${JSON.stringify(calm)})`);
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 20000);

  /* ── 6. 훈련장 게이트 ──────────────────────────────────────────────────── */
  console.log('훈련장');
  await P(() => {
    const ctx = window.__game.ctx;
    ctx.missionPlanet = null;
    ctx.missionMode = 'training';
    ctx.bus.emit('game:newMission', { seed: 7, mode: 'training' });
  });
  await waitFor(page, () => window.__game.ctx.phase === 'playing' || window.__game.ctx.phase === 'deploying', 'training mission', 25000);
  await waitSim(0.6);
  const train = await P(() => {
    const ctx = window.__game.ctx; const sys = window.__sys; const V = window.__V;
    const pp = ctx.player.position;
    const p = new V(pp.x + 12, pp.y, pp.z + 12);
    const called = ctx.enemies.callRogueDrop('train_zone', p);
    sys.debugInvestigate('train_zone2', p);
    return { training: sys.isTrainingWorld, called, pending: ctx.enemies.getRogueDrops().length, rolls: sys.debugRogueDrops.rolls };
  });
  ok(train.training, 'training world recognised');
  ok(train.called === false && train.pending === 0 && train.rolls === 0, `훈련장에서는 강하가 없다 (${JSON.stringify(train)})`);
  await P(() => { window.__game.ctx.missionMode = 'raid'; window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
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
