import * as THREE from 'three';
import {
  FACE_LIGHT_HEMI, FACE_LIGHT_KEY, FACE_LIGHT_RIM, FACE_SNAPSHOT_CACHE_MAX, FACE_SNAPSHOT_CAM_UP, FACE_SNAPSHOT_FAR,
  FACE_SNAPSHOT_FOV, FACE_SNAPSHOT_IDLE_DISPOSE_MS, FACE_SNAPSHOT_LOOK_UP, FACE_SNAPSHOT_NEAR, FACE_SNAPSHOT_SETTLE_DT,
  FACE_SNAPSHOT_SETTLE_STEPS, FACE_SNAPSHOT_SIZE, FACE_SNAPSHOT_SIZE_MAX, FACE_SNAPSHOT_SIZE_MIN, FACE_SNAPSHOT_TIME,
  FACE_SNAPSHOT_YAW, FACE_TONE_EXPOSURE, faceCameraDistance, sanitizeAccent,
} from '@/shared';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from './SoldierModel';

/* ────────────────────────────────────────────────────────────────────────────
 * The face portrait snapshot (2026-09-15, the terminal's `매칭` tab — `PlayerRef.snapshotFace`).
 *
 * The four square portrait cells of the `매칭` tab are **still images**. A WebGL canvas per cell would make four
 * contexts (the browser cap is 16, and the hologram · the launch-slot portraits already take one each), so **one**
 * offscreen renderer draws them one at a time, pulls each out with `toDataURL` and caches them per colour · size.
 * Even without `preserveDrawingBuffer`, a `toDataURL` inside the same task reads the buffer just drawn (the same
 * property `ui/menus/SoldierPreview.snapshotFace` leans on).
 *
 * **The framing is exactly the character-creation confirm popup's** — the numbers live in `shared/faceFraming` and
 * the procedure is this file's one `poseFaceModel` · `aimFaceCamera` · `addFaceLights`, which `SoldierPreview`
 * calls too. Neither side is fixed on its own.
 *
 * Renderer lifetime: built on the first call, and when nobody calls for `FACE_SNAPSHOT_IDLE_DISPOSE_MS` the model ·
 * scene · renderer are all released (`forceContextLoss`). The cache (data URL strings) stays — there is nothing to
 * draw again. Once a second GL context cannot be obtained, this page never tries again and is always null (the
 * caller then degrades to a name-only cell).
 *
 * The C-42 contract (`Portraits` · `SoldierPreview`): the model just used is only detached from the scene and
 * disposed **after the next render** — disposing first drops the program the moment no material holds that shader
 * program any more, and the next colour compiles it again.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The standing idle pose (no weapon, not walking) — the same pose as `Portraits` · `SoldierPreview`. */
const IDLE_POSE: SoldierPose = {
  moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
  verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
  prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
  meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
};

const _head = new THREE.Vector3();

/** Adds the face portrait lights (key + rim + hemisphere) to `scene`. */
export function addFaceLights(scene: THREE.Scene): void {
  const key = new THREE.DirectionalLight(FACE_LIGHT_KEY.color, FACE_LIGHT_KEY.intensity);
  key.position.set(FACE_LIGHT_KEY.x, FACE_LIGHT_KEY.y, FACE_LIGHT_KEY.z);
  scene.add(key);
  const rim = new THREE.DirectionalLight(FACE_LIGHT_RIM.color, FACE_LIGHT_RIM.intensity);
  rim.position.set(FACE_LIGHT_RIM.x, FACE_LIGHT_RIM.y, FACE_LIGHT_RIM.z);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(FACE_LIGHT_HEMI.sky, FACE_LIGHT_HEMI.ground, FACE_LIGHT_HEMI.intensity));
}

/**
 * Turns the body to the face portrait angle and holds it in the idle pose (breathing phase `FACE_SNAPSHOT_TIME`,
 * a few steps of joint damping). Afterwards the world matrices are updated too, so `aimFaceCamera` reads
 * `headPivot` straight away.
 */
export function poseFaceModel(model: SoldierModel, pose: SoldierPose = IDLE_POSE): void {
  model.root.rotation.set(0, FACE_SNAPSHOT_YAW, 0);
  for (let i = 0; i < FACE_SNAPSHOT_SETTLE_STEPS; i++) model.update(FACE_SNAPSHOT_SETTLE_DT, FACE_SNAPSHOT_TIME, pose);
  model.root.updateMatrixWorld(true);
}

