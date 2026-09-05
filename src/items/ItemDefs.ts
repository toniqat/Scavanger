import type { AmmoType, AttachmentDef, BagDef, ItemCategory, ItemDef, Rarity, WeaponDef, WeaponGrade } from '@/shared';
import { AMMO_STACK_ROUNDS } from '@/shared';
import { WEAPON_DEFS, gradeOf, weaponFamilyOf } from './WeaponDefs';

/* ── palette / labels ─────────────────────────────────────────────────────── */
export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  common: '#9aa3ad',
  uncommon: '#4fd17e',
  rare: '#4aa3ff',
  epic: '#b56cff',
  legendary: '#ffb347',
};

export const RARITY_ORDER: readonly Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const rarityRank = (r: Rarity): number => RARITY_ORDER.indexOf(r);

/** Rarity ↔ weapon grade (1 common … 5 legendary). */
export const rarityForGrade = (g: WeaponGrade): Rarity => RARITY_ORDER[g - 1];
export const gradeForRarity = (r: Rarity): WeaponGrade => (rarityRank(r) + 1) as WeaponGrade;

export const RARITY_LABEL_KO: Readonly<Record<Rarity, string>> = {
  common: '일반', uncommon: '고급', rare: '희귀', epic: '서사', legendary: '전설',
};

export const CATEGORY_LABEL_KO: Readonly<Record<ItemCategory, string>> = {
  primary: '주무기', secondary: '보조무기', grenade: '수류탄', stim: '스팀',
  ammo: '탄약', valuable: '귀중품', material: '재료',
  attachment: '부착물', bag: '가방',
};

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  light: '경량탄', medium: '준중량탄', heavy: '중량탄', shell: '산탄',
  /* legacy calibres (no def uses them) */
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
};

/** v2 calibres in display order. */
export const AMMO_TYPES_V2: readonly AmmoType[] = ['light', 'medium', 'heavy', 'shell'];

/** Ammo item id for a calibre (`medium` → `ammo_medium`). */
export function ammoItemIdFor(ammoType: AmmoType): string {
  return `ammo_${ammoType}`;
}

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── weapons (one ItemDef per WeaponDef grade) ────────────────────────────── */
interface WeaponFamilyMeta {
  width: number; height: number; icon: string; value: number; description: string;
}
const WEAPON_FAMILY_META: Readonly<Record<string, WeaponFamilyMeta>> = {
  ar23: { width: 4, height: 2, icon: '⌐╦', value: 350, description: '슈퍼 지구 표준 돌격소총. 균형 잡힌 연사와 안정적인 반동.' },
  smg37: { width: 3, height: 2, icon: '⌐╪', value: 480, description: '경량 기관단총. 근거리 연사에 특화되었으나 거리가 멀어질수록 위력이 급감.' },
  sg8: { width: 3, height: 2, icon: '⌐═', value: 520, description: '펌프액션 산탄총. 근거리에서 압도적인 제압력.' },
  r63: { width: 4, height: 1, icon: '⌐──', value: 780, description: '반자동 지정사수 소총. 원거리 정밀 사격에 최적화.' },
  sr9: { width: 5, height: 1, icon: '⌐───', value: 950, description: '볼트액션 저격소총. 4배율 조준경. 한 발로 대부분의 벌레를 무력화하지만 장전이 느리다.' },
  las16: { width: 3, height: 2, icon: '⌐≡', value: 1250, description: '레이저 소총. 준중량탄을 플라즈마 볼트로 가속하는 에너지 무기.' },
  p2: { width: 2, height: 1, icon: '⌐', value: 140, description: '표준 지급 권총. 신뢰할 수 있는 반자동 사이드암.' },
  p19: { width: 2, height: 1, icon: '⌐╡', value: 260, description: '완전 자동 기관권총. 탄약 소모가 빠르지만 화력이 우수.' },
};
const FALLBACK_META: WeaponFamilyMeta = { width: 3, height: 2, icon: '⌐', value: 300, description: '무기.' };

/** Value multiplier per grade above I. */
export const WEAPON_GRADE_VALUE_STEP = 0.6;

