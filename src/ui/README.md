# src/ui — HUD & menus (`HudSystem`)

Arc Raiders-style minimalist HUD and all full-screen menus. Everything is plain DOM under `ctx.uiRoot`
(no React), styled by `styles/base.css`. Korean text throughout. Components only touch the DOM when a
value actually changes; moving elements use `transform`.

Import via `@/ui` → `HudSystem`, `OBJECTIVE_TEXT`.

| File | Purpose |
|---|---|
| `HudSystem.ts` | `GameSystem` (`name: 'hud'`). Builds two `.hud` layers (overlay: vignette/edge flash/damage arcs; HUD: everything else), the deploy overlay and the four menus. Shows the HUD only in gameplay phases + `deploying`, hides it while `ctx.uiBlockers` has `'menu'` or the player is dead. Drives the default objective flow on `game:phaseChanged` / `extraction:boarded` / `extraction:tick` (emits `ui:objective`). |
| `dom.ts` | Helpers: `el()`, `setText()` (no-op if unchanged), `toggleClass()`, `setVisible()`, `fmtTime()` (MM:SS), `fmtInt()`, `damp()` (frame-rate independent lerp), `rarityColor()`, `escapeHtml()`. |
| `index.ts` | Barrel. |
| `styles/base.css` | Global reset, `#app` / `#game-canvas` / `#ui-root` layout (`pointer-events:none`; children opt in with `.interactive`), palette CSS variables (`--c-accent #ffb347`, `--c-danger #ff4d4d`, `--c-success #4fd17e`, rarity colors), font stack, utilities (`.ui-panel`, `.ui-label`, `.ui-btn`, `.ui-input`, `.keycap`) and all HUD/menu component styles. |
| **hud/** | |
| `hud/Reticle.ts` | Center 4-tick crosshair + dot. Blooms on `weapon:fired` (decays), tightens on `player:aimChanged`, widens while sprinting. Hitmarker X on `ui:hitmarker` (white = hit, red = kill). Fades out while any UI blocker is active. |
| `hud/Vitals.ts` | Bottom-left: 10-segment health bar with smooth drain and a delayed white "damage ghost", HP number (red < 40 %), stim pill (`stim:countChanged`) and grenade pill (`grenade:countChanged`). Reads `ctx.player.hp` each frame. |
| `hud/WeaponPanel.ts` | Bottom-right: slot tag (1/2), weapon name, large mag count, reserve, ammo-type tag (looked up via `ctx.loot.getWeaponDef`), SVG reload arc (`weapon:reloadStarted/Finished`), low (amber ≤ 25 %) / empty (red) states, flash on `weapon:dryFire`. |
| `hud/Compass.ts` | Top-center heading strip (cardinals + 15° ticks, 3 wrapped copies) scrolled from `ctx.player.getForward()`. Markers for extraction pads (icon + distance), active pad amber, ship triangle; markers clamp to the strip edges. Rebuilt on `world:ready`. |
| `hud/WorldMarkers.ts` | Projects pad centers (and the landed ship) through `ctx.camera` in `lateUpdate`; diamond icon + label + distance, hidden behind the camera / off-screen, fades when < 12 m. |
| `hud/Objective.ts` | Top-left objective panel (`ui:objective {text, subText}`) with swap animation, plus the large digital countdown under the compass (`extraction:tick`; pulses red ≤ 30 s; shows "도착" on `extraction:shipLanded`). Exports `OBJECTIVE_TEXT` (find / countdown / board / liftoffSwitch / liftoff). |
| `hud/InteractionPrompt.ts` | Center-bottom key cap "E" + prompt text and a linear hold-progress bar from `interact:promptChanged`. |
| `hud/Notifications.ts` | Right-center stack (max 6) with kind-colored left border and slide/fade dismiss. Feeds: `ui:notify`, `inventory:itemAdded` (rarity-colored name), `inventory:full`, `enemy:waveStarted` ("적 증원 감지!"), `crate:looted`, `player:stimUsed`, all `extraction:*` milestones. |
| `hud/DamageOverlay.ts` | Directional red arcs around the reticle (`ui:damageIndicator`, `player:damaged {from}`; angle relative to camera yaw, pooled ×6), red edge flash on `player:damaged`, low-HP vignette with heartbeat (< 40 % HP), heavy vignette when dead. |
| `hud/MissionInfo.ts` | Top-right mission timer (`ctx.missionTime`) and kill counter (`ctx.stats.kills`). |
| `hud/DeployOverlay.ts` | Bottom-center "행성 표면 강하 중…" sweep bar, visible during phase `deploying`. |
| **menus/** | |
| `menus/MenuBase.ts` | Abstract full-screen menu: scanline backdrop, framed panel with corner accents, `show()/hide()` add/remove `ctx.uiBlockers` token `'menu'` and exit pointer lock; `button()` helper plays `ui_click`. |
| `menus/TitleMenu.ts` | "SCAVANGER" wordmark, tagline, seed input (numeric or hashed string, blank = random) + "무작위", "임무 배치" → `game:newMission {seed}`, controls grid. Shown when phase is `menu`. |
| `menus/PauseMenu.ts` | Shown on `game:paused {paused:true}`: "계속" (emits `game:paused false`) / "임무 포기" (`game:abort`). |
| `menus/DeathScreen.ts` | "전사" + kills / survival time / crates / damage / lost loot value; "다시 배치" (same seed) / "메뉴로". Shown on `game:over`. |
| `menus/MissionComplete.ts` | "탈출 성공" summary with counting-up loot value (eased, 1.6 s, `ui_equip` chime at end), kills / time / crates / damage; "다시 배치" (same seed), "새 임무" (random seed), "메뉴로". Shown on `game:complete`. |

## Events consumed
`game:phaseChanged`, `game:paused`, `game:complete`, `game:over`, `game:abort`, `world:ready`, `player:*`,
`interact:promptChanged`, `weapon:*`, `stim:countChanged`, `grenade:countChanged`, `loadout:changed`,
`inventory:itemAdded/full`, `crate:looted`, `enemy:waveStarted`, `extraction:*`, `ui:*`.

## Events emitted
`game:newMission {seed}`, `game:abort`, `game:paused {paused:false}`, `ui:objective`, `audio:play {id:'ui_click'|'ui_equip'}`.
