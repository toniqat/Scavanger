import * as THREE from 'three';
import { Layers, type ArmorDef, type ItemCategory, type WeaponClass } from '@/shared';
import { applySoldierRim } from './SoldierRim';

/**
 * Procedural gear looks shared by the local soldier and the remote avatars (Phase 7):
 *  - `buildArmorPlate(def)`: the equipped armor as a chest / back / shoulder plate set tinted with `ArmorDef.color`,
 *    one greeble strip per tier (I..V) and a brighter rim for uniques (tier 0). Parented into `SoldierModel.torso`
 *    by `SoldierModel.setArmor`, so the same rule renders the local `PlayerGear.armor` and a remote `ar` snapshot field.
 *  - `buildHeldItem(category)`: the consumable / gadget in the hand while `HOLDING_ITEM` — stim = cylinder,
 *    grenade = sphere, gadget (and anything else) = box. Parented into the right-hand `weaponSocket`
 *    (item -Z = along the arm, like a weapon) by `RemoteAvatar`.
 * Every look owns its geometries / materials and frees them in `dispose()`. No lights, no textures.
 */
export interface GearLook {
  readonly group: THREE.Group;
  /** Materials the owner may fade / grey together with the body. */
  readonly materials: THREE.Material[];
  dispose(): void;
}

const _c = new THREE.Color();

function parseColor(css: string | undefined, fallback: number): number {
  if (!css) return fallback;
  try { _c.set(css); return _c.getHex(); } catch { return fallback; }
}

class Look implements GearLook {
  readonly group = new THREE.Group();
  readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  mat(color: number, metalness: number, roughness: number, emissive = 0, emissiveIntensity = 0): THREE.MeshStandardMaterial {
    // 2026-09-15 (D-7): plates / held items sit on the soldier — same fresnel rim program as the body (`SoldierRim`)
    const m = applySoldierRim(new THREE.MeshStandardMaterial({ color, metalness, roughness }));
    if (emissive) { m.emissive.setHex(emissive); m.emissiveIntensity = emissiveIntensity; }
    this.materials.push(m);
    return m;
  }
  box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d); this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z);
    this.finish(mesh); this.group.add(mesh); return mesh;
  }
  sphere(r: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const g = new THREE.SphereGeometry(r, 14, 10); this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z);
    this.finish(mesh); this.group.add(mesh); return mesh;
  }
  cyl(rt: number, rb: number, h: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
    const g = new THREE.CylinderGeometry(rt, rb, h, 12); this.geometries.push(g);
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z);
    this.finish(mesh); this.group.add(mesh); return mesh;
  }
  private finish(mesh: THREE.Mesh): void {
    // 2026-09-20 (`docs/PERF_PLAN.md` Phase 1): armour plates · held items sit **on** the soldier, so their shadow
    // landed inside the body's. The body keeps casting (`SoldierModel`'s torso · head · limbs); these 9-14 meshes
    // were 9-14 extra shadow draws per body, and the render block is the frame.
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.layers.enable(Layers.NO_RAYCAST);
  }
  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Chest plate + back plate + two shoulder caps over the torso, tinted by the armor's CSS colour. Tier I..V adds
 * one accent rib per tier on the chest; tier 0 (unique) gets an emissive rim instead. Local coordinates are the
 * torso's (chest centre ≈ y 0.33, front = -Z), matching `SoldierModel`'s chest box (0.44 × 0.5 × 0.28).
 */
export function buildArmorPlate(def: ArmorDef): GearLook {
  const look = new Look();
  look.group.name = `ArmorPlate:${def.id}`;
  const base = parseColor(def.color, 0x5a6472);
  const tier = Math.max(0, Math.min(5, Math.round(def.tier ?? 0)));
  const unique = tier === 0;
  const mPlate = look.mat(base, 0.4, 0.5, unique ? base : 0, unique ? 0.35 : 0);
  _c.setHex(base).offsetHSL(0, -0.1, 0.18);
  const mRib = look.mat(_c.getHex(), 0.5, 0.4);
  _c.setHex(base).multiplyScalar(0.7);
  const mEdge = look.mat(_c.getHex(), 0.3, 0.6);
  // chest plate: slightly wider / thicker than the steel plate underneath so it reads from the front
  look.box(0.36, 0.34, 0.05, mPlate, 0, 0.34, -0.165);
  look.box(0.4, 0.05, 0.06, mEdge, 0, 0.53, -0.16);            // collar edge
  // back plate over the pack straps
  look.box(0.3, 0.3, 0.04, mPlate, 0, 0.36, 0.145);
  // shoulder caps on top of the pads
  for (const s of [-1, 1]) {
    const cap = look.sphere(0.145, mPlate, s * 0.27, 0.53, 0);
    cap.scale.set(1.05, 0.55, 1.05);
    look.box(0.08, 0.02, 0.18, mRib, s * 0.29, 0.61, 0);
  }
  // one rib per tier (I..V) — stacked on the chest plate like rank bars
  for (let i = 0; i < tier; i++) {
    look.box(0.05, 0.16, 0.012, mRib, -0.12 + i * 0.06, 0.34, -0.195);
  }
  if (unique) {
    // uniques: a glowing rim strip along the plate edge
    look.box(0.34, 0.012, 0.012, mRib, 0, 0.5, -0.195);
    look.box(0.34, 0.012, 0.012, mRib, 0, 0.18, -0.195);
  }
  return look;
}

