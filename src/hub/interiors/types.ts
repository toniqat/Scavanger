import type * as THREE from 'three';
import type { HubShipKind } from '@/shared';
import type { BoxInteriorCollider } from './InteriorCollider';
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
  update(dt: number, time: number): void;
  dispose(): void;
}
