# Key bindings · input contract

Split out of [CLAUDE.md](../CLAUDE.md).
Implementation: [src/shared/constants.ts](../src/shared/constants.ts) (`DEFAULT_KEYS`, `Keys`) · [src/shared/Keybinds.ts](../src/shared/Keybinds.ts) ·
[src/ui/menus/KeybindMenu.ts](../src/ui/menus/KeybindMenu.ts) · [src/ui/menus/ControlsPanel.ts](../src/ui/menus/ControlsPanel.ts)

---

## 1. Rules

- Keys live in the **mutable `Keys` table** (`DEFAULT_KEYS` = factory defaults; `MouseButtons` is derived from `Keys.FIRE / AIM / PING`).
- `Keybinds.ts` saves the player's rebinds to localStorage `scav.keybinds` (`loadKeybinds()` runs once in `main.ts`) and owns the
  action catalogue (`KEY_ACTION_DEFS`: label · group · scope · mouse-only), conflict checks, and display names (`keyLabel`).
  Contextual actions follow another binding through `KEY_ALIASES` (`RESPAWN`/`GIVE_UP` → `JUMP`, `CARRY` → `MELEE`, `GRENADE` → `SHIP_CALL`).
- **Always read `Keys.X` at use time** — never cache a key or its label in a module constant. Displayed labels refresh on
  `input:bindingsChanged`.
- `scav.keybinds` stores **only non-default entries**, so existing saves pick up new default layouts.
- Retired actions in an old save and collisions with new defaults are collected by `loadKeybinds()` (`takeKeybindLoadReport()`)
  and reported once by ui (`ui/menus/keybindNotice`).
- `MENU` (Esc) is fixed and cannot be rebound. No gamepad support.
- Retired bindings kept only as contract (not in `KEY_ACTION_DEFS`, not in settings, read by nobody): `SECONDARY` (Digit3 — the
  secondary weapon slot was removed), `CURSOR` (Alt — the free-cursor feature was removed), `STIM` (H, now `COMMS`).
- Key glyphs in UI are drawn only through `shared/keycap` (`paintKeycap` · `createKeycap` · `renderKeyText` with `{ACTION}` /
  `{ACTION:hold}` tokens); hold keys get the `.kc-hold` chevron.

## 2. Default layout

