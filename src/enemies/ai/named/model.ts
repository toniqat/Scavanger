/**
 * src/enemies/ai/named/model.ts — **the state Roden and the scan drone exchange** (2026-09-11, a folder-internal
 * contract the lead fixed).
 *
 * The sniper (`Sniper.ts`) and the scan drone (`ScanDrone.ts`) are written by different owners. Each reads the other's
 * `Enemy.namedData` only in this shape — changing the shape changes both sides together. Both are used **on the host
 * only** (a replica sees the wire events and nothing else).
 */
import type { TargetId } from '../../Targets';

/** `Enemy.namedData` of a `rogue_sniper`. Owner: Sniper.ts (ScanDrone.ts reads `droneId` only). */
export interface SniperData {
  kind: 'sniper';
  /** Enemy id of the scan drone currently out, or null. */
  droneId: number | null;
  /** Seconds until the next drone may launch (`droneCooldown` after a finished scan, `droneRetry` after an interception). */
  droneCooldown: number;
  /** Seconds until the next shot may be telegraphed. */
  fireCooldown: number;
  /** Target of the shot being telegraphed (glint), or null. */
  aimTargetId: TargetId | null;
  /** Seconds left of the glint telegraph (> 0 = glinting, the shot fires at 0). */
  glintLeft: number;
  /** true when the telegraphed shot uses `scannedAccuracy` (the target was scanned), false = the near-mode curve. */
  aimScanned: boolean;
  /* ── appended by Sniper.ts (2026-09-11) ── */
  /**
   * **The signal to ScanDrone.ts.** Roden **consumed** drone `id`'s scan — it shot a scanned target (success), gave up
   * because the line never opened, or the drone went down before it finished scanning. At that moment `droneId` goes
   * back to null and that drone's id is left here. A drone that sees its own id clears the exposure
   * (`named:scanExposure {count:0}`) and flies home. The value is kept until the next drone launches.
   */
  resolvedDroneId: number | null;
  /* Sniper.ts internal state from here on — the drone side does not read it. */
  /** Seconds left waiting for a line of fire after the scan finished (< 0 = the finish has not been seen yet). */
  scanWait: number;
  /** Seconds the current drone has been out (a safety net for a drone that never answers). */
  droneAge: number;
  /** Last tick's hp — a drop means it was hit. */
  lastHp: number;
  /** Seconds left of a relocation, when one is under way (> 0 = it stands up and runs, target `Enemy.coverPos`). */
  relocate: number;
  /** Seconds until the next relocation. */
  relocateCd: number;
  /** Seconds spent prone (no glint starts before the pose has fully settled). */
  proneTime: number;
  /** The answer of the last target pick — the nearest target with an open line, or null. */
  pickId: TargetId | null;
  /** Whether that target is a scanned one. */
  pickScanned: boolean;
  /** Seconds until the next target pick. */
  pickAt: number;
  /** Centre direction the scope sweeps around with nothing to do (rad). */
  watchYaw: number;
}

/** `Enemy.namedData` of a `rogue_scan_drone`. Owner: ScanDrone.ts (Sniper.ts reads `exposure` / `done`). */
export interface ScanDroneData {
  kind: 'scanDrone';
  /** Enemy id of the sniper that launched it. */
  sniperId: number;
  /** Player it was sent after (the drone follows that player). */
  targetId: TargetId;
  /** Pulses emitted so far. */
  pulses: number;
  /** Seconds until the next pulse. */
  pulseTimer: number;
  /** Pulses each player was caught in (key = `CombatTarget.id`). */
  readonly exposure: Map<TargetId, number>;
  /** All `NAMED_SNIPER.scanPulses` pulses went out — the sniper may fire on anyone with `exposure ≥ exposeNeeded`. */
  done: boolean;
  /** Seconds spent over the target (`NAMED_SCAN_DRONE.loiterMax` → fly back and despawn). */
  loiter: number;
  /* ── appended (2026-09-11, ScanDrone.ts only — Sniper.ts does not read these) ── */
  /** true once the sniper's `SniperData.droneId` pointed at this drone — after that `droneId !== id` means "released". */
  claimed: boolean;
  /** The sniper is telegraphing a scanned shot (`glintLeft > 0 && aimScanned`) — a falling edge = the shot went out. */
  glinting: boolean;
  /** Seconds the drone still waits for a follow-up shot after one went out (< 0 = no shot seen yet). */
  shotGrace: number;
  /** Seconds spent flying home (phase 2) / climbing away (phase 3) — hard despawn deadline. */
  leave: number;
}

export function sniperDataOf(e: { namedData: unknown }): SniperData | null {
  const d = e.namedData as SniperData | null;
  return d && d.kind === 'sniper' ? d : null;
}

export function scanDroneDataOf(e: { namedData: unknown }): ScanDroneData | null {
  const d = e.namedData as ScanDroneData | null;
  return d && d.kind === 'scanDrone' ? d : null;
}
