/**
 * src/shared/viewZoom.ts — **how far the camera is zoomed in, as a screen-size factor** (2026-09-20).
 *
 * A number decided as 「how big is this on screen」 is only true at `CAMERA_BASE_FOV_DEG`. Scoping does not touch
 * `camera.zoom`: it narrows `camera.fov` to `base / adsZoom` (`player/CameraRig`, `data/attachments.csv`
 * `att_scope4` · `att_scope6` · `att_scope8`), so through an 8× scope a body at 100 m is drawn the size it has at
 * ~12 m. Two folders need the same correction, which is why it lives here (`CLAUDE.md` §4.1):
 * `enemies/EnemySystem.poseSkip` (the animation LOD is in metres) and `enemies/models/named/SniperLook` (the scope
 * glint sprite is sized as a fraction of the screen height).
 *
 * `viewZoomK` is **1 at the base FOV and smaller the further in the camera is zoomed** — multiply a screen-size
 * judgement by it, or a distance threshold² by its square. It is a pure number in, number out: the caller reads
 * `fov` / `zoom` off its own camera (and checks `isPerspectiveCamera` if it may hold something else).
 */
import { CAMERA_BASE_FOV_DEG } from './constants';

/** `tan` of the base half-FOV — the denominator of every correction here. */
export const TAN_BASE_HALF_FOV = Math.tan((CAMERA_BASE_FOV_DEG * Math.PI) / 360);

/**
 * `tan(fov/2) / zoom` over the same at the base FOV. 1 at the base FOV, 1/8 through an 8× scope, > 1 for a wider
 * view (the sprint kick / slash widen) — clamp at the call site if only zooming in should count.
 */
export function viewZoomK(fovDeg: number, zoom = 1): number {
  return Math.tan((fovDeg * Math.PI) / 360) / Math.max(1e-3, zoom) / TAN_BASE_HALF_FOV;
}
