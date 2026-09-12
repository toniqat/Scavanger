#!/usr/bin/env node
/**
 * data/*.csv 스키마 검사 — `npm run data:check`.
 *
 * Vite 를 헤드리스로 띄워 **게임이 실제로 쓰는 로더 그대로** csv 를 읽고, 로더가 모아 둔 문제 목록
 * (`dataIssues()`)을 줄 번호와 함께 출력한다. 검사 규칙을 따로 적어 두지 않으므로 로더와 검사기가
 * 어긋날 일이 없다 — 열 이름 · 필수 여부 · 허용값 · 범위는 전부 로더가 선언한 그대로다.
 *
 * 잡아내는 것
 *  - 없는 열 / 빈 필수 칸 / 숫자가 아닌 칸 / 범위를 벗어난 값 / 목록에 없는 열거값
 *  - 쉼표가 든 값을 따옴표로 안 감싼 줄 (칸 수가 헤더보다 많음)
 *  - `=상수` 식이 가리키는 이름이 없을 때
 *  - 아무도 읽지 않는 csv 파일 (고아 파일)
 *  - constants.csv / tuning.csv 에서 아무도 읽지 않는 키 (오타이거나 죽은 수치)
 *  - (2026-09-11) 커밋된 `server/economy.gen.json`(릴레이의 크레딧 검증 표)이 지금 csv 와 다를 때 —
 *    `npm run data:check -- --write` 로 다시 만든다 (`scripts/economy-table.mjs`)
 *
 * 브라우저에서는 같은 문제가 있어도 게임이 뜬다 (기본값으로 굴러간다). 그래서 이 스크립트가 있다.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
// 2026-09-11: 로더 목록은 verify 의 csv → 폴더 매핑과 같은 파일(`data-owners.mjs`)에 산다 — 한쪽만 고치지 않게.
import { CSV_FOLDERS, CSV_WIDE, DATA_OWNERS } from './data-owners.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root: ROOT,
  configFile: `${ROOT}/vite.config.ts`,
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

let loadFailed = false;
for (const mod of DATA_OWNERS) {
  try {
    await server.ssrLoadModule(mod);
  } catch (e) {
    loadFailed = true;
    console.error(`\n[data:check] ${mod} 을 읽지 못했다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
  }
}

const tables = await server.ssrLoadModule('/src/shared/data/tables.ts');

/* 계약 → 아이템 참조 (2026-09-12, E2): `contracts.csv` 의 `itemDefId`(특정 아이템 회수)가 실제 아이템인가. 로더(`shared/meta.ts`)는
 * items/ 를 모르므로 빈 칸 · 쓰이지 않는 칸만 잡고, 이름이 맞는지는 여기서 아이템 표와 맞춰 본다. */
