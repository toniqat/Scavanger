/**
 * CSV 파서 + 셀 접근자 — 게임 수치의 단일 원본은 프로젝트 루트의 `data/*.csv` 다.
 *
 * 이 파일은 **아무것도 import 하지 않는다** (`@/shared` 포함). `shared/constants.ts` 가 이 모듈을 쓰기 때문에
 * 무엇이든 되돌려 import 하는 순간 순환이 된다. 타입은 여기서 직접 정의한다.
 *
 * 규약
 * - `#` 로 시작하는 줄과 빈 줄은 무시. 첫 유효 줄이 헤더.
 * - 쉼표 구분, RFC4180 따옴표 (`"a,b"`, `""` = 큰따옴표 한 개). CRLF/LF/BOM 모두 허용.
 * - 빈 셀 = 값 없음(`undefined`). 숫자 셀은 `1_000` 처럼 밑줄을 써도 되고 `0x8fe8ff` 16진수도 된다.
 * - 목록 셀은 `|` 로 나눈다 (`AR|SMG|SG`).
 *
 * 잘못된 셀은 **던지지 않는다.** 문제를 `dataIssues()` 에 모아 두고 기본값으로 계속 굴린다 —
 * 오타 하나로 게임이 안 켜지면 수치 조정이 오히려 어려워진다. `npm run data:check` 가 그 목록을 보고 실패한다.
 */

/** 한 셀에서 발견된 문제. `npm run data:check` 가 이것을 줄 번호와 함께 출력한다. */
export interface CsvIssue {
  /** `weapons.csv` 처럼 파일 이름만. */
  file: string;
  /** 원본 파일 기준 1-based 줄 번호. */
  line: number;
  column?: string;
  message: string;
}

const ISSUES: CsvIssue[] = [];

/** 지금까지 모인 데이터 문제 전부 (읽기 전용). */
export function dataIssues(): readonly CsvIssue[] {
  return ISSUES;
}

/** 파서/로더가 문제를 등록한다. 같은 문제를 두 번 담지 않는다. */
export function addDataIssue(issue: CsvIssue): void {
  const dup = ISSUES.some((i) => i.file === issue.file && i.line === issue.line && i.column === issue.column && i.message === issue.message);
  if (!dup) ISSUES.push(issue);
}

/* ── 파서 ─────────────────────────────────────────────────────────────────── */

/** 한 줄을 셀로 나눈다 (따옴표 안의 쉼표 · 줄바꿈 없는 단순 형태). */
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

/** 파일 하나를 `{ header, rows }` 로. `rows[i].line` 은 원본 줄 번호다. */
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

/* ── 셀 접근자 ─────────────────────────────────────────────────────────────── */

/* ── `=` 식 ──────────────────────────────────────────────────────────────────
 * 셀이 `=` 로 시작하면 식으로 읽는다: `=FLAME_DPS`, `=FLAME_CONE_DEG/2`, `=1/SHOCK_CHARGE_TIME`.
 * 이름은 `data/constants.csv` 에서 찾는다 — 상수를 공유하는 표(유니크 무기 등)가 값을 베껴 두지 않아도 되고,
 * constants.csv 한 줄만 고치면 그 상수를 참조하는 모든 표가 같이 움직인다.
 * 이름은 `constants.csv` · `tuning.csv` 의 키, 또는 `표이름.키` (`=ARMOR_DR_BY_TIER.3`) 로 `tables.csv` 의 칸이다.
 * 쓸 수 있는 것은 이름 · 숫자 · `+ - * / ( )` 뿐이다 (eval 없음). */

let refResolver: ((name: string) => number | undefined) | null = null;

/** `tables.csv` 가 constants.csv 조회기를 꽂아 준다 (순환 import 를 피하려고 주입 방식). */
export function setNumberRefResolver(fn: (name: string) => number | undefined): void {
  refResolver = fn;
}

/** 식 하나를 계산한다. 이름을 못 찾거나 문법이 틀리면 `onError` 를 부르고 NaN. */
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

/** 숫자 문자열 → number. `1_000`, `0x8fe8ff`, `-0.5`, `1e3`, `=CONST*2` 허용. 실패하면 NaN. */
function toNumber(raw: string, onError: (message: string) => void = () => {}): number {
  if (!raw) return NaN;
  /* `=` 식 안의 밑줄은 상수 이름의 일부다 — 자릿수 구분 밑줄 제거는 순수 숫자에만 적용한다. */
  if (raw.startsWith('=')) return evalExpr(raw.slice(1), onError);
  const s = raw.replace(/_/g, '');
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(s)) return Number(s);
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  return Number(s);
}

