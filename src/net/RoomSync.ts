import type {
  ClientToServer, EventBus, PlayerCode, PresenceState, RoomErrorCode, RoomId, RoomInfo, RoomInvite, RoomLine, RoomMember,
  RoomsRef, RoomSystemKind, SocialCard,
} from '@/shared';
import {
  ROOM_ERROR_MESSAGE_KO, ROOM_HISTORY_PAGE, ROOM_JOINED_MAX, ROOM_LINES_MAX, ROOM_MEMBER_MAX, ROOM_NAME_MAX, ROOM_READ_STORAGE_KEY,
  ROOM_TEXT_MAX, SOCIAL_ERROR_MESSAGE_KO, formatPlayerCode, isValidPlayerCode, isValidRoomId, normalizePlayerCode,
  roomErrorMessage, roomSystemTextKo, sanitizeRoomName, sanitizeRoomText, slotKey,
} from '@/shared';

/** Longest name mirrored off the wire (the relay sanitizes to 16; a guard against a hostile frame). */
const NAME_MAX = 32;
const LEVEL_MAX = 999;
/**
 * A `room:say` / `room:create` that no `room:ack` answered within this long is taken as failed. Every relay that knows rooms
 * acks; the timer only covers a frame lost with a dying socket. A transport guard, not a balance number (like SocialSync's).
 */
const ROOM_ACK_TIMEOUT_MS = 10_000;
/** Invites mirrored at most (the relay has no per-invitee cap; this only bounds a hostile frame). */
const INVITES_MAX = 64;
const PRESENCES: ReadonlySet<string> = new Set<PresenceState>(['offline', 'ship', 'raid', 'training']);
const SYSTEM_KINDS: ReadonlySet<string> = new Set<RoomSystemKind>(['create', 'join', 'leave', 'kick', 'rename', 'owner']);

function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null; }
function errCode(v: unknown): RoomErrorCode | undefined {
  if (typeof v !== 'string') return undefined;
  const known = Object.prototype.hasOwnProperty.call(ROOM_ERROR_MESSAGE_KO, v) || Object.prototype.hasOwnProperty.call(SOCIAL_ERROR_MESSAGE_KO, v);
  return known ? v as RoomErrorCode : undefined;
}
function nameOf(v: unknown, code: PlayerCode): string {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, NAME_MAX) : formatPlayerCode(code);
}
/** Same line twice (a history page overlapping lines already pushed live): same time + author + kind + text. */
function sameLine(a: RoomLine, b: RoomLine): boolean {
  return a.at === b.at && a.code === b.code && a.text === b.text && a.system === b.system;
}

/**
 * `ctx.net.rooms` (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」): client mirror of the relay's **단체 메신저방**. Same shape as
 * `SocialSync`: NetSystem injects `bus` / `send` / `serverNow` / `me` (my card, from the social mirror) / `isBlocked` and feeds it
 * the socket frames:
 *   - `onWelcome()`        → a new connection; the relay pushes `room:state` right after `welcome` for a token socket, so there is
 *                            **no** automatic `room:get` (an older relay would answer that frame with `lobby:error invalid`).
 *   - `onState(m)`         → `room:state` — rooms + invites, sanitized, `room:updated {first}`, a new invite → `room:invited` once.
 *   - `onLine(m)`          → `room:line` — appended to that room's cache, the room's `last*` preview moves, `room:line`.
 *   - `onAck(m)`           → my `pending` line → `sent` / `failed` (`room:lineUpdated`); a refused `room:create` → `room:error`.
 *   - `onHistory(m)`       → a page merged into the cache (deduped), `room:history {room}`.
 *   - `onError(m)`         → `room:error`.
 *   - `onDisconnected()`   → `available=false`, rooms + invites emptied, pending lines `failed` (the line cache is kept).
 *
 * The client never edits membership: every mutation is a request answered by a fresh `room:state` (a declined / accepted invite
 * leaves the local list at once — the one optimistic change). **Unread** is client-side: a per-room `readAt` in
 * `slotKey(ROOM_READ_STORAGE_KEY)`. A room seen for the first time starts read up to its last line (its earlier history predates
 * this character joining it). My own lines, system lines and lines from players I blocked never count — but those lines stay in
 * the cache: **ui/ hides blocked authors itself** (`ctx.net.social.isBlocked`).
 */
