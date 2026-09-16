import type { ComputeClusterInfo, CryptoCoinDef, CryptoCoinInfo, GameContext, HoldAskHandle, HousingRef } from '@/shared';
import { CRYPTO_COIN_DEFS, CRYPTO_COIN_MAP, CRYPTO_TRADE_MAX_UNITS, CRYPTO_UNITS_PER_COIN, UI_HOLD_CONFIRM_S, cryptoCreditsFor, openHoldAsk } from '@/shared';
import type { PanelOverlay } from '../Panel';
import { el } from '../dom';
import './mining.css';

/* ────────────────────────────────────────────────────────────────────────────
 * **채굴 화면 공용** (2026-09-13, docs/DECISIONS.md 「2026-09-13 — 가구 접근 면 · 발전기 · 암호화폐 채굴」 · 2026-09-14 통합 창).
 *
 * 채굴 탭(`ClusterPage`) · 코인 드롭다운(`CoinPicker`) · 메인 컴퓨터 세 탭(`ComputerPages`)이 같이 쓰는 표기 · 계산 · 입력 조각.
 * 규칙은 하나도 없다 — 채굴 주기 · 견적 · 잠김 사유는 전부 `ctx.housing`(에이전트 ③)이 돌려준다. 여기 있는 계산은
 * **표시용 추정**(시간당 코인 · 크레딧)뿐이고, 식은 계약의 `cryptoCreditsFor` 를 그대로 부른다. CSS 접두사는 `.mn-`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 채굴 계약 메서드는 전부 optional 이다 (병렬로 짓는 폴더가 아직 없을 수 있다) — 화면은 이 모양으로만 읽는다. */
export type MiningHousing = HousingRef;

export const MS_PER_HOUR = 3_600_000;

export function coinDef(id: string | null | undefined): CryptoCoinDef | null {
  return id ? CRYPTO_COIN_MAP.get(id) ?? null : null;
}

/** 코인 목록 (housing 이 아직 없으면 csv 정의만으로 — 잠김 · 지갑 · 시세는 모른다). */
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

/** 서버 시세 (코인 1개당 크레딧), 모르면 null. */
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

/** 이 클러스터가 지금 설정으로 한 시간에 버는 단위 수 (코인 · 프로세서가 없으면 0). 표시용 추정. */
export function unitsPerHour(c: Pick<ComputeClusterInfo, 'coinId' | 'cycleMs'>): number {
  const def = coinDef(c.coinId);
  if (!def || !(c.cycleMs > 0) || !Number.isFinite(c.cycleMs)) return 0;
  return (def.yieldUnits * MS_PER_HOUR) / c.cycleMs;
}

/** 단위 수 → 시세 크레딧 (수수료 없는 평가액, 반올림). */
export function unitsValue(price: number, units: number): number {
  return (Math.max(0, price) * Math.max(0, units)) / Math.max(1, CRYPTO_UNITS_PER_COIN);
}

/** 크레딧 `credits` 로 살 수 있는 최대 단위 (수수료 포함, `CRYPTO_TRADE_MAX_UNITS` 까지). */
export function affordableUnits(price: number, credits: number): number {
  if (!(price > 0) || !(credits > 0)) return 0;
  let u = Math.min(CRYPTO_TRADE_MAX_UNITS, Math.floor((credits / price) * CRYPTO_UNITS_PER_COIN));
  // 올림 · 수수료 때문에 한두 단위 넘칠 수 있다 — 맞을 때까지 내린다 (많아야 몇 번)
  for (let guard = 0; u > 0 && cryptoCreditsFor('buy', price, u) > credits && guard < 64; guard++) {
    u = Math.max(0, Math.floor(u * 0.995) - 1);
  }
  return u;
}

export function fmtCredits(n: number): string {
  return Math.round(n).toLocaleString('ko-KR');
}

/** 시세 표기 — 100 이상은 정수, 그 밑은 소수 둘째 자리. */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return p >= 100 ? Math.round(p).toLocaleString('ko-KR') : p.toFixed(2);
}

/** 24시간 변동률 `+3.25 %` (null = `—`). */
export function fmtChange(c: number | null): string {
  if (c === null || !Number.isFinite(c)) return '—';
  const v = c * 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} %`;
}

export function changeTone(c: number | null): 'up' | 'down' | '' {
  if (c === null || !Number.isFinite(c) || c === 0) return '';
  return c > 0 ? 'up' : 'down';
}

/** 시간 길이 `12시간 30분` · `45분` · `30초` (주기 표기 — 남은 시간은 `HH:MM:SS` 시계를 쓴다). */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
  if (m > 0) return sec > 0 ? `${m}분 ${sec}초` : `${m}분`;
  return `${sec}초`;
}

/** 코인 글리프 칩 (`.mn-glyph`, 코인 색 `--cc`). */
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

/* ── 1초 홀드 확정 버튼 ─────────────────────────────────────────────────────── */

export interface HoldButton {
  readonly holding: boolean;
  cancel(): void;
  dispose(): void;
}

/**
 * **되돌릴 수 없는 확정 = `UI_HOLD_CONFIRM_S` 홀드** (CLAUDE.md, 기업 거래 성사와 같은 게이지 · 같은 규약): 클릭 · Enter · Space 로는
 * 아무 일도 없다. 게이지는 rAF(`fill` 의 `scaleX`), 확정은 타이머 — 프레임이 멈춘 탭에서도 확정이 멎지 않는다.
 * 일찍 떼면 `onTap`(사용법 안내).
 *
 * **2026-09-15 2차 (사용자 결정)**: 「버튼을 N초 동안 누르고 있으면 …」 안내 줄은 없앴다 — 이 함수로 묶는 버튼은
 * 라벨 왼쪽에 `shared/keycap.createHoldButtonCap()` 키캡을 둔다 (부르는 쪽이 만든다: 라벨 · 채움 바의 순서를
 * 아는 것은 그쪽이고, `setText` 로 라벨을 다시 쓸 때 키캡이 날아가지 않게 라벨은 자기 `span` 이어야 한다).
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

/** 패널 안 1초 홀드 경고 팝업 (`openHoldAsk`) — `PanelOverlay` 라 E · Tab 이 먼저 닫고, 패널이 닫히면 실행 없이 닫힌다. */
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
