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
/** Every Nth simulated step becomes a dot. 1 = one per step, so even a short lob still draws a readable arc. */
const DOT_EVERY = 1;
const MAX_DOTS = Math.ceil(MAX_STEPS / DOT_EVERY) + 1;
const MARKER_R = 0.8;

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
/** `RingGeometry` lies in the XY plane, so its own normal is +Z — that is what gets rotated onto the ground normal. */
const _ringN = new THREE.Vector3(0, 0, 1);
const _flat = new THREE.Vector3(0, 1, 0);
/** Full simulated flight (every step), before the preview fraction trims it. */
const _sim = new Float32Array((MAX_STEPS + 1) * 3);
const _impact = new THREE.Vector3();

/**
 * 투척 궤적 미리보기 (2026-09-08). A dotted arc from the hand along the throw. **2026-09-11: only the first
 * `THROW_ARC_PREVIEW_FRACTION` of the horizontal flight is drawn and the landing ring is never shown** (사용자 결정).
 *
 * **2026-09-14 2차 (사용자 결정) — 튕김은 계산하지 않는다. 「던질 때 날아가는 방향 궤적」만 그린다.**
 * 예전에는 실제 투척물과 똑같이 적분했다 — 매 스텝 `world.resolveCollision` 으로 장애물 밖으로 밀어내고
 * `getSurfaceY` 로 바닥을 잡았다. 그래서 바위 · 벽 · 창틀 · 난간을 스치는 순간 점선이 그 표면을 따라 **꺾이거나
 * 미끄러졌고**, 그것이 사람이 「튕긴다」고 읽은 움직임이었다. 미리보기가 답할 질문은 *어디로 던지는가* 하나이므로
 * **충돌 판정 자체를 뺐다**: 이제 릴리스 지점 · 속도 · 중력뿐인 순수 포물선이다. 그래서 **궤적이 벽을 통과해
 * 보이는 것은 의도된 결과**다 — 이 점선은 「여기 맞는다」가 아니라 「이쪽으로 나간다」를 말한다. (실제 수류탄 ·
 * 투척 가젯의 비행 · 튕김 · 신관은 `Grenade.ts` / `ThrownGadget` 그대로이고 한 줄도 바뀌지 않았다.)
 *
 * 그 대신 비행의 끝도 지형이 아니라 **던진 높이로 되돌아오는 점**이다(내려 던지면 최소 `MIN_STEPS`). 평지에서는
 * 옛 착지 시각과 사실상 같은 길이가 나오고, 세계에 무엇이 있느냐로 길이가 흔들리지 않는다. 릴리스 지점 · 속도는
 * 여전히 던지기가 쓸 바로 그 값이라(호출부가 계산한다) 근력 `derived.throwRangeMul` · 오버/언더핸드 · 플레이어
 * 자신의 관성은 예전 그대로 반영된다.
 *
 * Everything is pooled and light-free: one `Points` cloud with a fixed buffer (`setDrawRange` picks how much of it is
 * live) and one ring mesh, both `depthTest: false` so they read over the terrain they hug.
 */
export class ThrowArc {
  private group: THREE.Group | null = null;
  private dots: THREE.Points | null = null;
  private marker: THREE.Mesh | null = null;
  private positions: Float32Array = new Float32Array(MAX_DOTS * 3);
  private geo: THREE.BufferGeometry | null = null;
  private dotMat: THREE.PointsMaterial | null = null;
  private ringGeo: THREE.RingGeometry | null = null;
  private ringMat: THREE.MeshBasicMaterial | null = null;
  private shown = false;

  constructor(private readonly ctx: GameContext, private readonly color = 0xf2c14a) {}

