/**
 * SCAVANGER desktop (Electron) main process.
 *
 * One process runs the whole game: it serves the vite build from a small http server of its own, points a single
 * BrowserWindow at `http://127.0.0.1:<APP_PORT>/` and forwards that origin's `/ws` to whichever relay is in play —
 * the **embedded relay** (`server/RelayServer.ts`, loopback) is started on the first `/ws` upgrade (C-28,
 * 2026-09-11; `--lan` / `--port` start it at boot). Loading over http instead of `file://` is what keeps
 * `src/` untouched — the renderer's same-origin `/ws` lands on the relay exactly like it does behind the vite proxy,
 * so profiles, raid sessions and the social store all work offline.
 *
 * The window's port is **fixed and never OS-chosen**: localStorage (every character, the stash, `scav.sessionToken`)
 * is keyed by origin, so a port that moves between launches wipes the save. See `APP_PORT`.
 *
 * A distributed build normally points at ONE relay somebody else runs (`SCAVANGER-Server.exe`), so the address is
 * resolved from four places, first hit wins — flag, env, a `server.txt` the player can edit next to the exe, then the
 * address baked in at build time (`SCAV_DEFAULT_RELAY=… npm run app:dist`). Nothing configured at all = embedded
 * relay, i.e. the offline single-machine build. `--local` forces that even when an address is configured.
 *
 * **2026-09-10 — 게임 안 `설정 › 서버 설정` 이 이 넷 전부보다 위다.** 그것은 렌더러의 localStorage
 * (`shared/net` `RELAY_STORAGE_KEY`)에 있고 `NetSystem.defaultUrl()` 이 같은 오리진 `/ws` 대신 그 주소로
 * 곧장 붙으므로, 여기서 고른 주소는 그때 **쓰이지 않는다** — 여기서 고른 것은 *기본값*이다. 그 기본값이
 * 무엇인지 설정 화면이 보여 줄 수 있게 `RELAY_ROUTE` 로 알려 준다.
 *
 * CLI / env (both accepted; the flag wins):
 *   --port=<n>         SCAV_PORT       embedded relay port (default NET_DEFAULT_PORT, falls back to a free port)
 *   --app-port=<n>     SCAV_APP_PORT   the window's own http port (default 8790) — changing it starts a fresh save
 *   --lan              SCAV_LAN=1      bind 0.0.0.0 so other machines on the LAN can use this relay (firewall prompt)
 *   --relay=<ws url>   SCAV_RELAY      start no relay; proxy /ws to an existing one (ws://192.168.0.5:8787/ws)
 *   --local            SCAV_LOCAL=1    ignore every configured relay and run the embedded one (offline / solo)
 *   --devtools         SCAV_DEVTOOLS=1 enable DevTools (F12 / Ctrl+Shift+I); off in a normal build
 *
 * Test isolation (E-3, 2026-09-11 — `scripts/smoke-desktop.mjs`; a player never needs these):
 *   --user-data=<dir>  SCAV_USER_DATA  userData 를 옮긴다 — localStorage(세이브) · 단일 인스턴스 락 · 임베디드 릴레이
 *                                      프로필 · 창 상태가 전부 그 폴더로 간다. 켜 둔 게임도 사용자의 세이브도 건드리지 않는다
 *   --hidden           SCAV_HIDDEN=1   창을 보이지 않는다 (페이지는 계속 돈다 — 단 한 번도 보인 적 없는 창이라 rAF 가 초당 3–5 번)
 *   --lazy-relay       SCAV_LAZY_RELAY=1  `--port` 를 줘도 임베디드 릴레이를 첫 `/ws` 까지 미룬다 — 고정 포트로 C-28
 *                                      지연 시작을 재려는 테스트용 (`--port` 만 주면 "이 PC 가 서버다" 라 곧바로 켠다)
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { startRelayServer, type RelayServer } from '../server/RelayServer.ts';
import { NET_DEFAULT_PORT, NET_SHELL_RELAY_ROUTE, NET_WS_PATH, relayUrlFrom } from '../src/shared/net.ts';
import { attachStatic } from './static.ts';
import { attachWsProxy, type LazyProxyTarget } from './wsProxy.ts';
import { loadWindowState, trackWindowState } from './windowState.ts';

app.setName('SCAVANGER');

/* ── options ──────────────────────────────────────────────────────────── */
const argv = process.argv.slice(1);
const flag = (name: string, env: string): boolean =>
  argv.includes(`--${name}`) || process.env[env] === '1' || process.env[env] === 'true';
