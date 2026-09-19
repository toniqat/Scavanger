import * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import {
  COCKPIT_ROOM_INDEX, HOUSING_CELL_SIZE, HUB_POINT_LIGHTS, HUB_TRAVEL_WARP_STRETCH, ROOM_GRID_COLS, ROOM_LIGHT_DISTANCE, ROOM_LIGHT_INTENSITY, ROOM_LIGHT_POOL,
  ROOM_STRIP_DIM, ROOM_STRIP_LIT, SHIP_ROOM_COUNT, roomCellBlocked, roomGridSize,
} from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { Parts } from './parts';
import { LightPool, type LightFixture } from './LightPool';
import { Starfield, Planet } from './Starfield';
import { ViewportWarp } from './WarpStreaks';
import type { ShipStations } from './stations';
import { TextPlane } from '../Labels';
import { AIRLOCK, CEIL, COCKPIT, COCKPIT_ROOM_BOX, CORRIDOR, DOOR_HEIGHT, DOOR_WIDTH, ROOM_BOXES, ROOM_DEPTH, ROOM_GAP, ROOMS_PER_SIDE, SEGMENT, WALL, type RoomBox } from './RoomLayout';
import type { EditAreaDef, PodSlotDef, RoomDef, ShipInterior, TerminalDef, WarpDestination } from './types';

/** 2026-09-13: how long the cockpit ceiling takes to fade out / back in around ship management (UI timing, not balance). */
const COCKPIT_CEILING_FADE_S = 0.4;

/** An own, always-transparent copy of a shared palette material (opacity 1 = looks exactly like the original). */
function fadeMat(src: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  const m = src.clone();
  m.transparent = true;
  m.opacity = 1;
  return m;
}

/**
 * Personal ship (ship decoration, 2026-09-06): cockpit (−Z) → 3 m corridor running +Z → `SHIP_ROOM_COUNT` (8 since
 * 2026-09-12, was 10) `ROOM_SIZE × ROOM_DEPTH` housing rooms (half per side, doors on the corridor) → airlock. Every
 * coordinate lives in `RoomLayout.ts`.
 *
 * **2026-09-12 (user's decision) — the cockpit is a furniture area too.** The built-in implant bay · ship computer
 * are gone (the shared-facility furniture `furn_implant_bay` · `furn_corp_computer` take their spots) and the cockpit
 * is the `cockpit` (`COCKPIT_ROOM_INDEX`) furniture area. Room and cockpit floor grid lines alike are **their own
 * meshes** (`gridGroup`) and show only during ship management (`setGridVisible`); the cockpit grid draws no line on a
 * fixed prop's spot (`COCKPIT_BLOCKED_RECTS`).
 *
 * **2026-09-12 — a room is 8 × 8 m** (`ROOM_GRID_COLS/ROWS` 8 → 16). Not one number was newly written into this file:
 * room · corridor · airlock coordinates all come from `RoomLayout`, and only the airlock z values that used to be
 * hard-coded (26.0 · 26.4 · 26.3) became offsets from `AIRLOCK`. The corridor grew 25 → 45 m, so **the corridor light
 * places went from one per segment to two, and a room's from one to two** — only the places grew; the real point
 * lights are still `HUB_POINT_LIGHTS` of them (「Never change the point-light count at runtime」, `LightPool`).
 * Static geometry is merged per material (`GeoBatch`); the point-light count is constant: **`HUB_POINT_LIGHTS`**
 * pool lights (2026-09-10, was 13 lights of its own) serve the light fixtures nearest the player — cockpit 4,
 * corridor 10, airlock 1 and the two fixtures of each of the nearest `ROOM_LIGHT_POOL` lit rooms (`LightPool`:
 * re-anchored and ramped, never toggled). Furniture is rendered by `Furniture.ts` into `RoomDef.furnitureGroup`.
 *
 * Phase 8 (2026-09-06): the built-in workbench and the hydroponics rack are gone (정비 벤치 / 재배층 are placeable
 * furniture now) and each room owns its emissive strip materials so an empty room reads dark (`ROOM_STRIP_DIM`) and an
 * assigned one lit (`ROOM_STRIP_LIT`). 2026-09-16 (user's decision): the sliding doors (`ShipDoors`) are gone — every doorway
 * and the cockpit arch is an open, framed opening (they never had colliders, so walking is unchanged).
 *
 * Phase 9 UI pass (2026-09-07) — cockpit clean-up:
 *   • the console pedestal terminal is **gone**; the dashboard's centre monitor *is* `terminal.screen` (the 항법 /
 *     통신 side readouts were dropped with it), so nothing stands on the walk-in line any more;
 *   • the **ship computer** moved from the +X wall (where its `기업 네트워크` prompt fought the launch pod's boarding
 *     prompt) to the port half of the rear wall, replacing the lockers that overlapped the bunk;
 *   • the stash cabinet moved to the starboard half of the rear wall, and the bunk sits flush to the −X wall;
 *   • door frames stand clear of the wall slab (they used to intersect it) and the waist-high wainscot band no
 *     longer crosses a doorway (`Parts.walls` splits it around floor-level openings).
 */
