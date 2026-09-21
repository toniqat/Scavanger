/**
 * src/player/RemotePods.ts — **squadmates' drop pods** (2026-09-09).
 *
 * The question this file answers: *what is on my screen while a squadmate drops.*
 *
 * Before 2026-09-09 a remote squadmate simply appeared on the spot. Now the dropping player sends `pod drop` and
 * **the same hellpod** (`Hellpod`) falls here — the fall, the landing impact and the door opening are the same
 * presentation as the local one; only the camera cut is missing (that belongs to whoever is falling).
 *
 * Hiding the avatar is not done here — a dropping squadmate carries `PlayerFlags.DROPPING` in its own snapshot
 * and `RemoteAvatar` already hides the body on that flag. The door opens, the flag clears, the body is back.
 *
 * **`MAX_REMOTE_PODS` pods sit in the scene from the start** (2026-09-10). Every hellpod carries one thruster
 * `PointLight`, so putting a `new Hellpod()` into the scene the moment `pod drop` arrived, as it used to, raised
 * `numPointLights` by 1 and **every material in the scene recompiled its shader** — once per squadmate, on an
 * arbitrary frame mid-raid (measured 2.7 · 3.1 s freezes). And `clear()` disposed the pods every mission, so the
 * next mission repeated it. The pods now enter the scene once at `init` and wait at light intensity 0 with the
 * body hidden; `clear()` only **hides** them — the light count never changes (`Hellpod`'s `group` / `body`
 * contract, CLAUDE.md "Never change the point-light count at runtime").
 */
import * as THREE from 'three';
import type { GameContext, PeerId } from '@/shared';
import { Hellpod, type HellpodEvents } from './Hellpod';

/** Squad size − me = how many remote pods can exist at once. */
const MAX_REMOTE_PODS = 3;

interface Entry { pod: Hellpod; ev: HellpodEvents; owner: PeerId | null }

export class RemotePods {
  /** Always `MAX_REMOTE_PODS` of them — built in the constructor, never added to or removed before `dispose`. */
  private readonly slots: Entry[] = [];
  private readonly byPeer = new Map<PeerId, Entry>();

  constructor(scene: THREE.Object3D) {
    for (let i = 0; i < MAX_REMOTE_PODS; i++) {
      const pod = new Hellpod();   // born at light intensity 0 with `body` hidden
      scene.add(pod.group);
      this.slots.push({ pod, ev: { impact: false, opened: false, finished: false }, owner: null });
    }
  }

  /** Pods currently assigned to a squadmate (smoke tests · debug). */
  get count(): number { return this.byPeer.size; }
  /** Is this squadmate's pod falling right now (smoke tests · debug). */
  isActive(id: PeerId): boolean { return this.byPeer.get(id)?.pod.isActive ?? false; }

  /**
   * `pod drop` received — drops `id`'s pod onto `position`. The same person dropping again
   * (a rescue drop) reuses that person's pod. With no free pod one that already finished is
   * reclaimed, and while all three are falling this drop is skipped silently (as before).
   */
  drop(ctx: GameContext, id: PeerId, position: THREE.Vector3, yaw: number, kind: 0 | 1): void {
    let e = this.byPeer.get(id);
    if (!e) {
      e = this.freeSlot();
      if (!e) return;
      if (e.owner !== null) this.byPeer.delete(e.owner);
      e.owner = id;
      this.byPeer.set(id, e);
    }
    const landing = position.clone();
    if (ctx.world?.ready) landing.y = ctx.world.getHeightAt(landing.x, landing.z);
    e.pod.start(landing, yaw);
    ctx.bus.emit('net:remotePodDrop', { id, position: landing.clone(), yaw, kind });
    ctx.bus.emit('audio:play', { id: 'hellpod_fall', position: landing, volume: 0.7 });
  }

  update(dt: number, ctx: GameContext): void {
    for (let i = 0; i < this.slots.length; i++) {
      const e = this.slots[i];
      if (!e.pod.isActive) continue;
      e.pod.update(dt, e.ev);
      if (e.ev.impact) ctx.bus.emit('audio:play', { id: 'hellpod_impact', position: e.pod.position, volume: 0.8 });
      if (e.ev.opened) ctx.bus.emit('audio:play', { id: 'hellpod_open', position: e.pod.position, volume: 0.6 });
    }
  }

  /**
   * Mission reset · entering a ship: **hides** every pod and forgets the assignments only. Nothing is disposed —
   * taking a pod out of the scene changes the light count (file header).
   */
  clear(): void {
    for (const e of this.slots) {
      e.pod.hide();
      e.owner = null;
      e.ev.impact = false; e.ev.opened = false; e.ev.finished = false;
    }
    this.byPeer.clear();
  }

  /** System teardown only: disposes geometries · materials and removes them from the scene. */
  dispose(): void {
    for (const e of this.slots) e.pod.dispose();
    this.slots.length = 0;
    this.byPeer.clear();
  }

  /** A pod assigned to nobody, else one that has already finished landing. Neither → undefined. */
  private freeSlot(): Entry | undefined {
    for (const e of this.slots) if (e.owner === null) return e;
    for (const e of this.slots) if (!e.pod.isActive) return e;
    return undefined;
  }
}
