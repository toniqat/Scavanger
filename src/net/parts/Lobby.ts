/**
 * src/net/parts/Lobby.ts — **the lobby · the session · the host transfer**.
 *
 * Create / join / quick match / ready / start / leave, picking the target planet, and the two ends of a mission.
 * **The lobby survives a mission's end** — the only thing that leaves a lobby is `leaveLobby()` (undocking).
 */
import type {
  LobbyPlayer, LobbyState,
  PeerId,
} from '@/shared';
import type { ClientToServer, MissionMode, RaidSessionBlob } from '@/shared';
import type { PlanetId } from '@/shared';
import { isPlanetId } from '@/shared';
/* 2026-09-14: the intel broker — the fixed gimmicks the lobby carries (docs/DECISIONS.md 「2026-09-14 — 정보상」) */
import type { IntelWire } from '@/shared';
import { resolveIntelEffects, sanitizeIntelPicks } from '@/shared';
import { isDockedLobby } from '@/shared';
/* 2026-09-15: android squadmates — a bot member is never treated as a person (`src/shared/net.ts`, last section) */
import { ANDROID_BAY_COUNT, isBotPlayer } from '@/shared';
/* 2026-09-21: the ship this character owns — the hangar parks each member's own (CLAUDE.md §4.8) */
import { shipModelOf } from '@/shared';
import {
  NET_INVITE_PARAM, RAID_BLOB_MAX_BYTES,
  isValidLobbyCode, normalizeLobbyCode,
} from '@/shared';
import { PEER_LINGER } from '../model';
import type { NetSystem } from '../NetSystem';

/**
 * Host only, while not started: share the target planet with the ship. Mirrored optimistically (like
 * `setLobbySeed`) so the host's own terminal reacts without a round trip; the server's `lobby:state` confirms it for
 * everyone else.
 * There is no travel message — each client starts the cutscene off its own copy of `lobby.planet`.
 */
export function setLobbyPlanet(sys: NetSystem, planet: PlanetId): void {
  if (!isPlanetId(planet)) return;
  const lobby = sys._lobby;
  if (!lobby || !sys.isHost || lobby.started) return;
  if (lobby.planet === planet) return;
  lobby.planet = planet;   // optimistic mirror; the broadcast confirms it
  // No event: hub/ drives its own terminal / cutscene from `setPlanet` and reacts to a *squadmate's* change through
  // the server's `net:lobbyUpdated`. Emitting here would make the host's own pick look like a remote one.
  sys.client.send({ t: 'lobby:planet', planet });
  }

/**
 * 2026-09-14 (the intel broker) — leader only, before the start: tells the squad the fixed gimmicks it bought (or
 * dropped = null) through `lobby:intel`. **Same contract** as `setLobbyPlanet` — an optimistic mirror the server's
 * `lobby:state` confirms, and no event (squadmates learn it through the ordinary `net:lobbyUpdated`). The server
 * only sanitizes the shape and rebroadcasts it; it computes no layout.
 */
export function setLobbyIntel(sys: NetSystem, intel: IntelWire | null): void {
  const lobby = sys._lobby;
  if (!lobby || !sys.isHost || lobby.started) return;
  const next = sanitizeIntelWire(intel);
  lobby.intel = next;   // optimistic mirror; the broadcast confirms it
  sys.client.send({ t: 'lobby:intel', intel: next });
  }

/** A wire-safe shape: an empty pick · an unknown gimmick reads as "not bought" (null) — `shared/intel`. */
export function sanitizeIntelWire(raw: IntelWire | null | undefined): IntelWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const seed = Number(raw.seed);
  if (!Number.isFinite(seed)) return null;
  const picks = sanitizeIntelPicks(raw.picks);
  return picks.length ? { seed: Math.floor(seed), picks } : null;
  }

/* ── lobby ops ──────────────────────────────────────────────────────── */
/*
 * 2026-09-15 (squads · dock matching): the three old entrances (`lobby:create` · `lobby:join` ·
 * `lobby:quickmatch`) still have the server create a **docked** lobby or put us in one — I pressed it, so exactly
 * like `requestDock` this is "my own dock" (`dockPending`). Without it hub/ reads the arrival as the leader's dock
 * and runs the countdown first (invite link · smokes · the old UI).
 */
