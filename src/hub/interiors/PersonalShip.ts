import * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { Parts, fixture } from './parts';
import { Starfield, Planet } from './Starfield';
import { TextPlane } from '../Labels';
import type { PodSlotDef, ShipInterior, TerminalDef, WorkbenchDef } from './types';

const ROOM = { minX: -5, maxX: 5, minZ: -3, maxZ: 3 };
const CEIL = 3.2;
const WALL = 0.3;

/**
 * Personal ship: one ~10×6 m cabin. Cockpit viewport (−Z) with a starfield + planet outside, ship terminal on
 * the −X wall, a single launch pod at the +X wall, bunk / lockers / crates, six constant point lights.
 */
export class PersonalShip implements ShipInterior {
  readonly kind: HubShipKind = 'personal';
  readonly root = new THREE.Group();
  readonly collider = new BoxInteriorCollider();
  readonly spawn = new THREE.Vector3(0, 0, 1.2);
  readonly spawnYaw = 0;                       // facing −Z (the cockpit)
  readonly airlock = new THREE.Vector3(0, 0, 1.2);
  readonly airlockYaw = 0;
  readonly pods: PodSlotDef[] = [];
  readonly terminal: TerminalDef;
  readonly workbench: WorkbenchDef;

  private meshes: THREE.Mesh[] = [];
  private lights: THREE.PointLight[] = [];
  private stars: Starfield;
  private planet: Planet;
  private dashScreens: TextPlane[] = [];
  private beacon: THREE.Mesh;
  private beaconMat: THREE.MeshBasicMaterial;

