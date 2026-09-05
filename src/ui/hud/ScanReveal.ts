import * as THREE from 'three';
import type { GameContext, ScanTarget } from '@/shared';
import { DETECT_HIGHLIGHT_COLOR, DETECT_ENEMY_COLOR, IMPLANT_SCAN_REVEAL_TIME } from '@/shared';

const MAX_REVEALS = 64;
/** Shell radius (m) per revealed kind. */
const KIND_SCALE: Record<ScanTarget['kind'], number> = {
  enemy: 1.15, crate: 0.95, pickup: 0.55, gather: 0.6, objective: 1.6, deployable: 1.1,
};

const VERT = `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);
  gl_FragColor = vec4(uColor, rim * uOpacity);
}`;

interface Reveal {
  key: string;
  kind: ScanTarget['kind'];
  position: THREE.Vector3;
  object: THREE.Object3D | null;
  expires: number;
}

/**
 * Through-wall outlines for scan results (`implant:scanned`) and any other `detect:reveal` command.
 *
 * Each revealed object gets a pooled fresnel shell drawn with `depthTest: false` (so it reads through
 * geometry) for the requested duration — 10 s for the 정찰 implant. Targets that came with an `object`
 * follow it, so revealed enemies keep their outline while they move. Pool: `MAX_REVEALS` meshes,
 * two shared materials (enemy red / everything else cyan); nothing is allocated per frame.
 */
export class ScanReveal {
  private ctx!: GameContext;
  private reveals: Reveal[] = [];
  private group: THREE.Group | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private matNeutral: THREE.ShaderMaterial | null = null;
  private matEnemy: THREE.ShaderMaterial | null = null;
  private meshes: THREE.Mesh[] = [];
  private unsubs: Array<() => void> = [];

  bind(ctx: GameContext): void {
    this.ctx = ctx;
    const b = ctx.bus;
    this.unsubs.push(
      b.on('detect:reveal', ({ targets, duration }) => this.add(targets, duration)),
      b.on('implant:scanned', ({ targets, duration }) => this.add(targets, duration)),
      b.on('detect:clear', () => this.clear()),
      b.on('game:abort', () => this.teardown()),
      b.on('game:newMission', () => this.teardown()),
      b.on('player:died', () => this.clear()),
    );
  }

  private ensureScene(): void {
    if (this.group) return;
    this.geo = new THREE.IcosahedronGeometry(1, 2);
    const make = (hex: number): THREE.ShaderMaterial => new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(hex) }, uOpacity: { value: 0.8 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.matNeutral = make(DETECT_HIGHLIGHT_COLOR);
    this.matEnemy = make(DETECT_ENEMY_COLOR);
    this.group = new THREE.Group();
    this.group.name = 'scan-reveals';
    this.group.renderOrder = 999;
    for (let i = 0; i < MAX_REVEALS; i++) {
      const m = new THREE.Mesh(this.geo, this.matNeutral);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 999;
      this.group.add(m);
      this.meshes.push(m);
    }
    this.ctx.scene.add(this.group);
  }

  private add(targets: readonly ScanTarget[] | undefined, duration: number): void {
    if (!targets || targets.length === 0) return;
    const dur = duration > 0 ? duration : IMPLANT_SCAN_REVEAL_TIME;
    const expires = this.ctx.time + dur;
    for (const t of targets) {
      const key = `${t.kind}:${t.id}`;
      const existing = this.reveals.find((r) => r.key === key);
      if (existing) {
        existing.expires = Math.max(existing.expires, expires);
        existing.position.copy(t.position);
        existing.object = t.object ?? existing.object;
        continue;
      }
      if (this.reveals.length >= MAX_REVEALS) this.reveals.shift();
      this.reveals.push({ key, kind: t.kind, position: t.position.clone(), object: t.object ?? null, expires });
    }
    this.ensureScene();
  }

  private clear(): void {
    this.reveals.length = 0;
    for (const m of this.meshes) m.visible = false;
  }

  private teardown(): void {
    this.clear();
    if (this.group) {
      this.ctx.scene.remove(this.group);
      this.group.clear();
      this.group = null;
    }
    this.meshes.length = 0;
    this.geo?.dispose(); this.geo = null;
    this.matNeutral?.dispose(); this.matNeutral = null;
    this.matEnemy?.dispose(); this.matEnemy = null;
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    if (this.reveals.length === 0) return;
    const t = ctx.time;
    for (let i = this.reveals.length - 1; i >= 0; i--) {
      if (t >= this.reveals[i].expires) this.reveals.splice(i, 1);
    }
    if (this.reveals.length === 0) { this.clear(); return; }
    this.ensureScene();
    const pulse = 0.55 + 0.3 * Math.sin(t * 4);
    if (this.matNeutral) this.matNeutral.uniforms.uOpacity.value = pulse;
    if (this.matEnemy) this.matEnemy.uniforms.uOpacity.value = pulse * 1.15;

    const n = Math.min(this.reveals.length, this.meshes.length);
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (i >= n) { if (m.visible) m.visible = false; continue; }
      const r = this.reveals[i];
      if (r.object) r.object.getWorldPosition(r.position);
      m.position.copy(r.position);
      m.position.y += 0.5;
      const s = KIND_SCALE[r.kind] ?? 0.9;
      m.scale.setScalar(s);
      const mat = r.kind === 'enemy' ? this.matEnemy : this.matNeutral;
      if (mat && m.material !== mat) m.material = mat;
      if (!m.visible) m.visible = true;
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.teardown();
  }
}
