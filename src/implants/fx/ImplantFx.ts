import * as THREE from 'three';
import { Layers } from '@/shared';

/**
 * Pooled, allocation-free FX shared by every implant: energy beams (grapple wire, overcharge beam),
 * expanding shells (scan pulse), blasts (rocket detonation), streaks (dash trail, rocket trail) and
 * hit sparks (barrier impacts).
 *
 * No lights are ever created — the scene light count must stay constant (a changed light count
 * recompiles every lit shader, see CLAUDE.md). Brightness comes from additive `MeshBasicMaterial`.
 */

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Unit cylinder along +Y with its base at the origin — scale.y = length. */
function beamGeometry(): THREE.CylinderGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

/**
 * A single persistent beam between two points (grapple wire, overcharge beam). Owns its material so the
 * colour / opacity can pulse per instance; the geometry is shared with the pool that created it.
 */
export class BeamMesh {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(geo: THREE.BufferGeometry, color: number, opacity: number, private readonly thickness: number) {
    this.mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.enable(Layers.NO_RAYCAST);
  }

  setFromTo(a: THREE.Vector3, b: THREE.Vector3, thicknessMul = 1): void {
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) { this.mesh.visible = false; return; }
    _dir.divideScalar(len);
    this.mesh.position.copy(a);
    _q.setFromUnitVectors(UP, _dir);
    this.mesh.quaternion.copy(_q);
    const t = this.thickness * thicknessMul;
    this.mesh.scale.set(t, len, t);
    this.mesh.visible = true;
  }

  setOpacity(o: number): void { this.mat.opacity = o; }
  setColor(hex: number): void { this.mat.color.setHex(hex); }
  hide(): void { this.mesh.visible = false; }
  dispose(): void { this.mesh.removeFromParent(); this.mat.dispose(); }
}

interface Timed { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; dur: number; from: number; to: number }

const PULSES = 8;
const BLASTS = 6;
const STREAKS = 20;
const SPARKS = 24;

export class ImplantFx {
  readonly group = new THREE.Group();

  private readonly shellGeo = new THREE.SphereGeometry(1, 20, 12);
  private readonly ringGeo = new THREE.RingGeometry(0.82, 1, 40);
  private readonly beamGeo = beamGeometry();
  private readonly sparkGeo = new THREE.OctahedronGeometry(1, 0);

  private readonly pulses: Timed[] = [];
  private readonly pulseRings: Timed[] = [];
  private readonly blasts: Timed[] = [];
  private readonly blastRings: Timed[] = [];
  private readonly streaks: Timed[] = [];
  private readonly sparks: Timed[] = [];

  constructor(scene: THREE.Scene) {
    this.group.name = 'ImplantFx';
    this.ringGeo.rotateX(-Math.PI / 2);
    const mk = (geo: THREE.BufferGeometry, color: number, side: THREE.Side): Timed => {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0, depthWrite: false, side,
        blending: THREE.AdditiveBlending, toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.layers.enable(Layers.NO_RAYCAST);
      this.group.add(mesh);
      return { mesh, mat, t: 0, dur: 0, from: 0, to: 0 };
    };
    for (let i = 0; i < PULSES; i++) {
      this.pulses.push(mk(this.shellGeo, 0x7cf07a, THREE.BackSide));
      this.pulseRings.push(mk(this.ringGeo, 0x7cf07a, THREE.DoubleSide));
    }
    for (let i = 0; i < BLASTS; i++) {
      this.blasts.push(mk(this.shellGeo, 0xffa040, THREE.FrontSide));
      this.blastRings.push(mk(this.ringGeo, 0xffc060, THREE.DoubleSide));
    }
    for (let i = 0; i < STREAKS; i++) this.streaks.push(mk(this.beamGeo, 0xffffff, THREE.DoubleSide));
    for (let i = 0; i < SPARKS; i++) this.sparks.push(mk(this.sparkGeo, 0x9fe8ff, THREE.FrontSide));
    scene.add(this.group);
  }

  /** Shared geometry for persistent beams (grapple wire, overcharge beam). */
  makeBeam(color: number, opacity: number, thickness: number): BeamMesh {
    const b = new BeamMesh(this.beamGeo, color, opacity, thickness);
    this.group.add(b.mesh);
    return b;
  }

