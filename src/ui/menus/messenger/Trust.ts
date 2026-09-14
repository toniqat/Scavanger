import type { GameContext } from '@/shared';
import { REP_LEVEL_MAX, REP_TABLE, repLevelOf } from '@/shared';
import { clamp01, el } from '../../dom';

/**
 * **NPC 개인 신뢰도**의 읽기 · 그리기 (2026-09-14, docs/plans/intel-broker.md §2.7).
 *
 * 기업 신뢰도(`ctx.meta.getRep`)와 **별개**이고 같은 `REP_TABLE`(0–5)을 쓴다 — 값은 `ctx.meta.npcTrust(npcId)` 하나에서만
 * 오고 여기서는 레벨 · 구간 비율만 푼다 (meta/ 를 import 하지 않는다 — 폴더끼리는 `ctx` 의 ref 로만 말한다).
 *
 *   `npcTrustOf`      → `{ trust, level, next, frac }` · `ctx.meta` 가 없으면 null (스모크의 debug NPC ref 도 여기로 온다)
 *   `buildNpcTrust`   → 대화창 머리 · 퀘스트 상세 머리가 같이 쓰는 `Lv.n + 게이지`
 *   `buildNpcAvatar`  → 초상 테두리를 도는 **radial 게이지** + 우하단 레벨 배지 (2026-09-14 3차)
 *   `buildTrustChip`  → 퀘스트 카드 보상 줄의 칩. 기업 신뢰도 재화 칩(`buildCurrencyChip`)과 **같은 틀**(`.item-chip.currency-chip`)
 *                       이되 `data-currency-id` 는 붙이지 않는다 — NPC 신뢰도는 `data/currencies.csv` 의 재화가 아니고
 *                       가짜 재화 · 가짜 아이템 정의를 만들지 않는다는 규약 때문이다 (호버 카드 대신 네이티브 title).
 *
 * CSS 는 `ui/styles/messenger.css` 의 `.ms-trust*` (접두사 `ms-`).
 */

