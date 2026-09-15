# Multiplayer contract (host-authoritative, up to 4 players)

Split out of [CLAUDE.md](../CLAUDE.md). Every wire type lives in [`src/shared/net.ts`](../src/shared/net.ts) (drones in
`src/shared/drones.ts`), and the server imports only that. Per-folder detail: [src/net](../src/net/README.md) ·
[server](../server/README.md) · [src/enemies](../src/enemies/README.md) · [src/hub](../src/hub/README.md) · [src/player](../src/player/README.md)

---

## 1. Base contract

- **Topology**: browser clients ↔ Node WebSocket relay (`server/`). The lobby **host** simulates enemies, extraction and other
  shared world state; every client simulates its own player only. `ctx.isAuthority` (single-player OR host) gates simulation;
  `ctx.isMultiplayer` gates networking. The relay is opaque to game messages (`relay`) and authoritative only for lobbies,
  profiles, social, rooms, credits and crypto prices. Constants: `NET_*` in `src/shared/net.ts` (`NET_MAX_PLAYERS`, rates, delays).

- **Players**: `PlayerSnapshot` (`ps`, `NET_PLAYER_SNAPSHOT_HZ`: pos/vel/yaw/pitch/stance/flags/hp/shield/weapon/stride, plus
  optional `hs` ship id, `bfr` buff revision, `fp`/`fu` furniture pose) → `NetSystem` interpolates with `NET_INTERP_DELAY` + short
  extrapolation → `player/RemotePlayerSystem` drives a slot-coloured `SoldierModel` (`RemoteAvatar`), `weapons/RemoteWeapons`
  replays fire/reload/grenade FX, `ui/hud/Nameplates` + `Squad` + `MapScreen` show them. Omitted optional fields mean "unknown",
  never 0 — receivers fall back (e.g. shield restores to max).

- **Enemies**: host broadcasts `es` (`NET_ENEMY_SNAPSHOT_HZ`, a **delta** stream with a keyframe every `NET_ENEMY_KEYFRAME_S`)
  + `ee` events (spawn/kill/despawn/damaged/attack/acid/shell/corpse/grenade/named/worm …); clients run replicas (no AI) with interpolation. Client
  shots hit replica hitboxes locally → `hit` to host → host applies damage → `hitc` back (hitmarker + kill credit).
  Explosions → `explode`; status effects ride `hit.st` (bits of `ENEMY_STATUS_BITS`); shell intercepts → `intq`. Client bullets report to the host with `shotq` (enemy alerting). AI targets any
  player (`enemies/Targets.ts` `CombatTarget`); remote victims get `dmg` (with damage source `src`) via `ctx.net.send(..., peerId)`.

- **Extraction**: host owns the countdown, idle timer and departure grace and broadcasts `ex`
  (`activated` · `tick` · `shipIncoming` · `shipLanded` · `boarding` · `wait` · `depart` · `liftoff {riders, squadDone}` · `reset` · `sync`);
  clients send `exq` (`activate` · `board` · `liftoff` · `sync`). Liftoff takes **only riders who are aboard and alive**; the rest
  keep playing. Full table: [src/extraction/README.md](../src/extraction/README.md).

- **Flow** (`flow`): `game:paused {freeze:false}` in multiplayer (menu only, the world keeps running). A dead player spectates
  (`ui/hud/SpectateOverlay`). Host sends `flow over` on a squad wipe, `flow complete` when everyone left aboard, `flow abort` when
  the host aborts; `flow takeover` after a host change makes clients re-sync; `flow rejoined` answers a rejoin.

- **Pickups** (`item`/`itemq`): host-authoritative, ids `${peerId}-${n}`, client drops are optimistic and echoed by the host.
  **Containers** (`cont`/`contq`): contents are deterministic from the seed, the **taken state** is host-authoritative; player
  corpses are containers with id `pcorpse:<owner>:<n>` and ride the same path. **Opened look** of crates/containers: `crate`.
