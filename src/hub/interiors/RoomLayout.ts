import * as THREE from 'three';
import {
  COCKPIT_GRID_COLS, COCKPIT_GRID_ROWS, COCKPIT_ROOM_INDEX, HOUSING_CELL_SIZE, ROOM_GRID_COLS, ROOM_GRID_ROWS, SHIP_ROOM_COUNT,
  roomGridSize,
} from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Personal-ship layout (metres, world space; the ship is built at the origin, player forward = −Z at spawn).
 *
 *   cockpit   x −5 … 5,   z −6 … 0          (10 × 6 m, viewport on the −Z wall)
 *   corridor  x −1.5 … 1.5, z 0 … ROOMS_PER_SIDE·SEGMENT   (3 m wide, one SEGMENT per room pair)
 *   room i    ROOM_SIZE × ROOM_DEPTH m, floor grid ROOM_GRID_COLS × ROOM_GRID_ROWS × HOUSING_CELL_SIZE
 *             side −X (i < ROOMS_PER_SIDE): x = CORRIDOR.minX − WALL − ROOM_SIZE … CORRIDOR.minX − WALL
 *             side +X (the rest):          x = CORRIDOR.maxX + WALL … + ROOM_SIZE
 *             z  SEGMENT·(i mod ROOMS_PER_SIDE) + ROOM_GAP/2 … + ROOM_DEPTH, door (1.6 m) centred on the corridor wall
 *   airlock   x −1.5 … 1.5, z CORRIDOR.maxZ … + AIRLOCK_DEPTH   (a room of its own since 2026-09-21: an automatic
 *             pressure door at each end — the corridor bulkhead and the ship's rear hatch)
 *
 * **2026-09-12 — a room became 8 × 8 m.** `ROOM_GRID_COLS/ROWS` grew 8 → 16, so `ROOM_SIZE` · `ROOM_DEPTH` are
 * 4 → 8 m. `SEGMENT` used to be **hard-coded as 5**, which made `(SEGMENT − ROOM_DEPTH)/2 = −1.5` and overlapped the
 * rooms by 3 m along z — now `SEGMENT`, `AIRLOCK` and `CORRIDOR.maxZ` are all derived from the room depth. The ship
 * getting longer as a whole (corridor 25 → 45 m) is the intended result. The only free constants are the gap between
 * rooms (`ROOM_GAP`) and the airlock depth (`AIRLOCK_DEPTH`); change the grid size again and this file follows.
 *
 * **2026-09-12 (same day, user's decision) — 8 rooms · the cockpit is a furniture area too.** `SHIP_ROOM_COUNT` went
 * 10 → 8, so there are 4 per side and the corridor is 45 → 36 m (this file followed on its own). The cockpit rides the
 * same grid contract through `COCKPIT_ROOM_BOX` (room index `COCKPIT_ROOM_INDEX`) — `roomBox` · `roomCellToWorld` ·
 * `worldToRoomCell` all take that index. The cockpit's coordinates are now **derived from the grid**
 * (`COCKPIT_GRID_COLS/ROWS × HOUSING_CELL_SIZE` = 10 × 6 m), so the contract's grid and this file's walls cannot go
 * out of step. `ROOM_BOXES` holds **no** cockpit (room signs, room lights and room tracking loop over that list).
 *
 * Grid cells: `x` runs along world +X, `y` along world +Z; cell (0, 0) is the room's min-x / min-z corner.
 * `yaw` = quarter turns clockwise seen from above (world rotation.y = −yaw·π/2).
 * ──────────────────────────────────────────────────────────────────────────── */
export const WALL = 0.3;
export const CEIL = 3.2;
/** Cockpit: derived from the grid (20 × 12 cells × 0.5 m) — the rear wall (z 0) is the corridor opening, x 0 the centre. */
export const COCKPIT = {
  minX: -(COCKPIT_GRID_COLS * HOUSING_CELL_SIZE) / 2,
  maxX: (COCKPIT_GRID_COLS * HOUSING_CELL_SIZE) / 2,
  minZ: -(COCKPIT_GRID_ROWS * HOUSING_CELL_SIZE),
  maxZ: 0,
};
export const ROOM_SIZE = ROOM_GRID_COLS * HOUSING_CELL_SIZE;   // 8 m (was 4)
export const ROOM_DEPTH = ROOM_GRID_ROWS * HOUSING_CELL_SIZE;  // 8 m (was 4)
export const ROOMS_PER_SIDE = SHIP_ROOM_COUNT / 2;
/**
 * Gap along z between two neighbouring rooms on the same side. The corridor's rib / beam / wall-fill band stands in
 * it (`PersonalShip`), so it must stay ≥ the rib footprint (0.28 m). 1 m = the value the 4 m rooms had.
 */
export const ROOM_GAP = 1;
/** One room pitch along the corridor. **Must be ≥ `ROOM_DEPTH`** or the room boxes overlap each other. */
export const SEGMENT = ROOM_DEPTH + ROOM_GAP;
/**
 * 2026-09-21 (user's decision — the airlock is its own room): 2.5 → 3.6 m. The alcove the corridor used to end in
 * became a chamber shut off at **both** ends by an automatic pressure door (`AirlockDoors`), and two 0.3 m
 * bulkheads plus standing room between them do not fit in 2.5 m. 1.1 m on a 45 m corridor; the ship's outline is
 * otherwise untouched (what must not grow is the *raid* ship, which models only this end — see `PersonalShip`).
 */
export const AIRLOCK_DEPTH = 3.6;
export const CORRIDOR = { minX: -1.5, maxX: 1.5, minZ: 0, maxZ: ROOMS_PER_SIDE * SEGMENT };
export const AIRLOCK = { minX: -1.5, maxX: 1.5, minZ: CORRIDOR.maxZ, maxZ: CORRIDOR.maxZ + AIRLOCK_DEPTH };
export const DOOR_WIDTH = 1.6;
export const DOOR_HEIGHT = 2.4;
/**
 * Half-width of an **airlock** door's opening (2026-09-21). Narrower than a room's `DOOR_WIDTH`, and it has to be:
 * each leaf slides one opening-half outward into the bulkhead beside it, so `2 × AIRLOCK_DOOR_HALF` must stay inside
 * the chamber's half width (1.5 m) or an open leaf would stand in the room instead of vanishing into the wall.
 */
export const AIRLOCK_DOOR_HALF = 0.65;
/** Clear height of an airlock opening (a pressure door is shorter than a room door). */
export const AIRLOCK_DOOR_HEIGHT = 2.3;

export interface RoomBox { index: number; side: -1 | 1; minX: number; maxX: number; minZ: number; maxZ: number; doorZ: number }

const _boxes: RoomBox[] = [];
for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
  const side: -1 | 1 = i < ROOMS_PER_SIDE ? -1 : 1;
  const k = i % ROOMS_PER_SIDE;
  const minX = side < 0 ? CORRIDOR.minX - WALL - ROOM_SIZE : CORRIDOR.maxX + WALL;
  const minZ = CORRIDOR.minZ + k * SEGMENT + (SEGMENT - ROOM_DEPTH) / 2;
  _boxes.push({ index: i, side, minX, maxX: minX + ROOM_SIZE, minZ, maxZ: minZ + ROOM_DEPTH, doorZ: minZ + ROOM_DEPTH / 2 });
}
export const ROOM_BOXES: readonly RoomBox[] = _boxes;

/**
 * 2026-09-12: the cockpit as a room box (`COCKPIT_ROOM_INDEX`). `side` is meaningless (left at −1), `doorZ` is the arch (z 0).
 */
export const COCKPIT_ROOM_BOX: RoomBox = {
  index: COCKPIT_ROOM_INDEX, side: -1, minX: COCKPIT.minX, maxX: COCKPIT.maxX, minZ: COCKPIT.minZ, maxZ: COCKPIT.maxZ, doorZ: COCKPIT.maxZ,
};

/** Room box of a room index **or the cockpit** (`COCKPIT_ROOM_INDEX`), null for anything else. */
export function roomBox(room: number): RoomBox | null {
  if (room === COCKPIT_ROOM_INDEX) return COCKPIT_ROOM_BOX;
  return ROOM_BOXES[room] ?? null;
}

/** Room index whose floor rectangle contains (x, z), or null (corridor / cockpit / airlock / outside). */
export function roomAtWorld(x: number, z: number): number | null {
  for (const r of ROOM_BOXES) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r.index;
  }
  return null;
}