const refProblems = [];
try {
  const shared = await server.ssrLoadModule('/src/shared/index.ts');
  const items = await server.ssrLoadModule('/src/items/ItemDefs.ts');
  for (const c of shared.CONTRACT_DEFS) {
    if (c.itemDefId && !items.ITEM_DEF_MAP.has(c.itemDefId)) refProblems.push(`data/contracts.csv [itemDefId] — ${c.id}: 모르는 아이템 '${c.itemDefId}'`);
  }
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 계약 아이템 참조를 못 봤다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

/* 제작 ↔ 분해 ↔ 수리 경제 검산 (2026-09-10): 「제작 → (수리) → 분해 → 제작」 이 이득이 되면 안 된다.
 * 스키마가 아니라 **수치의 뜻**을 보는 검사라 로더가 아니라 items/Salvage.ts 가 직접 계산한다. */
let economy = [];
try {
  const salvage = await server.ssrLoadModule('/src/items/Salvage.ts');
  economy = salvage.checkSalvageEconomy();
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 분해 경제 검산을 못 돌렸다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

/* 서버 크레딧 검증 표 (2026-09-11, E-4): 릴레이가 `credits:tx` 금액을 검사하는 `server/economy.gen.json` 이 지금 csv 로
 * 만든 것과 같은지 + 표의 가격 식이 게임과 모든 아이템 · 레벨 · 수량에서 같은지. `--write` 면 다시 쓴다. */
const WRITE = process.argv.includes('--write');
let econTable = { problems: [], stale: false, wrote: false, missing: false };
try {
  const { runEconomyTable } = await import('./economy-table.mjs');
  econTable = await runEconomyTable(server, { write: WRITE });
} catch (e) {
  loadFailed = true;
  console.error(`\n[data:check] 서버 경제 표를 못 만들었다:\n  ${String(e?.message ?? e).split('\n')[0]}`);
}

await server.close();

const issues = tables.dataIssues();
const files = tables.csvFileNames();
const touched = new Set(tables.touchedFiles());
const orphans = files.filter((f) => !touched.has(f));
const unread = tables.allKeyTables().flatMap((t) => t.unreadKeys().map((k) => `${t.file}: ${k}`));

const rows = issues.length + orphans.length + unread.length + economy.length + econTable.problems.length + (econTable.stale ? 1 : 0)
  + refProblems.length;

if (refProblems.length) {
  console.error(`\n모르는 아이템을 가리키는 칸 ${refProblems.length}건`);
  for (const p of refProblems) console.error(`  ${p}`);
}

if (issues.length) {
  console.error(`\n잘못된 칸 ${issues.length}건`);
  for (const i of issues) {
    const where = i.line ? `data/${i.file}:${i.line}` : `data/${i.file}`;
    console.error(`  ${where}${i.column ? ` [${i.column}]` : ''} — ${i.message}`);
  }
}
if (orphans.length) {
  console.error(`\n아무도 읽지 않는 csv ${orphans.length}건 (읽는 코드가 없거나 이름이 틀렸다)`);
  for (const f of orphans) console.error(`  data/${f}`);
}
if (unread.length) {
  console.error(`\n아무도 읽지 않는 키 ${unread.length}건 (오타이거나 지워진 수치의 잔재다)`);
  for (const k of unread) console.error(`  data/${k}`);
}

if (economy.length) {
  console.error(`\n제작 → 분해 무한 이득 ${economy.length}건 (수리 재료 + 분해 산출 ≤ 제작 재료 여야 한다)`);
  for (const v of economy) console.error(`  ${v.defId}${v.bucket >= 0 ? ` [내구도 구간 ${v.bucket}]` : ''} — ${v.message}`);
}

if (econTable.problems.length) {
  console.error(`\n서버 경제 표가 게임 가격과 어긋남 ${econTable.problems.length}건 (server/Economy.ts 가 정상 거래를 거절하게 된다)`);
  for (const p of econTable.problems) console.error(`  ${p}`);
}
if (econTable.stale) {
  console.error(`\nserver/economy.gen.json 이 ${econTable.missing ? '없다' : '지금 csv 로 만든 표와 다르다'} — 릴레이가 옛 가격으로 크레딧을 검사한다.`);
  console.error('  고치기: npm run data:check -- --write   (그리고 server/economy.gen.json 을 커밋한다)');
}
if (econTable.wrote) console.log(`server/economy.gen.json 을 다시 썼다 (hash ${econTable.table.hash}) — 커밋한다`);

/* 2026-09-11: verify 가 csv 변경에서 스모크를 고르는 표에 없는 파일 — 실패는 아니고 알림이다 (`data-owners.mjs`). */
const unmapped = files.filter((f) => !CSV_WIDE.has(f) && !CSV_FOLDERS[f]);
if (unmapped.length) console.warn(`\n참고: scripts/data-owners.mjs 의 CSV_FOLDERS 에 없는 csv ${unmapped.length}건 (verify 가 이 파일 변경에 스모크를 못 고른다): ${unmapped.join(', ')}`);

if (loadFailed || rows) {
  console.error(`\ndata:check 실패 — ${rows}건`);
  process.exit(1);
}
console.log(`data:check ok — csv ${files.length}개, 문제 없음`);
