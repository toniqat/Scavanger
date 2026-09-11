import * as THREE from 'three';
import { Layers, PICKUP_PILLAR_HEIGHT, PICKUP_PILLAR_OPACITY, type ItemCategory, type ItemDef } from '@/shared';

/**
 * Height of the additive locator pillar above the item. Phase 10: shortened from a 5.5 m column to
 * `PICKUP_PILLAR_HEIGHT` and faded to transparent upward (baked vertex colours). The old name is kept as an
 * export — other code may read it.
 */
export const BEAM_HEIGHT = PICKUP_PILLAR_HEIGHT;
/** Radii of the pillar: narrower at the top so it reads as a beam of light, not a fence post. */
const PILLAR_RADIUS_BOTTOM = 0.15;
const PILLAR_RADIUS_TOP = 0.045;
/** Fade exponent: > 1 keeps the ground end solid and thins the upper half faster. */
const PILLAR_FADE_POW = 1.35;

/**
 * Bake a vertical fade into a geometry's vertex colours: white at y = 0, black at y = `height`. With
 * `AdditiveBlending` black **is** transparent, so the pillar dissolves upward with no custom shader — and the
 * per-visual material tint still multiplies through (`material.color × vertexColor`).
 */
function bakeUpwardFade(geo: THREE.BufferGeometry, height: number): void {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, pos.getY(i) / height));
    const k = Math.pow(1 - t, PILLAR_FADE_POW);
    colors[i * 3] = k; colors[i * 3 + 1] = k; colors[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
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
  /* appended: 2026-09-08 — 임플란트 (small capsule) */
  implant: 0.08,
  /* appended: 2026-09-11 온실 개편 — 작물은 약초처럼 낮게 눕고, 토양은 한 자루라 재료 상자와 같은 높이다.
     둘 다 `crate` 실루엣(default 가지)을 타고 색은 def 의 등급색이다 (`CATEGORY_COLOR.crop/soil` 은 목록 · 탭용). */
  crop: 0.07,
  soil: 0.14,
  /* appended: 2026-09-11 연구실 — 표본은 작은 채집물이라 약초처럼 낮게 눕고, 준비물은 몸에 두르는 장구라
     가방보다 조금 낮게 선다. 둘 다 `crate` 실루엣(default 가지)을 타고 색은 def 의 등급색이다. */
  sample: 0.07,
  prep: 0.15,
  /* appended: 2026-09-11 주방 · 프린터 (A-3c · A-15) — 셋 다 자기 실루엣이 있다 (아래 `create` 의 가지).
     요리는 그릇이라 바닥에 놓이고, 주머니는 가방보다 작으니 조금 낮게 서고, 열쇠(키카드)는 서적처럼 납작하게 눕는다. */
  meal: 0.06,
  pouch: 0.12,
  key: 0.05,
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
  // 2026-09-11 (A-3c): 요리 — 위가 넓은 얕은 그릇 + 가득 담긴 내용물(accent)
  private readonly mealBowl = new THREE.CylinderGeometry(0.17, 0.11, 0.09, 14);
  private readonly mealFill = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 14);
  // 2026-09-11 (A-15): 주머니 — 납작한 파우치 + 덮개 + 멜빵 (가방보다 한 치수 작다)
  private readonly pouchBody = new THREE.BoxGeometry(0.26, 0.2, 0.12);
  private readonly pouchFlap = new THREE.BoxGeometry(0.275, 0.07, 0.135);
  private readonly pouchStrap = new THREE.BoxGeometry(0.05, 0.215, 0.145);
  // 2026-09-11 (A-15): 열쇠 — 자기 카드 한 장 + 자기 띠 + 칩
  private readonly keyCard = new THREE.BoxGeometry(0.2, 0.016, 0.3);
  private readonly keyStripe = new THREE.BoxGeometry(0.2, 0.022, 0.055);
  private readonly keyChip = new THREE.BoxGeometry(0.06, 0.024, 0.05);
  private readonly beamGeo = new THREE.CylinderGeometry(PILLAR_RADIUS_TOP, PILLAR_RADIUS_BOTTOM, BEAM_HEIGHT, 10, 1, true);
  private readonly ringGeo = new THREE.RingGeometry(0.28, 0.36, 24);

  constructor() {
    this.group.name = 'Pickups';
    this.beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    // Phase 10: one bake on the SHARED geometry — every pooled visual reuses it (no per-pickup attribute).
    bakeUpwardFade(this.beamGeo, BEAM_HEIGHT);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.geos.push(this.rifleBody, this.rifleBarrel, this.rifleGrip, this.rifleMag, this.pistolBody, this.pistolGrip,
      this.ammoBox, this.ammoStripe, this.stimBody, this.stimCap, this.grenadeBody, this.grenadeBand, this.gem, this.gemBase,
      this.crate, this.crateEdge, this.bookCover, this.bookPages, this.bookSpine,
      this.mealBowl, this.mealFill, this.pouchBody, this.pouchFlap, this.pouchStrap,
      this.keyCard, this.keyStripe, this.keyChip, this.beamGeo, this.ringGeo);
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
    // Phase 10: breathe around PICKUP_PILLAR_OPACITY (the geometry's vertex fade owns the vertical falloff).
    v.beamMat.opacity = resting ? PICKUP_PILLAR_OPACITY * (0.75 + 0.45 * s) : PICKUP_PILLAR_OPACITY * 0.25;
    v.ringMat.opacity = resting ? 0.35 + 0.35 * s : 0;
    // 2026-09-11: 빛기둥은 시체에만 선다 (사용자 결정) — 떨어진 아이템은 바닥 고리와 몸체 발광만 남는다.
    // 메시는 풀에 그대로 두고 감추기만 한다 (광원이 아니므로 개수 규칙과는 무관하다).
    v.beam.visible = false;
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
    // Phase 10: `vertexColors` drives the upward fade baked into `beamGeo`; the tint still multiplies through.
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: PICKUP_PILLAR_OPACITY, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
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
      /* 2026-09-11 (A-3c): 요리 — 얕은 그릇에 담겨 있다. 그릇이 bodyMat, 내용물이 accentMat 라
         등급색이 "담긴 것" 쪽에서 더 밝게 난다. */
      case 'meal': {
        m(this.mealBowl, bodyMat);
        m(this.mealFill, accentMat, 0, 0.035, 0);
        break;
      }
      /* 2026-09-11 (A-15): 주머니 — 가방(2×2)보다 한 치수 작은 파우치. 덮개 · 멜빵이 accentMat 다. */
      case 'pouch': {
        m(this.pouchBody, bodyMat);
        m(this.pouchFlap, accentMat, 0, 0.08, 0);
        m(this.pouchStrap, accentMat, 0, 0, 0);
        body.rotation.y = 0.28;
        break;
      }
      /* 2026-09-11 (A-15): 열쇠 — 자기 카드 한 장. 서적처럼 납작하게 눕고 띠 · 칩만 빛난다. */
      case 'key': {
        m(this.keyCard, bodyMat);
        m(this.keyStripe, accentMat, 0, 0.004, -0.1);
        m(this.keyChip, accentMat, -0.055, 0.005, 0.075);
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
    const cats: ItemCategory[] = ['primary', 'secondary', 'grenade', 'stim', 'ammo', 'valuable', 'material', 'book',
      /* 2026-09-11: 자기 실루엣을 가진 카테고리는 여기에 올린다 (`book` 이 만든 선례) — default 가지를 타는
         것들(작물 · 토양 · 표본 · 준비물 …)은 `material` 하나로 이미 덥혀 있다. */
      'meal', 'pouch', 'key'];
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
