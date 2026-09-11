import * as THREE from 'three';
import { HUB_READY_PORTRAIT_YAW, NET_SLOT_COLORS, type GameContext, type PortraitRef } from '@/shared';
import { SoldierModel, SOLDIER_DEFAULT_ACCENT, type SoldierPose } from './SoldierModel';
import { resolveArmorDef } from './RemoteAvatar';

/** Camera framing: a 1.8 m body centred a little above the hips reads best from slightly above eye height. */
const CAM_FOV = 28;
const CAM_DIST = 4.3;
const CAM_HEIGHT = 1.15;
const LOOK_Y = 1.0;
/** Device pixel ratio cap for the portrait canvas (it is small; anti-aliasing does the rest). */
const MAX_DPR = 1.5;

interface Cell {
  model: SoldierModel | null;
  slot: number;
  armorId: string | null;
  yaw: number;
  /** true while a member fills this cell (an empty cell draws nothing at all). */
  filled: boolean;
}

/**
 * `cells` character portraits drawn into ONE canvas through scissored viewports (Phase 10, 발사 준비 패널).
 *
 * It owns its **own** `THREE.WebGLRenderer` + `Scene` + `PerspectiveCamera` + lights because `core/Engine`
 * renders the world through an `EffectComposer` at the end of the frame and offers no post-render hook, so a
 * portrait can never share the main canvas. Each cell builds its **own** `SoldierModel` (rebuilt when the cell's
 * slot colour changes, since the accent is baked into its per-instance materials at construction).
 *
 * **2026-09-11 (C-42) — 정정.** 예전 주석은 "여기 있는 것은 메인 렌더러의 아바타와 아무것도 공유하지 않는다" 였지만
 * 2026-09-10 부터 `SoldierModel` 의 **지오메트리 43개와 실루엣 머티리얼은 모듈 전체가 공유한다** (`SHARED_GEOS` —
 * three.js 가 GPU 버퍼를 렌더러별로 따로 잡으므로 두 번째 GL 컨텍스트에서도 같은 객체를 쓴다; 아무도
 * `geometry.dispose()` 를 부르지 않는 것이 규약이다). 공유하지 않는 것은 인스턴스마다의 **몸 머티리얼**뿐이다.
 * 그 공유 지오메트리마다 이 렌더러의 `WebGLGeometries` 가 `dispose` 리스너를 하나씩 붙이는데, 지오메트리가 영영
 * dispose 되지 않으므로 리스너는 렌더러를 만든 횟수만큼 남는다 — 발사 준비 패널은 페이지당 한 번만 만들므로 최대
 * 43개 한 벌이고, 그래서 고치지 않고 적어만 둔다.
 *
 * **이전 모델은 다음 render 뒤에 dispose 한다 (C-42).** 슬롯 색이 바뀌어 모델을 새로 지을 때 옛 모델의 머티리얼을
 * **먼저** dispose 하면, 같은 셰이더 프로그램(cacheKey)을 쥔 머티리얼이 하나도 남지 않은 순간 `WebGLPrograms` 가
 * 프로그램을 지우고 새 모델이 그것을 **다시 컴파일**했다(색만 바뀌었는데 한 프레임이 멎는다). 이제 옛 모델은
 * 씬에서 떼기만 하고 `pendingDispose` 에 두었다가, 새 모델이 한 번 그려진(= 같은 프로그램을 잡은) 뒤에 놓는다.
 *
 * The occlusion silhouette stays off (there is no world to be occluded by) and `render` returns immediately
 * while `visible` is false.
 */
class Portraits implements PortraitRef {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly cells: Cell[] = [];
  /** C-42: replaced models, already out of the scene — disposed after the next `render` (see the class comment). */
  private readonly pendingDispose: SoldierModel[] = [];
  private readonly ctx: GameContext;
  private visible = true;
  private lastW = 0;
  private lastH = 0;
  private disposed = false;
  private readonly pose: SoldierPose = {
    moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
    verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
    prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
    meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
  };

  constructor(ctx: GameContext, host: HTMLElement, cellCount: number, renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.renderer = renderer;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    this.renderer.autoClear = false;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 40);
    this.camera.position.set(0, CAM_HEIGHT, CAM_DIST);
    this.camera.lookAt(0, LOOK_Y, 0);

