import type * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import type { BoxInteriorCollider } from './InteriorCollider';
import type { ShipStations, StationDef } from './stations';
import type { TextPlane } from '../Labels';

/** Where a launch pod stands. `door` = unit XZ direction from the pod centre out through its door. */
export interface PodSlotDef {
  slot: number;
  position: THREE.Vector3;
  yaw: number;
  door: THREE.Vector3;
  /** Collider index of the door-opening blocker (enabled while the door is closed). */
  doorBlocker: number;
}

/** Ship workbench (weapon repair): interaction anchor in front of the bench. */
export interface WorkbenchDef {
  /** Interaction anchor (deck level, in front of the bench). */
  position: THREE.Vector3;
  /** Player yaw looking at the bench. */
  yaw: number;
}

export interface TerminalDef {
  /** Interaction anchor (deck level, in front of the console). */
  position: THREE.Vector3;
  yaw: number;
  /** Console screen the hub writes status lines to. */
  screen: TextPlane;
}

/** One of the personal ship's ten housing rooms (see `RoomLayout.ts` for the numbers). */
export interface RoomDef {
  index: number;
  /** −1 = port (−X) side, +1 = starboard (+X). */
  side: -1 | 1;
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** Corridor-side door console: interaction anchor (`hub_room_<i>`). */
  console: StationDef;
  /** `방 n` + purpose sign beside the door (corridor side); the hub rewrites its second line. */
  sign: TextPlane;
  /** Parent for the room's furniture meshes (one group per room, added / cleared by the furniture layer). */
  furnitureGroup: THREE.Group;
}

/** A built ship interior (personal or shared). Geometry is at world origin on every client. */
export interface ShipInterior {
  readonly kind: HubShipKind;
  readonly root: THREE.Group;
  readonly collider: BoxInteriorCollider;
  /** Default spawn (direct enter). */
  readonly spawn: THREE.Vector3;
  readonly spawnYaw: number;
  /** Docking arrivals appear here. */
  readonly airlock: THREE.Vector3;
  readonly airlockYaw: number;
  readonly pods: PodSlotDef[];
  readonly terminal: TerminalDef;
  readonly workbench: WorkbenchDef;
  /** 함선 컴퓨터 (Phase 5): interaction anchor in front of the desk (`hub_computer` → 기업 네트워크). */
  readonly computer: StationDef;
  /** 함선 시설 (tactical kit): 수경 재배 / 정비대 / 임플란트 시술대 anchors. */
  readonly stations: ShipStations;
  /** 함선 꾸미기 (personal ship only): the ten rooms and the cockpit facility console (`hub_facility`). */
  readonly rooms?: readonly RoomDef[];
  readonly facility?: StationDef;
  update(dt: number, time: number): void;
  dispose(): void;
}
