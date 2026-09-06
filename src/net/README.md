# src/net — Multiplayer client (`NetSystem`, publishes `ctx.net`)

Browser side of the multiplayer stack. Talks to the Node relay in `server/` over WebSocket, mirrors the lobby,
broadcasts the local `PlayerSnapshot` (in missions **and** in the shared ship hub), exposes interpolated
`RemotePlayerRef`s, and survives socket drops / page reloads by resuming into the same party. Host-authoritative
gameplay: `ctx.isAuthority` is `!inSession || isHost`; other systems gate enemy / extraction simulation on it.
Contract: `src/shared/net.ts` (types + constants) and the `net:*` events in `src/shared/events.ts`.

| File | Responsibility |
|---|---|
| `NetSystem.ts` | `GameSystem` (`name: 'net'`, registered first in `main.ts`) implementing `NetRef`. Session token, connection lifecycle + auto-reconnect state machine, lobby mirror (`lobby:state` diff → `net:peerJoined/peerLeft`; Phase 7: `net:missionMembership`, `net:peerSuspended`, `net:hostChanged`), quick match, `game:start` / `rejoinMission()` → `net:gameStarting` + `game:newMission` (training-aware), `leaveMission()`, session end (`game:complete/over/abort` → raid host sends `lobby:reset`, everyone else `lobby:mission false`), snapshot broadcast at `NET_PLAYER_SNAPSHOT_HZ` (mission + hub), inbound relay dispatch (bus translation + `onMessage` subscribers; `ghost` / `dmg.kb` / `flow takeover` applied here), remote player registry, `profile` / `raidBlob` / `saveRaid` / `missionMode` / `tookOver`; Phase 8: `serverNow()`; Phase 9: the cached `serverOffset`, `net:hostChanged` for any *started* lobby (not only in-session), the reload → `lobby:mission false` rule, and `lobby:error` forwarded to `ProfileSync.onError`. |
| `ProfileSync.ts` | `ProfileRef` implementation behind `ctx.net.profile` (Phase 7): mirrors the server `ProfileRecord` from `welcome.profile` / `profile:docs`, `get(key)`, `set(key, doc, {fresh?})` with a `PROFILE_SYNC_DEBOUNCE_MS` upload queue (`profile:set`), `flush()` (also on `pagehide`, on session end and right after every welcome), `addCredits(delta, reason)` → `credits:tx` matched by `txId` (10 s timeout; rejects only when offline). Emits `net:profileLoaded {profile, migrated}` (`migrated` = server credits still null → meta/ uploads its local balance with reason `'migrate'`). `available=false` + `credits=null` while the socket is down; pending transactions reject on a drop. **Phase 9 (newest wins)**: a `set` is **never dropped any more** — availability is irrelevant, every call lands in the `pending` map as `{doc, at}` where `at = serverNow()` (a `fresh` save carries `at: null`) and only the debounce timer is gated on the connection, so an offline queue simply waits for the next welcome. `flush()` sends `{key, doc, at}` or `{key, doc, fresh:true}` and mirrors the accepted stamp into `docsAt`. `applyRecord` (shared by `onWelcome` / `onDocs`, and where `migrated` is computed for both) mirrors the server record + its `docsAt`, then merges the queue over it: a stamped pending doc survives only while `at >= docsAt[key]` (ties: ours), a `fresh` one only while the server has nothing for that key — a loser is dropped and the server copy wins. `onError('too_large')` evicts the keys of the last flush so a doc the server refuses is never retried forever. `pendingKeys` exposes the queue for diagnostics / smokes. |
| `NetClient.ts` | Bare WebSocket transport: `connect(url)` resolves on `welcome`, JSON encode/decode with validation (type whitelist incl. `profile:docs` / `credits:result`, 2 MB inbound cap — a welcome may carry every profile document plus a raid blob), `ping` every 2 s → `rttMs`, status changes (`offline/connecting/connected/error`), clean `close()`. Phase 8: `serverTimeOffset` (`serverTime - performance.now()`) is captured at the **welcome** as well as at every pong, with `hasServerTime` telling whether the current connection ever supplied a clock (both reset by `teardown`). No lobby, reconnect or gameplay knowledge. |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` from `ctx.player` into one reused object (floats rounded to 3 decimals). Caches active weapon id/slot from `weapon:equipped` / `loadout:changed` for `w`, `HAS_WEAPON`, `TWO_HANDED`. Sets `IN_HUB` while `ctx.isHubPhase()` (and hides the weapon there) and `IN_POD` from `ctx.player.isInPod`. Phase 7: reads `ctx.weapons.remoteState` every snapshot (guarded when weapons is absent) → `h` (held consumable def id while `HOLDING_ITEM`), `att` (attachment ids of the active weapon, omitted when none / in the hub), flags `THROWING / COOKING / CHARGING / SPRAYING / HEAVY`; `ctx.player.isMeleeHeavy` → `MELEE_HEAVY`. Phase 9: `dhp` (`Math.round(player.downHp)`) rides along while the player is downed and is deleted otherwise, so a host ghost inherits the real bleed pool instead of a full one. |
| `RemotePlayer.ts` | `RemotePlayerRef` implementation. 16-entry ring buffer of `{arrival, snapshot}`; `tick(now)` renders at `now - NET_INTERP_DELAY`: lerp position/velocity/pitch, shortest-arc yaw/stride, extrapolate ≤ 0.25 s past the newest sample then hold, `stale` after `NET_STALE_AFTER`. Discrete fields (stance, flags, hp, weaponId, moveBlend, `heldItemId`, `attachments` — same array while unchanged) come from the newest sample. `resetStream()` forgets the `seq` guard + history when a peer's stream restarts (reload / rejoin with the same stable id); `push` also detects a restart itself (`seq` ≥ 200 below the last one, or any lower `seq` while stale). Phase 7: `suspended` / `inMission` mirrors, `applyGhost(GhostWire)` (position / yaw / hp / DOWNED / DEAD from the host's ghost, `ghosted=true` → `tick` leaves the pose alone, `ghostDownHp`), `clearGhost()` (ghost gone; the next live `push` also clears it). `position`/`velocity` are stable `Vector3` instances. Phase 9: `applyGhost` also stores `ghostState` (`GhostWire.st`: 0 alive / 1 downed / 2 dead) and `clearGhost` resets both it and `ghostDownHp` to `undefined` — game/ reads `ref.ghostState` for the wipe check instead of keeping its own map; `push` fills `downHp` from `PlayerSnapshot.dhp` while the DOWNED flag is set (undefined otherwise), which is what the host's `createGhost` inherits. |
| `index.ts` | Barrel. |

## Session token → stable PeerId
- `sessionToken`: 24 url-safe chars generated once with `crypto.getRandomValues` and stored under
  `NET_TOKEN_STORAGE_KEY` (`localStorage`). Every connect appends `?t=<token>&n=<playerName>`; the server derives
  the same `PeerId` from it, so reloads / drops come back as the same player (same slot, same colour).
- `localId` is cached from the last `welcome` and kept while the socket is down, so `isHost` / `isAuthority` do not
  flip mid-reconnect. Cleared only by `disconnect()`. The server keeps `hostId` on a started lobby for the whole grace
  (hub lobbies migrate immediately), so a dropped host keeps simulating and resumes as the authority.
- Two tabs with one token: the server kicks the **older** socket with `lobby:error duplicate` → that tab emits
  `net:error {duplicate}`, `net:lobbyLeft {reason:'kicked'}` and never auto-reconnects; the new tab resumes the lobby.

## Connection / reconnect state machine
```
                 ensureConnected() / connect()
   offline ─────────────────────────────────▶ connecting ──welcome──▶ connected
      ▲                                          │ fail                  │
      │      (no lobby, attempts exhausted)      ▼                       │ socket drops
      └──────────────────────────────────── reconnecting ◀──────────────┘  (not via disconnect(), not 'duplicate')
                                             │  ▲   lobby kept (suspended), inSession kept, remotes kept
                                             │  └── retry after NET_RECONNECT_BACKOFF_MS[attempt] (last value repeats)
                                             │      → net:reconnecting {attempt, nextInMs} before each wait
                                             │      lobby suspended → retry forever; after NET_MISSION_RESUME_TIMEOUT_MS
                                             │        the lobby is given up locally (net:lobbyLeft 'disconnected') and
                                             │        the loop continues without it for the remaining attempts
                                             ▼ welcome
        welcome.lobby present ──▶ applyLobby → net:resumed {lobby, inProgress, seamless}
              seamless = we were inSession before the drop && lobby.started && lobby.seed === our mission seed
                 → keep inSession + remotes (their streams are reset; fresh snapshots follow); nothing to rebuild
              otherwise → inSession=false, remotes cleared; inProgress = lobby.started (rejoin from a pod possible)
        welcome.lobby absent  ──▶ if a lobby was suspended: net:lobbyLeft {reason:'disconnected'}
