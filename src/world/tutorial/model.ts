import * as THREE from 'three';
import {
  PLAYER_HEIGHT, TUTORIAL_ENEMY_LEASH_M, TUTORIAL_ENEMY_SENSE_M,
  type TutorialCheckpointId, type TutorialEnemySpawn, type TutorialFallRule,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * The tutorial planet — **the shape of the map itself** (2026-09-14, `docs/DECISIONS.md` 「2026-09-14 — 튜토리얼 개편」).
 *
 * This file is `world/tutorial/`'s shared vocabulary (the `model.ts` + `parts/` convention in `CLAUDE.md`): coordinates ·
 * dimensions · types · small geometry helpers only, no state. **The numbers here never go out to csv** — they are not
 * balance values but the shape of hand-built terrain, and `TrainingArena.ts` decided the same first (lane x · diagonal z ·
 * ceiling height). What is balance (enemy sense · leash · fall damage · respawn delay) all comes from `data/constants.csv`.
 *
 * ## Coordinate convention
 * **Forward = −Z** (the front of player yaw 0 = `(-sin 0, 0, -cos 0)` = −Z). So every z below runs **from a large value
 * to a small one** (`z0 > z1`), and reading the order of the stretches is reading the order of play.
 * **+x = the right hand of a walking player**: right = forward × up = `(0,0,−1) × (0,1,0)` = `(1,0,0)`.
 * (So 「left」 in the enemy · prop comments below is x < 0 and 「right」 is x > 0.)
 * x is side to side, and the corridor half-width **differs per stretch** (`CORRIDOR_PROFILE` · `corridorHalfXAt`); outside
 * it is cliff wall the whole way, so the player has no way off the corridor.
 *
 * ## Why 「deck boxes」 and not terrain (a heightfield)
 * The two cliffs are the core of this map, and a heightfield **cannot make a vertical face**. Dropping 10 m over a 1 m
 * grid gives an 84° slope, past `PlayerController`'s `STEEP_COS` (50°), so a body **slides down it** — fall damage is 0
 * (it stays grounded) and both 「run and cross it」 and 「jump down」 are gone. So the floor (`VOID_Y`) is left as one flat
 * plate and the walkable decks stand as **box colliders** (`SpatialHash.addBox`): the side face is a full wall and stepping
 * past the edge falls. Structure floor plates and the tram deck already live that way, so `getSurfaceY` · `resolveCollision`
 * do not change one line. Only cliff 1's edge is **diagonal**, so two more rotated OBBs are used (the `CHASM_TILT` section below).
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── Level heights ───────────────────────────────────────────────────────── */

/**
 * **The terrain height** (`TutorialWorld.heightAt` · `raycastGround`) — what a body reaches where this map has no collider at all.
 * 2026-09-15 −34 → **−100**: the front of the ship was opened into a **bottomless cliff** (`ABYSS_*`), but `heightAt` is a
 * constant with no arguments (`WorldSystem` calls it as `heightAt()`), so it cannot be deepened just there. At −34 a body that
 * jumped off dies standing 24 m below an **invisible floor**. So the whole terrain went down and only cliff 1's floor stayed at
 * its old height, as the `CHASM_FLOOR_Y` collider. Fall time: from the lower deck (−10) 90 m = √(2·90/24) = **2.74 s** → `kill`.
 */
export const VOID_Y = -100;
/**
 * **Cliff 1's chasm floor** (the old `VOID_Y`). No longer terrain but a box collider (`parts/Ground`), and the chasm floor plate is
 * drawn at this height. The rule is `kill`, so the height is presentation — the fall time (√(2·34/24) = 1.68 s) has not changed.
 */
export const CHASM_FLOOR_Y = -34;
/** The deck top the front half (waking up ~ the first android pair) stands on. */
export const DECK_UPPER_Y = 0;
/** The deck top of the back half (supply ~ the ship), below cliff 2. A 10 m drop = 45 by `FALL_DAMAGE` — it hurts but does not kill. */
export const DECK_LOWER_Y = -10;
/** Cliff 2's drop (m). For display and the arithmetic check. */
export const CLIFF_DROP_M = DECK_UPPER_Y - DECK_LOWER_Y;

/* ── Corridor ────────────────────────────────────────────────────────────── */

/**
 * The half-width of a **combat area**. 2026-09-14 3rd pass, user's decision: 22 → **15.4** (−30 %) — the 2nd pass's 「too wide」
 * was still true of the combat areas. Only where cover and room to dodge have to be left keeps this width — from the 4th pass
 * that is **only the android stretch and the last stretch** (the bug stretch went down to `CORRIDOR_BUG_HALF_X`).
 * It is also the reference for the decks · the walls' outer face · the trigger volumes, so **it must be the largest stretch width**.
 */
export const CORRIDOR_MAX_HALF_X = 15.4;
/**
 * The half-width of a **pass-through stretch** — 2026-09-14 2nd pass, user's decision (「so wide I am not sure where to go」),
 * which halved every stretch with no combat. Walking · running jumps · crawling · falling · supply are all this wide (3rd: 7.7).
 */
export const CORRIDOR_PASS_HALF_X = CORRIDOR_MAX_HALF_X / 2;
/**
 * The **bug stretch** (z 62 … 0) half-width — 2026-09-14 4th pass, user's decision: 15.4 → **4.6** (−70 %). Not a battlefield
 * needing cover but **the neck where the gun is first fired**, so no reason to be wide: wide, the two bugs scatter left and
 * right and there is no telling where to look. **Narrower** even than a pass-through stretch (7.7), so the profile 「narrows,
 * then widens again」 — and that is the intent: a narrow neck puts the bugs straight ahead. The 9.2 m passable width is 10 × the
 * player diameter (0.9), so there is room to dodge, and a bug (`radius` 0.45) at x ±2.5 keeps nearly 1 m to the wall's inner face.
 */
export const CORRIDOR_BUG_HALF_X = 4.6;
/** Thickness of the cliff walls on both sides of the corridor (the inner face differs per stretch — `corridorHalfXAt`). */
export const WALL_T = 3;
/**
 * The cliff walls' **outer** face. Whatever the stretch width, it is solid rock out to this x — standing only the wall thickness
 * in a narrow stretch leaves what is behind it (the wide deck runs on) see-through, and a hole to fall into at a funnel seam.
 */
export const CORRIDOR_OUTER_X = CORRIDOR_MAX_HALF_X + WALL_T;
/** The cliff walls' top face (18 m above the upper deck). The sky is open; there is no way out sideways. */
export const WALL_TOP_Y = 18;

/* ── The abyss (in front of the ship) ────────────────────────────────────── */

/**
 * **The z where the lower deck ends** — beyond it is a cliff with no visible bottom (2026-09-15, user's decision 「in front of the
 * ship is not a blocking wall but a drop with no end in sight」). There used to be an 18 m dead-end wall here (the `Z_END` cap),
 * and the ship rose nose-first and **flew straight through it** (after the 1.6 s liftoff spool, at a seconds it climbs `6a² + 2a`
 * and moves forward `12(a − 0.8)²` — before clearing the wall top at y 18 the nose advanced 7.7 m into the cap (−162…−165)).
 *
 * **Arithmetic check**: the frontmost point of the ship's hull (`SHIP_POS`/`SHIP_YAW`, the nose tip at local z −9.7) is world z **−167.80**,
 * so **4.2 m** to the edge. Liftoff only starts moving forward at a = 0.8, already 5.4 m up, so it misses the deck corner too.
 */
export const ABYSS_EDGE_Z = -172;
/** How far (m) the side cliff walls run on past the edge, **descending**. Behind that is nothing — the sky dome's lower part (the dark `ground` colour). */
export const ABYSS_RUN_M = 36;
/** The z length of one piece of that wall — each piece steps its top face down and opens its inner face out a little (`parts/Ground.buildAbyss`). */
export const ABYSS_WALL_STEP_M = 6;
/**
 * The lowest point the cliff face is **drawn** to (the collider goes down to `VOID_Y`). 410 m below the edge, so it is never seen
 * that far down, and if it is, the vertex colour has fallen to black and joins the sky dome's lower part (the dark `ground` colour).
 */
export const ABYSS_DRAW_BOTTOM_Y = -420;
/**
 * The height where the cliff face crosses from **stone material into a darkening gradient**. Above it is the same stone-grain
 * texture as the other cliff walls; below it is a `fog: false` vertex-colour material — fog (FogExp2) paints the far distance in
 * the **bright** fog colour, so under fog the deep end would brighten instead and go out of step with the dark sky dome below.
 */
export const ABYSS_FADE_TOP_Y = -40;
/**
 * The width (m) of the edge band where 「the last spot stood on」 is **not recorded** (`TutorialWorld.pollSafeGround`). Respawning
 * right at the edge falls again in one step — the same reason as cliff 1's `SAFE_CHASM_MARGIN`.
 */
export const ABYSS_SAFE_MARGIN_M = 3;
/**
 * From this z forward (−Z) the straight cliff walls **do not bite inward** (`parts/Ground`'s bite = 0). Under the old rule the
 * left wall of the −152…−162 piece bit in 2.2 m, putting its inner face at x −13.2 — **0.07 m** from the ship's left nacelle
 * (−13.13). At 0 the left wall's inner face is always −15.4, so the clearance is **2.27 m** (checked by walking the whole liftoff
 * trajectory at 0.02 s steps). Why −142: from that piece on stand the ship and the `ship` checkpoint (x −12.5).
 */
export const WALL_PLAIN_FROM_Z = -142;

/* ── Last stretch, side walls descending (2026-09-16, user's decision) ───── */

/**
 * The diagonal barrier's two end points · half its thickness — `BARRIER` reads these. They sit apart up here because of **module
 * initialisation order**: the abyss cuts beyond the wire fence (`ABYSS_CUTS`) and the lower deck pieces (`DECKS`) build a stair
 * along the fence's far face, and both initialise above `BARRIER` (reading a `const` before its declaration is a ReferenceError).
 */
export const BARRIER_NEAR_END = { x: 17, z: -116 } as const;
export const BARRIER_FAR_END = { x: -8.5, z: -140 } as const;
export const BARRIER_HALF_T = 0.6;

/**
 * From this z forward (−Z) the side walls **descend at the top** (2026-09-16, user's decision — 「from the end of the wire fence the
 * left wall is cut down fast and the right wall descends gently, and both wrap the cliff」). The value = the barrier's `far` end z.
 * `parts/Ground` cuts the wall here, splits the rest into `WALL_DESCENT_STEP_M` pieces and drops each top face (bite 0, as `WALL_PLAIN_FROM_Z`).
 */
export const WALL_DESCENT_FROM_Z = BARRIER_FAR_END.z;
/** The z length of one descending wall piece (m). The collider is per piece too, so the stepped top face is the collider. */
export const WALL_DESCENT_STEP_M = 2;
/**
 * The rate of descent (top face m / m forward). Left 1.2 reaches the floor value (`WALL_MIN_ABOVE_WALK_M`) at z −160; right 0.5 is
 * at y **2.0** at the edge (`ABYSS_EDGE_Z`). Past the edge (`parts/Ground.buildAbyss`) every piece (6 m) keeps dropping by
 * `ABYSS_WALL_DROP_L` on the left and `ABYSS_WALL_DROP_R` on the right (the right one is always the gentler).
 */
export const WALL_DESCENT_RATE_L = 1.2;
export const WALL_DESCENT_RATE_R = 0.5;
/**
 * Beside walkable ground the wall top is **at least** this far above that ground (m). Jump 1.20 + the step-up ledge 0.9 = 2.10 < 3.0,
 * so the wall cannot be climbed (the same arithmetic as the `BARRIER` check). The left wall runs beside the path and the ship hill
 * to z −172, so it is measured from that hill (`SHIP_HILL_Y`) — beside the right wall everything past the fence is cliff, no floor.
 */
export const WALL_MIN_ABOVE_WALK_M = 3;
/** How much (m) each wall piece (6 m) past the edge drops its top face — left · right. */
export const ABYSS_WALL_DROP_L = 6;
export const ABYSS_WALL_DROP_R = 3;

/** A control point of the corridor half-width profile. */
export interface CorridorPoint { readonly z: number; readonly halfX: number }

/**
 * **The corridor half-width per stretch** (descending z = the order of play). Two neighbouring control points of equal width make
 * a straight stretch; different widths make a **funnel** between them (linear interpolation). `parts/Ground` stands a funnel as
 * one slanted plate (a rotated OBB), so there is no step lip and nowhere for a body to snag.
 *
 * The three stretches enemies stand in, and why they are that wide:
 *   z  62 …   0 — two bugs (spawn z 34 · 28). The `bugs` (60) ~ `crawl` (−10) checkpoint stretch.
 *                 2026-09-14 3rd pass: 26 → **62 m**, with the bugs set deep inside — 「so they are seen from further away」.
 *                 4th pass: the half-width only, 15.4 → **4.6** (`CORRIDOR_BUG_HALF_X`) — the length is unchanged.
 *   z −34 … −66 — two androids (spawn z −48 · −54). The `android` (−32) ~ `drop` (−71) checkpoint stretch.
 *   z −112 … −172 — the diagonal barrier (`BARRIER`) + two androids behind it + the abandoned ship on the left (2026-09-15).
 *                 The ship's hull (`extraction/Hull`) is local x ±5.25 (nacelles) · z −9.7…+0.6 and the ramp opens 3.25 m
 *                 toward +Z. Stood at yaw −10° its world footprint is x −13.13 … −2.76 · z −167.80 … −154.50, which leaves
 *                 **2.27 m** to the left wall (−15.4, bite 0 from `WALL_PLAIN_FROM_Z`). Narrow it and the ship no longer fits.
 *                 The end is not a dead-end wall but **the abyss** (`ABYSS_EDGE_Z`).
 *
 * ⚠ The decks (`DECKS`) are **never narrowed** — always `±CORRIDOR_MAX_HALF_X`. In a narrow stretch the wall stands on top of
 * that deck, so that even a wrong funnel seam or wall-thickness sum cannot make the ground under one's feet disappear.
 */
export const CORRIDOR_PROFILE: readonly CorridorPoint[] = [
  { z: 121, halfX: CORRIDOR_PASS_HALF_X },   // waking up · ruins · cliff 1 · corpse ①
  { z: 68, halfX: CORRIDOR_PASS_HALF_X },
  { z: 62, halfX: CORRIDOR_BUG_HALF_X },     // ↑ narrows — the entrance of the bug stretch (over 6 m = wall angle 27°)
  { z: 0, halfX: CORRIDOR_BUG_HALF_X },
  { z: -12, halfX: CORRIDOR_PASS_HALF_X },   // ↑ widens — the funnel before the collapsed corridor (crawling) (over 12 m = wall angle 15°)
  { z: -28, halfX: CORRIDOR_PASS_HALF_X },
  { z: -34, halfX: CORRIDOR_MAX_HALF_X },    // ↑ widens — the entrance of the android battlefield
  { z: -66, halfX: CORRIDOR_MAX_HALF_X },
  { z: -73, halfX: CORRIDOR_PASS_HALF_X },   // ↑ narrows — the funnel before cliff 2 (upper and lower deck must be the same width for the landing to be safe)
                                             //   4th pass: the cliff edge was pulled −82 → −77, so this control point moved −78 → −73 —
                                             //   narrowing has to end 4 m before the edge for the jump-off spot and the landing spot to be the same width
  { z: -106, halfX: CORRIDOR_PASS_HALF_X },
  { z: -112, halfX: CORRIDOR_MAX_HALF_X },   // ↑ widens — the diagonal barrier · the last fight · the ship
  { z: ABYSS_EDGE_Z, halfX: CORRIDOR_MAX_HALF_X },   // the straight wall ends here and `Ground.buildAbyss` joins the descending wall onto it
];

/** The corridor half-width at that z (linear interpolation between control points). A z outside the map clamps to the end values. */
export function corridorHalfXAt(z: number): number {
  const p = CORRIDOR_PROFILE;
  if (z >= p[0].z) return p[0].halfX;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (z < b.z) continue;
    const span = a.z - b.z;
    if (span <= 0) return b.halfX;
    return a.halfX + (b.halfX - a.halfX) * ((a.z - z) / span);
  }
  return p[p.length - 1].halfX;
}
/**
 * The map's two z ends. `Z_START` is outside the dead-end wall; `Z_END` is **where the wall past the abyss ends**.
 * 2026-09-14 3rd pass: the bug stretch grew 36 m, −129 → −165. 2026-09-15: the dead-end wall was taken out and the map widened
 * past the cliff to `ABYSS_EDGE_Z − ABYSS_RUN_M` = **−208** (`isInside` · `clampInside` · the `kill` fall volume read out to it).
 */
