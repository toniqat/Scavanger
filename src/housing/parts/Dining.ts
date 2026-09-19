/**
 * src/housing/parts/Dining.ts — **the dining table · the plate** (A-3c 2026-09-11 → 2026-09-16 the plate model, user's decision — the contract is the plate section of `shared/housing.ts`).
 *
 * 「A meal is not an item. A meal finished at the cook bench becomes **the one plate on the personal ship's dining table**, and eating at the table loads one raid's worth.」
 *
 *   • There is one plate per ship (`ShipState.plate`). Cooking again **replaces** the old plate — the warning is raised by the screen before the cook starts
 *     (`ui/cook/PlateAsk`), and the only rule here is 「a finished meal covers the plate」 (`setPlate`).
 *   • **Eating does not use the plate up.** Eating = the one line `ProgressionRef.useMeal(meal, quality)` — the pending meal · refusing the same meal · replacing it · carrying
 *     it over on launch are all progression's rules, and housing only asks.
 *   • At the start of the next raid (`game:newMission`, the training range excepted — the same condition as where game/ calls `armPreps`) the plate is taken away and saved.
 *   • The shared ship's **fixed table** (`uid` null) holds the personal plate + squadmates' plates (`squadPlates`, filled by net from `net:squadPlate`), and anyone's
 *     can be eaten (it becomes the eater's pending meal). The old 「분대에 차리기」 (`serveMealToSquad` · `housing:mealServed`) was replaced by this.
 *
 * There are two kinds of dining table: the personal ship's **furniture** (`interaction: 'dining_table'` — `uid` is that furniture) · the shared ship's **fixed table** (an
 * interaction point hub planted, so `uid` is null). With no dining-table furniture the cook bench cannot be used (`hasDiningTable` → the gate in `parts/Cooking`).
 */
import type { DiningPlate, MealItemDef, TablePlateInfo } from '@/shared';
import { getMealDef, normalizeMealQuality } from '@/shared';
import { isDiningTableDefId } from '../ShipState';
import type { HousingSystem } from '../HousingSystem';

/** One squadmate's plate (the shared ship's table) — keyed by PeerId. */
export interface SquadPlate { name: string; plate: DiningPlate }

/** Whether the player stands at the shared ship's fixed table (it is the only table with no uid). */
export function isSharedTable(sys: HousingSystem): boolean {
  return sys.ctx.hub?.ship === 'shared';
}

/** The dining-table furniture behind `uid`, or null when it is not one (or gone). */
export function diningTableOf(sys: HousingSystem, uid: string) {
  const item = sys.getPlacedByUid(uid);
  return item && isDiningTableDefId(item.defId) ? item : null;
}

/** Whether dining-table furniture is placed on the personal ship (a table in the furniture stash is not counted). The cook bench gate. */
export function hasDiningTable(sys: HousingSystem): boolean {
  return sys.state.furniture.some((f) => isDiningTableDefId(f.defId));
}

/**
 * Why the dining table cannot be used right now (null = it is fine). It does not open during a raid — a meal is eaten **before launch**.
 */
export function diningBlock(sys: HousingSystem, uid: string | null): string | null {
  const ctx = sys.ctx;
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 쓸 수 있습니다';
  if (uid === null) return isSharedTable(sys) ? null : '식탁이 없습니다';
  return diningTableOf(sys, uid) ? null : '식탁이 아닙니다';
}

/** The meal def (`shared/meals`), null when it is not a meal. */
export function mealDef(_sys: HousingSystem, defId: string): MealItemDef | null {
  return getMealDef(defId) ?? null;
}

/* ── The plate ────────────────────────────────────────────────────────────── */
/** The plate on the personal ship's dining table (an id the meal table does not know counts as none). */
export function getPlate(sys: HousingSystem): DiningPlate | null {
  const p = sys.state.plate;
  return p && getMealDef(p.mealDefId) ? p : null;
}

function samePlate(a: DiningPlate | null | undefined, b: DiningPlate | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.mealDefId === b.mealDefId && normalizeMealQuality(a.quality) === normalizeMealQuality(b.quality);
}

