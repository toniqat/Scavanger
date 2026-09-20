// Standalone smoke for the environmental hazard (src/world/Hazard.ts) — it runs single player, with no relay.
// Checks: the kind drawn by seed out of the planet's candidates · a start time in 30 s steps, that there are no
//       zones before it starts, announced → started → progress (a cap on how often it is published), `front`'s
//       「the side against the normal is the dangerous one」 convention, the whole map turning dangerous once it runs
//       to the end, the damage per second inside a zone · hazard:insideChanged · atmo:override, the spores' giant
//       mushroom groves (sources · harvestable mushrooms · fog:discovered 'grove'), the training-range gate and the
//       mission reset.
// 2026-09-13: the extraction pad count (threat 1 = 2–3 · 2 = 2 · 3 = 1–2), a spores raid's central drop · central
//       groves · outer pads, the storm eye starting as a circle that takes in the map's corners, the front entering
//       from the drop point's side, and the damage multiplier · HAZARD_DPS_MAX per second at progress 1.
// Usage: node scripts/smoke-hazard.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { closeBrowser } from './close-browser.mjs';
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

// The contract values (data/constants.csv · data/planets.csv) — a constant cannot be imported inside the browser,
// so they are transcribed here
const START_MIN = 360, START_MAX = 480, START_STEP = 30;
const WARN_S = 30, DPS = 1, TICK_S = 1, FULL_S = 420, EDGE_M = 12;
// 2026-09-13: a hazard grows stronger over time — damage HAZARD_DPS → HAZARD_DPS_MAX, the sight multiplier
// HAZARD_FOG_RAMP_START → END
const DPS_MAX = 5, FOG_RAMP_END = 1.25;
// 2026-09-13: a spores raid = a central drop · central groves · outer extraction pads (constants.csv's SPORE_* ·
// EXTRACTION_OUTER_MIN_M)
const SPORE_CENTER_R = 170, SPORE_GROVE_SPAWN_GAP = 80, OUTER_MIN = 200;
// 2026-09-10: how hard sight is narrowed differs per hazard (data/hazards.csv's fogMul) — only the storm eye is
// far denser
const FOG_MUL = { sandstorm: 7, blizzard: 7, storm_eye: 24, spores: 7 };
// 2026-09-11 (C-15): the storm eye closes fully at the end too — STORM_EYE_RADIUS_END 60 → 0
const EYE_START = 300, EYE_END = 0;
const SPORE_START = 360, SPORE_INTERVAL = 50, SPORE_MIN = 3, SPORE_MAX = 6;
const MAP = 640;
// The per-planet candidates (data/planets.csv's hazards column)
const AMBER = ['sandstorm', 'storm_eye'];       // the planet 아켈론 II
const MOSSY = ['spores', 'storm_eye'];          // the planet 베르단트 III

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
    try { localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } })); } catch { /* storage off */ }
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
  });
  await quietViteHmr(page, { parkRelay: true });   // vite HMR + the relay (scripts/quiet-hmr.mjs)
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.world, 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    const canvas = document.getElementById('game-canvas');
    Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
    window.__worldSys = window.__game.getSystem('world');
    window.__ev = {};
    const bus = window.__game.ctx.bus;
    for (const n of ['hazard:planned', 'hazard:announced', 'hazard:started', 'hazard:progress',
      'hazard:insideChanged', 'atmo:override', 'fog:discovered']) {
      window.__ev[n] = [];
      bus.on(n, (p) => window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3 ? [v.x, v.y, v.z] : v)))));
    }
    window.__clear = () => { for (const k of Object.keys(window.__ev)) window.__ev[k].length = 0; };
    /** One mission (the emitter convention: ctx first, then emit). */
    window.__mission = (seed, planet, mode) => {
      const ctx = window.__game.ctx;
      ctx.missionPlanet = planet ?? null;
      ctx.missionMode = mode ?? 'raid';
      const ev = { seed };
      if (mode) ev.mode = mode;
      if (planet) ev.planet = planet;
      ctx.bus.emit('game:newMission', ev);
    };
    /** Winds the hazard to second `t` (`missionTime` is an ordinary field). The state updates one frame later. */
    window.__seek = (t) => { window.__game.ctx.missionTime = t; };
    /** A summary of the zones as they are now (`getZones()` reuses its array, so copy at once). */
    window.__zones = () => (window.__game.ctx.world.hazard?.getZones() ?? []).map((z) => ({
      id: z.id, shape: z.shape, cx: z.center.x, cz: z.center.z, r: z.radius,
      dx: z.dirX, dz: z.dirZ, safeInside: z.safeInside,
    }));
    window.__hz = () => {
      const h = window.__game.ctx.world.hazard;
      return h ? { kind: h.kind, startsAt: h.startsAt, announced: h.announced, active: h.active, progress: h.progress } : null;
    };
    /** Sweeps the whole map as a grid and counts the samples that are not dangerous. */
    window.__safeCount = (n, half) => {
      const h = window.__game.ctx.world.hazard;
      if (!h) return -1;
      let safe = 0;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const x = -half + (i / n) * half * 2, z = -half + (j / n) * half * 2;
        if (!h.isInside(x, z)) safe++;
      }
      return safe;
    };
  });
  const waitSim = async (sec) => { const t0 = await page.evaluate(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 240000, t0 + sec); };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const newMission = async (seed, planet) => {
    await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
    await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 25000);
    await P((a) => { window.__clear(); window.__mission(a.seed, a.planet); }, { seed, planet });
    await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
    await waitFor(page, () => !window.__game.ctx.player.isDropping, 'hellpod exit', 15000);
    await waitSim(0.4);
  };

  /* ── 1. The plan (아켈론 II) ─────────────────────────────────────────── */
  console.log('계획 (아켈론 II · seed 21)');
  await newMission(21, 'amber');
  const h0 = await P(() => window.__hz());
  ok(!!h0, 'ctx.world.hazard 가 생겼다 (후보가 있는 행성)');
  ok(h0 && AMBER.includes(h0.kind), `종류가 행성 후보 중 하나다 (${h0 && h0.kind}; ${AMBER.join(' | ')})`);
  ok(h0 && h0.startsAt >= START_MIN && h0.startsAt <= START_MAX, `시작 시각이 ${START_MIN}~${START_MAX}s (${h0 && h0.startsAt})`);
  ok(h0 && h0.startsAt % START_STEP === 0, `시작 시각이 ${START_STEP}초 단위다 (${h0 && h0.startsAt})`);
  const planned = await P(() => window.__ev['hazard:planned']);
  ok(planned.length === 1 && planned[0].kind === h0.kind && planned[0].startsAt === h0.startsAt,
    `hazard:planned 이 월드 생성 직후 한 번 (${JSON.stringify(planned)})`);
  ok(h0 && h0.active === false && h0.progress === 0, '시작 전에는 active=false · progress=0');
  ok((await P(() => window.__zones())).length === 0, '시작 전에는 도형이 없다');
  ok(await P(() => window.__safeCount(12, 320)) === 13 * 13, '시작 전에는 맵 어디도 위험하지 않다');
  // 2026-09-13: the planet's threat decides the extraction pad count (threat 1 = 2–3)
  const pads1 = await P(() => window.__game.ctx.world.getExtractionPoints().length);
  ok(pads1 >= 2 && pads1 <= 3, `threat 1 행성(아켈론 II)의 탈출 패드는 2~3개 (${pads1})`);

  /* ── 2. Determinism ─────────────────────────────────────────────────── */
  console.log('결정성 (같은 시드 · 같은 행성)');
  await newMission(21, 'amber');
  const h0b = await P(() => window.__hz());
  ok(h0b && h0b.kind === h0.kind && h0b.startsAt === h0.startsAt,
    `같은 시드는 같은 계획을 낸다 (${h0.kind}@${h0.startsAt} vs ${h0b && h0b.kind}@${h0b && h0b.startsAt})`);

  /* ── 3. Announced → started → progress ──────────────────────────── */
  console.log('예고 → 시작 → 진행도');
  // `WARN_S` is a Node-side constant — a page.evaluate callback runs in the browser and cannot see that scope,
  // so it is handed over as an argument.
  await P((a) => { window.__clear(); window.__seek(a.at - a.warn + 2); }, { at: h0.startsAt, warn: WARN_S });
  await waitSim(0.4);
  const ann = await P(() => window.__ev['hazard:announced']);
  ok(ann.length === 1 && ann[0].kind === h0.kind, `hazard:announced 이 한 번 (${ann.length})`);
  ok(ann.length === 1 && ann[0].secondsLeft > 0 && ann[0].secondsLeft <= WARN_S, `남은 초가 0~${WARN_S} (${ann[0] && ann[0].secondsLeft})`);
  ok(await P(() => window.__hz().announced) === true, 'HazardRef.announced 가 켜졌다');

  await P((a) => { window.__clear(); window.__seek(a + 1); }, h0.startsAt);
  await waitSim(2.2);
  const started = await P(() => window.__ev['hazard:started']);
  ok(started.length === 1 && started[0].kind === h0.kind, `hazard:started 가 한 번 (${started.length})`);
  const hz1 = await P(() => window.__hz());
  ok(hz1.active === true && hz1.progress > 0 && hz1.progress < 0.02, `active · progress 가 막 올라간다 (${hz1.progress.toFixed(4)})`);
  const prog = await P(() => window.__ev['hazard:progress'].length);
  ok(prog >= 1 && prog <= 10, `hazard:progress 가 2초에 1~10회 — 프레임마다 쏘지 않는다 (${prog})`);
  ok((await P(() => window.__zones())).length >= 1, '시작하면 도형이 생긴다');
  if (h0.kind === 'storm_eye') {
    // 2026-09-13: the storm eye starts as a circle taking in all four map corners — at the moment it starts the
    // whole map is safe (wound and measured inside one evaluate)
    const atStart = await P((a) => { window.__game.ctx.missionTime = a; return window.__safeCount(16, 320); }, h0.startsAt);
    ok(atStart === 17 * 17, `폭풍의 눈 시작 순간 안전지대 100 % (${atStart}/${17 * 17})`);
  }

  /* ── 4. The zone conventions ───────────────────────────────────────── */
  console.log('도형 규약');
  const mid = await P((a) => { window.__seek(a.at + a.full * 0.5); return null; }, { at: h0.startsAt, full: FULL_S }) ?? await P(() => window.__zones());
  await waitSim(0.3);
  const zs = await P(() => window.__zones());
  if (h0.kind === 'storm_eye') {
    ok(zs.length === 1 && zs[0].shape === 'circle' && zs[0].safeInside === true, `폭풍의 눈 = 안이 안전한 원 하나 (${JSON.stringify(zs)})`);
    // 2026-09-13: the starting radius = from the eye's centre to the furthest map corner (the old fixed
    // EYE_START 300 is only a floor)
    const r0 = Math.max(EYE_START, Math.hypot(MAP / 2 + Math.abs(zs[0].cx), MAP / 2 + Math.abs(zs[0].cz)));
    const midR = (r0 + EYE_END) / 2;
    ok(Math.abs(zs[0].r - midR) < 8, `반경이 ${r0.toFixed(0)}(가장 먼 꼭짓점)→${EYE_END} 로 선형 축소한다 (중간 ${zs[0].r.toFixed(1)} / ${midR.toFixed(1)})`);
    const inside = await P((z) => window.__game.ctx.world.hazard.isInside(z.cx, z.cz), zs[0]);
    const outside = await P((z) => window.__game.ctx.world.hazard.isInside(z.cx + z.r + 40, z.cz), zs[0]);
    ok(inside === false && outside === true, `눈 안은 안전 · 밖은 위험 (안 ${inside} / 밖 ${outside})`);
  } else {
    ok(zs.length === 1 && zs[0].shape === 'front', `직선 잠식 = front 하나 (${JSON.stringify(zs)})`);
    const z = zs[0];
    const sides = await P((a) => {
      const h = window.__game.ctx.world.hazard;
      return {
        behind: h.isInside(a.cx - a.dx * 60, a.cz - a.dz * 60),   // the side it has already passed
        ahead: h.isInside(a.cx + a.dx * 60, a.cz + a.dz * 60),    // the side it has not reached yet
      };
    }, z);
    ok(sides.behind === true && sides.ahead === false, `법선 반대편(지나온 쪽)이 위험이다 (뒤 ${sides.behind} / 앞 ${sides.ahead})`);
    ok(Math.abs(Math.hypot(z.dx, z.dz) - 1) < 1e-6, '진행 방향이 단위 벡터다');
    // 2026-09-13: the front comes inward from the map edge the drop point sits on (travel direction · drop point < 0)
    const sp0 = await P(() => { const s = window.__game.ctx.world.getPlayerSpawn(); return { x: s.x, z: s.z }; });
    const dot = z.dx * sp0.x + z.dz * sp0.z;
    ok(dot < 0, `전선이 강하 지점 쪽 가장자리에서 들어온다 (dir·spawn ${dot.toFixed(1)})`);
  }
  void mid;

  /* ── 5. To the end = no safe zone left ───────────────────────── */
  console.log('끝까지 진행');
  await P((a) => window.__seek(a.at + a.full + 5), { at: h0.startsAt, full: FULL_S });
  await waitSim(0.4);
  const hzFull = await P(() => window.__hz());
  ok(Math.abs(hzFull.progress - 1) < 1e-6, `progress 가 1 에서 멈춘다 (${hzFull.progress})`);
  const mulFull = await P(() => window.__game.ctx.world.hazard.damageMul);
  ok(Math.abs(mulFull - DPS_MAX / DPS) < 1e-6, `끝까지 가면 피해 배수 = HAZARD_DPS_MAX / HAZARD_DPS (${mulFull})`);
  const safe = await P(() => window.__safeCount(16, 320));
  /* 2026-09-11 (C-15): the storm eye is no exception either — `STORM_EYE_RADIUS_END` is 0, so the eye closes
     completely (the old 60 m was the one exception that left 2.8 % of the map safe). */
  ok(safe === 0, `맵 전체가 위험 구역이다 — 안전지대 0 (${h0.kind}, 안전 표본 ${safe}/${17 * 17})`);
  if (h0.kind === 'storm_eye') {
    const rz = (await P(() => window.__zones()))[0];
    ok(Math.abs(rz.r - EYE_END) < 0.01, `마지막 반경 = STORM_EYE_RADIUS_END ${EYE_END} (${rz.r.toFixed(2)})`);
    const eyeIn = await P((z) => window.__game.ctx.world.hazard.isInside(z.cx + 0.3, z.cz), rz);
    ok(eyeIn === true, `닫힌 눈의 한가운데 곁도 위험하다 (중심 +0.3 m: ${eyeIn})`);
  }

  /* ── 6. Damage · sight ─────────────────────────────────────────────── */
  console.log('피해 · 시야 (구역 안으로 이동)');
  /* Section 5 above already wound to `startsAt + FULL_S + 5`, so the player is **already inside the zone**.
     `__clear()` only wipes the record: Hazard's internal 「it was inside」 edge state and its last `atmo:override`
     value stay as they were, so walking in from that state changes **nothing and publishes no event at all**
     (2026-09-09: that was why `isInside` was true while `hazard:insideChanged` was an empty array). So it is wound
     back to **before** the hazard starts, settles into the outside state, and only then goes in. */
  await P((a) => window.__seek(Math.max(0, a - 60)), h0.startsAt);
  await waitSim(0.8);
  await P((a) => {
    const ctx = window.__game.ctx;
    window.__clear();
    ctx.missionTime = a.at + a.full + 5;   // the moment the whole map (outside the eye, for a storm eye) is dangerous
    const h = ctx.world.hazard;
    const p = ctx.player;
    let x = p.position.x, z = p.position.z;
    if (!h.isInside(x, z)) {
      const zs = h.getZones();
      const c = zs[0];
      /* Out of the eye — but it has to stay **inside the map**. With the centre near a map edge `+ radius + 90`
         crosses the bound, and `respawnAt` pulls an out-of-map coordinate back to the spawn point (the same
         correction as Spawn.restoreState), leaving the player inside the safe zone — and then this check fails
         over a coordinate rather than over the hazard. (2026-09-09) */
      const lim = a.map / 2 - 20;
      const out = c.radius + 20;
      const dir = c.center.x > 0 ? -1 : 1;               // push toward the map centre
      x = Math.max(-lim, Math.min(lim, c.center.x + dir * out));
      z = Math.max(-lim, Math.min(lim, c.center.z));
      if (h.isInside(x, z) === false) { x = Math.max(-lim, Math.min(lim, c.center.x - dir * out)); }
    }
    p.respawnAt(new p.position.constructor(x, ctx.world.getHeightAt(x, z), z));
    window.__hp0 = p.hp;
  }, { at: h0.startsAt, full: FULL_S, map: MAP });
  await waitSim(0.6);
  const insideEv = await P(() => window.__ev['hazard:insideChanged']);
  /* On a failure the hazard · player state is printed alongside — an empty array on its own narrows nothing down. */
  const hzDbg = await P(() => {
    const ctx = window.__game.ctx; const h = ctx.world.hazard; const p = ctx.player;
    return {
      kind: h && h.kind, t: Math.round(ctx.missionTime), active: h && h.active,
      progress: h && +h.progress.toFixed(3), phase: ctx.phase, dead: p.isDead,
      px: +p.position.x.toFixed(1), pz: +p.position.z.toFixed(1),
      inside: h && h.isInside(p.position.x, p.position.z),
      zones: h ? h.getZones().map((z) => ({ s: z.shape, cx: +z.center.x.toFixed(1), cz: +z.center.z.toFixed(1), r: +z.radius.toFixed(1), si: z.safeInside })) : null,
    };
  });
  ok(insideEv.length >= 1 && insideEv[insideEv.length - 1].inside === true && insideEv[insideEv.length - 1].kind === h0.kind,
    `들어가면 hazard:insideChanged {inside:true} (${JSON.stringify(insideEv)})`, JSON.stringify(hzDbg));
  const atmo = await P(() => window.__ev['atmo:override']);
  const last = atmo[atmo.length - 1];
  const fogCap = 1 + ((FOG_MUL[h0.kind] ?? 7) - 1) * FOG_RAMP_END;   // 2026-09-13: the ramp multiplier at progress 1
  ok(!!last && last.blend > 0 && last.fogMul > 1 && last.fogMul <= fogCap + 1e-6 && last.color !== null,
    `atmo:override 로만 시야를 좁힌다 (${h0.kind} 상한 ${fogCap}, ${JSON.stringify(last)})`);
  ok(atmo.length <= 40, `atmo:override 를 프레임마다 쏘지 않는다 (0.6초에 ${atmo.length}회)`);
  await waitSim(3.4);
  const dmg = await P(() => ({ hp: window.__game.ctx.player.hp, hp0: window.__hp0 }));
  const lost = dmg.hp0 - dmg.hp;
  // 2026-09-13: the map is fully covered by now, so it is HAZARD_DPS_MAX per second
  ok(lost >= DPS_MAX * 2 && lost <= DPS_MAX * 6, `HAZARD_TICK_S(${TICK_S}s) 마다 ${DPS_MAX} 씩 깎인다 — 진행도 1 (4초에 ${lost.toFixed(1)})`);

  /* 2026-09-11 (C-14 · X-7): **a disconnected squadmate's body (the ghost) takes hazard damage too.** The
     authority (single player = this page) publishes `ghost:damage` every `HAZARD_TICK_S` for a `suspended`
     squadmate inside a zone. A fake squadmate (`remotePlayers.debugSpawn`) is not in `net.getRemotePlayers()`, so
     it is slipped into that list for the duration of this check only. */
  console.log('끊긴 분대원(고스트)도 재해를 맞는다');
  const ghost0 = await P(() => {
    const ctx = window.__game.ctx;
    const rp = window.__game.getSystem('remotePlayers');
    const p = ctx.player;
    const ref = rp.debugSpawn({ id: 'hz-ghost', slot: 2, position: p.position.clone() });
    ref.hp = 100;
    const g = rp.debugSuspend('hz-ghost', true);
    window.__gref = ref;
    window.__gevents = [];
    window.__goff = ctx.bus.on('ghost:damage', (e) => window.__gevents.push({ id: e.id, amount: e.amount }));
    const net = ctx.net;
    const orig = net.getRemotePlayers.bind(net);
    net.getRemotePlayers = () => [...orig(), window.__gref];
    window.__gunpatch = () => { delete net.getRemotePlayers; };
    return { created: !!g, hp: g ? g.hp : null, inside: ctx.world.hazard.isInside(ref.position.x, ref.position.z) };
  });
  await waitSim(3.3);
  const ghost1 = await P(() => {
    const g = window.__game.getSystem('remotePlayers').getGhost('hz-ghost');
    return { hp: g ? g.hp : null, shield: g ? g.shield : null, events: window.__gevents.slice() };
  });
  const gLost = (ghost0.hp ?? 0) - (ghost1.hp ?? 0) + 0;
  ok(ghost0.created && ghost0.inside, '구역 안에 끊긴 분대원 몸(고스트)을 세웠다', JSON.stringify(ghost0));
  ok(ghost1.events.length >= 2 && ghost1.events.every((e) => e.id === 'hz-ghost' && e.amount > 0),
    `HAZARD_TICK_S 마다 ghost:damage 가 나간다 (3.3초에 ${ghost1.events.length}회)`, JSON.stringify(ghost1.events));
  ok(gLost >= DPS_MAX * 2 && gLost <= DPS_MAX * 5, `고스트 체력이 초당 ${DPS_MAX} 씩 깎인다 — 로컬과 같은 램프 (${ghost0.hp} → ${ghost1.hp})`, JSON.stringify(ghost1));

  console.log('구역 밖으로');
  await P(() => {
    const ctx = window.__game.ctx;
    window.__clear();
    ctx.missionTime = 5;                    // still before the start = no danger zone
  });
  await waitSim(0.6);
  const outEv = await P(() => window.__ev['hazard:insideChanged']);
  ok(outEv.length === 1 && outEv[0].inside === false && outEv[0].kind === null,
    `나오면 hazard:insideChanged {inside:false, kind:null} 가 한 번 (${JSON.stringify(outEv)})`);
  const atmoOut = (await P(() => window.__ev['atmo:override'])).pop();
  ok(!!atmoOut && atmoOut.blend === 0 && atmoOut.fogMul === 1 && atmoOut.color === null,
    `나오면 대기 오버라이드가 원래대로 (${JSON.stringify(atmoOut)})`);
  // C-14: with no hazard the ghost takes nothing either — and the fake squadmate is cleared away
  const ghost2 = await P(() => { window.__gevents.length = 0; return window.__game.getSystem('remotePlayers').getGhost('hz-ghost')?.hp ?? null; });
  await waitSim(1.6);
  const ghost3 = await P(() => {
    const rp = window.__game.getSystem('remotePlayers');
    const out = { hp: rp.getGhost('hz-ghost')?.hp ?? null, events: window.__gevents.length };
    window.__goff(); window.__gunpatch(); rp.debugClear();
    return out;
  });
  ok(ghost3.events === 0 && ghost3.hp === ghost2, `재해가 없으면 고스트에게 ghost:damage 가 나가지 않는다 (${ghost3.events}회, hp ${ghost2} → ${ghost3.hp})`);

  /* ── 7. Spores · giant mushroom groves (베르단트 III) ────────── */
  console.log('독성 포자 · 거대 버섯 군락 (베르단트 III)');
  let sporeSeed = -1;
  let eyeChecked = h0.kind === 'storm_eye';
  for (const seed of [3, 7, 11, 19, 23, 29, 31, 37]) {
    await newMission(seed, 'mossy');
    const k = await P(() => window.__hz());
    ok(k && MOSSY.includes(k.kind), `seed ${seed}: 후보 안에서 뽑혔다 (${k && k.kind})`);
    /* 2026-09-11 (C-15): if section 1 drew a sandstorm, whether the storm eye closes fully is checked here. */
    if (k && k.kind === 'storm_eye' && !eyeChecked) {
      eyeChecked = true;
      await P((a) => window.__seek(a.at + a.full + 5), { at: k.startsAt, full: FULL_S });
      await waitSim(0.4);
      const eye = await P(() => { const z = window.__zones()[0]; return { r: z ? z.r : null, safe: window.__safeCount(16, 320), nearCentre: z ? window.__game.ctx.world.hazard.isInside(z.cx + 0.3, z.cz) : null }; });
      ok(eye.r !== null && Math.abs(eye.r - EYE_END) < 0.01 && eye.safe === 0 && eye.nearCentre === true,
        `seed ${seed}: 폭풍의 눈이 반경 ${EYE_END} 까지 닫혀 안전지대가 없다 (r ${eye.r}, 안전 표본 ${eye.safe})`, JSON.stringify(eye));
    }
    if (k && k.kind === 'spores') { sporeSeed = seed; break; }
  }
  if (!eyeChecked) console.log('  --   이 시드들에서 폭풍의 눈이 한 번도 안 나왔다 (C-15 끝 반경 검사 생략)');
  if (sporeSeed < 0) {
    fail++;
    console.log('  FAIL 8개 시드 안에 독성 포자가 한 번도 안 나왔다 (후보 추첨이 한쪽으로 쏠렸다)');
  } else {
    const sp = await P(() => {
      const h = window.__game.ctx.world.hazard;
      const src = h.getSources();
      const nodes = window.__game.ctx.world.getGatherNodes();
      // 2026-09-11 (the lab): a seed · sample node standing beside a grove does not count as 「a harvestable
      // mushroom was planted」
      const near = src.map((s) => nodes.filter((n) => n.kind === 'herb'
        && Math.hypot(n.position.x - s.position.x, n.position.z - s.position.z) < 16).length);
      const spawn = window.__game.ctx.world.getPlayerSpawn();
      return {
        kind: h.kind, startsAt: h.startsAt,
        sources: src.map((s) => ({ id: s.id, x: s.position.x, z: s.position.z, r: s.radius, erupted: s.erupted, discovered: s.discovered })),
        near,
        spawn: { x: spawn.x, z: spawn.z },
        pads: window.__game.ctx.world.getExtractionPoints().map((e) => ({ x: e.position.x, z: e.position.z })),
      };
    });
    ok(sp.startsAt === SPORE_START, `독성 포자만 시작 시각이 ${SPORE_START}s 고정이다 (${sp.startsAt})`);
    /* 2026-09-13: a spores raid is a central drop · central groves · 2–3 outer extraction pads (the spores
       spread from the centre outward) */
    const spawnR = Math.hypot(sp.spawn.x, sp.spawn.z);
    ok(spawnR < 130, `독성 포자 레이드는 맵 중앙에 강하한다 (중심에서 ${spawnR.toFixed(0)} m)`);
    ok(sp.pads.length >= 2 && sp.pads.length <= 3, `독성 포자 레이드의 탈출 패드는 2~3개 (${sp.pads.length})`);
    const outer = sp.pads.map((e) => Math.max(Math.abs(e.x), Math.abs(e.z)));
    ok(outer.every((d) => d >= OUTER_MIN * 0.8), `탈출 패드가 맵 외곽에 선다 (중심에서 x·z 최대 ${outer.map((d) => d.toFixed(0)).join(', ')} m)`);
    const srcR = sp.sources.map((s) => Math.hypot(s.x, s.z));
    ok(srcR.every((d) => d <= SPORE_CENTER_R * 1.8 + 1), `거대 버섯 군락이 맵 중앙부에 선다 (${srcR.map((d) => d.toFixed(0)).join(', ')} m)`);
    const srcGap = sp.sources.map((s) => Math.hypot(s.x - sp.spawn.x, s.z - sp.spawn.z));
    ok(srcGap.every((d) => d >= SPORE_GROVE_SPAWN_GAP - 1), `군락이 강하 지점에서 ${SPORE_GROVE_SPAWN_GAP} m 이상 떨어져 있다 (${srcGap.map((d) => d.toFixed(0)).join(', ')} m)`);
    ok(sp.sources.length >= 1 && sp.sources.length <= SPORE_MAX, `발생지가 1~${SPORE_MAX}개 (${sp.sources.length})`);
    ok(sp.sources.every((s) => !s.erupted), '시작 전에는 아무 발생지도 피어오르지 않았다');
    ok(sp.near.every((n) => n >= 1), `군락마다 채집 가능한 버섯이 심어져 있다 (${JSON.stringify(sp.near)})`);
    const gap = Math.min(...sp.sources.map((a, i) => sp.sources.slice(i + 1)
      .map((b) => Math.hypot(a.x - b.x, a.z - b.z)).reduce((m, d) => Math.min(m, d), Infinity)));
    ok(!Number.isFinite(gap) || gap > 60, `군락끼리 떨어져 있다 (최소 간격 ${Number.isFinite(gap) ? gap.toFixed(0) : '—'} m)`);

    // They bloom one at a time (SPORE_SOURCE_INTERVAL_S apart)
    await P((a) => window.__seek(a + 1), SPORE_START);
    await waitSim(0.4);
    const first = await P(() => ({ z: window.__zones().length, e: window.__game.ctx.world.hazard.getSources().filter((s) => s.erupted).length }));
    ok(first.e === 1 && first.z === 1, `시작 시각에는 발생지 하나만 피어오른다 (erupted ${first.e} · zones ${first.z})`);
    await P((a) => window.__seek(a.at + a.iv + 2), { at: SPORE_START, iv: SPORE_INTERVAL });
    await waitSim(0.4);
    const second = await P(() => ({ z: window.__zones().length, e: window.__game.ctx.world.hazard.getSources().filter((s) => s.erupted).length }));
    ok(second.e === Math.min(2, sp.sources.length), `${SPORE_INTERVAL}초마다 하나씩 더 피어오른다 (erupted ${second.e})`);
    ok(second.z === second.e, `피어오른 발생지 수 = 도형 수 (${second.z})`);
    ok(second.z >= 1 && (await P(() => window.__zones())).every((z) => z.shape === 'circle' && z.safeInside === false),
      '독성 포자 = 안이 위험한 원 여럿');

    // Run to the end and it covers the whole map
    await P((a) => window.__seek(a.at + a.full + 5), { at: SPORE_START, full: FULL_S });
    await waitSim(0.4);
    ok(await P(() => window.__safeCount(16, 320)) === 0, '독성 포자도 끝까지 가면 안전지대가 없다');

    // Clearing the fog reveals the sources in advance + fog:discovered {kind:'grove'}
    await P(() => { window.__clear(); });
    const disc = await P(() => {
      const ctx = window.__game.ctx;
      const fog = ctx.world.fog;
      const src = ctx.world.hazard.getSources();
      for (const s of src) fog.reveal(s.position.x, s.position.z, 40);
      return src.length;
    });
    await waitSim(1.2);
    const groveEv = await P(() => window.__ev['fog:discovered'].filter((e) => e.kind === 'grove'));
    ok(groveEv.length >= 1, `군락이 안개 밖으로 나오면 fog:discovered {kind:'grove'} (${groveEv.length} / ${disc})`);
    ok(await P(() => window.__game.ctx.world.hazard.getSources().every((s) => s.discovered)),
      '군락을 다 발견하면 발생지가 전부 discovered 다 (= 어디서 시작될지 미리 안다)');
  }

  /* ── 7b. Extraction pads (2026-09-13 — threat 2 = 2 · 3 = 1–2) ─────── */
  console.log('탈출 패드 수 (행성 threat)');
  for (const [planet, lo, hi] of [['tundra', 2, 2], ['ashen', 1, 2]]) {
    await newMission(41, planet);
    const n = await P(() => window.__game.ctx.world.getExtractionPoints().length);
    ok(n >= lo && n <= hi, `${planet}: 탈출 패드 ${lo}~${hi}개 (${n})`);
  }

  /* ── 8. The training range · the mission reset ──────────────────── */
  console.log('훈련장 · 미션 리셋');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 25000);
  await P(() => window.__mission(7, null, 'training'));
  await waitFor(page, () => window.__game.ctx.phase === 'playing' || window.__game.ctx.phase === 'deploying', 'training', 30000);
  await waitSim(0.6);
  ok(await P(() => window.__game.ctx.world.hazard === null), '훈련장에는 재해가 없다 (hazard = null)');

  await P(() => { window.__game.ctx.missionMode = 'raid'; window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }); });
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub', 25000);
  await P(() => { window.__clear(); window.__game.ctx.bus.emit('game:abort', {}); });
  await waitSim(0.4);
  ok(await P(() => window.__game.ctx.world.hazard === null), '미션 리셋이 재해를 비운다');

  const gameErrors = errors.filter((e) => !/WebSocket/.test(e));
  ok(gameErrors.length === 0, `no console errors (${gameErrors.length}; ${errors.length - gameErrors.length} relay socket errors ignored)`, gameErrors.slice(0, 5).join(' | '));
  void EDGE_M; void MAP; void SPORE_MIN;
} catch (e) {
  fail++;
  console.log('  FAIL', e.message);
  if (errors.length) console.log('  console errors:', errors.slice(0, 5).join(' | '));
} finally {
  await closeBrowser(browser);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