export class RoomSync implements RoomsRef {
  private _available = false;
  private _rooms: RoomInfo[] = [];
  private _invites: RoomInvite[] = [];
  private readonly lines = new Map<RoomId, RoomLine[]>();
  private readonly more = new Map<RoomId, boolean>();
  /** My lines waiting for `room:ack`, by nonce (the objects are the cached ones). */
  private readonly pending = new Map<number, { line: RoomLine; timer: ReturnType<typeof setTimeout> }>();
  /** `room:create` frames waiting for their ack. */
  private readonly pendingCreate = new Map<number, ReturnType<typeof setTimeout>>();
  /** Invites already announced on this page (`room:invited` once per `room|from|at`). */
  private readonly seenInvites = new Set<string>();
  private announced = false;
  private nonceSeq = 0;
  private readAt: Record<RoomId, number> | null = null;
  private lastUnread: number | null = null;

  /* ── wired by NetSystem ── */
  send: (msg: ClientToServer) => boolean = () => false;
  serverNow: () => number = () => Date.now();
  /** My own card (the social mirror's `me`) — authors my pending lines. */
  me: () => SocialCard | null = () => null;
  /** Players I blocked (the social mirror) — excluded from unread counts and invite announcements. */
  isBlocked: (code: PlayerCode) => boolean = () => false;
  bus: EventBus | null = null;

  /* ── RoomsRef ── */
  get available(): boolean { return this._available; }
  get rooms(): readonly RoomInfo[] { return this._rooms; }
  get invites(): readonly RoomInvite[] { return this._invites; }

  find(room: RoomId): RoomInfo | undefined { return this._rooms.find((r) => r.id === room); }

  history(room: RoomId): readonly RoomLine[] { return (this.lines.get(room) ?? []).map((l) => ({ ...l })); }

  requestHistory(room: RoomId, before?: number): void {
    if (!this._available || !isValidRoomId(room) || !this.find(room)) return;
    this.send(isNum(before) ? { t: 'room:history', room, before } : { t: 'room:history', room });
  }

  hasMore(room: RoomId): boolean { return this.more.get(room) ?? true; }

  create(name: string, invite?: readonly PlayerCode[]): boolean {
    if (!this._available) return false;
    const clean = sanitizeRoomName(name);
    if (!clean) return false;
    const codes: PlayerCode[] = [];
    for (const raw of invite ?? []) {
      const c = normalizePlayerCode(raw);
      if (c && !codes.includes(c) && c !== this.me()?.code) codes.push(c);
      if (codes.length >= ROOM_MEMBER_MAX - 1) break;
    }
    const nonce = ++this.nonceSeq;
    const msg: ClientToServer = codes.length > 0 ? { t: 'room:create', name: clean, invite: codes, nonce } : { t: 'room:create', name: clean, nonce };
    if (!this.send(msg)) return false;
    this.pendingCreate.set(nonce, setTimeout(() => this.pendingCreate.delete(nonce), ROOM_ACK_TIMEOUT_MS));
    return true;
  }

  invite(room: RoomId, code: PlayerCode): void {
    const c = normalizePlayerCode(code);
    if (!this.known(room) || c === '') return;
    this.send({ t: 'room:invite', room, code: c });
  }

  respond(room: RoomId, accept: boolean): void {
    if (!this._available || !isValidRoomId(room) || !this._invites.some((i) => i.room === room)) return;
    if (!this.send({ t: 'room:reply', room, accept: !!accept })) return;
    this._invites = this._invites.filter((i) => i.room !== room);
    this.bus?.emit('room:updated', { first: false });
  }

  leave(room: RoomId): void {
    if (!this.known(room)) return;
    this.send({ t: 'room:leave', room });
  }

  kick(room: RoomId, code: PlayerCode): void {
    const c = normalizePlayerCode(code);
    if (!this.known(room) || c === '') return;
    this.send({ t: 'room:kick', room, code: c });
  }

  rename(room: RoomId, name: string): void {
    const clean = sanitizeRoomName(name);
    if (!this.known(room) || !clean) return;
    this.send({ t: 'room:rename', room, name: clean });
  }

  say(room: RoomId, text: string): boolean {
    if (!this.known(room)) return false;
    const body = sanitizeRoomText(text);
    const me = this.me();
    if (!body || !me) return false;
    const nonce = ++this.nonceSeq;
    if (!this.send({ t: 'room:say', room, text: body, nonce })) return false;
    const line: RoomLine = { room, code: me.code, name: me.name || formatPlayerCode(me.code), text: body, at: this.serverNow(), nonce, state: 'pending' };
    const timer = setTimeout(() => this.resolveLine(nonce, 'failed', 'unavailable'), ROOM_ACK_TIMEOUT_MS);
    this.pending.set(nonce, { line, timer });
    this.insert(line);
    this.bumpPreview(line);
    // Writing into a room means I have read it.
    this.setReadAt(room, line.at);
    this.bus?.emit('room:line', { line: { ...line } });
    this.emitUnread();
    return true;
  }

