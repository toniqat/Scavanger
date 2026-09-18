/**
 * The registry that puts `data/*.csv` into the bundle and hands it out table by table.
 *
 * Vite's `import.meta.glob(..., { query: '?raw', eager: true })` inlines all of it as strings **at build time** — there
 * is no runtime fetch and no separate file shipping with the build. In dev, saving a csv runs HMR as it is.
 *
 * Like `csv.ts` it imports no `@/shared` (constants.ts uses this module).
 */
import { CsvRow, addDataIssue, dataIssues, parseCsv, setNumberRefResolver } from './csv';

export { CsvRow, addDataIssue, dataIssues };
export type { CsvIssue, NumOpts } from './csv';

/* The data/ folder at the project root. Drop a new csv in and it is picked up by name alone. */
/* `import.meta.glob` is Vite-only, so the server tsconfig has no type for it — it is narrowed here alone. */
type GlobFn = (pattern: string, options: { query: string; import: string; eager: true }) => Record<string, string>;
const MODULES = (import.meta as unknown as { glob: GlobFn }).glob(
  '../../../data/*.csv', { query: '?raw', import: 'default', eager: true },
);

/** `weapons.csv` → the file's contents. */
const TEXT = new Map<string, string>();
for (const [path, text] of Object.entries(MODULES)) {
  TEXT.set(path.slice(path.lastIndexOf('/') + 1), text);
}

/** Every csv file name that made it into the bundle (sorted). `data:check` uses it to find orphan files. */
export function csvFileNames(): string[] {
  return [...TEXT.keys()].sort();
}

const PARSED = new Map<string, readonly CsvRow[]>();
/** What was read out of which file — `data:check` catches a file or a key nobody read. */
const TOUCHED = new Set<string>();

/**
 * Every data line of one file. A missing file leaves a problem and returns an empty array.
 * Parsing happens exactly once per file and is cached.
 */
export function csvRows(file: string): readonly CsvRow[] {
  TOUCHED.add(file);
  const hit = PARSED.get(file);
  if (hit) return hit;
  const text = TEXT.get(file);
  if (text === undefined) {
    addDataIssue({ file, line: 0, message: `data/${file} 이 없다` });
    PARSED.set(file, []);
    return [];
  }
  const rows = parseCsv(file, text).rows;
  PARSED.set(file, rows);
  return rows;
}

/** Names of the csv files that were read at least once. */
export function touchedFiles(): string[] {
  return [...TOUCHED].sort();
}

/**
 * The lines grouped by the value of the `group` column. Used when one file holds several tables of different kinds
 * (the `table` column of `tables.csv`, the `block` column of `enemy_abilities.csv`).
 */
