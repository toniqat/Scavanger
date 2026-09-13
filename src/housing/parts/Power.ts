/**
 * src/housing/parts/Power.ts — **발전기 전력: 할당 · 비활성화 · 멈춤** (2026-09-13, docs/plans/power-crypto.md §전력, 사용자 결정).
 *
 * 순수 판정은 `../PowerRules.ts` 가 갖고 여기서는 상태를 바꾸고 이벤트를 낸다.
 *
 * - **할당** `setPowerAllocation(room, n)` — 정수 ≥ 0, 할당 합 ≤ 공급. 할당 < 요구면 그 시설의 전력을 쓰는 가구 전부가 멈춘다.
 * - **비활성화** `setFurnitureDisabled(uid, on)` — 전력을 쓰는 가구만. 요구에서 빠지고 멈춘다.
 * - **멈춤 기록** — `ShipState.pausedAt[uid]` 가 곧 「지금 멈춰 있다」다. 가구 · 방 · 발전기 · 코어가 바뀔 때마다 `recompute` 가
 *   작동 여부를 다시 계산해 차이를 낸다: 멈추는 순간 `pausedAt = now` + `housing:operationalChanged {operational:false, pausedMs:0}`,
 *   다시 도는 순간 `pausedMs = now − pausedAt`, 기록을 지우고 `{operational:true, pausedMs}` 를 **동기로** 낸다 — 받는 쪽
 *   (여기서 묶은 재배 · 배양 · 해석, 채굴은 `parts/Mining`)이 자기 시각을 그만큼 민다. `stationNow(uid)` = `pausedAt[uid] ?? now`.
 * - **자동 보충** (`POWER_AUTO_TOPUP`, `data/tuning.csv`) — 가동 중이던 시설(또는 새로 증축한 시설)의 요구가 늘면 부족분을
 *   **남는 전력에서만** 채운다. 다른 시설의 할당은 건드리지 않고, 모자라면 채우지 않는다 → 시설이 멈추고 토스트
 *   `<시설> 전력 부족 — 발전기에서 전력을 할당하세요`. 플레이어가 일부러 낮춰 둔(멈춘) 시설은 채우지 않는다.
 *
 * 상태는 `ShipState` 에만 있다 — 여기 모듈 메모(`MEMO`)는 「직전 계산의 요구 · 가동 시설 · 서명」 뿐이라 잃어도 다음 계산이 다시 만든다.
 */
import type { FacilityPowerInfo, PowerOverview, WorkbenchKind } from '@/shared';
import { POWER_AUTO_TOPUP, ROOM_PURPOSE_LABEL_KO } from '@/shared';
import type { HousingSystem } from '../HousingSystem';
import {
  allocationOf, benchBlockIn, computePower, facilityShortToast, furnitureDemand, isPowerFacilityRoom, operationalBenchLevel, operationalBlockIn,
  powerInt, powerSupplyOf, totalAllocation,
} from '../PowerRules';
import type { PowerSnapshot } from '../PowerRules';
import { shiftPausedGrows } from './Garden';
import { shiftPausedCultures } from './Culture';
import { shiftPausedAnalyses } from './Lab';

interface PowerMemo {
  /** 직전 계산이 끝났다 (첫 계산은 기준만 잡고 자동 보충 · 토스트를 하지 않는다). */
  seeded: boolean;
  /** 직전 계산의 시설별 요구 (방 번호 → 요구). */
  required: Map<number, number>;
  /** 직전 계산에서 전력이 충분했던 시설. */
  powered: Set<number>;
  /** 직전 `housing:powerChanged` 의 서명. */
  sig: string;
  busy: boolean;
  again: string | null;
}

const MEMO = new WeakMap<HousingSystem, PowerMemo>();

function memoOf(sys: HousingSystem): PowerMemo {
  let m = MEMO.get(sys);
  if (!m) { m = { seeded: false, required: new Map(), powered: new Set(), sig: '', busy: false, again: null }; MEMO.set(sys, m); }
  return m;
}

