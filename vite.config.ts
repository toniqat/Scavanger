import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * 2026-09-22 (TODO E-12 ⓑ): **headless Chrome gets its modules without the inline sourcemap.**
 *
 * Vite's dev server always appends a base64 sourcemap to every module it serves (there is no dev switch for it).
 * One boot of the game is ~880 requests and 41 MB, **28 MB of it those maps** — and a smoke Chrome never reads them
 * (DevTools is not open, and `Error.stack` in the page does not go through sourcemaps either). With several smoke
 * Chromes booting at once, parsing and base64-decoding them is what made `page.goto` the limit past 6 lanes.
 *
 * The test is the user agent (`HeadlessChrome`, which every smoke's `puppeteer.launch({ headless: true })` sends), so it
 * holds for a vite the runner started and for one it adopted; a normal browser, and so the developer's DevTools,
 * still gets its maps. Only the trailing `//# sourceMappingURL=data:` comment of a JS/CSS response is cut.
 */
function headlessNoSourcemap(): Plugin {
  const TAIL = '\n//# sourceMappingURL=data:';
  return {
    name: 'scav-headless-no-sourcemap',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/HeadlessChrome/.test(req.headers['user-agent'] ?? '')) return next();
        const end = res.end.bind(res) as (...a: unknown[]) => typeof res;
        (res as unknown as { end: (...a: unknown[]) => typeof res }).end = (chunk?: unknown, ...rest: unknown[]) => {
          const type = String(res.getHeader('Content-Type') ?? '');
          if (chunk != null && /javascript|css/.test(type)) {
            const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : null;
            const cut = text?.lastIndexOf(TAIL) ?? -1;
            if (text !== null && cut >= 0) {
              const body = text.slice(0, cut + 1);
              if (!res.headersSent) res.setHeader('Content-Length', Buffer.byteLength(body));
              return end(body, ...rest);
            }
          }
          return end(chunk, ...rest);
        };
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [headlessNoSourcemap()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    open: false,
    // Dev relay: the browser talks to same-origin /ws and Vite forwards it to the Node relay (npm run server).
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
    },
  },
});
