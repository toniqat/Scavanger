import type { GameContext, ItemDef, LibraryEffectsSummary } from '@/shared';
import { CORP_DEFS, COOK_GAME_LABEL_KO, FURNITURE_DEFS, LIBRARY_SERIES_DEFS, LIBRARY_SERIES_MAP, MEAL_BUFF_LABEL_KO } from '@/shared';
import type { CommandFactory } from './types';
import { err } from './types';

/**
 * `library [give <seriesId> [권|all]]` — the library series dev command (2026-09-13, docs/DECISIONS.md
 * 「2026-09-13 — 서재 시리즈 · 비디오게임」). Uses **public refs only**.
 *
 *   - `library`                          the `HousingRef.getLibraryEffects()` summary (one line per target + the
 *                                        opened recipes + the revision).
 *   - `library give <seriesId> [권|all]`  creates that series' media items (the `series` · `volume` of
 *                                        `ItemDef.book` · `disc` · `record`) and puts them in **the stash**
 *                                        (`InventoryRef.tryAddToStash`; with no room, bag → ground =
 *                                        `tryAddItemAnywhere`). An omitted volume means every volume.
 *
 * Shelving (`shelve`) was left out — which holder slot to pick is housing's library screen's job, and an item in
 * the stash can be dragged onto a shelf from that screen.
 */
const USAGE = '사용법: /library [give <시리즈 id> [권|all]]';

/** `0.1` → `+10 %`. */
function pct(v: number): string {
  const n = Math.round(v * 1000) / 10;
  return `${n < 0 ? '−' : '+'}${Math.abs(n)} %`;
}

function skillName(ctx: GameContext, id: string): string {
  try { return ctx.progression?.getSkillDef(id as never)?.name ?? id; } catch { return id; }
}

/** The summed-up summary — a target whose value is 0 is left out. */
function summaryLines(ctx: GameContext, e: LibraryEffectsSummary): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(e.skillGain)) if (v) out.push(`숙련 상승량 · ${skillName(ctx, k)} ${pct(v)}`);
  for (const [k, v] of Object.entries(e.derived)) if (v) out.push(`파생 · ${MEAL_BUFF_LABEL_KO[k as keyof typeof MEAL_BUFF_LABEL_KO] ?? k} ${Math.round(v * 1000) / 1000}`);
  for (const [k, v] of Object.entries(e.gymScore)) if (v) out.push(`운동 점수 · ${FURNITURE_DEFS.find((d) => d.interaction === k)?.name ?? k} ${pct(v)}`);
  for (const [k, v] of Object.entries(e.cookScore)) if (v) out.push(`조리 점수 · ${COOK_GAME_LABEL_KO[k as keyof typeof COOK_GAME_LABEL_KO] ?? k} ${pct(v)}`);
  if (e.raidXp) out.push(`레이드 경험치 ${pct(e.raidXp)}`);
  for (const [k, v] of Object.entries(e.trustXp)) {
    if (v) out.push(`계약 신뢰도 · ${k === 'all' ? '모든 기업' : CORP_DEFS[k as keyof typeof CORP_DEFS]?.name ?? k} ${pct(v)}`);
  }
  if (e.recipes.length) out.push(`열린 레시피 · ${e.recipes.join(', ')}`);
  return out;
}

/** The series' media items (in volume order). */
function seriesItems(ctx: GameContext, seriesId: string): ItemDef[] {
  let defs: readonly ItemDef[] = [];
  try { defs = ctx.loot?.getAllItemDefs() ?? []; } catch { defs = []; }
  return defs
    .filter((d) => (d.book ?? d.disc ?? d.record)?.series === seriesId && !d.retired)
    .sort((a, b) => ((a.book ?? a.disc ?? a.record)?.volume ?? 1) - ((b.book ?? b.disc ?? b.record)?.volume ?? 1));
}

export const library: CommandFactory = () => ({
  name: 'library',
  usage: 'library [give <seriesId> [volume|all]]',
  description: '서재 시리즈 효과 합산을 보거나, 시리즈 매체를 함선 창고에 넣습니다',
  run(args, ctx) {
    if (args.length === 0) {
      const h = ctx.housing;
      if (!h || typeof h.getLibraryEffects !== 'function') return err('하우징에 서재 시리즈(getLibraryEffects) 구현이 아직 없습니다');
      const e = h.getLibraryEffects();
      const lines = summaryLines(ctx, e);
      return `서재 효과 (리비전 ${e.revision})\n${lines.length ? lines.join('\n') : '효과 없음'}`;
    }
    if (args[0].toLowerCase() !== 'give' || args.length < 2 || args.length > 3) return err(USAGE);
    const series = LIBRARY_SERIES_MAP.get(args[1]) ?? LIBRARY_SERIES_DEFS.find((s) => s.id.toLowerCase() === args[1].toLowerCase() || s.name === args[1]);
    if (!series) return err(`알 수 없는 시리즈: ${args[1]}`);
    const inv = ctx.inventory;
    const loot = ctx.loot;
    if (!inv || !loot || typeof inv.tryAddToStash !== 'function') return err('인벤토리 시스템이 준비되지 않았습니다');
    const all = seriesItems(ctx, series.id);
    if (all.length === 0) return err(`${series.name} 시리즈의 아이템 정의가 아직 없습니다`);
    const volArg = (args[2] ?? 'all').toLowerCase();
    let picked = all;
    if (volArg !== 'all') {
      const v = Number(volArg);
      if (!Number.isInteger(v) || v < 1 || v > series.volumes) return err(`권 번호는 1 … ${series.volumes} 또는 all 입니다: ${args[2]}`);
      picked = all.filter((d) => ((d.book ?? d.disc ?? d.record)?.volume ?? 1) === v);
      if (picked.length === 0) return err(`${series.name} ${v}권 아이템 정의가 없습니다`);
    }
    const added: string[] = [];
    const failed: string[] = [];
    for (const d of picked) {
      const item = loot.createItem(d.id, 1);
      if (inv.tryAddToStash(item) || (typeof inv.tryAddItemAnywhere === 'function' && inv.tryAddItemAnywhere(item))) added.push(d.name);
      else failed.push(d.name);
    }
    if (added.length === 0) return err(`넣을 자리가 없습니다: ${failed.join(', ')}`);
    return `함선 창고에 넣었습니다: ${added.join(', ')}${failed.length ? ` (자리 없음: ${failed.join(', ')})` : ''}`;
  },
  complete(args) {
    if (args.length <= 1) return ['give'].filter((n) => n.startsWith((args[0] ?? '').toLowerCase()));
    if (args.length === 2 && args[0].toLowerCase() === 'give') {
      const p = args[1].toLowerCase();
      return LIBRARY_SERIES_DEFS.map((s) => s.id).filter((id) => id.toLowerCase().startsWith(p));
    }
    if (args.length === 3 && args[0].toLowerCase() === 'give') {
      const s = LIBRARY_SERIES_MAP.get(args[1]);
      const opts = ['all', ...Array.from({ length: s?.volumes ?? 0 }, (_, i) => String(i + 1))];
      return opts.filter((o) => o.startsWith(args[2].toLowerCase()));
    }
    return [];
  },
});
