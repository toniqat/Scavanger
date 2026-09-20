/**
 * src/stratagems/parts/Targeting.ts — **the G wheel and targeting**.
 *
 * A G tap arms straight away, a hold picks from the 4-way wheel. Once picked, aiming is either the ground ring
 * or, after a `STRATAGEM_CHARGE_TIME` left-click charge, the **top view** with a cursor on the ground.
 * Right click / Esc cancels.
 */
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
} from '@/shared';
import {
  SharedGeo, TargetRing, CallMarker, Burst, dustBurst, sparkBurst, LaserBeam, Fireball, SupplyCrateMesh, BarricadeMesh, makeRubble, KIND_COLOR,
} from '../Visuals';
import { AIRSTRIKE_FX_TIME, Call, GRENADE_STRUCTURE_DAMAGE, type Host, LASER_TICK, SHAKE_RANGE, STRUCTURE_DROP_HEIGHT, STRUCTURE_MIN_GAP, STRUCTURE_STAGGER, SUPPLY_DROP_HEIGHT, Structure, TARGET_EMIT_EPS, WHEEL_DRAG_PX, _a, _b, _dir, defOf, toTuple } from '../model';
import * as Rescue from './Rescue';
import type { StratagemSystem } from '../StratagemSystem';

/* ─────────────────────────── input ─────────────────────────── */
export function updateInput(sys: StratagemSystem, dt: number): void {
  const ctx = sys.ctx, input = ctx.input;
  const host = sys.host();
  const active = sys.baseActive();
  if (!active || !host) {
    if (sys.topview || sys.wheelOpen || sys.charge >= 0) sys.cancelTargeting();
    if (ctx.player && (ctx.player.isDead || ctx.player.isDowned)) sys.putAway();
    sys.setGroundTargeting(false);
    sys.gHeld = false;
    return;
  }

  /*
   * 2026-09-11 drone control: the input belongs to the drone — G is ignored and an open wheel · charge · top view
   * is closed (the armed call is left alone; the ground ring is turned off). `canUseWeapons()` is false too, so
   * the paths below are blocked anyway, but opening the wheel reads G before that.
   */
  // 2026-09-13: inside the rover (`roverRide`) is the same — the body is inside the hull, so nothing can be called
  if (ctx.player?.droneControl || ctx.player?.roverRide) {
    if (sys.topview || sys.wheelOpen || sys.charge >= 0) sys.cancelTargeting();
    sys.setGroundTargeting(false);
    sys.gHeld = false;
    return;
  }

  if (sys.topview) { sys.updateTopview(dt, host); return; }

  /* ── G: tap = arm last / put away, hold = wheel ── */
  if (input.wasPressed(Keys.SHIP_CALL)) { sys.gHeld = true; sys.gHoldT = 0; }
  if (sys.gHeld) {
    if (!input.isDown(Keys.SHIP_CALL)) {
      sys.gHeld = false;
      if (sys.wheelOpen) {
        const hover = sys.wheelHover;
        sys.closeWheel(host);
        if (hover) sys.arm(hover);
      } else if (sys._armed) sys.disarm();
      else sys.arm(sys.lastArmed);
    } else {
      sys.gHoldT += dt;
      if (!sys.wheelOpen && sys.gHoldT >= STRATAGEM_WHEEL_HOLD && host.canUseWeapons()) {
        /*
         * 2026-09-10 (user's decision): **the wheel does not open at all while the cooldown runs.** All four calls
         * share the one cooldown, so opening it would show no armable sector — it ends with the deny sound + a
         * toast, and the hold is cut here (`gHeld = false`) so `arm` does not raise the same toast again on
         * release.
         */
        if (sys._cooldown > 0) { sys.gHeld = false; denyCooldown(sys); return; }
        sys.wheelOpen = true; sys.wheelDX = 0; sys.wheelDY = 0; sys.wheelHover = null;
        sys.cancelCharge();
        host.setLookLocked(true);
        ctx.bus.emit('stratagem:wheelChanged', { open: true, hover: null });
        sys.audio('ui_open', undefined, 0.35);
      }
      if (sys.wheelOpen) sys.updateWheel(input.mouseDX, input.mouseDY);
      return;
    }
  }
  if (sys.wheelOpen) return;

  const armed = sys._armed;
  if (!armed) { sys.setGroundTargeting(false); return; }
  if (!host.canUseWeapons()) { sys.cancelCharge(); sys.setGroundTargeting(false); return; }
  const def = defOf(armed);

  if (def.targeting === 'ground') {
    /*
     * 2026-09-09 rescue drop: the squadmate picker comes **before** ground targeting. That screen holds a blocker,
     * so this normally never runs, but the pin is here so the ring cannot flicker on a frame where it is not up yet.
     */
    if (armed === 'rescue_drop' && sys._rescueTarget === null) {
      sys.setGroundTargeting(false);
      if (input.wasMousePressed(MouseButtons.AIM)) sys.disarm();
      return;
    }
    sys.setGroundTargeting(true);
    sys.updateGroundCursor(host);
    if (input.wasMousePressed(MouseButtons.AIM)) { sys.disarm(); return; }
    if (input.wasMousePressed(MouseButtons.FIRE) && sys.targetValid) sys.confirm(def);
    return;
  }

  /* topview def: LMB charge */
  if (input.wasMousePressed(MouseButtons.AIM)) { sys.disarm(); return; }
  if (input.isMouseDown(MouseButtons.FIRE)) {
    if (sys.charge < 0) sys.charge = 0;
    sys.charge = Math.min(1, sys.charge + dt / STRATAGEM_CHARGE_TIME);
    ctx.bus.emit('stratagem:chargeChanged', { t: sys.charge });
    if (sys.charge >= 1) { sys.charge = -1; ctx.bus.emit('stratagem:chargeChanged', { t: -1 }); sys.enterTopview(host); }
  } else if (sys.charge >= 0) sys.cancelCharge();
  }

