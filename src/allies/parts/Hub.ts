/**
 * src/allies/parts/Hub.ts — **the android in the ship**.
 *
 * Shared ship: a dormant body stands inside the cockpit bay (`HubRef.getAndroidBays`). The squad leader calls it
 * in, and that unit steps out of the capsule (`emerge`) and walks to the front of its own **launch pod**
 * (`HubRef.getPodStandPose`) to wait there (`hubIdle`). Sent back, it walks back in (`retire` → `dormant`).
 *
 * **The ship has no wire** — every client computes the same spot from the same lobby state. A body in the ship
 * takes its position from the lobby, so there is nothing to trade snapshots for, and that is what lets a late
 * joiner see the same picture at once.
 *
 * The cheat android of the personal ship has no bay (user's decision 「공용 함선 전용」) — it stands
 * `ALLY_HUB_FOLLOW_M` beside the PC.
 *
 * **The body in the ship wears the base kit too** (2026-09-16 user's decision): entering builds it fresh with
 * `Bag.equipKit`, and the idempotent `Bag.ensureKit` keeps it while it stands there. The ship has no dropping ·
 * handing over · corpse · stash, so a bound kit has no road out of it either.
 */
import { ALLY_HUB_FOLLOW_M, ALLY_WALK_SPEED } from '@/shared';
import type { HubAndroidBay } from '@/shared';
import type { AllySystem } from '../AllySystem';
import type { Ally } from './Body';
import { _v1, dist2D, yawToward } from '../model';
import * as Bag from './Bag';
import * as Nav from './Nav';
import * as Roster from './Roster';

/** The distance (m) that counts as 「arrived」 when walking — a layout constant. */
const ARRIVE_M = 0.4;

export function onHubEntered(sys: AllySystem): void {
  Roster.syncBodies(sys);
  for (const a of sys.bodies) {
    a.resetSim();
    a.mode = Roster.isRecruited(sys, a.id) ? 'hub' : 'dormant';
    a.state = a.mode === 'hub' ? 'hubIdle' : 'dormant';
    a.pose = a.mode === 'hub' ? 'stand' : 'dormant';
    a.hidden = false;
    a.hp = a.maxHp = Math.max(1, a.maxHp);
    a.dead = false;
    a.downed = false;
    /*
     * 2026-09-16 (user's decision 「호출되는 순간 기본 킷을 장착한 채로 선다」): entering the ship **stands it up in
     * the base kit again** — symmetrical with raid entry (`parts/Spawn`). Why a fresh build and not the idempotent
     * `ensureKit`: the raid that just ended may have left looted gear equipped or loot in the bag (the extraction
     * deposit moves only `raidFound` items), and then the androids in the ship stand in different outfits and
     * the launch slot card shows raid leftovers. The new kit is a bound thing too, so it has no road out either.
     */
    Bag.equipKit(sys, a);
    a.shield = a.maxShield;   // armor just put on — the shield is full (`equipKit` → `refreshLook` only sets the max)
    place(sys, a, true);
  }
}

export function onHubLeft(sys: AllySystem): void {
  for (const a of sys.bodies) a.hidden = true;
}

export function update(sys: AllySystem, dt: number): void {
  const ship = sys.ctx.hub?.ship ?? null;
  if (!ship) return;
  // A cockpit bay can appear **after** the ship is fully built (the order hub builds in). When a bay is missing,
  // the bodies are matched again.
  if (ship === 'shared') {
    for (const b of sys.ctx.hub?.getAndroidBays?.() ?? []) {
      if (!sys.bodies.some((x) => x.bay === b.bay)) { Roster.syncBodies(sys); break; }
    }
  }
  for (const a of sys.bodies) {
    // While it stands in the ship it always wears the base kit (2026-09-16 user's decision). The test is
    // idempotent, so calling it every frame is cheap, and it fills in one place even the paths that missed
    // `hub:entered` (a body created here because its bay appeared late, and the like).
    Bag.ensureKit(sys, a);
    const recruited = Roster.isRecruited(sys, a.id);
    if (ship === 'personal') { personal(sys, a, recruited, dt); continue; }
    shared(sys, a, recruited, dt);
  }
}

/* ── The shared ship ─────────────────────────────────────────────── */

function bayOf(sys: AllySystem, a: Ally): HubAndroidBay | null {
  for (const b of sys.ctx.hub?.getAndroidBays?.() ?? []) if (b.bay === a.bay) return b;
  return null;
}

