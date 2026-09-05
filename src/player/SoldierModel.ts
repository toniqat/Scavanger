import * as THREE from 'three';
import { Layers } from '@/shared';
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
  /** lying on the belly, weapon forward; crawl cycle driven by stridePhase while moving */
  prone: number;
  /** superman dive pose (body horizontal, arms forward, legs back) */
  dive: number;
  /** stepping-out / scripted walk: reuse moveBlend */
  /** grenade wind-up 0..1: right arm cocked back over the shoulder, torso twisted, slight lean back (Phase 2) */
  throw: number;
  /** consumable in the right hand 0..1: one-handed, right forearm raised in front of the chest, left arm free (Phase 2) */
  holdItem: number;
}

interface Limb {
  upper: THREE.Object3D; lower: THREE.Object3D;
}

const ARMOR = 0x3a4150;      // dark steel / blue-grey plates
const STEEL = 0x7c8796;
/** Default accent (helldiver yellow). Remote avatars pass `NET_SLOT_COLORS[slot]` instead. */
export const SOLDIER_DEFAULT_ACCENT = 0xffc23a;
const ACCENT = SOLDIER_DEFAULT_ACCENT;
const DARK = 0x22262e;       // undersuit
const CAPE = 0x2e3442;
const VISOR = 0x7fe3ff;
/**
 * Render order of the occlusion silhouette / the body. The silhouette (GreaterDepth, no depth write) is drawn
 * after every default-order opaque object (terrain, props, enemies, the hellpod) but BEFORE the body, so its
 * depth test only sees the world — the body then overwrites it wherever the soldier is actually visible, and
 * the flat black remains only where the world occludes him. Anything parented into `weaponSocket` is lifted
 * to BODY_ORDER too so the held weapon never gets black patches from the body behind it.
 */
const SIL_ORDER = 1;
const BODY_ORDER = 2;
const _silColor = new THREE.Color();

/**
 * Stylised armoured trooper (~1.8 m) built from primitives. Root origin is at the feet, model faces -Z.
 * Joint convention: rotation.x > 0 swings a limb forward (toward -Z).
 */
export class SoldierModel {
  /** Accent colour this model was built with (belt, stripes, crest, boot trim, cape hem; visor tint when non-default). */
  readonly accentColor: number;
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
  /** Occlusion silhouette: one child mesh per body mesh sharing its geometry (see SIL_ORDER). */
  private readonly silMeshes: THREE.Mesh[] = [];
  private readonly silMat: THREE.MeshBasicMaterial;
  private silhouetteOn = false;
  private fadeAlpha = 1;

  private readonly hipsBaseY = 0.98;

