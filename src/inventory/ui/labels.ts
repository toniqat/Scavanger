import type { ItemDef, WeaponDef, WeightState } from '@/shared';
import { WEIGHT_STATE_LABEL_KO } from '@/shared';
import { AMMO_LABEL_KO, CATEGORY_LABEL_KO, RARITY_COLORS, RARITY_LABEL_KO, WEAPON_CLASS_LABEL_KO, getTierLabel, weaponClassOf } from '@/items';

export const CELL = 54;   // px
export const GAP = 2;     // px
export const STEP = CELL + GAP;

export const fmtValue = (n: number): string => `₩ ${Math.round(n).toLocaleString('ko-KR')}`;
export const categoryLabel = (def: ItemDef): string => CATEGORY_LABEL_KO[def.category];
export const rarityLabel = (def: ItemDef): string => RARITY_LABEL_KO[def.rarity];
export const rarityColor = (def: ItemDef): string => RARITY_COLORS[def.rarity];
export const ammoLabel = (w: WeaponDef): string => AMMO_LABEL_KO[w.ammoType];
export const weaponClassLabel = (w: WeaponDef): string => WEAPON_CLASS_LABEL_KO[weaponClassOf(w)];
/** Effective range: where damage starts to fall off, or the max range when the weapon has no falloff. */
export const effectiveRange = (w: WeaponDef): number => w.falloffStart ?? w.range;
export const tierTitle = (tier: number): string => getTierLabel(tier);

/** kg formatter used by the weight bar and tooltips. */
export const fmtKg = (n: number): string => `${n.toFixed(1)} kg`;
export const weightLabel = (state: WeightState): string => WEIGHT_STATE_LABEL_KO[state] ?? state;
export const fmtSeconds = (n: number): string => `${n.toFixed(1)} s`;

export const TEXT = {
  bag: '가방',
  equipment: '장비',
  primary: '주무기',
  secondary: '보조무기',
  armor: '방탄복',
  backpack: '가방',
  emptySlot: '비어 있음',
  takeAll: '모두 가져가기',
  value: '가치',
  weight: '무게',
  quickBar: '빠른 사용',
  quickHint: '빠른 사용 슬롯으로 드래그',
  craft: '제작',
  craftPanel: '필드 제작',
  craftHold: '길게 눌러 제작',
  craftMaking: '제작 중…',
  craftNone: '지금 만들 수 있는 레시피가 없습니다',
  craftStationField: '야전',
  craftStationShip: '함선 작업대',
  durability: '내구도',
  broken: '파손',
  repair: '수리',
  searching: '감정 중…',
  hidden: '???',
  hints: [
    ['R', '회전'], ['우클릭', '빠른 이동/메뉴'], ['Shift+드래그', '절반'], ['Ctrl+드래그', '하나'],
    ['X', '버리기'], ['휠클릭', '요청'],
  ] as const,
  dropZone: '버리기',
  dropZoneHint: '여기에 놓으면 아이템을 바닥에 버립니다',
  menu: {
    equip: '장착',
    toBag: '가방으로 이동',
    toContainer: '상자로 이동',
    splitHalf: '절반 나누기',
    splitOne: '하나 나누기',
    splitCustom: '수량 지정…',
    requestAmmo: '탄약 요청',
    request: '요청',
    drop: '버리기',
    dropOne: '하나 버리기',
    quickAssign: '빠른 사용에 등록',
    quickClear: '빠른 사용에서 해제',
    repair: '수리 (함선)',
  },
  gear: {
    damageReduction: '피해 감소',
    perk: '특수',
    grid: '가방 칸',
    quickSlots: '빠른 사용',
    capacity: '적재 보너스',
    tier: '등급',
  },
  armorPerk: {
    none: '없음',
    regen: '스태미나 최대치일 때 초당 체력 회복',
    ultralight: '스태미나 회복 · 이동속도 증가',
    optical: '상시 은폐',
  } as Record<string, string>,
  backpackPerk: {
    none: '없음',
    tactical: '빠른 사용 8칸 · 무기 교체 50 % 단축 · 공중 호버',
    special: '임플란트 쿨타임 50 % 감소',
    jump: '공중 재점프로 전방 돌진',
  } as Record<string, string>,
  split: {
    title: '수량 지정',
    keep: '남김',
    take: '나눔',
    confirm: '확인',
    cancel: '취소',
  },
  size: '크기',
  qty: '수량',
  weaponStats: {
    damage: '피해', fireRate: '연사', magSize: '탄창', reserve: '예비 탄창',
    reload: '재장전', ammo: '탄종', range: '사거리', mode: '발사 모드',
    weaponClass: '종류', effectiveRange: '유효 사거리', zoom: '배율',
  },
  auto: '자동', semi: '반자동', pellets: '펠릿',
} as const;

/** Pixel size of a w×h-cell tile. */
export const tileSize = (w: number, h: number): { width: number; height: number } => ({
  width: w * STEP - GAP,
  height: h * STEP - GAP,
});
