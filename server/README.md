# server — WebSocket relay (lobbies + opaque message relay)

Small Node server that owns lobbies and forwards `GameMessage`s between lobby members. It never inspects relayed
payloads; the lobby host is the gameplay authority (see `src/shared/net.ts`).

Runs directly under **Node native type stripping** — no build step, no `tsx`. Node ≥ 23.6 needs no flag; Node 22.6–22.17 needs `--experimental-strip-types` (already in the `server` / `net:selftest` npm scripts). Rules for these files: erasable
TypeScript only (no enums / namespaces / parameter properties), explicit `.ts` extensions on relative imports,
`import type` for anything type-only. Runtime constants/helpers are value-imported from `../src/shared/net.ts`
(that file has no runtime dependencies).

| File | Responsibility |
|---|---|
| `index.ts` | Entry (`npm run server`, i.e. `node --experimental-strip-types server/index.ts`). Reads `PORT` (default `NET_DEFAULT_PORT` 8787) and `HOST` (default `0.0.0.0`), graceful SIGINT/SIGTERM shutdown. **2026-09-11**: `--data=<dir>` / `SCAV_DATA_DIR` moves the profile store (default `server/data/`) — `scripts/verify.mjs` gives the relay it starts itself a temp folder. **2026-09-11 (E-4)**: `SCAV_DEV_ECONOMY=1` / `--dev-economy` → `devEconomy` (the dev credit reasons, `devEconomyFromEnv`) — set **only** by the relay the verify runner starts itself; off for `npm run dev:all` · `start-server.bat` · `npm run server` (사용자 결정). `/health` reports `devEconomy` and the table `economy` hash. |
| `tool.ts` | **배포용 엔트리** (2026-09-10). `scripts/build-server.mjs` 가 이 파일을 번들해 `SCAVANGER-Server.exe` 로 굽는다 — 받는 사람은 저장소도 Node 도 없다. `index.ts` 와 **같은 릴레이**를 다른 껍데기로 감싼다: `--port` / `--host` / `--data` (+ `PORT` · `HOST` · `SCAV_DATA_DIR`), 친구에게 그대로 불러 줄 주소 배너(`shared/net.lanAddresses` 순위), 저장소는 exe 옆이 아니라 **`%LOCALAPPDATA%\SCAVANGER\server`**(배포 폴더에는 사람이 고치는 `server.txt` 만 둔다), 접속 · 로비 수가 **변할 때만** 한 줄, `EADDRINUSE` 에는 대안 포트를 알려 주고 **창을 닫지 않는다**(더블클릭한 콘솔에서 에러를 읽을 수 있게). SEA 번들이 CJS 라 **top-level await 이 없다** — 부팅 전체가 `main()` 안이다. **2026-09-11 — 서버 콘솔**: 창에 `list` · `lobbies` · `kick <아이디> [사유]` · `max <인원>`(0 · off = 무제한) · `gc`(프로필 정리 지금 한 번, B-2) · `help` 를 친다 (readline, stdin 이 없으면 콘솔만 없다). `--max=<n>` / `SCAV_MAX_CLIENTS` 는 시작할 때의 제한. 밴은 없다. |
| `RelayServer.ts` | `startRelayServer(opts)` → HTTP server (`GET /health` → `{ok, lobbies, clients, pendingReconnects, profiles, uptime}`) + `ws` `WebSocketServer` on `/ws` (`NET_WS_PATH`). Session tokens → stable `PeerId` (`peerIdFromToken`, `isValidSessionToken`), duplicate-session replacement, per-connection `welcome {id, lobby?, resumed?, profile?, raid?}`, inbound validation (JSON, type/field checks, 64 KB cap — only `profile:set` / `raid:save` may reach `MAX_DOC_FRAME_BYTES`), message handlers, reconnect grace timers, **host-migration timers** (Phase 7), broadcast helpers, 15 s ping heartbeat (dead sockets terminated), one log line per lobby / credits event. **Phase 9**: `profile:set` also parses the optional `at` (finite number) / `fresh` (boolean) — a malformed one is `invalid`, a `'stale'` store result is dropped silently; `autoResetMission(lobby)` closes **any** started lobby whose last `inMission` member left (raids now as well as trainings) and re-runs the hub migration afterwards; `migrateHostAway(lobby, id)` moves the authority off a *connected* host that reported `lobby:mission false`; the parked-host retries live in the `lobby:mission true` handler and in the resume path. **Phase 11**: `parseClientMessage` validates `lobby:planet` / `lobby:start.planet` (an unknown `PlanetId` → `invalid`) and the seven `social:*` frames (`sanitizeWhisper`, `MAX_WHISPER_INPUT`); the raid start refuses `no_planet`; **presence** (`presenceOf` → `PresenceState` + squad size) is folded out of `clients` / `lobbies` / `inMission` / `lobby.mode` and resolved into a `SocialSnapshot` (`buildSnapshot` / `resolveRow`, codes only — a `PeerId` never leaves the server); the missing out-of-lobby push channel is the `watchers` / `watching` index (`rewatch` on connect + after any friend change, `pushPresence` / `pushLobbyPresence` on connect / disconnect / lobby join / leave / `lobby:mission` / start / reset / `lobby:planet`, `notifyWatchers` on `social:me`), cleared in `close()`. Options: `port, host, quiet, heartbeatMs, reconnectGraceMs, hostMigrateDelayMs, dataDir, profileSaveDebounceMs`. Returns `{port, http, wss, lobbies, store, clientCount(), close()}`. **2026-09-11 (B-3 · B-4 · B-5 · B-6)**: see `소셜 서버` below — `watchers` index **all four lists** · every push through `PushCoalescer` (`pushSocial` = marked, `pushSocialNow` = the requester's own answer) · `announceLeave` / `removeFromLobby` / **`moveToLobby`** (atomic, `lobby:left {reason:'moved', to}`) · `closeInvite` / `sweepInvites` / `settleInvitesInto` / `openInvite` over an `InviteTable` · parser for `social:inviteReply` · `social:block` · `social:whisper.nonce` · options `inviteTtlMs`, `socialPushCoalesceMs`. |
| `Invites.ts` | **2026-09-11 (B-3 · B-5)** — memory-only social state, no sockets. `InviteTable` (`add(from, to, lobby, at, hidden)` → `OpenInvite {id, from, to, lobby, at, hidden}` with one TTL timer, `get` · `all` · `toPeer(to, includeHidden?)` · `fromPeer` · `pair(from, to)` · `between(a, b)` · `remove(inv)` → false when already closed · `clear`; `onExpire` callback, `ttlMs` default `SQUAD_INVITE_TTL_S`). `PushCoalescer` (`mark(id)` arms one `SOCIAL_PUSH_COALESCE_MS` timer for the whole set, `now(id)` sends at once and unmarks, `flush` · `close` · `pending` · `sent`). |
| `Store.ts` | **Profile store** (Phase 7): `ProfileStore` maps `PeerId` → `ProfileRecord {credits, docs, updatedAt, docsAt?}` (`src/shared/profile.ts`). `get(id)` creates an empty `{credits: null, docs: {}}` on demand (never persisted until written), `snapshot(id)` for the wire (copies `docsAt`), `setDoc(id, key, doc, at?, fresh?)` → `SetDocResult` (`invalid` for a bad key, `too_large` over `PROFILE_DOC_MAX_BYTES`, **`'stale'`** = ignored, not an error), `applyCredits(id, delta, reason)` → `CreditsTxResult` (atomic; a result below 0 is refused with `크레딧 부족`; the `'migrate'` reason seeds a still-null balance with `delta` exactly once; **2026-09-11 (E-4)** optional `max` = `CREDITS_MAX` cap — the relay calls **`applyCreditsTx(id, delta, reason, economy)`**, which validates through `Economy.ts` first and writes `ProfileRecord.ledger`; `ledgerOf(id)`; `sanitizeRecord` keeps the ledger through `sanitizeLedger`, `snapshot` never copies it). **Phase 9 — newest wins**: a *stamped* write (`at` = the writer's `serverNow()` at save time) is clamped to `Date.now() + PROFILE_CLOCK_SKEW_MS` and stored only when `at >= docsAt[key]` (absent = 0, ties accept, and the stamp is recorded in `docsAt[key]`); an older stamp returns `'stale'`. A `fresh` write — or a write with no `at` at all — is a *default / starter* save: stored only while the key is absent, and never stamped, so any later stamped write beats it. `sanitizeRecord` keeps `docsAt` only for keys that actually have a document and clamps each stamp into `0 … now + PROFILE_CLOCK_SKEW_MS`. Persistence: `<dataDir>/profiles.json` (default `DEFAULT_DATA_DIR` = `server/data/`, git-ignored; `dataDir: null` = memory, used by the selftest) written atomically (tmp + rename) with a 1 s debounce (`PROFILE_SAVE_DEBOUNCE_MS`) and flushed synchronously on `close()`. The server never interprets documents — only `credits` and the stamps. **Phase 11 — the social store**: `ProfileRecord.social` (`SocialRecord`) is server-owned *and* server-readable, so unlike `docs` it is validated field by field (`sanitizeSocial`: array caps `SOCIAL_FRIEND_MAX` / `SOCIAL_REQUEST_MAX` / `SOCIAL_RECENT_MAX`, invalid + duplicate + self codes dropped, `friends ∩ incoming/outgoing/recent` dropped, name sanitized, level floored into `0 … SOCIAL_LEVEL_MAX`, timestamps clamped). `ensureSocial(id, name?)` creates the record on first contact and `assignCode` derives its `PlayerCode` (`playerCodeFrom(peerId, salt)`, salt bumped past a collision with a *different* peer id), kept in a `byCode` index rebuilt in `load()` (a duplicate or unusable code is re-derived there); `getIfExists` / `social` / `peerByCode` / `card` never create a record. Rules live here, not in the relay: `setSocialLevel`, `addFriendRequest` (`self` / `already` / `limit`), `respondFriendRequest` (`invalid` / `limit`, accepting clears both `recent` entries), `removeFriend` (mutual, `invalid`), `recordMet` (newest-first, no duplicates, friends skipped, trimmed to `SOCIAL_RECENT_MAX`). A record with a `social` field is never treated as a placeholder, so an 아이디 survives a restart even for a profile that saved nothing else. **2026-09-11 (B-4)**: `SocialRecord.blocked` (cap `SOCIAL_BLOCK_MAX`) and `.inbox` (offline whispers, `WhisperInboxLine`) — `sanitizeSocial` keeps both (a blocked code is dropped from my friends / requests / recent; `sanitizeInbox` drops malformed · blocked-sender · expired lines and keeps the newest `SOCIAL_WHISPER_INBOX_MAX`); `setBlocked(me, other, blocked)` (`self` / `limit`; block = unlink both records, unblock = drop the request half they sent while blocked), `isBlocked(owner, code)`, `pushWhisperInbox` / `takeWhisperInbox` (delivered once); `addFriendRequest` refuses toward a code I blocked (`invalid`) and writes **only my outgoing** when they blocked me; `recordMet` skips a blocked pair; the GC also drops dangling blocked codes and expired inbox lines. **2026-09-11 (E-6)**: `docsRev` per document (seeded 1 on load, bumped by every accepted write), `writeDocs(id, writeId, entries)` → `RevWriteResult` (`ack` · `conflict` · `refused`, all or nothing, write ids remembered in memory), `revOf` — see `문서 리비전`. |
| `Economy.ts` | **2026-09-11 (E-4) — 서버 크레딧 검증**, pure (no sockets, no store). `ECONOMY_TABLE` = `economy.gen.json` through a **JSON import** (`with { type: 'json' }` — Node's JSON module under `index.ts`, inlined by rolldown into the exe bundle) shape-checked by `loadEconomyTable` (throws: a relay with a broken table must not start). `CreditEconomy(table, {dev})` — `check(balance, ledger, delta, reason, now)` → `{ok, parsed, delta, seed}` / `{ok:false, why}` (the rules of `src/shared/credits.ts`, see `서버 크레딧 검증` below), `commit(ledger, check, now)` after the balance really moved. `sanitizeLedger` · `pruneLedger` · `emptyLedger` (caps `CREDIT_LEDGER_DEBITS_MAX` 256 · `CREDIT_LEDGER_QUESTS_MAX` 1024, `CREDIT_CONTRACT_WINDOW_MS` 1 h), `economyTableIntact`, `devEconomyFromEnv(env, argv)`. |
| `economy.gen.json` | **Generated, committed** (2026-09-11, E-4): the economy table the relay prices `credits:tx` with — item value · stack, implant repair fees, contract / quest credit rewards, shop / sell multipliers, `CREDITS_MAX`, `repLevelMax`, `hash` (= `economyTableDigest` of the body). Written by `npm run data:check -- --write` from the **client's own modules** (`scripts/economy-table.mjs`); `npm run data:check` fails while it differs from what the csv produce. Never hand-edit. |
| `Lobby.ts` | **2026-09-09**: `hostDown` (호스트가 `lobby:hostDown` 으로 켠 사망 표시 — `reset()` · `migrateHost()` · `transferHostTo()` 가 지운다) 와 `transferHostTo(targetId)` (지명 이관: 같은 로비의 **연결된** 멤버만, 슬롯 규칙을 타지 않는다). `Lobby` (players map with `connected` / `inMission` flags, lowest-free-slot assignment, ready flags, `start(seed, mode, starterId)` / `reset()`, `mode` (`raid` or `training` while started), `raid` blobs per member (`setRaid` only for the running raid's seed, `getRaid`), `isJoinable()` (a training keeps the lobby open), `isPublic`, `createdAt`, `migrateHost(force?)`, `allReady()` over connected members only, `inMissionCount()`) and `LobbyManager` (code generation from `NET_LOBBY_ALPHABET`, peer → lobby index, create/join/leave, `findQuickMatch()` / `quickMatch()`, empty-lobby deletion). **Phase 9 migration rule**: not started (hub) → lowest-slot *connected* member as before; **started** → candidates are connected members **inside the mission** (`inMission`) only, and when there is none the role is **parked** (`migrateHost()` returns false, the dropped host's id is kept) until an in-mission member reconnects. `force` skips the "current host still connected" no-op, so a connected host that leaves the mission (page reload) can hand the authority over. `remove()`: a started lobby left with **no `inMission` member at all** is over — `reset()` first, then the ordinary hub migration. Korean error strings `LOBBY_ERROR_MESSAGE_KO` (incl. `not_started`, `duplicate`, `too_large`, `in_mission`). **Phase 11**: `Lobby.planet` (`PlanetId | null`) rides along in `toState()` and is deliberately **kept by `reset()`** — the destination outlives the mission; `no_planet` joins the error table. **2026-09-11 (B-6)**: `Lobby.canAdd()` → `LobbyErrorCode | null` is the **only** copy of the join rule (`add` calls it); `LobbyManager.move(id, toCode, name)` checks the target first (`not_found` · `in_lobby` · `canAdd`) and changes nothing on a refusal, then `leave` + `add` — no rollback path (an `add` refusal after a passed `canAdd` throws). **2026-09-11 (B-11)**: `findQuickMatch(accept?)` / `quickMatch(id, name, accept?)` take an optional candidate predicate — the model knows nothing about 차단, so the relay passes one in; `LOBBY_ERROR_MESSAGE_KO.blocked`. |
| `selftest.ts` | `npm run net:selftest` (**480 checks**): boots on a random port with a 300 ms grace (memory store) and drives `WebSocket` clients through health, ping, bad input, create, invalid/unknown code, normalized join, slots, ready gating, start, late-join refusal, relay to `host`/`others`/peerId/`all`, reset, leave, slot reuse; then tokens (deterministic id, invalid token → random id, duplicate socket replacement), disconnect keeps the slot with `connected=false`, immediate host migration to a connected member (hub) vs host id kept while started (returning host stays host), resume `welcome {lobby, resumed}` within grace (+ `?n=` rename), grace expiry → `peer:left` (hub lobbies; inside a running raid the slot is **kept** and only the host role moves — see 2026-09-07 below), late return → no lobby, `allReady` ignoring dropped members, resume into a started lobby, ready no-op on started lobbies; quick match (create public / join oldest open / private & started lobbies skipped / `in_lobby`), `setPublic`, `seed`, `name`; ghost hosts (quick match and code join into a not-started lobby whose host is in grace → joiner becomes host, connected-first quick-match preference, started lobbies unaffected). **Phase 7 (parts 5–7)**: `welcome.profile` for token ids (none for anonymous), `profile:set` / `profile:get` round trip, key replacement, `invalid` key / missing doc, `too_large` over the cap, ordinary frames still capped at 64 KB; credits (refusal below zero, `migrate` seeding once, atomic debit, overdraft, integer truncation, non-numeric → `invalid` — since 2026-09-11 with real table ids, and a second `migrate` is refused; **part 12** = the E-4 credit rules, see `변경 이력`), persistence across reconnect, `/health.profiles`; raid blobs (ignored outside a lobby / before start / foreign seed / during a training, latest wins, `too_large`, malformed → `invalid`, returned in `welcome.raid` on resume, dropped by `lobby:reset`); `lobby:mission` (`in_mission` when nothing runs, raid start marks every connected member, leave / rejoin); training (non-host start with `mode:'training'`, no ready gating, only the starter `inMission`, `started` on a second start, joins stay open, join via `lobby:mission true`, starter leaving keeps it running, last member leaving → server reset, reset when the last trainee's grace expires); a second server with `hostMigrateDelayMs` 250 ms: host back within the delay stays host, otherwise the role moves to the connected **inMission** member (slot order otherwise), the old host returns as a client (`welcome.lobby.hostId`), relay to `'host'` reaches the new host, chained migrations, hub lobbies still migrate immediately; `ProfileStore` file round trip (debounced write, reload, placeholders not persisted). **Phase 9**: profile stamps (`at` stores `docsAt`, an older stamp is ignored *without* a `lobby:error`, an equal stamp wins as the latest write, `fresh` over an existing key is ignored while `fresh` on an absent key stores an unstamped doc that any later stamp beats, a set with no `at` behaves like `fresh`, a far-future `at` is clamped to `now + PROFILE_CLOCK_SKEW_MS`, a non-numeric `at` → `invalid`, `docsAt` lists only stamped keys and rides along in `welcome.profile`), store-level `'stale'` results + `docsAt` file round trip + `sanitizeRecord` clamping a hostile `docsAt`; and on the 250 ms-migrate server: a **parked host** (host down past the delay while only a hub member is connected → no migration, lobby keeps the dropped host id and stays started, relay to it dropped silently), an in-mission member reconnecting into a parked lobby becoming host inside its own `welcome`, the **duplicate socket** (page reload) leaving the mission (`inMission false`, mission still running), a returning in-mission member taking the role from a host that left the mission, the **last in-mission member leaving a raid** → server reset (raids end like trainings), a connected host reporting `lobby:mission false` mid-raid handing over at once, and a parked host's grace expiring with nobody inside → reset + ordinary hub migration. **Phase 11 (part 8)**: 목표 행성 (`lobby:planet` host-only / not-started / unknown id → `invalid` / no-op echo, `no_planet` on a raid start, `game:start.planet`, `lobby:start {planet}` overriding the stored one, a training carrying none, `reset()` keeping it) and 소셜 (`welcome.social` + the derived 아이디, anonymous → `unavailable`, `social:me` clamping, friend request → decline → accept → mutual remove with `self` / `not_found` / `already` / `invalid`, dashed input, no `PeerId` in a snapshot, presence pushed to a friend **outside** any lobby on create / leave / disconnect / reconnect / training / raid, 최근 만난 플레이어 written on a shared ship and cleared by a friendship, `social:play` in all three branches plus `self` / `already` / `busy` / `offline` / `in_mission`, whisper routing / trimming / caps / `offline`, and the watcher index going quiet after 친구 삭제) followed by store-level checks (code index + salted re-derive, caps, `sanitizeSocial`, a `profiles.json` round trip). Every raid start in parts 1–6 picks a planet first (`pickPlanet`). **Part 8c (2026-09-11, B-3 · B-4 · B-5 · B-6, 64 checks + B-11 7 checks)**: see the `변경 이력` entries. **Part 11 (2026-09-11, E-6, `part11ProfileRevisions`, 24 checks)**: baseRev ack / conflict, writeId + txId replay, setMany all or nothing (stale key · oversized document · bad key · empty), a two-document transaction over the single-document frame cap, Phase 9 frames still unanswered but bumping the rev, anonymous refusal, `docsRev` in welcome and through `profiles.json` (legacy seed, hostile revs). Exits 0 on success. |
| `tsconfig.json` | Type-check config for this folder (`npm run typecheck:server`); `erasableSyntaxOnly` enforces the Node-runnable subset. |
| `data/` | Runtime profile store (`profiles.json` + since 2026-09-11 `profiles.json.bak` = the previous generation, and any `profiles.corrupt-<ts>.json` a failed load moved aside), created on the first write. Git-ignored. Delete it to wipe every server profile. |

## 서버 콘솔 · 저장소 안전 (2026-09-11, C-29 · C-41 · X-2)

**콘솔 관리 (C-29).** `RelayServer` 에 운영용 API 셋이 붙었다 — `listClients()` (연결된 소켓: PeerId · 이름 · 주소 ·
아이디 · 로비 · 분대장 · 임무 중 · 접속 시각, 오래된 순), `kick(idOrCode, reason?)` (PeerId 또는 대시 · 대소문자 무관
아이디), `setMaxClients(n | null)` + `maxClients` (옵션 `maxClients` 로 시작값, `/health.maxClients` 에도 실린다).
`server/tool.ts` 의 readline 콘솔이 이 셋을 부른다. **밴은 없다.**

- `kick` 은 **유예 없이** 슬롯부터 지운다(`removeFromLobby(…, 'kick')` → `peer:left` + 평소의 호스트 이관) → `lobby:error
  kicked`(사유가 있으면 괄호로 덧붙인다) → close `CLOSE_KICKED`(4002), 2 초 뒤 terminate. 닫히기 전에 도착한 프레임은
  `Client.kicked` 로 버린다(늦게 온 `lobby:quickmatch` 가 다시 합류하지 않게). 소켓이 이미 끊겨 유예 중인 멤버는
  슬롯만 비운다(`connected: false`).
- `max` 는 **새 소켓만** 막는다: `clients.size >= max` 면 welcome · 소셜 레코드 · 프리즌스 전에 `lobby:error server_full` →
  close `CLOSE_SERVER_FULL`(4003). 예외 둘 — 같은 토큰의 소켓 교체(새로고침), 그리고 **아직 로비 멤버인 id**(유예 중의
  재접속; 레이드 중에 끊긴 대원이 인원 제한 때문에 자기 레이드로 못 돌아오면 안 된다). 제한을 낮춰도 이미 붙은
  사람은 그대로다.
- 클라이언트(`src/net`)는 두 코드를 받으면 자동 재접속을 멈춘다 — `src/net/README.md` 의 2026-09-11.

**저장소 (C-41 · X-2).** `ProfileStore` 의 디바운스 쓰기가 **비동기**가 됐다: `profiles.json.tmp` 에 쓰고 `fsync` →
이전 `profiles.json` 을 `.bak` 으로 rename → tmp 를 `profiles.json` 으로 rename. 13 MB 짜리 개발 저장소를 동기로 쓰는
동안 릴레이 전체가 멎었었다. 한 번에 하나만 쓰고, 쓰는 중에 바뀌면 끝난 뒤 한 번 더 쓴다. `close()` 는 **동기**로
남았다(종료 직전 마지막 쓰기 보존) — 진행 중이던 비동기 쓰기는 세대 번호가 바뀐 것을 보고 rename 없이 물러나므로
옛 스냅샷이 새것을 덮지 않는다. 포맷(`{v:1, profiles}`)은 그대로다.
예전 `load` 는 파싱에 실패하면 "starting empty" 로 빈 DB 를 띄웠고 **첫 flush 가 원본을 덮어** 모든 계정이 영구히
사라졌다. 이제 ① 원본을 `profiles.corrupt-<ISO 시각>.json` 으로 옮겨 보존하고 ② `.bak` 에서 복구해 곧 새 main 을
쓰며 ③ `.bak` 도 없으면 빈 DB 로 시작하되 원본은 남는다. main 이 없고 `.bak` 만 있으면(두 rename 사이에서 죽음)
`.bak` 을 읽는다. 읽기 자체가 I/O 에러(잠김 · 권한)면 그 저장소는 **메모리로만 돌고 쓰지 않는다.**
`loadResult` · `idle()` 은 진단 · selftest 용이다.

## 프로필 GC (2026-09-11, B-2)

토큰으로 한 번이라도 붙은 사람마다 프로필(한 명당 약 5.7 KB — 클라이언트가 접속하자마자 기본 문서를 올리므로 "소셜만 있는
빈 레코드" 는 사실상 없다)이 영원히 쌓이던 것을 정리한다. 규칙은 `ProfileStore.collectGarbage(keep, now)` 한 곳이다.

- **비활성 프로필 삭제**: `ProfileRecord.seenAt`(릴레이가 토큰 소켓의 **접속 · 해제** 때 `touchSeen`) 기준 `PROFILE_GC_INACTIVE_MS`
  (90일) 동안 안 온 프로필을 크레딧 · 문서 · 아이디째 지운다. **접속 중이거나 로비 멤버(재접속 유예 포함)면 지우지 않는다** —
  릴레이가 `keep` 으로 넘긴다. 같은 토큰이 나중에 오면 새 프로필이고, 아이디는 PeerId 에서 다시 유도되므로 보통 같은 글자다.
- **참조 청소**: 남은 프로필의 친구 · 요청 · 최근 목록에서 **더 이상 어떤 프로필에도 없는 아이디**를 뺀다.
- **만료**: 최근 만난 플레이어 `SOCIAL_RECENT_TTL_MS`(30일), 답 없는 친구 요청 `SOCIAL_REQUEST_TTL_MS`(30일). 요청 시각은
  `SocialRecord.requestsAt` 에 **양쪽 같은 값**으로 적혀 한 번에 같이 철회된다.
- **옛 레코드**(`seenAt` 없음)는 `max(updatedAt, social.updatedAt)` 로 판단하고, 첫 패스에서 그 값을 `seenAt` 으로 굳힌다 —
  안 그러면 버려진 프로필에 누가 친구 요청을 보낼 때마다(`social.updatedAt` 갱신) 수명이 늘어난다. GC 자신은 `updatedAt` 을
  건드리지 않는다. 옛 대기 요청은 로드 시각으로 도장이 찍혀 업그레이드 30일 뒤에 만료된다(곧바로가 아니라).
- **언제**: 릴레이 시작 때 한 번 + `PROFILE_GC_INTERVAL_MS`(6시간)마다(옵션 `profileGcIntervalMs`, `null` = 주기 끔) + 서버 콘솔 `gc`.
  목록이 바뀐 **접속 중인** 사람은 곧바로 새 `social:state` 를 받고 watch 인덱스가 다시 지어진다. 지운 것이 있으면 로그 한 줄.
- 파일 포맷은 그대로다(`seenAt` · `requestsAt` 는 선택 필드). `seenAt` 은 서버 내부라 `snapshot()`(= `welcome.profile`)에 실리지 않는다.

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
| `lobby:quickmatch {name}` | join the best lobby with `isPublic && !started && free slot` — lobbies with ≥ 1 connected member first, then oldest; a lobby whose members are all in grace is used only when nothing better exists — else create a new **public** one → `lobby:state` to the lobby (`in_lobby` if already in one). **2026-09-11 (B-11)**: a lobby holding a 차단 in **either** direction is not a candidate at all (skipped, never refused); every candidate filtered out → the ordinary "nothing open" path creates a new lobby |
| `lobby:join {code, name}` | normalize + validate → `invalid` / `not_found` / `full` / `started` / `in_lobby`; lowest free slot → `lobby:state` to all. **2026-09-11 (B-11) — 차단**, checked **before** the join so a refusal leaves no trace: a member I blocked → `blocked` (명시), a member who blocked me → `not_found` (위장 — indistinguishable from a mistyped code); my own direction wins when both hold. **Ghost host**: joining (by code or quick match) a not-started lobby whose host is in reconnect grace migrates the host to the lowest-slot connected member (the joiner) immediately, so nobody waits on a dropped host |
| `lobby:leave` | remove, `lobby:left` to leaver, `peer:left {id, lobby}` to others (host migrates if needed) |
| `lobby:ready {ready}` | → `lobby:state`; on a **started** lobby: no-op, echoes `lobby:state` to the sender only |
| `lobby:start {seed, mode?, planet?}` | raid (default): host only (`not_host`), every *connected* member ready and ≥ 1 connected (`not_ready`), not already started (`started`), a 목표 행성 in the message **or** already on the lobby (`no_planet`, Phase 11) → `game:start {seed, lobby, mode:'raid', planet}` to all, every connected member `inMission`; a `planet` in the message replaces `LobbyState.planet`. `mode:'training'`: any member, no ready gating, no planet (ignored if sent), only the sender `inMission` → `game:start {…, mode:'training'}` to all |
| `lobby:planet {planet}` | host only (`not_host`), not started (`started`), known `PlanetId` (`invalid`) → `LobbyState.planet` → `lobby:state` to the lobby (**there is no travel message**: every member plays the cutscene off its own copy). Picking the planet that is already set only echoes the state to the sender. Survives `lobby:reset` |
| `social:get` | → `social:state {social}` (the sender's snapshot, **at once**). No profile → `social:error unavailable` |
| `social:me {level}` | clamp `0 … 999` and store → `social:state` to the sender at once + everyone watching (coalesced) |
| `social:request {code}` | `self` / `not_found` (unknown or malformed 아이디) / `already` (friends or a pending request either way) / `limit` (`SOCIAL_FRIEND_MAX`, `SOCIAL_REQUEST_MAX`) / `invalid` (a code I blocked) → recorded on **both** records → `social:state` to me at once, to them coalesced. **They blocked me** → only my `outgoing` gets it and they get nothing (hidden) |
| `social:respond {code, accept}` | the request must sit in my `incoming` (`invalid`). Accept → both `friends` + both `recent` entries dropped; decline → the request only. `social:state` to me at once, to them coalesced |
| `social:remove {code}` | mutual removal (`invalid` when we are not friends) → `social:state` to me at once, to them coalesced |
| `social:block {code, blocked}` | **2026-09-11 (B-4)**. `not_found` / `self` / `limit` (`SOCIAL_BLOCK_MAX`). Block → friends · requests · recent removed on **both** records, my invite to them `failed`, their invite to me turned hidden (`social:inviteClosed declined` to me only — it ends `expired` for them), both watches rebuilt → my `social:state` (`blocked: SocialCard[]`) at once. Unblock → off my list (+ the request half they sent while blocked). Not blocked → no-op `ok` |
| `social:play {code}` | ① `offline` / `in_mission` / `full` / `my_squad_full` from `playBlockReason`, `invalid` toward a code I blocked; ② the target **has a ship** → `busy` when others are in mine **or I am inside a mission (훈련장 too)**, `in_squad` when it is the same ship → **`moveToLobby`** (atomic) → `lobby:left {reason:'moved', to}` (only if I had a ship) → `lobby:state` → `social:play {outcome:'joined'}`; ③ the target **has no ship** (or blocked me — hidden) → mine is created first when I had none (`lobby:state`; `my_squad_full` when it is full), `openInvite` → `social:invited {invite:{id,…}}` to them, `social:play {outcome:'invited'}` to me |
| `social:inviteReply {id, accept}` | **2026-09-11 (B-3)**. Not mine / closed / hidden → `social:error expired`. `accept:false` → closed `declined` (`inviteResult` to the inviter, no echo to me). `accept:true` → `busy` (others in my ship or I am inside a mission — the invite stays open), the ship gone / inviter left → `not_found`, else `moveToLobby` (`full` / `in_mission` on refusal, invite `failed` with that reason) → closed `accepted`. Already in that ship → closed `accepted` + my `lobby:state` |
| `social:whisper {code, text, nonce?}` | trim + strip markup / control characters + cut to `SOCIAL_WHISPER_MAX` (empty → `invalid`), unknown 아이디 → `not_found`, a code I blocked → `invalid`; connected → `social:whisper {code, name, text, at}` to them (**dropped** when they blocked me); not connected → a **friend** gets it in `SocialRecord.inbox` (only with `nonce`), else `offline`. With `nonce` every outcome is `social:whisperAck {nonce, ok, at?, stored?, code?}` (blocked → `ok:true`); without it the old `social:error` rules. No echo of the line itself |
| `lobby:transferHost {targetId, claim?}` | **분대장 지명 이관 (2026-09-09)**. 허용되는 경우는 둘뿐: ① 보낸 사람이 지금 호스트, ② `claim` 이고 현재 호스트가 `lobby:hostDown` 으로 사망 표시를 켜 두었다. 그 외 `not_host`; `targetId` 가 같은 로비의 **연결된** 멤버가 아니면 `invalid`; 로비 밖이면 `not_in_lobby`. 성공 → `Lobby.transferHostTo` (hostId + 모든 `isHost` 갱신, 사망 표시 해제, `clearMigrate`) → `lobby:state` 방송 + 로그 한 줄. 이미 그 사람이 호스트면 방송 없이 보낸 사람에게만 상태를 되돌린다 |
| `lobby:hostDown {down}` | **호스트 본인만** (`not_host`). `LobbyState` 에 실리지 않으므로 **아무것도 방송하지 않는다**. 호스트가 바뀌면(`migrateHost` · `transferHostTo`) 또는 미션이 끝나면(`reset()`) 자동으로 꺼진다 |
| `lobby:reset` | host only → started=false, seed=null, mode cleared, all ready=false, all inMission=false, raid blobs dropped, **hostDown 해제** → `lobby:state` |
| `lobby:mission {inMission}` | update the sender's `inMission` (`in_mission` when `true` while nothing runs); `false` drops the sender's raid blob and, if the sender was the host, hands the role to a connected in-mission member; `true` claims a parked / out-of-mission host role; a started lobby with nobody left inside is reset → `lobby:state` |
| `profile:get` | → `profile:docs {profile}` (the sender's record) |
| `profile:set {key, doc, at?, fresh?}` | store one opaque document (`invalid` for an unknown key / anonymous id / a non-numeric `at` / a non-boolean `fresh`, `too_large` over `PROFILE_DOC_MAX_BYTES`); **newest wins** — a stamped write is kept only when `at >= docsAt[key]` (clamped to `now + PROFILE_CLOCK_SKEW_MS`), a `fresh` / unstamped write only while the key is absent. A losing write is ignored **silently** (no `lobby:error`) — the client keeps the server copy. No reply on success. **2026-09-11 (E-6)**: the Phase 9 path is unchanged but every accepted write bumps `docsRev[key]`; a frame **with `baseRev`** is a revision write — see the next row |
| `profile:set {key, doc, baseRev, writeId}` (E-6) | revision write (`ProfileStore.writeDocs`, one document): `baseRev` = current `docsRev[key]` (absent = 0) → stored, rev + 1, `docsAt[key]` = server now → **`profile:ack {writeId, revs}`**; another rev → **`profile:conflict {writeId, docs: {key: {rev, doc}}}`** (`doc` null when the server has none), nothing stored; bad key / malformed `baseRev` / anonymous → `profile:refused {writeId, code: invalid}`; over `PROFILE_DOC_MAX_BYTES` → `refused too_large`. A resend of an accepted `writeId` (last 16 per profile, memory only) → the same ack again. Never `lobby:error`, never silent |
| `profile:setMany {txId, docs: {key: {doc, baseRev}}}` (E-6) | several documents, **all or nothing**: every entry is validated and every `baseRev` checked first → `profile:ack {txId, revs}` / `profile:conflict {txId, docs}` (every mismatching key) / `profile:refused {txId, code}` (a bad entry → `invalid`, one document over `PROFILE_DOC_MAX_BYTES` or all over `PROFILE_SETMANY_MAX_BYTES` → `too_large`). The only frame allowed up to `MAX_TX_FRAME_BYTES` (the socket's `maxPayload`) |
| `credits:tx {txId, delta, reason}` | atomic, **validated** credits transaction (2026-09-11, E-4 — `Store.applyCreditsTx` + `Economy.ts`) → `credits:result {txId, ok, credits, reason?}`: `reason` must parse (`parseCreditReason`) and `delta` must fit its rule against `economy.gen.json` + the profile's ledger, else `ok:false, reason: CREDIT_TX_INVALID_KO` (`서버가 거래를 확인하지 못했습니다`, nothing changes; the relay log gets the English `why`); `크레딧 부족` when the balance would go below 0; a credit is capped at `CREDITS_MAX`; `migrate` only while the balance is null (once, clamped). Anonymous → `ok:false` |
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
- **푸시 채널**: `broadcast()` only reaches a lobby, so a `watchers` index (subject → connected clients that have the
  subject in **any of their four lists** since 2026-09-11 — friends · incoming · outgoing · recent — plus its reverse
  `watching`) carries `social:state` to everyone a change concerns — on connect, disconnect (and a member's socket
  dropping inside a lobby), lobby join / leave / move, `lobby:mission`, mission start / reset and `lobby:planet`.
  Nothing polls; the index is rebuilt for both sides after every list change (request · respond · remove · block ·
  최근 만난 플레이어 · GC) and dropped in `close()`. Pushes are coalesced — see `소셜 서버` below.
- **최근 만난 플레이어**: recorded on both records the moment two profiles share a ship (join / quick match / 같이 하기),
  newest first, never for friends, capped at `SOCIAL_RECENT_MAX` and cleared when the two become friends.

## 소셜 서버 (2026-09-11, B-6 · B-3 · B-5 · B-4)

- **원자적 이동 (B-6)**: 참가 가능 판정은 `Lobby.canAdd()` **하나**이고 `add` 도 그것을 부른다. `LobbyManager.move` 가
  대상을 **먼저** 검사하므로 거절되면 내 배는 그대로다 (예전 `social:play` ② 는 떠난 뒤 참가해서, 두 검사가 갈라지는 날
  배를 잃었다). 릴레이의 `moveToLobby` 가 옛 로비에 평범한 leave 를 알리고 나에게 `lobby:left {reason:'moved', to}`
  (옮기기 전에 배가 있었을 때만) → 곧바로 새 `lobby:state` 를 보낸다. 호출자가 미션(훈련장 포함) 안이면 `busy`.
- **초대 표 (B-3)**: `InviteTable` 이 메모리에 든다(서버가 꺼지면 로비도 없다). `(from, to)` 쌍마다 하나 — 새 초대가
  옛것을 `superseded` 로 닫는다 — 이고, 받는 사람당 보이는 초대는 `SQUAD_INVITE_MAX` 개(넘치면 가장 오래된 것이
  `failed` / `limit`). **닫히는 길은 전부 `closeInvite`** 하나: 보낸 사람 `social:inviteResult {id, code, name, outcome,
  reason?}` + 배지 push, 받은 사람 `social:inviteClosed {id, outcome, reason?}`(자기 응답 · 숨은 초대에는 안 보낸다).
  `accepted`(서버가 이동 · 옛 클라이언트의 `lobby:join` 도 그 배로 들어오면 답한 것으로 친다) · `declined` · `expired`
  (서버 타이머, `inviteTtlMs`) · `failed`(`sweepInvites` — 배가 없어짐 / 보낸 사람이 떠남 `not_found`, 가득 참 `full`,
  레이드 시작 `in_mission`; leave · 유예 만료 · kick · join · 빠른 매칭 · 이동 · 시작 뒤에 돈다) · `offline`(받는 사람 소켓이
  진짜로 끊김 — 새로고침으로 **교체된** 소켓은 아니다) · `superseded`. 접속 · 새로고침한 받는 사람에게는 열린 초대를 같은
  `id` 로 **다시 보낸다**. 보낸 사람의 행에는 `SocialPlayer.inviteAt`.
- **푸시 합치기 (B-5)**: 모든 push 가 `PushCoalescer` 를 지난다 — 표시만 하고 `SOCIAL_PUSH_COALESCE_MS`(250) 창이 닫힐 때
  viewer 마다 스냅샷 한 번. 요청자 본인의 답(`get` · `me` · `request` · `respond` · `remove` · `block` · 내가 보낸 초대의
  배지)은 `pushSocialNow` 로 즉시 가고 표시에서 빠진다. 4인 분대 시작 → 공통 친구 1개(예전 4개), `lobby:mission` 10번 → 1–2개.
  watch 는 네 목록 전부 — 최근 만난 플레이어 · 요청 행의 접속 상태도 실시간이다.
- **차단 (B-4)**: `SocialRecord.blocked`. 차단당한 사람이 나에게 하는 것은 **조용히 삼킨다** — 귓속말은 버리고 ack `ok:true`,
  친구 요청은 그쪽 outgoing 에만(해제하면 지운다, 아니면 B-2 GC 가 30일 뒤), 초대는 카드를 안 보내고 그쪽엔 TTL 뒤
  `expired`, 같이 하기로 **내 배에 들어오는 것**(②)도 숨은 초대(③)로 바뀐다. 거꾸로 내가 차단한 상대에게 보내는 요청 ·
  같이 하기 · 귓속말은 `invalid`(UI 가 먼저 막는다 — 해제가 먼저).
- **차단과 분대 참가 (B-11, 2026-09-11, 사용자 결정)**: 로비 코드로 직접 들어오는 것도 막는다. 판정은 `RelayServer` 의 헬퍼
  하나(`blockRefusal(lobby, joiner)` → `'blocked' | 'not_found' | null`, 그 밑에 한 쌍짜리 `blocks(owner, other)`)이고
  **방향이 답을 정한다** — 내가 차단한 사람이 그 분대에 있으면 `lobby:error blocked`(내 선택이니 정직하게), 나를 차단한
  사람이 있으면 `not_found`(차단이 드러나면 안 되므로 **코드 오타와 구별되지 않는 것이 노림수**). 둘 다면 내 방향이 이긴다.
  검사는 `lobbies.join` **앞**이라 거절이 로비 상태를 건드리지 않고, `quickmatch` 는 거절 대신 그 로비를 후보에서 뺀다
  (`LobbyManager.findQuickMatch(accept?)` · `quickMatch(id, name, accept?)`). 아이디(social record)가 없는 익명 접속은
  차단할 수도 당할 수도 없으므로 그대로 통과한다. `social:play` 의 양방향 검사도 같은 `blocks` 를 쓴다(동작 불변).
  **범위 밖**: 이미 같은 분대에 있는 사람을 나중에 차단해도 강퇴하지 않는다 — 채팅 · 말풍선은 클라이언트가 숨긴다.
- **전송 확인 · 오프라인 보관 (B-4)**: `social:whisper {nonce}` → `social:whisperAck`. 받는 사람이 오프라인 **친구**면
  `SocialRecord.inbox` 에 보관(받는 사람당 `SOCIAL_WHISPER_INBOX_MAX` 20줄 · `SOCIAL_WHISPER_INBOX_TTL_MS` 7일, 프로필 파일에
  들어가므로 B-2 GC 가 함께 치운다) → ack `stored:true`, 다음 접속 welcome 직후 `social:whisperBacklog {lines}` 한 번 뒤 비운다.
  `nonce` 없는 옛 클라이언트는 예전 규칙(오프라인이면 `social:error offline`, 보관 안 함).

### Known follow-ups
- ~~The watcher index tracks friends only~~ → 2026-09-11 (B-5): all four lists.
- A social record is created for **every** token connect (that is what makes an offline friend findable by 아이디).
  ~~no expiry or GC~~ → 2026-09-11 (B-2): profiles unseen for 90 days are collected, see `프로필 GC` above.
- ~~`my_squad_full` is reported as `full`~~ — the handler has sent `my_squad_full` since the contract grew that code.
- ~~`social:play` ② is not atomic~~ → B-6 · ~~`social:invited` is fire-and-forget~~ → B-3 · ~~no delivery receipt / no block
  list~~ → B-4 · ~~presence is not coalesced~~ → B-5 (all 2026-09-11, `소셜 서버` above). History of a conversation is
  client-side (`net/SocialSync`), not here. `sanitizeWhisper` strips `<`/`>` exactly like `sanitizePlayerName` (`<b>` reads `b`).
- The 아이디 is derived from the **session token**: clearing browser storage produces a new profile and a new 아이디,
  and friends keep the old (now unreachable, still indexed) code in their lists until they remove it.
- An invite to a lobby is failed when it **fills**; a slot freed a moment later does not reopen it (the inviter sends a new one).
- Open invites and the coalescing timer are per process: a relay restart drops them (the lobbies go with it).
- A blocked player's 같이 하기 toward the blocker still answers the presence gates (`offline` / `in_mission` / `full`) —
  the same any typed 아이디 gets; only the block itself is hidden.

## 문서 리비전 (2026-09-11, E-6)

사용자 결정 "리비전 전체". 설계는 `docs/plans/net-social-trust.md` §7. 토큰 = 브라우저 저장소라 **한 프로필의 작성자는
하나**다 — 그러니 "누구 시계가 늦나" 가 아니라 **"내가 본 판 위에 쓰는가"** 만 묻는다.

- `ProfileRecord.docsRev[key]` — 받아들인 쓰기마다 +1 (옛 `at` 쓰기도 올린다: 리비전 클라이언트가 그 뒤에 옛 판으로 쓰면
  충돌이 난다). 파일에 그대로 저장되고, 로드 때 **rev 없는 기존 문서는 1 로 시드**, 문서 없는 rev · 음수 · 문자열은 버리거나 1.
- `snapshot()` 은 `docsRev` 를 **늘** 싣는다(`{}` 라도) — 클라이언트는 그 존재로 "리비전을 아는 릴레이" 를 알아본다.
  옛 릴레이(= `docsRev` 없음)에는 클라이언트가 Phase 9 프레임을 보낸다.
- `ProfileStore.writeDocs(id, writeId, entries)` 가 단일 · 트랜잭션 공용이다: ① 기억한 id → 그대로 ack(replay) ② 모양 ·
  크기 검사 → `refused` ③ rev 전부 비교 → `conflict`(불일치 키 전부) ④ 전부 저장. **충돌 · 거절은 자리표시 프로필을 만들지 않는다.**
- 쓰기 id 기억은 **메모리뿐**(프로필당 16). 릴레이가 재시작되면 재전송은 `baseRev` 로 다시 판정되고, 클라이언트는
  welcome 사본(rev = base + 1 · 같은 문서)에서 자기 쓰기를 알아본다(`net/ProfileSync`).
- `stale` 무음 규칙은 `baseRev` 없는 **옛 프레임에만** 남는다.
- 검증: `selftest.ts` part 11(`part11ProfileRevisions` — 소켓 17 + 저장소 7 단언, part 5 · 7 에 한 줄씩).

## 서버 크레딧 검증 (2026-09-11, E-4)

사용자 결정 "서버 크레딧 검증까지" · "사유별 규칙 + 표 상한" · migrate "상한 CREDITS_MAX 로 1회". 계약은
`src/shared/credits.ts`(사유 문법 · `EconomyTable` · `CreditLedger` · 창 · 상한), 설계는 `docs/plans/net-social-trust.md` §5.

예전 릴레이는 `credits:tx` 의 `delta` 를 그대로 받았다(0 밑만 거절). 이제 `reason` 을 해석하고 금액을 표로 잰다:

| 사유 | 받는 조건 |
|---|---|
| `buy:<defId>` | `delta < 0` 이고 `−delta ≥ tableMinBuyPrice` (최고 신뢰도 레벨의 할인가 — 어느 레벨에서 사도 그 이상이다) |
| `sell:<defId>:<qty>` | `1 ≤ qty ≤ stack`, `0 < delta ≤ tableSellPrice(value, qty)` (= 게임의 `sellPriceOf` 반올림 그대로) |
| `refund:<defId>` | `0 < delta ≤` 원장에 있는 **창(`CREDIT_REFUND_WINDOW_MS` 60 s) 안의 미환불 `buy:<defId>`** 잔액 — 부분 환불은 합산, 이중 환불은 거절 |
| `repair:<brokenId>` | `delta === −수리비` (`implantRepairFee(repairsTo)`) |
| `refund:repair:<brokenId>` | 창 안의 미환불 `repair:<brokenId>` 짝 |
| `contract:<id>` | `delta === contracts.csv 보상`, 프로필당 한 시간에 `CREDIT_CONTRACT_MAX_PER_HOUR`(12)회 |
| `quest:<id>` | `delta === quests.csv 보상`, 퀘스트 id 당 **1회** (원장에 영구히) |
| `migrate` | 잔액이 **null** 일 때만 1회, `[0, CREDITS_MAX]` 로 clamp. 두 번째는 거절 (예전: 조용한 no-op) |
| `console` · `smoke:*` · `e2e:*` · `shot` | `devEconomy` 릴레이에서만 (`SCAV_DEV_ECONOMY=1` — **스모크 러너가 스스로 띄우는 릴레이뿐**: `verify.mjs` 의 릴레이. `npm run dev:all` · `start-server.bat` · `npm run server` · 배포 exe · 데스크톱 셸은 전부 끔). 금액 규칙 없음, 0 밑은 여전히 `크레딧 부족` |
| 그 밖 | 거절 |

- **거절 문구**는 `CREDIT_TX_INVALID_KO` 다 — `credits:result.reason` 은 처음부터 클라이언트가 그대로 보여 주는 한국어였다
  (`크레딧 부족`). 계약 주석의 `'invalid'` 는 이 문구를 가리킨다. 로그에는 영어 `why` 가 남는다.
- **원장**(`ProfileRecord.ledger`, 서버 내부)은 `snapshot()` 에 실리지 않고 `profiles.json` 으로 왕복하며 로드 때
  `sanitizeLedger` 가 정리한다(잘못된 항목 · 미래 시각 · 창 밖 debit · 한 시간 넘은 계약 도장 · 상한). 잔액이 실제로 바뀐
  트랜잭션만 적힌다 — `크레딧 부족` 으로 거절된 구매는 debit 을 남기지 않는다. 핸들러가 동기라 check → apply → commit
  사이에 다른 트랜잭션이 끼지 않는다.
- **양수 트랜잭션은 `CREDITS_MAX` 에서 멈춘다** (`applyCredits(…, max)`): 클라이언트의 `applyCreditsLocal` 이 원래 그 값으로
  잘랐으므로 서버 잔액만 넘어서 화면과 어긋나던 틈을 닫았다. 이미 넘은 옛 잔액을 깎지는 않는다.
- **표**는 `server/economy.gen.json` 이고 `npm run data:check -- --write` 가 **클라이언트와 같은 모듈**(`src/items` 의
  `ItemDef.value` · `stackMax`, `meta/Rules` 의 수리비, `shared/meta` 의 계약 · 퀘스트 · 가격 상수)로 만든다. 릴레이는
  Vite csv 로더를 못 돌리고 `value` 는 `items/` 가 파생하므로 규칙을 서버에 다시 적지 않는다. csv 를 고치고 표를 안 다시
  만들면 `data:check` 가 실패하고, 매 검사마다 표의 가격 식이 게임과 **모든 아이템 × 모든 신뢰도 레벨 × 모든 수량**에서
  같은지 · 상점이 파는 물건이 전부 표에 있는지 · 모든 사유가 64자 안에서 문법을 왕복하는지 검산한다.
- **검사하지 않는 것**(사용자 수용, 계획서): 그 아이템을 정말 갖고 있었는가. 창고 · 로드아웃 문서가 클라이언트 쓰기라
  서버가 비교해도 증명이 안 된다. 구매는 싸게 사는 것만, 판매는 비싸게 파는 것만 막는다.
- **dev 사유**: `server/index.ts` 만 환경변수를 읽는다. 배포 exe(`tool.ts`)와 데스크톱 셸의 임베디드 릴레이(`electron/`)는
  옵션을 넘기지 않으므로 늘 꺼져 있다 — `scripts/smoke-server-dist` 가 번들로 확인한다.

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

- **2026-09-11 (B-11 차단 · 분대 참가, 에이전트 ④)** — 위 `소셜 서버` 의 `차단과 분대 참가`. `RelayServer.ts`: `recordMet` 옆에
  `blocks(owner, other)` (아이디로 재는 한 쌍) + `blockRefusal(lobby, joiner)` → `'blocked' | 'not_found' | null`, `lobby:join`
  이 `lobbies.join` **앞에서** 그것을 묻고(이미 로비에 있는 사람은 예전대로 `in_lobby` 가 먼저다), `lobby:quickmatch` 는
  `accept` 술어로 넘기며, `social:play` 의 양방향 차단 두 줄이 같은 `blocks` 를 부른다(동작 불변). `Lobby.ts`:
  `findQuickMatch(accept?)` · `quickMatch(id, name, accept?)` 후보 술어. 계약은 리드 커밋 그대로 — `LobbyErrorCode.blocked`
  + `LOBBY_ERROR_MESSAGE_KO.blocked`. `selftest.ts` part 8c 에 **7 checks**(내가 차단 → `blocked` + 로비 무변경 · 나를 차단 →
  `not_found` + 로비 무변경 · 거절이 멤버에게 `lobby:state` 를 내지 않음 · 차단 없는 참가는 그대로 · quickmatch 가 내가
  차단한 공개 로비를 건너뛰고 새로 만듦 · 반대 방향도 건너뛰어 다른 공개 로비로 · 전부 걸러지면 새 로비). **480/480**.
  **범위 밖**: 이미 분대에 있는 사람을 나중에 차단해도 강퇴는 없다.

- **2026-09-11 (E-6 문서 리비전, 에이전트 ③)** — 위 `문서 리비전` 절. `Store.ts`: `sanitizeRecord` 가 `docsRev` 를 시드 · 정리,
  `snapshot` 이 `docsRev` 를 늘 싣고, `setDoc`(옛 경로)도 rev 를 올리고, 새 `writeDocs` · `revOf` · `RevWriteResult` ·
  `PROFILE_WRITE_ID_MEMORY` · `PROFILE_WRITE_ID_MAX`. `RelayServer.ts`: `profile:set {baseRev, writeId}` 파싱(잘못된 `baseRev` 는
  -1 로 핸들러까지 가서 id 붙은 `refused`), `profile:setMany` 파싱 · 핸들러, 응답 한 곳 `replyProfileWrite`, 새 `MAX_TX_FRAME_BYTES`
  (= `PROFILE_SETMANY_MAX_BYTES` + 16 KB)가 소켓 `maxPayload` — 그보다 큰 프레임은 여전히 `setMany` 만 허용. selftest part 11.

- **2026-09-11 (E-4 서버 크레딧 검증, 에이전트 ⑦)** — 위 `서버 크레딧 검증` 절. 새 `Economy.ts` + 생성 파일 `economy.gen.json`
  (JSON import — `tsconfig.json` 에 `resolveJsonModule`, `electron/tsconfig.json` 도 같은 한 줄). `Store.ts`: `applyCreditsTx`
  (검증 + 원장 commit) · `ledgerOf` · `sanitizeRecord` 가 `ledger` 를 보존 · `applyCredits(…, max?)` 의 `CREDITS_MAX` 상한.
  `RelayServer.ts`: `credits:tx` 가 `applyCreditsTx` 를 부르고 거절 로그에 `why`, 옵션 `devEconomy` · `economyTable`, 시작 로그 한 줄
  (`economy table <hash> · N items · dev reasons ON/off`). `index.ts`: `SCAV_DEV_ECONOMY` / `--dev-economy`. `tool.ts` 무변경(끔).
  `selftest.ts`: part 5 의 credits 단언을 표의 실제 id 로(`buy:test` · 맨 `sell` → 표 아이템, 두 번째 `migrate` 는 거절) +
  **part 12** 34 checks(표 로드 · digest · 최저가 · 문법 왕복 / 쓰레기 사유 · buy · sell · repair · contract · quest 금액 수락 / 부호 ·
  과다 · 과소 · 모르는 id 거절 · refund 짝(창 밖 · 다른 아이템 · 부분 환불 합산 · 이중 환불) · refund:repair 짝 · quest 1회 ·
  contract 시간당 상한과 재개방 · migrate null 1회 + clamp · dev 사유 on/off · `devEconomyFromEnv` · `sanitizeLedger` 정리 + 상한 ·
  원장 파일 왕복 + 재시작 뒤 환불 짝 · snapshot 비노출 · 와이어(dev 끔: clamp · 두 번째 migrate · 상한 · 정상 흐름 · 거절 문구 ·
  profile:docs 비노출 · 재접속 뒤 quest 유지 / dev 켬: smoke · e2e 수락 + 부족 · 나쁜 buy 거절)). `scripts/smoke-server-dist`
  +3(표가 번들에 인라인 · 정상 사유 수락 · 배포 exe 가 dev 사유 거절).

- **2026-09-11 (B-6 · B-3 · B-5 · B-4 소셜 서버)** — 위 `소셜 서버` 절. `Lobby.canAdd` · `LobbyManager.move`, 새 `Invites.ts`
  (`InviteTable` · `PushCoalescer`), `Store.ts` 소셜 절(`blocked` · `inbox` 정화, `setBlocked` · `isBlocked` ·
  `pushWhisperInbox` · `takeWhisperInbox`, 차단 시 요청 삼킴 · 고아 요청 정리, `recordMet` 차단 쌍 제외, GC 가 끊긴 차단 · 만료
  보관을 치움), `RelayServer.ts` 소셜 · 로비 이동(`announceLeave` / `moveToLobby`, 초대 표 · `sweepInvites`, 네 목록 watch +
  합치기, `social:inviteReply` · `social:block` · `whisper.nonce` 파서 · 핸들러, welcome 직후 backlog + 열린 초대 재전송,
  소켓 끊김 → `offline`, 옵션 `inviteTtlMs` · `socialPushCoalesceMs`). 계약은 커밋 `9bd72ce` 그대로 — shared 추가 없음.
  `selftest.ts`: part 8 의 `같이 하기 ②` 단언을 `lobby:left {reason:'moved', to}` → `lobby:state` → `social:play` 순서로,
  "친구 삭제 뒤 push 없음" 단언을 P1 혼자의 변화(`social:me`)로 갱신(이제 P2 가 최근 목록으로 P3 를 watch 한다), 새
  **part 8c** 64 checks — B-6 단위(`canAdd`==`add` 가득 · 시작 · 훈련, 가득 · 시작 · 사라짐 · 같은 로비일 때 이동 거절 + 내 로비
  그대로, 성공 이동) · B-4 단위(차단 캡 · 맨 앞 이동 · self · 보관 캡 · TTL · 한 번 전달 · 파일 왕복 · GC · 정화) · B-3 릴레이
  (id · 배지 · 수락 이동 + 결과 + 에코 없음 · 배지 해제 · 닫힌 초대 `expired` · 거절 · TTL 만료 · superseded · 새로고침 재전송 ·
  해산 `failed not_found` · `offline` · 옛 클라이언트 `lobby:join` · 분대 중 `busy` + 유지 · 혼자 탄 배에서 수락 → `moved` · 마지막 칸을 채우는 수락은 `accepted` · 가득 참
  `failed full` · 받는 사람당 캡) · B-6 릴레이(가득 찬 배 → `full` + 내 배 유지 · 훈련 중 `busy`) · B-5(최근 목록 오프라인/복귀 push ·
  요청 대상 push · 본인 응답 즉시 + 중복 없음 · 4인 시작 → 1개 · 토글 10번 → 1–2개) · B-4 릴레이(양쪽 정리 · 초대 닫힘 · 귓속말 /
  요청 / 초대 / 같이 하기 삼킴 · 숨은 초대 `expired` · 내가 차단한 상대 `invalid` · 해제 + 고아 요청 정리 · 보관 → backlog 1회 ·
  비친구 `offline` · 옛 프레임). **473/473** (③ · ⑦ 의 part 11 · 12 포함 시점).

- **2026-09-11 (B-2 프로필 GC)** — `ProfileStore.touchSeen` · `collectGarbage` → `ProfileGcReport`, `PROFILE_GC_INTERVAL_MS`,
  `sanitizeRecord` 가 `seenAt` 을, `sanitizeSocial` 이 `requestsAt` 을 보존(옛 요청은 로드 시각 도장), `addFriendRequest` /
  `respondFriendRequest` 가 요청 도장을 쓰고 지운다. `RelayServer`: 접속 · 해제 때 `touchSeen`, 시작 시 1회 + 6시간 주기
  (`profileGcIntervalMs`), `RelayServer.collectGarbage(now?)` (접속자 · 로비 멤버 보호, 바뀐 접속자에게 `social:state` + `rewatch`).
  `tool.ts` 콘솔 `gc`. 위 `프로필 GC` 절. `selftest.ts` **part 8b** 18 checks(삭제 · 창 안 유지 · keep 보호 · 끊긴 아이디 정리 +
  보고 · 같은 토큰 재접속 · 멱등 · `seenAt` 비노출 · 요청 양쪽 같은 도장 · 요청 · 최근 만료 · 응답이 도장 삭제 · 옛 요청 로드 도장 ·
  미래 `seenAt` clamp · 옛 레코드 판단 + `seenAt` 굳힘 · 남의 요청이 수명을 안 늘림 · 파일 왕복 · 해제가 `seenAt` 기록 · 릴레이 keep ·
  온라인 친구 즉시 push). **349/349**. `scripts/smoke-server-dist` 에 `gc` 명령 1줄(33/33).
- **2026-09-11 (C-29 · C-41 · X-2)** — 서버 콘솔(`listClients` · `kick` · `setMaxClients`, `CLOSE_KICKED` 4002 ·
  `CLOSE_SERVER_FULL` 4003, `/health.maxClients`, `tool.ts` readline `list` · `lobbies` · `kick` · `max` · `help` + `--max`),
  저장소 비동기 쓰기 + fsync + `.bak` 세대 + 손상 파일 보존 · 복구, `index.ts` 의 `--data` / `SCAV_DATA_DIR`. 위 절.
  `selftest.ts` 에 **part 7b**(비동기 쓰기 · 쓰는 중 변경 · close 가 이김 · tmp 잔여 없음 · 손상 → `.bak` 복구 · 원본 보존 ·
  main 없는 `.bak` · `.bak` 없는 손상) + **part 10**(list · 아이디로 kick · 4002 · 즉시 `peer:left` + 호스트 이관 ·
  not_found · 재접속 허용 · 유예 멤버 kick · `server_full` 4003 · `/health` · 소켓 교체 예외 · 유예 멤버 재접속 예외 ·
  거절된 토큰은 레코드를 안 남김 · 제한 해제). **331/331**.
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
