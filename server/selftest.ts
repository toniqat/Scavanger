/**
 * Relay server self-test: `node server/selftest.ts` (or `npm run net:selftest`).
 * Boots the server on a random port (with a 300 ms reconnect grace), drives WebSocket clients (Node 24 global
 * WebSocket) through the lobby / relay / disconnect / reconnect / quick-match flows and exits 0 on success,
 * 1 on the first failed assertion.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientToServer, ServerToClient, LobbyState } from '../src/shared/net.ts';
import type { RaidSessionBlob } from '../src/shared/profile.ts';
import { NET_WS_PATH, NET_TOKEN_PARAM, NET_NAME_PARAM, NET_TOKEN_LENGTH } from '../src/shared/net.ts';
import { PROFILE_CLOCK_SKEW_MS, PROFILE_DOC_MAX_BYTES, PROFILE_GC_INACTIVE_MS, RAID_BLOB_MAX_BYTES } from '../src/shared/profile.ts';
/* Phase 11 */
import type { PlanetId } from '../src/shared/planets.ts';
import type { PlayerCode } from '../src/shared/social.ts';
import {
  SOCIAL_ERROR_MESSAGE_KO, SOCIAL_FRIEND_MAX, SOCIAL_RECENT_MAX, SOCIAL_RECENT_TTL_MS, SOCIAL_REQUEST_TTL_MS,
  SOCIAL_WHISPER_MAX, isValidPlayerCode, playerCodeFrom,
} from '../src/shared/social.ts';
/* 2026-09-11 (B-3 · B-4 · B-5 · B-6) — part 8c */
import { SOCIAL_BLOCK_MAX, SOCIAL_PUSH_COALESCE_MS, SOCIAL_WHISPER_INBOX_MAX, SOCIAL_WHISPER_INBOX_TTL_MS, SQUAD_INVITE_MAX } from '../src/shared/social.ts';
import { Lobby, LobbyManager } from './Lobby.ts';
import { startRelayServer, peerIdFromToken, PEER_ID_LENGTH } from './RelayServer.ts';
import { ProfileStore, PROFILE_BACKUP_SUFFIX, PROFILE_FILE, SOCIAL_LEVEL_MAX } from './Store.ts';
/* 2026-09-11 (E-4 ⑦) — part 12: 서버 크레딧 검증 */
import type { CreditLedger, CreditReason } from '../src/shared/credits.ts';
import {
  CREDIT_CONTRACT_MAX_PER_HOUR, CREDIT_REFUND_WINDOW_MS, CREDIT_TX_INVALID_KO, economyTableDigest, formatCreditReason,
  parseCreditReason, tableMinBuyPrice, tableSellPrice,
} from '../src/shared/credits.ts';
import {
  CREDIT_CONTRACT_WINDOW_MS, CREDIT_LEDGER_DEBITS_MAX, CreditEconomy, ECONOMY_TABLE, devEconomyFromEnv, emptyLedger, sanitizeLedger,
} from './Economy.ts';

const GRACE_MS = 300;
const results: string[] = [];
let failures = 0;
function pass(name: string): void { results.push(`  ok   ${name}`); }
function fail(name: string, detail?: unknown): void {
  failures++;
  results.push(`  FAIL ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function assert(cond: boolean, name: string, detail?: unknown): void { cond ? pass(name) : fail(name, detail); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/**
 * Poll `cond` until it holds (or `timeoutMs` runs out). 2026-09-11 (C-68): a fixed sleep around an **async disk write**
 * is a load-sensitive assertion — part 7's `debounced write happened once` went red whenever the machine was busy
 * (seven agents verifying in the same tree). Wait for the write to land, then give it a moment to prove it was the only one.
 */
async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!cond() && Date.now() < until) await sleep(stepMs);
  return cond();
}

class TestClient {
  readonly ws: WebSocket;
  readonly label: string;
  id = '';
  lobby: LobbyState | null = null;
  closeCode = 0;
  private queue: ServerToClient[] = [];
  private waiters: Array<{ pred: (m: ServerToClient) => boolean; resolve: (m: ServerToClient) => void }> = [];

  constructor(label: string, url: string, query?: { token?: string; name?: string }) {
    this.label = label;
    let full = url;
    if (query) {
      const q = new URLSearchParams();
      if (query.token !== undefined) q.set(NET_TOKEN_PARAM, query.token);
      if (query.name !== undefined) q.set(NET_NAME_PARAM, query.name);
      full = `${url}?${q.toString()}`;
    }
    this.ws = new WebSocket(full);
    this.ws.addEventListener('close', (ev) => { this.closeCode = ev.code; });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerToClient;
      if (msg.t === 'lobby:state' || msg.t === 'peer:left') this.lobby = msg.lobby;
      if (msg.t === 'game:start') this.lobby = msg.lobby;
      if (msg.t === 'welcome' && msg.lobby) this.lobby = msg.lobby;
      if (msg.t === 'lobby:left') this.lobby = null;
      const idx = this.waiters.findIndex((w) => w.pred(msg));
      if (idx >= 0) { const [w] = this.waiters.splice(idx, 1); w.resolve(msg); }
      else this.queue.push(msg);
    });
  }

  send(m: ClientToServer): void { this.ws.send(JSON.stringify(m)); }
  sendRaw(text: string): void { this.ws.send(text); }

  /** Next message matching `pred` (already-queued first), with timeout. */
  wait<T extends ServerToClient['t']>(t: T, extra?: (m: Extract<ServerToClient, { t: T }>) => boolean, timeoutMs = 3000): Promise<Extract<ServerToClient, { t: T }>> {
    const pred = (m: ServerToClient): boolean => m.t === t && (!extra || extra(m as Extract<ServerToClient, { t: T }>));
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0] as Extract<ServerToClient, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`${this.label}: timeout waiting for ${t}; queued=${this.queue.map((m) => m.t).join(',') || '(none)'}`));
      }, timeoutMs);
      const wrapped = (m: ServerToClient): void => { clearTimeout(timer); resolve(m as Extract<ServerToClient, { t: T }>); };
      this.waiters.push({ pred, resolve: wrapped });
    });
  }

  /** Resolves true if no message of type `t` (matching `extra`) arrives within `ms` (for negative checks). */
  async expectNone(t: ServerToClient['t'], ms = 300, extra?: (m: ServerToClient) => boolean): Promise<boolean> {
    try { await this.wait(t, extra as never, ms); return false; } catch { return true; }
  }

  /** Drop every queued message (between test sections). */
  flush(): void { this.queue.length = 0; }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error(`${this.label}: connect failed`)), { once: true });
    });
  }
  closed(timeoutMs = 2000): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: not closed`)), timeoutMs);
      this.ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  close(): void { this.ws.close(); }
}

/** Connect + consume welcome. */
async function connect(label: string, url: string, query?: { token?: string; name?: string }): Promise<{ c: TestClient; welcome: Extract<ServerToClient, { t: 'welcome' }> }> {
  const c = new TestClient(label, url, query);
  await c.open();
  const welcome = await c.wait('welcome');
  c.id = welcome.id;
  return { c, welcome };
}

function makeToken(seedChar: string): string {
  return seedChar.repeat(NET_TOKEN_LENGTH).slice(0, NET_TOKEN_LENGTH);
}

/**
 * Phase 11: a raid start needs a 목표 행성 (`no_planet` otherwise), so every existing raid in this file picks one
 * first. `watchers` are the other connected members that must see the broadcast (so no stale `lobby:state` is left
 * queued for a later `expectNone`).
 */
async function pickPlanet(host: TestClient, planet: PlanetId, watchers: TestClient[] = []): Promise<void> {
  host.send({ t: 'lobby:planet', planet });
  await Promise.all([host, ...watchers].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.planet === planet)));
}

