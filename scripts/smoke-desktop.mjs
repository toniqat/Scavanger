#!/usr/bin/env node
/**
 * Launches the desktop shell (`electron/`) as **real Electron** and checks it (E-3, 2026-09-11 · the
 * 2026-09-15 rework that took the server out).
 *
 * Browser smokes *mimic* the shell with `window.__scavDesktop = true`, so the shell's own code (the window
 * server · the `/ws` proxy · relay address resolution · window port = save origin · the single-instance lock)
 * has until now only ever been confirmed by hand, a person attaching over CDP (those manual runs are in the
 * git history). This script is that procedure.
 *
 * **2026-09-15 — builds ship no server (user's decision).** The shell's embedded relay · `--port` · `--lan` ·
 * `--lazy-relay` are gone, so this smoke **starts a relay itself** (`server/index.ts`, 9823), points the shell
 * at it, and checks that the shell opens no port as a relay · that neither the bundle nor the release build
 * holds server code.
 *
 *   0. Setup  Rebuilds when `dist/` is older than `src/` · `data/`, or `dist-electron/main.js` older than
 *             `electron/` · `src/shared/` (`vite build` + `node electron/build.mjs` — `npm run app:build` with
 *             tsc alone taken out: the type check is the runner's first step, and another folder's
 *             half-finished type error must not block the shell check). The bundle holds **no** relay code
 *             (`startRelayServer` · `WebSocketServer` · `ProfileStore` · a `ws` import). Starts the smoke's
 *             relay on 9823.
 *   1. Boot   `electron.exe <repo> --hidden --relay=ws://127.0.0.1:9823/ws --app-port=9910 --user-data=<tmp>
 *             --remote-debugging-port=9340` → `/json/version` → puppeteer-core `connect` → the
 *             `127.0.0.1:9910` page. `window.__game.ctx` · UA `Electron/` · no `__scavDesktop` mimic ·
 *             `__scavShellRelock` installed · the simulation runs in a hidden window too · injecting Escape
 *             with `webContents.sendInputEvent` through the main-process inspector (`--inspect=9341`) gives
 *             `before-input-event` → `__scavShellRelock` exactly once · the page receives each key exactly
 *             once. The only ports the app's process tree listens on are the window and debugging ports (no
 *             relay port).
 *   2. Proxy (`--relay`)   `/__scav/relay` = that address · source `--relay` · `embedded: false` →
 *             `ensureConnected()` → welcome · the smoke relay's `clients === 1` · the profile store appears
 *             in **the smoke relay's folder** and userData holds no `relay-data`.
 *   3. This PC's server (`--local`)   `--local` wins even when `--relay` is given with it → `/__scav/relay` =
 *             `ws://127.0.0.1:8787/ws` (the start-server.bat server) · `embedded: false`. It is the same
 *             destination as having no address at all — that path itself cannot be seen here
 *             (`electron/default-relay.txt` has a LAN address baked in). On entering the ship the link either
 *             connects to 8787 (when a shared relay is up) or is `unreachable` + a background probe — either
 *             way there is no `embedded`.
 *   4. Save = the window port   a mark in localStorage → a clean quit through CDP `Browser.close` → a reboot
 *             on the same `--app-port` (step 3) → the mark is still there · `--app-port=9912` → it is not.
 *             In the ship, `body.desktop-nocursor` coming on is `isDesktopShell()` being true with no mimic.
 *   5. Single instance   a second run with the same userData → exits 0 at once · the first window gets
 *             `second-instance` · 9912 is never opened.
 *   6. `server.txt`   the temp folder = a `cwd` candidate, BOM + comments + a bare `host:port` → it is hit
 *             before the baked LAN address and the app connects to that relay.
 *   7. With `--release` only: `release/SCAVANGER/` holds exactly **three** (app/ · SCAVANGER.exe ·
 *             server.txt) · `app.asar` holds neither relay code nor `node_modules` · `server.txt` names
 *             start-server.bat · the stub `SCAVANGER.exe` passes its arguments (`--hidden --user-data=…
 *             --remote-debugging-port=…`) on and the boot assertions pass. An outdated release build runs
 *             `npm run app:dist` (minutes).
 *   End  none of the Electron · relay processes it launched is left · every port released · the output
 *             `N passed, M failed` + `FAIL` lines (the verify runner's parser).
 *
 * Ports (fixed so they never collide with another runner):
 *   8787 the shared relay (this smoke does not listen on it — in step 3 the shell only pipes there) ·
 *   8790–8799 **the user's real save origin (never used)** · 9910 the window · 9912 the second window's
 *   origin · 9823 the smoke relay · 9340 remote debugging (the renderer's CDP) · 9341 the main process's
 *   Node inspector.
 *   When one of these ports is busy at the start — only what this script left behind (`scav-desktop-` on the
 *   command line) is killed; anything else and it touches nothing and fails.
 *
 * How the shell's constraints are worked around:
 *   - `electron/default-relay.txt` has a LAN IP baked in → on the proxy path `--relay` / `server.txt` are hit
 *     first, and for this PC's server `--local` is, each ahead of the baked value. `SCAV_*` ·
 *     `PORTABLE_EXECUTABLE_DIR` · `ELECTRON_RUN_AS_NODE` are deleted from the child environment.
 *   - the single-instance lock · localStorage · the window state all live in userData → `--user-data=<temp>`
 *     isolates them. Neither a SCAVANGER the user has running nor `%APPDATA%/SCAVANGER` is touched.
 *   - there is no preload → the page carries no shell marker and the UA is the only clue. Headless does not
 *     work → `--hidden` (only the window is hidden, rendering carries on).
 *
 * **What automation cannot prove** (a recorded limit — `electron/README.md`, the "Escape" section):
 *   - real Escape · pointer-lock timing. A key injected over CDP (`Input.dispatchKeyEvent`) does not take
 *     Chromium's exclusive-access path, so it reaches the page with the lock still held, and **it does not go
 *     through `before-input-event` either** (measured: the page receives it, the hook fires 0 times). So step
 *     1 injects it with the main process's `sendInputEvent`, but a hidden window has no focus and cannot take
 *     a pointer lock, so the 「a re-request ≈1.25 s after Escape released the lock is refused」 cooldown and
 *     `shared/Input`'s deferral still cannot be measured. What is looked at here is **the wiring** only —
 *     whether an Escape key-up reaches `before-input-event` → `executeJavaScript(…, true)` →
 *     `window.__scavShellRelock`. When the lock really comes back is `src/shared/Input.ts`'s 「a re-lock
 *     right after Escape is deferred」 comment (commit `3b12420`), which is the original.
 *   - a hidden window cannot see focus · fullscreen · the window state restore (`windowState.ts`). Saves
 *     surviving a forced kill (Task Manager) (`flushStorageData`) are not measured here either — only a
 *     clean quit.
 *
 * Usage: node scripts/smoke-desktop.mjs [--no-build | --build] [--release | --release-dir=<folder>]
 *        (the vite URL argument the verify runner passes is ignored — neither vite nor the shared relay is
 *        used)
 */
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2).filter((a) => !/^https?:\/\//.test(a));
/** `--release-dir=<folder>` = checks a deploy folder built somewhere else (app:dist is then never run). */
const RELEASE_DIR = args.find((a) => a.startsWith('--release-dir='))?.slice('--release-dir='.length) ?? null;
const RELEASE = args.includes('--release') || !!RELEASE_DIR;
const NO_BUILD = args.includes('--no-build');
const FORCE_BUILD = args.includes('--build');

// ⚠ 2026-09-20: these were 8820 · 8822, and moving `PROXY_RELAY_PORT` the same day left the two of them
// behind — both sit inside the WinNAT reserved range **8800–8899**, and the shell tries `APP_PORT_TRIES` (10)
// ports in order from `APP_PORT`, so 8820–8829 all come back EACCES. The window then never opens at all,
// `/json/version` does not answer within 45 s and the score ends at 5/6 (exactly the red `docs/TODO.md` E-13
// wrote down as 「cause unknown」). 9910–9919 is outside it and well clear of 9823 · 9885 · 9886 · 9896 too.
// The range moves from machine to machine · from time to time — on another red, look at
// `netsh interface ipv4 show excludedportrange protocol=tcp` first.
const APP_PORT = 9910;
const APP_PORT_2 = 9912;
// ⚠ 2026-09-20: this was 8823, but this dev PC's WinNAT reserves **8800–8899** whole, so the bind died with
// EACCES and the smoke always failed, misdiagnosing it as 「the port has to be free」 (`netsh interface ipv4
// show excludedportrange protocol=tcp`). 9823 is outside that range — the same reason `smoke-netlink` moved
// to 9885 · 9886 the same day.
const PROXY_RELAY_PORT = 9823;
const DEBUG_PORT = 9340;
/**
 * The main process's (Node) inspector — `webContents.sendInputEvent` injects Escape on the **native input
 * path** rather than through CDP.
 */
const INSPECT_PORT = 9341;
const OUR_PORTS = [APP_PORT, APP_PORT_2, PROXY_RELAY_PORT, DEBUG_PORT, INSPECT_PORT];
/**
 * Where the shell pipes with no address at all · with `--local` — the server start-server.bat started on this
 * PC (`NET_DEFAULT_PORT`).
 */
const LOCAL_SERVER = 'ws://127.0.0.1:8787/ws';
const PROXY_URL = `ws://127.0.0.1:${PROXY_RELAY_PORT}/ws`;
/** This string on the command line means the process was launched by this script (the temp folder prefix). */
const TAG = 'scav-desktop-';
/**
 * It must not start with `scav.` — at boot `shared/saveSlot` moves an old single key to `scav.s1.*`, which
 * makes it look as if it "disappeared".
 */
const MARK_KEY = 'smokeDesktop.mark';
/** Traces of relay code that must not be in the bundle · the release build (2026-09-15 — builds ship no server). */
const RELAY_CODE = /startRelayServer|WebSocketServer|ProfileStore|LobbyManager/;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── processes · ports ─────────────────────────────────────────── */
const ELECTRON = (() => { try { return createRequire(import.meta.url)('electron'); } catch { return null; } })();

/** [{port, pid}] — every TCP socket LISTENING right now. */
function listeners() {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    return out.split('\n').map((l) => l.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)).filter(Boolean).map((m) => ({ port: +m[1], pid: +m[2] })).filter((x) => x.pid);
  }
  const out = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }).stdout ?? '';
  const rows = []; let pid = 0;
  for (const l of out.split('\n')) { if (l[0] === 'p') pid = +l.slice(1); else if (l[0] === 'n') { const m = l.match(/:(\d+)$/); if (m) rows.push({ port: +m[1], pid }); } }
  return rows;
}
function pidsOnPort(port) {
  return [...new Set(listeners().filter((x) => x.port === port).map((x) => x.pid))];
}
/** [{pid, ppid, name, cmd}] — electron · the release exe · node only (the full list is slow). */
function processList() {
  if (!isWin) {
    const out = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).stdout ?? '';
    return out.split('\n').filter(Boolean).map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], name: m[3], cmd: m[4] } : null;
    }).filter(Boolean);
  }
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='electron.exe' OR Name='SCAVANGER.exe' OR Name='node.exe'\" | "
    + 'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout || '[]');
    return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, cmd: p.CommandLine ?? '' }));
  } catch { return []; }
}
function descendants(rootPid, list = processList()) {
  const out = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of list) if (out.has(p.ppid) && !out.has(p.pid)) { out.add(p.pid); grew = true; }
  }
  return [...out];
}
/**
 * The ports the app's process tree listens on (sorted). Anything besides the window · debugging · inspector
 * ports is a server inside the shell.
 */
