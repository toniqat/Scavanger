import * as THREE from 'three';
import {
  Keys, MouseButtons, Random,
  STRATAGEM_DEFS, STRATAGEM_ORDER, STRATAGEM_WHEEL_HOLD, STRATAGEM_CHARGE_TIME,
  TOPVIEW_HEIGHT, TOPVIEW_RANGE, TOPVIEW_CURSOR_SPEED, GROUND_TARGET_RANGE,
  LASER_DURATION, LASER_RADIUS, LASER_DPS, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE,
  SUPPLY_FALL_TIME, SUPPLY_IMPACT_RADIUS, SUPPLY_IMPACT_DAMAGE, SUPPLY_CRATE_TIER,
  STRUCTURE_COUNT, STRUCTURE_HP, STRUCTURE_SCATTER, STRUCTURE_IMPACT_RADIUS, STRUCTURE_IMPACT_DAMAGE, STRUCTURE_FALL_TIME,
  type GameContext, type GameSystem, type StratagemsRef, type StratagemId, type StratagemCall, type StratagemStage, type StratagemDef,
  type PlayerRef, type PlayerWeaponHost, type Interactable, type Obstacle, type DestructibleRef, type WorldRef, type Vec3Tuple, type PeerId,
  type StratagemCallWire,
  /* 2026-09-09: 구조선 투하 */
  RESCUE_DROPS_PER_RAID, type RescueCandidate,
} from '@/shared';
import {
  SharedGeo, TargetRing, CallMarker, Burst, dustBurst, sparkBurst, LaserBeam, Fireball, SupplyCrateMesh, BarricadeMesh, makeRubble, KIND_COLOR,
} from './Visuals';

import { AIRSTRIKE_FX_TIME, Call, GRENADE_STRUCTURE_DAMAGE, type Host, LASER_TICK, SHAKE_RANGE, STRUCTURE_DROP_HEIGHT, STRUCTURE_MIN_GAP, STRUCTURE_STAGGER, SUPPLY_DROP_HEIGHT, Structure, TARGET_EMIT_EPS, WHEEL_DRAG_PX, _a, _b, _dir, defOf, toTuple } from './model';
/** 폴더 공용 어휘(상수 · 타입 · 스크래치)는 `model.ts` 가 갖는다 — 기존 import 경로를 위해 재수출한다. */
export * from './model';
import * as Aim from './parts/Targeting';
import * as Calls from './parts/Calls';
import * as Wire from './parts/Wire';
import * as Rescue from './parts/Rescue';

export class StratagemSystem implements GameSystem, StratagemsRef {
  readonly name = 'stratagems';
  ctx!: GameContext;
  readonly geo = new SharedGeo();
  readonly group = new THREE.Group();
  ring!: TargetRing;
  readonly calls: Call[] = [];
  /** ctx.time at the previous update (pause shift, see `updateCalls`). */
  lastClock = -1;
  readonly byId = new Map<string, Call>();
  readonly bursts: Burst[] = [];
  seq = 0;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  warnedNoObstacle = false;
  /** True while a synced call is fast-forwarded to its landed state: no impact damage / bursts / shake / audio (Phase 9). */
  silent = false;

  /* ── StratagemsRef state ── */
  _armed: StratagemId | null = null;
  lastArmed: StratagemId = STRATAGEM_ORDER[0];
  _cooldown = 0;
  private _cooldownTotal = 0;
  private cooldownEmitAcc = 0;
  /* wheel */
  gHeld = false;
  gHoldT = 0;
  wheelOpen = false;
  wheelDX = 0; wheelDY = 0;
  wheelHover: StratagemId | null = null;
  /* charge / topview */
  charge = -1;
  topview = false;
  needRelease = false;
  readonly cursor = new THREE.Vector3();
  /* ground */
  groundTargeting = false;
  readonly lastEmitted = new THREE.Vector3(NaN, NaN, NaN);
  targetValid = false;
  /* ── 구조선 (2026-09-09) ── */
  /** 분대 공용 잔여 횟수. 호스트가 원본이고 `rescue count` 로 방송된다. */
  _rescueLeft = RESCUE_DROPS_PER_RAID;
  /** 선택 화면에서 고른 분대원 (null = 아직 고르지 않음 → 지면 조준이 시작되지 않는다). */
  _rescueTarget: string | null = null;

