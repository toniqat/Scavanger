import type { AnalysisLevelInfo, AnalysisResultInfo, GameContext, SampleFamily } from '@/shared';
import {
  ANALYSIS_LEVEL_MAX, SAMPLE_FAMILIES, SAMPLE_FAMILY_COLOR, SAMPLE_FAMILY_ICON, SAMPLE_FAMILY_LABEL_KO, buildItemChip,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { clear, el, setText, toggleClass } from './dom';

/** Chip / silhouette edge in a result row (px). */
const ROW_CHIP_PX = 26;

/** One result row (a product of a family's result table). */
interface DexRow {
  root: HTMLElement;
  icon: HTMLElement;
  title: HTMLElement;
  qty: HTMLElement;
  chance: HTMLElement;
  /** What the icon currently shows (`found:<id>` · `sil` · `lock`) — rebuilt only when it changes. */
  iconKey: string;
}

/** One family section. */
interface FamilySection {
  family: SampleFamily;
  lv: HTMLElement;
  xpFill: HTMLElement;
  xpText: HTMLElement;
  mul: HTMLElement;
  list: HTMLElement;
  rows: DexRow[];
  builtKey: string;
}

/** Live handle of a rendered analysis catalogue (the analysis screen owns one; the same shape as `createBookDex`). */
export interface SampleDexView {
  root: HTMLElement;
  refresh(): void;
}

const pctText = (v: number): string => {
  const p = Math.max(0, v) * 100;
  if (p <= 0) return '0 %';
  if (p < 1) return '<1 %';
  return `${Math.round(p)} %`;
};
const qtyText = (min: number, max: number): string => (max > min ? `×${min}–${max}` : `×${min}`);
const mulText = (m: number): string => `×${(Math.round(m * 100) / 100).toFixed(2).replace(/0$/, '')}`;

/**
 * **The analysis catalogue** (A-12 2026-09-11 the old analysis catalogue → **rewritten 2026-09-13**, cooking material tiers — docs/DECISIONS.md 「2026-09-13 — 요리 재료 티어」).
 *
 * Not a list of samples but **the families' result tables** (user's decision: 3 sample families · the analysis level = a shorter
 * time + unlocked results). One section per family (`SAMPLE_FAMILIES` order — cell · mineral · DNA):
 *  - **The header row** — the family chip (`SAMPLE_FAMILY_ICON/COLOR/LABEL_KO`) · `Lv.n` · the XP bar `(xp − levelXp) / (next − levelXp)`
 *    with `n / m` (full + `MAX` at the max level) · 「해석 시간 ×0.85」 (`AnalysisLevelInfo.timeMul`).
 *  - **The result rows** (`getAnalysisResults(family)` order = minimum level → weight) — found (`found`) = the item chip (hover = the item card) + the name /
 *    not found = a **silhouette** (the glyph blacked out, no `data-def-id` — hovering leaks no name) + 「???」 / locked = a faded silhouette + 「Lv.n 해금」,
 *    and on the right the quantity range (`×1–2`) and the chance at the current level (「—」 when locked).
 *
 * The same contract as `ui/BookDex.ts`: pure DOM into `host`, no blocker, no listeners — the owner (`Analyzer`) calls `refresh()`
 * on `housing:analysisChanged` · `housing:analysisFound` · `housing:analysisLevelUp` · `housing:changed`. The rows are rebuilt only
 * when the result table's product list changes; the rest only fixes text · classes · bar widths. A missing item def (another agent's table not there yet) does not break it.
 */
export function createSampleDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement): SampleDexView {
  const root = el('div', { cls: 'hs-dex az-dex', parent: host });
  const summary = el('div', { cls: 'hs-dex-sum', text: '', parent: root });
  const sections: FamilySection[] = SAMPLE_FAMILIES.map((family) => buildSection(root, family));

  function buildSection(parent: HTMLElement, family: SampleFamily): FamilySection {
    const sec = el('section', { cls: 'az-dex-fam', attrs: { 'data-family': family }, parent });
    sec.style.setProperty('--fc', SAMPLE_FAMILY_COLOR[family]);
    const head = el('div', { cls: 'az-dex-head', parent: sec });
    el('span', { cls: 'az-dex-chip', text: `${SAMPLE_FAMILY_ICON[family]} ${SAMPLE_FAMILY_LABEL_KO[family]}`, parent: head });
    const lv = el('span', { cls: 'az-dex-lv', text: '', parent: head });
    const xp = el('span', { cls: 'az-dex-xp', parent: head });
    const xpBar = el('span', { cls: 'az-dex-xpbar', parent: xp });
    const xpFill = el('i', { parent: xpBar });
    const xpText = el('span', { cls: 'az-dex-xptext', text: '', parent: xp });
    const mul = el('span', { cls: 'az-dex-mul', text: '', parent: head });
    const list = el('div', { cls: 'az-dex-list', parent: sec });
    return { family, lv, xpFill, xpText, mul, list, rows: [], builtKey: '' };
  }

  function buildRows(sec: FamilySection, results: readonly AnalysisResultInfo[]): void {
    clear(sec.list);
    sec.rows = [];
    if (!results.length) {
      el('div', { cls: 'hs-empty', text: '알려진 결과가 없습니다', parent: sec.list });
      return;
    }
    for (const r of results) {
      const row = el('div', { cls: 'az-dex-row', attrs: { 'data-def-id-row': r.defId }, parent: sec.list });
      const icon = el('span', { cls: 'az-dex-icon', parent: row });
      const title = el('span', { cls: 'az-dex-title', text: '', parent: row });
      const qty = el('span', { cls: 'az-dex-qty', text: '', parent: row });
      const chance = el('span', { cls: 'az-dex-chance', text: '', parent: row });
      sec.rows.push({ root: row, icon, title, qty, chance, iconKey: '' });
    }
  }

  /** Found = the item chip · not found = a silhouette (the glyph only, blacked out) · locked = a faded silhouette. Rebuilt only when it changes. */
  function paintIcon(row: DexRow, r: AnalysisResultInfo): void {
    const key = r.found ? `found:${r.defId}` : r.unlocked ? 'sil' : 'lock';
    if (row.iconKey === key) return;
    row.iconKey = key;
    clear(row.icon);
    if (r.found) {
      row.icon.appendChild(buildItemChip(housing.defOf(r.defId), { size: ROW_CHIP_PX }));
      return;
    }
    // the silhouette is drawn **by hand** — `buildItemChip` would attach `data-def-id` and the hover card would show the name
    const sil = el('span', { cls: 'az-dex-sil', text: housing.defOf(r.defId)?.icon || '?', parent: row.icon });
    sil.setAttribute('aria-hidden', 'true');
  }

  function paintHead(sec: FamilySection, info: AnalysisLevelInfo): void {
    const max = info.level >= ANALYSIS_LEVEL_MAX || info.nextLevelXp === null;
    setText(sec.lv, `Lv.${info.level}${max ? ' MAX' : ''}`);
    const span = max ? 1 : Math.max(1, (info.nextLevelXp ?? info.levelXp) - info.levelXp);
    const into = max ? 1 : Math.max(0, Math.min(span, info.xp - info.levelXp));
    const w = `${Math.round((into / span) * 100)}%`;
    if (sec.xpFill.style.width !== w) sec.xpFill.style.width = w;
    setText(sec.xpText, max ? `${Math.round(info.xp)} XP` : `${Math.round(into)} / ${Math.round(span)}`);
    setText(sec.mul, `해석 시간 ${mulText(info.timeMul)}`);
    toggleClass(sec.mul, 'boosted', info.timeMul < 1);
  }

  function refresh(): void {
    let found = 0;
    let total = 0;
    for (const sec of sections) {
      const info = safe(() => housing.getAnalysisLevel(sec.family));
      const results = safe(() => housing.getAnalysisResults(sec.family)) ?? [];
      const key = results.map((r) => r.defId).join('|');
      if (key !== sec.builtKey) { sec.builtKey = key; buildRows(sec, results); }
      if (info) paintHead(sec, info);
      results.forEach((r, i) => {
        const row = sec.rows[i];
        if (!row) return;
        total++;
        if (r.found) found++;
        paintIcon(row, r);
        const name = r.found ? housing.nameOf(r.defId) : r.unlocked ? '???' : `Lv.${r.minLevel} 해금`;
        setText(row.title, name);
        setText(row.qty, qtyText(r.qtyMin, r.qtyMax));
        setText(row.chance, r.unlocked ? pctText(r.chance) : '—');
        toggleClass(row.root, 'owned', r.found);
        toggleClass(row.root, 'is-unknown', !r.found && r.unlocked);
        toggleClass(row.root, 'is-locked', !r.unlocked);
      });
    }
    /* 2026-09-16 (user's decision): the two rules are said here — ① the sample's rarity is the **floor** of the product's
     rarity, so the real chance differs with every sample put in (the chances here are for a **common sample**, the widest
     pool), ② one catalogue entry shortens the analysis time of every sample of **the same rarity** (the per-rarity numbers are at the head of the 해석 tab). */
  setText(summary, `발견한 산출물 ${found} / ${total} · 확률은 일반 표본 기준 — 표본 등급이 산출물 등급의 하한이라`
    + ` 높은 등급 표본일수록 아래쪽 결과가 빠집니다. 도감 한 칸은 같은 등급 표본의 해석을 빠르게 합니다.`);
  }

  refresh();                 // the first `refresh` builds the rows too (`builtKey` is still empty)
  return { root, refresh };
}

/** When the housing side is not implemented yet (another agent still at work) or throws, only that one catalogue section empties and the screen lives. */
function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}
