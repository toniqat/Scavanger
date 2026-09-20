/**
 * src/enemies/models/named/SniperLook.ts — **the look of Roden (`rogue_sniper`)** (2026-09-11).
 *
 * On top of the base humanoid rogue rig:
 *  - **Anti-materiel rifle** — the base rifle mesh (`rig.gun`'s arms + rifle merged) is hidden, and the same `rig.gun`
 *    gets arms + a long barrel · flash hider · large scope · bipod (unfolded when prone). `rig.muzzle` moves to the
 *    flash hider's tip → `Enemy.muzzle` and `fireGun` fire from there.
 *  - **Ghillie cloak** — cloth and ragged strips on the shoulders · back, a hood on the head.
 *  - **Prone pose** — at `e.namedHint` 14 / 15 it overwrites the pose `animateRogue` set and lays `rig.body` forward.
 *    A body that dies prone does not stand up; it slumps sideways where it lies.
 *  - **Scope glint** — an additively blended `THREE.Sprite` (not a light). `sizeAttenuation: false` makes the **screen
 *    size independent of distance** = the world size grows with distance (readable past 200 m). It turns on only at hint
 *    15 (or the `ee glint` a replica received), and is brighter the more the scope faces the camera (`onBeforeRender`
 *    sets the opacity for that one draw only). A zoomed aim (narrowed FOV) scales it back so it does not cover the screen.
 *
 * Head test: a prone head sits 0.27 m up · 0.84 m forward, not where a standing one is (1.66 m). So this rig swaps
 * `rig.params` for a **per-rig copy** and moves `head.y / head.z` by the pose ratio every frame — `Enemy.headCenter`
 * (the headshot sphere) and `lookAtTarget` read those values. The shared `ROGUE_RIG_PARAMS` is left alone.
 *
 * Circular import: `RogueModel` is `import type` only. Geometries · textures are built per rig and disposed by
 * `disposeSniperLook` (at most one Roden per raid, so a shared cache buys nothing). Part meshes share the rig's `chitin` (the hit flash).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Layers, viewZoomK } from '@/shared';
import type { BugAnim } from '../BugModel';
import type { RogueRig, RogueRigParams } from '../RogueModel';
import type { Enemy } from '../../Enemy';
import { NAMED_SNIPER } from '../../EnemyTypes';

/* ── Colours (drawing constants) ────────────────────────────────────────── */
const C_CLOTH = 0x2e2c22;
const C_ARMOR = 0x4a4636;
const C_METAL = 0x3a3b37;
const C_DARK = 0x1c1d1b;
const C_FURN = 0x5a5238;
const C_LENS = 0x0c1418;
const GILLIE = [0x4f5a34, 0x5e5236, 0x3c4428, 0x6b6440] as const;

/* ── Rifle dimensions (rig.gun space: origin = right shoulder, +Z = muzzle direction) ── */
const RX = -0.05;
const RY = -0.08;
const SCOPE_Y = RY + 0.13;
const MUZZLE_Z = 1.66;

/* ── Prone pose ──────────────────────────────────────────────────────────── */
/** Pelvis pivot height when prone (m). */
const PRONE_Y = 0.14;
/** Angle that lays the body forward (rad) — +Y (body up) becomes +Z (front). */
const PRONE_PITCH = Math.PI / 2;
/** Lifts the chest a little while prone (negative = the shoulders rise). */
const PRONE_TORSO_X = -0.2;
/** Prone head centre computed from the two values above (height above the feet · forward distance, m) — `rig.params.head` follows it. */
const PRONE_HEAD_Y = 0.27;
const PRONE_HEAD_Z = 0.84;
/** Rifle pivot (shoulder) position when prone (body space). */
const PRONE_GUN_X = 0.17, PRONE_GUN_Y = 0.52, PRONE_GUN_Z = -0.08;

/* ── Prone body test (C-55) ──────────────────────────────────────────────────
 * Measured (2026-09-11, prone 1 · root coords, slope undone): legs z −1.05…−0.06 · y 0.03…0.36, pelvis y −0.02…0.28,
 * body + cloak z 0.12…0.74 · y 0.01…0.60 · |x| ≤ 0.31, head z 0.60…1.01 (own head sphere). → one capsule: back end
 * (z −0.80, y 0.20) · front end (z 0.50, y 0.30) · radius 0.25 — covers toes −1.05, shoulder front 0.75, top 0.55.
 * Only splayed toes (|x| 0.39) stick out (a standing capsule leaves elbows out too). Standing is the vertical capsule
 * in `raycastEx` (radius = stats.radius, feet + r … height − r); in between, ends · radius mix by the **visible ratio**. */
