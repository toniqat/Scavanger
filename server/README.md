# server — WebSocket relay (lobbies + opaque message relay)

Small Node server that owns lobbies and forwards `GameMessage`s between lobby members. It never inspects relayed
payloads; the lobby host is the gameplay authority (see `src/shared/net.ts`).

Runs directly under **Node 24 native type stripping** — no build step, no `tsx`. Rules for these files: erasable
TypeScript only (no enums / namespaces / parameter properties), explicit `.ts` extensions on relative imports,
`import type` for anything type-only. Runtime constants/helpers are value-imported from `../src/shared/net.ts`
(that file has no runtime dependencies).

| File | Responsibility |
|---|---|
| `index.ts` | Entry (`npm run server` / `node server/index.ts`). Reads `PORT` (default `NET_DEFAULT_PORT` 8787) and `HOST` (default `0.0.0.0`), graceful SIGINT/SIGTERM shutdown. |
| `RelayServer.ts` | `startRelayServer(opts)` → HTTP server (`GET /health` → `{ok, lobbies, clients, uptime}`) + `ws` `WebSocketServer` on `/ws` (`NET_WS_PATH`). Per-connection `welcome {id}`, inbound validation (JSON, type/field checks, 64 KB cap), message handlers, broadcast helpers, 15 s ping heartbeat (dead sockets terminated), one log line per lobby event. |
| `Lobby.ts` | `Lobby` (players map, lowest-free-slot assignment, ready flags, start/reset, host migration to the lowest remaining slot) and `LobbyManager` (code generation from `NET_LOBBY_ALPHABET`, peer → lobby index, create/join/leave, empty-lobby deletion). Korean error strings `LOBBY_ERROR_MESSAGE_KO`. |
| `selftest.ts` | `npm run net:selftest`: boots on a random port, drives 3–4 `WebSocket` clients through health, ping, bad input, create, invalid/unknown code, normalized join, slots, ready gating, start, late-join refusal, relay to `host`/`others`/peerId/`all`, reset, leave, slot reuse, host-drop migration, cleanup. Exits 0 on success. |
| `tsconfig.json` | Type-check config for this folder (`npm run typecheck:server`); `erasableSyntaxOnly` enforces the Node-runnable subset. |

## Protocol summary (`ClientToServer` → `ServerToClient`)
| Client sends | Server does |
|---|---|
| `lobby:create {name}` | new 6-char code, creator = host at slot 0 → `lobby:state` |
| `lobby:join {code, name}` | normalize + validate → `invalid` / `not_found` / `full` / `started` / `in_lobby`; lowest free slot → `lobby:state` to all |
| `lobby:leave` | remove, `lobby:left` to leaver, `peer:left {id, lobby}` to others (host migrates if needed) |
| `lobby:ready {ready}` | → `lobby:state` |
| `lobby:start {seed}` | host only (`not_host`), all ready (`not_ready`), not already started (`started`) → `game:start {seed, lobby}` to all |
| `lobby:reset` | host only → started=false, seed=null, all ready=false → `lobby:state` |
| `relay {to, d}` | `to` = peerId \| `host` \| `all` (incl. sender) \| `others`; only inside a lobby; forwarded as `relay {from, d}` |
| `ping {ts}` | `pong {ts, serverTime}` |

Errors are `lobby:error {code, message}` with Korean `message`. Disconnects behave like `lobby:leave`; empty
lobbies are deleted. Player names pass through `sanitizePlayerName` (markup/control chars stripped, 16 chars).

## Running
- `npm run server` — relay only (port 8787).
- `npm run dev:all` — relay + Vite dev server together (`scripts/dev-all.mjs`, prefixed output, Ctrl+C stops both).
  The Vite dev server proxies `/ws` to `ws://localhost:8787`, so the browser uses same-origin `/ws`.
- Production: serve `dist/` from anywhere and point the client at the relay with `VITE_WS_URL=wss://host:port/ws`
  at build time, or put both behind one reverse proxy that forwards `/ws`.
