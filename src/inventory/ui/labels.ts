import type { ItemDef, WeaponDef } from '@/shared';
import { AMMO_LABEL_KO, CATEGORY_LABEL_KO, RARITY_COLORS, RARITY_LABEL_KO, getTierLabel } from '@/items';

export const CELL = 54;   // px
export const GAP = 2;     // px
export const STEP = CELL + GAP;

export const fmtValue = (n: number): string => `₩ ${Math.round(n).toLocaleString('ko-KR')}`;
export const categoryLabel = (def: ItemDef): string => CATEGORY_LABEL_KO[def.category];
export const rarityLabel = (def: ItemDef): string => RARITY_LABEL_KO[def.rarity];
export const rarityColor = (def: ItemDef): string => RARITY_COLORS[def.rarity];
export const ammoLabel = (w: WeaponDef): string => AMMO_LABEL_KO[w.ammoType];
export const tierTitle = (tier: number): string => getTierLabel(tier);

export const TEXT = {
  bag: '가방',
  equipment: '장비',
  primary: '주무기',
  secondary: '보조무기',
  emptySlot: '비어 있음',
  takeAll: '모두 가져가기',
  value: '가치',
  hints: [['R', '회전'], ['우클릭', '빠른 이동'], ['더블클릭', '장착 / 이동'], ['Tab', '닫기']] as const,
  size: '크기',
  qty: '수량',
  weaponStats: {
    damage: '피해', fireRate: '연사', magSize: '탄창', reserve: '예비 탄창',
    reload: '재장전', ammo: '탄종', range: '사거리', mode: '발사 모드',
  },
  auto: '자동', semi: '반자동', pellets: '펠릿',
} as const;

/** Pixel size of a w×h-cell tile. */
export const tileSize = (w: number, h: number): { width: number; height: number } => ({
  width: w * STEP - GAP,
  height: h * STEP - GAP,
});
