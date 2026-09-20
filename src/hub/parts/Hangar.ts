/**
 * src/hub/parts/Hangar.ts — **the shared ship's hangar** (2026-09-08).
 *
 * Beyond the sliding door at the shared ship's stern the hangar holds four bays marked as squares on the deck, one
 * **personal ship** per lobby slot. E in front of a ship's rear ramp walks into it.
 *
 * Drawing someone else's ship needs their placement state, and no message carried it — `ship state`
 * (`ShipVisitWire`) takes that load. It works **exactly** like the crew card: broadcast once on arrival in the
 * shared ship, re-broadcast debounced when our own ship changes, and answered straight away for `shipq state`.
 *
 * During a visit (someone else's ship) the terminal · benches · growing · library · furniture · ship management are
 * all refused — looking around only.
 */
import type {
  GameContext, HubShipBay, PeerId, PlacedBook, PlacedFurniture, Rarity, RoomPurpose, ShipModelId, ShipVisitWire,
} from '@/shared';
import {
  BOOKS_PER_SHELF, FURNITURE_DEF_MAP, NET_MAX_PLAYERS, SHELF_SLOTS, SHIP_ROOM_COUNT, SHIP_VISIT_COOLDOWN_S, SHIP_VISIT_MAX_FURNITURE,
  SHIP_VISIT_MIN_INTERVAL_S, SHIP_VISIT_WAIT_S, isBotPlayer, shelfMediumOfInteraction, shipModelOf,
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

/**
 * Our own ship as the wire sees it: rooms, facility levels, placed pieces and the shelved books.
 *
 * The piece list is capped at `SHIP_VISIT_MAX_FURNITURE` — the **same** number the receiver enforces. A relayed
 * frame over `MAX_MESSAGE_BYTES` (64 kB) is dropped by the server with no error, and `sendShipState` has already
 * advanced its debounce by then, so an over-large layout would simply never arrive and every visitor to that bay
 * would time out forever. Capping here keeps the document inside the frame instead of relying on luck.
 */
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
  try { furniture = [...h.getPlaced()].slice(0, SHIP_VISIT_MAX_FURNITURE); } catch { furniture = []; }
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
      } catch { /* not a bookshelf */ }
    }
  }
  if (books.length > 0) wire.books = books;
  // A-3e (2026-09-12): the media on disc stands · record racks and a TV · record player left on — same shape as
  // `books`, omitted when empty (the receiving `net`'s `sanitizeShipVisit` validates and keeps both fields)
  const state = h.state;
  if (state?.media && state.media.length > 0) wire.media = state.media.map((m) => ({ uid: m.uid, slot: m.slot, defId: m.defId }));
  if (state?.toggled && state.toggled.length > 0) wire.toggled = [...state.toggled];
  // 2026-09-17: the look of each culture-tank slot (medium id · whether a strain sits in it) — a visitor's tank model draws the owner's colours and masses
  if (state?.cultures && state.cultures.length > 0) {
    const placed = new Set(furniture.map((f) => f.uid));
    const cultures = state.cultures.filter((c) => placed.has(c.uid))
      .map((c) => (c.strainDefId ? { uid: c.uid, slot: c.slot, medium: c.mediumDefId, s: 1 as const } : { uid: c.uid, slot: c.slot, medium: c.mediumDefId }));
    if (cultures.length > 0) wire.cultures = cultures;
  }
  return wire;
  }

/**
 * `to` omitted = broadcast to `others`; `force` skips the debounce (arrival in the shared ship). A per-peer cooldown
 * keeps a `shipq state` flood from turning into a stream of multi-kB documents.
 */
export function sendShipState(sys: HubSystem, force: boolean, to?: PeerId): void {
  const ctx = sys.ctx;
  const net = ctx.net;
  // 2026-09-15: ship layouts belong to the docked squad's hangar — an undocked squad exchanges none
  if (!net || !sys.squadLobby() || typeof net.send !== 'function') { sys.shipStateDirty = false; return; }
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
  if (!sys.active || !sys.squadLobby()) return;
  sendShipState(sys, false);
  }

/**
 * Arriving in the shared ship: publish our layout and ask the squad for theirs (the bays render from the answers).
 *
 * **Only when something is actually missing.** `hub:entered {ship:'shared'}` also fires every time the player walks
 * back out of a bay (`leaveShip`), and a full announce there would make all three squadmates re-send their multi-kB
 * layout on every in-and-out — so this asks for the documents it does not have and force-broadcasts ours only when
 * the squad has not seen it yet. `shipAnsweredAt` (our per-peer answer cooldown, the actual anti-flood) is **never**
 * cleared here: that was copied from the crew card, where the payload is a few dozen bytes.
 */
export function announceShip(sys: HubSystem): void {
  bindShipRequests(sys);
  const net = sys.ctx.net;
  const lobby = sys.squadLobby();
  if (!net || !lobby || typeof net.send !== 'function') return;
  const me = net.localId;
  const known = typeof net.getShipVisit === 'function' ? net.getShipVisit(me ?? '') : null;
  if (!known) sendShipState(sys, true);          // first arrival in this squad — nobody has our layout
  for (const p of lobby.players) {
    // 2026-09-15: a bot member has no ship to ask for (and no socket either)
    if (p.id === me || isBotPlayer(p) || typeof net.requestShipVisit !== 'function') continue;
    if (!net.getShipVisit(p.id)) net.requestShipVisit(p.id);
  }
  }

