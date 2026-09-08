/**
 * src/implants/parts/Wire.ts — **임플란트의 네트워크 경로** (`imp` / `buff`).
 *
 * 방패 상태 · 오버차지 빔 · 실드 배쉬 · 정찰 스캔을 분대에 알리고, 남이 보낸 것을 우리 월드에 적용한다.
 * 정찰은 결과가 아니라 **시전 사실**만 보내고(`imp scanCast`) 각 피어가 자기 월드에서 드러낸다.
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

/* ═══════════════════════════ networking ═══════════════════════════ */
export function ensureNetHooks(sys: ImplantSystem): void {
  const net = sys.ctx?.net;
  if (!net || sys.netHooked) return;
  sys.netHooked = true;
  sys.unsubs.push(
    net.onMessage('imp', (m, from) => sys.onImplantMessage(m, from)),
    net.onMessage('buff', (m, from) => sys.onBuff(m, from)),
    // Phase 9 / 10: a late joiner learns our shield is raised (the snapshot only carries the BARRIER flag + bhp)
    net.onMessage('flow', (m, from) => {
      if (m.ev === 'rejoined' && sys.barrier?.active && from !== net.localId) sys.sendShield(true, from);
    }),
  );
  }

export function send(sys: ImplantSystem, msg: ImplantMessage, to: RelayTarget = 'others'): void {
  const ctx = sys.ctx;
  if (!ctx?.isMultiplayer || !ctx.net) return;
  ctx.net.send(msg, to);
  }

export function sendBuff(sys: ImplantSystem, msg: BuffMessage, to: PeerId): void {
  const ctx = sys.ctx;
  if (!ctx?.isMultiplayer || !ctx.net) return;
  ctx.net.send(msg, to);
  }

export function onImplantMessage(sys: ImplantSystem, m: ImplantMessage, from: PeerId): void {
  if (from === sys.ctx.net?.localId) return;
  sys.remote.handle(m, from);
  }

/**
 * Friendly effects aimed at *us* by someone else. Each `buff` kind has exactly one receiver: implants/ applies
 * the overcharge `heal` / `boost`; `revive` (defibrillator) and `cloak` belong to gadgets/ (Phase 9: the duplicate
 * `revive` branch here is gone).
 */
export function onBuff(sys: ImplantSystem, m: BuffMessage, _from: PeerId): void {
  const p = sys.ctx.player;
  if (!p) return;
  switch (m.kind) {
    case 'heal':
      if (p.isDead || p.isDowned) return;
      p.heal(m.amount);
      break;
    case 'boost':
      sys.applyBoost(p, m.amount > 0 ? m.amount : IMPLANT_OVERCHARGE_SPEED_MUL, m.duration || BOOST_SEND_INTERVAL + BOOST_LINGER);
      break;
    default:
      break;
  }
  }

/**
 * Overcharge buff on a player. The `'overcharge'` modifier key is the contract with player/: while it is
 * live the player runs faster and reports `isOvercharged` (weapons reads that for the fire-rate bonus).
 * `setSpeedModifier` is part of the tactical-kit contract, so it is probed defensively.
 */
export function applyBoost(sys: ImplantSystem, p: PlayerRef, mul: number, duration: number): void {
  if (typeof p.setSpeedModifier === 'function') p.setSpeedModifier('overcharge', mul, duration);
  }
