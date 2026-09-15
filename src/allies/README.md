# allies/ — android squadmates (`AllySystem`, publishes `ctx.allies`)

Android squadmates: the roster (relay bot members of the lobby, or the local `/android` cheat roster), their ship behaviour
(cockpit bays, standing ready at a launch pod), the raid simulation on the authority (FSM with reaction delays, harness
around the squad leader, raider-style cover combat, looting, deliveries, extraction, rescue), and the `ally` / `allyq` sync.
Contract: `src/shared/allies.ts`, the android section at the end of `src/shared/net.ts`, the android events in
`src/shared/events.ts`. This folder builds no meshes — `player/` draws the bodies from `ctx.allies.getBodies()`.

Design record: docs/DECISIONS.md 「2026-09-15 — 안드로이드 분대원 · 레이드 진입 로딩」.

## Files

| File | Responsibility |
|---|---|
| `AllySystem.ts` | `GameSystem` + `AlliesRef` — contract-commit stub (empty roster, no bodies) |
| `index.ts` | Barrel |

## Recent changes

Last 5 only — older: `git log -- src/allies`.
- 2026-09-15 — Folder created with a stub `ctx.allies` (contract commit).
