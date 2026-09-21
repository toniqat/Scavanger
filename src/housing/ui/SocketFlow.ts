import type { GameContext, GrowSocketTarget, HoldAskHandle, ItemDef } from '@/shared';
import { GROW_SOCKET_EFFECT_LABEL_KO, openHoldAsk } from '@/shared';
import type { PanelOverlay } from './Panel';
import type { StationMenu } from './StationMenu';
import type { TipRow } from './StationTip';
import { el } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * **Shared screen parts for soil · medium sockets** (2026-09-13, cooking material tiers).
 *
 * Pulled out so the grow station screen (`GrowStation`) and the culture screen (`CultureTank`) show the same rules the same way:
 *  - `socketEffectText` / `socketTipRows` — the socket rows of the hover card. `speed` · `yield` apply only as far as **the soil ·
 *    medium durability ratio** (contract `GrowSocketEffect`) — so the card writes the **value in effect now**, with the ratio multiplied in, while `wear` is unchanged.
 *  - `paintSocketDots` — the small dots inside the pot · the culture tube (one per socket slot, the filled ones marked). Rebuilt only when they change.
 *  - `SocketAsk` — inserting over a full slot (pick the socket to replace → a **1 s hold** warning) and the 「비우기」 socket-loss warning.
 *    It holds no rules at all — on a confirm the caller passes it on as the `replaceIndex` of `HousingRef.insertGrowSocket` /
 *    `insertCultureSocket`, and that method returns the refusal reason (in Korean).
 * ──────────────────────────────────────────────────────────────────────────── */

const pct = (v: number): number => Math.round(v * 100);
const ratioOf = (r: number | undefined): number => (typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1);

/** One socket's effect, one piece — `성장 속도 −8 %` · `추가 수확 30 % 확률 +1` · `토양 마모 감소 −20 %`. `ratio` = the durability ratio. */
export function socketEffectText(def: ItemDef | undefined, target: GrowSocketTarget, ratio?: number): string {
  const s = def?.growSocket;
  if (!s) return '효과 알 수 없음';
  const label = GROW_SOCKET_EFFECT_LABEL_KO[target]?.[s.effect] ?? s.effect;
  const r = s.effect === 'wear' ? 1 : ratioOf(ratio);
  const n = pct(s.amount * r);
  return s.effect === 'yield' ? `${label} ${n} % 확률 +1` : `${label} −${n} %`;
}

/** The hover card's socket rows: one header row (`n / 칸`) + one row per inserted socket. Nothing at all when there are 0 slots. */
export function socketTipRows(
  defOf: (id: string) => ItemDef | undefined,
  nameOf: (id: string) => string,
  target: GrowSocketTarget,
  sockets: readonly string[] | undefined,
  slots: number | undefined,
  ratio?: number,
): TipRow[] {
  const list = sockets ?? [];
  const n = Math.max(0, Math.floor(slots ?? 0));
  if (n <= 0 && !list.length) return [];
  const rows: TipRow[] = [{ k: '소켓', v: `${list.length} / ${n}칸${list.length >= n && n > 0 ? ' (가득)' : ''}` }];
  list.forEach((id, i) => {
    rows.push({ k: `  ${i + 1}`, v: `${nameOf(id)} · ${socketEffectText(defOf(id), target, ratio)}`, tone: 'good' });
  });
  return rows;
}

/**
 * The socket dots inside the pot · the culture tube. It keeps one `<i>` child of `host` per socket slot and puts `.on` on the
 * filled ones — written only when the slot count · the filled count changes (the 1 s tick never disturbs the DOM). The dots are `pointer-events: none`, so they never cover the drop target (the pot · the glass).
 */
export function paintSocketDots(host: HTMLElement, slots: number | undefined, filled: number | undefined): void {
  const n = Math.max(0, Math.floor(slots ?? 0));
  const f = Math.max(0, Math.min(n, Math.floor(filled ?? 0)));
  const key = `${n}:${f}`;
  if (host.dataset.k === key) return;
  host.dataset.k = key;
  while (host.children.length > n) host.lastElementChild!.remove();
  while (host.children.length < n) el('i', { parent: host });
  for (let i = 0; i < n; i++) (host.children[i] as HTMLElement).classList.toggle('on', i < f);
  host.hidden = n === 0;
}

