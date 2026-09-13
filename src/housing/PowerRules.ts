/**
 * src/housing/PowerRules.ts — **발전기 전력의 순수 판정** (2026-09-13, docs/plans/power-crypto.md §전력).
 *
 * ctx 도 DOM 도 없다 — `ShipState` 하나를 받아 공급 · 시설별 요구 · 가구별 작동 여부를 계산하고, 세이브 필드를 정리한다.
 * `parts/Power.ts`(상태를 바꾸고 이벤트를 낸다) · `ShipState.sanitize`(v12 정리 · 이관) · 스모크가 같은 식을 쓴다.
 * 배치 규칙(`Rules.ts`)과 섞지 않는다 — 다른 에이전트가 그 파일을 고친다.
 *
 * 규칙 (사용자 결정):
 *  - 공급 = `generatorPowerSupply(발전기 레벨)`.
 *  - 시설 = 지을 수 있는 용도(`ROOM_PURPOSES_ASSIGNABLE`)가 붙은 방. 조종석 · 빈 방은 전력을 쓰지 않는다.
 *  - 시설 요구 = `ROOM_PURPOSE_POWER[용도]` + 그 방의 **활성** 가구 demand 합. demand = `FurnitureDef.power`
 *    (+ 연산 클러스터면 꽂힌 코어 × `COMPUTE_CLUSTER_POWER_PER_CORE`). 비활성 가구는 요구에서 빠진다.
 *  - 할당 < 요구 → 그 시설의 전력을 쓰는 가구 **전부** 멈춘다. 전력을 안 쓰는 가구(demand 0)는 늘 작동한다.
 *  - 연산 클러스터는 추가로 **작동 중인 메인 컴퓨터**(채굴 시설 안)가 있어야 한다.
 */
import type { FacilityPowerInfo, FurniturePowerInfo, PlacedFurniture, PowerOverview, RoomPurpose, ShipState, WorkbenchKind } from '@/shared';
import {
  COCKPIT_ROOM_INDEX, COMPUTE_CLUSTER_DEF_ID, COMPUTE_CLUSTER_POWER_PER_CORE, FURNITURE_DEF_MAP, FURNITURE_DISABLED_REASON_KO,
  MINING_COMPUTER_DEF_ID, MINING_COMPUTER_REQUIRED_REASON_KO, POWER_SHORT_REASON_KO, ROOM_PURPOSES_ASSIGNABLE, ROOM_PURPOSE_POWER,
  benchKindOf, generatorPowerSupply,
} from '@/shared';

/* ── 기본 질의 ─────────────────────────────────────────────────────────────── */

