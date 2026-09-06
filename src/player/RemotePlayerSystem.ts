import * as THREE from 'three';
import {
  GHOST_BLEED_PER_SEC, NET_GHOST_PARK_S, NET_GHOST_STATE_HZ, PLAYER_DOWN_HP, PLAYER_MAX_HP, PLAYER_REVIVE_HOLD, PLAYER_REVIVE_HP,
  PLAYER_REVIVE_RANGE, PlayerFlags,
  type GameContext, type GameSystem, type GhostState, type GhostWire, type ImplantId, type Interactable, type PeerId,
  type RemotePlayerRef, type Stance,
} from '@/shared';
import { RemoteAvatar } from './RemoteAvatar';

const EMPTY: readonly RemotePlayerRef[] = [];
/** Max rate of `revive progress` relay messages while holding E on a downed teammate. */
const REVIVE_PROGRESS_INTERVAL = 0.25;
/** After a completed revive the interactable stays away this long (until the peer's DOWNED flag clears). */
const REVIVE_DONE_SUPPRESS = 1.5;
/** Horizontal metres a ghost is shoved per unit of knockback speed (no physics for a ghost; capped). */
const GHOST_KB_SCALE = 0.12;
const GHOST_KB_MAX = 2.0;

/**
 * Fully writable RemotePlayerRef for console smoke tests (`debugSpawn`). `isCloaked` / `isDowned` are getters
 * derived from `flags` exactly like NetSystem's real refs, so flipping `flags` alone drives the avatar.
 */
export interface DebugRemoteRef {
  id: PeerId; name: string; slot: number;
  position: THREE.Vector3; velocity: THREE.Vector3;
  yaw: number; pitch: number; stance: Stance; flags: number;
  hp: number; maxHp: number; isDead: boolean; weaponId: string | null;
  stridePhase: number; moveBlend: number; lastUpdate: number;
  connected: boolean; stale: boolean; avatar: RemoteAvatar | null;
  isDowned: boolean;
  /* appended: tactical kit */
  implantId: ImplantId | null;
  armorId: string | null;
  readonly isCloaked: boolean;
  /* Phase 7 */
  suspended: boolean;
  inMission: boolean;
  /** Held consumable def id (`PlayerSnapshot.h` mirror; the real refs expose the same field name). */
  heldItemId: string | null;
  /* Phase 9: ghost view on the ref (written by `applyToRef` while a ghost exists, cleared when it is dropped) */
  ghostState?: GhostState;
  ghostDownHp?: number;
  /** The member's own down pool (`PlayerSnapshot.dhp` mirror) — a ghost created from a downed ref inherits it. */
  downHp?: number;
}

interface ReviveEntry { interactable: Interactable; lastSent: number }

/**
 * Phase 9: a ghost whose member left the mission without rejoining (page reload → `inMission` false, or a socket that
 * came back without `flow rejoined`). Not simulated, not targetable, not counted; `flow rejoined` inside
 * `NET_GHOST_PARK_S` restores the body from `wire`.
 */
export interface ParkedGhost { wire: GhostWire; until: number; debug: boolean }

/**
 * Host-simulated body of a suspended member (Phase 7). Lives only on the authority; everyone else sees it through
 * `ghost state` (net writes the values onto the member's `RemotePlayerRef`).
 */
export interface Ghost {
  readonly id: PeerId;
  readonly position: THREE.Vector3;
  yaw: number;
  hp: number;
  downHp: number;
  state: GhostState;
  /** ctx.time of the last `ghost state` broadcast. */
  lastSent: number;
  /** Fractional bleed accumulator (whole points are broadcast). */
  bleedAcc: number;
  /** Debug-spawned (no session needed). */
  debug: boolean;
}

/** Optional hooks net/ may expose on its refs so the host's own view of a suspended peer follows its ghost. */
interface GhostApplicable { applyGhost?(g: GhostWire): void; clearGhost?(): void }