export interface SocketReplaceSpec {
  /** Where the menu that picks the socket to replace opens (the pot · the culture tube). */
  anchor: HTMLElement;
  target: GrowSocketTarget;
  /** The socket about to be inserted. */
  newDef: ItemDef;
  /** The def ids of the sockets in right now (the slots are full). */
  sockets: readonly string[];
  /** The soil · medium durability ratio (for the menu's effect text). */
  ratio?: number;
  defOf(id: string): ItemDef | undefined;
  nameOf(id: string): string;
  /** After the hold confirm — the caller inserts with `replaceIndex`. */
  run(replaceIndex: number): void;
}

export interface HoldConfirmSpec {
  title: string;
  body: string;
  /** The hold button's text. */
  label: string;
  run(): void;
  /** `data-ask` (the smoke test). */
  id?: string;
}

/**
 * The socket replace · socket loss warning (`PanelOverlay`). It goes last in the panel's `overlays` — E · Tab cancel this popup
 * first, and Escape is taken by `openHoldAsk` itself at the top of `ctx.escape`. When the panel closes (`close()`) it closes without running anything.
 *
 * The replace flow (user's decision 「inserting over a full slot pops a warning — the old socket is destroyed」):
 *  1. With only one slot, straight to 2. With more, a **small menu that picks the socket to replace** (`StationMenu`, beside the pot) — name · current effect per row.
 *  2. `openHoldAsk` — 「끼운 소켓은 빼낼 수 없습니다 — 교체하면 <이름>은(는) 파괴됩니다」, and only a **1 s hold** of the red 「교체」 button confirms.
 *     A click · Enter do not confirm, and Escape · cancel do nothing (the dropped socket stays in the bag · stash).
 */
export class SocketAsk implements PanelOverlay {
  private handle: HoldAskHandle | null = null;
  /** Smoke counters. */
  readonly debug = { pickers: 0, asks: 0 };

  constructor(private readonly ctx: GameContext, private readonly menu: StationMenu) {}

  get isOpen(): boolean { return !!this.handle?.isOpen; }

  /** E · Tab · the panel closing — the same as a cancel (nothing is run). */
  close(): void {
    const h = this.handle;
    this.handle = null;
    if (h?.isOpen) h.close();
  }

  askReplace(spec: SocketReplaceSpec): void {
    if (!spec.sockets.length) return;
    if (spec.sockets.length === 1) { this.confirmReplace(spec, 0); return; }
    this.debug.pickers++;
    const r = spec.anchor.getBoundingClientRect();
    this.menu.show(r.right + 6, r.top, spec.sockets.map((id, i) => ({
      label: `${i + 1}. ${spec.nameOf(id)} 교체 — ${socketEffectText(spec.defOf(id), spec.target, spec.ratio)}`,
      danger: true,
      run: () => this.confirmReplace(spec, i),
    })));
  }

  private confirmReplace(spec: SocketReplaceSpec, index: number): void {
    const oldId = spec.sockets[index];
    if (!oldId) return;
    const oldName = spec.nameOf(oldId);
    this.confirm({
      id: 'hs-socket-replace',
      title: '소켓 교체',
      body: `끼운 소켓은 빼낼 수 없습니다 — 교체하면 ${oldName}은(는) 파괴됩니다.\n`
        + `${oldName} (${socketEffectText(spec.defOf(oldId), spec.target, spec.ratio)})\n`
        + `→ ${spec.newDef.name} (${socketEffectText(spec.newDef, spec.target, spec.ratio)})`,
      label: '교체',
      run: () => spec.run(index),
    });
  }

  /** One irreversible confirm — a 1 s hold of the red button (`openHoldAsk`). */
  confirm(spec: HoldConfirmSpec): void {
    this.close();
    this.debug.asks++;
    const h = openHoldAsk(this.ctx, {
      id: spec.id,
      title: spec.title,
      body: spec.body,
      danger: true,
      buttons: [
        { label: '취소', cancel: true },
        { label: spec.label, kind: 'danger', hold: true, run: () => spec.run() },
      ],
    });
    this.handle = h;
  }
}
