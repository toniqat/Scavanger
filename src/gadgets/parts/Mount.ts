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
 * The enemy-only trigger of a mine riding a drone is the **`mine` branch** of the mine simulation
 * (`Simulate.updateMine` — a `remoteMine` never goes off by proximity at all, mounted or not). This file only keeps
 * `mount` accurate.
 *
 * **`DroneRef.mountedDeployableId` is nothing this file writes.** It is a getter on `Drone` (`drones/model.ts`) that
 * walks `GadgetsRef.getDeployables()` looking for `mount === drone.id`, so setting `d.mount` here *is* the write and
 * the drone side follows by itself. (Until 2026-09-19 this file also assigned the field through a cast; every
 * assignment threw against that getter and a `catch` swallowed it.)
 */
import type { DeployableWire, GameContext } from '@/shared';
import type { Deployable } from '../Deployable';
import type { GadgetSystem } from '../GadgetSystem';

/**
 * Right after the spawn: mounts it on the drone. While the drone is still unknown it holds the id alone and waits
 * (the position stays where it was requested).
 */
export function attach(sys: GadgetSystem, d: Deployable, droneId: string): void {
  d.mount = droneId;
  const drone = sys.ctx.drones?.getDrone(droneId) ?? null;
  if (!drone) return;
  drone.getMountPoint(d.position);
}

/** Before a removal · a detach: `mount` is the whole mark, so clearing it is the whole job (header comment). */
export function unmount(d: Deployable): void {
  if (!d.mount) return;
  d.mount = null;
}

/** Drops off the drone and stands on the surface below. The host re-broadcasts `gad spawn` under the same id. */
export function detach(sys: GadgetSystem, d: Deployable): void {
  if (!d.mount) return;
  unmount(d);
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
  if (d.mount && d.mount !== next) unmount(d);
  d.position.set(w.p[0], w.p[1], w.p[2]);
  d.yaw = w.yaw;
  d.hp = w.hp;
  d.armed = w.armed;
  if (next) attach(sys, d, next);
  d.visual.root.position.copy(d.position);
  d.visual.root.rotation.y = d.yaw;
}
