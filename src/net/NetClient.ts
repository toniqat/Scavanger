import type { ClientToServer, NetStatus, PeerId, ServerToClient } from '@/shared';

/** Server → client message types we accept; anything else is dropped with a warning. */
const SERVER_TYPES: ReadonlySet<string> = new Set([
  'welcome', 'lobby:state', 'lobby:error', 'lobby:left', 'game:start', 'relay', 'peer:left', 'pong',
  /* Phase 7 */
  'profile:docs', 'credits:result',
  /* Phase 11: 소셜 (the snapshots are small — MAX_INBOUND_BYTES is unchanged) */
  'social:state', 'social:invited', 'social:whisper', 'social:play', 'social:error',
]);
const PING_INTERVAL_MS = 2000;
/** `welcome` may carry every profile document (5 × PROFILE_DOC_MAX_BYTES) plus a raid blob. */
const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

/**
 * Thin WebSocket transport for the relay server: JSON framing, welcome handshake, RTT pings, status changes.
 * Knows nothing about lobbies or gameplay — NetSystem interprets the messages.
 */
export class NetClient {
  status: NetStatus = 'offline';
  localId: PeerId | null = null;
  rttMs = 0;
  /**
   * `serverTime - performance.now()` from the last `welcome` / `pong`. Adding `performance.now()` back gives the
   * relay's wall clock in epoch ms (`NetRef.serverNow()`); only valid while `hasServerTime` is true.
   */
  serverTimeOffset = 0;
  /** True once a `welcome`/`pong` supplied a server clock on the current connection (reset by `teardown`). */
  hasServerTime = false;

  onMessage: ((msg: ServerToClient) => void) | null = null;
  onStatus: ((status: NetStatus, reason?: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private url = '';

  get connected(): boolean { return this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN; }

  /** Idempotent: while connecting returns the same promise; when connected resolves immediately. */
  connect(url: string): Promise<void> {
    if (this.connected && this.url === url) return Promise.resolve();
    if (this.connectPromise && this.url === url) return this.connectPromise;
    if (this.ws) this.teardown();
    this.url = url;
    this.setStatus('connecting');

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.connectPromise = null;
        this.setStatus('error', (e as Error).message);
        reject(e);
        return;
      }
      this.ws = ws;
      let welcomed = false;
      /**
       * 2026-09-11 (C-29): the server's own Korean reason when it is about to close us on purpose (`kicked` by the
       * operator, `server_full` before any welcome). Used as the close reason instead of the generic transport text.
       */
      let refusal: string | null = null;

      const finishFail = (reason: string): void => {
        if (this.ws !== ws) return;
        this.connectPromise = null;
        this.teardown();
        this.setStatus('error', reason);
        if (!welcomed) reject(new Error(reason));
      };

      ws.onopen = () => { /* wait for welcome */ };
      ws.onerror = () => { if (!welcomed) finishFail('서버에 연결할 수 없습니다.'); };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        const reason = refusal ?? (welcomed ? (ev.wasClean ? '연결이 종료되었습니다.' : '서버와의 연결이 끊어졌습니다.') : '서버에 연결할 수 없습니다.');
        this.connectPromise = null;
        this.teardown();
        this.setStatus(welcomed && ev.wasClean ? 'offline' : 'error', reason);
        if (!welcomed) reject(new Error(reason));
      };
      ws.onmessage = (ev) => {
        const msg = this.decode(ev.data);
        if (!msg) return;
        if (msg.t === 'welcome') {
          if (welcomed) return;
          welcomed = true;
          this.localId = msg.id;
          // Server clock available from the handshake on, so `serverNow()` is right before the first pong.
          this.serverTimeOffset = msg.serverTime - performance.now();
          this.hasServerTime = true;
          this.connectPromise = null;
          this.setStatus('connected');
          this.startPing();
          resolve();
          this.onMessage?.(msg);
          return;
        }
        if (msg.t === 'pong') {
          this.rttMs = Math.max(0, Math.round(performance.now() - msg.ts));
          this.serverTimeOffset = msg.serverTime - performance.now();
          this.hasServerTime = true;
        }
        // C-29: a refusal (`kicked` / `server_full`) is the one frame that matters even before the handshake — the
        // server closes right after it, and NetSystem must learn *why* so it stops the reconnect loop.
        const refused = msg.t === 'lobby:error' && (msg.code === 'kicked' || msg.code === 'server_full');
        if (refused) refusal = msg.message;
        if (!welcomed) { if (refused) this.onMessage?.(msg); return; } // ignore anything else before the handshake
        this.onMessage?.(msg);
      };
    });
    return this.connectPromise;
  }

  /** Returns false when the message was not sent (not connected / encode failure). */
  send(msg: ClientToServer): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.status !== 'connected') return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.warn('[net] send failed', e);
      return false;
    }
  }

  /** Clean close; status → 'offline'. */
  close(): void {
    const ws = this.ws;
    this.connectPromise = null;
    this.teardown();
    if (ws) { try { ws.close(1000, 'client closed'); } catch { /* ignore */ } }
    this.setStatus('offline');
  }

  private teardown(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    const ws = this.ws;
    if (ws) {
      ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }
    this.ws = null;
    this.localId = null;
    this.rttMs = 0;
    this.hasServerTime = false;
    this.serverTimeOffset = 0;
  }

  private startPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => { this.send({ t: 'ping', ts: performance.now() }); }, PING_INTERVAL_MS);
  }

  private setStatus(status: NetStatus, reason?: string): void {
    if (this.status === status && !reason) return;
    this.status = status;
    this.onStatus?.(status, reason);
  }

  private decode(data: unknown): ServerToClient | null {
    if (typeof data !== 'string') { console.warn('[net] non-text frame dropped'); return null; }
    if (data.length > MAX_INBOUND_BYTES) { console.warn('[net] oversized frame dropped'); return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { console.warn('[net] malformed JSON dropped'); return null; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { console.warn('[net] non-object frame dropped'); return null; }
    const t = (parsed as { t?: unknown }).t;
    if (typeof t !== 'string' || !SERVER_TYPES.has(t)) { console.warn('[net] unknown server message dropped', t); return null; }
    return parsed as ServerToClient;
  }
}
