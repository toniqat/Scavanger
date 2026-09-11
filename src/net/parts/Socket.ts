/**
 * src/net/parts/Socket.ts — **연결 · 세션 토큰 · 자동 재접속**.
 *
 * 소켓이 끊기면 백오프로 다시 붙고, 같은 토큰이면 서버가 슬롯을 5분(레이드 중이면 레이드가 끝날 때까지)
 * 지켜 준다 → `net:reconnecting` → `net:resumed {seamless}`. 릴레이 주소 결정도 여기다.
 */
import * as THREE from 'three';
import type {
  ChatKind, GameContext, GameSystem, GameMessage, GameMessageOf, GameMessageType, GhostWire, LobbyPlayer, LobbyState,
  NetRef, NetStatus, PeerId, PingKind, RelayTarget, RemotePlayerRef, ServerToClient, Vec3Tuple,
} from '@/shared';
import type { ClientToServer, MissionMode, ProfileRef, RaidSessionBlob } from '@/shared';
import type { PlanetId, RelayProbe, SocialRef } from '@/shared';
import { isPlanetId } from '@/shared';
/* B-1 (2026-09-11): 링크 상태 · 배경 프로브 */
import type { GamePhase, NetLinkInfo, NetLinkState } from '@/shared';
import { NET_PROBE_BACKOFF_MS, NET_SHELL_RELAY_ROUTE, isDesktopShell } from '@/shared';
import {
  NET_INVITE_PARAM, NET_MISSION_RESUME_TIMEOUT_MS, NET_NAME_PARAM, NET_PLAYER_SNAPSHOT_HZ, NET_RECONNECT_BACKOFF_MS,
  NET_TOKEN_LENGTH, NET_TOKEN_PARAM, NET_TOKEN_STORAGE_KEY, NET_WS_PATH, PlayerFlags, RAID_BLOB_MAX_BYTES,
  RELAY_STORAGE_KEY, isValidLobbyCode, normalizeLobbyCode, relayUrlFrom, sanitizePlayerName,
} from '@/shared';
import { NetClient } from '../NetClient';
import { ProfileSync } from '../ProfileSync';
import { SocialSync } from '../SocialSync';
import { RemotePlayer } from '../RemotePlayer';
import { Snapshotter } from '../Snapshotter';
import type { CrewCardWire, ImplantId } from '@/shared';
import { IMPLANT_IDS } from '@/shared';
import { CHAT_KINDS, type Handler, IMPLANT_ID_SET, MAX_LOBBYLESS_ATTEMPTS, NAME_STORAGE_KEY, RELAY_PROBE_TIMEOUT_MS, PEER_LINGER, PING_KINDS, SNAPSHOT_INTERVAL, TOKEN_ALPHABET, TOKEN_RE, defIdOrNull, isGhostWire, isNum, isVec3, loadOrCreateSessionToken, sameCard, sanitizeCrewCard, vec } from '../model';
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

/* ── 릴레이 주소 (2026-09-10) ────────────────────────────────────────────
 * 우선순위는 `shared/net` 의 `RELAY_STORAGE_KEY` 주석에 적힌 네 단계이고, 렌더러가 아는 것은 그중 하나뿐이다
 * — **설정에 적어 둔 주소**. 나머지(플래그 · `SCAV_RELAY` · `server.txt` · 임베디드)는 데스크톱 셸이 골라
 * 같은 오리진 `/ws` 뒤에 숨겨 두므로 여기서는 그냥 같은 오리진으로 붙으면 된다.
 */

/** 설정에 적어 둔 주소 원문 (없거나 저장소를 못 읽으면 빈 문자열). 슬롯 공용 키라 `slotKey` 를 타지 않는다. */
export function relayOverride(): string {
  try { return localStorage.getItem(RELAY_STORAGE_KEY)?.trim() ?? ''; } catch { return ''; }
  }

