#!/usr/bin/env node
/**
 * 데스크톱 셸(`electron/`)을 **진짜 Electron 으로** 띄워 검사한다 (E-3, 2026-09-11).
 *
 * 브라우저 스모크는 `window.__scavDesktop = true` 로 셸을 *흉내* 낸다 — 그래서 셸 쪽 코드(창 서버 · `/ws` 프록시 ·
 * 임베디드 릴레이 지연 시작 · 릴레이 주소 결정 · 창 포트 = 세이브 오리진 · 단일 인스턴스 락)는 지금까지 사람이
 * CDP 로 붙어 손으로만 확인했다 (`electron/README.md` · `docs/VERIFICATION.md` 의 수동 기록). 이 스크립트가 그 절차다.
 *
 *   0. 준비   `dist/` 가 `src/` · `data/` 보다, `dist-electron/main.js` 가 `electron/` · `server/` · `src/shared/` 보다
 *             오래됐으면 다시 굽는다 (`vite build` + `node electron/build.mjs` — `npm run app:build` 에서 tsc 만 뺐다:
 *             타입 검사는 러너의 1단계가 하고, 남의 폴더의 반쯤 된 타입 에러로 셸 검사가 막히지 않게).
 *   1. 부팅   `electron.exe <repo> --local --hidden --lazy-relay --app-port=8820 --port=8821 --user-data=<tmp>
 *             --remote-debugging-port=9340` → `/json/version` → puppeteer-core `connect` → `127.0.0.1:8820` 페이지.
 *             `window.__game.ctx` · UA `Electron/` · `__scavDesktop` 흉내 없음 · `__scavShellRelock` 설치 ·
 *             숨긴 창에서도 시뮬레이션이 돈다 · 메인 프로세스 인스펙터(`--inspect=9341`)로 `webContents.sendInputEvent`
 *             Escape 를 넣으면 `before-input-event` → `__scavShellRelock` 이 정확히 한 번 · 페이지는 키를 한 번씩만 받는다.
 *   2. 지연 릴레이 (C-28)   접속 전 `8821/health` 거절 · `/__scav/relay` = `(필요할 때 켜짐)` → `ensureConnected()` →
 *             welcome · 이제 `/health` 응답 · 프로필 저장소가 임시 userData 안에 생긴다.
 *   3. 프록시 모드   스모크가 8823 에 릴레이를 띄우고 `--relay=ws://127.0.0.1:8823/ws` 로 재부팅 → 렌더러는 같은 오리진
 *             `/ws` 인데 그 릴레이의 `clients === 1`. 같은 것을 `server.txt`(임시 폴더 = `cwd` 후보, BOM + 주석 + 맨
 *             `host:port`)로 한 번 더.
 *   4. 세이브 = 창 포트   localStorage 표식 → CDP `Browser.close` 정상 종료 → 같은 `--app-port` 재부팅 → 표식 있음 ·
 *             `--app-port=8822` → 없음. 재부팅은 `--lazy-relay` 없이 `--port` 만 줘서 **즉시 시작**(C-28 의 다른 가지)도 본다.
 *             함선에 들어가 `body.desktop-nocursor` 가 켜지는 것으로 `isDesktopShell()` 이 흉내 없이 true 임을 확인한다.
 *   5. 단일 인스턴스   같은 userData 로 두 번째 실행 → 곧바로 exit 0 · 첫 창에 `second-instance` · 8822 를 안 연다.
 *   6. `--release` 일 때만: `release/SCAVANGER/` 가 정확히 넷 · stub `SCAVANGER.exe` 가 인자(`--hidden --user-data=…
 *             --remote-debugging-port=…`)를 넘겨 1번 단언이 통과. 배포본이 오래됐으면 `npm run app:dist` 를 돈다(수 분).
 *   끝  띄운 Electron · 릴레이 프로세스 0 · 포트 전부 해제 · 출력 `N passed, M failed` + `FAIL` 줄 (verify 러너 파서).
 *
 * 포트 (다른 러너와 겹치지 않게 고정 — `smoke-server-dist` 주석과 같은 표):
 *   8787 공용 릴레이 · 8790–8799 **사용자의 실제 세이브 오리진(절대 안 쓴다)** · 8820 창 · 8821 임베디드 릴레이 · 8822 두 번째
 *   창 오리진 · 8823 프록시 모드용 외부 릴레이 (8824–8829 여분) · 9340 원격 디버깅(렌더러 CDP) · 9341 메인 프로세스 Node
 *   인스펙터 · 8830–8869 smoke-server-dist.
 *   시작할 때 이 포트가 막혀 있으면 — 이 스크립트가 남긴 것(명령줄에 `scav-desktop-`)만 죽이고, 아니면 아무것도 안 하고 실패한다.
 *
 * 셸 제약을 이렇게 비켜 간다:
 *   - `electron/default-relay.txt` 에 LAN IP 가 구워져 있다 → 임베디드 경로는 전부 `--local`, 프록시 경로는 `--relay` /
 *     `server.txt` 가 구운 값보다 먼저 걸린다. 자식 환경에서 `SCAV_*` · `PORTABLE_EXECUTABLE_DIR` · `ELECTRON_RUN_AS_NODE` 를 지운다.
 *   - 단일 인스턴스 락 · localStorage · 창 상태 · 임베디드 릴레이 프로필은 전부 userData 에 있다 → `--user-data=<임시>` 로
 *     격리한다. 사용자가 켜 둔 SCAVANGER 도, `%APPDATA%/SCAVANGER` 도 건드리지 않는다.
 *   - preload 가 없다 → 페이지에 셸 표식이 없고 UA 가 유일한 단서다. 헤드리스가 안 된다 → `--hidden`(창만 숨기고 렌더링은 계속).
 *
 * **자동화로 증명하지 못하는 것** (기록된 한계 — `electron/README.md` "Escape" 절):
 *   - 진짜 Escape · 포인터 락 타이밍. CDP 로 넣은 키(`Input.dispatchKeyEvent`)는 Chromium 의 exclusive-access 경로를 타지
 *     않아 락을 쥔 채 페이지에 그대로 들어가고, **`before-input-event` 도 타지 않는다**(측정: 페이지는 받고 훅은 0 번).
 *     그래서 1번은 메인 프로세스의 `sendInputEvent` 로 넣는데, 숨긴 창은 포커스가 없어 포인터 락을 잡을 수 없으므로
 *     "Escape 로 락을 푼 직후 ≈1.25초 재요청 거부" 쿨다운과 `shared/Input` 의 미루기는 여전히 재지 못한다. 여기서 보는
 *     것은 **배선**뿐이다 — Escape key-up 이 `before-input-event` → `executeJavaScript(…, true)` → `window.__scavShellRelock`
 *     까지 닿는지. 락이 실제로 돌아오는 시각은 `docs/VERIFICATION.md` 2026-09-10 의 계측이 원본이다.
 *   - 숨긴 창은 포커스 · 전체화면 · 창 상태 복원(`windowState.ts`)을 보지 못한다. 강제 종료(작업 관리자) 뒤 세이브 유지
 *     (`flushStorageData`)도 여기서는 재지 않는다 — 정상 종료만.
 *
 * Usage: node scripts/smoke-desktop.mjs [--no-build | --build] [--release]
 *        (verify 러너가 넘기는 vite URL 인자는 무시한다 — vite 도 공용 릴레이도 쓰지 않는다)
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
/** `--release-dir=<폴더>` = 다른 곳에 만든 배포 폴더를 검사한다 (그때는 app:dist 를 절대 돌리지 않는다). */
const RELEASE_DIR = args.find((a) => a.startsWith('--release-dir='))?.slice('--release-dir='.length) ?? null;
const RELEASE = args.includes('--release') || !!RELEASE_DIR;
const NO_BUILD = args.includes('--no-build');
const FORCE_BUILD = args.includes('--build');

