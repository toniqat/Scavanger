/**
 * src/stratagems/model.ts — 함선 호출 폴더의 공용 어휘.
 *
 * `StratagemSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `StratagemSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `StratagemSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
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
} from './Visuals';

export type Host = PlayerRef & PlayerWeaponHost;

/** Wheel: pointer-locked drag (px) before a sector counts. */
export const WHEEL_DRAG_PX = 30;
/** Targeting ring / `stratagem:targeting` re-emit threshold (m). */
export const TARGET_EMIT_EPS = 0.2;
/** Laser damage tick (s). */
export const LASER_TICK = 0.25;
/** Airstrike FX length (s) before `stratagem:ended`. */
export const AIRSTRIKE_FX_TIME = 2.0;
/** Fall heights (m). */
export const SUPPLY_DROP_HEIGHT = 120;
export const STRUCTURE_DROP_HEIGHT = 60;
export const STRUCTURE_STAGGER = 0.15;
export const STRUCTURE_MIN_GAP = 2.4;
/** Grenade splash damage against structures (centre value, linear falloff). */
export const GRENADE_STRUCTURE_DAMAGE = 250;
/** `camera:shake` reach (m). */
export const SHAKE_RANGE = 60;

export const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();

export function defOf(id: StratagemId): StratagemDef {
  return STRATAGEM_DEFS.find((d) => d.id === id)!;
}
export function toTuple(v: THREE.Vector3): Vec3Tuple {
  return [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
}

/* ────────────────────────────── runtime records ────────────────────────────── */
export class Structure {
  hp = STRUCTURE_HP;
  landed = false;
  destroyed = false;
  remover: (() => void) | null = null;
  rubble: THREE.Group | null = null;
  readonly destructible: DestructibleRef;
  constructor(
    readonly id: string, readonly call: Call, readonly index: number,
    readonly position: THREE.Vector3, readonly landAt: number, readonly mesh: BarricadeMesh,
    onDamage: (s: Structure, amount: number) => void,
  ) {
    const self = this;
    this.destructible = {
      id, get hp() { return self.hp; }, maxHp: STRUCTURE_HP,
      onDamage(amount) { onDamage(self, amount); },
    };
  }
}

export class Call implements StratagemCall {
  stage: StratagemStage = 'incoming';
  /** Effect owner: this client called it (enemy damage is applied here only). */
  readonly local: boolean;
  readonly def: StratagemDef;
  marker: CallMarker | null = null;
  /* laser */
  beam: LaserBeam | null = null;
  nextTick = 0;
  /* airstrike */
  fireball: Fireball | null = null;
  /* supply */
  crate: SupplyCrateMesh | null = null;
  interactable: Interactable | null = null;
  obstacleRemover: (() => void) | null = null;
  looted = false;
  /* structures */
  structures: Structure[] = [];
  landedCount = 0;
  audioStarted = false;
  /* 구조선 (2026-09-09): 이 호출이 되살리는 분대원과 호출한 사람. 다른 종류에서는 null. */
  rescueTarget: string | null = null;
  rescueBy: string | null = null;
  constructor(
    readonly id: string, readonly kind: StratagemId, readonly position: THREE.Vector3,
    readonly landsAt: number, readonly caller: PeerId | null, readonly seed: number, local: boolean,
  ) {
    this.local = local;
    this.def = defOf(kind);
  }
}

/**
 * Ship calls (함선 호출). Publishes `ctx.stratagems`.
 *
 * Input state machine (gameplay only, pointer locked):
 *   idle ──G tap──▶ armed(last)      ──G tap / RMB──▶ idle
 *        ──G hold──▶ wheel ──release──▶ armed(hover)
 *   armed(topview def) ──LMB hold 3 s──▶ topview cursor ──LMB──▶ confirm / ──RMB, Esc──▶ armed
 *   armed(ground def)  = ring on the aim ray ──LMB──▶ confirm
 *   confirm → Call {incoming} → landsAt → effect (active) → done. One shared cooldown.
 * Every client simulates the effect FX + its own player's damage; enemy damage is applied on the caller's client only
 * (replica `applyExplosion` forwards to the host). Structures are placed from the call `seed`, so they match everywhere.
 */