  /**
   * @param accentColor hex colour for the yellow trim. The local player keeps the default; remote avatars use
   *   their lobby slot colour. A non-default accent also tints the visor glow halfway toward it so the
   *   squad reads apart from any angle.
   */
  constructor(accentColor: number = SOLDIER_DEFAULT_ACCENT) {
    this.accentColor = accentColor;
    this.root.name = 'Soldier';
    // low metalness on purpose: without an environment map, metallic surfaces go black under hemisphere light
    const mArmor = this.mat(ARMOR, 0.35, 0.55);
    const mSteel = this.mat(STEEL, 0.5, 0.45);
    const mAccent = this.mat(accentColor, 0.2, 0.5);
    const mDark = this.mat(DARK, 0.15, 0.75);
    const mCape = this.mat(CAPE, 0.0, 0.9, THREE.DoubleSide);
    this.visorMat = this.mat(0x102030, 0.6, 0.3) as THREE.MeshStandardMaterial;
    this.visorMat.emissive.setHex(VISOR);
    if (accentColor !== ACCENT) this.visorMat.emissive.lerp(new THREE.Color(accentColor), 0.5);
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

    const bodyMeshes: THREE.Mesh[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; o.renderOrder = BODY_ORDER; bodyMeshes.push(o as THREE.Mesh); }
    });

    // ── occlusion silhouette: flat, opaque, drawn only where something already in the depth buffer is in
    //    front (GreaterDepth). Opaque on purpose — a transparent material would be sorted after the body and
    //    paint the self-occluded parts (rear arm behind the chest) black over the visible model.
    _silColor.setHex(accentColor !== ACCENT ? accentColor : 0x000000);
    if (accentColor !== ACCENT) _silColor.multiplyScalar(0.16);
    this.silMat = new THREE.MeshBasicMaterial({
      color: _silColor.getHex(), depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false,
      transparent: false, fog: false, toneMapped: false, side: THREE.DoubleSide, // cape planes are double-sided
    });
    this.materials.push(this.silMat);
    for (const m of bodyMeshes) {
      const sil = new THREE.Mesh(m.geometry, this.silMat);   // child → inherits the part transform (incl. scale)
      sil.name = 'sil';
      sil.castShadow = false; sil.receiveShadow = false;
      sil.renderOrder = SIL_ORDER;
      sil.layers.enable(Layers.NO_RAYCAST);
      sil.visible = false;
      m.add(sil);
      this.silMeshes.push(sil);
    }
  }

  /**
   * Show the flat silhouette where the world occludes the body (off by default). Owners turn it off while
   * dead / dropping / in a pod / faded. Toggles `visible` on ~40 tiny meshes only when the state changes.
   */
  setSilhouette(on: boolean): void {
    const want = on && this.fadeAlpha >= 0.999;
    if (want === this.silhouetteOn) return;
    this.silhouetteOn = want;
    for (let i = 0; i < this.silMeshes.length; i++) this.silMeshes[i].visible = want;
  }
  get silhouetteVisible(): boolean { return this.silhouetteOn; }

  /**
   * Near-camera fade (camera closer than ~0.9 m to the pivot): 1 = opaque, 0 = hidden. Switches the body
   * materials to transparent only while fading so the normal opaque path is untouched at alpha 1.
   * The silhouette is suppressed while faded.
   */
  setFade(alpha: number): void {
    alpha = THREE.MathUtils.clamp(alpha, 0, 1);
    if (Math.abs(alpha - this.fadeAlpha) < 0.005 && (alpha === 1) === (this.fadeAlpha === 1)) return;
    this.fadeAlpha = alpha;
    const transparent = alpha < 0.999;
    for (const m of this.materials) {
      if (m === this.silMat) continue;
      m.transparent = transparent;
      m.opacity = transparent ? alpha : 1;
      m.depthWrite = !transparent || alpha > 0.5;   // opacity/transparent are not shader-defining: no recompile
    }
    this.bodyGroup.visible = alpha > 0.02;
    if (transparent && this.silhouetteOn) this.setSilhouette(false);
  }
  get fade(): number { return this.fadeAlpha; }

  /** Lift anything newly parented into the weapon socket (WeaponModel) to the body's render order. */
  private syncSocketRenderOrder(): void {
    const kids = this.weaponSocket.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].renderOrder !== BODY_ORDER) kids[i].traverse((o) => { o.renderOrder = BODY_ORDER; });
    }
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
    this.syncSocketRenderOrder();
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
    // lying poses (prone / dive) blend on top of the upright pose
    const pr = THREE.MathUtils.clamp(p.prone, 0, 1), dv = THREE.MathUtils.clamp(p.dive, 0, 1);
    const lie = Math.min(1, pr + dv);
    const dvW = lie > 0.001 ? dv / (pr + dv) : 0;      // fraction of the lying pose that is the dive
    const crawl = Math.min(1, p.moveBlend * 3) * pr * ground; // crawl cycle strength (prone speed ≈ 0.3 walk)
    const lerp = THREE.MathUtils.lerp;
    // quick-use poses (item in hand / grenade wind-up) — arms only while upright, fade out while lying
    const hi = THREE.MathUtils.clamp(p.holdItem ?? 0, 0, 1) * (1 - lie);
    const th = THREE.MathUtils.clamp(p.throw ?? 0, 0, 1) * (1 - lie);

    // ── hips / root bob
    const bob = (Math.abs(Math.sin(phi)) - 0.5) * (0.045 + 0.03 * sp) * mv * ground;
    const standHipY = this.hipsBaseY + bob - 0.36 * cr + air * (p.verticalVel > 0 ? 0.05 : -0.02);
    // lying: pelvis just above the ground (prone) or mid-air around the feet point (dive)
    const lieHipY = lerp(0.27, 0.55, dvW);
    const targetHipY = lerp(standHipY, lieHipY, lie);
    this.hips.position.y = damp(this.hips.position.y, targetHipY, lie > 0.01 ? 10 : 20, dt);
    const hipRoll = Math.sin(phi) * 0.05 * mv * ground;
    const hipYaw = -Math.sin(phi) * 0.08 * mv * ground * (1 - aim);
    // pitch the whole body forward: prone ≈ 85°, dive ≈ 78°
    const hipPitch = -lerp(1.48, 1.36, dvW) * lie;
    const crawlRoll = Math.sin(phi) * 0.07 * crawl;
    this.j(this.hips, hipPitch, hipYaw * (1 - lie), hipRoll * (1 - lie) + crawlRoll, dt, lie > 0.01 ? 9 : 18);

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
    // lying: legs extended back; prone crawl = alternating knee push; dive = straight
    const lieThighR = lerp(0.08 + Math.sin(phi) * 0.3 * crawl, -0.05, dvW);
    const lieThighL = lerp(0.08 + Math.sin(phi + Math.PI) * 0.3 * crawl, -0.05, dvW);
    const lieKneeR = lerp(-0.12 - 0.55 * crawl * Math.max(0, Math.cos(phi)), -0.08, dvW);
    const lieKneeL = lerp(-0.12 - 0.55 * crawl * Math.max(0, Math.cos(phi + Math.PI)), -0.08, dvW);
    const legSpread = lerp(0.03, 0.14, lie);
    this.j(this.legR.upper, lerp(thighR, lieThighR, lie), 0, -legSpread, dt, 22);
    this.j(this.legL.upper, lerp(thighL, lieThighL, lie), 0, legSpread, dt, 22);
    this.j(this.legR.lower, lerp(kneeR, lieKneeR, lie), 0, 0, dt, 22);
    this.j(this.legL.lower, lerp(kneeL, lieKneeL, lie), 0, 0, dt, 22);

    // ── torso
    const standLean = -(0.06 * mv + 0.22 * sp * mv + 0.3 * cr) + p.aimPitch * 0.25 * aim + breathe * 0.012 + p.flinch * 0.25 - air * 0.08;
    // prone: chest arched up off the ground (follows aim pitch); dive: flat
    const lieLean = lerp(0.35 + THREE.MathUtils.clamp(p.aimPitch, -0.5, 0.8) * 0.35, 0.1, dvW) + breathe * 0.01;
    // throw wind-up: lean back a touch and twist the shoulders to the right (the arm goes back over the shoulder)
    const lean = lerp(standLean, lieLean, lie) + 0.14 * th;
    const twist = THREE.MathUtils.clamp(p.torsoTwist, -0.6, 0.6) * (1 - aim) * (1 - 0.6 * lie) - 0.38 * th;
    this.j(this.torso, lean, twist, -hipRoll * 0.5 * (1 - lie), dt, 14);
    this.chestMesh.scale.y = 1 + breathe * 0.012;

    // ── head: look along aim, counter the lean; lifted while lying
    const standHeadX = -standLean * 0.6 + p.aimPitch * 0.45 * (0.4 + 0.6 * aim) + p.flinch * 0.3;
    const lieHeadX = lerp(0.95, 0.85, dvW) + THREE.MathUtils.clamp(p.aimPitch, -0.5, 0.8) * 0.3 + p.flinch * 0.2;
    this.j(this.headPivot, lerp(standHeadX, lieHeadX, lie), twist * 0.4, 0, dt, 12);

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
      rUx = lerp(lrRUx, aimRUx, aim);
      rUz = lerp(-0.1, -0.12, aim);
      rL = lerp(lrRL, aimRL, aim);
      lUx = lerp(lrLUx, aimLUx, aim);
      lUz = lerp(lrLUz, aimLUz, aim);
      lL = lerp(lrLL, aimLL, aim);
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
    if (hi > 0.001) {
      // item in the right hand: upper arm a little forward, forearm folded up so the hand sits in front of the
      // chest (weaponSocket = the item); the left arm swings freely like an unarmed walk
      const iRUx = 0.75 + Math.sin(phi + Math.PI) * armSwing * 0.15, iRUz = -0.2, iRL = 1.75;
      const iLUx = Math.sin(phi) * armSwing + 0.05 - air * 0.3, iLUz = 0.08 + air * 0.5, iLL = 0.25 + 0.2 * sp;
      rUx = lerp(rUx, iRUx, hi); rUz = lerp(rUz, iRUz, hi); rL = lerp(rL, iRL, hi);
      lUx = lerp(lUx, iLUx, hi); lUz = lerp(lUz, iLUz, hi); lL = lerp(lL, iLL, hi);
    }
    if (th > 0.001) {
      // wind-up: right upper arm swung up and back past vertical, elbow folded (hand behind the head);
      // left arm out front for balance
      const tRUx = 3.35, tRUz = -0.55, tRL = 1.55;
      const tLUx = 1.0, tLUz = 0.35, tLL = 0.5;
      rUx = lerp(rUx, tRUx, th); rUz = lerp(rUz, tRUz, th); rL = lerp(rL, tRL, th);
      lUx = lerp(lUx, tLUx, th); lUz = lerp(lUz, tLUz, th); lL = lerp(lL, tLL, th);
    }
    if (lie > 0.001) {
      // prone: upper arms angled down to the ground (elbows planted), forearms up so the weapon
      // points forward along the body axis (upper + lower ≈ π); crawl = alternating reach.
      // dive: both arms stretched straight forward (superman).
      const reachR = Math.sin(phi + Math.PI) * 0.25 * crawl, reachL = Math.sin(phi) * 0.25 * crawl;
      let pRUx = 2.55 + reachR, pRUz = -0.15, pRL = 0.6 - reachR * 0.8;
      let pLUx = (p.twoHanded ? 2.4 : 2.5) + reachL, pLUz = p.twoHanded ? 0.35 : 0.25, pLL = p.twoHanded ? 0.75 : 0.65;
      if (!p.hasWeapon) { pRL = 0.5; pLL = 0.5; }
      if (p.reloading && p.hasWeapon) { const t = time * 9; pLUx = 2.15 + Math.sin(t) * 0.12; pLUz = 0.3; pLL = 1.0 + Math.cos(t) * 0.1; }
      pRUx += p.recoil * 0.1; pRUz -= p.flinch * 0.1;
      const dRUx = 3.0, dRUz = -0.25, dRL = 0.05, dLUx = 3.0, dLUz = 0.25, dLL = 0.05;
      rUx = lerp(rUx, lerp(pRUx, dRUx, dvW), lie); rUz = lerp(rUz, lerp(pRUz, dRUz, dvW), lie); rL = lerp(rL, lerp(pRL, dRL, dvW), lie);
      lUx = lerp(lUx, lerp(pLUx, dLUx, dvW), lie); lUz = lerp(lUz, lerp(pLUz, dLUz, dvW), lie); lL = lerp(lL, lerp(pLL, dLL, dvW), lie);
    }
    const armLambda = 16;
    this.j(this.armR.upper, rUx, 0, rUz, dt, armLambda);
    this.j(this.armR.lower, rL, 0, 0, dt, armLambda);
    this.j(this.armL.upper, lUx, 0, lUz, dt, armLambda);
    this.j(this.armL.lower, lL, 0, 0, dt, armLambda);

    // ── cape: trail behind with speed, flutter; drapes along the back when prone, streams when diving
    const trail = (0.25 * mv + 0.55 * sp * mv) * ground + air * 0.6 * (p.verticalVel < 0 ? 1.4 : 0.5);
    for (let i = 0; i < this.capeSegs.length; i++) {
      const seg = this.capeSegs[i];
      const flutter = Math.sin(time * (6 + i * 1.5) + i * 1.3) * (0.03 + 0.05 * mv + 0.04 * air);
      const standTarget = i === 0 ? trail * 0.5 + 0.1 : trail * 0.35 + flutter;
      const lieTarget = lerp(0.05 + flutter * 0.3, -0.5 - i * 0.05 + flutter, dvW);
      seg.rotation.x = damp(seg.rotation.x, lerp(standTarget, lieTarget, lie), 10 - i, dt);
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
    // undo any prone/dive body pitch so the fall reads the same from every stance
    this.hips.rotation.x = damp(this.hips.rotation.x, 0, L, dt);
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
