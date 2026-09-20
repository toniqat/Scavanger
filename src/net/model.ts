/**
 * src/net/model.ts — the network folder's shared vocabulary.
 *
 * Only the constants · types (and the stateless helper classes) lifted out of `NetSystem`. It references no class,
 * so a `parts/*` module can use it without importing `NetSystem.ts` back (no circular import). `NetSystem.ts`
 * re-exports it with `export *`, so every existing import path keeps working.
 */
import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { ClientToServer, MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, SocialRef } from '@/shared';
import { isPlanetId } from '@/shared';
import {
  NET_INVITE_PARAM, NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_LENGTH, NET_TOKEN_PARAM, NET_TOKEN_STORAGE_KEY, NET_WS_PATH, PlayerFlags, RAID_BLOB_MAX_BYTES,
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName, slotKey,
} from '@/shared';
import { NetClient } from './NetClient';
import { ProfileSync } from './ProfileSync';
import { SocialSync } from './SocialSync';
import { RemotePlayer } from './RemotePlayer';
import { Snapshotter } from './Snapshotter';
import type { CrewCardWire, ImplantId } from '@/shared';
/* appended (2026-09-08): the shared ship's hangar — a visited member's ship layout */
import type { PlacedBook, PlacedFurniture, RoomPurpose, ShipVisitWire } from '@/shared';
import { COCKPIT_ROOM_INDEX, CULTURE_MAX_SLOTS, ROOM_PURPOSES, SHIP_ROOM_COUNT, SHIP_VISIT_MAX_FURNITURE, roomGridSize } from '@/shared';
import { IMPLANT_IDS } from '@/shared';
/* appended (Phase 11): the planet pick · social */
/* appended (Phase 10): the ready panel's crew cards */

export const NAME_STORAGE_KEY = 'scav.playerName';
export const SNAPSHOT_INTERVAL = 1 / NET_PLAYER_SNAPSHOT_HZ;
/** Seconds a departed peer's RemotePlayer lingers (connected=false) before removal. */
export const PEER_LINGER = 1.0;
/**
 * Auto-reconnect attempts made when we are NOT a lobby member (with a suspended lobby we retry forever).
 * B-1 (2026-09-11): running out is no longer silent — the link goes `unreachable` and the anonymous background probe
 * (`NET_PROBE_BACKOFF_MS`, `parts/Socket.goUnreachable`) keeps looking.
 */
export const MAX_LOBBYLESS_ATTEMPTS = NET_RECONNECT_BACKOFF_MS.length;
/**
 * 2026-09-10: how long the connection test in `설정 › 서버 설정` waits. A dead IP gives no `onerror` until the OS's
 * TCP timeout (tens of seconds), so it is cut here first — a button that spins forever is indistinguishable from
 * the answer "that address is wrong".
 */
export const RELAY_PROBE_TIMEOUT_MS = 4000;
export const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
export const PING_KINDS: ReadonlySet<string> = new Set<PingKind>(['ground', 'enemy', 'crate', 'extraction', 'item', 'attack', 'caution']);
export const CHAT_KINDS: ReadonlySet<string> = new Set<ChatKind>(['text', 'ping', 'request', 'system']);

export type Handler = (msg: GameMessage, from: PeerId) => void;

export function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
export function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
export function vec(t: Vec3Tuple): THREE.Vector3 { return new THREE.Vector3(t[0], t[1], t[2]); }
export const IMPLANT_ID_SET: ReadonlySet<string> = new Set<string>(IMPLANT_IDS);
/** A weapon / armor def id off the wire: a short plain string, or null. */
export function defIdOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}
/**
 * Phase 10: validate a peer's `CrewCardWire` before it reaches the READY panel. Everything is clamped / nulled rather
 * than rejected, so a card from an older or buggy peer still renders (a name + level 1 beats an empty cell).
 */
export function sanitizeCrewCard(c: unknown): CrewCardWire | null {
  if (typeof c !== 'object' || c === null) return null;
  const w = c as Partial<CrewCardWire>;
  const level = isNum(w.level) ? Math.max(1, Math.min(9999, Math.floor(w.level))) : 1;
  const implant = typeof w.implant === 'string' && IMPLANT_ID_SET.has(w.implant) ? (w.implant as ImplantId) : null;
  const card: CrewCardWire = { level, implant, armor: defIdOrNull(w.armor) };
  const p1 = defIdOrNull(w.primary); if (p1 !== null) card.primary = p1;
  const p2 = defIdOrNull(w.primary2); if (p2 !== null) card.primary2 = p2;
  const sec = defIdOrNull(w.secondary); if (sec !== null) card.secondary = sec;
  return card;
}

/** Field-wise equality: the local snoop in `send()` re-emits only when something actually changed. */
export function sameCard(a: CrewCardWire, b: CrewCardWire): boolean {
  return a.level === b.level && a.implant === b.implant && a.armor === b.armor
    && (a.primary ?? null) === (b.primary ?? null) && (a.primary2 ?? null) === (b.primary2 ?? null)
    && (a.secondary ?? null) === (b.secondary ?? null);
}

