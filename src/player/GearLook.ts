import * as THREE from 'three';
import { Layers, type ArmorDef, type ItemCategory } from '@/shared';

/**
 * Procedural gear looks shared by the local soldier and the remote avatars (Phase 7):
 *  - `buildArmorPlate(def)`: the equipped 방탄복 as a chest / back / shoulder plate set tinted with `ArmorDef.color`,
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
    const m = new THREE.MeshStandardMaterial({ color, metalness, roughness });
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
    mesh.castShadow = true; mesh.receiveShadow = false;
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
 * torso's (chest centre ≈ y 0.22, front = -Z), matching `SoldierModel`'s shirt box (0.40 × 0.36 × 0.24) and the
 * arm pivots at ±0.24 / y 0.32 (Phase 10: the 3-heads-tall body is shorter, so every literal shrank with it).
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
  // chest plate: slightly wider / thicker than the shirt underneath so it reads from the front
  look.box(0.34, 0.26, 0.045, mPlate, 0, 0.23, -0.145);
  look.box(0.36, 0.045, 0.055, mEdge, 0, 0.375, -0.14);        // collar edge
  // back plate
  look.box(0.28, 0.24, 0.04, mPlate, 0, 0.24, 0.125);
  // shoulder caps over the sleeves
  for (const s of [-1, 1]) {
    const cap = look.sphere(0.105, mPlate, s * 0.235, 0.345, 0);
    cap.scale.set(1.05, 0.6, 1.05);
    look.box(0.07, 0.018, 0.15, mRib, s * 0.25, 0.4, 0);
  }
  // one rib per tier (I..V) — stacked on the chest plate like rank bars
  for (let i = 0; i < tier; i++) {
    look.box(0.04, 0.13, 0.012, mRib, -0.1 + i * 0.05, 0.23, -0.172);
  }
  if (unique) {
    // uniques: a glowing rim strip along the plate edge
    look.box(0.3, 0.012, 0.012, mRib, 0, 0.35, -0.172);
    look.box(0.3, 0.012, 0.012, mRib, 0, 0.11, -0.172);
  }
  return look;
}

/**
 * Held consumable / gadget for the right hand. Item axis: -Z along the arm (weaponSocket convention), so the
 * cylinder / box stand along the forearm and the sphere sits just past the hand. Phase 10: sized up for the
 * big hands of the 3-heads-tall body (~1.4× the old armoured trooper's props).
 */
export function buildHeldItem(category: ItemCategory | null | undefined): GearLook {
  const look = new Look();
  look.group.name = `HeldItem:${category ?? 'unknown'}`;
  if (category === 'stim') {
    const mBody = look.mat(0xd8e4ee, 0.3, 0.45);
    const mFluid = look.mat(0x3ad0ff, 0.1, 0.35, 0x3ad0ff, 0.8);
    const mTip = look.mat(0x8892a0, 0.6, 0.35);
    const body = look.cyl(0.04, 0.04, 0.21, mBody, 0, 0, -0.03); body.rotation.x = Math.PI / 2;
    const fluid = look.cyl(0.029, 0.029, 0.13, mFluid, 0, 0, -0.03); fluid.rotation.x = Math.PI / 2;
    const tip = look.cyl(0.009, 0.017, 0.06, mTip, 0, 0, -0.165); tip.rotation.x = Math.PI / 2;
  } else if (category === 'grenade') {
    const mShell = look.mat(0x4a5340, 0.35, 0.6);
    const mCap = look.mat(0x9aa4b0, 0.6, 0.35);
    const shell = look.sphere(0.075, mShell, 0, 0, -0.07); shell.scale.set(1, 1.15, 1);
    look.cyl(0.027, 0.027, 0.04, mCap, 0, 0.095, -0.07);
    look.box(0.07, 0.026, 0.016, mCap, 0.04, 0.07, -0.07);   // spoon
  } else {
    // gadget (and any other category): a boxy device with a status light
    const mCase = look.mat(0x2e3542, 0.4, 0.55);
    const mLight = look.mat(0x202020, 0.2, 0.5, 0xffb347, 1.0);
    look.box(0.11, 0.07, 0.18, mCase, 0, 0, -0.055);
    look.box(0.04, 0.016, 0.04, mLight, 0, 0.043, -0.085);
  }
  return look;
}
