/**
 * src/player/model.ts — the player folder's shared vocabulary.
 *
 * Only the constants · types · scratch vectors split out of `PlayerSystem`. It references no class, so a
 * `parts/*` module can use it without importing the class back (no circular import).
 * `PlayerSystem.ts` re-exports it as is, so every existing import path still resolves.
 */
import * as THREE from 'three';
import type { FurniturePoseKind, PlayerRestoreState } from '@/shared';
import {
  GameContext, Keys, MouseButtons, PLAYER_MAX_HP, PLAYER_MAX_STAMINA, PLAYER_RADIUS, PLAYER_WALK_SPEED,
  PLAYER_DOWN_HP, PLAYER_DOWN_BLEED_PER_SEC, PLAYER_DOWN_SPEED_MUL, PLAYER_REVIVE_HP, PLAYER_GIVE_UP_HOLD,
  ARMOR_DURABILITY_PER_DAMAGE, CLOAK_BREAK_TIME, CLOAK_DETECT_MUL, CLOAK_REVEAL_DISTANCE, MELEE_COOLDOWN, MELEE_STAMINA_COST,
  ROLL_COOLDOWN, ROLL_DAMAGE_MUL, ROLL_DURATION, ROLL_STAMINA_COST, SLASH_DURATION,
  type GameSystem, type PlayerRef, type PlayerWeaponHost, type Interactable, type Stance, type InteriorCollider,
} from '@/shared';
import { FxManager, ParticleBurst } from '@/core/fx';
import { damp, dampAngle, smoothstep, wrapAngle } from '@/core/util/MathUtil';
import { SoldierModel, type SoldierPose } from './SoldierModel';
import { CameraRig, type RigInput } from './CameraRig';
import { PlayerController, type MoveInput, type MoveResult, type ShipBounds } from './PlayerController';
import { Hellpod, type HellpodEvents } from './Hellpod';
import { PlayerGear } from './PlayerGear';
import type { CarryEndReason, PortraitRef } from '@/shared';
import { PLAYER_CARRY_DROP_S, PLAYER_CARRY_OFFSET, PLAYER_CARRY_PICKUP_S, PLAYER_CARRY_RANGE, PLAYER_CARRY_SPEED_MUL } from '@/shared';
import type { CarryHost } from './Carry';
import { createPortraits } from './Portraits';
/* appended (Phase 10): shouldering a downed squadmate + ready-panel portraits */

/** Phase 12 perk `auto_revive`: seconds between going down and the automatic stand-up. */
export const AUTO_REVIVE_DELAY_S = 1;

export const EYE_STAND = 1.55;
export const EYE_CROUCH = 1.15;
export const EYE_PRONE = 0.45;
/** Eye height at the top of the tumble (the rig keeps following the pivot). */
export const EYE_ROLL = 0.95;

/* ── tactical kit tuning (local; the shared numbers live in shared/constants) ── */
/** Melee swing animation length; must stay below MELEE_COOLDOWN. */
export const MELEE_SWING_TIME = 0.45;
/** Cloaked players are drawn semi-transparent for themselves too (remotes use the same value). */
export const CLOAK_FADE = 0.4;
/** How often the cloak checks for enemies inside CLOAK_REVEAL_DISTANCE (seconds). */
export const CLOAK_PROBE_INTERVAL = 0.25;
/** Burning DoT is applied in ticks so the HUD is not spammed 60×/s. */
export const BURN_TICK = 0.5;
/** Stamina drained per second while the tactical bag hovers. */
export const HOVER_STAMINA_DRAIN = 10;
/** Fall speed (m/s, negative) that auto-triggers the tactical bag's one free hover (prevents a fatal fall). */
export const HOVER_AUTO_FALL = -18;
/** Speed-modifier keys the player owns itself (external callers must not reuse them). */
export const SPEEDMOD_WEIGHT = 'weight';
export const SPEEDMOD_ARMOR = 'armor';
export const INVULN_TIME = 0.15;
export const STIM_DURATION = 1.5;
export const DEATH_ANIM = 0.9;
/** Phase 9: max rate of `player:giveUpProgress` while the Space give-up hold runs. */
export const GIVE_UP_PROGRESS_HZ = 20;
/** Minimum upward speed (m/s) a knockback carries so the feet leave the ground and the shove is not eaten by friction. */
export const KNOCKBACK_MIN_LIFT = 1.5;

// stamina tuning
export const STAMINA_SPRINT_DRAIN = 14;     // per second
export const STAMINA_JUMP_COST = 12;
export const STAMINA_REGEN_DELAY = 0.8;
export const STAMINA_REGEN_MOVING = 16;     // per second
export const STAMINA_REGEN_IDLE = 22;
export const STAMINA_SPRINT_RECOVER = 20;   // sprint unavailable after depletion until this much
export const EXHAUSTED_SLOW_TIME = 1.0;
export const EXHAUSTED_SLOW = 0.9;
export const STAND_UP_TIME = 0.35;          // prone → stand/crouch transition (no jump/sprint/roll)
export const SPAWN_RING_RADIUS = 4;         // multiplayer: per-slot drop offset around the shared spawn (m)
// near-clip body fade: fully visible beyond FADE_FAR m camera->pivot, hidden inside FADE_NEAR
export const FADE_FAR = 0.9;
export const FADE_NEAR = 0.45;

