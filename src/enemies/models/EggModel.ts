/**
 * src/enemies/models/EggModel.ts — **the bug-egg rig** (2026-09-18, user's decision 「the nest's decorative eggs become a destructible enemy」).
 *
 * Until 2026-09-18 an egg was a **decorative mesh** that `world/Nests` baked into one per nest. As a destructible enemy
 * the owner of the drawn body moved into this folder — the **look must stay the same**, so the old code's numbers were carried over verbatim (`world/Nests.ts`'s header comment says so too):
 *   `SphereGeometry(er, 8, 6)` stretched ×1.2 on y alone · a vertical gradient `0xb8a070` (bottom) → `0xe0d0a0` (top) ·
 *   `MeshStandardMaterial({ roughness: 0.35, metalness: 0, emissive: 0x6a5020, emissiveIntensity: 0.25 })` · `castShadow`.
 *   The spot (`NestEggSpot.position`) is the **drawn sphere's centre**, so the ground is `radius × 0.6` below it.
 *
 * - **Size differs per spot** (`NestEggSpot.radius` = 0.35~0.7 m). The geometry is baked once from the `bug_egg` radius in
 *   `data/enemies.csv`, and the instance fits its own size with `rig.baseScale` (`setEggScale`). The hit capsule follows
 *   the same multiplier — the egg is the only type with a **per-instance copy** of `EnemyStats` (`Enemy` constructor), so 「the drawn egg = the hitbox」.
 * - **Damage**: as hp drops, dark ruptures open in the shell one by one (`hurt` = 1 − hp/maxHp in `animateEgg`).
 *   A rupture is a lens that **grows in place**, so it sits on the shell surface, and on an intact egg `visible = false`
 *   means **zero draw calls** (which matters — a raid holds dozens of eggs). Once broken the shell collapses
 *   (y squashed · xz spread) and sinks into the ground by `anim.fade` with the ruptures wide open.
 * - **No light** (§4.5): the yolk glow inside is emissive only. The materials are two vertex-coloured `MeshStandardMaterial`s —
 *   the same program as the bug rig (shell · eyes), so no new shader variant appears.
 * - The geometry is baked once per type and shared (`assets`); only the materials are cloned per instance (the hit flash ·
 *   status glow are per instance — the same rule as the bug rig). `disposeEggAssets()` is called by `parts/Pool.disposePools`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers } from '@/shared';
import { ENEMY_STATS, type EggEnemyType } from '../EnemyTypes';
import type { BugAnim } from './BugModel';

export type EggType = EggEnemyType;

/* ── Drawing numbers (not balance — the tests use the radius · height from enemies.csv) ───────── */
/** The old `world/Nests` egg: the sphere is stretched by this much on y alone. */
export const EGG_Y_SCALE = 1.2;
/** The old `world/Nests` egg: the centre sits radius × this above the ground (the bottom is buried in the soil). */
export const EGG_CENTER_MUL = 0.6;
/** The old `world/Nests` sphere segments (kept as they were for the same silhouette). */
const EGG_SEG_W = 8;
const EGG_SEG_H = 6;
/** Shell gradient (the old `eggA` → `eggB`). */
const EGG_LOW = 0xb8a070;
const EGG_HIGH = 0xe0d0a0;
/** The old `eggMat`'s emissive colour · intensity (the yolk glow seeping out from inside). */
const EGG_EMISSIVE = 0x6a5020;
const EGG_EMISSIVE_I = 0.25;
/** The flesh inside a rupture (a dark red-brown like dried blood). */
const EGG_INNER = 0x4a2416;
/** Rupture count · distance from the shell surface (relative to the radius) · size when fully open (relative to the radius). */
const RUPTURES = 3;
const RUPTURE_SEAT = 0.9;
const RUPTURE_SIZE = 0.62;
/** Damage at which ruptures start to show (0..1) — if a graze already cracks it, there is no 「intact egg」 picture. */
const CRACK_START = 0.2;
/** How far a broken shell collapses (the floor of the y multiplier) · the multiplier by which it spreads sideways. */
const DEATH_SQUASH = 0.35;
const DEATH_SPREAD = 1.25;

/** The egg's drawing numbers — all of them come from that type's `enemies.csv` row (instance size is `rig.baseScale`). */
export interface EggParams {
  /** The 「head」 sphere shared code reads — height above the feet · forward distance · radius (`Enemy.headCenter`). An egg has no weak spot, so `headMul` is 1. */
  readonly head: { y: number; z: number; r: number };
  /** For the gait phase (it never walks, but shared code reads it). */
  readonly strideLength: number;
  /** csv shell radius (m) — an instance's real radius is this × `baseScale`. */
  readonly radius: number;
}

