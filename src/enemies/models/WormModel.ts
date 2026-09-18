/**
 * src/enemies/models/WormModel.ts — **the sandworm rig** (2026-09-13).
 *
 * Like Dune's sandworm: a huge segmented body risen out of the ground, four jaws opening like petals · a ring of teeth
 * lining the inside · a faintly glowing throat. Procedural geometry with no external assets, and **no lights** (the throat is emissive).
 *
 * - The materials are the same two as the bug rig: a vertex-coloured `MeshStandardMaterial` (skin · dirt mound) and one
 *   without vertex colours (the throat — the same program as the bug eyes), so no new shader variant appears even when a rig is first built mid-raid.
 *   (The director still builds one rig of this planet's type at `world:ready` and runs `ctx.shaders.warm` on it.)
 * - The segments are a chain of groups — each takes a share of the forward lean toward the top so the mouth faces the
 *   target. The hit capsule is `EnemySystem.raycastEx`'s vertical capsule (`enemies.csv` radius · height) as it is, and the lean is small enough to stay inside it.
 * - It uses `BugAnim` as it is: `mandible` = the mouth opening, `abdomen` = the throat heaving before a spit, `aim` = the
 *   lean while preparing acid, `shake` = shivering, `death` / `deathDir` / `fade` = toppling sideways and sinking into
 *   its burrow. The `sink` argument = the depth still underground while digging in (the dirt mound stays above ground, only the body goes down).
 * - 2026-09-15: **the young sandworm** `sandworm_weak` (threat 1) is this rig too. The geometry is baked per type — its
 *   own `enemies.csv` row (radius · height = the adult × `SANDWORM_WEAK_SCALE`) measures the segment length · jaws · mound,
 *   so `baseScale` is 1 for both and the hit capsule · the burrow depth (`stats.height` in `Enemy.startEmerge`) never drift from the drawing (scaling the root down would multiply the depth twice).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import { ENEMY_STATS, type WormEnemyType } from '../EnemyTypes';
import { statusEmissive, type BugAnim } from './BugModel';

export type WormType = WormEnemyType;

/* ── Drawing numbers (not balance — the tests use the radius · height · head sphere from enemies.csv) ── */
/** Segment count. */
const SEGMENTS = 9;
/** Jaw count. */
const JAWS = 4;
/** Depth the body starts buried at (m) — the body reads as continuing below the dirt mound. */
const BURIED_M = 0.8;
/** Bottom segment radius = the test radius × this value; the top segment × (this value − TAPER). */
const BASE_RADIUS_MUL = 0.92;
const TAPER = 0.24;
/** Total forward lean (rad), shared out toward the top while standing. */
const LEAN_REST = 0.3;
/** The adult's mouth distance forward (m) — a young one scales it down by the height ratio. */
const HEAD_Z_ADULT = 1.6;

const SKIN = 0xa68456;
const SKIN_DARK = 0x6a4b2d;
const RIDGE = 0x4f3620;
const TOOTH = 0xe6dac0;
const DIRT = 0x4e3c2b;

export interface WormParams {
  /** The mouth (head) sphere — height above the feet · forward distance · radius (`Enemy.headCenter`). */
  readonly head: { y: number; z: number; r: number };
  /** For the gait phase (it never moves, but shared code reads it). */
  readonly strideLength: number;
  /** Length of one segment (m). */
  readonly segLen: number;
  /** Test radius (m). */
  readonly radius: number;
}

export interface WormRig {
  kind: 'worm';
  type: WormType;
  params: WormParams;
  baseScale: number;
  root: THREE.Group;
  /** The whole body (digging in · the death sink lower this — the dirt mound stays on the root). */
  body: THREE.Group;
  segments: THREE.Group[];
  segMeshes: THREE.Mesh[];
  /** The mouth on the end of the top segment (its world position = where a spit comes from). */
  mouth: THREE.Group;
  jaws: THREE.Group[];
  mound: THREE.Mesh;
  skin: THREE.MeshStandardMaterial;
  throat: THREE.MeshStandardMaterial;
}

