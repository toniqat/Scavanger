/**
 * src/enemies/ai/named/index.ts — **named rogue · scan drone AI dispatch** (2026-09-11).
 *
 * `ai/EnemyAI.updateEnemyAI` hands over here after perception (`updatePerception`) and **before** the ordinary rogue
 * branch (`updateRogue`). One file per type holds that type's state machine — the state is
 * `Enemy.namedPhase / namedTimer / namedCooldown / namedData`, the wire animation hint is `Enemy.namedHint`
 * (14..20, `EnemyWire.a`). The numbers come from the `NAMED_*` blocks in `EnemyTypes`.
 */
import type { EnemyType } from '@/shared';
import type { Enemy, EnemyHost } from '../../Enemy';
import type { CombatTarget } from '../../Targets';
import { updateSniper } from './Sniper';
import { updateScanDrone } from './ScanDrone';
import { updateHammer } from './Hammer';
import { updateHeavy } from './Heavy';

/** The types that take this branch — the three named rogues + Roden's scan drone. */
export function isNamedAiType(t: EnemyType): boolean {
  return t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy' || t === 'rogue_scan_drone';
}

export function updateNamed(e: Enemy, dt: number, host: EnemyHost, t: CombatTarget | null, targetAlive: boolean): void {
  switch (e.type) {
    case 'rogue_sniper': updateSniper(e, dt, host, t, targetAlive); return;
    case 'rogue_scan_drone': updateScanDrone(e, dt, host, t, targetAlive); return;
    case 'rogue_hammer': updateHammer(e, dt, host, t, targetAlive); return;
    case 'rogue_heavy': updateHeavy(e, dt, host, t, targetAlive); return;
    default: return;
  }
}
