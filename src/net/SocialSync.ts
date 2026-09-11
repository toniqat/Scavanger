import type {
  ClientToServer, EventBus, InviteOutcome, PlayBlock, PlayerCode, PresenceState, ServerToClient, SocialCard,
  SocialErrorCode, SocialPlayer, SocialRef, SocialSnapshot, SquadInvite, WhisperLine,
} from '@/shared';
import {
  NET_MAX_PLAYERS, SOCIAL_BLOCK_MAX, SOCIAL_ERROR_MESSAGE_KO, SOCIAL_FRIEND_MAX, SOCIAL_ME_DEBOUNCE_MS,
  SOCIAL_RECENT_MAX, SOCIAL_REQUEST_MAX, SOCIAL_WHISPER_INBOX_MAX, SOCIAL_WHISPER_MAX, SQUAD_INVITE_MAX,
  SQUAD_INVITE_TTL_S, WHISPER_HISTORY_PEERS, WHISPER_HISTORY_PER_PEER, WHISPER_STORAGE_KEY, formatPlayerCode,
  isValidLobbyCode, isValidPlayerCode, normalizeLobbyCode, normalizePlayerCode, playBlockReason, slotKey,
} from '@/shared';

/** Longest name we mirror off the wire (the relay sanitizes to 16; this is only a guard against a hostile frame). */
const NAME_MAX = 32;
/** `social:me` level clamp — the same range the server applies. */
const LEVEL_MAX = 999;
const PRESENCES: ReadonlySet<string> = new Set<PresenceState>(['offline', 'ship', 'raid', 'training']);
/** What `social:updated` carries while the feature is unavailable (the UI must read `available` first). */
const EMPTY_ME: SocialCard = { code: '', name: '', level: 0 };
const OUTCOMES: ReadonlySet<string> = new Set<InviteOutcome>(['accepted', 'declined', 'expired', 'failed', 'offline', 'superseded']);
/** Server invite ids are opaque; this only keeps a hostile frame from smuggling markup / megabytes through. */
const INVITE_ID_RE = /^[\w:.-]{1,64}$/;
/**
 * B-4: an outgoing line still `pending` this long after it went out is taken as `sent` — an **older relay** never acks.
 * A transport guard, not a balance number (like `NetClient`'s ping interval), so it lives here and not in `data/`.
 */
const WHISPER_ACK_FALLBACK_MS = 5000;
/** `social:inviteClosed.reason` as the bus carries it (the wire's `InviteOutcome` plus the two local ones). */
type InviteCloseReason = 'accepted' | 'dismissed' | 'expired' | 'declined' | 'failed' | 'offline' | 'superseded';
const LINE_STATES: ReadonlySet<string> = new Set(['pending', 'sent', 'stored', 'failed']);

function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function errCode(v: unknown): SocialErrorCode | undefined {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SOCIAL_ERROR_MESSAGE_KO, v) ? v as SocialErrorCode : undefined;
}
function inviteId(v: unknown): string | null { return typeof v === 'string' && INVITE_ID_RE.test(v) ? v : null; }

/** One conversation partner in the local 대화 기록 (`slotKey(WHISPER_STORAGE_KEY)`), newest partner first. */
interface PeerHistory { code: PlayerCode; name: string; at: number; lines: WhisperLine[] }

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
 * **2026-09-11 (B-3 · B-4)** — four more server frames and a local conversation log:
 *   - `onInviteClosed(m)` → the server closed an invite **I received** (`social:inviteClosed {id, outcome}`): the card
 *     goes, `social:inviteClosed {from, reason: outcome, id, detail}` on the bus.
 *   - `onInviteResult(m)` → how an invite **I sent** ended → `social:inviteResult` (ui/ toasts it). The row's
 *     `inviteAt` badge is cleared at once (the snapshot that follows says the same thing, later).
 *   - `onWhisperAck(m)` → my `pending` line becomes `sent` / `stored` / `failed` → `social:whisperUpdated {line}`.
 *   - `onWhisperBacklog(m)` → lines kept for me while I was offline → `social:whisper {line.backlog:true}` each.
 *   Accepting / declining an invite that carries an `id` is `social:inviteReply` (the server moves me); an invite from
 *   an older relay (no `id`) keeps the Phase 11 `lobby:join` path. `block()` is a request like every other mutation.
 *   The 대화 기록 is the **one** thing this mirror persists: per character slot, never on the server.
 *
 * **The client never edits the lists.** Every mutation is a request; the server answers with a fresh snapshot
 * (the `inviteAt` badge above is the one derived field dropped early). Apart from the 대화 기록 nothing social is
 * persisted locally — with no relay the feature is simply absent (`available === false`) and every method is an inert
 * no-op (`refresh()` excepted: it is how a connection becomes available in the first place; the history readers
 * work offline too). Inbound data is untrusted and sanitized field by field; **only `PlayerCode`s ever cross the wire**,
 * never a PeerId.
 */