  constructor() {
    const r = this.root;
    r.name = 'PersonalShip';
    const col = this.collider;
    col.addRoom(ROOM.minX, ROOM.maxX, ROOM.minZ, ROOM.maxZ, 0, CEIL);

    const b = new GeoBatch();
    const P = new Parts(b, col, CEIL);
    P.deck(ROOM, false);
    P.walls(ROOM, WALL, {
      n: { lo: -3.2, hi: 3.2, y0: 1.0, y1: 2.7 },          // cockpit viewport
    });
    P.glass(r, 6.4, 1.7, 0, 1.85, ROOM.minZ - WALL / 2, 0, this.meshes);

    // ribs + beams
    for (const x of [-3.3, 0, 3.3]) { P.rib(x, ROOM.minZ + 0.16); P.rib(x, ROOM.maxZ - 0.16); P.beam(ROOM.maxZ - ROOM.minZ, x, 0, Math.PI / 2); }
    P.rib(ROOM.minX + 0.16, -1.5); P.rib(ROOM.minX + 0.16, 1.5);

    // cockpit dashboard under the viewport
    b.boxB(6.6, 0.85, 0.7, 0, 0, ROOM.minZ + 0.35, M.hullDark);
    b.box(6.7, 0.06, 0.75, 0, 0.88, ROOM.minZ + 0.35, M.trimDark);
    b.box(6.2, 0.04, 0.5, 0, 0.9, ROOM.minZ + 0.45, M.gunmetal);
    col.addBox(0, 0, ROOM.minZ + 0.35, 6.6, 1.2, 0.7);
    // pilot seats
    for (const x of [-0.9, 0.9]) {
      b.boxB(0.7, 0.45, 0.7, x, 0, ROOM.minZ + 1.35, M.hullDark);
      b.boxB(0.7, 0.9, 0.16, x, 0.45, ROOM.minZ + 1.65, M.padding);
      b.box(0.62, 0.12, 0.6, x, 0.5, ROOM.minZ + 1.35, M.padding);
      col.addBox(x, 0, ROOM.minZ + 1.45, 0.7, 1.3, 0.75);
    }
    // dash readouts (text planes)
    for (let i = 0; i < 3; i++) {
      const tp = new TextPlane(1.5, 0.42, 384);
      tp.mesh.position.set(-2 + i * 2, 1.12, ROOM.minZ + 0.42);
      tp.mesh.rotation.x = -0.6;
      tp.set(i === 0 ? ['항법', '궤도 유지'] : i === 1 ? ['동력', '98 %'] : ['통신', '대기'], i === 1 ? '#7cf07a' : '#5fd7ff', 'rgba(6,14,20,0.9)');
      r.add(tp.mesh);
      this.dashScreens.push(tp);
    }

    // terminal (−X wall), facing +X
    const termYaw = yawFromForward(1, 0);
    const tx = ROOM.minX + 0.75, tz = -0.8;
    const c = P.consolePedestal(tx, tz, termYaw);
    const screen = new TextPlane(0.92, 0.6, 512, false);
    screen.mesh.position.copy(c.screenPos);
    screen.mesh.rotation.copy(c.screenRot);
    r.add(screen.mesh);
    this.terminal = { position: new THREE.Vector3(tx + 0.9, 0, tz), yaw: termYaw, screen };
    P.signStrip(ROOM.minX + WALL / 2 + 0.03, 2.3, tz, 1.2, M.stripCyan, Math.PI / 2);

    // launch pod socket (+X wall), door faces −X. Pod body is built by LaunchPod; here: floor plate, rear frame, door blocker.
    // The pod cell (1.5 × 1.1 m inside) stays walkable so a boarded player (r 0.45) is never pushed out.
    const px = ROOM.maxX - 1.0, pz = 0.6;
    b.box(2.0, 0.06, 2.0, px, 0.03, pz, M.hullDark);
    b.boxB(0.5, CEIL, 1.9, ROOM.maxX - 0.25, 0, pz, M.hullLight);        // rear housing
    b.box(0.3, 0.3, 2.2, px, CEIL - 0.15, pz, M.hullLight);
    col.addBlocker(px + 0.75, 0, pz - 0.95, ROOM.maxX, 3, pz + 0.95);    // rear
    col.addBlocker(px - 0.85, 0, pz - 0.95, px + 0.75, 3, pz - 0.55);    // side lips
    col.addBlocker(px - 0.85, 0, pz + 0.55, px + 0.75, 3, pz + 0.95);
    const doorBlocker = col.addBlocker(px - 0.95, 0, pz - 0.55, px - 0.75, 3, pz + 0.55);
    col.setBlockerEnabled(doorBlocker, false);
    this.pods.push({ slot: 0, position: new THREE.Vector3(px, 0, pz), yaw: yawFromForward(-1, 0), door: new THREE.Vector3(-1, 0, 0), doorBlocker });
    P.signStrip(ROOM.maxX - WALL / 2 - 0.03, 2.6, pz, 1.6, M.stripAmber, Math.PI / 2);

    // workbench (+X wall, −Z half), facing −X — between the cockpit dash and the pod's side lip
    const wb = P.workbench(ROOM.maxX - 0.55, -1.85, yawFromForward(-1, 0));
    this.workbench = { position: wb.position, yaw: wb.yaw };
    const wbSign = new TextPlane(0.9, 0.3, 256);
    wbSign.mesh.position.copy(wb.signPos);
    wbSign.mesh.rotation.copy(wb.signRot);
    wbSign.set(['정비'], '#9be8ff', 'rgba(6,8,10,0.85)');
    r.add(wbSign.mesh);
    this.dashScreens.push(wbSign);

    // bunk (−X wall, +Z half)
    b.boxB(1.0, 0.5, 2.1, ROOM.minX + 0.55, 0, 1.75, M.hullDark);
    b.box(0.94, 0.14, 2.0, ROOM.minX + 0.55, 0.57, 1.75, M.fabric);
    b.box(0.5, 0.1, 0.4, ROOM.minX + 0.55, 0.7, 0.9, M.padding);
    col.addBox(ROOM.minX + 0.55, 0, 1.75, 1.0, 0.7, 2.1);
    // lockers (+Z wall, left) + crates (+Z wall, right)
    P.lockers(-1.6, ROOM.maxZ - 0.27, 3, 0);
    P.crates(2.2, ROOM.maxZ - 0.5, 3, 0);
    // airlock door (+Z wall centre) — decorative
    b.box(1.6, 2.6, 0.08, 0.6, 1.3, ROOM.maxZ - 0.05, M.hullDark);
    b.box(0.04, 2.4, 0.1, 0.6, 1.3, ROOM.maxZ - 0.08, M.trim);
    b.box(1.7, 0.1, 0.12, 0.6, 2.65, ROOM.maxZ - 0.06, M.stripRed);

    b.build(r, this.meshes);

    // rotating beacon over the airlock
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff5a3a, transparent: true, opacity: 0.8 });
    this.beacon = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), this.beaconMat);
    this.beacon.position.set(0.6, 2.85, ROOM.maxZ - 0.2);
    r.add(this.beacon);

    // constant lights (6)
    fixture(r, -2.4, CEIL - 0.25, 0.4, 0xeef2ff, 18, 9, this.lights);
    fixture(r, 2.4, CEIL - 0.25, 0.4, 0xeef2ff, 18, 9, this.lights);
    fixture(r, 0, 2.3, ROOM.minZ + 0.9, 0x5fd7ff, 10, 7, this.lights);
    fixture(r, px - 1.2, 2.4, pz, 0xffb347, 12, 6, this.lights);
    fixture(r, ROOM.minX + 1.3, 2.0, tz, 0x7fd8ff, 7, 5, this.lights);
    fixture(r, ROOM.minX + 1.2, 1.6, 1.8, 0xffd7a8, 5, 4, this.lights);

    // space outside
    this.stars = new Starfield(320, 1800, 11);
    r.add(this.stars.points);
    this.planet = new Planet(110, 0x6c8a5a, 0x8fd0ff);
    this.planet.group.position.set(-70, -50, -360);
    r.add(this.planet.group);
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
    for (const s of this.dashScreens) s.dispose();
    this.terminal.screen.dispose();
    this.stars.dispose();
    this.planet.dispose();
    this.beacon.geometry.dispose(); this.beaconMat.dispose();
    this.root.removeFromParent();
  }
}
