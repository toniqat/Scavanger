import type { GameContext, GameStat, ItemDef, LibraryEffect, LibrarySeriesDef, ShelfMedium, SkillId } from '@/shared';
import {
  CORP_DEFS, COOK_GAME_LABEL_KO, LIBRARY_SERIES_DEFS, MEAL_BUFF_LABEL_KO, MEAL_BUFF_UNIT,
  WEAPON_GRADE_ROMAN,
} from '@/shared';
import type { CorpId } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import { gameMinigameLabel } from '../parts/VideoGame';
import { ACTIVE_FURNITURE_DEFS, SHELF_GLYPH, SHELF_UNIT_KO } from '../model';
import { librarySeriesOfItem, shelfHolderMediumOfItem } from '../Rules';
import { clear, el, setText, toggleClass } from './dom';

/* ── Library effect text (shared by the holder screen · the catalogue, 2026-09-13) ───────────────────────────── */

const num = (v: number): string => {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const signed = (v: number, unit: string): string => `${v < 0 ? '−' : '+'}${num(Math.abs(v))}${unit}`;
const pct = (v: number): string => signed(v * 100, ' %');

/** The volume number (`II`) — a digit outside the table. */
export function volumeRoman(volume: number): string {
  return WEAPON_GRADE_ROMAN[volume - 1] ?? String(volume);
}

/** The series tint — one point on the colour wheel picked by an id hash (a book has no grade, so every rarity colour is the same). */
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

/** The stat's Korean name (`ctx.progression.getStatDef`), the id when unknown. */
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
 * One effect line in Korean — `value` is what that line carries right now (or the full-series value). The unit comes from the effect kind: skill gain ·
 * raid XP · trust · gym / cooking score = %, derived = `MEAL_BUFF_UNIT` (the same table as a meal buff). A recipe prints the dish name with no value.
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

/**
 * One game disc line (`console · stat · kind`). The kind goes through `gameMinigameLabel`, the one name a **game disc's**
 * minigame has (`벤치프레스형` · `호흡형` · `사이클형`); the gym equipment names (`GYM_MINIGAME_LABEL_KO`) are a separate list,
 * and pasting `형` onto them here used to print a third variant on this screen alone.
 */
export function gameDiscText(ctx: GameContext, def: ItemDef): string {
  const g = def.gameDisc;
  if (!g) return '';
  const loot = ctx.loot;
  const consoleDef = loot && typeof loot.getAllItemDefs === 'function' ? loot.getAllItemDefs().find((d) => d.gameConsole?.console === g.console) : undefined;
  return `${consoleDef?.name ?? g.console} · ${statName(ctx, g.stat)} · ${gameMinigameLabel(g.minigame)}`;
}

/* ── The catalogue ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Live handle of a rendered catalogue (the holder panel owns one). */
export interface BookDexView {
  root: HTMLElement;
  refresh(): void;
  /** A-3e (2026-09-12): switch the medium the rows list (book · disc · record · 2026-09-13 game disc) and refresh. */
  setMedium(medium: ShelfMedium): void;
}

/** `서적` · `디스크` · `레코드` · `게임 디스크` — the catalogue's summary noun per medium. */
const DEX_NOUN: Readonly<Record<ShelfMedium, string>> = { book: '서적', disc: '디스크', record: '레코드', game: '게임 디스크' };

interface DexRow { root: HTMLElement; key: string }

/** The catalogue thumbnail's edge (px) — the item tile fits whole inside the square box (`buildItemTile`'s cell is derived from it). */
const DEX_THUMB = 48;

/**
 * The **square thumbnail** of a series' lead volume (or of one game disc). It uses the inventory tile (`ctx.inventory.buildItemTile`), and with
 * none stands one glyph in its place. Either way it carries `data-item-tip` + `data-def-id` so `ui/hud/ItemTip` raises the item card.
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
 * The catalogue (Phase 9 → A-3e media → 2026-09-13 series → **2026-09-14 simplified**, user's decision).
 * A row is **the square thumbnail + the name + how many volumes are collected** only — the planets it appears on · the full-series effect text ·
 * the `미발견` word are gone (the effects are told in one place, the rail's 「서재」 row). The volume pips (`.lib-pip`) stay: which volumes are collected is the progress.
 * For game discs it is **one row per disc** (thumbnail · name · `발견` / `0 / 1장`). A row is `.lib-dexrow[data-series]` / `[data-def]`
 * and carries `owned` (at least one volume found) · `complete` (every volume found) · `boosted` (an effect is running now).
 * Hovering the thumbnail raises that item's tooltip. Pure DOM into `host`: no blocker, no listeners — the owner calls `refresh()`.
 */
export function createBookDex(ctx: GameContext, housing: HousingSystem, host: HTMLElement, initial: ShelfMedium = 'book'): BookDexView {
  let medium: ShelfMedium = initial;
  const root = el('div', { cls: 'hs-dex lib-dex', parent: host });
  const summary = el('div', { cls: 'hs-dex-sum', text: '', parent: root });
  const list = el('div', { cls: 'hs-dex-list', parent: root });
  let rows: DexRow[] = [];
  let rowsKey = '';

  /** Series id → volume number → item def (one sweep over all of loot — panel scale). */
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
      // The lead volume = volume 1 (with none, the earliest volume in the table) — the thumbnail and its item tooltip come from it
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
