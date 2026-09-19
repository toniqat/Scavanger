/**
 * src/gadgets/drones/DroneSystem.ts — **ground · air drones** (`ctx.drones`, 2026-09-11).
 *
 * `drones.ts` in `@/shared` is the whole contract. This class holds state and one-line delegates only; `parts/` does
 * the work:
 *  - `parts/Control`   — the R-hold control switch · control input · the drone camera · link range / drop · return
 *  - `parts/Lifecycle` — deploy · owner simulation · sound / noise · damage / destruction (consumes one item) ·
 *                        E recover · queries · reset
 *  - `parts/Wire`      — owner-authoritative sync (`drone` / `droneq`) · replica interpolation
 * Body physics live in `GroundDrone` / `AirDrone` (`DroneBody` in `model.ts`).
 *
 * Registered right after `GadgetSystem` in `main.ts` — after `PlayerSystem` · `WeaponSystem`, so both the order in
 * which R is read and the order in which `setCameraOverride` reaches `PlayerSystem.lateUpdate` (the camera rig) in
 * the same frame come out right.
 */
import type * as THREE from 'three';
import type {
  DroneKind, DroneRayHit, DroneRef, DroneReleaseReason, DronesRef, GameContext, GameSystem, PeerId,
  DroneScanAim, DroneScanResult, Rarity,
} from '@/shared';
import type { Drone, DroneInput } from './model';
import * as Control from './parts/Control';
import * as Life from './parts/Lifecycle';
import * as Wire from './parts/Wire';
/* appended (2026-09-12): the ground drone's scan */
import * as Scan from './parts/Scan';

export class DroneSystem implements GameSystem, DronesRef {
  readonly name = 'drones';
  ctx!: GameContext;
  readonly drones: Drone[] = [];
  readonly byId = new Map<string, Drone>();
  /** The drone whose view the local player is borrowing right now. */
  controlled: Drone | null = null;
  /** Is an R hold running (this press started as a control switch). */
  holding = false;
  holdT = 0;
  seq = 0;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  readonly input: DroneInput = { forward: 0, right: 0, vertical: 0, sprint: false, jump: false, yaw: 0, pitch: 0 };
  /** The object `raycast` returns — **reused by the next call** (no allocation). */
  rayHit: DroneRayHit | null = null;
  /** When an owner was last asked for `droneq sync` after a `state` for an unknown drone arrived. */
  readonly syncAskedAt = new Map<PeerId, number>();

  /* ── 2026-09-12: the ground drone's scan (`parts/Scan`) ── */
  /** Accumulated scan hold (s) and its target id (a change restarts it from 0). */
  scanT = 0;
  scanTargetId: string | null = null;
  /** One scan has been filled — no counting again until left click is released. */
  scanLatch = false;
  /** The target currently on the aim line (valid only while `scanAimOn`, a reused object). */
  scanAimOn = false;
  readonly scanAimView: Scan.MutableScanAim = { id: '', kind: 'crate', name: '', distance: 0, inRange: false };
  /** This raid's results — target id → the latest result (`scanList` is the value array, rebuilt on a change). */
  readonly scans = new Map<string, DroneScanResult>();
  scanList: readonly DroneScanResult[] = [];
  /** Receiving side: the time of the last accepted scan per sender · the number of scans dropped (debug · smokes). */
  readonly scanRecvAt = new Map<PeerId, number>();
  scanRefused = 0;

  get controlHold(): number { return Control.controlHold(this); }
  get scanHold(): number { return Scan.scanHold(this); }
  get scanAim(): DroneScanAim | null { return Scan.scanAim(this); }
  getScanResults(): readonly DroneScanResult[] { return Scan.getScanResults(this); }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.drones = this;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('game:newMission', () => this.clear()),
      b.on('game:abort', () => this.clear()),
      b.on('hub:entered', () => this.clear()),
      b.on('world:ready', () => {
        this.clear();
        if (ctx.isMultiplayer) ctx.net?.send({ t: 'droneq', ev: 'sync' }, 'others');
      }),
      b.on('player:damaged', ({ amount }) => { if (amount > 0) this.releaseControl('damage'); }),
      b.on('player:downed', () => this.releaseControl('reset')),
      b.on('player:died', () => this.releaseControl('reset')),
      b.on('net:remotePlayerRemoved', ({ id }) => Life.removeOwnedBy(this, id)),
    );
    this.ensureNetHooks();
  }

  update(dt: number, ctx: GameContext): void {
    this.ensureNetHooks();
    Control.updateControl(this, dt);
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.removing) continue;
      if (d.isLocal) Life.simulateOwn(this, d, dt);
      else Wire.updateReplica(this, d);
      Control.updateLink(this, d);
      d.body.animate(dt, ctx.time);
      Life.updateSounds(this, d, dt);
      Life.emitNoise(this, d);   // the authority test is inside (`Lifecycle.emitNoise`)
      if (d.isLocal) Wire.maybeSendState(this, d);
    }
    Control.updateControlled(this, dt);
    Scan.updateScan(this, dt);
  }

  dispose(): void {
    this.clear();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.ctx?.drones === this) this.ctx.drones = null;
  }

  /* ═══════════════════════════ DronesRef ═══════════════════════════ */
  getDrones(): readonly DroneRef[] { return this.drones; }
  getDrone(id: string): DroneRef | null { return this.byId.get(id) ?? null; }
  getOwnDrone(kind: DroneKind): DroneRef | null { return Life.ownDrone(this, kind); }
  deploy(kind: DroneKind): boolean { return Life.deploy(this, kind); }
  releaseControl(reason: DroneReleaseReason): void { return Control.releaseControl(this, reason); }
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, kind?: DroneKind): DroneRayHit | null { return Life.raycast(this, origin, dir, maxDist, kind); }
  damageDrone(id: string, amount: number, from?: THREE.Vector3): void { return Life.damageDrone(this, id, amount, from); }
  applyExplosion(center: THREE.Vector3, radius: number, damage: number): void { return Life.applyExplosion(this, center, radius, damage); }
  clear(): void { Scan.clearScans(this); return Life.clear(this); }

  /* ═══════════════════════════ debug / smoke ═══════════════════════════ */
  /** Enters the view of my own drone `id` straight away (no R hold — for smokes). true on success. */
  debugControl(id: string): boolean {
    const d = this.byId.get(id);
    if (!d || !d.isLocal || d.removing) return false;
    Control.startControl(this, d);
    return this.controlled === d;
  }
  /** What scanning target `id` right now would yield (records and broadcasts nothing), null when unknown. */
  scanPreview(id: string): { rarity: Rarity | null; defIds: string[] } | null {
    const items = Scan.previewItems(this, id);
    if (!items) return null;
    return { rarity: Scan.maxRarity(this, items), defIds: items.filter((i) => i.qty > 0).map((i) => `${i.defId}x${i.qty}`).sort() };
  }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void { return Wire.ensureNetHooks(this); }
}
