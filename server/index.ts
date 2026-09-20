/**
 * Entry point: `node server/index.ts` (or `npm run server`) — **the only way to run a server** (2026-09-15, user decision:
 * builds ship no server; `start-server.bat` in this repo runs this file, directly in `relay` mode or through
 * `scripts/dev-all.mjs` by default).
 *
 * `--port=<n>` / PORT env (default NET_DEFAULT_PORT = 8787), `--host=<addr>` / HOST env (default 0.0.0.0).
 * 2026-09-11 (C-41): `--data=<dir>` / `SCAV_DATA_DIR` moves the profile store (default `server/data/`). The verify
 * runner points the relay it starts itself at a temp folder so smoke runs stop piling test profiles into the dev store.
 * 2026-09-15: `--max=<n>` / `SCAV_MAX_CLIENTS` = connection cap at startup (console `max` changes it later), and the
 * operator console (`server/Console.ts`) reads stdin — harmless when stdin is ignored or closed.
 */
import { startRelayServer, type RelayServer } from './RelayServer.ts';
import { devEconomyFromEnv } from './Economy.ts';
import { CONSOLE_COMMANDS_LINE, startServerConsole } from './Console.ts';
import { NET_DEFAULT_PORT } from '../src/shared/net.ts';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const dataDir = arg('data') || process.env.SCAV_DATA_DIR || undefined;
const portArg = Number(arg('port'));
const port = Number.isInteger(portArg) && portArg > 0 ? portArg : undefined;
const host = arg('host') || undefined;
const maxClients = Number(arg('max') ?? process.env.SCAV_MAX_CLIENTS ?? 0) || null;
/* 2026-09-11 (E-4 ⑦): `SCAV_DEV_ECONOMY=1` / `--dev-economy` accepts the dev credit reasons (console · smoke:* · e2e:* · shot).
   Only the relay scripts/verify.mjs starts itself sets it; `npm run dev:all` · start-server.bat · `npm run server` leave it off. */
const devEconomy = devEconomyFromEnv();

/*
 * 2026-09-15: **the relay keeps running when its console is gone.** A relay left behind by `npm run verify …
 * --keep-relay` loses the *reading end* of its stdout pipe the moment the runner exits. A log line then throws EPIPE,
 * an unhandled stream error rises as an uncaughtException, and the handler at the end of this file throws the same
 * EPIPE while trying to print it with `console.error` — the event loop is caught in that loop, eats 100 % of one core
 * and answers ever later as discarded writes pile up (after about an hour a ping round trip is 1 s — a relay that
 * late brings a whole two-client smoke down). With a listener attached a stream error never becomes an
 * uncaughtException — only the log is lost and the relay carries on.
 */
process.stdout.on('error', () => { /* the console is gone — drop this line and keep serving */ });
process.stderr.on('error', () => { /* the same */ });

let server: RelayServer;
try {
  server = await startRelayServer({
    ...(dataDir ? { dataDir } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(host ? { host } : {}),
    maxClients,
    devEconomy,
  });
} catch (e: unknown) {
  const msg = (e as Error)?.message ?? String(e);
  const tried = port ?? (Number(process.env.PORT ?? NET_DEFAULT_PORT) || NET_DEFAULT_PORT);
  console.error(`[relay] 서버를 시작하지 못했습니다: ${msg}`);
  if (/EADDRINUSE|EACCES/i.test(msg)) {
    console.error(`[relay]   포트 ${tried} 를 이미 다른 프로그램이 쓰고 있거나 Windows 가 예약해 두었습니다.`);
    console.error('[relay]   start-server.bat 가 이미 켜져 있는지 먼저 확인하세요. 다른 포트로 켜려면 --port=<n>');
    console.error('[relay]   (그 경우 접속하는 사람도 주소 끝에 같은 포트를 적어야 합니다)');
  }
  // The stores · the quote timer may already be running — this exits without waiting for them.
  process.exit(1);
}

// The command line is announced only when a person can type (a TTY, or dev-all forwarding its own window's input).
const consoleInput = startServerConsole(server);
if (consoleInput && (process.stdin.isTTY || process.env.SCAV_CONSOLE === '1')) {
  console.log(`[relay] 콘솔 명령: ${CONSOLE_COMMANDS_LINE}   (이 창에 치고 Enter)`);
}

const shutdown = (signal: string): void => {
  console.log(`[relay] ${signal} → shutting down`);
  consoleInput?.close();
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
/**
 * Writes one line for an uncaught error and **keeps running** (better than losing the whole relay).
 * A throw while reporting ends it there — a second guard over the loop above (EPIPE → uncaughtException → EPIPE).
 */
let reporting = false;
const report = (label: string, e: unknown): void => {
  if (reporting) return;
  reporting = true;
  try { console.error(`[relay] ${label}`, e); } catch { /* nowhere left to write */ }
  reporting = false;
};
process.on('uncaughtException', (e) => report('uncaughtException', e));
process.on('unhandledRejection', (e) => report('unhandledRejection', e));
