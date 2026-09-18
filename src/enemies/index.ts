export { EnemySystem } from './EnemySystem';
export { Enemy, type EnemyState, type HitPart, type EnemyHost } from './Enemy';
export { ENEMY_STATS, ALL_ENEMY_TYPES, HUNTER_LEAP, SPEWER_SPIT, CHARGER_CHARGE, ROGUE_AI, ARTILLERY_AI, TOXIC_AI, BEHEMOTH_AI, isRogueType, isEggType, baseTypeOf, isTutorialEnemyType, TUTORIAL_ENEMY_BASE, type EnemyStats, type BugType, type EggEnemyType, type TutorialEnemyType } from './EnemyTypes';
export { BUG_PARAMS, type BugParams } from './models/BugParams';
export { createBugRig, disposeBugRig, animateBug, createBugAnim, disposeBugAssets, type BugRig, type BugAnim } from './models/BugModel';
export { createRogueRig, disposeRogueRig, animateRogue, disposeRogueAssets, ROGUE_RIG_PARAMS, type RogueRig, type RogueType } from './models/RogueModel';
export { SpatialGrid } from './SpatialGrid';
export { CombatTarget, TargetList, type TargetId } from './Targets';
export {
  AmbientSpawner, findSpawnCenter, spawnGroup, ambientGroup, waveGroup, isVisibleToAnyPlayer,
  MAX_ARTILLERY, MAX_BEHEMOTH, ambientCap, ecoAllows, maxArtilleryOf, maxBehemothOf, type SpawnHost,
} from './Spawner';
export { placeRogueGuards, guardCap, ECO_BOSS_CHANCE, MAX_GUARDS, type RogueSpawnHost, type GuardPlacement } from './RogueGuards';
export { placeTutorialEnemies, tutorialHold, updateTutorialAmbush, type TutorialAmbush, type TutorialPlacement } from './Tutorial';
/* appended (2026-09-15): chain spawn · per-stretch aggro release · the liftoff fire window */
export { onTutorialCheckpoint, onTutorialFell, onTutorialLiftoff, updateTutorialScript, type TutorialScriptHost } from './Tutorial';
export { RogueDropDirector, disposeRogueDropAssets, type RogueDropHost } from './RogueDrop';
export { Corpse, CorpseManager } from './Corpses';
export { raySphere, rayCapsule, rayStandingCapsule } from './RayTests';
export { WaveDirector, WAVE_ALIVE_CAP } from './WaveDirector';
/* appended (2026-09-18): bug nests — eggs · anchors · the garrison leash · refill */
export { NestDirector, applyEggSize, type NestPlacement } from './NestDirector';
export { nestLeashHold } from './ai/NestLeash';
export { createEggRig, disposeEggRig, animateEgg, disposeEggAssets, setEggScale, type EggRig } from './models/EggModel';
export { BloodFX } from './fx/BloodFX';
export { AcidProjectiles, type AcidHost, type AcidSlow } from './fx/AcidProjectile';
export { ShellProjectiles, type ShellHost } from './fx/ShellProjectile';
export { RogueGrenades, type GrenadeHost } from './fx/RogueGrenade';
export { pickCover, coverBlocksLine, flankCost, COVER_SEARCH_RADIUS } from './ai/RogueCover';
export { LureField, type LureEntry } from './ai/Lures';
export { refreshStructureTarget, biteStructure, STRUCT_DAMAGE_MUL } from './ai/Structures';
export { hasLineOfSight, visionClarity, detectionRange, senseRadiusOf, hearRadiusOf, becomeAlert, acquireTarget, updatePerception } from './ai/Perception';
export { fireOrigin, hasFireLine, fireLineStrafe } from './ai/FireLine';
export { EnemyReplica, ReplicaBuffer, type ReplicaHost } from './net/Replica';
export { encodeSnapshot, animHint } from './net/HostSync';
