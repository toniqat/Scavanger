import type { AmmoType, ArmorDef, BackpackDef, ItemCategory, ItemDef, Rarity } from '@/shared';
import { ARMOR_DEFS, ARMOR_ICON, armorItemSize } from './ArmorDefs';
import { BACKPACK_DEFS, BACKPACK_ICON, backpackItemSize } from './BackpackDefs';

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

export const RARITY_LABEL_KO: Readonly<Record<Rarity, string>> = {
  common: '일반', uncommon: '고급', rare: '희귀', epic: '영웅', legendary: '전설',
};

export const CATEGORY_LABEL_KO: Readonly<Record<ItemCategory, string>> = {
  primary: '주무기', secondary: '보조무기', grenade: '수류탄', stim: '스팀',
  ammo: '탄약', valuable: '귀중품', material: '재료',
  /* appended: tactical kit */
  armor: '방탄복', backpack: '가방', gadget: '가젯', herb: '약초',
};

/** Accent colour per category (panel chips, quick bar, map icons). */
export const CATEGORY_COLOR: Readonly<Record<ItemCategory, string>> = {
  primary: '#ffd27a', secondary: '#ffe3a0', grenade: '#ff8f5c', stim: '#6ee7a8',
  ammo: '#c8ccd2', valuable: '#7fd2ff', material: '#b0a58c',
  armor: '#9fb4ff', backpack: '#d9b98a', gadget: '#8fe8ff', herb: '#7ee08a',
};

/** Short glyph per category (used where an item has none, e.g. empty quick slots). */
export const CATEGORY_ICON: Readonly<Record<ItemCategory, string>> = {
  primary: '⌐╦', secondary: '⌐', grenade: '●', stim: '✚',
  ammo: '▮▮', valuable: '◆', material: '▫',
  armor: '⛊', backpack: '▤', gadget: '◈', herb: '❦',
};

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
};

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

/* ── gear generated from the ArmorDef / BackpackDef tables ────────────────── */
const armorItem = (a: ArmorDef): ItemDef => {
  const { width, height } = armorItemSize(a);
  return def({
    id: a.id, name: a.name, description: a.description, category: 'armor', rarity: a.rarity,
    width, height, value: Math.round(300 + a.damageReduction * 4200 + a.durabilityMax * 1.4),
    icon: ARMOR_ICON[a.id] ?? '⛊', armorId: a.id, weight: a.weight, durabilityMax: a.durabilityMax,
  });
};

