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
 *
 * **2026-09-13 (요리 재료 티어 — docs/plans/food-tiers.md §4.5)**: 배지는 흙과 **같은 내구도 규칙**이다 — 수확마다
 * `MEDIUM_WEAR_PER_HARVEST` 만큼 닳고 **0 이어도 칸이 비지 않으며**, 배지 속도 보너스 · 소켓 `speed` · `yield` 가 내구도 비율로 준다.
 * `mediumUsesLeft` 는 「0 까지 남은 수확」이다. 칸에는 **배양 스캐폴드**가 들어갈 수 있다: 배지 → (스캐폴드) → 세포주. 스캐폴드가
 * 있으면 세포주의 `scaffoldOutputDefId`(종별 고기)를 `scaffoldHours` 동안 만들고 **수확할 때 소모된다**. 세포주가 들어가기 전이면
 * `takeScaffold` 로 되돌려받는다. 은퇴한 세포주(`strain` 데이터가 없다)는 배양조가 받지 않는다.
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
      // 2026-09-13: 은퇴한 세포주는 `strain` 데이터가 없다 — 세포주 필드만 지우고 배지는 남긴다 (모르는 id 와 같은 길)
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

/* ── 배지 내구도 (2026-09-13) ───────────────────────────────────────────── */
/** 배지 한 종류의 최대 내구도 — `MediumDef.durability`. 값이 없으면(옛 아이템 표) 옛 수확 횟수 × 수확당 마모. */
export function mediumMaxDurability(def: ItemDef | null | undefined): number {
  const m = def?.medium;
  if (!m) return 0;
  const d = (m as { durability?: number }).durability;
  if (typeof d === 'number' && Number.isFinite(d) && d > 0) return d;
  return Math.max(1, Math.floor(Number.isFinite(m.uses) ? m.uses : 1)) * Math.max(0, MEDIUM_WEAR_PER_HARVEST);
}

/** 한 칸의 배지 상태를 규칙에 맞춘다 (`parts/Garden` 의 `normalizeSoil` 과 같은 식). 배지 def 를 모르면 아무것도 안 한다. */
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

/** 칸의 배지 수치 한 벌. 배지 def 를 모르면 전부 0 (속도 배수는 1). */
function mediumStats(sys: HousingSystem, c: CultureSlot): { max: number; dur: number; ratio: number; slots: number; speedMul: number } {
  const def = sys.mediumDef(c.mediumDefId);
  if (!def || !def.medium) return { max: 0, dur: 0, ratio: 0, slots: 0, speedMul: 1 };
  normalizeMedium(sys, c, false);
  const max = mediumMaxDurability(def);
  const dur = c.mediumDurability ?? 0;
  return { max, dur, ratio: durabilityRatio(dur, max), slots: growSocketSlotsFor(def.rarity), speedMul: def.medium.speedMul };
}

/** 스캐폴드가 든 칸에서 이 세포주가 만드는 것 — 세 값이 다 있어야 한다. 없으면 null (그 세포주는 스캐폴드에서 자라지 않는다). */
function scaffoldOutputOf(def: ItemDef | null): { defId: string; qty: number; hours: number } | null {
  const s = def?.strain;
  if (!s || !s.scaffoldOutputDefId) return null;
  const qty = Math.max(1, Math.floor(Number.isFinite(s.scaffoldOutputQty) ? s.scaffoldOutputQty as number : 1));
  const hours = Number.isFinite(s.scaffoldHours) && (s.scaffoldHours as number) > 0 ? s.scaffoldHours as number : s.cultureHours;
  return { defId: s.scaffoldOutputDefId, qty, hours };
}

