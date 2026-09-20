/**
 * src/shared/shipModel.ts — **the one dropship mesh** (2026-09-21, user's decision).
 *
 * The ship the squad boards in the shared ship's hangar, the ship that flies the docking cutscene and the ship that
 * lands on an extraction pad used to be **three different models**: `hub/interiors/ExteriorShips.buildPersonalExterior`
 * drew a 9 m wedge, and `extraction/Ship.ts` drew the ~14 m "Pelican". Nothing tied them together, so the ship a
 * player walked into in the hangar was not the ship that came down in the raid. This file is the builder both folders
 * now call (CLAUDE.md §4.1 — the same code in two folders moves to `shared`; `hub` importing `extraction`'s internals
 * is not allowed).
 *
 * It owns **geometry only**. Flight, colliders, the bay's walk box and every event stay in `extraction/`; parking,
 * bay signs and the cutscene path stay in `hub/`.
 *
 * ── Two detail levels ────────────────────────────────────────────────────────────────────────────────
 * `'full'`     — the raid ship: the bay interior, its own material instances (so `setModel` can re-tint one ship
 *                without touching another) and every animated part as its own mesh. Nothing is merged, because
 *                `extraction/Ship` scales the gear, pulses the switch and dims the bay lamp separately, and
 *                `scripts/smoke-raidflow.mjs` walks `body.children` triangle by triangle to prove the rear doorway
 *                is open.
 * `'exterior'` — the hangar parks up to `NET_MAX_PLAYERS` of these at once and the cutscene flies one past the
 *                camera. No bay, **materials shared per model id** and everything but the ramp merged into one mesh
 *                per material (§4.5 — a body's cost is its triangles, and four unmerged hulls is a needless pile of
 *                draw calls on top of them). No greebles either: they are a close-up detail and the hangar never
 *                gets that close.
 *
 * ── Lights ───────────────────────────────────────────────────────────────────────────────────────────
 * **This file creates no light at all** (§4.5 — the scene's point-light count is part of the shader program key).
 * `extraction/Ship` keeps its three on `Dropship.root`, which stays visible for ever; the hangar and the cutscene
 * add none.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ══ ship models ══════════════════════════════════════════════════════════════════════════════════════
 * A **ship model id** is what a player owns (`PlayerProfile.shipModel`) and what decides the hull they see. The
 * registry is deliberately one row wide today: the shop is not built yet and inventing a second ship would be
 * inventing content. Adding one is a row here plus its colours — nothing else in `hub` / `extraction` changes.
 *
 * Colours, not geometry, are what a model varies **today**: re-tinting a material costs nothing and recompiles
 * nothing, so `Dropship.setShipModel` can run the moment a raid's extraction is called. A model that changes the
 * *shape* would have to rebuild the mesh, which is why that call sits before the ship is ever revealed.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Ship models a player can own. Add-only — a retired model must keep its row, or old profiles resolve to nothing. */
export type ShipModelId = 'dropship';

/** What one model looks like. `label` is the in-game (Korean) name a future shop would print. */
export interface ShipModelDef {
  readonly id: ShipModelId;
  readonly label: string;
  readonly hull: number;
  readonly hullDark: number;
  readonly accent: number;
  readonly glass: number;
  readonly glassEmissive: number;
}

/** Every ship model, by id. */
export const SHIP_MODELS: Record<ShipModelId, ShipModelDef> = {
  dropship: {
    id: 'dropship', label: '표준 수송선',
    hull: 0x5c6168, hullDark: 0x33373c, accent: 0xc9a03a, glass: 0x0f1a24, glassEmissive: 0x1a3550,
  },
};

/** The model every character starts with (and the fallback for an unknown id). */
export const DEFAULT_SHIP_MODEL: ShipModelId = 'dropship';

/** Model ids in registry order (a future shop lists them in this order). */
export const SHIP_MODEL_IDS: readonly ShipModelId[] = Object.keys(SHIP_MODELS) as ShipModelId[];

/** Is `v` a known model id? */
export function isShipModelId(v: unknown): v is ShipModelId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SHIP_MODELS, v);
}

/** Any stored / received value → a model id, falling back to `DEFAULT_SHIP_MODEL`. */
export function resolveShipModelId(v: unknown): ShipModelId {
  return isShipModelId(v) ? v : DEFAULT_SHIP_MODEL;
}