export function createLobby(sys: NetSystem): void {
  sys.pendingQuickMatch = false;
  if (sys.client.connected) sys._dockPending = true;
  sys.client.send({ t: 'lobby:create', name: sys._playerName });
  }

export function joinLobby(sys: NetSystem, code: string): void {
  const norm = normalizeLobbyCode(code);
  if (!isValidLobbyCode(norm)) {
    sys.ctx.bus.emit('net:error', { code: 'invalid', message: '잘못된 로비 코드입니다. 6자리 코드를 입력하세요.' });
    return;
  }
  sys.pendingQuickMatch = false;
  if (sys.client.connected) sys._dockPending = true;
  sys.client.send({ t: 'lobby:join', code: norm, name: sys._playerName });
  }

export function leaveLobby(sys: NetSystem): void {
  sys.pendingQuickMatch = false;
  if (sys.client.connected) { sys.client.send({ t: 'lobby:leave' }); return; }
  // Offline with a suspended lobby: leaving is local (the server drops our slot when the grace expires).
  sys.stopReconnect();
  if (sys._lobby || sys._inSession) sys.dropLobby('left');
  }

export function setReady(sys: NetSystem, ready: boolean): void { sys.client.send({ t: 'lobby:ready', ready }); }

/**
 * Raid (default): host only, everyone ready. Training: any member; only the caller enters (`inMission`).
 * Phase 11: `planet` is the raid's target planet (the server refuses a raid without one — `no_planet`); a training
 * ignores it, and an unknown id is dropped here rather than sent. Falls back to `lobby.planet` when omitted.
 */
export function startGame(sys: NetSystem, seed: number, mode?: MissionMode, planet?: PlanetId, intel?: IntelWire | null): void {
  const s = Math.floor(seed) >>> 0;
  const training = mode === 'training';
  const p = training ? undefined : (isPlanetId(planet) ? planet : (sys._lobby?.planet ?? undefined));
  const msg: Extract<ClientToServer, { t: 'lobby:start' }> = { t: 'lobby:start', seed: s };
  if (mode) msg.mode = mode;
  if (p !== undefined) msg.planet = p;
  /* 2026-09-14 (the intel broker): with no argument given, `lobby.intel` (what already went up through
   * `lobby:intel`) rides along. A training never has one. */
  if (!training) {
    const w = sanitizeIntelWire(intel !== undefined ? intel : sys._lobby?.intel ?? null);
    if (w) msg.intel = w;
  }
  sys.client.send(msg);
  }

export function quickMatch(sys: NetSystem): void {
  if (!sys.client.connected) {
    sys.ctx.bus.emit('net:error', { code: 'server', message: '서버에 연결되어 있지 않습니다.' });
    return;
  }
  sys.pendingQuickMatch = true;
  sys._dockPending = true;   // 2026-09-15: a docked public lobby I asked for — see `createLobby`
  sys.client.send({ t: 'lobby:quickmatch', name: sys._playerName });
  }

export function setPublic(sys: NetSystem, isPublic: boolean): void { sys.client.send({ t: 'lobby:setPublic', isPublic }); }

/**
 * 2026-09-15 (android squadmates): the result of the leader holding the shared ship's cockpit bay `bay` for 3 s —
 * recruiting (`recruit`) / sending it back. The answer is one server `lobby:state` (`net:lobbyUpdated`); unlike
 * `setLobbyPlanet` nothing is mirrored optimistically — only the relay knows the cap (a human beats a bot) and only
 * the relay decides the slot. What cannot be sent returns its reason as `net:error` (`requestDock`'s contract).
 */
export function setAndroidBay(sys: NetSystem, bay: number, recruit: boolean): void {
  if (!Number.isInteger(bay) || bay < 0 || bay >= ANDROID_BAY_COUNT) return;
  if (!sys.client.connected) {
    sys.ctx.bus.emit('net:error', { code: 'server', message: '서버에 연결되어 있지 않습니다.' });
    return;
  }
  if (!sys._lobby) {
    sys.ctx.bus.emit('net:error', { code: 'not_in_lobby', message: '공용 함선에 도킹한 뒤에 할 수 있습니다.' });
    return;
  }
  if (!sys.isHost) {
    sys.ctx.bus.emit('net:error', { code: 'not_host', message: '분대장만 안드로이드를 배치할 수 있습니다.' });
    return;
  }
  sys.client.send({ t: 'lobby:android', bay, recruit });
  }

