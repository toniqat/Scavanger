# 멀티플레이 계약 (host-authoritative, 최대 4인)

[CLAUDE.md](../CLAUDE.md) 에서 분리했다. 와이어 타입은 전부 [`src/shared/net.ts`](../src/shared/net.ts) 에 있고,
서버도 그 파일만 import 한다. 폴더별 상세: [src/net](../src/net/README.md) · [server](../server/README.md) ·
[src/enemies](../src/enemies/README.md) · [src/hub](../src/hub/README.md) · [src/player](../src/player/README.md)

---

## 1. 기본 계약

- **Topology**: browser clients ↔ Node WebSocket relay (`server/`). The lobby **host** simulates enemies, waves and extraction; every client simulates its own player only. `ctx.isAuthority` (single-player OR host) gates simulation; `ctx.isMultiplayer` gates networking. All wire types live in `src/shared/net.ts` (also imported by the server).

- **Players**: `PlayerSnapshot` (`ps`, 20 Hz, pos/vel/yaw/pitch/stance/flags/hp/weapon/stride) → `NetSystem` interpolates with a 0.12 s buffer + ≤0.25 s extrapolation → `player/RemotePlayerSystem` drives a slot-coloured `SoldierModel` (`RemoteAvatar`), `weapons/RemoteWeapons` parents a `WeaponModel` and replays fire/reload/grenade FX, `ui/hud/Nameplates` + `Squad` + `MapScreen` show them. Spawn = 4 m ring by slot.

- **Enemies**: host broadcasts `es` (full snapshot, 10 Hz, ~90 B/bug) + `ee` events (spawn/kill/despawn/damaged/attack/acid/wave); clients run replicas (no AI) with interpolation. Client shots hit replica hitboxes locally → replica `takeDamage` sends `hit` to host → host applies damage → `hitc` back (kill hitmarker + kill credit). Explosions → `explode`. AI targets any player (`enemies/Targets.ts` `CombatTarget`); remote victims get `dmg` (+ optional slow) via `ctx.net.send(..., peerId)`.

- **Extraction**: host owns the countdown and broadcasts `ex` (activated/tick 0.5 s/shipIncoming/shipLanded/boarding/liftoff/reset); clients send `exq` (activate/board/liftoff). Liftoff requires every alive connected player boarded (`탑승 대기 중 (n/m)`).

- **Flow**: `game:paused {freeze:false}` in multiplayer (menu only, world keeps running — Engine + enemies honour it). A dead player spectates (`SpectateOverlay`); host sends `flow over` when everyone is dead, `flow abort` when the host aborts → whole squad returns to the lobby (`NetSystem` sends `lobby:reset`). Death/complete screens show `로비로` while a lobby exists.

- **Ship hub & reconnection** (2026-09-05): title `함선 탑승` → `hub:enter personal` (hub calls `ensureConnected`; a token still in a lobby resumes straight into the shared ship). Terminal quick match (`lobby:quickmatch` → public lobby) or code → `docking` cutscene → shared ship at world origin (all clients build identical geometry, so hub snapshots line up). Pod board = `setReady(true)`; all connected members ready → 3 s countdown → host `startGame(seed)`. Socket drop: server keeps the slot 5 min (`connected=false`), client reconnects with backoff; same mission still running → `net:resumed {seamless:true}` (host keeps authority through its own drop); page reload → shared ship, and `missionInProgress` lets a pod `rejoinMission()` (world by seed, enemies from full `es`, `exq sync` → `ex sync`, `itemq sync` → `item sync`). Mission end/abort → everyone back to the shared ship; only `leaveLobby()` (도킹 해제) leaves.

- **Pickups**: host-authoritative (`item`/`itemq`), ids `${peerId}-${n}`, client drop is optimistic and echoed by the host. **Chat**: `chat {text, kind}` relayed to others, also in the hub. **Pings**: `ping {p, kind, label?, enemyId?}` (label/enemyId read via `onMessage('ping')`).

## 2. Phase 별로 더해진 것

- **Phase 7 (2026-09-06)**: a member whose socket drops mid-raid keeps a **ghost** body on the host (`suspended` ref: enemies keep targeting it, it can be downed / bleed out / be revived, everyone sees it grey with `연결 끊김`); its inventory / stats are saved to the server (`raid:save`) and handed back with the ghost's hp / position on rejoin (`ghost restore`). The **host migrates** 4 s after it drops (`net:hostChanged` → enemies promote replicas, extraction / pickups / gadgets continue, `flow takeover` makes clients re-sync). **Squad wipe** ends the raid (`flow over` → 레이드 실패). Container contents stay deterministic but the **taken state is host-authoritative** (`contq / cont`). Replica grenades damage the local player. Remote poses / held items / attachments / armor / overcharge beams replicate. A **training** (`lobby:start {mode:'training'}`, any member) keeps the lobby open; members join / leave individually (`lobby:mission`).

- **Phase 9 (2026-09-07)**: a dropped member's ghost now inherits its real bleed pool, and a member that leaves the mission (page reload) has its ghost **parked** for `NET_GHOST_PARK_S` instead of dropped. The host role migrates only to someone inside the raid. `es` is a **delta** stream with a keyframe every `NET_ENEMY_KEYFRAME_S`. Live ship calls (`strat sync`), a standing barrier and the squad's contract hits (`meta sync`) reach a late joiner; pickups / gadgets / gather / containers re-sync on a takeover.

- **Phase 11 (2026-09-07)**: `LobbyState.planet` 은 **호스트만** 정하고(`lobby:planet`), 모든 멤버가 자기 `lobby:state` 를 보고 워프 컷씬을 돈다 — 별도 이동 메시지는 없다. 목표 행성 없이 레이드를 시작하면 서버가 `no_planet` 으로 거부하고(훈련장은 무관), `lobby:reset` 후에도 목적지는 남는다. **소셜은 로비 밖에서도 오간다**: 릴레이가 친구 watcher 인덱스로 `social:state` 를 밀어 주고 귓속말 · 분대 초대를 아이디로 라우팅한다. 모든 `LobbyState` 에 각 멤버의 아이디 · 레벨이 실린다.

## 3. 아직 동기화되지 않은 것

- **Not synced yet**: pickup lifetime expiry is per-client (`PICKUP_LIFETIME` is 0); a host promoted mid-mission does not inherit the old host's guard anchors / lures and takes its wave index from the `ee wave` events it saw; a corpse the host never opened validates only the first take per index; `ee grenadeHit` matches replica grenades by proximity.