function weaponItemDef(w: WeaponDef): ItemDef {
  const meta = WEAPON_FAMILY_META[weaponFamilyOf(w)] ?? FALLBACK_META;
  const grade = gradeOf(w);
  return def({
    id: itemIdForWeapon(w.id), name: w.name, category: w.slot, rarity: rarityForGrade(grade),
    width: meta.width, height: meta.height, value: Math.round(meta.value * (1 + WEAPON_GRADE_VALUE_STEP * (grade - 1))),
    icon: meta.icon, weaponId: w.id, description: meta.description,
  });
}

export const WEAPON_ITEM_DEFS: readonly ItemDef[] = WEAPON_DEFS.map(weaponItemDef);

/* ── ammo v2 (qty = rounds) ───────────────────────────────────────────────── */
const ammoDef = (type: AmmoType, name: string, value: number, icon: string, description: string): ItemDef =>
  def({ id: ammoItemIdFor(type), name, category: 'ammo', rarity: 'common', width: 1, height: 1,
    stackMax: AMMO_STACK_ROUNDS[type], value, icon, ammoType: type, description });

export const AMMO_ITEM_DEFS: readonly ItemDef[] = [
  ammoDef('light', '경량탄', 1, '▪', '기관단총·권총용 경량 탄약. 수량은 발수.'),
  ammoDef('medium', '준중량탄', 2, '▮', '돌격소총용 준중량 탄약. 수량은 발수.'),
  ammoDef('heavy', '중량탄', 3, '▬', '저격소총·지정사수소총용 중량 탄약. 수량은 발수.'),
  ammoDef('shell', '산탄', 3, '◘', '산탄총용 셸. 수량은 발수.'),
];