const BODY_BACK_Z = -0.8, BODY_BACK_Y = 0.2;
const BODY_FRONT_Z = 0.5, BODY_FRONT_Y = 0.3;
const BODY_PRONE_R = 0.25;

/* ── Scope glint ─────────────────────────────────────────────────────────── */
/** Sprite size relative to the screen height (no sizeAttenuation — view-space units × depth). */
const GLINT_SCALE = 0.05;

interface SniperLookState {
  kind: 'sniperLook';
  /** This rig's own copy of `rig.params` (the head position moves with the prone blend). */
  params: RogueRigParams;
  standHeadY: number;
  standHeadZ: number;
  /** 0 standing … 1 prone */
  prone: number;
  /** `prone` through smoothstep — the **visible** prone ratio the pose actually uses. The body test reads it (`sniperBodyCapsule`). */
  pose: number;
  /** 0..1 how far the glint is on */
  glint: number;
  /** Seconds since the glint turned on (bigger and brighter toward the end). */
  glintAge: number;
  /** Replica: seconds left to keep it on after `ee glint`, until the snapshot hint catches up. */
  glintHold: number;
  /** Final brightness `onBeforeRender` uses (before the facing factor). */
  glintOut: number;
  /** Zoomed-aim correction (from last frame's camera, ≤ 1). */
  fovK: number;
  /** Spots the first frame after the body was acquired from the pool again. */
  lastId: number;
  age: number;
  bipodLegs: THREE.Object3D[];
  sprite: THREE.Sprite;
  spriteMat: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture | null;
  geos: THREE.BufferGeometry[];
}

function lookOf(rig: RogueRig): SniperLookState | null {
  const s = rig.named as SniperLookState | undefined;
  return s && s.kind === 'sniperLook' ? s : null;
}

