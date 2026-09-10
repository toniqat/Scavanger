import * as THREE from 'three';
import {
  FOOTSTEP_MIN_INTERVAL_S,
  GHOST_BLEED_PER_SEC, NET_GHOST_PARK_S, NET_GHOST_STATE_HZ, PLAYER_CARRY_OFFSET, PLAYER_DOWN_HP, PLAYER_MAX_HP,
  PLAYER_REVIVE_HOLD, PLAYER_REVIVE_HP, PLAYER_REVIVE_RANGE, PlayerFlags,
  type GameContext, type GameSystem, type GhostState, type GhostWire, type ImplantId, type Interactable, type PeerId,
  type RemotePlayerRef, type Stance,
} from '@/shared';
import { RemoteAvatar } from './RemoteAvatar';
import { STRIDE_MIN_SPEED } from './PlayerController';
import type { CarryHost, CarryStatus, CarryTarget } from './Carry';
/* appended (2026-09-09): 아군의 강하 포드 */
import { RemotePods } from './RemotePods';

const EMPTY: readonly RemotePlayerRef[] = [];
/** 스크래치 — `pod drop` 좌표 (핫 패스는 아니지만 프레임당 할당을 만들지 않는다). */
const _podPos = new THREE.Vector3();
/** Max rate of `revive progress` relay messages while holding E on a downed teammate. */
const REVIVE_PROGRESS_INTERVAL = 0.25;
/** After a completed revive the interactable stays away this long (until the peer's DOWNED flag clears). */
const REVIVE_DONE_SUPPRESS = 1.5;
/** Horizontal metres a ghost is shoved per unit of knockback speed (no physics for a ghost; capped). */
const GHOST_KB_SCALE = 0.12;
const GHOST_KB_MAX = 2.0;

/**
 * 2026-09-10 — 원격 발소리. 로컬이 `PlayerController` 의 보행 위상에서 `player:footstep` 을 내는 것과 **같은
 * 기준**을 스냅샷 쪽에서 다시 적용한다: 접지 + 수평 속도 `STRIDE_MIN_SPEED` 초과 + 구르는 중이 아님,
 * 그리고 `stridePhase` 가 π 경계를 넘을 때 한 걸음. 거리는 여기서 재지 않는다 — 감쇠는 `audio/` 의 몫이다.
 */
interface StepState { idx: number; t: number }
/** 발소리를 내지 않는 플래그 묶음 — 공중 · 구르기 · 강하 중 · 포드 안. */
const STEP_MUTE_FLAGS = PlayerFlags.AIRBORNE | PlayerFlags.DIVE | PlayerFlags.DROPPING | PlayerFlags.IN_POD;

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
  /* Phase 10: 들쳐메기 mirrors (`PlayerSnapshot.cr` / `flags & CARRIED`, derived `carriedBy`) */
  carrying?: PeerId | null;
  isCarried?: boolean;
  carriedBy?: PeerId | null;
}