const backpackItem = (b: BackpackDef): ItemDef => {
  const { width, height } = backpackItemSize(b);
  return def({
    id: b.id, name: b.name, description: b.description, category: 'backpack', rarity: b.rarity,
    width, height, value: Math.round(180 + b.cols * b.rows * 12 + b.capacityBonus * 30 + (b.quickSlots - 4) * 260),
    icon: BACKPACK_ICON[b.id] ?? '▤', backpackId: b.id, weight: b.weight, durabilityMax: b.durabilityMax,
  });
};

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary (do not occupy grid cells while equipped) */
  def({ id: 'wpn_ar23', name: 'AR-23 리버레이터', category: 'primary', rarity: 'common', width: 4, height: 2, value: 350, icon: '⌐╦', weaponId: 'ar23',
    weight: 4.2, durabilityMax: 320,
    description: '슈퍼 지구 표준 돌격소총. 균형 잡힌 연사와 안정적인 반동. 견고한 개머리판.' }),
  def({ id: 'wpn_smg37', name: 'SMG-37 디펜더', category: 'primary', rarity: 'uncommon', width: 3, height: 2, value: 480, icon: '⌐╪', weaponId: 'smg37',
    weight: 3.1, durabilityMax: 260,
    description: '경량 기관단총. 근거리 연사에 특화되었으나 거리가 멀어질수록 위력이 급감. 접이식 개머리판.' }),
  def({ id: 'wpn_sg8', name: 'SG-8 퍼니셔', category: 'primary', rarity: 'uncommon', width: 3, height: 2, value: 520, icon: '⌐═', weaponId: 'sg8',
    weight: 4.6, durabilityMax: 300,
    description: '펌프액션 산탄총. 근거리에서 압도적인 제압력. 묵직한 개머리판으로 후려치기 좋다.' }),
  def({ id: 'wpn_r63', name: 'R-63 딜리전스', category: 'primary', rarity: 'rare', width: 4, height: 1, value: 780, icon: '⌐──', weaponId: 'r63',
    weight: 4.4, durabilityMax: 340,
    description: '반자동 지정사수 소총. 원거리 정밀 사격에 최적화.' }),
  def({ id: 'wpn_sr9', name: 'SR-9 이래디케이터', category: 'primary', rarity: 'rare', width: 5, height: 1, value: 950, icon: '⌐───', weaponId: 'sr9',
    weight: 6.8, durabilityMax: 380,
    description: '볼트액션 저격소총. 4배율 조준경. 한 발로 대부분의 벌레를 무력화하지만 장전이 느리다.' }),
  def({ id: 'wpn_las16', name: 'LAS-16 사이드', category: 'primary', rarity: 'epic', width: 3, height: 2, value: 1250, icon: '⌐≡', weaponId: 'las16',
    weight: 5.5, durabilityMax: 420,
    description: '레이저 소총. 탄약 대신 열을 관리해야 하는 에너지 무기.' }),
  /* weapons — secondary */
  def({ id: 'wpn_p2', name: 'P-2 피스메이커', category: 'secondary', rarity: 'common', width: 2, height: 1, value: 140, icon: '⌐', weaponId: 'p2',
    weight: 1.1, durabilityMax: 240,
    description: '표준 지급 권총. 신뢰할 수 있는 반자동 사이드암.' }),
  def({ id: 'wpn_p19', name: 'P-19 리디머', category: 'secondary', rarity: 'uncommon', width: 2, height: 1, value: 260, icon: '⌐╡', weaponId: 'p19',
    weight: 1.3, durabilityMax: 220,
    description: '완전 자동 기관권총. 탄약 소모가 빠르지만 화력이 우수.' }),

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

  /* ammo packs — small footprint, deliberately heavy */
  def({ id: 'ammo_rifle', name: '소총 탄약 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 30, icon: '▮▮', ammoType: 'rifle',
    weight: 2.2, quickUsable: true,
    description: '소총탄 보급. 소총 계열 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_pistol', name: '권총 탄약 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 20, icon: '▪▪', ammoType: 'pistol',
    weight: 1.4, quickUsable: true,
    description: '권총탄 보급. 권총 계열 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_shotgun', name: '산탄 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 30, icon: '▬▬', ammoType: 'shotgun',
    weight: 2.0, quickUsable: true,
    description: '산탄총 셸 보급. 산탄총 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_energy', name: '에너지 셀', category: 'ammo', rarity: 'uncommon', width: 2, height: 1, stackMax: 2, value: 45, icon: '◈◈', ammoType: 'energy',
    weight: 1.6, quickUsable: true,
    description: '레이저 무기용 냉각 셀. 에너지 무기 예비 탄약을 보충합니다.' }),

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
    description: '재활용 가능한 금속 조각. 탄약 제작의 기본 재료.' }),
  def({ id: 'mat_bio_sample', name: '생체 조직', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 20, icon: '⁂', weight: 0.2,
    description: '터미니드 사체에서 채취한 조직.' }),
  def({ id: 'mat_alloy', name: '합금 판', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 40, icon: '▪', weight: 0.8,
    description: '경량 고강도 합금.' }),
  def({ id: 'mat_power_cell', name: '파워 셀', category: 'material', rarity: 'rare', width: 1, height: 1, stackMax: 10, value: 85, icon: '⚡', weight: 1.1,
    description: '충전된 소형 전력 셀.' }),
  def({ id: 'mat_gunpowder', name: '화약', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 20, value: 12, icon: '⋆', weight: 0.05,
    description: '탄약을 분해해 얻는 추진제. 원하는 탄종으로 다시 만들 수 있다.' }),

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

  /* gear generated from the ArmorDef / BackpackDef tables */
  ...ARMOR_DEFS.map(armorItem),
  ...BACKPACK_DEFS.map(backpackItem),
];

export const ITEM_DEF_MAP: ReadonlyMap<string, ItemDef> = new Map(ITEM_DEFS.map((d) => [d.id, d]));

export function getItemDef(defId: string): ItemDef | undefined {
  return ITEM_DEF_MAP.get(defId);
}

export function itemDefsByCategory(category: ItemCategory): ItemDef[] {
  return ITEM_DEFS.filter((d) => d.category === category);
}

/** Item id for a weapon def id (`ar23` → `wpn_ar23`). */
export function itemIdForWeapon(weaponId: string): string {
  return `wpn_${weaponId}`;
}

/** True when the item may be dropped into a quick-use slot. */
export function isQuickUsable(def: ItemDef): boolean {
  return def.quickUsable === true;
}

/** Starter kit applied on every `world:ready`. Ids are ItemDef ids. */
export const STARTER_LOADOUT = {
  primary: 'wpn_ar23',
  secondary: 'wpn_p2',
  /* appended: tactical kit — the backpack decides the bag grid, so the starter kit ships one. */
  armor: 'armor_2',
  backpack: 'bp_2',
  bag: [
    { id: 'grenade_frag', qty: 4 },
    { id: 'stim', qty: 2 },
    { id: 'ammo_rifle', qty: 1 },
    { id: 'gad_smoke', qty: 1 },
  ],
} as const;
