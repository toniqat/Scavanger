import * as THREE from 'three';
import { HOUSING_CELL_SIZE, ROOM_GRID_COLS, ROOM_GRID_ROWS, SHIP_ROOM_COUNT } from '@/shared';

/* ────────────────────────────────────────────────────────────────────────────
 * Personal-ship layout (metres, world space; the ship is built at the origin, player forward = −Z at spawn).
 *
 *   cockpit   x −5 … 5,   z −6 … 0          (10 × 6 m, viewport on the −Z wall)
 *   corridor  x −1.5 … 1.5, z 0 … ROOMS_PER_SIDE·SEGMENT   (3 m wide, one SEGMENT per room pair)
 *   room i    ROOM_SIZE × ROOM_DEPTH m, floor grid ROOM_GRID_COLS × ROOM_GRID_ROWS × HOUSING_CELL_SIZE
 *             side −X (i = 0..4): x = CORRIDOR.minX − WALL − ROOM_SIZE … CORRIDOR.minX − WALL
 *             side +X (i = 5..9): x = CORRIDOR.maxX + WALL … + ROOM_SIZE
 *             z  SEGMENT·(i mod 5) + ROOM_GAP/2 … + ROOM_DEPTH, door (1.6 m) centred on the corridor wall
 *   airlock   x −1.5 … 1.5, z CORRIDOR.maxZ … + AIRLOCK_DEPTH   (decorative shared-ship entrance)
 *
 * **2026-09-12 — 방이 8 × 8 m 가 됐다.** `ROOM_GRID_COLS/ROWS` 가 8 → 16 으로 커졌으므로 `ROOM_SIZE` ·
 * `ROOM_DEPTH` 는 4 → 8 m 다. 예전에는 `SEGMENT` 가 **5 로 코드에 박혀** 있어 `(SEGMENT − ROOM_DEPTH)/2 = −1.5`
 * 가 되고 방들이 z 축으로 3 m 씩 겹쳤다 — 이제 `SEGMENT` 도 `AIRLOCK` 도 `CORRIDOR.maxZ` 도 전부 방 깊이에서
 * 유도한다. 함선이 통째로 길어지는 것(복도 25 → 45 m)은 의도한 결과다. 자유 상수는 방 사이 틈(`ROOM_GAP`)과
 * 에어락 깊이(`AIRLOCK_DEPTH`) 둘뿐이고, 격자 크기를 또 바꿔도 이 파일은 따라온다.
 *
 * Grid cells: `x` runs along world +X, `y` along world +Z; cell (0, 0) is the room's min-x / min-z corner.
 * `yaw` = quarter turns clockwise seen from above (world rotation.y = −yaw·π/2).
 * ──────────────────────────────────────────────────────────────────────────── */
export const WALL = 0.3;
export const CEIL = 3.2;
export const COCKPIT = { minX: -5, maxX: 5, minZ: -6, maxZ: 0 };
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
export const AIRLOCK_DEPTH = 2.5;
export const CORRIDOR = { minX: -1.5, maxX: 1.5, minZ: 0, maxZ: ROOMS_PER_SIDE * SEGMENT };
export const AIRLOCK = { minX: -1.5, maxX: 1.5, minZ: CORRIDOR.maxZ, maxZ: CORRIDOR.maxZ + AIRLOCK_DEPTH };
export const DOOR_WIDTH = 1.6;
export const DOOR_HEIGHT = 2.4;

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
