import * as THREE from 'three';
import { FACE_SNAPSHOT_FAR, FACE_SNAPSHOT_FOV, FACE_SNAPSHOT_NEAR, FACE_TONE_EXPOSURE } from '@/shared';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, addFaceLights, aimFaceCamera, poseFaceModel, type SoldierPose } from '@/player';

/* ────────────────────────────────────────────────────────────────────────────
 * The 3D preview of the character creation screen (2026-09-09).
 *
 * The same thing as `hub/ui/PlanetHologram` · `player/Portraits`: it holds **its own `WebGLRenderer` + `Scene` +
 * camera + lights** and draws into its own `<canvas>`. `core/Engine` draws the world with `EffectComposer` at the end
 * of the frame and gives no post-render hook, so a widget inside a DOM panel has no way to share the main canvas.
 *
 * The rules are the same too — with no second GL context to be had, `create…` returns **null** and the screen falls
 * back to a text-only substitute. While closed (`setVisible(false)`) `render` returns immediately. `dispose()`
 * releases the model · scene · renderer · canvas, all of them — a leaked renderer is a real bug here.
 *
 * The accent colour is **baked in** the `SoldierModel` constructor (the materials are made then), so changing the
 * colour rebuilds the model, exactly as `Portraits` does when a slot colour changes.
 *
 * **2026-09-11 (C-42) — the old model is released after the next render.** Disposing the old model's materials before
 * building the new one made three.js delete the shader program the moment the material holding it disappeared, and
 * the new model **recompiled the same shader** — the preview stalled once for every colour swatch pressed. The old
 * model is only detached from the scene and parked in `pendingDispose`, then disposed after `renderer.render` (the
 * same pattern as `player/Portraits`).
 *
 * **2026-09-14 — the face snapshot (`snapshotFace`).** The thumbnail on the right of the confirm popup is a **still
 * image** (user's decision — 「카메라 쪽 왼쪽 사선을 바라보는 얼굴, 정지된 채로」). Without making a third GL context it
 * draws one face with this renderer and pulls it out with `toDataURL`, then redraws the turntable view inside the
 * same task to put the canvas back (even without `preserveDrawingBuffer`, a `toDataURL` in the same task reads the
 * buffer just drawn).
 *
 * **2026-09-15 — the framing is one set with the terminal's match tab.** The same face is drawn for the squad
 * portraits of the ship terminal (`player/FaceSnapshot`, `PlayerRef.snapshotFace`), so the yaw · FOV · width · light
 * numbers moved to `shared/faceFraming`, and fixing the pose · aiming the camera · adding the lights moved to
 * `poseFaceModel` · `aimFaceCamera` · `addFaceLights` in `player`. No number is written out again here — the two
 * images would drift apart.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Turntable framing that holds a 1.8 m body a little above chest height (values of the same family as `player/Portraits`). */
const CAM_FOV = 26;
const CAM_DIST = 4.6;
const CAM_HEIGHT = 1.25;
const LOOK_Y = 1.0;
/** Turntable spin speed (rad/s) — one slow revolution. */
const SPIN = 0.42;
/** A small canvas, so the DPR is capped here (the same cap as `Portraits` / `PlanetHologram`). */
const MAX_DPR = 1.5;