/** 자동 보충을 하지 않는 계산 사유 — 플레이어가 직접 할당한 것 · 불러온 문서 · 첫 계산. */
const NO_TOPUP = new Set(['alloc', 'power', 'profile', 'load', 'disable']);
/** 「전력 부족」 토스트를 띄우지 않는 사유 — 할당을 직접 낮춘 것 · 불러온 문서. */
const NO_TOAST = new Set(['alloc', 'power', 'profile', 'load', 'disable', 'recover', 'purpose']);

/* ── 바인딩 ──────────────────────────────────────────────────────────────── */

/**
 * `HousingSystem.init` 에서 한 번. 멈춤에서 풀린 가구의 시각 밀기(재배 · 배양 · 해석)를 먼저 묶고, 가구 · 방 · 발전기 사건마다
 * `recompute` 를 건다. 첫 계산(기준)을 여기서 바로 한다.
 */
export function bindPower(sys: HousingSystem): Array<() => void> {
  const b = sys.ctx.bus;
  const unsubs = [
    b.on('housing:operationalChanged', ({ uid, operational, pausedMs }) => {
      if (!operational || !(pausedMs > 0)) return;
      shiftPausedGrows(sys, uid, pausedMs);
      shiftPausedCultures(sys, uid, pausedMs);
      shiftPausedAnalyses(sys, uid, pausedMs);
    }),
    b.on('housing:loaded', () => { const m = memoOf(sys); m.seeded = false; m.required.clear(); m.powered.clear(); recompute(sys, 'load'); }),
    b.on('housing:changed', ({ reason }) => recompute(sys, reason)),
    b.on('housing:furniturePlaced', () => recompute(sys, 'place')),
    b.on('housing:furnitureMoved', () => recompute(sys, 'move')),
    b.on('housing:furnitureRecovered', () => recompute(sys, 'recover')),
    b.on('housing:furnitureUpgraded', () => recompute(sys, 'furnitureUpgrade')),
    b.on('housing:facilityUpgraded', () => recompute(sys, 'generator')),
    b.on('housing:roomPurposeChanged', ({ room }) => {
      // 용도가 바뀌거나 방이 비면 그 방의 할당은 사라진다 — 새 시설은 「새로 증축한 시설」로 다시 센다
      const alloc = sys.state.powerAlloc;
      if (alloc && String(room) in alloc) delete alloc[String(room)];
      const m = memoOf(sys);
      m.required.delete(room);
      m.powered.delete(room);
      recompute(sys, 'purpose');
    }),
  ];
  recompute(sys, 'load');
  return unsubs;
}

/* ── 다시 계산 ───────────────────────────────────────────────────────────── */

/**
 * 작동 여부를 다시 계산해 멈춤 기록 · 이벤트 · 자동 보충 · 토스트를 맞춘다. 같은 호출 스택 안에서 다시 불리면(받는 쪽이 `housing:changed`
 * 를 냈다) 끝난 뒤 한 번 더 돈다.
 */
export function recompute(sys: HousingSystem, reason: string): void {
  const m = memoOf(sys);
  if (m.busy) { m.again = m.again ?? reason; return; }
  m.busy = true;
  try {
    let next: string | null = reason;
    for (let guard = 0; next !== null && guard < 4; guard++) {
      m.again = null;
      runOnce(sys, m, next);
      next = m.again;
    }
  } finally {
    m.busy = false;
    m.again = null;
  }
}

