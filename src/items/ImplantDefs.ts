import type { ItemDef, PerkId, Rarity, StatId } from '@/shared';
import { CATEGORY_COLOR, CATEGORY_ICON, PERK_DEFS, RARITY_COLORS, STAT_IDS, csvRows, keyTable, numberMap } from '@/shared';

/* 수치의 원본: 등급별 장착칸 = `data/tables.csv` 의 IMPLANT_SLOTS_BY_GRADE,
 * 등급별 가격 · 수리 재료 = `data/implants_repair.csv`, 퍽 임플란트 = `data/implants_perks.csv`,
 * 무게 · 망가진 것의 가격 배수 = `data/tuning.csv`. 이름과 설명문은 여기서 만들어진다. */
const T = /* data/tuning.csv */ keyTable('tuning.csv');

/* ────────────────────────────────────────────────────────────────────────────
 * 임플란트 아이템 (Phase 12, 2026-09-08 — `docs/DECISIONS.md` Phase 12).
 *
 * Distinct from the six 전술 임플란트 (Q key, `ImplantId`): these are **items** of category `'implant'` that the
 * character slots on the 캐릭터 tab (progression/ owns the rules — `IMPLANT_SLOTS_BASE` 4 + 1 per 5 levels, max 10).
 * Each takes `implant.slots` of those slots and adds `implant.stats` to the five base stats while equipped.
 *
 *   ┌ stat implants: 5 stats × grades I–IV ─────────────────────────────────────────────────┐
 *   │ grade  rarity     slots  bonus │ id                    name                         │
 *   │ I      common     1      +1    │ imp_<stat>_1          근력 임플란트 I                │
 *   │ II     uncommon   2      +2    │ imp_<stat>_2          근력 임플란트 II               │
 *   │ III    rare       2      +3    │ imp_<stat>_3          근력 임플란트 III              │
 *   │ IV     epic       3      +4    │ imp_<stat>_4          근력 임플란트 IV               │
 *   └───────────────────────────────────────────────────────────────────────────────────────┘
 *   3 legendary **perk** implants (`implant.perk`, effects read from `derived.perks` by player/ and weapons/):
 *     imp_perk_auto_revive   재기동 회로     slots 3, +1 지구력
 *     imp_perk_quick_heal    가속 대사       slots 2, +1 재주
 *     imp_perk_kill_stamina  아드레날린 펌프  slots 3, +1 근력
 *
 * Every one of the 23 has a **broken** twin `imp_broken_<same suffix>` (`망가진 <name>`, same rarity, `broken: true`,
 * no stats, same slot cost): that is what raids drop (tier 2–4 containers, 로그 / 보스 시체 — `LootTables.ts`).
 * A broken implant cannot be equipped; 세레스 바이오 (meta/) repairs it into `repairsTo` for `repairCost`. Working
 * implants are never loot and never craftable — 세레스 바이오 sells them, the repair desk makes them.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ImplantGrade = 1 | 2 | 3 | 4;
export const IMPLANT_GRADES: readonly ImplantGrade[] = [1, 2, 3, 4];

const ROMAN: Readonly<Record<ImplantGrade, string>> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
const GRADE_RARITY: Readonly<Record<ImplantGrade, Rarity>> = { 1: 'common', 2: 'uncommon', 3: 'rare', 4: 'epic' };
/** Slot cost per grade (I 1 · II 2 · III 2 · IV 3); legendaries set theirs individually. */
export const IMPLANT_SLOTS_BY_GRADE: Readonly<Record<ImplantGrade, number>> =
  numberMap<`${ImplantGrade}`>('tables.csv', 'IMPLANT_SLOTS_BY_GRADE') as unknown as Readonly<Record<ImplantGrade, number>>;

