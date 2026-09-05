import * as THREE from 'three';
import {
  PLAYER_MAX_HP, type GameContext, type GameSystem, type PeerId, type RemotePlayerRef, type Stance,
} from '@/shared';
import { RemoteAvatar } from './RemoteAvatar';

const EMPTY: readonly RemotePlayerRef[] = [];

/** Fully writable RemotePlayerRef for console smoke tests (`debugSpawn`). */
export interface DebugRemoteRef {
  id: PeerId; name: string; slot: number;
  position: THREE.Vector3; velocity: THREE.Vector3;
  yaw: number; pitch: number; stance: Stance; flags: number;
  hp: number; maxHp: number; isDead: boolean; weaponId: string | null;
  stridePhase: number; moveBlend: number; lastUpdate: number;
  connected: boolean; stale: boolean; avatar: RemoteAvatar | null;
}

/**
 * Renders every peer in `ctx.net.getRemotePlayers()` as a `RemoteAvatar`. Avatars are created on demand
 * (first frame a ref is seen, or on `net:remotePlayerAdded`), driven every frame from the interpolated ref,
 * and disposed on `net:remotePlayerRemoved`, when `!ref.connected`, when the ref disappears from the list,
 * and wholesale on `game:abort` / `game:newMission` (refs that survive are re-avatared next frame).
 *
 * Runs right after PlayerSystem (see main.ts); NetSystem has already smoothed the refs this frame.
 */
export class RemotePlayerSystem implements GameSystem {
  readonly name = 'remotePlayers';

  private ctx!: GameContext;
  private readonly avatars = new Map<PeerId, RemoteAvatar>();
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

  /* ─────────────────────────── debug ─────────────────────────── */
  /**
   * Smoke-test helper (browser console): spawn a fake remote without a NetSystem session and mutate the
   * returned object (`ref.flags |= PlayerFlags.SPRINT`, `ref.stance = 'prone'`, `ref.position.x += …`).
   * `window.__game.getSystem('remotePlayers').debugSpawn({ slot: 1 })`.
   */
  debugSpawn(opts: Partial<Pick<DebugRemoteRef, 'id' | 'name' | 'slot' | 'stance' | 'flags' | 'weaponId'>> & { position?: THREE.Vector3 } = {}): DebugRemoteRef {
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
    const av = this.avatars.get(id);
    if (!av) return;
    this.avatars.delete(id);
    av.dispose();
  }

  private clearAll(): void {
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
  }
}
