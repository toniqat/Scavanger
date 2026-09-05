import * as THREE from 'three';
import type {
  GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, LobbyPlayer, LobbyState, NetRef,
  NetStatus, PeerId, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import {
  NET_INVITE_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_WS_PATH, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName,
} from '@/shared';
import { NetClient } from './NetClient';
import { RemotePlayer } from './RemotePlayer';
import { Snapshotter } from './Snapshotter';

const NAME_STORAGE_KEY = 'scav.playerName';
const SNAPSHOT_INTERVAL = 1 / NET_PLAYER_SNAPSHOT_HZ;
/** Seconds a departed peer's RemotePlayer lingers (connected=false) before removal. */
const PEER_LINGER = 1.0;

type Handler = (msg: GameMessage, from: PeerId) => void;

function isVec3(v: unknown): v is Vec3Tuple {
  return Array.isArray(v) && v.length === 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
function isNum(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v); }
function vec(t: Vec3Tuple): THREE.Vector3 { return new THREE.Vector3(t[0], t[1], t[2]); }

/**
 * Multiplayer client. Owns the relay connection, the lobby mirror, local snapshot broadcasting and the
 * interpolated RemotePlayerRefs. Publishes itself as `ctx.net`. Registered first in main.ts so inbound
 * state is applied before any other system reads it in the same frame.
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
  private _lobby: LobbyState | null = null;
  private _inSession = false;
  private _inviteCode: string | null = null;

  /* ── NetRef getters ─────────────────────────────────────────────────── */
  get status(): NetStatus { return this.client.status; }
  get connected(): boolean { return this.client.connected; }
  get localId(): PeerId | null { return this.client.localId; }
  get playerName(): string { return this._playerName; }
  get lobby(): LobbyState | null { return this._lobby; }
  get inSession(): boolean { return this._inSession; }
  get isHost(): boolean { return this._lobby !== null && this._lobby.hostId === this.client.localId; }
  get isAuthority(): boolean { return !this._inSession || this.isHost; }
  get localSlot(): number {
    const me = this.client.localId ? this.getLobbyPlayer(this.client.localId) : undefined;
    return me ? me.slot : 0;
  }
  get rttMs(): number { return this.client.rttMs; }
  get inviteCode(): string | null { return this._inviteCode; }

  /* ── GameSystem ─────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.net = this;

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
      ctx.bus.emit('net:statusChanged', reason !== undefined ? { status, reason } : { status });
      if (status !== 'connected' && status !== 'connecting') this.onDisconnected();
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
      if (!e.primary && !e.secondary) { this.snapshotter.weaponId = null; this.snapshotter.weaponSlot = null; }
    });
    bus.on('player:died', (e) => {
      if (this._inSession) this.send({ t: 'died', p: [e.position.x, e.position.y, e.position.z] }, 'others');
    });
    // NetSystem runs before GameFlow/Extraction, whose handlers for these same events still need `inSession`,
    // `isAuthority` and `send()` intact (they broadcast `flow abort` / `ex reset`). End the session in a microtask.
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

      // Broadcast our own snapshot. Timed on unscaled ctx.time (Engine passes dt = 0 while paused, but a
      // multiplayer pause is non-freezing and peers must keep seeing us).
      if (this._inSession && ctx.player && (ctx.isGameplayPhase() || ctx.phase === 'deploying')) {
        if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL) {
          this.lastSnapshotAt = now;
          const snap = this.snapshotter.build(ctx);
          if (snap) this.send(snap, 'others');
        }
      } else {
        this.lastSnapshotAt = -Infinity; // send immediately once gameplay resumes
      }
    } catch (e) {
      console.warn('[net] update error', e);
    }
  }

  dispose(): void {
    this.client.close();
    this.clearRemotes();
    this.handlers.clear();
    if (this.ctx && this.ctx.net === this) this.ctx.net = null;
  }

  /* ── connection ─────────────────────────────────────────────────────── */
  connect(url?: string): Promise<void> {
    return this.client.connect(url ?? this.defaultUrl());
  }

  disconnect(): void {
    if (this._lobby || this._inSession) this.dropLobby('left');
    this.client.close();
  }

  setPlayerName(name: string): void {
    this._playerName = sanitizePlayerName(name);
    try { localStorage.setItem(NAME_STORAGE_KEY, this._playerName); } catch { /* storage unavailable */ }
  }

  private defaultUrl(): string {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const fromEnv = env?.VITE_WS_URL;
    if (fromEnv) return fromEnv;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${NET_WS_PATH}`;
  }

  /* ── lobby ops ──────────────────────────────────────────────────────── */
  createLobby(): void { this.client.send({ t: 'lobby:create', name: this._playerName }); }
  joinLobby(code: string): void {
    const norm = normalizeLobbyCode(code);
    if (!isValidLobbyCode(norm)) {
      this.ctx.bus.emit('net:error', { code: 'invalid', message: '잘못된 로비 코드입니다. 6자리 코드를 입력하세요.' });
      return;
    }
    this.client.send({ t: 'lobby:join', code: norm, name: this._playerName });
  }
  leaveLobby(): void { this.client.send({ t: 'lobby:leave' }); }
  setReady(ready: boolean): void { this.client.send({ t: 'lobby:ready', ready }); }
  startGame(seed: number): void { this.client.send({ t: 'lobby:start', seed: Math.floor(seed) >>> 0 }); }

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
      case 'pong':
        return;

      case 'lobby:state':
        this.applyLobby(msg.lobby);
        return;

      case 'lobby:error':
        bus.emit('net:error', { code: msg.code, message: msg.message });
        return;

      case 'lobby:left':
        this.dropLobby('left');
        return;

      case 'game:start': {
        this.applyLobby(msg.lobby);
        this._inSession = true;
        this.snapshotter.reset();
        this.lastSnapshotAt = -Infinity;
        this.clearRemotes();
        bus.emit('net:gameStarting', { seed: msg.seed, lobby: msg.lobby });
        bus.emit('game:newMission', { seed: msg.seed });
        return;
      }

      case 'peer:left': {
        const prev = this._lobby;
        const gone = prev ? prev.players.find((p) => p.id === msg.id) : undefined;
        this._lobby = msg.lobby;
        bus.emit('net:lobbyUpdated', { lobby: msg.lobby });
        bus.emit('net:peerLeft', { id: msg.id, name: gone?.name ?? '대원' });
        const r = this.remotes.get(msg.id);
        if (r && r.connected) {
          r.connected = false;
          r.removeAt = this.ctx.time + PEER_LINGER;
        }
        // Names/slots may have shifted (host migration only changes isHost; slots are stable).
        this.syncRemoteIdentities();
        return;
      }

      case 'relay':
        this.handleRelay(msg.from, msg.d);
        return;
    }
  }

  private applyLobby(next: LobbyState): void {
    const prev = this._lobby;
    this._lobby = next;
    const bus = this.ctx.bus;
    if (prev && prev.code === next.code) {
      const me = this.client.localId;
      for (const p of next.players) {
        if (p.id === me) continue;
        if (!prev.players.some((q) => q.id === p.id)) bus.emit('net:peerJoined', { id: p.id, name: p.name, slot: p.slot });
      }
      for (const q of prev.players) {
        if (q.id === me) continue;
        if (!next.players.some((p) => p.id === q.id)) {
          bus.emit('net:peerLeft', { id: q.id, name: q.name });
          const r = this.remotes.get(q.id);
          if (r && r.connected) { r.connected = false; r.removeAt = this.ctx.time + PEER_LINGER; }
        }
      }
    }
    this.syncRemoteIdentities();
    bus.emit('net:lobbyUpdated', { lobby: next });
  }

  private syncRemoteIdentities(): void {
    if (!this._lobby) return;
    for (const p of this._lobby.players) {
      const r = this.remotes.get(p.id);
      if (r) { r.name = p.name; r.slot = p.slot; }
    }
  }

  private dropLobby(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft'): void {
    const had = this._lobby !== null;
    this._lobby = null;
    this._inSession = false;
    this.clearRemotes();
    if (had) this.ctx.bus.emit('net:lobbyLeft', { reason });
  }

  private onDisconnected(): void {
    if (this._lobby || this._inSession) this.dropLobby('disconnected');
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

  /** Mission ended (complete / over / abort). Leaves the lobby object intact so the menu shows it again. */
  private endSession(): void {
    if (!this._inSession) return;
    this._inSession = false;
    const wasHost = this.isHost;
    this.clearRemotes();
    if (wasHost && this.client.connected && this._lobby) this.client.send({ t: 'lobby:reset' });
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
        const r = this.getOrCreateRemote(from);
        r.push(d, this.ctx.time);
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
        if (isVec3(d.p) && isVec3(d.v)) bus.emit('net:remoteGrenade', { id: from, position: vec(d.p), velocity: vec(d.v) });
        break;
      case 'died': {
        const r = this.remotes.get(from);
        if (r) r.markDead();
        const name = r?.name ?? this.getLobbyPlayer(from)?.name ?? '대원';
        bus.emit('net:remoteDied', { id: from, name, position: isVec3(d.p) ? vec(d.p) : (r ? r.position.clone() : new THREE.Vector3()) });
        break;
      }
      case 'ping':
        if (isVec3(d.p) && typeof d.kind === 'string') bus.emit('net:remotePing', { id: from, position: vec(d.p), kind: d.kind });
        break;
      case 'chat':
        if (typeof d.text === 'string') {
          const name = this.getLobbyPlayer(from)?.name ?? this.remotes.get(from)?.name ?? '대원';
          bus.emit('net:chat', { id: from, name, text: d.text.slice(0, 200) });
        }
        break;
      case 'dmg':
        if (isNum(d.amount) && this.ctx.player) {
          this.ctx.player.takeDamage(d.amount, isVec3(d.from) ? vec(d.from) : undefined);
          if (d.slow && isNum(d.slow.duration) && isNum(d.slow.factor)) bus.emit('player:applySlow', { duration: d.slow.duration, factor: d.slow.factor });
        }
        break;
      default:
        // hit / explode / hitc / es / ee / ex / exq / flow / crate: subscribers only.
        break;
    }

    const set = this.handlers.get(d.t);
    if (set && set.size) {
      for (const h of Array.from(set)) {
        try { h(d, from); } catch (e) { console.error(`[net] onMessage handler for '${d.t}' threw`, e); }
      }
    }
  }

  /* ── remote players ─────────────────────────────────────────────────── */
  private getOrCreateRemote(id: PeerId): RemotePlayer {
    let r = this.remotes.get(id);
    if (r) return r;
    const lp = this.getLobbyPlayer(id);
    r = new RemotePlayer(id, lp?.name ?? '대원', lp?.slot ?? 0, this.ctx.time);
    this.remotes.set(id, r);
    this.remoteList = Array.from(this.remotes.values());
    this.ctx.bus.emit('net:remotePlayerAdded', { id });
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