/** 정수 ≥ 0 (NaN · 음수 · 무한 → 0). */
export function powerInt(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 발전기 공급 전력. */
export function powerSupplyOf(state: ShipState): number {
  return generatorPowerSupply(state.generatorLevel);
}

/** 방 `room` 이 전력 시설인가 — 방 번호가 있고 지을 수 있는 용도가 붙어 있다 (조종석 · 빈 방 · 은퇴 용도 = 아님). */
export function isPowerFacilityRoom(state: ShipState, room: number): boolean {
  if (room === COCKPIT_ROOM_INDEX || !Number.isInteger(room) || room < 0 || room >= state.rooms.length) return false;
  return ROOM_PURPOSES_ASSIGNABLE.includes(state.rooms[room].purpose);
}

/** 시설 용도의 기본 요구 전력. */
export function purposeBasePower(purpose: RoomPurpose): number {
  return powerInt(ROOM_PURPOSE_POWER[purpose]);
}

/** 연산 클러스터에 꽂힌 코어 수 (`state.clusters`, 없으면 0). */
export function clusterCoresOf(state: ShipState, uid: string): number {
  const c = Array.isArray(state.clusters) ? state.clusters.find((x) => x && x.uid === uid) : undefined;
  return c ? powerInt(c.cores) : 0;
}

/** 가구 하나의 demand (활성일 때 요구 전력, 코어 포함). 조종석에 놓인 가구 · 모르는 def 는 0. */
export function furnitureDemand(state: ShipState, item: PlacedFurniture): number {
  if (item.room === COCKPIT_ROOM_INDEX) return 0;
  const def = FURNITURE_DEF_MAP.get(item.defId);
  if (!def) return 0;
  let d = powerInt(def.power);
  if (def.id === COMPUTE_CLUSTER_DEF_ID) d += clusterCoresOf(state, item.uid) * powerInt(COMPUTE_CLUSTER_POWER_PER_CORE);
  return d;
}

/** 시설 할당 (없으면 0). */
export function allocationOf(state: ShipState, room: number): number {
  return powerInt(state.powerAlloc?.[String(room)]);
}

/** 할당 합. */
export function totalAllocation(state: ShipState): number {
  let sum = 0;
  for (const v of Object.values(state.powerAlloc ?? {})) sum += powerInt(v);
  return sum;
}

/* ── 한 번에 계산 ───────────────────────────────────────────────────────────── */

export interface PowerSnapshot extends PowerOverview {
  /** 전력을 쓰는 가구(demand > 0, 조종석 밖) uid → 작동하지 않는 사유 (작동하면 null). 여기 없는 uid 는 늘 작동한다. */
  blocks: Map<string, string | null>;
  /** 방 번호 → 시설 현황. */
  byRoom: Map<number, FacilityPowerInfo>;
}

/**
 * 공급 · 시설별 요구 / 할당 · 가구별 작동 여부 전부. 시설은 방 번호 순서다. 한 번에 O(가구 수) — 필요할 때마다 새로 부른다
 * (스모크가 `state` 를 직접 고쳐도 답이 따라간다).
 */
export function computePower(state: ShipState): PowerSnapshot {
  const supply = powerSupplyOf(state);
  const disabled = new Set(Array.isArray(state.disabledFurniture) ? state.disabledFurniture : []);
  const facilities: FacilityPowerInfo[] = [];
  const byRoom = new Map<number, FacilityPowerInfo>();
  for (let room = 0; room < state.rooms.length; room++) {
    if (!isPowerFacilityRoom(state, room)) continue;
    const purpose = state.rooms[room].purpose;
    const base = purposeBasePower(purpose);
    const info: FacilityPowerInfo = { room, purpose, base, required: base, allocated: allocationOf(state, room), powered: true, furniture: [] };
    facilities.push(info);
    byRoom.set(room, info);
  }
  for (const f of state.furniture) {
    const info = byRoom.get(f.room);
    if (!info) continue;
    const demand = furnitureDemand(state, f);
    if (demand <= 0) continue;
    const off = disabled.has(f.uid);
    info.furniture.push({ uid: f.uid, defId: f.defId, demand, disabled: off, operational: false, block: null });
    if (!off) info.required += demand;
  }
  let allocated = 0, required = 0;
  for (const info of facilities) {
    info.powered = info.allocated >= info.required;
    allocated += info.allocated;
    required += info.required;
  }
  // 1차: 비활성 · 전력
  const blocks = new Map<string, string | null>();
  for (const info of facilities) {
    for (const p of info.furniture) {
      p.block = p.disabled ? FURNITURE_DISABLED_REASON_KO : info.powered ? null : POWER_SHORT_REASON_KO;
      p.operational = p.block === null;
      blocks.set(p.uid, p.block);
    }
  }
  // 2차: 연산 클러스터 = 작동 중인 메인 컴퓨터(채굴 시설 안)가 있어야 한다 (사용자 결정)
  let computerUp = false;
  for (const info of facilities) {
    if (info.purpose !== 'mining') continue;
    for (const p of info.furniture) if (p.defId === MINING_COMPUTER_DEF_ID && p.operational) computerUp = true;
  }
  if (!computerUp) {
    for (const info of facilities) {
      for (const p of info.furniture) {
        if (p.defId !== COMPUTE_CLUSTER_DEF_ID || !p.operational) continue;
        p.block = MINING_COMPUTER_REQUIRED_REASON_KO;
        p.operational = false;
        blocks.set(p.uid, p.block);
      }
    }
  }
  return { supply, allocated, free: Math.max(0, supply - allocated), required, facilities, blocks, byRoom };
}

/** 가구 하나가 지금 작동하지 않는 사유 (전력을 안 쓰는 가구 · 모르는 uid = null). */
export function operationalBlockIn(snap: PowerSnapshot, uid: string): string | null {
  return snap.blocks.get(uid) ?? null;
}

/** 그 종류의 작업대 중 **작동하는** 것의 가장 높은 레벨 (0 = 없음). */
export function operationalBenchLevel(state: ShipState, snap: PowerSnapshot, kind: WorkbenchKind): number {
  let best = 0;
  for (const f of state.furniture) {
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def || benchKindOf(def.interaction) !== kind) continue;
    if (operationalBlockIn(snap, f.uid) !== null) continue;
    best = Math.max(best, f.level);
  }
  return best;
}

/** 그 종류의 작업대가 놓여 있지만 하나도 작동하지 않는 사유 (먼저 만난 것의 사유), 아니면 null. */
export function benchBlockIn(state: ShipState, snap: PowerSnapshot, kind: WorkbenchKind): string | null {
  let reason: string | null = null;
  for (const f of state.furniture) {
    const def = FURNITURE_DEF_MAP.get(f.defId);
    if (!def || benchKindOf(def.interaction) !== kind) continue;
    const b = operationalBlockIn(snap, f.uid);
    if (b === null) return null;
    reason ??= b;
  }
  return reason;
}