/* ── Geometry helpers (the same way as RogueModel's — a separate copy here because of the circular import) ── */
const _col = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function colorize(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _col.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, hex);
}
function rod(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, hex: number, taper = 0.85): THREE.BufferGeometry {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.CylinderGeometry(r * taper, r, len, 8, 1);
  g.translate(0, len / 2, 0);
  _b.sub(_a).normalize();
  _q.setFromUnitVectors(_up, _b);
  g.applyQuaternion(_q);
  g.translate(ax, ay, az);
  return colorize(g, hex);
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // BoxGeometry is indexed and so is CylinderGeometry — both carry the same attributes (position/normal/uv/color)
  const m = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!m) throw new Error('[enemies] sniper mergeGeometries failed');
  m.computeBoundingSphere();
  return m;
}
/** Deterministic 0..1 random (it only scatters the shape — not game state). */
function hash01(i: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function buildArmsAndRifle(): THREE.BufferGeometry {
  return merge([
    // arms — the right hand on the grip, the left on the handguard
    rod(0, 0, 0, 0.0, -0.17, 0.2, 0.045, C_CLOTH),
    rod(0.0, -0.17, 0.2, RX, -0.17, 0.33, 0.04, C_ARMOR),
    rod(-0.46, 0, 0, -0.34, -0.2, 0.3, 0.045, C_CLOTH),
    rod(-0.34, -0.2, 0.3, RX - 0.02, -0.14, 0.7, 0.04, C_ARMOR),
    // stock · cheek rest · grip
    box(0.06, 0.17, 0.05, RX, RY - 0.03, -0.03, C_DARK),
    box(0.05, 0.12, 0.3, RX, RY - 0.02, 0.13, C_FURN),
    box(0.052, 0.05, 0.16, RX, RY + 0.06, 0.1, C_FURN),
    box(0.045, 0.12, 0.06, RX, RY - 0.11, 0.32, C_DARK),
    // receiver · magazine · handguard · rail
    box(0.08, 0.1, 0.44, RX, RY, 0.5, C_METAL),
    box(0.055, 0.13, 0.1, RX, RY - 0.11, 0.5, C_DARK),
    box(0.075, 0.085, 0.34, RX, RY - 0.005, 0.88, C_FURN),
    box(0.03, 0.02, 0.62, RX, RY + 0.06, 0.5, C_DARK),
    // long barrel + flash hider
    rod(RX, RY, 1.02, RX, RY, 1.56, 0.024, C_METAL, 1),
    box(0.082, 0.066, 0.12, RX, RY, 1.6, C_DARK),
    box(0.088, 0.022, 0.028, RX, RY, 1.575, C_METAL),
    box(0.088, 0.022, 0.028, RX, RY, 1.625, C_METAL),
    // large scope: tube · objective bell · eyepiece · turrets · mount rings · lens
    rod(RX, SCOPE_Y, 0.3, RX, SCOPE_Y, 0.64, 0.036, C_DARK, 1),
    rod(RX, SCOPE_Y, 0.62, RX, SCOPE_Y, 0.75, 0.054, C_DARK, 0.7),
    rod(RX, SCOPE_Y, 0.23, RX, SCOPE_Y, 0.31, 0.046, C_DARK, 1.15),
    box(0.03, 0.045, 0.04, RX, SCOPE_Y + 0.05, 0.47, C_METAL),
    box(0.045, 0.03, 0.04, RX + 0.048, SCOPE_Y, 0.47, C_METAL),
    box(0.04, 0.07, 0.03, RX, RY + 0.085, 0.38, C_METAL),
    box(0.04, 0.07, 0.03, RX, RY + 0.085, 0.58, C_METAL),
    box(0.08, 0.08, 0.008, RX, SCOPE_Y, 0.752, C_LENS),
  ]);
}

function buildCloak(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    box(0.54, 0.1, 0.36, 0, 0.57, -0.02, GILLIE[0]),      // shoulder shawl
    box(0.46, 0.44, 0.06, 0, 0.32, -0.25, GILLIE[1]),     // back cover (over the pack)
    box(0.2, 0.12, 0.1, 0, 0.5, -0.3, GILLIE[2]),         // bunched cloth
  ];
  // strips hanging from the back — when prone they lie over the back toward the legs
  for (let i = 0; i < 11; i++) {
    const len = 0.16 + hash01(i) * 0.32;
    const x = -0.23 + i * 0.046;
    parts.push(box(0.034, len, 0.018, x, 0.52 - len / 2, -0.29 - (i % 2) * 0.016, GILLIE[i % GILLIE.length]));
  }
  // strips at the shoulder tips
  for (const side of [1, -1]) {
    for (let j = 0; j < 3; j++) {
      const len = 0.14 + hash01(20 + j * 3 + side) * 0.22;
      parts.push(box(0.03, len, 0.03, side * (0.27 + j * 0.012), 0.55 - len / 2, -0.1 + j * 0.09, GILLIE[(j + (side > 0 ? 1 : 2)) % GILLIE.length]));
    }
  }
  return merge(parts);
}

function buildHood(): THREE.BufferGeometry {
  return merge([
    box(0.33, 0.2, 0.34, 0, 0.07, -0.05, GILLIE[0]),
    box(0.36, 0.05, 0.18, 0, 0.13, 0.08, GILLIE[3]),
    box(0.04, 0.24, 0.02, 0.08, -0.07, -0.21, GILLIE[2]),
    box(0.04, 0.2, 0.02, -0.07, -0.05, -0.22, GILLIE[1]),
    box(0.035, 0.16, 0.02, 0.0, -0.03, -0.225, GILLIE[3]),
  ]);
}

/** Additively blended glint texture: a white core + a warm bleed + a long horizontal streak · a short vertical one. */
function makeGlintTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  const rad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rad.addColorStop(0, 'rgba(255,255,255,1)');
  rad.addColorStop(0.1, 'rgba(255,248,225,0.95)');
  rad.addColorStop(0.32, 'rgba(255,205,130,0.3)');
  rad.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = rad;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'lighter';
  const hor = g.createLinearGradient(0, 0, 128, 0);
  hor.addColorStop(0, 'rgba(255,230,190,0)');
  hor.addColorStop(0.5, 'rgba(255,250,235,0.9)');
  hor.addColorStop(1, 'rgba(255,230,190,0)');
  g.fillStyle = hor;
  g.fillRect(0, 62, 128, 4);
  const ver = g.createLinearGradient(0, 22, 0, 106);
  ver.addColorStop(0, 'rgba(255,230,190,0)');
  ver.addColorStop(0.5, 'rgba(255,250,235,0.7)');
  ver.addColorStop(1, 'rgba(255,230,190,0)');
  g.fillStyle = ver;
  g.fillRect(62, 22, 4, 84);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function noRaycast(): void { /* a sprite's raycast throws without a camera — the glint is nothing to hit */ }

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = THREE.MathUtils.lerp;

