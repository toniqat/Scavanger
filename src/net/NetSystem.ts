import type {
  GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, RelayTarget, RemotePlayerRef, ServerToClient,
} from '@/shared';
import type { MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, RelayProbe, SocialRef } from '@/shared';
/* 2026-09-14: the intel broker — the fixed gimmicks the lobby carries (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
import type { IntelWire } from '@/shared';
import type { NetLinkInfo } from '@/shared';
/* appended (2026-09-08): the shared ship's hangar */
import type { ShipVisitWire } from '@/shared';
/* 2026-09-15: squads · dock matching — the shared-ship test · the accent colour in the connect URL (`?a=`) */
import { NET_ACCENT_PARAM, activeSlot, isDockedLobby, readSlotCard, sanitizeAccent } from '@/shared';
/* 2026-09-15: android squadmates — tells a bot member from a person (`src/shared/net.ts`, last section) */
import { humanPlayersOf } from '@/shared';
import {
  NET_INVITE_PARAM, isValidLobbyCode, normalizeLobbyCode, sanitizePlayerName, slotKey,
} from '@/shared';
import { NetClient } from './NetClient';
import { ProfileSync } from './ProfileSync';
import { PROFILE_QUEUE_STORAGE_KEY } from '@/shared';
import { SocialSync } from './SocialSync';
import { RoomSync } from './RoomSync';
import type { RoomsRef } from '@/shared';
import { RemotePlayer } from './RemotePlayer';
import { Snapshotter } from './Snapshotter';
import type { CrewCardWire } from '@/shared';

import { type Handler, NAME_STORAGE_KEY, SNAPSHOT_INTERVAL, loadOrCreateSessionToken } from './model';
/** `model.ts` owns the folder vocabulary (constants · types · scratch) — re-exported for the old import paths. */
export * from './model';
import * as Sock from './parts/Socket';
import * as Lobby from './parts/Lobby';
import * as Remotes from './parts/Remotes';
import * as Msg from './parts/Messages';
/* 2026-09-16 (the plate model): the old `parts/Meal` (the table's 「분대에 차리기」) is gone — the plate wire replaces it */
import { PlateRelay } from './parts/Plates';
import { CharBuffRelay } from './parts/CharBuffs';
/* 2026-09-13: the crypto quote desk `ctx.net.crypto` */
import { CryptoMarketClient } from './parts/Crypto';
import type { CryptoMarketRef } from '@/shared';

export class NetSystem implements GameSystem, NetRef {
  readonly name = 'net';

  ctx!: GameContext;
  readonly client = new NetClient();
  readonly snapshotter = new Snapshotter();
  readonly handlers = new Map<GameMessageType, Set<Handler>>();
  readonly remotes = new Map<PeerId, RemotePlayer>();
  remoteList: RemotePlayer[] = [];
  lastSnapshotAt = -Infinity;

  _playerName = sanitizePlayerName('');
  readonly _sessionToken = loadOrCreateSessionToken();
  _lobby: LobbyState | null = null;
  _inSession = false;
  private _inviteCode: string | null = null;
  /** Seed of the mission we are (or were, before a drop) in. */
  missionSeed: number | null = null;
  /** Last id the server gave us; kept through a drop so `isHost`/`isAuthority` do not flip while reconnecting. */
  lastLocalId: PeerId | null = null;
  pendingQuickMatch = false;
  /** 2026-09-15 (squads · dock matching): `requestDock` sent, no docked lobby / error yet — `NetRef.dockPending`. */
  _dockPending = false;
  /**
   * 2026-09-21 (B-101): the ship model id last sent in `lobby:look`, so the nudge is sent **once per value**.
   * It cannot be judged from my own lobby row any more: the relay fills that row from the profile store, so a
   * profile that has uploaded no `progression` document leaves it empty for good and comparing against it sent a
   * nudge on every `lobby:state` — which broadcast another state, which nudged again. Cleared on disconnect.
   */
  _pushedShipModel: string | null = null;