    // key + fill + ambient sky/ground: the same read as the world's sun + hemisphere, without touching it
    const key = new THREE.DirectionalLight(0xfff3dd, 2.1);
    key.position.set(2.2, 3.4, 3.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    rim.position.set(-2.8, 1.8, -2.4);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2b2f38, 0.9));

    for (let i = 0; i < cellCount; i++) {
      this.cells.push({ model: null, slot: -1, armorId: null, yaw: HUB_READY_PORTRAIT_YAW, filled: false });
    }
  }

  /** Cell `index` shows a body with this slot colour / armor; `null` = empty cell (member not ready). */
  setMember(index: number, member: { slot: number; armorId: string | null } | null): void {
    const cell = this.cells[index];
    if (!cell || this.disposed) return;
    if (!member) {
      cell.filled = false;
      if (cell.model) cell.model.setVisible(false);
      return;
    }
    cell.filled = true;
    if (!cell.model || cell.slot !== member.slot) {
      if (cell.model) {
        // C-42: detach now, free after the new body has been drawn once (keeps its shader programs alive).
        cell.model.root.removeFromParent();
        this.pendingDispose.push(cell.model);
        cell.model = null;
      }
      const accent = NET_SLOT_COLORS[member.slot] ?? SOLDIER_DEFAULT_ACCENT;
      const model = new SoldierModel(accent);
      model.setSilhouette(false);
      model.resetPose();
      this.scene.add(model.root);
      cell.model = model;
      cell.slot = member.slot;
      cell.armorId = null;      // force the armor rebuild below
    }
    cell.model.setVisible(false); // only the cell being drawn is visible (see `render`)
    cell.model.root.rotation.set(0, cell.yaw, 0);
    if (member.armorId !== cell.armorId) {
      cell.armorId = member.armorId;
      cell.model.setArmor(member.armorId ? resolveArmorDef(this.ctx, member.armorId) : null);
    }
  }

  /** Body yaw in radians for one cell (3/4 view = `HUB_READY_PORTRAIT_YAW`; the model's front is −Z). */
  setYaw(index: number, yaw: number): void {
    const cell = this.cells[index];
    if (!cell) return;
    cell.yaw = yaw;
    if (cell.model) cell.model.root.rotation.set(0, yaw, 0);
  }

  /** Draw one frame: the whole canvas is cleared once, then every filled cell in its own scissored viewport. */
  render(dt: number, time: number): void {
    if (!this.visible || this.disposed) return;
    const host = this.canvas.parentElement;
    const w = Math.max(1, Math.round(host?.clientWidth || this.canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(host?.clientHeight || this.canvas.clientHeight || 1));
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
    }
    const n = this.cells.length;
    const cw = w / n;
    this.camera.aspect = Math.max(0.05, cw / h);
    this.camera.updateProjectionMatrix();

    // breathing / idle sway (no stride, no weapon) — cheap, and it keeps the portraits from looking like statues
    for (const cell of this.cells) if (cell.filled && cell.model) cell.model.update(dt, time, this.pose);

    this.renderer.setScissorTest(false);
    this.renderer.clear(true, true, false);
    for (let i = 0; i < n; i++) {
      const cell = this.cells[i];
      if (!cell.filled || !cell.model) continue;
      const x = Math.round(i * cw);
      const cwi = Math.round((i + 1) * cw) - x;
      this.renderer.setViewport(x, 0, cwi, h);
      this.renderer.setScissor(x, 0, cwi, h);
      this.renderer.setScissorTest(true);
      cell.model.setVisible(true);
      this.renderer.render(this.scene, this.camera);
      cell.model.setVisible(false);
    }
    this.renderer.setScissorTest(false);
    this.flushPendingDispose();
  }

  /** C-42: the replacement bodies have been rendered (their programs are held) — the old ones can go now. */
  private flushPendingDispose(): void {
    for (const m of this.pendingDispose) m.dispose();
    this.pendingDispose.length = 0;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.canvas.style.visibility = visible ? '' : 'hidden';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flushPendingDispose();
    for (const cell of this.cells) {
      if (cell.model) { cell.model.dispose(); cell.model = null; }
    }
    this.cells.length = 0;
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

/**
 * Build `cells` character portraits into `host` (one canvas, `cells` scissored viewports). Returns null when a
 * second WebGL context is unavailable — the caller must then degrade to a name-only cell.
 */
export function createPortraits(ctx: GameContext, host: HTMLElement, cells: number): PortraitRef | null {
  const count = Math.max(1, Math.min(8, Math.round(cells) || 1));
  let canvas: HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    canvas = document.createElement('canvas');
    canvas.className = 'portrait-canvas';
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  } catch (e) {
    console.warn('[Portraits] no second WebGL context', e);
    return null;
  }
  try {
    return new Portraits(ctx, host, count, renderer, canvas);
  } catch (e) {
    console.warn('[Portraits] build failed', e);
    try { renderer.dispose(); } catch { /* ignore */ }
    canvas.remove();
    return null;
  }
}