const value = (name: string, env: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : process.env[env];
};

const wantPort = Number(value('port', 'SCAV_PORT') ?? NET_DEFAULT_PORT) || NET_DEFAULT_PORT;
const lan = flag('lan', 'SCAV_LAN');
const devtools = flag('devtools', 'SCAV_DEVTOOLS');
const local = flag('local', 'SCAV_LOCAL');
/** Diagnostics: leave Escape to Chromium (no forward, no re-lock) — the behaviour before Phase 12. */
const rawEscape = flag('raw-escape', 'SCAV_RAW_ESCAPE');
/** E-3: 창을 띄우지 않는다 (스모크가 작업 중인 화면을 가리지 않게). */
const hidden = flag('hidden', 'SCAV_HIDDEN');
/** E-3: `--port` 가 있어도 임베디드 릴레이를 지연 시작한다 (아래 `eagerEmbedded`). */
const lazyRelay = flag('lazy-relay', 'SCAV_LAZY_RELAY');

/* E-3 (2026-09-11) — userData 격리. **`requestSingleInstanceLock` 과 `app.ready` 보다 먼저** 여야 한다: 락 ·
 * 세션 저장소(localStorage) 경로가 그때 정해진다. `setPath` 는 없는 폴더를 거절하므로 먼저 만든다. */
const userDataArg = value('user-data', 'SCAV_USER_DATA');
if (userDataArg) {
  const dir = resolvePath(userDataArg);
  mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
}

/* ── which relay do we talk to? ───────────────────────────────────────── */

/** Address compiled in by `electron/build.mjs` (`SCAV_DEFAULT_RELAY`); the empty string when the build set none. */
declare const __SCAV_DEFAULT_RELAY__: string;

/**
 * Plain-text override the player can edit without a rebuild: first non-empty, non-`#` line is the address.
 * **2026-09-10**: the distributed name is `server.txt` (그 폴더에서 유일하게 사람이 고치는 파일이다);
 * `relay.txt` 는 이미 배포된 사본을 위해 계속 읽는다 — 앞에 있는 이름이 이긴다.
 */
const RELAY_FILES = ['server.txt', 'relay.txt'];

/**
 * Local route the renderer's 설정 화면 asks for the *default* address (see the header comment).
 * 2026-09-11: 원본은 `shared/net` 의 `NET_SHELL_RELAY_ROUTE` — `net/parts/Socket` 도 같은 라우트로 임베디드 목표를 판별한다.
 */
const RELAY_ROUTE = NET_SHELL_RELAY_ROUTE;

/**
 * `RELAY_ROUTE` 의 응답. `embedded` (2026-09-11) = 같은 오리진 `/ws` 가 **이 프로세스의 임베디드 릴레이**로 가는가 —
 * 렌더러(`net/parts/Socket`)가 source 라벨 문자열 대신 이것을 보고 프로브를 끈다 (첫 `/ws` 가 릴레이를 켜므로, C-28).
 */
interface RelayRouteInfo { target: string; source: string; embedded: boolean }

type RelaySource = 'flag' | 'env' | 'file' | 'build';
const RELAY_SOURCE_LABEL: Record<RelaySource, string> = {
  flag: '--relay',
  env: 'SCAV_RELAY',
  file: RELAY_FILES[0],
  build: 'build default',
};

/**
 * Where the player's own copy sits. A portable exe unpacks itself into a temp folder, so `process.execPath` is not
 * where they put the file — electron-builder hands us the real directory in `PORTABLE_EXECUTABLE_DIR`. `cwd` covers
 * `npm run app`, where `execPath` is Electron's own binary inside node_modules.
 *
 * **2026-09-10 — 배포본은 `app/` 안에 있다.** 받는 사람이 보는 폴더에는 stub `SCAVANGER.exe` · `server.txt` ·
 * 서버 exe 만 두고 실제 빌드는 `app/` 으로 내렸으므로(`scripts/pack-release.mjs`), `execPath` 의 **부모**도
 * 후보다 — 사람이 고치는 `server.txt` 는 그 위에 있다.
 */