export const Z_START = 121;
export const Z_END = ABYSS_EDGE_Z - ABYSS_RUN_M;
/**
 * The side length the map and pings use (`WorldRef.size`). The whole corridor fits — the map is centred on the origin, so the
 * half-side (210) must be larger than `max(|Z_START|, |Z_END|)` = 208 (2026-09-15: 340 → 420).
 */
export const TUTORIAL_MAP_SIZE = 420;
/** The largest side of one deck collider — a bigger `SpatialHash.maxRadius` slows every query (16 m cells). */
export const DECK_TILE_M = 16;
/** The fixed seed for the dressing (rubble · stone chips). A hand-built map, so it looks the same whatever the mission seed. */
export const DRESSING_SEED = 0x7ea11e;

/* ── Rectangles ──────────────────────────────────────────────────────────── */

/** An XZ rectangle. It keeps the `z0 > z1` convention (forward = −Z). */
export interface Rect { x0: number; x1: number; z0: number; z1: number }

export function rectContains(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z <= r.z0 && z >= r.z1;
}

/**
 * Splits `r` into tiles of side `max` or less (one big collider raises `SpatialHash.maxRadius`, which slows **every** hash
 * query — a whole deck in one box has an 85 m circumscribed circle).
 *
 * ⚠ **Inner boundaries overlap by `TILE_OVERLAP`.** `boxContainsXZ` includes the boundary (`<=`), but if rounding error reads
 * a point exactly on the boundary as outside *both* tiles, that frame's `getSurfaceY` answers with the terrain (the chasm
 * floor) and **the ground under the feet disappears**. Outer boundaries (the rectangle's own edges) are never grown, so the
 * cliff gap and the deck ends keep their designed dimensions.
 */
export const TILE_OVERLAP = 0.05;

export function tileRect(r: Rect, max: number): Rect[] {
  const out: Rect[] = [];
  const w = r.x1 - r.x0, d = r.z0 - r.z1;
  const nx = Math.max(1, Math.ceil(w / max)), nz = Math.max(1, Math.ceil(d / max));
  const o = TILE_OVERLAP;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      out.push({
        x0: r.x0 + (w * i) / nx - (i > 0 ? o : 0),
        x1: r.x0 + (w * (i + 1)) / nx + (i < nx - 1 ? o : 0),
        z0: r.z0 - (d * j) / nz + (j > 0 ? o : 0),
        z1: r.z0 - (d * (j + 1)) / nz - (j < nz - 1 ? o : 0),
      });
    }
  }
  return out;
}

/** `r` grown by `m` on every side (for collider seams — the `TILE_OVERLAP` comment). */
export function growRect(r: Rect, m: number): Rect {
  return { x0: r.x0 - m, x1: r.x1 + m, z0: r.z0 + m, z1: r.z1 - m };
}

/* ── Beyond the wire fence (last stretch): the pit · walls · abyss cuts ──── */

/**
 * **The pit's depth** (2026-09-15 2nd pass, user's decision — 「where the androids stand is sunk about half a PC body down and
 * runs up a hill to where the ship is」; reconfirmed in the 3rd pass as 「keep 0.9 m + walls」). Half a body = `PLAYER_HEIGHT / 2`,
 * so the number is taken from there rather than written out.
 *
 * ⚠ This value is **exactly `PROP_STEP_UP_MAX` (0.9)** (`−10.9 + 0.9 === −10` even in floating point). So the lip is
 *   - **not a wall to people and enemies** — `resolveCollision`'s 「a ledge that can be stepped on is not a wall」 branch
 *     (`top <= feet + 0.9`) and `getSurfaceY`'s ceiling (`feet + 0.9`) **both let it through**, so they walk up over the open
 *     edges (the fence side · the lip left on the ramp side).
 *   - **a wall to throwables** — the same branch is gated by `!small`, so a body with a radius under `SMALL_BODY_R` (0.25) has
 *     no exception. A grenade (`BODY_R` 0.08 in `weapons/Grenade`) is pushed out = **it cannot roll out.**
 * 2026-09-15 3rd pass: what traps a grenade thrown *in* is not the lip but the **walls** (`PIT_WALLS`, 2.5 m).
 */
export const PIT_DEPTH = PLAYER_HEIGHT / 2;
/** The top face of the pit floor. `PIT_DEPTH` below the lower deck. */
export const PIT_FLOOR_Y = DECK_LOWER_Y - PIT_DEPTH;

/**
 * **The pit's plan** (2026-09-15 3rd pass — the 2nd pass's x −2 … 6 · z −140.5 … −147 (52 m²) grew to **80.75 m² (×1.55)**) — axis-aligned.
 *
 * Why not barrier coordinates (a rotated rectangle): the decks are axis-aligned tiles (`tileRect`) and every seam of a rotated
 * rectangle leaves a triangular sliver where the ground under the feet vanishes. So the spot is **checked** in barrier
 * coordinates (the table below) and only the shape is axis-aligned. From the 2026-09-15 3rd pass the hole is not dug with
 * `subtractRect` but **left empty from the start between `DECKS`' lower deck pieces** (2026-09-16: west = the path
 * `lower_pit_w`, south-west lip = the hill ramp `SHIP_SLOPE`, north lip · east · south = `PIT_WALLS` — beyond them all is
 * cliff, so the pit is an island entered only by the ramp).
 *
 * **Why ×1.55 and not ×2** (the user's decisions 「about twice」 and 「anywhere inside the pit kills both」 do not both hold):
 *   A grenade has to be within `GRENADE_RADIUS` 7.2 m for `EXPLOSION_OUTER_MUL` × `GRENADE_DAMAGE` ≥ the tutorial android's hp
 *   (2026-09-17 across-the-board 1/3 rebalance: 0.5 × 60 = 30 ≥ hp 30 — `enemies.csv` `tut_android*`. Old values 0.6 × 250 =
 *   150 > 140). With the two standing s apart, the spots 「within 7.2 m of both」 are the lens of two circles, and for an
 *   axis-aligned rectangle to lie inside it, **half-diagonal + half-gap ≤ 7.2**. 104 m² (×2, e.g. 10.4 × 10) has a half-diagonal
 *   of 7.2 on its own, so not even its centre point fits; 9.5 × 8.5 has a half-diagonal of 6.37, so standing the two
 *   **1.8 m** apart the largest corner distance is 7.07 and it fits (table below). Any wider drops the gap below 1 m and they touch.
 *
 * **Arithmetic check** (barrier coordinates `barrierLocal` — along = 0.7282·dx + 0.6853·dz · depth = −0.6853·dx + 0.7282·dz, dx = x + 8.5 · dz = z + 140;
 *   androids A1 (1.85, −144.75) · A2 (3.65, −144.75) — `FINAL_ANDROIDS`):
 *   | corner | along | depth | to A1 | to A2 |
 *   | (−2.0, −140.5) |  4.39 |  −4.82 | 5.73 | 7.07 |
 *   | ( 7.5, −140.5) | 11.31 | −11.33 | 7.07 | 5.73 |
 *   | (−2.0, −149.0) | −1.43 | −11.01 | 5.73 | 7.07 |
 *   | ( 7.5, −149.0) |  5.48 | −17.52 | 7.07 | 5.73 |
 *   - **The gap to the wire fence**: the shallowest corner is at depth −4.82 and the fence collider's far face is at −0.6, so
 *     they are **4.22 m** apart (pulling x0 further left breaks that clearance — the diagonal means x0 ≥ −2.32 for 4 m). Until
 *     2026-09-15 that gap was flat ground; from 2026-09-16 it is **cliff** (the fence stair in `ABYSS_CUTS` — user's decision
 *     「beyond the fence everything but the path, the ship hill and the pit is cliff」). The pit's north face is therefore a lip
 *     toward the cliff (`pit_rim_n` in `PIT_WALLS`, at deck height). Standing against the fence (eyes 1.55) only about 2.7 m
 *     behind the lip is hidden, and the androids (10.5 m away) are far outside that.
 *   - **Both with one grenade**: all four corners are within 7.2 m of both (max **7.07**). The grenade body (radius 0.08) stops
 *     that far from a wall, so the real maximum is √(5.57² + 4.17²) = 6.96, and measuring vertically to the enemy's body centre
 *     (+0.9) as well gives √(7.07² + 0.82²) = 7.12 < 7.2.
 *   - **It does not touch the `ship` checkpoint band (z −150 … −158)**: the pit's front end is −149.0, so **1.0 m** of clearance
 *     (the same value as the 2nd pass — the band moved 2 m back). That band is `CHECKPOINT_STEP.ship = 'extract'`, so jumping
 *     into the pit must not skip the tutorial's grenade step. The south wall (−149 … −149.6) leaves the ramp's south lip
 *     (x −2 … 1.5) as the only way from the pit floor to z −150, and that is the way out onto the ship strip.
 *   - **It does not overlap the ship's footprint** (x −13.13 … −2.76 · z −167.80 … −154.50) — 0.76 m apart in x, 5.5 m in z.
 *   - **The liftoff cutscene camera's first spot** (−4.07, −5.9, −139.96 — 2026-09-16 ship hill +0.9) is outside the pit (2.07 m
 *     in x), stands over the fence stair's abyss cut, and is 4.1 m **above** the deck.
 *   - **Corpse ③** (9, −117) is still flat ground (23.5 m away in z · 8.2 m in front of the edge −125.17 of fence stair column [8.5, 9.5]).
 */