const APP_PORT = 8820;
const RELAY_PORT = 8821;
const APP_PORT_2 = 8822;
const PROXY_RELAY_PORT = 8823;
const DEBUG_PORT = 9340;
const OUR_PORTS = [APP_PORT, RELAY_PORT, APP_PORT_2, PROXY_RELAY_PORT, DEBUG_PORT, 9341];
/** 이 문자열이 명령줄에 있으면 이 스크립트가 띄운 프로세스다 (임시 폴더 접두어). */
const TAG = 'scav-desktop-';
/** `scav.` 로 시작하면 안 된다 — `shared/saveSlot` 이 부팅 때 옛 단일 키를 `scav.s1.*` 로 옮겨 "사라진 것처럼" 보인다. */
const MARK_KEY = 'smokeDesktop.mark';
/** 메인 프로세스(Node) 인스펙터 — `webContents.sendInputEvent` 로 CDP 가 아닌 **네이티브 입력 경로**의 Escape 를 넣는다. */
const INSPECT_PORT = 9341;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 프로세스 · 포트 ─────────────────────────────────────────────────── */
const ELECTRON = (() => { try { return createRequire(import.meta.url)('electron'); } catch { return null; } })();

function pidsOnPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    return [...new Set(out.split('\n').map((l) => l.match(re)?.[1]).filter((p) => p && p !== '0'))].map(Number);
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean).map(Number);
}
/** [{pid, ppid, name, cmd}] — electron · 배포 exe · node 만 (전체 목록은 느리다). */
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
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : { httpStatus: r.status }; } catch { return null; }
}

