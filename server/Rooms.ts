/**
 * server/Rooms.ts — 단체 메신저방 저장소 (2026-09-14, docs/DECISIONS.md 「2026-09-14 — 메신저 · NPC 퀘스트 · 단체방」).
 *
 * 방은 **서버 권위 · 영속**이다. 이 파일은 데이터와 규칙(멤버 · 방장 · 초대 · 줄 · 한도)만 갖고, 누가 친구인지 · 누가 누구를
 * 차단했는지 · 접속해 있는지는 모른다 — 그건 `RelayServer` 가 `ProfileStore` 로 먼저 보고 여기를 부른다. 그래서 모든 연산은
 * 소켓 없이 부를 수 있고 (selftest 가 한도 · 방장 이관 · GC 를 직접 돌린다) 결과로 **붙은 줄**과 **`room:state` 를 새로 받아야 할
 * 아이디 목록**을 돌려준다.
 *
 * 규칙 (사용자 결정 「방장형」):
 *  - 누구나 만든다 (만든 사람 = 방장). 한 사람이 든 방은 `ROOM_JOINED_MAX` 개.
 *  - 초대 · 강퇴 · 이름 변경은 방장만. 초대는 영속이고 `ROOM_INVITE_TTL_MS` 뒤 사라진다. 멤버는 `ROOM_MEMBER_MAX` 명.
 *  - 방장이 나가면 **가장 먼저 들어온 멤버**가 방장 (시스템 줄 `owner`), 마지막 멤버가 나가면 방 삭제 (열린 초대도 함께).
 *  - 줄은 방마다 최근 `ROOM_LINES_MAX` 줄. 시각은 방 안에서 **엄격히 증가**한다 (`room:history {before}` 가 시각으로 자르므로 같은
 *    ms 두 줄이 한쪽을 건너뛰지 않게).
 *  - 프로필 GC 가 지운 아이디는 멤버 · 초대에서 빠진다 (`collectGarbage`).
 *
 * 저장: `<dataDir>/rooms.json` — `Store.ts` 와 같은 춤 (디바운스 비동기 쓰기 = tmp + fsync → 이전 파일 → `.bak` → tmp → 본 파일,
 * `flush()` · `close()` 는 동기). 읽다 깨지면 원본을 `rooms.corrupt-<시각>.json` 으로 옮기고 `.bak` 에서 복구, 그것도 없으면 빈 채로
 * 시작하되 원본은 남는다. 옮기지도 못하면 메모리로만 돈다 (덮어쓰지 않는다).
 *
 * Erasable-TypeScript only (runs under Node 24's native type stripping).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { PlayerCode, RoomErrorCode, RoomId, RoomLine, RoomRecord, RoomSystemKind } from '../src/shared/social.ts';
import {
  ROOM_HISTORY_PAGE, ROOM_INVITE_TTL_MS, ROOM_JOINED_MAX, ROOM_LINES_MAX, ROOM_MEMBER_MAX, ROOM_NAME_MAX, ROOM_TEXT_MAX,
  formatPlayerCode, isValidPlayerCode, isValidRoomId, sanitizeRoomName, sanitizeRoomText,
} from '../src/shared/social.ts';

export const ROOM_FILE = 'rooms.json';
export const ROOM_BACKUP_SUFFIX = '.bak';
export const ROOM_SAVE_DEBOUNCE_MS = 1000;
/** Name the unreadable file is kept under (never deleted). */
export function corruptRoomFileName(now: Date = new Date()): string {
  return `rooms.corrupt-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}

type StoredLine = RoomRecord['lines'][number];

export interface RoomActor { code: PlayerCode; name: string }

/** A successful mutation: the room after it (null = deleted), the lines it appended, and who needs a fresh `room:state`. */
export type RoomOp =
  | { ok: true; roomId: RoomId; room: RoomRecord | null; lines: RoomLine[]; notify: PlayerCode[] }
  | { ok: false; code: RoomErrorCode };

export interface RoomGcReport {
  /** Rooms deleted because no member was left. */
  deleted: RoomId[];
  /** Members / invites dropped (unknown 아이디 or an expired invite). */
  droppedMembers: number;
  expiredInvites: number;
  /** System lines appended (owner handoffs) — the relay fans them out. */
  lines: { room: RoomRecord; line: RoomLine }[];
  /** 아이디 whose `room:state` changed. */
  notify: PlayerCode[];
}

export interface RoomStoreOptions {
  /** Directory of `rooms.json` (`null` = memory only). */
  dataDir?: string | null;
  saveDebounceMs?: number;
  quiet?: boolean;
  /** Display name of an 아이디 for system lines the store writes on its own (GC owner handoff). Default: the dashed code. */
  nameOf?: (code: PlayerCode) => string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const SYSTEM_KINDS: ReadonlySet<string> = new Set<RoomSystemKind>(['create', 'join', 'leave', 'kick', 'rename', 'owner']);

/** A room read back from disk: shape-checked field by field, caps re-applied. null = unusable. */
function sanitizeRoom(id: string, raw: unknown): RoomRecord | null {
  if (!isValidRoomId(id) || !isRecord(raw)) return null;
  const name = sanitizeRoomName(raw.name);
  if (!name || typeof raw.owner !== 'string' || !isValidPlayerCode(raw.owner)) return null;
  const members: PlayerCode[] = [];
  for (const c of Array.isArray(raw.members) ? raw.members : []) {
    if (typeof c === 'string' && isValidPlayerCode(c) && !members.includes(c)) members.push(c);
    if (members.length >= ROOM_MEMBER_MAX) break;
  }
  if (members.length === 0) return null;
  const owner = members.includes(raw.owner) ? raw.owner : members[0];
  const invites: RoomRecord['invites'] = [];
  for (const i of Array.isArray(raw.invites) ? raw.invites : []) {
    if (!isRecord(i) || typeof i.code !== 'string' || !isValidPlayerCode(i.code) || typeof i.from !== 'string' || !isValidPlayerCode(i.from) || !isNum(i.at)) continue;
    if (members.includes(i.code) || invites.some((x) => x.code === i.code)) continue;
    invites.push({ code: i.code, from: i.from, at: i.at });
  }
  const lines: StoredLine[] = [];
  let lastAt = -Infinity;
  for (const l of Array.isArray(raw.lines) ? raw.lines.slice(-ROOM_LINES_MAX) : []) {
    if (!isRecord(l) || typeof l.code !== 'string' || !isValidPlayerCode(l.code) || !isNum(l.at) || l.at <= lastAt) continue;
    const system = typeof l.system === 'string' && SYSTEM_KINDS.has(l.system) ? l.system as RoomSystemKind : undefined;
    const text = typeof l.text === 'string' ? l.text.slice(0, Math.max(ROOM_TEXT_MAX, ROOM_NAME_MAX)) : '';
    if (!system && text.length === 0) continue;
    const line: StoredLine = { code: l.code, name: typeof l.name === 'string' ? l.name.slice(0, 32) : '', text, at: l.at };
    if (system) line.system = system;
    if (typeof l.target === 'string' && isValidPlayerCode(l.target)) line.target = l.target;
    if (typeof l.targetName === 'string') line.targetName = l.targetName.slice(0, 32);
    lines.push(line);
    lastAt = l.at;
  }
  const createdAt = isNum(raw.createdAt) ? raw.createdAt : (lines[0]?.at ?? 0);
  return { id, name, owner, members, invites, lines, createdAt, updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : createdAt };
}

export class RoomStore {
  private readonly rooms = new Map<RoomId, RoomRecord>();
  /** 아이디 → rooms it is a member of. */
  private readonly byMember = new Map<PlayerCode, Set<RoomId>>();
  /** 아이디 → rooms that invited it. */
  private readonly byInvitee = new Map<PlayerCode, Set<RoomId>>();
  private file: string | null;
  private readonly debounceMs: number;
  private readonly quiet: boolean;
  private readonly nameOf: (code: PlayerCode) => string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writes = 0;
  private writing: Promise<void> | null = null;
  private gen = 0;
  private closed = false;
  private loadNote: 'fresh' | 'loaded' | 'bak-recovered' | 'corrupt-recovered' | 'corrupt-empty' = 'fresh';
  private corruptPath: string | null = null;

  constructor(opts: RoomStoreOptions = {}) {
    const dir = opts.dataDir === undefined ? null : opts.dataDir;
    this.file = dir === null ? null : join(dir, ROOM_FILE);
    this.debounceMs = opts.saveDebounceMs ?? ROOM_SAVE_DEBOUNCE_MS;
    this.quiet = opts.quiet ?? false;
    this.nameOf = opts.nameOf ?? ((code) => formatPlayerCode(code));
    if (dir !== null) this.load(dir);
  }

  get size(): number { return this.rooms.size; }
  get path(): string | null { return this.file; }
  get writeCount(): number { return this.writes; }
  get loadResult(): { note: string; corruptPath: string | null } { return { note: this.loadNote, corruptPath: this.corruptPath }; }
  async idle(): Promise<void> { while (this.writing) await this.writing; }

  private log(line: string): void { if (!this.quiet) console.log(`[rooms ${new Date().toISOString()}] ${line}`); }
  private warn(line: string): void { if (!this.quiet) console.error(`[rooms ${new Date().toISOString()}] ${line}`); }

  /* ── queries ───────────────────────────────────────────────────────────── */

  get(id: RoomId): RoomRecord | undefined { return this.rooms.get(id); }

  /** Rooms `code` is a member of, last line newest first. */
  roomsOf(code: PlayerCode): RoomRecord[] {
    const out: RoomRecord[] = [];
    for (const id of this.byMember.get(code) ?? []) { const r = this.rooms.get(id); if (r) out.push(r); }
    return out.sort((a, b) => RoomStore.lastAt(b) - RoomStore.lastAt(a));
  }

  /** Open (unexpired) invites for `code`, newest first. */
  invitesOf(code: PlayerCode, now: number = Date.now()): { room: RoomRecord; from: PlayerCode; at: number }[] {
    const out: { room: RoomRecord; from: PlayerCode; at: number }[] = [];
    for (const id of this.byInvitee.get(code) ?? []) {
      const room = this.rooms.get(id);
      const inv = room?.invites.find((i) => i.code === code);
      if (room && inv && now - inv.at <= ROOM_INVITE_TTL_MS) out.push({ room, from: inv.from, at: inv.at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Unexpired invites of one room (the `pending` row of `RoomInfo`). */
  pendingOf(room: RoomRecord, now: number = Date.now()): RoomRecord['invites'] {
    return room.invites.filter((i) => now - i.at <= ROOM_INVITE_TTL_MS);
  }

  joinedCount(code: PlayerCode): number { return this.byMember.get(code)?.size ?? 0; }

  /** Time of the last line (the room's creation when it has none). */
  static lastAt(room: RoomRecord): number { return room.lines.at(-1)?.at ?? room.createdAt; }

  /** Wire form of a stored line. */
  static wire(room: RoomRecord, l: StoredLine): RoomLine {
    const out: RoomLine = { room: room.id, code: l.code, name: l.name, text: l.text, at: l.at };
    if (l.system) out.system = l.system;
    if (l.target) out.target = l.target;
    if (l.targetName !== undefined) out.targetName = l.targetName;
    return out;
  }

  /* ── mutations ─────────────────────────────────────────────────────────── */

  create(owner: RoomActor, rawName: unknown, now: number = Date.now()): RoomOp {
    const name = sanitizeRoomName(rawName);
    if (!name || !isValidPlayerCode(owner.code)) return { ok: false, code: 'invalid' };
    if (this.joinedCount(owner.code) >= ROOM_JOINED_MAX) return { ok: false, code: 'room_limit' };
    let id = randomBytes(8).toString('base64url');
    while (this.rooms.has(id)) id = randomBytes(8).toString('base64url');
    const room: RoomRecord = { id, name, owner: owner.code, members: [owner.code], invites: [], lines: [], createdAt: now, updatedAt: now };
    this.rooms.set(id, room);
    this.index(this.byMember, owner.code, id, true);
    const line = this.append(room, { code: owner.code, name: owner.name, text: '', at: now, system: 'create' });
    return { ok: true, roomId: id, room, lines: [line], notify: [owner.code] };
  }

  /** Owner-only. The relay has already checked friendship / blocks. */
  invite(roomId: RoomId, from: PlayerCode, target: PlayerCode, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(from)) return { ok: false, code: 'not_member' };
    if (room.owner !== from) return { ok: false, code: 'not_owner' };
    if (!isValidPlayerCode(target)) return { ok: false, code: 'not_found' };
    if (target === from) return { ok: false, code: 'self' };
    if (room.members.includes(target)) return { ok: false, code: 'already' };
    const prev = room.invites.find((i) => i.code === target);
    if (prev && now - prev.at <= ROOM_INVITE_TTL_MS) return { ok: false, code: 'already' };
    if (room.members.length >= ROOM_MEMBER_MAX) return { ok: false, code: 'room_full' };
    room.invites = room.invites.filter((i) => i.code !== target);
    room.invites.push({ code: target, from, at: now });
    this.index(this.byInvitee, target, roomId, true);
    this.touch(room, now);
    return { ok: true, roomId, room, lines: [], notify: [target, ...room.members] };
  }

  reply(roomId: RoomId, actor: RoomActor, accept: boolean, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    const inv = room?.invites.find((i) => i.code === actor.code);
    if (!room || !inv || now - inv.at > ROOM_INVITE_TTL_MS) {
      if (room && inv) this.dropInvite(room, actor.code, now);   // expired: tidy it away
      return { ok: false, code: 'expired' };
    }
    if (accept) {
      /* limits first: a refused accept keeps the invite (leave another room, then accept) */
      if (room.members.length >= ROOM_MEMBER_MAX) return { ok: false, code: 'room_full' };
      if (this.joinedCount(actor.code) >= ROOM_JOINED_MAX) return { ok: false, code: 'room_limit' };
    }
    this.dropInvite(room, actor.code, now);
    if (!accept) return { ok: true, roomId, room, lines: [], notify: [actor.code, ...room.members] };
    room.members.push(actor.code);
    this.index(this.byMember, actor.code, roomId, true);
    const line = this.append(room, { code: actor.code, name: actor.name, text: '', at: now, system: 'join', target: actor.code, targetName: actor.name });
    return { ok: true, roomId, room, lines: [line], notify: [...room.members] };
  }

  leave(roomId: RoomId, actor: RoomActor, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(actor.code)) return { ok: false, code: 'not_member' };
    const lines = this.removeMember(room, actor.code, actor.name, now, 'leave');
    return this.after(room, lines, [actor.code]);
  }

  kick(roomId: RoomId, owner: RoomActor, target: PlayerCode, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(owner.code)) return { ok: false, code: 'not_member' };
    if (room.owner !== owner.code) return { ok: false, code: 'not_owner' };
    if (target === owner.code) return { ok: false, code: 'self' };
    if (!room.members.includes(target)) return { ok: false, code: 'not_member' };
    room.members = room.members.filter((c) => c !== target);
    this.index(this.byMember, target, roomId, false);
    const line = this.append(room, { code: owner.code, name: owner.name, text: '', at: now, system: 'kick', target, targetName: this.nameOf(target) });
    return { ok: true, roomId, room, lines: [line], notify: [target, ...room.members] };
  }

  rename(roomId: RoomId, owner: RoomActor, rawName: unknown, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(owner.code)) return { ok: false, code: 'not_member' };
    if (room.owner !== owner.code) return { ok: false, code: 'not_owner' };
    const name = sanitizeRoomName(rawName);
    if (!name) return { ok: false, code: 'invalid' };
    if (name === room.name) return { ok: true, roomId, room, lines: [], notify: [] };
    room.name = name;
    const line = this.append(room, { code: owner.code, name: owner.name, text: name, at: now, system: 'rename' });
    return { ok: true, roomId, room, lines: [line], notify: [...room.members, ...this.pendingOf(room, now).map((i) => i.code)] };
  }

  say(roomId: RoomId, actor: RoomActor, rawText: unknown, now: number = Date.now()): RoomOp {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(actor.code)) return { ok: false, code: 'not_member' };
    const text = sanitizeRoomText(rawText);
    if (!text) return { ok: false, code: 'invalid' };
    const line = this.append(room, { code: actor.code, name: actor.name, text, at: now });
    return { ok: true, roomId, room, lines: [line], notify: [] };
  }

  /** One page older than `before` (newest page when absent), oldest first. */
  history(roomId: RoomId, code: PlayerCode, before?: number): { ok: true; lines: RoomLine[]; more: boolean } | { ok: false; code: RoomErrorCode } {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.includes(code)) return { ok: false, code: 'not_member' };
    let end = room.lines.length;
    if (before !== undefined && isNum(before)) {
      end = 0;
      while (end < room.lines.length && room.lines[end].at < before) end++;
    }
    const start = Math.max(0, end - ROOM_HISTORY_PAGE);
    return { ok: true, lines: room.lines.slice(start, end).map((l) => RoomStore.wire(room, l)), more: start > 0 };
  }

  /**
   * Profile GC follow-up + invite expiry: members whose 아이디 no longer resolves leave (owner handoff with its system line,
   * empty rooms deleted), invites past `ROOM_INVITE_TTL_MS` or naming a vanished 아이디 are dropped.
   */
  collectGarbage(resolves: (code: PlayerCode) => boolean, now: number = Date.now()): RoomGcReport {
    const report: RoomGcReport = { deleted: [], droppedMembers: 0, expiredInvites: 0, lines: [], notify: [] };
    const notify = new Set<PlayerCode>();
    for (const room of [...this.rooms.values()]) {
      const before = room.invites.length;
      const keep = room.invites.filter((i) => now - i.at <= ROOM_INVITE_TTL_MS && resolves(i.code));
      if (keep.length !== before) {
        for (const i of room.invites) if (!keep.includes(i)) { this.index(this.byInvitee, i.code, room.id, false); notify.add(i.code); }
        report.expiredInvites += before - keep.length;
        room.invites = keep;
        for (const m of room.members) notify.add(m);
        this.touch(room, now);
      }
      for (const code of [...room.members]) {
        if (resolves(code)) continue;
        report.droppedMembers++;
        const lines = this.removeMember(room, code, this.nameOf(code), now, null);
        for (const line of lines) report.lines.push({ room, line });
        for (const m of room.members) notify.add(m);
      }
      if (!this.rooms.has(room.id)) report.deleted.push(room.id);
    }
    report.notify = [...notify];
    if (report.deleted.length + report.droppedMembers + report.expiredInvites > 0) {
      this.log(`gc: ${report.deleted.length} rooms deleted, ${report.droppedMembers} members dropped, ${report.expiredInvites} invites expired (${this.rooms.size} rooms left)`);
    }
    return report;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private index(map: Map<PlayerCode, Set<RoomId>>, code: PlayerCode, id: RoomId, add: boolean): void {
    let set = map.get(code);
    if (add) {
      if (!set) { set = new Set<RoomId>(); map.set(code, set); }
      set.add(id);
    } else if (set) {
      set.delete(id);
      if (set.size === 0) map.delete(code);
    }
  }

  private dropInvite(room: RoomRecord, code: PlayerCode, now: number): void {
    room.invites = room.invites.filter((i) => i.code !== code);
    this.index(this.byInvitee, code, room.id, false);
    this.touch(room, now);
  }

  /**
   * Take `code` out of `room`: a `leave` line (`kind` null = silent — the GC), owner handoff to the earliest remaining member
   * with an `owner` line, and the room deleted (open invites with it) when nobody is left. Returns the appended lines.
   */
  private removeMember(room: RoomRecord, code: PlayerCode, name: string, now: number, kind: 'leave' | null): RoomLine[] {
    room.members = room.members.filter((c) => c !== code);
    this.index(this.byMember, code, room.id, false);
    if (room.members.length === 0) {
      for (const i of room.invites) this.index(this.byInvitee, i.code, room.id, false);
      this.rooms.delete(room.id);
      this.markDirty();
      return [];
    }
    const lines: RoomLine[] = [];
    if (kind) lines.push(this.append(room, { code, name, text: '', at: now, system: 'leave' }));
    if (room.owner === code) {
      room.owner = room.members[0];
      lines.push(this.append(room, { code, name, text: '', at: now, system: 'owner', target: room.owner, targetName: this.nameOf(room.owner) }));
    }
    this.touch(room, now);
    return lines;
  }

  /** Result of a leave: the notify list is the leaver + the remaining members (+ open invitees of a deleted room). */
  private after(room: RoomRecord, lines: RoomLine[], extra: PlayerCode[]): RoomOp {
    const alive = this.rooms.has(room.id);
    const notify = alive ? [...extra, ...room.members] : [...extra, ...room.invites.map((i) => i.code)];
    return { ok: true, roomId: room.id, room: alive ? room : null, lines, notify };
  }

  /** Append with a strictly increasing time, trim to `ROOM_LINES_MAX`, persist. */
  private append(room: RoomRecord, line: StoredLine): RoomLine {
    const last = room.lines.at(-1)?.at ?? -Infinity;
    line.at = Math.max(line.at, last + 1);
    room.lines.push(line);
    if (room.lines.length > ROOM_LINES_MAX) room.lines.splice(0, room.lines.length - ROOM_LINES_MAX);
    this.touch(room, line.at);
    return RoomStore.wire(room, line);
  }

  private touch(room: RoomRecord, now: number): void {
    room.updatedAt = Math.max(room.updatedAt, now);
    this.markDirty();
  }

  /* ── persistence (same dance as Store.ts) ──────────────────────────────── */

  private static readFile(path: string): Record<string, unknown> | null {
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    return isRecord(parsed) && isRecord(parsed.rooms) ? parsed.rooms : null;
  }

  private load(dir: string): void {
    const file = this.file!;
    const bak = `${file}${ROOM_BACKUP_SUFFIX}`;
    let data: Record<string, unknown> | null = null;
    try {
      if (!existsSync(file)) {
        if (existsSync(bak)) {
          data = RoomStore.readFile(bak);
          if (data) { this.loadNote = 'bak-recovered'; this.log(`${file} missing — recovered from ${bak}`); }
        }
        if (!data) { this.loadNote = 'fresh'; return; }
      } else {
        data = RoomStore.readFile(file);
        if (data) this.loadNote = 'loaded';
        else {
          const corrupt = join(dir, corruptRoomFileName());
          try { renameSync(file, corrupt); this.corruptPath = corrupt; } catch (e) {
            this.warn(`${file} is unreadable and could not be moved aside (${(e as Error).message}) — NOT writing this store`);
            this.file = null;
            return;
          }
          let fromBak: Record<string, unknown> | null = null;
          try { fromBak = existsSync(bak) ? RoomStore.readFile(bak) : null; } catch { fromBak = null; }
          if (fromBak) {
            data = fromBak;
            this.loadNote = 'corrupt-recovered';
            this.warn(`${file} was unreadable → kept as ${corrupt}, recovered the previous generation from ${bak}`);
          } else {
            this.loadNote = 'corrupt-empty';
            this.warn(`${file} was unreadable → kept as ${corrupt}; no usable ${bak}, starting empty (the original is preserved)`);
            return;
          }
        }
      }
      for (const [id, raw] of Object.entries(data)) {
        const room = sanitizeRoom(id, raw);
        if (!room) continue;
        this.rooms.set(id, room);
        for (const m of room.members) this.index(this.byMember, m, id, true);
        for (const i of room.invites) this.index(this.byInvitee, i.code, id, true);
      }
      if (this.loadNote !== 'loaded') this.markDirty();
      this.log(`loaded ${this.rooms.size} rooms from ${file}`);
    } catch (e) {
      this.rooms.clear();
      this.byMember.clear();
      this.byInvitee.clear();
      this.file = null;
      this.warn(`failed to read ${file}: ${(e as Error).message} — this store keeps running in memory and will NOT write`);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.file === null || this.closed || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flushAsync(); }, this.debounceMs);
    this.saveTimer.unref();
  }

  private serialize(): string {
    const rooms: Record<string, RoomRecord> = {};
    for (const [id, r] of this.rooms) rooms[id] = r;
    return JSON.stringify({ v: 1, rooms });
  }

  private flushAsync(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (this.writing || !this.dirty || this.closed) return;
    this.dirty = false;
    const gen = this.gen;
    const text = this.serialize();
    const tmp = `${file}.tmp`;
    const bak = `${file}${ROOM_BACKUP_SUFFIX}`;
    const run = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true });
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      if (existsSync(file)) await rename(file, bak);
      if (gen !== this.gen) { await rm(tmp, { force: true }); return; }
      await rename(tmp, file);
      this.writes++;
    };
    this.writing = run()
      .catch((e: unknown) => {
        if (gen === this.gen) this.dirty = true;
        this.warn(`failed to write ${file}: ${(e as Error).message}`);
      })
      .finally(() => {
        this.writing = null;
        if (this.dirty && !this.closed) this.flushAsync();
      });
  }

  /** Write now, synchronously (server close / selftest). */
  flush(): void {
    if (this.saveTimer !== null) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const file = this.file;
    if (file === null) { this.dirty = false; return; }
    if (!this.dirty && !this.writing) return;
    this.gen++;
    this.dirty = false;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-sync`;
      writeFileSync(tmp, this.serialize(), { encoding: 'utf8', flush: true });
      if (existsSync(file)) renameSync(file, `${file}${ROOM_BACKUP_SUFFIX}`);
      renameSync(tmp, file);
      this.writes++;
    } catch (e) {
      this.dirty = true;
      this.warn(`failed to write ${file}: ${(e as Error).message}`);
    }
  }

  close(): void {
    this.closed = true;
    this.flush();
  }
}