  get armed(): StratagemId | null { return this._armed; }
  get targeting(): boolean { return this.topview || this.groundTargeting; }
  get cooldown(): number { return this._cooldown; }
  get cooldownTotal(): number { return this._cooldownTotal; }
  getCalls(): readonly StratagemCall[] { return this.calls; }
  get structureCount(): number {
    let n = 0;
    for (const c of this.calls) for (const s of c.structures) if (s.landed && !s.destroyed) n++;
    return n;
  }

  /* ── StratagemsRef: 구조선 (2026-09-09) ── */
  get rescueLeft(): number { return this._rescueLeft; }
  get rescueAvailable(): boolean { return Rescue.rescueAvailable(this); }
  getRescueCandidates(): readonly RescueCandidate[] { return Rescue.getRescueCandidates(this); }
  get rescueTarget(): string | null { return this._rescueTarget; }
  /** 무장 거부 사유 (호스트 전용 · 구조선 게이트), 없으면 null. UI 는 같은 규칙을 `@/shared` 로 스스로 계산한다. */
  armBlockReason(id: StratagemId): string | null { return Rescue.armBlockReason(this, id); }

  /* ─────────────────────────── GameSystem ─────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.stratagems = this;
    this.ring = new TargetRing(this.geo);
    this.group.add(this.ring.group);
    ctx.scene.add(this.group);
    const b = ctx.bus;
    const clear = () => this.clearAll();
    this.unsubs.push(
      b.on('game:abort', clear),
      b.on('game:newMission', clear),
      b.on('hub:entered', clear),
      b.on('world:cleared', clear),
      b.on('player:died', () => this.putAway()),
      b.on('player:downed', () => this.putAway()),
      b.on('game:phaseChanged', ({ phase }) => {
        if (phase !== 'playing' && phase !== 'extracting' && phase !== 'shipLanded' && phase !== 'liftoff') this.putAway();
      }),
      b.on('crate:looted', ({ crateId }) => this.onCrateLooted(crateId)),
      b.on('grenade:exploded', ({ position, radius }) => this.splashStructures(position, radius, GRENADE_STRUCTURE_DAMAGE)),
      // Phase 9: a late joiner asks the host for every live call (the answer arrives as `strat sync`)
      b.on('world:ready', () => {
        const net = ctx.net;
        if (ctx.isMultiplayer && net && !net.isHost) net.send({ t: 'stratq', ev: 'sync' }, 'host');
      }),
      /* 2026-09-09 구조선: 선택 화면(ui/hud/RescuePicker)이 고른 대상 */
      b.on('rescue:selectTarget', ({ peerId }) => this.selectRescueTarget(peerId)),
      /*
       * 2026-09-09 분대장 이관: 잠금 상태가 즉시 갱신되어야 한다. 새로 잠긴 호출을 손에 들고 있었다면
       * (호스트 자리를 잃었다) 그대로 내려놓는다 — 조준만 해 놓고 쏠 수 없는 상태를 남기지 않는다.
       */
      b.on('net:hostChanged', () => {
        const armed = this._armed;
        if (armed && Rescue.hostLocked(this, armed)) {
          this.putAway();
          ctx.bus.emit('ui:notify', { text: '분대장이 바뀌어 호출을 내려놓았습니다', kind: 'warning', duration: 2 });
        }
      }),
    );
    this.ensureNetHooks();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    this.tickCooldown(dt);
    this.updateInput(dt);
    this.updateCalls(dt);
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      if (!this.bursts[i].update(dt)) { this.group.remove(this.bursts[i].points); this.bursts[i].dispose(); this.bursts.splice(i, 1); }
    }
    void ctx;
  }

  dispose(): void {
    this.clearAll();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.ring.dispose();
    this.ctx.scene.remove(this.group);
    this.geo.dispose();
    if (this.ctx.stratagems === this) this.ctx.stratagems = null;
  }

  /** Debug: create a call at `position` immediately (no input, no cooldown). Returns the call id. */
  debugCall(kind: StratagemId, position: THREE.Vector3): string {
    const def = defOf(kind);
    const p = position.clone();
    if (this.ctx.world?.ready) p.y = this.ctx.world.getHeightAt(p.x, p.z);
    return this.createCall(kind, p, def.delay, (Math.random() * 0xffffffff) >>> 0, true).id;
  }

  /** Debug: clear the shared cooldown (emits `stratagem:cooldown {remaining: 0}`). */
  debugCooldownReset(): void {
    this._cooldown = 0;
    this.cooldownEmitAcc = 0;
    this.ctx.bus.emit('stratagem:cooldown', { remaining: 0, total: this._cooldownTotal });
  }

  /* ─────────────────────────── helpers ─────────────────────────── */
  host(): Host | null {
    const p = this.ctx.player;
    if (!p || typeof (p as Partial<PlayerWeaponHost>).getAimRay !== 'function') return null;
    return p as Host;
  }
  world(): WorldRef | null {
    const w = this.ctx.world;
    return w && w.ready ? w : null;
  }
  /** Gameplay, pointer locked, alive and not downed. */
  baseActive(): boolean {
    const ctx = this.ctx, p = ctx.player;
    return !!p && ctx.isGameplayActive() && ctx.input.isPointerLocked && !p.isDead && !p.isDowned;
  }
  audio(id: string, position?: THREE.Vector3, volume = 1): void {
    if (this.silent) return;
    this.ctx.bus.emit('audio:play', { id, position, volume });
  }
  shakeFrom(center: THREE.Vector3, base: number): void {
    if (this.silent) return;
    const p = this.ctx.player; if (!p) return;
    const d = p.position.distanceTo(center);
    const k = THREE.MathUtils.clamp(1 - d / SHAKE_RANGE, 0, 1);
    if (k > 0) this.ctx.bus.emit('camera:shake', { intensity: base * (0.25 + k * 0.75), duration: 0.5 });
  }
  burst(b: Burst): void {
    if (this.silent) { b.dispose(); return; }
    this.bursts.push(b); this.group.add(b.points);
  }

  /* ─────────────────────────── cooldown ─────────────────────────── */
  private tickCooldown(dt: number): void {
    if (this._cooldown <= 0) return;
    this._cooldown = Math.max(0, this._cooldown - dt);
    this.cooldownEmitAcc += dt;
    if (this._cooldown === 0 || this.cooldownEmitAcc >= 0.5) {
      this.cooldownEmitAcc = 0;
      this.ctx.bus.emit('stratagem:cooldown', { remaining: this._cooldown, total: this._cooldownTotal });
    }
  }
  startCooldown(seconds: number): void {
    this._cooldown = this._cooldownTotal = seconds;
    this.cooldownEmitAcc = 0;
    this.ctx.bus.emit('stratagem:cooldown', { remaining: seconds, total: seconds });
  }

  /* ─────────────────────────── input ─────────────────────────── */
  private updateInput(dt: number): void { return Aim.updateInput(this, dt); }

  cancelCharge(): void { return Aim.cancelCharge(this); }

  updateWheel(dx: number, dy: number): void { return Aim.updateWheel(this, dx, dy); }

  closeWheel(host: Host): void { return Aim.closeWheel(this, host); }

  arm(id: StratagemId): void { return Aim.arm(this, id); }

  disarm(): void { return Aim.disarm(this); }

  /** Leave any targeting and put the call away. */
  putAway(): void { return Aim.putAway(this); }

  /* ─────────────────────────── ground targeting ─────────────────────────── */
  setGroundTargeting(on: boolean): void { return Aim.setGroundTargeting(this, on); }

  updateGroundCursor(host: Host): void { return Aim.updateGroundCursor(this, host); }

  emitTargeting(): void { return Aim.emitTargeting(this); }

  /* ─────────────────────────── top view ─────────────────────────── */
  /*
   * 2026-09-08: Escape no longer cancels the top view. It could never actually reach us — the browser eats the key
   * to free the pointer lock — and that unlock is now the 일시정지 메뉴, whose `'menu'` blocker fails `baseActive()`
   * and cancels the targeting through the normal path above. RMB is the cancel that works while aiming.
   */

  enterTopview(host: Host): void { return Aim.enterTopview(this, host); }

  updateTopview(_dt: number, host: Host): void { return Aim.updateTopview(this, _dt, host); }

  /** Leave the top view / wheel / charge, restoring camera + controls. Keeps the armed call. */
  cancelTargeting(): void { return Aim.cancelTargeting(this); }

  /* ─────────────────────────── confirm / calls ─────────────────────────── */
  confirm(def: StratagemDef): void { return Aim.confirm(this, def); }

  createCall(kind: StratagemId, position: THREE.Vector3, eta: number, seed: number, local: boolean, id?: string, caller?: PeerId | null): Call { return Calls.createCall(this, kind, position, eta, seed, local, id, caller); }

  removeMarker(call: Call): void { return Calls.removeMarker(this, call); }

  landed(call: Call): void { return Calls.landed(this, call); }
  ended(call: Call): void { return Calls.ended(this, call); }

  /** Radial damage of an impact: enemies only on the caller's client, the local player everywhere (linear falloff). */
  impactDamage(call: Call, center: THREE.Vector3, radius: number, damage: number): void { return Calls.impactDamage(this, call, center, radius, damage); }

  private updateCalls(dt: number): void { return Calls.updateCalls(this, dt); }

  /* ─────────────────────────── orbital laser ─────────────────────────── */
  updateLaser(c: Call, t: number, _dt: number): void { return Calls.updateLaser(this, c, t, _dt); }

  /* ─────────────────────────── airstrike ─────────────────────────── */
  updateAirstrike(c: Call, t: number): void { return Calls.updateAirstrike(this, c, t); }

  /* ─────────────────────────── supply drop ─────────────────────────── */
  prepareSupply(c: Call): void { return Calls.prepareSupply(this, c); }

  updateSupply(c: Call, t: number): void { return Calls.updateSupply(this, c, t); }

  private onCrateLooted(crateId: string): void { return Calls.onCrateLooted(this, crateId); }

  /* ─────────────────────────── structures ─────────────────────────── */
  addObstacle(o: Obstacle): (() => void) | null { return Calls.addObstacle(this, o); }

  prepareStructures(c: Call): void { return Calls.prepareStructures(this, c); }

  updateStructures(c: Call, t: number): void { return Calls.updateStructures(this, c, t); }

  damageStructure(s: Structure, amount: number, broadcast: boolean): void { return Calls.damageStructure(this, s, amount, broadcast); }

  setStructureHp(s: Structure, hp: number): void { return Calls.setStructureHp(this, s, hp); }

  destroyStructure(s: Structure): void { return Calls.destroyStructure(this, s); }

  /** Radial damage to standing structures (grenades). */
  private splashStructures(center: THREE.Vector3, radius: number, damage: number): void { return Calls.splashStructures(this, center, radius, damage); }

  disposeStructure(s: Structure): void { return Calls.disposeStructure(this, s); }

  /* ─────────────────────────── 구조선 (2026-09-09) ─────────────────────────── */
  /** `rescue:selectTarget` — 선택 화면이 고른 분대원 (null = 해제 → 호출을 내려놓는다). */
  selectRescueTarget(peerId: string | null): void { return Rescue.selectTarget(this, peerId); }

  /** 지면 조준 확정 → 호스트에게 `rescue req` (호스트 · 싱글은 그 자리에서 승인). */
  confirmRescue(target: string, position: THREE.Vector3): void { return Rescue.confirmRescue(this, target, position); }

  /** 호스트 권한: 횟수 −1 + 착륙 지점 확정 + `rescue grant` 방송. */
  grantRescue(target: string, position: THREE.Vector3, by: string): void { return Rescue.grant(this, target, position, by); }

  /** 잔여 횟수를 세우고 `rescue:countChanged` (호스트면 `rescue count` 방송). */
  setRescueLeft(left: number, broadcast: boolean): void { return Rescue.setRescueLeft(this, left, broadcast); }

  updateRescue(c: Call, t: number): void { return Rescue.updateRescue(this, c, t); }

  /* ─────────────────────────── net ─────────────────────────── */
  private ensureNetHooks(): void { return Wire.ensureNetHooks(this); }

  /** Every live call as `StratagemCallWire` (`eta` relative to now, `st` = damaged structures only). */
  syncWire(): StratagemCallWire[] { return Wire.syncWire(this); }

  sendSync(to: PeerId): void { return Wire.sendSync(this, to); }

  /**
   * Late-join reception: unknown calls are created as remote (`local = false`); a call that already landed (`eta ≤ 0`)
   * is back-dated and fast-forwarded in this frame — silently (no impact damage / FX) — so its obstacles and supply
   * interactable exist at once; the synced structure hp is applied **inside the same silent window**, so a block that
   * was already rubble when we joined leaves rubble without its demolition shake / dust / bang. The state events
   * (`stratagem:landed`, `structure:damaged / destroyed`) are still emitted — only the felt FX are suppressed.
   * The cooldown is personal and not synced.
   */
  applySync(calls: StratagemCallWire[]): void { return Wire.applySync(this, calls); }

  /** Run one silent update step at `ctx.time` so a back-dated call reaches its landed state immediately. */
  fastForward(c: Call): void { return Wire.fastForward(this, c); }

  /* ─────────────────────────── cleanup ─────────────────────────── */
  removeCall(c: Call): void { return Calls.removeCall(this, c); }

  private clearAll(): void { return Calls.clearAll(this); }
}
