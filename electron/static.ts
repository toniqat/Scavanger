/**
 * Static file serving for the desktop build.
 *
 * The renderer is loaded over **http from the relay's own server** (`http://127.0.0.1:<port>/`) rather than from
 * `file://`, so `location.host` resolves and `NetSystem.defaultUrl()` finds the relay at the same origin `/ws`
 * exactly like it does under vite. That keeps `src/` untouched: no build-time `VITE_WS_URL`, no preload shim.
 *
 * `startRelayServer()` registers its own `request` listener (GET /health, 404 for everything else), so this module
 * takes that listener over: ours runs first and delegates anything it does not own back to the original.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

/** Map a request url onto a file inside `root`, or null when it escapes the root. */
function resolveFile(root: string, url: string): string | null {
  const path = decodeURIComponent(url.split('?')[0]?.split('#')[0] ?? '/');
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^[/\\]+/, '');
  const full = resolve(join(root, rel));
  const rootFull = resolve(root);
  if (full !== rootFull && !full.startsWith(rootFull + sep)) return null;
  return full;
}

/**
 * Serve `root` from an existing http server, keeping its previous handlers as the fallback.
 * A GET that matches no file falls through to the relay (which answers /health and 404s the rest).
 */
export function attachStatic(server: HttpServer, root: string): void {
  const fallbacks = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const pass = (): void => { for (const fn of fallbacks) fn.call(server, req, res); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { pass(); return; }
    const url = req.url ?? '/';
    if (url === '/health' || url.startsWith('/health?')) { pass(); return; }

    const file = resolveFile(root, url);
    if (!file) { res.writeHead(403).end(); return; }

    void stat(file).then((st) => {
      if (!st.isFile()) { pass(); return; }
      res.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(st.size),
        // Local files behind a versioned bundle: never let a stale asset survive an app update.
        'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }).catch(() => { pass(); });
  });
}
