import type { CharBuff, GameContext, ItemDef } from '@/shared';
import {
  CHAR_BUFF_COLOR, CHAR_BUFF_GLYPH, ENV_COLOR, ENV_ICON,
  charBuffRemainingRatio, charBuffRemainingS, charBuffTitle,
} from '@/shared';
import { el, setText, toggleClass } from '../dom';
import '../styles/buffs.css';

/** 시간 글자 · 게이지를 다시 쓰는 주기 (UI 타이밍, 밸런스 아님). 타이머가 있는 썸네일이 보일 때만 돈다. */
const TICK_MS = 1000;

/** One thumbnail as the smoke / debug getters read it back. */
export interface BuffCellState {
  key: string;
  kind: CharBuff['kind'];
  glyph: string;
  color: string;
  /** `state === 'pending'` → drawn dimmed. */
  dim: boolean;
  /** red frame. */
  debuff: boolean;
  /** 0…1 remaining ratio of the time gauge, null when the buff has no timer. */
  ratio: number | null;
  /** `23h` / `42m` / `35s`, empty without a timer. */
  time: string;
  title: string;
}

interface Cell {
  root: HTMLElement;
  base: HTMLElement;
  lit: HTMLElement;
  reveal: HTMLElement;
  timeEl: HTMLElement;
  buff: CharBuff;
  glyph: string;
  color: string;
  ratio: number | null;
  /** `--r` as last written (rounded). */
  rs: string;
  time: string;
}

/**
 * **캐릭터 버프 썸네일 줄 (2026-09-12, 사용자 결정 — `docs/plans/char-buffs.md` §6-D).** 한 캐릭터의 `CharBuff[]` 를 작은 정사각
 * 썸네일로 늘어놓는다. PC 체력바 아래(`hud/Vitals`)와 좌하단 분대 목록의 분대원 행(`hud/Squad`)이 **같은 컴포넌트**를 쓴다 —
 * 크기만 `mini` 로 갈린다. 목록을 모으는 것은 player(내 것) · net(분대원 것)이고, 이 파일은 받은 목록을 **그대로 그린다**
 * (정렬은 소유자가 `CHAR_BUFF_ORDER` 로 이미 했다).
 *
 *   - 글리프 · 색: `meal` · `prep` = 아이템 def 의 `icon` · `color` (`ctx.loot.getItemDef`), `env_exposed` = `ENV_ICON` · `ENV_COLOR`,
 *     못 찾으면 `CHAR_BUFF_GLYPH` · `CHAR_BUFF_COLOR`.
 *   - `pending`(함선에서 다음 레이드에 실어 둔 것) = 흐리게 (`.is-pending`), 디버프 = 빨간 테두리 (`.is-debuff`).
 *   - 타이머(`startedAt` · `endsAt`)가 있으면 **시간 게이지** — 임플란트 썸네일(`styles/implant.css`)과 같은 두 얼굴 기법이다:
 *     흐린 바탕 얼굴 위에 밝은 사본을 밑에서부터 `charBuffRemainingRatio` 만큼만 드러내므로 남은 시간이 줄수록 빛이
 *     **위에서 아래로 빠진다**. 우하단에 아주 작은 남은 시간(`23h` · `42m` · `35s`).
 *   - `title` = `charBuffTitle` (요리 · 준비물 이름은 아이템 def 에서).
 *
 * `set(list)` 은 **참조로** 비교한다 (`PlayerRef.buffs` · `RemotePlayerRef.buffs` 는 바뀔 때만 새 배열이다) — 같은 배열이면 아무것도
 * 안 한다. 썸네일 DOM 은 `key` 로 재사용하고, 사라진 키만 떼어 낸다. `update()` 는 매 프레임(또는 분대 목록의 10 Hz) 불려도 되고,
 * 타이머가 있는 썸네일이 있을 때만 1초에 한 번 게이지 · 글자를 다시 쓴다. 시각은 `ctx.net.serverNow() ?? Date.now()` —
 * 목록의 시각을 찍은 player 와 같은 시계다.
 */
export class BuffStrip {
  readonly root: HTMLElement;
  private cells = new Map<string, Cell>();
  private list: readonly CharBuff[] | null = null;
  private timed = false;
  private nextTickAt = 0;

  constructor(parent: HTMLElement, opts: { mini?: boolean } = {}) {
    this.root = el('div', { cls: opts.mini ? 'bfs is-mini' : 'bfs', parent });
  }

  /** Install a new list (same reference = no-op). `null` / empty clears the strip. */
  set(list: readonly CharBuff[] | null | undefined, ctx: GameContext | null): void {
    const next = list && list.length > 0 ? list : null;
    if (next === this.list) return;
    this.list = next;
    const seen = new Set<string>();
    let timed = false;
    if (next) {
      let i = 0;
      for (const b of next) {
        if (!b || typeof b.key !== 'string' || seen.has(b.key)) continue;
        seen.add(b.key);
        const cell = this.cells.get(b.key) ?? this.makeCell(b.key);
        this.paintCell(cell, b, ctx);
        // keep DOM order = list order without re-appending cells that are already in place
        if (this.root.children[i] !== cell.root) this.root.insertBefore(cell.root, this.root.children[i] ?? null);
        i++;
        if (typeof b.endsAt === 'number' && typeof b.startedAt === 'number') timed = true;
      }
    }
    for (const [key, cell] of this.cells) {
      if (seen.has(key)) continue;
      cell.root.remove();
      this.cells.delete(key);
    }
    this.timed = timed;
    this.nextTickAt = 0;
    toggleClass(this.root, 'has-items', seen.size > 0);
    if (timed) this.tick(ctx);
  }

