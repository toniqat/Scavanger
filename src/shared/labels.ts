import type { EnvKind, ItemCategory, Rarity, SoilTag, WeaponGrade } from './types';

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
  primary: '주무기', secondary: '보조무기', grenade: '수류탄', stim: '회복약',
  ammo: '탄약', valuable: '귀중품', material: '재료',
  attachment: '부착물', bag: '가방',
  armor: '방탄복', gadget: '가젯', herb: '약초',
  furniture: '가구',
  seed: '씨앗',
  book: '서적',
  implant: '임플란트',
  soil: '토양',
  crop: '작물',
  sample: '표본',
  prep: '준비물',
};

/** Accent colour per category (panel chips, quick bar, map icons). */
export const CATEGORY_COLOR: Readonly<Record<ItemCategory, string>> = {
  primary: '#ffd27a', secondary: '#ffe3a0', grenade: '#ff8f5c', stim: '#6ee7a8',
  ammo: '#c8ccd2', valuable: '#7fd2ff', material: '#b0a58c', attachment: '#d0c4ff', bag: '#d9b98a',
  armor: '#9fb4ff', gadget: '#8fe8ff', herb: '#7ee08a',
  furniture: '#e0c9a6',
  seed: '#c8e08a',
  book: '#c9a77a',
  implant: '#e39cff',
  soil: '#a98868',
  crop: '#9fd86a',
  sample: '#a9d8ff',
  prep: '#ffd08a',
};

/** Short glyph per category (used where an item has none, e.g. empty quick slots). */
export const CATEGORY_ICON: Readonly<Record<ItemCategory, string>> = {
  primary: '⌐╦', secondary: '⌐', grenade: '●', stim: '✚',
  ammo: '▮▮', valuable: '◆', material: '▫', attachment: '⊙', bag: '▣',
  armor: '⛊', gadget: '◈', herb: '❦',
  furniture: '⌂',
  seed: '⁘',
  book: '▤',
  implant: '⬡',
  soil: '▩',
  crop: '❁',
  sample: '◍',
  prep: '⌾',
};

/**
 * appended (온실 개편, 2026-09-11): 토양 속성의 이름과 색. 재배 화면의 흙 원, 토양 아이템 툴팁, 씨앗 툴팁의
 * 「맞는 토양」 줄이 모두 이 표 하나를 읽는다 — CLAUDE.md 의 「같은 것을 두 폴더가 쓰면 shared 로 뽑는다」 그대로다.
 */
export const SOIL_TAG_LABEL_KO: Readonly<Record<SoilTag, string>> = {
  ash: '화산재', frost: '동토', humus: '부엽토', mineral: '광물',
  /* appended (품종 확장 A-11, 2026-09-11) */
  saline: '염류', spore: '포자',
};
/** 흙이 채워진 모습을 그리는 색 (재배 화면의 원 안, 80 % 높이까지 찬다). */
export const SOIL_TAG_COLOR: Readonly<Record<SoilTag, string>> = {
  ash: '#6b625c', frost: '#7d8fa0', humus: '#5c4433', mineral: '#8a6a58',
  saline: '#b9b0a0', spore: '#6e7a52',
};

/**
 * appended (연구실 A-13, 2026-09-11): 행성 상시 환경의 이름 · 색 · 글리프. 행성 터미널의 브리핑 줄, 출격 경고,
 * 레이드 HUD 의 환경 배지, 준비물 아이템 툴팁이 **이 표 하나**를 읽는다.
 */
export const ENV_LABEL_KO: Readonly<Record<EnvKind, string>> = { heat: '고온', toxin: '유독' };
/** 한 줄 설명 — 「무엇이 몸을 깎는가」. 브리핑과 준비물 툴팁이 같은 문장을 쓴다. */
export const ENV_DESC_KO: Readonly<Record<EnvKind, string>> = {
  heat: '지열과 재가 체온을 올린다. 내열 준비물 없이는 체력이 계속 깎인다.',
  toxin: '대기 자체가 독하다. 방독 준비물 없이는 체력이 계속 깎인다.',
};
export const ENV_COLOR: Readonly<Record<EnvKind, string>> = { heat: '#ff8f5c', toxin: '#9fe07a' };
export const ENV_ICON: Readonly<Record<EnvKind, string>> = { heat: '♨', toxin: '☣' };
