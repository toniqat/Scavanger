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

/*
 * 2026-09-12 (사용자 결정 — 정비 벤치 제거): `WorkbenchDef` 가 여기 있었다. 함선의 **붙박이 정비 벤치**
 * (`hub_workbench`, 공유 함선 병기고)는 상호작용을 잃었다 — 수리는 이제 인벤토리에서 재료로 한다.
 * 벤치 소품과 `정비` 표지는 병기고 장식으로 남아 있고 `SharedShip` 은 그 좌표를 더 이상 내보내지 않는다.
 * 되돌리려면 이 인터페이스와 `ShipInterior.workbench?` 를 되살리고 `hub/Workbench.ts` 를 다시 만든다.
 */

export interface TerminalDef {
  /** Interaction anchor (deck level, in front of the console). */
  position: THREE.Vector3;
  yaw: number;
  /** Console screen the hub writes status lines to. */
  screen: TextPlane;
}

/**
 * 2026-09-12: 가구를 놓을 수 있는 공간 하나 — 방 **또는 조종석**(`index === COCKPIT_ROOM_INDEX`). 가구 층
 * (`interiors/Furniture.FurnitureLayer`)은 이것만 알면 된다.
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
   * 함선 컴퓨터 (Phase 5): interaction anchor in front of the desk (`hub_computer` → 기업 네트워크).
   * 2026-09-12: **optional** — the personal ship's computer is the `furn_corp_computer` furniture now; only the
   * shared ship still has a built-in desk.
   */
  readonly computer?: StationDef;
  /** 함선 시설 (tactical kit): 정비대 (shared ship) / 임플란트 시술대 anchors. */
  readonly stations: ShipStations;
  /** 함선 꾸미기 (personal ship only): the rooms. The door / facility consoles were removed in the Phase 8 UI pass. */
  readonly rooms?: readonly RoomDef[];
  /** 2026-09-12 (personal ship only): the cockpit as a furniture area (`COCKPIT_ROOM_INDEX`). */
  readonly cockpit?: EditAreaDef;
  /**
   * 2026-09-12 (사용자 결정): 방 · 조종석 바닥 격자선은 **시설 관리(하우징 모드) 중에만** 보인다. hub/HousingMode 가
   * 모드에 들어가며 켜고 나오며 끈다. Optional — 격자가 없는 인테리어(공유 함선)는 생략한다.
   */
  setGridVisible?(on: boolean): void;
  /**
   * 2026-09-13 (사용자 결정, personal ship only): 시설 관리가 열려 있는 동안 조종석 천장(천장판 · 천장 보 셋 · 천장 조명 띠)을 부드럽게
   * 지우고 닫으면 되살린다. hub/HousingMode 가 매 프레임 원하는 상태를 넘기고 인테리어의 `update` 가 불투명도를 몬다 — 재질을 새로
   * 만들거나 transparent 를 켜고 끄지 않으므로 셰이더를 다시 컴파일하지 않고, 광원도 건드리지 않는다.
   */
  setCockpitCeilingHidden?(hidden: boolean): void;
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
