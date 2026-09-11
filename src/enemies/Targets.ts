import * as THREE from 'three';
import { CLOAK_DETECT_MUL, PLAYER_HEIGHT, PlayerFlags, type DroneRef, type GameContext, type PeerId, type PlayerRef } from '@/shared';
import type { Enemy } from './Enemy';

/** `'local'` is the player on this machine; `'ai'` is another enemy (faction warfare, Phase 4); anything else is a remote peer id. */
export type TargetId = PeerId | 'local' | 'ai';

const EYE_STAND = 1.55, EYE_CROUCH = 1.15, EYE_PRONE = 0.45;

/**
 * Something a bug can hunt: the local player or an interpolated remote player.
 * Instances are stable for as long as the player is present, so an `Enemy.target` reference stays valid
 * across frames; `present` flips to false when the peer leaves / goes stale and the AI must re-target.
 * `position` / `velocity` are copies refreshed once per frame by `TargetList.refresh`.
 */
export class CombatTarget {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  isDead = true;
  /** Downed (crawling, revivable). Never an AI target / victim, but still a body for separation and spawn-distance checks. */
  downed = false;
  present = false;
  yaw = 0;
  eyeHeight = EYE_STAND;
  /**
   * Appended (tactical kit): 0..1 factor an enemy multiplies its detection range by.
   * Local → `PlayerRef.getStealthFactor()`; remote → `CLOAK_DETECT_MUL` while the `CLOAKED` flag is set.
   * Defaults to 1 whenever the player system does not implement it yet.
   */
  stealth = 1;
  /** Set for the local target so eye/forward come straight from the player (camera yaw, pod state…). */
  player: PlayerRef | null = null;
  /**
   * Phase 7: the remote member's socket is down and the host simulates its body (`RemotePlayerRef.suspended`).
   * Still a target; damage goes out as `ghost:damage` instead of a `dmg` message (the host's RemotePlayerSystem applies it).
   */
  suspended = false;
  /**
   * Phase 4: set when this target is another enemy (`id === 'ai'`). Every `Enemy` owns one such proxy (`Enemy.asTarget`)
   * refreshed by the system each frame so bug ↔ rogue combat reuses the player-hunting code paths unchanged.
   */
  enemy: Enemy | null = null;
  /* ── appended (2026-09-11): 드론 표적 ─────────────────────────────────────── */
  /**
   * 이 표적이 드론의 프록시면 그 드론 (`TargetList.drones`), 아니면 null. 드론 프록시의 `id` 는 `'ai'` 다 —
   * 플레이어 id 체계(`'local'` / PeerId)를 건드리지 않으려는 것이고, 피해는 `droneId` 로 `ctx.drones.damageDrone` 에 간다.
   * 드론이 사라져도 이 참조는 지우지 않는다(`present` / `isDead` 만 내린다) — 그 순간 표적으로 들고 있던 적이
   * 이 프록시를 플레이어로 착각해 `dmg` 를 `'ai'` 에게 보내는 일이 없게.
   */
  drone: DroneRef | null = null;
  droneId: string | null = null;
  droneRadius = 0;
  droneHeight = 0;
  /** 드론 몸체 **밑면**이 그 아래 표면보다 몇 m 떠 있는가 — 근접 벌레가 닿을 수 있는지(`pickTarget`). */
  droneAltitude = 0;
  /** `TargetList` 가 이번 갱신에서 이 드론을 봤는가 (프레임 번호). */
  droneStamp = 0;
  /** 속도 추정용 — `DroneRef` 에는 속도가 없어서 위치 차분으로 만든다. */
  readonly dronePrev = new THREE.Vector3();
  dronePrevAt = -Infinity;

  constructor(readonly id: TargetId) {}

  get isLocal(): boolean { return this.id === 'local'; }
  get isEnemy(): boolean { return this.enemy !== null; }
  get isDrone(): boolean { return this.drone !== null; }

