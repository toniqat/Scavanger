import type { AmmoType, ArmorDef, AttachmentDef, BagDef, ItemCategory, ItemDef, Rarity, WeaponDef, WeaponGrade } from '@/shared';
import { AMMO_STACK_ROUNDS, QUICK_USABLE_CATEGORIES, RARITY_COLORS, rarityForGrade } from '@/shared';
import { WEAPON_DEFS, gradeOf, isUniqueWeapon, weaponFamilyOf } from './WeaponDefs';
import { ARMOR_DEFS, ARMOR_ICON, armorItemSize } from './ArmorDefs';

/* ── palette / labels ─────────────────────────────────────────────────────── */
/* Phase 7 (2026-09-06): the rarity / category labels, colours, icons and order live in `src/shared/labels.ts` now so
 * meta/ and ui/ can use them without importing items/. Re-exported here so every existing `@/items` import keeps working. */
export {
  RARITY_COLORS, RARITY_ORDER, rarityRank, rarityForGrade, gradeForRarity,
  RARITY_LABEL_KO, CATEGORY_LABEL_KO, CATEGORY_COLOR, CATEGORY_ICON,
} from '@/shared';

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  light: '경량탄', medium: '준중량탄', heavy: '중량탄', shell: '산탄',
  /* legacy calibres (no def uses them) */
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
  /* unique-weapon calibres (2026-09-06) */
  fuel: '연료통', cell: '전지', shuriken: '표창', arrow: '화살', rocket: '로켓', belt: '탄띠',
};

