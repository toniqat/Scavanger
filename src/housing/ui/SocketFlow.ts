import type { GameContext, GrowSocketTarget, HoldAskHandle, ItemDef } from '@/shared';
import { GROW_SOCKET_EFFECT_LABEL_KO, openHoldAsk } from '@/shared';
import type { PanelOverlay } from './Panel';
import type { StationMenu } from './StationMenu';
import type { TipRow } from './StationTip';
import { el } from './dom';

/* ────────────────────────────────────────────────────────────────────────────
 * **흙 · 배지 소켓 화면 공용** (2026-09-13, 요리 재료 티어 — docs/plans/food-tiers.md §5).
 *
 * 재배 화면(`GrowStation`)과 배양 화면(`CultureTank`)이 같은 규칙을 같은 모양으로 보여 주려고 뽑은 것:
 *  - `socketEffectText` / `socketTipRows` — 호버 카드의 소켓 줄. `speed` · `yield` 는 **흙 · 배지 내구도 비율**만큼만
 *    듣는다 (계약 `GrowSocketEffect`) — 그래서 카드는 비율을 곱한 **지금 듣는 값**을 적고, `wear` 는 그대로다.
 *  - `paintSocketDots` — 흙구멍 · 배양관 안의 작은 점 (칸 수만큼, 끼운 것은 채움). 바뀔 때만 다시 짓는다.
 *  - `SocketAsk` — 가득 찬 칸에 덮어 끼우기(교체할 소켓 고르기 → **1초 홀드** 경고)와 「비우기」의 소켓 소실 경고.
 *    규칙은 하나도 없다 — 확정되면 부른 쪽이 `HousingRef.insertGrowSocket` / `insertCultureSocket` 의 `replaceIndex` 로 넘기고,
 *    거절 사유(한국어)는 그 메서드가 돌려준다.
 * ──────────────────────────────────────────────────────────────────────────── */

const pct = (v: number): number => Math.round(v * 100);
const ratioOf = (r: number | undefined): number => (typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1);

/** 한 소켓의 효과 한 조각 — `성장 속도 −8 %` · `추가 수확 30 % 확률 +1` · `토양 마모 감소 −20 %`. `ratio` = 내구도 비율. */
export function socketEffectText(def: ItemDef | undefined, target: GrowSocketTarget, ratio?: number): string {
  const s = def?.growSocket;
  if (!s) return '효과 알 수 없음';
  const label = GROW_SOCKET_EFFECT_LABEL_KO[target]?.[s.effect] ?? s.effect;
  const r = s.effect === 'wear' ? 1 : ratioOf(ratio);
  const n = pct(s.amount * r);
  return s.effect === 'yield' ? `${label} ${n} % 확률 +1` : `${label} −${n} %`;
}

/** 호버 카드의 소켓 줄: 머리 한 줄(`n / 칸`) + 끼운 소켓마다 한 줄. 칸이 0 이면 아무것도 없다. */
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
 * 흙구멍 · 배양관 안의 소켓 점. `host` 의 자식 `<i>` 를 칸 수만큼 두고 끼운 것에 `.on` — 칸 수 · 개수가 바뀔 때만 쓴다
 * (1초 틱이 DOM 을 흔들지 않는다). 점은 `pointer-events: none` 이라 드롭 대상(흙구멍 · 유리)을 가리지 않는다.
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
  /** 교체할 소켓을 고르는 메뉴가 뜰 자리 (흙구멍 · 배양관). */
  anchor: HTMLElement;
  target: GrowSocketTarget;
  /** 새로 끼울 소켓. */
  newDef: ItemDef;
  /** 지금 끼워진 소켓 def id (칸이 가득 차 있다). */
  sockets: readonly string[];
  /** 흙 · 배지 내구도 비율 (메뉴의 효과 글). */
  ratio?: number;
  defOf(id: string): ItemDef | undefined;
  nameOf(id: string): string;
  /** 홀드 확정 뒤 — 부른 쪽이 `replaceIndex` 로 끼운다. */
  run(replaceIndex: number): void;
}

export interface HoldConfirmSpec {
  title: string;
  body: string;
  /** 홀드 버튼 글. */
  label: string;
  run(): void;
  /** `data-ask` (스모크). */
  id?: string;
}

/**
 * 소켓 교체 · 소켓 소실 경고 (`PanelOverlay`). 패널의 `overlays` 맨 뒤에 넣는다 — E · Tab 은 이 팝업을 먼저 취소하고,
 * Escape 는 `openHoldAsk` 가 `ctx.escape` 맨 위에서 스스로 받는다. 패널이 닫히면(`close()`) 아무것도 실행하지 않고 닫힌다.
 *
 * 교체 흐름 (사용자 결정 「가득 찬 칸에 덮어 끼우면 경고 팝업 — 옛 소켓 파괴」):
 *  1. 칸이 하나뿐이면 바로 2 로. 둘 이상이면 **교체할 소켓을 고르는 작은 메뉴**(`StationMenu`, 흙구멍 옆) — 줄마다 이름 · 지금 효과.
 *  2. `openHoldAsk` — 「끼운 소켓은 빼낼 수 없습니다 — 교체하면 <이름>은(는) 파괴됩니다」, 빨간 「교체」 버튼 **1초 홀드**만 확정.
 *     클릭 · Enter 로는 확정되지 않고 Escape · 취소는 아무것도 하지 않는다 (드롭한 소켓은 가방 · 창고에 그대로 있다).
 */
export class SocketAsk implements PanelOverlay {
  private handle: HoldAskHandle | null = null;
  /** Smoke counters. */
  readonly debug = { pickers: 0, asks: 0 };

  constructor(private readonly ctx: GameContext, private readonly menu: StationMenu) {}

  get isOpen(): boolean { return !!this.handle?.isOpen; }

  /** E · Tab · 패널 닫기 — 취소와 같다 (아무것도 실행하지 않는다). */
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

  /** 되돌릴 수 없는 확정 하나 — 빨간 버튼 1초 홀드 (`openHoldAsk`). */
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
