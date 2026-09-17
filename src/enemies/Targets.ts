import * as THREE from 'three';
import { CLOAK_DETECT_MUL, PLAYER_HEIGHT, PlayerFlags, blastReachesBody, explosionFalloff, type AllyBodyView, type DroneRef, type GameContext, type PeerId, type PlayerRef, type RoverRef, type WorldRef } from '@/shared';
import type { Enemy } from './Enemy';

/** `'local'` is the player on this machine; `'ai'` is another enemy (faction warfare, Phase 4); anything else is a remote peer id. */
export type TargetId = PeerId | 'local' | 'ai';

const EYE_STAND = 1.55, EYE_CROUCH = 1.15, EYE_PRONE = 0.45;

/**
 * 2026-09-13 (탐사 차량): 차체 판정 상자(`RoverRef.halfLength/halfWidth/height`)와 월드 레이캐스트(차체 콜라이더)의 여유(m).
 * 사선 검사는 차체에 들어가기 이만큼 **앞에서** 멈춘다 — 안 그러면 차체 자신의 콜라이더가 사선을 막아 차량이 영영 안 보인다.
 * 사격 판정은 월드 탄착이 차체 입구보다 이만큼 앞이어도 차량이 맞은 것으로 본다 (콜라이더가 판정 상자보다 조금 커도 맞는다).
 * 알고리즘 상수라 csv 대상이 아니다.
 */
