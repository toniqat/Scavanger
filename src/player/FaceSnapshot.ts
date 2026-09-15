import * as THREE from 'three';
import {
  FACE_LIGHT_HEMI, FACE_LIGHT_KEY, FACE_LIGHT_RIM, FACE_SNAPSHOT_CACHE_MAX, FACE_SNAPSHOT_CAM_UP, FACE_SNAPSHOT_FAR,
  FACE_SNAPSHOT_FOV, FACE_SNAPSHOT_IDLE_DISPOSE_MS, FACE_SNAPSHOT_LOOK_UP, FACE_SNAPSHOT_NEAR, FACE_SNAPSHOT_SETTLE_DT,
  FACE_SNAPSHOT_SETTLE_STEPS, FACE_SNAPSHOT_SIZE, FACE_SNAPSHOT_SIZE_MAX, FACE_SNAPSHOT_SIZE_MIN, FACE_SNAPSHOT_TIME,
  FACE_SNAPSHOT_YAW, FACE_TONE_EXPOSURE, faceCameraDistance, sanitizeAccent,
} from '@/shared';
import { SOLDIER_DEFAULT_ACCENT, SoldierModel, type SoldierPose } from './SoldierModel';

/* ────────────────────────────────────────────────────────────────────────────
 * 얼굴 초상 스냅숏 (2026-09-15, 터미널 매칭 탭 — `PlayerRef.snapshotFace`).
 *
 * 매칭 탭의 정사각 초상 4칸은 **정지 이미지**다. 칸마다 WebGL 캔버스를 두면 컨텍스트가 넷이 되므로(브라우저 상한이
 * 16 이고 홀로그램 · 발사 슬롯 초상이 이미 하나씩 쓴다) 오프스크린 렌더러 **하나**로 한 장씩 그려 `toDataURL` 로
 * 뽑고 색 · 크기별로 캐시한다. `preserveDrawingBuffer` 없이도 같은 태스크 안의 `toDataURL` 은 방금 그린 버퍼를 읽는다
 * (`ui/menus/SoldierPreview.snapshotFace` 가 기대는 성질과 같다).
 *
 * **프레이밍은 캐릭터 생성 확정 팝업과 똑같다** — 숫자는 `shared/faceFraming`, 절차는 이 파일의 `poseFaceModel` ·
 * `aimFaceCamera` · `addFaceLights` 하나이고 `SoldierPreview` 도 이 셋을 부른다. 한쪽을 따로 고치지 않는다.
 *
 * 렌더러 수명: 처음 부를 때 만들고, `FACE_SNAPSHOT_IDLE_DISPOSE_MS` 동안 아무도 부르지 않으면 모델 · 씬 · 렌더러를
 * 전부 놓는다 (`forceContextLoss`). 캐시(data URL 문자열)는 남는다 — 다시 그릴 일이 없다. 두 번째 GL 컨텍스트를
 * 한 번 못 얻으면 이 페이지에서는 다시 시도하지 않고 늘 null 이다 (부르는 쪽이 이름만 남은 칸으로 내려간다).
 *
 * C-42 규약(`Portraits` · `SoldierPreview`): 방금 쓴 모델은 씬에서 떼기만 하고 **다음 render 뒤에** dispose 한다 —
 * 먼저 dispose 하면 같은 셰이더 프로그램을 쥔 머티리얼이 사라진 순간 프로그램이 지워져 다음 색이 다시 컴파일한다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** 서 있는 대기 자세 (무기 없음, 걷지 않음) — `Portraits` · `SoldierPreview` 의 포즈와 같다. */
const IDLE_POSE: SoldierPose = {
  moveBlend: 0, sprint: 0, stridePhase: 0, crouch: 0, aim: 0, aimPitch: 0, torsoTwist: 0, airborne: 0,
  verticalVel: 0, flinch: 0, hasWeapon: false, twoHanded: false, reloading: false, recoil: 0, dead: 0,
  prone: 0, throw: 0, holdItem: 0, roll: 0, rollPhase: 0, melee: 0, hover: 0, downed: 0,
  meleeHeavy: 0, charging: 0, spraying: 0, heavyCarry: 0, cooking: 0, carry: 0,
};

