/**
 * Relay server self-test: `node server/selftest.ts` (or `npm run net:selftest`).
 * Boots the server on a random port (with a 300 ms reconnect grace), drives WebSocket clients (Node 24 global
 * WebSocket) through the lobby / relay / disconnect / reconnect / quick-match flows and exits 0 on success,
 * 1 on the first failed assertion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientToServer, ServerToClient, LobbyState } from '../src/shared/net.ts';
import type { RaidSessionBlob } from '../src/shared/profile.ts';
import { NET_WS_PATH, NET_TOKEN_PARAM, NET_NAME_PARAM, NET_TOKEN_LENGTH } from '../src/shared/net.ts';
import { PROFILE_DOC_MAX_BYTES, RAID_BLOB_MAX_BYTES } from '../src/shared/profile.ts';
import { startRelayServer, peerIdFromToken, PEER_ID_LENGTH } from './RelayServer.ts';
import { ProfileStore } from './Store.ts';

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

    /* start */
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
    e.send({ t: 'lobby:start', seed: 77 });
    const gs = await e.wait('game:start');
    assert(gs.seed === 77 && gs.lobby.started && gs.lobby.players.length === 2, 'start succeeds while a not-ready member is disconnected (allReady ignores dropped members)', gs.lobby);

    /* G reconnects into the started lobby → welcome.lobby.started (mission in progress → rejoin path) */
    ({ c: g } = await connect('G2', url, { token: T3, name: 'Golf' }));
    assert(g.lobby?.code === codeE && g.lobby.started === true && g.lobby.seed === 77, 'reconnect into a started lobby → welcome.lobby.started with the seed', g.lobby);
    await e.wait('lobby:state', (m) => m.lobby.players.find((p) => p.id === g.id)?.connected === true);
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
    const hostExpired = await g.wait('peer:left', (m) => m.id === e.id, GRACE_MS + 1500);
    assert(hostExpired.lobby.hostId === g.id && hostExpired.lobby.players.find((p) => p.id === g.id)?.isHost === true && hostExpired.lobby.started,
      'grace expiry while started → peer:left + host migrated to G', hostExpired.lobby);
    g.send({ t: 'lobby:reset' });
    await g.wait('lobby:state', (m) => !m.lobby.started);
    pass('new host reset after the mission');
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
    assert(uw.profile !== undefined && uw.profile.credits === null && Object.keys(uw.profile.docs).length === 0 && uw.raid === undefined,
      'token connect → welcome.profile {credits:null, docs:{}} (fresh record)', uw.profile);
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
    u.send({ t: 'profile:set', key: 'meta', doc: { credits: 8 } });
    u.send({ t: 'profile:get' });
    docs = await u.wait('profile:docs');
    assert(JSON.stringify(docs.profile.docs.meta) === '{"credits":8}' && JSON.stringify(docs.profile.docs.stash) === '[1,2,3]', 'profile:set replaces one key, keeps the others');
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
    u.sendRaw(JSON.stringify({ t: 'relay', to: 'all', d: { t: 'chat', text: 'y'.repeat(70 * 1024) } }));
    err = await u.wait('lobby:error');
    assert(err.code === 'invalid', 'ordinary frames keep the 64 KB cap (oversized relay → invalid)');

    /* credits transactions */
    u.send({ t: 'credits:tx', txId: 1, delta: -100, reason: 'buy:test' });
    let cr = await u.wait('credits:result', (m) => m.txId === 1);
    assert(cr.ok === false && cr.credits === 0 && cr.reason === '크레딧 부족', 'credits:tx below zero on a null balance → refused with 크레딧 부족', cr);
    u.send({ t: 'credits:tx', txId: 2, delta: 500, reason: 'migrate' });
    cr = await u.wait('credits:result', (m) => m.txId === 2);
    assert(cr.ok === true && cr.credits === 500 && cr.reason === undefined, "first 'migrate' tx seeds the balance with delta", cr);
    u.send({ t: 'credits:tx', txId: 3, delta: 9999, reason: 'migrate' });
    cr = await u.wait('credits:result', (m) => m.txId === 3);
    assert(cr.ok === true && cr.credits === 500, "second 'migrate' is a no-op (balance kept)", cr);
    u.send({ t: 'credits:tx', txId: 4, delta: -120, reason: 'buy:wpn_ar23' });
    cr = await u.wait('credits:result', (m) => m.txId === 4);
    assert(cr.ok === true && cr.credits === 380, 'debit applied atomically → 380', cr);
    u.send({ t: 'credits:tx', txId: 5, delta: -381, reason: 'buy:too_much' });
    cr = await u.wait('credits:result', (m) => m.txId === 5);
    assert(cr.ok === false && cr.credits === 380 && cr.reason === '크레딧 부족', 'overdraft refused, balance unchanged', cr);
    u.send({ t: 'credits:tx', txId: 6, delta: 45.9, reason: 'sell' });
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
    } finally {
      await server2.close();
    }

    /* ══════════════════════════ part 7: profile store file round-trip ══════════════════════════ */
    const dir = mkdtempSync(join(tmpdir(), 'scav-store-'));
    try {
      const s1 = new ProfileStore({ dataDir: dir, saveDebounceMs: 20, quiet: true });
      assert(s1.get('p1').credits === null && s1.size === 1, 'store.get creates an empty record');
      s1.setDoc('p1', 'meta', { a: 1 });
      const tx = s1.applyCredits('p1', 300, 'migrate');
      assert(tx.ok && tx.credits === 300, 'store migrate seeds credits');
      assert(s1.applyCredits('p1', -301, 'buy').ok === false && s1.applyCredits('p1', -300, 'buy').credits === 0, 'store refuses overdraft, allows exact spend');
      s1.get('untouched');
      await sleep(80);
      assert(s1.writeCount === 1, 'debounced write happened once', s1.writeCount);
      s1.close();
      const s2 = new ProfileStore({ dataDir: dir, quiet: true });
      assert(s2.size === 1 && s2.get('p1').credits === 0 && JSON.stringify(s2.get('p1').docs.meta) === '{"a":1}' && !s2.has('untouched'),
        'a new store reloads the file: credits + docs kept, placeholder records not persisted', s2.get('p1'));
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

main().catch((e) => { console.error('selftest crashed', e); process.exit(1); });
