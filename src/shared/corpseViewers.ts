/**
 * src/shared/corpseViewers.ts — **who is looking into this corpse right now** (2026-09-16, user's decision).
 *
 * The rule: an empty corpse (player · android · tutorial · enemy) sinks and disappears **once the looting ended** —
 * after the last viewer closed their window — plus a `CORPSE_EMPTY_REMOVE_DELAY_S` wait. It never goes while anyone
 * (me or a squadmate) keeps a window open. A corpse that stood up empty-handed (nobody ever opened it) counts from
 * the moment it stood, as before.
 *
 * The question this file answers: *how every kind of corpse (game · enemies · world/tutorial) makes the same
 * 「who is viewing」 judgement from one place.*
 *
 * - **Local**: it listens only to inventory's `inventory:opened {containerId}` / `inventory:closed` (it never looks
 *   inside inventory). While the window shows that container = viewing. As a safety net it also reads
 *   `ctx.inventory.isOpen` (so a missed close event never holds one forever).
 * - **Wire** (`cviewq open|close`, sent only by a non-host in a session): the host keeps corpse id → the set of
 *   viewing peers. One person views exactly one corpse at a time (there is one window) — so the table never grows
 *   beyond the squad.
 * - **Host guard** (the same order as `buffRules.createBuffGuard`): `open` = ① shape (an id this tracker owns · a
 *   known corpse) ② sender (a connected, living snapshot) ③ distance (`CORPSE_EMPTY_REQUEST_REACH_M`, horizontal)
 *   ④ rate (a per-sender bucket `CORPSE_EMPTY_REQUEST_RATE_MAX` / `_BURST`). `close` only removes the sender's
 *   **own** entry, so it is checked for shape alone. An id another tracker owns is ignored, not refused.
 * - **Host cleanup**: on leaving (`net:peerLeft`) · dropping (`net:peerSuspended`) · rejoining (`flow rejoined` — a
 *   freshly opened window is closed) · death · a snapshot that disappeared · walking out of range, the host removes
 *   that person's entry itself (`update`). A lost close wire never leaves a corpse standing forever.
 * - **Host transfer**: the new host's table is empty — a client with a window open re-sends `open` on `net:hostChanged`.
 * - The **consumers** of the judgement (remove it or not) are the folders: `game/Corpses` · `enemies/parts/CorpseEmpty` ·
 *   `world/tutorial/parts/Corpses`. The ids they own must not overlap (so one window opening is never sent twice) —
 *   `pcorpse:` / `corpse:<number>` / the tutorial's hand-placed corpse ids.
 */
import type * as THREE from 'three';
import type { GameContext } from './GameContext';
import {
  CORPSE_EMPTY_REQUEST_BURST, CORPSE_EMPTY_REQUEST_RATE_MAX, CORPSE_EMPTY_REQUEST_REACH_M,
} from './constants';
import type { CorpseViewRequest, NetRef, PeerId } from './net';

export interface CorpseViewTrackerOptions {
  /** Is this a container id this tracker owns (it must not overlap another tracker's)? */
  matches(containerId: string): boolean;
  /** Where that corpse stands right now (an unknown corpse = null). Used by the host's distance guard and its out-of-range cleanup. */
  positionOf(containerId: string): THREE.Vector3 | null;
  /** false = local only, no wire (the tutorial's hand-placed corpses). Default true. */
  net?: boolean;
}

interface Bucket { tokens: number; at: number }

export class CorpseViewTracker {
  /** The corpse id my window shows right now (of the ones this tracker owns). */
  private local: string | null = null;
  /** Host: corpse id → the remote peers viewing it. */
  private readonly remote = new Map<string, Set<PeerId>>();
  private readonly buckets = new Map<PeerId, Bucket>();
  private readonly unsubs: Array<() => void> = [];
  private netUnsubs: Array<() => void> = [];
  private hookedNet: NetRef | null = null;
  /** How many `cviewq open` the host refused (smokes · debugging — a refused request does nothing). */
  refused = 0;

  constructor(private readonly ctx: GameContext, private readonly opts: CorpseViewTrackerOptions) {
    const bus = ctx.bus;
    this.unsubs.push(
      bus.on('inventory:opened', ({ containerId }) =>
        this.setLocal(containerId && opts.matches(containerId) ? containerId : null)),
      bus.on('inventory:closed', () => this.setLocal(null)),
      bus.on('game:newMission', () => this.reset()),
      bus.on('game:abort', () => this.reset()),
    );
    if (opts.net !== false) {
      this.unsubs.push(
        bus.on('net:peerLeft', ({ id }) => this.dropPeer(id)),
        bus.on('net:peerSuspended', ({ id, suspended }) => { if (suspended) this.dropPeer(id); }),
        bus.on('net:hostChanged', ({ isLocalHost }) => {
          this.remote.clear();
          this.buckets.clear();
          // the new host does not know who is viewing — whoever has a window open tells it again
          if (!isLocalHost && this.local && this.sends()) this.ctx.net!.send({ t: 'cviewq', ev: 'open', id: this.local }, 'host');
        }),
      );
      this.hookNet();
    }
  }

  /** Is my window showing `id` right now? */
  isLocalViewing(id: string): boolean {
    return this.local === id && !!this.ctx.inventory?.isOpen;
  }

