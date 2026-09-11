/**
 * src/gadgets/drones/parts/Control.ts — **누가 언제 드론 시점으로 들어가고 나오는가.**
 *
 * R 홀드(`DRONE_CONTROL_HOLD_S`)로 조종을 잡고 같은 홀드로 PC 로 돌아온다. 조종 중에는 키 · 마우스를 `DroneInput`
 * 으로 옮기고, 드론 렌즈를 매 프레임 `player.setCameraOverride(pos, look, true)` 로 넘긴다 — `DroneSystem.update` 는
 * `PlayerSystem.update` 뒤 · `PlayerSystem.lateUpdate`(카메라 리그) 앞이라 한 프레임도 늦지 않는다.
 * 사거리(`linkRatio`) · 강제 끊김 · 지지직도 여기다.
 */
import {
  DRONE_CONTROL_HOLD_S, DRONE_LINK_WARN_RATIO, DroneFlags, Keys, droneKindOfGadget,
  type DroneKind, type DroneReleaseReason, type GadgetId,
} from '@/shared';
import {
  _camLook, _camPos, DRONE_LOOK_PITCH_MAX, DRONE_LOOK_SENSITIVITY, DRONE_STATIC_SFX_S, droneRange, wrapAngle,
  type Drone, type DroneInput,
} from '../model';
import type { DroneSystem } from '../DroneSystem';
import { deny, ownDrone } from './Lifecycle';

let staticT = 0;

/** 손에 든 아이템이 드론 조종기면 그 종류. */
export function heldDroneKind(sys: DroneSystem): DroneKind | null {
  const id = sys.ctx.weapons?.remoteState?.heldItemId;
  if (!id) return null;
  const def = sys.ctx.loot?.getItemDef(id);
  return droneKindOfGadget((def?.gadgetId ?? null) as GadgetId | null);
}

export function controlHold(sys: DroneSystem): number {
  return sys.holding ? Math.min(1, sys.holdT / Math.max(0.01, DRONE_CONTROL_HOLD_S)) : 0;
}

/**
 * R 홀드. 홀드는 **이번 누름**(`wasPressed`)에서만 시작한다 — 재장전하려고 누르고 있던 R 이 드론을 손에 드는 순간
 * 조종으로 이어지지 않게. 채우면 한 번 전환하고, 뗄 때까지 다시 세지 않는다.
 */
export function updateControl(sys: DroneSystem, dt: number): void {
  const ctx = sys.ctx;
  const input = ctx.input;
  const p = ctx.player;
  const rDown = input.isDown(Keys.RELOAD);
  if (!rDown) { sys.holding = false; sys.holdT = 0; }

  const cur = sys.controlled;
  if (cur) {
    // `setDroneControl` 은 조용히 거절되거나 스스로 풀릴 수 있다 (사다리 · 헬포드 · 들쳐메기 · 함선 실내 …) — 이벤트가 없으니 매 프레임 본다
    if (!p || p.isDead || p.isDowned || !ctx.isGameplayPhase() || cur.removing || p.droneControl === false) { releaseControl(sys, 'reset'); return; }
    if (!ctx.isGameplayActive()) { sys.holding = false; sys.holdT = 0; return; }
    if (input.wasPressed(Keys.RELOAD)) { input.consume(Keys.RELOAD); sys.holding = true; sys.holdT = 0; }
    if (!sys.holding) return;
    sys.holdT += dt;
    if (sys.holdT >= DRONE_CONTROL_HOLD_S) releaseControl(sys, 'manual');
    return;
  }

  const able = !!p && !p.isDead && !p.isDowned && !p.droneControl && ctx.isGameplayActive();
  const kind = able ? heldDroneKind(sys) : null;
  const d = kind ? ownDrone(sys, kind) : null;
  if (!d) { sys.holding = false; sys.holdT = 0; return; }
  if (input.wasPressed(Keys.RELOAD)) {
    input.consume(Keys.RELOAD);
    if (d.linkRatio >= 1) { sys.holding = false; deny(sys, '신호 범위 밖'); return; }
    sys.holding = true;
    sys.holdT = 0;
  }
  if (!sys.holding) return;
  sys.holdT += dt;
  if (sys.holdT < DRONE_CONTROL_HOLD_S) return;
  sys.holding = false;
  sys.holdT = 0;
  if (d.linkRatio >= 1) { deny(sys, '신호 범위 밖'); return; }
  startControl(sys, d);
}