export function cancelCharge(sys: StratagemSystem): void {
  if (sys.charge < 0) return;
  sys.charge = -1;
  sys.ctx.bus.emit('stratagem:chargeChanged', { t: -1 });
  }

export function updateWheel(sys: StratagemSystem, dx: number, dy: number): void {
  sys.wheelDX += dx; sys.wheelDY += dy;
  let hover: StratagemId | null = null;
  if (sys.wheelDX * sys.wheelDX + sys.wheelDY * sys.wheelDY >= WHEEL_DRAG_PX * WHEEL_DRAG_PX) {
    // 0 = N (up), clockwise; snapped to the 4 cardinal sectors → STRATAGEM_ORDER (N, E, S, W)
    const ang = Math.atan2(sys.wheelDX, -sys.wheelDY);
    const idx = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
    hover = STRATAGEM_ORDER[idx];
  }
  if (hover !== sys.wheelHover) {
    sys.wheelHover = hover;
    sys.ctx.bus.emit('stratagem:wheelChanged', { open: true, hover });
    if (hover) sys.audio('ui_click', undefined, 0.3);
  }
  }

export function closeWheel(sys: StratagemSystem, host: Host): void {
  if (!sys.wheelOpen) return;
  sys.wheelOpen = false; sys.wheelHover = null;
  host.setLookLocked(false);
  sys.ctx.bus.emit('stratagem:wheelChanged', { open: false, hover: null });
  }

/** The refusal while the shared cooldown runs — opening the wheel and arming use the same sound · same text. */
function denyCooldown(sys: StratagemSystem): void {
  sys.audio('ui_deny', undefined, 0.6);
  sys.ctx.bus.emit('ui:notify', { text: `함선 지원 재충전 중 (${Math.ceil(sys._cooldown)}초)`, kind: 'warning', duration: 1.5 });
}

export function arm(sys: StratagemSystem, id: StratagemId): void {
  if (sys._cooldown > 0) { denyCooldown(sys); return; }
  /*
   * 2026-09-09: the gate for the host-only calls (`궤도 폭격` · `항공 폭탄`) and for the rescue drop — the wheel
   * greys out on the same rule.
   */
  const blocked = Rescue.armBlockReason(sys, id);
  if (blocked) {
    sys.audio('ui_deny', undefined, 0.6);
    sys.ctx.bus.emit('ui:notify', { text: blocked, kind: 'warning', duration: 2 });
    return;
  }
  sys._rescueTarget = null;
  sys.cancelCharge();
  sys.setGroundTargeting(false);   // re-enabled next frame for ground defs
  sys._armed = id; sys.lastArmed = id;
  const def = defOf(id);
  sys.ring.setKind(id, def.radius);
  sys.ctx.bus.emit('stratagem:armed', { id });
  sys.audio('ui_equip', undefined, 0.6);
  }

