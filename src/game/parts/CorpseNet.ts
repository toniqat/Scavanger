/**
 * src/game/parts/CorpseNet.ts — **player corpse creation and sync** (`pcorpse` / `pcorpseq`, 2026-09-09).
 *
 * The question this file answers: *who makes a corpse, and how somebody who joined late learns about it.*
 *
 * - `spawn` is sent to `'all'` by **the dead player themselves** — only their own inventory is the truth, so nobody
 *   can speak for them. `'all'` echoes back to the sender too, but the corpse id dedupes it, so it spawns only once.
 * - The host holds **other people's corpses with their `items` too** and answers a `pcorpseq sync` / `flow rejoined`
 *   with `pcorpse sync` (the same shape as the late-join pattern in `stratagems/parts/Wire`).
 * - **Taking** the items inside a corpse has nothing to do with this file — it rides `cont` / `contq` exactly as a
 *   crate does.
 */
import * as THREE from 'three';
import type { CorpseMessage, ItemInstance, PeerId, PlayerCorpseWire } from '@/shared';
import { normalizeMealQuality } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** The stand-in `PeerId` for single player (the contract: solo is `'sp'`). */
export const SOLO_PEER = 'sp';

export function localPeerId(sys: GameFlowSystem): string {
  return sys.ctx.isMultiplayer ? (sys.ctx.net?.localId ?? SOLO_PEER) : SOLO_PEER;
}

function localName(sys: GameFlowSystem): string {
  const net = sys.ctx.net;
  const id = net?.localId;
  return (id ? net?.getLobbyPlayer?.(id)?.name : null) || net?.playerName || '스캐빈저';
}

function slotOf(sys: GameFlowSystem, peerId: string): number {
  const net = sys.ctx.net;
  if (!net) return 0;
  if (peerId === net.localId) return net.localSlot;
  return net.getLobbyPlayer?.(peerId)?.slot ?? 0;
}

/** `net.onMessage('pcorpse' | 'pcorpseq')` + `flow rejoined`. Raised exactly once, in `ensureNetHooks`. */
export function hookCorpseNet(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.corpseUnsubs.length > 0) return;
  sys.corpseUnsubs.push(
    net.onMessage('pcorpse', (msg, from) => onCorpseMessage(sys, msg, from)),
    net.onMessage('pcorpseq', (msg, from) => { if (msg.ev === 'sync' && net.isHost) sendCorpseSync(sys, from); }),
    net.onMessage('flow', (msg, from) => { if (msg.ev === 'rejoined' && net.isHost) sendCorpseSync(sys, from); }),
  );
}

export function unhookCorpseNet(sys: GameFlowSystem): void {
  for (const u of sys.corpseUnsubs) u();
  sys.corpseUnsubs.length = 0;
}

/**
 * `from` (2026-09-16): `emptied` is now the fact that **clears a corpse away**, so only one sent by the lobby host
 * is accepted (the same rule as `ee`). **A message with no sender is refused too** — with a lobby the test is
 * `from === hostId` and nothing else, so an `emptied` that arrives without a `from` cannot clear a corpse away
 * (`parts/Wire.onFlowMessage` guards `flow` in exactly this shape). Every client builds the container ahead of
 * time from every `pcorpse` wire (`inventory/parts/CorpseLoot.hookCorpseWire` → `primeCorpseContainer` — `'all'`
 * echoes back to the sender too), so whoever takes the last item, the host's `crate:looted` sees it too. With no
 * lobby (a smoke) nothing is compared.
 * 2026-09-16 (2nd pass): the host sends it **once nobody looks into that corpse any more** (`Corpses.update`) — the
 * receiver counts the sink clock from the moment it arrives (`releaseEmptied`).
 */
export function onCorpseMessage(sys: GameFlowSystem, msg: CorpseMessage, from?: PeerId): void {
  if (msg.ev === 'spawn') applyCorpseWire(sys, msg.corpse);
  else if (msg.ev === 'sync') for (const w of msg.corpses ?? []) applyCorpseWire(sys, w);
  else if (msg.ev === 'emptied') {
    const hostId = sys.ctx.net?.lobby?.hostId;
    if (hostId && from !== hostId) return;
    if (typeof msg.id === 'string') sys.corpses?.releaseEmptied(msg.id);
  }
}

