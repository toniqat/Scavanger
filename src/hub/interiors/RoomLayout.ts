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
 *   airlock   x −1.5 … 1.5, z CORRIDOR.maxZ … + AIRLOCK_DEPTH   (decorative shared-ship entrance)
 *
 * **2026-09-12 — 방이 8 × 8 m 가 됐다.** `ROOM_GRID_COLS/ROWS` 가 8 → 16 으로 커졌으므로 `ROOM_SIZE` ·
 * `ROOM_DEPTH` 는 4 → 8 m 다. 예전에는 `SEGMENT` 가 **5 로 코드에 박혀** 있어 `(SEGMENT − ROOM_DEPTH)/2 = −1.5`
 * 가 되고 방들이 z 축으로 3 m 씩 겹쳤다 — 이제 `SEGMENT` 도 `AIRLOCK` 도 `CORRIDOR.maxZ` 도 전부 방 깊이에서
 * 유도한다. 함선이 통째로 길어지는 것(복도 25 → 45 m)은 의도한 결과다. 자유 상수는 방 사이 틈(`ROOM_GAP`)과
 * 에어락 깊이(`AIRLOCK_DEPTH`) 둘뿐이고, 격자 크기를 또 바꿔도 이 파일은 따라온다.
 *
 * **2026-09-12 (같은 날, 사용자 결정) — 방 8개 · 조종석도 꾸미는 공간이다.** `SHIP_ROOM_COUNT` 가 10 → 8 이라 한 쪽에
 * 4개씩이고 복도는 45 → 36 m 다(이 파일은 저절로 따라왔다). 조종석은 `COCKPIT_ROOM_BOX`(방 번호
 * `COCKPIT_ROOM_INDEX`)로 같은 격자 규약을 탄다 — `roomBox` · `roomCellToWorld` · `worldToRoomCell` 이 그 번호를 받는다.
 * 조종석의 좌표는 이제 **격자에서 유도한다**(`COCKPIT_GRID_COLS/ROWS × HOUSING_CELL_SIZE` = 10 × 6 m): 계약의 격자와
 * 이 파일의 벽이 어긋날 수 없게 한 것이다. `ROOM_BOXES` 에는 조종석이 **없다** (방 표지 · 방 조명 · 방 추적이 그
 * 목록을 돌기 때문이다).
 *
 * Grid cells: `x` runs along world +X, `y` along world +Z; cell (0, 0) is the room's min-x / min-z corner.
 * `yaw` = quarter turns clockwise seen from above (world rotation.y = −yaw·π/2).
 * ──────────────────────────────────────────────────────────────────────────── */
export const WALL = 0.3;
export const CEIL = 3.2;
/** 조종석: 격자(20 × 12 칸 × 0.5 m)에서 유도 — 뒷벽(z 0)이 복도 입구, 가로 중앙이 x 0. */
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

/**
 * 2026-09-12: 조종석을 방처럼 다루는 상자 (`COCKPIT_ROOM_INDEX`). `side` 는 뜻이 없고(−1 로 둔다) `doorZ` 는 복도 아치(z 0)다.
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
 * 2026-09-12: 꾸밀 수 있는 공간(방 **또는 조종석**) 중 (x, z) 를 담은 것의 번호. `roomAtWorld` 는 계약(`hub:roomEntered`
 * 의 `null` = 복도 · 조종석) 때문에 조종석을 모르는 채로 둔다.
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
