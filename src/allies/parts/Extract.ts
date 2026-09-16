/**
 * src/allies/parts/Extract.ts — **탈출**. 사용자 결정 세 가지가 여기 산다.
 *
 *  ① 「탈출하고 싶다」 핑 → 하네스 안에서 **이미 밝혀진** 탈출 패드를 찾아 핑을 찍는다. 같은 사람이
 *     `ALLY_EXTRACT_CONFIRM_S` 안에 다시 말하면 거기까지 걸어가 **호출 버튼을 누른다**.
 *  ② 가방이 「조금 무거움」이 되면 탈출 핑 — **레이드당 한 번**. 「무거움」이 되면 또 한 번이고, 이쪽은 보통으로
 *     돌아왔다가 다시 무거워지면 다시 찍는다 (사용자 결정의 비대칭을 그대로 옮긴 것이다).
 *  ③ 함선이 내려앉고 분대장이 타러 가면 같이 탄다. 이륙하면 **레이드에서 주운 것**이 분대장 창고로 간다
 *     (`ally deposit` → `inventory:allyDeposit`); 기본 킷은 묶인 물건이라 따라가지 않는다.
 *  ④ 2026-09-16 사용자 결정: **PC 가 탈출구 핑을 찍고** 「탈출하고 싶다」면 스스로 패드를 찾지 않고 **그 핑 자리로**
 *     간다 — 「PC 하네스 범위 내에서 해당 탈출구를 향해 이동」. 동의와 표시는 `parts/Commands.agreeToHumanExtract`,
 *     걸음은 여기 `seek` 의 `hasExtractPing` 갈래다. 확인 창(①)은 그대로라 한 번 더 말하면 콘솔을 누른다.
 */
import type * as THREE from 'three';
import {
  ALLY_EXTRACT_CONFIRM_S, ALLY_MOVE_ARRIVE_M, ALLY_RUN_SPEED,
} from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import type { Proposal } from './Fsm';
import { CHAT_KO, PRIO, _v1, _v2, dist2D } from '../model';
import * as Nav from './Nav';
import * as Ping from './Ping';
import * as Commands from './Commands';

export function proposal(sys: AllySystem, a: Ally): Proposal | null {
  weightPing(sys, a);
  if (a.state === 'aboard') return null;

  // 함선이 내려앉았고 분대장이 타러 간다 → 같이 탄다.
  const ex = sys.ctx.extraction;
  if (ex && (ex.stage === 'landed' || ex.stage === 'departing') && sys.leaderKnown) {
    const bp = ex.boardingPoint?.(_v1) ?? null;
    if (bp && (ex.isInShipBay(sys.leaderPos) || dist2D(sys.leaderPos, bp) < sys.harness)) {
      return { state: 'board', prio: PRIO.extract };
    }
  }

  if (a.taskKind !== 'extract') return null;
  if (a.confirmExtract && a.extractPadId) return { state: 'callExtract', prio: PRIO.extract };
  return { state: 'seekExtract', prio: PRIO.extract };
}

export function act(sys: AllySystem, a: Ally, dt: number): void {
  switch (a.state) {
    case 'seekExtract': return seek(sys, a, dt);
    case 'callExtract': return call(sys, a, dt);
    case 'board': return board(sys, a, dt);
    default: Nav.halt(a);
  }
}

/* ── ① 탈출구 탐색 ──────────────────────────────────────────────────────── */

/** 하네스 안에서 이미 밝혀진 패드를 찾아 `out` 에 쓰고 그 id 를 돌려준다. 없으면 null. */
function findPad(sys: AllySystem, out: THREE.Vector3): string | null {
  const pads = sys.ctx.extraction?.getPads?.() ?? [];
  const fog = sys.ctx.world?.fog ?? null;
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const p of pads) {
    if (sys.leaderKnown && dist2D(p.position, sys.leaderPos) > sys.harness) continue;
    if (fog && !fog.isDiscovered(p.position)) continue;      // 발견하지 못한 것은 없는 것이다 (안개 규약)
    const d = sys.leaderKnown ? dist2D(p.position, sys.leaderPos) : 0;
    if (d < bestD) { bestId = p.id; bestD = d; out.copy(p.position); }
  }
  return bestId;
}