export const PIT: Rect = { x0: -2, x1: 7.5, z0: -140.5, z1: -149 };

/** The pit walls' thickness (m) — 0.6, the same as the barrier (thick enough that a grenade cannot pass in one step, the 50 fps check in the `BARRIER` comment). */
export const PIT_WALL_T = 0.6;
/**
 * The pit walls' height (m, **measured from the deck top** — from inside the pit it is 3.4 m, 0.9 more). User's decision 「about 2.5 m」.
 *   - **Cannot be climbed**: jump 1.20 + the step-up ledge 0.9 = 2.10 < 2.5 (the same arithmetic as the `BARRIER` check).
 *   - **A grenade cannot get out**: the top of a trajectory thrown horizontally over the fence is 1.805 m above the deck (the
 *     `BARRIER` check), so it hits the 2.5 m wall and slides to its foot. It is lower than the liftoff camera (y −5.9 = deck
 *     +4.1 in the `SHIP_POS` check — 2026-09-16 ship hill), and 11 m away in x to begin with.
 */
export const PIT_WALL_H = 2.5;
/**
 * The height of the pit's **north lip** (m, from the deck top — 0 means a lip at deck height = 0.9 m from inside the pit).
 * 2026-09-16: once the flat ground between the fence and the pit became cliff, the north face needed something — without it the
 * pit floor runs straight into the cliff edge, grenades roll out and the androids walk out. Why **a lip and not a wall (2.5 m)**:
 * this face is the one from the 2026-09-15 decision 「the face a grenade thrown over the fence comes in through · the face the
 * androids are seen through the fence on」. A 2.5 m wall would hide a chest inside the pit (deck +0.27) from eyes standing
 * against the fence (deck +1.55), and would catch the top of a horizontal throw's trajectory (deck +1.805) too. A deck-height
 * lip is below that line of sight (about deck +0.9 at the pit's north end), and 0.9 m = `PROP_STEP_UP_MAX`, so **a grenade (a
 * small body) cannot pass** while people and enemies step up (the `PIT_DEPTH` comment). To make it a wall, raise only this value.
 */
export const PIT_NORTH_RIM_H = 0;
/** The x of the right-hand cliff edge = the outer face of the pit's east wall. To its right (beyond the fence) there is no floor. */
export const PIT_EAST_X = PIT.x1 + PIT_WALL_T;
/**
 * The right-hand end x of the **ship strip** (the left strip where floor remains). **4.26 m** of clearance from the ship
 * footprint's right end, −2.76. The south wall starts here, and to its left (x −2 … 1.5, 1 m of ramp and flat) is a 0.9 m lip
 * with no wall — the android → ship line of sight passes there, so it is not blocked (the sight-line table in the
 * `FINAL_ANDROIDS` comment: A2 → the cargo-bay centre line crosses z −149 at x **0.48**).
 */
export const SHIP_STRIP_X1 = 1.5;

/**
 * **The ship hill** (2026-09-16, user's decision — 「the ship sits slightly up a hill, half a player body high」). Half a body =
 * `PLAYER_HEIGHT / 2` = 0.9, the same value as the pit depth (`PIT_DEPTH`). The ship (`SHIP_POS.y`) · the `ship` checkpoint ·
 * the safe levels (`TutorialWorld.SAFE_LEVELS`) all read it.
 *
 * It is climbed by a **ramp** (`SHIP_SLOPE`, a ramp collider), not a lip: 0.9 m is exactly `PROP_STEP_UP_MAX`, so a lip would be
 * walkable too, but the decision is a hill that is eased up, not one stepped up 「in a jolt」. The hill's other three faces are
 * wall (left) and cliff (right `cut_s` · ahead `ABYSS_EDGE_Z`), so there is nowhere to climb it by a lip.
 */
export const SHIP_HILL_RISE = PLAYER_HEIGHT / 2;
export const SHIP_HILL_Y = DECK_LOWER_Y + SHIP_HILL_RISE;
/**
 * The horizontal run of the hill ramp (m, toward −Z). Slope atan(0.9 / 4.5) = **11.3°** (gentler than the pit ramp's 19.8°).
 * The ramp starts at the pit's front end (`PIT.z1` −149) and ends at **−153.5** — **1.0 m** in front of the toe corners of the
 * ship's rear ramp (world z −154.52 … −155.08, local x ±1.6 · z 3.25), so that ramp lies flat on the hill top (y = the ship floor height).
 */
export const SHIP_SLOPE_RUN = 4.5;
/** The z where the flat hill top begins (−153.5). */
export const SHIP_HILL_Z0 = PIT.z1 - SHIP_SLOPE_RUN;
/**
 * The hill ramp's plan — the full width of the ship strip (x −15.4 … `SHIP_STRIP_X1`), z −149 … −153.5. The body
 * (`VOID_Y … DECK_LOWER_Y`) + the wedge drawing + the ramp collider are in `parts/Ground.buildShipSlope`. Its north end (−149)
 * starts at the same height as the path (`lower_pit_w`, −10), and at x −2 … 1.5 it becomes the pit's south lip (0.9 m) — the
 * same spot and the same height as the north end of 2026-09-15's `lower_ship`.
 */
export const SHIP_SLOPE: Rect = { x0: -CORRIDOR_MAX_HALF_X, x1: SHIP_STRIP_X1, z0: PIT.z1, z1: SHIP_HILL_Z0 };
/**
 * From this z forward (−Z) the lower deck has **holes** (cliff). The chasm floor plate (`tut-void-floor` in `parts/Ground`) ends
 * here, and from here the side cliff walls are drawn with a darkening band below `ABYSS_FADE_TOP_Y` (so the wall seen while
 * falling through a hole does not stop dead at −100). The value is 1.67 m behind the far face of the fence's concrete block
 * beside the right wall (z −118.33 at x 15.4). From 2026-09-16 the fence stair's edge (`fenceColumns`) is cut at this value
 * too — the last column [14.5, 15.4] is cut here (a hole in front of it would show the chasm floor plate underneath).
 */
export const ABYSS_CUT_Z0 = -120;

/**
 * **The pit's walls** (2026-09-15 3rd pass, user's decision — 「wall it in on every side but the hill toward the ship, so a grenade
 * cannot slip away」). They replace the old concrete `BACKSTOP` (diagonal). The collider is one column from `VOID_Y` to the top
 * face, so its outer face is the cliff face.
 *   east `pit_wall_e` — x 7.5 … 8.1, z −140.5 … −149.6. Its outer face (8.1) is the right-hand cliff edge (「beyond the wall is
 *              cliff, so no floor」).
 *   south `pit_wall_s` — x 1.5 … 7.5, z −149 … −149.6. The wall that **stops** a grenade flown over the fence (the old
 *              `BACKSTOP`'s job); behind it is cliff (`cut_s` in `ABYSS_CUTS`). It shares the corner (7.5, −149 … −149.6) with the east wall.
 * **Two open faces**: north (the one facing the fence — the way a thrown-over grenade comes in) and west (the ramp toward the
 * ship, `PIT_RAMP_*`). Why the south wall starts at x 1.5 is in the `SHIP_STRIP_X1` comment.
 */
export const PIT_WALLS: readonly DeckRect[] = [
  // 2026-09-16: the east wall grew north by the north lip's thickness (−140.5 → −139.9) — the wall closes the lip/wall corner
  { id: 'pit_wall_e', rect: { x0: PIT.x1, x1: PIT_EAST_X, z0: PIT.z0 + PIT_WALL_T, z1: PIT.z1 - PIT_WALL_T }, top: DECK_LOWER_Y + PIT_WALL_H },
  { id: 'pit_wall_s', rect: { x0: SHIP_STRIP_X1, x1: PIT.x1, z0: PIT.z1, z1: PIT.z1 - PIT_WALL_T }, top: DECK_LOWER_Y + PIT_WALL_H },
  // 2026-09-16: the north lip (the `PIT_NORTH_RIM_H` comment) — north of it is the fence stair's abyss cut
  { id: 'pit_rim_n', rect: { x0: PIT.x0, x1: PIT.x1, z0: PIT.z0 + PIT_WALL_T, z1: PIT.z0 }, top: DECK_LOWER_Y + PIT_NORTH_RIM_H },
];

/**
 * The z at which the fence's **far face** (the far side of the barrier collider — `BARRIER_HALF_T` behind the centre line) passes
 * that x. Seen from above the barrier is a `\`, so z grows with x: **−140.82** at x −8.5 · −125.20 at x 8.1 · −118.33 at x 15.4 (gradient dz/dx = 0.941).
 */
export function fenceFarFaceZ(x: number): number {
  const len = Math.hypot(BARRIER_NEAR_END.x - BARRIER_FAR_END.x, BARRIER_NEAR_END.z - BARRIER_FAR_END.z);
  const dx = (BARRIER_NEAR_END.x - BARRIER_FAR_END.x) / len, dz = (BARRIER_NEAR_END.z - BARRIER_FAR_END.z) / len;
  // the near-side normal is (−dz, dx), so a point on the far face = the far end − the normal × halfT
  const px = BARRIER_FAR_END.x + dz * BARRIER_HALF_T, pz = BARRIER_FAR_END.z - dx * BARRIER_HALF_T;
  return pz + (dz / dx) * (x - px);
}
/** The x width of one fence stair column (m). */
export const FENCE_EDGE_STEP_M = 1;
/**
 * The floor left behind the fence's far face **at minimum** (m, measured at the column's left end — inside a column the gradient
 * widens it by another 0.94 m). It is the lip that keeps a barrier block from hanging in mid-air, and it keeps the minimum (0.35)
 * of the 2026-09-15 right-hand stair table.
 */
export const FENCE_LEDGE_MIN_M = 0.35;
/** A column whose cut is shallower than this (m) is left as floor instead — so no 0.27 m hairline gap opens behind the barrier's `far` end beside the gap. */
export const FENCE_CUT_MIN_M = 0.5;

/** One column of the fence stair: the x range, the edge z (`edge`, floor in front of it), and the z the cut ends at (`bottom`). `edge === bottom` means no cut. */
interface FenceColumn { readonly x0: number; readonly x1: number; readonly edge: number; readonly bottom: number }

/**
 * The fence stair columns (ascending x). Column boundaries = every `FENCE_EDGE_STEP_M` from the barrier's `far` end (−8.5), plus
 * the pit's west end (−2) · the east wall's outer face (8.1) · the corridor's right end (15.4). The edge =
 * `min(fenceFarFaceZ(x0) − FENCE_LEDGE_MIN_M, ABYSS_CUT_Z0)` — the barrier is a `\`, so the far face is furthest back at the
 * column's left end; measuring the lip there keeps the edge behind the far face across the whole column (= **no cut opens on the
 * near side**). It is clamped by `ABYSS_CUT_Z0` because the chasm floor plate (`tut-void-floor` in `parts/Ground`) ends there (a
 * cut in front of it would show the plate under the hole). The cut's south end (`bottom`) is whatever lies below that column:
 * x ≤ −2 the path (`lower_pit_w`, −140.5), x −2 … 8.1 the pit's north lip · east wall (−139.9), x ≥ 8.1 all the way to the
 * old edge (`ABYSS_EDGE_Z`).
 */
function fenceColumns(): FenceColumn[] {
  const xs = new Set<number>([PIT.x0, PIT_EAST_X, CORRIDOR_MAX_HALF_X]);
  for (let x = BARRIER_FAR_END.x; x < CORRIDOR_MAX_HALF_X - 1e-6; x += FENCE_EDGE_STEP_M) xs.add(x);
  const sorted = [...xs].sort((a, b) => a - b);
  const out: FenceColumn[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const x0 = sorted[i], x1 = sorted[i + 1];
    const bottom = x1 <= PIT.x0 ? PIT.z0 : x0 >= PIT_EAST_X ? ABYSS_EDGE_Z : PIT.z0 + PIT_WALL_T;
    const edge = Math.min(fenceFarFaceZ(x0) - FENCE_LEDGE_MIN_M, ABYSS_CUT_Z0);
    out.push({ x0, x1, edge: edge - bottom >= FENCE_CUT_MIN_M ? edge : bottom, bottom });
  }
  return out;
}
const FENCE_COLUMNS = fenceColumns();
/**
 * The x where the fence stair begins (**−6.5**) — everything left of it (the barrier's left gap · the 0.35 … 1.56 m lip behind the
 * `far` end) is floor throughout (`lower_gap`). Column [−7.5, −6.5] has a cut of only 0.27 m, so `FENCE_CUT_MIN_M` keeps it as floor.
 */
