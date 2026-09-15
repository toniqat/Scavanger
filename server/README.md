# server/ — WebSocket relay (lobbies, relay, profile / social / room stores, credit validation)

Small Node server (`ws`) that owns lobbies, forwards opaque `GameMessage`s between lobby members, and keeps per-token
stores: profiles (credits + opaque documents + social record + credit ledger), raid session blobs, group rooms and the
crypto market. It never inspects relayed gameplay payloads — the lobby host is the gameplay authority. The only game
facts it validates are credit transactions (reason grammar + generated economy table) and the shape of lobby fields.
The same relay runs under `npm run server`, the standalone exe (`tool.ts`) and the desktop shell (`electron/`).

Runs under **Node native type stripping** (no build, no `tsx`; Node 22.6–22.17 needs `--experimental-strip-types`, already
in the npm scripts). Files must be erasable TypeScript (no enums / namespaces / parameter properties — enforced by
`erasableSyntaxOnly`), use explicit `.ts` extensions, and `import type` for type-only imports.

## Files

| File | Responsibility |
|---|---|
| `index.ts` | Dev entry (`npm run server`): `PORT` (default `NET_DEFAULT_PORT` 8787), `HOST` (default `0.0.0.0`), `--data=<dir>` / `SCAV_DATA_DIR`, `SCAV_DEV_ECONOMY=1` / `--dev-economy`, graceful SIGINT / SIGTERM |
| `tool.ts` | Deploy entry bundled into `SCAVANGER-Server.exe`: `--port` / `--host` / `--data` / `--max` (+ `PORT` · `HOST` · `SCAV_DATA_DIR` · `SCAV_MAX_CLIENTS`), address banner (`lanAddresses`), data in `%LOCALAPPDATA%\SCAVANGER\server`, readline console, keeps the window open on `EADDRINUSE`. No top-level await (SEA bundle is CJS) |
| `RelayServer.ts` | `startRelayServer(opts)`: HTTP `GET /health` + `WebSocketServer` on `NET_WS_PATH`; token → `PeerId`, duplicate replacement, welcome, frame parser / validation, every handler, reconnect grace + host-migration timers, presence / watcher index, invite and room fan-out, 15 s heartbeat, operator API (`listClients`, `kick`, `setMaxClients`), periodic GC |
| `Lobby.ts` | `Lobby` (players, slots, ready, `start` / `reset`, `mode`, `planet`, `intel`, raid blobs, `hostDown`, `canAdd`, `migrateHost`, `transferHostTo`) and `LobbyManager` (codes, peer index, create / join / leave / atomic `move`, `findQuickMatch(accept?)`); `LOBBY_ERROR_MESSAGE_KO` |
| `Store.ts` | `ProfileStore`: records keyed by `PeerId`, document writes (revision + legacy stamp paths), credits (`applyCreditsTx` via `Economy.ts`), social record rules (codes, friends, requests, recent, blocks, whisper inbox), `collectGarbage`, `profiles.json` persistence |
| `Invites.ts` | Memory-only `InviteTable` (one open invite per (from, to), TTL timers) and `PushCoalescer` (batches social pushes per viewer) |
| `Rooms.ts` | `RoomStore`: group-room rules and limits, returns `RoomOp` (lines + who needs a fresh `room:state`), `rooms.json` persistence. Knows nothing of sockets, friends or blocks |
| `Economy.ts` | Pure credit validation: `ECONOMY_TABLE` (JSON import of `economy.gen.json`, shape-checked by `loadEconomyTable` — a broken table stops startup), `CreditEconomy.check` / `commit`, ledger sanitize / prune, injected crypto quote source, `devEconomyFromEnv` |
| `CryptoMarket.ts` | Server-authoritative coin prices: mean-reverting log price with jumps per tick from a stateless hash (a gap replays identically), 1-minute / 1-hour candles, `history`, `quoteRange`, `crypto.json` persistence with backfill |
| `economy.gen.json` | **Generated, committed** economy table (item value / stack, repair fees, contract and NPC-quest credit rewards, price multipliers, `CREDITS_MAX`, rover fare range, `intel`, `crypto`, `hash`). Written by `npm run data:check -- --write` (`scripts/economy-table.mjs`) from the client's own modules; `data:check` fails when stale. Never hand-edit |
| `selftest.ts` | `npm run net:selftest` — boots relays on random ports (memory stores) and drives real sockets through every protocol area (parts 1–14) plus store-level checks |
| `tsconfig.json` | `npm run typecheck:server` (`erasableSyntaxOnly`) |
| `data/` | Runtime stores (git-ignored): `profiles.json` (+ `.bak`, `profiles.corrupt-<ts>.json`), `rooms.json` (+ same), `crypto.json` (+ same; deleting it only loses chart history — 31 days are re-backfilled deterministically) |

