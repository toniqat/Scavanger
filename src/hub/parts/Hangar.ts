/**
 * src/hub/parts/Hangar.ts — **공용 함선 격납고** (2026-09-08).
 *
 * 공유 함선 뒤쪽 자동문 너머의 격납고에는 바닥에 네모로 표시된 정박 구역이 4개 있고, 로비 슬롯마다
 * 그 대원의 **개인 함선**이 한 대씩 서 있다. 함선 뒷문(램프) 앞에서 E 를 누르면 그 함선 안으로 들어간다.
 *
 * 남의 함선을 그리려면 그 사람의 배치 상태가 필요한데 어떤 메시지도 그걸 나르지 않는다 —
 * `ship state` (`ShipVisitWire`) 가 그 짐을 진다. 동작 방식은 크루 카드와 **똑같다**:
 * 공유 함선에 도착하면 한 번 뿌리고, 내 함선이 바뀌면 디바운스해서 다시 뿌리고, `shipq state` 에는 바로 답한다.
 *
 * 방문 중에는(남의 함선) 터미널 · 작업대 · 재배 · 서재 · 가구 · 시설 관리가 전부 막힌다 — 둘러보기 전용.
 */
import type {
  GameContext, HubShipBay, PeerId, PlacedBook, PlacedFurniture, Rarity, RoomPurpose, ShipVisitWire,
} from '@/shared';
import {
  BOOKS_PER_SHELF, NET_MAX_PLAYERS, SHIP_ROOM_COUNT, SHIP_VISIT_COOLDOWN_S, SHIP_VISIT_MIN_INTERVAL_S,
  SHIP_VISIT_WAIT_S,
} from '@/shared';
import type { FurnitureSource } from '../interiors/Furniture';
import type { HubSystem } from '../HubSystem';

/** Radius of a bay's boarding interactable (the ramp is a wide target). */
const BAY_RADIUS = 3.0;

/* ── ship state on the wire ────────────────────────────────────────────── */
/**
 * Answer `shipq state`. Receiving / storing is `net/`'s job (`getShipVisit`, `net:shipVisit`); the hub only **sends**,
 * exactly like the crew card. Registered once; a missing `ctx.net` is retried on `hub:entered`.
 */
export function bindShipRequests(sys: HubSystem): void {
  if (sys.shipUnsub) return;
  const net = sys.ctx.net;
  if (!net || typeof net.onMessage !== 'function') return;
  sys.shipUnsub = net.onMessage('shipq', (msg, from) => {
    if (msg.ev === 'state') sendShipState(sys, false, from);
  });
  }

/** Our own ship as the wire sees it: rooms, facility levels, every placed piece and the shelved books. */
export function shipStateWire(sys: HubSystem): ShipVisitWire | null {
  const h = sys.ctx.housing;
  if (!h) return null;
  const rooms: { purpose: RoomPurpose; level: number }[] = [];
  for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
    let purpose: RoomPurpose = 'empty', level = 0;
    try { const r = h.getRoom(i); purpose = r.purpose; level = r.level; } catch { /* stub */ }
    rooms.push({ purpose, level });
  }
  let furniture: PlacedFurniture[] = [];
  try { furniture = [...h.getPlaced()]; } catch { furniture = []; }
  const wire: ShipVisitWire = {
    rooms,
    generatorLevel: h.state?.generatorLevel ?? 0,
    storageLevel: h.state?.storageLevel ?? 0,
    furniture,
  };
  const books: PlacedBook[] = [];
  if (typeof h.getBooks === 'function') {
    for (const piece of furniture) {
      try {
        for (const slot of h.getBooks(piece.uid)) {
          if (slot.defId) books.push({ uid: piece.uid, slot: slot.slot, defId: slot.defId });
        }
      } catch { /* not a 책장 */ }
    }
  }
  if (books.length > 0) wire.books = books;
  return wire;
  }

/**
 * `to` omitted = broadcast to `others`; `force` skips the debounce (arrival in the shared ship). A per-peer cooldown
 * keeps a `shipq state` flood from turning into a stream of multi-kB documents.
 */
export function sendShipState(sys: HubSystem, force: boolean, to?: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  if (!net?.lobby || typeof net.send !== 'function') { sys.shipStateDirty = false; return; }
  if (to !== undefined) {
    const last = sys.shipAnsweredAt.get(to) ?? -Infinity;
    if (!force && ctx.time - last < SHIP_VISIT_COOLDOWN_S) return;
    sys.shipAnsweredAt.set(to, ctx.time);
  } else {
    if (!force && ctx.time - sys.lastShipStateAt < SHIP_VISIT_MIN_INTERVAL_S) { sys.shipStateDirty = true; return; }
    sys.lastShipStateAt = ctx.time;
    sys.shipStateDirty = false;
  }
  const ship = shipStateWire(sys);
  if (!ship) return;
  try { net.send({ t: 'ship', ev: 'state', ship }, to ?? 'others'); } catch { /* offline */ }
  }