export const FENCE_STAIR_X0 = FENCE_COLUMNS.find((c) => c.edge > c.bottom)?.x0 ?? CORRIDOR_MAX_HALF_X;

/**
 * **The abyss cuts beyond the wire fence** (2026-09-15 3rd pass → **fully reworked 2026-09-16**, user's decision — 「beyond the fence
 * it is all bottomless cliff. What is left is the path from the left gap to the ship, the ship hill, and the android pit」). The
 * axis-aligned rectangles with **no floor** in the lower deck — read by the `kill` fall-rule volumes (`FALL_RULES`) · the edge band
 * of 「the last spot stood on」 (`inAbyssCut`, `ABYSS_SAFE_MARGIN_M`) · the debris exclusion. The ground itself comes from `DECKS`'
 * lower deck pieces **leaving these rectangles empty** (the two lists must be each other's complement — `lowerTilingErrors` measures it at build time).
 *
 * Floor that remains: (a) the whole corridor on the barrier's near side (`lower_n` · `lower_gap` · `lower_fence_*` — out to the
 * 0.35 … 1.29 m lip behind the fence's far face), (b) the path from the barrier's left gap to the ship (`lower_pit_w`,
 * x −15.4 … −2 · z −140.5 … −149 — the pit ramp comes up here), (c) the ship hill (the `SHIP_SLOPE` ramp + `ship_hill`,
 * x ≤ `SHIP_STRIP_X1`), (d) the pit + walls + north lip + ramp (an island — entered from the path by the ramp only).
 * 2026-09-15's (d) 「the flat ground between the fence and the pit」 is gone.
 *
 * **The fence stair** (`FENCE_COLUMNS`): the edge is raised per 1 m column along the barrier's far face — of 26 columns, the 24 from x −6.5 on have a cut.
 *   | x range | edge z | south end of the cut | far face ~ edge (lip) |
 *   | −6.5 … −2   | −139.29 … −135.53 | −140.5 (the path)        | 0.35 … 1.29 |
 *   | −2 … 8.1    | −135.06 … −126.12 | −139.9 (lip · east wall) | 0.35 … 1.29 |
 *   | 8.1 … 14.5  | −125.55 … −120.47 | −172                     | 0.35 … 1.29 |
 *   | 14.5 … 15.4 | −120 (cut by `ABYSS_CUT_Z0`) | −172         | 0.82 … 1.67 |
 *   The two concrete blocks (the `far` end along 0 … 3.5, the `near` end along 27 … 35) also keep ≥ 0.35 m of floor behind the far face, so neither hangs in mid-air.
 *   Corpse ③ (9, −117) is 8.2 m in front of that column's edge (−125.17).
 *
 * **South** (`cut_s`, unchanged since 2026-09-15): from the south wall's outer face (−149.6) to the old edge (`ABYSS_EDGE_Z`), x `SHIP_STRIP_X1` … `PIT_EAST_X`.
 * It is 4.26 m from the ship's footprint, and liftoff **rises** out nose-first (front right), so no floor is needed (the `extraction/Hull` collider exists only while landed).
 */
export const ABYSS_CUTS: readonly Rect[] = [
  ...FENCE_COLUMNS.filter((c) => c.edge > c.bottom).map((c): Rect => ({ x0: c.x0, x1: c.x1, z0: c.edge, z1: c.bottom })),
  { x0: SHIP_STRIP_X1, x1: PIT_EAST_X, z0: PIT.z1 - PIT_WALL_T, z1: ABYSS_EDGE_Z },           // cut_s — beyond the south wall
];

/** Is that point inside an abyss cut (with `margin` to spare — the edge band test). */
export function inAbyssCut(x: number, z: number, margin = 0): boolean {
  for (const c of ABYSS_CUTS) {
    if (x >= c.x0 - margin && x <= c.x1 + margin && z <= c.z0 + margin && z >= c.z1 - margin) return true;
  }
  return false;
}

/* ── Decks ───────────────────────────────────────────────────────────────── */

export interface DeckRect { readonly id: string; readonly rect: Rect; readonly top: number }

/**
 * **Cliff 2's edge z** — the upper deck breaks off here and the lower deck starts here. The decks · the fall-rule volumes ·
 * the debris height test all look at this one value (copying the number out means the landing zone drifts when only one is fixed).
 *
 * 2026-09-14 4th pass, user's decision: −82 → **−77**. From the end of the android stretch (−66) the cliff took another 16 m of
 * walking to appear, which read as 「so what am I supposed to do now」 — at 11 m it is in sight as soon as the corridor opens.
 * Nothing behind it moved (`supply` −92 · the collapsed wall −114 · the ship −149 · `Z_END`), so **the lower deck just got 5 m longer**.
 */
export const CLIFF2_EDGE_Z = -77;

/**
 * The walkable ground. Two upper decks + the lower deck pieces (2026-09-16: one per fence stair column + the ship hill); **the empty space between them is the cliff**:
 *   between `upper_a` ↔ `upper_b` = cliff 1 (crossed only by a running jump — the edge is **diagonal**, so two rotated OBBs
 *     `parts/Ground.buildChasmEdges` fill from here out to the diagonal),
 *   from the end of `upper_b` (z = `CLIFF2_EDGE_Z` −77) down to `lower_n` = cliff 2 (jumped down),
 *   the holes between the lower deck pieces = the android pit (`PIT`, 0.9 m) and the abyss cuts beyond the fence (`ABYSS_CUTS`, `kill`),
 *   beyond the end of `ship_hill` (z = `ABYSS_EDGE_Z` −172) = the abyss (2026-09-15 — falling is `kill`).
 *
 * ⚠ `upper_a.z1` (85.8) · `upper_b.z0` (74.9) are **the points furthest back from the diagonal** — an axis-aligned rectangle
 * cannot hold a diagonal, so the wedge out to the diagonal is covered by the rotated OBBs and these two end inside it. The
 * arithmetic check is in the `CHASM_EDGE` comment.
 *
 * ⚠ 2026-09-16 — **the lower deck is pieces** (one per fence stair column). The abyss cuts beyond the fence (`ABYSS_CUTS`) and the android pit (`PIT`)
 * come from **the empty space between the pieces**. The union of the lower pieces (top < `DECK_UPPER_Y`) + `SHIP_SLOPE` + `PIT` + `PIT_WALLS` + `ABYSS_CUTS`
 * must cover the old `lower` (x ±15.4 · z −77 … −172) **exactly once** — `lowerTilingErrors` measures it on a 0.25 m sample and `TutorialWorld.build` warns.
 *   `lower_n`         x ±15.4          z  −77 … −120    all of it before the cuts start (cliff 2 landing · supply · the `wall` checkpoint · corpse ③)
 *   `lower_gap`       x −15.4 … −6.5   z −120 … −140.5  the barrier's left gap + the corridor in front of it (`FENCE_STAIR_X0`)
 *   `lower_fence_*`   x −6.5 … 14.5    z −120 … edge    the corridor on the fence's near side — each 1 m column ends along the far face (`ABYSS_CUTS` table)
 *   `lower_pit_w`     x −15.4 … −2     z −140.5 … −149  **the path** — from the gap to the ship hill, the top end of the pit ramp
 *   (`SHIP_SLOPE`)    x −15.4 … 1.5    z −149 … −153.5  the hill ramp (a ramp collider, so outside this list — `parts/Ground.buildShipSlope`)
 *   `ship_hill`       x −15.4 … 1.5    z −153.5 … −172  **the ship hill** (top `SHIP_HILL_Y`); its end is the old abyss
 * At the seams between lower deck pieces `parts/Ground` overlaps the colliders only, grown by `TILE_OVERLAP` (`growRect`) — the
 * same reason `tileRect` does it on inner boundaries; the drawing (the top plate) keeps its designed size, so overlapping plates do not z-fight.
 */
export const DECKS: readonly DeckRect[] = [
  { id: 'upper_a', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 118, z1: 85.8 }, top: DECK_UPPER_Y },
  { id: 'upper_b', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: 74.9, z1: CLIFF2_EDGE_Z }, top: DECK_UPPER_Y },
  { id: 'lower_n', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X, z0: CLIFF2_EDGE_Z, z1: ABYSS_CUT_Z0 }, top: DECK_LOWER_Y },
  { id: 'lower_gap', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: FENCE_STAIR_X0, z0: ABYSS_CUT_Z0, z1: PIT.z0 }, top: DECK_LOWER_Y },
  ...FENCE_COLUMNS.filter((c) => c.x0 >= FENCE_STAIR_X0 && c.edge < ABYSS_CUT_Z0).map((c, i): DeckRect => ({
    id: `lower_fence_${i}`, rect: { x0: c.x0, x1: c.x1, z0: ABYSS_CUT_Z0, z1: c.edge }, top: DECK_LOWER_Y,
  })),
  { id: 'lower_pit_w', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: PIT.x0, z0: PIT.z0, z1: PIT.z1 }, top: DECK_LOWER_Y },
  { id: 'ship_hill', rect: { x0: -CORRIDOR_MAX_HALF_X, x1: SHIP_STRIP_X1, z0: SHIP_HILL_Z0, z1: ABYSS_EDGE_Z }, top: SHIP_HILL_Y },
];

/* ── Cliff 1 (the diagonal) ──────────────────────────────────────────────── */

/**
 * Cliff 1's **tilt** (2026-09-14 3rd pass, user's decision — 「a collapsed cliff」). It leans 20° against the corridor axis (−Z),
 * and both edges are **parallel**, so the gap is the same width everywhere.
 *
 * The difficulty is unchanged:
 *   - Measured along the corridor (−Z) the gap is always `CHASM_GAP_Z` = **3.6 m**. A walking jump does 4.2 m/s × 0.633 s = 2.66 m
 *     and fails; a sprinting jump does 7.2 m/s × 0.633 s = 4.56 m and clears it (airtime = `2 × JUMP_SPEED(7.6) / GRAVITY(24)` = 0.633 s).
 *   - Crossing **perpendicular** to the diagonal (= the shortest way) is still 3.6 × cos 20° = **3.383 m**, out of reach of a
 *     walking jump (2.66) and above the 3.0 m floor the user set. Whichever way it is crossed, it is 3.383 … 3.6 m.
 */
export const CHASM_TILT = (20 * Math.PI) / 180;
/** The z where the diagonal crosses the middle of the corridor (x = 0) — the near edge (the upper deck `upper_a`). */
export const CHASM_NEAR_Z = 82;
/** The gap measured along the corridor axis (−Z). */
export const CHASM_GAP_Z = 3.6;
/**
 * **The run-up needed to clear cliff 1 at a sprint** (m, back from the near edge). 「Only a sprint clears it」 is the whole
 * point of this cliff, so this value has to be read by two places **together**:
 *   ① the `cliff` checkpoint's respawn spot (`CHASM_NEAR_Z + CHASM_RUNUP_M`),
 *   ② the approach-side width of the **band where 「the last spot stood on」 is not recorded** (`TutorialWorld.pollSafeGround`).
 * Fix only one and whoever failed the jump respawns with no run-up, which reads as 「fall again」 —
 * that actually happened in the 2026-09-14 4th pass, and the two were then tied to one constant.
 * It is more than the distance needed to reach `PLAYER_SPRINT_SPEED` (7.2).
 */
export const CHASM_RUNUP_M = 12;
/**
 * The dimensions of one rotated OBB that makes the diagonal edge (`parts/Ground.buildChasmEdges`).
 *   `width`   = the width **perpendicular** to the diagonal. The diagonal face is one of its faces; it reaches this far toward the deck.
 *   `halfLen` = the half-length along the diagonal.
 *
 * **Arithmetic check** (k = tan 20° = 0.36397, 1/cos 20° = 1.06418):
 *   - The only walkable x is |x| ≤ `CORRIDOR_PASS_HALF_X` (7.7) (outside it is wall). For margin, |x| ≤ 9 is guaranteed.
 *   - The near plate's **far boundary** is `82 − kx + 7.0 × 1.06418`. At x = +9, 82 − 3.276 + 7.449 = **86.17** >
 *     `upper_a.z1` (85.8) — they overlap with no gap (on the other side, x = −9, it is 92.7, far roomier).
 *   - The far plate's **far boundary** is `78.4 − kx − 7.449`. At x = −9, 78.4 + 3.276 − 7.449 = **74.23** <
 *     `upper_b.z0` (74.9) — again they overlap.
 *   - At `halfLen` 12.0 the plate ends reach x ≈ ±13.7 (the wall's inner face is |x| ≥ 6.6, so every part that touches the
 *     corridor is covered). The wedge outside that is filled by the wall body (VOID_Y…WALL_TOP_Y) and is neither seen nor touched.
 */