/** v2 calibres in display order: the four graded-weapon calibres, then the six unique-weapon calibres. */
export const AMMO_TYPES_V2: readonly AmmoType[] = ['light', 'medium', 'heavy', 'shell', 'fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];
/** Calibres only a unique weapon fires (never rolled with the graded-weapon ammo). */
export const UNIQUE_AMMO_TYPES: readonly AmmoType[] = ['fuel', 'cell', 'shuriken', 'arrow', 'rocket', 'belt'];

/** Ammo item id for a calibre (`medium` → `ammo_medium`). */
export function ammoItemIdFor(ammoType: AmmoType): string {
  return `ammo_${ammoType}`;
}

/* ── weight ───────────────────────────────────────────────────────────────── */
/** kg for an ItemDef that does not declare `weight` (matches the shared contract comment). */
export const DEFAULT_ITEM_WEIGHT = 0.1;

/** Weight in kg of `qty` units of `def`. */
export function itemWeight(def: ItemDef, qty = 1): number {
  return (def.weight ?? DEFAULT_ITEM_WEIGHT) * Math.max(0, qty);
}

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── weapons (one ItemDef per WeaponDef grade) ────────────────────────────── */
interface WeaponFamilyMeta {
  width: number; height: number; icon: string; value: number; description: string;
  /** kg (tactical kit weight budget). */
  weight: number;
}
const WEAPON_FAMILY_META: Readonly<Record<string, WeaponFamilyMeta>> = {
  ar23: { width: 4, height: 2, icon: '⌐╦', value: 350, weight: 4.2, description: '슈퍼 지구 표준 돌격소총. 균형 잡힌 연사와 안정적인 반동.' },
  smg37: { width: 3, height: 2, icon: '⌐╪', value: 480, weight: 3.1, description: '경량 기관단총. 근거리 연사에 특화되었으나 거리가 멀어질수록 위력이 급감.' },
  sg8: { width: 3, height: 2, icon: '⌐═', value: 520, weight: 4.6, description: '펌프액션 산탄총. 근거리에서 압도적인 제압력.' },
  r63: { width: 4, height: 1, icon: '⌐──', value: 780, weight: 4.4, description: '반자동 지정사수 소총. 원거리 정밀 사격에 최적화.' },
  sr9: { width: 5, height: 1, icon: '⌐───', value: 950, weight: 6.8, description: '볼트액션 저격소총. 4배율 조준경. 한 발로 대부분의 벌레를 무력화하지만 장전이 느리다.' },
  las16: { width: 3, height: 2, icon: '⌐≡', value: 1250, weight: 5.5, description: '레이저 소총. 준중량탄을 플라즈마 볼트로 가속하는 에너지 무기.' },
  p2: { width: 2, height: 1, icon: '⌐', value: 140, weight: 1.1, description: '표준 지급 권총. 신뢰할 수 있는 반자동 사이드암.' },
  p19: { width: 2, height: 1, icon: '⌐╡', value: 260, weight: 1.3, description: '완전 자동 기관권총. 탄약 소모가 빠르지만 화력이 우수.' },
};
const FALLBACK_META: WeaponFamilyMeta = { width: 3, height: 2, icon: '⌐', value: 300, weight: 3.5, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = 0.6;

/* ── unique weapons (Phase 6): fixed legendary items, description names the LMB / RMB behaviour ── */
interface UniqueWeaponMeta extends WeaponFamilyMeta { rarity: Rarity }
const UNIQUE_WEAPON_META: Readonly<Record<string, UniqueWeaponMeta>> = {
  u_flame: { width: 5, height: 2, icon: '⌐♨', value: 6800, weight: 9.5, rarity: 'legendary',
    description: '연료를 태워 불길을 뿜는 화염방사기. 좌클릭: 넓은 화염 분사 (지속 피해 + 잔불). 우클릭: 길고 가는 화염 제트. 열이 쌓인 적은 전소되어 몸부림친다. 정조준 없음.' },
  u_shock: { width: 4, height: 2, icon: '⌐⚡', value: 7200, weight: 6.2, rarity: 'legendary',
    description: '테슬라 코일 전격총. 좌클릭: 시야 안 최대 4마리에게 동시에 전격 (감전·둔화). 우클릭: 충전 후 놓으면 고위력 전격탄. 정조준 없음.' },
  u_shuriken: { width: 3, height: 2, icon: '⌐✧', value: 5400, weight: 2.4, rarity: 'legendary',
    description: '팔 보호구형 표창 발사기. 좌클릭: 표창 1개. 우클릭: 부채꼴로 3개. 근접(F) 홀드 후 놓으면 스태미나 절반을 써서 넓은 용검 베기. 정조준 없음.' },
  u_bow: { width: 5, height: 2, icon: '⌐)', value: 5900, weight: 3.6, rarity: 'legendary',
    description: '컴포짓 보우. 좌클릭: 직선으로 날아가는 화살 (낙차 없음). 우클릭: 정조준 (유니크 중 유일). 저격소총보다 짧지만 지정사수소총 연사.' },
  u_bazooka: { width: 5, height: 2, icon: '⌐═▶', value: 8400, weight: 11.8, rarity: 'legendary',
    description: '해머헤드 바주카. 좌클릭: 착탄 폭발 로켓 (구조물 파괴). 우클릭: 짧은 신관으로 공중 폭발. 폭발 반경 안에 있으면 자신도 피해와 넉백을 받는다 — 공중에서 발밑을 쏘면 로켓 점프. 정조준 없음.' },
  u_minigun: { width: 5, height: 2, icon: '⌐≣', value: 7600, weight: 14.5, rarity: 'legendary',
    description: '6총열 미니건. 좌클릭 홀드: 1.2초 예열 후 초당 24발 연사, 회전 중 이동 속도 55 %. 우클릭: 예열 유지. 정조준 없음.' },
};

function weaponItemDef(w: WeaponDef): ItemDef {
  if (isUniqueWeapon(w)) {
    const meta = UNIQUE_WEAPON_META[w.id] ?? { ...FALLBACK_META, rarity: 'legendary' as const };
    return def({
      id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: meta.rarity,
      width: meta.width, height: meta.height, value: meta.value,
      icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
    });
  }
  const meta = WEAPON_FAMILY_META[weaponFamilyOf(w)] ?? FALLBACK_META;
  const grade = gradeOf(w);
  return def({
    id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: rarityForGrade(grade),
    width: meta.width, height: meta.height, value: Math.round(meta.value * (1 + WEAPON_GRADE_VALUE_STEP * (grade - 1))),
    icon: meta.icon, weaponId: w.id, description: meta.description, weight: meta.weight,
  });
}

export const WEAPON_ITEM_DEFS: readonly ItemDef[] = WEAPON_DEFS.map(weaponItemDef);

/* ── ammo v2 (qty = rounds) ───────────────────────────────────────────────── */
/** kg per round (tactical kit weight budget). */
export const AMMO_ROUND_WEIGHT: Readonly<Partial<Record<AmmoType, number>>> = {
  light: 0.012, medium: 0.02, heavy: 0.04, shell: 0.05,
  /* unique calibres: a full stack weighs 4–7 kg (fuel 200 → 4 kg, rockets 6 → 7.2 kg) */
  fuel: 0.02, cell: 0.06, shuriken: 0.07, arrow: 0.05, rocket: 1.2, belt: 0.015,
};
const ammoDef = (type: AmmoType, name: string, value: number, icon: string, description: string, rarity: Rarity = 'common'): ItemDef =>
  def({ id: ammoItemIdFor(type), name, category: 'ammo', rarity, width: 1, height: 1,
    stackMax: AMMO_STACK_ROUNDS[type], value, icon, ammoType: type, description, weight: AMMO_ROUND_WEIGHT[type] ?? 0.02 });

export const AMMO_ITEM_DEFS: readonly ItemDef[] = [
  ammoDef('light', '경량탄', 1, '▪', '기관단총·권총용 경량 탄약. 수량은 발수.'),
  ammoDef('medium', '준중량탄', 2, '▮', '돌격소총용 준중량 탄약. 수량은 발수.'),
  ammoDef('heavy', '중량탄', 3, '▬', '저격소총·지정사수소총용 중량 탄약. 수량은 발수.'),
  ammoDef('shell', '산탄', 3, '◘', '산탄총용 셸. 수량은 발수.'),
  /* unique-weapon calibres (rare: loot tables weight them by rarity, tiers 1–3 zero them out) */
  ammoDef('fuel', '연료통', 1, '⛽', '「인페르노」 화염방사기용 연료. 수량은 연료 단위 (초당 12 소모).', 'rare'),
  ammoDef('cell', '전지', 4, '▯', '「테슬라 코일」 전격총용 전지. 수량은 전지 단위.', 'rare'),
  ammoDef('shuriken', '표창', 5, '✧', '「카게」 표창 발사기용 강철 표창. 수량은 개수.', 'rare'),
  ammoDef('arrow', '화살', 4, '➶', '「롱혼」 컴포짓 보우용 카본 화살. 수량은 개수.', 'rare'),
  ammoDef('rocket', '로켓', 60, '▶', '「해머헤드」 바주카용 로켓. 수량은 발수. 한 발이 1.2 kg.', 'rare'),
  ammoDef('belt', '탄띠', 1, '≣', '「사이클론」 미니건용 연결 탄띠. 수량은 발수.', 'rare'),
];

/* ── attachments ──────────────────────────────────────────────────────────── */
const NOT_PISTOL = ['AR', 'SMG', 'SG', 'SR', 'DMR'] as const;
const attDef = (
  id: string, name: string, rarity: Rarity, value: number, icon: string, description: string, attachment: AttachmentDef,
): ItemDef => def({ id, name, category: 'attachment', rarity, width: 1, height: 1, value, icon, description, attachment, weight: 0.3 });

export const ATTACHMENT_ITEM_DEFS: readonly ItemDef[] = [
  /* muzzle */
  attDef('att_brake', '총구 제동기', 'uncommon', 180, '⊏', '총구 가스를 옆으로 분산해 수직·수평 반동을 25 % 줄인다.',
    { socket: 'muzzle', effects: { recoilV: 0.75, recoilH: 0.75 } }),
  attDef('att_comp', '보정기', 'uncommon', 180, '⊐', '탄 퍼짐을 15 % 줄이는 총구 보정기.',
    { socket: 'muzzle', effects: { spread: 0.85 } }),
  attDef('att_choke', '산탄총 초크', 'uncommon', 200, '⊓', '산탄 확산을 30 % 조여 유효 사거리를 늘린다. 산탄총 전용.',
    { socket: 'muzzle', classes: ['SG'], effects: { spread: 0.7 } }),
  /* grip */
  attDef('att_grip_angled', '앵글 그립', 'uncommon', 160, '⌊', '수평 반동을 30 % 줄이는 경사 손잡이. 권총에는 장착 불가.',
    { socket: 'grip', classes: NOT_PISTOL, effects: { recoilH: 0.7 } }),
  attDef('att_grip_vertical', '수직 그립', 'uncommon', 160, '⌋', '수직 반동을 30 % 줄이는 수직 손잡이. 권총에는 장착 불가.',
    { socket: 'grip', classes: NOT_PISTOL, effects: { recoilV: 0.7 } }),
  /* mag */
  attDef('att_mag_light', '확장형 경량 탄창', 'rare', 260, '▯', '경량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['light'], effects: { magSize: 1.4 } }),
  attDef('att_mag_medium', '확장형 준중량 탄창', 'rare', 280, '▯', '준중량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['medium'], effects: { magSize: 1.4 } }),
  attDef('att_mag_heavy', '확장형 중량 탄창', 'rare', 320, '▯', '중량탄 무기의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['heavy'], effects: { magSize: 1.4 } }),
  attDef('att_mag_shell', '확장형 산탄 탄창', 'rare', 300, '▯', '산탄총의 장탄수 40 % 증가.',
    { socket: 'mag', ammoTypes: ['shell'], effects: { magSize: 1.4 } }),
  /* stock */
  attDef('att_stock', '전술 개머리판', 'rare', 300, '⊂', '탄 퍼짐 10 % 감소, 조준 시간 25 % 단축. 권총에는 장착 불가.',
    { socket: 'stock', classes: NOT_PISTOL, effects: { spread: 0.9, adsTime: 0.75 } }),
  /* sight */
  attDef('att_laser', '레이저사이트', 'uncommon', 200, '⋅', '지향 사격 퍼짐 30 % 감소. 조준점에 레이저 도트 표시.',
    { socket: 'sight', effects: { laser: true, hipSpread: 0.7 } }),
  attDef('att_scope4', '4배 조준경', 'rare', 420, '⊙', '4배율 조준경. 조준 시 스코프 화면 전환. 권총·산탄총에는 장착 불가.',
    { socket: 'sight', classes: ['AR', 'SMG', 'SR', 'DMR'], effects: { adsZoom: 4, scope: true } }),
  attDef('att_scope6', '6배 조준경', 'epic', 700, '⊚', '6배율 조준경. 조준 시 스코프 화면 전환. 권총·산탄총에는 장착 불가.',
    { socket: 'sight', classes: ['AR', 'SMG', 'SR', 'DMR'], effects: { adsZoom: 6, scope: true } }),
  attDef('att_scope8', '8배 조준경', 'legendary', 1200, '◎', '8배율 장거리 조준경. 저격소총·지정사수소총 전용.',
    { socket: 'sight', classes: ['SR', 'DMR'], effects: { adsZoom: 8, scope: true } }),
];

/* ── bags ─────────────────────────────────────────────────────────────────── */
const bagDef = (id: string, name: string, rarity: Rarity, value: number, bag: BagDef, description: string): ItemDef =>
  def({ id, name, category: 'bag', rarity, width: 2, height: 2, value, icon: bag.tactical ? '⛶' : '▣', description, bag, weight: 1.2 + bag.cols * bag.rows * 0.02 });

export const BAG_ITEM_DEFS: readonly ItemDef[] = [
  bagDef('bag_common', '일반 가방', 'common', 120, { cols: 5, rows: 6, quickSlots: 2 }, '표준 지급 배낭. 5×6 칸, 퀵슬롯 2.'),
  bagDef('bag_uncommon', '고급 가방', 'uncommon', 260, { cols: 6, rows: 6, quickSlots: 3 }, '보강된 배낭. 6×6 칸, 퀵슬롯 3.'),
  bagDef('bag_rare', '희귀 가방', 'rare', 520, { cols: 8, rows: 6, quickSlots: 4 }, '군용 대형 배낭. 8×6 칸, 퀵슬롯 4.'),
  bagDef('bag_epic', '서사 가방', 'epic', 980, { cols: 9, rows: 6, quickSlots: 5 }, '특수부대용 배낭. 9×6 칸, 퀵슬롯 5.'),
  bagDef('bag_legendary', '전설 가방', 'legendary', 1800, { cols: 10, rows: 6, quickSlots: 6 }, '헬다이버 원정용 배낭. 10×6 칸, 퀵슬롯 6.'),
  bagDef('bag_rare_tac', '희귀 전술 가방', 'rare', 560, { cols: 7, rows: 6, quickSlots: 7, tactical: true }, '전술 조끼 일체형. 7×6 칸, 퀵슬롯 7.'),
  bagDef('bag_epic_tac', '서사 전술 가방', 'epic', 1050, { cols: 8, rows: 6, quickSlots: 8, tactical: true }, '전술 조끼 일체형. 8×6 칸, 퀵슬롯 8.'),
  bagDef('bag_legendary_tac', '전설 전술 가방', 'legendary', 1950, { cols: 9, rows: 6, quickSlots: 9, tactical: true }, '전술 조끼 일체형. 9×6 칸, 퀵슬롯 9.'),
];

/* ── armor generated from the ArmorDef table (tactical kit) ───────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height, value: Math.round(300 + a.damageReduction * 4200 + a.durabilityMax * 1.4),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,

  /* grenades */
  def({ id: 'grenade_frag', name: 'G-12 고폭 수류탄', category: 'grenade', rarity: 'common', width: 1, height: 1, stackMax: 4, value: 40, icon: '●',
    weight: 0.45, quickUsable: true,
    description: '파편 수류탄. 반경 6 m 광역 피해.' }),
  def({ id: 'grenade_incendiary', name: 'G-10 소이 수류탄', category: 'grenade', rarity: 'uncommon', width: 1, height: 1, stackMax: 4, value: 70, icon: '◉',
    weight: 0.5, quickUsable: true,
    description: '소이 수류탄. 넓은 반경에 화염 피해.' }),

  /* stims */
  def({ id: 'stim', name: '스팀', category: 'stim', rarity: 'common', width: 1, height: 1, stackMax: 3, value: 60, icon: '✚', healAmount: 50,
    weight: 0.2, quickUsable: true,
    description: '자동 주사기. 체력 50 회복.' }),
  def({ id: 'stim_advanced', name: '고급 스팀', category: 'stim', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 120, icon: '✚', healAmount: 100,
    weight: 0.25, quickUsable: true,
    description: '군용 나노 주사기. 체력 완전 회복.' }),

  /* ammo v2 */
  ...AMMO_ITEM_DEFS,

  /* attachments */
  ...ATTACHMENT_ITEM_DEFS,

  /* bags */
  ...BAG_ITEM_DEFS,

  /* valuables — value and weight are deliberately uncorrelated */
  def({ id: 'gem_quartz', name: '석영 결정', category: 'valuable', rarity: 'common', width: 1, height: 1, value: 120, icon: '◇', weight: 0.6,
    description: '흔한 광물 결정. 소량의 가치.' }),
  def({ id: 'gem_amber', name: '호박석', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 260, icon: '◆', weight: 0.35,
    description: '외계 수액이 굳어 생긴 호박. 수집가들이 찾는 물건.' }),
  def({ id: 'gem_sapphire', name: '청옥', category: 'valuable', rarity: 'rare', width: 1, height: 1, value: 620, icon: '◆', weight: 0.4,
    description: '순도 높은 청색 보석.' }),
  def({ id: 'gem_void', name: '공허석', category: 'valuable', rarity: 'epic', width: 1, height: 1, value: 1400, icon: '✦', weight: 1.9,
    description: '빛을 흡수하는 검은 결정. 손바닥만 한데 벽돌처럼 무겁다.' }),
  def({ id: 'cred_chip', name: '크레딧 칩', category: 'valuable', rarity: 'common', width: 1, height: 1, stackMax: 5, value: 90, icon: '▣', weight: 0.02,
    description: '슈퍼 크레딧이 저장된 데이터 칩.' }),
  def({ id: 'salvage_electronics', name: '회수 전자장비', category: 'valuable', rarity: 'common', width: 2, height: 1, value: 180, icon: '▤▥', weight: 3.2,
    description: '추락한 장비에서 뜯어낸 회로 기판. 방열판째로 뜯어와서 꽤 무겁다.' }),
  def({ id: 'data_core', name: '데이터 코어', category: 'valuable', rarity: 'rare', width: 2, height: 1, value: 900, icon: '▦▦', weight: 1.2,
    description: '전초기지 기록이 담긴 저장 코어.' }),
  def({ id: 'data_core_encrypted', name: '암호화 데이터 코어', category: 'valuable', rarity: 'epic', width: 2, height: 1, value: 2100, icon: '▩▩', weight: 1.4,
    description: '군 등급 암호화가 걸린 코어. 정보부가 고가에 매입.' }),
  def({ id: 'sample_canister', name: '샘플 캐니스터', category: 'valuable', rarity: 'uncommon', width: 3, height: 1, value: 480, icon: '▭▭▭', weight: 2.6,
    description: '터미니드 조직 샘플이 봉인된 용기.' }),
  def({ id: 'sample_canister_pure', name: '정제 샘플 캐니스터', category: 'valuable', rarity: 'rare', width: 3, height: 1, value: 1100, icon: '▭▭▭', weight: 2.8,
    description: '고순도 외계 생체 샘플. 연구부의 최우선 회수 대상.' }),
  def({ id: 'terminid_gland', name: '터미니드 분비선', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 300, icon: '❂', weight: 0.9,
    description: '페로몬을 분비하는 기관. 생화학 연구용.' }),
  def({ id: 'alien_artifact', name: '외계 유물', category: 'valuable', rarity: 'epic', width: 2, height: 2, value: 3200, icon: '⬡', weight: 6.5,
    description: '알 수 없는 문자가 새겨진 금속 조각. 미약하게 진동한다.' }),
  def({ id: 'alien_relic', name: '고대 성유물', category: 'valuable', rarity: 'legendary', width: 2, height: 2, value: 7500, icon: '✧', weight: 9.0,
    description: '선행 문명의 유물. 측정 불가한 에너지를 방출한다. 들고 뛰기엔 너무 무겁다.' }),
  def({ id: 'super_earth_medal', name: '슈퍼 지구 훈장', category: 'valuable', rarity: 'legendary', width: 1, height: 1, value: 4800, icon: '★', weight: 0.15,
    description: '전사한 헬다이버의 훈장. 깃털처럼 가볍고 값은 어마어마하다.' }),

  /* materials */
  def({ id: 'mat_scrap', name: '폐금속', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 15, icon: '▫', weight: 0.5,
    description: '재활용 가능한 금속 조각. 무기 수리에 사용.' }),
  def({ id: 'mat_bio_sample', name: '생체 조직', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 20, icon: '⁂', weight: 0.2,
    description: '터미니드 사체에서 채취한 조직.' }),
  def({ id: 'mat_alloy', name: '합금 판', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 40, icon: '▪', weight: 0.8,
    description: '경량 고강도 합금. 고등급 무기 수리에 사용.' }),
  def({ id: 'mat_power_cell', name: '파워 셀', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 85, icon: '⚡', weight: 1.1,
    description: '충전된 소형 전력 셀.' }),
  def({ id: 'mat_gunpowder', name: '화약', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 20, value: 12, icon: '⋆', weight: 0.05,
    description: '탄약을 분해해 얻는 추진제. 원하는 탄종으로 다시 만들 수 있다.' }),
  /* ship housing (Phase 6): facility / furniture costs */
  def({ id: 'mat_cable', name: '전력 케이블', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 25, icon: '∿', weight: 0.3,
    description: '피복이 벗겨진 전력 케이블 뭉치. 함선 시설과 작업대 설치에 쓰인다.' }),
  def({ id: 'mat_circuit', name: '회로 기판', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 120, icon: '▦', weight: 0.15,
    description: '멀쩡히 남은 제어 회로 기판. 함선 시설·작업대 업그레이드에 필수.' }),

  /* herbs (gathered from world plants) */
  def({ id: 'herb_bloodroot', name: '혈근초', category: 'herb', rarity: 'common', width: 1, height: 1, stackMax: 8, value: 25, icon: '❦', weight: 0.08,
    description: '붉은 뿌리를 가진 지혈 식물. 스팀 조제의 기본 재료.' }),
  def({ id: 'herb_ashleaf', name: '잿빛잎', category: 'herb', rarity: 'uncommon', width: 1, height: 1, stackMax: 8, value: 55, icon: '❧', weight: 0.06,
    description: '화산재 지대에서 자라는 잎. 인화성이 강해 소이 제조에도 쓰인다.' }),
  def({ id: 'herb_glowcap', name: '발광버섯', category: 'herb', rarity: 'rare', width: 1, height: 1, stackMax: 6, value: 140, icon: '✿', weight: 0.12,
    description: '스스로 빛나는 균류. 강력한 재생 촉진제.' }),

  /* gadgets (behaviour lives in src/gadgets; here they are just consumables) */
  def({ id: 'gad_cloak_veil', name: '은폐 장막', category: 'gadget', rarity: 'rare', width: 1, height: 2, stackMax: 2, value: 620, icon: '◌',
    gadgetId: 'cloakVeil', weight: 1.1, quickUsable: true,
    description: '주변 아군까지 함께 은폐시키는 광학 장막. 12초.' }),
  def({ id: 'gad_dome_shield', name: '돔 실드', category: 'gadget', rarity: 'epic', width: 2, height: 2, stackMax: 1, value: 1350, icon: '⌓',
    gadgetId: 'domeShield', weight: 5.8, quickUsable: true,
    description: '던진 자리에 돔형 방어막을 전개한다. 내구도 1000.' }),
  def({ id: 'gad_barricade', name: '바리케이드', category: 'gadget', rarity: 'rare', width: 2, height: 2, stackMax: 1, value: 700, icon: '▥',
    gadgetId: 'barricade', weight: 7.2, quickUsable: true,
    description: '정면에 거대한 차폐물을 세운다. 누구나 3초 만에 회수할 수 있다.' }),
  def({ id: 'gad_lure', name: '유인 수류탄', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 180, icon: '☄',
    gadgetId: 'lureGrenade', weight: 0.5, quickUsable: true,
    description: '요란한 소음으로 벌레 떼의 시선을 끈다.' }),
  def({ id: 'gad_smoke', name: '연막탄', category: 'gadget', rarity: 'common', width: 1, height: 1, stackMax: 3, value: 110, icon: '☁',
    gadgetId: 'smokeGrenade', weight: 0.55, quickUsable: true,
    description: '시야를 가리는 연막. 안에서 쏘면 대충 그 방향으로 응사당한다.' }),
  def({ id: 'gad_mine', name: '지뢰', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 4, value: 240, icon: '◎',
    gadgetId: 'mine', weight: 1.1, quickUsable: true,
    description: '3초 후 활성화. 피아를 가리지 않는다. 작지만 묵직하다.' }),
  def({ id: 'gad_turret', name: '포탑 설치', category: 'gadget', rarity: 'epic', width: 2, height: 2, stackMax: 1, value: 1600, icon: '⚙',
    gadgetId: 'turret', weight: 9.5, quickUsable: true,
    description: '자동 조준 포탑. 사이에 낀 아군도 맞는다. 회수 가능.' }),
  def({ id: 'gad_incendiary', name: '화염수류탄', category: 'gadget', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 210, icon: '♨',
    gadgetId: 'incendiary', weight: 0.6, quickUsable: true,
    description: '착탄점에 10초간 화염지대를 만든다. 피아 구분 없음.' }),
  def({ id: 'gad_defib', name: '제세동기', category: 'gadget', rarity: 'rare', width: 2, height: 1, stackMax: 1, value: 780, icon: '⚡',
    gadgetId: 'defib', weight: 2.4, quickUsable: true,
    description: '쓰러진 아군을 즉시 만피로 일으켜 세운다.' }),
  def({ id: 'gad_jumppad', name: '점프대', category: 'gadget', rarity: 'rare', width: 2, height: 2, stackMax: 1, value: 640, icon: '⌃',
    gadgetId: 'jumpPad', weight: 6.4, quickUsable: true,
    description: '밟으면 튀어오른다. 달리면서 밟으면 전방으로 크게 도약. 회수 가능.' }),

  /* armor generated from the ArmorDef table */
  ...ARMOR_DEFS.map(armorItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId);
}

export function itemDefsByCategory(category: ItemCategory): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.category === category);
}

/** Item id for a weapon def id (`ar23` → `wpn_ar23`, `ar23_g3` → `wpn_ar23_g3`). */
export function itemIdForWeapon(weaponId: string): string {
  return `wpn_${weaponId}`;
}

/** True when the def is an equippable weapon (primary or secondary with a `weaponId`). */
export function isWeaponItemDef(d: ItemDef | undefined): d is ItemDef & { weaponId: string } {
  return !!d && (d.category === 'primary' || d.category === 'secondary') && !!d.weaponId;
}

/** True when the item may be dropped into a quick-use slot. */
export function isQuickUsable(def: ItemDef): boolean {
  return def.quickUsable === true || QUICK_USABLE_CATEGORIES.includes(def.category);
}

/** Starter kit applied on every `world:ready`. Ids are ItemDef ids. */
export const STARTER_LOADOUT = {
  primary: 'wpn_ar23',
  primary2: null,
  secondary: 'wpn_p2',
  bag: 'bag_common',
  /* appended: tactical kit */
  armor: 'armor_2',
  items: [
    { id: 'grenade_frag', qty: 2 },
    { id: 'stim', qty: 2 },
    { id: 'ammo_medium', qty: 90 },
    { id: 'ammo_light', qty: 60 },
    { id: 'gad_smoke', qty: 1 },
  ],
} as const;

export type StarterLoadout = {
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  armor: string | null;
  items: readonly { id: string; qty: number }[];
};