export interface NpcTrustInfo {
  /** 누적 점수. */
  trust: number;
  /** 0 … `REP_LEVEL_MAX`. */
  level: number;
  /** 다음 레벨의 누적 점수. 최고 레벨이면 null. */
  next: number | null;
  /** 지금 레벨 구간의 0 … 1 (최고 레벨이면 1). */
  frac: number;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('ko-KR');

/** 지금 신뢰도. `ctx.meta` 가 아직 없으면(부팅 · 스모크) null — 부르는 쪽은 아무것도 그리지 않는다. */
export function npcTrustOf(ctx: GameContext, npcId: string): NpcTrustInfo | null {
  const meta = ctx.meta;
  if (!npcId || !meta || typeof meta.npcTrust !== 'function') return null;
  let trust = 0;
  try { trust = Math.max(0, Math.round(meta.npcTrust(npcId))); } catch { return null; }
  if (!Number.isFinite(trust)) return null;
  const level = repLevelOf(trust);
  const prev = REP_TABLE[level] ?? 0;
  const next = level >= REP_LEVEL_MAX ? null : REP_TABLE[level + 1] ?? null;
  const frac = next === null ? 1 : clamp01((trust - prev) / Math.max(1, next - prev));
  return { trust, level, next, frac };
}

/** 호버에 뜨는 한 줄 — `레이븐 신뢰도 Lv.4 · 1,650 / 3,000`. */
export function npcTrustTitle(name: string, t: NpcTrustInfo): string {
  const span = t.next === null ? `${fmt(t.trust)} · 최고 등급` : `${fmt(t.trust)} / ${fmt(t.next)}`;
  return `${name} 신뢰도 Lv.${t.level} · ${span}`;
}

export interface NpcTrustOptions {
  /** 좁은 자리용 — 게이지만 짧게, 숫자 없음. (2026-09-14 3차: 대화 목록 한 줄에서는 신뢰도를 아예 빼서 지금은 부르는 곳이 없다.) */
  compact?: boolean;
  /** 초상 · 이름 강조색 (`NpcDef.color`). 게이지가 이 색으로 찬다. */
  color?: string;
}

/**
 * `Lv.n [게이지] 1,650 / 3,000`. `ctx.meta` 가 없거나 값을 못 읽으면 **null** 이라 호출부는 그 자리를 비운다.
 * `name` 은 호버 한 줄에만 쓴다 (칸이 이미 그 NPC 옆이라 이름을 다시 적지 않는다).
 */
export function buildNpcTrust(ctx: GameContext, npcId: string, name: string, opts: NpcTrustOptions = {}): HTMLElement | null {
  const t = npcTrustOf(ctx, npcId);
  if (!t) return null;
  const wrap = el('span', { cls: `ms-trust${opts.compact ? ' compact' : ''}` });
  if (opts.color) wrap.style.setProperty('--qc', opts.color);
  wrap.title = npcTrustTitle(name, t);
  wrap.dataset.npc = npcId;
  wrap.dataset.level = String(t.level);
  el('span', { cls: 'ms-trust-lv ui-mono', text: `Lv.${t.level}`, parent: wrap });
  const bar = el('span', { cls: 'ms-bar ms-trust-bar', parent: wrap });
  el('i', { parent: bar }).style.transform = `scaleX(${t.frac.toFixed(3)})`;
  if (!opts.compact) {
    el('span', { cls: 'ms-trust-num ui-mono', text: t.next === null ? `${fmt(t.trust)} · 최고 등급` : `${fmt(t.trust)} / ${fmt(t.next)}`, parent: wrap });
  }
  return wrap;
}

export interface NpcAvatarOptions {
  /** 초상 글자 (`NpcDef.glyph` 또는 이름 첫 글자). */
  glyph: string;
  /** NPC 색 — 초상 바탕 · radial 게이지 · 레벨 배지가 같이 쓴다. */
  color: string;
}

/**
 * **신뢰도 radial 게이지를 두른 NPC 초상** (2026-09-14 3차, 사용자 결정) — 대화창 머리 · 퀘스트 탭 상세 머리가 같이 쓴다.
 *
 * 테두리는 conic-gradient 한 줄이다 (외부 에셋 금지 · SVG 도 필요 없다): `--frac` = **지금 레벨 구간 안의** 진행률이라
 * 레벨이 오르면 고리가 한 바퀴 돌고 처음부터 다시 찬다. 우하단 배지가 그 레벨 숫자다.
 * `ctx.meta` 가 없어(부팅 · 스모크) 신뢰도를 못 읽으면 고리는 빈 테두리로만 남고 배지는 없다 — 초상 자체는 늘 그린다.
 */
export function buildNpcAvatar(ctx: GameContext, npcId: string, name: string, opts: NpcAvatarOptions): HTMLElement {
  const t = npcTrustOf(ctx, npcId);
  const wrap = el('span', { cls: `ms-avwrap${t ? '' : ' no-trust'}` });
  wrap.style.setProperty('--qc', opts.color);
  wrap.style.setProperty('--frac', (t?.frac ?? 0).toFixed(3));
  if (t) {
    wrap.title = npcTrustTitle(name, t);
    wrap.dataset.npc = npcId;
    wrap.dataset.level = String(t.level);
  }
  const av = el('span', { cls: 'ms-av big', text: opts.glyph, parent: wrap });
  av.style.setProperty('--av', opts.color);
  if (t) el('span', { cls: 'ms-avlv ui-mono', text: String(t.level), parent: wrap });
  return wrap;
}

/**
 * 퀘스트 카드 보상 줄의 NPC 신뢰도 칩. 재화 칩과 같은 육각 틀 · 같은 글리프(`◈`)를 쓰되 색은 그 NPC 색이다.
 * `amount` 가 0 이하면 null.
 */
export function buildTrustChip(name: string, amount: number, color: string, size = 30): HTMLElement | null {
  if (!(amount > 0)) return null;
  const chip = el('div', { cls: 'item-chip currency-chip ms-trust-chip' });
  chip.style.setProperty('--chip-size', `${size}px`);
  chip.style.setProperty('--cy', color);
  chip.style.setProperty('--rc', color);
  chip.style.setProperty('--ic', color);
  chip.title = `${name} 신뢰도 +${fmt(amount)} — NPC 개인 신뢰도 (기업 신뢰도와 별개)`;
  const thumb = el('div', { cls: 'item-chip-thumb currency-thumb', parent: chip });
  el('span', { cls: 'item-chip-icon', text: '◈', parent: thumb });
  const count = el('div', { cls: 'item-chip-count', parent: thumb });
  el('span', { cls: 'item-chip-have', text: `+${fmt(amount)}`, parent: count });
  return chip;
}
