/**
 * SCAVANGER desktop (Electron) main process.
 *
 * One process runs the game window: it serves the vite build from a small http server of its own, points a single
 * BrowserWindow at `http://127.0.0.1:<APP_PORT>/` and forwards that origin's `/ws` to the relay the player uses.
 * Loading over http instead of `file://` is what keeps `src/` untouched — the renderer's same-origin `/ws` lands on the
 * relay exactly like it does behind the vite proxy.
 *
 * **2026-09-15 — builds ship no server (user's decision).** The embedded relay this process used to start from
 * `server/RelayServer.ts` (C-28's lazy start · `--port` · `--lan` · `--lazy-relay`) and the server exe for the deploy
 * folder were taken out. A server runs only from this repo, through `start-server.bat`. So this shell **only ever
 * pipes** `/ws`, and with no address at all it looks at the server start-server.bat started on this PC
 * (`ws://127.0.0.1:NET_DEFAULT_PORT/ws`). If that server is off the pipe drops at once and the renderer is plainly
 * offline → its background probe (`net/parts/Socket`) finds it again — the shell has nothing of its own to do.
 *
 * The window's port is **fixed and never OS-chosen**: localStorage (every character, the stash, `scav.sessionToken`)
 * is keyed by origin, so a port that moves between launches wipes the save. See `APP_PORT`.
 *
 * The address is resolved from four places, first hit wins — flag, env, a `server.txt` the player can edit next to the
 * exe, then the address baked in at build time (`electron/default-relay.txt` / `SCAV_DEFAULT_RELAY=… npm run app:dist`).
 * Nothing configured = this PC's server. `--local` forces that even when an address is configured.
 *
 * **2026-09-10 — the in-game `설정 › 서버 설정` outranks all four of these.** It lives in the renderer's localStorage
 * (`shared/net` `RELAY_STORAGE_KEY`) and `NetSystem.defaultUrl()` dials that address directly instead of the
 * same-origin `/ws`, so the address picked here is **not used** then — what is picked here is the *default*. It is
 * published on `RELAY_ROUTE` so the 설정 화면 can show what that default is.
 *
 * CLI / env (both accepted; the flag wins):
 *   --app-port=<n>     SCAV_APP_PORT   the window's own http port (default 8790) — changing it starts a fresh save
 *   --relay=<ws url>   SCAV_RELAY      proxy /ws to that relay (ws://192.168.0.5:8787/ws, or just 192.168.0.5)
 *   --local            SCAV_LOCAL=1    ignore every configured address and use this PC's server (start-server.bat)
 *   --devtools         SCAV_DEVTOOLS=1 enable DevTools (F12 / Ctrl+Shift+I); off in a normal build
 *   --raw-escape       SCAV_RAW_ESCAPE=1  leave Escape to Chromium (diagnostics, see `handleEscape`)
 *
 * Test isolation (E-3, 2026-09-11 — `scripts/smoke-desktop.mjs`; a player never needs these):
 *   --user-data=<dir>  SCAV_USER_DATA  moves userData — localStorage (the saves) · the single-instance lock · the
 *                                      window state all go to that folder. Touches neither a running game nor the
 *                                      user's own saves
 *   --hidden           SCAV_HIDDEN=1   never shows the window (the page still runs — a window shown not even once
 *                                      gets 3–5 rAF per second)
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { NET_DEFAULT_PORT, NET_SHELL_RELAY_ROUTE, NET_WS_PATH, relayUrlFrom } from '../src/shared/net.ts';
import { attachStatic } from './static.ts';
import { attachWsProxy } from './wsProxy.ts';
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

const devtools = flag('devtools', 'SCAV_DEVTOOLS');
const local = flag('local', 'SCAV_LOCAL');
/** Diagnostics: leave Escape to Chromium (no forward, no re-lock) — the behaviour before Phase 12. */
const rawEscape = flag('raw-escape', 'SCAV_RAW_ESCAPE');
/** E-3: never raises the window (so a smoke does not cover the screen being worked on). */
const hidden = flag('hidden', 'SCAV_HIDDEN');

