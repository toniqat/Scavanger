import type { ArmorDef } from '@/shared';
import { csvRows } from '@/shared';

/**
 * Body armor (방탄복) — 수치의 원본은 `data/armor.csv` 다.
 *
 * **2026-09-10 — 방탄복은 피해 감소가 아니라 실드(추가 체력)를 준다.** 번호 방탄복 I..V 의 `shield` 는
 * csv 가 `=ARMOR_SHIELD_BY_TIER.3` 으로 `data/tables.csv` 의 표를 그대로 가리키고 (20/40/60/80/100),
 * 유니크 3벌은 옛 뎀감률을 `round(damageReduction / ARMOR_DR_BY_TIER.5 × 100)` 으로 환산한 값을 직접 적었다
 * (재생 90 · 초경량 33 · 광학미채 27). `damageReduction` 은 그 환산의 근거로만 남은 열이라 **아무도 읽지 않는다**
 * (`shared/gear.ts` 의 주석 참고 — 계약은 추가만 한다는 규칙 때문에 지우지 않았다).
 *
 * `player/` 는 `shield` 만큼의 풀을 들고 피해를 체력보다 **먼저** 그 풀에서 깎으며, 실드가 먹은 만큼
 * `ctx.inventory.damageDurability` 로 판을 닳게 한다. 내구도 0 = 파손 = 실드 최대치 0 (충전기로도 못 채운다).
 *
 * Weight is deliberately *not* proportional to the grid footprint — the heaviest plates cost more
 * of the carry budget than their cells suggest, and the ultralight vest is almost free.
 */
export const ARMOR_DEFS: readonly ArmorDef[] = csvRows('armor.csv').map((r) => ({
  id: r.str('id'),
  name: r.str('name'),
  tier: r.int('tier', { min: 0 }),
  rarity: r.str('rarity') as ArmorDef['rarity'],
  description: r.str('description'),
  damageReduction: r.num('damageReduction', { min: 0, max: 1 }),
  shield: r.num('shield', { min: 0 }),
  weight: r.num('weight', { min: 0 }),
  durabilityMax: r.int('durabilityMax', { min: 1 }),
  perk: r.enum('perk', ['none', 'regen', 'ultralight', 'optical'] as const),
  ...(r.has('perkValue') ? { perkValue: r.num('perkValue') } : {}),
  color: r.str('color'),
}));

export const ARMOR_DEF_MAP: ReadonlyMap<string, ArmorDef> = new Map(ARMOR_DEFS.map((a) => [a.id, a]));

export function getArmorDef(armorId: string): ArmorDef | undefined {
  return ARMOR_DEF_MAP.get(armorId);
}

/**
 * Grid footprint of the carried (unequipped) plate.
 *
 * **2026-09-12 — 방탄복은 전부 2×2 다** (사용자 결정). 예전에는 초경량 · 광학미채 · I–II 만 2×2 이고 III–V 와 재생은
 * 2×3 이라, 후반 방탄복을 한 벌 챙기는 것만으로 가방 한 줄이 통째로 날아갔다. 등급이 올라갈수록 무거워지는 부담은
 * `weight`(`data/armor.csv`) 가 이미 지고 있으므로 자리까지 이중으로 물릴 이유가 없다.
 *
 * 값이 상수가 된 뒤에도 **함수를 지우지 않는다** — `ItemDefs.armorItem()` 이 이것으로 `width`/`height` 를 채우는
 * 유일한 자리이고, 등급 · 퍽별로 다시 갈라야 할 때 고칠 곳이 여기 하나로 남는다.
 */
export function armorItemSize(_def: ArmorDef): { width: number; height: number } {
  return { width: 2, height: 2 };
}

/** Icon glyph per armor id (procedural text glyph, no asset files) — `data/armor.csv` 의 `icon` 칸. */
export const ARMOR_ICON: Readonly<Record<string, string>> =
  Object.fromEntries(csvRows('armor.csv').map((r) => [r.str('id'), r.str('icon')]));
