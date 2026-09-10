/**
 * src/shared/lightPool.ts — **점광원 풀**: 광원 자리가 많은 장면을 점광원 몇 개로 비춘다 (2026-09-10 `hub/interiors`
 * 에서 태어나 2026-09-11 에 `shared` 로 옮겼다 — 함선과 행성의 버려진 구조물이 **같은 규칙**을 쓴다).
 *
 * 씬의 점광원 개수는 `core/LightBudget` 이 세션 내내 고정한다 (셰이더 프로그램 키에 들어가서, 바뀌면 전부 다시
 * 컴파일된다). 그래서 광원 **자리**(`LightFixture`)는 얼마든지 두되 진짜 광원은 `size` 개만 만들어 **플레이어에게
 * 가장 가까운 자리**로 옮겨 단다. 자리를 바꿀 때는 intensity 를 0 까지 내렸다가 옮기고 다시 올린다 —
 * `visible` 은 절대 건드리지 않는다 (개수가 변한다).
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
   * Walled-off area this fixture lights (e.g. shared deck 0, 격납고 1). While the player stands in another zone the
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
 * 2026-09-11: 층이 다르다고 보는 높이 차(m). `update(…, eyeY)` 를 주면 광원 자리와 눈높이의 차가 이보다 크면
 * 다른 층(바닥판 너머)으로 보고 `ZONE_PENALTY_M` 을 더한다 — 지하실 전등이 1층 발밑에서 가장 가깝다고 뽑히지 않게.
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
