// net/ + ui/ + hub/ smoke: **링크 상태 · 배경 프로브 · 연결 배지** (B-1, 2026-09-11) + C-59 (터미널이 닫혀 있어도 거절 사유가 토스트로).
//
// `ctx.net.link` 를 실제 소켓으로 끝까지 몬다. 설정 오버라이드(`localStorage['scav.relay']`)를 **죽은 포트**로 두고 시작해
//   1. 타이틀: 아무도 접속을 시도하지 않았다 → `idle`, 배지 없음
//   2. 함선 진입(`tryResume`) → `connecting` → 거절 → `unreachable` (6 s 안) · 배지 `오프라인 · 서버 찾는 중 (n초 뒤)`
//   3. 접속 타임아웃: 받기만 하고 대답하지 않는 TCP 서버(8886) → `ensureConnected()` 가 `NET_CONNECT_TIMEOUT_MS` 로 끝난다
//   4. 스모크가 그 포트(8885)에 릴레이를 직접 띄운다 → 백오프 안에 **익명** 프로브가 찾고 자동 접속 + `서버에 연결되었습니다`
//   5. 릴레이를 죽인다 → `reconnecting` + `서버 연결이 끊겼습니다 — 다시 찾는 중` → 로비 없는 재접속 포기가 조용하지 않고
//      `unreachable` 로 넘어간다 → 다시 띄우면 `서버에 다시 연결되었습니다`
//   6. 레이드 중에는 찾아도 **접속하지 않고** `found: true` 만 (배지도 숨김) → 함선으로 돌아오면 그때 접속
//   7. 거절(`kicked` · `server_full` · `duplicate`)은 프레임 주입으로: `refused` 뒤 프로브 · 소켓 없음, 사유 토스트(C-59),
//      명시적 connect 가 지운다
//   8. 타이틀: 배지 옆 `서버 설정` · `다시 시도` 버튼
//   9. 데스크톱 셸 흉내(`window.__scavDesktop` + `/__scav/relay` 응답 가짜): 임베디드 목표면 프로브하지 않는다
//
// 릴레이 포트는 **8885**(죽은 포트 → 스모크가 띄우는 릴레이), 8886(대답 없는 TCP) — 공용 릴레이(8787)는 건드리지 않는다.
// Usage: node scripts/smoke-netlink.mjs [http://localhost:5273]   (needs a running vite; the relay it needs it starts itself)
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5273/';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_PORT = 8885;
const HANG_PORT = 8886;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}/ws`;
const HANG_URL = `ws://127.0.0.1:${HANG_PORT}/ws`;
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
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* loading */ }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/* ── ports / relay ─────────────────────────────────────────────────────── */
function portFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}
async function healthy(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}
const dataDir = mkdtempSync(resolve(os.tmpdir(), 'scav-netlink-relay-'));
let relay = null;
async function startRelay() {
  for (let tryNo = 0; tryNo < 4; tryNo++) {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/index.ts'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', SCAV_DATA_DIR: dataDir },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && child.exitCode === null) {
      if (await healthy(RELAY_PORT)) { relay = child; return; }
      await sleep(150);
    }
    try { child.kill(); } catch { /* gone */ }
    console.log(`  (relay start ${tryNo + 1} failed — ${out.trim().split('\n').slice(-2).join(' | ')})`);
    await sleep(800);   // Windows can hold the port for a moment after a kill
  }
  throw new Error(`relay did not come up on ${RELAY_PORT}`);
}
async function stopRelay() {
  const child = relay;
  relay = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && await healthy(RELAY_PORT)) await sleep(100);
}
/** A TCP server that accepts and never answers — a WebSocket handshake to it hangs until the client gives up. */
const hanging = new Set();
const hangServer = createServer((sock) => { hanging.add(sock); sock.on('error', () => {}); sock.on('close', () => hanging.delete(sock)); });

