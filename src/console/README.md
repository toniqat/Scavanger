# console/ — developer console and cheats (dev hosts only)

`ConsoleSystem` (`name: 'console'`) publishes `ctx.console` (`ConsoleRef`, `src/shared/console.ts`). It is registered
**last** in `src/main.ts` so it reads every other ref's final state for the frame. Only a dev client gets a console:
`enabled = isDevHost()` (hostname in `DEV_HOSTS`); elsewhere no DOM is built, no key listener is installed and
`run` / `print` / `open` / `close` are no-ops (`register` / `getCommands` still work). The console never imports
other feature folders — cheats go through public `*Ref` methods or `cheat:*` bus commands.

## Files

| File | Responsibility |
|---|---|
| `ConsoleSystem.ts` | DOM (`.dev-console`: log → suggestions → input), capture-phase key listener, blocker + cursor mode, `run()` parser / dispatcher, log (`CONSOLE_MAX_LINES`), suggestions (`CONSOLE_SUGGESTIONS_MAX`), localStorage history (`CONSOLE_HISTORY_KEY`, `CONSOLE_HISTORY_MAX`), Home move cheat and collider overlay in `update()` |
| `ColliderOverlay.ts` | `colliders` wireframe: obstacles within 30 m of the player (or camera) in one `LineSegments`, rebuilt every 0.25 s; cylinder / box / ramp / hull / bullet bands in distinct colours; depth test off, no lights, visible only in gameplay phases, disposed when off |
| `console.css` | Bottom bar styling, line colours by `ConsoleLineKind` |
| `commands/index.ts` | `builtinCommands(host)` — every built-in in `help` order |
| `commands/types.ts` | `BuiltinHost` (`clearLog`, move-cheat and collider toggles), `CommandFactory`, helpers `err`, `parseNumber`, `fmt` |
| `commands/*.ts` | One built-in each: `help`, `clear`, `seed`, `move`, `movecheat`, `items`, `stat`, `skill`, `gym`, `cook`, `library`, `analyze`, `worm`, `rover`, `crypto` (exported as `cryptoCmd`), `pos`, `colliders` |
| `index.ts` | Barrel (`ConsoleSystem`) |

## Public API

- `ctx.console.register({ name, usage, description, run, complete? })` — returns the unregister function; same name
  replaces. `run` returns a string (success line), `{ error }` (red line), nothing, or a promise of those; throws become
  red lines. Other registrants: `meta/parts/Console.ts` (`credits`, `rep`, `contract`, `implant`, `npc`),
  `tutorial/TutorialSystem.ts` (`tutorial`).
- Emits `console:toggled {open}`, `console:executed {line, ok, output}`, `cheat:moveCheat`, `cheat:seed`,
  `cheat:sandworm` (`worm`), `cheat:rover` (`rover`).
- Consumes `meta:creditsChanged` with `reason: 'revert:console'` → prints a red line (the relay rejected a dev
  `/credits` because it was not started with `SCAV_DEV_ECONOMY=1`).

## Commands

Input accepts `/move …` and `move …`, case-insensitive; output is Korean.

| Command | Where | Does |
|---|---|---|
| `help [name]` | anywhere | List or one command's usage |
| `clear` | anywhere | Empty the log |
| `seed <숫자\|문구\|random>` | `hub` phase, lobby host | `ctx.hub.setMissionSeed` (digits → uint32, text → FNV-1a, `random` → null) |
| `move <x>,<y>,<z>` | gameplay phases | Teleport inside map bounds; y below terrain snaps up |
| `movecheat [0\|1]` | anywhere | While on, holding `Keys.MOVE_CHEAT` moves along camera forward at `MOVE_CHEAT_SPEED` |
| `items` | anywhere | Close console, `ctx.inventory.openCatalog()` (search focus is the catalog's job) |
| `stat <id\|이름> <±xp>` | anywhere | `ProgressionRef.addStatXp` |
| `skill <id\|이름> <±xp>` | anywhere | `ProgressionRef.addSkillXpRaw` (name may contain spaces; last token is xp) |
| `gym [clear [str\|end] \| <str\|end> <±xp>]` | anywhere | Trained-stat status; dev `addTrainedXp?` / `clearGymFatigue?` |
| `cook [plate <요리> [품질 0-5] \| clear]` | anywhere | Current cook session + dining plate; put a plate on my dining table without cooking (`devSetPlate`) or clear it |
| `library [give <seriesId> [권\|all]]` | anywhere | `HousingRef.getLibraryEffects()` summary, or add series items to the stash (`tryAddToStash`, fallback `tryAddItemAnywhere`) |
| `analyze [ff <시간> \| done [uid\|all]]` | anywhere | Analyzer slot status; dev `HousingRef.devAdvanceAnalysis?` (`done` advances by the longest `remainingS`) |
| `worm [뱉기초]` | gameplay, authority, not training | Force the sandworm event under the player |
| `rover [tp\|hp <n>\|speed <배수>\|depart\|arrive]` | gameplay, not training | Rover status / `tp`; the rest need authority |
| `crypto [wallet <coin> <coins> \| cores <uid\|all> <n> \| ff <hours>]` | anywhere | Cluster status; dev `devSetCryptoWallet?` / `devSetClusterCores?` / `devAdvanceMining?` |
| `pos` | anywhere | Phase, ship / room, feet position, yaw, seed |
| `colliders [0\|1]` | anywhere (draws in gameplay) | Toggle `ColliderOverlay` |

## Rules

- Open adds blocker `'console'` **before** `input.setCursorMode(true, 'console')` and keeps the pointer lock; close
  reverses both and does not re-lock (nothing was unlocked). `setCursorMode` is ref-counted per token, so opening over
  another cursor surface leaves it alone. — `ConsoleSystem.ts` (`open`, `close`)
- Keys are handled in a **capture-phase** window listener: the toggle key is `preventDefault`ed, Esc closes only the
  console (`stopImmediatePropagation`, so the pause menu never sees it), keys aimed elsewhere are swallowed while open;
  when another text field has focus the toggle key is left alone.
- Dev-only cheat methods on other refs are optional (`?`); commands check `typeof … === 'function'` and print which
  method is missing instead of throwing.
- Commands use only public refs and bus commands — never import `world/`, `enemies/`, `housing/` internals.
- The console does not close on phase changes.

## Recent changes

Older: `git log -- src/console`.
- 2026-09-16 — `cook give` replaced by `cook plate <요리> [품질]` / `cook clear` (meals are not items).
- 2026-09-15 — `analyze` command; `items` search focus moved into the inventory catalog.
- 2026-09-13 — `crypto` command (dev `HousingRef` mining methods).
- 2026-09-13 — `library` command.
- 2026-09-13 — `rover` (`cheat:rover`) and `worm` (`cheat:sandworm`) commands.