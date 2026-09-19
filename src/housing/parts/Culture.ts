/**
 * src/housing/parts/Culture.ts — **the greenhouse culture tank** (A-14, 2026-09-11).
 *
 * 「Pour a medium in, put a strain on it, and it grows for that much real time into a culture product.」
 * It is the analyzer (`parts/Lab.ts`) and the grow station (`parts/Garden.ts`) merged — **the level opens slots, like the**
 * **analyzer** (`cultureSlotsForLevel`, Lv.1 = 1 slot … Lv.3 = 3 slots; slot numbers do not shift on an upgrade), and there are
 * **two steps, like the greenhouse** (① `fillMedium` the medium → ② `insertStrain` the strain). A medium wears **once per**
 * **harvest** (`mediumUsesLeft`) and at 0 the slot empties completely. The culture time is fixed into `readyAt` **the moment it**
 * **goes in**: swapping the medium or raising the gardening skill afterwards never moves a running timer.
 *
 * The pure judgements (culture time · progress · seconds left) are all in `../Rules.ts`; this file changes state.
 *
 * **2026-09-13 (cooking material tiers — docs/DECISIONS.md 「2026-09-13 — 요리 재료 티어」)**: a medium follows **the same durability**
 * **rule as soil** — it wears `MEDIUM_WEAR_PER_HARVEST` per harvest, **the slot does not empty even at 0**, and the medium's speed bonus · the sockets' `speed` · `yield` apply by the durability ratio.
 * `mediumUsesLeft` is 「harvests left until 0」. A slot may hold a **culture scaffold**: medium → (scaffold) → strain. With a scaffold
 * in it the strain's `scaffoldOutputDefId` (meat of that species) is made over `scaffoldHours` and **the scaffold is consumed on**
 * **harvest**. Before the strain goes in, `takeScaffold` gives it back. A retired strain (no `strain` data) is refused by the tank.
 *
 * **2026-09-17 (the culture start confirm — user's decision)**: inserting a strain **does not start the culture**. The slot stands
 * 「시작 대기」 (only `strainDefId`, no `startedAt` · `readyAt`), and the screen's 「배양 시작」 → a 1 s hold confirm calls `startCulture`, which fixes `readyAt` **at that moment**.
 * Before the start the strain (`takeStrain`) · the scaffold (`takeScaffold`) · a never-used medium (`takeMedium`) all come back; after
 * it none of the three can be taken out. 「Has it started」 is the one test `startedAt > 0` — an old save's strain started the moment it
 * went in and always carries `startedAt`, so it keeps culturing with no migration (`ShipState.sanitize` keeps a waiting slot by the same test).
 */
import type { CultureSlot, CultureSlotInfo, HarvestDestination, ItemDef, PlacedFurniture } from '@/shared';
import { CULTURE_MAX_SLOTS, MEDIUM_WEAR_PER_HARVEST, cultureSlotUnlockLevel, cultureSlotsForLevel, growSocketSlotsFor } from '@/shared';
import {
  cultureDurationMs, durabilityFromUses, durabilityRatio, growProgress, growRemainingS, harvestsUntilWorn, wearAfterHarvest,
} from '../Rules';
import { insertSocket, sanitizeSocketIds, socketSum, yieldBonus } from './Sockets';
import { isCultureTankDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * The culture slots. The save only shape-checks the ids; the first time `ctx.loot` is around, every id that is no longer a
 * real medium / strain is dropped here (the same contract as the library's `books()` · the greenhouse's `grows()` · the lab's
 * `analyses()` — a def gone from the item table must not break the culture tank). An unknown strain leaves plain medium
 * behind, exactly like an unknown seed leaves plain soil.
 */
export function cultures(sys: HousingSystem): CultureSlot[] {
  if (!Array.isArray(sys.state.cultures)) sys.state.cultures = [];
  const list = sys.state.cultures;
  if (!sys.culturesPruned && sys.ctx?.loot && typeof sys.ctx.loot.getItemDef === 'function') {
    sys.culturesPruned = true;
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (!sys.defOf(c.mediumDefId)?.medium) {
        console.warn(`[housing] unknown medium '${c.mediumDefId}' dropped from 배양조 ${c.uid}`);
        list.splice(i, 1);
        continue;
      }
      // 2026-09-13: a retired strain has no `strain` data — only the strain fields are deleted and the medium stays (the same path as an unknown id)
      if (c.strainDefId && !sys.defOf(c.strainDefId)?.strain) {
        console.warn(`[housing] unknown / retired strain '${c.strainDefId}' dropped from 배양조 ${c.uid}`);
        delete c.strainDefId; delete c.startedAt; delete c.readyAt;
      }
      if (c.scaffoldDefId && !sys.defOf(c.scaffoldDefId)?.scaffold) {
        console.warn(`[housing] '${c.scaffoldDefId}' is not a 배양 스캐폴드 — dropped from 배양조 ${c.uid}`);
        delete c.scaffoldDefId;
      }
      normalizeMedium(sys, c, true);
    }
  }
  return list;
}