export const CHASM_EDGE = { width: 7.0, halfLen: 12.0 } as const;

/** The z of the near edge (the upper deck) at that x. */
export function chasmNearZAt(x: number): number { return CHASM_NEAR_Z - x * Math.tan(CHASM_TILT); }
/** The z of the far edge (the deck across) at that x. */
export function chasmFarZAt(x: number): number { return chasmNearZAt(x) - CHASM_GAP_Z; }
/** Is that point inside cliff 1's gap (with `margin` to spare). */
export function inChasm(x: number, z: number, margin = 0): boolean {
  return z <= chasmNearZAt(x) + margin && z >= chasmFarZAt(x) - margin;
}

/**
 * Cliff 1's **outer rectangle** (the axis-aligned box that holds the whole diagonal gap). Used by the fall-rule volumes and the
 * dressing exclusion zone — the diagonal itself is answered by `chasm*ZAt` above.
 */
export const CHASM: Rect = {
  x0: -CORRIDOR_MAX_HALF_X, x1: CORRIDOR_MAX_HALF_X,
  z0: CHASM_NEAR_Z + CORRIDOR_MAX_HALF_X * Math.tan(CHASM_TILT),          // 87.61 (x = −15.4)
  z1: CHASM_NEAR_Z - CHASM_GAP_Z - CORRIDOR_MAX_HALF_X * Math.tan(CHASM_TILT),  // 72.79 (x = +15.4)
};

/* ── Checkpoints ─────────────────────────────────────────────────────────── */

/** A trigger volume with a y (z alone cannot separate the upper and lower decks). */
export interface Volume extends Rect { y0: number; y1: number }

export interface CheckpointSpec {
  readonly id: TutorialCheckpointId;
  /** The respawn spot — the feet position. */
  readonly at: THREE.Vector3;
  /** The yaw to face on respawn (all 0 = forward). */
  readonly yaw: number;
  /** The volume that turns this checkpoint on when passed. A band across the corridor, so it cannot be walked around. */
  readonly trigger: Volume;
}

const UPPER_Y0 = DECK_UPPER_Y - 3, UPPER_Y1 = DECK_UPPER_Y + 6;
const LOWER_Y0 = DECK_LOWER_Y - 3, LOWER_Y1 = DECK_LOWER_Y + 6;
/**
 * The half-width of the checkpoint and fall-rule volumes. **Measured on the widest stretch**, so in a narrow stretch it spills
 * past the wall — but the wall stops anyone getting there, so spilling is the safe side (changing a stretch width cannot leak the band).
 */
const W = CORRIDOR_MAX_HALF_X + 1;

/** `x1` is the band's right end — `W` by default. Only `ship`, whose right side is an **abyss cut** and not a wall, narrows it (see that line). */
function cp(id: TutorialCheckpointId, x: number, y: number, z: number, z0: number, z1: number, x1 = W): CheckpointSpec {
  const upper = y > (DECK_UPPER_Y + DECK_LOWER_Y) / 2;
  return {
    id,
    at: new THREE.Vector3(x, y, z),
    yaw: 0,
    trigger: { x0: -W, x1, z0, z1, y0: upper ? UPPER_Y0 : LOWER_Y0, y1: upper ? UPPER_Y1 : LOWER_Y1 },
  };
}

/**
 * Ten spots. The order **must match** `TUTORIAL_CHECKPOINTS` (`TutorialWorld` checks it in its constructor).
 *
 * ⚠ **Placement rule**: every checkpoint is **outside** the sense radius of its stretch's enemies (`TUTORIAL_ENEMY_SENSE_M` = 12 m) —
 * because someone who respawned without a weapon has to be able to walk to their own corpse. The real distances are worked out in
 * the `ENEMIES` comment below, and the tightest is **17.46 m** (`android` → the left android). Move a coordinate and that table is recomputed.
 * **The one exception — `ship`** (2026-09-15 3rd pass, user's decision): the last two androids' sense radius is `FINAL_ANDROID_SENSE_M`
 * (22 m), reaching the ship's ramp and cargo bay, and the `ship` respawn spot (−12.5, −154 — 2026-09-16 the hill top) is 17.07 · 18.61 m
 * from them, i.e. **inside**. No band anywhere near the ship is outside 22 m (even the barrier's left gap (−12.2, −140) is 14.83 m). What
 * that stretch guarantees instead is ① the intended route kills both with a grenade first (the `grenade` step) and ② no enemy line of
 * sight opens on the fence's near side (the `BARRIER` check) — see the reference section in `docs/TODO.md`.
 *
 * Every respawn spot but `ship` is at **x = 0**, so it is inside the walls however `CORRIDOR_PROFILE` is narrowed (the narrowest
 * stretch's half-width is 4.6 m). `ship` is past the barrier's left gap (x −12.5), and that piece has bite 0 (`WALL_PLAIN_FROM_Z`), so 2.9 m to the wall.
 */
export const CHECKPOINTS: readonly CheckpointSpec[] = [
  cp('wake', 0, DECK_UPPER_Y, 112, 118, 104),      // the middle of the ruins — this is where he wakes up
  // Before cliff 1. From x 0 to the edge (82) is `CHASM_RUNUP_M` = 12 m of run-up — the spot comes from the constant, so it
  // is always the same value as 「the band where the respawn spot is not recorded」 (`TutorialWorld.pollSafeGround`).
  cp('cliff', 0, DECK_UPPER_Y, CHASM_NEAR_Z + CHASM_RUNUP_M, 100, 88),
  // ⚠ The band's start (75) must be behind **the furthest end of the diagonal gap** (far edge 75.60 at x +7.7). Otherwise
  // someone who failed the jump on cliff 1's right side passes this band **while falling** (the volume's y is open down to −3)
  // and gets the checkpoint across. A body pushed by the wall stays a body radius off the diagonal, so in practice z ≥ 76.08.
  cp('corpse', 0, DECK_UPPER_Y, 72, 75, 68),       // where the cliff was cleared. Corpse ① is 6 m ahead
  cp('bugs', 0, DECK_UPPER_Y, 60, 64, 54),         // the entrance of the bug battlefield — the bugs are 26 m ahead
  cp('crawl', 0, DECK_UPPER_Y, -10, -6, -14),      // **right in front of** the collapsed corridor (2026-09-14 3rd pass)
  cp('android', 0, DECK_UPPER_Y, -32, -28, -36),   // where the corridor opens out. Two androids
  cp('drop', 0, DECK_UPPER_Y, -71, -68, -75),      // **right in front of** cliff 2 (6 m from the edge, −77) — 2026-09-14 4th pass
  cp('supply', 0, DECK_LOWER_Y, -92, -88, -96),    // where he landed. Corpse ② is ahead
  // **Before** the diagonal barrier starts — the band ends 4 m in front of the barrier's nearest end (right, −116) (2026-09-15)
  cp('wall', 0, DECK_LOWER_Y, -108, -104, -112),
  // 2026-09-15: past the barrier's left gap, **in front of the ship ramp**. The band (−150 … −158) is behind the two androids
  // (z −144.75), so heading for them through the gap does not hand out the checkpoint first. The band covers the ramp foot (−154.8), so walking to the ramp always crosses it.
  // ⚠ 2026-09-15 3rd pass — the pit's (`PIT`) front end is −149.0, so it must stay **1.0 m** from this band (−150) (the 2nd pass's −148 moved 2 m back).
  //    This checkpoint is `CHECKPOINT_STEP.ship = 'extract'`, so merely jumping into the pit must not skip the tutorial's grenade step.
  //    The band's right end is not `W` but **the end of the ship strip** (`SHIP_STRIP_X1`) — to its right is not wall but an abyss cut (`cut_s`),
  //    so a falling body (the volume's y is open down to −13) must not pick the checkpoint up on its way past.
  // 2026-09-16 — the ship hill: the respawn spot moved to **the hill top** (z −154, y `SHIP_HILL_Y`). The old −152 was mid-ramp (−149 … −153.5),
  //    respawning on the slope. The band (−150 … −158) is unchanged — it turns on mid-ramp, and its y (−13 … −4) holds the hill.
  //    x −12.5 · z −154 is 2.1 m from the ramp toe's left corner (−10.64, −155.08).
  cp('ship', -12.5, SHIP_HILL_Y, SHIP_HILL_Z0 - 0.5, -150, -158, SHIP_STRIP_X1),
];

/* ── Fall rules ──────────────────────────────────────────────────────────── */

export interface FallRuleVolume extends Volume { readonly rule: TutorialFallRule }

/**
 * The rule decided by **where** a body lands. Outside every volume the global fall damage applies unchanged (`normal`).
 * The first match in list order wins.
 */
export const FALL_RULES: readonly FallRuleVolume[] = [
  // Cliff 1's floor — it means the jump was not made, so it kills outright and sends him back to the checkpoint.
  // The band is the diagonal gap's **outer rectangle** (`CHASM`) plus 1.5 m. In that z range the only place with a y below
  // `DECK_UPPER_Y − 3` is the chasm (on the upper deck y = 0), so there is no need to cut it along the diagonal itself.
  // 2026-09-15: the chasm floor is a `CHASM_FLOOR_Y` collider and no longer terrain, so y0 is measured from that height.
  { rule: 'kill', x0: -W - WALL_T, x1: W + WALL_T, z0: CHASM.z0 + 1.5, z1: CHASM.z1 - 1.5, y0: CHASM_FLOOR_Y - 6, y1: DECK_UPPER_Y - 3 },
  // Cliff 2's landing zone — a fall that must be survived. Damage lands, but never takes hp below 1
  { rule: 'clamp', x0: -W, x1: W, z0: CLIFF2_EDGE_Z, z1: -102, y0: DECK_LOWER_Y - 4, y1: DECK_LOWER_Y + 4 },
  // 2026-09-15 — **the abyss** (in front of the ship). Past the edge, reaching `VOID_Y` (the terrain) kills → respawn as usual.
  // x is opened generously out to where the descending walls spread (the last piece's inner face, 18.4), z past `Z_END`. The top
  // end is `DECK_LOWER_Y − 3`, so a body standing on the lower deck edge (y −10) is outside this volume.
  { rule: 'kill', x0: -CORRIDOR_OUTER_X - 6, x1: CORRIDOR_OUTER_X + 6, z0: ABYSS_EDGE_Z, z1: Z_END - 10, y0: VOID_Y - 6, y1: DECK_LOWER_Y - 3 },
  // 2026-09-15 3rd pass — **the abyss cuts beyond the fence** (`ABYSS_CUTS`): the same `kill`. The rectangles are grown by 1 m, but the top
  // end `DECK_LOWER_Y − 3` keeps a standing body out even where the growth laps onto the deck (a falling body is pushed off the deck's side face into the hole).
  ...ABYSS_CUTS.map((c): FallRuleVolume => ({ rule: 'kill', ...growRect(c, 1), y0: VOID_Y - 6, y1: DECK_LOWER_Y - 3 })),
];

/* ── The diagonal barrier (last stretch) ─────────────────────────────────── */

