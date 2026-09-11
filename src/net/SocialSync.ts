import type {
  ClientToServer, EventBus, PlayBlock, PlayerCode, PresenceState, ServerToClient, SocialCard, SocialPlayer,
  SocialRef, SocialSnapshot, SquadInvite, WhisperLine,
} from '@/shared';
import {
  NET_MAX_PLAYERS, SOCIAL_FRIEND_MAX, SOCIAL_ME_DEBOUNCE_MS, SOCIAL_RECENT_MAX, SOCIAL_REQUEST_MAX,
  SOCIAL_WHISPER_MAX, SQUAD_INVITE_MAX, SQUAD_INVITE_TTL_S, formatPlayerCode, isValidLobbyCode, isValidPlayerCode,
  normalizeLobbyCode, normalizePlayerCode, playBlockReason,
} from '@/shared';

/** Longest name we mirror off the wire (the relay sanitizes to 16; this is only a guard against a hostile frame). */
const NAME_MAX = 32;
/** `social:me` level clamp — the same range the server applies. */
const LEVEL_MAX = 999;
const PRESENCES: ReadonlySet<string> = new Set<PresenceState>(['offline', 'ship', 'raid', 'training']);
/** What `social:updated` carries while the feature is unavailable (the UI must read `available` first). */
const EMPTY_ME: SocialCard = { code: '', name: '', level: 0 };

function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }

/**
 * `ctx.net.social` (Phase 11): client mirror of the relay's social state — 아이디 · 친구 · 받은/보낸 요청 ·
 * 최근 만난 플레이어 · 귓속말 · 분대 초대. Modelled on `ProfileSync`: NetSystem owns it, injects `bus` / `send` /
 * `serverNow` / `joinLobby` / `squadSize` and feeds it the socket messages:
 *   - `onWelcome(social)`   → `welcome.social`; absent (anonymous socket / a relay without a store) = unavailable.
 *   - `onState(snapshot)`   → `social:state` after `social:get` and after every mutation / presence move.
 *   - `onInvited(invite)`   → `social:invited`; held for `SQUAD_INVITE_TTL_S`, at most `SQUAD_INVITE_MAX` at a time.
 *   - `onWhisper(m)`        → `social:whisper` → the `social:whisper` bus event with `out:false`.
 *   - `onPlay(m)` / `onError(m)` → the matching bus events.
 *   - `onDisconnected()`    → `available=false`, every list emptied, invites dropped, one `social:updated`.
 *
 * **The client never edits the lists.** Every mutation is a request; the server answers with a fresh snapshot.
 * Nothing social is persisted locally — with no relay the whole feature is simply absent (`available === false`) and
 * every method is an inert no-op (`refresh()` excepted: it is how a connection becomes available in the first place).
 * Inbound data is untrusted and sanitized field by field; **only `PlayerCode`s ever cross the wire**, never a PeerId.
 */
export class SocialSync implements SocialRef {
  private _available = false;
  private _me: SocialCard | null = null;
  private _friends: SocialPlayer[] = [];
  private _incoming: SocialPlayer[] = [];
  private _outgoing: SocialPlayer[] = [];
  private _recent: SocialPlayer[] = [];
  private _invites: SquadInvite[] = [];
  /** TTL timers per invite sender. */
  private readonly inviteTimers = new Map<PlayerCode, ReturnType<typeof setTimeout>>();
  /** A snapshot has already been announced on this connection (`social:updated.first`). */
  private announced = false;
  /** Level to publish (`social:me`), debounced by `SOCIAL_ME_DEBOUNCE_MS`; null = nothing to say. */
  private pendingLevel: number | null = null;
  private levelTimer: ReturnType<typeof setTimeout> | null = null;
  private sentLevel: number | null = null;

  /* ── wired by NetSystem ── */
  /** Sends a frame when the socket is up (false otherwise). */
  send: (msg: ClientToServer) => boolean = () => false;
  /** `NetRef.serverNow()` — invite stamps / whisper echoes ride the relay clock. */
  serverNow: () => number = () => Date.now();
  /** `NetRef.joinLobby` — accepting an invite goes through the ordinary lobby path. */
  joinLobby: (code: string) => void = () => {};
  /** Members in my own lobby (0 = none): the `mySquad` argument of `playBlockReason`. */
  squadSize: () => number = () => 0;
  bus: EventBus | null = null;