export function disarm(sys: StratagemSystem): void {
  sys.cancelCharge();
  sys.setGroundTargeting(false);
  sys._rescueTarget = null;
  if (sys._armed === null) return;
  sys._armed = null;
  sys.ctx.bus.emit('stratagem:armed', { id: null });
  }

/** Leave any targeting and put the call away. */
export function putAway(sys: StratagemSystem): void {
  sys.cancelTargeting();
  sys.disarm();
  }

/* ─────────────────────────── ground targeting ─────────────────────────── */
export function setGroundTargeting(sys: StratagemSystem, on: boolean): void {
  if (on === sys.groundTargeting) return;
  sys.groundTargeting = on;
  sys.ring.show(on);
  if (!on) {
    sys.lastEmitted.set(NaN, NaN, NaN); sys.targetValid = false;
    sys.ctx.bus.emit('stratagem:targeting', { active: false, kind: null, position: null });
  }
  }

export function updateGroundCursor(sys: StratagemSystem, host: Host): void {
  const world = sys.world();
  if (!world) { sys.targetValid = false; sys.ring.show(false); return; }
  host.getAimRay(_a, _dir);
  const hit = world.raycast(_a, _dir, GROUND_TARGET_RANGE);
  if (hit) sys.cursor.copy(hit.point);
  else {
    sys.cursor.copy(_a).addScaledVector(_dir, GROUND_TARGET_RANGE);
    sys.cursor.y = world.getHeightAt(sys.cursor.x, sys.cursor.z);
  }
  // keep the point within range of the player (a hit far below the horizon can exceed it) and inside the map
  const p = host.position;
  _b.set(sys.cursor.x - p.x, 0, sys.cursor.z - p.z);
  const d = _b.length();
  if (d > GROUND_TARGET_RANGE) {
    _b.multiplyScalar(GROUND_TARGET_RANGE / d);
    sys.cursor.set(p.x + _b.x, 0, p.z + _b.z);
    sys.cursor.y = world.getHeightAt(sys.cursor.x, sys.cursor.z);
  }
  sys.targetValid = world.isInsideBounds(sys.cursor.x, sys.cursor.z);
  sys.ring.show(sys.targetValid);
  sys.ring.animate(sys.cursor, sys.ctx.time);
  sys.emitTargeting();
  }

export function emitTargeting(sys: StratagemSystem): void {
  if (!sys._armed) return;
  if (sys.lastEmitted.distanceToSquared(sys.cursor) < TARGET_EMIT_EPS * TARGET_EMIT_EPS) return;
  sys.lastEmitted.copy(sys.cursor);
  sys.ctx.bus.emit('stratagem:targeting', { active: true, kind: sys._armed, position: sys.cursor });
  }

export function enterTopview(sys: StratagemSystem, host: Host): void {
  if (sys.topview || !sys._armed) return;
  sys.topview = true;
  sys.needRelease = true;
  host.setControlsEnabled(false);
  host.setLookLocked(true);
  const pos = host.position.clone(); pos.y += TOPVIEW_HEIGHT; pos.z += 0.001;
  host.setCameraOverride(pos, host.position.clone(), false);
  sys.cursor.copy(host.position);
  const world = sys.world();
  if (world) sys.cursor.y = world.getHeightAt(sys.cursor.x, sys.cursor.z);
  sys.ring.show(true);
  sys.ring.animate(sys.cursor, sys.ctx.time);
  sys.lastEmitted.set(NaN, NaN, NaN);
  sys.emitTargeting();
  sys.audio('ui_open', undefined, 0.5);
  }

