# stratagems/ — ship calls (`함선 호출`): G wheel, targeting, shared cooldown, rescue drops

`StratagemSystem` (`name: 'stratagems'`) publishes `ctx.stratagems` (`StratagemsRef`, `src/shared/types.ts`). It owns
the G-key input state machine, the four wheel calls (`STRATAGEM_ORDER`: orbital laser, supply drop, tripod structures,
rescue drop), their procedural effects, destructible cover structures, and the `strat` / `stratq` / `rescue` wire.
It draws no HUD (ui/ renders from events) and no hellpods (`player/` draws rescue pods from `pod drop`).

## Files
| File | Responsibility |
|---|---|
| `StratagemSystem.ts` | System class, `StratagemsRef` getters, bus subscriptions, shared cooldown (`startCooldown` · `tickCooldown` · `refundCooldown` · `emitReady`), `silent`-aware FX helpers, debug hooks; delegates to `parts/` |
| `model.ts` | `Call`, `Structure`, `defOf`, folder-local fixed values (laser tick, drop heights, `GRENADE_STRUCTURE_DAMAGE`, `SHAKE_RANGE` …), scratch |
| `parts/Targeting.ts` | Wheel, LMB charge → top view, ground ring, confirm / cancel, `denyCooldown` |
| `parts/Calls.ts` | Call effects, `impactDamage`, `splashStructures`, supply crate interactable, structures, pause shift (`updateCalls`), `clearAll` |
| `parts/Rescue.ts` | Rescue candidates, arm gate, `rescue req/grant/deny/count`, landing |
| `parts/Wire.ts` | Host relay (`onCallRequest` · `callRefusal`), deny + refund (`sendCallDeny` · `onCallDenied`), late-join `sendSync` / `applySync` / `fastForward` |
| `Visuals.ts` | Procedural meshes/points, no lights: ring, marker, bursts, beam, fireball, crate, barricade, rubble |
| `index.ts` | Exports `StratagemSystem` |

## Input
Runs only when `baseActive()` (gameplay, pointer locked, alive, not downed) and not `player.droneControl` / `roverRide`.
- G tap arms `lastArmed` / puts away; G held `STRATAGEM_WHEEL_HOLD` opens the 4-sector wheel (refused with a toast while
  the cooldown runs). Release arms the hovered call.
- `targeting: 'topview'` (orbital): hold LMB `STRATAGEM_CHARGE_TIME` → straight-down camera override, cursor moved by
  mouse within `TOPVIEW_RANGE`; LMB confirms, RMB returns to armed.
- `targeting: 'ground'`: ring on the aim ray ≤ `GROUND_TARGET_RANGE`; LMB confirms, RMB disarms. `rescue_drop` shows no
  ring until a target is picked (`ui/hud/RescuePicker` → `rescue:selectTarget`).
- Confirm → `Call {incoming, landsAt = time + delay}` + `startCooldown(def.cooldown)`. Weapons do not fire while
  `armed` / `targeting`. Death, downed, non-gameplay phase, or losing host rights on a host-only call puts it away.

## Effects
Every client simulates each call; enemy damage (`ctx.enemies.applyExplosion`) only where `call.local`; each client hurts
only its own player (`impactDamage`, `shared/explosion`, source `{kind:'explosion'}`).
- `orbital_laser` — `LASER_*` beam ticks. `airstrike` — implemented, not on the wheel.
- `supply_drop` — crate lands (`SUPPLY_*`), interactable `supply:<callId>` (`보급 상자 열기`) → `crate:open {tier: SUPPLY_CRATE_TIER}`.
- `structure_drop` — `STRUCTURE_COUNT` barricades from the call `seed`, destructible obstacles; weapons and
  `grenade:exploded` damage them → `structure:damaged` / `structure:destroyed` → rubble.
Numbers: `data/stratagems.csv` (`cooldown`, `delay`, `targeting`, `radius`) + the keys above in `data/constants.csv`.

