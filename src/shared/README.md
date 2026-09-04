# src/shared — Module contract

Everything every feature folder depends on. Append-only: add new events/fields, never rename or remove.

| File | Purpose |
|---|---|
| `constants.ts` | Map size, extraction countdown, player tuning, `Layers`, `Keys` bindings |
| `types.ts` | `GamePhase`, `MissionStats`, item/weapon defs, `*Ref` interfaces (World, Player, EnemyManager, Inventory, Loot), `Interactable`, `GameSystem` |
| `events.ts` | `GameEvents` map: every bus event name → payload type, grouped by owning module |
| `EventBus.ts` | Typed synchronous emitter (`on/once/off/emit`) |
| `Input.ts` | Keyboard/mouse state with per-frame pressed/released sets, pointer lock helpers. `endFrame()` called by Engine |
| `GameContext.ts` | Shared context: bus, input, interactables registry, scene/camera/renderer, module refs, phase, stats, `uiBlockers`, `isGameplayActive()` |
| `Random.ts` | Seeded RNG (mulberry32) with `range/int/pick/weighted/shuffle/fork` |
| `index.ts` | Barrel export — import via `@/shared` |

## Appended contract (2026-09, stance / weapon classes / ping / map)
- `types.ts`: `WeaponClass` (`AR|SMG|SR|DMR|SG|PISTOL`) + optional `WeaponDef.weaponClass/falloffStart/falloffEnd/falloffMin/adsZoom/scope`; `Stance` (`stand|crouch|prone`); `PlayerRef.stance/isDiving/stamina/maxStamina`; `PlayerWeaponHost.setAimZoom(zoom, scope)`.
- `events.ts`: `player:stanceChanged`, `player:dived`, `player:staminaDepleted`, `weapon:scopeChanged`, `ping:placed`, `ping:removed`, `ui:mapToggled`, `input:pointerLockLost`.
- `constants.ts`: `PLAYER_MAX_STAMINA`, `PLAYER_CROUCH_SPEED`, `PLAYER_PRONE_SPEED`, `PING_LIFETIME`; `Keys.CROUCH` is now `KeyC`, plus `Keys.PRONE` (`KeyZ`), `Keys.DIVE` (`AltLeft`), `Keys.MAP` (`KeyM`); `MouseButtons` (`FIRE 0 / PING 1 / AIM 2`).
- `Input.ts`: Alt keydown and middle-click (while locked) are `preventDefault`ed; `lastLockRequest` timestamps the last pointer-lock request so GameFlow can tell a denied re-lock from a real Esc exit.