  /* ── reconnect state machine ── */
  private lastStatus: NetStatus = 'offline';
  /** `disconnect()` was called: the coming close is intentional. */
  intentionalClose = false;
  /** The server closed us with `duplicate` (same token from another tab): never auto-reconnect after that. */
  duplicateKicked = false;
  /**
   * 2026-09-11 (C-29): the relay closed us on purpose — `kicked` (operator console) or `server_full` (operator cap).
   * Like `duplicateKicked` it stops auto-reconnect; an explicit `connect()` (the terminal's `다시 연결`) clears it — there is no ban.
   */
  serverRefused: 'kicked' | 'server_full' | null = null;
  _reconnecting = false;
  reconnectAttempt = 0;
  reconnectStartedAt = 0;
  reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lobby kept alive locally while the socket is down. */
  lobbySuspended = false;
  /** We were inside a running mission when the socket dropped (seamless-resume candidate). */
  wasInSessionAtDrop = false;

  /* ── B-1 (2026-09-11): link state · background probe — rules in `parts/Socket` (`setLink` / `goUnreachable`) ── */
  /** Stored link (`link` getter adds the live `nextProbeInMs`). `url` = the address the state is about. */
  _link: NetLinkInfo = { state: 'idle', url: '' };
  probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 0-based index into `NET_PROBE_BACKOFF_MS` for the next wait (last value repeats). */
  probeAttempt = 0;
  /** `performance.now()` at which the pending probe fires (valid while `probeTimer` is set). */
  probeDueAt = 0;
  /** Bumped by every stop / restart: an in-flight probe of an older generation is ignored. */
  probeGen = 0;

  /* ── Phase 7 ── */
  readonly profileSync = new ProfileSync();
  _raidBlob: RaidSessionBlob | null = null;
  /** Mode of the session we are in (valid while `_inSession`). */
  sessionMode: MissionMode = 'raid';
  _tookOver = false;
  /** Host id before the last change (for `flow takeover` events that arrive after the lobby state). */
  prevHostId: PeerId | null = null;
  /** Last `inMission` we reported per member (`net:missionMembership` diffs). */
  readonly membership = new Map<PeerId, boolean>();
  raidTooLargeWarned = false;
  /* ── Phase 9 ── */
  /** `serverTime - performance.now()` from the last welcome / pong of ANY connection this session (null = never welcomed). */
  serverOffset: number | null = null;

  /* ── Phase 10 ── */
  /**
   * Last `crew card` per member, **including our own** (recorded from `send()` when hub/ broadcasts it, so the READY
   * panel reads the local cell through the same accessor). Cleared with the lobby.
   */
  readonly crewCards = new Map<PeerId, CrewCardWire>();
  /**
   * The shared ship's hangar (2026-09-08): the last `ship state` seen per peer (our own included — `send()` snoops
   * it exactly like a crew card). hub/ renders a hangar bay's ship straight out of this map.
   */
  readonly shipVisits = new Map<PeerId, ShipVisitWire>();
  /** true while anybody (local or remote) is carrying someone: gates the per-frame `carriedBy` derivation. */
  carryActive = false;

  /* ── Phase 11 ── */
  /** `ctx.net.social`: the relay's social state (friends / requests / recent / whispers / squad invites). */
  readonly socialSync = new SocialSync();
  /** 2026-09-14: `ctx.net.rooms` — the group-room mirror (`RoomSync`). */
  readonly roomSync = new RoomSync();

  /* ── A-3c (2026-09-11) → the dining plate (2026-09-16) ── */
  /** 2026-09-16: the dining plate — `plate state` / `plateq sync` (`parts/Plates`). */
  readonly plateRelay = new PlateRelay();

  /* ── 2026-09-12: character buffs ── */
  /** `cbuf state` / `cbufq sync` + the per-member list store (`parts/CharBuffs`). */
  readonly charBuffRelay = new CharBuffRelay();

