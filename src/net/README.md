# src/net — Multiplayer client (`NetSystem`, publishes `ctx.net`)

Browser side of the multiplayer stack. Talks to the Node relay in `server/` over WebSocket, mirrors the lobby,
broadcasts the local `PlayerSnapshot` (in missions **and** in the shared ship hub), exposes interpolated
`RemotePlayerRef`s, and survives socket drops / page reloads by resuming into the same party. Host-authoritative
gameplay: `ctx.isAuthority` is `!inSession || isHost`; other systems gate enemy / extraction simulation on it.
Contract: `src/shared/net.ts` (types + constants) and the `net:*` events in `src/shared/events.ts`.

| File | Responsibility |
|---|---|
| `NetSystem.ts` | `GameSystem` (`name: 'net'`, registered first in `main.ts`) implementing `NetRef`. Session token, connection lifecycle + auto-reconnect state machine, lobby mirror (`lobby:state` diff → `net:peerJoined/peerLeft`; Phase 7: `net:missionMembership`, `net:peerSuspended`, `net:hostChanged`), quick match, `game:start` / `rejoinMission()` → `net:gameStarting` + `game:newMission` (training-aware), `leaveMission()`, session end (`game:complete/over/abort` → raid host sends `lobby:reset`, everyone else `lobby:mission false`), snapshot broadcast at `NET_PLAYER_SNAPSHOT_HZ` (mission + hub), inbound relay dispatch (bus translation + `onMessage` subscribers; `ghost` / `dmg.kb` / `flow takeover` applied here), remote player registry, `profile` / `raidBlob` / `saveRaid` / `missionMode` / `tookOver`; Phase 8: `serverNow()`; Phase 9: the cached `serverOffset`, `net:hostChanged` for any *started* lobby (not only in-session), the reload → `lobby:mission false` rule, and `lobby:error` forwarded to `ProfileSync.onError`. **Phase 10**: the `crewCards` map + `getCrewCard` / `requestCrewLoadout` (`crew` / `crewq` receive side, `sanitizeCrewCard`, the local card snooped in `send()`), the `carry` one-shots, and the per-frame `refreshCarriedBy()` derivation. **Phase 11**: the `SocialSync` instance (`social`), `lobbyPlanet` / `setLobbyPlanet`, `startGame(seed, mode?, planet?)`, the planet threaded through `game:start` / `beginSession` / `rejoinMission` (`ctx.missionPlanet` set **before** `game:newMission`), the five `social:*` server cases, and `pushLevel()` on `progress:loaded` / `progress:levelUp`. |
| `model.ts` | 폴더 공용 어휘 — `NetSystem` 에서 떼어낸 상수 · 타입 · 스크래치. 클래스를 참조하지 않으므로 `parts/*` 가 순환 import 없이 쓴다. `NetSystem.ts` 가 재수출하므로 기존 import 경로는 그대로다 |
| `parts/Socket.ts` | **연결 · 세션 토큰 · 자동 재접속**. 소켓이 끊기면 백오프로 다시 붙고, 같은 토큰이면 서버가 슬롯을 5분(레이드 중이면 레이드가 끝날 때까지) 지켜 준다 → `net:reconnecting` → `net:resumed {seamless}`. 릴레이 주소 결정도 여기다. |
| `parts/Lobby.ts` | **로비 · 세션 · 호스트 이관**. 방 만들기 / 참가 / 신호 찾기 / 준비 / 시작 / 나가기, 목표 행성 지정, 그리고 임무의 시작과 끝. 임무가 끝나도 **로비는 유지된다** — 로비를 떠나는 것은 `leaveLobby()`(도킹 해제) 하나뿐이다. |
| `parts/Remotes.ts` | **원격 플레이어 참조**. 들어온 스냅샷마다 `RemotePlayerRef` 를 만들고 지운다. 이름 · 레벨 · 크루 카드 · 들쳐메기 관계가 각각 다른 메시지로 오므로, 그것들을 하나의 ref 위에 합치는 것이 이 파일의 일이다. |
| `parts/Messages.ts` | **수신 메시지 분배**. 서버 프로토콜 메시지(`handleServerMessage`)와 다른 클라이언트가 보낸 불투명 게임 메시지 (`handleRelay`)를 각 시스템의 `onMessage` 구독자에게 넘긴다. 게임 규칙은 여기 없다 — 스냅샷 적용과 `net:*` 버스 이벤트 번역까지가 이 파일의 범위다. |
| `ProfileSync.ts` | `ProfileRef` implementation behind `ctx.net.profile` (Phase 7): mirrors the server `ProfileRecord` from `welcome.profile` / `profile:docs`, `get(key)`, `set(key, doc, {fresh?})` with a `PROFILE_SYNC_DEBOUNCE_MS` upload queue (`profile:set`), `flush()` (also on `pagehide`, on session end and right after every welcome), `addCredits(delta, reason)` → `credits:tx` matched by `txId` (10 s timeout; rejects only when offline). Emits `net:profileLoaded {profile, migrated}` (`migrated` = server credits still null → meta/ uploads its local balance with reason `'migrate'`). `available=false` + `credits=null` while the socket is down; pending transactions reject on a drop. **Phase 9 (newest wins)**: a `set` is **never dropped any more** — availability is irrelevant, every call lands in the `pending` map as `{doc, at}` where `at = serverNow()` (a `fresh` save carries `at: null`) and only the debounce timer is gated on the connection, so an offline queue simply waits for the next welcome. `flush()` sends `{key, doc, at}` or `{key, doc, fresh:true}` and mirrors the accepted stamp into `docsAt`. `applyRecord` (shared by `onWelcome` / `onDocs`, and where `migrated` is computed for both) mirrors the server record + its `docsAt`, then merges the queue over it: a stamped pending doc survives only while `at >= docsAt[key]` (ties: ours), a `fresh` one only while the server has nothing for that key — a loser is dropped and the server copy wins. `onError('too_large')` evicts the keys of the last flush so a doc the server refuses is never retried forever. `pendingKeys` exposes the queue for diagnostics / smokes. |
| `SocialSync.ts` | `SocialRef` implementation behind `ctx.net.social` (**Phase 11**): client mirror of the relay's social state — my `SocialCard`, 친구 / 받은 요청 / 보낸 요청 / 최근 만난 플레이어, 귓속말 and 분대 초대. Fed by NetSystem (`onWelcome(welcome.social)` / `onState` / `onInvited` / `onWhisper` / `onPlay` / `onError` / `onDisconnected`) with the same injected wiring as `ProfileSync` (`bus` / `send` / `serverNow`, plus `joinLobby` and `squadSize`). **The client never edits the lists**: `requestFriend` / `respondFriend` / `removeFriend` / `playWith` are requests and the server answers with a whole new snapshot (`social:updated {snapshot, first}`). `invites` holds at most `SQUAD_INVITE_MAX` live `SquadInvite`s, each with its own `SQUAD_INVITE_TTL_S` timer off the invite's own `at` (expiry / accept / dismiss / trim → `social:inviteClosed {reason}`; a second invite from the same 아이디 replaces the first); `acceptInvite` drops it and calls the ordinary `net.joinLobby(invite.lobby)`. `whisper(code, text)` trims to `SOCIAL_WHISPER_MAX`, refuses locally for empty text / a row known to be `offline` / a failed send, and emits the sender's own echo (`social:whisper {line.out:true}`); an inbound `social:whisper` becomes the same event with `out:false`. `setLevel` is debounced by `SOCIAL_ME_DEBOUNCE_MS` and a level reported while offline waits for the next snapshot. `playBlock(code)` is the shared `playBlockReason(row, squadSize(), NET_MAX_PLAYERS, isSelf)` (unknown 아이디 → `'offline'`). Everything is inert while `available` is false — `refresh()` excepted, since `social:get` is how a connection becomes available when a welcome carried no snapshot. Inbound frames are sanitized field by field (code validated with `isValidPlayerCode`, name capped, level / squad clamped, presence whitelisted, lists de-duplicated and capped, invite lobby code validated) and **only `PlayerCode`s ever cross the wire**. |
| `NetClient.ts` | Bare WebSocket transport: `connect(url)` resolves on `welcome`, JSON encode/decode with validation (type whitelist incl. `profile:docs` / `credits:result`, 2 MB inbound cap — a welcome may carry every profile document plus a raid blob), `ping` every 2 s → `rttMs`, status changes (`offline/connecting/connected/error`), clean `close()`. Phase 8: `serverTimeOffset` (`serverTime - performance.now()`) is captured at the **welcome** as well as at every pong, with `hasServerTime` telling whether the current connection ever supplied a clock (both reset by `teardown`). No lobby, reconnect or gameplay knowledge. |
| `Snapshotter.ts` | Builds the local `PlayerSnapshot` from `ctx.player` into one reused object (floats rounded to 3 decimals). Caches active weapon id/slot from `weapon:equipped` / `loadout:changed` for `w`, `HAS_WEAPON`, `TWO_HANDED`. Sets `IN_HUB` while `ctx.isHubPhase()` (and hides the weapon there) and `IN_POD` from `ctx.player.isInPod`. Phase 7: reads `ctx.weapons.remoteState` every snapshot (guarded when weapons is absent) → `h` (held consumable def id while `HOLDING_ITEM`), `att` (attachment ids of the active weapon, omitted when none / in the hub), flags `THROWING / COOKING / CHARGING / SPRAYING / HEAVY`; `ctx.player.isMeleeHeavy` → `MELEE_HEAVY`. Phase 9: `dhp` (`Math.round(player.downHp)`) rides along while the player is downed and is deleted otherwise, so a host ghost inherits the real bleed pool instead of a full one. **Phase 10**: `ctx.player.carrying` → `cr` + `PlayerFlags.CARRYING`, and a carrier is forced down the **no-gun** path (neither `HAS_WEAPON` nor `HOLDING_ITEM`, `w` nulled) because both hands hold the squadmate; `ctx.player.isCarried` → `PlayerFlags.CARRIED`; `ctx.implants.barrierHp` → `bhp` whenever the `BARRIER` flag is set (deleted otherwise). **2026-09-09**: `typing` (from `ui:chatToggled`) → `PlayerFlags.TYPING`. **2026-09-10**: `shm` / `sh` (방탄복 실드와 그 최대치) 는 `dhp` 와 같은 규약으로 **방탄복을 입었을 때만** 실리고, 아니면 지워진다 — 원격 체력 바 · 호스트 고스트 · 재접속 복귀가 전부 이 값을 읽는다. **2026-09-11**: `ctx.player.climbingLadder` 가 문자열이면(함선 밖) `PlayerFlags.CLIMBING` — 새 필드는 없고 `p` / `v.y` 가 수직 이동을 싣는다. |
| `RemotePlayer.ts` | `RemotePlayerRef` implementation. 16-entry ring buffer of `{arrival, snapshot}`; `tick(now)` renders at `now - NET_INTERP_DELAY`: lerp position/velocity/pitch, shortest-arc yaw/stride, extrapolate ≤ 0.25 s past the newest sample then hold, `stale` after `NET_STALE_AFTER`. Discrete fields (stance, flags, hp, weaponId, moveBlend, `heldItemId`, `attachments` — same array while unchanged) come from the newest sample. `resetStream()` forgets the `seq` guard + history when a peer's stream restarts (reload / rejoin with the same stable id); `push` also detects a restart itself (`seq` ≥ 200 below the last one, or any lower `seq` while stale). Phase 7: `suspended` / `inMission` mirrors, `applyGhost(GhostWire)` (position / yaw / hp / DOWNED / DEAD from the host's ghost, `ghosted=true` → `tick` leaves the pose alone, `ghostDownHp`), `clearGhost()` (ghost gone; the next live `push` also clears it). `position`/`velocity` are stable `Vector3` instances. Phase 9: `applyGhost` also stores `ghostState` (`GhostWire.st`: 0 alive / 1 downed / 2 dead) and `clearGhost` resets both it and `ghostDownHp` to `undefined` — game/ reads `ref.ghostState` for the wipe check instead of keeping its own map; `push` fills `downHp` from `PlayerSnapshot.dhp` while the DOWNED flag is set (undefined otherwise), which is what the host's `createGhost` inherits. **Phase 10**: `carrying` (from `cr` while CARRYING; also written optimistically by a `carry pick/drop` one-shot), the `isCarried` / `isBarrierUp` flag getters, `barrierHp` (from `bhp` while BARRIER), the NetSystem-written `carriedBy`, and the crew-card mirrors `crewLevel` / `equippedImplant`. `applyGhost` clears `carrying` / `barrierHp` and masks CARRYING / CARRIED / BARRIER out of `flags` — a ghost owns its pose, carries nobody and holds no shield. **2026-09-10**: `shield` / `maxShield` 를 `PlayerSnapshot.sh` / `.shm` 에서 받는다 (방탄복이 없으면 둘 다 `undefined`); `applyGhost` 는 둘을 지운다. **2026-09-11**: `applyGhost` 가 `CLIMBING` 도 가린다 (끊긴 고스트가 사다리 자세로 굳지 않게). |
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
| `startGame(seed, mode?, planet?)` | `'raid'` (default): host only, everyone ready. `'training'`: any member, no ready gating; the server marks only the caller `inMission`. **Phase 11**: `planet` is the raid's 목표 행성 — omitted it falls back to `lobby.planet`, an unknown id is dropped here, and a training never sends one (the server refuses a planet-less raid with `no_planet`). |
| `lobbyPlanet` | **Phase 11.** `lobby.planet` (the host's 목표 행성) or null outside a lobby / while nothing is picked. hub/ reads it as its own `planet` whenever a lobby exists. |
| `setLobbyPlanet(planet)` | **Phase 11.** Host only, lobby not started, `isPlanetId` checked: mirrors `lobby.planet` optimistically (like `setLobbySeed`) and sends `lobby:planet`. Emits **no** event — hub/ drives its own terminal / cutscene from `HubRef.setPlanet` and learns about a *squadmate's* change from the server's `net:lobbyUpdated`. |
| `social` | **Phase 11.** `SocialRef` (see `SocialSync.ts`). Always present; `available` is false offline / for an anonymous socket / on a relay without a store, and then every method is inert. |
| `transferHost(targetId, claim?)` | **2026-09-09 — 분대장 지명 이관.** `lobby:transferHost` 를 보낸다. 서버가 받아 주는 경우는 ① 내가 지금 호스트, ② `claim` 이고 현재 호스트가 `reportHostDown(true)` 로 사망 표시를 켰다 — 그 외에는 `lobby:error not_host` (→ `net:error`). **로비가 없거나 소켓이 끊겼을 때만 no-op** 이다: 함선(세션 밖)에서도 넘길 수 있어야 하므로 `inSession` 은 보지 않는다. 결과는 평소의 `lobby:state` → `net:hostChanged` 로만 온다 — 이 메서드는 아무 이벤트도 내지 않는다. |
| `reportHostDown(down)` | **2026-09-09.** 호스트 본인이 이 레이드에서 완전히 사망했다고(또는 되살아났다고) 서버에 알린다. 남의 `transferHost(..., true)` 가 통하는 유일한 조건이고, 서버는 이 표시를 **방송하지 않는다**. |
| `leaveMission()` | Leave the running mission but keep the lobby: `inSession=false`, remotes cleared, `lobby:mission false` (the server closes a training when its last member leaves), `net:lobbyUpdated`. game/ calls it on a training exit; a client's own abort goes through `game:abort` and ends the same way. |
| `missionMode` | `lobby.mode ?? 'raid'` while the lobby is started, else null. |
| `profile` | `ProfileRef` (see `ProfileSync.ts`). |
| `raidBlob` / `saveRaid(blob)` | `welcome.raid` (also announced as `net:raidLoaded`) kept until the session ends; `saveRaid` sends `raid:save` only inside a raid session with the session's seed (size-guarded by `RAID_BLOB_MAX_BYTES`). |
| `tookOver` | true once we were promoted to host during a session (reset at every session start / end). |
| `serverNow()` | **Phase 8.** Relay wall clock in epoch ms: `performance.now() + NetClient.serverTimeOffset` (offset from `welcome.serverTime` / every `pong`). `performance.now()` is monotonic, so moving the system clock cannot advance a real-time timer — housing/ stamps `GrowPlot.plantedAt` / `readyAt` with it so 온실 crops agree across devices. **Phase 9**: `NetSystem` caches the offset in `serverOffset` at every welcome / pong and **keeps it through a disconnect**, so profile stamps written offline stay on the server's clock; only a session that never saw a welcome falls back to `Date.now()`. |
| `getCrewCard(id)` | **Phase 10.** Last `crew card` for `id`, **including the local player** — hub/ owns *sending* the card and `send()` snoops our own broadcast into the same map, so the READY panel reads every cell through one accessor (it also works offline / single-player, where the relay drops the message). `null` when none arrived. |
| `requestCrewLoadout(id)` | **Phase 10.** Sends `{t:'crewq', ev:'loadout'}` addressed to that peer; the answer arrives as `net:crewLoadout {id, card, loadout}`. No-op for our own id. A peer may rate-limit the answer (`CREW_LOADOUT_COOLDOWN_S`), so callers must tolerate silence. |

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
  - `ghost state` / `ghost sync` → the member's ref (created if missing) gets `applyGhost` → `net:ghostState {id, hp, downHp, state}`; `ghost restore` addressed to us → `net:ghostRestore {state}` (`PlayerRestoreState` with a `Vector3`, 2026-09-10 부터 `shield` = `GhostWire.sh` 포함 — 없으면 `undefined` 이고 player/ 가 최대치로 읽는다); `ghost gone` → `clearGhost()`
  - `flow takeover` (from the new host) → `net:hostChanged {hostId: from, prev, isLocalHost:false}` so every system re-requests its sync
  - `crew card` / `crew loadout` (Phase 10) → sanitized into `crewCards`, mirrored onto the ref, `net:crewCard` (+ `net:crewLoadout` for the loadout answer); `crewq` is subscriber-only (hub/ answers it)
  - `carry pick` / `carry drop` (Phase 10) → the carrier ref's `carrying` optimistically, `net:remoteCarryChanged`
  - `social:state` / `social:invited` / `social:whisper` / `social:play` / `social:error` (Phase 11) are **server**
    frames, not relayed game messages: they pass the `NetClient` whitelist and go straight to `SocialSync`
    (`social:updated` / `invited` / `whisper` / `play` / `error` on the bus). `welcome.social` is the first snapshot.
  - a `lobby.planet` change arrives as an ordinary `lobby:state` → `net:lobbyUpdated` only; **there is no travel
    message** and net emits nothing extra — hub/ compares the planet against its own copy and plays the cutscene.
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

## Phase 11 (2026-09-07): 소셜 미러 · 목표 행성 와이어
- **`ctx.net.social` = `SocialSync`** (new file, modelled on `ProfileSync`): the relay owns every social fact, this
  mirrors it and turns it into bus events. Nothing is cached client-side, nothing survives a disconnect
  (`onDisconnected` empties the lists, drops the invites and emits one final `social:updated`) and every method is a
  no-op while `available` is false, so **single-player / an offline ship behaves exactly as before**. Only
  `PlayerCode`s cross the wire — a PeerId of another player never reaches the client, and the API has no way to ask
  for one. Every inbound frame is sanitized (see the file table) before the UI can see it; a malformed
  `social:state` is dropped with a warning rather than half-applied.
- **My level** goes up as `social:me`: NetSystem listens to `progress:loaded` / `progress:levelUp` and calls
  `social.setLevel(ctx.progression?.level)` (optional-ref style — no progression system, no push), which debounces by
  `SOCIAL_ME_DEBOUNCE_MS`; a level set while the socket was down is flushed at the next snapshot, and every welcome
  re-publishes it because a fresh profile has `level: 0`.
- **목표 행성 wire.** `lobbyPlanet` reads `lobby.planet`; `setLobbyPlanet` is host-only / not-started / `isPlanetId`
  checked and mirrors optimistically. `startGame(seed, mode?, planet?)` carries it (falling back to `lobby.planet`,
  never for a training). Inbound `game:start` takes `msg.planet ?? msg.lobby.planet ?? null`, so an older relay that
  does not echo the field still starts on the squad's planet, and `rejoinMission()` reads `lobby.planet`.
  `beginSession` sets **`ctx.missionPlanet` before it emits `game:newMission`** — the same contract `ctx.missionMode`
  already follows, because world/ generates synchronously inside the emit — and puts the planet on both
  `net:gameStarting` and `game:newMission` (a training sets `null` and omits the field).
- **Not done here (other lanes)**: the full-screen terminal, the planet hologram, `HubRef.planet / setPlanet /
  travelling` and the travel cutscene (hub/); the ESC social column, the community icon, the invite panels with the
  `Keys.INVITE` hold and the whisper chat mode (ui/); the social store, presence fan-out, `lobby:planet` and the
  `social:*` handlers (server/); planet → biome / herbs (world/), planet → sky / fog (core/), the ecosystem (enemies/).
- **Coverage.** `scripts/e2e-multiplayer.mjs` (this lane owns it) grew two groups: **social** in the shared ship
  (`available` + a valid 8-char 아이디 on both clients, `social:updated {first:true}` from the welcome, `playBlock`
  self, an empty whisper refused locally, 최근 만난 플레이어 holding the squadmate, friend request → `incoming` /
  `hasNews` / `outgoing` → accept → mutual friend rows with `presence:'ship'` + `squad:2` + `onlineFriends`, the row
  leaving 최근, `find`, a whisper delivered with the sender's name plus the sender's own `out:true` echo, and a
  mutual `removeFriend` that also leaves the profile store clean for the next run) and **목표 행성** (host
  `setLobbyPlanet` mirroring optimistically, the guest mirroring it through `lobby:state`, a guest's own
  `setLobbyPlanet` and `ctx.hub.setPlanet` refused, an unknown id dropped before it is sent, `ctx.hub.planet`
  following the squad, then `net:gameStarting.planet` / `game:newMission.planet` / `ctx.missionPlanet` on both
  clients at the raid start and `ctx.missionPlanet === null` for a training). Both groups **skip themselves** with a
  logged note when the relay has no social store / does not handle `lobby:planet` yet, so the script stays usable
  while the server lane is mid-flight.
- **Verified (2026-09-07)**: `npm run typecheck` clean, `npm run typecheck:server` clean, `npm run net:selftest`
  **276/276** (194 before the server lane's Phase 11 part 8), `node scripts/e2e-multiplayer.mjs` against a
  fresh relay on 8787 + a snapshot of the tree on its own vite port: **156/156** (124 before this phase), no console
  errors on either client. Because parallel lanes were still saving files, the run was driven against a **copy** of
  the tree on a private vite port — a full reload from another lane's save kills the script mid-run.

## Phase 10 (2026-09-07): crew cards · 들쳐메기 스냅샷 · 배리어 방패 필드
- **Crew cards (receive side).** `hub/` sends `crew card` (debounced `CREW_CARD_MIN_INTERVAL_S`) and answers
  `crewq loadout` with `crew loadout`; **net only receives, stores and surfaces**. Every inbound `crew` runs through
  `sanitizeCrewCard` (level clamped to 1..9999, `implant` checked against `IMPLANT_IDS`, def ids length-capped — a
  malformed card is *clamped*, never dropped, so a buggy peer still fills its cell), lands in `crewCards`, mirrors
  `crewLevel` / `equippedImplant` onto the member's ref (also applied in `getOrCreateRemote` for a card that arrived
  before the ref existed) and emits `net:crewCard`. `crew loadout` additionally emits `net:crewLoadout` with the
  **opaque** `loadout` document — inventory/ validates it before rendering. `crewq` gets **no case**: it flows
  straight to `onMessage('crewq')` so hub/ can answer both `sync` and `loadout`. The relay treats `crew` / `crewq`
  as opaque payloads, so **no server change was needed**.
  Cards are pruned in `syncRemoteIdentities` when a member leaves (ours is kept) and the whole map is cleared by
  `dropLobby` — hub/ re-sends ours on the next `hub:entered`. `equippedImplant` is the **ship** choice and stays
  valid in the hub, unlike `implantId`, which is the wielded one and is nulled there by `Snapshotter`.
- **Carry plumbing.** Steady state is on the snapshot: `Snapshotter` sets `PlayerFlags.CARRYING` + `cr` from
  `ctx.player.carrying` and forces the **no-gun** path (a carrier is unarmed: no `HAS_WEAPON`, no `HOLDING_ITEM`,
  `w` nulled), and `PlayerFlags.CARRIED` from `ctx.player.isCarried`. `RemotePlayer` mirrors `cr` → `carrying` and
  the CARRIED bit → `isCarried`. `carriedBy` is **derived**, never sent: `refreshCarriedBy()` runs once per frame
  in `update` while anybody carries (≤ 4 refs, plus one trailing pass that clears the field when the last carry
  ends) and scans every ref's `carrying` **and** the local `ctx.player.carrying`, so the carried side knows whose
  shoulder it rides. A **suspended** carrier is skipped and a suspended ref's `carriedBy` is forced to null (the
  host owns that body as a ghost); the suspension transition in `syncRemoteIdentities` also clears the carrier's own
  `carrying` and emits `net:remoteCarryChanged {carrying:null}`.
  The `carry pick` / `carry drop` one-shots are relayed, validated (`drop` only for the body the ref actually
  holds) and applied optimistically for instant feedback ahead of the next 20 Hz snapshot; they also reach
  `onMessage('carry')` like every other message. Every `carrying` change emits `net:remoteCarryChanged {id, carrying}`
  (`id` = the carrier).
