/**
 * SCAVANGER desktop (Electron) main process.
 *
 * One process runs the whole game: it starts the **embedded relay** (`server/RelayServer.ts`) on loopback, serves the
 * vite build from that same http server and points a single BrowserWindow at `http://127.0.0.1:<port>/`. Loading over
 * http instead of `file://` is what keeps `src/` untouched — the renderer's same-origin `/ws` lands on the embedded
 * relay exactly like it does behind the vite proxy, so profiles, raid sessions and the social store all work offline.
 *
 * CLI / env (both accepted; the flag wins):
 *   --port=<n>         SCAV_PORT       relay + http port (default NET_DEFAULT_PORT, falls back to a free port)
 *   --lan              SCAV_LAN=1      bind 0.0.0.0 so other machines on the LAN can use this relay (firewall prompt)
 *   --relay=<ws url>   SCAV_RELAY      start no relay; proxy /ws to an existing one (ws://192.168.0.5:8787/ws)
 *   --devtools         SCAV_DEVTOOLS=1 enable DevTools (F12 / Ctrl+Shift+I); off in a normal build
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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

const wantPort = Number(value('port', 'SCAV_PORT') ?? NET_DEFAULT_PORT) || NET_DEFAULT_PORT;
const lan = flag('lan', 'SCAV_LAN');
const devtools = flag('devtools', 'SCAV_DEVTOOLS');
const relayUrl = value('relay', 'SCAV_RELAY');

const WEB_ROOT = join(app.getAppPath(), 'dist');
let relay: RelayServer | null = null;
let proxyServer: HttpServer | null = null;
let win: BrowserWindow | null = null;

/* ── local server ─────────────────────────────────────────────────────── */

/** Listen on `port`, falling back to an OS-chosen free one when it is taken (a second copy, or `npm run server`). */
async function listenWithFallback(start: (port: number) => Promise<number>): Promise<number> {
  try {
    return await start(wantPort);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    console.warn(`[desktop] port ${wantPort} is busy -> using a free port`);
    return start(0);
  }
}

/** Embedded relay + static files on one http server. Returns the bound port. */
async function startEmbedded(): Promise<number> {
  const port = await listenWithFallback(async (p) => {
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

/** No relay of our own: static files locally, `/ws` forwarded to `relayUrl`. */
async function startProxied(target: URL): Promise<number> {
  return listenWithFallback((p) => new Promise<number>((resolve, reject) => {
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
      if (relayUrl) {
        const target = new URL(relayUrl.startsWith('ws') ? relayUrl : `ws://${relayUrl}`);
        if (!target.pathname || target.pathname === '/') target.pathname = NET_WS_PATH;
        port = await startProxied(target);
        console.log(`[desktop] relay proxy -> ${target.href}`);
      } else {
        port = await startEmbedded();
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
