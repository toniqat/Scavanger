# src/extraction — Extraction sequence (`ExtractionSystem`)

Switch consoles on every landing pad → **20 s** countdown (`EXTRACTION_COUNTDOWN`, 2026-09-13: was 60 s) with a signal flare → procedural
dropship flight-in and landing → **solid hull** (world colliders, enemy-only doorway) → boarding volume → **60 s idle timer**
(`EXTRACTION_AUTO_DEPART_IDLE_S`) → interior switch **or** the idle timer starts an uncancellable **10 s departure grace**
(`EXTRACTION_DEPART_GRACE_S`) → the ship leaves with whoever is aboard and alive → riders get the **departure cinematic**,
everyone else keeps playing and the flow **resets** so a new ship can be called. Emits every `extraction:*` event;
`GameFlowSystem` owns the phase transitions. **There is no defense any more** — nothing here asks enemies for waves (the wave
director that used to start on `extraction:activated` is removed on the enemies side). All geometry is procedural (no assets).

Publishes **`ctx.extraction`** (`shared/extraction.ts` → `ExtractionRef`: `stage` · `departRemaining` · `idleRemaining` · `riding` ·
`isInShipBay(p)` · `keepEnemyOut(p, r)`).

Import via `@/extraction` → `ExtractionSystem`, `ExtractionConsole`, `Dropship`, `ParticlePool`, `FlareColumn`, `DustRing`.

