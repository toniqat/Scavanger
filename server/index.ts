/**
 * Entry point: `node server/index.ts` (or `npm run server`).
 * PORT env (default NET_DEFAULT_PORT = 8787), HOST env (default 0.0.0.0).
 */
import { startRelayServer } from './RelayServer.ts';

const server = await startRelayServer();

const shutdown = (signal: string): void => {
  console.log(`[relay] ${signal} → shutting down`);
  void server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('[relay] uncaughtException', e); });
process.on('unhandledRejection', (e) => { console.error('[relay] unhandledRejection', e); });