- **Barrier shield fields.** `Snapshotter` sends `bhp` (`ctx.implants.barrierHp`, rounded) only while the `BARRIER`
  flag is set — the shield's transform rides on the sender's own `p` / `yaw`, so implants/ needs no `imp shield` for
  a late joiner. `RemotePlayer` exposes `isBarrierUp` (flag getter) and `barrierHp`.
- **Not done here (other lanes)**: the local `carry()` / `dropCarried()` / shoulder socket (player/), the READY panel
  and card *sending* (hub/), `captureCrewLoadout` / `createCrewLoadoutView` (inventory/), the shield itself
  (implants/). `DebugRemoteRef` in `player/RemotePlayerSystem.ts` does **not** declare the new fields; it does not
  have to, because every Phase 10 member of `RemotePlayerRef` is optional.
- **Coverage.** `scripts/e2e-multiplayer.mjs` grew two groups (this lane owns that script): a **crew-card round trip**
  in the shared ship (local snoop → `getCrewCard(localId)`, the card reaching B with `getCrewCard(A)` + ref mirrors,
  a malformed card clamped, `requestCrewLoadout` landing in A's `onMessage('crewq')`, and the `crew loadout` answer
  arriving as `net:crewLoadout` with the document verbatim) and a **carry check** in the mission (both `carry`
  one-shots, then `ctx.player.carrying` / `isCarried` forced on the two clients to assert `CARRYING` + `cr`, the
  unarmed wire state, `CARRIED`, the derived `carriedBy`, and that everything reverts when the carry ends).
  `npm run typecheck` is clean for `src/net` + `src/pickups` and `npm run net:selftest` stays green (**276/276** since the Phase 11 server lane; it was 194 when this line was written).

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


