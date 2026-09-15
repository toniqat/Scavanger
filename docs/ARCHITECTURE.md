# System architecture · mission flow

Split out of [CLAUDE.md](../CLAUDE.md). Per-folder detail is in each folder's `README.md`.

---

## 1. System lifecycle

```ts
interface GameSystem { name; init(ctx); update(dt, ctx); lateUpdate?(dt, ctx); dispose?() }
```

Folders talk through exactly two channels: **`ctx.bus` events** (async notifications) and **`*Ref` interfaces on `ctx`**
(sync queries). Never import another feature folder's internals — only `@/shared`.

### Registration · update order (`src/main.ts`)

```
NetSystem → ProgressionSystem → HousingSystem → WorldSystem → HubSystem → PlayerSystem →
RemotePlayerSystem → ImplantSystem → WeaponSystem → EnemySystem → InventorySystem → MetaSystem →
GadgetSystem → DroneSystem → PickupSystem → StratagemSystem → ExtractionSystem → HudSystem → AudioSystem →
GameFlowSystem → TutorialSystem → ConsoleSystem
```

Registration order is update order, and it matters:

| Position | Why |
|---|---|
| `NetSystem` first | This frame's snapshots must be applied before anyone reads `ctx.net` |
| `ProgressionSystem` second | Almost every system reads `ctx.progression.derived` |
| `HousingSystem` before hub · inventory | The hub builds the personal ship from ship state; inventory reads the stash size |
| `ImplantSystem` before `WeaponSystem` | The same frame's `blocksWeapons` must be current so the gun holsters |
| `MetaSystem` after `InventorySystem` | Buy / sell / deliveries use the bag + stash |
| `GadgetSystem` after `InventorySystem` | `use()` must be able to consume items |
| `DroneSystem` right after `GadgetSystem` | `gadgets.use` hands deployment to it (control input · drone camera · owner-authoritative sync) |
| `TutorialSystem` after the systems it watches, before the console | Progress is event-driven so order barely matters, but `init` attaches the `tutorial` command to `ctx.console` |
| `ConsoleSystem` last | Cheats see the frame's final state. It does not exist at all outside a dev host |

> **Gotcha**: `WorldSystem` generates the world **synchronously inside its own `game:newMission` handler**, so
> `world:ready` fires **before** the `game:newMission` handlers of systems registered after it.
> Never unconditionally `reset()` on `world:ready` — check `ctx.world.seed`.

> **Shader hold**: on `world:ready`, `core/Engine` calls `ctx.shaders.holdForScene()`. From then on the engine is
> `holding`: after the rest of that frame's `game:newMission` handlers run (hub teardown · hellpods · extraction consoles …)
> it compiles the whole scene **right before drawing**, and until the driver finishes **simulation dt is 0 and nothing is
> drawn** (same mechanism as `game:paused {freeze}` — systems keep ticking with dt 0 and network messages are still
> processed). So during a hold `ctx.missionTime` stops while `ctx.time` runs. Ship entry · docking cutscene start · shared
> ship arrival · hangar transitions take the same hold (`hub/parts/Transitions`). `core/LightBudget` keeps the scene's
> point-light count fixed for the whole session — code that adds lights reads the light rule in CLAUDE.md first.

## 2. Game loop (player view)

Game start (new characters begin in the tutorial raid) → personal ship → computer (corporations · contracts) and messenger
(NPC quests) → matchmaking to a shared ship → set target planet → loadout → launch-pod ready → planet → raid → call the ship
at an extraction pad → ship lands → board and depart → results (XP · contracts) → ship.

## 3. Mission flow (events)

1. `GameFlowSystem` emits `game:newMission {seed}` → `WorldSystem` generates **synchronously**, then `world:ready {seed, playerSpawn}`.
2. On `world:ready`: the player drops to the spawn, enemies reset and ambient spawning starts, inventory gives a minimum kit
   (only when empty) and emits `loadout:changed`, extraction builds consoles on `ctx.world.getExtractionPoints()`.
3. Player activates a pad console → `extraction:activated` → HUD countdown, `extraction:tick` every frame. There are no
   defense waves.
4. Countdown ends → `extraction:shipIncoming` → landing → `extraction:shipLanded`; boarding → `extraction:boarded`.
   While landed: `extraction:departureTick` (idle timer, then grace).
5. Interior switch or idle timeout → `extraction:departureStarted` (uncancellable grace) → `extraction:liftoff {aboard, squadDone}`.
   Riders get `game:complete {stats}`; players left behind keep playing and get `extraction:reset` (they can call again).
   Details: [src/extraction/README.md](../src/extraction/README.md).
