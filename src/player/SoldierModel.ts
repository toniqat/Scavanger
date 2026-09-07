import * as THREE from 'three';
import { Layers, type ArmorDef } from '@/shared';
import { damp } from '@/core/util/MathUtil';
import { buildArmorPlate, type GearLook } from './GearLook';

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
  /* ── appended: tactical kit ── */
  /** tuck-and-tumble roll blend 0..1 (Alt). Drives the limb tuck; `rollPhase` drives the rotation. */
  roll: number;
  /** 0..1 progress through the tumble (one full forward revolution). Held at 1 while the blend fades out. */
  rollPhase: number;
  /** melee swing progress 0..1 (0 = idle); the right arm chops across the body. */
  melee: number;
  /** backpack hover blend 0..1 (legs tucked, arms out, cape streaming up) */
  hover: number;
  /** downed / bleeding out 0..1 — lies on the side, limbs limp (combined with `prone`) */
  downed: number;
  /** stepping-out / scripted walk: reuse moveBlend */
  /** grenade wind-up 0..1: right arm cocked back over the shoulder, torso twisted, slight lean back (Phase 2) */
  throw: number;
  /** consumable in the right hand 0..1: one-handed, right forearm raised in front of the chest, left arm free (Phase 2) */
  holdItem: number;
  /* ── appended: unique weapons (2026-09-06) — all optional, remote avatars leave them undefined ── */
  /** 1 while `melee` is the 용검 big slash: two-handed wide horizontal sweep (wind-up right, swing across to the left) instead of the chop */
  meleeHeavy?: number;
  /** braced charge stance 0..1 (shockgun RMB / minigun spin-up): weight low, elbows tucked, leaning into the gun */
  charging?: number;
  /** continuous hip spray 0..1 (flamethrower / arc): gun held low at the hip, a little lean back, arms jittering */
  spraying?: number;
  /** heavy hip carry 0..1 (bazooka / minigun): right hand on the rear grip at the hip, left arm forward under the barrel, no ADS */
  heavyCarry?: number;
  /* ── appended: Phase 7 (remote pose sync) ── */
  /** pin pulled / cooking 0..1: item held in front of the chest, left hand reaching across to it (over `holdItem`) */
  cooking?: number;
  /* ── appended: Phase 10 (부상자 들쳐메기) ── */
  /**
   * Fireman carry 0..1: the right arm reaches up over the shoulder to hold the load (`shoulderSocket`), the left arm
   * stays free for balance, the torso leans forward and the knees soften. Never combined with ADS (the gun is
   * holstered while carrying).
   */
  carry?: number;
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
 * the flat black remains only where the world occludes him. Anything parented into `weaponSocket` /
 * `shoulderSocket` is lifted to BODY_ORDER too so a held weapon (or a carried squadmate) never gets black
 * patches from the body behind it.
 */