function configDirs(): string[] {
  const exeDir = dirname(process.execPath);
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, exeDir, dirname(exeDir), process.cwd()];
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

function readRelayFile(): { url: string; from: string } | null {
  for (const dir of configDirs()) {
    for (const name of RELAY_FILES) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      try {
        // Notepad likes to save UTF-8 with a BOM; without this the BOM'd first line stops looking like a comment.
        const text = readFileSync(path, 'utf8');
        const line = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith('#'));
        if (line) return { url: line, from: path };
      } catch (e) {
        console.warn(`[desktop] ${path}: ${(e as Error).message}`);
      }
    }
  }
  return null;
}

function resolveRelay(): { url: string; source: RelaySource; from?: string } | null {
  if (local) return null;
  const fromFlag = argv.find((a) => a.startsWith('--relay='));
  if (fromFlag) return { url: fromFlag.slice('--relay='.length), source: 'flag' };
  const fromEnv = process.env.SCAV_RELAY;
  if (fromEnv) return { url: fromEnv, source: 'env' };
  const file = readRelayFile();
  if (file) return { url: file.url, source: 'file', from: file.from };
  const baked = typeof __SCAV_DEFAULT_RELAY__ === 'string' ? __SCAV_DEFAULT_RELAY__.trim() : '';
  if (baked) return { url: baked, source: 'build' };
  return null;
}

/**
 * Accepts `ws://host:port/ws`, `host:port` and a bare `host` — the port and `/ws` path are filled in.
 * **2026-09-10**: the rule itself lives in `shared/net.relayUrlFrom` so 설정 화면 · 렌더러 · 이 셸이 같은
 * 주소를 만든다 (설정에서 초록불이 뜬 주소로 앱이 다른 데 붙으면 안 된다). 형식이 아니면 그대로 던진다 —
 * 부르는 쪽이 이미 `try` 안에서 임베디드 릴레이로 떨어질 준비를 하고 있다.
 */
function toRelayUrl(raw: string): URL {
  const url = relayUrlFrom(raw);
  if (!url) throw new Error(`릴레이 주소 형식이 아닙니다: ${raw}`);
  return new URL(url);
}

const WEB_ROOT = join(app.getAppPath(), 'dist');
let relay: RelayServer | null = null;
let appServer: HttpServer | null = null;
let win: BrowserWindow | null = null;
/** 세이브(localStorage)를 디스크로 밀어내는 주기 — 아래 `flushStorageData` 주석 참고. */
const SAVE_FLUSH_MS = 30_000;
let flushTimer: NodeJS.Timeout | null = null;

/* ── local server ─────────────────────────────────────────────────────── */

/**
 * 창이 열리는 로컬 http 포트 (`--app-port` / `SCAV_APP_PORT` 로 바꾼다).
 *
 * **2026-09-09 — 껐다 켜면 캐릭터가 사라지던 이유.** localStorage 는 오리진(`http://127.0.0.1:<port>`)
 * 단위다. 그런데 창의 포트는 (a) 프록시 모드(= `relay.txt` 로 남의 릴레이에 붙는 배포본의 기본형)에서
 * **언제나 OS 가 주는 임의 포트**였고, (b) 임베디드 모드에서도 릴레이 포트가 이미 쓰이는 중이면(`npm run
 * server` · `start-server.bat` · 앞서 죽다 만 사본) 임의 포트로 떨어졌다. 실행할 때마다 오리진이 달라지니
 * 캐릭터 · 창고 · 설정이 매번 빈 채로 떴고, `scav.sessionToken` 까지 새로 발급돼 **릴레이가 들고 있던 서버
 * 프로필(크레딧 · 창고 · 로드아웃 · 진행도)도 같이 사라졌다.**
 *
 * 그래서 창은 릴레이와 **무관한 전용 포트**를 쓰고, 막혀 있으면 임의 포트가 아니라 정해진 순서로 다음 칸을
 * 본다. 단일 인스턴스 락(`requestSingleInstanceLock`)이 있으므로 실제로는 언제나 첫 칸이다.
 */
