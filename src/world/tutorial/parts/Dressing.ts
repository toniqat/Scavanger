import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Random } from '@/shared';
import type { ObstacleEntry, SpatialHash } from '../../SpatialHash';
import {
  BARRIER, BARRIER_GHOST_OVERLAP, BARRIER_LEN, BARRIER_MESH_YAW, CLIFF2_EDGE_Z, CRAWL, DECK_LOWER_Y,
  DECK_UPPER_Y, DRESSING_SEED, PIT, PIT_RAMP_TOE_X, PIT_WALLS, RUINS, SHIP_POS, SHIP_SLOPE, SHIP_YAW, barrierLocal,
  barrierPoint, box, corridorHalfXAt, crawlClearanceAt, inAbyssCut, inChasm, pitSurfaceY, rectContains, shipHillSurfaceY,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * Hand-built structures — the start ruins · the collapsed corridor (the crawl stretch) · the diagonal barrier (blind wire fence) · rubble.
 *
 * One rule: **only what has a collider is drawn large, and what has none is kept below toe height.** That is what keeps
 * "the visible silhouette is the collider" (`CLAUDE.md`) from breaking. 0 lights, and everything that looks lit is emissive.
 *
 * 2026-09-14 2nd pass (corridor narrowed): every x that touches the corridor comes from `corridorHalfXAt(z)` — copying a constant
 * half-width buries a prop in a wall or pokes it out past one every time the corridor profile changes. The start ruins' five walls
 * are on a narrow stretch, so they were moved inward by hand (once more in the 3rd pass, when the half-width went 11 → 7.7).
 *
 * 2026-09-14 3rd pass — **the floor dressing was removed from stretches that are passed through.** Where the body is lowered to get
 * through, as in the crawl stretch, a prone body passes straight through collider-less rubble and it draws the eye. The rebar that
 * hung below the ceiling was removed for the same reason (the head went through it).
 *
 * 2026-09-15 — the old 「collapsed wall」 (crossing the corridor, open only for 5 m in the middle) became the **diagonal barrier**
 * (`buildBarrier`). Every dimension and arithmetic check is in `model.ts`'s `BARRIER` · `PIT_WALLS` comments.
 *
 * 2026-09-15 2nd pass (user's decision) — the fence is drawn at **half height** (2.7 → 1.35, ×1.5 again on 2026-09-17) but the collider lays a `passRays` + `passSmall`
 * **ghost band** on top so only people are blocked (`BARRIER.blockHeight`). Every slat dimension is now derived from `BARRIER.fenceHeight`.
 * And since the last two androids stand in the **pit** (`model.ts`'s `PIT`, the ground is `parts/Ground.buildPit`), rubble inside the pit
 * went down to the height `pitSurfaceY` answers.
 *
 * 2026-09-15 3rd pass (user's decision) — ① the concrete `BACKSTOP` is gone: the wall that stops a grenade is now the rock wall around the
 * pit (`model.ts`'s `PIT_WALLS`, `parts/Ground.buildPit`) and only the rubble at its foot is placed here. ② Abyss cuts (`ABYSS_CUTS`) appeared
 * beyond the fence, so rubble skips `inAbyssCut` spots (they would float). ③ The **fallen antenna mast** at the waking spot, which lay in the
 * middle of the corridor with no collider, moved beside the left ruin wall and was given a box collider matching its silhouette (`buildRuins`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The maximum height of something drawn with no collider (walked over without catching a foot — below `PROP_STEP_UP_MAX` 0.9). */
const FLAT_DEBRIS_H = 0.35;

/*
 * The blind wire fence's drawing dimensions. **All of them derived from the height (`BARRIER.fenceHeight`)** — when the 2026-09-15 2nd pass
 * halved it 2.7 → 1.35, the old fixed sizes (slat 0.12 + gap 0.18, base 0.25) fitted only three slats. 2026-09-17 raised it again
 * (×1.5 → 2.025) and every number below followed on its own:
 *   One pitch `SLAT_PITCH` = height / (`SLAT_COUNT` + 1) = 2.025 / 6 = **0.3375** (the topmost pitch is where the rail and the wire go)
 *   Slat `SLAT_H` = 40 % of the pitch = 0.135, gap 0.2025 → **the gap is 60 %**, so the far side is visible (the 2026-09-15 ratio kept).
 *   Base `SLAT_BASE` = 80 % of the pitch = 0.27 → the top slat's top face 0.27 + 4 × 0.3375 + 0.135 = **1.755 m**, the top rail 1.905 … 2.005 —
 *   all **below** the fence height 2.025, so nothing drawn stands above the collider that judges a grenade thrown over it.
 * The slats are two layers at ±`SLAT_FACE` (0.55) from the barrier centreline — 5 cm inside the collider faces (±0.6), so a bullet mark stands just in front of a slat.
 * Both layers' slats sit at the same height so their gaps line up, and the vertical angle that sees through a gap goes up to atan(0.2025 / 1.1) = **10.4°**.
 *   ⚠ That angle decides 「is the far side visible from a distance」: since 2026-09-17 the top face is above standing eye height (1.55), so the far
 *   side is never **seen over** it any more. The sight line onto an android in the pit (chest = deck +0.27, the nearest 9.95 m beyond the fence)
 *   runs down at **7.3°** at most — standing right against the fence — and flattens further back, so it stays inside the gap angle at every
 *   distance and the far side is **seen between the slats from anywhere** (`model.ts`'s `BARRIER` arithmetic check).
 */
const SLAT_COUNT = 5, SLAT_T = 0.04;
const SLAT_PITCH = BARRIER.fenceHeight / (SLAT_COUNT + 1);
const SLAT_H = SLAT_PITCH * 0.4, SLAT_GAP = SLAT_PITCH - SLAT_H, SLAT_BASE = SLAT_PITCH * 0.8;
const SLAT_FACE = BARRIER.halfT - 0.05;
const RAIL_H = 0.1;
/** The height of the concrete sill under the fence — below the first slat (`SLAT_BASE`). */
const SILL_H = SLAT_PITCH * 0.7;
/** Post spacing (m) — the fence run is split into bays no longer than this. */
const POST_STEP_M = 3;
/**
 * The maximum length of one barrier collider (m). As one plate its circumscribed circle would be 17.5 m, `SpatialHash.maxRadius` would grow
 * past the deck tile's (11.3) and **every** hash query would slow down (the same reason as `DECK_TILE_M`). Seams overlap by `BARRIER_JOIN_M`.
 */
const BARRIER_COLLIDER_MAX_M = 12;
const BARRIER_JOIN_M = 0.05;

export class Dressing {
  readonly group = new THREE.Group();
  private entries: ObstacleEntry[] = [];
  private disposables: Array<{ dispose(): void }> = [];

  constructor() { this.group.name = 'TutorialDressing'; }

  build(root: THREE.Group, hash: SpatialHash): void {
    root.add(this.group);
    const rng = new Random(DRESSING_SEED);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x776d5e, roughness: 0.95, metalness: 0.05, emissive: 0x141210, emissiveIntensity: 0.55 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x6b4530, roughness: 0.9, metalness: 0.25, emissive: 0x120a06, emissiveIntensity: 0.6 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x5a5e60, roughness: 0.7, metalness: 0.3, emissive: 0x0b0c0d, emissiveIntensity: 0.6 });
    this.disposables.push(concrete, rust, steel);

    const solid: THREE.BufferGeometry[] = [];   // concrete that carries a collider
    const flat: THREE.BufferGeometry[] = [];    // floor rubble (no collider)
    const metal: THREE.BufferGeometry[] = [];   // the wire fence (its collider is one barrier block)

    this.buildRuins(hash, solid, flat, rng);
    this.buildCrawl(hash, solid, rng);
    this.buildBarrier(hash, solid, metal, flat, rng);
    this.scatterRubble(flat, rng);

    this.addMerged(solid, concrete, 'tut-concrete');
    this.addMerged(flat, rust, 'tut-debris');
    this.addMerged(metal, steel, 'tut-fence');
  }

  /* ── Start ruins: a few broken walls around the waking spot, and the fallen antenna ── */
  private buildRuins(hash: SpatialHash, solid: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_UPPER_Y;
    // Five half-standing walls — they ring the waking spot (0, 112) but leave the front (−Z) open.
    // 2026-09-14 3rd pass: this stretch's half-width shrank to 7.7 and a wall bites up to 1.1 inward (`Ground`'s bite, which on a
    // narrow stretch shrinks by the same ratio to (4 × 0.55 × 0.5) = 1.1), so the inner face is at |x| 6.6 at the least. Every ruin
    // prop therefore stays within **|x| ≤ 6.5** (the real x range is beside each row below).
    const walls: Array<[number, number, number, number, number]> = [
      // x, z, length, yaw, height                  // the x it occupies
      [-3.2, 116, 6.0, 0, 3.4],                     // −6.20 … −0.20
      [3.2, 115, 5.6, 0.12, 2.6],                   //   0.37 …  6.03
      [-5.9, 107, 9, Math.PI / 2, 3.0],             // −6.35 … −5.45
      [5.5, 104, 12, Math.PI / 2 + 0.08, 2.2],      //   4.57 …  6.43
      [-2.8, 98, 5, 0.25, 1.9],                     // −5.33 … −0.27
    ];
    for (const [x, z, len, yaw, h] of walls) {
      solid.push(box(len, h, 0.9, x, y + h / 2, z, yaw));
      this.addBox(hash, x, y, z, len / 2, 0.45, yaw, h, 'tut_ruin');
      // The collapsed pieces at the wall's foot
      flat.push(box(len * 0.6, FLAT_DEBRIS_H, 2.2, x + rng.range(-1, 1), y + FLAT_DEBRIS_H / 2, z + rng.range(-2, 2), yaw + 0.1));
    }
    /* The fallen antenna mast — 2026-09-15 3rd pass (user's decision — 「the decorative mast in the middle of the waking spot lies there with no collider, which is odd」):
     * moved from the middle of the corridor (old x −2.92 … 5.72 · z 109) **beside the left ruin wall**, laid along the corridor, and given a box
     * collider matching its silhouette (length 9 · diameter 0.9 → height 0.85). 0.85 < `PROP_STEP_UP_MAX` 0.9, so it can be stepped onto but not passed through.
     * Position: centre (−4.45, 104.5), slightly skewed (0.06 rad) → x −5.17 … −3.73 · z 100 … 109. It clears the left wall piece (x −6.35 … −5.45,
     * z 102.5 … 111.5) by 0.28 m and the front wall piece (z ≤ 99.05) by 0.95 m, and stays inside the walls' inner face (|x| ≥ 6.6), so it is not buried in a wall. */
    const mastYaw = Math.PI / 2 + 0.06;
    const mast = new THREE.CylinderGeometry(0.35, 0.45, 9, 8);
    mast.rotateZ(Math.PI / 2);
    mast.rotateY(mastYaw);
    mast.translate(-4.45, y + 0.4, 104.5);
    solid.push(mast);
    this.addBox(hash, -4.45, y, 104.5, 4.5, 0.45, mastYaw, 0.85, 'tut_ruin');
    // One piece of pod wreckage — the only prop that says "this is where it fell". x −3.83 … 0.23
    solid.push(box(3.2, 2.0, 2.6, -1.8, y + 1.0, 118.5, 0.5));
    this.addBox(hash, -1.8, y, 118.5, 1.6, 1.3, 0.5, 2.0, 'tut_ruin');
  }

  /**
   * The collapsed corridor — blocked by wreckage on both sides so only `CRAWL.gapHalfX` is open, with a slab covering it.
   *
   * 2026-09-14 3rd pass (user's decision):
   *   - The slab was **tilted** (`CRAWL.slabSlope`) — it reads as 「wreckage that collapsed and sank」. The drawing is one tilted box
   *     and **the collider is `CRAWL.slabSegments` plates** of axis-aligned box (the underside is the value at that piece's middle).
   *   - The **thin rebar** that hung below the ceiling **was removed** (it went through the head passing under it).
   *   - The **floor rubble plates** on the way through **were removed too** (a prone body passed through them).
   *
   * 2026-09-14 4th pass: the slope's **sign flipped** (it rises from entrance to exit), 7 segments, thickness 2.4.
   * 2026-09-15: the entrance rose 1.35 → **1.70** (a crouched head's top 1.55 + 0.15), so the slope got gentler.
   * The formulas in this file did not change by a line either time — both the drawing's centre (`clearance + slabThickness / 2`) and the
   * collider's base are **measured from the underside**, so a thicker slab grows upward only, and `crawlClearanceAt` answers the slope
   * with its sign. The arithmetic checks (both ends · each segment's underside · the head's top) are all in the `CRAWL` comment.
   */
  private buildCrawl(hash: SpatialHash, solid: THREE.BufferGeometry[], rng: Random): void {
    const y = DECK_UPPER_Y;
    const zMid = (CRAWL.z0 + CRAWL.z1) / 2, depth = CRAWL.z0 - CRAWL.z1;
    const corridor = corridorHalfXAt(zMid);
    for (const sx of [-1, 1]) {
      const inner = sx * CRAWL.gapHalfX, outer = sx * corridor;
      const cx = (inner + outer) / 2, half = Math.abs(outer - inner) / 2;
      const h = 5.2;
      solid.push(box(half * 2, h, depth, cx, y + h / 2, zMid));
      this.addBox(hash, cx, y, zMid, half, depth / 2, 0, h, 'tut_crawl');
      // A few lumps that break up the wreckage pile's silhouette (the blocked side, so they go on with no collider)
      for (let i = 0; i < 4; i++) {
        const s = rng.range(1.2, 2.6);
        solid.push(box(s, s * 0.7, s, cx + rng.range(-half * 0.6, half * 0.6), y + h - 0.2, zMid + rng.range(-depth / 2, depth / 2), rng.range(0, 1)));
      }
    }
    // The slab overhead — the drawing is one tilted box (rotateX(−atan(slope)), so the underside's dy/dz is `slabSlope` itself:
    // from the 4th pass slope is negative, so the smaller z is (= the further out), the higher it sits)
    const slabW = CRAWL.gapHalfX * 2 + 1.2;
    const slab = new THREE.BoxGeometry(slabW, CRAWL.slabThickness, depth);
    slab.rotateX(-Math.atan(CRAWL.slabSlope));
    slab.translate(0, y + CRAWL.clearance + CRAWL.slabThickness / 2, zMid);
    solid.push(slab);
    // The collider is one axis-aligned box per segment — the underside is the slab height at that segment's middle
    const segD = depth / CRAWL.slabSegments;
    for (let i = 0; i < CRAWL.slabSegments; i++) {
      const zc = CRAWL.z0 - segD * (i + 0.5);
      this.addBox(hash, 0, y + crawlClearanceAt(zc), zc, slabW / 2, segD / 2, 0, CRAWL.slabThickness, 'tut_crawl');
    }
  }

  /**
   * The diagonal barrier (2026-09-15) — a **horizontal blind wire fence** between two concrete blocks, plus the rubble at the foot
   * of the pit walls. (The concrete `BACKSTOP` that used to stand behind the androids was retired in the 2026-09-15 3rd pass —
   * what stops a grenade now is the rock wall around the pit, `model.ts`'s `PIT_WALLS` built by `parts/Ground.buildPit`.)
   *
   * Every piece is placed in barrier coordinates (`barrierPoint(along, depth)`): turning `box()`'s local +X by `BARRIER_MESH_YAW` gives the
   * barrier direction, and local +Z becomes the near-side normal (rotateY(θ) sends +Z to (sin θ, cos θ) = (−0.685, 0.728)).
   * The collider passes the **mesh yaw** into `addBox`, which flips the sign there (comment at the end of the file).
   *
   * The fence's collider is not the slats but **the whole block**, and from the 2026-09-15 2nd pass it is **two layers** — the lower one (up to
   * the drawn `BARRIER.fenceHeight`) blocks bullets and enemy sight as well, and the upper one (up to `blockHeight`) is a `passRays` + `passSmall` ghost that blocks only people and enemies (the table in the `BARRIER` comment).
   */
  private buildBarrier(
    hash: SpatialHash, solid: THREE.BufferGeometry[], metal: THREE.BufferGeometry[], flat: THREE.BufferGeometry[], rng: Random,
  ): void {
    const y = DECK_LOWER_Y;
    const yaw = BARRIER_MESH_YAW;
    const T = BARRIER.halfT * 2;
    const fence0 = BARRIER.solidFarM, fence1 = BARRIER_LEN - BARRIER.solidNearM;

    // ① The two concrete blocks (the `far` end · the `near` end)
    for (const [a0, a1] of [[0, fence0], [fence1, BARRIER_LEN]] as const) {
      const c = barrierPoint((a0 + a1) / 2, 0);
      const h = BARRIER.solidHeight;
      solid.push(box(a1 - a0, h, T, c.x, y + h / 2, c.z, yaw));
      this.addBox(hash, c.x, y, c.z, (a1 - a0) / 2 + BARRIER_JOIN_M, BARRIER.halfT, yaw, h, 'tut_barrier');
    }
    // The `far` end post — it finishes thickly the end seen from the gap (inside the collider, the same height as the concrete — the liftoff camera starts 3 m to the side)
    {
      const c = barrierPoint(0.3, 0);
      solid.push(box(0.6, BARRIER.solidHeight, T + 0.1, c.x, y + BARRIER.solidHeight / 2, c.z, yaw));
    }
    // The broken top of the `near` end block (toward the right wall — far from the camera and the gap)
    for (let i = 0; i < 4; i++) {
      const s = rng.range(0.5, 1.1);
      const p = barrierPoint(rng.range(fence1 + 0.8, BARRIER_LEN - 2.5), rng.range(-0.25, 0.25));
      solid.push(box(s * 1.4, s * 0.6, T * 0.8, p.x, y + BARRIER.solidHeight + s * 0.3 - 0.15, p.z, yaw + rng.range(-0.2, 0.2)));
    }

    // ② The blind wire fence
    const fenceLen = fence1 - fence0;
    const bays = Math.max(1, Math.ceil(fenceLen / POST_STEP_M));
    const bay = fenceLen / bays;
    const H = BARRIER.fenceHeight;
    {
      const c = barrierPoint(fence0 + fenceLen / 2, 0);
      solid.push(box(fenceLen, SILL_H, T - 0.1, c.x, y + SILL_H / 2, c.z, yaw));
    }
    for (let i = 0; i <= bays; i++) {
      const c = barrierPoint(fence0 + bay * i, 0);
      metal.push(box(0.14, H, T - 0.1, c.x, y + H / 2, c.z, yaw));
    }
    for (let i = 0; i < bays; i++) {
      const mid = fence0 + bay * (i + 0.5);
      for (const face of [-1, 1]) {
        const c = barrierPoint(mid, face * SLAT_FACE);
        for (let k = 0; k < SLAT_COUNT; k++) {
          const sy = y + SLAT_BASE + k * (SLAT_H + SLAT_GAP) + SLAT_H / 2;
          metal.push(box(bay - 0.14, SLAT_H, SLAT_T, c.x, sy, c.z, yaw));
        }
        metal.push(box(bay, RAIL_H, 0.08, c.x, y + H - RAIL_H / 2 - 0.02, c.z, yaw));
      }
      // Zigzag wire running between the two rails (the barbed wire)
      const zig = Math.max(2, Math.round(bay / 0.6));
      for (let k = 0; k < zig; k++) {
        const a0 = fence0 + bay * i + (bay * k) / zig, a1 = a0 + bay / zig;
        const d0 = (k % 2 === 0 ? -1 : 1) * SLAT_FACE;
        const p0 = barrierPoint(a0, d0), p1 = barrierPoint(a1, -d0);
        const dx = p1.x - p0.x, dz = p1.z - p0.z;
        metal.push(box(Math.hypot(dx, dz), 0.025, 0.025, (p0.x + p1.x) / 2, y + H - 0.05, (p0.z + p1.z) / 2, -Math.atan2(dz, dx)));
      }
    }
    /* The fence collider — **two layers** (2026-09-15 2nd pass, `model.ts`'s `BARRIER` comment):
     *   lower `y … y + fenceHeight`      an ordinary block — it blocks people · enemies · bullets · grenades (the drawn fence's height).
     *   upper `… y + blockHeight`        a `passRays` + `passSmall` **ghost band** — bullets · enemy sight · grenades pass through and
     *                                    only people (0.45) · enemies are pushed out. So although it looks half height it **cannot be climbed over**.
     * The two layers overlap by `BARRIER_GHOST_OVERLAP` — on exactly the same line a point on that line can fall out of both.
     * The length is split to `BARRIER_COLLIDER_MAX_M` or less and seams overlap by `BARRIER_JOIN_M`. */
    const pieces = Math.max(1, Math.ceil(fenceLen / BARRIER_COLLIDER_MAX_M));
    const ghostBase = y + H - BARRIER_GHOST_OVERLAP;
    const ghostH = y + BARRIER.blockHeight - ghostBase;
    for (let i = 0; i < pieces; i++) {
      const a0 = fence0 + (fenceLen * i) / pieces, a1 = fence0 + (fenceLen * (i + 1)) / pieces;
      const c = barrierPoint((a0 + a1) / 2, 0);
      const halfLen = (a1 - a0) / 2 + BARRIER_JOIN_M;
      this.addBox(hash, c.x, y, c.z, halfLen, BARRIER.halfT, yaw, H, 'tut_fence');
      const ghost = this.addBox(hash, c.x, ghostBase, c.z, halfLen, BARRIER.halfT, yaw, ghostH, 'tut_fence_ghost');
      ghost.passRays = true;
      ghost.passSmall = true;
    }

    /* ③ Rubble at the foot of the pit walls (2026-09-15 3rd pass) — the walls themselves are ground (`parts/Ground.buildPit`, `PIT_WALLS`). A few flat
     * pieces are placed at the **pit floor height** along the inner foot of the east and south walls (a grenade rolls to rest here, so no collider — `FLAT_DEBRIS_H`). */
    for (let i = 0; i < 3; i++) {
      const px = PIT.x1 - rng.range(0.5, 1.3), pz = PIT.z0 - rng.range(1, PIT.z0 - PIT.z1 - 1.5);
      flat.push(box(rng.range(0.7, 1.4), FLAT_DEBRIS_H, rng.range(0.6, 1.2), px, (pitSurfaceY(px, pz) ?? y) + FLAT_DEBRIS_H / 2, pz, rng.range(0, Math.PI)));
    }
    for (let i = 0; i < 3; i++) {
      const px = rng.range(PIT_RAMP_TOE_X + 1.5, PIT.x1 - 1.5), pz = PIT.z1 + rng.range(0.5, 1.3);
      flat.push(box(rng.range(0.8, 1.8), FLAT_DEBRIS_H, rng.range(0.5, 1.0), px, (pitSurfaceY(px, pz) ?? y) + FLAT_DEBRIS_H / 2, pz, rng.range(0, Math.PI)));
    }
  }

  /**
   * 2026-09-15 — where floor rubble is not scattered: at the barrier's foot (it looks half buried inside the collider) and on
   * **the abandoned ship's footprint** (0.35 m of rubble comes up through the cargo bay floor and the ramp). The ship-local coordinates use the
   * same formula as `extraction/Ship.bayLocal`, with clearance around the hull x ±5.25 · z −9.7 … the ramp's end +3.25.
   *
   * 2026-09-15 2nd pass — **the pit's ramp** is excluded too. Rubble is a flat box turned by yaw only, so on the 19.8° slope one end
   * floats 0.25 m and the other is buried. The flat **floor** is not excluded — `scatterRubble` takes the height down through
   * `pitSurfaceY`, so rubble lies inside the pit too (a bare rim with nothing in it reads as a dug hole).
   *
   * 2026-09-15 3rd pass — **the foot of the pit walls** (`PIT_WALLS` + 0.5 m — it would be buried in the wall) and **the abyss cuts beyond the
   * fence** (`inAbyssCut`, out to 0.6 m from the edge — deck-height rubble would float) are excluded too.
   *
   * 2026-09-16 — **the ship hill's ramp** (`SHIP_SLOPE`) is excluded too (the same reason as the pit ramp). The hill top is not excluded; rubble goes at the `shipHillSurfaceY` height.
   */
  private blocksRubble(x: number, z: number): boolean {
    const b = barrierLocal(x, z);
    if (b.along > -1.5 && b.along < BARRIER_LEN + 1.5 && Math.abs(b.depth) < BARRIER.halfT + 1.2) return true;
    if (pitSurfaceY(x, z) !== null && x < PIT_RAMP_TOE_X) return true;
    if (inAbyssCut(x, z, 0.6)) return true;
    if (rectContains(SHIP_SLOPE, x, z)) return true;   // 2026-09-16 the ship hill ramp — the same reason as the pit ramp (it is tilted)
    for (const w of PIT_WALLS) {
      if (x >= w.rect.x0 - 0.5 && x <= w.rect.x1 + 0.5 && z <= w.rect.z0 + 0.5 && z >= w.rect.z1 - 0.5) return true;
    }
    const c = Math.cos(SHIP_YAW), s = Math.sin(SHIP_YAW);
    const dx = x - SHIP_POS.x, dz = z - SHIP_POS.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < 6 && lz > -10.5 && lz < 4.2;
  }

  /* ── Floor rubble scattered over the whole corridor (none of it has a collider) ── */
  private scatterRubble(flat: THREE.BufferGeometry[], rng: Random): void {
    for (let i = 0; i < 90; i++) {
      const z = rng.range(-160, RUINS.z0);
      // Kept 2 m off the walls — on a narrow stretch measured from that stretch's half-width (the rng call order is unchanged)
      const lim = Math.max(2.5, corridorHalfXAt(z) - 2);
      const x = rng.range(-lim, lim);
      // 2026-09-15 2nd pass: inside the pit, at the pit floor height — at deck height it would look 0.9 m off the ground. 2026-09-16: on the ship hill, at the hill height (else buried)
      const y = pitSurfaceY(x, z) ?? shipHillSurfaceY(x, z) ?? (z > CLIFF2_EDGE_Z ? DECK_UPPER_Y : DECK_LOWER_Y);
      if (inChasm(x, z, 1.5)) continue;        // nothing in chasm 1's gap (2026-09-14 3rd pass: it is diagonal)
      // The crawl stretch — a prone body is seen passing through collider-less rubble (2026-09-14 3rd pass)
      if (z <= CRAWL.z0 + 1 && z >= CRAWL.z1 - 1) continue;
      if (this.blocksRubble(x, z)) continue;   // the barrier's foot · the pit ramp · the pit walls · abyss cuts · the ship's footprint (2026-09-15)
      const w = rng.range(0.4, 1.6);
      flat.push(box(w, FLAT_DEBRIS_H * rng.range(0.5, 1), w * rng.range(0.5, 1.4), x, y + FLAT_DEBRIS_H / 2, z, rng.range(0, Math.PI)));
    }
  }

  /**
   * ⚠ `yaw` is the **mesh's `rotateY`** value. `Obstacle.box.yaw` is the math convention with the opposite sign (`world/obb.ts`'s
   * `toLocal` · the same comment in `extraction/Hull`), so it is flipped once here — without the flip a tilted ruin wall's collider
   * becomes a **mirror image** of the drawn plate (fixed in the 2026-09-14 2nd pass).
   */
  private addBox(
    hash: SpatialHash, x: number, y: number, z: number, hx: number, hz: number, yaw: number, height: number, kind: string,
  ): ObstacleEntry {
    const e = hash.addBox(new THREE.Vector3(x, y, z), hx, hz, -yaw, height, kind);
    this.entries.push(e);
    return e;
  }

  private addMerged(parts: THREE.BufferGeometry[], mat: THREE.Material, name: string): void {
    if (parts.length === 0) return;
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.disposables.push(merged);
  }

  dispose(hash: SpatialHash): void {
    for (const e of this.entries) hash.remove(e);
    this.entries.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}