## 파일 분할 규약 (`model.ts` + `parts/`, 2026-09-08)

`NetSystem.ts` 는 한 파일에 다 있기에는 너무 커져서 **동작을 바꾸지 않고** 갈랐다. 규칙은 세 줄이다.

1. **`model.ts`** — 폴더 공용 어휘(타입 · 상수 · 스크래치 객체, 상태 없는 보조 클래스).
   `NetSystem.ts` 이 `export * from './model'` 로 재수출하므로 **기존 import 경로는 전부 그대로 동작한다.**
2. **`parts/*.ts`** — 클래스에서 떼어낸 메서드 묶음. 각 함수는 인스턴스를 첫 인자 `sys` 로 받는다:
   ```ts
   export function foo(sys: NetSystem, …) { … }   // 예전의 this → sys
   ```
   클래스에는 같은 이름의 **한 줄 위임 메서드**가 남아 있으므로 호출부는 하나도 바뀌지 않았다.
3. `parts/` 가 닿는 클래스 멤버는 `private` 이 벗겨져 있다. **폴더 밖에서 쓰라는 뜻이 아니다** —
   외부와의 계약은 `@/shared` 의 `*Ref` 인터페이스가 전부다.

새 `parts/` 파일은 맨 위 doc 주석에 **그 파일이 답하는 질문 한 줄**을 적고 위 표에 행을 추가한다.
순환 import 를 만들지 않으려면 `parts/` 는 `NetSystem.ts` 에서 **타입만** 가져와야 한다 — 값은 `model.ts` 로.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **tactical kit** — `PlayerSnapshot.imp` / `ar` (wielded implant, armor), flags CLOAKED / BARRIER / MELEE / HOVER / OVERCHARGED, `RemotePlayerRef.implantId` / `armorId` / `isCloaked`, relays `imp` / `buff` / `melee` / `gad` / `gadq` / `harv` / `harvq`

