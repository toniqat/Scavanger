// Smoke test for 행성 선택 (Phase 11 §3-3, hub folder, 2026-09-07) — **solo path only**; the lobby path
// (host picks / guest mirrors / non-host refusal) is `npm run e2e:mp`'s.
//
// Covers: the full-screen terminal (three columns, the 승무원 이름 section gone, `.seed-hint` kept, `닫기 (Esc)`,
// `hub:terminalToggled`, Phase 10 cursor etiquette), the 행성 홀로그램 canvas + its ◀ ▶ / arrow / A-D stepping
// (preview only — `ctx.hub.planet` does not move), 행성 이동 → `hub:travel start` → the warp cutscene →
// `hub:travel end` + `hub:planetChanged`, the window planet re-tinted to the destination, `PLANET_STORAGE_KEY`
// persistence across a reload, the terminal screen's `목표 <행성>` line, `setPlanet` refusals, the launch-slot gate
// (prompt + refusal while 목표 미지정, boarding allowed after) and `game:newMission {planet}` / `ctx.missionPlanet`.
//
// Usage: node scripts/smoke-planets.mjs [http://localhost:5299/]   (needs a vite instance, no relay required)
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5273/';
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
async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch (e) { /* loading */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** The five planets, in `PLANET_IDS` order (kept in step with `src/shared/planets.ts` by the checks below). */
const PLANETS = [
  { id: 'amber', name: '아켈론 II', terrain: '호박빛 사막', threat: 1, hologram: 0xb89a68 },
  { id: 'tundra', name: '보레아스 IX', terrain: '동토 툰드라', threat: 2, hologram: 0xcbd0cc },
  { id: 'mossy', name: '베르단트 III', terrain: '이끼 습지', threat: 2, hologram: 0x66683c },
  { id: 'ashen', name: '피로스 VII', terrain: '잿빛 화산지대', threat: 3, hologram: 0x4c4c4e },
  { id: 'crimson', name: '카민 I', terrain: '적색 외계 평원', threat: 3, hologram: 0x8e3c4c },
];
const THREAT_LABELS = ['', '위협 낮음', '위협 보통', '위협 높음'];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=angle', ...GL_ARGS, '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1600,900', '--no-sandbox'],
});
const errors = [];
try {
  const page = (await browser.pages())[0] ?? await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.evaluateOnNewDocument(() => {
    Element.prototype.requestPointerLock = function () { return Promise.resolve(); };
    Document.prototype.exitPointerLock = function () {};
    // Park vite's HMR socket AND the relay socket: this script is the solo path, a real relay must not hand us a lobby.
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr') || /\/ws(\?|$)/.test(String(args[0]))) return new QuietSocket(args[0]);
        return new target(...args);
      },
    });
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /** Boot (or re-boot) the page with a driven frame loop and the event taps installed. */
  const boot = async (label) => {
    await page.goto(BASE, { waitUntil: 'load' });
    await waitFor(page, () => !!window.__game && !!window.__game.ctx.hub, `boot (${label})`);
    await page.evaluate(() => {
      let lastRaf = performance.now();
      (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
      setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
      const canvas = document.getElementById('game-canvas');
      Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => canvas, configurable: true });
      window.__ev = {};
      const bus = window.__game.ctx.bus;
      for (const n of ['hub:entered', 'hub:left', 'hub:travel', 'hub:planetChanged', 'hub:terminalToggled',
        'ui:hubMenuToggled', 'ui:notify', 'game:newMission', 'world:ready', 'hub:launchCountdown']) {
        window.__ev[n] = [];
        bus.on(n, (p) => { window.__ev[n].push(JSON.parse(JSON.stringify(p, (k, v) => (v && v.isVector3) ? [v.x, v.y, v.z] : v))); });
      }
    });
  };
  const P = (fn, arg) => page.evaluate(fn, arg);
  const tap = (code) => page.evaluate((c) => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: c, key: c, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: c, key: c, bubbles: true }));
  }, code);
  // headless rendering runs at a few fps and dt is clamped to 50 ms: wait on simulation time, not wall time
  const waitSim = async (sec) => { const t0 = await P(() => window.__game.ctx.time); await waitFor(page, (t) => window.__game.ctx.time >= t, `sim +${sec}s`, 180000, t0 + sec); };
  const ev = (n) => P((k) => window.__ev[k], n);
  const lastEv = async (n) => { const a = await ev(n); return a[a.length - 1]; };
  const screenText = () => P(() => window.__game.getSystem('hub').terminal?.def.screen.last ?? '');
  const openTerminal = async () => {
    await P(() => window.__game.ctx.interactables.all().find((i) => i.id === 'hub_terminal').interact());
    await waitFor(page, () => !document.querySelector('.menu.hub-menu').hidden, 'terminal open');
    await waitSim(0.15);
  };
  const clickSel = (sel) => P((s) => {
    const b = document.querySelector(s);
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }, sel);
  const planetCard = () => P(() => ({
    name: document.querySelector('.hp-name')?.textContent ?? null,
    terrain: document.querySelector('.hp-terrain')?.textContent ?? null,
    threat: document.querySelector('.hp-threat')?.textContent ?? null,
    threatLv: document.querySelector('.hp-threat')?.dataset.threat ?? null,
    brief: document.querySelector('.hp-brief')?.textContent ?? null,
    dots: [...document.querySelectorAll('.hp-dots i')].map((d) => `${d.dataset.planet}${d.classList.contains('on') ? '*' : ''}${d.classList.contains('here') ? '!' : ''}`),
    travel: document.querySelector('.ui-btn.hp-travel')?.textContent ?? null,
    travelOff: document.querySelector('.ui-btn.hp-travel')?.disabled ?? null,
    current: document.querySelector('.hp-current')?.hidden ?? null,
    hubPlanet: window.__game.ctx.hub.planet,
  }));

  /* ── 1. 목표 미지정: state, terminal screen, launch-slot gate ─────────── */
  console.log('목표 미지정');
  await boot('fresh');
  await page.evaluate(() => { try { localStorage.removeItem('scav.planet'); } catch {} });
  await boot('no planet');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase');
  await waitSim(0.3);
  const s0 = await P(() => ({ planet: window.__game.ctx.hub.planet, travelling: window.__game.ctx.hub.travelling, mission: window.__game.ctx.missionPlanet }));
  ok(s0.planet === null, `fresh profile has no 목표 행성 (${s0.planet})`);
  ok(s0.travelling === false, 'ctx.hub.travelling false in the ship');
  ok(s0.mission === null, `ctx.missionPlanet starts null (${s0.mission})`);
  ok((await screenText()).includes('목표 목표 미지정'), `terminal screen reads 목표 미지정 (${(await screenText()).split('\n').join(' / ')})`);
  const pod0 = await P(() => {
    const ctx = window.__game.ctx;
    const it = ctx.interactables.all().find((i) => i.id === 'hub_pod_0');
    const n0 = window.__ev['ui:notify'].length;
    const prompt = it?.getPrompt() ?? null;
    const can = it?.canInteract() ?? null;
    it?.interact();
    return { prompt, can, inPod: ctx.player.isInPod, notes: window.__ev['ui:notify'].slice(n0).map((n) => n.text) };
  });
  ok(pod0.prompt === '목표 행성 미지정 — 터미널에서 지정', `pod prompt "${pod0.prompt}"`);
  ok(pod0.can === true, 'the pod stays interactable so the prompt (and the reason) is visible at all');
  ok(!pod0.inPod && pod0.notes.some((t) => /목표 행성이 없습니다/.test(t)), `boarding refused with a notice (${pod0.notes.join(' | ')})`);
  const noLaunch = await P(() => window.__game.ctx.player.isInPod);
  ok(noLaunch === false, 'no launch countdown can start while 목표 미지정');

  /* ── 2. the full-screen terminal ─────────────────────────────────────── */
  console.log('전체화면 터미널');
  await openTerminal();
  const term = await P(() => {
    const root = document.querySelector('.menu.hub-menu');
    const f = root.querySelector('.frame');
    const r = f.getBoundingClientRect();
    const secLabel = (t) => [...document.querySelectorAll('.menu.hub-menu .hub-section')].find((s) => s.querySelector('.ui-label')?.textContent === t);
    const sig = secLabel('신호'), ship = secLabel('공유 함선'), train = secLabel('시뮬레이션 훈련장');
    return {
      full: root.classList.contains('fullscreen'),
      w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
      sw: f.scrollWidth, cw: f.clientWidth, sh: f.scrollHeight, ch: f.clientHeight,
      cols: document.querySelectorAll('.menu.hub-menu .hub-col').length,
      sigIn: sig?.closest('.hub-col')?.classList.contains('left') ?? null,
      sigHidden: sig?.hidden ?? null,
      shipHidden: ship?.hidden ?? null,
      trainIn: train?.closest('.hub-col')?.classList.contains('right') ?? null,
      planetIn: document.querySelector('.hub-planet')?.closest('.hub-col')?.classList.contains('centre') ?? null,
      crewName: document.querySelectorAll('.hub-crew-name').length,
      nameInput: [...document.querySelectorAll('.menu.hub-menu input')].filter((i) => i.placeholder === '호출명').length,
      seedHint: document.querySelector('.menu.hub-menu .seed-hint')?.textContent ?? null,
      closeBtn: [...document.querySelectorAll('.hub-foot .ui-btn')].map((b) => b.textContent),
      blocker: window.__game.ctx.uiBlockers.has('hub'),
      cursor: window.__game.ctx.input.isCursorMode,
      locked: !!document.pointerLockElement,
    };
  });
  ok(term.full, 'root carries .fullscreen');
  ok(term.w >= term.vw - 2 && term.h >= term.vh - 2, `the frame fills the viewport (${term.w}×${term.h} of ${term.vw}×${term.vh})`);
  ok(term.sw <= term.cw && term.sh <= term.ch, `the frame still has no scroll overflow (${term.sw}/${term.cw} × ${term.sh}/${term.ch})`);
  ok(term.cols === 3, `three columns (${term.cols})`);
  ok(term.sigIn === true && term.sigHidden === false, '신호 section in the left column, shown in the personal ship');
  ok(term.shipHidden === true, '공유 함선 section hidden without a lobby');
  ok(term.trainIn === true, '시뮬레이션 훈련장 section in the right column');
  ok(term.planetIn === true, '행성 카드 in the centre column');
  ok(term.crewName === 0 && term.nameInput === 0, `the 승무원 이름 section is gone (${term.crewName} label / ${term.nameInput} input)`);
  ok(/\/seed/.test(term.seedHint ?? ''), `.seed-hint kept ("${(term.seedHint ?? '').slice(0, 28)}…")`);
  ok(term.closeBtn.includes('닫기 (Esc)') && term.closeBtn.includes('타이틀로'), `footer: ${term.closeBtn.join(' / ')}`);
  ok(term.blocker && term.cursor === true, `the 'hub' blocker + software cursor (Phase 10 etiquette, cursor ${term.cursor})`);
  ok(term.locked === true, 'the pointer lock is kept (no exitPointerLock)');
  const tog = await lastEv('hub:terminalToggled');
  ok(tog && tog.open === true, `hub:terminalToggled {open:true} (${JSON.stringify(tog)})`);
  ok((await ev('ui:hubMenuToggled')).slice(-1)[0]?.open === true, 'the legacy ui:hubMenuToggled still fires');

  /* ── 3. the hologram + ◀ ▶ / arrows / A-D ────────────────────────────── */
  console.log('행성 홀로그램');
  const holo = await P(() => {
    const host = document.querySelector('.hp-holo');
    const c = host?.querySelector('canvas');
    const r = c?.getBoundingClientRect();
    return {
      canvas: !!c, cls: c?.className ?? null,
      w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      gl: !!c && !!c.getContext && true,
      noHolo: document.querySelector('.menu.hub-menu').classList.contains('no-holo'),
      arrows: document.querySelectorAll('.ui-btn.hp-arrow').length,
    };
  });
  ok(holo.canvas && holo.cls === 'planet-canvas', 'the hologram built its own WebGL canvas');
  ok(!holo.noHolo, 'no .no-holo fallback (a second GL context was available)');
  ok(holo.w > 100 && Math.abs(holo.w - holo.h) <= 2, `the canvas is square (${holo.w}×${holo.h})`);
  ok(holo.arrows === 2, `◀ ▶ buttons present (${holo.arrows})`);
  const c0 = await planetCard();
  ok(c0.name === PLANETS[0].name, `목표 미지정 previews the first planet (${c0.name})`);
  ok(c0.terrain === PLANETS[0].terrain, `지형 line "${c0.terrain}"`);
  ok(c0.threat === THREAT_LABELS[PLANETS[0].threat] && c0.threatLv === '1', `위협 badge "${c0.threat}" (lv ${c0.threatLv})`);
  ok((c0.brief ?? '').length > 10, `one-line brief ("${(c0.brief ?? '').slice(0, 18)}…")`);
  ok(c0.dots.length === 5 && c0.dots[0].includes('*') && !c0.dots.some((d) => d.includes('!')), `5 dots, cursor on the first, none marked current (${c0.dots.join(' ')})`);
  ok(c0.travelOff === false && (c0.travel ?? '').includes(PLANETS[0].name), `행성 이동 enabled ("${c0.travel}")`);
  ok(c0.current === true, 'the 현재 목표 tag is hidden while nothing is picked');

  await clickSel('.ui-btn.hp-arrow.next');
  await waitSim(0.1);
  const c1 = await planetCard();
  ok(c1.name === PLANETS[1].name && c1.dots[1].includes('*'), `▶ steps to ${c1.name}`);
  ok(c1.threatLv === String(PLANETS[1].threat), `위협 badge follows (lv ${c1.threatLv})`);
  await tap('ArrowRight');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[2].name, '→ key steps right');
  await tap('KeyA');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[1].name, 'A key steps left');
  await tap('ArrowLeft');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[0].name, '← key steps left');
  await clickSel('.ui-btn.hp-arrow.prev');
  await waitSim(0.1);
  const cw = await planetCard();
  ok(cw.name === PLANETS[4].name, `◀ wraps around to ${cw.name}`);
  ok(cw.hubPlanet === null, 'stepping only previews — ctx.hub.planet is still null');
  ok((await ev('hub:travel')).length === 0, 'no hub:travel while only previewing');
  // back to 베르단트 III for the trip
  await tap('ArrowRight'); await tap('ArrowRight'); await tap('ArrowRight');
  await waitSim(0.1);
  ok((await planetCard()).name === PLANETS[2].name, `previewing ${PLANETS[2].name} for the trip`);

  /* ── 4. 행성 이동: the warp cutscene ─────────────────────────────────── */
  console.log('행성 이동');
  const glow = () => P(() => {
    const g = window.__game.ctx.scene.getObjectByName('PersonalShip');
    let hex = null;
    g?.traverse((o) => { if (o.name === 'HubPlanetBody' && hex === null) hex = o.material.color.getHex(); });
    return hex;
  });
  const beforeHex = await glow();
  ok(typeof beforeHex === 'number', `the window planet is readable (0x${(beforeHex ?? 0).toString(16)})`);
  await clickSel('.ui-btn.hp-travel');
  await waitFor(page, () => window.__game.ctx.hub.travelling === true, 'travelling');
  await waitSim(0.2);   // the status line is written by the next `HubSystem.update` frame, not by `startTravel`
  const t1 = await P(() => {
    const ctx = window.__game.ctx;
    const cut = ctx.scene.getObjectByName('DockingCutscene');
    let streaks = false, dest = 0;
    cut?.traverse((o) => { if (o.name === 'HubWarpStreaks') streaks = true; if (o.name === 'HubPlanet') dest++; });
    return {
      start: window.__ev['hub:travel'].slice(-1)[0] ?? null,
      menuHidden: document.querySelector('.menu.hub-menu').hidden,
      blocker: ctx.uiBlockers.has('hub'), cursor: ctx.input.isCursorMode,
      phase: ctx.phase, cut: !!cut, streaks, dest,
      interior: !!ctx.hub.collider && !!ctx.player.interior,
      status: document.querySelector('.hub-status')?.textContent ?? '',
      podCan: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.canInteract() ?? null,
    };
  });
  ok(t1.start && t1.start.stage === 'start' && t1.start.planet === PLANETS[2].id, `hub:travel {stage:'start', planet:'${t1.start?.planet}'}`);
  ok(t1.menuHidden && !t1.blocker && t1.cursor === false, 'the terminal closed itself and released the blocker / cursor');
  ok(t1.phase === 'hub', `the phase stays 'hub' during a planet change (${t1.phase})`);
  ok(t1.cut && t1.streaks, 'the warp cutscene is in the scene with its WarpStreaks layer');
  ok(t1.dest === 1, `the destination sphere is built once (${t1.dest})`);
  ok(t1.interior, 'the ship interior was NOT rebuilt (collider + player interior kept)');
  ok(/항로 이동 중/.test(t1.status), `status line "${t1.status.trim().slice(0, 30)}"`);
  ok(t1.podCan === false, 'launch slots are unavailable while travelling');
  const refused = await P(() => ({
    same: window.__game.ctx.hub.setPlanet('mossy'),
    other: window.__game.ctx.hub.setPlanet('ashen'),
  }));
  ok(refused.other === false, 'setPlanet is refused while travelling');
  await waitSim(5.2);
  await waitFor(page, () => window.__game.ctx.hub.travelling === false, 'travel finished');
  await waitSim(0.3);
  const t2 = await P(() => {
    const ctx = window.__game.ctx;
    return {
      travel: window.__ev['hub:travel'].slice(-1)[0] ?? null,
      changed: window.__ev['hub:planetChanged'].slice(-1)[0] ?? null,
      planet: ctx.hub.planet, travelling: ctx.hub.travelling,
      cut: !!ctx.scene.getObjectByName('DockingCutscene'),
      controls: ctx.player.controlsEnabled !== false,
      stored: (() => { try { return localStorage.getItem('scav.planet'); } catch { return null; } })(),
      podPrompt: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.getPrompt() ?? null,
      podCan: ctx.interactables.all().find((i) => i.id === 'hub_pod_0')?.canInteract() ?? null,
    };
  });
  ok(t2.travel && t2.travel.stage === 'end' && t2.travel.planet === PLANETS[2].id, `hub:travel {stage:'end'} (${JSON.stringify(t2.travel)})`);
  ok(t2.changed && t2.changed.planet === PLANETS[2].id && t2.changed.by === 'local', `hub:planetChanged {by:'local'} (${JSON.stringify(t2.changed)})`);
  ok(t2.planet === PLANETS[2].id && t2.travelling === false, `ctx.hub.planet = ${t2.planet}, travelling false`);
  ok(!t2.cut, 'the cutscene disposed itself');
  ok(t2.controls, 'controls handed back');
  ok(t2.stored === PLANETS[2].id, `the pick is persisted in scav.planet (${t2.stored})`);
  ok((await glow()) === PLANETS[2].hologram, `the window planet took the destination colour (0x${(await glow()).toString(16)})`);
  ok((await screenText()).includes(`목표 ${PLANETS[2].name}`), `terminal screen reads 목표 ${PLANETS[2].name}`);
  ok(t2.podPrompt === '발사 슬롯 탑승' && t2.podCan === true, `the launch slot opened up ("${t2.podPrompt}")`);

  /* ── 4b. 출격 준비 경고 (2026-09-08) ──────────────────────────────────────
   * 기본 지급품에는 주무기가 없으므로 슬롯에 타려 하면 경고 카드가 먼저 뜬다. 막지는 않는다 —
   * 확인하면 그대로 타고, 같은 조합에 대해서는 두 번 묻지 않는다.
   * 솔로에서는 탑승만으로 발사 카운트다운이 시작되므로 탑승 검사는 전부 **한 evaluate 안에서** 끝내고
   * 곧바로 내린다 (프레임이 사이에 돌지 않는다). */
  console.log('출격 준비 경고');
  const warnIds = await P(() => window.__game.ctx.inventory.getLaunchWarnings().map((w) => w.id));
  ok(warnIds.includes('noPrimary'), `기본 지급품에는 주무기가 없어 경고가 잡힌다 (${warnIds.join(',')})`);
  const popped = await P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact();
    const root = document.querySelector('.menu.hub-menu.launch-warn');
    return {
      hidden: root?.hidden, rows: [...root.querySelectorAll('.lw-row')].map((r) => r.dataset.id),
      texts: [...root.querySelectorAll('.lw-row .nm')].map((e) => e.textContent),
      details: [...root.querySelectorAll('.lw-row .sub')].length,
      boarded: hub.boardedSlot, blocker: ctx.uiBlockers.has('hub'), cursor: ctx.input.isCursorMode,
    };
  });
  ok(popped.hidden === false && popped.boarded < 0, '탑승 시도 → 경고 카드가 뜨고 아직 타지 않는다', JSON.stringify({ hidden: popped.hidden, boarded: popped.boarded }));
  ok(popped.rows.join(',') === warnIds.join(',') && popped.details === popped.rows.length,
    `사유가 하나씩 전부 표시된다 (${popped.rows.join(',')})`, JSON.stringify(popped.texts));
  ok(popped.blocker && popped.cursor, '경고 카드가 hub 블로커 + 소프트 커서를 잡는다', JSON.stringify({ blocker: popped.blocker, cursor: popped.cursor }));
  const cancelled = await P(() => {
    const hub = window.__game.getSystem('hub');
    [...document.querySelectorAll('.launch-warn .hub-foot .ui-btn')].find((b) => b.textContent === '취소').click();
    return { hidden: document.querySelector('.launch-warn').hidden, boarded: hub.boardedSlot, ack: hub.launchWarnAck, blocker: window.__game.ctx.uiBlockers.has('hub') };
  });
  ok(cancelled.hidden && cancelled.boarded < 0 && cancelled.ack === '' && !cancelled.blocker, '취소하면 닫히고 타지 않으며 아무것도 기억하지 않는다', JSON.stringify(cancelled));
  const confirmed = await P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact();
    const reopened = document.querySelector('.launch-warn').hidden === false;
    [...document.querySelectorAll('.launch-warn .hub-foot .ui-btn')].find((b) => b.textContent === '그래도 출격').click();
    const out = { reopened, hidden: document.querySelector('.launch-warn').hidden, boarded: hub.boardedSlot, ack: hub.launchWarnAck, blocker: ctx.uiBlockers.has('hub') };
    hub.leavePod(true);   // 솔로에서는 탑승 = 발사 준비 — 프레임이 돌기 전에 내린다
    out.after = hub.boardedSlot;
    return out;
  });
  ok(confirmed.reopened, '취소한 뒤 다시 타려 하면 경고가 또 뜬다');
  ok(confirmed.hidden && confirmed.boarded === 0 && !confirmed.blocker && confirmed.after < 0,
    '그래도 출격 → 카드가 닫히고 그대로 탑승한다', JSON.stringify(confirmed));
  ok(confirmed.ack === warnIds.join(','), `같은 조합을 기억한다 (${confirmed.ack})`);
  const second = await P(() => {
    const ctx = window.__game.ctx, hub = window.__game.getSystem('hub');
    ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact();
    const out = { hidden: document.querySelector('.launch-warn').hidden, boarded: hub.boardedSlot };
    hub.leavePod(true);
    out.after = hub.boardedSlot;
    return out;
  });
  ok(second.hidden && second.boarded === 0 && second.after < 0, '한 번 넘긴 조합은 다시 묻지 않고 바로 탑승한다', JSON.stringify(second));

  /* ── 5. refusals + the terminal on a chosen planet ───────────────────── */
  console.log('거부 규칙');
  const ref2 = await P(() => ({
    same: window.__game.ctx.hub.setPlanet('mossy'),
    unknown: window.__game.ctx.hub.setPlanet('nowhere'),
    planet: window.__game.ctx.hub.planet,
  }));
  ok(ref2.same === false, 'setPlanet on the current planet is refused (the button reads 현재 목표)');
  ok(ref2.unknown === false && ref2.planet === PLANETS[2].id, 'an unknown planet id is refused and changes nothing');
  await openTerminal();
  const c2 = await planetCard();
  ok(c2.name === PLANETS[2].name && c2.travel === '현재 목표' && c2.travelOff === true, `reopening previews the ship's planet, button "${c2.travel}" disabled`);
  ok(c2.current === false && c2.dots[2].includes('!'), `the 현재 목표 tag and the dot marker point at ${PLANETS[2].name}`);
  await tap('Escape');
  await waitFor(page, () => document.querySelector('.menu.hub-menu').hidden, 'terminal closed');
  await waitSim(0.2);
  const closed = await P(() => ({
    tog: window.__ev['hub:terminalToggled'].slice(-1)[0] ?? null,
    cursor: window.__game.ctx.input.isCursorMode, blocker: window.__game.ctx.uiBlockers.has('hub'),
  }));
  ok(closed.tog && closed.tog.open === false, 'hub:terminalToggled {open:false} on Esc');
  ok(closed.cursor === false && !closed.blocker, 'closing releases the software cursor and the blocker');

  /* ── 6. persistence across a reload ──────────────────────────────────── */
  console.log('저장 / 복원');
  await boot('reload');
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub phase (reload)');
  await waitSim(0.3);
  const re = await P(() => ({
    planet: window.__game.ctx.hub.planet,
    hex: (() => {
      const g = window.__game.ctx.scene.getObjectByName('PersonalShip');
      let hex = null;
      g?.traverse((o) => { if (o.name === 'HubPlanetBody' && hex === null) hex = o.material.color.getHex(); });
      return hex;
    })(),
    travelEvents: window.__ev['hub:travel'].length,
  }));
  ok(re.planet === PLANETS[2].id, `the planet survives a reload (${re.planet})`);
  ok(re.hex === PLANETS[2].hologram, 'the ship is built with the stored planet colour, no cutscene');
  ok(re.travelEvents === 0, 'restoring a saved planet plays no travel cutscene');

  /* ── 7. launch: game:newMission carries the planet ───────────────────── */
  console.log('발사');
  // 2026-09-08: 리로드로 세션이 새로 시작됐으므로 출격 준비 경고가 다시 뜬다 — 확인하고 그대로 탑승한다
  const boardedNow = await P(() => {
    window.__game.ctx.interactables.all().find((i) => i.id === 'hub_pod_0').interact();
    const warn = document.querySelector('.launch-warn');
    const warned = warn && !warn.hidden;
    if (warned) [...warn.querySelectorAll('.hub-foot .ui-btn')].find((b) => b.textContent === '그래도 출격').click();
    return { warned, boarded: window.__game.getSystem('hub').boardedSlot };
  });
  ok(boardedNow.warned && boardedNow.boarded === 0, '리로드 뒤에는 경고가 다시 뜨고, 확인하면 탑승한다', JSON.stringify(boardedNow));
  await waitSim(0.2);
  ok(await P(() => window.__game.ctx.player.isInPod), 'boarded the launch slot');
  await waitFor(page, () => window.__ev['game:newMission'].length > 0, 'launch', 60000);
  const nm = await lastEv('game:newMission');
  ok(nm && nm.planet === PLANETS[2].id, `game:newMission {planet:'${nm?.planet}'}`);
  ok(nm && nm.mode === 'raid' && typeof nm.seed === 'number', `…with mode 'raid' and a seed (${nm?.seed})`);
  ok(await P(() => window.__game.ctx.missionPlanet) === PLANETS[2].id, 'ctx.missionPlanet was set BEFORE the emit (the world can read it)');
  const cd = await ev('hub:launchCountdown');
  ok(cd.length > 0, `the countdown ran (${cd.length} ticks)`);
} catch (e) {
  fail++;
  console.log(`  FAIL exception: ${e.message}`);
} finally {
  await browser.close();
}

const real = errors.filter((e) => !/WebSocket|websocket|favicon|404|net::ERR/.test(e));
if (real.length) { console.log(`\n  ${real.length} console error(s):`); for (const e of real.slice(0, 6)) console.log(`    ${e}`); }
console.log(`\n${pass} passed, ${fail} failed, ${real.length} console errors`);
process.exit(fail === 0 && real.length === 0 ? 0 : 1);
