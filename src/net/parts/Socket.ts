/**
 * src/net/parts/Socket.ts — **the connection · the session token · auto-reconnect**.
 *
 * A dropped socket reattaches on a backoff and, with the same token, the server keeps the slot for 5 minutes (until
 * the raid ends while one runs) → `net:reconnecting` → `net:resumed {seamless}`. The relay address is decided here.
 */
import type {
  ServerToClient,
} from '@/shared';
import type { RelayProbe } from '@/shared';
/* B-1 (2026-09-11): the link state · the background probe */
import type { GamePhase, NetLinkInfo, NetLinkState } from '@/shared';
import { NET_PROBE_BACKOFF_MS } from '@/shared';
import {
  NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_PARAM, NET_WS_PATH, RELAY_STORAGE_KEY, relayUrlFrom,
} from '@/shared';
import { MAX_LOBBYLESS_ATTEMPTS, RELAY_PROBE_TIMEOUT_MS } from '../model';
import type { NetSystem } from '../NetSystem';

/* ── Phase 8 ── */
/**
 * Relay wall clock in epoch ms: the offset captured at the last `welcome` / `pong` plus the elapsed local time.
 * `performance.now()` is monotonic, so moving the system clock cannot advance a crop timer. Phase 9: the last
 * offset is **kept through a disconnect** (profile stamps written offline stay on the server's clock); only a
 * session that never saw a welcome falls back to `Date.now()` (single-player keeps working on the local clock).
 */
export function serverNow(sys: NetSystem): number {
  const c = sys.client;
  if (c.connected && c.hasServerTime) sys.serverOffset = c.serverTimeOffset;
  if (sys.serverOffset === null) return Date.now();
  const t = performance.now() + sys.serverOffset;
  return Number.isFinite(t) ? t : Date.now();
  }

/* ── connection ─────────────────────────────────────────────────────── */
export function connect(sys: NetSystem, url?: string): Promise<void> {
  if (sys.client.connected) return Promise.resolve();
  sys.intentionalClose = false;
  sys.duplicateKicked = false;
  sys.serverRefused = null;   // C-29: no ban — an explicit connect may try again
  // An explicit connect while the backoff timer is pending: attempt right now instead.
  if (sys.reconnectTimer !== null) { clearTimeout(sys.reconnectTimer); sys.reconnectTimer = null; }
  // B-1: an explicit attempt ends the background probe (and a `refused`); the reconnect loop keeps its own state.
  if (sys._reconnecting) setLink(sys, 'reconnecting', { attempt: Math.max(1, sys.reconnectAttempt) });
  else if (sys._link.state !== 'connecting') setLink(sys, 'connecting', url ? { url } : {});
  const p = sys.client.connect(sys.withSession(url ?? sys.defaultUrl()));
  // Keep the reconnect loop alive if this manual attempt fails (attemptReconnect's own catch may already have rescheduled).
  if (sys._reconnecting) p.catch(() => { if (sys._reconnecting && sys.reconnectTimer === null) sys.scheduleReconnect(); });
  return p;
  }

export async function ensureConnected(sys: NetSystem): Promise<boolean> {
  if (sys.client.connected) return true;
  try { await sys.connect(); return true; } catch { return false; }
  }

export function disconnect(sys: NetSystem): void {
  sys.stopReconnect();
  sys.intentionalClose = true;
  sys.profileSync.flush();
  if (sys._lobby || sys._inSession) sys.dropLobby('left');
  sys.lastLocalId = null;
  sys.client.close();
  setLink(sys, 'idle');   // B-1: we chose to go offline — nothing to probe for
  }

/* ── the relay address (2026-09-10) ─────────────────────────────────
 * The order is the four steps written in `shared/net`'s `RELAY_STORAGE_KEY` comment, and the renderer knows exactly
 * one of them — **the address written in the settings**. The rest (the flag · `SCAV_RELAY` · `server.txt` ·
 * embedded) are picked by the desktop shell and hidden behind the same-origin `/ws`, so connecting to the same
 * origin is all that is needed here.
 */

/** The raw address written in the settings ('' with none / unreadable storage). A slot-shared key: no `slotKey`. */
export function relayOverride(): string {
  try { return localStorage.getItem(RELAY_STORAGE_KEY)?.trim() ?? ''; } catch { return ''; }
  }