/**
 * 2026-09-15 (squads · dock matching): the terminal's 매칭 tab `비공개 매칭` / `공개 매칭`. `dockPending` is cleared
 * when a docked lobby arrives (`applyLobby`), on an error, or on leaving the lobby (`dropLobby`) — it is what lets
 * hub/ tell "the dock I pressed" from someone else's.
 */
export function requestDock(sys: NetSystem, isPublic: boolean): void {
  if (!sys.client.connected) {
    sys.ctx.bus.emit('net:error', { code: 'server', message: '서버에 연결되어 있지 않습니다.' });
    return;
  }
  sys.pendingQuickMatch = false;
  sys._dockPending = true;
  sys.client.send({ t: 'lobby:dock', isPublic });
  }

/* ══ 2026-09-09: host transfer by nomination ══════════════════════════════════════════════════════
 *
 * The server accepts two cases only — ① I am the host right now, ② it is a `claim` and the current host raised its
 * death flag with `lobby:hostDown` (the squad-leader device beside the corpse); anything else comes back as
 * `lobby:error {code:'not_host'}`. Here it is a no-op **only without a lobby** — the role has to be handed over
 * inside the ship as well (a lobby, no session).
 */
export function transferHost(sys: NetSystem, targetId: PeerId, claim?: boolean): void {
  if (!sys._lobby || !sys.client.connected) return;
  if (typeof targetId !== 'string' || targetId.length === 0) return;
  const msg: Extract<ClientToServer, { t: 'lobby:transferHost' }> = { t: 'lobby:transferHost', targetId };
  if (claim) msg.claim = true;
  sys.client.send(msg);
  }

/** The host tells the server it died fully in this raid (or came back) — the squad-leader device's precondition. */
export function reportHostDown(sys: NetSystem, down: boolean): void {
  if (!sys._lobby || !sys.client.connected) return;
  sys.client.send({ t: 'lobby:hostDown', down });
  }

export function setLobbySeed(sys: NetSystem, seed: number): void {
  const s = Math.floor(seed) >>> 0;
  if (sys._lobby) sys._lobby.seed = s; // optimistic mirror; the broadcast confirms it
  sys.client.send({ t: 'lobby:seed', seed: s });
  }

/**
 * Re-enter the running mission (raid after a resume, or join a running training from the terminal): tells the
 * server (`lobby:mission true`), starts the session with the lobby's mode and announces `flow rejoined` so the host
 * re-syncs us (extraction / pickups / containers / ghosts — our own body comes back with `ghost restore`).
 */
export function rejoinMission(sys: NetSystem): void {
  const lobby = sys._lobby;
  if (!lobby || !sys.missionInProgress || lobby.seed === null) return;
  const seed = lobby.seed;
  const mode: MissionMode = lobby.mode ?? 'raid';
  const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
  /* 2026-09-15 (title `레이드 포기`): an abandoned raid is never re-entered. The relay refuses it with `drifted`
   * too, but opening the session here first would leave us alone in an empty world — stop before sending. A training
   * has nothing to do with drifting (the mark is only ever raised on a raid). */
  if (mode === 'raid' && me?.drifted) {
    sys.ctx.bus.emit('net:error', { code: 'drifted', message: '레이드를 포기해 표류 처리되었습니다. 이 임무에는 다시 들어갈 수 없습니다.' });
    return;
  }
  sys.client.send({ t: 'lobby:mission', inMission: true });
  if (me) me.inMission = true; // optimistic; the broadcast confirms it
  // Phase 11: a rejoin takes the target planet from the lobby (the mission is already running on it).
  const planet = mode === 'training' ? null : (isPlanetId(lobby.planet) ? lobby.planet : null);
  /* 2026-09-14 (the intel broker): the fixed gimmicks are taken back from the lobby **exactly like the planet** —
   * otherwise the returning player alone builds a different map. */
  const intel = mode === 'training' ? null : sanitizeIntelWire(lobby.intel ?? null);
  sys.beginSession(seed, lobby, mode, true, planet, intel);
  sys.send({ t: 'flow', ev: 'rejoined' }, 'all');
  }