/** Definition of any stored / received value (never null). */
export function resolveShipModel(v: unknown): ShipModelDef {
  return SHIP_MODELS[resolveShipModelId(v)];
}

/**
 * The ship model carried by a profile, a lobby player or any other record that may hold one.
 *
 * It takes `unknown` rather than `PlayerProfile` / `LobbyPlayer` on purpose: the field is owned by
 * `shared/progression.ts` and `shared/net.ts`, and this accessor lets `hub` / `extraction` read it through one
 * function whether or not those two have grown it yet. An absent field is the default ship.
 */
export function shipModelOf(src: unknown): ShipModelId {
  const v = src && typeof src === 'object' ? (src as { shipModel?: unknown }).shipModel : undefined;
  return resolveShipModelId(v);
}

/* ══ geometry ═════════════════════════════════════════════════════════════════════════════════════════
 * Local −Z is the nose; the rear ramp opens toward +Z. The bay **deck plane** is local y = 0, so a landed ship is
 * walked into straight off the ground.
 *
 * ── Coplanar-surface budget (2026-09-15, moved here 2026-09-21) ──────────────────────────────────────
 * The ship's origin sits **on the ground** (`Dropship.floorYAt` = deck = local y 0, and `landPos.y` is the pad /
 * deck top), so anything drawn at exactly local y 0 is coplanar with the terrain the ship stands on — and any two
 * hull parts that share a face plane fight each other. Three of those existed and all three were reported as bugs:
 *   1. bay floor top = belly slab top = ground (y 0)          → "the bay floor is see-through, the ground shows"
 *   2. bay lining inner face = side slab inner face (x ±1.6)  → "the left/right wall colours swap every frame"
 *   3. bay ceiling bottom = hull roof bottom (y 2.6)          → the same flicker overhead
 * The constants below are the fix: the **drawn** deck is lifted a hair, the lining is given its own thickness and
 * the outer shell starts outboard of it. `Dropship.floorYAt` / `SHIP_BAY_HEIGHT` / `extraction/Hull.ts` are
 * untouched — the walking deck is still local y 0, feet just sink `SHIP_BAY_FLOOR_LIFT` into the plate.
 *
 * ── Ground clearance of the drawn deck (2026-09-15) ──────────────────────────────────────────────────
 * A world may **draw** its walkable ground above the height it reports for walking: the tutorial deck's textured top
 * plane sits `TOP_LIFT` = 0.02 above `DECK_LOWER_Y` (`world/tutorial/parts/Ground.ts`), a raid pad's chevrons 0.01
 * above the pad top (`world/Pads.ts`). Invariant, checked by `scripts/smoke-extraction.mjs`:
 *   `SHIP_BAY_FLOOR_LIFT − SHIP_GROUND_DRAW_LIFT_MAX ≥ 0.02`, and **`root.y` never goes below `landPos.y` while the
 *   ship is on the ground** (landed: no bob; liftoff spool: the shake is one-sided, ≥ 0).
 * A world that draws its ground higher than `SHIP_GROUND_DRAW_LIFT_MAX` above its walk height must raise it.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Bay floor rectangle in ship-local space (a player walks in from local +Z through the ramp). */
export const SHIP_BAY_HALF_W = 1.5;
export const SHIP_BAY_Z_MIN = -5.2;
export const SHIP_BAY_Z_MAX = 0.2;
export const SHIP_BAY_HEIGHT = 2.6;
/** Highest any world draws its walkable ground above the height `getSurfaceY` / the pad report (tutorial `TOP_LIFT`). */
export const SHIP_GROUND_DRAW_LIFT_MAX = 0.02;
/**
 * How far the **drawn** bay floor sits above the deck plane (local y 0) so it wins against ground + belly — 2 cm above
 * `SHIP_GROUND_DRAW_LIFT_MAX` (see the clearance note). Feet sink this much into the plate; the open ramp's top is at 0.07.
 */
export const SHIP_BAY_FLOOR_LIFT = SHIP_GROUND_DRAW_LIFT_MAX + 0.02;

/** Outer face of the side slabs (hull half width). */
const HULL_HALF_W = 2.1;
/** Bay lining walls: inner face (the walkable opening) and their thickness → outer face `BAY_LINING_OUTER_X`. */
const BAY_LINING_INNER_X = 1.6;
const BAY_LINING_T = 0.12;
const BAY_LINING_OUTER_X = BAY_LINING_INNER_X + BAY_LINING_T;   // 1.72
/** Clearance between the lining's outer face and the side slab's inner face — no shared plane, no fight. */
const HULL_SKIN_GAP = 0.01;

