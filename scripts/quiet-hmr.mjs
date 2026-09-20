/**
 * The shared smoke helper that **parks vite's HMR socket quietly** (2026-09-11, C-65). Not a smoke — `verify.mjs`
 * only runs the files listed in the `SMOKES` map, so this file is never mistaken for one.
 *
 * Why: the vite page a smoke opens holds an HMR socket, and when anyone in the same tree saves a `src/` file vite
 * **full-reloads** that page (in this game nearly every TS module change is a full reload). The state the smoke planted
 * is gone with it and the run breaks at any moment with `Execution context was destroyed` · `timeout waiting for boot`.
 * In a tree where several agents edit and verify at once it happens constantly. It used to be 35 smokes each carrying
 * its own copy of the same 12 lines, and 10 that carried none at all.
 *
 * How: **before** the page loads (`page.evaluateOnNewDocument` — ahead of the game modules, and again after every reload
 * and `page.goto`) `window.WebSocket` is wrapped in a Proxy that hands back a **fake socket parked in CONNECTING(0)**
 * for sockets whose subprotocol is `vite-hmr`. The vite client logs only on error / close, so a socket that never
 * finishes connecting stays silent. **The game's relay socket (`/ws`) passes straight through** — it carries no
 * subprotocol. The relay is parked too **only when `parkRelay` says so**.
 *
 * How to use it (puppeteer-core, before `page.goto`):
 *
 *   import { quietViteHmr } from './quiet-hmr.mjs';
 *   await quietViteHmr(page);                          // parks the HMR socket only (the default)
 *   await quietViteHmr(page, { parkRelay: true });     // + parks the relay socket (`…/ws`, `…/ws?…`) — for a single-player
 *                                                       //   smoke a server profile must not arrive mid-run (meta · housing · ladder …)
 *   await quietViteHmr(page, { logSockets: '__ws' });  // records every socket it let through in `window.__ws` as `{url, at}` (netlink)
 *
 * A smoke that opens several pages (multi-client · a new tab · a new browser) calls it **per page**. Installed on one
 * document twice, the second call does nothing (the options that went first win). It returns `evaluateOnNewDocument`'s
 * `{identifier}`.
 *
 * A new smoke that opens vite hangs this helper on it (`scripts/README.md`). One that does not open vite —
 * the real Electron shell (`smoke-desktop`, `dist/` carries no HMR client) · the static pitch pages (`smoke-pitch`) — has no need of it.
 */

/** The relay path: ends in `…/ws`, or has `?` · `#` · `/` after it (the old copies' `/\/ws\?/` · `/\/ws(\?|$)/` · `includes('/ws')` merged into one). */
const RELAY_PATH_SOURCE = String.raw`\/ws(?:[?#/]|$)`;

/**
 * The install function that runs inside the browser — puppeteer hands it over through `toString()`, so it
 * **references no outer variable** (the options arrive as the argument and nothing else).
 * @param {{ parkRelay: boolean, logSockets: string | null, relayPath: string }} opts
 */
function installQuietSockets(opts) {
  if (window.__quietViteHmr) return;
  Object.defineProperty(window, '__quietViteHmr', { value: true, configurable: true });
  const RealWS = window.WebSocket;
  if (typeof RealWS !== 'function') return;
  const relay = new RegExp(opts.relayPath);
  if (opts.logSockets) window[opts.logSockets] = [];
  // A socket stuck in CONNECTING: never opens, never errors, never closes — the vite client stays silent.
  class QuietSocket extends EventTarget {
    constructor(url) { super(); this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob'; }
    send() {} close() {}
  }
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args) {
      const protos = Array.isArray(args[1]) ? args[1] : [args[1]];
      if (protos.includes('vite-hmr')) return new QuietSocket(args[0]);
      if (opts.parkRelay && relay.test(String(args[0]))) return new QuietSocket(args[0]);
      if (opts.logSockets) window[opts.logSockets].push({ url: String(args[0]), at: performance.now() });
      return new target(...args);
    },
  });
}

/**
 * Park vite's HMR socket (and optionally the relay socket) on every document this page loads from now on.
 * Call it **before** `page.goto`.
 * @param {import('puppeteer-core').Page} page
 * @param {{ parkRelay?: boolean, logSockets?: string }} [options]
 */
export function quietViteHmr(page, options = {}) {
  return page.evaluateOnNewDocument(installQuietSockets, {
    parkRelay: !!options.parkRelay,
    logSockets: options.logSockets ?? null,
    relayPath: RELAY_PATH_SOURCE,
  });
}
