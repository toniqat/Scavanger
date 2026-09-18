/**
 * src/shared/lightPool.ts — the **point-light pool**: it lights a scene that has many light positions with a few point
 * lights (born in `hub/interiors` on 2026-09-10 and moved to `shared` on 2026-09-11 — the ship and a planet's abandoned
 * structures use **the same rule**).
 *
 * A scene's point-light count is fixed for the whole session by `core/LightBudget` (it is part of the shader program
 * key, so a change recompiles everything). So there may be as many light **positions** (`LightFixture`) as you like,
 * while only `size` real lights are built and moved onto the **positions nearest the player**. Moving one lowers the
 * intensity to 0, moves it and raises it again — `visible` is never touched (that would change the count).
 */
import * as THREE from 'three';

/** A place a light would hang, and how it would shine. */
export interface LightFixture {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  /**
   * Walled-off area this fixture lights (e.g. shared deck 0, hangar 1). While the player stands in another zone the
   * fixture ranks `ZONE_PENALTY_M` farther away — a lamp behind a bulkhead is close but lights nothing you can see.
   */
  zone?: number;
}

/** Fraction of a fixture's intensity a pool light gains / loses per second (0.4 s fade — the old room-light rate). */
const RAMP_PER_S = 2.5;
/** Hysteresis (m): a lit fixture keeps its light until another one is at least this much closer to the player. */
const KEEP_BONUS_M = 1.5;
/** Below this a pool light counts as dark and may be moved to another fixture. */
const DARK = 0.02;
/** Extra ranking distance (m) of a fixture outside the player's zone (see `LightFixture.zone`) or on another floor. */
const ZONE_PENALTY_M = 25;
/**
 * 2026-09-11: the height difference (m) that counts as another storey. Pass `update(…, eyeY)` and a fixture whose height
 * differs from the eye height by more than this counts as another storey (beyond a floor plate) and takes
 * `ZONE_PENALTY_M` — so a basement lamp is not picked as the nearest one from underfoot on the ground floor.
 */
const FLOOR_GAP_M = 2.2;

export class LightPool {
  private readonly lights: THREE.PointLight[] = [];
  /** Fixture index each pool light serves (−1 = parked). */
  private readonly slot: number[] = [];
  private fixtures: readonly LightFixture[];
  private primed = false;
  private readonly score: number[] = [];
  private readonly order: number[] = [];
  private readonly free: number[] = [];

  constructor(parent: THREE.Object3D, size: number, fixtures: readonly LightFixture[] = [], name = 'PoolLight') {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 1, 2);
      l.name = name;
      l.castShadow = false;
      l.position.set(0, -100, 0);
      parent.add(l);
      this.lights.push(l);
      this.slot.push(-1);
    }
    this.fixtures = fixtures;
  }

  get size(): number { return this.lights.length; }
  /** Fixture index per pool light (−1 = parked). Debug / smoke. */
  get assignment(): readonly number[] { return this.slot; }
  /** Current candidate fixtures (same array identity the caller passed). */
  get fixtureList(): readonly LightFixture[] { return this.fixtures; }

  /**
   * Replace the candidate list (a room got lit / went dark). Fixtures are matched **by identity**, so a light keeps
   * serving a fixture that is still in the list; one whose fixture left fades out where it hangs.
   */
  setFixtures(list: readonly LightFixture[]): void {
    const old = this.fixtures;
    this.fixtures = list;
    for (let k = 0; k < this.slot.length; k++) {
      const f = this.slot[k] >= 0 ? old[this.slot[k]] : undefined;
      this.slot[k] = f ? list.indexOf(f) : -1;
    }
  }

  /**
   * Every frame with the player's XZ (and zone, −1 = zones ignored). `eyeY` (2026-09-11) adds the floor rule
   * (`FLOOR_GAP_M`); omit it for single-storey scenes. The first call snaps intensities (no fade-in on arrival).
   */
  update(dt: number, px: number, pz: number, zone = -1, eyeY?: number): void {
    const fixtures = this.fixtures;
    const n = fixtures.length;
    const size = this.lights.length;
    const score = this.score, order = this.order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      const f = fixtures[i];
      score[i] = Math.hypot(f.x - px, f.z - pz) - (this.slot.includes(i) ? KEEP_BONUS_M : 0)
        + (zone >= 0 && f.zone !== undefined && f.zone !== zone ? ZONE_PENALTY_M : 0)
        + (eyeY !== undefined && Math.abs(f.y - eyeY) > FLOOR_GAP_M ? ZONE_PENALTY_M : 0);
      order.push(i);
    }
    order.sort((a, b) => score[a] - score[b]);
    const wanted = Math.min(size, n);

    const free = this.free;
    free.length = 0;
    for (let w = 0; w < wanted; w++) if (!this.slot.includes(order[w])) free.push(order[w]);

    for (let k = 0; k < size; k++) {
      const l = this.lights[k];
      const f = this.slot[k];
      let target = 0;
      if (f >= 0 && order.indexOf(f) < wanted) {
        target = fixtures[f].intensity;
      } else if (l.intensity <= DARK || !this.primed) {
        const next = free.shift();
        if (next !== undefined) {
          const fx = fixtures[next];
          l.position.set(fx.x, fx.y, fx.z);
          l.color.setHex(fx.color);
          l.distance = fx.distance;
          this.slot[k] = next;
          target = fx.intensity;
        } else {
          this.slot[k] = -1;
        }
      }
      if (!this.primed) { l.intensity = target; continue; }
      const cur = this.slot[k] >= 0 ? fixtures[this.slot[k]].intensity : l.intensity;
      const rate = Math.max(cur, target, 1) * RAMP_PER_S * dt;
      l.intensity = target > l.intensity ? Math.min(target, l.intensity + rate) : Math.max(target, l.intensity - rate);
    }
    this.primed = true;
  }

  dispose(): void {
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    this.slot.length = 0;
  }
}