  unread(room: RoomId): number {
    const r = this.find(room);
    if (!r) return 0;
    const readAt = this.readMap()[room] ?? RoomSync.lastOf(r);
    const myCode = this.me()?.code ?? '';
    let n = 0;
    for (const l of this.lines.get(room) ?? []) if (l.at > readAt && this.counts(l.code, l.system, myCode)) n++;
    // Lines that arrived while this page had no cache of the room (offline / history not loaded): the preview says one did.
    if (n === 0 && r.lastAt > readAt && r.lastCode !== undefined && this.counts(r.lastCode, r.lastSystem, myCode)) n = 1;
    return n;
  }

  markRead(room: RoomId): void {
    const r = this.find(room);
    if (!r) return;
    let at = RoomSync.lastOf(r);
    for (const l of this.lines.get(room) ?? []) at = Math.max(at, l.at);
    this.setReadAt(room, at);
    this.emitUnread();
  }

  get unreadTotal(): number {
    let n = 0;
    for (const r of this._rooms) n += this.unread(r.id);
    return n;
  }

  /* ── fed by NetSystem ─────────────────────────────────────────────────── */

  onWelcome(): void { this.announced = false; }

  onState(m: { rooms?: unknown }): void {
    const snap = isObj(m.rooms) ? m.rooms : null;
    if (!snap || !Array.isArray(snap.rooms) || !Array.isArray(snap.invites)) { console.warn('[net] malformed room:state dropped'); return; }
    const rooms: RoomInfo[] = [];
    for (const raw of snap.rooms) {
      const r = RoomSync.sanitizeRoom(raw);
      if (r && !rooms.some((x) => x.id === r.id)) rooms.push(r);
      if (rooms.length >= ROOM_JOINED_MAX) break;
    }
    rooms.sort((a, b) => b.lastAt - a.lastAt);
    const invites: RoomInvite[] = [];
    for (const raw of snap.invites) {
      const i = RoomSync.sanitizeInvite(raw);
      if (i && !this.isBlocked(i.from) && !rooms.some((r) => r.id === i.room) && !invites.some((x) => x.room === i.room)) invites.push(i);
      if (invites.length >= INVITES_MAX) break;
    }
    this._available = true;
    this._rooms = rooms;
    this._invites = invites;
    /* caches of rooms I am no longer in go; a room seen for the first time starts read up to its last line */
    const ids = new Set(rooms.map((r) => r.id));
    for (const id of [...this.lines.keys()]) if (!ids.has(id)) { this.lines.delete(id); this.more.delete(id); }
    const read = this.readMap();
    let changed = false;
    for (const id of Object.keys(read)) if (!ids.has(id)) { delete read[id]; changed = true; }
    for (const r of rooms) if (read[r.id] === undefined) { read[r.id] = RoomSync.lastOf(r); changed = true; }
    if (changed) this.saveRead();
    const first = !this.announced;
    this.announced = true;
    for (const inv of invites) {
      const key = `${inv.room}|${inv.from}|${inv.at}`;
      if (this.seenInvites.has(key)) continue;
      this.seenInvites.add(key);
      if (this.seenInvites.size > 128) this.seenInvites.delete(this.seenInvites.values().next().value as string);
      this.bus?.emit('room:invited', { invite: { ...inv } });
    }
    this.bus?.emit('room:updated', { first });
    this.emitUnread();
  }

  onLine(m: { line?: unknown }): void {
    const line = RoomSync.sanitizeLine(m.line);
    if (!line) return;
    if (!this.insert(line)) return;   // already have it
    this.bumpPreview(line);
    this.bus?.emit('room:line', { line: { ...line } });
    this.emitUnread();
  }

  onAck(m: { nonce?: unknown; ok?: unknown; room?: unknown; at?: unknown; code?: unknown }): void {
    if (!isNum(m.nonce)) return;
    const create = this.pendingCreate.get(m.nonce);
    if (create !== undefined) {
      clearTimeout(create);
      this.pendingCreate.delete(m.nonce);
      if (m.ok !== true) {
        const code = errCode(m.code) ?? 'invalid';
        this.bus?.emit('room:error', { code, message: roomErrorMessage(code) });
      }
      return;
    }
    if (m.ok === true) this.resolveLine(m.nonce, 'sent', undefined, isNum(m.at) ? m.at : undefined);
    else this.resolveLine(m.nonce, 'failed', errCode(m.code) ?? 'invalid');
  }

