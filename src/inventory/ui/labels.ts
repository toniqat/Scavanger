import type { AmmoType, EffectiveWeaponStats, ImplantMode, ItemDef, LoadoutSlot, WeaponDef, WeightState } from '@/shared';
import { Keys, WEAPON_GRADE_ROMAN, WEIGHT_STATE_LABEL_KO, keyLabel } from '@/shared';
import { AMMO_LABEL_KO, CATEGORY_LABEL_KO, RARITY_COLORS, RARITY_LABEL_KO, WEAPON_CLASS_LABEL_KO, getTierLabel, weaponClassOf } from '@/items';

export const CELL = 54;   // px
export const GAP = 2;     // px
export const STEP = CELL + GAP;

export const fmtValue = (n: number): string => `₩ ${Math.round(n).toLocaleString('ko-KR')}`;
export const categoryLabel = (def: ItemDef): string => CATEGORY_LABEL_KO[def.category];
export const rarityLabel = (def: ItemDef): string => RARITY_LABEL_KO[def.rarity];
export const rarityColor = (def: ItemDef): string => RARITY_COLORS[def.rarity];
export const ammoLabel = (w: WeaponDef): string => AMMO_LABEL_KO[w.ammoType];
export const ammoTypeLabel = (t: AmmoType): string => AMMO_LABEL_KO[t];
export const weaponClassLabel = (w: WeaponDef): string => WEAPON_CLASS_LABEL_KO[weaponClassOf(w)];
export const gradeLabel = (s: EffectiveWeaponStats): string => WEAPON_GRADE_ROMAN[s.grade - 1] ?? String(s.grade);
/** Effective range: where damage starts to fall off, or the max range when the weapon has no falloff. */
export const effectiveRange = (w: WeaponDef): number => w.falloffStart ?? w.range;
export const tierTitle = (tier: number): string => getTierLabel(tier);
/** Radians → degrees with two decimals (recoil display). */
export const fmtDeg = (rad: number): string => `${(rad * 180 / Math.PI).toFixed(2)}°`;
/** Percentage change of a multiplier (`0.75` → `−25 %`). */
export const fmtMul = (m: number): string => `${m < 1 ? '−' : '+'}${Math.round(Math.abs(1 - m) * 100)} %`;
/** Durability thresholds shared by tiles / tooltip. */
export const DURABILITY_LOW = 0.3;

export const SLOT_LABEL: Readonly<Record<LoadoutSlot, string>> = {
  primary: '주무기 I', primary2: '주무기 II', secondary: '보조무기', bag: '가방', armor: '방탄복',
};
/** @deprecated static defaults — use `slotKeyLabel(slot)` (follows the live bindings). */
export const SLOT_KEY: Readonly<Record<LoadoutSlot, string>> = { primary: '1', primary2: '2', secondary: '3', bag: '', armor: '' };
/** Live key label of a weapon slot ('' for bag / armor). */
export function slotKeyLabel(slot: LoadoutSlot): string {
  if (slot === 'primary') return keyLabel(Keys.PRIMARY);
  if (slot === 'primary2') return keyLabel(Keys.PRIMARY2);
  if (slot === 'secondary') return keyLabel(Keys.SECONDARY);
  return '';
}
/* appended: tactical kit */
export const fmtKg = (n: number): string => `${n.toFixed(1)} kg`;
export const weightLabel = (state: WeightState): string => WEIGHT_STATE_LABEL_KO[state] ?? state;
export const fmtSeconds = (n: number): string => `${n.toFixed(1)} s`;
/** Wheel direction glyphs by quick-slot index (N, NE, E, SE, S, SW, W, NW). */
export const QUICK_DIR_GLYPH: readonly string[] = ['▲', '◥', '►', '◢', '▼', '◣', '◄', '◤'];
/** DOM order of the 3×3 compass rose (row-major, -1 = centre). */
export const QUICK_ROSE_ORDER: readonly number[] = [7, 0, 1, 6, -1, 2, 5, 4, 3];

