import type { EnemyType } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * 네임드 로그 (2026-09-11). Owner: `enemies/` — 스폰은 `enemies/named/Director`, AI 는 `enemies/ai/named/*`.
 *
 * 레이드마다 **최대 한 명**이다 (사용자 결정). 확률은 행성 난이도 순번(`planetTier`, 1..5)으로
 * `NAMED_ROGUE_CHANCE_BY_RANK` 표에서 읽고, 셋 중 누구인지는 같은 시드 스트림에서 고른다 — 호스트가 바뀌어도
 * 같은 답이 나온다. 네임드는 전부 휴머노이드 로그 리그를 쓰고 팩션은 `rogue` 다.
 *
 *  - 로든 (`rogue_sniper`)  — 개활지의 엎드려쏴 저격수. 멀리서는 **스캔 드론**(`rogue_scan_drone`)의 음파를
 *    `scanPulses` 번 받은 플레이어만 노리고(높은 명중률), 감지 범위 안에서는 드론 없이 쏜다(거리에 따라 명중률 감소).
 *    쏘기 전에는 반드시 조준경 반짝임(`named:sniperGlint`)이 먼저 뜬다 — 전조 없는 즉사는 없다.
 *  - 타길라 (`rogue_hammer`) — 망치 근접. 붙으면 초당 50. 체력은 일반 로그의 10배. 엄폐물 · 구조물 근처에 선다.
 *  - 헤비 (`rogue_heavy`)    — 미니건. SMG 로그 호위(`NAMED_HEAVY_ESCORTS_BY_SQUAD`, 분대 인원별)와 함께 온다.
 * ──────────────────────────────────────────────────────────────────────────── */

export type NamedRogueType = 'rogue_sniper' | 'rogue_hammer' | 'rogue_heavy';

export const NAMED_ROGUE_TYPES: readonly NamedRogueType[] = ['rogue_sniper', 'rogue_hammer', 'rogue_heavy'];

/** 게임 안에 적히는 이름. */
export const NAMED_ROGUE_NAME_KO: Readonly<Record<NamedRogueType, string>> = {
  rogue_sniper: '로든',
  rogue_hammer: '타길라',
  rogue_heavy: '헤비',
};

export function isNamedRogueType(t: EnemyType | string | null | undefined): t is NamedRogueType {
  return t === 'rogue_sniper' || t === 'rogue_hammer' || t === 'rogue_heavy';
}