function portsOfTree(rootPid) {
  const tree = new Set(descendants(rootPid));
  return [...new Set(listeners().filter((x) => tree.has(x.pid)).map((x) => x.port))].sort((a, b) => a - b);
}
function killTree(pid) {
  if (!pid) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
async function waitPortsFree(ports, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const busy = ports.filter((p) => pidsOnPort(p).length);
    if (!busy.length || Date.now() - t0 > ms) return busy;
    await sleep(250);
  }
}
async function getJson(url, ms = 1500) {
  return (await probeJson(url, ms)).v;
}
/**
 * The same as `getJson` but it records **why it failed** (E-13, 2026-09-17). 「the app has not opened the port
 * yet」 and 「our own fetch failed (socket exhaustion · timeout · connection refused)」 cannot be told apart
 * from one `null` — and telling a boot failure that happens only inside a full run apart, from the log alone,
 * needs the reason.
 */
async function probeJson(url, ms = 1500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { v: r.ok ? await r.json() : { httpStatus: r.status }, err: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) {
    const cause = e?.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : '';
    return { v: null, err: `${e?.name ?? 'Error'}: ${e?.message ?? e}${cause}` };
  }
}
/**
 * Records **what blocked it** when the boot did not finish inside the timeout (E-13, 2026-09-17). The old
 * message was the one line 「did not answer within 45 s」, which told nothing about whether it was slow · dead
 * · or held by someone else. It runs only on a failure, so it costs a passing run nothing — instead it waits
 * `graceMs` longer past the timeout to see whether it **comes up in the end**.
 */
