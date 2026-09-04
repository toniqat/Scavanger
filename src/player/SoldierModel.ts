import * as THREE from 'three';
import { damp } from '@/core/util/MathUtil';

/**
 * Per-frame pose parameters driving the procedural animation. All blends are 0..1 unless noted.
 */
export interface SoldierPose {
  /** 0 = standing still, 1 = walking at full walk speed (>1 allowed for sprint) */
  moveBlend: number;
  sprint: number;
  /** radians; one step every π */
  stridePhase: number;
  crouch: number;
  aim: number;
  /** camera pitch in radians (+ = looking up) */
  aimPitch: number;
  /** yaw difference (radians) upper body should twist toward relative to the root facing */
  torsoTwist: number;
  airborne: number;
  /** vertical velocity (m/s) for jump/fall poses */
  verticalVel: number;
  /** hit reaction 0..1 (decays outside) */
  flinch: number;
  hasWeapon: boolean;
  twoHanded: boolean;
  reloading: boolean;
  /** 0..1 recoil impulse (decays outside) */
  recoil: number;
  /** death progress 0..1 (0 = alive) */
  dead: number;
  /** stepping-out / scripted walk: reuse moveBlend */
}

interface Limb {
  upper: THREE.Object3D; lower: THREE.Object3D;
}

const ARMOR = 0x3a4150;      // dark steel / blue-grey plates
const STEEL = 0x7c8796;
const ACCENT = 0xffc23a;     // helldiver yellow
const DARK = 0x22262e;       // undersuit
const CAPE = 0x2e3442;
const VISOR = 0x7fe3ff;

/**
 * Stylised armoured trooper (~1.8 m) built from primitives. Root origin is at the feet, model faces -Z.
 * Joint convention: rotation.x > 0 swings a limb forward (toward -Z).
 */
export class SoldierModel {
  readonly root = new THREE.Group();
  readonly weaponSocket = new THREE.Object3D();
  readonly headPivot = new THREE.Object3D();

