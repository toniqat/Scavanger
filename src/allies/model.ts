/**
 * src/allies/model.ts — the **vocabulary** of android squadmates. It holds no state (the `model.ts` + `parts/*.ts`
 * contract of CLAUDE.md §4.1).
 *
 * What lives here: the FSM priorities · the reaction-delay formula · scratch vectors · the coordinate convention
 * (forward = `(−sin yaw, 0, −cos yaw)`) · Korean lines · the kinds of order and request. The body itself is `Ally` in
 * `parts/Body.ts`, and `parts/*` does the deciding.
 */
import * as THREE from 'three';
import {
  ALLY_REACT_JITTER, ALLY_REACT_MAX_S, ALLY_REACT_MIN_S, ALLY_STATE_WEIGHT,
} from '@/shared';
import type { AllyStateId, PeerId } from '@/shared';

/**
 * Priority of an FSM proposal — an **order**, not a balance number, so it lives here and not in csv (the user's
 * decision's own ranking, carried over as it stands: death/downed > carrying > rescue > combat > handing over > the
 * extraction call/boarding > junk dropping > an ordered pickup > movement/`주의`/`앞장` > autonomous looting >
 * following > idling). On a tie the proposal that came first wins.
 */
export const PRIO = {
  idle: 0,
  /**
   * Outside the harness = it goes back to the squad leader · inside the harness = the free search (2026-09-16). They
   * share one rank, so `Fsm.decide` proposes exactly one of the two.
   */
  follow: 5,
  roam: 5,
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

/**
 * The kinds of request (only one is taken — first one wins). It folds the inventory request `ItemRequestKind` and the
 * comms wheel onto one axis.
 */
export type AllyRequestKind = 'heal' | 'shield' | 'ammo' | 'item' | 'crate' | 'extract' | 'contract';

/** The one request the squad has raised (first one wins; others are ignored for `ALLY_REQUEST_COOLDOWN_S`). */
export interface AllyRequest {
  kind: AllyRequestKind;
  /** Who requested it (locally `ctx.net.localId ?? ALLY_LOCAL_PEER`). */
  by: PeerId;
  /** The requester's position (a snapshot copy — it has to be a value that is safe to keep). */
  at: THREE.Vector3;
  /** For an item request, its def id / ammo type. */
  defId: string | null;
  ammoType: string | null;
  /**
   * For a **crate** ping, the id of the container it names (`WorldRef.getLootContainers` — the same id
   * `peekContainerItems` · `takeContainerItemFor` use; `PingMessage.containerId` carries it over the wire). Null on an
   * **item** ping: that one names a thing on the ground, and `parts/Loot` finds it by position (`PickupsRef.findNear`).
   */
  targetId: string | null;
  /** The `ctx.time` the request arrived. */
  time: number;
  /** Id of the android that took this request (null while none has). */
  claimedBy: string | null;
}

/** Korean lines — it says in chat when it has none (user's decision 「없으면 채팅으로 없다고 함」). */
export const CHAT_KO = {
  noHeal: '회복 아이템이 없다.',
  noShield: '실드 충전기가 없다.',
  noAmmo: (label: string) => `${label} 탄약이 없다.`,
  noExtract: '탈출구를 찾지 못했다.',
  noContract: '계약 목표를 찾지 못했다.',
  noItem: '건넬 만한 물건이 없다.',
  wantExtract: '탈출해야 한다!',
  /* 2026-09-16 (agreeing to a ping) — one line saying it took the PC's ping (`Ping.say` stops the same sentence
   * from repeating). */
  agreeEnemy: '적 확인. 요격한다.',
  agreeExtract: '그 탈출구로 간다.',
  agreeCrate: '그 상자를 확인한다.',
  cantReach: '거기까진 못 가겠다.',
} as const;

/* ── Scratch (never reallocated per frame — CLAUDE.md §4.1) ──────────────────────────── */
export const _v1 = new THREE.Vector3();
export const _v2 = new THREE.Vector3();
export const _v3 = new THREE.Vector3();
export const _v4 = new THREE.Vector3();
export const _v5 = new THREE.Vector3();
export const _v6 = new THREE.Vector3();

/**
 * The yaw looking from `from` toward `to`. This is the **remote-avatar convention** — body forward =
 * `(−sin yaw, 0, −cos yaw)` (`player/CameraRig.getForward`). Its sign is the opposite of the enemy AI's `yawTo`, so
 * that one must not be copied over as it stands.
 */
export function yawToward(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Turns `yaw` toward `target` by at most `rate × dt`. */
export function turnToward(yaw: number, target: number, rate: number, dt: number): number {
  let diff = target - yaw;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const max = rate * dt;
  if (diff > max) diff = max;
  else if (diff < -max) diff = -max;
  return yaw + diff;
}

/** Writes the unit vector of `yaw` into `out` (forward = `(−sin yaw, 0, −cos yaw)`). */
export function forwardOf(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** XZ distance. */
export function dist2D(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The delay (s) between a state change and acting on it — user's decision 「0.5 ~ 2초, 행동의 무게가 무거울수록 크고 무작위」.
 * `rand` is 0..1 (drawn from a per-unit seed, so three units never move identically at the same moment).
 */
export function reactionDelay(state: AllyStateId, rand: number): number {
  const w = ALLY_STATE_WEIGHT[state] ?? 0;
  const t = w * (1 - ALLY_REACT_JITTER) + rand * ALLY_REACT_JITTER;
  return ALLY_REACT_MIN_S + (ALLY_REACT_MAX_S - ALLY_REACT_MIN_S) * Math.min(1, Math.max(0, t));
}

/** States applied instantly — downed · dead · dormant · aboard do not go through the reaction delay. */
export function isInstantState(state: AllyStateId): boolean {
  return state === 'downed' || state === 'dead' || state === 'dormant' || state === 'aboard';
}
