/**
 * `data/*.csv` 를 번들에 넣고 표 단위로 꺼내 주는 레지스트리.
 *
 * Vite 의 `import.meta.glob(..., { query: '?raw', eager: true })` 로 **빌드 시점에** 전부 문자열로 인라인된다 —
 * 런타임 fetch 도, 배포본에 딸려 나가는 별도 파일도 없다. dev 에서는 csv 를 저장하면 그대로 HMR 이 돈다.
 *
 * `csv.ts` 와 마찬가지로 `@/shared` 를 import 하지 않는다 (constants.ts 가 이 모듈을 쓴다).
 */
import { CsvRow, addDataIssue, dataIssues, parseCsv, setNumberRefResolver } from './csv';

export { CsvRow, addDataIssue, dataIssues };
export type { CsvIssue, NumOpts } from './csv';

/* 프로젝트 루트의 data/ 폴더. 새 csv 를 넣으면 이름만으로 바로 잡힌다. */
/* `import.meta.glob` 은 Vite 전용이라 서버 tsconfig 에는 타입이 없다 — 여기서만 좁혀 쓴다. */
type GlobFn = (pattern: string, options: { query: string; import: string; eager: true }) => Record<string, string>;
const MODULES = (import.meta as unknown as { glob: GlobFn }).glob(
  '../../../data/*.csv', { query: '?raw', import: 'default', eager: true },
);

/** `weapons.csv` → 파일 내용. */
const TEXT = new Map<string, string>();
for (const [path, text] of Object.entries(MODULES)) {
  TEXT.set(path.slice(path.lastIndexOf('/') + 1), text);
}

/** 번들에 들어온 csv 파일 이름 전부 (정렬됨). `data:check` 가 고아 파일을 찾는 데 쓴다. */
export function csvFileNames(): string[] {
  return [...TEXT.keys()].sort();
}

const PARSED = new Map<string, readonly CsvRow[]>();
/** 어떤 파일에서 무엇을 읽었는지 — 아무도 안 읽은 파일/키를 `data:check` 가 잡아낸다. */
const TOUCHED = new Set<string>();

/**
 * 파일 하나의 데이터 줄 전부. 없는 파일이면 문제를 남기고 빈 배열.
 * 파싱은 파일당 한 번만 하고 캐시한다.
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

/** 한 번이라도 읽힌 csv 파일 이름. */
export function touchedFiles(): string[] {
  return [...TOUCHED].sort();
}

/**
 * `group` 열의 값으로 묶은 줄들. 한 파일에 성격이 다른 표를 여러 개 담을 때 쓴다
 * (`tables.csv` 의 `table` 열, `enemy_abilities.csv` 의 `block` 열).
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

/* ── key,value 형식 ────────────────────────────────────────────────────────── */

/**
 * `key,value,…` 로 된 파일의 조회기. 읽은 키를 기록해 두므로 `data:check` 가
 * **아무도 안 읽는 키**(= 오타 났거나 죽은 수치)를 찾아낼 수 있다.
 */
export class KeyTable {
  private readonly rows = new Map<string, CsvRow>();
  private readonly read = new Set<string>();

  readonly file: string;

  /* 서버 tsconfig 가 `erasableSyntaxOnly` 라 생성자 파라미터 프로퍼티를 쓸 수 없다. */
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

  /** 숫자 하나. 줄이 없으면 문제 + 0. */
  num(key: string, column = 'value'): number {
    return this.row(key)?.num(column) ?? 0;
  }

  /** 문자열 하나. */
  str(key: string, column = 'value'): string {
    return this.row(key)?.str(column) ?? '';
  }

  /** `true`/`false` 하나. */
  bool(key: string, column = 'value'): boolean {
    return this.row(key)?.bool(column) ?? false;
  }

  /** `|` 로 나뉜 목록. */
  list(key: string, column = 'value'): string[] {
    return this.row(key)?.list(column) ?? [];
  }

  /** 아직 아무도 읽지 않은 키 — 대개 오타이거나 지워진 수치의 잔재다. */
  unreadKeys(): string[] {
    return [...this.rows.keys()].filter((k) => !this.read.has(k)).sort();
  }
}

const KEY_TABLES = new Map<string, KeyTable>();

/** 파일당 하나만 만들어 재사용 (읽음 표시가 흩어지지 않게). */
export function keyTable(file: string, keyColumn = 'key'): KeyTable {
  const hit = KEY_TABLES.get(file);
  if (hit) return hit;
  const made = new KeyTable(file, keyColumn);
  KEY_TABLES.set(file, made);
  return made;
}

/** 만들어진 모든 KeyTable (checker 가 미사용 키를 훑는다). */
export function allKeyTables(): readonly KeyTable[] {
  return [...KEY_TABLES.values()];
}

/**
 * 어느 csv 든 `=FLAME_DPS` 처럼 `data/constants.csv` 의 상수를 참조할 수 있게 한다.
 * 상수를 공유하는 표가 값을 베껴 두지 않아도 되므로 원본은 계속 한 곳이다.
 */
setNumberRefResolver((name) => {
  const constants = keyTable('constants.csv');
  if (constants.has(name)) return constants.num(name);
  const tuning = keyTable('tuning.csv');
  if (tuning.has(name)) return tuning.num(name);
  /* `표이름.키` → tables.csv 의 그 칸 (`=ARMOR_DR_BY_TIER.3`). */
  const dot = name.indexOf('.');
  if (dot > 0) {
    const row = csvGroups('tables.csv', 'table').get(name.slice(0, dot))?.find((r) => r.raw('key') === name.slice(dot + 1));
    if (row) return row.num('value');
  }
  return undefined;
});

/* ── table,key,value 형식 (긴 형태 표) ─────────────────────────────────────── */

/**
 * `tables.csv` 처럼 `table,key,value` 로 여러 표를 담은 파일에서 표 하나를 꺼낸다.
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
 * 같은 형식이지만 `key` 가 0,1,2… 인덱스인 배열 표
 * (`ARMOR_DR_BY_TIER`, `STASH_ROWS_BY_STORAGE_LEVEL`). 빠진 인덱스는 문제로 잡는다.
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

/** 같은 형식의 문자열 배열 표 (`WEAPON_GRADE_ROMAN`, `QUICK_SLOT_DIRS` …). */
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

/** 같은 형식의 문자열 사전 표 (`SOCKET_LABEL_KO`, `WEIGHT_STATE_LABEL_KO` …). */
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
 * `facility_upgrades.csv` 처럼 "그룹 + 레벨 + 재료 목록" 으로 된 파일을
 * `[레벨1 비용, 레벨2 비용, …]` 의 배열로 묶는다.
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