async function main(): Promise<void> {
  const server = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: GRACE_MS, dataDir: null });
  const url = `ws://127.0.0.1:${server.port}${NET_WS_PATH}`;
  console.log(`selftest: server on ${url}`);

  try {
    /* ══════════════════════════ part 1: original lobby / relay flow ══════════════════════════ */
    /* health endpoint */
    const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { ok: boolean; lobbies: number; clients: number };
    assert(health.ok === true && health.lobbies === 0 && health.clients === 0, 'GET /health ok with zero lobbies/clients', health);

    /* connect 3 clients (anonymous → random ids) */
    const a = new TestClient('A', url), b = new TestClient('B', url), c = new TestClient('C', url);
    await Promise.all([a.open(), b.open(), c.open()]);
    for (const cl of [a, b, c]) {
      const w = await cl.wait('welcome');
      cl.id = w.id;
      assert(typeof w.id === 'string' && w.id.length >= 6 && typeof w.serverTime === 'number' && w.lobby === undefined, `${cl.label} received welcome (no lobby)`, w);
    }
    assert(new Set([a.id, b.id, c.id]).size === 3, 'peer ids are unique');

    /* ping/pong */
    a.send({ t: 'ping', ts: 4242 });
    const pong = await a.wait('pong');
    assert(pong.ts === 4242 && typeof pong.serverTime === 'number', 'ping → pong echoes ts');

    /* bad input never crashes */
    a.sendRaw('this is not json');
    let err = await a.wait('lobby:error');
    assert(err.code === 'invalid', 'garbage frame → lobby:error invalid');
    a.sendRaw(JSON.stringify({ t: 'lobby:join', code: 12345, name: 'x' }));
    err = await a.wait('lobby:error');
    assert(err.code === 'invalid', 'wrong field types → lobby:error invalid');
    a.sendRaw(JSON.stringify({ t: 'lobby:seed', seed: 'seven' }));
    err = await a.wait('lobby:error');
    assert(err.code === 'invalid', 'lobby:seed with a string → invalid');
    a.sendRaw(JSON.stringify({ t: 'lobby:setPublic', isPublic: 1 }));
    err = await a.wait('lobby:error');
    assert(err.code === 'invalid', 'lobby:setPublic with a number → invalid');
    a.send({ t: 'relay', to: 'all', d: { t: 'chat', text: 'hi' } });
    err = await a.wait('lobby:error');
    assert(err.code === 'not_in_lobby', 'relay outside a lobby → not_in_lobby');

    /* create */
    a.send({ t: 'lobby:create', name: '  Alpha<script>  ' });
    let st = await a.wait('lobby:state');
    const code = st.lobby.code;
    assert(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code), 'lobby code is 6 chars from the alphabet', code);
    assert(st.lobby.hostId === a.id && st.lobby.players.length === 1 && st.lobby.players[0].slot === 0
      && st.lobby.players[0].isHost && !st.lobby.players[0].ready && !st.lobby.started && st.lobby.seed === null,
      'creator is host at slot 0, not ready, not started', st.lobby);
    assert(st.lobby.isPublic === false && st.lobby.players[0].connected === true, 'lobby:create → private lobby, member connected=true', st.lobby);
    assert(st.lobby.players[0].name === 'Alphascript', 'player name sanitized (markup stripped, trimmed)', st.lobby.players[0].name);
    a.send({ t: 'lobby:create', name: 'again' });
    err = await a.wait('lobby:error');
    assert(err.code === 'in_lobby', 'creating while in a lobby → in_lobby');

    /* invalid / unknown code */
    b.send({ t: 'lobby:join', code: 'ABC', name: 'Bravo' });
    err = await b.wait('lobby:error');
    assert(err.code === 'invalid' && /로비 코드/.test(err.message), 'join with malformed code → invalid (Korean message)', err);
    const wrong = code[0] === 'A' ? 'B' + code.slice(1) : 'A' + code.slice(1);
    b.send({ t: 'lobby:join', code: wrong, name: 'Bravo' });
    err = await b.wait('lobby:error');
    assert(err.code === 'not_found', 'join with unknown code → not_found');

    /* join by code (lower-case + separators are normalized) */
    b.send({ t: 'lobby:join', code: ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3)} `, name: 'Bravo' });
    const [stA, stB] = await Promise.all([a.wait('lobby:state', (m) => m.lobby.players.length === 2), b.wait('lobby:state')]);
    assert(stB.lobby.code === code && stB.lobby.players.length === 2, 'B joined via normalized code', stB.lobby);
    assert(stA.lobby.players.find((p) => p.id === b.id)?.slot === 1, 'A saw B join at slot 1');
    c.send({ t: 'lobby:join', code, name: 'Charlie' });
    await Promise.all([a.wait('lobby:state', (m) => m.lobby.players.length === 3), b.wait('lobby:state', (m) => m.lobby.players.length === 3), c.wait('lobby:state')]);
    assert(c.lobby?.players.find((p) => p.id === c.id)?.slot === 2, 'C joined at slot 2');
    b.send({ t: 'lobby:join', code, name: 'Bravo2' });
    err = await b.wait('lobby:error');
    assert(err.code === 'in_lobby', 'joining twice → in_lobby');

    /* start rejected: non-host, then not ready */
    b.send({ t: 'lobby:start', seed: 7 });
    err = await b.wait('lobby:error');
    assert(err.code === 'not_host', 'non-host start → not_host');
    a.send({ t: 'lobby:start', seed: 7 });
    err = await a.wait('lobby:error');
    assert(err.code === 'not_ready', 'start with nobody ready → not_ready');

    /* ready ×3 (start still rejected until the last one) */
    a.send({ t: 'lobby:ready', ready: true });
    await Promise.all([a, b, c].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === a.id)?.ready === true)));
    b.send({ t: 'lobby:ready', ready: true });
    await Promise.all([a, b, c].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === b.id)?.ready === true)));
    a.send({ t: 'lobby:start', seed: 7 });
    err = await a.wait('lobby:error');
    assert(err.code === 'not_ready', 'start with 2/3 ready → not_ready');
    c.send({ t: 'lobby:ready', ready: true });
    await Promise.all([a, b, c].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => p.ready))));
    pass('all three ready and every client saw it');

    /* start (Phase 11: a raid needs a 목표 행성 first) */
    await pickPlanet(a, 'mossy', [b, c]);
    a.send({ t: 'lobby:start', seed: 1234 });
    const starts = await Promise.all([a, b, c].map((cl) => cl.wait('game:start')));
    assert(starts.every((m) => m.seed === 1234 && m.lobby.started && m.lobby.seed === 1234), 'game:start broadcast with seed to all 3');
    a.send({ t: 'lobby:start', seed: 9 });
    err = await a.wait('lobby:error');
    assert(err.code === 'started', 'second start → started');
    a.send({ t: 'lobby:seed', seed: 5 });
    err = await a.wait('lobby:error');
    assert(err.code === 'started', 'lobby:seed after start → started');
    c.send({ t: 'lobby:ready', ready: false });
    st = await c.wait('lobby:state');
    assert(st.lobby.started && st.lobby.players.find((p) => p.id === c.id)?.ready === true, 'lobby:ready on a started lobby → no-op echo of the state', st.lobby);
    assert(await a.expectNone('lobby:state'), 'started-lobby ready no-op is not broadcast');

    /* a late joiner is refused */
    const d = new TestClient('D', url);
    await d.open();
    const dw = await d.wait('welcome'); d.id = dw.id;
    d.send({ t: 'lobby:join', code, name: 'Delta' });
    err = await d.wait('lobby:error');
    assert(err.code === 'started', 'join after start → started');

    /* relay: to host / others / peerId / all */
    b.send({ t: 'relay', to: 'host', d: { t: 'chat', text: 'to-host' } });
    const rh = await a.wait('relay', (m) => m.d.t === 'chat' && m.d.text === 'to-host');
    assert(rh.from === b.id, "relay 'host' reaches the host with from=sender");
    assert(await c.expectNone('relay'), "relay 'host' does not reach other peers");

    a.send({ t: 'relay', to: 'others', d: { t: 'ps', seq: 1, time: 0, p: [1, 2, 3], v: [0, 0, 0], yaw: 0, pitch: 0, stance: 'stand', f: 0, hp: 100, w: null, stride: 0, move: 0 } });
    const [rob, roc] = await Promise.all([b.wait('relay', (m) => m.d.t === 'ps'), c.wait('relay', (m) => m.d.t === 'ps')]);
    assert(rob.from === a.id && roc.from === a.id && rob.d.t === 'ps' && rob.d.p[2] === 3, "relay 'others' reaches both peers verbatim");
    assert(await a.expectNone('relay'), "relay 'others' excludes the sender");

    c.send({ t: 'relay', to: b.id, d: { t: 'chat', text: 'direct' } });
    const rd = await b.wait('relay', (m) => m.d.t === 'chat' && m.d.text === 'direct');
    assert(rd.from === c.id, 'relay to peerId reaches only that peer');
    assert(await a.expectNone('relay'), 'peerId relay skips others');

    c.send({ t: 'relay', to: 'all', d: { t: 'chat', text: 'everyone' } });
    const ra = await Promise.all([a, b, c].map((cl) => cl.wait('relay', (m) => m.d.t === 'chat' && m.d.text === 'everyone')));
    assert(ra.every((m) => m.from === c.id), "relay 'all' includes the sender");

    c.send({ t: 'relay', to: d.id, d: { t: 'chat', text: 'leak?' } });
    assert(await d.expectNone('relay'), 'relay to a peer outside the lobby is dropped');

    /* reset (host only) */
    b.send({ t: 'lobby:reset' });
    err = await b.wait('lobby:error');
    assert(err.code === 'not_host', 'non-host reset → not_host');
    a.send({ t: 'lobby:reset' });
    const resets = await Promise.all([a, b, c].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started)));
    assert(resets.every((m) => m.lobby.seed === null && m.lobby.players.every((p) => !p.ready)), 'reset clears started/seed/ready for everyone');

    /* explicit leave */
    c.send({ t: 'lobby:leave' });
    const left = await c.wait('lobby:left');
    assert(left.t === 'lobby:left', 'leaver gets lobby:left');
    const pl = await Promise.all([a, b].map((cl) => cl.wait('peer:left')));
    assert(pl.every((m) => m.id === c.id && m.lobby.players.length === 2 && m.lobby.hostId === a.id), 'others get peer:left for C, host unchanged');
    c.send({ t: 'lobby:leave' });
    err = await c.wait('lobby:error');
    assert(err.code === 'not_in_lobby', 'leaving twice → not_in_lobby');

    /* slot reuse: C rejoins and gets the lowest free slot (2) */
    c.send({ t: 'lobby:join', code, name: 'Charlie' });
    await Promise.all([a, b].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.length === 3)));
    const cs = await c.wait('lobby:state');
    assert(cs.lobby.players.find((p) => p.id === c.id)?.slot === 2, 'rejoin reuses the lowest free slot');

    /* host disconnects → slot kept (connected=false), host migrated immediately to lowest connected slot (B) */
    a.close();
    const susp = await Promise.all([b, c].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === a.id)?.connected === false)));
    assert(susp.every((m) => m.lobby.hostId === b.id && m.lobby.players.find((p) => p.id === b.id)?.isHost === true
      && m.lobby.players.find((p) => p.id === c.id)?.isHost === false && m.lobby.players.length === 3),
      'host drop → lobby:state with A connected=false, slot kept, host migrated to B', susp[0].lobby);
    /* anonymous peers cannot come back → grace expiry removes A with peer:left */
    const mig = await Promise.all([b, c].map((cl) => cl.wait('peer:left', (m) => m.id === a.id, GRACE_MS + 1500)));
    assert(mig.every((m) => m.lobby.players.length === 2 && m.lobby.hostId === b.id), 'grace expiry → peer:left for A, 2 players remain', mig[0].lobby);
    b.send({ t: 'lobby:start', seed: 1 });
    err = await b.wait('lobby:error');
    assert(err.code === 'not_ready', 'new host may call start (rejected only for readiness)');

    /* a clean close of a lobby-less client is reaped from server state immediately */
    const before = server.clientCount();
    d.close();
    await sleep(200);
    assert(server.clientCount() === before - 1, 'disconnected client removed from server registry');

    /* everyone leaves → lobby deleted once the grace timers expire */
    b.close(); c.close();
    await sleep(200);
    assert(server.lobbies.count === 1, 'lobby lingers while members are within grace', server.lobbies.count);
    await sleep(GRACE_MS + 300);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'empty lobby deleted after grace, no clients left', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════════ part 2: session tokens / reconnection ══════════════════════════ */
    const T1 = makeToken('e'), T2 = makeToken('f'), T3 = makeToken('g');
    const expectedE = peerIdFromToken(T1);

    /* token → deterministic id; invalid token → random id */
    let { c: e, welcome: ew } = await connect('E', url, { token: T1, name: 'Echo' });
    assert(e.id === expectedE && e.id.length === PEER_ID_LENGTH, 'token → deterministic PeerId (sha256/base64url/12)', { id: e.id, expectedE });
    assert(ew.lobby === undefined && ew.resumed === undefined, 'first connect with a token → welcome without lobby');
    const { c: badTok } = await connect('BAD', url, { token: 'too-short' });
    assert(badTok.id !== peerIdFromToken('too-short') && badTok.id.length === 8, 'invalid token → random anonymous id', badTok.id);
    badTok.close();
    e.close();
    await e.closed();
    ({ c: e, welcome: ew } = await connect('E2', url, { token: T1, name: 'Echo' }));
    assert(e.id === expectedE, 'reconnect with the same token → same PeerId');

    /* duplicate: a second socket with the same token replaces the first */
    const eDup = new TestClient('E3', url, { token: T1, name: 'Echo' });
    await eDup.open();
    const [dupErr, dupWelcome] = await Promise.all([e.wait('lobby:error'), eDup.wait('welcome')]);
    eDup.id = dupWelcome.id;
    assert(dupErr.code === 'duplicate', 'old socket gets lobby:error duplicate');
    await e.closed();
    assert(e.closeCode === 4001, 'old socket is closed by the server (code 4001)', e.closeCode);
    assert(dupWelcome.id === expectedE, 'new socket owns the same PeerId');
    e = eDup;

    /* E creates a private lobby, F joins */
    e.send({ t: 'lobby:create', name: 'Echo' });
    st = await e.wait('lobby:state');
    const codeE = st.lobby.code;
    const { c: f } = await connect('F', url, { token: T2, name: 'Fox' });
    f.send({ t: 'lobby:join', code: codeE, name: 'Fox' });
    await Promise.all([e.wait('lobby:state', (m) => m.lobby.players.length === 2), f.wait('lobby:state')]);
    assert(f.lobby?.players.find((p) => p.id === f.id)?.slot === 1, 'F joined E\'s lobby at slot 1');

    /* host E drops → F sees E connected=false, F becomes host; E's slot is kept */
    e.close();
    st = await f.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.connected === false);
    assert(st.lobby.players.length === 2 && st.lobby.hostId === f.id && st.lobby.players.find((p) => p.id === e.id)?.slot === 0,
      'member drop keeps the slot with connected=false; host migrated to the connected member', st.lobby);

    /* E reconnects within grace → welcome carries the lobby + resumed; F sees connected=true; E is no longer host */
    ({ c: e, welcome: ew } = await connect('E4', url, { token: T1, name: 'Echo2' }));
    assert(ew.lobby?.code === codeE && ew.resumed === true, 'reconnect within grace → welcome {lobby, resumed:true}', ew);
    assert(ew.lobby?.players.find((p) => p.id === e.id)?.connected === true && ew.lobby?.hostId === f.id, 'resumed member is connected again; host stays with F', ew.lobby);
    st = await f.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.connected === true);
    assert(st.lobby.players.find((p) => p.id === e.id)?.name === 'Echo2', 'reconnect broadcasts lobby:state; ?n= renames the member', st.lobby);
    assert(await f.expectNone('peer:left'), 'no peer:left for a member who came back in time');

    /* grace expiry: F (host) drops and never returns → E becomes host immediately, F removed after grace */
    f.close();
    st = await e.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === f.id)?.connected === false);
    assert(st.lobby.hostId === e.id && st.lobby.players.find((p) => p.id === e.id)?.isHost === true, 'host drop → host migrates back to E (lowest connected slot)', st.lobby);
    const fLeft = await e.wait('peer:left', (m) => m.id === f.id, GRACE_MS + 1500);
    assert(fLeft.lobby.players.length === 1 && fLeft.lobby.hostId === e.id, 'grace expiry → peer:left, member removed', fLeft.lobby);
    /* F comes back too late → no lobby in welcome */
    const { c: fLate, welcome: fw } = await connect('F2', url, { token: T2, name: 'Fox' });
    assert(fw.lobby === undefined, 'reconnect after grace → welcome without lobby (slot is gone)', fw);
    fLate.close();
    await fLate.closed();
    await sleep(50);

    /* allReady ignores disconnected members: G joins, both ready, G drops, E may start */
    let { c: g } = await connect('G', url, { token: T3, name: 'Golf' });
    g.send({ t: 'lobby:join', code: codeE, name: 'Golf' });
    await Promise.all([e.wait('lobby:state', (m) => m.lobby.players.length === 2), g.wait('lobby:state')]);
    e.send({ t: 'lobby:ready', ready: true });
    await Promise.all([e, g].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.ready === true)));
    e.send({ t: 'lobby:start', seed: 3 });
    err = await e.wait('lobby:error');
    assert(err.code === 'not_ready', 'start with a connected member not ready → not_ready');
    g.close();
    await e.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === g.id)?.connected === false);
    await pickPlanet(e, 'amber');
    e.send({ t: 'lobby:start', seed: 77 });
    const gs = await e.wait('game:start');
    assert(gs.seed === 77 && gs.lobby.started && gs.lobby.players.length === 2, 'start succeeds while a not-ready member is disconnected (allReady ignores dropped members)', gs.lobby);

    /* G reconnects into the started lobby → welcome.lobby.started (mission in progress → rejoin path) */
    ({ c: g } = await connect('G2', url, { token: T3, name: 'Golf' }));
    assert(g.lobby?.code === codeE && g.lobby.started === true && g.lobby.seed === 77, 'reconnect into a started lobby → welcome.lobby.started with the seed', g.lobby);
    await e.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === g.id)?.connected === true);
    // Phase 9: a rejoin enters the mission (`lobby:mission true`) — only in-mission members can inherit the host role.
    g.send({ t: 'lobby:mission', inMission: true });
    await Promise.all([e, g].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === g.id)?.inMission === true)));
    g.send({ t: 'relay', to: 'host', d: { t: 'flow', ev: 'rejoined' } });
    const rj = await e.wait('relay', (m) => m.d.t === 'flow');
    assert(rj.from === g.id, 'rejoined member can relay to the host again');

    /* started lobby: the host's drop keeps the host id through the grace (returning host stays the authority) */
    e.close();
    st = await g.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.connected === false);
    assert(st.lobby.started && st.lobby.hostId === e.id && st.lobby.players.find((p) => p.id === e.id)?.isHost === true
      && st.lobby.players.find((p) => p.id === g.id)?.isHost === false,
      'host drop while started → host id kept (no immediate migration)', st.lobby);
    ({ c: e, welcome: ew } = await connect('E5', url, { token: T1, name: 'Echo2' }));
    assert(ew.lobby?.started === true && ew.lobby.hostId === e.id && ew.lobby.players.find((p) => p.id === e.id)?.isHost === true,
      'returning host resumes as host of the running mission', ew.lobby);
    await g.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.connected === true);
    pass('squad sees the host reconnected');

    /* started lobby: host gone for the whole grace → migration happens at expiry */
    e.close();
    st = await g.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === e.id)?.connected === false);
    assert(st.lobby.hostId === e.id, 'second host drop while started still keeps the host id', st.lobby);
    g.send({ t: 'relay', to: 'host', d: { t: 'exq', ev: 'sync' } });
    assert(await g.expectNone('lobby:error', 100), 'relay to a dropped host is silently skipped (no error)');
    // 2026-09-07: the grace expiry of an in-mission member of a **started** lobby no longer reaps the slot — the raid
    // keeps the body until it ends. The host role still moves at that first expiry.
    const hostMoved = await g.wait('lobby:state', (m) => m.lobby.hostId === g.id, GRACE_MS + 1500);
    assert(hostMoved.lobby.players.find((p) => p.id === g.id)?.isHost === true && hostMoved.lobby.started
      && hostMoved.lobby.players.length === 2 && hostMoved.lobby.players.find((p) => p.id === e.id)?.connected === false,
      'grace expiry while started → host migrated to G, the dropped raider keeps their slot', hostMoved.lobby);
    assert(await g.expectNone('peer:left', 400), 'no peer:left while the raid is still running');
    g.send({ t: 'lobby:reset' });
    await g.wait('lobby:state', (m) => !m.lobby.started);
    pass('new host reset after the mission');
    /* mission over → the next grace tick finally reaps the member who never came back */
    const eLeft = await g.wait('peer:left', (m) => m.id === e.id, GRACE_MS + 1500);
    assert(eLeft.lobby.players.length === 1, 'mission reset → the kept slot is reaped at the next grace tick', eLeft.lobby);
    /* E is out of the lobby now; reconnect it lobby-less so the cleanup below closes a live socket */
    ({ c: e } = await connect('E6', url, { token: T1, name: 'Echo' }));
    assert(e.lobby === null, 'expired host returns without a lobby');

    /* ══════════════════════════ part 3: quick match / setPublic / seed / name ══════════════════════════ */
    const { c: h } = await connect('H', url, { name: 'Hotel' });
    h.send({ t: 'lobby:quickmatch', name: 'Hotel' });
    st = await h.wait('lobby:state');
    const codeH = st.lobby.code;
    assert(st.lobby.isPublic === true && st.lobby.players.length === 1 && st.lobby.hostId === h.id && codeH !== codeE,
      'quickmatch with no open public lobby → creates a new public lobby (E\'s private lobby is not matched)', st.lobby);
    const { c: i } = await connect('I', url, { name: 'India' });
    i.send({ t: 'lobby:quickmatch', name: 'India' });
    const [hs, is] = await Promise.all([h.wait('lobby:state', (m) => m.lobby.players.length === 2), i.wait('lobby:state')]);
    assert(is.lobby.code === codeH && is.lobby.players.find((p) => p.id === i.id)?.slot === 1 && hs.lobby.players.length === 2,
      'quickmatch joins the existing open public lobby', is.lobby);
    i.send({ t: 'lobby:quickmatch', name: 'India' });
    err = await i.wait('lobby:error');
    assert(err.code === 'in_lobby', 'quickmatch while in a lobby → in_lobby');

    /* setPublic: non-host refused; host makes it private → next quickmatch creates a new lobby */
    i.send({ t: 'lobby:setPublic', isPublic: false });
    err = await i.wait('lobby:error');
    assert(err.code === 'not_host', 'non-host setPublic → not_host');
    h.send({ t: 'lobby:setPublic', isPublic: false });
    await Promise.all([h, i].map((cl) => cl.wait('lobby:state', (m) => m.lobby.isPublic === false)));
    pass('host setPublic(false) broadcast to the lobby');
    const { c: j } = await connect('J', url, { name: 'Juliet' });
    j.send({ t: 'lobby:quickmatch', name: 'Juliet' });
    st = await j.wait('lobby:state');
    const codeJ = st.lobby.code;
    assert(codeJ !== codeH && st.lobby.isPublic && st.lobby.players.length === 1, 'private lobbies are not quick-matched → new public lobby', st.lobby);
    h.send({ t: 'lobby:setPublic', isPublic: true });
    await Promise.all([h, i].map((cl) => cl.wait('lobby:state', (m) => m.lobby.isPublic === true)));

    /* started lobbies are not matched: J's lobby (older? no — H's is older) → H's lobby is oldest and open again */
    const { c: k } = await connect('K', url, { name: 'Kilo' });
    k.send({ t: 'lobby:quickmatch', name: 'Kilo' });
    st = await k.wait('lobby:state');
    assert(st.lobby.code === codeH && st.lobby.players.length === 3, 'quickmatch prefers the oldest open public lobby', { code: st.lobby.code, codeH, codeJ });
    await Promise.all([h, i].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.length === 3)));
    for (const cl of [h, i, k]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([h, i, k].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => p.ready))));
    await pickPlanet(h, 'tundra', [i, k]);
    h.send({ t: 'lobby:start', seed: 11 });
    await Promise.all([h, i, k].map((cl) => cl.wait('game:start')));
    const { c: l } = await connect('L', url, { name: 'Lima' });
    l.send({ t: 'lobby:quickmatch', name: 'Lima' });
    st = await l.wait('lobby:state');
    assert(st.lobby.code === codeJ && st.lobby.players.length === 2, 'started lobbies are not quick-matched → joins the next open one (J)', { code: st.lobby.code, codeJ });
    await j.wait('lobby:state', (m) => m.lobby.players.length === 2);

    /* seed: host only, not started */
    l.send({ t: 'lobby:seed', seed: 999 });
    err = await l.wait('lobby:error');
    assert(err.code === 'not_host', 'non-host lobby:seed → not_host');
    j.send({ t: 'lobby:seed', seed: 999 });
    const seeds = await Promise.all([j, l].map((cl) => cl.wait('lobby:state', (m) => m.lobby.seed === 999)));
    assert(seeds.every((m) => !m.lobby.started), 'host lobby:seed → LobbyState.seed broadcast (not started)');

    /* name */
    l.send({ t: 'lobby:name', name: '  Lima<b>Prime  ' });
    const names = await Promise.all([j, l].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === l.id)?.name === 'LimabPrime')));
    assert(names.length === 2, 'lobby:name sanitizes and broadcasts the new name');
    const { c: m } = await connect('M', url, { name: 'Mike' });
    m.send({ t: 'lobby:name', name: 'Mike2' });
    assert(await m.expectNone('lobby:error'), 'lobby:name outside a lobby is accepted silently');

    /* ══════════════════════════ part 4: ghost hosts (not-started lobby whose host is in grace) ══════════════════════════ */
    /* close J's lobby to quick match by starting it */
    for (const cl of [j, l]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([j, l].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => p.ready))));
    await pickPlanet(j, 'ashen', [l]);
    j.send({ t: 'lobby:start', seed: 5 });
    await Promise.all([j, l].map((cl) => cl.wait('game:start')));
    /* N creates a public lobby and drops → zero connected members, still within grace */
    const TN = makeToken('n');
    const { c: n } = await connect('N', url, { token: TN, name: 'Nov' });
    n.send({ t: 'lobby:quickmatch', name: 'Nov' });
    st = await n.wait('lobby:state');
    const codeN = st.lobby.code;
    assert(st.lobby.players.length === 1 && st.lobby.isPublic, 'N opened a fresh public lobby (no other open one)', st.lobby);
    n.close(); await n.closed(); await sleep(30);
    assert(server.lobbies.byCode(codeN)?.connectedCount() === 0 && server.lobbies.byCode(codeN)?.hostId === n.id, 'N lobby lingers with zero connected members, N still host', server.lobbies.byCode(codeN)?.toState());
    /* O quick-matches: the ghost lobby is the only candidate → join it and become host immediately */
    const { c: o } = await connect('O', url, { name: 'Oscar' });
    o.send({ t: 'lobby:quickmatch', name: 'Oscar' });
    st = await o.wait('lobby:state');
    assert(st.lobby.code === codeN && st.lobby.hostId === o.id && st.lobby.players.find((p) => p.id === o.id)?.isHost === true
      && st.lobby.players.find((p) => p.id === n.id)?.connected === false && st.lobby.players.find((p) => p.id === n.id)?.isHost === false,
      'quickmatch into a lobby with a ghost host → joiner becomes host at once', st.lobby);
    const nGone = await o.wait('peer:left', (m) => m.id === n.id, GRACE_MS + 1500);
    assert(nGone.lobby.hostId === o.id && nGone.lobby.players.length === 1, 'ghost host expires → peer:left, O stays host', nGone.lobby);
    /* preference: R (older, zero connected) vs Q (newer, 1 connected) → S lands in Q's lobby */
    o.send({ t: 'lobby:setPublic', isPublic: false });
    await o.wait('lobby:state', (m) => !m.lobby.isPublic);
    const TR = makeToken('r');
    const { c: r } = await connect('R', url, { token: TR, name: 'Romeo' });
    r.send({ t: 'lobby:quickmatch', name: 'Romeo' });
    st = await r.wait('lobby:state');
    const codeR = st.lobby.code;
    r.send({ t: 'lobby:setPublic', isPublic: false });
    await r.wait('lobby:state', (m) => !m.lobby.isPublic);
    const { c: q } = await connect('Q', url, { name: 'Quebec' });
    q.send({ t: 'lobby:quickmatch', name: 'Quebec' });
    st = await q.wait('lobby:state');
    const codeQ = st.lobby.code;
    assert(codeQ !== codeR && st.lobby.players.length === 1, 'Q opened its own public lobby while R lobby was private', st.lobby);
    r.send({ t: 'lobby:setPublic', isPublic: true });
    await r.wait('lobby:state', (m) => m.lobby.isPublic);
    r.close(); await r.closed(); await sleep(30);
    const { c: s2 } = await connect('S', url, { name: 'Sierra' });
    s2.send({ t: 'lobby:quickmatch', name: 'Sierra' });
    st = await s2.wait('lobby:state');
    assert(st.lobby.code === codeQ && st.lobby.players.length === 2 && st.lobby.hostId === q.id,
      'quickmatch prefers the lobby with a connected member over an older ghost lobby', { code: st.lobby.code, codeQ, codeR });
    await q.wait('lobby:state', (m) => m.lobby.players.length === 2);
    /* code join into a ghost-host lobby → joiner becomes host too */
    const { c: t2 } = await connect('T', url, { name: 'Tango' });
    t2.send({ t: 'lobby:join', code: codeR, name: 'Tango' });
    st = await t2.wait('lobby:state');
    assert(st.lobby.code === codeR && st.lobby.hostId === t2.id && st.lobby.players.find((p) => p.id === r.id)?.connected === false,
      'code join into a lobby with a ghost host → joiner becomes host at once', st.lobby);
    /* the started-lobby rule is untouched: H's started lobby keeps its host through a drop */
    h.close();
    st = await i.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === h.id)?.connected === false);
    assert(st.lobby.started && st.lobby.hostId === h.id, 'started lobby still keeps a dropped host during grace', st.lobby);

    /* cleanup: everyone closes → all lobbies deleted after grace */
    for (const cl of [e, g, h, i, j, k, l, m, n, o, q, r, s2, t2]) cl.close();
    await sleep(GRACE_MS + 400);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'all lobbies deleted after grace, no clients left', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════════ part 5: Phase 7 — profile store / credits / raid session / training / membership ══════════════════════════ */
    const TU = makeToken('u'), TV = makeToken('v'), TW = makeToken('w');
    let { c: u, welcome: uw } = await connect('U', url, { token: TU, name: 'Uni' });
    assert(uw.profile !== undefined && uw.profile.credits === null && Object.keys(uw.profile.docs).length === 0 && uw.raid === undefined
      && JSON.stringify(uw.profile.docsRev) === '{}',
      'token connect → welcome.profile {credits:null, docs:{}, docsRev:{}} (fresh record; E-6 docsRev always present)', uw.profile);
    const { c: anon, welcome: anonW } = await connect('ANON', url);
    assert(anonW.profile === undefined, 'anonymous connect → no profile in welcome');
    anon.send({ t: 'profile:set', key: 'meta', doc: { x: 1 } });
    err = await anon.wait('lobby:error');
    assert(err.code === 'invalid', 'profile:set from an anonymous id → invalid');
    anon.close();

    /* profile:set / profile:get */
    u.send({ t: 'profile:set', key: 'meta', doc: { credits: 7, rep: { helix: 2 } } });
    u.send({ t: 'profile:set', key: 'stash', doc: [1, 2, 3] });
    assert(await u.expectNone('lobby:error', 150), 'profile:set with valid keys → no error');
    u.send({ t: 'profile:get' });
    let docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.meta) === JSON.stringify({ credits: 7, rep: { helix: 2 } }) && JSON.stringify(docs.profile.docs.stash) === '[1,2,3]' && docs.profile.updatedAt > 0,
      'profile:get returns the stored documents verbatim', docs.profile);
    u.send({ t: 'profile:set', key: 'meta', doc: { credits: 8 }, at: Date.now() });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.meta) === '{"credits":8}' && JSON.stringify(docs.profile.docs.stash) === '[1,2,3]', 'stamped profile:set replaces one key, keeps the others');
    u.sendRaw(JSON.stringify({ t: 'profile:set', key: 'bogus', doc: {} }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'profile:set with an unknown key → invalid');
    u.sendRaw(JSON.stringify({ t: 'profile:set', key: 'ship' }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'profile:set without doc → invalid');
    u.send({ t: 'profile:set', key: 'ship', doc: { pad: 'x'.repeat(PROFILE_DOC_MAX_BYTES + 100) } });
    err = await u.wait('lobby:error');
    assert(err.code === 'too_large', 'profile:set over PROFILE_DOC_MAX_BYTES → too_large');
    u.send({ t: 'profile:set', key: 'ship', doc: { pad: 'x'.repeat(PROFILE_DOC_MAX_BYTES - 100) } });
    assert(await u.expectNone('lobby:error', 150), 'profile:set just under the cap is accepted');

    /* Phase 9: newest wins — stamped writes, stale writes, fresh writes, skew clamp, docsAt on the wire */
    const now = Date.now();
    u.send({ t: 'profile:set', key: 'progression', doc: { v: 'A' }, at: now - 10_000 });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.progression) === '{"v":"A"}' && docs.profile.docsAt?.progression === now - 10_000,
      'stamped profile:set stores the doc and its docsAt stamp', docs.profile.docsAt);
    u.send({ t: 'profile:set', key: 'progression', doc: { v: 'OLD' }, at: now - 20_000 });
    assert(await u.expectNone('lobby:error', 120), 'older stamp is ignored silently (no lobby:error)');
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.progression) === '{"v":"A"}' && docs.profile.docsAt?.progression === now - 10_000, 'older stamp did not replace the newer document');
    u.send({ t: 'profile:set', key: 'progression', doc: { v: 'B' }, at: now - 5_000 });
    u.send({ t: 'profile:set', key: 'progression', doc: { v: 'TIE' }, at: now - 5_000 });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.progression) === '{"v":"TIE"}' && docs.profile.docsAt?.progression === now - 5_000, 'newer stamp replaces; an equal stamp is accepted (ties: latest write)');
    u.send({ t: 'profile:set', key: 'progression', doc: { v: 'FRESH' }, fresh: true });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.progression) === '{"v":"TIE"}', 'fresh write over an existing document is ignored');
    u.send({ t: 'profile:set', key: 'loadout', doc: { v: 'FRESH' }, fresh: true });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.loadout) === '{"v":"FRESH"}' && docs.profile.docsAt?.loadout === undefined, 'fresh write on an absent key is stored without a stamp');
    u.send({ t: 'profile:set', key: 'loadout', doc: { v: 'STAMPED' }, at: 1 });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.loadout) === '{"v":"STAMPED"}' && docs.profile.docsAt?.loadout === 1, 'any stamped write beats an unstamped (fresh) document');
    u.send({ t: 'profile:set', key: 'loadout', doc: { v: 'UNSTAMPED' } });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.loadout) === '{"v":"STAMPED"}', 'a set without at behaves like fresh (ignored over an existing doc)');
    const far = now + 60 * 60_000;
    u.send({ t: 'profile:set', key: 'loadout', doc: { v: 'FUTURE' }, at: far });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    const clampedAt = docs.profile.docsAt?.loadout ?? 0;
    assert(JSON.stringify(docs.profile.docs.loadout) === '{"v":"FUTURE"}' && clampedAt < far && clampedAt <= Date.now() + PROFILE_CLOCK_SKEW_MS && clampedAt > now,
      'a stamp far in the future is clamped to now + PROFILE_CLOCK_SKEW_MS', { far, clampedAt });
    u.sendRaw(JSON.stringify({ t: 'profile:set', key: 'loadout', doc: { v: 'X' }, at: 'yesterday' }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'profile:set with a non-numeric at → invalid');
    u.send({ t: 'profile:set', key: 'meta', doc: { credits: 8 }, at: now });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(docs.profile.docsAt?.meta === now && docs.profile.docsAt?.stash === undefined, 'docsAt lists only stamped documents (pre-Phase-9 docs stay unstamped)', docs.profile.docsAt);
    u.sendRaw(JSON.stringify({ t: 'relay', to: 'all', d: { t: 'chat', text: 'y'.repeat(70 * 1024) } }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'ordinary frames keep the 64 KB cap (oversized relay → invalid)');

    /* credits transactions */
    /* E-4 (⑦, 2026-09-11): reasons are validated now — real item ids from the generated table (buy ≥ best-discount price, sell ≤ table price). */
    const cheapBuy = Object.entries(ECONOMY_TABLE.items).find(([, it]) => tableMinBuyPrice(ECONOMY_TABLE, it.value) <= 100)![0];
    const sellOne = Object.entries(ECONOMY_TABLE.items).find(([, it]) => tableSellPrice(ECONOMY_TABLE, it.value, 1) >= 46)![0];
    u.send({ t: 'credits:tx', txId: 1, delta: -100, reason: `buy:${cheapBuy}` });
    let cr = await u.wait('credits:result', (m) => m.txId === 1);
    assert(cr.ok === false && cr.credits === 0 && cr.reason === '크레딧 부족', 'credits:tx below zero on a null balance → refused with 크레딧 부족', cr);
    u.send({ t: 'credits:tx', txId: 2, delta: 500, reason: 'migrate' });
    cr = await u.wait('credits:result', (m) => m.txId === 2);
    assert(cr.ok === true && cr.credits === 500 && cr.reason === undefined, "first 'migrate' tx seeds the balance with delta", cr);
    u.send({ t: 'credits:tx', txId: 3, delta: 9999, reason: 'migrate' });
    cr = await u.wait('credits:result', (m) => m.txId === 3);
    assert(cr.ok === false && cr.credits === 500 && cr.reason === CREDIT_TX_INVALID_KO, "second 'migrate' is refused (balance kept) — E-4: migrate only while the balance is null", cr);
    u.send({ t: 'credits:tx', txId: 4, delta: -120, reason: `buy:${cheapBuy}` });
    cr = await u.wait('credits:result', (m) => m.txId === 4);
    assert(cr.ok === true && cr.credits === 380, 'debit applied atomically → 380', cr);
    u.send({ t: 'credits:tx', txId: 5, delta: -381, reason: `buy:${cheapBuy}` });
    cr = await u.wait('credits:result', (m) => m.txId === 5);
    assert(cr.ok === false && cr.credits === 380 && cr.reason === '크레딧 부족', 'overdraft refused, balance unchanged', cr);
    u.send({ t: 'credits:tx', txId: 6, delta: 45.9, reason: `sell:${sellOne}:1` });
    cr = await u.wait('credits:result', (m) => m.txId === 6);
    assert(cr.ok === true && cr.credits === 425, 'credit truncated to integers (+45.9 → +45)', cr);
    u.sendRaw(JSON.stringify({ t: 'credits:tx', txId: 7, delta: 'lots', reason: 'x' }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'credits:tx with a non-numeric delta → invalid');
    /* persistence across reconnect */
    u.close(); await u.closed();
    ({ c: u, welcome: uw } = await connect('U2', url, { token: TU, name: 'Uni' }));
    assert(uw.profile?.credits === 425 && JSON.stringify(uw.profile.docs.meta) === '{"credits":8}' && JSON.stringify(uw.profile.docs.stash) === '[1,2,3]',
      'reconnect → welcome.profile carries the stored credits and documents', uw.profile);
    assert(uw.profile?.docsAt?.meta === now && uw.profile.docsAt.progression === now - 5_000, 'welcome.profile carries docsAt (Phase 9)', uw.profile?.docsAt);
    const healthP = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { profiles: number };
    assert(healthP.profiles >= 1, '/health reports the profile count', healthP);

    /* raid session: only while a raid with that seed runs */
    const blob = (seed: number, extra = ''): RaidSessionBlob => ({ seed, missionTime: 12.5, stats: { kills: 3 } as never, inventory: { bag: [extra] }, savedAt: Date.now() });
    u.send({ t: 'raid:save', blob: blob(1) });
    assert(await u.expectNone('lobby:error', 150), 'raid:save outside a lobby is ignored silently');
    u.send({ t: 'lobby:create', name: 'Uni' });
    st = await u.wait('lobby:state');
    const codeU = st.lobby.code;
    assert(st.lobby.mode === undefined && st.lobby.players[0].inMission === false, 'fresh lobby: no mode, inMission=false', st.lobby);
    const { c: v } = await connect('V', url, { token: TV, name: 'Vic' });
    v.send({ t: 'lobby:join', code: codeU, name: 'Vic' });
    await Promise.all([u.wait('lobby:state', (m) => m.lobby.players.length === 2), v.wait('lobby:state')]);
    u.send({ t: 'raid:save', blob: blob(1) });
    assert(await u.expectNone('lobby:error', 150), 'raid:save before start is ignored');
    assert(server.lobbies.byCode(codeU)?.raid.size === 0, 'no blob stored before start');
    /* lobby:mission true while nothing runs → in_mission */
    v.send({ t: 'lobby:mission', inMission: true });
    err = await v.wait('lobby:error');
    assert(err.code === 'in_mission', 'lobby:mission {true} while nothing runs → in_mission');
    /* raid start marks every connected member inMission; mode 'raid' on the wire */
    for (const cl of [u, v]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => p.ready))));
    await pickPlanet(u, 'crimson', [v]);
    u.send({ t: 'lobby:start', seed: 4242 });
    const rs = await Promise.all([u, v].map((cl) => cl.wait('game:start')));
    assert(rs.every((m) => m.mode === 'raid' && m.lobby.mode === 'raid' && m.lobby.players.every((p) => p.inMission === true)),
      'raid start → game:start {mode:raid}, every connected member inMission', rs[0].lobby);
    u.send({ t: 'raid:save', blob: blob(1) });
    assert(await u.expectNone('lobby:error', 150), 'raid:save with a foreign seed is ignored (no error)');
    assert(server.lobbies.byCode(codeU)?.raid.size === 0, 'foreign-seed blob not stored');
    u.send({ t: 'raid:save', blob: blob(4242, 'first') });
    u.send({ t: 'raid:save', blob: blob(4242, 'second') });
    await sleep(80);
    assert(server.lobbies.byCode(codeU)?.raid.get(u.id)?.inventory !== undefined && JSON.stringify(server.lobbies.byCode(codeU)?.raid.get(u.id)?.inventory) === '{"bag":["second"]}',
      'raid:save with the running seed is stored (latest wins)');
    u.send({ t: 'raid:save', blob: blob(4242, 'z'.repeat(RAID_BLOB_MAX_BYTES + 100)) });
    err = await u.wait('lobby:error');
    assert(err.code === 'too_large', 'raid:save over RAID_BLOB_MAX_BYTES → too_large');
    u.sendRaw(JSON.stringify({ t: 'raid:save', blob: { seed: 4242 } }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'raid:save with a malformed blob → invalid');
    /* the host drops and comes back: welcome carries lobby + raid blob; host kept (migrate delay 4 s > grace here) */
    u.close(); await u.closed();
    await v.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === u.id)?.connected === false);
    ({ c: u, welcome: uw } = await connect('U3', url, { token: TU, name: 'Uni' }));
    assert(uw.lobby?.started === true && uw.raid !== undefined && uw.raid !== null && uw.raid.seed === 4242 && JSON.stringify(uw.raid.inventory) === '{"bag":["second"]}',
      'resume into the running raid → welcome.raid returns my blob', uw.raid);
    assert(uw.lobby?.hostId === u.id && uw.lobby.players.find((p) => p.id === u.id)?.inMission === true, 'returning host inside the migrate delay stays host, still inMission', uw.lobby);
    await v.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === u.id)?.connected === true);
    /* a client leaves the mission: lobby:mission false → inMission false, blob dropped, lobby still started */
    v.send({ t: 'lobby:mission', inMission: false });
    const vm = await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === v.id)?.inMission === false)));
    assert(vm.every((m) => m.lobby.started && m.lobby.mode === 'raid'), 'lobby:mission {false} in a raid → inMission false, raid keeps running', vm[0].lobby);
    v.send({ t: 'lobby:mission', inMission: true });
    await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === v.id)?.inMission === true)));
    pass('lobby:mission {true} on a started lobby → inMission true again (rejoin)');
    /* lobby:reset clears membership + blobs */
    u.send({ t: 'lobby:reset' });
    const rst = await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started)));
    assert(rst.every((m) => m.lobby.mode === undefined && m.lobby.players.every((p) => p.inMission === false)) && server.lobbies.byCode(codeU)?.raid.size === 0,
      'lobby:reset → mode cleared, everyone inMission=false, raid blobs dropped', rst[0].lobby);
    u.close(); await u.closed();
    ({ c: u, welcome: uw } = await connect('U4', url, { token: TU, name: 'Uni' }));
    assert(uw.lobby?.code === codeU && uw.raid === undefined, 'resume after reset → no raid blob', uw);
    assert(uw.lobby?.hostId === v.id, 'host drop in the hub (not started) migrated the host to V at once', uw.lobby);
    await v.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === u.id)?.connected === true);
    u.flush(); v.flush();

    /* training: any member starts, no ready gating, only the starter enters, joins stay open, auto reset */
    v.send({ t: 'lobby:start', seed: 1, mode: 'raid' });
    err = await v.wait('lobby:error');
    assert(err.code === 'not_ready', "explicit mode:'raid' keeps the ready gating");
    u.send({ t: 'lobby:start', seed: 99, mode: 'training' });
    const ts = await Promise.all([u, v].map((cl) => cl.wait('game:start')));
    assert(ts.every((m) => m.mode === 'training' && m.seed === 99 && m.lobby.started && m.lobby.mode === 'training'
      && m.lobby.players.find((p) => p.id === u.id)?.inMission === true && m.lobby.players.find((p) => p.id === v.id)?.inMission === false),
      'non-host training start → game:start {mode:training} to all, only the starter inMission', ts[0].lobby);
    u.send({ t: 'lobby:start', seed: 5, mode: 'training' });
    err = await u.wait('lobby:error');
    assert(err.code === 'started', 'second training start → started');
    u.send({ t: 'raid:save', blob: blob(99) });
    await sleep(60);
    assert(server.lobbies.byCode(codeU)?.raid.size === 0, 'raid:save during a training is ignored');
    const { c: w } = await connect('W', url, { token: TW, name: 'Whi' });
    w.send({ t: 'lobby:join', code: codeU, name: 'Whi' });
    const wj = await w.wait('lobby:state');
    assert(wj.lobby.started && wj.lobby.mode === 'training' && wj.lobby.players.length === 3 && wj.lobby.players.find((p) => p.id === w.id)?.inMission === false,
      'a training keeps the lobby open: newcomer joins with inMission=false', wj.lobby);
    await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.length === 3)));
    u.flush(); v.flush(); w.flush();
    v.send({ t: 'lobby:mission', inMission: true });
    await Promise.all([u, v, w].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === v.id)?.inMission === true)));
    pass('another member joins the training with lobby:mission {true}');
    u.send({ t: 'lobby:mission', inMission: false });
    const vl = await Promise.all([u, v, w].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === u.id)?.inMission === false)));
    assert(vl.every((m) => m.lobby.started && m.lobby.mode === 'training'), 'the starter leaving keeps the training running while someone is still in', vl[0].lobby);
    v.send({ t: 'lobby:mission', inMission: false });
    const ended = await Promise.all([u, v, w].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started)));
    assert(ended.every((m) => m.lobby.mode === undefined && m.lobby.seed === null && m.lobby.players.every((p) => !p.inMission && !p.ready)),
      'last member leaving a training → server reset (started=false, mode cleared)', ended[0].lobby);
    /* auto reset also when the last trainee's grace expires */
    w.send({ t: 'lobby:start', seed: 7, mode: 'training' });
    await Promise.all([u, v, w].map((cl) => cl.wait('game:start')));
    w.close();
    const wGone = await Promise.all([u, v].map((cl) => cl.wait('peer:left', (m) => m.id === w.id, GRACE_MS + 1500)));
    assert(wGone.every((m) => m.lobby.players.length === 2), 'trainee grace expiry → peer:left', wGone[0].lobby);
    const wReset = await Promise.all([u, v].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started, 1500)));
    assert(wReset.every((m) => m.lobby.mode === undefined), 'training whose only member expired → reset broadcast', wReset[0].lobby);
    u.close(); v.close();
    await sleep(GRACE_MS + 400);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'part 5 cleanup: all lobbies deleted', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════════ part 6: Phase 7 — mid-mission host migration (own server: short delay, longer grace) ══════════════════════════ */
    const MIG_MS = 250;
    const server2 = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: 2_500, hostMigrateDelayMs: MIG_MS, dataDir: null });
    const url2 = `ws://127.0.0.1:${server2.port}${NET_WS_PATH}`;
    try {
      const TX = makeToken('x'), TY = makeToken('y'), TZ = makeToken('z');
      let { c: x } = await connect('X', url2, { token: TX, name: 'Xen' });
      const { c: y } = await connect('Y', url2, { token: TY, name: 'Yan' });
      const { c: z } = await connect('Z', url2, { token: TZ, name: 'Zed' });
      x.send({ t: 'lobby:create', name: 'Xen' });
      st = await x.wait('lobby:state');
      const codeX = st.lobby.code;
      y.send({ t: 'lobby:join', code: codeX, name: 'Yan' });
      await Promise.all([x.wait('lobby:state', (m) => m.lobby.players.length === 2), y.wait('lobby:state')]);
      z.send({ t: 'lobby:join', code: codeX, name: 'Zed' });
      await Promise.all([x.wait('lobby:state', (m) => m.lobby.players.length === 3), y.wait('lobby:state', (m) => m.lobby.players.length === 3), z.wait('lobby:state')]);
      for (const cl of [x, y, z]) cl.send({ t: 'lobby:ready', ready: true });
      await Promise.all([x, y, z].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => p.ready))));
      await pickPlanet(x, 'mossy', [y, z]);
      x.send({ t: 'lobby:start', seed: 31 });
      await Promise.all([x, y, z].map((cl) => cl.wait('game:start')));
      /* Y (slot 1) leaves the mission → Z (slot 2, inMission) must be preferred over Y when the host drops */
      y.send({ t: 'lobby:mission', inMission: false });
      await Promise.all([x, y, z].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === y.id)?.inMission === false)));
      /* brief blip: host back before the delay → stays host */
      x.close(); await x.closed();
      st = await z.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === x.id)?.connected === false);
      assert(st.lobby.hostId === x.id, 'host drop while started → host id kept at first', st.lobby);
      ({ c: x } = await connect('X2', url2, { token: TX, name: 'Xen' }));
      assert(x.lobby?.hostId === x.id, 'host back within NET_HOST_MIGRATE_DELAY → still host', x.lobby);
      await z.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === x.id)?.connected === true);
      assert(await z.expectNone('lobby:state', MIG_MS + 200, (m) => m.t === 'lobby:state' && m.lobby.hostId !== x.id), 'no migration fires after the host returned');
      /* real drop: after the delay the role moves to the connected member INSIDE the mission (Z, not Y) */
      x.close(); await x.closed();
      await Promise.all([y, z].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === x.id)?.connected === false)));
      const t0 = Date.now();
      const mg = await Promise.all([y, z].map((cl) => cl.wait('lobby:state', (m) => m.lobby.hostId !== x.id, MIG_MS + 1500)));
      const dtMig = Date.now() - t0;
      assert(mg.every((m) => m.lobby.hostId === z.id && m.lobby.started && m.lobby.players.find((p) => p.id === z.id)?.isHost === true && m.lobby.players.find((p) => p.id === x.id)?.connected === false),
        'host still down after the delay → lobby:state with the host migrated to the connected inMission member (Z over Y)', mg[0].lobby);
      assert(dtMig >= MIG_MS - 50 && dtMig < MIG_MS + 1000, `migration happened after ~${MIG_MS} ms (${dtMig} ms)`);
      assert(await y.expectNone('peer:left', 200), 'old host keeps its slot (grace still running)');
      /* the old host returns: welcome.lobby.hostId says it is a client now; Z stays host */
      ({ c: x } = await connect('X3', url2, { token: TX, name: 'Xen' }));
      assert(x.lobby?.hostId === z.id && x.lobby.players.find((p) => p.id === x.id)?.isHost === false && x.lobby.players.find((p) => p.id === x.id)?.inMission === true,
        'returning old host learns from welcome.lobby.hostId that it is a client (still inMission)', x.lobby);
      x.send({ t: 'relay', to: 'host', d: { t: 'flow', ev: 'rejoined' } });
      const rjz = await z.wait('relay', (m) => m.d.t === 'flow');
      assert(rjz.from === x.id, "relay to 'host' reaches the new host");
      /* new host drops with nobody left inside → falls back to a connected member (Y) */
      z.close(); await z.closed();
      const mg2 = await Promise.all([x, y].map((cl) => cl.wait('lobby:state', (m) => m.lobby.hostId !== z.id, MIG_MS + 1500)));
      assert(mg2.every((m) => m.lobby.hostId === x.id), 'next migration prefers the connected inMission member again (X, slot 0)', mg2[0].lobby);
      /* not-started lobby keeps the immediate migration */
      x.send({ t: 'lobby:reset' });
      await Promise.all([x, y].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started)));
      y.flush();
      x.close(); await x.closed();
      st = await y.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === x.id)?.connected === false);
      assert(st.lobby.hostId === y.id, 'hub (not started) lobby still migrates the host immediately', st.lobby);
      y.close();

      /* ── Phase 9: parked host, reload = mission leave, host-away, raid over ── */
      const TI = makeToken('i'), TJ = makeToken('j'), TK = makeToken('k');
      let { c: pi } = await connect('I', url2, { token: TI, name: 'Ivy' });
      let { c: pj } = await connect('J', url2, { token: TJ, name: 'Jo' });
      const { c: pk } = await connect('K', url2, { token: TK, name: 'Kim' });
      pi.send({ t: 'lobby:create', name: 'Ivy' });
      st = await pi.wait('lobby:state');
      const codeI = st.lobby.code;
      pj.send({ t: 'lobby:join', code: codeI, name: 'Jo' });
      await Promise.all([pi.wait('lobby:state', (m) => m.lobby.players.length === 2), pj.wait('lobby:state')]);
      pk.send({ t: 'lobby:join', code: codeI, name: 'Kim' });
      await Promise.all([pi.wait('lobby:state', (m) => m.lobby.players.length === 3), pj.wait('lobby:state', (m) => m.lobby.players.length === 3), pk.wait('lobby:state')]);
      const readyAll = async (cls: TestClient[]): Promise<void> => {
        for (const cl of cls) cl.send({ t: 'lobby:ready', ready: true });
        await Promise.all(cls.map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.every((p) => !p.connected || p.ready))));
      };
      await readyAll([pi, pj, pk]);
      await pickPlanet(pi, 'tundra', [pj, pk]);
      pi.send({ t: 'lobby:start', seed: 51 });
      await Promise.all([pi, pj, pk].map((cl) => cl.wait('game:start')));
      /* K goes back to the hub (connected, out of the mission); J drops while inside */
      pk.send({ t: 'lobby:mission', inMission: false });
      await Promise.all([pi, pj, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pk.id)?.inMission === false)));
      pj.close(); await pj.closed();
      await Promise.all([pi, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pj.id)?.connected === false)));
      /* host drops: only a hub member is connected → the role is parked, not handed to the hub */
      pi.close(); await pi.closed();
      await pk.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pi.id)?.connected === false);
      assert(await pk.expectNone('lobby:state', MIG_MS + 400, (m) => m.t === 'lobby:state' && m.lobby.hostId !== pi.id),
        'host down past the delay with only a hub member connected → host parked (no migration to the hub member)');
      assert(server2.lobbies.byCode(codeI)?.hostId === pi.id && server2.lobbies.byCode(codeI)?.started === true, 'parked lobby keeps the dropped host id and stays started');
      pk.send({ t: 'relay', to: 'host', d: { t: 'exq', ev: 'sync' } });
      assert(await pk.expectNone('lobby:error', 100), 'relay to a parked host is dropped silently');
      /* an in-mission member reconnects → takes the role at once (welcome already says so) */
      ({ c: pj } = await connect('J2', url2, { token: TJ, name: 'Jo' }));
      assert(pj.lobby?.hostId === pj.id && pj.lobby.started && pj.lobby.players.find((p) => p.id === pj.id)?.isHost === true && pj.lobby.players.find((p) => p.id === pj.id)?.inMission === true,
        'in-mission member reconnecting into a parked lobby becomes host immediately (welcome.lobby.hostId)', pj.lobby);
      await pk.wait('lobby:state', (m) => m.lobby.hostId === pj.id);
      pass('hub member sees the parked-host handover broadcast');
      /* duplicate socket = a new page → out of the mission; nobody eligible → the role stays with it for now */
      const pj2 = new TestClient('J3', url2, { token: TJ, name: 'Jo' });
      await pj2.open();
      const [dupErr9, dupW9] = await Promise.all([pj.wait('lobby:error'), pj2.wait('welcome')]);
      pj2.id = dupW9.id;
      assert(dupErr9.code === 'duplicate' && dupW9.lobby?.players.find((p) => p.id === pj2.id)?.inMission === false && dupW9.lobby.started,
        'duplicate socket (page reload) → the member is out of the mission (inMission false), mission still running', dupW9.lobby);
      assert(dupW9.lobby?.hostId === pj2.id, 'no connected in-mission member → the reloaded host keeps the role for now', dupW9.lobby);
      await pk.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pj2.id)?.inMission === false);
      pj = pj2;
      /* the old host returns inside the mission → takes the role from a host that is out of it */
      ({ c: pi } = await connect('I2', url2, { token: TI, name: 'Ivy' }));
      assert(pi.lobby?.hostId === pi.id && pi.lobby.players.find((p) => p.id === pi.id)?.inMission === true,
        'returning in-mission member takes the role from a host that left the mission', pi.lobby);
      await Promise.all([pj, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.hostId === pi.id)));
      pass('everyone sees the role move back inside the mission');
      /* the last in-mission member leaves by message → the raid is over → server reset */
      pi.send({ t: 'lobby:mission', inMission: false });
      const over = await Promise.all([pi, pj, pk].map((cl) => cl.wait('lobby:state', (m) => !m.lobby.started)));
      assert(over.every((m) => m.lobby.mode === undefined && m.lobby.hostId === pi.id && m.lobby.players.every((p) => !p.inMission)),
        'last in-mission member leaving a raid → server reset (raids end like trainings), host kept (connected)', over[0].lobby);
      /* host-away: a connected host that leaves the mission hands the role to a connected in-mission member */
      pi.flush(); pj.flush(); pk.flush();
      await readyAll([pi, pj, pk]);
      pi.send({ t: 'lobby:start', seed: 52 });
      await Promise.all([pi, pj, pk].map((cl) => cl.wait('game:start')));
      pi.flush(); pj.flush(); pk.flush(); // ready broadcasts still queued
      pi.send({ t: 'lobby:mission', inMission: false });
      const away = await Promise.all([pi, pj, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.started && m.lobby.players.find((p) => p.id === pi.id)?.inMission === false)));
      assert(away.every((m) => m.lobby.started && m.lobby.hostId === pj.id && m.lobby.players.find((p) => p.id === pj.id)?.isHost === true),
        'host reporting lobby:mission false mid-raid → role moves at once to the lowest-slot connected in-mission member', away[0].lobby);
      /* grace expiry of a parked host with nobody left inside → reset + hub migration */
      pk.send({ t: 'lobby:mission', inMission: false });
      await Promise.all([pi, pj, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pk.id)?.inMission === false)));
      pj.close(); await pj.closed();
      await Promise.all([pi, pk].map((cl) => cl.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === pj.id)?.connected === false)));
      assert(await pi.expectNone('lobby:state', MIG_MS + 400, (m) => m.t === 'lobby:state' && m.lobby.hostId !== pj.id), 'host parked again (hub members only)');
      const jGone = await Promise.all([pi, pk].map((cl) => cl.wait('peer:left', (m) => m.id === pj.id, 2_500 + 1_500)));
      assert(jGone.every((m) => !m.lobby.started && m.lobby.hostId === pi.id && m.lobby.players.length === 2),
        'parked host expiring with nobody inside → mission reset + ordinary hub migration', jGone[0].lobby);
      pi.close(); pk.close();
    } finally {
      await server2.close();
    }

    /* ══════════════════════════ part 7: profile store file round-trip ══════════════════════════ */
    const dir = mkdtempSync(join(tmpdir(), 'scav-store-'));
    try {
      const s1 = new ProfileStore({ dataDir: dir, saveDebounceMs: 20, quiet: true });
      assert(s1.get('p1').credits === null && s1.size === 1, 'store.get creates an empty record');
      s1.setDoc('p1', 'meta', { a: 1 });
      s1.setDoc('p1', 'stash', { b: 2 }, 1_000);
      assert(s1.setDoc('p1', 'stash', { b: 3 }, 999) === 'stale' && JSON.stringify(s1.get('p1').docs.stash) === '{"b":2}' && s1.get('p1').docsAt?.stash === 1_000,
        'store: stamped write keeps docsAt, an older stamp is stale', s1.get('p1'));
      assert(s1.setDoc('p1', 'meta', { a: 2 }, undefined, true) === 'stale' && JSON.stringify(s1.get('p1').docs.meta) === '{"a":1}', 'store: fresh write over an existing doc is stale');
      const tx = s1.applyCredits('p1', 300, 'migrate');
      assert(tx.ok && tx.credits === 300, 'store migrate seeds credits');
      assert(s1.applyCredits('p1', -301, 'buy').ok === false && s1.applyCredits('p1', -300, 'buy').credits === 0, 'store refuses overdraft, allows exact spend');
      s1.get('untouched');
      /* C-68: wait for the debounced write instead of sleeping past it, then 80 ms to catch a second one. */
      await waitFor(() => s1.writeCount >= 1);
      await sleep(80);
      assert(s1.writeCount === 1, 'debounced write happened once', s1.writeCount);
      s1.close();
      const s2 = new ProfileStore({ dataDir: dir, quiet: true });
      assert(s2.size === 1 && s2.get('p1').credits === 0 && JSON.stringify(s2.get('p1').docs.meta) === '{"a":1}' && !s2.has('untouched'),
        'a new store reloads the file: credits + docs kept, placeholder records not persisted', s2.get('p1'));
      assert(s2.get('p1').docsAt?.stash === 1_000 && s2.get('p1').docsAt?.meta === undefined, 'docsAt round-trips through the file (stamped keys only)', s2.get('p1').docsAt);
      // E-6: every accepted Phase 9 write bumped the rev (meta fresh 1, stash stamped 1; the stale ones did not)
      assert(s2.revOf('p1', 'meta') === 1 && s2.revOf('p1', 'stash') === 1, 'E-6: accepted Phase 9 writes carry docsRev through the file, refused ones did not bump it', s2.get('p1').docsRev);
      s2.close();
      /* corrupt / hostile docsAt is clamped on load: a far-future stamp, a stamp without a document */
      writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ v: 1, profiles: { p9: { credits: 1, docs: { meta: { z: 1 } }, updatedAt: 1, docsAt: { meta: 9e15, stash: 5, bogus: 3 } } } }), 'utf8');
      const s3 = new ProfileStore({ dataDir: dir, quiet: true });
      const at9 = s3.get('p9').docsAt;
      assert(at9 !== undefined && at9.meta !== undefined && at9.meta <= Date.now() + PROFILE_CLOCK_SKEW_MS && at9.stash === undefined && !('bogus' in at9),
        'sanitizeRecord clamps docsAt to now + PROFILE_CLOCK_SKEW_MS and drops stamps without a document', at9);
      s3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    /* ── part 7b (2026-09-11, C-41 · X-2): 비동기 쓰기 · .bak 세대 · 손상 파일 보존 + 복구 ── */
    const d7 = mkdtempSync(join(tmpdir(), 'scav-store-b-'));
    const d7e = mkdtempSync(join(tmpdir(), 'scav-store-c-'));
    try {
      const main7 = join(d7, PROFILE_FILE);
      const bak7 = `${main7}${PROFILE_BACKUP_SUFFIX}`;
      const creditsIn = (path: string): unknown => (JSON.parse(readFileSync(path, 'utf8')) as { profiles: Record<string, { credits: unknown }> }).profiles.q1?.credits;
      /** The debounced async write has started (it sets `writing` synchronously, before its first await). */
      const writeStarted = async (s: ProfileStore): Promise<boolean> => {
        for (const t0 = Date.now(); Date.now() - t0 < 2000;) {
          if ((s as unknown as { writing: unknown }).writing) return true;
          await new Promise<void>((r) => setImmediate(r));
        }
        return false;
      };

      const a7 = new ProfileStore({ dataDir: d7, saveDebounceMs: 5, quiet: true });
      a7.applyCredits('q1', 100, 'migrate');
      assert(await writeStarted(a7), 'C-41: the debounced write runs asynchronously (in flight after the timer)');
      a7.applyCredits('q1', 1, 'earn');                       // lands while the first write is in flight
      await a7.idle();
      assert(a7.writeCount === 2 && creditsIn(main7) === 101, 'C-41: a change during a write is written once more when it finishes', { writes: a7.writeCount, credits: creditsIn(main7) });
      assert(existsSync(bak7) && creditsIn(bak7) === 100, 'C-41: every write rotates the previous file into profiles.json.bak (one generation back)', existsSync(bak7) ? creditsIn(bak7) : 'no .bak');
      assert((JSON.parse(readFileSync(main7, 'utf8')) as { v?: unknown }).v === 1, 'C-41: the file format is unchanged ({v:1, profiles})');

      a7.applyCredits('q1', 1, 'earn');                       // 102 → async write starts
      assert(await writeStarted(a7), 'C-41: second async write in flight');
      a7.applyCredits('q1', 1, 'earn');                       // 103
      a7.close();                                              // synchronous — must win over the write in flight
      assert(creditsIn(main7) === 103, 'C-41: close() writes synchronously right away', creditsIn(main7));
      await a7.idle();
      assert(creditsIn(main7) === 103 && creditsIn(bak7) === 101, 'C-41: the aborted in-flight write never renames an older snapshot over close()', { main: creditsIn(main7), bak: creditsIn(bak7) });
      assert(readdirSync(d7).every((f) => f === PROFILE_FILE || f === `${PROFILE_FILE}${PROFILE_BACKUP_SUFFIX}`), 'C-41: no tmp file is left behind', readdirSync(d7));

      /* X-2 ① 망가진 profiles.json + 쓸 만한 .bak → 원본은 corrupt-<시각> 으로 보존, .bak 에서 복구, 곧 새 main */
      const garbage = '{"v":1,"profiles":{ half-written';
      writeFileSync(main7, garbage, 'utf8');
      const b7 = new ProfileStore({ dataDir: d7, saveDebounceMs: 5, quiet: true });
      const kept = readdirSync(d7).filter((f) => /^profiles\.corrupt-.+\.json$/.test(f));
      assert(b7.loadResult.note === 'corrupt-recovered' && b7.get('q1').credits === 101, 'X-2: an unreadable profiles.json is recovered from .bak (not started empty)', { load: b7.loadResult, credits: b7.get('q1').credits });
      assert(kept.length === 1 && readFileSync(join(d7, kept[0] ?? ''), 'utf8') === garbage && b7.loadResult.corruptPath?.endsWith(kept[0] ?? '?') === true,
        'X-2: the unreadable original is preserved byte for byte as profiles.corrupt-<ts>.json', kept);
      await sleep(40);
      await b7.idle();
      assert(existsSync(main7) && creditsIn(main7) === 101, 'X-2: a recovered store writes a healthy profiles.json back on its own', existsSync(main7));
      b7.close();

      /* X-2 ② flush 의 두 rename 사이에서 죽었다(= main 없음, .bak 만) → .bak 이 최신이다 */
      renameSync(main7, bak7);
      const c7 = new ProfileStore({ dataDir: d7, quiet: true });
      assert(c7.loadResult.note === 'bak-recovered' && c7.get('q1').credits === 101, 'X-2: a missing profiles.json with a .bak loads the .bak', c7.loadResult);
      c7.close();

      /* X-2 ③ 망가진 파일 + .bak 없음 → 빈 DB 로 시작하되 원본은 남고, 첫 쓰기가 그것을 덮지 않는다 */
      const mainE = join(d7e, PROFILE_FILE);
      writeFileSync(mainE, 'not json at all', 'utf8');
      const e7 = new ProfileStore({ dataDir: d7e, quiet: true });
      const keptE = readdirSync(d7e).filter((f) => /^profiles\.corrupt-.+\.json$/.test(f));
      assert(e7.loadResult.note === 'corrupt-empty' && e7.size === 0 && keptE.length === 1, 'X-2: unreadable with no .bak → starts empty but moves the original aside', { load: e7.loadResult, files: readdirSync(d7e) });
      e7.applyCredits('z', 5, 'migrate');
      e7.close();
      assert(readFileSync(join(d7e, keptE[0] ?? ''), 'utf8') === 'not json at all' && existsSync(mainE),
        'X-2: the first write of the empty store leaves the preserved original untouched', readdirSync(d7e));
    } finally {
      rmSync(d7, { recursive: true, force: true });
      rmSync(d7e, { recursive: true, force: true });
    }

    /* ══════════════════════════ part 8: Phase 11 — 행성 + 소셜 ══════════════════════════ */
    const T81 = makeToken('1'), T82 = makeToken('2'), T83 = makeToken('3'), T84 = makeToken('4');
    let { c: p8a, welcome: w8a } = await connect('P1', url, { token: T81, name: 'Uno' });
    const { c: p8b } = await connect('P2', url, { token: T82, name: 'Duo' });
    const { c: p8c } = await connect('P3', url, { token: T83, name: 'Tres' });
    let se: Extract<ServerToClient, { t: 'social:error' }>;
    let sn: Extract<ServerToClient, { t: 'social:state' }>;

    /* ── 아이디 assignment + welcome.social ── */
    const code1: PlayerCode = w8a.social?.me.code ?? '';
    const codes = await Promise.all([p8b, p8c].map(async (cl) => { cl.send({ t: 'social:get' }); return (await cl.wait('social:state')).social.me.code; }));
    const codeB: PlayerCode = codes[0], codeC: PlayerCode = codes[1];
    assert(w8a.social !== undefined && isValidPlayerCode(code1) && code1 === playerCodeFrom(peerIdFromToken(T81)),
      'token connect → welcome.social with the 아이디 derived from the PeerId', w8a.social?.me);
    assert(w8a.social?.me.name === 'Uno' && w8a.social?.me.level === 0 && w8a.social.friends.length === 0
      && w8a.social.incoming.length === 0 && w8a.social.outgoing.length === 0 && w8a.social.recent.length === 0,
      'a fresh social record: name from ?n=, level 0, empty lists', w8a.social);
    assert(new Set([code1, codeB, codeC]).size === 3 && isValidPlayerCode(codeB) && isValidPlayerCode(codeC), 'every profile has its own valid 아이디', [code1, codeB, codeC]);
    const { c: p8anon, welcome: w8anon } = await connect('P-ANON', url);
    assert(w8anon.social === undefined && w8anon.profile === undefined, 'anonymous connect → no profile and no social in welcome');
    p8anon.send({ t: 'social:get' });
    se = await p8anon.wait('social:error');
    assert(se.code === 'unavailable' && se.message === SOCIAL_ERROR_MESSAGE_KO.unavailable, 'social:get from an anonymous socket → social:error unavailable (Korean message)', se);
    p8anon.send({ t: 'social:whisper', code: code1, text: 'hi' });
    se = await p8anon.wait('social:error');
    assert(se.code === 'unavailable', 'every social request from an anonymous socket → unavailable');
    p8anon.close(); await p8anon.closed();

    /* ── social:me ── */
    p8a.send({ t: 'social:me', level: 12 });
    sn = await p8a.wait('social:state', (mm) => mm.social.me.level === 12);
    assert(sn.social.me.code === code1, 'social:me {level} → social:state with the level stored');
    p8a.send({ t: 'social:me', level: -4 });
    sn = await p8a.wait('social:state');
    assert(sn.social.me.level === 0, 'a negative level is clamped to 0', sn.social.me);
    p8a.send({ t: 'social:me', level: 4000 });
    sn = await p8a.wait('social:state');
    assert(sn.social.me.level === SOCIAL_LEVEL_MAX, `a level above the cap is clamped to ${SOCIAL_LEVEL_MAX}`, sn.social.me);
    p8a.send({ t: 'social:me', level: 12 });
    await p8a.wait('social:state', (mm) => mm.social.me.level === 12);
    p8a.sendRaw(JSON.stringify({ t: 'social:me', level: 'high' }));
    err = await p8a.wait('lobby:error');
    assert(err.code === 'invalid', 'social:me with a non-numeric level → lobby:error invalid');

    /* ── friend requests ── */
    p8a.send({ t: 'social:request', code: code1 });
    se = await p8a.wait('social:error');
    assert(se.code === 'self', 'a friend request to my own 아이디 → self');
    p8a.send({ t: 'social:request', code: 'ZZZZZZZZ' });
    se = await p8a.wait('social:error');
    assert(se.code === 'not_found', 'a friend request to an unassigned 아이디 → not_found');
    p8a.send({ t: 'social:request', code: 'ab-cd' });
    se = await p8a.wait('social:error');
    assert(se.code === 'not_found', 'a malformed 아이디 (too short) → not_found, never an exception');
    p8a.sendRaw(JSON.stringify({ t: 'social:request', code: 'X'.repeat(64) }));
    err = await p8a.wait('lobby:error');
    assert(err.code === 'invalid', 'an oversized 아이디 field is refused by the parser → invalid');
    /* dashed / lower-case input is what a player actually types */
    p8a.send({ t: 'social:request', code: `${codeB.slice(0, 4).toLowerCase()}-${codeB.slice(4)}` });
    const [reqA, reqB] = await Promise.all([
      p8a.wait('social:state', (mm) => mm.social.outgoing.length === 1),
      p8b.wait('social:state', (mm) => mm.social.incoming.length === 1),
    ]);
    assert(reqA.social.outgoing[0].code === codeB && reqA.social.outgoing[0].name === 'Duo'
      && reqA.social.outgoing[0].presence === 'ship' && reqA.social.outgoing[0].squad === 0 && reqA.social.outgoing[0].joinable === true,
      'friend request (dashed / lower-case) → the sender sees it in outgoing, resolved with presence', reqA.social.outgoing[0]);
    assert(reqB.social.incoming[0].code === code1 && reqB.social.incoming[0].level === 12 && reqB.social.friends.length === 0,
      'the target sees it in incoming with my level', reqB.social.incoming[0]);
    assert(JSON.stringify(reqB.social).indexOf(p8a.id) < 0, 'a snapshot never contains another player PeerId (아이디 only)');
    p8a.send({ t: 'social:request', code: codeB });
    se = await p8a.wait('social:error');
    assert(se.code === 'already', 'a second identical request → already');
    p8b.send({ t: 'social:request', code: code1 });
    se = await p8b.wait('social:error');
    assert(se.code === 'already', 'a request in the opposite direction of a pending one → already');
    p8b.send({ t: 'social:respond', code: code1, accept: false });
    const [decA, decB] = await Promise.all([
      p8a.wait('social:state', (mm) => mm.social.outgoing.length === 0),
      p8b.wait('social:state', (mm) => mm.social.incoming.length === 0),
    ]);
    assert(decA.social.friends.length === 0 && decB.social.friends.length === 0, 'declining drops the request on both sides without befriending');
    p8b.send({ t: 'social:respond', code: code1, accept: true });
    se = await p8b.wait('social:error');
    assert(se.code === 'invalid', 'responding to a request that is not in incoming → invalid');
    p8a.send({ t: 'social:request', code: codeB });
    await Promise.all([p8a.wait('social:state', (mm) => mm.social.outgoing.length === 1), p8b.wait('social:state', (mm) => mm.social.incoming.length === 1)]);
    p8b.send({ t: 'social:respond', code: code1, accept: true });
    const [okA, okB] = await Promise.all([
      p8a.wait('social:state', (mm) => mm.social.friends.length === 1),
      p8b.wait('social:state', (mm) => mm.social.friends.length === 1),
    ]);
    assert(okA.social.friends[0].code === codeB && okA.social.outgoing.length === 0
      && okB.social.friends[0].code === code1 && okB.social.incoming.length === 0,
      'accepting → mutual friends, the request cleared on both sides', { a: okA.social.friends, b: okB.social.friends });

    /* ── presence pushed outside a lobby (the watcher index, not polling) ── */
    p8a.send({ t: 'lobby:create', name: 'Uno' });
    st = await p8a.wait('lobby:state');
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.squad === 1);
    assert(sn.social.friends[0].presence === 'ship' && sn.social.friends[0].joinable === true,
      'a friend in no lobby of mine is still pushed my new squad size', sn.social.friends[0]);
    p8a.send({ t: 'lobby:leave' });
    await p8a.wait('lobby:left');
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.squad === 0);
    assert(sn.social.friends[0].presence === 'ship', 'leaving the ship is pushed to the friend as squad 0', sn.social.friends[0]);
    p8a.close(); await p8a.closed();
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.presence === 'offline');
    assert(sn.social.friends[0].joinable === false, 'a dropped friend reads offline at once (the reconnect grace does not count as online)', sn.social.friends[0]);
    ({ c: p8a, welcome: w8a } = await connect('P1b', url, { token: T81, name: 'Uno' }));
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.presence === 'ship');
    assert(w8a.social?.friends[0]?.code === codeB && w8a.social.me.level === 12,
      'welcome.social carries the friends list and the stored level across a reconnect', w8a.social);
    assert(sn.social.friends[0].squad === 0, 'a friend coming back online is pushed as ship / squad 0', sn.social.friends[0]);

    /* ── 최근 만난 플레이어 ── */
    p8a.send({ t: 'lobby:create', name: 'Uno' });
    st = await p8a.wait('lobby:state');
    const code8A = st.lobby.code;
    p8c.send({ t: 'lobby:join', code: code8A, name: 'Tres' });
    await Promise.all([p8a.wait('lobby:state', (mm) => mm.lobby.players.length === 2), p8c.wait('lobby:state')]);
    const [recA, recC] = await Promise.all([
      p8a.wait('social:state', (mm) => mm.social.recent.length === 1),
      p8c.wait('social:state', (mm) => mm.social.recent.length === 1),
    ]);
    assert(recA.social.recent[0].code === codeC && (recA.social.recent[0].at ?? 0) > 0 && recA.social.recent[0].squad === 2,
      'sharing a ship records 최근 만난 플레이어 with a timestamp', recA.social.recent[0]);
    assert(recC.social.recent[0].code === code1 && recC.social.friends.length === 0, 'the other side got the same entry (and is not a friend)', recC.social.recent[0]);
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.squad === 2);
    assert(sn.social.recent.length === 0, 'a friend of a member gets the presence push but no 최근 만난 플레이어 entry', sn.social);
    p8a.send({ t: 'social:request', code: codeC });
    await Promise.all([p8a.wait('social:state', (mm) => mm.social.outgoing.length === 1), p8c.wait('social:state', (mm) => mm.social.incoming.length === 1)]);
    p8c.send({ t: 'social:respond', code: code1, accept: true });
    const [fa, fc] = await Promise.all([
      p8a.wait('social:state', (mm) => mm.social.friends.length === 2),
      p8c.wait('social:state', (mm) => mm.social.friends.length === 1),
    ]);
    assert(fa.social.recent.length === 0 && fc.social.recent.length === 0, 'becoming friends drops the 최근 만난 플레이어 entry on both sides', { a: fa.social.recent, c: fc.social.recent });

    /* ── 목표 행성 ── */
    p8c.send({ t: 'lobby:planet', planet: 'ashen' });
    err = await p8c.wait('lobby:error');
    assert(err.code === 'not_host', 'lobby:planet from a non-host → not_host');
    p8a.sendRaw(JSON.stringify({ t: 'lobby:planet', planet: 'atlantis' }));
    err = await p8a.wait('lobby:error');
    assert(err.code === 'invalid', 'lobby:planet with an unknown planet id → invalid (never thrown)');
    for (const cl of [p8a, p8c]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.every((p) => p.ready))));
    p8a.send({ t: 'lobby:start', seed: 811 });
    err = await p8a.wait('lobby:error');
    assert(err.code === 'no_planet' && /행성/.test(err.message), 'a raid start with no 목표 행성 → no_planet (Korean message)', err);
    p8a.send({ t: 'lobby:start', seed: 811, mode: 'training' });
    const t8 = await Promise.all([p8a, p8c].map((cl) => cl.wait('game:start')));
    assert(t8.every((mm) => mm.mode === 'training' && mm.planet === undefined && mm.lobby.planet === undefined),
      'a training starts without a planet and carries none', t8[0]);
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.presence === 'training');
    assert(sn.social.friends[0].joinable === false, '훈련장 presence reaches the friend and blocks 같이 하기', sn.social.friends[0]);
    p8a.send({ t: 'lobby:reset' });
    await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => !mm.lobby.started)));
    await pickPlanet(p8a, 'mossy', [p8c]);
    p8a.flush(); p8c.flush();
    p8a.send({ t: 'lobby:planet', planet: 'mossy' });
    st = await p8a.wait('lobby:state');
    assert(st.lobby.planet === 'mossy', 'picking the planet that is already selected → state echo to the sender', st.lobby);
    assert(await p8c.expectNone('lobby:state', 200), 'a no-op planet pick is not broadcast to the squad');
    for (const cl of [p8a, p8c]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.every((p) => p.ready))));
    p8a.send({ t: 'lobby:start', seed: 812 });
    const r8 = await Promise.all([p8a, p8c].map((cl) => cl.wait('game:start')));
    assert(r8.every((mm) => mm.mode === 'raid' && mm.planet === 'mossy' && mm.lobby.planet === 'mossy'),
      'a raid start uses the lobby planet → game:start {planet} for every member', r8[0]);
    sn = await p8b.wait('social:state', (mm) => mm.social.friends[0]?.presence === 'raid');
    assert(sn.social.friends[0].joinable === false, '임무 중 presence reaches the friend and blocks 같이 하기', sn.social.friends[0]);
    p8a.send({ t: 'lobby:reset' });
    const rs8 = await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => !mm.lobby.started)));
    assert(rs8.every((mm) => mm.lobby.planet === 'mossy' && mm.lobby.seed === null),
      'lobby:reset keeps the 목표 행성 (the destination outlives the mission)', rs8[0].lobby);
    p8a.send({ t: 'lobby:start', seed: 813, planet: 'crimson' });
    err = await p8a.wait('lobby:error');
    assert(err.code === 'not_ready', 'the ready gating still comes before the planet gate');
    for (const cl of [p8a, p8c]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.every((p) => p.ready))));
    p8a.send({ t: 'lobby:start', seed: 813, planet: 'crimson' });
    const r8b = await Promise.all([p8a, p8c].map((cl) => cl.wait('game:start')));
    assert(r8b.every((mm) => mm.planet === 'crimson' && mm.lobby.planet === 'crimson'), 'lobby:start {planet} overrides the stored destination', r8b[0]);
    p8a.send({ t: 'lobby:planet', planet: 'amber' });
    err = await p8a.wait('lobby:error');
    assert(err.code === 'started', 'lobby:planet while the mission runs → started');
    p8b.send({ t: 'social:play', code: code1 });
    se = await p8b.wait('social:error');
    assert(se.code === 'in_mission', '같이 하기 with someone inside a running raid → in_mission');
    p8a.send({ t: 'lobby:reset' });
    await Promise.all([p8a, p8c].map((cl) => cl.wait('lobby:state', (mm) => !mm.lobby.started)));

    /* ── 같이 하기 (social:play): the server picks the branch ── */
    p8b.send({ t: 'social:play', code: codeB });
    se = await p8b.wait('social:error');
    assert(se.code === 'self', '같이 하기 with my own 아이디 → self');
    p8b.send({ t: 'social:play', code: code1 });
    const [played, joinedState] = await Promise.all([p8b.wait('social:play'), p8a.wait('lobby:state', (mm) => mm.lobby.players.length === 3)]);
    assert(played.outcome === 'joined' && played.code === code1 && played.name === 'Uno', '같이 하기 with a squadded friend → outcome joined', played);
    assert(joinedState.lobby.players.some((p) => p.id === p8b.id) && p8b.lobby?.code === code8A && p8b.lobby?.planet === 'crimson',
      'the caller is added to the target ship (both sides get lobby:state, planet included)', joinedState.lobby);
    p8b.send({ t: 'social:play', code: code1 });
    se = await p8b.wait('social:error');
    assert(se.code === 'in_squad', '같이 하기 with someone already in my ship → in_squad');
    const { c: p8d } = await connect('P4', url, { token: T84, name: 'Quad' });
    p8d.send({ t: 'social:get' });
    const codeD: PlayerCode = (await p8d.wait('social:state')).social.me.code;
    p8d.send({ t: 'lobby:create', name: 'Quad' });
    await p8d.wait('lobby:state');
    p8b.send({ t: 'social:play', code: codeD });
    se = await p8b.wait('social:error');
    assert(se.code === 'busy', '같이 하기 while other members are in my ship → busy (disband or invite instead)');
    p8b.send({ t: 'lobby:leave' });
    await p8b.wait('lobby:left');
    p8d.send({ t: 'lobby:leave' });
    await p8d.wait('lobby:left');
    p8b.flush();
    p8b.send({ t: 'social:play', code: codeD });
    const [invited, invite] = await Promise.all([p8b.wait('social:play'), p8d.wait('social:invited')]);
    const myShip = await p8b.wait('lobby:state', (mm) => mm.lobby.players.length === 1);
    assert(invited.outcome === 'invited' && invited.code === codeD, '같이 하기 with a friend who has no ship → outcome invited', invited);
    assert(invite.invite.from === codeB && invite.invite.name === 'Duo' && invite.invite.lobby === myShip.lobby.code && invite.invite.at > 0,
      'the invite carries my 아이디 / name and the lobby code to join, and my ship was created for it', invite.invite);
    p8d.close(); await p8d.closed(); await sleep(80);
    p8b.send({ t: 'social:play', code: codeD });
    se = await p8b.wait('social:error');
    assert(se.code === 'offline', '같이 하기 with a profile that is not connected → offline');
    /* ② from a ship of my own: alone in it, so it is left behind and I dock into theirs */
    /* 2026-09-11 (B-6): the leave is now a server move — `lobby:left {reason:'moved', to}` → new `lobby:state` → `social:play joined`. */
    const order8: string[] = [];
    const leftOwnP = p8b.wait('lobby:left').then((mm) => { order8.push('left'); return mm; });
    const stateP = p8b.wait('lobby:state', (mm) => mm.lobby.code === code8A).then((mm) => { order8.push('state'); return mm; });
    const joinedP = p8b.wait('social:play').then((mm) => { order8.push('play'); return mm; });
    p8b.send({ t: 'social:play', code: code1 });
    const [leftOwn, , joined2] = await Promise.all([leftOwnP, stateP, joinedP]);
    assert(leftOwn.reason === 'moved' && leftOwn.to === code8A && joined2.outcome === 'joined' && p8b.lobby?.code === code8A,
      '같이 하기 from a ship where I am alone → lobby:left {reason:moved, to} and I dock into theirs', { leftOwn, lobby: p8b.lobby?.code });
    assert(order8.join(',') === 'left,state,play', 'the move reads lobby:left moved → lobby:state (new ship) → social:play joined', order8);
    p8b.send({ t: 'lobby:leave' });
    await p8b.wait('lobby:left');

    /* ── 귓속말 ── */
    p8a.send({ t: 'social:whisper', code: codeB, text: '  안녕 <b>친구</b>  ' });
    const wh = await p8b.wait('social:whisper');
    assert(wh.code === code1 && wh.name === 'Uno' && wh.text === '안녕 b친구/b' && wh.at > 0,
      'a whisper reaches the target with the sender 아이디 / name, trimmed and with markup stripped', wh);
    p8a.send({ t: 'social:whisper', code: codeB, text: '   ' });
    se = await p8a.wait('social:error');
    assert(se.code === 'invalid', 'an empty / whitespace whisper → invalid');
    p8a.send({ t: 'social:whisper', code: codeB, text: 'y'.repeat(SOCIAL_WHISPER_MAX + 50) });
    const whLong = await p8b.wait('social:whisper');
    assert(whLong.text.length === SOCIAL_WHISPER_MAX, `a whisper is truncated to SOCIAL_WHISPER_MAX (${SOCIAL_WHISPER_MAX})`, whLong.text.length);
    p8a.sendRaw(JSON.stringify({ t: 'social:whisper', code: codeB, text: 'z'.repeat(4 * SOCIAL_WHISPER_MAX + 10) }));
    err = await p8a.wait('lobby:error');
    assert(err.code === 'invalid', 'a whisper frame far over the input cap is refused by the parser');
    p8a.send({ t: 'social:whisper', code: 'ZZZZZZZZ', text: 'hello' });
    se = await p8a.wait('social:error');
    assert(se.code === 'not_found', 'a whisper to an unknown 아이디 → not_found');
    p8c.close(); await p8c.closed(); await sleep(80);
    p8a.send({ t: 'social:whisper', code: codeC, text: 'hello' });
    se = await p8a.wait('social:error');
    assert(se.code === 'offline', 'a whisper to a profile that is not connected → offline');

    /* ── 친구 삭제 tears the push channel down ── */
    p8b.send({ t: 'social:remove', code: code1 });
    const [remB, remA] = await Promise.all([
      p8b.wait('social:state', (mm) => mm.social.friends.length === 0),
      p8a.wait('social:state', (mm) => !mm.social.friends.some((f) => f.code === codeB)),
    ]);
    assert(remB.social.friends.length === 0 && remA.social.friends.length === 1, 'social:remove is mutual and pushed to both sides', { b: remB.social.friends, a: remA.social.friends });
    p8b.send({ t: 'social:remove', code: code1 });
    se = await p8b.wait('social:error');
    assert(se.code === 'invalid', 'removing someone who is not a friend → invalid');
    p8a.send({ t: 'lobby:leave' });
    await p8a.wait('lobby:left');
    await sleep(400);   // B-5: let the coalesced pushes of the leave land (P2 still watches P3 through its recent list)
    p8b.flush();
    /* a change that concerns P1 alone (its level) is pushed only to whoever still has P1 in a list */
    p8a.send({ t: 'social:me', level: 13 });
    await p8a.wait('social:state', (mm) => mm.social.me.level === 13);
    assert(await p8b.expectNone('social:state', 450), 'after 친구 삭제 no presence push reaches the ex-friend (watcher index cleaned)');

    /* ── store level: caps, index, sanitisation ── */
    const s8 = new ProfileStore({ dataDir: null, quiet: true });
    const soc8 = s8.ensureSocial('peer-one', 'One');
    assert(isValidPlayerCode(soc8.code) && soc8.code === playerCodeFrom('peer-one') && soc8.salt === 0 && s8.peerByCode(soc8.code) === 'peer-one',
      'store.ensureSocial assigns the derived 아이디 and indexes it', soc8);
    assert(s8.ensureSocial('peer-one', 'One') === soc8 && s8.getIfExists('nobody') === undefined,
      'ensureSocial is idempotent and getIfExists never creates a record');
    assert(s8.peerByCode('ZZZZZZZZ') === undefined && s8.peerByCode('nope') === undefined, 'peerByCode: an unknown / malformed 아이디 → undefined');
    for (let n = 0; n < SOCIAL_RECENT_MAX + 3; n++) {
      s8.ensureSocial(`peer-met-${n}`, `Met${n}`);
      s8.recordMet('peer-one', `peer-met-${n}`, 1_000 + n);
    }
    const rec8 = s8.social('peer-one')?.recent ?? [];
    assert(rec8.length === SOCIAL_RECENT_MAX && rec8[0].code === s8.social(`peer-met-${SOCIAL_RECENT_MAX + 2}`)?.code
      && rec8[0].at === 1_000 + SOCIAL_RECENT_MAX + 2 && !rec8.some((r) => r.code === s8.social('peer-met-0')?.code),
      `최근 만난 플레이어 is capped at SOCIAL_RECENT_MAX (${SOCIAL_RECENT_MAX}), newest first, oldest dropped`, rec8.length);
    s8.recordMet('peer-one', 'peer-met-5', 9_999);
    const rec8b = s8.social('peer-one')?.recent ?? [];
    assert(rec8b[0].code === s8.social('peer-met-5')?.code && rec8b.length === SOCIAL_RECENT_MAX
      && rec8b.filter((r) => r.code === rec8b[0].code).length === 1, 'meeting the same player again moves the entry to the front (no duplicate)');
    assert(s8.addFriendRequest('peer-one', 'peer-one') === 'self', 'store: a request to myself → self');
    assert(s8.addFriendRequest('peer-one', 'peer-met-1') === 'ok' && s8.addFriendRequest('peer-one', 'peer-met-1') === 'already', 'store: a duplicate request → already');
    assert(s8.respondFriendRequest('peer-met-1', 'peer-one', true) === 'ok'
      && (s8.social('peer-one')?.friends ?? []).includes(s8.social('peer-met-1')?.code ?? '')
      && !(s8.social('peer-one')?.recent ?? []).some((r) => r.code === s8.social('peer-met-1')?.code),
      'store: accepting befriends both sides and clears the recent entry');
    assert(s8.removeFriend('peer-one', 'peer-met-1') === 'ok' && (s8.social('peer-met-1')?.friends.length ?? -1) === 0
      && s8.removeFriend('peer-one', 'peer-met-1') === 'invalid', 'store: removal is mutual; a second removal → invalid');
    const filler = s8.social('peer-one');
    if (filler) while (filler.friends.length < SOCIAL_FRIEND_MAX) filler.friends.push(playerCodeFrom(`filler-${filler.friends.length}`));
    assert(s8.addFriendRequest('peer-one', 'peer-met-2') === 'limit', `store: a request past SOCIAL_FRIEND_MAX (${SOCIAL_FRIEND_MAX}) → limit`);
    s8.close();

    const dir8 = mkdtempSync(join(tmpdir(), 'scav-social-'));
    try {
      /* p-own squats the 아이디 p-clone would derive, and p-clone's stored code is unusable → re-derive with a salt. */
      const squatted = playerCodeFrom('p-clone');
      writeFileSync(join(dir8, PROFILE_FILE), JSON.stringify({ v: 1, profiles: {
        'p-own': { credits: 0, docs: {}, updatedAt: 5, social: {
          code: squatted, salt: 0, name: 'Own<b>', level: 5.7,
          friends: ['AAAABBBB', 'AAAABBBB', squatted, 'bogus!', 'CCCCDDDD'],
          incoming: ['CCCCDDDD'], outgoing: ['nope'],
          recent: [{ code: 'AAAABBBB', at: 7 }, { code: 'EEEEFFFF', at: -3 }, { code: 'zz', at: 1 }], updatedAt: 5,
        } },
        'p-clone': { credits: 0, docs: {}, updatedAt: 5, social: { code: 'nope', salt: 0, name: 'Clone', level: 0, friends: [], incoming: [], outgoing: [], recent: [], updatedAt: 5 } },
        'p-bad': { credits: 0, docs: {}, updatedAt: 5, social: 42 },
      } }), 'utf8');
      const s9 = new ProfileStore({ dataDir: dir8, quiet: true });
      const own = s9.social('p-own');
      assert(own?.friends.length === 2 && own.friends.includes('AAAABBBB') && own.friends.includes('CCCCDDDD'),
        'sanitizeSocial: duplicates, my own 아이디 and malformed codes are dropped from friends', own?.friends);
      assert(own?.incoming.length === 0 && own.outgoing.length === 0,
        'sanitizeSocial: a friend cannot also sit in incoming, and a malformed outgoing code goes', { i: own?.incoming, o: own?.outgoing });
      assert(own?.recent.length === 1 && own.recent[0].code === 'EEEEFFFF' && own.recent[0].at === 0,
        'sanitizeSocial: recent drops friends / malformed codes and clamps a negative timestamp', own?.recent);
      assert(own?.name === 'Ownb' && own.level === 5, 'sanitizeSocial: the name is sanitized and the level floored', { name: own?.name, level: own?.level });
      assert(s9.social('p-bad') === undefined && s9.getIfExists('p-bad') !== undefined, 'sanitizeSocial: a non-object social field is dropped, the profile itself kept');
      assert(s9.peerByCode(squatted) === 'p-own', 'the 아이디 → PeerId index is rebuilt from the file');
      const clone = s9.social('p-clone');
      assert(clone !== undefined && isValidPlayerCode(clone.code) && clone.code !== squatted && clone.salt === 1
        && clone.code === playerCodeFrom('p-clone', 1) && s9.peerByCode(clone.code) === 'p-clone',
        'a colliding 아이디 is re-derived with the next salt and re-indexed', clone);
      s9.close();
      /* the assigned 아이디 and the friends list survive a store restart */
      const s10 = new ProfileStore({ dataDir: dir8, quiet: true });
      assert(s10.peerByCode(squatted) === 'p-own' && (s10.social('p-own')?.friends.length ?? 0) === 2,
        'a social record round-trips through profiles.json (아이디 + friends)', s10.social('p-own'));
      s10.close();
    } finally {
      rmSync(dir8, { recursive: true, force: true });
    }

    /* ── part 8b (2026-09-11, B-2): 프로필 GC — 비활성 프로필 삭제 · 끊긴 아이디 · 최근 목록 / 친구 요청 만료 ── */
    {
      const DAY = 24 * 60 * 60_000;
      const T = Date.now();
      const g = new ProfileStore({ dataDir: null, quiet: true });
      for (const id of ['gc-old', 'gc-fresh', 'gc-kept', 'gc-friend']) g.ensureSocial(id, id);
      const oldCode = g.social('gc-old')!.code;
      g.addFriendRequest('gc-friend', 'gc-old');
      g.respondFriendRequest('gc-old', 'gc-friend', true);
      g.recordMet('gc-fresh', 'gc-old', T);
      g.addFriendRequest('gc-kept', 'gc-old');
      g.touchSeen('gc-old', T - PROFILE_GC_INACTIVE_MS - DAY);
      g.touchSeen('gc-fresh', T - PROFILE_GC_INACTIVE_MS + DAY);
      g.touchSeen('gc-kept', T - 2 * PROFILE_GC_INACTIVE_MS);
      g.touchSeen('gc-friend', T);
      const r1 = g.collectGarbage((id) => id === 'gc-kept', T);
      assert(r1.removed.length === 1 && r1.removed[0] === 'gc-old' && g.getIfExists('gc-old') === undefined && g.peerByCode(oldCode) === undefined,
        `gc: a profile unseen for more than ${PROFILE_GC_INACTIVE_MS / DAY} days is deleted and its 아이디 leaves the index`, r1);
      assert(g.getIfExists('gc-fresh') !== undefined && g.getIfExists('gc-kept') !== undefined,
        'gc: a profile inside the window stays, and keep() protects an older one (connected / lobby member)');
      assert(!(g.social('gc-friend')?.friends ?? []).includes(oldCode) && !(g.social('gc-fresh')?.recent ?? []).some((r) => r.code === oldCode)
        && !(g.social('gc-kept')?.outgoing ?? []).includes(oldCode) && g.social('gc-kept')?.requestsAt === undefined
        && r1.danglingRefs === 3 && ['gc-friend', 'gc-fresh', 'gc-kept'].every((id) => r1.changed.includes(id)),
        'gc: the deleted 아이디 is dropped from friends / recent / outgoing (+ its request stamp) and the owners are reported', r1);
      const again = g.ensureSocial('gc-old', 'gc-old');
      assert(again.code === oldCode && again.friends.length === 0 && !(g.social('gc-friend')?.friends ?? []).includes(oldCode),
        'gc: the same token coming back starts a new profile (same derived 아이디, no stale friendship)', again);
      const r1b = g.collectGarbage((id) => id === 'gc-kept', T);
      assert(r1b.removed.length === 0 && r1b.changed.length === 0 && r1b.danglingRefs === 0,
        'gc: a second pass at the same time changes nothing (idempotent)', r1b);
      assert(!('seenAt' in g.snapshot('gc-friend')), 'gc: seenAt is server-internal (not in the wire snapshot)');
      g.close();

      /* expiry: requests (both halves at once) and 최근 만난 플레이어 */
      const e = new ProfileStore({ dataDir: null, quiet: true });
      for (const id of ['ex-a', 'ex-b', 'ex-c']) { e.ensureSocial(id, id); e.touchSeen(id, T); }
      e.addFriendRequest('ex-a', 'ex-b');
      const reqAt = e.social('ex-a')?.requestsAt?.[e.social('ex-b')!.code];
      assert(typeof reqAt === 'number' && reqAt === e.social('ex-b')?.requestsAt?.[e.social('ex-a')!.code],
        'a friend request is stamped with the same time on both records', { a: e.social('ex-a')?.requestsAt, b: e.social('ex-b')?.requestsAt });
      e.recordMet('ex-a', 'ex-c', T - DAY);
      e.recordMet('ex-b', 'ex-c', T + 10 * DAY);
      const r2 = e.collectGarbage(() => false, T + SOCIAL_REQUEST_TTL_MS + 2 * DAY);
      assert(r2.removed.length === 0 && e.social('ex-a')?.outgoing.length === 0 && e.social('ex-b')?.incoming.length === 0
        && e.social('ex-a')?.requestsAt === undefined && r2.expiredRequests === 2,
        `gc: a request unanswered for more than ${SOCIAL_REQUEST_TTL_MS / DAY} days is withdrawn on both sides`, r2);
      assert(r2.expiredRecent === 2 && !(e.social('ex-a')?.recent ?? []).length
        && (e.social('ex-c')?.recent ?? []).length === 1 && e.social('ex-c')?.recent[0].code === e.social('ex-b')?.code,
        `gc: 최근 만난 플레이어 older than ${SOCIAL_RECENT_TTL_MS / DAY} days go (both sides), newer ones stay`, { r2, c: e.social('ex-c')?.recent });
      e.addFriendRequest('ex-b', 'ex-a');
      e.respondFriendRequest('ex-a', 'ex-b', true);
      assert(e.social('ex-a')?.requestsAt?.[e.social('ex-b')!.code] === undefined && e.social('ex-b')?.requestsAt?.[e.social('ex-a')!.code] === undefined,
        'answering a request removes its stamp on both records');
      e.close();

      /* legacy records (no seenAt / requestsAt) + file round trip */
      const dirG = mkdtempSync(join(tmpdir(), 'scav-gc-'));
      try {
        const legacy = (code: string, at: number, incoming: string[] = []) => ({
          credits: 0, docs: { meta: {} }, updatedAt: at,
          social: { code, salt: 0, name: code, level: 1, friends: [], incoming, outgoing: [], recent: [], updatedAt: at },
        });
        writeFileSync(join(dirG, PROFILE_FILE), JSON.stringify({ v: 1, profiles: {
          'lg-gone': legacy('GGGGNNNN', T - PROFILE_GC_INACTIVE_MS - DAY),
          'lg-idle': legacy('DDDDLLLL', T - 10 * DAY, ['GGGGNNNN']),
          'lg-future': { ...legacy('FUTUREAA', T), seenAt: T + 365 * DAY },
        } }), 'utf8');
        const l1 = new ProfileStore({ dataDir: dirG, saveDebounceMs: 5, quiet: true });
        const stamped = l1.social('lg-idle')?.requestsAt?.GGGGNNNN;
        assert(typeof stamped === 'number' && stamped >= T && stamped <= Date.now(),
          'a legacy pending request is stamped when the store loads it (expires 30 days after the upgrade, not at once)', l1.social('lg-idle'));
        assert((l1.getIfExists('lg-future')?.seenAt ?? Infinity) <= Date.now(), 'a stored seenAt ahead of the server clock is clamped to it on load');
        const r3 = l1.collectGarbage(() => false, T);
        assert(r3.removed.length === 1 && r3.removed[0] === 'lg-gone' && l1.getIfExists('lg-idle')?.seenAt === T - 10 * DAY
          && (l1.social('lg-idle')?.incoming.length ?? -1) === 0,
          'gc: a legacy record is judged by its newest write, and a survivor gets that as its seenAt', { r3, idle: l1.getIfExists('lg-idle') });
        /* a request *to* an abandoned profile bumps its social.updatedAt — that must not keep it alive */
        l1.addFriendRequest('lg-future', 'lg-idle');
        const r4 = l1.collectGarbage(() => false, T + PROFILE_GC_INACTIVE_MS - 5 * DAY);
        assert(r4.removed.includes('lg-idle') && l1.social('lg-future')?.outgoing.length === 0,
          'gc: someone else touching a profile (a friend request) does not reset its inactivity clock', r4);
        l1.close();
        const l2 = new ProfileStore({ dataDir: dirG, quiet: true });
        assert(l2.getIfExists('lg-gone') === undefined && l2.getIfExists('lg-idle') === undefined
          && typeof l2.getIfExists('lg-future')?.seenAt === 'number' && l2.peerByCode('FUTUREAA') === 'lg-future',
          'gc results and seenAt round-trip through profiles.json', { future: l2.getIfExists('lg-future') });
        l2.close();
      } finally {
        rmSync(dirG, { recursive: true, force: true });
      }

      /* relay level: connected sockets and lobby members are never collected; online friends are re-pushed */
      const gs = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: 5_000, dataDir: null, profileGcIntervalMs: null });
      const gurl = `ws://127.0.0.1:${gs.port}${NET_WS_PATH}`;
      try {
        const { c: ga, welcome: wga } = await connect('GA', gurl, { token: makeToken('g'), name: 'GcA' });
        const { c: gb, welcome: wgb } = await connect('GB', gurl, { token: makeToken('h'), name: 'GcB' });
        const { c: gc } = await connect('GC', gurl, { token: makeToken('i'), name: 'GcC' });
        const codeGA = wga.social!.me.code;
        ga.send({ t: 'social:request', code: wgb.social!.me.code });
        await gb.wait('social:state', (mm) => mm.social.incoming.length === 1);
        gb.send({ t: 'social:respond', code: codeGA, accept: true });
        await ga.wait('social:state', (mm) => mm.social.friends.length === 1);
        gc.send({ t: 'lobby:create', name: 'GcC' });
        await gc.wait('lobby:state');
        gb.close(); gc.close();
        await Promise.all([gb.closed(), gc.closed()]);
        for (let i = 0; i < 40 && gs.clientCount() > 1; i++) await sleep(25);
        await ga.wait('social:state', (mm) => mm.social.friends[0]?.presence === 'offline');
        assert(typeof gs.store.getIfExists(gb.id)?.seenAt === 'number' && (gs.store.getIfExists(gb.id)?.seenAt ?? 0) >= T,
          'relay: a disconnect stamps seenAt on the profile');
        const r5 = gs.collectGarbage(Date.now() + PROFILE_GC_INACTIVE_MS + DAY);
        assert(r5.removed.length === 1 && r5.removed[0] === gb.id && gs.store.getIfExists(ga.id) !== undefined && gs.store.getIfExists(gc.id) !== undefined,
          'relay gc: the offline profile goes; the connected socket and the lobby member inside its grace stay', { removed: r5.removed, a: ga.id, c: gc.id });
        const pushed = await ga.wait('social:state', (mm) => mm.social.friends.length === 0);
        assert(pushed.social.friends.length === 0, 'relay gc: an online friend of a deleted profile is pushed a fresh snapshot at once');
        ga.close();
        await ga.closed();
      } finally {
        await gs.close();
      }
    }

    /* ── part 8c (2026-09-11, B-6 · B-3 · B-5 · B-4): 원자적 이동 · 초대 표 · 푸시 합치기 · 차단 · 귓속말 확인/보관 ── */
    {
      /* B-6 (unit): one join rule, and a refused move changes nothing */
      const lm = new LobbyManager();
      const home = lm.create('mv-a', 'A') as Lobby;
      const dest = lm.create('mv-host', 'H') as Lobby;
      assert(dest.canAdd() === null && home.canAdd() === null, 'B-6: canAdd() is null for an open lobby');
      for (const id of ['mv-2', 'mv-3', 'mv-4']) lm.join(id, dest.code, id);
      assert(dest.canAdd() === 'full' && dest.add('mv-x', 'X') === 'full', 'B-6: canAdd() and add() agree on a full lobby');
      let mv = lm.move('mv-a', dest.code, 'A');
      assert(!mv.ok && mv.code === 'full' && lm.lobbyOf('mv-a') === home && lm.byCode(home.code) === home && home.size === 1,
        'B-6: move into a full lobby → full, and my own lobby is untouched', mv);
      lm.leave('mv-4');
      dest.start(1, 'raid', 'mv-host');
      assert(dest.canAdd() === 'started' && dest.add('mv-x', 'X') === 'started', 'B-6: canAdd() and add() agree on a started raid');
      mv = lm.move('mv-a', dest.code, 'A');
      assert(!mv.ok && mv.code === 'started' && lm.lobbyOf('mv-a') === home && home.has('mv-a'), 'B-6: move into a started raid → started, my lobby untouched', mv);
      dest.reset();
      dest.start(2, 'training', 'mv-host');
      assert(dest.canAdd() === null, 'B-6: a training keeps canAdd() open, exactly like add()');
      mv = lm.move('mv-a', 'ZZZZZZ', 'A');
      assert(!mv.ok && mv.code === 'not_found' && lm.lobbyOf('mv-a') === home, 'B-6: move into a lobby that is gone → not_found, my lobby untouched', mv);
      mv = lm.move('mv-a', home.code, 'A');
      assert(!mv.ok && mv.code === 'in_lobby', 'B-6: move into the lobby I am already in → in_lobby', mv);
      mv = lm.move('mv-a', dest.code, 'A');
      assert(mv.ok && mv.from === home && mv.fromDeleted && lm.byCode(home.code) === undefined && lm.lobbyOf('mv-a') === dest && dest.has('mv-a'),
        'B-6: a successful move leaves (my empty lobby deleted) and joins in one step', mv.ok ? { from: mv.from?.code, deleted: mv.fromDeleted } : mv);

      /* B-4 (unit): block cap · inbox cap / TTL / delivered once · file round trip · GC */
      const sb = new ProfileStore({ dataDir: null, quiet: true });
      sb.ensureSocial('bk-me', 'Me');
      for (let n = 0; n < SOCIAL_BLOCK_MAX; n++) { sb.ensureSocial(`bk-${n}`, `B${n}`); sb.setBlocked('bk-me', `bk-${n}`, true); }
      sb.ensureSocial('bk-over', 'Over');
      assert(sb.setBlocked('bk-me', 'bk-over', true) === 'limit' && sb.social('bk-me')?.blocked?.length === SOCIAL_BLOCK_MAX,
        `B-4: blocking past SOCIAL_BLOCK_MAX (${SOCIAL_BLOCK_MAX}) → limit`);
      assert(sb.setBlocked('bk-me', 'bk-0', true) === 'ok' && sb.social('bk-me')?.blocked?.[0] === sb.social('bk-0')?.code
        && sb.social('bk-me')?.blocked?.length === SOCIAL_BLOCK_MAX, 'B-4: re-blocking someone already blocked moves them to the front (not limit)');
      assert(sb.setBlocked('bk-me', 'bk-me', true) === 'self' && sb.setBlocked('bk-me', 'bk-over', false) === 'ok',
        'B-4: blocking myself → self; unblocking someone not blocked is a no-op ok');
      const nowIb = Date.now();
      const fromIb = sb.social('bk-1')!.code;
      for (let n = 0; n < SOCIAL_WHISPER_INBOX_MAX + 5; n++) sb.pushWhisperInbox('bk-over', { from: fromIb, name: 'B1', text: `m${n}`, at: nowIb - 1000 + n }, nowIb);
      const ib = sb.social('bk-over')?.inbox ?? [];
      assert(ib.length === SOCIAL_WHISPER_INBOX_MAX && ib[0].text === 'm5' && ib[ib.length - 1].text === `m${SOCIAL_WHISPER_INBOX_MAX + 4}`,
        `B-4: an inbox keeps the newest SOCIAL_WHISPER_INBOX_MAX (${SOCIAL_WHISPER_INBOX_MAX}) lines, oldest first`, ib.length);
      assert(sb.takeWhisperInbox('bk-over', nowIb + SOCIAL_WHISPER_INBOX_TTL_MS + 5_000).length === 0 && sb.social('bk-over')?.inbox === undefined,
        'B-4: lines older than SOCIAL_WHISPER_INBOX_TTL_MS are not delivered, and taking empties the inbox');
      sb.pushWhisperInbox('bk-over', { from: fromIb, name: 'B1', text: 'one', at: nowIb }, nowIb);
      sb.pushWhisperInbox('bk-over', { from: fromIb, name: 'B1', text: 'two', at: nowIb + 1 }, nowIb);
      const took = sb.takeWhisperInbox('bk-over', nowIb + 2);
      assert(took.length === 2 && took[0].text === 'one' && sb.takeWhisperInbox('bk-over', nowIb + 3).length === 0, 'B-4: the inbox is delivered once, oldest first');
      sb.close();

      const dirB = mkdtempSync(join(tmpdir(), 'scav-block-'));
      try {
        const f1 = new ProfileStore({ dataDir: dirB, saveDebounceMs: 5, quiet: true });
        for (const id of ['fb-me', 'fb-them', 'fb-pal']) { f1.ensureSocial(id, id); f1.touchSeen(id); }
        f1.setBlocked('fb-me', 'fb-them', true);
        f1.pushWhisperInbox('fb-me', { from: f1.social('fb-pal')!.code, name: 'fb-pal', text: 'kept', at: Date.now() });
        const themCode = f1.social('fb-them')!.code;
        f1.close();
        const f2 = new ProfileStore({ dataDir: dirB, quiet: true });
        assert(f2.social('fb-me')?.blocked?.[0] === themCode && f2.social('fb-me')?.inbox?.[0]?.text === 'kept' && f2.isBlocked('fb-me', themCode),
          'B-4: blocked + inbox round-trip through profiles.json', f2.social('fb-me'));
        const DAYB = 24 * 60 * 60_000;
        f2.touchSeen('fb-them', Date.now() - PROFILE_GC_INACTIVE_MS - DAYB);
        const gcB = f2.collectGarbage((id) => id !== 'fb-them');
        assert(gcB.removed.includes('fb-them') && f2.social('fb-me')?.blocked === undefined && gcB.changed.includes('fb-me'),
          'B-4: the GC drops a blocked 아이디 whose profile it deleted (and reports the owner)', gcB);
        f2.close();
        writeFileSync(join(dirB, PROFILE_FILE), JSON.stringify({ v: 1, profiles: {
          'tb-me': { credits: 0, docs: {}, updatedAt: 5, social: {
            code: 'MEMEMEME', salt: 0, name: 'Me', level: 1, friends: ['BLKCKEDA', 'FRNDFRND'], incoming: [], outgoing: [], recent: [], updatedAt: 5,
            blocked: ['BLKCKEDA', 'bad!', 'BLKCKEDA', 'MEMEMEME'],
            inbox: [{ from: 'FRNDFRND', name: 'F', text: 'ok', at: Date.now() - 1000 }, { from: 'FRNDFRND', text: 7, at: 1 },
              { from: 'BLKCKEDA', name: 'B', text: 'from blocked', at: Date.now() }, { from: 'FRNDFRND', name: 'F', text: 'stale', at: Date.now() - SOCIAL_WHISPER_INBOX_TTL_MS - 60_000 }],
          } },
        } }), 'utf8');
        const f3 = new ProfileStore({ dataDir: dirB, quiet: true });
        const tb = f3.social('tb-me');
        assert(tb?.blocked?.length === 1 && tb.blocked[0] === 'BLKCKEDA' && tb.friends.length === 1 && tb.friends[0] === 'FRNDFRND',
          'B-4 sanitize: the block list drops junk / duplicates / my own code, and a blocked code cannot stay a friend', tb);
        assert(tb?.inbox?.length === 1 && tb.inbox[0].text === 'ok', 'B-4 sanitize: malformed, blocked-sender and expired inbox lines are dropped', tb?.inbox);
        f3.close();
      } finally {
        rmSync(dirB, { recursive: true, force: true });
      }

      /* relay level */
      const TTL8C = 2000;
      const ss = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: GRACE_MS, dataDir: null, profileGcIntervalMs: null, inviteTtlMs: TTL8C });
      const surl = `ws://127.0.0.1:${ss.port}${NET_WS_PATH}`;
      type P = { c: TestClient; code: PlayerCode };
      const conn = async (label: string, ch: string, name: string): Promise<P> => {
        const r = await connect(label, surl, { token: makeToken(ch), name });
        return { c: r.c, code: r.welcome.social?.me.code ?? '' };
      };
      const befriend = async (a: P, b: P): Promise<void> => {
        a.c.send({ t: 'social:request', code: b.code });
        await b.c.wait('social:state', (mm) => mm.social.incoming.some((r) => r.code === a.code));
        b.c.send({ t: 'social:respond', code: a.code, accept: true });
        await Promise.all([
          a.c.wait('social:state', (mm) => mm.social.friends.some((r) => r.code === b.code)),
          b.c.wait('social:state', (mm) => mm.social.friends.some((r) => r.code === a.code)),
        ]);
      };
      /** After `settleMs`, how many `t` frames are queued (consumed). */
      const countQueued = async (cl: TestClient, t: ServerToClient['t'], settleMs: number): Promise<number> => {
        await sleep(settleMs);
        let n = 0;
        for (;;) { try { await cl.wait(t, undefined, 0); n++; } catch { return n; } }
      };
      const openedLobby = async (p: P): Promise<string> => {
        p.c.send({ t: 'lobby:create', name: 'x' });
        return (await p.c.wait('lobby:state', (mm) => mm.lobby.players.length === 1)).lobby.code;
      };
      try {
        const A = await conn('8cA', 'P', 'Alfa');
        let B = await conn('8cB', 'Q', 'Bravo');
        const C = await conn('8cC', 'R', 'Charlie');
        const D = await conn('8cD', 'S', 'Delta');
        const E = await conn('8cE', 'T', 'Echo');
        const F = await conn('8cF', 'U', 'Fox');

        /* ── B-3: accept → server move, badge, no echo to the invitee ── */
        await befriend(A, B);
        A.c.send({ t: 'social:play', code: B.code });
        const [pl1, iv1] = await Promise.all([A.c.wait('social:play'), B.c.wait('social:invited')]);
        assert(pl1.outcome === 'invited' && typeof iv1.invite.id === 'string' && iv1.invite.id.length > 0 && iv1.invite.from === A.code,
          'B-3: social:invited carries the server invite id', iv1.invite);
        const badge = await A.c.wait('social:state', (mm) => mm.social.friends.some((r) => r.code === B.code && r.inviteAt === iv1.invite.at));
        assert(badge.social.friends.length === 1, 'B-3 배지: the inviter row carries inviteAt = the invite time');
        const aShip = A.c.lobby?.code ?? '';
        B.c.send({ t: 'social:inviteReply', id: iv1.invite.id ?? '', accept: true });
        const [acc1, stB1] = await Promise.all([
          A.c.wait('social:inviteResult', (mm) => mm.id === iv1.invite.id),
          B.c.wait('lobby:state', (mm) => mm.lobby.code === aShip),
        ]);
        assert(acc1.outcome === 'accepted' && acc1.code === B.code && acc1.name === 'Bravo' && stB1.lobby.players.length === 2,
          'B-3: accept → the server moves the invitee into the ship and the inviter gets inviteResult accepted', { acc1, n: stB1.lobby.players.length });
        assert(await B.c.expectNone('social:inviteClosed', 150) && await B.c.expectNone('lobby:left', 1),
          'B-3: no inviteClosed echo for my own reply (and no lobby:left — I had no ship to leave)');
        await A.c.wait('social:state', (mm) => mm.social.friends.some((r) => r.code === B.code && r.inviteAt === undefined && r.squad === 2));
        pass('B-3 배지: the inviteAt badge is gone once the invite closes');
        B.c.send({ t: 'social:inviteReply', id: iv1.invite.id ?? '', accept: true });
        const exp1 = await B.c.wait('social:error');
        assert(exp1.code === 'expired' && exp1.message === SOCIAL_ERROR_MESSAGE_KO.expired, 'B-3: answering an invite that is already closed → social:error expired', exp1);
        B.c.send({ t: 'lobby:leave' });
        await B.c.wait('lobby:left');

        /* ── declined ── */
        A.c.send({ t: 'social:play', code: B.code });
        let iv = await B.c.wait('social:invited');
        B.c.send({ t: 'social:inviteReply', id: iv.invite.id ?? '', accept: false });
        let ir = await A.c.wait('social:inviteResult', (mm) => mm.id === iv.invite.id);
        assert(ir.outcome === 'declined' && await B.c.expectNone('social:inviteClosed', 150), 'B-3: decline → the inviter hears declined (not expired), no echo to the invitee', ir);

        /* ── expired (server TTL) ── */
        A.c.send({ t: 'social:play', code: B.code });
        iv = await B.c.wait('social:invited');
        const tIv = Date.now();
        const [exA, exB] = await Promise.all([
          A.c.wait('social:inviteResult', (mm) => mm.id === iv.invite.id, TTL8C + 2000),
          B.c.wait('social:inviteClosed', (mm) => mm.id === iv.invite.id, TTL8C + 2000),
        ]);
        assert(exA.outcome === 'expired' && exB.outcome === 'expired' && Date.now() - tIv >= TTL8C - 200,
          'B-3: the server TTL expires an unanswered invite on both sides', { exA, exB, ms: Date.now() - tIv });

        /* ── superseded ── */
        A.c.send({ t: 'social:play', code: B.code });
        const ivOld = await B.c.wait('social:invited');
        A.c.send({ t: 'social:play', code: B.code });
        const [supA, supB, ivNew] = await Promise.all([
          A.c.wait('social:inviteResult', (mm) => mm.id === ivOld.invite.id),
          B.c.wait('social:inviteClosed', (mm) => mm.id === ivOld.invite.id),
          B.c.wait('social:invited', (mm) => mm.invite.id !== ivOld.invite.id),
        ]);
        assert(supA.outcome === 'superseded' && supB.outcome === 'superseded' && ivNew.invite.from === A.code,
          'B-3: re-inviting the same player supersedes the old invite on both sides, then the new card arrives', { supA, supB });

        /* ── a page reload is shown the still-open invite again ── */
        const Breload = await conn('8cB-reload', 'Q', 'Bravo');
        const again = await Breload.c.wait('social:invited');
        await B.c.closed();
        assert(again.invite.id === ivNew.invite.id && await A.c.expectNone('social:inviteResult', 200, (mm) => (mm as { id?: string }).id === ivNew.invite.id),
          'B-3: a replaced socket (page reload) gets the open invite again with the same id, and it stays open', again.invite);
        B = Breload;

        /* ── failed: the inviter leaves → the ship dissolves ── */
        A.c.send({ t: 'lobby:leave' });
        await A.c.wait('lobby:left');
        const [flA, flB] = await Promise.all([
          A.c.wait('social:inviteResult', (mm) => mm.id === ivNew.invite.id),
          B.c.wait('social:inviteClosed', (mm) => mm.id === ivNew.invite.id),
        ]);
        assert(flA.outcome === 'failed' && flA.reason === 'not_found' && flB.outcome === 'failed' && flB.reason === 'not_found',
          'B-3: the inviter ship dissolving fails the invite on both sides (not_found)', { flA, flB });
        B.c.send({ t: 'social:inviteReply', id: ivNew.invite.id ?? '', accept: true });
        assert((await B.c.wait('social:error')).code === 'expired', 'B-3: accepting a failed invite → expired');

        /* ── offline: the invitee disconnects ── */
        A.c.send({ t: 'social:play', code: B.code });
        iv = await B.c.wait('social:invited');
        B.c.close();
        await B.c.closed();
        ir = await A.c.wait('social:inviteResult', (mm) => mm.id === iv.invite.id);
        assert(ir.outcome === 'offline' && ir.code === B.code, 'B-3: the invitee disconnecting closes the invite as offline for the inviter', ir);
        B = await conn('8cB2', 'Q', 'Bravo');

        /* ── an older client ignores the id and joins with lobby:join ── */
        A.c.send({ t: 'social:play', code: B.code });
        iv = await B.c.wait('social:invited');
        B.c.send({ t: 'lobby:join', code: iv.invite.lobby, name: 'Bravo' });
        const [oldSt, oldRes] = await Promise.all([
          B.c.wait('lobby:state', (mm) => mm.lobby.code === iv.invite.lobby),
          A.c.wait('social:inviteResult', (mm) => mm.id === iv.invite.id),
        ]);
        assert(oldSt.lobby.players.length === 2 && oldRes.outcome === 'accepted',
          'B-3: an older client (id ignored) still gets in with lobby:join — and that answers the invite', { n: oldSt.lobby.players.length, oldRes });
        B.c.send({ t: 'lobby:leave' });
        await B.c.wait('lobby:left');

        /* ── busy while in someone else's squad; then accept from a ship where I am alone → lobby:left moved ── */
        A.c.send({ t: 'social:play', code: B.code });
        iv = await B.c.wait('social:invited');
        const cShip = await openedLobby(C);
        B.c.send({ t: 'lobby:join', code: cShip, name: 'Bravo' });
        await Promise.all([B.c, C.c].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.code === cShip && mm.lobby.players.length === 2)));
        B.c.send({ t: 'social:inviteReply', id: iv.invite.id ?? '', accept: true });
        const busy1 = await B.c.wait('social:error');
        assert(busy1.code === 'busy' && B.c.lobby?.code === cShip && await A.c.expectNone('social:inviteResult', 150, (mm) => (mm as { id?: string }).id === iv.invite.id),
          'B-3: accepting while in a squad with others → busy, I stay, and the invite stays open', busy1);
        C.c.send({ t: 'lobby:leave' });
        await C.c.wait('lobby:left');
        await B.c.wait('peer:left');
        const aShipCur = A.c.lobby?.code ?? '';
        const movedP = B.c.wait('lobby:left');
        const movedStateP = B.c.wait('lobby:state', (mm) => mm.lobby.code === aShipCur);
        B.c.send({ t: 'social:inviteReply', id: iv.invite.id ?? '', accept: true });
        const [mvLeft, mvState, mvRes] = await Promise.all([movedP, movedStateP, A.c.wait('social:inviteResult', (mm) => mm.id === iv.invite.id)]);
        assert(mvLeft.reason === 'moved' && mvLeft.to === mvState.lobby.code && mvRes.outcome === 'accepted' && ss.lobbies.byCode(cShip) === undefined,
          'B-3 + B-6: accepting from a ship where I am alone → lobby:left {moved, to} → the inviter ship; my old ship is deleted', { mvLeft, mvRes });

        /* ── failed: the inviter ship fills up · B-6: 같이 하기 into a full ship leaves my own ship alone ── */
        /* A's ship holds A + B. Two invites open (C · E), D joins (3), then C accepts from a ship of its own → 4 = full:
         * C's invite must read accepted (the move filled the ship — not "failed full"), E's fails full. */
        const aShipNow = A.c.lobby?.code ?? '';
        A.c.send({ t: 'social:play', code: C.code });
        const ivC = await C.c.wait('social:invited');
        A.c.send({ t: 'social:play', code: E.code });
        const ivE = await E.c.wait('social:invited');
        D.c.send({ t: 'lobby:join', code: aShipNow, name: 'x' });
        await D.c.wait('lobby:state', (mm) => mm.lobby.code === aShipNow && mm.lobby.players.length === 3);
        await openedLobby(C);
        C.c.send({ t: 'social:inviteReply', id: ivC.invite.id ?? '', accept: true });
        const [fillLeft, fillRes, fullA, fullE] = await Promise.all([
          C.c.wait('lobby:left'),
          A.c.wait('social:inviteResult', (mm) => mm.id === ivC.invite.id),
          A.c.wait('social:inviteResult', (mm) => mm.id === ivE.invite.id),
          E.c.wait('social:inviteClosed', (mm) => mm.id === ivE.invite.id),
        ]);
        assert(fillLeft.reason === 'moved' && fillRes.outcome === 'accepted' && ss.lobbies.byCode(aShipNow)?.size === 4,
          'B-3: accepting from my own ship into the last free slot reads accepted (the move filling the ship does not fail it)', { fillRes, size: ss.lobbies.byCode(aShipNow)?.size });
        assert(fullA.outcome === 'failed' && fullA.reason === 'full' && fullE.outcome === 'failed' && fullE.reason === 'full',
          'B-3: the inviter ship filling up fails its other open invites on both sides (full)', { fullA, fullE });
        const eShip = await openedLobby(E);
        E.c.flush();
        E.c.send({ t: 'social:play', code: A.code });
        const fullErr = await E.c.wait('social:error');
        assert(fullErr.code === 'full' && ss.lobbies.lobbyOf(E.c.id)?.code === eShip && await E.c.expectNone('lobby:left', 100),
          'B-6: 같이 하기 into a full ship → full, and my own ship is kept (no lobby:left)', fullErr);
        E.c.send({ t: 'lobby:leave' });
        await E.c.wait('lobby:left');

        /* ── cap: SQUAD_INVITE_MAX open invites per invitee, the oldest goes ── */
        for (const p of [B, C, D]) { p.c.send({ t: 'lobby:leave' }); await p.c.wait('lobby:left'); }
        const capIds: string[] = [];
        for (const p of [A, B, D, E]) {
          p.c.send({ t: 'social:play', code: F.code });
          capIds.push((await F.c.wait('social:invited', (mm) => mm.invite.from === p.code)).invite.id ?? '');
        }
        const [capA, capF] = await Promise.all([
          A.c.wait('social:inviteResult', (mm) => mm.id === capIds[0]),
          F.c.wait('social:inviteClosed', (mm) => mm.id === capIds[0]),
        ]);
        assert(capA.outcome === 'failed' && capA.reason === 'limit' && capF.reason === 'limit' && SQUAD_INVITE_MAX === 3,
          `B-3: a ${SQUAD_INVITE_MAX + 1}th open invite to the same player closes the oldest (failed / limit)`, { capA, capF });
        for (const id of capIds.slice(1)) F.c.send({ t: 'social:inviteReply', id, accept: false });
        await Promise.all([B, D, E].map((p, i) => p.c.wait('social:inviteResult', (mm) => mm.id === capIds[i + 1] && mm.outcome === 'declined')));

        /* ── B-6: 같이 하기 while inside a 훈련장 → busy, the training goes on ── */
        const dShip = D.c.lobby?.code ?? '';
        D.c.send({ t: 'lobby:start', seed: 77, mode: 'training' });
        await D.c.wait('game:start');
        D.c.send({ t: 'social:play', code: A.code });
        const busyT = await D.c.wait('social:error');
        assert(busyT.code === 'busy' && ss.lobbies.lobbyOf(D.c.id)?.code === dShip && ss.lobbies.lobbyOf(D.c.id)?.get(D.c.id)?.inMission === true,
          'B-6: 같이 하기 from inside my own training → busy, and I stay in it', busyT);
        D.c.send({ t: 'lobby:mission', inMission: false });
        await D.c.wait('lobby:state', (mm) => !mm.lobby.started);

        /* ── B-5: 최근 만난 플레이어 · request targets are watched; my own answer is immediate ── */
        const G = await conn('8cG', 'V', 'Golf');
        let H = await conn('8cH', 'W', 'Hotel');
        const hShip = await openedLobby(H);
        G.c.send({ t: 'lobby:join', code: hShip, name: 'Golf' });
        await G.c.wait('lobby:state', (mm) => mm.lobby.code === hShip);
        G.c.send({ t: 'lobby:leave' });
        await G.c.wait('lobby:left');
        H.c.send({ t: 'lobby:leave' });
        await H.c.wait('lobby:left');
        await sleep(SOCIAL_PUSH_COALESCE_MS + 150);
        G.c.flush();
        H.c.close();
        await H.c.closed();
        await G.c.wait('social:state', (mm) => mm.social.recent.some((r) => r.code === H.code && r.presence === 'offline'));
        pass('B-5: a 최근 만난 플레이어 row is pushed when that player goes offline (not only friends are watched)');
        H = await conn('8cH2', 'W', 'Hotel');
        await G.c.wait('social:state', (mm) => mm.social.recent.some((r) => r.code === H.code && r.presence === 'ship'));
        pass('B-5: … and when they come back');
        const I = await conn('8cI', 'Y', 'India');
        G.c.send({ t: 'social:request', code: I.code });
        await I.c.wait('social:state', (mm) => mm.social.incoming.some((r) => r.code === G.code));
        await openedLobby(I);
        await G.c.wait('social:state', (mm) => mm.social.outgoing.some((r) => r.code === I.code && r.squad === 1));
        pass('B-5: the target of my pending request is watched — their new ship reaches my outgoing row');
        I.c.send({ t: 'lobby:leave' });
        await I.c.wait('lobby:left');
        await sleep(SOCIAL_PUSH_COALESCE_MS + 150);
        I.c.flush(); H.c.flush();
        const tReq = Date.now();
        I.c.send({ t: 'social:request', code: H.code });
        await I.c.wait('social:state', (mm) => mm.social.outgoing.some((r) => r.code === H.code));
        const dtOwn = Date.now() - tReq;
        await H.c.wait('social:state', (mm) => mm.social.incoming.some((r) => r.code === I.code));
        const dtOther = Date.now() - tReq;
        assert(dtOwn < 200 && dtOther - dtOwn >= 150, 'B-5: my own answer (social:request) is immediate; the other side comes with the coalescing window', { dtOwn, dtOther });
        assert(await countQueued(I.c, 'social:state', SOCIAL_PUSH_COALESCE_MS + 150) === 0, 'B-5: … and no duplicate snapshot follows for the requester');

        /* ── B-5: a 4-member squad starting → a friend of all four gets ONE snapshot; 10 toggles → 1–2 ── */
        const M = [await conn('8cM1', 'Z', 'M1'), await conn('8cM2', '5', 'M2'), await conn('8cM3', '6', 'M3'), await conn('8cM4', '0', 'M4')];
        for (const m of M) await befriend(G, m);
        const mShip = await openedLobby(M[0]);
        for (const m of M.slice(1)) m.c.send({ t: 'lobby:join', code: mShip, name: 'm' });
        await Promise.all(M.map((m) => m.c.wait('lobby:state', (mm) => mm.lobby.code === mShip && mm.lobby.players.length === 4)));
        await pickPlanet(M[0].c, 'mossy', M.slice(1).map((m) => m.c));
        for (const m of M) m.c.send({ t: 'lobby:ready', ready: true });
        await Promise.all(M.map((m) => m.c.wait('lobby:state', (mm) => mm.lobby.players.length === 4 && mm.lobby.players.every((p) => p.ready))));
        await sleep(SOCIAL_PUSH_COALESCE_MS + 200);
        G.c.flush();
        M[0].c.send({ t: 'lobby:start', seed: 88 });
        await Promise.all(M.map((m) => m.c.wait('game:start')));
        const n4 = await countQueued(G.c, 'social:state', SOCIAL_PUSH_COALESCE_MS + 350);
        assert(n4 === 1, 'B-5: a 4-member squad starting a raid reaches a friend of all four as ONE snapshot (was 4)', n4);
        for (let i = 0; i < 10; i++) M[1].c.send({ t: 'lobby:mission', inMission: i % 2 === 1 });
        const n10 = await countQueued(G.c, 'social:state', SOCIAL_PUSH_COALESCE_MS + 450);
        assert(n10 >= 1 && n10 <= 2, 'B-5: ten quick lobby:mission toggles reach that friend as 1–2 snapshots (was 10)', n10);

        /* ── B-4: block → both sides cleaned, open invites closed ── */
        const N1 = await conn('8cN1', 'a', 'Nov');
        const N2 = await conn('8cN2', 'b', 'Oscar');
        const N3 = await conn('8cN3', 'c', 'Papa');
        await befriend(N1, N2);
        const n3Ship = await openedLobby(N3);
        N1.c.send({ t: 'lobby:join', code: n3Ship, name: 'Nov' });
        await N1.c.wait('lobby:state', (mm) => mm.lobby.code === n3Ship);
        N1.c.send({ t: 'lobby:leave' });
        await N1.c.wait('lobby:left');
        N3.c.send({ t: 'social:request', code: N1.code });
        await N1.c.wait('social:state', (mm) => mm.social.incoming.some((r) => r.code === N3.code) && mm.social.recent.some((r) => r.code === N3.code));
        N3.c.send({ t: 'social:play', code: N1.code });            // N3 (ship) → N1 (no ship): invite
        const iv31 = await N1.c.wait('social:invited', (mm) => mm.invite.from === N3.code);
        N1.c.send({ t: 'social:play', code: N2.code });            // N1 (no ship) → N2: my ship is made, invite
        const iv12 = await N2.c.wait('social:invited', (mm) => mm.invite.from === N1.code);
        N1.c.send({ t: 'social:block', code: N2.code, blocked: true });
        const [bl1, bl2, cl12, rs12] = await Promise.all([
          N1.c.wait('social:state', (mm) => (mm.social.blocked ?? []).some((r) => r.code === N2.code)),
          N2.c.wait('social:state', (mm) => !mm.social.friends.some((r) => r.code === N1.code)),
          N2.c.wait('social:inviteClosed', (mm) => mm.id === iv12.invite.id),
          N1.c.wait('social:inviteResult', (mm) => mm.id === iv12.invite.id),
        ]);
        assert(bl1.social.friends.length === 0 && bl1.social.blocked?.[0]?.name === 'Oscar' && bl2.social.friends.length === 0,
          'B-4: block → the friendship goes on both sides and the code is in my blocked list (a card)', { mine: bl1.social, theirs: bl2.social.friends });
        assert(cl12.outcome === 'failed' && rs12.outcome === 'failed', 'B-4: my open invite to the player I block is closed on both sides', { cl12, rs12 });
        N3.c.flush();
        N1.c.send({ t: 'social:block', code: N3.code, blocked: true });
        const [bl3, n3s, cl31] = await Promise.all([
          N1.c.wait('social:state', (mm) => (mm.social.blocked ?? []).length === 2),
          N3.c.wait('social:state', (mm) => !mm.social.outgoing.some((r) => r.code === N1.code)),
          N1.c.wait('social:inviteClosed', (mm) => mm.id === iv31.invite.id),
        ]);
        assert(bl3.social.incoming.length === 0 && bl3.social.recent.length === 0 && n3s.social.recent.every((r) => r.code !== N1.code)
          && bl3.social.blocked?.[0]?.code === N3.code, 'B-4: block → requests and 최근 만난 플레이어 are removed on both sides, newest block first', { mine: bl3.social, theirs: n3s.social });
        assert(await N3.c.expectNone('social:inviteResult', 200), 'B-4: their open invite to me closes for me only — the blocked inviter hears nothing yet', cl31);

        /* ── B-4: what a blocked player sends me is swallowed, silently ── */
        N1.c.flush(); N2.c.flush();
        N2.c.send({ t: 'social:whisper', code: N1.code, text: 'hello?', nonce: 7 });
        const ackSw = await N2.c.wait('social:whisperAck');
        assert(ackSw.nonce === 7 && ackSw.ok && (ackSw.at ?? 0) > 0 && !ackSw.stored && await N1.c.expectNone('social:whisper', 200),
          'B-4: a whisper from a player I blocked is dropped, and their ack still says ok', ackSw);
        N2.c.send({ t: 'social:request', code: N1.code });
        await N2.c.wait('social:state', (mm) => mm.social.outgoing.some((r) => r.code === N1.code));
        assert(await N1.c.expectNone('social:state', SOCIAL_PUSH_COALESCE_MS + 200), 'B-4: a friend request from a blocked player sits in their outgoing only — nothing reaches me');
        N1.c.send({ t: 'social:get' });
        assert((await N1.c.wait('social:state')).social.incoming.length === 0, 'B-4: … and my incoming stays empty');
        const n1Ship = N1.c.lobby?.code ?? '';
        N2.c.send({ t: 'social:play', code: N1.code });
        const plSw = await N2.c.wait('social:play');
        assert(plSw.outcome === 'invited' && ss.lobbies.byCode(n1Ship)?.size === 1 && ss.lobbies.lobbyOf(N2.c.id)?.code !== n1Ship
          && await N1.c.expectNone('social:invited', 200),
          'B-4: 같이 하기 toward a blocker with a ship does not move them in — it reads "invited" and no card reaches me', plSw);
        const swRes = await N2.c.wait('social:inviteResult', (mm) => mm.code === N1.code, TTL8C + 2500);
        const n3Res = await N3.c.wait('social:inviteResult', (mm) => mm.id === iv31.invite.id, TTL8C + 2500);
        assert(swRes.outcome === 'expired' && n3Res.outcome === 'expired' && await N1.c.expectNone('social:inviteClosed', 50),
          'B-4: a swallowed invite (and one hidden by the block) ends as expired for the blocked inviter', { swRes, n3Res });
        N1.c.send({ t: 'social:whisper', code: N2.code, text: 'nope', nonce: 8 });
        const ackMine = await N1.c.wait('social:whisperAck');
        assert(ackMine.nonce === 8 && !ackMine.ok && ackMine.code === 'invalid', 'B-4: whispering someone I blocked → ack ok:false invalid (unblock first)', ackMine);

        /* ── B-4: unblock ── */
        N1.c.send({ t: 'social:block', code: N2.code, blocked: false });
        const [ub1, ub2] = await Promise.all([
          N1.c.wait('social:state', (mm) => (mm.social.blocked ?? []).length === 1),
          N2.c.wait('social:state', (mm) => !mm.social.outgoing.some((r) => r.code === N1.code)),
        ]);
        assert(ub1.social.blocked?.[0]?.code === N3.code && ub2.social.outgoing.length === 0,
          'B-4: unblock → off my list, and the request half they sent while blocked is dropped', { mine: ub1.social.blocked, theirs: ub2.social.outgoing });
        N2.c.send({ t: 'social:whisper', code: N1.code, text: 'hi again', nonce: 9 });
        const [wAgain, ackAgain] = await Promise.all([N1.c.wait('social:whisper'), N2.c.wait('social:whisperAck', (mm) => mm.nonce === 9)]);
        assert(wAgain.text === 'hi again' && ackAgain.ok && wAgain.at === ackAgain.at, 'B-4: after unblocking, whispers are delivered again (ack at = line at)', { wAgain, ackAgain });

        /* ── B-4: ack · offline friend inbox → backlog once · non-friend offline · old client ── */
        let N4 = await conn('8cN4', 'd', 'Quebec');
        const N5 = await conn('8cN5', 'e', 'Romeo');
        await befriend(N1, N4);
        N4.c.close(); N5.c.close();
        await Promise.all([N4.c.closed(), N5.c.closed()]);
        await sleep(60);
        N1.c.send({ t: 'social:whisper', code: N4.code, text: '나중에 봐', nonce: 11 });
        const ackSt = await N1.c.wait('social:whisperAck', (mm) => mm.nonce === 11);
        assert(ackSt.ok && ackSt.stored === true && (ackSt.at ?? 0) > 0, 'B-4: a whisper to an offline friend is kept → ack ok + stored', ackSt);
        N1.c.send({ t: 'social:whisper', code: N5.code, text: 'hey', nonce: 12 });
        const ackOff = await N1.c.wait('social:whisperAck', (mm) => mm.nonce === 12);
        assert(!ackOff.ok && ackOff.code === 'offline' && !ackOff.stored, 'B-4: to an offline non-friend → ack ok:false offline (nothing kept)', ackOff);
        N1.c.send({ t: 'social:whisper', code: N4.code, text: 'old client' });
        const oldErr = await N1.c.wait('social:error');
        assert(oldErr.code === 'offline' && await N1.c.expectNone('social:whisperAck', 100), 'B-4: a frame without nonce keeps the old rule (social:error offline, no ack, not kept)', oldErr);
        N4 = await conn('8cN4b', 'd', 'Quebec');
        const bl = await N4.c.wait('social:whisperBacklog');
        assert(bl.lines.length === 1 && bl.lines[0].code === N1.code && bl.lines[0].name === 'Nov' && bl.lines[0].text === '나중에 봐' && bl.lines[0].at === ackSt.at,
          'B-4: reconnecting → social:whisperBacklog with the kept line (sender 아이디 / name / time), old-client line not included', bl.lines);
        N4.c.close();
        await N4.c.closed();
        N4 = await conn('8cN4c', 'd', 'Quebec');
        assert(await N4.c.expectNone('social:whisperBacklog', 250), 'B-4: the backlog is delivered once (the inbox was emptied)');

        for (const p of [A, B, C, D, E, F, G, H, I, ...M, N1, N2, N3, N4]) p.c.close();
      } finally {
        await ss.close();
      }
    }

    /* cleanup */
    p8a.close(); p8b.close();
    await sleep(GRACE_MS + 400);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'part 8 cleanup: all lobbies deleted, no clients left', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════ part 9 (2026-09-09): 분대장(호스트) 지명 이관 ══════════════════════
     *
     * 두 경우만 통한다 — 지금 호스트가 넘기거나, `lobby:hostDown` 으로 사망 표시가 켜진 뒤 누군가 claim 하거나.
     * 나머지는 `not_host`, 로비 밖 targetId 는 `invalid`.
     */
    const { c: p9a } = await connect('P9A', url, { token: makeToken('9'), name: '분대장' });
    const { c: p9b } = await connect('P9B', url, { token: makeToken('8'), name: '대원B' });
    const { c: p9c } = await connect('P9C', url, { token: makeToken('7'), name: '대원C' });
    p9a.send({ t: 'lobby:create', name: '분대장' });
    const l9 = await p9a.wait('lobby:state');
    const code9 = l9.lobby.code;
    p9b.send({ t: 'lobby:join', code: code9, name: '대원B' });
    await Promise.all([p9a, p9b].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.length === 2)));
    assert(l9.lobby.hostId === p9a.id, 'part 9: the creator is the host', l9.lobby.hostId);

    /* ① 호스트가 남에게 넘기면 모두가 새 lobby:state 를 받는다 */
    p9a.send({ t: 'lobby:transferHost', targetId: p9b.id });
    const t9 = await Promise.all([p9a, p9b].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.hostId === p9b.id)));
    assert(t9[0].lobby.players.find((p) => p.id === p9b.id)?.isHost === true
      && t9[0].lobby.players.find((p) => p.id === p9a.id)?.isHost === false,
      'lobby:transferHost by the host moves hostId and every isHost flag', t9[0].lobby.players);

    /* ② 이제 호스트가 아닌 A 가 되돌리려 하면 not_host */
    p9a.send({ t: 'lobby:transferHost', targetId: p9a.id });
    let e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'not_host', 'a non-host transferHost → not_host', e9);

    /* ③ 사망 표시가 없는 상태의 claim 도 not_host */
    p9a.send({ t: 'lobby:transferHost', targetId: p9a.id, claim: true });
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'not_host', 'claim without a hostDown flag → not_host', e9);

    /* ④ 사망 표시는 호스트만 세울 수 있다 */
    p9a.send({ t: 'lobby:hostDown', down: true });
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'not_host', 'lobby:hostDown from a non-host → not_host', e9);

    /* ⑤ 호스트가 사망 표시를 켜면 남의 claim 이 통한다 (분대장 기기) */
    p9b.send({ t: 'lobby:hostDown', down: true });
    assert(await p9a.expectNone('lobby:state', 200), 'lobby:hostDown itself broadcasts nothing (it is not part of LobbyState)');
    p9a.send({ t: 'lobby:transferHost', targetId: p9a.id, claim: true });
    const c9 = await Promise.all([p9a, p9b].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.hostId === p9a.id)));
    assert(c9[0].lobby.hostId === p9a.id, 'claim after lobby:hostDown hands the 분대장 to the claimer', c9[0].lobby.hostId);

    /* ⑥ 표시는 이관과 함께 지워진다 — 같은 claim 을 두 번 쓸 수 없다 */
    p9b.send({ t: 'lobby:transferHost', targetId: p9b.id, claim: true });
    e9 = await p9b.wait('lobby:error');
    assert(e9.code === 'not_host', 'the hostDown flag is cleared by the transfer, so a second claim → not_host', e9);

    /* ⑦ 로비 밖 targetId 는 invalid */
    p9a.send({ t: 'lobby:transferHost', targetId: p9c.id });
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'invalid', 'a targetId outside the lobby → invalid', e9);
    p9a.send({ t: 'lobby:transferHost', targetId: 'nobody-at-all' });
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'invalid', 'an unknown targetId → invalid', e9);

    /* ⑧ 이미 호스트인 사람에게 넘기면 방송 없이 상태만 되돌아온다 */
    p9b.flush();
    p9a.send({ t: 'lobby:transferHost', targetId: p9a.id });
    const noop9 = await p9a.wait('lobby:state');
    assert(noop9.lobby.hostId === p9a.id, 'transferHost to the current host echoes the state to the sender', noop9.lobby.hostId);
    assert(await p9b.expectNone('lobby:state', 200), 'a no-op transferHost is not broadcast to the squad');

    /* ⑨ 로비 밖에서 보내면 not_in_lobby */
    p9c.send({ t: 'lobby:transferHost', targetId: p9a.id });
    e9 = await p9c.wait('lobby:error');
    assert(e9.code === 'not_in_lobby', 'transferHost outside a lobby → not_in_lobby', e9);

    /* ⑩ 미션이 끝나면(lobby:reset) 사망 표시도 끝난다 */
    await pickPlanet(p9a, 'mossy', [p9b]);
    for (const cl of [p9a, p9b]) cl.send({ t: 'lobby:ready', ready: true });
    await Promise.all([p9a, p9b].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.every((p) => p.ready))));
    p9a.send({ t: 'lobby:start', seed: 911 });
    await Promise.all([p9a, p9b].map((cl) => cl.wait('game:start')));
    p9a.send({ t: 'lobby:hostDown', down: true });
    p9a.send({ t: 'lobby:reset' });
    await Promise.all([p9a, p9b].map((cl) => cl.wait('lobby:state', (mm) => !mm.lobby.started)));
    p9b.send({ t: 'lobby:transferHost', targetId: p9b.id, claim: true });
    e9 = await p9b.wait('lobby:error');
    assert(e9.code === 'not_host', 'lobby:reset clears the hostDown flag (a later claim → not_host)', e9);

    /* ⑪ 잘못된 프레임은 파서가 먼저 거른다 */
    p9a.sendRaw(JSON.stringify({ t: 'lobby:transferHost' }));
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'invalid', 'lobby:transferHost with no targetId → invalid (parser)', e9);
    p9a.sendRaw(JSON.stringify({ t: 'lobby:hostDown', down: 'yes' }));
    e9 = await p9a.wait('lobby:error');
    assert(e9.code === 'invalid', 'lobby:hostDown with a non-boolean → invalid (parser)', e9);

    p9a.close(); p9b.close(); p9c.close();
    await sleep(GRACE_MS + 400);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'part 9 cleanup: all lobbies deleted, no clients left', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════ part 10 (2026-09-11, C-29): 서버 콘솔 — list · kick · max ══════════════════════
     *
     * `server/tool.ts` 의 콘솔 명령이 부르는 세 API. kick 은 유예 없이 슬롯부터 비우고(peer:left + 호스트 이관)
     * `lobby:error kicked` 뒤 CLOSE_KICKED 로 닫는다 — 밴은 없다. max 는 **새** 소켓만 막고, 같은 소켓의 교체와
     * 유예 중인 로비 멤버의 재접속은 예외다.
     */
    const { c: k1, welcome: wk1 } = await connect('K1', url, { token: makeToken('K'), name: '호스트K' });
    const { c: k2, welcome: wk2 } = await connect('K2', url, { token: makeToken('L'), name: '대원L' });
    k1.send({ t: 'lobby:create', name: '호스트K' });
    const lk = await k1.wait('lobby:state');
    k2.send({ t: 'lobby:join', code: lk.lobby.code, name: '대원L' });
    await Promise.all([k1, k2].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.length === 2)));
    const rows10 = server.listClients();
    assert(rows10.length === 2 && rows10.every((r) => r.lobby === lk.lobby.code)
      && rows10.find((r) => r.id === k1.id)?.host === true && rows10.find((r) => r.id === k2.id)?.host === false
      && rows10[0].id === k1.id,
      'listClients: every socket with its lobby code + host flag, oldest first', rows10);
    const code10 = wk1.social?.me.code ?? '';
    assert(!!code10 && rows10.find((r) => r.id === k1.id)?.code === code10 && rows10.find((r) => r.id === k2.id)?.code === wk2.social?.me.code,
      'listClients carries each 아이디', rows10);

    /* ① 아이디(대시 · 소문자로 쳐도)로 호스트를 쫓아내면: kicked → CLOSE_KICKED, 분대는 곧바로 peer:left + 호스트 이관 */
    const kr = server.kick(`${code10.slice(0, 4)}-${code10.slice(4)}`.toLowerCase(), '테스트 사유');
    assert(kr.ok && kr.id === k1.id && kr.connected && kr.lobby === lk.lobby.code, 'kick resolves a dashed lower-case 아이디 to the connected peer', kr);
    const ek = await k1.wait('lobby:error', (mm) => mm.code === 'kicked');
    assert(ek.message.includes('테스트 사유'), 'the kicked socket gets lobby:error kicked carrying the reason', ek);
    await k1.closed();
    assert(k1.closeCode === 4002, 'then it is closed with CLOSE_KICKED (4002)', k1.closeCode);
    const pl10 = await k2.wait('peer:left', (mm) => mm.id === k1.id);
    assert(pl10.lobby.hostId === k2.id && pl10.lobby.players.length === 1, 'the squad gets peer:left at once (no grace) and the host role moves', pl10.lobby);
    await sleep(50);
    assert(server.clientCount() === 1 && server.lobbies.lobbyOf(k1.id) === undefined, 'the kicked id is gone from clients and from the lobby', { clients: server.clientCount() });
    const nf = server.kick('ZZZZ-ZZZZ');
    assert(!nf.ok && nf.reason === 'not_found' && !server.kick('').ok, 'kick of an unknown / empty 아이디 → not_found');

    /* ② 밴은 없다 — 같은 토큰은 다시 붙고, 로비 밖에서 시작한다 */
    const { c: k1b, welcome: wk1b } = await connect('K1b', url, { token: makeToken('K'), name: '호스트K' });
    assert(wk1b.id === k1.id && !wk1b.lobby, 'no ban: the kicked token connects again, outside any lobby', wk1b);

    /* ③ 유예 중인(소켓이 없는) 멤버를 PeerId 로 kick → 슬롯만 비운다 */
    k2.close();
    await k2.closed();
    await sleep(50);
    assert(server.lobbies.lobbyOf(k2.id)?.get(k2.id)?.connected === false, 'precondition: K2 sits in its reconnect grace');
    const kg = server.kick(k2.id);
    assert(kg.ok && !kg.connected && server.lobbies.lobbyOf(k2.id) === undefined && server.lobbies.count === 0,
      'kick by PeerId of a member in grace removes the slot (and the empty lobby) before the grace expires', kg);

    /* ④ max: 새 소켓은 welcome 없이 server_full → CLOSE_SERVER_FULL, /health 에 제한이 보인다 */
    server.setMaxClients(1);
    assert(server.maxClients === 1, 'setMaxClients(1) → maxClients 1');
    const full10 = new TestClient('FULL', url);
    await full10.open();
    const ef = await full10.wait('lobby:error');
    assert(ef.code === 'server_full' && ef.message.length > 0, 'over the cap a new socket gets lobby:error server_full', ef);
    await full10.closed();
    assert(full10.closeCode === 4003 && await full10.expectNone('welcome', 50), 'and is closed with CLOSE_SERVER_FULL (4003) before any welcome', full10.closeCode);
    assert(server.clientCount() === 1, 'a refused socket is never counted', server.clientCount());
    const h10 = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as { maxClients?: unknown };
    assert(h10.maxClients === 1, '/health reports maxClients', h10);

    /* ⑤ 같은 토큰의 소켓 교체(새로고침)는 제한에 걸리지 않는다 */
    const { c: k1c, welcome: wk1c } = await connect('K1c', url, { token: makeToken('K'), name: '호스트K' });
    assert(wk1c.id === k1.id, 'at the cap, a page reload replacing its own socket is not refused');
    await k1b.closed();

    /* ⑥ 유예 중인 로비 멤버의 재접속은 제한에 걸리지 않는다 — 새 토큰은 걸린다 */
    server.setMaxClients(null);
    k1c.send({ t: 'lobby:create', name: '호스트K' });
    const lk2 = await k1c.wait('lobby:state');
    const { c: k3 } = await connect('K3', url, { token: makeToken('M'), name: '대원M' });
    k3.send({ t: 'lobby:join', code: lk2.lobby.code, name: '대원M' });
    await Promise.all([k1c, k3].map((cl) => cl.wait('lobby:state', (mm) => mm.lobby.players.length === 2)));
    server.setMaxClients(1);
    k3.close();
    await k3.closed();
    await k1c.wait('lobby:state', (mm) => mm.lobby.players.some((p) => p.id === k3.id && !p.connected));
    const { c: k3b, welcome: wk3b } = await connect('K3b', url, { token: makeToken('M'), name: '대원M' });
    assert(wk3b.resumed === true && wk3b.lobby?.code === lk2.lobby.code && server.clientCount() === 2,
      'at the cap, a lobby member reconnecting inside its grace is still let in', { resumed: wk3b.resumed, clients: server.clientCount() });
    const tokenN = makeToken('N');
    const full11 = new TestClient('FULL2', url, { token: tokenN, name: '늦은손님' });
    await full11.open();
    const ef2 = await full11.wait('lobby:error');
    await full11.closed();
    assert(ef2.code === 'server_full' && !server.store.has(peerIdFromToken(tokenN)),
      'a fresh token over the cap is refused and leaves no profile / social record behind', ef2);
    server.setMaxClients(0);
    assert(server.maxClients === null, 'setMaxClients(0) → unlimited');
    const { c: k4, welcome: wk4 } = await connect('K4', url, { token: tokenN, name: '늦은손님' });
    assert(wk4.id === peerIdFromToken(tokenN), 'after lifting the cap the same token connects');

    k1c.close(); k3b.close(); k4.close();
    await sleep(GRACE_MS + 400);
    assert(server.lobbies.count === 0 && server.clientCount() === 0, 'part 10 cleanup: all lobbies deleted, no clients left', { lobbies: server.lobbies.count, clients: server.clientCount() });

    /* ══════════════════════ part 11 (2026-09-11, E-6): 문서 리비전 · ack · 트랜잭션 ══════════════════════ */
    await part11ProfileRevisions(url);

    /* ══════════════════════ part 12 (2026-09-11, E-4 ⑦): 서버 크레딧 검증 ══════════════════════ */
    await part12CreditEconomy();
  } catch (e) {
    fail('unexpected exception', (e as Error).message);
  } finally {
    await server.close();
  }

  console.log(results.join('\n'));
  const total = results.length;
  console.log(`\nselftest: ${total - failures}/${total} passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
}

/**
 * part 11 (2026-09-11, E-6): `profile:set {baseRev, writeId}` → ack / conflict, writeId resend = ack again, `profile:setMany`
 * all or nothing (a stale rev or one oversized document stores nothing), Phase 9 `at` frames still work (and bump the rev),
 * `docsRev` in welcome / docs and through the file. Its own function so the parts other agents append never collide with it.
 */
async function part11ProfileRevisions(url: string): Promise<void> {
  const T = makeToken('R');
  let { c: r, welcome: rw } = await connect('R11', url, { token: T, name: '리비전' });
  assert(rw.profile !== undefined && JSON.stringify(rw.profile.docsRev) === '{}', 'E-6: welcome.profile carries docsRev ({} for a fresh record)', rw.profile?.docsRev);

  /* single document: base 0 → ack rev 1; base 0 again → conflict with the server copy */
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'A' }, baseRev: 0, writeId: 'w1' });
  const a1 = await r.wait('profile:ack', (mm) => mm.writeId === 'w1');
  assert(a1.revs.meta === 1 && a1.txId === undefined, 'E-6: profile:set baseRev 0 on an absent key → profile:ack {writeId, revs.meta 1}', a1);
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'LOST' }, baseRev: 0, writeId: 'w2' });
  const c2 = await r.wait('profile:conflict', (mm) => mm.writeId === 'w2');
  assert(c2.docs.meta?.rev === 1 && JSON.stringify(c2.docs.meta.doc) === '{"v":"A"}', 'E-6: a stale baseRev → profile:conflict with the server copy + rev, nothing stored', c2);
  /* resend of an accepted writeId (a reconnect) → the same ack, even with another body */
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'RESENT' }, baseRev: 0, writeId: 'w1' });
  const a1b = await r.wait('profile:ack', (mm) => mm.writeId === 'w1');
  r.send({ t: 'profile:get' });
  let d = await r.wait('profile:docs');
  assert(a1b.revs.meta === 1 && JSON.stringify(d.profile.docs.meta) === '{"v":"A"}' && d.profile.docsRev?.meta === 1,
    'E-6: resending an accepted writeId is acked again (idempotent) and changes nothing', { ack: a1b, docs: d.profile.docs.meta, rev: d.profile.docsRev });
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'B' }, baseRev: 1, writeId: 'w3' });
  const a3 = await r.wait('profile:ack', (mm) => mm.writeId === 'w3');
  assert(a3.revs.meta === 2, 'E-6: baseRev = current rev → accepted, rev + 1', a3);
  assert(await r.expectNone('lobby:error', 100), 'E-6: revision writes never answer with lobby:error');

  /* transactions */
  r.send({ t: 'profile:setMany', txId: 'tx1', docs: { stash: { doc: { s: 1 }, baseRev: 0 }, loadout: { doc: { l: 1 }, baseRev: 0 } } });
  const t1 = await r.wait('profile:ack', (mm) => mm.txId === 'tx1');
  assert(t1.revs.stash === 1 && t1.revs.loadout === 1 && t1.writeId === undefined, 'E-6: profile:setMany → one profile:ack {txId, revs of every key}', t1);
  r.send({ t: 'profile:setMany', txId: 'tx2', docs: { stash: { doc: { s: 2 }, baseRev: 1 }, loadout: { doc: { l: 2 }, baseRev: 0 } } });
  const t2 = await r.wait('profile:conflict', (mm) => mm.txId === 'tx2');
  r.send({ t: 'profile:get' });
  d = await r.wait('profile:docs');
  assert(Object.keys(t2.docs).join() === 'loadout' && t2.docs.loadout?.rev === 1 && JSON.stringify(d.profile.docs.stash) === '{"s":1}' && d.profile.docsRev?.stash === 1,
    'E-6: setMany with one stale key → conflict lists that key, the fresh key is NOT stored either (all or nothing)', { conflict: t2, stash: d.profile.docs.stash, revs: d.profile.docsRev });
  r.send({ t: 'profile:setMany', txId: 'tx3', docs: { stash: { doc: { s: 3 }, baseRev: 1 }, ship: { doc: { pad: 'x'.repeat(PROFILE_DOC_MAX_BYTES + 10) }, baseRev: 0 } } });
  const t3 = await r.wait('profile:refused', (mm) => mm.txId === 'tx3');
  r.send({ t: 'profile:get' });
  d = await r.wait('profile:docs');
  assert(t3.code === 'too_large' && JSON.stringify(d.profile.docs.stash) === '{"s":1}' && d.profile.docs.ship === undefined && d.profile.docsRev?.stash === 1,
    'E-6: setMany with one oversized document → profile:refused too_large, nothing stored', { t3, stash: d.profile.docs.stash });
  r.sendRaw(JSON.stringify({ t: 'profile:setMany', txId: 'tx4', docs: { stash: { doc: { s: 4 }, baseRev: 1 }, bogus: { doc: 1, baseRev: 0 } } }));
  const t4 = await r.wait('profile:refused', (mm) => mm.txId === 'tx4');
  r.sendRaw(JSON.stringify({ t: 'profile:setMany', txId: 'tx5', docs: {} }));
  const t5 = await r.wait('profile:refused', (mm) => mm.txId === 'tx5');
  r.sendRaw(JSON.stringify({ t: 'profile:set', key: 'stash', doc: { s: 6 }, baseRev: 'one', writeId: 'w6' }));
  const t6 = await r.wait('profile:refused', (mm) => mm.writeId === 'w6');
  assert(t4.code === 'invalid' && t5.code === 'invalid' && t6.code === 'invalid', 'E-6: unknown key / empty transaction / malformed baseRev → profile:refused invalid (tagged with its id)', { t4, t5, t6 });
  r.send({ t: 'profile:setMany', txId: 'tx1', docs: { stash: { doc: { s: 'again' }, baseRev: 0 }, loadout: { doc: {}, baseRev: 0 } } });
  const t1b = await r.wait('profile:ack', (mm) => mm.txId === 'tx1');
  assert(t1b.revs.stash === 1 && t1b.revs.loadout === 1, 'E-6: resending an accepted txId is acked again', t1b);
  /* a transaction bigger than one document frame (MAX_DOC_FRAME_BYTES) but inside PROFILE_SETMANY_MAX_BYTES */
  const big = (ch: string): { pad: string } => ({ pad: ch.repeat(PROFILE_DOC_MAX_BYTES - 1024) });
  r.send({ t: 'profile:setMany', txId: 'tx7', docs: { stash: { doc: big('s'), baseRev: 1 }, loadout: { doc: big('l'), baseRev: 1 } } });
  const t7 = await r.wait('profile:ack', (mm) => mm.txId === 'tx7', 5000);
  assert(t7.revs.stash === 2 && t7.revs.loadout === 2, 'E-6: a two-document transaction over the single-document frame cap is accepted', t7);

  /* Phase 9 frames keep their rules, and bump the rev so a revision client based on the old rev conflicts */
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'OLDCLIENT' }, at: Date.now() });
  assert(await r.expectNone('profile:ack', 150), 'E-6: a Phase 9 `at` frame gets no ack (old clients unchanged)');
  r.send({ t: 'profile:set', key: 'meta', doc: { v: 'C' }, baseRev: 2, writeId: 'w8' });
  const c8 = await r.wait('profile:conflict', (mm) => mm.writeId === 'w8');
  assert(c8.docs.meta?.rev === 3 && JSON.stringify(c8.docs.meta.doc) === '{"v":"OLDCLIENT"}', 'E-6: the old-client write bumped the rev → a revision write on the previous rev conflicts', c8);
  r.send({ t: 'profile:set', key: 'progression', doc: { v: 'F' }, fresh: true });
  r.send({ t: 'profile:set', key: 'progression', doc: { v: 'F2' }, fresh: true });
  r.send({ t: 'profile:get' });
  d = await r.wait('profile:docs');
  assert(JSON.stringify(d.profile.docs.progression) === '{"v":"F"}' && d.profile.docsRev?.progression === 1, 'E-6: a Phase 9 fresh write still fills only an absent key (rev 1), the second is silently stale', { doc: d.profile.docs.progression, rev: d.profile.docsRev });

  /* anonymous socket */
  const { c: an } = await connect('R11anon', url);
  an.send({ t: 'profile:set', key: 'meta', doc: {}, baseRev: 0, writeId: 'anon1' });
  const ar = await an.wait('profile:refused', (mm) => mm.writeId === 'anon1');
  an.send({ t: 'profile:setMany', txId: 'anon2', docs: { meta: { doc: {}, baseRev: 0 } } });
  const ar2 = await an.wait('profile:refused', (mm) => mm.txId === 'anon2');
  assert(ar.code === 'invalid' && ar2.code === 'invalid', 'E-6: a revision write / transaction from an anonymous socket → profile:refused invalid', { ar, ar2 });
  an.close();

  /* reconnect: welcome carries every rev */
  r.close(); await r.closed();
  ({ c: r, welcome: rw } = await connect('R11b', url, { token: T, name: '리비전' }));
  const rv = rw.profile?.docsRev;
  assert(rv?.meta === 3 && rv.stash === 2 && rv.loadout === 2 && rv.progression === 1 && rv.ship === undefined, 'E-6: welcome after a reconnect carries docsRev of every stored document', rv);
  r.close();

  /* file round-trip: revs persist, a legacy document is seeded 1, hostile revs are cleaned */
  const dir = mkdtempSync(join(tmpdir(), 'scav-store-rev-'));
  try {
    const s1 = new ProfileStore({ dataDir: dir, saveDebounceMs: 20, quiet: true });
    s1.writeDocs('q', 'x1', { meta: { doc: { m: 1 }, baseRev: 0 } });
    s1.writeDocs('q', 'x2', { meta: { doc: { m: 2 }, baseRev: 1 }, stash: { doc: { s: 1 }, baseRev: 0 } });
    const again = s1.writeDocs('q', 'x2', { meta: { doc: { m: 99 }, baseRev: 0 } });
    assert(again.kind === 'ack' && again.replay && again.revs.meta === 2, 'E-6 store: writeDocs replays an accepted id', again);
    const bad = s1.writeDocs('q2', 'x3', { meta: { doc: { m: 1 }, baseRev: 5 } });
    assert(bad.kind === 'conflict' && !s1.has('q2'), 'E-6 store: a conflicting write mints no placeholder profile', bad);
    s1.close();
    const s2 = new ProfileStore({ dataDir: dir, quiet: true });
    assert(s2.revOf('q', 'meta') === 2 && s2.revOf('q', 'stash') === 1 && JSON.stringify(s2.snapshot('q').docsRev) === '{"meta":2,"stash":1}',
      'E-6 store: docsRev round-trips through profiles.json', s2.snapshot('q').docsRev);
    const replayAfterRestart = s2.writeDocs('q', 'x2', { meta: { doc: { m: 2 }, baseRev: 1 } });
    assert(replayAfterRestart.kind === 'conflict', 'E-6 store: write ids are memory only — after a restart a resend is judged on its baseRev', replayAfterRestart);
    s2.close();
    writeFileSync(join(dir, PROFILE_FILE), JSON.stringify({ v: 1, profiles: {
      legacy: { credits: 1, docs: { meta: { z: 1 }, stash: { z: 2 } }, updatedAt: 1 },
      hostile: { credits: 1, docs: { meta: { z: 1 }, ship: { z: 3 } }, updatedAt: 1, docsRev: { meta: -5, ship: 'x', stash: 9, bogus: 4 } },
      kept: { credits: 1, docs: { loadout: { z: 1 } }, updatedAt: 1, docsRev: { loadout: 7.9 } },
    } }), 'utf8');
    const s3 = new ProfileStore({ dataDir: dir, quiet: true });
    assert(JSON.stringify(s3.snapshot('legacy').docsRev) === '{"meta":1,"stash":1}', 'E-6 store: a document written before revisions is seeded rev 1 on load', s3.snapshot('legacy').docsRev);
    assert(JSON.stringify(s3.snapshot('hostile').docsRev) === '{"meta":1,"ship":1}' && s3.revOf('kept', 'loadout') === 7,
      'E-6 store: invalid revs → 1, a rev without a document / an unknown key is dropped, a fractional rev is floored', { hostile: s3.snapshot('hostile').docsRev, kept: s3.revOf('kept', 'loadout') });
    const legacyWrite = s3.writeDocs('legacy', 'x4', { meta: { doc: { z: 'new' }, baseRev: 0 } });
    assert(legacyWrite.kind === 'conflict' && legacyWrite.docs.meta?.rev === 1, 'E-6 store: a client that never saw a rev (base 0) conflicts on a seeded legacy document', legacyWrite);
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * part 12 (2026-09-11, E-4 ⑦): 서버 크레딧 검증 — `server/Economy.ts` + `Store.applyCreditsTx` + `credits:tx`.
 * The reason grammar round trip, every rule of `shared/credits.ts` accepting the exact legit amount and refusing a wrong
 * sign / too much / too little / an unknown id, refunds pairing with their debit (window, double refund), the quest once
 * rule, the contract hourly cap, migrate once + `CREDITS_MAX` clamp, dev reasons gated by `devEconomy`, the ledger through
 * `sanitizeLedger` and the file, and the same rules over the wire on a dev-off and a dev-on relay. Ids and amounts come
 * from the committed table, so a csv change never breaks this part. Its own function (like part 11).
 */
async function part12CreditEconomy(): Promise<void> {
  const T = ECONOMY_TABLE;
  const NOW = 1_800_000_000_000;
  const entries = Object.entries(T.items);
  const [BUY, buyIt] = entries.find(([, it]) => tableMinBuyPrice(T, it.value) >= 10)!;
  const MIN = tableMinBuyPrice(T, buyIt.value);
  const [STACK, stackIt] = entries.find(([, it]) => it.stack > 1 && tableSellPrice(T, it.value, it.stack) >= 2)!;
  const [SOLO] = entries.find(([, it]) => it.stack === 1)!;
  const [REPAIR, FEE] = Object.entries(T.repairFees)[0];
  const [CONTRACT, CREWARD] = Object.entries(T.contracts).find(([, n]) => n > 0)!;
  const [QUEST, QREWARD] = Object.entries(T.quests)[0];
  type TxResult = Extract<ServerToClient, { t: 'credits:result' }>;

  /* the table itself */
  assert(T.v === 1 && T.hash === economyTableDigest(T) && entries.length > 0 && typeof T.repLevelMax === 'number'
    && Object.keys(T.repairFees).length > 0 && Object.keys(T.quests).length > 0,
    'E-4: economy.gen.json loads (JSON import), its hash is the digest of its body', { hash: T.hash, digest: economyTableDigest(T) });
  assert(MIN === Math.max(1, Math.round(buyIt.value * Math.max(T.shopPriceMinMul, T.shopPriceBaseMul - T.shopPriceDiscountPerRep * (T.repLevelMax ?? 0)))),
    'E-4: tableMinBuyPrice = the price at the highest reputation level', { MIN, value: buyIt.value });

  /* grammar */
  const samples: CreditReason[] = [
    { kind: 'buy', id: BUY }, { kind: 'sell', id: STACK, qty: stackIt.stack }, { kind: 'refund', id: BUY }, { kind: 'repair', id: REPAIR },
    { kind: 'refund-repair', id: REPAIR }, { kind: 'contract', id: CONTRACT }, { kind: 'quest', id: QUEST }, { kind: 'migrate', id: '' },
    { kind: 'dev', id: '', tag: 'smoke:meta' }, { kind: 'dev', id: '', tag: 'e2e:probe' }, { kind: 'dev', id: '', tag: 'console' }, { kind: 'dev', id: '', tag: 'shot' },
  ];
  const trips = samples.map((r) => {
    const raw = formatCreditReason(r);
    const b = parseCreditReason(raw);
    return { raw, ok: !!b && b.kind === r.kind && b.id === r.id && (r.qty === undefined || b.qty === r.qty) && (r.tag === undefined || b.tag === r.tag) };
  });
  assert(trips.every((x) => x.ok), 'E-4: formatCreditReason → parseCreditReason round-trips every kind (sell carries its qty)', trips.filter((x) => !x.ok));
  const junk = ['', 'sell', `sell:${STACK}`, `sell:${STACK}:0`, `sell:${STACK}:1.5`, `buy:${BUY}:2`, 'buy:', 'refund:repair:', 'refund:repair:a:b',
    'migrate:x', 'earn:x', 'buy:bad-id', `buy:${'x'.repeat(61)}`, 'smoke', 'e2e', 'revert:buy:x'];
  assert(junk.every((s) => parseCreditReason(s) === null), 'E-4: malformed / unknown reasons parse to null (bare `smoke`, 65 chars, a dash, qty 0, a stray segment)', junk.filter((s) => parseCreditReason(s) !== null));

  /* rules (pure) */
  const eco = new CreditEconomy(T, { dev: false });
  const ecoDev = new CreditEconomy(T, { dev: true });
  const chk = (delta: number, reason: string, ledger?: CreditLedger, balance: number | null = 100_000, at = NOW, e = eco): boolean => e.check(balance, ledger, delta, reason, at).ok;
  assert(chk(-MIN, `buy:${BUY}`) && chk(-(MIN + 500), `buy:${BUY}`), 'E-4: buy accepts the best-discount price and anything above it');
  assert(!chk(-(MIN - 1), `buy:${BUY}`) && !chk(MIN, `buy:${BUY}`) && !chk(0, `buy:${BUY}`) && !chk(-MIN, 'buy:no_such_item_zz'),
    'E-4: buy refuses a price under the best discount, a positive / zero delta and an unknown item');
  const stackMax = tableSellPrice(T, stackIt.value, stackIt.stack);
  assert(chk(stackMax, `sell:${STACK}:${stackIt.stack}`) && chk(1, `sell:${STACK}:1`), 'E-4: sell accepts up to the table price of a full stack');
  assert(!chk(stackMax + 1, `sell:${STACK}:${stackIt.stack}`) && !chk(tableSellPrice(T, stackIt.value, 1), `sell:${STACK}:${stackIt.stack + 1}`)
    && !chk(0, `sell:${STACK}:1`) && !chk(-5, `sell:${STACK}:1`) && !chk(1, `sell:${SOLO}:2`) && !chk(1, 'sell:no_such_item_zz:1'),
    'E-4: sell refuses one credit over the price, qty over the stack (also 2 of an unstackable), zero / negative and an unknown item', { stackMax });
  assert(chk(-FEE, `repair:${REPAIR}`) && !chk(-FEE + 1, `repair:${REPAIR}`) && !chk(-FEE - 1, `repair:${REPAIR}`) && !chk(FEE, `repair:${REPAIR}`) && !chk(-150, 'repair:no_such_implant'),
    'E-4: repair accepts exactly −fee (nothing else, no unknown implant)', { REPAIR, FEE });
  assert(chk(CREWARD, `contract:${CONTRACT}`) && !chk(CREWARD + 1, `contract:${CONTRACT}`) && !chk(-CREWARD, `contract:${CONTRACT}`) && !chk(100, 'contract:no_such_contract'),
    'E-4: contract accepts exactly its reward');
  assert(chk(QREWARD, `quest:${QUEST}`) && !chk(QREWARD - 1, `quest:${QUEST}`) && !chk(100, 'quest:no_such_quest'), 'E-4: quest accepts exactly its reward');
  assert(!chk(1, 'earn') && !chk(1, 'sell') && !chk(45, 'buy:test'), 'E-4: an unknown reason is refused');

  /* refunds pair with a debit */
  const L = emptyLedger();
  const buy = eco.check(100_000, L, -MIN, `buy:${BUY}`, NOW);
  if (buy.ok) eco.commit(L, buy, NOW);
  assert(!chk(MIN + 1, `refund:${BUY}`, L, 100_000, NOW + 1_000) && chk(MIN, `refund:${BUY}`, L, 100_000, NOW + 1_000), 'E-4: refund pairs with the buy (≤ its amount, not more)');
  assert(!chk(MIN, `refund:${BUY}`, L, 100_000, NOW + CREDIT_REFUND_WINDOW_MS + 1), 'E-4: refund outside CREDIT_REFUND_WINDOW_MS is refused');
  assert(!chk(1, `refund:${STACK}`, L, 100_000, NOW + 1_000) && !chk(1, `refund:${BUY}`, emptyLedger(), 100_000, NOW + 1_000), 'E-4: refund of another item / with no debit is refused');
  const r1 = eco.check(100_000, L, MIN - 1, `refund:${BUY}`, NOW + 1_000);
  if (r1.ok) eco.commit(L, r1, NOW + 1_000);
  const r2 = eco.check(100_000, L, 1, `refund:${BUY}`, NOW + 2_000);
  if (r2.ok) eco.commit(L, r2, NOW + 2_000);
  assert(r1.ok && r2.ok && !chk(1, `refund:${BUY}`, L, 100_000, NOW + 3_000), 'E-4: partial refunds add up to the debit, then a further refund is refused', L);
  const rep = eco.check(100_000, L, -FEE, `repair:${REPAIR}`, NOW);
  if (rep.ok) eco.commit(L, rep, NOW);
  const viaBuy = chk(FEE, `refund:${REPAIR}`, L, 100_000, NOW + 500);
  const rr = eco.check(100_000, L, FEE, `refund:repair:${REPAIR}`, NOW + 500);
  if (rr.ok) eco.commit(L, rr, NOW + 500);
  assert(rr.ok && !viaBuy && !chk(FEE, `refund:repair:${REPAIR}`, L, 100_000, NOW + 600) && !chk(FEE, `refund:repair:${REPAIR}`, emptyLedger(), 100_000, NOW + 600),
    'E-4: refund:repair pairs with its repair once (not through refund:<id>, not twice, not without a repair)');

  /* quest once, contract hourly cap */
  const LQ = emptyLedger();
  const q1 = eco.check(0, LQ, QREWARD, `quest:${QUEST}`, NOW);
  if (q1.ok) eco.commit(LQ, q1, NOW);
  assert(q1.ok && !chk(QREWARD, `quest:${QUEST}`, LQ, 0, NOW + 10 * CREDIT_CONTRACT_WINDOW_MS), 'E-4: the second payout of the same quest is refused (ledger, forever)', LQ);
  const LC = emptyLedger();
  let paid = 0;
  for (let i = 0; i < CREDIT_CONTRACT_MAX_PER_HOUR + 1; i++) {
    const cc = eco.check(0, LC, CREWARD, `contract:${CONTRACT}`, NOW + i);
    if (cc.ok) { eco.commit(LC, cc, NOW + i); paid++; }
  }
  assert(paid === CREDIT_CONTRACT_MAX_PER_HOUR && chk(CREWARD, `contract:${CONTRACT}`, LC, 0, NOW + CREDIT_CONTRACT_WINDOW_MS + CREDIT_CONTRACT_MAX_PER_HOUR),
    `E-4: contract payouts stop at ${CREDIT_CONTRACT_MAX_PER_HOUR} per rolling hour and open again after it`, { paid });

  /* migrate, dev */
  const m1 = eco.check(null, undefined, T.creditsMax + 12_345, 'migrate', NOW);
  const m0 = eco.check(null, undefined, -50, 'migrate', NOW);
  assert(m1.ok && m1.delta === T.creditsMax && m1.seed && m0.ok && m0.delta === 0 && !chk(10, 'migrate', undefined, 0) && !chk(10, 'migrate', undefined, 500),
    'E-4: migrate only on a null balance, clamped to [0, CREDITS_MAX]', { m1, m0 });
  const devTags = ['console', 'smoke:meta', 'e2e:probe', 'shot'];
  assert(devTags.every((tag) => !chk(5, tag)) && devTags.every((tag) => chk(-5, tag, undefined, 100, NOW, ecoDev)) && !chk(-MIN + 1, `buy:${BUY}`, undefined, 100, NOW, ecoDev),
    'E-4: dev reasons are refused without devEconomy and accepted with it (the other rules stay on)');
  assert(devEconomyFromEnv({ SCAV_DEV_ECONOMY: '1' }, []) && devEconomyFromEnv({}, ['--dev-economy']) && !devEconomyFromEnv({}, []) && !devEconomyFromEnv({ SCAV_DEV_ECONOMY: '0' }, []),
    'E-4: devEconomyFromEnv reads SCAV_DEV_ECONOMY=1 / --dev-economy, off otherwise');

  /* ledger sanitize */
  const hostile = sanitizeLedger({
    quests: [QUEST, QUEST, 3, 'bad-id', 'x'.repeat(70)],
    contractsAt: [NOW - 10, NOW + 1e9, 'x', NOW - CREDIT_CONTRACT_WINDOW_MS - 5],
    debits: [
      { reason: 'buy:a', amount: 50, at: NOW - 1_000, refunded: 80 },
      { reason: 'buy:b', amount: Number.NaN, at: NOW, refunded: 0 },
      { reason: 'buy:c', amount: 10, at: NOW - CREDIT_REFUND_WINDOW_MS - 1, refunded: 0 },
      { reason: 'buy:d', amount: 10.7, at: NOW + 1e9, refunded: -3 },
    ],
  }, NOW);
  assert(!!hostile && JSON.stringify(hostile.quests) === JSON.stringify([QUEST]) && JSON.stringify(hostile.contractsAt) === JSON.stringify([NOW - 10, NOW])
    && hostile.debits.length === 1 && hostile.debits[0].reason === 'buy:d' && hostile.debits[0].amount === 10 && hostile.debits[0].at === NOW && hostile.debits[0].refunded === 0,
    'E-4: sanitizeLedger drops junk / duplicates, clamps future stamps and refunded, prunes expired + fully refunded debits', hostile);
  const many = sanitizeLedger({ debits: Array.from({ length: CREDIT_LEDGER_DEBITS_MAX + 40 }, () => ({ reason: 'buy:x', amount: 5, at: NOW, refunded: 0 })) }, NOW);
  assert(many?.debits.length === CREDIT_LEDGER_DEBITS_MAX && sanitizeLedger(42, NOW) === null && sanitizeLedger({}, NOW) === null,
    `E-4: the debit list is capped at ${CREDIT_LEDGER_DEBITS_MAX}; an empty / non-object ledger is dropped`);

  /* store: ledger through the file */
  const dir = mkdtempSync(join(tmpdir(), 'scav-econ-'));
  try {
    const s1 = new ProfileStore({ dataDir: dir, saveDebounceMs: 60_000, quiet: true });
    const seeded = s1.applyCreditsTx('e1', 3_000, 'migrate', eco);
    const bought = s1.applyCreditsTx('e1', -MIN, `buy:${BUY}`, eco);
    const quest = s1.applyCreditsTx('e1', QREWARD, `quest:${QUEST}`, eco);
    const over = s1.applyCreditsTx('e1', -1_000_000_000, `buy:${BUY}`, eco);
    assert(seeded.ok && bought.ok && quest.ok && !over.ok && over.reason === '크레딧 부족' && s1.ledgerOf('e1')?.debits.length === 1,
      'E-4: Store.applyCreditsTx — an overdraft refused by the balance writes nothing to the ledger', s1.ledgerOf('e1'));
    s1.close();
    const onDisk = (JSON.parse(readFileSync(join(dir, PROFILE_FILE), 'utf8')) as { profiles: Record<string, { ledger?: CreditLedger }> }).profiles.e1?.ledger;
    const s2 = new ProfileStore({ dataDir: dir, saveDebounceMs: 60_000, quiet: true });
    const l2 = s2.ledgerOf('e1');
    assert(!!onDisk && !!l2 && l2.quests.includes(QUEST) && l2.debits.length === 1 && l2.debits[0].reason === `buy:${BUY}` && l2.debits[0].amount === MIN,
      'E-4: the ledger survives profiles.json (quests + debits)', { onDisk, l2 });
    assert(!s2.applyCreditsTx('e1', QREWARD, `quest:${QUEST}`, eco).ok && s2.applyCreditsTx('e1', MIN, `refund:${BUY}`, eco).ok,
      'E-4: after a restart the quest stays paid and a refund still pairs with the debit written before it');
    assert(!('ledger' in s2.snapshot('e1')), 'E-4: ProfileStore.snapshot (welcome.profile / profile:docs) never carries the ledger');
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  /* wire: a relay without devEconomy (the shipped default) */
  const srv = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: GRACE_MS, dataDir: null });
  const url = `ws://127.0.0.1:${srv.port}${NET_WS_PATH}`;
  let txId = 0;
  const txOf = (cl: TestClient) => async (delta: number, reason: string): Promise<TxResult> => {
    const id = ++txId;
    cl.send({ t: 'credits:tx', txId: id, delta, reason });
    return cl.wait('credits:result', (mm) => mm.txId === id);
  };
  try {
    const { c: a } = await connect('E12a', url, { token: makeToken('e'), name: '상한' });
    const txa = txOf(a);
    const ma = await txa(T.creditsMax + 5_000, 'migrate');
    const ma2 = await txa(10, 'migrate');
    const capSell = await txa(tableSellPrice(T, stackIt.value, 1), `sell:${STACK}:1`);
    assert(ma.ok && ma.credits === T.creditsMax && !ma2.ok && ma2.reason === CREDIT_TX_INVALID_KO && ma2.credits === T.creditsMax && capSell.ok && capSell.credits === T.creditsMax,
      'E-4 wire: migrate clamps to CREDITS_MAX, a second migrate is refused, a credit never lifts the balance past CREDITS_MAX', { ma, ma2, capSell });
    a.close();

    const TB = makeToken('f');
    let { c: b } = await connect('E12b', url, { token: TB, name: '거래' });
    let txb = txOf(b);
    const seq: [string, TxResult][] = [];
    const step = async (label: string, delta: number, reason: string): Promise<TxResult> => {
      const r = await txb(delta, reason);
      seq.push([label, r]);
      return r;
    };
    await step('migrate', 5_000, 'migrate');
    const sb = await step('buy', -MIN, `buy:${BUY}`);
    const sr = await step('refund', MIN, `refund:${BUY}`);
    const sr2 = await step('refund again', MIN, `refund:${BUY}`);
    const ss = await step('sell', stackMax, `sell:${STACK}:${stackIt.stack}`);
    const sq = await step('quest', QREWARD, `quest:${QUEST}`);
    const sq2 = await step('quest again', QREWARD, `quest:${QUEST}`);
    const sp = await step('repair', -FEE, `repair:${REPAIR}`);
    const spr = await step('refund:repair', FEE, `refund:repair:${REPAIR}`);
    const sc = await step('contract', CREWARD, `contract:${CONTRACT}`);
    const sd = await step('smoke', 1, 'smoke:x');
    const sco = await step('console', 1, 'console');
    const su = await step('unknown', -100, 'buy:test');
    const expect = 5_000 + stackMax + QREWARD + CREWARD;
    assert(sb.ok && sb.credits === 5_000 - MIN && sr.ok && sr.credits === 5_000 && ss.ok && sq.ok && sp.ok && spr.ok && sc.ok,
      'E-4 wire: buy → refund → sell (full stack) → quest → repair → refund:repair → contract are accepted with the legit amounts', seq);
    assert([sr2, sq2, sd, sco, su].every((r) => !r.ok && r.reason === CREDIT_TX_INVALID_KO) && su.credits === expect,
      'E-4 wire: double refund / quest twice / smoke:* / console / buy:test → credits:result {ok:false, reason: CREDIT_TX_INVALID_KO}, balance kept', { sr2, sq2, sd, sco, su, expect });
    b.send({ t: 'profile:get' });
    const docsB = await b.wait('profile:docs');
    assert(docsB.profile.credits === expect && !('ledger' in docsB.profile) && (srv.store.ledgerOf(b.id)?.quests ?? []).includes(QUEST),
      'E-4 wire: profile:docs carries the balance but never the ledger (the relay keeps it)', { credits: docsB.profile.credits, keys: Object.keys(docsB.profile) });
    b.close();
    await b.closed();
    ({ c: b } = await connect('E12b2', url, { token: TB, name: '거래' }));
    txb = txOf(b);
    const sq3 = await txb(QREWARD, `quest:${QUEST}`);
    assert(!sq3.ok && sq3.credits === expect, 'E-4 wire: the quest stays paid across a reconnect', sq3);
    b.close();
  } finally {
    await srv.close();
  }

  /* wire: a relay with devEconomy (verify runner / e2e / dev:all) */
  const dev = await startRelayServer({ port: 0, host: '127.0.0.1', quiet: true, heartbeatMs: 1_000, reconnectGraceMs: GRACE_MS, dataDir: null, devEconomy: true });
  try {
    const { c: d } = await connect('E12d', `ws://127.0.0.1:${dev.port}${NET_WS_PATH}`, { token: makeToken('g'), name: '개발' });
    const txd = txOf(d);
    const d1 = await txd(77, 'smoke:seed');
    const d2 = await txd(0, 'e2e:probe');
    const d3 = await txd(-9_999_999, 'e2e:overdraft');
    const d4 = await txd(-1, 'buy:no_such_item_zz');
    assert(d1.ok && d1.credits === 77 && d2.ok && !d3.ok && d3.reason === '크레딧 부족' && !d4.ok && d4.reason === CREDIT_TX_INVALID_KO,
      'E-4 wire (devEconomy): smoke:* / e2e:* accepted, an overdraft still 크레딧 부족, a bad buy still refused', { d1, d2, d3, d4 });
    d.close();
  } finally {
    await dev.close();
  }
}

main().catch((e) => { console.error('selftest crashed', e); process.exit(1); });
