import * as THREE from 'three';
import { IMPLANT_BARRIER_CARRY_WIDTH, Layers, type ImplantId } from '@/shared';
import { implantHex } from '../ImplantDefs';

/**
 * Procedural hand-held device for a wielded implant (갈고리 / 오버차지 / 정찰 / 대전차포).
 * Parented to the player's weapon socket (or a remote avatar's), so the local convention applies:
 * the device points along **-Z** and `muzzle` sits at its tip.
 *
 * Everything is built from primitives — no external assets, no lights (an emissive core + additive
 * glow disc stands in for one).
 */
export class ImplantDevice {
  readonly root = new THREE.Group();
  /** Tip of the device in device space; world position via `muzzle.matrixWorld`. */
  readonly muzzle = new THREE.Object3D();

  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly glow: THREE.Mesh[] = [];
  private readonly accentMat: THREE.MeshStandardMaterial;
  private phase = 0;
  /** 0..1 charge/energy readout driving the glow brightness. */
  private energy = 1;

  constructor(readonly id: ImplantId) {
    const hex = implantHex(id);
    const shell = this.mat(new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.55, metalness: 0.65 }));
    const dark = this.mat(new THREE.MeshStandardMaterial({ color: 0x14181d, roughness: 0.8, metalness: 0.3 }));
    this.accentMat = this.mat(new THREE.MeshStandardMaterial({
      color: hex, emissive: hex, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.2,
    })) as THREE.MeshStandardMaterial;

    this.root.name = `Implant:${id}`;
    switch (id) {
      case 'grapple': this.buildGrapple(shell, dark); break;
      case 'overcharge': this.buildOvercharge(shell, dark); break;
      case 'scan': this.buildScanner(shell, dark); break;
      case 'atlauncher': this.buildLauncher(shell, dark); break;
      case 'barrier': this.buildShieldGrip(shell, dark); break;
      default: this.buildScanner(shell, dark); break;   // instant implants have no device; harmless fallback
    }
    this.root.add(this.muzzle);
    this.root.traverse((o) => { o.layers.enable(Layers.NO_RAYCAST); });
  }

  /** Idle animation: slow energy pulse on the accent parts. */
  update(dt: number, energy01: number): void {
    this.phase += dt * 2.4;
    this.energy += (energy01 - this.energy) * Math.min(1, dt * 6);
    const p = 0.7 + 0.3 * Math.sin(this.phase);
    const e = 0.25 + this.energy * 1.5 * p;
    this.accentMat.emissiveIntensity = e;
    for (const g of this.glow) {
      const m = g.material as THREE.MeshBasicMaterial;
      m.opacity = 0.18 + this.energy * 0.5 * p;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.geos.length = 0; this.mats.length = 0; this.glow.length = 0;
  }

  /* ─────────────────────────── builders ─────────────────────────── */
  private buildGrapple(shell: THREE.Material, dark: THREE.Material): void {
    this.add(this.geo(new THREE.BoxGeometry(0.11, 0.13, 0.34)), shell, 0, 0, -0.06);
    this.add(this.geo(new THREE.BoxGeometry(0.07, 0.15, 0.07)), dark, 0, -0.12, 0.04);
    // launcher barrel + harpoon head
    this.add(this.geo(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 10)), shell, 0, 0.02, -0.3, Math.PI / 2);
    this.add(this.geo(new THREE.ConeGeometry(0.05, 0.13, 8)), this.accentMat, 0, 0.02, -0.46, -Math.PI / 2);
    // spool
    this.add(this.geo(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12)), dark, 0.075, 0.06, -0.05, 0, 0, Math.PI / 2);
    this.addGlow(0.05, 0, 0.09, -0.14);
    this.muzzle.position.set(0, 0.02, -0.52);
  }

  private buildOvercharge(shell: THREE.Material, dark: THREE.Material): void {
    this.add(this.geo(new THREE.BoxGeometry(0.1, 0.12, 0.3)), shell, 0, 0, -0.04);
    this.add(this.geo(new THREE.BoxGeometry(0.07, 0.15, 0.07)), dark, 0, -0.12, 0.05);
    // three emitter prongs around the core
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const g = this.geo(new THREE.CylinderGeometry(0.016, 0.022, 0.24, 6));
      const m = new THREE.Mesh(g, shell);
      m.position.set(Math.cos(a) * 0.055, 0.02 + Math.sin(a) * 0.055, -0.3);
      m.rotation.x = Math.PI / 2;
      this.root.add(m);
    }
    this.add(this.geo(new THREE.SphereGeometry(0.045, 12, 8)), this.accentMat, 0, 0.02, -0.34);
    this.addGlow(0.09, 0, 0.02, -0.34);
    this.muzzle.position.set(0, 0.02, -0.42);
  }

  private buildScanner(shell: THREE.Material, dark: THREE.Material): void {
    this.add(this.geo(new THREE.BoxGeometry(0.13, 0.13, 0.22)), shell, 0, 0, -0.02);
    this.add(this.geo(new THREE.BoxGeometry(0.07, 0.14, 0.07)), dark, 0, -0.12, 0.04);
    // dish + emitter ring
    this.add(this.geo(new THREE.CylinderGeometry(0.13, 0.09, 0.05, 16)), dark, 0, 0.01, -0.17, Math.PI / 2);
    this.add(this.geo(new THREE.TorusGeometry(0.1, 0.014, 6, 20)), this.accentMat, 0, 0.01, -0.2);
    this.addGlow(0.12, 0, 0.01, -0.21);
    this.muzzle.position.set(0, 0.01, -0.24);
  }

  /**
   * 배리어 방패 (Phase 10): only the **hand hardware** — grip, forearm brace and the projector frame.
   * The blocking surface itself is `effects/Barrier.BarrierField`, which follows the carrier in world space,
   * so nothing here may pretend to be the panel.
   */
  private buildShieldGrip(shell: THREE.Material, dark: THREE.Material): void {
    // grip in the fist + forearm brace running back along the arm
    this.add(this.geo(new THREE.BoxGeometry(0.055, 0.15, 0.055)), dark, 0, -0.1, 0.02);
    this.add(this.geo(new THREE.BoxGeometry(0.09, 0.06, 0.26)), shell, 0, -0.02, 0.05);
    // projector head: a short block with an emitter bar the field springs from. Phase 12: the bar and the frame arms
    // scale with the carry width (1.5 m → 0.3 m bar; 3.2 m → ~0.45 m) so the wide panel visibly comes out of it.
    const bar = Math.min(0.6, IMPLANT_BARRIER_CARRY_WIDTH * 0.14);
    this.add(this.geo(new THREE.BoxGeometry(0.16, 0.1, 0.1)), shell, 0, 0.02, -0.14);
    this.add(this.geo(new THREE.BoxGeometry(bar, 0.035, 0.035)), this.accentMat, 0, 0.06, -0.2);
    // two stubby arms suggesting the frame the panel unfolds from
    for (const sx of [-1, 1]) {
      this.add(this.geo(new THREE.BoxGeometry(0.03, 0.03, 0.14)), shell, sx * (bar / 2 - 0.01), 0.04, -0.13);
    }
    this.addGlow(0.1, 0, 0.04, -0.22);
    this.muzzle.position.set(0, 0.04, -0.24);
  }

  private buildLauncher(shell: THREE.Material, dark: THREE.Material): void {
    this.add(this.geo(new THREE.CylinderGeometry(0.075, 0.075, 0.95, 12, 1, true)), shell, 0, 0.03, -0.2, Math.PI / 2);
    this.add(this.geo(new THREE.CylinderGeometry(0.085, 0.095, 0.12, 12)), dark, 0, 0.03, -0.64, Math.PI / 2);
    this.add(this.geo(new THREE.BoxGeometry(0.07, 0.14, 0.07)), dark, 0, -0.09, 0.02);
    this.add(this.geo(new THREE.BoxGeometry(0.05, 0.05, 0.16)), dark, 0.02, 0.12, -0.12);   // sight
    this.add(this.geo(new THREE.TorusGeometry(0.06, 0.012, 6, 16)), this.accentMat, 0, 0.03, -0.62);
    this.addGlow(0.09, 0, 0.03, -0.62);
    this.muzzle.position.set(0, 0.03, -0.72);
  }

  /* ─────────────────────────── helpers ─────────────────────────── */
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g; }
  private mat<T extends THREE.Material>(m: T): T { this.mats.push(m); return m; }

  private add(g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = false;
    this.root.add(mesh);
    return mesh;
  }

  /** Additive disc standing in for a light (light counts must never change at runtime). */
  private addGlow(size: number, x: number, y: number, z: number): void {
    const g = this.geo(new THREE.CircleGeometry(size, 14));
    const m = this.mat(new THREE.MeshBasicMaterial({
      color: implantHex(this.id), transparent: true, opacity: 0.35, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    this.root.add(mesh);
    this.glow.push(mesh);
  }
}
