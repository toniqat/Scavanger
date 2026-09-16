# extraction/ — extraction consoles, countdown, dropship landing, boarding, departure

`ExtractionSystem` (`name: 'extraction'`) publishes `ctx.extraction` (`ExtractionRef`, `src/shared/extraction.ts`) and
emits every `extraction:*` event; `game/` owns the phase transitions. Flow: console → countdown + flare → dropship lands
with a solid hull → boarding → idle timer or interior switch → uncancellable grace → the ship leaves with whoever is
aboard and alive. No defense waves. Host-authoritative in multiplayer. All geometry procedural.

## Files
| File | Responsibility |
|---|---|
| `ExtractionSystem.ts` | Pads + console interactables (`extract_<id>`), countdown, ship call, touchdown, switch `ship_liftoff_switch`, idle/grace, boarding, `liftoff`, left-behind reset, corpse riding, wire, rejoin, host takeover, tutorial entries |
| `Ship.ts` | `Dropship` mesh + states `hidden → approach → descend → landed → liftoff`; bay exports (`BAY_*`, `GROUND_DRAW_LIFT_MAX`, `LIFTOFF_SPOOL_S`, `floorYAt`, `writeInteriorBounds`, `bayToWorld`, `nearGround`) |
| `Hull.ts` | `ShipHull`: eight ship-local `Obstacle.box` colliders while landed; `keepEnemyOut`, `inBay` |
| `Cinematic.ts` | `DepartureCinematic`: `ui:cinematic`, chase-camera blend (`EXTRACTION_CINEMATIC_BLEND_S`), hard cut back |
| `Console.ts` | `ExtractionConsole`: pedestal, lever, lamp, point light, beacon (visible only when `active`) |
| `ShipGreebles.ts` | Outer-skin detail merged per existing hull material (no new materials/lights, nothing in bay or ramp arc) |
| `Particles.ts` | `ParticlePool` (CPU point sprites, one draw call), `FlareColumn`, `DustRing` |
| `index.ts` | Barrel |

## Timeline
Numbers are `data/constants.csv` keys.
1. Hold E on a console (`탈출 신호 전송 (E 길게)`) → `extraction:activated`, flare on, other consoles off.
2. `EXTRACTION_COUNTDOWN` (`extraction:tick`); 12 s left → `extraction:shipIncoming` + approach.
3. Touchdown → hull registered, ramp open, `extraction:shipLanded`, idle `EXTRACTION_AUTO_DEPART_IDLE_S` (`departureTick waiting`).
4. Living boarded player holds the switch, or idle hits 0 → `EXTRACTION_DEPART_GRACE_S` grace (`departureStarted`,
   `departureTick departing`); boarding stays open.
5. `liftoff()` → `extraction:liftoff {aboard, squadDone}`, ramp closes (`doorsClosed`), hull removed at `LIFTOFF_SPOOL_S`.
6. Riders: cinematic, result screen after `EXTRACTION_LIFTOFF_TO_COMPLETE_S` (`game/`). Left behind: `LEFT_BEHIND_RESET_S`
   (+0.5 s on clients) → `departedReset()` → `extraction:reset`, consoles usable again.

Boarding = volume test → `extraction:boarded`; while landed the bay is walked in world mode against the hull. A rider
switches to the moving bay box only at liftoff (`setShipInterior`, `setControlsEnabled(false)`, `attachTo(ship.root)`).
Corpses in the bay attach to the deck (`CorpsesRef.attachCorpse`) and leave with it. Downed = dead; suspended and
`IN_HUB` members are not required. No pads (training arena) → nothing is built.

## Public API
- `ctx.extraction`: `stage`, `departRemaining`, `idleRemaining`, `riding`, `isInShipBay(p)`, `keepEnemyOut(p, r)`;
  tutorial-only `beginPreLanded(pos, yaw, {autoDepart})`, `skipToLiftoff()`, `skipToComplete()`; `holdFire()` (always false).
- Androids (2026-09-15): `getPads()` → `{id, position}` per pad (reused array; `position` = the standing spot
  `PAD_STAND_BACK` m in front of the console), `requestActivate(padId)` (authority only, same gate as a console
  press — `playing` and no pad active yet), `boardingPoint(out)` (bay centre on the deck, null unless the ship is
  `landed`). No new flow: `requestActivate` calls the very `activate` a human press does.
- Emits `extraction:activated|tick|shipIncoming|shipLanded|boarded|departureStarted|departureTick|liftoff|doorsClosed|reset`,
  `ui:cinematic`, `camera:shake`, `audio:play`, `ui:notify` (`탑승 n/m`).
