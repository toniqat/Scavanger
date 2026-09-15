/**
 * src/housing/parts/Dining.ts — **식탁 · 접시** (A-3c 2026-09-11 → 2026-09-16 접시 모델, 사용자 결정 — 계약은 `shared/housing.ts` 의 접시 절).
 *
 * 「요리는 아이템이 아니다. 조리대에서 끝난 요리는 **내 함선 식탁의 접시 하나**가 되고, 식탁에서 먹으면 다음 레이드 1회분이 실린다.」
 *
 *   • 접시는 함선당 하나다 (`ShipState.plate`). 다시 요리하면 옛 접시를 **바꾼다** — 경고는 조리 시작 전에 화면이 띄운다
 *     (`ui/cook/PlateAsk`), 여기 규칙은 「끝난 요리가 접시를 덮는다」 하나다 (`setPlate`).
 *   • **먹어도 접시는 줄지 않는다.** 먹기 = `ProgressionRef.useMeal(요리, 품질)` 한 줄 — 대기 식사 · 같은 요리 거절 · 교체 · 출격 때
 *     옮기기는 전부 progression 의 규칙이고 housing 은 묻기만 한다.
 *   • 다음 레이드 시작(`game:newMission`, 훈련장 제외 — game/ 이 `armPreps` 를 부르는 자리와 같은 조건)에 접시를 치우고 저장한다.
 *   • 공유 함선의 **고정 식탁**(`uid` null)에는 내 접시 + 분대원 접시(`squadPlates`, net 이 `net:squadPlate` 로 채운다)가 놓이고 누구 것이든
 *     먹을 수 있다 (먹은 사람의 대기 식사가 된다). 옛 「분대에 차리기」(`serveMealToSquad` · `housing:mealServed`)는 이것으로 대체됐다.
 *
 * 식탁은 두 가지다: 개인 함선의 **가구**(`interaction: 'dining_table'` — `uid` 가 그 가구) · 공유 함선의 **고정 식탁**(hub 가 심어 둔
 * 상호작용 지점이라 `uid` 가 null). 식탁 가구가 없으면 조리대를 쓸 수 없다 (`hasDiningTable` → `parts/Cooking` 의 게이트).
 */
import type { DiningPlate, MealItemDef, TablePlateInfo } from '@/shared';
import { getMealDef, normalizeMealQuality } from '@/shared';
import { isDiningTableDefId } from '../ShipState';
import type { HousingSystem } from '../HousingSystem';

/** 분대원 한 명의 접시 (공유 함선 식탁) — PeerId 로 묶는다. */
export interface SquadPlate { name: string; plate: DiningPlate }

/** 공유 함선의 고정 식탁 앞에 서 있는가 (uid 없는 식탁은 이것 하나뿐이다). */
export function isSharedTable(sys: HousingSystem): boolean {
  return sys.ctx.hub?.ship === 'shared';
}

/** The 식탁 가구 behind `uid`, or null when it is not one (or gone). */
export function diningTableOf(sys: HousingSystem, uid: string) {
  const item = sys.getPlacedByUid(uid);
  return item && isDiningTableDefId(item.defId) ? item : null;
}

/** 내 함선에 식탁 가구가 배치돼 있나 (가구 창고에 든 식탁은 세지 않는다). 조리대 게이트. */
export function hasDiningTable(sys: HousingSystem): boolean {
  return sys.state.furniture.some((f) => isDiningTableDefId(f.defId));
}

/**
 * 왜 지금 식탁을 쓸 수 없는가 (null = 괜찮다). 레이드 중에는 열리지 않는다 — 식사는 **출격 전에** 먹는 것이다.
 */
export function diningBlock(sys: HousingSystem, uid: string | null): string | null {
  const ctx = sys.ctx;
  if (ctx.isRaidActive() || !ctx.isHubPhase()) return '함선에서만 쓸 수 있습니다';
  if (uid === null) return isSharedTable(sys) ? null : '식탁이 없습니다';
  return diningTableOf(sys, uid) ? null : '식탁이 아닙니다';
}

/** 요리 정의 (`shared/meals`), 요리가 아니면 null. */
export function mealDef(_sys: HousingSystem, defId: string): MealItemDef | null {
  return getMealDef(defId) ?? null;
}

/* ── 접시 ─────────────────────────────────────────────────────────────────── */
/** 내 함선 식탁의 접시 (요리 표가 모르는 id 면 없는 것으로 본다). */
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
 * 내 식탁에 접시를 놓는다 (옛 접시는 **바뀐다**). 저장은 `saveSoon` — `housing:changed` 를 내지 않으므로 hub 가 함선 가구를 통째로 다시 짓지
 * 않는다 (식탁 조각만 `housing:tablePlatesChanged` 로). 치운 옛 접시를 돌려준다 (없었으면 null).
 */
