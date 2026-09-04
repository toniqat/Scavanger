# SCAVANGER — Project Command Center

Helldivers 2-inspired third-person extraction shooter in the browser. Three.js + Vite + TypeScript.
Arc Raiders-style minimalist UI, Diablo 2-style grid inventory, procedural maps, 120 s extraction countdown.

## Commands
```
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit (must pass before you finish)
npm run build
```

## Stack & conventions
- Three.js 0.185, TypeScript strict, ES modules, path alias `@/` → `src/`.
- **No external asset files.** Every model (player, bugs, crates, ship, props) is built procedurally from Three.js geometry in code. No GLTF, no textures on disk; use procedural CanvasTexture / shader if needed.
- All HTML UI lives in DOM under `ctx.uiRoot` (`#ui-root`), styled with CSS in `src/ui/styles/`. No React.
- Korean UI text (게임 내 텍스트는 한국어).
- Each feature folder has a `README.md` describing its files. Update it when you change the folder.
- Never edit `src/shared/*` without coordinating — it is the contract every module depends on. If you truly need a new event/field, add it (append only, never rename/remove).
- Use `ctx.bus` events for cross-module communication; use the `*Ref` interfaces on `ctx` for synchronous queries. Never import another feature folder's internals; only `@/shared`.
- Reuse `THREE.Vector3` scratch objects; avoid per-frame allocations in hot paths.
- Dispose geometries/materials you create when a mission is reset (`game:abort`, `game:newMission`).

## Feature → folder map

| Folder | Owner system | Publishes on ctx | Responsibility |
|---|---|---|---|
| `src/shared/` | — | `GameContext`, `EventBus`, `Input`, `Random`, types, events, constants | Contract. Read first. |
| `src/core/` | `Engine` | scene/camera/renderer | Renderer setup, lighting, sky, fog, postprocess, main loop, resize, system registry |
| `src/player/` | `PlayerSystem` | `ctx.player` | Third-person controller, camera rig (over-shoulder, no head-bob, ADS zoom/scope pull-in), procedural soldier model (stand/crouch/prone/dive poses), health, stims, **stamina**, stances (C crouch / Z prone / Alt dive), interaction (E), hellpod drop-in |
| `src/weapons/` | `WeaponSystem` | — | Primary/secondary weapons, hitscan/projectiles, tracers, muzzle flash, impacts, recoil/spread scaled by stance×ADS, distance damage falloff, SR bolt cycle + 4× scope (`setAimZoom`, `weapon:scopeChanged`), reload, grenades, listens `loadout:changed` |
| `src/world/` | `WorldSystem` | `ctx.world` | Procedural terrain (heightfield), biome palette, props/obstacles, crates (mesh + interactable), extraction pads, bug nests, spawn queries, collision, terrain raycast |
| `src/enemies/` | `EnemySystem` | `ctx.enemies` | Terminid-style bugs (5 types), procedural animated models, AI (idle/patrol/alert/chase/attack), ambient spawning, extraction waves, hit reactions, deaths, gore FX |
| `src/items/` | (data) | `ctx.loot` | Item & weapon definitions (classes AR/SMG/SR/DMR/SG/PISTOL, falloff, `WEAPON_CLASS_LABEL_KO`), loot tables, `LootRef` impl |
| `src/inventory/` | `InventorySystem` | `ctx.inventory` | Diablo 2 grid model (multi-cell items, rotation R, stacks), bag UI (Tab), container/loot window, equip slots, emits `loadout:changed` |
| `src/extraction/` | `ExtractionSystem` | — | Extraction switch consoles at pads, 120 s countdown, ship flight-in/landing, boarding volume, ship interior switch, doors close + liftoff |
| `src/ui/` | `HudSystem` | — | Arc Raiders-style HUD (health, **stamina**, ammo, compass, objective markers, prompts, notifications, hitmarkers, damage indicators, stance-aware reticle, `hud/ScopeOverlay`, `hud/Pings` middle-click pings), `map/MapScreen` tactical map (M), menus (title, pause, death, mission complete), `styles/base.css` |
| `src/game/` | `GameFlowSystem` | `ctx.phase` | Phase state machine: menu → deploying → playing → extracting → shipLanded → liftoff → complete / dead; stats; restart; pause on pointer-lock loss / window blur (`input:pointerLockLost`) |
| `src/audio/` | `AudioSystem` | — | Procedural WebAudio SFX (gunfire, hits, bug screeches, UI, ship engines, countdown beeps) & ambient; reacts to bus events |
| `src/main.ts` | — | — | Bootstraps Engine and registers systems in order |