  /* ── 2026-09-13: crypto quotes ── */
  /** `crypto:watch` refcount + the last `crypto:prices` / `crypto:history` (`parts/Crypto`). */
  readonly cryptoMarket = new CryptoMarketClient();
  /** `ctx.net.crypto`: server quotes · candle history (`available` false = offline, or no quote received yet). */
  get crypto(): CryptoMarketRef { return this.cryptoMarket; }

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
  /**
   * 2026-09-15 (squads · dock matching): a squad (a lobby) is not the same thing as the shared ship. Hub snapshots
   * travel only inside a **docked** squad's shared ship (the deck · the hangar · a personal ship entered from the
   * hangar) — undocked squadmates each stand in a **different** personal ship built at the same origin, so their
   * avatars would be drawn at somebody else's ship coordinates. Standing in the personal ship during the dock
   * countdown is the same case.
   */
  get inHubSession(): boolean {
    if (!isDockedLobby(this._lobby) || this._inSession || this.ctx.phase !== 'hub') return false;
    const hub = this.ctx.hub;
    return !!hub && (hub.ship === 'shared' || hub.hubSite !== null);
  }
  /* ── Phase 7 ── */
  get profile(): ProfileRef { return this.profileSync; }
  get raidBlob(): RaidSessionBlob | null { return this._raidBlob; }
  get missionMode(): MissionMode | null { return this._lobby?.started ? (this._lobby.mode ?? 'raid') : null; }
  get tookOver(): boolean { return this._tookOver; }
  /* ── Phase 11 ── */
  /** The squad's target planet (`lobby.planet`), or null outside a lobby / while nothing is picked. */
  get lobbyPlanet(): PlanetId | null { return this._lobby?.planet ?? null; }
  /**
   * Host only, while not started: share the target planet with the ship. Mirrored optimistically (like
   * `setLobbySeed`) so the host's own terminal reacts without a round trip; the server's `lobby:state` confirms it
   * for everyone else.
   * There is no travel message — each client starts the cutscene off its own copy of `lobby.planet`.
   */
  setLobbyPlanet(planet: PlanetId): void { return Lobby.setLobbyPlanet(this, planet); }
  /* ── 2026-09-14: the intel broker (docs/DECISIONS.md 「2026-09-14 — 정보상」) ── */
  /** Fixed gimmicks the leader bought (`lobby.intel`) — null with no lobby / nothing bought; squadmates read only. */
  get lobbyIntel(): IntelWire | null { return this._lobby?.intel ?? null; }
  /** Leader only, before the start: announces the intel bought (or dropped = null) — `setLobbyPlanet`'s contract. */
  setLobbyIntel(intel: IntelWire | null): void { return Lobby.setLobbyIntel(this, intel); }
  /** Friends · requests · recent · private chat · squad invites (always present; `available` false offline). */
  get social(): SocialRef { return this.socialSync; }
  /** 2026-09-14: group rooms (always present; `available` is false offline / anonymous / a relay without rooms). */
  get rooms(): RoomsRef { return this.roomSync; }
  /* ── Phase 8 ── */
  /**
   * Relay wall clock in epoch ms: the offset captured at the last `welcome` / `pong` plus the elapsed local time.
   * `performance.now()` is monotonic, so moving the system clock cannot advance a crop timer. Phase 9: the last
   * offset is **kept through a disconnect** (profile stamps written offline stay on the server's clock); only a
   * session that never saw a welcome falls back to `Date.now()` (single-player keeps working on the local clock).
   */
  serverNow(): number { return Sock.serverNow(this); }

  /* ── GameSystem ─────────────────────────────────────────────────────── */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.net = this;
    this.profileSync.bus = ctx.bus;
    this.profileSync.send = (m) => this.client.send(m);
    this.profileSync.serverNow = () => this.serverNow();
    // 2026-09-11 (E-6): the write queue survives a reload / an offline session (per character slot)
    this.profileSync.useStorage(slotKey(PROFILE_QUEUE_STORAGE_KEY));
    /* Phase 11: the social mirror gets the same injected wiring (no socket / no lobby knowledge of its own). */
    this.socialSync.bus = ctx.bus;
    this.socialSync.send = (m) => this.client.send(m);
    this.socialSync.serverNow = () => this.serverNow();
    this.socialSync.joinLobby = (code) => this.joinLobby(code);
    /*
     * 2026-09-15 (android squadmates): the squad size the social gates use counts **humans only** — the same rule
     * as the relay's `presenceOf` · `canAdd` (a human beats a bot, so a friend can still join a squad filled with
     * androids). Anywhere that asks "how many fighters" — difficulty · enemy scaling — **does** count androids,
     * and that side reads the lobby directly in enemies/.
     */
    this.socialSync.squadSize = () => humanPlayersOf(this._lobby).length;
    /* 2026-09-15 (squads · dock matching): squad-invite gate — codes in my squad · "in a squad I do not lead" */
    this.socialSync.squadCodes = () => {
      const me = this.localId;
      const out: string[] = [];
      for (const p of this._lobby?.players ?? []) if (p.id !== me && typeof p.code === 'string' && p.code) out.push(p.code);
      return out;
    };
    this.socialSync.iAmMember = () => this._lobby !== null && !this.isHost;
    /* 2026-09-14: the room mirror borrows my card and the block list from the social mirror. */
    this.roomSync.bus = ctx.bus;
    this.roomSync.send = (m) => this.client.send(m);
    this.roomSync.serverNow = () => this.serverNow();
    this.roomSync.me = () => this.socialSync.me;
    this.roomSync.isBlocked = (code) => this.socialSync.isBlocked(code);