```
- Only an **established** connection that drops starts the loop; an initial `connect()` failure just rejects
  (`ensureConnected()` → `false`, offline personal ship). Without a lobby the loop stops after
  `NET_RECONNECT_BACKOFF_MS.length` attempts; with a suspended lobby it never stops on its own.
- A fresh page load with a stored token: `ensureConnected()` → `welcome.lobby` → `net:resumed {seamless:false}` with
  `inProgress` telling the hub whether the party is mid-mission.
- `net:statusChanged` is emitted for every transport status change as before (UI shows connecting/error).

## Lobby / hub / mission API (what the hub & UI call)
| `NetRef` member | Effect |
|---|---|
| `ensureConnected(): Promise<boolean>` | Idempotent connect to `VITE_WS_URL` or same-origin `/ws`; never rejects. Call at hub startup. |
| `createLobby()` / `joinLobby(code)` / `leaveLobby()` | As before; `createLobby` → private ship. `leaveLobby()` while offline drops the suspended lobby locally. **Only `leaveLobby()` leaves** — mission end / abort keeps the lobby. |
| `quickMatch()` | `lobby:quickmatch`; the next `lobby:state` with a new code → `net:matched {lobby, created}` (`created` = we opened a new public ship). Errors via `net:error`. |
| `setPublic(isPublic)` / `setLobbySeed(seed)` | Host only; server broadcasts → `net:lobbyUpdated` (`lobby.isPublic`, `lobby.seed`; the seed is mirrored optimistically). |
| `setReady(ready)` / `startGame(seed)` | Ready = "in a launch pod"; start requires every *connected* member ready. On a started lobby `setReady` is a server-side no-op. |
| `setPlayerName(name)` | Persists the name; while in a lobby also sends `lobby:name` so the ship shows it. |
| `missionInProgress` | `lobby.started && !inSession` — the party is in a mission we are not part of (after a resume, or after aborting alone). |
| `rejoinMission()` | If `missionInProgress && lobby.seed != null`: sends `lobby:mission true`, `inSession=true`, `ctx.missionMode = lobby.mode ?? 'raid'`, `net:gameStarting {seed, lobby, rejoin:true, mode}` → `game:newMission {seed, mode}`, then `flow rejoined` to `'all'`. Used both for a raid rejoin (world by seed, enemies from `es`, extraction `exq sync`, pickups `itemq sync`, body back via `ghost restore`) and for **joining a running training** from the terminal. |
| `inHubSession` | `lobby !== null && !inSession && phase === 'hub'`: snapshots are exchanged in the shared ship. |
| `reconnecting`, `sessionToken` | See above. |
| `startGame(seed, mode?)` | `'raid'` (default): host only, everyone ready. `'training'`: any member, no ready gating; the server marks only the caller `inMission`. |
| `leaveMission()` | Leave the running mission but keep the lobby: `inSession=false`, remotes cleared, `lobby:mission false` (the server closes a training when its last member leaves), `net:lobbyUpdated`. game/ calls it on a training exit; a client's own abort goes through `game:abort` and ends the same way. |
| `missionMode` | `lobby.mode ?? 'raid'` while the lobby is started, else null. |
| `profile` | `ProfileRef` (see `ProfileSync.ts`). |
| `raidBlob` / `saveRaid(blob)` | `welcome.raid` (also announced as `net:raidLoaded`) kept until the session ends; `saveRaid` sends `raid:save` only inside a raid session with the session's seed (size-guarded by `RAID_BLOB_MAX_BYTES`). |
| `tookOver` | true once we were promoted to host during a session (reset at every session start / end). |
| `serverNow()` | **Phase 8.** Relay wall clock in epoch ms: `performance.now() + NetClient.serverTimeOffset` (offset from `welcome.serverTime` / every `pong`). `performance.now()` is monotonic, so moving the system clock cannot advance a real-time timer — housing/ stamps `GrowPlot.plantedAt` / `readyAt` with it so 온실 crops agree across devices. **Phase 9**: `NetSystem` caches the offset in `serverOffset` at every welcome / pong and **keeps it through a disconnect**, so profile stamps written offline stay on the server's clock; only a session that never saw a welcome falls back to `Date.now()`. |

## Behaviour notes
- **Never auto-connects on its own**; the hub calls `ensureConnected()`. Single-player works with no server.
- Player name persists in `localStorage['scav.playerName']`; default via `sanitizePlayerName('')` (`스캐빈저`).
- `inviteCode` is parsed from `?lobby=CODE` at init; `getInviteUrl()` builds the shareable link for the current lobby.
- `send()` is a no-op unless connected **and** in a lobby (default target `'others'`).
- Snapshots are sent while `inSession && ctx.player && (isGameplayPhase() || phase === 'deploying')` **or**
  `inHubSession`. Never in `menu` / `docking`.
- **Spaces**: a `ps` carrying `IN_HUB` is only accepted while we are *not* in a session, a mission `ps` only while we
  are — peers in the other scene never become remote refs here (an existing ref just goes `stale`). Extraction /
  GameFlow additionally ignore `stale` refs, so someone who left for the ship does not block the liftoff.
- Relayed message routing:
  - `ps` → RemotePlayer (created on first snapshot → `net:remotePlayerAdded`; out-of-order `seq` dropped, restarted streams accepted)
  - `fire/reload/grenade/died` → `net:remoteFired/remoteReloaded/remoteGrenade/remoteDied`
  - `ping` → `net:remotePing {id, position, kind}` (`kind` validated against `PingKind`, default `ground`; `label`/`enemyId` via `onMessage('ping')`)
  - `chat` → `net:chat {id, name, text, kind}` (`kind` validated against `ChatKind`, default `text`)
  - `dmg` → `ctx.player.takeDamage(amount, from)` (+ `player:applySlow` when `slow` present, + `applyKnockback(d, s)` when `kb` present), only while `inSession`
  - `ghost state` / `ghost sync` → the member's ref (created if missing) gets `applyGhost` → `net:ghostState {id, hp, downHp, state}`; `ghost restore` addressed to us → `net:ghostRestore {state}` (`PlayerRestoreState` with a `Vector3`); `ghost gone` → `clearGhost()`
  - `flow takeover` (from the new host) → `net:hostChanged {hostId: from, prev, isLocalHost:false}` so every system re-requests its sync
  - **everything** (including the above) is also dispatched to `ctx.net.onMessage(type, handler)` subscribers —
    `hit/explode/hitc/es/ee/ex/exq/flow/crate/item/itemq/cont/contq/ghostq/…` are delivered *only* that way.
- Lobby diffing: `lobby:state` emits `net:peerJoined/peerLeft` only when a previous state for the same lobby existed;
  a member flipping `connected` false → true resets that remote's snapshot stream. `peer:left` (grace expired) →
  lobby updated, RemotePlayer `connected=false`, removed 1 s later (`net:remotePlayerRemoved`).
- `game:start` (and `rejoinMission`) clear the hub remotes; mission avatars are re-created from the first snapshots.
  `game:start {mode:'training'}` enters the session only when our `LobbyPlayer.inMission` is true (the starter);
  everyone else just mirrors the lobby (`missionInProgress`, `missionMode === 'training'`) and may join later with
  `rejoinMission()`. `ctx.missionMode` is set right before `game:newMission` (the world generates synchronously inside it).
- **Session end ordering.** NetSystem is registered before GameFlow/Extraction, so its `game:complete` / `game:over` /
  `game:abort` handlers do *not* flip `inSession` synchronously. The end is deferred with `queueMicrotask`: every
  synchronous handler of that same event (GameFlow's `flow abort`, Extraction's `ex reset`, …) still sees
  `inSession === true`, `isAuthority` unchanged and a working `send()`. Only after that microtask does NetSystem
  set `inSession = false`, dispose remotes and (as host) send `lobby:reset`. The lobby stays: the player returns to
  the shared ship; a client that aborted alone sees `missionInProgress` until the host resets.
- `lobby:left` → `lobby = null`, `inSession = false`, remotes disposed, `net:lobbyLeft {reason:'left'}`.
- Debug: `window.__game.getSystem('net')` or `window.__game.ctx.net`.

## Phase 7 (2026-09-06): profile · raid session · suspended members / ghosts · host migration · training
- **Profile**: `welcome.profile` → `ProfileSync.onWelcome` → `net:profileLoaded {profile, migrated}` (skipped on a
  *seamless* mid-mission resume: the documents cannot have changed, only availability / credits refresh). Persisting
  folders call `profile.set(key, save)` after each local save; `get(key)` answers from the mirror. Offline → `addCredits`
  rejects (`오프라인`) and callers fall back to their local path; `set` was a no-op here **until Phase 9**, where it queues
  instead (see below).
- **Suspended members**: on every `lobby:state` the refs mirror `inMission` (`LobbyPlayer.inMission`, else
  `started && connected`) and `suspended = inSession && inMission && !connected`. Changes emit `net:peerSuspended
  {id, name, suspended}` (also right after a ref is created already suspended, e.g. from a `ghost state`) and
  `net:missionMembership {id, inMission}` (for every member, ref or not). A suspended ref is **never removed** for it —
  only `peer:left` (grace expiry) removes refs. The host's `RemotePlayerSystem` turns a suspended ref into a ghost and
  broadcasts `ghost state`; here `applyGhost` overrides that ref's pose / vitals until `ghost gone` or a live snapshot.
- **Host migration**: `lobby.hostId` changing while `inSession` → `net:hostChanged {hostId, prev, isLocalHost}` (from
  `lobby:state` *and* `peer:left`). When we are the new host: `tookOver=true`, the event runs every local promotion
  synchronously, then `flow takeover` goes to `'others'`, who emit `net:hostChanged {isLocalHost:false}` again and
  re-request their syncs. A returning old host resumes seamlessly and is demoted by the same event. A seamless resume by
  a non-host also sends `flow rejoined` (the new host may hold our body as a ghost → `ghost restore`).
- **Session end**: raid host → `lobby:reset` (clears every `inMission` + raid blobs); raid client / any trainee →
  `lobby:mission false` (the server resets a training once nobody is left). `leaveMission()` does the same synchronously
  and is a no-op for the deferred end afterwards (`inSession` already false).
- **Snapshot fields**: `h`, `att`, `THROWING / COOKING / CHARGING / SPRAYING / HEAVY / MELEE_HEAVY` (see `Snapshotter`);
  `RemotePlayer.heldItemId` / `attachments` expose them (player/ and weapons/ may also read the raw `ps` via `onMessage`).
- Not done here (other folders): ghost simulation itself (player/), raid blob capture / apply and the restore timeout
  (game/), container authority (inventory/), training arena (world/), terminal entry (hub/).

## Phase 9 (2026-09-06): newest-wins profiles · ghost fields on the ref · reload = mission leave
- **Profiles are never dropped.** `profile.set(key, doc)` always queues (see `ProfileSync.ts` above); the server decides
  the winner by stamp (`profile:set {at}`, `ProfileRecord.docsAt`, `PROFILE_CLOCK_SKEW_MS`). Default / starter saves go up
  as `set(key, doc, {fresh:true})` — no stamp, accepted only while the server has no document for that key, so a
  brand-new client's empty stash never overwrites a real profile. Owning folders (inventory / meta / progression /
  housing) no longer keep their own offline queues.
- **`serverNow()` survives a drop** (offset cached in `NetSystem.serverOffset`), so a stamp written offline is still on
  the relay's clock when the queue flushes.
- The merge itself is smoke-covered: `scripts/smoke-search.mjs` imports `/src/net/ProfileSync.ts` in the page and drives
  a stubbed instance (`send` / `serverNow` replaced, no socket) — a queued edit stamped after the server copy is kept
  and flushed with its `at`, an older one loses to the server document, and a `fresh` default only fills a key the
  server has no document for. Consumers must expect their **own** pending document back inside the merged record and
  do nothing with it (inventory compares it against its local state before applying).
- **Ghost fields live on the ref**: `RemotePlayerRef.ghostState` / `ghostDownHp` (from `ghost state / sync`, cleared by
  `ghost gone`) and `downHp` (from `PlayerSnapshot.dhp` while DOWNED). game/ dropped its own `net:ghostState` map and
  reads `ref.ghostState` for the wipe check; player/'s `createGhost` inherits `ref.downHp` instead of a full pool.
- **`net:hostChanged` outside the session**: the guard is now `lobby.started` instead of `_inSession`, so a hub member of
  a running lobby also learns about a migration (every system is a no-op outside a live mission anyway). `tookOver` and
  the `flow takeover` broadcast stay session-only.
- **A reload leaves the mission.** A non-seamless `welcome` into a started lobby while we are not in the session and the
  server still lists us as `inMission` sends `lobby:mission false` (mirrored optimistically). The host then parks our
  ghost and the server never waits on us for the authority; a pod / the terminal re-enters with `rejoinMission()`,
  which flips the flag back.

## Verified (2026-09-06, Phase 7)
`npm run typecheck` clean for `src/net` (remaining errors were in other agents' in-progress folders), `npm run
typecheck:server` clean, `npm run net:selftest` **165/165** (×4 runs). `node scripts/e2e-multiplayer.mjs` against a
private relay (`PORT=8797`) + vite (`VITE_WS_URL=ws://127.0.0.1:8797/ws`, port 5311): **70/70** — profile loaded from
welcome (`migrated:true`, meta migrated 500 credits), `addCredits(0)` round trip, overdraft refused with `크레딧 부족`,
every member `inMission` after the raid start, `net:peerSuspended` true → false around B's socket drop, host A held
offline > 4 s → B `net:hostChanged {isLocalHost:true}` + `tookOver` + authority, A resumed seamlessly and demoted
(`isLocalHost:false`), `flow rejoined` reached the new host, the new host's abort reset the lobby for both, no console
errors on either client.