/*
 * The shared ship's hangar (2026-09-08): a peer's ship layout off the wire. Like `sanitizeCrewCard` this **never
 * rejects the whole document** — a room with a bad purpose falls back to `'empty'` and a malformed piece is dropped,
 * so a ship from an older or buggy peer still walks. Caps mirror what the personal ship can physically hold.
 */
const ROOM_PURPOSE_SET: ReadonlySet<string> = new Set<RoomPurpose>(ROOM_PURPOSES);
/** Hard cap on books accepted from a peer (the ship's own limit is far lower). Pieces use `SHIP_VISIT_MAX_FURNITURE`. */
const SHIP_VISIT_MAX_BOOKS = 400;

export function sanitizeShipVisit(v: unknown): ShipVisitWire | null {
  if (typeof v !== 'object' || v === null) return null;
  const w = v as Partial<ShipVisitWire>;
  const rooms: { purpose: RoomPurpose; level: number }[] = [];
  const src = Array.isArray(w.rooms) ? w.rooms : [];
  for (let i = 0; i < SHIP_ROOM_COUNT; i++) {
    const r = src[i] as Partial<{ purpose: RoomPurpose; level: number }> | undefined;
    const purpose = typeof r?.purpose === 'string' && ROOM_PURPOSE_SET.has(r.purpose) ? r.purpose : 'empty';
    const level = isNum(r?.level) ? Math.max(0, Math.min(99, Math.floor(r.level))) : 0;
    rooms.push({ purpose, level });
  }
  const furniture: PlacedFurniture[] = [];
  if (Array.isArray(w.furniture)) {
    for (const f of w.furniture.slice(0, SHIP_VISIT_MAX_FURNITURE)) {
      const piece = sanitizePlaced(f);
      if (piece) furniture.push(piece);
    }
  }
  const out: ShipVisitWire = {
    rooms,
    generatorLevel: isNum(w.generatorLevel) ? Math.max(0, Math.min(99, Math.floor(w.generatorLevel))) : 0,
    storageLevel: isNum(w.storageLevel) ? Math.max(0, Math.min(99, Math.floor(w.storageLevel))) : 0,
    furniture,
  };
  if (Array.isArray(w.books)) {
    const books = sanitizeShelved(w.books);
    if (books.length > 0) out.books = books;
  }
  /* 2026-09-12 (A-3e): what is shelved in the `디스크 전시대` · `레코드랙` (`media`) and the TV · record players left
     on (`toggled`). This function builds a new object and moves the fields over one by one, so anything not accepted
     here vanishes for the visitor even when the sender put it on the wire. Same rule as `books`, and **omitted when
     empty**. Whether a medium fits its holder is screened by the def on the drawing side (hub `FurnitureSource`). */
  if (Array.isArray(w.media)) {
    const media = sanitizeShelved(w.media);
    if (media.length > 0) out.media = media;
  }
  if (Array.isArray(w.toggled)) {
    // Being switched on only means something for a placed piece — a uid missing from the document's furniture
    // list is dropped (and the same uid twice counts once).
    const placed = new Set(furniture.map((f) => f.uid));
    const toggled: string[] = [];
    for (const u of w.toggled.slice(0, SHIP_VISIT_MAX_FURNITURE)) {
      const uid = defIdOrNull(u);
      if (uid !== null && placed.has(uid) && !toggled.includes(uid)) toggled.push(uid);
    }
    if (toggled.length > 0) out.toggled = toggled;
  }
  /* 2026-09-17: a culture tank's slot appearance (`cultures` — the medium id · whether a strain is in it). Only uids
     of placed pieces, one per (uid, slot), the slot number inside `CULTURE_MAX_SLOTS`. Whether the medium is really a
     medium · the piece really a culture tank is screened by the drawing side's catalogue (hub `FurnitureSource`). */
  if (Array.isArray(w.cultures)) {
    const placed = new Set(furniture.map((f) => f.uid));
    const seen = new Set<string>();
    const cultures: NonNullable<ShipVisitWire['cultures']> = [];
    for (const c of w.cultures.slice(0, SHIP_VISIT_MAX_FURNITURE * CULTURE_MAX_SLOTS)) {
      const e = c as Partial<{ uid: unknown; slot: unknown; medium: unknown; s: unknown }> | null;
      const uid = defIdOrNull(e?.uid), medium = defIdOrNull(e?.medium);
      if (uid === null || medium === null || !placed.has(uid) || !isNum(e?.slot)) continue;
      const slot = Math.floor(e?.slot as number);
      if (slot < 0 || slot >= CULTURE_MAX_SLOTS || seen.has(`${uid}#${slot}`)) continue;
      seen.add(`${uid}#${slot}`);
      cultures.push(e?.s === 1 ? { uid, slot, medium, s: 1 } : { uid, slot, medium });
    }
    if (cultures.length > 0) out.cultures = cultures;
  }
  return out;
}

