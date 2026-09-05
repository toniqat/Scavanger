import * as THREE from 'three';
import {
  PLAYER_MAX_HP, PLAYER_REVIVE_HOLD, PLAYER_REVIVE_RANGE, PlayerFlags,
  type GameContext, type GameSystem, type ImplantId, type Interactable, type PeerId, type RemotePlayerRef, type Stance,
} from '@/shared';
import { RemoteAvatar } from './RemoteAvatar';

const EMPTY: readonly RemotePlayerRef[] = [];
/** Max rate of `revive progress` relay messages while holding E on a downed teammate. */
const REVIVE_PROGRESS_INTERVAL = 0.25;
/** After a completed revive the interactable stays away this long (until the peer's DOWNED flag clears). */
const REVIVE_DONE_SUPPRESS = 1.5;

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
}

interface ReviveEntry { interactable: Interactable; lastSent: number }

/**
 * Renders every peer in `ctx.net.getRemotePlayers()` as a `RemoteAvatar`. Avatars are created on demand
 * (first frame a ref is seen, or on `net:remotePlayerAdded`), driven every frame from the interpolated ref,
 * and disposed on `net:remotePlayerRemoved`, when `!ref.connected`, when the ref disappears from the list,
 * and wholesale on `game:abort` / `game:newMission` / `hub:entered` (refs that survive are re-avatared next frame).
 * Runs in every phase — hub avatars render whenever `ctx.net` still lists remote refs (`inHubSession`).
 *
 * Phase 2: every downed, alive, connected, non-stale ref gets a `revive:<peerId>` `Interactable` (hold E
 * PLAYER_REVIVE_HOLD within PLAYER_REVIVE_RANGE) that relays `revive progress/cancel/done` to that peer;
 * the peer's NetSystem calls `ctx.player.revive()` on `done`.
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

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.bus.on('net:remotePlayerAdded', ({ id }) => {
      const ref = ctx.net?.getRemotePlayer(id);
      if (ref) this.ensure(ref);
    });
    ctx.bus.on('net:remotePlayerRemoved', ({ id }) => this.remove(id));
    ctx.bus.on('game:abort', () => this.clearAll());
    ctx.bus.on('game:newMission', () => this.clearAll());
    // entering a ship: drop mission avatars so nobody lingers at a stale planet position; the peers still in
    // the shared ship re-avatar from their next hub snapshot
    ctx.bus.on('hub:entered', () => this.clearAll());
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
  }

  dispose(): void { this.clearAll(); }

  /* ─────────────────────────── queries ─────────────────────────── */
  getAvatar(id: PeerId): RemoteAvatar | undefined { return this.avatars.get(id); }
  getAvatars(): ReadonlyMap<PeerId, RemoteAvatar> { return this.avatars; }
  /** Peers currently offering a `revive:<id>` interactable. */
  getReviveTargets(): PeerId[] { return [...this.revives.keys()]; }

  /* ─────────────────────────── debug ─────────────────────────── */
  /**
   * Smoke-test helper (browser console): spawn a fake remote without a NetSystem session and mutate the
   * returned object (`ref.flags |= PlayerFlags.SPRINT`, `ref.stance = 'prone'`, `ref.isDowned = true`, `ref.position.x += …`).
   * `window.__game.getSystem('remotePlayers').debugSpawn({ slot: 1 })`.
   */
  debugSpawn(opts: Partial<Pick<DebugRemoteRef, 'id' | 'name' | 'slot' | 'stance' | 'flags' | 'weaponId' | 'isDowned' | 'implantId' | 'armorId'>> & { position?: THREE.Vector3 } = {}): DebugRemoteRef {
    const slot = opts.slot ?? (this.debugRefs.length + 1) % 4;
    const pos = new THREE.Vector3();
    if (opts.position) pos.copy(opts.position);
    else if (this.ctx.player) { pos.copy(this.ctx.player.position); pos.x += 2 + slot; }
    const ref: DebugRemoteRef = {
      id: opts.id ?? `debug-${slot}-${Date.now().toString(36)}`,
      name: opts.name ?? `테스트 ${slot}`,
      slot,
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
    }
  }

  /* ─────────────────────────── internals ─────────────────────────── */
  private drive(ref: RemotePlayerRef, dt: number, ctx: GameContext): void {
    if (!ref.connected) { this.remove(ref.id); return; }
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
  }

  /* ─────────────────────────── revive interactable ─────────────────────────── */
  private syncRevive(ref: RemotePlayerRef, ctx: GameContext): void {
    const suppressed = (this.reviveSuppress.get(ref.id) ?? 0) > ctx.time;
    const want = ref.isDowned && !ref.isDead && ref.connected && !ref.stale && !suppressed;
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
        send('done');
        ctx.bus.emit('ui:notify', { text: `${ref.name} 부활`, kind: 'success', duration: 2 });
        ctx.bus.emit('audio:play', { id: 'stim', position: ref.position, volume: 0.8 });
        // keep the prompt away until the peer's DOWNED flag actually clears (next snapshots)
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
}
