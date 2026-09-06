import * as THREE from 'three';
import { Layers, type ItemCategory, type ItemDef } from '@/shared';

/** Height of the additive locator beam above the item (readable from ~30 m). */
export const BEAM_HEIGHT = 5.5;
/** Rest height of the body centre above the ground, per category (used by the physics too). */
const REST_Y: Record<ItemCategory, number> = {
  primary: 0.08, secondary: 0.06, grenade: 0.09, stim: 0.06, ammo: 0.09, valuable: 0.16, material: 0.14, attachment: 0.07, bag: 0.18,
  /* appended: tactical kit */
  armor: 0.12, gadget: 0.1, herb: 0.07,
  /* appended: ship housing */
  furniture: 0.16,
  /* appended: Phase 8 — 씨앗 (small pouch, sits low like a herb) */
  seed: 0.07,
  /* appended: Phase 9 — 서적 (flat, lies like a plate) */
  book: 0.06,
};

/**
 * One pooled pickup visual: tinted procedural body (per category silhouette), soft emissive pulse, additive
 * locator beam + ground ring. Bodies use shared per-category geometry; the tint material and beam material are
 * per visual (recoloured on reuse — no allocation after warm-up). No lights (constant scene light count).
 */
export interface PickupVisual {
  category: ItemCategory;
  root: THREE.Group;
  /** Body group (bobs / spins); the beam stays upright. */
  body: THREE.Group;
  beam: THREE.Mesh;
  ring: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  beamMat: THREE.MeshBasicMaterial;
  ringMat: THREE.MeshBasicMaterial;
  /** Per-visual pulse offset. */
  phase: number;
}

const _c = new THREE.Color();

function parseCss(css: string, out: THREE.Color): THREE.Color {
  try { out.setStyle(css); } catch { out.setHex(0xffffff); }
  return out;
}

export function restHeightFor(category: ItemCategory): number {
  return REST_Y[category] ?? 0.1;
}

/**
 * Factory + pool. `acquire(def)` returns a visual configured for the def (hidden until positioned),
 * `release(v)` hides it and returns it to the per-category free list.
 */
export class PickupVisualPool {
  readonly group = new THREE.Group();
  private readonly free = new Map<ItemCategory, PickupVisual[]>();
  private readonly all: PickupVisual[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];