/* ── medium durability (2026-09-13) ─────────────────────────────────────── */
/** One medium kind's maximum durability — `MediumDef.durability`. With no value (an old item table), the old harvest count × the wear per harvest. */
export function mediumMaxDurability(def: ItemDef | null | undefined): number {
  const m = def?.medium;
  if (!m) return 0;
  const d = (m as { durability?: number }).durability;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return Math.max(1, Math.floor(Number.isFinite(m.uses) ? m.uses : 1)) * Math.max(0, MEDIUM_WEAR_PER_HARVEST);
}

/** Brings one slot's medium state in line with the rules (the same shape as `normalizeSoil` in `parts/Garden`). Does nothing when the medium def is unknown. */
function normalizeMedium(sys: HousingSystem, c: CultureSlot, withSockets: boolean): void {
  const def = sys.mediumDef(c.mediumDefId);
  if (!def || !def.medium) return;
  const max = mediumMaxDurability(def);
  if (typeof c.mediumDurability !== 'number' || !Number.isFinite(c.mediumDurability)) {
    c.mediumDurability = durabilityFromUses(max, c.mediumUsesLeft, def.medium.uses);
  }
  c.mediumDurability = Math.max(0, Math.min(max, c.mediumDurability));
  if (withSockets || !Array.isArray(c.sockets)) c.sockets = sanitizeSocketIds(sys, c.sockets ?? [], 'medium', growSocketSlotsFor(def.rarity));
  c.mediumUsesLeft = harvestsUntilWorn(c.mediumDurability, MEDIUM_WEAR_PER_HARVEST, socketSum(sys, c.sockets, 'wear'));
}

/** One set of the slot's medium numbers. All 0 when the medium def is unknown (the speed multiplier is 1). */
function mediumStats(sys: HousingSystem, c: CultureSlot): { max: number; dur: number; ratio: number; slots: number; speedMul: number } {
  const def = sys.mediumDef(c.mediumDefId);
  if (!def || !def.medium) return { max: 0, dur: 0, ratio: 0, slots: 0, speedMul: 1 };
  normalizeMedium(sys, c, false);
  const max = mediumMaxDurability(def);
  const dur = c.mediumDurability ?? 0;
  return { max, dur, ratio: durabilityRatio(dur, max), slots: growSocketSlotsFor(def.rarity), speedMul: def.medium.speedMul };
}

/** What this strain makes in a slot holding a scaffold — all three values must be there. null otherwise (that strain does not grow on a scaffold). */
function scaffoldOutputOf(def: ItemDef | null): { defId: string; qty: number; hours: number } | null {
  const s = def?.strain;
  if (!s || !s.scaffoldOutputDefId) return null;
  const qty = Math.max(1, Math.floor(Number.isFinite(s.scaffoldOutputQty) ? s.scaffoldOutputQty as number : 1));
  const hours = Number.isFinite(s.scaffoldHours) && (s.scaffoldHours as number) > 0 ? s.scaffoldHours as number : s.cultureHours;
  return { defId: s.scaffoldOutputDefId, qty, hours };
}

/** What the strain in this slot would make right now (the scaffold folded in). null with no strain. */
function outputOf(sys: HousingSystem, c: CultureSlot): { defId: string; qty: number; usesScaffold: boolean } | null {
  const def = c.strainDefId ? sys.strainDef(c.strainDefId) : null;
  if (!def || !def.strain) return null;
  const sc = c.scaffoldDefId ? scaffoldOutputOf(def) : null;
  if (sc) return { defId: sc.defId, qty: sc.qty, usesScaffold: true };
  return { defId: def.strain.outputDefId, qty: Math.max(1, Math.floor(def.strain.outputQty)), usesScaffold: false };
}

/** The culture tank behind `uid`, or null when it is not one (or gone). */
export function tankOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isCultureTankDefId(item.defId) ? item : null;
}

