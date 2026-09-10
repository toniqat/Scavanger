import * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import {
  HOUSING_CELL_SIZE, HUB_POINT_LIGHTS, HUB_TRAVEL_WARP_STRETCH, ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_LIGHT_DISTANCE, ROOM_LIGHT_INTENSITY, ROOM_LIGHT_POOL,
  ROOM_STRIP_DIM, ROOM_STRIP_LIT, SHIP_ROOM_COUNT,
} from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { ShipDoors } from './Doors';
import { Parts } from './parts';
import { LightPool, type LightFixture } from './LightPool';
import { Starfield, Planet } from './Starfield';
import { ViewportWarp } from './WarpStreaks';
import { implantBay, shipComputer, type ShipStations, type StationDef } from './stations';
import { TextPlane } from '../Labels';
import { AIRLOCK, CEIL, COCKPIT, CORRIDOR, DOOR_HEIGHT, DOOR_WIDTH, ROOM_BOXES, ROOMS_PER_SIDE, SEGMENT, WALL, type RoomBox } from './RoomLayout';
import type { PodSlotDef, RoomDef, ShipInterior, TerminalDef, WarpDestination } from './types';

/**
 * Personal ship (함선 꾸미기, 2026-09-06): cockpit (−Z) → 3 m corridor running +Z → ten 4 × 4 m housing rooms
 * (five per side, doors on the corridor) → airlock. Every coordinate lives in `RoomLayout.ts`.
 * Static geometry is merged per material (`GeoBatch`); the point-light count is constant: **`HUB_POINT_LIGHTS`**
 * pool lights (2026-09-10, was 13 lights of its own) serve the light fixtures nearest the player — cockpit 4,
 * corridor 5, airlock 1 and the nearest `ROOM_LIGHT_POOL` lit rooms (`LightPool`: re-anchored and ramped, never
 * toggled). Furniture is rendered by `Furniture.ts` into `RoomDef.furnitureGroup`.
 *
 * Phase 8 (2026-09-06): the built-in workbench and the hydroponics rack are gone (정비 벤치 / 재배층 are placeable
 * furniture now), every doorway carries a sliding `ShipDoors` door and each room owns its emissive strip materials
 * so an empty room reads dark (`ROOM_STRIP_DIM`) and an assigned one lit (`ROOM_STRIP_LIT`).
 *
 * Phase 9 UI pass (2026-09-07) — cockpit clean-up:
 *   • the console pedestal terminal is **gone**; the dashboard's centre monitor *is* `terminal.screen` (the 항법 /
 *     통신 side readouts were dropped with it), so nothing stands on the walk-in line any more;
 *   • the **함선 컴퓨터** moved from the +X wall (where its 기업 네트워크 prompt fought the launch pod's boarding
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
  readonly airlock = new THREE.Vector3(0, 0, 26.0);
  readonly airlockYaw = 0;
  readonly pods: PodSlotDef[] = [];
  readonly terminal: TerminalDef;
  readonly computer: StationDef;
  readonly stations: ShipStations;
  readonly rooms: RoomDef[] = [];
  /** 자동문: room doorways + the cockpit arch (own meshes, never merged, no collider). */
  readonly doors = new ShipDoors(this.root);

  private meshes: THREE.Mesh[] = [];
  private stars: Starfield;
  private planet: Planet;
  /** 창문 워프 (2026-09-09): streaks past the cockpit viewport, driven by the hub through `setWarp`. */
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
  /** The ten fixed fixtures (cockpit 4, corridor 5, airlock 1). */
  private readonly staticFixtures: LightFixture[] = [];
  /** One ceiling fixture per room; only lit rooms are candidates, and only the nearest `ROOM_LIGHT_POOL` of them. */
  private readonly roomFixtures: LightFixture[] = [];
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
    P.deck(C, false);
    P.walls(C, WALL, {
      n: { lo: -3.2, hi: 3.2, y0: 1.0, y1: 2.7 },                              // viewport
      s: { lo: CORRIDOR.minX, hi: CORRIDOR.maxX, y0: 0, y1: 2.6 },              // corridor arch
    });
    P.glass(r, 6.4, 1.7, 0, 1.85, C.minZ - WALL / 2, 0, this.meshes);
    for (const x of [-3.3, 0, 3.3]) { P.rib(x, C.minZ + 0.16); P.beam(C.maxZ - C.minZ, x, C.minZ + (C.maxZ - C.minZ) / 2, Math.PI / 2); }
    // rear ribs: only the starboard one survives — the port rear corner is the 함선 컴퓨터 desk now, and the rib
    // stood inside it (it hid the 기업 네트워크 monitor).
    P.rib(3.3, C.maxZ - 0.16);
    P.rib(C.minX + 0.16, -3.95);
    // corridor arch trim
    b.box(0.12, 2.6, 0.36, CORRIDOR.minX - 0.06, 1.3, C.maxZ + WALL / 2, M.trim);
    b.box(0.12, 2.6, 0.36, CORRIDOR.maxX + 0.06, 1.3, C.maxZ + WALL / 2, M.trim);
    b.box(3.2, 0.1, 0.36, 0, 2.65, C.maxZ + WALL / 2, M.trim);
    b.box(2.4, 0.06, 0.05, 0, 2.55, C.maxZ - 0.02, M.stripAmber);

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
     * 함선 터미널 (Phase 9 UI pass): the cockpit console pedestal between the pilot seats is **gone** — it stood on
     * the walk-in line and its 기업 네트워크 neighbour clashed with the launch pod. The dashboard's centre readout
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
    P.signStrip(0, CEIL - 0.07, C.minZ + 0.9, 1.8, M.stripCyan, 0);      // ceiling bar over the dashboard

    // −X wall (front → back): implant bay, bunk. The bunk sits flush against the wall (x −5.0 … −4.0) and was moved
    // aft to z −2.8 … −0.7 — it used to run into the rear-wall lockers that stood where the 함선 컴퓨터 is now.
    const faceX = yawFromForward(1, 0);
    const implantDef = implantBay(b, col, C.minX + 0.95, -4.9, faceX);
    const bunkX = C.minX + 0.5, bunkZ = -1.75;
    b.boxB(1.0, 0.5, 2.1, bunkX, 0, bunkZ, M.hullDark);
    b.box(0.94, 0.14, 2.0, bunkX, 0.57, bunkZ, M.fabric);
    b.box(0.5, 0.1, 0.4, bunkX, 0.7, bunkZ - 0.85, M.padding);
    col.addBox(bunkX, 0, bunkZ, 1.0, 0.7, 2.1);

    // +X wall (front → back): storage lockers (the workbench moved to the 작업실), launch pod. The 함선 컴퓨터 used to
    // stand here and its 기업 네트워크 prompt overlapped the pod's boarding prompt — it moved to the rear wall.
    const faceNegX = yawFromForward(-1, 0);
    P.lockers(C.maxX - 0.27, -4.7, 2, faceNegX);
    // pod socket: floor plate, rear frame, side lips + toggleable door blocker (cell stays walkable, see README)
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

    // +Z (rear) wall, port side: **함선 컴퓨터** (기업 네트워크) where the lockers used to be — they overlapped the
    // bunk and the desk needed a spot away from the launch pod. Monitors face −Z, into the cockpit.
    const cp = shipComputer(b, col, -3.15, C.maxZ - 0.35, 0);
    const cScreen = new TextPlane(0.56, 0.34, 256, false);
    cScreen.mesh.position.copy(cp.screenPos);
    cScreen.mesh.rotation.copy(cp.screenRot);
    cScreen.set(['기업 네트워크', '접속 대기'], '#7cf07a', 'rgba(4,14,10,1)', '#9fd8b0');
    r.add(cScreen.mesh);
    this.screens.push(cScreen);
    this.computer = { position: cp.position, yaw: cp.yaw };
    // stash cabinet on the starboard half of the rear wall (clear of the arch and the pod socket)
    this.stashCabinet(b, col, 2.4, C.maxZ - 0.3);
    this.stations = { implantBay: implantDef };
    // 자동문 on the cockpit arch (x −1.5 … 1.5, the wall slab at z 0 … 0.3)
    this.doors.add(0, C.maxZ + WALL / 2, CORRIDOR.maxX - CORRIDOR.minX, 2.55, 0.12, 'x');

    /* ── corridor ── */
    P.deck(CORRIDOR, false);
    for (let k = 1; k < ROOMS_PER_SIDE; k++) {
      const z = CORRIDOR.minZ + k * SEGMENT;
      // wall fill between neighbouring rooms + rib + beam
      for (const side of [-1, 1]) {
        const x = side < 0 ? CORRIDOR.minX - WALL / 2 : CORRIDOR.maxX + WALL / 2;
        b.box(WALL, CEIL, 0.4, x, CEIL / 2, z, M.hull);
        col.addBlocker(x - WALL / 2, 0, z - 0.2, x + WALL / 2, CEIL, z + 0.2);
        P.rib(side < 0 ? CORRIDOR.minX + 0.16 : CORRIDOR.maxX - 0.16, z);
      }
      P.beam(CORRIDOR.maxX - CORRIDOR.minX, 0, z, 0);
    }
    // Wainscot trim along both corridor walls (the rooms' door walls carry none). 2026-09-07: it used to be one
    // full-length bar per side, so the 1.05 m amber line ran straight across every room doorway and read as a rope
    // barring the door. Split it into the segments **between** the doorways instead.
    for (const side of [-1, 1] as const) {
      const x = side < 0 ? CORRIDOR.minX + 0.03 : CORRIDOR.maxX - 0.03;
      const gaps = ROOM_BOXES.filter((rb) => rb.side === side)
        .map((rb) => ({ lo: rb.doorZ - DOOR_WIDTH / 2 - 0.12, hi: rb.doorZ + DOOR_WIDTH / 2 + 0.12 }))
        .sort((a, c) => a.lo - c.lo);
      let z = CORRIDOR.minZ;
      for (const g of [...gaps, { lo: CORRIDOR.maxZ, hi: CORRIDOR.maxZ }]) {
        const len = Math.min(g.lo, CORRIDOR.maxZ) - z;
        if (len > 0.02) b.box(0.05, 0.05, len, x, 1.05, z + len / 2, M.trim);
        z = Math.max(z, g.hi);
      }
    }

    /* ── rooms ── */
    for (const rb of ROOM_BOXES) this.rooms.push(this.buildRoom(b, P, rb));

    /* ── airlock ── */
    const A = { minX: AIRLOCK.minX, maxX: AIRLOCK.maxX, minZ: AIRLOCK.minZ - 0.2, maxZ: AIRLOCK.maxZ };
    b.plane(A.maxX - A.minX, A.maxZ - A.minZ, 0, 0, (A.minZ + A.maxZ) / 2, M.floor);
    b.plane(A.maxX - A.minX, A.maxZ - A.minZ, 0, CEIL, (A.minZ + A.maxZ) / 2, M.hullDark, Math.PI / 2);
    b.box(1.8, 0.04, 0.18, 0, CEIL - 0.03, (A.minZ + A.maxZ) / 2, M.stripRed);
    P.walls(A, WALL, { n: { lo: A.minX, hi: A.maxX, y0: 0, y1: CEIL } });
    P.lockers(A.minX + 0.27, 26.4, 3, yawFromForward(1, 0));
    P.crates(A.maxX - 0.36, 26.4, 3, Math.PI / 2);      // supply crates (moved out of the cockpit for the computer desk)
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

    // 광원 자리 (2026-09-10): the ten places this ship used to hang its own PointLights (cockpit 4, corridor 5, airlock 1)
    // plus one per room. `HUB_POINT_LIGHTS` real lights serve the nearest of them — see `LightPool` / `updateNear`.
    const fx = (x: number, y: number, z: number, color: number, intensity: number, distance: number): LightFixture => ({ x, y, z, color, intensity, distance });
    this.staticFixtures.push(
      fx(-2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9),
      fx(2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9),
      fx(0, 2.3, C.minZ + 0.9, 0x5fd7ff, 10, 7),
      fx(px - 1.2, 2.4, pz, 0xffb347, 12, 6),
    );
    for (let k = 0; k < ROOMS_PER_SIDE; k++) this.staticFixtures.push(fx(0, CEIL - 0.25, CORRIDOR.minZ + k * SEGMENT + SEGMENT / 2, 0xeef2ff, 14, 8));
    this.staticFixtures.push(fx(0, 2.7, 26.3, 0xff6a4a, 8, 5));
    for (const rb of ROOM_BOXES) {
      this.roomFixtures[rb.index] = fx((rb.minX + rb.maxX) / 2, CEIL - 0.6, (rb.minZ + rb.maxZ) / 2, 0xfff0d8, ROOM_LIGHT_INTENSITY, ROOM_LIGHT_DISTANCE);
    }
    this.lightPool = new LightPool(r, HUB_POINT_LIGHTS, this.staticFixtures.slice());

    // space outside
    this.stars = new Starfield(320, 1800, 11);
    r.add(this.stars.points);
    this.planet = new Planet(110, 0x6c8a5a, 0x8fd0ff);
    this.planet.group.position.set(-70, -50, -360);
    r.add(this.planet.group);
    // 창문 워프: the nose is −Z (the cockpit viewport wall); the hull is ~9 m off the axis, the streak shell starts at 26
    this.warp = new ViewportWarp(r, this.stars, this.planet, HUB_TRAVEL_WARP_STRETCH, { forward: new THREE.Vector3(0, 0, -1), rMin: 26, rMax: 240, span: 900 });
  }

  /** 창고 cabinet (stash prop, decorative — the stash grid lives on the Tab ship screen). */
  private stashCabinet(b: GeoBatch, col: BoxInteriorCollider, x: number, z: number): void {
    b.boxB(0.9, 2.2, 0.55, x, 0, z, M.hullDark);
    b.box(0.94, 0.05, 0.58, x, 2.22, z, M.trimDark);
    for (let k = 0; k < 3; k++) {
      b.box(0.8, 0.5, 0.03, x, 0.4 + k * 0.62, z - 0.29, M.hullLight);
      b.box(0.3, 0.04, 0.03, x, 0.4 + k * 0.62, z - 0.31, M.trim);
    }
    b.box(0.7, 0.05, 0.04, x, 2.05, z - 0.3, M.stripAmber);
    col.addBox(x, 0, z, 0.9, 2.2, 0.55);
  }

  /** One housing room: floor + grid, walls with a corridor door, emissive strips and the door sign. */
  private buildRoom(b: GeoBatch, P: Parts, rb: RoomBox): RoomDef {
    const side = rb.side;
    const face = side < 0 ? CORRIDOR.minX : CORRIDOR.maxX;          // corridor wall face on this side
    const doorLo = rb.doorZ - DOOR_WIDTH / 2, doorHi = rb.doorZ + DOOR_WIDTH / 2;
    const cx = (rb.minX + rb.maxX) / 2, cz = (rb.minZ + rb.maxZ) / 2;

    // floor + ceiling reach through the door wall to the corridor face (no gap in the doorway)
    const fMinX = side < 0 ? rb.minX : face, fMaxX = side < 0 ? face : rb.maxX;
    b.plane(fMaxX - fMinX, rb.maxZ - rb.minZ, (fMinX + fMaxX) / 2, 0, cz, M.floor);
    b.plane(fMaxX - fMinX, rb.maxZ - rb.minZ, (fMinX + fMaxX) / 2, CEIL, cz, M.hullDark, Math.PI / 2);
    // cell grid
    for (let k = 0; k <= ROOM_GRID_COLS; k++) b.box(0.02, 0.006, rb.maxZ - rb.minZ, rb.minX + k * HOUSING_CELL_SIZE, 0.004, cz, M.grid);
    for (let k = 0; k <= ROOM_GRID_ROWS; k++) b.box(rb.maxX - rb.minX, 0.006, 0.02, cx, 0.004, rb.minZ + k * HOUSING_CELL_SIZE, M.grid);
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
    b.box(0.04, 0.08, 3.0, outerX, 2.4, cz, cyan);
    b.box(0.06, 0.02, DOOR_WIDTH - 0.2, face + (side < 0 ? -0.45 : 0.45), 0.012, rb.doorZ, amber);
    // 자동문 in the doorway (inside the wall slab between the room and the corridor face)
    this.doors.add(face + (side < 0 ? -WALL / 2 : WALL / 2), rb.doorZ, DOOR_WIDTH, DOOR_HEIGHT - 0.05, 0.1, 'z');
    // sign above the door (corridor side) — second line = purpose, rewritten by the hub
    const sign = new TextPlane(1.3, 0.5, 384);
    sign.mesh.position.set(fx, DOOR_HEIGHT + 0.42, rb.doorZ);
    sign.mesh.rotation.y = -side * Math.PI / 2;
    sign.set([`방 ${rb.index + 1}`, '빈 방'], '#e8e6e1', 'rgba(6,8,10,0.85)', '#9fb4c8');
    this.root.add(sign.mesh);
    this.screens.push(sign);
    // (the corridor door console was removed in the Phase 8 UI pass — E on a door did nothing but open the 방 메뉴)

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
   * 방 조명 (Phase 8): a room with a purpose lights its own emissive wall strips (`ROOM_STRIP_LIT`) and becomes a
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
    return this.lightPool.assignment.map((i) => (i >= 0 ? this.roomFixtures.indexOf(list[i]) : -1));
  }
  /** The ship's light pool (debug / smoke). */
  get lights(): LightPool { return this.lightPool; }

  /**
   * Player-proximity animation: sliding doors + the light pool. The light **count never changes** and no light is
   * ever toggled — a light that must move to another fixture first ramps its intensity to 0, is repositioned, then
   * ramps back up (`LightPool`). A lit room is a candidate only while it is one of the nearest `ROOM_LIGHT_POOL`.
   */
  updateNear(dt: number, px: number, pz: number): void {
    this.doors.update(dt, px, pz);
    this.pickRooms(px, pz);
    this.lightPool.update(dt, px, pz);
  }

  /** Nearest `ROOM_LIGHT_POOL` lit rooms → the pool's candidate list (rewritten only when that set changes). */
  private pickRooms(px: number, pz: number): void {
    const next = this.roomPickNext;
    next.length = 0;
    for (const rb of ROOM_BOXES) {
      if (!this.roomLit[rb.index]) continue;
      const f = this.roomFixtures[rb.index];
      this.roomDist[rb.index] = (f.x - px) * (f.x - px) + (f.z - pz) * (f.z - pz);
      next.push(rb.index);
    }
    next.sort((a, b) => this.roomDist[a] - this.roomDist[b]);
    if (next.length > ROOM_LIGHT_POOL) next.length = ROOM_LIGHT_POOL;
    next.sort((a, b) => a - b);
    const cur = this.roomPick;
    if (cur.length === next.length && cur.every((v, i) => v === next[i])) return;
    this.roomPick = next.slice();
    const list: LightFixture[] = this.staticFixtures.slice();
    for (const i of this.roomPick) list.push(this.roomFixtures[i]);
    this.lightPool.setFixtures(list);
  }

  /** 목표 행성 (Phase 11): the planet outside the cockpit viewport takes the selected planet's colours. */
  setPlanetLook(color: number, atmo: number): void {
    this.planet.setColors(color, atmo);
  }

  /** 목표 행성 없음 → 창밖 행성 숨김 (2026-09-09): see `ShipInterior.setPlanetVisible`. */
  setPlanetVisible(on: boolean): void {
    this.planet.setShown(on);
  }

  /** 창문 워프 (2026-09-09): see `ShipInterior.setWarp` — stars → streaks, planet out and back in as `dest`. */
  setWarp(speed: number, dest?: WarpDestination): void {
    this.warp.set(speed, dest);
  }

  update(dt: number, time: number): void {
    this.stars.update(dt);
    this.planet.update(dt);
    this.warp.update(dt);
    this.beaconMat.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(time * 4));
  }

  dispose(): void {
    this.doors.dispose();
    disposeMeshes(this.meshes);
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
