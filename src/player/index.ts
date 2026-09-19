export { PlayerSystem } from './PlayerSystem';
export { RemotePlayerSystem } from './RemotePlayerSystem';
export type { DebugRemoteRef } from './RemotePlayerSystem';
export { RemoteAvatar } from './RemoteAvatar';
export { SoldierModel, SOLDIER_DEFAULT_ACCENT } from './SoldierModel';
export type { SoldierPose } from './SoldierModel';
export { CameraRig } from './CameraRig';
export { PlayerController } from './PlayerController';
export { PlayerGear } from './PlayerGear';
export { Hellpod } from './Hellpod';
export type { Ghost } from './RemotePlayerSystem';
export { buildArmorPlate, buildHeldItem } from './GearLook';
export type { GearLook } from './GearLook';
/* appended (Phase 10): shouldering seam + ready-panel portraits */
export type { CarryHost, CarryStatus, CarryTarget } from './Carry';
export { createPortraits } from './Portraits';
/* appended (2026-09-15): face portraits — `PlayerRef.snapshotFace`, shared by the `매칭` tab and character creation */
export { addFaceLights, aimFaceCamera, poseFaceModel, releaseFaceSnapshots, snapshotAndroidFace, snapshotFace } from './FaceSnapshot';
/* appended (2026-09-15): android squadmate bodies — `ctx.allies`' `AllyBodyView` drawn as a `SoldierModel` */
export { AllyAvatar, AllyAvatars } from './AllyAvatars';
export type { DebugAllyBody } from './AllyAvatars';
export { buildHeldWeapon } from './GearLook';
export type { WeaponLook } from './GearLook';