export interface NumOpts {
  /** 이 값보다 작으면 문제로 잡는다(값은 그대로 쓴다 — 의도적 실험을 막지 않기 위해). */
  min?: number;
  max?: number;
  /** 셀이 비었을 때 쓸 값. 없으면 "필수" 로 보고 문제로 잡는다. */
  fallback?: number;
}

/** CSV 한 줄. 열 이름으로 값을 꺼내며, 잘못된 값은 `dataIssues()` 에 쌓고 기본값을 돌려준다. */
export class CsvRow {
  /** `weapons.csv` 처럼 파일 이름만. */
  readonly file: string;
  /** 원본 파일 기준 1-based 줄 번호 (오류 메시지가 이걸 찍는다). */
  readonly line: number;
  private readonly cells: Readonly<Record<string, string>>;

  /* 서버 tsconfig 가 `erasableSyntaxOnly` 라 생성자 파라미터 프로퍼티를 쓸 수 없다 — 필드를 직접 적는다. */
  constructor(file: string, line: number, cells: Readonly<Record<string, string>>) {
    this.file = file;
    this.line = line;
    this.cells = cells;
  }

  private issue(column: string, message: string): void {
    addDataIssue({ file: this.file, line: this.line, column, message });
  }

  /** 열이 아예 없으면 문제로 잡는다(오타 난 헤더 찾기). */
  private cell(column: string): string {
    const v = this.cells[column];
    if (v === undefined) {
      this.issue(column, `열 '${column}' 이 없다`);
      return '';
    }
    return v;
  }

  /** 이 줄이 그 열을 가지고 있고 비어 있지 않은가. */
  has(column: string): boolean {
    return !!this.cells[column];
  }

  /** 원본 문자열 그대로 (없으면 ''). */
  raw(column: string): string {
    return this.cells[column] ?? '';
  }

  /** 필수 문자열. 비어 있으면 문제 + `''`. */
  str(column: string): string {
    const v = this.cell(column);
    if (!v) this.issue(column, '값이 비었다');
    return v;
  }

  /** 있으면 문자열, 없으면 undefined. */
  optStr(column: string): string | undefined {
    const v = this.cells[column] ?? '';
    return v === '' ? undefined : v;
  }

  /** 필수 숫자 (`opts.fallback` 을 주면 빈 칸을 허용). */
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

  /** 있으면 숫자, 없으면 undefined (선택 필드용 — `WeaponDef.adsZoom` 처럼). */
  optNum(column: string, opts: Omit<NumOpts, 'fallback'> = {}): number | undefined {
    if (!this.has(column)) return undefined;
    return this.num(column, opts);
  }

  /** 정수. 소수점이 있으면 문제로 잡고 반올림해서 돌려준다. */
  int(column: string, opts: NumOpts = {}): number {
    const n = this.num(column, opts);
    if (!Number.isInteger(n)) {
      this.issue(column, `${n} 은 정수가 아니다`);
      return Math.round(n);
    }
    return n;
  }

  /** `true` / `false` (빈 칸 = `fallback`, 기본 false). */
  bool(column: string, fallback = false): boolean {
    const v = this.cell(column).toLowerCase();
    if (v === '') return fallback;
    if (v === 'true' || v === '1' || v === 'y' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'n' || v === 'no') return false;
    this.issue(column, `'${v}' 는 true/false 가 아니다`);
    return fallback;
  }

  /** 정해진 값 중 하나. 벗어나면 문제 + 첫 번째 값. */
  enum<T extends string>(column: string, allowed: readonly T[], fallback?: T): T {
    const v = this.cell(column);
    if (!v && fallback !== undefined) return fallback;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    this.issue(column, `'${v}' 는 ${allowed.join(' | ')} 중 하나여야 한다`);
    return fallback ?? allowed[0];
  }

  /** 선택 열거값 (빈 칸 = undefined). */
  optEnum<T extends string>(column: string, allowed: readonly T[]): T | undefined {
    if (!this.has(column)) return undefined;
    return this.enum(column, allowed);
  }

  /** `|` 로 나뉜 문자열 목록 (빈 칸 = 빈 배열). */
  list(column: string): string[] {
    const v = this.cells[column] ?? '';
    if (!v) return [];
    return v.split('|').map((s) => s.trim()).filter(Boolean);
  }

  /** `|` 로 나뉜 열거값 목록 — 하나라도 목록 밖이면 문제. */
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
   * 재료 목록 · 보상 목록처럼 "id:수량" 쌍이 반복되는 칸에 쓴다.
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

  /** 이 줄에 대한 문제를 직접 등록한다 (로더가 교차 검증할 때). */
  report(column: string, message: string): void {
    this.issue(column, message);
  }
}
