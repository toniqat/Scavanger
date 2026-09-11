/**
 * Entry point: `node server/index.ts` (or `npm run server`).
 * PORT env (default NET_DEFAULT_PORT = 8787), HOST env (default 0.0.0.0).
 * 2026-09-11 (C-41): `--data=<dir>` / `SCAV_DATA_DIR` moves the profile store (default `server/data/`). The verify
 * runner points the relay it starts itself at a temp folder so smoke runs stop piling test profiles into the dev store.
 */
import { startRelayServer } from './RelayServer.ts';
import { devEconomyFromEnv } from './Economy.ts';

const dataArg = process.argv.slice(2).find((a) => a.startsWith('--data='))?.slice('--data='.length);
const dataDir = dataArg || process.env.SCAV_DATA_DIR || undefined;
/* 2026-09-11 (E-4 ⑦): `SCAV_DEV_ECONOMY=1` / `--dev-economy` accepts the dev credit reasons (console · smoke:* · e2e:* · shot).
   Only the relay scripts/verify.mjs starts itself sets it; `npm run dev:all` · start-server.bat · `npm run server` leave it off. */
const devEconomy = devEconomyFromEnv();

const server = await startRelayServer({ ...(dataDir ? { dataDir } : {}), devEconomy });

const shutdown = (signal: string): void => {
  console.log(`[relay] ${signal} → shutting down`);
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('[relay] uncaughtException', e); });
process.on('unhandledRejection', (e) => { console.error('[relay] unhandledRejection', e); });
