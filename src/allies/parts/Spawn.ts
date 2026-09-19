/**
 * src/allies/parts/Spawn.ts — **raid entry**. It comes down in a **drop pod** at the same spot as the people.
 *
 * Only the authority stands the bodies up (solo · the lobby host). The training range · the tutorial are
 * skipped — an android is a squadmate of the real raid. Every raid starts over from the base kit (`ANDROID_KIT`)
 * (user's decision), and until it lands it is `hidden`, so nobody draws it.
 * Since 2026-09-16 it wears the kit in the ship too (`parts/Hub`), so here that one is stripped (`Bag.clearKit`)
 * and a **new kit** is built — the kit is a bound thing, so the stripped one simply vanishes and by no road at all
 * ends up in the stash · a corpse · on the ground.
 */
import type * as THREE from 'three';
import type { AllySystem } from '../AllySystem';
import { _v1 } from '../model';
import * as Bag from './Bag';
import * as Vitals from './Vitals';
import * as Nav from './Nav';

/**
 * From the drop pod touching the ground to the body coming out (s). It matches the cutscene length of
 * `player/Hellpod.ts` (fall 2.4 + impact 0.35 + door 0.55), a **cutscene sync value** — not a balance number, so it
 * lives here and not in csv, and it changes together with that one.
 */
const POD_LAND_S = 3.3;
/** The spacing (m) that keeps squadmates from overlapping — a layout constant, wider than a body's diameter. */
const SPAWN_GAP_M = 2.5;

export function onAbort(sys: AllySystem): void {
  sys.raidActive = false;
  sys.request = null;
  sys.orderKind = null;
  sys.watchUntil = -Infinity;
  sys.preferredEnemyId = null;
  sys.viewedContainers.clear();
  for (const a of sys.bodies) { a.resetSim(); a.mode = 'dormant'; a.hidden = true; }
}

/**
 * ⚠ This folder does **not listen** to `game:newMission`. Because world builds the world synchronously
 * **inside** its own `game:newMission` handler, `world:ready` arrives **before** the `game:newMission` of a
 * system registered after it (the gotcha in docs/ARCHITECTURE.md). Unless the new-mission cleanup happens here
 * too, the `game:newMission` that comes afterwards wipes the bodies just stood up.
 */
export function onWorldReady(sys: AllySystem, playerSpawn: THREE.Vector3): void {
  const ctx = sys.ctx;
  sys.viewedContainers.clear();
  sys.landAt.clear();
  sys.request = null;
  sys.requestBlockedUntil = -Infinity;
  sys.orderKind = null;
  sys.watchUntil = -Infinity;
  sys.preferredEnemyId = null;
  /*
   * 2026-09-16 (the ship kit): the kit worn in the ship is **stripped first**. The authority builds a new kit
   * just below (it does not build one on top of another), and from here on a replica looks only at the
   * `ally bag` wire — if an empty bag made in the ship is left behind, host migration
   * (`parts/Sync.onHostChanged`) picks that up and loses the android's loot wholesale.
   */
  for (const a of sys.bodies) { a.resetSim(); Bag.clearKit(a); a.mode = 'dormant'; a.hidden = true; }
  if (ctx.missionMode !== 'raid') { sys.raidActive = false; return; }
  sys.raidActive = true;
  if (!sys.simulating) return;                      // a replica waits for `ally state`

  let i = 0;
  for (const a of sys.bodies) {
    if (!sys.roster.some((e) => e.id === a.id)) continue;   // a dormant bay body does not come to the raid
    a.mode = 'raid';
    const ang = (i / Math.max(1, sys.roster.length)) * Math.PI * 2;
    a.position.set(playerSpawn.x + Math.cos(ang) * SPAWN_GAP_M, playerSpawn.y, playerSpawn.z + Math.sin(ang) * SPAWN_GAP_M);
    Nav.snapToGround(sys, a);
    a.yaw = ang;
    Bag.equipKit(sys, a);
    Vitals.resetVitals(a);
    a.hidden = true;
    a.state = 'idle';
    a.pose = 'stand';
    // The drop pod — player/ draws it, and the body comes out at the landing time.
    _v1.copy(a.position);
    ctx.bus.emit('ally:podDrop', { id: a.id, position: _v1, yaw: a.yaw });
    sys.sendPodDrop(a);
    sys.landAt.set(a.id, ctx.time + POD_LAND_S);
    i++;
  }
}

/** Reveals every unit whose landing time has passed (each frame). */
export function updateLanding(sys: AllySystem): void {
  if (sys.landAt.size === 0) return;
  for (const [id, at] of sys.landAt) {
    if (sys.ctx.time < at) continue;
    sys.landAt.delete(id);
    const a = sys.byId.get(id);
    if (!a || a.dead) continue;
    a.hidden = false;
    Nav.snapToGround(sys, a);
  }
}