  onHistory(m: { room?: unknown; lines?: unknown; more?: unknown }): void {
    if (!isValidRoomId(m.room) || !Array.isArray(m.lines)) return;
    const room = m.room;
    for (const raw of m.lines.slice(-ROOM_HISTORY_PAGE * 2)) {
      const line = RoomSync.sanitizeLine(raw);
      if (line && line.room === room) this.insert(line);
    }
    this.more.set(room, m.more === true);
    this.bus?.emit('room:history', { room });
    this.emitUnread();
  }

  onError(m: { code?: unknown; message?: unknown }): void {
    const code = errCode(m.code) ?? 'invalid';
    this.bus?.emit('room:error', { code, message: typeof m.message === 'string' && m.message ? m.message.slice(0, 120) : roomErrorMessage(code) });
  }

  onDisconnected(): void {
    const had = this._available || this._rooms.length > 0 || this._invites.length > 0;
    this._available = false;
    this._rooms = [];
    this._invites = [];
    this.announced = false;
    for (const nonce of [...this.pending.keys()]) this.resolveLine(nonce, 'failed', 'unavailable');
    for (const t of this.pendingCreate.values()) clearTimeout(t);
    this.pendingCreate.clear();
    if (had) this.bus?.emit('room:updated', { first: false });
    this.emitUnread();
  }