/** Our ship changed (furniture placed, room re-purposed, a facility upgraded…): re-broadcast, debounced. */
export function shipStateChanged(sys: HubSystem): void {
  if (!sys.active || !sys.ctx.net?.lobby) return;
  sendShipState(sys, false);
  }

/** Arriving in the shared ship: publish our layout and ask the squad for theirs (the bays render from the answers). */
export function announceShip(sys: HubSystem): void {
  bindShipRequests(sys);
  const net = sys.ctx.net;
  if (!net?.lobby || typeof net.send !== 'function') return;
  sys.shipAnsweredAt.clear();
  sendShipState(sys, true);
  for (const p of net.lobby.players) {
    if (p.id !== net.localId && typeof net.requestShipVisit === 'function') net.requestShipVisit(p.id);
  }
  }

/**
 * Read-only `FurnitureSource` over a member's `ShipVisitWire` (nothing in it ever changes under the layer). Book
 * **rarities** are looked up locally from `ctx.loot` — the wire only carries def ids, and the item catalogue is the
 * same on every client, so a visited 책장's spines read exactly as they do in the owner's own ship.
 */
export function furnitureSource(ctx: GameContext, wire: ShipVisitWire): FurnitureSource {
  const byRoom = new Map<number, PlacedFurniture[]>();
  for (const piece of wire.furniture) {
    let list = byRoom.get(piece.room);
    if (!list) { list = []; byRoom.set(piece.room, list); }
    list.push(piece);
  }
  const byUid = new Map<string, (Rarity | null)[]>();
  for (const bk of wire.books ?? []) {
    let slots = byUid.get(bk.uid);
    if (!slots) { slots = new Array(BOOKS_PER_SHELF).fill(null); byUid.set(bk.uid, slots); }
    if (bk.slot < 0 || bk.slot >= BOOKS_PER_SHELF) continue;
    let rarity: Rarity = 'common';
    try { rarity = ctx.loot?.getItemDef(bk.defId)?.rarity ?? 'common'; } catch { /* unknown book */ }
    slots[bk.slot] = rarity;
  }
  const EMPTY_ROOM: readonly PlacedFurniture[] = [];
  const EMPTY_SHELF: readonly (Rarity | null)[] = new Array(BOOKS_PER_SHELF).fill(null);
  return {
    getPlaced: (room) => byRoom.get(room) ?? EMPTY_ROOM,
    getBooks: (uid) => byUid.get(uid) ?? EMPTY_SHELF,
  };
  }

/* ── bays ──────────────────────────────────────────────────────────────── */
/** Crew name parked in bay `slot`, or null when the slot is empty (no lobby → only our own bay 0 is filled). */
function occupantOf(sys: HubSystem, slot: number): { id: PeerId; name: string } | null {
  const net = sys.ctx.net;
  const lobby = net?.lobby ?? null;
  if (!lobby) return slot === 0 ? { id: net?.localId ?? 'local', name: '내 함선' } : null;
  const p = lobby.players.find((q) => q.slot === slot) ?? null;
  return p ? { id: p.id, name: p.name } : null;
  }

/** The hangar's four bays with their current occupants (empty outside the shared ship). */
export function getShipBays(sys: HubSystem): readonly HubShipBay[] {
  const defs = sys.interior?.bays;
  if (!defs || defs.length === 0) return [];
  return defs.map((d) => ({
    slot: d.slot,
    position: d.position.clone(),
    entrance: d.entrance.clone(),
    yaw: d.yaw,
    occupant: occupantOf(sys, d.slot)?.id ?? null,
  }));
  }

/**
 * Korean reason boarding bay `slot` is refused right now (also the bay's prompt), or null when it takes us. Like the
 * launch pods this keeps `canInteract` true, so the player always sees *why* instead of no prompt at all.
 */
export function bayBlockReason(sys: HubSystem, slot: number): string | null {
  if (sys.cutscene || sys.travelling) return '함선 이동 중';
  if (sys.countdown >= 0) return '발사 준비 중 — 함선을 떠날 수 없습니다';
  if (sys.raidRunning()) return '임무 진행 중';
  const occ = occupantOf(sys, slot);
  if (!occ) return '비어 있는 정박 구역';
  return null;
  }

export function bayPrompt(sys: HubSystem, slot: number): string | null {
  if (!sys.interior?.bays?.length || sys.boardedSlot >= 0 || sys.housingMode.active) return null;
  // An **empty** bay says so on its own sign and floor marking; standing in it must not nag with a prompt.
  const occ = occupantOf(sys, slot);
  if (!occ) return null;
  const blocked = bayBlockReason(sys, slot);
  if (blocked) return blocked;
  const mine = occ.id === (sys.ctx.net?.localId ?? 'local');
  return mine ? '개인 함선 탑승' : `${occ.name} 의 함선 방문`;
  }