/** Writes / clears the settings address. A malformed address stores nothing and returns false. */
export function setRelayOverride(sys: NetSystem, raw: string): boolean {
  const text = raw.trim();
  if (text && !relayUrlFrom(text)) return false;
  try {
    if (text) localStorage.setItem(RELAY_STORAGE_KEY, text);
    else localStorage.removeItem(RELAY_STORAGE_KEY);
  } catch { /* storage unavailable → valid for this page only */ }
  sys.ctx?.bus.emit('net:relayChanged', { url: defaultUrl(sys), custom: !!text });
  // B-1: still looking for a server → look for the new one, from the first backoff step.
  if (sys._link.state === 'unreachable') goUnreachable(sys);
  return true;
  }

export function defaultUrl(sys: NetSystem): string {
  const custom = relayUrlFrom(relayOverride());
  if (custom) return custom;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromEnv = env?.VITE_WS_URL;
  if (fromEnv) return fromEnv;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${NET_WS_PATH}`;
  }

/**
 * Knocks on one address **anonymously** (tokenless) and measures the time to `welcome`. With a token the server
 * reads it as a duplicate connection of the same session and cuts the live socket with `duplicate` — a connection
 * test must never kill the connection. `NetClient` is skipped for the same reason: this socket never enters the
 * state machine, it is opened and closed right here.
 */
export function probeRelay(sys: NetSystem, raw?: string): Promise<RelayProbe> {
  const url = relayUrlFrom(raw ?? relayOverride()) ?? (raw === undefined ? defaultUrl(sys) : null);
  if (!url) return Promise.resolve({ ok: false, url: '', ms: 0, error: '주소 형식이 아닙니다' });
  return new Promise<RelayProbe>((resolve) => {
    let ws: WebSocket;
    // `relayUrlFrom` already checked the format, so a throw here is in practice mixed content (https page + ws://).
    try { ws = new WebSocket(url); } catch { resolve({ ok: false, url, ms: 0, error: '이 주소를 열 수 없습니다 (https 페이지에서는 ws:// 를 쓸 수 없습니다)' }); return; }
    const t0 = performance.now();
    let done = false;
    const finish = (r: RelayProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, url, ms: 0, error: '응답이 없습니다 (방화벽 · 포트 확인)' }),
      RELAY_PROBE_TIMEOUT_MS);
    ws.onmessage = (ev) => {
      // The first frame is the `welcome` — all this confirms is that the relay talks.
      const ms = Math.max(1, Math.round(performance.now() - t0));
      let frame: { t?: unknown; message?: unknown } | null = null;
      try { frame = typeof ev.data === 'string' ? JSON.parse(ev.data) as { t?: unknown; message?: unknown } : null; } catch { frame = null; }
      if (frame?.t === 'welcome') { finish({ ok: true, url, ms }); return; }
      /*
       * 2026-09-11 (C-29): a `lobby:error` arriving instead of a welcome, followed at once by a close, means this
       * **is** a relay — one whose operator capped the player count (`server_full`). Reading it as
       * `릴레이가 아닙니다` would call a correct address wrong.
       */
      if (frame?.t === 'lobby:error') {
        const why = typeof frame.message === 'string' && frame.message ? frame.message : '서버가 접속을 거절했습니다';
        finish({ ok: false, url, ms, error: `서버는 찾았지만 들어갈 수 없습니다: ${why}` });
        return;
      }
      finish({ ok: false, url, ms, error: '릴레이가 아닙니다' });
    };
    ws.onerror = () => finish({ ok: false, url, ms: 0, error: '연결할 수 없습니다' });
    ws.onclose = () => finish({ ok: false, url, ms: 0, error: '연결이 거부되었습니다' });
  });
  }

/** Reattaches to the stored address. Any lobby is left (a different server does not have that lobby). */
export async function reconnectRelay(sys: NetSystem): Promise<boolean> {
  disconnect(sys);
  sys.intentionalClose = false;
  return ensureConnected(sys);
  }

/** Append `?t=<token>&n=<name>` (NET_TOKEN_PARAM / NET_NAME_PARAM) to a relay URL. */
export function withSession(sys: NetSystem, url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${NET_TOKEN_PARAM}=${encodeURIComponent(sys._sessionToken)}&${NET_NAME_PARAM}=${encodeURIComponent(sys._playerName)}`;
  }

