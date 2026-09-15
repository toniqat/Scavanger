# src/net/ — multiplayer client (`NetSystem`, publishes `ctx.net`)

Browser side of the multiplayer stack. Talks to the Node relay in `server/` over one WebSocket: session token,
connection / reconnect / link state, lobby mirror, mission start / rejoin / end, 20 Hz player snapshots (in missions and
in the shared ship), interpolated `RemotePlayerRef`s, and the relayed `GameMessage` fan-out to other systems. It also
publishes the profile-document sync (`ctx.net.profile`), social + private chat (`ctx.net.social`), group rooms
(`ctx.net.rooms`) and crypto quotes (`ctx.net.crypto`). It holds no gameplay rules: `ctx.isAuthority` is
`!inSession || isHost` and other folders gate their simulation on it. Contract: `src/shared/net.ts`, `profile.ts`,
`social.ts`, and the `net:*` / `social:*` / `room:*` events in `src/shared/events.ts`.

## Files

| File | Responsibility |
|---|---|
| `index.ts` | Barrel |
| `NetSystem.ts` | `GameSystem` `'net'` implementing `NetRef`; owns the sub-objects below and one-line delegates into `parts/` |
| `model.ts` | Folder vocabulary (no state): storage keys (`NAME_STORAGE_KEY` `scav.playerName`), `loadOrCreateSessionToken` (per slot via `slotKey(NET_TOKEN_STORAGE_KEY)`), wire sanitizers `sanitizeCrewCard` · `sanitizeShipVisit` · `isGhostWire`, vector helpers |
| `NetClient.ts` | Bare transport: `connect(url)` resolves on `welcome` or fails after `NET_CONNECT_TIMEOUT_MS`, JSON with a server-type whitelist (`SERVER_TYPES`) and an inbound byte cap, 2 s ping → `rttMs`, `serverTimeOffset`, status `offline/connecting/connected/error` |
| `parts/Socket.ts` | Connection, token, auto-reconnect backoff, relay address (`defaultUrl`, `setRelayOverride`, anonymous `probeRelay`, `reconnectRelay`), **link state** (`setLink` is the only transition → `net:linkChanged`), background probe (every target, the desktop shell included) |
| `parts/Lobby.ts` | Create / join / quick match / ready / start / leave, host transfer, planet + intel wire (`sanitizeIntelWire`), `beginSession`, `rejoinMission`, `leaveMission`, deferred `endSession`, `dropLobby` |
| `parts/Messages.ts` | Inbound dispatch: server frames (`handleServerMessage`) and relayed game messages (`handleRelay`) → snapshot apply, bus translation, `onMessage` subscribers. No game rules |
| `parts/Remotes.ts` | Remote ref registry, identity sync (names, suspension, membership), crew cards, ship-visit layouts, derived `carriedBy`, `pushLevel` |
| `parts/CharBuffs.ts` | `CharBuffRelay` — squad buff lists: `cbuf state` / `cbufq sync`, per-member `entries` mirrored onto refs |
| `parts/Meal.ts` | Shared-ship dining table wire (`meal req` / `meal serve`) |
| `parts/Crypto.ts` | `CryptoMarketClient` (`ctx.net.crypto`): ref-counted `watch()`, prices, history cache |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` into one reused object from `ctx.player` / `ctx.weapons` / `ctx.implants` |
| `RemotePlayer.ts` | `RemotePlayerRef`: 16-sample ring buffer rendered at `now - NET_INTERP_DELAY`, stream restart detection, ghost overlay, buff / pose mirrors |
| `ProfileSync.ts` | `ProfileRef` (`ctx.net.profile`): server record mirror, revisioned persistent write queue, `setMany` transactions, `addCredits` → `credits:tx` |
| `SocialSync.ts` | `SocialRef` (`ctx.net.social`): friends / requests / recent / blocks, squad invites, private chat (nonces, backlog, per-slot history + unread) |
| `RoomSync.ts` | `RoomsRef` (`ctx.net.rooms`): group-room mirror, pending → ack lines, history pages, per-room read marks |

## Public API

**`NetRef` (`ctx.net`)** — full signatures in `src/shared/net.ts`.

| Member | Notes |
|---|---|
| `status`, `connected`, `link`, `rttMs`, `reconnecting`, `sessionToken`, `localId`, `playerName` / `setPlayerName` | `localId` survives a drop so `isHost` does not flip mid-reconnect |
| `connect(url?)` / `ensureConnected()` / `disconnect()` | `ensureConnected` never rejects (false = offline ship) |
| `relayUrl`, `relayOverride`, `setRelayOverride(raw)`, `probeRelay(raw?)`, `reconnectRelay()` | Override = settings `서버 설정` (`RELAY_STORAGE_KEY`); probe is tokenless |
| `lobby`, `isHost`, `isAuthority`, `inSession`, `inHubSession`, `missionInProgress`, `missionMode`, `tookOver`, `localSlot` | `inHubSession` = **docked** lobby (`isDockedLobby`) && !inSession && phase `hub` && standing in the shared ship (`hub.ship === 'shared'` or a bay's ship, `hubSite !== null`) |
| `requestDock(isPublic)`, `dockPending` | 터미널 매칭 → `lobby:dock`. `dockPending` is true from the request (and from `createLobby` / `joinLobby` / `quickMatch`) until a docked lobby's `net:lobbyUpdated` **has been emitted**, a `lobby:error`, or leaving (kept through `moved`) — hub/ reads it inside that event to tell its own dock from the leader's |
| `createLobby` / `joinLobby` / `leaveLobby` / `quickMatch` / `setPublic` / `setLobbySeed` / `setReady` | Only `leaveLobby()` leaves a lobby; mission end keeps it |
| `startGame(seed, mode?, planet?, intel?)` | Raid: host, all ready; planet / intel default to the lobby's. Training: any member, no planet |
| `lobbyPlanet` / `setLobbyPlanet`, `lobbyIntel` / `setLobbyIntel` | Host-only, not started, mirrored optimistically, no event |
| `transferHost(targetId, claim?)`, `reportHostDown(down)` | Result arrives only as `lobby:state` → `net:hostChanged` |
| `rejoinMission()`, `leaveMission()` | Rejoin re-reads `lobby.mode` / `planet` / `intel`, then `flow rejoined` |
| `raidBlob`, `saveRaid(blob)` | Raid session blob from `welcome.raid`; save only inside a raid session |
| `serverNow()` | Relay wall clock (offset cached through disconnects) |
| `send(msg, to?)`, `onMessage(type, handler)` | `send` is a no-op unless connected and in a lobby |
| `getRemotePlayers` / `getRemotePlayer` / `getLobbyPlayer`, `getInviteUrl` | |
| `getCrewCard(id)` / `requestCrewLoadout(id)`, `getShipVisit(id)` / `requestShipVisit(id)` | Own id answers too (outgoing broadcast is snooped); peers may rate-limit answers |
| `profile`, `social`, `rooms`, `crypto` | See the sub-object sections below |

**Events emitted:** `net:statusChanged`, `net:error`, `net:linkChanged`, `net:relayChanged`, `net:reconnecting`,
`net:resumed`, `net:matched`, `net:lobbyUpdated`, `net:lobbyLeft`, `net:peerJoined` / `peerLeft`, `net:gameStarting`
(+ `game:newMission`), `net:hostChanged`, `net:peerSuspended`, `net:missionMembership`, `net:remotePlayerAdded` / `Removed`,
`net:remoteFired` / `Reloaded` / `Grenade` / `Died` / `Downed` / `Revived` / `Ping` / `CarryChanged` / `BuffsChanged`,
`net:chat`, `net:ghostState`, `net:ghostRestore`, `net:crewCard`, `net:crewLoadout`, `net:shipVisit`, `net:profileLoaded`,
`net:profileConflict`, `net:raidLoaded`, `net:cryptoPrices`, `net:cryptoHistory`, `social:*`, `room:*`,
`player:reviveProgress`, `player:applySlow`, `housing:mealServed` (re-emitted for received meals).

**Events consumed:** `game:complete` / `game:over` / `game:abort` (session end), `game:phaseChanged` (link),
`progress:loaded` / `progress:levelUp` (social level), `ui:chatToggled` (`TYPING`), `weapon:equipped`, `loadout:changed`,
`quick:equipped`, `equip:changed`, `implant:wieldChanged`, `player:buffsChanged`, `player:died`,
`housing:mealServed`, `leader:transferRequested`, `net:lobbyLeft`.

**Relayed messages handled here** (everything is also delivered to `onMessage` subscribers, and most types —
`hit/explode/es/ee/ex/exq/flow/crate/item/cont/ghostq/crewq/shipq/…` — only that way): `ps`, `fire`, `reload`,
`grenade`, `died`, `ping`, `chat`, `dmg` (→ `ctx.player.takeDamage(amount, from, source)` + slow / knockback, in session
only), `revive`, `ghost state|sync|restore|gone`, `flow takeover`, `crew card|loadout`, `ship state`, `carry pick|drop`,
`cbuf` / `cbufq`, `meal`.

## Connection and link state

```
 idle ─connect()─▶ connecting ─welcome─▶ connected ─drop─▶ reconnecting ─(no lobby, attempts exhausted)─┐
                     │ fail / NET_CONNECT_TIMEOUT_MS                                                   ▼
                     └──────────────────────────────────────────────────────────────────────────▶ unreachable
 unreachable: anonymous probeRelay every NET_PROBE_BACKOFF_MS[i] (last repeats)
   found → phase hub / menu: ensureConnected()   raid / training: {found:true}, connect on return to hub / title
 refused {kicked | server_full | duplicate}: no probe, no auto-reconnect; an explicit connect() clears it
 disconnect() → idle