  /** Per frame (or per squad refresh): re-writes the time gauges once a second while a timed buff is shown. */
  update(ctx: GameContext | null): void {
    if (!this.timed) return;
    const t = performance.now();
    if (t < this.nextTickAt) return;
    this.tick(ctx);
  }

  /** Rendered thumbnails in DOM order (debug / smoke). */
  get state(): BuffCellState[] {
    const out: BuffCellState[] = [];
    for (const node of Array.from(this.root.children)) {
      const key = (node as HTMLElement).dataset.key;
      const c = key !== undefined ? this.cells.get(key) : undefined;
      if (!c) continue;
      out.push({
        key: c.buff.key, kind: c.buff.kind, glyph: c.glyph, color: c.color,
        dim: c.root.classList.contains('is-pending'), debuff: c.root.classList.contains('is-debuff'),
        ratio: c.ratio, time: c.time, title: c.root.title,
      });
    }
    return out;
  }

  get count(): number { return this.cells.size; }

  dispose(): void { this.cells.clear(); this.root.remove(); }

  private makeCell(key: string): Cell {
    const root = el('div', { cls: 'bfs-cell' });
    root.dataset.key = key;
    const base = el('span', { cls: 'bfs-face', parent: root });
    const reveal = el('span', { cls: 'bfs-reveal', parent: root });
    const lit = el('span', { cls: 'bfs-face lit', parent: reveal });
    const timeEl = el('span', { cls: 'bfs-t ui-mono', text: '', parent: root });
    const cell: Cell = { root, base, lit, reveal, timeEl, buff: { kind: 'rest', key, debuff: false, state: 'active' }, glyph: '', color: '', ratio: null, rs: '', time: '' };
    this.cells.set(key, cell);
    return cell;
  }

  private paintCell(cell: Cell, b: CharBuff, ctx: GameContext | null): void {
    cell.buff = b;
    const def = (b.kind === 'meal' || b.kind === 'prep') && b.defId ? defOf(ctx, b.defId) : undefined;
    let glyph: string = CHAR_BUFF_GLYPH[b.kind] ?? '•';
    let color: string = CHAR_BUFF_COLOR[b.kind] ?? 'var(--c-text-dim)';
    if (def) { glyph = def.icon || glyph; color = def.color || color; }
    else if (b.kind === 'env_exposed' && b.env) { glyph = ENV_ICON[b.env] ?? glyph; color = ENV_COLOR[b.env] ?? color; }
    if (glyph !== cell.glyph) { cell.glyph = glyph; setText(cell.base, glyph); setText(cell.lit, glyph); }
    if (color !== cell.color) { cell.color = color; cell.root.style.setProperty('--bc', color); }
    toggleClass(cell.root, 'is-pending', b.state === 'pending');
    toggleClass(cell.root, 'is-debuff', !!b.debuff);
    const hasTimer = typeof b.endsAt === 'number' && typeof b.startedAt === 'number';
    toggleClass(cell.root, 'is-timed', hasTimer);
    let title = '';
    try { title = charBuffTitle(b, (id) => defOf(ctx, id)); } catch { title = b.key; }
    if (cell.root.title !== title) cell.root.title = title;
    cell.root.dataset.kind = b.kind;
    if (!hasTimer) this.writeGauge(cell, null, '');
  }

  private tick(ctx: GameContext | null): void {
    this.nextTickAt = performance.now() + TICK_MS;
    const now = nowMs(ctx);
    for (const cell of this.cells.values()) {
      const b = cell.buff;
      const ratio = charBuffRemainingRatio(b, now);
      if (ratio === null) continue;
      this.writeGauge(cell, ratio, formatRemaining(charBuffRemainingS(b, now) ?? 0));
    }
  }

  private writeGauge(cell: Cell, ratio: number | null, time: string): void {
    const r = ratio === null ? null : Math.min(1, Math.max(0, ratio));
    cell.ratio = r;
    const rs = (r ?? 1).toFixed(3);
    if (cell.rs !== rs) { cell.rs = rs; cell.root.style.setProperty('--r', rs); }
    if (cell.time !== time) { cell.time = time; setText(cell.timeEl, time); }
  }
}

function defOf(ctx: GameContext | null, defId: string): ItemDef | undefined {
  if (!ctx) return undefined;
  try { return ctx.loot?.getItemDef(defId) ?? ctx.inventory?.getDef(defId); } catch { return undefined; }
}

/** The clock the buff list was stamped with (`player` / `progression` use the same one). */
function nowMs(ctx: GameContext | null): number {
  try {
    const n = ctx?.net?.serverNow?.();
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return n;
  } catch { /* offline */ }
  return Date.now();
}

/** `23h` · `42m` · `35s` — whole hours / minutes (floor), seconds rounded up so the last second reads `1s`. */
export function formatRemaining(sec: number): string {
  const s = Math.max(0, sec);
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${Math.ceil(s)}s`;
}
