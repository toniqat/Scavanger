/**
 * Bundle the Electron main process (and the relay it embeds) to `dist-electron/main.js`.
 *
 * `server/` is written in erasable TypeScript and normally runs under Node's `--experimental-strip-types`; Electron's
 * main process has no such loader, so the desktop build bundles it instead. Rolldown ships with vite, so this needs no
 * extra dependency. `electron` and `ws` stay external: the first is provided by the runtime, the second is a real
 * dependency that electron-builder packs into the app.
 */
import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outFile = join(root, 'dist-electron', 'main.js');

const bundle = await rolldown({
  input: join(here, 'main.ts'),
  platform: 'node',
  external: ['electron', 'ws'],
});
await bundle.write({ file: outFile, format: 'esm', sourcemap: false });
await bundle.close();

console.log(`[app:build] ${outFile}`);
