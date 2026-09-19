import * as THREE from 'three';
import { HUB_POINT_LIGHTS, HUB_TRAVEL_WARP_STRETCH, NET_MAX_PLAYERS, NET_SLOT_COLORS, type HubAndroidBay, type HubShipKind } from '@/shared';
import { GeoBatch, HUB_MATS as M, disposeMeshes, yawFromForward } from './GeoBatch';
import { BoxInteriorCollider } from './InteriorCollider';
import { Hangar, type HangarBayDef } from './Hangar';
import { Parts } from './parts';
import { LightPool, type LightFixture } from './LightPool';
import { Starfield, Planet } from './Starfield';
import { ViewportWarp } from './WarpStreaks';
/* 2026-09-15: three android bays in the bridge corner (user's decision 「조종실 내부 한켠」) */
import { AndroidBayRack, type AndroidBayState } from './AndroidBays';
// 2026-09-14: `repairBench` is no longer called (the 정비 벤치 was removed, props and all) — the function stays in stations.ts
import { diningTable, diningTablePlateSlots, implantBay, shipComputer, type ShipStations, type StationDef } from './stations';
import { TextPlane } from '../Labels';
import type { PodSlotDef, ShipInterior, TerminalDef, WarpDestination } from './types';

const ROOM = { minX: -13, maxX: 13, minZ: -7, maxZ: 7 };
const CEIL = 4.2;
const WALL = 0.35;
/** Pod centres along the −Z wall. */
const POD_X = [-6, -2, 2, 6];
const POD_Z = ROOM.minZ + 1.15;
/** Hangar doorway (2026-09-08): half-width of the aft opening in the +Z wall, and its height (the sliding leaves are gone, 2026-09-16). */
const HANGAR_DOOR_HALF = 2.0;
const HANGAR_DOOR_HEIGHT = 3.2;

