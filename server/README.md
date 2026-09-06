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
| `RelayServer.ts` | `startRelayServer(opts)` → HTTP server (`GET /health` → `{ok, lobbies, clients, pendingReconnects, profiles, uptime}`) + `ws` `WebSocketServer` on `/ws` (`NET_WS_PATH`). Session tokens → stable `PeerId` (`peerIdFromToken`, `isValidSessionToken`), duplicate-session replacement, per-connection `welcome {id, lobby?, resumed?, profile?, raid?}`, inbound validation (JSON, type/field checks, 64 KB cap — only `profile:set` / `raid:save` may reach `MAX_DOC_FRAME_BYTES`), message handlers, reconnect grace timers, **host-migration timers** (Phase 7), broadcast helpers, 15 s ping heartbeat (dead sockets terminated), one log line per lobby / credits event. **Phase 9**: `profile:set` also parses the optional `at` (finite number) / `fresh` (boolean) — a malformed one is `invalid`, a `'stale'` store result is dropped silently; `autoResetMission(lobby)` closes **any** started lobby whose last `inMission` member left (raids now as well as trainings) and re-runs the hub migration afterwards; `migrateHostAway(lobby, id)` moves the authority off a *connected* host that reported `lobby:mission false`; the parked-host retries live in the `lobby:mission true` handler and in the resume path. Options: `port, host, quiet, heartbeatMs, reconnectGraceMs, hostMigrateDelayMs, dataDir, profileSaveDebounceMs`. Returns `{port, http, wss, lobbies, store, clientCount(), close()}`. |
| `Store.ts` | **Profile store** (Phase 7): `ProfileStore` maps `PeerId` → `ProfileRecord {credits, docs, updatedAt, docsAt?}` (`src/shared/profile.ts`). `get(id)` creates an empty `{credits: null, docs: {}}` on demand (never persisted until written), `snapshot(id)` for the wire (copies `docsAt`), `setDoc(id, key, doc, at?, fresh?)` → `SetDocResult` (`invalid` for a bad key, `too_large` over `PROFILE_DOC_MAX_BYTES`, **`'stale'`** = ignored, not an error), `applyCredits(id, delta, reason)` → `CreditsTxResult` (atomic; a result below 0 is refused with `크레딧 부족`; the `'migrate'` reason seeds a still-null balance with `delta` exactly once). **Phase 9 — newest wins**: a *stamped* write (`at` = the writer's `serverNow()` at save time) is clamped to `Date.now() + PROFILE_CLOCK_SKEW_MS` and stored only when `at >= docsAt[key]` (absent = 0, ties accept, and the stamp is recorded in `docsAt[key]`); an older stamp returns `'stale'`. A `fresh` write — or a write with no `at` at all — is a *default / starter* save: stored only while the key is absent, and never stamped, so any later stamped write beats it. `sanitizeRecord` keeps `docsAt` only for keys that actually have a document and clamps each stamp into `0 … now + PROFILE_CLOCK_SKEW_MS`. Persistence: `<dataDir>/profiles.json` (default `DEFAULT_DATA_DIR` = `server/data/`, git-ignored; `dataDir: null` = memory, used by the selftest) written atomically (tmp + rename) with a 1 s debounce (`PROFILE_SAVE_DEBOUNCE_MS`) and flushed synchronously on `close()`. The server never interprets documents — only `credits` and the stamps. |
| `Lobby.ts` | `Lobby` (players map with `connected` / `inMission` flags, lowest-free-slot assignment, ready flags, `start(seed, mode, starterId)` / `reset()`, `mode` (`raid` or `training` while started), `raid` blobs per member (`setRaid` only for the running raid's seed, `getRaid`), `isJoinable()` (a training keeps the lobby open), `isPublic`, `createdAt`, `migrateHost(force?)`, `allReady()` over connected members only, `inMissionCount()`) and `LobbyManager` (code generation from `NET_LOBBY_ALPHABET`, peer → lobby index, create/join/leave, `findQuickMatch()` / `quickMatch()`, empty-lobby deletion). **Phase 9 migration rule**: not started (hub) → lowest-slot *connected* member as before; **started** → candidates are connected members **inside the mission** (`inMission`) only, and when there is none the role is **parked** (`migrateHost()` returns false, the dropped host's id is kept) until an in-mission member reconnects. `force` skips the "current host still connected" no-op, so a connected host that leaves the mission (page reload) can hand the authority over. `remove()`: a started lobby left with **no `inMission` member at all** is over — `reset()` first, then the ordinary hub migration. Korean error strings `LOBBY_ERROR_MESSAGE_KO` (incl. `not_started`, `duplicate`, `too_large`, `in_mission`). |
| `selftest.ts` | `npm run net:selftest` (**194 checks**): boots on a random port with a 300 ms grace (memory store) and drives `WebSocket` clients through health, ping, bad input, create, invalid/unknown code, normalized join, slots, ready gating, start, late-join refusal, relay to `host`/`others`/peerId/`all`, reset, leave, slot reuse; then tokens (deterministic id, invalid token → random id, duplicate socket replacement), disconnect keeps the slot with `connected=false`, immediate host migration to a connected member (hub) vs host id kept while started (returning host stays host), resume `welcome {lobby, resumed}` within grace (+ `?n=` rename), grace expiry → `peer:left`, late return → no lobby, `allReady` ignoring dropped members, resume into a started lobby, ready no-op on started lobbies; quick match (create public / join oldest open / private & started lobbies skipped / `in_lobby`), `setPublic`, `seed`, `name`; ghost hosts (quick match and code join into a not-started lobby whose host is in grace → joiner becomes host, connected-first quick-match preference, started lobbies unaffected). **Phase 7 (parts 5–7)**: `welcome.profile` for token ids (none for anonymous), `profile:set` / `profile:get` round trip, key replacement, `invalid` key / missing doc, `too_large` over the cap, ordinary frames still capped at 64 KB; credits (refusal below zero, `migrate` seeding once, atomic debit, overdraft, integer truncation, non-numeric → `invalid`), persistence across reconnect, `/health.profiles`; raid blobs (ignored outside a lobby / before start / foreign seed / during a training, latest wins, `too_large`, malformed → `invalid`, returned in `welcome.raid` on resume, dropped by `lobby:reset`); `lobby:mission` (`in_mission` when nothing runs, raid start marks every connected member, leave / rejoin); training (non-host start with `mode:'training'`, no ready gating, only the starter `inMission`, `started` on a second start, joins stay open, join via `lobby:mission true`, starter leaving keeps it running, last member leaving → server reset, reset when the last trainee's grace expires); a second server with `hostMigrateDelayMs` 250 ms: host back within the delay stays host, otherwise the role moves to the connected **inMission** member (slot order otherwise), the old host returns as a client (`welcome.lobby.hostId`), relay to `'host'` reaches the new host, chained migrations, hub lobbies still migrate immediately; `ProfileStore` file round trip (debounced write, reload, placeholders not persisted). **Phase 9**: profile stamps (`at` stores `docsAt`, an older stamp is ignored *without* a `lobby:error`, an equal stamp wins as the latest write, `fresh` over an existing key is ignored while `fresh` on an absent key stores an unstamped doc that any later stamp beats, a set with no `at` behaves like `fresh`, a far-future `at` is clamped to `now + PROFILE_CLOCK_SKEW_MS`, a non-numeric `at` → `invalid`, `docsAt` lists only stamped keys and rides along in `welcome.profile`), store-level `'stale'` results + `docsAt` file round trip + `sanitizeRecord` clamping a hostile `docsAt`; and on the 250 ms-migrate server: a **parked host** (host down past the delay while only a hub member is connected → no migration, lobby keeps the dropped host id and stays started, relay to it dropped silently), an in-mission member reconnecting into a parked lobby becoming host inside its own `welcome`, the **duplicate socket** (page reload) leaving the mission (`inMission false`, mission still running), a returning in-mission member taking the role from a host that left the mission, the **last in-mission member leaving a raid** → server reset (raids end like trainings), a connected host reporting `lobby:mission false` mid-raid handing over at once, and a parked host's grace expiring with nobody inside → reset + ordinary hub migration. Exits 0 on success. |
| `tsconfig.json` | Type-check config for this folder (`npm run typecheck:server`); `erasableSyntaxOnly` enforces the Node-runnable subset. |
| `data/` | Runtime profile store (`profiles.json`), created on the first write. Git-ignored. Delete it to wipe every server profile. |

## Connection & sessions
- Clients connect to `ws://host/ws?t=<token>&n=<name>` (`NET_TOKEN_PARAM`, `NET_NAME_PARAM`). A valid token
  (`NET_TOKEN_LENGTH` = 24 url-safe chars) yields `PeerId = base64url(sha256(token)).slice(0, 12)` — the same id on
  every connect. Missing / invalid token → random 8-char id (legacy / anonymous).
- **Duplicate session** (same token already attached, e.g. a second tab or a zombie socket): the old socket gets
  `lobby:error {code:'duplicate'}` and is closed with code `4001`; the new socket takes over the id *and* the lobby
  membership (its `welcome` carries the lobby). Stragglers from the replaced socket are ignored.
  **Phase 9 — a replaced socket is a new page, and a new page is not inside the mission**: while the lobby is started
  the resumed member is set `inMission=false` and its raid blob dropped (the client reports the same thing itself on an
  ordinary reload); if it was the host it hands the authority to a connected in-mission member (`migrateHostAway`), and
  if nobody is left inside, the mission is reset (`autoResetMission`).
- **Welcome**: `{t:'welcome', id, serverTime}` — plus `lobby: LobbyState, resumed: true` whenever the id is still a
  lobby member (reconnect within grace, page reload, duplicate takeover). `?n=` renames the member on resume.
  Phase 7: `profile: ProfileRecord` for every token-derived id (a fresh `{credits: null, docs: {}}` on first contact;
  anonymous ids get none, so that client stays in offline mode) and `raid: RaidSessionBlob` when resuming into a started
  lobby that still runs the seed of the member's last `raid:save`.

## Reconnect grace
When a lobby member's socket closes the member is **not** removed: `LobbyPlayer.connected=false`, `lobby:state`
broadcast, and a timer of `reconnectGraceMs` (default `NET_RECONNECT_GRACE_MS` = 5 min) starts. If the member was
the host: **not started** (hub) → the host role moves immediately to the lowest-slot *connected* member so the party
can still launch; **started** (mission running) → the host id is kept for `hostMigrateDelayMs`
(`NET_HOST_MIGRATE_DELAY_MS` = 4 s, Phase 7) so a brief blip keeps the authority; when the host is still down after
that, `migrateHost()` hands the role to the lowest-slot connected member **inside the mission** (`inMission`) and
broadcasts `lobby:state` — the new host promotes itself (`net:hostChanged`) and announces `flow takeover`. A host that
returns later learns from `welcome.lobby.hostId` that it is a client now; its body was kept as a ghost by the new host
and comes back with `ghost restore` after its `flow rejoined`.
**Phase 9 — the host role is parked instead of falling back**: while a lobby is `started` there is *no* fallback to a
member sitting in the hub (it simulates nothing). When the delay fires with no connected in-mission member the role
stays with the dropped host id (`host parked` in the log, the lobby stays started, relays `to:'host'` are dropped
silently), and the first in-mission member that reconnects — or that reports `lobby:mission true` — takes it right
there, learning about it from its own `welcome.lobby.hostId`. Symmetrically, a *connected* host that leaves the mission
(`lobby:mission false`, i.e. a page reload or a return to the hub) hands the role to a connected in-mission member at
once. A started lobby whose **last** in-mission member leaves is over: the server `reset()`s it (raids now behave like
trainings) and the ordinary hub migration runs afterwards.
Reconnecting within the grace clears the timers, sets `connected=true`, answers `welcome {lobby, resumed:true, raid?}` and
broadcasts `lobby:state`. When the grace timer fires the member is removed as a normal leave (`peer:left {id, lobby}` to
the rest, host migrated if it was the host, its raid blob dropped; an empty players map deletes the lobby). A started
lobby whose members are all disconnected lingers until every grace expires.

## Mission membership, trainings, raid session (Phase 7)
- `LobbyPlayer.inMission`: a **raid** start (`lobby:start` without `mode` / `mode:'raid'`) sets it for every *connected*
  member; a **training** start (`mode:'training'`, any member, no ready gating, `LobbyState.mode='training'`) only for
  the starter. `lobby:mission {inMission}` updates the sender (`in_mission` error when `inMission:true` while nothing
  runs) and broadcasts `lobby:state`. A started lobby whose last member leaves (`inMission` all false — by message,
  leave, duplicate socket or grace expiry) is **reset by the server** (`started=false`, `lobby:state`); Phase 9 applies
  this to raids as well, not just trainings. `lobby:reset` (host) clears every flag.
  While a training runs the lobby stays joinable (code + quick match): newcomers arrive with `inMission=false`.
- **Raid session**: `raid:save {blob}` is stored per member only while `started && mode !== 'training' && blob.seed ===
  lobby.seed` (otherwise ignored silently; over `RAID_BLOB_MAX_BYTES` → `too_large`). Returned as `welcome.raid` on a
  resume under the same condition. Dropped by `lobby:reset`, `lobby:mission false`, leave / grace expiry and a new
  `lobby:start`.
- **Profile store**: see `Store.ts` above. `profile:set` from an anonymous connection → `invalid`; `credits:tx` from one
  answers `ok:false`.

## Protocol summary (`ClientToServer` → `ServerToClient`)
| Client sends | Server does |
|---|---|
| `lobby:create {name}` | new 6-char code, **private** (`isPublic=false`), creator = host at slot 0 → `lobby:state` |
| `lobby:quickmatch {name}` | join the best lobby with `isPublic && !started && free slot` — lobbies with ≥ 1 connected member first, then oldest; a lobby whose members are all in grace is used only when nothing better exists — else create a new **public** one → `lobby:state` to the lobby (`in_lobby` if already in one) |
| `lobby:join {code, name}` | normalize + validate → `invalid` / `not_found` / `full` / `started` / `in_lobby`; lowest free slot → `lobby:state` to all. **Ghost host**: joining (by code or quick match) a not-started lobby whose host is in reconnect grace migrates the host to the lowest-slot connected member (the joiner) immediately, so nobody waits on a dropped host |
| `lobby:leave` | remove, `lobby:left` to leaver, `peer:left {id, lobby}` to others (host migrates if needed) |
| `lobby:ready {ready}` | → `lobby:state`; on a **started** lobby: no-op, echoes `lobby:state` to the sender only |
| `lobby:start {seed, mode?}` | raid (default): host only (`not_host`), every *connected* member ready and ≥ 1 connected (`not_ready`), not already started (`started`) → `game:start {seed, lobby, mode:'raid'}` to all, every connected member `inMission`. `mode:'training'`: any member, no ready gating, only the sender `inMission` → `game:start {…, mode:'training'}` to all |
| `lobby:reset` | host only → started=false, seed=null, mode cleared, all ready=false, all inMission=false, raid blobs dropped → `lobby:state` |
| `lobby:mission {inMission}` | update the sender's `inMission` (`in_mission` when `true` while nothing runs); `false` drops the sender's raid blob and, if the sender was the host, hands the role to a connected in-mission member; `true` claims a parked / out-of-mission host role; a started lobby with nobody left inside is reset → `lobby:state` |
| `profile:get` | → `profile:docs {profile}` (the sender's record) |
| `profile:set {key, doc, at?, fresh?}` | store one opaque document (`invalid` for an unknown key / anonymous id / a non-numeric `at` / a non-boolean `fresh`, `too_large` over `PROFILE_DOC_MAX_BYTES`); **newest wins** — a stamped write is kept only when `at >= docsAt[key]` (clamped to `now + PROFILE_CLOCK_SKEW_MS`), a `fresh` / unstamped write only while the key is absent. A losing write is ignored **silently** (no `lobby:error`) — the client keeps the server copy. No reply on success |
| `credits:tx {txId, delta, reason}` | atomic credits transaction → `credits:result {txId, ok, credits, reason?}` (`크레딧 부족` when the balance would go below 0; `reason 'migrate'` seeds a null balance once) |
| `raid:save {blob}` | keep the sender's mid-raid state while its lobby runs a raid with `blob.seed` (else ignored; `too_large` over `RAID_BLOB_MAX_BYTES`) |
| `lobby:setPublic {isPublic}` | host only → `LobbyState.isPublic` → `lobby:state` |
| `lobby:seed {seed}` | host only, not started (`started`) → `LobbyState.seed` → `lobby:state` |
| `lobby:name {name}` | sanitize, update the member's name → `lobby:state` (silently accepted outside a lobby) |
| `relay {to, d}` | `to` = peerId \| `host` \| `all` (incl. sender) \| `others`; only inside a lobby; forwarded as `relay {from, d}`; targets whose socket is down are skipped. Never inspected: `ghost` / `ghostq` / `cont` / `contq` / `flow takeover` (Phase 7) are plain relays like everything else |
| `ping {ts}` | `pong {ts, serverTime}` |

Errors are `lobby:error {code, message}` with Korean `message`. Player names pass through `sanitizePlayerName`
(markup/control chars stripped, 16 chars).

## Running
- `npm run server` — relay only (port 8787). Profiles persist in `server/data/profiles.json` (`dataDir` option; delete the file to wipe).
- `npm run dev:all` — relay + Vite dev server together (`scripts/dev-all.mjs`, prefixed output, Ctrl+C stops both).
  The Vite dev server proxies `/ws` to `ws://localhost:8787`, so the browser uses same-origin `/ws`.
- Production: serve `dist/` from anywhere and point the client at the relay with `VITE_WS_URL=wss://host:port/ws`
  at build time, or put both behind one reverse proxy that forwards `/ws`.
