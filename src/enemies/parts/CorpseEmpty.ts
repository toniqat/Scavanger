/**
 * src/enemies/parts/CorpseEmpty.ts — **an enemy corpse that was opened and emptied sinks into the ground one second after the looting ended** (2026-09-16, user's decision).
 *
 * The question this file answers: *who decides 「this enemy corpse is empty」, and how every client removes the same body.*
 *
 * - An enemy corpse's contents are rolled per client from a seed (`Corpse.interact`) and only the taken state travels, as the host's `cont`. A corpse
 *   the host never opened is one the host cannot know is empty — so **whoever emptied it** says so.
 * - The authority (single player · host) on `crate:looted corpse:<id>` → `markCorpseEmptied` (marks the search finished). A replica's `crate:looted`
 *   sends `ecorpseq emptied` to the host only when my body stands near that corpse (so that somebody who merely watched it empty from far away
 *   through a `cont taken` does not send one). It never removes the body itself — it waits for the host's `ee corpseEmptied`.
 * - 2026-09-16 (2nd pass): **it is not removed while anybody holds that corpse's window open**. Viewers are judged by `shared/corpseViewers`
 *   (`cviewq open|close`, the host keeps them per corpse), and the moment it is empty and nobody is looking — at once, or on the frame the last
 *   person closes (`updateEmptyCorpses`) — the authority shortens the lifetime (`releaseCorpse`) and in a session broadcasts `ee corpseEmptied`.
 *   So sinking is 「`CORPSE_EMPTY_REMOVE_DELAY_S` after the window closed」. Even an already-shortened corpse has its lifetime held while **my**
 *   window shows it (a broadcast and my own close that crossed).
 * - The host's request guard is in the same order as `shared/buffRules.createBuffGuard`: ① shape (an integer id · a known dead body · it has a
 *   search slot) ② sender (a snapshot exists) ③ distance (`CORPSE_EMPTY_REQUEST_REACH_M`, horizontal) ④ rate (a token bucket per sender). A
 *   duplicate request for a corpse already emptied is ignored, not refused (several people can have seen the same `cont taken` — it spends no bucket).
 * - Applying it (`releaseCorpse`, the same formula on every client): the body's `corpseLife` is cut to 「now + `CORPSE_EMPTY_REMOVE_DELAY_S` +
 *   `CORPSE_EMPTY_SINK_S`」 and the sink (`anim.fade`) time to `CORPSE_EMPTY_SINK_S`.
 *   **The removal itself is the ordinary corpse lifetime loop** (`EnemySystem.update` → `Pool.despawn` → on the authority `ee despawn` + `corpseGone`).
 *   The lifetime rides on the body, so a new host carries on removing it exactly where the old one left off.
 * - A corpse never opened, and one that cannot be searched (no search slot), does not pass through here — it disappears after `CORPSE_LIFETIME`, as before.
 */
import {
  CORPSE_EMPTY_REMOVE_DELAY_S, CORPSE_EMPTY_REQUEST_BURST, CORPSE_EMPTY_REQUEST_RATE_MAX, CORPSE_EMPTY_REQUEST_REACH_M,
  CORPSE_EMPTY_SINK_S, CorpseViewTracker, type EnemyCorpseRequest, type PeerId,
} from '@/shared';
import type { Enemy } from '../Enemy';
import type { EnemySystem } from '../EnemySystem';

const CORPSE_PREFIX = 'corpse:';

/**
 * `corpse:<enemyId>` → the enemy id. null when it is not an enemy's — the tutorial's hand-placed corpse (`corpse:tut_gear`) and
 * the smoke's `corpse:smoke-1` share the prefix, so **only digits** count as an enemy id.
 */
export function corpseEnemyId(containerId: string): number | null {
  if (typeof containerId !== 'string' || !containerId.startsWith(CORPSE_PREFIX)) return null;
  const rest = containerId.slice(CORPSE_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) ? id : null;
}

/* ── viewers (`shared/corpseViewers`) ───────────────────────────────────────────────────────────────────── */

/** One tracker per system (a smoke making several systems never mixes them up). */
const viewerTrackers = new WeakMap<EnemySystem, CorpseViewTracker>();

/** Once in `init`: builds the tracker that owns enemy corpses (`corpse:<digits>`). The returned function releases it (`dispose`). */
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

/** Is anybody at all looking at enemy corpse `id` (with no tracker — a smoke's bare system — nobody is). */
function isViewed(sys: EnemySystem, id: number): boolean {
  const t = viewerTrackers.get(sys);
  return !!t && t.isViewed(CORPSE_PREFIX + id);
}

/* ── marking · releasing ────────────────────────────────────────────────────────────────────────────────── */

