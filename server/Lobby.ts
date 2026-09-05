/**
 * Lobby model for the relay server. Pure data + rules; no sockets in here.
 * Erasable-TypeScript only (Node 24 strips types natively): no enums, namespaces or parameter properties.
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
};

export class Lobby {
  readonly code: string;
  hostId: PeerId;
  started = false;
  seed: number | null = null;
  /** Insertion order == join order; slots are assigned separately (lowest free). */
  readonly players = new Map<PeerId, LobbyPlayer>();

  constructor(code: string, hostId: PeerId) {
    this.code = code;
    this.hostId = hostId;
  }

  get size(): number { return this.players.size; }
  has(id: PeerId): boolean { return this.players.has(id); }
  get(id: PeerId): LobbyPlayer | undefined { return this.players.get(id); }

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
    const player: LobbyPlayer = { id, name, slot, ready: false, isHost: id === this.hostId };
    this.players.set(id, player);
    return player;
  }

  /** Remove a player. Returns true when the host changed (migrated to the lowest remaining slot). */
  remove(id: PeerId): boolean {
    if (!this.players.delete(id)) return false;
    if (this.hostId !== id || this.players.size === 0) return false;
    let next: LobbyPlayer | null = null;
    for (const p of this.players.values()) if (!next || p.slot < next.slot) next = p;
    if (!next) return false;
    this.hostId = next.id;
    for (const p of this.players.values()) p.isHost = p.id === this.hostId;
    return true;
  }

  setReady(id: PeerId, ready: boolean): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.ready = ready;
    return true;
  }

  allReady(): boolean {
    for (const p of this.players.values()) if (!p.ready) return false;
    return true;
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

  toState(): LobbyState {
    const players = Array.from(this.players.values())
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ ...p }));
    return { code: this.code, hostId: this.hostId, players, started: this.started, seed: this.seed };
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

  create(hostId: PeerId, name: string): Lobby | LobbyErrorCode {
    if (this.byPeer.has(hostId)) return 'in_lobby';
    let code = randomLobbyCode();
    let guard = 0;
    while (this.lobbies.has(code) && guard++ < 1000) code = randomLobbyCode();
    if (this.lobbies.has(code)) return 'server';
    const lobby = new Lobby(code, hostId);
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
    return lobby;
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
