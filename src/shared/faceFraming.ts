/* ────────────────────────────────────────────────────────────────────────────
 * Face portrait framing (2026-09-15, the terminal's matching tab — docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」).
 *
 * The same face is drawn in two places — the still image in the character-creation confirm popup
 * (`ui/menus/SoldierPreview.snapshotFace`) and the square portrait on the ship terminal's matching tab
 * (`player/FaceSnapshot`, `PlayerRef.snapshotFace`). If the two held the numbers separately, fixing one would leave the
 * same character with a different face on the two screens (「the same thing in two folders moves to shared」).
 * This is presentation geometry and lighting, not balance numbers, so it lives here and not in csv. It has no runtime import (not even three).
 *
 * The **procedure** that poses the model and aims the camera is one thing, `poseFaceModel` · `aimFaceCamera` in
 * `player/FaceSnapshot`, and both renderers call it — only the values that procedure reads live here.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The body's yaw. The model faces −Z, and turned by yaw its front becomes `(−sin yaw, 0, −cos yaw)` — at π it looks
 * straight at the camera (+Z), and the **less** it is turned from π the further the head goes to screen left (−X).
 * 0.7 rad ≈ 40° = a left three-quarter angle toward the camera.
 */
export const FACE_SNAPSHOT_YAW = Math.PI - 0.7;
/** Vertical FOV of the face camera (degrees). */
export const FACE_SNAPSHOT_FOV = 24;
/** The width the image's **short edge** holds (m) — helmet + neck + the top line of the shoulders. */
export const FACE_SNAPSHOT_SPAN = 0.62;
/** The look-at point — from `SoldierModel.headPivot` (the base of the neck) to the middle of the helmet (m). */
export const FACE_SNAPSHOT_LOOK_UP = 0.15;
/** The camera is raised this far above eye height (m) — a portrait looking slightly down. */
export const FACE_SNAPSHOT_CAM_UP = 0.04;
/** Camera near / far (m). */
export const FACE_SNAPSHOT_NEAR = 0.05;
export const FACE_SNAPSHOT_FAR = 20;
/**
 * Pinning the pose: the breathing phase (the time in `SoldierModel.update`) is pinned to this value and the model is
 * stepped enough times for the joint damping to reach its targets. `update(dt <= 0)` returns **without touching** the
 * standing pose, so shooting a freshly built model (`resetPose` = joints at 0) without stepping it once captures the
 * skeleton's default angles rather than an at-attention stance.
 */
export const FACE_SNAPSHOT_TIME = 0;
export const FACE_SNAPSHOT_SETTLE_STEPS = 12;
export const FACE_SNAPSHOT_SETTLE_DT = 0.1;

/** Lighting — key + rim + hemisphere (the turntable in the character-creation preview uses the same lighting). */
export const FACE_LIGHT_KEY = { color: 0xfff3dd, intensity: 2.3, x: 2.6, y: 3.4, z: 3.4 } as const;
export const FACE_LIGHT_RIM = { color: 0x9fc4ff, intensity: 1.35, x: -3.0, y: 2.0, z: -2.6 } as const;
export const FACE_LIGHT_HEMI = { sky: 0xbcd4ff, ground: 0x2b2f38, intensity: 0.95 } as const;
/** Tone-mapping exposure (ACES Filmic). */
export const FACE_TONE_EXPOSURE = 1.0;

/** The default edge length of `PlayerRef.snapshotFace` (px) and its allowed range. */
export const FACE_SNAPSHOT_SIZE = 256;
export const FACE_SNAPSHOT_SIZE_MIN = 48;
export const FACE_SNAPSHOT_SIZE_MAX = 512;
/** Cap of the data URL cache, keyed by colour and size (past it the oldest go first). */
export const FACE_SNAPSHOT_CACHE_MAX = 16;
/** When nobody calls for this long after the last snapshot, the offscreen renderer (a GL context) is released (ms). */
export const FACE_SNAPSHOT_IDLE_DISPOSE_MS = 4000;

/**
 * The camera distance at which the short edge holds `FACE_SNAPSHOT_SPAN`. `aspect` = width / height — when the width is
 * the shorter one (a canvas taller than it is wide) it is measured down by the horizontal field of view. This is the
 * formula that makes the side cropping the image square (`object-fit: cover`) see the same face.
 */
export function faceCameraDistance(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanHalf = Math.tan(((FACE_SNAPSHOT_FOV * Math.PI) / 180) / 2) * Math.min(1, a);
  return (FACE_SNAPSHOT_SPAN / 2) / Math.max(1e-3, tanHalf);
}
