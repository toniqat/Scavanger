import * as THREE from 'three';
import type { GameContext } from '@/shared';
import {
  GUIDE_ARRIVE, GUIDE_COLOR, GUIDE_DASH, GUIDE_FLOW, GUIDE_GAP, GUIDE_LIFT, GUIDE_WIDTH,
  PILLAR_HEIGHT, PILLAR_RADIUS, RETARGET_INTERVAL,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Guide.ts — **바닥 안내선** (흐르는 점선 + 목표 빛기둥).
 *
 * 목표는 `Interactable.id` 로 준다 (`hub_terminal` · `hub_pod_0` · `hub_furn_<uid>`) — 그러면 방 배치나
 * 가구 위치를 몰라도 `ctx.interactables` 하나로 좌표가 나온다.
 *
 * 선은 **플레이어 → 목표** 직선을 바닥 위 `GUIDE_LIFT` 에 깐 얇은 띠 하나(`PlaneGeometry`)이고, 점선은
 * 지오메트리가 아니라 **셰이더**가 그린다: 길이 방향 UV 를 실제 미터로 환산해 `fract()` 로 잘라 내고
 * `uTime` 만큼 밀면 마디가 목표 쪽으로 흐른다. 마디를 메시로 만들면 경로가 바뀔 때마다 지오메트리를
 * 새로 만들어야 하는데, 이 방식은 uniform 두 개만 갱신하면 된다 (프레임당 할당 0).
 *
 * 목표에는 반투명 원기둥 빛기둥 + 바닥 링을 세운다. 둘 다 `depthWrite: false` 라 서로 겹쳐도 깨지지 않는다.
 * 벽을 통과해 보이는 것은 의도한 것이다 — 안내선은 "저쪽이다"를 알려 주는 물건이지 시야 판정이 아니다.
 *
 * 미션 리셋 때 dispose 해야 하는 지오메트리 · 머티리얼은 전부 `disposables` 에 모아 둔다.
 * ──────────────────────────────────────────────────────────────────────────── */

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _mid = new THREE.Vector3();

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * `uLength` = 띠의 실제 길이(m) — UV.x 를 미터로 되돌리는 데 쓴다. `uTime` 이 마디를 흘린다.
 * 가장자리(`vUv.y`)는 부드럽게 흐리고, 목표에 가까울수록 밝게 해서 방향이 읽히게 한다.
 */
const FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uLength;
  uniform float uDash;
  uniform float uGap;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float period = uDash + uGap;
    float s = fract((vUv.x * uLength - uTime) / period) * period;
    float dash = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(uDash - 0.05, uDash, s));
    float edge = 1.0 - smoothstep(0.35, 0.5, abs(vUv.y - 0.5));
    float head = 0.55 + 0.45 * vUv.x;
    float a = dash * edge * head * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

export class Guide {
  private readonly group = new THREE.Group();
  private readonly line: THREE.Mesh;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly pillar: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private targetId: string | null = null;
  private timer = 0;
  private mounted = false;
  private time = 0;
  /** Last resolved target position (null = the interactable is not registered right now). */
  private target: THREE.Vector3 | null = null;

  constructor(private readonly ctx: GameContext) {
    this.group.name = 'TutorialGuide';
    this.group.renderOrder = 3;

    const geo = new THREE.PlaneGeometry(1, GUIDE_WIDTH, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0.5, 0, 0);              // 원점이 시작점이 되도록 (스케일 = 길이)
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(GUIDE_COLOR) },
        uTime: { value: 0 }, uLength: { value: 1 },
        uDash: { value: GUIDE_DASH }, uGap: { value: GUIDE_GAP }, uOpacity: { value: 1 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.line = new THREE.Mesh(geo, this.lineMat);
    this.line.frustumCulled = false;
    this.group.add(this.line);
    this.disposables.push(geo, this.lineMat);

    const pGeo = new THREE.CylinderGeometry(PILLAR_RADIUS, PILLAR_RADIUS * 0.85, PILLAR_HEIGHT, 20, 1, true);
    pGeo.translate(0, PILLAR_HEIGHT / 2, 0);
    const pMat = new THREE.MeshBasicMaterial({
      color: GUIDE_COLOR, transparent: true, opacity: 0.16,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.pillar = new THREE.Mesh(pGeo, pMat);
    this.pillar.frustumCulled = false;
    this.group.add(this.pillar);
    this.disposables.push(pGeo, pMat);

    const rGeo = new THREE.RingGeometry(PILLAR_RADIUS * 0.8, PILLAR_RADIUS, 28);
    rGeo.rotateX(-Math.PI / 2);
    const rMat = new THREE.MeshBasicMaterial({
      color: GUIDE_COLOR, transparent: true, opacity: 0.75, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(rGeo, rMat);
    this.ring.frustumCulled = false;
    this.group.add(this.ring);
    this.disposables.push(rGeo, rMat);
  }

  /** 목표 `Interactable.id` (null = 안내선 끄기). */
  setTarget(id: string | null): void {
    if (this.targetId === id) return;
    this.targetId = id;
    this.timer = 0;
    if (!id) this.unmount();
  }

  update(dt: number): void {
    if (!this.targetId) return;
    this.time += dt * GUIDE_FLOW;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = RETARGET_INTERVAL;
      this.target = this.resolve();
    }
    const player = this.ctx.player;
    if (!this.target || !player) { this.unmount(); return; }
    _from.copy(player.position); _from.y = GUIDE_LIFT;
    _to.copy(this.target); _to.y = GUIDE_LIFT;
    const len = _from.distanceTo(_to);
    if (len < GUIDE_ARRIVE) { this.unmount(); return; }   // 다 왔으면 걷어 준다
    this.mount();

    // 띠: 시작점에 놓고 목표를 향해 회전 + 길이만큼 스케일
    this.line.position.copy(_from);
    this.line.rotation.set(0, Math.atan2(_to.x - _from.x, _to.z - _from.z) - Math.PI / 2, 0);
    this.line.scale.set(len, 1, 1);
    this.lineMat.uniforms.uLength.value = len;
    this.lineMat.uniforms.uTime.value = this.time;

    // 빛기둥: 목표 위, 천천히 도는 링
    _mid.copy(this.target); _mid.y = 0.02;
    this.pillar.position.set(this.target.x, 0.02, this.target.z);
    this.ring.position.copy(_mid);
    this.ring.rotation.y += dt * 0.6;
    const pulse = 0.55 + 0.45 * Math.sin(this.time * 1.6);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.4 * pulse;
  }

  private resolve(): THREE.Vector3 | null {
    if (!this.targetId) return null;
    const it = this.ctx.interactables.all().find((i) => i.id === this.targetId);
    return it ? it.position : null;
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.ctx.scene.add(this.group);
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.ctx.scene.remove(this.group);
  }

  /** 스모크 / 디버그. */
  get visible(): boolean { return this.mounted; }
  get targetPosition(): THREE.Vector3 | null { return this.mounted ? this.target : null; }

  dispose(): void {
    this.unmount();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
