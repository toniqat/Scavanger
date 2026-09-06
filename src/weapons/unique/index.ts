import type { UniqueWeaponKind } from '@/shared';
import type { UniqueHandler, UniqueServices } from './UniqueHandler';
import { Flamethrower } from './Flamethrower';
import { Shockgun } from './Shockgun';
import { Shuriken } from './Shuriken';
import { Bow } from './Bow';
import { Bazooka } from './Bazooka';
import { Minigun } from './Minigun';

export type { UniqueHandler, UniqueServices, UniqueInput, UniquePose, UniqueShot, UniqueWeapon, Host } from './UniqueHandler';
export { coneTargets, enemyCentre } from './UniqueHandler';
export { UniqueFx, ARC_BOLTS } from './UniqueFx';
export { Flamethrower, Shockgun, Shuriken, Bow, Bazooka, Minigun };

/** One handler per equipped unique weapon (`WeaponDef.unique`). */
export function createUniqueHandler(kind: UniqueWeaponKind, s: UniqueServices): UniqueHandler {
  switch (kind) {
    case 'flamethrower': return new Flamethrower(s);
    case 'shockgun': return new Shockgun(s);
    case 'shuriken': return new Shuriken(s);
    case 'bow': return new Bow(s);
    case 'bazooka': return new Bazooka(s);
    case 'minigun': return new Minigun(s);
  }
}