/** One library holder list (`books` · `media`) — malformed entries are dropped, the slot number clamped to 0 … 99. */
function sanitizeShelved(list: readonly unknown[]): PlacedBook[] {
  const out: PlacedBook[] = [];
  for (const b of list.slice(0, SHIP_VISIT_MAX_BOOKS)) {
    const e = b as Partial<PlacedBook> | null;
    const uid = defIdOrNull(e?.uid), defId = defIdOrNull(e?.defId);
    if (uid === null || defId === null || !isNum(e?.slot)) continue;
    out.push({ uid, defId, slot: Math.max(0, Math.min(99, Math.floor(e?.slot as number))) });
  }
  return out;
}

function sanitizePlaced(f: unknown): PlacedFurniture | null {
  if (typeof f !== 'object' || f === null) return null;
  const w = f as Partial<PlacedFurniture>;
  const uid = defIdOrNull(w.uid), defId = defIdOrNull(w.defId);
  if (uid === null || defId === null) return null;
  if (!isNum(w.room) || !isNum(w.x) || !isNum(w.y)) return null;
  const room = Math.floor(w.room);
  // 2026-09-12: cockpit furniture (`COCKPIT_ROOM_INDEX`) rides on the visit document too — a fixed value outside
  // the room-number range, so it is accepted separately
  if (room !== COCKPIT_ROOM_INDEX && (room < 0 || room >= SHIP_ROOM_COUNT)) return null;
  const yaw = w.yaw === 1 || w.yaw === 2 || w.yaw === 3 ? w.yaw : 0;
  /*
   * Clamp to the **room grid**, not to some large round number: `hub/interiors/Furniture` feeds these straight into
   * `roomCellToWorld`, which extrapolates happily — a cell of 63 would put the mesh *and its solid collider blocker*
   * ~31 m outside the room, anywhere in the visitor's own interior, including on top of the airlock anchor that is
   * the only way out of a visit. 2026-09-12: the grid is per area (`roomGridSize` — the cockpit is 20 × 12).
   */
  const grid = roomGridSize(room);
  const piece: PlacedFurniture = {
    uid, defId, room,
    x: Math.max(0, Math.min(grid.cols - 1, Math.floor(w.x))),
    y: Math.max(0, Math.min(grid.rows - 1, Math.floor(w.y))),
    yaw,
    level: isNum(w.level) ? Math.max(1, Math.min(99, Math.floor(w.level))) : 1,
  };
  if (isNum(w.layer) && w.layer > 0) piece.layer = Math.max(0, Math.min(15, Math.floor(w.layer)));
  return piece;
}

export function isGhostWire(g: unknown): g is GhostWire {
  if (typeof g !== 'object' || g === null) return false;
  const w = g as Partial<GhostWire>;
  return typeof w.id === 'string' && isVec3(w.p) && isNum(w.yaw) && isNum(w.hp) && isNum(w.dhp) && (w.st === 0 || w.st === 1 || w.st === 2);
}

/** Persistent per-browser session token (NET_TOKEN_LENGTH url-safe chars) — the server derives a stable PeerId from it. */
export function loadOrCreateSessionToken(): string {
  try {
    const stored = localStorage.getItem(slotKey(NET_TOKEN_STORAGE_KEY));
    if (stored && stored.length === NET_TOKEN_LENGTH && TOKEN_RE.test(stored)) return stored;
  } catch { /* storage unavailable */ }
  const bytes = new Uint8Array(NET_TOKEN_LENGTH);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let token = '';
  for (let i = 0; i < NET_TOKEN_LENGTH; i++) token += TOKEN_ALPHABET[bytes[i] & 63];
  try { localStorage.setItem(slotKey(NET_TOKEN_STORAGE_KEY), token); } catch { /* storage unavailable → token lives for this page only */ }
  return token;
}

/**
 * Multiplayer client. Owns the relay connection, the lobby mirror, local snapshot broadcasting and the
 * interpolated RemotePlayerRefs. Publishes itself as `ctx.net`. Registered first in main.ts so inbound
 * state is applied before any other system reads it in the same frame.
 *
 * Reconnection: the session token makes our PeerId stable, so after an unexpected socket drop we keep the lobby
 * (suspended), retry with NET_RECONNECT_BACKOFF_MS and resume into the same party when `welcome.lobby` comes back
 * (`net:resumed`). Snapshots are also exchanged in the shared ship hub (`inHubSession`).
 *
 * Phase 7: server profile (`profile`), raid session blobs, training missions (any member starts, the rest join from
 * the terminal), suspended members whose body the host keeps as a ghost, and mid-mission host migration
 * (`net:hostChanged` / `flow takeover`).
 */