async function bootDiag(h, debugPort, lastErr, waitedMs, graceMs = 120_000) {
  const pid = h?.child.pid ?? null;
  const list = processList();
  const alive = pid ? list.some((p) => p.pid === pid) : null;
  const tree = pid && alive ? descendants(pid, list).length : 0;
  const onDebug = pidsOnPort(debugPort);
  const onInspect = pidsOnPort(INSPECT_PORT);
  const t1 = Date.now();
  let late = null;
  while (!late && Date.now() - t1 < graceMs) { late = await getJson(`http://127.0.0.1:${debugPort}/json/version`, 1000); if (!late) await sleep(500); }
  const lateS = late ? ((Date.now() - t1 + waitedMs) / 1000).toFixed(0) : null;
  /*
   * 2026-09-20 (E-13): the shell was already printing 「app port N is reserved by Windows」 ten lines at a
   * time, but the one-line FAIL summary never carried it up, so it stayed 「cause unknown」 for four days. The
   * diagnosis says it itself — when this line shows it is the ports, not any check before it, so look at
   * `netsh interface ipv4 show excludedportrange protocol=tcp` and move the port.
   */
  const reserved = (h?.out.match(/app port \d+ is reserved by Windows/g) ?? []).length;
  const portNote = reserved ? ` — 셸이 앱 포트 ${reserved}개를 「reserved by Windows」로 넘겼다: WinNAT 예약 구간이 APP_PORT 스캔 범위를 덮어 창이 열리지 않았다` : '';
  return `[진단] exit=${JSON.stringify(h?.exit ?? null)} 프로세스생존=${alive} 트리=${tree} `
    + `듣는중 ${debugPort}=[${onDebug.join(',')}] ${INSPECT_PORT}=[${onInspect.join(',')}] 마지막fetch=${lastErr ?? 'none'} `
    + (late ? `— 결국 ${lateS} s 에 떴다 (죽은 게 아니라 느린 것이다)` : `— ${Math.round((waitedMs + graceMs) / 1000)} s 를 기다려도 안 떴다`) + portNote;
}

/**
 * Runs an expression in the main process (the Node inspector of an Electron launched with `--inspect=<port>`).
 * The bundle is ESM, so `import()` is blocked in the inspector context
 * (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), and `electron` is obtained through the `require` that
 * `includeCommandLineAPI` provides.
 */
async function mainEval(port, expression) {
  let list = null;
  for (let i = 0; i < 50 && !list; i++) { list = await getJson(`http://127.0.0.1:${port}/json/list`); if (!list) await sleep(100); }
  if (!list?.[0]?.webSocketDebuggerUrl) throw new Error(`메인 프로세스 인스펙터(${port})에 붙지 못했다`);
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  try {
    const reply = await new Promise((res) => {
      ws.addEventListener('message', (m) => { const j = JSON.parse(m.data); if (j.id === 1) res(j); });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
    });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
    return reply.result?.result?.value;
  } finally { ws.close(); }
}

/** What this script launched — at the end every one is confirmed, and killed if it is still there. */
const launched = new Set();
const trackedPids = new Set();
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^SCAV_/i.test(k) || /^(PORTABLE_EXECUTABLE_DIR|ELECTRON_RUN_AS_NODE)$/i.test(k)) delete env[k];
  return env;
};
function launch(label, exe, argv, { cwd, env } = {}) {
  const child = spawn(exe, argv, { cwd, env: env ?? cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const h = { label, child, out: '', exit: null };
  h.exited = new Promise((res) => child.on('exit', (code, signal) => { h.exit = { code, signal }; launched.delete(h); res(h.exit); }));
  child.on('error', (e) => { h.out += `\n[spawn error] ${e.message}`; });
  child.stdout.on('data', (d) => { h.out += d; });
  child.stderr.on('data', (d) => { h.out += d; });
  launched.add(h);
  trackedPids.add(child.pid);
  return h;
}
const tail = (h, n = 12) => h.out.trim().split('\n').slice(-n).map((l) => `      | ${l}`).join('\n');

async function waitFor(page, fn, label, timeout = 60000, arg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.evaluate(fn, arg); if (v) return v; } catch { /* navigating */ }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Attaches to the remote debugging port and takes hold of the window server's page. When `appPid` is known
 * (it is not when `h` is the stub) its descendants go into the tracked list.
 * If `h.exit` arrives first it throws at once — a boot failure is not waited out for 60 s.
 */
async function attach(h, { debugPort = DEBUG_PORT, early = true } = {}) {
  const t0 = Date.now();
  let version = null;
  let lastErr = null;
  while (!version && Date.now() - t0 < 45000) {
    if (early && h?.exit) throw new Error(`${h.label} 이 부팅 중에 끝났다 (exit ${h.exit.code})\n${tail(h)}`);
    // When the main bundle dies on load, Electron stays alive with an error dialog up — it ends at once
    // rather than waiting.
    if (h && /App threw an error during load|Error launching app|A JavaScript error occurred in the main process/.test(h.out)) {
      killTree(h.child.pid);
      throw new Error(`${h.label}: 메인 프로세스 번들이 로드 중에 죽었다 (dist-electron/main.js — 다른 작업이 반쯤 된 코드일 수 있다)\n${tail(h)}`);
    }
    const probe = await probeJson(`http://127.0.0.1:${debugPort}/json/version`, 1000);
    version = probe.v; lastErr = probe.err;
    if (!version) await sleep(200);
  }
  const bootMs = Date.now() - t0;
  if (!version) throw new Error(`${debugPort}/json/version 이 45 초 안에 응답하지 않았다 ${await bootDiag(h, debugPort, lastErr, bootMs)}${h ? `\n${tail(h)}` : ''}`);
  // Whether the boot slows down inside a full run (E-13) only shows in the times of runs that passed —
  // anything over 3 s is recorded.
  if (bootMs > 3000) console.log(`  note: ${h?.label ?? '앱'} 의 ${debugPort}/json/version 이 ${(bootMs / 1000).toFixed(1)} s 만에 떴다 (제한 45 s)`);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null, protocolTimeout: 60000 });
  let page = null;
  while (!page && Date.now() - t0 < 60000) {
    page = (await browser.pages()).find((p) => p.url().startsWith('http://127.0.0.1:')) ?? null;
    if (!page) await sleep(200);
  }
  if (!page) { await browser.disconnect(); throw new Error('창 서버 페이지(http://127.0.0.1:…)가 뜨지 않았다'); }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await waitFor(page, () => !!window.__game && !!window.__game.ctx, 'window.__game.ctx', 60000);
  return { browser, page, version, errors, origin: new URL(page.url()).origin };
}