export function startControl(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  if (sys.controlled === d) return;
  if (sys.controlled) releaseControl(sys, 'manual');
  const p = ctx.player;
  if (!p) return;
  if (typeof p.setDroneControl === 'function') {
    p.setDroneControl(true);
    // 플레이어가 거절했다 (사다리 · 헬포드 · 들쳐메기 · 함선 실내 …) — 시점을 넘기지 않는다
    if (!p.droneControl) { deny(sys, '지금은 드론을 조종할 수 없다'); return; }
  }
  sys.controlled = d;
  d.localControlled = true;
  d.lookYaw = d.body.yaw;
  d.lookPitch = 0;
  d.netDirty = true;
  staticT = 0;
  d.body.setOwnerView(true);
  applyCamera(sys);
  ctx.bus.emit('audio:play', { id: 'drone_link_on', volume: 0.7 });
  ctx.bus.emit('drone:controlChanged', { id: d.id, kind: d.kind, reason: null });
}

export function releaseControl(sys: DroneSystem, reason: DroneReleaseReason): void {
  const d = sys.controlled;
  if (!d) return;
  const ctx = sys.ctx;
  sys.controlled = null;
  sys.holding = false;
  sys.holdT = 0;
  d.localControlled = false;
  d.netDirty = true;
  d.body.setOwnerView(false);
  const p = ctx.player;
  if (p && (p.droneControl ?? true)) p.setDroneControl?.(false);
  // snap + null = 즉시 컷. 그냥 null 은 1 초쯤 섞여 돌아오는데, 멀리 있는 드론에서 PC 까지 카메라가 지형을 훑고 지나간다.
  p?.setCameraOverride(null, undefined, true);
  ctx.bus.emit('audio:play', { id: 'drone_link_off', volume: 0.7 });
  ctx.bus.emit('drone:controlChanged', { id: null, kind: null, reason });
}

/** 조종 중인 드론의 이번 프레임 입력. UI 가 열려 있으면 null (지상은 멈추고 공중은 제자리 비행). */
export function buildInput(sys: DroneSystem, d: Drone): DroneInput | null {
  const ctx = sys.ctx;
  if (!ctx.isGameplayActive()) return null;
  const input = ctx.input;
  if (input.isPointerLocked) {
    d.lookYaw = wrapAngle(d.lookYaw - input.mouseDX * DRONE_LOOK_SENSITIVITY);
    d.lookPitch = Math.max(-DRONE_LOOK_PITCH_MAX, Math.min(DRONE_LOOK_PITCH_MAX, d.lookPitch - input.mouseDY * DRONE_LOOK_SENSITIVITY));
  }
  const inp = sys.input;
  inp.forward = (input.isDown(Keys.FORWARD) ? 1 : 0) - (input.isDown(Keys.BACK) ? 1 : 0);
  inp.right = (input.isDown(Keys.RIGHT) ? 1 : 0) - (input.isDown(Keys.LEFT) ? 1 : 0);
  inp.vertical = (input.isDown(Keys.JUMP) ? 1 : 0) - (input.isDown(Keys.CROUCH) ? 1 : 0);
  inp.sprint = input.isDown(Keys.SPRINT);
  inp.jump = input.wasPressed(Keys.JUMP);
  inp.yaw = d.lookYaw;
  inp.pitch = d.lookPitch;
  return inp;
}

/** 소유자 PC ↔ 드론 3D 거리 ÷ 사거리. 복제본은 그 소유자의 원격 위치로 잰다 (없으면 와이어의 LINK_LOST). */
export function updateLink(sys: DroneSystem, d: Drone): void {
  const ctx = sys.ctx;
  const range = droneRange(d.kind);
  if (d.isLocal) {
    const p = ctx.player;
    d.linkRatio = p ? p.position.distanceTo(d.position) / range : 0;
    return;
  }
  const owner = ctx.net?.getRemotePlayer(d.owner as string);
  const lost = (d.flags & DroneFlags.LINK_LOST) !== 0;
  if (owner) {
    const r = owner.position.distanceTo(d.position) / range;
    d.linkRatio = lost ? Math.max(1, r) : r;
  } else d.linkRatio = lost ? 1 : 0;
}

/** 루프 뒤: 강제 끊김 · 카메라 · 지지직. */
export function updateControlled(sys: DroneSystem, dt: number): void {
  const d = sys.controlled;
  if (!d) return;
  if (d.linkRatio >= 1) { releaseControl(sys, 'range'); return; }
  applyCamera(sys);
  if (d.linkRatio >= DRONE_LINK_WARN_RATIO) {
    staticT -= dt;
    if (staticT <= 0) {
      staticT = DRONE_STATIC_SFX_S;
      const k = (d.linkRatio - DRONE_LINK_WARN_RATIO) / Math.max(0.01, 1 - DRONE_LINK_WARN_RATIO);
      sys.ctx.bus.emit('audio:play', { id: 'drone_static', volume: 0.25 + 0.55 * Math.max(0, Math.min(1, k)) });
    }
  } else staticT = 0;
}

export function applyCamera(sys: DroneSystem): void {
  const d = sys.controlled;
  const p = sys.ctx.player;
  if (!d || !p) return;
  d.body.getCameraPose(d.lookPitch, _camPos, _camLook);
  p.setCameraOverride(_camPos, _camLook, true);
}
