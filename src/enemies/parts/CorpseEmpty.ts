/**
 * src/enemies/parts/CorpseEmpty.ts — **열어서 다 비운 적 시체는 1초 뒤 땅으로 가라앉아 사라진다** (2026-09-16, 사용자 결정).
 *
 * 이 파일이 답하는 질문: *누가 「이 적 시체는 비었다」를 정하고, 모든 클라이언트가 어떻게 같은 몸을 치우는가.*
 *
 * - 적 시체의 내용물은 클라이언트마다 시드로 굴리고(`Corpse.interact`), 가져간 상태만 호스트가 `cont` 로 나른다. 호스트가
 *   한 번도 열지 않은 시체는 호스트가 비었는지 모른다 — 그래서 **비운 쪽이** 알린다.
 * - 권위(싱글 · 호스트)의 `crate:looted corpse:<id>` → 곧바로 `applyCorpseEmptied` + (세션이면) `ee corpseEmptied` 방송.
 * - 리플리카의 `crate:looted` → 내 몸이 그 시체 가까이 있을 때만 `ecorpseq emptied` 를 호스트에 보낸다 (멀리서 `cont taken`
 *   으로 비는 것을 본 사람까지 보내지 않게). 스스로는 몸을 치우지 않는다 — 호스트의 `ee corpseEmptied` 를 기다린다.
 * - 호스트의 요청 가드는 `shared/buffRules.createBuffGuard` 와 같은 순서다: ① 모양(정수 id · 알려진 죽은 몸 · 수색 자리가 있다)
 *   ② 보낸 사람(스냅샷이 있다) ③ 거리(`CORPSE_EMPTY_REQUEST_REACH_M`, 수평) ④ 요율(보낸 사람별 토큰 버킷). 이미 비운 시체의
 *   중복 요청은 거절이 아니라 무시다 (같은 `cont taken` 을 본 사람이 여럿일 수 있다 — 버킷을 쓰지 않는다).
 * - 적용(`applyCorpseEmptied`, 모든 클라이언트가 같은 식): 수색 자리를 `looted`(빛기둥 · 프롬프트 끝), 몸의 `corpseLife` 를
 *   「지금 + `CORPSE_EMPTY_REMOVE_DELAY_S` + `CORPSE_EMPTY_SINK_S`」로 줄이고 가라앉기(`anim.fade`) 시간을 `CORPSE_EMPTY_SINK_S` 로.
 *   **치우는 것은 원래의 시체 수명 루프다** (`EnemySystem.update` → `Pool.despawn` → 권위는 `ee despawn` + `corpseGone`).
 *   몸마다 수명이 실려 있으므로 호스트가 바뀌어도 새 호스트가 그대로 이어서 치운다.
 * - 열지 않은 시체 · 수색 불가 시체(수색 자리 없음)는 여기를 지나지 않는다 — 예전 그대로 `CORPSE_LIFETIME` 뒤에 사라진다.
 */
import {
  CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_REQUEST_BURST, CORPSE_EMPTY_REQUEST_RATE_MAX, CORPSE_EMPTY_REQUEST_REACH_M,
  CORPSE_EMPTY_SINK_S, type EnemyCorpseRequest, type PeerId,
} from '@/shared';
import type { EnemySystem } from '../EnemySystem';

const CORPSE_PREFIX = 'corpse:';

/**
 * `corpse:<enemyId>` → 적 id. 적의 것이 아니면 null — 튜토리얼 손 시체(`corpse:tut_gear`) · 스모크의 `corpse:smoke-1` 도
 * 같은 접두어를 쓰므로 **숫자만** 적 id 로 본다.
 */
