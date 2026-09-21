/**
 * src/enemies/ai/Gates.ts — **the chokepoint throttle** (TODO A-18 phase 2, 2026-09-21, user's decision 「길목은 2마리씩」).
 *
 * The nav graph publishes the raid's narrow passages as gates (`NavRef.gates` — a doorway, a stair flight, a corridor). Sixty
 * bugs chasing one player through one door would otherwise pile into it as one block, so a gate lets `NAV_GATE_CAPACITY`
 * bodies through at a time: a body whose flow step reports a gate ahead needs that gate's **token**; without one it walks up
 * to `NAV_GATE_HOLD_M` from the gate and stands there. How many were refused is reported to the graph
 * (`NavRef.setGateLoad`), which makes that gate dearer in the next field build — the rest spread to another door or a window.
 *
 * - **One token per body.** Reported a different gate, it drops the old token first.
 * - **A body already inside a gate never waits** — standing still in a doorway is the one thing that would block it for good.
 * - A token is released when the flow stops reporting that gate for `TOKEN_GRACE_S` (passed through, or routed elsewhere),
 *   when the body leaves flow mode / dies / goes back to the pool (`Enemy.clearNav`), or after `NAV_GATE_TOKEN_S` without
 *   passing — and a body that lost it that way may not take another for the same time, so the queue behind it moves first.
 * - **The counters are recounted from the living bodies** every `GATE_SWEEP_S` (`sweepGates`), so whatever path drops a body —
 *   a kill, a recycle, a host change, a reset — a token can never leak. Between two sweeps take / release keep them exact.
 * - Path mode (a private goal) ignores gates: few bodies use it at once.
 *
 * Authority only, nothing on the wire. The state lives on `EnemyNavState` (`ai/NavMove`); this file only has functions.
 */
import { NAV_GATE_CAPACITY, NAV_GATE_TOKEN_S, type NavRef } from '@/shared';
import type { Enemy } from '../Enemy';
import type { EnemyNavState } from './NavMove';

/** How often the counters are rebuilt from the bodies, tokens aged and the queues reported (s). Algorithm constant. */
export const GATE_SWEEP_S = 0.5;
/** A token survives the flow not reporting its gate for this long (s) — one sample past the last cell is not 「passed」. Algorithm constant. */
const TOKEN_GRACE_S = 0.4;
/** Within this many metres of a gate's first cell (along the field) the body counts as inside it and never waits. Algorithm constant. */
const INSIDE_M = 0.05;

/** Sizes the counters to the graph's gate list (it is fixed once the graph is ready, so this runs once per raid). */
export function resizeGates(st: EnemyNavState, n: number): void {
  if (st.holders.length === n) return;
  st.holders.length = n; st.waiting.length = n; st.reported.length = n;
  for (let i = 0; i < n; i++) { st.holders[i] = 0; st.waiting[i] = 0; st.reported[i] = 0; }
}

/**
 * May this body walk on? `gate` / `gateDist` come from the flow step (`NavFlowStep`). True = go (no gate ahead, it holds the
 * token, it just took one, or it is already inside); false = refused — the caller stops it at the hold distance, and
 * `Enemy.navWaitGate` names the queue it stands in.
 */
export function gatePass(st: EnemyNavState, e: Enemy, gate: number, gateDist: number, dt: number): boolean {
  if (gate < 0 || gate >= st.holders.length) { gateMiss(st, e, dt); return true; }
  if (e.navGate === gate) { e.navGateMiss = 0; return true; }
  if (e.navGate >= 0) releaseGate(st, e);
  // `navGateAge < 0` with no token = the ban after an expired one (`sweepGates`)
  if (e.navGateAge >= 0 && st.holders[gate] < NAV_GATE_CAPACITY) {
    e.navGate = gate; e.navGateAge = 0; e.navGateMiss = 0;
    st.holders[gate]++;
    return true;
  }
  if (gateDist <= INSIDE_M) return true;
  e.navWaitGate = gate;
  return false;
}

/** The flow reported no gate (or gave no answer) this tick: a held token runs out after `TOKEN_GRACE_S` of that. */
export function gateMiss(st: EnemyNavState, e: Enemy, dt: number): void {
  if (e.navGate < 0) return;
  e.navGateMiss += dt;
  if (e.navGateMiss >= TOKEN_GRACE_S) releaseGate(st, e);
}

/** Gives the token back (a no-op without one). */
export function releaseGate(st: EnemyNavState, e: Enemy): void {
  const g = e.navGate;
  if (g < 0) return;
  if (g < st.holders.length && st.holders[g] > 0) st.holders[g]--;
  e.navGate = -1; e.navGateAge = 0; e.navGateMiss = 0;
}

/**
 * Every `GATE_SWEEP_S`: rebuild holders and queues from the living bodies, age the tokens (`NAV_GATE_TOKEN_S` → lost, and
 * banned for as long again), and tell the graph every queue length that changed.
 */
export function sweepGates(st: EnemyNavState, nav: NavRef, active: readonly Enemy[], elapsed: number): void {
  const holders = st.holders, waiting = st.waiting, reported = st.reported;
  const n = holders.length;
  for (let i = 0; i < n; i++) { holders[i] = 0; waiting[i] = 0; }
  for (let i = 0; i < active.length; i++) {
    const e = active[i];
    if (e.navGate < 0) {
      if (e.navGateAge < 0) e.navGateAge = Math.min(0, e.navGateAge + elapsed);   // the ban runs out
    } else if (e.state === 'dead' || !e.active || e.navGate >= n) {
      e.navGate = -1; e.navGateAge = 0; e.navGateMiss = 0;
    } else {
      e.navGateAge += elapsed;
      if (e.navGateAge >= NAV_GATE_TOKEN_S) { e.navGate = -1; e.navGateAge = -NAV_GATE_TOKEN_S; e.navGateMiss = 0; }
      else holders[e.navGate]++;
    }
    const w = e.navWaitGate;
    if (w >= 0 && w < n && e.state !== 'dead' && e.active) waiting[w]++;
  }
  for (let i = 0; i < n; i++) {
    if (waiting[i] === reported[i]) continue;
    reported[i] = waiting[i];
    nav.setGateLoad(i, waiting[i]);
  }
}
