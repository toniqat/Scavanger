# src/extraction — Extraction sequence (`ExtractionSystem`)

Switch consoles on every landing pad → 60 s countdown (`EXTRACTION_COUNTDOWN`, 2026-09-09: was 120 s) with a signal flare → procedural dropship flight-in and
landing → boarding volume → interior liftoff switch → doors close and the ship departs. Emits every `extraction:*`
event; `GameFlowSystem` owns the phase transitions and EnemySystem subscribes to `extraction:activated` /
`extraction:liftoff` for its waves. All geometry is procedural (no assets).

Import via `@/extraction` → `ExtractionSystem`, `ExtractionConsole`, `Dropship`, `ParticlePool`, `FlareColumn`, `DustRing`.

| File | Purpose |
|---|---|
| `ExtractionSystem.ts` | `GameSystem` (`name: 'extraction'`). On `world:ready` builds one `ExtractionConsole` per `ctx.world.getExtractionPoints()` (none at all when the list is empty — the 훈련장 arena) (5 m from pad center toward `yaw`, on the platform top) and registers `Interactable` `extract_<id>` (radius 2.6, hold 1.2 s, prompt "탈출 신호 전송 (E 길게)", only in phase `playing`). Activation (`activate()` → `beginActivation()`): console → amber/blink, other consoles off, flare starts, `extraction:activated`, `audio:play extract_activate`. Countdown emits `extraction:tick` every frame, `countdown_beep` in the last 10 s; at 12 s left `extraction:shipIncoming` + ship approach (authority only). Touchdown → `camera:shake`, `ship_land`, `extraction:shipLanded`, registers `ship_liftoff_switch` (hold 1.0 s, "이륙 스위치 작동 (E 길게)" when ready, otherwise "탑승 대기 중 (n/m)" in multiplayer; only when boarded in phase `shipLanded`). Boarding: player XZ inside the bay → `extraction:boarded` + `player.setShipInterior(shipBounds)`; leaving clears it. **`shipBounds` is one object rewritten every frame** (`ship.writeInteriorBounds(out, player.position)`, right after `ship.update`) so the deck travels with the ship. Liftoff: `player.setControlsEnabled(false)`, `player.attachTo(ship.root)` (multiplayer: only if the local player is boarded and alive → `riding`; a boarded non-rider gets `setShipInterior(null)` instead of being dragged up), `extraction:liftoff`, `ship_liftoff`; ramp closes → `extraction:doorsClosed`. Resets on `game:abort` (everything) and `game:newMission` (keeps pads that already belong to the new seed — `world:ready` fires synchronously before this handler). Multiplayer section below. |
| `Console.ts` | `ExtractionConsole`: base plate, pedestal with canvas-generated hazard stripe, slanted panel with emissive screen, big hazard-striped lever (tweens down when activated), status lamp on a mast, 40 m additive holographic beacon shaft, point light. States `idle` (blue pulse) / `active` (amber blink) / `off`. `interactPoint` is the interactable position. **2026-09-09 — the beacon shaft is off while `idle`.** A 40 m column told the whole map where every 신호소 was, which is exactly what the 전장의 안개 (`world/Fog`) takes away: a pad has to be walked into now, and `ui/map` + `hud/WorldMarkers` + `hud/Compass` gate it on `FogRef.isDiscovered`. The shaft comes **back on** in `active` — by then the squad knows and the countdown wants a landmark. Only `beacon.visible` changes: the pedestal light, screen, lamp and lever are untouched, so the console still reads from close up (which is what makes it 발견 in the first place). |
| `Ship.ts` | `Dropship`: `forceLand(pos, yaw)` snaps straight to `landed` (multiplayer client fallback). ~14 m "Pelican"-style hull (**shell of four slabs + a front cap — the rear is a real hole**, top deck, spine, wedge nose + cockpit glass, chin, tail fins/plane), wings with two nacelles, flickering additive blue thrust cones + engine lights, 3 retractable landing legs, amber landing lights, hinged rear ramp (1.5 s open/close — **the only thing that closes the rear**), lit interior bay (floor at local y=0, walls/ribs/benches, ceiling light strip, red interior switch console on the far wall). **`root` = transform + the 3 point lights and is always visible; `body` = every mesh and carries the visibility toggle** (see 변경 이력 2026-09-10). States `hidden → approach → descend → landed → liftoff`. `startApproach()` flies a curved, banking, decelerating path from 300 m out / 130 m up over the pad, hovers at 24 m then descends with wobble; `beginLiftoff()` closes the ramp, spools engines, then climbs and accelerates toward the nose. Exports bay constants, `containsWorldPoint()`, `floorYAt(x, z)` (deck plane — the deck tilts), `writeInteriorBounds(out, at?)` / `getInteriorBounds()` (rotation-safe world AABB), `interiorSwitchWorld`. Local −Z is the nose; the ramp faces +Z (toward the console). |
| `Particles.ts` | `ParticlePool` — CPU-simulated point sprites in one draw call (custom ShaderMaterial: soft round sprite, life fade, color lerp, gravity/drag/growth). `FlareColumn` — red smoke + amber embers + flickering glow rising from the active pad for the whole countdown; **its `group` is never hidden** (it holds a point light — see 변경 이력 2026-09-10), `shown` gates the work instead. `DustRing` — radial ground dust blown outward during descent and liftoff. |
| `index.ts` | Barrel. |

