/**
 * src/allies/model.ts — 안드로이드 분대원의 **어휘**. 상태를 들지 않는다 (CLAUDE.md §4.1 의 `model.ts` + `parts/*.ts` 규약).
 *
 * 여기 있는 것: FSM 우선순위 · 반응 지연 식 · 스크래치 벡터 · 좌표 규약(앞 = `(−sin yaw, 0, −cos yaw)`) · 한국어 대사 ·
 * 명령/요청의 종류. 실제 몸은 `parts/Body.ts` 의 `Ally`, 판단은 `parts/*` 가 한다.
 */
import * as THREE from 'three';
import {
  ALLY_REACT_JITTER, ALLY_REACT_MAX_S, ALLY_REACT_MIN_S, ALLY_STATE_WEIGHT,
} from '@/shared';
import type { AllyStateId, PeerId } from '@/shared';

/**
 * FSM 제안의 우선순위 — **순서**지 균형 수치가 아니라 csv 가 아니라 여기 있다 (사용자 결정의 서열을 그대로 옮긴 것이다:
 * 사망/쓰러짐 > 업기 > 구조 > 전투 > 건네기 > 탈출 호출/탑승 > 짐 버리기 > 명령받은 줍기 > 이동/주의/앞장 > 자율 루팅 > 따라가기 > 대기).
 * 같은 값이면 먼저 제안된 것이 이긴다.
 */
export const PRIO = {
  idle: 0,
  follow: 5,
  autoLoot: 10,
  order: 20,
  orderLoot: 30,
  junk: 40,
  extract: 50,
  deliver: 60,
  combat: 70,
  rescue: 80,
  carry: 90,
  down: 100,
} as const;

/** 요청(선착순 하나만 받는 것)의 종류. 인벤토리 요청 `ItemRequestKind` 와 의사소통 휠을 한 축으로 묶는다. */
export type AllyRequestKind = 'heal' | 'shield' | 'ammo' | 'item' | 'crate' | 'extract' | 'contract';

/** 지금 분대가 건 요청 하나 (선착순, `ALLY_REQUEST_COOLDOWN_S` 동안 다른 요청을 무시한다). */
export interface AllyRequest {
  kind: AllyRequestKind;
  /** 요청한 사람 (로컬은 `ctx.net.localId ?? ALLY_LOCAL_PEER`). */
  by: PeerId;
  /** 요청자 위치 (스냅샷 복사본 — 보관해도 되는 값이어야 한다). */
  at: THREE.Vector3;
  /** 아이템 요청이면 그 def id / 탄종. */
  defId: string | null;
  ammoType: string | null;
  /** 상자 · 아이템 핑이면 그 대상 id. */
  targetId: string | null;
  /** 요청이 들어온 `ctx.time`. */
  time: number;
  /** 이 요청을 맡은 안드로이드 id (아직 없으면 null). */
  claimedBy: string | null;
}

/** 한국어 대사 — 없을 때 채팅으로 알린다 (사용자 결정 「없으면 채팅으로 없다고 함」). */
export const CHAT_KO = {
  noHeal: '회복 아이템이 없다.',
  noShield: '실드 충전기가 없다.',
  noAmmo: (label: string) => `${label} 탄약이 없다.`,
  noExtract: '탈출구를 찾지 못했다.',
  noContract: '계약 목표를 찾지 못했다.',
  noItem: '건넬 만한 물건이 없다.',
  wantExtract: '탈출해야 한다!',
} as const;

/* ── 스크래치 (프레임마다 재할당하지 않는다 — CLAUDE.md §4.1) ─────────────────────────────── */
export const _v1 = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _v3 = new THREE.Vector3();
export const _v4 = new THREE.Vector3();
export const _v5 = new THREE.Vector3();
export const _v6 = new THREE.Vector3();

/**
 * `from` 에서 `to` 를 바라보는 yaw. **원격 아바타 규약**이다 — 몸 앞 = `(−sin yaw, 0, −cos yaw)`
 * (`player/CameraRig.getForward`). 적 AI 의 `yawTo` 와 부호가 반대이므로 그대로 베껴 오면 안 된다.
 */
export function yawToward(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** `yaw` 를 `target` 쪽으로 최대 `rate × dt` 만큼 돌린다. */
export function turnToward(yaw: number, target: number, rate: number, dt: number): number {
  let diff = target - yaw;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const max = rate * dt;
  if (diff > max) diff = max;
  else if (diff < -max) diff = -max;
  return yaw + diff;
}

/** yaw 방향 단위 벡터를 `out` 에 쓴다 (앞 = `(−sin yaw, 0, −cos yaw)`). */
export function forwardOf(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** XZ 거리. */
export function dist2D(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * 상태가 바뀐 뒤 행동까지의 지연 (s) — 사용자 결정 「0.5 ~ 2초, 행동의 무게가 무거울수록 크고 무작위」.
 * `rand` 는 0..1 (기마다 다른 시드에서 뽑는다 — 세 기가 동시에 똑같이 움직이지 않게).
 */
export function reactionDelay(state: AllyStateId, rand: number): number {
  const w = ALLY_STATE_WEIGHT[state] ?? 0;
  const t = w * (1 - ALLY_REACT_JITTER) + rand * ALLY_REACT_JITTER;
  return ALLY_REACT_MIN_S + (ALLY_REACT_MAX_S - ALLY_REACT_MIN_S) * Math.min(1, Math.max(0, t));
}

/** 즉시 적용되는 상태 — 쓰러짐 · 사망 · 잠듦은 반응 지연을 타지 않는다. */
export function isInstantState(state: AllyStateId): boolean {
  return state === 'downed' || state === 'dead' || state === 'dormant' || state === 'aboard';
}