export function csvGroups(file: string, groupColumn: string): Map<string, CsvRow[]> {
  const out = new Map<string, CsvRow[]>();
  for (const row of csvRows(file)) {
    const key = row.raw(groupColumn);
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/* ── the key,value form ───────────────────────────────────────────────────── */

/**
 * The lookup for a `key,value,…` file. It records the keys that were read, so `data:check` can find
 * **a key nobody reads** (= a typo, or a dead number).
 */
export class KeyTable {
  private readonly rows = new Map<string, CsvRow>();
  private readonly read = new Set<string>();

  readonly file: string;

  /* The server tsconfig is `erasableSyntaxOnly`, so constructor parameter properties cannot be used. */
  constructor(file: string, keyColumn = 'key') {
    this.file = file;
    for (const row of csvRows(file)) {
      const key = row.raw(keyColumn);
      if (!key) { row.report(keyColumn, '키가 비었다'); continue; }
      if (this.rows.has(key)) { row.report(keyColumn, `'${key}' 가 중복이다`); continue; }
      this.rows.set(key, row);
    }
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  private row(key: string): CsvRow | undefined {
    this.read.add(key);
    const row = this.rows.get(key);
    if (!row) addDataIssue({ file: this.file, line: 0, column: key, message: `'${key}' 줄이 없다` });
    return row;
  }

  /** One number. A missing line is a problem + 0. */
  num(key: string, column = 'value'): number {
    return this.row(key)?.num(column) ?? 0;
  }

  /** One string. */
  str(key: string, column = 'value'): string {
    return this.row(key)?.str(column) ?? '';
  }

  /** One `true`/`false`. */
  bool(key: string, column = 'value'): boolean {
    return this.row(key)?.bool(column) ?? false;
  }

  /** A `|`-separated list. */
  list(key: string, column = 'value'): string[] {
    return this.row(key)?.list(column) ?? [];
  }

  /** Keys nobody has read yet — usually a typo, or what a deleted number left behind. */
  unreadKeys(): string[] {
    return [...this.rows.keys()].filter((k) => !this.read.has(k)).sort();
  }
}

const KEY_TABLES = new Map<string, KeyTable>();

/** Exactly one per file, reused (so the read marks do not scatter). */
export function keyTable(file: string, keyColumn = 'key'): KeyTable {
  const hit = KEY_TABLES.get(file);
  if (hit) return hit;
  const made = new KeyTable(file, keyColumn);
  KEY_TABLES.set(file, made);
  return made;
}

/** Every KeyTable that was built (the checker sweeps them for unused keys). */
export function allKeyTables(): readonly KeyTable[] {
  return [...KEY_TABLES.values()];
}

/**
 * Lets any csv reference a constant of `data/constants.csv`, like `=FLAME_DPS`.
 * A table that shares a constant need not copy the value, so the source stays in one place.
 */
setNumberRefResolver((name) => {
  const constants = keyTable('constants.csv');
  if (constants.has(name)) return constants.num(name);
  const tuning = keyTable('tuning.csv');
  if (tuning.has(name)) return tuning.num(name);
  /* `<table>.<key>` → that cell of tables.csv (`=ARMOR_DR_BY_TIER.3`). */
  const dot = name.indexOf('.');
  if (dot > 0) {
    const row = csvGroups('tables.csv', 'table').get(name.slice(0, dot))?.find((r) => r.raw('key') === name.slice(dot + 1));
    if (row) return row.num('value');
  }
  return undefined;
});

/* ── the table,key,value form (long-form tables) ──────────────────────────── */

/**
 * Pulls one table out of a file that holds several as `table,key,value`, like `tables.csv`.
 * `AMMO_STACK_ROUNDS` → `{ light: 80, medium: 50, … }`.
 */
export function numberMap<K extends string>(file: string, table: string, groupColumn = 'table'): Record<K, number> {
  const out = {} as Record<K, number>;
  const group = csvGroups(file, groupColumn).get(table);
  if (!group || group.length === 0) {
    addDataIssue({ file, line: 0, column: table, message: `표 '${table}' 이 비었거나 없다` });
    return out;
  }
  for (const row of group) {
    const key = row.str('key');
    if (!key) continue;
    if (key in out) { row.report('key', `'${table}.${key}' 가 중복이다`); continue; }
    out[key as K] = row.num('value');
  }
  return out;
}

/**
 * The same form, but an array table whose `key` is the index 0,1,2…
 * (`ARMOR_DR_BY_TIER`, `STASH_ROWS_BY_STORAGE_LEVEL`). A missing index is flagged.
 */
export function numberList(file: string, table: string, groupColumn = 'table'): number[] {
  const map = numberMap(file, table, groupColumn);
  const keys = Object.keys(map);
  const out: number[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (!(String(i) in map)) {
      addDataIssue({ file, line: 0, column: table, message: `배열 표 '${table}' 에 인덱스 ${i} 이 없다 (key 는 0..${keys.length - 1})` });
      out.push(0);
    } else out.push(map[String(i)]);
  }
  return out;
}

/** A string array table of the same form (`WEAPON_GRADE_ROMAN`, `QUICK_SLOT_DIRS` …). */
export function stringList(file: string, table: string, groupColumn = 'table'): string[] {
  const group = csvGroups(file, groupColumn).get(table);
  if (!group) {
    addDataIssue({ file, line: 0, column: table, message: `표 '${table}' 이 없다` });
    return [];
  }
  const byIndex = new Map<number, string>();
  for (const row of group) {
    const idx = row.int('key', { min: 0 });
    if (byIndex.has(idx)) row.report('key', `'${table}' 의 인덱스 ${idx} 이 중복이다`);
    byIndex.set(idx, row.raw('value'));
  }
  const out: string[] = [];
  for (let i = 0; i < byIndex.size; i++) {
    const v = byIndex.get(i);
    if (v === undefined) {
      addDataIssue({ file, line: 0, column: table, message: `배열 표 '${table}' 에 인덱스 ${i} 이 없다` });
      out.push('');
    } else out.push(v);
  }
  return out;
}

/** A string dictionary table of the same form (`SOCKET_LABEL_KO`, `WEIGHT_STATE_LABEL_KO` …). */
export function stringMap<K extends string>(file: string, table: string, groupColumn = 'table'): Record<K, string> {
  const out = {} as Record<K, string>;
  const group = csvGroups(file, groupColumn).get(table);
  if (!group || group.length === 0) {
    addDataIssue({ file, line: 0, column: table, message: `표 '${table}' 이 비었거나 없다` });
    return out;
  }
  for (const row of group) {
    const key = row.str('key');
    if (!key) continue;
    out[key as K] = row.raw('value');
  }
  return out;
}

/**
 * Folds a file shaped as "group + level + material list", like `facility_upgrades.csv`,
 * into the array `[level 1 cost, level 2 cost, …]`.
 */
export function costLevels(file: string, groupColumn: string, group: string): { defId: string; qty: number }[][] {
  const rows = csvGroups(file, groupColumn).get(group);
  if (!rows) {
    addDataIssue({ file, line: 0, column: group, message: `'${group}' 줄이 하나도 없다` });
    return [];
  }
  const byLevel = new Map<number, { defId: string; qty: number }[]>();
  for (const row of rows) {
    const level = row.int('level', { min: 1 });
    if (byLevel.has(level)) row.report('level', `'${group}' 의 레벨 ${level} 이 중복이다`);
    byLevel.set(level, row.costList('cost'));
  }
  const out: { defId: string; qty: number }[][] = [];
  for (let level = 1; level <= byLevel.size; level++) {
    const cost = byLevel.get(level);
    if (!cost) {
      addDataIssue({ file, line: 0, column: group, message: `'${group}' 에 레벨 ${level} 이 없다` });
      out.push([]);
    } else out.push(cost);
  }
  return out;
}