/* ── step smoothing · ladder (2026-09-11) — numbers in `STEP_SMOOTH_RATE` · `STEP_SMOOTH_MAX` (constants.csv) ── */
/** A one-frame height change smaller than this (m) is not smoothed — the body follows the terrain's undulation. */
export const STEP_SMOOTH_MIN = 0.04;
/**
 * Only a height change / horizontal move over this ratio is a "step". A slope (at most 50° ≈ 1.19) is continuous,
 * so smoothing it lifts the model off its feet or sinks it — a low rock · box edge · `SNAP_DOWN` jump far more.
 */
export const STEP_SLOPE_RATIO = 1.5;
/** Longest visual offset (m) the body is smoothed over when it snaps onto a ladder. */
export const CLIMB_GRAB_OFFSET_MAX = 2;
/** Rung sound volume: normal / fast. */
export const LADDER_STEP_VOLUME = 0.45;
export const LADDER_STEP_VOLUME_FAST = 0.6;

/* ── furniture poses (2026-09-12, `parts/FurniturePose`) — the body offsets live in `SoldierModel`'s `FURN_*` ── */
/** Damp rate of the pose blend (0 ↔ 1) — sitting · lying down · standing up finish in about 0.6 s. */
export const FURN_BLEND_RATE = 5;
/** Damp rate at which the body turns toward the pose's facing. */
export const FURN_YAW_RATE = 10;
/** Camera pivot (eye) height — **above the anchor**. The rocking chair has free look: this is its orbit centre. */
export const FURN_EYE: Readonly<Record<FurniturePoseKind, number>> = {
  sit: 0.85, bench: 0.45, run: EYE_STAND, cycle: 0.8,
  /* 2026-09-13 cooking: anchor = the floor and the body leans ~0.3 rad toward the cook bench — a little under the
     standing eye height (`SoldierModel.FURN_COOK`). */
  cook: 1.42,
};
/** Self-driven rates when the caller never sets a phase: a bench rep (s) · run steps / s · pedal revs / s. */
export const FURN_BENCH_REP_S = 2.6;
export const FURN_RUN_STEPS_PER_S = 2.8;
export const FURN_CYCLE_REV_PER_S = 1.2;
/** 2026-09-13 cooking: self-driven hand rate when `cook` gets no phase (cycles / s) — slow chopping · stirring. */
export const FURN_COOK_CYCLE_PER_S = 0.9;
/** `run` rides the walk cycle as is — the moveBlend · sprint blends fed in while it does. */
export const FURN_RUN_MOVE = 1.15;
export const FURN_RUN_SPRINT = 0.7;
/** E caption on a `releaseOnInteract` pose. */
export const FURN_STAND_PROMPT = '일어나기';
/** Remote nameplate: head height while posed = anchor + `FURN_EYE[kind]` + this (standing head 1.7 − eye 1.55). */
export const FURN_HEAD_ABOVE_EYE = 0.15;

/* ── furniture-pose shared math (2026-09-12 char buffs — local `parts/FurniturePose` and remote `RemoteAvatar`) ── */
/** Body (root) facing — on `bench` the head points at the rack, so the feet face the other way = `yaw + π`. */
export function furnitureBodyYaw(kind: FurniturePoseKind, yaw: number): number {
  return kind === 'bench' ? yaw + Math.PI : yaw;
}
/** One step of the pose blend (`FURN_BLEND_RATE`). */
export function stepFurnitureBlend(blend: number, on: boolean, dt: number): number {
  return damp(blend, on ? 1 : 0, FURN_BLEND_RATE, dt);
}
/** Root toward the anchor: `out` already holds the standing spot — pulled toward `anchor` by smoothstep(blend). */
export function lerpFurnitureRoot(out: THREE.Vector3, anchor: THREE.Vector3, blend: number): THREE.Vector3 {
  const e = blend * blend * (3 - 2 * blend);
  return out.lerp(anchor, e);
}
/**
 * The furniture-pose fields of `SoldierPose`. `cumPhase` is the **accumulated phase** (`FurniturePoseState.phase`
 * wire contract — bench 0…1 · run steps · cycle revolutions · cook hand cycles · sit 0). `run` rides the walk cycle
 * (`stridePhase = π × steps`), the rest let `SoldierModel.poseFurniture` own the skeleton (`cook` = the fractional
 * part, the position inside one cycle). The ordinary pose values (moveBlend · sprint …) must already be written
 * before this is called — `run` blends on top of them.
 */
