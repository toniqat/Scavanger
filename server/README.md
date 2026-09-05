# server — WebSocket relay (lobbies + opaque message relay)

Small Node server that owns lobbies and forwards `GameMessage`s between lobby members. It never inspects relayed
payloads; the lobby host is the gameplay authority (see `src/shared/net.ts`).

Runs directly under **Node native type stripping** — no build step, no `tsx`. Node ≥ 23.6 needs no flag; Node 22.6–22.17 needs `--experimental-strip-types` (already in the `server` / `net:selftest` npm scripts). Rules for these files: erasable
TypeScript only (no enums / namespaces / parameter properties), explicit `.ts` extensions on relative imports,
`import type` for anything type-only. Runtime constants/helpers are value-imported from `../src/shared/net.ts`
(that file has no runtime dependencies).

| File | Responsibility |
|---|---|
| `index.ts` | Entry (`npm run server`, i.e. `node --experimental-strip-types server/index.ts`). Reads `PORT` (default `NET_DEFAULT_PORT` 8787) and `HOST` (default `0.0.0.0`), graceful SIGINT/SIGTERM shutdown. |
| `RelayServer.ts` | `startRelayServer(opts)` → HTTP server (`GET /health` → `{ok, lobbies, clients, pendingReconnects, uptime}`) + `ws` `WebSocketServer` on `/ws` (`NET_WS_PATH`). Session tokens → stable `PeerId` (`peerIdFromToken`, `isValidSessionToken`), duplicate-session replacement, per-connection `welcome {id, lobby?, resumed?}`, inbound validation (JSON, type/field checks, 64 KB cap), message handlers, reconnect grace timers, broadcast helpers, 15 s ping heartbeat (dead sockets terminated), one log line per lobby event. Options: `port, host, quiet, heartbeatMs, reconnectGraceMs`. |
| `Lobby.ts` | `Lobby` (players map with `connected` flags, lowest-free-slot assignment, ready flags, start/reset, `isPublic`, `createdAt`, `migrateHost()` → lowest-slot *connected* member, `allReady()` over connected members only) and `LobbyManager` (code generation from `NET_LOBBY_ALPHABET`, peer → lobby index, create/join/leave, `findQuickMatch()` / `quickMatch()`, empty-lobby deletion). Korean error strings `LOBBY_ERROR_MESSAGE_KO` (incl. `not_started`, `duplicate`). |
| `selftest.ts` | `npm run net:selftest` (101 checks): boots on a random port with a 300 ms grace and drives `WebSocket` clients through health, ping, bad input, create, invalid/unknown code, normalized join, slots, ready gating, start, late-join refusal, relay to `host`/`others`/peerId/`all`, reset, leave, slot reuse; then tokens (deterministic id, invalid token → random id, duplicate socket replacement), disconnect keeps the slot with `connected=false`, immediate host migration to a connected member (hub) vs host id kept through the grace while started (returning host stays host; migration only at expiry), resume `welcome {lobby, resumed}` within grace (+ `?n=` rename), grace expiry → `peer:left`, late return → no lobby, `allReady` ignoring dropped members, resume into a started lobby, ready no-op on started lobbies; quick match (create public / join oldest open / private & started lobbies skipped / `in_lobby`), `setPublic`, `seed`, `name`; ghost hosts (quick match and code join into a not-started lobby whose host is in grace → joiner becomes host, connected-first quick-match preference, started lobbies unaffected). Exits 0 on success. |
| `tsconfig.json` | Type-check config for this folder (`npm run typecheck:server`); `erasableSyntaxOnly` enforces the Node-runnable subset. |

## Connection & sessions
- Clients connect to `ws://host/ws?t=<token>&n=<name>` (`NET_TOKEN_PARAM`, `NET_NAME_PARAM`). A valid token
  (`NET_TOKEN_LENGTH` = 24 url-safe chars) yields `PeerId = base64url(sha256(token)).slice(0, 12)` — the same id on
  every connect. Missing / invalid token → random 8-char id (legacy / anonymous).