export const TEXT = {
  bag: '가방',
  equipment: '장비',
  emptySlot: '비어 있음',
  takeAll: '모두 가져가기',
  value: '가치',
  quickSlots: '퀵슬롯',
  hintRotate: '회전',
  hintDrop: '버리기',
  /* hub screen (2026-09-06) */
  stash: '함선 창고',
  stashHint: '가방 ↔ 창고: 드래그 또는 우클릭. 창고는 함선에 보관되어 임무·사망 후에도 유지됩니다.',
  tabs: { inventory: '인벤토리', character: '캐릭터', corp: '기업', corpSoon: '기업 · 계약 · 퀘스트는 준비 중입니다' },
  implant: {
    slot: '전술 임플란트',
    empty: '비어 있음 · 클릭해 장착',
    unavailable: '사용 불가',
    clickHint: '클릭: 임플란트 교체',
    raidLocked: '임무 중에는 임플란트를 교체할 수 없습니다',
    equipped: '장착',
    unequipped: '임플란트를 해제했습니다',
    cooldown: '쿨타임',
    charges: '충전',
    mode: { instant: '즉시', hold: '홀드', wielded: '장비형' } as Readonly<Record<ImplantMode, string>>,
  },
  quick: {
    title: '퀵슬롯',
    eyebrow: 'QUICK USE',
    hint: '스팀·수류탄·가젯을 끌어다 놓기',
    holdHint: (key: string): string => `${key} 길게 눌러 휠 열기`,
    locked: '가방 등급이 낮아 잠김',
    empty: '비어 있음',
  },
  dropZone: '버리기',
  dropZoneHint: '여기에 놓으면 아이템을 바닥에 버립니다',
  menu: {
    equip: '장착',
    equipPrimary2: '주무기 II로 장착',
    toBag: '가방으로 이동',
    toContainer: '상자로 이동',
    toStash: '창고로 이동',
    repair: '수리',
    repairShort: '재료 부족',
    repairShortMsg: '수리 재료가 부족합니다',
    repairFail: '수리할 수 없습니다',
    unload: '장전된 탄약 모두 탈착',
    detachAll: '무기 소켓 모두 탈착',
    splitHalf: '절반 나누기',
    splitOne: '하나 나누기',
    splitCustom: '수량 지정…',
    requestAmmo: '탄약 요청',
    request: '요청',
    quickAssign: '빠른 슬롯에 등록',
    quickClear: '빠른 슬롯 해제',
    drop: '버리기',
    dropOne: '하나 버리기',
  },
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
    damage: '대미지', fireRate: '연사', magSize: '탄창', loaded: '장전',
    reload: '재장전', ammo: '탄종', range: '사거리', mode: '발사 모드',
    weaponClass: '종류', grade: '등급', effectiveRange: '유효 사거리', zoom: '배율',
    recoil: '반동', adsTime: '정조준 시간', durability: '내구도', sockets: '소켓',
  },
  attachmentStats: {
    socket: '소켓', fits: '호환', all: '모든 무기', recoilV: '수직 반동', recoilH: '수평 반동', spread: '탄 퍼짐',
    hipSpread: '지향 사격 퍼짐', adsTime: '정조준 시간', magSize: '장탄수', zoom: '배율', scope: '스코프', laser: '레이저',
  },
  bagStats: { grid: '칸', quickSlots: '퀵슬롯', tactical: '전술형' },
  /* appended: tactical kit */
  weight: '무게',
  armorStats: { dr: '피해 감소', durability: '내구도', perk: '특성' },
  craft: '제작',
  craftPanel: '필드 제작',
  craftNone: '지금 만들 수 있는 레시피가 없습니다',
  craftHold: '길게 눌러 제작',
  craftMaking: '제작 중…',
  craftStationShip: '함선 작업대',
  craftStationField: '야전 제작',
  socketEmpty: '비어 있음',
  broken: '고장',
  auto: '자동', semi: '반자동', pellets: '펠릿',
} as const;

/** Pixel size of a w×h-cell tile. */
export const tileSize = (w: number, h: number): { width: number; height: number } => ({
  width: w * STEP - GAP,
  height: h * STEP - GAP,
});