/** Aims `cam` at `model`'s face. `aspect` = width / height of the canvas being drawn. */
export function aimFaceCamera(model: SoldierModel, cam: THREE.PerspectiveCamera, aspect: number): void {
  model.headPivot.getWorldPosition(_head);
  _head.y += FACE_SNAPSHOT_LOOK_UP;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  cam.fov = FACE_SNAPSHOT_FOV;
  cam.near = FACE_SNAPSHOT_NEAR;
  cam.far = FACE_SNAPSHOT_FAR;
  cam.aspect = a;
  cam.updateProjectionMatrix();
  cam.position.set(_head.x, _head.y + FACE_SNAPSHOT_CAM_UP, _head.z + faceCameraDistance(a));
  cam.lookAt(_head);
}

class FaceSnapshotter {
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  /** C-42: the model just shot — released after the next render. */
  private pendingDispose: SoldierModel[] = [];
  /** A second GL context could not be obtained once — this page never tries again. */
  private failed = false;
  private readonly cache = new Map<string, string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  snapshot(opts: { accent: string; size?: number }, android = false): string | null {
    const accent = sanitizeAccent(opts?.accent) ?? `#${SOLDIER_DEFAULT_ACCENT.toString(16).padStart(6, '0')}`;
    const rawSize = Math.round(Number(opts?.size ?? FACE_SNAPSHOT_SIZE));
    const size = Math.max(FACE_SNAPSHOT_SIZE_MIN, Math.min(FACE_SNAPSHOT_SIZE_MAX, Number.isFinite(rawSize) ? rawSize : FACE_SNAPSHOT_SIZE));
    // 2026-09-15: an android is a different picture even at the same colour — the cache key is split
    const key = `${android ? 'android|' : ''}${accent}|${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    if (!this.ensure()) return null;
    const renderer = this.renderer!, scene = this.scene!, camera = this.camera!, canvas = this.canvas!;

    let url: string | null = null;
    let model: SoldierModel | null = null;
    try {
      renderer.setSize(size, size, false);
      model = new SoldierModel(Number.parseInt(accent.slice(1), 16));
      if (android) model.setAndroidLook(true);
      model.setSilhouette(false);            // there is no world to be occluded by
      model.resetPose();
      model.setVisible(true);
      scene.add(model.root);
      poseFaceModel(model, IDLE_POSE);
      aimFaceCamera(model, camera, 1);
      renderer.render(scene, camera);
      url = canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[FaceSnapshot] snapshot failed', e);
      url = null;
    }
    this.flushPendingDispose();              // this render has taken the program — the last model can go now
    if (model) { model.root.removeFromParent(); this.pendingDispose.push(model); }
    this.scheduleIdle();
    if (!url || !url.startsWith('data:image/')) return null;
    if (this.cache.size >= FACE_SNAPSHOT_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, url);
    return url;
  }

  private ensure(): boolean {
    if (this.renderer) return true;
    if (this.failed || typeof document === 'undefined') return false;
    let canvas: HTMLCanvasElement;
    let renderer: THREE.WebGLRenderer;
    try {
      canvas = document.createElement('canvas');
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = FACE_TONE_EXPOSURE;
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(1);             // the caller gives the size in px
    } catch (e) {
      console.warn('[FaceSnapshot] no second WebGL context', e);
      this.failed = true;
      return false;
    }
    const scene = new THREE.Scene();
    addFaceLights(scene);
    this.canvas = canvas;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(FACE_SNAPSHOT_FOV, 1, FACE_SNAPSHOT_NEAR, FACE_SNAPSHOT_FAR);
    return true;
  }

  private scheduleIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = null; this.release(); }, FACE_SNAPSHOT_IDLE_DISPOSE_MS);
  }

  private flushPendingDispose(): void {
    for (const m of this.pendingDispose) m.dispose();
    this.pendingDispose.length = 0;
  }

  /** Releases the model · scene · renderer (the cache is kept). The next snapshot builds them again. */
  release(): void {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.flushPendingDispose();
    if (!this.renderer) return;
    this.scene?.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.canvas = null;
  }
}

const snapper = new FaceSnapshotter();

/**
 * The implementation of `PlayerRef.snapshotFace`: one face of the `accent` soldier (`#rrggbb`, the default
 * helldiver yellow when it is wrong) as a `size`×`size` PNG data URL. null without a GL context. The same colour ·
 * size comes back from the cache.
 */
export function snapshotFace(opts: { accent: string; size?: number }): string | null {
  return snapper.snapshot(opts);
}

/**
 * The implementation of `PlayerRef.snapshotAndroidFace` (2026-09-15, android squadmates): one face with the
 * **same framing · pose · lighting** as `snapshotFace` and only `SoldierModel.setAndroidLook(true)` turned on. Its
 * cache per colour · size is kept apart from the human faces'.
 */
export function snapshotAndroidFace(opts: { accent: string; size?: number }): string | null {
  return snapper.snapshot(opts, true);
}

/** Releases the offscreen renderer now (the cache stays). Normally the idle timer calls this by itself. */
export function releaseFaceSnapshots(): void {
  snapper.release();
}
