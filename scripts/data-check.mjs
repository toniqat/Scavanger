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
 *
 * 브라우저에서는 같은 문제가 있어도 게임이 뜬다 (기본값으로 굴러간다). 그래서 이 스크립트가 있다.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** csv 를 읽는 모듈 전부. 하나라도 빠지면 그 파일이 "고아" 로 잘못 잡히므로 같이 늘린다. */
const DATA_OWNERS = [
  '/src/shared/index.ts',        // constants · tables · meta · housing · planetDefs
  '/src/items/ItemDefs.ts',      // items · ammo · attachments · bags · seeds · books · armor · implants
  '/src/items/WeaponStats.ts',   // tuning (반동 · 조준 계수)
  '/src/items/LootTables.ts',    // loot_*
  '/src/items/Recipes.ts',       // recipes
  '/src/enemies/EnemyTypes.ts',  // enemies · enemy_abilities
  '/src/progression/defs.ts',    // stats · skills
  '/src/meta/Rules.ts',          // tuning (임플란트 수리 수수료)
  '/src/world/structures/model.ts', // structures (버려진 구조물 · 선로 플랫폼 · 전차)
  '/src/world/hazard/model.ts',  // hazards (환경 재해의 색 · 입자 · 벽)
];

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
await server.close();

const issues = tables.dataIssues();
const files = tables.csvFileNames();
const touched = new Set(tables.touchedFiles());
const orphans = files.filter((f) => !touched.has(f));
const unread = tables.allKeyTables().flatMap((t) => t.unreadKeys().map((k) => `${t.file}: ${k}`));

const rows = issues.length + orphans.length + unread.length;

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

if (loadFailed || rows) {
  console.error(`\ndata:check 실패 — ${rows}건`);
  process.exit(1);
}
console.log(`data:check ok — csv ${files.length}개, 문제 없음`);