/**
 * **The diagonal barrier, a `\` seen from above** (2026-09-15, user's decision — replacing the old 「collapsed wall」 that crossed the corridor with only 5 m open in the middle).
 * With forward drawn upward it starts at the near right (`near`, **inside** the right cliff wall) and reaches left and forward; the
 * corridor is blocked but for **the gap at the left end** (between the `far` end and the left wall). The player walks left and forward along the barrier's near face and rounds the gap.
 *
 * Three blocks (distance measured along the barrier from the `far` end):
 *   0 … `solidFarM`                        concrete (height `solidHeight`)
 *   `solidFarM` … length − `solidNearM`    **a horizontal-slat blind fence** (height `fenceHeight`) — the far side shows between the slats
 *   length − `solidNearM` … length         concrete
 *
 * **The fence looks half-height but cannot be climbed** (2026-09-15 2nd pass, user's decision — 「low enough to throw over easily, but
 * not climbable」). The drawn fence is `fenceHeight` (1.35 = half the old 2.7) and the collider is **two layers** (`parts/Dressing.buildBarrier`):
 *   lower  y 0 … `fenceHeight`             an ordinary rotated OBB — it blocks people · enemies · bullets · grenades alike.
 *   upper  y `fenceHeight` … `blockHeight` the same rotated OBB with `passRays` + `passSmall` on, a **ghost band**
 *         (world-internal flags on `SpatialHash.ObstacleEntry` — the ones a broken window frame uses):
 *         `raycast` ignores it, so **bullets and enemy sight pass over**, and `resolveCollision` only lets through a body with
 *         a radius under `SMALL_BODY_R` (0.25), so **a grenade passes while a person (0.45) and enemies are pushed out**.
 * The seam between the two blocks **overlaps** by `BARRIER_GHOST_OVERLAP` (0.05) — on exactly the same line, floating-point error
 * can drop a point on that line out of both (the same reason `TILE_OVERLAP` exists).
 *
 * **Is the far side of the diagonal visible** (drawing and judgement measured separately — the judgement is blocked only by the 1.35 block below):
 *   - Player → android: eyes `EYE_STAND` 1.55, and the android's chest is the pit floor + 1.17 = deck **+0.27**, so the line of
 *     sight goes down. Standing **within 1.85 m** of the fence the line is above the fence top (1.35) and **clears it**; further
 *     back the line eases to under 6.2° and shows **between the slats** (vertical angle 7.0° — `SLAT_*` in `parts/Dressing`). The
 *     two ranges meet, so from anywhere he can see and **can shoot** (the line of sight is the ballistic line — `weapons/parts/AimLine`).
 *   - Android → player: `Perception.hasLineOfSight` is eye → **chest**. The android's eye is the pit floor + 1.44 = deck **+0.54**,
 *     so the fence top (+1.35) is **0.81 m above** the eye while the player's chest (deck +1.17) is only **0.63 m** above it —
 *     the line never rises to 0.81, so it is **blocked at any distance** → it **cannot see or shoot** a player beyond the fence.
 *     ⚠ Not because of the pit (`PIT`) — without the pit either (eye = deck +1.44, the top 0.09 below it) the chest is 0.27 below
 *     the eye, so within 20 m of the fence it is always blocked. That is, **halving the height still does not open the enemy's line** (checked with the model, not measured in game).
 *     So this stretch is still **the player striking first**, and once the barrier's left gap is rounded it is the usual firefight.
 *
 * **Arithmetic check** (`near` (17, −116) · `far` (−8.5, −140)):
 *   - Length √(25.5² + 24²) = **35.02 m**, direction (0.7282, 0.6853) = 43.3° from the x axis — a `\`.
 *   - The gap = **6.9 m** from the left wall's inner face (−15.4, bite 0 on the z −132…−142 piece) to the `far` end (−8.5) (7.7 × the player's 0.9 diameter).
 *   - `near`'s x 17 is inside the right cliff wall's body (inner face 13.2 … outer face 18.4), so there is no gap between barrier and wall.
 *   - Its nearest end is z −116, so it starts 4 m behind the `wall` checkpoint band (−104 … −112).
 *   - **Cannot be climbed**: jump height `JUMP_SPEED² / 2g` = 7.6² / 48 = 1.20 m plus the step-up ledge `PROP_STEP_UP_MAX` 0.9 is still
 *     **2.10 m** < the ghost band top `blockHeight` 2.7 · concrete 3.0. (Had only the drawn 1.35 blocked, it would have been cleared exactly.)
 *   - **Thrown over**: even thrown **horizontally** from hand height 1.55 the trajectory tops out at 1.55 + 3.5²/(2×24) = **1.805 m** > 1.35,
 *     so no upward throw is needed (the old 2.7 needed 7.5° or more and landed that much further away). A grenade that gets over is stopped by the pit's south wall (`PIT_WALLS`).
 *   - **The thickness** 1.2 m (`halfT` 0.6) is because of grenades. A throwable moves its position each step and `resolveCollision`
 *     then pushes it out through the **nearer face**, so advancing more than half the barrier (0.6) + the body (0.08) = 0.68 m in one
 *     step pushes it out the far side. At 34 m/s, 0.68 m = **50 fps** or more blocks even a grenade thrown straight at it (the old
 *     collapsed wall's 2.2 m was 29 fps). The drawing is 1.1 m thick with two layers of slats, so collider face and slats differ by 5 cm.
 */
export const BARRIER = {
  // the end points · thickness are `BARRIER_NEAR_END` · `BARRIER_FAR_END` · `BARRIER_HALF_T` higher up the file (the fence stair reads them first in initialisation order)
  near: BARRIER_NEAR_END,
  far: BARRIER_FAR_END,
  halfT: BARRIER_HALF_T,
  /**
   * The **drawn** height of the fence. 2026-09-15 2nd pass, user's decision: 2.7 → **1.35** (half) — throwing over is the point of
   * this stretch, and 2.7 could not be cleared by a horizontal throw (top 1.855). Blocking is `blockHeight`'s job instead.
   * 2026-09-17, user's decision: ×1.5 → **2.025**. A horizontal throw (top 1.805) now catches, and it takes **a slightly raised throw** to get over.
   * It is above standing eye height (1.55), so nowhere sees over the top; the far side shows only between the slats (vertical angle 10.4° — `SLAT_*` in `parts/Dressing`)
   * (the angle onto an android's chest in the pit is 6.2° or less even standing against the fence). It is still below `blockHeight` 2.7 · `solidHeight` 3.0.
   * The collider (the lower block's top) reads this value directly, so it rises with the drawing. The 1.35-based checks in the table below are the 2026-09-15 values.
   */
  fenceHeight: 2.025,
  /**
   * The **top face** of the column that blocks people and enemies (measured from the fence's foot). Above `fenceHeight` it is a
   * `passRays` + `passSmall` ghost, invisible and passed by bullets · sight · grenades, but a body is pushed out up to here. Why: it must be above jump 1.20 + the step-up ledge 0.9 = **2.10 m**.
   */
  blockHeight: 2.7,
  /**
   * The height of the concrete blocks. It has to stay below the liftoff cutscene camera (`CAM_OFFSET` y 3.2 in `extraction/Cinematic`
   * — **measured from the ship floor**): the camera starts 3 m beside the barrier's `far` end (the `SHIP_POS` check below), so any higher
   * and it starts inside the concrete. With 2026-09-16 standing the ship on the hill (`SHIP_HILL_RISE` 0.9) the camera starts at deck +4.1 — the limit went 3.2 → **4.1**, 1.1 m of room today.
   */
  solidHeight: 3.0,
  /** The length of the concrete block at the `far` end. */
  solidFarM: 3.5,
  /** The length of the concrete block at the `near` end (1.6 m of it is buried in the right wall). */
  solidNearM: 8,
} as const;

/** The height the lower (blocking) block and the upper (ghost) block overlap by — the same reason as `TILE_OVERLAP`. */
export const BARRIER_GHOST_OVERLAP = 0.05;

/** The barrier's length (m). */
export const BARRIER_LEN = Math.hypot(BARRIER.near.x - BARRIER.far.x, BARRIER.near.z - BARRIER.far.z);
/** The unit vector `far` → `near` (along the barrier). */
export const BARRIER_DIR = {
  x: (BARRIER.near.x - BARRIER.far.x) / BARRIER_LEN,
  z: (BARRIER.near.z - BARRIER.far.z) / BARRIER_LEN,
} as const;
/** The normal toward the **near side** (the side the player comes from, +z component positive) = the direction turned +90°, `(−dir.z, dir.x)`. */
export const BARRIER_NORMAL = { x: -BARRIER_DIR.z, z: BARRIER_DIR.x } as const;
/** The mesh `rotateY` value — local +X becomes the barrier direction (`rotateY(θ)` sends +X to `(cos θ, −sin θ)`). */
export const BARRIER_MESH_YAW = -Math.atan2(BARRIER_DIR.z, BARRIER_DIR.x);

/** Barrier coordinates (`along` = the distance along the barrier from the `far` end, `depth` = + toward the near side) → world XZ. */
export function barrierPoint(along: number, depth: number): { x: number; z: number } {
  return {
    x: BARRIER.far.x + BARRIER_DIR.x * along + BARRIER_NORMAL.x * depth,
    z: BARRIER.far.z + BARRIER_DIR.z * along + BARRIER_NORMAL.z * depth,
  };
}

/** World XZ → barrier coordinates. */
export function barrierLocal(x: number, z: number): { along: number; depth: number } {
  const dx = x - BARRIER.far.x, dz = z - BARRIER.far.z;
  return { along: dx * BARRIER_DIR.x + dz * BARRIER_DIR.z, depth: dx * BARRIER_NORMAL.x + dz * BARRIER_NORMAL.z };
}

/* ── The android pit's ramp (last stretch) ───────────────────────────────── */

/**
 * The horizontal run of the **ramp** filling the face toward the ship (−X). East and south are walls (`PIT_WALLS`); north (the fence
 * side — from 2026-09-16 the lip `pit_rim_n`, cliff beyond it) and the ramp's south lip (x −2 … 1.5 — beyond it the hill ramp
 * `SHIP_SLOPE`) are 0.9 m lips (vertical). So the pit is an **island** and this ramp is the only way in (people and enemies can
 * step up a 0.9 m lip, but beyond the north lip is cliff).
 * Slope atan(0.9 / 2.5) = **19.8°** — inside `PlayerController`'s `STEEP_COS` (50°), and being a ramp collider (`Obstacle.ramp`)
 * it never goes through the terrain slope test at all (`CLAUDE.md` 「the terrain slope test applies only while the feet are on terrain」).
 *
 * Why the −X face: the player rounds the barrier's left gap (≈ x −12.2, z −140) and walks to the ship (−8.5, −158) — the pit's
 * −X face is the one facing that path. Putting the hill here makes the decision's 「it runs up a hill to where the ship is」 true as
 * written, and an android chasing out comes up toward the player. From the ramp's top end (x −2) to the ship path (x ≤ −8.5) is 6.5 m, so it does not block the path.
 */
export const PIT_RAMP_RUN = 2.5;
/** The x where the ramp ends and the flat floor starts (0.5). A1 (x 1.85) is **1.35 m** inside it, so it stands on the flat. */
export const PIT_RAMP_TOE_X = PIT.x0 + PIT_RAMP_RUN;
/**
 * How far the ramp collider bites under the deck — `CLAUDE.md`'s 「a ramp's top end must overlap the flat floor plate by 0.08 m」.
 * On exactly the same line, floating-point error makes both sides miss the point at the seam and the ground drops a level.
 */
export const PIT_RAMP_OVERLAP = 0.08;

/**
 * The **pit surface height** at that spot (the flat floor or the ramp), or null outside the pit. Used by the dressing
 * (`parts/Dressing`) when it puts debris inside the pit — at deck height it would look 0.9 m off the ground.
 */
export function pitSurfaceY(x: number, z: number): number | null {
  if (!rectContains(PIT, x, z)) return null;
  if (x >= PIT_RAMP_TOE_X) return PIT_FLOOR_Y;
  return DECK_LOWER_Y - PIT_DEPTH * ((x - PIT.x0) / PIT_RAMP_RUN);
}

/**
 * The **ship hill surface height** at that spot (the `SHIP_SLOPE` ramp or the `ship_hill` top), or null off the hill (2026-09-16). Used
 * when the dressing puts debris on the hill and when `parts/Ground` draws the ramp wedge (the same reason as `pitSurfaceY` — at deck height it would be 0.9 m buried).
 * It is the drawn slope (0.9 over 4.5 m) — the ramp collider bites 0.08 m further under the hill and is at most 1.6 cm lower (`Ground.buildShipSlope` ④).
 */
export function shipHillSurfaceY(x: number, z: number): number | null {
  if (x < -CORRIDOR_MAX_HALF_X || x > SHIP_STRIP_X1 || z > SHIP_SLOPE.z0 || z < ABYSS_EDGE_Z) return null;
  if (z <= SHIP_HILL_Z0) return SHIP_HILL_Y;
  return DECK_LOWER_Y + SHIP_HILL_RISE * ((SHIP_SLOPE.z0 - z) / SHIP_SLOPE_RUN);
}

/* ── The abandoned ship (= the real extraction ship, stood up landed) ────── */

