#!/usr/bin/env node
/**
 * Verification runner — the one command to run after a change.
 *
 *   node scripts/verify.mjs                      # --changed: smokes for the folders touched in the working tree
 *   node scripts/verify.mjs --all                # everything (typecheck, build, selftest, 8 smokes, e2e) — before a merge
 *   node scripts/verify.mjs --folders weapons,ui # smokes mapped to those feature folders
 *   node scripts/verify.mjs --only smoke-weapons,e2e-mp
 *   node scripts/verify.mjs --rerun-failed       # only what failed in the previous run (scripts/logs/last-run.json)
 *   node scripts/verify.mjs --list               # folder → smoke map (+ src/ 밖의 경로 매핑)
 *   node scripts/verify.mjs --help               # this text (an unknown option prints it too and runs nothing)
 *
 * Options: --jobs N (parallel Chrome instances, default 4; use 1–2 with SMOKE_GL=swiftshader, which is CPU-bound) · --serial · --base <git ref> (diff base for --changed,
 *          default = working tree vs HEAD, falling back to HEAD~1) · --build · --no-typecheck · --no-e2e ·
 *          --keep-relay (do not restart a relay already listening on 8787) · --url http://host:port/ · --timeout <min> ·
 *          --log-dir <dir> (default scripts/logs — give each concurrent runner its own, e.g. scripts/logs/agent-3)
 *
 * What it does:
 *   1. typecheck (client + server), net:selftest and data:check (data/*.csv 스키마) in parallel — seconds.
 *   2. Starts vite (5273) and the relay (8787) if they are not up — **unless every selected script is `standalone`**
 *      (smoke-server-dist, smoke-pitch), which use neither. When e2e-mp is in the set the relay is always
 *      restarted first: public lobbies left by an interrupted run live for the 5-min grace and hijack quick match.
 *   3. Runs the selected smoke scripts concurrently (each owns its own headless Chrome on the real GPU via ANGLE D3D11,
 *      10–50 s each; lanes start 8 s apart so vite warm-up and Chrome launches never coincide). Output goes to
 *      scripts/logs/<name>.log; only the summary and the FAIL lines are printed. SMOKE_GL=swiftshader (no GPU / CI) is
 *      ~10× slower and CPU-bound: measured 2026-09-06, one script ≈ 140 s alone and 2 lanes gained nothing (31 min total).
 *   4. e2e-mp runs alone at the end (two browsers, 15 s waits — sensitive to CPU contention).
 *   5. Writes scripts/logs/last-run.json and prints a one-line result string ready to paste into docs/VERIFICATION.md.
 *   Servers started here are stopped on exit; servers found running are left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, createWriteStream } from 'node:fs';
import { CSV_FOLDERS, CSV_WIDE } from './data-owners.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// `--log-dir <dir>` (2026-09-11): 여러 에이전트가 같은 트리에서 동시에 돌 때 서로의 로그 · last-run.json 을 덮어쓰지 않게.
const LOG_ARG = process.argv.indexOf('--log-dir');
const LOG_REL = (LOG_ARG >= 0 && process.argv[LOG_ARG + 1] ? process.argv[LOG_ARG + 1] : 'scripts/logs').replace(/\\/g, '/').replace(/\/$/, '');
const LOG_DIR = resolve(ROOT, LOG_REL);
const LAST_RUN = resolve(LOG_DIR, 'last-run.json');
const isWin = process.platform === 'win32';

// ─── Job catalogue ─────────────────────────────────────────────────────────────────────────────────────────────
// `folders` = feature folders (src/<name>, or `server`) whose changes make this script relevant.
// `standalone: true` = neither vite nor the relay is used, so the runner does not start them.
// Keep this in sync with the "Verification" section of CLAUDE.md when a smoke is added.
const SMOKES = {
  'smoke-weapons':      { file: 'scripts/smoke-weapons.mjs',      folders: ['weapons', 'items', 'inventory', 'hub', 'pickups', 'audio'] },
  'smoke-phase2':       { file: 'scripts/smoke-phase2.mjs',       folders: ['player', 'weapons', 'inventory', 'game', 'ui'] },
  'smoke-quickslots':   { file: 'scripts/smoke-quickslots.mjs',   folders: ['inventory', 'ui', 'weapons'] },
  'smoke-phase3':       { file: 'scripts/smoke-phase3.mjs',       folders: ['stratagems', 'world', 'ui', 'weapons'] },
  'smoke-stratagems':   { file: 'scripts/smoke-stratagems.mjs',   folders: ['stratagems', 'world'] },
  'smoke-phase4':       { file: 'scripts/smoke-phase4.mjs',       folders: ['enemies', 'items', 'world', 'inventory', 'weapons', 'player'] },
  'smoke-tactical':     { file: 'scripts/smoke-tactical.mjs',     folders: ['implants', 'gadgets', 'progression', 'player', 'world', 'enemies', 'inventory', 'items', 'weapons', 'audio'] },
  'smoke-controls-hub': { file: 'scripts/smoke-controls-hub.mjs', folders: ['ui', 'hub', 'inventory', 'implants', 'progression', 'player', 'net'] },
  'smoke-ship-rooms':   { file: 'scripts/smoke-ship-rooms.mjs',   folders: ['hub', 'housing'] },
  'smoke-inventory-p6': { file: 'scripts/smoke-inventory-p6.mjs', folders: ['inventory', 'housing', 'items'] },
  'smoke-loadout':      { file: 'scripts/smoke-loadout.mjs',      folders: ['inventory'] },
  'smoke-search':       { file: 'scripts/smoke-search.mjs',       folders: ['inventory'] },
  'smoke-housing':      { file: 'scripts/smoke-housing.mjs',      folders: ['housing', 'hub', 'inventory', 'progression'] },
  'smoke-console':      { file: 'scripts/smoke-console.mjs',      folders: ['console', 'progression', 'inventory', 'player', 'hub'] },
  'smoke-progression':  { file: 'scripts/smoke-progression.mjs',  folders: ['progression'] },
  'smoke-ui-p6':        { file: 'scripts/smoke-ui-p6.mjs',        folders: ['ui'] },
  'smoke-ui-p5':        { file: 'scripts/smoke-ui-p5.mjs',        folders: ['ui', 'meta', 'game'] },
  'smoke-uniques':      { file: 'scripts/smoke-uniques.mjs',      folders: ['weapons', 'items', 'enemies', 'player', 'ui'] },
  'smoke-rogue-v2':     { file: 'scripts/smoke-rogue-v2.mjs',     folders: ['enemies'] },
  'smoke-enemy-alert':  { file: 'scripts/smoke-enemy-alert.mjs',  folders: ['enemies', 'implants', 'weapons'] },
  'smoke-rogue-drop':   { file: 'scripts/smoke-rogue-drop.mjs',   folders: ['enemies', 'world'] },
  'smoke-resume-gate':  { file: 'scripts/smoke-resume-gate.mjs',  folders: ['game', 'ui'] },
  'smoke-meta':         { file: 'scripts/smoke-meta.mjs',         folders: ['meta', 'inventory', 'hub', 'ui', 'game'] },
  'smoke-training':     { file: 'scripts/smoke-training.mjs',     folders: ['world', 'hub', 'housing', 'game'] },
  'smoke-ghost':        { file: 'scripts/smoke-ghost.mjs',        folders: ['player', 'net', 'game'] },
  /* 2026-09-11: 사다리 (잡기 · W/S · 달리기 스태미나 · 꼭대기 올라서기 · E 놓기 · 점프 · 발치 내려서기 · 무기 잠금 ·
     CLIMBING 비트) + 단차 보간(`bodyOffset`) + 월드 천장 클램프. 가짜 `LadderDef` 로 돌아 world 의 사다리가 없어도 된다. */
  'smoke-ladder':       { file: 'scripts/smoke-ladder.mjs',       folders: ['player', 'net'] },
  'smoke-raidflow':     { file: 'scripts/smoke-raidflow.mjs',     folders: ['game', 'extraction', 'player', 'inventory', 'world'] },
  'smoke-library':      { file: 'scripts/smoke-library.mjs',      folders: ['housing', 'items', 'hub', 'inventory'] },
  'smoke-enemy-delta':  { file: 'scripts/smoke-enemy-delta.mjs',  folders: ['enemies', 'net'] },
  /* Phase 11 */
  'smoke-planets':      { file: 'scripts/smoke-planets.mjs',      folders: ['hub', 'world', 'game'] },
  'smoke-social':       { file: 'scripts/smoke-social.mjs',       folders: ['ui', 'net'] },
  'smoke-ecology':      { file: 'scripts/smoke-ecology.mjs',      folders: ['world', 'enemies', 'items'] },
  /* 2026-09-09: 소품 콜라이더가 그려진 실루엣보다 큰지 **숫자로** 잰다. `Props.hullOf` 가 바운딩 박스로
     콜라이더를 만들기 때문에 지오메트리 쪽 사고(→ `noise3` 의 lerp 인자 순서)가 곧 보이지 않는 벽이 된다. */
  'smoke-props-collision': { file: 'scripts/smoke-props-collision.mjs', folders: ['world'] },
  /* 2026-09-09: 버려진 구조물 · 선로 · 전차. 같은 취지로 **사각(OBB) 콜라이더**가 그려진 실루엣 안에 있는지
     재고, 실내 이동 · 지하실 해치 · 플랫폼 데크 · 전차 발판 속도까지 본다. */
  'smoke-structures':   { file: 'scripts/smoke-structures.mjs',   folders: ['world', 'items', 'inventory'] },
  /* 2026-09-09: 환경 재해 — 종류 · 시작 시각이 시드의 함수라 와이어가 없다. 시드 결정성 · 도형 규약 ·
     끝까지 갔을 때의 맵 봉쇄 · 초당 피해 · atmo:override · 거대 버섯 군락을 브라우저 안에서 잰다. */
  'smoke-hazard':       { file: 'scripts/smoke-hazard.mjs',       folders: ['world'] },
  /* 2026-09-08: 튜토리얼 — 게이트가 housing / hub / inventory / meta 의 거절 사유 함수에 들어가 있으므로
     그 폴더를 건드리면 함께 돈다. 다른 스모크는 전부 `scav.s1.tutorial` 을 done 으로 심고 시작한다. */
  'smoke-tutorial':     { file: 'scripts/smoke-tutorial.mjs',     folders: ['tutorial', 'hub', 'housing', 'inventory', 'ui', 'items'] },
  /* 2026-09-08: 공용 함선 격납고 — 두 클라이언트가 필요하다 (개인 함선 방문 · `hs` 동석 규칙). 릴레이를 쓰므로
     e2e 와 같이 exclusive 로 돈다. */
  'smoke-hangar':       { file: 'scripts/smoke-hangar.mjs',       folders: ['hub', 'net', 'housing', 'player'], exclusive: true, freshRelay: true },
  /* 2026-09-10: 배포용 서버 빌드 (`npm run server:dist`) — 브라우저도 vite 도 릴레이도 쓰지 않는다.
     번들이 CJS 인지 · ws 가 안에 들어갔는지 · `--port` / `--data` 가 먹는지 · 릴레이가 말을 하는지, 그리고
     주소 정규화(`relayUrlFrom`) · LAN 주소 순위(`lanAddresses`)를 검사한다. exe 는 굽지 않는다 (86 MB). */
  /* 2026-09-11 (C-46): 이 스모크는 `src/shared/net.ts` 를 Node 에서 직접 import 한다 — Node 22.6–22.17 은 플래그 없이는
     `.ts` 를 못 읽는다(23.6+ 는 기본). `nodeArgs` 는 스크립트 경로 **앞에** 펼쳐진다 (net:selftest 와 같은 플래그). */
  'smoke-server-dist': { file: 'scripts/smoke-server-dist.mjs', folders: ['server', 'net'], standalone: true,
    nodeArgs: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] },
  /* 2026-09-10: 피칭 위키(`docs/pitch/`) — 빌드가 없어서 깨져도 조용한 문서다. vite 도 게임도 쓰지 않고
     `docs/pitch` 를 정적으로 서빙해 페이지를 전부 열어 본다 (링크 · 사이드바 · nextnav · 카드 넘기기).
     `folders` 로는 안 잡히므로(`src/` 밖이다) 위의 `EXTRA_PATHS` 가 `docs/pitch/` 변경에서 직접 고른다. */
  'smoke-pitch':        { file: 'scripts/smoke-pitch.mjs',        folders: [], standalone: true },
  /* 2026-09-10: 씬의 광원 개수. 플레이 중에 그 숫자가 바뀌면 씬의 모든 머티리얼이 셰이더를 다시 컴파일해
     한 프레임이 멎는다 — 지금까지 탈출 함선 · 신호탄 · 헬포드 · 분대장 기기가 이 그물에 걸렸다. 광원을
     들고 있는 폴더 전부에 매핑한다. */
  'smoke-lights':       { file: 'scripts/smoke-lights.mjs',       folders: ['extraction', 'player', 'game', 'hub', 'world', 'core'] },
  /* 2026-09-11 (C 배치): 네임드 로그 판정 (엎드린 로든 눕힌 캡슐 · 소염기 매몰 · 승격 시 스캔 드론 입양 · 리플리카 헤비
     트레이서 · 리플리카 훅 host) 과 전차 위 적 · 적 시체 탑승 (+ 리플리카 예측 · 강하 목표 플랫폼). 둘 다 릴레이 없이 돈다. */
  'smoke-named':        { file: 'scripts/smoke-named.mjs',        folders: ['enemies', 'weapons'] },
  'smoke-tram-ride':    { file: 'scripts/smoke-tram-ride.mjs',    folders: ['enemies', 'world'] },
  /* 2026-09-11 (E-4 + C-57 · X-6): 신뢰 경로 — 두 클라이언트 · **코드로 만든 비공개 로비**(빠른 매칭 아님)로 레이드에 들어가
     위조 strat call / stratq call · 버프 상한 · 벽 뒤 스프레이 · 계약 킬 파생 · meta sync rid · crate opened 거리 · 넉백 기하 ·
     hit 요청 DPS 상한을 잰다. 공용 릴레이를 쓰지만 자기 로비라 exclusive 가 아니다. */
  'smoke-trust':        { file: 'scripts/smoke-trust.mjs',        folders: ['stratagems', 'weapons', 'implants', 'gadgets', 'meta', 'enemies'] },
  /* 2026-09-11 (B-1): 링크 상태 · 익명 배경 프로브 · 연결 배지 · 거절 뒤 프로브 없음 · 셸 임베디드 목표. 공용 릴레이(8787)는
     쓰지 않고 8885(스스로 띄우고 죽이는 릴레이) · 8886(대답 없는 TCP)을 쓴다 — 그래서 exclusive 가 아니다. */
  'smoke-netlink':      { file: 'scripts/smoke-netlink.mjs',      folders: ['net', 'ui', 'hub'] },
  /* 2026-09-11 (E-3): 데스크톱 셸을 **진짜 Electron** 으로 (`--hidden --user-data=<임시>`, 창 8820 · 릴레이 8821 · 8822 ·
     8823 · 디버깅 9340 · 메인 인스펙터 9341). vite 도 공용 릴레이도 안 쓰지만 GPU · 포트를 잡고 `dist/` 가 오래됐으면
     vite build 를 돌리므로 혼자 돈다. `folders` 로는 안 잡힌다 — `EXTRA_PATHS` 가 `electron/` · `pack-release` · 자기 자신에서 고른다. */
  'smoke-desktop':      { file: 'scripts/smoke-desktop.mjs',      folders: [], standalone: true, exclusive: true },
  'e2e-mp':             { file: 'scripts/e2e-multiplayer.mjs',    folders: ['net', 'server', 'game', 'extraction', 'hub', 'pickups', 'player', 'enemies'], exclusive: true, freshRelay: true },
};
// Anything under these paths touches the contract / bootstrap → run everything.
const GLOBAL_PATHS = [/^src\/shared\//, /^src\/core\//, /^src\/main\.ts$/, /^index\.html$/, /^vite\.config/, /^package\.json$/, /^tsconfig/];

// `src/` 밖에 사는 것들 — 폴더 이름으로는 안 잡히므로 경로에서 스모크를 직접 고른다.
const EXTRA_PATHS = [
  { label: 'docs/pitch/', re: /^docs\/pitch\//, smokes: ['smoke-pitch'] },
  // 2026-09-11 (E-3): 데스크톱 셸 · 배포 폴더 · 그 스모크 자신.
  { label: 'electron/', re: /^electron\//, smokes: ['smoke-desktop'] },
  { label: 'scripts/pack-release.mjs', re: /^scripts\/pack-release\.mjs$/, smokes: ['smoke-desktop'] },
  { label: 'scripts/smoke-desktop.mjs', re: /^scripts\/smoke-desktop\.mjs$/, smokes: ['smoke-desktop'] },
];

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
/* 2026-09-11: 모르는 플래그 · --help 는 **아무것도 돌리지 않고** 머리 주석을 찍고 끝낸다. 예전에는 조용히 무시돼서
   `verify.mjs --help` 가 인자 없는 --changed 전체 검증(릴레이 재시작 + e2e 포함)을 시작했다. */
const KNOWN_FLAGS = new Set(['--all', '--list', '--rerun-failed', '--serial', '--build', '--no-typecheck', '--no-e2e', '--keep-relay']);
const VALUE_FLAGS = new Set(['--folders', '--only', '--base', '--jobs', '--url', '--timeout', '--log-dir']);
{
  const unknown = argv.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !VALUE_FLAGS.has(a) && !VALUE_FLAGS.has(argv[i - 1]));
  if (unknown.length) {
    const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
    const isHelp = unknown.every((a) => a === '--help' || a === '-h');
    if (!isHelp) console.error(`unknown option(s): ${unknown.join(' ')}\n`);
    console.log(head.split('\n').map((l) => l.replace(/^\s?\*\s?/, '')).join('\n').trim());
    process.exit(isHelp ? 0 : 2);
  }
}
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const opts = {
  all: has('--all'), list: has('--list'), rerunFailed: has('--rerun-failed'),
  folders: val('--folders', '').split(',').filter(Boolean),
  only: val('--only', '').split(',').filter(Boolean),
  base: val('--base', null),
  jobs: has('--serial') ? 1 : Math.max(1, Number(val('--jobs', 4)) || 4),
  build: has('--build') || has('--all'),
  typecheck: !has('--no-typecheck'),
  e2e: !has('--no-e2e'),
  keepRelay: has('--keep-relay'),
  url: val('--url', 'http://localhost:5273/'),
  timeoutMs: (Number(val('--timeout', 15)) || 15) * 60_000,
};

if (opts.list) {
  const byFolder = {};
  for (const [name, j] of Object.entries(SMOKES)) for (const f of j.folders) (byFolder[f] ??= []).push(name);
  console.log('folder → smoke scripts');
  for (const f of Object.keys(byFolder).sort()) console.log(`  ${f.padEnd(12)} ${byFolder[f].join(', ')}`);
  console.log(`  ${'(global)'.padEnd(12)} src/shared, src/core, main.ts, package.json → all`);
  // `src/` 밖의 경로로 붙는 것들은 폴더 표에 안 나오므로 따로 찍는다.
  for (const e of EXTRA_PATHS) console.log(`  ${'(path)'.padEnd(12)} ${e.label} → ${e.smokes.join(', ')}`);
  // 2026-09-11: data/*.csv → 소비 폴더 (`scripts/data-owners.mjs`). 스모크는 위 폴더 표를 따라간다.
  console.log('\ndata csv → folders (scripts/data-owners.mjs)');
  for (const [csv, fs] of Object.entries(CSV_FOLDERS).sort()) console.log(`  ${csv.padEnd(26)} ${fs.join(', ')}`);
  console.log(`  ${[...CSV_WIDE].join(', ').padEnd(26)} (wide — no smokes picked, a note is printed)`);
  let csvOnDisk = [];
  try { csvOnDisk = readdirSync(resolve(ROOT, 'data')).filter((f) => f.endsWith('.csv')); } catch { /* no data dir */ }
  const unmapped = csvOnDisk.filter((f) => !CSV_WIDE.has(f) && !CSV_FOLDERS[f]);
  if (unmapped.length) console.log(`  ⚠ not mapped (a change to these picks no smokes): ${unmapped.join(', ')}`);
  process.exit(0);
}

// ─── Selection ─────────────────────────────────────────────────────────────────────────────────────────────────
function git(args) { return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? ''; }
function changedFiles() {
  if (opts.base) return git(['diff', '--name-only', opts.base]).split('\n').filter(Boolean);
  const status = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim()).map((p) => p.includes(' -> ') ? p.split(' -> ')[1] : p);
  if (status.length) return status;
  return git(['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
}
function foldersOf(files) {
  const folders = new Set(); const extra = new Set(); const notes = []; let global = false;
  for (const f of files) {
    const p = f.replace(/\\/g, '/');
    if (GLOBAL_PATHS.some((re) => re.test(p))) { global = true; continue; }
    const m = p.match(/^src\/([^/]+)\//); if (m) folders.add(m[1]);
    if (/^server\//.test(p)) folders.add('server');
    for (const e of EXTRA_PATHS) if (e.re.test(p)) e.smokes.forEach((n) => extra.add(n));
    // 2026-09-11: data/<file>.csv → 그 수치를 소비하는 폴더 (`scripts/data-owners.mjs`). 전역 표는 고르지 않고 알린다.
    const csv = p.match(/^data\/([^/]+\.csv)$/)?.[1];
    if (csv) {
      if (CSV_WIDE.has(csv)) notes.push(`data/${csv} 는 거의 모든 폴더가 읽는다 — 스모크를 고르지 않았다 (--folders 로 직접 주거나 verify:all)`);
      else if (CSV_FOLDERS[csv]) CSV_FOLDERS[csv].forEach((x) => folders.add(x));
      else notes.push(`data/${csv} 가 scripts/data-owners.mjs 의 CSV_FOLDERS 에 없다 — 스모크를 고르지 못했다`);
    }
  }
  return { folders: [...folders], extra: [...extra], global, notes };
}
function select() {
  const names = Object.keys(SMOKES);
  let picked, reason;
  if (opts.only.length) {
    const bad = opts.only.filter((n) => !SMOKES[n]);
    if (bad.length) { console.error(`unknown script(s): ${bad.join(', ')}. Known: ${names.join(', ')}`); process.exit(2); }
    picked = opts.only; reason = '--only';
  } else if (opts.rerunFailed) {
    if (!existsSync(LAST_RUN)) { console.error(`no previous run recorded (${LOG_REL}/last-run.json)`); process.exit(2); }
    const last = JSON.parse(readFileSync(LAST_RUN, 'utf8'));
    picked = last.results.filter((r) => !r.ok).map((r) => r.name).filter((n) => SMOKES[n]);
    reason = `--rerun-failed (${last.time})`;
  } else if (opts.all) {
    picked = names; reason = '--all';
  } else if (opts.folders.length) {
    picked = names.filter((n) => SMOKES[n].folders.some((f) => opts.folders.includes(f)));
    reason = `--folders ${opts.folders.join(',')}`;
  } else {
    const files = changedFiles();
    const { folders, extra, global, notes } = foldersOf(files);
    for (const n of notes) console.log(`  note: ${n}`);
    if (global) { picked = names; reason = `changed: shared/core/bootstrap → all (${files.length} files)`; }
    else {
      // `extra` = `src/` 밖의 경로가 직접 고른 것 (docs/pitch → smoke-pitch). 폴더 매핑과 합집합이다.
      picked = names.filter((n) => extra.includes(n) || SMOKES[n].folders.some((f) => folders.includes(f)));
      reason = `changed folders: ${[...folders, ...extra.map((n) => `(${n})`)].join(', ') || '(none)'}`;
    }
  }
  if (!opts.e2e) picked = picked.filter((n) => n !== 'e2e-mp');
  return { picked, reason };
}

// ─── Process helpers ───────────────────────────────────────────────────────────────────────────────────────────
const children = new Set();
function npmRun(script, logName, extraEnv = {}) {
  const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
  const env = { ...process.env, FORCE_COLOR: '0', ...extraEnv };
  const child = isWin
    ? spawn(`npm.cmd run ${script}`, { shell: true, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
    : spawn('npm', ['run', script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  child.stdout.pipe(log); child.stderr.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}
function pidsOnPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    return [...new Set(out.split('\n').map((l) => l.match(re)?.[1]).filter((p) => p && p !== '0'))];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').filter(Boolean);
}
function killPort(port) {
  for (const pid of pidsOnPort(port)) {
    if (isWin) spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
  }
}
async function isUp(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, label, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await isUp(url)) return true; await sleep(500); }
  throw new Error(`${label} did not come up at ${url} within ${ms / 1000}s (see ${LOG_REL}/)`);
}
/** Run a command, capture everything to a log, return {code, out, seconds}. */
function runCapture(cmd, args, logName, { shell = false, timeoutMs = opts.timeoutMs } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    const log = createWriteStream(resolve(LOG_DIR, `${logName}.log`));
    let out = '';
    const child = spawn(cmd, args, { shell, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
    children.add(child);
    const onData = (chunk) => { out += chunk; log.write(chunk); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { out += `\n[verify] timeout after ${timeoutMs / 60000} min — killed\n`; killTree(child); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer); children.delete(child); log.end();
      done({ code: code ?? (signal ? 1 : 0), out, seconds: Math.round((Date.now() - t0) / 1000) });
    });
    child.on('error', (err) => { clearTimeout(timer); children.delete(child); done({ code: 1, out: String(err), seconds: 0 }); });
  });
}
function summarize(name, r) {
  const m = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  const ratio = r.out.match(/(\d+)\/(\d+) passed/); // server selftest prints "selftest: 101/101 passed"
  const passed = m ? Number(m[1]) : ratio ? Number(ratio[1]) : null;
  const failed = m ? Number(m[2]) : ratio ? Number(ratio[2]) - Number(ratio[1]) : null;
  const consoleErrs = r.out.match(/(\d+) console errors/)?.[1];
  const ok = r.code === 0 && (failed === null || failed === 0);
  const fails = r.out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 12);
  const score = passed !== null ? `${passed}/${passed + failed}` : (r.code === 0 ? 'ok' : `exit ${r.code}`);
  return { name, ok, score, passed, failed, consoleErrs: consoleErrs ? Number(consoleErrs) : undefined, seconds: r.seconds, code: r.code, fails, log: `${LOG_REL}/${name}.log` };
}
function report(s) {
  const mark = s.ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m';
  console.log(`${mark} ${s.name.padEnd(20)} ${s.score.padEnd(9)} ${String(s.seconds).padStart(4)} s${s.ok ? '' : `   → ${s.log}`}`);
  for (const f of s.fails) console.log(`      ${f.trim()}`);
  if (!s.ok && !s.fails.length) console.log(`      (no FAIL line — crashed or timed out; tail of ${s.log}:)\n      ${tail(s.log)}`);
}
function tail(logRel, n = 6) {
  try { return readFileSync(resolve(ROOT, logRel), 'utf8').trim().split('\n').slice(-n).join('\n      '); } catch { return ''; }
}

// ─── Main ──────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });
const started = { vite: null, relay: null, relayData: null };
const results = [];
const tStart = Date.now();
let exiting = false;
function cleanup() {
  if (exiting) return; exiting = true;
  for (const c of children) killTree(c);
  killTree(started.vite); killTree(started.relay);
  if (started.relayData) { try { rmSync(started.relayData, { recursive: true, force: true }); } catch { /* still locked → stays in %TEMP% */ } }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  const { picked, reason } = select();
  console.log(`verify — ${reason}`);
  console.log(`  smokes: ${picked.length ? picked.join(', ') : '(none)'}   jobs: ${opts.jobs}   cpus: ${os.cpus().length}`);

  // 1. Fast static checks, all in parallel.
  const npx = isWin ? 'npx.cmd' : 'npx';
  const fast = [];
  if (opts.typecheck) {
    fast.push(runCapture(npx, ['tsc', '--noEmit'], 'typecheck', { shell: isWin }).then((r) => summarize('typecheck', r)));
    fast.push(runCapture(npx, ['tsc', '--noEmit', '-p', 'server/tsconfig.json'], 'typecheck-server', { shell: isWin }).then((r) => summarize('typecheck-server', r)));
  }
  fast.push(runCapture(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/selftest.ts'], 'net-selftest').then((r) => summarize('net-selftest', r)));

  // data/*.csv 는 수치의 단일 원본이다 — 오타는 게임을 죽이지 않고 조용히 기본값으로 굴러가므로 여기서 잡는다.
  fast.push(runCapture(process.execPath, ['scripts/data-check.mjs'], 'data-check').then((r) => summarize('data-check', r)));
  if (opts.build) fast.push(runCapture(npx, ['vite', 'build'], 'build', { shell: isWin }).then((r) => {
    const s = summarize('build', r);
    const js = r.out.match(/index-[\w-]+\.js\s+([\d.,]+ kB)/)?.[1]; const css = r.out.match(/index-[\w-]+\.css\s+([\d.,]+ kB)/)?.[1];
    if (js) s.score = `${js} JS${css ? ` / ${css} CSS` : ''}`;
    return s;
  }));
  for (const s of await Promise.all(fast)) { results.push(s); report(s); }

  // `standalone` = 이 스크립트는 vite 도 릴레이도 쓰지 않는다 (배포 서버 빌드 · 피칭 위키).
  // 고른 것이 **전부** standalone 이면 서버를 아예 띄우지 않는다 — 안 그러면 쓰지도 않을 vite 를
  // 기다리느라 수십 초를 버린다. 하나라도 브라우저를 쓰면 예전처럼 둘 다 띄운다.
  const needServers = picked.some((n) => !SMOKES[n].standalone);
  if (picked.length) {
    // 2. Servers — 고른 것이 전부 standalone 이면 건너뛴다.
    if (!needServers) console.log('  servers skipped (standalone scripts only)');
    else {
      const relayUrl = 'http://localhost:8787/health';
      const needFreshRelay = picked.some((n) => SMOKES[n].freshRelay) && !opts.keepRelay;
      if (needFreshRelay && pidsOnPort(8787).length) { console.log('  restarting relay (stale lobbies would hijack quick match)'); killPort(8787); await sleep(500); }
      if (!(await isUp(relayUrl))) {
        // C-41 (2026-09-11): 러너가 직접 띄우는 릴레이는 임시 프로필 저장소를 쓴다 — 스모크가 만든 수천 개의
        // 테스트 프로필이 개발용 server/data/profiles.json 에 쌓이지 않게. 이미 떠 있던 릴레이는 건드리지 않는다.
        started.relayData = mkdtempSync(resolve(os.tmpdir(), 'scav-verify-relay-'));
        // E-4 (2026-09-11): 스모크 · e2e 가 쓰는 dev 크레딧 사유(smoke:* · e2e:* · console · shot)를 받는 릴레이로 띄운다.
        started.relay = npmRun('server', 'relay', { SCAV_DATA_DIR: started.relayData, SCAV_DEV_ECONOMY: '1' });
        await waitUp(relayUrl, 'relay');
        console.log(`  relay started (8787, profiles in ${started.relayData})`);
      }
      else {
        console.log('  relay already up (8787)');
        // E-4 (2026-09-11): a relay someone started by hand (dev:all · npm run server) refuses the dev credit reasons
        // (`smoke:*` top-ups revert). `/health.devEconomy` is absent on a relay older than the credit validation.
        const h = await fetch(relayUrl, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null);
        if (h && h.devEconomy === false) console.log('  note: that relay runs WITHOUT SCAV_DEV_ECONOMY — smokes that top up credits with smoke:* reasons see them reverted (restart it with SCAV_DEV_ECONOMY=1, or drop --keep-relay)');
      }
      if (!(await isUp(opts.url))) { started.vite = npmRun('dev', 'vite'); await waitUp(opts.url, 'vite'); console.log(`  vite started (${opts.url})`); }
      else console.log(`  vite already up (${opts.url})`);
    }

    // 3. Smokes in a pool; exclusive jobs afterwards, one at a time.
    const pool = picked.filter((n) => !SMOKES[n].exclusive);
    const solo = picked.filter((n) => SMOKES[n].exclusive);
    const runSmoke = async (name) => {
      const s = summarize(name, await runCapture(process.execPath, [...(SMOKES[name].nodeArgs ?? []), SMOKES[name].file, opts.url], name));
      results.push(s); report(s);
    };
    let next = 0;
    const lane = async (i) => { await sleep(i * 8_000); while (next < pool.length) await runSmoke(pool[next++]); };
    await Promise.all(Array.from({ length: Math.min(opts.jobs, pool.length) }, (_, i) => lane(i)));
    for (const name of solo) await runSmoke(name);
  }
} catch (err) {
  console.error(`\nverify aborted: ${err.message}`);
  results.push({ name: 'runner', ok: false, score: 'aborted', seconds: 0, fails: [], log: `${LOG_REL}/` });
} finally {
  cleanup();
}

// 4. Summary + record.
const total = Math.round((Date.now() - tStart) / 1000);
const failed = results.filter((r) => !r.ok);
const line = results.map((r) => `${r.name} ${r.score}${r.consoleErrs ? ` (${r.consoleErrs} console errors)` : ''}`).join(', ');
console.log(`\n${failed.length ? `\x1b[31m${failed.length} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'} in ${Math.floor(total / 60)} min ${total % 60} s`);
console.log(`docs line: ${new Date().toISOString().slice(0, 10)}: ${line}`);
if (failed.length) console.log('re-run only the failures: node scripts/verify.mjs --rerun-failed');
writeFileSync(LAST_RUN, JSON.stringify({ time: new Date().toISOString(), totalSeconds: total, results }, null, 2));
process.exit(failed.length ? 1 : 0);
