import type { GameContext, ItemDef, ShelfMedium, SkillId } from '@/shared';
import { SHELF_MEDIA, SHELF_MEDIUM_LABEL_KO, SKILL_IDS, buildItemChip, shelfItemOf } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { clear, el, setText, toggleClass } from './dom';

/** One 도감 row (a skill and the item of the current medium that teaches it). */
interface DexRow {
  root: HTMLElement;
  skill: HTMLElement;
  chip: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  mul: HTMLElement;
  defId: string | null;
}

/** Live handle of a rendered 도감 (the 보관함 panel owns one). */
export interface BookDexView {
  root: HTMLElement;
  refresh(): void;
  /** A-3e (2026-09-12): switch the medium the rows list (책 · 디스크 · 레코드) and refresh. */
  setMedium(medium: ShelfMedium): void;
}

/** 서적 · 디스크 · 레코드 — the 도감 summary noun per medium. */
const DEX_NOUN: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드' };

/**
 * 도감 (Phase 9; A-3e 2026-09-12 — any 서재 medium): one row per skill in `SKILL_IDS` order — 한국어 skill name (from
 * `ctx.progression.getSkillDef`), the item of `medium` that teaches it (`shelfItemOf(def)`, as an item chip + title), whether
 * it has ever been shelved (`housing.getShelfDex(medium)` → 보유 / 미보유) and the current **서재 배율** for that skill
 * (`housing.getBookBonus` = 책 + 디스크 + 레코드 몫의 합; the row's `title` attribute breaks it down per medium).
 * Pure DOM into `host`: no blocker, no listeners — the owner calls `refresh()` on its own change events.
 */
export function createBookDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement, initial: ShelfMedium = 'book'): BookDexView {
  let medium: ShelfMedium = initial;
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

  /** skill → its item of the current medium (one per skill by design; the first wins if a mod adds more). */
  const itemsBySkill = (): Map<SkillId, ItemDef> => {
    const out = new Map<SkillId, ItemDef>();
    const loot = ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return out;
    for (const def of loot.getAllItemDefs()) {
      const s = shelfItemOf(def);
      if (s && s.medium === medium && !out.has(s.skill)) out.set(s.skill, def);
    }
    return out;
  };

  /** Per-medium breakdown for the row tooltip (`getShelfBonus` is optional in the contract — guarded). */
  const breakdown = (id: SkillId): string => {
    if (typeof housing.getShelfBonus !== 'function') return '';
    const info = housing.getShelfBonus(id);
    return SHELF_MEDIA.map((m) => `${SHELF_MEDIUM_LABEL_KO[m]} +${Math.round(info.parts[m] * 100)} %${info.aux[m] ? ' (보조 가구)' : ''}`).join(' · ');
  };

  function refresh(): void {
    const dex = medium === 'book' ? housing.getBookDex() : housing.getShelfDex(medium);
    const items = itemsBySkill();
    let owned = 0;
    rows.forEach((row, i) => {
      const id = SKILL_IDS[i];
      const def = items.get(id) ?? null;
      const inDex = !!def && dex.includes(def.id);
      const bonus = housing.getBookBonus(id);
      if (inDex) owned++;
      setText(row.skill, skillName(id));
      if (row.defId !== (def?.id ?? null)) {
        row.defId = def?.id ?? null;
        clear(row.chip);
        if (def) row.chip.appendChild(buildItemChip(def, { size: 22 }));
      }
      setText(row.title, def ? def.name : `해당 ${DEX_NOUN[medium]} 없음`);
      setText(row.state, inDex ? '보유' : '미보유');
      setText(row.mul, `×${bonus.toFixed(2)}`);
      const tip = bonus > 1 + 1e-9 ? breakdown(id) : '';
      if (row.mul.title !== tip) row.mul.title = tip;
      toggleClass(row.root, 'owned', inDex);
      toggleClass(row.root, 'boosted', bonus > 1 + 1e-9);
    });
    setText(summary, `꽂아 본 ${DEX_NOUN[medium]} ${owned} / ${rows.length} · 배율은 지금 서재에 꽂힌 책 · 디스크 · 레코드 전부 기준`);
  }

  function setMedium(m: ShelfMedium): void {
    if (m !== medium) {
      medium = m;
      for (const row of rows) { row.defId = null; clear(row.chip); }   // chips belong to the old medium
    }
    root.dataset.medium = medium;
    refresh();
  }

  root.dataset.medium = medium;
  refresh();
  return { root, refresh, setMedium };
}