/** Spawns one wire body in the world (an id already known is ignored). */
export function applyCorpseWire(sys: GameFlowSystem, w: PlayerCorpseWire): void {
  const mgr = sys.corpses;
  if (!mgr || !w || typeof w.id !== 'string') return;
  if (mgr.get(w.id)) return;
  const pos = new THREE.Vector3(w.p?.[0] ?? 0, w.p?.[1] ?? 0, w.p?.[2] ?? 0);
  const world = sys.ctx.world;
  // 2026-09-11 (C-18): the **walkable surface**, not the terrain — so a corpse that died on a tram deck · an
  // upper floor does not fall to the ground
  if (world?.ready) pos.y = world.getSurfaceY(pos.x, pos.z, pos.y);
  const items = itemsFromWire(sys, w.items ?? []);
  mgr.add(w.id, w.owner, w.name || '분대원', pos, Number.isFinite(w.yaw) ? w.yaw : 0,
    Number.isFinite(w.at) ? w.at : sys.ctx.missionTime, items, slotOf(sys, w.owner));
}

function itemsFromWire(sys: GameFlowSystem, wire: PlayerCorpseWire['items']): ItemInstance[] {
  const loot = sys.ctx.loot;
  if (!loot) return [];
  const out: ItemInstance[] = [];
  for (const w of wire) {
    if (!w || typeof w.defId !== 'string') continue;
    const item = loot.createItem(w.defId, Math.max(1, Math.floor(w.qty || 1)), w.ex);
    // 2026-09-12: omitted = no mark
    if (item && typeof w.rf === 'number' && Number.isFinite(w.rf)) item.raidFound = w.rf >>> 0;
    const q = normalizeMealQuality(w.q);   // 2026-09-13: meal quality (omitted = 0)
    if (item && q > 0) item.quality = q;
    if (item) out.push(item);
  }
  return out;
}

/**
 * The local player has died fully: the whole inventory is stripped out, a corpse is spawned on the spot, and in
 * multiplayer it is announced to `'all'`. Called **exactly once**, from `game/parts/Death.onLocalDied`.
 */
export function spawnLocalCorpse(sys: GameFlowSystem): void {
  const ctx = sys.ctx;
  const mgr = sys.corpses;
  const player = ctx.player;
  if (!mgr || !player) return;
  const items: ItemInstance[] = ctx.inventory && typeof ctx.inventory.stripForCorpse === 'function'
    ? ctx.inventory.stripForCorpse() : [];
  const owner = localPeerId(sys);
  const pos = player.position.clone();
  // 2026-09-11 (C-18): the surface that can be stepped onto at foot height (a tram deck · an upper floor) —
  // looking at the terrain alone drops it below them
  if (ctx.world?.ready) pos.y = ctx.world.getSurfaceY(pos.x, pos.z, pos.y);
  const id = mgr.nextId(owner);
  const corpse = mgr.add(id, owner, localName(sys), pos, player.yaw, ctx.missionTime, items, slotOf(sys, owner));
  // with empty hands `add` marks it an empty corpse at once — the receivers see the same `items`, so there is
  // nothing to announce (2026-09-16)
  if (corpse && ctx.isMultiplayer) ctx.net?.send({ t: 'pcorpse', ev: 'spawn', corpse: corpse.toWire() }, 'all');
}

/** Client: asks the host for the list of corpses standing (after `world:ready` · rejoin · host transfer). */
export function requestCorpseSync(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer || net.isHost) return;
  net.send({ t: 'pcorpseq', ev: 'sync' }, 'host');
}

export function sendCorpseSync(sys: GameFlowSystem, to: PeerId): void {
  const net = sys.ctx.net;
  if (!net || !sys.ctx.isMultiplayer || !sys.corpses) return;
  net.send({ t: 'pcorpse', ev: 'sync', corpses: sys.corpses.syncWire() }, to);
}

/**
 * `crate:looted` — a container went empty. If it is a corpse it is marked an empty corpse (the prompt `비어 있음` →
 * a moment later it sinks and disappears).
 *
 * 2026-09-16: **only the host** tells the squad `pcorpse emptied`. A client's `crate:looted` comes only out of a
 * `cont taken` / `cont sync` the host confirmed (a client never takes out of a container optimistically), so marking
 * its own copy is right, and at the same moment the host's copy is empty too and the host broadcasts. A corpse that
 * stood empty-handed is marked by `add` on every client separately.
 * 2026-09-16 (2nd pass): the broadcast is the manager's, and **only on the authority** — `Corpses.markEmptied`
 * and `Corpses.update` both reach it through `releaseByAuthority`, which is gated on `ctx.isAuthority` and fires
 * once every viewer has closed their window. This caller itself sends nothing.
 */
export function onContainerLooted(sys: GameFlowSystem, containerId: string): void {
  if (!containerId.startsWith('pcorpse:')) return;
  sys.corpses?.markEmptied(containerId);
}
