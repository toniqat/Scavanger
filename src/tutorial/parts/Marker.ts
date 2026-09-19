import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameContext } from '@/shared';
import {
  MARKER_BASE_Y, MARKER_BOB, MARKER_BOB_PERIOD, MARKER_CHEVRON_ANGLE, MARKER_CHEVRON_LEN, MARKER_CHEVRON_W,
  MARKER_COLOR, MARKER_TOP_Y, MARKER_WIDTH,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Marker.ts — **the target marker** (2026-09-14 3rd pass, user's decision).
 *
 * One quest mark: **a vertical line + a chevron pointing down**, highlight orange (`MARKER_COLOR` = the same value
 * as the UI accent) and bobbing up and down **slowly**. It stands over the target corpse of the `corpseLoot` step.
 *
 * Three things are contract.
 *   ① **The spot is not written into the code** — `TutorialSystem` passes the spot of the corpse it found in
 *      `ctx.interactables` (so it follows `world/tutorial` moving the coordinates).
 *   ② **It creates no light** — `CLAUDE.md`'s 「Never change the point-light count at runtime」. `MeshBasicMaterial`
 *      neither takes nor gives light, and with one material only, shader variants do not grow either.
 *   ③ **No external assets** — all of it is one procedural geometry merged from `BoxGeometry` (1 draw call).
 *
 * The chevron is a flat shape, so it disappears seen from the side. Only the group's **yaw turns to the camera**
 * (a billboard) — the vertical line is axially symmetric, so turning does not show, and the chevron reads as 「∨」
 * from anywhere. `depthTest: false` for the same reason as the floor guide (`parts/Guide`): it is a thing that says
 * 「it is over there」, not a line-of-sight test.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One bar on the local XY plane (length `len`, thickness `w`) — extends from the origin in the `angle` direction. */
function bar(len: number, w: number, angle: number, x: number, y: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, w, w);
  g.translate(len / 2, 0, 0);
  g.rotateZ(angle);
  g.translate(x, y, 0);
  return g;
}

/** The vertical line + chevron merged into one geometry (origin = the target's feet). */
function markerGeometry(): THREE.BufferGeometry | null {
  const a = MARKER_CHEVRON_ANGLE;
  const tip = MARKER_BASE_Y;
  const stemY0 = tip + MARKER_CHEVRON_LEN * Math.cos(a) + 0.14;
  const parts: THREE.BufferGeometry[] = [
    // the vertical line — a bar extending upwards (angle π/2)
    bar(Math.max(0.2, MARKER_TOP_Y - stemY0), MARKER_WIDTH, Math.PI / 2, 0, stemY0),
    // the chevron's two wings — spreading upwards from tip (「∨」)
    bar(MARKER_CHEVRON_LEN, MARKER_CHEVRON_W, Math.PI / 2 + a, 0, tip),
    bar(MARKER_CHEVRON_LEN, MARKER_CHEVRON_W, Math.PI / 2 - a, 0, tip),
  ];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export class ObjectiveMarker {
  private readonly group = new THREE.Group();
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly base = new THREE.Vector3();
  private mounted = false;
  private time = 0;
  private has = false;

  constructor(private readonly ctx: GameContext) {
    this.group.name = 'TutorialObjectiveMarker';
    this.group.renderOrder = 4;
    const geo = markerGeometry();
    const mat = new THREE.MeshBasicMaterial({
      color: MARKER_COLOR, transparent: true, opacity: 0.92,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.disposables.push(mat);
    if (geo) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(geo);
    }
  }

  /**
   * The target spot (null = the marker off). The feet coordinates are passed as they are — the height is this
   * file's.
   */
  setTarget(position: THREE.Vector3 | null): void {
    if (!position) { this.has = false; this.unmount(); return; }
    this.has = true;
    this.base.copy(position);
  }

  update(dt: number): void {
    if (!this.has) return;
    this.time += dt;
    this.mount();
    const bob = Math.sin((this.time / MARKER_BOB_PERIOD) * Math.PI * 2) * MARKER_BOB;
    this.group.position.set(this.base.x, this.base.y + bob, this.base.z);
    // the chevron is flat, so only yaw turns to the camera (the vertical line is axially symmetric, so no effect)
    const cam = this.ctx.camera.position;
    this.group.rotation.y = Math.atan2(cam.x - this.base.x, cam.z - this.base.z);
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.ctx.scene.add(this.group);
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.ctx.scene.remove(this.group);
  }

  /** Smoke / debug. */
  get visible(): boolean { return this.mounted; }

  dispose(): void {
    this.unmount();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
