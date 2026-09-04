# src/weapons — Weapons, grenades, weapon FX

Owner: `WeaponSystem` (`name: 'weapons'`). Registers after `PlayerSystem`; reaches the player through `ctx.player` narrowed to `PlayerRef & PlayerWeaponHost`.

| File | Purpose |
|---|---|
| `WeaponSystem.ts` | Slots primary/secondary from `loadout:changed` (defs via `ctx.loot.getItemDef(defId).weaponId → getWeaponDef`, fallback built-ins). Ammo (`ammoInMag`, `reserveRounds`) persisted per item `uid` so swapping keeps state. LMB fire (auto/semi, only while pointer-locked and `host.canUseWeapons()`), R reload (empty reserve → `inventory.consumeWhere(ammo of def.ammoType)` refills `reserveMags × magSize`, else "탄약 없음"), 1/2/Q swap with 0.4 s holster/draw, G grenade (`consumeWhere(grenade)`). Firing: reticle ray from `host.getAimRay` with spread (hip/ADS × bloom × moving) → nearest of `enemies.raycast`/`world.raycast` (hits between camera and player ignored) gives the target; the real shot is re-cast from the muzzle toward that target; tracer from muzzle; `enemy.takeDamage(dmg, point, dir)`; shotgun pellets; `projectileSpeed` weapons use `ProjectilePool`. Emits `weapon:equipped/ammoChanged/fired/dryFire/reloadStarted/reloadFinished/hit`, `ui:hitmarker {kill, headshot}` (headshot = `EnemyHit.part === 'head'`), `grenade:countChanged`, `audio:play`. Recoil → `host.addRecoil`; pose → `host.setWeaponState`. If no `loadout:changed` arrives within 1 s of `world:ready`, equips the built-in rifle + pistol. |
| `WeaponDefaults.ts` | `DEFAULT_RIFLE` (AR-23 리버레이터: 60 dmg, 10 rps, 45/6 mags, 2.4 s, auto, tracer 0xffd070), `DEFAULT_PISTOL` (P-2 피스메이커: 45 dmg, semi, 15/6, 1.6 s), `kindOf(def)` → rifle/pistol/shotgun/energy, `shotSoundId`. |
| `WeaponModel.ts` | Procedural rifle / pistol / shotgun / energy-rifle meshes (grip at origin, barrel -Z) with `muzzle` and `ejectPort` sockets. Animation: recoil kick (`kick`), reload (mag drops, disappears, new mag slides in; weapon cants), draw/holster swing (`setDraw`), energy glow pulse. |
| `Grenade.ts` | `GrenadeManager`: 8 pooled frags; gravity, terrain bounce (restitution/friction via `getNormalAt`), obstacle push-out, 2.5 s fuse with accelerating LED blink; explosion radius 6 m / 250 dmg via `enemies.applyExplosion`, self-damage with falloff, distance-scaled `camera:shake`, `grenade:thrown/exploded`, `audio:play explosion`. |
| `Projectile.ts` | `ProjectilePool`: 48 swept projectiles (enemy + world raycast per step, slight drop), glowing tracer trail, hit callback. |
| `fx/WeaponFx.ts` | Muzzle flash (FlashPool light + glow, sparks, wisp), casings, surface impacts (sparks on obstacles, dust on terrain), enemy ichor, explosion (fireball, sparks, smoke, ground ring, flash, expanding shockwave ring). |
| `index.ts` | Barrel. |

Audio ids emitted: `shot_rifle`, `shot_pistol`, `shot_shotgun`, `shot_energy`, `dry_fire`, `reload`, `reload_done`, `weapon_swap`, `hit_flesh`, `hit_metal`, `hit_dirt`, `grenade_throw`, `grenade_bounce`, `explosion`, `ui_deny`.