export function cultureAt(sys: HousingSystem, uid: string, slot: number): CultureSlot | null {
  return sys.cultures().find((c) => c.uid === uid && c.slot === slot) ?? null;
}

/** 2026-09-17: has the culture started (is a timer running). With a strain and false it is 「시작 대기」 — what went in still comes back. */
export function cultureStarted(c: CultureSlot | null | undefined): boolean {
  return !!c && typeof c.startedAt === 'number' && c.startedAt > 0 && typeof c.readyAt === 'number';
}

/** 2026-09-17: a never-used medium — no strain · scaffold · socket, and full durability (`takeMedium` gives it back). */
function mediumPristine(sys: HousingSystem, c: CultureSlot): boolean {
  if (c.strainDefId || c.scaffoldDefId || (c.sockets?.length ?? 0) > 0) return false;
  const st = mediumStats(sys, c);
  return st.max > 0 && st.dur >= st.max;
}

/** Drop every culture slot of a tank that is being recovered (its medium · strain go with it). */
export function dropCulturesOf(sys: HousingSystem, uid: string): void {
  const list = sys.cultures();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Finished slots of a tank (the `housing:cultureChanged` payload and the hub's glowing tubes). */
export function readyCultures(sys: HousingSystem, uid: string): number {
  const now = sys.stationNow(uid);
  return sys.cultures().filter((c) => c.uid === uid && !!c.readyAt && now >= c.readyAt).length;
}

export function cultureChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:cultureChanged', { uid, ready: sys.readyCultures(uid) });
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** The medium def with its `medium` data, or null when `defId` is not a medium. */
export function mediumDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.medium ? def : null;
}

/** The strain def with its `strain` data, or null when `defId` is not a strain. */
export function strainDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.strain ? def : null;
}

/* ── what the culture screen reads ──────────────────────────────────────── */
/**
 * Every culture slot of one tank — **always `CULTURE_MAX_SLOTS`** in slot order, locked ones included so the panel can draw
 * the slots an upgrade will open. `[]` when `uid` is not a culture tank.
 */
export function getCultureSlots(sys: HousingSystem, uid: string): CultureSlotInfo[] {
  const tank = sys.tankOf(uid);
  if (!tank) return [];
  const now = sys.stationNow(uid);
  const open = cultureSlotsForLevel(tank.level);
  const out: CultureSlotInfo[] = [];
  for (let slot = 0; slot < CULTURE_MAX_SLOTS; slot++) {
    const locked = slot >= open;
    const c = locked ? null : sys.cultureAt(uid, slot);
    const medium = c ? sys.mediumDef(c.mediumDefId)?.medium ?? null : null;
    const st = c ? mediumStats(sys, c) : null;
    const output = c ? outputOf(sys, c) : null;
    out.push({
      slot, locked, unlockLevel: cultureSlotUnlockLevel(slot),
      mediumDefId: c?.mediumDefId ?? null,
      // 2026-09-13: its meaning changed to 「harvests left until durability 0」 (the slot stays even at 0)
      mediumUsesLeft: c?.mediumUsesLeft ?? 0,
      mediumSpeedMul: medium?.speedMul ?? 1,
      strainDefId: c?.strainDefId ?? null,
      // progress · seconds left are the same pure time arithmetic as the greenhouse's · the lab's (those two in `Rules` know nothing of what is growing)
      progress: growProgress(now, c?.startedAt, c?.readyAt),
      remainingS: growRemainingS(now, c?.readyAt),
      ready: !!c?.readyAt && now >= c.readyAt,
      // 2026-09-13: with a scaffold, meat of that species (`outputOf`)
      yieldDefId: output?.defId ?? null,
      yieldQty: output?.qty ?? 0,
      mediumDurability: st?.dur ?? 0,
      mediumDurabilityMax: st?.max ?? 0,
      mediumBonusRatio: st?.ratio ?? 0,
      sockets: c?.sockets ? [...c.sockets] : [],
      socketSlots: st?.slots ?? 0,
      scaffoldDefId: c?.scaffoldDefId ?? null,
      // 2026-09-17: a waiting slot is `started` false even with a `strainDefId` (progress −1 · 0 left come out by themselves, from the missing `readyAt`)
      started: cultureStarted(c),
      mediumReturnable: !!c && mediumPristine(sys, c),
    });
  }
  return out;
}

/** Medium item defs the player owns right now (bag + stash), lowest maximum durability first (2026-09-13) — the culture screen's hint. */
export function getOwnedMediums(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.medium) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => mediumMaxDurability(sys.mediumDef(a.defId)) - mediumMaxDurability(sys.mediumDef(b.defId)));
  return out;
}