Runtime imports from `src/shared`: `net.ts`, `profile.ts`, `social.ts`, `credits.ts`, `cryptoMarket.ts`, `intel.ts`,
`planets.ts` (`types.ts` type-only).

## Connections, sessions, grace

- Connect to `ws://host/ws?t=<token>&n=<name>`. A valid token (`NET_TOKEN_LENGTH`) gives
  `PeerId = base64url(sha256(token)).slice(0, 12)` — stable across reconnects and servers. Invalid / missing token →
  random anonymous id: no profile, no social, no rooms (`unavailable` errors), `credits:tx` answers `ok:false`.
- **Duplicate token**: the old socket gets `lobby:error duplicate` and close `4001`; the new socket takes over the id and
  lobby slot. A replaced socket is a new page: in a started lobby it is set `inMission=false`, its raid blob dropped, host
  role moved (`migrateHostAway`), and an empty mission reset (`autoResetMission`).
- **Welcome** `{id, serverTime}` + `lobby, resumed:true` while still a lobby member, `profile` (token ids), `raid` (resuming
  into the seed of the last `raid:save`), `social`; then `room:state`, pending invites re-sent with their ids, and a
  `social:whisperBacklog` for stored offline lines.
- **Reconnect grace** `NET_RECONNECT_GRACE_MS` (5 min): member kept with `connected=false`. A dropped **raider** keeps
  the slot for the whole raid while another connected member is still inside (the host holds the body as a ghost).
  Grace expiry otherwise removes the member (`peer:left`).
- **Host migration**: hub lobby → immediately to the lowest-slot connected member. Started lobby → after
  `NET_HOST_MIGRATE_DELAY_MS` to a connected member **inside the mission**; with none the role is **parked** on the
  dropped id (relays `to:'host'` dropped) until an in-mission member reconnects or sends `lobby:mission true`. A connected
  host that reports `lobby:mission false` hands over at once. A started lobby whose last `inMission` member leaves is
  reset. Joining a not-started lobby whose host is in grace makes the joiner host.
- **Mission membership**: a raid start marks every connected member `inMission`; a training start (`mode:'training'`, any
  member, no ready gating, no planet) marks only the starter and keeps the lobby joinable.
- **Raid blobs**: stored per member only while `started && mode !== 'training' && blob.seed === lobby.seed`; dropped by
  `lobby:reset`, `lobby:mission false`, leave / grace expiry and a new start.

## Protocol summary (`ClientToServer` → `ServerToClient`)

Types: `src/shared/net.ts` (lobby, profile, crypto, room frames) and `src/shared/social.ts`. Lobby errors are
`lobby:error {code, message}` (Korean); social requests answer `social:error`; room requests `room:error`. A malformed
frame is always `lobby:error invalid`. Frame caps: 64 KB (`MAX_MESSAGE_BYTES`), `profile:set` / `raid:save` up to
`MAX_DOC_FRAME_BYTES`, `profile:setMany` up to `MAX_TX_FRAME_BYTES` (socket `maxPayload`).

