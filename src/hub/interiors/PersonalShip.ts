import * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import { HOUSING_CELL_SIZE, ROOM_GRID_COLS, ROOM_GRID_ROWS } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { Parts, fixture } from './parts';
import { Starfield, Planet } from './Starfield';
import { hydroponics, implantBay, shipComputer, type ShipStations, type StationDef } from './stations';
import { TextPlane } from '../Labels';
import { AIRLOCK, CEIL, COCKPIT, CORRIDOR, DOOR_HEIGHT, DOOR_WIDTH, ROOM_BOXES, ROOMS_PER_SIDE, SEGMENT, WALL, type RoomBox } from './RoomLayout';
import type { PodSlotDef, RoomDef, ShipInterior, TerminalDef, WorkbenchDef } from './types';

/**
 * Personal ship (함선 꾸미기, 2026-09-06): cockpit (−Z) → 3 m corridor running +Z → ten 4 × 4 m housing rooms
 * (five per side, doors on the corridor) → airlock. Every coordinate lives in `RoomLayout.ts`.
 * Static geometry is merged per material (`GeoBatch`); rooms are lit by emissive strips only and the point-light
 * count is constant (**10**: cockpit 4, corridor 5, airlock 1). Furniture is rendered by `Furniture.ts` into
 * `RoomDef.furnitureGroup`.
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
  readonly workbench: WorkbenchDef;
  readonly computer: StationDef;
  readonly stations: ShipStations;
  readonly rooms: RoomDef[] = [];
  readonly facility: StationDef;

  private meshes: THREE.Mesh[] = [];
  private lights: THREE.PointLight[] = [];
  private stars: Starfield;
  private planet: Planet;
  private screens: TextPlane[] = [];
  private beacon: THREE.Mesh;
  private beaconMat: THREE.MeshBasicMaterial;

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
    for (const x of [-3.3, 3.3]) P.rib(x, C.maxZ - 0.16);
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
    for (let i = 0; i < 3; i++) {
      const tp = new TextPlane(1.5, 0.42, 384);
      tp.mesh.position.set(-2 + i * 2, 1.12, C.minZ + 0.42);
      tp.mesh.rotation.x = -0.6;
      tp.set(i === 0 ? ['항법', '궤도 유지'] : i === 1 ? ['동력', '98 %'] : ['통신', '대기'], i === 1 ? '#7cf07a' : '#5fd7ff', 'rgba(6,14,20,0.9)');
      r.add(tp.mesh);
      this.screens.push(tp);
    }

    // −X wall (front → back): implant bay, terminal, bunk
    const faceX = yawFromForward(1, 0);
    const implantDef = implantBay(b, col, C.minX + 0.95, -4.9, faceX);
    const tx = C.minX + 0.75, tz = -3.0;
    const c = P.consolePedestal(tx, tz, faceX);
    const screen = new TextPlane(0.92, 0.6, 512, false);
    screen.mesh.position.copy(c.screenPos);
    screen.mesh.rotation.copy(c.screenRot);
    r.add(screen.mesh);
    this.terminal = { position: new THREE.Vector3(tx + 0.9, 0, tz), yaw: faceX, screen };
    P.signStrip(C.minX + WALL / 2 + 0.03, 2.3, tz, 1.2, M.stripCyan, Math.PI / 2);
    b.boxB(1.0, 0.5, 2.1, C.minX + 0.55, 0, -1.2, M.hullDark);
    b.box(0.94, 0.14, 2.0, C.minX + 0.55, 0.57, -1.2, M.fabric);
    b.box(0.5, 0.1, 0.4, C.minX + 0.55, 0.7, -2.05, M.padding);
    col.addBox(C.minX + 0.55, 0, -1.2, 1.0, 0.7, 2.1);

    // +X wall (front → back): weapon workbench, ship computer, launch pod
    const faceNegX = yawFromForward(-1, 0);
    const wb = P.workbench(C.maxX - 0.55, -4.9, faceNegX);
    this.workbench = { position: wb.position, yaw: wb.yaw };
    const wbSign = new TextPlane(0.9, 0.3, 256);
    wbSign.mesh.position.copy(wb.signPos);
    wbSign.mesh.rotation.copy(wb.signRot);
    wbSign.set(['정비'], '#9be8ff', 'rgba(6,8,10,0.85)');
    r.add(wbSign.mesh);
    this.screens.push(wbSign);
    // 함선 컴퓨터 (기업 네트워크): desk between the workbench and the pod socket, monitors facing −X
    const cp = shipComputer(b, col, C.maxX - 0.35, -3.1, faceNegX);
    const cScreen = new TextPlane(0.56, 0.34, 256, false);
    cScreen.mesh.position.copy(cp.screenPos);
    cScreen.mesh.rotation.copy(cp.screenRot);
    cScreen.set(['기업 네트워크', '접속 대기'], '#7cf07a', 'rgba(4,14,10,1)', '#9fd8b0');
    r.add(cScreen.mesh);
    this.screens.push(cScreen);
    this.computer = { position: cp.position, yaw: cp.yaw };
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

    // +Z wall: hydroponics + stash cabinet left of the arch, facility console right of it
    const gardenDef = hydroponics(b, col, -3.6, C.maxZ - 0.38, 0);
    this.stashCabinet(b, col, -2.0, C.maxZ - 0.3);
    const fc = P.consolePedestal(2.3, C.maxZ - 0.35, 0);
    const fScreen = new TextPlane(0.92, 0.6, 512, false);
    fScreen.mesh.position.copy(fc.screenPos);
    fScreen.mesh.rotation.copy(fc.screenRot);
    fScreen.set(['함선 시설', '발전기 · 창고'], '#ffd27a', 'rgba(18,12,4,1)', '#e8c890');
    r.add(fScreen.mesh);
    this.screens.push(fScreen);
    this.facility = { position: new THREE.Vector3(2.3, 0, C.maxZ - 1.25), yaw: yawFromForward(0, 1) };
    P.signStrip(2.3, 2.3, C.maxZ - WALL / 2 - 0.03, 1.2, M.stripAmber, 0);
    this.stations = { garden: gardenDef, implantBay: implantDef, bench: { position: wb.position, yaw: wb.yaw } };

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
    // wainscot along both corridor walls (the rooms' door walls carry none)
    for (const side of [-1, 1]) {
      const x = side < 0 ? CORRIDOR.minX + 0.03 : CORRIDOR.maxX - 0.03;
      b.box(0.05, 0.05, CORRIDOR.maxZ - CORRIDOR.minZ, x, 1.05, (CORRIDOR.minZ + CORRIDOR.maxZ) / 2, M.trim);
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

    // constant lights (10): cockpit 4, corridor 5, airlock 1 — never toggled
    fixture(r, -2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9, this.lights);
    fixture(r, 2.4, CEIL - 0.25, -3.2, 0xeef2ff, 18, 9, this.lights);
    fixture(r, 0, 2.3, C.minZ + 0.9, 0x5fd7ff, 10, 7, this.lights);
    fixture(r, px - 1.2, 2.4, pz, 0xffb347, 12, 6, this.lights);
    for (let k = 0; k < ROOMS_PER_SIDE; k++) fixture(r, 0, CEIL - 0.25, CORRIDOR.minZ + k * SEGMENT + SEGMENT / 2, 0xeef2ff, 14, 8, this.lights);
    fixture(r, 0, 2.7, 26.3, 0xff6a4a, 8, 5, this.lights);

    // space outside
    this.stars = new Starfield(320, 1800, 11);
    r.add(this.stars.points);
    this.planet = new Planet(110, 0x6c8a5a, 0x8fd0ff);
    this.planet.group.position.set(-70, -50, -360);
    r.add(this.planet.group);
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

  /** One housing room: floor + grid, walls with a corridor door, emissive strips, door sign + console. */
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
    // door frame (corridor side)
    const fx = face + (side < 0 ? -0.02 : 0.02);
    b.box(0.1, DOOR_HEIGHT, 0.1, fx, DOOR_HEIGHT / 2, doorLo - 0.05, M.trim);
    b.box(0.1, DOOR_HEIGHT, 0.1, fx, DOOR_HEIGHT / 2, doorHi + 0.05, M.trim);
    b.box(0.1, 0.1, DOOR_WIDTH + 0.2, fx, DOOR_HEIGHT + 0.05, rb.doorZ, M.trim);
    // emissive strips: white bands high on both side walls (nothing hangs under the ceiling, so the housing-mode
    // camera above the room sees the whole floor), a cyan band on the outer wall, amber threshold
    for (const zz of [rb.minZ + 0.03, rb.maxZ - 0.03]) b.box(ROOM_GRID_COLS * HOUSING_CELL_SIZE * 0.7, 0.08, 0.04, cx, CEIL - 0.35, zz, M.stripWhite);
    const outerX = side < 0 ? rb.minX + 0.03 : rb.maxX - 0.03;
    b.box(0.04, 0.08, 3.0, outerX, 2.4, cz, M.stripCyan);
    b.box(0.06, 0.02, DOOR_WIDTH - 0.2, face + (side < 0 ? -0.45 : 0.45), 0.012, rb.doorZ, M.stripAmber);
    // sign above the door (corridor side) — second line = purpose, rewritten by the hub
    const sign = new TextPlane(1.3, 0.5, 384);
    sign.mesh.position.set(fx, DOOR_HEIGHT + 0.42, rb.doorZ);
    sign.mesh.rotation.y = -side * Math.PI / 2;
    sign.set([`방 ${rb.index + 1}`, '빈 방'], '#e8e6e1', 'rgba(6,8,10,0.85)', '#9fb4c8');
    this.root.add(sign.mesh);
    this.screens.push(sign);
    // door console (corridor wall, +Z of the door)
    const czc = rb.doorZ + 1.15;
    const cxc = face + (side < 0 ? -0.06 : 0.06);
    b.box(0.12, 0.46, 0.5, cxc, 1.3, czc, M.hullDark);
    b.box(0.03, 0.3, 0.4, cxc + (side < 0 ? 0.07 : -0.07), 1.34, czc, M.screen);
    b.box(0.04, 0.04, 0.44, cxc + (side < 0 ? 0.07 : -0.07), 1.1, czc, M.stripCyan);
    const console: StationDef = { position: new THREE.Vector3(face + (side < 0 ? 0.6 : -0.6), 0, czc), yaw: yawFromForward(side, 0) };

    const furnitureGroup = new THREE.Group();
    furnitureGroup.name = `room-${rb.index}`;
    this.root.add(furnitureGroup);
    return { index: rb.index, side, minX: rb.minX, maxX: rb.maxX, minZ: rb.minZ, maxZ: rb.maxZ, console, sign, furnitureGroup };
  }

  /** Rewrite a room's door sign (`방 n` + purpose label). */
  setRoomLabel(room: number, purposeLabel: string, accent = '#e8e6e1'): void {
    const def = this.rooms[room];
    if (def) def.sign.set([`방 ${room + 1}`, purposeLabel], accent, 'rgba(6,8,10,0.85)', '#9fb4c8');
  }

  update(dt: number, time: number): void {
    this.stars.update(dt);
    this.planet.update(dt);
    this.beaconMat.opacity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(time * 4));
  }

  dispose(): void {
    disposeMeshes(this.meshes);
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    for (const s of this.screens) s.dispose();
    this.terminal.screen.dispose();
    for (const rd of this.rooms) rd.furnitureGroup.removeFromParent();
    this.stars.dispose();
    this.planet.dispose();
    this.beacon.geometry.dispose(); this.beaconMat.dispose();
    this.root.removeFromParent();
  }
}
