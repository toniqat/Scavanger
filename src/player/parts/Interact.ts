/**
 * src/player/parts/Interact.ts — **E 상호작용**.
 *
 * 화면 안의 `Interactable` 중 가장 알맞은 것을 고르고, 탭 / 홀드를 구분해
 * `onHoldProgress` · `onHoldCancel` 을 흘린다(홀드 시간은 능력치의 영향을 여기서 한 번만 받는다).
 */
import * as THREE from 'three';
import type { PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, type SoldierPose } from '../SoldierModel';
import { CameraRig, type RigInput } from '../CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from '../PlayerController';
import { Hellpod, type HellpodEvents } from '../Hellpod';
import { PlayerGear } from '../PlayerGear';
import type { CarryEndReason, PortraitRef } from '@/shared';
import { PLAYER_CARRY_DROP_S, PLAYER_CARRY_OFFSET, PLAYER_CARRY_PICKUP_S, PLAYER_CARRY_RANGE, PLAYER_CARRY_SPEED_MUL } from '@/shared';
import type { CarryHost } from '../Carry';
import { createPortraits } from '../Portraits';
import { AUTO_REVIVE_DELAY_S, BURN_TICK, CLOAK_FADE, CLOAK_PROBE_INTERVAL, DEATH_ANIM, EXHAUSTED_SLOW, EXHAUSTED_SLOW_TIME, EYE_CROUCH, EYE_PRONE, EYE_ROLL, EYE_STAND, FADE_FAR, FADE_NEAR, GIVE_UP_PROGRESS_HZ, HOVER_AUTO_FALL, HOVER_STAMINA_DRAIN, INVULN_TIME, KNOCKBACK_MIN_LIFT, MELEE_SWING_TIME, type MeleeKind, SPAWN_RING_RADIUS, SPEEDMOD_ARMOR, SPEEDMOD_WEIGHT, STAMINA_JUMP_COST, STAMINA_REGEN_DELAY, STAMINA_REGEN_IDLE, STAMINA_REGEN_MOVING, STAMINA_SPRINT_DRAIN, STAMINA_SPRINT_RECOVER, STAND_UP_TIME, STIM_DURATION, type SpeedMod, type WeaponState, _camLook, _camPos, _dir, _q, _spawn, _up, _v } from '../model';
import type { PlayerSystem } from '../PlayerSystem';

/** Tell a hold interactable that its running hold was released / retargeted before completion. */
export function cancelHold(sys: PlayerSystem): void {
  const t = sys.interactTarget;
  if (t && sys.holdProgress > 0 && t.onHoldCancel) {
    try { t.onHoldCancel(); } catch (e) { console.error('[Player] onHoldCancel threw', e); }
  }
  sys.holdProgress = 0;
  }

export function updateInteraction(sys: PlayerSystem, dt: number, active: boolean): void {
  const ctx = sys.ctx, input = ctx.input;
  let target: Interactable | null = null;
  if (active && sys.interactCooldown <= 0) {
    sys.rig.getForward(_v);
    target = ctx.interactables.findBest(sys.controller.position, _v);
  }
  if (target !== sys.interactTarget) { sys.cancelHold(); sys.interactTarget = target; }
  if (!input.isDown(Keys.INTERACT)) sys.holdArmed = true;
  let text: string | null = null;
  if (target) {
    text = target.getPrompt();
    // 재주 (Phase 5): every hold interaction runs `derived.interactSpeedMul` times faster — applied here once, so
    // interactables publish their base `holdTime` and never scale it themselves.
    const hold = (target.holdTime ?? 0) / Math.max(0.25, ctx.progression?.derived.interactSpeedMul ?? 1);
    if (hold > 0) {
      if (input.isDown(Keys.INTERACT) && sys.holdArmed) {
        sys.holdProgress += dt / hold;
        if (sys.holdProgress >= 1) {
          sys.holdArmed = false;
          sys.perform(target); sys.holdProgress = 0; target = null; text = null;
        } else if (target.onHoldProgress) {
          try { target.onHoldProgress(sys.holdProgress); } catch (e) { console.error('[Player] onHoldProgress threw', e); }
        }
      } else if (sys.holdProgress > 0) {
        // released early: the hold decays; a relay-style interactable (revive) is told once
        sys.cancelHold();
      }
    } else if (input.wasPressed(Keys.INTERACT)) {
      sys.perform(target); target = null; text = null;
    }
  } else {
    sys.holdProgress = 0;
  }
  if (text !== sys.lastPromptText || sys.holdProgress !== sys.lastHoldProgress) {
    sys.lastPromptText = text; sys.lastHoldProgress = sys.holdProgress;
    ctx.bus.emit('interact:promptChanged', { text, holdProgress: sys.holdProgress });
  }
  }

export function perform(sys: PlayerSystem, target: Interactable): void {
  sys.interactCooldown = 0.35;
  sys.interactTarget = null;
  /*
   * 2026-09-09: a throwing `interact()` used to be a console line and nothing else — the prompt stayed up, the key
   * did nothing, and the player had no way to tell a bug from "the game ignores me" (that is exactly how a broken
   * pod boarding was reported). The catch stays — one bad interactable must not kill the frame — but it says so.
   */
  try {
    target.interact();
  } catch (e) {
    console.error('[Player] interact threw', e);
    sys.ctx.bus.emit('ui:notify', { text: '상호작용에 실패했습니다', kind: 'warning' });
  }
  sys.ctx.bus.emit('interact:performed', { id: target.id });
  sys.ctx.bus.emit('audio:play', { id: 'interact', position: target.position, volume: 0.7 });
  }
