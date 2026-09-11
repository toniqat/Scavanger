/**
 * 2026-09-11 (B-3 · B-5) — two small pieces of social state the relay keeps **in memory only** (a restart has no lobbies
 * either, so there is nothing to persist):
 *
 *  - `InviteTable` — the squad invites that are still open. Pure bookkeeping + one TTL timer per invite; it never
 *    sends anything. The relay closes every invite through its own `closeInvite`, which tells both sides.
 *  - `PushCoalescer` — viewers whose `social:state` is stale. A presence change marks everyone it concerns; one timer
 *    (`SOCIAL_PUSH_COALESCE_MS`) then sends each marked viewer **one** snapshot, however many times it was marked.
 *
 * Erasable-TypeScript only (Node native type stripping): no enums, namespaces or parameter properties.
 */
import { randomBytes } from 'node:crypto';
import type { PeerId } from '../src/shared/net.ts';
import { SOCIAL_PUSH_COALESCE_MS, SQUAD_INVITE_TTL_S } from '../src/shared/social.ts';

/** One open squad invite. `from` / `to` are PeerIds — the wire only ever carries 아이디 and the invite `id`. */
export interface OpenInvite {
  readonly id: string;
  readonly from: PeerId;
  readonly to: PeerId;
  /** Lobby code the invitee is moved into on accept (the inviter's ship when the invite was sent). */
  readonly lobby: string;
  /** Server epoch ms it was sent (`social:invited.invite.at`, `SocialPlayer.inviteAt`). */
  readonly at: number;
  /**
   * B-4: the invitee has blocked the inviter. The invitee never sees it (no `social:invited`, no `inviteClosed`, not
   * counted against `SQUAD_INVITE_MAX`); for the inviter it looks like an ordinary unanswered invite and ends as
   * `expired` — or on the inviter's own side (superseded, the lobby failing).
   */
  hidden: boolean;
}

export interface InviteTableOptions {
  /** Invite lifetime (default `SQUAD_INVITE_TTL_S`). The selftest shortens it. */
  ttlMs?: number;
  /** Called once when an invite's TTL runs out while it is still open (the table has not removed it yet). */
  onExpire: (inv: OpenInvite) => void;
}

export class InviteTable {
  /** Insertion order == age: every list below comes out oldest first. */
  private readonly open = new Map<string, OpenInvite>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly onExpire: (inv: OpenInvite) => void;

  constructor(opts: InviteTableOptions) {
    this.ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : SQUAD_INVITE_TTL_S * 1000;
    this.onExpire = opts.onExpire;
  }

  get size(): number { return this.open.size; }
  get(id: string): OpenInvite | undefined { return this.open.get(id); }
  /** Every open invite, oldest first (a copy — safe to close while iterating). */
  all(): OpenInvite[] { return [...this.open.values()]; }
  /** Open invites addressed to `to`, oldest first. Hidden ones only with `includeHidden`. */
  toPeer(to: PeerId, includeHidden = false): OpenInvite[] {
    return this.all().filter((i) => i.to === to && (includeHidden || !i.hidden));
  }
  /** Open invites sent by `from`, oldest first. */
  fromPeer(from: PeerId): OpenInvite[] { return this.all().filter((i) => i.from === from); }
  /** The open invite `from` → `to`, if any (a pair holds at most one). */
  pair(from: PeerId, to: PeerId): OpenInvite | undefined {
    for (const i of this.open.values()) if (i.from === from && i.to === to) return i;
    return undefined;
  }
  /** Open invites between two players, either direction. */
  between(a: PeerId, b: PeerId): OpenInvite[] {
    return this.all().filter((i) => (i.from === a && i.to === b) || (i.from === b && i.to === a));
  }

  /**
   * Record a new invite and arm its TTL. The caller has already closed the pair's previous invite (`superseded`) and
   * made room under the invitee's cap — this only stores.
   */
  add(from: PeerId, to: PeerId, lobby: string, at: number, hidden: boolean): OpenInvite {
    let id = randomBytes(6).toString('base64url');
    while (this.open.has(id)) id = randomBytes(6).toString('base64url');
    const inv: OpenInvite = { id, from, to, lobby, at, hidden };
    this.open.set(id, inv);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (this.open.get(id) === inv) this.onExpire(inv);
    }, this.ttlMs);
    timer.unref();
    this.timers.set(id, timer);
    return inv;
  }

  /** Take `inv` out of the table. false when it was already closed (every close path checks this — closes happen once). */
  remove(inv: OpenInvite): boolean {
    if (this.open.get(inv.id) !== inv) return false;
    this.open.delete(inv.id);
    const t = this.timers.get(inv.id);
    if (t !== undefined) { clearTimeout(t); this.timers.delete(inv.id); }
    return true;
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.open.clear();
  }
}

export interface PushCoalescerOptions {
  /** Sends one viewer its snapshot now (the relay's `social:state` builder). */
  send: (id: PeerId) => void;
  /** Window (default `SOCIAL_PUSH_COALESCE_MS`). */
  windowMs?: number;
}

/**
 * B-5: `mark` a viewer as stale; the first mark into an empty set arms one timer, and when it fires every marked
 * viewer gets exactly one snapshot. `now` is for a direct answer to the viewer's own request (`social:request` ·
 * `respond` · `remove` · `block` · `get` · `me`): it sends at once and takes the viewer out of the set, so the button
 * reacts immediately and no duplicate follows 250 ms later.
 */
export class PushCoalescer {
  private readonly dirty = new Set<PeerId>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly send: (id: PeerId) => void;
  private readonly windowMs: number;
  /** Snapshots sent by `flush` / `now` (diagnostics). */
  sent = 0;

  constructor(opts: PushCoalescerOptions) {
    this.send = opts.send;
    this.windowMs = typeof opts.windowMs === 'number' && opts.windowMs >= 0 ? opts.windowMs : SOCIAL_PUSH_COALESCE_MS;
  }

  get pending(): number { return this.dirty.size; }

  mark(id: PeerId): void {
    this.dirty.add(id);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.windowMs);
    this.timer.unref();
  }

  now(id: PeerId): void {
    this.dirty.delete(id);
    this.sent++;
    this.send(id);
  }

  /** Send every marked viewer one snapshot. A send that marks again (it should not) lands in the next window. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) { this.sent++; this.send(id); }
  }

  close(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.dirty.clear();
  }
}