const APP_PORT = Number(value('app-port', 'SCAV_APP_PORT') ?? 8790) || 8790;
/** 첫 칸이 막혔을 때 훑어볼 칸 수. 임의 포트로는 절대 떨어지지 않는다 — 그게 세이브를 지운다. */
const APP_PORT_TRIES = 10;

/** Listen on `preferred`, falling back to an OS-chosen free one when it is taken (a second copy, or `npm run server`). */
async function listenWithFallback(preferred: number, start: (port: number) => Promise<number>): Promise<number> {
  if (preferred === 0) return start(0);
  try {
    return await start(preferred);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    console.warn(`[desktop] port ${preferred} is busy -> using a free port`);
    return start(0);
  }
}

/** `ports` 를 **적힌 순서대로** 훑는다. 전부 막혔으면 던진다 — 임의 포트로 도망가지 않는다(오리진 = 세이브). */
async function listenStable(ports: readonly number[], start: (port: number) => Promise<number>): Promise<number> {
  let last: Error | null = null;
  for (const p of ports) {
    try {
      return await start(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      last = e as Error;
      console.warn(`[desktop] app port ${p} is busy -> trying the next one`);
    }
  }
  throw last ?? new Error('no free app port');
}

/**
 * 2026-09-11 (C-28) — 임베디드 릴레이는 **필요할 때 켠다**. 예전에는 설정된 주소가 없으면 부팅 때 무조건 켰는데,
 * 그러면 쓰지도 않을 릴레이가 포트 8787 · 프로필 저장소 동기 로드 · heartbeat 를 쥐고 있었고 — 게임 안
 * `설정 › 서버 설정` 으로 다른 서버에 붙는 사람도 마찬가지였다 — 게임을 먼저 켜고 같은 PC 에서
 * `SCAVANGER-Server.exe` 를 나중에 켜면 그쪽이 `EADDRINUSE` 로 못 떴다. 이제 창 서버의 `/ws` 업그레이드가
 * **처음 들어올 때** 켠다 (`attachWsProxy` 의 `LazyProxyTarget`). `--lan` / `--port` 는 "이 PC 가 서버다" 라는
 * 명시적인 뜻이므로 부팅 때 곧바로 켠다. 동시에 들어온 업그레이드는 같은 Promise 를 기다린다.
 */
let embeddedStart: Promise<URL> | null = null;
const eagerEmbedded = !lazyRelay && (lan || value('port', 'SCAV_PORT') !== undefined);

function ensureEmbedded(): Promise<URL> {
  if (!embeddedStart) {
    embeddedStart = startEmbedded().then((url) => {
      console.log(`[desktop] embedded relay on ${url.host}${lan ? ' (bound 0.0.0.0 — LAN)' : ''}`);
      return url;
    });
    // 실패하면 다음 업그레이드가 다시 시도하게 비운다 (포트가 잠깐 막혀 있었을 수 있다).
    embeddedStart.catch((e: unknown) => {
      console.warn(`[desktop] embedded relay failed: ${(e as Error).message}`);
      embeddedStart = null;
    });
  }
  return embeddedStart;
}

/** Embedded relay (its own http server; the window does not live on it). Returns the relay's ws URL. */
async function startEmbedded(): Promise<URL> {
  await listenWithFallback(wantPort, async (p) => {
    relay = await startRelayServer({
      port: p,
      host: lan ? '0.0.0.0' : '127.0.0.1',
      // Portable build: profiles / raid sessions live with the user, never next to the exe.
      dataDir: join(app.getPath('userData'), 'relay-data'),
    });
    return relay.port;
  });
  // LAN 브라우저가 이 PC 에서 게임을 받아 갈 수 있게 릴레이 포트에서도 계속 서빙한다(예전 그대로).
  if (relay) attachStatic(relay.http, WEB_ROOT);
  return new URL(`ws://127.0.0.1:${relay?.port ?? wantPort}${NET_WS_PATH}`);
}

/**
 * 창이 사는 http 서버: `dist/` 를 서빙하고 `/ws` 업그레이드를 `relayWs`(임베디드든 원격이든)로 파이프한다.
 *
 * 릴레이 포트를 절대 뺏지 않는다 — 자기 PC 의 릴레이를 가리키는 사람이 `/ws` 를 이 프로세스로 되돌려
 * 보내게 되기 때문이다. 포트는 `APP_PORT` 부터 순서대로(위 주석) — 오리진이 곧 세이브다.
 */
async function startWindowServer(
  relayWs: URL | LazyProxyTarget,
  def: () => RelayRouteInfo,
): Promise<number> {
  const ports = Array.from({ length: APP_PORT_TRIES }, (_, i) => APP_PORT + i);
  return listenStable(ports, (p) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // A bare server has no handler, so answer unknown paths first; attachStatic then runs ahead of it.
    server.on('request', (req, res) => {
      if (res.headersSent) return;
      // 설정 › 서버 설정 이 "기본값: …" 줄에 쓸 값. 이 창의 렌더러만 볼 수 있는 loopback 라우트다.
      // 임베디드 릴레이는 늦게 켜지므로(C-28) 요청마다 지금 값을 읽는다.
      if ((req.url ?? '').split('?')[0] === RELAY_ROUTE) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(def()));
        return;
      }
      res.writeHead(404).end('SCAVANGER desktop');
    });
    attachStatic(server, WEB_ROOT);
    attachWsProxy(server, relayWs, (e) => console.warn(`[desktop] relay proxy: ${e.message}`));
    server.listen(p, '127.0.0.1', () => {
      appServer = server;
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : p);
    });
  }));
}