export class PersonalShip implements ShipInterior {
  readonly kind: HubShipKind = 'personal';
  readonly root = new THREE.Group();
  readonly collider = new BoxInteriorCollider();
  readonly spawn = new THREE.Vector3(0, 0, -1.8);
  readonly spawnYaw = 0;                       // facing −Z (the cockpit)
  /** 1 m inside the airlock, on its centre line (was the literal 26.0 — the airlock moved with the longer corridor). */
  readonly airlock = new THREE.Vector3(0, 0, AIRLOCK.minZ + 1.0);
  readonly airlockYaw = 0;
  readonly pods: PodSlotDef[] = [];
  readonly terminal: TerminalDef;
  /*
   * 2026-09-12 (user's decision): `computer` and `stations.implantBay` used to be here — the cockpit's built-in ship
   * computer · implant bay. Both became **shared-facility furniture** (`furn_corp_computer` · `furn_implant_bay`) that
   * housing seats in the cockpit (`COCKPIT_DEFAULT_FURNITURE`); their models reuse `stations.ts`'s body functions
   * through the builders in `interiors/Furniture`.
   */
  readonly stations: ShipStations = {};
  readonly rooms: RoomDef[] = [];
  /** 2026-09-12: the cockpit as a furniture area (`COCKPIT_ROOM_INDEX`). Grid `roomGridSize` · blocked cells `roomCellBlocked`. */
  readonly cockpit: EditAreaDef;
  private meshes: THREE.Mesh[] = [];
  /**
   * 2026-09-13 (user's decision): the cockpit ceiling — ceiling plate · ceiling light strips · three ceiling beams ·
   * the strip over the dashboard. Its own group, lifted out of the ship-wide merged batch, with **its own materials**
   * (clones of the shared `HUB_MATS`, `transparent` from the start), so ship management fades this and nothing else.
   * Toggling `transparent` mid-flight would change the program key (`OPAQUE`) and recompile the shader, so it stays on
   * and only `opacity` is moved.
   */
  private readonly cockpitCeiling = new THREE.Group();
  private readonly ceilMeshes: THREE.Mesh[] = [];
  private readonly ceilMats = {
    plate: fadeMat(M.hullDark), beam: fadeMat(M.hullLight), strip: fadeMat(M.stripWhite), bar: fadeMat(M.stripCyan),
  };
  /** Fade progress 0 (shown) … 1 (hidden) and where it is heading. */
  private ceilFade = 0;
  private ceilTarget = 0;
  /** 2026-09-12: room and cockpit floor grid lines — shown only during ship management (`setGridVisible`). No light. */
  private readonly gridGroup = new THREE.Group();
  private gridMeshes: THREE.Mesh[] = [];
  private stars: Starfield;
  private planet: Planet;
  /** The window warp (2026-09-09): streaks past the cockpit viewport, driven by the hub through `setWarp`. */
  private warp: ViewportWarp;
  private screens: TextPlane[] = [];
  private beacon: THREE.Mesh;
  private beaconMat: THREE.MeshBasicMaterial;
  /** Per-room emissive strip materials (own instances so one room can be dimmed without touching the others). */
  private stripMats: THREE.MeshStandardMaterial[][] = [];
  private roomLit: boolean[] = new Array(SHIP_ROOM_COUNT).fill(false);
  /**
   * 2026-09-10: every point light of this ship. `HUB_POINT_LIGHTS` lights move between the fixtures below, nearest to
   * the player first, so the scene-wide count stays inside `SCENE_POINT_LIGHT_BUDGET` (see `LightPool`).
   */
  private lightPool!: LightPool;
  /** The fixed fixtures (cockpit 4, corridor 2 × `ROOMS_PER_SIDE`, airlock 1 — 15 since 2026-09-12, was 10). */
  private readonly staticFixtures: LightFixture[] = [];
  /**
   * Ceiling fixtures per room (2026-09-12: **two**, one per half of the 8 × 8 m room); only lit rooms are
   * candidates, and only the nearest `ROOM_LIGHT_POOL` of them. Adding *places* costs nothing — the pool still
   * hangs exactly `HUB_POINT_LIGHTS` real lights, so the scene's point-light count never moves.
   */
  private readonly roomFixtures: LightFixture[][] = [];
  /** Reverse index for `roomLightRooms` (debug / smoke): which room a fixture object belongs to. */
  private readonly fixtureRoom = new Map<LightFixture, number>();
  /** Rooms whose fixture is in the pool's candidate list right now (sorted by index). */
  private roomPick: number[] = [];
  private readonly roomPickNext: number[] = [];
  private readonly roomDist: number[] = new Array(SHIP_ROOM_COUNT).fill(0);