    try {
      const stored = localStorage.getItem(slotKey(NAME_STORAGE_KEY));
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
        this.socialSync.onDisconnected();   // Phase 11: nothing social survives a connection (the server owns it)
        this.roomSync.onDisconnected();     // 2026-09-14: rooms are server-owned too (the line cache stays)
        this.cryptoMarket.onDisconnected(); // 2026-09-13: prices are only `available` on a live connection
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
    // 2026-09-09: chat input open/closed → PlayerFlags.TYPING (remotes draw the `…` bubble; ui/hud owns the drawing).
    bus.on('ui:chatToggled', (e) => { this.snapshotter.typing = e.open; });
    bus.on('player:died', (e) => {
      if (this._inSession) this.send({ t: 'died', p: [e.position.x, e.position.y, e.position.z] }, 'others');
    });
    // NetSystem runs before GameFlow/Extraction, whose handlers for these same events still need `inSession`,
    // `isAuthority` and `send()` intact (they broadcast `flow abort` / `ex reset`). End the session in a microtask.
    // None of these leave the lobby: a client that aborts alone returns to the shared ship (`missionInProgress`).
    bus.on('game:complete', () => this.scheduleEndSession());
    bus.on('game:over', () => this.scheduleEndSession());
    bus.on('game:abort', () => this.scheduleEndSession());
    /* Phase 11: publish my level for friends' rows (debounced inside SocialSync; progression may be absent). */
    bus.on('progress:loaded', () => this.pushLevel());
    bus.on('progress:levelUp', () => this.pushLevel());
    /*
     * 2026-09-09: the **shared entrance** to handing the squad leader over. The community window's right-click menu
     * and the interaction inside the shared ship both emit the same event — neither grabs `ctx.net` directly.
     */
    bus.on('leader:transferRequested', ({ peerId }) => this.transferHost(peerId));
    /* B-1 (2026-09-11): a server the background probe found during a raid / training is joined once we are back in the ship / title. */
    bus.on('game:phaseChanged', ({ phase }) => Sock.onPhaseChanged(this, phase));
    /* 2026-09-16: the dining plate — `housing:plateChanged` ↔ `plate` / `plateq` → `net:squadPlate`
     * (`parts/Plates`, replacing the old `meal` wire). */
    this.plateRelay.init(this);
    /* 2026-09-12: character buffs — `player:buffsChanged` ↔ `cbuf` / `cbufq` (`parts/CharBuffs`). */
    this.charBuffRelay.init(this);
    /* 2026-09-13: crypto quotes — `crypto:watch` refcount / history cache
     * (`parts/Crypto`, wired in Messages + onStatus). */
    this.cryptoMarket.init(this);
  }

  /** `social:me` with the current character level; a no-op without a progression system (headless tests / stubs). */
  pushLevel(): void { return Remotes.pushLevel(this); }

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
      // Phase 10: derive `carriedBy` from everyone's `carrying` (≤ 4 refs; skipped entirely while nobody carries).
      this.refreshCarriedBy();

