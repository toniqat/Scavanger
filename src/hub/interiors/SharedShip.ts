import * as THREE from 'three';
import { NET_MAX_PLAYERS, NET_SLOT_COLORS, type HubShipKind } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { Parts, fixture } from './parts';
import { Starfield, Planet } from './Starfield';
import { hydroponics, implantBay, repairBench, shipComputer, type ShipStations, type StationDef } from './stations';
import { TextPlane } from '../Labels';
import type { PodSlotDef, ShipInterior, TerminalDef, WorkbenchDef } from './types';

const ROOM = { minX: -13, maxX: 13, minZ: -7, maxZ: 7 };
const CEIL = 4.2;
const WALL = 0.35;
/** Pod centres along the −Z wall. */
const POD_X = [-6, -2, 2, 6];
const POD_Z = ROOM.minZ + 1.15;

/**
 * Shared ship: 26×14 m hangar deck. Bridge + terminal and a wide viewport at −X, four launch pods in a row on the
 * −Z wall (slot-coloured rings by LaunchPod), armoury / lockers / crates along +Z, central holo table, airlock at +X
 * where docking arrivals spawn. Six constant point lights.
 */
export class SharedShip implements ShipInterior {
  readonly kind: HubShipKind = 'shared';
  readonly root = new THREE.Group();
  readonly collider = new BoxInteriorCollider();
  readonly spawn = new THREE.Vector3(3, 0, 0.5);
  readonly spawnYaw = 0;                                   // facing the pods (−Z)
  readonly airlock = new THREE.Vector3(11, 0, 0);
  readonly airlockYaw = yawFromForward(-1, 0);             // walking in toward −X
  readonly pods: PodSlotDef[] = [];
  readonly terminal: TerminalDef;
  readonly workbench: WorkbenchDef;
  readonly computer: StationDef;
  readonly stations: ShipStations;

  private meshes: THREE.Mesh[] = [];
  private lights: THREE.PointLight[] = [];
  private stars: Starfield;
  private planet: Planet;
  private screens: TextPlane[] = [];
  private holoMat: THREE.MeshBasicMaterial;
  private holo: THREE.Mesh;
  private slotSigns: THREE.Mesh[] = [];