export class SocialSync implements SocialRef {
  private _available = false;
  private _me: SocialCard | null = null;
  private _friends: SocialPlayer[] = [];
  private _incoming: SocialPlayer[] = [];
  private _outgoing: SocialPlayer[] = [];
  private _recent: SocialPlayer[] = [];
  private _blocked: SocialCard[] = [];
  private _invites: SquadInvite[] = [];
  /** TTL timers per invite sender. */
  private readonly inviteTimers = new Map<PlayerCode, ReturnType<typeof setTimeout>>();
  /**
   * Server invite ids already announced on this page (B-3). The relay re-sends every open invite with the **same id**
   * after a reconnect / reload; one it already announced comes back as a card only — no second `social:invited` toast.
   */
  private readonly seenInviteIds = new Set<string>();
  /** A snapshot has already been announced on this connection (`social:updated.first`). */
  private announced = false;
  /** Level to publish (`social:me`), debounced by `SOCIAL_ME_DEBOUNCE_MS`; null = nothing to say. */
  private pendingLevel: number | null = null;
  private levelTimer: ReturnType<typeof setTimeout> | null = null;
  private sentLevel: number | null = null;

  /* ── B-4: delivery state of my own lines ── */
  private nonceSeq = 0;
  /** My lines waiting for `social:whisperAck`, by nonce (the objects are the ones stored in the history). */
  private readonly pending = new Map<number, { line: WhisperLine; timer: ReturnType<typeof setTimeout> }>();
  /** This connection answered a nonce at least once — an ack-aware relay (never guess from `social:error` then). */
  private acksSeen = false;
  /** Nonce of my last social request when it was a whisper (an older relay's `social:error` is attributed to it). */
  private lastWhisperNonce: number | null = null;
  /* ── B-4: 대화 기록 (lazy — the slot is fixed for the page's lifetime) ── */
  private history: PeerHistory[] | null = null;
  private saveQueued = false;

  /* ── wired by NetSystem ── */
  /** Sends a frame when the socket is up (false otherwise). */
  send: (msg: ClientToServer) => boolean = () => false;
  /** `NetRef.serverNow()` — invite stamps / whisper echoes ride the relay clock. */
  serverNow: () => number = () => Date.now();
  /** `NetRef.joinLobby` — accepting an invite from an older relay (no `id`) goes through the ordinary lobby path. */
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
  get blocked(): readonly SocialCard[] { return this._blocked; }
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
  refresh(): void { this.request({ t: 'social:get' }); }

