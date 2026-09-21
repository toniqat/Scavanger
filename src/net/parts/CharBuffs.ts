/**
 * src/net/parts/CharBuffs.ts — **how a squadmate's buff list travels** (character buffs, 2026-09-12).
 *
 *   my list changed ── `player:buffsChanged` ──▶ dirty ──(NetSystem.update, **before** the snapshot)──▶
 *                      `cbuf state {rev, buffs}` → others
 *                      (several changes in one frame collapse into one — at most one send per update)
 *   the 20 Hz snapshot's `bfr` ── the receiver's `onSnapshot(ref)`: `bfr ≠ ref.buffsRevision` (or the stream
 *                      restarted) → `cbufq sync` to that member (once per `CHAR_BUFF_SYNC_COOLDOWN_S`)
 *   `cbufq sync` ── my `cbuf state` to the requester alone (the same cooldown, per requester)
 *   `cbuf state` ── lobby members only · `sanitizeCharBuffs` · a lower rev is dropped (unless it equals that member's
 *                   newest snapshot `bfr` — a reload restarted the revision counter at 1) → `entries` + the ref
 *                   mirror → `net:remoteBuffsChanged` only when the list really changed
 *
 * Buffs have no gameplay effect (the user's decision), so there is no authority check — only lobby membership and the
 * shape are tested. Not one line of the server changes: the relay passes the `relay` envelope's `d` through after
 * checking only that `t` is a string (`server/RelayServer.ts`'s `relay` validation).
 *
 * `entries` lives apart from the ref: every ship ↔ raid transition clears and rebuilds the refs (`clearRemotes`)
 * while the lists did not change in between, so a new ref inherits them at once (`mirror`) — the squad list's
 * thumbnails never blink and no request goes out.
 */
import type { CharBuffMessage, CharBuffRequest, PeerId, RelayTarget } from '@/shared';
import type { CharBuff } from '@/shared';
import { CHAR_BUFF_SYNC_COOLDOWN_S, CHAR_BUFF_WIRE_MAX, sameCharBuffs, sanitizeCharBuffs } from '@/shared';
import type { NetSystem } from '../NetSystem';
import type { RemotePlayer } from '../RemotePlayer';
import { EMPTY_CHAR_BUFFS } from '../RemotePlayer';

interface Entry { rev: number; buffs: readonly CharBuff[] }

const nowS = (): number => performance.now() / 1000;

export class CharBuffRelay {
  private sys: NetSystem | null = null;
  private offs: Array<() => void> = [];
  /** My own list changed since the last `flush` (set by `player:buffsChanged`). */
  private dirty = false;
  /** Last accepted list + revision per lobby member (outlives the ref — see the file header). */
  readonly entries = new Map<PeerId, Entry>();
  /** `performance.now()` seconds of our last `cbufq sync` to each peer. */
  private readonly askedAt = new Map<PeerId, number>();
  /** `performance.now()` seconds of our last answer to each requester. */
  private readonly answeredAt = new Map<PeerId, number>();

  init(sys: NetSystem): void {
    this.sys = sys;
    this.offs.push(
      sys.ctx.bus.on('player:buffsChanged', () => { this.dirty = true; }),
      sys.onMessage('cbuf', (m, from) => this.onState(m, from)),
      sys.onMessage('cbufq', (m, from) => this.onRequest(m, from)),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.clear();
    this.dirty = false;
    this.sys = null;
  }

  /* ── the sending side ──────────────────────────────────────────────── */
  /**
   * `NetSystem.update`, **before** the snapshot: at most one `cbuf state` per frame however many `player:buffsChanged`
   * fired since. A change while offline / lobbyless is simply dropped — the next snapshot's `bfr` makes every receiver ask.
   */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.sendState('others');
  }

  private sendState(to: RelayTarget): void {
    const sys = this.sys;
    if (!sys || !sys.client.connected || !sys.lobby) return;   // `send()` would drop it too — skip the copy
    const p = sys.ctx.player;
    const list = p?.buffs ?? EMPTY_CHAR_BUFFS;
    const r = p?.buffsRevision;
    const rev = typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.floor(r) : 0;
    const msg: CharBuffMessage = { t: 'cbuf', ev: 'state', rev, buffs: list.slice(0, Math.max(0, Math.floor(CHAR_BUFF_WIRE_MAX))) };
    sys.send(msg, to);
  }