/** Leave the running mission but stay in the lobby (training exit, raid abort by a client). */
export function leaveMission(sys: NetSystem): void {
  const lobby = sys._lobby;
  const wasIn = sys._inSession;
  sys._inSession = false;
  sys.missionSeed = null;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.clearRemotes();
  sys.snapshotter.reset();
  sys.lastSnapshotAt = -Infinity;
  if (!lobby) return;
  const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
  if (me) me.inMission = false;
  if (sys.client.connected) sys.client.send({ t: 'lobby:mission', inMission: false });
  if (wasIn || me) sys.ctx.bus.emit('net:lobbyUpdated', { lobby });
  }

/**
 * 2026-09-15 (title `레이드 포기`): throws away the raid a reload left behind → `lobby:abandon`. Marks me `drifted`
 * at once, drops the blob and then emits `net:lobbyUpdated` (so the title that just closed the abandon popup never
 * redraws `이어하기` for even one tick). The relay's `lobby:state` confirms it. The corpse · the settlement are
 * finished by game/ **before** this is called (`game/parts/Resume`).
 */
export function abandonRaid(sys: NetSystem): void {
  const lobby = sys._lobby;
  if (!lobby || !lobby.started || (lobby.mode ?? 'raid') !== 'raid' || sys._inSession || !sys.client.connected) return;
  const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
  if (me) { me.drifted = true; me.inMission = false; }   // optimistic; the broadcast confirms it
  sys._raidBlob = null;
  sys.client.send({ t: 'lobby:abandon' });
  sys.ctx.bus.emit('net:lobbyUpdated', { lobby });
  }

/** Upload my mid-raid state (game/ calls it periodically and on loot). Only inside a raid session. */
export function saveRaid(sys: NetSystem, blob: RaidSessionBlob): void {
  if (!sys._inSession || sys.sessionMode !== 'raid' || !sys._lobby || !sys.client.connected) return;
  if (blob.seed !== sys.missionSeed) return;
  let text: string;
  try { text = JSON.stringify(blob); } catch { return; }
  if (text.length * 3 > RAID_BLOB_MAX_BYTES && new TextEncoder().encode(text).byteLength > RAID_BLOB_MAX_BYTES) {
    if (!sys.raidTooLargeWarned) { sys.raidTooLargeWarned = true; console.warn(`[net] raid blob exceeds ${RAID_BLOB_MAX_BYTES} bytes; not uploaded`); }
    return;
  }
  sys.client.send({ t: 'raid:save', blob });
  }

export function getInviteUrl(sys: NetSystem): string | null {
  if (!sys._lobby) return null;
  return `${location.origin}${location.pathname}?${NET_INVITE_PARAM}=${sys._lobby.code}`;
  }

export function getLobbyPlayer(sys: NetSystem, id: PeerId): LobbyPlayer | undefined {
  const lobby = sys._lobby;
  if (!lobby) return undefined;
  for (let i = 0; i < lobby.players.length; i++) if (lobby.players[i].id === id) return lobby.players[i];
  return undefined;
  }

/**
 * Enter the mission of `lobby` with `seed` (server `game:start`, or `rejoinMission()`).
 * Phase 11: `planet` is the raid's target planet (null for a training / an older relay with nothing picked).
 */
