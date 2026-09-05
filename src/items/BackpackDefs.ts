import type { BackpackDef } from '@/shared';

/**
 * Backpacks (가방). The equipped backpack *is* the bag: it decides the grid size, how many quick-use
 * slots are live and how much extra weight the character may carry. Numbered I..V simply grow;
 * the three legendaries all share the rare-tier grid and pay for their perk with quick slots / weight.
 *
 * Perks are implemented elsewhere and only *declared* here:
 *  - `tactical`  → 8 quick slots + 50 % faster weapon swap (weapons/) + jump-hold hover (player/)
 *  - `special`   → implant cooldown ×0.5 (progression/ folds it into `derived.implantCooldownMul`)
 *  - `jump`      → mid-air re-jump forward dash (player/)
 */
export const BACKPACK_DEFS: readonly BackpackDef[] = [
  {
    id: 'bp_1', name: '가방 I', tier: 1, rarity: 'common',
    description: '작은 전술 파우치. 없는 것보다는 낫다.',
    cols: 8, rows: 4, quickSlots: 4, capacityBonus: 4, weight: 1.2, durabilityMax: 220,
    perk: 'none', color: '#8e9299',
  },
  {
    id: 'bp_2', name: '가방 II', tier: 2, rarity: 'common',
    description: '표준 지급 배낭.',
    cols: 9, rows: 5, quickSlots: 4, capacityBonus: 7, weight: 1.9, durabilityMax: 280,
    perk: 'none', color: '#93a08c',
  },
  {
    id: 'bp_3', name: '가방 III', tier: 3, rarity: 'uncommon',
    description: '확장 프레임 배낭. 측면 파우치 추가.',
    cols: 10, rows: 5, quickSlots: 4, capacityBonus: 10, weight: 2.5, durabilityMax: 340,
    perk: 'none', color: '#6f9d72',
  },
  {
    id: 'bp_4', name: '가방 IV', tier: 4, rarity: 'rare',
    description: '군용 대용량 배낭. 하중 분산 하네스.',
    cols: 10, rows: 6, quickSlots: 4, capacityBonus: 14, weight: 3.3, durabilityMax: 420,
    perk: 'none', color: '#5b8fd6',
  },
  {
    id: 'bp_5', name: '가방 V', tier: 5, rarity: 'epic',
    description: '원정용 화물 배낭. 이 정도면 상자 하나를 통째로 담는다.',
    cols: 12, rows: 6, quickSlots: 4, capacityBonus: 18, weight: 4.4, durabilityMax: 500,
    perk: 'none', color: '#a877e8',
  },

  /* ── legendaries (rare-tier grid) ──────────────────────────────────────── */
  {
    id: 'bp_tactical', name: '전술 가방', tier: 0, rarity: 'legendary',
    description: '빠른 사용 슬롯 8칸. 주무기 교체가 50 % 빨라지고, 공중에서 점프 키를 누르면 호버로 낙하를 늦춘다.',
    cols: 10, rows: 6, quickSlots: 8, capacityBonus: 12, weight: 3.6, durabilityMax: 420,
    perk: 'tactical', color: '#ffb347',
  },
  {
    id: 'bp_special', name: '특수 가방', tier: 0, rarity: 'legendary',
    description: '임플란트 보조 전원부. 전술 임플란트 쿨타임이 50 % 줄어든다.',
    cols: 10, rows: 6, quickSlots: 4, capacityBonus: 12, weight: 3.4, durabilityMax: 420,
    perk: 'special', color: '#8fe8ff',
  },
  {
    id: 'bp_jump', name: '점프 가방', tier: 0, rarity: 'legendary',
    description: '소형 추진기 내장. 점프 후 다시 점프하면 전방으로 돌진한다 (스태미나 50 %, 12초 쿨타임).',
    cols: 10, rows: 6, quickSlots: 4, capacityBonus: 10, weight: 4.6, durabilityMax: 400,
    perk: 'jump', color: '#ff7f9f',
  },
];

export const BACKPACK_DEF_MAP: ReadonlyMap<string, BackpackDef> = new Map(BACKPACK_DEFS.map((b) => [b.id, b]));

export function getBackpackDef(backpackId: string): BackpackDef | undefined {
  return BACKPACK_DEF_MAP.get(backpackId);
}

/** Grid footprint of the carried (unequipped) backpack. */
export function backpackItemSize(def: BackpackDef): { width: number; height: number } {
  if (def.tier > 0 && def.tier <= 3) return { width: 3, height: 2 };
  return { width: 3, height: 3 };
}

export const BACKPACK_ICON: Readonly<Record<string, string>> = {
  bp_1: '▭', bp_2: '▯', bp_3: '▤', bp_4: '▦', bp_5: '▩',
  bp_tactical: '◨', bp_special: '◫', bp_jump: '⌃',
};

/** Grid used when no backpack is equipped (몸에 지닌 주머니). */
export const BASE_BAG_COLS = 6;
export const BASE_BAG_ROWS = 4;
/** Quick-use slots without a backpack. */
export const BASE_QUICK_SLOTS = 2;
