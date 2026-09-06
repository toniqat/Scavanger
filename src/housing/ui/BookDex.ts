import type { GameContext, ItemDef, SkillId } from '@/shared';
import { SKILL_IDS, buildItemChip } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { clear, el, setText, toggleClass } from './dom';

/** One 도감 row (a skill and its book). */
interface DexRow {
  root: HTMLElement;
  skill: HTMLElement;
  chip: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  mul: HTMLElement;
  defId: string | null;
}

/** Live handle of a rendered 도감 (the bookshelf panel and the 함선 tab each own one). */
export interface BookDexView {
  root: HTMLElement;
  refresh(): void;
}

/**
 * 도감 (Phase 9): one row per skill in `SKILL_IDS` order — 한국어 skill name (from `ctx.progression.getSkillDef`), the
 * book that teaches it (`ItemDef.book.skill`, as an item chip + title), whether it has ever been shelved
 * (`housing.getBookDex()` → 보유 / 미보유) and the current 서재 multiplier for that skill (`housing.getBookBonus`).
 * Pure DOM into `host`: no blocker, no listeners — the owner calls `refresh()` on its own change events.
 */
export function createBookDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement): BookDexView {
  const root = el('div', { cls: 'hs-dex', parent: host });
  const summary = el('div', { cls: 'hs-dex-sum', text: '', parent: root });
  const list = el('div', { cls: 'hs-dex-list', parent: root });
  const rows: DexRow[] = [];
  for (const id of SKILL_IDS) {
    const row = el('div', { cls: 'hs-dex-row', parent: list, attrs: { 'data-skill': id } });
    const skill = el('span', { cls: 'skill', text: id, parent: row });
    const book = el('span', { cls: 'book', parent: row });
    const chip = el('span', { cls: 'chipwrap', parent: book });
    const title = el('span', { cls: 'title', text: '', parent: book });
    const state = el('span', { cls: 'state', text: '', parent: row });
    const mul = el('span', { cls: 'mul', text: '', parent: row });
    rows.push({ root: row, skill, chip, title, state, mul, defId: null });
  }

  const skillName = (id: SkillId): string => {
    try {
      const p = ctx.progression;
      const def = p && typeof p.getSkillDef === 'function' ? p.getSkillDef(id) : null;
      return def?.name || id;
    } catch { return id; }
  };

  /** skill → its book def (one per skill by design; the first wins if a mod adds more). */
  const booksBySkill = (): Map<SkillId, ItemDef> => {
    const out = new Map<SkillId, ItemDef>();
    const loot = ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return out;
    for (const def of loot.getAllItemDefs()) if (def.book && !out.has(def.book.skill)) out.set(def.book.skill, def);
    return out;
  };

  function refresh(): void {
    const dex = housing.getBookDex();
    const books = booksBySkill();
    let owned = 0;
    rows.forEach((row, i) => {
      const id = SKILL_IDS[i];
      const def = books.get(id) ?? null;
      const inDex = !!def && dex.includes(def.id);
      const bonus = housing.getBookBonus(id);
      if (inDex) owned++;
      setText(row.skill, skillName(id));
      if (row.defId !== (def?.id ?? null)) {
        row.defId = def?.id ?? null;
        clear(row.chip);
        if (def) row.chip.appendChild(buildItemChip(def, { size: 22 }));
      }
      setText(row.title, def ? def.name : '해당 서적 없음');
      setText(row.state, inDex ? '보유' : '미보유');
      setText(row.mul, `×${bonus.toFixed(2)}`);
      toggleClass(row.root, 'owned', inDex);
      toggleClass(row.root, 'boosted', bonus > 1 + 1e-9);
    });
    setText(summary, `꽂아 본 서적 ${owned} / ${rows.length} · 배율은 지금 함선 책장에 꽂힌 책 기준`);
  }

  refresh();
  return { root, refresh };
}