/* E-3 (2026-09-11) — userData isolation. It has to come **before `requestSingleInstanceLock` and `app.ready`**: the
 * lock's and the session store's (localStorage) paths are decided there. `setPath` refuses a folder that does not
 * exist, so it is created first. */
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
 * **2026-09-10**: the distributed name is `server.txt` (the only file in that folder a person edits); `relay.txt` is
 * still read for copies already shipped — the name earlier in the list wins.
 */
const RELAY_FILES = ['server.txt', 'relay.txt'];

/**
 * Local route the renderer's 설정 화면 asks for the *default* address (see the header comment).
 * 2026-09-11: the source of truth is `NET_SHELL_RELAY_ROUTE` in `shared/net`.
 */
const RELAY_ROUTE = NET_SHELL_RELAY_ROUTE;

/**
 * The `RELAY_ROUTE` response. `embedded` only remains because it is contract (`shared/net`, add-only) and is
 * **always false since 2026-09-15** — this shell no longer holds a relay.
 */
interface RelayRouteInfo { target: string; source: string; embedded: false }

type RelaySource = 'flag' | 'env' | 'file' | 'build' | 'local' | 'default';
const RELAY_SOURCE_LABEL: Record<RelaySource, string> = {
  flag: '--relay',
  env: 'SCAV_RELAY',
  file: RELAY_FILES[0],
  build: 'build default',
  // the 설정 화면 shows it in brackets, "기본값: ws://127.0.0.1:8787/ws  (…)" — so a label carries no brackets.
  local: '--local · 이 PC 의 서버',
  default: '이 PC 의 서버 · start-server.bat',
};

/** Where it looks with no address at all (or with `--local`): the server start-server.bat started on this PC. */
const LOCAL_SERVER = `ws://127.0.0.1:${NET_DEFAULT_PORT}${NET_WS_PATH}`;

/**
 * Where the player's own copy sits. A portable exe unpacks itself into a temp folder, so `process.execPath` is not
 * where they put the file — electron-builder hands us the real directory in `PORTABLE_EXECUTABLE_DIR`. `cwd` covers
 * `npm run app`, where `execPath` is Electron's own binary inside node_modules.
 *
 * **2026-09-10 — the build sits inside `app/`.** The folder a receiver sees holds only the stub `SCAVANGER.exe` and
 * `server.txt`, with the real build moved down into `app/` (`scripts/pack-release.mjs`), so `execPath`'s **parent**
 * is a candidate too — the `server.txt` a person edits is up there.
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

/** Always picks one destination — the last entry is this PC's server, so there is no `null`. */
function resolveRelay(): { url: string; source: RelaySource; from?: string } {
  if (local) return { url: LOCAL_SERVER, source: 'local' };
  const fromFlag = argv.find((a) => a.startsWith('--relay='));
  if (fromFlag) return { url: fromFlag.slice('--relay='.length), source: 'flag' };
  const fromEnv = process.env.SCAV_RELAY;
  if (fromEnv) return { url: fromEnv, source: 'env' };
  const file = readRelayFile();
  if (file) return { url: file.url, source: 'file', from: file.from };
  const baked = typeof __SCAV_DEFAULT_RELAY__ === 'string' ? __SCAV_DEFAULT_RELAY__.trim() : '';
  if (baked) return { url: baked, source: 'build' };
  return { url: LOCAL_SERVER, source: 'default' };
}

/**
 * Accepts `ws://host:port/ws`, `host:port` and a bare `host` — the port and `/ws` path are filled in.
 * **2026-09-10**: the rule itself lives in `shared/net.relayUrlFrom` so the 설정 화면 · the renderer · this shell all
 * build the same address (an address the settings showed a green light for must not land the app somewhere else). A
 * malformed one throws — boot then shows that address and where it was written in an error box (better than silently
 * connecting to a different server).
 */