| File | Purpose |
|---|---|
| `ExtractionSystem.ts` | `GameSystem` (`name: 'extraction'`). On `world:ready` builds one `ExtractionConsole` per `ctx.world.getExtractionPoints()` (none at all when the list is empty — the 훈련장 arena) (5 m from pad center toward `yaw`, on the platform top) and registers `Interactable` `extract_<id>` (radius 2.6, hold 1.2 s, prompt "탈출 신호 전송 (E 길게)", only in phase `playing` and while no flow is active). Activation (`activate()` → `beginActivation()`): console → amber/blink, other consoles off, flare starts, `extraction:activated`, `audio:play extract_activate`. Countdown emits `extraction:tick` every frame, `countdown_beep` in the last 10 s; at 12 s left `extraction:shipIncoming` + ship approach (authority only). Touchdown (`onShipLanded`) → `camera:shake`, `ship_land`, **`ShipHull.register`**, `idleRemaining = EXTRACTION_AUTO_DEPART_IDLE_S`, `extraction:shipLanded`, registers `ship_liftoff_switch` (hold 1.0 s, "출발 시퀀스 시작 (E 길게) · 10초 뒤 이륙", interactable only for a **living boarded** local player while landed and not departing). While landed every frame: `extraction:departureTick {stage:'waiting'}` (idle timer) or `{stage:'departing'}` (grace, + a `countdown_beep` per second); the authority starts the grace at idle 0 (`startDeparture(true)`) and lifts off at grace 0. **Boarding** = a volume test only (`ship.containsWorldPoint`) → `extraction:boarded`; the body keeps walking in **world mode** against the hull colliders so it can step out through the ramp again (2026-09-13 — the old `setShipInterior` box clamp never let a boarded player leave). **Liftoff** (`liftoff()`): authority computes `riders` (required ∩ in the bay) and `squadDone` (somebody left and nobody alive stayed outside); the local player rides iff boarded and alive → `ship.writeInteriorBounds` + `setShipInterior(shipBounds)` (**one object rewritten every frame** while riding, so the deck travels with the ship) + `setControlsEnabled(false)` + `attachTo(ship.root)` + `DepartureCinematic.start`; `extraction:liftoff {position, aboard, squadDone}`, `ship_liftoff`; ramp closes → `extraction:doorsClosed`; the hull colliders go when the climb starts (`liftoffTime ≥ LIFTOFF_SPOOL_S`). **Left behind** (`!riding && !squadDone`): `LEFT_BEHIND_RESET_S` (= `EXTRACTION_LIFTOFF_TO_COMPLETE_S + 1`; clients + 0.5 s) after the liftoff → `departedReset()`: removes the corpses that flew off (`CorpsesRef.removeCorpse`), `resetMission(false, keepPlayer)`, `extraction:reset`. **Corpses**: `corpse:playerSpawned` in the bay (landed / near the pad: `ShipHull.inBay`; climbing: only a rider's own corpse) → `CorpsesRef.attachCorpse(id, ship.root, deck-local)`. Resets on `game:abort` (everything) and `game:newMission` (keeps pads that already belong to the new seed — `world:ready` fires synchronously before this handler). Multiplayer section below. |
| `Hull.ts` | **2026-09-13.** `ShipHull`: eight ship-local `Obstacle.box` colliders (side slabs, belly = deck surface, roof + spine, bay front wall → front cap, nose + chin, two nacelles) registered through `WorldRef.addObstacle` at touchdown and removed when the climb starts (static — a rising roof slab would shove riders sideways). The rear ramp opening has no collider. `ShipHull.keepEnemyOut(ship, p, r)` pushes a body inside the bay rectangle (grown by `r`) out through the doorway (local +Z) only — sides and front are already walls; `ShipHull.inBay(ship, p, pad)`. Both only while `ship.nearGround`. |
| `Cinematic.ts` | **2026-09-13.** `DepartureCinematic`: `start` snapshots the camera pose, closes open screens (`inventory.closeAll`) and emits `ui:cinematic {active:true}`; `update` damps a chase point behind-right of the ship (`CAM_OFFSET` in the yaw frame, rate 1.1/s — the accelerating ship pulls away) and blends camera → chase over `EXTRACTION_CINEMATIC_BLEND_S` (smoothstep), handing the **already blended** pose to `setCameraOverride(pos, look, true)` every frame (no jump on the first frame); `stop` = hard cut back + `ui:cinematic {active:false}`. Never below terrain + 1.5 m. |
| `Console.ts` | `ExtractionConsole`: base plate, pedestal with canvas-generated hazard stripe, slanted panel with emissive screen, big hazard-striped lever (tweens down when activated), status lamp on a mast, 40 m additive holographic beacon shaft, point light. States `idle` (blue pulse) / `active` (amber blink) / `off`. `interactPoint` is the interactable position. **2026-09-09 — the beacon shaft is off while `idle`** (전장의 안개; `ui/map` + `hud/WorldMarkers` + `hud/Compass` gate pads on `FogRef.isDiscovered`); it comes back on in `active`. Only `beacon.visible` changes. |
| `Ship.ts` | `Dropship`: `forceLand(pos, yaw)` snaps straight to `landed` (multiplayer client fallback). ~14 m "Pelican"-style hull (**shell of four slabs + a front cap — the rear is a real hole**, top deck, spine, wedge nose + cockpit glass, chin, tail fins/plane), wings with two nacelles, flickering additive blue thrust cones + engine lights, 3 retractable landing legs, amber landing lights, hinged rear ramp (1.5 s open/close — **the only thing that closes the rear**), lit interior bay (floor at local y=0, walls/ribs/benches, ceiling light strip, red interior switch console on the far wall). **`root` = transform + the 3 point lights and is always visible; `body` = every mesh and carries the visibility toggle** (see 변경 이력 2026-09-10). States `hidden → approach → descend → landed → liftoff`. `startApproach()` flies a curved, banking, decelerating path from 300 m out / 130 m up, hovers at 24 m then descends with wobble; `beginLiftoff()` closes the ramp, spools for `LIFTOFF_SPOOL_S` (1.6 s), then climbs and accelerates toward the nose. Exports bay constants, `LIFTOFF_SPOOL_S`, `containsWorldPoint()`, `floorYAt(x, z)` (deck plane — the deck tilts), `writeInteriorBounds(out, at?)` / `getInteriorBounds()` (rotation-safe world AABB), `interiorSwitchWorld`, and (2026-09-13) `yaw`, `nearGround`, `bayLocal(p, out)` / `bayToWorld(lx, lz, y, out)` (yaw-only frame). Local −Z is the nose; the ramp faces +Z (toward the console). |
| `Particles.ts` | `ParticlePool` — CPU-simulated point sprites in one draw call (custom ShaderMaterial: soft round sprite, life fade, color lerp, gravity/drag/growth). `FlareColumn` — red smoke + amber embers + flickering glow rising from the active pad for the whole countdown; **its `group` is never hidden** (it holds a point light — see 변경 이력 2026-09-10), `shown` gates the work instead. `DustRing` — radial ground dust blown outward during descent and liftoff. |
| `index.ts` | Barrel. |

## Timeline (2026-09-13)
activation · 20 s countdown (`extraction:tick`) · 12 s left → `shipIncoming`, approach 8 s + descent 4.2 s · touchdown, ramp opens, hull solid ·
idle **60 s** (`departureTick waiting`) · switch or idle 0 → grace **10 s** (`departureStarted`, `departureTick departing`, boarding still open) ·
0 → `extraction:liftoff {aboard, squadDone}` · ramp closes 1.6 s (`doorsClosed`), hull colliders removed, climb ·
riders: cinematic, result screen `EXTRACTION_LIFTOFF_TO_COMPLETE_S` (10 s) after the liftoff (`GameFlowSystem`) ·
left behind: `extraction:reset` 11 s after the liftoff (clients 11.5 s), consoles callable again.

## Enemies never enter the ship
- The hull is eight world box colliders while the ship is on the pad (`Hull.ts`) — bugs, rogues, bullets and grenades all stop at it.
- The ramp opening is closed to **enemies only**: `enemies/ai/EnemyAI.integrate` (and the hunter leap) call `ctx.extraction.keepEnemyOut(pos, radius)`
  right after `world.resolveCollision` / `resolveBarrier`. A charge that hits the doorway stumbles like on any wall. Replicas follow the host.
- Players are never passed to it — the bay is walked in world mode, the belly box is the floor, the ramp is open.

## Multiplayer (host-authoritative; everything gated on `ctx.isMultiplayer`, so single-player is unchanged)
Pads/consoles are built identically on every client (deterministic world). `ctx.net` may be null → always null-checked;
net subscriptions are made lazily (`ensureNetHooks()` on `world:ready` / `update`) and dropped on `game:abort` / `dispose()`.

| Step | Host (`ctx.isAuthority`) | Client |
|---|---|---|
| Console E | `activate()` → `ex activated {padId, duration}` to others | `exq activate {padId}` to host (no local countdown until `activated` arrives) |
| Countdown | local tick every frame; `ex tick {remaining}` every 0.5 s | `activated` → `beginActivation()`; decrements locally, snaps to each `tick`; never calls the ship |
| Ship | `callShip()` → `ex shipIncoming {eta}` | `shipIncoming` → `ship.startApproach()` + `extraction:shipIncoming` |
| Landing | touchdown → `onShipLanded()` → `ex shipLanded` + initial `ex boarding` + `ex wait` | local touchdown → `onShipLanded()`; if the host's `shipLanded` arrives and the local ship has not landed within 1 s → `ship.forceLand()` |
| Idle timer | local; `ex wait {remaining}` every 1 s; at 0 → `startDeparture(true)` | local mirror, snaps to `wait` |
| Boarding | local volume → `boardedPeers` add/remove `localId`; `exq board` → set → `ex boarding {boarded, required}` + `탑승 n/m` toast | local volume → `exq board {inside}` |
| Interior switch | `startDeparture(false)` | `exq liftoff` → host accepts only while landed, not departing, from a peer in `boardedPeers` |
| Grace | `ex depart {remaining, auto}` at start and every 0.5 s; at 0 → `liftoff()` | `depart` → `startDeparture` (force-lands first if needed) / snap `departRemaining`; never lifts off by itself |
| Liftoff | `liftoff()` → `ex liftoff {riders, squadDone}` | `liftoff` → riders added to `riderIds`, `liftoff(squadDone)`; **riding is decided locally** (boarded && alive) |
| Left behind | at `LEFT_BEHIND_RESET_S` → `departedReset()` → `ex reset` | at `LEFT_BEHIND_RESET_S + 0.5` by itself, or earlier on `reset` → `departedReset()` |
| Rider | — | a riding client ignores every later `ex` message and `net:hostChanged` (its flow ends on its result screen) |
| Abort reset | `resetMission()` → `ex reset` (when a flow was active) | `reset` → `departedReset()`; the host's `flow abort` follows and aborts anyway |

**Who leaves the raid.** `squadDone` (somebody left aboard and no required player — alive, connected, not suspended, not `IN_HUB`, not
downed — stayed outside): the raid ends for everyone like before (non-riders reach the result screen with `extracted = false`, the host's
`flow complete` backs it up). Otherwise only the riders leave: `game/parts/Death.complete` calls `net.leaveMission()` right after their
result screen (`LIFTOFF_TO_COMPLETE`), no `flow complete` is sent, and the server hands the host role to a squadmate still in the raid.
The remaining squad resets one second later (`LEFT_BEHIND_RESET_S`), so a console press after the reset already reaches the new host.
When the remaining members are all dead, the wipe check (`checkAllDead`, riders are `inMission: false` by then) ends the raid as a failure.

**Host takeover** (`net:hostChanged`): the new host promotes its mirror (`activePad / countdown / shipCalled / landed / idleRemaining / departing /
departRemaining / lifting / liftoffElapsed` are the same fields on both sides) — the countdown, idle timer and grace keep ticking and are now
broadcast (`tick` / `wait` / `depart` sent at once), the ship continues its flight, a lifted-off flow resets on the host's own timer.
`boardedPeers` is rebuilt from the last `boarding` / `sync` list (`lastBoarded`) + the local bay state, minus refs that are gone or suspended.
Every other client (incl. the demoted host) sends `exq sync` to the new host.

## Rejoin sync
A client that (re)enters a running mission has no extraction state. When its phase goes `deploying → playing` (hellpod landed) and it
is a non-host session member, it sends `exq sync`; the host replies to that peer only with `ex sync {state: ExtractionSyncState}`
(`stage` idle / countdown / shipIncoming / shipLanded / **departing** / liftoff, `padId`, `remaining`, `boarded`, `required`, and since
2026-09-13 `idleRemaining` · `departRemaining` · `departAuto` · `sinceLiftoff` · `squadDone`). The client replays the normal entry paths in
order (`beginActivation` → `callShip` / `forceLandNow` → `startDeparture` → `liftoff`) so GameFlow sees the usual events. A rejoiner
at `liftoff` is not boarded and watches the ship go (resetting with the squad unless `squadDone`). If a flow is already active locally
the numbers are refreshed and a missed stage is caught up; a host that answers `idle` while our flow is still up resets it.

## Phase 2 / Phase 7 (kept)
- Downed (`PlayerFlags.DOWNED` / `ctx.player.isDowned`) players are treated like dead ones — never riders, never required.
- `collectRequired` skips `RemotePlayerRef.suspended` members (socket down, host-simulated ghost) and `IN_HUB` refs; host `net:peerSuspended {suspended:true}` drops the peer from `boardedPeers`.
- **훈련장**: `buildPads()` returns early when `getExtractionPoints()` is empty → no consoles, no countdown, no ship.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

- **2026-09-13 (탈출 개편, 사용자 결정)** — 디펜스 기믹 제거 · 호출 20초 · 출발 유예 · 자동 출발 · 이륙 연출 · 남겨진 사람의 재호출 ·
  함선 콜라이더 · 화물칸 시체.
  1. **타이밍은 전부 csv 다** (`data/constants.csv`): `EXTRACTION_COUNTDOWN` 60 → **20**, 새 `EXTRACTION_DEPART_GRACE_S` 10 ·
     `EXTRACTION_AUTO_DEPART_IDLE_S` 60 · `EXTRACTION_LIFTOFF_TO_COMPLETE_S` 10(옛 `game/model` 의 6.5) · `EXTRACTION_CINEMATIC_BLEND_S` 2.2 ·
     `EXTRACTION_HUD_FADE_S` 0.9. 탈출 웨이브(디펜스)는 enemies 쪽이 `extraction:activated` 구독을 걷어냈다 — 이 폴더에는 원래 방어 조건이 없었다.
  2. **옛 「전원 탑승」 이륙 게이트는 없다.** 함선 안에 살아 있는 사람 누구든 스위치를 1초 누르면 **취소할 수 없는** 10초 유예가 시작되고, 착륙 뒤
     60초 동안 아무도 누르지 않으면 유예가 스스로 걸린다. 유예 중에도 탈 수 있고, 0 이 되는 순간 **함선 안에 살아 있는 사람만** 떠난다 — 아무도
     없어도 떠난다. 유예 · 대기 시간은 `extraction:departureTick` 으로 분대 전원에게 가고 `ui/hud/Objective` 의 큰 타이머가 그린다.
  3. **남겨진 사람은 계속 싸운다.** `extraction:liftoff` 에 `aboard` · `squadDone` 이 붙었다(추가만). 둘 다 false 면 GameFlow 는 페이즈를 바꾸지
     않고, 11초 뒤 `departedReset` → `extraction:reset` → 페이즈 `playing`, 콘솔이 다시 켜진다. 탑승자는 결과 화면에서 `leaveMission()` 으로 레이드를
     나가 서버가 남은 대원에게 분대장을 넘긴다 — `flow complete` 는 `squadDone` 일 때만 간다. 리셋을 결과 화면보다 1초 늦게 둔 이유: 호스트가
     탑승자면 그 사이에 분대장이 넘어가 있어야 리셋 뒤 콘솔 요청이 받아 줄 호스트에게 간다.
  4. **이륙 연출** (`Cinematic.ts`): 카메라가 캐릭터에서 함선 뒤쪽 외부 카메라로 스르륵 넘어가 날아가는 함선을 늦게 따라가고, `ui:cinematic` 이
     전투 HUD 를 페이드한다. 블렌드는 이 파일이 직접 섞어 `snap` 으로 넘긴다 — `setCameraOverride` 의 감쇠 12 는 0.25초라 "부드럽게" 가 아니다.
  5. **적이 외피를 뚫고 들어오던 것** — 함선에 **월드 콜라이더가 하나도 없었다**. 이제 착륙 순간 외피 상자 여덟 개(`Hull.ts`)를 `addObstacle` 로
     등록하고(world 가 `box` 를 싣도록 두 줄 고쳤다) 뒤쪽 입구는 `ctx.extraction.keepEnemyOut` 이 **적에게만** 막는다. 콜라이더는 함선이 오르기
     시작할 때 걷는다 — 떠오르는 지붕 판이 탑승자를 옆으로 미는 쪽이라 움직이는 콜라이더로 만들지 않았다.
  6. **탑승은 이제 월드 모드다.** 옛 방식(탑승 = `setShipInterior` 상자 클램프)은 상자 뒤 끝이 입구 평면을 넘지 못해 **한번 타면 못 내렸다** —
     탑승 즉시 이륙하던 시절엔 드러나지 않았다. 외피가 벽이 됐으므로 착륙해 있는 동안은 그냥 걸어 들어가고 나가며, 상자 클램프는 **이륙하는
     탑승자에게만** 건다. `PlayerRef.isInShip` 은 착륙한 화물칸 안에서도 true 다(`player/` 한 줄 — 재해 · 전차 면제가 그대로 산다).
  7. **화물칸의 시체** — `corpse:playerSpawned` 가 화물칸 안이면 `CorpsesRef.attachCorpse(id, ship.root, 데크 로컬)` 로 데크에 눕혀 함께 오르고,
     남겨진 쪽의 리셋에서 `removeCorpse` 로 사라진다(주인의 장비도). 이륙 중에는 높이를 믿을 수 없어 탑승자 본인의 시체만 싣는다.
  검증: `npm run typecheck`(이 폴더 · game · ui · player 깨끗), `npm run data:check` 통과. 새 `scripts/smoke-extraction.mjs`(리드가 돌린다).
  **알려진 한계**: `progression` 의 암호학 XP 가 `extraction:activated` 마다 붙으므로 재호출도 XP 를 준다 · `ui/map/MapScreen` 의 `activePadId` 는
  `extraction:reset` 을 모른다(재해 에이전트 소유 파일이라 건드리지 않았다 — 지도에 떠난 신호소가 활성으로 남는다).

- **2026-09-10 (콘솔에 감지 빛기둥 없음)** — 탈출 신호 콘솔(`extract_<padId>`)과 함선 안 이륙 스위치
  (`ship_liftoff_switch`)의 `Interactable` 에 `hidePillar: true`. 가까이 가면 `ui/hud/Detection` 이 세우던 청록
  빛기둥이 더 이상 서지 않는다 (콘솔 자체가 발광 장치라 루팅 표시와 헷갈렸다 — 사용자 요청). 활성화 뒤 패드
  한가운데서 오르는 **신호탄 연기(`FlareColumn`)는 그대로**다 — 그것은 감지 표시가 아니라 착륙 지점 표시다.

- **2026-09-10 (뒷문 · 탑승 이동 · 도착 렉)** — 플레이 피드백 3건.

  1. **뒷문 자리가 실제로 뚫렸다.** 외피가 상자 하나(`4.2 × 3.3 × 7.2`)라 그 **뒷면이 화물칸 입구 바로 뒤에**
     있었다 — 램프가 내려와도 회색 벽만 보였다. 이제 외피는 화물칸을 둘러싼 **판 넷(좌 · 우 · 지붕 · 배)
     + 앞 마개**이고 뒤는 구멍이다. 구멍을 막는 것은 **램프뿐**이다 (닫히면 `z = 0.25` 에 3.2 × 3.0 으로
     서서 입구 전체를 덮는다 — 원래 뒷문이 해야 할 일). 앞 마개가 필요한 이유는 4각 노즈 콘이 모서리에
     틈을 남겨서, 껍데기가 뒤로 뚫린 순간 앞 구획이 들여다보이기 때문이다. 실루엣(바운딩 박스)은
     한 치도 바뀌지 않았다. 겸사겸사 화물칸 내장(`interiorParts`)은 그림자 캐스터에서 뺐다 — 밖에서
     보이지 않는데 태양 그림자 패스에 50개 중 19개를 얹고 있었다.

  2. **함선을 타면 함선과 함께 움직인다.** `attachTo(ship.root)` 는 **모델만** 함선에 붙였고, 걷는 바닥은
     `setShipInterior` 이 **탑승 순간 찍어 둔 박스** 하나였다. 함선이 올라가면 바닥은 땅에 남아 있으니
     컨트롤러가 매 프레임 플레이어를 그 자리로 도로 끌어내렸다 — 그래서 "떨어졌다가 나중에 혼자
     올라간다" 였다. 이제 `ExtractionSystem` 이 박스 **하나**를 들고 `ship.update` 직후에 다시 쓴다
     (`Dropship.writeInteriorBounds`). 높이는 박스의 상수가 아니라 **데크 평면**(`floorYAt`)에서 푼다 —
     이륙 상승은 기수를 0.35 rad 들어 올리므로 평평한 높이 하나로는 화물칸 끝에서 0.9 m 를 파고든다.
     `PlayerSystem.lateUpdate` 도 붙어 있는 동안 월드 좌표를 다시 읽는다: `extraction` 이 `player` **뒤에**
     등록돼 있어 카메라만 한 프레임(초속 26 m 에서 약 0.4 m) 뒤처졌다.

  3. **도착할 때의 렉은 조명 개수였다.** three.js 는 보이지 않는 가지를 통째로 건너뛰므로 **숨은 root 밑의
     광원은 세지 않는다** — 함선이 나타나는 그 프레임에 `numPointLights` 가 3 늘고, 그러면 **씬의 모든
     머티리얼이 셰이더를 다시 컴파일한다.** 신호탄(`FlareColumn`)도 광원을 하나 들고 같은 짓을 해서
     카운트다운 시작 때 한 번, 함선 도착 때 또 한 번 얼어붙었다. 이제 둘 다 광원을 **끄지 않고 어둡게만**
     한다: `Dropship.root` 는 영영 보이는 채로 광원 셋을 들고 `body` 가 메시 전부와 표시 토글을 갖는다.
     `core/fx/FlashPool` 이 처음부터 적어 둔 규칙이고, 레이드 내내 광원이 넷 늘어나는 대가는 측정상
     p50 프레임 시간에 잡히지 않는다 (16.7 ms 로 동일).

- **2026-09-09 (탈출 신호소 빛기둥)** — `Console.ts` 의 40 m 홀로그램 빛기둥이 **평상시(idle)에는 꺼진다**.
  맵 어디서나 신호소 자리를 알려 주던 것이라 전장의 안개와 정면으로 충돌했다. `extraction:activated` 뒤
  (`active`, 호박색 점멸)에는 **그대로 켜진다** — 이미 분대 전원이 아는 사실이고 카운트다운의
  랜드마크다. 바뀐 것은 `beacon.visible` 하나뿐이고 근거리 조명 · 화면 · 레버는 그대로다.

- **Phase 7** — `required` excludes suspended members (a ghost cannot board → 미탈출), no consoles when the world has no extraction points (training), a promoted host continues the countdown / ship / boarding from its mirrored state (unchanged in Phase 9)