/**
 * 메인 프로세스에서 식을 돌린다 (`--inspect=<port>` 로 띄운 Electron 의 Node 인스펙터). 번들이 ESM 이라 `import()` 는
 * 인스펙터 문맥에서 막혀 있고(`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), `includeCommandLineAPI` 가 주는 `require` 로
 * `electron` 을 얻는다.
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

/** 이 스크립트가 띄운 것 — 끝나면 전부 확인하고 남았으면 죽인다. */
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
 * 원격 디버깅 포트에 붙어 창 서버의 페이지를 잡는다. `appPid` 를 알면(`h` 가 stub 이면 모른다) 그 자손을 추적 목록에 넣는다.
 * `h.exit` 가 먼저 오면 곧바로 던진다 — 부팅 실패를 60 초 기다리지 않는다.
 */
async function attach(h, { debugPort = DEBUG_PORT, early = true } = {}) {
  const t0 = Date.now();
  let version = null;
  while (!version && Date.now() - t0 < 45000) {
    if (early && h?.exit) throw new Error(`${h.label} 이 부팅 중에 끝났다 (exit ${h.exit.code})\n${tail(h)}`);
    // 메인 번들이 로드에서 죽으면 Electron 은 오류 대화상자를 띄운 채 살아 있다 — 기다리지 않고 곧바로 끝낸다.
    if (h && /App threw an error during load|Error launching app|A JavaScript error occurred in the main process/.test(h.out)) {
      killTree(h.child.pid);
      throw new Error(`${h.label}: 메인 프로세스 번들이 로드 중에 죽었다 (dist-electron/main.js — 다른 작업이 반쯤 된 코드일 수 있다)\n${tail(h)}`);
    }
    version = await getJson(`http://127.0.0.1:${debugPort}/json/version`, 1000);
    if (!version) await sleep(200);
  }
  if (!version) throw new Error(`${debugPort}/json/version 이 45 초 안에 응답하지 않았다${h ? `\n${tail(h)}` : ''}`);
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

/** CDP `Browser.close` → Electron 이 창을 닫고 `window-all-closed` → `app.quit()`. `pid` 가 끝날 때까지 기다린다. */
async function closeApp(label, h, s, { pid = h?.child.pid } = {}) {
  try { await Promise.race([s.browser.close(), sleep(8000)]); } catch { /* socket closed under us */ }
  const t0 = Date.now();
  const alive = () => (h ? !h.exit : processList().some((p) => p.pid === pid));
  while (alive() && Date.now() - t0 < 20000) await sleep(200);
  const exited = !alive();
  ok(exited && (!h || h.exit.code === 0), `${label}: CDP Browser.close 로 정상 종료한다`, h ? `(exit ${JSON.stringify(h.exit)})` : '');
  if (!exited) killTree(pid);
  const busy = await waitPortsFree(OUR_PORTS.filter((p) => p !== PROXY_RELAY_PORT));
  ok(busy.length === 0, `${label}: 종료 뒤 창 · 릴레이 · 디버깅 포트가 비었다`, busy.join(','));
}

/* ── 0. 준비 ───────────────────────────────────────────────────────────── */
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
let proxyRelay = null;
const t0All = Date.now();

try {
  if (!ELECTRON || !existsSync(ELECTRON)) throw new Error('node_modules/electron 이 없다 (npm install)');

  console.log('desktop: 0 준비');
  // 포트: 이 스크립트가 예전에 남긴 것만 치운다. 남의 것이면 건드리지 않고 실패한다.
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
  const mainSrc = Math.max(newestIn('electron', ['electron/resources']), newestIn('server', ['server/data']), newestIn('src/shared'));
  const needDist = FORCE_BUILD || (!NO_BUILD && distStamp < distSrc) || !distStamp;
  const needMain = FORCE_BUILD || (!NO_BUILD && mainStamp < mainSrc) || !mainStamp;
  if (!needDist && !needMain) console.log(`  note: ${NO_BUILD ? '--no-build' : 'dist/ · dist-electron/ 가 소스보다 새것이다'} — 빌드를 건너뛴다`);
  // 빌드는 실패할 때만 센다 — 돌았는지 여부로 `N passed` 가 실행마다 달라지지 않게.
  if (needDist && !runStep('vite build → dist/', process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])) ok(false, 'dist/ 를 굽는다 (vite build) — 옛 dist/ 로 계속한다');
  if (needMain && !runStep('electron/build.mjs → dist-electron/main.js', process.execPath, [join(ROOT, 'electron', 'build.mjs')])) ok(false, 'dist-electron/main.js 를 굽는다');
  if (!existsSync(join(ROOT, 'dist', 'index.html')) || !existsSync(join(ROOT, 'dist-electron', 'main.js'))) throw new Error('빌드 산출물이 없다 — 셸이 모달 다이얼로그로 멈추므로 띄우지 않는다');
  {
    const main = readFileSync(join(ROOT, 'dist-electron', 'main.js'), 'utf8');
    // 이 플래그를 모르는 옛 번들로 띄우면 사용자의 userData(세이브 · 단일 인스턴스 락)를 그대로 쓴다 — 절대 띄우지 않는다.
    if (!main.includes('SCAV_USER_DATA') || !main.includes('SCAV_HIDDEN')) throw new Error('dist-electron/main.js 가 --user-data · --hidden 을 모른다 (옛 번들) — --no-build 를 빼고 다시');
  }

  const UD1 = join(TMP, 'ud-embedded');
  const UD2 = join(TMP, 'ud-proxy');
  const electronArgs = (...flags) => [ROOT, '--hidden', ...flags];

  /* ── 1. 부팅 ────────────────────────────────────────────────────────── */
  console.log('desktop: 1 부팅 (--local --hidden --lazy-relay --app-port=8820 --port=8821 --user-data=<tmp>)');
  const A = launch('boot A', ELECTRON, electronArgs(`--inspect=${INSPECT_PORT}`, '--local', '--lazy-relay', `--app-port=${APP_PORT}`, `--port=${RELAY_PORT}`, `--user-data=${UD1}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sA = await attach(A);
  for (const pid of descendants(A.child.pid)) trackedPids.add(pid);
  ok(/Electron\//.test(sA.version['User-Agent'] ?? ''), `원격 디버깅 /json/version 이 Electron 이다 (${(sA.version['User-Agent'] ?? '').match(/Electron\/[\d.]+/)?.[0] ?? sA.version.Browser})`);
  ok(sA.origin === `http://127.0.0.1:${APP_PORT}`, `창의 오리진이 정확히 http://127.0.0.1:${APP_PORT} 다 (8790–8799 가 아니다)`, sA.origin);
  const bootA = await sA.page.evaluate(() => ({
    ctx: !!window.__game?.ctx,
    ua: navigator.userAgent,
    mimic: typeof window.__scavDesktop,
    relock: typeof window.__scavShellRelock,
    phase: window.__game?.ctx.phase,
    net: !!window.__game?.getSystem?.('net'),
  }));
  ok(bootA.ctx && bootA.net, 'window.__game.ctx 와 net 시스템이 있다');
  ok(/\bElectron\//.test(bootA.ua), 'navigator.userAgent 에 Electron/ 이 있다 (isDesktopShell 의 유일한 단서)');
  ok(bootA.mimic === 'undefined', 'window.__scavDesktop 흉내가 없다 (preload 없음 · 이 스모크도 심지 않았다)', bootA.mimic);
  ok(bootA.relock === 'function', 'window.__scavShellRelock 훅이 설치돼 있다', bootA.relock);
  {
    // 숨긴 창에서도 게임 루프가 돈다 — 스모크의 `__game.frame` fallback 없이. 단 **느리다**: 한 번도 보이지 않은 창은
    // 합성기가 프레임을 요구하지 않아 rAF 가 초당 ≈5 번이다 (2026-09-11 측정). 셸 검사에는 충분하고, 게임플레이를 재는
    // 검사를 여기 붙이려면 다른 스모크처럼 `__game.frame` 을 대신 불러야 한다.
    const t1 = await sA.page.evaluate(() => window.__game.ctx.time);
    const rafs = await sA.page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); })(); }));
    const t2 = await sA.page.evaluate(() => window.__game.ctx.time);
    ok(t2 > t1 && rafs >= 2, `--hidden 창에서도 게임 루프가 돈다 (ctx.time ${t1.toFixed(2)} → ${t2.toFixed(2)}, rAF ${rafs}/s)`);
  }
  {
    // 메인 프로세스의 `webContents.sendInputEvent` = CDP 가 아닌 네이티브 입력 경로. `before-input-event` →
    // `executeJavaScript(SHELL_RELOCK, true)` → 페이지 훅까지의 **배선**과, 키가 페이지에 정확히 한 번 닿는지를 본다.
    // (CDP `Input.dispatchKeyEvent` 는 `before-input-event` 를 아예 타지 않는다 — 측정: 페이지는 받고 훅은 0 번.)
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

  /* ── 2. 지연 릴레이 (C-28) ──────────────────────────────────────────── */
  console.log('desktop: 2 임베디드 릴레이 지연 시작');
  ok((await getJson(`http://127.0.0.1:${RELAY_PORT}/health`)) === null, `접속 전에는 ${RELAY_PORT}/health 가 거절된다 (릴레이가 아직 없다)`);
  ok(pidsOnPort(RELAY_PORT).length === 0, `접속 전에는 아무도 ${RELAY_PORT} 를 듣지 않는다`);
  const route0 = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(route0?.target === `ws://127.0.0.1:${RELAY_PORT}/ws` && /필요할 때 켜짐/.test(route0?.source ?? ''), '/__scav/relay 가 "(필요할 때 켜짐)" 기본값을 준다', JSON.stringify(route0));
  // `embedded` (2026-09-11) — 렌더러의 연결 UI(net/parts/Socket)가 라벨 문자열 대신 보는 필드. 프록시 경로(③)는 false.
  ok(route0?.embedded === true && route0?.source !== undefined, '/__scav/relay 의 embedded 가 true 다 (같은 오리진 /ws = 임베디드 릴레이, 켜지기 전에도)', JSON.stringify(route0));
  const conn = await sA.page.evaluate(async () => {
    const net = window.__game.getSystem('net');
    const res = await Promise.race([net.ensureConnected(), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    return { res, id: net.localId, connected: net.connected };
  });
  ok(conn.res === true && conn.connected && !!conn.id, `ensureConnected() → 같은 오리진 /ws → welcome (localId ${conn.id})`, JSON.stringify(conn));
  const h1 = await getJson(`http://127.0.0.1:${RELAY_PORT}/health`);
  ok(h1?.ok === true && h1.clients === 1, `첫 /ws 뒤에는 ${RELAY_PORT}/health 가 응답하고 clients 1`, JSON.stringify(h1));
  ok(pidsOnPort(RELAY_PORT).includes(A.child.pid), `${RELAY_PORT} 를 듣는 것이 이 Electron 메인 프로세스다`, `${pidsOnPort(RELAY_PORT)} vs ${A.child.pid}`);
  const route1 = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(route1?.target === `ws://127.0.0.1:${RELAY_PORT}/ws` && route1?.source === '이 PC 의 내장 서버' && route1?.embedded === true, '/__scav/relay 가 요청마다 지금 값을 준다 ("이 PC 의 내장 서버", embedded)', JSON.stringify(route1));
  {
    // 저장소는 1 초 디바운스로 쓴다 — 조금 기다린다.
    const file = join(UD1, 'relay-data', 'profiles.json');
    for (let i = 0; i < 40 && !existsSync(file); i++) await sleep(150);
    ok(existsSync(file), '임베디드 릴레이의 프로필 저장소가 임시 userData 안에 생겼다 (relay-data/profiles.json)');
  }

  // 4번 준비: 이 오리진의 localStorage 에 표식 + 튜토리얼 끝 표시 (다음 부팅에서 함선에 들어간다).
  const runId = `run-${Date.now().toString(36)}`;
  await sA.page.evaluate((k, v) => {
    localStorage.setItem(k, v);
    localStorage.setItem('scav.s1.tutorial', JSON.stringify({ version: 1, step: null, done: true }));
  }, MARK_KEY, runId);
  ok(sA.errors.length === 0, `페이지 오류 0 (boot A)`, sA.errors.slice(0, 3).join(' | '));
  await closeApp('boot A', A, sA);
  ok(existsSync(join(UD1, 'Local Storage')), 'localStorage 가 임시 userData 에 있다 (Local Storage/)');
  ok(/relay ws \/ws -> embedded relay \(starts on the first connection\)/.test(A.out), '메인 프로세스 로그: 부팅 때 릴레이를 켜지 않았다 (--lazy-relay)', A.out.trim() ? '' : '(stdout 이 비었다)');

  /* ── 4. 세이브 = 창 포트 + 5. 단일 인스턴스 ─────────────────────────── */
  console.log('desktop: 4 세이브 = 창 포트 (같은 포트 재부팅 — --port 즉시 시작)');
  const D = launch('boot D', ELECTRON, electronArgs('--local', `--app-port=${APP_PORT}`, `--port=${RELAY_PORT}`, `--user-data=${UD1}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sD = await attach(D);
  for (const pid of descendants(D.child.pid)) trackedPids.add(pid);
  const hEager = await getJson(`http://127.0.0.1:${RELAY_PORT}/health`);
  ok(hEager?.ok === true && hEager.clients === 0, `--port 만 주면(--lazy-relay 없이) 접속 전에도 ${RELAY_PORT}/health 가 응답한다 (C-28 즉시 시작)`, JSON.stringify(hEager));
  ok(sD.origin === `http://127.0.0.1:${APP_PORT}`, `같은 --app-port 로 다시 떠 오리진이 같다 (${sD.origin})`);
  const markD = await sD.page.evaluate((k) => localStorage.getItem(k), MARK_KEY);
  ok(markD === runId, '정상 종료 뒤 같은 창 포트로 재부팅하면 localStorage 표식이 그대로 있다', `${markD} vs ${runId}`);

  // isDesktopShell() 이 흉내 없이 true — 함선에서 커서 소유자가 없으면 셸만 body.desktop-nocursor 를 켠다.
  await sD.page.evaluate(() => window.__game.ctx.bus.emit('hub:enter', { ship: 'personal' }));
  await waitFor(sD.page, () => window.__game.ctx.phase === 'hub', 'hub', 30000);
  const cur = await waitFor(sD.page, () => {
    const c = window.__game.ctx;
    return document.body.classList.contains('desktop-nocursor') ? { cursor: c.input.isCursorMode, mimic: typeof window.__scavDesktop, gate: !!document.querySelector('.resume-gate:not(.hidden)') } : null;
  }, 'desktop-nocursor', 15000).catch(async () => sD.page.evaluate(() => ({ missing: true, cursor: window.__game.ctx.input.isCursorMode, blockers: [...window.__game.ctx.uiBlockers] })));
  ok(!cur.missing && cur.mimic === 'undefined', '함선에서 body.desktop-nocursor 가 켜진다 — isDesktopShell() 이 흉내 없이 true', JSON.stringify(cur));

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

  /* ── 3. 프록시 모드 ─────────────────────────────────────────────────── */
  console.log('desktop: 3 프록시 모드 (--relay · server.txt)');
  proxyRelay = launch('proxy relay', process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'index.ts'), `--data=${join(TMP, 'proxy-relay-data')}`],
    { cwd: ROOT, env: { ...cleanEnv(), PORT: String(PROXY_RELAY_PORT), HOST: '127.0.0.1' } });
  let hp = null;
  for (let i = 0; i < 80 && !hp; i++) { if (proxyRelay.exit) break; hp = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`); if (!hp) await sleep(150); }
  ok(hp?.ok === true && hp.clients === 0, `스모크가 띄운 외부 릴레이가 ${PROXY_RELAY_PORT} 에서 뜬다`, hp ? JSON.stringify(hp) : `\n${tail(proxyRelay)}`);
  if (!hp) throw new Error('외부 릴레이가 뜨지 않았다');

  const B = launch('boot B', ELECTRON, electronArgs(`--relay=ws://127.0.0.1:${PROXY_RELAY_PORT}/ws`, `--app-port=${APP_PORT}`, `--user-data=${UD2}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: EMPTY_CWD });
  const sB = await attach(B);
  for (const pid of descendants(B.child.pid)) trackedPids.add(pid);
  const routeB = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(routeB?.target === `ws://127.0.0.1:${PROXY_RELAY_PORT}/ws` && routeB?.source === '--relay' && routeB?.embedded === false, '--relay: /__scav/relay 가 그 주소와 출처 --relay 를 준다 (embedded false)', JSON.stringify(routeB));
  const connB = await sB.page.evaluate(async () => {
    const net = window.__game.getSystem('net');
    const res = await Promise.race([net.ensureConnected(), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    return { res, id: net.localId, origin: location.origin };
  });
  const hB = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`);
  ok(connB.res === true && !!connB.id && hB?.clients === 1, `--relay: 렌더러는 같은 오리진 /ws(${connB.origin}) 인데 외부 릴레이의 clients 가 1 이다`, `${JSON.stringify(connB)} ${JSON.stringify(hB)}`);
  ok(pidsOnPort(8787).every((pid) => !descendants(B.child.pid).includes(pid)), '--relay: 임베디드 릴레이를 켜지 않았다 (8787 을 이 앱이 쥐지 않는다)');
  ok(sB.errors.length === 0, `페이지 오류 0 (boot B)`, sB.errors.slice(0, 3).join(' | '));
  await closeApp('boot B', B, sB);
  {
    let c = null;
    for (let i = 0; i < 40; i++) { c = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`); if (c?.clients === 0) break; await sleep(150); }
    // 끊긴 소켓은 재접속 유예로 넘어간다 — clients 에서 빠지는 것만 본다.
    ok(c?.clients === 0, '--relay: 앱을 닫으면 외부 릴레이의 clients 가 0 으로 돌아온다', JSON.stringify(c));
  }

  // server.txt — 임시 폴더를 cwd 로 (configDirs 의 cwd 후보). BOM + 주석 + 빈 줄 + 맨 host:port.
  const cfgDir = join(TMP, 'cfg');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'server.txt'), `﻿# smoke-desktop — 주석과 빈 줄은 건너뛴다\n\n127.0.0.1:${PROXY_RELAY_PORT}\nws://10.255.255.1:1/ws\n`, 'utf8');
  const C = launch('boot C', ELECTRON, electronArgs(`--app-port=${APP_PORT}`, `--user-data=${UD2}`, `--remote-debugging-port=${DEBUG_PORT}`), { cwd: cfgDir });
  const sC = await attach(C);
  for (const pid of descendants(C.child.pid)) trackedPids.add(pid);
  const routeC = await getJson(`http://127.0.0.1:${APP_PORT}/__scav/relay`);
  ok(routeC?.target === `ws://127.0.0.1:${PROXY_RELAY_PORT}/ws` && routeC?.source === 'server.txt' && routeC?.embedded === false,
    'server.txt: 구워진 LAN 주소보다 먼저 걸리고 host:port 가 ws://…/ws 로 채워진다 (embedded false)', JSON.stringify(routeC));
  const connC = await sC.page.evaluate(async () => {
    const net = window.__game.getSystem('net');
    const res = await Promise.race([net.ensureConnected(), new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    return { res, id: net.localId };
  });
  const hC = await getJson(`http://127.0.0.1:${PROXY_RELAY_PORT}/health`);
  ok(connC.res === true && !!connC.id && hC?.clients === 1, 'server.txt: 같은 오리진 /ws 가 그 릴레이에 붙는다 (clients 1)', `${JSON.stringify(connC)} ${JSON.stringify(hC)}`);
  ok(C.out.includes(join(cfgDir, 'server.txt')), 'server.txt: 메인 프로세스 로그가 읽은 파일 경로(cwd 후보)를 적는다', C.out.trim() ? '' : '(stdout 이 비었다)');
  ok(sC.errors.length === 0, `페이지 오류 0 (boot C)`, sC.errors.slice(0, 3).join(' | '));
  await closeApp('boot C', C, sC);

  proxyRelay.child.kill();
  await Promise.race([proxyRelay.exited, sleep(5000)]);
  if (!proxyRelay.exit) killTree(proxyRelay.child.pid);

  /* ── 6. 배포 폴더 (--release) ──────────────────────────────────────── */
  if (RELEASE) {
    console.log('desktop: 6 배포 폴더 (--release)');
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
    ok(JSON.stringify(entries) === JSON.stringify(['SCAVANGER-Server.exe', 'SCAVANGER.exe', 'app', 'server.txt']),
      'release/SCAVANGER/ 에는 정확히 넷 (app/ · SCAVANGER.exe · server.txt · SCAVANGER-Server.exe)', JSON.stringify(entries));
    if (!asarFresh()) {
      ok(false, '배포본의 app.asar 가 --user-data 를 안다 (모르면 사용자의 세이브를 쓰므로 띄우지 않는다)');
    } else {
      const UD3 = join(TMP, 'ud-release');
      const stub = launch('stub', join(rel, 'SCAVANGER.exe'),
        ['--local', '--hidden', '--lazy-relay', `--app-port=${APP_PORT}`, `--port=${RELAY_PORT}`, `--user-data=${UD3}`, `--remote-debugging-port=${DEBUG_PORT}`], { cwd: EMPTY_CWD });
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
      ok(pidsOnPort(RELAY_PORT).length === 0, '배포본: --lazy-relay 라 접속 전 임베디드 릴레이 없음');
      await closeApp('release app', null, sR, { pid: appPid });
    }
  }
} catch (e) {
  fail++;
  console.log(`  FAIL ${e.message.split('\n')[0]}`);
  if (e.message.includes('\n')) console.log(e.message.split('\n').slice(1).join('\n'));
} finally {
  /* ── 끝: 남은 프로세스 · 포트 · 임시 폴더 ─────────────────────────────── */
  console.log('desktop: 정리');
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
