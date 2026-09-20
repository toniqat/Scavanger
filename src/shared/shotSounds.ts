import type { UniqueWeaponKind, WeaponClass, WeaponDef } from './types';

/*
 * The shot sound a weapon makes — **one table, read by every folder that plays one** (2026-09-20, `docs/TODO.md` B-63).
 *
 * It used to live twice. `weapons/WeaponDefaults` branched on `WeaponKind` and covered the uniques; `player/AllyAvatars`
 * judged a `WeaponDef` again by `ammoType` / `pellets` / class and knew nothing about uniques, so an android holding a
 * legendary fired the **rifle** sample. Neither copy could import the other (CLAUDE.md §4.1 — a folder never reaches into
 * another folder's internals), and nothing failed when the two drifted, which is the shape §4.1 answers with "the same
 * formula in two folders moves to `src/shared`".
 *
 * So this file owns the archetype (`weaponKindOf`) and the id it maps to (`shotSoundId`); `weapons/` and `player/` are
 * both call sites now. A new shot sound is added **here**, once.
 */

/** Weapon archetype used to pick a model and a shot sound. Uniques are their own kinds. */
export type WeaponKind = 'rifle' | 'pistol' | 'shotgun' | 'energy' | 'smg' | 'sniper' | UniqueWeaponKind;

/**
 * The archetype of a def, undefined class included: a secondary with no `weaponClass` is a pistol, anything else an AR.
 * `items/WeaponDefs.weaponClassOf` is this same line, published to the folders that read the class itself.
 */
export function weaponClassOfDef(def: WeaponDef): WeaponClass {
  return def.weaponClass ?? (def.slot === 'secondary' ? 'PISTOL' : 'AR');
}

/** Kind by class → graded ids (`ar_g3`) pick the same procedural model as their family; uniques pick theirs. */
export function weaponKindOf(def: WeaponDef): WeaponKind {
  if (def.unique) return def.unique;
  if (def.pellets && def.pellets > 1) return 'shotgun';
  if (def.ammoType === 'energy') return 'energy';
  switch (weaponClassOfDef(def)) {
    case 'SR': return 'sniper';
    case 'SMG': return 'smg';
    case 'PISTOL': return 'pistol';
    case 'SG': return 'shotgun';
    default: return 'rifle';   // AR / DMR
  }
}

/** The `audio:play` id for a kind. Uniques reuse existing SFX ids — there are no dedicated samples yet. */
export function shotSoundId(kind: WeaponKind): string {
  switch (kind) {
    case 'pistol': return 'shot_pistol';
    case 'shotgun': return 'shot_shotgun';
    case 'energy': return 'shot_energy';
    case 'smg': return 'shot_smg';
    case 'sniper': return 'shot_sniper';
    case 'flamethrower': return 'shot_energy';
    case 'shockgun': return 'shot_energy';
    case 'shuriken': return 'melee_swing';
    case 'bow': return 'melee_swing';
    case 'bazooka': return 'shot_shotgun';
    case 'minigun': return 'shot_rifle';
    default: return 'shot_rifle';
  }
}

/** The shot sound of a def in one call — what a folder holding only a `WeaponDef` wants. */
export function shotSoundOfDef(def: WeaponDef | null | undefined): string {
  return def ? shotSoundId(weaponKindOf(def)) : 'shot_rifle';
}