/* ── reconnect ──────────────────────────────────────────────────────── */
/** Socket went offline/error. `wasConnected` = an established (welcomed) connection dropped, not a failed attempt. */
export function onSocketDown(sys: NetSystem, wasConnected: boolean): void {
  if (sys.intentionalClose) return;
  // B-1: every `refused` link is set **before** `dropLobby`, so `net:lobbyLeft` listeners (game/Wire's toast) can read why.
  if (sys.duplicateKicked) {
    // Another tab took over this session: hand the lobby over to it and stay offline.
    sys.stopReconnect();
    setLink(sys, 'refused', { refused: 'duplicate' });
    if (sys._lobby || sys._inSession) sys.dropLobby('kicked');
    return;
  }
  if (sys.serverRefused) {
    // C-29: the relay closed us on purpose (`kicked` by its operator / `server_full`). Retrying would only hammer it
    // (a kick) or be refused again (a full server) — stay offline; `net:error` already carried the Korean reason.
    sys.stopReconnect();
    setLink(sys, 'refused', { refused: sys.serverRefused });
    if (sys._lobby || sys._inSession) sys.dropLobby(sys.serverRefused === 'kicked' ? 'kicked' : 'disconnected');
    return;
  }
  if (sys._reconnecting) return;          // a retry failed; attemptReconnect() schedules the next one
  // An initial connect() failed (refused port, timeout, bad address): the caller still decides what to do with the
  // offline ship, but the link goes `unreachable` and the anonymous background probe starts looking (B-1).
  if (!wasConnected) { goUnreachable(sys); return; }
  sys.beginReconnect();
  }

export function beginReconnect(sys: NetSystem): void {
  sys._reconnecting = true;
  sys.reconnectAttempt = 0;
  sys.reconnectStartedAt = performance.now();
  sys.lobbySuspended = sys._lobby !== null;
  sys.wasInSessionAtDrop = sys._inSession;
  // Remotes stay (seamless resume keeps them; they go `stale` meanwhile and refresh with the next snapshots).
  sys.scheduleReconnect();
  }

export function scheduleReconnect(sys: NetSystem): void {
  if (!sys._reconnecting) return;
  const attempt = ++sys.reconnectAttempt;
  const elapsed = performance.now() - sys.reconnectStartedAt;
  if (sys.lobbySuspended && elapsed >= NET_MISSION_RESUME_TIMEOUT_MS) {
    // Waited long enough for the party: give the lobby up locally. If the server still has our slot when we do
    // get back, `welcome.lobby` re-enters it via `net:resumed` (fresh-load semantics).
    sys.lobbySuspended = false;
    sys.dropLobby('disconnected');
  }
  if (!sys.lobbySuspended && attempt > MAX_LOBBYLESS_ATTEMPTS) {
    sys.stopReconnect();
    // B-1: no longer a silent give-up — the tokened loop hands over to the anonymous background probe.
    goUnreachable(sys);
    return;
  }
  const delay = NET_RECONNECT_BACKOFF_MS[Math.min(attempt - 1, NET_RECONNECT_BACKOFF_MS.length - 1)];
  setLink(sys, 'reconnecting', { attempt });
  sys.ctx.bus.emit('net:reconnecting', { attempt, nextInMs: delay });
  sys.reconnectTimer = setTimeout(() => { sys.reconnectTimer = null; void sys.attemptReconnect(); }, delay);
  }

export async function attemptReconnect(sys: NetSystem): Promise<void> {
  if (!sys._reconnecting) return;
  try {
    await sys.client.connect(sys.withSession(sys.defaultUrl()));
    // Success path continues in handleServerMessage('welcome').
  } catch {
    if (sys._reconnecting) sys.scheduleReconnect();
  }
  }

export function stopReconnect(sys: NetSystem): void {
  if (sys.reconnectTimer !== null) { clearTimeout(sys.reconnectTimer); sys.reconnectTimer = null; }
  sys._reconnecting = false;
  sys.reconnectAttempt = 0;
  }