const _kb = new THREE.Vector3();

/**
 * Renders every peer in `ctx.net.getRemotePlayers()` as a `RemoteAvatar`. Avatars are created on demand
 * (first frame a ref is seen, or on `net:remotePlayerAdded`), driven every frame from the interpolated ref,
 * and disposed on `net:remotePlayerRemoved`, when `!ref.connected` (unless `suspended`), when the ref disappears
 * from the list, and wholesale on `game:abort` / `game:newMission` / `hub:entered` (refs that survive are
 * re-avatared next frame). Runs in every phase — hub avatars render whenever `ctx.net` still lists remote refs.
 *
 * Phase 2: every downed, alive, connected, non-stale ref gets a `revive:<peerId>` `Interactable` (hold E
 * PLAYER_REVIVE_HOLD within PLAYER_REVIVE_RANGE) that relays `revive progress/cancel/done` to that peer;
 * the peer's NetSystem calls `ctx.player.revive()` on `done`.
 *
 * Phase 7 — **ghosts** (host only): when a member's socket drops mid-mission (`net:peerSuspended`) the host keeps
 * simulating its body here: `ghost:damage` from enemies → hp / downed (`downHp`) / bleed (`GHOST_BLEED_PER_SEC`) /
 * dead, broadcast as `ghost state` on change + at `NET_GHOST_STATE_HZ`; `ghostq sync` / `flow rejoined` → `ghost sync`;
 * `ghostq revive` (a squadmate finished the revive hold on the suspended body) → hp `PLAYER_REVIVE_HP`; the returning
 * member's `flow rejoined` gets a `ghost restore` (→ `PlayerRef.restoreState`) and the ghost is dropped (`ghost gone`).
 * A new host rebuilds the ghosts from the last `ghost state` it saw (`net:hostChanged {isLocalHost:true}`); a demoted
 * host drops them. The revive interactable on a suspended peer sends `ghostq revive` to the host instead of `revive done`.
 *
 * Runs right after PlayerSystem (see main.ts); NetSystem has already smoothed the refs this frame.
 */
export class RemotePlayerSystem implements GameSystem {
  readonly name = 'remotePlayers';

  private ctx!: GameContext;
  private readonly avatars = new Map<PeerId, RemoteAvatar>();
  private readonly revives = new Map<PeerId, ReviveEntry>();
  /** peer id → ctx.time until which no revive interactable is re-registered (just completed one). */
  private readonly reviveSuppress = new Map<PeerId, number>();
  /** Console-injected fake peers (see `debugSpawn`). */
  private readonly debugRefs: DebugRemoteRef[] = [];
  private frame = 0;
  /* ── Phase 7 ghosts ── */
  private readonly ghosts = new Map<PeerId, Ghost>();
  /** Last `ghost state` / `sync` wire seen for each id (every client keeps it so a promoted host can rebuild). */
  private readonly lastGhost = new Map<PeerId, GhostWire>();
  /** Phase 9: ghosts of members that left the mission without rejoining, kept for `NET_GHOST_PARK_S` (host only). */
  private readonly parked = new Map<PeerId, ParkedGhost>();
  private readonly unsubs: (() => void)[] = [];

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.bus.on('net:remotePlayerAdded', ({ id }) => {
      const ref = ctx.net?.getRemotePlayer(id);
      if (ref) this.ensure(ref);
    });
    ctx.bus.on('net:remotePlayerRemoved', ({ id }) => { this.remove(id); this.dropGhost(id, true); this.parked.delete(id); });
    ctx.bus.on('game:abort', () => this.clearAll());
    ctx.bus.on('game:newMission', () => this.clearAll());
    // entering a ship: drop mission avatars so nobody lingers at a stale planet position; the peers still in
    // the shared ship re-avatar from their next hub snapshot
    ctx.bus.on('hub:entered', () => this.clearAll());