function emitPlate(sys: HousingSystem, reason: 'cooked' | 'raid' | 'profile' | 'dev'): void {
  const b = sys.ctx.bus;
  b.emit('housing:plateChanged', { plate: getPlate(sys), reason });
  emitTablePlates(sys);
}

export function emitTablePlates(sys: HousingSystem): void {
  sys.ctx.bus.emit('housing:tablePlatesChanged', { count: (getPlate(sys) ? 1 : 0) + sys.squadPlates.size });
}

/**
 * Puts a plate on the personal table (the old plate is **replaced**). The save is `saveSoon` — it emits no `housing:changed`, so hub does not rebuild the ship's furniture
 * wholesale (only the dining-table piece, from `housing:tablePlatesChanged`). Returns the old plate it took away (null with none).
 */
export function setPlate(sys: HousingSystem, mealDefId: string, quality: number, reason: 'cooked' | 'dev'): DiningPlate | null {
  const before = getPlate(sys);
  sys.state.plate = { mealDefId, quality: normalizeMealQuality(quality), cookedAt: sys.nowMs() };
  sys.saveSoon();
  emitPlate(sys, reason);
  return before;
}

/** Takes the personal plate away (a raid start · dev). true when something was taken. */
export function clearPlate(sys: HousingSystem, reason: 'raid' | 'dev'): boolean {
  if (!sys.state.plate) return false;
  sys.state.plate = null;
  sys.saveSoon();
  emitPlate(sys, reason);
  return true;
}

/** The server copy replaced the state — announces it when the plate differs (`HousingSystem.onProfileLoaded`). */
export function afterStateReplaced(sys: HousingSystem, before: DiningPlate | null): void {
  if (!samePlate(before, getPlate(sys))) emitPlate(sys, 'profile');
}

/**
 * The plates on that table — the personal ship's table (`uid`) holds the player's own only, the shared ship's fixed table (`null`) the player's own + squadmates' (only while standing in the shared ship).
 * The player's own plate first, the rest by name.
 */
export function getTablePlates(sys: HousingSystem, uid: string | null): TablePlateInfo[] {
  const out: TablePlateInfo[] = [];
  const mine = getPlate(sys);
  if (mine) out.push({ ...mine, ownerId: null, ownerName: sys.ctx.net?.playerName || '나', mine: true });
  if (uid === null && isSharedTable(sys)) {
    const others: TablePlateInfo[] = [];
    for (const [id, s] of sys.squadPlates) {
      if (!getMealDef(s.plate.mealDefId)) continue;
      others.push({ ...s.plate, ownerId: id, ownerName: s.name || '분대원', mine: false });
    }
    others.sort((a, b) => a.ownerName.localeCompare(b.ownerName, 'ko'));
    out.push(...others);
  }
  return out;
}

function plateOf(sys: HousingSystem, uid: string | null, ownerId: string | null | undefined): DiningPlate | null {
  if (!ownerId) return getPlate(sys);
  if (uid !== null) return null;                                   // a squadmate's plate exists only on the shared ship's fixed table
  return sys.squadPlates.get(ownerId)?.plate ?? null;
}

/* ── Eating ───────────────────────────────────────────────────────────────── */
/**
 * The Korean reason that plate cannot be eaten right now (null = it can). It is a query for the screen's button state — the real refusal is what `eatPlate` gets back
 * from `progression.useMeal`. 「이미 먹었다」 is a **display** compared against progression's pending meal (the rule lives there).
 */
export function plateEatBlock(sys: HousingSystem, uid: string | null, ownerId?: string | null): string | null {
  const block = diningBlock(sys, uid);
  if (block) return block;
  const plate = plateOf(sys, uid, ownerId);
  if (!plate) return ownerId ? '그 접시가 없습니다' : '차린 요리가 없습니다';
  const prog = sys.ctx.progression;
  if (!prog || typeof prog.useMeal !== 'function') return '식사를 실을 수 없습니다';
  const q = normalizeMealQuality(plate.quality);
  const pendingQ = typeof prog.getMealQuality === 'function' ? prog.getMealQuality() : 0;
  if (prog.getMeal() === plate.mealDefId && pendingQ === q) return '이미 먹었습니다';
  return null;
}

