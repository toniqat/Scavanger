import type { ItemCategory, Rarity, WeaponGrade } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Item rarity / category labels and palette (Phase 7, 2026-09-06).
 * Moved here from items/ItemDefs.ts (which re-exports them) so meta/, ui/ and inventory/ can label items without
 * importing another feature folder. Data-only, like FURNITURE_DEFS / CONTRACT_GOAL_LABEL_KO.
 * ──────────────────────────────────────────────────────────────────────────── */

export const RARITY_ORDER: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const rarityRank = (r: Rarity): number => RARITY_ORDER.indexOf(r);
/** Rarity ↔ weapon grade (1 common … 5 legendary). */
export const rarityForGrade = (g: WeaponGrade): Rarity => RARITY_ORDER[g - 1];
export const gradeForRarity = (r: Rarity): WeaponGrade => (rarityRank(r) + 1) as WeaponGrade;

export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  common: '#9aa3ad',
  uncommon: '#4fd17e',
  rare: '#4aa3ff',
  epic: '#b56cff',
  legendary: '#ffb347',
};

export const RARITY_LABEL_KO: Readonly<Record<Rarity, string>> = {
  common: '일반', uncommon: '고급', rare: '희귀', epic: '서사', legendary: '전설',
};

export const CATEGORY_LABEL_KO: Readonly<Record<ItemCategory, string>> = {
  primary: '주무기', secondary: '보조무기', grenade: '수류탄', stim: '스팀',
  ammo: '탄약', valuable: '귀중품', material: '재료',
  attachment: '부착물', bag: '가방',
  armor: '방탄복', gadget: '가젯', herb: '약초',
  furniture: '가구',
  seed: '씨앗',
};

/** Accent colour per category (panel chips, quick bar, map icons). */
export const CATEGORY_COLOR: Readonly<Record<ItemCategory, string>> = {
  primary: '#ffd27a', secondary: '#ffe3a0', grenade: '#ff8f5c', stim: '#6ee7a8',
  ammo: '#c8ccd2', valuable: '#7fd2ff', material: '#b0a58c', attachment: '#d0c4ff', bag: '#d9b98a',
  armor: '#9fb4ff', gadget: '#8fe8ff', herb: '#7ee08a',
  furniture: '#e0c9a6',
  seed: '#c8e08a',
};

/** Short glyph per category (used where an item has none, e.g. empty quick slots). */
export const CATEGORY_ICON: Readonly<Record<ItemCategory, string>> = {
  primary: '⌐╦', secondary: '⌐', grenade: '●', stim: '✚',
  ammo: '▮▮', valuable: '◆', material: '▫', attachment: '⊙', bag: '▣',
  armor: '⛊', gadget: '◈', herb: '❦',
  furniture: '⌂',
  seed: '⁘',
};
