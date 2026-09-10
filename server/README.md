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
| `tool.ts` | **배포용 엔트리** (2026-09-10). `scripts/build-server.mjs` 가 이 파일을 번들해 `SCAVANGER-Server.exe` 로 굽는다 — 받는 사람은 저장소도 Node 도 없다. `index.ts` 와 **같은 릴레이**를 다른 껍데기로 감싼다: `--port` / `--host` / `--data` (+ `PORT` · `HOST` · `SCAV_DATA_DIR`), 친구에게 그대로 불러 줄 주소 배너(`shared/net.lanAddresses` 순위), 저장소는 exe 옆이 아니라 **`%LOCALAPPDATA%\SCAVANGER\server`**(배포 폴더에는 사람이 고치는 `server.txt` 만 둔다), 접속 · 로비 수가 **변할 때만** 한 줄, `EADDRINUSE` 에는 대안 포트를 알려 주고 **창을 닫지 않는다**(더블클릭한 콘솔에서 에러를 읽을 수 있게). SEA 번들이 CJS 라 **top-level await 이 없다** — 부팅 전체가 `main()` 안이다. |
| `RelayServer.ts` | `startRelayServer(opts)` → HTTP server (`GET /health` → `{ok, lobbies, clients, pendingReconnects, profiles, uptime}`) + `ws` `WebSocketServer` on `/ws` (`NET_WS_PATH`). Session tokens → stable `PeerId` (`peerIdFromToken`, `isValidSessionToken`), duplicate-session replacement, per-connection `welcome {id, lobby?, resumed?, profile?, raid?}`, inbound validation (JSON, type/field checks, 64 KB cap — only `profile:set` / `raid:save` may reach `MAX_DOC_FRAME_BYTES`), message handlers, reconnect grace timers, **host-migration timers** (Phase 7), broadcast helpers, 15 s ping heartbeat (dead sockets terminated), one log line per lobby / credits event. **Phase 9**: `profile:set` also parses the optional `at` (finite number) / `fresh` (boolean) — a malformed one is `invalid`, a `'stale'` store result is dropped silently; `autoResetMission(lobby)` closes **any** started lobby whose last `inMission` member left (raids now as well as trainings) and re-runs the hub migration afterwards; `migrateHostAway(lobby, id)` moves the authority off a *connected* host that reported `lobby:mission false`; the parked-host retries live in the `lobby:mission true` handler and in the resume path. **Phase 11**: `parseClientMessage` validates `lobby:planet` / `lobby:start.planet` (an unknown `PlanetId` → `invalid`) and the seven `social:*` frames (`sanitizeWhisper`, `MAX_WHISPER_INPUT`); the raid start refuses `no_planet`; **presence** (`presenceOf` → `PresenceState` + squad size) is folded out of `clients` / `lobbies` / `inMission` / `lobby.mode` and resolved into a `SocialSnapshot` (`buildSnapshot` / `resolveRow`, codes only — a `PeerId` never leaves the server); the missing out-of-lobby push channel is the `watchers` / `watching` index (`rewatch` on connect + after any friend change, `pushPresence` / `pushLobbyPresence` on connect / disconnect / lobby join / leave / `lobby:mission` / start / reset / `lobby:planet`, `notifyWatchers` on `social:me`), cleared in `close()`. Options: `port, host, quiet, heartbeatMs, reconnectGraceMs, hostMigrateDelayMs, dataDir, profileSaveDebounceMs`. Returns `{port, http, wss, lobbies, store, clientCount(), close()}`. |
| `Store.ts` | **Profile store** (Phase 7): `ProfileStore` maps `PeerId` → `ProfileRecord {credits, docs, updatedAt, docsAt?}` (`src/shared/profile.ts`). `get(id)` creates an empty `{credits: null, docs: {}}` on demand (never persisted until written), `snapshot(id)` for the wire (copies `docsAt`), `setDoc(id, key, doc, at?, fresh?)` → `SetDocResult` (`invalid` for a bad key, `too_large` over `PROFILE_DOC_MAX_BYTES`, **`'stale'`** = ignored, not an error), `applyCredits(id, delta, reason)` → `CreditsTxResult` (atomic; a result below 0 is refused with `크레딧 부족`; the `'migrate'` reason seeds a still-null balance with `delta` exactly once). **Phase 9 — newest wins**: a *stamped* write (`at` = the writer's `serverNow()` at save time) is clamped to `Date.now() + PROFILE_CLOCK_SKEW_MS` and stored only when `at >= docsAt[key]` (absent = 0, ties accept, and the stamp is recorded in `docsAt[key]`); an older stamp returns `'stale'`. A `fresh` write — or a write with no `at` at all — is a *default / starter* save: stored only while the key is absent, and never stamped, so any later stamped write beats it. `sanitizeRecord` keeps `docsAt` only for keys that actually have a document and clamps each stamp into `0 … now + PROFILE_CLOCK_SKEW_MS`. Persistence: `<dataDir>/profiles.json` (default `DEFAULT_DATA_DIR` = `server/data/`, git-ignored; `dataDir: null` = memory, used by the selftest) written atomically (tmp + rename) with a 1 s debounce (`PROFILE_SAVE_DEBOUNCE_MS`) and flushed synchronously on `close()`. The server never interprets documents — only `credits` and the stamps. **Phase 11 — the social store**: `ProfileRecord.social` (`SocialRecord`) is server-owned *and* server-readable, so unlike `docs` it is validated field by field (`sanitizeSocial`: array caps `SOCIAL_FRIEND_MAX` / `SOCIAL_REQUEST_MAX` / `SOCIAL_RECENT_MAX`, invalid + duplicate + self codes dropped, `friends ∩ incoming/outgoing/recent` dropped, name sanitized, level floored into `0 … SOCIAL_LEVEL_MAX`, timestamps clamped). `ensureSocial(id, name?)` creates the record on first contact and `assignCode` derives its `PlayerCode` (`playerCodeFrom(peerId, salt)`, salt bumped past a collision with a *different* peer id), kept in a `byCode` index rebuilt in `load()` (a duplicate or unusable code is re-derived there); `getIfExists` / `social` / `peerByCode` / `card` never create a record. Rules live here, not in the relay: `setSocialLevel`, `addFriendRequest` (`self` / `already` / `limit`), `respondFriendRequest` (`invalid` / `limit`, accepting clears both `recent` entries), `removeFriend` (mutual, `invalid`), `recordMet` (newest-first, no duplicates, friends skipped, trimmed to `SOCIAL_RECENT_MAX`). A record with a `social` field is never treated as a placeholder, so an 아이디 survives a restart even for a profile that saved nothing else. |
| `Lobby.ts` | **2026-09-09**: `hostDown` (호스트가 `lobby:hostDown` 으로 켠 사망 표시 — `reset()` · `migrateHost()` · `transferHostTo()` 가 지운다) 와 `transferHostTo(targetId)` (지명 이관: 같은 로비의 **연결된** 멤버만, 슬롯 규칙을 타지 않는다). `Lobby` (players map with `connected` / `inMission` flags, lowest-free-slot assignment, ready flags, `start(seed, mode, starterId)` / `reset()`, `mode` (`raid` or `training` while started), `raid` blobs per member (`setRaid` only for the running raid's seed, `getRaid`), `isJoinable()` (a training keeps the lobby open), `isPublic`, `createdAt`, `migrateHost(force?)`, `allReady()` over connected members only, `inMissionCount()`) and `LobbyManager` (code generation from `NET_LOBBY_ALPHABET`, peer → lobby index, create/join/leave, `findQuickMatch()` / `quickMatch()`, empty-lobby deletion). **Phase 9 migration rule**: not started (hub) → lowest-slot *connected* member as before; **started** → candidates are connected members **inside the mission** (`inMission`) only, and when there is none the role is **parked** (`migrateHost()` returns false, the dropped host's id is kept) until an in-mission member reconnects. `force` skips the "current host still connected" no-op, so a connected host that leaves the mission (page reload) can hand the authority over. `remove()`: a started lobby left with **no `inMission` member at all** is over — `reset()` first, then the ordinary hub migration. Korean error strings `LOBBY_ERROR_MESSAGE_KO` (incl. `not_started`, `duplicate`, `too_large`, `in_mission`). **Phase 11**: `Lobby.planet` (`PlanetId | null`) rides along in `toState()` and is deliberately **kept by `reset()`** — the destination outlives the mission; `no_planet` joins the error table. |
| `selftest.ts` | `npm run net:selftest` (**278 checks**): boots on a random port with a 300 ms grace (memory store) and drives `WebSocket` clients through health, ping, bad input, create, invalid/unknown code, normalized join, slots, ready gating, start, late-join refusal, relay to `host`/`others`/peerId/`all`, reset, leave, slot reuse; then tokens (deterministic id, invalid token → random id, duplicate socket replacement), disconnect keeps the slot with `connected=false`, immediate host migration to a connected member (hub) vs host id kept while started (returning host stays host), resume `welcome {lobby, resumed}` within grace (+ `?n=` rename), grace expiry → `peer:left` (hub lobbies; inside a running raid the slot is **kept** and only the host role moves — see 2026-09-07 below), late return → no lobby, `allReady` ignoring dropped members, resume into a started lobby, ready no-op on started lobbies; quick match (create public / join oldest open / private & started lobbies skipped / `in_lobby`), `setPublic`, `seed`, `name`; ghost hosts (quick match and code join into a not-started lobby whose host is in grace → joiner becomes host, connected-first quick-match preference, started lobbies unaffected). **Phase 7 (parts 5–7)**: `welcome.profile` for token ids (none for anonymous), `profile:set` / `profile:get` round trip, key replacement, `invalid` key / missing doc, `too_large` over the cap, ordinary frames still capped at 64 KB; credits (refusal below zero, `migrate` seeding once, atomic debit, overdraft, integer truncation, non-numeric → `invalid`), persistence across reconnect, `/health.profiles`; raid blobs (ignored outside a lobby / before start / foreign seed / during a training, latest wins, `too_large`, malformed → `invalid`, returned in `welcome.raid` on resume, dropped by `lobby:reset`); `lobby:mission` (`in_mission` when nothing runs, raid start marks every connected member, leave / rejoin); training (non-host start with `mode:'training'`, no ready gating, only the starter `inMission`, `started` on a second start, joins stay open, join via `lobby:mission true`, starter leaving keeps it running, last member leaving → server reset, reset when the last trainee's grace expires); a second server with `hostMigrateDelayMs` 250 ms: host back within the delay stays host, otherwise the role moves to the connected **inMission** member (slot order otherwise), the old host returns as a client (`welcome.lobby.hostId`), relay to `'host'` reaches the new host, chained migrations, hub lobbies still migrate immediately; `ProfileStore` file round trip (debounced write, reload, placeholders not persisted). **Phase 9**: profile stamps (`at` stores `docsAt`, an older stamp is ignored *without* a `lobby:error`, an equal stamp wins as the latest write, `fresh` over an existing key is ignored while `fresh` on an absent key stores an unstamped doc that any later stamp beats, a set with no `at` behaves like `fresh`, a far-future `at` is clamped to `now + PROFILE_CLOCK_SKEW_MS`, a non-numeric `at` → `invalid`, `docsAt` lists only stamped keys and rides along in `welcome.profile`), store-level `'stale'` results + `docsAt` file round trip + `sanitizeRecord` clamping a hostile `docsAt`; and on the 250 ms-migrate server: a **parked host** (host down past the delay while only a hub member is connected → no migration, lobby keeps the dropped host id and stays started, relay to it dropped silently), an in-mission member reconnecting into a parked lobby becoming host inside its own `welcome`, the **duplicate socket** (page reload) leaving the mission (`inMission false`, mission still running), a returning in-mission member taking the role from a host that left the mission, the **last in-mission member leaving a raid** → server reset (raids end like trainings), a connected host reporting `lobby:mission false` mid-raid handing over at once, and a parked host's grace expiring with nobody inside → reset + ordinary hub migration. **Phase 11 (part 8)**: 목표 행성 (`lobby:planet` host-only / not-started / unknown id → `invalid` / no-op echo, `no_planet` on a raid start, `game:start.planet`, `lobby:start {planet}` overriding the stored one, a training carrying none, `reset()` keeping it) and 소셜 (`welcome.social` + the derived 아이디, anonymous → `unavailable`, `social:me` clamping, friend request → decline → accept → mutual remove with `self` / `not_found` / `already` / `invalid`, dashed input, no `PeerId` in a snapshot, presence pushed to a friend **outside** any lobby on create / leave / disconnect / reconnect / training / raid, 최근 만난 플레이어 written on a shared ship and cleared by a friendship, `social:play` in all three branches plus `self` / `already` / `busy` / `offline` / `in_mission`, whisper routing / trimming / caps / `offline`, and the watcher index going quiet after 친구 삭제) followed by store-level checks (code index + salted re-derive, caps, `sanitizeSocial`, a `profiles.json` round trip). Every raid start in parts 1–6 picks a planet first (`pickPlanet`). Exits 0 on success. |
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
  Phase 11: `social: SocialSnapshot` for every token-derived id as well — the 아이디 is assigned on that first contact
  (`ProfileStore.ensureSocial`) and `?n=` refreshes the stored display name. An anonymous socket gets no snapshot and
  every `social:*` request from it answers `social:error unavailable`.

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

**2026-09-07 — a dropped raider keeps their slot for the whole raid.** `armGrace(c)` re-arms instead of reaping when
the member is `inMission` of a **started raid** (never a 훈련장 — that is entered and left individually and holds no
body) *and* at least one **other connected member is still inside the mission*. The host holds the body as a ghost
(`NET_GHOST_PARK_S`, now an hour) and the client auto-rejoins on reconnect, so cutting the slot at 5 minutes was
throwing a live run away. Two things are deliberately unchanged: the **host role** still moves at the first grace
expiry (`migrateHost()` + `lobby:state` from inside `armGrace`, on top of the `hostMigrateDelayMs` path), so the squad
never sits without an authority; and when the expiring member was the **last one inside**, the slot is reaped exactly
as before — which ends the mission, migrates the host and lets an abandoned lobby die.

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
| `lobby:start {seed, mode?, planet?}` | raid (default): host only (`not_host`), every *connected* member ready and ≥ 1 connected (`not_ready`), not already started (`started`), a 목표 행성 in the message **or** already on the lobby (`no_planet`, Phase 11) → `game:start {seed, lobby, mode:'raid', planet}` to all, every connected member `inMission`; a `planet` in the message replaces `LobbyState.planet`. `mode:'training'`: any member, no ready gating, no planet (ignored if sent), only the sender `inMission` → `game:start {…, mode:'training'}` to all |
| `lobby:planet {planet}` | host only (`not_host`), not started (`started`), known `PlanetId` (`invalid`) → `LobbyState.planet` → `lobby:state` to the lobby (**there is no travel message**: every member plays the cutscene off its own copy). Picking the planet that is already set only echoes the state to the sender. Survives `lobby:reset` |
| `social:get` | → `social:state {social}` (the sender's snapshot). No profile → `social:error unavailable` |
| `social:me {level}` | clamp `0 … 999` and store → `social:state` to the sender + every connected friend |
| `social:request {code}` | `self` / `not_found` (unknown or malformed 아이디) / `already` (friends or a pending request either way) / `limit` (`SOCIAL_FRIEND_MAX`, `SOCIAL_REQUEST_MAX`) → recorded on **both** records → `social:state` to both |
| `social:respond {code, accept}` | the request must sit in my `incoming` (`invalid`). Accept → both `friends` + both `recent` entries dropped; decline → the request only. `social:state` to both |
| `social:remove {code}` | mutual removal (`invalid` when we are not friends) → `social:state` to both |
| `social:play {code}` | ① `offline` / `in_mission` / `full` (either squad) from `playBlockReason`; ② the target **has a ship** → I leave mine when I am alone in it (`busy` when others are in it, `already` when it is the same ship) and am added to theirs → `lobby:state` to both ships + `social:play {outcome:'joined'}` to me; ③ the target **has no ship** → mine is created first when I had none (`lobby:state`), `social:invited {invite}` to them, `social:play {outcome:'invited'}` to me |
| `social:whisper {code, text}` | trim + strip markup / control characters + cut to `SOCIAL_WHISPER_MAX` (empty → `invalid`), unknown 아이디 → `not_found`, target not connected → `offline`; otherwise `social:whisper {code, name, text, at}` to them (works outside any lobby). No echo — the sender renders its own line |
| `lobby:transferHost {targetId, claim?}` | **분대장 지명 이관 (2026-09-09)**. 허용되는 경우는 둘뿐: ① 보낸 사람이 지금 호스트, ② `claim` 이고 현재 호스트가 `lobby:hostDown` 으로 사망 표시를 켜 두었다. 그 외 `not_host`; `targetId` 가 같은 로비의 **연결된** 멤버가 아니면 `invalid`; 로비 밖이면 `not_in_lobby`. 성공 → `Lobby.transferHostTo` (hostId + 모든 `isHost` 갱신, 사망 표시 해제, `clearMigrate`) → `lobby:state` 방송 + 로그 한 줄. 이미 그 사람이 호스트면 방송 없이 보낸 사람에게만 상태를 되돌린다 |
| `lobby:hostDown {down}` | **호스트 본인만** (`not_host`). `LobbyState` 에 실리지 않으므로 **아무것도 방송하지 않는다**. 호스트가 바뀌면(`migrateHost` · `transferHostTo`) 또는 미션이 끝나면(`reset()`) 자동으로 꺼진다 |
| `lobby:reset` | host only → started=false, seed=null, mode cleared, all ready=false, all inMission=false, raid blobs dropped, **hostDown 해제** → `lobby:state` |
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
(markup/control chars stripped, 16 chars). Phase 11: the seven `social:*` requests answer with `social:error
{code, message}` (`SocialErrorCode` + `SOCIAL_ERROR_MESSAGE_KO`) instead — a malformed **frame** is still
`lobby:error invalid` (the parser refuses it before any handler sees it).

## 목표 행성 · 소셜 (Phase 11, 2026-09-07)
- **행성**: `LobbyState.planet` is picked by the host at the terminal (`lobby:planet`) and mirrored by everyone; there
  is no travel message, the `lobby:state` broadcast *is* the cue. A raid cannot start without one (`no_planet`,
  checked **after** the ready gating so the older error still wins), a training ignores it, and `reset()` keeps it so
  the squad's destination outlives the mission. `game:start` carries the planet it started with.
- **아이디**: the relay derives a `PlayerCode` from the PeerId (`playerCodeFrom`) on the first token connect, stores it
  on `ProfileRecord.social` and keeps a code → PeerId index; a collision with a *different* peer id bumps the salt.
  **Only the code travels** — `SocialSnapshot` resolves friends / requests / 최근 만난 플레이어 into
  `SocialPlayer {code, name, level, presence, squad, joinable}` rows, so no client ever learns another player's PeerId.
- **프리즌스**: derived, never stored — `clients` (socket present), `lobbies.lobbyOf` (squad size), `LobbyPlayer.inMission`
  and `Lobby.mode` fold into `offline | ship | raid | training`. A member inside the 5-minute reconnect grace reads
  `offline`: they are gone *now*. `joinable` is `playBlockReason(...) === null`, the same pure rule the UI greys out with.
- **푸시 채널**: `broadcast()` only reaches a lobby, so a `watchers` index (subject → connected friends of the subject,
  plus its reverse `watching`) carries `social:state` to everyone a change concerns — on connect, disconnect, lobby
  join / leave, `lobby:mission`, mission start / reset and `lobby:planet`. Nothing polls; the index is rebuilt for both
  sides after every friend change and dropped in `close()`.
- **최근 만난 플레이어**: recorded on both records the moment two profiles share a ship (join / quick match / 같이 하기),
  newest first, never for friends, capped at `SOCIAL_RECENT_MAX` and cleared when the two become friends.

### Known follow-ups
- The watcher index tracks **friends only** (as specified), so the presence of a row in `incoming` / `outgoing` /
  `recent` only refreshes on the next mutation or `social:get` — the ESC screen calls `refresh()` on open for that reason.
- A social record is created for **every** token connect (that is what makes an offline friend findable by 아이디), so
  `profiles.json` now grows by one small record per visitor; there is no expiry or GC.
- `playBlockReason`'s `my_squad_full` is reported as `full` — the contract has no separate code for "my own squad is
  full", and the message ("상대 분대가 가득 찼습니다") is then slightly off.
- `social:play` branch ② is not atomic: the caller leaves its own (solo) lobby and then joins the target's. If the
  target's last slot is taken in between, the caller ends up with no ship and a `full` error.
- A `social:invited` is fire-and-forget: the server keeps no invite state, so the TTL, the dedupe and the P-hold all
  live on the receiving client, and a lobby that fills up (or disbands) before the hold completes fails at the join.
- A whisper is not echoed to its sender and nothing is stored, so there is no history, no delivery receipt and no
  block list; `sanitizeWhisper` strips `<`/`>` exactly like `sanitizePlayerName` (so `<b>` reads `b`).
- The 아이디 is derived from the **session token**: clearing browser storage produces a new profile and a new 아이디,
  and friends keep the old (now unreachable, still indexed) code in their lists until they remove it.
- Presence has no per-friend rate limit: a member flipping `lobby:mission` quickly fans out one snapshot per flip to
  every connected friend. Snapshots are small (a handful of rows) but this is the obvious thing to coalesce later.

## Running
- `npm run server` — relay only (port 8787). Profiles persist in `server/data/profiles.json` (`dataDir` option; delete the file to wipe).
- `npm run dev:all` — relay + Vite dev server together (`scripts/dev-all.mjs`, prefixed output, Ctrl+C stops both).
  The Vite dev server proxies `/ws` to `ws://localhost:8787`, so the browser uses same-origin `/ws`.
- Production: serve `dist/` from anywhere and point the client at the relay with `VITE_WS_URL=wss://host:port/ws`
  at build time, or put both behind one reverse proxy that forwards `/ws`.

---

## 배포 (2026-09-10)

서버를 켤 사람에게 저장소 · Node · `npm install` 을 요구하지 않는다. `npm run server:dist` 가 세 단계로
`release/SCAVANGER-Server.exe` 를 만든다 (`scripts/build-server.mjs`):

1. **번들** — `tool.ts` + 릴레이 + `ws` → `dist-server/server.cjs` (rolldown, vite 의존성이라 새 패키지가 없다).
   형식은 **CJS** 다: Node SEA 의 main 스크립트는 CommonJS 여야 한다. `bufferutil` · `utf-8-validate` 는
   external 로 남긴다 — `ws` 가 `try/catch` 안에서 require 하므로 없으면 순수 JS 경로로 조용히 내려간다.
2. **blob** — `node --experimental-sea-config`.
3. **주입** — `node.exe` 사본 + postject(`NODE_SEA_BLOB`), 그리고 rcedit 가 있으면 아이콘 · 버전 정보.

결과는 86 MB 짜리 단독 exe 다 (Node 런타임이 그 안에 있다). `npm run app:dist` 는 이것을 배포 폴더
`release/SCAVANGER/` 안에 함께 넣는다 — 그 폴더 구성은 [electron/README.md](../electron/README.md) 를 본다.

검증은 `scripts/smoke-server-dist.mjs` (`npm run verify` 가 `server/` · `src/net/` 변경에 매핑한다): 번들이
CJS 인지 · `ws` 가 안에 들어갔는지 · `--port` / `--data` 가 먹는지 · `/health` 와 `welcome` 이 오는지, 그리고
주소 규약(`relayUrlFrom` · `lanAddresses`)까지 **브라우저 없이** 잰다. exe 단계(postject)는 굽지 않는다.

**서버 프로필은 접속 주소가 아니라 토큰에 묶여 있다** (`peerIdFromToken`). 그래서 플레이어가 다른 서버로
옮겨 갔다 돌아오면 그 서버가 들고 있던 크레딧 · 창고 · 진행도를 그대로 되찾는다 — 서버마다 별도 계정이다.

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../docs/HISTORY.md) 에 있다.

- **2026-09-10 (배포용 서버 툴)** — `tool.ts` 추가. `RelayServer` · `Store` · `Lobby` · 프로토콜은 **한 줄도
  바뀌지 않았다** — 새 엔트리 하나와 그것을 굽는 스크립트(`scripts/build-server.mjs`)뿐이다. 저장 폴더 기본값이
  엔트리마다 다른 것이 유일한 차이다: `index.ts` 는 여전히 `server/data/`(`DEFAULT_DATA_DIR`), `tool.ts` 는
  사용자 폴더. 클라이언트가 이 서버를 어떻게 찾는지는 `src/shared/net.ts` 의 `RELAY_STORAGE_KEY` 주석
  (게임 내 설정 > `--relay` > `SCAV_RELAY` > `server.txt` > 내장 릴레이).

- **Phase 7** — `Store.ts` profile store (`profiles.json` under `server/data/`, git-ignored; `dataDir:null` = memory), `welcome.profile / raid`, `profile:get / set`, `credits:tx` → `credits:result`, `raid:save` per running raid, `lobby:start {mode:'training'}` by any member, `lobby:mission` + `LobbyPlayer.inMission` (a training resets itself when its last member leaves), host migration `NET_HOST_MIGRATE_DELAY_MS` after the host drops mid-mission (prefers connected in-mission members), `/health.profiles`

- **Phase 9** — per-document stamps (`ProfileRecord.docsAt`, `profile:set {at, fresh}`, newest wins, clamped to the server clock + `PROFILE_CLOCK_SKEW_MS`), while a raid is started the host role migrates **only** to a connected in-mission member (nobody inside → the role is parked until one returns; the last one leaving resets the mission), and a duplicate socket (page reload) clears `inMission`

- **Phase 11** — `ProfileRecord.social` 저장소(아이디 발급 + 충돌 salt + 코드→PeerId 인덱스 + 정화 · 캡), 프리즌스(`clients` / `lobbyOf` / `inMission` 접기, 그레이스는 `offline`), 로비 **밖** push 채널(친구 watcher 인덱스 — 접속 · 해제 · 로비 이동 · `lobby:mission` · start · `lobby:planet` 마다 팬아웃), `social:*` 7 핸들러(3분기 `social:play`, 최근 만난 플레이어 자동 기록), `lobby:planet` (호스트 · 미시작) · 레이드 `no_planet` 게이트 · `game:start.planet` · `lobby:reset` 후에도 목적지 유지, `lobbyState()` 가 모든 `LobbyState` 에 아이디 · 레벨을 실어 보낸다

- **2026-09-09 (분대장 지명 이관)** — `Lobby.hostDown` (호스트가 스스로 세우는 사망 표시, `reset()` · 이관에서
  자동 해제) + `Lobby.transferHostTo(targetId)` (슬롯 규칙을 건너뛰는 지명 이관, 연결된 멤버만), 그리고
  `lobby:transferHost` / `lobby:hostDown` 두 핸들러 + 파서. 자동 이관(드롭 · 미션 이탈) 규칙은 **하나도 바뀌지
  않았다** — 지명은 세 번째 경로로 더해졌을 뿐이고, 승격/강등은 여전히 `lobby:state` → `net:hostChanged` 다.
  `selftest.ts` 에 **part 9** (17 checks): 호스트 이관 성공 · 비호스트 `not_host` · 표시 없는 claim `not_host` ·
  비호스트 `lobby:hostDown` `not_host` · 표시는 방송하지 않음 · 표시 후 claim 성공 · 표시가 이관과 함께 지워짐 ·
  로비 밖/미지의 targetId `invalid` · 이미 호스트면 방송 없는 에코 · 로비 밖 `not_in_lobby` · `lobby:reset` 이
  표시를 지움 · 잘못된 프레임 두 종류. **295/295**.

- **2026-09-07** — `armGrace` — 진행 중인 **레이드** 안에 있던 멤버는 (다른 접속 멤버가 아직 안에 있는 한) 슬롯을 레이드가 끝날 때까지 유지한다(훈련장 제외, 호스트 역할은 예전처럼 첫 만료에 이관)
