/**
 * src/net/model.ts — 네트워크 폴더의 공용 어휘.
 *
 * `NetSystem` 에서 떼어낸 상수 · 타입(그리고 상태 없는 보조 클래스)만 있다. 클래스를 참조하지 않으므로
 * `parts/*` 모듈이 `NetSystem.ts` 를 되돌아 import 하지 않고 쓸 수 있다(순환 import 방지).
 * `NetSystem.ts` 가 `export *` 로 재수출하므로 기존 import 경로는 전부 유지된다.
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
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '@/shared';
import { NetClient } from './NetClient';
import { ProfileSync } from './ProfileSync';
import { SocialSync } from './SocialSync';
import { RemotePlayer } from './RemotePlayer';
import { Snapshotter } from './Snapshotter';
import type { CrewCardWire, ImplantId } from '@/shared';
/* appended (2026-09-08): 공용 함선 격납고 — a visited member's ship layout */
import type { PlacedBook, PlacedFurniture, RoomPurpose, ShipVisitWire } from '@/shared';
import { ROOM_GRID_COLS, ROOM_GRID_ROWS, ROOM_PURPOSES, SHIP_ROOM_COUNT, SHIP_VISIT_MAX_FURNITURE } from '@/shared';
import { IMPLANT_IDS } from '@/shared';
/* appended (Phase 11): 행성 선택 · 소셜 */
/* appended (Phase 10): 발사 준비 패널 crew cards */

export const NAME_STORAGE_KEY = 'scav.playerName';
export const SNAPSHOT_INTERVAL = 1 / NET_PLAYER_SNAPSHOT_HZ;
/** Seconds a departed peer's RemotePlayer lingers (connected=false) before removal. */
export const PEER_LINGER = 1.0;
/** Auto-reconnect attempts made when we are NOT a lobby member (with a suspended lobby we retry forever). */
export const MAX_LOBBYLESS_ATTEMPTS = NET_RECONNECT_BACKOFF_MS.length;
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
 * 공용 함선 격납고 (2026-09-08): a peer's ship layout off the wire. Like `sanitizeCrewCard` this **never rejects the
 * whole document** — a room with a bad purpose falls back to `'empty'` and a malformed piece is dropped, so a ship
 * from an older or buggy peer still walks. Caps mirror what the personal ship can physically hold.
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
    const books: PlacedBook[] = [];
    for (const b of w.books.slice(0, SHIP_VISIT_MAX_BOOKS)) {
      const e = b as Partial<PlacedBook>;
      const uid = defIdOrNull(e?.uid), defId = defIdOrNull(e?.defId);
      if (uid === null || defId === null || !isNum(e?.slot)) continue;
      books.push({ uid, defId, slot: Math.max(0, Math.min(99, Math.floor(e.slot as number))) });
    }
    if (books.length > 0) out.books = books;
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
  if (room < 0 || room >= SHIP_ROOM_COUNT) return null;
  const yaw = w.yaw === 1 || w.yaw === 2 || w.yaw === 3 ? w.yaw : 0;
  /*
   * Clamp to the **room grid**, not to some large round number: `hub/interiors/Furniture` feeds these straight into
   * `roomCellToWorld`, which extrapolates happily — a cell of 63 would put the mesh *and its solid collider blocker*
   * ~31 m outside the room, anywhere in the visitor's own interior, including on top of the airlock anchor that is
   * the only way out of a visit.
   */
  const piece: PlacedFurniture = {
    uid, defId, room,
    x: Math.max(0, Math.min(ROOM_GRID_COLS - 1, Math.floor(w.x))),
    y: Math.max(0, Math.min(ROOM_GRID_ROWS - 1, Math.floor(w.y))),
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
    const stored = localStorage.getItem(NET_TOKEN_STORAGE_KEY);
    if (stored && stored.length === NET_TOKEN_LENGTH && TOKEN_RE.test(stored)) return stored;
  } catch { /* storage unavailable */ }
  const bytes = new Uint8Array(NET_TOKEN_LENGTH);
  try { crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  let token = '';
  for (let i = 0; i < NET_TOKEN_LENGTH; i++) token += TOKEN_ALPHABET[bytes[i] & 63];
  try { localStorage.setItem(NET_TOKEN_STORAGE_KEY, token); } catch { /* storage unavailable → token lives for this page only */ }
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

