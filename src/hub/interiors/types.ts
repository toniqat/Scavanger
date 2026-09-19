import type * as THREE from 'three';
import type { HubAndroidBay, HubShipKind } from '@/shared';
import type { AndroidBayState } from './AndroidBays';
import type { BoxInteriorCollider } from './InteriorCollider';
import type { ShipStations, StationDef } from './stations';
import type { HangarBayDef } from './Hangar';
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

/*
 * 2026-09-12 (user's decision — the repair bench was dropped): `WorkbenchDef` stood here. The ship's **built-in
 * repair bench** (`hub_workbench`, the shared ship's armoury) lost its interaction — repair now happens in the
 * inventory, from materials. The bench prop and its `정비` sign stay as armoury dressing, and `SharedShip` no longer
 * publishes those coordinates. Undoing it means reviving this interface and `ShipInterior.workbench?`, and writing
 * `hub/Workbench.ts` again.
 */

export interface TerminalDef {
  /** Interaction anchor (deck level, in front of the console). */
  position: THREE.Vector3;
  yaw: number;
  /** Console screen the hub writes status lines to. */
  screen: TextPlane;
}

/**
 * 2026-09-12: one space furniture can be placed in — a room **or the cockpit** (`index === COCKPIT_ROOM_INDEX`).
 * This is everything the furniture layer (`interiors/Furniture.FurnitureLayer`) needs to know.
 */
export interface EditAreaDef {
  index: number;
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** Parent for the area's furniture meshes (one group per area, added / cleared by the furniture layer). */
  furnitureGroup: THREE.Group;
}

/** One of the personal ship's housing rooms (`SHIP_ROOM_COUNT`, see `RoomLayout.ts` for the numbers). */
export interface RoomDef extends EditAreaDef {
  /** −1 = port (−X) side, +1 = starboard (+X). */
  side: -1 | 1;
  /** `방 n` + purpose sign beside the door (corridor side); the hub rewrites its second line. */
  sign: TextPlane;
}

/** Colours the window planet takes once the warp lands (`PlanetDef.hologram` / `hologramAtmo`). */
export interface WarpDestination { color: number; atmo: number }

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
  /**
   * The ship computer (Phase 5): interaction anchor in front of the desk (`hub_computer` → the corporate network).
   * 2026-09-12: **optional** — the personal ship's computer is the `furn_corp_computer` furniture now; only the
   * shared ship still has a built-in desk.
   */
  readonly computer?: StationDef;
  /** Ship stations (tactical kit): repair bench (shared ship) / implant bay anchors. */
  readonly stations: ShipStations;
  /** Decorating the ship (personal ship only): the rooms. The door / facility consoles were removed in the Phase 8 UI pass. */
  readonly rooms?: readonly RoomDef[];
  /** 2026-09-12 (personal ship only): the cockpit as a furniture area (`COCKPIT_ROOM_INDEX`). */
  readonly cockpit?: EditAreaDef;
  /**
   * 2026-09-12 (user's decision): the floor grid of a room · the cockpit shows **only during ship management
   * (housing mode)**. hub/HousingMode turns it on entering the mode and off leaving it. Optional — an interior with
   * no grid (the shared ship) omits it.
   */
  setGridVisible?(on: boolean): void;
  /**
   * 2026-09-13 (user's decision, personal ship only): fade the cockpit ceiling (the plate · its three beams · the
   * recessed light strips) away while ship management is open and bring it back when it closes. hub/HousingMode
   * passes the wanted state every frame and the interior's `update` drives the opacity — no material is created and
   * `transparent` is never toggled, so no shader recompiles and no light is touched.
   */
  setCockpitCeilingHidden?(hidden: boolean): void;
  /**
   * Target planet (Phase 11): re-tint the decorative planet outside the viewports to the selected planet's
   * `PlanetDef.hologram` / `hologramAtmo`. Called on build and when a warp ends — the interior itself is
   * never rebuilt for a planet change, only the view outside it.
   */
  setPlanetLook?(color: number, atmo: number): void;
  /**
   * No target planet, no planet outside the window (2026-09-09): show / hide the decorative window planet. The hub calls it
   * from `applyPlanetLook` with `HubRef.planet !== null` — a fresh character, a lobby whose host has not picked yet,
   * or a cleared destination leaves the viewport as stars only. Independent of the warp fade (`setWarp`), which
   * only drives opacity; the interior's `Planet` ANDs the two. Optional like `setPlanetLook`.
   */
  setPlanetVisible?(on: boolean): void;
  /**
   * The window warp (2026-09-09): drive the view outside the windows with the warp `speed` (0 = at rest, 1 = full warp;
   * `hub:warpProgress.speed`). The hub calls it **every frame of a trip** and once more with 0 on arrival /
   * cancellation. Expected look: the point stars fade out as the streaks fade in and stretch toward
   * `HUB_TRAVEL_WARP_STRETCH`, the window planet fades out on the way up and — re-tinted to `dest` — fades back in
   * on the way down. Optional: an interior without windows may omit it (the hub guards the call).
   */
  setWarp?(speed: number, dest?: WarpDestination): void;
  /**
   * Room lights (2026-09-08): per-frame animation that follows the player — both ships move their light pool here
   * (the sliding doors it also drove were removed 2026-09-16). Optional.
   */
  updateNear?(dt: number, px: number, pz: number): void;
  /**
   * The shared ship's hangar (2026-09-08, shared ship only): the four personal-ship bays behind the aft door, in slot order.
   * Empty / absent everywhere else.
   */
  readonly bays?: readonly HangarBayDef[];
  /** Park the squad's ships in the bays: `names[i]` = crew name in bay `i`, null = empty. Shared ship only. */
  setBayOccupants?(names: readonly (string | null)[]): void;
  /**
   * The android bays (2026-09-15, shared ship only): the cockpit's `ANDROID_BAY_COUNT` capsules in bay order. Absent /
   * empty everywhere else. A reused array — read it and use it, never keep it.
   */
  readonly androidBays?: readonly HubAndroidBay[];
  /** Status strip + name tag of one android bay (dormant inside / out with the squad / waiting for the relay). */
  setAndroidBayState?(bay: number, state: AndroidBayState): void;
  update(dt: number, time: number): void;
  dispose(): void;
}