/**
 * Read-only `FurnitureSource` over a member's `ShipVisitWire` (nothing in it ever changes under the layer). Book
 * **rarities** are looked up locally from `ctx.loot` — the wire only carries def ids, and the item catalogue is the
 * same on every client, so a visited bookshelf's spines read exactly as they do in the owner's own ship.
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
  /*
   * A-3e (2026-09-12): the slots of disc stands · record racks — the slot count comes from that piece's media
   * (`SHELF_SLOTS`), and a uid missing from the wire · a slot out of range · a piece that is not a holder are dropped
   * (the same defence as books). Rarities are looked up in the local catalogue, as books are.
   */
  const defOfUid = new Map<string, string>();
  for (const piece of wire.furniture) defOfUid.set(piece.uid, piece.defId);
  const mediaByUid = new Map<string, (Rarity | null)[]>();
  for (const m of wire.media ?? []) {
    const defId = defOfUid.get(m.uid);
    const def = defId ? FURNITURE_DEF_MAP.get(defId) : undefined;
    const medium = def ? shelfMediumOfInteraction(def.interaction) : null;
    if (!medium || medium === 'book') continue;
    const n = SHELF_SLOTS[medium];
    if (m.slot < 0 || m.slot >= n) continue;
    let slots = mediaByUid.get(m.uid);
    if (!slots) { slots = new Array(n).fill(null); mediaByUid.set(m.uid, slots); }
    let rarity: Rarity = 'common';
    try { rarity = ctx.loot?.getItemDef(m.defId)?.rarity ?? 'common'; } catch { /* unknown medium */ }
    slots[m.slot] = rarity;
  }
  const toggled = new Set(wire.toggled ?? []);
  // 2026-09-17: culture-tank slots (medium id · whether a strain sits in it) — anything from a piece that is not a tank is dropped
  const culturesByUid = new Map<string, { slot: number; medium: string; filled: boolean }[]>();
  for (const c of wire.cultures ?? []) {
    const defId = defOfUid.get(c.uid);
    if (!defId || FURNITURE_DEF_MAP.get(defId)?.interaction !== 'culture_tank') continue;
    let list = culturesByUid.get(c.uid);
    if (!list) { list = []; culturesByUid.set(c.uid, list); }
    list.push({ slot: c.slot, medium: c.medium, filled: c.s === 1 });
  }
  const EMPTY_ROOM: readonly PlacedFurniture[] = [];
  const EMPTY_SHELF: readonly (Rarity | null)[] = new Array(BOOKS_PER_SHELF).fill(null);
  const EMPTY_MEDIA: readonly (Rarity | null)[] = [];
  return {
    getPlaced: (room) => byRoom.get(room) ?? EMPTY_ROOM,
    getBooks: (uid) => byUid.get(uid) ?? EMPTY_SHELF,
    getMedia: (uid) => mediaByUid.get(uid) ?? EMPTY_MEDIA,
    isOn: (uid) => toggled.has(uid),
    getCultures: (uid) => culturesByUid.get(uid) ?? [],
  };
  }

/* ── bays ──────────────────────────────────────────────────────────────── */
/**
 * Crew name parked in bay `slot`, or null when the slot is empty (no lobby → only our own bay 0 is filled).
 *
 * 2026-09-15 (android squadmates): a bot member has no personal ship — that slot's bay stays **empty**
 * (`비어 있는 정박 구역`), no ship is parked in it and no `ship state` is ever asked for.
 */
function occupantOf(sys: HubSystem, slot: number): { id: PeerId; name: string; model: ShipModelId } | null {
  const net = sys.ctx.net;
  const lobby = sys.squadLobby();
  const mine = myShipModel(sys);
  if (!lobby) return slot === 0 ? { id: net?.localId ?? 'local', name: '내 함선', model: mine } : null;
  const p = lobby.players.find((q) => q.slot === slot) ?? null;
  if (!p || isBotPlayer(p)) return null;
  // 2026-09-21 (the ship-purchase hook): each bay parks **its owner's** ship. Our own model comes from our profile;
  // a squadmate's rides `LobbyPlayer` — `shipModelOf` reads the field by shape, so a relay that does not send it yet
  // simply parks the default ship instead of failing to compile.
  const isMe = p.id === (net?.localId ?? 'local');
  return { id: p.id, name: p.name, model: isMe ? mine : shipModelOf(p) };
  }

/** The local character's ship model (`PlayerProfile.shipModel`), defaulting when progression is absent. */
function myShipModel(sys: HubSystem): ShipModelId {
  return shipModelOf(sys.ctx.progression?.profile);
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
  const models: (ShipModelId | null)[] = [];
  for (let i = 0; i < NET_MAX_PLAYERS; i++) {
    const occ = occupantOf(sys, i);
    names.push(occ?.name ?? null);
    models.push(occ?.model ?? null);
  }
  interior.setBayOccupants(names, models);
  }

/* ── entering / leaving a parked ship ──────────────────────────────────── */
/**
 * Board the personal ship in bay `slot`. Ours enters at once; someone else's needs their `ship state` — when it has not
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