  // shared geometry per category
  private readonly rifleBody = new THREE.BoxGeometry(0.78, 0.09, 0.05);
  private readonly rifleBarrel = new THREE.CylinderGeometry(0.014, 0.014, 0.42, 8);
  private readonly rifleGrip = new THREE.BoxGeometry(0.06, 0.12, 0.04);
  private readonly rifleMag = new THREE.BoxGeometry(0.05, 0.16, 0.04);
  private readonly pistolBody = new THREE.BoxGeometry(0.26, 0.07, 0.04);
  private readonly pistolGrip = new THREE.BoxGeometry(0.05, 0.12, 0.04);
  private readonly ammoBox = new THREE.BoxGeometry(0.32, 0.18, 0.16);
  private readonly ammoStripe = new THREE.BoxGeometry(0.33, 0.05, 0.17);
  private readonly stimBody = new THREE.CapsuleGeometry(0.045, 0.16, 4, 10);
  private readonly stimCap = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8);
  private readonly grenadeBody = new THREE.SphereGeometry(0.09, 12, 10);
  private readonly grenadeBand = new THREE.CylinderGeometry(0.092, 0.092, 0.03, 12);
  private readonly gem = new THREE.OctahedronGeometry(0.15, 0);
  private readonly gemBase = new THREE.CylinderGeometry(0.11, 0.13, 0.03, 8);
  private readonly crate = new THREE.BoxGeometry(0.28, 0.28, 0.28);
  private readonly crateEdge = new THREE.BoxGeometry(0.3, 0.05, 0.3);
  // Phase 9: 서적 — a flat slab (cover) with a lighter page block and a raised spine
  private readonly bookCover = new THREE.BoxGeometry(0.24, 0.045, 0.32);
  private readonly bookPages = new THREE.BoxGeometry(0.215, 0.05, 0.3);
  private readonly bookSpine = new THREE.BoxGeometry(0.035, 0.055, 0.325);
  private readonly beamGeo = new THREE.CylinderGeometry(0.05, 0.16, BEAM_HEIGHT, 10, 1, true);
  private readonly ringGeo = new THREE.RingGeometry(0.28, 0.36, 24);

  constructor() {
    this.group.name = 'Pickups';
    this.beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.geos.push(this.rifleBody, this.rifleBarrel, this.rifleGrip, this.rifleMag, this.pistolBody, this.pistolGrip,
      this.ammoBox, this.ammoStripe, this.stimBody, this.stimCap, this.grenadeBody, this.grenadeBand, this.gem, this.gemBase,
      this.crate, this.crateEdge, this.bookCover, this.bookPages, this.bookSpine, this.beamGeo, this.ringGeo);
  }

  acquire(def: ItemDef): PickupVisual {
    const cat = def.category;
    const list = this.free.get(cat);
    let v = list && list.length > 0 ? list.pop()! : this.create(cat);
    this.tint(v, def);
    v.root.visible = true;
    v.body.rotation.set(0, 0, 0);
    v.phase = Math.random() * Math.PI * 2;
    return v;
  }

  release(v: PickupVisual): void {
    v.root.visible = false;
    let list = this.free.get(v.category);
    if (!list) { list = []; this.free.set(v.category, list); }
    list.push(v);
  }

  /** Emissive pulse + beam breathing. `t` = ctx.time. */
  animate(v: PickupVisual, t: number, resting: boolean): void {
    const s = 0.5 + 0.5 * Math.sin(t * 3.2 + v.phase);
    v.bodyMat.emissiveIntensity = 0.18 + 0.42 * s;
    v.accentMat.emissiveIntensity = 0.4 + 0.8 * s;
    v.beamMat.opacity = resting ? 0.16 + 0.1 * s : 0.05;
    v.ringMat.opacity = resting ? 0.35 + 0.35 * s : 0;
    v.beam.visible = true;
    v.ring.visible = resting;
    if (resting) {
      v.body.rotation.y += 0.008;
      v.body.position.y = 0.03 * Math.sin(t * 2 + v.phase);
    }
  }

  private tint(v: PickupVisual, def: ItemDef): void {
    parseCss(def.color, _c);
    v.bodyMat.color.copy(_c).multiplyScalar(0.55).addScalar(0.12);
    v.bodyMat.emissive.copy(_c);
    v.accentMat.color.copy(_c);
    v.accentMat.emissive.copy(_c);
    v.beamMat.color.copy(_c);
    v.ringMat.color.copy(_c);
  }

  private create(cat: ItemCategory): PickupVisual {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0xffffff, emissiveIntensity: 0.3, metalness: 0.35, roughness: 0.5 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, metalness: 0.2, roughness: 0.4 });
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const root = new THREE.Group();
    const body = new THREE.Group();
    const m = (g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
      const mesh = new THREE.Mesh(g, mat); mesh.position.set(x, y, z); mesh.castShadow = true; body.add(mesh); return mesh;
    };
    switch (cat) {
      case 'primary': {
        m(this.rifleBody, bodyMat);
        const b = m(this.rifleBarrel, accentMat, 0.56, 0.01, 0); b.rotation.z = Math.PI / 2;
        m(this.rifleGrip, bodyMat, -0.12, -0.09, 0);
        m(this.rifleMag, accentMat, 0.08, -0.1, 0);
        body.rotation.z = 0.06;
        break;
      }
      case 'secondary': {
        m(this.pistolBody, bodyMat);
        m(this.pistolGrip, accentMat, -0.08, -0.08, 0);
        break;
      }
      case 'ammo': {
        m(this.ammoBox, bodyMat);
        m(this.ammoStripe, accentMat, 0, 0.02, 0);
        break;
      }
      case 'stim': {
        const c = m(this.stimBody, bodyMat); c.rotation.z = Math.PI / 2;
        const cap = m(this.stimCap, accentMat, 0.12, 0, 0); cap.rotation.z = Math.PI / 2;
        break;
      }
      case 'grenade': {
        m(this.grenadeBody, bodyMat);
        m(this.grenadeBand, accentMat);
        break;
      }
      case 'valuable': {
        m(this.gem, accentMat, 0, 0.02, 0);
        m(this.gemBase, bodyMat, 0, -0.15, 0);
        break;
      }
      case 'book': {
        m(this.bookCover, bodyMat);
        m(this.bookPages, accentMat, 0.012, 0, 0);
        m(this.bookSpine, accentMat, -0.115, 0, 0);
        body.rotation.y = 0.35;
        break;
      }
      case 'material':
      default: {
        m(this.crate, bodyMat);
        m(this.crateEdge, accentMat, 0, 0.13, 0);
        m(this.crateEdge, accentMat, 0, -0.13, 0);
        break;
      }
    }
    const beam = new THREE.Mesh(this.beamGeo, beamMat);
    beam.renderOrder = 21; beam.frustumCulled = false;
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.renderOrder = 21; ring.position.y = 0.02;
    root.add(body, beam, ring);
    root.traverse((o) => o.layers.enable(Layers.NO_RAYCAST));
    root.visible = false;
    this.group.add(root);
    const v: PickupVisual = { category: cat, root, body, beam, ring, bodyMat, accentMat, beamMat, ringMat, phase: 0 };
    this.all.push(v);
    return v;
  }

  /** Pre-create one visual per category so the first drop allocates nothing (and shaders can be warmed up). */
  warm(): void {
    const cats: ItemCategory[] = ['primary', 'secondary', 'grenade', 'stim', 'ammo', 'valuable', 'material', 'book'];
    for (const c of cats) {
      if ((this.free.get(c)?.length ?? 0) > 0) continue;
      const v = this.create(c);
      this.release(v);
    }
  }

  dispose(): void {
    for (const v of this.all) { v.bodyMat.dispose(); v.accentMat.dispose(); v.beamMat.dispose(); v.ringMat.dispose(); }
    for (const g of this.geos) g.dispose();
    this.all.length = 0; this.free.clear();
    this.group.removeFromParent();
  }
}
