#!/usr/bin/env node
/**
 * `npm run server:dist` — 릴레이를 **Node 없이 도는 단독 exe** 로 굽는다 (`release/SCAVANGER-Server.exe`).
 *
 * 서버를 켜는 사람에게 저장소도 `npm install` 도 요구하지 않는 것이 목적이다. 세 단계다:
 *
 *   ① **번들**: `server/tool.ts` + 릴레이 + `ws` 를 파일 하나(`dist-server/server.cjs`)로 묶는다. rolldown 은
 *      vite 의 의존성이라 새 패키지가 필요 없다 (`electron/build.mjs` 와 같은 이유). 형식은 **CJS** 다 —
 *      Node SEA 의 main 스크립트는 CommonJS 여야 한다. 그래서 `tool.ts` 에 top-level await 이 없다.
 *   ② **blob**: `node --experimental-sea-config` 가 그 스크립트를 SEA blob 으로 만든다.
 *   ③ **주입**: `node.exe` 사본에 postject 로 blob 을 넣는다. 이때부터 그 exe 는 우리 스크립트를 실행한다.
 *      아이콘은 `rcedit`(있으면)으로 갈아 끼운다 — 없으면 Node 아이콘으로 남고 빌드는 성공한다.
 *
 * `ws` 의 선택적 네이티브 가속(`bufferutil` · `utf-8-validate`)은 external 로 남긴다: ws 가 `try/catch` 안에서
 * require 하므로 없으면 순수 JS 경로로 조용히 내려간다. 번들에 넣으려 하면 해석 실패로 빌드가 깨진다.
 */
import { rolldown } from 'rolldown';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'dist-server');
const bundle = join(outDir, 'server.cjs');
const blob = join(outDir, 'server.blob');
const seaConfig = join(outDir, 'sea-config.json');
/** `--out=<path>` 로 배포 폴더에 바로 굽는다 (`scripts/pack-release.mjs` 가 그렇게 부른다). */
const outArg = process.argv.find((a) => a.startsWith('--out='));
const exeOut = outArg ? outArg.slice('--out='.length) : join(root, 'release', 'SCAVANGER-Server.exe');
const bundleOnly = process.argv.includes('--bundle-only');

mkdirSync(outDir, { recursive: true });

/* ── ① 번들 ─────────────────────────────────────────────────────────── */
const b = await rolldown({
  input: join(root, 'server', 'tool.ts'),
  platform: 'node',
  external: ['bufferutil', 'utf-8-validate'],
});
await b.write({ file: bundle, format: 'cjs', sourcemap: false });
await b.close();
console.log(`[server:dist] bundle ${bundle}  (${(statSync(bundle).size / 1024).toFixed(0)} KB)`);

if (bundleOnly) {
  console.log('[server:dist] --bundle-only → exe 는 만들지 않았습니다');
  process.exit(0);
}
if (process.platform !== 'win32') {
  console.log('[server:dist] Windows 가 아니므로 exe 는 건너뜁니다 (번들만 만들었습니다)');
  process.exit(0);
}

/* ── ② SEA blob ─────────────────────────────────────────────────────── */
writeFileSync(seaConfig, `${JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2)}\n`);
const sea = spawnSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
if (sea.status !== 0) {
  console.error('[server:dist] SEA blob 생성 실패');
  process.exit(1);
}

/* ── ③ node.exe 사본 + postject ─────────────────────────────────────── */
mkdirSync(dirname(exeOut), { recursive: true });
// 실행 중인 exe 는 덮어쓸 수 없다 — 앞선 서버가 아직 떠 있으면 여기서 알려 주고 멈춘다.
if (existsSync(exeOut)) {
  try { rmSync(exeOut); } catch (e) {
    console.error(`[server:dist] ${exeOut} 를 지울 수 없습니다 (실행 중인 서버를 먼저 끄세요)\n  ${e.message}`);
    process.exit(1);
  }
}
copyFileSync(process.execPath, exeOut);

const require = createRequire(import.meta.url);
const { inject } = require('postject');
await inject(exeOut, 'NODE_SEA_BLOB', readFileSync(blob), {
  // Node 가 자기 안에 SEA 가 있는지 찾을 때 보는 값. Node 문서에 박힌 상수이고 버전과 무관하다.
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});
console.log(`[server:dist] ${exeOut}  (${(statSync(exeOut).size / 1024 / 1024).toFixed(0)} MB)`);

/* 아이콘: 있으면 갈아 끼우고 없으면 넘어간다 (배포 자체를 막을 이유가 없다). */
const icon = join(root, 'electron', 'resources', 'icon.ico');
const rcedit = join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
if (existsSync(icon) && existsSync(rcedit)) {
  const r = spawnSync(rcedit, [
    exeOut,
    '--set-icon', icon,
    '--set-version-string', 'FileDescription', 'SCAVANGER 서버',
    '--set-version-string', 'ProductName', 'SCAVANGER Server',
  ], { stdio: 'inherit' });
  console.log(r.status === 0 ? '[server:dist] 아이콘 · 버전 정보 적용' : '[server:dist] 아이콘 적용 실패 (무시)');
} else {
  console.log('[server:dist] 아이콘을 건너뜁니다 (icon.ico 또는 rcedit 없음)');
}
