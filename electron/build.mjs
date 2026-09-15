/**
 * Bundle the Electron main process to `dist-electron/main.js`.
 *
 * `electron/` is written in TypeScript and imports `src/shared/net.ts`; Electron's main process has no type-stripping
 * loader, so the desktop build bundles it. Rolldown ships with vite, so this needs no extra dependency. `electron` stays
 * external (the runtime provides it).
 *
 * **2026-09-15 — the build carries no server** (user decision). The embedded relay and with it `server/` and `ws` are
 * gone from this bundle; a server runs only from the repo via `start-server.bat`. `scripts/smoke-desktop.mjs` checks that
 * the bundle holds no relay code.
 *
 * SCAV_DEFAULT_RELAY bakes the address a distributed build talks to by default, so the players who receive it do not
 * have to pass `--relay`. It is only the *last* fallback — a `server.txt` next to the exe, `SCAV_RELAY` and the flag
 * all win over it (see `main.ts`), and an empty value makes the build look for this PC's server
 * (`ws://127.0.0.1:8787/ws`, started with `start-server.bat`).
 *
 * The address itself lives in `electron/default-relay.txt` so a plain `npm run app:dist` bakes it (setting an env var
 * per shell is awkward on Windows); `SCAV_DEFAULT_RELAY` still overrides that for a one-off build.
 */
import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outFile = join(root, 'dist-electron', 'main.js');

const NEWLINE = /\r?\n/;

/** First line that is neither blank nor a `#` comment. */
function firstEntry(file) {
  if (!existsSync(file)) return '';
  const text = readFileSync(file, 'utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(NEWLINE)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
}

const defaultRelay = (process.env.SCAV_DEFAULT_RELAY ?? firstEntry(join(here, 'default-relay.txt'))).trim();

const bundle = await rolldown({
  input: join(here, 'main.ts'),
  platform: 'node',
  external: ['electron'],
  // `define` lives under `transform`; at the top level rolldown only warns and silently drops it.
  transform: { define: { __SCAV_DEFAULT_RELAY__: JSON.stringify(defaultRelay) } },
});
await bundle.write({ file: outFile, format: 'esm', sourcemap: false });
await bundle.close();

console.log(`[app:build] ${outFile}`);
console.log(`[app:build] default relay: ${defaultRelay || "(none — the build looks for this PC's server, ws://127.0.0.1:8787/ws)"}`);
