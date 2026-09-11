import type { GameContext, ItemDef } from '@/shared';
import { ANALYZE_DEX_SPEEDUP, buildItemChip } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { clear, el, formatRemaining, setText, toggleClass } from './dom';

/** One 해석 도감 row (a 표본 and what it yields). */
interface DexRow {
  root: HTMLElement;
  chip: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  state: HTMLElement;
  defId: string;
}

/** Live handle of a rendered 해석 도감 (the 분석 화면 owns one; `createBookDex` 와 같은 모양이다). */
export interface SampleDexView {
  root: HTMLElement;
  refresh(): void;
}

/**
 * **해석 도감** (A-12, 2026-09-11): one row per 표본 def (`ItemDef.sample`), shortest 해석 first — item chip + 이름,
 * 기본 해석 시간과 산출물 한 줄, 그리고 회수해 본 적이 있는지(`housing.getSampleDex()` → 해석함 / 미해석).
 * 머리줄은 진척(`getSampleDexRatio`)과 그것이 지금 주는 **해석 속도 보너스**를 적는다 — 도감을 채우는 이유가
 * 화면에 보여야 한다.
 *
 * `ui/BookDex.ts` 와 같은 규약: pure DOM into `host`, no blocker, no listeners — 주인이 자기 이벤트에서
 * `refresh()` 를 부른다. 행 수는 아이템 표가 정하므로 **defs 가 바뀌면 목록을 다시 짓는다**.
 */
export function createSampleDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement): SampleDexView {
  const root = el('div', { cls: 'hs-dex az-dex', parent: host });
  const summary = el('div', { cls: 'hs-dex-sum', text: '', parent: root });
  const list = el('div', { cls: 'hs-dex-list', parent: root });
  let rows: DexRow[] = [];
  let builtKey = '';

  /** Every 표본 def, shortest 해석 first (the item table is the only source — housing invents no list). */
  const sampleDefs = (): ItemDef[] => {
    const loot = ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
    return loot.getAllItemDefs().filter((d) => !!d.sample)
      .slice()
      .sort((a, b) => (a.sample?.analyzeHours ?? 0) - (b.sample?.analyzeHours ?? 0));
  };

  function build(defs: readonly ItemDef[]): void {
    clear(list);
    rows = [];
    if (!defs.length) {
      el('div', { cls: 'hs-empty', text: '아직 알려진 표본이 없습니다', parent: list });
      return;
    }
    for (const def of defs) {
      const row = el('div', { cls: 'hs-dex-row az-dex-row', parent: list, attrs: { 'data-def-id': def.id } });
      const chipwrap = el('span', { cls: 'chipwrap', parent: row });
      chipwrap.appendChild(buildItemChip(def, { size: 22 }));
      const body = el('span', { cls: 'body', parent: row });
      const title = el('span', { cls: 'title', text: def.name, parent: body });
      const sub = el('span', { cls: 'sub', text: '', parent: body });
      const state = el('span', { cls: 'state', text: '', parent: row });
      rows.push({ root: row, chip: chipwrap, title, sub, state, defId: def.id });
    }
  }

  function refresh(): void {
    const defs = sampleDefs();
    const key = defs.map((d) => d.id).join('|');
    if (key !== builtKey) { builtKey = key; build(defs); }
    const dex = housing.getSampleDex();
    const ratio = housing.getSampleDexRatio();
    let known = 0;
    rows.forEach((row, i) => {
      const def = defs[i];
      if (!def || !def.sample) return;
      const inDex = dex.includes(def.id);
      if (inDex) known++;
      const reward = ctx.loot?.getItemDef(def.sample.rewardDefId)?.name ?? def.sample.rewardDefId;
      const first = def.sample.firstDefId ? ctx.loot?.getItemDef(def.sample.firstDefId)?.name ?? def.sample.firstDefId : null;
      setText(row.title, def.name);
      setText(row.sub, `기본 ${formatRemaining(def.sample.analyzeHours * 3600)} · ${reward} ×${def.sample.rewardQty}${first ? ` · 첫 해석 ${first}` : ''}`);
      setText(row.state, inDex ? '해석함' : '미해석');
      toggleClass(row.root, 'owned', inDex);
    });
    // 「지금 해석 시간 n %」는 `analyzeDurationMs` 의 **첫 항**을 그대로 되읽은 것이다 (수치는 csv 에서 온다)
    const left = Math.round((1 - ANALYZE_DEX_SPEEDUP * Math.max(0, Math.min(1, ratio))) * 100);
    setText(summary, rows.length
      ? `해석한 표본 ${known} / ${rows.length} · 도감 진척 ${Math.round(ratio * 100)} % · 지금 해석 시간 ${left} %`
      : '해석한 표본 0 / 0');
  }

  refresh();                 // 첫 `refresh` 가 목록도 함께 짓는다 (`builtKey` 가 아직 비어 있다)
  return { root, refresh };
}
