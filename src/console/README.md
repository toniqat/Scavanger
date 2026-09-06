# src/console — 개발자 콘솔 (dev console / cheats, Phase 6)

Owner system: `ConsoleSystem` (`name: 'console'`), publishes `ctx.console` (`ConsoleRef`, `src/shared/console.ts`).
Registered **last** in `src/main.ts` so it reads every other ref's final state for the frame.
Only a **dev client** gets a console: `enabled = isDevHost()` (page hostname in `DEV_HOSTS` — localhost / 127.0.0.1 / ::1).
On any other host no DOM is built, no key listener is installed and `run/print/open/close` are no-ops (`register`/`getCommands` still work).

| File | Role |
|---|---|
| `ConsoleSystem.ts` | DOM (`.dev-console` under `ctx.uiRoot`: log → suggestion list → input row), ` toggle + Esc/↑/↓/Tab/Enter in a **capture-phase** window listener, blocker `'console'` + pointer-lock etiquette, `run()` parser / dispatcher, output log (`CONSOLE_MAX_LINES`), suggestions (`CONSOLE_SUGGESTIONS_MAX`), history (`CONSOLE_HISTORY_KEY`, `CONSOLE_HISTORY_MAX`, localStorage), Home move cheat in `update()` |
| `console.css` | Bottom bar styling (z-index 90, mono font, line colours by `ConsoleLineKind`) |
| `commands/index.ts` | `builtinCommands(host)` — the list below, in `help` order; `BuiltinHost` = what commands need beyond `ConsoleRef` (`clearLog`, `setMoveCheat`, `moveCheat`) |
| `commands/types.ts` | `BuiltinHost`, `CommandFactory`, helpers `err`, `parseNumber`, `fmt` |
| `commands/help.ts` `clear.ts` `seed.ts` `move.ts` `movecheat.ts` `items.ts` `stat.ts` `skill.ts` `pos.ts` | One built-in each (see table) |
| `index.ts` | exports `ConsoleSystem` |

## Commands (input accepts `/move …` and `move …`, case-insensitive; unknown → red line; all output 한국어)
| Command | Where | Does |
|---|---|---|
| `help [name]` | anywhere | Sorted list `/usage — description`, or one command's usage + description. `complete` = command names |
| `clear` | anywhere | Empties the log |
| `seed <숫자\|문구\|random>` | `hub` phase only | `ctx.hub.setMissionSeed(seed)`; digits → uint32, other text → FNV-1a (same rule as the hub `parseSeed`, copied into `seed.ts`), `random` → null. Non-host in a lobby → `로비 호스트만 …`. Emits `cheat:seed` |
| `move <x>,<y>,<z>` | gameplay phases only | Commas / spaces both split the numbers. `world.isInsideBounds` false → `맵 범위를 벗어났습니다 (±MAP_SIZE/2)`. y below `getHeightAt` snaps to the terrain. `ctx.player.teleport(pos, undefined, snapped)` |
| `movecheat [0\|1]` | anywhere (moves while `isControlActive()`) | Toggle (no arg = flip; `on/off/true/false` accepted). While on and `Keys.MOVE_CHEAT` (Home) is held, `update()` teleports the player along **camera forward** by `MOVE_CHEAT_SPEED × dt` (planet and ship; inside map bounds, y ≥ terrain on the planet). Emits `cheat:moveCheat` |
| `items` | anywhere | Closes the console, then `ctx.inventory.openCatalog()` (the infinite-crate window is inventory's) |
| `stat <id\|이름> <±xp>` | anywhere | `ctx.progression.addStatXp(id, n)`; id = `str/end/per/int/dex`, full id, or 한국어 (근력 …). Prints `근력 7 (312/1852)` from `getStat` / `getStatProgress` / `statXpToNext`. `complete` = aliases + ids + names |
| `skill <id\|이름> <±xp>` | anywhere | `ctx.progression.addSkillXpRaw(id, n)`; 14 ids (`gun_AR` …, case-insensitive) or 한국어 names (the name may contain spaces — the last token is the xp). Prints `사격 · 돌격소총 Lv.3 (40 %)`. `complete` = ids + names |
| `pos` | anywhere | Phase (+ 멀티플레이 / ship / room), feet position, yaw, world seed |

Other folders add commands with `ctx.console.register({ name, usage, description, run, complete? })` (returns the unregister
function; same name replaces). `run` may return a string (green line), `{ error }` (red line), nothing, or a promise of those;
thrown errors become red lines. `console:executed { line, ok, output }` fires after each run with every printed line joined by `\n`.

## Flow
```
` (Keys.CONSOLE, capture listener) ── not open ──▶ open(): uiBlockers.add('console') → input.exitPointerLock() → root shown, input focused,
                                                      console:toggled {open:true}
                                   ── open ──────▶ close(): root hidden, blocker removed, console:toggled {open:false},
                                                      queueMicrotask → requestPointerLock() when isControlActive() and not dead
typing ──▶ 'input' event ──▶ suggestions: no space yet → commands whose name starts with the text (`/usage — description`);
           after `cmd ` → cmd.complete(args) filtered by the current token. Cursor −1 by default.
↑/↓ ──▶ input empty (or already browsing history, or no suggestions) → history (newest first, past the newest = the draft);
        otherwise → suggestion cursor (wraps)
Tab ──▶ apply the cursor suggestion (first when none)        Enter ──▶ apply the cursor suggestion, else submit → run(line)
Esc ──▶ close only the console (stopImmediatePropagation, so GameFlow's pause never sees it)
Home (Keys.MOVE_CHEAT) held + moveCheat + isControlActive() + console closed ──▶ update() teleports along camera forward
```
The ` keydown is `preventDefault`ed so the character never lands in the field; when another text field (chat, terminal name)
has focus the key is left alone. Keys typed into the input stop at the element (never reach `Input`); keys dispatched elsewhere
while the console is open are swallowed in the capture phase so the player does not move.

Events: emits `console:toggled`, `console:executed`, `cheat:moveCheat`, `cheat:seed`. Listens to nothing on the bus (reads refs
directly). Does not close on phase changes — a dev tool stays where it was.

## Verification
`node scripts/smoke-console.mjs` (needs `npm run dev`): dev-host gating (`isDevHost('example.com') === false` via a dynamic import of
`/src/shared/console.ts`), ` open / blocker / Esc close, `mo` → `move` + `movecheat` suggestions with ↑/↓ cursor + Tab, `/move` refused
in the ship, `/seed 42 / random / 문구` (FNV matches), `/movecheat 1` + Home hold → position advances, `/move 10,0,10` on the planet
(y ≥ terrain), `/move 9999,0,0` → range error, `/items` (catalog opens), `/stat` (rise to STAT_MAX / floor at STAT_MIN), `/skill`, `help`, unknown
command, `clear`, history in localStorage + ↑/↓ recall, Esc does not pause, W while open does not move — **63 checks, 0 console errors**
(2026-09-06). Registered in `scripts/verify.mjs` (`smoke-console`). The script parks vite's `vite-hmr` WebSocket in CONNECTING so a
save in another editor cannot full-reload the page mid-run.