/** Marks the search finished (the light pillar and the prompt go) and `corpseEmptied`. false with no dead body, or when it was marked already. */
function markCorpseEmptied(sys: EnemySystem, e: Enemy): boolean {
  if (e.corpseEmptied) return false;
  e.corpseEmptied = true;
  const c = sys.corpses.get(e.id);
  if (c) { c.looted = true; c.hidePillar = true; }
  return true;
}

/**
 * Cuts the lifetime to 「now + the delay + the sink」 (exactly once). A body already sinking (the natural sink at the end of its
 * lifetime) has neither its lifetime extended nor its sink rewound.
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

/** Authority: cuts the lifetime and, in a session, broadcasts the fact. */
function releaseByAuthority(sys: EnemySystem, e: Enemy): void {
  if (!releaseCorpse(e)) return;
  if (sys.hosting) sys.ctx.net!.send({ t: 'ee', ev: 'corpseEmptied', id: e.id }, 'others');
}

/**
 * Every client (a replica from `ee corpseEmptied`): makes body `id` 「an emptied corpse nobody is looking at」 — the mark plus the
 * shortened lifetime. false with no dead body, or when it was shortened already (nothing happens).
 */
export function applyCorpseEmptied(sys: EnemySystem, id: number): boolean {
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state !== 'dead' || e.corpseReleased) return false;
  markCorpseEmptied(sys, e);
  return releaseCorpse(e);
}

/**
 * Authority: marks the corpse emptied and, when nobody is looking right now, releases and broadcasts it at once (with a viewer,
 * `updateEmptyCorpses` does it the moment they close). false with no dead body, when it was emptied already, or off the authority.
 */
export function emptyCorpseAuthority(sys: EnemySystem, id: number): boolean {
  if (!sys.authority) return false;
  const e = sys.byId.get(id);
  if (!e || !e.active || e.state !== 'dead' || !markCorpseEmptied(sys, e)) return false;
  if (!isViewed(sys, id)) releaseByAuthority(sys, e);
  return true;
}

/**
 * Every frame (`EnemySystem.update`, before the lifetime loop): tidies the viewer table and —
 *  · Authority: releases the emptied-but-still-held corpses that nobody is looking at any more.
 *  · Everyone: even an already-released corpse has its lifetime held above 「now + the delay + the sink」 while **my** window shows it.
 * With no emptied corpse it builds no string.
 */
export function updateEmptyCorpses(sys: EnemySystem): void {
  const t = viewerTrackers.get(sys);
  if (!t) return;
  t.update();
  let mine: number | null | undefined;   // the enemy corpse my own window is showing — resolved once, only when it is needed
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

/** `crate:looted` (every client) — an enemy corpse container went empty on this client. */
export function onCorpseContainerLooted(sys: EnemySystem, containerId: string): void {
  const id = corpseEnemyId(containerId);
  if (id === null) return;
  sys.corpses.markLooted(containerId);
  if (sys.authority) { emptyCorpseAuthority(sys, id); return; }
  const net = sys.ctx.net, p = sys.ctx.player;
  const e = sys.byId.get(id), c = sys.corpses.get(id);
  if (!net || !p || !e || !c || e.state !== 'dead' || e.corpseEmptied) return;
  // somebody who watched it empty from far away through another's `cont taken` does not send — the same distance as the host's guard
  const dx = c.position.x - p.position.x, dz = c.position.z - p.position.z;
  if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) return;
  net.send({ t: 'ecorpseq', ev: 'emptied', id }, 'host');
}

interface Bucket { tokens: number; at: number }
/** Rate buckets per sender — one set per system (a smoke making several systems never mixes them up). */
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
 * Host: a client's `ecorpseq emptied`. A refusal only bumps `hitGuardStats.corpseEmptyRefused` (a refused request does nothing
 * else, so that counter is the only trace a smoke can see).
 */
export function onCorpseEmptiedRequest(sys: EnemySystem, msg: EnemyCorpseRequest, from: PeerId): void {
  if (!sys.hosting) return;
  const refuse = (): void => { sys.hitGuardStats.corpseEmptyRefused++; };
  // ① shape
  if (!msg || msg.ev !== 'emptied' || typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) { refuse(); return; }
  const e = sys.byId.get(msg.id), c = sys.corpses.get(msg.id);
  if (!e || !e.active || e.state !== 'dead' || !c) { refuse(); return; }
  if (e.corpseEmptied) return;
  // ② sender
  const ref = sys.ctx.net?.getRemotePlayer(from);
  if (!ref) { refuse(); return; }
  // ③ distance (horizontal)
  const dx = c.position.x - ref.position.x, dz = c.position.z - ref.position.z;
  if (dx * dx + dz * dz > CORPSE_EMPTY_REQUEST_REACH_M * CORPSE_EMPTY_REQUEST_REACH_M) { refuse(); return; }
  // ④ rate
  if (!spendRequest(sys, from)) { refuse(); return; }
  emptyCorpseAuthority(sys, msg.id);
}
