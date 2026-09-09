import type * as THREE from 'three';
import type { HubShipKind } from '@/shared';
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
  /** `방 n` + purpose sign beside the door (corridor side); the hub rewrites its second line. */
  sign: TextPlane;
  /** Parent for the room's furniture meshes (one group per room, added / cleared by the furniture layer). */
  furnitureGroup: THREE.Group;
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
   * Built-in weapon-repair bench (`hub_workbench`). **Shared ship only since Phase 8** — the personal ship's
   * repair menu opens from a placed `furn_repair_bench` in the 작업실 instead, so this is optional.
   */
  readonly workbench?: WorkbenchDef;
  /** 함선 컴퓨터 (Phase 5): interaction anchor in front of the desk (`hub_computer` → 기업 네트워크). */
  readonly computer: StationDef;
  /** 함선 시설 (tactical kit): 정비대 (shared ship) / 임플란트 시술대 anchors. */
  readonly stations: ShipStations;
  /** 함선 꾸미기 (personal ship only): the ten rooms. The door / facility consoles were removed in the Phase 8 UI pass. */
  readonly rooms?: readonly RoomDef[];
  /**
   * 목표 행성 (Phase 11): re-tint the decorative planet outside the viewports to the selected planet's
   * `PlanetDef.hologram` / `hologramAtmo`. Called on build and when a warp ends — the interior itself is
   * never rebuilt for a planet change, only the view outside it.
   */
  setPlanetLook?(color: number, atmo: number): void;
  /**
   * 목표 행성이 없으면 창밖에 행성도 없다 (2026-09-09): show / hide the decorative window planet. The hub calls it
   * from `applyPlanetLook` with `HubRef.planet !== null` — a fresh character, a lobby whose host has not picked yet,
   * or a cleared destination leaves the viewport as stars only. Independent of the warp fade (`setWarp`), which
   * only drives opacity; the interior's `Planet` ANDs the two. Optional like `setPlanetLook`.
   */
  setPlanetVisible?(on: boolean): void;
  /**
   * 창문 워프 (2026-09-09): drive the view outside the windows with the warp `speed` (0 = at rest, 1 = full warp;
   * `hub:warpProgress.speed`). The hub calls it **every frame of a trip** and once more with 0 on arrival /
   * cancellation. Expected look: the point stars fade out as the streaks fade in and stretch toward
   * `HUB_TRAVEL_WARP_STRETCH`, the window planet fades out on the way up and — re-tinted to `dest` — fades back in
   * on the way down. Optional: an interior without windows may omit it (the hub guards the call).
   */
  setWarp?(speed: number, dest?: WarpDestination): void;
  /**
   * 자동문 · 방 조명 (2026-09-08): per-frame animation that follows the player. Optional — an interior without
   * sliding doors simply omits it. `PersonalShip` moves its room-light pool here too.
   */
  updateNear?(dt: number, px: number, pz: number): void;
  /**
   * 공용 함선 격납고 (2026-09-08, shared ship only): the four 개인 함선 bays behind the aft 자동문, in slot order.
   * Empty / absent everywhere else.
   */
  readonly bays?: readonly HangarBayDef[];
  /** Park the squad's ships in the bays: `names[i]` = crew name in bay `i`, null = empty. Shared ship only. */
  setBayOccupants?(names: readonly (string | null)[]): void;
  update(dt: number, time: number): void;
  dispose(): void;
}
