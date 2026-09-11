import * as THREE from 'three';
import {
  GADGET_DEFUSE_TIME, GADGET_INCENDIARY_DPS, GADGET_JUMPPAD_FORWARD, GADGET_JUMPPAD_IMPULSE,
  GADGET_CLOAK_SHARE_RADIUS, GADGET_LURE_RADIUS, GADGET_MINE_ARM_TIME, GADGET_MINE_DAMAGE, GADGET_TURRET_DPS, JUMP_PAD_RETRIGGER_S, Keys, PLAYER_RADIUS,
  type BuffMessage, type DeployableKind, type DeployableRef, type EnemyRef, type FlowMessage, type GadgetDef,
  type GadgetId, type GadgetMessage, type GadgetRequest, type GameContext, type GameSystem, type GadgetsRef,
  type Interactable, type ItemInstance, type DeployableWire, type PeerId, type PlayerWeaponHost, type Vec3Tuple,
} from '@/shared';
import { GADGET_DEFS, gadgetDef, gadgetForKind, isRecoverable } from './GadgetDefs';
import { Deployable, BARRICADE_HALF, DOME_UNFOLD_TIME, JUMPPAD_TRIGGER_RADIUS, MINE_TRIGGER_RADIUS } from './Deployable';
import { GadgetVisualPool } from './GadgetVisuals';
import { ThrownGadgetManager } from './ThrownGadget';

import { EMPTY_ENEMIES, MAX_DEPLOYABLES, PLACE_CLEARANCE, PLACE_DISTANCE, PLAYER_HALF_H, RECOVER_RADIUS, TURRET_AIM_CONE, TURRET_RETARGET, TURRET_ROF, TURRET_TURN_RATE, USE_COOLDOWN, type Victim, ZONE_TICK, _a, _b, _c, _d, _e, _fwd, _g0, _g1, _g2, _r0, _r1, _r2, _r3, _r4, angleDelta, toTuple } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Deploy from './parts/Deploy';
import * as Sim from './parts/Simulate';
import * as Q from './parts/Queries';
import * as Wire from './parts/Wire';
import * as Remote from './parts/Remote';
import * as Preview from './parts/Preview';
import * as Mount from './parts/Mount';
import { LARGE_DEPLOYABLE_KINDS, MOUNTABLE_DEPLOYABLE_KINDS, type PlacementPreview } from '@/shared';

export class GadgetSystem implements GameSystem, GadgetsRef {
  readonly name = 'gadgets';
  ctx!: GameContext;
  visuals!: GadgetVisualPool;
  thrown!: ThrownGadgetManager;
  readonly deployables: Deployable[] = [];
  readonly byId = new Map<string, Deployable>();
  readonly interactables = new Map<string, Interactable>();
  /** Ids this client asked the host to recover; the item is granted when the removal echoes back. */
  readonly pendingRecover = new Set<string>();
  readonly unsubs: Array<() => void> = [];
  readonly itemDefCache = new Map<GadgetId, string>();
  seq = 0;
  netHooked = false;
  useCooldown = 0;
  /** Over / under-hand throw toggle (B), shared with grenades. */
  underhand = false;
  /** 2026-09-11 (parts/Preview): 손에 든 설치형 가젯의 미리보기. `previewActive` 일 때만 `placement` 로 나간다. */
  readonly preview: PlacementPreview = Preview.createPreview();
  previewActive = false;
  /** 마지막으로 보낸 `gadget:placementChanged` 값 (바뀔 때만 보낸다). */
  readonly previewSent = Preview.createPreviewKey();
  /** `use()` 가 설치 순간 다시 돌리는 판정 — 노출용 `preview` 를 건드리지 않는다. */
  readonly placeUse: PlacementPreview = Preview.createPreview();

  /** 손에 든 `place` 가젯의 현재 설치 미리보기, 들고 있지 않으면 null. */
  get placement(): PlacementPreview | null { return this.previewActive ? this.preview : null; }