function toRelayUrl(raw: string, where: string): URL {
  const url = relayUrlFrom(raw);
  if (!url) throw new Error(`서버 주소 형식이 아닙니다: ${raw}\n(${where})`);
  return new URL(url);
}

const WEB_ROOT = join(app.getAppPath(), 'dist');
let appServer: HttpServer | null = null;
let win: BrowserWindow | null = null;
/** How often the saves (localStorage) are pushed out to disk — see the `flushStorageData` comment below. */
const SAVE_FLUSH_MS = 30_000;
let flushTimer: NodeJS.Timeout | null = null;

/* ── local server ─────────────────────────────────────────────────────── */

/**
 * The local http port the window opens on (`--app-port` / `SCAV_APP_PORT` change it).
 *
 * **2026-09-09 — why characters vanished across a restart.** localStorage is keyed by origin
 * (`http://127.0.0.1:<port>`). But the window's port was (a) **always a random one handed out by the OS** in proxy
 * mode (= the normal shape of a deploy folder, dialling someone else's relay through `relay.txt`), and (b) in
 * embedded mode (taken out on 2026-09-15) fell back to a random one whenever the relay port was already in use. A
 * different origin every launch meant characters · the stash · settings came up empty every time, and
 * `scav.sessionToken` was reissued too, so **the server profile the relay held (credits · stash · loadout ·
 * progression) went with them.**
 *
 * So the window takes a **dedicated port unrelated to the relay**, and when it is blocked it looks at the next entry
 * in a fixed order rather than at a random port. The single-instance lock (`requestSingleInstanceLock`) means it is
 * in practice always the first entry.
 */
const APP_PORT = Number(value('app-port', 'SCAV_APP_PORT') ?? 8790) || 8790;
/** Entries to scan when the first is blocked. It never falls back to a random port — that wipes the saves. */
const APP_PORT_TRIES = 10;

/**
 * The two ways a port cannot be opened — `EADDRINUSE` (someone is on it: a second copy) and `EACCES`.
 *
 * **2026-09-14 — `EACCES`.** Windows' WinNAT (Hyper-V · WSL · Docker use it) reserves a random 100-entry range at
 * boot, and `listen` on a port inside it is refused with `EACCES` even as administrator
 * (`netsh int ipv4 show excludedportrange protocol=tcp`). Before, only `EADDRINUSE` counted as "try the next entry",
 * so a window port caught by a reservation raised the error box **without looking at the entries left**. Both mean
 * the same thing: look at another entry.
 */
