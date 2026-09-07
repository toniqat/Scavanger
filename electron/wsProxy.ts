/**
 * WebSocket pass-through for `--relay=<url>` (play on someone else's relay).
 *
 * The renderer always dials the same origin it was loaded from (`NetSystem.defaultUrl()`), so pointing the desktop
 * app at a remote relay means forwarding the upgrade rather than rewriting the client's URL. This is a raw byte
 * pipe: the relay protocol (and its `?t=` / `?n=` session query) passes through untouched.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { IncomingMessage, Server as HttpServer } from 'node:http';

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

export function attachWsProxy(server: HttpServer, target: URL, onError?: (e: Error) => void): void {
  const secure = target.protocol === 'wss:';
  const port = Number(target.port || (secure ? 443 : 80));

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const path = (req.url ?? '/').split('?')[0];
    const query = (req.url ?? '').slice(path?.length ?? 0);
    if (path !== target.pathname) { socket.destroy(); return; }

    const opts = { host: target.hostname, port };
    const up = secure ? tlsConnect({ ...opts, servername: target.hostname }) : netConnect(opts);
    const ready = secure ? 'secureConnect' : 'connect';

    const fail = (e: Error): void => { onError?.(e); socket.destroy(); up.destroy(); };
    up.on('error', fail);
    socket.on('error', fail);

    up.once(ready, () => {
      up.write(requestHead(req, target, query));
      if (head.length) up.write(head);
      socket.setNoDelay(true);
      up.setNoDelay(true);
      up.pipe(socket);
      socket.pipe(up);
    });
  });
}