- **Empty corpses** (2026-09-16): a corpse with no items sinks after `CORPSE_EMPTY_REMOVE_DELAY_S` and is removed on every
  client. Player / android corpses: an empty spawn wire is judged locally by everyone; a looted-empty one is judged by the host
  (it primes a container for every `pcorpse` wire, `'all'` echoes to the sender) → `pcorpse emptied` to others, accepted only
  from the host; host `pcorpse sync` omits emptied corpses and removed ids never re-spawn. Enemy corpses (contents rolled per
  client): the emptier's `crate:looted` → `ecorpseq emptied` to the host (shape → sender → distance → rate) → `ee corpseEmptied`
  → every client shortens that body's `corpseLife`; the usual `despawn` / `corpseGone` follows.
- **Chat**: `chat {text, kind}` relayed to others, also in the hub. **Pings**: `ping {p, kind, label?, enemyId?}` + `pingack`.
  **Comms wheel**: `comm`.

### Message families and owners

| Family | Direction | Owner |
|---|---|---|
| `ps` · `fire` · `reload` · `grenade` (`fire` flag for G-10) · `melee` · `died` · `fall` | peer → others | player / weapons |
| `es` · `ee` · `hit` · `hitc` · `explode` · `intq` · `dmg` · `shotq` · `ecorpseq` | host ↔ clients | enemies |
| `ex` · `exq` | host ↔ clients | extraction |
| `strat` · `stratq` (`call` via host, `deny` refunds cooldown) · `rescue` · `pod` | host ↔ clients | stratagems / player |
| `gad` · `gadq` · `imp` · `buff` · `revive` · `harv` · `harvq` | mixed (see types) | gadgets / implants / player / world |
| `drone` · `droneq` | **owner** ↔ others | gadgets/drones |
| `ghost` · `ghostq` · `raid:save` | host ↔ clients / server | game / net |
| `pcorpse` · `pcorpseq` · `lead` · `leadq` · `fog` · `fogq` | host ↔ clients | game / world |
| `struct` · `structq` · `tram` · `tramq` · `hz` · `hzq` · `rdrop` · `rover` · `roverq` | host ↔ clients | world / enemies |
| `meta` · `metaq` | peer ↔ peer | meta |
| `crew` · `crewq` · `ship` · `shipq` · `carry` · `plate` · `plateq` · `cbuf` · `cbufq` | peer ↔ peer | net / hub / player |
| `ally` (host → all) · `allyq` (member → host) | host ↔ clients | allies |
| `load` (`p` progress → others, `go` from the host) | peers ↔ host | game |

## 2. Ship hub & reconnection

- Title `게임 시작` → `hub:enter personal` (hub calls `ensureConnected`; a token still in a lobby resumes straight into the shared ship).
  2026-09-15: a character whose squad raid is still running (local `SQUAD_RAID_MARK_KEY` marker) connects **on the title** instead
  and gets `이어하기` / `레이드 포기` there (`game/parts/Resume`); see Socket drop below.
- **Squad ≠ shared ship** (2026-09-15). A lobby carries `LobbyState.docked` (always sent by the relay; absent = older server = docked,
  read it through `isDockedLobby`). Only the shared ship is at world origin (every client builds identical geometry, so hub snapshots
  line up); an undocked squad's members stay in their own personal ships.
- **Invites make squads**: `social:play` is invite-only. With no lobby, the sender becomes leader of a new private **undocked** lobby at once;
  the invitee joins only by accepting (`social:inviteReply`, atomic move). Refusals: `in_squad` (already mine) · `offline` · `in_mission` ·
  `my_squad_full` · `in_other_squad` (target in a squad of 2+) · `not_leader` (I am a member, not the leader) · `busy` (my raid is running).
  The relay dissolves an undocked, not-started lobby left with one member and no open invite into it (`lobby:left` without a reason) —
  after any invite close, leave, grace expiry, kick, move out or resume; a disconnected sole member is left to its grace timer.
- **Docking** (터미널 > 매칭): `lobby:dock {isPublic}`. No lobby → private: a new docked private lobby; public: the quick-match path.
  Leader of an undocked squad → private: docked + private; public + alone: moved into an open public docked ship when there is one
  (`lobby:left {reason:'moved', to}` then its `lobby:state`; invites into the old squad then fail), else its own lobby docks public;
  public with 2+ members: its own lobby docks public — **squads never merge**, only lone players fill free public slots. Member → `not_host`,
  started → `started`, already docked → `in_lobby`. The player who pressed it plays the docking cutscene at once; the others count down
  `HUB_SQUAD_DOCK_COUNTDOWN_S` first (a member accepting into an already docked lobby also counts down).
