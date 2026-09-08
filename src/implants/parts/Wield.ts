/**
 * src/implants/parts/Wield.ts — **손에 드는 임플란트**와 프로필 연동.
 *
 * 대전차포와 방패는 손에 들리므로 총을 홀스터해야 하고(`blocksWeapons`), 무기 키를 누르면 집어넣어야
 * 한다(`stow`). 어떤 임플란트를 장착했는지는 진행도 프로필이 갖고 있으므로 그 적용도 여기서 한다.
 */
import * as THREE from 'three';
import {
  IMPLANT_AT_DAMAGE, IMPLANT_AT_RADIUS, IMPLANT_BARRIER_BLOCK_DAMAGE, IMPLANT_BARRIER_BREAK_LOCKOUT,
  IMPLANT_BARRIER_CARRY_OFFSET, IMPLANT_BARRIER_CARRY_REGEN,
  IMPLANT_BARRIER_CARRY_REGEN_DELAY, IMPLANT_BARRIER_CARRY_SPEED_MUL, IMPLANT_BARRIER_CARRY_WIDTH,
  IMPLANT_BARRIER_HP, IMPLANT_BARRIER_REGEN,
  IMPLANT_DASH_DISTANCE, IMPLANT_GRAPPLE_RANGE,
  IMPLANT_OVERCHARGE_ALLY_HEAL_PER_SEC, IMPLANT_OVERCHARGE_BUFF_HP_RATIO, IMPLANT_OVERCHARGE_ENERGY,
  IMPLANT_OVERCHARGE_RANGE, IMPLANT_OVERCHARGE_REGEN_TIME, IMPLANT_OVERCHARGE_SELF_HEAL_PER_SEC, IMPLANT_OVERCHARGE_SPEED_MUL,
  IMPLANT_SCAN_RADIUS, IMPLANT_SCAN_REVEAL_TIME_V2,
  IMPLANT_SHIELD_BASH_COOLDOWN, IMPLANT_SHIELD_BASH_DAMAGE, IMPLANT_SHIELD_BASH_KNOCKBACK, IMPLANT_SHIELD_BASH_RANGE, IMPLANT_SHIELD_BASH_STAMINA,
  IMPLANT_SHIELD_BASH_SWING_S,
  Keys, MouseButtons, PLAYER_RADIUS,
  type BuffMessage, type EnemyRef, type GameContext, type GameSystem, type ImplantDef, type ImplantId,
  type ImplantMessage, type ImplantsRef, type PeerId, type PlayerRef, type PlayerWeaponHost, type RelayTarget,
  type Vec3Tuple,
} from '@/shared';
import { IMPLANT_DEFS, getImplantDef, implantHex, isImplantId } from '../ImplantDefs';
import { ImplantDevice } from '../devices/ImplantDevice';
import { BarrierField } from '../effects/Barrier';
import { GrappleWire } from '../effects/Grapple';
import { RocketPool, type RocketImpact } from '../effects/AtLauncher';
import { OverchargeBeam, allyPoint, findAlly } from '../effects/Overcharge';
import { revealScan } from '../effects/Scan';
import { ImplantFx } from '../fx/ImplantFx';
import { RemoteImplants } from '../RemoteImplants';
import { ABSORB_RANGE, BARRIER_SEND_EVERY_HITS, BASH_FX_Y, BEAM_SEND_INTERVAL, BOOST_LINGER, BOOST_SEND_INTERVAL, BUMP_FX_INTERVAL, GRAPPLE_ARRIVE_DIST, GRAPPLE_FLY_SPEED, GRAPPLE_MAX_TIME, HEAL_SEND_INTERVAL, HUD_EMIT_INTERVAL, type Host, OVERCHARGE_MIN_START, SCAN_PULSE_FX_S, SHIELD_SPEED_KEY, _bp, _d, _from, _hitPt, _hp, _muzzle, _n, _o, _p, _r, _t, _tmp, tuple } from '../model';
import type { ImplantSystem } from '../ImplantSystem';

/**
 * 들쳐메기 gate (Phase 10): while a downed squadmate is on our shoulder every action but running first drops
 * them. `carrying` / `dropCarried` are probed defensively — player/ owns them and may register later.
 */
export function dropCarriedFirst(sys: ImplantSystem, p: PlayerRef): boolean {
  if ((p.carrying ?? null) === null) return false;
  if (typeof p.dropCarried === 'function') p.dropCarried('action');
  return true;
  }

/** Force the wielded implant away and end any channel (weapon swap, death, phase change). */
export function stow(sys: ImplantSystem): void {
  sys.releaseGrapple(true);
  sys.setOvercharge(false);
  if (!sys.wieldedFlag) return;
  const id = sys.equippedId;
  if (id === 'barrier') sys.lowerShield();
  sys.detachDevice();
  sys.wieldedFlag = false;
  if (id) {
    sys.ctx?.bus.emit('implant:wieldChanged', { id, wielded: false });
    sys.send({ t: 'imp', ev: 'wield', id, wielded: false });
  }
  }