/** 설정의 주소를 쓴다/지운다. 형식이 아니면 아무것도 저장하지 않고 false. */
export function setRelayOverride(sys: NetSystem, raw: string): boolean {
  const text = raw.trim();
  if (text && !relayUrlFrom(text)) return false;
  try {
    if (text) localStorage.setItem(RELAY_STORAGE_KEY, text);
    else localStorage.removeItem(RELAY_STORAGE_KEY);
  } catch { /* storage unavailable → 이 페이지 동안만 유효 */ }
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
 * 주소 하나를 **익명으로**(토큰 없이) 두드려 `welcome` 까지의 시간을 잰다. 토큰을 붙이면 서버가 같은 세션의
 * 중복 접속으로 보고 살아 있는 내 소켓을 `duplicate` 로 끊어 버린다 — 연결 테스트가 연결을 죽이면 안 된다.
 * `NetClient` 를 쓰지 않는 이유도 같다: 이 소켓은 상태 기계에 들어가지 않고 여기서 열고 여기서 닫는다.
 */
export function probeRelay(sys: NetSystem, raw?: string): Promise<RelayProbe> {
  const url = relayUrlFrom(raw ?? relayOverride()) ?? (raw === undefined ? defaultUrl(sys) : null);
  if (!url) return Promise.resolve({ ok: false, url: '', ms: 0, error: '주소 형식이 아닙니다' });
  return new Promise<RelayProbe>((resolve) => {
    let ws: WebSocket;
    // 형식은 이미 `relayUrlFrom` 이 봤으므로, 여기서 던지는 것은 사실상 혼합 콘텐츠(https 페이지 + ws://)다.
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
      // 첫 프레임이 곧 `welcome` 이다 — 릴레이가 말을 한다는 것만 확인한다.
      const ms = Math.max(1, Math.round(performance.now() - t0));
      let frame: { t?: unknown; message?: unknown } | null = null;
      try { frame = typeof ev.data === 'string' ? JSON.parse(ev.data) as { t?: unknown; message?: unknown } : null; } catch { frame = null; }
      if (frame?.t === 'welcome') { finish({ ok: true, url, ms }); return; }
      /*
       * 2026-09-11 (C-29): welcome 대신 `lobby:error` 가 먼저 오고 곧바로 끊기는 것은 **릴레이가 맞다** — 운영자가
       * 인원 제한(`server_full`)을 걸어 둔 서버다. "릴레이가 아닙니다" 로 읽으면 맞는 주소를 틀렸다고 말하게 된다.
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

/** 저장된 주소로 다시 붙는다. 로비에 있었다면 떠난다 (서버가 바뀌면 그 로비는 존재하지 않는다). */
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
        sys.client.send({ t: 'lobby:mission', inMission: false });
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

/* ══ B-1 (2026-09-11): 링크 상태 · 배경 프로브 ═══════════════════════════
 *
 * `ctx.net.link` 는 "지금 서버와 어떤 사이인가" 한 줄이다. 전이는 **이 파일의 `setLink` 로만** 일어나고
 * 바뀔 때마다 `net:linkChanged {link, prev}` 가 나간다 (그리는 쪽은 `ui/hud/NetBadge`).
 *
 *   idle ──connect()──▶ connecting ──welcome──▶ connected ──drop──▶ reconnecting ──(로비 없이 6회)──┐
 *                          │ fail / NET_CONNECT_TIMEOUT_MS                                          │
 *                          ▼                                                                         ▼
 *                     unreachable ◀──────────────────────────────────────────────────────────────────┘
 *                          │ 익명 probeRelay 를 NET_PROBE_BACKOFF_MS 로 (토큰 없이 — 같은 토큰은 duplicate 로 끊긴다)
 *                          ▼ 찾음
 *              함선 · 타이틀 → ensureConnected() · 레이드 · 훈련 → `found: true` 만 (함선으로 돌아오면 접속)
 *
 *   refused {kicked | server_full | duplicate} — 프로브도 자동 재접속도 없다. 명시적인 connect() 만 지운다.
 *
 * 데스크톱 셸이 같은 오리진 `/ws` 를 **임베디드 릴레이**로 보내고 있으면(`NET_SHELL_RELAY_ROUTE` 의 source) 프로브하지
 * 않는다 — 첫 `/ws` 가 그 릴레이를 켜므로(C-28) 두드리는 것 자체가 지연 시작을 무의미하게 만든다 (`embedded: true`).
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
 * backoff step — unless the target is the desktop shell's embedded relay, which is never probed.
 */
export function goUnreachable(sys: NetSystem): void {
  stopProbe(sys);
  sys.probeAttempt = 0;
  const url = defaultUrl(sys);
  if (!sameOriginTarget() || !isDesktopShell()) { scheduleProbe(sys); return; }
  const cached = sys.embeddedCache?.url === url ? sys.embeddedCache.embedded : null;
  if (cached === true) { setLink(sys, 'unreachable', { embedded: true, nextProbeInMs: null }); return; }
  if (cached === false) { scheduleProbe(sys); return; }
  // Unknown yet: say `unreachable` now (not probing), ask the shell once, then decide.
  setLink(sys, 'unreachable', { nextProbeInMs: null });
  const gen = sys.probeGen;
  void shellSaysEmbedded().then((embedded) => {
    sys.embeddedCache = { url, embedded };
    if (gen !== sys.probeGen || sys._link.state !== 'unreachable') return;
    if (embedded) setLink(sys, 'unreachable', { embedded: true, nextProbeInMs: null });
    else scheduleProbe(sys);
  });
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

/** `defaultUrl` falls through to the page's own origin (no settings override, no `VITE_WS_URL`). */
function sameOriginTarget(): boolean {
  if (relayUrlFrom(relayOverride())) return false;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return !env?.VITE_WS_URL;
  }

/**
 * Ask the desktop shell where its `/ws` goes. `embedded` (appended to the route by the shell, if ever) wins; otherwise
 * the embedded relay is recognised by its source label (`이 PC 의 내장 서버` / `… (필요할 때 켜짐)`). No route, not JSON
 * (vite answers index.html) or any failure = not embedded → the ordinary probe runs.
 */
async function shellSaysEmbedded(): Promise<boolean> {
  try {
    const res = await fetch(NET_SHELL_RELAY_ROUTE, { cache: 'no-store' });
    if (!res.ok) return false;
    const j = await res.json() as { embedded?: unknown; source?: unknown };
    if (typeof j.embedded === 'boolean') return j.embedded;
    return typeof j.source === 'string' && j.source.includes('내장 서버');
  } catch { return false; }
  }