function runOnce(sys: HousingSystem, m: PowerMemo, reason: string): void {
  const state = sys.state;
  let dirty = false;
  if (!state.powerAlloc || typeof state.powerAlloc !== 'object') { state.powerAlloc = {}; dirty = true; }
  if (!Array.isArray(state.disabledFurniture)) { state.disabledFurniture = []; dirty = true; }
  if (!state.pausedAt || typeof state.pausedAt !== 'object') { state.pausedAt = {}; dirty = true; }
  const alloc = state.powerAlloc, paused = state.pausedAt;

  // 정리: 시설이 아닌 방의 할당 · 배치되지 않은 가구의 비활성 표시
  for (const k of Object.keys(alloc)) {
    if (!isPowerFacilityRoom(state, Number(k)) || powerInt(alloc[k]) <= 0) { delete alloc[k]; dirty = true; }
  }
  const placed = new Set(state.furniture.map((f) => f.uid));
  const keepDisabled = state.disabledFurniture.filter((uid, i, a) => placed.has(uid) && a.indexOf(uid) === i);
  if (keepDisabled.length !== state.disabledFurniture.length) { state.disabledFurniture = keepDisabled; dirty = true; }

  let snap = computePower(state);

  // 자동 보충 — 가동 중이던 시설(또는 새 시설)의 요구가 늘었을 때만, 남는 전력으로만
  if (POWER_AUTO_TOPUP && m.seeded && !NO_TOPUP.has(reason)) {
    let free = snap.free, changed = false;
    for (const info of snap.facilities) {
      if (info.powered) continue;
      const prev = m.required.get(info.room);
      const wasPowered = prev === undefined || m.powered.has(info.room);
      if (!wasPowered || (prev !== undefined && info.required <= prev)) continue;
      const need = info.required - info.allocated;
      if (need > 0 && need <= free) {
        alloc[String(info.room)] = info.required;
        free -= need;
        changed = true;
      }
    }
    if (changed) { dirty = true; snap = computePower(state); }
  }

  // 멈춤 기록의 차이
  const now = sys.nowMs();
  const events: Array<{ uid: string; operational: boolean; pausedMs: number }> = [];
  for (const [uid, block] of snap.blocks) {
    const wasRunning = !(uid in paused);
    const running = block === null;
    if (wasRunning && !running) {
      paused[uid] = now;
      dirty = true;
      // 첫 계산(불러오기)에서 기록이 없던 멈춘 가구는 조용히 적는다 — 「멈췄다」 사건이 아니라 이관이다
      if (m.seeded) events.push({ uid, operational: false, pausedMs: 0 });
    } else if (!wasRunning && running) {
      const at = Number(paused[uid]);
      delete paused[uid];
      dirty = true;
      events.push({ uid, operational: true, pausedMs: Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : 0 });
    }
  }
  // 더는 전력을 쓰지 않는(회수 · 조종석 · 전력 0) 가구의 멈춤 기록 — 배치돼 있으면 다시 도는 것이다
  for (const uid of Object.keys(paused)) {
    if (snap.blocks.has(uid)) continue;
    const at = Number(paused[uid]);
    delete paused[uid];
    dirty = true;
    if (placed.has(uid)) events.push({ uid, operational: true, pausedMs: Number.isFinite(at) && at > 0 ? Math.max(0, now - at) : 0 });
  }

  // 토스트 — 가동 중이던 시설이 이번 변경으로 멈췄다 (할당을 직접 낮춘 것 · 회수 · 불러오기는 빼고)
  const toasts: string[] = [];
  if (m.seeded && !NO_TOAST.has(reason)) {
    for (const info of snap.facilities) {
      if (info.powered) continue;
      const prev = m.required.get(info.room);
      if (prev === undefined ? info.base <= 0 && info.furniture.length === 0 : !m.powered.has(info.room)) continue;
      toasts.push(facilityShortToast(ROOM_PURPOSE_LABEL_KO[info.purpose]));
    }
  }

  m.required.clear();
  m.powered.clear();
  for (const info of snap.facilities) {
    m.required.set(info.room, info.required);
    if (info.powered) m.powered.add(info.room);
  }
  const wasSeeded = m.seeded;
  m.seeded = true;

  const bus = sys.ctx.bus;
  for (const e of events) bus.emit('housing:operationalChanged', e);
  const sig = signature(snap);
  if (sig !== m.sig) {
    m.sig = sig;
    if (wasSeeded || reason === 'load') bus.emit('housing:powerChanged', { reason });
  }
  for (const text of toasts) sys.notify(text, 'warning');
  if (dirty) sys.saveSoon();
}