/** 한국어 stat names (progression/defs.ts owns the full StatDef table; items only needs the label for the item name). */
export const IMPLANT_STAT_NAME_KO: Readonly<Record<StatId, string>> = {
  strength: '근력', endurance: '지구력', perception: '인지력', intelligence: '지능', dexterity: '재주',
};
const STAT_FLAVOR_KO: Readonly<Record<StatId, string>> = {
  strength: '근섬유 보조 서보를 척추에 붙인다',
  endurance: '심폐 순환을 보조하는 산소 재순환기',
  perception: '시각 · 청각 신호를 증폭하는 감각 피질 보조기',
  intelligence: '기억 색인과 연산을 돕는 신경 코프로세서',
  dexterity: '소근육 반응 지연을 줄이는 운동 피질 보조기',
};

/** `data/implants_repair.csv` — 등급별 가격과 수리 재료. */
const IMPLANT_REPAIR_ROWS = csvRows('implants_repair.csv');

/** Sale value by rarity (세레스 바이오 prices off `value`); a broken one is worth `1 / BROKEN_IMPLANT_VALUE_DIV`. */
export const IMPLANT_VALUE_BY_RARITY: Readonly<Record<Rarity, number>> =
  Object.fromEntries(IMPLANT_REPAIR_ROWS.map((r) => [r.str('rarity'), r.int('value', { min: 1 })])) as Record<Rarity, number>;
export const BROKEN_IMPLANT_VALUE_DIV = T.num('BROKEN_IMPLANT_VALUE_DIV');

/** Repair materials at 세레스 바이오, growing with grade; legendaries use the `legendary` row. */
export const IMPLANT_REPAIR_COST: Readonly<Record<Rarity, ReadonlyArray<{ defId: string; qty: number }>>> =
  Object.fromEntries(IMPLANT_REPAIR_ROWS.map((r) => [r.str('rarity'), r.costList('repairCost')])) as Record<Rarity, { defId: string; qty: number }[]>;

const IMPLANT_WEIGHT = T.num('IMPLANT_WEIGHT');
const IMPLANT_ICON = CATEGORY_ICON.implant;
const IMPLANT_COLOR = CATEGORY_COLOR.implant;
/** A broken implant reads grey-violet so it is never mistaken for a working one on a tile. */
const BROKEN_IMPLANT_COLOR = '#8c7a99';

/** `imp_strength_2` — item id of the working grade-`g` implant for `stat`. */
export function implantItemIdFor(stat: StatId, grade: ImplantGrade): string {
  return `imp_${stat}_${grade}`;
}
/** `imp_perk_quick_heal` — item id of a legendary perk implant. */
export function perkImplantItemIdFor(perk: PerkId): string {
  return `imp_perk_${perk}`;
}
/** `imp_strength_2` → `imp_broken_strength_2` (the id of the broken twin; also works for `imp_perk_*`). */
export function brokenImplantIdOf(workingId: string): string {
  return workingId.replace(/^imp_/, 'imp_broken_');
}

interface WorkingSpec {
  id: string; name: string; rarity: Rarity; slots: number;
  stats: Partial<Record<StatId, number>>; perk?: PerkId; description: string;
}

function working(spec: WorkingSpec): ItemDef {
  return {
    id: spec.id, name: spec.name, category: 'implant', rarity: spec.rarity, width: 1, height: 1, stackMax: 1,
    value: IMPLANT_VALUE_BY_RARITY[spec.rarity], color: spec.rarity === 'legendary' ? RARITY_COLORS.legendary : IMPLANT_COLOR,
    icon: IMPLANT_ICON, weight: IMPLANT_WEIGHT, description: spec.description,
    implant: { slots: spec.slots, stats: { ...spec.stats }, ...(spec.perk ? { perk: spec.perk } : {}) },
  };
}

