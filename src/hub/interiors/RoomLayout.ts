import * as THREE from 'three';
import { HOUSING_CELL_SIZE, ROOM_GRID_COLS, ROOM_GRID_ROWS, SHIP_ROOM_COUNT } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Personal-ship layout (metres, world space; the ship is built at the origin, player forward = −Z at spawn).
 *
 *   cockpit   x −5 … 5,   z −6 … 0          (10 × 6 m, viewport on the −Z wall)
 *   corridor  x −1.5 … 1.5, z 0 … 25        (3 m wide, 5 segments × 5 m)
 *   room i    4 × 4 m, floor grid 8 × 8 × 0.5 m
 *             side −X (i = 0..4): x −5.8 … −1.8,  side +X (i = 5..9): x 1.8 … 5.8
 *             z  5·(i mod 5) + 0.5 … + 4.5, door (1.6 m) centred at z 5·(i mod 5) + 2.5 on the corridor wall
 *   airlock   x −1.5 … 1.5, z 25 … 27.5     (decorative shared-ship entrance)
 *
 * Grid cells: `x` runs along world +X, `y` along world +Z; cell (0, 0) is the room's min-x / min-z corner.
 * `yaw` = quarter turns clockwise seen from above (world rotation.y = −yaw·π/2).
 * ──────────────────────────────────────────────────────────────────────────── */
export const WALL = 0.3;
export const CEIL = 3.2;
export const COCKPIT = { minX: -5, maxX: 5, minZ: -6, maxZ: 0 };
export const CORRIDOR = { minX: -1.5, maxX: 1.5, minZ: 0, maxZ: 25 };
export const AIRLOCK = { minX: -1.5, maxX: 1.5, minZ: 25, maxZ: 27.5 };
export const ROOM_SIZE = ROOM_GRID_COLS * HOUSING_CELL_SIZE;   // 4 m
export const ROOM_DEPTH = ROOM_GRID_ROWS * HOUSING_CELL_SIZE;  // 4 m
export const SEGMENT = 5;
export const DOOR_WIDTH = 1.6;
export const DOOR_HEIGHT = 2.4;
export const ROOMS_PER_SIDE = SHIP_ROOM_COUNT / 2;

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

export function roomBox(room: number): RoomBox | null { return ROOM_BOXES[room] ?? null; }

/** Room index whose floor rectangle contains (x, z), or null (corridor / cockpit / airlock / outside). */
export function roomAtWorld(x: number, z: number): number | null {
  for (const r of ROOM_BOXES) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return r.index;
  }
  return null;
}

/**
 * World centre of a footprint whose top-left cell is (x, y) and which spans `cols × rows` cells (after rotation).
 * With cols = rows = 1 this is the centre of one cell.
 */
export function roomCellToWorld(room: number, x: number, y: number, out: THREE.Vector3, cols = 1, rows = 1): THREE.Vector3 {
  const r = ROOM_BOXES[room];
  if (!r) return out.set(0, 0, 0);
  return out.set(r.minX + (x + cols / 2) * HOUSING_CELL_SIZE, 0, r.minZ + (y + rows / 2) * HOUSING_CELL_SIZE);
}

/** Cell under a world position, clamped into the grid (null when the point is outside the room by > 1 cell). */
export function worldToRoomCell(room: number, wx: number, wz: number): { x: number; y: number } | null {
  const r = ROOM_BOXES[room];
  if (!r) return null;
  const fx = (wx - r.minX) / HOUSING_CELL_SIZE, fz = (wz - r.minZ) / HOUSING_CELL_SIZE;
  if (fx < -1 || fz < -1 || fx > ROOM_GRID_COLS + 1 || fz > ROOM_GRID_ROWS + 1) return null;
  return {
    x: THREE.MathUtils.clamp(Math.floor(fx), 0, ROOM_GRID_COLS - 1),
    y: THREE.MathUtils.clamp(Math.floor(fz), 0, ROOM_GRID_ROWS - 1),
  };
}

/** World yaw (rotation.y) of a furniture piece: quarter turns clockwise seen from above. */
export function yawToRotation(yaw: 0 | 1 | 2 | 3): number { return -yaw * Math.PI / 2; }
