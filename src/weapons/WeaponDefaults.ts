import type { WeaponDef } from '@/shared';

/** Built-in fallbacks used when `ctx.loot` is unavailable or a weaponId cannot be resolved. */
export const DEFAULT_RIFLE: WeaponDef = {
  id: 'ar23_liberator', name: 'AR-23 리버레이터', slot: 'primary', ammoType: 'rifle',
  damage: 60, fireRate: 10, magSize: 45, reserveMags: 6, reloadTime: 2.4,
  spread: 0.028, adsSpread: 0.007, range: 220, automatic: true, recoil: 0.011, tracerColor: 0xffd070,
};

export const DEFAULT_PISTOL: WeaponDef = {
  id: 'p2_peacemaker', name: 'P-2 피스메이커', slot: 'secondary', ammoType: 'pistol',
  damage: 45, fireRate: 6, magSize: 15, reserveMags: 6, reloadTime: 1.6,
  spread: 0.02, adsSpread: 0.006, range: 140, automatic: false, recoil: 0.02, tracerColor: 0xffe2a8,
};

export function defaultFor(slot: 'primary' | 'secondary'): WeaponDef {
  return slot === 'primary' ? DEFAULT_RIFLE : DEFAULT_PISTOL;
}

export type WeaponKind = 'rifle' | 'pistol' | 'shotgun' | 'energy';

export function kindOf(def: WeaponDef): WeaponKind {
  if (def.pellets && def.pellets > 1) return 'shotgun';
  if (def.ammoType === 'energy') return 'energy';
  if (def.slot === 'secondary' || def.ammoType === 'pistol') return 'pistol';
  return 'rifle';
}

export function shotSoundId(kind: WeaponKind): string {
  switch (kind) {
    case 'pistol': return 'shot_pistol';
    case 'shotgun': return 'shot_shotgun';
    case 'energy': return 'shot_energy';
    default: return 'shot_rifle';
  }
}
