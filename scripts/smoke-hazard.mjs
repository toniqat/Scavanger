// 환경 재해 (src/world/Hazard.ts) 단독 스모크 — 릴레이 없이 싱글 플레이로 돈다.
// 검사: 행성 후보에서 시드로 뽑은 종류 · 30초 단위 시작 시각, 시작 전에는 도형이 없다는 것,
//       예고 → 시작 → 진행도(발행 빈도 상한), front 의 "법선 반대편이 위험" 규약, 끝까지 갔을 때
//       맵 전체가 위험해지는 것, 구역 안에서의 초당 피해 · hazard:insideChanged · atmo:override,
//       독성 포자의 거대 버섯 군락(발생지 · 채집 버섯 · fog:discovered 'grove'), 훈련장 게이트, 미션 리셋.
// Usage: node scripts/smoke-hazard.mjs [http://localhost:5273]   (needs a running vite; agents use a private port)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('no chrome/edge found'); process.exit(2); }
const GL_ARGS = process.env.SMOKE_GL === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=d3d11', '--enable-gpu'];

// 계약 값 (data/constants.csv · data/planets.csv) — 브라우저 안에서 상수를 import 할 수 없으니 옮겨 적는다
const START_MIN = 360, START_MAX = 480, START_STEP = 30;
const WARN_S = 30, DPS = 1, TICK_S = 1, FULL_S = 420, EDGE_M = 12;
// 2026-09-10: 시야 제한의 세기는 재해마다 다르다 (data/hazards.csv 의 fogMul) — 폭풍의 눈만 훨씬 짙다
const FOG_MUL = { sandstorm: 7, blizzard: 7, storm_eye: 24, spores: 7 };
const EYE_START = 300, EYE_END = 60;
const SPORE_START = 360, SPORE_INTERVAL = 50, SPORE_MIN = 3, SPORE_MAX = 6;
const MAP = 640;
// 행성별 후보 (data/planets.csv 의 hazards 열)
const AMBER = ['sandstorm', 'storm_eye'];       // 아켈론 II
const MOSSY = ['spores', 'storm_eye'];          // 베르단트 III

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
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws\?/.test(String(args[0]))) return new QuietSocket(args[0]);
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
    /** 미션 하나 (emitter 규약: ctx 먼저, 그다음 emit). */
    window.__mission = (seed, planet, mode) => {
      const ctx = window.__game.ctx;
      ctx.missionPlanet = planet ?? null;
      ctx.missionMode = mode ?? 'raid';
      const ev = { seed };
      if (mode) ev.mode = mode;
      if (planet) ev.planet = planet;
      ctx.bus.emit('game:newMission', ev);
    };
    /** 재해를 `t` 초로 감는다 (`missionTime` 은 평범한 필드다). 한 프레임 뒤에 상태가 갱신된다. */
    window.__seek = (t) => { window.__game.ctx.missionTime = t; };
    /** 지금 도형의 요약 (`getZones()` 는 배열을 재사용하므로 즉시 복사한다). */
    window.__zones = () => (window.__game.ctx.world.hazard?.getZones() ?? []).map((z) => ({
      id: z.id, shape: z.shape, cx: z.center.x, cz: z.center.z, r: z.radius,
      dx: z.dirX, dz: z.dirZ, safeInside: z.safeInside,
    }));
    window.__hz = () => {
      const h = window.__game.ctx.world.hazard;
      return h ? { kind: h.kind, startsAt: h.startsAt, announced: h.announced, active: h.active, progress: h.progress } : null;
    };
    /** 맵 전체를 격자로 훑어 위험하지 않은 표본 수를 센다. */
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

  /* ── 1. 계획 (아켈론 II) ───────────────────────────────────────────────── */
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

  /* ── 2. 결정성 ─────────────────────────────────────────────────────────── */
  console.log('결정성 (같은 시드 · 같은 행성)');
  await newMission(21, 'amber');
  const h0b = await P(() => window.__hz());
  ok(h0b && h0b.kind === h0.kind && h0b.startsAt === h0.startsAt,
    `같은 시드는 같은 계획을 낸다 (${h0.kind}@${h0.startsAt} vs ${h0b && h0b.kind}@${h0b && h0b.startsAt})`);

  /* ── 3. 예고 → 시작 → 진행도 ───────────────────────────────────────────── */
  console.log('예고 → 시작 → 진행도');
  // `WARN_S` 는 Node 쪽 상수다 — page.evaluate 콜백은 브라우저에서 돌아 그 스코프를 못 본다. 인자로 넘긴다.
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

  /* ── 4. 도형 규약 ──────────────────────────────────────────────────────── */
  console.log('도형 규약');
  const mid = await P((a) => { window.__seek(a.at + a.full * 0.5); return null; }, { at: h0.startsAt, full: FULL_S }) ?? await P(() => window.__zones());
  await waitSim(0.3);
  const zs = await P(() => window.__zones());
  if (h0.kind === 'storm_eye') {
    ok(zs.length === 1 && zs[0].shape === 'circle' && zs[0].safeInside === true, `폭풍의 눈 = 안이 안전한 원 하나 (${JSON.stringify(zs)})`);
    const midR = (EYE_START + EYE_END) / 2;
    ok(Math.abs(zs[0].r - midR) < 6, `반경이 ${EYE_START}→${EYE_END} 로 선형 축소한다 (중간 ${zs[0].r.toFixed(1)} / ${midR})`);
    const inside = await P((z) => window.__game.ctx.world.hazard.isInside(z.cx, z.cz), zs[0]);
    const outside = await P((z) => window.__game.ctx.world.hazard.isInside(z.cx + z.r + 40, z.cz), zs[0]);
    ok(inside === false && outside === true, `눈 안은 안전 · 밖은 위험 (안 ${inside} / 밖 ${outside})`);
  } else {
    ok(zs.length === 1 && zs[0].shape === 'front', `직선 잠식 = front 하나 (${JSON.stringify(zs)})`);
    const z = zs[0];
    const sides = await P((a) => {
      const h = window.__game.ctx.world.hazard;
      return {
        behind: h.isInside(a.cx - a.dx * 60, a.cz - a.dz * 60),   // 이미 지나온 쪽
        ahead: h.isInside(a.cx + a.dx * 60, a.cz + a.dz * 60),    // 아직 오지 않은 쪽
      };
    }, z);
    ok(sides.behind === true && sides.ahead === false, `법선 반대편(지나온 쪽)이 위험이다 (뒤 ${sides.behind} / 앞 ${sides.ahead})`);
    ok(Math.abs(Math.hypot(z.dx, z.dz) - 1) < 1e-6, '진행 방향이 단위 벡터다');
  }
  void mid;

  /* ── 5. 끝까지 = 안전지대 없음 ────────────────────────────────────────── */
  console.log('끝까지 진행');
  await P((a) => window.__seek(a.at + a.full + 5), { at: h0.startsAt, full: FULL_S });
  await waitSim(0.4);
  const hzFull = await P(() => window.__hz());
  ok(Math.abs(hzFull.progress - 1) < 1e-6, `progress 가 1 에서 멈춘다 (${hzFull.progress})`);
  const safe = await P(() => window.__safeCount(16, 320));
  if (h0.kind === 'storm_eye') {
    // 눈은 계약 상수대로 `STORM_EYE_RADIUS_END` 만큼 남는다 — 640 m 맵의 2.8 % 다 (사실상 강제 탈출)
    const share = safe / (17 * 17);
    ok(share < 0.05, `폭풍의 눈만 ${EYE_END} m 짜리 눈이 남는다 (안전 표본 ${safe}/${17 * 17} = ${(share * 100).toFixed(1)}%)`);
    const rz = (await P(() => window.__zones()))[0];
    ok(Math.abs(rz.r - EYE_END) < 0.01, `마지막 반경 = STORM_EYE_RADIUS_END (${rz.r.toFixed(2)})`);
  } else {
    ok(safe === 0, `맵 전체가 위험 구역이다 — 안전지대 0 (안전 표본 ${safe}/${17 * 17})`);
  }

  /* ── 6. 피해 · 시야 ────────────────────────────────────────────────────── */
  console.log('피해 · 시야 (구역 안으로 이동)');
  /* 앞 절(5)이 이미 `startsAt + FULL_S + 5` 까지 감아 둬서 플레이어는 **이미 구역 안**이다. `__clear()` 는
     기록만 지우고 Hazard 의 "안에 있었다" 는 내부 에지 상태와 마지막 `atmo:override` 값은 그대로라, 그
     상태에서 곧장 안으로 들여보내면 **변화가 없어 아무 이벤트도 안 나간다** (2026-09-09: `isInside` 는 true 인데
     `hazard:insideChanged` 가 빈 배열이던 원인이 이것이었다). 그래서 재해 **시작 전**으로 한 번 되감아
     밖 상태로 가라앉힌 다음에 들어간다. */
  await P((a) => window.__seek(Math.max(0, a - 60)), h0.startsAt);
  await waitSim(0.8);
  await P((a) => {
    const ctx = window.__game.ctx;
    window.__clear();
    ctx.missionTime = a.at + a.full + 5;   // 맵 전체(폭풍의 눈이면 눈 밖)가 위험한 시점
    const h = ctx.world.hazard;
    const p = ctx.player;
    let x = p.position.x, z = p.position.z;
    if (!h.isInside(x, z)) {
      const zs = h.getZones();
      const c = zs[0];
      /* 눈 밖으로 — 다만 **맵 안에** 남아야 한다. 중심이 맵 가장자리 쪽이면 `+ radius + 90` 이 경계를 넘고,
         `respawnAt` 이 맵 밖 좌표를 스폰 지점으로 되돌려 버려 (Spawn.restoreState 와 같은 보정) 플레이어가
         안전지대 안에 그대로 남는다 — 그러면 이 검사는 재해가 아니라 좌표 때문에 실패한다. (2026-09-09) */
      const lim = a.map / 2 - 20;
      const out = c.radius + 20;
      const dir = c.center.x > 0 ? -1 : 1;               // 맵 중앙을 향해 밀어낸다
      x = Math.max(-lim, Math.min(lim, c.center.x + dir * out));
      z = Math.max(-lim, Math.min(lim, c.center.z));
      if (h.isInside(x, z) === false) { x = Math.max(-lim, Math.min(lim, c.center.x - dir * out)); }
    }
    p.respawnAt(new p.position.constructor(x, ctx.world.getHeightAt(x, z), z));
    window.__hp0 = p.hp;
  }, { at: h0.startsAt, full: FULL_S, map: MAP });
  await waitSim(0.6);
  const insideEv = await P(() => window.__ev['hazard:insideChanged']);
  /* 실패하면 왜인지 알 수 있게 재해 · 플레이어 상태를 함께 찍는다 — 빈 배열만으로는 원인을 못 좁힌다. */
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
  const fogCap = FOG_MUL[h0.kind] ?? 7;
  ok(!!last && last.blend > 0 && last.fogMul > 1 && last.fogMul <= fogCap + 1e-6 && last.color !== null,
    `atmo:override 로만 시야를 좁힌다 (${h0.kind} 상한 ${fogCap}, ${JSON.stringify(last)})`);
  ok(atmo.length <= 40, `atmo:override 를 프레임마다 쏘지 않는다 (0.6초에 ${atmo.length}회)`);
  await waitSim(3.4);
  const dmg = await P(() => ({ hp: window.__game.ctx.player.hp, hp0: window.__hp0 }));
  const lost = dmg.hp0 - dmg.hp;
  ok(lost >= DPS * 2 && lost <= DPS * 6, `HAZARD_TICK_S(${TICK_S}s) 마다 ${DPS} 씩 깎인다 (4초에 ${lost.toFixed(1)})`);

  console.log('구역 밖으로');
  await P(() => {
    const ctx = window.__game.ctx;
    window.__clear();
    ctx.missionTime = 5;                    // 아직 시작 전 = 위험 구역이 없다
  });
  await waitSim(0.6);
  const outEv = await P(() => window.__ev['hazard:insideChanged']);
  ok(outEv.length === 1 && outEv[0].inside === false && outEv[0].kind === null,
    `나오면 hazard:insideChanged {inside:false, kind:null} 가 한 번 (${JSON.stringify(outEv)})`);
  const atmoOut = (await P(() => window.__ev['atmo:override'])).pop();
  ok(!!atmoOut && atmoOut.blend === 0 && atmoOut.fogMul === 1 && atmoOut.color === null,
    `나오면 대기 오버라이드가 원래대로 (${JSON.stringify(atmoOut)})`);

  /* ── 7. 독성 포자 · 거대 버섯 군락 (베르단트 III) ──────────────────────── */
  console.log('독성 포자 · 거대 버섯 군락 (베르단트 III)');
  let sporeSeed = -1;
  for (const seed of [3, 7, 11, 19, 23, 29, 31, 37]) {
    await newMission(seed, 'mossy');
    const k = await P(() => window.__hz());
    ok(k && MOSSY.includes(k.kind), `seed ${seed}: 후보 안에서 뽑혔다 (${k && k.kind})`);
    if (k && k.kind === 'spores') { sporeSeed = seed; break; }
  }
  if (sporeSeed < 0) {
    fail++;
    console.log('  FAIL 8개 시드 안에 독성 포자가 한 번도 안 나왔다 (후보 추첨이 한쪽으로 쏠렸다)');
  } else {
    const sp = await P(() => {
      const h = window.__game.ctx.world.hazard;
      const src = h.getSources();
      const nodes = window.__game.ctx.world.getGatherNodes();
      const near = src.map((s) => nodes.filter((n) => n.kind !== 'salvage'
        && Math.hypot(n.position.x - s.position.x, n.position.z - s.position.z) < 16).length);
      return {
        kind: h.kind, startsAt: h.startsAt,
        sources: src.map((s) => ({ id: s.id, x: s.position.x, z: s.position.z, r: s.radius, erupted: s.erupted, discovered: s.discovered })),
        near,
      };
    });
    ok(sp.startsAt === SPORE_START, `독성 포자만 시작 시각이 ${SPORE_START}s 고정이다 (${sp.startsAt})`);
    ok(sp.sources.length >= 1 && sp.sources.length <= SPORE_MAX, `발생지가 1~${SPORE_MAX}개 (${sp.sources.length})`);
    ok(sp.sources.every((s) => !s.erupted), '시작 전에는 아무 발생지도 피어오르지 않았다');
    ok(sp.near.every((n) => n >= 1), `군락마다 채집 가능한 버섯이 심어져 있다 (${JSON.stringify(sp.near)})`);
    const gap = Math.min(...sp.sources.map((a, i) => sp.sources.slice(i + 1)
      .map((b) => Math.hypot(a.x - b.x, a.z - b.z)).reduce((m, d) => Math.min(m, d), Infinity)));
    ok(!Number.isFinite(gap) || gap > 60, `군락끼리 떨어져 있다 (최소 간격 ${Number.isFinite(gap) ? gap.toFixed(0) : '—'} m)`);

    // 하나씩 피어오른다 (SPORE_SOURCE_INTERVAL_S 간격)
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

    // 끝까지 가면 맵 전체
    await P((a) => window.__seek(a.at + a.full + 5), { at: SPORE_START, full: FULL_S });
    await waitSim(0.4);
    ok(await P(() => window.__safeCount(16, 320)) === 0, '독성 포자도 끝까지 가면 안전지대가 없다');

    // 안개를 걷으면 발생지를 미리 안다 + fog:discovered {kind:'grove'}
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

  /* ── 8. 훈련장 · 미션 리셋 ─────────────────────────────────────────────── */
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
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
