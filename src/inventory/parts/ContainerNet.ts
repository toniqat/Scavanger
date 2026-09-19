/**
 * src/inventory/parts/ContainerNet.ts — **the host-authoritative path of a container take** (Phase 7).
 *
 * In single player picking an item out of a crate applies at once, but in multiplayer the host is the judge:
 * a client sends `contq take` and waits for `cont taken` / `cont denied` (`'pending'` in `OpResult`).
 * This file holds all of it — that queue (`pendingTakes`) · the timeout · the host-side validation · applying another member's take.
 */
import type {
  ContainerMessage, ContainerRequest, PeerId as NetPeerId,
} from '@/shared';
import { Container } from '../Container';
import {
  TAKE_REQUEST_TIMEOUT, type DropTarget, type ItemLocation, type OpResult,
} from '../model';
import type { InventorySystem } from '../InventorySystem';

/** Multiplayer client: every container → player move is a request to the host. */
export function needsTakeRequest(sys: InventorySystem, from: ItemLocation): boolean {
  return from.kind === 'grid' && from.grid === 'container' && sys.ctx.isMultiplayer && !sys.ctx.isAuthority;
}

/** Multiplayer host: applies takes itself and broadcasts them. */
export function isNetAuthority(sys: InventorySystem): boolean { return sys.ctx.isMultiplayer && sys.ctx.isAuthority; }

export function isContainerLoc(sys: InventorySystem, loc: ItemLocation): boolean { return loc.kind === 'grid' && loc.grid === 'container'; }

/** Multiplayer: nothing may be put INTO a container (only takes are shared), so container-bound drops are refused. */
export function refusesIntoContainer(sys: InventorySystem, from: ItemLocation, target: DropTarget): boolean {
  if (!sys.ctx.isMultiplayer) return false;
  if (target.kind === 'grid' && target.grid === 'container' && !sys.isContainerLoc(from)) return true;
  return false;
}

/**
 * Gate for a container → player move of `qty` units (null = the whole stack) of `uid`: an unsearched item is refused;
 * a multiplayer client sends `contq take` and replays `run` on `cont taken` (`'pending'`); the host / single-player
 * runs it now and — in multiplayer — records + broadcasts what actually left the container.
 */
export function guardedTake(sys: InventorySystem, uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult {
  if (sys.isItemLocked(uid, from)) return 'fail';
  if (sys.needsTakeRequest(from)) return sys.requestTake(uid, from, qty, run);
  return sys.trackTake(uid, from, run);
}

export function requestTake(sys: InventorySystem, uid: string, from: ItemLocation, qty: number | null, run: () => OpResult): OpResult {
  const c = sys.activeContainer;
  const net = sys.ctx.net;
  const p = c?.grid.get(uid);
  if (!c || !p || !net) return 'fail';
  const idx = c.indexOf(uid);
  if (idx < 0) return 'fail';
  if (sys.pendingTakes.some((t) => t.uid === uid)) return 'noop';
  const n = Math.max(1, Math.min(p.item.qty, Math.floor(qty ?? p.item.qty)));
  sys.pendingTakes.push({ containerId: c.id, idx, qty: n, uid, from, run, sentAt: sys.ctx.time });
  net.send({ t: 'contq', ev: 'take', id: c.id, idx, qty: n }, 'host');
  sys.ui?.refresh();
  return 'pending';
}

/**
 * Run a container take now (host / single-player). The multiplayer host records + broadcasts the units that left its
 * copy; every local take also reports `container:itemTaken {live: true, byLocal: true}` so the same consumers see
 * my own loot and a squad mate's through one event.
 */
export function trackTake(sys: InventorySystem, uid: string, from: ItemLocation, run: () => OpResult): OpResult {
  const c = sys.activeContainer;
  if (!c || !sys.isContainerLoc(from)) return run();
  const idx = c.indexOf(uid);
  const before = c.grid.get(uid)?.item.qty ?? 0;
  const r = run();
  const after = c.grid.get(uid)?.item.qty ?? 0;
  const removed = before - after;
  if (idx < 0 || removed <= 0) return r;
  if (sys.isNetAuthority()) sys.announceTake(c, idx, removed);
  const me = sys.ctx.isMultiplayer ? sys.ctx.net?.localId ?? null : null;
  sys.emitItemTaken(c.id, idx, uid, removed, after, me, true);
  return r;
}

/**
 * `by` (2026-09-15, android squadmates): the id of the body that took it — omitted it is **me**, as it always was. An android
 * take carries that unit's id (the receiving side sees `msg.by !== localId`, so it rides the 「somebody else took it」 path unchanged — no new branch appears).
 */
export function announceTake(sys: InventorySystem, c: Container, idx: number, qty: number, by?: string): void {
  const net = sys.ctx.net;
  if (!net || !net.localId) return;
  c.recordTaken(idx, qty);
  net.send({
    t: 'cont', ev: 'taken', id: c.id, idx, qty, by: by ?? net.localId,
    rem: c.remainingAt(idx), seq: sys.containers.nextTakeSeq(c.id),
  }, 'others');
}

/**
 * Phase 10 — the one place `container:itemTaken` is emitted. `live` separates a real-time take (someone is looting
 * this crate right now → animate) from a `cont sync` / pending catch-up (silent). A live take by **another** member
 * also marks the tile so `GridView.refresh` animates it out instead of deleting it.
 */
export function emitItemTaken(sys: InventorySystem, containerId: string, idx: number, uid: string | null, qty: number, remaining: number, by: NetPeerId | null, live: boolean): void {
  const net = sys.ctx.net;
  const byLocal = by === null || (!!net?.localId && by === net.localId);
  const byName = by && !byLocal ? net?.getLobbyPlayer?.(by)?.name ?? null : null;
  if (live && !byLocal && uid && sys.activeContainer?.id === containerId) sys.ui?.vanishContainerItem(uid);
  sys.ctx.bus.emit('container:itemTaken', { containerId, idx, uid, qty, remaining, by, byName, byLocal, live });
}

/** Uids of container items whose take is waiting for the host (UI pulse). */
export function pendingTakeUids(sys: InventorySystem): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of sys.pendingTakes) out.add(t.uid);
  return out;
}