    /* ── Phase 7: ghosts ── */
    ctx.bus.on('net:peerSuspended', ({ id, suspended }) => this.onPeerSuspended(id, suspended));
    // Phase 9: a member that leaves the mission (page reload → `lobby:mission false`) has its ghost parked, not dropped
    ctx.bus.on('net:missionMembership', ({ id, inMission }) => { if (!inMission) this.parkGhost(id); });
    ctx.bus.on('net:hostChanged', ({ isLocalHost }) => this.onHostChanged(isLocalHost));
    ctx.bus.on('ghost:damage', ({ id, amount, kb }) => this.damageGhost(id, amount, kb));
    const net = ctx.net;
    if (net) {
      this.unsubs.push(
        net.onMessage('ghostq', (msg, from) => {
          if (!this.hostsGhosts()) return;
          if (msg.ev === 'sync') this.sendSync(from);
          else if (msg.ev === 'revive') this.reviveGhost(msg.id);
        }),
        net.onMessage('flow', (msg, from) => {
          if (msg.ev !== 'rejoined' || !this.hostsGhosts()) return;
          // the returning member gets its own body back first (active or parked ghost), then the remaining ghosts
          this.restoreTo(from);
          this.sendSync(from);
        }),
        net.onMessage('ghost', (msg) => {
          // every client remembers the last wire state so a promoted host can rebuild the ghosts
          if (msg.ev === 'state' || msg.ev === 'restore') this.lastGhost.set(msg.g.id, msg.g);
          else if (msg.ev === 'sync') for (const g of msg.ghosts) this.lastGhost.set(g.id, g);
          else if (msg.ev === 'gone') this.lastGhost.delete(msg.id);
        }),
      );
    }
  }

  update(dt: number, ctx: GameContext): void {
    this.frame++;
    const refs = ctx.net?.getRemotePlayers() ?? EMPTY;
    for (let i = 0; i < refs.length; i++) this.drive(refs[i], dt, ctx);
    for (let i = 0; i < this.debugRefs.length; i++) this.drive(this.debugRefs[i], dt, ctx);
    // sweep avatars whose ref vanished without a removal event
    if (this.avatars.size > refs.length + this.debugRefs.length) {
      for (const [id, av] of this.avatars) if (av.seenFrame !== this.frame) this.remove(id);
    }
    if (this.ghosts.size > 0 || this.parked.size > 0) this.updateGhosts(dt, ctx);
  }

  dispose(): void {
    this.clearAll();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
  }

  /* ─────────────────────────── queries ─────────────────────────── */
  getAvatar(id: PeerId): RemoteAvatar | undefined { return this.avatars.get(id); }
  getAvatars(): ReadonlyMap<PeerId, RemoteAvatar> { return this.avatars; }
  /** Peers currently offering a `revive:<id>` interactable. */
  getReviveTargets(): PeerId[] { return [...this.revives.keys()]; }
  /** Ghosts this client simulates (host only; empty elsewhere). */
  getGhosts(): ReadonlyMap<PeerId, Ghost> { return this.ghosts; }
  getGhost(id: PeerId): Ghost | undefined { return this.ghosts.get(id); }
  /** Last ghost wire state seen per id (kept on every client for host promotion). */
  getLastGhostStates(): ReadonlyMap<PeerId, GhostWire> { return this.lastGhost; }
  /** Phase 9: parked ghosts (host only) — `until` is the ctx.time they expire. */
  getParkedGhosts(): ReadonlyMap<PeerId, ParkedGhost> { return this.parked; }

  /* ─────────────────────────── debug ─────────────────────────── */
  /**
   * Smoke-test helper (browser console): spawn a fake remote without a NetSystem session and mutate the
   * returned object (`ref.flags |= PlayerFlags.SPRINT`, `ref.stance = 'prone'`, `ref.isDowned = true`, `ref.position.x += …`).
   * `window.__game.getSystem('remotePlayers').debugSpawn({ slot: 1 })`.
   */
  debugSpawn(opts: Partial<Pick<DebugRemoteRef, 'id' | 'name' | 'slot' | 'stance' | 'flags' | 'weaponId' | 'isDowned' | 'implantId' | 'armorId' | 'heldItemId' | 'downHp'>> & { position?: THREE.Vector3 } = {}): DebugRemoteRef {
    const slot = opts.slot ?? (this.debugRefs.length + 1) % 4;
    const pos = new THREE.Vector3();
    if (opts.position) pos.copy(opts.position);
    else if (this.ctx.player) { pos.copy(this.ctx.player.position); pos.x += 2 + slot; }
    const ref: DebugRemoteRef = {
      id: opts.id ?? `debug-${slot}-${Date.now().toString(36)}`,
      name: opts.name ?? `테스트 ${slot}`,
      slot,
      suspended: false, inMission: true,
      position: pos,
      velocity: new THREE.Vector3(),
      yaw: this.ctx.player?.yaw ?? 0,
      pitch: 0,
      stance: opts.stance ?? 'stand',
      flags: opts.flags ?? 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      isDead: false,
      weaponId: opts.weaponId ?? null,
      stridePhase: 0, moveBlend: 0,
      lastUpdate: this.ctx.time,
      connected: true, stale: false,
      avatar: null,
      isDowned: opts.isDowned ?? false,
      implantId: opts.implantId ?? null,
      armorId: opts.armorId ?? null,
      heldItemId: opts.heldItemId ?? null,
      downHp: opts.downHp,
      get isCloaked(): boolean { return (this.flags & PlayerFlags.CLOAKED) !== 0; },
    };
    this.debugRefs.push(ref);
    return ref;
  }

  /** Remove one (by id) or every fake remote created with `debugSpawn`. */
  debugClear(id?: PeerId): void {
    for (let i = this.debugRefs.length - 1; i >= 0; i--) {
      const r = this.debugRefs[i];
      if (id !== undefined && r.id !== id) continue;
      this.debugRefs.splice(i, 1);
      this.remove(r.id);
      this.dropGhost(r.id, false);
      this.parked.delete(r.id);
    }
  }

  /**
   * Smoke-test helper: suspend / resume a `debugSpawn` ref exactly like `net:peerSuspended` would (ghost created
   * from its last position / hp / downed state when suspending; `ctx.net.send` is a no-op offline).
   */
  debugSuspend(id: PeerId, suspended: boolean): Ghost | undefined {
    const ref = this.debugRefs.find((r) => r.id === id);
    if (!ref) return undefined;
    ref.suspended = suspended;
    ref.stale = suspended;
    this.ctx.bus.emit('net:peerSuspended', { id, name: ref.name, suspended });
    return this.ghosts.get(id);
  }

  /**
   * Smoke-test helper: the returning member's `flow rejoined` for a debug ghost — active or parked (Phase 9) —
   * returns the restore wire, or null when there is nothing to restore.
   */
  debugRejoin(id: PeerId): GhostWire | null {
    const g = this.ghosts.get(id);
    const wire = g ? toWire(g) : (this.parked.get(id)?.wire ?? null);
    if (!wire) return null;
    this.restoreTo(id);
    return wire;
  }

  /** Smoke-test helper: make a parked ghost expire on the next frame instead of after `NET_GHOST_PARK_S`. */
  debugExpireParked(id: PeerId): boolean {
    const e = this.parked.get(id);
    if (!e) return false;
    e.until = this.ctx.time;
    return true;
  }

  /* ─────────────────────────── internals ─────────────────────────── */
  private drive(ref: RemotePlayerRef, dt: number, ctx: GameContext): void {
    // Phase 7: a suspended member keeps its ref (and body) even when the lobby marks it disconnected
    if (!ref.connected && !ref.suspended) { this.remove(ref.id); return; }
    const av = this.ensure(ref);
    av.seenFrame = this.frame;
    av.update(dt, ctx);
    this.syncRevive(ref, ctx);
  }

  private ensure(ref: RemotePlayerRef): RemoteAvatar {
    let av = this.avatars.get(ref.id);
    if (av && av.ref !== ref) { this.remove(ref.id); av = undefined; } // ref object was recreated
    if (!av) {
      av = new RemoteAvatar(ref, this.ctx.scene);
      this.avatars.set(ref.id, av);
      ref.avatar = av;
    } else if (ref.avatar !== av) {
      ref.avatar = av;
    }
    return av;
  }

  private remove(id: PeerId): void {
    this.unregisterRevive(id);
    const av = this.avatars.get(id);
    if (!av) return;
    this.avatars.delete(id);
    av.dispose();
  }

  private clearAll(): void {
    for (const id of [...this.revives.keys()]) this.unregisterRevive(id);
    this.reviveSuppress.clear();
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    this.ghosts.clear();
    this.lastGhost.clear();
    this.parked.clear();
  }

  /* ─────────────────────────── revive interactable ─────────────────────────── */
  private syncRevive(ref: RemotePlayerRef, ctx: GameContext): void {
    const suppressed = (this.reviveSuppress.get(ref.id) ?? 0) > ctx.time;
    // Phase 7: a suspended (ghost-driven) body is revivable too — the hold completes into `ghostq revive`
    const present = ref.suspended || (ref.connected && !ref.stale);
    const want = ref.isDowned && !ref.isDead && present && !suppressed;
    const has = this.revives.has(ref.id);
    if (want && !has) this.registerRevive(ref);
    else if (!want && has) this.unregisterRevive(ref.id);
    if (!suppressed && this.reviveSuppress.has(ref.id)) this.reviveSuppress.delete(ref.id);
  }

  private registerRevive(ref: RemotePlayerRef): void {
    const ctx = this.ctx;
    const id = ref.id;
    const entry: ReviveEntry = { interactable: null as unknown as Interactable, lastSent: -Infinity };
    const send = (ev: 'progress' | 'cancel' | 'done', p?: number) => {
      if (ref.suspended) return;   // socket down: nothing to relay; the host applies the completed hold
      ctx.net?.send(p === undefined ? { t: 'revive', ev, target: id } : { t: 'revive', ev, target: id, p }, id);
    };
    entry.interactable = {
      id: `revive:${id}`,
      position: ref.position,          // the ref's own Vector3 (stable instance, follows the interpolated peer)
      radius: PLAYER_REVIVE_RANGE,
      holdTime: PLAYER_REVIVE_HOLD,
      getPrompt: () => `부활: ${ref.name}`,
      canInteract: () => {
        const me = ctx.player;
        return !!me && !me.isDead && !me.isDowned && ctx.isGameplayActive() && ref.isDowned && !ref.isDead;
      },
      onHoldProgress: (t: number) => {
        if (ctx.time - entry.lastSent < REVIVE_PROGRESS_INTERVAL) return;
        entry.lastSent = ctx.time;
        send('progress', Math.min(1, Math.max(0, t)));
      },
      onHoldCancel: () => { entry.lastSent = -Infinity; send('cancel'); },
      interact: () => {
        if (ref.suspended) {
          // Phase 7: the member's socket is down — the host's ghost stands back up
          if (this.hostsGhosts() && this.ghosts.has(id)) this.reviveGhost(id);
          else ctx.net?.send({ t: 'ghostq', ev: 'revive', id }, 'host');
        } else {
          send('done');
        }
        ctx.bus.emit('ui:notify', { text: `${ref.name} 부활`, kind: 'success', duration: 2 });
        ctx.bus.emit('audio:play', { id: 'stim', position: ref.position, volume: 0.8 });
        // keep the prompt away until the peer's DOWNED flag actually clears (next snapshots / ghost state)
        this.reviveSuppress.set(id, ctx.time + REVIVE_DONE_SUPPRESS);
        this.unregisterRevive(id);
      },
    };
    this.revives.set(id, entry);
    ctx.interactables.register(entry.interactable);
  }

  private unregisterRevive(id: PeerId): void {
    const entry = this.revives.get(id);
    if (!entry) return;
    this.revives.delete(id);
    this.ctx.interactables.unregister(entry.interactable.id);
  }

  /* ─────────────────────────── Phase 7: ghosts (host) ─────────────────────────── */
  /** true when this client simulates ghosts: authority inside a session (debug refs need no session). */
  private hostsGhosts(): boolean {
    const ctx = this.ctx;
    return ctx.isAuthority && ((ctx.net?.inSession ?? false) || this.debugRefs.length > 0);
  }

  private findRef(id: PeerId): RemotePlayerRef | undefined {
    return this.ctx.net?.getRemotePlayer(id) ?? this.debugRefs.find((r) => r.id === id);
  }

  private onPeerSuspended(id: PeerId, suspended: boolean): void {
    if (!suspended) {
      // Phase 9: the socket is back. A seamless resume sends `flow rejoined` right away (restore from the parked
      // wire); a member that never rejoins (came back without the mission) keeps a parked body for NET_GHOST_PARK_S.
      if (this.ghosts.has(id)) this.parkGhost(id);
      return;
    }
    if (!this.hostsGhosts() || this.ghosts.has(id)) return;
    const ref = this.findRef(id);
    if (!ref) return;
    const debug = this.debugRefs.some((r) => r.id === id);
    if (!debug && !(this.ctx.net?.inSession ?? false)) return;
    this.parked.delete(id);   // a fresh suspension supersedes a parked body
    const g = this.createGhost(ref, this.lastGhost.get(id), debug);
    this.applyToRef(g);
    this.sendState(g);
  }

  /** Build a ghost from the ref's last known body (or a remembered wire state when this host was promoted). */
  private createGhost(ref: RemotePlayerRef, wire: GhostWire | undefined, debug: boolean): Ghost {
    const g: Ghost = {
      id: ref.id, position: new THREE.Vector3(), yaw: ref.yaw, hp: ref.hp, downHp: 0, state: 0,
      lastSent: -Infinity, bleedAcc: 0, debug,
    };
    if (wire) {
      g.position.set(wire.p[0], wire.p[1], wire.p[2]);
      g.yaw = wire.yaw; g.hp = wire.hp; g.downHp = wire.dhp; g.state = wire.st;
    } else {
      g.position.copy(ref.position);
      if (ref.isDead) { g.state = 2; g.hp = 0; g.downHp = 0; }
      else if (ref.isDowned) {
        // Phase 9: inherit the member's real bleed pool (`PlayerSnapshot.dhp` → `ref.downHp`); unknown → full pool
        const dhp = ref.downHp;
        g.state = 1; g.hp = 0;
        g.downHp = Math.max(1, Math.min(PLAYER_DOWN_HP, Math.round(Number.isFinite(dhp) ? (dhp as number) : PLAYER_DOWN_HP)));
      }
      else g.hp = Math.max(1, Math.min(PLAYER_MAX_HP, ref.hp));
    }
    this.ghosts.set(ref.id, g);
    return g;
  }

  /** Enemies hit the suspended body: hp → downed (`downHp`) → dead; a knockback shoves the ghost a little. */
  private damageGhost(id: PeerId, amount: number, kb?: { direction: THREE.Vector3; speed: number }): void {
    const g = this.ghosts.get(id);
    if (!g || !this.hostsGhosts() || g.state === 2) return;
    let changed = false;
    if (amount > 0) {
      if (g.state === 0) {
        g.hp = Math.max(0, g.hp - amount);
        if (g.hp <= 0) { g.state = 1; g.downHp = PLAYER_DOWN_HP; g.bleedAcc = 0; }
        changed = true;
      } else {
        g.downHp = Math.max(0, g.downHp - amount);
        if (g.downHp <= 0) { g.state = 2; g.hp = 0; }
        changed = true;
      }
    }
    if (kb && kb.speed > 0 && kb.direction.lengthSq() > 1e-6 && g.state !== 2) {
      _kb.copy(kb.direction).setY(0);
      if (_kb.lengthSq() > 1e-6) {
        _kb.normalize().multiplyScalar(Math.min(GHOST_KB_MAX, kb.speed * GHOST_KB_SCALE));
        g.position.add(_kb);
        const world = this.ctx.world;
        if (world?.ready) {
          if (!world.isInsideBounds(g.position.x, g.position.z)) g.position.sub(_kb);
          g.position.y = world.getHeightAt(g.position.x, g.position.z);
        }
        changed = true;
      }
    }
    if (changed) { this.applyToRef(g); this.sendState(g); }
  }

  /** A squadmate completed the revive hold on the suspended body (local host or `ghostq revive`). */
  private reviveGhost(id: PeerId): void {
    const g = this.ghosts.get(id);
    if (!g || g.state !== 1) return;
    g.state = 0; g.hp = PLAYER_REVIVE_HP; g.downHp = 0; g.bleedAcc = 0;
    this.applyToRef(g);
    this.sendState(g);
  }

  private updateGhosts(dt: number, ctx: GameContext): void {
    if (!this.hostsGhosts()) { this.ghosts.clear(); this.parked.clear(); return; }
    // Phase 9: parked bodies expire quietly (`ghost gone` went out when they were parked)
    if (this.parked.size > 0) for (const [id, e] of this.parked) if (ctx.time >= e.until) this.parked.delete(id);
    const interval = 1 / NET_GHOST_STATE_HZ;
    for (const g of this.ghosts.values()) {
      let changed = false;
      if (g.state === 1) {
        g.bleedAcc += GHOST_BLEED_PER_SEC * dt;
        const whole = Math.floor(g.bleedAcc);
        if (whole >= 1) {
          g.bleedAcc -= whole;
          g.downHp = Math.max(0, g.downHp - whole);
          if (g.downHp <= 0) { g.state = 2; g.hp = 0; }
          changed = true;
        }
      }
      if (changed) this.applyToRef(g);
      if (changed || ctx.time - g.lastSent >= interval) this.sendState(g);
    }
  }

  /** The host's own ref of the suspended peer mirrors the ghost so enemies / HUD / revive read the live body. */
  private applyToRef(g: Ghost): void {
    const ref = this.findRef(g.id);
    if (!ref) return;
    const hook = ref as unknown as GhostApplicable;
    if (typeof hook.applyGhost === 'function') { hook.applyGhost(toWire(g)); return; }
    // no net hook (debug ref / older net): write the mutable view directly
    const w = ref as unknown as { hp: number; flags: number; yaw: number; isDead?: boolean; isDowned?: boolean; ghostState?: GhostState; ghostDownHp?: number };
    ref.position.copy(g.position);
    w.yaw = g.yaw;
    w.hp = g.hp;
    w.ghostState = g.state;
    w.ghostDownHp = g.downHp;
    let flags = w.flags & ~(PlayerFlags.DOWNED | PlayerFlags.DEAD);
    if (g.state === 1) flags |= PlayerFlags.DOWNED;
    if (g.state === 2) flags |= PlayerFlags.DEAD;
    w.flags = flags;
    // debug refs carry plain boolean fields instead of flag getters
    const d = Object.getOwnPropertyDescriptor(ref, 'isDowned');
    if (d && d.writable) { w.isDowned = g.state === 1; w.isDead = g.state === 2; }
  }

  private sendState(g: Ghost): void {
    g.lastSent = this.ctx.time;
    const wire = toWire(g);
    this.lastGhost.set(g.id, wire);
    this.ctx.bus.emit('net:ghostState', { id: g.id, hp: g.hp, downHp: g.downHp, state: g.state });
    if (g.debug) return;
    this.ctx.net?.send({ t: 'ghost', ev: 'state', g: wire }, 'others');
  }

  private sendSync(to: PeerId): void {
    const ghosts: GhostWire[] = [];
    for (const g of this.ghosts.values()) if (!g.debug) ghosts.push(toWire(g));
    this.ctx.net?.send({ t: 'ghost', ev: 'sync', ghosts }, to);
  }

  /**
   * The member is back in the mission (`flow rejoined`): hand its body over and drop the ghost. Phase 9: with no
   * active ghost, a parked body inside its window is restored the same way (then forgotten).
   */
  private restoreTo(id: PeerId): void {
    const g = this.ghosts.get(id);
    if (g) {
      if (!g.debug) this.ctx.net?.send({ t: 'ghost', ev: 'restore', g: toWire(g) }, id);
      this.dropGhost(id, true);
      return;
    }
    const p = this.parked.get(id);
    if (!p) return;
    this.parked.delete(id);
    if (!p.debug) this.ctx.net?.send({ t: 'ghost', ev: 'restore', g: p.wire }, id);
  }

  /**
   * Phase 9: the member left the mission without rejoining (page reload → `inMission` false, or its socket came back
   * without `flow rejoined`) — keep the body's last state for `NET_GHOST_PARK_S`, out of the simulation, and tell
   * everyone the ghost is gone (avatars go back to snapshot mode).
   */
  private parkGhost(id: PeerId): void {
    const g = this.ghosts.get(id);
    if (!g) return;
    this.parked.set(id, { wire: toWire(g), until: this.ctx.time + NET_GHOST_PARK_S, debug: g.debug });
    this.dropGhost(id, true);
  }

  private dropGhost(id: PeerId, announce: boolean): void {
    const g = this.ghosts.get(id);
    this.lastGhost.delete(id);
    if (!g) return;
    this.ghosts.delete(id);
    this.clearRefGhost(id);
    if (announce && !g.debug) this.ctx.net?.send({ t: 'ghost', ev: 'gone', id }, 'others');
  }

  /** The host's own ref of the member goes back to snapshot mode (net hook, or the debug ref's plain fields). */
  private clearRefGhost(id: PeerId): void {
    const ref = this.findRef(id);
    if (!ref) return;
    const hook = ref as unknown as GhostApplicable;
    if (typeof hook.clearGhost === 'function') { hook.clearGhost(); return; }
    const w = ref as unknown as { ghostState?: GhostState; ghostDownHp?: number };
    w.ghostState = undefined;
    w.ghostDownHp = undefined;
  }

  /** Promotion: rebuild every suspended member's ghost from the last wire state; demotion: drop them silently. */
  private onHostChanged(isLocalHost: boolean): void {
    if (!isLocalHost) {
      this.ghosts.clear();
      this.parked.clear();   // parked bodies were announced gone; the new host cannot restore them
      // ask the new host for the current ghosts so our refs follow them
      if (this.ctx.net?.inSession) this.ctx.net.send({ t: 'ghostq', ev: 'sync' }, 'host');
      return;
    }
    if (!this.hostsGhosts()) return;
    const refs = this.ctx.net?.getRemotePlayers() ?? EMPTY;
    const rebuild = (ref: RemotePlayerRef, debug: boolean) => {
      if (!ref.suspended || this.ghosts.has(ref.id)) return;
      const g = this.createGhost(ref, this.lastGhost.get(ref.id), debug);
      this.applyToRef(g);
    };
    for (const ref of refs) rebuild(ref, false);
    for (const ref of this.debugRefs) rebuild(ref, true);
    for (const g of this.ghosts.values()) this.sendState(g);
  }
}

function toWire(g: Ghost): GhostWire {
  return { id: g.id, p: [g.position.x, g.position.y, g.position.z], yaw: g.yaw, hp: g.hp, dhp: g.downHp, st: g.state };
}