| Client sends | Server does |
|---|---|
| `lobby:create {name}` | New private lobby, creator host at slot 0 → `lobby:state` |
| `lobby:quickmatch {name}` | Join best public, not-started lobby with a free slot (connected members first, then oldest); lobbies with a block in either direction are skipped; else create a public one |
| `lobby:join {code, name}` | `invalid` / `not_found` / `full` / `started` / `in_lobby`; blocks checked first: someone I blocked → `blocked`, someone who blocked me → `not_found` (disguised) |
| `lobby:leave` | `lobby:left` to leaver, `peer:left` to others, host migrates |
| `lobby:ready {ready}` | → `lobby:state` (no-op on a started lobby, echoed to sender) |
| `lobby:start {seed, mode?, planet?, intel?}` | Raid: host, every connected member ready, planet in message or lobby (`no_planet`) → `game:start {seed, lobby, mode, planet, intel}`. Training: any member |
| `lobby:planet {planet}` | Host, not started, known `PlanetId` → `lobby:state`. Kept by `reset()`; there is no travel message |
| `lobby:intel {intel}` | Host, not started; shape-only `sanitizeIntelWire`; `null` is valid. Cleared by `reset()` |
| `lobby:setPublic` / `lobby:seed` / `lobby:name` | Host (seed: not started) / any member → `lobby:state` |
| `lobby:transferHost {targetId, claim?}` | Allowed if sender is host, or `claim` while the host has `hostDown` set; target must be a connected member of the lobby → `lobby:state` |
| `lobby:hostDown {down}` | Host only; not broadcast; cleared by any host change or `reset()` |
| `lobby:reset` | Host → started/seed/mode/ready/inMission/raid blobs/intel/hostDown cleared → `lobby:state` |
| `lobby:mission {inMission}` | Update sender (`in_mission` when nothing runs); `false` drops blob and hands off host; `true` claims a parked host role |
| `relay {to, d}` | `to` = peerId \| `host` \| `all` \| `others`; forwarded as `relay {from, d}` to connected targets; never inspected |
| `ping {ts}` | `pong {ts, serverTime}` |
| `raid:save {blob}` | Stored under the rule above; `too_large` over `RAID_BLOB_MAX_BYTES` |
| `profile:get` | `profile:docs {profile}` |
| `profile:set {key, doc, baseRev, writeId}` | Revision write: `baseRev === docsRev[key]` → stored, rev+1 → `profile:ack {writeId, revs}`; else `profile:conflict {writeId, docs}`; bad input / over `PROFILE_DOC_MAX_BYTES` → `profile:refused {writeId, code}`. Replayed `writeId` → same ack |
| `profile:set {key, doc, at?, fresh?}` | Legacy (no `baseRev`): stamped write kept if `at >= docsAt[key]` (clamped by `PROFILE_CLOCK_SKEW_MS`), `fresh` / unstamped only if absent; a losing write is ignored silently; still bumps the rev |
| `profile:setMany {txId, docs}` | All-or-nothing revision transaction → `ack` / `conflict` (every mismatching key) / `refused` (`PROFILE_SETMANY_MAX_BYTES`) |
| `credits:tx {txId, delta, reason}` | Validated transaction (below) → `credits:result {txId, ok, credits, reason?}` |
| `social:get` / `social:me {level}` | `social:state` to sender at once (+ watchers, coalesced) |
| `social:request` / `respond` / `remove {code}` | Friend list rules in `Store.ts`; sender answered at once, other side coalesced. Requests toward a blocker land only in my `outgoing` |
| `social:block {code, blocked}` | Block unlinks both records, fails / hides invites; unblock removes from list |
| `social:play {code}` | `playBlockReason` gates; target has a ship → atomic `moveToLobby` (`lobby:left {reason:'moved', to}` then `lobby:state`), outcome `joined`; else invite (`social:invited`), outcome `invited`; `busy` while I am in a mission or others are in my ship |
| `social:inviteReply {id, accept}` | Decline / accept → move; every close goes through `closeInvite` (`social:inviteResult` to inviter, `social:inviteClosed` to invitee) |
| `social:whisper {code, text, nonce?}` | Sanitized, `SOCIAL_WHISPER_MAX`; online → `social:whisper`; offline friend + nonce → stored in `inbox`; `social:whisperAck {nonce, ok, at?, stored?, code?}`; to a blocker: dropped but acked `ok:true` |
| `room:get` · `create` · `invite` · `reply` · `leave` · `kick` · `rename` · `say` · `history` | Group rooms (below) → `room:state`, `room:line`, `room:ack`, `room:history`, `room:error` |
| `crypto:watch {on}` | Per-socket flag (anonymous allowed); `on` → `crypto:prices` now and every tick |
| `crypto:history {coin, range}` | `crypto:history {coin, range, at, candles}` to that socket; unknown → no answer; token bucket `CRYPTO_HISTORY_BURST` / `CRYPTO_HISTORY_PER_S` |

## Credit validation

`credits:tx` reasons follow `src/shared/credits.ts` (`parseCreditReason`); amounts are checked against `economy.gen.json`
plus the profile's ledger (`ProfileRecord.ledger`, never sent to clients). Refusals answer `CREDIT_TX_INVALID_KO`
(English `why` in the log); a balance below 0 answers `크레딧 부족`; positive transactions stop at `CREDITS_MAX`.

