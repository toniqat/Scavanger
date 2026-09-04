import * as THREE from 'three';
import type { WeaponDef } from '@/shared';
import { damp, easeOutCubic } from '@/core/util/MathUtil';
import { kindOf, type WeaponKind } from './WeaponDefaults';

const GUNMETAL = 0x2b3038;
const STEEL = 0x6a7280;
const ACCENT = 0xf2b632;
const DARK = 0x14171c;
const WOOD = 0x5a3a24;

/**
 * Procedural weapon meshes. Origin = grip (sits in the hand socket), barrel points -Z.
 * Exposes `muzzle` and `ejectPort` sockets plus recoil / reload / draw animation.
 */
export class WeaponModel {
  readonly root = new THREE.Group();
  readonly muzzle = new THREE.Object3D();
  readonly ejectPort = new THREE.Object3D();
  readonly kind: WeaponKind;
  private readonly body = new THREE.Group();
  private readonly mag: THREE.Object3D | null = null;
  private magBase = new THREE.Vector3();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private glowMat: THREE.MeshStandardMaterial | null = null;
  private kickZ = 0;
  private kickRot = 0;
  private reloadT = -1;
  private drawT = 1;

  constructor(def: WeaponDef) {
    this.kind = kindOf(def);
    this.root.name = `Weapon:${def.id}`;
    this.root.add(this.body);
    const mMetal = this.mat(GUNMETAL, 0.85, 0.4);
    const mSteel = this.mat(STEEL, 0.9, 0.3);
    const mAccent = this.mat(ACCENT, 0.4, 0.5);
    const mDark = this.mat(DARK, 0.5, 0.7);

    switch (this.kind) {
      case 'pistol': this.mag = this.buildPistol(mMetal, mSteel, mAccent, mDark); break;
      case 'shotgun': this.mag = this.buildShotgun(mMetal, mSteel, mAccent, mDark); break;
      case 'energy': this.mag = this.buildEnergy(mMetal, mSteel, mAccent, mDark); break;
      default: this.mag = this.buildRifle(mMetal, mSteel, mAccent, mDark);
    }
    if (this.mag) this.magBase.copy(this.mag.position);
    this.body.add(this.muzzle, this.ejectPort);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  }