  constructor() {
    const r = this.root;
    r.name = 'SharedShip';
    const col = this.collider;
    col.addRoom(ROOM.minX, ROOM.maxX, ROOM.minZ, ROOM.maxZ, 0, CEIL);

    const b = new GeoBatch();
    const P = new Parts(b, col, CEIL);
    P.deck(ROOM, true);
    P.walls(ROOM, WALL, {
      w: { lo: -5.2, hi: 5.2, y0: 1.0, y1: 3.4 },            // bridge viewport (−X)
      e: { lo: -1.3, hi: 1.3, y0: 0, y1: 3.0 },              // airlock opening (+X) — closed by the door below
    });
    P.glass(r, 10.4, 2.4, ROOM.minX - WALL / 2, 2.2, 0, Math.PI / 2, this.meshes);

    // structure
    for (const x of [-9, -4.5, 0, 4.5, 9]) {
      P.rib(x, ROOM.minZ + 0.18); P.rib(x, ROOM.maxZ - 0.18);
      P.beam(ROOM.maxZ - ROOM.minZ, x, 0, Math.PI / 2);
    }
    for (const z of [-4, 0, 4]) { P.rib(ROOM.minX + 0.18, z); P.rib(ROOM.maxX - 0.18, z); }
    P.beam(ROOM.maxX - ROOM.minX, 0, -2.6); P.beam(ROOM.maxX - ROOM.minX, 0, 2.6);

    // ── bridge (−X) ──
    b.boxB(0.8, 0.9, 10.8, ROOM.minX + 0.6, 0, 0, M.hullDark);
    b.box(0.85, 0.06, 10.9, ROOM.minX + 0.6, 0.93, 0, M.trimDark);
    col.addBox(ROOM.minX + 0.6, 0, 0, 0.8, 1.2, 10.8);
    for (let i = 0; i < 4; i++) {
      const tp = new TextPlane(1.6, 0.44, 384);
      tp.mesh.position.set(ROOM.minX + 0.72, 1.15, -3.9 + i * 2.6);
      tp.mesh.rotation.set(-0.6, Math.PI / 2, 0, 'YXZ');
      tp.set(['항법', '궤도 유지', '', '동력', '96 %', '', '도킹', '개방', '', '함선 통신', '온라인'].slice(i * 3, i * 3 + 2), i % 2 ? '#7cf07a' : '#5fd7ff', 'rgba(6,14,20,0.9)');
      r.add(tp.mesh);
      this.screens.push(tp);
    }
    // bridge chairs
    for (const z of [-2.2, 2.2]) {
      b.boxB(0.7, 0.45, 0.7, ROOM.minX + 1.9, 0, z, M.hullDark);
      b.boxB(0.16, 0.9, 0.7, ROOM.minX + 2.2, 0.45, z, M.padding);
      col.addBox(ROOM.minX + 2.0, 0, z, 0.8, 1.3, 0.75);
    }
    // ship terminal (faces +X, in front of the bridge dash)
    const termYaw = yawFromForward(1, 0);
    const tx = ROOM.minX + 2.3, tz = 0;
    const c = P.consolePedestal(tx, tz, termYaw);
    const screen = new TextPlane(0.92, 0.6, 512, false);
    screen.mesh.position.copy(c.screenPos);
    screen.mesh.rotation.copy(c.screenRot);
    r.add(screen.mesh);
    this.terminal = { position: new THREE.Vector3(tx + 0.9, 0, tz), yaw: termYaw, screen };
    // 함선 컴퓨터 (기업 네트워크): forward-port corner of the bridge, against the −Z wall, monitors facing +Z
    const cp = shipComputer(b, col, -11.0, ROOM.minZ + 0.35, Math.PI);
    const cScreen = new TextPlane(0.56, 0.34, 256, false);
    cScreen.mesh.position.copy(cp.screenPos);
    cScreen.mesh.rotation.copy(cp.screenRot);
    cScreen.set(['기업 네트워크', '접속 대기'], '#7cf07a', 'rgba(4,14,10,1)', '#9fd8b0');
    r.add(cScreen.mesh);
    this.screens.push(cScreen);
    this.computer = { position: cp.position, yaw: cp.yaw };

    // ── launch bay (−Z wall): 4 pod sockets ──
    b.box(ROOM.maxX - ROOM.minX - 2, 0.06, 3.2, 0, 0.03, ROOM.minZ + 1.6, M.hullDark);   // bay plate
    b.box(ROOM.maxX - ROOM.minX - 2, 0.02, 0.08, 0, 0.07, ROOM.minZ + 3.2, M.stripAmber);
    for (let i = 0; i < NET_MAX_PLAYERS; i++) {
      const px = POD_X[i], pz = POD_Z;
      b.boxB(1.9, CEIL, 0.5, px, 0, ROOM.minZ + 0.25, M.hullLight);          // rear housing
      b.box(2.2, 0.3, 0.3, px, CEIL - 0.15, pz, M.hullLight);
      // pod cell stays walkable (see PersonalShip): rear wall, side lips, toggleable door slab
      col.addBlocker(px - 0.95, 0, ROOM.minZ, px + 0.95, 3, pz - 0.75);      // rear
      col.addBlocker(px - 0.95, 0, pz - 0.75, px - 0.55, 3, pz + 0.85);      // side lips
      col.addBlocker(px + 0.55, 0, pz - 0.75, px + 0.95, 3, pz + 0.85);
      const doorBlocker = col.addBlocker(px - 0.55, 0, pz + 0.75, px + 0.55, 3, pz + 0.95);
      col.setBlockerEnabled(doorBlocker, false);
      this.pods.push({ slot: i, position: new THREE.Vector3(px, 0, pz), yaw: yawFromForward(0, 1), door: new THREE.Vector3(0, 0, 1), doorBlocker });
      // slot number sign above the socket
      const sign = new TextPlane(1.2, 0.36, 256);
      sign.mesh.position.set(px, CEIL - 0.55, ROOM.minZ + 0.52);
      sign.set([`슬롯 ${i + 1}`], `#${NET_SLOT_COLORS[i].toString(16).padStart(6, '0')}`, 'rgba(6,8,10,0.85)');
      r.add(sign.mesh);
      this.screens.push(sign);
      this.slotSigns.push(sign.mesh);
      // separators between sockets
      if (i < NET_MAX_PLAYERS - 1) {
        const sx = (POD_X[i] + POD_X[i + 1]) / 2;
        b.boxB(0.25, 2.6, 1.6, sx, 0, ROOM.minZ + 0.9, M.hullDark);
        col.addBox(sx, 0, ROOM.minZ + 0.9, 0.25, 2.6, 1.6);
      }
    }

    // ── armoury (+Z wall) ──
    // weapon racks
    for (const x of [-9.5, -6.5]) {
      b.boxB(2.4, 2.2, 0.35, x, 0, ROOM.maxZ - 0.35, M.gunmetal);
      for (let k = 0; k < 5; k++) b.box(0.08, 1.1, 0.12, x - 0.9 + k * 0.45, 1.25, ROOM.maxZ - 0.6, M.hullDark);
      b.box(2.4, 0.05, 0.05, x, 2.15, ROOM.maxZ - 0.55, M.stripCyan);
      col.addBox(x, 0, ROOM.maxZ - 0.4, 2.4, 2.2, 0.6);
    }
    P.lockers(-2.5, ROOM.maxZ - 0.27, 5, 0);
    // workbench (weapon repair), facing −Z into the deck
    const wb = P.workbench(2.5, ROOM.maxZ - 0.62, 0);
    this.workbench = { position: wb.position, yaw: wb.yaw };
    const wbSign = new TextPlane(0.9, 0.3, 256);
    wbSign.mesh.position.copy(wb.signPos);
    wbSign.mesh.rotation.copy(wb.signRot);
    wbSign.set(['정비'], '#9be8ff', 'rgba(6,8,10,0.85)');
    r.add(wbSign.mesh);
    this.screens.push(wbSign);
    P.crates(6.5, ROOM.maxZ - 0.55, 4, 0);
    P.crates(10.0, ROOM.maxZ - 0.55, 2, 0);
    P.crates(ROOM.maxX - 0.6, -4.5, 3, Math.PI / 2);

    // ── 함선 시설 (tactical kit) — merged into the same GeoBatch, no extra draw calls ──
    // 수경 재배: +Z wall far left; 정비대: the existing workbench (board only); 임플란트 시술대: +X wall, +Z half.
    this.stations = {
      garden: hydroponics(b, col, -11.8, ROOM.maxZ - 0.4, 0),
      bench: repairBench(b, col, 2.5, ROOM.maxZ - 0.7, 0, false),
      implantBay: implantBay(b, col, ROOM.maxX - 1.0, 3.6, yawFromForward(-1, 0)),
    };

    // ── central holo table ──
    b.cyl(1.0, 1.15, 0.85, 16, 0, 0.425, 1.5, M.hullDark);
    b.cyl(1.05, 1.05, 0.06, 16, 0, 0.88, 1.5, M.trimDark);
    col.addBox(0, 0, 1.5, 2.2, 1.2, 2.2);

    // ── airlock (+X wall) ──
    b.box(0.1, 3.0, 2.6, ROOM.maxX + WALL / 2 - 0.02, 1.5, 0, M.hullDark);
    col.addBlocker(ROOM.maxX - 0.1, 0, -1.3, ROOM.maxX + WALL, 3, 1.3);
    b.box(0.14, 2.8, 0.05, ROOM.maxX + 0.02, 1.5, 0, M.trim);                     // door seam
    b.box(0.12, 0.1, 2.8, ROOM.maxX, 3.1, 0, M.stripRed);
    b.box(0.6, 0.04, 2.6, ROOM.maxX - 0.6, 0.015, 0, M.stripAmber);                // threshold strip
    P.signStrip(ROOM.maxX - WALL / 2 - 0.03, 3.6, 0, 3.0, M.stripAmber, Math.PI / 2);

    b.build(r, this.meshes);

    // holo projection disc
    this.holoMat = new THREE.MeshBasicMaterial({ color: 0x3ac8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.holo = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.9, 1.4, 20, 1, true), this.holoMat);
    this.holo.position.set(0, 1.62, 1.5);
    r.add(this.holo);

    // constant lights (6)
    fixture(r, -8, CEIL - 0.3, 0.5, 0xeef2ff, 30, 13, this.lights);
    fixture(r, 0, CEIL - 0.3, 0.8, 0xeef2ff, 30, 13, this.lights);
    fixture(r, 8, CEIL - 0.3, 0.5, 0xeef2ff, 30, 13, this.lights);
    fixture(r, ROOM.minX + 1.8, 2.9, 0, 0x5fd7ff, 14, 8, this.lights);
    fixture(r, 0, 3.4, ROOM.minZ + 2.4, 0xffb347, 18, 10, this.lights);
    fixture(r, 4, 3.0, ROOM.maxZ - 1.6, 0xffd7a8, 12, 8, this.lights);

    // space outside (−X viewport)
    this.stars = new Starfield(420, 2200, 23);
    r.add(this.stars.points);
    this.planet = new Planet(150, 0x8a6a4a, 0xffb98a);
    this.planet.group.position.set(-430, -70, 60);
    r.add(this.planet.group);
  }

  update(dt: number, time: number): void {
    this.stars.update(dt);
    this.planet.update(dt);
    this.holo.rotation.y += dt * 0.6;
    this.holoMat.opacity = 0.28 + 0.1 * Math.sin(time * 2.3);
  }

  dispose(): void {
    disposeMeshes(this.meshes);
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    for (const s of this.screens) s.dispose();
    this.terminal.screen.dispose();
    this.stars.dispose();
    this.planet.dispose();
    this.holo.geometry.dispose(); this.holoMat.dispose();
    this.root.removeFromParent();
  }
}