- **Duplicate session** (same token already attached, e.g. a second tab or a zombie socket): the old socket gets
  `lobby:error {code:'duplicate'}` and is closed with code `4001`; the new socket takes over the id *and* the lobby
  membership (its `welcome` carries the lobby). Stragglers from the replaced socket are ignored.
- **Welcome**: `{t:'welcome', id, serverTime}` — plus `lobby: LobbyState, resumed: true` whenever the id is still a
  lobby member (reconnect within grace, page reload, duplicate takeover). `?n=` renames the member on resume.

## Reconnect grace
When a lobby member's socket closes the member is **not** removed: `LobbyPlayer.connected=false`, `lobby:state`
broadcast, and a timer of `reconnectGraceMs` (default `NET_RECONNECT_GRACE_MS` = 5 min) starts. If the member was
the host: **not started** (hub) → the host role moves immediately to the lowest-slot *connected* member so the party
can still launch; **started** (mission running) → the host id is kept for the whole grace so a returning host resumes
as the gameplay authority (clients keep `lobby.hostId`, their `exq`/`hit` requests to `'host'` are dropped meanwhile).
Reconnecting within the grace clears the timer, sets `connected=true`, answers `welcome {lobby, resumed:true}` and
broadcasts `lobby:state`. When the timer fires the member is removed as a normal leave (`peer:left {id, lobby}` to
the rest, host migrated to the lowest-slot connected member if it was the host; an empty players map deletes the
lobby). A started lobby whose members are all disconnected lingers until every grace expires.

## Protocol summary (`ClientToServer` → `ServerToClient`)
| Client sends | Server does |
|---|---|
| `lobby:create {name}` | new 6-char code, **private** (`isPublic=false`), creator = host at slot 0 → `lobby:state` |
| `lobby:quickmatch {name}` | join the best lobby with `isPublic && !started && free slot` — lobbies with ≥ 1 connected member first, then oldest; a lobby whose members are all in grace is used only when nothing better exists — else create a new **public** one → `lobby:state` to the lobby (`in_lobby` if already in one) |
| `lobby:join {code, name}` | normalize + validate → `invalid` / `not_found` / `full` / `started` / `in_lobby`; lowest free slot → `lobby:state` to all. **Ghost host**: joining (by code or quick match) a not-started lobby whose host is in reconnect grace migrates the host to the lowest-slot connected member (the joiner) immediately, so nobody waits on a dropped host |
| `lobby:leave` | remove, `lobby:left` to leaver, `peer:left {id, lobby}` to others (host migrates if needed) |
| `lobby:ready {ready}` | → `lobby:state`; on a **started** lobby: no-op, echoes `lobby:state` to the sender only |
| `lobby:start {seed}` | host only (`not_host`), every *connected* member ready and ≥ 1 connected (`not_ready`), not already started (`started`) → `game:start {seed, lobby}` to all |
| `lobby:reset` | host only → started=false, seed=null, all ready=false → `lobby:state` |
| `lobby:setPublic {isPublic}` | host only → `LobbyState.isPublic` → `lobby:state` |
| `lobby:seed {seed}` | host only, not started (`started`) → `LobbyState.seed` → `lobby:state` |
| `lobby:name {name}` | sanitize, update the member's name → `lobby:state` (silently accepted outside a lobby) |
| `relay {to, d}` | `to` = peerId \| `host` \| `all` (incl. sender) \| `others`; only inside a lobby; forwarded as `relay {from, d}`; targets whose socket is down are skipped |
| `ping {ts}` | `pong {ts, serverTime}` |

Errors are `lobby:error {code, message}` with Korean `message`. Player names pass through `sanitizePlayerName`
(markup/control chars stripped, 16 chars).

## Running
- `npm run server` — relay only (port 8787).
- `npm run dev:all` — relay + Vite dev server together (`scripts/dev-all.mjs`, prefixed output, Ctrl+C stops both).
  The Vite dev server proxies `/ws` to `ws://localhost:8787`, so the browser uses same-origin `/ws`.
- Production: serve `dist/` from anywhere and point the client at the relay with `VITE_WS_URL=wss://host:port/ws`
  at build time, or put both behind one reverse proxy that forwards `/ws`.
