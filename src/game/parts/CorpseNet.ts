/**
 * src/game/parts/CorpseNet.ts — **시체의 생성과 동기화** (`pcorpse` / `pcorpseq`, 2026-09-09).
 *
 * 이 파일이 답하는 질문: *누가 시체를 만들고, 늦게 합류한 사람은 그것을 어떻게 알게 되는가.*
 *
 * - `spawn` 은 **죽은 본인**이 `'all'` 로 보낸다 — 자기 인벤토리만이 진실이라 아무도 대신 말할 수 없다.
 *   `'all'` 은 보낸 사람에게도 되돌아오지만 시체 id 로 중복 제거되므로 두 번 서지 않는다.
 * - 호스트는 **남의 시체도 `items` 채로** 들고 있다가 `pcorpseq sync` / `flow rejoined` 에 `pcorpse sync` 로 답한다
 *   (`stratagems/parts/Wire` 의 late-join 패턴과 같은 모양).
 * - 시체 안의 아이템을 **가져가는** 것은 이 파일과 무관하다 — 상자와 똑같이 `cont` / `contq` 를 탄다.
 */
import * as THREE from 'three';
import type { CorpseMessage, ItemInstance, PeerId, PlayerCorpseWire } from '@/shared';
import type { GameFlowSystem } from '../GameFlowSystem';

/** 싱글 플레이의 `PeerId` 대역 (계약: 솔로는 `'sp'`). */
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

/** `net.onMessage('pcorpse' | 'pcorpseq')` + `flow rejoined`. `ensureNetHooks` 에서 한 번만 건다. */
export function hookCorpseNet(sys: GameFlowSystem): void {
  const net = sys.ctx.net;
  if (!net || sys.corpseUnsubs.length > 0) return;
  sys.corpseUnsubs.push(
    net.onMessage('pcorpse', (msg) => onCorpseMessage(sys, msg)),
    net.onMessage('pcorpseq', (msg, from) => { if (msg.ev === 'sync' && net.isHost) sendCorpseSync(sys, from); }),
    net.onMessage('flow', (msg, from) => { if (msg.ev === 'rejoined' && net.isHost) sendCorpseSync(sys, from); }),
  );
}

export function unhookCorpseNet(sys: GameFlowSystem): void {
  for (const u of sys.corpseUnsubs) u();
  sys.corpseUnsubs.length = 0;
}

export function onCorpseMessage(sys: GameFlowSystem, msg: CorpseMessage): void {
  if (msg.ev === 'spawn') applyCorpseWire(sys, msg.corpse);
  else if (msg.ev === 'sync') for (const w of msg.corpses ?? []) applyCorpseWire(sys, w);
  else if (msg.ev === 'emptied') sys.corpses?.markEmptied(msg.id);
}

/** 와이어 한 구를 월드에 세운다 (이미 아는 id 는 무시된다). */
export function applyCorpseWire(sys: GameFlowSystem, w: PlayerCorpseWire): void {
  const mgr = sys.corpses;
  if (!mgr || !w || typeof w.id !== 'string') return;
  if (mgr.get(w.id)) return;
  const pos = new THREE.Vector3(w.p?.[0] ?? 0, w.p?.[1] ?? 0, w.p?.[2] ?? 0);
  const world = sys.ctx.world;
  if (world?.ready) pos.y = world.getHeightAt(pos.x, pos.z);
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
    if (item) out.push(item);
  }
  return out;
}

/**
 * 로컬 플레이어가 완전히 사망했다: 인벤토리를 통째로 뽑아 그 자리에 시체를 세우고, 멀티면 `'all'` 로 알린다.
 * `game/parts/Death.onLocalDied` 에서 **정확히 한 번** 불린다.
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
  if (ctx.world?.ready) pos.y = ctx.world.getHeightAt(pos.x, pos.z);
  const id = mgr.nextId(owner);
  const corpse = mgr.add(id, owner, localName(sys), pos, player.yaw, ctx.missionTime, items, slotOf(sys, owner));
  if (ctx.isMultiplayer) ctx.net?.send({ t: 'pcorpse', ev: 'spawn', corpse: corpse.toWire() }, 'all');
}

/** 클라이언트: 지금 서 있는 시체 목록을 호스트에게 청한다 (`world:ready` 이후 · 재합류 · 호스트 이관). */
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

/** `crate:looted` — 컨테이너가 비었다. 시체면 프롬프트를 `비어 있음` 으로 바꾸고 분대에도 알린다. */
export function onContainerLooted(sys: GameFlowSystem, containerId: string): void {
  if (!containerId.startsWith('pcorpse:')) return;
  if (!sys.corpses?.markEmptied(containerId)) return;
  if (sys.ctx.isMultiplayer) sys.ctx.net?.send({ t: 'pcorpse', ev: 'emptied', id: containerId }, 'others');
}
