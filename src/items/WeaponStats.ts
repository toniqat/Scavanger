import type { AttachmentDef, AttachmentEffects, EffectiveWeaponStats, ItemInstance, SocketSlot, WeaponDef, WeaponGrade } from '@/shared';
import {
  SOCKET_SLOTS, WEAPON_ADS_TIME, WEAPON_DEFAULT_DURABILITY, WEAPON_GRADE_ROMAN,
  WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY, keyTable,
} from '@/shared';

/** `data/tuning.csv` — the scalars used only inside items/ (recoil · aim coefficients). */
const T = keyTable('tuning.csv');
import { ITEM_DEF_MAP } from './ItemDefs';
import { damageFalloff, gradeOf, isUniqueWeapon, weaponClassOf, weaponFamilyTuning, weaponHandlingMul } from './WeaponDefs';

/** Horizontal recoil as a fraction of the def's (vertical) recoil. */
export const RECOIL_H_RATIO = T.num('RECOIL_H_RATIO');
/** Secondaries aim in twice as fast. */
export const SECONDARY_ADS_TIME_MUL = T.num('SECONDARY_ADS_TIME_MUL');
/** 2026-09-14: sustained-fire bloom of a weapon without a family row (the uniques). Graded families use `weapons.csv`. */
export const WEAPON_BLOOM_PER_SHOT_DEFAULT = T.num('WEAPON_BLOOM_PER_SHOT_DEFAULT');
export const WEAPON_BLOOM_SPREAD_DEFAULT = T.num('WEAPON_BLOOM_SPREAD_DEFAULT');
export const WEAPON_BLOOM_DECAY_DEFAULT = T.num('WEAPON_BLOOM_DECAY_DEFAULT');
/** Uniques accept no attachment. */
const NO_SOCKETS: readonly SocketSlot[] = [];

/** Roman numeral for a grade (`3` → `III`; out-of-range → the number). */
export function gradeRoman(grade: number): string {
  return WEAPON_GRADE_ROMAN[grade - 1] ?? String(grade);
}

/**
 * Bare (unsocketed) stats for a def. Damage / magSize / spreads / recoil / fire rate / durability are already graded in the
 * def (`WeaponDefs.buildGrade` — spreads and recoil carry the grade handling multiplier).
 * 2026-09-14 (gun balance): ADS time comes from the family row and, like `swayMul`, takes the same grade handling
 * multiplier (`weaponHandlingMul`); bloom from the family row; `sockets` = the class list (uniques: none); falloff
 * always filled (`falloffStart === falloffEnd` with min 1 = none); `projectileSpeed` / `bulletGravity` from the def.
 */
export function baseWeaponStats(def: WeaponDef): EffectiveWeaponStats {
  const secondary = def.slot === 'secondary';
  const tune = weaponFamilyTuning(def);
  const handling = weaponHandlingMul(def);
  const hasFalloff = def.falloffStart !== undefined && def.falloffEnd !== undefined && def.falloffEnd > def.falloffStart;
  const stats: EffectiveWeaponStats = {
    weaponId: def.id,
    weaponClass: weaponClassOf(def),
    ammoType: def.ammoType,
    grade: gradeOf(def),
    damage: def.damage,
    magSize: def.magSize,
    spread: def.spread,
    adsSpread: def.adsSpread,
    recoilV: def.recoil,
    recoilH: def.recoil * RECOIL_H_RATIO,
    adsTime: (tune?.adsTime ?? WEAPON_ADS_TIME) * handling * (secondary ? SECONDARY_ADS_TIME_MUL : 1),
    swapTime: secondary ? WEAPON_SWAP_TIME_SECONDARY : WEAPON_SWAP_TIME_PRIMARY,
    adsZoom: def.adsZoom ?? 1,
    scope: !!def.scope,
    laser: false,
    maxDurability: def.maxDurability ?? WEAPON_DEFAULT_DURABILITY,
    reloadTime: def.reloadTime,
    fireRate: def.fireRate,
    sockets: isUniqueWeapon(def) ? NO_SOCKETS : (def.sockets ?? SOCKET_SLOTS),
    swayMul: handling,
    falloffStart: hasFalloff ? def.falloffStart! : def.range,
    falloffEnd: hasFalloff ? def.falloffEnd! : def.range,
    // `damageFalloff` at the end distance is the def's minimum incl. its default when `falloffMin` is blank
    falloffMin: hasFalloff ? damageFalloff(def, def.falloffEnd!) : 1,
    projectileSpeed: def.projectileSpeed ?? 0,
    bulletGravity: def.bulletGravity ?? 0,
    bloomPerShot: tune?.bloomPerShot ?? WEAPON_BLOOM_PER_SHOT_DEFAULT,
    bloomSpread: tune?.bloomSpread ?? WEAPON_BLOOM_SPREAD_DEFAULT,
    bloomDecay: tune?.bloomDecay ?? WEAPON_BLOOM_DECAY_DEFAULT,
  };
  return stats;
}

