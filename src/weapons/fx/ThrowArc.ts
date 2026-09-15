import * as THREE from 'three';
import { GRAVITY, THROW_ARC_PREVIEW_FRACTION, type GameContext } from '@/shared';

/** Simulation step (s) and flight cap — 2.5 s of arc covers every throw in the game with room to spare. */
const STEP = 1 / 30;
const MAX_STEPS = 75;
/**
 * 아래로 던지는 경우의 최소 길이 (0.4 s). 비행의 끝은 「던진 높이로 되돌아오는 점」인데, 발밑을 겨누고 던지면
 * 릴리스 순간부터 내려가므로 그 조건이 첫 스텝에서 참이 되어 점이 하나도 안 찍힌다. 방향은 보여야 한다.
 */
const MIN_STEPS = 12;
/** Centreline points: the release point, one per simulated step, and the interpolated cut at the preview fraction. */
const MAX_PTS = MAX_STEPS + 2;

/* ── 2026-09-15 궤적 모양 (사용자 결정: 점선 → 연한 빨강 트레일) ───────────────────────────────────────────── */
/** Ribbon width at the hand (m); it narrows linearly with arc length to a point at the preview's end. */
const TRAIL_WIDTH_M = 0.12;
/** Light red — the default for every caller (the constructor still accepts an override). */
const TRAIL_COLOR = 0xff8080;
/** Material opacity — "slightly transparent". */
const TRAIL_OPACITY = 0.5;
/** Vertex alpha at the far end (1 at the hand) — the tail fades as well as tapers. */
const TAIL_ALPHA = 0.3;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
/** Full simulated flight (every step), before the preview fraction trims it. */
const _sim = new Float32Array((MAX_STEPS + 1) * 3);
/** Trimmed centreline the ribbon is built around. */
const _line = new Float32Array(MAX_PTS * 3);
/** Cumulative 3D arc length per centreline point (taper + fade parameter). */
const _cum = new Float32Array(MAX_PTS);
const _tan = new THREE.Vector3();
const _view = new THREE.Vector3();
const _side = new THREE.Vector3();
const _prevSide = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * 투척 궤적 미리보기 (2026-09-08). **2026-09-11: only the first `THROW_ARC_PREVIEW_FRACTION` of the horizontal flight is
 * drawn and the landing ring is never shown** (사용자 결정).
 *
 * **2026-09-14 2차 (사용자 결정) — 튕김은 계산하지 않는다. 「던질 때 날아가는 방향 궤적」만 그린다.**
 * 예전에는 실제 투척물과 똑같이 적분했다 — 매 스텝 `world.resolveCollision` 으로 장애물 밖으로 밀어내고
 * `getSurfaceY` 로 바닥을 잡았다. 그래서 바위 · 벽 · 창틀 · 난간을 스치는 순간 점선이 그 표면을 따라 **꺾이거나
 * 미끄러졌고**, 그것이 사람이 「튕긴다」고 읽은 움직임이었다. 미리보기가 답할 질문은 *어디로 던지는가* 하나이므로
 * **충돌 판정 자체를 뺐다**: 이제 릴리스 지점 · 속도 · 중력뿐인 순수 포물선이다. 그래서 **궤적이 벽을 통과해
 * 보이는 것은 의도된 결과**다 — 이 궤적은 「여기 맞는다」가 아니라 「이쪽으로 나간다」를 말한다. (실제 수류탄 ·
 * 투척 가젯의 비행 · 튕김 · 신관은 `Grenade.ts` / `ThrownGadget` 그대로이고 한 줄도 바뀌지 않았다.)
 *
 * 그 대신 비행의 끝도 지형이 아니라 **던진 높이로 되돌아오는 점**이다(내려 던지면 최소 `MIN_STEPS`). 평지에서는
 * 옛 착지 시각과 사실상 같은 길이가 나오고, 세계에 무엇이 있느냐로 길이가 흔들리지 않는다. 릴리스 지점 · 속도는
 * 여전히 던지기가 쓸 바로 그 값이라(호출부가 계산한다) 근력 `derived.throwRangeMul` · 오버/언더핸드 · 플레이어
 * 자신의 관성은 예전 그대로 반영된다.
 *
 * **2026-09-15 (사용자 결정) — 점선이 아니라 트레일이다.** 같은 중심선(길이 · 비율 · `MIN_STEPS` 전부 그대로)을
 * **연한 빨강 반투명 리본**으로 그린다: 손에서 `TRAIL_WIDTH_M` 폭으로 시작해 호 길이에 비례해 좁아지다가 미리보기
 * 끝에서 한 점이 되고, 정점 알파도 `TAIL_ALPHA` 까지 옅어진다. 리본은 **카메라를 향한다** — 각 점의 폭 방향이
 * `접선 × (점 − 카메라)` 라 3인칭 카메라에서 옆으로 누운 판이 선 한 줄로 사라지지 않는다. 카메라를 따라 뒤집히지
 * 않도록 이웃 점의 폭 방향과 내적이 음수면 부호를 뒤집는다 (꼬임 방지). 카메라 위치는 `show()` 시점의
 * `ctx.camera.position` 이다 — 카메라는 씬 루트에 붙어 있고(`core/Engine`), 한 프레임 늦은 위치라도 폭 방향은
 * 사실상 같다.
 *
 * Everything is pooled and light-free: one `Mesh` over a fixed-size indexed quad strip (position + RGBA colour,
 * `setDrawRange` picks how many quads are live), `depthTest: false` so it reads over the terrain it passes, no per-frame
 * allocation.
 */
