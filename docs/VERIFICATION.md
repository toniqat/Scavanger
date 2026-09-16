# Verification procedure

This file only says **what to run and when**. What each smoke checks is in [scripts/README.md](../scripts/README.md);
runner options: `node scripts/verify.mjs --help`.

> **Do not record run results here.** Which checks were green on a given day has no future use, and the smokes are the
> record. Put the result in the `검증:` line at the end of the commit message (the runner's `docs line:` output is that line).

## Order

| Step | Command | Time | When |
|---|---|---|---|
| 1. Static | `npm run typecheck` (`typecheck:server` if you touched the server) | seconds | After every edit |
| 1b. Data | `npm run data:check` | seconds | When you touched `data/*.csv` |
| 2. Feature | `npm run verify` | 1–2 min | After finishing a feature — only the smokes mapped to folders changed in the working tree (`--list` shows the map, `--dry-run` shows what this change picks, `--folders` · `--only` override) |
| 3. Re-check | `node scripts/verify.mjs --rerun-failed` | < 1 min | Only what just failed (`scripts/logs/last-run.json`) |
| 4. Full | `npm run verify:all` | ~18 min | **Once at the end of a work session, and before a merge** — not per commit. An engine/bootstrap path or a wide `src/shared` change makes the runner go full by itself anyway (see below) |
| 5. Release | Run `npm run app:dist` once → check by eye that `release/SCAVANGER/` holds **only** `app/` · `SCAVANGER.exe` · `server.txt` (three entries — builds ship no server) | ~3 min | When you touched `electron/` · `scripts/pack-release.mjs` (the shell and the deploy folder are checked automatically by `smoke-desktop`) |

The runner starts vite and the relay itself (it restarts the relay before `e2e:mp`), runs smokes on 4 GPU lanes, and prints
one line per script plus the `FAIL` lines (full output in `scripts/logs/<name>.log`). On a machine without a GPU use
`SMOKE_GL=swiftshader --jobs 1` (about 10× slower).

## When step 2 becomes step 4

`src/core` · `main.ts` · `index.html` · `vite.config` · `package.json` · `tsconfig` always select everything. `src/shared` is
judged by size: **≤ 2 changed code files and ≤ 3 feature folders** picks the folders that use the changed exports (`.md` is not
counted, and the runner falls back to full if it cannot name a single changed export); anything wider goes full. The reason is
measured, not a guess — a wide shared change is a feature batch that its own folders already map to 91 of 95 smokes, while a
narrow one (a contract commit: 6 files, 1 folder) used to cost the full 18 minutes for 5 smokes' worth of risk.

`node scripts/verify.mjs --dry-run` prints the selection and the reason without running anything — use it when you are not sure
whether a change is about to go full.

The full run grows with the suite — 94 smokes × 40–90 s of simulated time each. **Raising `--jobs` does not shorten it**
(measured: 4 lanes 18 min 30 s vs 8 lanes 20 min 00 s); a smoke waits on `ctx.time`, and below the 20 fps floor set by
`Engine.MAX_DT` the game clock itself slows down, so extra lanes buy contention instead of throughput. If a single run is
suddenly 2–3× slower, something else on the machine is holding the fast cores — re-run rather than tuning. The reasoning and
the numbers live in [scripts/README.md](../scripts/README.md#why-the-run-takes-as-long-as-it-does).

## Several sessions in the same tree

- Separate runners' logs and relay: `--log-dir scripts/logs/<name> --keep-relay`. When you start a shared relay by hand, add `SCAV_DEV_ECONOMY=1`.
- **`--keep-relay` is for a relay you just started, never for one an earlier run left behind.** The runner restarts the relay
  before `e2e:mp` because lobbies from a previous run live for the 5-min grace and hijack quick match; `--keep-relay` suppresses
  exactly that. A `verify:all --keep-relay` on 2026-09-15 turned 4 scripts red (`smoke-trust` 42/68 · `smoke-hangar` 57/58 ·
  `e2e-mp` 138/145 · `smoke-inventory-p6` 180/183); all four passed on a fresh relay with no source change.
- Someone else's save reloads vite and can kill a smoke at any point (`Execution context was destroyed` · `timeout waiting for playing`).
  New scripts call `quietViteHmr(page)`; if it still flakes, re-run after edits have stopped. **Do not fix code based on a red from that state.**
- If the runner reports "vite/relay already up" and grabs the servers of a previous run that is **dying**, you get
  `timeout waiting for boot` · `ERR_CONNECTION_REFUSED` — for boot timeouts suspect the **ports (5273 · 8787)** before the code.
- To learn "was this red there before my change", check out the pre-change commit with `git worktree add`, not `git stash`.

## Known flakes

Read the log first when something fails — a check that fell out of a timing window is usually the harness.

| Smoke | Symptom | Reason |
|---|---|---|
| `smoke-phase3` | `timeout waiting for laser ended` | While the orbital-laser window runs at `timeScale 4`, a newly spawned bug can kill the player; the raid ends and the call list is cleared |
| `smoke-rogue-v2` | grenade explosion timing · `no clear+flat spot found` | On rolls with no open, flat spot the rogue never sees the player — re-run alone (`--only`) |
| `smoke-phase4` | bug↔rogue damage exchange | Faction-clash timing — the exchange does not always happen inside the watched window |
| `smoke-humanoid-ai` | C-24 left/right · raider accuracy · rogue vs android shot count | AI timing — a different assertion fails on each serial re-run |
| `smoke-inventory-p6` | Bag · stash · `primary2` edits silently roll back to the state at ship entry | It is **not** single-client: `hub:enter` connects to the relay and `net:profileLoaded` replaces stash and loadout ~260 ms later (`inventory/parts/ProfileDocs.ts`). A broken link (`ws proxy error: write ECONNABORTED` in `vite.log`) reverts the edits — check the relay before the code |
| `smoke-aim-sway` | `shot lands on the rendered crosshair ray under sway` — a few cm over the allowance | The shot is fired **at a sway peak** (the smoke waits for `|swayYaw| > 1°`), where the angular rate is highest, and the allowance `0.08 m + drop × 1.3` is **metric**, not angular. When the search for a look line lands on distant ground instead of the intended ~25 m (seen at 97 m), the same sub-frame angular lag turns into a much larger miss in metres. Re-run — a different ground hit passes |
| `smoke-library-consumers` and similar | A module-state value set by the smoke is not visible to the app | A long-lived vite's `?t=` stamp makes the module evaluate twice — see the `import('/src/…')` section in [scripts/README.md](../scripts/README.md) |

## Not automated

- **Pointer-lock timing** — the smokes stub the lock, so they cannot see Chromium's rules for granting and revoking it. The
  rules and measurements live in the `src/shared/Input.ts` comment 「Escape 직후의 재잠금은 미룬다」. If you change it, close the
  inventory and map with ESC in the desktop app and check by hand that the camera responds again without a click.
- **The full release folder** — step 5 above.
