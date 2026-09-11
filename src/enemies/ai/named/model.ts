/**
 * src/enemies/ai/named/model.ts — **로든 ↔ 스캔 드론이 주고받는 상태** (2026-09-11, 리드가 고정한 폴더 내부 계약).
 *
 * 저격수(`Sniper.ts`)와 스캔 드론(`ScanDrone.ts`)은 서로 다른 담당이 만든다. 둘은 서로의 `Enemy.namedData` 를
 * 이 모양으로만 읽는다 — 모양을 바꾸려면 양쪽이 같이 바꾼다. 둘 다 **호스트에서만** 쓴다(리플리카는 와이어 이벤트만 본다).
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
   * **ScanDrone.ts 에 보내는 신호.** 로든이 드론 `id` 의 스캔을 **소모**했다 — 스캔 표적에게 쐈거나(성공),
   * 사선이 끝내 안 열려 포기했거나, 드론이 스캔을 마치기 전에 떨어졌다. 그 순간 `droneId` 는 null 로 돌아가고
   * 여기에 그 드론의 id 가 남는다. 드론은 자기 id 가 보이면 노출을 풀고(`named:scanExposure {count:0}`) 복귀하면 된다.
   * 다음 드론이 뜨기 전까지 값이 유지된다.
   */
  resolvedDroneId: number | null;
  /* 이하 Sniper.ts 내부 상태 — 드론 쪽은 읽지 않는다. */
  /** 스캔 완료 뒤 사선을 기다리는 남은 s (< 0 = 아직 완료를 못 봤다). */
  scanWait: number;
  /** 지금 드론이 뜬 지 몇 s (드론이 응답이 없을 때의 안전장치). */
  droneAge: number;
  /** 지난 틱의 hp — 줄었으면 피격. */
  lastHp: number;
  /** 자리를 옮기는 중이면 남은 s (> 0 = 일어서서 달린다, 목표는 `Enemy.coverPos`). */
  relocate: number;
  /** 다음 자리 옮기기까지 s. */
  relocateCd: number;
  /** 엎드린 지 몇 s (자세가 다 내려앉기 전에는 반짝임을 시작하지 않는다). */
  proneTime: number;
  /** 마지막 표적 고르기의 답 — 사선이 열린 가장 가까운 표적, 또는 null. */
  pickId: TargetId | null;
  /** 그 표적이 스캔 표적인가. */
  pickScanned: boolean;
  /** 다음 표적 고르기까지 s. */
  pickAt: number;
  /** 할 일이 없을 때 조준경으로 훑는 중심 방향 (rad). */
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
  /* ── appended (2026-09-11, ScanDrone.ts 전용 — Sniper.ts 는 읽지 않는다) ── */
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