export function expirePendingTakes(sys: InventorySystem): void {
  if (sys.pendingTakes.length === 0) return;
  const now = sys.ctx.time;
  const keep = sys.pendingTakes.filter((t) => now - t.sentAt < TAKE_REQUEST_TIMEOUT);
  if (keep.length === sys.pendingTakes.length) return;
  sys.pendingTakes = keep;
  sys.ui?.refresh();
}

/** Host → all `cont` (taken / denied / sync). Only the lobby host is trusted. */
export function onContainerMessage(sys: InventorySystem, msg: ContainerMessage, from: NetPeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer) return;
  const hostId = net.lobby?.hostId;
  if (hostId && from !== hostId) return;
  if (msg.ev === 'taken') {
    // Phase 10: `seq` is the host's per-container take counter — a duplicate / out-of-order message is dropped
    // (it would otherwise remove the same units twice and animate a tile that is already gone).
    if (!sys.containers.acceptTakeSeq(msg.id, msg.seq)) return;
    if (msg.by === net.localId) sys.resolvePendingTake(msg.id, msg.idx, msg.qty);
    else sys.applyRemoteTaken(msg.id, msg.idx, msg.qty, msg.by, msg.rem);
  } else if (msg.ev === 'denied') {
    const i = sys.pendingTakes.findIndex((t) => t.containerId === msg.id && t.idx === msg.idx);
    if (i < 0) return;
    const [t] = sys.pendingTakes.splice(i, 1);
    sys.ctx.bus.emit('audio:play', { id: 'ui_error' });
    sys.ctx.bus.emit('ui:notify', { text: '다른 대원이 먼저 가져갔습니다', kind: 'warning', duration: 1.6 });
    sys.ui?.refresh();
    sys.ui?.shakeItem(t.uid, t.from);
  } else if (msg.ev === 'sync') {
    const changed = sys.containers.applySync(msg.items);
    for (const id of changed) { const c = sys.containers.get(id); if (c) sys.checkLootedFor(c); }
    if (changed.length > 0) sys.ui?.refresh();
  }
}

/** My `contq take` was confirmed: replay the move (the item may sit in a container whose window closed meanwhile). */
export function resolvePendingTake(sys: InventorySystem, id: string, idx: number, qty: number): void {
  const i = sys.pendingTakes.findIndex((t) => t.containerId === id && t.idx === idx);
  if (i < 0) { sys.applyRemoteTaken(id, idx, qty, sys.ctx.net?.localId ?? null); return; }
  const [t] = sys.pendingTakes.splice(i, 1);
  const c = sys.containers.get(id);
  if (!c) { sys.containers.recordPending(id, idx, qty); return; }
  const before = c.remainingAt(idx);
  const prev = sys.activeContainer;
  sys.activeContainer = c;
  let r: OpResult = 'fail';
  try { r = t.run(); } finally { sys.activeContainer = prev; }
  const removed = before - c.remainingAt(idx);
  c.recordTaken(idx, Math.max(removed, 0));
  if (removed < qty) {
    // the replay took less than the host granted (bag changed meanwhile): stay consistent with the host's copy
    if (r !== 'ok') console.warn(`[Inventory] confirmed take of ${id}#${idx} could not be applied (${r})`);
    c.applyTaken(idx, qty - removed);
    c.taken.set(idx, (c.taken.get(idx) ?? 0) - (qty - removed)); // applyTaken recorded it again
  }
  if (r === 'ok') sys.ctx.bus.emit('audio:play', { id: 'ui_pickup' });
  sys.emitItemTaken(id, idx, t.uid, qty, c.remainingAt(idx), sys.ctx.net?.localId ?? null, true);
  sys.checkLootedFor(c);
  sys.ui?.refresh();
}

