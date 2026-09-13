import type { AnalysisLevelInfo, AnalysisResultInfo, GameContext, SampleFamily } from '@/shared';
import {
  ANALYSIS_LEVEL_MAX, SAMPLE_FAMILIES, SAMPLE_FAMILY_COLOR, SAMPLE_FAMILY_ICON, SAMPLE_FAMILY_LABEL_KO, buildItemChip,
} from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { clear, el, setText, toggleClass } from './dom';

/** Chip / silhouette edge in a 결과 row (px). */
const ROW_CHIP_PX = 26;

/** One 결과 row (an 산출물 of a family's 결과표). */
interface DexRow {
  root: HTMLElement;
  icon: HTMLElement;
  title: HTMLElement;
  qty: HTMLElement;
  chance: HTMLElement;
  /** What the icon currently shows (`found:<id>` · `sil` · `lock`) — rebuilt only when it changes. */
  iconKey: string;
}

/** One 계열 구획. */
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

/** Live handle of a rendered 분석 도감 (the 분석 화면 owns one; `createBookDex` 와 같은 모양이다). */
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
 * **분석 도감** (A-12 2026-09-11 해석 도감 → **2026-09-13 재작성**, 요리 재료 티어 — docs/plans/food-tiers.md §5).
 *
 * 표본 목록이 아니라 **계열 결과표**다 (사용자 결정: 표본 3계열 · 분석 레벨 = 시간 단축 + 결과 해금). 계열
 * (`SAMPLE_FAMILIES` 순서 — 세포 · 광물 · DNA)마다 한 구획:
 *  - **머리줄** — 계열 칩(`SAMPLE_FAMILY_ICON/COLOR/LABEL_KO`) · `Lv.n` · 경험치 막대 `(xp − levelXp) / (next − levelXp)` 와
 *    `n / m` (최대 레벨이면 가득 + `MAX`) · 「해석 시간 ×0.85」 (`AnalysisLevelInfo.timeMul`).
 *  - **결과 행** (`getAnalysisResults(family)` 순서 = 최소 레벨 → 가중치) — 발견(`found`) = 아이템 칩(호버 = 아이템 카드) + 이름 /
 *    미발견 = **실루엣**(글리프를 검게, `data-def-id` 없음 — 호버로 이름이 새지 않는다) + 「???」 / 잠김 = 흐린 실루엣 + 「Lv.n 해금」,
 *    오른쪽에 개수 범위(`×1–2`)와 지금 레벨의 확률(잠김이면 「—」).
 *
 * `ui/BookDex.ts` 와 같은 규약: pure DOM into `host`, no blocker, no listeners — 주인(`Analyzer`)이 `housing:analysisChanged` ·
 * `housing:analysisFound` · `housing:analysisLevelUp` · `housing:changed` 에서 `refresh()` 를 부른다. 행은 결과표의 산출물 목록이
 * 바뀔 때만 다시 짓고, 나머지는 글자 · 클래스 · 막대 폭만 고친다. 아이템 def 가 없어도(다른 에이전트의 표가 아직) 깨지지 않는다.
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

  /** 발견 = 아이템 칩 · 미발견 = 실루엣(글리프만, 검게) · 잠김 = 흐린 실루엣. 바뀔 때만 다시 짓는다. */
  function paintIcon(row: DexRow, r: AnalysisResultInfo): void {
    const key = r.found ? `found:${r.defId}` : r.unlocked ? 'sil' : 'lock';
    if (row.iconKey === key) return;
    row.iconKey = key;
    clear(row.icon);
    if (r.found) {
      row.icon.appendChild(buildItemChip(housing.defOf(r.defId), { size: ROW_CHIP_PX }));
      return;
    }
    // 실루엣은 **직접** 그린다 — `buildItemChip` 은 `data-def-id` 를 달아 호버 카드가 이름을 보여 주기 때문이다
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
    setText(summary, `발견한 산출물 ${found} / ${total} · 분석 레벨이 오르면 해석이 빨라지고 새 결과가 열립니다`);
  }

  refresh();                 // 첫 `refresh` 가 행도 함께 짓는다 (`builtKey` 가 아직 비어 있다)
  return { root, refresh };
}

/** housing 쪽 구현이 아직 없거나(다른 에이전트 작업 중) 던지면 도감 한 구획만 비우고 화면은 산다. */
function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}
