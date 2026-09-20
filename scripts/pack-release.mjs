#!/usr/bin/env node
/**
 * The last step of `npm run app:dist` — it builds **the folder a receiver zips and sends as it is**
 * (`release/SCAVANGER/`).
 *
 * ```
 * release/SCAVANGER/
 *   app/                    everything electron-builder produced (SCAVANGER.exe + hundreds of runtime files)
 *   SCAVANGER.exe           the stub launcher — it starts app\SCAVANGER.exe (electron/launcher.cs)
 *   server.txt              one line, the server address to connect to (the only file a receiver edits)
 * ```
 *
 * **2026-09-15 — no server goes in (user's decision).** `SCAVANGER-Server.exe`, once the fourth entry, and the
 * tools that built it (`scripts/build-server.mjs` · `server/tool.ts` · `pe-signature.mjs`) were deleted. A server
 * runs only from this repo, through `start-server.bat`. So this folder holds exactly three entries and
 * `scripts/smoke-desktop.mjs --release` counts them.
 *
 * **Why a stub**: handing over the `dir` target output as it is puts one exe next to `.pak` · `locales/` and
 * hundreds of dlls, and there is no telling which one to click. The `portable` target (a self-extracting exe)
 * does not have that problem, but it unpacks itself into a temp folder on every run, so it starts slowly, and it
 * does not fit the present shape either, which keeps `server.txt` in the deploy folder. So the real build moves
 * down into `app/` and only the thing to click stays in the root.
 *
 * The stub is built with the .NET Framework compiler (`csc.exe`) Windows always has — no new build dependency,
 * `/target:winexe` so no console flashes, and `/win32icon` puts the same icon on it as the game.
 *
 * ⚠ Never delete `build.electronDist = "node_modules/electron/dist"` from `package.json` (it is JSON, so no
 * comment fits there) — without it electron-builder's `win-unpacked.tmp` rename collides with a security
 * scanner's file lock and `app:dist` dies with `EPERM`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const releaseDir = join(root, 'release');
const unpacked = join(releaseDir, 'win-unpacked');
const outDir = join(releaseDir, 'SCAVANGER');
const appDir = join(outDir, 'app');
const icon = join(root, 'electron', 'resources', 'icon.ico');

if (process.platform !== 'win32') {
  console.error('[pack] Windows 전용입니다 (stub 런처 · exe).');
  process.exit(1);
}
if (!existsSync(join(unpacked, 'SCAVANGER.exe'))) {
  console.error(`[pack] ${unpacked}\\SCAVANGER.exe 가 없습니다 — 먼저 "electron-builder --win dir" 이 돌아야 합니다.`);
  process.exit(1);
}

/* ── ① a clean deploy folder + app/ ─────────────────────────────── */
if (existsSync(outDir)) {
  try { rmSync(outDir, { recursive: true, force: true }); } catch (e) {
    console.error(`[pack] 이전 배포 폴더를 지울 수 없습니다 (게임이 실행 중인지 확인)\n  ${e.message}`);
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });
// Same drive, so the rename finishes at once (it avoids copying hundreds of MB). On failure it falls back to a copy.
try {
  renameSync(unpacked, appDir);
} catch {
  cpSync(unpacked, appDir, { recursive: true });
  rmSync(unpacked, { recursive: true, force: true });
}
console.log(`[pack] app/  ← ${unpacked}`);

/* ── ② the stub launcher ────────────────────────────────────────────── */
const csc = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((p) => existsSync(p));
if (!csc) {
  console.error('[pack] csc.exe (.NET Framework 4) 를 찾을 수 없어 stub 을 만들 수 없습니다.');
  process.exit(1);
}
const stubExe = join(outDir, 'SCAVANGER.exe');
const cs = spawnSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  `/out:${stubExe}`,
  ...(existsSync(icon) ? [`/win32icon:${icon}`] : []),
  '/r:System.dll',
  '/r:System.Windows.Forms.dll',
  join(root, 'electron', 'launcher.cs'),
], { stdio: 'inherit' });
if (cs.status !== 0) {
  console.error('[pack] stub 컴파일 실패');
  process.exit(1);
}
console.log(`[pack] SCAVANGER.exe  (stub → app\\SCAVANGER.exe${existsSync(icon) ? ' · 아이콘 적용' : ''})`);

/* ── ③ server.txt ─────────────────────────────────────────────────────── */
/**
 * The default address baked into the build (the first real address in `electron/default-relay.txt`).
 * None at all = an empty string = it looks for this PC's server.
 */
function bakedAddress() {
  const f = join(root, 'electron', 'default-relay.txt');
  if (!existsSync(f)) return '';
  const text = readFileSync(f, 'utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .split(/\r?\n/).map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
}
const baked = bakedAddress();
writeFileSync(join(outDir, 'server.txt'), [
  '# SCAVANGER 접속할 서버 주소',
  '#',
  '#   - 주석(#)과 빈 줄을 뺀 첫 줄이 접속할 서버입니다. 고치면 다음 실행부터 바로 반영됩니다.',
  '#   - 게임 안 [설정 › 서버 설정] 에 주소를 적으면 그것이 이 파일보다 우선합니다.',
  '#     (그 칸을 비우면 다시 이 파일의 주소를 씁니다)',
  '#   - 형식은 ws://주소:8787/ws 입니다. "192.168.0.12" 처럼 주소만 적어도 됩니다.',
  '#   - 주소 줄을 지우거나 주석 처리하면 이 PC 의 서버(ws://127.0.0.1:8787/ws)에 붙습니다.',
  '#     게임 안에는 서버가 들어 있지 않습니다 — 그때는 이 PC 에서 start-server.bat 가 켜져 있어야 합니다.',
  '#',
  '#   서버는 SCAVANGER 프로젝트 폴더의 start-server.bat 로만 켭니다.',
  '#   서버를 켠 사람의 창에 적히는 주소를 이 파일이나 게임 설정에 적으면 됩니다.',
  '',
  baked,
  '',
].join('\r\n'));   // a file opened in Notepad, so it is written with CRLF
console.log(`[pack] server.txt  (${baked || '주소 없음 — 이 PC 의 서버 ws://127.0.0.1:8787/ws'})`);

console.log(`\n[pack] 배포 폴더 준비 완료: ${outDir}`);
console.log('  이 폴더를 그대로 압축해 보내면 됩니다 (app 폴더 포함). 서버는 들어 있지 않습니다 — start-server.bat 로 켭니다.');
