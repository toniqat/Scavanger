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
| 4. Full | `npm run verify:all` | ~17 min | **Once at the end of a work session, and before a merge** — not per commit. An engine/bootstrap path or a wide `src/shared` change makes the runner go full by itself anyway (see below) |
| 5. Release | Run `npm run app:dist` once → check by eye that `release/SCAVANGER/` holds **only** `app/` · `SCAVANGER.exe` · `server.txt` (three entries — builds ship no server) | ~3 min | When you touched `electron/` · `scripts/pack-release.mjs` (the shell and the deploy folder are checked automatically by `smoke-desktop`) |

The runner starts vite and the relay itself (it restarts the relay before `e2e:mp`), runs smokes on 4 GPU lanes on the smoke clock (`src/core/README.md`), and prints
one line per script plus the `FAIL` lines (full output in `scripts/logs/<name>.log`). On a machine without a GPU use
`SMOKE_GL=swiftshader --jobs 1` (about 10× slower).

## When step 2 becomes step 4

`src/core` · `main.ts` · `index.html` · `vite.config` · `package.json` · `tsconfig` always select everything. `src/shared` is
judged by size: **≤ 2 changed code files and ≤ 3 feature folders** picks the folders that use the changed exports (`.md` is not
counted, and the runner falls back to full if it cannot name a single changed export); anything wider goes full. The reason is
measured, not a guess — a wide shared change is a feature batch that its own folders already map to 91 of 95 smokes, while a
narrow one (a contract commit: 6 files, 1 folder) used to cost the full run for 5 smokes' worth of risk.

`node scripts/verify.mjs --dry-run` prints the selection and the reason without running anything — use it when you are not sure
whether a change is about to go full.

