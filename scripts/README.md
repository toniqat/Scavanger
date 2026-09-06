# scripts/

Node scripts for running and verifying the game. None of them are part of the build.

| File | Role |
|---|---|
| `verify.mjs` | **Verification runner** — `npm run verify` (smokes mapped to the folders changed in the working tree) / `npm run verify:all` (everything, before a merge). Runs typecheck (client + server), `net:selftest` and optionally `vite build` in parallel, starts vite (5273) and the relay (8787) when they are not up, restarts the relay before `e2e-mp` (stale public lobbies hijack quick match), runs the smoke scripts in 4 staggered lanes (each owns a headless Chrome on the GPU), then `e2e-mp` alone. Prints one line per script + the `FAIL` lines, full output in `logs/<name>.log`, records `logs/last-run.json` for `--rerun-failed`, and ends with a `docs line:` to paste into `docs/VERIFICATION.md`. `--list` shows the folder → script map (`SMOKES` table at the top — register new smokes there). |
| `dev-all.mjs` | `npm run dev:all`: relay + vite together with prefixed output, Ctrl+C stops both. |
| `e2e-multiplayer.mjs` | `npm run e2e:mp`: two headless Chrome instances through a running relay + vite (hub → quick match → docking → pods → mission → pickups → reconnect → abort). Needs a freshly started relay — use the runner. |
| `smoke-weapons.mjs` | Weapon package: grades, durability, ammo v2, 3 slots, sockets, bags, workbench repair (44 checks). |
| `smoke-phase2.mjs` | Downed / bleed / give-up / respawn, quick wheel, stim in hand, grenade cooking (44). |
| `smoke-quickslots.mjs` | Quick-slot model + real-mouse drag onto the compass rose (45). |
| `smoke-phase3.mjs` | Ship calls: wheel / arm, top-view targeting, airstrike / structures / supply / laser, HUD layers (32). |
| `smoke-stratagems.mjs` | Stratagems folder smoke (51; registers the system itself if `main.ts` has not). |
| `smoke-phase4.mjs` | Rogues, boss, artillery interception, toxic, behemoth armour, factions, corpses (36). |
| `smoke-tactical.mjs` | Tactical kit: implants, gadgets, armor / weight, melee, roll, gather nodes, crafting, progression (45). |
| `smoke-controls-hub.mjs` | Controls diagram + rebinding, hub Tab ship screen (stash / implant slot / repair), terminal, implant gauge (60; `--shots` writes PNGs to `shots/`). |
| `logs/`, `shots/` | Runner output and screenshots (git-ignored). |

Every smoke script takes the vite URL as its first argument (default `http://localhost:5273/`), launches its own headless
Chrome on the **real GPU** (`GL_ARGS`: ANGLE D3D11, 10–50 s per script; `SMOKE_GL=swiftshader` = CPU rasterizer, ~10× slower),
stubs `requestPointerLock` (a real lock would trap the OS cursor in the hidden window — Windows ClipCursor) and fakes
`pointerLockElement`, waits on **simulation time** (`ctx.time`) and dispatches key taps as keydown+keyup in one frame on
`document.body`. `waitFor` defaults to 60 s so four scripts can share the machine. Checks build on each other, so the unit of
re-run is the whole script.
