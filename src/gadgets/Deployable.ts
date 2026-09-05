import * as THREE from 'three';
import type { DeployableKind, DeployableRef, GadgetId, PeerId } from '@/shared';
import type { GadgetVisual } from './GadgetVisuals';

/** Physical sizes used for collision / trigger tests (the gameplay radius lives in `GadgetDef.radius`). */
export const BARRICADE_HALF = new THREE.Vector3(2.1, 0.95, 0.2);
/** A mine goes off when something enters this radius (the blast radius is `GadgetDef.radius`). */
export const MINE_TRIGGER_RADIUS = 1.5;
/** Jump pad trigger radius (its visual pad is 1.5 m). */
export const JUMPPAD_TRIGGER_RADIUS = 1.7;
/** Seconds a dome shield takes to unfold before it starts blocking. */
export const DOME_UNFOLD_TIME = 0.6;

/**
 * One world deployable (turret, mine, barricade, dome shield, jump pad, smoke / fire / lure zone).
 *
 * Only the authority (single-player or the lobby host) simulates these; every other client holds a replica that
 * is created / updated / removed by the `gad` broadcast. All mutable state lives here so `GadgetSystem` stays
 * a dispatcher.
 */
export class Deployable implements DeployableRef {
  readonly position = new THREE.Vector3();
  yaw = 0;
  hp: number;
  readonly maxHp: number;
  armed: boolean;
  /** `ctx.time` when it expires, or 0 for "no expiry". */
  expires: number;
  /** Set by the system: routes damage to the authority (or a `gadq damage` request). */
  onDamage: ((d: Deployable, amount: number, from?: THREE.Vector3) => void) | null = null;

  /* per-kind runtime state (authority only) */
  /** Seconds since it was deployed. */
  age = 0;
  /** Turret: seconds until the next shot. */
  fireTimer = 0;
  /** Turret: enemy id currently tracked. */
  targetId: number | null = null;
  /** Turret head yaw (also animated on replicas so remote turrets track). */
  headYaw = 0;
  /** Lure / fire: seconds until the next AI / status tick. */
  tickTimer = 0;
  /** Jump pad: local re-trigger cooldown (per client). */
  padCooldown = 0;
  /** Host: throttles `gad update` broadcasts while it is being chewed on. */
  netCooldown = 0;
  /** true once removal was already dispatched (guards double removal). */
  removing = false;

  constructor(
    readonly id: string,
    readonly kind: DeployableKind,
    readonly owner: PeerId | 'local',
    readonly gadgetId: GadgetId,
    readonly radius: number,
    hp: number,
    maxHp: number,
    armed: boolean,
    expires: number,
    readonly visual: GadgetVisual,
  ) {
    this.hp = hp;
    this.maxHp = maxHp;
    this.armed = armed;
    this.expires = expires;
  }

  get object(): THREE.Object3D { return this.visual.root; }
  get hpRatio(): number { return this.maxHp > 0 ? THREE.MathUtils.clamp(this.hp / this.maxHp, 0, 1) : 1; }
  get destructible(): boolean { return this.maxHp > 0; }

  /** Enemies, friendly fire and explosions chew through deployables with this. */
  takeDamage(amount: number, from?: THREE.Vector3): void {
    if (!this.destructible || this.removing || amount <= 0) return;
    this.onDamage?.(this, amount, from);
  }

  /** Height of the visual centre above the ground — used for hit tests and prompts. */
  get centerHeight(): number {
    switch (this.kind) {
      case 'barricade': return BARRICADE_HALF.y;
      case 'turret': return 0.75;
      case 'domeShield': return this.radius * 0.5;
      case 'lure': return 0.6;
      case 'smoke': return this.radius * 0.5;
      default: return 0.2;
    }
  }
}
