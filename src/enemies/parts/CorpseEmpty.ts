/**
 * src/enemies/parts/CorpseEmpty.ts — **열어서 다 비운 적 시체는 루팅이 끝나고 1초 뒤 땅으로 가라앉아 사라진다** (2026-09-16, 사용자 결정).
 *
 * 이 파일이 답하는 질문: *누가 「이 적 시체는 비었다」를 정하고, 모든 클라이언트가 어떻게 같은 몸을 치우는가.*
 *
 * - 적 시체의 내용물은 클라이언트마다 시드로 굴리고(`Corpse.interact`), 가져간 상태만 호스트가 `cont` 로 나른다. 호스트가
 *   한 번도 열지 않은 시체는 호스트가 비었는지 모른다 — 그래서 **비운 쪽이** 알린다.
 * - 권위(싱글 · 호스트)의 `crate:looted corpse:<id>` → `markCorpseEmptied`(수색 끝 표시). 리플리카의 `crate:looted` → 내 몸이 그
 *   시체 가까이 있을 때만 `ecorpseq emptied` 를 호스트에 보낸다 (멀리서 `cont taken` 으로 비는 것을 본 사람까지 보내지 않게).
 *   스스로는 몸을 치우지 않는다 — 호스트의 `ee corpseEmptied` 를 기다린다.
 * - 2026-09-16 (2차): **누가 그 시체 창을 열어 두고 있는 동안은 치우지 않는다**. 보는 사람 판정은 `shared/corpseViewers`
 *   (`cviewq open|close`, 호스트가 시체별로 든다)이고, 권위는 비었고 아무도 보지 않는 순간 — 곧바로, 또는 마지막 사람이 닫는
 *   프레임에(`updateEmptyCorpses`) — 수명을 줄이고(`releaseCorpse`) 세션이면 `ee corpseEmptied` 를 방송한다. 그래서 가라앉기는
 *   「창을 닫고 `CORPSE_EMPTY_REMOVE_DELAY_S` 뒤」다. 이미 줄인 시체라도 **내** 창이 그것을 보여 주는 동안은 수명을 붙잡는다
 *   (방송과 내 닫기가 엇갈린 경우).
 * - 호스트의 요청 가드는 `shared/buffRules.createBuffGuard` 와 같은 순서다: ① 모양(정수 id · 알려진 죽은 몸 · 수색 자리가 있다)
 *   ② 보낸 사람(스냅샷이 있다) ③ 거리(`CORPSE_EMPTY_REQUEST_REACH_M`, 수평) ④ 요율(보낸 사람별 토큰 버킷). 이미 비운 시체의
 *   중복 요청은 거절이 아니라 무시다 (같은 `cont taken` 을 본 사람이 여럿일 수 있다 — 버킷을 쓰지 않는다).
 * - 적용(`releaseCorpse`, 모든 클라이언트가 같은 식): 몸의 `corpseLife` 를 「지금 + `CORPSE_EMPTY_REMOVE_DELAY_S` +
 *   `CORPSE_EMPTY_SINK_S`」로 줄이고 가라앉기(`anim.fade`) 시간을 `CORPSE_EMPTY_SINK_S` 로.
 *   **치우는 것은 원래의 시체 수명 루프다** (`EnemySystem.update` → `Pool.despawn` → 권위는 `ee despawn` + `corpseGone`).
 *   몸마다 수명이 실려 있으므로 호스트가 바뀌어도 새 호스트가 그대로 이어서 치운다.
 * - 열지 않은 시체 · 수색 불가 시체(수색 자리 없음)는 여기를 지나지 않는다 — 예전 그대로 `CORPSE_LIFETIME` 뒤에 사라진다.
 */
import {
  CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_REQUEST_BURST, CORPSE_EMPTY_REQUEST_RATE_MAX, CORPSE_EMPTY_REQUEST_REACH_M,
  CORPSE_EMPTY_SINK_S, CorpseViewTracker, type EnemyCorpseRequest, type PeerId,
} from '@/shared';
import type { Enemy } from '../Enemy';
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

/* ── 보는 사람 (`shared/corpseViewers`) ─────────────────────────────────────────────────────────────────── */

/** 시스템마다 추적기 하나 (스모크가 시스템을 여럿 만들어도 섞이지 않는다). */
const viewerTrackers = new WeakMap<EnemySystem, CorpseViewTracker>();

/** `init` 에서 한 번: 적 시체(`corpse:<숫자>`)를 맡는 추적기를 만든다. 돌려주는 함수가 해제한다 (`dispose`). */
export function hookCorpseViews(sys: EnemySystem): () => void {
  let t = viewerTrackers.get(sys);
  if (!t) {
    t = new CorpseViewTracker(sys.ctx, {
      matches: (id) => corpseEnemyId(id) !== null,
      positionOf: (id) => {
        const n = corpseEnemyId(id);
        return n === null ? null : sys.corpses.get(n)?.position ?? null;
      },
    });
    viewerTrackers.set(sys, t);
  }
  const tracker = t;
  return () => { tracker.dispose(); if (viewerTrackers.get(sys) === tracker) viewerTrackers.delete(sys); };
}

