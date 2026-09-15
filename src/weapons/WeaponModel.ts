import * as THREE from 'three';
import type { WeaponDef } from '@/shared';
import { damp, easeOutCubic } from '@/core/util/MathUtil';
import { kindOf, type WeaponKind } from './WeaponDefaults';

const GUNMETAL = 0x2b3038;
const STEEL = 0x6a7280;
const ACCENT = 0xf2b632;
const DARK = 0x14171c;
const WOOD = 0x5a3a24;
const LASER = 0xff2a2a;
/** Laser beam along the barrel (m) — the resting length. */
const LASER_BARREL_LEN = 1.6;
/** Aimed laser: beam length clamp (m) toward the shot line's end, and the blend rate barrel ↔ aim (1/s). */
const LASER_AIM_MIN = 0.3, LASER_AIM_MAX = 40, LASER_BLEND_RATE = 14;
/** 확장 총열 sleeve length (m) per silhouette (visual only — ballistics come from the attachment's stats). */
const BARREL_EXT_LEN: Partial<Record<WeaponKind, number>> = { rifle: 0.18, energy: 0.16, shotgun: 0.18, smg: 0.13, sniper: 0.2, pistol: 0.07 };
const _lp = new THREE.Vector3(), _ld = new THREE.Vector3(), _ls = new THREE.Vector3();
const _lq = new THREE.Quaternion(), _laim = new THREE.Quaternion(), _lident = new THREE.Quaternion();
const _negZ = new THREE.Vector3(0, 0, -1);
/*
 * 2026-09-15 「롱혼」 가로 파지 (visual only — ballistics live in `unique/Bow.bowBallistics`). The bow lies in one
 * horizontal plane `BOW_Y` above the grip: limb pivots at the riser ends (`BOW_LIMB_X`, `BOW_LIMB_Z`), each limb sweeps
 * back toward the archer to `BOW_LIMB_MID` and recurves forward to the string nock at `BOW_LIMB_TIP` (pivot-local, +X
 * side; mirrored). The resting string runs nock to nock at z = `BOW_LIMB_Z + BOW_LIMB_TIP[1]` = `BOW_STRING_Z` — behind
 * the riser, on the archer's side. A full draw pulls the string centre + arrow `BOW_PULL` further back and flexes each
 * limb `BOW_FLEX` rad.
 */
const BOW_Y = 0.07;
const BOW_LIMB_X = 0.13, BOW_LIMB_Z = -0.04;
const BOW_LIMB_MID: readonly [number, number] = [0.27, 0.12];
const BOW_LIMB_TIP: readonly [number, number] = [0.41, 0.11];
const BOW_STRING_Z = BOW_LIMB_Z + BOW_LIMB_TIP[1];
const BOW_PULL = 0.24, BOW_FLEX = 0.14;
/** Nocked arrow: shaft length from the nock forward and the arrow tip (local −Z from the string). */
const BOW_SHAFT_LEN = 0.7, BOW_ARROW_TIP = 0.76;

/** Procedural attachment visuals derived from a weapon instance's sockets (see `WeaponSystem.attachmentsFor`). */
export interface WeaponAttachmentVisuals {
  /** `barrel` (2026-09-14) = 확장 총열: a longer sleeve past the muzzle. */
  muzzle?: 'brake' | 'comp' | 'choke' | 'barrel';
  grip?: 'angled' | 'vertical';
  sight?: 'laser' | 'scope';
  /** Extended magazine (longer mag body). */
  mag?: boolean;
  /** Stock upgrade (cheek riser + butt pad). */
  stock?: boolean;
}

/** Local-space anchors per silhouette used to place attachment meshes. `null` = the socket has no visual on this kind. */
interface KindAnchors {
  /** Barrel axis height (y) — the muzzle attachment sits on it at the muzzle socket. */
  barrelY: number;
  /** Under the fore-end: [y (bottom of the handguard), z]. */
  fore: readonly [number, number] | null;
  /** Top rail: [y (top surface), z centre]. */
  rail: readonly [number, number] | null;
  /** Stock end: [y centre, z (butt)]. */
  stock: readonly [number, number] | null;
}

