/**
 * src/housing/parts/Culture.ts — **온실 배양조** (A-14, 2026-09-11).
 *
 * 「배지를 붓고 그 위에 세포주를 넣으면 현실 시간만큼 자라 배양 산물이 된다.」
 * 분석기(`parts/Lab.ts`)와 재배 스테이션(`parts/Garden.ts`)을 합친 모양이다 — **분석기처럼 레벨이 칸을 열고**
 * (`cultureSlotsForLevel`, Lv.1 = 1칸 … Lv.3 = 3칸, 칸 번호는 강화해도 밀리지 않는다), **온실처럼 두 단계**다
 * (① `fillMedium` 배지 → ② `insertStrain` 세포주). 배지는 **수확마다 1회** 닳고(`mediumUsesLeft`) 0 이면 칸이
 * 완전히 빈다. 배양 시간은 **넣는 순간** `readyAt` 에 확정된다: 그 뒤로 배지를 갈거나 원예 숙련이 올라도
 * 돌아가던 타이머는 움직이지 않는다.
 *
 * 순수 판정(배양 시간 · 진행도 · 남은 초)은 전부 `../Rules.ts` 에 있고, 여기서는 상태를 바꾼다.
 */
import type { CultureSlot, CultureSlotInfo, HarvestDestination, ItemDef, PlacedFurniture } from '@/shared';
import { CULTURE_MAX_SLOTS, cultureSlotUnlockLevel, cultureSlotsForLevel } from '@/shared';
import { cultureDurationMs, growProgress, growRemainingS } from '../Rules';
import { isCultureTankDefId } from '../ShipState';
import { formatRemaining } from '../ui/dom';
import type { HousingSystem } from '../HousingSystem';
import { deliverItem, noRoomReason } from './Deliver';

/* ── state access ──────────────────────────────────────────────────────── */
/**
 * 배양 칸. The save only shape-checks the ids; the first time `ctx.loot` is around every id that is not a real
 * 배지 / 세포주 any more is dropped here (서재의 `books()` · 온실의 `grows()` · 연구실의 `analyses()` 와 같은
 * 규약 — 아이템 표에서 사라진 def 가 배양조를 깨뜨리지 않는다). An unknown 세포주 leaves plain 배지 behind,
 * exactly like an unknown seed leaves plain soil.
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
      if (c.strainDefId && !sys.defOf(c.strainDefId)?.strain) {
        console.warn(`[housing] unknown strain '${c.strainDefId}' dropped from 배양조 ${c.uid}`);
        delete c.strainDefId; delete c.startedAt; delete c.readyAt;
      }
    }
  }
  return list;
}

/** The 배양조 behind `uid`, or null when it is not one (or gone). */
export function tankOf(sys: HousingSystem, uid: string): PlacedFurniture | null {
  const item = sys.getPlacedByUid(uid);
  return item && isCultureTankDefId(item.defId) ? item : null;
}

export function cultureAt(sys: HousingSystem, uid: string, slot: number): CultureSlot | null {
  return sys.cultures().find((c) => c.uid === uid && c.slot === slot) ?? null;
}

/** Drop every 배양 칸 of a tank that is being recovered (its 배지 · 세포주 go with it). */
export function dropCulturesOf(sys: HousingSystem, uid: string): void {
  const list = sys.cultures();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].uid === uid) list.splice(i, 1);
}

/** Finished 칸 of a tank (the `housing:cultureChanged` payload and the hub's glowing tubes). */
export function readyCultures(sys: HousingSystem, uid: string): number {
  const now = sys.nowMs();
  return sys.cultures().filter((c) => c.uid === uid && !!c.readyAt && now >= c.readyAt).length;
}

export function cultureChanged(sys: HousingSystem, uid: string, reason: string): void {
  sys.changed(reason);
  sys.ctx.bus.emit('housing:cultureChanged', { uid, ready: sys.readyCultures(uid) });
}

/* ── item lookups ──────────────────────────────────────────────────────── */
/** 배지 def with its `medium` data, or null when `defId` is not a 배지. */
export function mediumDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.medium ? def : null;
}