| Reason | Accepted when |
|---|---|
| `buy:<defId>` | `delta < 0`, `−delta ≥ tableMinBuyPrice` |
| `sell:<defId>:<qty>` | `1 ≤ qty ≤ stack`, `0 < delta ≤ tableSellPrice(value, qty)` |
| `refund:<defId>` / `refund:repair:<id>` | Pairs with an unrefunded debit inside `CREDIT_REFUND_WINDOW_MS` |
| `repair:<brokenId>` | `delta === −repair fee` |
| `contract:<id>` | `delta === reward`, ≤ `CREDIT_CONTRACT_MAX_PER_HOUR` per profile |
| `quest:<id>` | `delta === NPC-quest credit reward`, once per quest id (ledger) |
| `rover:<from>:<to>` | `delta < 0` integer within the table's fare range, ≤ `CREDIT_ROVER_MAX_PER_HOUR`; not refundable |
| `intel:<planet>:<code>` | `delta === −intelCost(threat, picks, table.intel)`, tiers within `maxTier`, ≤ `CREDIT_INTEL_MAX_PER_HOUR`; not refundable |
| `cbuy:<coin>:<units>` / `csell:<coin>:<units>` | Integer units ≤ `maxUnits`; buy pays ≥ `cryptoTradeCredits('buy', window low)`, sell gets ≤ `cryptoTradeCredits('sell', window high)` over the recent quote window; locked coins need their unlock quest in the ledger; ≤ `CREDIT_CRYPTO_MAX_PER_HOUR` |
| `migrate` | Only while the balance is null, once, clamped to `[0, CREDITS_MAX]` |
| `console` · `smoke:*` · `e2e:*` · `shot` | Only on a `devEconomy` relay |

Not checked by design: whether the item / wallet was really owned (stash and loadout are client-written documents) and
whether an intel purchase was really used. Only `index.ts` reads the dev-economy env; `tool.ts` and the electron
embedded relay never enable it.

## Stores

- **Persistence dance** (`Store.ts`, `Rooms.ts`, `CryptoMarket.ts`): debounced async write to `*.tmp` + `fsync` → old
  file renamed to `.bak` → tmp renamed over main; one write at a time; `close()` flushes synchronously and a stale async
  write backs off. On a parse failure the original is kept as `*.corrupt-<ISO time>.json` and the store recovers from
  `.bak` (or starts empty without overwriting). An I/O read error keeps that store memory-only. `dataDir: null` = memory.
- **Profiles**: `get(id)` creates an empty placeholder that is not persisted until written. `docsRev[key]` is bumped by
  every accepted write, seeded to 1 for pre-revision documents on load, and always present in `snapshot()` (clients detect
  a revision-aware relay by it). Write ids are remembered in memory only (16 per profile). Conflicts / refusals never
  create placeholders. Social records are server-owned and sanitized field by field; only `PlayerCode`s leave the server
  (`playerCodeFrom(peerId, salt)`, salt bumped on collision, `byCode` index).
- **Profile GC** (`collectGarbage(keep, now)`): at startup, every `PROFILE_GC_INTERVAL_MS`, and console `gc`. Deletes
  profiles not seen (`seenAt`) for `PROFILE_GC_INACTIVE_MS` unless connected or a lobby member; strips dangling codes;
  expires recent entries (`SOCIAL_RECENT_TTL_MS`), unanswered requests (`SOCIAL_REQUEST_TTL_MS`, `requestsAt` stamped on
  both sides) and inbox lines; then runs room GC and pushes fresh state to affected sockets.
- **Rooms** (`Rooms.ts`): server-authoritative and persistent. Anyone creates (owner), up to `ROOM_JOINED_MAX` per
  player; invite / kick / rename owner-only; invites friends only and persist until `ROOM_INVITE_TTL_MS`; `room_full` /
  `room_limit` refusals keep the invite; owner leaving passes ownership to the earliest member; last member leaving
  deletes the room. Lines capped at `ROOM_LINES_MAX` with strictly increasing timestamps per room. Membership lives only
  in `rooms.json` (not `SocialRecord.rooms`). `applyRoomOp` sends `room:state` **before** lines; `room:say` gets only an ack
  (no echo), rate-limited by `ROOM_SAY_BURST` / `ROOM_SAY_PER_S`. Block rules mirror social (invite to a blocker →
  `not_found`, to someone I blocked → `invalid`); existing co-members are not removed — clients hide lines.