function shared(sys: AllySystem, a: Ally, recruited: boolean, dt: number): void {
  const bay = bayOf(sys, a);
  a.hidden = false;
  // The transition — called in it comes out, sent back it goes in.
  if (recruited && (a.state === 'dormant' || a.state === 'retire')) a.state = 'emerge';
  if (!recruited && (a.state === 'hubIdle' || a.state === 'emerge')) a.state = 'retire';
  a.mode = a.state === 'dormant' ? 'dormant' : 'hub';

  switch (a.state) {
    case 'dormant':
      if (bay) { a.position.copy(bay.position); a.yaw = bay.yaw; }
      a.pose = 'dormant';
      Nav.halt(a);
      break;
    case 'emerge': {
      a.pose = 'stand';
      const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
      // One step out of the capsule first, then on to the front of the launch pod.
      const target = bay && dist2D(a.position, bay.exit) > ARRIVE_M && !leftBay(a, bay) ? bay.exit : stand?.position ?? null;
      if (!target) { a.state = 'hubIdle'; Nav.halt(a); break; }
      const left = Nav.step(sys, a, target, ALLY_WALK_SPEED, dt);
      if (left <= ARRIVE_M && (!stand || target === stand.position)) {
        a.state = 'hubIdle';
        if (stand) a.yaw = stand.yaw;
        Nav.halt(a);
      }
      break;
    }
    case 'hubIdle': {
      a.pose = 'stand';
      const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
      if (stand && dist2D(a.position, stand.position) > ARRIVE_M) Nav.step(sys, a, stand.position, ALLY_WALK_SPEED, dt);
      else { Nav.halt(a); if (stand) a.yaw = stand.yaw; }
      break;
    }
    case 'retire': {
      a.pose = 'stand';
      if (!bay) { a.state = 'dormant'; Nav.halt(a); break; }
      const target = dist2D(a.position, bay.exit) > ARRIVE_M ? bay.exit : bay.position;
      const left = Nav.step(sys, a, target, ALLY_WALK_SPEED, dt);
      if (left <= ARRIVE_M && target === bay.position) { a.state = 'dormant'; a.yaw = bay.yaw; Nav.halt(a); }
      break;
    }
    default:
      a.state = recruited ? 'hubIdle' : 'dormant';
      break;
  }
}

/** Has it already come out of the capsule (past the one-step spot). */
function leftBay(a: Ally, bay: HubAndroidBay): boolean {
  return dist2D(a.position, bay.position) > dist2D(bay.exit, bay.position);
}

/* ── The personal ship (cheat) ────────────────────────── */

function personal(sys: AllySystem, a: Ally, recruited: boolean, dt: number): void {
  if (!recruited) { a.hidden = true; return; }
  const p = sys.ctx.player;
  if (!p) { a.hidden = true; return; }
  a.hidden = false;
  a.mode = 'hub';
  a.state = 'hubIdle';
  a.pose = 'stand';
  const d = dist2D(a.position, p.position);
  if (d > ALLY_HUB_FOLLOW_M) Nav.step(sys, a, p.position, ALLY_WALK_SPEED, dt);
  else { Nav.halt(a); a.yaw = yawToward(a.position, p.position); }
}

/**
 * Puts a body on its **entry spot** — every body, both ships. `onHubEntered` calls it for each one: in the shared
 * ship an unrecruited unit lands inside its cockpit bay and a recruited one at its launch-pod stand (falling back to
 * the bay exit when the pod stand is not built yet), and in the personal ship the cheat android lands
 * `ALLY_HUB_FOLLOW_M` beside the PC. `snap` also sticks it to the floor.
 */
export function place(sys: AllySystem, a: Ally, snap: boolean): void {
  const ship = sys.ctx.hub?.ship ?? null;
  if (ship === 'shared') {
    const bay = bayOf(sys, a);
    if (bay && !Roster.isRecruited(sys, a.id)) { a.position.copy(bay.position); a.yaw = bay.yaw; return; }
    const stand = sys.ctx.hub?.getPodStandPose?.(a.slot) ?? null;
    if (stand) { a.position.copy(stand.position); a.yaw = stand.yaw; }
    else if (bay) { a.position.copy(bay.exit); a.yaw = bay.yaw; }
    return;
  }
  const p = sys.ctx.player;
  if (!p) return;
  _v1.copy(p.position);
  _v1.x += ALLY_HUB_FOLLOW_M;
  a.position.copy(_v1);
  a.yaw = yawToward(a.position, p.position);
  if (snap) Nav.snapToGround(sys, a);
}