/** 세포주 def with its `strain` data, or null when `defId` is not a 세포주. */
export function strainDef(sys: HousingSystem, defId: string): ItemDef | null {
  const def = sys.defOf(defId);
  return def && def.strain ? def : null;
}

/* ── 배양 화면이 읽는 값 ────────────────────────────────────────────────── */
/**
 * Every 배양 칸 of one tank — **always `CULTURE_MAX_SLOTS`** in slot order, locked ones included so the panel can draw
 * the slots an upgrade will open. `[]` when `uid` is not a 배양조.
 */
export function getCultureSlots(sys: HousingSystem, uid: string): CultureSlotInfo[] {
  const tank = sys.tankOf(uid);
  if (!tank) return [];
  const now = sys.nowMs();
  const open = cultureSlotsForLevel(tank.level);
  const out: CultureSlotInfo[] = [];
  for (let slot = 0; slot < CULTURE_MAX_SLOTS; slot++) {
    const locked = slot >= open;
    const c = locked ? null : sys.cultureAt(uid, slot);
    const medium = c ? sys.mediumDef(c.mediumDefId)?.medium ?? null : null;
    const strain = c?.strainDefId ? sys.strainDef(c.strainDefId)?.strain ?? null : null;
    out.push({
      slot, locked, unlockLevel: cultureSlotUnlockLevel(slot),
      mediumDefId: c?.mediumDefId ?? null,
      mediumUsesLeft: c?.mediumUsesLeft ?? 0,
      mediumSpeedMul: medium?.speedMul ?? 1,
      strainDefId: c?.strainDefId ?? null,
      // 진행도 · 남은 초는 온실 · 연구실과 같은 순수 시각 계산이다 (`Rules` 의 그 둘은 무엇이 자라는지 모른다)
      progress: growProgress(now, c?.startedAt, c?.readyAt),
      remainingS: growRemainingS(now, c?.readyAt),
      ready: !!c?.readyAt && now >= c.readyAt,
      yieldDefId: strain?.outputDefId ?? null,
      yieldQty: strain ? Math.max(1, Math.floor(strain.outputQty)) : 0,
    });
  }
  return out;
}

/** 배지 item defs the player owns right now (bag + stash), 버티는 횟수가 적은 것부터 — the 배양 화면 hint. */
export function getOwnedMediums(sys: HousingSystem): { defId: string; qty: number }[] {
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.getAllItemDefs !== 'function') return [];
  const out: { defId: string; qty: number }[] = [];
  for (const def of loot.getAllItemDefs()) {
    if (!def.medium) continue;
    const qty = sys.countDef(def.id);
    if (qty > 0) out.push({ defId: def.id, qty });
  }
  out.sort((a, b) => (sys.mediumDef(a.defId)?.medium?.uses ?? 0) - (sys.mediumDef(b.defId)?.medium?.uses ?? 0));
  return out;
}

/** 세포주 item defs the player owns (bag + stash), shortest 배양 first. */
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

/* ── 한국어 게이트 ──────────────────────────────────────────────────────── */
/** Why `uid` / `slot` is not a usable 배양 칸 right now; null = fine. Every mutator starts here. */
function slotBlock(sys: HousingSystem, uid: string, slot: number): string | null {
  const tank = sys.tankOf(uid);
  if (!tank) return '배양조가 아닙니다';
  if (!Number.isInteger(slot) || slot < 0 || slot >= CULTURE_MAX_SLOTS) return '없는 배양 칸입니다';
  if (slot >= cultureSlotsForLevel(tank.level)) return `배양조를 Lv.${cultureSlotUnlockLevel(slot)} 로 강화해야 열립니다`;
  return null;
}

/* ── 칸 조작 ────────────────────────────────────────────────────────────── */
/**
 * Pour one 영양 배지 (bag → stash, consumes 1) into an empty 칸. `mediumUsesLeft` starts at `MediumDef.uses`.
 * 한국어 reason on failure, null on success.
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
  sys.cultures().push({ uid, slot, mediumDefId, mediumUsesLeft: Math.max(1, Math.floor(def.medium.uses)) });
  sys.cultureChanged(uid, 'medium');
  return null;
}

/**
 * Scrape a 칸 back to 배지 없음. **The 배지 is not returned** — 남은 횟수가 있어도 버려진다 (부은 흙과 같다).
 * Refused while something is culturing in it.
 */