interface WormAssets {
  segment: THREE.BufferGeometry;
  jaw: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  throat: THREE.BufferGeometry;
  mound: THREE.BufferGeometry;
}

/** Geometry per type (adult · young bake at different sizes). There is one material template. */
const assets = new Map<WormType, WormAssets>();
let materials: { skin: THREE.MeshStandardMaterial; dirt: THREE.MeshStandardMaterial; throatMat: THREE.MeshStandardMaterial } | null = null;
const tmpColor = new THREE.Color();

function colorize(geo: THREE.BufferGeometry, hex: number, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  tmpColor.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = jitter > 0 ? 1 + (Math.random() - 0.5) * jitter : 1;
    arr[i * 3] = Math.min(1, tmpColor.r * k); arr[i * 3 + 1] = Math.min(1, tmpColor.g * k); arr[i * 3 + 2] = Math.min(1, tmpColor.b * k);
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[enemies] worm mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

/** One segment (radius 1 · length `len`, base at y 0). The mesh's xz scale is the real radius. */
function buildSegment(len: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colorize(new THREE.CylinderGeometry(0.95, 1.0, len, 18, 3, true).translate(0, len * 0.5, 0), SKIN, 0.12));
  // the thick ring between segments (at the base) — the dark colour breaks the segments apart to the eye
  parts.push(colorize(new THREE.TorusGeometry(1.0, 0.11, 6, 18).rotateX(Math.PI / 2).translate(0, 0.06, 0), RIDGE, 0.1));
  // three dorsal scale plates (back · left · right)
  for (let k = 0; k < 3; k++) {
    const a = Math.PI + (k - 1) * 0.9;
    const plate = new THREE.SphereGeometry(1, 8, 6);
    plate.scale(0.34, len * 0.34, 0.12);
    plate.rotateY(a);
    plate.translate(Math.sin(a) * 0.96, len * 0.52, Math.cos(a) * 0.96);
    parts.push(colorize(plate, SKIN_DARK, 0.15));
  }
  return merge(parts);
}

/** One jaw — a curved petal whose root (y 0) sits on the mouth rim and reaches along +Y, with teeth on the inside (−Z). */
function buildJaw(len: number, width: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const petal = new THREE.SphereGeometry(1, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  petal.scale(width, len, width * 0.42);
  parts.push(colorize(petal, SKIN, 0.1));
  const teeth = 5;
  for (let i = 0; i < teeth; i++) {
    const t = (i + 0.5) / teeth;
    const cone = new THREE.ConeGeometry(width * 0.1, width * 0.55, 5);
    cone.rotateX(-Math.PI / 2 - 0.35);   // pointing inward · downward
    cone.translate((t - 0.5) * width * 1.2, len * (0.25 + 0.55 * (1 - Math.abs(t - 0.5))), -width * 0.3);
    parts.push(colorize(cone, TOOTH, 0.05));
  }
  return merge(parts);
}

/** The mouth rim ring + the inner teeth lining the throat. */
function buildRim(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colorize(new THREE.TorusGeometry(r, r * 0.12, 6, 20).rotateX(Math.PI / 2), RIDGE, 0.1));
  const ring = 14;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const cone = new THREE.ConeGeometry(r * 0.07, r * 0.42, 5);
    cone.rotateZ(Math.PI / 2 + 0.5);        // tilted toward the centre
    cone.rotateY(-a);
    cone.translate(Math.cos(a) * r * 0.78, -r * 0.05, Math.sin(a) * r * 0.78);
    parts.push(colorize(cone, TOOTH, 0.05));
  }
  return merge(parts);
}

/** The dirt mound — a flat hump + scattered clods. */
function buildMound(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
  dome.scale(r * 1.9, r * 0.45, r * 1.9);
  parts.push(colorize(dome, DIRT, 0.2));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
    const d = r * (1.7 + Math.random() * 0.8);
    const s = r * (0.18 + Math.random() * 0.16);
    const rock = new THREE.DodecahedronGeometry(s, 0);
    rock.translate(Math.cos(a) * d, s * 0.3, Math.sin(a) * d);
    parts.push(colorize(rock, DIRT, 0.3));
  }
  return merge(parts);
}