- **Crypto market**: created whenever the economy table has a `crypto` section, same `dataDir`. Model constants live in
  `CryptoMarket.ts`; per-coin balance comes from csv via the table.

## Social server rules

- Presence is derived, never stored (`offline | ship | raid | training`); a member in reconnect grace reads `offline`.
- Watchers: a subject's `social:state` reaches every connected client that has it in any of friends / incoming / outgoing /
  recent; rebuilt after every list change. All pushes go through `PushCoalescer` (`SOCIAL_PUSH_COALESCE_MS`) except the
  requester's own answer (`pushSocialNow`).
- Invites: one per (from, to) — a new one closes the old as `superseded`; at most `SQUAD_INVITE_MAX` visible per invitee;
  outcomes `accepted` · `declined` · `expired` · `failed` (swept after leave / kick / join / start …) · `offline` · `superseded`.
  Open invites and coalescing timers are per process.
- Blocks are silent toward the blocked side (whispers dropped but acked, requests only in their outgoing, invites hidden
  and expire). Joining is refused by direction (`blockRefusal`). Blocking a current squadmate does not kick them.
- Recent players are recorded when two profiles share a ship, never for friends, capped at `SOCIAL_RECENT_MAX`.

## Server console (`tool.ts`)

`list` (connected sockets) · `lobbies` · `kick <id or code> [reason]` (no grace: slot removed, `lobby:error kicked`,
close `4002`) · `max <n|off>` (new sockets only: `lobby:error server_full`, close `4003`; same-token replacement and current
lobby members are exempt) · `gc` · `help`. There is no ban — a kicked client stops auto-reconnecting but may connect again
explicitly.

## Running and deploy

- `npm run server` — relay only (8787), data in `server/data/`. `npm run dev:all` — relay + Vite (Vite proxies `/ws`).
  Production web: build with `VITE_WS_URL=wss://host:port/ws` or reverse-proxy `/ws`.
- `/health` → `{ok, lobbies, clients, pendingReconnects, profiles, uptime, maxClients, devEconomy, economy, crypto}`.
- `npm run server:dist` (`scripts/build-server.mjs`): rolldown bundle of `tool.ts` + relay + `ws` → `dist-server/server.cjs`
  (**CJS** — Node SEA requires it; `bufferutil` / `utf-8-validate` stay external) → SEA blob → injected into a copy of
  `node.exe` (postject, rcedit icon if available) → `release/SCAVANGER-Server.exe`. `npm run app:dist` places it in the
  deploy folder (see `electron/README.md`). `scripts/smoke-server-dist.mjs` checks the bundle, flags, `/health`, welcome and
  the address rules without a browser.
- Server profiles are bound to the token, not the address: each server is a separate account store.

## Rules

- `economy.gen.json` must be regenerated (`npm run data:check -- --write`) after any economy csv change; the relay never
  re-derives prices itself — it cannot run the Vite csv loader.
- Validation stays pure and injected: `CreditEconomy` knows no sockets or stores; the crypto quote source is set with
  `setCryptoQuotes(market)`. Handlers are synchronous, so check → apply → commit cannot interleave.
- `Lobby.canAdd()` is the only copy of the join rule; `LobbyManager.move` checks the target before leaving the old lobby.
- A new relay entry point must pass through `startRelayServer` so crypto, GC and stores are wired the same way.
- `LOBBY_ERROR_MESSAGE_KO` is a `Record` over `LobbyErrorCode` — a new shared error code needs its Korean string here.

## Recent changes

Last 5 only — older: `git log -- server`.
- 2026-09-14 — Intel: `lobby:intel`, `LobbyState.intel` / `game:start.intel`, `intel:` credit reason.
- 2026-09-14 — `Rooms.ts` group rooms (`room:*`, `rooms.json`, room GC).
- 2026-09-13 — `CryptoMarket.ts`, `crypto:watch` / `crypto:history`, `cbuy` / `csell` validation.
- 2026-09-13 — `rover:<from>:<to>` fare validation.
- 2026-09-11 — Block-aware lobby join / quick match (`blocked` / disguised `not_found`).