  private ensure(): void {
    if (this.group) return;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setDrawRange(0, 0);
    this.dotMat = new THREE.PointsMaterial({
      color: this.color, size: 6, sizeAttenuation: false,
      transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.dots = new THREE.Points(this.geo, this.dotMat);
    this.dots.frustumCulled = false;
    this.ringGeo = new THREE.RingGeometry(MARKER_R * 0.72, MARKER_R, 24);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: this.color, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.marker = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.marker.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.name = 'throw-arc';
    this.group.renderOrder = 3;
    this.group.visible = false;
    this.group.add(this.dots, this.marker);
    this.ctx.scene.add(this.group);
  }

  /**
   * Show the arc for a throw released at `origin` with `velocity`. Both must be the values the throw itself will
   * use — the caller owns the release maths so there is exactly one copy of it per throw type.
   *
   * 2026-09-11 — **궤적은 끝까지 그리지 않는다** (사용자 결정). 비행을 끝까지 적분한 뒤 수평 비거리의
   * `THROW_ARC_PREVIEW_FRACTION`(0.5) 까지만 점을 찍고, **떨어질 자리 표시(고리)는 없다** — 대충 어디로 날아갈지만
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
    _impact.copy(_p);
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(_sim[i * 3] - _sim[(i - 1) * 3], _sim[i * 3 + 2] - _sim[(i - 1) * 3 + 2]);
    // ② 앞쪽 비율만큼만 점으로 옮긴다 (마지막 점은 경계에서 보간)
    const frac = Math.min(1, Math.max(0, THROW_ARC_PREVIEW_FRACTION));
    const limit = total * frac;
    this.positions[0] = _sim[0]; this.positions[1] = _sim[1]; this.positions[2] = _sim[2];
    let dots = 1, run = 0;
    for (let i = 1; i < n && dots < MAX_DOTS; i++) {
      const ax = _sim[(i - 1) * 3], ay = _sim[(i - 1) * 3 + 1], az = _sim[(i - 1) * 3 + 2];
      const bx = _sim[i * 3], by = _sim[i * 3 + 1], bz = _sim[i * 3 + 2];
      const seg = Math.hypot(bx - ax, bz - az);
      if (run + seg >= limit) {
        const t = seg > 1e-6 ? (limit - run) / seg : 0;
        this.positions[dots * 3] = ax + (bx - ax) * t;
        this.positions[dots * 3 + 1] = ay + (by - ay) * t;
        this.positions[dots * 3 + 2] = az + (bz - az) * t;
        dots++;
        break;
      }
      run += seg;
      if (i % DOT_EVERY === 0) {
        this.positions[dots * 3] = bx; this.positions[dots * 3 + 1] = by; this.positions[dots * 3 + 2] = bz;
        dots++;
      }
    }
    this.geo!.attributes.position.needsUpdate = true;
    this.geo!.setDrawRange(0, dots);
    // 착지 고리는 더 이상 보이지 않는다 — 자리만 기억해 둔다 (`getImpact`). 2026-09-14 2차: 그 자리가 땅이라는
    // 보장이 없어졌으므로 지형 법선(`getNormalAt`)도 묻지 않는다 — 보이지 않는 고리를 평평하게 눕혀 둘 뿐이다.
    const m = this.marker!;
    m.position.copy(_impact);
    m.quaternion.setFromUnitVectors(_ringN, _flat);
    m.visible = false;
    this.group!.visible = true;
    this.shown = true;
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.group) this.group.visible = false;
  }

  /** Whether the preview is on screen right now (debug / smoke). */
  get isShowing(): boolean { return this.shown; }
  /** World-space end of the last `show()` 's arc (debug / smoke); null while hidden. 2026-09-14 2차: 착지점이 아니다. */
  getImpact(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.shown || !this.marker) return null;
    return out.copy(this.marker.position);
  }

  dispose(): void {
    this.hide();
    if (this.group) { this.ctx.scene.remove(this.group); this.group.clear(); this.group = null; }
    this.geo?.dispose(); this.geo = null;
    this.dotMat?.dispose(); this.dotMat = null;
    this.ringGeo?.dispose(); this.ringGeo = null;
    this.ringMat?.dispose(); this.ringMat = null;
    this.dots = null; this.marker = null;
  }
}