6. Solo death or squad wipe → `game:raidFailed` then `game:over {stats}`. The result screen emits `hub:enter {ship}` →
   `HubSystem` first emits `game:abort` (if coming from a mission / result phase), builds the ship, then
   `player.setInterior(collider)` + `spawnStanding`, `setPhase('hub')`, `hub:entered`.
   `game:newMission` tears the hub down (`hub:left`). **`ctx.world` is null in the hub.**

## 4. Input gates · UI blockers · cursor

- `ctx.isGameplayActive()` — gate for weapons · pings · map · grenades.
- `ctx.isControlActive()` — gate for movement · stance · interaction · camera (gameplay **or** `hub` phase, and no blocker).

**UI blocker tokens** (`ctx.uiBlockers`; grep `uiBlockers.add(` for the full list): `menu` · `inventory` · `map` · `chat` ·
`hub` (terminal) · `hub:intel` · `hub:match` · `ready` (launch-ready panel — the hub's exit-pod path ignores only this token) ·
`housing` · `housing.cook` · `housing.gym` · `housing.game` · `shipmanage` · `stats` · `tutorial` · `rescuePick` · `console` ·
`COMMUNITY_BLOCKER` · `RESUME_GATE_BLOCKER`. `FREE_CURSOR_BLOCKER` (`cursor`) is exported for contract stability but has no users.

### Cursor = pointer-lock release

A UI screen adds its token and calls `ctx.input.setCursorMode(true, TOKEN)`. That **releases the pointer lock**, so the real
OS cursor comes back and `ui/hud/GameCursor` repaints it with procedurally drawn CSS cursor art. `setCursorMode` is
ref-counted per token.

- Screens **never call `exitPointerLock()` themselves** (`setCursorMode` does) and **never re-lock themselves** (`main.ts` does).
- The pause menu (`menu`) is no exception — `ui/menus/MenuBase` uses the same token.
- Losing the lock **outside** cursor mode (an Escape Chrome does not return, alt-tab back) just leaves the cursor visible.
  The game keeps running, `Input` retries the lock on the next real gesture, and a left click on the canvas is the fallback.
  **Only losing window focus pauses.**
- `shared/Input` filters lock bounces (`LOCK_BOUNCE_GRACE_MS`) and defers re-lock requests right after Escape; see the
  comment 「Escape 직후의 재잠금은 미룬다」 in `src/shared/Input.ts`.

### ESC close stack

A second registry paired with blocker tokens. A screen calls `ctx.escape.push(TOKEN, () => this.close())` **next to**
`uiBlockers.add(TOKEN)`, and `ctx.escape.remove(TOKEN)` next to `delete` (`shared/escape` → `EscapeStack`). One Escape closes
**the topmost screen, in reverse opening order**; only when the stack is empty does the pause menu open — the policy lives
in one place, `game/parts/Phases.escapeKey`.

- Why `shared` knows the order: if every screen polled the key, closing order would follow **system registration order**
  (`main.ts`) and a lower mode could close before the panel on top of it.
- Places that share one token (`hub`) push their own key, e.g. `'hub:terminal'`. Popups with no token can push a key too.
- The innermost popups (quantity picker · context menu · warning popup · settings · key rebinding · chat · console) are not
  on the stack — they swallow Escape in their own **window capture** handler so `Input` never records it.
- The pause menu itself closes on Escape **only in the desktop app** (`isDesktopShell()`, `ui/menus/PauseMenu`).
- If a close function returns **`false`** the entry stays on the stack — the screen only stepped back one level
  (e.g. housing mode putting down the held furniture).

Key layout and cursor details: [CONTROLS.md](CONTROLS.md).

## 5. `src/main.ts` — bootstrap

Starts the Engine and registers systems in the order above. It also:

1. **Relays** the cursor's `onModeChange` onto the bus as `input:cursorModeChanged` (`shared` owns the cursor but has no bus).
2. Is **the only place that re-requests the pointer lock** when the last cursor owner leaves. The only conditions are phase
   (`isGameplayPhase()` or `isHubPhase()`) and not dead — no blocker check. Every screen that uses the cursor is a cursor-mode
   owner, so **the last owner leaving is itself the condition**.
3. Forwards `input.onUserUnlock` to `input:pointerLockLost` (game/ opens the pause menu for it) and applies display settings
   (`ui:displayChanged` → bloom · shadows · resolution scale).