function signature(snap: PowerSnapshot): string {
  const parts = [`${snap.supply}/${snap.allocated}/${snap.required}`];
  for (const f of snap.facilities) {
    parts.push(`${f.room}:${f.purpose}:${f.required}:${f.allocated}`);
    for (const p of f.furniture) parts.push(`${p.uid}:${p.demand}:${p.disabled ? 1 : 0}:${p.block ?? ''}`);
  }
  return parts.join('|');
}

/* ── 계약 API ─────────────────────────────────────────────────────────────── */

export function getPowerOverview(sys: HousingSystem): PowerOverview {
  const s = computePower(sys.state);
  return { supply: s.supply, allocated: s.allocated, free: s.free, required: s.required, facilities: s.facilities };
}

export function getFacilityPower(sys: HousingSystem, room: number): FacilityPowerInfo | null {
  return computePower(sys.state).byRoom.get(room) ?? null;
}

export function setPowerAllocation(sys: HousingSystem, room: number, amount: number): string | null {
  const state = sys.state;
  if (!isPowerFacilityRoom(state, room)) return '전력을 할당할 수 없는 방입니다';
  const raw = Number(amount);
  if (!Number.isFinite(raw) || raw < 0) return '할당량은 0 이상이어야 합니다';
  const n = Math.floor(raw);
  const cur = allocationOf(state, room);
  if (n === cur) return null;
  const others = totalAllocation(state) - cur;
  const max = Math.max(0, powerSupplyOf(state) - others);
  if (n > max) return `남는 전력이 부족합니다 (최대 ${max})`;
  const alloc = state.powerAlloc ?? (state.powerAlloc = {});
  if (n > 0) alloc[String(room)] = n; else delete alloc[String(room)];
  recompute(sys, 'alloc');
  sys.changed('power');
  return null;
}

export function isFurnitureDisabled(sys: HousingSystem, uid: string): boolean {
  return Array.isArray(sys.state.disabledFurniture) && sys.state.disabledFurniture.includes(uid);
}

export function setFurnitureDisabled(sys: HousingSystem, uid: string, disabled: boolean): string | null {
  const item = sys.getPlacedByUid(uid);
  if (!item) return '설치되지 않은 가구입니다';
  if (furnitureDemand(sys.state, item) <= 0) return '전력을 쓰지 않는 가구입니다';
  const list = Array.isArray(sys.state.disabledFurniture) ? sys.state.disabledFurniture : (sys.state.disabledFurniture = []);
  const has = list.includes(uid);
  if (has === !!disabled) return null;
  if (disabled) list.push(uid); else list.splice(list.indexOf(uid), 1);
  recompute(sys, disabled ? 'disable' : 'enable');
  sys.changed('power');
  return null;
}

export function furnitureOperationalBlock(sys: HousingSystem, uid: string): string | null {
  return operationalBlockIn(computePower(sys.state), uid);
}

export function stationNow(sys: HousingSystem, uid: string): number {
  const now = sys.nowMs();
  const at = Number(sys.state.pausedAt?.[uid]);
  return Number.isFinite(at) && at > 0 ? Math.min(at, now) : now;
}

export function getOperationalBenchLevel(sys: HousingSystem, kind: WorkbenchKind): number {
  return operationalBenchLevel(sys.state, computePower(sys.state), kind);
}

export function benchOperationalBlock(sys: HousingSystem, kind: WorkbenchKind): string | null {
  return benchBlockIn(sys.state, computePower(sys.state), kind);
}