/**
 * Shared ship: 26×14 m main deck. Bridge + terminal and a wide viewport at −X, four launch pods in a row on the −Z
 * wall (slot-coloured rings by LaunchPod), armoury / lockers / crates along +Z, central holo table, airlock at +X
 * where docking arrivals spawn. Six light fixtures on the deck + nine in the hangar, served by `HUB_POINT_LIGHTS`
 * pool lights nearest the player (2026-09-10, `LightPool` — the deck and the hangar used to hang 15 lights of their own).
 *
 * **Hangar (2026-09-08)**: the middle of the +Z (aft) wall is a 4 m open doorway (a sliding door until 2026-09-16)
 * onto the `Hangar` deck — 44 × 30 m, four marked bays with the squad's personal ships parked in them. The hangar is
 * part of *this* interior (same `GeoBatch`, same collider, one walkable union), so the doorway is an open shared edge
 * and remote avatars simply walk through it. The armoury moved aside for the doorway: the weapon racks keep the port
 * half, lockers and crates the starboard half (the 정비 벤치 that stood to port was pulled out on 2026-09-14 — see the
 * armoury section in `buildDeck`).
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
  readonly computer: StationDef;
  readonly stations: ShipStations;
  /** Hangar (2026-09-08): the aft deck and its four personal-ship bays. */
  readonly hangar: Hangar;
  /** Three android bays (2026-09-15) — the port corner of the bridge, `interiors/AndroidBays.ts`. */
  private androidRack!: AndroidBayRack;

  private meshes: THREE.Mesh[] = [];
  /** 2026-09-10: every point light of this ship (deck + hangar fixtures, nearest to the player first). */
  private lightPool!: LightPool;
  private stars: Starfield;
  private planet: Planet;
  /** The window warp (2026-09-09): streaks past the bridge viewport, driven by the hub through `setWarp`. */
  private warp: ViewportWarp;
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
      // Hangar doorway (+Z): a real opening — the hangar deck is part of the same walkable union, so this doorway is an
      // open shared edge exactly like a personal-ship room door (2026-09-16: no sliding leaves in it any more).
      s: { lo: -HANGAR_DOOR_HALF, hi: HANGAR_DOOR_HALF, y0: 0, y1: HANGAR_DOOR_HEIGHT },
    });
    P.glass(r, 10.4, 2.4, ROOM.minX - WALL / 2, 2.2, 0, Math.PI / 2, this.meshes);

    // structure (the aft rib at x 0 is skipped — it would stand inside the hangar doorway)
    for (const x of [-9, -4.5, 0, 4.5, 9]) {
      P.rib(x, ROOM.minZ + 0.18);
      if (Math.abs(x) > HANGAR_DOOR_HALF) P.rib(x, ROOM.maxZ - 0.18);
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
    // Ship computer (`기업 네트워크`): forward-port corner of the bridge, against the −Z wall, monitors facing +Z
    const cp = shipComputer(b, col, -11.0, ROOM.minZ + 0.35, Math.PI);
    const cScreen = new TextPlane(0.56, 0.34, 256, false);
    cScreen.mesh.position.copy(cp.screenPos);
    cScreen.mesh.rotation.copy(cp.screenRot);
    cScreen.set(['기업 네트워크', '접속 대기'], '#7cf07a', 'rgba(4,14,10,1)', '#9fd8b0');
    r.add(cScreen.mesh);
    this.screens.push(cScreen);
    this.computer = { position: cp.position, yaw: cp.yaw };

    /*
     * ── Android bays (2026-09-15, user's decision 「조종실 내부 한켠」) ──
     * The empty corner behind the helm console (x −12.8 … −12.0) and the pilot seats (z ±2.2), in front of the
     * armoury's weapon racks (z 6.3 … 6.9). The shell is merged into this `GeoBatch` and only the status strip and
     * the name tag are own meshes (why this spot was chosen is in `interiors/AndroidBays.ts`'s comments).
     */
    this.androidRack = new AndroidBayRack(b, col, r);

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

    /*
     * ── armoury (+Z wall) ──
     * 2026-09-08: the middle of this wall is the hangar doorway now (x −2 … 2), so the row moved outward — the weapon
     * racks to port, lockers and crates to starboard. Nothing stands within a metre of the opening. (The 정비 벤치 was
     * to port too until 2026-09-14 — the note below it.)
     */
    // weapon racks
    for (const x of [-9.5, -6.5]) {
      b.boxB(2.4, 2.2, 0.35, x, 0, ROOM.maxZ - 0.35, M.gunmetal);
      for (let k = 0; k < 5; k++) b.box(0.08, 1.1, 0.12, x - 0.9 + k * 0.45, 1.25, ROOM.maxZ - 0.6, M.hullDark);
      b.box(2.4, 0.05, 0.05, x, 2.15, ROOM.maxZ - 0.55, M.stripCyan);
      col.addBox(x, 0, ROOM.maxZ - 0.4, 2.4, 2.2, 0.6);
    }
    P.lockers(4.2, ROOM.maxZ - 0.27, 5, 0);
    /*
     * The 정비 벤치 — **removed outright on 2026-09-14** (user's decision). On 2026-09-12 only the interaction
     * (`hub_workbench`) was taken away and the table · vice · tool board · `정비` sign were left standing as an
     * 「armoury silhouette」; but a repair bench with nothing to press on it is a lie in itself, so the props, the
     * colliders and the sign all went. The armoury's aft wall keeps only the weapon racks (−Z side) and the lockers ·
     * supply crates (+Z side). `Parts.workbench` · `stations.repairBench` stay in their files so their coordinates
     * are not lost (nothing calls them).
     */
    P.crates(7.8, ROOM.maxZ - 0.55, 4, 0);
    P.crates(10.8, ROOM.maxZ - 0.55, 2, 0);
    P.crates(ROOM.maxX - 0.6, -4.5, 3, Math.PI / 2);

    // ── ship facilities (tactical kit) — merged into the same GeoBatch, no extra draw calls ──
    // implant bay: +X wall, +Z half. (Phase 8: the hydroponics rack is gone; since the 2026-09-12 greenhouse rework growing
    //  is a placed 재배 스테이션 in a personal ship's greenhouse room — no ship has a built-in one.
    //  2026-09-14: there is no `bench` either — the 정비 벤치 was pulled out down to its props, see the armoury section above.)
    this.stations = {
      implantBay: implantBay(b, col, ROOM.maxX - 1.0, 3.6, yawFromForward(-1, 0)),
      /*
       * The fixed dining table (kitchen A-3c, 2026-09-11): the shared ship has no furniture, so the interior itself
       * plants the seat where the squad eats together (`ctx.housing.openDiningTable(null)`). It stands on the
       * starboard (+X) mid-deck — clear of every collider of the lockers · supply crates (+Z), the implant bay ·
       * airlock (+X), the launch pods (−Z) and the holo table (centre), and out of the z ≈ 0 walk-in line from the
       * airlock onto the deck. (Port x ≈ −8 is left empty because that is the line `smoke-hangar` walks to check
       * 「the aft wall still stops a walk beside the doorway」.)
       */
      diningTable: diningTable(b, col, 8.6, 2.2, 0),
      diningPlates: diningTablePlateSlots(8.6, 2.2, 0),   // 2026-09-16 plate model: the four place settings a squadmate's plate sits on
    };
    const dtSign = new TextPlane(0.9, 0.3, 256);
    dtSign.mesh.position.set(8.6, 1.62, 2.2);
    dtSign.mesh.rotation.y = Math.PI;                                        // PlaneGeometry faces +Z; the table's front is −Z
    dtSign.set(['식당'], '#ffc8a0', 'rgba(6,8,10,0.85)');
    r.add(dtSign.mesh);
    this.screens.push(dtSign);

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

    /*
     * ── Hangar (2026-09-08) ──
     * Built into the **same** `GeoBatch` and collider, so the whole aft deck costs no extra draw calls and its floor
     * joins the ship's walkable union at the +Z wall's outer face. `Hangar` owns its own lights, bay signs and the
     * parked ship models; only the doorway trim belongs here.
     */
    this.hangar = new Hangar(b, col, { wallZ: ROOM.maxZ + WALL, deckZ: ROOM.maxZ, halfWidth: ROOM.maxX + WALL, ceil: CEIL }, HANGAR_DOOR_HALF);
    r.add(this.hangar.root);
    /*
     * Doorway trim + a threshold strip, so the opening reads as a door and not a hole.
     * 2026-09-16 (sliding doors removed — user's decision 「문틀 주변에 흉한 것이 남지 않게」): with the leaves gone the reveal is in plain
     * view, and the trim shared its planes — post inner faces on the reveals (x = ±`HANGAR_DOOR_HALF`), the header's
     * underside on the soffit (y `HANGAR_DOOR_HEIGHT`) → z-fighting. Posts / header now stand 2 cm proud of them. Their
     * deck side reaches in front of the wainscot band and its trim line (`jambFront`, the band's trim is 5.5 cm off the
     * wall); their hangar side stops 2 cm past the wall (`jambBack`) — just short of the hangar's cyan reveal strip
     * (z `wallZ + 0.03`), which it used to meet. The threshold strip ends at the posts instead of running into them.
     */
    const jambFront = ROOM.maxZ - 0.065, jambBack = ROOM.maxZ + WALL + 0.02;
    const jambD = jambBack - jambFront, jambZ = (jambFront + jambBack) / 2;
    for (const sx of [-1, 1]) b.box(0.14, HANGAR_DOOR_HEIGHT, jambD, sx * (HANGAR_DOOR_HALF + 0.05), HANGAR_DOOR_HEIGHT / 2, jambZ, M.trim);
    b.box(HANGAR_DOOR_HALF * 2 + 0.24, 0.12, jambD, 0, HANGAR_DOOR_HEIGHT + 0.04, jambZ, M.trim);
    b.box(HANGAR_DOOR_HALF * 2 - 0.04, 0.03, 0.5, 0, 0.014, ROOM.maxZ + WALL / 2, M.stripAmber);
    const hangarSign = new TextPlane(1.6, 0.44, 320);
    hangarSign.mesh.position.set(0, HANGAR_DOOR_HEIGHT + 0.42, ROOM.maxZ - 0.02);
    hangarSign.mesh.rotation.y = Math.PI;                                    // reads from inside the ship
    hangarSign.set(['격납고'], '#ffc98a', 'rgba(6,8,10,0.85)');
    r.add(hangarSign.mesh);
    this.screens.push(hangarSign);

    b.build(r, this.meshes);

    // holo projection disc
    this.holoMat = new THREE.MeshBasicMaterial({ color: 0x3ac8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.holo = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.9, 1.4, 20, 1, true), this.holoMat);
    this.holo.position.set(0, 1.62, 1.5);
    r.add(this.holo);

    // Light places (2026-09-10): the deck's six fixtures + the hangar's nine; `HUB_POINT_LIGHTS` pool lights serve the nearest
    const fx = (x: number, y: number, z: number, color: number, intensity: number, distance: number): LightFixture => ({ x, y, z, color, intensity, distance });
    const deck: LightFixture[] = [
      fx(-8, CEIL - 0.3, 0.5, 0xeef2ff, 30, 13),
      fx(0, CEIL - 0.3, 0.8, 0xeef2ff, 30, 13),
      fx(8, CEIL - 0.3, 0.5, 0xeef2ff, 30, 13),
      fx(ROOM.minX + 1.8, 2.9, 0, 0x5fd7ff, 14, 8),
      fx(0, 3.4, ROOM.minZ + 2.4, 0xffb347, 18, 10),
      fx(4, 3.0, ROOM.maxZ - 1.6, 0xffd7a8, 12, 8),
    ];
    // zones: the deck (0) and the hangar behind the aft wall (1) — see `updateNear`
    for (const f of deck) f.zone = 0;
    for (const f of this.hangar.lightFixtures) f.zone = 1;
    this.lightPool = new LightPool(r, HUB_POINT_LIGHTS, [...deck, ...this.hangar.lightFixtures]);

    // space outside (−X viewport)
    this.stars = new Starfield(420, 2200, 23);
    r.add(this.stars.points);
    this.planet = new Planet(150, 0x8a6a4a, 0xffb98a);
    this.planet.group.position.set(-430, -70, 60);
    r.add(this.planet.group);
    // The window warp: the bridge (and its viewport) is −X, so that is the nose. The hangar reaches z ≈ +37 behind the
    // deck, so the streak shell starts at 48 m off the X axis — no streak ever crosses a walkable room.
    this.warp = new ViewportWarp(r, this.stars, this.planet, HUB_TRAVEL_WARP_STRETCH, { forward: new THREE.Vector3(-1, 0, 0), rMin: 48, rMax: 300, span: 1000, seed: 37 });
  }

  /** 목표 행성 (Phase 11): the planet outside the −X viewport takes the squad's selected planet colours. */
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

  /** Hangar bays, in slot order (the hub hangs the boarding interactables off these). */
  get bays(): readonly HangarBayDef[] { return this.hangar.bays; }

  /** Park the squad's ships: `names[i]` = crew name in bay `i`, null = empty bay. */
  setBayOccupants(names: readonly (string | null)[]): void { this.hangar.setOccupants(names); }

  /** The android bays (2026-09-15), in bay order. A reused array — the coordinates never change once built. */
  get androidBays(): readonly HubAndroidBay[] { return this.androidRack.bays; }

  /** Bay status strip · name tag: an android is dormant inside / is out with the squad / is waiting on a request. */
  setAndroidBayState(bay: number, state: AndroidBayState): void { this.androidRack.setState(bay, state); }

  /** The light pool follows the player (called by the hub, same contract as `PersonalShip.updateNear`). */
  updateNear(dt: number, px: number, pz: number): void {
    // past the aft wall = the hangar: its nine gantry lamps outrank the deck lamps behind the bulkhead, and vice versa
    this.lightPool.update(dt, px, pz, pz > ROOM.maxZ ? 1 : 0);
  }

  /** The ship's light pool (debug / smoke). */
  get lights(): LightPool { return this.lightPool; }

  update(dt: number, time: number): void {
    this.stars.update(dt);
    this.planet.update(dt);
    this.warp.update(dt);
    this.holo.rotation.y += dt * 0.6;
    this.holoMat.opacity = 0.28 + 0.1 * Math.sin(time * 2.3);
    this.hangar.update(dt, time);
    this.androidRack.update(dt, time);
  }

  dispose(): void {
    this.androidRack.dispose();
    this.hangar.dispose();
    disposeMeshes(this.meshes);
    this.lightPool.dispose();
    for (const s of this.screens) s.dispose();
    this.terminal.screen.dispose();
    this.warp.dispose();
    this.stars.dispose();
    this.planet.dispose();
    this.holo.geometry.dispose(); this.holoMat.dispose();
    this.root.removeFromParent();
  }
}