/* ── Escape (Phase 12) ─────────────────────────────────────────────────
 *
 * A page cannot re-take the pointer lock right after an Escape: Chrome grants Escape no user activation (it is
 * reserved for leaving fullscreen / pointer lock), so the re-lock the game asks for when its last screen closes is
 * refused and the player is left with a visible cursor until their next click or key. In the browser the game answers
 * with the '좌측 클릭으로 게임 재개' gate (`src/game/ResumeGate.ts`). The shell can do better, because the **main**
 * process is allowed to hand the page an activation:
 *
 *   `executeJavaScript(code, true)` runs `code` *with a user gesture*, which is exactly what `requestPointerLock()`
 *   wants. On every Escape **key-up** we run the page's `window.__scavShellRelock` hook that way; it waits two frames
 *   (so the screen this Escape closed has released cursor mode) and re-locks only if nothing owns the cursor.
 *
 * The key itself is deliberately **left alone** — no `preventDefault`, no synthetic forward. Measured 2026-09-08 on
 * the built app: while the lock is held Chromium's exclusive-access handler consumes Escape *before*
 * `before-input-event`, so a `preventDefault` here keeps neither the lock nor the key; and while a screen is open
 * there is no lock, so the real Escape reaches the page by itself. Forwarding a synthetic copy on top of that
 * delivered the key **twice** (observed under CDP), which closed two screens on one press. `--raw-escape` skips even
 * the hook (the pre-Phase-12 behaviour), for diagnostics.
 */
const SHELL_RELOCK = '(() => { const f = window.__scavShellRelock; if (typeof f === "function") f(); })()';

function handleEscape(_event: Electron.Event, input: Electron.Input): void {
  if (input.type !== 'keyUp') return;
  void win?.webContents.executeJavaScript(SHELL_RELOCK, true).catch(() => { /* page reloading */ });
}

/* ── window ───────────────────────────────────────────────────────────── */
function createWindow(port: number): void {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#05070a',
    title: 'SCAVANGER',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: devtools,
      // The host simulates enemies for the whole squad — never let an unfocused window drop to 1 fps.
      backgroundThrottling: false,
    },
  });
  trackWindowState(win);

  win.once('ready-to-show', () => {
    if (hidden) return;   // E-3: 전체화면 · 최대화도 창을 보이게 하므로 같이 건너뛴다
    if (state.fullscreen) win?.setFullScreen(true);
    else if (state.maximized) win?.maximize();
    win?.show();
  });

  // F11 = fullscreen. Everything else (Tab, `) belongs to the game — Escape included, but through `handleEscape`.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.code === 'Escape' && !rawEscape) { handleEscape(event, input); return; }
    if (input.type !== 'keyDown') return;
    if (input.code === 'F11' && !input.control && !input.alt) {
      event.preventDefault();
      win?.setFullScreen(!win.isFullScreen());
    }
  });

  // Keep the app on its own origin; real links open in the user's browser.
  const origin = `http://127.0.0.1:${port}`;
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) { event.preventDefault(); void shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('SCAVANGER', `렌더러가 종료되었습니다 (${details.reason}).\n앱을 다시 실행해 주세요.`);
  });

  win.on('closed', () => { win = null; });
  void win.loadURL(`${origin}/`);
}