| Key | Action (`Keys.*`) | Notes |
|---|---|---|
| `W A S D` | Move | |
| `Shift` | Sprint (`SPRINT`) | Drains stamina |
| `Space` | Jump (`JUMP`) · give up while downed · respawn when allowed | |
| `C` / `Z` | Crouch / prone (`CROUCH` / `PRONE`) | Prone works in the ship too |
| `V` | Roll (`DIVE`) | The roll itself refuses in the hub · indoors · at `무거움` weight or above |
| `1` / `2` | Primary I / Primary II (`PRIMARY` / `PRIMARY2`) | Only two weapon slots exist |
| `Q` | Tactical implant (`IMPLANT`) | Instant / hold / hand-held per implant — equipped in the Tab ship screen |
| `X` | Shoulder swap (`SHOULDER`) | Moves the third-person camera to the other shoulder (`CameraRig.shoulderSide`, smooth). The soldier model does not flip; hit resolution is the crosshair line either way. Session-only, not saved. `X` in the inventory (drop) and ship management (retrieve) are cursor screens, so the scopes do not overlap |
| `F` | Melee (`MELEE`) | With a downed ally within `PLAYER_CARRY_RANGE`, a **tap = carry / put down** (E-hold revive is unchanged) |
| `T` | Quick use (`QUICK`) | Tap = item in hand, hold = 8-way wheel (gadgets included). If my remote mines (C4) are still in the world, a tap re-takes the **detonator** when there is no quick slot to use, or when the last item used was C4 and that slot is empty (the wheel has no detonator cell). A drone item stays in hand as a controller after deployment |
| `B` | Throw style toggle for gadgets (`THROW_MODE`) | Overhand ↔ underhand toast (`gadget:throwModeChanged`) |
| `E` | Interact (`INTERACT`) | Tap / hold. Hold prompts get the same chevron on the caption keycap (`interact:promptChanged.hold`) and the progress ring fills on the crosshair — also inside the ship (launch-slot boarding: radial gauge around the dot crosshair) |
| `R` | Reload (`RELOAD`) · pull grenade pin (cooking) · **drone control (hold)** | Holding a drone item (ground · air) for `DRONE_CONTROL_HOLD_S` switches to the drone view; the same hold returns. While controlling, WASD · Shift (ground sprint) · Space (ground jump / air climb) · C (air descend) · mouse drive the **drone**; the PC sits still. Weapons · T · F · Q · G · H are blocked; the middle-click ping fires from the drone view. Being hit or leaving range disconnects. **Ground drone**: aim the lens at a crate · container · corpse · supply crate within range and **hold left click** to scan the best grade inside (world label, squad-shared; aiming away resets the gauge) |
| `G` | Ship-call wheel (`SHIP_CALL`) | Tap = arm / disarm the last call, hold = 4-cell wheel. **The wheel does not open during cooldown** — the four calls share one cooldown (`cooldown` in `data/stratagems.csv`), so there is nothing to pick; only a deny sound + `재충전 n초` toast. HUD: square thumbnail left of the tactical implant (`ui/hud/StratagemPanel`), cooldown fills bottom-up with seconds in the centre |
| `H` | Communication wheel (`COMMS`, hold) | Hold ≥ `COMMS_WHEEL_HOLD_S` to open a radial wheel, push the mouse past `COMMS_WHEEL_DEAD_PX` to pick a cell, **release** to send — a short tap does nothing. Standing: 4 cells (heal needed · extract · my contract · lead the way); **downed: 2 cells** (help me · leave me). Layout and text are owned by `shared/comms.ts`; only `내 계약` fills name and remaining count from `ctx.meta.activeContract`. Cooldown `COMMS_COOLDOWN_S`. Result is one chat line (`request`) plus a toast for remote players. The wheel touches no blocker, pointer lock or ESC stack (like the quick-use and ship-call wheels), so it is not in the key guide |
| `M` | Tactical map (`MAP`) | Needs `isGameplayActive()`. Closes with M, **Tab** or Esc. In the hub, `MAP` also opens ship management |
| `Tab` | Inventory (4-tab screen in the ship) · **close the open screen** (`INVENTORY`) | Tab closes whatever screen or mode is open (map · chat · messenger · terminal · workbench · ship management); the closing screen consumes Tab so the same press does not open the inventory. The bottom-right **key guide** (`ui/hud/KeyGuide`) shows the open screen's keys plus `Tab` · `Esc` `닫기` (hidden in the pause menu and while typing in chat). **Hold keys get a chevron** (`KeyGuideEntry.hold`) |
| `X` (inventory open) | Drop item (`DROP_ITEM`) | `R` rotates the held item (`ROTATE_ITEM`) |
| `Enter` | Chat (`CHAT`) | Enter **sends and keeps the input open** (empty Enter is ignored). Close with **Tab / Esc** — the `Tab 키로 닫기` hint at the right end of the input points at it. Esc on an empty private-chat input first clears the target. Private chats (`개인 대화`, formerly whispers) typed here are stored in the messenger conversation |
| `P` | **Messenger** (ship only) · accept squad invite (hold) (`INVITE`) | Tap toggles; Tab · Esc also close. Tabs `대화` (NPCs · private chats · group rooms) · `친구` · `퀘스트`. With a squad-invite card up, hold to accept (`SQUAD_INVITE_HOLD_S`). Does not open during a raid — quest progress is in the map's (`M`) quest panel |
| `Esc` | **Close the open screen** · pause menu (`MENU`) | Closes **the topmost** open screen (reverse opening order — `ctx.escape` in `shared/escape`, policy in `game/parts/Phases.escapeKey`). Only with nothing to close does the pause menu open. Popups (quantity · context menu · warning popup · settings · key rebinding · chat · console) eat Escape first. **The menu itself closes on Esc only in the desktop app** — in the browser the `게임으로 돌아가기` click doubles as the re-lock gesture |
| Left click | Fire · use · raise grenade (`FIRE`) | **Healing consumables: hold for the item's use time** (crosshair ring). **Combat consumables** (adrenaline · stimulant · stabilizer): 3 s hold, usable at full health. Bow: hold to draw, release to shoot |
| Right click | Aim (ADS) (`AIM`) | While aiming the view sways in a slow figure-8 — size depends on weapon class (`data/aim_sway.csv`), stance (crouch · prone reduce it) and movement; stimulant reduces it. Hand-held gadgets · grenades: underhand toggle. Unique weapons: **secondary fire**, no ADS (bow: right click cancels the draw). **Holding a remote mine (C4): right click detonates all my remote mines** — after placing the last C4 the hand stays a **detonator** (left click refused, right click detonates); once none of my C4 remain in the world the hand returns to the gun |
| Middle click | Ping (`PING`) | Hold + drag. A visible left/right 2-cell wheel appears after a short delay (`ui/hud/PingWheel`) — left = `여기 조심해`, right = `저쪽으로 가자`; **downed**: left = `살려줘`, right = `나를 버려` (`PING_HOLD_KINDS`). There is no ammo request gesture — `H` and middle-clicking an equipped weapon in the inventory cover that. Can also be placed on the map |