/**
 * The spot handed to `ctx.extraction.beginPreLanded(position, yaw)`. The ship's origin sits on the deck (the `Ship.floorYAt`
 * convention), and **the rear ramp opens toward `(sin yaw, cos yaw)`** — at yaw 0 that is +Z, i.e. facing the approaching player.
 * (It has to stand **before** the enemy list — the last two androids take their yaw from `SHIP_POS`.)
 *
 * 2026-09-15 (user's decision — 「the ship on the left, slightly angled, with the ramp facing the way he comes from」): it stands on the
 * **left** (x −8.5) at **yaw −10°**. The ramp faces back left (−0.174, 0.985), so it is walked straight into from the barrier's left
 * gap. Liftoff flies out nose-first, (0.174, −0.985) = front right, **away from the wall**.
 *
 * **Arithmetic check** (world; the `extraction/Hull` shell + ramp + nacelles · wings · tail were stepped at 0.25 m and measured):
 *   - Footprint x −13.13 … −2.76 · z −167.80 … −154.50 → **2.27 m** to the left wall (−15.4, `WALL_PLAIN_FROM_Z`), **4.20 m** to the
 *     abyss edge (−172), **14.05 m** to the barrier, **4.26 m** to the ship strip's right end (`SHIP_STRIP_X1` 1.5, an abyss cut beyond it).
 *     2026-09-16: the ship hill `ship_hill` (x −15.4 … 1.5 · z −153.5 … −172) holds the whole footprint — the ramp toe (z −154.52 … −155.08)
 *     is 1.0 m behind the end of the ramp up. x · z · yaw are unchanged since 2026-09-15.
 *   - **y = `SHIP_HILL_Y`** (2026-09-16): the rear ramp lies out **flat** at the ship floor height (`rampAngle` 0 in `extraction/Ship`), so it must
 *     match the hill top beneath it — lower and a lip appears at the ramp's end, higher and the ground comes up through the ramp. The hull
 *     collider's floor (`ship.getGroundY()` in `extraction/Hull` = this y) and the cargo-bay floor drawing's margin (`Ship.GROUND_DRAW_LIFT_MAX` — the hill top plate is `TOP_LIFT` 0.02 too) both still fit.
 *   - The ramp foot (local 0, 3.25) = (−9.06, −154.80). Walking there from the middle of the gap (−12.20, −140) is **2.0°** off the ramp axis.
 *     That path (x ≈ −9 … −12) stays 6.5 m or more from the pit ramp's top end (x −2).
 *   - The liftoff trajectory (1.6 s spool + climb `6a² + 2a` · forward `12(a − 0.8)²` · nose-up 0.35 rad) was followed at 0.02 s steps and every
 *     sample compared against the side cliff wall pieces (inner face · top face) — **nothing touches** (before clearing the wall tops it has only moved 18.5 m front-right).
 *     The pit walls (top deck +2.5 = −7.5) are 4.26 m or more to the right of the footprint in x, so they are irrelevant to the trajectory.
 *   - The liftoff cutscene camera's first spot (local 7.5, 3.2, 17) = (−4.07, **−5.9**, −139.96) (2026-09-16 hill +0.9): 3.0 m across the barrier ·
 *     3.3 m from the `far` end, so **1.1 m** above the concrete block (top −7.0), and below it is the fence stair's abyss cut (column x −4.5 … −3.5) —
 *     a floating camera needs no floor. It is 2.07 m clear of the pit (`PIT`, x ≥ −2) in x.
 */
export const SHIP_POS = new THREE.Vector3(-8.5, SHIP_HILL_Y, -158);
export const SHIP_YAW = (-10 * Math.PI) / 180;

/* ── Enemies ─────────────────────────────────────────────────────────────── */

export interface EnemySpot {
  readonly type: string; readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  /** This one body's own sense radius (m). Absent = `ENEMY_SENSE` (csv). Only the last two use `FINAL_ANDROID_SENSE_M`. */
  readonly sense?: number;
  /**
   * The **family id** of the gun the spawn hands over (the grade I id in `data/weapons.csv` — `'sg'` · `'dmr'`). Absent = the first
   * entry of the faction table (`enemies/Tutorial.weaponFor`). On a `*_loot` type that gun drops on the corpse as is (`loot_corpse_rolls.csv`).
   */
  readonly weapon?: string;
}

/**
 * One row the world hands to `enemies/` = the shared contract `TutorialEnemySpawn` + this map's own `weapon`. The contract
 * (`shared/tutorialWorld`) is add-only, but other work is editing `src/shared` right now, so it was left alone — the world builds
 * with this extended type and `enemies/Tutorial` reads `weapon` as an optional field (reference section in `docs/TODO.md`: moving it onto the contract).
 */
export interface TutorialSpawnSpec extends TutorialEnemySpawn { weapon?: string }

/**
 * The last two androids — ±0.9 in x from the pit's centre (2.75, −144.75) (a **1.8 m** gap, 1.0 m between the bodies (radius 0.4)).
 * Why they stand that close is in the `PIT` comment (「×1.55 and not ×2」) — the corner table's maximum 7.07 < `GRENADE_RADIUS` 7.2 comes from this gap.
 *   A1 = (1.85, −144.75) shotgun · A2 = (3.65, −144.75) designated marksman rifle, feet at `PIT_FLOOR_Y`.
 * In barrier coordinates A1 is along 4.28 · depth −10.55 and A2 along 5.59 · depth −11.79 — both in front of the fence block
 * (along 3.5 … 27.0), so neither hides behind a concrete block, and they are 10.5 · 11.8 m across the fence (about the 2nd pass's 10 m).
 */
export const FINAL_ANDROIDS = { cx: (PIT.x0 + PIT.x1) / 2, cz: (PIT.z0 + PIT.z1) / 2, halfGap: 0.9 } as const;
/**
 * The last two's sense radius (m) — 2026-09-15 3rd pass, user's decision 「so the ship's ramp and cargo bay fall inside the sense
 * radius (~22 m)」. A shape number, so it lives here: from the two of them to the ramp foot (−9.06, −154.8) is **14.84 · 16.21** and
 * to the cargo-bay centre (local z −2.5 = (−8.07, −160.46)) **18.58 · 19.60**, so 22 leaves 2.4 m of room. The other four keep csv's `TUTORIAL_ENEMY_SENSE_M` (12).
 * That this radius also holds the `ship` checkpoint (17.07 · 18.61) and the barrier's left gap (14.83 · 16.55) is the exception in the `CHECKPOINTS` comment.
 * Once the switch is pressed, the liftoff fire window in `enemies/Tutorial` widens the radius further to `TUTORIAL_LIFTOFF_FIRE_RANGE_M` (the second waking).
 */
export const FINAL_ANDROID_SENSE_M = 22;
const FINAL_A1 = { x: FINAL_ANDROIDS.cx - FINAL_ANDROIDS.halfGap, z: FINAL_ANDROIDS.cz };
const FINAL_A2 = { x: FINAL_ANDROIDS.cx + FINAL_ANDROIDS.halfGap, z: FINAL_ANDROIDS.cz };
/**
 * The yaw that looks at the **ship** (`SHIP_POS`) from that spot. An enemy yaw's front is `(sin yaw, cos yaw)` (`enemies/Enemy.facing` · `ai/Steering`) → yaw = atan2(dx, dz).
 * A1 **−2.478** (−142.0°, front (−0.616, −0.788)) · A2 **−2.399** (−137.5°, front (−0.676, −0.737)) — both look at the ship ahead to the left.
 * ⚠ Corrected on 2026-09-16: the earlier atan2(−dx, −dz) copied the **player** yaw convention (front `(−sin, −cos)`), so both stood with their backs to the ship.
 */
function yawToShip(x: number, z: number): number { return Math.atan2(SHIP_POS.x - x, SHIP_POS.z - z); }

/**
 * Six bodies. No rolls, no waves, no patrols (`enemies/` reads this once on `world:ready` and stands them as given).
 * The first four are yaw = π and face the approaching player (+Z), and the last two face the **ship** (`yawToShip`) (2026-09-15 3rd pass — up to the 2nd they faced the fence).
 *
 * **Types** (2026-09-14 3rd pass — tutorial-only types, `data/enemies.csv` · `enemies/EnemyTypes.TUTORIAL_ENEMY_BASE`):
 * only `*_loot` has a guaranteed drop; the rest drop nothing. **+x is the right hand of a walking player**
 * (the forward × up calculation in the coordinate convention section).
 *   bugs              — **near one (z 34) = right (x +2.5) `tut_bug_loot`** · far one (z 28) = left (x −2.5) `tut_bug`
 *                       (2026-09-15, user's decision — left and right were swapped. The drop is still the near one)
 *   crouching androids — right (x +7) `tut_android_loot` (assault rifle) · left (x −7) `tut_android`
 *   across the fence   — both `tut_android_loot` (2026-09-15 3rd pass, user's decision — 「both drop 100 %, one a shotgun and one a designated marksman rifle」):
 *                       A1 `weapon: 'sg'` · A2 `weapon: 'dmr'`. Grade I as they are (`loot_factions.csv` has no tut row, so there is no grade roll),
 *                       one full stack of their ammo (shells · heavy rounds) and one `mat_cable` — the same rule as the right crouching android's assault rifle.
 *
 * **Distances to the checkpoints** (the grounds for clearing the sense radius — 12 m for the first four · 22 m for the last two. Move a coordinate and this is recomputed):
 *   `bugs`(0,60)          → (2.5,34) 26.12 · (−2.5,28) 32.10
 *   `crawl`(0,−10)        → (2.5,34) 44.07 · (−2.5,28) 38.08
 *   `android`(0,−32)      → (−7,−48) **17.46** · (7,−54) 23.09
 *   `drop`(0,−71)         → (−7,−48) 24.04 · (7,−54) 18.38
 *   `wall`(0,−108)        → A1 36.80 · A2 36.93
 *   `ship`(−12.5,−154)    → A1 17.07 · A2 18.61 — **inside 22 m** (the one exception, the `CHECKPOINTS` comment. 2026-09-16 the respawn spot moved 2 m to the hill top)
 * Excluding that exception the tightest is 17.46 m.
 *
 * **Is each inside its own stretch's walls** (half-widths from `corridorHalfXAt`):
 *   two bugs   (z 34 · 28) half-width `CORRIDOR_BUG_HALF_X` 4.6 → `|x|` 2.5 + `radius` 0.45 = 2.95, **1.65 m of room**.
 *              The wall's inner face bites in further by `Ground`'s bite, but that share shrinks with the width too (4 × 0.55 × 4.6/15.4
 *              = 0.66), so at minimum 3.94 and **0.99 m of room** remains. Swapping left and right keeps `|x|`, so it is unchanged.
 *   two crouching (z −48 · −54) half-width 15.4 → `|x| ≤ 7`, 8.4 m of room or more.
 *   last two   (z −144.75) inside the pit — 3.45 m from A2's body edge (4.05) to the east wall (7.5), 0.95 m from A1's body edge (1.45) to the ramp toe (0.5).
 *
 * **The two across the fence** (2026-09-15 — 「seen between the slats, both from one grenade thrown over」; 3rd pass — 「they stand facing the ship · the ship is inside their sense」):
 *   - Both are **10.5 · 11.8 m across the fence** and 4.3 · 5.6 m along the barrier, so from anywhere on the near side what is in front of them is the fence block (3.5 … 27.0 m).
 *   - Grenades: the `PIT` · `PIT_WALLS` comments — thrown horizontally over the fence one hits the south wall (2.5 m) and drops to its foot, and **wherever it goes off
 *     inside the pit** both are within 7.2 m, so 30 damage ≥ hp 30 (2026-09-17 — the old 150 > 140).
 *   - **The ship is visible** — the eye is the pit floor + 1.44 = **−9.46** and the target chest is the **ship hill** (`SHIP_HILL_Y`) + 1.17 = **−7.93** (`Perception.hasLineOfSight`
 *     is eye → chest). The only faces open from the pit toward the ship are the west (the ramp, x −2) and the ramp's south lip (x −2 … 1.5, z −149) (beyond the north lip is cliff,
 *     east and south are walls). Where the line crosses that boundary / where it comes **closest to the ground** behind it — remeasured for the 2026-09-16 hill +0.9 (0.001 sampling,
 *     with the pit ramp · lips · walls · hill ramp · hill corner all included). The target rose 0.9 and the line only steepened; nothing blocks it:
 *       A1 → ramp foot (−9.06, −154.8):     crosses x −2 at z **−148.29** · line −8.92 / nearest ground: the hill corner (−7.65, −153.5), **0.97 m** above
 *       A2 → ramp foot:                     crosses z −149 at x **−1.73** · line −8.81 (above the pit ramp's −10.10) / hill corner (−7.42, −153.5), 0.97 m above
 *       A1 → cargo-bay centre (−8.07, −160.46): crosses z −149 at x **−0.83** · line −9.05 / hill corner (−3.67, −153.5), **0.49 m** above
 *       A2 → cargo-bay centre:                crosses z −149 at x **0.48** · line −9.05 — **1.02 m** to the south wall's start (1.5) (why `SHIP_STRIP_X1` is 1.5) / 0.49 m above the hill corner
 *       A1 · A2 → the barrier's left gap (−12.2, −140, chest −8.83): crossing x −2 at z −143.45 · −143.06 → visible from the moment he rounds the gap (14.83 · 16.55 m).
 *       A1 · A2 → the `ship` respawn spot (−12.5, −154): 17.07 · 18.61 m, at least 0.95 · 1.08 m above the ground.
 *     The cargo-bay entrance width check (±1.6, local z 0.6) is unchanged from the 2nd pass: a body standing up to 0.8 m inside the ramp is seen straight on, while the
 *     cargo-bay centre is hidden by the hull's side panel. The hull collider is removed after the liftoff spool (1.6 s) (`extraction/Hull`), so after that the line reaches a body inside the rising ship.
 *   - **Two wakings** (user's decision — both): ① the sense radius `FINAL_ANDROID_SENSE_M` 22 m holds the ramp and the cargo bay, ② pressing the switch
 *     (= the tutorial ship goes straight to `extraction:liftoff`) makes the fire window in `enemies/Tutorial.onTutorialLiftoff` attach humanoids within 40 m to whoever is aboard.
 *   - `homeLeash` 22 m: they can chase out as far as the ramp foot (14.84 · 16.21) and no further than the ship's footprint.
 */
