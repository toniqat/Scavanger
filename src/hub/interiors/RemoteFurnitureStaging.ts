import type { FurniturePoseKind, PeerId, RemotePlayerRef } from '@/shared';
import type { FurnitureRig } from './FurnitureLeisure';
import { RUN_STRIDE_LENGTH, UNRACK_S, poseBelt, poseBenchBar, poseCrank, poseRock, restRig, type StagedPiece } from './GymStaging';

/* ────────────────────────────────────────────────────────────────────────────
 * Remote furniture staging (2026-09-12, character buffs · furniture pose sync).
 *
 * When a squadmate takes a furniture pose, net interpolates the snapshot `fp` · `fu` into `RemotePlayerRef.furniturePose`. Here,
 * while that person is on the **same ship** (`hubSite`) and `furnitureUid` points at a piece of the ship drawn right now, the
 * piece's moving parts run off their interpolated cumulative phase — the **same functions** as the local `GymStaging`
 * (`poseBenchBar` · `poseBelt` · `poseCrank` · `poseRock`), so a visitor's barbell height · belt · crank match the owner's.
 *
 *   bench / smith  plates shown · bar from the rack → the press path (over `UNRACK_S`) · phase 0 … 1 used as it comes
 *   run            belt = the **difference** in cumulative strides × `RUN_STRIDE_LENGTH` (going backwards, or over
 *                  `RUN_PHASE_JUMP` in one frame, moves no belt that frame — a restarted pose resets the phase to 0, and the belt must not wind back)
 *   cycle          crank · pedals · flywheel = the cumulative revolutions (absolute, so a rewind only teleports — it never spins empty)
 *   sit            the rocking chair rocks (the phase is always 0 — the rock is driven by time)
 *   cook           (2026-09-13) nothing to drive — the cook bench model carries `cook`, not `rig`, and which tool is out (the
 *                  step game) is not on the wire. The `rig` check below makes no entry and passes silently (player's `RemoteAvatar` draws the body's knife work).
 *                  `drive()` still names the kind, and its `default` branch is an exhaustive `never` check: give a cook bench a `rig` one day and
 *                  the silence is a decision taken here, not an entry that is created and then never driven.
 *
 * When the pose ends (the ref's `furniturePose` null · gone from the list · disconnected · stale · another ship) the piece goes
 * back to rest (`restRig` — plates hidden · bar on the rack · chair stopped). A piece **the local staging drives** (`GymStaging.uid` ·
 * a rocking chair being sat in) is never touched. The piece is re-found by uid every frame — a room rebuild swaps the rig (like `GymStaging.find`).
 *
 * Hot path: no per-frame allocation — the entry array is walked by index, removal is a swap-remove, and a finished entry returns to `spare` for reuse.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A run phase that moved more than this (in strides) in one frame is read as a jump, not a step — it moves no belt. */
const RUN_PHASE_JUMP = 1.5;

interface Entry {
  peer: PeerId;
  uid: string;
  kind: FurniturePoseKind;
  /** Bench: progress along the rack → press path (0 … 1). */
  unrack: number;
  /** Last frame's cumulative phase (the run difference is taken from it). */
  phase: number;
  /** Treadmill belt offset (m, wrapped). */
  belt: number;
  /** The frame number this entry was last driven on. */
  seen: number;
}

export interface RemoteStagingHost {
  /** The piece for this uid right now (it changes when the room is rebuilt). */
  find(uid: string): StagedPiece | null;
  /** The local player is using this piece (a gym session · a rocking chair being sat in) — remote staging leaves it alone. */
  isLocal(uid: string): boolean;
}

export class RemoteFurnitureStaging {
  private readonly entries: Entry[] = [];
  private readonly spare: Entry[] = [];
  private frame = 0;

  constructor(private readonly host: RemoteStagingHost) {}

