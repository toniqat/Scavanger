import type { AmmoType, ItemCategory, ItemDef, Rarity } from '@/shared';

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
};

export const AMMO_LABEL_KO: Readonly<Record<AmmoType, string>> = {
  rifle: '소총탄', pistol: '권총탄', shotgun: '산탄', energy: '에너지 셀',
};

/* ── builder ──────────────────────────────────────────────────────────────── */
type DefInput = Omit<ItemDef, 'color' | 'stackMax'> & { stackMax?: number };
const def = (d: DefInput): ItemDef => ({ ...d, stackMax: d.stackMax ?? 1, color: RARITY_COLORS[d.rarity] });

/* ── definitions ──────────────────────────────────────────────────────────── */
export const ITEM_DEFS: readonly ItemDef[] = [
  /* weapons — primary (do not occupy grid cells while equipped) */
  def({ id: 'wpn_ar23', name: 'AR-23 리버레이터', category: 'primary', rarity: 'common', width: 4, height: 2, value: 350, icon: '⌐╦', weaponId: 'ar23',
    description: '슈퍼 지구 표준 돌격소총. 균형 잡힌 연사와 안정적인 반동.' }),
  def({ id: 'wpn_sg8', name: 'SG-8 퍼니셔', category: 'primary', rarity: 'uncommon', width: 3, height: 2, value: 520, icon: '⌐═', weaponId: 'sg8',
    description: '펌프액션 산탄총. 근거리에서 압도적인 제압력.' }),
  def({ id: 'wpn_r63', name: 'R-63 딜리전스', category: 'primary', rarity: 'rare', width: 4, height: 1, value: 780, icon: '⌐──', weaponId: 'r63',
    description: '반자동 지정사수 소총. 원거리 정밀 사격에 최적화.' }),
  def({ id: 'wpn_las16', name: 'LAS-16 사이드', category: 'primary', rarity: 'epic', width: 3, height: 2, value: 1250, icon: '⌐≡', weaponId: 'las16',
    description: '레이저 소총. 탄약 대신 열을 관리해야 하는 에너지 무기.' }),
  /* weapons — secondary */
  def({ id: 'wpn_p2', name: 'P-2 피스메이커', category: 'secondary', rarity: 'common', width: 2, height: 1, value: 140, icon: '⌐', weaponId: 'p2',
    description: '표준 지급 권총. 신뢰할 수 있는 반자동 사이드암.' }),
  def({ id: 'wpn_p19', name: 'P-19 리디머', category: 'secondary', rarity: 'uncommon', width: 2, height: 1, value: 260, icon: '⌐╡', weaponId: 'p19',
    description: '완전 자동 기관권총. 탄약 소모가 빠르지만 화력이 우수.' }),

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

  /* ammo packs */
  def({ id: 'ammo_rifle', name: '소총 탄약 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 30, icon: '▮▮', ammoType: 'rifle',
    description: '소총탄 보급. 소총 계열 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_pistol', name: '권총 탄약 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 20, icon: '▪▪', ammoType: 'pistol',
    description: '권총탄 보급. 권총 계열 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_shotgun', name: '산탄 팩', category: 'ammo', rarity: 'common', width: 2, height: 1, stackMax: 2, value: 30, icon: '▬▬', ammoType: 'shotgun',
    description: '산탄총 셸 보급. 산탄총 예비 탄약을 보충합니다.' }),
  def({ id: 'ammo_energy', name: '에너지 셀', category: 'ammo', rarity: 'uncommon', width: 2, height: 1, stackMax: 2, value: 45, icon: '◈◈', ammoType: 'energy',
    description: '레이저 무기용 냉각 셀. 에너지 무기 예비 탄약을 보충합니다.' }),

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
    description: '재활용 가능한 금속 조각.' }),
  def({ id: 'mat_bio_sample', name: '생체 조직', category: 'material', rarity: 'common', width: 1, height: 1, stackMax: 10, value: 20, icon: '⁂',
    description: '터미니드 사체에서 채취한 조직.' }),
  def({ id: 'mat_alloy', name: '합금 판', category: 'material', rarity: 'uncommon', width: 1, height: 1, stackMax: 10, value: 40, icon: '▪',
    description: '경량 고강도 합금.' }),
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

/** Item id for a weapon def id (`ar23` → `wpn_ar23`). */
export function itemIdForWeapon(weaponId: string): string {
  return `wpn_${weaponId}`;
}

/** Starter kit applied on every `world:ready`. Ids are ItemDef ids. */
export const STARTER_LOADOUT = {
  primary: 'wpn_ar23',
  secondary: 'wpn_p2',
  bag: [
    { id: 'grenade_frag', qty: 4 },
    { id: 'stim', qty: 2 },
    { id: 'ammo_rifle', qty: 1 },
  ],
} as const;