/** A revive prompt owns its own position vector so it can follow a carrier's shoulder socket (Phase 10). */
interface ReviveEntry { interactable: Interactable; lastSent: number; position: THREE.Vector3 }

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
  /** 2026-09-10: 실드 — 피해는 이것부터 비운다 (살아 있는 몸과 같은 순서). 방탄복이 없으면 0. */
  shield: number;
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
const _cw = new THREE.Vector3();

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
export class RemotePlayerSystem implements GameSystem, CarryHost {
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
  /** Phase 10: peer ids whose avatar the LOCAL player carries (instant feedback before their `CARRIED` bit lands). */
  private readonly localCarried = new Set<PeerId>();
  /** Phase 10: peer id whose shoulder socket our own body currently hangs on (null = not carried). */
  private myCarrier: PeerId | null = null;
  /** 2026-09-09: 아군의 강하 포드 (`pod drop`). 미션 시작 · 구조선 둘 다 여기로 들어온다. */
  private pods: RemotePods | null = null;
  /** 2026-09-10: 원격 발소리 — peer 별 마지막 걸음 인덱스와 시각 (`remote:footstep`). */
  private readonly steps = new Map<PeerId, StepState>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.pods = new RemotePods(ctx.scene);
    // the player owns the carry rules but not the avatars / refs — hand it this system as its carry host
    (ctx.player as unknown as { setCarryHost?(h: CarryHost | null): void } | null)?.setCarryHost?.(this);
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
        /*
         * 2026-09-09 — **아군의 강하 포드**. 지금까지 원격 분대원은 자리에 그냥 나타났다. `who` 의 아바타는
         * 그 사람의 `PlayerFlags.DROPPING` 이 이미 감추고 있으므로 여기서는 포드만 떨어뜨리면 된다.
         */
        net.onMessage('pod', (msg) => {
          if (msg.ev !== 'drop' || !msg.who || msg.who === net.localId) return;
          this.pods?.drop(ctx, msg.who, _podPos.set(msg.p[0], msg.p[1], msg.p[2]), msg.yaw, msg.kind);
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
    // Phase 10: bodies riding on somebody's shoulder (including our own) — the avatars exist by now
    this.updateCarries(refs, ctx);
    // 2026-09-09: 떨어지는 중인 아군 포드 (없으면 즉시 반환)
    this.pods?.update(dt, ctx);
    if (this.ghosts.size > 0 || this.parked.size > 0) this.updateGhosts(dt, ctx);
  }

  dispose(): void {
    this.clearAll();
    (this.ctx?.player as unknown as { setCarryHost?(h: CarryHost | null): void } | null)?.setCarryHost?.(null);
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
    this.emitFootstep(ref, av, ctx);
    this.syncRevive(ref, ctx);
  }

  /**
   * 2026-09-10 — **원격 분대원의 발소리** (`remote:footstep`). `av.update` 뒤에 부르므로 `av.isShown` 이
   * 이번 프레임의 값이다: 강하 중 · 포드 안 · 다른 함선 · 시체로 대체된 몸은 그대로 조용하다.
   * 거리는 재지 않는다 — "멀 수록 작게" 는 `audio/AudioSystem` 이 `FOOTSTEP_AUDIBLE_RANGE` 로 건다.
   * 핫 패스라 프레임당 할당이 없다: peer 별 `StepState` 는 한 번만 만들고 `ref.position` 을 그대로 넘긴다
   * (로컬이 `c.position` 을 그대로 넘기는 것과 같다 — 받는 쪽이 동기적으로 읽는다).
   */
  private emitFootstep(ref: RemotePlayerRef, av: RemoteAvatar, ctx: GameContext): void {
    const idx = Math.floor(ref.stridePhase / Math.PI);
    let st = this.steps.get(ref.id);
    if (st === undefined) { st = { idx, t: -Infinity }; this.steps.set(ref.id, st); }
    if (idx === st.idx) return;
    st.idx = idx;
    // 보이지 않는 몸 · 죽은 몸 · 스냅샷이 끊긴 몸(정지한 위상이 한 번 튄다)은 소리를 내지 않는다
    if (!av.isShown || ref.isDead || ref.suspended || ref.stale) return;
    if ((ref.flags & STEP_MUTE_FLAGS) !== 0) return;
    // 로컬의 `speed > STRIDE_MIN_SPEED` 게이트와 같은 기준 — 제자리에서 위상이 중립으로 되감길 때는 조용하다
    const v = ref.velocity;
    if (Math.hypot(v.x, v.z) <= STRIDE_MIN_SPEED) return;
    if (ctx.time - st.t < FOOTSTEP_MIN_INTERVAL_S) return;
    st.t = ctx.time;
    ctx.bus.emit('remote:footstep', {
      position: ref.position,
      sprinting: (ref.flags & PlayerFlags.SPRINT) !== 0,
      peerId: ref.id,
    });
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
    this.steps.delete(id);
    const av = this.avatars.get(id);
    if (!av) return;
    // Phase 10: never take a carried body down with the carrier's avatar (`dispose` detaches the whole subtree)
    this.evacuateShoulder(av);
    if (this.localCarried.delete(id)) this.ctx.player?.dropCarried('reset');
    if (this.myCarrier === id) { this.myCarrier = null; this.ctx.player?.setCarriedBy(null); }
    this.avatars.delete(id);
    av.dispose();
  }

  /** Move whatever hangs on `av`'s shoulder socket back into the scene before the avatar goes away. */
  private evacuateShoulder(av: RemoteAvatar): void {
    const kids = [...av.shoulderSocket.children];
    for (const kid of kids) {
      kid.updateWorldMatrix(true, false);
      this.ctx.scene.attach(kid);
    }
  }

  private clearAll(): void {
    for (const id of [...this.revives.keys()]) this.unregisterRevive(id);
    this.reviveSuppress.clear();
    this.steps.clear();
    if (this.myCarrier !== null) { this.myCarrier = null; this.ctx.player?.setCarriedBy(null); }
    this.localCarried.clear();
    for (const av of this.avatars.values()) { this.evacuateShoulder(av); av.carried = false; av.dispose(); }
    this.avatars.clear();
    this.ghosts.clear();
    this.lastGhost.clear();
    this.parked.clear();
    this.pods?.clear();
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
    // Phase 10: while the body is carried, `ref.position` is a stale snapshot — the prompt has to follow the
    // carrier's shoulder socket, otherwise a shouldered squadmate can never be revived.
    const entry = this.revives.get(ref.id);
    if (entry) {
      const av = this.avatars.get(ref.id);
      if (av && (av.carried || ref.isCarried === true)) entry.position.copy(av.root.getWorldPosition(_cw));
      else entry.position.copy(ref.position);
    }
  }

  private registerRevive(ref: RemotePlayerRef): void {
    const ctx = this.ctx;
    const id = ref.id;
    const entry: ReviveEntry = {
      interactable: null as unknown as Interactable, lastSent: -Infinity,
      position: ref.position.clone(),
    };
    const send = (ev: 'progress' | 'cancel' | 'done', p?: number) => {
      if (ref.suspended) return;   // socket down: nothing to relay; the host applies the completed hold
      ctx.net?.send(p === undefined ? { t: 'revive', ev, target: id } : { t: 'revive', ev, target: id, p }, id);
    };
    entry.interactable = {
      id: `revive:${id}`,
      // own Vector3, refreshed every frame in `syncRevive` from the interpolated ref — or from the carrier's
      // shoulder socket while the body is being carried (Phase 10)
      position: entry.position,
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

  /* ─────────────────────── Phase 10: 부상자 들쳐메기 (CarryHost) ─────────────────────── */
  /** Every ref this client knows about (real peers first, then the console's fake ones). Reuses one array. */
  private allRefs(): readonly RemotePlayerRef[] {
    const real = this.ctx.net?.getRemotePlayers() ?? EMPTY;
    if (this.debugRefs.length === 0) return real;
    const out = this.refScratch;
    out.length = 0;
    for (const r of real) out.push(r);
    for (const r of this.debugRefs) out.push(r as unknown as RemotePlayerRef);
    return out;
  }
  private readonly refScratch: RemotePlayerRef[] = [];

  /** A ref is present when its snapshots are live, or when the host's ghost drives its body. */
  private static present(ref: RemotePlayerRef): boolean {
    return ref.suspended === true || (ref.connected && !ref.stale);
  }

  /** Who is carrying `id`: the net-derived `carriedBy` if there is one, else whoever's `cr` points at it. */
  private carrierIdOf(id: PeerId, refs: readonly RemotePlayerRef[]): PeerId | null {
    for (const r of refs) {
      if (r.id !== id) continue;
      if (r.carriedBy) return r.carriedBy;
      break;
    }
    for (const r of refs) if (r.carrying && r.carrying === id) return r.id;
    return null;
  }

  /** Nearest carriable (downed, alive, present, nobody else's load) squadmate within `range`. */
  findCarriable(from: THREE.Vector3, range: number): CarryTarget | null {
    const refs = this.allRefs();
    let best: CarryTarget | null = null;
    let bestD = range * range;
    for (const ref of refs) {
      if (!this.carriableRef(ref, refs)) continue;
      const d = ref.position.distanceToSquared(from);
      if (d > bestD) continue;
      bestD = d;
      best = { id: ref.id, name: ref.name, position: ref.position };
    }
    return best;
  }

  targetOf(id: string): CarryTarget | null {
    const refs = this.allRefs();
    for (const ref of refs) {
      if (ref.id !== id) continue;
      return this.carriableRef(ref, refs) ? { id: ref.id, name: ref.name, position: ref.position } : null;
    }
    return null;
  }

  /** Why an in-progress carry has to end (`'ok'` = keep going). */
  carryStatus(id: string): CarryStatus {
    for (const ref of this.allRefs()) {
      if (ref.id !== id) continue;
      if (!RemotePlayerSystem.present(ref)) return 'gone';
      if (ref.isDead) return 'died';
      if (!ref.isDowned) return 'revived';
      return 'ok';
    }
    return 'gone';
  }

  attachCarried(id: string, socket: THREE.Object3D): boolean {
    const av = this.avatars.get(id);
    if (!av) return false;
    socket.add(av.root);
    av.root.position.set(PLAYER_CARRY_OFFSET[0], PLAYER_CARRY_OFFSET[1], PLAYER_CARRY_OFFSET[2]);
    av.root.quaternion.identity();
    av.carried = true;
    this.localCarried.add(id);
    return true;
  }

  detachCarried(id: string, position: THREE.Vector3): void {
    this.localCarried.delete(id);
    const av = this.avatars.get(id);
    if (!av) return;
    av.carried = false;
    av.root.updateWorldMatrix(true, false);
    this.ctx.scene.attach(av.root);
    av.root.position.copy(position);
    // the peer's own snapshots take over again from here; this just avoids a one-frame pop at the old spot
  }

  /** true when this body may be shouldered right now. */
  private carriableRef(ref: RemotePlayerRef, refs: readonly RemotePlayerRef[]): boolean {
    if (!ref.isDowned || ref.isDead) return false;
    if (!RemotePlayerSystem.present(ref)) return false;
    if (ref.isCarried === true || this.localCarried.has(ref.id)) return false;
    if (this.carrierIdOf(ref.id, refs)) return false;
    return true;
  }

  /**
   * Per frame: keep every carried body parented to its carrier's shoulder socket (ours is already parented by
   * `attachCarried`), and hand / take back the LOCAL body when a peer picks us up or puts us down.
   */
  private updateCarries(refs: readonly RemotePlayerRef[], ctx: GameContext): void {
    const localId = ctx.net?.localId ?? null;
    const all = this.allRefs();
    for (const av of this.avatars.values()) {
      const id = av.ref.id;
      if (this.localCarried.has(id)) { av.carried = true; continue; }
      const by = this.carrierIdOf(id, all);
      const carrier = by && by !== localId ? this.avatars.get(by) : undefined;
      if (carrier && carrier !== av) {
        if (av.root.parent !== carrier.shoulderSocket) {
          carrier.shoulderSocket.add(av.root);
          av.root.position.set(PLAYER_CARRY_OFFSET[0], PLAYER_CARRY_OFFSET[1], PLAYER_CARRY_OFFSET[2]);
          av.root.quaternion.identity();
        }
        av.carried = true;
        continue;
      }
      if (av.carried) {
        av.carried = false;
        if (av.root.parent !== ctx.scene) { av.root.updateWorldMatrix(true, false); ctx.scene.attach(av.root); }
      }
    }
    // our own body: whoever's `cr` points at us owns it (the carried side of `attachTo`)
    if (!localId) return;   // no session: only `debugCarryLocal` drives the local body
    let mine: PeerId | null = null;
    for (const r of refs) if (r.carrying === localId) { mine = r.id; break; }
    if (!mine) for (const r of this.debugRefs) if (r.carrying === localId) { mine = r.id; break; }
    if (mine === this.myCarrier) return;
    this.myCarrier = mine;
    const socket = mine ? this.avatars.get(mine)?.shoulderSocket ?? null : null;
    ctx.player?.setCarriedBy(socket);
    if (mine && !socket) this.myCarrier = null;   // no avatar yet: retry next frame
  }

  /**
   * Smoke-test helper: pretend the debug peer `id` shouldered the local player (the wire path is
   * `PlayerSnapshot.cr` → `RemotePlayerRef.carrying`, which a fake ref sets directly).
   */
  debugCarryLocal(id: PeerId, on: boolean): boolean {
    const ref = this.debugRefs.find((r) => r.id === id);
    if (!ref) return false;
    if (on) {
      const av = this.avatars.get(id);
      if (!av) return false;
      // Set the wire field AND wire the local body up right away, so the helper is synchronous whether or not a
      // relay session exists (`updateCarries` then sees `mine === myCarrier` and leaves it alone).
      ref.carrying = this.ctx.net?.localId ?? '__local__';
      this.myCarrier = id;
      this.ctx.player?.setCarriedBy(av.shoulderSocket);
      return true;
    }
    ref.carrying = null;
    if (this.myCarrier === id) { this.myCarrier = null; this.ctx.player?.setCarriedBy(null); }
    return true;
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
      id: ref.id, position: new THREE.Vector3(), yaw: ref.yaw, hp: ref.hp, downHp: 0, shield: 0, state: 0,
      lastSent: -Infinity, bleedAcc: 0, debug,
    };
    if (wire) {
      g.position.set(wire.p[0], wire.p[1], wire.p[2]);
      g.yaw = wire.yaw; g.hp = wire.hp; g.downHp = wire.dhp; g.state = wire.st;
      g.shield = Math.max(0, Math.round(wire.sh ?? 0));
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
      /* 실드는 마지막 스냅샷(`PlayerSnapshot.sh`)에서 온다 — 방탄복이 없거나 아직 모르면 0. */
      const sh = ref.shield;
      if (g.state === 0 && Number.isFinite(sh)) g.shield = Math.max(0, Math.round(sh as number));
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
        /* 살아 있는 몸과 같은 순서: 실드를 먼저 비우고 남은 만큼만 hp 로. */
        const absorbed = Math.min(g.shield, amount);
        g.shield -= absorbed;
        g.hp = Math.max(0, g.hp - (amount - absorbed));
        if (g.hp <= 0) { g.state = 1; g.downHp = PLAYER_DOWN_HP; g.shield = 0; g.bleedAcc = 0; }
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
  const w: GhostWire = { id: g.id, p: [g.position.x, g.position.y, g.position.z], yaw: g.yaw, hp: g.hp, dhp: g.downHp, st: g.state };
  if (g.shield > 0) w.sh = g.shield;   // 실드가 있을 때만 실어 보낸다 (`PlayerSnapshot.sh` 와 같은 규약)
  return w;
}