/** Strain item defs the player owns (bag + stash), shortest culture first. */
export function getOwnedStrains(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.strain) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.strainDef(a.defId)?.strain?.cultureHours ?? 0) - (sys.strainDef(b.defId)?.strain?.cultureHours ?? 0));
  return out;
}

/* ── the Korean block reasons ───────────────────────────────────────────── */
/** Why `uid` / `slot` is not a usable culture slot right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, slot: number): string | null {
  const tank = sys.tankOf(uid);
  if (!tank) return '배양조가 아닙니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= CULTURE_MAX_SLOTS) return '없는 배양 칸입니다';
  if (slot >= cultureSlotsForLevel(tank.level)) return `배양조를 Lv.${cultureSlotUnlockLevel(slot)} 로 강화해야 열립니다`;
  return null;
}

/* ── slot mutations ─────────────────────────────────────────────────────── */
/**
 * Pour one nutrient medium (bag → stash, consumes 1) into an empty slot. 2026-09-13: durability at maximum · no sockets ·
 * `mediumUsesLeft` = harvests left until 0. A Korean reason on failure, null on success.
 */
export function fillMedium(sys: HousingSystem, uid: string, slot: number, mediumDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  if (sys.cultureAt(uid, slot)) return '이미 배지가 채워져 있습니다';
  const def = sys.mediumDef(mediumDefId);
  if (!def || !def.medium) return '영양 배지가 아닙니다';
  if (sys.countDef(mediumDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(mediumDefId, 1)) return '배지를 꺼낼 수 없습니다';
  const max = mediumMaxDurability(def);
  sys.cultures().push({
    uid, slot, mediumDefId,
    mediumDurability: max, sockets: [],
    mediumUsesLeft: harvestsUntilWorn(max, MEDIUM_WEAR_PER_HARVEST, 0),
  });
  sys.cultureChanged(uid, 'medium');
  return null;
}

/**
 * Scrape a slot back to no medium. **The medium is not returned** — it is thrown away with durability left (the same as poured soil), and the inserted sockets with it.
 * Refused while something is culturing in it. 2026-09-13: with a scaffold in it and no strain, **the scaffold is given back**
 * (bag → stash, refused when there is no room — an unused item is never thrown away silently). Discarded together with a strain, the scaffold goes too.
 */
export function clearMedium(sys: HousingSystem, uid: string, slot: number, discardStrain = false): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  // 2026-09-12: the right-click 「세포주 버리고 배지 비우기」 — it passes only when the discard was asked for
  const started = cultureStarted(c);
  if (c.strainDefId && started && !discardStrain) return '배양 중인 세포주를 먼저 수확하세요';
  // 2026-09-17: a strain from before the start is given back, not thrown away (the same rule as the scaffold — an unused item is never thrown away silently)
  if (c.strainDefId && !started) {
    const loot = sys.ctx.loot;
    if (!loot || typeof loot.createItem !== 'function') return '세포주를 되돌려받을 수 없습니다';
    if (!deliverItem(sys, loot.createItem(c.strainDefId, 1), 'bag-first')) return noRoomReason('bag-first');
    delete c.strainDefId;
  }
  if (c.scaffoldDefId && !c.strainDefId) {
    const loot = sys.ctx.loot;
    if (!loot || typeof loot.createItem !== 'function') return '스캐폴드를 되돌려받을 수 없습니다';
    if (!deliverItem(sys, loot.createItem(c.scaffoldDefId, 1), 'bag-first')) return noRoomReason('bag-first');
    delete c.scaffoldDefId;
  }
  const list = sys.cultures();
  list.splice(list.indexOf(c), 1);
  sys.cultureChanged(uid, 'mediumClear');
  return null;
}

/**
 * Put one strain (bag → stash, consumes 1) into a slot that already holds a medium. `readyAt` is fixed **here** from
 * `cultureHours × the medium's rarity × gardening`, so a later medium swap or skill change never moves a running timer.
 * 2026-09-13: in a slot with a scaffold it uses `scaffoldHours` (a strain with no scaffold output is refused), and the medium bonus · the socket speed apply as far as the durability ratio.
 * A retired strain is refused.
 */
