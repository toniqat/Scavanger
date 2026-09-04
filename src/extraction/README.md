# src/extraction — Extraction sequence (`ExtractionSystem`)

Switch consoles on every landing pad → 120 s countdown with a signal flare → procedural dropship flight-in and
landing → boarding volume → interior liftoff switch → doors close and the ship departs. Emits every `extraction:*`
event; `GameFlowSystem` owns the phase transitions and EnemySystem subscribes to `extraction:activated` /
`extraction:liftoff` for its waves. All geometry is procedural (no assets).

Import via `@/extraction` → `ExtractionSystem`, `ExtractionConsole`, `Dropship`, `ParticlePool`, `FlareColumn`, `DustRing`.

| File | Purpose |
|---|---|
| `ExtractionSystem.ts` | `GameSystem` (`name: 'extraction'`). On `world:ready` builds one `ExtractionConsole` per `ctx.world.getExtractionPoints()` (5 m from pad center toward `yaw`, on the platform top) and registers `Interactable` `extract_<id>` (radius 2.6, hold 1.2 s, prompt "탈출 신호 전송 (E 길게)", only in phase `playing`). Activation: console → amber/blink, other consoles off, flare starts, `extraction:activated`, `audio:play extract_activate`. Countdown emits `extraction:tick` every frame, `countdown_beep` in the last 10 s; at 12 s left `extraction:shipIncoming` + ship approach. Touchdown → `camera:shake`, `ship_land`, `extraction:shipLanded`, registers `ship_liftoff_switch` (hold 1.0 s, "이륙 스위치 작동 (E 길게)", only when boarded in phase `shipLanded`). Boarding: player XZ inside the bay → `extraction:boarded` + `player.setShipInterior(bounds)`; leaving clears it. Liftoff: `player.setControlsEnabled(false)`, `player.attachTo(ship.root)`, `extraction:liftoff`, `ship_liftoff`; ramp closes → `extraction:doorsClosed`. Resets on `game:abort` (everything) and `game:newMission` (keeps pads that already belong to the new seed — `world:ready` fires synchronously before this handler). |
| `Console.ts` | `ExtractionConsole`: base plate, pedestal with canvas-generated hazard stripe, slanted panel with emissive screen, big hazard-striped lever (tweens down when activated), status lamp on a mast, 40 m additive holographic beacon shaft, point light. States `idle` (blue pulse) / `active` (amber blink) / `off`. `interactPoint` is the interactable position. |
| `Ship.ts` | `Dropship`: ~14 m "Pelican"-style hull (body, top deck, spine, wedge nose + cockpit glass, chin, tail fins/plane), wings with two nacelles, flickering additive blue thrust cones + engine lights, 3 retractable landing legs, amber landing lights, hinged rear ramp (1.5 s open/close), lit interior bay (floor at local y=0, walls/ribs/benches, ceiling light strip, red interior switch console on the far wall). States `hidden → approach → descend → landed → liftoff`. `startApproach()` flies a curved, banking, decelerating path from 300 m out / 130 m up over the pad, hovers at 24 m then descends with wobble; `beginLiftoff()` closes the ramp, spools engines, then climbs and accelerates toward the nose. Exports bay constants, `containsWorldPoint()`, `getInteriorBounds()` (rotation-safe world AABB), `interiorSwitchWorld`. Local −Z is the nose; the ramp faces +Z (toward the console). |
| `Particles.ts` | `ParticlePool` — CPU-simulated point sprites in one draw call (custom ShaderMaterial: soft round sprite, life fade, color lerp, gravity/drag/growth). `FlareColumn` — red smoke + amber embers + flickering glow rising from the active pad for the whole countdown. `DustRing` — radial ground dust blown outward during descent and liftoff. |
| `index.ts` | Barrel. |

## Timeline (seconds remaining)
120 → activation · 12 → `shipIncoming`, approach (8 s) · ~4 → descent (4.2 s) · 0 → touchdown, ramp opens ·
board → interior switch → liftoff: ramp closes 1.5 s (`doorsClosed`), climb/accelerate; `GameFlowSystem` completes the mission 6.5 s after `extraction:liftoff`.