/** 이 칸에서 지금 세포주가 만들 것 (스캐폴드 반영). 세포주가 없으면 null. */
function outputOf(sys: HousingSystem, c: CultureSlot): { defId: string; qty: number; usesScaffold: boolean } | null {
  const def = c.strainDefId ? sys.strainDef(c.strainDefId) : null;
  if (!def || !def.strain) return null;
  const sc = c.scaffoldDefId ? scaffoldOutputOf(def) : null;
  if (sc) return { defId: sc.defId, qty: sc.qty, usesScaffold: true };
  return { defId: def.strain.outputDefId, qty: Math.max(1, Math.floor(def.strain.outputQty)), usesScaffold: false };
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
    const st = c ? mediumStats(sys, c) : null;
    const output = c ? outputOf(sys, c) : null;
    out.push({
      slot, locked, unlockLevel: cultureSlotUnlockLevel(slot),
      mediumDefId: c?.mediumDefId ?? null,
      // 2026-09-13: 뜻이 「내구도 0 까지 남은 수확 횟수」로 바뀌었다 (0 이어도 칸은 남는다)
      mediumUsesLeft: c?.mediumUsesLeft ?? 0,
      mediumSpeedMul: medium?.speedMul ?? 1,
      strainDefId: c?.strainDefId ?? null,
      // 진행도 · 남은 초는 온실 · 연구실과 같은 순수 시각 계산이다 (`Rules` 의 그 둘은 무엇이 자라는지 모른다)
      progress: growProgress(now, c?.startedAt, c?.readyAt),
      remainingS: growRemainingS(now, c?.readyAt),
      ready: !!c?.readyAt && now >= c.readyAt,
      // 2026-09-13: 스캐폴드가 있으면 종별 고기 (`outputOf`)
      yieldDefId: output?.defId ?? null,
      yieldQty: output?.qty ?? 0,
      mediumDurability: st?.dur ?? 0,
      mediumDurabilityMax: st?.max ?? 0,
      mediumBonusRatio: st?.ratio ?? 0,
      sockets: c?.sockets ? [...c.sockets] : [],
      socketSlots: st?.slots ?? 0,
      scaffoldDefId: c?.scaffoldDefId ?? null,
    });
  }
  return out;
}

/** 배지 item defs the player owns right now (bag + stash), 최대 내구도가 낮은 것부터 (2026-09-13) — the 배양 화면 hint. */
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
 * Pour one 영양 배지 (bag → stash, consumes 1) into an empty 칸. 2026-09-13: 내구도 최대 · 소켓 없음 ·
 * `mediumUsesLeft` = 0 까지 남은 수확. 한국어 reason on failure, null on success.
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
 * Scrape a 칸 back to 배지 없음. **The 배지 is not returned** — 남은 내구도가 있어도 버려진다 (부은 흙과 같다), 끼운 소켓도 함께.
 * Refused while something is culturing in it. 2026-09-13: 세포주 없이 스캐폴드만 들어 있으면 **스캐폴드는 되돌려준다**
 * (가방 → 창고, 자리가 없으면 거절 — 아직 쓰지 않은 아이템을 조용히 버리지 않는다). 세포주와 함께 버리면 스캐폴드도 버려진다.
 */
export function clearMedium(sys: HousingSystem, uid: string, slot: number, discardStrain = false): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  // 2026-09-12: 우클릭 「세포주 버리고 배지 비우기」 — 버리겠다고 한 경우만 통과한다
  if (c.strainDefId && !discardStrain) return '배양 중인 세포주를 먼저 수확하세요';
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
 * Put one 세포주 (bag → stash, consumes 1) into a 칸 that already holds 배지. `readyAt` is fixed **here** from
 * `cultureHours × 배지 등급 × 원예`, so a later 배지 swap or skill change never moves a running timer.
 * 2026-09-13: 스캐폴드가 든 칸이면 `scaffoldHours` 를 쓰고(스캐폴드 산출이 없는 세포주는 거절), 배지 보너스 · 소켓 speed 는 내구도 비율만큼.
 * 은퇴한 세포주는 받지 않는다.
 */
export function insertStrain(sys: HousingSystem, uid: string, slot: number, strainDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  if (c.strainDefId) return '이미 배양 중인 칸입니다';
  if (sys.defOf(strainDefId)?.retired) return '더 이상 배양할 수 없는 세포주입니다';
  const def = sys.strainDef(strainDefId);
  if (!def || !def.strain) return '세포주가 아닙니다';
  const scaffold = c.scaffoldDefId ? scaffoldOutputOf(def) : null;
  if (c.scaffoldDefId && !scaffold) return '이 세포주는 스캐폴드에서 자라지 않습니다';
  if (sys.countDef(strainDefId) < 1) return `${def.name}이(가) 없습니다`;
  const inv = sys.ctx.inventory;
  if (!inv || typeof inv.consumeDefAll !== 'function' || !inv.consumeDefAll(strainDefId, 1)) return '세포주를 꺼낼 수 없습니다';
  const st = mediumStats(sys, c);
  const hours = scaffold ? scaffold.hours : def.strain.cultureHours;
  c.startedAt = sys.nowMs();
  c.readyAt = c.startedAt + cultureDurationMs(hours, st.speedMul, sys.gardening(), st.ratio, socketSum(sys, c.sockets, 'speed'));
  c.strainDefId = strainDefId;
  sys.cultureChanged(uid, 'cultureStart');
  return null;
}