export const VEHICLE_RAY_MARGIN = 0.5;

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
  /* ── appended (2026-09-13): 탐사 차량 ─────────────────────────────────────── */
  /**
   * 이 플레이어가 탐사 차량 **안에** 타 있다 (로컬 `PlayerRef.roverRide` · 원격 `PlayerFlags.IN_ROVER`). 탑승자는 어떤 피해도
   * 받지 않으므로 적의 표적도 희생자도 아니다 — `isDeadOrDowned` 에 접혀 `alive` 에서 빠지고, 들고 있던 적은 다시 고른다.
   * `all` 에는 남는다 (스폰 거리 · 재활용 거리는 그 몸을 계속 본다).
   */
  riding = false;
  /**
   * 이 표적이 탐사 차량의 프록시면 그 차량 (`TargetList.vehicles`), 아니면 null. 프록시 `id` 는 `'ai'` 다 — 드론과 같은 이유.
   * 차량이 사라져도(파괴 · 레이드 종료) 참조는 지우지 않고 `present` / `isDead` 만 내린다.
   * `position` = 차체 중심 **바닥**(`RoverVehicleDef.position`), `dist2D` = 차체 발자국(OBB) **가장자리**까지의 거리.
   */
  vehicle: RoverRef | null = null;
  /** 차량 프록시: 차체 yaw (`RoverVehicleDef.yaw` 규약 — 전방 = (cos, 0, sin)). `yaw` 필드는 플레이어 규약으로 따로 적힌다. */
  vehicleYaw = 0;
  /** 차량 프록시: 지금 달리는 중(`patrol` · `trip`) — 들린다. */
  vehicleMoving = false;
  readonly vehiclePrev = new THREE.Vector3();
  vehiclePrevAt = -Infinity;
  /* ── appended (2026-09-15): 안드로이드 분대원 ─────────────────────────────── */
  /**
   * 이 표적이 안드로이드 분대원의 프록시면 그 몸(`TargetList.allies`), 아니면 null. 프록시 `id` 는 드론 · 차량과 같은
   * 이유로 `'ai'` 다 — 플레이어 id 체계(`'local'` / PeerId)에 섞이면 `applyDamage` 의 원격 가지가 존재하지 않는
   * 상대에게 `dmg` 를 보내게 된다. 개체 식별은 `allyId` (`AllyBodyView.id`)로 하고, 피해는 `ctx.allies.damage` 로 간다.
   * 안드로이드가 사라져도 참조는 지우지 않고 `present` / `isDead` 만 내린다 (드론과 같은 이유).
   */
  ally: AllyBodyView | null = null;
  allyId: string | null = null;
  /** `TargetList` 가 이번 갱신에서 이 안드로이드를 봤는가 (프레임 번호). */
  allyStamp = 0;

  constructor(readonly id: TargetId) {}

  get isLocal(): boolean { return this.id === 'local'; }
  get isEnemy(): boolean { return this.enemy !== null; }
  get isDrone(): boolean { return this.drone !== null; }
  get isVehicle(): boolean { return this.vehicle !== null; }
  /** 2026-09-15: 안드로이드 분대원 — 몸 크기 · 사선 · 조준은 사람과 같고, 피해만 `ctx.allies.damage` 로 간다. */
  get isAlly(): boolean { return this.ally !== null; }

  /** True when bugs must neither hunt nor hurt this player (dead, or downed and waiting for a revive — or 2026-09-13 riding inside the 탐사 차량). */
  get isDeadOrDowned(): boolean { return this.isDead || this.downed || this.riding; }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.player) return this.player.getEyePosition(out);
    if (this.drone || this.vehicle) return this.getChest(out);
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
    // 2026-09-13: 차량 프록시의 가운데 = 차체 높이의 절반 (바닥점 기준)
    const h = this.vehicle ? this.vehicle.height * 0.5 : this.drone ? this.droneHeight * 0.5 : this.enemy ? this.enemy.height * 0.6 : PLAYER_HEIGHT * 0.65;
    return out.set(this.position.x, this.position.y + h, this.position.z);
  }

  /**
   * Body radius for hit tests (players PLAYER_RADIUS-like via the caller; enemies their own; drones their body).
   * 2026-09-13: a vehicle is 0 — its `dist2D` already measures to the hull's edge, so every "`d < reach + bodyRadius`" rule
   * reads the edge distance unchanged.
   */
  get bodyRadius(): number { return this.vehicle ? 0 : this.drone ? this.droneRadius : this.enemy ? this.enemy.radius : 0.45; }
  get bodyHeight(): number { return this.vehicle ? this.vehicle.height : this.drone ? this.droneHeight : this.enemy ? this.enemy.height : PLAYER_HEIGHT; }

  /** 2D distance to `p` — for a vehicle proxy (2026-09-13) the distance to the hull footprint's **edge** (0 inside). */
  dist2D(p: THREE.Vector3): number {
    if (this.vehicle) return this.vehicleGap2D(p.x, p.z);
    return Math.hypot(this.position.x - p.x, this.position.z - p.z);
  }

  /* ── 2026-09-13: 탐사 차량 차체 상자 (OBB) 질의 — 차량 프록시에서만 부른다. 할당 없음. ── */

  /** `(x, z)` 에서 차체 발자국까지의 수평 거리 (안이면 0). */
  vehicleGap2D(x: number, z: number): number {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const dx = x - this.position.x, dz = z - this.position.z;
    const ox = Math.max(0, Math.abs(dx * c + dz * s) - v.halfLength);
    const oz = Math.max(0, Math.abs(-dx * s + dz * c) - v.halfWidth);
    return Math.hypot(ox, oz);
  }

  /** 점 `p` 에서 차체 상자(바닥 … 바닥 + 높이)까지의 거리 (안이면 0) — 폭발 · 산성 스플래시. */
  vehicleGap3D(p: THREE.Vector3): number {
    const g = this.vehicleGap2D(p.x, p.z);
    const y0 = this.position.y, y1 = y0 + this.vehicle!.height;
    const oy = p.y < y0 ? y0 - p.y : p.y > y1 ? p.y - y1 : 0;
    return Math.hypot(g, oy);
  }

  /** `(x, z)` 가 `pad` 만큼 넓힌 차체 발자국 안인가. */
  vehicleContainsXZ(x: number, z: number, pad: number): boolean {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const dx = x - this.position.x, dz = z - this.position.z;
    return Math.abs(dx * c + dz * s) <= v.halfLength + pad && Math.abs(-dx * s + dz * c) <= v.halfWidth + pad;
  }

  /**
   * `pad` 만큼 넓힌 차체 발자국 둘레에서 `from` 에 가장 가까운 점을 `out` 의 x / z 에 적는다 (y 는 건드리지 않는다). `from` 이 이미
   * 안이면 가장 가까운 면으로 밀어낸 점. 적이 차 **중심**이 아니라 차체 옆으로 다가가게 하는 조향 목표다.
   */
  vehicleApproach(from: THREE.Vector3, pad: number, out: THREE.Vector3): THREE.Vector3 {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const hl = v.halfLength + pad, hw = v.halfWidth + pad;
    const dx = from.x - this.position.x, dz = from.z - this.position.z;
    let lx = dx * c + dz * s, lz = -dx * s + dz * c;
    if (Math.abs(lx) <= hl && Math.abs(lz) <= hw) {
      if (hl - Math.abs(lx) < hw - Math.abs(lz)) lx = (lx < 0 ? -1 : 1) * hl;
      else lz = (lz < 0 ? -1 : 1) * hw;
    } else {
      lx = Math.max(-hl, Math.min(hl, lx));
      lz = Math.max(-hw, Math.min(hw, lz));
    }
    out.x = this.position.x + lx * c - lz * s;
    out.z = this.position.z + lx * s + lz * c;
    return out;
  }

  /** 레이(`d` 단위 벡터)가 차체 상자에 들어가는 거리 — 시작점이 안이면 0, `maxT` 안에서 못 맞히면 −1 (슬랩 판정). */
  rayVehicle(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
    const v = this.vehicle!;
    const c = Math.cos(this.vehicleYaw), s = Math.sin(this.vehicleYaw);
    const hh = v.height * 0.5;
    const rx = o.x - this.position.x, rz = o.z - this.position.z;
    const ox = rx * c + rz * s, oz = -rx * s + rz * c, oy = o.y - (this.position.y + hh);
    const dx = d.x * c + d.z * s, dz = -d.x * s + d.z * c, dy = d.y;
    let t0 = 0, t1 = maxT;
    // x (전방 축)
    if (Math.abs(dx) < 1e-9) { if (Math.abs(ox) > v.halfLength) return -1; }
    else {
      let a = (-v.halfLength - ox) / dx, b = (v.halfLength - ox) / dx;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    // z (옆 축)
    if (Math.abs(dz) < 1e-9) { if (Math.abs(oz) > v.halfWidth) return -1; }
    else {
      let a = (-v.halfWidth - oz) / dz, b = (v.halfWidth - oz) / dz;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    // y
    if (Math.abs(dy) < 1e-9) { if (Math.abs(oy) > hh) return -1; }
    else {
      let a = (-hh - oy) / dy, b = (hh - oy) / dy;
      if (a > b) { const k = a; a = b; b = k; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
    return t0;
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
  /* ── appended (2026-09-13): 탐사 차량 ── */
  /**
   * 적이 노려도 되는(`RoverRef.targetable`) 탐사 차량의 프록시 — 레이드당 1대라 0 또는 1개. **`all` / `alive` 에는 넣지 않는다**
   * (드론과 같은 이유 — 스포너 · 웨이브 · 분리 · 플레이어 루프가 차량을 플레이어로 착각하지 않게). 차량을 알아야 하는 경로
   * (`pickTarget` · 사격 · 산성 · 몸통 접촉 · 적의 폭발)만 따로 본다. 프록시는 하나를 계속 쓴다.
   */
  readonly vehicles: CombatTarget[] = [];
  private readonly vehicleProxy = new CombatTarget('ai');
  /* ── appended (2026-09-15): 안드로이드 분대원 ── */
  /**
   * 적이 노려도 되는 안드로이드 분대원(`AlliesRef.getCombatBodies`)의 프록시. **`all` / `alive` 에는 넣지 않는다** —
   * 드론 · 차량과 같은 이유이자, 「사람이 전원 사망하면 레이드 실패」(사용자 결정)를 세는 곳들이 안드로이드를
   * 사람으로 세면 안 되기 때문이다. 스포너 앵커 · 웨이브 방향 · `nearestAlive` 는 사람만 본다.
   * 표적 선택 · 사격 · 산성 · 몸통 접촉 · 광역 피해만 이 목록을 따로 본다.
   */
  readonly allies: CombatTarget[] = [];
  private readonly allyById = new Map<string, CombatTarget>();
  private readonly allyAll: CombatTarget[] = [];
  private allyFrame = 0;
  /**
   * 디버그 주입(`EnemySystem.debugAllyTargets`) — null 이 아니면 `ctx.allies` 대신 이 목록을 쓴다.
   * `scripts/smoke-enemy-allies.mjs` 가 allies/ 없이 적 쪽만 검사할 수 있게 하는 유일한 통로다.
   */
  allyOverride: readonly AllyBodyView[] | null = null;
  /** 2026-09-18: 폭발 차폐 판정(`damageVehicleAt`)이 읽는 월드 — `refresh` 가 매 프레임 담는다. */
  private world: WorldRef | null = null;

  refresh(ctx: GameContext): void {
    this.world = ctx.world ?? null;
    this.refreshDrones(ctx);
    this.refreshVehicle(ctx);
    this.refreshAllies(ctx);
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
      t.riding = player.roverRide === true;   // 2026-09-13: 탐사 차량 안 — 표적도 희생자도 아니다
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
        t.riding = (r.flags & PlayerFlags.IN_ROVER) !== 0;   // 2026-09-13
      }
    }

    this.all.length = 0;
    this.alive.length = 0;
    this.gone.length = 0;
    for (const t of this.byId.values()) {
      if (!t.present) { this.gone.push(t.id); continue; }
      this.all.push(t);
      if (!t.isDead && !t.downed && !t.riding) this.alive.push(t);
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

  /**
   * 2026-09-13: `ctx.world.rover` → `vehicles`. 파괴 · 경로 없음 · 월드 준비 전이면 비운다(`present` / `isDead` 만 내리고 `vehicle`
   * 참조는 남긴다 — 그 순간 표적으로 들고 있던 적이 프록시를 플레이어로 착각하지 않게). 속도는 위치 차분, yaw 는 플레이어 규약
   * (forward = −sin, −cos) 으로 옮겨 적고 차체 규약 값은 `vehicleYaw` 에 둔다.
   */
  private refreshVehicle(ctx: GameContext): void {
    this.vehicles.length = 0;
    const t = this.vehicleProxy;
    const world = ctx.world;
    const rover = world && world.ready ? world.rover ?? null : null;
    if (!rover || !rover.targetable) {
      t.present = false; t.isDead = true; t.vehicleMoving = false; t.vehiclePrevAt = -Infinity;
      return;
    }
    const v = rover.vehicle;
    const p = v.position;
    const now = ctx.time;
    t.vehicle = rover;
    const dt = now - t.vehiclePrevAt;
    if (dt > 1e-3) {
      if (dt < 0.5) t.velocity.set((p.x - t.vehiclePrev.x) / dt, (p.y - t.vehiclePrev.y) / dt, (p.z - t.vehiclePrev.z) / dt);
      else t.velocity.set(0, 0, 0);
      t.vehiclePrev.copy(p);
      t.vehiclePrevAt = now;
    }
    t.position.copy(p);
    t.vehicleYaw = v.yaw;
    t.yaw = Math.atan2(-Math.cos(v.yaw), -Math.sin(v.yaw));
    t.vehicleMoving = v.state === 'patrol' || v.state === 'trip';
    t.player = null;
    t.suspended = false;
    t.stealth = 1;
    t.downed = false;
    t.riding = false;
    t.isDead = false;
    t.present = true;
    this.vehicles.push(t);
  }

  /**
   * 2026-09-15 (안드로이드 분대원): `ctx.allies.getCombatBodies()` → `allies`. 계약상 그 목록은 이미 「레이드 · 쓰러지지도
   * 죽지도 않음 · 보인다」로 걸러져 있지만, 한 프레임 늦은 목록이 와도 안전하도록 여기서 한 번 더 본다.
   * 프록시는 안드로이드 id 당 하나이고 그 기가 목록에 있는 동안 유지된다 — 할당은 처음 볼 때 한 번.
   */
  private refreshAllies(ctx: GameContext): void {
    const frame = ++this.allyFrame;
    this.allies.length = 0;
    const list = this.allyOverride ?? ctx.allies?.getCombatBodies();
    if (list && list.length > 0) {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        let t = this.allyById.get(b.id);
        if (!t) {
          t = new CombatTarget('ai');
          t.allyId = b.id;
          this.allyById.set(b.id, t);
          this.allyAll.push(t);
        }
        t.ally = b;
        t.allyStamp = frame;
        t.position.copy(b.position);
        t.velocity.copy(b.velocity);
        t.yaw = b.yaw;
        t.player = null;
        t.suspended = false;
        t.stealth = 1;
        t.riding = false;
        t.downed = b.downed;
        t.isDead = b.dead;
        t.eyeHeight = b.pose === 'crouch' ? EYE_CROUCH : EYE_STAND;
        t.present = !b.hidden && !b.dead && !b.downed;
        if (!t.present) continue;
        this.allies.push(t);
      }
    }
    // 목록에서 사라진 안드로이드: 프록시를 버린다 (표적으로 들고 있던 적은 `present` false 를 보고 다시 고른다)
    for (let i = this.allyAll.length - 1; i >= 0; i--) {
      const t = this.allyAll[i];
      if (t.allyStamp === frame) continue;
      t.present = false;
      t.isDead = true;
      if (t.allyId !== null) this.allyById.delete(t.allyId);
      this.allyAll.splice(i, 1);
    }
  }

  /** 2026-09-15: `p` 에서 가장 가까운, 지금 노릴 수 있는 안드로이드 프록시 (없으면 null). */
  nearestAllyAlive(p: THREE.Vector3): CombatTarget | null {
    let best: CombatTarget | null = null;
    let bestD = Infinity;
    for (let i = 0; i < this.allies.length; i++) {
      const t = this.allies[i];
      if (t.isDeadOrDowned) continue;
      const d = t.dist2D(p);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /** 2026-09-15: `p` 의 `maxDist` 안에서 가장 가까운 안드로이드 프록시 — `applyAllyHit` 의 재표적. */
  allyNear(p: THREE.Vector3, maxDist: number): CombatTarget | null {
    const t = this.nearestAllyAlive(p);
    return t && t.dist2D(p) <= maxDist ? t : null;
  }

  /** 2026-09-13: 지금 노릴 수 있는 탐사 차량 프록시, 없으면 null. */
  vehicleTarget(): CombatTarget | null {
    return this.vehicles.length > 0 ? this.vehicles[0] : null;
  }

  /**
   * 2026-09-13 (탐사 차량): **적이 낸** 폭발 · 분출 한 번이 차체에 닿으면 피해를 넣는다 — 폭심에서 차체 상자까지의 거리로
   * 공용 2단 계단 감쇠(`shared/explosion`, 2026-09-15 사용자 결정 — 예전에는 `1 − d / radius` 선형이었다, 최소 `minFalloff`).
   * **권한 분기에서만** 부른다 (`RoverRef.damage` 는 리플리카에서 무시되지만 두 번 부를
   * 이유가 없다). 플레이어 · 가젯 폭발이 지나는 공용 `explode()` 에는 넣지 않는다 — 사용자 결정 「적 · 재해만 피해」.
   */
  damageVehicleAt(center: THREE.Vector3, radius: number, damage: number, minFalloff = 0.15): boolean {
    const t = this.vehicleTarget();
    if (!t || !t.vehicle || !(radius > 0) || !(damage > 0)) return false;
    const d = t.vehicleGap3D(center);
    if (d >= radius) return false;
    // 2026-09-18 (사용자 결정): 벽 · 지붕 너머의 차체는 맞지 않는다 (몸 3점 — 차체 안에서 시작한 레이는 제 콜라이더를 보지 않는다)
    if (!blastReachesBody(this.world, center, t.position.x, t.position.y, t.position.z, t.bodyHeight)) return false;
    t.vehicle.damage(damage * Math.max(minFalloff, explosionFalloff(d, radius)), center);
    return true;
  }

  clear(): void {
    this.byId.clear();
    this.all.length = 0;
    this.alive.length = 0;
    this.vehicles.length = 0;
    this.vehicleProxy.present = false;
    this.vehicleProxy.isDead = true;
    this.vehicleProxy.vehiclePrevAt = -Infinity;
    for (let i = 0; i < this.droneAll.length; i++) { const t = this.droneAll[i]; t.present = false; t.isDead = true; }
    this.droneAll.length = 0;
    this.droneById.clear();
    this.drones.length = 0;
    // 2026-09-15: 안드로이드 프록시 (디버그 주입은 레이드가 끝나도 남겨 둔다 — 지우는 것은 `debugAllyTargets(null)`)
    for (let i = 0; i < this.allyAll.length; i++) { const t = this.allyAll[i]; t.present = false; t.isDead = true; }
    this.allyAll.length = 0;
    this.allyById.clear();
    this.allies.length = 0;
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
    // 2026-09-15: 안드로이드 분대원 — 사람과 같은 몸이라 사람과 같은 규칙 (수평 거리만)
    for (let i = 0; i < this.allies.length; i++) {
      const a = this.allies[i];
      if (a.isDeadOrDowned) continue;
      const dd = a.dist2D(p);
      if (dd < bestD) { best = a; bestD = dd; }
    }
    // 2026-09-13: 탐사 차량 — 차체 **가장자리**까지의 수평 거리 (`dist2D`), 수직으로도 겹칠 때만
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (v.isDeadOrDowned) continue;
      const dd = v.dist2D(p);
      if (dd >= bestD) continue;
      if (v.position.y - p.y > radius || v.position.y + v.bodyHeight < p.y - radius) continue;
      best = v; bestD = dd;
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