class Preview {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  /** 2026-09-14: a camera just for the face snapshot (it never touches the turntable camera's framing). */
  private readonly faceCamera: THREE.PerspectiveCamera;
  private model: SoldierModel | null = null;
  /** C-42: replaced models, already out of the scene — disposed after the next `renderer.render`. */
  private readonly pendingDispose: SoldierModel[] = [];
  private accent = SOLDIER_DEFAULT_ACCENT;
  /** The model faces −Z and the camera sits at +Z — half a turn makes the face look this way (twisted slightly to a 3/4 angle). */
  private yaw = Math.PI - 0.35;
  private time = 0;
  private visible = false;
  private disposed = false;
  private lastW = 0;
  private lastH = 0;
  /** One standing idle pose (no weapon, not walking) — the same pose as `Portraits`. */
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };

  constructor(host: HTMLElement, renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 40);
    this.camera.position.set(0, CAM_HEIGHT, CAM_DIST);
    this.camera.lookAt(0, LOOK_Y, 0);
    this.faceCamera = new THREE.PerspectiveCamera(FACE_SNAPSHOT_FOV, 1, FACE_SNAPSHOT_NEAR, FACE_SNAPSHOT_FAR);

    // Key + rim + hemisphere light: only enough that the silhouette reads and the armour does not die black (the
    // same lights as the face portrait — `shared/faceFraming`).
    addFaceLights(this.scene);

    this.build();
  }

  /** (Re)builds the soldier in the accent colour — the materials are baked in the constructor, so a colour is a rebuild. */
  private build(): void {
    if (this.disposed) return;
    if (this.model) {
      // C-42: detach now, dispose after the new body has been drawn once (its shader programs stay compiled).
      this.model.root.removeFromParent();
      this.pendingDispose.push(this.model);
      this.model = null;
    }
    const model = new SoldierModel(this.accent);
    model.setSilhouette(false);            // there is no world to be occluded by
    model.resetPose();
    model.setVisible(true);
    this.scene.add(model.root);
    this.model = model;
  }

  /** Takes `#rrggbb` (`SoldierModel` takes a numeric hex, so it is converted here). */
  setAccent(hex: string): void {
    const n = /^#[0-9a-fA-F]{6}$/.test(hex) ? Number.parseInt(hex.slice(1), 16) : SOLDIER_DEFAULT_ACCENT;
    if (n === this.accent && this.model) return;
    this.accent = n;
    this.build();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? '' : 'hidden';
  }

  /** Fits the canvas size to its host (only when it changed). */
  private fit(): void {
    const host = this.canvas.parentElement;
    const w = Math.max(1, Math.round(host?.clientWidth || this.canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(host?.clientHeight || this.canvas.clientHeight || 1));
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** One frame. While closed it returns immediately — a closed creation screen costs nothing. */
  render(dt: number): void {
    if (!this.visible || this.disposed || !this.model) return;
    this.fit();
    this.time += dt;
    this.yaw += dt * SPIN;
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.update(dt, this.time, this.pose);   // breathing / a fine sway
    this.renderer.render(this.scene, this.camera);
    this.flushPendingDispose();
  }

  /**
   * 2026-09-14: **one face** of the soldier in the current accent colour — a 3/4 portrait looking down the left
   * diagonal toward the camera, returned as a PNG data URL. The image keeps the canvas ratio and the caller crops a
   * square with `object-fit: cover`, so the distance is set for the **short side** to hold `FACE_SNAPSHOT_SPAN`
   * (`shared/faceFraming.faceCameraDistance`). Once drawn, the turntable view is redrawn straight away to put the
   * preview canvas back. With no model (disposed · build failed) or an unreadable canvas, null.
   */
  snapshotFace(): string | null {
    const model = this.model;
    if (this.disposed || !model) return null;
    this.fit();
    // 2026-09-15: the pose · camera are the same functions as the terminal match tab's portrait (`player/FaceSnapshot`)
    poseFaceModel(model, this.pose);
    aimFaceCamera(model, this.faceCamera, this.lastW / Math.max(1, this.lastH));

    let url: string | null = null;
    try {
      this.renderer.render(this.scene, this.faceCamera);
      url = this.canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[SoldierPreview] face snapshot failed', e);
      url = null;
    }
    // Put the turntable back (the same task — the face frame never reaches the screen once)
    model.root.rotation.set(0, this.yaw, 0);
    this.renderer.render(this.scene, this.camera);
    this.flushPendingDispose();
    return url && url.startsWith('data:image/') ? url : null;
  }

  /** C-42: the new body is drawn (programs held) — the replaced ones can be freed now. */
  private flushPendingDispose(): void {
    for (const m of this.pendingDispose) m.dispose();
    this.pendingDispose.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushPendingDispose();
    if (this.model) { this.model.dispose(); this.model = null; }
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

export type SoldierPreview = Preview;

/**
 * Makes the soldier preview canvas inside `host`. With no second WebGL context to be had, **null** — the caller has
 * to fall back to the text substitute.
 */
export function createSoldierPreview(host: HTMLElement): SoldierPreview | null {
  let canvas: HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    canvas = document.createElement('canvas');
    canvas.className = 'cc-canvas';
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = FACE_TONE_EXPOSURE;
  } catch (e) {
    console.warn('[SoldierPreview] no second WebGL context', e);
    return null;
  }
  try {
    return new Preview(host, renderer, canvas);
  } catch (e) {
    console.warn('[SoldierPreview] build failed', e);
    try { renderer.dispose(); } catch { /* ignore */ }
    canvas.remove();
    return null;
  }
}