### Developer only (dev host)

| Key | Action |
|---|---|
| `` ` `` (`Keys.CONSOLE`) | Developer console |
| `Home` (`Keys.MOVE_CHEAT`) | Fast move along view direction while `/movecheat 1` |

### Ship management (housing) mode

Clicking furniture only **selects** it. `E` or a **left-click hold** enters the move state: left click places · `R` rotates ·
`X` retrieves (cockpit-only furniture cannot be retrieved) · `C` / `Esc` put it back. The room-console path additionally
lists wheel = select and `C` = cancel (`CANCEL_KEY`, fixed, not rebindable). `M` / `Tab` exit. Keys are shown in the
bottom-right **key guide** (`hub/HousingMode` emits `ui:keyGuide {owner:'housing'}`; `ui/hud/KeyGuide` appends `닫기`).

### Inventory · looting · trade screens (mouse)

- **Right click = context menu on every item** — quick move (bag / stash / crate) · favourite on/off, plus the item's own
  entries (equip · quick slot · salvage · split …).
- **Double click = quick move**, with exceptions: weapons · bags · armor equip (an item from a crate/stash only goes to an empty slot — already
  equipped items are never silently replaced); with no crate open, healing
  items · grenades in the bag register to a quick slot.
- Bag / stash grids in corporation trade and furniture screens open the same right-click menu. Item **chips** (quest delivery ·
  craft materials · contract items) and corporation shop tiles: right click = favourite on/off — works for items you do not own.
- Hold an item tile still for a moment to pin its tooltip (`ui:cursorHold` ring); click outside, the diamond, or Esc unpins.

## 3. Responsibilities across folders

- **The weapons folder owns the melee key**, but the swing only happens when `ctx.player.startMelee()` accepts it
  (stamina · cooldown · pose belong to `src/player/`).
- Rolling is refused in the ship; pings and the map need `isGameplayActive()`.
- The mission seed is set **only by the `/seed` console command**.

## 4. Cursor and pointer lock

Screens that use the cursor **release** the pointer lock and use the real OS cursor, repainted with procedural CSS cursor art by
[`ui/hud/GameCursor`](../src/ui/hud/GameCursor.ts).

**No lock does not mean paused.** Only losing window focus pauses. The lock comes back three ways: `main.ts` re-requests it when
the last cursor owner leaves; a denied request retries on the next real gesture (`Input.awaitingLockGesture`); and a **left click on
the canvas** (that click is swallowed, so the click that takes the camera back does not fire the gun).

In fullscreen, `navigator.keyboard.lock(['Escape'])` keeps Escape from breaking the lock. Windowed Chrome gives Escape no user
activation, so closing a screen with Escape leaves the cursor up until the next input, and if the re-lock is refused the game shows
the **`좌측 클릭으로 게임 재개`** gate (`src/game/ResumeGate.ts`). Because Esc closes screens, browser players see this gate more
often — the accepted cost of not splitting controls by environment. **The desktop app has no gate**: the main process hands over
activation on every Escape **key-up** via `executeJavaScript(code, true)` calling `window.__scavShellRelock`, so the camera returns
immediately (`electron/main.ts`). Chromium also refuses any re-lock for about 1.25 s after a user exit; `shared/Input` defers requests
around Escape itself (`LOCK_ESCAPE_DEFER_MS`, `LOCK_USER_EXIT_COOLDOWN_MS`, `LOCK_RELOCK_RETRIES`).

The full UI-blocker and cursor-mode contract is in [ARCHITECTURE.md](ARCHITECTURE.md) section 4.
