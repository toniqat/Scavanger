import * as THREE from 'three';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from '@/player';

/* ────────────────────────────────────────────────────────────────────────────
 * 캐릭터 생성창의 3D 미리보기 (2026-09-09).
 *
 * `hub/ui/PlanetHologram` · `player/Portraits` 와 같은 물건이다: **자기 `WebGLRenderer` + `Scene` + 카메라 +
 * 조명**을 들고 자기 `<canvas>` 에 그린다. `core/Engine` 은 프레임 끝에 `EffectComposer` 로 월드를 그리고
 * 렌더 후 훅을 주지 않으므로, DOM 패널 안의 위젯이 메인 캔버스를 나눠 쓸 길이 없다.
 *
 * 규칙도 같다 — 두 번째 GL 컨텍스트를 못 얻으면 `create…` 가 **null** 을 돌려주고 화면은 글자만 남는 대체
 * 표시로 내려간다. 닫혀 있는 동안(`setVisible(false)`)에는 `render` 가 즉시 돌아온다. `dispose()` 는
 * 모델 · 씬 · 렌더러 · 캔버스를 전부 놓는다 — 새는 렌더러는 여기서 진짜 버그다.
 *
 * 악센트 색은 `SoldierModel` 생성자에서 **구워지므로**(재질이 그때 만들어진다), 색을 바꾸면 `Portraits` 가
 * 슬롯 색이 바뀔 때 하는 것과 똑같이 모델을 새로 짓는다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 1.8 m 몸을 가슴 높이에서 살짝 위로 잡는 프레이밍 (`player/Portraits` 와 같은 계열의 값). */
const CAM_FOV = 26;
const CAM_DIST = 4.6;
const CAM_HEIGHT = 1.25;
const LOOK_Y = 1.0;
/** 턴테이블 회전 속도 (rad/s) — 천천히 한 바퀴. */
const SPIN = 0.42;
/** 작은 캔버스라 DPR 은 여기서 끊는다 (`Portraits` / `PlanetHologram` 과 같은 상한). */
const MAX_DPR = 1.5;

class Preview {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private model: SoldierModel | null = null;
  private accent = SOLDIER_DEFAULT_ACCENT;
  /** 모델의 정면은 −Z 이고 카메라는 +Z 에 있다 — 반 바퀴 돌려야 얼굴이 이쪽을 본다 (3/4 각도로 살짝 비튼다). */
  private yaw = Math.PI - 0.35;
  private time = 0;
  private visible = false;
  private disposed = false;
  private lastW = 0;
  private lastH = 0;
  /** 서 있는 대기 자세 하나 (무기 없음, 걷지 않음) — `Portraits` 의 포즈와 같다. */
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

    // 키 + 림 + 반구광: 실루엣이 읽히고 갑주가 검게 죽지 않을 만큼만.
    const key = new THREE.DirectionalLight(0xfff3dd, 2.3);
    key.position.set(2.6, 3.4, 3.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.35);
    rim.position.set(-3.0, 2.0, -2.6);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x2b2f38, 0.95));

    this.build();
  }

  /** 악센트 색으로 병사를 (다시) 짓는다 — 재질은 생성자에서 구워지므로 색은 재건축이다. */
  private build(): void {
    if (this.disposed) return;
    if (this.model) { this.model.dispose(); this.model = null; }
    const model = new SoldierModel(this.accent);
    model.setSilhouette(false);            // 가려질 월드가 없다
    model.resetPose();
    model.setVisible(true);
    this.scene.add(model.root);
    this.model = model;
  }

  /** `#rrggbb` 를 받는다 (`SoldierModel` 은 숫자 hex 를 받으므로 여기서 변환한다). */
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

  /** 한 프레임. 닫혀 있으면 즉시 돌아온다 — 닫힌 생성창은 아무 비용도 쓰지 않는다. */
  render(dt: number): void {
    if (!this.visible || this.disposed || !this.model) return;
    const host = this.canvas.parentElement;
    const w = Math.max(1, Math.round(host?.clientWidth || this.canvas.clientWidth || 1));
    const h = Math.max(1, Math.round(host?.clientHeight || this.canvas.clientHeight || 1));
    if (w !== this.lastW || h !== this.lastH) {
      this.lastW = w; this.lastH = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.time += dt;
    this.yaw += dt * SPIN;
    this.model.root.rotation.set(0, this.yaw, 0);
    this.model.update(dt, this.time, this.pose);   // 숨쉬기 / 미세한 흔들림
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.model) { this.model.dispose(); this.model = null; }
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

export type SoldierPreview = Preview;

/**
 * `host` 안에 병사 미리보기 캔버스를 만든다. 두 번째 WebGL 컨텍스트를 얻지 못하면 **null** —
 * 부르는 쪽이 글자 대체 표시로 내려가야 한다.
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
    renderer.toneMappingExposure = 1.0;
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