/**
 * 2026-09-13: 배지가 있고 세포주 · 스캐폴드가 없는 칸에 배양 스캐폴드 하나를 (가방 → 창고, 1개 소모) 넣는다
 * (`HousingRef.insertScaffold`). 한국어 사유 / null.
 */
export function insertScaffold(sys: HousingSystem, uid: string, slot: number, scaffoldDefId: string): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '영양 배지를 먼저 채우세요';
  if (c.strainDefId) return '이미 배양 중인 칸입니다';
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

/** 2026-09-13: 세포주가 들어가기 전의 스캐폴드를 되돌려받는다 (`HousingRef.takeScaffold`). 한국어 사유 / null. */
export function takeScaffold(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c) return '배지가 없습니다';
  if (!c.scaffoldDefId) return '스캐폴드가 없습니다';
  if (c.strainDefId) return '배양 중에는 스캐폴드를 뺄 수 없습니다';
  const loot = sys.ctx.loot;
  if (!loot || typeof loot.createItem !== 'function') return '스캐폴드를 되돌려받을 수 없습니다';
  if (!deliverItem(sys, loot.createItem(c.scaffoldDefId, 1), dest)) return noRoomReason(dest);
  delete c.scaffoldDefId;
  sys.cultureChanged(uid, 'scaffoldTake');
  return null;
}

/** 2026-09-13: 배지가 든 배양 칸에 배지 소켓을 끼운다 (`HousingRef.insertCultureSocket`) — 규칙은 `insertGrowSocket` 과 같다. */
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
 * Harvest one finished 칸 into the bag (stash fallback). 2026-09-13: 산출 = 스캐폴드면 스캐폴드 산출(스캐폴드 소모), 아니면 기본 산출,
 * 수량 + `yield` 소켓 덤(마모 **전** 비율) → 세포주 필드 삭제 → 배지 마모. **칸은 비지 않는다.**
 */
export function harvestCulture(sys: HousingSystem, uid: string, slot: number, dest: HarvestDestination = 'bag-first'): string | null {
  const block = slotBlock(sys, uid, slot);
  if (block) return block;
  const c = sys.cultureAt(uid, slot);
  if (!c || !c.strainDefId || !c.readyAt) return '배양 중인 세포주가 없습니다';
  const now = sys.nowMs();
  if (now < c.readyAt) return `아직 배양 중입니다 (${formatRemaining(Math.ceil((c.readyAt - now) / 1000))} 남음)`;
  const output = outputOf(sys, c);
  const loot = sys.ctx.loot;
  if (!output || !loot || typeof loot.createItem !== 'function') return '배양 산물을 만들 수 없습니다';
  // 배양조는 채집이 아니다 — 원예 `gatherYieldMul` 을 곱하지 않는다 (산출량은 세포주가 정한 그대로다). 소켓 덤만 더한다.
  const { ratio } = mediumStats(sys, c);
  const qty = output.qty + yieldBonus(sys, c.sockets, ratio, Math.random);
  const item = loot.createItem(output.defId, qty);
  if (!deliverItem(sys, item, dest)) return noRoomReason(dest);
  // 2026-09-13: the 배지 wears per harvest but the 칸 never empties by itself; a 스캐폴드 that was used is consumed
  delete c.strainDefId; delete c.startedAt; delete c.readyAt;
  if (output.usesScaffold) delete c.scaffoldDefId;
  c.mediumDurability = wearAfterHarvest(c.mediumDurability ?? 0, MEDIUM_WEAR_PER_HARVEST, socketSum(sys, c.sockets, 'wear'));
  normalizeMedium(sys, c, false);
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