/** The broken twin of a working def: same rarity / slots, no stats, `repairsTo` the working id. */
function broken(w: ItemDef): ItemDef {
  const imp = w.implant!;
  return {
    id: brokenImplantIdOf(w.id), name: `망가진 ${w.name}`, category: 'implant', rarity: w.rarity, width: 1, height: 1, stackMax: 1,
    value: Math.max(1, Math.round(w.value / BROKEN_IMPLANT_VALUE_DIV)), color: BROKEN_IMPLANT_COLOR, icon: IMPLANT_ICON,
    weight: IMPLANT_WEIGHT,
    description: `회로가 타 버린 ${w.name}. 장착할 수 없고 능력치도 주지 않는다 — 세레스 바이오의 임플란트 데스크에서 수리하면 ${w.name}(으)로 되살아난다.`,
    implant: { slots: imp.slots, stats: {}, broken: true, repairsTo: w.id, repairCost: IMPLANT_REPAIR_COST[w.rarity].map((c) => ({ ...c })) },
  };
}

function statImplant(stat: StatId, grade: ImplantGrade): ItemDef {
  const rarity = GRADE_RARITY[grade];
  const slots = IMPLANT_SLOTS_BY_GRADE[grade];
  const name = `${IMPLANT_STAT_NAME_KO[stat]} 임플란트 ${ROMAN[grade]}`;
  return working({
    id: implantItemIdFor(stat, grade), name, rarity, slots, stats: { [stat]: grade },
    description: `${STAT_FLAVOR_KO[stat]}. 장착 중 ${IMPLANT_STAT_NAME_KO[stat]} +${grade}. 장착칸 ${slots}. 함선의 캐릭터 탭에서 장착한다.`,
  });
}

interface PerkSpec { perk: PerkId; slots: number; stat: StatId }
const PERK_SPECS: readonly PerkSpec[] = csvRows('implants_perks.csv').map((r) => ({
  perk: r.str('perk') as PerkId,
  slots: r.int('slots', { min: 1 }),
  stat: r.str('stat') as StatId,
}));

function perkImplant(spec: PerkSpec): ItemDef {
  const def = PERK_DEFS[spec.perk];
  return working({
    id: perkImplantItemIdFor(spec.perk), name: def.name, rarity: 'legendary', slots: spec.slots, perk: spec.perk,
    stats: { [spec.stat]: 1 },
    description: `${def.description} 장착 중 ${IMPLANT_STAT_NAME_KO[spec.stat]} +1. 장착칸 ${spec.slots}. 전설 임플란트.`,
  });
}

/** 20 stat implants (stat-major, grade I → IV) then the 3 legendary perk implants. */
export const IMPLANT_WORKING_DEFS: readonly ItemDef[] = [
  ...STAT_IDS.flatMap((stat) => IMPLANT_GRADES.map((g) => statImplant(stat, g))),
  ...PERK_SPECS.map(perkImplant),
];
/** One broken twin per working def, in the same order (`IMPLANT_BROKEN_DEFS[i].implant.repairsTo === IMPLANT_WORKING_DEFS[i].id`). */
export const IMPLANT_BROKEN_DEFS: readonly ItemDef[] = IMPLANT_WORKING_DEFS.map(broken);
/** Every implant item def — working first, then broken (46). */
export const IMPLANT_ITEM_DEFS: readonly ItemDef[] = [...IMPLANT_WORKING_DEFS, ...IMPLANT_BROKEN_DEFS];
/** The 3 legendary perk implants (working). */
export const PERK_IMPLANT_DEFS: readonly ItemDef[] = IMPLANT_WORKING_DEFS.filter((d) => d.rarity === 'legendary');

/** True for any implant item def (working or broken). */
export function isImplantItemDef(d: ItemDef | undefined): d is ItemDef & { implant: NonNullable<ItemDef['implant']> } {
  return !!d && d.category === 'implant' && !!d.implant;
}
/** True for a broken implant (raid loot; repairable, not equippable). */
export function isBrokenImplantDef(d: ItemDef | undefined): boolean {
  return isImplantItemDef(d) && d.implant.broken === true;
}
