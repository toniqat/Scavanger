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
/* appended (Phase 10): 들쳐메기 seam + 준비 패널 초상화 */
export type { CarryHost, CarryStatus, CarryTarget } from './Carry';
export { createPortraits } from './Portraits';
/* appended (2026-09-15): 얼굴 초상 — 터미널 매칭 탭(`PlayerRef.snapshotFace`)과 캐릭터 생성 미리보기가 같은 절차를 쓴다 */
export { addFaceLights, aimFaceCamera, poseFaceModel, releaseFaceSnapshots, snapshotAndroidFace, snapshotFace } from './FaceSnapshot';
/* appended (2026-09-15): 안드로이드 분대원의 몸 — `ctx.allies` 의 `AllyBodyView` 를 `SoldierModel` 로 그린다 */
export { AllyAvatar, AllyAvatars } from './AllyAvatars';
export type { DebugAllyBody } from './AllyAvatars';
export { buildHeldWeapon } from './GearLook';
export type { WeaponLook } from './GearLook';