if (!(await portFree(RELAY_PORT)) || !(await portFree(HANG_PORT))) {
  console.error(`ports ${RELAY_PORT} / ${HANG_PORT} must be free (another smoke-netlink running?)`);
  process.exit(2);
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
  await page.evaluateOnNewDocument((relayUrl) => {
    try {
      localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true }));
      // 설정 › 서버 설정 오버라이드 = 아직 아무도 듣지 않는 포트 (슬롯 공용 키).
      localStorage.setItem('scav.relay', relayUrl);
    } catch { /* storage off */ }
    // Park vite's HMR socket (another agent's save would full-reload the page mid-run) and record every game socket.
    window.__ws = [];
    const RealWS = window.WebSocket;
    class QuietSocket extends EventTarget {
      constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
      send() {} close() {}
    }
    window.WebSocket = new Proxy(RealWS, {
      construct(target, args) {
        const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
        if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
        window.__ws.push({ url: String(args[0]), at: performance.now() });
        return new target(...args);
      },
    });
  }, RELAY_URL);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await waitFor(page, () => !!window.__game && !!window.__game.ctx.net && !!window.__game.getSystem('hud'), 'boot');
  await page.evaluate(() => {
    let lastRaf = performance.now();
    (function tick() { lastRaf = performance.now(); requestAnimationFrame(tick); })();
    setInterval(() => { const now = performance.now(); if (now - lastRaf > 100) window.__game.frame(now); }, 33);
    window.__ev = { link: [], notify: [], error: [] };
    const bus = window.__game.ctx.bus;
    bus.on('net:linkChanged', ({ link, prev }) => window.__ev.link.push({ ...link, prev, at: performance.now() }));
    bus.on('ui:notify', ({ text }) => window.__ev.notify.push({ text, at: performance.now() }));
    bus.on('net:error', ({ code, message }) => window.__ev.error.push({ code, message }));
  });
  const P = (fn, arg) => page.evaluate(fn, arg);
  const link = () => P(() => { const n = window.__game.ctx.net; return { ...n.link, connected: n.connected, reconnecting: n.reconnecting, probing: n.probeTimer !== null }; });
  const badge = () => P(() => { const h = window.__game.getSystem('hud').netBadgeState; const r = document.querySelector('.net-badge'); return { ...h, ship: !!r?.classList.contains('nb-ship') }; });
  const now = () => P(() => performance.now());
  const toastsSince = (t) => P((t0) => window.__ev.notify.filter((n) => n.at >= t0).map((n) => n.text), t);
  const socketsSince = (t) => P((t0) => window.__ev ? window.__ws.filter((s) => s.at >= t0).map((s) => s.url) : [], t);
  const waitLink = (pred, label, timeout) => waitFor(page, new Function(`const n = window.__game.ctx.net; const l = n.link; return (${pred})(l, n);`), label, timeout);
  const forceGiveUp = () => P(() => {
    // 로비 없는 재접속 6회를 기다리는 대신 마지막 회차로 건너뛴다 — `scheduleReconnect` 가 포기하는 그 분기.
    const n = window.__game.getSystem('net');
    if (n.reconnectTimer !== null) { clearTimeout(n.reconnectTimer); n.reconnectTimer = null; }
    n.reconnectAttempt = 6;
    n.scheduleReconnect();
    return { state: n.link.state, reconnecting: n.reconnecting, probing: n.probeTimer !== null };
  });

  /* ── 1. title: idle ─────────────────────────────────────────────────── */
  console.log('1. 타이틀 — 아직 아무도 접속하지 않았다');
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'title');
  await sleep(300);
  let l = await link();
  ok(l.state === 'idle' && !l.connected, `link idle on the title (${l.state})`);
  ok(l.url === RELAY_URL, `link.url = the settings override (${l.url})`);
  ok(!(await badge()).on, 'no badge while idle');

  /* ── 2. hub → unreachable ───────────────────────────────────────────── */
  console.log('2. 함선 진입 → 죽은 포트 → unreachable');
  let t = await now();
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub');
  await waitLink('(l) => l.state === "unreachable" && typeof l.nextProbeInMs === "number"', 'unreachable', 8000);
  const seq2 = await P((t0) => window.__ev.link.filter((e) => e.at >= t0).map((e) => e.state), t);
  const tUnreach = await P((t0) => { const e = window.__ev.link.find((x) => x.at >= t0 && x.state === 'unreachable'); return e ? e.at - t0 : -1; }, t);
  ok(seq2[0] === 'connecting' && seq2.includes('unreachable'), `connecting → unreachable (${seq2.join(' → ')})`);
  ok(tUnreach >= 0 && tUnreach < 6000, `unreachable within NET_CONNECT_TIMEOUT_MS (${Math.round(tUnreach)} ms)`);
  l = await link();
  ok(l.probing && l.nextProbeInMs > 0 && l.nextProbeInMs <= 5000, `background probe scheduled on the first backoff step (${l.nextProbeInMs} ms)`);
  await sleep(250);
  let b = await badge();
  ok(b.on && b.ship && /^오프라인 · 서버 찾는 중 \(\d+초 뒤\)$/.test(b.main), `ship badge: ${b.main}`, JSON.stringify(b));
  ok(!b.actions, 'no buttons on the ship badge (no cursor there)');
  ok(!(await toastsSince(t)).some((x) => x.includes('끊겼습니다')), 'no "connection lost" toast for a connection that never existed');

  /* ── 3. connect timeout ─────────────────────────────────────────────── */
  console.log('3. 대답 없는 서버 → NET_CONNECT_TIMEOUT_MS');
  await new Promise((r) => hangServer.listen(HANG_PORT, '127.0.0.1', r));
  const to = await P(async (url) => {
    const net = window.__game.ctx.net;
    net.setRelayOverride(url);
    const restarted = net.link;
    const t0 = performance.now();
    const res = await net.ensureConnected();
    return { res, ms: performance.now() - t0, state: net.link.state, restartedUrl: restarted.url, restartedState: restarted.state };
  }, HANG_URL);
  ok(to.restartedState === 'unreachable' && to.restartedUrl === HANG_URL, `a new address restarts the probe for it (${to.restartedUrl})`);
  ok(to.res === false && to.ms >= 5500 && to.ms < 8000, `a silent server fails the connect after ~6 s (${Math.round(to.ms)} ms)`);
  ok(to.state === 'unreachable', `→ unreachable (${to.state})`);
  await P((url) => window.__game.ctx.net.setRelayOverride(url), RELAY_URL);
  for (const s of hanging) s.destroy();
  await new Promise((r) => hangServer.close(r));

  /* ── 4. relay comes up → probe → auto connect (ship) ────────────────── */
  console.log('4. 릴레이를 띄운다 → 익명 프로브 → 함선에서 자동 접속');
  t = await now();
  await startRelay();
  await waitLink('(l, n) => l.state === "connected" && n.connected', 'auto connect', 15000);
  let socks = await socketsSince(t);
  const firstToRelay = socks.find((u) => u.startsWith(RELAY_URL));
  ok(!!firstToRelay && !/[?&]t=/.test(firstToRelay), `the probe that found it is anonymous (${firstToRelay})`);
  ok(socks.some((u) => u.startsWith(RELAY_URL) && /[?&]t=/.test(u)), 'then a tokened connect followed');
  const seq4 = await P((t0) => window.__ev.link.filter((e) => e.at >= t0).map((e) => e.state), t);
  ok(seq4.slice(-2).join(',') === 'connecting,connected', `unreachable → connecting → connected (${seq4.join(' → ')})`);
  await sleep(200);
  ok((await toastsSince(t)).includes('서버에 연결되었습니다'), 'toast 서버에 연결되었습니다', JSON.stringify(await toastsSince(t)));
  b = await badge();
  ok(b.on && b.main === '연결됨', `badge 연결됨 (${b.main})`);
  await sleep(3400);
  ok(!(await badge()).on, 'badge gone 3 s after connecting');

  /* ── 5. drop → reconnecting → give-up → unreachable → back ──────────── */
  console.log('5. 끊김 → 재접속 → (로비 없이 포기) → unreachable → 복귀');
  t = await now();
  await stopRelay();
  await waitLink('(l) => l.state === "reconnecting"', 'reconnecting', 8000);
  await sleep(200);
  ok((await toastsSince(t)).includes('서버 연결이 끊겼습니다 — 다시 찾는 중'), 'toast 서버 연결이 끊겼습니다 — 다시 찾는 중', JSON.stringify(await toastsSince(t)));
  ok(!(await toastsSince(t)).some((x) => x.startsWith('서버 재연결 중')), 'no per-attempt 재연결 toast in the ship (the badge counts)');
  b = await badge();
  ok(b.on && /^서버 재연결 중… \(\d+\)$/.test(b.main), `badge ${b.main}`);
  const gu = await forceGiveUp();
  ok(gu.state === 'unreachable' && !gu.reconnecting && gu.probing, `lobbyless give-up hands over to the probe (${JSON.stringify(gu)})`);
  const giveUpEv = await P((t0) => window.__ev.link.filter((e) => e.at >= t0).some((e) => e.prev === 'reconnecting' && e.state === 'unreachable'), t);
  ok(giveUpEv, 'net:linkChanged reconnecting → unreachable (not a silent stop)');
  t = await now();
  await startRelay();
  await waitLink('(l, n) => l.state === "connected" && n.connected', 'reconnect via probe', 15000);
  await sleep(200);
  ok((await toastsSince(t)).includes('서버에 다시 연결되었습니다'), 'toast 서버에 다시 연결되었습니다', JSON.stringify(await toastsSince(t)));

  /* ── 6. raid: found, not joined ─────────────────────────────────────── */
  console.log('6. 레이드 중 — 찾아도 접속하지 않는다');
  await stopRelay();
  await waitLink('(l) => l.state === "reconnecting"', 'reconnecting (6)', 8000);
  await forceGiveUp();
  await P(() => window.__game.ctx.bus.emit('game:newMission', { seed: 11 }));
  await waitFor(page, () => window.__game.ctx.phase === 'playing', 'playing', 30000);
  t = await now();
  await startRelay();
  await P((url) => window.__game.ctx.net.setRelayOverride(url), RELAY_URL);   // restart the probe on its first step
  await waitLink('(l) => l.state === "unreachable" && l.found === true', 'found in raid', 15000);
  await sleep(1500);
  l = await link();
  ok(l.state === 'unreachable' && l.found === true && !l.connected && !l.probing, `found:true, not connected, probe stopped (${JSON.stringify(l)})`);
  socks = await socketsSince(t);
  ok(socks.length > 0 && socks.every((u) => !/[?&]t=/.test(u)), `only anonymous sockets during the raid (${socks.length})`);
  ok(!(await badge()).on, 'badge hidden on the raid HUD');
  t = await now();
  await P(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(page, () => window.__game.ctx.phase === 'hub', 'hub (6)', 20000);
  await waitLink('(l, n) => l.state === "connected" && n.connected', 'connect back in the ship', 10000);
  ok(true, 'back in the ship → connected');

  /* ── 7. refused: kicked / server_full / duplicate ───────────────────── */
  console.log('7. 거절 — 프로브 없음 · 사유 토스트 (C-59) · 명시적 connect 가 지운다');
  const refuse = (code, message) => P(({ code, message }) => {
    const n = window.__game.getSystem('net');
    n.client.onMessage({ t: 'lobby:error', code, message });
    n.client.close();
    return { state: n.link.state, refused: n.link.refused, probing: n.probeTimer !== null, reconnecting: n.reconnecting };
  }, { code, message });
  t = await now();
  const kickMsg = '서버 관리자가 연결을 끊었습니다. (smoke)';
  let r = await refuse('kicked', kickMsg);
  ok(r.state === 'refused' && r.refused === 'kicked' && !r.probing && !r.reconnecting, `kicked → refused, no probe, no reconnect (${JSON.stringify(r)})`);
  await sleep(250);
  ok((await toastsSince(t)).includes(kickMsg), 'the server reason reaches a toast with the terminal closed (C-59)', JSON.stringify(await toastsSince(t)));
  ok(!(await toastsSince(t)).some((x) => x.includes('끊겼습니다')), 'no generic "connection lost" toast on a refusal');
  b = await badge();
  ok(b.on && b.main === '추방됨', `badge 추방됨 (${b.main} / ${b.sub})`);
  await sleep(6000);
  l = await link();
  socks = await socketsSince(t);
  ok(l.state === 'refused' && !l.connected && socks.length === 0, `6 s later: still refused, no socket opened (${socks.length})`);
  ok(await P(() => window.__game.ctx.net.ensureConnected()), 'explicit connect clears the refusal');
  r = await refuse('server_full', '서버 접속 인원이 가득 찼습니다.');
  ok(r.state === 'refused' && r.refused === 'server_full' && !r.probing, `server_full → refused (${JSON.stringify(r)})`);
  ok(await P(() => window.__game.ctx.net.ensureConnected()), 'explicit connect after server_full');
  r = await refuse('duplicate', '다른 탭에서 같은 세션으로 접속했습니다. 이 연결은 종료됩니다.');
  ok(r.state === 'refused' && r.refused === 'duplicate' && !r.probing, `duplicate → refused (${JSON.stringify(r)})`);

  /* ── 8. title: buttons ──────────────────────────────────────────────── */
  console.log('8. 타이틀 — 배지 옆 서버 설정 · 다시 시도');
  await P(() => window.__game.ctx.bus.emit('game:abort', {}));
  await waitFor(page, () => window.__game.ctx.phase === 'menu', 'title (8)');
  await sleep(250);
  b = await badge();
  ok(b.on && !b.ship && b.actions && b.main === '다른 곳에서 접속됨', `title badge with buttons (${JSON.stringify(b)})`);
  const labels = await P(() => [...document.querySelectorAll('.net-badge .nb-actions .ui-btn')].map((x) => x.textContent));
  ok(labels.join(',') === '다시 시도,서버 설정', `buttons ${labels.join(' / ')}`);
  const hit = await P(() => {
    const r = document.querySelector('.net-badge .nb-actions .ui-btn').getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && !!top.closest('.net-badge');
  });
  ok(hit, 'the badge buttons are on top of the title (clickable)');
  await P(() => [...document.querySelectorAll('.net-badge .nb-actions .ui-btn')].find((x) => x.textContent === '서버 설정').click());
  await waitFor(page, () => window.__game.getSystem('hud').isSettingsOpen, 'settings open');
  ok((await P(() => window.__game.getSystem('hud').settingsSection)) === 'network', '서버 설정 opens the settings on 서버 설정');
  await P(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true })));
  await waitFor(page, () => !window.__game.getSystem('hud').isSettingsOpen, 'settings closed', 5000);
  await P(() => [...document.querySelectorAll('.net-badge .nb-actions .ui-btn')].find((x) => x.textContent === '다시 시도').click());
  await waitLink('(l, n) => l.state === "connected" && n.connected', '다시 시도', 8000);
  await sleep(200);
  b = await badge();
  ok(b.on && b.main === '연결됨' && !b.actions, `다시 시도 → 연결됨, buttons gone (${JSON.stringify(b)})`);

  /* ── 9. desktop shell + embedded target: no probe ───────────────────── */
  console.log('9. 데스크톱 셸 흉내 — 임베디드 목표는 프로브하지 않는다');
  await stopRelay();
  await waitLink('(l) => l.state === "reconnecting"', 'reconnecting (9)', 8000);
  await forceGiveUp();
  await P(() => {
    window.__scavDesktop = true;
    window.__routeSource = '이 PC 의 내장 서버 (필요할 때 켜짐)';
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => (String(input).includes('/__scav/relay')
      ? Promise.resolve(new Response(JSON.stringify({ target: 'ws://127.0.0.1:8790/ws', source: window.__routeSource }), { status: 200, headers: { 'content-type': 'application/json' } }))
      : real(input, init));
  });
  t = await now();
  await P(() => window.__game.ctx.net.setRelayOverride(''));   // same-origin /ws = what the shell proxies
  await waitLink('(l) => l.state === "unreachable" && l.embedded === true', 'embedded', 5000);
  l = await link();
  ok(l.embedded === true && l.nextProbeInMs === null && !l.probing, `embedded target → no probe (${JSON.stringify(l)})`);
  await sleep(6000);
  socks = await socketsSince(t);
  ok(socks.length === 0, `6 s: no socket to the lazy relay (${socks.length})`);
  b = await badge();
  ok(b.on && b.main === '오프라인' && b.sub.includes('내장 서버'), `badge ${b.main} / ${b.sub}`);
  // the same shell with a configured relay (server.txt / --relay) is probed as usual
  const cfg = await P(() => {
    const n = window.__game.getSystem('net');
    window.__routeSource = '--relay';
    n.embeddedCache = null;
    n.setRelayOverride('');
    return null;
  });
  void cfg;
  await waitLink('(l) => l.state === "unreachable" && typeof l.nextProbeInMs === "number" && l.nextProbeInMs > 0', 'configured shell relay probed', 5000);
  l = await link();
  ok(!l.embedded && l.probing, `configured shell relay → probing (${JSON.stringify(l)})`);
  // stop before that probe reaches the shared dev relay through vite
  await P(() => { const n = window.__game.ctx.net; n.disconnect(); window.__scavDesktop = false; });
  ok((await link()).state === 'idle', 'disconnect() → idle, probe stopped');

  const realErrors = errors.filter((e) => !/WebSocket|ws:\/\/|ERR_CONNECTION|net::/.test(e));
  ok(realErrors.length === 0, 'no page errors (relay socket noise excluded)', realErrors.slice(0, 3).join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  if (realErrors.length) { console.log('page errors:'); for (const e of realErrors.slice(0, 10)) console.log('  ', e); }
} catch (e) {
  fail++;
  console.log(`  FAIL crashed: ${e.message}`);
  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  await browser.close().catch(() => {});
  await stopRelay();
  for (const s of hanging) s.destroy();
  try { hangServer.close(); } catch { /* not listening */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* locked → stays in %TEMP% */ }
}
process.exit(fail ? 1 : 0);