/** A type's drawing numbers — all of them from that type's `enemies.csv` row (for a young one the adult × `SANDWORM_WEAK_SCALE` is already written into the csv). */
function wormParams(type: WormType): WormParams {
  const st = ENEMY_STATS[type];
  const adult = ENEMY_STATS.sandworm;
  const segLen = (st.height + BURIED_M) / SEGMENTS;
  const headZ = HEAD_Z_ADULT * (adult.height > 0 ? st.height / adult.height : 1);
  return { head: { y: st.height * 0.9, z: headZ, r: st.headRadius }, strideLength: 1, segLen, radius: st.radius };
}

function getMaterials(): NonNullable<typeof materials> {
  if (materials) return materials;
  materials = {
    skin: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.1, emissive: 0x000000 }),
    dirt: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0.1, emissive: 0x000000 }),
    throatMat: new THREE.MeshStandardMaterial({ color: 0x250a06, emissive: 0xff5a1e, emissiveIntensity: 2.4, roughness: 0.3 }),
  };
  return materials;
}

function getAssets(type: WormType): WormAssets {
  const have = assets.get(type);
  if (have) return have;
  const p = wormParams(type);
  const topR = p.radius * (BASE_RADIUS_MUL - TAPER);
  const built: WormAssets = {
    segment: buildSegment(p.segLen),
    jaw: buildJaw(topR * 1.25, topR * 0.9),
    rim: buildRim(topR * 1.02),
    throat: new THREE.CircleGeometry(topR * 0.82, 20).rotateX(-Math.PI / 2),
    mound: buildMound(p.radius),
  };
  assets.set(type, built);
  return built;
}

/** Releases the shared geometries · template materials (dispose the rigs first). */
export function disposeWormAssets(): void {
  for (const a of assets.values()) {
    a.segment.dispose(); a.jaw.dispose(); a.rim.dispose(); a.throat.dispose(); a.mound.dispose();
  }
  assets.clear();
  if (materials) {
    materials.skin.dispose(); materials.dirt.dispose(); materials.throatMat.dispose();
    materials = null;
  }
}

export function createWormRig(type: WormType = 'sandworm'): WormRig {
  const a = getAssets(type);
  const m = getMaterials();
  const p = wormParams(type);
  const skin = m.skin.clone();
  const throat = m.throatMat.clone();
  const root = new THREE.Group();
  root.name = `worm_${type}`;

  const mound = new THREE.Mesh(a.mound, m.dirt);
  mound.receiveShadow = true;
  mound.layers.enable(Layers.NO_RAYCAST);
  root.add(mound);

  const body = new THREE.Group();
  body.position.y = -BURIED_M;
  root.add(body);

  const segments: THREE.Group[] = [];
  const segMeshes: THREE.Mesh[] = [];
  let parent: THREE.Object3D = body;
  for (let i = 0; i < SEGMENTS; i++) {
    const g = new THREE.Group();
    g.position.y = i === 0 ? 0 : p.segLen;
    const mesh = new THREE.Mesh(a.segment, skin);
    const r = p.radius * (BASE_RADIUS_MUL - TAPER * (i / (SEGMENTS - 1)));
    mesh.scale.set(r, 1, r);
    mesh.castShadow = true;
    mesh.layers.enable(Layers.ENEMY);
    g.add(mesh);
    parent.add(g);
    segments.push(g);
    segMeshes.push(mesh);
    parent = g;
  }

  const mouth = new THREE.Group();
  mouth.position.y = p.segLen;
  parent.add(mouth);
  const rim = new THREE.Mesh(a.rim, skin);
  rim.layers.enable(Layers.ENEMY);
  mouth.add(rim);
  const throatMesh = new THREE.Mesh(a.throat, throat);
  throatMesh.position.y = -0.25 * (p.radius / Math.max(0.01, ENEMY_STATS.sandworm.radius));
  throatMesh.layers.enable(Layers.ENEMY);
  mouth.add(throatMesh);

  const topR = p.radius * (BASE_RADIUS_MUL - TAPER);
  const jaws: THREE.Group[] = [];
  for (let k = 0; k < JAWS; k++) {
    const ang = (k / JAWS) * Math.PI * 2 + Math.PI / JAWS;
    const hinge = new THREE.Group();
    hinge.position.set(Math.sin(ang) * topR, 0, Math.cos(ang) * topR);
    hinge.rotation.y = ang;
    const tilt = new THREE.Group();   // rotation.x = the opening (+ = folded outward)
    const jm = new THREE.Mesh(a.jaw, skin);
    jm.castShadow = true;
    jm.layers.enable(Layers.ENEMY);
    tilt.add(jm);
    hinge.add(tilt);
    mouth.add(hinge);
    jaws.push(tilt);
  }

  return { kind: 'worm', type, params: p, baseScale: 1, root, body, segments, segMeshes, mouth, jaws, mound, skin, throat };
}

