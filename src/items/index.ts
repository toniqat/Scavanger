export * from './ItemDefs';
export * from './WeaponDefs';
export * from './WeaponStats';
export * from './ArmorDefs';
export * from './ImplantDefs';
export * from './Recipes';
/* appended (2026-09-10): 내구도 연동 분해 · 수리 — `getRecipe` · `ALL_CRAFT_RECIPES` 는 여기로 옮겨졌다 */
export * from './Salvage';
export * from './LootTables';
/* appended (2026-09-15, 가젯 개편): 설명 인라인 마크업 · 카드 스펙 줄 — 두 툴팁이 같은 함수를 부른다 */
export * from './ItemText';
export * from './ItemSpec';
export { LootService, nextUid } from './Loot';
