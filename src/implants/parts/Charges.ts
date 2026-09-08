/**
 * src/implants/parts/Charges.ts — **쿨다운 · 충전 · 에너지 풀**.
 *
 * 임플란트를 쓸 수 있는지, 얼마나 남았는지 하나로 관리한다: 대시의 3충전, 오버차지의 에너지 풀,
 * 배리어 붕괴 후의 잠금, 그리고 `derived.implantCooldownMul` 이 곱해지는 지점.
 * 크로스헤어 왼쪽 세로 게이지가 읽는 이벤트(`implant:cooldown` / `energyChanged`)도 여기서 나간다.
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

/* ═══════════════════════════ charges & cooldown ═══════════════════════════ */
export function cooldownMul(sys: ImplantSystem): number {
  const mul = sys.ctx?.progression?.derived?.implantCooldownMul ?? 1;
  return Number.isFinite(mul) && mul > 0 ? mul : 1;
  }

export function effectiveCooldown(sys: ImplantSystem): number {
  const def = sys.def();
  if (!def) return 0;
  return def.cooldown * sys.cooldownMul();
  }

/** Charge-based implants may fire while a refill is running; single-charge ones may not. */
export function cdRemainingBlocking(sys: ImplantSystem): number {
  const def = sys.def();
  if (!def) return 1;
  return def.charges > 1 ? 0 : sys.cdRemaining;
  }

/** Spend one charge. `startCooldown` false = the caller starts it later (scan starts it when the train ends). */
export function useCharge(sys: ImplantSystem, startCooldown = true): boolean {
  if (!sys.ready) { sys.deny(); return false; }
  sys.chargesLeft--;
  // 2026-09-08: a refill already in flight is **never restarted**. A charge-based implant (대시, 3 charges) may
  //   fire while its refill timer runs (`cdRemainingBlocking` lets it), and the old unconditional `startCooldown()`
  //   reset that timer to full — so spending a charge also threw away the progress of the one that was recharging.
  //   A single-charge implant can never reach here with `cdRemaining > 0` (`ready` gates it).
  if (startCooldown && sys.cdRemaining <= 0) sys.startCooldown();
  sys.emitCooldown(true);
  return true;
  }

export function startCooldown(sys: ImplantSystem, seconds?: number): void {
  const t = seconds ?? sys.effectiveCooldown();
  if (t <= 0) return;
  sys.cdRemaining = t;
  sys.cdTotal = t;
  sys.emitCooldown(true);
  }

export function tickCooldown(sys: ImplantSystem, dt: number): void {
  if (dt <= 0) return;
  sys.hudAcc += dt;
  if (sys.cdRemaining <= 0) return;
  sys.cdRemaining = Math.max(0, sys.cdRemaining - dt);
  if (sys.cdRemaining === 0) {
    const def = sys.def();
    const max = def?.charges ?? 1;
    if (sys.chargesLeft < max) {
      sys.chargesLeft++;
      if (sys.chargesLeft < max) { sys.startCooldown(); return; }
    }
    if (sys.barrierLocked) { sys.barrierLocked = false; sys.barrier.hp = sys.barrier.maxHp; sys.emitBarrier(); }
    sys.emitCooldown(true);
    sys.ctx.bus.emit('audio:play', { id: 'implant_ready', volume: 0.4 });
    return;
  }
  if (sys.hudAcc >= HUD_EMIT_INTERVAL) sys.emitCooldown(false);
  }

export function emitCooldown(sys: ImplantSystem, force: boolean): void {
  const def = sys.def();
  if (!def || !sys.ctx) return;
  if (!force && sys.hudAcc < HUD_EMIT_INTERVAL) return;
  sys.hudAcc = 0;
  sys.ctx.bus.emit('implant:cooldownChanged', {
    id: def.id,
    remaining: sys.cdRemaining,
    total: sys.cdTotal || sys.effectiveCooldown(),
    charges: sys.chargesLeft,
    maxCharges: def.charges,
  });
  }

export function emitEnergy(sys: ImplantSystem, force: boolean): void {
  if (!sys.ctx || sys.equippedId !== 'overcharge') return;
  const e = Math.round(sys.ocEnergy * 20) / 20;
  if (!force && e === sys.lastEnergyEmitted) return;
  sys.lastEnergyEmitted = e;
  sys.ctx.bus.emit('implant:energyChanged', { energy: sys.ocEnergy, max: IMPLANT_OVERCHARGE_ENERGY });
  }

export function deny(sys: ImplantSystem): void {
  sys.ctx?.bus.emit('audio:play', { id: 'ui_deny', volume: 0.45 });
  }

export function activated(sys: ImplantSystem, id: ImplantId, position: THREE.Vector3): void {
  sys.ctx.bus.emit('implant:activated', { id, position: position.clone() });
  }

/* ═══════════════════════════ 오버차지 (hold Q, energy) ═══════════════════════════ */
/** Energy drains while channelling and refills from empty in IMPLANT_OVERCHARGE_REGEN_TIME while released. */
export function tickEnergy(sys: ImplantSystem, dt: number, def: ImplantDef | undefined): void {
  if (def?.id !== 'overcharge' || dt <= 0) return;
  if (sys.ocActive) return;                       // drained inside updateOvercharge
  if (sys.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) return;
  sys.ocEnergy = Math.min(IMPLANT_OVERCHARGE_ENERGY, sys.ocEnergy + dt * IMPLANT_OVERCHARGE_ENERGY / IMPLANT_OVERCHARGE_REGEN_TIME);
  sys.energyEmitAcc += dt;
  if (sys.energyEmitAcc >= HUD_EMIT_INTERVAL || sys.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) {
    sys.energyEmitAcc = 0;
    sys.emitEnergy(false);
    if (sys.ocEnergy >= IMPLANT_OVERCHARGE_ENERGY) sys.ctx.bus.emit('audio:play', { id: 'implant_ready', volume: 0.3 });
  }
  }