export function decorateSniperLook(rig: RogueRig): void {
  const mesh = (g: THREE.BufferGeometry): THREE.Mesh => {
    const m = new THREE.Mesh(g, rig.chitin);
    m.castShadow = true;
    m.layers.enable(Layers.ENEMY);
    return m;
  };
  // hide the base rifle (arms merged in) — the long sniper rifle takes its place on the same pivot
  for (const c of rig.gun.children) if ((c as THREE.Mesh).isMesh) c.visible = false;
  const rifleGeo = buildArmsAndRifle();
  rig.gun.add(mesh(rifleGeo));
  rig.muzzle.position.set(RX, RY, MUZZLE_Z + 0.06);

  // bipod: folded along the barrel while standing, unfolded downward when prone
  const legGeo = merge([box(0.02, 0.27, 0.02, 0, -0.135, 0, C_METAL), box(0.03, 0.02, 0.05, 0, -0.27, 0, C_DARK)]);
  const bipod = new THREE.Group();
  bipod.position.set(RX, RY - 0.045, 1.2);
  const legs: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const leg = mesh(legGeo);
    leg.position.x = side * 0.024;
    leg.userData.side = side;
    bipod.add(leg);
    legs.push(leg);
  }
  rig.gun.add(bipod);

  const cloakGeo = buildCloak();
  rig.torso.add(mesh(cloakGeo));
  const hoodGeo = buildHood();
  rig.head.add(mesh(hoodGeo));

  // scope glint — an additive sprite, not a light
  const texture = makeGlintTexture();
  const spriteMat = new THREE.SpriteMaterial({
    map: texture, color: 0xfff1d6, blending: THREE.AdditiveBlending, transparent: true,
    depthWrite: false, depthTest: true, sizeAttenuation: false, toneMapped: false, fog: false, opacity: 0,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(RX, SCOPE_Y, 0.8);
  sprite.renderOrder = 31;
  sprite.visible = false;
  sprite.raycast = noRaycast;
  rig.gun.add(sprite);

  const base = rig.params;
  const st: SniperLookState = {
    kind: 'sniperLook',
    params: { head: { r: base.head.r, y: base.head.y, z: base.head.z }, strideLength: base.strideLength },
    standHeadY: base.head.y,
    standHeadZ: base.head.z,
    prone: 0, pose: 0, glint: 0, glintAge: 0, glintHold: 0, glintOut: 0, fovK: 1,
    lastId: -1, age: 0,
    bipodLegs: legs,
    sprite, spriteMat, texture,
    geos: [rifleGeo, legGeo, cloakGeo, hoodGeo],
  };
  rig.params = st.params;   // the per-rig copy — the shared ROGUE_RIG_PARAMS is left alone
  rig.named = st;

  // for that one draw only: brighter the more the scope faces the camera; a zoomed aim shrinks next frame's size
  sprite.onBeforeRender = (_renderer, _scene, camera) => {
    const g = rig.gun.matrixWorld.elements;
    let fx = g[8], fy = g[9], fz = g[10];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const sp = sprite.matrixWorld.elements;
    const cm = camera.matrixWorld.elements;
    let cx = cm[12] - sp[12], cy = cm[13] - sp[13], cz = cm[14] - sp[14];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl; cy /= cl; cz /= cl;
    const f = THREE.MathUtils.smoothstep(fx * cx + fy * cy + fz * cz, 0.25, 0.95);
    spriteMat.opacity = Math.min(1, st.glintOut * (0.12 + 0.88 * f));
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) {
      // 2026-09-20: the same correction the animation LOD makes, from `shared/viewZoom` (it was a second copy of 70° here)
      st.fovK = Math.min(1, viewZoomK(pc.fov, pc.zoom) * 1.6);
    }
  };
}

/** When a replica receives `ee glint` — the glint turns on before snapshot hint 15 arrives. */
export function holdSniperGlint(rig: RogueRig, duration: number): void {
  const st = lookOf(rig);
  if (st) { st.glintHold = Math.max(0, duration); st.glintAge = 0; }
}

