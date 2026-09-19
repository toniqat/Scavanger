/**
 * src/gadgets/parts/Mount.ts — **how long, and how, does a deployable riding a drone follow it?** (2026-09-11)
 *
 * While `Deployable.mount` holds a drone id, the position is `DroneRef.getMountPoint` every frame. Every client
 * already has a replica of the drone's position, so **each one follows it locally** — there is no position message.
 *
 * When the drone goes, the mounted deployable drops to the surface below that spot and **stays as a ground
 * deployable** (`mount = null`):
 *  - everyone drops it locally on `drone:removed` (an immediate reaction).
 *  - the host additionally **re-broadcasts `gad spawn` under the same id** (with no `mount`). That route was chosen
 *    because the contract has no position-update message, and the receiving side (spawn in `Wire`) creates nothing
 *    for an id it already has: it overwrites position · yaw · hp · armed · mount only — so a landing spot pulled out
 *    of place by the replica's drone interpolation lag is lined up with the host's.
 *  - a non-host **does not unmount on that alone** when `getDrone` returns null — for a late joiner `gad sync` can
 *    arrive before `drone sync`, so reading a drone it does not know yet as "gone" would drop a perfectly good
 *    mounted deployable to the ground.
 *
 * The enemy-only trigger of a mine riding a drone belongs to the mine simulation (`Simulate`) — this file only keeps
 * `mount` accurate.
 */
import type { DeployableWire, DroneRef, GameContext } from '@/shared';
import type { Deployable } from '../Deployable';
import type { GadgetSystem } from '../GadgetSystem';

/**
 * `DroneRef.mountedDeployableId` is readonly in the contract and documented as "gadgets sets it". When the drone
 * implementation keeps it as a writable field this fills it in; when it is a getter only (computing itself) the
 * assignment fails silently.
 */
function setDroneMountId(drone: DroneRef | null | undefined, id: string | null): void {
  if (!drone) return;
  try { (drone as { mountedDeployableId: string | null }).mountedDeployableId = id; } catch { /* getter-only */ }
}

/**
 * Right after the spawn: mounts it on the drone. While the drone is still unknown it holds the id alone and waits
 * (the position stays where it was requested).
 */
export function attach(sys: GadgetSystem, d: Deployable, droneId: string): void {
  d.mount = droneId;
  const drone = sys.ctx.drones?.getDrone(droneId) ?? null;
  if (!drone) return;
  drone.getMountPoint(d.position);
  setDroneMountId(drone, d.id);
}

/**
 * Before a removal · a detach: clears the mark on the drone side (only while that drone still points at this
 * deployable).
 */
export function unmount(sys: GadgetSystem, d: Deployable): void {
  const id = d.mount;
  if (!id) return;
  d.mount = null;
  const drone = sys.ctx.drones?.getDrone(id) ?? null;
  if (drone && drone.mountedDeployableId === d.id) setDroneMountId(drone, null);
}

/** Drops off the drone and stands on the surface below. The host re-broadcasts `gad spawn` under the same id. */
export function detach(sys: GadgetSystem, d: Deployable): void {
  if (!d.mount) return;
  unmount(sys, d);
  const world = sys.ctx.world;
  if (world && world.ready) d.position.y = world.getSurfaceY(d.position.x, d.position.z, d.position.y);
  d.visual.root.position.copy(d.position);
  if (sys.ctx.isAuthority) sys.broadcast({ t: 'gad', ev: 'spawn', d: sys.wireOf(d) }, 'others');
}

/** Every frame (before the deployable loop): moves mounted deployables onto the drone's top face. */
export function updateMounts(sys: GadgetSystem, ctx: GameContext): void {
  const list = sys.deployables;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (!d.mount || d.removing) continue;
    const drone = ctx.drones?.getDrone(d.mount) ?? null;
    if (drone) {
      drone.getMountPoint(d.position);
      d.yaw = drone.yaw;
      if (drone.mountedDeployableId !== d.id) setDroneMountId(drone, d.id);
      continue;
    }
    // Only the authority believes "the drone is gone" (the header comment above)
    if (ctx.isAuthority) detach(sys, d);
  }
}

/** `drone:removed`: drops everything riding that drone (on every client). */
export function onDroneRemoved(sys: GadgetSystem, droneId: string): void {
  const list = sys.deployables;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d.mount === droneId && !d.removing) detach(sys, d);
  }
}

/**
 * Non-host: a `gad spawn` arrived again under an id that already exists (the host re-broadcasting a deployable that
 * dropped off a drone) — nothing is created, only the state is overwritten.
 */
export function applyWire(sys: GadgetSystem, d: Deployable, w: DeployableWire): void {
  const next = w.mount ?? null;
  if (d.mount && d.mount !== next) unmount(sys, d);
  d.position.set(w.p[0], w.p[1], w.p[2]);
  d.yaw = w.yaw;
  d.hp = w.hp;
  d.armed = w.armed;
  if (next) attach(sys, d, next);
  d.visual.root.position.copy(d.position);
  d.visual.root.rotation.y = d.yaw;
}