const _head = new THREE.Vector3();

/** 얼굴 초상의 조명 (키 + 림 + 반구광) 을 `scene` 에 단다. */
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
 * 몸을 얼굴 초상 각도로 돌리고 대기 자세에 고정한다 (숨쉬기 위상 `FACE_SNAPSHOT_TIME`, 관절 감쇠 몇 걸음).
 * 끝나면 월드 행렬까지 갱신돼 있어 `aimFaceCamera` 가 `headPivot` 을 바로 읽는다.
 */
export function poseFaceModel(model: SoldierModel, pose: SoldierPose = IDLE_POSE): void {
  model.root.rotation.set(0, FACE_SNAPSHOT_YAW, 0);
  for (let i = 0; i < FACE_SNAPSHOT_SETTLE_STEPS; i++) model.update(FACE_SNAPSHOT_SETTLE_DT, FACE_SNAPSHOT_TIME, pose);
  model.root.updateMatrixWorld(true);
}

/** `cam` 을 `model` 의 얼굴에 겨눈다. `aspect` = 그릴 캔버스의 가로 / 세로. */
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
  /** C-42: 방금 찍은 모델 — 다음 render 뒤에 놓는다. */
  private pendingDispose: SoldierModel[] = [];
  /** 두 번째 GL 컨텍스트를 한 번 못 얻었다 — 이 페이지에서는 다시 시도하지 않는다. */
  private failed = false;
  private readonly cache = new Map<string, string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  snapshot(opts: { accent: string; size?: number }, android = false): string | null {
    const accent = sanitizeAccent(opts?.accent) ?? `#${SOLDIER_DEFAULT_ACCENT.toString(16).padStart(6, '0')}`;
    const rawSize = Math.round(Number(opts?.size ?? FACE_SNAPSHOT_SIZE));
    const size = Math.max(FACE_SNAPSHOT_SIZE_MIN, Math.min(FACE_SNAPSHOT_SIZE_MAX, Number.isFinite(rawSize) ? rawSize : FACE_SNAPSHOT_SIZE));
    // 2026-09-15: 안드로이드는 같은 색이라도 다른 그림이다 — 캐시 열쇠를 나눈다
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
      model.setSilhouette(false);            // 가려질 월드가 없다
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
    this.flushPendingDispose();              // 이번 render 가 프로그램을 잡았다 — 지난 모델은 이제 놓아도 된다
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
      renderer.setPixelRatio(1);             // 크기는 부르는 쪽이 px 로 준다
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

  /** 모델 · 씬 · 렌더러를 놓는다 (캐시는 남긴다). 다음 스냅숏이 다시 만든다. */
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
 * `PlayerRef.snapshotFace` 의 구현: `accent`(`#rrggbb`, 틀리면 기본 헬다이버 노랑) 병사의 얼굴 한 장을 `size`×`size`
 * PNG data URL 로. GL 컨텍스트가 없으면 null. 같은 색 · 크기는 캐시에서 돌려준다.
 */
export function snapshotFace(opts: { accent: string; size?: number }): string | null {
  return snapper.snapshot(opts);
}

/**
 * `PlayerRef.snapshotAndroidFace` 의 구현 (2026-09-15, 안드로이드 분대원): `snapshotFace` 와 **같은 프레이밍 · 자세 ·
 * 조명**에 `SoldierModel.setAndroidLook(true)` 만 켠 얼굴 한 장. 색 · 크기별 캐시는 사람 얼굴과 따로 잡는다.
 */
export function snapshotAndroidFace(opts: { accent: string; size?: number }): string | null {
  return snapper.snapshot(opts, true);
}

/** 오프스크린 렌더러를 지금 놓는다 (캐시는 남는다). 보통은 유휴 타이머가 알아서 부른다. */
export function releaseFaceSnapshots(): void {
  snapper.release();
}