      // 2026-09-12: my buff list changed since the last frame → one `cbuf state`, sent BEFORE the snapshot that carries
      // the new `bfr`, so receivers normally never see the revision ahead of the list (any phase, while in a lobby).
      this.charBuffRelay.flush();
      this.plateRelay.tick();   // 2026-09-16: the frame the hub session is entered — my plate + `plateq sync`

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
    Sock.stopProbe(this);
    this.intentionalClose = true;
    this.profileSync.flush();
    this.socialSync.dispose();
    this.roomSync.dispose();
    this.plateRelay.dispose();
    this.charBuffRelay.dispose();
    this.cryptoMarket.dispose();
    this.client.close();
    this.clearRemotes();
    this.handlers.clear();
    if (this.ctx && this.ctx.net === this) this.ctx.net = null;
  }

  /* ── connection ─────────────────────────────────────────────────────── */
  connect(url?: string): Promise<void> { return Sock.connect(this, url); }

  async ensureConnected(): Promise<boolean> { return Sock.ensureConnected(this); }

  disconnect(): void { return Sock.disconnect(this); }

  setPlayerName(name: string): void {
    this._playerName = sanitizePlayerName(name);
    try { localStorage.setItem(slotKey(NAME_STORAGE_KEY), this._playerName); } catch { /* storage unavailable */ }
    // Already in a lobby → rename there too (server sanitizes + broadcasts).
    if (this.client.connected && this._lobby) this.client.send({ t: 'lobby:name', name: this._playerName });
  }

  defaultUrl(): string { return Sock.defaultUrl(this); }

  /* ── the link state (2026-09-11, B-1): every transition goes through `parts/Socket`'s `setLink` ── */
  get link(): NetLinkInfo { return Sock.linkInfo(this); }

  /* ── the server address (2026-09-10) ────────────────────────────── */
  get relayUrl(): string { return Sock.defaultUrl(this); }

  get relayOverride(): string { return Sock.relayOverride(); }

  setRelayOverride(raw: string): boolean { return Sock.setRelayOverride(this, raw); }

  probeRelay(raw?: string): Promise<RelayProbe> { return Sock.probeRelay(this, raw); }

  reconnectRelay(): Promise<boolean> { return Sock.reconnectRelay(this); }

  /**
   * Append `?t=<token>&n=<name>` (NET_TOKEN_PARAM / NET_NAME_PARAM) to a relay URL. 2026-09-15: plus `&a=<accent>`
   * (`NET_ACCENT_PARAM`) — this character's `PlayerProfile.accent`, read from the slot card exactly like
   * `player/PlayerSystem` does, so `매칭` tab portraits (`LobbyPlayer.accent`) know it from the first `lobby:state`.
   * No valid accent (no card yet · storage off) → nothing is added and the portrait falls back to the slot colour.
   */
  withSession(url: string): string {
    const base = Sock.withSession(this, url);
    let accent: string | null = null;
    try { accent = sanitizeAccent(readSlotCard(activeSlot()).accent); } catch { accent = null; }
    return accent ? `${base}&${NET_ACCENT_PARAM}=${encodeURIComponent(accent)}` : base;
  }

  /* ── reconnect ──────────────────────────────────────────────────────── */
  /** Socket went offline/error. `wasConnected` = an established (welcomed) connection dropped, not a failed attempt. */
  private onSocketDown(wasConnected: boolean): void { return Sock.onSocketDown(this, wasConnected); }

  beginReconnect(): void { return Sock.beginReconnect(this); }

  scheduleReconnect(): void { return Sock.scheduleReconnect(this); }

  async attemptReconnect(): Promise<void> { return Sock.attemptReconnect(this); }

  stopReconnect(): void { return Sock.stopReconnect(this); }

  /** `welcome` arrived (first connect, reconnect or fresh page load). */
  onWelcome(msg: Extract<ServerToClient, { t: 'welcome' }>): void { return Sock.onWelcome(this, msg); }

  /* ── lobby ops ──────────────────────────────────────────────────────── */
  createLobby(): void { return Lobby.createLobby(this); }
  joinLobby(code: string): void { return Lobby.joinLobby(this, code); }
  leaveLobby(): void { return Lobby.leaveLobby(this); }
  setReady(ready: boolean): void { return Lobby.setReady(this, ready); }
  /**
   * Raid (default): host only, everyone ready. Training: any member; only the caller enters (`inMission`).
   * Phase 11: `planet` is the raid's target planet (the server refuses a raid without one — `no_planet`); a training
   * ignores it, and an unknown id is dropped here rather than sent. Falls back to `lobby.planet` when omitted.
   */
  startGame(seed: number, mode?: MissionMode, planet?: PlanetId, intel?: IntelWire | null): void { return Lobby.startGame(this, seed, mode, planet, intel); }

  quickMatch(): void { return Lobby.quickMatch(this); }
  setPublic(isPublic: boolean): void { return Lobby.setPublic(this, isPublic); }
  requestDock(isPublic: boolean): void { return Lobby.requestDock(this, isPublic); }
  get dockPending(): boolean { return this._dockPending; }
  /**
   * 2026-09-15 (android squadmates): leader only — recruits the android of cockpit bay `bay` into the squad
   * (`recruit`) or sends it back to its bay. The result is a new `lobby:state` (`net:lobbyUpdated`), a refusal is
   * `net:error`. A unit pushed out because a human joined arrives separately as `net:androidReturned {bay, reason}`.
   */
  setAndroidBay(bay: number, recruit: boolean): void { return Lobby.setAndroidBay(this, bay, recruit); }
  setLobbySeed(seed: number): void { return Lobby.setLobbySeed(this, seed); }

  /* ══ 2026-09-09: host transfer by nomination ════════════════ */
  /**
   * Hands the squad leader over to `targetId`. The server allows it when ① I am the host right now, or ② it is a
   * `claim` and the current host raised its death flag with `reportHostDown(true)` (the squad-leader device) —
   * anything else is `not_host`. On success a new `lobby:state` arrives and everyone gets `net:hostChanged`.
   * Outside a lobby it is a no-op.
   */
  transferHost(targetId: PeerId, claim?: boolean): void { return Lobby.transferHost(this, targetId, claim); }

  /** The host tells the server it died fully in this raid — the only condition someone else's `claim` works under. */
  reportHostDown(down: boolean): void { return Lobby.reportHostDown(this, down); }

  /**
   * Re-enter the running mission (raid after a resume, or join a running training from the terminal): tells the
   * server (`lobby:mission true`), starts the session with the lobby's mode and announces `flow rejoined` so the host
   * re-syncs us (extraction / pickups / containers / ghosts — our own body comes back with `ghost restore`).
   */
  rejoinMission(): void { return Lobby.rejoinMission(this); }

  /** Leave the running mission but stay in the lobby (training exit, raid abort by a client). */
  leaveMission(): void { return Lobby.leaveMission(this); }

  /** 2026-09-15 (title `레이드 포기`): throws away the raid we left → `lobby:abandon` (drifted from that raid). */
  abandonRaid(): void { return Lobby.abandonRaid(this); }

  /** Upload my mid-raid state (game/ calls it periodically and on loot). Only inside a raid session. */
  saveRaid(blob: RaidSessionBlob): void { return Lobby.saveRaid(this, blob); }

  getInviteUrl(): string | null { return Lobby.getInviteUrl(this); }

  /* ── game messages ──────────────────────────────────────────────────── */
  send(msg: GameMessage, to: RelayTarget = 'others'): void { return Msg.send(this, msg, to); }

  onMessage<T extends GameMessageType>(type: T, handler: (msg: GameMessageOf<T>, from: PeerId) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const h = handler as unknown as Handler;
    set.add(h);
    return () => { this.handlers.get(type)?.delete(h); };
  }

  getRemotePlayers(): readonly RemotePlayerRef[] { return Remotes.getRemotePlayers(this); }
  getRemotePlayer(id: PeerId): RemotePlayerRef | undefined { return Remotes.getRemotePlayer(this, id); }
  getLobbyPlayer(id: PeerId): LobbyPlayer | undefined { return Lobby.getLobbyPlayer(this, id); }

  /* ── inbound: server ────────────────────────────────────────────────── */
  private handleServerMessage(msg: ServerToClient): void { return Msg.handleServerMessage(this, msg); }

  /**
   * Enter the mission of `lobby` with `seed` (server `game:start`, or `rejoinMission()`).
   * Phase 11: `planet` is the raid's target planet (null for a training / an older relay with nothing picked).
   */
  beginSession(seed: number, lobby: LobbyState, mode: MissionMode, rejoin: boolean, planet: PlanetId | null, intel: IntelWire | null = null): void { return Lobby.beginSession(this, seed, lobby, mode, rejoin, planet, intel); }

  applyLobby(next: LobbyState): void { return Lobby.applyLobby(this, next); }

  /**
   * `lobby.hostId` changed while the lobby runs a mission. Inside the session this is a migration: promote / demote
   * systems, announce a takeover. Phase 9: the event goes out even when we are NOT in the session (hub member of a
   * running lobby — every system is a no-op outside a live mission), but `tookOver` / `flow takeover` stay session-only.
   */
  onHostChanged(prev: PeerId, next: PeerId): void { return Lobby.onHostChanged(this, prev, next); }

  /**
   * Mirror lobby facts onto the remote refs (name / slot; Phase 7: `inMission`, `suspended`) and report membership
   * changes for every member (`net:missionMembership`), suspension changes for refs (`net:peerSuspended`).
   */
  syncRemoteIdentities(): void { return Remotes.syncRemoteIdentities(this); }

  playerInMission(p: LobbyPlayer, lobby: LobbyState): boolean { return Lobby.playerInMission(this, p, lobby); }

  dropLobby(reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved', to?: string): void { return Lobby.dropLobby(this, reason, to); }

  endSessionPending = false;
  /** Deferred session end: runs after every synchronous handler of the triggering bus event has finished. */
  private scheduleEndSession(): void { return Lobby.scheduleEndSession(this); }

  /**
   * Mission ended for us (complete / over / abort). Leaves the lobby intact — we return to the shared ship. Raid: the
   * host reopens the lobby (`lobby:reset`), a client that left alone reports `lobby:mission false` and sees
   * `missionInProgress` until the host resets. Training: everyone reports `lobby:mission false`; the server closes the
   * training once the last member left (never `lobby:reset`, other members may still be training).
   */
  endSession(): void { return Lobby.endSession(this); }

  /* ── inbound: relayed game messages ─────────────────────────────────── */
  handleRelay(from: PeerId, d: GameMessage): void { return Msg.handleRelay(this, from, d); }

  /** `ghost state` / `sync` entry for a lobby member (never ourselves): the ref is created when missing. */
  applyGhost(g: GhostWire): void { return Remotes.applyGhost(this, g); }

  /* ── remote players ─────────────────────────────────────────────────── */
  getOrCreateRemote(id: PeerId): RemotePlayer { return Remotes.getOrCreateRemote(this, id); }

  removeRemote(id: PeerId): void { return Remotes.removeRemote(this, id); }

  clearRemotes(): void { return Remotes.clearRemotes(this); }
  /* ══ Phase 10 — the ready panel's crew cards ═════════════════════ */
  /**
   * Last `crew card` seen for `id`, the local player included: hub/ owns *sending* the card and we snoop our own
   * broadcast in `send()`, so the READY panel reads every cell (ours and the squad's) through this one accessor.
   */
  getCrewCard(id: PeerId): CrewCardWire | null { return Remotes.getCrewCard(this, id); }

  /**
   * Ask `id` for its full loadout (`crewq loadout` addressed to that peer). The answer comes back as
   * `crew loadout` → `net:crewLoadout {id, card, loadout}`; a peer may rate-limit it (`CREW_LOADOUT_COOLDOWN_S`),
   * so the caller must tolerate no answer at all.
   */
  requestCrewLoadout(id: PeerId): void { return Remotes.requestCrewLoadout(this, id); }

  /** Mirror the ship-side card onto the member's ref (the wielded `implantId` stays snapshot-driven). */
  applyCrewCard(id: PeerId, card: CrewCardWire): void { return Remotes.applyCrewCard(this, id, card); }

  /* ══ the shared ship's hangar (2026-09-08) ══════════════════════ */
  /**
   * Last `ship state` seen for `id` (our own broadcast is snooped in `send()`, so our own id answers too). The hangar
   * bay reads this to build the parked member's interior; null means nothing has arrived yet and the bay asks.
   */
  getShipVisit(id: PeerId): ShipVisitWire | null { return Remotes.getShipVisit(this, id); }

  /**
   * Ask `id` for its ship layout (`shipq state` addressed to that peer). The answer comes back as `ship state` →
   * `net:shipVisit {id}`; a peer may rate-limit it (`SHIP_VISIT_COOLDOWN_S`), so the caller must tolerate silence.
   */
  requestShipVisit(id: PeerId): void { return Remotes.requestShipVisit(this, id); }

  /**
   * Phase 10: `RemotePlayerRef.carriedBy` is derived, not sent — every carrier advertises `carrying` and the carried
   * side only sets `PlayerFlags.CARRIED`. Runs once per frame while anybody carries (≤ 4 refs, so the O(n²) scan is
   * free) plus one trailing pass that clears the field when the last carry ends. A **suspended** carrier is ignored:
   * its socket is down, the host owns that body as a ghost, so the victim is no longer on a shoulder.
   */
  private refreshCarriedBy(): void { return Remotes.refreshCarriedBy(this); }

}