  private readonly hips = new THREE.Object3D();
  private readonly torso = new THREE.Object3D();
  private readonly chestMesh: THREE.Mesh;
  private readonly visorMat: THREE.MeshStandardMaterial;
  private readonly armR: Limb; private readonly armL: Limb;
  private readonly legR: Limb; private readonly legL: Limb;
  private readonly capeSegs: THREE.Object3D[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly bodyGroup = new THREE.Group();

  private readonly hipsBaseY = 0.98;

  constructor() {
    this.root.name = 'Soldier';
    // low metalness on purpose: without an environment map, metallic surfaces go black under hemisphere light
    const mArmor = this.mat(ARMOR, 0.35, 0.55);
    const mSteel = this.mat(STEEL, 0.5, 0.45);
    const mAccent = this.mat(ACCENT, 0.2, 0.5);
    const mDark = this.mat(DARK, 0.15, 0.75);
    const mCape = this.mat(CAPE, 0.0, 0.9, THREE.DoubleSide);
    this.visorMat = this.mat(0x102030, 0.6, 0.3) as THREE.MeshStandardMaterial;
    this.visorMat.emissive.setHex(VISOR);
    this.visorMat.emissiveIntensity = 0.9;

    this.root.add(this.bodyGroup);
    this.bodyGroup.add(this.hips);
    this.hips.position.y = this.hipsBaseY;

    // pelvis
    this.hips.add(this.box(0.34, 0.2, 0.24, mArmor, 0, -0.06, 0));
    this.hips.add(this.box(0.36, 0.06, 0.26, mAccent, 0, 0.02, 0)); // belt

    // torso
    this.hips.add(this.torso);
    this.chestMesh = this.box(0.44, 0.5, 0.28, mArmor, 0, 0.33, 0);
    this.torso.add(this.chestMesh);
    this.torso.add(this.box(0.3, 0.32, 0.06, mSteel, 0, 0.36, -0.15));        // chest plate
    this.torso.add(this.box(0.08, 0.26, 0.02, mAccent, -0.1, 0.36, -0.185));  // yellow stripe
    this.torso.add(this.box(0.08, 0.26, 0.02, mAccent, 0.1, 0.36, -0.185));
    this.torso.add(this.box(0.3, 0.38, 0.2, mDark, 0, 0.3, 0.22));            // backpack
    this.torso.add(this.box(0.1, 0.3, 0.1, mSteel, 0.18, 0.34, 0.25));        // canister
    this.torso.add(this.box(0.1, 0.3, 0.1, mSteel, -0.18, 0.34, 0.25));
    // shoulder pads
    for (const s of [-1, 1]) {
      const pad = this.sphere(0.13, mArmor, s * 0.27, 0.52, 0);
      pad.scale.set(1, 0.7, 1);
      this.torso.add(pad);
      this.torso.add(this.box(0.16, 0.03, 0.2, mAccent, s * 0.27, 0.6, 0));
    }

    // head
    this.headPivot.position.set(0, 0.58, 0);
    this.torso.add(this.headPivot);
    this.headPivot.add(this.cyl(0.07, 0.08, 0.08, mDark, 0, 0.04, 0));          // neck
    const helmet = this.sphere(0.145, mArmor, 0, 0.17, 0);
    helmet.scale.set(1, 1.08, 1.05);
    this.headPivot.add(helmet);
    this.headPivot.add(this.box(0.2, 0.06, 0.1, mAccent, 0, 0.29, -0.04));        // crest
    this.headPivot.add(this.box(0.22, 0.07, 0.06, this.visorMat, 0, 0.17, -0.12)); // visor
    this.headPivot.add(this.box(0.26, 0.04, 0.16, mSteel, 0, 0.22, -0.06));       // brim

    // arms
    this.armR = this.makeArm(1, mArmor, mSteel, mDark);
    this.armL = this.makeArm(-1, mArmor, mSteel, mDark);
    // legs
    this.legR = this.makeLeg(1, mArmor, mSteel, mDark, mAccent);
    this.legL = this.makeLeg(-1, mArmor, mSteel, mDark, mAccent);

    // weapon socket in the right hand: weapon -Z aligned with the arm (-Y)
    this.weaponSocket.position.set(0, -0.3, -0.02);
    this.weaponSocket.rotation.set(-Math.PI / 2, 0, 0);
    this.armR.lower.add(this.weaponSocket);

    // cape: 4 hanging segments
    let parent: THREE.Object3D = this.torso;
    let y = 0.56;
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Object3D();
      seg.position.set(0, y, i === 0 ? 0.17 : 0);
      const w = 0.5 - i * 0.04;
      const len = 0.3;
      const plane = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(w, len)), mCape);
      plane.position.y = -len / 2;
      plane.castShadow = true;
      plane.receiveShadow = false;
      seg.add(plane);
      if (i === 3) seg.add(this.box(w, 0.04, 0.01, mAccent, 0, -len + 0.02, 0)); // yellow hem
      parent.add(seg);
      this.capeSegs.push(seg);
      parent = seg;
      y = -len;
    }

    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  }

  /* ─────────────── builders ─────────────── */
  private mat(color: number, metalness: number, roughness: number, side: THREE.Side = THREE.FrontSide): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness, side });
    this.materials.push(m);
    return m;
  }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.geometries.push(g); return g; }
  private box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y, z);
    return mesh;
  }
  private sphere(r: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo(new THREE.SphereGeometry(r, 16, 12)), m);
    mesh.position.set(x, y, z);
    return mesh;
  }
  private cyl(rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(rt, rb, h, 12)), m);
    mesh.position.set(x, y, z);
    return mesh;
  }
  private capsule(r: number, len: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geo(new THREE.CapsuleGeometry(r, len, 4, 10)), m);
    mesh.position.set(x, y, z);
    return mesh;
  }

  private makeArm(side: number, mArmor: THREE.Material, mSteel: THREE.Material, mDark: THREE.Material): Limb {
    const upper = new THREE.Object3D();
    upper.position.set(side * 0.29, 0.5, 0);
    upper.add(this.capsule(0.065, 0.2, mArmor, 0, -0.15, 0));
    const lower = new THREE.Object3D();
    lower.position.set(0, -0.3, 0);
    lower.add(this.capsule(0.055, 0.18, mDark, 0, -0.13, 0));
    lower.add(this.box(0.11, 0.12, 0.12, mSteel, 0, -0.1, 0)); // bracer
    lower.add(this.box(0.08, 0.08, 0.09, mDark, 0, -0.29, 0));  // glove
    upper.add(lower);
    this.torso.add(upper);
    return { upper, lower };
  }

  private makeLeg(side: number, mArmor: THREE.Material, mSteel: THREE.Material, mDark: THREE.Material, mAccent: THREE.Material): Limb {
    const upper = new THREE.Object3D();
    upper.position.set(side * 0.11, -0.05, 0);
    upper.add(this.capsule(0.085, 0.3, mArmor, 0, -0.22, 0));
    upper.add(this.box(0.12, 0.2, 0.08, mSteel, 0, -0.25, -0.08)); // thigh plate
    const lower = new THREE.Object3D();
    lower.position.set(0, -0.47, 0);
    lower.add(this.capsule(0.07, 0.28, mDark, 0, -0.2, 0));
    lower.add(this.box(0.12, 0.26, 0.08, mSteel, 0, -0.2, -0.07)); // shin guard
    lower.add(this.box(0.14, 0.12, 0.3, mDark, 0, -0.4, -0.05));   // boot
    lower.add(this.box(0.15, 0.03, 0.31, mAccent, 0, -0.35, -0.05)); // boot trim
    upper.add(lower);
    this.hips.add(upper);
    return { upper, lower };
  }

  /* ─────────────── animation ─────────────── */
  private static readonly L = 14; // damping lambda for joints

  private j(o: THREE.Object3D, x: number, y: number, z: number, dt: number, lambda = SoldierModel.L): void {
    o.rotation.x = damp(o.rotation.x, x, lambda, dt);
    o.rotation.y = damp(o.rotation.y, y, lambda, dt);
    o.rotation.z = damp(o.rotation.z, z, lambda, dt);
  }

  update(dt: number, time: number, p: SoldierPose): void {
    const dead = p.dead;
    if (dead > 0) { this.poseDead(dt, p); return; }
    if (dt <= 0) return;

    const phi = p.stridePhase;
    const mv = Math.min(1, p.moveBlend);
    const sp = p.sprint;
    const cr = p.crouch;
    const air = p.airborne;
    const aim = p.aim * (p.hasWeapon ? 1 : 0);
    const ground = 1 - air;
    const breathe = Math.sin(time * 1.7);

    // ── hips / root bob
    const bob = (Math.abs(Math.sin(phi)) - 0.5) * (0.045 + 0.03 * sp) * mv * ground;
    const targetHipY = this.hipsBaseY + bob - 0.36 * cr + air * (p.verticalVel > 0 ? 0.05 : -0.02);
    this.hips.position.y = damp(this.hips.position.y, targetHipY, 20, dt);
    const hipRoll = Math.sin(phi) * 0.05 * mv * ground;
    const hipYaw = -Math.sin(phi) * 0.08 * mv * ground * (1 - aim);
    this.j(this.hips, 0, hipYaw, hipRoll, dt, 18);

    // ── legs: walk cycle
    const swing = (0.5 + 0.35 * sp) * mv * ground;
    const kneeAmt = (0.9 + 0.5 * sp) * mv * ground;
    let thighR = Math.sin(phi) * swing;
    let thighL = Math.sin(phi + Math.PI) * swing;
    let kneeR = -kneeAmt * Math.max(0, Math.cos(phi));
    let kneeL = -kneeAmt * Math.max(0, Math.cos(phi + Math.PI));
    // crouch
    thighR += 1.05 * cr; thighL += 1.0 * cr; kneeR -= 1.55 * cr; kneeL -= 1.5 * cr;
    // airborne tuck
    const up = THREE.MathUtils.clamp(p.verticalVel / 8, -1, 1);
    thighR += air * (0.55 + 0.2 * up); thighL += air * (-0.15 + 0.1 * up);
    kneeR += air * (-0.9); kneeL += air * (-0.5);
    this.j(this.legR.upper, thighR, 0, -0.03, dt, 22);
    this.j(this.legL.upper, thighL, 0, 0.03, dt, 22);
    this.j(this.legR.lower, kneeR, 0, 0, dt, 22);
    this.j(this.legL.lower, kneeL, 0, 0, dt, 22);

    // ── torso
    const lean = -(0.06 * mv + 0.22 * sp * mv + 0.3 * cr) + p.aimPitch * 0.25 * aim + breathe * 0.012 + p.flinch * 0.25 - air * 0.08;
    const twist = THREE.MathUtils.clamp(p.torsoTwist, -0.6, 0.6) * (1 - aim);
    this.j(this.torso, lean, twist, -hipRoll * 0.5, dt, 14);
    this.chestMesh.scale.y = 1 + breathe * 0.012;

    // ── head: look along aim, counter the lean
    const headX = -lean * 0.6 + p.aimPitch * 0.45 * (0.4 + 0.6 * aim) + p.flinch * 0.3;
    this.j(this.headPivot, headX, twist * 0.4, 0, dt, 12);

    // ── arms
    let rUx: number, rUz: number, rL: number, lUx: number, lUz: number, lL: number;
    const armSwing = (0.35 + 0.35 * sp) * mv * ground;
    if (!p.hasWeapon) {
      rUx = Math.sin(phi + Math.PI) * armSwing + 0.05 - air * 0.3; rUz = -0.08 - air * 0.5; rL = 0.25 + 0.2 * sp;
      lUx = Math.sin(phi) * armSwing + 0.05 - air * 0.3; lUz = 0.08 + air * 0.5; lL = 0.25 + 0.2 * sp;
    } else {
      // low-ready
      const lrRUx = 0.55 + Math.sin(phi + Math.PI) * armSwing * 0.25 - 0.15 * sp * mv;
      const lrRL = 1.05 + 0.15 * sp;
      const lrLUx = p.twoHanded ? 0.7 : Math.sin(phi) * armSwing + 0.05;
      const lrLUz = p.twoHanded ? 0.45 : 0.08;
      const lrLL = p.twoHanded ? 1.35 : 0.3;
      // aim
      const pitchArm = p.aimPitch * 0.9;
      const aimRUx = Math.PI / 2 + pitchArm;
      const aimRL = 0.15;
      const aimLUx = p.twoHanded ? Math.PI / 2 + pitchArm - 0.35 : Math.PI / 2 + pitchArm - 0.6;
      const aimLUz = p.twoHanded ? 0.4 : 0.7;
      const aimLL = p.twoHanded ? 0.95 : 1.3;
      rUx = THREE.MathUtils.lerp(lrRUx, aimRUx, aim);
      rUz = THREE.MathUtils.lerp(-0.1, -0.12, aim);
      rL = THREE.MathUtils.lerp(lrRL, aimRL, aim);
      lUx = THREE.MathUtils.lerp(lrLUx, aimLUx, aim);
      lUz = THREE.MathUtils.lerp(lrLUz, aimLUz, aim);
      lL = THREE.MathUtils.lerp(lrLL, aimLL, aim);
      if (p.reloading) {
        // left hand works the magazine
        const t = time * 9;
        lUx = 0.35 + Math.sin(t) * 0.12 + aim * 0.3;
        lUz = 0.25;
        lL = 1.45 + Math.cos(t) * 0.1;
        rUx -= 0.25 * aim;
      }
      // recoil jerk
      rUx += p.recoil * 0.14; lUx += p.recoil * 0.12;
      // sprint: pump the rifle up
      if (!p.reloading) { rUx -= 0.1 * sp * mv * (1 - aim); }
    }
    rUx += p.flinch * -0.3; lUx += p.flinch * -0.3;
    const armLambda = 16;
    this.j(this.armR.upper, rUx, 0, rUz, dt, armLambda);
    this.j(this.armR.lower, rL, 0, 0, dt, armLambda);
    this.j(this.armL.upper, lUx, 0, lUz, dt, armLambda);
    this.j(this.armL.lower, lL, 0, 0, dt, armLambda);

    // ── cape: trail behind with speed, flutter
    const trail = (0.25 * mv + 0.55 * sp * mv) * ground + air * 0.6 * (p.verticalVel < 0 ? 1.4 : 0.5);
    for (let i = 0; i < this.capeSegs.length; i++) {
      const seg = this.capeSegs[i];
      const flutter = Math.sin(time * (6 + i * 1.5) + i * 1.3) * (0.03 + 0.05 * mv + 0.04 * air);
      const target = i === 0 ? trail * 0.5 + 0.1 : trail * 0.35 + flutter;
      seg.rotation.x = damp(seg.rotation.x, target, 10 - i, dt);
      seg.rotation.z = damp(seg.rotation.z, Math.sin(time * 3 + i) * 0.02 * (1 + mv), 8, dt);
    }

    // visor pulse
    this.visorMat.emissiveIntensity = 0.85 + Math.sin(time * 2.2) * 0.15;
    this.bodyGroup.rotation.x = damp(this.bodyGroup.rotation.x, 0, 10, dt);
    this.bodyGroup.position.y = damp(this.bodyGroup.position.y, 0, 10, dt);
  }

  private poseDead(dt: number, p: SoldierPose): void {
    const d = p.dead;
    const e = 1 - (1 - d) * (1 - d) * (1 - d); // easeOutCubic
    // fall backwards, slight twist
    this.bodyGroup.rotation.x = e * 1.42;
    this.bodyGroup.position.y = e * 0.12;
    this.hips.position.y = THREE.MathUtils.lerp(this.hips.position.y, 0.55, e * 0.6);
    const L = 8;
    this.j(this.torso, 0.25 * e, 0.15 * e, 0, dt, L);
    this.j(this.headPivot, 0.5 * e, 0.3 * e, 0.2 * e, dt, L);
    this.j(this.armR.upper, -0.2, 0, -1.1 * e, dt, L);
    this.j(this.armR.lower, 0.4, 0, 0, dt, L);
    this.j(this.armL.upper, 0.6 * e, 0, 0.9 * e, dt, L);
    this.j(this.armL.lower, 0.7, 0, 0, dt, L);
    this.j(this.legR.upper, 0.35 * e, 0, -0.25 * e, dt, L);
    this.j(this.legL.upper, 0.1 * e, 0, 0.3 * e, dt, L);
    this.j(this.legR.lower, -0.5 * e, 0, 0, dt, L);
    this.j(this.legL.lower, -0.2 * e, 0, 0, dt, L);
    for (const seg of this.capeSegs) seg.rotation.x = damp(seg.rotation.x, -0.4, 6, dt);
    this.visorMat.emissiveIntensity = Math.max(0, 0.9 - d * 1.1);
  }

  /** Snap all joints to a neutral standing pose (respawn). */
  resetPose(): void {
    this.root.traverse((o) => { if (o !== this.root && o !== this.weaponSocket) o.rotation.set(0, 0, 0); });
    this.weaponSocket.rotation.set(-Math.PI / 2, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);
    this.bodyGroup.position.set(0, 0, 0);
    this.hips.position.y = this.hipsBaseY;
    this.visorMat.emissiveIntensity = 0.9;
  }

  setVisible(v: boolean): void { this.root.visible = v; }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
