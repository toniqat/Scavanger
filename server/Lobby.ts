/**
 * Lobby model for the relay server. Pure data + rules; no sockets or timers in here.
 * Erasable-TypeScript only (Node 24 strips types natively): no enums, namespaces or parameter properties.
 *
 * Reconnection: a member whose socket dropped stays in `players` with `connected=false` until the server's grace
 * timer removes them (`LobbyManager.leave`). Host migration prefers connected members.
 */
import type { LobbyErrorCode, LobbyPlayer, LobbyState, PeerId } from '../src/shared/net.ts';
import { NET_LOBBY_ALPHABET, NET_LOBBY_CODE_LENGTH, NET_MAX_PLAYERS } from '../src/shared/net.ts';

export const LOBBY_ERROR_MESSAGE_KO: Record<LobbyErrorCode, string> = {
  not_found: '해당 코드의 로비를 찾을 수 없습니다.',
  full: '로비가 가득 찼습니다.',
  started: '이미 임무가 시작된 로비입니다.',
  not_host: '호스트만 할 수 있는 작업입니다.',
  not_ready: '모든 대원이 준비 완료 상태여야 합니다.',
  invalid: '잘못된 요청입니다.',
  in_lobby: '이미 로비에 참가 중입니다.',
  not_in_lobby: '참가 중인 로비가 없습니다.',
  server: '서버 오류가 발생했습니다.',
  not_started: '진행 중인 임무가 없습니다.',
  duplicate: '다른 탭에서 같은 세션으로 접속했습니다. 이 연결은 종료됩니다.',
};

export class Lobby {
  readonly code: string;
  hostId: PeerId;
  started = false;
  seed: number | null = null;
  /** Quick-match eligibility. `lobby:create` → false (code / invite only); `lobby:quickmatch` → true. */
  isPublic = false;
  /** Creation time (ms); quick match prefers the oldest open lobby. */
  readonly createdAt: number;
  /** Insertion order == join order; slots are assigned separately (lowest free). */
  readonly players = new Map<PeerId, LobbyPlayer>();

  constructor(code: string, hostId: PeerId, isPublic = false, now: number = Date.now()) {
    this.code = code;
    this.hostId = hostId;
    this.isPublic = isPublic;
    this.createdAt = now;
  }

  get size(): number { return this.players.size; }
  has(id: PeerId): boolean { return this.players.has(id); }
  get(id: PeerId): LobbyPlayer | undefined { return this.players.get(id); }

  /** Members whose socket is currently attached. */
  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  /** Lowest slot index not currently in use, or -1 when full. */
  freeSlot(): number {
    for (let s = 0; s < NET_MAX_PLAYERS; s++) {
      let used = false;
      for (const p of this.players.values()) if (p.slot === s) { used = true; break; }
      if (!used) return s;
    }
    return -1;
  }

  add(id: PeerId, name: string): LobbyPlayer | LobbyErrorCode {
    if (this.started) return 'started';
    const slot = this.freeSlot();
    if (slot < 0 || this.players.size >= NET_MAX_PLAYERS) return 'full';
    const player: LobbyPlayer = { id, name, slot, ready: false, isHost: id === this.hostId, connected: true };
    this.players.set(id, player);
    return player;
  }

  /**
   * Move the host role to the lowest-slot *connected* member (falling back to the lowest slot overall).
   * Returns true when the host changed. No-op when the current host is still connected.
   */
  migrateHost(): boolean {
    const cur = this.players.get(this.hostId);
    if (cur && cur.connected) return false;
    let next: LobbyPlayer | null = null;
    let anyConnected = false;
    for (const p of this.players.values()) if (p.connected) { anyConnected = true; break; }
    for (const p of this.players.values()) {
      if (anyConnected && !p.connected) continue;
      if (!next || p.slot < next.slot) next = p;
    }
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    for (const p of this.players.values()) p.isHost = p.id === this.hostId;
    return true;
  }

  /** Remove a player. Returns true when the host changed (migrated to the lowest remaining connected slot). */
  remove(id: PeerId): boolean {
    if (!this.players.delete(id)) return false;
    if (this.hostId !== id || this.players.size === 0) return false;
    return this.migrateHost();
  }

  /** Mark a member's socket state. Returns the player or undefined when not a member. */
  setConnected(id: PeerId, connected: boolean): LobbyPlayer | undefined {
    const p = this.players.get(id);
    if (p) p.connected = connected;
    return p;
  }

