# src/net — Multiplayer client (`NetSystem`, publishes `ctx.net`)

Browser side of the multiplayer stack. Talks to the Node relay in `server/` over WebSocket, mirrors the lobby,
broadcasts the local `PlayerSnapshot`, and exposes interpolated `RemotePlayerRef`s. Host-authoritative gameplay:
`ctx.isAuthority` is `!inSession || isHost`; other systems gate enemy / extraction simulation on it.
Contract: `src/shared/net.ts` (types + constants) and the `net:*` events in `src/shared/events.ts`.

| File | Responsibility |
|---|---|
| `NetSystem.ts` | `GameSystem` (`name: 'net'`, registered first in `main.ts`) implementing `NetRef`. Connection lifecycle, lobby mirror (`lobby:state` diff → `net:peerJoined/peerLeft`), `game:start` → `net:gameStarting` + `game:newMission`, session end (`game:complete/over/abort` → host sends `lobby:reset`), snapshot broadcast at `NET_PLAYER_SNAPSHOT_HZ`, inbound relay dispatch (bus translation + `onMessage` subscribers), remote player registry. |
| `NetClient.ts` | Bare WebSocket transport: `connect(url)` resolves on `welcome`, JSON encode/decode with validation (type whitelist, 256 KB cap), `ping` every 2 s → `rttMs`, status changes (`offline/connecting/connected/error`), clean `close()`. No lobby or gameplay knowledge. |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` from `ctx.player` into one reused object (floats rounded to 3 decimals). Caches active weapon id/slot from `weapon:equipped` / `loadout:changed` for `w`, `HAS_WEAPON`, `TWO_HANDED`. |
| `RemotePlayer.ts` | `RemotePlayerRef` implementation. 16-entry ring buffer of `{arrival, snapshot}`; `tick(now)` renders at `now - NET_INTERP_DELAY`: lerp position/velocity/pitch, shortest-arc yaw/stride, extrapolate ≤ 0.25 s past the newest sample then hold, `stale` after `NET_STALE_AFTER`. Discrete fields (stance, flags, hp, weaponId, moveBlend) come from the newest sample. `position`/`velocity` are stable `Vector3` instances. |
| `index.ts` | Barrel. |

## Behaviour notes
- **Never auto-connects.** Single-player works with no server; the lobby UI calls `ctx.net.connect()`.
  URL = `VITE_WS_URL` if set, else same-origin `ws(s)://host/ws` (Vite proxies `/ws` → `ws://localhost:8787`).
- Player name persists in `localStorage['scav.playerName']`; default via `sanitizePlayerName('')` (`스캐빈저`).
- `inviteCode` is parsed from `?lobby=CODE` at init; `getInviteUrl()` builds the shareable link for the current lobby.
- `send()` is a no-op unless connected **and** in a lobby (default target `'others'`).
- Snapshots are sent while `inSession && ctx.player && (isGameplayPhase() || phase === 'deploying')`.
- Relayed message routing:
  - `ps` → RemotePlayer (created on first snapshot → `net:remotePlayerAdded`; out-of-order `seq` dropped)
  - `fire/reload/grenade/died/ping/chat` → `net:remoteFired/remoteReloaded/remoteGrenade/remoteDied/remotePing/chat`
  - `dmg` → `ctx.player.takeDamage(amount, from)` (+ `player:applySlow` when `slow` present)
  - **everything** (including the above) is also dispatched to `ctx.net.onMessage(type, handler)` subscribers —
    `hit/explode/hitc/es/ee/ex/exq/flow/crate` are delivered *only* that way (enemies/extraction/game/world own them).
- `peer:left` → lobby updated, RemotePlayer `connected=false`, removed 1 s later (`net:remotePlayerRemoved`).
- `lobby:state` diffing emits peer events only when a previous state for the same lobby existed (joining a lobby
  does not fire `net:peerJoined` for every existing member; `net:lobbyUpdated` carries the full list).
- **Session end ordering.** NetSystem is registered before GameFlow/Extraction, so its `game:complete` / `game:over` /
  `game:abort` handlers do *not* flip `inSession` synchronously. The end is deferred with `queueMicrotask`: every
  synchronous handler of that same event (GameFlow's `flow abort`, Extraction's `ex reset`, …) still sees
  `inSession === true`, `isAuthority` unchanged and a working `send()`. Only after that microtask does NetSystem
  set `inSession = false`, dispose remotes and (as host) send `lobby:reset`. The lobby object itself stays so the
  menu shows the lobby again. Inbound relayed messages (`flow`, `ex`, …) are always dispatched to `onMessage`
  subscribers regardless of `inSession`; `send()` only requires a connection and a lobby.
- Disconnect / `lobby:left` → `lobby = null`, `inSession = false`, remotes disposed, `net:lobbyLeft {reason}`.
- Debug: `window.__game.getSystem('net')` or `window.__game.ctx.net`.
