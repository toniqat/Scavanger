# src/net — Multiplayer client (`NetSystem`, publishes `ctx.net`)

Browser side of the multiplayer stack. Talks to the Node relay in `server/` over WebSocket, mirrors the lobby,
broadcasts the local `PlayerSnapshot` (in missions **and** in the shared ship hub), exposes interpolated
`RemotePlayerRef`s, and survives socket drops / page reloads by resuming into the same party. Host-authoritative
gameplay: `ctx.isAuthority` is `!inSession || isHost`; other systems gate enemy / extraction simulation on it.
Contract: `src/shared/net.ts` (types + constants) and the `net:*` events in `src/shared/events.ts`.

| File | Responsibility |
|---|---|
| `NetSystem.ts` | `GameSystem` (`name: 'net'`, registered first in `main.ts`) implementing `NetRef`. Session token, connection lifecycle + auto-reconnect state machine, lobby mirror (`lobby:state` diff → `net:peerJoined/peerLeft`), quick match, `game:start` / `rejoinMission()` → `net:gameStarting` + `game:newMission`, session end (`game:complete/over/abort` → host sends `lobby:reset`), snapshot broadcast at `NET_PLAYER_SNAPSHOT_HZ` (mission + hub), inbound relay dispatch (bus translation + `onMessage` subscribers), remote player registry. |
| `NetClient.ts` | Bare WebSocket transport: `connect(url)` resolves on `welcome`, JSON encode/decode with validation (type whitelist, 256 KB cap), `ping` every 2 s → `rttMs`, status changes (`offline/connecting/connected/error`), clean `close()`. No lobby, reconnect or gameplay knowledge. |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` from `ctx.player` into one reused object (floats rounded to 3 decimals). Caches active weapon id/slot from `weapon:equipped` / `loadout:changed` for `w`, `HAS_WEAPON`, `TWO_HANDED`. Sets `IN_HUB` while `ctx.isHubPhase()` (and hides the weapon there) and `IN_POD` from `ctx.player.isInPod`. |
| `RemotePlayer.ts` | `RemotePlayerRef` implementation. 16-entry ring buffer of `{arrival, snapshot}`; `tick(now)` renders at `now - NET_INTERP_DELAY`: lerp position/velocity/pitch, shortest-arc yaw/stride, extrapolate ≤ 0.25 s past the newest sample then hold, `stale` after `NET_STALE_AFTER`. Discrete fields (stance, flags, hp, weaponId, moveBlend) come from the newest sample. `resetStream()` forgets the `seq` guard + history when a peer's stream restarts (reload / rejoin with the same stable id); `push` also detects a restart itself (`seq` ≥ 200 below the last one, or any lower `seq` while stale). `position`/`velocity` are stable `Vector3` instances. |
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
| `rejoinMission()` | If `missionInProgress && lobby.seed != null`: `inSession=true`, `net:gameStarting {seed, lobby}` → `game:newMission {seed}`, then `flow rejoined` to `'all'`. The world is deterministic by seed; enemies arrive with the host's full `es` snapshots; extraction asks `exq sync`, pickups `itemq sync`. |
| `inHubSession` | `lobby !== null && !inSession && phase === 'hub'`: snapshots are exchanged in the shared ship. |
| `reconnecting`, `sessionToken` | See above. |

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
  - `dmg` → `ctx.player.takeDamage(amount, from)` (+ `player:applySlow` when `slow` present), only while `inSession`
  - **everything** (including the above) is also dispatched to `ctx.net.onMessage(type, handler)` subscribers —
    `hit/explode/hitc/es/ee/ex/exq/flow/crate/item/itemq` are delivered *only* that way.
- Lobby diffing: `lobby:state` emits `net:peerJoined/peerLeft` only when a previous state for the same lobby existed;
  a member flipping `connected` false → true resets that remote's snapshot stream. `peer:left` (grace expired) →
  lobby updated, RemotePlayer `connected=false`, removed 1 s later (`net:remotePlayerRemoved`).
- `game:start` (and `rejoinMission`) clear the hub remotes; mission avatars are re-created from the first snapshots.
- **Session end ordering.** NetSystem is registered before GameFlow/Extraction, so its `game:complete` / `game:over` /
  `game:abort` handlers do *not* flip `inSession` synchronously. The end is deferred with `queueMicrotask`: every
  synchronous handler of that same event (GameFlow's `flow abort`, Extraction's `ex reset`, …) still sees
  `inSession === true`, `isAuthority` unchanged and a working `send()`. Only after that microtask does NetSystem
  set `inSession = false`, dispose remotes and (as host) send `lobby:reset`. The lobby stays: the player returns to
  the shared ship; a client that aborted alone sees `missionInProgress` until the host resets.
- `lobby:left` → `lobby = null`, `inSession = false`, remotes disposed, `net:lobbyLeft {reason:'left'}`.
- Debug: `window.__game.getSystem('net')` or `window.__game.ctx.net`.

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