## Timeline (seconds remaining)
120 → activation · 12 → `shipIncoming`, approach (8 s) · ~4 → descent (4.2 s) · 0 → touchdown, ramp opens ·
board → interior switch → liftoff: ramp closes 1.5 s (`doorsClosed`), climb/accelerate; `GameFlowSystem` completes the mission 6.5 s after `extraction:liftoff`.

## Multiplayer (host-authoritative; everything gated on `ctx.isMultiplayer`, so single-player is unchanged)
Pads/consoles are built identically on every client (deterministic world). `ctx.net` may be null → always null-checked;
net subscriptions are made lazily (`ensureNetHooks()` on `world:ready` / `update`) and dropped on `game:abort` / `dispose()`.

| Step | Host (`ctx.isAuthority`) | Client |
|---|---|---|
| Console E | `activate()` → `ex activated {padId, duration}` to others | `exq activate {padId}` to host (no local countdown until `activated` arrives) |
| Countdown | local tick every frame; `ex tick {remaining}` every 0.5 s | `activated` → `beginActivation()` (same visuals/flare/`extraction:activated`); decrements locally, snaps to each `tick`; never calls the ship |
| Ship | `callShip()` → `ex shipIncoming {eta}` | `shipIncoming` → `ship.startApproach()` + `extraction:shipIncoming` |
| Landing | touchdown → `onShipLanded()` → `ex shipLanded` + initial `ex boarding` | local touchdown → `onShipLanded()`; if the host's `shipLanded` arrives and the local ship has not landed within 1 s → `ship.forceLand()` |
| Boarding | local volume → `boardedPeers` add/remove `localId`; `exq board` from clients → set → `ex boarding {boarded, required}` + `ui:notify "n/m 탑승"` | local volume → `exq board {inside}` + `setShipInterior`; `boarding` → n/m + ready flag for the switch prompt |
| Interior switch | `liftoff()` when gate passes; `exq liftoff` uses the same gate | `exq liftoff` to host; prompt from the latest `boarding` |
| Liftoff | `liftoff()` → `ex liftoff` | `liftoff` → `ship.beginLiftoff()`, attach + lock the local player only if boarded and alive, `extraction:liftoff` |
| Reset | `resetMission()` → `ex reset` (when a flow was active) | `reset` → `resetMission(false)` |

**Liftoff gate**: `required` = local player if alive + every remote `RemotePlayerRef` with `connected && !stale && !isDead`;
liftoff is allowed when `required` is non-empty and every required id is in `boardedPeers` (plus the presser must be boarded,
phase `shipLanded`, not already lifting). `net:peerLeft` removes the peer from `boardedPeers` and re-broadcasts.
`player:died` stops the flare only in single-player; `game:paused` is not subscribed here, so a host pause menu never stops the countdown.

## Rejoin sync (appended 2026-09-05)
A client that (re)enters a running mission has no extraction state. When its phase goes `deploying → playing`
(hellpod landed) and it is a non-host session member, it sends `exq sync` to the host; the host replies to that
peer only with `ex sync {state: ExtractionSyncState}` (`stage` idle / countdown / shipIncoming / shipLanded / liftoff,
`padId`, `remaining` = countdown or ETA, `boarded`, `required`). On a normal start the host answers `idle` (no-op).
The client applies the state by running the normal entry paths in order so GameFlow sees the usual events:
`beginActivation(pad)` + `countdown = remaining` (→ `extraction:activated`), then `callShip()` for `shipIncoming`,
`forceLandNow()` + boarding numbers for `shipLanded` (→ `extraction:shipLanded`), and additionally `liftoff()` for
`liftoff` (the ship is already leaving; the rejoiner is not boarded, keeps its controls and reaches the result
screen via GameFlow). If a flow is already active locally only the countdown / n-m numbers are refreshed.
`collectRequired` also skips remote refs flagged `IN_HUB` (peers walking the shared ship never block the liftoff).

## Phase 2 (2026-09-05)
- Liftoff gate: downed (`PlayerFlags.DOWNED` / `ctx.player.isDowned`) players are treated like dead ones — not required, not counted.

## Phase 7 (2026-09-06)
- **Liftoff gate**: `collectRequired` also skips `RemotePlayerRef.suspended` members (socket down, host-simulated ghost) — they cannot board, so they neither block
  nor count as extracted. Host: `net:peerSuspended {suspended:true}` drops the peer from `boardedPeers` and re-broadcasts `boarding`.
- **Host takeover** (`net:hostChanged`): the new host promotes its client mirror (`activePad / countdown / shipCalled / landed / lifting` are the same fields on both
  sides) to authority — the countdown keeps ticking and is now broadcast, the ship continues its flight, `boardedPeers` is rebuilt from the last `boarding` / `sync`
  list (`lastBoarded`) + the local bay state, minus refs that are gone or suspended; one `tick` (and `boarding` when landed) is sent right away. Every other client
  (incl. the demoted host) sends `exq sync` to the new host and applies the reply (numbers only when its flow is already active).
- **훈련장**: `buildPads()` returns early when `getExtractionPoints()` is empty → no consoles, no countdown, no ship, no waves.

---

## 변경 이력

프로젝트 전체 이력은 [docs/HISTORY.md](../../docs/HISTORY.md) 에 있다.

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
