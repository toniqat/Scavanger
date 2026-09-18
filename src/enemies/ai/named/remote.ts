/**
 * src/enemies/ai/named/remote.ts — **named rogues · the scan drone on a replica (non-host)** (2026-09-11).
 *
 * A non-host runs no AI. `net/Replica` hands over here in three places:
 *  - `beforeNamedReplica(e, hint)` — **before** the snapshot pose lands (e.g. the scan drone turns the terrain snap off
 *    with `e.airborne = true`). `e.namedHint` already holds the hint that arrived.
 *  - `afterNamedReplica(e, hint, dt, host)` — **after** the default animation targets were damped (per-type pose
 *    overrides · sounds).
 *  - `onNamedEvent(host, msg)` — `ee scanPulse / glint / snipe / hammer / spray` visuals (no game state changes).
 */
import type { EnemyEvent } from '@/shared';
import type { Enemy } from '../../Enemy';
import type { ReplicaHost } from '../../net/Replica';
import { afterSniperReplica, beforeSniperReplica, onSniperEvent } from './Sniper';
import { afterScanDroneReplica, beforeScanDroneReplica, onScanDroneEvent } from './ScanDrone';
import { afterHammerReplica, beforeHammerReplica, onHammerEvent } from './Hammer';
import { afterHeavyReplica, beforeHeavyReplica, onHeavyEvent } from './Heavy';

export type NamedEnemyEvent = Extract<EnemyEvent, { ev: 'scanPulse' | 'glint' | 'snipe' | 'hammer' | 'spray' }>;

export function beforeNamedReplica(e: Enemy, hint: number): void {
  switch (e.type) {
    case 'rogue_sniper': beforeSniperReplica(e, hint); return;
    case 'rogue_scan_drone': beforeScanDroneReplica(e, hint); return;
    case 'rogue_hammer': beforeHammerReplica(e, hint); return;
    case 'rogue_heavy': beforeHeavyReplica(e, hint); return;
    default: return;
  }
}

/**
 * `host`: the exit through which replica visuals reach sounds, raycasts and the target lists. `net/Replica.drive`
 * always passes it, so it is **required** — a per-type file never parks a host in a module global (C-54, 2026-09-11).
 */
export function afterNamedReplica(e: Enemy, hint: number, dt: number, host: ReplicaHost): void {
  switch (e.type) {
    case 'rogue_sniper': afterSniperReplica(e, hint, dt); return;
    case 'rogue_scan_drone': afterScanDroneReplica(e, hint, dt, host); return;
    case 'rogue_hammer': afterHammerReplica(e, hint, dt, host); return;
    case 'rogue_heavy': afterHeavyReplica(e, hint, dt, host); return;
    default: return;
  }
}

export function onNamedEvent(host: ReplicaHost, msg: NamedEnemyEvent): void {
  switch (msg.ev) {
    case 'scanPulse': onScanDroneEvent(host, msg); return;
    case 'glint':
    case 'snipe': onSniperEvent(host, msg); return;
    case 'hammer': onHammerEvent(host, msg); return;
    case 'spray': onHeavyEvent(host, msg); return;
  }
}