  dispose(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const t of this.pendingCreate.values()) clearTimeout(t);
    this.pendingCreate.clear();
  }

  /* ── internals ────────────────────────────────────────────────────────── */

  private known(room: RoomId): boolean { return this._available && isValidRoomId(room) && !!this.find(room); }

  private counts(code: PlayerCode, system: RoomSystemKind | undefined, myCode: PlayerCode): boolean {
    return system === undefined && code !== myCode && !this.isBlocked(code);
  }

  /** Insert by time into the room's cache (deduped, capped). false = it was already there. */
  private insert(line: RoomLine): boolean {
    let list = this.lines.get(line.room);
    if (!list) { list = []; this.lines.set(line.room, list); }
    if (list.some((l) => sameLine(l, line))) return false;
    let i = list.length;
    while (i > 0 && list[i - 1].at > line.at) i--;
    list.splice(i, 0, line);
    if (list.length > ROOM_LINES_MAX) list.splice(0, list.length - ROOM_LINES_MAX);
    return true;
  }

  /** The room's `last*` preview follows the newest line, and the list re-sorts. */
  private bumpPreview(line: RoomLine): void {
    const r = this.find(line.room);
    if (!r || line.at < r.lastAt) return;
    r.lastAt = line.at;
    r.lastText = line.system ? roomSystemTextKo(line) : line.text;
    r.lastCode = line.code;
    if (line.system) r.lastSystem = line.system; else delete r.lastSystem;
    if (line.system === 'rename' && line.text) r.name = sanitizeRoomName(line.text) || r.name;
    this._rooms.sort((a, b) => b.lastAt - a.lastAt);
  }

  private resolveLine(nonce: number, state: 'sent' | 'failed', failCode?: RoomErrorCode, at?: number): void {
    const p = this.pending.get(nonce);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(nonce);
    const line = p.line;
    line.state = state;
    if (failCode) line.failCode = failCode; else delete line.failCode;
    if (at !== undefined && at !== line.at) {
      // keep the cache ordered by the relay's time
      const list = this.lines.get(line.room);
      const idx = list ? list.indexOf(line) : -1;
      if (list && idx >= 0) list.splice(idx, 1);
      line.at = at;
      if (list && idx >= 0) {
        let i = list.length;
        while (i > 0 && list[i - 1].at > line.at) i--;
        list.splice(i, 0, line);
      }
      if (state === 'sent') this.setReadAt(line.room, at);
    }
    this.bus?.emit('room:lineUpdated', { line: { ...line } });
  }

  private emitUnread(): void {
    const total = this.unreadTotal;
    if (total === this.lastUnread) return;
    this.lastUnread = total;
    this.bus?.emit('room:unreadChanged', { total });
  }

  private static lastOf(r: RoomInfo): number { return Math.max(r.lastAt, r.createdAt); }

  /* ── read markers (localStorage, per character slot) ── */
  private readMap(): Record<RoomId, number> {
    if (this.readAt) return this.readAt;
    const out: Record<RoomId, number> = {};
    try {
      const raw = localStorage.getItem(slotKey(ROOM_READ_STORAGE_KEY));
      const doc = raw ? JSON.parse(raw) as unknown : null;
      if (isObj(doc) && doc.v === 1 && isObj(doc.rooms)) {
        for (const [id, at] of Object.entries(doc.rooms)) if (isValidRoomId(id) && isNum(at)) out[id] = at;
      }
    } catch { /* storage off / corrupt → nothing read yet */ }
    this.readAt = out;
    return out;
  }

  private setReadAt(room: RoomId, at: number): void {
    const read = this.readMap();
    if ((read[room] ?? -Infinity) >= at) return;
    read[room] = at;
    this.saveRead();
  }

  private saveRead(): void {
    try { localStorage.setItem(slotKey(ROOM_READ_STORAGE_KEY), JSON.stringify({ v: 1, rooms: this.readMap() })); } catch { /* storage full / off */ }
  }

  /* ── static validation (inbound data is untrusted) ── */
  private static sanitizeCard(raw: unknown): SocialCard | null {
    if (!isObj(raw) || typeof raw.code !== 'string' || !isValidPlayerCode(raw.code)) return null;
    const level = isNum(raw.level) ? Math.max(0, Math.min(LEVEL_MAX, Math.floor(raw.level))) : 0;
    return { code: raw.code, name: nameOf(raw.name, raw.code), level };
  }

  static sanitizeRoom(raw: unknown): RoomInfo | null {
    if (!isObj(raw) || !isValidRoomId(raw.id)) return null;
    const name = sanitizeRoomName(raw.name);
    if (!name || typeof raw.owner !== 'string' || !isValidPlayerCode(raw.owner)) return null;
    const members: RoomMember[] = [];
    for (const m of Array.isArray(raw.members) ? raw.members : []) {
      const card = RoomSync.sanitizeCard(m);
      if (!card || members.some((x) => x.code === card.code)) continue;
      const p = (m as { presence?: unknown }).presence;
      members.push({ ...card, presence: typeof p === 'string' && PRESENCES.has(p) ? p as PresenceState : 'offline' });
      if (members.length >= ROOM_MEMBER_MAX) break;
    }
    const pending: SocialCard[] = [];
    for (const c of Array.isArray(raw.pending) ? raw.pending : []) {
      const card = RoomSync.sanitizeCard(c);
      if (card && !pending.some((x) => x.code === card.code)) pending.push(card);
      if (pending.length >= ROOM_MEMBER_MAX) break;
    }
    const createdAt = isNum(raw.createdAt) ? raw.createdAt : 0;
    const info: RoomInfo = { id: raw.id, name, owner: raw.owner, members, pending, createdAt, lastAt: isNum(raw.lastAt) ? raw.lastAt : createdAt };
    if (typeof raw.lastText === 'string') info.lastText = raw.lastText.slice(0, Math.max(ROOM_TEXT_MAX, ROOM_NAME_MAX + 40));
    if (typeof raw.lastCode === 'string' && isValidPlayerCode(raw.lastCode)) info.lastCode = raw.lastCode;
    if (typeof raw.lastSystem === 'string' && SYSTEM_KINDS.has(raw.lastSystem)) info.lastSystem = raw.lastSystem as RoomSystemKind;
    return info;
  }

  static sanitizeInvite(raw: unknown): RoomInvite | null {
    if (!isObj(raw) || !isValidRoomId(raw.room) || typeof raw.from !== 'string' || !isValidPlayerCode(raw.from)) return null;
    const name = sanitizeRoomName(raw.name);
    if (!name) return null;
    return {
      room: raw.room, name, from: raw.from, fromName: nameOf(raw.fromName, raw.from),
      members: isNum(raw.members) ? Math.max(0, Math.min(ROOM_MEMBER_MAX, Math.floor(raw.members))) : 0,
      at: isNum(raw.at) ? raw.at : 0,
    };
  }

  static sanitizeLine(raw: unknown): RoomLine | null {
    if (!isObj(raw) || !isValidRoomId(raw.room) || typeof raw.code !== 'string' || !isValidPlayerCode(raw.code) || !isNum(raw.at)) return null;
    const system = typeof raw.system === 'string' && SYSTEM_KINDS.has(raw.system) ? raw.system as RoomSystemKind : undefined;
    const text = system === 'rename' ? sanitizeRoomName(raw.text) : system ? '' : sanitizeRoomText(raw.text);
    if (!system && !text) return null;
    const line: RoomLine = { room: raw.room, code: raw.code, name: nameOf(raw.name, raw.code), text, at: raw.at };
    if (system) line.system = system;
    if (typeof raw.target === 'string' && isValidPlayerCode(raw.target)) line.target = raw.target;
    if (typeof raw.targetName === 'string' && raw.targetName.length > 0) line.targetName = raw.targetName.slice(0, NAME_MAX);
    return line;
  }
}