export class ThrowArc {
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  /** Two vertices per centreline point (left, right). */
  private positions: Float32Array = new Float32Array(MAX_PTS * 2 * 3);
  /** RGBA per vertex — rgb stays 1 (the material carries the colour), alpha fades toward the tail. */
  private colors: Float32Array = new Float32Array(MAX_PTS * 2 * 4).fill(1);
  private geo: THREE.BufferGeometry | null = null;
  private mat: THREE.MeshBasicMaterial | null = null;
  /** End of the last `show()` 's parabola (debug / smoke — not drawn). */
  private readonly impact = new THREE.Vector3();
  private shown = false;

  constructor(private readonly ctx: GameContext, private readonly color = TRAIL_COLOR) {}

  private ensure(): void {
    if (this.mesh) return;
    const geo = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(this.positions, 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.BufferAttribute(this.colors, 4);
    col.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('color', col);
    // static quad strip: segment i = vertices (2i, 2i+1, 2i+2, 2i+3)
    const index = new Uint16Array((MAX_PTS - 1) * 6);
    for (let i = 0; i < MAX_PTS - 1; i++) {
      const a = i * 2, o = i * 6;
      index[o] = a; index[o + 1] = a + 1; index[o + 2] = a + 2;
      index[o + 3] = a + 1; index[o + 4] = a + 3; index[o + 5] = a + 2;
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    this.mat = new THREE.MeshBasicMaterial({
      color: this.color, vertexColors: true, transparent: true, opacity: TRAIL_OPACITY,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.name = 'throw-arc';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.visible = false;
    this.mesh = mesh;
    this.ctx.scene.add(mesh);
  }

  /**
   * Show the arc for a throw released at `origin` with `velocity`. Both must be the values the throw itself will
   * use — the caller owns the release maths so there is exactly one copy of it per throw type.
   *
   * 2026-09-11 — **궤적은 끝까지 그리지 않는다** (사용자 결정). 비행을 끝까지 적분한 뒤 수평 비거리의
   * `THROW_ARC_PREVIEW_FRACTION`(0.5) 까지만 그리고, **떨어질 자리 표시(고리)는 없다** — 대충 어디로 날아갈지만
   * 보여 준다. 근력(`derived.throwRangeMul`) · 임플란트로 사거리가 늘면 보이는 궤적도 그만큼 길어진다.
   *
   * 2026-09-14 2차 — 적분은 **중력뿐**이다 (클래스 주석). 세계에 아무것도 묻지 않으므로 `world` 가 아직 없거나
   * (함선 · 훈련장 로딩 중) 바뀌는 중이어도 같은 궤적이 나온다. `getImpact` 가 돌려주는 것은 이제 실제 착지점이
   * 아니라 **그 포물선이 끝나는 자리**다 (디버그 · 스모크용 — 화면에는 없다).
   */
  show(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    this.ensure();
    _p.copy(origin);
    _v.copy(velocity);
    // ① 끝까지 적분 — 던진 높이로 되돌아오거나 MAX_STEPS 에 닿을 때까지의 모든 점 (충돌 판정 없음)
    _sim[0] = _p.x; _sim[1] = _p.y; _sim[2] = _p.z;
    let n = 1;
    for (let i = 0; i < MAX_STEPS; i++) {
      _v.y -= GRAVITY * STEP;
      _p.addScaledVector(_v, STEP);
      _sim[n * 3] = _p.x; _sim[n * 3 + 1] = _p.y; _sim[n * 3 + 2] = _p.z;
      n++;
      if (n > MIN_STEPS && _v.y < 0 && _p.y <= origin.y) break;
    }
    this.impact.copy(_p);
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(_sim[i * 3] - _sim[(i - 1) * 3], _sim[i * 3 + 2] - _sim[(i - 1) * 3 + 2]);
    // ② 앞쪽 비율만큼만 중심선으로 옮긴다 (마지막 점은 경계에서 보간)
    const frac = Math.min(1, Math.max(0, THROW_ARC_PREVIEW_FRACTION));
    const limit = total * frac;
    _line[0] = _sim[0]; _line[1] = _sim[1]; _line[2] = _sim[2];
    let pts = 1, run = 0;
    for (let i = 1; i < n && pts < MAX_PTS; i++) {
      const ax = _sim[(i - 1) * 3], ay = _sim[(i - 1) * 3 + 1], az = _sim[(i - 1) * 3 + 2];
      const bx = _sim[i * 3], by = _sim[i * 3 + 1], bz = _sim[i * 3 + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      if (run + seg >= limit) {
        const t = seg > 1e-6 ? (limit - run) / seg : 0;
        _line[pts * 3] = ax + (bx - ax) * t;
        _line[pts * 3 + 1] = ay + (by - ay) * t;
        _line[pts * 3 + 2] = az + (bz - az) * t;
        pts++;
        break;
      }
      run += seg;
      _line[pts * 3] = bx; _line[pts * 3 + 1] = by; _line[pts * 3 + 2] = bz;
      pts++;
    }
    // ③ 중심선 → 카메라를 향한, 끝으로 갈수록 좁아지는 리본
    this.buildRibbon(pts);
    this.mesh!.visible = true;
    this.shown = true;
  }

  /** Fill the first `pts` centreline points' vertex pairs and set the draw range. No allocation. */
  private buildRibbon(pts: number): void {
    const geo = this.geo!;
    if (pts < 2) { geo.setDrawRange(0, 0); return; }
    const pos = this.positions, col = this.colors;
    _cum[0] = 0;
    for (let i = 1; i < pts; i++) {
      const a = (i - 1) * 3, b = i * 3;
      _cum[i] = _cum[i - 1] + Math.hypot(_line[b] - _line[a], _line[b + 1] - _line[a + 1], _line[b + 2] - _line[a + 2]);
    }
    const len = _cum[pts - 1] > 1e-6 ? _cum[pts - 1] : 1;
    const cam = this.ctx.camera.position;
    _prevSide.set(0, 0, 0);
    for (let i = 0; i < pts; i++) {
      const c = i * 3;
      const a = (i > 0 ? i - 1 : 0) * 3, b = (i < pts - 1 ? i + 1 : pts - 1) * 3;
      const px = _line[c], py = _line[c + 1], pz = _line[c + 2];
      _tan.set(_line[b] - _line[a], _line[b + 1] - _line[a + 1], _line[b + 2] - _line[a + 2]);
      _view.set(px - cam.x, py - cam.y, pz - cam.z);
      _side.crossVectors(_tan, _view);
      if (_side.lengthSq() < 1e-10) {
        // looking straight down the arc here: keep the neighbour's direction, else fall back to horizontal
        if (_prevSide.lengthSq() > 0) _side.copy(_prevSide);
        else { _side.crossVectors(_tan, _up); if (_side.lengthSq() < 1e-10) _side.set(1, 0, 0); }
      }
      _side.normalize();
      if (_prevSide.lengthSq() > 0 && _side.dot(_prevSide) < 0) _side.negate();   // no half-twists along the strip
      _prevSide.copy(_side);
      const f = _cum[i] / len;
      const hw = TRAIL_WIDTH_M * 0.5 * (1 - f);
      const v = i * 6;
      pos[v] = px + _side.x * hw; pos[v + 1] = py + _side.y * hw; pos[v + 2] = pz + _side.z * hw;
      pos[v + 3] = px - _side.x * hw; pos[v + 4] = py - _side.y * hw; pos[v + 5] = pz - _side.z * hw;
      const alpha = 1 + (TAIL_ALPHA - 1) * f;
      col[i * 8 + 3] = alpha;
      col[i * 8 + 7] = alpha;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, (pts - 1) * 6);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.mesh) this.mesh.visible = false;
  }

  /** Whether the preview is on screen right now (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** World-space end of the last `show()` 's arc (debug / smoke); null while hidden. 2026-09-14 2차: 착지점이 아니다. */
  getImpact(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.shown || !this.mesh) return null;
    return out.copy(this.impact);
  }

  dispose(): void {
    this.hide();
    if (this.mesh) { this.ctx.scene.remove(this.mesh); this.mesh = null; }
    this.geo?.dispose(); this.geo = null;
    this.mat?.dispose(); this.mat = null;
  }
}