export function corpseEnemyId(containerId: string): number | null {
  if (typeof containerId !== 'string' || !containerId.startsWith(CORPSE_PREFIX)) return null;
  const rest = containerId.slice(CORPSE_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * 모든 클라이언트: 몸 `id` 를 「비운 시체」로 만든다. 죽은 몸이 없거나 이미 비웠으면 false (아무것도 안 한다).
 * 가라앉기가 이미 시작된(수명 끝의 자연스러운 가라앉기) 몸은 수명을 늘리지도, 가라앉기를 되감지도 않는다.
 */
export function applyCorpseEmptied(sys: EnemySystem, id: number): boolean {
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state !== 'dead' || e.corpseEmptied) return false;
  e.corpseEmptied = true;
  const c = sys.corpses.get(id);
  if (c) { c.looted = true; c.hidePillar = true; }
  const life = e.deathTimer + CORPSE_EMPTY_REMOVE_DELAY_S + CORPSE_EMPTY_SINK_S;
  const sinking = e.deathTimer >= e.corpseLife - e.corpseFadeS;
  if (!sinking && life < e.corpseLife) {
    e.corpseLife = life;
    e.corpseFadeS = CORPSE_EMPTY_SINK_S;
  }
  return true;
}

/** 권위: 적용하고, 세션이면 사실을 방송한다. */
export function emptyCorpseAuthority(sys: EnemySystem, id: number): boolean {
  if (!sys.authority || !applyCorpseEmptied(sys, id)) return false;
  if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'corpseEmptied', id }, 'others');
  return true;
}

/** `crate:looted` (모든 클라이언트) — 적 시체 컨테이너가 이 클라이언트에서 비었다. */
export function onCorpseContainerLooted(sys: EnemySystem, containerId: string): void {
  const id = corpseEnemyId(containerId);
  if (id === null) return;
  sys.corpses.markLooted(containerId);
  if (sys.authority) { emptyCorpseAuthority(sys, id); return; }
  const net = sys.ctx.net, p = sys.ctx.player;
  const e = sys.byId.get(id), c = sys.corpses.get(id);
  if (!net || !p || !e || !c || e.state !== 'dead' || e.corpseEmptied) return;
  // 멀리서 남의 `cont taken` 으로 빈 것을 본 사람은 보내지 않는다 — 호스트의 거리 가드와 같은 거리
  const dx = c.position.x - p.position.x, dz = c.position.z - p.position.z;
  if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) return;
  net.send({ t: 'ecorpseq', ev: 'emptied', id }, 'host');
}

interface Bucket { tokens: number; at: number }
/** 보낸 사람별 요율 버킷 — 시스템마다 따로 (스모크가 시스템을 여럿 만들어도 섞이지 않는다). */
const buckets = new WeakMap<EnemySystem, Map<string, Bucket>>();

function spendRequest(sys: EnemySystem, from: string): boolean {
  let map = buckets.get(sys);
  if (!map) { map = new Map(); buckets.set(sys, map); }
  const now = sys.ctx.time;
  let b = map.get(from);
  if (!b) { b = { tokens: CORPSE_EMPTY_REQUEST_BURST, at: now }; map.set(from, b); }
  b.tokens = Math.min(CORPSE_EMPTY_REQUEST_BURST, b.tokens + Math.max(0, now - b.at) * CORPSE_EMPTY_REQUEST_RATE_MAX);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/**
 * 호스트: 클라이언트의 `ecorpseq emptied`. 거절은 `hitGuardStats.corpseEmptyRefused` 만 센다 (거절된 요청은 아무것도 하지
 * 않으므로 스모크가 볼 수 있는 유일한 흔적이다).
 */
export function onCorpseEmptiedRequest(sys: EnemySystem, msg: EnemyCorpseRequest, from: PeerId): void {
  if (!sys.hosting) return;
  const refuse = (): void => { sys.hitGuardStats.corpseEmptyRefused++; };
  // ① 모양
  if (!msg || msg.ev !== 'emptied' || typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) { refuse(); return; }
  const e = sys.byId.get(msg.id), c = sys.corpses.get(msg.id);
  if (!e || !e.active || e.state !== 'dead' || !c) { refuse(); return; }
  if (e.corpseEmptied) return;
  // ② 보낸 사람
  const ref = sys.ctx.net?.getRemotePlayer(from);
  if (!ref) { refuse(); return; }
  // ③ 거리 (수평)
  const dx = c.position.x - ref.position.x, dz = c.position.z - ref.position.z;
  if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) { refuse(); return; }
  // ④ 요율
  if (!spendRequest(sys, from)) { refuse(); return; }
  emptyCorpseAuthority(sys, msg.id);
}
