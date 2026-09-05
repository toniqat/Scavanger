import * as THREE from 'three';
import { ROGUE_BOSS_ESCORTS, Random, type EnemyType } from '@/shared';
import type { Enemy } from './Enemy';
import { ROGUE_AI } from './EnemyTypes';
import type { SpawnHost } from './Spawner';

/* ────────────────────────────────────────────────────────────────────────────
 * Rogue guard placement (Phase 4, authority only, on `world:ready`). Squads of 2–4 gunners stand 6–12 m around
 * tier ≥ 2 crates (30 % of tier-2, every tier-3/4 crate), ≤ MAX_GUARDS in total; one random tier-3/4 crate gets the
 * boss with ROGUE_BOSS_ESCORTS escorts that follow it. Seeded by the world seed so a host reproduces the same layout
 * for the same mission (guards are not part of waves or the ambient bug cap).
 * ──────────────────────────────────────────────────────────────────────────── */

export const MAX_GUARDS = 16;

/** Extra spawn service for rogues (implemented by EnemySystem). */
export interface RogueSpawnHost extends SpawnHost {
  /** Spawn a rogue guarding `guardPos` (leash centre) with rifle `weaponId`; `escortOf` makes it follow the boss. */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null): Enemy | null;
}

const _p = new THREE.Vector3();

export interface GuardPlacement { squads: number; rogues: number; boss: Enemy | null }

export function placeRogueGuards(host: RogueSpawnHost, seed: number): GuardPlacement {
  const result: GuardPlacement = { squads: 0, rogues: 0, boss: null };
  const world = host.ctx.world;
  if (!world) return result;
  const rng = new Random((seed ^ 0x9e3779b9) >>> 0);
  const crates = world.getCrates();
  const spawn = world.getPlayerSpawn();
  const high = crates.filter((c) => c.tier >= 3 && Math.hypot(c.position.x - spawn.x, c.position.z - spawn.z) > 45);
  const mid = crates.filter((c) => c.tier === 2 && Math.hypot(c.position.x - spawn.x, c.position.z - spawn.z) > 45);

  // boss at one random tier-3/4 crate
  let bossCrate = high.length > 0 ? high[rng.int(0, high.length - 1)] : null;
  if (bossCrate) {
    const boss = placeAround(host, 'rogue_boss', bossCrate.position, rng, 5, 7, ROGUE_AI.bossWeapon, null);
    if (boss) {
      boss.leash = ROGUE_AI.leash;
      result.boss = boss;
      result.rogues++;
      for (let i = 0; i < ROGUE_BOSS_ESCORTS && result.rogues < MAX_GUARDS; i++) {
        const w = ROGUE_AI.weapons[rng.int(0, ROGUE_AI.weapons.length - 1)];
        const esc = placeAround(host, 'rogue', boss.position, rng, 3, 6, w, boss);
        if (esc) { esc.leash = ROGUE_AI.escortLeash; result.rogues++; }
      }
      result.squads++;
    } else bossCrate = null;
  }

  // squads at the remaining high crates, then 30 % of the tier-2 crates
  const targets = high.filter((c) => c !== bossCrate);
  for (const c of mid) if (rng.chance(0.3)) targets.push(c);
  for (const crate of targets) {
    if (result.rogues >= MAX_GUARDS) break;
    const n = Math.min(rng.int(2, 4), MAX_GUARDS - result.rogues);
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const w = ROGUE_AI.weapons[rng.int(0, ROGUE_AI.weapons.length - 1)];
      const e = placeAround(host, 'rogue', crate.position, rng, 6, 12, w, null);
      if (e) { placed++; result.rogues++; }
    }
    if (placed > 0) result.squads++;
  }
  return result;
}

function placeAround(host: RogueSpawnHost, type: EnemyType, center: THREE.Vector3, rng: Random, minR: number, maxR: number, weaponId: string, escortOf: Enemy | null): Enemy | null {
  const world = host.ctx.world!;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ang = rng.range(0, Math.PI * 2);
    const rad = rng.range(minR, maxR);
    _p.set(center.x + Math.cos(ang) * rad, 0, center.z + Math.sin(ang) * rad);
    if (!world.isInsideBounds(_p.x, _p.z)) continue;
    world.resolveCollision(_p, 1.0);
    _p.y = world.getHeightAt(_p.x, _p.z);
    const yaw = Math.atan2(center.x - _p.x, center.z - _p.z) + Math.PI;   // face outward from the crate
    return host.spawnRogue(type, _p, yaw, center, weaponId, escortOf);
  }
  return null;
}
