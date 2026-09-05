import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, KEY_THROW_MODE, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from './GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from './Deployable';
import { GadgetVisualPool } from './GadgetVisuals';
import { ThrownGadgetManager } from './ThrownGadget';

/* ── tuning that stays inside this folder ─────────────────────────────────── */
/** Distance in front of the player where 'place' gadgets land. */
const PLACE_DISTANCE = 2.8;
/** Minimum distance between two deployables of the same kind. */
const PLACE_CLEARANCE = 1.4;
/** Interaction radius of the recover / defuse prompt. */
const RECOVER_RADIUS = 2.8;
/** Base seconds between two gadget uses (divided by `derived.useSpeedMul`). */
const USE_COOLDOWN = 0.55;
/** Turret rounds per second (damage per shot = GADGET_TURRET_DPS / this). */
const TURRET_ROF = 4;
/** Turret head turn rate (rad/s) and the cone it must be inside before firing. */
const TURRET_TURN_RATE = 3.4;
const TURRET_AIM_CONE = 0.22;
/** Turret re-target interval (s). */
const TURRET_RETARGET = 0.35;
/** Seconds between lure aggro pulses / fire-zone status refreshes. */
const ZONE_TICK = 0.5;
/** Maximum deployables alive at once (oldest of the same owner is evicted). */
const MAX_DEPLOYABLES = 40;
/** Half-height of the player capsule used for turret friendly-fire tests. */
const PLAYER_HALF_H = 0.9;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _d = new THREE.Vector3(), _e = new THREE.Vector3(), _fwd = new THREE.Vector3();
/** Scratch reserved for playerAlongRay (its callers pass _a / _b in). */
const _r0 = new THREE.Vector3(), _r1 = new THREE.Vector3(), _r2 = new THREE.Vector3();
const _r3 = new THREE.Vector3(), _r4 = new THREE.Vector3();
/** Scratch reserved for the pure geometry helpers (segment vs dome / smoke). */
const _g0 = new THREE.Vector3(), _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3();

function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 1000) / 1000, Math.round(v.y * 1000) / 1000, Math.round(v.z * 1000) / 1000];
}
function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Which peer a turret / mine hurt. */
type Victim = PeerId | 'local';

/**
 * Special gadgets (특수 가젯). Publishes `ctx.gadgets` and owns `GADGET_DEFS`.
 *
 * - `use(id, underhand)` consumes the matching `ItemDef` (`gadgetId`) and either applies an instant effect
 *   (은폐 장막 / 제세동기), throws a canister (돔 실드 / 유인 / 연막 / 화염) or places a deployable in front of
 *   the player (바리케이드 / 지뢰 / 포탑 / 점프대).
 * - World deployables are **host-authoritative**: only `ctx.isAuthority` simulates them. Clients send
 *   `gadq place/damage/recover/sync` and mirror the host's `gad spawn/update/remove/fire/sync`.
 * - Mines, fire zones and turrets have **no friend-or-foe check** — they hurt players and bugs alike.
 * - Query API for other folders: `findEnemyTarget`, `findDistraction`, `blocksProjectile`, `visionFactor`,
 *   `fireDamageAt`, `jumpPadAt`.
 */
export class GadgetSystem implements GameSystem, GadgetsRef {
  readonly name = 'gadgets';
  private ctx!: GameContext;
  private visuals!: GadgetVisualPool;
  private thrown!: ThrownGadgetManager;
  private readonly deployables: Deployable[] = [];
  private readonly byId = new Map<string, Deployable>();
  private readonly interactables = new Map<string, Interactable>();
  /** Ids this client asked the host to recover; the item is granted when the removal echoes back. */
  private readonly pendingRecover = new Set<string>();
  private readonly unsubs: Array<() => void> = [];
  private readonly itemDefCache = new Map<GadgetId, string>();
  private seq = 0;
  private netHooked = false;
  private useCooldown = 0;
  /** Over / under-hand throw toggle (B), shared with grenades. */
  private underhand = false;