/**
 * Someone else's take was confirmed: remove it from my copy (or remember it for a container I have not opened).
 * Phase 10: the uid is read **before** `applyTaken` drops the placement and reported as a live take, so the tile
 * animates out and the HUD can name the looter.
 */
export function applyRemoteTaken(sys: InventorySystem, id: string, idx: number, qty: number, by: NetPeerId | null, hostRemaining?: number): void {
  const c = sys.containers.get(id);
  if (!c) { sys.containers.recordPending(id, idx, qty); return; }
  const uid = c.uidAt(idx) ?? null;
  let removed = c.applyTaken(idx, qty);
  // `cont taken.rem` (Phase 10) is the host's own remaining count: converge on it when this copy still holds more
  if (typeof hostRemaining === 'number' && Number.isFinite(hostRemaining) && hostRemaining >= 0) {
    const extra = c.remainingAt(idx) - Math.floor(hostRemaining);
    if (extra > 0) removed += c.applyTaken(idx, extra);
  }
  if (removed <= 0) return;
  sys.emitItemTaken(id, idx, uid, removed, c.remainingAt(idx), by, true);
  sys.checkLootedFor(c);
  if (sys._open) sys.ui?.refresh();
}

/** Host: validate a peer's `contq take` against its own copy (rolled on demand for world crates) and broadcast. */
export function onContainerRequest(sys: InventorySystem, msg: ContainerRequest, from: NetPeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.isNetAuthority()) return;
  if (msg.ev === 'sync') { net.send({ t: 'cont', ev: 'sync', items: sys.containers.takenWire() }, from); return; }
  const qty = Math.floor(msg.qty);
  const c = sys.containers.get(msg.id) ?? sys.materializeCrate(msg.id);
  const allowed = Number.isFinite(qty) && qty >= 1 && (c
    ? c.uidAt(msg.idx) !== undefined && qty <= c.remainingAt(msg.idx)
    : sys.containers.pendingTakenOf(msg.id, msg.idx) === 0);
  if (!allowed) { net.send({ t: 'cont', ev: 'denied', id: msg.id, idx: msg.idx }, from); return; }
  if (c) {
    const uid = c.uidAt(msg.idx) ?? null;
    const removed = c.applyTaken(msg.idx, qty);
    if (removed > 0) sys.emitItemTaken(msg.id, msg.idx, uid, removed, c.remainingAt(msg.idx), from, true);
    sys.checkLootedFor(c);
    if (sys._open) sys.ui?.refresh();
  } else {
    sys.containers.recordPending(msg.id, msg.idx, qty);
  }
  net.send({
    t: 'cont', ev: 'taken', id: msg.id, idx: msg.idx, qty, by: from,
    ...(c ? { rem: c.remainingAt(msg.idx) } : {}), seq: sys.containers.nextTakeSeq(msg.id),
  }, 'others');
}

/** Host: a world crate it never opened can still be rolled (deterministic seed ^ id) to validate a request. */
export function materializeCrate(sys: InventorySystem, id: string): Container | null {
  const crate = sys.ctx.world?.getCrates().find((k) => k.id === id);
  if (!crate) return null;
  // 2026-09-16: the same roll rules as the opening path (a map crate is always undefined, but it is kept as one rule)
  return sys.containers.getOrCreate(id, crate.tier, crate.position, sys.loot, sys.missionSeed, sys.ctx.missionPlanet,
    sys.ctx.world?.crateLootOpts?.(id));
}

/** Ask the (new) host for every taken map (host migration, rejoin fallback). */
export function requestContainerSync(sys: InventorySystem): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer || sys.ctx.isAuthority) return;
  sys.pendingTakes = [];
  sys.containers.resetTakeSeq(); // the new host counts its takes from 1 again
  net.send({ t: 'contq', ev: 'sync' }, 'host');
}
