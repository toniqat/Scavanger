import type { GameContext, GameStat, ItemDef, LibraryEffect, LibrarySeriesDef, ShelfMedium, SkillId } from '@/shared';
import {
  CORP_DEFS, COOK_GAME_LABEL_KO, GYM_MINIGAME_LABEL_KO, LIBRARY_SERIES_DEFS, MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT,
  WEAPON_GRADE_ROMAN,
} from '@/shared';
import type { CorpId } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { ACTIVE_FURNITURE_DEFS, SHELF_GLYPH, SHELF_UNIT_KO } from '../model';
import { librarySeriesOfItem, shelfHolderMediumOfItem } from '../Rules';
import { clear, el, setText, toggleClass } from './dom';

/* ── 서재 효과 글 (보관함 화면 · 도감 공용, 2026-09-13) ──────────────────────────────────────────────────────── */

const num = (v: number): string => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const signed = (v: number, unit: string): string => `${v < 0 ? '−' : '+'}${num(Math.abs(v))}${unit}`;
const pct = (v: number): string => signed(v * 100, ' %');

/** 권 번호 (`II`) — 표 밖이면 숫자. */
export function volumeRoman(volume: number): string {
  return WEAPON_GRADE_ROMAN[volume - 1] ?? String(volume);
}

