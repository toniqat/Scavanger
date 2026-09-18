/* ────────────────────────────────────────────────────────────────────────────
 * The communication wheel (2026-09-09, owner: ui/hud/CommsWheel)
 *
 * **Holding** `H` opens a radial wheel; push the mouse to pick a slice and release the key, and that one line goes to
 * the squad (a chat line + a toast + a sound). A short tap does nothing — this key is the wheel and nothing else.
 *
 * The layout splits in two by state:
 *   - while standing (`COMMS_ALIVE`) — **4 slices** N / E / S / W
 *   - while downed (`COMMS_DOWNED`)  — **2 slices** left / right (`살려줘` · `나를 버려`)
 * At the same moment the local ping's (mouse wheel button) hold gesture turns into those same two lines (`PingKind`'s `help` / `abandon`).
 *
 * An entry whose text (`line`) holds `{n}` is filled in with the number **by the sender** (`comms:sent.text` is
 * always a finished sentence). Today `contract` is the only one, and it reads its value from meta/'s running contract.
 *
 * This file holds only the values (labels · layout); the numbers are `data/constants.csv` (`COMMS_*`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Id of one line. **Never reorder or delete** — the wire (`CommsMessage.id`) carries this string verbatim. */
export type CommsId =
  /* while standing (4 slices) */
  | 'need_heal'    // `회복수단이 필요하다`
  | 'extract'      // `탈출해야 한다`
  | 'contract'     // highlights my contract — `계약 완료까지 <이름> <n>건 남았다`
  | 'lead'         // `앞장서라`
  /* while downed (2 slices) */
  | 'help_me'      // `살려줘`
  | 'abandon_me';  // `나를 버려`

/** Where a slice sits. The 4-slice layout uses N/E/S/W, the 2-slice layout only L/R. */
export type CommsDir = 'N' | 'E' | 'S' | 'W' | 'L' | 'R';

export interface CommsDef {
  id: CommsId;
  /** Short label drawn on the wheel slice. */
  label: string;
  /**
   * The sentence that actually goes out. `{n}` · `{name}` are substituted by the sender (when they cannot be, it
   * uses `fallback`). The sender's name is not prefixed here — chat and the toast add it from `comms:sent.byName`.
   */
  line: string;
  /** Sentence used when `{n}` cannot be filled in (no contract at all, and so on). Absent = `line` as it is. */
  fallback?: string;
  dir: CommsDir;
  /** Slice colour (CSS). The more urgent, the redder. */
  color: string;
}

/** The 4 slices while standing. **Array order = wheel index**, and `comms:wheelChanged.hover` is that index. */
export const COMMS_ALIVE: readonly CommsDef[] = [
  { id: 'need_heal', dir: 'N', label: '회복 필요', line: '회복수단이 필요하다!', color: '#4fd17e' },
  { id: 'extract',   dir: 'E', label: '탈출',     line: '탈출해야 한다!',       color: '#ffb347' },
  { id: 'contract',  dir: 'S', label: '내 계약',  line: '내 계약 — {name} 완료까지 {n}건 남았다.', fallback: '진행 중인 계약이 없다.', color: '#7fb7e6' },
  { id: 'lead',      dir: 'W', label: '앞장서라', line: '앞장서라.',             color: '#c77dff' },
];

/** The 2 slices while downed (left / right). */
export const COMMS_DOWNED: readonly CommsDef[] = [
  { id: 'help_me',     dir: 'L', label: '살려줘',     line: '살려줘!',       color: '#ff4d4d' },
  { id: 'abandon_me',  dir: 'R', label: '나를 버려',  line: '나를 버려라.',  color: '#8a929c' },
];

/** id → def (both layouts in one table). */
export const COMMS_DEF_MAP: ReadonlyMap<CommsId, CommsDef> =
  new Map([...COMMS_ALIVE, ...COMMS_DOWNED].map((d) => [d.id, d]));

/** The layout used in that state. Nowhere else writes `downed ? COMMS_DOWNED : COMMS_ALIVE` again. */
export function commsLayout(downed: boolean): readonly CommsDef[] {
  return downed ? COMMS_DOWNED : COMMS_ALIVE;
}

/**
 * Fills in `line`'s placeholders. With a value missing it returns `fallback` (or `line` verbatim when there is none).
 * Called only on the sending side; a receiver draws the already-finished `comms:sent.text` as it is.
 */
export function fillCommsLine(def: CommsDef, vars?: { n?: number; name?: string }): string {
  const needsN = def.line.includes('{n}');
  const needsName = def.line.includes('{name}');
  if ((needsN && vars?.n === undefined) || (needsName && !vars?.name)) return def.fallback ?? def.line;
  return def.line
    .replace('{n}', String(vars?.n ?? 0))
    .replace('{name}', vars?.name ?? '');
}

/**
 * The `PingKind` a local ping becomes while downed. Left = `살려줘` (`help`), right = `나를 버려` (`abandon`);
 * while standing it stays left = `여기 조심해` (`caution`), right = `저쪽으로 가자` (`attack`).
 * The labels are owned by `PING_LABEL` in ui/hud/Pings — this only decides which kind sits on which side.
 */
export const PING_HOLD_KINDS = {
  alive: { left: 'caution', right: 'attack' },
  downed: { left: 'help', right: 'abandon' },
} as const;

/** Korean labels drawn on the left / right wheel slices (the ping hold wheel). */
export const PING_HOLD_LABEL_KO = {
  caution: '여기 조심해', attack: '저쪽으로 가자', help: '살려줘', abandon: '나를 버려',
} as const;