export function applyProfile(sys: ImplantSystem, id: ImplantId | null): void {
  sys.profileApplied = true;
  if (id !== null && !isImplantId(id)) id = null;
  if (id === sys.equippedId) return;
  sys.stow();
  sys.equippedId = id;
  sys.resetRuntime();
  sys.emitCooldown(true);
  sys.emitBarrier();
  sys.emitEnergy(true);
  }

/** progression/ may register after us; pick up its saved implant as soon as it exists. */
export function applyProfileLazily(sys: ImplantSystem): void {
  if (sys.profileApplied) return;
  const prog = sys.ctx.progression;
  if (prog) { sys.applyProfile(prog.profile.implant); return; }
  if (sys.equippedId === null) {
    // offline / no profile yet: everyone owns all six, so hand out the first one instead of nothing
    sys.equippedId = IMPLANT_DEFS[0].id;
    sys.resetRuntime();
    sys.emitCooldown(true);
  }
  }

export function resetRuntime(sys: ImplantSystem): void {
  const def = sys.def();
  sys.chargesLeft = def?.charges ?? 0;
  sys.cdRemaining = 0;
  sys.cdTotal = sys.effectiveCooldown();
  sys.grappleState = 'idle';
  sys.grappleFlown = 0;
  sys.grappleTimer = 0;
  sys.grappleTargetValid = false;
  sys.bashTimer = 0;
  sys.bashCd = 0;
  sys.wire?.hide();
  sys.beam?.hide();
  sys.ocActive = false;
  sys.ocTarget = null;
  sys.ocHealAcc = 0;
  sys.ocEnergy = IMPLANT_OVERCHARGE_ENERGY;
  sys.holdingFlag = false;
  sys.barrierLocked = false;
  sys.barrierSinceHit = IMPLANT_BARRIER_CARRY_REGEN_DELAY;
  if (sys.barrier) { sys.barrier.lower(); sys.barrier.hp = IMPLANT_BARRIER_HP; }
  sys.clearShieldSpeed();
  sys.setGrapplePull(null);
  }

export function wield(sys: ImplantSystem): void {
  const def = sys.def();
  if (!def || def.mode !== 'wielded' || sys.wieldedFlag) return;
  if (def.id === 'barrier' && !sys.canRaiseShield()) return;
  sys.wieldedFlag = true;
  sys.device?.dispose();
  sys.device = new ImplantDevice(def.id);
  sys.deviceAttached = false;
  sys.attachDevice();
  if (def.id === 'barrier') sys.raiseShield();
  sys.ctx.bus.emit('implant:wieldChanged', { id: def.id, wielded: true });
  sys.ctx.bus.emit('audio:play', { id: 'implant_wield', volume: 0.6 });
  sys.send({ t: 'imp', ev: 'wield', id: def.id, wielded: true });
  }

export function attachDevice(sys: ImplantSystem): void {
  if (!sys.device || sys.deviceAttached) return;
  const socket = sys.weaponSocket();
  if (!socket) return;
  socket.add(sys.device.root);
  sys.deviceAttached = true;
  }

export function detachDevice(sys: ImplantSystem): void {
  if (!sys.device) return;
  sys.device.dispose();
  sys.device = null;
  sys.deviceAttached = false;
  }

export function weaponSocket(sys: ImplantSystem): THREE.Object3D | null {
  const p = sys.ctx.player as Host | null;
  if (!p || typeof p.getWeaponSocket !== 'function') return null;
  try { return p.getWeaponSocket(); } catch { return null; }
  }

/** Aim ray from the reticle; falls back to eye + horizontal forward when the host has no camera ray. */
export function aimRay(sys: ImplantSystem, origin: THREE.Vector3, dir: THREE.Vector3): boolean {
  const p = sys.ctx.player as Host | null;
  if (!p) return false;
  if (typeof p.getAimRay === 'function') { p.getAimRay(origin, dir); return true; }
  p.getEyePosition(origin);
  p.getForward(dir);
  return true;
  }

/**
 * World position an effect leaves from: the wielded device's muzzle, else the hand (weapon socket) so the
 * grapple wire and the overcharge beam start at the gun, else the eye.
 */
export function muzzle(sys: ImplantSystem, out: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
  if (sys.device && sys.deviceAttached) {
    sys.device.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(sys.device.muzzle.matrixWorld);
    return out;
  }
  const socket = sys.weaponSocket();
  if (socket) {
    socket.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(socket.matrixWorld);
    return out.addScaledVector(dir, 0.35);
  }
  const p = sys.ctx.player;
  if (p) { p.getEyePosition(out); out.addScaledVector(dir, 0.45); return out; }
  return out.set(0, 0, 0);
  }

export function localName(sys: ImplantSystem): string {
  return sys.ctx.net?.playerName ?? '스캐빈저';
  }
