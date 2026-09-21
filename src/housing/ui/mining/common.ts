import type { ComputeClusterInfo, CryptoCoinDef, CryptoCoinInfo, GameContext, HoldAskHandle, HousingRef } from '@/shared';
import { CRYPTO_COIN_DEFS, CRYPTO_COIN_MAP, CRYPTO_TRADE_MAX_UNITS, CRYPTO_UNITS_PER_COIN, UI_HOLD_CONFIRM_S, cryptoCreditsFor, openHoldAsk } from '@/shared';
import type { PanelOverlay } from '../Panel';
import { el } from '../dom';
import './mining.css';

/* ────────────────────────────────────────────────────────────────────────────
 * **Shared by the mining screen** (2026-09-13 · the 2026-09-14 combined window).
 *
 * The formatting · calculation · input pieces the `채굴` tab (`ClusterPage`) · the coin dropdown (`CoinPicker`) · the main computer's three tabs (`ComputerPages`) share.
 * Not one rule lives here — the mining cycle · the quote · the lock reason all come back from `ctx.housing`. The
 * calculations here are **display estimates** only (coins · credits per hour), and the formula calls the contract's `cryptoCreditsFor` as-is. The CSS prefix is `.mn-`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The mining half of `HousingRef` is optional in the contract (`shared/housing.ts`), so every call here goes through `?.` — the screen reads only through this shape. */
export type MiningHousing = HousingRef;

export const MS_PER_HOUR = 3_600_000;

export function coinDef(id: string | null | undefined): CryptoCoinDef | null {
  return id ? CRYPTO_COIN_MAP.get(id) ?? null : null;
}

/** The coin list (with no housing yet, from the csv defs alone — the lock · the wallet · the quote are unknown). */
export function coinInfos(h: MiningHousing, ctx: GameContext): CryptoCoinInfo[] {
  try {
    const list = h.getCryptoCoins?.();
    if (list && list.length) return list;
  } catch { /* unfinished folder */ }
  const m = ctx.net?.crypto;
  return CRYPTO_COIN_DEFS.map((def) => ({
    def,
    unlocked: !def.unlockQuest,
    lockReason: def.unlockQuest ? '기업 퀘스트 완료 필요' : null,
    walletUnits: 0,
    price: m?.available ? m.prices[def.id] ?? null : null,
    change24h: m?.available ? m.change24h[def.id] ?? null : null,
  }));
}

export function clusterList(h: MiningHousing): ComputeClusterInfo[] {
  try { return h.getComputeClusters?.() ?? []; } catch { return []; }
}

export function clusterOf(h: MiningHousing, uid: string): ComputeClusterInfo | null {
  try {
    if (h.getComputeCluster) return h.getComputeCluster(uid);
    return clusterList(h).find((c) => c.uid === uid) ?? null;
  } catch { return null; }
}

