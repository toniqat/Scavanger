/**
 * Lobby model for the relay server. Pure data + rules; no sockets or timers in here.
 * Erasable-TypeScript only (Node 24 strips types natively): no enums, namespaces or parameter properties.
 *
 * Reconnection: a member whose socket dropped stays in `players` with `connected=false` until the server's grace
 * timer removes them (`LobbyManager.leave`). Host migration prefers connected members.
 */
import type { IntelWire, LobbyErrorCode, LobbyPlayer, LobbyState, PeerId } from '../src/shared/net.ts';
import type { MissionMode } from '../src/shared/types.ts';
import type { PlanetId } from '../src/shared/planets.ts';
import type { RaidSessionBlob } from '../src/shared/profile.ts';
import { NET_LOBBY_ALPHABET, NET_LOBBY_CODE_LENGTH, NET_MAX_PLAYERS } from '../src/shared/net.ts';
/* 2026-09-15: android squadmates — bot members (no socket). Contract: the last section of `src/shared/net.ts`. */
import { ANDROID_BAY_COUNT, androidIdOf, isBotPlayer } from '../src/shared/net.ts';
/* Only the display name is taken. Every other import inside `src/shared/allies.ts` is an `import type`, so nothing
   of it survives type stripping. */
import { androidNameOf } from '../src/shared/allies.ts';

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
  /* 2026-09-11 (C-29): the operator console */
  kicked: '서버 관리자가 연결을 끊었습니다.',
  server_full: '서버 접속 인원이 가득 찼습니다.',
  /* 2026-09-11 (B-11): a squad holding someone I blocked. The other direction (someone who blocked me) is
     disguised as not_found. */
  blocked: '차단한 상대가 있는 분대입니다.',
  /* 2026-09-15: squad · dock matchmaking — an undocked squad locks the solo launch · the training range */
  not_docked: '분대가 아직 공용 함선에 도킹하지 않았습니다.',
  /* 2026-09-15: abandoning the raid from the title — an abandoned raid can never be entered again */
  drifted: '레이드를 포기해 표류 처리되었습니다. 이 임무에는 다시 들어갈 수 없습니다.',
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
   * The target planet the host picked (`lobby:planet`), or null while nothing is chosen. A raid needs it
   * (`no_planet`);
   * a training ignores it. **`reset()` keeps it** — the destination outlives the mission.
   */
  planet: PlanetId | null = null;
  /* 2026-09-14 — the intel broker (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
  /**
   * The **fixed gimmicks** the squad leader bought (`lobby:intel`), or null when nobody bought any. The server
   * sanitizes **the shape only** and broadcasts it as it is — it computes no layout (treated like `planet`).
   * `reset()` **clears it**: the intel is consumed by that raid, so it must not survive into the next one (unlike
   * the planet, which stays because it is the destination).
   */
  intel: IntelWire | null = null;
  /* 2026-09-09 — host transfer by nomination */
  /**
   * The current host reported itself **fully dead** in this raid (`lobby:hostDown`). Only while this flag is up is
   * another member's `lobby:transferHost {claim:true}` (the squad-leader device beside the corpse) accepted.
   * Any host change or the end of the mission (`reset()`) turns it off — the flag must not outlive the raid.
   */
  hostDown = false;
  /* 2026-09-15 — squad · dock matchmaking (docs/DECISIONS.md 「2026-09-15 — 분대 · 도킹 매칭」) */
  /**
   * false = only a squad was formed and everyone is in **their own personal ship** (the lobby an invite creates the
   * moment it is sent). true = the squad is in a shared ship.
   * Why the default is **true**: `lobby:create` · `lobby:join` · `lobby:quickmatch` make a docked lobby as they
   * always did (the smokes · older clients rely on it). The one place that makes it false is the relay's
   * `social:play`, and the one place that raises it to true is `lobby:dock` — a lobby that has docked never goes
   * back. An undocked lobby is not a quick-match candidate (`isQuickMatchable`), refuses ready · launch · the
   * training range · joining the mission (`not_docked`), and is dissolved by the relay once it is left with one
   * member and no open invite.
   */
  docked = true;

  constructor(code: string, hostId: PeerId, isPublic = false, now: number = Date.now()) {
    this.code = code;
    this.hostId = hostId;
    this.isPublic = isPublic;
    this.createdAt = now;
  }

  get size(): number { return this.players.size; }
  has(id: PeerId): boolean { return this.players.has(id); }
  get(id: PeerId): LobbyPlayer | undefined { return this.players.get(id); }

  /**
   * 2026-09-15: the record of android bot members that went back to their bay to free a slot for a human (`add`
   * fills it). The relay drains it **after** the join and broadcasts `lobby:androidReturned` — the newcomer has to
   * hear the same news for its squad list to be right. `Lobby` knows nothing about sockets, so writing it down here
   * is the only way it can tell anyone.
   */
  private readonly returnedBots: LobbyPlayer[] = [];

  /** Members whose socket is currently attached. 2026-09-15: a bot has no socket — humans only are counted. */
  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected && !isBotPlayer(p)) n++;
    return n;
  }

  /* ── 2026-09-15: android bot members ──────────────────────────── */
  /** Human members (connected or not). The squad cap · dissolving · presence all use this count. */
  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!isBotPlayer(p)) n++;
    return n;
  }

  /** Android bot members. */
  botCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (isBotPlayer(p)) n++;
    return n;
  }

  /** The bot that walked out of cockpit bay `bay`, or null. */
  botOnBay(bay: number): LobbyPlayer | null {
    for (const p of this.players.values()) if (isBotPlayer(p) && p.bay === bay) return p;
    return null;
  }

  /** The latest-recruited bot (the higher bay on a tie) — this is the unit that goes back when a human joins. */
  latestBot(): LobbyPlayer | null {
    let best: LobbyPlayer | null = null;
    for (const p of this.players.values()) {
      if (!isBotPlayer(p)) continue;
      if (!best) { best = p; continue; }
      const a = p.recruitedAt ?? 0, b = best.recruitedAt ?? 0;
      if (a > b || (a === b && (p.bay ?? 0) > (best.bay ?? 0))) best = p;
    }
    return best;
  }

  /**
   * The squad leader takes the android in cockpit bay `bay` on as a squadmate. A bot eats a **real slot** too (the
   * launch pod · the colour · the spawn spacing follow the slot). No free slot → `'full'`; already out, or a bay
   * outside the range → `'invalid'`.
   */
  addBot(bay: number, now: number = Date.now()): LobbyPlayer | LobbyErrorCode {
    if (!Number.isInteger(bay) || bay < 0 || bay >= ANDROID_BAY_COUNT) return 'invalid';
    if (this.botOnBay(bay)) return 'invalid';
    const slot = this.freeSlot();
    if (slot < 0) return 'full';
    const id = androidIdOf(this.code, bay);
    if (this.players.has(id)) return 'invalid';
    const bot: LobbyPlayer = {
      id, name: androidNameOf(bay), slot, ready: true, isHost: false, connected: true,
      /* With a raid running it counts as inside at once — recruiting only works before the start, so in practice
         this is always false. */
      inMission: this.started && this.mode !== 'training',
      bot: true, bay, recruitedAt: now,
    };
    this.players.set(id, bot);
    return bot;
  }

  /** Takes the bot of bay `bay` out of the squad and back to its bay. null when there is none. */
  removeBot(bay: number): LobbyPlayer | null {
    const bot = this.botOnBay(bay);
    if (!bot) return null;
    this.players.delete(bot.id);
    return bot;
  }

  /** Every human is gone — bots cannot keep a lobby alive (`LobbyManager.leave`). */
  clearBots(): LobbyPlayer[] {
    const out: LobbyPlayer[] = [];
    for (const p of Array.from(this.players.values())) if (isBotPlayer(p)) { this.players.delete(p.id); out.push(p); }
    return out;
  }

  /** Takes the bots `add` removed to make room for a human (once only). The relay broadcasts them after the join. */
  takeReturnedBots(): LobbyPlayer[] {
    if (this.returnedBots.length === 0) return [];
    return this.returnedBots.splice(0, this.returnedBots.length);
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

  /**
   * Members currently inside the running mission (`inMission`).
   * 2026-09-15: **humans only** — in the judgement 「a mission with nobody inside is over」 (`remove` ·
   * `autoResetMission`) a bot must not keep a raid alive forever.
   */
  inMissionCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.inMission && !isBotPlayer(p)) n++;
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
   *
   * 2026-09-15 (android squadmates): **humans only** — humans win over bots. When a human comes to a squad filled
   * with bots, `add` sends the latest-recruited bot back to its bay and gives the place away (user's decision).
   */
  canAdd(): LobbyErrorCode | null {
    if (!this.isJoinable()) return 'started';
    if (this.humanCount() >= NET_MAX_PLAYERS) return 'full';
    return null;
  }

  /** `accent` (2026-09-15): the joiner's `#rrggbb` as the relay already sanitized it; null / omitted = unknown (field absent). */
  add(id: PeerId, name: string, accent?: string | null): LobbyPlayer | LobbyErrorCode {
    const refused = this.canAdd();
    if (refused !== null) return refused;
    /*
     * 2026-09-15: humans win over bots. Past `canAdd` with no free slot left, every remaining place belongs to a
     * bot — they go back latest-recruited first (the relay broadcasts `returnedBots` after the join).
     */
    while (this.freeSlot() < 0) {
      const bot = this.latestBot();
      if (!bot) break;
      this.players.delete(bot.id);
      this.returnedBots.push(bot);
    }
    const slot = this.freeSlot();
    if (slot < 0) return 'full';   // full of humans alone (cannot disagree with canAdd; the contract pinned in code)
    const player: LobbyPlayer = { id, name, slot, ready: false, isHost: id === this.hostId, connected: true, inMission: false };
    if (accent) player.accent = accent;
    this.players.set(id, player);
    return player;
  }

  /** 2026-09-15: `lobby:look` / a reconnect with `?a=`. true when the member's accent actually changed (→ broadcast). */
  setAccent(id: PeerId, accent: string): boolean {
    const p = this.players.get(id);
    if (!p || p.accent === accent) return false;
    p.accent = accent;
    return true;
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
    for (const p of this.players.values()) if (p.connected && !isBotPlayer(p)) anyConnected = true;
    for (const p of this.players.values()) {
      /* 2026-09-15: a bot never becomes the squad leader — there is no client to run the simulation. */
      if (isBotPlayer(p)) continue;
      if (this.started) { if (!p.connected || !p.inMission) continue; }
      else if (anyConnected && !p.connected) continue;
      if (!next || p.slot < next.slot) next = p;
    }
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    for (const p of this.players.values()) p.isHost = p.id === this.hostId;
    this.hostDown = false;   // 2026-09-09: the new host is alive — the down flag does not follow the host role
    return true;
  }

  /**
   * 2026-09-09 — **the named transfer**. Skips `migrateHost`'s slot rule and makes `targetId` the squad leader as
   * it is (a right click in the community screen · an interaction inside the ship · the squad-leader device). Only
   * a **connected** member of the same lobby is accepted. A transfer clears the down flag as well.
   */
  transferHostTo(targetId: PeerId): boolean {
    const p = this.players.get(targetId);
    /* 2026-09-15: a bot cannot be the squad leader (the same reason as in `migrateHost`) — the relay answers this
       with `invalid`. */
    if (!p || !p.connected || isBotPlayer(p)) return false;
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
      delete p.drifted;   // 2026-09-15: drifting belongs to **that raid** — a new one is a new one
    }
  }

  /**
   * End the mission and reopen the lobby. Phase 11: `planet` is deliberately **not** cleared.
   * 2026-09-14: `intel` **is** — the intel was consumed by that raid (the host's profile clears it too).
   */
  reset(): void {
    this.started = false;
    this.seed = null;
    this.mode = null;
    this.intel = null;
    this.raid.clear();
    this.hostDown = false;   // 2026-09-09: the end of the mission ends the leader's down flag too
    /* 2026-09-15: a bot is always ready — dropping its `ready` after a reset would keep the squad from ever
       launching. */
    for (const p of this.players.values()) { p.ready = isBotPlayer(p); p.inMission = false; delete p.drifted; }
  }

  /**
   * 2026-09-15 (abandoning the raid from the title): this member threw away the running raid — **drifting**. It is
   * taken out of the mission and its blob dropped (there is nothing left to resume). The flag stays until `start()`
   * · `reset()` and blocks any `lobby:mission {true}` in between (the relay's `drifted`).
   * false when there is no raid, or the id is not a member.
   */
  setDrifted(id: PeerId): boolean {
    const p = this.players.get(id);
    if (!p || isBotPlayer(p) || !this.started || (this.mode ?? 'raid') !== 'raid') return false;
    p.drifted = true;
    p.inMission = false;
    this.raid.delete(id);
    return true;
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
    if (this.players.get(id)?.drifted) return false;   // 2026-09-15: an abandoned raid has nothing left to save
    this.raid.set(id, blob);
    return true;
  }

  /** The member's blob when it still belongs to the running raid, else null. */
  getRaid(id: PeerId): RaidSessionBlob | null {
    if (!this.started || this.mode === 'training') return null;
    const b = this.raid.get(id);
    return b && b.seed === this.seed ? b : null;
  }

  /**
   * Open to newcomers via quick match (a not-started lobby, or one whose members are only training).
   * 2026-09-15: only a **docked** lobby — an undocked squad is still spread over personal ships, and a stranger quick-matched
   * into it would have no shared ship to arrive in.
   * 2026-09-15 (android squadmates): bots **are** counted here — a squad filled with androids takes no more
   * strangers (user's spec). An invite still goes through (`canAdd` counts humans only) — someone they know pushes
   * a bot out and comes in.
   */
  isQuickMatchable(): boolean {
    return this.docked && this.isPublic && this.isJoinable() && this.players.size < NET_MAX_PLAYERS && this.freeSlot() >= 0;
  }

  toState(): LobbyState {
    const players = Array.from(this.players.values())
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ ...p }));
    /* 2026-09-15: `docked` is always sent (absent means "older server → docked" to the client, so false must be explicit). */
    const state: LobbyState = { code: this.code, hostId: this.hostId, players, started: this.started, seed: this.seed, isPublic: this.isPublic, docked: this.docked };
    if (this.started && this.mode) state.mode = this.mode;
    if (this.planet) state.planet = this.planet;
    if (this.intel) state.intel = this.intel;   // 2026-09-14: the intel broker — shape sanitized, echoed as it is
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

  /**
   * `opts` (2026-09-15): `docked` (default true — only the relay's 같이 하기 makes an undocked squad) and the host's `accent`.
   */
  create(hostId: PeerId, name: string, isPublic = false, opts: { docked?: boolean; accent?: string | null } = {}): Lobby | LobbyErrorCode {
    if (this.byPeer.has(hostId)) return 'in_lobby';
    let code = randomLobbyCode();
    let guard = 0;
    while (this.lobbies.has(code) && guard++ < 1000) code = randomLobbyCode();
    if (this.lobbies.has(code)) return 'server';
    const lobby = new Lobby(code, hostId, isPublic);
    if (opts.docked === false) lobby.docked = false;
    lobby.add(hostId, name, opts.accent);
    this.lobbies.set(code, lobby);
    this.byPeer.set(hostId, lobby);
    return lobby;
  }

  join(id: PeerId, code: string, name: string, accent?: string | null): Lobby | LobbyErrorCode {
    if (this.byPeer.has(id)) return 'in_lobby';
    const lobby = this.lobbies.get(code);
    if (!lobby) return 'not_found';
    const res = lobby.add(id, name, accent);
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
   * relay skips every lobby holding a block either way. Skipping (rather than refusing) is the point: public lobbies
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
  quickMatch(id: PeerId, name: string, accept?: (lobby: Lobby) => boolean, accent?: string | null): { lobby: Lobby; created: boolean } | LobbyErrorCode {
    if (this.byPeer.has(id)) return 'in_lobby';
    const open = this.findQuickMatch(accept);
    if (open) {
      const res = open.add(id, name, accent);
      if (typeof res === 'string') return res;
      this.byPeer.set(id, open);
      this.adoptHostIfAbsent(open);
      return { lobby: open, created: false };
    }
    const lobby = this.create(id, name, true, { accent });
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
  move(id: PeerId, toCode: string, name: string, accent?: string | null):
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
    const added = to.add(id, name, accent);
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
    /* 2026-09-15: androids cannot keep a lobby alive — once every human is gone the bots go with them and the
       lobby is deleted. */
    if (lobby.humanCount() === 0) lobby.clearBots();
    let deleted = false;
    if (lobby.size === 0) { this.lobbies.delete(lobby.code); deleted = true; }
    return { lobby, hostMigrated, deleted };
  }
}
