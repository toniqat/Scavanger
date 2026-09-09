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

- **2026-09-08 (공용 함선 격납고)**: 공유 함선 뒤 격납고에는 분대원 개개인의 **개인 함선**이 정박해 있고, 그 사람의 함선 안으로 걸어 들어갈 수 있다. 남의 함선 내부를 그리려면 배치 정보가 필요해서 `ship state` (`ShipVisitWire` — 방 용도 · 시설 레벨 · 배치 가구 · 꽂힌 책)가 새로 생겼다. 동작은 **크루 카드와 같다**: 공유 함선 도착 시 `others` 로 한 번 뿌리고 나머지에게 `shipq state` 를 요청, 내 함선이 바뀌면 디바운스 재방송, 요청에는 쿨다운을 두고 즉답. 서버는 여전히 내용을 보지 않는다(불투명 릴레이). 창고 · 프리셋 · 도감은 보내지 않는다 — **방문은 둘러보기 전용**이라 그릴 것만 있으면 된다. 함선을 드나드는 것은 **로비 상태를 전혀 바꾸지 않는다**(도킹도 아니고 임무도 아니다). 인테리어가 전부 월드 원점에 지어지므로 "지금 어느 함선 안인가"를 `PlayerSnapshot.hs` 로 알려서(`null` = 공유 데크) 값이 다른 아바타는 그리지 않는다 — 같은 함선을 구경 중인 둘은 서로 보인다.

- **2026-09-09 (분대장 지명 이관 · 구조선 투하)**: 아래 4절 · 5절.

## 4. 분대장(호스트) 지명 이관

이관 경로가 이제 **셋**이다. 앞의 둘은 예전부터 있던 자동 이관이고, 셋째가 2026-09-09 에 더해진 **지명**이다.

| 경로 | 누가 정하나 | 언제 |
|---|---|---|
| 자동 (드롭) | 서버 | 호스트 소켓이 끊기고 `NET_HOST_MIGRATE_DELAY_MS` 가 지나면 — 레이드 중이면 **미션 안에 있는** 접속 멤버에게, 아무도 없으면 **주차**(parked) |
| 자동 (미션 이탈) | 서버 | 접속 중인 호스트가 `lobby:mission false` (새로고침 · 함선 복귀) 를 보내면 즉시 |
| **지명** | **사람** | `lobby:transferHost {targetId, claim?}` — 커뮤니티 창 우클릭 · 공용 함선 안 상호작용 · 시체 옆 분대장 기기 |

**와이어 (`src/shared/net.ts`)**

- `{t:'lobby:transferHost', targetId, claim?}` → 서버가 받아 주는 경우는 둘뿐이다:
  ① 보낸 사람이 **지금 호스트**다, 또는 ② `claim === true` 이고 현재 호스트가 `lobby:hostDown` 으로 **사망 표시**를
  켜 두었다. 그 외에는 `lobby:error {code:'not_host'}`. `targetId` 가 같은 로비의 **연결된** 멤버가 아니면 `invalid`,
  로비 밖이면 `not_in_lobby`. 성공하면 `Lobby.transferHostTo` 가 `hostId` 와 모든 `LobbyPlayer.isHost` 를 갱신하고
  **사망 표시를 지운 뒤** `lobby:state` 를 방송한다 — 즉 같은 claim 을 두 번 쓸 수 없다.
  이미 그 사람이 호스트면 방송 없이 보낸 사람에게만 상태를 되돌려 준다 (`lobby:planet` 의 no-op 과 같은 규약).
- `{t:'lobby:hostDown', down}` → **호스트 본인만** 세울 수 있다 (`not_host`). `LobbyState` 에 실리지 않으므로
  **아무것도 방송하지 않는다** — 남들은 그냥 claim 을 시도하고 `not_host` 로 알게 된다. 미션이 끝나거나
  (`lobby:reset` · `autoResetMission` → `Lobby.reset()`) 호스트가 바뀌면(`migrateHost` / `transferHostTo`) 자동으로 꺼진다.
- 클라이언트 API 는 `NetRef.transferHost(targetId, claim?)` · `NetRef.reportHostDown(down)` 이고, 둘 다
  **로비가 없거나 소켓이 끊겼으면 no-op** 이다 (함선 안 = 세션 밖에서도 넘길 수 있어야 하므로 세션은 보지 않는다).
- UI 는 서버를 직접 부르지 않는다. 커뮤니티 창의 우클릭도 함선 안 상호작용도 `leader:transferRequested {peerId}`
  버스 이벤트 하나를 내고, `NetSystem` 이 그것을 구독해 `transferHost(peerId)` 를 부른다.
- 이관이 끝나면 모두가 평소의 `net:hostChanged` 를 받는다 — **시스템들이 승격/강등되는 경로는 자동 이관과 한 글자도
  다르지 않다.** 호스트 전용 함선 호출(`STRATAGEM_HOST_ONLY`)을 무장 중이던 사람은 그 이벤트에서 손을 내려놓는다.

## 5. 구조선 투하 (`rescue_drop`)

- **분대 공용 횟수는 호스트가 들고 있다** (`RESCUE_DROPS_PER_RAID`). 아무나 `{t:'rescue', ev:'req', target, p}` 를
  호스트에게 보내고, 호스트가 `grant`(횟수 −1 + `world.scatterPoints` 로 착륙 지점 확정) 또는 `deny`
  (`empty` / `alive` / `busy`) 로 답한다. **차감은 grant 시점**이고 취소 · 실패해도 환불하지 않는다.
- `{t:'rescue', ev:'count', left}` 가 잔여 횟수 방송이고 `rescue:countChanged` 로 HUD 에 닿는다. 늦게 합류한
  클라이언트는 `stratq sync` / `flow rejoined` 답장에 이 프레임이 함께 실린다 (`StratagemCallWire` 에는 자리가 없다).
- 진행 중인 구조선 호출은 `strat sync` 에 **싣지 않는다** — 4초짜리 일회성이고, 늦게 받은 쪽이 `rescue:landed` 를
  다시 내면 안 되기 때문이다.
- **헬포드는 stratagems 가 그리지 않는다.** 원격에서 보이는 강하 포드의 유일한 원본은 `player/` 의 `pod drop`
  (`PodMessage`, `kind:1`) 이다. stratagems 는 표적 마커 · 착륙 먼지와 `rescue:called` / `rescue:landed` 만 낸다.
- 멀티에서 **궤도 폭격 · 항공 폭탄은 호스트 전용**(`STRATAGEM_HOST_ONLY`)이다. 싱글 플레이는 제한이 없다.

## 6. 아직 동기화되지 않은 것

- **Not synced yet**: pickup lifetime expiry is per-client (`PICKUP_LIFETIME` is 0); a host promoted mid-mission does not inherit the old host's guard anchors / lures and takes its wave index from the `ee wave` events it saw; a corpse the host never opened validates only the first take per index; `ee grenadeHit` matches replica grenades by proximity.