export function insertStrain(sys: HousingSystem, uid: string, slot: number, strainDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  if (c.strainDefId) return cultureStarted(c) ? '이미 배양 중인 칸입니다' : '이미 세포주가 들어 있습니다';
  if (sys.defOf(strainDefId)?.retired) return '더 이상 배양할 수 없는 세포주입니다';
  const def = sys.strainDef(strainDefId);
  if (!def || !def.strain) return '세포주가 아닙니다';
  const scaffold = c.scaffoldDefId ? scaffoldOutputOf(def) : null;
  if (c.scaffoldDefId && !scaffold) return '이 세포주는 스캐폴드에서 자라지 않습니다';
  if (sys.countDef(strainDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(strainDefId, 1)) return '세포주를 꺼낼 수 없습니다';
  // 2026-09-17: it only goes in — the timer is started by `startCulture` (the screen's 1 s hold confirm)
  c.strainDefId = strainDefId;
  delete c.startedAt; delete c.readyAt;
  sys.cultureChanged(uid, 'strain');
  return null;
}

/**
 * 2026-09-17: starts the culture of a waiting slot (`HousingRef.startCulture`). `readyAt` is fixed **here** from `cultureHours`
 * (`scaffoldHours` with a scaffold) × the medium's rarity × gardening × the medium durability ratio × the socket speed, and after
 * that the medium · strain · scaffold cannot be taken out. A strain with no scaffold output sitting in a scaffold slot (its data changed after it went in) is refused. A Korean reason / null.
 */
export function startCulture(sys: HousingSystem, uid: string, slot: number): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  if (!c.strainDefId) return '세포주를 먼저 넣으세요';
  if (cultureStarted(c)) return '이미 배양 중인 칸입니다';
  const def = sys.strainDef(c.strainDefId);
  if (!def || !def.strain || def.retired) return '더 이상 배양할 수 없는 세포주입니다';
  const scaffold = c.scaffoldDefId ? scaffoldOutputOf(def) : null;
  if (c.scaffoldDefId && !scaffold) return '이 세포주는 스캐폴드에서 자라지 않습니다';
  const st = mediumStats(sys, c);
  const hours = scaffold ? scaffold.hours : def.strain.cultureHours;
  c.startedAt = sys.stationNow(uid);
  c.readyAt = c.startedAt + cultureDurationMs(hours, st.speedMul, sys.gardening(), st.ratio, socketSum(sys, c.sockets, 'speed'));
  sys.cultureChanged(uid, 'cultureStart');
  return null;
}

/** 2026-09-17: takes the strain back out of a slot before the start (`HousingRef.takeStrain`, bag → stash · refused with no room). A Korean reason / null. */
export function takeStrain(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c || !c.strainDefId) return '세포주가 없습니다';
  if (cultureStarted(c)) return '배양을 시작한 세포주는 꺼낼 수 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '세포주를 되돌려받을 수 없습니다';
  if (!deliverItem(sys, loot.createItem(c.strainDefId, 1), dest)) return noRoomReason(dest);
  delete c.strainDefId; delete c.startedAt; delete c.readyAt;
  sys.cultureChanged(uid, 'strainTake');
  return null;
}

/**
 * 2026-09-17: takes a never-used medium back, slot and all (`HousingRef.takeMedium`). Durability · sockets live in the slot and
 * cannot ride on the item, so **only an untouched medium** comes back — after one harvest or one socket the only way out is the old 「배지 비우기」 (discard). A Korean reason / null.
 */
export function takeMedium(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  if (c.strainDefId || c.scaffoldDefId) return '세포주 · 스캐폴드를 먼저 빼세요';
  if (!mediumPristine(sys, c)) return '사용한 배지는 되돌려받을 수 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '배지를 되돌려받을 수 없습니다';
  if (!deliverItem(sys, loot.createItem(c.mediumDefId, 1), dest)) return noRoomReason(dest);
  const list = sys.cultures();
  list.splice(list.indexOf(c), 1);
  sys.cultureChanged(uid, 'mediumTake');
  return null;
}

/**
 * 2026-09-13: puts one culture scaffold (bag → stash, consumes 1) into a slot that holds a medium and no strain · scaffold
 * (`HousingRef.insertScaffold`). A Korean reason / null.
 */