/* ── lifecycle ────────────────────────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[desktop] second instance refused (single-instance lock) -> focusing the existing window');
    if (!win || hidden) return;   // E-3: 숨긴 창을 focus/restore 하면 보이게 된다
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Pointer lock and fullscreen are the only web permissions this game asks for.
    const allowed = new Set(['pointerLock', 'fullscreen']);
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    /* 2026-09-09 — Chromium 은 localStorage 를 느긋하게 디스크에 내린다: 정상 종료면 나갈 때 쓰지만,
     * **작업 관리자로 끄거나 렌더러가 죽으면 마지막 쓰기 이후가 통째로 사라진다** (측정: SIGTERM 한 번에
     * 세이브 전부 유실). 세이브 하나가 몇 KB 라 강제로 내리는 비용이 없으므로 주기적으로 · 종료할 때 내린다. */
    flushTimer = setInterval(() => ses.flushStorageData(), SAVE_FLUSH_MS);
    app.on('before-quit', () => ses.flushStorageData());

    if (!existsSync(join(WEB_ROOT, 'index.html'))) {
      dialog.showErrorBox('SCAVANGER', `게임 빌드를 찾을 수 없습니다:\n${WEB_ROOT}\n\n먼저 "npm run app:build" 를 실행하세요.`);
      app.quit();
      return;
    }

    try {
      let relayWs: URL | LazyProxyTarget;
      /** 설정 화면의 "기본값: …" 줄에 그대로 실리는 값 (`RELAY_ROUTE`). */
      let def: () => RelayRouteInfo;
      let routeLabel: string;
      const configured = resolveRelay();
      if (configured) {
        const url = toRelayUrl(configured.url);
        relayWs = url;
        const from = configured.from ? `: ${configured.from}` : '';
        console.log(`[desktop] relay proxy -> ${url.href}  (${RELAY_SOURCE_LABEL[configured.source]}${from})`);
        const fixed: RelayRouteInfo = { target: url.href, source: RELAY_SOURCE_LABEL[configured.source], embedded: false };
        def = () => fixed;
        routeLabel = url.href;
      } else {
        // C-28: `--lan` / `--port` 면 지금 켜고, 아니면 첫 `/ws` 업그레이드가 켠다.
        if (eagerEmbedded) await ensureEmbedded();
        relayWs = { path: NET_WS_PATH, resolve: ensureEmbedded };
        def = () => relay
          ? { target: `ws://127.0.0.1:${relay.port}${NET_WS_PATH}`, source: '이 PC 의 내장 서버', embedded: true }
          : { target: `ws://127.0.0.1:${wantPort}${NET_WS_PATH}`, source: '이 PC 의 내장 서버 (필요할 때 켜짐)', embedded: true };
        routeLabel = relay ? `ws://127.0.0.1:${relay.port}${NET_WS_PATH}` : 'embedded relay (starts on the first connection)';
      }
      // 창의 오리진은 릴레이와 무관한 고정 포트다 (localStorage = 세이브가 오리진에 묶여 있다).
      const port = await startWindowServer(relayWs, def);
      console.log(`[desktop] http://127.0.0.1:${port}/  (relay ws ${NET_WS_PATH} -> ${routeLabel})`);
      createWindow(port);
    } catch (e) {
      dialog.showErrorBox('SCAVANGER', `로컬 서버를 시작하지 못했습니다.\n${(e as Error).message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', () => {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    appServer?.close();
    appServer = null;
    void relay?.close();
    relay = null;
    // 켜지는 중이던 임베디드 릴레이도 뜨는 대로 닫는다 (C-28).
    if (embeddedStart) {
      void embeddedStart.then(() => relay?.close(), () => { /* never started */ });
      embeddedStart = null;
    }
  });
}