  /** True when bugs must neither hunt nor hurt this player (dead, or downed and waiting for a revive). */
  get isDeadOrDowned(): boolean { return this.isDead || this.downed; }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getEyePosition(out);
    if (this.drone) return this.getChest(out);
    if (this.enemy) return out.set(this.position.x, this.position.y + this.enemy.height * 0.8, this.position.z);
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Horizontal forward (same convention as the player camera rig: yaw 0 → -Z). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getForward(out);
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Point bugs aim at / trace LOS to (chest height). */
  getChest(out: THREE.Vector3): THREE.Vector3 {
    // 드론 프록시의 `position` 은 몸체 밑면이라 가운데는 높이의 절반 위다 (공중 드론 = 원래의 몸체 중심)
    const h = this.drone ? this.droneHeight * 0.5 : this.enemy ? this.enemy.height * 0.6 : PLAYER_HEIGHT * 0.65;
    return out.set(this.position.x, this.position.y + h, this.position.z);
  }

  /** Body radius for hit tests (players PLAYER_RADIUS-like via the caller; enemies their own; drones their body). */
  get bodyRadius(): number { return this.drone ? this.droneRadius : this.enemy ? this.enemy.radius : 0.45; }
  get bodyHeight(): number { return this.drone ? this.droneHeight : this.enemy ? this.enemy.height : PLAYER_HEIGHT; }

  dist2D(p: THREE.Vector3): number {
    return Math.hypot(this.position.x - p.x, this.position.z - p.z);
  }
}

/**
 * Read `PlayerRef.getStealthFactor()` defensively: the player system may not implement it yet
 * (folders are built in parallel), and a bad value must never make the bugs blind or omniscient.
 */
function readStealth(player: PlayerRef): number {
  const fn = (player as Partial<PlayerRef>).getStealthFactor;
  if (typeof fn !== 'function') return 1;
  const v = fn.call(player);
  return typeof v === 'number' && v > 0 && v <= 1 ? v : 1;
}

/**
 * Per-frame list of every player the enemies know about: the local player (when spawned) plus every connected,
 * non-stale remote player that is not still inside its hellpod — and (Phase 7) every *suspended* member, whose body
 * the host keeps simulating as a ghost. In single-player only the local target exists, so every query below
 * degenerates to the old `ctx.player` behaviour.
 */
export class TargetList {
  /** Every present target (alive, downed or dead). */
  readonly all: CombatTarget[] = [];
  /** Present, alive and not downed — the only players the AI may target or damage. */
  readonly alive: CombatTarget[] = [];
  private readonly byId = new Map<TargetId, CombatTarget>();
  private readonly gone: TargetId[] = [];
  /* ── appended (2026-09-11): 드론 표적 ── */
  /**
   * 지금 적이 노려도 되는(`DroneRef.aggroable`, 살아 있는) 드론의 프록시. **`all` / `alive` 에는 넣지 않는다** —
   * 스포너 · 웨이브 · 산성 스플래시 · 포탄 · 분리(separation)가 드론을 플레이어로 착각하지 않게. 드론을 알아야 하는
   * 경로(`pickTarget` · 로그 사격 · 산성 직격 · 몸통 접촉 `nearestAliveWithin`)만 이 목록을 따로 본다.
   * 프록시는 드론 id 당 하나이고 그 드론이 월드에 있는 동안 유지된다(조용해지면 `present` 만 내린다) — 할당은 꺼낼 때 한 번.
   */
  readonly drones: CombatTarget[] = [];
  private readonly droneById = new Map<string, CombatTarget>();
  /** 모든 드론 프록시 (조용한 것 포함) — 사라진 드론을 찾는 순회용. Map 엔트리 순회는 프레임마다 튜플을 만든다. */
  private readonly droneAll: CombatTarget[] = [];
  private droneFrame = 0;