The full run grows with the suite — 94 smokes × 40–90 s of simulated time each (a smoke waits on `ctx.time`). Every smoke
closes Chrome with `closeBrowser` (`scripts/close-browser.mjs`); a bare `browser.close()` can hold a lane ~2 min after the
test is over, and that stall once took 41 % of the run. `--jobs 6` is faster (12 min 56 s vs 16 min 40 s) but pushes pages
under the 20 fps floor set by `Engine.MAX_DT` and adds timing reds, so the default stays 4. If a single run is suddenly much
slower, re-run before tuning anything. The reasoning and
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
| `smoke-nav` | `seed N unreachable-goal search 28–54 ms` · `long open-ground search 30.8 ms` (213–214/215) | A **wall-clock** bar (`SEARCH_MS_MAX` 25 ms, `smoke-nav.mjs`) on one A\* search, measured with `performance.now()` inside a page that shares the CPU with five other lanes — the smoke clock does not touch it (it moves game time, not the search's own milliseconds). Red in two of three full 6-lane runs on 2026-09-21 and on each `--rerun-failed` that ran it beside other smokes; the graph answers themselves were right every time. A counter bar (nodes expanded) would settle it, but the search exposes none yet. Re-run alone — `--only smoke-nav` |
| `smoke-phase4` | `a later shell landed (enemy:shellLanded radius undefined)` — `fired: 2, live: 1` (61/62) | The second artillery shell is still in the air when the smoke's `waitEv('enemy:shellLanded', 20)` runs out: cadence + flight time sit near the 20 game-second window, so it is on the edge whenever the page is loaded. Red in 3 of 5 full runs on 2026-09-21 (4 and 6 lanes, machine shared with other sessions' tests), green alone twice and in a 4-script A/B **with and without** the smoke clock. Re-run alone — `--only smoke-phase4` |
| `smoke-phase3` | `FAIL laser ends after its duration  the raid ended first …` | While the orbital-laser window runs at `timeScale 4`, a bug that survived the clearing can kill the player; the raid ends and the call list is cleared, so `stratagem:ended` can never arrive. **Not a flake in the laser** — the payload names the real cause (`phase` · `dead` · the emptied `calls`), and a preceding check states whether the raid was still running when the section started. Until 2026-09-19 (B-31) this surfaced as a 60 s `timeout waiting for laser ended`, which said nothing; measured 2026-09-18 at `f23f444` it was red 3 / 3 with the logged state already `phase: "hub"` |
| `smoke-rogue-v2` | grenade explosion timing · `no clear+flat spot found` | On rolls with no open, flat spot the rogue never sees the player — re-run alone (`--only`) |
| `smoke-phase4` | bug↔rogue damage exchange | Faction-clash timing — the exchange does not always happen inside the watched window |
| `smoke-hazard` | 「50초마다 하나씩 더 피어오른다」 (erupted 1) · 「피어오른 발생지 수 = 도형 수」 (2) | The spore sources bloom on a wall-clock schedule (`GROVE_ERUPT_GAP_S`), so under the full 4-lane load of `verify:all` the second bloom can fall outside the watched window. Red only in `verify:all` (2026-09-18, `117abe5`), **57/57 alone** — re-run it on its own |
| `smoke-phase4` | `a later shell landed (enemy:shellLanded radius undefined)` | Artillery timing: by the time the second shell is awaited the piece is back in `chase` 78–87 m out and has stopped firing, so the awaited event never arrives and the payload logs empty. Measured 2026-09-18 at `9e6c01d`: red · red · **green** over three serial runs, green at the parent commit. Re-measured 2026-09-19 at `9477913` (a **comment-only** commit whose `tsc --removeComments` emit is byte-identical to its parent's, so behaviour cannot have changed): red · red · green · red · red over five serial runs, and the logged `dist` drifts every run (86.90 · 86.96 · 87.24 m) — the sim is frame-timing dependent under swiftshader, so **the parent-commit check can itself come up green by luck**; needing more than one green there. Re-measured 2026-09-21 against a `git worktree` of `7ccd1c6`: **red 3 / 8 at the baseline** vs 5 / 7 with the A-18 phase-2 tree (artillery has `navCan 0`, so no nav code runs for it), same signature at 87.24 m. Re-run |
| `e2e-mp` | `A squad panel lists 분대원 in the hub` (178/179; the checks before and after it pass) | The one DOM check in that stretch that is **not** awaited: `e2e-multiplayer.mjs:298` reads `#ui-root .squad` the instant after `waitFor` confirmed the renamed member in `ctx.net.lobby`, so under load the HUD panel can still hold the pre-rename text. Red once in a full-selection `verify` (96 scripts, 4 lanes; 2026-09-19, `51b0446`, fresh relay), **179/179** on `--rerun-failed` at the same commit — re-run, and see `docs/TODO.md` B-26 for the fix |
| `smoke-humanoid-ai` | C-24 left/right · raider accuracy · rogue vs android shot count | AI timing — a different assertion fails on each serial re-run |
| `smoke-inventory-p6` | Bag · stash · `primary2` edits silently roll back to the state at ship entry | It is **not** single-client: `hub:enter` connects to the relay and `net:profileLoaded` replaces stash and loadout ~260 ms later (`inventory/parts/ProfileDocs.ts`). A broken link (`ws proxy error: write ECONNABORTED` in `vite.log`) reverts the edits — check the relay before the code |
| `smoke-aim-sway` | `shot lands on the rendered crosshair ray under sway` — a few cm over the allowance | The shot is fired **at a sway peak** (the smoke waits for `|swayYaw| > 1°`), where the angular rate is highest, and the allowance `0.08 m + drop × 1.3` is **metric**, not angular. When the search for a look line lands on distant ground instead of the intended ~25 m (seen at 97 m), the same sub-frame angular lag turns into a much larger miss in metres. Re-run — a different ground hit passes |
| ~~`smoke-desktop`~~ | ~~`9340/json/version 이 45 초 안에 응답하지 않았다`~~ | **Not a flake — solved 2026-09-20 (TODO E-13, now closed).** The same WinNAT block that took the smoke's relay (8823 → 9823) also covered its **`APP_PORT` 8820**, which was missed at the time. The shell tries `APP_PORT` … `+APP_PORT_TRIES-1`, so all of 8820–8829 came back `EACCES`, no window ever opened, and `/json/version` never answered — the process was alive and listening on 9340 because the *debug* port was never the problem. Ports moved to 9910 · 9912; 50/50 in 14 s instead of 5/6 in 168 s. The shell had been printing ten `app port N is reserved by Windows` lines into the log the whole time and only the one-line FAIL summary hid them, so `bootDiag` now counts them and says so. **First move on any port that binds but never answers, or never binds: `netsh interface ipv4 show excludedportrange protocol=tcp`** — the ranges drift per machine and per boot, and a `*` row is an administered exclusion (still explicitly bindable, like the relay's 8787–8799) while an unmarked one is WinNAT and is not. |
| `smoke-tactical` | `LMB with the shield raised → bashing (implant:bashed hits=1)` (135/136; every check around it passes) | The assertion is `bashing === true && events.length === 1`, and the payload already says the **event fired once with the right hit count** — so what failed is only the `bashing` flag still being up when the state was read. The checks on either side prove the bash itself happened (stamina 100 → 75, the bug 40 → 22 hp, `pushBack` once) and that it cleared on time. Under the 4-lane load of `verify:all` the read lands after `IMPLANT_SHIELD_BASH_SWING_S` has already run out. Red once in `verify:all` (2026-09-21, 97 scripts), **136/136** alone at the same commit — re-run alone, `--only smoke-tactical` |
| `smoke-tactical` | `shader programs 24 → 124 after every tactical FX fired` | The bound is `programs1 − programs0 < 100` and the count now sits **on** it: measured 2026-09-21 against a `git worktree` of `7ccd1c6` (before A-18 phase 2), 122 · 124 over two serial runs — which bug types and FX happen to be on screen when a material first compiles varies per run. Not a leak (the check exists to catch unbounded growth); the bound needs re-measuring, not a re-run |
| `smoke-allies-core` | `the android pinged the enemy it spotted []` — the other 29 checks pass, including the kill right after it | The assertion sits in a race the smoke opens itself: `debugSpawn` and the `resetEv()` that follows are two round-trips, so the android can spot the scavenger and ping **in between** — the event is then wiped and `ALLY_ENEMY_PING_COOLDOWN_S` (10 s) is exactly the `waitSim(10)` that follows, so no second ping can arrive before the scavenger dies. Red under load (`verify:all`, 4 lanes) and on a re-run against that run's long-lived vite; green twice alone at the same commit. Re-run alone — `--only smoke-allies-core` |
| `smoke-fire-zones` | `replica blast at 1.5 m: G-10 22.0 vs frag 0.0` (30/31; every check before and after it passes) | Both numbers are wrong at once, which is the tell: the G-10 window read 22.0 where the blast alone is ~9, and the frag window read **0**. The two measurements are back-to-back `waitSim(0.4)` windows around a 0.05 s fuse (`smoke-fire-zones.mjs:305-321`), so under the 4-lane load one window can swallow damage that belongs to the other and leave the next one empty. Red once in a folder-selected `verify` (7 scripts, 4 lanes; 2026-09-19, `8cecc7b`, on a **comment-only** change whose step-4 proof printed `code changes: 0`), **31/31** twice afterwards — once via `--rerun-failed` and once via `--only smoke-fire-zones`. Re-run **2026-09-20 measured the load correlation.** A second shape appears when only the *G-10* window over-reads: `G-10 13.0 vs frag 36.0` — the frag number is exactly right and the assertion dies on the ratio (36 < 13 × 3), because an extra fire tick landed inside the first window. Across nine runs that day it was red 3× and green 6×, and **every red was during or right after a 97-script run**; idle it was green 4/4 with the change under test and 3/3 with `src/weapons` reverted to HEAD, which is what settles "is it mine" for this one — one green at the parent would not have. **2026-09-20 (the queue-tail pass) found a third shape, and it is not load-correlated at all**: `G-10 9.0 vs frag 4.0` — the G-10 number is **exactly right** (the outer band, 30 × 0.5 × 0.6 = 9) and the **frag** window under-reads, 4.0 where the comment at `smoke-fire-zones.mjs:322` computes 36. It reproduced identically three times, twice of them idle, so `--rerun-failed` does not clear it. What settles it is the emit: `src/weapons` + `src/gadgets` compiled with `--removeComments` are **byte-identical** between HEAD and the change (§4 of the comment-translation plan, `git show bb4eb2c:docs/COMMENT_I18N_PLAN.md`), so the red is the smoke's own timing, not the tree's. The second window is the suspect — it re-`heal`s and re-throws inside one `page.evaluate` and then measures over its own `waitSim(0.4)`, so a frame boundary falling between the heal and the blast costs it most of the damage. Needs a real fix at the assertion (measure the blast, not a window), not another re-run. |
| `net-selftest` | `FAIL B-5: a 4-member squad starting a raid reaches a friend of all four as ONE snapshot (was 4) — 2` (649/650) | `SOCIAL_PUSH_COALESCE_MS` is a **250 ms wall-clock** window and the assertion counts snapshots over `+350 ms` (`server/selftest.ts:2006`). Under the full 4-lane load the four members' `lobby:start` fan-outs straddle the boundary and arrive as 2. Same shape as the `smoke-hazard` row. Measured 2026-09-20: red in the 15-script `src/game` run, 650/650 alone straight after (`--rerun-failed`) |
| `smoke-library-consumers` and similar | A module-state value set by the smoke is not visible to the app | A long-lived vite's `?t=` stamp makes the module evaluate twice — see the `import('/src/…')` section in [scripts/README.md](../scripts/README.md) |

## Not automated

- **Pointer-lock timing** — the smokes stub the lock, so they cannot see Chromium's rules for granting and revoking it. The
  rules and measurements live in the `src/shared/Input.ts` comment 「Escape 직후의 재잠금은 미룬다」. If you change it, close the
  inventory and map with ESC in the desktop app and check by hand that the camera responds again without a click.
- **The full release folder** — step 5 above.
