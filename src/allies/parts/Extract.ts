/**
 * src/allies/parts/Extract.ts — **extraction**. Three user's decisions live here.
 *
 *  ① A 「탈출하고 싶다」 ping → it looks inside the harness for an **already discovered** extraction pad and pings it.
 *     When the same person says it again within `ALLY_EXTRACT_CONFIRM_S`, it walks there and **presses the call
 *     button**.
 *  ② An extract ping once the bag reaches 「조금 무거움」 — **once per raid**. 「무거움」 gets one more, and that one
 *     fires again every time the load comes back to normal and grows heavy again (the asymmetry of the user's
 *     decision carried over as it stands).
 *  ③ When the ship has landed and the squad leader goes to board, it boards too. On liftoff **what was found in the
 *     raid** goes to the squad leader's stash (`ally deposit` → `inventory:allyDeposit`); the base kit is a bound
 *     thing and does not follow.
 *  ④ 2026-09-16 user's decision: when **a PC has pinged the way out** and says 「탈출하고 싶다」, it does not search for
 *     a pad itself and walks **to that ping spot** — 「PC 하네스 범위 내에서 해당 탈출구를 향해 이동」. Agreeing and
 *     marking live in `parts/Commands.agreeToHumanExtract`, the walking in `seek`'s `hasExtractPing` branch here. The
 *     confirm window (①) is unchanged, so saying it once more presses the console.
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

  // The ship has landed and the squad leader goes to board → it boards too.
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

/* ── ① searching for the way out ─────────────────────────────────────────── */

/** Finds an already discovered pad inside the harness, writes it into `out` and returns its id. Null with none. */
function findPad(sys: AllySystem, out: THREE.Vector3): string | null {
  const pads = sys.ctx.extraction?.getPads?.() ?? [];
  const fog = sys.ctx.world?.fog ?? null;
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const p of pads) {
    if (sys.leaderKnown && dist2D(p.position, sys.leaderPos) > sys.harness) continue;
    if (fog && !fog.isDiscovered(p.position)) continue;      // undiscovered = does not exist (the fog contract)
    const d = sys.leaderKnown ? dist2D(p.position, sys.leaderPos) : 0;
    if (d < bestD) { bestId = p.id; bestD = d; out.copy(p.position); }
  }
  return bestId;
}

function seek(sys: AllySystem, a: Ally, dt: number): void {
  // ④ With a way out a PC has pinged it does not search itself — it walks to that spot, inside the harness.
  if (a.hasExtractPing) {
    Nav.clampToHarness(sys.leaderKnown ? sys.leaderPos : a.position, sys.harness, a.extractPingPos, _v1);
    a.running = true;
    if (Nav.step(sys, a, _v1, ALLY_RUN_SPEED, dt) <= ALLY_MOVE_ARRIVE_M) {
      // Arrived — the harness is tied to the squad leader, so it stands and waits here (when the leader comes,
      // ③ boarding takes over).
      Nav.halt(a);
      a.running = false;
    }
    return;
  }
  Nav.halt(a);
  void dt;
  if (a.oneShot) return;      // already searched on this entry (no repeat during the transition — `Ally.oneShot`)
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
  // The confirm window is open — the request itself ends (saying it again turns `confirmExtract` on in
  // `Commands.onExtractComms`).
  Commands.finishTask(sys, a);
}

/* ── the call button ─────────────────────────────────────────────────────── */

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

/* ── ③ boarding ──────────────────────────────────────────────────────────── */

function board(sys: AllySystem, a: Ally, dt: number): void {
  const ex = sys.ctx.extraction;
  const bp = ex?.boardingPoint?.(_v1) ?? null;
  if (!bp) { Nav.halt(a); return; }
  if (ex?.isInShipBay(a.position)) { Nav.halt(a); return; }
  a.running = true;
  Nav.step(sys, a, bp, ALLY_RUN_SPEED, dt);
}

/* ── ② the weight-driven extract ping ────────────────────────────────────── */

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

/* ── liftoff ─────────────────────────────────────────────────────────────── */

/** Liftoff — a unit alive in the ship bay counts as extracted; its loot goes to the squad leader's stash. */
export function onLiftoff(sys: AllySystem): void {
  if (!sys.simulating) return;
  const ex = sys.ctx.extraction;
  for (const a of sys.bodies) {
    if (a.mode !== 'raid' || a.dead || !ex?.isInShipBay(a.position)) continue;
    const loot = a.loot();
    a.state = 'aboard';
    a.hidden = true;
    sys.depositToLeader(a, loot);
    // Picked-up gear went out with it — the equipment slots are emptied and the bag stripped (the kit stays).
    for (const slot of ['primary', 'armor', 'bag'] as const) {
      const it = a.equip[slot];
      if (it && !a.kitUids.has(it.uid)) a.equip[slot] = null;
    }
    if (a.bag) a.bag.clear();
    a.bagDirty = true;
  }
}

/** How long the confirm window lasts (s) — `AllySystem` reads it. */
export const CONFIRM_WINDOW_S = ALLY_EXTRACT_CONFIRM_S;
