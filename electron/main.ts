/**
 * SCAVANGER desktop (Electron) main process.
 *
 * One process runs the whole game: it starts the **embedded relay** (`server/RelayServer.ts`) on loopback, serves the
 * vite build from that same http server and points a single BrowserWindow at `http://127.0.0.1:<port>/`. Loading over
 * http instead of `file://` is what keeps `src/` untouched — the renderer's same-origin `/ws` lands on the embedded
 * relay exactly like it does behind the vite proxy, so profiles, raid sessions and the social store all work offline.
 *
 * A distributed build normally points at ONE relay somebody else runs (`start-server.bat`), so the address is resolved
 * from four places, first hit wins — flag, env, a `relay.txt` the player can edit next to the exe, then the address
 * baked in at build time (`SCAV_DEFAULT_RELAY=… npm run app:dist`). Nothing configured at all = embedded relay, i.e.
 * the offline single-machine build. `--local` forces that even when an address is configured.
 *
 * CLI / env (both accepted; the flag wins):
 *   --port=<n>         SCAV_PORT       relay + http port (default NET_DEFAULT_PORT, falls back to a free port)
 *   --lan              SCAV_LAN=1      bind 0.0.0.0 so other machines on the LAN can use this relay (firewall prompt)
 *   --relay=<ws url>   SCAV_RELAY      start no relay; proxy /ws to an existing one (ws://192.168.0.5:8787/ws)
 *   --local            SCAV_LOCAL=1    ignore every configured relay and run the embedded one (offline / solo)
 *   --devtools         SCAV_DEVTOOLS=1 enable DevTools (F12 / Ctrl+Shift+I); off in a normal build
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { startRelayServer, type RelayServer } from '../server/RelayServer.ts';
import { NET_DEFAULT_PORT, NET_WS_PATH } from '../src/shared/net.ts';
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

const portGiven = value('port', 'SCAV_PORT') !== undefined;
const wantPort = Number(value('port', 'SCAV_PORT') ?? NET_DEFAULT_PORT) || NET_DEFAULT_PORT;
const lan = flag('lan', 'SCAV_LAN');
const devtools = flag('devtools', 'SCAV_DEVTOOLS');
const local = flag('local', 'SCAV_LOCAL');

/* ── which relay do we talk to? ───────────────────────────────────────── */

/** Address compiled in by `electron/build.mjs` (`SCAV_DEFAULT_RELAY`); the empty string when the build set none. */
declare const __SCAV_DEFAULT_RELAY__: string;

/** Plain-text override the player can edit without a rebuild: first non-empty, non-`#` line is the address. */
const RELAY_FILE = 'relay.txt';

type RelaySource = 'flag' | 'env' | 'file' | 'build';
const RELAY_SOURCE_LABEL: Record<RelaySource, string> = {
  flag: '--relay',
  env: 'SCAV_RELAY',
  file: RELAY_FILE,
  build: 'build default',
};

/**
 * Where the player's own copy sits. A portable exe unpacks itself into a temp folder, so `process.execPath` is not
 * where they put the file — electron-builder hands us the real directory in `PORTABLE_EXECUTABLE_DIR`. `cwd` covers
 * `npm run app`, where `execPath` is Electron's own binary inside node_modules.
 */
function configDirs(): string[] {
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, dirname(process.execPath), process.cwd()];
  return [...new Set(dirs.filter((d): d is string => !!d))];
}

function readRelayFile(): { url: string; from: string } | null {
  for (const dir of configDirs()) {
    const path = join(dir, RELAY_FILE);
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

/** Accepts `ws://host:port/ws`, `host:port` and a bare `host` — the port and `/ws` path are filled in. */
function toRelayUrl(raw: string): URL {
  const text = raw.trim();
  const url = new URL(/^wss?:\/\//i.test(text) ? text : `ws://${text}`);
  if (!url.port) url.port = String(NET_DEFAULT_PORT);
  if (!url.pathname || url.pathname === '/') url.pathname = NET_WS_PATH;
  return url;
}

const WEB_ROOT = join(app.getAppPath(), 'dist');
let relay: RelayServer | null = null;
let proxyServer: HttpServer | null = null;
let win: BrowserWindow | null = null;

/* ── local server ─────────────────────────────────────────────────────── */

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

/** Embedded relay + static files on one http server. Returns the bound port. */
async function startEmbedded(): Promise<number> {
  const port = await listenWithFallback(wantPort, async (p) => {
    relay = await startRelayServer({
      port: p,
      host: lan ? '0.0.0.0' : '127.0.0.1',
      // Portable build: profiles / raid sessions live with the user, never next to the exe.
      dataDir: join(app.getPath('userData'), 'relay-data'),
    });
    return relay.port;
  });
  if (relay) attachStatic(relay.http, WEB_ROOT);
  return port;
}

/**
 * No relay of our own: static files locally, `/ws` forwarded to `target`.
 *
 * Unlike the embedded case this server is a private detail (it only exists to give the window an origin), so it takes
 * an OS-chosen port unless one was asked for. Squatting on the relay port would be actively harmful: a player whose
 * configured relay is on this very machine would otherwise proxy `/ws` straight back into this process.
 */
async function startProxied(target: URL): Promise<number> {
  return listenWithFallback(portGiven ? wantPort : 0, (p) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    // A bare server has no handler, so answer unknown paths first; attachStatic then runs ahead of it.
    server.on('request', (_req, res) => { if (!res.headersSent) res.writeHead(404).end('SCAVANGER desktop'); });
    attachStatic(server, WEB_ROOT);
    attachWsProxy(server, target, (e) => console.warn(`[desktop] relay proxy: ${e.message}`));
    server.listen(p, '127.0.0.1', () => {
      proxyServer = server;
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : p);
    });
  }));
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
    if (state.fullscreen) win?.setFullScreen(true);
    else if (state.maximized) win?.maximize();
    win?.show();
  });

  // F11 = fullscreen. Everything else (Esc, Tab, `) belongs to the game.
  win.webContents.on('before-input-event', (event, input) => {
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
    if (!win) return;
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

    if (!existsSync(join(WEB_ROOT, 'index.html'))) {
      dialog.showErrorBox('SCAVANGER', `게임 빌드를 찾을 수 없습니다:\n${WEB_ROOT}\n\n먼저 "npm run app:build" 를 실행하세요.`);
      app.quit();
      return;
    }

    try {
      let port: number;
      const configured = resolveRelay();
      if (configured) {
        const target = toRelayUrl(configured.url);
        port = await startProxied(target);
        const from = configured.from ? `: ${configured.from}` : '';
        console.log(`[desktop] relay proxy -> ${target.href}  (${RELAY_SOURCE_LABEL[configured.source]}${from})`);
      } else {
        port = await startEmbedded();
        console.log(`[desktop] embedded relay${lan ? ' on 0.0.0.0 (LAN)' : ''}`);
      }
      console.log(`[desktop] http://127.0.0.1:${port}/  (relay ws ${NET_WS_PATH})`);
      createWindow(port);
    } catch (e) {
      dialog.showErrorBox('SCAVANGER', `릴레이 서버를 시작하지 못했습니다.\n${(e as Error).message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', () => {
    proxyServer?.close();
    proxyServer = null;
    void relay?.close();
    relay = null;
  });
}