/** CDP `Browser.close` → Electron closes the window, `window-all-closed` → `app.quit()`. Waits for `pid` to end. */
async function closeApp(label, h, s, { pid = h?.child.pid } = {}) {
  try { await Promise.race([s.browser.close(), sleep(8000)]); } catch { /* socket closed under us */ }
  const t0 = Date.now();
  const alive = () => (h ? !h.exit : processList().some((p) => p.pid === pid));
  while (alive() && Date.now() - t0 < 20000) await sleep(200);
  const exited = !alive();
  ok(exited && (!h || h.exit.code === 0), `${label}: CDP Browser.close 로 정상 종료한다`, h ? `(exit ${JSON.stringify(h.exit)})` : '');
  if (!exited) killTree(pid);
  const busy = await waitPortsFree(OUR_PORTS.filter((p) => p !== PROXY_RELAY_PORT));
  ok(busy.length === 0, `${label}: 종료 뒤 창 · 디버깅 포트가 비었다`, busy.join(','));
}

/**
 * Whether the ports the app listens on are only the window · debugging · inspector ones — the most direct
 * proof that there is no relay inside the shell.
 */
function checkNoServerPorts(label, rootPid, appPort) {
  const allowed = new Set([appPort, DEBUG_PORT, INSPECT_PORT]);
  const ports = portsOfTree(rootPid);
  ok(ports.includes(appPort) && ports.every((p) => allowed.has(p)),
    `${label}: 앱 프로세스가 듣는 포트는 창 · 디버깅 포트뿐이다 — 릴레이를 켜지 않는다 (${ports.join(', ')})`);
}

/** The renderer connects over same-origin `/ws` → the smoke relay's clients is 1. */
async function connectThroughProxy(label, s) {
  const conn = await s.page.evaluate(async () => {
    const net = window.__game.getSystem('net');
    const res = await Promise.race([net.ensureConnected(), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    return { res, id: net.localId, origin: location.origin };
  });
  const h = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`);
  ok(conn.res === true && !!conn.id && h?.clients === 1, `${label}: 렌더러는 같은 오리진 /ws(${conn.origin}) 인데 스모크 릴레이의 clients 가 1 이다`, `${JSON.stringify(conn)} ${JSON.stringify(h)}`);
}
async function relayClientsBackToZero(label) {
  let c = null;
  for (let i = 0; i < 40; i++) { c = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`); if (c?.clients === 0) break; await sleep(150); }
  // A dropped socket goes into the reconnect grace — only its leaving `clients` is looked at.
  ok(c?.clients === 0, `${label}: 앱을 닫으면 스모크 릴레이의 clients 가 0 으로 돌아온다`, JSON.stringify(c));
}

