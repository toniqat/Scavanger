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
| `parts/Plates.ts` | Dining plates wire (`plate state` / `plateq sync`) → `net:squadPlate` (replaced the old `parts/Meal.ts`, 2026-09-16) |
| `parts/Crypto.ts` | `CryptoMarketClient` (`ctx.net.crypto`): ref-counted `watch()`, prices, history cache |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` into one reused object from `ctx.player` / `ctx.weapons` / `ctx.implants` |
| `RemotePlayer.ts` | `RemotePlayerRef`: 16-sample ring buffer rendered at `now - NET_INTERP_DELAY`, stream restart detection, ghost overlay, buff / pose mirrors |
| `ProfileSync.ts` | `ProfileRef` (`ctx.net.profile`): server record mirror, revisioned persistent write queue, `setMany` transactions, `addCredits` → `credits:tx` |
| `SocialSync.ts` | `SocialRef` (`ctx.net.social`): friends / requests / recent / blocks, squad invites, private chat (nonces, backlog, per-slot history + unread) |
| `TrustSync.ts` | `TrustRef` (`ctx.net.trust`): player ↔ player pair trust from `SocialSnapshot.trust` + `trust:gain`, the like window (`trust:window`, optimistic until it arrives), `like` → `trust:like`, `beforeRaid` captured on a raid `game:start` |
| `RoomSync.ts` | `RoomsRef` (`ctx.net.rooms`): group-room mirror, pending → ack lines, history pages, per-room read marks |

## Public API

**`NetRef` (`ctx.net`)** — full signatures in `src/shared/net.ts`.

| Member | Notes |
|---|---|
| `status`, `connected`, `link`, `rttMs`, `reconnecting`, `sessionToken`, `localId`, `playerName` / `setPlayerName` | `localId` survives a drop so `isHost` does not flip mid-reconnect |
| `connect(url?)` / `ensureConnected()` / `disconnect()` | `ensureConnected` never rejects (false = offline ship) |
| `relayUrl`, `relayOverride`, `setRelayOverride(raw)`, `probeRelay(raw?)`, `reconnectRelay()` | Override = settings `서버 설정` (`RELAY_STORAGE_KEY`); probe is tokenless |
| `lobby`, `isHost`, `isAuthority`, `inSession`, `inHubSession`, `missionInProgress`, `missionMode`, `tookOver`, `localSlot` | `inHubSession` = **docked** lobby (`isDockedLobby`) && !inSession && phase `hub` && standing in the shared ship (`hub.ship === 'shared'` or a bay's ship, `hubSite !== null`) |
| `setAndroidBay(bay, recruit)` | 2026-09-15 — leader only: put the cockpit bay's android into / out of the squad (`lobby:android`). Result is the relay's `lobby:state`; never mirrored optimistically (the relay owns the cap and the slot). Not connected / no lobby / not the leader → `net:error` (`server` · `not_in_lobby` · `not_host`) |
| `requestDock(isPublic)`, `dockPending` | 터미널 매칭 → `lobby:dock`. `dockPending` is true from the request (and from `createLobby` / `joinLobby` / `quickMatch`) until a docked lobby's `net:lobbyUpdated` **has been emitted**, a `lobby:error`, or leaving (kept through `moved`) — hub/ reads it inside that event to tell its own dock from the leader's |
| `createLobby` / `joinLobby` / `leaveLobby` / `quickMatch` / `setPublic` / `setLobbySeed` / `setReady` | Only `leaveLobby()` leaves a lobby; mission end keeps it |
| `startGame(seed, mode?, planet?, intel?)` | Raid: host, all ready; planet / intel default to the lobby's. Training: any member, no planet |
| `lobbyPlanet` / `setLobbyPlanet`, `lobbyIntel` / `setLobbyIntel` | Host-only, not started, mirrored optimistically, no event |
| `transferHost(targetId, claim?)`, `reportHostDown(down)` | Result arrives only as `lobby:state` → `net:hostChanged` |
| `rejoinMission()`, `leaveMission()` | Rejoin re-reads `lobby.mode` / `planet` / `intel`, then `flow rejoined`; refused locally (`net:error drifted`) for a raid I abandoned |
| `abandonRaid()` | 2026-09-15 title `레이드 포기`: `lobby:abandon`, marks me `drifted` and drops `raidBlob` at once, emits `net:lobbyUpdated`; no-op in session / without a connected running raid |
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
`net:androidReturned`,
`net:chat`, `net:ghostState`, `net:ghostRestore`, `net:crewCard`, `net:crewLoadout`, `net:shipVisit`, `net:profileLoaded`,
`net:profileConflict`, `net:raidLoaded`, `net:cryptoPrices`, `net:cryptoHistory`, `social:*`, `room:*`,
`player:reviveProgress`, `player:applySlow`, `net:squadPlate` (a squadmate's dining plate).

**Events consumed:** `game:complete` / `game:over` / `game:abort` (session end), `game:phaseChanged` (link),
`progress:loaded` / `progress:levelUp` (social level), `ui:chatToggled` (`TYPING`), `weapon:equipped`, `loadout:changed`,
`quick:equipped`, `equip:changed`, `implant:wieldChanged`, `player:buffsChanged`, `player:died`,
`housing:plateChanged`, `leader:transferRequested`, `net:lobbyLeft`.

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
  sends `lobby:mission {inMission:false, keep:true}` (a reload leaves the mission but the relay keeps the blob; the title's
  `이어하기` or a pod / terminal rejoins).
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

**`ctx.net.trust` — `TrustSync`** (2026-09-21, rules in `shared/playerTrust.ts`, wire in `docs/MULTIPLAYER.md` §11). The relay
owns every value; the pair map is replaced by each `SocialSnapshot.trust` (welcome · `social:state`) and one pair is updated
by `trust:gain` (→ `net:trustChanged {code, name, points, delta, reason, mine?}` for the result screen). A raid `game:start`
(not a rejoin) captures the values (`beforeRaid`) and takes the lobby's other humans as the like window's guess, so
`canLike` is true before the relay's `trust:window` arrives; the relay then decides (`net:trustWindow`), a refusal comes back
as `net:trustRefused` and takes the optimistic mark back. Levels are `playerTrustInfo(points, PLAYER_TRUST_TABLE)`. Likes are
refused locally while disconnected or anonymous.

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
- Plate wire (2026-09-16, replaces the host-relayed `meal` wire): `plate state {def?, q?, fresh?}` = the sender's **own**
  plate, sent to `others` on `housing:plateChanged` while `inHubSession` and once on the frame we enter the hub session
  (`tick`), together with `plateq sync`; a `plateq` is answered to the requester only (`CHAR_BUFF_SYNC_COOLDOWN_S` per
  requester). Receivers accept connected non-bot lobby members, a known meal id (`getMealDef`) and a normalized quality,
  then emit `net:squadPlate`. No host authority: the plate is the sender's own state and eating only changes the eater's
  profile — `parts/Plates.ts`. The `meal` message type stays declared in `shared/net.ts` and is never sent.
- `dmg.src` is checked with `damageSourceFromWire`; a malformed source becomes `undefined` (unknown) and never rejects
  the damage — `parts/Messages.ts`.
- **Android bot members are not peers** (2026-09-15). A `LobbyPlayer` with `bot` is an android the relay put in the squad
  (`src/shared/net.ts` last section); it has no socket, so nothing here ever addresses it. `applyLobby` emits no
  `net:peerJoined` / `peerLeft` for it (allies/ announces roster changes from `androidPlayersOf(lobby)`),
  `syncRemoteIdentities` skips it (no `RemotePlayerRef`, no `net:missionMembership`, and it never enters the crew-card /
  ship-visit / buff-list pruning sets), squad codes skip it (a bot has no `code`) and `parts/Plates` never accepts a plate
  from one. **Squad size is humans-only where the question is social** — `SocialSync.squadSize` feeds
  `playBlockReason` (invite gates), matching the relay's own humans-only cap; folders asking "how many fighters" (enemy /
  difficulty scaling) read `ctx.net.lobby` themselves and count androids.
- `lobby:androidReturned` only explains a roster change the `lobby:state` already carried, so it is translated straight to
  `net:androidReturned` and touches no local state; a malformed frame is dropped (one missing toast, never a wrong roster).
- `parts/` import rule: parts take the instance as first argument `sys`, import `NetSystem.ts` **types only**, and put
  shared values in `model.ts`. Members made non-private for `parts/` are still folder-internal.
- **Intended multiplayer limits**: no lag compensation on client shots (the host checks the enemy id and a damage ceiling
  only); remote hellpods are not rendered; the ship's launch countdown is a client-local mirror (no wire message); a
  joining client is not told about a cloak already in progress.
- **Accounts are per-token profiles.** Login and sharing one character across devices are out of scope (Phase 5).
- **Crew cards carry no bag**: `CrewCardWire` is level · implant · armor · primary · primary2 · secondary, so a squadmate's
  bag thumbnail on the launch-slot card is `?` and the value sum leaves out bag and tactical implant. Someone else's
  weapon sockets are drawn as empty outlines rather than claiming 「부착물 없음」. Fixing it is a wire extension first.
- A visited personal ship shows no dining plate — `ShipVisitWire` carries no plate. — `parts/Plates.ts`

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **`explode` guard: shape · sender · distance · rate, sharing `hit`'s bucket; a dead sender is accepted.** Rejected: per-kind caps.
- **Status bits (`st`) use their own count bucket.** Rejected: pre-deducting DoT (nerfs legit multi-target flames).
- **Profile sync by revisions, server wins** (replaced timestamp sync).

## Recent changes

Last 5 only — older: `git log -- src/net`.
- 2026-09-21 — Player ↔ player trust: `TrustSync` as `ctx.net.trust` (`get` · `infoOf` · `beforeRaid` · `canLike` · `hasLiked` · `like`), fed by welcome / `social:state` / `trust:gain` / `trust:window` / `trust:refused` in `parts/Messages` + `parts/Socket`, captured on a raid `game:start`.
- 2026-09-21 — `lobby:look.shipModel` became a **nudge** (B-101): the relay no longer stores what the client says — it fills `LobbyPlayer.shipModel` from that member's own `progression` document. `pushShipModel` therefore de-duplicates against the new `NetSystem._pushedShipModel` instead of against my own lobby row: that row is the relay's answer, and a profile with no uploaded document leaves it empty for good, so the old comparison nudged on **every** `lobby:state` and each nudge broadcast another one. The field is cleared in `dropLobby`.
- 2026-09-21 — `docs/TODO.md` B-83: the never-read `NetSystem.embeddedCache` field removed (a 2026-09-15 「builds ship no server」 leftover — `NET_SHELL_RELAY_ROUTE` is asked for by `ui/menus/SettingsMenu` alone), and the JSDoc of the `meal serve` wire deleted on 2026-09-16 taken off `plateRelay`.
- 2026-09-20 — Code comments translated to English (project-wide rule change, CLAUDE.md §4.1); Korean on-screen labels and decision headings kept verbatim in backticks / 「」, no string literal touched.
- 2026-09-17 — `sanitizeShipVisit` keeps `cultures` (placed uid · slot < `CULTURE_MAX_SLOTS` · medium id · `s: 1` strain flag, one per slot) for the visited culture tank model.