  /* ─────────── builders ─────────── */
  private mat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(m);
    return m;
  }
  private box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.body): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d); this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  /** cylinder along -Z (length d) */
  private tube(r: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.body): THREE.Mesh {
    const g = new THREE.CylinderGeometry(r, r, d, 12); this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.rotation.x = Math.PI / 2; mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }

  private buildRifle(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    this.box(0.05, 0.085, 0.38, mMetal, 0, 0.065, -0.13);                 // receiver
    this.box(0.052, 0.02, 0.3, mDark, 0, 0.115, -0.17);                    // top rail
    this.box(0.045, 0.06, 0.24, mDark, 0, 0.055, -0.44);                   // handguard
    this.box(0.02, 0.02, 0.24, mAccent, 0.03, 0.06, -0.44);                // accent stripe
    this.tube(0.013, 0.34, mSteel, 0, 0.075, -0.6);                        // barrel
    this.tube(0.02, 0.06, mDark, 0, 0.075, -0.78);                          // muzzle brake
    this.box(0.045, 0.07, 0.22, mMetal, 0, 0.05, 0.16);                    // stock
    this.box(0.05, 0.1, 0.04, mDark, 0, 0.01, 0.27);                       // stock butt
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01);       // pistol grip
    grip.rotation.x = -0.25;
    this.box(0.03, 0.05, 0.03, mDark, 0, 0.0, -0.4);                       // foregrip
    // optic
    this.box(0.03, 0.035, 0.09, mDark, 0, 0.145, -0.16);
    const glow = this.mat(0x113344, 0.2, 0.5); glow.emissive.setHex(0x40d0ff); glow.emissiveIntensity = 1.5;
    this.box(0.02, 0.02, 0.005, glow, 0, 0.145, -0.115);
    // magazine (animated)
    const mag = new THREE.Object3D(); mag.position.set(0, 0.01, -0.09); this.body.add(mag);
    const magMesh = this.box(0.03, 0.16, 0.065, mMetal, 0, -0.08, 0, mag); magMesh.rotation.x = 0.12;
    this.box(0.032, 0.02, 0.067, mAccent, 0, -0.15, -0.01, mag);
    this.muzzle.position.set(0, 0.075, -0.81);
    this.ejectPort.position.set(0.04, 0.08, -0.1);
    return mag;
  }

  private buildPistol(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    this.box(0.032, 0.04, 0.2, mSteel, 0, 0.045, -0.06);                  // slide
    this.box(0.034, 0.012, 0.12, mAccent, 0, 0.068, -0.08);                // slide serration/accent
    this.box(0.03, 0.03, 0.16, mMetal, 0, 0.015, -0.04);                   // frame
    this.tube(0.008, 0.04, mDark, 0, 0.045, -0.17);                        // barrel tip
    const grip = this.box(0.03, 0.1, 0.045, mDark, 0, -0.04, 0.02); grip.rotation.x = -0.3;
    this.box(0.012, 0.03, 0.006, mDark, 0, 0.085, 0.02);                   // rear sight
    this.box(0.006, 0.02, 0.006, mDark, 0, 0.08, -0.15);                   // front sight
    this.box(0.02, 0.04, 0.01, mDark, 0, -0.005, -0.05);                   // trigger guard
    const mag = new THREE.Object3D(); mag.position.set(0, -0.09, 0.03); this.body.add(mag);
    this.box(0.026, 0.05, 0.04, mMetal, 0, -0.01, 0, mag);
    this.box(0.028, 0.01, 0.042, mAccent, 0, -0.035, 0, mag);
    this.muzzle.position.set(0, 0.045, -0.19);
    this.ejectPort.position.set(0.025, 0.06, -0.05);
    return mag;
  }

  private buildShotgun(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const mWood = this.mat(WOOD, 0.1, 0.8);
    this.box(0.055, 0.09, 0.3, mMetal, 0, 0.06, -0.1);                     // receiver
    this.tube(0.018, 0.5, mSteel, 0, 0.09, -0.5);                          // barrel
    this.tube(0.02, 0.4, mMetal, 0, 0.045, -0.45);                         // tube magazine
    this.box(0.05, 0.05, 0.16, mWood, 0, 0.045, -0.32);                    // pump
    this.box(0.05, 0.02, 0.16, mAccent, 0, 0.075, -0.32);
    this.box(0.05, 0.08, 0.26, mWood, 0, 0.045, 0.18);                     // stock
    this.box(0.052, 0.1, 0.04, mDark, 0, 0.03, 0.31);
    const grip = this.box(0.04, 0.1, 0.05, mDark, 0, -0.04, 0.02); grip.rotation.x = -0.3;
    this.box(0.012, 0.02, 0.01, mAccent, 0, 0.115, -0.72);                 // bead sight
    const mag = new THREE.Object3D(); mag.position.set(0, 0.0, -0.2); this.body.add(mag); // shells (invisible anim anchor)
    this.muzzle.position.set(0, 0.09, -0.76);
    this.ejectPort.position.set(0.04, 0.07, -0.08);
    return mag;
  }

  private buildEnergy(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const glow = this.mat(0x102838, 0.3, 0.4); glow.emissive.setHex(0x38c8ff); glow.emissiveIntensity = 2.2;
    this.glowMat = glow;
    this.box(0.06, 0.1, 0.42, mMetal, 0, 0.065, -0.14);                    // body
    this.box(0.07, 0.03, 0.3, mDark, 0, 0.125, -0.15);
    this.box(0.03, 0.03, 0.3, glow, 0, 0.09, -0.4);                        // glowing rail
    this.tube(0.028, 0.32, mSteel, 0, 0.07, -0.55);                        // emitter housing
    this.tube(0.02, 0.04, glow, 0, 0.07, -0.72);                            // emitter lens
    this.box(0.05, 0.07, 0.2, mMetal, 0, 0.05, 0.16);                      // stock
    this.box(0.02, 0.02, 0.2, mAccent, 0.035, 0.06, 0.16);
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01); grip.rotation.x = -0.25;
    const mag = new THREE.Object3D(); mag.position.set(0, 0.02, -0.08); this.body.add(mag);
    this.box(0.04, 0.12, 0.08, glow, 0, -0.06, 0, mag);                    // energy cell
    this.muzzle.position.set(0, 0.07, -0.75);
    this.ejectPort.position.set(0.04, 0.09, -0.1);
    return mag;
  }

  /* ─────────── animation ─────────── */
  kick(strength = 1): void {
    this.kickZ = Math.min(0.12, this.kickZ + 0.045 * strength);
    this.kickRot = Math.min(0.5, this.kickRot + 0.12 * strength);
  }
  /** progress 0..1 while reloading, -1 when idle */
  setReload(progress: number): void { this.reloadT = progress; }
  /** 0 = holstered, 1 = drawn */
  setDraw(progress: number): void { this.drawT = progress; }

  update(dt: number, time: number): void {
    this.kickZ = damp(this.kickZ, 0, 16, dt);
    this.kickRot = damp(this.kickRot, 0, 14, dt);
    // draw / holster: swing up from below
    const d = easeOutCubic(this.drawT);
    this.root.visible = this.drawT > 0.02;
    this.body.position.set(0, -0.25 * (1 - d), 0.1 * (1 - d) + this.kickZ);
    let rx = -1.3 * (1 - d) + this.kickRot;
    let rz = 0;
    if (this.reloadT >= 0 && this.mag) {
      const t = this.reloadT;
      rz = Math.sin(Math.min(1, t * 1.15) * Math.PI) * 0.45;   // cant the weapon toward the player
      rx += Math.sin(t * Math.PI) * -0.25;
      const m = this.mag;
      if (t < 0.38) {           // mag drops out
        const k = t / 0.38;
        m.visible = true;
        m.position.set(this.magBase.x, this.magBase.y - k * k * 0.45, this.magBase.z + k * 0.08);
        m.rotation.x = k * 0.9;
      } else if (t < 0.55) {    // gone
        m.visible = false;
      } else {                  // new mag slides in
        const k = Math.min(1, (t - 0.55) / 0.3);
        const e = easeOutCubic(k);
        m.visible = true;
        m.position.set(this.magBase.x, this.magBase.y - (1 - e) * 0.3, this.magBase.z);
        m.rotation.x = (1 - e) * 0.4;
      }
    } else if (this.mag) {
      this.mag.visible = true;
      this.mag.position.copy(this.magBase);
      this.mag.rotation.x = 0;
    }
    this.body.rotation.set(rx, 0, rz);
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.8 + Math.sin(time * 5) * 0.4;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