/* ── 0. setup ────────────────────────────────────────────────────────── */
const SRC_EXT = /\.(ts|tsx|js|mjs|css|html|csv|txt|json|glsl)$/i;
function newestIn(rel, skip = []) {
  const start = join(ROOT, rel);
  if (!existsSync(start)) return 0;
  const st = statSync(start);
  if (st.isFile()) return st.mtimeMs;
  let best = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !skip.some((s) => p.startsWith(join(ROOT, s)))) walk(p); }
      else if (SRC_EXT.test(e.name)) best = Math.max(best, statSync(p).mtimeMs);
    }
  };
  walk(start);
  return best;
}
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
function runStep(label, cmd, argv, timeoutMs = 10 * 60_000) {
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, timeout: timeoutMs, shell: false, windowsHide: true });
  const secs = Math.round((Date.now() - t0) / 1000);
  const good = r.status === 0;
  console.log(`  ${good ? 'built' : 'FAIL '} ${label} (${secs} s)`);
  if (!good) console.log(String((r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\n${r.error.message}` : '')).trim().split('\n').slice(-15).map((l) => `      | ${l}`).join('\n'));
  return good;
}

const TMP = mkdtempSync(join(tmpdir(), TAG));
const EMPTY_CWD = join(TMP, 'cwd');
mkdirSync(EMPTY_CWD, { recursive: true });
const RELAY_DATA = join(TMP, 'proxy-relay-data');
let proxyRelay = null;
const t0All = Date.now();

try {
  if (!ELECTRON || !existsSync(ELECTRON)) throw new Error('node_modules/electron 이 없다 (npm install)');

  console.log('desktop: 0 준비');
  // Ports: only what this script left behind earlier is cleared. Anything else is left alone and it fails.
  {
    const busy = OUR_PORTS.map((p) => [p, pidsOnPort(p)]).filter(([, pids]) => pids.length);
    if (busy.length) {
      const list = processList();
      for (const [port, pids] of busy) {
        for (const pid of pids) {
          const proc = list.find((p) => p.pid === pid);
          if (proc && proc.cmd.includes(TAG)) { console.log(`  note: 지난 실행이 남긴 ${proc.name} (pid ${pid}, 포트 ${port}) 를 정리한다`); killTree(pid); }
          else throw new Error(`포트 ${port} 를 다른 프로세스가 쓰고 있다 (pid ${pid} ${proc?.name ?? ''}) — 건드리지 않고 멈춘다`);
        }
      }
      const still = await waitPortsFree(OUR_PORTS, 10000);
      if (still.length) throw new Error(`포트 ${still.join(',')} 가 풀리지 않는다`);
    }
  }

  const distStamp = mtime(join(ROOT, 'dist', 'index.html'));
  const distSrc = Math.max(newestIn('src'), newestIn('data'), newestIn('index.html'), newestIn('vite.config.ts'), newestIn('package.json'));
  const mainStamp = mtime(join(ROOT, 'dist-electron', 'main.js'));
  const mainSrc = Math.max(newestIn('electron', ['electron/resources']), newestIn('src/shared'));
  const needDist = FORCE_BUILD || (!NO_BUILD && distStamp < distSrc) || !distStamp;
  const needMain = FORCE_BUILD || (!NO_BUILD && mainStamp < mainSrc) || !mainStamp;
  if (!needDist && !needMain) console.log(`  note: ${NO_BUILD ? '--no-build' : 'dist/ · dist-electron/ 가 소스보다 새것이다'} — 빌드를 건너뛴다`);
  // A build counts only when it fails — so that whether it ran does not move `N passed` from run to run.
  if (needDist && !runStep('vite build → dist/', process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])) ok(false, 'dist/ 를 굽는다 (vite build) — 옛 dist/ 로 계속한다');
  if (needMain && !runStep('electron/build.mjs → dist-electron/main.js', process.execPath, [join(ROOT, 'electron', 'build.mjs')])) ok(false, 'dist-electron/main.js 를 굽는다');
  if (!existsSync(join(ROOT, 'dist', 'index.html')) || !existsSync(join(ROOT, 'dist-electron', 'main.js'))) throw new Error('빌드 산출물이 없다 — 셸이 모달 다이얼로그로 멈추므로 띄우지 않는다');
  {
    const main = readFileSync(join(ROOT, 'dist-electron', 'main.js'), 'utf8');
    // Launching an old bundle that does not know these flags would use the user's own userData (the saves ·
    // the single-instance lock) — so it is never launched.
    if (!main.includes('SCAV_USER_DATA') || !main.includes('SCAV_HIDDEN')) throw new Error('dist-electron/main.js 가 --user-data · --hidden 을 모른다 (옛 번들) — --no-build 를 빼고 다시');
    // 2026-09-15 (user's decision): builds ship no server.
    ok(!RELAY_CODE.test(main), 'dist-electron/main.js 에 릴레이 코드가 없다 (startRelayServer · WebSocketServer · ProfileStore · LobbyManager)', main.match(RELAY_CODE)?.[0] ?? '');
    ok(!/from\s*["']ws["']|require\(\s*["']ws["']\s*\)/.test(main), 'dist-electron/main.js 가 ws 패키지를 import 하지 않는다');
  }

  // The smoke relay — the shell holds no server, so the smoke makes something to connect to (the same
  // `server/index.ts` start-server.bat starts).
  proxyRelay = launch('smoke relay', process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'index.ts'), `--data=${RELAY_DATA}`, `--port=${PROXY_RELAY_PORT}`, '--host=127.0.0.1'],
    { cwd: ROOT, env: cleanEnv() });
  let hp = null;
  for (let i = 0; i < 80 && !hp; i++) { if (proxyRelay.exit) break; hp = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`); if (!hp) await sleep(150); }
  ok(hp?.ok === true && hp.clients === 0, `스모크 릴레이가 ${PROXY_RELAY_PORT} 에서 뜬다 (server/index.ts --port --host --data)`, hp ? JSON.stringify(hp) : `\n${tail(proxyRelay)}`);
  if (!hp) throw new Error('스모크 릴레이가 뜨지 않았다');

  const UD1 = join(TMP, 'ud-main');
  const UD2 = join(TMP, 'ud-file');
  const electronArgs = (...flags) => [ROOT, '--hidden', ...flags];

  /* ── 1. boot + 2. proxy (--relay) ─────────────────────────────── */
  console.log(`desktop: 1 부팅 (--hidden --relay=${PROXY_URL} --app-port=${APP_PORT} --user-data=<tmp>)`);
  const A = launch('boot A', ELECTRON, electronArgs(`--inspect=${INSPECT_PORT}`, `--relay=${PROXY_URL}`, `--app-port=${APP_PORT}`, `--user-data=${UD1}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sA = await attach(A);
  for (const pid of descendants(A.child.pid)) trackedPids.add(pid);
  ok(/Electron\//.test(sA.version['User-Agent'] ?? ''), `원격 디버깅 /json/version 이 Electron 이다 (${(sA.version['User-Agent'] ?? '').match(/Electron\/[\d.]+/)?.[0] ?? sA.version.Browser})`);
  ok(sA.origin === `http://127.0.0.1:${APP_PORT}`, `창의 오리진이 정확히 http://127.0.0.1:${APP_PORT} 다 (8790–8799 가 아니다)`, sA.origin);
  const bootA = await sA.page.evaluate(() => ({
    ctx: !!window.__game?.ctx,
    ua: navigator.userAgent,
    mimic: typeof window.__scavDesktop,
    relock: typeof window.__scavShellRelock,
    net: !!window.__game?.getSystem?.('net'),
  }));
  ok(bootA.ctx && bootA.net, 'window.__game.ctx 와 net 시스템이 있다');
  ok(/\bElectron\//.test(bootA.ua), 'navigator.userAgent 에 Electron/ 이 있다 (isDesktopShell 의 유일한 단서)');
  ok(bootA.mimic === 'undefined', 'window.__scavDesktop 흉내가 없다 (preload 없음 · 이 스모크도 심지 않았다)', bootA.mimic);
  ok(bootA.relock === 'function', 'window.__scavShellRelock 훅이 설치돼 있다', bootA.relock);
  {
    // The game loop runs in a hidden window too — with no smoke-side `__game.frame` fallback. It is **slow**
    // though: a window never once shown gets no frame request from the compositor, so rAF fires ≈5 times a
    // second (measured 2026-09-11). That is enough for the shell checks; a check that measures gameplay would
    // have to call `__game.frame` itself here, the way the other smokes do.
    const t1 = await sA.page.evaluate(() => window.__game.ctx.time);
    const rafs = await sA.page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); })(); }));
    const t2 = await sA.page.evaluate(() => window.__game.ctx.time);
    ok(t2 > t1 && rafs >= 2, `--hidden 창에서도 게임 루프가 돈다 (ctx.time ${t1.toFixed(2)} → ${t2.toFixed(2)}, rAF ${rafs}/s)`);
  }
  {
    // The main process's `webContents.sendInputEvent` = the native input path, not CDP. What is looked at is
    // the **wiring** through `before-input-event` → `executeJavaScript(SHELL_RELOCK, true)` → the page hook,
    // and that the key reaches the page exactly once.
    // (CDP `Input.dispatchKeyEvent` does not go through `before-input-event` at all — measured: the page
    // receives it, the hook fires 0 times.)
    await sA.page.evaluate(() => {
      window.__relockOrig = window.__scavShellRelock; window.__relockCalls = 0; window.__escKeys = [];
      window.__scavShellRelock = function () { window.__relockCalls++; };
      window.__escSpy = (e) => { if (e.code === 'Escape') window.__escKeys.push(e.type); };
      addEventListener('keydown', window.__escSpy, true); addEventListener('keyup', window.__escSpy, true);
    });
    const sent = await mainEval(INSPECT_PORT, `(() => {
      const { webContents } = require('electron');
      const w = webContents.getAllWebContents().find((x) => x.getURL().startsWith('http://127.0.0.1:${APP_PORT}/'));
      if (!w) return 'no webContents';
      w.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      w.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      return 'sent';
    })()`).catch((e) => `error: ${e.message}`);
    await sleep(600);
    const esc = await sA.page.evaluate(() => ({ calls: window.__relockCalls, keys: window.__escKeys }));
    ok(sent === 'sent' && esc.calls === 1, `네이티브 Escape key-up 한 번에 메인 프로세스가 __scavShellRelock 을 정확히 한 번 부른다 (${esc.calls})`, String(sent));
    ok(JSON.stringify(esc.keys) === '["keydown","keyup"]', `그 Escape 는 페이지에 keydown · keyup 한 번씩만 닿는다 (합성 전달 없음)`, JSON.stringify(esc.keys));
    await sA.page.evaluate(() => {
      window.__scavShellRelock = window.__relockOrig; delete window.__relockOrig;
      removeEventListener('keydown', window.__escSpy, true); removeEventListener('keyup', window.__escSpy, true);
    });
  }
  checkNoServerPorts('boot A', A.child.pid, APP_PORT);

  console.log('desktop: 2 프록시 (--relay)');
  const routeA = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(routeA?.target === PROXY_URL && routeA?.source === '--relay' && routeA?.embedded === false, '--relay: /__scav/relay 가 그 주소와 출처 --relay 를 준다 (embedded false)', JSON.stringify(routeA));
  await connectThroughProxy('--relay', sA);
  {
    // The store writes on a 1 s debounce — so it waits a moment.
    const file = join(RELAY_DATA, 'profiles.json');
    for (let i = 0; i < 40 && !existsSync(file); i++) await sleep(150);
    ok(existsSync(file), '프로필은 스모크 릴레이의 저장 폴더에 생긴다 (profiles.json)');
    ok(!existsSync(join(UD1, 'relay-data')), 'userData 에는 relay-data 가 없다 (셸 안의 서버가 없다)');
  }
  ok(A.out.includes(`relay proxy -> ${PROXY_URL}  (--relay)`), '메인 프로세스 로그: relay proxy -> 그 주소 (--relay)', A.out.trim() ? '' : '(stdout 이 비었다)');

  // Preparing step 4: a mark in this origin's localStorage + the tutorial marked done (the next boot enters
  // the ship).
  const runId = `run-${Date.now().toString(36)}`;
  await sA.page.evaluate((k, v) => {
    localStorage.setItem(k, v);
    localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 2, tracks: { raid: { step: null, done: true }, ship: { step: null, done: true }, build: { step: null, done: true } } }));
  }, MARK_KEY, runId);
  ok(sA.errors.length === 0, `페이지 오류 0 (boot A)`, sA.errors.slice(0, 3).join(' | '));
  await closeApp('boot A', A, sA);
  ok(existsSync(join(UD1, 'Local Storage')), 'localStorage 가 임시 userData 에 있다 (Local Storage/)');
  await relayClientsBackToZero('--relay');

  /* ── 3. this PC's server (--local) + 4. save = window port + 5. single instance ── */
  console.log('desktop: 3 이 PC 의 서버 (--local 이 --relay 를 이긴다) · 4 세이브 = 창 포트 (같은 포트 재부팅)');
  const D = launch('boot D', ELECTRON, electronArgs('--local', `--relay=${PROXY_URL}`, `--app-port=${APP_PORT}`, `--user-data=${UD1}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sD = await attach(D);
  for (const pid of descendants(D.child.pid)) trackedPids.add(pid);
  const routeD = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(routeD?.target === LOCAL_SERVER && routeD?.embedded === false && /이 PC 의 서버/.test(routeD?.source ?? '') && !/내장/.test(routeD?.source ?? ''),
    `--local: /__scav/relay 가 이 PC 의 서버(${LOCAL_SERVER}) 를 준다 — 내장 서버가 아니다 (embedded false)`, JSON.stringify(routeD));
  ok(D.out.includes(`relay proxy -> ${LOCAL_SERVER}`), `메인 프로세스 로그: relay proxy -> ${LOCAL_SERVER}`, D.out.trim() ? '' : '(stdout 이 비었다)');
  checkNoServerPorts('boot D', D.child.pid, APP_PORT);
  ok(sD.origin === `http://127.0.0.1:${APP_PORT}`, `같은 --app-port 로 다시 떠 오리진이 같다 (${sD.origin})`);
  const markD = await sD.page.evaluate((k) => localStorage.getItem(k), MARK_KEY);
  ok(markD === runId, '정상 종료 뒤 같은 창 포트로 재부팅하면 localStorage 표식이 그대로 있다', `${markD} vs ${runId}`);

  // isDesktopShell() is true with no mimic — in the ship, when nobody owns the cursor, only the shell turns
  // body.desktop-nocursor on.
  await sD.page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(sD.page, () => window.__game.ctx.phase === 'hub', 'hub', 30000);
  const cur = await waitFor(sD.page, () => {
    const c = window.__game.ctx;
    return document.body.classList.contains('desktop-nocursor') ? { cursor: c.input.isCursorMode, mimic: typeof window.__scavDesktop, gate: !!document.querySelector('.resume-gate:not(.hidden)') } : null;
  }, 'desktop-nocursor', 15000).catch(async () => sD.page.evaluate(() => ({ missing: true, cursor: window.__game.ctx.input.isCursorMode, blockers: [...window.__game.ctx.uiBlockers] })));
  ok(!cur.missing && cur.mimic === 'undefined', '함선에서 body.desktop-nocursor 가 켜진다 — isDesktopShell() 이 흉내 없이 true', JSON.stringify(cur));
  {
    // Entering the ship tries to connect over same-origin /ws → 8787. It connects when a shared relay is up,
    // and is offline + a background probe when it is not.
    // Either way the shell target must never be read as "embedded" and turn the probe off (2026-09-15).
    const linkD = await waitFor(sD.page, () => {
      const n = window.__game.getSystem('net');
      const l = n.link;
      if (l.state === 'connected' || (l.state === 'unreachable' && typeof l.nextProbeInMs === 'number')) return { state: l.state, embedded: l.embedded ?? null, probing: n.probeTimer !== null, url: l.url };
      return null;
    }, 'link connected | unreachable+probe', 20000).catch(async () => sD.page.evaluate(() => ({ timeout: true, ...window.__game.getSystem('net').link })));
    ok(!linkD.timeout && !linkD.embedded && (linkD.state === 'connected' || linkD.probing),
      `--local: 링크는 8787 에 붙거나(공용 릴레이가 있을 때) 오프라인 + 배경 프로브다 — embedded 없음 (${linkD.state})`, JSON.stringify(linkD));
  }

  console.log('desktop: 5 단일 인스턴스');
  const second = launch('second instance', ELECTRON, electronArgs('--local', `--app-port=${APP_PORT_2}`, `--user-data=${UD1}`), { cwd: EMPTY_CWD });
  const secondExit = await Promise.race([second.exited, sleep(20000).then(() => null)]);
  ok(secondExit !== null && secondExit.code === 0, `같은 userData 로 두 번째 실행은 곧바로 exit 0 으로 끝난다`, JSON.stringify(secondExit));
  if (!secondExit) killTree(second.child.pid);
  ok(pidsOnPort(APP_PORT_2).length === 0, `두 번째 실행은 창 서버(${APP_PORT_2})를 열지 않았다`);
  const heard = await (async () => { for (let i = 0; i < 30; i++) { if (/second instance refused/.test(D.out)) return true; await sleep(100); } return false; })();
  ok(heard, '첫 실행이 second-instance 를 받았다 (메인 프로세스 로그)');
  ok(await sD.page.evaluate(() => window.__game.ctx.phase === 'hub').catch(() => false), '첫 실행의 창은 그대로 살아 있다');
  ok(sD.errors.length === 0, `페이지 오류 0 (boot D)`, sD.errors.slice(0, 3).join(' | '));
  await closeApp('boot D', D, sD);

  console.log('desktop: 4 세이브 = 창 포트 (다른 포트)');
  const E = launch('boot E', ELECTRON, electronArgs('--local', `--app-port=${APP_PORT_2}`, `--user-data=${UD1}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sE = await attach(E);
  for (const pid of descendants(E.child.pid)) trackedPids.add(pid);
  ok(sE.origin === `http://127.0.0.1:${APP_PORT_2}`, `--app-port=${APP_PORT_2} 면 오리진이 바뀐다 (${sE.origin})`);
  const markE = await sE.page.evaluate((k) => localStorage.getItem(k), MARK_KEY);
  ok(markE === null, '같은 userData 라도 다른 창 포트(오리진)에서는 표식이 없다 — 창 포트가 곧 세이브다', String(markE));
  await closeApp('boot E', E, sE);

  /* ── 6. server.txt ──────────────────────────────────────────────────── */
  console.log('desktop: 6 server.txt');
  // The temp folder as cwd (the `cwd` candidate in configDirs). BOM + comments + blank lines + a bare host:port.
  const cfgDir = join(TMP, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'server.txt'), `﻿# smoke-desktop — 주석과 빈 줄은 건너뛴다\n\n127.0.0.1:${PROXY_RELAY_PORT}\nws://10.255.255.1:1/ws\n`, 'utf8');
  const C = launch('boot C', ELECTRON, electronArgs(`--app-port=${APP_PORT}`, `--user-data=${UD2}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: cfgDir });
  const sC = await attach(C);
  for (const pid of descendants(C.child.pid)) trackedPids.add(pid);
  const routeC = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(routeC?.target === PROXY_URL && routeC?.source === 'server.txt' && routeC?.embedded === false,
    'server.txt: 구워진 LAN 주소보다 먼저 걸리고 host:port 가 ws://…/ws 로 채워진다 (embedded false)', JSON.stringify(routeC));
  await connectThroughProxy('server.txt', sC);
  ok(C.out.includes(join(cfgDir, 'server.txt')), 'server.txt: 메인 프로세스 로그가 읽은 파일 경로(cwd 후보)를 적는다', C.out.trim() ? '' : '(stdout 이 비었다)');
  ok(sC.errors.length === 0, `페이지 오류 0 (boot C)`, sC.errors.slice(0, 3).join(' | '));
  await closeApp('boot C', C, sC);
  await relayClientsBackToZero('server.txt');

  /* ── 7. the deploy folder (--release) ──────────────────────────── */
  if (RELEASE) {
    console.log('desktop: 7 배포 폴더 (--release)');
    const rel = RELEASE_DIR ? RELEASE_DIR : join(ROOT, 'release', 'SCAVANGER');
    const asar = join(rel, 'app', 'resources', 'app.asar');
    const asarFresh = () => existsSync(asar) && readFileSync(asar).includes('SCAV_USER_DATA') && mtime(asar) >= mtime(join(ROOT, 'dist-electron', 'main.js'));
    if (!asarFresh() && (NO_BUILD || RELEASE_DIR)) {
      console.log('  note: 배포본이 없거나 오래됐는데 --no-build / --release-dir 다 — app:dist 를 돌리지 않는다 (배포 폴더를 덮어쓰지 않는다)');
    } else if (!asarFresh()) {
      console.log('  note: 배포본이 없거나 오래됐다 — npm run app:dist (수 분)');
      const npm = isWin ? 'npm.cmd' : 'npm';
      const t = Date.now();
      const r = spawnSync(npm, ['run', 'app:dist'], { cwd: ROOT, encoding: 'utf8', shell: isWin, timeout: 20 * 60_000, windowsHide: true });
      console.log(`  ${r.status === 0 ? 'built' : 'FAIL '} npm run app:dist (${Math.round((Date.now() - t) / 1000)} s)`);
      if (r.status !== 0) console.log(String((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').slice(-15).map((l) => `      | ${l}`).join('\n'));
    }
    const entries = existsSync(rel) ? readdirSync(rel).sort() : [];
    ok(JSON.stringify(entries) === JSON.stringify(['SCAVANGER.exe', 'app', 'server.txt']),
      'release/SCAVANGER/ 에는 정확히 셋 (app/ · SCAVANGER.exe · server.txt) — 서버 exe 없음', JSON.stringify(entries));
    const serverTxt = existsSync(join(rel, 'server.txt')) ? readFileSync(join(rel, 'server.txt'), 'utf8') : '';
    ok(serverTxt.includes('start-server.bat') && !serverTxt.includes('SCAVANGER-Server') && !serverTxt.includes('자기 안의 서버'),
      'server.txt 주석이 start-server.bat 를 말하고 내장 서버 · 서버 exe 를 말하지 않는다');
    if (!asarFresh()) {
      ok(false, '배포본의 app.asar 가 --user-data 를 안다 (모르면 사용자의 세이브를 쓰므로 띄우지 않는다)');
    } else {
      const asarBuf = readFileSync(asar);
      ok(!RELAY_CODE.test(asarBuf.toString('latin1')), 'app.asar 에 릴레이 코드가 없다');
      ok(!asarBuf.includes('"node_modules"'), 'app.asar 에 node_modules 가 없다 (ws 를 싣지 않는다)');
      const UD3 = join(TMP, 'ud-release');
      const stub = launch('stub', join(rel, 'SCAVANGER.exe'),
        ['--hidden', `--relay=${PROXY_URL}`, `--app-port=${APP_PORT}`, `--user-data=${UD3}`, `--remote-debugging-port=${DEBUG_PORT}`], { cwd: EMPTY_CWD });
      const stubExit = await Promise.race([stub.exited, sleep(15000).then(() => null)]);
      ok(stubExit?.code === 0, 'stub SCAVANGER.exe 가 app\\SCAVANGER.exe 를 띄우고 exit 0', JSON.stringify(stubExit));
      const sR = await attach(null);
      const appPid = pidsOnPort(APP_PORT)[0];
      const plist = processList();
      for (const pid of descendants(appPid, plist)) trackedPids.add(pid);
      const appProc = plist.find((p) => p.pid === appPid);
      ok(!!appProc && /\\app\\SCAVANGER\.exe/i.test(appProc.cmd) && appProc.cmd.includes(UD3) && /--remote-debugging-port=9340/.test(appProc.cmd),
        'stub 이 인자를 그대로 넘겼다 (app\\SCAVANGER.exe --user-data=… --remote-debugging-port=…)', appProc?.cmd ?? `(pid ${appPid})`);
      ok(sR.origin === `http://127.0.0.1:${APP_PORT}`, `배포본: 오리진 ${sR.origin}`);
      const bootR = await sR.page.evaluate(() => ({ ctx: !!window.__game?.ctx, ua: navigator.userAgent, mimic: typeof window.__scavDesktop, relock: typeof window.__scavShellRelock }));
      ok(bootR.ctx && /\bElectron\//.test(bootR.ua) && bootR.mimic === 'undefined' && bootR.relock === 'function',
        '배포본: window.__game.ctx · UA Electron/ · 흉내 없음 · __scavShellRelock', JSON.stringify({ ...bootR, ua: bootR.ua.match(/Electron\/[\d.]+/)?.[0] }));
      const routeR = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
      ok(routeR?.target === PROXY_URL && routeR?.embedded === false, '배포본: /__scav/relay 가 --relay 주소를 준다 (embedded false)', JSON.stringify(routeR));
      if (appPid) checkNoServerPorts('배포본', appPid, APP_PORT);
      await closeApp('release app', null, sR, { pid: appPid });
    }
  }
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message.split('\n')[0]}`);
  if (e.message.includes('\n')) console.log(e.message.split('\n').slice(1).join('\n'));
} finally {
  /* ── end: leftover processes · ports · temp folder ───────── */
  console.log('desktop: 정리');
  if (proxyRelay && !proxyRelay.exit) {
    proxyRelay.child.kill();
    await Promise.race([proxyRelay.exited, sleep(5000)]);
    if (!proxyRelay.exit) killTree(proxyRelay.child.pid);
  }
  for (const h of [...launched]) {
    console.log(`  note: ${h.label} (pid ${h.child.pid}) 가 아직 살아 있다 — 죽인다`);
    killTree(h.child.pid);
  }
  await sleep(500);
  let leftovers = processList().filter((p) => p.cmd.includes(TAG) || (trackedPids.has(p.pid) && /electron|SCAVANGER/i.test(p.name)));
  for (let i = 0; i < 20 && leftovers.length; i++) {
    await sleep(250);
    leftovers = processList().filter((p) => p.cmd.includes(TAG) || (trackedPids.has(p.pid) && /electron|SCAVANGER/i.test(p.name)));
  }
  ok(leftovers.length === 0, '이 스모크가 띄운 Electron · 릴레이 프로세스가 하나도 남지 않았다', leftovers.map((p) => `${p.name}:${p.pid}`).join(' '));
  for (const p of leftovers) killTree(p.pid);
  const busy = await waitPortsFree(OUR_PORTS, 5000);
  ok(busy.length === 0, `포트 ${OUR_PORTS.join(' · ')} 가 전부 비었다`, busy.join(','));
  let removed = false;
  for (let i = 0; i < 10 && !removed; i++) {
    try { rmSync(TMP, { recursive: true, force: true }); removed = true; } catch { await sleep(300); }
  }
  if (!removed) console.log(`  note: 임시 폴더를 지우지 못했다 (${TMP}) — 파일 잠금, %TEMP% 에 남는다`);
  console.log(`\nsmoke-desktop: ${Math.round((Date.now() - t0All) / 1000)} s`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