/** `welcome` arrived (first connect, reconnect or fresh page load). */
export function onWelcome(sys: NetSystem, msg: Extract<ServerToClient, { t: 'welcome' }>): void {
  const bus = sys.ctx.bus;
  const resumedAfterDrop = sys._reconnecting;
  sys.stopReconnect();
  // B-1: first, so every `net:resumed` / `net:profileLoaded` listener below already reads `link.state === 'connected'`.
  setLink(sys, 'connected');
  sys.lastLocalId = msg.id;
  if (sys.client.hasServerTime) sys.serverOffset = sys.client.serverTimeOffset;
  const lobby = msg.lobby ?? null;

  // Seamless: we were inside the mission this lobby is still running → keep inSession + remotes, nothing rebuilt.
  const seamless = lobby !== null && resumedAfterDrop && sys.wasInSessionAtDrop && sys._inSession
    && lobby.started && sys.missionSeed !== null && lobby.seed === sys.missionSeed;

  // Profile first: persisting folders replace their local state from it before any lobby / mission event. During a
  // seamless resume the documents cannot have changed (only this client writes them) — refresh availability only.
  sys.profileSync.onWelcome(msg.profile, !seamless);
  // Phase 11: the social snapshot belongs to the connection, not the session — refresh it on every welcome, then
  // (re-)publish my level, which the relay forgets when nothing reported it yet.
  sys.socialSync.onWelcome(msg.social);
  sys.pushLevel();

  if (lobby) {
    if (!seamless) {
      sys._inSession = false;
      sys._tookOver = false;
      sys.clearRemotes();
      sys.snapshotter.reset();
      sys._raidBlob = msg.raid ?? null;
    } else {
      // Peers may have restarted their snapshot streams while we were away.
      for (const r of sys.remoteList) r.resetStream();
    }
    sys.lobbySuspended = false;
    sys.applyLobby(lobby);
    sys.lastSnapshotAt = -Infinity;
    // Phase 9: coming back into a running mission WITHOUT our session state (page reload, or a drop we gave up on)
    // means we left it — tell the server so the host parks our ghost and the authority never waits on us. A pod /
    // the terminal re-enters with `rejoinMission()` (which flips `inMission` back).
    if (lobby.started && !seamless && !sys._inSession) {
      const me = sys.getLobbyPlayer(msg.id);
      if (me && me.inMission) {
        me.inMission = false; // optimistic mirror; the broadcast confirms it
        // 2026-09-15 (title `이어하기`): `keep` — a reload did not end the raid. The relay has to keep the blob so
        // a second reload still lets the title resume or abandon it (the voluntary return · extraction send no
        // `keep` — `leaveMission` · `endSession`).
        sys.client.send({ t: 'lobby:mission', inMission: false, keep: true });
      }
    }
    bus.emit('net:resumed', { lobby, inProgress: lobby.started && !sys._inSession, seamless });
    if (!seamless && sys._raidBlob) bus.emit('net:raidLoaded', { blob: sys._raidBlob });
    // Back inside the running mission: the host may hold our body as a ghost — ask for it back (`ghost restore`)
    // and let every system re-sync us. A host that kept its role through the blip has nothing to ask for.
    if (seamless && !sys.isHost) sys.send({ t: 'flow', ev: 'rejoined' }, 'all');
  } else if (sys._lobby || sys._inSession) {
    // We kept a suspended lobby but the server no longer knows us (grace expired / server restarted).
    sys.lobbySuspended = false;
    sys.dropLobby('disconnected');
  }
  sys.wasInSessionAtDrop = false;
  }

/* ══ B-1 (2026-09-11): the link state · the background probe ════
 *
 * `ctx.net.link` is a one-line answer to "what terms is the client on with the server right now". Transitions
 * happen **only through this file's `setLink`**, and every change emits `net:linkChanged {link, prev}`
 * (`ui/hud/NetBadge` is what draws it).
 *
 *   idle ──connect()──▶ connecting ──welcome──▶ connected ──drop──▶ reconnecting ──(no lobby, 6 tries)──┐
 *                          │ fail / NET_CONNECT_TIMEOUT_MS                                              │
 *                          ▼                                                                            ▼
 *                     unreachable ◀─────────────────────────────────────────────────────────────────────┘
 *                          │ anonymous probeRelay on NET_PROBE_BACKOFF_MS (tokenless — same token = duplicate)
 *                          ▼ found
 *              ship · title → ensureConnected() · raid · training → `found: true` only (connects back in the ship)
 *
 *   refused {kicked | server_full | duplicate} — no probe, no auto-reconnect; an explicit connect() clears it.
 *
 * 2026-09-15: the desktop shell's same-origin `/ws` is **always probed too.** It used to be skipped while the shell
 * pointed it at an embedded relay (the first `/ws` started that relay, C-28), but the build ships no server any more
 * (the user's decision), so the shell is only a pipe — with no address at all it goes to this PC's start-server.bat
 * server, and that server coming up later has to be found. `NetLinkInfo.embedded` stays as part of the contract, but
 * nothing here ever sets it.
 */

