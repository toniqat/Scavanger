/**
 * src/player/SoldierPool.ts — **the remote avatar body pool** (2026-09-10).
 *
 * The question this file answers: *must a soldier model be built again every time a squadmate moves ship ↔ planet.*
 *
 * `RemotePlayerSystem` drops every avatar on `hub:entered` · `game:newMission` · `game:abort` and makes them again
 * from the next snapshot (that is the rule that keeps stale positions out, so it is left alone). It used to rebuild
 * `SoldierModel`'s meshes · materials whole every time — 86 meshes per person (43 body + 43 silhouette) and 6
 * materials. Now a disappearing avatar's body is **parked** here (`release` → `SoldierModel.resetForReuse`), and
 * when an avatar of the same accent appears again that body is taken back out.
 *
 * The key is the **accent colour** alone — it is the only value the constructor bakes in (`NET_SLOT_COLORS[slot]`).
 * At most `NET_MAX_PLAYERS − 1` bodies are held per accent; anything over that is `dispose`d on the spot.
 */
import { NET_MAX_PLAYERS } from '@/shared';
import { SoldierModel } from './SoldierModel';

export class SoldierPool {
  private readonly parked = new Map<number, SoldierModel[]>();

  constructor(private readonly capPerAccent = NET_MAX_PLAYERS - 1) {}

  /** Total number of parked bodies (smoke tests · debug). */
  get size(): number {
    let n = 0;
    for (const list of this.parked.values()) n += list.length;
    return n;
  }

  /** One body baked with `accent` — a parked one if there is one, else newly built. Not added to the scene. */
  acquire(accent: number): SoldierModel {
    return this.parked.get(accent)?.pop() ?? new SoldierModel(accent);
  }

  /**
   * Hands a body back: the instance state returns to just after construction (and it is detached from the scene),
   * then it is parked if there is room and disposed if there is not.
   */
  release(model: SoldierModel): void {
    let list = this.parked.get(model.accentColor);
    if (!list) { list = []; this.parked.set(model.accentColor, list); }
    if (list.includes(model)) return;   // already parked (a double release must never hand one body to two avatars)
    model.resetForReuse();
    if (list.length >= this.capPerAccent) { model.dispose(); return; }
    list.push(model);
  }

  /** System shutdown: disposes every parked body. */
  dispose(): void {
    for (const list of this.parked.values()) for (const m of list) m.dispose();
    this.parked.clear();
  }
}