  requestFriend(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null || this.refuseBlocked(c)) return;
    this.request({ t: 'social:request', code: c });
  }

  respondFriend(code: PlayerCode, accept: boolean): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.request({ t: 'social:respond', code: c, accept: !!accept });
  }

  removeFriend(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null) return;
    this.request({ t: 'social:remove', code: c });
  }

  playWith(code: PlayerCode): void {
    const c = this.wanted(code);
    if (c === null || this.refuseBlocked(c)) return;
    this.request({ t: 'social:play', code: c });
  }

  /**
   * B-3: an invite with a server `id` is answered with `social:inviteReply {accept:true}` — the **server** moves me
   * (`lobby:left {reason:'moved'}` + `lobby:state`) or refuses with `social:error` (busy / full / started / expired …).
   * An invite from an older relay has no `id` and keeps the Phase 11 `lobby:join`.
   */
  acceptInvite(from: PlayerCode): void {
    const code = normalizePlayerCode(from);
    const invite = this._invites.find((i) => i.from === code);
    if (!invite) return;
    this.closeInvite(code, 'accepted');
    if (invite.id) this.request({ t: 'social:inviteReply', id: invite.id, accept: true });
    else this.joinLobby(invite.lobby);
  }

  /** The card ×: since B-3 the same as `declineInvite` (the inviter reads "…님이 초대를 거절했습니다"). */
  dismissInvite(from: PlayerCode): void { this.declineInvite(from); }

  /** B-3: `social:inviteReply {accept:false}` when the invite has an `id`; an older relay's invite just leaves the stack. */
  declineInvite(from: PlayerCode): void {
    const code = normalizePlayerCode(from);
    const invite = this._invites.find((i) => i.from === code);
    if (!invite) return;
    if (invite.id) {
      this.closeInvite(code, 'declined');
      this.request({ t: 'social:inviteReply', id: invite.id, accept: false });
    } else {
      this.closeInvite(code, 'dismissed');
    }
  }

  isBlocked(code: PlayerCode): boolean {
    const c = normalizePlayerCode(code);
    return c !== '' && this._blocked.some((b) => b.code === c);
  }

  /** B-4: `social:block`. The answer is a snapshot whose `blocked` (and pruned friend / recent lists) says what happened. */
  block(code: PlayerCode, blocked: boolean): void {
    const c = this.wanted(code);
    if (c === null) return;
    if (this._me && this._me.code === c) {
      this.bus?.emit('social:error', { code: 'self', message: SOCIAL_ERROR_MESSAGE_KO.self });
      return;
    }
    this.request({ t: 'social:block', code: c, blocked: !!blocked });
  }

  /**
   * B-4: send a whisper. The line is drawn at once (`social:whisper {line.out, state:'pending'}`) and resolved in
   * place by the relay's `social:whisperAck` (`social:whisperUpdated`) — a failure is **that line** turning `failed`,
   * never a second error toast. A row known to be offline that is not a friend (the relay only keeps lines for
   * friends) fails on the spot, still as a drawn line. A player I blocked is refused with one `social:error` toast and
   * nothing drawn. Returns false only when nothing was said at all (unavailable / empty / the socket is down) — the
   * caller then says so itself.
   */
  whisper(code: PlayerCode, text: string): boolean {
    const c = this.wanted(code);
    if (c === null) return false;
    const body = (text ?? '').trim().slice(0, SOCIAL_WHISPER_MAX);
    if (body.length === 0) return false;
    if (this.refuseBlocked(c)) return true;   // said once as a toast — nothing to draw, and no second failure line
    const row = this.find(c);
    const line: WhisperLine = { code: c, name: row?.name || this.historyName(c) || formatPlayerCode(c), text: body, at: this.serverNow(), out: true };
    if (row && row.presence === 'offline' && !this._friends.some((f) => f.code === c)) {
      line.state = 'failed';
      line.failCode = 'offline';
      this.record(line);
      this.bus?.emit('social:whisper', { line: { ...line } });
      return true;
    }
    const nonce = ++this.nonceSeq;
    if (!this.send({ t: 'social:whisper', code: c, text: body, nonce })) return false;
    this.lastWhisperNonce = nonce;
    line.nonce = nonce;
    line.state = 'pending';
    // An older relay never acks: after the grace the line counts as sent (its refusals still arrive as `social:error`).
    const timer = setTimeout(() => this.resolveLine(nonce, 'sent'), WHISPER_ACK_FALLBACK_MS);
    this.pending.set(nonce, { line, timer });
    this.record(line);
    this.bus?.emit('social:whisper', { line: { ...line } });
    return true;
  }

  whisperHistory(code: PlayerCode): readonly WhisperLine[] {
    const c = normalizePlayerCode(code);
    const peer = this.loadHistory().find((p) => p.code === c);
    return peer ? peer.lines.map((l) => ({ ...l })) : [];
  }

  whisperPeers(): readonly { code: PlayerCode; name: string; at: number }[] {
    return this.loadHistory().map((p) => ({ code: p.code, name: p.name, at: p.at }));
  }

  get lastWhisperPeer(): PlayerCode | null { return this.loadHistory()[0]?.code ?? null; }

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
    this._blocked = snap.blocked ?? [];
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
    if (this.isBlocked(invite.from)) return;   // B-4: the relay swallows these already — never draw one that slipped through
    // B-3: the relay re-sends open invites with their id after a reconnect — refresh the card, announce it once.
    const resent = invite.id !== undefined && this.seenInviteIds.has(invite.id);
    if (invite.id !== undefined) {
      this.seenInviteIds.add(invite.id);
      if (this.seenInviteIds.size > 64) this.seenInviteIds.delete(this.seenInviteIds.values().next().value as string);
    }
    const prev = this.inviteTimers.get(invite.from);
    if (prev !== undefined) { clearTimeout(prev); this.inviteTimers.delete(invite.from); }
    this._invites = this._invites.filter((i) => i.from !== invite.from);
    this._invites.push(invite);
    // Cap the stack: the oldest panel makes room for the new one (the sender is not told — it expires for them).
    while (this._invites.length > SQUAD_INVITE_MAX) {
      const oldest = this._invites[0];
      this._invites = this._invites.slice(1);
      this.clearTimer(oldest.from);
      this.bus?.emit('social:inviteClosed', oldest.id ? { from: oldest.from, reason: 'dismissed', id: oldest.id } : { from: oldest.from, reason: 'dismissed' });
    }
    const ttl = Math.max(0, invite.at + SQUAD_INVITE_TTL_S * 1000 - this.serverNow());
    this.inviteTimers.set(invite.from, setTimeout(() => this.closeInvite(invite.from, 'expired'), ttl));
    if (!resent) this.bus?.emit('social:invited', { invite });
  }

  /** B-3 `social:inviteClosed`: the relay closed an invite I received (expired · failed · offline · superseded …). */
  onInviteClosed(m: { id?: unknown; outcome?: unknown; reason?: unknown }): void {
    const id = inviteId(m.id);
    if (id === null) return;
    const invite = this._invites.find((i) => i.id === id);
    if (!invite) return;   // already answered / trimmed locally
    const outcome: InviteCloseReason = typeof m.outcome === 'string' && OUTCOMES.has(m.outcome) ? m.outcome as InviteOutcome : 'expired';
    this.closeInvite(invite.from, outcome, errCode(m.reason));
  }

  /** B-3 `social:inviteResult`: how an invite **I sent** ended. ui/ toasts it (`SOCIAL_INVITE_OUTCOME_KO`). */
  onInviteResult(m: { id?: unknown; code?: unknown; name?: unknown; outcome?: unknown; reason?: unknown }): void {
    const id = inviteId(m.id);
    const code = typeof m.code === 'string' ? normalizePlayerCode(m.code) : '';
    if (id === null || code === '' || typeof m.outcome !== 'string' || !OUTCOMES.has(m.outcome)) return;
    const outcome = m.outcome as InviteOutcome;
    const name = typeof m.name === 'string' && m.name.length > 0 ? m.name.slice(0, NAME_MAX) : (this.find(code)?.name || formatPlayerCode(code));
    // The `초대 중` badge ends with the invite. `superseded` means a newer invite to the same player is open — keep it.
    if (outcome !== 'superseded') this.clearInviteBadge(code);
    const reason = errCode(m.reason);
    this.bus?.emit('social:inviteResult', reason ? { id, code, name, outcome, reason } : { id, code, name, outcome });
  }

  /** `social:whisper`: an incoming line (`out:false`); ChatLog renders it, the 대화 기록 keeps it. */
  onWhisper(m: Extract<ServerToClient, { t: 'social:whisper' }>): void {
    const line = this.sanitizeIncoming(m);
    if (!line) return;
    this.record(line);
    this.bus?.emit('social:whisper', { line: { ...line } });
  }

  /** B-4 `social:whisperAck`: my `pending` line by nonce → `sent` / `stored` / `failed`. */
  onWhisperAck(m: { nonce?: unknown; ok?: unknown; at?: unknown; stored?: unknown; code?: unknown }): void {
    if (!isNum(m.nonce)) return;
    this.acksSeen = true;
    const at = isNum(m.at) ? m.at : undefined;
    if (m.stored === true) this.resolveLine(m.nonce, 'stored', undefined, at);
    else if (m.ok === true) this.resolveLine(m.nonce, 'sent', undefined, at);
    else this.resolveLine(m.nonce, 'failed', errCode(m.code) ?? 'offline', at);
  }

  /** B-4 `social:whisperBacklog`: friends' lines kept while I was offline, oldest first — each one drawn and recorded. */
  onWhisperBacklog(m: { lines?: unknown }): void {
    if (!Array.isArray(m.lines)) return;
    const lines: WhisperLine[] = [];
    for (const raw of m.lines.slice(0, SOCIAL_WHISPER_INBOX_MAX)) {
      const line = this.sanitizeIncoming(raw as Extract<ServerToClient, { t: 'social:whisper' }>);
      if (line) { line.backlog = true; lines.push(line); }
    }
    lines.sort((a, b) => a.at - b.at);
    for (const line of lines) {
      this.record(line);
      this.bus?.emit('social:whisper', { line: { ...line } });
    }
  }

  /** `social:play`: how the server resolved my 같이 하기 (`joined` = I am in their lobby, `invited` = they were asked). */
  onPlay(m: Extract<ServerToClient, { t: 'social:play' }>): void {
    const code = normalizePlayerCode(m.code);
    if (code === '' || (m.outcome !== 'joined' && m.outcome !== 'invited')) return;
    const name = typeof m.name === 'string' && m.name.length > 0 ? m.name.slice(0, NAME_MAX) : formatPlayerCode(code);
    this.bus?.emit('social:play', { code, name, outcome: m.outcome });
  }

  /**
   * `social:error`: the server refused a request; `message` is already the Korean line. B-4: an **older relay** (no
   * ack seen on this connection) refuses a whisper this way — when my last request was a whisper still `pending`, the
   * refusal turns that line `failed` instead of raising a toast next to it.
   */
  onError(m: Extract<ServerToClient, { t: 'social:error' }>): void {
    if (typeof m.code !== 'string') return;
    const nonce = this.lastWhisperNonce;
    if (!this.acksSeen && nonce !== null && this.pending.has(nonce)
      && (m.code === 'offline' || m.code === 'not_found' || m.code === 'invalid' || m.code === 'self')) {
      this.lastWhisperNonce = null;
      this.resolveLine(nonce, 'failed', m.code);
      return;
    }
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
    this._blocked = [];
    for (const invite of this._invites) this.clearTimer(invite.from);
    this._invites = [];
    this.announced = false;
    if (this.levelTimer !== null) { clearTimeout(this.levelTimer); this.levelTimer = null; }
    this.sentLevel = null;   // re-publish the level on the next connection
    // B-4: a line still waiting for its ack went out on a socket that is gone — nobody will ever say it arrived.
    for (const nonce of Array.from(this.pending.keys())) this.resolveLine(nonce, 'failed', 'unavailable');
    this.acksSeen = false;
    this.lastWhisperNonce = null;
    if (had) this.bus?.emit('social:updated', { snapshot: this.snapshot(), first: false });
  }

  /** Drop every timer (NetSystem.dispose). */
  dispose(): void {
    for (const t of this.inviteTimers.values()) clearTimeout(t);
    this.inviteTimers.clear();
    if (this.levelTimer !== null) { clearTimeout(this.levelTimer); this.levelTimer = null; }
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    if (this.saveQueued) { this.saveQueued = false; this.saveHistory(); }
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
      blocked: this._blocked.slice(),
    };
  }

  /** Every social request except a whisper: it also ends the window in which an old relay's error means "that whisper". */
  private request(msg: ClientToServer): boolean {
    this.lastWhisperNonce = null;
    return this.send(msg);
  }

  /**
   * B-4: I blocked `code` — the relay answers a friend request / 같이 하기 / whisper to them with a bare
   * `social:error invalid`, so say the real reason here instead and send nothing. True = refused.
   */
  private refuseBlocked(code: PlayerCode): boolean {
    if (!this.isBlocked(code)) return false;
    this.bus?.emit('social:error', { code: 'invalid', message: '차단한 상대입니다 — 차단을 해제하면 보낼 수 있습니다' });
    return true;
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

  private closeInvite(from: PlayerCode, reason: InviteCloseReason, detail?: SocialErrorCode): void {
    const invite = from === '' ? undefined : this._invites.find((i) => i.from === from);
    if (!invite) return;
    this._invites = this._invites.filter((i) => i !== invite);
    this.clearTimer(from);
    this.bus?.emit('social:inviteClosed', {
      from, reason, ...(invite.id ? { id: invite.id } : {}), ...(detail ? { detail } : {}),
    });
  }

  /** B-3: the invite I sent to `code` is over — drop the row's `inviteAt` so the `초대 중` badge goes now. */
  private clearInviteBadge(code: PlayerCode): void {
    let changed = false;
    const strip = (list: SocialPlayer[]): SocialPlayer[] => list.map((p) => {
      if (p.code !== code || p.inviteAt === undefined) return p;
      changed = true;
      const { inviteAt: _gone, ...rest } = p;
      return rest;
    });
    this._friends = strip(this._friends);
    this._incoming = strip(this._incoming);
    this._outgoing = strip(this._outgoing);
    this._recent = strip(this._recent);
    if (changed && this._available) this.bus?.emit('social:updated', { snapshot: this.snapshot(), first: false });
  }

  /** B-4: settle my pending line `nonce` (ack, the old-relay grace, an old relay's error, a dropped socket). */
  private resolveLine(nonce: number, state: 'sent' | 'stored' | 'failed', failCode?: SocialErrorCode, at?: number): void {
    const p = this.pending.get(nonce);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(nonce);
    if (this.lastWhisperNonce === nonce) this.lastWhisperNonce = null;
    const line = p.line;   // the same object the 대화 기록 holds
    line.state = state;
    if (failCode) line.failCode = failCode; else delete line.failCode;
    if (at !== undefined) line.at = at;
    this.saveSoon();
    this.bus?.emit('social:whisperUpdated', { line: { ...line } });
  }

  private sanitizeIncoming(m: { code?: unknown; name?: unknown; text?: unknown; at?: unknown }): WhisperLine | null {
    if (typeof m !== 'object' || m === null) return null;
    const code = typeof m.code === 'string' ? normalizePlayerCode(m.code) : '';
    if (code === '' || this.isBlocked(code)) return null;
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, SOCIAL_WHISPER_MAX) : '';
    if (text.length === 0) return null;
    const name = typeof m.name === 'string' && m.name.length > 0 ? m.name.slice(0, NAME_MAX) : formatPlayerCode(code);
    return { code, name, text, at: isNum(m.at) ? m.at : this.serverNow(), out: false };
  }

  private sanitizeInvite(raw: unknown): SquadInvite | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const w = raw as Partial<SquadInvite>;
    const from = typeof w.from === 'string' ? normalizePlayerCode(w.from) : '';
    if (from === '') return null;
    const lobby = typeof w.lobby === 'string' ? normalizeLobbyCode(w.lobby) : '';
    if (!isValidLobbyCode(lobby)) return null;
    const name = typeof w.name === 'string' && w.name.length > 0 ? w.name.slice(0, NAME_MAX) : formatPlayerCode(from);
    const invite: SquadInvite = { from, name, lobby, at: isNum(w.at) ? w.at : this.serverNow() };
    const id = inviteId(w.id);
    if (id !== null) invite.id = id;
    return invite;
  }

  /* ── B-4: 대화 기록 (localStorage, per character slot) ── */
  private loadHistory(): PeerHistory[] {
    if (this.history) return this.history;
    let list: PeerHistory[] = [];
    try {
      const raw = localStorage.getItem(slotKey(WHISPER_STORAGE_KEY));
      if (raw) list = SocialSync.sanitizeHistory(JSON.parse(raw));
    } catch { list = []; }
    this.history = list;
    return list;
  }

  /** The name the 대화 기록 last saw for `code` (a whisper to someone who is on none of my lists). */
  private historyName(code: PlayerCode): string {
    return this.loadHistory().find((p) => p.code === code)?.name ?? '';
  }

  /** Append one line (either direction) to its partner's log; the partner moves to the front (`lastWhisperPeer`). */
  private record(line: WhisperLine): void {
    const list = this.loadHistory();
    const i = list.findIndex((p) => p.code === line.code);
    const peer: PeerHistory = i >= 0 ? list.splice(i, 1)[0] : { code: line.code, name: line.name, at: line.at, lines: [] };
    if (line.name && line.name !== formatPlayerCode(line.code)) peer.name = line.name;
    // Oldest first by `at` — a backlog line is older than what may already be there.
    let at = peer.lines.length;
    while (at > 0 && peer.lines[at - 1].at > line.at) at--;
    peer.lines.splice(at, 0, line);
    if (peer.lines.length > WHISPER_HISTORY_PER_PEER) peer.lines.splice(0, peer.lines.length - WHISPER_HISTORY_PER_PEER);
    peer.at = Math.max(peer.at, line.at);
    list.unshift(peer);
    if (list.length > WHISPER_HISTORY_PEERS) list.length = WHISPER_HISTORY_PEERS;
    this.saveSoon();
  }

  /** One write per task, however many lines (a backlog) arrived in it. */
  private saveSoon(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      if (!this.saveQueued) return;
      this.saveQueued = false;
      this.saveHistory();
    });
  }

  private saveHistory(): void {
    const list = this.history;
    if (!list) return;
    const doc = {
      v: 1,
      peers: list.map((p) => ({
        code: p.code, name: p.name, at: p.at,
        lines: p.lines.map((l) => {
          const o: Record<string, unknown> = { name: l.name, text: l.text, at: l.at, out: l.out };
          if (l.state) o.state = l.state;
          if (l.failCode) o.failCode = l.failCode;
          if (l.backlog) o.backlog = true;
          return o;
        }),
      })),
    };
    try { localStorage.setItem(slotKey(WHISPER_STORAGE_KEY), JSON.stringify(doc)); } catch { /* storage full / unavailable */ }
  }

  /** Untrusted on the way back in too (another build, a hand edit). A line still `pending` at save time reads as `sent`. */
  private static sanitizeHistory(raw: unknown): PeerHistory[] {
    if (typeof raw !== 'object' || raw === null) return [];
    const peers = (raw as { v?: unknown; peers?: unknown }).peers;
    if ((raw as { v?: unknown }).v !== 1 || !Array.isArray(peers)) return [];
    const out: PeerHistory[] = [];
    for (const p of peers) {
      if (out.length >= WHISPER_HISTORY_PEERS) break;
      if (typeof p !== 'object' || p === null) continue;
      const w = p as { code?: unknown; name?: unknown; at?: unknown; lines?: unknown };
      if (typeof w.code !== 'string' || !isValidPlayerCode(w.code) || out.some((q) => q.code === w.code)) continue;
      const code = w.code;
      const name = typeof w.name === 'string' ? w.name.slice(0, NAME_MAX) : '';
      const lines: WhisperLine[] = [];
      for (const l of Array.isArray(w.lines) ? w.lines.slice(-WHISPER_HISTORY_PER_PEER) : []) {
        if (typeof l !== 'object' || l === null) continue;
        const e = l as { name?: unknown; text?: unknown; at?: unknown; out?: unknown; state?: unknown; failCode?: unknown; backlog?: unknown };
        const text = typeof e.text === 'string' ? e.text.slice(0, SOCIAL_WHISPER_MAX) : '';
        if (text.length === 0 || !isNum(e.at)) continue;
        const line: WhisperLine = { code, name: typeof e.name === 'string' ? e.name.slice(0, NAME_MAX) : name, text, at: e.at, out: e.out === true };
        if (typeof e.state === 'string' && LINE_STATES.has(e.state)) line.state = e.state === 'pending' ? 'sent' : e.state as WhisperLine['state'];
        const fc = errCode(e.failCode);
        if (fc && line.state === 'failed') line.failCode = fc;
        if (e.backlog === true) line.backlog = true;
        lines.push(line);
      }
      lines.sort((a, b) => a.at - b.at);
      out.push({ code, name: name || formatPlayerCode(code), at: isNum(w.at) ? w.at : (lines.at(-1)?.at ?? 0), lines });
    }
    return out;
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
    if (isNum(w.inviteAt)) row.inviteAt = w.inviteAt;   // B-3: `초대 중` badge
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

  private static sanitizeCards(raw: unknown, cap: number): SocialCard[] {
    if (!Array.isArray(raw)) return [];
    const out: SocialCard[] = [];
    for (const e of raw) {
      const card = SocialSync.sanitizeCard(e);
      if (card && !out.some((p) => p.code === card.code)) out.push(card);
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
      blocked: SocialSync.sanitizeCards(w.blocked, SOCIAL_BLOCK_MAX),
    };
  }
}
