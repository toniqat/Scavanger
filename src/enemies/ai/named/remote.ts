/**
 * src/enemies/ai/named/remote.ts — **리플리카(비호스트)에서의 네임드 로그 · 스캔 드론** (2026-09-11).
 *
 * 비호스트는 AI 를 돌리지 않는다. `net/Replica` 가 세 군데에서 여기로 넘긴다:
 *  - `beforeNamedReplica(e, hint)` — 스냅샷 자세를 입히기 **전** (예: 스캔 드론은 `e.airborne = true` 로 지형 스냅을 끈다).
 *    `e.namedHint` 는 이미 받은 힌트로 채워져 있다.
 *  - `afterNamedReplica(e, hint, dt, host)` — 기본 애니메이션 목표를 댐핑한 **뒤** (종류별 자세 덮어쓰기 · 소리).
 *  - `onNamedEvent(host, msg)` — `ee scanPulse / glint / snipe / hammer / spray` 연출 (게임 상태는 바꾸지 않는다).
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
 * `host`: 리플리카 연출이 소리 · 레이캐스트 · 표적 목록을 읽는 출구. `net/Replica.drive` 가 늘 넘기므로 **필수**다 —
 * 종류별 파일은 모듈 전역에 호스트를 받아 두지 않는다 (C-54, 2026-09-11).
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