```

- Reconnect: backoff `NET_RECONNECT_BACKOFF_MS`; with a suspended lobby it retries forever, and after
  `NET_MISSION_RESUME_TIMEOUT_MS` gives the lobby up locally (`net:lobbyLeft 'disconnected'`). Only an established
  connection that drops starts the loop; an initial failure just goes `unreachable`.
- Resume: `welcome.lobby` → `net:resumed {lobby, inProgress, seamless}`. Seamless = we were in session, lobby started,
  same seed → session and remotes kept (streams reset). Otherwise remotes are cleared and a started lobby we are not in
  sends `lobby:mission false` (a reload leaves the mission; a pod / terminal rejoins).
- Duplicate token: the server kicks the **older** socket (`lobby:error duplicate`) → `net:error`, `net:lobbyLeft 'kicked'`.
  `kicked` / `server_full` arrive before the close; `NetClient` passes them even pre-handshake and the Korean server
  message becomes the close reason.
- Desktop shell: its same-origin `/ws` is probed like any other target (2026-09-15 — the build has no embedded relay; with
  no address the shell pipes to this PC's `start-server.bat` relay). `NetLinkInfo.embedded` is never set.

## Sub-objects

**`ctx.net.profile` — `ProfileSync`.** Mirrors `welcome.profile` / `profile:docs`. `set(key, doc, {fresh?})` and
`setMany(docs)` enqueue; the queue persists at `slotKey(PROFILE_QUEUE_STORAGE_KEY)` (installed in `NetSystem.init` via
`useStorage`, before any folder saves) and a write leaves it only on ack, refusal, or conflict resolution.
- Each write carries `baseRev` + `writeId`; one in flight per key. `profile:ack` advances the rev; `profile:conflict` →
  the server copy wins (write and edits stacked on it dropped, `console.warn` + `net:profileConflict`, one `profile:get`);
  `profile:refused` → dropped.
- On welcome / docs (`applyRecord`): an unsent write whose base equals the server rev wins locally (folders receive
  their own offline progress in `net:profileLoaded`); a higher server rev wins with a conflict event, emitted
  **before** `net:profileLoaded`. A `fresh` default loses silently to any existing document.
- One-time transition fallback (C-69): if every key of an unsent write has never seen a rev, `baseRev 0` and a stamp,
  it is judged by the older timestamp rule (`docsAt`) and a loss is silent.
- Old relay (welcome without `docsRev`): stamp-based `{at}` / `{fresh}` frames (`flushLegacy`).
- `addCredits(delta, reason)` → `credits:tx` matched by `txId`; rejects only offline. `net:profileLoaded {migrated}`
  tells meta/ to upload its local balance with reason `migrate`. Not re-announced on a seamless resume.
- Consumers get their own pending document back inside the merged record and must treat it as a no-op.

**`ctx.net.social` — `SocialSync`.** The relay owns every social fact; the client never edits lists — requests are
answered with a whole snapshot (`social:updated {snapshot, first}`). Only `PlayerCode`s cross the wire. Every inbound frame
is sanitized field by field; everything is inert while `available` is false (except `refresh()`), and a disconnect empties
the lists. Invites: at most `SQUAD_INVITE_MAX`, own TTL timers, reply by invite id. Private chat (`whisper`): nonce →
`pending → sent / stored / failed` (`social:whisperUpdated`), offline backlog, per-slot history at
`slotKey(WHISPER_STORAGE_KEY)` with per-peer `readAt` (`whisperUnread`, `markWhisperRead`, `social:unreadChanged`);
records without `readAt` count as read. Chat window `/r` and the messenger share this history. Level is pushed with
`setLevel` (debounced, re-sent after every welcome).

**`ctx.net.rooms` — `RoomSync`.** Mirror of the relay's rooms, invites and line cache. It never sends `room:get` itself
(the relay pushes `room:state` after welcome; an old relay would answer `lobby:error invalid`, so `available` stays false).
`say` adds a `pending` line at once, ack → `sent` / `failed` (10 s or disconnect → `failed`). `respond` is the only
optimistic change. History pages merge by time. Unread: per-room `readAt` at `slotKey(ROOM_READ_STORAGE_KEY)`; a newly
seen room starts fully read; own, system and blocked-sender lines never count. Blocked senders' lines stay in the cache —
the UI hides them with `social.isBlocked(line.code)`; system text comes from `roomSystemTextKo`.

**`ctx.net.crypto` — `CryptoMarketClient`.** Quotes come only from the relay (`server/CryptoMarket.ts`). `watch()` is
ref-counted (`crypto:watch on/off`) and re-sent after every welcome (the server forgets per connection). `available` =
connected and prices received on this connection. `requestHistory(coin, range)` caches the last answer per
(coin, range) and folds every new price into the last candle. Trade screens must hold a `watch()` until the trade settles.

## Snapshot and remote-ref rules

- Snapshots go out while in session during a gameplay / deploying phase, or while `inHubSession`; never in `menu` /
  `docking`. A `ps` with `IN_HUB` is accepted only outside a session, a mission `ps` only inside — other-scene peers never
  become refs. Out-of-order `seq` is dropped; a restarted stream (`seq` far lower, or lower while stale) is accepted.
- Optional snapshot fields ride only while meaningful and are deleted otherwise: `dhp` (downed), `sh` / `shm` (armor
  worn — omitted means "unknown", receivers restore to max), `bhp` (barrier up), `cr` (carrying), `h` / `att`, `bfr`
  (non-zero buff revision), `fp` / `fu` (furniture pose). Flags include `IN_HUB`, `IN_POD`, `IN_ROVER` (raid only),
  `CLIMBING`, `TYPING`, `CARRYING` / `CARRIED` (a carrier is forced onto the no-gun path).
- `applyGhost` owns the pose: it masks `CARRYING` / `CARRIED` / `BARRIER` / `CLIMBING` / `IN_ROVER`, clears carrying,
  barrier hp, shield and furniture pose, keeps buffs. `ghostState` / `ghostDownHp` / `downHp` live on the ref.
- `carriedBy` is derived each frame while anyone carries, never sent; suspended carriers are ignored.
- Crew cards are clamped, never dropped; `equippedImplant` is the ship choice (`implantId` is nulled in the hub).
- `furniturePose` phase is cumulative and interpolated at the render time; kind / uid / anchor / yaw come from the newest
  sample. It is one object mutated in `tick` — copy it to keep it.
- Buff lists: `player:buffsChanged` marks dirty; `flush()` runs once per frame **before** the snapshot, so receivers never
  see a new `bfr` before its list. Lists live in per-member `entries` so a ref recreated at a scene change inherits them.
  A lower `rev` is accepted only when it equals the sender's latest `bfr` (sender reloaded). `resetStream` sets
  `buffsResync` to ask once more. Peer resync requests are rate-limited by `CHAR_BUFF_SYNC_COOLDOWN_S`.

## Rules

- `NetSystem` is registered **first** in `main.ts` so snapshots apply before anyone reads `ctx.net`.
- Nothing connects automatically except the link probe's "found in hub / menu" path; code that calls
  `ensureConnected()` on its own must check `ctx.net.link.state !== 'refused'` first — `parts/Socket.ts`.
- A server found during a raid / training is only recorded; a mid-mission welcome would make every persisting folder
  swap state via `net:profileLoaded` — `parts/Socket.ts`.
- The relay test / probe is always tokenless: the same token would be kicked as `duplicate`.
- Session end is deferred with `queueMicrotask`, so every synchronous handler of `game:complete|over|abort` still sees
  `inSession` and a working `send()` — `parts/Lobby.ts` (`scheduleEndSession`). Raid host then sends `lobby:reset`,
  everyone else `lobby:mission false`.
- `beginSession` sets `ctx.missionMode`, `ctx.missionPlanet` and `ctx.missionIntel = resolveIntelEffects(...)` **before**
  emitting `game:newMission` (the world generates inside the emit). Inbound `game:start` falls back to
  `msg.lobby.planet` / `lobby.intel` for relays that do not echo them; `rejoinMission` must restore both.
- `net:hostChanged` fires for any started lobby (not only in session); `tookOver` and `flow takeover` are session-only.
- A `refused` link is set before `dropLobby`, so `net:lobbyLeft` listeners can read `ctx.net.link.refused`.
- Meal wire: only sent from the shared-ship deck (`inHubSession && ctx.hub.hubSite === null`). The host checks shape →
  connected lobby member → both on the shared deck within `MEAL_SERVE_RANGE + BUFF_RANGE_SLACK` → token bucket
  (`META_HIT_RATE`), then sends `serve` individually to each member in range. Receivers accept `serve` only from the
  lobby host, call `progression.serveMeal(def, normalizeMealQuality(q))` and re-emit `housing:mealServed` under a
  re-entry guard (`applying`). Quality `q` is omitted when 0 — `parts/Meal.ts`.
- `dmg.src` is checked with `damageSourceFromWire`; a malformed source becomes `undefined` (unknown) and never rejects
  the damage — `parts/Messages.ts`.
- `parts/` import rule: parts take the instance as first argument `sys`, import `NetSystem.ts` **types only**, and put
  shared values in `model.ts`. Members made non-private for `parts/` are still folder-internal.

## Recent changes

Last 5 only — older: `git log -- src/net`.
- 2026-09-15 — Squads vs shared ship: `inHubSession` needs a docked lobby + standing in its shared ship (hub `ps` from anywhere else dropped); `withSession` adds `&a=<accent>`; `dockPending` also set by create / join / quick match, cleared after the docked `net:lobbyUpdated`, on `lobby:error`, kept through `moved`; `SocialSync.playBlock` → `in_squad` / `not_leader`.
- 2026-09-15 — `dmg.src` damage source decoded and passed as the third `takeDamage` argument.
- 2026-09-14 — Intel wire: `lobbyIntel` / `setLobbyIntel`, `startGame(…, intel)`, `ctx.missionIntel` set in `beginSession`, restored on rejoin.
- 2026-09-14 — `RoomSync.ts` (group rooms); private-chat unread in `SocialSync`.
- 2026-09-13 — `parts/Crypto.ts` (`ctx.net.crypto`); `PlayerFlags.IN_ROVER`; meal quality `q` on `meal req|serve`.