  /* ── the receiving side ─────────────────────────────────────────────── */
  private isMember(from: PeerId): boolean {
    const sys = this.sys;
    return !!sys && from !== sys.localId && !!sys.getLobbyPlayer(from);
  }

  private onState(m: CharBuffMessage, from: PeerId): void {
    const sys = this.sys;
    if (!sys || !m || typeof m !== 'object' || m.ev !== 'state' || !this.isMember(from)) return;
    if (typeof m.rev !== 'number' || !Number.isFinite(m.rev) || m.rev < 0) return;
    const rev = Math.floor(m.rev);
    const ref = sys.remotes.get(from);
    const prev = this.entries.get(from);
    // An older revision than ours is a late / stale copy — unless the sender's live snapshot says it IS at that revision
    // (a reload restarted its counter from 1).
    if (prev && rev < prev.rev && !(ref && ref.snapshotBuffsRev === rev)) return;
    const clean = sanitizeCharBuffs(m.buffs);
    const before = prev?.buffs ?? EMPTY_CHAR_BUFFS;
    const next = sameCharBuffs(before, clean) ? before : (clean.length === 0 ? EMPTY_CHAR_BUFFS : clean);
    this.entries.set(from, { rev, buffs: next });
    if (ref) { this.mirror(ref); ref.buffsResync = false; }   // an accepted list is the sender's current one
    if (next !== before) sys.ctx.bus.emit('net:remoteBuffsChanged', { id: from, buffs: next });
  }

  /** `cbufq sync`: answer the requester alone, at most once per `CHAR_BUFF_SYNC_COOLDOWN_S` per requester. */
  private onRequest(m: CharBuffRequest, from: PeerId): void {
    if (!this.sys || !m || typeof m !== 'object' || m.ev !== 'sync' || !this.isMember(from)) return;
    const now = nowS();
    const last = this.answeredAt.get(from);
    if (last !== undefined && now - last < CHAR_BUFF_SYNC_COOLDOWN_S) return;
    this.answeredAt.set(from, now);
    this.sendState(from);
  }

  /**
   * Every accepted `ps` (`parts/Messages`): the snapshot's `bfr` differs from the list we hold — or the stream restarted,
   * which makes an equal number meaningless — so ask that member for its list, once per `CHAR_BUFF_SYNC_COOLDOWN_S`.
   */
  onSnapshot(r: RemotePlayer): void {
    const sys = this.sys;
    if (!sys) return;
    if (r.snapshotBuffsRev === r.buffsRevision && !r.buffsResync) return;
    if (r.buffsResync && r.snapshotBuffsRev === 0 && r.buffsRevision === 0 && r.buffs.length === 0) { r.buffsResync = false; return; }
    const now = nowS();
    const last = this.askedAt.get(r.id);
    if (last !== undefined && now - last < CHAR_BUFF_SYNC_COOLDOWN_S) return;
    this.askedAt.set(r.id, now);
    const req: CharBuffRequest = { t: 'cbufq', ev: 'sync' };
    sys.send(req, r.id);
  }

  /** Copy the stored list onto `r` (a new ref after a scene change, or an accepted `cbuf state`). */
  mirror(r: RemotePlayer): void {
    const e = this.entries.get(r.id);
    if (!e) return;
    r.buffs = e.buffs;
    r.buffsRevision = e.rev;
  }

  /** `lobby:state` sweep: forget the members who are gone (same place the crew cards / ship visits are pruned). */
  prune(members: ReadonlySet<PeerId>): void {
    for (const map of [this.entries, this.askedAt, this.answeredAt] as Map<PeerId, unknown>[]) {
      for (const id of Array.from(map.keys())) if (!members.has(id)) map.delete(id);
    }
  }

  /** The lobby is gone. */
  clear(): void {
    this.entries.clear();
    this.askedAt.clear();
    this.answeredAt.clear();
  }
}
