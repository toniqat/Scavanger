/**
 * src/enemies/ai/named/index.ts — **네임드 로그 · 스캔 드론 AI 분기** (2026-09-11).
 *
 * `ai/EnemyAI.updateEnemyAI` 가 인지(`updatePerception`) 뒤, 일반 로그 분기(`updateRogue`) **앞에서** 여기로 넘긴다.
 * 종류마다 파일 하나가 자기 상태 기계를 갖는다 — 상태는 `Enemy.namedPhase / namedTimer / namedCooldown / namedData`,
 * 와이어 애니메이션 힌트는 `Enemy.namedHint`(14..20, `EnemyWire.a`). 수치는 `EnemyTypes` 의 `NAMED_*` 블록.
 */
import type { EnemyType } from '@/shared';
import type { Enemy, EnemyHost } from '../../Enemy';
import type { CombatTarget } from '../../Targets';
import { updateSniper } from './Sniper';
import { updateScanDrone } from './ScanDrone';
import { updateHammer } from './Hammer';
import { updateHeavy } from './Heavy';

/** 이 분기를 타는 종류 — 네임드 3종 + 로든의 스캔 드론. */
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
