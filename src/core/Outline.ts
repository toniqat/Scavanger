import * as THREE from 'three';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import type { OutlineChannel, OutlineRef } from '@/shared';

/**
 * `ctx.outline` (2026-09-12) — 화면 공간 외곽선. 계약은 `shared/render.ts` 의 `OutlineRef`.
 *
 * 시설 관리에서 가구에 커서를 올리면 **약한 흰색**(`hover`), 골라 두면 **중간 밝기 연두색**(`selected`) 외곽선이 선다
 * (사용자 결정 — 화면 공간 아웃라인 패스). three 의 `OutlinePass` 를 채널마다 하나씩 쓴다.
 *
 * - **안 쓸 때 비용 0**: 채널이 비면 `enabled = false` 라 컴포저가 건너뛰고, 캔버스 경로도 부르지 않는다.
 *   `set` 이 같은 목록이면 아무 일도 없다. 두 채널에 같은 오브젝트(또는 그 조상 · 자손)가 있으면 `selected` 만 그린다.
 * - **블룸 꺼짐에서도 선다**: 컴포저가 있으면 블룸 뒤 · OutputPass 앞에 끼워 넣고(`attach`), 블룸을 끈 캔버스 경로에서는
 *   `renderDirect` 가 씬을 그린 뒤 같은 패스를 캔버스에 **덧그린다** — 캔버스 경로를 컴포저로 바꾸면 그리는 렌더 타깃이
 *   바뀌어 씬 전체가 재컴파일되기 때문이다 (Engine `applyPost` 주석). 캔버스는 톤매핑 · sRGB 인코딩을 거치지 않으므로
 *   그 경로에서는 색을 sRGB 로 인코딩한 값으로 바꿔 끼운다.
 * - **첫 호버의 컴파일 멈춤을 없앤다** (`warm`): 외곽선 머티리얼의 프로그램 키는 **그리는 곳의 상태**를 따른다 — 씬을
 *   오버라이드로 그리는 깊이 · 마스크 머티리얼은 씬의 포그 · 점광원 개수 · 그림자와 렌더 타깃(선형)을, 전체 화면 쿼드는
 *   광원 0 · 포그 없음 · 렌더 타깃을, 마지막 덧그리기(overlay)는 캔버스 경로면 캔버스(sRGB · ACES)를 본다. 그래서 그 상태가
 *   바뀔 때마다(포그 종류 · 해의 그림자 · 블룸 경로) 똑같은 조건을 흉내 내 `renderer.compile` 로 링크를 걸어 둔다
 *   (KHR_parallel_shader_compile — 드라이버가 백그라운드에서 끝낸다). 점광원 개수는 `LightBudget` 이 세션 내내 고정이라
 *   Engine 이 `beforeRender`(예산 채움) **뒤**에만 부른다. 마스크 단계는 선택하지 않은 메시를 전부 숨기고 그리므로, 메시
 *   밑에 매달린 광원이 빠진 개수를 그대로 보도록 워밍도 같은 숨김 안에서 한다.
 * - **광원을 만들지 않는다.** 패스가 잠깐 바꾸는 `visible` 은 메시 · 스프라이트 · 점 · 선뿐이고 광원 · 그룹은 건드리지
 *   않으며 렌더가 끝나기 전에 되돌린다 — `smoke-lights` 가 세는 개수(`traverseVisible`)는 프레임 사이에서 그대로다.
 * - **그림자를 다시 그리지 않는다**: 패스 안의 `renderer.render(scene)` 두 번이 해의 그림자 맵까지 다시 그리지 않게,
 *   그동안만 `shadowMap.autoUpdate` 를 끈다 (그림자 맵은 이번 프레임에 본 렌더가 이미 갱신했다).
 */

/** 채널별 겉모습 (UI 시각값이지 밸런스 수치가 아니다). */
const STYLE: Readonly<Record<OutlineChannel, { color: number; strength: number; thickness: number }>> = {
  hover: { color: 0xffffff, strength: 1.4, thickness: 1.0 },      // 약한 흰색
  selected: { color: 0xa8f060, strength: 3.0, thickness: 1.5 },   // 중간 밝기 연두색
};

/** 외곽선 채널 하나를 그리는 패스 — 내부 씬 렌더 동안 그림자 맵 갱신을 끈다. */
class ChannelPass extends OutlinePass {
  override render(
    renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number, maskActive: boolean,
  ): void {
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    try { super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive); }
    finally { renderer.shadowMap.autoUpdate = auto; }
  }
}

/** The pass's real (underscore) internals — `@types/three` still lists the pre-rename names. */
interface PassInternals {
  _selectionCache: Set<THREE.Object3D>;
  _visibilityCache: Map<THREE.Object3D, boolean>;
  _changeVisibilityOfNonSelectedObjects(visible: boolean): void;
}

