# src/ui — HUD & menus (`HudSystem`)

Arc Raiders-style minimalist HUD and all full-screen menus. Everything is plain DOM under `ctx.uiRoot`
(no React), styled by `styles/base.css`. Korean text throughout. Components only touch the DOM when a
value actually changes; moving elements use `transform`.

Import via `@/ui` → `HudSystem`, `OBJECTIVE_TEXT`.

| File | Purpose |
|---|---|
| `HudSystem.ts` | `GameSystem` (`name: 'hud'`). Builds two `.hud` layers (overlay: vignette/edge flash/damage arcs/scope; HUD: everything else), the deploy overlay, the tactical map and the four menus. Shows the HUD only in gameplay phases + `deploying`, hides it while `ctx.uiBlockers` has `'menu'` or the player is dead. Drives the default objective flow on `game:phaseChanged` / `extraction:boarded` / `extraction:tick` (emits `ui:objective`). `isMapOpen` getter for debugging. |
| `dom.ts` | Helpers: `el()`, `setText()` (no-op if unchanged), `toggleClass()`, `setVisible()`, `fmtTime()` (MM:SS), `fmtInt()`, `damp()` (frame-rate independent lerp), `rarityColor()`, `escapeHtml()`. |
| `index.ts` | Barrel. |
| `styles/base.css` | Global reset, `#app` / `#game-canvas` / `#ui-root` layout (`pointer-events:none`; children opt in with `.interactive`), palette CSS variables (`--c-accent #ffb347`, `--c-danger #ff4d4d`, `--c-success #4fd17e`, rarity colors), font stack, utilities (`.ui-panel`, `.ui-label`, `.ui-btn`, `.ui-input`, `.keycap`) and all HUD/menu component styles. |
| **hud/** | |
| `hud/Reticle.ts` | Center 4-tick crosshair + dot. Base gap by stance × aim (`ctx.player.stance`: stand 14/7, crouch 10/5, prone 8/4 px hip/ADS), sprinting 18, +2 while moving (`ctx.player.velocity`); blooms on `weapon:fired` (decays). Hitmarker X on `ui:hitmarker` (white = hit, red = kill). Fades out while any UI blocker is active and is fully hidden while the scope overlay shows (`weapon:scopeChanged.scope && aiming`). |
| `hud/Vitals.ts` | Bottom-left: 10-segment health bar with smooth drain and a delayed white "damage ghost", HP number (red < 40 %), thin stamina bar (`.stamina`, polls `ctx.player.stamina/maxStamina`, damped; `.full` dims to 40 %, `.low` < 25 % amber, `.depleted` amber pulse on `player:staminaDepleted`), stim pill (`stim:countChanged`) and grenade pill (`grenade:countChanged`). Reads `ctx.player.hp` each frame. |
| `hud/ScopeOverlay.ts` | `.scope` full-screen sniper overlay (in the overlay layer): radial-gradient black mask with a clear circle (`--scope-r`), lens vignette, 4-arm crosshair with mil-dot ticks, zoom label (`4×`). Shown while `weapon:scopeChanged.scope` is true **and** `player:aimChanged.aiming` and gameplay is active; `.show` toggles (120 ms in / 80 ms out via CSS). Never intercepts pointer events. |
| `hud/Pings.ts` | Middle-mouse pings (`MouseButtons.PING`, 0.3 s cooldown, while gameplay active + pointer locked). Ray from `ctx.camera` (≤ 300 m) vs `ctx.enemies.raycast` / `ctx.world.raycast`, else 120 m along the ray clamped to terrain. Kind: enemy hit → `enemy` (marker follows the enemy while alive); ≤ 2.5 m of a crate → `crate`; ≤ 8 m of a pad → `extraction`; else `ground`. Each ping = projected DOM marker (`.pmarker.<kind>`: icon, label 핑/적/보급/탈출, live distance) + scene beacon (`THREE.Group` of an additive emissive 6 m line + pulsing ground ring; shared geometries, per-ping materials). Max 3 (oldest dropped), expire after `PING_LIFETIME`, fade in the last 2 s. Emits `ping:placed` (position is the live vector) / `ping:removed`. Cleared (and shared geometry disposed) on `game:abort` / `game:newMission`. Exports `PingKind`, `PING_LABEL`, `PING_COLOR`. |
| `hud/WeaponPanel.ts` | Bottom-right: slot tag (1/2), weapon name, large mag count, reserve, ammo-type tag (looked up via `ctx.loot.getWeaponDef`), SVG reload arc (`weapon:reloadStarted/Finished`), low (amber ≤ 25 %) / empty (red) states, flash on `weapon:dryFire`. |
| `hud/Compass.ts` | Top-center heading strip (cardinals + 15° ticks, 3 wrapped copies) scrolled from `ctx.player.getForward()`. Markers for extraction pads (icon + distance), active pad amber, ship triangle; markers clamp to the strip edges. Rebuilt on `world:ready`. |
| `hud/WorldMarkers.ts` | Projects pad centers (and the landed ship) through `ctx.camera` in `lateUpdate`; diamond icon + label + distance, hidden behind the camera / off-screen, fades when < 12 m. |
| `hud/Objective.ts` | Top-left objective panel (`ui:objective {text, subText}`) with swap animation, plus the large digital countdown under the compass (`extraction:tick`; pulses red ≤ 30 s; shows "도착" on `extraction:shipLanded`). Exports `OBJECTIVE_TEXT` (find / countdown / board / liftoffSwitch / liftoff). |
| `hud/InteractionPrompt.ts` | Center-bottom key cap "E" + prompt text and a linear hold-progress bar from `interact:promptChanged`. |
| `hud/Notifications.ts` | Right-center stack (max 6) with kind-colored left border and slide/fade dismiss. Feeds: `ui:notify`, `inventory:itemAdded` (rarity-colored name), `inventory:full`, `enemy:waveStarted` ("적 증원 감지!"), `crate:looted`, `player:stimUsed`, all `extraction:*` milestones. |
| `hud/DamageOverlay.ts` | Directional red arcs around the reticle (`ui:damageIndicator`, `player:damaged {from}`; angle relative to camera yaw, pooled ×6), red edge flash on `player:damaged`, low-HP vignette with heartbeat (< 40 % HP), heavy vignette when dead. |
| `hud/MissionInfo.ts` | Top-right mission timer (`ctx.missionTime`) and kill counter (`ctx.stats.kills`). |
| `hud/DeployOverlay.ts` | Bottom-center "행성 표면 강하 중…" sweep bar, visible during phase `deploying`. |
| **map/** | |
| `map/MapScreen.ts` | Tactical map (`Keys.MAP` = M, toggled in gameplay phases when no other blocker is active; Esc closes via a capture-phase keydown listener with `stopImmediatePropagation` so GameFlow does not pause). `.map-screen.interactive` (hidden via the `hidden` attribute, z-index 40) with a side panel (title 전술 지도, seed, legend, zoom readout, `초기화` reset, hint) and a square canvas (~85 % of viewport height). Static layer built lazily per `world:ready` seed into an offscreen 1024² canvas: 256×256 `getHeightAt` samples shaded by height with NW hillshading and contour lines every 4 m. Dynamic layer every frame while open: 100 m grid with coordinate labels, nests (red triangle + soft radius), crates (square, opened dimmed, tier ≥ 3 amber outline), pads (diamond; active amber + pulsing ring), landed ship (green disc), pings (kind icon + pulsing ring), player arrow (`ctx.player.yaw`; forward = (−sin yaw, −cos yaw)) with a view cone, north badge. Wheel zooms 1×–4× around the cursor, left-drag pans (view clamped to the map). Adds `ctx.uiBlockers` token `'map'` **before** `exitPointerLock()`, emits `ui:mapToggled {open}`; on close re-requests pointer lock (deferred one microtask) when back in gameplay with no blockers. Closes on non-gameplay `game:phaseChanged`, `player:died`, `game:abort`. |
| **menus/** | |
| `menus/MenuBase.ts` | Abstract full-screen menu: scanline backdrop, framed panel with corner accents, `show()/hide()` add/remove `ctx.uiBlockers` token `'menu'` (added before exiting pointer lock, so GameFlow's lock-loss pause does not fire); `button()` helper plays `ui_click`. |
| `menus/TitleMenu.ts` | "SCAVANGER" wordmark, tagline, seed input (numeric or hashed string, blank = random) + "무작위", "임무 배치" → `game:newMission {seed}`, controls grid. Shown when phase is `menu`. |
| `menus/PauseMenu.ts` | Shown on `game:paused {paused:true}`: "계속" (emits `game:paused false`) / "임무 포기" (`game:abort`). |
| `menus/DeathScreen.ts` | "전사" + kills / survival time / crates / damage / lost loot value; "다시 배치" (same seed) / "메뉴로". Shown on `game:over`. |
| `menus/MissionComplete.ts` | "탈출 성공" summary with counting-up loot value (eased, 1.6 s, `ui_equip` chime at end), kills / time / crates / damage; "다시 배치" (same seed), "새 임무" (random seed), "메뉴로". Shown on `game:complete`. |

## Events consumed
`game:phaseChanged`, `game:paused`, `game:complete`, `game:over`, `game:abort`, `game:newMission`, `world:ready`, `player:*`
(incl. `player:staminaDepleted`, `player:aimChanged`), `interact:promptChanged`, `weapon:*` (incl. `weapon:scopeChanged`),
`stim:countChanged`, `grenade:countChanged`, `loadout:changed`, `inventory:itemAdded/full`, `crate:looted`,
`enemy:waveStarted`, `extraction:*`, `ping:placed/removed` (map), `ui:*`.

## Events emitted
`game:newMission {seed}`, `game:abort`, `game:paused {paused:false}`, `ui:objective`, `ping:placed {id, position, kind, expires}`,
`ping:removed {id}`, `ui:mapToggled {open}`, `audio:play {id:'ui_click'|'ui_equip'}` (ping / map / scope sounds are played by
AudioSystem from `ping:placed`, `ui:mapToggled`, `player:aimChanged`).

## Pointer lock etiquette
Anything that opens a full-screen UI adds its `ctx.uiBlockers` token **first** and only then calls `ctx.input.exitPointerLock()`;
GameFlow pauses on any lock loss that happens with no blocker present. When a UI closes back into gameplay it requests the lock
again (map, inventory, pause resume) — deferred one microtask so a synchronous phase change right after the close wins. Chrome
may refuse a re-lock for ~1 s after an Esc-triggered exit; the click-to-lock fallback in `PlayerSystem` covers that.

## CSS added for these features (`styles/base.css`)
`.vitals .stamina(.full/.low/.depleted) .stam-bar .fill`, `.scope(.show) .mask .lens .cross .arm .mil .center .info .zoom`,
`.ping-markers`, `.pmarker(.ground/.enemy/.crate/.extraction) .ico .lbl .dist`, `.map-screen`, `.map-frame`, `.map-side`,
`.map-head`, `.map-title`, `.map-seed`, `.map-legend`, `.map-legend-row .sw`, `.map-foot`, `.map-zoom-row`, `.map-hint`,
`.map-canvas-wrap`, `.map-canvas(.grabbing)`, `.map-north`, `.ui-btn.small`.
