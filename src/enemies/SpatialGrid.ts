import type * as THREE from 'three';

interface GridItem { position: THREE.Vector3 }

/**
 * Uniform 2D (XZ) hash grid rebuilt every frame for cheap neighbor queries.
 * Zero allocations after construction: cells are reused arrays, results are written to caller buffers.
 */
export class SpatialGrid<T extends GridItem> {
  private readonly cells: T[][];
  private readonly used: number[] = [];
  private readonly dim: number;
  private readonly half: number;
  private readonly inv: number;

  constructor(worldSize: number, private readonly cellSize: number) {
    this.dim = Math.ceil(worldSize / cellSize) + 2;
    this.half = worldSize / 2 + cellSize;
    this.inv = 1 / cellSize;
    this.cells = new Array(this.dim * this.dim);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
  }

  clear(): void {
    for (let i = 0; i < this.used.length; i++) this.cells[this.used[i]].length = 0;
    this.used.length = 0;
  }

  private cellIndex(x: number, z: number): number {
    let cx = Math.floor((x + this.half) * this.inv);
    let cz = Math.floor((z + this.half) * this.inv);
    if (cx < 0) cx = 0; else if (cx >= this.dim) cx = this.dim - 1;
    if (cz < 0) cz = 0; else if (cz >= this.dim) cz = this.dim - 1;
    return cz * this.dim + cx;
  }

  insert(item: T): void {
    const idx = this.cellIndex(item.position.x, item.position.z);
    const cell = this.cells[idx];
    if (cell.length === 0) this.used.push(idx);
    cell.push(item);
  }

  /** Writes all items whose cell overlaps the query circle into `out`; returns count. Caller filters by exact distance. */
  query(x: number, z: number, radius: number, out: T[]): number {
    let n = 0;
    const minX = Math.max(0, Math.floor((x - radius + this.half) * this.inv));
    const maxX = Math.min(this.dim - 1, Math.floor((x + radius + this.half) * this.inv));
    const minZ = Math.max(0, Math.floor((z - radius + this.half) * this.inv));
    const maxZ = Math.min(this.dim - 1, Math.floor((z + radius + this.half) * this.inv));
    for (let cz = minZ; cz <= maxZ; cz++) {
      const row = cz * this.dim;
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.cells[row + cx];
        for (let i = 0; i < cell.length; i++) {
          if (n < out.length) out[n] = cell[i]; else out.push(cell[i]);
          n++;
        }
      }
    }
    return n;
  }
}