export function beginSession(
  sys: NetSystem, seed: number, lobby: LobbyState, mode: MissionMode, rejoin: boolean, planet: PlanetId | null,
  intel: IntelWire | null = null,
): void {
  const bus = sys.ctx.bus;
  sys.applyLobby(lobby);
  sys._inSession = true;
  sys.sessionMode = mode;
  sys.missionSeed = seed;
  sys._tookOver = false;
  sys.snapshotter.reset();
  sys.lastSnapshotAt = -Infinity;
  sys.clearRemotes(); // hub avatars are re-created from the first mission snapshots
  // Contract: whoever emits `game:newMission` sets `ctx.missionMode` **and** `ctx.missionPlanet` first — world/ and
  // core/ read them inside their synchronous handlers (the world generates during the emit).
  sys.ctx.missionMode = mode;
  sys.ctx.missionPlanet = mode === 'training' ? null : planet;
  /* 2026-09-14 (the intel broker): **exactly the contract of** `missionPlanet` — it has to be set **before**
   * `game:newMission` is emitted so world/ · enemies/ read it inside their synchronous handlers (the world
   * generates during the emit). A training is always null. */
  const iw = mode === 'training' ? null : sanitizeIntelWire(intel);
  sys.ctx.missionIntel = iw ? resolveIntelEffects(iw.picks) : null;
  const p = sys.ctx.missionPlanet;
  bus.emit('net:gameStarting', p !== null ? { seed, lobby, rejoin, mode, planet: p } : { seed, lobby, rejoin, mode });
  bus.emit('game:newMission', p !== null ? { seed, mode, planet: p } : { seed, mode });
  }

export function applyLobby(sys: NetSystem, next: LobbyState): void {
  const prev = sys._lobby;
  sys._lobby = next;
  const bus = sys.ctx.bus;
  if (prev && prev.code === next.code) {
    const me = sys.localId;
    for (const p of next.players) {
      if (p.id === me) continue;
      /* 2026-09-15: an android bot member is **not a person** — it makes no join / leave announcement and no
       * remote avatar. allies/ announces roster changes with `ally:rosterChanged` (`androidPlayersOf(lobby)`). */
      if (isBotPlayer(p)) continue;
      const was = prev.players.find((q) => q.id === p.id);
      if (!was) bus.emit('net:peerJoined', { id: p.id, name: p.name, slot: p.slot });
      else if (!was.connected && p.connected) sys.remotes.get(p.id)?.resetStream(); // came back → fresh seq
    }
    for (const q of prev.players) {
      if (q.id === me || isBotPlayer(q)) continue;
      if (!next.players.some((p) => p.id === q.id)) {
        bus.emit('net:peerLeft', { id: q.id, name: q.name });
        const r = sys.remotes.get(q.id);
        if (r && r.connected) { r.connected = false; r.removeAt = sys.ctx.time + PEER_LINGER; }
      }
    }
    if (prev.hostId !== next.hostId) sys.onHostChanged(prev.hostId, next.hostId);
  } else {
    sys.membership.clear();
    sys.prevHostId = null;
  }
  sys.syncRemoteIdentities();
  pushShipModel(sys);
  bus.emit('net:lobbyUpdated', { lobby: next });
  /*
   * 2026-09-15 (squads · dock matching): the dock I asked for arrived. Cleared **after** the emit on purpose — hub/
   * reads `dockPending` inside its `net:lobbyUpdated` handler to tell my own dock (fade → cutscene at once) from the
   * leader's dock reaching me (countdown first). Clearing it earlier made every dock look like somebody else's.
   */
  if (isDockedLobby(next)) sys._dockPending = false;
  }

/**
 * `lobby.hostId` changed while the lobby runs a mission. Inside the session this is a migration: promote / demote
 * systems, announce a takeover. Phase 9: the event goes out even when we are NOT in the session (hub member of a
 * running lobby — every system is a no-op outside a live mission), but `tookOver` / `flow takeover` stay session-only.
 */
export function onHostChanged(sys: NetSystem, prev: PeerId, next: PeerId): void {
  sys.prevHostId = prev;
  if (!sys._lobby || !sys._lobby.started) return;
  const isLocalHost = next === sys.localId;
  if (isLocalHost && sys._inSession) sys._tookOver = true;
  sys.ctx.bus.emit('net:hostChanged', { hostId: next, prev, isLocalHost });
  // After every local system promoted itself: tell the others so they re-request their syncs from us.
  if (isLocalHost && sys._inSession) sys.send({ t: 'flow', ev: 'takeover' }, 'others');
  }

export function playerInMission(sys: NetSystem, p: LobbyPlayer, lobby: LobbyState): boolean {
  return p.inMission ?? (lobby.started && p.connected);
  }