- Listens `world:ready`, `game:abort` (full reset), `game:newMission`, `game:phaseChanged`, `player:died`,
  `net:peerLeft`, `net:peerSuspended`, `net:hostChanged`, `corpse:playerSpawned`.
- Callers: `enemies/ai/EnemyAI.ts` (`keepEnemyOut` after `resolveCollision`), `enemies/ai/Common.ts` (`holdFire`),
  `tutorial/` (tutorial entries), `game/parts/Death.ts` (`isTutorialSkipLiftoff`).

### Wire (`ex` host → clients, `exq` client → host)
| Step | Host | Client |
|---|---|---|
| Console | `ex activated {padId, duration}` | `exq activate`; waits for `activated` |
| Countdown / ship | `ex tick` (0.5 s), `ex shipIncoming {eta}` | mirrors; never calls the ship |
| Landing | `ex shipLanded` + `boarding` + `wait` | own touchdown; `forceLand()` if 1 s late |
| Boarding | `ex boarding {boarded, required}` | `exq board {inside}` |
| Switch / grace | `ex depart {remaining, auto}` (0.5 s) | `exq liftoff` (host: landed, not departing, sender boarded) |
| Liftoff / reset | `ex liftoff {riders, squadDone}`, `ex reset` | riding decided locally; a rider ignores later `ex` |

Rejoin: `exq sync` → `ex sync {state}` (`ExtractionSyncState`); the client replays the normal entry paths so `game/`
sees the usual events. Host takeover promotes the mirror fields, rebuilds `boardedPeers`, rebroadcasts timers.

## Rules
- Liftoff does not end the raid: only `squadDone` (someone left, nobody alive/required outside) ends it for all;
  otherwise riders `net.leaveMission()` after their result screen and the rest reset — `ExtractionSystem.ts` (`liftoff`).
- The doorway is closed to enemies only, via the `keepEnemyOut` query; never call it for players or projectiles — `Hull.ts`.
- Hull colliders are static and removed when the climb starts (a rising roof box shoves riders sideways) — `Hull.ts`.
- Point-light count must never change: `Dropship.root` holds the lights and stays visible, `body` toggles;
  `FlareColumn.group` is never hidden — `Ship.ts` (`body`), `Particles.ts`.
- The rider's bay box is one object rewritten every frame; the floor is the tilted deck plane (`floorYAt`) — `Ship.ts`.
- The ship origin sits on the ground: anything at local y 0 is coplanar with terrain; fix visuals in the drawn meshes,
  never via `floorYAt` / `BAY_HEIGHT` / `Hull.ts` — `Ship.ts` (coplanar budget).
- The drawn deck clears whatever a world draws above its walk height: `BAY_FLOOR_LIFT − GROUND_DRAW_LIFT_MAX ≥ 0.02`
  and `root.y` never dips below `landPos.y` while on the ground (no landed bob, one-sided spool shake) — `Ship.ts`
  (clearance note), checked by `smoke-extraction`. A world drawing its ground higher raises `GROUND_DRAW_LIFT_MAX`.
- Tutorial paths are gated on `ctx.missionMode === 'tutorial'` and reuse the normal flow:
  - `beginPreLanded` = `forceLand` + silent `onShipLanded`; `autoDepart: false` → no idle timer; no left-behind reset.
  - `game/` accepts `extraction:liftoff` only in `extracting` / `shipLanded`, so `syncPreLandedPhase` emits
    `activated {duration: 0}` + `shipLanded` on the first `playing` frame (markers/music need it; ui filters the toast).
  - The pre-landed switch calls `skipToLiftoff()` (player placed mid-bay, `liftoff()` at once, hull removed); riders get
    `setSceneLock(true, {allowDamage: true, minHp: 1})`, released in `resetMission`.
  - `skipToComplete` emits one `extraction:liftoff {aboard: true, squadDone: true}` without flying; succeeds only if
    `game/` moves to `complete`.

## Recent changes
Last 5 only — older: `git log -- src/extraction`.
- 2026-09-16 — Liftoff switch prompt is `출발 시퀀스 작동` for every ship.
- 2026-09-15 — `Ship.ts` drawn-deck ground clearance (`GROUND_DRAW_LIFT_MAX`, no landed bob); tutorial switch caption `출발 시퀀스 시작`.
- 2026-09-15 — Android hooks: `getPads` / `requestActivate` / `boardingPoint` on `ctx.extraction`.
- 2026-09-15 — `Ship.ts` coplanar budget fixes floor / side wall / ceiling z-fighting.
- 2026-09-15 — Tutorial liftoff: riders hit but clamped at 1 hp, hull removed at once, `holdFire` false; `skipToComplete`.