export interface EggRig {
  kind: 'egg';
  type: EggType;
  params: EggParams;
  /** Instance size multiplier (`NestEggSpot.radius` / the csv radius) — `Enemy.reset` uses it as the root scale. */
  baseScale: number;
  root: THREE.Group;
  /** The group that squashes shell + ruptures together (it also carries the centre height above the ground). */
  body: THREE.Group;
  shell: THREE.Mesh;
  /** Three ruptures — they grow **in place** with the damage (at 0, `visible` false = no draw call). */
  ruptures: THREE.Group[];
  shellMat: THREE.MeshStandardMaterial;
  innerMat: THREE.MeshStandardMaterial;
}

interface EggAssets {
  shell: THREE.BufferGeometry;
  rupture: THREE.BufferGeometry;
}

const assets = new Map<EggType, EggAssets>();
let materials: { shell: THREE.MeshStandardMaterial; inner: THREE.MeshStandardMaterial } | null = null;
const _color = new THREE.Color();
const _lo = new THREE.Color();
const _hi = new THREE.Color();

/** The same trick as the old `world/build.paintGradient` — two colours mixed along y and baked into vertex colours. */
function paintGradient(geo: THREE.BufferGeometry, lo: number, hi: number, y0: number, y1: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  _lo.setHex(lo); _hi.setHex(hi);
  const pos = g.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  const span = Math.max(1e-4, y1 - y0);
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - y0) / span));
    _color.copy(_lo).lerp(_hi, t);
    arr[i * 3] = _color.r; arr[i * 3 + 1] = _color.g; arr[i * 3 + 2] = _color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function flat(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  _color.setHex(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _color.r; arr[i * 3 + 1] = _color.g; arr[i * 3 + 2] = _color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[enemies] egg mergeGeometries failed');
  merged.computeBoundingSphere();
  return merged;
}

/** The egg shell — the same sphere as the old decorative egg (segments · y squash · gradient included). Centred on the origin. */
function buildShell(r: number): THREE.BufferGeometry {
  const sph = new THREE.SphereGeometry(r, EGG_SEG_W, EGG_SEG_H);
  sph.scale(1, EGG_Y_SCALE, 1);
  return paintGradient(sph, EGG_LOW, EGG_HIGH, -r * EGG_Y_SCALE, r * EGG_Y_SCALE);
}

/**
 * One rupture — a flat lump half-sunk into the shell (origin-centred, +Z outward). The parent group seats it on the
 * shell surface and orients it, so `scale` alone makes it **grow in place** (it does not shrink toward the origin = the growing picture really shows).
 */
function buildRupture(r: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const lens = new THREE.SphereGeometry(1, 6, 4);
  lens.scale(r * RUPTURE_SIZE, r * RUPTURE_SIZE * 0.72, r * 0.2);
  parts.push(flat(lens, EGG_INNER));
  return merge(parts);
}

function getMaterials(): NonNullable<typeof materials> {
  if (materials) return materials;
  materials = {
    shell: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.35, metalness: 0, emissive: EGG_EMISSIVE, emissiveIntensity: EGG_EMISSIVE_I }),
    inner: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0, emissive: EGG_EMISSIVE, emissiveIntensity: EGG_EMISSIVE_I * 2 }),
  };
  return materials;
}

function eggParams(type: EggType): EggParams {
  const st = ENEMY_STATS[type];
  const r = Math.max(0.05, st.radius);
  /* The head sphere is always **inside** the shell and `headMul` is 1, so it changes no test (a body with no weak spot).
     It is still not left at 0 because `raycastEx`'s broad-phase radius adds this value in. */
  return { head: { y: r * EGG_CENTER_MUL, z: 0, r: st.headRadius }, strideLength: 1, radius: r };
}

function getAssets(type: EggType): EggAssets {
  const have = assets.get(type);
  if (have) return have;
  const p = eggParams(type);
  const built: EggAssets = { shell: buildShell(p.radius), rupture: buildRupture(p.radius) };
  assets.set(type, built);
  return built;
}

/** Releases the shared geometries · template materials (dispose the rigs first). */
export function disposeEggAssets(): void {
  for (const a of assets.values()) { a.shell.dispose(); a.rupture.dispose(); }
  assets.clear();
  if (materials) { materials.shell.dispose(); materials.inner.dispose(); materials = null; }
}