  /** Expanding hollow shell + ground ring — the 정찰 pulse. */
  pulse(center: THREE.Vector3, radius: number, duration: number, color: number, groundY?: number): void {
    const s = this.take(this.pulses);
    s.mesh.position.copy(center);
    s.mat.color.setHex(color);
    s.t = 0; s.dur = duration; s.from = 0.4; s.to = radius;
    s.mesh.visible = true;
    const r = this.take(this.pulseRings);
    r.mesh.position.set(center.x, (groundY ?? center.y) + 0.08, center.z);
    r.mat.color.setHex(color);
    r.t = 0; r.dur = duration; r.from = 0.4; r.to = radius;
    r.mesh.visible = true;
  }

  /** Rocket detonation: bright expanding sphere + shockwave ring. */
  blast(center: THREE.Vector3, radius: number, groundY?: number): void {
    const s = this.take(this.blasts);
    s.mesh.position.copy(center);
    s.t = 0; s.dur = 0.45; s.from = radius * 0.15; s.to = radius;
    s.mesh.visible = true;
    const r = this.take(this.blastRings);
    r.mesh.position.set(center.x, (groundY ?? center.y - 0.4) + 0.1, center.z);
    r.t = 0; r.dur = 0.6; r.from = radius * 0.2; r.to = radius * 1.7;
    r.mesh.visible = true;
    // a few debris streaks
    for (let i = 0; i < 4; i++) {
      _s1.copy(center);
      _s2.set(Math.random() * 2 - 1, Math.random() * 0.8 + 0.2, Math.random() * 2 - 1).normalize()
        .multiplyScalar(radius * (0.6 + Math.random() * 0.6)).add(center);
      this.streak(_s1, _s2, 0xffb060, 0.35, 0.12);
    }
  }

  /** Fading straight streak (dash trail, rocket trail, remote wire flash). */
  streak(a: THREE.Vector3, b: THREE.Vector3, color: number, duration: number, thickness: number): void {
    const s = this.take(this.streaks);
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    s.mesh.position.copy(a);
    _q.setFromUnitVectors(UP, _dir);
    s.mesh.quaternion.copy(_q);
    s.mesh.scale.set(thickness, len, thickness);
    s.mat.color.setHex(color);
    s.t = 0; s.dur = duration; s.from = -1; s.to = -1;   // scale is fixed, only opacity fades
    s.mesh.visible = true;
  }

  /** Small impact flash (barrier block, wire anchor). */
  spark(point: THREE.Vector3, color: number, size = 0.35): void {
    const s = this.take(this.sparks);
    s.mesh.position.copy(point);
    s.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    s.mat.color.setHex(color);
    s.t = 0; s.dur = 0.28; s.from = size; s.to = size * 2.4;
    s.mesh.visible = true;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.step(this.pulses, dt, 0.55);
    this.step(this.pulseRings, dt, 0.7);
    this.step(this.blasts, dt, 1);
    this.step(this.blastRings, dt, 0.8);
    this.step(this.streaks, dt, 0.9);
    this.step(this.sparks, dt, 1);
  }

  clear(): void {
    for (const list of [this.pulses, this.pulseRings, this.blasts, this.blastRings, this.streaks, this.sparks]) {
      for (const s of list) { s.mesh.visible = false; s.dur = 0; s.mat.opacity = 0; }
    }
  }

  dispose(): void {
    this.clear();
    for (const list of [this.pulses, this.pulseRings, this.blasts, this.blastRings, this.streaks, this.sparks]) {
      for (const s of list) { s.mesh.removeFromParent(); s.mat.dispose(); }
      list.length = 0;
    }
    this.shellGeo.dispose(); this.ringGeo.dispose(); this.beamGeo.dispose(); this.sparkGeo.dispose();
    this.group.removeFromParent();
  }

  private take(list: Timed[]): Timed {
    let best = list[0];
    let bestLeft = Infinity;
    for (const s of list) {
      if (!s.mesh.visible) return s;
      const left = s.dur - s.t;
      if (left < bestLeft) { bestLeft = left; best = s; }
    }
    return best;
  }

  private step(list: Timed[], dt: number, peak: number): void {
    for (const s of list) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      const k = s.dur > 0 ? Math.min(1, s.t / s.dur) : 1;
      if (k >= 1) { s.mesh.visible = false; s.mat.opacity = 0; continue; }
      if (s.from >= 0) {
        const r = s.from + (s.to - s.from) * (1 - (1 - k) * (1 - k));   // ease-out
        s.mesh.scale.setScalar(Math.max(1e-3, r));
      }
      s.mat.opacity = peak * (1 - k) * (1 - k);
    }
  }
}