/** Local z of the ramp hinge (the rear lip of the bay floor) and the ramp's own length. */
export const SHIP_RAMP_HINGE_Z = 0.25;
export const SHIP_RAMP_LEN = 3.0;
/** Local z the open ramp's far edge reaches — where a boarding player steps on. */
export const SHIP_RAMP_END_Z = SHIP_RAMP_HINGE_Z + SHIP_RAMP_LEN;
/** Local z of the nose tip and local y of the landing pads' underside — the hull's full extent for parking / framing. */
export const SHIP_NOSE_Z = -9.7;
export const SHIP_GEAR_BOTTOM_Y = -1.06;

/**
 * Drawing scale of a ship shown **outside a raid** (hangar bay, docking cutscene).
 *
 * The raid ship is drawn at 1:1 against a planet. The hangar's bays are 9 × 12 m, 11 m apart, and the shared ship's
 * bay mouth in the cutscene is 12.6 × 5.3 m — all of them sized when a personal ship was a 9 m wedge. At 1:1 the
 * dropship (10.5 m across the nacelles) would overhang its floor marking and all but touch its neighbour. The whole
 * hub already draws ships far smaller than their interiors (a 45 m corridor lives inside that 9 m wedge), so the
 * honest fix is to keep **one shape** and show it at hangar scale rather than to keep two shapes.
 */
export const SHIP_EXTERIOR_SCALE = 0.8;

/** Materials a greeble pass paints with (`extraction/ShipGreebles`). */
export interface ShipHullMaterials {
  hull: THREE.MeshStandardMaterial;
  hullDark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  /** Bay lining / seats / ceiling — `'full'` only. */
  interior: THREE.MeshStandardMaterial;
  /** Bay deck plate and ramp plate. */
  floor: THREE.MeshStandardMaterial;
}

/**
 * Outer-skin detail pass (`extraction/ShipGreebles.buildShipGreebles`). It stays in `extraction/` because only the
 * raid ship is ever seen from a metre away; passing it in keeps `shared` from importing a feature folder.
 */
export type ShipGreebleHook = (
  parent: THREE.Object3D,
  mats: { hull: THREE.Material; hullDark: THREE.Material; accent: THREE.Material; glass: THREE.Material },
  keep: (g: THREE.BufferGeometry) => void,
) => void;

export type ShipModelDetail = 'full' | 'exterior';

export interface ShipModelOptions {
  /** Which ship. Unknown / omitted = `DEFAULT_SHIP_MODEL`. */
  model?: unknown;
  /** `'full'` (raid ship, bay included) or `'exterior'` (hangar / cutscene, merged, no bay). Default `'full'`. */
  detail?: ShipModelDetail;
  /** Outer-skin greebles — `'full'` only, and only when the caller passes one. */
  greebles?: ShipGreebleHook;
}

/** Everything a caller has to animate, light or dispose. */
export interface ShipModelBuild {
  readonly model: ShipModelId;
  readonly detail: ShipModelDetail;
  readonly materials: ShipHullMaterials;
  /** Rear ramp, hinged at the bay floor's rear edge. `rotation.x = -angle`; 0 = flat open, π/2 = closed. */
  readonly ramp: THREE.Group;
  /** Landing gear — retracted by `scale.y`. */
  readonly gear: THREE.Group;
  /** Additive engine plumes (one per nacelle) and their materials, in nacelle order (−X, +X). */
  readonly thrustCones: THREE.Mesh[];
  readonly thrustMats: THREE.MeshBasicMaterial[];
  /** Where a nacelle's light / glow disc belongs, in nacelle order. The builder itself adds **no light**. */
  readonly enginePoints: THREE.Vector3[];
  /** Amber strips at the rear edges (emissive mesh only, no light) and the material they share. */
  readonly landingLights: THREE.Mesh[];
  readonly landingLightMat: THREE.MeshStandardMaterial;
  /** Bay lamp strip / the red departure switch — `'full'` only, null otherwise. */
  readonly interiorLampMat: THREE.MeshStandardMaterial | null;
  readonly switchMat: THREE.MeshStandardMaterial | null;
  /** Where the bay lamp hangs (`'full'` only) — the caller decides whether to put a light there. */
  readonly interiorLightPoint: THREE.Vector3 | null;
  /** Bay lining meshes — only ever seen from inside, so the caller keeps them out of the sun's shadow pass. */
  readonly interiorParts: THREE.Mesh[];
  /** Re-tint to another model. `'full'` only (its materials are its own); a no-op for a shared-material build. */
  setModel(model: unknown): void;
  dispose(): void;
}