const SIL_ORDER = 1;
const BODY_ORDER = 2;
/** Height of the tumble pivot used by the roll pose (roughly the curled body's centre). */
const ROLL_PIVOT_Y = 0.55;
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
  /**
   * Right-shoulder socket a carried squadmate's body is parented into (Phase 10). Yawed a quarter turn so a
   * prone body lies **across** the shoulders; `PLAYER_CARRY_OFFSET` is the carried root's offset inside it.
   */
  readonly shoulderSocket = new THREE.Object3D();
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
  /* ── Phase 7: armor plate look, overcharge rim glow, suspended grey tint ── */
  private armorLook: GearLook | null = null;
  private armorLookId: string | null = null;
  private readonly plateMats: THREE.MeshStandardMaterial[] = [];
  private readonly baseColors: number[] = [];
  private glowTarget = 0;
  private glow = 0;
  private greyed = false;

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
    this.plateMats.push(mArmor, mSteel);

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

    // carried squadmate: across the shoulders (pads sit at torso y 0.52), head hanging over the left side —
    // the body itself stays in its prone pose, so the socket only has to yaw it a quarter turn
    this.shoulderSocket.position.set(0.12, 0.36, 0.02);
    this.shoulderSocket.rotation.set(0, Math.PI / 2, 0);
    this.torso.add(this.shoulderSocket);

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
    for (const m of this.materials) this.baseColors.push(m === this.silMat ? -1 : (m as THREE.MeshStandardMaterial).color?.getHex() ?? -1);
  }

  /* ─────────────── Phase 7: gear look / glow / grey ─────────────── */
  /**
   * Equipped 방탄복 plate set over the torso (`GearLook.buildArmorPlate`), the same rule for the local soldier
   * (`PlayerGear.armor`) and remote avatars (`PlayerSnapshot.ar`). `null` removes it. Rebuilt only when the def id
   * changes; the plates share the body's render order (never painted over by the silhouette) and follow the fade /
   * grey tint.
   */
  setArmor(def: ArmorDef | null): void {
    const id = def ? def.id : null;
    if (id === this.armorLookId) return;
    this.armorLookId = id;
    if (this.armorLook) { this.armorLook.dispose(); this.armorLook = null; }
    if (!def) return;
    const look = buildArmorPlate(def);
    look.group.traverse((o) => { o.renderOrder = BODY_ORDER; });
    this.torso.add(look.group);
    this.armorLook = look;
    this.armorBaseColors.length = 0;
    this.applyFadeTo(look.materials);
    if (this.greyed) this.applyGrey(look.materials, true);
  }
  /** Def id of the armor plate currently shown (null = none). */
  get armorId(): string | null { return this.armorLookId; }

  /** Overcharge rim: the steel plates glow (emissive, damped in `update`) while on. */
  setGlow(on: boolean): void { this.glowTarget = on ? 1 : 0; }
  get glowAmount(): number { return this.glow; }

  /**
   * Suspended member (socket down, body kept by the host's ghost): every body material is desaturated to a
   * flat grey and the visor dims. Restored exactly when turned off.
   */
  setGreyed(on: boolean): void {
    if (on === this.greyed) return;
    this.greyed = on;
    this.applyGrey(this.materials, on);
    if (this.armorLook) this.applyGrey(this.armorLook.materials, on);
  }
  get isGreyed(): boolean { return this.greyed; }

  /** Desaturate (`on`) or restore every material in `mats`; base colours are the ones each material was built with. */
  private applyGrey(mats: THREE.Material[], on: boolean): void {
    const base = mats === this.materials ? this.baseColors : this.armorBaseColors;
    if (mats !== this.materials && base.length !== mats.length) {
      base.length = 0;
      for (const m of mats) base.push((m as THREE.MeshStandardMaterial).color?.getHex() ?? -1);
    }
    for (let i = 0; i < mats.length; i++) {
      if (mats[i] === this.silMat) continue;
      const m = mats[i] as THREE.MeshStandardMaterial;
      if (!m.color || base[i] < 0) continue;
      if (on) {
        const lum = _silColor.setHex(base[i]);
        const g = 0.32 + (lum.r * 0.3 + lum.g * 0.5 + lum.b * 0.2) * 0.4;
        m.color.setRGB(g, g, g);
        if (m !== this.visorMat && m.emissiveIntensity > 0) m.emissiveIntensity = 0;
      } else {
        m.color.setHex(base[i]);
      }
    }
    if (mats === this.materials) this.visorMat.emissiveIntensity = on ? 0.25 : 0.9;
  }
  private readonly armorBaseColors: number[] = [];

  private applyFadeTo(mats: THREE.Material[]): void {
    const alpha = this.fadeAlpha;
    const transparent = alpha < 0.999;
    for (const m of mats) {
      m.transparent = transparent;
      m.opacity = transparent ? alpha : 1;
      m.depthWrite = !transparent || alpha > 0.5;
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
    if (this.armorLook) this.applyFadeTo(this.armorLook.materials);
    this.bodyGroup.visible = alpha > 0.02;
    if (transparent && this.silhouetteOn) this.setSilhouette(false);
  }
  get fade(): number { return this.fadeAlpha; }

  /**
   * Lift anything newly parented into the weapon socket (WeaponModel) or the shoulder socket (a carried
   * squadmate) to the body's render order — meshes added after the constructor have no silhouette of their own.
   */
  private syncSocketRenderOrder(): void {
    for (const socket of [this.weaponSocket, this.shoulderSocket]) {
      const kids = socket.children;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].renderOrder !== BODY_ORDER) kids[i].traverse((o) => { o.renderOrder = BODY_ORDER; });
      }
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
    this.updateGlow(dt, time);
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
    // the lying pose (prone) blends on top of the upright pose (the superman dive pose is gone — Alt rolls)
    const pr = THREE.MathUtils.clamp(p.prone, 0, 1);
    // tactical kit blends
    const rollB = THREE.MathUtils.clamp(p.roll, 0, 1);
    const hov = THREE.MathUtils.clamp(p.hover, 0, 1);
    const dwn = THREE.MathUtils.clamp(p.downed, 0, 1);
    const mel = THREE.MathUtils.clamp(p.melee, 0, 1);
    // melee: 0..0.3 windup (arm cocked back), 0.3..0.62 chop, then recovery. `melW` fades the whole thing in/out.
    const melChop = mel > 0.3 ? Math.min(1, (mel - 0.3) / 0.32) : 0;
    const melW = mel > 0.001 ? Math.sin(Math.PI * Math.min(1, mel)) : 0;
    // 용검 big slash: the same progress drives a two-handed horizontal sweep — wind-up to the right (0..0.32),
    // sweep across the body to the left (0.32..0.7), then recover. `hvy` selects it over the chop.
    const hvy = mel > 0.001 ? THREE.MathUtils.clamp(p.meleeHeavy ?? 0, 0, 1) : 0;
    const slashSweep = mel > 0.32 ? Math.min(1, (mel - 0.32) / 0.38) : 0;
    const slashS = slashSweep * slashSweep * (3 - 2 * slashSweep);   // smoothstep so the blade accelerates through the arc
    // unique weapon stances (weapon in hand, upright only)
    const upright = 1 - pr;
    const chg = (p.hasWeapon ? THREE.MathUtils.clamp(p.charging ?? 0, 0, 1) : 0) * upright;
    const spr = (p.hasWeapon ? THREE.MathUtils.clamp(p.spraying ?? 0, 0, 1) : 0) * upright;
    const hvc = (p.hasWeapon ? THREE.MathUtils.clamp(p.heavyCarry ?? 0, 0, 1) : 0) * upright;
    const lie = pr;
    const crawl = Math.min(1, p.moveBlend * 3) * pr * ground; // crawl cycle strength (prone speed ≈ 0.3 walk)
    const lerp = THREE.MathUtils.lerp;
    // quick-use poses (item in hand / grenade wind-up / cooking) — arms only while upright, fade out while lying
    const hi = THREE.MathUtils.clamp(p.holdItem ?? 0, 0, 1) * (1 - lie);
    const th = THREE.MathUtils.clamp(p.throw ?? 0, 0, 1) * (1 - lie);
    const ck = THREE.MathUtils.clamp(p.cooking ?? 0, 0, 1) * (1 - lie);
    // Phase 10: fireman carry (upright only — the load is put down before anything else happens)
    const cry = THREE.MathUtils.clamp(p.carry ?? 0, 0, 1) * (1 - lie);

    // ── hips / root bob
    const bob = (Math.abs(Math.sin(phi)) - 0.5) * (0.045 + 0.03 * sp) * mv * ground;
    const standHipY = this.hipsBaseY + bob - 0.36 * cr + air * (p.verticalVel > 0 ? 0.05 : -0.02);
    // lying: pelvis just above the ground
    const lieHipY = 0.27;
    let targetHipY = lerp(standHipY, lieHipY, lie);
    // braced charge / heavy slash / a body on the shoulders: weight drops a little
    targetHipY -= 0.07 * chg + 0.05 * hvc + 0.09 * melW * hvy + 0.06 * cry;
    // roll: pull the pelvis into a ball around the tumble pivot
    if (rollB > 0.001) targetHipY = lerp(targetHipY, 0.5, rollB);
    this.hips.position.y = damp(this.hips.position.y, targetHipY, lie > 0.01 ? 10 : 20, dt);
    const hipRoll = Math.sin(phi) * 0.05 * mv * ground;
    const hipYaw = -Math.sin(phi) * 0.08 * mv * ground * (1 - aim);
    // pitch the whole body forward: prone ≈ 85°
    const hipPitch = -1.48 * lie;
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
    // braced stance / heavy carry: knees bent a touch; the big slash plants the legs wide and low
    const brace = 0.35 * chg + 0.22 * hvc + 0.4 * melW * hvy + 0.2 * cry;
    thighR += brace; thighL += brace * 0.9; kneeR -= brace * 1.4; kneeL -= brace * 1.3;
    // airborne tuck
    const up = THREE.MathUtils.clamp(p.verticalVel / 8, -1, 1);
    thighR += air * (0.55 + 0.2 * up); thighL += air * (-0.15 + 0.1 * up);
    kneeR += air * (-0.9); kneeL += air * (-0.5);
    // lying: legs extended back; prone crawl = alternating knee push
    const lieThighR = 0.08 + Math.sin(phi) * 0.3 * crawl;
    const lieThighL = 0.08 + Math.sin(phi + Math.PI) * 0.3 * crawl;
    const lieKneeR = -0.12 - 0.55 * crawl * Math.max(0, Math.cos(phi));
    const lieKneeL = -0.12 - 0.55 * crawl * Math.max(0, Math.cos(phi + Math.PI));
    const legSpread = lerp(0.03, 0.14, lie);
    let finThighR = lerp(thighR, lieThighR, lie), finThighL = lerp(thighL, lieThighL, lie);
    let finKneeR = lerp(kneeR, lieKneeR, lie), finKneeL = lerp(kneeL, lieKneeL, lie);
    // hover: knees drawn up under the pack; roll: full tuck
    if (hov > 0.001) {
      finThighR += 0.5 * hov; finThighL += 0.42 * hov;
      finKneeR -= 0.85 * hov; finKneeL -= 0.75 * hov;
    }
    if (rollB > 0.001) {
      finThighR = lerp(finThighR, 1.65, rollB); finThighL = lerp(finThighL, 1.5, rollB);
      finKneeR = lerp(finKneeR, -2.0, rollB); finKneeL = lerp(finKneeL, -2.0, rollB);
    }
    const legLambda = rollB > 0.001 ? 26 : 22;
    this.j(this.legR.upper, finThighR, 0, -legSpread, dt, legLambda);
    this.j(this.legL.upper, finThighL, 0, legSpread, dt, legLambda);
    this.j(this.legR.lower, finKneeR, 0, 0, dt, legLambda);
    this.j(this.legL.lower, finKneeL, 0, 0, dt, legLambda);

    // ── torso
    const standLean = -(0.06 * mv + 0.22 * sp * mv + 0.3 * cr) + p.aimPitch * 0.25 * aim + breathe * 0.012 + p.flinch * 0.25 - air * 0.08;
    // prone: chest arched up off the ground (follows aim pitch)
    const lieLean = 0.35 + THREE.MathUtils.clamp(p.aimPitch, -0.5, 0.8) * 0.35 + breathe * 0.01;
    // throw wind-up: lean back a touch and twist the shoulders to the right (the arm goes back over the shoulder)
    let lean = lerp(standLean, lieLean, lie) + 0.14 * th;
    // braced charge leans into the gun; spray / heavy carry lean back against the weight; a carried body
    // pitches the carrier forward under the load
    lean += 0.14 * chg - 0.06 * spr - 0.09 * hvc + 0.2 * cry;
    if (hov > 0.001) lean = lerp(lean, -0.12, hov);
    if (rollB > 0.001) lean = lerp(lean, 0.9, rollB);      // curl into the tumble
    const twist = THREE.MathUtils.clamp(p.torsoTwist, -0.6, 0.6) * (1 - aim) * (1 - 0.6 * lie) - 0.38 * th;
    // the chop drags the shoulders around with it; the big slash winds the shoulders far right and whips them left
    const chopTwist = melW * (0.35 - 0.85 * melChop);
    const slashTwist = melW * lerp(0.75, -0.95, slashS);
    const meleeTwist = lerp(chopTwist, slashTwist, hvy);
    this.j(this.torso, lean, twist + meleeTwist, -hipRoll * 0.5 * (1 - lie) + 0.1 * cry, dt, mel > 0.001 ? 22 : 14);
    this.chestMesh.scale.y = 1 + breathe * 0.012;

    // ── head: look along aim, counter the lean; lifted while lying
    const standHeadX = -standLean * 0.6 + p.aimPitch * 0.45 * (0.4 + 0.6 * aim) + p.flinch * 0.3;
    const lieHeadX = 0.95 + THREE.MathUtils.clamp(p.aimPitch, -0.5, 0.8) * 0.3 + p.flinch * 0.2;
    this.j(this.headPivot, lerp(standHeadX, lieHeadX, lie) - 0.12 * cry, twist * 0.4, 0, dt, 12);

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
      // ── unique weapon stances (blend over hip / ADS, never while reloading)
      if (!p.reloading) {
        if (chg > 0.001) {
          // braced: both elbows tucked in, gun pulled tight against the shoulder, following the aim pitch
          const cRUx = 1.35 + pitchArm * 0.6, cRL = 0.7, cLUx = 1.25 + pitchArm * 0.6, cLUz = 0.3, cLL = 1.15;
          rUx = lerp(rUx, cRUx, chg); rUz = lerp(rUz, -0.05, chg); rL = lerp(rL, cRL, chg);
          lUx = lerp(lUx, cLUx, chg); lUz = lerp(lUz, cLUz, chg); lL = lerp(lL, cLL, chg);
        }
        if (spr > 0.001) {
          // hip spray: gun low at the hip, left hand forward on the fore-grip, a fast tremble on both arms
          const jit = Math.sin(time * 31) * 0.03 + Math.sin(time * 47) * 0.02;
          const sRUx = 0.75 + pitchArm * 0.4 + jit, sRL = 1.0, sLUx = 1.05 + pitchArm * 0.4 - jit, sLUz = 0.4, sLL = 1.05;
          rUx = lerp(rUx, sRUx, spr); rUz = lerp(rUz, -0.15, spr); rL = lerp(rL, sRL, spr);
          lUx = lerp(lUx, sLUx, spr); lUz = lerp(lUz, sLUz, spr); lL = lerp(lL, sLL, spr);
        }
        if (hvc > 0.001) {
          // heavy carry: right hand on the rear grip at the hip, left arm stretched forward under the barrel
          const hRUx = 0.45 + pitchArm * 0.3, hRL = 0.95, hLUx = 1.15 + pitchArm * 0.5, hLUz = 0.5, hLL = 0.75;
          rUx = lerp(rUx, hRUx, hvc); rUz = lerp(rUz, -0.2, hvc); rL = lerp(rL, hRL, hvc);
          lUx = lerp(lUx, hLUx, hvc); lUz = lerp(lUz, hLUz, hvc); lL = lerp(lL, hLL, hvc);
        }
      }
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
    if (ck > 0.001) {
      // cooking (pin pulled): the item stays in front of the chest, the left hand reaches across to it and
      // the shoulders hunch over the grenade
      const cRUx = 0.95, cRUz = -0.3, cRL = 1.9;
      const cLUx = 0.8, cLUz = -0.42, cLL = 1.95;
      rUx = lerp(rUx, cRUx, ck); rUz = lerp(rUz, cRUz, ck); rL = lerp(rL, cRL, ck);
      lUx = lerp(lUx, cLUx, ck); lUz = lerp(lUz, cLUz, ck); lL = lerp(lL, cLL, ck);
    }
    if (cry > 0.001) {
      // fireman carry: the right arm reaches up and over the shoulder to hold the load in place
      // (`shoulderSocket`); the left arm stays low and a little out for balance.
      const yRUx = 2.4, yRUz = -0.28, yRL = 1.55;
      const yLUx = 0.25 + Math.sin(phi) * armSwing * 0.3, yLUz = 0.3, yLL = 0.5;
      rUx = lerp(rUx, yRUx, cry); rUz = lerp(rUz, yRUz, cry); rL = lerp(rL, yRL, cry);
      lUx = lerp(lUx, yLUx, cry); lUz = lerp(lUz, yLUz, cry); lL = lerp(lL, yLL, cry);
    }
    if (lie > 0.001) {
      // prone: upper arms angled down to the ground (elbows planted), forearms up so the weapon
      // points forward along the body axis (upper + lower ≈ π); crawl = alternating reach.
      const reachR = Math.sin(phi + Math.PI) * 0.25 * crawl, reachL = Math.sin(phi) * 0.25 * crawl;
      let pRUx = 2.55 + reachR, pRUz = -0.15, pRL = 0.6 - reachR * 0.8;
      let pLUx = (p.twoHanded ? 2.4 : 2.5) + reachL, pLUz = p.twoHanded ? 0.35 : 0.25, pLL = p.twoHanded ? 0.75 : 0.65;
      if (!p.hasWeapon) { pRL = 0.5; pLL = 0.5; }
      if (p.reloading && p.hasWeapon) { const t = time * 9; pLUx = 2.15 + Math.sin(t) * 0.12; pLUz = 0.3; pLL = 1.0 + Math.cos(t) * 0.1; }
      pRUx += p.recoil * 0.1; pRUz -= p.flinch * 0.1;
      rUx = lerp(rUx, pRUx, lie); rUz = lerp(rUz, pRUz, lie); rL = lerp(rL, pRL, lie);
      lUx = lerp(lUx, pLUx, lie); lUz = lerp(lUz, pLUz, lie); lL = lerp(lL, pLL, lie);
    }
    // ── tactical kit arm overrides (hover → arms out, roll → tucked in, melee → chop, downed → limp)
    if (hov > 0.001) {
      rUx = lerp(rUx, 0.15, hov * 0.6); rUz = lerp(rUz, -0.75, hov);
      lUx = lerp(lUx, 0.15, hov * 0.6); lUz = lerp(lUz, 0.75, hov);
    }
    if (rollB > 0.001) {
      rUx = lerp(rUx, 2.35, rollB); rUz = lerp(rUz, -0.35, rollB); rL = lerp(rL, 2.1, rollB);
      lUx = lerp(lUx, 2.35, rollB); lUz = lerp(lUz, 0.35, rollB); lL = lerp(lL, 2.1, rollB);
    }
    if (melW > 0.001 && hvy < 0.999) {
      // right arm cocks back over the shoulder and chops down across the body
      const w = melW * (1 - hvy);
      rUx = lerp(rUx, lerp(-0.75, 2.25, melChop), w);
      rUz = lerp(rUz, lerp(-0.7, 0.35, melChop), w);
      rL = lerp(rL, lerp(1.6, 0.25, melChop), w);
      lUx = lerp(lUx, lerp(0.5, 0.15, melChop), w * 0.7);
    }
    if (melW > 0.001 && hvy > 0.001) {
      // 용검: both arms straight out at chest height gripping the hilt; the sweep carries them from far right
      // (rUz swung outward, lUz across the chest) to far left with the elbows nearly locked
      const w = melW * hvy;
      const armX = Math.PI / 2 - 0.15 + p.aimPitch * 0.5;
      rUx = lerp(rUx, armX + 0.1 * slashS, w); rUz = lerp(rUz, lerp(-1.05, 0.55, slashS), w); rL = lerp(rL, lerp(0.55, 0.15, slashS), w);
      lUx = lerp(lUx, armX - 0.05, w); lUz = lerp(lUz, lerp(-0.35, 1.15, slashS), w); lL = lerp(lL, lerp(0.35, 0.7, slashS), w);
    }
    if (dwn > 0.001) {
      rUx = lerp(rUx, 1.35, dwn); rUz = lerp(rUz, -0.55, dwn); rL = lerp(rL, 0.2, dwn);
      lUx = lerp(lUx, 1.1, dwn); lUz = lerp(lUz, 0.6, dwn); lL = lerp(lL, 0.15, dwn);
    }
    const armLambda = mel > 0.001 ? 26 : rollB > 0.001 ? 22 : 16;
    this.j(this.armR.upper, rUx, 0, rUz, dt, armLambda);
    this.j(this.armR.lower, rL, 0, 0, dt, armLambda);
    this.j(this.armL.upper, lUx, 0, lUz, dt, armLambda);
    this.j(this.armL.lower, lL, 0, 0, dt, armLambda);

    // ── cape: trail behind with speed, flutter; drapes along the back when prone
    const trail = (0.25 * mv + 0.55 * sp * mv) * ground + air * 0.6 * (p.verticalVel < 0 ? 1.4 : 0.5);
    for (let i = 0; i < this.capeSegs.length; i++) {
      const seg = this.capeSegs[i];
      const flutter = Math.sin(time * (6 + i * 1.5) + i * 1.3) * (0.03 + 0.05 * mv + 0.04 * air);
      const standTarget = i === 0 ? trail * 0.5 + 0.1 : trail * 0.35 + flutter;
      const lieTarget = 0.05 + flutter * 0.3;
      seg.rotation.x = damp(seg.rotation.x, lerp(standTarget, lieTarget, lie), 10 - i, dt);
      seg.rotation.z = damp(seg.rotation.z, Math.sin(time * 3 + i) * 0.02 * (1 + mv), 8, dt);
    }

    // visor pulse (dimmed while downed)
    this.visorMat.emissiveIntensity = (0.85 + Math.sin(time * 2.2) * 0.15) * (1 - 0.6 * dwn);

    // ── whole-body transform: the roll tumbles one full revolution around a pivot ~0.55 m up
    if (rollB > 0.001) {
      const th = -Math.PI * 2 * THREE.MathUtils.clamp(p.rollPhase, 0, 1);   // -2π ≡ identity at the end
      const h = ROLL_PIVOT_Y * rollB;
      this.bodyGroup.rotation.x = th;
      this.bodyGroup.position.y = h * (1 - Math.cos(th));
      this.bodyGroup.position.z = -h * Math.sin(th);
    } else {
      // unwrap a finished tumble (-2π) so easing back to 0 does not spin the model backwards
      let bx = this.bodyGroup.rotation.x;
      if (bx < -Math.PI) bx += Math.PI * 2;
      this.bodyGroup.rotation.x = damp(bx, 0, 12, dt);
      this.bodyGroup.position.y = damp(this.bodyGroup.position.y, 0, 12, dt);
      this.bodyGroup.position.z = damp(this.bodyGroup.position.z, 0, 12, dt);
    }
    // downed: roll onto the side
    this.bodyGroup.rotation.z = damp(this.bodyGroup.rotation.z, 0.45 * dwn, 8, dt);
  }

  private poseDead(dt: number, p: SoldierPose): void {
    const d = p.dead;
    const e = 1 - (1 - d) * (1 - d) * (1 - d); // easeOutCubic
    // fall backwards, slight twist
    this.bodyGroup.rotation.x = e * 1.42;
    this.bodyGroup.position.y = e * 0.12;
    // clear any roll / downed offsets left over from the last live frame
    this.bodyGroup.position.z = damp(this.bodyGroup.position.z, 0, 8, dt);
    this.bodyGroup.rotation.z = damp(this.bodyGroup.rotation.z, 0, 8, dt);
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

  /** Overcharge rim glow: emissive on the steel / armor plates, damped toward `setGlow`, pulsing while on. */
  private updateGlow(dt: number, time: number): void {
    if (this.glow < 0.001 && this.glowTarget === 0) return;
    this.glow = damp(this.glow, this.glowTarget, 8, dt);
    if (this.glow < 0.001) this.glow = 0;
    const k = this.glow * (0.55 + Math.sin(time * 5) * 0.15);
    for (const m of this.plateMats) {
      m.emissive.setHex(0x8fe9ff);
      m.emissiveIntensity = k;
    }
  }

  /** Snap all joints to a neutral standing pose (respawn). */
  resetPose(): void {
    this.root.traverse((o) => {
      if (o === this.root || o === this.weaponSocket || o === this.shoulderSocket) return;
      o.rotation.set(0, 0, 0);
    });
    this.weaponSocket.rotation.set(-Math.PI / 2, 0, 0);
    this.bodyGroup.rotation.set(0, 0, 0);
    this.bodyGroup.position.set(0, 0, 0);
    this.hips.position.y = this.hipsBaseY;
    this.visorMat.emissiveIntensity = 0.9;
  }

  setVisible(v: boolean): void { this.root.visible = v; }

  dispose(): void {
    if (this.armorLook) { this.armorLook.dispose(); this.armorLook = null; this.armorLookId = null; }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