- **Phase 7** — `ProfileSync.ts` (`ctx.net.profile`: welcome record → `net:profileLoaded {migrated}`, debounced `set` / `flush`, `addCredits` transactions by `txId`), `raidBlob` / `saveRaid`, `startGame(seed, mode)` / `leaveMission` / training `game:start` (only `inMission` members enter), `suspended` + `inMission` on refs (`net:peerSuspended` / `net:missionMembership`), ghost messages applied to the ref (`applyGhost`), `net:hostChanged` + `tookOver` + `flow takeover`, `Snapshotter` pose bits / `h` / `att` / MELEE_HEAVY, `dmg.kb` → knockback

- **Phase 8** — `serverNow()` (relay wall clock in epoch ms, `Date.now()` offline) for real-time 온실 재배

- **Phase 9** — `ProfileSync` **never drops a `set`** (offline documents wait in a stamped pending map and are merged newest-wins against the server's `docsAt` at `welcome`; `fresh` marks a default save that must not beat a real profile), `serverNow()` keeps its offset across a drop, `Snapshotter` sends `dhp`, the ref carries `ghostState / ghostDownHp / downHp`, `net:hostChanged` fires for a started lobby even outside a session, and a page reload mid-raid reports `lobby:mission {inMission:false}`

- **Phase 10** — **crew cards** (`crew` / `crewq` received, clamped and stored per peer, `net:crewCard` / `net:crewLoadout`, `getCrewCard` / `requestCrewLoadout`, `crewLevel` / `equippedImplant` mirrored onto the ref — needed because `PlayerSnapshot.imp` and `.w` are **nulled in the hub** and `LobbyPlayer` carries no level), **carry plumbing** (`Snapshotter` sets `CARRYING` + `cr` and forces the unarmed path, `CARRIED` on the carried side, `carriedBy` derived per frame from every ref's `cr` including the local player, `net:remoteCarryChanged`, the `carry` one-shots applied optimistically, a suspended carrier's `carrying` cleared), and the shield's `bhp` → `isBarrierUp` / `barrierHp`

- **Phase 11** — `SocialSync.ts` (`ctx.net.social` — 스냅샷 미러, 초대 TTL / `SQUAD_INVITE_MAX`, 귓속말 in/out, `setLevel` debounce, `playBlock`; 인바운드는 필드 단위 정화, **아이디만** 노출), `lobbyPlanet` / `setLobbyPlanet` / `startGame(seed, mode?, planet?)`, `game:start` · `beginSession` · `rejoinMission` 에서 `ctx.missionPlanet` 을 `game:newMission` **emit 전에** 세팅

- **2026-09-08 (공용 함선 격납고)** — `ship state` / `shipq state`. 격납고의 정박 구역은 그 대원의 **개인 함선을
  실제로 그려야** 하는데 어떤 메시지도 배치 정보를 나르지 않았다. `ShipVisitWire`(방 용도 · 시설 레벨 · 배치
  가구 · 꽂힌 책 — 창고 · 프리셋 · 도감처럼 그릴 필요 없는 것은 **보내지 않는다**)가 그 짐을 지고, 처리 경로는
  크루 카드와 **한 글자도 다르지 않다**: `sanitizeShipVisit` 로 필드 단위 정화(방 하나가 깨지면 `'empty'`,
  가구 하나가 깨지면 그것만 버린다 — 문서째로 거절하지 않는다) → `shipVisits` 맵 → `net:shipVisit {id}`,
  `getShipVisit(id)` / `requestShipVisit(id)`, 보내는 쪽은 `hub/parts/Hangar` 소유. `send()` 가 자기 방송을
  스누핑하므로 **내 정박 구역도 남들이 보는 것과 똑같은 와이어로** 그려진다. 로비를 떠나면 `crewCards` 와 함께
  비우고, 사라진 멤버의 것은 `lobby:state` 스윕에서 지운다.

- **2026-09-09 (분대장 지명 이관)** — `NetRef.transferHost(targetId, claim?)` · `reportHostDown(down)`
  (`parts/Lobby`). UI 는 net 을 직접 붙잡지 않는다: 커뮤니티 창의 우클릭도, 공용 함선 안의 상호작용도
  **`leader:transferRequested {peerId}`** 하나를 내고 `NetSystem.init` 이 그것을 구독해 `transferHost(peerId)` 를
  부른다 — 입구가 하나뿐이라 두 UI 가 규칙을 따로 들고 있을 수 없다. 이관이 확정되는 경로는 자동 이관과
  **완전히 같다** (`lobby:state` → `applyLobby` → `onHostChanged` → `net:hostChanged`), 그래서 net 쪽에 승격/강등
  코드는 한 줄도 더해지지 않았다. `net:hostChanged` 를 듣고 토스트를 띄우는 것은 `game/parts/Leader` 의 몫이다.

- **2026-09-08 (같은 함선끼리만 보인다)** — `PlayerSnapshot.hs` (append-only, 없으면 공유 데크). 모든 인테리어가
  원점에 지어지므로 서로 다른 함선 안의 두 사람은 좌표가 겹친다. `Snapshotter` 가 `ctx.hub.hubSite` 를 실어
  보내고 `RemotePlayer.push` 가 `RemotePlayerRef.hubSite` 로 받는다. 숨기는 판단은 `player/RemoteAvatar` 가 한다.

- **2026-09-08 (격납고 리뷰 수정)** — `sanitizeShipVisit` 의 셀 클램프를 0…63 에서 **방 격자**(`ROOM_GRID_COLS/ROWS − 1`)
  로 조였다. `hub/interiors/Furniture` 가 이 값을 `roomCellToWorld` 에 그대로 넣고 그 함수는 외삽하므로, 63 은 메시와
  **단단한 콜라이더 blocker** 를 방 밖 ~31 m 지점 — 방문자 함선 어디에나, 방문의 유일한 출구인 에어락 위에도 —
  놓을 수 있었다. 가구 개수 상한은 `SHIP_VISIT_MAX_FURNITURE` 로 `shared/constants.ts` 에 올려 보내는 쪽과 공유한다.

- **2026-09-10 (서버 주소)** — `parts/Socket` 의 `defaultUrl()` 이 이제 **설정에 적어 둔 주소를 먼저** 본다
  (`relayOverride()` → localStorage `scav.relay`, **슬롯 접두사 없는 공용 키**). 없으면 예전 그대로
  `VITE_WS_URL` → 같은 오리진 `/ws` 다. 함께 붙은 것: `setRelayOverride(raw)` (형식이 아니면 저장하지 않고
  false, `net:relayChanged` 발행), `probeRelay(raw?)` — **토큰 없이** 익명 소켓 하나를 열어 `welcome` 까지의
  시간을 재고 닫는다 (토큰을 붙이면 서버가 중복 세션으로 보고 **살아 있는 내 소켓을 끊는다**; 그래서
  `NetClient` 도 쓰지 않는다 — 이 소켓은 상태 기계에 들어가지 않는다), `reconnectRelay()` (끊고 다시 붙는다;
  로비에 있었으면 떠난다). 주소 정규화는 `shared/net.relayUrlFrom` 하나가 하고 UI · 데스크톱 셸 · 서버 배너가
  같은 함수를 쓴다. 와이어 · 스냅샷 · 프로필 규약은 **하나도 바뀌지 않았다** — 어디로 붙는지만 바뀐다.

- **2026-09-09 (채팅 입력 중 말풍선)** — `PlayerFlags.TYPING` (append-only). `NetSystem` 이 `ui:chatToggled {open}` 을
  듣고 `Snapshotter.typing` 을 켜고 끄며, 스냅샷 플래그에 실린다 — 함선 안에서도 유효하다. 그리는 쪽은
  `ui/hud/TypingBubbles` (원격 아바타에만; 내 머리 위에는 안 뜬다). `RemotePlayer.applyGhost` 는 다른 자세 비트와
  함께 이 비트도 지운다 — 연결이 끊긴 고스트가 계속 타이핑하는 것처럼 보이지 않게.

- **2026-09-11 (사다리)** — `PlayerFlags.CLIMBING` (append-only, `shared/net.ts` 는 world 담당이 추가). `Snapshotter` 가
  `ctx.player.climbingLadder` 가 문자열이면(함선 밖에서만) 비트를 싣는다. 새 필드는 없다 — 매달린 동안 `p` 가
  수직으로 움직이고 `v.y` 가 오르내리는 속도라 보간이 그대로 먹으며, `AIRBORNE` 도 함께 실린다(접지가 아니다).
  그리는 쪽은 `player/RemoteAvatar` (높이 변화 → 오르기 위상, 가까운 사다리 → 방향, `AIRBORNE` 가림).
  `RemotePlayer.applyGhost` 는 다른 자세 비트와 함께 `CLIMBING` 도 지운다 — 끊긴 고스트가 허공에서 사다리를 타지 않게.