  refresh(ctx: GameContext): void {
    this.refreshDrones(ctx);
    for (const t of this.byId.values()) t.present = false;

    const player = ctx.player;
    if (player) {
      const t = this.obtain('local');
      t.player = player;
      t.position.copy(player.position);
      t.velocity.copy(player.velocity);
      t.yaw = player.yaw;
      t.isDead = player.isDead;
      t.downed = player.isDowned;
      t.eyeHeight = player.stance === 'prone' ? EYE_PRONE : player.stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
      t.stealth = readStealth(player);
      t.suspended = false;
    }

    const net = ctx.net;
    if (net && ctx.isMultiplayer) {
      const remotes = net.getRemotePlayers();
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        // Phase 7: a suspended member (socket down, slot kept) stays a target — its position / hp / downed / dead come
        // from the host's ghost simulation through the same ref, so only a *non-suspended* stale ref drops out.
        const suspended = r.suspended === true;
        if (!r.connected || (r.stale && !suspended) || (r.flags & PlayerFlags.DROPPING) !== 0) continue;
        const t = this.obtain(r.id);
        t.player = null;
        t.suspended = suspended;
        t.position.copy(r.position);
        t.velocity.copy(r.velocity);
        t.yaw = r.yaw;
        t.isDead = r.isDead || (r.flags & PlayerFlags.DEAD) !== 0;
        t.downed = r.isDowned || (r.flags & PlayerFlags.DOWNED) !== 0;
        t.eyeHeight = r.stance === 'prone' ? EYE_PRONE : r.stance === 'crouch' ? EYE_CROUCH : EYE_STAND;
        t.stealth = (r.isCloaked ?? (r.flags & PlayerFlags.CLOAKED) !== 0) ? CLOAK_DETECT_MUL : 1;
      }
    }