function isPortBlocked(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function blockedWhy(e: unknown): string {
  return (e as NodeJS.ErrnoException).code === 'EACCES' ? 'reserved by Windows' : 'busy';
}

/** Walks `ports` **in the written order**. Throws when all are blocked — never a random port (origin = saves). */
async function listenStable(ports: readonly number[], start: (port: number) => Promise<number>): Promise<number> {
  let last: Error | null = null;
  for (const p of ports) {
    try {
      return await start(p);
    } catch (e) {
      if (!isPortBlocked(e)) throw e;
      last = e as Error;
      console.warn(`[desktop] app port ${p} is ${blockedWhy(e)} -> trying the next one`);
    }
  }
  throw last ?? new Error('no free app port');
}

/**
 * The body of the boot-failure error box. When the window port was caught by a Windows reservation (`EACCES`) it adds
 * the cause and the commands that undo it — it **never says to move the port** (origin = the saves). The middle line
 * claims those ports as a user reservation (`*`) first, so WinNAT cannot take them back on the next boot. An app can
 * `listen` on a user-reserved port as it is (measured 2026-09-14: user reservation 50000 → OK, WinNAT reservation
 * 8790 → EACCES).
 * 2026-09-15: this process holds no relay, so only the window port range is claimed (start-server.bat's 8787 is that
 * PC's business).
 */
function startupFailureMessage(e: unknown): string {
  const lines = ['SCAVANGER 를 시작하지 못했습니다.', (e as Error).message];
  if ((e as NodeJS.ErrnoException).code !== 'EACCES') return lines.join('\n');
  const last = APP_PORT + APP_PORT_TRIES - 1;
  lines.push(
    '',
    `포트 ${APP_PORT}–${last} 가 Windows 에 예약되어 있습니다.`,
    '(Hyper-V · WSL · Docker 가 쓰는 WinNAT 서비스가 부팅할 때 잡는 대역입니다.)',
    '',
    '관리자 PowerShell 에서 아래 세 줄을 실행한 뒤 다시 켜 주세요:',
    '',
    '    net stop winnat',
    `    netsh int ipv4 add excludedportrange protocol=tcp startport=${APP_PORT} numberofports=${APP_PORT_TRIES}`,
    '    net start winnat',
    '',
    '가운데 줄이 이 포트들을 먼저 잡아 두어 다음 부팅에도 다시 막히지 않습니다.',
    '(창 포트를 바꾸면 세이브가 새로 시작되므로 포트를 옮기지 않습니다.)',
  );
  return lines.join('\n');
}

/**
 * The http server the window lives on: serves `dist/` and pipes the `/ws` upgrade to `relayWs`.
 * Ports run in order from `APP_PORT` (comment above) — the origin *is* the saves.
 */
async function startWindowServer(relayWs: URL, def: RelayRouteInfo): Promise<number> {
  const ports = Array.from({ length: APP_PORT_TRIES }, (_, i) => APP_PORT + i);
  return listenStable(ports, (p) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // A bare server has no handler, so answer unknown paths first; attachStatic then runs ahead of it.
    server.on('request', (req, res) => {
      if (res.headersSent) return;
      // what `설정 › 서버 설정` puts on its "기본값: …" line — a loopback route only this window's renderer sees.
      if ((req.url ?? '').split('?')[0] === RELAY_ROUTE) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(def));
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
    if (hidden) return;   // E-3: fullscreen · maximize would show the window too, so they are skipped with it
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
    if (!win || hidden) return;   // E-3: focus/restore on a hidden window makes it visible
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

    /* 2026-09-09 — Chromium writes localStorage out to disk lazily: on a clean exit it writes on the way out, but
     * **killing it from the task manager, or losing the renderer, drops everything since the last write** (measured:
     * one SIGTERM lost every save). A save is a few KB, so forcing the write costs nothing — it runs periodically and
     * on quit. */
    flushTimer = setInterval(() => ses.flushStorageData(), SAVE_FLUSH_MS);
    app.on('before-quit', () => ses.flushStorageData());

    if (!existsSync(join(WEB_ROOT, 'index.html'))) {
      dialog.showErrorBox('SCAVANGER', `게임 빌드를 찾을 수 없습니다:\n${WEB_ROOT}\n\n먼저 "npm run app:build" 를 실행하세요.`);
      app.quit();
      return;
    }

    try {
      const picked = resolveRelay();
      const label = RELAY_SOURCE_LABEL[picked.source];
      const from = picked.from ? `: ${picked.from}` : '';
      const url = toRelayUrl(picked.url, `${label}${from}`);
      console.log(`[desktop] relay proxy -> ${url.href}  (${label}${from})`);
      /** The value carried verbatim on the 설정 화면's "기본값: …" line (`RELAY_ROUTE`). */
      const def: RelayRouteInfo = { target: url.href, source: label, embedded: false };
      // the window's origin is a fixed port unrelated to the relay (localStorage = saves are bound to the origin).
      const port = await startWindowServer(url, def);
      console.log(`[desktop] http://127.0.0.1:${port}/  (relay ws ${NET_WS_PATH} -> ${url.href})`);
      createWindow(port);
    } catch (e) {
      dialog.showErrorBox('SCAVANGER', startupFailureMessage(e));
      app.quit();
    }
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', () => {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    appServer?.close();
    appServer = null;
  });
}