## System lifecycle (contract)
```ts
interface GameSystem { name; init(ctx); update(dt, ctx); lateUpdate?(dt, ctx); dispose?() }
```
Registration/update order in `main.ts`:
`WorldSystem → PlayerSystem → WeaponSystem → EnemySystem → InventorySystem → ExtractionSystem → HudSystem → AudioSystem → GameFlowSystem`

Mission flow via events:
1. `GameFlowSystem` emits `game:newMission {seed}` → `WorldSystem` generates **synchronously** and emits `world:ready {seed, playerSpawn}`.
2. On `world:ready`: Player respawns at spawn (drop-in), Enemies reset & start ambient spawning, Inventory resets to starter loadout and emits `loadout:changed`, Extraction builds consoles at `ctx.world.getExtractionPoints()`.
3. Player presses a pad switch → `extraction:activated` → Enemies `startExtractionWaves`, HUD countdown, `extraction:tick` every frame.
4. Countdown ends → `extraction:shipIncoming` → ship lands → `extraction:shipLanded`; player boards (`extraction:boarded` when inside).
5. Player presses ship switch → `extraction:liftoff` → doors close → ship rises → `game:complete {stats}`.
6. `player:died` → `game:over {stats}`. Menus call `game:newMission` again or `game:abort`.

`ctx.isGameplayActive()` gates all gameplay input (false when a UI blocker like the inventory is open). Systems that open UI add their `ctx.uiBlockers` token **before** `ctx.input.exitPointerLock()` and re-request the lock when they close with no blocker left (inventory, map, pause resume). Any other lock loss during gameplay (Esc, alt-tab, cursor leaving to another monitor) is treated as a pause by `GameFlowSystem`; clicking the canvas re-locks as a fallback.

Key bindings live in `Keys` / `MouseButtons` (`src/shared/constants.ts`): C crouch, Z prone, Alt dive, M map, middle mouse ping. All stance/dive/ping/map keys are ignored unless `isGameplayActive()`.

## Quality bar
AAA feel within a browser: readable silhouettes, strong lighting (sun + hemisphere + fog + bloom-ish glow via emissive), smooth animation (procedural walk cycles, tweened UI), screen shake, hit feedback, particle FX (instanced/points), 60 fps target with up to ~60 enemies. Type-check clean.

## Verification (what was actually tested)
- `npm run typecheck` → 0 errors (TypeScript 7: `tsconfig.json` uses `paths` only, no `baseUrl`).
- `npm run build` → single ~870 kB JS chunk, ~28 kB CSS.
- Headless/headed Chrome smoke tests (puppeteer-core, driving `window.__game` = Engine): title → deploy → hellpod drop → movement + pointer lock → firing/reload/stim/grenade → crate open → container drag/rotate/right-click/take-all → Tab bag → Esc pause → extraction switch → 120 s countdown (fast-forwarded) → ship lands → boarding → interior switch → liftoff → mission complete; death → restart. 0 console errors. ~55 fps at 1600×900 on a laptop GPU.
- Real-mouse test (puppeteer `page.mouse`): title seed input + 임무 배치, pause 계속, inventory drag, death-screen 다시 배치 all clickable. Root cause of an earlier "nothing clickable" bug: the inventory overlay (`.inv-root`, fixed inset:0, z-index 50, pointer-events:auto) was hidden only via the `hidden` attribute, which its own `display:flex` overrode → invisible layer swallowed every click. Fixed with a global `[hidden] { display:none !important }` in `base.css`. Rule: never hide a full-screen layer with opacity alone.
- Debug hooks: `window.__game.ctx` (GameContext), `window.__game.getSystem('extraction'|'player'|'weapons'|…)`.

## 마지막 업데이트
- 2026-09-05: stamina + stances + dive (player), weapon classes/falloff/SR scope (items, weapons), stamina bar/scope overlay/pings/map (ui, new `src/ui/map/`), pointer-lock pause & re-lock (game, inventory), new SFX (audio). Smoke-tested in Chrome by driving `window.__game.frame()` from a timer (hidden tab): C/Z/Alt/M, sprint drain + regen, SR equip → scope overlay + FOV 17.5, ping, bolt fire, lock loss → pause menu. 0 console errors.

## Known follow-ups
- Soldier armor still reads dark in the mossy/toxic-green palette; consider an env map or rim light.
- Dropship hull is boxy up close; more greebles/panel lines would help.
- Ambient enemy pressure and wave sizes are untuned for a real play session.
- Stamina/falloff/recoil numbers are first-pass; tune with real play. Prone crawl animation is minimal.
