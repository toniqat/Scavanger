/**
 * src/gadgets/drones/DroneSystem.ts — **지상 · 공중 드론** (`ctx.drones`, 2026-09-11).
 *
 * 계약은 `@/shared` 의 `drones.ts` 가 전부다. 이 클래스는 상태와 한 줄 위임만 갖고, 일은 `parts/` 가 한다:
 *  - `parts/Control`   — R 홀드 조종 전환 · 조종 입력 · 드론 카메라 · 사거리/끊김 · 복귀
 *  - `parts/Lifecycle` — 꺼내기 · 소유자 시뮬레이션 · 소리/소음 · 피해/파괴(아이템 1개 소모) · E 회수 · 질의 · 리셋
 *  - `parts/Wire`      — 소유자 권한 동기화 (`drone` / `droneq`) · 복제본 보간
 * 몸체 물리는 `GroundDrone` / `AirDrone` (`model.ts` 의 `DroneBody`).
 *
 * `main.ts` 에서 `GadgetSystem` 바로 뒤에 등록된다 — `PlayerSystem` · `WeaponSystem` 보다 뒤라 R 을 읽는 순서 ·
 * `setCameraOverride` 가 같은 프레임 `PlayerSystem.lateUpdate`(카메라 리그) 에 들어가는 순서가 맞다.
 */
import type * as THREE from 'three';
import type {
  DroneKind, DroneRayHit, DroneRef, DroneReleaseReason, DronesRef, GameContext, GameSystem, PeerId,
} from '@/shared';
import type { Drone, DroneInput } from './model';
import * as Control from './parts/Control';
import * as Life from './parts/Lifecycle';
import * as Wire from './parts/Wire';

export class DroneSystem implements GameSystem, DronesRef {
  readonly name = 'drones';
  ctx!: GameContext;
  readonly drones: Drone[] = [];
  readonly byId = new Map<string, Drone>();
  /** 로컬 플레이어가 지금 시점을 빌려 쓰는 드론. */
  controlled: Drone | null = null;
  /** R 홀드가 진행 중인가 (이번 누름이 조종 전환용으로 시작됐다). */
  holding = false;
  holdT = 0;
  seq = 0;
  netHooked = false;
  readonly unsubs: Array<() => void> = [];
  readonly input: DroneInput = { forward: 0, right: 0, vertical: 0, sprint: false, jump: false, yaw: 0, pitch: 0 };
  /** `raycast` 가 돌려주는 객체 — **다음 호출에서 재사용된다** (할당 없음). */
  rayHit: DroneRayHit | null = null;
  /** 모르는 드론의 `state` 를 받고 그 소유자에게 `droneq sync` 를 마지막으로 물은 시각. */
  readonly syncAskedAt = new Map<PeerId, number>();

  get controlHold(): number { return Control.controlHold(this); }

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
    const authority = ctx.isAuthority;
    for (let i = this.drones.length - 1; i >= 0; i--) {
      const d = this.drones[i];
      if (d.removing) continue;
      if (d.isLocal) Life.simulateOwn(this, d, dt);
      else Wire.updateReplica(this, d);
      Control.updateLink(this, d);
      d.body.animate(dt, ctx.time);
      Life.updateSounds(this, d, dt);
      if (authority) Life.emitNoise(this, d);
      if (d.isLocal) Wire.maybeSendState(this, d);
    }
    Control.updateControlled(this, dt);
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
  clear(): void { return Life.clear(this); }

  /* ═══════════════════════════ networking ═══════════════════════════ */
  private ensureNetHooks(): void { return Wire.ensureNetHooks(this); }
}