- **Undocked squads refuse** `lobby:ready`, `lobby:start` (raid and training) and `lobby:mission {inMission:true}` with `not_docked`;
  `lobby:planet` · `lobby:intel` · `lobby:transferHost` · `lobby:leave` · `lobby:look` still work. Once docked, `lobby:leave` (도킹 해제)
  takes out only the sender. Quick match (`lobby:quickmatch`, `lobby:dock` public) never picks an undocked lobby.
- Old paths `lobby:create` · `lobby:join` · `lobby:quickmatch` still create / join docked lobbies (smokes, older clients).
- **Accent**: `?a=<#rrggbb>` (`NET_ACCENT_PARAM`) on connect and `lobby:look {accent}` set `LobbyPlayer.accent` (`sanitizeAccent`, invalid
  ignored); only the 매칭 탭 portraits read it — in-raid avatars keep slot colours.
- Launch pod: boarding ≠ ready. Ready = `setReady(true)`; all connected members ready → countdown → host `startGame(seed)` →
  `lobby:start {seed, mode, planet, intel}` → server `game:start`.
- **Planet**: `LobbyState.planet` is set **by the host only** (`lobby:planet`); every member runs the warp from its own `lobby:state`
  (no separate move message). Starting a raid with no planet is refused with `no_planet` (training exempt); the destination
  survives `lobby:reset`. **Intel** (`lobby:intel`, host only) is echoed in `LobbyState` and restored on rejoin.
- **Hangar visits**: squad members' personal ships dock behind the shared ship and can be walked into. `ship state`
  (`ShipVisitWire` — room purposes, facility levels, placed furniture, shelved media, toggles) is sent to `others` on arrival and
  on change (debounced); `shipq state` requests it (cooldown, immediate reply). Stash, presets and dex are not sent — visits are
  look-only. Entering a ship **changes no lobby state**. Interiors are built at world origin, so `PlayerSnapshot.hs` says which ship
  a player is in (`null` = shared deck); avatars with a different value are not drawn.
- **Socket drop**: the server keeps the slot for `NET_RECONNECT_GRACE_MS` (`connected=false`); the client reconnects with
  `NET_RECONNECT_BACKOFF_MS`. Same mission still running → `net:resumed {seamless:true}` (the host keeps authority through its own
  short drop). Page reload → `welcome` answered with `lobby:mission {inMission:false, keep:true}` (the relay **keeps** the raid
  blob), and the title offers `이어하기` (`rejoinMission()` straight from the title) or `레이드 포기`; a pod still rejoins from the
  ship (world by seed, enemies from a full `es`, then the `*q sync` requests: `exq`, `itemq`, `stratq`, `pcorpseq`, `leadq`,
  `fogq`, `hzq`, `structq`, `tramq`, `metaq` …).
- **Abandon (표류)**: `lobby:abandon` from a member of a started raid → `LobbyPlayer.drifted`, `inMission:false`, blob dropped,
  host handed off / empty mission reset, `lobby:state`. The abandoning client first sends its own `pcorpse spawn` (items from the
  blob, at `RaidSessionBlob.pose`). A drifted member's `lobby:mission true` → `drifted`; pods and the auto-rejoin on `net:resumed`
  refuse too. `start()` / `reset()` clear the flag.
  Mission end/abort → everyone back to the shared ship; only `leaveLobby()` (`도킹 해제`) leaves.
- A link that is `refused` (kicked · `server_full` · session taken elsewhere) never reconnects by itself.

## 3. Ghosts · host migration · late join

- A member whose socket drops mid-raid keeps a **ghost** body on the host (`suspended` ref: enemies keep targeting it, it can be
  downed / bleed out / be revived, everyone sees it grey with `연결 끊김`). Its inventory / stats are saved to the server
  (`raid:save`) and handed back with the ghost's hp / shield / position on rejoin (`ghost restore`). The ghost inherits the real
  bleed pool; a member that leaves the mission (page reload) has its ghost **parked** for `NET_GHOST_PARK_S`.