/** The live `NetRef.link`: the stored state plus the remaining wait of a pending probe. */
export function linkInfo(sys: NetSystem): NetLinkInfo {
  const l = sys._link;
  const out: NetLinkInfo = { ...l, url: l.url || defaultUrl(sys) };
  if (l.state === 'unreachable') {
    out.nextProbeInMs = sys.probeTimer !== null ? Math.max(0, Math.round(sys.probeDueAt - performance.now())) : null;
  }
  return out;
  }

/** The one place the link changes. Leaving `unreachable` stops the probe (a stale probe result is ignored by generation). */
export function setLink(sys: NetSystem, state: NetLinkState, extra: Partial<Omit<NetLinkInfo, 'state'>> = {}): void {
  if (state !== 'unreachable') stopProbe(sys);
  const prev = sys._link.state;
  sys._link = { url: defaultUrl(sys), ...extra, state };
  sys.ctx?.bus.emit('net:linkChanged', { link: linkInfo(sys), prev });
  }

export function stopProbe(sys: NetSystem): void {
  if (sys.probeTimer !== null) { clearTimeout(sys.probeTimer); sys.probeTimer = null; }
  sys.probeGen++;
  }

/**
 * An attempt failed (or the tokened reconnect loop gave up): report `unreachable` and start looking from the first
 * backoff step. Every target is probed — the desktop shell included (2026-09-15: it no longer embeds a relay).
 */
export function goUnreachable(sys: NetSystem): void {
  stopProbe(sys);
  sys.probeAttempt = 0;
  scheduleProbe(sys);
  }

function scheduleProbe(sys: NetSystem): void {
  if (sys.probeTimer !== null) { clearTimeout(sys.probeTimer); sys.probeTimer = null; }
  const delay = NET_PROBE_BACKOFF_MS[Math.min(sys.probeAttempt, NET_PROBE_BACKOFF_MS.length - 1)];
  const gen = sys.probeGen;
  sys.probeDueAt = performance.now() + delay;
  sys.probeTimer = setTimeout(() => { sys.probeTimer = null; void runProbe(sys, gen); }, delay);
  setLink(sys, 'unreachable', { nextProbeInMs: delay });
  }

async function runProbe(sys: NetSystem, gen: number): Promise<void> {
  if (gen !== sys.probeGen || sys._link.state !== 'unreachable') return;
  // Anonymous on purpose (see `probeRelay`): a probe must never collide with this session's own token.
  const r = await probeRelay(sys);
  if (gen !== sys.probeGen || sys._link.state !== 'unreachable') return;
  sys.probeAttempt++;
  if (!r.ok) { scheduleProbe(sys); return; }
  if (shipOrTitle(sys.ctx?.phase)) { void ensureConnected(sys); return; }
  // In a raid / training: a mid-mission `welcome` would make every persisting folder swap its state out from under the
  // mission (`net:profileLoaded`). Remember that a server is there; `onPhaseChanged` connects back in the ship / title.
  setLink(sys, 'unreachable', { found: true, nextProbeInMs: null });
  }

/** `game:phaseChanged`: the server found during a mission is joined as soon as we are in the ship or on the title. */
export function onPhaseChanged(sys: NetSystem, phase: GamePhase): void {
  if (sys._link.state !== 'unreachable' || !sys._link.found || !shipOrTitle(phase)) return;
  void ensureConnected(sys);
  }

function shipOrTitle(phase: GamePhase | undefined): boolean { return phase === 'hub' || phase === 'menu'; }