/* ── 세이브 정리 (v12) ──────────────────────────────────────────────────────── */

/**
 * `ShipState.sanitize` 가 부른다 — `state` 의 방 · 가구 · 발전기가 이미 정리된 뒤. 결과를 `state` 에 쓴다:
 *  - `powerAlloc`: 전력 시설 방 번호만, 정수 ≥ 0 (0 은 적지 않는다). 합이 공급을 넘으면 **가장 높은 방 번호부터** 깎는다.
 *  - `disabledFurniture`: 배치된 uid 만, 중복 없이.
 *  - `pausedAt`: 배치된 uid 만, 유한한 양수.
 */
export function sanitizePowerFields(state: ShipState, raw: { powerAlloc?: unknown; disabledFurniture?: unknown; pausedAt?: unknown }): void {
  const placed = new Set(state.furniture.map((f) => f.uid));
  const alloc: Record<string, number> = {};
  const src = raw.powerAlloc && typeof raw.powerAlloc === 'object' && !Array.isArray(raw.powerAlloc) ? (raw.powerAlloc as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(src)) {
    if (!/^\d+$/.test(k)) continue;
    const room = Number(k);
    const n = powerInt(v);
    if (n > 0 && isPowerFacilityRoom(state, room)) alloc[String(room)] = n;
  }
  state.powerAlloc = alloc;
  trimAllocationsToSupply(state);

  const disabled: string[] = [];
  for (const uid of Array.isArray(raw.disabledFurniture) ? raw.disabledFurniture : []) {
    if (typeof uid === 'string' && placed.has(uid) && !disabled.includes(uid)) disabled.push(uid);
  }
  state.disabledFurniture = disabled;

  const paused: Record<string, number> = {};
  const rawPaused = raw.pausedAt && typeof raw.pausedAt === 'object' && !Array.isArray(raw.pausedAt) ? (raw.pausedAt as Record<string, unknown>) : {};
  for (const [uid, v] of Object.entries(rawPaused)) {
    if (!placed.has(uid)) continue;
    const t = Number(v);
    if (Number.isFinite(t) && t > 0) paused[uid] = Math.floor(t);
  }
  state.pausedAt = paused;
}

/** 할당 합이 공급을 넘으면 가장 높은 방 번호부터 깎는다. 깎았으면 true. */
export function trimAllocationsToSupply(state: ShipState): boolean {
  const alloc = state.powerAlloc ?? (state.powerAlloc = {});
  let over = totalAllocation(state) - powerSupplyOf(state);
  if (over <= 0) return false;
  const rooms = Object.keys(alloc).map(Number).sort((a, b) => b - a);
  for (const room of rooms) {
    if (over <= 0) break;
    const cur = powerInt(alloc[String(room)]);
    const cut = Math.min(cur, over);
    const next = cur - cut;
    if (next > 0) alloc[String(room)] = next; else delete alloc[String(room)];
    over -= cut;
  }
  return true;
}

/**
 * v12 이관 (옛 세이브에는 할당이 없다): **방 순서대로** 시설마다 지금 요구량을 통째로 할당한다 — 남은 공급으로 요구를 다
 * 못 채우는 시설은 건너뛰고(반쪽 할당은 어차피 멈춘다) 다음 시설로 간다. 업데이트 한 번에 모든 시설이 꺼지지 않게 (사용자 결정).
 * 할당한 것이 있으면 true.
 */
export function autoAllocateRequirements(state: ShipState): boolean {
  state.powerAlloc = {};
  let left = powerSupplyOf(state);
  let any = false;
  for (const info of computePower(state).facilities) {
    if (info.required <= 0 || info.required > left) continue;
    state.powerAlloc[String(info.room)] = info.required;
    left -= info.required;
    any = true;
  }
  return any;
}

/** 발전기 화면 한 줄 요약에 쓰는 문장 — 요구 합이 공급을 넘으면 업그레이드 안내. */
export const GENERATOR_UPGRADE_NEEDED_KO = '발전기 업그레이드가 필요합니다';

/** 시설이 멈췄다는 토스트 (`<시설> 전력 부족 — 발전기에서 전력을 할당하세요`). */
export function facilityShortToast(label: string): string {
  return `${label} 전력 부족 — 발전기에서 전력을 할당하세요`;
}

/** 그 가구의 전력 현황 (전력을 안 쓰는 가구는 null). */
export function furniturePowerIn(snap: PowerSnapshot, uid: string): FurniturePowerInfo | null {
  for (const info of snap.facilities) for (const p of info.furniture) if (p.uid === uid) return p;
  return null;
}