function isInside(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

function sameList(a: readonly THREE.Object3D[], b: readonly THREE.Object3D[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Channel {
  pass: ChannelPass;
  /** What the caller asked for (kept even while detached from the scene — it may come back). */
  wanted: THREE.Object3D[];
  linear: THREE.Color;
  /** `linear` encoded to sRGB — the canvas path writes straight into the display buffer. */
  display: THREE.Color;
}

export class Outline implements OutlineRef {
  private readonly channels: Record<OutlineChannel, Channel>;
  private readonly order: readonly Channel[];
  /** Warm-up stand-ins: the scene-override materials on a plain + an instanced box, the full-screen ones on a quad. */
  private readonly warmScene = new THREE.Group();
  private readonly warmMask = new THREE.Group();
  private readonly warmQuad = new THREE.Group();
  private readonly warmOverlay = new THREE.Group();
  private readonly warmCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly warmGeos: THREE.BufferGeometry[] = [];
  /** Fog kind × 4 + sun shadow × 2 + canvas path — the scene state the outline programs were last linked for (−1 = never). */
  private warmedState = -1;

  constructor(private readonly scene: THREE.Scene, camera: THREE.Camera) {
    const make = (ch: OutlineChannel): Channel => {
      const s = STYLE[ch];
      const pass = new ChannelPass(new THREE.Vector2(256, 256), scene, camera);
      const linear = new THREE.Color(s.color);                // hex → working (linear) space
      pass.visibleEdgeColor.copy(linear);
      pass.hiddenEdgeColor.copy(linear);                      // occluded edges look the same (the hub ceiling is back-face culled, but the depth pass is double-sided)
      pass.edgeStrength = s.strength;
      pass.edgeThickness = s.thickness;
      pass.edgeGlow = 0;
      pass.pulsePeriod = 0;
      pass.enabled = false;
      return { pass, wanted: [], linear, display: linear.clone().convertLinearToSRGB() };
    };
    this.channels = { hover: make('hover'), selected: make('selected') };
    this.order = [this.channels.hover, this.channels.selected];   // selected draws last = on top
    this.buildWarmObjects();
  }

  /* ── OutlineRef ── */
  set(channel: OutlineChannel, objects: readonly THREE.Object3D[] | null): void {
    const ch = this.channels[channel];
    const next = objects ? objects.filter((o): o is THREE.Object3D => !!o) : [];
    if (sameList(ch.wanted, next)) return;
    ch.wanted = next;
  }

  clear(): void {
    for (const ch of this.order) ch.wanted = [];
    for (const ch of this.order) { ch.pass.selectedObjects = []; ch.pass.enabled = false; }
  }

  /** Debug / smoke: objects each channel is drawing this frame. */
  get drawing(): { hover: number; selected: number } {
    return { hover: this.channels.hover.pass.selectedObjects.length, selected: this.channels.selected.pass.selectedObjects.length };
  }

  /* ── Engine hooks ── */
  /** Insert both passes into the composer right before its last pass (OutputPass). */
  attach(composer: { passes: unknown[]; insertPass(pass: unknown, index: number): void }): void {
    const at = Math.max(0, composer.passes.length - 1);
    composer.insertPass(this.channels.hover.pass, at);
    composer.insertPass(this.channels.selected.pass, at + 1);
  }

  /** Drawing-buffer size (CSS size × pixel ratio). The composer resizes attached passes too; this covers the canvas path. */
  setSize(width: number, height: number): void {
    for (const ch of this.order) ch.pass.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  }

  /**
   * Once per frame before drawing: resolve what each channel really draws — objects detached from the scene drop out,
   * `selected` wins over `hover` (same object, ancestor or descendant) — and enable only non-empty passes.
   */
  prepare(): void {
    const sel = this.channels.selected, hov = this.channels.hover;
    const selLive = this.live(sel.wanted, sel.pass.selectedObjects);
    const hovLive = this.live(hov.wanted, hov.pass.selectedObjects, selLive);
    sel.pass.selectedObjects = selLive;
    hov.pass.selectedObjects = hovLive;
    sel.pass.enabled = selLive.length > 0;
    hov.pass.enabled = hovLive.length > 0;
  }

  /** Whether any channel draws this frame. */
  get active(): boolean { return this.channels.hover.pass.enabled || this.channels.selected.pass.enabled; }

  /**
   * The canvas path (bloom off): the scene is already on the canvas — add the outlines on top of it. The passes'
   * final overlay binds `readBuffer`, so null = the canvas; `writeBuffer` is never read.
   */
  renderDirect(renderer: THREE.WebGLRenderer, dt: number): void {
    if (!this.active) return;
    for (const ch of this.order) {
      if (!ch.pass.enabled) continue;
      ch.pass.visibleEdgeColor.copy(ch.display);
      ch.pass.hiddenEdgeColor.copy(ch.display);
      ch.pass.render(renderer, null as unknown as THREE.WebGLRenderTarget, null as unknown as THREE.WebGLRenderTarget, dt, false);
      ch.pass.visibleEdgeColor.copy(ch.linear);
      ch.pass.hiddenEdgeColor.copy(ch.linear);
    }
    renderer.setRenderTarget(null);
  }

  /**
   * Link the outline programs for the scene state they will be drawn in (see the class comment). Cheap no-op unless
   * the state key changed. **Call only after `LightBudget` has filled the scene** (Engine: after `shaders.beforeRender`).
   */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera, sunShadow: boolean, canvasPath: boolean): void {
    // called every frame: compare the three inputs without building a key string (no per-frame allocation)
    const fog = this.scene.fog;
    const fogKind = fog ? ((fog as THREE.FogExp2).isFogExp2 ? 2 : 1) : 0;
    const state = fogKind * 4 + (sunShadow ? 2 : 0) + (canvasPath ? 1 : 0);
    if (state === this.warmedState) return;
    this.warmedState = state;
    const prevTarget = renderer.getRenderTarget();
    const rt = this.channels.selected.pass.renderTargetMaskBuffer;
    const hider = this.channels.selected.pass as unknown as PassInternals;
    try {
      renderer.setRenderTarget(rt);
      // step 1 (depth of the non-selected objects): the scene as it is
      renderer.compile(this.warmScene, camera, this.scene);
      // step 1b (mask of the selected objects): every mesh / sprite / point / line hidden, like the pass does
      hider._selectionCache.clear();
      hider._changeVisibilityOfNonSelectedObjects(false);
      try { renderer.compile(this.warmMask, camera, this.scene); }
      finally { hider._changeVisibilityOfNonSelectedObjects(true); hider._visibilityCache.clear(); }
      // full-screen quads: no lights, no fog, into a render target (the overlay too on the composer path)
      renderer.compile(this.warmQuad, this.warmCam);
      renderer.compile(this.warmOverlay, this.warmCam);
      if (canvasPath) {
        renderer.setRenderTarget(null);
        renderer.compile(this.warmOverlay, this.warmCam);
      }
    } catch (e) {
      console.warn('[Outline] warm-up failed', e);
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  /** Force the next `warm` to run again (e.g. after a scene swap that the key cannot see). */
  invalidateWarm(): void { this.warmedState = -1; }

  dispose(): void {
    this.clear();
    for (const ch of this.order) ch.pass.dispose();
    for (const g of this.warmGeos) g.dispose();
    this.warmGeos.length = 0;
  }

  /* ── internals ── */
  /** `wanted` filtered to objects in the scene (and, for hover, not overlapping `exclude`). Reuses `out` when unchanged. */
  private live(wanted: readonly THREE.Object3D[], current: THREE.Object3D[], exclude?: readonly THREE.Object3D[]): THREE.Object3D[] {
    let changed = false;
    let n = 0;
    for (const o of wanted) {
      if (!isInside(o, this.scene)) continue;
      if (exclude && exclude.some((e) => isInside(o, e) || isInside(e, o))) continue;
      if (current[n] !== o) changed = true;
      n++;
    }
    if (!changed && n === current.length) return current;
    const out: THREE.Object3D[] = [];
    for (const o of wanted) {
      if (!isInside(o, this.scene)) continue;
      if (exclude && exclude.some((e) => isInside(o, e) || isInside(e, o))) continue;
      out.push(o);
    }
    return out;
  }

  private buildWarmObjects(): void {
    const pass = this.channels.selected.pass;
    const box = new THREE.BoxGeometry(1, 1, 1);            // position + normal + uv — like the merged furniture geometry
    this.warmGeos.push(box);
    const plainAndInstanced = (group: THREE.Group, mat: THREE.Material): void => {
      group.add(new THREE.Mesh(box, mat));
      const inst = new THREE.InstancedMesh(box, mat, 1);
      inst.setMatrixAt(0, new THREE.Matrix4());
      group.add(inst);
    };
    plainAndInstanced(this.warmScene, pass.depthMaterial);
    plainAndInstanced(this.warmMask, pass.prepareMaskMaterial);
    // FullScreenQuad's geometry: position + uv, no normal
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
    this.warmGeos.push(quad);
    for (const m of [pass.materialCopy, pass.edgeDetectionMaterial, pass.separableBlurMaterial1, pass.separableBlurMaterial2]) {
      this.warmQuad.add(new THREE.Mesh(quad, m));
    }
    this.warmOverlay.add(new THREE.Mesh(quad, pass.overlayMaterial));
  }
}