export function insertScaffold(sys: HousingSystem, uid: string, slot: number, scaffoldDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  // 2026-09-17: the slot order is medium → scaffold → strain — even before the start, a strain already in it has to come out first
  if (c.strainDefId) return cultureStarted(c) ? '이미 배양 중인 칸입니다' : '세포주를 뺀 뒤에 스캐폴드를 넣으세요';
  if (c.scaffoldDefId) return '이미 스캐폴드가 들어 있습니다';
  const def = sys.defOf(scaffoldDefId);
  if (!def || !def.scaffold) return '배양 스캐폴드가 아닙니다';
  if (sys.countDef(scaffoldDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(scaffoldDefId, 1)) return '스캐폴드를 꺼낼 수 없습니다';
  c.scaffoldDefId = scaffoldDefId;
  sys.cultureChanged(uid, 'scaffold');
  return null;
}

/** 2026-09-13: takes back a scaffold from before the strain went in (`HousingRef.takeScaffold`). A Korean reason / null. */
export function takeScaffold(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  if (!c.scaffoldDefId) return '스캐폴드가 없습니다';
  // 2026-09-17: it may come out of a waiting slot — the strain left behind grows into the default output (`outputDefId`)
  if (cultureStarted(c)) return '배양 중에는 스캐폴드를 뺄 수 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '스캐폴드를 되돌려받을 수 없습니다';
  if (!deliverItem(sys, loot.createItem(c.scaffoldDefId, 1), dest)) return noRoomReason(dest);
  delete c.scaffoldDefId;
  sys.cultureChanged(uid, 'scaffoldTake');
  return null;
}

/** 2026-09-13: inserts a medium socket into a culture slot that holds a medium (`HousingRef.insertCultureSocket`) — the same rules as `insertGrowSocket`. */
export function insertCultureSocket(sys: HousingSystem, uid: string, slot: number, socketDefId: string, replaceIndex?: number): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  const slots = c ? mediumStats(sys, c).slots : 0;
  const err = insertSocket(sys, c, 'medium', socketDefId, slots, replaceIndex);
  if (err) return err;
  if (c) normalizeMedium(sys, c, false);
  sys.cultureChanged(uid, 'socket');
  return null;
}

/**
 * Harvest one finished slot into the bag (stash fallback). 2026-09-13: the output = the scaffold output with a scaffold in it (the
 * scaffold is consumed), else the default output, quantity + the `yield` socket bonus (the ratio **before** the wear) → delete the strain fields → wear the medium. **The slot does not empty.**
 */
export function harvestCulture(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c || !c.strainDefId || !cultureStarted(c) || c.readyAt === undefined) return '배양 중인 세포주가 없습니다';
  const now = sys.stationNow(uid);
  const readyAt = c.readyAt;
  if (now < readyAt) return `아직 배양 중입니다 (${formatRemaining(Math.ceil((readyAt - now) / 1000))} 남음)`;
  const output = outputOf(sys, c);
  const loot = sys.ctx.loot;
  if (!output || !loot || typeof loot.createItem !== 'function') return '배양 산물을 만들 수 없습니다';
  // a culture tank is not gathering — the gardening `gatherYieldMul` is not multiplied in (the strain decides the amount). Only the socket bonus is added.
  const { ratio } = mediumStats(sys, c);
  const qty = output.qty + yieldBonus(sys, c.sockets, ratio, Math.random);
  const item = loot.createItem(output.defId, qty);
  if (!deliverItem(sys, item, dest)) return noRoomReason(dest);
  // 2026-09-13: the medium wears per harvest but the slot never empties by itself; a scaffold that was used is consumed
  delete c.strainDefId; delete c.startedAt; delete c.readyAt;
  if (output.usesScaffold) delete c.scaffoldDefId;
  c.mediumDurability = wearAfterHarvest(c.mediumDurability ?? 0, MEDIUM_WEAR_PER_HARVEST, socketSum(sys, c.sockets, 'wear'));
  normalizeMedium(sys, c, false);
  sys.cultureChanged(uid, 'cultureHarvest');
  return null;
}

/** Harvest every finished slot of the tank; returns how many were taken. */
export function harvestAllCultures(sys: HousingSystem, uid: string): number {
  const tank = sys.tankOf(uid);
  if (!tank) return 0;
  let taken = 0;
  for (let slot = 0; slot < cultureSlotsForLevel(tank.level); slot++) {
    const c = sys.cultureAt(uid, slot);
    if (!c || !c.readyAt || sys.stationNow(uid) < c.readyAt) continue;
    if (sys.harvestCulture(uid, slot) === null) taken++;
  }
  return taken;
}

/** Open the culture screen (`culture_tank` interaction): culture slots on the left · bag + ship stash on the right. */
export function openCultureTank(sys: HousingSystem, uid: string): void {
  if (!sys.cultureTank) return;
  if (!sys.tankOf(uid)) { sys.notify('배양조가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.cultureTank.openTank(uid);
}