/** The shot (`ee snipe`) — turns the held glint off. */
export function clearSniperGlint(rig: RogueRig): void {
  const st = lookOf(rig);
  if (st) st.glintHold = 0;
}

export function animateSniperLook(rig: RogueRig, a: BugAnim, e: Enemy, dt: number): void {
  const st = lookOf(rig);
  if (!st) return;
  if (st.lastId !== e.id) { st.lastId = e.id; st.age = 0; st.glintHold = 0; st.glintAge = 0; st.glint = 0; }
  st.age += dt;
  const dying = a.death >= 0;

  /* ── prone ratio ── */
  const hint = e.namedHint;
  let target = hint === 14 || hint === 15 ? 1 : 0;
  if (dying) target = st.prone >= 0.5 ? 1 : 0;           // a body that dies prone does not stand up
  const rate = st.age < 0.6 ? 40 : target > st.prone ? 3.2 : 4.5;
  st.prone += (target - st.prone) * Math.min(1, dt * rate);
  if (Math.abs(st.prone - target) < 0.001) st.prone = target;
  const p = smooth(THREE.MathUtils.clamp(st.prone, 0, 1));
  st.pose = p;

  st.params.head.y = lerp(st.standHeadY, PRONE_HEAD_Y, p);
  st.params.head.z = lerp(st.standHeadZ, PRONE_HEAD_Z, p);

  // bipod
  for (let i = 0; i < st.bipodLegs.length; i++) {
    const leg = st.bipodLegs[i];
    const side = leg.userData.side as number;
    leg.rotation.set(lerp(-Math.PI / 2 + 0.08, 0.12, p), 0, side * lerp(0.05, 0.34, p));
  }

  /* ── scope glint ── */
  const glintOn = !dying && (hint === 15 || st.glintHold > 0);
  if (st.glintHold > 0) st.glintHold = Math.max(0, st.glintHold - dt);
  st.glintAge = glintOn ? st.glintAge + dt : 0;
  st.glint += ((glintOn ? 1 : 0) - st.glint) * Math.min(1, dt * (glintOn ? 14 : 8));
  if (st.glint < 0.005 && !glintOn) st.glint = 0;
  const sprite = st.sprite;
  if (st.glint > 0) {
    const ramp = THREE.MathUtils.clamp(st.glintAge / Math.max(0.1, NAMED_SNIPER.glintTime), 0, 1);
    const t = a.time;
    const flicker = 0.78 + 0.22 * Math.sin(t * 27.3) * Math.sin(t * 9.1 + 0.7);
    st.glintOut = st.glint * (0.55 + 0.45 * ramp) * flicker;
    const s = GLINT_SCALE * (0.6 + 0.7 * ramp) * (0.9 + 0.2 * flicker) * st.fovK;
    sprite.scale.set(s, s, 1);
    sprite.material.rotation = t * 0.6;
    if (!sprite.visible) sprite.visible = true;
  } else {
    st.glintOut = 0;
    if (sprite.visible) sprite.visible = false;
  }

  if (p <= 0.001) return;   // standing — animateRogue's pose is kept as it is

  /* ── overwrite with the prone pose (after animateRogue) ── */
  const fall = dying ? smooth(THREE.MathUtils.clamp(a.deathFall, 0, 1)) : 0;
  const side = a.deathDir === 1 ? 1 : a.deathDir === 0 ? -1 : 0;
  const bodyY = PRONE_Y - (dying ? smooth(a.fade) * 0.55 : 0);
  const flx = a.flinch * a.flinchZ * 0.12;
  const flr = a.flinch * a.flinchX * 0.2;
  const body = rig.body;
  body.position.set(lerp(body.position.x, 0, p), lerp(body.position.y, bodyY, p), lerp(body.position.z, 0, p));
  body.rotation.set(
    lerp(body.rotation.x, PRONE_PITCH + a.slopePitch + flx, p),
    lerp(body.rotation.y, a.slopeRoll + flr + side * fall * 0.45, p),   // prone puts the body axis (local Y) forward, so the side roll is Y
    lerp(body.rotation.z, 0, p),
  );

  for (const leg of rig.legs) {
    leg.hip.rotation.x = lerp(leg.hip.rotation.x, 0.05 + fall * 0.05, p);
    leg.hip.rotation.z = lerp(leg.hip.rotation.z, leg.side * 0.2, p);
    leg.knee.rotation.x = lerp(leg.knee.rotation.x, 0.14 - fall * 0.1, p);
  }

  const tx = PRONE_TORSO_X + fall * 0.18;                 // on death the chest settles onto the ground
  const torso = rig.torso;
  torso.rotation.set(lerp(torso.rotation.x, tx, p), lerp(torso.rotation.y, 0, p), lerp(torso.rotation.z, -a.headYaw * 0.3, p));

  const level = -(PRONE_PITCH + tx);                     // the angle that levels the head · rifle again
  const head = rig.head;
  head.rotation.set(
    lerp(head.rotation.x, level + a.headPitch * 0.6 + fall * 0.7, p),
    lerp(head.rotation.y, a.headYaw * 0.45, p),
    lerp(head.rotation.z, side * fall * 0.4, p),
  );

  const k = a.recoil * a.recoil;
  const gun = rig.gun;
  gun.position.set(
    lerp(gun.position.x, PRONE_GUN_X, p),
    lerp(gun.position.y, PRONE_GUN_Y - k * 0.07, p),      // body -Y = the back of a prone body — recoil pushes the shoulder
    lerp(gun.position.z, PRONE_GUN_Z, p),
  );
  gun.rotation.set(
    lerp(gun.rotation.x, level + a.headPitch * 0.9 - k * 0.14 + fall * 0.35, p),
    lerp(gun.rotation.y, a.headYaw * 0.5, p),
    lerp(gun.rotation.z, side * fall * 0.7, p),
  );
}