- **Automatic host migration**: `NET_HOST_MIGRATE_DELAY_MS` after the host's socket drops, to a connected member **inside the
  raid** (parked if nobody); immediately when a connected host sends `lobby:mission false`. Everyone gets `net:hostChanged` →
  enemies promote replicas, extraction / pickups / gadgets continue.
- **Squad wipe** ends the raid (`flow over` → `레이드 실패`).
- A **training** run (`lobby:start {mode:'training'}`, any member) keeps the lobby open; members join / leave individually (`lobby:mission`).
- Late joiners receive live ship calls (`strat sync`), barriers, contract hits (`meta sync`), corpses, fog mask, hazard state,
  structures, trams and extraction state through the `*q sync` requests above.

## 4. Named host transfer

| Path | Decided by | When |
|---|---|---|
| Automatic (drop) | server | See §3 |
| Automatic (left mission) | server | Connected host sends `lobby:mission false` |
| **Named** | **a person** | `lobby:transferHost {targetId, claim?}` — messenger/friends right click · in-ship interaction · squad-leader device by the host's corpse |

- `{t:'lobby:transferHost', targetId, claim?}` is accepted in only two cases: ① the sender **is the host**, or ② `claim === true`
  and the current host has set the **down flag** via `lobby:hostDown`. Otherwise `lobby:error {code:'not_host'}`. A `targetId` that is
  not a **connected** member of the same lobby → `invalid`; sender outside a lobby → `not_in_lobby`. On success
  `Lobby.transferHostTo` updates `hostId` and every `LobbyPlayer.isHost`, **clears the down flag**, and broadcasts `lobby:state` —
  so one claim cannot be used twice. If the target already is host, the state is returned to the sender only (same no-op rule as `lobby:planet`).
- `{t:'lobby:hostDown', down}` → **host only** (`not_host`). Not part of `LobbyState`, so **nothing is broadcast** — others just try a
  claim. Cleared automatically on mission end (`lobby:reset` · `autoResetMission` → `Lobby.reset()`) or host change.
- Client API: `NetRef.transferHost(targetId, claim?)` · `NetRef.reportHostDown(down)`; both are no-ops without a lobby or socket
  (they do not check the session — handing over must work inside the ship too).
- UI never calls the server: every entry point emits the bus event `leader:transferRequested {peerId}` and `NetSystem` calls
  `transferHost`. The squad-leader device itself is `lead drop` / `lead taken` (hold `LEADER_DEVICE_HOLD_S`).
- After a transfer everyone gets the normal `net:hostChanged` — **systems promote/demote exactly as in automatic migration**.
  Someone arming a host-only ship call (`STRATAGEM_HOST_ONLY`) drops it on that event. The toast is shown only by `game/parts/Leader`.

## 5. Rescue drop (`rescue_drop`)

- **The squad-wide count lives on the host** (`RESCUE_DROPS_PER_RAID`). Anyone sends `{t:'rescue', ev:'req', target, p}`; the host
  answers `grant` (count −1, landing point fixed with `world.scatterPoints`) or `deny` (`empty` / `alive` / `busy`). **The count is
  spent at grant** — no refund on cancel or failure. A `drifted` member (abandoned from the title) is never a candidate.
- `{t:'rescue', ev:'count', left}` broadcasts the remainder (`rescue:countChanged` → HUD). Late joiners get it alongside the
  `stratq sync` / `flow rejoined` replies (`StratagemCallWire` has no room for it).
- Rescue calls in flight are **not** put in `strat sync` — they last seconds, and a late receiver must not re-emit `rescue:landed`.
- **Stratagems do not draw the hellpod.** The only source of a remotely visible drop pod is player's `pod drop` (`PodMessage`, `kind:1`);
  stratagems emit only the target marker, landing dust and `rescue:called` / `rescue:landed`.
- In multiplayer the ship calls in `STRATAGEM_HOST_ONLY` can be armed only by the host. Single-player has no restriction.

## 6. Authority rules for requests