## Verified (2026-09-05)
`npm run net:selftest` 101/101. Node-level harness (TS sources under Node 24 type stripping + `@/` resolve hook, real
relay, two–four `NetSystem` instances with stub contexts): token generation/persistence, `ensureConnected`
idempotency, hub snapshots with `IN_HUB`/`IN_POD`, none in `menu`, drop → `net:reconnecting {1, 800}` with lobby
kept and no `net:lobbyLeft`, resume in the hub, `setLobbySeed`/`setPublic` broadcast, `game:start` authority split,
seamless mid-mission resume keeping the host's remote ref, client abort → `missionInProgress`, hub `ps` ignored by a
mission peer, `rejoinMission` → `net:gameStarting` + `flow rejoined` at the host, `quickMatch` → `net:matched
{created:true}`, duplicate tab → `net:error duplicate` + `net:lobbyLeft kicked` on the old tab and `net:resumed
{inProgress:true}` on the new one, host `game:complete` → lobby reset, `disconnect()` never reconnects; host drop mid-mission → `isHost`/`isAuthority` stay true while reconnecting, client keeps `lobby.hostId`, host resumes `seamless:true` still as host. 39/39.

## Phase 2 (2026-09-05): downed / revive / consumables
- `Snapshotter`: `PlayerFlags.DOWNED` from `ctx.player.isDowned`; `HOLDING_ITEM` (from `quick:equipped`) replaces `HAS_WEAPON` and clears `w` while a stim / grenade is in hand;
  `TWO_HANDED` for both primary slots.
- `RemotePlayer.isDowned` (flag getter). On each snapshot the DOWNED transition emits `net:remoteDowned {id, name, position}` / `net:remoteRevived {id, name}`.
- `revive` messages addressed to us: `progress` → `player:reviveProgress {t, by, byName}`, `cancel` → `t = −1`, `done` → `ctx.player.revive()` (+ `t = −1`). Sent by `player/RemotePlayerSystem`'s revive interactable.
- `grenade` messages carry `fuse` → `net:remoteGrenade.fuse`.
