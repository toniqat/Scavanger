/**
 * CSV parser + cell accessors — the single source of the game's numbers is `data/*.csv` at the project root.
 *
 * This file **imports nothing** (`@/shared` included). `shared/constants.ts` uses this module, so importing anything
 * back becomes a cycle the moment it happens. The types are defined here directly.
 *
 * Conventions
 * - Lines starting with `#` and blank lines are ignored. The first valid line is the header.
 * - Comma separated, RFC4180 quoting (`"a,b"`, `""` = one double quote). CRLF/LF/BOM are all accepted.
 * - An empty cell = no value (`undefined`). A number cell may use underscores like `1_000`, and `0x8fe8ff` hex works too.
 * - A list cell is split on `|` (`AR|SMG|SG`).
 *
 * A bad cell **does not throw.** The problem is collected in `dataIssues()` and it keeps running on the default —
 * a game that will not start because of one typo makes tuning numbers harder, not easier. `npm run data:check` reads that list and fails.
 */

/** A problem found in one cell. `npm run data:check` prints it with the line number. */
export interface CsvIssue {
  /** The file name only, like `weapons.csv`. */
  file: string;
  /** 1-based line number in the source file. */
  line: number;
  column?: string;
  message: string;
}

const ISSUES: CsvIssue[] = [];

/** Every data problem collected so far (read-only). */
export function dataIssues(): readonly CsvIssue[] {
  return ISSUES;
}

/** The parser and the loaders register a problem here. The same problem is never stored twice. */
export function addDataIssue(issue: CsvIssue): void {
  const dup = ISSUES.some((i) => i.file === issue.file && i.line === issue.line && i.column === issue.column && i.message === issue.message);
  if (!dup) ISSUES.push(issue);
}

/* ── Parser ───────────────────────────────────────────────────────────────── */

/** Splits one line into cells (a comma inside quotes · the simple form, no line breaks). */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** One file as `{ header, rows }`. `rows[i].line` is the source line number. */
export interface ParsedCsv {
  file: string;
  header: readonly string[];
  rows: readonly CsvRow[];
}

export function parseCsv(file: string, text: string): ParsedCsv {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let header: string[] | null = null;
  const rows: CsvRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cells = splitLine(raw);
    if (!header) { header = cells; continue; }
    if (cells.every((c) => c === '')) continue;
    if (cells.length > header.length) {
      addDataIssue({ file, line: i + 1, message: `칸이 ${cells.length}개인데 헤더는 ${header.length}개다 — 쉼표가 든 값은 "따옴표"로 감싼다` });
    }
    const map: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) map[header[c]] = cells[c] ?? '';
    rows.push(new CsvRow(file, i + 1, map));
  }
  return { file, header: header ?? [], rows };
}

/* ── Cell accessors ───────────────────────────────────────────────────────── */

/* ── `=` expressions ─────────────────────────────────────────────────────────
 * A cell that starts with `=` is read as an expression: `=FLAME_DPS`, `=FLAME_CONE_DEG/2`, `=1/SHOCK_CHARGE_TIME`.
 * Names are looked up in `data/constants.csv` — a table that shares a constant (a unique weapon and so on) need not copy
 * the value, and fixing one line of constants.csv moves every table that references that constant with it.
 * A name is a key of `constants.csv` · `tuning.csv`, or `<table>.<key>` (`=ARMOR_DR_BY_TIER.3`) for a cell of `tables.csv`.
 * All that may be used is names · numbers · `+ - * / ( )` (there is no eval). */

let refResolver: ((name: string) => number | undefined) | null = null;

/** `tables.csv` plugs the constants.csv lookup in (injection, to avoid a circular import). */
export function setNumberRefResolver(fn: (name: string) => number | undefined): void {
  refResolver = fn;
}