/** `moved` + `to` (2026-09-11, B-6): the server moved me straight into lobby `to`; its `lobby:state` follows at once. */
export function dropLobby(sys: NetSystem, reason: 'left' | 'disconnected' | 'kicked' | 'hostLeft' | 'moved', to?: string): void {
  const had = sys._lobby !== null;
  sys._lobby = null;
  sys._inSession = false;
  sys.missionSeed = null;
  sys.lobbySuspended = false;
  sys.pendingQuickMatch = false;
  // 2026-09-15: a dock request dies with the lobby — except `moved`: `공개 매칭` from alone in an undocked squad moves
  // me into an open public ship (`lobby:left {moved}` + its `lobby:state`), and that arrival is still **my** dock.
  if (reason !== 'moved') sys._dockPending = false;
  /* 2026-09-21 (B-101): a new lobby · a new relay has not been told my ship, so the nudge is due again. */
  sys._pushedShipModel = null;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.prevHostId = null;
  sys.membership.clear();
  sys.crewCards.clear();   // Phase 10: cards belong to the party we just left (hub/ re-sends ours on `hub:entered`)
  sys.shipVisits.clear();  // 2026-09-08: so do the ship layouts behind the hangar bays
  sys.charBuffRelay.clear(); // 2026-09-12: and the squad's buff lists (the next lobby's members answer `bfr` with `cbufq sync`)
  sys.carryActive = false;
  sys.clearRemotes();
  if (had) sys.ctx.bus.emit('net:lobbyLeft', reason === 'moved' && to ? { reason, to } : { reason });
  }

/** Deferred session end: runs after every synchronous handler of the triggering bus event has finished. */
export function scheduleEndSession(sys: NetSystem): void {
  if (!sys._inSession || sys.endSessionPending) return;
  sys.endSessionPending = true;
  queueMicrotask(() => {
    sys.endSessionPending = false;
    sys.endSession();
  });
  }

/**
 * Mission ended for us (complete / over / abort). Leaves the lobby intact — we return to the shared ship. Raid: the
 * host reopens the lobby (`lobby:reset`), a client that left alone reports `lobby:mission false` and sees
 * `missionInProgress` until the host resets. Training: everyone reports `lobby:mission false`; the server closes the
 * training once the last member left (never `lobby:reset`, other members may still be training).
 */
export function endSession(sys: NetSystem): void {
  if (!sys._inSession) return;
  sys._inSession = false;
  sys.missionSeed = null;
  const wasHost = sys.isHost;
  const mode = sys.sessionMode;
  sys._tookOver = false;
  sys._raidBlob = null;
  sys.clearRemotes();
  sys.profileSync.flush();
  if (sys.client.connected && sys._lobby) {
    if (mode === 'raid' && wasHost) sys.client.send({ t: 'lobby:reset' });
    else {
      const me = sys.localId ? sys.getLobbyPlayer(sys.localId) : undefined;
      if (me) me.inMission = false;
      sys.client.send({ t: 'lobby:mission', inMission: false });
    }
  }
  }

/**
 * 2026-09-21 (함선 구매 훅) — the nudge that says 「my ship changed, re-read it」 (`lobby:look.shipModel`).
 *
 * It runs off `lobby:state` because the model can change **while connected** (a purchase, a slot switch), and it is
 * de-duplicated against `NetSystem._pushedShipModel` — **not** against my own lobby row. That row is the relay's
 * answer, and since B-101 the relay fills it from my `progression` document: a profile that has uploaded none
 * leaves it empty for ever, so comparing against it sent a nudge on every state, which broadcast another state,
 * which nudged again. One value, one nudge. The accent travels on the connect URL instead (`?a=`) — that one cannot
 * change mid-session, so it needs no loop at all.
 *
 * **The value sent is not honoured.** The relay reads only its shape and then takes the id out of the profile store
 * (`Store.shipModel`); a purchase is not the client's word to give.
 */
export function pushShipModel(sys: NetSystem): void {
  if (!sys.localId || !sys.getLobbyPlayer(sys.localId) || !sys.client.connected) return;
  const mine = shipModelOf(sys.ctx.progression?.profile);
  if (sys._pushedShipModel === mine) return;
  sys._pushedShipModel = mine;
  sys.client.send({ t: 'lobby:look', shipModel: mine });
}
