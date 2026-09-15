/**
 * src/weapons/parts/Defib.ts — **제세동기의 조준 사용** (2026-09-15, 사용자 결정).
 *
 * 다른 홀드 소모품과 **반대**다: 회복약 · 실드 충전기 · 가젯은 홀드가 **채워지는 순간** 발동하지만,
 * 제세동기는 채워진 뒤에도 좌클릭을 **누르고 있고**, 쓰러진 아군을 크로스헤어에 올린 채 **떼야** 일으킨다.
 * 대상 없이 떼면 불발이고 **아이템은 소모되지 않는다**.
 *
 * 이 파일이 하는 일은 셋뿐이다 — ① 충전 타이머(`DEFIB_USE_TIME_S`, 아이템의 `gadgetUseTime` 가 있으면 그것),
 * ② 겨눈 대상 판정(`GADGET_DEFIB_RANGE` 안 · `DEFIB_AIM_CONE_DEG` 반각), ③ 상태 방송 `gadget:defibAim`.
 * **그리는 곳은 `ui/hud/Reticle` 하나다** (작은 흰 원이 커져 큰 반투명 원과 겹치고, 겨누면 주황).
 *
 * 실제 소생은 그대로 `ctx.gadgets.use('defib')` 가 한다 — 아이템 소모 · 사거리 검사 · `buff revive` 송신이
 * 전부 거기 있다. 여기의 `target` 은 **크로스헤어용 표시**이고, 「어느 아군인가」는 gadgets 의
 * `findDownedAlly` 가 **같은 조준 광선에서 각이 가장 작은 아군**을 고르므로 둘이 어긋나지 않는다.
 */
import * as THREE from 'three';
import { DEFIB_AIM_CONE_DEG, GADGET_DEFIB_RANGE, MouseButtons, type GadgetId, type ItemDef } from '@/shared';
import type { Host, QuickHand } from '../model';
import type { WeaponSystem } from '../WeaponSystem';

/** 제세동기 가젯 id — 아이템 def 의 `gadgetId`. */
const DEFIB: GadgetId = 'defib';

/** `gadget:defibAim` 송신 상한 (회복 홀드 게이지와 같은 30 Hz). 시작 · 준비 완료 · 대상 변화 · 종료는 강제로 보낸다. */
const EMIT_HZ = 30;

const _o = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
/** 아군의 「가슴」 높이 — 발밑을 겨누지 않아도 잡히게 (스프레이 · 오버차지 빔과 같은 값). */
const CHEST_Y = 1.15;

/** 손에 든 것이 제세동기인가 (기폭기 손 · 드론 조종기와 같은 방식의 한 줄 판별). */
export function isDefibHand(sys: WeaponSystem, q: QuickHand): boolean {
  void sys;
  return !q.detonator && q.def.gadgetId === DEFIB;
}

/** 충전에 걸리는 초 — 아이템의 `gadgetUseTime`(없으면 `DEFIB_USE_TIME_S`)에 퍽 `quick_heal` 이 얹힌다. */
function chargeTime(sys: WeaponSystem, def: ItemDef): number {
  return Math.max(0.05, sys.holdTimeOf(def));
}

/**
 * 지금 떼면 일으킬 아군이 걸려 있는가 — `GADGET_DEFIB_RANGE` 안의 **전투불능** 분대원 중 조준 광선에서 각이
 * `DEFIB_AIM_CONE_DEG` 이내인 것이 하나라도 있으면 true. 벽 뒤는 보지 않는다 (사거리가 5 m 라 의미가 없고,
 * gadgets 의 실제 소생 판정도 사거리만 본다 — 두 판정이 어긋나면 안 된다).
 */
function hasAimedAlly(sys: WeaponSystem, host: Host): boolean {
  const ctx = sys.ctx;
  const me = ctx.player;
  if (!me) return false;
  host.getAimRay(_o, _dir);
  _dir.normalize();
  const cos = Math.cos((DEFIB_AIM_CONE_DEG * Math.PI) / 180);
  const rangeSq = GADGET_DEFIB_RANGE * GADGET_DEFIB_RANGE;
  const aimed = (at: THREE.Vector3): boolean => {
    if (at.distanceToSquared(me.position) > rangeSq) return false;
    _to.copy(at); _to.y += CHEST_Y;
    _to.sub(_o);
    const len = _to.length();
    return len < 1e-3 || _to.dot(_dir) / len >= cos;
  };
  for (const r of ctx.net?.getRemotePlayers() ?? []) {
    if (!r.isDowned || r.stale) continue;
    if (aimed(r.position)) return true;
  }
  /* 2026-09-15 (안드로이드 분대원): 쓰러진 **안드로이드**도 같은 대상이다 — 여기가 「떼면 발동한다」 의 문이므로
   * (`releaseDefib` 의 `fire = armed && target`) gadgets 의 `findDownedAlly` 와 **같은 범위**를 봐야 한다. */
  for (const b of ctx.allies?.getBodies?.() ?? []) {
    if (!b.downed || b.dead || b.hidden || b.mode !== 'raid') continue;
    if (aimed(b.position)) return true;
  }
  return false;
}