- Messages that affect others are accepted **only from the lobby host**: `strat call`, `ee`, `crate sync`. (`meal serve` is retired —
  dining plates travel as each sender's own `plate state`, no authority: eating only changes the eater's profile.) Squad
  members' ship calls go through the host as `stratq call` (kind · caller cooldown · range check) and are re-broadcast; a refusal
  comes back as `strat deny` for the caller's own `callId`, and the caller gets the full cooldown refunded.
- Host-side requests (`hit` incl. its `st` status bits and `kb` knockback · `explode` · `buff`) pass four layers in order — shape · sender · distance · rate —
  via `shared/buffRules.createBuffGuard`. Two paths of one capability share one bucket (`explode` shares `hit`'s DPS bucket). Distance
  limits derive from data (`FLAME_RANGE`/`SHOCK_RANGE` for status bits, `STRAT_MAX_CALL_RANGE` for `explode`). A dead sender may still
  `explode` (fuses outlive throwers); only `kb` (shield bash) filters on `isDead`.
- Peer-to-peer `buff` is checked by the receiving folder (lobby membership · snapshot distance · amount · rate); senders do a
  chest-to-chest ray so buffs do not go through walls. Squad contract kill shares count via `enemy:squadKill`.

## 7. Crypto prices · trades

- **Prices are simulated by the relay** (`server/CryptoMarket.ts`) — independent of lobbies and hosts, and **anonymous connections**
  may watch (prices are not secret). Charts and trades need a server; mining is a local ship-state clock and works offline.
- `{t:'crypto:watch', on}` → when on, one immediate `{t:'crypto:prices', at, prices, change24h}`, then one per tick (`CRYPTO_TICK_S`)
  (price = credits per coin, `at` = server epoch ms). The subscription is **per socket** and forgotten on disconnect — the client
  (`net/parts/Crypto`) re-enables it after `welcome`.
- `{t:'crypto:history', coin, range}` → **to the requesting socket only** `{t:'crypto:history', coin, range, at, candles}`, oldest →
  newest, at most `CRYPTO_CANDLE_COUNT[range]`, candle length `CRYPTO_CANDLE_MS[range]`, the last candle may be open. Unknown coin /
  range, or exceeding the per-socket bucket (`CRYPTO_HISTORY_BURST` · `CRYPTO_HISTORY_PER_S` in `server/RelayServer.ts`), gets **no reply**.
- **Trades are not a new message** — `credits:tx {delta, reason}` with `cbuy:<coin>:<units>` · `csell:<coin>:<units>` (`units` = wallet
  units, `CRYPTO_UNITS_PER_COIN` units = one coin). The relay bounds buy cost from the **lowest** and sell proceeds from the **highest**
  price in the last `CRYPTO_QUOTE_WINDOW_S` (+ one tick) using `shared/cryptoMarket.cryptoTradeCredits` — any price inside the window
  passes. A locked coin (`unlockQuest`) requires that quest's `quest:` credit grant in the ledger; 1 ≤ units ≤ `CRYPTO_TRADE_MAX_UNITS`;
  at most `CREDIT_CRYPTO_MAX_PER_HOUR` per profile per hour. Refusal is the usual `credits:result {ok:false, reason: CREDIT_TX_INVALID_KO}`.
  **Wallet ownership is not checked** — the ship document is a client write, so the server has nothing to compare (same limit as item sales).

## 8. Group messenger rooms

- A **server-authoritative, persistent channel independent of lobbies** (`server/Rooms.ts` → `rooms.json`). Needs a profile (token);
  does not use `relay`.
- Client → server: `room:get` · `room:create {name, invite?, nonce}` · `room:invite {room, code}` · `room:reply {room, accept}` · `room:leave {room}` ·
  `room:kick {room, code}` · `room:rename {room, name}` · `room:say {room, text, nonce}` · `room:history {room, before?}`.
- Server → client: `room:state {rooms: {rooms, invites}}` (right after `welcome` and to everyone concerned on change, coalesced like
  social — the requester immediately) · `room:line {line}` (connected current members, excluding the sender of a `say`) ·
  `room:ack {nonce, ok, room?, at?, code?}` (create · say only) · `room:history {room, lines, more}` · `room:error {code, message}`.
- **Owner model** (invite · kick · rename); invites **to friends only**, persistent for `ROOM_INVITE_TTL_MS`; limits `ROOM_MEMBER_MAX` ·
  `ROOM_LINES_MAX` · rooms per person in `src/shared/social.ts`. When the owner leaves, the earliest member takes over; when the last
  member leaves the room is deleted. Blocking follows social's directional rule (blocked by them → `not_found`, I blocked → `invalid`);
  blocks inside the same room are hidden client-side.
- **Not connected to the chat window** — rooms exist only in the messenger. Private chats (formerly whispers) remain `social:whisper`,
  and the chat window and messenger share one history.
- Unread state is client-side (`slotKey(ROOM_READ_STORAGE_KEY)` · the conversation log's `readAt`).

## 9. Android squadmates (bot lobby members)

2026-09-15 user decision — contract in `src/shared/allies.ts` and the last section of `src/shared/net.ts`; simulation is
`src/allies/` (see [src/allies/README.md](../src/allies/README.md)). The relay owns only **membership**.

- An android that walked out of a cockpit bay is an ordinary lobby member with `LobbyPlayer.bot === true`, `bay`
  (`0 … ANDROID_BAY_COUNT`), `recruitedAt`, no socket, always `connected` and `ready`, `inMission` from the raid start like
  anyone else. Its id is `androidIdOf(lobby.code, bay)` (`android:<code>:<bay>`) — a prefix a profile `PeerId` can never carry.
  It takes a **real lobby slot** (launch pod, colour, spawn offset), so a squad is still at most `NET_MAX_PLAYERS` bodies.
- `lobby:android {bay, recruit}` — **leader only**, **docked** lobby only, before the start. Refusals in order:
  `not_in_lobby` → `not_host` → `not_docked` → `started` → `invalid` (bay out of range, or already in that state) →
  `full`. A `full` refusal also sends `lobby:androidReturned {bay, reason:'full'}` to the requester alone. Success is one
  `lobby:state`; a deliberate dismissal sends no `androidReturned` (the roster is in the state).
- **Humans win.** `Lobby.canAdd()` counts humans only, so an android-filled squad still accepts a join / invite / move;
  `Lobby.add` then evicts the bot with the latest `recruitedAt` and the relay broadcasts
  `lobby:androidReturned {bay, reason:'human_joined'}` to the lobby **after** the join, so the newcomer hears it too.
  Quick match counts **everyone** (`isQuickMatchable`), so androids do close a ship to strangers — invites still get in.
- Androids are left out of everything that is about people: host migration and `lobby:transferHost` (→ `invalid`),
  `relay {to}` (dropped silently), presence squad counts, 최근 만난 플레이어, block checks, `pruneLonely`, the reconnect
  grace's "others still inside", `inMissionCount` / `autoResetMission`, raid blobs, `net:peerJoined` / `peerLeft`,
  `RemotePlayerRef`s and `net:missionMembership`, dining plates. `Lobby.reset()` keeps them `ready`, and when the **last
  human** leaves the lobby is deleted with its androids (they never keep a ship alive).
- Client: `NetRef.setAndroidBay(bay, recruit)` (leader only; otherwise `net:error`) and `net:androidReturned {bay, reason}`.
  Squad size is humans-only where the question is social (invite gates, crew rows); folders that ask "how many fighters"
  (enemy scaling) read the lobby themselves and count androids. Operator console: `lobbies` marks them, `kick <androidId>`
  returns one to its bay.
- **Raid-entry loading** (`load`): after the launch countdown everyone fades to black, reports progress with
  `load p {seed, v}` to `others`, and the host releases with `load go {seed, to?}` when every **human** in the mission is
  done or `RAID_LOAD_TIMEOUT_S` passes (a late player releases itself). Owner: `src/game/parts/LoadGate`.

## 10. Not synced yet

- Pickup lifetime expiry is per-client (`PICKUP_LIFETIME` is 0).
- A host promoted mid-mission does not inherit the old host's guard anchors / lures.
- A corpse the host never opened validates only the first take per index.
- `ee grenadeHit` matches replica grenades by proximity.