/** 누가든 적 시체 `id` 를 보고 있는가 (추적기가 없으면 — 스모크의 맨 시스템 — 아무도 안 본다). */
function isViewed(sys: EnemySystem, id: number): boolean {
  const t = viewerTrackers.get(sys);
  return !!t && t.isViewed(CORPSE_PREFIX + id);
}

/* ── 표시 · 풀기 ────────────────────────────────────────────────────────────────────────────────────────── */

/** 수색 끝 표시(빛기둥 · 프롬프트 끝)와 `corpseEmptied`. 죽은 몸이 없거나 이미 표시했으면 false. */
function markCorpseEmptied(sys: EnemySystem, e: Enemy): boolean {
  if (e.corpseEmptied) return false;
  e.corpseEmptied = true;
  const c = sys.corpses.get(e.id);
  if (c) { c.looted = true; c.hidePillar = true; }
  return true;
}

/**
 * 수명을 「지금 + 지연 + 가라앉기」로 줄인다 (한 번). 가라앉기가 이미 시작된(수명 끝의 자연스러운 가라앉기) 몸은 수명을 늘리지도,
 * 가라앉기를 되감지도 않는다.
 */
function releaseCorpse(e: Enemy): boolean {
  if (e.corpseReleased) return false;
  e.corpseReleased = true;
  const life = e.deathTimer + CORPSE_EMPTY_REMOVE_DELAY_S + CORPSE_EMPTY_SINK_S;
  const sinking = e.deathTimer >= e.corpseLife - e.corpseFadeS;
  if (!sinking && life < e.corpseLife) {
    e.corpseLife = life;
    e.corpseFadeS = CORPSE_EMPTY_SINK_S;
  }
  return true;
}

/** 권위: 수명을 줄이고, 세션이면 사실을 방송한다. */
function releaseByAuthority(sys: EnemySystem, e: Enemy): void {
  if (!releaseCorpse(e)) return;
  if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'corpseEmptied', id: e.id }, 'others');
}

/**
 * 모든 클라이언트 (리플리카는 `ee corpseEmptied`): 몸 `id` 를 「비웠고 아무도 보지 않는 시체」로 만든다 — 표시 + 수명 줄이기.
 * 죽은 몸이 없거나 이미 줄였으면 false (아무것도 안 한다).
 */
export function applyCorpseEmptied(sys: EnemySystem, id: number): boolean {
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state !== 'dead' || e.corpseReleased) return false;
  markCorpseEmptied(sys, e);
  return releaseCorpse(e);
}

/**
 * 권위: 비운 시체로 표시하고, 지금 아무도 보지 않으면 곧바로 풀어 방송한다 (누가 보고 있으면 `updateEmptyCorpses` 가 닫는 순간).
 * 죽은 몸이 없거나 이미 비웠거나 권위가 아니면 false.
 */
export function emptyCorpseAuthority(sys: EnemySystem, id: number): boolean {
  if (!sys.authority) return false;
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state !== 'dead' || !markCorpseEmptied(sys, e)) return false;
  if (!isViewed(sys, id)) releaseByAuthority(sys, e);
  return true;
}

/**
 * 매 프레임 (`EnemySystem.update`, 수명 루프 앞): 보는 사람 표를 정리하고 —
 *  · 권위: 비었지만 아직 붙잡힌 시체 가운데 아무도 보지 않게 된 것을 푼다.
 *  · 모두: 이미 풀린 시체라도 **내** 창이 보여 주는 동안은 수명을 「지금 + 지연 + 가라앉기」 밑으로 줄지 않게 붙잡는다.
 * 비운 시체가 없으면 문자열을 만들지 않는다.
 */
export function updateEmptyCorpses(sys: EnemySystem): void {
  const t = viewerTrackers.get(sys);
  if (!t) return;
  t.update();
  let mine: number | null | undefined;   // 내 창이 보여 주는 적 시체 — 필요할 때 한 번만 푼다
  for (let i = 0; i < sys.active.length; i++) {
    const e = sys.active[i];
    if (e.state !== 'dead' || !e.corpseEmptied) continue;
    if (!e.corpseReleased) {
      if (sys.authority && !t.isViewed(CORPSE_PREFIX + e.id)) releaseByAuthority(sys, e);
      continue;
    }
    if (mine === undefined) { const v = t.localViewing; mine = v === null ? null : corpseEnemyId(v); }
    if (mine !== e.id) continue;
    const hold = e.deathTimer + CORPSE_EMPTY_REMOVE_DELAY_S + CORPSE_EMPTY_SINK_S;
    if (hold > e.corpseLife) e.corpseLife = hold;
  }
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