export function writeFurniturePose(p: SoldierPose, kind: FurniturePoseKind | null, blend: number, cumPhase: number): void {
  if (kind === null) { p.furniture = 0; p.furnitureKind = null; p.furniturePhase = 0; return; }
  const ph = Number.isFinite(cumPhase) ? cumPhase : 0;
  p.furniture = blend;
  p.furnitureKind = kind;
  p.furniturePhase = kind === 'bench' || kind === 'sit' ? Math.min(1, Math.max(0, ph)) : ph - Math.floor(ph);
  if (kind !== 'run') return;
  const e = blend;
  p.moveBlend += (FURN_RUN_MOVE - p.moveBlend) * e;
  p.sprint += (FURN_RUN_SPRINT - p.sprint) * e;
  p.stridePhase = Math.PI * ph;
  p.airborne *= 1 - e;
  p.torsoTwist *= 1 - e;
  p.crouch *= 1 - e;
}
/** Recollect period (s) for the char buff list — catches eventless change, e.g. a gym debuff expiry (`Buffs`). */
export const BUFF_TICK_S = 1;

/** `PlayerSystem.furn` — the state of one furniture pose (only `parts/FurniturePose` uses it). */
export interface FurniturePoseState {
  /** The logical state (`PlayerRef.furniturePose`). null = no pose. */
  kind: FurniturePoseKind | null;
  /** The pose the model draws — it stays after the release until the blend reaches 0. */
  visKind: FurniturePoseKind | null;
  /** 0..1, damped by `FURN_BLEND_RATE`. */
  blend: number;
  releaseOnInteract: boolean;
  readonly anchor: THREE.Vector3;
  yaw: number;
  /** Whether a fixed camera was raised (`camPos` · `camLook` hold it). */
  hasCamera: boolean;
  readonly camPos: THREE.Vector3;
  readonly camLook: THREE.Vector3;
  /** Feet position · body facing · stance from just before the pose — a release returns to these. */
  readonly restorePos: THREE.Vector3;
  restoreYaw: number;
  restoreStance: Stance;
  /** Whether `setFurniturePoseDrive` was ever called (otherwise the pose drives itself). */
  driven: boolean;
  /** Phase 0..1 — the position inside a `bench` bar · `cycle` crank · `run` step. */
  phase: number;
  /**
   * `run`: steps taken · `cycle`: revolutions taken (+1 every time the phase wraps 1 → 0 — the feet must alternate).
   * 2026-09-12: the wire's **accumulated phase** is `steps + phase` (`furniturePoseState`).
   */
  steps: number;
  /** Self-drive clock (s). */
  clock: number;
  /** 2026-09-12: `FurniturePose.furnitureUid` (null when unknown) — buffs · the wire point at the furniture piece. */
  furnitureUid: string | null;
  /** 2026-09-12: the reused object `PlayerRef.furniturePoseState` returns (`anchor` is the same Vector3 as above). */
  readonly wire: { kind: FurniturePoseKind; anchor: THREE.Vector3; yaw: number; phase: number; furnitureUid: string | null };
}

export function createFurniturePoseState(): FurniturePoseState {
  const anchor = new THREE.Vector3();
  return {
    kind: null, visKind: null, blend: 0, releaseOnInteract: false,
    anchor, yaw: 0,
    hasCamera: false, camPos: new THREE.Vector3(), camLook: new THREE.Vector3(),
    restorePos: new THREE.Vector3(), restoreYaw: 0, restoreStance: 'stand',
    driven: false, phase: 0, steps: 0, clock: 0,
    furnitureUid: null,
    wire: { kind: 'sit', anchor, yaw: 0, phase: 0, furnitureUid: null },
  };
}

export const _v = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _spawn = new THREE.Vector3();
export const _q = new THREE.Quaternion(), _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3();
export const _dir = new THREE.Vector3();

export interface WeaponState {
  hasWeapon: boolean; reloading: boolean; firing: boolean; twoHanded: boolean; throwing: boolean; holdingItem: boolean;
  /* unique weapons (2026-09-06): braced charge stance, continuous hip spray, heavy hip carry */
  charging: boolean; spraying: boolean; heavy: boolean;
  /* Phase 7: pin pulled (grenade cooking) — optional hint, remotes get it from the COOKING flag */
  cooking: boolean;
}
/** Melee swing kinds: `light` = the F chop (MELEE_SWING_TIME), `heavy` = the `용검` two-hand slash (SLASH_DURATION). */
export type MeleeKind = 'light' | 'heavy';

/** One entry of the multiplicative speed-modifier stack (`setSpeedModifier`). */
export interface SpeedMod { mul: number; until: number }

/**
 * Third-person player: controller + camera rig + procedural soldier + health/stims + stamina +
 * stances (C crouch / Z prone / Alt dive) + interaction + hellpod drop + downed / revive / respawn (Phase 2).
 * Publishes itself as `ctx.player` (PlayerRef & PlayerWeaponHost).
 */