/* ── attachments ──────────────────────────────────────────────────────────── */
const NOT_PISTOL = ['AR', 'SMG', 'SG', 'SR', 'DMR'] as const;
const attDef = (
  id: string, name: string, rarity: Rarity, value: number, icon: string, description: string, attachment: AttachmentDef,
): ItemDef => def({ id, name, category: 'attachment', rarity, width: 1, height: 1, value, icon, description, attachment });

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
  def({ id, name, category: 'bag', rarity, width: 2, height: 2, value, icon: bag.tactical ? '⛶' : '▣', description, bag });

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

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary / secondary (do not occupy grid cells while equipped) */
  ...WEAPON_ITEM_DEFS,

  /* grenades */
  def({ id: 'grenade_frag', name: 'G-12 고폭 수류탄', category: 'grenade', rarity: 'common', width: 1, height: 1, stackMax: 4, value: 40, icon: '●',
    description: '파편 수류탄. 반경 6 m 광역 피해.' }),
  def({ id: 'grenade_incendiary', name: 'G-10 소이 수류탄', category: 'grenade', rarity: 'uncommon', width: 1, height: 1, stackMax: 4, value: 70, icon: '◉',
    description: '소이 수류탄. 넓은 반경에 화염 피해.' }),

  /* stims */
  def({ id: 'stim', name: '스팀', category: 'stim', rarity: 'common', width: 1, height: 1, stackMax: 3, value: 60, icon: '✚', healAmount: 50,
    description: '자동 주사기. 체력 50 회복.' }),
  def({ id: 'stim_advanced', name: '고급 스팀', category: 'stim', rarity: 'uncommon', width: 1, height: 1, stackMax: 3, value: 120, icon: '✚', healAmount: 100,
    description: '군용 나노 주사기. 체력 완전 회복.' }),

  /* ammo v2 */
  ...AMMO_ITEM_DEFS,

  /* attachments */
  ...ATTACHMENT_ITEM_DEFS,

  /* bags */
  ...BAG_ITEM_DEFS,

  /* valuables */
  def({ id: 'gem_quartz', name: '석영 결정', category: 'valuable', rarity: 'common', width: 1, height: 1, value: 120, icon: '◇',
    description: '흔한 광물 결정. 소량의 가치.' }),
  def({ id: 'gem_amber', name: '호박석', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 260, icon: '◆',
    description: '외계 수액이 굳어 생긴 호박. 수집가들이 찾는 물건.' }),
  def({ id: 'gem_sapphire', name: '청옥', category: 'valuable', rarity: 'rare', width: 1, height: 1, value: 620, icon: '◆',
    description: '순도 높은 청색 보석.' }),
  def({ id: 'gem_void', name: '공허석', category: 'valuable', rarity: 'epic', width: 1, height: 1, value: 1400, icon: '✦',
    description: '빛을 흡수하는 검은 결정. 기원 불명.' }),
  def({ id: 'cred_chip', name: '크레딧 칩', category: 'valuable', rarity: 'common', width: 1, height: 1, stackMax: 5, value: 90, icon: '▣',
    description: '슈퍼 크레딧이 저장된 데이터 칩.' }),
  def({ id: 'salvage_electronics', name: '회수 전자장비', category: 'valuable', rarity: 'common', width: 2, height: 1, value: 180, icon: '▤▥',
    description: '추락한 장비에서 뜯어낸 회로 기판.' }),
  def({ id: 'data_core', name: '데이터 코어', category: 'valuable', rarity: 'rare', width: 2, height: 1, value: 900, icon: '▦▦',
    description: '전초기지 기록이 담긴 저장 코어.' }),
  def({ id: 'data_core_encrypted', name: '암호화 데이터 코어', category: 'valuable', rarity: 'epic', width: 2, height: 1, value: 2100, icon: '▩▩',
    description: '군 등급 암호화가 걸린 코어. 정보부가 고가에 매입.' }),
  def({ id: 'sample_canister', name: '샘플 캐니스터', category: 'valuable', rarity: 'uncommon', width: 3, height: 1, value: 480, icon: '▭▭▭',
    description: '터미니드 조직 샘플이 봉인된 용기.' }),
  def({ id: 'sample_canister_pure', name: '정제 샘플 캐니스터', category: 'valuable', rarity: 'rare', width: 3, height: 1, value: 1100, icon: '▭▭▭',
    description: '고순도 외계 생체 샘플. 연구부의 최우선 회수 대상.' }),
  def({ id: 'terminid_gland', name: '터미니드 분비선', category: 'valuable', rarity: 'uncommon', width: 1, height: 1, value: 300, icon: '❂',
    description: '페로몬을 분비하는 기관. 생화학 연구용.' }),
  def({ id: 'alien_artifact', name: '외계 유물', category: 'valuable', rarity: 'epic', width: 2, height: 2, value: 3200, icon: '⬡',
    description: '알 수 없는 문자가 새겨진 금속 조각. 미약하게 진동한다.' }),
  def({ id: 'alien_relic', name: '고대 성유물', category: 'valuable', rarity: 'legendary', width: 2, height: 2, value: 7500, icon: '✧',
    description: '선행 문명의 유물. 측정 불가한 에너지를 방출한다.' }),
  def({ id: 'super_earth_medal', name: '슈퍼 지구 훈장', category: 'valuable', rarity: 'legendary', width: 1, height: 1, value: 4800, icon: '★',
    description: '전사한 헬다이버의 훈장. 명예와 함께 막대한 가치.' }),

  /* materials */
  def({ id: 'mat_scrap', name: '폐금속', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 15, icon: '▫',
    description: '재활용 가능한 금속 조각. 무기 수리에 사용.' }),
  def({ id: 'mat_bio_sample', name: '생체 조직', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 20, icon: '⁂',
    description: '터미니드 사체에서 채취한 조직.' }),
  def({ id: 'mat_alloy', name: '합금 판', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 40, icon: '▪',
    description: '경량 고강도 합금. 고등급 무기 수리에 사용.' }),
  def({ id: 'mat_power_cell', name: '파워 셀', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 85, icon: '⚡',
    description: '충전된 소형 전력 셀.' }),
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

/** Starter kit applied on every `world:ready`. Ids are ItemDef ids. */
export const STARTER_LOADOUT = {
  primary: 'wpn_ar23',
  primary2: null,
  secondary: 'wpn_p2',
  bag: 'bag_common',
  items: [
    { id: 'grenade_frag', qty: 2 },
    { id: 'stim', qty: 2 },
    { id: 'ammo_medium', qty: 90 },
    { id: 'ammo_light', qty: 60 },
  ],
} as const;

export type StarterLoadout = {
  primary: string | null;
  primary2: string | null;
  secondary: string | null;
  bag: string | null;
  items: readonly { id: string; qty: number }[];
};
