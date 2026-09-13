import type * as THREE from 'three';
import type { EnemyType, HumanoidSpawnOpts } from '@/shared';
import type { Enemy } from './Enemy';
import type { SpawnHost } from './Spawner';

/* ────────────────────────────────────────────────────────────────────────────
 * 인간형 스폰 서비스 계약 (Phase 4 부터 이 파일 이름이다).
 *
 * 2026-09-13: **상자 경비(`placeRogueGuards`)는 폐지됐다.** 레이드 시작 배치는 행성 threat 에 따른 **거점 그룹**이고
 * `SiteGroups.ts` 가 갖는다 (연구소 · 전진기지 · 선로 플랫폼 · 폐허 전초). 이 파일에는 거점 그룹 · 레이더 강하
 * (`RogueDrop.ts`) · 네임드(`named/Director.ts`)가 함께 쓰는 `RogueSpawnHost` 만 남았다 — 이름은 계약이라 그대로다.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Extra spawn service for humanoids (implemented by EnemySystem). */
export interface RogueSpawnHost extends SpawnHost {
  /**
   * Spawn a humanoid (rogue · android · raider · named) guarding `guardPos` (leash centre) with weapon family `weaponId`;
   * `escortOf` makes it follow that leader. `opts` = 거점 · 분대 · 역할 (생략 = 거점 없음 · 분대 없음 · member).
   */
  spawnRogue(type: EnemyType, position: THREE.Vector3, yaw: number, guardPos: THREE.Vector3, weaponId: string, escortOf: Enemy | null, opts?: HumanoidSpawnOpts): Enemy | null;
  /** 2026-09-13: 이번 레이드에서 유일한 새 분대 id (1 부터, `Pool.reset` 이 되돌린다). 거점 그룹 · 강하 파도 · 헤비 분대가 쓴다. */
  allocSquadId(): number;
}

/* ── 은퇴한 이름 (2026-09-13) ─────────────────────────────────────────────────────────────────────────────
 * 폴더 안 여러 파일(`model.ts` · `parts/*` 의 공용 import 줄)과 `index.ts` 가 옛 이름을 가져온다. 그 파일들을 한꺼번에
 * 고치지 않으려고 이름만 남긴다 — **아무도 호출하지 않고, 불러도 아무것도 세우지 않는다.** 배치는 `SiteGroups.placeSiteGroups`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────── */
/** @deprecated 2026-09-13 — 상자 경비 폐지. 0. */
export const MAX_GUARDS = 0;
/** @deprecated 2026-09-13 — 상자 경비 폐지. 0. */
export const ECO_BOSS_CHANCE = 0;
/** @deprecated 2026-09-13 — 상자 경비 폐지. */
export interface GuardPlacement { squads: number; rogues: number; boss: Enemy | null }
/** @deprecated 2026-09-13 — 상자 경비 폐지. 늘 0. */
export function guardCap(_eco?: unknown): number { return 0; }
/** @deprecated 2026-09-13 — 상자 경비 폐지. 아무것도 세우지 않는다 (`SiteGroups.placeSiteGroups` 를 쓴다). */
export function placeRogueGuards(_host?: RogueSpawnHost, _seed?: number, _eco?: unknown): GuardPlacement {
  return { squads: 0, rogues: 0, boss: null };
}