/**
 * Held consumable / gadget for the right hand. Item axis: -Z along the arm (weaponSocket convention), so the
 * cylinder / box stand along the forearm and the sphere sits just past the glove.
 */
/**
 * 2026-09-15 (the gadget rework): `ItemCategory`'s `'grenade'` was removed (a grenade is `category: 'gadget'`
 * too), so the key that picks the held look is widened by one slot inside this file only — the caller passes
 * `def.grenade ? 'grenade' : def.category`.
 */
export type HeldItemLook = ItemCategory | 'grenade';

/** The stand-in gun + its muzzle spot (`buildHeldWeapon`). */
export interface WeaponLook extends GearLook {
  /** The muzzle tip — an android's muzzle flash · tracers start here. */
  readonly muzzle: THREE.Object3D;
}

/**
 * 2026-09-15 (android squadmates): the **stand-in for a gun** in the hand. A person's gun is drawn by
 * `weapons/WeaponModel`, but that is another folder's internals and cannot be used here (CLAUDE.md §4.1) — an
 * android only needs the silhouette to match, with no weapon grade · attachments, so it is a few boxes differing
 * only in length per class. The item axis contract is the held item's: **−Z runs forward along the arm**.
 */
export function buildHeldWeapon(cls: WeaponClass): WeaponLook {
  const look = new Look();
  look.group.name = `HeldWeapon:${cls}`;
  const short = cls === 'PISTOL';
  const long = cls === 'SR' || cls === 'DMR';
  const bodyLen = short ? 0.16 : long ? 0.44 : 0.32;
  const barrel = short ? 0.1 : long ? 0.4 : 0.24;
  const mBody = look.mat(0x2a2f38, 0.45, 0.5);
  const mSteel = look.mat(0x7c8796, 0.6, 0.4);
  look.box(0.06, 0.09, bodyLen, mBody, 0, 0, -bodyLen / 2 - 0.02);                       // receiver
  look.box(0.034, 0.034, barrel, mSteel, 0, 0.015, -bodyLen - barrel / 2 - 0.02);        // barrel
  look.box(0.042, 0.09, 0.05, mBody, 0, -0.07, -0.05);                                   // grip
  if (!short) look.box(0.05, 0.07, 0.14, mBody, 0, -0.005, 0.06);                        // stock
  if (cls === 'SG') look.box(0.03, 0.03, bodyLen * 0.8, mSteel, 0, -0.045, -bodyLen / 2); // tube magazine
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0.015, -(bodyLen + barrel + 0.02));
  look.group.add(muzzle);
  return { group: look.group, materials: look.materials, muzzle, dispose: () => look.dispose() };
}

export function buildHeldItem(category: HeldItemLook | null | undefined): GearLook {
  const look = new Look();
  look.group.name = `HeldItem:${category ?? 'unknown'}`;
  if (category === 'stim') {
    const mBody = look.mat(0xd8e4ee, 0.3, 0.45);
    const mFluid = look.mat(0x3ad0ff, 0.1, 0.35, 0x3ad0ff, 0.8);
    const mTip = look.mat(0x8892a0, 0.6, 0.35);
    const body = look.cyl(0.028, 0.028, 0.16, mBody, 0, 0, -0.02); body.rotation.x = Math.PI / 2;
    const fluid = look.cyl(0.02, 0.02, 0.1, mFluid, 0, 0, -0.02); fluid.rotation.x = Math.PI / 2;
    const tip = look.cyl(0.006, 0.012, 0.05, mTip, 0, 0, -0.125); tip.rotation.x = Math.PI / 2;
  } else if (category === 'grenade') {
    const mShell = look.mat(0x4a5340, 0.35, 0.6);
    const mCap = look.mat(0x9aa4b0, 0.6, 0.35);
    const shell = look.sphere(0.055, mShell, 0, 0, -0.05); shell.scale.set(1, 1.15, 1);
    look.cyl(0.02, 0.02, 0.03, mCap, 0, 0.07, -0.05);
    look.box(0.05, 0.02, 0.012, mCap, 0.03, 0.05, -0.05);    // spoon
  } else {
    // gadget (and any other category): a boxy device with a status light
    const mCase = look.mat(0x2e3542, 0.4, 0.55);
    const mLight = look.mat(0x202020, 0.2, 0.5, 0xffb347, 1.0);
    look.box(0.08, 0.05, 0.13, mCase, 0, 0, -0.04);
    look.box(0.03, 0.012, 0.03, mLight, 0, 0.031, -0.06);
  }
  return look;
}
