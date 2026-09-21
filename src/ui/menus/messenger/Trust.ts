import type { GameContext, PlayerCode, PlayerTrustInfo } from '@/shared';
import { REP_LEVEL_MAX, REP_TABLE, repLevelOf } from '@/shared';
import { clamp01, el } from '../../dom';

/**
 * Reading · drawing an **NPC's personal trust** (2026-09-14).
 *
 * **Separate** from corporation reputation (`ctx.meta.getRep`) while using the same `REP_TABLE` (0–5) — the value comes from
 * `ctx.meta.npcTrust(npcId)` alone and only the level · the band fraction are worked out here (meta/ is not imported — folders speak to each other through `ctx` refs only).
 *
 *   `npcTrustOf`      → `{ trust, level, next, frac }` · null with no `ctx.meta` (the smoke's debug NPC ref arrives here too)
 *   `buildNpcTrust`   → the `Lv.n + gauge` the conversation head · the quest detail head share
 *   `buildNpcAvatar`  → the **radial gauge** running around the avatar's border + the level badge at the bottom right (2026-09-14 3rd pass)
 *   `buildTrustChip`  → the chip on a quest card's reward row. The **same frame** (`.item-chip.currency-chip`) as the
 *                       corporation reputation currency chip (`buildCurrencyChip`), but without `data-currency-id` — NPC
 *                       trust is not a currency in `data/currencies.csv` and the contract says no fake currencies · fake item
 *                       defs are made. The hover card is `ItemTip`'s **text card** (`data-tip-name` · `-sub` · `-desc` · `-color`) — before 2026-09-17 it was a native title only and no game card appeared.
 *
 * The CSS is `.ms-trust*` in `ui/styles/messenger.css` (prefix `ms-`).
 */

export interface NpcTrustInfo {
  /** The accumulated score. */
  trust: number;
  /** 0 … `REP_LEVEL_MAX`. */
  level: number;
  /** The next level’s accumulated score. null at the top level. */
  next: number | null;
  /** 0 … 1 inside the current level’s band (1 at the top level). */
  frac: number;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('ko-KR');

/** Trust right now. null while there is no `ctx.meta` yet (boot · smoke) — the caller then draws nothing. */
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

/** The one line that appears on hover — `레이븐 신뢰도 Lv.4 · 1,650 / 3,000`. */
export function npcTrustTitle(name: string, t: NpcTrustInfo): string {
  const span = t.next === null ? `${fmt(t.trust)} · 최고 등급` : `${fmt(t.trust)} / ${fmt(t.next)}`;
  return `${name} 신뢰도 Lv.${t.level} · ${span}`;
}

export interface NpcTrustOptions {
  /** For a narrow spot — a short gauge only, no numbers. (2026-09-14 3rd pass: trust left the conversation row entirely, so nothing calls it now.) */
  compact?: boolean;
  /** The avatar · name accent colour (`NpcDef.color`). The gauge fills in it. */
  color?: string;
}

/**
 * `Lv.n [gauge] 1,650 / 3,000`. With no `ctx.meta`, or a value that cannot be read, it is **null** and the caller leaves the spot empty.
 * `name` is used in the hover line only (the slot already sits beside that NPC, so the name is not written again).
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
  /** The avatar glyph (`NpcDef.glyph`, or the name’s first character). */
  glyph: string;
  /** The NPC colour — the avatar background · the radial gauge · the level badge share it. */
  color: string;
}

/**
 * **An NPC avatar wearing the trust radial gauge** (2026-09-14 3rd pass, user's decision) — the conversation head · the quest tab's detail head share it.
 *
 * The border is one conic-gradient (no external assets · no SVG needed): `--frac` = the progress **inside the current level's
 * band**, so a level-up turns the ring once and it fills again from the start. The badge at the bottom right is that level.
 * With no `ctx.meta` (boot · smoke) trust cannot be read, the ring stays an empty border and there is no badge — the avatar itself is always drawn.
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
 * The NPC trust chip on a quest card's reward row. The same hexagonal frame · the same glyph (`◈`) as a currency chip, in that NPC's colour.
 * null when `amount` is 0 or less.
 */
export function buildTrustChip(name: string, amount: number, color: string, size = 30): HTMLElement | null {
  if (!(amount > 0)) return null;
  const chip = el('div', { cls: 'item-chip currency-chip ms-trust-chip' });
  chip.style.setProperty('--chip-size', `${size}px`);
  chip.style.setProperty('--cy', color);
  chip.style.setProperty('--rc', color);
  chip.style.setProperty('--ic', color);
  /* 2026-09-17 (user's bug report 「신뢰도 보상 썸네일에 툴팁이 없다」): the game hover card instead of a native title (`ui/hud/ItemTip`'s text card). */
  chip.dataset.tipName = `◈ ${name} 신뢰도`;
  chip.dataset.tipSub = 'NPC 신뢰도';
  chip.dataset.tipDesc = `${name} 개인이 대원을 얼마나 믿는가. 퀘스트를 완료하면 +${fmt(amount)} 오른다. 기업 신뢰도와는 따로 쌓인다.`;
  chip.dataset.tipColor = color;
  const thumb = el('div', { cls: 'item-chip-thumb currency-thumb', parent: chip });
  el('span', { cls: 'item-chip-icon', text: '◈', parent: thumb });
  const count = el('div', { cls: 'item-chip-count', parent: thumb });
  el('span', { cls: 'item-chip-have', text: `+${fmt(amount)}`, parent: count });
  return chip;
}

/* ── 2026-09-21: player ↔ player trust (`ctx.net.trust`, `shared/playerTrust.ts`) ─────────────────────────────── */

/** The one hover line of a player pair — `신뢰도 Lv.2 · 75 / 130`. */
export function playerTrustTitle(name: string, t: PlayerTrustInfo): string {
  const span = t.next === null ? `${fmt(t.points)} · 최고 등급` : `${fmt(t.points)} / ${fmt(t.next)}`;
  return `${name ? `${name} 님과의 ` : ''}신뢰도 Lv.${t.level} · ${span}`;
}

/**
 * **Player trust** drawn exactly like NPC trust (`Lv.n [gauge]`, the same `.ms-trust` look) — for a friend / recent-player
 * card in the 친구 tab. The value is the relay's pair value (`ctx.net.trust.get`); null without a net system (the caller
 * leaves the spot empty). A pair that never played reads `Lv.0` with an empty gauge — that is information too.
 */
export function buildPlayerTrust(ctx: GameContext, code: PlayerCode, name: string): HTMLElement | null {
  const ref = ctx.net?.trust;
  if (!ref || !code) return null;
  let t: PlayerTrustInfo;
  try { t = ref.get(code); } catch { return null; }
  const wrap = el('span', { cls: 'ms-trust in-card' });
  wrap.title = playerTrustTitle(name, t);
  wrap.dataset.code = code;
  wrap.dataset.level = String(t.level);
  el('span', { cls: 'ms-trust-lv ui-mono', text: `신뢰 Lv.${t.level}`, parent: wrap });
  const bar = el('span', { cls: 'ms-bar ms-trust-bar', parent: wrap });
  el('i', { parent: bar }).style.transform = `scaleX(${t.frac.toFixed(3)})`;
  return wrap;
}