export function clearMedium(sys: HousingSystem, uid: string, slot: number, discardStrain = false): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  // 2026-09-12: 우클릭 「세포주 버리고 배지 비우기」 — 버리겠다고 한 경우만 통과한다
  if (c.strainDefId && !discardStrain) return '배양 중인 세포주를 먼저 수확하세요';
  const list = sys.cultures();
  list.splice(list.indexOf(c), 1);
  sys.cultureChanged(uid, 'mediumClear');
  return null;
}

/**
 * Put one 세포주 (bag → stash, consumes 1) into a 칸 that already holds 배지. `readyAt` is fixed **here** from
 * `cultureHours × 배지 등급 × 원예`, so a later 배지 swap or skill change never moves a running timer.
 */
export function insertStrain(sys: HousingSystem, uid: string, slot: number, strainDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  if (c.strainDefId) return '이미 배양 중인 칸입니다';
  const def = sys.strainDef(strainDefId);
  if (!def || !def.strain) return '세포주가 아닙니다';
  if (sys.countDef(strainDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(strainDefId, 1)) return '세포주를 꺼낼 수 없습니다';
  const speedMul = sys.mediumDef(c.mediumDefId)?.medium?.speedMul ?? 1;
  c.startedAt = sys.nowMs();
  c.readyAt = c.startedAt + cultureDurationMs(def.strain.cultureHours, speedMul, sys.gardening());
  c.strainDefId = strainDefId;
  sys.cultureChanged(uid, 'cultureStart');
  return null;
}

/**
 * Harvest one finished 칸 into the bag (stash fallback). Spends one `mediumUsesLeft`: the 칸 empties completely at 0,
 * otherwise it goes back to 넣을 준비가 된 배지.
 */
export function harvestCulture(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c || !c.strainDefId || !c.readyAt) return '배양 중인 세포주가 없습니다';
  const now = sys.nowMs();
  if (now < c.readyAt) return `아직 배양 중입니다 (${formatRemaining(Math.ceil((c.readyAt - now) / 1000))} 남음)`;
  const strain = sys.strainDef(c.strainDefId)?.strain ?? null;
  const loot = sys.ctx.loot;
  if (!strain || !loot || typeof loot.createItem !== 'function') return '배양 산물을 만들 수 없습니다';
  // 배양조는 채집이 아니다 — 원예 `gatherYieldMul` 을 곱하지 않는다 (산출량은 세포주가 정한 그대로다)
  const qty = Math.max(1, Math.floor(strain.outputQty));
  const item = loot.createItem(strain.outputDefId, qty);
  if (!deliverItem(sys, item, dest)) return noRoomReason(dest);
  // the 배지 is spent per harvest: at 0 the 칸 goes back to 배지 없음, otherwise it can take a new 세포주
  delete c.strainDefId; delete c.startedAt; delete c.readyAt;
  c.mediumUsesLeft -= 1;
  if (c.mediumUsesLeft <= 0) {
    const list = sys.cultures();
    list.splice(list.indexOf(c), 1);
  }
  sys.cultureChanged(uid, 'cultureHarvest');
  return null;
}

/** Harvest every finished 칸 of the tank; returns how many were taken. */
export function harvestAllCultures(sys: HousingSystem, uid: string): number {
  const tank = sys.tankOf(uid);
  if (!tank) return 0;
  let taken = 0;
  for (let slot = 0; slot < cultureSlotsForLevel(tank.level); slot++) {
    const c = sys.cultureAt(uid, slot);
    if (!c || !c.readyAt || sys.nowMs() < c.readyAt) continue;
    if (sys.harvestCulture(uid, slot) === null) taken++;
  }
  return taken;
}

/** Open the 배양 화면 (`culture_tank` interaction): 좌 배양 칸 · 우 가방 + 함선 창고. */
export function openCultureTank(sys: HousingSystem, uid: string): void {
  if (!sys.cultureTank) return;
  if (!sys.tankOf(uid)) { sys.notify('배양조가 없습니다', 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.cultureTank.openTank(uid);
}
