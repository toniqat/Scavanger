/**
 * src/allies/AllySystem.ts — **android squadmates** (`ctx.allies`, contract `shared/allies.ts`).
 *
 * The contract is `allies.ts` plus the last section of `net.ts`, both in `@/shared`. This class holds state and
 * one-line delegates only; `parts/` does the work:
 *  - `parts/Roster`   — the roster (lobby bot members / the cheat roster) · body creation · `ally:rosterChanged`
 *  - `parts/Hub`      — dormant bay bodies in the shared ship · emerge / retire · waiting at the launch pod ·
 *                       the cheat android following in the personal ship
 *  - `parts/Spawn`    — raid entry (the base kit · the drop pod)
 *  - `parts/Fsm`      — proposal → reaction delay → transition, and the per-state action branch
 *  - `parts/Harness`  — squad leader tracking · the harness radius (halved while it keeps one heading)
 *  - `parts/Nav`      — steering · obstacle avoidance · surface/collision (it keeps the world query order)
 *  - `parts/Combat`   — sensing · the enemy ping · cover · bursts
 *  - `parts/Vitals`   — shield/hp/downed/death · hazards · revive
 *  - `parts/Commands` — pings · the comms wheel · inventory requests (one, first one wins)
 *  - `parts/Bag`      — weight · gear swapping · junk dropping
 *  - `parts/Loot`     — containers · items on the ground
 *  - `parts/Support`  — handing an item to the requester
 *  - `parts/Extract`  — searching for the way out · the call · boarding · the stash deposit
 *  - `parts/Contract` — contract objective search
 *  - `parts/Rescue`   — getting a downed PC up · carrying one out of a hazard
 *  - `parts/Ping`     — pings and chat going out under the android's name
 *  - `parts/Sync`     — the `ally` / `allyq` wire (host authority)
 *  - `parts/Console`  — the dev cheat `/android 1|0`
 *
 * This folder **builds no meshes** — player/ reads `getBodies()` and draws them with `SoldierModel`.
 * It is registered in `main.ts` right after `ExtractionSystem`: it decides after enemies · inventory · pickups ·
 * extraction have published this frame's state.
 */
import * as THREE from 'three';
import { ALLY_EXTRACT_CONFIRM_S, ALLY_LOCAL_PEER, PLAYER_REVIVE_RANGE } from '@/shared';
import type {
  AlliesRef, AllyBodyView, AllyId, AllyLoadoutView, AllyRosterEntry, AllyStateId, GameContext, GameSystem,
  ItemInstance, PeerId, PingKind, PlayerDamageSource,
} from '@/shared';
import type { Ally } from './parts/Body';
import type { AllyRequest } from './model';
import * as Roster from './parts/Roster';
import * as Hub from './parts/Hub';
import * as Spawn from './parts/Spawn';
import * as Fsm from './parts/Fsm';
import * as Harness from './parts/Harness';
import * as Vitals from './parts/Vitals';
import * as Commands from './parts/Commands';
import * as Support from './parts/Support';
import * as Extract from './parts/Extract';
import * as Sync from './parts/Sync';
import * as Console from './parts/Console';

export class AllySystem implements GameSystem, AlliesRef {
  readonly name = 'allies';
  ctx!: GameContext;

  /** Every body this client knows (in bay order). `getBodies()` hands this very array out. */
  readonly bodies: Ally[] = [];
  readonly byId = new Map<AllyId, Ally>();
  /** The current roster (`AlliesRef.roster`). A new array only when it changed. */
  roster: readonly AllyRosterEntry[] = [];
  /** The serverless cheat roster — it lives for the session only (it is never saved). */
  readonly localRoster: AllyRosterEntry[] = [];
  /** A unit a person outranked and sent back to its bay — it becomes `evicted` on the next `ally:rosterChanged`. */
  readonly evictedPending: AllyId[] = [];
  /**
   * The roster has to be recomputed (the frame loop calls `Roster.refresh` only while this is raised — it keeps array
   * allocation down).
   */
  rosterDirty = true;

  /** The reused array `getCombatBodies()` returns. */
  readonly combatBuf: Ally[] = [];

  /* ── Squad leader · harness (`parts/Harness`) ── */
  leaderId: PeerId = ALLY_LOCAL_PEER;
  readonly leaderPos = new THREE.Vector3();
  readonly leaderPrev = new THREE.Vector3();
  readonly leaderDir = new THREE.Vector3();
  leaderKnown = false;
  /** How steadily it keeps one heading, 0..1 (EMA). At 1 the harness shrinks to `ALLY_HARNESS_MIN_FRAC`. */
  commit = 0;
  harness = 0;