/** 시리즈 색 — id 해시로 고른 색상환 한 점 (책은 등급이 없어 희귀도 색이 모두 같다). */
export function seriesTint(seriesId: string): string {
  let h = 0;
  for (let i = 0; i < seriesId.length; i++) h = (h * 31 + seriesId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 56%)`;
}

function skillName(ctx: GameContext, id: string): string {
  try {
    const p = ctx.progression;
    return (p && typeof p.getSkillDef === 'function' ? p.getSkillDef(id as SkillId)?.name : '') || id;
  } catch { return id; }
}

/** 능력치 한국어 이름 (`ctx.progression.getStatDef`), 모르면 id. */
export function statName(ctx: GameContext, id: GameStat): string {
  try {
    const p = ctx.progression;
    return (p && typeof p.getStatDef === 'function' ? p.getStatDef(id)?.name : '') || id;
  } catch { return id; }
}

function recipeName(ctx: GameContext, id: string): string {
  const loot = ctx.loot;
  const r = loot && typeof loot.getAllRecipes === 'function' ? loot.getAllRecipes().find((x) => x.id === id) : undefined;
  if (!r) return id;
  return loot?.getItemDef(r.outputDefId)?.name ?? r.name ?? id;
}

/**
 * 효과 줄 하나를 한국어로 — `value` 는 그 줄에 지금 붙은 값(또는 전권 값). 단위는 효과 종류가 정한다: 숙련 상승량 · 레이드 경험치 · 신뢰도 ·
 * 헬스 / 요리 점수 = %, 파생 = `MEAL_BUFF_UNIT`(요리 버프와 같은 표). 레시피는 값 없이 요리 이름.
 */
export function libraryEffectText(ctx: GameContext, e: LibraryEffect, value: number): string {
  switch (e.kind) {
    case 'skillGain': return `${skillName(ctx, e.target)} 상승량 ${pct(value)}`;
    case 'derived': {
      const unit = MEAL_BUFF_UNIT[e.target];
      const amount = unit === '%' ? pct(value) : signed(value, unit ? ` ${unit}` : '');
      return `${MEAL_BUFF_LABEL_KO[e.target] ?? e.target} ${amount}`;
    }
    case 'gymScore': return `${ACTIVE_FURNITURE_DEFS.find((d) => d.interaction === e.target)?.name ?? e.target} 운동 점수 ${pct(value)}`;
    case 'cookScore': return `${COOK_GAME_LABEL_KO[e.target] ?? e.target} 점수 ${pct(value)}`;
    case 'raidXp': return `레이드 경험치 ${pct(value)}`;
    case 'trustXp': return `${e.target === 'all' ? '모든 기업' : CORP_DEFS[e.target as CorpId]?.name ?? e.target} 신뢰도 ${pct(value)}`;
    case 'recipe': return `레시피 · ${recipeName(ctx, e.target)}`;
  }
}

/** 게임 디스크 한 줄 (`게임기 · 능력치 · 방식`). */
export function gameDiscText(ctx: GameContext, def: ItemDef): string {
  const g = def.gameDisc;
  if (!g) return '';
  const loot = ctx.loot;
  const consoleDef = loot && typeof loot.getAllItemDefs === 'function' ? loot.getAllItemDefs().find((d) => d.gameConsole?.console === g.console) : undefined;
  return `${consoleDef?.name ?? g.console} · ${statName(ctx, g.stat)} · ${GYM_MINIGAME_LABEL_KO[g.minigame] ?? g.minigame}형`;
}

/* ── 도감 ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Live handle of a rendered 도감 (the 보관함 panel owns one). */
export interface BookDexView {
  root: HTMLElement;
  refresh(): void;
  /** A-3e (2026-09-12): switch the medium the rows list (책 · 디스크 · 레코드 · 2026-09-13 게임 디스크) and refresh. */
  setMedium(medium: ShelfMedium): void;
}

/** 서적 · 디스크 · 레코드 · 게임 디스크 — the 도감 summary noun per medium. */
const DEX_NOUN: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드', game: '게임 디스크' };

interface DexRow { root: HTMLElement; key: string }

/** 도감 썸네일 한 변 (px) — 정사각 상자 안에 아이템 타일이 통째로 들어간다 (`buildItemTile` 의 cell 을 여기서 유도한다). */
const DEX_THUMB = 48;

/**
 * 시리즈 대표 권(또는 게임 디스크) 하나의 **정사각 썸네일**. 인벤토리 타일(`ctx.inventory.buildItemTile`)을 쓰고, 없으면
 * 글리프 하나로 대신한다. 어느 쪽이든 `data-item-tip` + `data-def-id` 를 달아 `ui/hud/ItemTip` 이 아이템 카드를 띄운다.
 */
function dexThumb(ctx: GameContext, defId: string | null, fallbackGlyph: string): HTMLElement {
  const box = el('div', { cls: 'lib-dex-thumb' });
  if (!defId) { el('span', { cls: 'lib-dex-glyph', text: fallbackGlyph, parent: box }); return box; }
  const inv = ctx.inventory;
  const def = ctx.loot && typeof ctx.loot.getItemDef === 'function' ? ctx.loot.getItemDef(defId) : undefined;
  if (inv && typeof inv.buildItemTile === 'function') {
    const span = Math.max(1, Math.max(def?.width ?? 1, def?.height ?? 1));
    box.appendChild(inv.buildItemTile(defId, 1, { cell: Math.max(16, Math.floor(DEX_THUMB / span)) }));
    return box;
  }
  el('span', { cls: 'lib-dex-glyph', text: def?.icon || fallbackGlyph, parent: box });
  box.dataset.itemTip = '';
  box.dataset.defId = defId;
  return box;
}

/**
 * 도감 (Phase 9 → A-3e 매체 → 2026-09-13 시리즈 → **2026-09-14 단순화**, 사용자 결정).
 * 한 줄은 **정사각 썸네일 + 이름 + 모은 권 수**뿐이다 — 등장 행성 · 전권 효과 설명 · `미발견` 글자는 걷어냈다
 * (효과 이야기는 레일의 「서재」 항목이 한 곳에서 한다). 권 칸(`.lib-pip`)은 남는다: 어느 권을 모았는지가 곧 진척이다.
 * 게임 디스크면 **디스크마다 한 줄**(썸네일 · 이름 · `발견` / `0 / 1장`). 줄은 `.lib-dexrow[data-series]` / `[data-def]`
 * 이고 `owned`(한 권이라도 발견) · `complete`(전권 발견) · `boosted`(지금 효과가 난다) 를 단다.
 * 썸네일에 호버하면 그 아이템 툴팁이 뜬다. Pure DOM into `host`: no blocker, no listeners — the owner calls `refresh()`.
 */
export function createBookDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement, initial: ShelfMedium = 'book'): BookDexView {
  let medium: ShelfMedium = initial;
  const root = el('div', { cls: 'hs-dex lib-dex', parent: host });
  const summary = el('div', { cls: 'hs-dex-sum', text: '', parent: root });
  const list = el('div', { cls: 'hs-dex-list', parent: root });
  let rows: DexRow[] = [];
  let rowsKey = '';

  /** 시리즈 id → 권 번호 → item def (loot 전체를 한 번 훑는다 — 패널 규모). */
  const volumesBySeries = (): Map<string, Map<number, ItemDef>> => {
    const out = new Map<string, Map<number, ItemDef>>();
    const loot = ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return out;
    for (const def of loot.getAllItemDefs()) {
      const s = librarySeriesOfItem(def);
      if (!s) continue;
      let m = out.get(s.seriesId);
      if (!m) { m = new Map(); out.set(s.seriesId, m); }
      if (!m.has(s.volume)) m.set(s.volume, def);
    }
    return out;
  };

  const gameDiscDefs = (): ItemDef[] => {
    const loot = ctx.loot;
    if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
    return loot.getAllItemDefs().filter((d) => shelfHolderMediumOfItem(d) === 'game')
      .sort((a, b) => (a.gameDisc!.console.localeCompare(b.gameDisc!.console)) || a.id.localeCompare(b.id));
  };

  function refreshSeries(): void {
    const dex = new Set(medium === 'book' ? housing.getBookDex() : housing.getShelfDex(medium));
    const seriesList: LibrarySeriesDef[] = LIBRARY_SERIES_DEFS.filter((s) => s.medium === medium);
    const key = `s:${medium}:${seriesList.map((s) => s.id).join(',')}`;
    if (key !== rowsKey) {
      clear(list);
      rows = seriesList.map((s) => ({ root: el('div', { cls: 'lib-dexrow', attrs: { 'data-series': s.id }, parent: list }), key: '' }));
      rowsKey = key;
    }
    const vols = volumesBySeries();
    const states = housing.librarySeriesStates();
    let seenSeries = 0, seenVolumes = 0, allVolumes = 0;
    seriesList.forEach((s, i) => {
      const row = rows[i];
      const byVol = vols.get(s.id) ?? new Map<number, ItemDef>();
      const live = new Set(states.get(s.id)?.volumes ?? []);
      let seen = 0;
      const pips: string[] = [];
      for (let v = 1; v <= s.volumes; v++) {
        const def = byVol.get(v);
        const on = !!def && dex.has(def.id);
        if (on) seen++;
        pips.push(`${on ? 1 : 0}${live.has(v) ? 1 : 0}`);
      }
      allVolumes += s.volumes;
      seenVolumes += seen;
      if (seen > 0) seenSeries++;
      // 대표 권 = 1권 (없으면 표에 있는 가장 앞 권) — 썸네일과 그 아이템 툴팁이 여기서 온다
      const lead = byVol.get(1) ?? [...byVol.values()][0] ?? null;
      const rowKey = `${pips.join('')}|${lead?.id ?? ''}`;
      if (row.key !== rowKey) {
        row.key = rowKey;
        clear(row.root);
        row.root.appendChild(dexThumb(ctx, lead?.id ?? null, SHELF_GLYPH[medium]));
        const body = el('div', { cls: 'lib-dex-body', parent: row.root });
        el('div', { cls: 'lib-dex-name', text: s.name, parent: body });
        const pipBox = el('span', { cls: 'lib-pips', parent: body });
        for (let v = 1; v <= s.volumes; v++) {
          const p = pips[v - 1];
          const pip = el('i', { cls: `lib-pip${p[0] === '1' ? ' is-on' : ''}${p[1] === '1' ? ' is-live' : ''}`, parent: pipBox });
          pip.title = s.volumes > 1 ? `${volumeRoman(v)}권` : '단편';
        }
        el('span', { cls: 'lib-dex-state', text: `${seen} / ${s.volumes}${SHELF_UNIT_KO[medium]}`, parent: row.root });
      }
      toggleClass(row.root, 'owned', seen > 0);
      toggleClass(row.root, 'complete', seen >= s.volumes);
      toggleClass(row.root, 'boosted', live.size > 0);
    });
    setText(summary, seriesList.length
      ? `${seenSeries} / ${seriesList.length} 시리즈 · ${seenVolumes} / ${allVolumes}${SHELF_UNIT_KO[medium]}`
      : `아직 알려진 ${DEX_NOUN[medium]} 시리즈가 없습니다`);
  }

  function refreshGames(): void {
    const dex = new Set(housing.getShelfDex('game'));
    const defs = gameDiscDefs();
    const key = `g:${defs.map((d) => d.id).join(',')}`;
    if (key !== rowsKey) {
      clear(list);
      rows = defs.map((d) => ({ root: el('div', { cls: 'lib-dexrow', attrs: { 'data-def': d.id }, parent: list }), key: '' }));
      rowsKey = key;
    }
    let seen = 0;
    defs.forEach((d, i) => {
      const row = rows[i];
      const on = dex.has(d.id);
      if (on) seen++;
      const rowKey = `${on}`;
      if (row.key !== rowKey) {
        row.key = rowKey;
        clear(row.root);
        row.root.appendChild(dexThumb(ctx, d.id, SHELF_GLYPH.game));
        const body = el('div', { cls: 'lib-dex-body', parent: row.root });
        el('div', { cls: 'lib-dex-name', text: d.name, parent: body });
        el('span', { cls: 'lib-dex-state', text: `${on ? 1 : 0} / 1${SHELF_UNIT_KO.game}`, parent: row.root });
      }
      toggleClass(row.root, 'owned', on);
      toggleClass(row.root, 'complete', on);
      toggleClass(row.root, 'boosted', false);
    });
    setText(summary, defs.length ? `${seen} / ${defs.length}${SHELF_UNIT_KO.game}` : '아직 알려진 게임 디스크가 없습니다');
  }

  function refresh(): void {
    if (medium === 'game') refreshGames(); else refreshSeries();
  }

  function setMedium(m: ShelfMedium): void {
    if (m !== medium) { medium = m; rowsKey = ''; }
    root.dataset.medium = medium;
    refresh();
  }

  root.dataset.medium = medium;
  refresh();
  return { root, refresh, setMedium };
}