export function setPlate(sys: HousingSystem, mealDefId: string, quality: number, reason: 'cooked' | 'dev'): DiningPlate | null {
  const before = getPlate(sys);
  sys.state.plate = { mealDefId, quality: normalizeMealQuality(quality), cookedAt: sys.nowMs() };
  sys.saveSoon();
  emitPlate(sys, reason);
  return before;
}

/** 내 접시를 치운다 (레이드 시작 · 개발). 치운 것이 있으면 true. */
export function clearPlate(sys: HousingSystem, reason: 'raid' | 'dev'): boolean {
  if (!sys.state.plate) return false;
  sys.state.plate = null;
  sys.saveSoon();
  emitPlate(sys, reason);
  return true;
}

/** 서버 사본이 상태를 바꿨다 — 접시가 달라졌으면 알린다 (`HousingSystem.onProfileLoaded`). */
export function afterStateReplaced(sys: HousingSystem, before: DiningPlate | null): void {
  if (!samePlate(before, getPlate(sys))) emitPlate(sys, 'profile');
}

/**
 * 그 식탁에 놓인 접시들 — 개인 함선 식탁(`uid`)은 내 것만, 공유 함선 고정 식탁(`null`)은 내 것 + 분대원 것 (공유 함선에 서 있을 때만).
 * 내 접시가 맨 앞, 나머지는 이름 순.
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
  if (uid !== null) return null;                                   // 분대원의 접시는 공유 함선의 고정 식탁에만 있다
  return sys.squadPlates.get(ownerId)?.plate ?? null;
}

/* ── 먹기 ─────────────────────────────────────────────────────────────────── */
/**
 * 지금 그 접시를 먹을 수 없는 한국어 사유 (null = 먹을 수 있다). 화면의 버튼 상태용 질의다 — 실제 거절은 `eatPlate` 가
 * `progression.useMeal` 에서 받는다. 「이미 먹었다」는 progression 의 대기 식사와 비교한 **표시**다 (규칙은 거기에 있다).
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
 * 접시를 먹는다 — **접시는 그대로** 두고 `progression.useMeal(요리, 품질)` 이 대기 식사를 싣는다 (다른 식사를 이미 실었으면 교체).
 * `ownerId` 생략 · null = 내 접시, PeerId = 공유 함선 식탁의 분대원 접시. 한국어 사유 / null.
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

/** 개발 · 스모크: 조리 없이 내 식탁에 접시를 놓는다. */
export function devSetPlate(sys: HousingSystem, mealDefId: string, quality = 0): string | null {
  if (!getMealDef(mealDefId)) return `요리가 아닙니다: ${mealDefId}`;
  setPlate(sys, mealDefId, quality, 'dev');
  return null;
}

/* ── 분대원 접시 (공유 함선) ─────────────────────────────────────────────── */
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

/** Open the 식사 화면 (`dining_table` interaction). `uid` null = 공유 함선의 고정 식탁. */
export function openDiningTable(sys: HousingSystem, uid: string | null): void {
  if (!sys.diningTable) return;
  const block = diningBlock(sys, uid);
  if (block) { sys.notify(block, 'warning'); return; }
  sys.exitHousingMode();
  sys.closeMenus(false);
  sys.diningTable.openTable(uid);
}

/** 접시의 수명을 끊는 바깥 사건들 — `init` 에서 한 번. */
export function bindDining(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  return [
    /* 다음 레이드가 시작됐다 — 먹지 않은 접시는 치운다 (사용자 결정). 조건은 game/ 이 `armPreps` 를 부르는 자리와 같다: 훈련장은 레이드가
       아니다 (`parts/Phases` — `if (!isTraining()) armPreps()`). 분대원 접시도 모두 그 레이드로 떠났다 — 함선에 돌아와 허브 세션에 들어서면
       net 이 `plateq sync` 로 다시 묻는다. */
    b.on('game:newMission', ({ mode }) => {
      if (mode !== 'training') clearPlate(sys, 'raid');
      clearSquadPlates(sys);
    }),
    b.on('net:squadPlate', ({ id, name, plate }) => setSquadPlate(sys, id, name, plate)),
    b.on('net:lobbyLeft', () => clearSquadPlates(sys)),
    // 떠난 분대원의 접시는 식탁에서 내려간다 (net 이 null 을 보내지 못한 채 끊긴 경우도)
    b.on('net:lobbyUpdated', ({ lobby }) => {
      let changed = false;
      for (const id of Array.from(sys.squadPlates.keys())) {
        if (!lobby.players.some((p) => p.id === id)) { sys.squadPlates.delete(id); changed = true; }
      }
      if (changed) emitTablePlates(sys);
    }),
  ];
}