/** Fold one attachment's effects into `stats` (mutates). Multipliers multiply; overrides replace. */
export function applyAttachmentEffects(stats: EffectiveWeaponStats, fx: AttachmentEffects): EffectiveWeaponStats {
  if (fx.recoilV !== undefined) stats.recoilV *= fx.recoilV;
  if (fx.recoilH !== undefined) stats.recoilH *= fx.recoilH;
  if (fx.spread !== undefined) { stats.spread *= fx.spread; stats.adsSpread *= fx.spread; }
  if (fx.hipSpread !== undefined) stats.spread *= fx.hipSpread;
  if (fx.adsTime !== undefined) stats.adsTime *= fx.adsTime;
  if (fx.magSize !== undefined) stats.magSize = Math.max(1, Math.round(stats.magSize * fx.magSize));
  if (fx.adsZoom !== undefined) stats.adsZoom = fx.adsZoom;
  if (fx.scope !== undefined) stats.scope = fx.scope;
  if (fx.laser !== undefined) stats.laser = fx.laser;
  // 2026-09-14 (gun balance): stock · grip sway, the falloff · bullet drop of the extended barrel (확장 총열)
  if (fx.sway !== undefined) stats.swayMul *= fx.sway;
  if (fx.falloffRange !== undefined) { stats.falloffStart *= fx.falloffRange; stats.falloffEnd *= fx.falloffRange; }
  if (fx.falloffLoss !== undefined) stats.falloffMin = 1 - (1 - stats.falloffMin) * fx.falloffLoss;
  if (fx.bulletDrop !== undefined) stats.bulletGravity *= fx.bulletDrop;
  return stats;
}

/** Attachment defs currently socketed in `inst` (socket order), skipping unknown / non-attachment items. */
export function socketedAttachments(inst: ItemInstance | undefined): AttachmentDef[] {
  const out: AttachmentDef[] = [];
  const sockets = inst?.sockets;
  if (!sockets) return out;
  for (const slot of SOCKET_SLOTS) {
    const att = sockets[slot];
    if (!att) continue;
    const def = ITEM_DEF_MAP.get(att.defId);
    if (def?.attachment) out.push(def.attachment);
  }
  return out;
}

/**
 * Graded + socketed numbers a weapon instance fires with. Starts from the def
 * (already graded), applies slot-based ADS/swap times, then folds every socketed
 * attachment in `inst.sockets`. Uniques (`WeaponDef.unique`) return the def numbers
 * untouched: no grade scaling exists for them and sockets are ignored even if an
 * instance somehow carries one.
 * 2026-09-14: an attachment the weapon no longer accepts (`canAttach` false — an old save from before the per-class
 * socket rules, or one sitting in a socket that is not its own) has **no effect**; inventory detaches it on load.
 */
export function computeWeaponStats(def: WeaponDef, inst?: ItemInstance): EffectiveWeaponStats {
  const stats = baseWeaponStats(def);
  if (isUniqueWeapon(def)) return stats;
  for (const att of fittingAttachments(def, inst)) applyAttachmentEffects(stats, att.effects);
  return stats;
}

/** 2026-09-14: socketed attachment defs of `inst` that still fit `def` (own socket + `canAttach`), in socket order. */
export function fittingAttachments(def: WeaponDef, inst: ItemInstance | undefined): AttachmentDef[] {
  const out: AttachmentDef[] = [];
  const sockets = inst?.sockets;
  if (!sockets) return out;
  for (const slot of SOCKET_SLOTS) {
    const att = sockets[slot];
    if (!att) continue;
    const a = ITEM_DEF_MAP.get(att.defId)?.attachment;
    if (a && a.socket === slot && canAttach(def, a)) out.push(a);
  }
  return out;
}

/**
 * 2026-09-14 (gun balance): damage multiplier at `distance` m from **effective stats** — the def's falloff after
 * sockets (확장 총열). ×1 up to `falloffStart`, linear down to `falloffMin` at `falloffEnd`. `damageFalloff(def, d)`
 * stays for callers that only have a def (it ignores sockets).
 */
export function damageFalloffStats(stats: Pick<EffectiveWeaponStats, 'falloffStart' | 'falloffEnd' | 'falloffMin'>, distance: number): number {
  const { falloffStart: start, falloffEnd: end, falloffMin: min } = stats;
  if (!(end > start) || distance <= start) return 1;
  if (distance >= end) return min;
  return 1 - ((distance - start) / (end - start)) * (1 - min);
}

/**
 * Does `attachment` fit `weaponDef`? The class must have that socket (2026-09-14 — `WeaponDef.sockets`, `data/weapons.csv`:
 * SG = muzzle · mag · sight …), then the class list and calibre list when given. Uniques take no attachments.
 */
export function canAttach(weaponDef: WeaponDef, attachment: AttachmentDef): boolean {
  if (isUniqueWeapon(weaponDef)) return false;
  if (!(weaponDef.sockets ?? SOCKET_SLOTS).includes(attachment.socket)) return false;
  if (attachment.classes && !attachment.classes.includes(weaponClassOf(weaponDef))) return false;
  if (attachment.ammoTypes && !attachment.ammoTypes.includes(weaponDef.ammoType)) return false;
  return true;
}

/** Grade as a `WeaponGrade` from any number (clamped 1..5). */
export function clampGrade(g: number): WeaponGrade {
  return Math.max(1, Math.min(5, Math.round(g))) as WeaponGrade;
}