/** The server quote (credits per coin), null when unknown. */
export function livePrice(ctx: GameContext, coinId: string | null | undefined): number | null {
  const m = ctx.net?.crypto;
  if (!coinId || !m || !m.available) return null;
  const p = m.prices[coinId];
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

export function liveChange(ctx: GameContext, coinId: string): number | null {
  const m = ctx.net?.crypto;
  if (!m || !m.available) return null;
  const c = m.change24h[coinId];
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** The units this cluster earns in an hour at its current setup (0 with no coin · no processor). A display estimate. */
export function unitsPerHour(c: Pick<ComputeClusterInfo, 'coinId' | 'cycleMs'>): number {
  const def = coinDef(c.coinId);
  if (!def || !(c.cycleMs > 0) || !Number.isFinite(c.cycleMs)) return 0;
  return (def.yieldUnits * MS_PER_HOUR) / c.cycleMs;
}

/** Units → credits at the quote (the value with no fee, rounded). */
export function unitsValue(price: number, units: number): number {
  return (Math.max(0, price) * Math.max(0, units)) / Math.max(1, CRYPTO_UNITS_PER_COIN);
}

/** The most units `credits` credits can buy (fee included, up to `CRYPTO_TRADE_MAX_UNITS`). */
export function affordableUnits(price: number, credits: number): number {
  if (!(price > 0) || !(credits > 0)) return 0;
  let u = Math.min(CRYPTO_TRADE_MAX_UNITS, Math.floor((credits / price) * CRYPTO_UNITS_PER_COIN));
  // the ceil · the fee can overshoot by a unit or two — lowered until it fits (a few rounds at most)
  for (let guard = 0; u > 0 && cryptoCreditsFor('buy', price, u) > credits && guard < 64; guard++) {
    u = Math.max(0, Math.floor(u * 0.995) - 1);
  }
  return u;
}

export function fmtCredits(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

/** Quote formatting — an integer at 100 and above, two decimals below it. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p >= 100 ? Math.round(p).toLocaleString('ko-KR') : p.toFixed(2);
}

/** The 24-hour change `+3.25 %` (null = `—`). */
export function fmtChange(c: number | null): string {
  if (c === null || !Number.isFinite(c)) return '—';
  const v = c * 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} %`;
}

export function changeTone(c: number | null): 'up' | 'down' | '' {
  if (c === null || !Number.isFinite(c) || c === 0) return '';
  return c > 0 ? 'up' : 'down';
}

/** A duration `12시간 30분` · `45분` · `30초` (the cycle readout — the remaining time uses the `HH:MM:SS` clock). */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return sec > 0 ? `${m}분 ${sec}초` : `${m}분`;
  return `${sec}초`;
}

/** The coin glyph chip (`.mn-glyph`, the coin colour `--cc`). */
export function coinGlyph(parent: HTMLElement, def: CryptoCoinDef | null, cls = ''): HTMLElement {
  const g = el('span', { cls: `mn-glyph ${cls}`.trim(), text: def?.glyph ?? '·', parent });
  if (def) g.style.setProperty('--cc', def.color);
  return g;
}

export function paintCoinGlyph(g: HTMLElement, def: CryptoCoinDef | null): void {
  const text = def?.glyph ?? '·';
  if (g.textContent !== text) g.textContent = text;
  const c = def?.color ?? '';
  if (g.dataset.c !== c) { g.dataset.c = c; if (c) g.style.setProperty('--cc', c); else g.style.removeProperty('--cc'); }
}

/* ── The 1 s hold confirm button ───────────────────────────────────────── */

export interface HoldButton {
  readonly holding: boolean;
  cancel(): void;
  dispose(): void;
}

/**
 * **An irreversible confirm = a `UI_HOLD_CONFIRM_S` hold** (CLAUDE.md, the same gauge · the same contract as closing a corporation
 * trade): a click · Enter · Space does nothing. The gauge is rAF (`fill`'s `scaleX`), the confirm is a timer — the confirm does
 * not stall in a tab whose frames have stopped. Released early it is `onTap` (the usage hint).
 *
 * **2026-09-15 2nd pass (user's decision)**: the 「버튼을 N초 동안 누르고 있으면 …」 guidance row is gone — a button bound by this
 * function carries a `shared/keycap.createHoldButtonCap()` keycap left of the label (built by the caller: it is the caller that
 * knows the order of the label · the fill bar, and the label has to be its own `span` so rewriting it with `setText` does not blow the keycap away).
 */
export function bindHoldButton(btn: HTMLButtonElement, fill: HTMLElement, onDone: () => void, onTap?: () => void): HoldButton {
  let hold: { t0: number; raf: number; timer: number } | null = null;
  const holdMs = Math.max(1, UI_HOLD_CONFIRM_S * 1000);
  const cancel = (): void => {
    const h = hold;
    hold = null;
    if (h) { cancelAnimationFrame(h.raf); clearTimeout(h.timer); }
    fill.style.transform = 'scaleX(0)';
    btn.classList.remove('is-holding');
  };
  const onClick = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); } };
  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || btn.disabled || hold) return;
    e.stopPropagation(); e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
    const t0 = performance.now();
    const tick = (): void => {
      if (!hold || hold.t0 !== t0) return;
      const f = Math.min(1, (performance.now() - t0) / holdMs);
      fill.style.transform = `scaleX(${f.toFixed(3)})`;
      if (f < 1) hold.raf = requestAnimationFrame(tick);
    };
    const timer = window.setTimeout(() => {
      if (!hold || hold.t0 !== t0) return;
      cancel();
      if (!btn.disabled) onDone();
    }, holdMs);
    hold = { t0, raf: requestAnimationFrame(tick), timer };
    btn.classList.add('is-holding');
  };
  const release = (): void => {
    const h = hold;
    if (!h) return;
    const f = (performance.now() - h.t0) / holdMs;
    cancel();
    if (f < 0.6) onTap?.();
  };
  btn.addEventListener('click', onClick);
  btn.addEventListener('keydown', onKey);
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('lostpointercapture', release);
  return {
    get holding() { return !!hold; },
    cancel,
    dispose(): void {
      cancel();
      btn.removeEventListener('click', onClick);
      btn.removeEventListener('keydown', onKey);
      btn.removeEventListener('pointerdown', onDown);
      btn.removeEventListener('pointerup', release);
      btn.removeEventListener('pointercancel', release);
      btn.removeEventListener('pointerleave', release);
      btn.removeEventListener('lostpointercapture', release);
    },
  };
}

/** The in-panel 1 s hold warning popup (`openHoldAsk`) — a `PanelOverlay`, so E · Tab close it first, and it closes without running when the panel closes. */
export class MiningAsk implements PanelOverlay {
  private handle: HoldAskHandle | null = null;
  constructor(private readonly ctx: GameContext) {}
  get isOpen(): boolean { return !!this.handle?.isOpen; }
  close(): void {
    const h = this.handle;
    this.handle = null;
    if (h?.isOpen) h.close();
  }
  confirm(spec: { id: string; title: string; body: string; label: string; run(): void }): void {
    this.close();
    this.handle = openHoldAsk(this.ctx, {
      id: spec.id,
      title: spec.title,
      body: spec.body,
      danger: true,
      buttons: [
        { label: '취소', cancel: true },
        { label: spec.label, kind: 'danger', hold: true, run: () => spec.run() },
      ],
    });
  }
}