const ANCHORS: Readonly<Record<WeaponKind, KindAnchors>> = {
  rifle:   { barrelY: 0.075, fore: [0.025, -0.44], rail: [0.125, -0.2], stock: [0.05, 0.27] },
  pistol:  { barrelY: 0.045, fore: [0.0, -0.12],   rail: [0.074, -0.08], stock: null },
  shotgun: { barrelY: 0.09,  fore: [0.02, -0.32],  rail: [0.105, -0.1], stock: [0.045, 0.31] },
  energy:  { barrelY: 0.07,  fore: [0.015, -0.4],  rail: [0.14, -0.15], stock: [0.05, 0.26] },
  smg:     { barrelY: 0.065, fore: [0.045, -0.22], rail: [0.112, -0.1], stock: [0.06, 0.245] },
  sniper:  { barrelY: 0.075, fore: [0.0125, -0.5], rail: null, stock: [0.045, 0.365] },
  /* uniques: no sockets (`LootRef.canAttach` → false); anchors exist only so the table stays total */
  flamethrower: { barrelY: 0.07, fore: null, rail: null, stock: null },
  shockgun:     { barrelY: 0.08, fore: null, rail: null, stock: null },
  shuriken:     { barrelY: 0.05, fore: null, rail: null, stock: null },
  bow:          { barrelY: BOW_Y, fore: null, rail: null, stock: null },
  bazooka:      { barrelY: 0.11, fore: null, rail: null, stock: null },
  minigun:      { barrelY: 0.09, fore: null, rail: null, stock: null },
};

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
  /* attachments: separate group + resource lists so they can be rebuilt without touching the base mesh */
  private readonly attachGroup = new THREE.Group();
  private readonly attachGeometries: THREE.BufferGeometry[] = [];
  private readonly attachMaterials: THREE.Material[] = [];
  private attachMagExt: THREE.Object3D | null = null;
  private muzzleBase = new THREE.Vector3();
  /** 2026-09-14 laser sight: pivot at the lens (beam = its unit-length child), barrel ↔ aim blend 0..1. */
  private laserPivot: THREE.Object3D | null = null;
  private laserBeam: THREE.Mesh | null = null;
  private laserBlend = 0;
  private readonly laserTarget = new THREE.Vector3();
  private readonly baseMats: { metal: THREE.Material; steel: THREE.Material; accent: THREE.Material; dark: THREE.Material };
  /** Bolt handle (sniper); animated by `setBolt`. */
  private bolt: THREE.Object3D | null = null;
  private boltBase = new THREE.Vector3();
  private kickZ = 0;
  private kickRot = 0;
  private reloadT = -1;
  private boltT = -1;
  private drawT = 1;
  /* unique weapons */
  /** Minigun barrel cluster (rotates about local Z while `spin` > 0). */
  private barrels: THREE.Object3D | null = null;
  private spin = 0;
  private barrelAngle = 0;
  /** Bow string + nocked arrow: pulled back by the draw (`setBowDraw`, 2026-09-14) or, on replicas, the `kick`. */
  private bowDraw = 0;
  /** 2026-09-15: limb pivots [right, left] (flex about Y) and the two string halves (nock → string centre, a V when drawn). */
  private readonly bowLimbs: THREE.Object3D[] = [];
  private readonly bowStrings: THREE.Object3D[] = [];
  private bowArrow: THREE.Object3D | null = null;
  private bowArrowBase = new THREE.Vector3();
  /** 2026-09-15: an arrow is available to nock (`setBowNocked`) and the empty-string beat after a release (`bowLoose`). */
  private bowNocked = true;
  private bowLooseT = 0;
  /** Flamethrower pilot light / shock coil glow: 0..1 heat driven by `setHeat` (spraying / arcing). */
  private heat = 0;
  private heatMat: THREE.MeshStandardMaterial | null = null;

  constructor(def: WeaponDef) {
    this.kind = kindOf(def);
    this.root.name = `Weapon:${def.id}`;
    this.root.add(this.body);
    const mMetal = this.mat(GUNMETAL, 0.85, 0.4);
    const mSteel = this.mat(STEEL, 0.9, 0.3);
    const mAccent = this.mat(ACCENT, 0.4, 0.5);
    const mDark = this.mat(DARK, 0.5, 0.7);
    this.baseMats = { metal: mMetal, steel: mSteel, accent: mAccent, dark: mDark };

    switch (this.kind) {
      case 'pistol': this.mag = this.buildPistol(mMetal, mSteel, mAccent, mDark); break;
      case 'shotgun': this.mag = this.buildShotgun(mMetal, mSteel, mAccent, mDark); break;
      case 'energy': this.mag = this.buildEnergy(mMetal, mSteel, mAccent, mDark); break;
      case 'smg': this.mag = this.buildSmg(mMetal, mSteel, mAccent, mDark); break;
      case 'sniper': this.mag = this.buildSniper(mMetal, mSteel, mAccent, mDark); break;
      case 'flamethrower': this.mag = this.buildFlamethrower(mMetal, mSteel, mAccent, mDark); break;
      case 'shockgun': this.mag = this.buildShockgun(mMetal, mSteel, mAccent, mDark); break;
      case 'shuriken': this.mag = this.buildShuriken(mMetal, mSteel, mAccent, mDark); break;
      case 'bow': this.mag = this.buildBow(mMetal, mSteel, mAccent, mDark); break;
      case 'bazooka': this.mag = this.buildBazooka(mMetal, mSteel, mAccent, mDark); break;
      case 'minigun': this.mag = this.buildMinigun(mMetal, mSteel, mAccent, mDark); break;
      default: this.mag = this.buildRifle(mMetal, mSteel, mAccent, mDark);
    }
    if (this.mag) this.magBase.copy(this.mag.position);
    if (this.bolt) this.boltBase.copy(this.bolt.position);
    this.body.add(this.muzzle, this.ejectPort, this.attachGroup);
    this.muzzleBase.copy(this.muzzle.position);
    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  }

  /* ─────────── attachments ─────────── */
  /**
   * Rebuild the socket attachment meshes. Muzzle devices extend the `muzzle` socket forward; the extended mag is
   * parented to the animated magazine so it drops out on reload. Pass `{}` to strip everything. No lights are added.
   */
  setAttachments(cfg: WeaponAttachmentVisuals): void {
    this.clearAttachments();
    const a = ANCHORS[this.kind];
    const g = this.attachGroup;
    const { metal, steel, dark, accent } = this.baseMats;

    // muzzle device (brake: baffled cylinder / comp: ported can / choke: flared short tube)
    if (cfg.muzzle) {
      const mz = this.muzzleBase;
      let len = 0.07;
      if (cfg.muzzle === 'brake') {
        this.atube(0.02, len, dark, mz.x, mz.y, mz.z - len / 2, g);
        for (let i = 0; i < 3; i++) this.abox(0.046, 0.012, 0.007, steel, mz.x, mz.y, mz.z - 0.012 - i * 0.022, g);
      } else if (cfg.muzzle === 'comp') {
        len = 0.09;
        this.atube(0.019, len, metal, mz.x, mz.y, mz.z - len / 2, g);
        for (let i = 0; i < 4; i++) this.abox(0.008, 0.024, 0.008, dark, mz.x, mz.y + 0.016, mz.z - 0.012 - i * 0.018, g);
        this.abox(0.03, 0.008, len, accent, mz.x, mz.y - 0.018, mz.z - len / 2, g);
      } else if (cfg.muzzle === 'barrel') {
        // 2026-09-14 확장 총열: a long sleeve (heat-shield rings + a crown) — the muzzle socket moves to its end
        len = BARREL_EXT_LEN[this.kind] ?? 0.16;
        const r = this.kind === 'shotgun' ? 0.021 : this.kind === 'pistol' ? 0.011 : this.kind === 'sniper' ? 0.019 : 0.015;
        this.atube(r, len, metal, mz.x, mz.y, mz.z - len / 2, g);
        const rings = Math.max(2, Math.round(len / 0.05));
        for (let i = 0; i < rings; i++) this.atube(r * 1.3, 0.006, steel, mz.x, mz.y, mz.z - (i + 0.5) * (len / rings), g);
        this.atube(r * 1.2, 0.012, dark, mz.x, mz.y, mz.z - len + 0.006, g);
        this.abox(r * 0.9, 0.006, len * 0.8, accent, mz.x, mz.y + r * 1.05, mz.z - len / 2, g);
      } else {
        len = 0.05;
        const t = this.atube(0.024, len, dark, mz.x, mz.y, mz.z - len / 2, g);
        t.scale.set(1.15, 1, 1.15);
        this.atube(0.022, 0.006, steel, mz.x, mz.y, mz.z - len, g);
      }
      this.muzzle.position.set(mz.x, mz.y, mz.z - len);
    } else {
      this.muzzle.position.copy(this.muzzleBase);
    }

    // fore-grip under the handguard
    if (cfg.grip && a.fore) {
      const [fy, fz] = a.fore;
      if (cfg.grip === 'vertical') {
        const b = this.abox(0.028, 0.075, 0.03, dark, 0, fy - 0.037, fz, g);
        b.rotation.x = -0.08;
        this.abox(0.03, 0.008, 0.032, accent, 0, fy - 0.07, fz, g);
      } else {
        const b = this.abox(0.026, 0.045, 0.06, dark, 0, fy - 0.02, fz + 0.01, g);
        b.rotation.x = 0.55;
      }
    }

    // sight on the top rail: laser emitter (+ short emissive beam) or an optic tube
    if (cfg.sight && a.rail) {
      const [ry, rz] = a.rail;
      if (cfg.sight === 'laser') {
        const mz = this.muzzleBase;
        this.abox(0.022, 0.02, 0.05, dark, 0.032, a.barrelY, mz.z + 0.12, g);            // emitter right of the barrel
        const lm = this.amat(0x330000, 0, 0.6); lm.emissive.setHex(LASER); lm.emissiveIntensity = 3;
        this.abox(0.006, 0.006, 0.008, lm, 0.032, a.barrelY, mz.z + 0.094, g);           // lens
        // 2026-09-14: the beam is a unit-length box in a pivot at the lens — `setLaserAim` turns / stretches the pivot
        // (barrel = identity, `LASER_BARREL_LEN` long). Never casts a shadow (it can be tens of metres long).
        const pivot = new THREE.Object3D();
        pivot.position.set(0.032, a.barrelY, mz.z + 0.09);
        pivot.scale.set(1, 1, LASER_BARREL_LEN);
        g.add(pivot);
        const beam = this.abox(0.003, 0.003, 1, lm, 0, 0, -0.5, pivot);                   // thin beam
        beam.name = 'laserBeam';
        this.laserPivot = pivot; this.laserBeam = beam;
        this.laserBlend = 0;
        this.abox(0.03, 0.016, 0.03, steel, 0, ry + 0.008, rz, g);                       // rail riser
      } else if (this.kind === 'pistol') {
        this.abox(0.024, 0.02, 0.03, dark, 0, ry + 0.01, rz, g);                         // mini red-dot housing
        const glow = this.amat(0x112233, 0.2, 0.5); glow.emissive.setHex(0xff4040); glow.emissiveIntensity = 1.8;
        this.abox(0.016, 0.014, 0.004, glow, 0, ry + 0.012, rz + 0.016, g);
      } else if (this.kind !== 'sniper') {
        const y = ry + 0.035;
        this.abox(0.014, 0.03, 0.03, steel, 0, ry + 0.012, rz - 0.06, g);                // mounts
        this.abox(0.014, 0.03, 0.03, steel, 0, ry + 0.012, rz + 0.06, g);
        this.atube(0.017, 0.18, dark, 0, y, rz, g);                                      // tube
        this.atube(0.024, 0.05, dark, 0, y, rz - 0.1, g);                                // objective bell
        this.atube(0.021, 0.04, dark, 0, y, rz + 0.095, g);                              // ocular bell
        const lens = this.amat(0x0c1a26, 0.1, 0.2); lens.emissive.setHex(0x3fb8ff); lens.emissiveIntensity = 1.2;
        this.atube(0.019, 0.006, lens, 0, y, rz - 0.127, g);
        this.atube(0.016, 0.006, lens, 0, y, rz + 0.117, g);
        this.abox(0.012, 0.014, 0.014, steel, 0, y + 0.02, rz, g);                       // elevation turret
      }
    }

    // extended magazine: longer body parented to the animated mag anchor
    if (cfg.mag && this.mag) {
      const ext = new THREE.Object3D();
      this.mag.add(ext);
      this.attachMagExt = ext;
      switch (this.kind) {
        case 'pistol': this.abox(0.026, 0.05, 0.04, metal, 0, -0.06, 0, ext); this.abox(0.028, 0.01, 0.042, accent, 0, -0.085, 0, ext); break;
        case 'smg': this.abox(0.026, 0.07, 0.045, metal, 0, -0.205, 0, ext); this.abox(0.028, 0.012, 0.047, accent, 0, -0.243, 0, ext); break;
        case 'sniper': this.abox(0.028, 0.05, 0.07, metal, 0, -0.095, 0, ext); this.abox(0.03, 0.012, 0.072, accent, 0, -0.123, 0, ext); break;
        case 'energy': this.abox(0.04, 0.05, 0.08, metal, 0, -0.145, 0, ext); break;
        case 'shotgun': this.abox(0.05, 0.03, 0.14, dark, 0, 0.02, -0.15, ext); break;   // side-saddle shell holder
        default: { const m = this.abox(0.03, 0.07, 0.065, metal, 0, -0.19, -0.012, ext); m.rotation.x = 0.12; this.abox(0.032, 0.012, 0.067, accent, 0, -0.225, -0.015, ext); }
      }
    }

    // stock upgrade: cheek riser + rubber butt pad
    if (cfg.stock && a.stock) {
      const [sy, sz] = a.stock;
      this.abox(0.036, 0.022, 0.1, dark, 0, sy + 0.05, sz - 0.11, g);                    // cheek riser
      this.abox(0.052, 0.11, 0.018, this.amat(0x1a1a1a, 0.1, 0.95), 0, sy - 0.02, sz + 0.02, g); // butt pad
    }

    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    if (this.laserBeam) this.laserBeam.castShadow = false;   // tens of metres long when aimed — never in the shadow map
  }

  private clearAttachments(): void {
    this.laserPivot = null; this.laserBeam = null; this.laserBlend = 0;
    for (const c of [...this.attachGroup.children]) this.attachGroup.remove(c);
    if (this.attachMagExt) { this.attachMagExt.removeFromParent(); this.attachMagExt = null; }
    for (const g of this.attachGeometries) g.dispose();
    for (const m of this.attachMaterials) m.dispose();
    this.attachGeometries.length = 0;
    this.attachMaterials.length = 0;
    this.muzzle.position.copy(this.muzzleBase);
  }

  private amat(color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.attachMaterials.push(m);
    return m;
  }
  private abox(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d); this.attachGeometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  private atube(r: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
    const g = new THREE.CylinderGeometry(r, r, d, 12); this.attachGeometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.rotation.x = Math.PI / 2; mesh.position.set(x, y, z); parent.add(mesh); return mesh;
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

  /** Compact SMG: short receiver, stubby barrel with a shroud, skeleton stock, vertical magazine. */
  private buildSmg(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    this.box(0.048, 0.075, 0.26, mMetal, 0, 0.06, -0.08);                  // receiver
    this.box(0.05, 0.016, 0.2, mDark, 0, 0.104, -0.1);                     // top rail
    this.box(0.02, 0.014, 0.16, mAccent, 0.026, 0.075, -0.1);              // side accent
    this.tube(0.02, 0.14, mDark, 0, 0.065, -0.26);                         // barrel shroud
    for (let i = 0; i < 3; i++) this.box(0.046, 0.006, 0.012, mSteel, 0, 0.065, -0.2 - i * 0.045); // shroud rings
    this.tube(0.01, 0.1, mSteel, 0, 0.065, -0.36);                         // barrel
    this.tube(0.014, 0.03, mDark, 0, 0.065, -0.41);                         // threaded tip
    // skeleton stock: two rails + butt plate
    this.box(0.012, 0.012, 0.2, mSteel, 0, 0.085, 0.14);
    this.box(0.012, 0.012, 0.2, mSteel, 0, 0.035, 0.14);
    this.box(0.04, 0.075, 0.018, mDark, 0, 0.06, 0.245);
    this.box(0.014, 0.05, 0.012, mSteel, 0, 0.06, 0.05);                   // stock hinge
    const grip = this.box(0.032, 0.1, 0.045, mDark, 0, -0.045, 0.02); grip.rotation.x = -0.25;
    this.box(0.018, 0.035, 0.012, mDark, 0, 0.0, -0.03);                   // trigger guard
    this.box(0.02, 0.03, 0.006, mDark, 0, 0.125, 0.0);                     // rear sight
    this.box(0.006, 0.022, 0.006, mDark, 0, 0.122, -0.19);                 // front sight
    // vertical magazine (animated)
    const mag = new THREE.Object3D(); mag.position.set(0, 0.02, -0.06); this.body.add(mag);
    this.box(0.026, 0.17, 0.045, mMetal, 0, -0.085, 0, mag);
    this.box(0.028, 0.016, 0.047, mAccent, 0, -0.165, 0, mag);
    this.muzzle.position.set(0, 0.065, -0.43);
    this.ejectPort.position.set(0.035, 0.07, -0.08);
    return mag;
  }

  /** Bolt-action sniper: long heavy barrel, scope with lens rims, folded bipod, long stock, animated bolt handle. */
  private buildSniper(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    this.box(0.05, 0.08, 0.34, mMetal, 0, 0.06, -0.1);                     // receiver
    this.box(0.052, 0.016, 0.26, mDark, 0, 0.108, -0.1);                   // scope rail
    this.box(0.048, 0.055, 0.5, mDark, 0, 0.04, -0.4);                     // long handguard / chassis
    this.box(0.018, 0.018, 0.5, mAccent, 0.03, 0.05, -0.4);                // accent stripe
    this.tube(0.017, 0.7, mSteel, 0, 0.075, -0.75);                        // heavy barrel
    this.tube(0.024, 0.09, mDark, 0, 0.075, -1.1);                          // muzzle brake
    for (let i = 0; i < 3; i++) this.box(0.052, 0.012, 0.008, mSteel, 0, 0.075, -1.075 - i * 0.022); // brake baffles
    // stock: long, with cheek riser and butt pad
    this.box(0.045, 0.07, 0.3, mMetal, 0, 0.045, 0.2);
    this.box(0.04, 0.03, 0.16, mDark, 0, 0.1, 0.2);                        // cheek riser
    this.box(0.05, 0.11, 0.035, mDark, 0, 0.02, 0.365);                    // butt pad
    this.box(0.02, 0.015, 0.14, mAccent, 0.025, 0.05, 0.2);
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.02); grip.rotation.x = -0.25;
    this.box(0.02, 0.035, 0.012, mDark, 0, -0.005, -0.04);                 // trigger guard
    // scope: tube + objective/ocular bells with lens rims
    this.tube(0.02, 0.22, mDark, 0, 0.155, -0.12);
    this.tube(0.028, 0.06, mDark, 0, 0.155, -0.25);                         // objective bell
    this.tube(0.025, 0.05, mDark, 0, 0.155, 0.0);                           // ocular bell
    const lens = this.mat(0x0c1a26, 0.1, 0.2); lens.emissive.setHex(0x3fb8ff); lens.emissiveIntensity = 1.2;
    this.tube(0.022, 0.006, lens, 0, 0.155, -0.283);                        // objective lens
    this.tube(0.019, 0.006, lens, 0, 0.155, 0.028);                         // ocular lens
    this.tube(0.03, 0.008, mSteel, 0, 0.155, -0.278);                       // lens rims
    this.tube(0.027, 0.008, mSteel, 0, 0.155, 0.024);
    this.box(0.014, 0.03, 0.03, mSteel, 0, 0.125, -0.2);                   // scope mounts
    this.box(0.014, 0.03, 0.03, mSteel, 0, 0.125, -0.04);
    this.box(0.012, 0.012, 0.016, mSteel, 0.02, 0.16, -0.1);               // windage turret
    this.box(0.012, 0.016, 0.016, mSteel, 0, 0.18, -0.1);                  // elevation turret
    // folded bipod legs under the handguard
    for (const sx of [-1, 1]) {
      const leg = this.box(0.008, 0.008, 0.18, mSteel, sx * 0.02, 0.008, -0.5);
      leg.rotation.x = 0.06;
      this.box(0.01, 0.012, 0.012, mDark, sx * 0.02, 0.01, -0.41);         // pivot
    }
    // bolt handle (right side of the receiver, animated on cycle)
    const bolt = new THREE.Object3D(); bolt.position.set(0.025, 0.075, -0.02); this.body.add(bolt);
    this.tube(0.008, 0.06, mSteel, 0, 0, 0.0, bolt);                       // bolt body
    const arm = this.box(0.04, 0.008, 0.008, mSteel, 0.02, -0.01, 0.01, bolt); arm.rotation.z = -0.35; // handle arm
    this.box(0.012, 0.012, 0.012, mDark, 0.038, -0.02, 0.01, bolt);        // knob
    this.bolt = bolt;
    // magazine (animated)
    const mag = new THREE.Object3D(); mag.position.set(0, 0.015, -0.1); this.body.add(mag);
    this.box(0.028, 0.07, 0.07, mMetal, 0, -0.035, 0, mag);
    this.box(0.03, 0.014, 0.072, mAccent, 0, -0.07, 0, mag);
    this.muzzle.position.set(0, 0.075, -1.15);
    this.ejectPort.position.set(0.035, 0.085, -0.04);
    return mag;
  }


  /* ─────────── unique weapons (Phase 6) ─────────── */
  /** 「인페르노」: fuel tank slung under the fore-end, hose, wide nozzle with a pilot light. */
  private buildFlamethrower(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const mTank = this.mat(0xb0412a, 0.55, 0.45);
    const pilot = this.mat(0x3a1a08, 0.1, 0.6); pilot.emissive.setHex(0xff7a2a); pilot.emissiveIntensity = 1.2;
    this.heatMat = pilot;
    this.box(0.055, 0.08, 0.34, mMetal, 0, 0.065, -0.1);                   // receiver
    this.box(0.05, 0.03, 0.2, mDark, 0, 0.115, -0.12);                     // top cover
    this.tube(0.022, 0.42, mSteel, 0, 0.07, -0.5);                         // feed pipe
    this.tube(0.038, 0.1, mDark, 0, 0.07, -0.72);                           // nozzle bell
    this.tube(0.026, 0.02, pilot, 0, 0.07, -0.775);                         // pilot flame ring
    this.box(0.012, 0.06, 0.06, mAccent, 0.032, 0.11, -0.66);              // igniter fin
    for (let i = 0; i < 3; i++) this.box(0.06, 0.008, 0.01, mSteel, 0, 0.07, -0.34 - i * 0.09); // heat-shield rings
    // fuel tank hanging under the fore-end (the animated "magazine": swapped on reload)
    const mag = new THREE.Object3D(); mag.position.set(0, 0.0, -0.3); this.body.add(mag);
    this.tube(0.05, 0.28, mTank, 0, -0.06, 0, mag);
    this.tube(0.052, 0.02, mSteel, 0, -0.06, -0.12, mag);
    this.tube(0.052, 0.02, mSteel, 0, -0.06, 0.12, mag);
    this.box(0.02, 0.03, 0.04, mDark, 0, -0.005, 0, mag);                  // tank clamp
    const hose = this.tube(0.012, 0.3, mDark, -0.03, -0.02, 0.0); hose.rotation.z = 0.2; // hose back to the grip
    this.box(0.05, 0.07, 0.18, mMetal, 0, 0.05, 0.14);                     // stock stub
    this.box(0.05, 0.09, 0.03, mDark, 0, 0.03, 0.24);
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01); grip.rotation.x = -0.25;
    this.box(0.03, 0.05, 0.03, mDark, 0, 0.0, -0.45);                      // fore grip
    this.muzzle.position.set(0, 0.07, -0.79);
    this.ejectPort.position.set(0.04, 0.08, -0.1);
    return mag;
  }

  /** 「테슬라 코일」: stacked copper coil rings around a glowing core, capacitor pack as the magazine. */
  private buildShockgun(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const core = this.mat(0x0c2a36, 0.3, 0.3); core.emissive.setHex(0x5fe0ff); core.emissiveIntensity = 1.6;
    this.heatMat = core;
    const mCopper = this.mat(0xb8733a, 0.9, 0.35);
    this.box(0.055, 0.09, 0.32, mMetal, 0, 0.065, -0.08);                  // receiver
    this.box(0.05, 0.02, 0.24, mDark, 0, 0.12, -0.1);
    this.tube(0.016, 0.5, core, 0, 0.08, -0.5);                            // glowing core rod
    for (let i = 0; i < 6; i++) this.tube(0.04, 0.02, mCopper, 0, 0.08, -0.3 - i * 0.075); // coil rings
    this.box(0.01, 0.09, 0.44, mSteel, 0.045, 0.08, -0.52);                // side rails holding the coils
    this.box(0.01, 0.09, 0.44, mSteel, -0.045, 0.08, -0.52);
    this.tube(0.03, 0.05, mDark, 0, 0.08, -0.77);                            // emitter cap
    this.tube(0.02, 0.012, core, 0, 0.08, -0.8);                            // emitter tip
    this.box(0.045, 0.06, 0.2, mMetal, 0, 0.05, 0.15);                     // stock
    this.box(0.05, 0.09, 0.03, mDark, 0, 0.03, 0.25);
    this.box(0.02, 0.014, 0.16, mAccent, 0.03, 0.06, 0.14);
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01); grip.rotation.x = -0.25;
    this.box(0.03, 0.05, 0.03, mDark, 0, 0.0, -0.36);                      // fore grip
    const mag = new THREE.Object3D(); mag.position.set(0, 0.01, -0.1); this.body.add(mag);
    this.box(0.04, 0.13, 0.07, mMetal, 0, -0.07, 0, mag);                  // capacitor pack
    this.box(0.03, 0.03, 0.04, core, 0, -0.135, 0, mag);
    this.muzzle.position.set(0, 0.08, -0.81);
    this.ejectPort.position.set(0.04, 0.09, -0.1);
    return mag;
  }

  /** 「카게」: forearm bracer with a launcher rail and a holder stacked with stars. Short — barely past the hand. */
  private buildShuriken(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const mStar = this.mat(0xd8dde6, 0.95, 0.3);
    const plate = this.box(0.07, 0.03, 0.22, mDark, 0, 0.03, 0.1);        // bracer plate along the forearm
    plate.rotation.x = 0.05;
    this.box(0.075, 0.012, 0.22, mMetal, 0, 0.048, 0.1);                   // plate rim
    this.box(0.02, 0.012, 0.2, mAccent, 0.03, 0.05, 0.1);
    this.box(0.05, 0.02, 0.16, mSteel, 0, 0.055, -0.08);                   // launcher rail
    this.box(0.012, 0.03, 0.14, mDark, 0.025, 0.06, -0.08);                // rail guides
    this.box(0.012, 0.03, 0.14, mDark, -0.025, 0.06, -0.08);
    this.box(0.04, 0.03, 0.03, mDark, 0, 0.065, 0.02);                     // spring housing
    // holder with a stack of stars (the animated "magazine")
    const mag = new THREE.Object3D(); mag.position.set(0, 0.07, 0.1); this.body.add(mag);
    this.box(0.05, 0.01, 0.05, mDark, 0, 0.0, 0, mag);
    for (let i = 0; i < 3; i++) {
      const y = 0.012 + i * 0.012;
      this.box(0.11, 0.005, 0.02, mStar, 0, y, 0, mag);
      const b = this.box(0.11, 0.005, 0.02, mStar, 0, y, 0, mag); b.rotation.y = Math.PI / 2;
    }
    this.box(0.012, 0.05, 0.012, mSteel, 0, 0.03, 0.1, mag);               // holder pin
    this.box(0.08, 0.008, 0.02, mDark, 0, 0.012, 0.03);                    // straps under the arm
    this.box(0.08, 0.008, 0.02, mDark, 0, 0.012, 0.17);
    this.muzzle.position.set(0, 0.06, -0.17);
    this.ejectPort.position.set(0.03, 0.07, -0.02);
    return mag;
  }

  /**
   * 「롱혼」 (2026-09-15 가로 파지): a composite recurve held **horizontally** — the limbs spread along ±X in one plane
   * `BOW_Y` above the grip and the arrow flies −Z. The riser (two cheeks around a centre window, the arrow shelf under it,
   * the grip down into the hand) is in front; the limbs sweep back toward the archer and recurve forward at the tips; the
   * string runs nock to nock **behind** the riser (+Z, `BOW_STRING_Z`) and the nocked arrow's tail sits on it, its head
   * well ahead of the riser. The draw (`setBowDraw`, or the kick on a replica) pulls the string centre + arrow further
   * back toward the body (the string bends into a V, the limbs flex — `poseBow`). No reload animation: the arrow is
   * hidden only while out of arrows (`setBowNocked`) or for the beat after a release (`bowLoose`).
   */
  private buildBow(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const mLimb = this.mat(0x3b2d22, 0.2, 0.7);
    const mString = this.mat(0xe6e2d6, 0.0, 0.9);
    const mShaft = this.mat(0x8a6a3c, 0.1, 0.8);
    const y = BOW_Y;
    // riser: a cheek either side of the arrow window, accent inlays on the front face, limb pockets at the ends
    for (const sx of [-1, 1]) {
      this.box(0.11, 0.045, 0.05, mMetal, sx * 0.075, y, -0.04);
      this.box(0.03, 0.012, 0.006, mAccent, sx * 0.08, y, -0.067);
      this.box(0.026, 0.05, 0.03, mSteel, sx * BOW_LIMB_X, y, BOW_LIMB_Z);
    }
    this.box(0.04, 0.02, 0.05, mDark, 0, y - 0.022, -0.04);               // arrow shelf (bridge under the window)
    this.box(0.045, 0.09, 0.045, mDark, 0, 0.005, -0.035);                // grip, down into the hand
    // limbs: one pivot per side at the riser end — flexed about Y by `poseBow`
    for (const sx of [1, -1]) {
      const pivot = new THREE.Object3D();
      pivot.position.set(sx * BOW_LIMB_X, y, BOW_LIMB_Z);
      this.body.add(pivot);
      this.limbSeg(0, 0, sx * BOW_LIMB_MID[0], BOW_LIMB_MID[1], 0.03, 0.02, mLimb, pivot);                                  // sweeps back
      this.limbSeg(sx * BOW_LIMB_MID[0], BOW_LIMB_MID[1], sx * BOW_LIMB_TIP[0], BOW_LIMB_TIP[1], 0.026, 0.016, mLimb, pivot); // recurve tip
      this.box(0.02, 0.034, 0.02, mSteel, sx * BOW_LIMB_TIP[0], 0, BOW_LIMB_TIP[1], pivot);                                 // string nock
      this.bowLimbs.push(pivot);
    }
    // string: two halves (nock → string centre), each a unit box along its pivot's +X, turned / stretched by `poseBow`
    for (let i = 0; i < 2; i++) {
      const half = new THREE.Object3D();
      this.body.add(half);
      this.box(1, 0.004, 0.004, mString, 0.5, 0, 0, half);
      this.bowStrings.push(half);
    }
    // nocked arrow: tail on the string centre, along −Z over the shelf (the "magazine" object, but it never reloads)
    const mag = new THREE.Object3D(); mag.position.set(0, y, BOW_STRING_Z); this.body.add(mag);
    this.box(0.012, 0.012, 0.02, mDark, 0, 0, -0.005, mag);                                // nock
    this.tube(0.006, BOW_SHAFT_LEN, mShaft, 0, 0, -0.01 - BOW_SHAFT_LEN / 2, mag);         // shaft
    const head = this.box(0.014, 0.014, 0.06, mSteel, 0, 0, -(BOW_ARROW_TIP - 0.03), mag); head.rotation.z = Math.PI / 4;
    this.box(0.004, 0.04, 0.08, mString, 0, 0, -0.07, mag);                                 // fletching
    this.box(0.04, 0.004, 0.08, mString, 0, 0, -0.07, mag);
    this.bowArrow = mag; this.bowArrowBase.copy(mag.position);
    // short stabiliser forward under the shelf
    this.box(0.02, 0.02, 0.03, mDark, 0, y - 0.035, -0.07);
    this.tube(0.008, 0.16, mDark, 0, y - 0.035, -0.15);
    this.tube(0.015, 0.035, mDark, 0, y - 0.035, -0.24);
    this.muzzle.position.set(0, y, BOW_STRING_Z - BOW_ARROW_TIP - 0.01);
    this.ejectPort.position.set(0.03, y, -0.02);
    this.poseBow(0, 0);
    return mag;
  }

  /** A flat limb segment from (x0, z0) to (x1, z1) in `parent`'s XZ plane: `w` tall (Y), `d` thick. */
  private limbSeg(x0: number, z0: number, x1: number, z1: number, w: number, d: number, m: THREE.Material, parent: THREE.Object3D): void {
    const dx = x1 - x0, dz = z1 - z0;
    const seg = this.box(Math.hypot(dx, dz), w, d, m, (x0 + x1) / 2, 0, (z0 + z1) / 2, parent);
    seg.rotation.y = -Math.atan2(dz, dx);   // local +X → (dx, dz)
  }

  /**
   * 「롱혼」 pose for a pull `f` 0..1: limbs flex back, the string halves meet at the pulled centre, the arrow rides it.
   * Allocation-free (called every frame).
   */
  private poseBow(f: number, dt: number): void {
    const arrow = this.bowArrow;
    if (!arrow || this.bowLimbs.length !== 2 || this.bowStrings.length !== 2) return;
    const cz = BOW_STRING_Z + f * BOW_PULL;
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      const limb = this.bowLimbs[i];
      const a = -sx * BOW_FLEX * f;          // the tip swings back toward the archer
      limb.rotation.y = a;
      const c = Math.cos(a), s = Math.sin(a);
      const lx = sx * BOW_LIMB_TIP[0], lz = BOW_LIMB_TIP[1];
      const nx = limb.position.x + lx * c + lz * s;
      const nz = limb.position.z - lx * s + lz * c;
      const half = this.bowStrings[i];
      half.position.set(nx, BOW_Y, nz);
      const dx = -nx, dz = cz - nz;
      half.rotation.y = -Math.atan2(dz, dx);
      half.scale.x = Math.max(1e-4, Math.hypot(dx, dz));
    }
    if (this.bowLooseT > 0) this.bowLooseT = Math.max(0, this.bowLooseT - dt);
    arrow.visible = this.bowNocked && this.bowLooseT <= 0;
    arrow.position.set(this.bowArrowBase.x, this.bowArrowBase.y, this.bowArrowBase.z + f * BOW_PULL);
    arrow.rotation.set(0, 0, 0);
  }

  /** 「해머헤드」: fat launch tube with a flared front, shoulder rest, side grip and a flip-up sight. */
  private buildBazooka(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    const mOlive = this.mat(0x4d5a3a, 0.5, 0.6);
    const warhead = this.mat(0x7a2a1a, 0.5, 0.5);
    this.tube(0.075, 0.95, mOlive, 0, 0.11, -0.3);                         // main tube
    this.tube(0.09, 0.08, mDark, 0, 0.11, -0.8);                             // front flare
    this.tube(0.078, 0.02, mSteel, 0, 0.11, -0.74);
    this.tube(0.09, 0.06, mDark, 0, 0.11, 0.2);                              // rear venturi
    for (let i = 0; i < 3; i++) this.box(0.16, 0.012, 0.008, mAccent, 0, 0.11, -0.05 - i * 0.2); // bands
    this.box(0.045, 0.05, 0.12, mDark, 0, 0.19, -0.2);                     // sight block
    const sight = this.box(0.03, 0.06, 0.006, mSteel, 0, 0.245, -0.25); sight.rotation.x = -0.1;
    this.box(0.05, 0.03, 0.2, mMetal, 0, 0.03, 0.06);                      // trigger housing
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01); grip.rotation.x = -0.25;
    const fore = this.box(0.03, 0.09, 0.045, mDark, 0, -0.01, -0.36); fore.rotation.x = -0.15; // fore grip
    this.box(0.07, 0.06, 0.2, mMetal, 0, 0.04, 0.32);                      // shoulder rest
    this.box(0.08, 0.1, 0.03, mDark, 0, 0.03, 0.43);
    // loaded rocket visible in the muzzle (the animated "magazine")
    const mag = new THREE.Object3D(); mag.position.set(0, 0.11, -0.72); this.body.add(mag);
    this.tube(0.05, 0.14, warhead, 0, 0, -0.05, mag);
    this.muzzle.position.set(0, 0.11, -0.86);
    this.ejectPort.position.set(0.05, 0.11, 0.25);
    return mag;
  }

  /** 「사이클론」: six barrels around a hub (spun by `setSpin`), motor housing, top carry handle, ammo drum. */
  private buildMinigun(mMetal: THREE.Material, mSteel: THREE.Material, mAccent: THREE.Material, mDark: THREE.Material): THREE.Object3D {
    this.box(0.09, 0.11, 0.3, mMetal, 0, 0.09, 0.0);                       // motor housing
    this.box(0.1, 0.03, 0.3, mDark, 0, 0.16, 0.0);
    this.box(0.02, 0.05, 0.16, mAccent, 0.052, 0.1, 0.0);                  // side stripe
    this.box(0.03, 0.03, 0.2, mSteel, 0, 0.21, -0.02);                     // carry handle
    this.box(0.03, 0.05, 0.02, mSteel, 0, 0.19, 0.08);
    this.box(0.03, 0.05, 0.02, mSteel, 0, 0.19, -0.12);
    this.tube(0.05, 0.06, mSteel, 0, 0.09, -0.18);                          // front bearing plate
    this.tube(0.05, 0.05, mSteel, 0, 0.09, -0.62);                          // muzzle clamp
    // barrel cluster (rotates about local Z)
    const barrels = new THREE.Object3D(); barrels.position.set(0, 0.09, -0.4); this.body.add(barrels);
    this.tube(0.02, 0.5, mDark, 0, 0, 0, barrels);                          // axle
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.tube(0.009, 0.5, mSteel, Math.cos(a) * 0.036, Math.sin(a) * 0.036, 0, barrels);
    }
    this.barrels = barrels;
    const spade = this.box(0.04, 0.09, 0.05, mDark, 0, -0.04, -0.35); spade.rotation.x = -0.2; // fore grip
    const grip = this.box(0.035, 0.11, 0.05, mDark, 0, -0.05, 0.01); grip.rotation.x = -0.25;
    this.box(0.06, 0.07, 0.12, mMetal, 0, 0.06, 0.2);                      // rear block
    // ammo drum + feed chute (the animated "magazine")
    const mag = new THREE.Object3D(); mag.position.set(-0.03, 0.03, 0.05); this.body.add(mag);
    const drum = this.tube(0.06, 0.12, mMetal, -0.05, -0.04, 0, mag); drum.rotation.set(0, 0, Math.PI / 2);
    this.box(0.04, 0.03, 0.06, mAccent, -0.04, 0.0, 0, mag);               // chute
    this.muzzle.position.set(0, 0.09, -0.66);
    this.ejectPort.position.set(0.05, 0.06, 0.02);
    return mag;
  }

  /** Minigun barrel spin 0..1 (0 = still, 1 = full speed). No-op on other kinds. */
  setSpin(t: number): void { this.spin = t < 0 ? 0 : t > 1 ? 1 : t; }
  /** Flamethrower pilot / shock core glow 0..1 (spraying / arcing). No-op on other kinds. */
  setHeat(t: number): void { this.heat = t < 0 ? 0 : t > 1 ? 1 : t; }
  /** 2026-09-14: 「롱혼」 string draw 0..1 (0 = at rest) — string + nocked arrow pull back with it. No-op on other kinds. */
  setBowDraw(t: number): void { this.bowDraw = t < 0 ? 0 : t > 1 ? 1 : t; }
  /** 2026-09-15: 「롱혼」 has an arrow to nock (false = out of arrows — the string stays empty). No-op on other kinds. */
  setBowNocked(on: boolean): void { this.bowNocked = on; }
  /** 2026-09-15: 「롱혼」 an arrow just left — the string stays empty for `seconds` before the next arrow shows nocked. */
  bowLoose(seconds: number): void { if (seconds > this.bowLooseT) this.bowLooseT = seconds; }

  /* ─────────── laser sight (2026-09-14) ─────────── */
  /** A laser sight is mounted (`setAttachments({sight: 'laser'})`). */
  get hasLaser(): boolean { return this.laserPivot !== null; }

  /** Current barrel ↔ aim blend of the laser beam (0 = along the barrel). */
  get laserAimBlend(): number { return this.laserBlend; }

  /**
   * Turn the laser beam toward a world point (`null` = back along the barrel), blended over time. The beam leaves the
   * emitter lens; aimed, it is stretched to the point's distance (`LASER_AIM_MIN`–`LASER_AIM_MAX`). Call once per
   * frame after the model's pose is set (the local weapon only — replicas keep the barrel beam). No-op without a laser.
   */
  setLaserAim(target: THREE.Vector3 | null, dt: number): void {
    const pivot = this.laserPivot;
    if (!pivot) return;
    if (target) this.laserTarget.copy(target);
    this.laserBlend = damp(this.laserBlend, target ? 1 : 0, LASER_BLEND_RATE, Math.max(0, dt));
    if (!target && this.laserBlend < 0.002) this.laserBlend = 0;
    const t = this.laserBlend;
    if (t <= 0) { pivot.quaternion.identity(); pivot.scale.z = LASER_BARREL_LEN; return; }
    const parent = pivot.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    _lp.copy(pivot.position).applyMatrix4(parent.matrixWorld);
    _ld.subVectors(this.laserTarget, _lp);
    const dist = _ld.length();
    if (dist < 1e-3) { pivot.quaternion.identity(); pivot.scale.z = LASER_BARREL_LEN; return; }
    // the aim direction in the pivot's parent space (the body kicks / cants, so this is redone every frame)
    parent.getWorldQuaternion(_lq).invert();
    _ld.divideScalar(dist).applyQuaternion(_lq);
    _laim.setFromUnitVectors(_negZ, _ld);
    pivot.quaternion.slerpQuaternions(_lident, _laim, t);
    parent.getWorldScale(_ls);
    const s = Math.abs(_ls.z) > 1e-6 ? Math.abs(_ls.z) : 1;
    const aimLen = Math.min(LASER_AIM_MAX, Math.max(LASER_AIM_MIN, dist)) / s;
    pivot.scale.z = LASER_BARREL_LEN + (aimLen - LASER_BARREL_LEN) * t;
  }

  /* ─────────── animation ─────────── */
  kick(strength = 1): void {
    this.kickZ = Math.min(0.12, this.kickZ + 0.045 * strength);
    this.kickRot = Math.min(0.5, this.kickRot + 0.12 * strength);
  }
  /** progress 0..1 while reloading, -1 when idle */
  setReload(progress: number): void { this.reloadT = progress; }
  /** progress 0..1 while cycling the bolt (sniper), -1 when idle */
  setBolt(progress: number): void { this.boltT = progress; }
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
    // 2026-09-15: the bow never reloads (its arrows feed straight from the quiver) — no mag-drop animation for it
    if (this.reloadT >= 0 && this.mag && this.kind !== 'bow') {
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
    // bolt cycle: lift handle, pull back, push forward, drop
    if (this.bolt) {
      const b = this.bolt;
      if (this.boltT >= 0 && this.reloadT < 0) {
        const t = this.boltT;
        const lift = t < 0.2 ? t / 0.2 : t > 0.8 ? (1 - t) / 0.2 : 1;
        const pull = t < 0.2 ? 0 : t < 0.45 ? (t - 0.2) / 0.25 : t < 0.6 ? 1 : t < 0.8 ? 1 - (t - 0.6) / 0.2 : 0;
        b.rotation.z = easeOutCubic(lift) * 1.2;
        b.position.set(this.boltBase.x, this.boltBase.y, this.boltBase.z + easeOutCubic(pull) * 0.07);
        rz += Math.sin(t * Math.PI) * 0.18;           // slight cant as the hand works the bolt
        rx += Math.sin(t * Math.PI) * -0.08;
      } else {
        b.rotation.z = 0;
        b.position.copy(this.boltBase);
      }
    }
    this.body.rotation.set(rx, 0, rz);
    if (this.glowMat) this.glowMat.emissiveIntensity = 1.8 + Math.sin(time * 5) * 0.4;
    // unique extras: spinning barrels, bow draw, pilot / coil glow
    if (this.barrels && this.spin > 0) {
      this.barrelAngle += this.spin * 34 * dt;
      this.barrels.rotation.z = this.barrelAngle;
    }
    if (this.bowArrow) {
      // 2026-09-14: the local bow's draw (`setBowDraw`) pulls the string; the recoil kick still snaps it on release
      // (and is all a replica has — the draw is not on the wire). 2026-09-15: toward +Z, the archer's side.
      this.poseBow(Math.max(this.bowDraw, Math.min(1, this.kickZ / 0.06)), dt);
    }
    if (this.heatMat) this.heatMat.emissiveIntensity = 1.0 + this.heat * 2.4 + Math.sin(time * 9) * 0.25 * this.heat;
  }

  dispose(): void {
    this.clearAttachments();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.root.removeFromParent();
  }
}