  /* ── Orders · requests ── */
  /** The squad leader's movement order (an `attack` ping · a `lead` line on the comms wheel). */
  orderKind: 'moveTo' | 'lead' | null = null;
  readonly orderPos = new THREE.Vector3();
  orderUntil = -Infinity;
  /**
   * Until the `ctx.time` at which `앞장서라` expires — the harness radius is ×`ALLY_LEAD_HARNESS_MUL` until then
   * (`parts/Harness`). Why it lives apart from `orderKind`: the walk out ahead ends on arrival, but **the widened
   * search range** stays for `ALLY_LEAD_DURATION_S` so the free search (`roam`) sweeps the area (2026-09-16 user's
   * decision).
   */
  leadUntil = -Infinity;
  /** The `주의` ping (`caution`). */
  readonly watchPos = new THREE.Vector3();
  watchUntil = -Infinity;
  /**
   * A person placed an enemy ping — the squad intercepts that enemy first (2026-09-16 user's decision; it is not
   * leader-only). It is released in exactly one place, `parts/Commands.tickEnemyPing`: death · nobody saw it for
   * `ALLY_WATCH_S` · a new ping.
   */
  preferredEnemyId: number | null = null;
  /** The designated enemy's last known spot — a unit that has not seen it yet closes on this, inside the harness. */
  readonly preferredEnemyPos = new THREE.Vector3();
  preferredEnemyUntil = -Infinity;
  /**
   * The last extraction ping a person placed (the spot · who · when). When that person says 「탈출하고 싶다」 the squad
   * agrees and goes **to this spot** (2026-09-16 user's decision) — `parts/Commands.agreeToHumanExtract` ·
   * `parts/Extract.seek`.
   */
  readonly humanExtractPos = new THREE.Vector3();
  humanExtractBy: PeerId | null = null;
  humanExtractAt = -Infinity;
  hasHumanExtractPing = false;
  /** The one request currently taken (first one wins). */
  request: AllyRequest | null = null;
  /** The Korean sentence that came with it (the only clue a remote contract request gives). */
  requestText = '';
  /** New requests are ignored until this `ctx.time`. */
  requestBlockedUntil = -Infinity;
  /** Length of the extraction confirm window (s). */
  readonly extractConfirmWindow = ALLY_EXTRACT_CONFIRM_S;
  /** The distance (m) within which the host accepts `allyq revive` — the same as a person's revive range. */
  readonly reviveRange = PLAYER_REVIVE_RANGE;

  /* ── Containers · timers · sync ── */
  /** Containers a person has looked into — an android looting that crate stops. */
  readonly viewedContainers = new Set<string>();
  /** The `ctx.time` at which the drop pod touches the ground. */
  readonly landAt = new Map<AllyId, number>();
  hazardTimer = 0;
  envTimer = 0;
  netTimer = 0;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  readonly netUnsubs: Array<() => void> = [];
  /** Scratch for unpacking the wire (a vector going out on an event is read and used at once). */
  readonly fireFrom = new THREE.Vector3();
  readonly fireTo = new THREE.Vector3();

  /** The raid simulation is running (after `world:ready`). */
  raidActive = false;

