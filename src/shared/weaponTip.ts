import type { EffectiveWeaponStats, ItemInstance, SocketSlot, WeaponDef } from './types';
import { SOCKET_LABEL_KO } from './constants';

/* ────────────────────────────────────────────────────────────────────────────
 * **One set of body text** for the weapon card (2026-09-16).
 *
 * Two cards draw a weapon's detail — the instance card of the bag grid (`inventory/ui/Tooltip`, a 2×2 gauge + socket
 * slots + a durability bar) and the floating chip card that comes up anywhere (`ui/hud/ItemTip`, a two-column table).
 * They look different, but **the numbers read and the sentences around them must be the same**: the tiles of the
 * corporation trade screen use the chip card, which had no damage · range at all, so the same gun's card differed
 * between the bag and the sales desk (user's bug, 2026-09-16).
 *
 * So **the values and the sentences are made in this one file** and the two cards only paint them with their own markup
 * (§4.1 — the same formula in two folders moves to `src/shared`). Whether to draw a gauge or a table row is the card's
 * choice, so it is an option.
 *
 * `AMMO_LABEL_KO` lives in `@/items` and `@/shared` does not import `@/items`, so the ammo type's name is handed over as
 * a string by the caller (`ammoLabel`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The weapon card's row names — both cards use the same words (the same text as `inventory/ui/labels.TEXT.weaponStats`). */
export const WEAPON_TIP_LABEL_KO = {
  damage: '대미지', fireRate: '연사', recoil: '반동', range: '사거리',
  ammo: '탄종', loaded: '장전', mode: '발사 모드', zoom: '배율',
  durability: '내구도', sockets: '소켓',
  auto: '자동', semi: '반자동', scope: '스코프', broken: '파손', socketNone: '없음',
} as const;

/** The effective range — the distance where damage starts to drop, or the maximum range for a weapon with no falloff. */
export const weaponEffectiveRange = (w: WeaponDef): number => w.falloffStart ?? w.range;

/** Recoil radians → `1.20°` (two decimal places). */
export const weaponRecoilText = (rad: number): string => `${(rad * 180 / Math.PI).toFixed(2)}°`;

/** The **values** of the four gauges (`damage` is one shot's total with the pellets multiplied in, `recoil` is radians, `range` is m). */
export interface WeaponGaugeValues { damage: number; fireRate: number; recoil: number; range: number }

export function weaponGaugeValues(weapon: WeaponDef, s: EffectiveWeaponStats): WeaponGaugeValues {
  return {
    damage: s.damage * (weapon.pellets ?? 1),
    fireRate: s.fireRate,
    recoil: s.recoilV,
    range: weaponEffectiveRange(weapon),
  };
}

/** The **text** of the four gauges (a shotgun reads `24×8`). The small number next to a gauge and a table row's value must be the same sentence. */
export function weaponGaugeTexts(weapon: WeaponDef, s: EffectiveWeaponStats): Record<keyof WeaponGaugeValues, string> {
  const pellets = weapon.pellets ?? 1;
  return {
    damage: pellets > 1 ? `${s.damage}×${pellets}` : `${s.damage}`,
    fireRate: `${s.fireRate} /s`,
    recoil: weaponRecoilText(s.recoilV),
    range: `${weaponEffectiveRange(weapon)} m`,
  };
}

export interface WeaponTipRow { k: string; v: string }

export interface WeaponTipRowOptions {
  /** The hovered instance — the loaded rounds · the durability left · the fitted attachments are read from it. With none, the card knows only the def. */
  item?: ItemInstance | null;
  /** The Korean name of the ammo type (`AMMO_LABEL_KO` in `@/items`). Without it there is no ammo row (the grid card draws a thumbnail instead). */
  ammoLabel?: string;
  /** Damage · fire rate · recoil · range as table rows too (false for the grid card, which draws gauge bars). */
  gauges?: boolean;
  /** The durability row (false for the grid card, which draws a full-width gauge). */
  durability?: boolean;
  /** The socket row (false for the grid card, which draws a row of square slots). */
  sockets?: boolean;
  /** An attachment def id → its name. Without it, only the socket names are written instead of the fitted attachment names. */
  attachmentName?: (defId: string) => string | undefined;
}

/**
 * The weapon card's table rows. The order is the same on both cards — the four gauges → ammo → loaded → fire mode → zoom
 * → durability → sockets. A unique with no magazine like 「롱혼」 drops the loaded row (it nocks the arrows it carries one
 * at a time — `1 / 1` would be a lie).
 */
export function weaponTipRows(weapon: WeaponDef, stats: EffectiveWeaponStats, opts: WeaponTipRowOptions = {}): WeaponTipRow[] {
  const L = WEAPON_TIP_LABEL_KO;
  const rows: WeaponTipRow[] = [];
  if (opts.gauges) {
    const t = weaponGaugeTexts(weapon, stats);
    rows.push({ k: L.damage, v: t.damage }, { k: L.fireRate, v: t.fireRate }, { k: L.recoil, v: t.recoil }, { k: L.range, v: t.range });
  }
  if (opts.ammoLabel) rows.push({ k: L.ammo, v: opts.ammoLabel });
  const item = opts.item ?? null;
  if (weapon.unique !== 'bow') {
    rows.push({ k: L.loaded, v: item ? `${Math.max(0, item.ammoInMag ?? 0)} / ${stats.magSize}` : `${stats.magSize}` });
  }
  rows.push({ k: L.mode, v: weapon.automatic ? L.auto : L.semi });
  if (stats.adsZoom > 1 || stats.scope) rows.push({ k: L.zoom, v: `${stats.adsZoom}×${stats.scope ? ` · ${L.scope}` : ''}` });
  if (opts.durability) {
    const max = Math.max(1, stats.maxDurability);
    const cur = item ? Math.round(Math.max(0, Math.min(max, item.durability ?? max))) : null;
    rows.push({ k: L.durability, v: cur === null ? `최대 ${max}` : cur <= 0 ? `${L.broken} · 0 / ${max}` : `${cur} / ${max}` });
  }
  if (opts.sockets) {
    const text = weaponSocketText(stats, item, opts.attachmentName);
    if (text) rows.push({ k: L.sockets, v: text });
  }
  return rows;
}

/**
 * The one row of accepted sockets — `총구(소음기) · 조준경 · 개머리판`. Which slots are accepted is decided by
 * `stats.sockets` alone (the `sockets` column of the weapon table), and a fitted attachment's name is appended in
 * brackets. A unique with no accepted slots gives an empty string.
 */
export function weaponSocketText(
  stats: EffectiveWeaponStats, item?: ItemInstance | null, attachmentName?: (defId: string) => string | undefined,
): string {
  const slots: readonly SocketSlot[] = stats.sockets ?? [];
  if (slots.length === 0) return '';
  return slots.map((s) => {
    const att = item?.sockets?.[s];
    const name = att ? (attachmentName?.(att.defId) ?? att.defId) : '';
    return name ? `${SOCKET_LABEL_KO[s]}(${name})` : SOCKET_LABEL_KO[s];
  }).join(' · ');
}