  setName(id: PeerId, name: string): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.name = name;
    return true;
  }

  setReady(id: PeerId, ready: boolean): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.ready = ready;
    return true;
  }

  /** Every *connected* member is ready and at least one member is connected (dropped members do not block a launch). */
  allReady(): boolean {
    let connected = 0;
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      connected++;
      if (!p.ready) return false;
    }
    return connected > 0;
  }

  start(seed: number): void {
    this.started = true;
    this.seed = seed;
  }

  reset(): void {
    this.started = false;
    this.seed = null;
    for (const p of this.players.values()) p.ready = false;
  }

  /** Open to newcomers via quick match. */
  isQuickMatchable(): boolean {
    return this.isPublic && !this.started && this.players.size < NET_MAX_PLAYERS && this.freeSlot() >= 0;
  }

  toState(): LobbyState {
    const players = Array.from(this.players.values())
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ ...p }));
    return { code: this.code, hostId: this.hostId, players, started: this.started, seed: this.seed, isPublic: this.isPublic };
  }
}

export function randomLobbyCode(rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < NET_LOBBY_CODE_LENGTH; i++) {
    s += NET_LOBBY_ALPHABET[Math.floor(rng() * NET_LOBBY_ALPHABET.length) % NET_LOBBY_ALPHABET.length];
  }
  return s;
}

/** All lobbies + reverse index peer → lobby. */
export class LobbyManager {
  readonly lobbies = new Map<string, Lobby>();
  private readonly byPeer = new Map<PeerId, Lobby>();

  get count(): number { return this.lobbies.size; }
  lobbyOf(id: PeerId): Lobby | undefined { return this.byPeer.get(id); }
  byCode(code: string): Lobby | undefined { return this.lobbies.get(code); }

  create(hostId: PeerId, name: string, isPublic = false): Lobby | LobbyErrorCode {
    if (this.byPeer.has(hostId)) return 'in_lobby';
    let code = randomLobbyCode();
    let guard = 0;
    while (this.lobbies.has(code) && guard++ < 1000) code = randomLobbyCode();
    if (this.lobbies.has(code)) return 'server';
    const lobby = new Lobby(code, hostId, isPublic);
    lobby.add(hostId, name);
    this.lobbies.set(code, lobby);
    this.byPeer.set(hostId, lobby);
    return lobby;
  }

  join(id: PeerId, code: string, name: string): Lobby | LobbyErrorCode {
    if (this.byPeer.has(id)) return 'in_lobby';
    const lobby = this.lobbies.get(code);
    if (!lobby) return 'not_found';
    const res = lobby.add(id, name);
    if (typeof res === 'string') return res;
    this.byPeer.set(id, lobby);
    this.adoptHostIfAbsent(lobby);
    return lobby;
  }

  /**
   * Best public, not-started lobby with a free slot: lobbies with >= 1 connected member first, then the oldest.
   * A lobby whose members are all in reconnect grace is used only when nothing better exists (the joiner becomes
   * host at once via `adoptHostIfAbsent`, so nobody waits on a ghost).
   */
  findQuickMatch(): Lobby | undefined {
    let best: Lobby | undefined;
    let bestLive = false;
    for (const l of this.lobbies.values()) {
      if (!l.isQuickMatchable()) continue;
      const live = l.connectedCount() > 0;
      if (!best || (live && !bestLive) || (live === bestLive && l.createdAt < best.createdAt)) { best = l; bestLive = live; }
    }
    return best;
  }

  /** After a join into a not-started lobby whose host is in grace: hand the host role to a connected member now. */
  private adoptHostIfAbsent(lobby: Lobby): boolean {
    if (lobby.started) return false;
    return lobby.migrateHost();
  }

  /** Join the oldest open public lobby or create a new public one. `created` tells which happened. */
  quickMatch(id: PeerId, name: string): { lobby: Lobby; created: boolean } | LobbyErrorCode {
    if (this.byPeer.has(id)) return 'in_lobby';
    const open = this.findQuickMatch();
    if (open) {
      const res = open.add(id, name);
      if (typeof res === 'string') return res;
      this.byPeer.set(id, open);
      this.adoptHostIfAbsent(open);
      return { lobby: open, created: false };
    }
    const lobby = this.create(id, name, true);
    if (typeof lobby === 'string') return lobby;
    return { lobby, created: true };
  }

  /** Remove `id` from its lobby. Returns the lobby (possibly now empty and deleted) plus whether the host migrated. */
  leave(id: PeerId): { lobby: Lobby; hostMigrated: boolean; deleted: boolean } | null {
    const lobby = this.byPeer.get(id);
    if (!lobby) return null;
    this.byPeer.delete(id);
    const hostMigrated = lobby.remove(id);
    let deleted = false;
    if (lobby.size === 0) { this.lobbies.delete(lobby.code); deleted = true; }
    return { lobby, hostMigrated, deleted };
  }
}
