# src/extraction — Extraction sequence (`ExtractionSystem`)

Switch consoles on every landing pad → 60 s countdown (`EXTRACTION_COUNTDOWN`, 2026-09-09: was 120 s) with a signal flare → procedural dropship flight-in and
landing → boarding volume → interior liftoff switch → doors close and the ship departs. Emits every `extraction:*`
event; `GameFlowSystem` owns the phase transitions and EnemySystem subscribes to `extraction:activated` /
`extraction:liftoff` for its waves. All geometry is procedural (no assets).

Import via `@/extraction` → `ExtractionSystem`, `ExtractionConsole`, `Dropship`, `ParticlePool`, `FlareColumn`, `DustRing`.

| File | Purpose |
|---|---|
| `ExtractionSystem.ts` | `GameSystem` (`name: 'extraction'`). On `world:ready` builds one `ExtractionConsole` per `ctx.world.getExtractionPoints()` (none at all when the list is empty — the 훈련장 arena) (5 m from pad center toward `yaw`, on the platform top) and registers `Interactable` `extract_<id>` (radius 2.6, hold 1.2 s, prompt "탈출 신호 전송 (E 길게)", only in phase `playing`). Activation (`activate()` → `beginActivation()`): console → amber/blink, other consoles off, flare starts, `extraction:activated`, `audio:play extract_activate`. Countdown emits `extraction:tick` every frame, `countdown_beep` in the last 10 s; at 12 s left `extraction:shipIncoming` + ship approach (authority only). Touchdown → `camera:shake`, `ship_land`, `extraction:shipLanded`, registers `ship_liftoff_switch` (hold 1.0 s, "이륙 스위치 작동 (E 길게)" when ready, otherwise "탑승 대기 중 (n/m)" in multiplayer; only when boarded in phase `shipLanded`). Boarding: player XZ inside the bay → `extraction:boarded` + `player.setShipInterior(bounds)`; leaving clears it. Liftoff: `player.setControlsEnabled(false)`, `player.attachTo(ship.root)` (multiplayer: only if the local player is boarded and alive), `extraction:liftoff`, `ship_liftoff`; ramp closes → `extraction:doorsClosed`. Resets on `game:abort` (everything) and `game:newMission` (keeps pads that already belong to the new seed — `world:ready` fires synchronously before this handler). Multiplayer section below. |
| `Console.ts` | `ExtractionConsole`: base plate, pedestal with canvas-generated hazard stripe, slanted panel with emissive screen, big hazard-striped lever (tweens down when activated), status lamp on a mast, 40 m additive holographic beacon shaft, point light. States `idle` (blue pulse) / `active` (amber blink) / `off`. `interactPoint` is the interactable position. **2026-09-09 — the beacon shaft is off while `idle`.** A 40 m column told the whole map where every 신호소 was, which is exactly what the 전장의 안개 (`world/Fog`) takes away: a pad has to be walked into now, and `ui/map` + `hud/WorldMarkers` + `hud/Compass` gate it on `FogRef.isDiscovered`. The shaft comes **back on** in `active` — by then the squad knows and the countdown wants a landmark. Only `beacon.visible` changes: the pedestal light, screen, lamp and lever are untouched, so the console still reads from close up (which is what makes it 발견 in the first place). |
| `Ship.ts` | `Dropship`: `forceLand(pos, yaw)` snaps straight to `landed` (multiplayer client fallback). ~14 m "Pelican"-style hull (body, top deck, spine, wedge nose + cockpit glass, chin, tail fins/plane), wings with two nacelles, flickering additive blue thrust cones + engine lights, 3 retractable landing legs, amber landing lights, hinged rear ramp (1.5 s open/close), lit interior bay (floor at local y=0, walls/ribs/benches, ceiling light strip, red interior switch console on the far wall). States `hidden → approach → descend → landed → liftoff`. `startApproach()` flies a curved, banking, decelerating path from 300 m out / 130 m up over the pad, hovers at 24 m then descends with wobble; `beginLiftoff()` closes the ramp, spools engines, then climbs and accelerates toward the nose. Exports bay constants, `containsWorldPoint()`, `getInteriorBounds()` (rotation-safe world AABB), `interiorSwitchWorld`. Local −Z is the nose; the ramp faces +Z (toward the console). |
| `Particles.ts` | `ParticlePool` — CPU-simulated point sprites in one draw call (custom ShaderMaterial: soft round sprite, life fade, color lerp, gravity/drag/growth). `FlareColumn` — red smoke + amber embers + flickering glow rising from the active pad for the whole countdown. `DustRing` — radial ground dust blown outward during descent and liftoff. |
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

- **2026-09-09 (탈출 신호소 빛기둥)** — `Console.ts` 의 40 m 홀로그램 빛기둥이 **평상시(idle)에는 꺼진다**.
  맵 어디서나 신호소 자리를 알려 주던 것이라 전장의 안개와 정면으로 충돌했다. `extraction:activated` 뒤
  (`active`, 호박색 점멸)에는 **그대로 켜진다** — 이미 분대 전원이 아는 사실이고 카운트다운의
  랜드마크다. 바뀐 것은 `beacon.visible` 하나뿐이고 근거리 조명 · 화면 · 레버는 그대로다.

- **Phase 7** — `required` excludes suspended members (a ghost cannot board → 미탈출), no consoles when the world has no extraction points (training), a promoted host continues the countdown / ship / boarding from its mirrored state (unchanged in Phase 9)