  /* ═══════════════════════════ GameSystem ═══════════════════════════ */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.gadgets = this;
    this.visuals = new GadgetVisualPool();
    this.thrown = new ThrownGadgetManager(ctx, (gid, pos) => this.onThrownImpact(gid, pos));
    ctx.scene.add(this.visuals.group);
    this.visuals.warm();
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
      b.on('player:died', () => { /* deployables outlive their owner on purpose */ }),
      b.on('world:ready', () => {
        this.clear();
        const net = ctx.net;
        if (ctx.isMultiplayer && net && !net.isHost) net.send({ t: 'gadq', ev: 'sync' }, 'host');
      }),
    );
    this.ensureNetHooks();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    if (dt > 0 && this.useCooldown > 0) this.useCooldown = Math.max(0, this.useCooldown - dt);
    this.handleInput(ctx);
    this.thrown.update(dt);
    this.visuals.updatePulses(dt);

    const t = ctx.time;
    const authority = ctx.isAuthority;
    for (let i = this.deployables.length - 1; i >= 0; i--) {
      const d = this.deployables[i];
      if (d.removing) continue;
      if (dt > 0) {
        d.age += dt;
        if (d.padCooldown > 0) d.padCooldown -= dt;
        if (d.netCooldown > 0) d.netCooldown -= dt;
        this.updateArming(d);
        if (authority) {
          if (d.expires > 0 && t >= d.expires) { this.remove(d, 'expired'); continue; }
          this.simulate(d, dt, ctx);
        }
      }
      if (d.removing) continue;
      this.animate(d, t, dt);
    }
    if (dt > 0) this.updateLocalEffects(dt, ctx);
  }

  dispose(): void {
    this.clear();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.thrown.dispose();
    this.visuals.dispose();
    if (this.ctx?.gadgets === this) this.ctx.gadgets = null;
  }

  /* ═══════════════════════════ GadgetsRef ═══════════════════════════ */
  getDefs(): readonly GadgetDef[] { return GADGET_DEFS; }
  getDef(id: GadgetId): GadgetDef | undefined { return gadgetDef(id); }
  getDeployables(): readonly DeployableRef[] { return this.deployables; }

  use(id: GadgetId, underhand?: boolean): boolean {
    const ctx = this.ctx;
    const def = gadgetDef(id);
    if (!def) return false;
    const player = ctx.player;
    // usable from the quick bar with the inventory open, but never in the hub / menus / while paused
    if (!ctx.isGameplayPhase() || ctx.uiBlockers.has('menu')) return this.deny(null);
    if (!player || player.isDead || player.isDowned) return this.deny(null);
    if (this.useCooldown > 0) return false;

    // validate before consuming the item
    let target: { id: PeerId; position: THREE.Vector3; name: string } | null = null;
    if (def.use === 'place' && !this.placementSpot(def, _a)) return this.deny('설치할 공간이 없다');
    if (def.use === 'target') {
      target = this.findDownedAlly(def.radius);
      if (!target) return this.deny('근처에 쓰러진 아군이 없다');
    }
    if (!this.consumeItem(def)) return this.deny(`${def.name} 없음`);

    this.useCooldown = USE_COOLDOWN / Math.max(0.25, this.derived('useSpeedMul', 1));
    const over = underhand === undefined ? this.underhand : underhand;
    switch (def.use) {
      case 'self': this.useCloakVeil(def); break;
      case 'target': if (target) this.useDefib(def, target); break;
      case 'throw': this.throwGadget(def, over); break;
      case 'place': this.requestPlace(def, _a, player.yaw); break;
    }
    ctx.bus.emit('gadget:used', { id, position: player.position.clone() });
    return true;
  }

  findEnemyTarget(pos: THREE.Vector3, radius: number): DeployableRef | null {
    let best: Deployable | null = null, bestD = radius * radius;
    for (const d of this.deployables) {
      if (d.removing || !d.destructible || d.hp <= 0) continue;
      if (d.kind !== 'barricade' && d.kind !== 'turret' && d.kind !== 'lure' && d.kind !== 'domeShield') continue;
      const dist = d.position.distanceToSquared(pos);
      // lures are the loudest thing on the field: enemies prefer them
      const score = d.kind === 'lure' ? dist * 0.35 : dist;
      if (score <= bestD) { bestD = score; best = d; }
    }
    return best;
  }

  findDistraction(pos: THREE.Vector3, radius: number): DeployableRef | null {
    let best: Deployable | null = null, bestD = Infinity;
    for (const d of this.deployables) {
      if (d.removing || d.kind !== 'lure' || !d.armed) continue;
      const dist = d.position.distanceToSquared(pos);
      if (dist > radius * radius && dist > d.radius * d.radius) continue;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  blocksProjectile(from: THREE.Vector3, to: THREE.Vector3, fromEnemy: boolean): THREE.Vector3 | null {
    let bestT = Infinity;
    let hit: THREE.Vector3 | null = null;
    for (const d of this.deployables) {
      if (d.removing || !d.armed) continue;
      let t = -1;
      if (d.kind === 'barricade') t = this.segmentVsBarricade(d, from, to);
      else if (d.kind === 'domeShield' && fromEnemy) t = this.segmentVsDome(d, from, to);
      if (t >= 0 && t < bestT) {
        bestT = t;
        hit = (hit ?? new THREE.Vector3()).lerpVectors(from, to, t);
      }
    }
    return hit;
  }

  visionFactor(from: THREE.Vector3, to: THREE.Vector3): number {
    let factor = 1;
    for (const d of this.deployables) {
      if (d.removing || d.kind !== 'smoke') continue;
      const cover = this.segmentSphereCoverage(from, to, d.position, d.radius, d.radius * 0.9);
      if (cover > 0) factor *= 1 - 0.92 * cover;
    }
    return THREE.MathUtils.clamp(factor, 0, 1);
  }

  fireDamageAt(pos: THREE.Vector3): number {
    let dps = 0;
    for (const d of this.deployables) {
      if (d.removing || d.kind !== 'fire') continue;
      const dx = pos.x - d.position.x, dz = pos.z - d.position.z;
      if (dx * dx + dz * dz > d.radius * d.radius) continue;
      if (Math.abs(pos.y - d.position.y) > 3.5) continue;
      dps += GADGET_INCENDIARY_DPS;
    }
    return dps;
  }

  jumpPadAt(pos: THREE.Vector3): DeployableRef | null {
    for (const d of this.deployables) {
      if (d.removing || d.kind !== 'jumpPad' || !d.armed) continue;
      const dx = pos.x - d.position.x, dz = pos.z - d.position.z;
      if (dx * dx + dz * dz > JUMPPAD_TRIGGER_RADIUS * JUMPPAD_TRIGGER_RADIUS) continue;
      const dy = pos.y - d.position.y;
      if (dy < -0.8 || dy > 1.8) continue;
      return d;
    }
    return null;
  }

  recover(id: string): ItemInstance | null {
    const ctx = this.ctx;
    const d = this.byId.get(id);
    if (!d || d.removing) return null;
    const def = gadgetForKind(d.kind);
    if (!def || def.recoverTime <= 0) return null;
    if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
      // client: ask the host; the item is granted when `gad remove {recovered}` echoes back
      this.pendingRecover.add(id);
      ctx.net.send({ t: 'gadq', ev: 'recover', id }, 'host');
      return null;
    }
    const item = this.grantRecovered(d);
    this.remove(d, 'recovered');
    return item;
  }

  clear(): void {
    for (let i = this.deployables.length - 1; i >= 0; i--) this.removeLocal(this.deployables[i], 'expired');
    this.pendingRecover.clear();
    this.thrown.clear();
  }

  /* ═══════════════════════════ input ═══════════════════════════ */
  private handleInput(ctx: GameContext): void {
    if (!ctx.isGameplayActive()) return;
    if (ctx.input.wasPressed(KEY_THROW_MODE)) {
      this.underhand = !this.underhand;
      ctx.bus.emit('gadget:throwModeChanged', { underhand: this.underhand });
      ctx.bus.emit('ui:notify', { text: this.underhand ? '언더 스로' : '오버 스로', kind: 'info', duration: 1 });
      ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.4 });
    }
  }

  /* ═══════════════════════════ use paths ═══════════════════════════ */
  private useCloakVeil(def: GadgetDef): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    if (typeof p.setCloak === 'function') p.setCloak(def.duration, 'gadget');
    this.visuals.pulse(p.position, def.color, 0.6, def.radius, 0.8);
    ctx.bus.emit('audio:play', { id: 'gadget_cloak', position: p.position, volume: 0.8 });
    ctx.bus.emit('ui:notify', { text: `은폐 ${Math.round(def.duration)}초`, kind: 'success', duration: 1.6 });

    // Share the cloak with squadmates standing inside the veil. Each recipient applies it locally on `buff`.
    const net = ctx.net;
    if (!net?.inSession) return;
    const shareSq = GADGET_CLOAK_SHARE_RADIUS * GADGET_CLOAK_SHARE_RADIUS;
    let shared = 0;
    for (const r of net.getRemotePlayers()) {
      if (!r.connected || r.isDead) continue;
      if (r.position.distanceToSquared(p.position) > shareSq) continue;
      const msg: BuffMessage = { t: 'buff', kind: 'cloak', amount: 0, duration: def.duration, by: net.playerName };
      net.send(msg, r.id);
      shared++;
    }
    if (shared > 0) {
      ctx.bus.emit('ui:notify', { text: `아군 ${shared}명 은폐`, kind: 'success', duration: 1.6 });
    }
  }

  private useDefib(def: GadgetDef, target: { id: PeerId; position: THREE.Vector3; name: string }): void {
    const ctx = this.ctx;
    const net = ctx.net;
    const msg: BuffMessage = {
      t: 'buff', kind: 'revive',
      amount: ctx.player?.maxHp ?? 100,
      duration: 0,
      by: net?.playerName ?? '아군',
    };
    net?.send(msg, target.id);
    this.visuals.pulse(target.position, def.color, 0.4, 3.2, 0.6);
    ctx.bus.emit('audio:play', { id: 'gadget_defib', position: target.position, volume: 0.9 });
    ctx.bus.emit('ui:notify', { text: `${target.name} 부활`, kind: 'success', duration: 2 });
    ctx.bus.emit('chat:post', { text: `${target.name} 을(를) 일으켰다`, kind: 'system' });
  }

  private throwGadget(def: GadgetDef, underhand: boolean): void {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return;
    const range = this.derived('throwRangeMul', 1);
    // use the camera aim ray when the player exposes it (pitch included), else the horizontal forward
    const host = p as unknown as Partial<PlayerWeaponHost>;
    if (typeof host.getAimRay === 'function') { host.getAimRay(_a, _b); }
    else { p.getEyePosition(_a); p.getForward(_b); }
    _b.normalize();
    _a.addScaledVector(_b, 0.6);
    const speed = (underhand ? 8 : 17) * range;
    _c.copy(_b).multiplyScalar(speed).addScaledVector(p.velocity, 0.5);
    _c.y += underhand ? 2.4 : 3.5;
    this.thrown.throw(def.id, def.color, _a, _c);
    ctx.bus.emit('audio:play', { id: 'grenade_throw', position: _a, volume: 0.65 });
  }

  private onThrownImpact(gid: GadgetId, pos: THREE.Vector3): void {
    const def = gadgetDef(gid);
    if (!def || !def.deployable) return;
    const yaw = this.ctx.player?.yaw ?? 0;
    this.requestPlace(def, pos, yaw);
  }

  /** Authority spawns straight away; clients ask the host and wait for `gad spawn`. */
  private requestPlace(def: GadgetDef, position: THREE.Vector3, yaw: number): void {
    const ctx = this.ctx;
    if (!def.deployable) return;
    if (!ctx.isAuthority && ctx.isMultiplayer && ctx.net) {
      ctx.net.send({ t: 'gadq', ev: 'place', gadget: def.id, p: toTuple(position), yaw }, 'host');
      return;
    }
    this.spawnDeployable(this.nextId(), def, ctx.net?.localId ?? 'local', position, yaw, null);
  }

  /* ═══════════════════════════ spawn / remove ═══════════════════════════ */
  private nextId(): string {
    return `${this.ctx.net?.localId ?? 'sp'}-g${++this.seq}`;
  }

  /**
   * @param wire non-null when this is a replica built from a `gad spawn` / `gad sync` broadcast
   *   (hp / armed / ttl come from the host instead of the definition).
   */
  private spawnDeployable(
    id: string, def: GadgetDef, owner: PeerId | 'local', position: THREE.Vector3, yaw: number, wire: DeployableWire | null,
  ): Deployable | null {
    const kind = def.deployable;
    if (!kind || this.byId.has(id)) return null;
    const ctx = this.ctx;
    while (this.deployables.length >= MAX_DEPLOYABLES) this.removeLocal(this.deployables[0], 'expired');

    const hp = wire ? wire.hp : def.hp;
    const maxHp = wire ? wire.maxHp : def.hp;
    const armed = wire ? wire.armed : !(kind === 'mine' || kind === 'domeShield');
    const ttl = wire ? wire.ttl : def.duration;
    const expires = ttl > 0 ? ctx.time + ttl : 0;

    const visual = this.visuals.acquire(kind, def.color, def.radius);
    const d = new Deployable(id, kind, owner, def.id, def.radius, hp, maxHp, armed, expires, visual);
    d.position.copy(position);
    d.position.y = this.groundY(position);
    d.yaw = yaw;
    d.headYaw = yaw;
    d.onDamage = (dep, amount, from) => this.onDeployableDamage(dep, amount, from);
    visual.root.position.copy(d.position);
    visual.root.rotation.y = yaw;

    this.deployables.push(d);
    this.byId.set(id, d);
    if (def.recoverTime > 0) {
      const it = this.makeInteractable(d, def);
      this.interactables.set(id, it);
      ctx.interactables.register(it);
    }
    ctx.bus.emit('gadget:deployed', { id, kind, position: d.position, owner: String(owner) });
    ctx.bus.emit('audio:play', { id: kind === 'mine' ? 'mine_place' : 'gadget_deploy', position: d.position, volume: 0.8 });
    this.visuals.pulse(d.position, def.color, 0.3, Math.min(def.radius, 4), 0.45);
    if (ctx.isAuthority) this.broadcast({ t: 'gad', ev: 'spawn', d: this.wireOf(d) }, 'others');
    return d;
  }

  /** Removes locally and, on the authority, tells everyone. */
  private remove(d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void {
    if (d.removing) return;
    if (this.ctx.isAuthority) this.broadcast({ t: 'gad', ev: 'remove', id: d.id, reason }, 'others');
    this.removeLocal(d, reason);
  }

  private removeLocal(d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void {
    if (d.removing) return;
    d.removing = true;
    const i = this.deployables.indexOf(d);
    if (i >= 0) this.deployables.splice(i, 1);
    this.byId.delete(d.id);
    const it = this.interactables.get(d.id);
    if (it) { this.ctx.interactables.unregister(it.id); this.interactables.delete(d.id); }
    this.visuals.release(d.visual);
    this.pendingRecover.delete(d.id);
    this.ctx.bus.emit('gadget:removed', { id: d.id, kind: d.kind, reason });
  }

  private makeInteractable(d: Deployable, def: GadgetDef): Interactable {
    const sys = this;
    const prompt = d.kind === 'mine' ? '지뢰 해체' : `${def.name} 회수`;
    return {
      id: `gadget:${d.id}`,
      position: d.position,
      radius: RECOVER_RADIUS,
      getPrompt: () => prompt,
      canInteract: () => sys.ctx.isGameplayActive() && !d.removing && !sys.pendingRecover.has(d.id),
      interact: () => { sys.recover(d.id); },
      get holdTime(): number {
        return (def.recoverTime || GADGET_DEFUSE_TIME) / Math.max(0.25, sys.derived('interactSpeedMul', 1));
      },
    };
  }

  /** Puts the recovered item in the local bag (barricade / turret / jump pad only). */
  private grantRecovered(d: Deployable): ItemInstance | null {
    if (!isRecoverable(d.kind)) return null;
    const defId = this.itemDefIdFor(d.gadgetId);
    const loot = this.ctx.loot;
    if (!defId || !loot) return null;
    const item = loot.createItem(defId, 1);
    const ok = this.ctx.inventory?.tryAddItem(item) ?? false;
    if (!ok) return null;   // inventory already emitted `inventory:full`; the deployable is removed anyway
    this.ctx.bus.emit('gadget:recovered', { id: d.id, item });
    this.ctx.bus.emit('audio:play', { id: 'gadget_recover', position: d.position, volume: 0.7 });
    return item;
  }

  /* ═══════════════════════════ simulation (authority) ═══════════════════════════ */
  private updateArming(d: Deployable): void {
    if (d.armed) return;
    const need = d.kind === 'mine' ? GADGET_MINE_ARM_TIME : DOME_UNFOLD_TIME;
    if (d.age < need) return;
    d.armed = true;
    if (d.kind === 'mine') this.ctx.bus.emit('audio:play', { id: 'mine_arm', position: d.position, volume: 0.7 });
    if (this.ctx.isAuthority) this.broadcast({ t: 'gad', ev: 'update', id: d.id, hp: d.hp, armed: true }, 'others');
  }

  private simulate(d: Deployable, dt: number, ctx: GameContext): void {
    switch (d.kind) {
      case 'mine': if (d.armed) this.updateMine(d, ctx); break;
      case 'turret': this.updateTurret(d, dt, ctx); break;
      case 'fire': this.updateFireZone(d, dt, ctx); break;
      case 'lure': this.updateLure(d, dt, ctx); break;
      default: break;
    }
  }

  private updateMine(d: Deployable, ctx: GameContext): void {
    // friend or foe: anything that walks close enough sets it off
    for (const e of this.enemiesNear(d.position, MINE_TRIGGER_RADIUS)) {
      if (e.isDead) continue;
      this.explodeMine(d, ctx);
      return;
    }
    const p = ctx.player;
    if (p && !p.isDead && p.position.distanceTo(d.position) <= MINE_TRIGGER_RADIUS + PLAYER_RADIUS) { this.explodeMine(d, ctx); return; }
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (r.isDead || r.stale) continue;
      if (r.position.distanceTo(d.position) <= MINE_TRIGGER_RADIUS + PLAYER_RADIUS) { this.explodeMine(d, ctx); return; }
    }
  }

  private explodeMine(d: Deployable, ctx: GameContext): void {
    const radius = d.radius;
    const dmg = GADGET_MINE_DAMAGE;
    const ownerName = ctx.net?.getLobbyPlayer(String(d.owner))?.name ?? undefined;
    this.damageEnemies(d.position, radius, dmg, ownerName);
    // players (no friend-or-foe check, the owner included)
    const p = ctx.player;
    if (p && !p.isDead) {
      const dist = p.position.distanceTo(d.position);
      if (dist < radius) p.takeDamage(dmg * (1 - dist / radius) * 0.85, d.position.clone());
    }
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (r.isDead || r.stale) continue;
      const dist = r.position.distanceTo(d.position);
      if (dist < radius) this.hurtRemote(r.id, dmg * (1 - dist / radius) * 0.85, d.position);
    }
    this.blastFx(d.position, radius);
    this.remove(d, 'destroyed');
  }

  private updateTurret(d: Deployable, dt: number, ctx: GameContext): void {
    d.fireTimer -= dt;
    d.tickTimer -= dt;
    let target: EnemyRef | null = null;
    if (d.tickTimer <= 0 || d.targetId === null) {
      d.tickTimer = TURRET_RETARGET;
      let bestD = Infinity;
      for (const e of this.enemiesNear(d.position, d.radius)) {
        if (e.isDead) continue;
        const dist = e.position.distanceToSquared(d.position);
        if (dist < bestD) { bestD = dist; target = e; }
      }
      d.targetId = target?.id ?? null;
    } else {
      target = this.enemyById(d.targetId);
      if (!target || target.isDead || target.position.distanceTo(d.position) > d.radius) { d.targetId = null; target = null; }
    }
    if (!target) return;

    _a.copy(target.position); _a.y += target.height * 0.5;
    _b.copy(d.position); _b.y += 0.75;
    _c.subVectors(_a, _b);
    const want = Math.atan2(-_c.x, -_c.z);
    const delta = angleDelta(d.headYaw, want);
    const step = TURRET_TURN_RATE * dt;
    d.headYaw += THREE.MathUtils.clamp(delta, -step, step);
    if (Math.abs(delta) > TURRET_AIM_CONE || d.fireTimer > 0) return;

    d.fireTimer = 1 / TURRET_ROF;
    const dmg = GADGET_TURRET_DPS / TURRET_ROF;
    // friendly fire: whoever stands in the firing line eats the burst instead
    const victim = this.playerAlongRay(_b, _a);
    if (victim) this.hurtPlayer(victim, dmg, _b);
    else target.takeDamage(dmg, _a.clone(), _c.clone().normalize());
    this.visuals.flash(d.visual);
    this.broadcast({ t: 'gad', ev: 'fire', id: d.id, target: toTuple(_a) }, 'others');
    ctx.bus.emit('audio:play', { id: 'turret_fire', position: d.position, volume: 0.55 });
  }

  private updateFireZone(d: Deployable, dt: number, ctx: GameContext): void {
    d.tickTimer -= dt;
    if (d.tickTimer > 0) return;
    d.tickTimer = ZONE_TICK;
    const enemies = ctx.enemies;
    for (const e of this.enemiesNear(d.position, d.radius)) {
      if (e.isDead) continue;
      if (enemies && typeof enemies.applyStatus === 'function') enemies.applyStatus(e.id, 'burning', GADGET_INCENDIARY_DPS, ZONE_TICK * 2.4);
      else e.takeDamage(GADGET_INCENDIARY_DPS * ZONE_TICK);
    }
    // remote players burn too (no friend-or-foe check); the local player is handled by updateLocalEffects on every client
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (r.isDead || r.stale) continue;
      const dx = r.position.x - d.position.x, dz = r.position.z - d.position.z;
      if (dx * dx + dz * dz > d.radius * d.radius) continue;
      this.hurtRemote(r.id, GADGET_INCENDIARY_DPS * ZONE_TICK, d.position);
    }
  }

  private updateLure(d: Deployable, dt: number, ctx: GameContext): void {
    d.tickTimer -= dt;
    if (d.tickTimer > 0) return;
    d.tickTimer = ZONE_TICK;
    const enemies = ctx.enemies;
    if (enemies && typeof enemies.addDistraction === 'function') {
      enemies.addDistraction(d.position, Math.max(d.radius, GADGET_LURE_RADIUS), ZONE_TICK * 2.2, 0.85);
    }
    ctx.bus.emit('audio:play', { id: 'lure_beep', position: d.position, volume: 0.4 });
  }

  /* ═══════════════════════════ local (every client) ═══════════════════════════ */
  private updateLocalEffects(dt: number, ctx: GameContext): void {
    const p = ctx.player;
    if (!p || p.isDead || !ctx.isGameplayPhase()) return;
    // fire zones burn whoever stands in them, friend or foe. Each client applies it to its own player so the
    // effect stays responsive and does not depend on a `dmg` round trip.
    const dps = this.fireDamageAt(p.position);
    if (dps > 0 && typeof p.setBurning === 'function') p.setBurning(dps, 1.2);

    const pad = this.jumpPadAt(p.position) as Deployable | null;
    if (pad && pad.padCooldown <= 0 && typeof p.applyImpulse === 'function') {
      pad.padCooldown = 0.7;
      _d.set(0, GADGET_JUMPPAD_IMPULSE, 0);
      const speed = Math.hypot(p.velocity.x, p.velocity.z);
      if (p.isSprinting || speed > 3.5) {
        _e.set(p.velocity.x, 0, p.velocity.z);
        if (_e.lengthSq() < 0.01) p.getForward(_e);
        _e.normalize().multiplyScalar(GADGET_JUMPPAD_FORWARD);
        _d.add(_e);
      }
      p.applyImpulse(_d);
      this.visuals.pulse(pad.position, gadgetDef('jumpPad')?.color ?? '#5fd7ff', 0.6, 3, 0.4);
      ctx.bus.emit('audio:play', { id: 'jumppad', position: pad.position, volume: 0.9 });
    }
  }

  /* ═══════════════════════════ animation ═══════════════════════════ */
  private animate(d: Deployable, t: number, dt: number): void {
    const v = d.visual;
    v.root.position.copy(d.position);
    v.root.rotation.y = d.yaw;
    if (v.head) v.head.rotation.y = d.headYaw - d.yaw;
    const def = gadgetForKind(d.kind);
    const life = d.expires > 0 && def && def.duration > 0 ? THREE.MathUtils.clamp((d.expires - t) / def.duration, 0, 1) : 1;
    this.visuals.animate(v, t, dt, d.armed, d.hpRatio, life);
  }

  /* ═══════════════════════════ damage ═══════════════════════════ */
  private onDeployableDamage(d: Deployable, amount: number, from?: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx.isAuthority) {
      if (ctx.isMultiplayer && ctx.net) ctx.net.send({ t: 'gadq', ev: 'damage', id: d.id, dmg: amount }, 'host');
      return;
    }
    d.hp = Math.max(0, d.hp - amount);
    ctx.bus.emit('gadget:damaged', { id: d.id, hp: d.hp, maxHp: d.maxHp });
    if (d.kind === 'domeShield' || d.kind === 'barricade') {
      ctx.bus.emit('audio:play', { id: 'shield_hit', position: from ?? d.position, volume: 0.5 });
    }
    if (d.hp <= 0) {
      if (d.kind === 'mine') { this.explodeMine(d, ctx); return; }
      this.blastFx(d.position, Math.min(d.radius, 3), 0.4);
      ctx.bus.emit('audio:play', { id: 'gadget_break', position: d.position, volume: 0.8 });
      this.remove(d, 'destroyed');
      return;
    }
    if (d.netCooldown <= 0) {
      d.netCooldown = 0.2;
      this.broadcast({ t: 'gad', ev: 'update', id: d.id, hp: d.hp, armed: d.armed }, 'others');
    }
  }

  private damageEnemies(center: THREE.Vector3, radius: number, damage: number, by?: string): void {
    const enemies = this.ctx.enemies;
    if (!enemies) return;
    if (typeof enemies.applyAreaDamage === 'function') enemies.applyAreaDamage(center, radius, damage, by);
    else enemies.applyExplosion(center, radius, damage);
  }

  private hurtPlayer(victim: Victim, amount: number, from: THREE.Vector3): void {
    if (victim === 'local') this.ctx.player?.takeDamage(amount, from.clone());
    else this.hurtRemote(victim, amount, from);
  }

  private hurtRemote(peer: PeerId, amount: number, from: THREE.Vector3): void {
    const net = this.ctx.net;
    if (!net || !this.ctx.isMultiplayer) return;
    net.send({ t: 'dmg', amount, from: toTuple(from) }, peer);
  }

  private blastFx(position: THREE.Vector3, radius: number, shake = 1): void {
    const ctx = this.ctx;
    this.visuals.pulse(position, '#ffb14a', 0.5, radius * 1.2, 0.55);
    this.visuals.pulse(position, '#ff5a3c', 0.3, radius * 0.7, 0.35);
    ctx.bus.emit('audio:play', { id: 'explosion', position, volume: 0.9 });
    const p = ctx.player;
    if (p) {
      const dist = p.position.distanceTo(position);
      const k = THREE.MathUtils.clamp(1 - dist / 26, 0, 1) * shake;
      if (k > 0) ctx.bus.emit('camera:shake', { intensity: 0.2 + k * 0.7, duration: 0.4 });
    }
  }

  /* ═══════════════════════════ geometry helpers ═══════════════════════════ */
  /** Segment (from→to) vs the barricade box. Returns the parametric hit t in [0,1], or -1. */
  private segmentVsBarricade(d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number {
    const cos = Math.cos(d.yaw), sin = Math.sin(d.yaw);
    const cy = d.position.y + BARRICADE_HALF.y;
    // world → local (inverse Y rotation)
    const ox = from.x - d.position.x, oz = from.z - d.position.z;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const lox = ox * cos - oz * sin, loz = ox * sin + oz * cos;
    const ldx = dx * cos - dz * sin, ldz = dx * sin + dz * cos;
    const loy = from.y - cy;
    let tMin = 0, tMax = 1;
    const slab = (o: number, dd: number, half: number): boolean => {
      if (Math.abs(dd) < 1e-6) return o >= -half && o <= half;
      let t1 = (-half - o) / dd, t2 = (half - o) / dd;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
      return tMin <= tMax;
    };
    if (!slab(lox, ldx, BARRICADE_HALF.x)) return -1;
    if (!slab(loy, dy, BARRICADE_HALF.y)) return -1;
    if (!slab(loz, ldz, BARRICADE_HALF.z)) return -1;
    return tMin >= 0 ? tMin : -1;
  }

  /** Segment vs the dome hemisphere. Shots that start inside pass out freely. */
  private segmentVsDome(d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number {
    _g0.copy(d.position);
    const r = d.radius;
    _g1.subVectors(from, _g0);
    if (_g1.lengthSq() <= r * r && from.y >= _g0.y) return -1;   // shooter inside the dome
    _g2.subVectors(to, from);
    const a = _g2.lengthSq();
    if (a < 1e-6) return -1;
    const b = 2 * _g1.dot(_g2);
    const cc = _g1.lengthSq() - r * r;
    const disc = b * b - 4 * a * cc;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
      if (t < 0 || t > 1) continue;
      const y = from.y + _g2.y * t;
      if (y >= _g0.y - 0.1) return t;
    }
    return -1;
  }

  /** 0..1 fraction of the segment swallowed by a sphere (smoke). */
  private segmentSphereCoverage(from: THREE.Vector3, to: THREE.Vector3, center: THREE.Vector3, radius: number, height: number): number {
    _g0.subVectors(to, from);
    const len = _g0.length();
    if (len < 1e-4) return 0;
    _g0.multiplyScalar(1 / len);
    _g1.subVectors(center, from);
    const proj = THREE.MathUtils.clamp(_g1.dot(_g0), 0, len);
    _g2.copy(from).addScaledVector(_g0, proj);
    const dx = _g2.x - center.x, dz = _g2.z - center.z;
    const dyRaw = _g2.y - (center.y + height * 0.5);
    const flat = Math.sqrt(dx * dx + dz * dz);
    if (flat > radius || Math.abs(dyRaw) > height) return 0;
    const near = 1 - flat / radius;
    // fully inside the cloud → total cover; grazing → partial
    return THREE.MathUtils.clamp(near, 0, 1);
  }

  /**
   * Nearest player (local or remote) whose capsule the segment crosses before reaching `to`.
   * Uses its own scratch vectors: callers (the turret) pass `_a` / `_b` in, so touching those here would
   * silently destroy the caller's ray.
   */
  private playerAlongRay(from: THREE.Vector3, to: THREE.Vector3): Victim | null {
    _r0.copy(from); _r1.copy(to);
    _r2.subVectors(_r1, _r0);
    const len = _r2.length();
    if (len < 0.01) return null;
    _r2.multiplyScalar(1 / len);
    let best: Victim | null = null, bestT = len;
    const test = (pos: THREE.Vector3, id: Victim): void => {
      _r3.copy(pos); _r3.y += PLAYER_HALF_H;
      _r4.subVectors(_r3, _r0);
      const t = _r4.dot(_r2);
      if (t <= 0.6 || t >= bestT) return;
      _r4.copy(_r0).addScaledVector(_r2, t);
      if (_r4.distanceTo(_r3) > PLAYER_RADIUS + 0.15) return;
      bestT = t; best = id;
    };
    const ctx = this.ctx;
    if (ctx.player && !ctx.player.isDead) test(ctx.player.position, 'local');
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (r.isDead || r.stale) continue;
      test(r.position, r.id);
    }
    return best;
  }

  /* ═══════════════════════════ placement / items ═══════════════════════════ */
  private groundY(position: THREE.Vector3): number {
    const world = this.ctx.world;
    if (world && world.ready) return world.getHeightAt(position.x, position.z);
    const interior = this.ctx.player?.interior;
    if (interior) return interior.getFloorAt(position.x, position.z);
    return position.y;
  }

  /** Spot in front of the player for a 'place' gadget. false when it is blocked / off the map. */
  private placementSpot(def: GadgetDef, out: THREE.Vector3): boolean {
    const ctx = this.ctx;
    const p = ctx.player;
    const world = ctx.world;
    if (!p || !world || !world.ready) return false;
    p.getForward(_fwd);
    out.copy(p.position).addScaledVector(_fwd, PLACE_DISTANCE);
    if (!world.isInsideBounds(out.x, out.z)) return false;
    out.y = world.getHeightAt(out.x, out.z);
    // do not stack deployables on top of each other
    for (const d of this.deployables) {
      if (d.removing) continue;
      const clearance = d.kind === 'barricade' ? PLACE_CLEARANCE * 2 : PLACE_CLEARANCE;
      if (d.position.distanceTo(out) < clearance) return false;
    }
    // too steep? (slope guard so barricades / turrets do not float)
    world.getNormalAt(out.x, out.z, _b);
    if (_b.y < 0.72) return false;
    void def;
    return true;
  }

  /** Item def id whose `gadgetId` matches (items/ owns the actual definitions). */
  private itemDefIdFor(id: GadgetId): string | null {
    const cached = this.itemDefCache.get(id);
    if (cached) return cached;
    const loot = this.ctx.loot;
    if (!loot) return null;
    for (const def of loot.getAllItemDefs()) {
      if (def.gadgetId === id) { this.itemDefCache.set(id, def.id); return def.id; }
    }
    return null;
  }

  /**
   * Takes one unit out of the bag. When items/ has not published a gadget item yet (parallel development),
   * the gadget is allowed through so the system stays testable.
   */
  private consumeItem(def: GadgetDef): boolean {
    const inv = this.ctx.inventory;
    const defId = this.itemDefIdFor(def.id);
    if (!inv || !defId) return true;
    if (typeof inv.consumeDef === 'function') return inv.consumeDef(defId, 1);
    return inv.consumeWhere((d) => d.id === defId, 1) > 0;
  }

  private findDownedAlly(radius: number): { id: PeerId; position: THREE.Vector3; name: string } | null {
    const ctx = this.ctx;
    const p = ctx.player;
    if (!p) return null;
    let best: { id: PeerId; position: THREE.Vector3; name: string } | null = null;
    let bestD = radius * radius;
    for (const r of ctx.net?.getRemotePlayers() ?? []) {
      if (!r.isDowned || r.stale) continue;
      const dist = r.position.distanceToSquared(p.position);
      if (dist <= bestD) { bestD = dist; best = { id: r.id, position: r.position, name: r.name }; }
    }
    return best;
  }

  private derived(key: 'useSpeedMul' | 'interactSpeedMul' | 'throwRangeMul', fallback: number): number {
    const v = this.ctx.progression?.derived?.[key];
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : fallback;
  }

  private deny(text: string | null): false {
    if (text) {
      this.ctx.bus.emit('ui:notify', { text, kind: 'warning', duration: 1.4 });
      this.ctx.bus.emit('audio:play', { id: 'ui_deny', volume: 0.5 });
    }
    return false;
  }

  /* ═══════════════════════════ enemy helpers ═══════════════════════════ */
  private enemiesNear(pos: THREE.Vector3, radius: number): readonly EnemyRef[] {
    const enemies = this.ctx.enemies;
    if (!enemies) return EMPTY_ENEMIES;
    if (typeof enemies.queryNear === 'function') return enemies.queryNear(pos, radius);
    const out: EnemyRef[] = [];
    const r2 = radius * radius;
    for (const e of enemies.getEnemies()) {
      if (!e.isDead && e.position.distanceToSquared(pos) <= r2) out.push(e);
    }
    return out;
  }

  private enemyById(id: number): EnemyRef | null {
    const enemies = this.ctx.enemies;
    if (!enemies) return null;
    for (const e of enemies.getEnemies()) if (e.id === id) return e;
    return null;
  }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void {
    const net = this.ctx.net;
    if (!net || this.netHooked) return;
    this.netHooked = true;
    this.unsubs.push(
      net.onMessage('gad', (m, from) => this.onGadgetMessage(m, from)),
      net.onMessage('gadq', (m, from) => this.onGadgetRequest(m, from)),
      net.onMessage('buff', (m, from) => this.onBuff(m, from)),
      net.onMessage('flow', (m, from) => this.onFlow(m, from)),
    );
  }

  private broadcast(msg: GadgetMessage, to: 'all' | 'others' | PeerId): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.net) return;
    ctx.net.send(msg, to);
  }

  private wireOf(d: Deployable): DeployableWire {
    return {
      id: d.id,
      kind: d.kind,
      owner: String(d.owner),
      p: toTuple(d.position),
      yaw: Math.round(d.yaw * 1000) / 1000,
      hp: Math.round(d.hp),
      maxHp: d.maxHp,
      armed: d.armed,
      ttl: d.expires > 0 ? Math.max(0, Math.round((d.expires - this.ctx.time) * 100) / 100) : 0,
    };
  }

  private spawnFromWire(w: DeployableWire): void {
    const def = gadgetForKind(w.kind);
    if (!def) return;
    _a.set(w.p[0], w.p[1], w.p[2]);
    this.spawnDeployable(w.id, def, w.owner, _a, w.yaw, w);
  }

  /** Host → clients. */
  private onGadgetMessage(m: GadgetMessage, from: PeerId): void {
    const ctx = this.ctx;
    const net = ctx.net;
    if (!net || !ctx.isMultiplayer || ctx.isAuthority) return;
    const hostId = net.lobby?.hostId;
    if (hostId && from !== hostId) return;
    switch (m.ev) {
      case 'spawn':
        this.spawnFromWire(m.d);
        break;
      case 'update': {
        const d = this.byId.get(m.id);
        if (!d) return;
        if (d.hp !== m.hp) ctx.bus.emit('gadget:damaged', { id: d.id, hp: m.hp, maxHp: d.maxHp });
        d.hp = m.hp;
        d.armed = m.armed;
        break;
      }
      case 'remove': {
        const d = this.byId.get(m.id);
        if (!d) { this.pendingRecover.delete(m.id); return; }
        if (m.reason === 'destroyed') {
          if (d.kind === 'mine') this.blastFx(d.position, d.radius);
          else this.blastFx(d.position, Math.min(d.radius, 3), 0.4);
        }
        // our own recover request came through → take the item now
        if (m.reason === 'recovered' && this.pendingRecover.has(m.id)) this.grantRecovered(d);
        this.removeLocal(d, m.reason);
        break;
      }
      case 'fire': {
        const d = this.byId.get(m.id);
        if (!d) return;
        _a.set(m.target[0], m.target[1], m.target[2]);
        _b.copy(d.position); _b.y += 0.75;
        _c.subVectors(_a, _b);
        d.headYaw = Math.atan2(-_c.x, -_c.z);
        this.visuals.flash(d.visual);
        ctx.bus.emit('audio:play', { id: 'turret_fire', position: d.position, volume: 0.5 });
        break;
      }
      case 'sync':
        this.clear();
        for (const w of m.items) this.spawnFromWire(w);
        break;
    }
  }

  /** Clients → host. */
  private onGadgetRequest(m: GadgetRequest, from: PeerId): void {
    const ctx = this.ctx;
    if (!ctx.isMultiplayer || !ctx.isAuthority) return;
    switch (m.ev) {
      case 'place': {
        const def = gadgetDef(m.gadget);
        if (!def || !def.deployable) return;
        _a.set(m.p[0], m.p[1], m.p[2]);
        this.spawnDeployable(`${from}-g${++this.seq}`, def, from, _a, m.yaw, null);
        break;
      }
      case 'damage': {
        const d = this.byId.get(m.id);
        if (!d) return;
        this.onDeployableDamage(d, Math.max(0, Math.min(m.dmg, d.maxHp)), undefined);
        break;
      }
      case 'recover': {
        const d = this.byId.get(m.id);
        if (!d) return;
        const def = gadgetForKind(d.kind);
        if (!def || def.recoverTime <= 0) return;
        this.remove(d, 'recovered');   // the requester grants itself the item on the echo
        break;
      }
      case 'sync':
        this.broadcast({ t: 'gad', ev: 'sync', items: this.deployables.map((d) => this.wireOf(d)) }, from);
        break;
    }
  }

  /**
   * `buff` receiver. Gadgets own 'revive' (제세동기) and 'cloak' (은폐 장막); 'heal' / 'boost' belong to
   * implants/, so they are ignored here to avoid applying the same buff twice.
   */
  private onBuff(m: BuffMessage, from: PeerId): void {
    if (m.kind === 'cloak') {
      const self = this.ctx.player;
      if (!self || self.isDead || typeof self.setCloak !== 'function') return;
      self.setCloak(m.duration, 'gadget');
      const def = gadgetDef('cloakVeil');
      this.visuals.pulse(self.position, def?.color ?? '#9fd8ff', 0.6, def?.radius ?? 6, 0.8);
      this.ctx.bus.emit('audio:play', { id: 'gadget_cloak', position: self.position, volume: 0.8 });
      this.ctx.bus.emit('ui:notify', { text: `${m.by} 의 은폐 장막`, kind: 'success', duration: 1.8 });
      void from;
      return;
    }
    if (m.kind !== 'revive') return;
    const p = this.ctx.player;
    if (!p || !p.isDowned || typeof p.revive !== 'function') return;
    p.revive(m.by);
    this.visuals.pulse(p.position, gadgetDef('defib')?.color ?? '#ff5f8f', 0.4, 3.2, 0.6);
    this.ctx.bus.emit('audio:play', { id: 'gadget_defib', position: p.position, volume: 0.9 });
    this.ctx.bus.emit('ui:notify', { text: `${m.by} 이(가) 일으켜 세웠다`, kind: 'success', duration: 2.5 });
    void from;
  }

  private onFlow(m: FlowMessage, from: PeerId): void {
    if (m.ev === 'rejoined' && this.ctx.isAuthority && this.ctx.isMultiplayer) {
      this.broadcast({ t: 'gad', ev: 'sync', items: this.deployables.map((d) => this.wireOf(d)) }, from);
    }
  }
}

const EMPTY_ENEMIES: readonly EnemyRef[] = [];
