import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import {
  NET_INVITE_PARAM, NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_LENGTH, NET_TOKEN_PARAM, NET_TOKEN_STORAGE_KEY, NET_WS_PATH, PlayerFlags, RAID_BLOB_MAX_BYTES,
  isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '@/shared';
import { NetClient } from './NetClient';
import { ProfileSync } from './ProfileSync';
import { RemotePlayer } from './RemotePlayer';
import { Snapshotter } from './Snapshotter';

const NAME_STORAGE_KEY = 'scav.playerName';
const SNAPSHOT_INTERVAL = 1 / NET_PLAYER_SNAPSHOT_HZ;
/** Seconds a departed peer's RemotePlayer lingers (connected=false) before removal. */
const PEER_LINGER = 1.0;
/** Auto-reconnect attempts made when we are NOT a lobby member (with a suspended lobby we retry forever). */
const MAX_LOBBYLESS_ATTEMPTS = NET_RECONNECT_BACKOFF_MS.length;
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const PING_KINDS: ReadonlySet<string> = new Set<PingKind>(['ground', 'enemy', 'crate', 'extraction', 'item', 'attack', 'caution']);
const CHAT_KINDS: ReadonlySet<string> = new Set<ChatKind>(['text', 'ping', 'request', 'system']);

type Handler = (msg: GameMessage, from: PeerId) => void;

function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function vec(t: Vec3Tuple): THREE.Vector3 { return new THREE.Vector3(t[0], t[1], t[2]); }
function isGhostWire(g: unknown): g is GhostWire {
  if (typeof g !== 'object' || g === null) return false;
  const w = g as Partial<GhostWire>;
  return typeof w.id === 'string' && isVec3(w.p) && isNum(w.yaw) && isNum(w.hp) && isNum(w.dhp) && (w.st === 0 || w.st === 1 || w.st === 2);
}

/** Persistent per-browser session token (NET_TOKEN_LENGTH url-safe chars) — the server derives a stable PeerId from it. */
function loadOrCreateSessionToken(): string {
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
export class NetSystem implements GameSystem, NetRef {
  readonly name = 'net';

  private ctx!: GameContext;
  private readonly client = new NetClient();
  private readonly snapshotter = new Snapshotter();
  private readonly handlers = new Map<GameMessageType, Set<Handler>>();
  private readonly remotes = new Map<PeerId, RemotePlayer>();
  private remoteList: RemotePlayer[] = [];
  private lastSnapshotAt = -Infinity;

  private _playerName = sanitizePlayerName('');
  private readonly _sessionToken = loadOrCreateSessionToken();
  private _lobby: LobbyState | null = null;
  private _inSession = false;
  private _inviteCode: string | null = null;
  /** Seed of the mission we are (or were, before a drop) in. */
  private missionSeed: number | null = null;
  /** Last id the server gave us; kept through a drop so `isHost`/`isAuthority` do not flip while reconnecting. */
  private lastLocalId: PeerId | null = null;
  private pendingQuickMatch = false;

  /* ── reconnect state machine ── */
  private lastStatus: NetStatus = 'offline';
  /** `disconnect()` was called: the coming close is intentional. */
  private intentionalClose = false;
  /** The server closed us with `duplicate` (same token from another tab): never auto-reconnect after that. */
  private duplicateKicked = false;
  private _reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lobby kept alive locally while the socket is down. */
  private lobbySuspended = false;
  /** We were inside a running mission when the socket dropped (seamless-resume candidate). */
  private wasInSessionAtDrop = false;

  /* ── Phase 7 ── */
  private readonly profileSync = new ProfileSync();
  private _raidBlob: RaidSessionBlob | null = null;
  /** Mode of the session we are in (valid while `_inSession`). */
  private sessionMode: MissionMode = 'raid';
  private _tookOver = false;
  /** Host id before the last change (for `flow takeover` events that arrive after the lobby state). */
  private prevHostId: PeerId | null = null;
  /** Last `inMission` we reported per member (`net:missionMembership` diffs). */
  private readonly membership = new Map<PeerId, boolean>();
  private raidTooLargeWarned = false;
  /* ── Phase 9 ── */
  /** `serverTime - performance.now()` from the last welcome / pong of ANY connection this session (null = never welcomed). */
  private serverOffset: number | null = null;

  /* ── NetRef getters ─────────────────────────────────────────────────── */
  get status(): NetStatus { return this.client.status; }
  get connected(): boolean { return this.client.connected; }
  get localId(): PeerId | null { return this.client.localId ?? this.lastLocalId; }
  get playerName(): string { return this._playerName; }
  get lobby(): LobbyState | null { return this._lobby; }
  get inSession(): boolean { return this._inSession; }
  get isHost(): boolean { return this._lobby !== null && this.localId !== null && this._lobby.hostId === this.localId; }
  get isAuthority(): boolean { return !this._inSession || this.isHost; }
  get localSlot(): number {
    const me = this.localId ? this.getLobbyPlayer(this.localId) : undefined;
    return me ? me.slot : 0;
  }
  get rttMs(): number { return this.client.rttMs; }
  get inviteCode(): string | null { return this._inviteCode; }
  get sessionToken(): string { return this._sessionToken; }
  get reconnecting(): boolean { return this._reconnecting; }
  get missionInProgress(): boolean { return this._lobby !== null && this._lobby.started && !this._inSession; }
  get inHubSession(): boolean { return this._lobby !== null && !this._inSession && this.ctx.phase === 'hub'; }
  /* ── Phase 7 ── */
  get profile(): ProfileRef { return this.profileSync; }
  get raidBlob(): RaidSessionBlob | null { return this._raidBlob; }
  get missionMode(): MissionMode | null { return this._lobby?.started ? (this._lobby.mode ?? 'raid') : null; }
  get tookOver(): boolean { return this._tookOver; }
  /* ── Phase 8 ── */
  /**
   * Relay wall clock in epoch ms: the offset captured at the last `welcome` / `pong` plus the elapsed local time.
   * `performance.now()` is monotonic, so moving the system clock cannot advance a crop timer. Phase 9: the last
   * offset is **kept through a disconnect** (profile stamps written offline stay on the server's clock); only a
   * session that never saw a welcome falls back to `Date.now()` (single-player keeps working on the local clock).
   */
  serverNow(): number {
    const c = this.client;
    if (c.connected && c.hasServerTime) this.serverOffset = c.serverTimeOffset;
    if (this.serverOffset === null) return Date.now();
    const t = performance.now() + this.serverOffset;
    return Number.isFinite(t) ? t : Date.now();
  }

  /* ── GameSystem ─────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.net = this;
    this.profileSync.bus = ctx.bus;
    this.profileSync.send = (m) => this.client.send(m);
    this.profileSync.serverNow = () => this.serverNow();

    try {
      const stored = localStorage.getItem(NAME_STORAGE_KEY);
      if (stored) this._playerName = sanitizePlayerName(stored);
    } catch { /* storage unavailable */ }

    try {
      const raw = new URLSearchParams(location.search).get(NET_INVITE_PARAM);
      if (raw) {
        const code = normalizeLobbyCode(raw);
        this._inviteCode = isValidLobbyCode(code) ? code : null;
      }
    } catch { this._inviteCode = null; }

    this.client.onStatus = (status, reason) => {
      const wasConnected = this.lastStatus === 'connected';
      this.lastStatus = status;
      ctx.bus.emit('net:statusChanged', reason !== undefined ? { status, reason } : { status });
      if (status === 'offline' || status === 'error') {
        this.profileSync.onDisconnected();
        this.onSocketDown(wasConnected);
      }
    };
    this.client.onMessage = (msg) => {
      try { this.handleServerMessage(msg); } catch (e) { console.warn('[net] failed to handle server message', msg.t, e); }
    };

    const bus = ctx.bus;
    bus.on('weapon:equipped', (e) => {
      const has = typeof e.weaponId === 'string' && e.weaponId.length > 0;
      this.snapshotter.weaponId = has ? e.weaponId : null;
      this.snapshotter.weaponSlot = has ? e.slot : null;
    });
    bus.on('loadout:changed', (e) => {
      if (!e.primary && !e.secondary && !e.primary2) { this.snapshotter.weaponId = null; this.snapshotter.weaponSlot = null; }
    });
    bus.on('quick:equipped', (e) => { this.snapshotter.holdingItem = e.item !== null; });
    /* appended: tactical kit — gear the remote avatars render. */
    bus.on('implant:wieldChanged', (e) => { this.snapshotter.implantId = e.wielded ? e.id : null; });
    bus.on('equip:changed', (e) => { if (e.slot === 'armor') this.snapshotter.armorId = e.item ? e.item.defId : null; });
    bus.on('player:died', (e) => {
      if (this._inSession) this.send({ t: 'died', p: [e.position.x, e.position.y, e.position.z] }, 'others');
    });
    // NetSystem runs before GameFlow/Extraction, whose handlers for these same events still need `inSession`,
    // `isAuthority` and `send()` intact (they broadcast `flow abort` / `ex reset`). End the session in a microtask.
    // None of these leave the lobby: a client that aborts alone returns to the shared ship (`missionInProgress`).
    bus.on('game:complete', () => this.scheduleEndSession());
    bus.on('game:over', () => this.scheduleEndSession());
    bus.on('game:abort', () => this.scheduleEndSession());
  }

  update(dt: number, ctx: GameContext): void {
    try {
      const now = ctx.time;
      // Interpolate remotes; reap departed peers.
      let reap = false;
      for (let i = 0; i < this.remoteList.length; i++) {
        const r = this.remoteList[i];
        r.tick(now);
        if (!r.connected && now >= r.removeAt) reap = true;
      }
      if (reap) {
        for (const r of this.remoteList) if (!r.connected && now >= r.removeAt) this.removeRemote(r.id);
      }

      // Broadcast our own snapshot: in a mission (gameplay phases + hellpod drop) or while walking the shared ship.
      // Timed on unscaled ctx.time (Engine passes dt = 0 while paused, but a multiplayer pause is non-freezing and
      // peers must keep seeing us). Never in 'menu' / 'docking'.
      const missionSnapshots = this._inSession && (ctx.isGameplayPhase() || ctx.phase === 'deploying');
      if (ctx.player && (missionSnapshots || this.inHubSession)) {
        if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL) {
          this.lastSnapshotAt = now;
          const snap = this.snapshotter.build(ctx);
          if (snap) this.send(snap, 'others');
        }
      } else {
        this.lastSnapshotAt = -Infinity; // send immediately once gameplay / hub resumes
      }
    } catch (e) {
      console.warn('[net] update error', e);
    }
  }

  dispose(): void {
    this.stopReconnect();
    this.intentionalClose = true;
    this.profileSync.flush();
    this.client.close();
    this.clearRemotes();
    this.handlers.clear();
    if (this.ctx && this.ctx.net === this) this.ctx.net = null;
  }

  /* ── connection ─────────────────────────────────────────────────────── */
  connect(url?: string): Promise<void> {
    if (this.client.connected) return Promise.resolve();
    this.intentionalClose = false;
    this.duplicateKicked = false;
    // An explicit connect while the backoff timer is pending: attempt right now instead.
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const p = this.client.connect(this.withSession(url ?? this.defaultUrl()));
    // Keep the reconnect loop alive if this manual attempt fails (attemptReconnect's own catch may already have rescheduled).
    if (this._reconnecting) p.catch(() => { if (this._reconnecting && this.reconnectTimer === null) this.scheduleReconnect(); });
    return p;
  }

  async ensureConnected(): Promise<boolean> {
    if (this.client.connected) return true;
    try { await this.connect(); return true; } catch { return false; }
  }

  disconnect(): void {
    this.stopReconnect();
    this.intentionalClose = true;
    this.profileSync.flush();
    if (this._lobby || this._inSession) this.dropLobby('left');
    this.lastLocalId = null;
    this.client.close();
  }

  setPlayerName(name: string): void {
    this._playerName = sanitizePlayerName(name);
    try { localStorage.setItem(NAME_STORAGE_KEY, this._playerName); } catch { /* storage unavailable */ }
    // Already in a lobby → rename there too (server sanitizes + broadcasts).
    if (this.client.connected && this._lobby) this.client.send({ t: 'lobby:name', name: this._playerName });
  }

  private defaultUrl(): string {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.VITE_WS_URL;
    if (fromEnv) return fromEnv;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${NET_WS_PATH}`;
  }

  /** Append `?t=<token>&n=<name>` (NET_TOKEN_PARAM / NET_NAME_PARAM) to a relay URL. */
  private withSession(url: string): string {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${NET_TOKEN_PARAM}=${encodeURIComponent(this._sessionToken)}&${NET_NAME_PARAM}=${encodeURIComponent(this._playerName)}`;
  }

  /* ── reconnect ──────────────────────────────────────────────────────── */
  /** Socket went offline/error. `wasConnected` = an established (welcomed) connection dropped, not a failed attempt. */
  private onSocketDown(wasConnected: boolean): void {
    if (this.intentionalClose) return;
    if (this.duplicateKicked) {
      // Another tab took over this session: hand the lobby over to it and stay offline.
      this.stopReconnect();
      if (this._lobby || this._inSession) this.dropLobby('kicked');
      return;
    }
    if (this._reconnecting) return;           // a retry failed; attemptReconnect() schedules the next one
    if (!wasConnected) return;                // an initial connect() failed → the caller decides (offline hub)
    this.beginReconnect();
  }

  private beginReconnect(): void {
    this._reconnecting = true;
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = performance.now();
    this.lobbySuspended = this._lobby !== null;
    this.wasInSessionAtDrop = this._inSession;
    // Remotes stay (seamless resume keeps them; they go `stale` meanwhile and refresh with the next snapshots).
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this._reconnecting) return;
    const attempt = ++this.reconnectAttempt;
    const elapsed = performance.now() - this.reconnectStartedAt;
    if (this.lobbySuspended && elapsed >= NET_MISSION_RESUME_TIMEOUT_MS) {
      // Waited long enough for the party: give the lobby up locally. If the server still has our slot when we do
      // get back, `welcome.lobby` re-enters it via `net:resumed` (fresh-load semantics).
      this.lobbySuspended = false;
      this.dropLobby('disconnected');
    }
    if (!this.lobbySuspended && attempt > MAX_LOBBYLESS_ATTEMPTS) {
      this.stopReconnect();
      return;
    }
    const delay = NET_RECONNECT_BACKOFF_MS[Math.min(attempt - 1, NET_RECONNECT_BACKOFF_MS.length - 1)];
    this.ctx.bus.emit('net:reconnecting', { attempt, nextInMs: delay });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.attemptReconnect(); }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this._reconnecting) return;
    try {
      await this.client.connect(this.withSession(this.defaultUrl()));
      // Success path continues in handleServerMessage('welcome').
    } catch {
      if (this._reconnecting) this.scheduleReconnect();
    }
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._reconnecting = false;
    this.reconnectAttempt = 0;
  }

  /** `welcome` arrived (first connect, reconnect or fresh page load). */
  private onWelcome(msg: Extract<ServerToClient, { t: 'welcome' }>): void {
    const bus = this.ctx.bus;
    const resumedAfterDrop = this._reconnecting;
    this.stopReconnect();
    this.lastLocalId = msg.id;
    if (this.client.hasServerTime) this.serverOffset = this.client.serverTimeOffset;
    const lobby = msg.lobby ?? null;

    // Seamless: we were inside the mission this lobby is still running → keep inSession + remotes, nothing rebuilt.
    const seamless = lobby !== null && resumedAfterDrop && this.wasInSessionAtDrop && this._inSession
      && lobby.started && this.missionSeed !== null && lobby.seed === this.missionSeed;

    // Profile first: persisting folders replace their local state from it before any lobby / mission event. During a
    // seamless resume the documents cannot have changed (only this client writes them) — refresh availability only.
    this.profileSync.onWelcome(msg.profile, !seamless);

    if (lobby) {
      if (!seamless) {
        this._inSession = false;
        this._tookOver = false;
        this.clearRemotes();
        this.snapshotter.reset();
        this._raidBlob = msg.raid ?? null;
      } else {
        // Peers may have restarted their snapshot streams while we were away.
        for (const r of this.remoteList) r.resetStream();
      }
      this.lobbySuspended = false;
      this.applyLobby(lobby);
      this.lastSnapshotAt = -Infinity;
      // Phase 9: coming back into a running mission WITHOUT our session state (page reload, or a drop we gave up on)
      // means we left it — tell the server so the host parks our ghost and the authority never waits on us. A pod /
      // the terminal re-enters with `rejoinMission()` (which flips `inMission` back).
      if (lobby.started && !seamless && !this._inSession) {
        const me = this.getLobbyPlayer(msg.id);
        if (me && me.inMission) {
          me.inMission = false; // optimistic mirror; the broadcast confirms it
          this.client.send({ t: 'lobby:mission', inMission: false });
        }
      }
      bus.emit('net:resumed', { lobby, inProgress: lobby.started && !this._inSession, seamless });
      if (!seamless && this._raidBlob) bus.emit('net:raidLoaded', { blob: this._raidBlob });
      // Back inside the running mission: the host may hold our body as a ghost — ask for it back (`ghost restore`)
      // and let every system re-sync us. A host that kept its role through the blip has nothing to ask for.
      if (seamless && !this.isHost) this.send({ t: 'flow', ev: 'rejoined' }, 'all');
    } else if (this._lobby || this._inSession) {
      // We kept a suspended lobby but the server no longer knows us (grace expired / server restarted).
      this.lobbySuspended = false;
      this.dropLobby('disconnected');
    }
    this.wasInSessionAtDrop = false;
  }

  /* ── lobby ops ──────────────────────────────────────────────────────── */
  createLobby(): void { this.pendingQuickMatch = false; this.client.send({ t: 'lobby:create', name: this._playerName }); }
  joinLobby(code: string): void {
    const norm = normalizeLobbyCode(code);
    if (!isValidLobbyCode(norm)) {
      this.ctx.bus.emit('net:error', { code: 'invalid', message: '잘못된 로비 코드입니다. 6자리 코드를 입력하세요.' });
      return;
    }
    this.pendingQuickMatch = false;
    this.client.send({ t: 'lobby:join', code: norm, name: this._playerName });
  }
  leaveLobby(): void {
    this.pendingQuickMatch = false;
    if (this.client.connected) { this.client.send({ t: 'lobby:leave' }); return; }
    // Offline with a suspended lobby: leaving is local (the server drops our slot when the grace expires).
    this.stopReconnect();
    if (this._lobby || this._inSession) this.dropLobby('left');
  }
  setReady(ready: boolean): void { this.client.send({ t: 'lobby:ready', ready }); }
  /** Raid (default): host only, everyone ready. Training: any member; only the caller enters (`inMission`). */
  startGame(seed: number, mode?: MissionMode): void {
    const s = Math.floor(seed) >>> 0;
    this.client.send(mode ? { t: 'lobby:start', seed: s, mode } : { t: 'lobby:start', seed: s });
  }

  quickMatch(): void {
    if (!this.client.connected) {
      this.ctx.bus.emit('net:error', { code: 'server', message: '서버에 연결되어 있지 않습니다.' });
      return;
    }
    this.pendingQuickMatch = true;
    this.client.send({ t: 'lobby:quickmatch', name: this._playerName });
  }
  setPublic(isPublic: boolean): void { this.client.send({ t: 'lobby:setPublic', isPublic }); }
  setLobbySeed(seed: number): void {
    const s = Math.floor(seed) >>> 0;
    if (this._lobby) this._lobby.seed = s; // optimistic mirror; the broadcast confirms it
    this.client.send({ t: 'lobby:seed', seed: s });
  }

  /**
   * Re-enter the running mission (raid after a resume, or join a running training from the terminal): tells the
   * server (`lobby:mission true`), starts the session with the lobby's mode and announces `flow rejoined` so the host
   * re-syncs us (extraction / pickups / containers / ghosts — our own body comes back with `ghost restore`).
   */
  rejoinMission(): void {
    const lobby = this._lobby;
    if (!lobby || !this.missionInProgress || lobby.seed === null) return;
    const seed = lobby.seed;
    const mode: MissionMode = lobby.mode ?? 'raid';
    this.client.send({ t: 'lobby:mission', inMission: true });
    const me = this.localId ? this.getLobbyPlayer(this.localId) : undefined;
    if (me) me.inMission = true; // optimistic; the broadcast confirms it
    this.beginSession(seed, lobby, mode, true);
    this.send({ t: 'flow', ev: 'rejoined' }, 'all');
  }

  /** Leave the running mission but stay in the lobby (training exit, raid abort by a client). */
  leaveMission(): void {
    const lobby = this._lobby;
    const wasIn = this._inSession;
    this._inSession = false;
    this.missionSeed = null;
    this._tookOver = false;
    this._raidBlob = null;
    this.clearRemotes();
    this.snapshotter.reset();
    this.lastSnapshotAt = -Infinity;
    if (!lobby) return;
    const me = this.localId ? this.getLobbyPlayer(this.localId) : undefined;
    if (me) me.inMission = false;
    if (this.client.connected) this.client.send({ t: 'lobby:mission', inMission: false });
    if (wasIn || me) this.ctx.bus.emit('net:lobbyUpdated', { lobby });
  }

  /** Upload my mid-raid state (game/ calls it periodically and on loot). Only inside a raid session. */
  saveRaid(blob: RaidSessionBlob): void {
    if (!this._inSession || this.sessionMode !== 'raid' || !this._lobby || !this.client.connected) return;
    if (blob.seed !== this.missionSeed) return;
    let text: string;
    try { text = JSON.stringify(blob); } catch { return; }
    if (text.length * 3 > RAID_BLOB_MAX_BYTES && new TextEncoder().encode(text).byteLength > RAID_BLOB_MAX_BYTES) {
      if (!this.raidTooLargeWarned) { this.raidTooLargeWarned = true; console.warn(`[net] raid blob exceeds ${RAID_BLOB_MAX_BYTES} bytes; not uploaded`); }
      return;
    }
    this.client.send({ t: 'raid:save', blob });
  }

  getInviteUrl(): string | null {
    if (!this._lobby) return null;
    return `${location.origin}${location.pathname}?${NET_INVITE_PARAM}=${this._lobby.code}`;
  }

  /* ── game messages ──────────────────────────────────────────────────── */
  send(msg: GameMessage, to: RelayTarget = 'others'): void {
    if (!this.client.connected || !this._lobby) return;
    this.client.send({ t: 'relay', to, d: msg });
  }

  onMessage<T extends GameMessageType>(type: T, handler: (msg: GameMessageOf<T>, from: PeerId) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const h = handler as unknown as Handler;
    set.add(h);
    return () => { this.handlers.get(type)?.delete(h); };
  }

  getRemotePlayers(): readonly RemotePlayerRef[] { return this.remoteList; }
  getRemotePlayer(id: PeerId): RemotePlayerRef | undefined { return this.remotes.get(id); }
  getLobbyPlayer(id: PeerId): LobbyPlayer | undefined {
    const lobby = this._lobby;
    if (!lobby) return undefined;
    for (let i = 0; i < lobby.players.length; i++) if (lobby.players[i].id === id) return lobby.players[i];
    return undefined;
  }

  /* ── inbound: server ────────────────────────────────────────────────── */
  private handleServerMessage(msg: ServerToClient): void {
    const bus = this.ctx.bus;
    switch (msg.t) {
      case 'welcome':
        this.onWelcome(msg);
        return;
      case 'pong':
        if (this.client.hasServerTime) this.serverOffset = this.client.serverTimeOffset;
        return;

      case 'lobby:state': {
        const matched = this.pendingQuickMatch && (!this._lobby || this._lobby.code !== msg.lobby.code);
        this.applyLobby(msg.lobby);
        if (matched) {
          this.pendingQuickMatch = false;
          bus.emit('net:matched', { lobby: msg.lobby, created: msg.lobby.players.length === 1 });
        }
        return;
      }

      case 'lobby:error':
        if (msg.code === 'duplicate') this.duplicateKicked = true;
        this.profileSync.onError(msg.code);
        this.pendingQuickMatch = false;
        bus.emit('net:error', { code: msg.code, message: msg.message });
        return;

      case 'lobby:left':
        this.dropLobby('left');
        return;

      case 'game:start': {
        const mode: MissionMode = msg.mode ?? 'raid';
        const me = this.localId ? msg.lobby.players.find((p) => p.id === this.localId) : undefined;
        // A training reaches every member, but only those the server marked `inMission` (the starter) enter it;
        // the rest just see the lobby running (`missionInProgress`) and may join from the terminal.
        const enters = me ? (me.inMission ?? true) : true;
        if (this._inSession || (mode === 'training' && !enters)) { this.applyLobby(msg.lobby); return; }
        this.beginSession(msg.seed, msg.lobby, mode, false);
        return;
      }

      case 'peer:left': {
        const prev = this._lobby;
        const gone = prev ? prev.players.find((p) => p.id === msg.id) : undefined;
        this._lobby = msg.lobby;
        if (prev && prev.code === msg.lobby.code && prev.hostId !== msg.lobby.hostId) this.onHostChanged(prev.hostId, msg.lobby.hostId);
        this.syncRemoteIdentities();
        bus.emit('net:lobbyUpdated', { lobby: msg.lobby });
        bus.emit('net:peerLeft', { id: msg.id, name: gone?.name ?? '대원' });
        const r = this.remotes.get(msg.id);
        if (r && r.connected) {
          r.connected = false;
          r.removeAt = this.ctx.time + PEER_LINGER;
        }
        return;
      }

      case 'relay':
        this.handleRelay(msg.from, msg.d);
        return;

      /* Phase 7 */
      case 'profile:docs':
        this.profileSync.onDocs(msg.profile);
        return;
      case 'credits:result':
        this.profileSync.onCreditsResult(msg);
        return;
    }
  }

  /** Enter the mission of `lobby` with `seed` (server `game:start`, or `rejoinMission()`). */
  private beginSession(seed: number, lobby: LobbyState, mode: MissionMode, rejoin: boolean): void {
    const bus = this.ctx.bus;
    this.applyLobby(lobby);
    this._inSession = true;
    this.sessionMode = mode;
    this.missionSeed = seed;
    this._tookOver = false;
    this.snapshotter.reset();
    this.lastSnapshotAt = -Infinity;
    this.clearRemotes(); // hub avatars are re-created from the first mission snapshots
    // Contract: whoever emits `game:newMission` sets `ctx.missionMode` first (world generates synchronously inside).
    this.ctx.missionMode = mode;
    bus.emit('net:gameStarting', { seed, lobby, rejoin, mode });
    bus.emit('game:newMission', { seed, mode });
  }

  private applyLobby(next: LobbyState): void {
    const prev = this._lobby;
    this._lobby = next;
    const bus = this.ctx.bus;
    if (prev && prev.code === next.code) {
      const me = this.localId;
      for (const p of next.players) {
        if (p.id === me) continue;
        const was = prev.players.find((q) => q.id === p.id);
        if (!was) bus.emit('net:peerJoined', { id: p.id, name: p.name, slot: p.slot });
        else if (!was.connected && p.connected) this.remotes.get(p.id)?.resetStream(); // came back → fresh seq
      }
      for (const q of prev.players) {
        if (q.id === me) continue;
        if (!next.players.some((p) => p.id === q.id)) {
          bus.emit('net:peerLeft', { id: q.id, name: q.name });
          const r = this.remotes.get(q.id);
          if (r && r.connected) { r.connected = false; r.removeAt = this.ctx.time + PEER_LINGER; }
        }
      }
      if (prev.hostId !== next.hostId) this.onHostChanged(prev.hostId, next.hostId);
    } else {
      this.membership.clear();
      this.prevHostId = null;
    }
    this.syncRemoteIdentities();
    bus.emit('net:lobbyUpdated', { lobby: next });
  }

  /**
   * `lobby.hostId` changed while the lobby runs a mission. Inside the session this is a migration: promote / demote
   * systems, announce a takeover. Phase 9: the event goes out even when we are NOT in the session (hub member of a
   * running lobby — every system is a no-op outside a live mission), but `tookOver` / `flow takeover` stay session-only.
   */
  private onHostChanged(prev: PeerId, next: PeerId): void {
    this.prevHostId = prev;
    if (!this._lobby || !this._lobby.started) return;
    const isLocalHost = next === this.localId;
    if (isLocalHost && this._inSession) this._tookOver = true;
    this.ctx.bus.emit('net:hostChanged', { hostId: next, prev, isLocalHost });
    // After every local system promoted itself: tell the others so they re-request their syncs from us.
    if (isLocalHost && this._inSession) this.send({ t: 'flow', ev: 'takeover' }, 'others');
  }

  /**
   * Mirror lobby facts onto the remote refs (name / slot; Phase 7: `inMission`, `suspended`) and report membership
   * changes for every member (`net:missionMembership`), suspension changes for refs (`net:peerSuspended`).
   */
  private syncRemoteIdentities(): void {
    const lobby = this._lobby;
    if (!lobby) return;
    const bus = this.ctx.bus;
    const me = this.localId;
    const seen = new Set<PeerId>();
    for (const p of lobby.players) {
      seen.add(p.id);
      const inM = this.playerInMission(p, lobby);
      if (this.membership.get(p.id) !== inM) {
        this.membership.set(p.id, inM);
        if (p.id !== me) bus.emit('net:missionMembership', { id: p.id, inMission: inM });
      }
      const r = this.remotes.get(p.id);
      if (!r) continue;
      r.name = p.name;
      r.slot = p.slot;
      r.inMission = inM;
      // Suspended = socket down while part of the running mission we are in (the host keeps their body as a ghost).
      const susp = this._inSession && inM && !p.connected;
      if (r.suspended !== susp) {
        r.suspended = susp;
        bus.emit('net:peerSuspended', { id: p.id, name: p.name, suspended: susp });
      }
    }
    for (const id of Array.from(this.membership.keys())) if (!seen.has(id)) this.membership.delete(id);
  }

  private playerInMission(p: LobbyPlayer, lobby: LobbyState): boolean {
    return p.inMission ?? (lobby.started && p.connected);
  }

  private dropLobby(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft'): void {
    const had = this._lobby !== null;
    this._lobby = null;
    this._inSession = false;
    this.missionSeed = null;
    this.lobbySuspended = false;
    this.pendingQuickMatch = false;
    this._tookOver = false;
    this._raidBlob = null;
    this.prevHostId = null;
    this.membership.clear();
    this.clearRemotes();
    if (had) this.ctx.bus.emit('net:lobbyLeft', { reason });
  }

  private endSessionPending = false;
  /** Deferred session end: runs after every synchronous handler of the triggering bus event has finished. */
  private scheduleEndSession(): void {
    if (!this._inSession || this.endSessionPending) return;
    this.endSessionPending = true;
    queueMicrotask(() => {
      this.endSessionPending = false;
      this.endSession();
    });
  }

  /**
   * Mission ended for us (complete / over / abort). Leaves the lobby intact — we return to the shared ship. Raid: the
   * host reopens the lobby (`lobby:reset`), a client that left alone reports `lobby:mission false` and sees
   * `missionInProgress` until the host resets. Training: everyone reports `lobby:mission false`; the server closes the
   * training once the last member left (never `lobby:reset`, other members may still be training).
   */
  private endSession(): void {
    if (!this._inSession) return;
    this._inSession = false;
    this.missionSeed = null;
    const wasHost = this.isHost;
    const mode = this.sessionMode;
    this._tookOver = false;
    this._raidBlob = null;
    this.clearRemotes();
    this.profileSync.flush();
    if (this.client.connected && this._lobby) {
      if (mode === 'raid' && wasHost) this.client.send({ t: 'lobby:reset' });
      else {
        const me = this.localId ? this.getLobbyPlayer(this.localId) : undefined;
        if (me) me.inMission = false;
        this.client.send({ t: 'lobby:mission', inMission: false });
      }
    }
  }

  /* ── inbound: relayed game messages ─────────────────────────────────── */
  private handleRelay(from: PeerId, d: GameMessage): void {
    if (typeof d !== 'object' || d === null || typeof (d as { t?: unknown }).t !== 'string') {
      console.warn('[net] malformed relay payload dropped', d);
      return;
    }
    const bus = this.ctx.bus;
    switch (d.t) {
      case 'ps': {
        if (!isNum(d.seq) || !isVec3(d.p) || !isVec3(d.v) || !isNum(d.yaw) || !isNum(d.pitch) || !isNum(d.hp) || !isNum(d.f)) {
          console.warn('[net] malformed snapshot dropped', from);
          return;
        }
        // Only peers sharing our space become remote refs: hub snapshots (IN_HUB) while we are in a mission — or
        // mission snapshots while we walk the ship — belong to a different 3D scene. An existing ref simply goes stale.
        const senderInHub = (d.f & PlayerFlags.IN_HUB) !== 0;
        if (senderInHub === this._inSession) break;
        const r = this.getOrCreateRemote(from);
        const wasDowned = r.isDowned;
        r.push(d, this.ctx.time);
        // Phase 2: squadmate went down / got back up → HUD feed (derived from the DOWNED flag transition)
        if (r.isDowned !== wasDowned) {
          const name = r.name ?? this.getLobbyPlayer(from)?.name ?? '대원';
          if (r.isDowned) bus.emit('net:remoteDowned', { id: from, name, position: r.position.clone() });
          else if (!r.isDead) bus.emit('net:remoteRevived', { id: from, name });
        }
        break;
      }
      case 'fire':
        if (typeof d.w === 'string' && isVec3(d.o) && isVec3(d.d)) {
          bus.emit('net:remoteFired', { id: from, weaponId: d.w, origin: vec(d.o), direction: vec(d.d) });
        }
        break;
      case 'reload':
        if (typeof d.w === 'string') bus.emit('net:remoteReloaded', { id: from, weaponId: d.w });
        break;
      case 'grenade':
        if (isVec3(d.p) && isVec3(d.v)) bus.emit('net:remoteGrenade', { id: from, position: vec(d.p), velocity: vec(d.v), fuse: typeof d.fuse === 'number' ? d.fuse : undefined });
        break;
      case 'revive': {
        // reviver → us (Phase 2): progress feeds the HUD, done stands us back up
        if (d.target !== this.localId) break;
        const byName = this.getLobbyPlayer(from)?.name ?? this.remotes.get(from)?.name ?? '대원';
        if (d.ev === 'done') { this.ctx.player?.revive(); bus.emit('player:reviveProgress', { t: -1, by: from, byName }); }
        else if (d.ev === 'progress') bus.emit('player:reviveProgress', { t: typeof d.p === 'number' ? Math.max(0, Math.min(1, d.p)) : 0, by: from, byName });
        else if (d.ev === 'cancel') bus.emit('player:reviveProgress', { t: -1, by: from, byName });
        break;
      }
      case 'died': {
        const r = this.remotes.get(from);
        if (r) r.markDead();
        const name = r?.name ?? this.getLobbyPlayer(from)?.name ?? '대원';
        bus.emit('net:remoteDied', { id: from, name, position: isVec3(d.p) ? vec(d.p) : (r ? r.position.clone() : new THREE.Vector3()) });
        break;
      }
      case 'ping':
        if (isVec3(d.p)) {
          const kind: PingKind = typeof d.kind === 'string' && PING_KINDS.has(d.kind) ? d.kind : 'ground';
          bus.emit('net:remotePing', { id: from, position: vec(d.p), kind });
        }
        break;
      case 'chat':
        if (typeof d.text === 'string') {
          const name = this.getLobbyPlayer(from)?.name ?? this.remotes.get(from)?.name ?? '대원';
          const kind: ChatKind = typeof d.kind === 'string' && CHAT_KINDS.has(d.kind) ? d.kind : 'text';
          bus.emit('net:chat', { id: from, name, text: d.text.slice(0, 200), kind });
        }
        break;
      case 'dmg':
        if (isNum(d.amount) && this.ctx.player && this._inSession) {
          this.ctx.player.takeDamage(d.amount, isVec3(d.from) ? vec(d.from) : undefined);
          if (d.slow && isNum(d.slow.duration) && isNum(d.slow.factor)) bus.emit('player:applySlow', { duration: d.slow.duration, factor: d.slow.factor });
          // Phase 7: knockback rides along (behemoth charge, blasts); the player ignores it while downed.
          if (d.kb && isVec3(d.kb.d) && isNum(d.kb.s) && d.kb.s > 0) this.ctx.player.applyKnockback(vec(d.kb.d), d.kb.s);
        }
        break;
      /* Phase 7: the host's ghost of a suspended member overrides that ref's pose / vitals. */
      case 'ghost':
        if (!this._inSession) break;
        if (d.ev === 'state') { if (isGhostWire(d.g)) this.applyGhost(d.g); }
        else if (d.ev === 'sync') { if (Array.isArray(d.ghosts)) for (const g of d.ghosts) if (isGhostWire(g)) this.applyGhost(g); }
        else if (d.ev === 'restore') {
          if (isGhostWire(d.g) && d.g.id === this.localId) {
            bus.emit('net:ghostRestore', { state: { position: vec(d.g.p), yaw: d.g.yaw, hp: d.g.hp, downHp: d.g.dhp, state: d.g.st } });
          }
        } else if (d.ev === 'gone') {
          if (typeof d.id === 'string') this.remotes.get(d.id)?.clearGhost();
        }
        break;
      /* Phase 7: the new host finished promoting itself → every system re-requests its sync (isLocalHost false). */
      case 'flow':
        if (d.ev === 'takeover' && this._inSession && from !== this.localId) {
          const cur = this._lobby?.hostId ?? from;
          const prev = cur === from ? this.prevHostId : cur;
          bus.emit('net:hostChanged', { hostId: from, prev: prev === from ? null : prev, isLocalHost: false });
        }
        break;
      default:
        // hit / explode / hitc / es / ee / ex / exq / crate / item / itemq / cont / contq / ghostq …: subscribers only.
        break;
    }

    const set = this.handlers.get(d.t);
    if (set && set.size) {
      for (const h of Array.from(set)) {
        try { h(d, from); } catch (e) { console.error(`[net] onMessage handler for '${d.t}' threw`, e); }
      }
    }
  }

  /** `ghost state` / `sync` entry for a lobby member (never ourselves): the ref is created when missing. */
  private applyGhost(g: GhostWire): void {
    if (g.id === this.localId || !this.getLobbyPlayer(g.id)) return;
    const r = this.getOrCreateRemote(g.id);
    r.applyGhost(g);
    this.ctx.bus.emit('net:ghostState', { id: g.id, hp: g.hp, downHp: g.dhp, state: g.st });
  }

  /* ── remote players ─────────────────────────────────────────────────── */
  private getOrCreateRemote(id: PeerId): RemotePlayer {
    let r = this.remotes.get(id);
    if (r) return r;
    const lp = this.getLobbyPlayer(id);
    r = new RemotePlayer(id, lp?.name ?? '대원', lp?.slot ?? 0, this.ctx.time);
    if (lp && this._lobby) {
      r.inMission = this.playerInMission(lp, this._lobby);
      r.suspended = this._inSession && r.inMission && !lp.connected;
    }
    this.remotes.set(id, r);
    this.remoteList = Array.from(this.remotes.values());
    this.ctx.bus.emit('net:remotePlayerAdded', { id });
    if (r.suspended) this.ctx.bus.emit('net:peerSuspended', { id, name: r.name, suspended: true });
    return r;
  }

  private removeRemote(id: PeerId): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    this.remoteList = Array.from(this.remotes.values());
    this.ctx.bus.emit('net:remotePlayerRemoved', { id });
    r.dispose();
  }

  private clearRemotes(): void {
    if (this.remotes.size === 0) return;
    for (const id of Array.from(this.remotes.keys())) this.removeRemote(id);
  }
}