/* ── shared exterior materials, one set per model id (a hangar parks four ships from one set) ── */
const _exteriorMats = new Map<ShipModelId, ShipHullMaterials>();

function makeMaterials(def: ShipModelDef): ShipHullMaterials {
  return {
    hull: new THREE.MeshStandardMaterial({ color: def.hull, roughness: 0.6, metalness: 0.55 }),
    hullDark: new THREE.MeshStandardMaterial({ color: def.hullDark, roughness: 0.7, metalness: 0.5 }),
    accent: new THREE.MeshStandardMaterial({ color: def.accent, roughness: 0.6, metalness: 0.3 }),
    glass: new THREE.MeshStandardMaterial({ color: def.glass, roughness: 0.1, metalness: 0.9, emissive: def.glassEmissive, emissiveIntensity: 0.6 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.85, metalness: 0.3, side: THREE.DoubleSide }),
    floor: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.9, metalness: 0.2 }),
  };
}

function tint(mats: ShipHullMaterials, def: ShipModelDef): void {
  mats.hull.color.setHex(def.hull);
  mats.hullDark.color.setHex(def.hullDark);
  mats.accent.color.setHex(def.accent);
  mats.glass.color.setHex(def.glass);
  mats.glass.emissive.setHex(def.glassEmissive);
}

/** Materials every `'exterior'` build of one model shares (created once, never disposed — like `hub`'s `HUB_MATS`). */
function exteriorMaterials(model: ShipModelId): ShipHullMaterials {
  let m = _exteriorMats.get(model);
  if (!m) { m = makeMaterials(SHIP_MODELS[model]); _exteriorMats.set(model, m); }
  return m;
}

/** Collects boxes / cylinders per material so an `'exterior'` ship is a handful of merged meshes, not forty. */
class HullBatch {
  private readonly groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  /**
   * false = keep every piece as its own mesh (the `'full'` ship animates them separately).
   * The fields are written out rather than declared as constructor parameter properties: `server/tsconfig.json`
   * type-checks `src/shared` with `erasableSyntaxOnly`, which that shorthand is not.
   */
  private readonly merging: boolean;
  private readonly parent: THREE.Object3D;
  private readonly keep: (g: THREE.BufferGeometry) => void;

  constructor(merging: boolean, parent: THREE.Object3D, keep: (g: THREE.BufferGeometry) => void) {
    this.merging = merging;
    this.parent = parent;
    this.keep = keep;
  }

  add(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh | null {
    if (!this.merging) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, rz);
      this.keep(geo);
      this.parent.add(mesh);
      return mesh;
    }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(1, 1, 1),
    );
    geo.applyMatrix4(m);
    let list = this.groups.get(mat);
    if (!list) { list = []; this.groups.set(mat, list); }
    list.push(geo);
    return null;
  }

  /** Merge what was collected into `parent` (no-op when not merging). */
  flush(): void {
    for (const [mat, list] of this.groups) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.matrixAutoUpdate = false;
      this.keep(merged);
      this.parent.add(mesh);
    }
    this.groups.clear();
  }
}

/**
 * Build one dropship into `parent`. The meshes are **direct children of `parent`** (apart from the ramp and the gear,
 * which own a group each because they move) — `extraction/Ship` hands its `body` group in and
 * `scripts/smoke-raidflow.mjs` walks exactly those children to prove the rear doorway is open.
 */