    this.all.length = 0;
    this.alive.length = 0;
    this.gone.length = 0;
    for (const t of this.byId.values()) {
      if (!t.present) { this.gone.push(t.id); continue; }
      this.all.push(t);
      if (!t.isDead && !t.downed) this.alive.push(t);
    }
    for (let i = 0; i < this.gone.length; i++) this.byId.delete(this.gone[i]);
  }

  private obtain(id: TargetId): CombatTarget {
    let t = this.byId.get(id);
    if (!t) { t = new CombatTarget(id); this.byId.set(id, t); }
    t.present = true;
    return t;
  }

  /**
   * 2026-09-11: `ctx.drones.getDrones()` → `drones`. 걷는 지상 드론은 `aggroable` 이 false 라 목록에 오르지 않는다
   * (적이 봐도 무시). 프록시 `position` 은 **몸체 밑면**이다 — 지상 드론은 `DroneRef.position`(바닥점) 그대로, 공중
   * 드론은 몸체 중심에서 높이의 절반 아래. 그래서 발 기준으로 짜인 기존 식(`getChest` · `rayStandingCapsule` ·
   * `lookAtTarget` · 산성 조준)이 공중 드론에도 그대로 맞는다. yaw 는 플레이어 규약(forward = −sin, −cos)으로 뒤집어 둔다.
   */
  private refreshDrones(ctx: GameContext): void {
    const frame = ++this.droneFrame;
    this.drones.length = 0;
    const list = ctx.drones?.getDrones();
    if (list && list.length > 0) {
      const world = ctx.world && ctx.world.ready ? ctx.world : null;
      const now = ctx.time;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        let t = this.droneById.get(d.id);
        if (!t) {
          t = new CombatTarget('ai');
          t.droneId = d.id;
          this.droneById.set(d.id, t);
          this.droneAll.push(t);
        }
        t.drone = d;
        t.droneStamp = frame;
        const p = d.position;
        const bottom = d.kind === 'air' ? p.y - d.height * 0.5 : p.y;
        // 속도 = 위치 차분. 같은 프레임에 두 번 갱신되면(world:ready 등) 이전 값을 그대로 둔다.
        const dt = now - t.dronePrevAt;
        if (dt > 1e-3) {
          if (dt < 0.5) t.velocity.set((p.x - t.dronePrev.x) / dt, (p.y - t.dronePrev.y) / dt, (p.z - t.dronePrev.z) / dt);
          else t.velocity.set(0, 0, 0);
          t.dronePrev.copy(p);
          t.dronePrevAt = now;
        }
        t.position.set(p.x, bottom, p.z);
        t.yaw = d.yaw + Math.PI;
        t.droneRadius = d.radius;
        t.droneHeight = d.height;
        t.player = null;
        t.suspended = false;
        t.stealth = 1;
        t.downed = false;
        t.isDead = !(d.hp > 0);
        t.present = d.aggroable && !t.isDead;
        if (!t.present) continue;
        t.droneAltitude = world ? Math.max(0, bottom - world.getSurfaceY(p.x, p.z, bottom)) : 0;
        this.drones.push(t);
      }
    }
    // 월드에서 사라진 드론: 프록시를 버린다. 그 프록시를 표적으로 들고 있던 적은 `present` false 를 보고 다시 고른다.
    for (let i = this.droneAll.length - 1; i >= 0; i--) {
      const t = this.droneAll[i];
      if (t.droneStamp === frame) continue;
      t.present = false;
      t.isDead = true;
      if (t.droneId !== null) this.droneById.delete(t.droneId);
      this.droneAll.splice(i, 1);
    }
  }

  clear(): void {
    this.byId.clear();
    this.all.length = 0;
    this.alive.length = 0;
    for (let i = 0; i < this.droneAll.length; i++) { const t = this.droneAll[i]; t.present = false; t.isDead = true; }
    this.droneAll.length = 0;
    this.droneById.clear();
    this.drones.length = 0;
  }

  get(id: TargetId): CombatTarget | undefined { return this.byId.get(id); }
  local(): CombatTarget | undefined { return this.byId.get('local'); }
  anyAlive(): boolean { return this.alive.length > 0; }

  /** Nearest alive target (2D), or null. */
  nearestAlive(p: THREE.Vector3): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.alive.length; i++) {
      const t = this.alive[i];
      const d = t.dist2D(p);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /**
   * Nearest alive target within `radius` (2D), or null — the **body contact** query (charger rush, hunter leap landing,
   * toxic swell trigger). 2026-09-11: aggroable drones count too, but only when their body is within `radius`
   * **vertically** of `p` (the enemy's feet) as well — a bug does not bump into an air drone hovering overhead.
   * `nearestAlive` (target choice, wave facing, spawner anchors) still sees players only.
   */
  nearestAliveWithin(p: THREE.Vector3, radius: number): CombatTarget | null {
    const t = this.nearestAlive(p);
    let best = t && t.dist2D(p) < radius ? t : null;
    let bestD = best ? best.dist2D(p) : radius;
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      if (d.isDeadOrDowned) continue;
      const dd = d.dist2D(p);
      if (dd >= bestD) continue;
      if (d.position.y - p.y > radius || d.position.y + d.droneHeight < p.y - radius) continue;
      best = d; bestD = dd;
    }
    return best;
  }

  /** Smallest 2D distance from `p` to any present target (alive or dead); Infinity when none. */
  minDist(p: THREE.Vector3): number {
    let best = Infinity;
    for (let i = 0; i < this.all.length; i++) { const d = this.all[i].dist2D(p); if (d < best) best = d; }
    return best;
  }

  /** 2D distance to the local player (Infinity when absent) — for listener-relative audio / shake decisions. */
  distToLocal(p: THREE.Vector3): number {
    const l = this.byId.get('local');
    return l && l.present ? l.dist2D(p) : Infinity;
  }

  randomAlive(): CombatTarget | null {
    const n = this.alive.length;
    return n === 0 ? null : this.alive[Math.floor(Math.random() * n)];
  }

  /**
   * Random present target, preferring one that is not dead (i.e. downed) — the ambient spawner's anchor when nobody
   * is alive, so patrols keep coming while the whole squad is downed / waiting to respawn.
   */
  randomPresent(): CombatTarget | null {
    let n = 0;
    for (let i = 0; i < this.all.length; i++) if (!this.all[i].isDead) n++;
    if (n > 0) {
      let k = Math.floor(Math.random() * n);
      for (let i = 0; i < this.all.length; i++) if (!this.all[i].isDead && k-- === 0) return this.all[i];
    }
    const m = this.all.length;
    return m === 0 ? null : this.all[Math.floor(Math.random() * m)];
  }
}
