import * as THREE from 'three';
import type { GameContext } from '@/shared';
import { TUTORIAL_STEP_DELAY_S } from '@/shared';
import {
  GUIDE_ARRIVE, GUIDE_COLOR, GUIDE_DASH, GUIDE_FLOW, GUIDE_GAP, GUIDE_LIFT, GUIDE_WIDTH,
  PILLAR_HEIGHT, PILLAR_RADIUS, RETARGET_INTERVAL,
} from '../model';

/* ────────────────────────────────────────────────────────────────────────────
 * src/tutorial/parts/Guide.ts — **the floor guide** (a flowing dashed strip + the target pillar).
 *
 * The target is given as an `Interactable.id` (`hub_terminal` · `hub_pod_0` · `hub_furn_<uid>`) — `ctx.interactables`
 * alone then yields the coordinates, with no knowledge of the room layout or where the furniture stands.
 *
 * The line is one thin strip (`PlaneGeometry`) laying the straight **player → target** line at `GUIDE_LIFT` above the
 * floor, and the dashes are drawn by a **shader**, not by geometry: the lengthwise UV is converted back into real
 * metres, cut with `fract()` and pushed along by `uTime`, so the dashes flow towards the target. Dashes as meshes
 * would mean new geometry every time the path changes; this way only two uniforms are updated (zero allocation per
 * frame).
 *
 * At the target stand a translucent cylindrical pillar + a floor ring. Both are `depthWrite: false`, so overlapping
 * each other does not break them. Being visible through walls is intended — the floor guide is a thing that says
 * "it is over there", not a line-of-sight test.
 *
 * Every geometry · material that has to be disposed on a mission reset is collected in `disposables`.
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
 * `uLength` = the strip's real length (m) — used to turn UV.x back into metres. `uTime` makes the dashes flow.
 * The edges (`vUv.y`) are blurred softly, and the closer to the target the brighter, so the direction reads.
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
  /**
   * Time left (s, `TUTORIAL_STEP_DELAY_S`) from a new target being set until the line is laid — it appears late on
   * the same beat as the spotlight (2026-09-09).
   */
  private wait = 0;
  private mounted = false;
  private time = 0;
  /** Last resolved target position (null = the interactable is not registered right now). */
  private target: THREE.Vector3 | null = null;

  constructor(private readonly ctx: GameContext) {
    this.group.name = 'TutorialGuide';
    this.group.renderOrder = 3;

    const geo = new THREE.PlaneGeometry(1, GUIDE_WIDTH, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0.5, 0, 0);              // so the origin is the start point (scale = length)
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

  /** The target `Interactable.id` (null = the floor guide off). */
  setTarget(id: string | null): void {
    if (this.targetId === id) return;
    this.targetId = id;
    this.timer = 0;
    this.wait = TUTORIAL_STEP_DELAY_S;
    this.unmount();                       // the previous target's line is taken down at once, the new one half a beat on
  }

  update(dt: number): void {
    if (!this.targetId) return;
    if (this.wait > 0) { this.wait -= dt; if (this.wait > 0) return; }
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
    if (len < GUIDE_ARRIVE) { this.unmount(); return; }   // on arrival it is taken down
    this.mount();

    // the strip: placed at the start point, rotated towards the target + scaled by the length
    this.line.position.copy(_from);
    this.line.rotation.set(0, Math.atan2(_to.x - _from.x, _to.z - _from.z) - Math.PI / 2, 0);
    this.line.scale.set(len, 1, 1);
    this.lineMat.uniforms.uLength.value = len;
    this.lineMat.uniforms.uTime.value = this.time;

    // the pillar: over the target, with a slowly turning ring
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

  /** Smoke / debug. */
  get visible(): boolean { return this.mounted; }
  get targetPosition(): THREE.Vector3 | null { return this.mounted ? this.target : null; }

  dispose(): void {
    this.unmount();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
