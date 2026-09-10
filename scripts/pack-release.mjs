#!/usr/bin/env node
/**
 * `npm run dist` 의 마지막 단계 — **받는 사람이 그대로 압축해 보낼 폴더**를 만든다 (`release/SCAVANGER/`).
 *
 * ```
 * release/SCAVANGER/
 *   app/                    electron-builder 의 산출물 전부 (SCAVANGER.exe + 런타임 파일 수백 개)
 *   SCAVANGER.exe           stub 런처 — app\SCAVANGER.exe 를 띄운다 (electron/launcher.cs)
 *   server.txt              접속할 서버 주소 한 줄 (사람이 고치는 유일한 파일)
 *   SCAVANGER-Server.exe    서버를 켤 사람만 실행 (scripts/build-server.mjs)
 * ```
 *
 * **왜 stub 인가**: `dir` 타깃의 결과를 그대로 주면 exe 하나 옆에 `.pak` · `locales/` · dll 수백 개가 놓여
 * 어느 것을 눌러야 하는지 알 수 없다. `portable` 타깃(자체 압축 exe)은 그 문제는 없지만 실행할 때마다 임시
 * 폴더로 자기를 풀어 시작이 느리고, 배포 폴더에 `server.txt` 를 두는 지금 구조와도 맞지 않는다. 그래서
 * 실제 빌드는 `app/` 으로 내리고 루트에는 누를 것만 남긴다.
 *
 * stub 은 Windows 에 항상 있는 .NET Framework 컴파일러(`csc.exe`)로 굽는다 — 새 빌드 의존성이 없고,
 * `/target:winexe` 라 콘솔이 깜빡이지 않으며, `/win32icon` 으로 게임과 같은 아이콘을 박는다.
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
const skipServer = process.argv.includes('--no-server');

if (process.platform !== 'win32') {
  console.error('[pack] Windows 전용입니다 (stub 런처 · exe).');
  process.exit(1);
}
if (!existsSync(join(unpacked, 'SCAVANGER.exe'))) {
  console.error(`[pack] ${unpacked}\\SCAVANGER.exe 가 없습니다 — 먼저 "electron-builder --win dir" 이 돌아야 합니다.`);
  process.exit(1);
}

/* ── ① 깨끗한 배포 폴더 + app/ ─────────────────────────────────────────── */
if (existsSync(outDir)) {
  try { rmSync(outDir, { recursive: true, force: true }); } catch (e) {
    console.error(`[pack] 이전 배포 폴더를 지울 수 없습니다 (게임 · 서버가 실행 중인지 확인)\n  ${e.message}`);
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });
// 같은 드라이브이므로 rename 이 즉시 끝난다 (수백 MB 복사를 피한다). 실패하면 복사로 떨어진다.
try {
  renameSync(unpacked, appDir);
} catch {
  cpSync(unpacked, appDir, { recursive: true });
  rmSync(unpacked, { recursive: true, force: true });
}
console.log(`[pack] app/  ← ${unpacked}`);

/* ── ② stub 런처 ──────────────────────────────────────────────────────── */
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
/** 빌드에 구워진 기본 주소 (`electron/default-relay.txt` 의 첫 실주소). 없으면 빈 문자열 = 혼자 플레이. */
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
  '#   - 주소 줄을 지우거나 주석 처리하면 게임이 자기 안의 서버를 씁니다 (혼자 플레이).',
  '#',
  '#   서버를 켜는 사람은 이 폴더의 SCAVANGER-Server.exe 를 실행하고,',
  '#   그 창에 적히는 주소를 나머지 사람들에게 알려 주면 됩니다.',
  '',
  baked,
  '',
].join('\r\n'));   // 메모장으로 여는 파일이라 CRLF 로 쓴다
console.log(`[pack] server.txt  (${baked || '주소 없음 — 혼자 플레이'})`);

/* ── ④ 서버 exe ───────────────────────────────────────────────────────── */
if (skipServer) {
  console.log('[pack] --no-server → 서버 exe 는 만들지 않았습니다');
} else {
  const srv = spawnSync(process.execPath, [
    join(here, 'build-server.mjs'),
    `--out=${join(outDir, 'SCAVANGER-Server.exe')}`,
  ], { stdio: 'inherit' });
  if (srv.status !== 0) {
    console.error('[pack] 서버 exe 빌드 실패');
    process.exit(1);
  }
}

console.log(`\n[pack] 배포 폴더 준비 완료: ${outDir}`);
console.log('  이 폴더를 그대로 압축해 보내면 됩니다 (app 폴더 포함).');