/** Register one interactable per bay (shared ship only). */
export function buildBays(sys: HubSystem): void {
  const defs = sys.interior?.bays;
  if (!defs) return;
  for (const d of defs) {
    const id = `hub_ship_bay_${d.slot}`;
    sys.ctx.interactables.register({
      id,
      position: d.entrance.clone(),
      radius: BAY_RADIUS,
      getPrompt: () => bayPrompt(sys, d.slot),
      canInteract: () => bayPrompt(sys, d.slot) !== null,
      interact: () => { sys.enterShipBay(d.slot); },
    });
    sys.bayIds.push(id);
  }
  refreshBays(sys);
  }

export function clearBays(sys: HubSystem): void {
  for (const id of sys.bayIds) sys.ctx.interactables.unregister(id);
  sys.bayIds.length = 0;
  }

/** Park / clear the ships and rewrite the bay signs from the current lobby. */
export function refreshBays(sys: HubSystem): void {
  const interior = sys.interior;
  if (!interior || typeof interior.setBayOccupants !== 'function') return;
  const names: (string | null)[] = [];
  for (let i = 0; i < NET_MAX_PLAYERS; i++) names.push(occupantOf(sys, i)?.name ?? null);
  interior.setBayOccupants(names);
  }

/* ── entering / leaving a parked ship ──────────────────────────────────── */
/**
 * Board the 개인 함선 in bay `slot`. Ours enters at once; someone else's needs their `ship state` — when it has not
 * arrived we ask for it and wait up to `SHIP_VISIT_WAIT_S` (`tickPendingVisit` finishes or gives up).
 */
export function enterShipBay(sys: HubSystem, slot: number): boolean {
  const ctx = sys.ctx;
  const deny = (text: string): false => {
    ctx.bus.emit('ui:notify', { text, kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
    return false;
  };
  if (ctx.phase !== 'hub' || sys.ship !== 'shared' || !sys.interior?.bays?.length) return false;
  const blocked = bayBlockReason(sys, slot);
  if (blocked) return deny(blocked);
  const occ = occupantOf(sys, slot);
  if (!occ) return false;
  if (sys.boardedSlot >= 0) sys.leavePod(true);

  const me = ctx.net?.localId ?? 'local';
  if (occ.id === me) { sys.boardShip(null, slot); return true; }

  const net = ctx.net;
  const wire = net && typeof net.getShipVisit === 'function' ? net.getShipVisit(occ.id) : null;
  if (wire) { sys.boardShip(occ.id, slot); return true; }
  if (!net || typeof net.requestShipVisit !== 'function') return deny('함선 정보를 받을 수 없습니다');
  net.requestShipVisit(occ.id);
  sys.pendingBay = { slot, peerId: occ.id, until: ctx.time + SHIP_VISIT_WAIT_S };
  ctx.bus.emit('ui:notify', { text: `${occ.name} 의 함선 정보를 받는 중…`, kind: 'info', duration: 2 });
  return true;
  }

/**
 * A pending visit: enter as soon as the layout lands, give up (with a toast) at `SHIP_VISIT_WAIT_S`. Also cancelled
 * when the player walks away from the bay, so a forgotten request never yanks them off the deck later.
 */
export function tickPendingVisit(sys: HubSystem): void {
  const pending = sys.pendingBay;
  if (!pending) return;
  const ctx = sys.ctx;
  if (ctx.phase !== 'hub' || sys.ship !== 'shared' || sys.cutscene) { sys.pendingBay = null; return; }
  const def = sys.interior?.bays?.[pending.slot];
  const p = ctx.player;
  if (def && p && p.position.distanceTo(def.entrance) > BAY_RADIUS * 2) { sys.pendingBay = null; return; }
  const net = ctx.net;
  const wire = net && typeof net.getShipVisit === 'function' ? net.getShipVisit(pending.peerId) : null;
  if (wire) {
    sys.pendingBay = null;
    if (bayBlockReason(sys, pending.slot) === null) sys.boardShip(pending.peerId, pending.slot);
    return;
  }
  if (ctx.time >= pending.until) {
    sys.pendingBay = null;
    ctx.bus.emit('ui:notify', { text: '함선 정보를 받지 못했습니다 — 잠시 후 다시 시도하세요', kind: 'warning' });
    ctx.bus.emit('audio:play', { id: 'ui_deny' });
  }
  }

/** Walk back out through the visited ship's airlock into the hangar bay we came from. */
export function returnToHangar(sys: HubSystem): boolean {
  const visit = sys.visit;
  if (!visit || sys.ctx.phase !== 'hub' || sys.cutscene) return false;
  sys.leaveShip();
  return true;
  }

/** Status line while inside a bay's ship (the HUD's only reminder of how to get back out). */
export function visitStatus(sys: HubSystem): { main: string; sub: string } | null {
  const visit = sys.visit;
  if (!visit) return null;
  if (visit.peerId === null) return { main: '개인 함선', sub: '에어락으로 나가면 격납고로 돌아갑니다' };
  const name = sys.ctx.net?.getRemotePlayer(visit.peerId)?.name
    ?? sys.ctx.net?.lobby?.players.find((p) => p.id === visit.peerId)?.name
    ?? '분대원';
  return { main: `${name} 의 함선 방문 중`, sub: '둘러보기 전용 — 에어락으로 나가면 격납고로 돌아갑니다' };
  }
