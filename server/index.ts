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
 * 2026-09-15: **콘솔이 끊겨도 릴레이는 계속 돈다.** `npm run verify … --keep-relay` 가 남긴 릴레이는 러너가 끝나는
 * 순간 표준 출력 파이프의 *읽는 쪽*을 잃는다. 그 뒤 로그 한 줄이 EPIPE 를 던지고, 처리되지 않은 스트림 오류는
 * uncaughtException 으로 올라오며, 파일 끝의 핸들러가 그것을 다시 `console.error` 로 찍으려다 같은 EPIPE 를
 * 던진다 — 이벤트 루프가 그 고리에 갇혀 한 코어를 100 % 먹고, 버려진 쓰기가 쌓이면서 응답이 점점 늦어진다
 * (한 시간쯤 지나면 ping 왕복이 1 초 — 중계가 늦는 만큼 두 클라이언트 스모크가 통째로 무너진다).
 * 리스너를 달아 두면 스트림 오류가 uncaughtException 이 되지 않는다 — 로그만 잃고 중계는 멀쩡히 이어진다.
 */
process.stdout.on('error', () => { /* 콘솔이 사라졌다 — 이 줄은 버리고 계속 서비스한다 */ });
process.stderr.on('error', () => { /* 같다 */ });

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
  // 저장소 · 시세 타이머가 이미 돌고 있을 수 있다 — 기다리지 않고 끝낸다.
  process.exit(1);
}

// 명령 줄은 사람이 입력할 수 있을 때만 알린다 (터미널이거나, dev-all 이 자기 창의 입력을 넘겨주는 중).
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
 * 잡지 못한 오류를 한 줄 적고 **계속 돈다** (릴레이가 통째로 죽는 것보다 낫다).
 * 보고하다가 또 터지면 그대로 끝낸다 — 위 주석의 고리(EPIPE → uncaughtException → EPIPE)를 두 겹으로 막는다.
 */
let reporting = false;
const report = (label: string, e: unknown): void => {
  if (reporting) return;
  reporting = true;
  try { console.error(`[relay] ${label}`, e); } catch { /* 적을 곳이 없다 */ }
  reporting = false;
};
process.on('uncaughtException', (e) => report('uncaughtException', e));
process.on('unhandledRejection', (e) => report('unhandledRejection', e));