  /* ═══════════════════════════ Lifecycle ═══════════════════════════ */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.allies = this;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('net:lobbyUpdated', () => { this.rosterDirty = true; }),
      b.on('net:lobbyLeft', () => { this.rosterDirty = true; }),
      b.on('net:androidReturned', ({ bay, reason }) => Roster.onReturned(this, bay, reason)),
      b.on('hub:entered', () => { this.rosterDirty = true; Roster.refresh(this); Hub.onHubEntered(this); }),
      b.on('hub:left', () => Hub.onHubLeft(this)),
      b.on('world:ready', (e) => { this.clearPingOrders(); Spawn.onWorldReady(this, e.playerSpawn); Sync.askSync(this); }),
      b.on('game:abort', () => { this.clearPingOrders(); Spawn.onAbort(this); }),
      b.on('ping:placedV3', (e) => Commands.onPing(this, e)),
      b.on('comms:sent', (e) => Commands.onComms(this, e)),
      b.on('inventory:itemRequested', (e) => Commands.onItemRequest(this, e)),
      b.on('inventory:containerViewed', ({ containerId }) => Commands.onContainerViewed(this, containerId)),
      b.on('extraction:liftoff', () => Extract.onLiftoff(this)),
      b.on('net:hostChanged', ({ isLocalHost }) => Sync.onHostChanged(this, isLocalHost)),
    );
    Console.register(this);
  }

  update(dt: number, ctx: GameContext): void {
    Sync.ensureNetHooks(this);
    if (this.rosterDirty) Roster.refresh(this);
    Harness.update(this, dt);
    if (ctx.isHubPhase()) Hub.update(this, dt);
    else if (this.raidActive) {
      Spawn.updateLanding(this);
      if (this.simulating) {
        Vitals.update(this, dt);
        Commands.tickRequest(this);
        Commands.tickEnemyPing(this);     // The designated enemy's spot · release (a sweep per unit makes arrays)
        Fsm.update(this, dt);
      } else Sync.updateReplicas(this, dt);
    }
    Sync.update(this, dt);
  }

  /**
   * Cleanup of the **ping-based orders** when leaving a raid or when a new map opens (the ones added on 2026-09-16 —
   * the same place as the older fields `parts/Spawn` clears). Left behind, they send it running to the last map's
   * way-out coordinates, or start it with a widened harness.
   */
  private clearPingOrders(): void {
    Harness.clearDebug();            // module state — a smoke that forgot to clear it must not pin the next raid
    this.leadUntil = -Infinity;
    this.preferredEnemyUntil = -Infinity;
    this.hasHumanExtractPing = false;
    this.humanExtractBy = null;
    this.humanExtractAt = -Infinity;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    Sync.unhook(this);
    this.bodies.length = 0;
    this.byId.clear();
    if (this.ctx?.allies === this) this.ctx.allies = null;
  }

  /* ═══════════════════════════ AlliesRef ═══════════════════════════ */
  /** Does this client run the androids — solo · the lobby host. */
  get simulating(): boolean { return this.ctx?.isAuthority ?? true; }

  getBodies(): readonly AllyBodyView[] { return this.bodies; }
  getBody(id: AllyId): AllyBodyView | null { return this.byId.get(id) ?? null; }
  getCombatBodies(): readonly AllyBodyView[] {
    const out = this.combatBuf;
    out.length = 0;
    if (!this.raidActive) return out;
    for (const a of this.bodies) {
      if (a.mode !== 'raid' || a.dead || a.downed || a.hidden) continue;
      out.push(a);
    }
    return out;
  }
  getLoadout(id: AllyId): AllyLoadoutView | null { return Roster.loadoutOf(this, id); }
  damage(id: AllyId, amount: number, source?: PlayerDamageSource, from?: THREE.Vector3): void {
    Vitals.damage(this, id, amount, source, from);
  }
  requestRevive(id: AllyId, opts?: { defib?: boolean }): boolean { return Vitals.requestRevive(this, id, opts); }
  carrierOf(peer: PeerId): AllyBodyView | null {
    for (const a of this.bodies) if (a.carrying === peer) return a;
    return null;
  }
  devSetAndroid(on: boolean): string { return Console.devSetAndroid(this, on); }

  /* ═══════════════════════════ One-line delegates for parts/ ═══════════════════════════ */
  sendPing(a: Ally, kind: PingKind, p: THREE.Vector3, label?: string, enemyId?: number): void {
    Sync.sendPing(this, a, kind, p, label, enemyId);
  }
  sendChat(a: Ally, text: string): void { Sync.sendChat(this, a, text); }
  sendFire(a: Ally, from: THREE.Vector3, to: THREE.Vector3): void { Sync.sendFire(this, a, from, to); }
  sendPodDrop(a: Ally): void { Sync.sendPodDrop(this, a); }
  sendReviveRequest(id: AllyId, defib: boolean): boolean { return Sync.sendReviveRequest(this, id, defib); }
  revivePlayer(a: Ally, target: PeerId, defib: boolean): void { Sync.revivePlayer(this, a, target, defib); }
  depositToLeader(a: Ally, items: readonly ItemInstance[]): void { Sync.depositToLeader(this, a, items); }
  offerToLeader(a: Ally, item: ItemInstance): void { Support.offerToLeader(this, a, item); }

  /* ═══════════════════════════ Debug · smokes ═══════════════════════════ */
  /** Pushes one unit into a given state (with no reaction delay). False on an unknown id. */
  debugForceState(id: AllyId, state: AllyStateId): boolean {
    const a = this.byId.get(id);
    if (!a) return false;
    Fsm.enter(this, a, state, 1000);
    return true;
  }
  /** Puts one item in the bag (marked `raidFound` — eligible for handing over · the stash deposit). */
  debugGive(id: AllyId, defId: string, qty = 1): boolean { return Roster.debugGive(this, id, defId, qty); }
  /** Overrides the squad leader position (to check the harness · following). Null releases it. */
  debugLeaderAt(pos: THREE.Vector3 | null): void { Harness.debugOverride(this, pos); }
  /** The current harness radius (m) and heading consistency 0..1. */
  debugHarness(): { radius: number; commit: number } { return { radius: this.harness, commit: this.commit }; }
  /** Moves one unit to that spot. */
  debugTeleport(id: AllyId, x: number, y: number, z: number): boolean {
    const a = this.byId.get(id);
    if (!a) return false;
    a.position.set(x, y, z);
    a.hidden = false;
    return true;
  }
  /** One unit's current state · hp · what it carries (for a smoke's assertions). */
  debugInfo(id: AllyId): {
    state: AllyStateId; mode: string; hp: number; shield: number; downed: boolean; dead: boolean; hidden: boolean;
    items: string[]; task: string | null; pos: [number, number, number];
  } | null {
    const a = this.byId.get(id);
    if (!a) return null;
    return {
      state: a.state, mode: a.mode, hp: a.hp, shield: a.shield, downed: a.downed, dead: a.dead, hidden: a.hidden,
      items: (a.bag?.items() ?? a.wireItems).map((i) => `${i.defId}x${i.qty}`),
      task: a.taskKind, pos: [a.position.x, a.position.y, a.position.z],
    };
  }
}