/** Evaluates one expression. When a name is not found or the syntax is wrong it calls `onError` and returns NaN. */
function evalExpr(src: string, onError: (message: string) => void): number {
  let i = 0;
  const ws = (): void => { while (i < src.length && src[i] === ' ') i++; };
  let failed = false;
  const fail = (m: string): number => { if (!failed) { failed = true; onError(m); } return NaN; };

  const primary = (): number => {
    ws();
    if (src[i] === '(') {
      i++;
      const v = expr();
      ws();
      if (src[i] !== ')') return fail(`'${src}' 의 괄호가 안 닫혔다`);
      i++;
      return v;
    }
    if (src[i] === '-') { i++; return -primary(); }
    if (src[i] === '+') { i++; return primary(); }
    const idStart = i;
    while (i < src.length && /[A-Za-z_]/.test(src[i])) i++;
    if (i > idStart) {
      while (i < src.length && /[A-Za-z0-9_.]/.test(src[i])) i++;
      const name = src.slice(idStart, i);
      const v = refResolver?.(name);
      if (v === undefined) return fail(`'${name}' 을 찾을 수 없다 — data/constants.csv · data/tuning.csv 의 키이거나 '표이름.키' 여야 한다`);
      return v;
    }
    const numStart = i;
    while (i < src.length && /[0-9._eE]/.test(src[i])) i++;
    if (i === numStart) return fail(`'${src}' 를 계산할 수 없다`);
    const n = Number(src.slice(numStart, i).replace(/_/g, ''));
    if (Number.isNaN(n)) return fail(`'${src.slice(numStart, i)}' 는 숫자가 아니다`);
    return n;
  };
  const term = (): number => {
    let v = primary();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '*' && op !== '/') return v;
      i++;
      const r = primary();
      v = op === '*' ? v * r : v / r;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
  };
  const value = expr();
  ws();
  if (!failed && i < src.length) return fail(`'${src}' 의 '${src.slice(i)}' 를 계산할 수 없다`);
  return value;
}

/** Number string → number. `1_000`, `0x8fe8ff`, `-0.5`, `1e3`, `=CONST*2` are accepted. NaN on failure. */
function toNumber(raw: string, onError: (message: string) => void = () => {}): number {
  if (!raw) return NaN;
  /* An underscore inside a `=` expression is part of a constant's name — digit-group underscores are stripped from plain numbers only. */
  if (raw.startsWith('=')) return evalExpr(raw.slice(1), onError);
  const s = raw.replace(/_/g, '');
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) return Number(s);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

export interface NumOpts {
  /** Below this it is flagged as a problem (the value is still used — so a deliberate experiment is not blocked). */
  min?: number;
  max?: number;
  /** The value to use when the cell is empty. Without it the column counts as required and is flagged. */
  fallback?: number;
}

/** One CSV line. Values come out by column name; a bad value piles up in `dataIssues()` and the default is returned. */
export class CsvRow {
  /** The file name only, like `weapons.csv`. */
  readonly file: string;
  /** 1-based line number in the source file (error messages print it). */
  readonly line: number;
  private readonly cells: Readonly<Record<string, string>>;

  /* The server tsconfig is `erasableSyntaxOnly`, so constructor parameter properties cannot be used — the fields are written out. */
  constructor(file: string, line: number, cells: Readonly<Record<string, string>>) {
    this.file = file;
    this.line = line;
    this.cells = cells;
  }

  private issue(column: string, message: string): void {
    addDataIssue({ file: this.file, line: this.line, column, message });
  }

  /** A column that is not there at all is flagged (finding a misspelt header). */
  private cell(column: string): string {
    const v = this.cells[column];
    if (v === undefined) {
      this.issue(column, `열 '${column}' 이 없다`);
      return '';
    }
    return v;
  }

  /** Does this line have that column, and is it non-empty. */
  has(column: string): boolean {
    return !!this.cells[column];
  }

  /** The raw string as it is ('' when missing). */
  raw(column: string): string {
    return this.cells[column] ?? '';
  }

  /** A required string. Empty = a problem + `''`. */
  str(column: string): string {
    const v = this.cell(column);
    if (!v) this.issue(column, '값이 비었다');
    return v;
  }

  /** The string when present, undefined when not. */
  optStr(column: string): string | undefined {
    const v = this.cells[column] ?? '';
    return v === '' ? undefined : v;
  }