export function buildShipModel(parent: THREE.Object3D, opts: ShipModelOptions = {}): ShipModelBuild {
  const model = resolveShipModelId(opts.model);
  const def = SHIP_MODELS[model];
  const detail: ShipModelDetail = opts.detail ?? 'full';
  const full = detail === 'full';

  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  const keep = (g: THREE.BufferGeometry): void => { disposables.push(g); };
  // `'full'` owns its materials (so one ship can be re-tinted alone); `'exterior'` shares one set per model.
  const mats = full ? makeMaterials(def) : exteriorMaterials(model);
  if (full) for (const m of Object.values(mats)) disposables.push(m);
  const { hull, hullDark, accent, glass, interior, floor: floorMat } = mats;

  const b = new HullBatch(!full, parent, keep);
  const interiorParts: THREE.Mesh[] = [];
  const thrustCones: THREE.Mesh[] = [];
  const thrustMats: THREE.MeshBasicMaterial[] = [];
  const enginePoints: THREE.Vector3[] = [];
  const landingLights: THREE.Mesh[] = [];
  let interiorLampMat: THREE.MeshStandardMaterial | null = null;
  let switchMat: THREE.MeshStandardMaterial | null = null;
  let interiorLightPoint: THREE.Vector3 | null = null;

  /* ── Bay (interior, `'full'` only) ── deck plane at y 0, walls x ±1.6, z −5.2 .. 0.2, ceiling 2.6 ──
   * The floor plate is drawn `SHIP_BAY_FLOOR_LIFT` above the deck plane (see the coplanar note): at y 0 it shared its
   * top face with the belly slab **and** with the terrain the ship stands on, which is what made the ground show
   * through it in mottled patches. It is also grown 0.04 m into the lining walls and the front wall on every side, so
   * its own side faces end up buried instead of sharing a plane with them. */
  if (full) {
    // top face at y = SHIP_BAY_FLOOR_LIFT; x ±1.64, z −5.24 .. 0.2
    b.add(new THREE.BoxGeometry(3.28, 0.12, 5.44), floorMat, 0, SHIP_BAY_FLOOR_LIFT - 0.06, -2.52);
    const wallL = b.add(new THREE.BoxGeometry(BAY_LINING_T, SHIP_BAY_HEIGHT, 5.4), interior, -(BAY_LINING_INNER_X + BAY_LINING_T / 2), SHIP_BAY_HEIGHT / 2, -2.5)!;
    const wallR = b.add(new THREE.BoxGeometry(BAY_LINING_T, SHIP_BAY_HEIGHT, 5.4), interior, BAY_LINING_INNER_X + BAY_LINING_T / 2, SHIP_BAY_HEIGHT / 2, -2.5)!;
    // Dropped 0.025 so its underside clears `hullRoof`'s underside (both sat at y 2.6 and fought). The roof's face is
    // inside the ceiling slab now, and the lamp strip below is simply recessed into it.
    const ceiling = b.add(new THREE.BoxGeometry(3.4, 0.12, 5.4), interior, 0, SHIP_BAY_HEIGHT + 0.06 - 0.025, -2.5)!;
    const frontWall = b.add(new THREE.BoxGeometry(3.4, SHIP_BAY_HEIGHT + 0.2, 0.12), interior, 0, SHIP_BAY_HEIGHT / 2, -5.26)!;
    // Wall panels / ribs
    for (let i = 0; i < 5; i++) {
      const z = -4.6 + i * 1.05;
      const ribGeo = new THREE.BoxGeometry(0.08, SHIP_BAY_HEIGHT - 0.2, 0.16);
      interiorParts.push(b.add(ribGeo, hullDark, -1.56, SHIP_BAY_HEIGHT / 2, z)!);
      interiorParts.push(b.add(ribGeo.clone(), hullDark, 1.56, SHIP_BAY_HEIGHT / 2, z)!);
    }
    // Seats (benches) along the walls
    for (const sx of [-1, 1]) {
      interiorParts.push(b.add(new THREE.BoxGeometry(0.4, 0.1, 4.2), hullDark, sx * 1.35, 0.5, -2.7)!);
      interiorParts.push(b.add(new THREE.BoxGeometry(0.08, 0.6, 4.2), hullDark, sx * 1.55, 0.85, -2.7)!);
    }
    // Ceiling light strip (an emissive mesh; the light itself belongs to the caller)
    interiorLampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 2.2 });
    disposables.push(interiorLampMat);
    const lamp = b.add(new THREE.BoxGeometry(0.3, 0.04, 4.6), interiorLampMat, 0, SHIP_BAY_HEIGHT - 0.03, -2.6)!;
    interiorLightPoint = new THREE.Vector3(0, SHIP_BAY_HEIGHT - 0.4, -2.6);
    // Red interior switch console on the far (front) wall
    const swBox = b.add(new THREE.BoxGeometry(0.6, 0.5, 0.18), hullDark, 0, 1.25, -5.1)!;
    switchMat = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2a2a, emissiveIntensity: 1.4, roughness: 0.4 });
    disposables.push(switchMat);
    const swBtn = b.add(new THREE.CylinderGeometry(0.11, 0.12, 0.08, 16), switchMat, 0, 1.3, -5.0, Math.PI / 2)!;
    const swGuard = b.add(new THREE.TorusGeometry(0.17, 0.02, 8, 20), accent, 0, 1.3, -5.0)!;
    const swLabelMat = new THREE.MeshStandardMaterial({ color: 0xe6b31e, emissive: 0xe6b31e, emissiveIntensity: 0.5 });
    disposables.push(swLabelMat);
    const swLabel = b.add(new THREE.PlaneGeometry(0.5, 0.08), swLabelMat, 0, 1.0, -5.005)!;
    interiorParts.push(wallL, wallR, ceiling, frontWall, lamp, swBox, swBtn, swGuard, swLabel);
  }

  /* ── Outer hull ──
   * 2026-09-10: this used to be **one solid box** (4.2 × 3.3 × 7.2 at y 1.35, z −3.0), so its rear face sat right
   * behind the bay opening — the ramp came down and revealed a grey wall instead of the lit interior. It is a shell
   * now: four slabs around the bay (left / right / roof / belly) plus a front cap, leaving a real hole at the rear.
   * The only thing that closes that hole is the ramp itself (upright at z = 0.25 when closed, 3.2 wide × 3.0 tall).
   * Hull outline x ±2.1, y −0.3..3.0, z −6.6..0.6; the opening is x ±1.6, y 0..2.6 — the bay lining owns x 1.6..1.72
   * and the shell picks up outboard of it (`sideInnerX`), so no two faces share a plane (`HULL_SKIN_GAP`). */
  const sideInnerX = BAY_LINING_OUTER_X + HULL_SKIN_GAP;      // 1.73
  const sideW = HULL_HALF_W - sideInnerX;                     // 0.37
  for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(sideW, 3.3, 7.2), hull, sx * (HULL_HALF_W - sideW / 2), 1.35, -3.0);
  b.add(new THREE.BoxGeometry(4.2, 0.4, 7.2), hull, 0, 2.8, -3.0);
  // Belly: bottom stays at y −0.3 (the greeble seams live at −0.305), but its **top** drops 0.02 below the deck plane
  // so it no longer shares y 0 with the ground under the ship. `extraction/Hull.ts`'s belly collider — whose top *is*
  // the deck — is a separate box and is deliberately left where it is.
  b.add(new THREE.BoxGeometry(4.2, 0.28, 7.2), hull, 0, -0.16, -3.0);
  // Front cap: the forward section (between the bay's front wall and the nose) has to stay closed now that the shell
  // is open-ended — the 4-sided nose cone leaves corner gaps you would otherwise see straight through.
  b.add(new THREE.BoxGeometry(4.2, 3.3, 0.2), hullDark, 0, 1.35, -6.5);
  b.add(new THREE.BoxGeometry(3.0, 0.6, 6.4), hullDark, 0, 3.25, -3.2);
  b.add(new THREE.BoxGeometry(0.8, 0.5, 9.4), accent, 0, 3.6, -3.6);
  // Nose / cockpit (wedge via a 4-sided cylinder segment)
  b.add(new THREE.CylinderGeometry(1.5, 2.05, 3.2, 4, 1), hull, 0, 1.45, -8.1, Math.PI / 2, Math.PI / 4);
  b.add(new THREE.BoxGeometry(2.1, 0.9, 1.6), glass, 0, 2.55, -7.2, 0.25);
  // Same reason as the belly: the chin's underside sat exactly on the ground plane (y 0). It reaches 0.02 below it now.
  b.add(new THREE.BoxGeometry(2.6, 0.72, 2.4), hullDark, 0, 0.34, -7.4);
  // Tail fins
  for (const sx of [-1, 1]) b.add(new THREE.BoxGeometry(0.1, 1.6, 1.8), hull, sx * 1.4, 4.1, 0.2, 0, 0, -sx * 0.45);
  b.add(new THREE.BoxGeometry(3.4, 0.12, 1.4), hull, 0, 3.9, 0.3);

  /* ── Wings + nacelles + thrust cones ──
   * The plumes stay their own meshes at both detail levels: they are additive, they scale with thrust, and merging
   * them into the hull would blend a transparent material into an opaque one. */
  for (const sx of [-1, 1]) {
    b.add(new THREE.BoxGeometry(2.6, 0.22, 2.6), hull, sx * 3.0, 2.3, -3.2);
    b.add(new THREE.CylinderGeometry(0.95, 1.05, 3.6, 18), hullDark, sx * 4.2, 1.9, -3.2);
    b.add(new THREE.TorusGeometry(1.0, 0.1, 10, 24), accent, sx * 4.2, 0.15, -3.2, Math.PI / 2);
    const tm = new THREE.MeshBasicMaterial({ color: 0x66c4ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const coneGeo = new THREE.ConeGeometry(0.85, 2.2, 18, 1, true);
    const cone = new THREE.Mesh(coneGeo, tm);
    cone.rotation.x = Math.PI;
    cone.position.set(sx * 4.2, -0.9, -3.2);
    cone.castShadow = false;
    parent.add(cone);
    disposables.push(coneGeo, tm);
    thrustMats.push(tm);
    thrustCones.push(cone);
    enginePoints.push(new THREE.Vector3(sx * 4.2, -0.4, -3.2));
  }

  /* ── Landing gear (3 legs, retracted by scale) ── its own group at both detail levels: a parked ship stands on it
   * and a flying one folds it away. */
  const gear = new THREE.Group();
  gear.name = 'ship-gear';
  const gearBatch = new HullBatch(!full, gear, keep);
  for (const [x, z] of [[-1.8, -1.0], [1.8, -1.0], [0, -7.0]]) {
    gearBatch.add(new THREE.CylinderGeometry(0.1, 0.12, 1.1, 8), hullDark, x, -0.45, z);
    gearBatch.add(new THREE.CylinderGeometry(0.35, 0.4, 0.12, 12), hullDark, x, -1.0, z);
  }
  gearBatch.flush();
  parent.add(gear);

  /* ── Landing lights (amber strips at the rear edges) ──
   * 2026-09-15: x 2.0 → 2.15. At 2.0 the strip (x 1.925..2.075) sat entirely inside the side slab (outer face x 2.1)
   * and was never visible; it now pokes 0.125 m out of its housing greeble. Emissive mesh only — no light. */
  const landingLightMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xffb347, emissiveIntensity: 0 });
  disposables.push(landingLightMat);
  for (const sx of [-1, 1]) {
    const geo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
    const l = new THREE.Mesh(geo, landingLightMat);
    l.position.set(sx * 2.15, 0.4, 0.1);
    parent.add(l);
    disposables.push(geo);
    landingLights.push(l);
  }

  /* ── Rear ramp (hinged at the bay floor's rear edge, local z = `SHIP_RAMP_HINGE_Z`) ── */
  const ramp = new THREE.Group();
  ramp.name = 'ship-ramp';
  ramp.position.set(0, 0, SHIP_RAMP_HINGE_Z);
  const rampBatch = new HullBatch(!full, ramp, keep);
  rampBatch.add(new THREE.BoxGeometry(3.2, 0.14, SHIP_RAMP_LEN), floorMat, 0, 0, SHIP_RAMP_LEN / 2);
  rampBatch.add(new THREE.BoxGeometry(0.12, 0.2, SHIP_RAMP_LEN), accent, -1.6, 0.05, SHIP_RAMP_LEN / 2);
  rampBatch.add(new THREE.BoxGeometry(0.12, 0.2, SHIP_RAMP_LEN), accent, 1.6, 0.05, SHIP_RAMP_LEN / 2);
  rampBatch.flush();
  ramp.rotation.x = -Math.PI / 2;     // closed
  parent.add(ramp);

  b.flush();

  // Greebles (2026-09-15, D-8): panel seams, rivets, pipes, vents, hatches, antennas, nacelle ribs — outer skin only,
  // merged per existing material (no new programs, no lights). `'full'` only (see the detail note at the top).
  if (full && opts.greebles) opts.greebles(parent, { hull, hullDark, accent, glass }, keep);

  return {
    model, detail, materials: mats, ramp, gear, thrustCones, thrustMats, enginePoints,
    landingLights, landingLightMat, interiorLampMat, switchMat, interiorLightPoint, interiorParts,
    setModel(next: unknown): void {
      if (!full) return;      // shared materials — an `'exterior'` ship is rebuilt for another model instead
      tint(mats, resolveShipModel(next));
    },
    dispose(): void {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      ramp.removeFromParent();
      gear.removeFromParent();
    },
  };
}