  /** A remote squadmate is using this piece (a room rebuild uses it to build the piece with its plates on). */
  drives(uid: string): boolean {
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i].uid === uid) return true;
    return false;
  }

  /** Debug · smoke: the remote poses being staged right now. */
  get staged(): Array<{ peer: PeerId; uid: string; kind: FurniturePoseKind; phase: number }> {
    return this.entries.map((e) => ({ peer: e.peer, uid: e.uid, kind: e.kind, phase: e.phase }));
  }

  /**
   * Every frame (`FurnitureLayer.update`, after the local `GymStaging`). `refs` = the remote squadmates, `site` = the ship the
   * local player stands in (`HubRef.hubSite` — may be null in the shared ship / the own ship, and a ref counts **only when** its `hubSite` matches).
   */
  update(dt: number, time: number, refs: readonly RemotePlayerRef[], site: PeerId | null): void {
    const f = ++this.frame;
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const pose = ref.furniturePose;
      if (!pose || !pose.furnitureUid) continue;
      if (ref.connected === false || ref.stale === true || ref.suspended === true) continue;
      if ((ref.hubSite ?? null) !== site) continue;
      const uid = pose.furnitureUid;
      if (this.host.isLocal(uid) || this.heldByOther(uid, ref.id, f)) continue;
      const rig = this.host.find(uid)?.model.rig;
      if (!rig || rig.pose !== pose.kind) continue;
      const phase = Number.isFinite(pose.phase) ? pose.phase : 0;
      let e = this.entryOf(ref.id);
      if (e && (e.uid !== uid || e.kind !== pose.kind)) {
        // the same person moved to another machine — the old piece is put to rest first
        this.release(e, f);
        reset(e, ref.id, uid, pose.kind, phase);
      }
      if (!e) {
        e = this.spare.pop() ?? { peer: ref.id, uid, kind: pose.kind, unrack: 0, phase, belt: 0, seen: f };
        reset(e, ref.id, uid, pose.kind, phase);
        this.entries.push(e);
      }
      e.seen = f;
      drive(rig, e, phase, dt, time);
    }
    // an entry nobody pointed at this frame = the pose ended (swap-remove from the back — the tail holds entries already seen)
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.seen === f) continue;
      this.release(e, f);
      const last = this.entries.length - 1;
      this.entries[i] = this.entries[last];
      this.entries.length = last;
      this.spare.push(e);
    }
  }

  /** Put every piece back to rest and empty the list (layer dispose). */
  dispose(): void {
    const f = ++this.frame;
    for (let i = 0; i < this.entries.length; i++) this.release(this.entries[i], f);
    this.entries.length = 0;
    this.spare.length = 0;
  }

  private entryOf(peer: PeerId): Entry | null {
    for (let i = 0; i < this.entries.length; i++) if (this.entries[i].peer === peer) return this.entries[i];
    return null;
  }

  /**
   * Another squadmate already holds this piece (since last frame) — whoever took it first wins. Two bodies can never be on one
   * piece, but this keeps the staging from flickering between them for the one moment two out-of-step snapshots name the same uid.
   */
  private heldByOther(uid: string, peer: PeerId, f: number): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.uid === uid && e.peer !== peer && e.seen >= f - 1) return true;
    }
    return false;
  }

  /** Put the entry's piece to rest — left alone when the local player holds it or another entry drove it this frame. */
  private release(e: Entry, f: number): void {
    if (this.host.isLocal(e.uid)) return;
    for (let i = 0; i < this.entries.length; i++) {
      const o = this.entries[i];
      if (o !== e && o.uid === e.uid && o.seen === f) return;
    }
    const rig = this.host.find(e.uid)?.model.rig;
    if (rig) restRig(rig);
  }
}

function reset(e: Entry, peer: PeerId, uid: string, kind: FurniturePoseKind, phase: number): void {
  e.peer = peer; e.uid = uid; e.kind = kind; e.unrack = 0; e.phase = phase; e.belt = 0;
}

function drive(rig: FurnitureRig, e: Entry, phase: number, dt: number, time: number): void {
  switch (e.kind) {
    case 'bench':
      if (rig.plates) rig.plates.visible = true;
      e.unrack = Math.min(1, e.unrack + dt / UNRACK_S);
      poseBenchBar(rig, e.unrack, Math.min(1, Math.max(0, phase)));
      break;
    case 'run': {
      const d = phase - e.phase;
      // a freshly built belt (a room rebuild) lands on the same offset — the position is re-applied even on a frame with no movement
      e.belt = poseBelt(rig, e.belt + (d > 0 && d <= RUN_PHASE_JUMP ? d * RUN_STRIDE_LENGTH : 0));
      break;
    }
    case 'cycle':
      poseCrank(rig, phase);
      break;
    case 'sit':
      poseRock(rig, time);
      break;
    case 'cook':
      // (2026-09-13) nothing to drive: the cook bench carries `model.cook`, not `model.rig`, so `update`'s `rig` lookup
      // never reaches here. The branch exists so the `never` below stays reachable-free.
      break;
    default: {
      // Exhaustive over `FurniturePoseKind`: a new pose kind must decide here what a remote body does to the piece.
      // Without this a new kind silently got an entry that was never driven and never put to rest.
      const unhandled: never = e.kind;
      void unhandled;
      break;
    }
  }
  e.phase = phase;
}