/**
 * Eats a plate — **the plate is left alone** and `progression.useMeal(meal, quality)` loads the pending meal (replacing another meal already loaded).
 * `ownerId` omitted · null = the player's own plate, a PeerId = a squadmate's plate on the shared ship's table. A Korean reason / null.
 */
export function eatPlate(sys: HousingSystem, uid: string | null, ownerId?: string | null): string | null {
  const block = diningBlock(sys, uid);
  if (block) return block;
  const plate = plateOf(sys, uid, ownerId);
  if (!plate) return ownerId ? '그 접시가 없습니다' : '차린 요리가 없습니다';
  if (!getMealDef(plate.mealDefId)) return '알 수 없는 요리입니다';
  const prog = sys.ctx.progression;
  if (!prog || typeof prog.useMeal !== 'function') return '식사를 실을 수 없습니다';
  const refusal = prog.useMeal(plate.mealDefId, normalizeMealQuality(plate.quality));
  if (refusal) return refusal;
  sys.ctx.bus.emit('audio:play', { id: 'ui_equip' });
  return null;
}

/** Dev · smoke tests: puts a plate on the personal table with no cook. */
export function devSetPlate(sys: HousingSystem, mealDefId: string, quality = 0): string | null {
  if (!getMealDef(mealDefId)) return `요리가 아닙니다: ${mealDefId}`;
  setPlate(sys, mealDefId, quality, 'dev');
  return null;
}

/* ── Squadmate plates (the shared ship) ──────────────────────────────────── */
function setSquadPlate(sys: HousingSystem, id: string, name: string, plate: DiningPlate | null): void {
  const prev = sys.squadPlates.get(id);
  if (!plate || !getMealDef(plate.mealDefId)) {
    if (!prev) return;
    sys.squadPlates.delete(id);
  } else {
    const next: DiningPlate = { mealDefId: plate.mealDefId, quality: normalizeMealQuality(plate.quality), cookedAt: plate.cookedAt };
    if (prev && prev.name === name && samePlate(prev.plate, next)) return;
    sys.squadPlates.set(id, { name, plate: next });
  }
  emitTablePlates(sys);
}

function clearSquadPlates(sys: HousingSystem): void {
  if (sys.squadPlates.size === 0) return;
  sys.squadPlates.clear();
  emitTablePlates(sys);
}

/** Opens the dining screen (`dining_table` interaction). `uid` null = the shared ship's fixed table. */
export function openDiningTable(sys: HousingSystem, uid: string | null): void {
  if (!sys.diningTable) return;
  const block = diningBlock(sys, uid);
  if (block) { sys.notify(block, 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.diningTable.openTable(uid);
}

/** The outside events that cut a plate's lifetime — once, in `init`. */
export function bindDining(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  return [
    /* The next raid started — an uneaten plate is taken away (user's decision). The condition is the same as where game/ calls `armPreps`: the training range is
       not a raid (`parts/Phases` — `if (!isTraining()) armPreps()`). Squadmates' plates all left for that raid too — back on the ship and into a hub session,
       net asks again with `plateq sync`. */
    b.on('game:newMission', ({ mode }) => {
      if (mode !== 'training') clearPlate(sys, 'raid');
      clearSquadPlates(sys);
    }),
    b.on('net:squadPlate', ({ id, name, plate }) => setSquadPlate(sys, id, name, plate)),
    b.on('net:lobbyLeft', () => clearSquadPlates(sys)),
    // a departed squadmate's plate comes off the table (including a link that dropped before net could send null)
    b.on('net:lobbyUpdated', ({ lobby }) => {
      let changed = false;
      for (const id of Array.from(sys.squadPlates.keys())) {
        if (!lobby.players.some((p) => p.id === id)) { sys.squadPlates.delete(id); changed = true; }
      }
      if (changed) emitTablePlates(sys);
    }),
  ];
}