## Rescue drop
Squad-wide `RESCUE_DROPS_PER_RAID`, host-owned. Candidates = lobby members; only the dead are `selectable`
(`ctx.corpses` may be absent — optional chaining). Host grant spends one charge (no refund on cancel), picks the landing
point with `world.scatterPoints(…, RESCUE_SCATTER_RADIUS, 1, RESCUE_POD_MIN_GAP, seed)` and broadcasts.

## Public API
- `ctx.stratagems`: `armed`, `targeting`, `cooldown`, `cooldownTotal`, `getCalls()`, `structureCount`, `rescueLeft`,
  `rescueAvailable`, `getRescueCandidates()`, `rescueTarget`.
- Emits `stratagem:wheelChanged|armed|chargeChanged|targeting|called|landed|ended|cooldown|ready {refunded}`,
  `structure:damaged|destroyed`, `crate:open`, `rescue:countChanged|called|landed`, `camera:shake`, `audio:play`, `ui:notify`.
- Listens `game:abort` · `game:newMission` · `hub:entered` · `world:cleared` (clear), `world:ready`, `player:died`,
  `player:downed`, `game:phaseChanged`, `crate:looted`, `grenade:exploded`, `rescue:selectTarget`, `net:hostChanged`.
- Wire (`src/shared/net.ts`):
  - `stratq call {callId, kind, p, seed}` → host. `callRefusal`: own unused `callId`, wheel kind (not rescue, not
    `STRATAGEM_HOST_ONLY`), gameplay phase, lobby member, alive, `p` in map within `STRAT_MAX_CALL_RANGE`,
    `callerReadyAt[from] − STRAT_COOLDOWN_SLACK_S` passed. Accept → `strat call {…, eta, by}` to all incl. caller
    (its echo creates the call with `local = true`).
  - `strat deny {callId, reason}` → refused caller only; rescue uses `rescueDenyId(from)`. Forged ids get no answer.
  - `strat structHp` → others (lower hp wins). `stratq sync` → `strat sync {calls}`; landed calls fast-forward under
    `silent`. Rescue calls are not synced — `sendSync` sends `rescue count`.
- Ids: `<localId|sp>-<n>` (rescue `-r<n>`), structures `<callId>:<index>`.
- Debug: `debugCall(kind, pos)`, `debugCooldownReset()`, `refundCooldown()`, `lastCallRefusal` · `lastDenySent` · `lastCallDeny`.

## Rules
- One cooldown shared by all calls, length = confirmed call's csv `cooldown`; personal, never synced. The host keeps
  non-host readiness by wall clock only to validate — `StratagemSystem.ts` (`_cooldown`, `callerReadyAt`).
- Clients accept `strat call|sync` and `rescue grant|deny|count` only from the lobby host (`fromHost`) — `parts/Wire.ts`.
- A deny refunds the full cooldown and is accepted only from the host for `<me>-…` ids — `parts/Wire.ts` (`onCallDenied`).
- `landsAt` uses `ctx.time`; while `dt === 0` (solo pause) pending stamps shift by wall time — `parts/Calls.ts` (`updateCalls`).
- Structure hp and supply loot are per-client; remote calls use the receiver's terrain height.
- Top-view cancel is RMB, not Escape: under pointer lock Escape opens the pause menu, which cancels via `baseActive()`.
- `parts/` import only types from `StratagemSystem.ts`; values live in `model.ts`.

## Recent changes
Last 5 only — older: `git log -- src/stratagems`.
- 2026-09-15 — Player impact and grenade→structure damage use `shared/explosion` two-step falloff.
- 2026-09-15 — Local player impact damage carries `{kind:'explosion'}`.
- 2026-09-13 — Targeting disabled while riding the rover.
- 2026-09-12 — `stratagem:ready {refunded}` when the cooldown reaches 0.
- 2026-09-11 — E-8: `strat deny` to refused callers with full cooldown refund.