export function createEggRig(type: EggType = 'bug_egg'): EggRig {
  const a = getAssets(type);
  const m = getMaterials();
  const p = eggParams(type);
  const shellMat = m.shell.clone();
  const innerMat = m.inner.clone();

  const root = new THREE.Group();
  root.name = `egg_${type}`;
  const body = new THREE.Group();
  // the same spot as the old decorative egg: the sphere centre sits radius × 0.6 above the ground (the bottom is buried)
  body.position.y = p.radius * EGG_CENTER_MUL;
  root.add(body);

  const shell = new THREE.Mesh(a.shell, shellMat);
  shell.castShadow = true;
  shell.layers.enable(Layers.ENEMY);
  body.add(shell);

  const ruptures: THREE.Group[] = [];
  for (let i = 0; i < RUPTURES; i++) {
    const g = new THREE.Group();
    // different bearing · height so the three never line up — seated on the shell surface, facing outward (+Z after the rotation)
    const yaw = (i / RUPTURES) * Math.PI * 2 + 0.6;
    const pitch = (i - 1) * 0.42;
    g.rotation.set(pitch, yaw, 0, 'YXZ');
    g.position.set(
      Math.sin(yaw) * Math.cos(pitch) * p.radius * RUPTURE_SEAT,
      Math.sin(pitch) * p.radius * EGG_Y_SCALE * RUPTURE_SEAT,
      Math.cos(yaw) * Math.cos(pitch) * p.radius * RUPTURE_SEAT,
    );
    g.visible = false;                       // an intact egg draws the shell and nothing else
    const mesh = new THREE.Mesh(a.rupture, innerMat);
    mesh.layers.enable(Layers.NO_RAYCAST);   // the only test is the shell capsule
    g.add(mesh);
    body.add(g);
    ruptures.push(g);
  }

  return { kind: 'egg', type, params: p, baseScale: 1, root, body, shell, ruptures, shellMat, innerMat };
}

/**
 * Fits this instance to its egg spot's radius (m, `NestEggSpot.radius`). `Enemy.reset` uses `rig.baseScale` as the root
 * scale, so it is called **right before the spawn**. The hit capsule is the caller's job (`NestDirector`), which puts the same multiplier into the per-instance `EnemyStats`.
 */
export function setEggScale(rig: EggRig, radius: number): void {
  const r = Number.isFinite(radius) && radius > 0 ? radius : rig.params.radius;
  rig.baseScale = r / rig.params.radius;
}

export function disposeEggRig(rig: EggRig): void {
  rig.shellMat.dispose();
  rig.innerMat.dispose();
  rig.root.removeFromParent();
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * One frame's pose. `hurt` = 1 − hp / maxHp (0 intact … 1 about to break) — host and replica both hold `hp` (it rides the
 * snapshot), so both draw the same picture with no extra wire field. No allocation.
 */
export function animateEgg(rig: EggRig, a: BugAnim, hurt: number): void {
  const dying = a.death >= 0;
  const d = dying ? smooth(Math.min(1, a.death * 1.6)) : 0;
  const fade = dying ? smooth(Math.min(1, a.fade)) : 0;
  const r = rig.params.radius;

  // shell: a brief flinch on a hit; once broken it collapses and spreads sideways
  const wobble = a.flinch > 0.001 ? 1 + 0.06 * a.flinch * Math.sin(a.time * 33) : 1;
  rig.body.scale.set((1 + d * (DEATH_SPREAD - 1)) * (2 - wobble), (1 - d * (1 - DEATH_SQUASH)) * wobble, (1 + d * (DEATH_SPREAD - 1)) * (2 - wobble));
  // a broken shell sinks into the ground over the last `corpseFadeS` seconds of its lifetime
  rig.body.position.y = r * EGG_CENTER_MUL - fade * r * EGG_Y_SCALE * 2.2;

  // ruptures: they open one by one with the damage, and all three go wide once it breaks
  const open = Math.max(dying ? 1 : 0, hurt <= CRACK_START ? 0 : (hurt - CRACK_START) / (1 - CRACK_START));
  for (let i = 0; i < rig.ruptures.length; i++) {
    const g = rig.ruptures[i];
    // one after another — the first almost at once, the last when the hp is nearly gone
    const k = Math.max(0, Math.min(1, open * rig.ruptures.length - i));
    if (k <= 0.001) { if (g.visible) g.visible = false; continue; }
    if (!g.visible) g.visible = true;
    g.scale.setScalar(k);
  }

  /* Glow: the yolk light inside is always there (at a fixed intensity), and only the hit flash · burning · shock are laid on top.
     Why not `BugModel.statusEmissive` — with no status that function **clears the emissive to 0**, which would kill the egg's own yolk glow. */
  const glow = a.writhe * (0.32 + 0.18 * Math.abs(Math.sin(a.time * 17)));
  _color.setHex(EGG_EMISSIVE).multiplyScalar(dying ? 1 - d * 0.8 : 1);
  if (a.hitFlash > 0.001) { _color.r += 1.0 * a.hitFlash; _color.g += 0.7 * a.hitFlash; _color.b += 0.35 * a.hitFlash; }
  if (glow > 0.001) { _color.r += 1.0 * glow; _color.g += 0.32 * glow; _color.b += 0.05 * glow; }
  if (a.spark > 0.001) { _color.r += 0.35 * a.spark; _color.g += 0.85 * a.spark; _color.b += 1.1 * a.spark; }
  rig.shellMat.emissive.copy(_color);
  rig.innerMat.emissive.copy(_color);
}