export function updateTopview(sys: StratagemSystem, _dt: number, host: Host): void {
  const input = sys.ctx.input;
  const world = sys.world();
  if (!world) { sys.cancelTargeting(); return; }
  // cursor: screen right = world +X, screen up = world −Z (camera above the player looking down, up = −Z)
  const dx = input.mouseDX * TOPVIEW_CURSOR_SPEED, dz = input.mouseDY * TOPVIEW_CURSOR_SPEED;
  if (dx !== 0 || dz !== 0) {
    const px = sys.cursor.x, pz = sys.cursor.z;
    sys.cursor.x += dx; sys.cursor.z += dz;
    const p = host.position;
    _b.set(sys.cursor.x - p.x, 0, sys.cursor.z - p.z);
    const d = _b.length();
    if (d > TOPVIEW_RANGE) { _b.multiplyScalar(TOPVIEW_RANGE / d); sys.cursor.x = p.x + _b.x; sys.cursor.z = p.z + _b.z; }
    if (!world.isInsideBounds(sys.cursor.x, sys.cursor.z)) { sys.cursor.x = px; sys.cursor.z = pz; }
    sys.cursor.y = world.getHeightAt(sys.cursor.x, sys.cursor.z);
  }
  sys.ring.animate(sys.cursor, sys.ctx.time);
  sys.emitTargeting();

  if (!input.isMouseDown(MouseButtons.FIRE)) sys.needRelease = false;
  if (input.wasMousePressed(MouseButtons.AIM)) { sys.cancelTargeting(); return; }
  if (!sys.needRelease && input.wasMousePressed(MouseButtons.FIRE) && sys._armed) sys.confirm(defOf(sys._armed));
  }

/** Leave the top view / wheel / charge, restoring camera + controls. Keeps the armed call. */
export function cancelTargeting(sys: StratagemSystem): void {
  const host = sys.host();
  sys.cancelCharge();
  if (sys.wheelOpen && host) sys.closeWheel(host);
  else if (sys.wheelOpen) { sys.wheelOpen = false; sys.wheelHover = null; sys.ctx.bus.emit('stratagem:wheelChanged', { open: false, hover: null }); }
  if (!sys.topview) return;
  sys.topview = false;
  if (host) {
    host.setCameraOverride(null);
    host.setControlsEnabled(true);
    host.setLookLocked(false);
  }
  sys.ring.show(false);
  sys.lastEmitted.set(NaN, NaN, NaN);
  sys.ctx.bus.emit('stratagem:targeting', { active: false, kind: null, position: null });
  }

/* ─────────────────────────── confirm / calls ─────────────────────────── */
export function confirm(sys: StratagemSystem, def: StratagemDef): void {
  const target = sys.cursor.clone();
  const seed = (Math.random() * 0xffffffff) >>> 0;
  sys.cancelTargeting();
  sys.setGroundTargeting(false);
  sys.startCooldown(def.cooldown);
  sys._armed = null;
  sys.ctx.bus.emit('stratagem:armed', { id: null });
  /*
   * 2026-09-09: the rescue drop does not create the call here — the **host**, who holds the squad-wide count, has
   * to grant it, and the call only stands once that `rescue grant` comes back (single-player grants it on the spot).
   */
  if (def.id === 'rescue_drop') {
    const who = sys._rescueTarget;
    sys._rescueTarget = null;
    sys.audio('ui_click', undefined, 0.6);
    if (who) sys.confirmRescue(who, target);
    return;
  }
  sys.audio('ui_click', undefined, 0.6);
  const net = sys.ctx.net;
  /*
   * 2026-09-11 (E-4) **relayed by the host**: a squadmate does not stand the call up here but sends `stratq call`
   * to the host. The host checks kind · host-only · that caller's cooldown · inside the map · range and
   * re-broadcasts `strat call {by}`; that message comes back to me too (`by === me` → `local`) and the call stands
   * then — a call already carries a `delay` of several seconds, so the one hop is not felt. A refusal stands it up
   * nowhere (the cooldown already started — the same as a lost frame).
   */
  if (sys.ctx.isMultiplayer && net && !net.isHost) {
    const callId = `${net.localId ?? 'sp'}-${++sys.seq}`;
    net.send({ t: 'stratq', ev: 'call', callId, kind: def.id, p: toTuple(target), seed }, 'host');
    return;
  }
  const call = sys.createCall(def.id, target, def.delay, seed, true);
  if (sys.ctx.isMultiplayer && net) {
    net.send({ t: 'strat', ev: 'call', callId: call.id, kind: def.id, p: toTuple(target), eta: def.delay, seed, by: net.localId ?? undefined }, 'others');
  }
  }