function seek(sys: AllySystem, a: Ally, dt: number): void {
  // ④ PC 가 찍어 둔 탈출구가 있으면 스스로 찾지 않는다 — 하네스 안에서 그 자리로 걸어간다.
  if (a.hasExtractPing) {
    Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, a.extractPingPos, _v1);
    a.running = true;
    if (Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt) <= ALLY_MOVE_ARRIVE_M) {
      // 도착했다 — 하네스가 분대장에게 묶여 있으니 여기 서서 기다린다 (분대장이 오면 ③ 탑승이 이어받는다).
      Nav.halt(a);
      a.running = false;
    }
    return;
  }
  Nav.halt(a);
  void dt;
  if (a.oneShot) return;      // 이번 진입에서 이미 찾아 봤다 (전이 지연 동안 반복 실행 금지 — `Ally.oneShot`)
  a.oneShot = true;
  const id = findPad(sys, _v2);
  if (!id) {
    Ping.say(sys, a, CHAT_KO.noExtract);
    Commands.finishTask(sys, a);
    return;
  }
  a.extractPadId = id;
  a.extractPingAt = sys.ctx.time;
  a.extractRequester = a.taskBy;
  Ping.place(sys, a, 'extraction', _v2);
  // 확인 창이 열렸다 — 요청 자체는 끝난다 (다시 말하면 `Commands.onExtractComms` 가 `confirmExtract` 를 켠다).
  Commands.finishTask(sys, a);
}

/* ── 호출 버튼 ──────────────────────────────────────────────────────────── */

function call(sys: AllySystem, a: Ally, dt: number): void {
  const pads = sys.ctx.extraction?.getPads?.() ?? [];
  const pad = pads.find((p) => p.id === a.extractPadId) ?? null;
  if (!pad) { a.confirmExtract = false; Commands.finishTask(sys, a); Nav.halt(a); return; }
  _v1.copy(pad.position);
  a.running = true;
  const left = Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt);
  if (left > ALLY_MOVE_ARRIVE_M) return;
  Nav.halt(a);
  a.running = false;
  sys.ctx.extraction?.requestActivate?.(pad.id);
  a.confirmExtract = false;
  Commands.finishTask(sys, a);
}

/* ── ③ 탑승 ────────────────────────────────────────────────────────────── */

function board(sys: AllySystem, a: Ally, dt: number): void {
  const ex = sys.ctx.extraction;
  const bp = ex?.boardingPoint?.(_v1) ?? null;
  if (!bp) { Nav.halt(a); return; }
  if (ex?.isInShipBay(a.position)) { Nav.halt(a); return; }
  a.running = true;
  Nav.step(sys, a, bp, ALLY_RUN_SPEED, dt);
}

/* ── ② 무게로 인한 탈출 핑 ─────────────────────────────────────────────── */

function weightPing(sys: AllySystem, a: Ally): void {
  const w = a.weightState;
  if (w === 'normal') { a.heavyPingArmed = true; return; }
  if (w === 'light' && !a.lightPingDone) {
    a.lightPingDone = true;
    sayExtract(sys, a);
    return;
  }
  if ((w === 'heavy' || w === 'over') && a.heavyPingArmed) {
    a.heavyPingArmed = false;
    sayExtract(sys, a);
  }
}

function sayExtract(sys: AllySystem, a: Ally): void {
  Ping.say(sys, a, CHAT_KO.wantExtract);
  const id = findPad(sys, _v2);
  if (id) Ping.place(sys, a, 'extraction', _v2);
}

/* ── 이륙 ──────────────────────────────────────────────────────────────── */

/** 이륙 — 화물칸 안에 살아 있는 기는 탈출한 것으로 보고 전리품을 분대장 창고로 보낸다. */
export function onLiftoff(sys: AllySystem): void {
  if (!sys.simulating) return;
  const ex = sys.ctx.extraction;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || !ex?.isInShipBay(a.position)) continue;
    const loot = a.loot();
    a.state = 'aboard';
    a.hidden = true;
    sys.depositToLeader(a, loot);
    // 주운 장비까지 같이 나갔다 — 낀 자리를 비우고 가방을 턴다 (킷은 그대로 남는다).
    for (const slot of ['primary', 'armor', 'bag'] as const) {
      const it = a.equip[slot];
      if (it && !a.kitUids.has(it.uid)) a.equip[slot] = null;
    }
    if (a.bag) a.bag.clear();
    a.bagDirty = true;
  }
}

/** 확인 창의 길이 (s) — `AllySystem` 이 읽는다. */
export const CONFIRM_WINDOW_S = ALLY_EXTRACT_CONFIRM_S;