/**
 * 2026-09-12: index of the furniture area (a room **or the cockpit**) that contains (x, z). `roomAtWorld` is left
 * unaware of the cockpit because of the contract (`hub:roomEntered`'s `null` = corridor · cockpit).
 */
export function editAreaAtWorld(x: number, z: number): number | null {
  const room = roomAtWorld(x, z);
  if (room !== null) return room;
  const c = COCKPIT_ROOM_BOX;
  return x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ ? c.index : null;
}

/**
 * World centre of a footprint whose top-left cell is (x, y) and which spans `cols × rows` cells (after rotation).
 * With cols = rows = 1 this is the centre of one cell.
 */
export function roomCellToWorld(room: number, x: number, y: number, out: THREE.Vector3, cols = 1, rows = 1): THREE.Vector3 {
  const r = roomBox(room);
  if (!r) return out.set(0, 0, 0);
  return out.set(r.minX + (x + cols / 2) * HOUSING_CELL_SIZE, 0, r.minZ + (y + rows / 2) * HOUSING_CELL_SIZE);
}

/** Cell under a world position, clamped into the grid (null when the point is outside the room by > 1 cell). */
export function worldToRoomCell(room: number, wx: number, wz: number): { x: number; y: number } | null {
  const r = roomBox(room);
  if (!r) return null;
  const g = roomGridSize(room);
  const fx = (wx - r.minX) / HOUSING_CELL_SIZE, fz = (wz - r.minZ) / HOUSING_CELL_SIZE;
  if (fx < -1 || fz < -1 || fx > g.cols + 1 || fz > g.rows + 1) return null;
  return {
    x: THREE.MathUtils.clamp(Math.floor(fx), 0, g.cols - 1),
    y: THREE.MathUtils.clamp(Math.floor(fz), 0, g.rows - 1),
  };
}

/** World yaw (rotation.y) of a furniture piece: quarter turns clockwise seen from above. */
export function yawToRotation(yaw: 0 | 1 | 2 | 3): number { return -yaw * Math.PI / 2; }
