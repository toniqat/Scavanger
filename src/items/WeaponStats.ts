import type { AttachmentDef, AttachmentEffects, EffectiveWeaponStats, ItemInstance, WeaponDef, WeaponGrade } from '@/shared';
import {
  SOCKET_SLOTS, WEAPON_ADS_TIME, WEAPON_DEFAULT_DURABILITY, WEAPON_GRADE_ROMAN,
  WEAPON_SWAP_TIME_PRIMARY, WEAPON_SWAP_TIME_SECONDARY, keyTable,
} from '@/shared';

/** `data/tuning.csv` — items/ 안에서만 쓰는 스칼라 (반동 · 조준 계수). */
const T = keyTable('tuning.csv');
import { ITEM_DEF_MAP } from './ItemDefs';
import { gradeOf, isUniqueWeapon, weaponClassOf } from './WeaponDefs';

/** Horizontal recoil as a fraction of the def's (vertical) recoil. */
export const RECOIL_H_RATIO = T.num('RECOIL_H_RATIO');
/** Secondaries aim in twice as fast. */
export const SECONDARY_ADS_TIME_MUL = T.num('SECONDARY_ADS_TIME_MUL');

/** Roman numeral for a grade (`3` → `III`; out-of-range → the number). */
export function gradeRoman(grade: number): string {
  return WEAPON_GRADE_ROMAN[grade - 1] ?? String(grade);
}

/** Bare (unsocketed) stats for a def. Damage / magSize / spreads / durability are already graded in the def. */
export function baseWeaponStats(def: WeaponDef): EffectiveWeaponStats {
  const secondary = def.slot === 'secondary';
  return {
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
    adsTime: WEAPON_ADS_TIME * (secondary ? SECONDARY_ADS_TIME_MUL : 1),
    swapTime: secondary ? WEAPON_SWAP_TIME_SECONDARY : WEAPON_SWAP_TIME_PRIMARY,
    adsZoom: def.adsZoom ?? 1,
    scope: !!def.scope,
    laser: false,
    maxDurability: def.maxDurability ?? WEAPON_DEFAULT_DURABILITY,
    reloadTime: def.reloadTime,
    fireRate: def.fireRate,
  };
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
 */
export function computeWeaponStats(def: WeaponDef, inst?: ItemInstance): EffectiveWeaponStats {
  const stats = baseWeaponStats(def);
  if (isUniqueWeapon(def)) return stats;
  for (const att of socketedAttachments(inst)) applyAttachmentEffects(stats, att.effects);
  return stats;
}

/*
 * 2026-09-10 — `repairCost(def, inst)` 는 **여기서 사라졌다.** 수리비는 이제 빠진 내구도가 아니라
 * **제작 재료 × 남은 내구도 구간의 배수**이고, 무기뿐 아니라 방탄복도 같은 규칙을 탄다.
 * 구현은 `items/Salvage.ts` 의 `repairCostFor(inst)` 하나이고 `ctx.loot.getRepairCost` 가 그것을 부른다.
 * `REPAIR_SCRAP_PER` · `REPAIR_ALLOY_PER` 상수는 계약이라 `shared/constants` 에 남아 있을 뿐이다.
 */

/** Does `attachment` fit `weaponDef`? (class list and calibre list, when given). Uniques take no attachments. */
export function canAttach(weaponDef: WeaponDef, attachment: AttachmentDef): boolean {
  if (isUniqueWeapon(weaponDef)) return false;
  if (attachment.classes && !attachment.classes.includes(weaponClassOf(weaponDef))) return false;
  if (attachment.ammoTypes && !attachment.ammoTypes.includes(weaponDef.ammoType)) return false;
  return true;
}

/** Grade as a `WeaponGrade` from any number (clamped 1..5). */
export function clampGrade(g: number): WeaponGrade {
  return Math.max(1, Math.min(5, Math.round(g))) as WeaponGrade;
}