  /** A required number (pass `opts.fallback` to allow an empty cell). */
  num(column: string, opts: NumOpts = {}): number {
    const v = this.cell(column);
    if (v === '') {
      if (opts.fallback !== undefined) return opts.fallback;
      this.issue(column, '숫자가 필요한데 비었다');
      return 0;
    }
    const n = toNumber(v, (message) => this.issue(column, message));
    if (Number.isNaN(n)) {
      this.issue(column, `'${v}' 는 숫자가 아니다`);
      return opts.fallback ?? 0;
    }
    if (opts.min !== undefined && n < opts.min) this.issue(column, `${n} 은 최소값 ${opts.min} 보다 작다`);
    if (opts.max !== undefined && n > opts.max) this.issue(column, `${n} 은 최대값 ${opts.max} 보다 크다`);
    return n;
  }

  /** The number when present, undefined when not (for optional fields — like `WeaponDef.adsZoom`). */
  optNum(column: string, opts: Omit<NumOpts, 'fallback'> = {}): number | undefined {
    if (!this.has(column)) return undefined;
    return this.num(column, opts);
  }

  /** An integer. A fractional value is flagged and returned rounded. */
  int(column: string, opts: NumOpts = {}): number {
    const n = this.num(column, opts);
    if (!Number.isInteger(n)) {
      this.issue(column, `${n} 은 정수가 아니다`);
      return Math.round(n);
    }
    return n;
  }

  /** `true` / `false` (an empty cell = `fallback`, false by default). */
  bool(column: string, fallback = false): boolean {
    const v = this.cell(column).toLowerCase();
    if (v === '') return fallback;
    if (v === 'true' || v === '1' || v === 'y' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'n' || v === 'no') return false;
    this.issue(column, `'${v}' 는 true/false 가 아니다`);
    return fallback;
  }

  /** One of a fixed set of values. Anything outside it is a problem + the first value. */
  enum<T extends string>(column: string, allowed: readonly T[], fallback?: T): T {
    const v = this.cell(column);
    if (!v && fallback !== undefined) return fallback;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    this.issue(column, `'${v}' 는 ${allowed.join(' | ')} 중 하나여야 한다`);
    return fallback ?? allowed[0];
  }

  /** An optional enum value (an empty cell = undefined). */
  optEnum<T extends string>(column: string, allowed: readonly T[]): T | undefined {
    if (!this.has(column)) return undefined;
    return this.enum(column, allowed);
  }

  /** A `|`-separated list of strings (an empty cell = an empty array). */
  list(column: string): string[] {
    const v = this.cells[column] ?? '';
    if (!v) return [];
    return v.split('|').map((s) => s.trim()).filter(Boolean);
  }

  /** A `|`-separated list of enum values — any one outside the set is a problem. */
  enumList<T extends string>(column: string, allowed: readonly T[]): T[] {
    const out: T[] = [];
    for (const v of this.list(column)) {
      if ((allowed as readonly string[]).includes(v)) out.push(v as T);
      else this.issue(column, `'${v}' 는 ${allowed.join(' | ')} 중 하나여야 한다`);
    }
    return out;
  }

  /**
   * `mat_scrap:4|mat_cable:2` → `[{ defId: 'mat_scrap', qty: 4 }, …]`.
   * Used for a cell that repeats "id:qty" pairs, like a material list or a reward list.
   */
  costList(column: string): { defId: string; qty: number }[] {
    const out: { defId: string; qty: number }[] = [];
    for (const part of this.list(column)) {
      const at = part.lastIndexOf(':');
      if (at <= 0) { this.issue(column, `'${part}' 는 'id:수량' 꼴이어야 한다`); continue; }
      const defId = part.slice(0, at).trim();
      const qty = toNumber(part.slice(at + 1).trim(), (message) => this.issue(column, message));
      if (Number.isNaN(qty)) { this.issue(column, `'${part}' 의 수량이 숫자가 아니다`); continue; }
      out.push({ defId, qty });
    }
    return out;
  }

  /** Registers a problem against this line directly (when a loader cross-checks). */
  report(column: string, message: string): void {
    this.issue(column, message);
  }
}