  /* ═══════════════════════════ GameSystem ═══════════════════════════ */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.gadgets = this;
    this.visuals = new GadgetVisualPool();
    this.thrown = new ThrownGadgetManager(ctx, (gid, pos) => this.onThrownImpact(gid, pos));
    ctx.scene.add(this.visuals.group);
    this.visuals.warm();
    // 2026-09-11: 설치 미리보기 고스트 (대형 + 소형 place 종류)
    this.visuals.warmGhosts([...LARGE_DEPLOYABLE_KINDS, ...MOUNTABLE_DEPLOYABLE_KINDS]);
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => { this.clear(); this.resetPlacement(); }),
      b.on('game:abort', () => { this.clear(); this.resetPlacement(); }),
      b.on('hub:entered', () => { this.clear(); this.resetPlacement(); }),
      b.on('player:died', () => { /* deployables outlive their owner on purpose */ }),
      // 2026-09-11 (parts/Mount): 드론이 사라지면 그 위 탑재물은 아래 바닥으로 떨어져 남는다
      b.on('drone:removed', ({ id }) => Mount.onDroneRemoved(this, id)),
      b.on('world:ready', () => {
        this.clear();
        this.resetPlacement();
        const net = ctx.net;
        if (ctx.isMultiplayer && net && !net.isHost) net.send({ t: 'gadq', ev: 'sync' }, 'host');
      }),
      // Phase 9: a promoted host may hold deployables we never saw (or different hp) — re-request the full set
      b.on('net:hostChanged', ({ isLocalHost }) => {
        const net = ctx.net;
        if (!isLocalHost && ctx.isMultiplayer && net && ctx.world?.ready) net.send({ t: 'gadq', ev: 'sync' }, 'host');
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
    // 2026-09-11: 드론 위 탑재물을 먼저 옮기고(미리보기의 "이미 드론에 설치물이 있다" 가 그것을 본다), 그다음 미리보기
    this.updateMounts(ctx);
    this.updatePlacement(ctx);

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

  use(id: GadgetId, underhand?: boolean): boolean { return Deploy.use(this, id, underhand); }

  findEnemyTarget(pos: THREE.Vector3, radius: number): DeployableRef | null { return Q.findEnemyTarget(this, pos, radius); }

  findDistraction(pos: THREE.Vector3, radius: number): DeployableRef | null { return Q.findDistraction(this, pos, radius); }

  blocksProjectile(from: THREE.Vector3, to: THREE.Vector3, fromEnemy: boolean): THREE.Vector3 | null { return Q.blocksProjectile(this, from, to, fromEnemy); }

  visionFactor(from: THREE.Vector3, to: THREE.Vector3): number { return Q.visionFactor(this, from, to); }

  fireDamageAt(pos: THREE.Vector3): number { return Q.fireDamageAt(this, pos); }

  jumpPadAt(pos: THREE.Vector3): DeployableRef | null { return Q.jumpPadAt(this, pos); }

  recover(id: string): ItemInstance | null { return Deploy.recover(this, id); }

  /** 2026-09-11: 로컬 플레이어의 무장된 원격 지뢰 전부 기폭 (클라는 `gadq detonate`). 반환 = 개수. */
  detonateRemoteMines(): number { return Remote.detonateRemoteMines(this); }

  /** 2026-09-11: 로컬 플레이어 소유로 월드에 있는 원격 지뢰 수 (무장 여부 무관). */
  liveRemoteMineCount(): number { return Remote.liveRemoteMineCount(this); }

  clear(): void { return Deploy.clear(this); }

  /* ═══════════════════════════ input ═══════════════════════════ */
  private handleInput(ctx: GameContext): void { return Deploy.handleInput(this, ctx); }

  /* ═══════════════════════════ use paths ═══════════════════════════ */
  useCloakVeil(def: GadgetDef): void { return Deploy.useCloakVeil(this, def); }

  useDefib(def: GadgetDef, target: { id: PeerId; position: THREE.Vector3; name: string }): void { return Deploy.useDefib(this, def, target); }

  throwGadget(def: GadgetDef, underhand: boolean): void { return Deploy.throwGadget(this, def, underhand); }

  private onThrownImpact(gid: GadgetId, pos: THREE.Vector3): void { return Deploy.onThrownImpact(this, gid, pos); }

  /** Authority spawns straight away; clients ask the host and wait for `gad spawn`. */
  requestPlace(def: GadgetDef, position: THREE.Vector3, yaw: number, mount: string | null = null): void { return Deploy.requestPlace(this, def, position, yaw, mount); }

  /* ═══════════════════════════ 설치 미리보기 · 드론 탑재 (2026-09-11) ═══════════════════════════ */
  /** 매 프레임: 손에 든 설치형 가젯의 판정 → 고스트 → `gadget:placementChanged` (parts/Preview). */
  updatePlacement(ctx: GameContext): void { return Preview.updatePreview(this, ctx); }

  /** 고스트를 숨기고 `placement` 를 null 로. */
  resetPlacement(): void { return Preview.resetPreview(this); }

  /** 드론 위 탑재물이 드론을 따라간다 / 드론이 없으면 떨어진다 (parts/Mount). */
  updateMounts(ctx: GameContext): void { return Mount.updateMounts(this, ctx); }

  /* ═══════════════════════════ spawn / remove ═══════════════════════════ */
  nextId(): string { return Deploy.nextId(this); }

  /**
   * @param wire non-null when this is a replica built from a `gad spawn` / `gad sync` broadcast
   *   (hp / armed / ttl come from the host instead of the definition).
   */
  spawnDeployable(id: string, def: GadgetDef, owner: PeerId | 'local', position: THREE.Vector3, yaw: number, wire: DeployableWire | null, mount?: string | null): Deployable | null { return Deploy.spawnDeployable(this, id, def, owner, position, yaw, wire, mount); }

  /** Removes locally and, on the authority, tells everyone. */
  remove(d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void { return Deploy.remove(this, d, reason); }

  removeLocal(d: Deployable, reason: 'destroyed' | 'recovered' | 'expired'): void { return Deploy.removeLocal(this, d, reason); }

  makeInteractable(d: Deployable, def: GadgetDef): Interactable { return Deploy.makeInteractable(this, d, def); }

  /** Puts the recovered item in the local bag (barricade / turret / jump pad only). */
  grantRecovered(d: Deployable): ItemInstance | null { return Deploy.grantRecovered(this, d); }

  /* ═══════════════════════════ simulation (authority) ═══════════════════════════ */
  private updateArming(d: Deployable): void { return Sim.updateArming(this, d); }

  private simulate(d: Deployable, dt: number, ctx: GameContext): void { return Sim.simulate(this, d, dt, ctx); }

  updateMine(d: Deployable, ctx: GameContext): void { return Sim.updateMine(this, d, ctx); }

  explodeMine(d: Deployable, ctx: GameContext): void { return Sim.explodeMine(this, d, ctx); }

  updateTurret(d: Deployable, dt: number, ctx: GameContext): void { return Sim.updateTurret(this, d, dt, ctx); }

  updateFireZone(d: Deployable, dt: number, ctx: GameContext): void { return Sim.updateFireZone(this, d, dt, ctx); }

  updateLure(d: Deployable, dt: number, ctx: GameContext): void { return Sim.updateLure(this, d, dt, ctx); }

  /* ═══════════════════════════ local (every client) ═══════════════════════════ */
  private updateLocalEffects(dt: number, ctx: GameContext): void { return Sim.updateLocalEffects(this, dt, ctx); }

  /* ═══════════════════════════ animation ═══════════════════════════ */
  private animate(d: Deployable, t: number, dt: number): void { return Sim.animate(this, d, t, dt); }

  /* ═══════════════════════════ damage ═══════════════════════════ */
  onDeployableDamage(d: Deployable, amount: number, from?: THREE.Vector3): void { return Sim.onDeployableDamage(this, d, amount, from); }

  damageEnemies(center: THREE.Vector3, radius: number, damage: number, by?: string): void { return Sim.damageEnemies(this, center, radius, damage, by); }

  hurtPlayer(victim: Victim, amount: number, from: THREE.Vector3): void { return Sim.hurtPlayer(this, victim, amount, from); }

  hurtRemote(peer: PeerId, amount: number, from: THREE.Vector3): void { return Sim.hurtRemote(this, peer, amount, from); }

  blastFx(position: THREE.Vector3, radius: number, shake = 1): void { return Sim.blastFx(this, position, radius, shake); }

  /* ═══════════════════════════ geometry helpers ═══════════════════════════ */
  /** Segment (from→to) vs the barricade box. Returns the parametric hit t in [0,1], or -1. */
  segmentVsBarricade(d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number { return Q.segmentVsBarricade(this, d, from, to); }

  /** Segment vs the dome hemisphere. Shots that start inside pass out freely. */
  segmentVsDome(d: Deployable, from: THREE.Vector3, to: THREE.Vector3): number { return Q.segmentVsDome(this, d, from, to); }

  /** 0..1 fraction of the segment swallowed by a sphere (smoke). */
  segmentSphereCoverage(from: THREE.Vector3, to: THREE.Vector3, center: THREE.Vector3, radius: number, height: number): number { return Q.segmentSphereCoverage(this, from, to, center, radius, height); }

  /**
   * Nearest player (local or remote) whose capsule the segment crosses before reaching `to`.
   * Uses its own scratch vectors: callers (the turret) pass `_a` / `_b` in, so touching those here would
   * silently destroy the caller's ray.
   */
  playerAlongRay(from: THREE.Vector3, to: THREE.Vector3): Victim | null { return Q.playerAlongRay(this, from, to); }

  /* ═══════════════════════════ placement / items ═══════════════════════════ */
  groundY(position: THREE.Vector3): number { return Q.groundY(this, position); }

  /** Spot in front of the player for a 'place' gadget. false when it is blocked / off the map. */
  placementSpot(def: GadgetDef, out: THREE.Vector3): boolean { return Deploy.placementSpot(this, def, out); }

  /** Item def id whose `gadgetId` matches (items/ owns the actual definitions). */
  itemDefIdFor(id: GadgetId): string | null { return Deploy.itemDefIdFor(this, id); }

  /**
   * Takes one unit out of the bag. When items/ has not published a gadget item yet (parallel development),
   * the gadget is allowed through so the system stays testable.
   */
  consumeItem(def: GadgetDef): boolean { return Deploy.consumeItem(this, def); }

  findDownedAlly(radius: number): { id: PeerId; position: THREE.Vector3; name: string } | null { return Deploy.findDownedAlly(this, radius); }

  derived(key: 'useSpeedMul' | 'interactSpeedMul' | 'throwRangeMul', fallback: number): number { return Q.derived(this, key, fallback); }

  deny(text: string | null): false { return Deploy.deny(this, text); }

  /* ═══════════════════════════ enemy helpers ═══════════════════════════ */
  enemiesNear(pos: THREE.Vector3, radius: number): readonly EnemyRef[] { return Q.enemiesNear(this, pos, radius); }

  enemyById(id: number): EnemyRef | null { return Q.enemyById(this, id); }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void { return Wire.ensureNetHooks(this); }

  broadcast(msg: GadgetMessage, to: 'all' | 'others' | PeerId): void { return Wire.broadcast(this, msg, to); }

  wireOf(d: Deployable): DeployableWire { return Wire.wireOf(this, d); }

  spawnFromWire(w: DeployableWire): void { return Wire.spawnFromWire(this, w); }

  /** Host → clients. */
  onGadgetMessage(m: GadgetMessage, from: PeerId): void { return Wire.onGadgetMessage(this, m, from); }

  /** Clients → host. */
  onGadgetRequest(m: GadgetRequest, from: PeerId): void { return Wire.onGadgetRequest(this, m, from); }

  /**
   * `buff` receiver. Gadgets own 'revive' (제세동기) and 'cloak' (은폐 장막); 'heal' / 'boost' belong to
   * implants/, so they are ignored here to avoid applying the same buff twice.
   */
  onBuff(m: BuffMessage, from: PeerId): void { return Wire.onBuff(this, m, from); }

  onFlow(m: FlowMessage, from: PeerId): void { return Wire.onFlow(this, m, from); }
}