  /* ── SocialRef ── */
  get available(): boolean { return this._available; }
  get me(): SocialCard | null { return this._me; }
  get friends(): readonly SocialPlayer[] { return this._friends; }
  get incoming(): readonly SocialPlayer[] { return this._incoming; }
  get outgoing(): readonly SocialPlayer[] { return this._outgoing; }
  get recent(): readonly SocialPlayer[] { return this._recent; }
  get invites(): readonly SquadInvite[] { return this._invites; }
  get onlineFriends(): number {
    let n = 0;
    for (const f of this._friends) if (f.presence !== 'offline') n++;
    return n;
  }
  get hasNews(): boolean { return this._incoming.length > 0; }

  /**
   * Ask for a fresh snapshot. The only method that runs while `available` is false — `welcome.social` normally
   * supplies the first snapshot, but a relay that answered without one is still reachable through `social:get`.
   */
  refresh(): void { this.send({ t: 'social:get' }); }

  requestFriend(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.send({ t: 'social:request', code: c });
  }

  respondFriend(code: PlayerCode, accept: boolean): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.send({ t: 'social:respond', code: c, accept: !!accept });
  }

  removeFriend(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.send({ t: 'social:remove', code: c });
  }

  playWith(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.send({ t: 'social:play', code: c });
  }

  acceptInvite(from: PlayerCode): void {
    const code = normalizePlayerCode(from);
    const invite = this._invites.find((i) => i.from === code);
    if (!invite) return;
    this.closeInvite(code, 'accepted');
    this.joinLobby(invite.lobby);
  }

  dismissInvite(from: PlayerCode): void {
    this.closeInvite(normalizePlayerCode(from), 'dismissed');
  }

  /* ── 2026-09-11 계약 자리 (B-3 · B-4): ② 가 구현한다 ── */
  get blocked(): readonly SocialCard[] { return []; }
  isBlocked(_code: PlayerCode): boolean { return false; }
  block(_code: PlayerCode, _blocked: boolean): void { /* ② */ }
  declineInvite(from: PlayerCode): void { this.dismissInvite(from); }
  whisperHistory(_code: PlayerCode): readonly WhisperLine[] { return []; }
  whisperPeers(): readonly { code: PlayerCode; name: string; at: number }[] { return []; }
  get lastWhisperPeer(): PlayerCode | null { return null; }

  whisper(code: PlayerCode, text: string): boolean {
    const c = this.wanted(code);
    if (c === null) return false;
    const body = (text ?? '').trim().slice(0, SOCIAL_WHISPER_MAX);
    if (body.length === 0) return false;
    // A row we know to be offline fails locally; an unknown 아이디 goes out and the server answers `social:error`.
    const row = this.find(c);
    if (row && row.presence === 'offline') return false;
    if (!this.send({ t: 'social:whisper', code: c, text: body })) return false;
    this.bus?.emit('social:whisper', {
      line: { code: c, name: row?.name ?? formatPlayerCode(c), text: body, at: this.serverNow(), out: true },
    });
    return true;
  }

  /** Debounced `social:me`: level changes fire on every XP tick, and an offline change waits for the next snapshot. */
  setLevel(level: number): void {
    const lv = isNum(level) ? Math.max(0, Math.min(LEVEL_MAX, Math.floor(level))) : 0;
    if (lv === this.sentLevel) return;
    this.pendingLevel = lv;
    if (!this._available || this.levelTimer !== null) return;
    this.levelTimer = setTimeout(() => { this.levelTimer = null; this.flushLevel(); }, SOCIAL_ME_DEBOUNCE_MS);
  }

  find(code: PlayerCode): SocialPlayer | undefined {
    const c = normalizePlayerCode(code);
    if (c === '') return undefined;
    for (const list of [this._friends, this._incoming, this._outgoing, this._recent]) {
      const hit = list.find((p) => p.code === c);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Pure mirror of the server's own 같이 하기 gate (`playBlockReason`), so the UI greys out with the same reason. */
  playBlock(code: PlayerCode): PlayBlock | null {
    const c = normalizePlayerCode(code);
    if (c === '') return 'offline';
    if (this._me && this._me.code === c) return 'self';
    const row = this.find(c);
    if (!row) return 'offline';   // nothing known about them → nothing to offer
    return playBlockReason(row, this.squadSize(), NET_MAX_PLAYERS, false);
  }

  /* ── fed by NetSystem ─────────────────────────────────────────────────── */
  /** `welcome.social`. Absent = this connection has no social state (anonymous token / relay without a store). */
  onWelcome(social: SocialSnapshot | undefined): void {
    this.announced = false;
    if (!social) { this.onDisconnected(); return; }
    this.onState(social);
  }

  /** `social:state`: the whole snapshot, sanitized before it reaches the UI. */
  onState(raw: unknown): void {
    const snap = SocialSync.sanitizeSnapshot(raw);
    if (!snap) { console.warn('[net] malformed social:state dropped'); return; }
    this._available = true;
    this._me = snap.me;
    this._friends = snap.friends;
    this._incoming = snap.incoming;
    this._outgoing = snap.outgoing;
    this._recent = snap.recent;
    const first = !this.announced;
    this.announced = true;
    this.bus?.emit('social:updated', { snapshot: this.snapshot(), first });
    // My own level may have been reported while the socket was down (progression loads before the hub connects).
    if (this.pendingLevel !== null && this.pendingLevel !== snap.me.level) this.flushLevel();
    else if (this.pendingLevel !== null) { this.sentLevel = this.pendingLevel; this.pendingLevel = null; }
  }

  /** `social:invited`: a squad invite waiting for a P hold. Newest last; an older one from the same sender is replaced. */
  onInvited(raw: unknown): void {
    const invite = this.sanitizeInvite(raw);
    if (!invite) { console.warn('[net] malformed social:invited dropped'); return; }
    const prev = this.inviteTimers.get(invite.from);
    if (prev !== undefined) { clearTimeout(prev); this.inviteTimers.delete(invite.from); }
    this._invites = this._invites.filter((i) => i.from !== invite.from);
    this._invites.push(invite);
    // Cap the stack: the oldest panel makes room for the new one (the sender is not told — it expires for them).
    while (this._invites.length > SQUAD_INVITE_MAX) {
      const oldest = this._invites[0];
      this._invites = this._invites.slice(1);
      this.clearTimer(oldest.from);
      this.bus?.emit('social:inviteClosed', { from: oldest.from, reason: 'dismissed' });
    }
    const ttl = Math.max(0, invite.at + SQUAD_INVITE_TTL_S * 1000 - this.serverNow());
    this.inviteTimers.set(invite.from, setTimeout(() => this.closeInvite(invite.from, 'expired'), ttl));
    this.bus?.emit('social:invited', { invite });
  }

  /** `social:whisper`: an incoming line (`out:false`); ChatLog renders it. */
  onWhisper(m: Extract<ServerToClient, { t: 'social:whisper' }>): void {
    const code = normalizePlayerCode(m.code);
    if (code === '') return;
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, SOCIAL_WHISPER_MAX) : '';
    if (text.length === 0) return;
    const name = typeof m.name === 'string' && m.name.length > 0 ? m.name.slice(0, NAME_MAX) : formatPlayerCode(code);
    this.bus?.emit('social:whisper', { line: { code, name, text, at: isNum(m.at) ? m.at : this.serverNow(), out: false } });
  }

  /** `social:play`: how the server resolved my 같이 하기 (`joined` = I am in their lobby, `invited` = they were asked). */
  onPlay(m: Extract<ServerToClient, { t: 'social:play' }>): void {
    const code = normalizePlayerCode(m.code);
    if (code === '' || (m.outcome !== 'joined' && m.outcome !== 'invited')) return;
    const name = typeof m.name === 'string' && m.name.length > 0 ? m.name.slice(0, NAME_MAX) : formatPlayerCode(code);
    this.bus?.emit('social:play', { code, name, outcome: m.outcome });
  }

  /** `social:error`: the server refused a request; `message` is already the Korean line. */
  onError(m: Extract<ServerToClient, { t: 'social:error' }>): void {
    if (typeof m.code !== 'string') return;
    this.bus?.emit('social:error', { code: m.code, message: typeof m.message === 'string' ? m.message : '' });
  }

  /** Socket down: nothing social survives a connection (the server owns all of it). Invites are dropped. */
  onDisconnected(): void {
    const had = this._available || this._invites.length > 0;
    this._available = false;
    this._me = null;
    this._friends = [];
    this._incoming = [];
    this._outgoing = [];
    this._recent = [];
    for (const invite of this._invites) this.clearTimer(invite.from);
    this._invites = [];
    this.announced = false;
    if (this.levelTimer !== null) { clearTimeout(this.levelTimer); this.levelTimer = null; }
    this.sentLevel = null;   // re-publish the level on the next connection
    if (had) this.bus?.emit('social:updated', { snapshot: this.snapshot(), first: false });
  }

  /** Drop every timer (NetSystem.dispose). */
  dispose(): void {
    for (const t of this.inviteTimers.values()) clearTimeout(t);
    this.inviteTimers.clear();
    if (this.levelTimer !== null) { clearTimeout(this.levelTimer); this.levelTimer = null; }
  }

  /* ── internals ────────────────────────────────────────────────────────── */
  /** The snapshot as the mirror currently stands (what `social:updated` carries). */
  private snapshot(): SocialSnapshot {
    return {
      me: this._me ?? EMPTY_ME,
      friends: this._friends.slice(),
      incoming: this._incoming.slice(),
      outgoing: this._outgoing.slice(),
      recent: this._recent.slice(),
    };
  }

  /** Canonical 아이디 for an outgoing request, or null when the feature is off / the code is nonsense. */
  private wanted(code: PlayerCode): PlayerCode | null {
    if (!this._available) return null;
    const c = normalizePlayerCode(code);
    if (c === '') {
      this.bus?.emit('social:error', { code: 'invalid', message: '잘못된 아이디입니다' });
      return null;
    }
    return c;
  }

  private flushLevel(): void {
    const lv = this.pendingLevel;
    if (lv === null || !this._available) return;
    if (!this.send({ t: 'social:me', level: lv })) return;
    this.sentLevel = lv;
    this.pendingLevel = null;
  }

  private clearTimer(from: PlayerCode): void {
    const t = this.inviteTimers.get(from);
    if (t !== undefined) { clearTimeout(t); this.inviteTimers.delete(from); }
  }

  private closeInvite(from: PlayerCode, reason: 'accepted' | 'dismissed' | 'expired'): void {
    if (from === '' || !this._invites.some((i) => i.from === from)) return;
    this._invites = this._invites.filter((i) => i.from !== from);
    this.clearTimer(from);
    this.bus?.emit('social:inviteClosed', { from, reason });
  }

  private sanitizeInvite(raw: unknown): SquadInvite | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as Partial<SquadInvite>;
    const from = typeof w.from === 'string' ? normalizePlayerCode(w.from) : '';
    if (from === '') return null;
    const lobby = typeof w.lobby === 'string' ? normalizeLobbyCode(w.lobby) : '';
    if (!isValidLobbyCode(lobby)) return null;
    const name = typeof w.name === 'string' && w.name.length > 0 ? w.name.slice(0, NAME_MAX) : formatPlayerCode(from);
    return { from, name, lobby, at: isNum(w.at) ? w.at : this.serverNow() };
  }

  /* ── static validation (inbound data is untrusted) ── */
  private static sanitizeCard(raw: unknown): SocialCard | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as Partial<SocialCard>;
    if (typeof w.code !== 'string' || !isValidPlayerCode(w.code)) return null;
    const name = typeof w.name === 'string' ? w.name.slice(0, NAME_MAX) : '';
    const level = isNum(w.level) ? Math.max(0, Math.min(LEVEL_MAX, Math.floor(w.level))) : 0;
    return { code: w.code, name, level };
  }

  private static sanitizePlayer(raw: unknown): SocialPlayer | null {
    const card = SocialSync.sanitizeCard(raw);
    if (!card) return null;
    const w = raw as Partial<SocialPlayer>;
    const presence: PresenceState = typeof w.presence === 'string' && PRESENCES.has(w.presence)
      ? (w.presence as PresenceState) : 'offline';
    const squad = isNum(w.squad) ? Math.max(0, Math.min(NET_MAX_PLAYERS, Math.floor(w.squad))) : 0;
    const row: SocialPlayer = { ...card, presence, squad, joinable: w.joinable === true };
    if (isNum(w.at)) row.at = w.at;
    return row;
  }

  private static sanitizeList(raw: unknown, cap: number): SocialPlayer[] {
    if (!Array.isArray(raw)) return [];
    const out: SocialPlayer[] = [];
    for (const e of raw) {
      const row = SocialSync.sanitizePlayer(e);
      if (row && !out.some((p) => p.code === row.code)) out.push(row);
      if (out.length >= cap) break;
    }
    return out;
  }

  static sanitizeSnapshot(raw: unknown): SocialSnapshot | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as Partial<SocialSnapshot>;
    const me = SocialSync.sanitizeCard(w.me);
    if (!me) return null;
    return {
      me,
      friends: SocialSync.sanitizeList(w.friends, SOCIAL_FRIEND_MAX),
      incoming: SocialSync.sanitizeList(w.incoming, SOCIAL_REQUEST_MAX),
      outgoing: SocialSync.sanitizeList(w.outgoing, SOCIAL_REQUEST_MAX),
      recent: SocialSync.sanitizeList(w.recent, SOCIAL_RECENT_MAX),
    };
  }
}
