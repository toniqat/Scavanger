/**
 * Lobby model for the relay server. Pure data + rules; no sockets or timers in here.
 * Erasable-TypeScript only (Node 24 strips types natively): no enums, namespaces or parameter properties.
 *
 * Reconnection: a member whose socket dropped stays in `players` with `connected=false` until the server's grace
 * timer removes them (`LobbyManager.leave`). Host migration prefers connected members.
 */
import type { LobbyErrorCode, LobbyPlayer, LobbyState, PeerId } from '../src/shared/net.ts';
import type { MissionMode } from '../src/shared/types.ts';
import type { PlanetId } from '../src/shared/planets.ts';
import type { RaidSessionBlob } from '../src/shared/profile.ts';
import { NET_LOBBY_ALPHABET, NET_LOBBY_CODE_LENGTH, NET_MAX_PLAYERS } from '../src/shared/net.ts';

export const LOBBY_ERROR_MESSAGE_KO: Record<LobbyErrorCode, string> = {
  not_found: '해당 코드의 로비를 찾을 수 없습니다.',
  /* Phase 7 */
  in_mission: '진행 중인 임무가 없거나 다른 종류의 임무가 진행 중입니다.',
  too_large: '저장 데이터가 너무 큽니다.',
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
  /* Phase 11 */
  no_planet: '목표 행성을 먼저 지정해야 합니다.',
  /* 2026-09-11 (C-29): 서버 콘솔 */
  kicked: '서버 관리자가 연결을 끊었습니다.',
  server_full: '서버 접속 인원이 가득 찼습니다.',
  /* 2026-09-11 (B-11): 내가 차단한 상대가 있는 분대. 반대 방향(나를 차단한 사람)은 not_found 로 위장한다. */
  blocked: '차단한 상대가 있는 분대입니다.',
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
  /* Phase 7 */
  /** Kind of the running mission while `started`; null otherwise. A training keeps the lobby open to joins. */
  mode: MissionMode | null = null;
  /** Mid-raid state of each member (`raid:save`), returned in `welcome.raid` on a resume. Cleared with the mission. */
  readonly raid = new Map<PeerId, RaidSessionBlob>();
  /* Phase 11 */
  /**
   * 목표 행성 the host picked (`lobby:planet`), or null while nothing is chosen. A raid needs it (`no_planet`);
   * a training ignores it. **`reset()` keeps it** — the destination outlives the mission.
   */
  planet: PlanetId | null = null;
  /* 2026-09-09 — 분대장 지명 이관 */
  /**
   * 현재 호스트가 이 레이드에서 **완전히 사망**했다고 스스로 알린 상태 (`lobby:hostDown`). 이 표시가 켜져 있는
   * 동안에만 다른 멤버의 `lobby:transferHost {claim:true}` (시체 옆의 분대장 기기)를 받아 준다.
   * 호스트가 바뀌거나 미션이 끝나면(`reset()`) 자동으로 꺼진다 — 표시가 다음 판까지 남아서는 안 된다.
   */
  hostDown = false;

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

  /** Members currently inside the running mission (`inMission`). */
  inMissionCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.inMission) n++;
    return n;
  }

  /** A raid closes the lobby to newcomers; a training keeps it open (they join from the terminal). */
  isJoinable(): boolean {
    return !this.started || this.mode === 'training';
  }

  /**
   * 2026-09-11 (B-6): why a newcomer cannot be added right now, or null. **The only copy of the join rule** — `add`
   * calls it, and `LobbyManager.move` asks it *before* taking the mover out of their own lobby, so the two can never
   * disagree (a check written twice is how 같이 하기 would one day leave someone with no ship).
   */
  canAdd(): LobbyErrorCode | null {
    if (!this.isJoinable()) return 'started';
    if (this.freeSlot() < 0 || this.players.size >= NET_MAX_PLAYERS) return 'full';
    return null;
  }

  add(id: PeerId, name: string): LobbyPlayer | LobbyErrorCode {
    const refused = this.canAdd();
    if (refused !== null) return refused;
    const slot = this.freeSlot();
    const player: LobbyPlayer = { id, name, slot, ready: false, isHost: id === this.hostId, connected: true, inMission: false };
    this.players.set(id, player);
    return player;
  }

  /**
   * Move the host role. Not started (hub): lowest-slot *connected* member (falling back to the lowest slot overall).
   * Started (Phase 9 rule): candidates are **connected members inside the mission** (`inMission`) only — when there is
   * none the role is *parked* (returns false, host id kept; the relay retries when an in-mission member reconnects).
   * Returns true when the host changed. No-op when the current host is still connected, unless `force` (Phase 9:
   * a connected host that left the mission — page reload — must hand the authority to someone who simulates).
   */
  migrateHost(force = false): boolean {
    const cur = this.players.get(this.hostId);
    if (cur && cur.connected && !force) return false;
    let next: LobbyPlayer | null = null;
    let anyConnected = false;
    for (const p of this.players.values()) if (p.connected) anyConnected = true;
    for (const p of this.players.values()) {
      if (this.started) { if (!p.connected || !p.inMission) continue; }
      else if (anyConnected && !p.connected) continue;
      if (!next || p.slot < next.slot) next = p;
    }
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    for (const p of this.players.values()) p.isHost = p.id === this.hostId;
    this.hostDown = false;   // 2026-09-09: 새 호스트는 살아 있다 — 사망 표시는 호스트를 따라가지 않는다
    return true;
  }

  /**
   * 2026-09-09 — **지명 이관**. `migrateHost` 의 슬롯 규칙을 건너뛰고 `targetId` 를 그대로 분대장으로 세운다
   * (커뮤니티 우클릭 · 함선 안 상호작용 · 분대장 기기). 같은 로비의 **연결된** 멤버만 받는다.
   * 이관이 일어나면 사망 표시도 함께 지운다.
   */
  transferHostTo(targetId: PeerId): boolean {
    const p = this.players.get(targetId);
    if (!p || !p.connected) return false;
    this.hostId = targetId;
    for (const q of this.players.values()) q.isHost = q.id === this.hostId;
    this.hostDown = false;
    return true;
  }

  /**
   * Remove a player. Returns true when the host changed. Phase 9: a started lobby left with **no `inMission` member
   * at all** is over — `reset()` first, then the ordinary (hub) migration; otherwise the started rule applies (a
   * removed host with no connected in-mission member stays parked).
   */
  remove(id: PeerId): boolean {
    if (!this.players.delete(id)) return false;
    this.raid.delete(id);
    if (this.players.size === 0) return false;
    const missionOver = this.started && this.inMissionCount() === 0;
    if (missionOver) this.reset();
    if (this.hostId !== id && !missionOver) return false;
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

  /**
   * Start a mission. `raid` (default): every connected member enters (`inMission`). `training`: only `starterId`
   * enters; the others stay in the hub and may join later with `lobby:mission {inMission:true}`.
   * Old raid blobs are dropped (they belong to a previous seed).
   */
  start(seed: number, mode: MissionMode = 'raid', starterId?: PeerId): void {
    this.started = true;
    this.seed = seed;
    this.mode = mode;
    this.raid.clear();
    for (const p of this.players.values()) {
      p.inMission = mode === 'training' ? p.id === starterId : p.connected;
    }
  }

  /** End the mission and reopen the lobby. Phase 11: `planet` is deliberately **not** cleared. */
  reset(): void {
    this.started = false;
    this.seed = null;
    this.mode = null;
    this.raid.clear();
    this.hostDown = false;   // 2026-09-09: 미션이 끝나면 분대장 사망 표시도 끝난다
    for (const p of this.players.values()) { p.ready = false; p.inMission = false; }
  }

  /** Update a member's mission membership. Returns the player or undefined when not a member. */
  setInMission(id: PeerId, inMission: boolean): LobbyPlayer | undefined {
    const p = this.players.get(id);
    if (p) p.inMission = inMission;
    return p;
  }

  /** Accept a raid blob: only while a raid with the same seed is running (`false` = ignored). */
  setRaid(id: PeerId, blob: RaidSessionBlob): boolean {
    if (!this.started || this.mode === 'training' || blob.seed !== this.seed || !this.players.has(id)) return false;
    this.raid.set(id, blob);
    return true;
  }

  /** The member's blob when it still belongs to the running raid, else null. */
  getRaid(id: PeerId): RaidSessionBlob | null {
    if (!this.started || this.mode === 'training') return null;
    const b = this.raid.get(id);
    return b && b.seed === this.seed ? b : null;
  }

  /** Open to newcomers via quick match (a not-started lobby, or one whose members are only training). */
  isQuickMatchable(): boolean {
    return this.isPublic && this.isJoinable() && this.players.size < NET_MAX_PLAYERS && this.freeSlot() >= 0;
  }

  toState(): LobbyState {
    const players = Array.from(this.players.values())
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ ...p }));
    const state: LobbyState = { code: this.code, hostId: this.hostId, players, started: this.started, seed: this.seed, isPublic: this.isPublic };
    if (this.started && this.mode) state.mode = this.mode;
    if (this.planet) state.planet = this.planet;
    return state;
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
   *
   * 2026-09-11 (B-11): `accept` lets the caller drop candidates for a reason this model knows nothing about — the
   * relay skips every lobby holding a 차단 either way. Skipping (rather than refusing) is the point: public lobbies
   * come in numbers, and when they are all filtered out the ordinary "nothing open" path creates a new one.
   */
  findQuickMatch(accept?: (lobby: Lobby) => boolean): Lobby | undefined {
    let best: Lobby | undefined;
    let bestLive = false;
    for (const l of this.lobbies.values()) {
      if (!l.isQuickMatchable()) continue;
      if (accept !== undefined && !accept(l)) continue;
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

  /**
   * Join the oldest open public lobby or create a new public one. `created` tells which happened.
   * `accept` (2026-09-11, B-11) narrows the candidates — see `findQuickMatch`.
   */
  quickMatch(id: PeerId, name: string, accept?: (lobby: Lobby) => boolean): { lobby: Lobby; created: boolean } | LobbyErrorCode {
    if (this.byPeer.has(id)) return 'in_lobby';
    const open = this.findQuickMatch(accept);
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

  /**
   * 2026-09-11 (B-6): move `id` from whatever lobby it is in (possibly none) straight into lobby `toCode`, **atomically**:
   * the target is checked first (`not_found` · `in_lobby` for the same lobby · `Lobby.canAdd`) and a refusal changes
   * nothing. Only then is `id` taken out of its old lobby (`leave` — deleted when it empties) and added to the new one.
   * There is no rollback path: `add` asks the same `canAdd`, so a refusal after the leave is a contract violation and
   * throws (the selftest would see it) rather than being papered over.
   * Rules about the *mover* (a squad in tow → busy, inside a mission → busy) are the relay's — this is the data move.
   */
  move(id: PeerId, toCode: string, name: string):
    | { ok: true; from: Lobby | null; to: Lobby; fromDeleted: boolean; hostMigrated: boolean }
    | { ok: false; code: LobbyErrorCode } {
    const to = this.lobbies.get(toCode);
    if (!to) return { ok: false, code: 'not_found' };
    const from = this.byPeer.get(id) ?? null;
    if (from === to) return { ok: false, code: 'in_lobby' };
    const refused = to.canAdd();
    if (refused !== null) return { ok: false, code: refused };
    let fromDeleted = false;
    let hostMigrated = false;
    if (from) {
      const left = this.leave(id);
      fromDeleted = left?.deleted ?? false;
      hostMigrated = left?.hostMigrated ?? false;
    }
    const added = to.add(id, name);
    if (typeof added === 'string') throw new Error(`LobbyManager.move: canAdd() passed but add() refused (${added})`);
    this.byPeer.set(id, to);
    this.adoptHostIfAbsent(to);
    return { ok: true, from, to, fromDeleted, hostMigrated };
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