/** Visible prone ratio 0..1 (0 when this is not Roden's rig). */
export function sniperPoseOf(e: Enemy): number {
  const rig = e.rig;
  if (rig.kind !== 'rogue') return 0;
  const st = lookOf(rig);
  return st ? st.pose : 0;
}

/**
 * The body capsule of a prone (or going-prone) Roden — the end points go into `a` · `b` in world coordinates and the
 * radius is returned. Standing (ratio ≈ 0) gives -1 → the caller uses the vertical capsule instead. The slope
 * (`anim.slopePitch`) tilts it around the pelvis pivot (`PRONE_Y`) as the pose does — prone facing downhill drops the front end.
 */
export function sniperBodyCapsule(e: Enemy, a: THREE.Vector3, b: THREE.Vector3): number {
  const p = sniperPoseOf(e);
  if (p <= 0.001) return -1;
  const r = e.stats.radius, h = e.stats.height;
  const sp = e.anim.slopePitch * p;
  const cs = Math.cos(sp), sn = Math.sin(sp);
  // mix the standing capsule ends (feet + r · height − r, z 0) with the prone ends by the visible ratio, then turn by the slope
  bodyEnd(e, lerp(r, BODY_BACK_Y, p), BODY_BACK_Z * p, cs, sn, a);
  bodyEnd(e, lerp(Math.max(r, h - r), BODY_FRONT_Y, p), BODY_FRONT_Z * p, cs, sn, b);
  return lerp(r, BODY_PRONE_R, p);
}

/** Turns one root-space point (y, z) by the slope (cos, sin) around the pelvis pivot into world space. A hot path — no closure. */
function bodyEnd(e: Enemy, y: number, z: number, cs: number, sn: number, out: THREE.Vector3): void {
  const yl = y - PRONE_Y;
  const yy = PRONE_Y + yl * cs - z * sn;
  const zz = yl * sn + z * cs;
  out.set(e.position.x + Math.sin(e.yaw) * zz, e.position.y + yy, e.position.z + Math.cos(e.yaw) * zz);
}

/** Body centre height for the blast test (above the feet, m) — half the height standing, the middle of the capsule (≈ 0.25) prone. */
export function sniperBodyCenterY(e: Enemy): number {
  return lerp(e.stats.height * 0.5, (BODY_BACK_Y + BODY_FRONT_Y) * 0.5, sniperPoseOf(e));
}

export function disposeSniperLook(rig: RogueRig): void {
  const st = lookOf(rig);
  if (!st) return;
  for (const g of st.geos) g.dispose();
  st.geos.length = 0;
  st.spriteMat.dispose();
  st.texture?.dispose();
  st.sprite.removeFromParent();
  rig.named = undefined;
}