  /** The corpse id my window shows (of the ones this tracker owns), or null. For comparing without building a string every frame. */
  get localViewing(): string | null {
    return this.local !== null && this.ctx.inventory?.isOpen ? this.local : null;
  }

  /**
   * Is anyone viewing `id`? The host and single-player know about everyone. A non-host in a session knows only its own
   * window — that is enough there, because the moment of removal is decided by the host's broadcast.
   */
  isViewed(id: string): boolean {
    if (this.isLocalViewing(id)) return true;
    if (!this.hosting()) return false;
    const set = this.remote.get(id);
    return !!set && set.size > 0;
  }

  /** Host: how many remote peers are viewing `id` (smokes · debugging). */
  remoteViewers(id: string): number { return this.remote.get(id)?.size ?? 0; }

  /** Every frame (from the consumer's `update`): hooks a `ctx.net` that appeared late and, on the host, removes the entries of people who left or walked away. */
  update(): void {
    if (this.opts.net === false) return;
    this.hookNet();
    if (this.remote.size === 0) return;
    if (!this.hosting()) { this.remote.clear(); return; }
    const net = this.ctx.net!;
    const reach2 = CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M;
    for (const [id, set] of this.remote) {
      const at = this.opts.positionOf(id);
      for (const peer of set) {
        const ref = net.getRemotePlayer(peer);
        const gone = !at || !ref || ref.connected === false || ref.isDead
          || (ref.position.x - at.x) ** 2 + (ref.position.z - at.z) ** 2 > reach2;
        if (gone) set.delete(peer);
      }
      if (set.size === 0) this.remote.delete(id);
    }
  }

  /** Mission reset: empties the table (no wire is sent). */
  reset(): void {
    this.local = null;
    this.remote.clear();
    this.buckets.clear();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    for (const u of this.netUnsubs) u();
    this.netUnsubs = [];
    this.hookedNet = null;
    this.reset();
  }

  /* ── Internals ─────────────────────────────────────────────────────────────────────────────────────── */

  private hosting(): boolean {
    return this.opts.net !== false && this.ctx.isMultiplayer && !!this.ctx.net?.isHost;
  }

  /** Only a non-host in a session tells the host. */
  private sends(): boolean {
    return this.opts.net !== false && this.ctx.isMultiplayer && !!this.ctx.net && !this.ctx.net.isHost;
  }

  private setLocal(id: string | null): void {
    if (id === this.local) return;
    const net = this.sends() ? this.ctx.net! : null;
    if (this.local !== null && net) net.send({ t: 'cviewq', ev: 'close', id: this.local }, 'host');
    this.local = id;
    if (id !== null && net) net.send({ t: 'cviewq', ev: 'open', id }, 'host');
  }

  private hookNet(): void {
    const net = this.ctx.net;
    if (!net || net === this.hookedNet || typeof net.onMessage !== 'function') return;
    for (const u of this.netUnsubs) u();
    this.hookedNet = net;
    this.netUnsubs = [
      net.onMessage('cviewq', (msg, from) => this.onRequest(msg, from)),
      net.onMessage('flow', (msg, from) => { if (msg.ev === 'rejoined') this.dropPeer(from); }),
    ];
  }

  private dropPeer(peer: PeerId): void {
    this.dropViews(peer);
    this.buckets.delete(peer);
  }

  private onRequest(msg: CorpseViewRequest, from: PeerId): void {
    if (!this.hosting()) return;
    // ① shape
    if (!msg || (msg.ev !== 'open' && msg.ev !== 'close') || typeof msg.id !== 'string' || typeof from !== 'string') {
      this.refused++;
      return;
    }
    if (!this.opts.matches(msg.id)) return;   // another corpse kind's tracker owns it
    if (msg.ev === 'close') {
      const set = this.remote.get(msg.id);
      if (set?.delete(from) && set.size === 0) this.remote.delete(msg.id);
      return;
    }
    const at = this.opts.positionOf(msg.id);
    if (!at) { this.refused++; return; }
    // ② sender
    const ref = this.ctx.net!.getRemotePlayer(from);
    if (!ref || ref.connected === false || ref.isDead) { this.refused++; return; }
    // ③ distance (horizontal)
    const dx = ref.position.x - at.x, dz = ref.position.z - at.z;
    if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) { this.refused++; return; }
    // ④ rate
    if (!this.spend(from)) { this.refused++; return; }
    // there is one window — any other corpse that person was viewing is closed
    this.dropViews(from);
    let set = this.remote.get(msg.id);
    if (!set) { set = new Set(); this.remote.set(msg.id, set); }
    set.add(from);
  }

  private dropViews(peer: PeerId): void {
    for (const [id, set] of this.remote) {
      if (set.delete(peer) && set.size === 0) this.remote.delete(id);
    }
  }

  private spend(from: PeerId): boolean {
    const now = this.ctx.time;
    let b = this.buckets.get(from);
    if (!b) { b = { tokens: CORPSE_EMPTY_REQUEST_BURST, at: now }; this.buckets.set(from, b); }
    b.tokens = Math.min(CORPSE_EMPTY_REQUEST_BURST, b.tokens + Math.max(0, now - b.at) * CORPSE_EMPTY_REQUEST_RATE_MAX);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
