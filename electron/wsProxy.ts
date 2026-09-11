/**
 * WebSocket pass-through for the window's own http server: `/ws` → the relay in play.
 *
 * The renderer always dials the same origin it was loaded from (`NetSystem.defaultUrl()`), so pointing the desktop
 * app at a relay means forwarding the upgrade rather than rewriting the client's URL. This is a raw byte
 * pipe: the relay protocol (and its `?t=` / `?n=` session query) passes through untouched.
 *
 * **2026-09-11 (C-28) — 목적지는 늦게 정해질 수 있다.** 임베디드 릴레이는 `/ws` 업그레이드가 처음 들어올 때
 * 켜지므로(`electron/main.ts` 의 `ensureEmbedded`), 목적지로 `URL` 대신 `{ path, resolve }` 를 받는다. `path` 는
 * 미리 알아야 한다(아닌 경로는 곧바로 끊는다). 시작을 기다리는 동안 업그레이드 요청 뒤에 붙어 온 바이트
 * (`head`)는 클로저에 그대로 들고 있고, 소켓은 http 서버가 `readableFlowing = null` 로 넘겨주므로 그 사이에 온
 * 데이터도 `pipe` 를 붙이는 순간까지 소켓 버퍼에 남는다 — 잃는 바이트가 없다.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { IncomingMessage, Server as HttpServer } from 'node:http';

/** A destination decided on the first upgrade (the embedded relay starts on demand). */
export interface LazyProxyTarget {
  /** The only accepted upgrade path (known up front — anything else is dropped at once). */
  readonly path: string;
  /** Resolves the upstream relay URL. Called for every upgrade; the implementation memoises. */
  resolve(): Promise<URL>;
}

/** Rebuild the request head for the upstream relay, swapping in its Host and path. */
function requestHead(req: IncomingMessage, target: URL, query: string): string {
  const lines = [`GET ${target.pathname}${query} HTTP/1.1`];
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i] ?? '';
    if (key.toLowerCase() === 'host') continue;
    lines.push(`${key}: ${raw[i + 1] ?? ''}`);
  }
  lines.push(`Host: ${target.host}`);
  return lines.join('\r\n') + '\r\n\r\n';
}

/** Pipe one accepted upgrade to `target` (the socket may have been waiting for a lazy start). */
function pipeTo(req: IncomingMessage, socket: Socket, head: Buffer, target: URL, query: string, onError?: (e: Error) => void): void {
  const secure = target.protocol === 'wss:';
  const port = Number(target.port || (secure ? 443 : 80));
  const opts = { host: target.hostname, port };
  const up = secure ? tlsConnect({ ...opts, servername: target.hostname }) : netConnect(opts);
  const ready = secure ? 'secureConnect' : 'connect';

  const fail = (e: Error): void => { onError?.(e); socket.destroy(); up.destroy(); };
  up.on('error', fail);
  socket.on('error', fail);
  // The page gave up while we were connecting — drop the upstream socket too.
  socket.once('close', () => up.destroy());

  up.once(ready, () => {
    up.write(requestHead(req, target, query));
    if (head.length) up.write(head);
    socket.setNoDelay(true);
    up.setNoDelay(true);
    up.pipe(socket);
    socket.pipe(up);
  });
}

export function attachWsProxy(server: HttpServer, target: URL | LazyProxyTarget, onError?: (e: Error) => void): void {
  const wsPath = target instanceof URL ? target.pathname : target.path;

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0];
    const query = (req.url ?? '').slice(path?.length ?? 0);
    if (path !== wsPath) { socket.destroy(); return; }

    if (target instanceof URL) { pipeTo(req, socket, head, target, query, onError); return; }

    // Lazy: keep the socket (and `head`) until the relay is up. An error before then must not crash the process.
    const early = (e: Error): void => { onError?.(e); };
    socket.on('error', early);
    target.resolve().then(
      (url) => {
        socket.off('error', early);
        if (socket.destroyed) return;
        pipeTo(req, socket, head, url, query, onError);
      },
      (e: unknown) => {
        onError?.(e instanceof Error ? e : new Error(String(e)));
        socket.destroy();
      },
    );
  });
}