  constructor() {
    const r = this.root;
    r.name = 'PersonalShip';
    const col = this.collider;
    const b = new GeoBatch();
    const P = new Parts(b, col, CEIL);

    /* ── walkable union ── */
    col.addRoom(COCKPIT.minX, COCKPIT.maxX, COCKPIT.minZ, COCKPIT.maxZ, 0, CEIL);
    col.addRoom(CORRIDOR.minX, CORRIDOR.maxX, CORRIDOR.minZ, CORRIDOR.maxZ, 0, CEIL);
    col.addRoom(AIRLOCK.minX, AIRLOCK.maxX, AIRLOCK.minZ, AIRLOCK.maxZ, 0, CEIL);
    // each room reaches through its door wall to the corridor face so the doorway is an open shared edge
    for (const rb of ROOM_BOXES) {
      if (rb.side < 0) col.addRoom(rb.minX, CORRIDOR.minX, rb.minZ, rb.maxZ, 0, CEIL);
      else col.addRoom(CORRIDOR.maxX, rb.maxX, rb.minZ, rb.maxZ, 0, CEIL);
    }

    /* ── cockpit ── */
    const C = COCKPIT;
    // 2026-09-13 (user's decision): the cockpit **ceiling** (plane + light channels + the three full-depth beams + the bar over the
    // dashboard) is its own batch with its own always-transparent material instances, so ship management can fade it out
    // (`setCockpitCeilingHidden`). The launch pod's top frame stays in the ship-wide batch on purpose.
    const ceil = { b: new GeoBatch(), plate: this.ceilMats.plate, beam: this.ceilMats.beam, strip: this.ceilMats.strip };
    P.deck(C, false, ceil);
    P.walls(C, WALL, {
      n: { lo: -3.2, hi: 3.2, y0: 1.0, y1: 2.7 },                              // viewport
      s: { lo: CORRIDOR.minX, hi: CORRIDOR.maxX, y0: 0, y1: 2.6 },              // corridor arch
    });
    P.glass(r, 6.4, 1.7, 0, 1.85, C.minZ - WALL / 2, 0, this.meshes);
    for (const x of [-3.3, 0, 3.3]) { P.rib(x, C.minZ + 0.16); P.beam(C.maxZ - C.minZ, x, C.minZ + (C.maxZ - C.minZ) / 2, Math.PI / 2, ceil); }
    // rear ribs: only the starboard one survives — the port rear corner is the ship computer desk now, and the rib
    // stood inside it (it hid the `기업 네트워크` monitor).
    P.rib(3.3, C.maxZ - 0.16);
    P.rib(C.minX + 0.16, -3.95);
    /*
     * Corridor arch trim. 2026-09-16 (sliding doors removed — user's decision 「문틀 주변에 흉한 것이 남지 않게」): with the leaves gone the
     * arch is looked *through*, and three things showed:
     *  - the posts' inner faces sat exactly on the wall's reveal planes (x = ±1.5) and the header's underside exactly on
     *    the soffit (y 2.6) → trim-vs-hull z-fighting inside the opening. Posts and header now stand 2 cm proud of the
     *    reveal / soffit, so the trim covers them instead of sharing their planes;
     *  - the cockpit wainscot band (front z −0.04) and its trim line (−0.055) ran 1–2.5 cm *in front of* the posts →
     *    the posts reach to `archFront` so the band butts into them like a skirting board into a casing;
     *  - the amber bar hung **inside** the opening just under the header (y 2.52 … 2.58, crossing the wall face) — it
     *    now sits on the cockpit face of the header wall above the trim.
     * The corridor's waist trim starts behind the posts (`archBack`, below) instead of running through them.
     */
    const archFront = C.maxZ - 0.065, archBack = C.maxZ + WALL + 0.03;
    const archD = archBack - archFront, archZ = (archFront + archBack) / 2;
    b.box(0.14, 2.6, archD, CORRIDOR.minX - 0.05, 1.3, archZ, M.trim);
    b.box(0.14, 2.6, archD, CORRIDOR.maxX + 0.05, 1.3, archZ, M.trim);
    b.box(3.24, 0.12, archD, 0, 2.64, archZ, M.trim);
    b.box(2.4, 0.06, 0.05, 0, 2.8, C.maxZ - 0.03, M.stripAmber);

    // dashboard under the viewport + pilot seats + readouts
    b.boxB(6.6, 0.85, 0.7, 0, 0, C.minZ + 0.35, M.hullDark);
    b.box(6.7, 0.06, 0.75, 0, 0.88, C.minZ + 0.35, M.trimDark);
    b.box(6.2, 0.04, 0.5, 0, 0.9, C.minZ + 0.45, M.gunmetal);
    col.addBox(0, 0, C.minZ + 0.35, 6.6, 1.2, 0.7);
    for (const x of [-0.9, 0.9]) {
      b.boxB(0.7, 0.45, 0.7, x, 0, C.minZ + 1.35, M.hullDark);
      b.boxB(0.7, 0.9, 0.16, x, 0.45, C.minZ + 1.65, M.padding);
      b.box(0.62, 0.12, 0.6, x, 0.5, C.minZ + 1.35, M.padding);
      col.addBox(x, 0, C.minZ + 1.45, 0.7, 1.3, 0.75);
    }
    /**
     * The ship terminal (Phase 9 UI pass): the cockpit console pedestal between the pilot seats is **gone** — it stood
     * on the walk-in line and its `기업 네트워크` neighbour clashed with the launch pod. The dashboard's centre readout
     * (the old `동력 98 %` monitor) *is* the terminal now, and the flanking 항법 / 통신 readouts were dropped so the
     * one screen reads at a glance. The player uses it standing between the seats at the dashboard.
     */
    const TILT = -0.5;
    const BX = 0, BY = 1.27, BZ = C.minZ + 0.62;
    b.box(2.06, 0.94, 0.06, BX, BY, BZ, M.hullDark, 0, TILT);
    b.box(2.14, 0.05, 0.07, 0, 1.72, C.minZ + 0.38, M.trim);
    // the screen sits on the bezel's **front** face: its normal is (0,0,1) rotated by TILT around X
    const nY = -Math.sin(TILT), nZ = Math.cos(TILT), off = 0.045;
    const screen = new TextPlane(1.9, 0.8, 512, false);
    screen.mesh.position.set(BX, BY + nY * off, BZ + nZ * off);
    screen.mesh.rotation.x = TILT;
    r.add(screen.mesh);
    this.terminal = { position: new THREE.Vector3(0, 0, C.minZ + 1.5), yaw: yawFromForward(0, -1), screen };
    ceil.b.box(1.8, 0.08, 0.04, 0, CEIL - 0.07, C.minZ + 0.9, this.ceilMats.bar);   // ceiling bar over the dashboard (was `P.signStrip`)

    /*
     * 2026-09-13 (user's decision): the cockpit's remaining fixed props are **decor furniture** now — the −X wall bunk
     * (x −5 … −4, z −2.8 … −0.7) → `furn_bunk`, the two +X wall lockers (x 4.48 … 4.98 around z −4.7) → two `furn_locker`,
     * the stash cabinet on the rear wall (x 2.4) → `furn_drawer`. housing seats them once on their old spots
     * (`COCKPIT_DECOR_FURNITURE`) and their geometry + colliders left this file; `COCKPIT_BLOCKED_RECTS` freed the cells.
     * 2026-09-12: the implant bay (x −4.05, z −4.9) is the `furn_implant_bay` furniture (`COCKPIT_DEFAULT_FURNITURE`).
     */

    // +X wall: launch pod (the lockers in front of it are furniture now). The ship computer used to stand here and its
    // `기업 네트워크` prompt overlapped the pod's boarding prompt — it moved to the rear wall.
    const faceNegX = yawFromForward(-1, 0);
    // pod socket: floor plate, rear frame, side lips + toggleable door blocker. The cell itself stays walkable —
    // a seated player must never be pushed out of the pod by `resolveCollision`; only the door slab blocks when closed.
    const px = C.maxX - 1.0, pz = -1.2;
    b.box(2.0, 0.06, 2.0, px, 0.03, pz, M.hullDark);
    b.boxB(0.5, CEIL, 1.9, C.maxX - 0.25, 0, pz, M.hullLight);
    b.box(0.3, 0.3, 2.2, px, CEIL - 0.15, pz, M.hullLight);
    col.addBlocker(px + 0.75, 0, pz - 0.95, C.maxX, 3, pz + 0.95);
    col.addBlocker(px - 0.85, 0, pz - 0.95, px + 0.75, 3, pz - 0.55);
    col.addBlocker(px - 0.85, 0, pz + 0.55, px + 0.75, 3, pz + 0.95);
    const doorBlocker = col.addBlocker(px - 0.95, 0, pz - 0.55, px - 0.75, 3, pz + 0.55);
    col.setBlockerEnabled(doorBlocker, false);
    this.pods.push({ slot: 0, position: new THREE.Vector3(px, 0, pz), yaw: faceNegX, door: new THREE.Vector3(-1, 0, 0), doorBlocker });
    P.signStrip(C.maxX - WALL / 2 - 0.03, 2.6, pz, 1.6, M.stripAmber, Math.PI / 2);

    // +Z (rear) wall, port side: the **ship computer** desk stood here (x −3.15) until 2026-09-12 — it is the
    // `furn_corp_computer` furniture now and housing seats it on the same spot (`COCKPIT_DEFAULT_FURNITURE`).
    // (the stash cabinet on the starboard half is the `furn_drawer` furniture since 2026-09-13 — see above)
    ceil.b.build(this.cockpitCeiling, this.ceilMeshes);
    this.cockpitCeiling.name = 'cockpit-ceiling';
    r.add(this.cockpitCeiling);

    /* ── corridor ── */
    P.deck(CORRIDOR, false);
    for (let k = 1; k < ROOMS_PER_SIDE; k++) {
      const z = CORRIDOR.minZ + k * SEGMENT;
      // Wall fill between neighbouring rooms + rib + beam. The fill spans the **whole** `ROOM_GAP` (2026-09-12):
      // the room walls cover z ∈ [minZ, maxZ] and the gap is `SEGMENT − ROOM_DEPTH`, so a fixed 0.4 m fill left a
      // 0.3 m slit of open space on each side of it — invisible at 4 m rooms only because nobody looked.
      for (const side of [-1, 1]) {
        const x = side < 0 ? CORRIDOR.minX - WALL / 2 : CORRIDOR.maxX + WALL / 2;
        b.box(WALL, CEIL, ROOM_GAP, x, CEIL / 2, z, M.hull);
        col.addBlocker(x - WALL / 2, 0, z - ROOM_GAP / 2, x + WALL / 2, CEIL, z + ROOM_GAP / 2);
        P.rib(side < 0 ? CORRIDOR.minX + 0.16 : CORRIDOR.maxX - 0.16, z);
      }
      P.beam(CORRIDOR.maxX - CORRIDOR.minX, 0, z, 0);
    }
    // 2026-09-12: one more ceiling beam halfway through every segment — a 9 m pitch in a 3 m corridor read as an
    // empty tube. Decoration only (no rib, no blocker), and it stands over the middle of each room's door.
    for (let k = 0; k < ROOMS_PER_SIDE; k++) P.beam(CORRIDOR.maxX - CORRIDOR.minX, 0, CORRIDOR.minZ + (k + 0.5) * SEGMENT, 0);
    // Wainscot trim along both corridor walls (the rooms' door walls carry none). 2026-09-07: it used to be one
    // full-length bar per side, so the 1.05 m amber line ran straight across every room doorway and read as a rope
    // barring the door. Split it into the segments **between** the doorways instead.
    for (const side of [-1, 1] as const) {
      const x = side < 0 ? CORRIDOR.minX + 0.03 : CORRIDOR.maxX - 0.03;
      const gaps = ROOM_BOXES.filter((rb) => rb.side === side)
        .map((rb) => ({ lo: rb.doorZ - DOOR_WIDTH / 2 - 0.12, hi: rb.doorZ + DOOR_WIDTH / 2 + 0.12 }))
        .sort((a, c) => a.lo - c.lo);
      let z = archBack;   // 2026-09-16: from behind the arch posts, not through them (z 0 … 0.33 is the arch)
      for (const g of [...gaps, { lo: CORRIDOR.maxZ, hi: CORRIDOR.maxZ }]) {
        const len = Math.min(g.lo, CORRIDOR.maxZ) - z;
        if (len > 0.02) b.box(0.05, 0.05, len, x, 1.05, z + len / 2, M.trim);
        z = Math.max(z, g.hi);
      }
    }

    /* ── rooms ── */
    // 2026-09-12 (user's decision): the floor grid lines are **their own meshes** (`gridGroup`), shown only while ship management is
    // up (`setGridVisible`). They reuse `M.grid` — a plain `MeshStandardMaterial` with no maps, i.e. the same program
    // key as the deck materials already on screen — so the first reveal compiles nothing (no shader hitch).
    const grid = new GeoBatch();
    for (const rb of ROOM_BOXES) this.rooms.push(this.buildRoom(b, grid, P, rb));
    /* ── cockpit as a furniture area (`COCKPIT_ROOM_INDEX`) + its grid, holes left where the fixed props stand ── */
    this.gridLines(grid, COCKPIT_ROOM_BOX);
    const cockpitGroup = new THREE.Group();
    cockpitGroup.name = 'cockpit-furniture';
    this.root.add(cockpitGroup);
    this.cockpit = { index: COCKPIT_ROOM_INDEX, minX: COCKPIT.minX, maxX: COCKPIT.maxX, minZ: COCKPIT.minZ, maxZ: COCKPIT.maxZ, furnitureGroup: cockpitGroup };
    this.gridGroup.name = 'housing-grid';
    this.gridGroup.visible = false;
    grid.build(this.gridGroup, this.gridMeshes, false, true);
    this.root.add(this.gridGroup);

    /* ── airlock ── */
    const A = { minX: AIRLOCK.minX, maxX: AIRLOCK.maxX, minZ: AIRLOCK.minZ - 0.2, maxZ: AIRLOCK.maxZ };
    b.plane(A.maxX - A.minX, A.maxZ - A.minZ, 0, 0, (A.minZ + A.maxZ) / 2, M.floor);
    b.plane(A.maxX - A.minX, A.maxZ - A.minZ, 0, CEIL, (A.minZ + A.maxZ) / 2, M.hullDark, Math.PI / 2);
    b.box(1.8, 0.04, 0.18, 0, CEIL - 0.03, (A.minZ + A.maxZ) / 2, M.stripRed);
    P.walls(A, WALL, { n: { lo: A.minX, hi: A.maxX, y0: 0, y1: CEIL } });
    const aPropZ = AIRLOCK.minZ + 1.4;                  // was the literal 26.4 (AIRLOCK.minZ was 25)
    P.lockers(A.minX + 0.27, aPropZ, 3, yawFromForward(1, 0));
    P.crates(A.maxX - 0.36, aPropZ, 3, Math.PI / 2);    // supply crates (moved out of the cockpit for the computer desk)
    b.box(1.6, 2.6, 0.08, 0, 1.3, A.maxZ - 0.05, M.hullDark);
    b.box(0.04, 2.4, 0.1, 0, 1.3, A.maxZ - 0.08, M.trim);
    b.box(1.7, 0.1, 0.12, 0, 2.65, A.maxZ - 0.06, M.stripRed);
    const airSign = new TextPlane(1.2, 0.36, 256);
    airSign.mesh.position.set(0, 2.85, A.maxZ - 0.14);
    airSign.mesh.rotation.y = Math.PI;
    airSign.set(['에어락'], '#ff8a7a', 'rgba(10,6,6,0.85)');
    r.add(airSign.mesh);
    this.screens.push(airSign);

    b.build(r, this.meshes);

    // rotating beacon over the airlock door
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff5a3a, transparent: true, opacity: 0.8 });
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), this.beaconMat);
    this.beacon.position.set(0, 3.0, A.maxZ - 0.25);
    r.add(this.beacon);

    // Light places (2026-09-10): the ten places this ship used to hang its own PointLights (cockpit 4, corridor 5, airlock 1)
    // plus one per room. `HUB_POINT_LIGHTS` real lights serve the nearest of them — see `LightPool` / `updateNear`.
    const fx = (x: number, y: number, z: number, color: number, intensity: number, distance: number): LightFixture => ({ x, y, z, color, intensity, distance });
    this.staticFixtures.push(
      fx(-2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9),
      fx(2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9),
      fx(0, 2.3, C.minZ + 0.9, 0x5fd7ff, 10, 7),
      fx(px - 1.2, 2.4, pz, 0xffb347, 12, 6),
    );
    // Corridor: **two** places per segment since 2026-09-12 (a 9 m pitch left the halfway point dark at `distance` 8).
    for (let k = 0; k < ROOMS_PER_SIDE; k++) {
      for (const t of [0.25, 0.75]) this.staticFixtures.push(fx(0, CEIL - 0.25, CORRIDOR.minZ + (k + t) * SEGMENT, 0xeef2ff, 14, 8));
    }
    this.staticFixtures.push(fx(0, 2.7, AIRLOCK.minZ + 1.3, 0xff6a4a, 8, 5));   // was the literal 26.3
    // Rooms: **two** places per room since 2026-09-12 — one ceiling lamp with `ROOM_LIGHT_DISTANCE` (7 m from
    // y 2.6) only reaches 6.5 m across the floor, and an 8 × 8 m room's corner is 5.7 m from its centre with the
    // walls in the way. The two sit at z ± ROOM_DEPTH/4 so each half of the room has one overhead.
    for (const rb of ROOM_BOXES) {
      const cxr = (rb.minX + rb.maxX) / 2, czr = (rb.minZ + rb.maxZ) / 2;
      this.roomFixtures[rb.index] = [-1, 1].map((s) =>
        fx(cxr, CEIL - 0.6, czr + s * ROOM_DEPTH / 4, 0xfff0d8, ROOM_LIGHT_INTENSITY, ROOM_LIGHT_DISTANCE));
      for (const f of this.roomFixtures[rb.index]) this.fixtureRoom.set(f, rb.index);
    }
    this.lightPool = new LightPool(r, HUB_POINT_LIGHTS, this.staticFixtures.slice());

    // space outside
    this.stars = new Starfield(320, 1800, 11);
    r.add(this.stars.points);
    this.planet = new Planet(110, 0x6c8a5a, 0x8fd0ff);
    this.planet.group.position.set(-70, -50, -360);
    r.add(this.planet.group);
    // The window warp: the nose is −Z (the cockpit viewport wall); the hull is ~9 m off the axis, the streak shell starts at 26
    this.warp = new ViewportWarp(r, this.stars, this.planet, HUB_TRAVEL_WARP_STRETCH, { forward: new THREE.Vector3(0, 0, -1), rMin: 26, rMax: 240, span: 900 });
  }

  /*
   * `stashCabinet(b, col, x, z)` (the stash cabinet prop) lived here until 2026-09-13 — it is the `furn_drawer` decor furniture
   * now and its look moved to the `drawer` builder in `interiors/Furniture.ts`.
   */

  /**
   * 2026-09-13 (user's decision): erases the cockpit ceiling during ship management (`hidden` true) / brings it back.
   * Only the target is written down and `update` moves the opacity over `COCKPIT_CEILING_FADE_S`. The materials are
   * `transparent` from the start so the program never changes, and once it is fully erased only the group's `visible`
   * is turned off (no light is touched).
   */
  setCockpitCeilingHidden(hidden: boolean): void { this.ceilTarget = hidden ? 1 : 0; }
  /** 0 = ceiling fully shown … 1 = fully faded out (debug / smoke). */
  get cockpitCeilingFade(): number { return this.ceilFade; }

  private tickCeiling(dt: number): void {
    if (this.ceilFade === this.ceilTarget) return;
    const step = Math.max(0, dt) / COCKPIT_CEILING_FADE_S;
    this.ceilFade = this.ceilTarget > this.ceilFade
      ? Math.min(this.ceilTarget, this.ceilFade + step)
      : Math.max(this.ceilTarget, this.ceilFade - step);
    const t = this.ceilFade;
    const opacity = 1 - t * t * (3 - 2 * t);                 // smoothstep
    for (const m of Object.values(this.ceilMats)) {
      m.opacity = opacity;
      m.depthWrite = opacity >= 0.999;                       // a see-through ceiling must not hide what is under it
    }
    this.cockpitCeiling.visible = opacity > 0.001;
  }

  /**
   * 2026-09-12: the ship-management grid lines — turns `gridGroup` on and off. No mesh is added or taken out: only
   * `visible` changes, and neither a light nor a material is created (CLAUDE.md 「never change the point-light count
   * at runtime」).
   */
  setGridVisible(on: boolean): void { this.gridGroup.visible = on; }
  /** Whether the housing grid is showing (debug / smoke). */
  get gridVisible(): boolean { return this.gridGroup.visible; }

  /**
   * Cell lines of one edit area into `g` (2026-09-12). A line segment is drawn only where **at least one** of the two
   * cells it separates is placeable (`roomCellBlocked`), so the cockpit's fixed props (dashboard, seats, pod socket,
   * lockers, bunk) sit in clean holes instead of under a lattice. Consecutive segments are merged into one box.
   */
  private gridLines(g: GeoBatch, rb: RoomBox): void {
    const { cols, rows } = roomGridSize(rb.index);
    const free = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < cols && y < rows && !roomCellBlocked(rb.index, x, y);
    const S = HOUSING_CELL_SIZE;
    // vertical lines (constant x = k), running along +Z
    for (let k = 0; k <= cols; k++) {
      let start = -1;
      for (let y = 0; y <= rows; y++) {
        const on = y < rows && (free(k - 1, y) || free(k, y));
        if (on && start < 0) start = y;
        if (!on && start >= 0) {
          const len = (y - start) * S;
          g.box(0.02, 0.006, len, rb.minX + k * S, 0.004, rb.minZ + start * S + len / 2, M.grid);
          start = -1;
        }
      }
    }
    // horizontal lines (constant z = k), running along +X
    for (let k = 0; k <= rows; k++) {
      let start = -1;
      for (let x = 0; x <= cols; x++) {
        const on = x < cols && (free(x, k - 1) || free(x, k));
        if (on && start < 0) start = x;
        if (!on && start >= 0) {
          const len = (x - start) * S;
          g.box(len, 0.006, 0.02, rb.minX + start * S + len / 2, 0.004, rb.minZ + k * S, M.grid);
          start = -1;
        }
      }
    }
  }

  /** One housing room: floor, walls with a corridor door, emissive strips and the door sign (grid lines go into `grid`). */
  private buildRoom(b: GeoBatch, grid: GeoBatch, P: Parts, rb: RoomBox): RoomDef {
    const side = rb.side;
    const face = side < 0 ? CORRIDOR.minX : CORRIDOR.maxX;          // corridor wall face on this side
    const doorLo = rb.doorZ - DOOR_WIDTH / 2, doorHi = rb.doorZ + DOOR_WIDTH / 2;
    const cx = (rb.minX + rb.maxX) / 2, cz = (rb.minZ + rb.maxZ) / 2;

    // floor + ceiling reach through the door wall to the corridor face (no gap in the doorway)
    const fMinX = side < 0 ? rb.minX : face, fMaxX = side < 0 ? face : rb.maxX;
    b.plane(fMaxX - fMinX, rb.maxZ - rb.minZ, (fMinX + fMaxX) / 2, 0, cz, M.floor);
    b.plane(fMaxX - fMinX, rb.maxZ - rb.minZ, (fMinX + fMaxX) / 2, CEIL, cz, M.hullDark, Math.PI / 2);
    // cell grid — its own batch since 2026-09-12 (shown only in ship management)
    this.gridLines(grid, rb);
    // walls (door on the corridor side)
    const door = { lo: doorLo, hi: doorHi, y0: 0, y1: DOOR_HEIGHT };
    P.walls({ minX: rb.minX, maxX: rb.maxX, minZ: rb.minZ, maxZ: rb.maxZ }, WALL, side < 0 ? { e: door } : { w: door });
    // Door frame, standing **in the corridor just clear of the wall slab**. It used to sit at `face ∓ 0.02`, i.e.
    // buried 3 cm inside the 30 cm door wall, so the posts and the header intersected the wall segments around the
    // opening (visible z-fighting on the frame). `face − side · 0.06` puts the 10 cm trim wholly on the corridor side.
    const fx = face - side * 0.06;
    b.box(0.1, DOOR_HEIGHT, 0.1, fx, DOOR_HEIGHT / 2, doorLo - 0.05, M.trim);
    b.box(0.1, DOOR_HEIGHT, 0.1, fx, DOOR_HEIGHT / 2, doorHi + 0.05, M.trim);
    b.box(0.1, 0.1, DOOR_WIDTH + 0.2, fx, DOOR_HEIGHT + 0.05, rb.doorZ, M.trim);
    // emissive strips: white bands high on both side walls (nothing hangs under the ceiling, so the housing-mode
    // camera above the room sees the whole floor), a cyan band on the outer wall, amber threshold.
    // Each room owns **its own material instances** so `setRoomLit` can dim an empty room (ROOM_STRIP_DIM) without
    // touching the rest of the ship; GeoBatch groups by material, so a room costs 3 extra merged meshes.
    const white = M.stripWhite.clone(), cyan = M.stripCyan.clone(), amber = M.stripAmber.clone();
    for (const m of [white, cyan, amber]) m.emissiveIntensity = ROOM_STRIP_DIM;
    this.stripMats[rb.index] = [white, cyan, amber];
    for (const zz of [rb.minZ + 0.03, rb.maxZ - 0.03]) b.box(ROOM_GRID_COLS * HOUSING_CELL_SIZE * 0.7, 0.08, 0.04, cx, CEIL - 0.35, zz, white);
    const outerX = side < 0 ? rb.minX + 0.03 : rb.maxX - 0.03;
    b.box(0.04, 0.08, ROOM_DEPTH * 0.7, outerX, 2.4, cz, cyan);   // was the literal 3.0 (= 0.75 × the old 4 m wall)
    b.box(0.06, 0.02, DOOR_WIDTH - 0.2, face + (side < 0 ? -0.45 : 0.45), 0.012, rb.doorZ, amber);
    // (2026-09-16: the sliding door that stood in this doorway, inside the wall slab, is gone — the opening is open)
    // Sign above the door (corridor side) — second line = purpose, rewritten by the hub.
    // 2026-09-16: it was 0.5 m tall centred at `DOOR_HEIGHT + 0.42` (2.57 … 3.07 m), and the half-segment ceiling beam
    // (`CEIL − 0.22` = 2.98 m, 0.28 m deep, reaching the wall) stands right over the door — so the beam cut through
    // the sign's top 9 cm. Now it fits between the frame header (top `DOOR_HEIGHT + 0.1`) and that beam.
    const signH = 0.44;
    const sign = new TextPlane(1.3, signH, 384);
    sign.mesh.position.set(fx, DOOR_HEIGHT + 0.1 + 0.02 + signH / 2, rb.doorZ);
    sign.mesh.rotation.y = -side * Math.PI / 2;
    sign.set([`방 ${rb.index + 1}`, '빈 방'], '#e8e6e1', 'rgba(6,8,10,0.85)', '#9fb4c8');
    this.root.add(sign.mesh);
    this.screens.push(sign);
    // (the corridor door console was removed in the Phase 8 UI pass — E on a door did nothing but open the room menu)

    const furnitureGroup = new THREE.Group();
    furnitureGroup.name = `room-${rb.index}`;
    this.root.add(furnitureGroup);
    return { index: rb.index, side, minX: rb.minX, maxX: rb.maxX, minZ: rb.minZ, maxZ: rb.maxZ, sign, furnitureGroup };
  }

  /** Rewrite a room's door sign (`방 n` + purpose label). */
  setRoomLabel(room: number, purposeLabel: string, accent = '#e8e6e1'): void {
    const def = this.rooms[room];
    if (def) def.sign.set([`방 ${room + 1}`, purposeLabel], accent, 'rgba(6,8,10,0.85)', '#9fb4c8');
  }

  /**
   * Room lights (Phase 8): a room with a purpose lights its own emissive wall strips (`ROOM_STRIP_LIT`) and becomes a
   * candidate for the point-light pool; an empty one stays at `ROOM_STRIP_DIM` and gets no light.
   */
  setRoomLit(room: number, lit: boolean): void {
    const mats = this.stripMats[room];
    if (!mats) return;
    this.roomLit[room] = lit;
    const v = lit ? ROOM_STRIP_LIT : ROOM_STRIP_DIM;
    for (const m of mats) m.emissiveIntensity = v;
  }

  /** Lit rooms (debug / smoke). */
  isRoomLit(room: number): boolean { return this.roomLit[room] === true; }
  /** Room each pool light currently serves, −1 for a corridor / cockpit / airlock fixture or a parked light (debug / smoke). */
  get roomLightRooms(): readonly number[] {
    const list = this.lightPool.fixtureList;
    return this.lightPool.assignment.map((i) => (i >= 0 ? this.fixtureRoom.get(list[i]) ?? -1 : -1));
  }
  /** The ship's light pool (debug / smoke). */
  get lights(): LightPool { return this.lightPool; }

  /**
   * Player-proximity animation: the light pool (the sliding doors were removed 2026-09-16). The light **count never changes** and no light is
   * ever toggled — a light that must move to another fixture first ramps its intensity to 0, is repositioned, then
   * ramps back up (`LightPool`). A lit room is a candidate only while it is one of the nearest `ROOM_LIGHT_POOL`.
   */
  updateNear(dt: number, px: number, pz: number): void {
    this.pickRooms(px, pz);
    this.lightPool.update(dt, px, pz);
  }

  /** Nearest `ROOM_LIGHT_POOL` lit rooms → the pool's candidate list (rewritten only when that set changes). */
  private pickRooms(px: number, pz: number): void {
    const next = this.roomPickNext;
    next.length = 0;
    for (const rb of ROOM_BOXES) {
      if (!this.roomLit[rb.index]) continue;
      // nearest of the room's fixtures ranks the room (2026-09-12: a room owns two of them)
      let d = Infinity;
      for (const f of this.roomFixtures[rb.index]) d = Math.min(d, (f.x - px) * (f.x - px) + (f.z - pz) * (f.z - pz));
      this.roomDist[rb.index] = d;
      next.push(rb.index);
    }
    next.sort((a, b) => this.roomDist[a] - this.roomDist[b]);
    if (next.length > ROOM_LIGHT_POOL) next.length = ROOM_LIGHT_POOL;
    next.sort((a, b) => a - b);
    const cur = this.roomPick;
    if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;
    this.roomPick = next.slice();
    const list: LightFixture[] = this.staticFixtures.slice();
    for (const i of this.roomPick) list.push(...this.roomFixtures[i]);
    this.lightPool.setFixtures(list);
  }

  /** 목표 행성 (Phase 11): the planet outside the cockpit viewport takes the selected planet's colours. */
  setPlanetLook(color: number, atmo: number): void {
    this.planet.setColors(color, atmo);
  }

  /** No 목표 행성 → the planet outside the window is hidden (2026-09-09): see `ShipInterior.setPlanetVisible`. */
  setPlanetVisible(on: boolean): void {
    this.planet.setShown(on);
  }

  /** The window warp (2026-09-09): see `ShipInterior.setWarp` — stars → streaks, planet out and back in as `dest`. */
  setWarp(speed: number, dest?: WarpDestination): void {
    this.warp.set(speed, dest);
  }

  update(dt: number, time: number): void {
    this.stars.update(dt);
    this.planet.update(dt);
    this.warp.update(dt);
    this.tickCeiling(dt);
    this.beaconMat.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(time * 4));
  }

  dispose(): void {
    disposeMeshes(this.meshes);
    disposeMeshes(this.ceilMeshes);
    this.cockpitCeiling.removeFromParent();
    for (const m of Object.values(this.ceilMats)) m.dispose();   // own clones, not the shared palette
    disposeMeshes(this.gridMeshes);
    this.gridGroup.removeFromParent();
    this.cockpit.furnitureGroup.removeFromParent();
    this.lightPool.dispose();
    for (const mats of this.stripMats) for (const m of mats ?? []) m.dispose();     // per-room clones, not shared
    this.stripMats.length = 0;
    for (const s of this.screens) s.dispose();
    this.terminal.screen.dispose();
    for (const rd of this.rooms) rd.furnitureGroup.removeFromParent();
    this.warp.dispose();
    this.stars.dispose();
    this.planet.dispose();
    this.beacon.geometry.dispose(); this.beaconMat.dispose();
    this.root.removeFromParent();
  }
}