export function disposeWormRig(rig: WormRig): void {
  rig.skin.dispose();
  rig.throat.dispose();
  rig.root.removeFromParent();
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * One frame's pose. `sink` = the depth still underground while digging in (m, `Enemy.burrowSink`) — it lowers the body only and the dirt mound stays on the ground.
 * No allocation.
 */
export function animateWorm(rig: WormRig, a: BugAnim, sink: number): void {
  const t = a.time;
  const dying = a.death >= 0;
  const n = rig.segments.length;
  const d = dying ? smooth(Math.min(1, a.death * 1.4)) : 0;
  const side = a.deathDir === 1 ? 1 : a.deathDir === 0 ? -1 : 0;
  const shake = a.shake > 0 ? (Math.sin(t * 47) * 0.05 + Math.sin(t * 31) * 0.035) * a.shake : 0;
  const wr = a.writhe;

  // body: the burrow sink · shiver · death sink · fade
  rig.body.position.set(shake, -BURIED_M - sink - d * rig.params.segLen * 2.5 - smooth(Math.min(1, a.fade)) * rig.params.segLen * 4, shake * 0.6);

  const lean = LEAN_REST + a.aim * 0.18 + Math.sin(t * 0.55) * 0.05 + a.flinch * a.flinchZ * 0.12;
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += Math.pow((i + 1) / n, 1.5);
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const w = Math.pow(f, 1.5) / wsum;
    const g = rig.segments[i];
    const sway = Math.sin(t * 0.9 + i * 0.55) * 0.03 * f + Math.sin(t * 7.3 + i) * 0.06 * wr * f;
    // death: the forward lean grows and it curls sideways as it topples (deathDir 2 = it bends backward)
    const deathBend = side === 0 ? -d * 1.4 * w * n * 0.2 : d * 0.35 * w * n * 0.2;
    g.rotation.set(lean * w + deathBend + a.flinch * 0.02 * f, 0, sway + side * d * 1.7 * w + a.flinch * a.flinchX * 0.03 * f);
    // the heave before a spit: a bulging ring travelling from bottom to top
    const ripple = a.abdomen > 0.001 ? 1 + 0.14 * a.abdomen * Math.max(0, Math.sin(t * 8 - i * 0.85)) : 1;
    const m = rig.segMeshes[i];
    const r0 = rig.params.radius * (BASE_RADIUS_MUL - TAPER * (i / (n - 1)));
    m.scale.set(r0 * ripple, 1, r0 * ripple);
  }

  // mouth: it keeps opening and closing a little even at rest
  const open = dying ? THREE.MathUtils.lerp(Math.max(a.mandible, 0.2), 1.25, d) : Math.max(a.mandible, 0.12 + 0.08 * Math.sin(t * 1.3)) + wr * 0.3 * Math.abs(Math.sin(t * 9));
  for (let k = 0; k < rig.jaws.length; k++) {
    rig.jaws[k].rotation.x = -0.28 + open * 1.15 + Math.sin(t * 2.1 + k * 1.7) * 0.03;
  }

  statusEmissive(rig.skin, a, 1, 0.55, 0.3, 1.0);
  rig.throat.emissiveIntensity = dying ? 2.4 * (1 - smooth(Math.min(1, a.death / 0.6))) : 1.2 + open * 1.6 + a.abdomen * 1.2;
}