/** `gadget:defibAim` (throttled). `force` = 시작 · 준비 완료 · 대상 변화 · 종료. */
function emit(sys: WeaponSystem, armed: boolean, charge: number, target: boolean, force: boolean): void {
  if (!force && sys.ctx.time - sys.defibEmitAt < 1 / EMIT_HZ) return;
  sys.defibEmitAt = sys.ctx.time;
  sys.ctx.bus.emit('gadget:defibAim', { armed, charge: THREE.MathUtils.clamp(charge, 0, 1), target });
}

/** 손을 떼거나 무기를 바꾸거나 죽었다: 크로스헤어를 닫고 이동 감속을 푼다. 아이템은 건드리지 않는다. */
export function cancelDefib(sys: WeaponSystem, quiet = true): void {
  if (!sys.defibHeld && !sys.defibArmed) { if (!quiet) emit(sys, false, 0, false, true); return; }
  sys.defibHeld = false;
  sys.defibArmed = false;
  sys.defibT = 0;
  sys.defibTarget = false;
  sys.setConsumableSlow(false);
  emit(sys, false, 0, false, true);
}

/**
 * 매 프레임, 제세동기를 손에 든 동안. 누르기 시작 → 충전 → 준비 완료(이동 감속 해제) → 겨눔 표시 →
 * **떼면** 발동(대상이 있을 때만 `useGadget`, 없으면 거부음 · 소모 없음).
 */
export function updateDefibHand(sys: WeaponSystem, dt: number, host: Host, q: QuickHand, usable: boolean, inputFree: boolean): void {
  const input = sys.ctx.input;
  if (!usable) { cancelDefib(sys); return; }
  const down = input.isMouseDown(MouseButtons.FIRE);

  if (!sys.defibHeld) {
    // 크로스헤어는 손에 든 순간부터 제세동기 모양이다 (Reticle 이 `quick:equipped` 로 안다) — 여기서는 누름만 본다.
    if (!inputFree || sys.quickCooldown > 0 || sys.quickHolsterT > 0) return;
    if (!input.wasMousePressed(MouseButtons.FIRE)) return;
    sys.defibHeld = true;
    sys.defibArmed = false;
    sys.defibT = 0;
    sys.defibTarget = false;
    sys.setConsumableSlow(true);
    emit(sys, false, 0, false, true);
    return;
  }

  if (!down) { releaseDefib(sys, host, q); return; }

  const dur = chargeTime(sys, q.def);
  let force = false;
  if (!sys.defibArmed) {
    sys.defibT += dt;
    if (sys.defibT >= dur) {
      sys.defibArmed = true;
      sys.defibT = dur;
      force = true;
      // 준비가 끝나면 감속을 푼다 — 준비한 채로 쓰러진 아군에게 **걸어가야** 하기 때문이다 (사용자 결정).
      sys.setConsumableSlow(false);
      sys.ctx.bus.emit('audio:play', { id: 'ui_click', volume: 0.5 });
    }
  }
  const target = sys.defibArmed && hasAimedAlly(sys, host);
  if (target !== sys.defibTarget) { sys.defibTarget = target; force = true; }
  emit(sys, sys.defibArmed, sys.defibArmed ? 1 : sys.defibT / dur, target, force);
}

/** 좌클릭을 뗐다. 준비 + 대상이면 일으키고, 아니면 불발 — **아이템은 소모되지 않는다**. */
function releaseDefib(sys: WeaponSystem, host: Host, q: QuickHand): void {
  const fire = sys.defibArmed && sys.defibTarget;
  sys.defibHeld = false;
  sys.defibArmed = false;
  sys.defibT = 0;
  sys.defibTarget = false;
  sys.setConsumableSlow(false);
  emit(sys, false, 0, false, true);
  if (!fire) { sys.deny(); return; }
  // 소모 · 사거리 재검사 · `buff revive` 는 전부 gadgets 안에 있다 (거절하면 아이템도 그대로다).
  sys.useGadget(host, q);
}