export const ENEMIES: readonly EnemySpot[] = [
  { type: 'tut_bug_loot', x: 2.5, y: DECK_UPPER_Y, z: 34, yaw: Math.PI },       // near · right — drops a weapon and materials
  { type: 'tut_bug', x: -2.5, y: DECK_UPPER_Y, z: 28, yaw: Math.PI },           // far · left
  { type: 'tut_android', x: -7, y: DECK_UPPER_Y, z: -48, yaw: Math.PI },        // left
  { type: 'tut_android_loot', x: 7, y: DECK_UPPER_Y, z: -54, yaw: Math.PI },    // right — assault rifle · ammo
  // across the fence (both from one grenade) — they stand on the **pit floor** (`PIT`) and face the **ship**. Both guaranteed drops: shotgun · designated marksman rifle (2026-09-15 3rd pass)
  { type: 'tut_android_loot', x: FINAL_A1.x, y: PIT_FLOOR_Y, z: FINAL_A1.z, yaw: yawToShip(FINAL_A1.x, FINAL_A1.z), sense: FINAL_ANDROID_SENSE_M, weapon: 'sg' },
  { type: 'tut_android_loot', x: FINAL_A2.x, y: PIT_FLOOR_Y, z: FINAL_A2.z, yaw: yawToShip(FINAL_A2.x, FINAL_A2.z), sense: FINAL_ANDROID_SENSE_M, weapon: 'dmr' },
];

export const ENEMY_SENSE = TUTORIAL_ENEMY_SENSE_M;
export const ENEMY_LEASH = TUTORIAL_ENEMY_LEASH_M;

/* ── Three corpses ───────────────────────────────────────────────────────── */

/**
 * A fixed item list — **no container roll**. `qty: 'stack'` means one cell full of that item's `stackMax` (ammo), so that the
 * number is not written into the code.
 */
export interface CorpseSpec {
  /** The `corpse:` prefix = the only kind a light pillar stands on (`ui/hud/pillar.pillarAllowed`). */
  readonly id: string;
  readonly name: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly yaw: number;
  readonly items: readonly { readonly id: string; readonly qty: number | 'stack' }[];
}

/**
 * All three are `|x| ≤ 9` and inside their stretch's half-width (6.67 · 7.7 · 15.4) — ① sits in the middle of the bug stretch's
 * funnel (z 66), which shrank 10.3 → 6.67 in the 2026-09-14 4th pass, but its `x` is only 2, so it is left alone.
 * ③ (9, −117) **did not move** when the diagonal barrier arrived on 2026-09-15: in barrier coordinates it is along 28.5 · depth **+4.41**
 * (near side) — 3.8 m in front of the right-hand concrete block, so neither inside the barrier nor across it, and right where walking along the wall starts.
 * It is 28.66 · 28.26 m from the two androids across the fence (1.85 · 3.65, −144.75), outside their sense radius (`FINAL_ANDROID_SENSE_M` 22 m).
 * 2026-09-15 3rd pass — it is **23.5 m in z** from the pit (`PIT`, x −2 … 7.5 · z −140.5 … −149) and **8.2 m** from the edge (z −125.17)
 * of the 2026-09-16 fence stair column [8.5, 9.5], so it is still flat ground.
 */
export const CORPSES: readonly CorpseSpec[] = [
  {
    id: 'corpse:tut_gear', name: '분대원의 시체', x: 2, y: DECK_UPPER_Y, z: 66, yaw: 2.3,
    items: [{ id: 'wpn_smg', qty: 1 }, { id: 'bag_common', qty: 1 }, { id: 'ammo_light', qty: 'stack' }],
  },
  {
    id: 'corpse:tut_supply', name: '위생병의 시체', x: -3, y: DECK_LOWER_Y, z: -100, yaw: -1.1,
    items: [{ id: 'heal_bandage', qty: 2 }, { id: 'grenade_frag', qty: 2 }],
  },
  {
    id: 'corpse:tut_relic', name: '약탈자의 시체', x: 9, y: DECK_LOWER_Y, z: -117, yaw: 0.6,
    items: [{ id: 'gem_amber', qty: 1 }, { id: 'cred_chip', qty: 2 }],
  },
];

/* ── Dimensions of the hand-built structures ─────────────────────────────── */

/** The collapsed corridor (the crawl stretch): the corridor narrows and a slab passes overhead. */
export const CRAWL = {
  z0: -14, z1: -28,
  /**
   * Half the passable width. 2026-09-14 2nd pass, user's decision: 3 → **2.1** (−30 %) — 「narrow enough that he has to crouch」 is
   * the point of this stretch, so it went narrower, but it is still **4.7 ×** the player's diameter (`PLAYER_RADIUS` 0.45 × 2 = 0.9 m),
   * so there is room to dodge sideways while crouched (4.2 m of passable width).
   */
  gapHalfX: 2.1,
  /**
   * The underside of the overhead slab at the **middle** of the stretch (from the deck top). It is between **blocking a standing body
   * (`BOX_HEADROOM` 2.1) and passing a crouched one (`PLAYER_CROUCH_CLEARANCE_M` 1.3)** — on 2026-09-14 `PlayerController` began
   * passing the stance height to `resolveCollision`, which made 「only a crouch gets through」 real. He cannot stand up under it either
   * (`player/parts/Locomotion.canStandHere`). Leave the range **between** the two constants and the stretch loses its point, so they are read together.
   *
   * 2026-09-15 1.65 → **1.825** (user's report 「crouching through it, the head is half buried in the ceiling」). The collider asks for 1.3, but
   * **the drawn head** is higher — the top of the crouched soldier model's head (`player/SoldierModel`) was measured:
   *   hips `hipsBaseY` 0.98 − crouch 0.36 = 0.62 → torso → head pivot 0.58 (torso lean cos ≤ 1) = 1.20
   *   → helmet sphere 0.17 + 0.145 × 1.08 = 0.327 (crest top 0.32) = **1.53**, plus the crouch-walk bob +0.023 = **1.55 m**.
   * The old entrance 1.35 was 0.20 m below that (over half of the 0.33 m helmet inside the slab). The new entrance 1.70 is **0.15 m above**.
   */
  clearance: 1.825,
  /**
   * The slab's thickness. 2026-09-14 4th pass, user's decision: 1.2 → **2.4** (「make the ceiling thicker upward」) — one thin plate
   * floating there read as a shelf, not collapsed wreckage. **The underside stays and it only thickens upward**: the drawing
   * (`Dressing` puts the centre at `clearance + slabThickness / 2`) and the collider (underside as base, thickness as height) are
   * both measured from the underside, so raising this value does not change the pass height by a hair. The top stays inside the
   * rubble piles on either side (height 5.2), so it does not poke out (1.95 + 2.4 = 4.35 at the exit, 1.70 + 2.4 = 4.10 at the entrance).
   */
  slabThickness: 2.4,
  /**
   * 2026-09-14 3rd pass — the slab is **tilted** so it reads as wreckage that collapsed and settled. This is the underside's gradient (dy/dz).
   * 4th pass, user's decision: **the sign was flipped**: the way in (z0) is low and the way out (z1) is high — where the camera used to
   * bury itself in the slab while aiming forward crouched (`crouchAim`) was the **exit**, and 「crawl in and then out」 fits this
   * stretch's meaning better than 「crawl into a hole that keeps getting lower」.
   * 2026-09-15: the exit (1.95) was left alone and **only the entrance was raised 1.35 → 1.70** (the `clearance` comment above — the crouched head top 1.55 + 0.15).
   * So the gradient **eased** from −0.6/14 to `−0.25 / 14` (rounding 0.017857… by hand into the file makes the two ends disagree).
   *
   * **Arithmetic check** (depth 14 m, `clearance` 1.825 in the middle):
   *   highest point z1 = −28 → 1.825 + 7 × 0.017857 = **1.950 m** < `BOX_HEADROOM` 2.1 → nowhere can he stand ✔
   *   lowest point z0 = −14 → 1.825 − 7 × 0.017857 = **1.700 m** > the crouched head top 1.55 + 0.15 ✔ (`PLAYER_CROUCH_CLEARANCE_M` 1.3 ✔)
   *   crouched eye height `EYE_CROUCH` 1.15 (aiming +0.22 = 1.37) is 0.33 m below the entrance's underside, so the camera does not bury itself.
   *
   * The collider is `slabSegments` axis-aligned boxes, and each piece's underside is the value at that piece's **middle**, so it
   * differs from the drawn underside by at most `(14/7)/2 × 0.017857` = **0.018 m**.
   * The underside per piece (z centres −15 · −17 · −19 · −21 · −23 · −25 · −27):
   *   **1.718 · 1.754 · 1.789 · 1.825 · 1.861 · 1.896 · 1.932** — all seven between 1.3 and 2.1 ✔
   * If even one drops below 1.3 it cannot be crawled either, and above 2.1 it can be walked through and the stretch loses its point.
   */
  slabSlope: -0.25 / 14,
  slabSegments: 7,
} as const;

/** The height of the slab's underside at that z (from the deck top). */
export function crawlClearanceAt(z: number): number {
  return CRAWL.clearance + CRAWL.slabSlope * (z - (CRAWL.z0 + CRAWL.z1) / 2);
}

/** The zone the starting ruins stand in. */
export const RUINS = { z0: 118, z1: 96 } as const;

/* ── Geometry helpers (the same trick as TrainingArena) ──────────────────── */

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

export function placed(geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  _q.setFromEuler(new THREE.Euler(0, ry, 0));
  _v.set(x, y, z);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  return placed(new THREE.BoxGeometry(w, h, d), x, y, z, ry);
}

/**
 * Samples whether the old lower deck rectangle (x ±`CORRIDOR_MAX_HALF_X` · z `CLIFF2_EDGE_Z` … `ABYSS_EDGE_Z`) is covered **exactly once** by the lower
 * pieces (those of `DECKS` with top < `DECK_UPPER_Y`) · `SHIP_SLOPE` · `PIT` · `PIT_WALLS` · `ABYSS_CUTS` (2026-09-16 — it replaces the hand check now that the fence stair is generated in code).
 * Returns up to 8 wrong spots (an empty array = correct). The 0.25 m sample step is narrower than the narrowest piece (column [8.1, 8.5] 0.4 m · lips · walls 0.6 m), and
 * the 0.113 offset does not land on a boundary value (0.5 · 0.1 units · stair edges), so a point on a boundary is never counted twice. Once at build time — a few ms.
 */
export function lowerTilingErrors(): string[] {
  const rects: Array<{ id: string; r: Rect }> = [];
  for (const d of DECKS) if (d.top < DECK_UPPER_Y) rects.push({ id: d.id, r: d.rect });
  for (const w of PIT_WALLS) rects.push({ id: w.id, r: w.rect });
  rects.push({ id: 'pit', r: PIT }, { id: 'ship_slope', r: SHIP_SLOPE });
  ABYSS_CUTS.forEach((c, i) => rects.push({ id: `cut_${i}`, r: c }));
  const out: string[] = [];
  const STEP = 0.25, OFF = 0.113;
  for (let x = -CORRIDOR_MAX_HALF_X + OFF; x < CORRIDOR_MAX_HALF_X; x += STEP) {
    for (let z = CLIFF2_EDGE_Z - OFF; z > ABYSS_EDGE_Z; z -= STEP) {
      let n = 0, first = '';
      for (const { id, r } of rects) if (rectContains(r, x, z)) { if (n === 0) first = id; n++; }
      if (n === 1) continue;
      out.push(`(${x.toFixed(2)}, ${z.toFixed(2)}) ${n === 0 ? '빈틈 (바닥도 구멍도 아니다)' : `겹침 ×${n} (${first} …)`}`);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** `rect` as a box geometry with underside `y0` and top `top`. */
export function rectBox(rect: Rect, y0: number, top: number): THREE.BufferGeometry {
  const w = rect.x1 - rect.x0, d = rect.z0 - rect.z1, h = top - y0;
  return box(w, h, d, (rect.x0 + rect.x1) / 2, y0 + h / 2, (rect.z0 + rect.z1) / 2);
}
