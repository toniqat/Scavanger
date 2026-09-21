# src/ui/ — all DOM UI: HUD layers, menus, tactical map, chat, messenger (`HudSystem`)

`HudSystem` builds every HTML surface of the game under `ctx.uiRoot` (`#ui-root`, `pointer-events: none`; children opt
in with `.interactive`): the raid and ship HUD, crosshair rings, danger indicators, the fog-gated tactical map, pings,
chat, the messenger panel, and the title / character / pause / settings / result menus. Plain DOM + CSS, no React;
in-game text is Korean. It publishes nothing on `ctx`; other folders reach it only through bus events (`ui:*`).
It draws what other systems decide — it never re-derives gameplay judgements (grapple validity, placement, aim block,
defib target all arrive as events) and it never requests the pointer lock (that is `main.ts`).

Import: `@/ui` → `HudSystem`, `OBJECTIVE_TEXT` (`index.ts`). `main.ts` imports `@/ui/HudSystem` directly.

## Files

| File | Responsibility |
|---|---|
| `HudSystem.ts` | Builds the layers and every component, gates layer visibility per phase (`applyVisibility`), drives `update` / `lateUpdate`, owns the full-screen black fade (`ui:screenFade`) and the extraction cinematic class (`ui:cinematic`), exposes smoke/debug getters |
| `dom.ts` | DOM helpers: `el`, `setText` (no-op if unchanged), `toggleClass`, `setVisible`, `fmtTime`, `fmtInt`, `damp`, `clamp01`, `rarityColor`, `escapeHtml` |
| `index.ts` | Barrel |
| **hud/** | |
| `hud/ActionFeedback.ts` | Pooled CSS screen feedback: melee swipe/hit, dive, dash, barrier hit, grit save, burning, cloak |
| `hud/allySource.ts` | The one reader of `ctx.allies` for this folder (`alliesOf`, `allyRoster`, `allyBodies`, `allyBody`) + the `setDebugAllies` smoke hook |
| `hud/BuffStrip.ts` | Character buff thumbnails (`CharBuff[]`) under the PC vitals (22 px) and each squad row (mini 14 px); pending dim, debuff red border, time gauge; registered in `shared/charBuffView` so the character sheet header borrows an `interactive` strip (ItemTip text-card data instead of `title`) |
| `hud/ChargeGauge.ts` | Ship-call LMB charge ring at the crosshair (`stratagem:chargeChanged`) |
| `hud/ChatLog.ts` | Squad chat log + input (Enter opens, sends and stays open; Tab/Esc closes), `/r` reply to the last private chat, hides lines from blocked peers, relays `chat:post` |
| `hud/CheatTag.ts` | `MOVE CHEAT` corner tag (`cheat:moveCheat`) |
| `hud/CommsWheel.ts` | `H`-hold communication wheel (`Keys.COMMS`): reads its own input, sends `comm`, posts chat/toast |
| `hud/Community.ts` | Ship-only top-right messenger thumbnail with unread badge; owns the panel frame (blocker, cursor, Escape, key guide), `Keys.INVITE` tap = toggle / hold = accept squad invite stack, NPC contact toasts, squad-leader transfer row menu |
| `hud/Compass.ts` | Top heading strip: pads/ship markers, fog-discovered landmarks, red enemy ticks inside `enemyDetectRadius` + scan reveals; fades in after the intro wake |
| `hud/ContractPanel.ts` | Top-left active contract + squadmates' contract rows (never in training) |
| `hud/CookGauge.ts` | Grenade cook arc (`grenade:holdChanged`) |
| `hud/CursorHoldGauge.ts` | Cursor-centred hold ring for furniture move-hold (`housing:moveHold`) and tooltip pinning (`ui:cursorHold`) |
| `hud/CutsceneWatch.ts` | Shared "docking / warp cutscene playing" flag + ship kind for ship-only corner widgets |
| `hud/DamageOverlay.ts` | Damage direction arcs (`ui:damageIndicator`), low-HP vignette + heartbeat, edge flash |
| `hud/DangerIndicators.ts` | Incoming threats — enemy shells, grenades (ally + enemy), ship-call drops, raider drop pods, fire zones: head marker on screen, direction arc off screen |
| `hud/Deployables.ts` | Deployed gadget markers; mines visible to everyone with a world blast ring |
| `hud/DeployOverlay.ts` | "descending" overlay during `deploying` |
| `hud/Detection.ts` | Light pillars on corpses in `detectRadius`; off-screen enemy arrows / on-screen chevrons in `enemyDetectRadius` |
| `hud/DroneHud.ts` | Drone-control HUD: `drone-view` class on the gameplay layer, viewfinder, link-range gauge, static noise, altitude/keys, control hold ring, disconnect notices; owns `DroneScanLabels` |
| `hud/DroneScanLabels.ts` | World labels for drone scan results (`ctx.drones.getScanResults()`), projected in `lateUpdate` |
| `hud/FallVignette.ts` | Red fall vignette sized by `player:fell` damage, faded from `update(dt)` |
| `hud/GadgetHandHint.ts` | Under-crosshair hint for the held gadget: place / invalid reason, remote-mine detonate count, drone deploy / hold-to-control |
| `hud/GameCursor.ts` | Procedural cursor art injected as CSS `cursor:` images under `body.cursor-ui` (the real OS cursor) |
| `hud/HazardHud.ts` | Environmental hazard banner, safe-zone gauge, safe-direction arrow, inside-hazard warning + edge pulse |
| `hud/HealGauge.ts` | Healing consumable hold / spray ring (`heal:holdChanged`), the right-button ally hold (`heal:allyHoldChanged`) and its `.heal-ally` target chip (`heal:allyTargetChanged`) |
| `hud/HoldGauge.ts` | Crosshair hold ring for interactables (`interact:promptChanged.holdProgress`) and the downed give-up hold |
| `hud/HubDot.ts` | Ship centre dot (phase `hub`, no blocker, no cutscene) |
| `hud/ImplantWidget.ts` | Tactical implant thumbnail, bottom centre: cooldown / charges / gauge display, ready flash + glow, refund text |
| `hud/InteractionPrompt.ts` | Bottom-centre `E — action` caption; hold interactables get a hold keycap |
| `hud/ItemFavoriteMenu.ts` | Right-click favorite menu on any `.item-chip[data-def-id]` or opted-in tile; registers the chip favorite source |
| `hud/ItemTip.ts` | Hover card for item chips / `data-item-tip` tiles / currency chips / text chips (`data-tip-name` · `-sub` · `-desc` · `-color` — the NPC trust reward chip) (def data, series, meal quality, sockets…); weapons get the **same body as the grid card** through `shared/weaponTip` (대미지 · 연사 · 반동 · 사거리 · 탄종 · 장전 · 발사 모드 · 배율 · 내구도 · 소켓); exports `TIP_ANCHOR_ATTR`, `TIP_PRICE_ATTR`, `TIP_NAME_ATTR` |
| `hud/KeyGuide.ts` | Bottom-right key line for the topmost `ui:keyGuide` owner; appends the `Tab · Esc 닫기` entry itself |
| `hud/LoadingGauge.ts` (+ `styles/loading.css`) | Raid-entry loading gauge: bottom-right radial ring over the black plate, `squad` fill, `n명 대기 중`; driven by `performance.now()` because the load gate hands every system `dt 0` |
| `hud/mealText.ts` | Meal buff / quality / cook-step text helpers shared by ItemTip, BuffStrip, Notifications |
| `hud/MetaToasts.ts` | Top-centre credits chip (coalesced), reputation level, contract settlement toasts |
| `hud/MusicPlayer.ts` | **Personal-ship-only** music player window (`ctx.phase === 'hub'` + `ctx.hub?.ship === 'personal'`, re-read every frame; `housing:musicChanged`): title, artist, volume, progress, prev/next, mode, stop — no sound. Hiding it never clears the state |
| `hud/NamedScanWarning.ts` | Named sniper warnings: scan exposure banner, exposure sweep, scope glint head/arc (`named:*`) |
| `hud/Nameplates.ts` | Remote player name / shield / hp plates (projected, distance fade); android bodies in a raid get the same plate (`.ally`, `쓰러짐` tag) |
| `hud/NetBadge.ts` | Server link badge in ship and title (hidden in raids); owns link-transition toasts |
| `hud/Notifications.ts` | Right-centre toast stack: draws `ui:notify` and converts squad / inventory / extraction / NPC quest / housing / social events into toasts; channel ticker |
| `hud/Objective.ts` | Top-left mission clock + big extraction timer (arrive / idle / depart); both hidden in the tutorial raid. `OBJECTIVE_TEXT` (emitted, not drawn) |
| `hud/OffscreenIndicators.ts` | Edge arrows for off-screen pings (own + squad) |
| `hud/pillar.ts` | Light pillar geometry/material builder + `pillarAllowed` (corpses only) |
| `hud/Pings.ts` | Middle-mouse pings v3 (raid and ship): gesture (holds `ctx.player.setLookLocked` from press to release / `PING_HOLD_MAX`, releasing only its own lock), aim assist, per-player cap, ack ping, markers, chat callouts, `ping` / `pingack` wire; `placeAtWorld` for the map |
| `hud/PingWheel.ts` | Left/right ping hold wheel (presentation only) |
| `hud/ProgressToasts.ts` | Skill-up toasts + coalesced XP chip (level-up is played by `RewardsBlock`) |
| `hud/QuickStrip.ts` | Quick-slot thumbnails with live keycap, stacked on the weapon panel |
| `hud/QuickWheel.ts` | Quick-use wheel (`quick:wheelChanged`) |
| `hud/RaidAlerts.ts` | DOM-less event → toast converter: landmark discovery, raider drop warning, rover trips/damage |
| `hud/ReloadGauge.ts` | Reload / weapon-swap ring at the crosshair (ignores the bow); freezes dimmed on `weapon:reloadPaused` (a hold is not a cancel) |
| `hud/RescuePicker.ts` (+ `rescuePicker.css`) | Full-screen rescue-drop target picker (`rescue:selectTarget`) |
| `hud/Reticle.ts` | Crosshair: stance/aim gap + bloom, hitmarkers, consumable dot readout, grapple chip, blocked-muzzle colour, bow draw mode, defib circles; hidden during the intro wake, then fades in over `TUTORIAL_RETICLE_FADE_S` |
| `hud/RoomLabel.ts` | `방 n · 용도` label on `hub:roomEntered` |
| `hud/RoverHud.ts` | Rover passenger HUD: `rover-view` class, hp bar, state line, `M` key guide |
| `hud/ScanReveal.ts` | Through-wall pillars for scan-revealed corpses/enemies (`scan:cast`) |
| `hud/ScanTracker.ts` | Shared list of scan-revealed enemies (Compass + Detection) |
| `hud/ScopeOverlay.ts` | Sniper scope mask + mil-dot (`weapon:scopeChanged`) |
| `hud/ShipManage.ts` | Facility management (`시설 관리`) screen: room list, purpose picker, furniture craft/storage tabs (last tab remembered per slot), furniture craft modal (`.sm-craft`, 1 s hold on `.sm-craft-ok`), session-only 가구 창고 red dots (`.sm-dot` on the tab / sub-tab / new or recovered store cards), inspector with upgrade/remove, confirm popups |
| `hud/ShipManageHint.ts` | `시설 관리` + `Keys.MAP` keycap hint on the personal ship |
| `hud/SpectateOverlay.ts` | Multiplayer death banner with remaining squad and rescue drops |
| `hud/Squad.ts` | Bottom-left squad list of **other members only** — the local row is never drawn (2026-09-16), in the shared ship or in a raid, and the whole list hides when no row is filled. Slot colour, name, mission badge, hp, state, host-ghost bleed, mini buff strip; an **undocked** squad's rows read `개인 함선`. Bot lobby members are never human rows — androids come last from `ctx.allies.roster` (`안드로이드` badge, shield bar, `쓰러짐` / `사망`), and one android alone puts the list up with no lobby |
| `hud/StatusMarkers.ts` | World markers for burned / shocked enemies |
| `hud/stratagemGlyphs.ts` | Ship-call glyph, colour, def lookup, arm/target hints |
| `hud/StratagemPanel.ts` | Ship-call square thumbnail left of the implant: shared cooldown fill, armed colour, rescue count, ready flash |
| `hud/StratagemWheel.ts` | 4-slot ship-call wheel (`stratagem:wheelChanged`), cooling state |
| `hud/TargetingHud.ts` | Ship-call targeting frame; toggles `.hud.targeting` (hides reticle) |
| `hud/TrainingPanel.ts` | Training arena mode / score / course timer panel |
| `hud/TypingBubbles.ts` | `…` bubbles over remote players with `PlayerFlags.TYPING` (not for blocked peers) |
| `hud/Vitals.ts` | PC name + segmented shield and hp bars with red damage ghost, downed mode, give-up caption, buff strip; stamina bar stays in the gameplay layer |
| `hud/WeaponChargeGauge.ts` | Unique weapon wind-up arc (`weapon:chargeChanged` kinds `charge` / `spinup` / `slash`; ignores `draw`) |
| `hud/WeaponPanel.ts` | Bottom-right weapon box: rarity thumbnail, `mag / reserve`, type tag (`weaponTypeLabel`), durability, modes; consumable mode |
| `hud/WorldMarkers.ts` | Screen diamonds for discovered / active extraction pads (no landed-ship marker; the active pad's hides once the ship lands) |
| `hud/viewport.ts` | The screen size every projecting widget reads (`hudViewport`), measured on `resize` only — no per-frame layout read |
| **map/** | |
| `map/MapScreen.ts` | Tactical map (`M`): cached terrain, fog layer + edges, hazard hatch over fog, discovered landmarks, squad, pings (middle-click places), legend swatches, rover route + destination pick with 1 s hold payment |
| `map/mapIcons.ts` | Stateless canvas marker painters shared by map and legend (`MAP_COL`, `MARKER_SCALE`, `draw*`), `MapLabels` overlap culling |
| `map/QuestPanels.ts` | Map left column: the running tutorial track's objectives on top (`MapTutorialPanel` ← `ctx.tutorial.panelInfo()`), then NPC quest tracks for this raid (`ctx.meta.npc.getRaidTracks()`) + hover detail tooltip |
| **menus/** | |
| `menus/MenuBase.ts` | Full-screen menu base: `'menu'` blocker + cursor mode, show/hide |
| `menus/TitleMenu.ts` | Title: wordmark + `게임 시작` / `설정` / `종료`; with a remaining raid (`ctx.raidResume.offer`) a highlighted `이어하기` above a red `게임 시작` that opens only the abandon popup; hosts character select/create, keybind notice, auto-start (waits for the raid check) |
| `menus/raidResumeCard.ts` | Abandon popup body (`buildRaidResumeCard`): kind · planet · elapsed line, four square face tiles like the terminal match tab (me → members by slot → empty; `분대장` / `표류` / `안드로이드` / `연결 끊김` tags), what is lost. CSS `.trs-` in `styles/title.css` |
| `menus/CharacterSelect.ts` | Slot cards (`SLOT_IDS`) from each slot's save; start, delete (hold popup), create |
| `menus/CharacterCreate.ts` | Character creation: name, stat allocation, 3D preview, accent swatch, summary confirm card with 1 s hold |
| `menus/SoldierPreview.ts` | Own `WebGLRenderer` soldier preview for creation (`createSoldierPreview`, `snapshotFace`); face framing = `shared/faceFraming` + `@/player` `poseFaceModel` / `aimFaceCamera` / `addFaceLights`, identical to the terminal match-tab portraits |
| `menus/enterShip.ts` | The single path from character select / auto-start into the game: waits for `ctx.raidResume.settled()` and returns to the title when a raid remains (`onResumeOffer`), then pending invite, else tutorial raid (track `raid` not done, no lobby), else personal ship |
| `menus/askPopup.ts` | Generic warning popup (`AskSpec`, `cancel` label, `content` node, `cardCls`): Escape cancels, Enter swallowed, danger/hold confirms need `UI_HOLD_CONFIRM_S` |
| `menus/PauseMenu.ts` | ESC menu: resume / settings / `함선으로 귀환` or `튜토리얼 건너뛰기` / `파티 떠나기` / `타이틀로` / `게임 종료`, with in-frame warning popup |
| `menus/SettingsMenu.ts` | Settings overlay: `화면 설정` · `오디오 설정` · `키 설정` · `서버 설정` sections |
| `menus/displaySettings.ts` | Display settings store (`scav.display`: fullscreen, bloom, shadows, scale) |
| `menus/ControlsPanel.ts` | Keyboard + mouse controls diagram (settings `키 설정`) |
| `menus/KeybindMenu.ts` | Key rebinding overlay (mouse-glyph binding buttons) |
| `menus/keybindNotice.ts` | One-shot boot notice for retired / colliding saved keybinds (`takeKeybindLoadReport`) |
| `menus/DeathScreen.ts` | Solo death / raid-failed screen with auto-return countdown |
| `menus/MissionComplete.ts` | Extraction result screen (death look for squadmates who were down) |
| `menus/ResultReport.ts` | Shared result body: `buildResultHeader`, `buildPlanetLine`, loot value line, death cause row (enemy portrait or procedural icon) |
| `menus/RewardsBlock.ts` | XP count-up, level-up moment + `level_up` chime, contract settlement line (`contractOutcome`) |
| `menus/messenger/Messenger.ts` | Messenger panel body inside the Community frame: tabs `대화` / `친구` / `퀘스트`, `ui:openMessenger` targets |
| `menus/messenger/ChatTab.ts` | Conversation list (NPC, private chat, group rooms) + bubbles, NPC quest cards, room management, staged "typing" reveal of unread NPC lines (WAAPI dots), intro choices `MESSENGER_CHOICE_DELAY_S` after the last line, half-height empty tail (`.ms-tail`) under every thread |
| `menus/messenger/QuestsTab.ts` | Active / completed NPC quests + detail card (deliver, report) |
| `menus/messenger/QuestCard.ts` | NPC quest card shared by chat bubble and quest detail |
| `menus/messenger/Popover.ts` | Single in-panel popover (create room, invite, rename) |
| `menus/messenger/Trust.ts` | NPC personal trust read + gauge / avatar ring / reward chip |
| `menus/messenger/sources.ts` | `npcOf` / `roomsOf` accessors + smoke debug refs |
| `menus/messenger/textInput.ts` | IME-safe text input wiring (Enter after composition end, keys never reach the game) |
| `menus/messenger/format.ts` | Clock / clip / room system line / initials helpers |
| `menus/social/SocialColumn.ts` | Friends column (squad, requests, friends, recent) hosted in the messenger `친구` tab |
| `menus/social/ProfileCard.ts` | Player card + `초대 중 · n초` badge text |
| `menus/social/SocialMenu.ts` | Card right-click menu (`분대 초대` — invite only, greyed with `PLAY_BLOCK_LABELS`; `개인 대화`, friend add/remove, block) + remove-friend confirm |
| `menus/social/SocialPages.ts` | Block-list page over the column |
| `menus/social/socialSource.ts` | The one reader of `ctx.net.social` (`socialOf`, `isPeerBlocked`) + smoke debug snapshot |
| `menus/social/whisperText.ts` | Private-chat delivery state text/class shared by ChatLog and ChatTab |
| **styles/** | Imported by the component named; `base.css` is linked from `index.html` |
| `styles/base.css` | Reset, `#ui-root`, palette + scrollbar variables, utilities, keycaps (`.kc-hold`, `.kc-btn`), menus, most HUD widgets, `.screen-fade`, `.menu.hidden`, reduced-motion rule |
| `styles/buffs.css` | `.bfs-*` (BuffStrip) |
| `styles/danger.css` | `.dgr-*` (DangerIndicators) |
| `styles/drone.css` | `.hud.drone-view` hide list, `.dr-*`, `.dsl-*` (DroneHud, scan labels) |
| `styles/fall.css` | `.fall-vignette` (FallVignette) |
| `styles/gadgetHint.css` | `.ghh-*` (GadgetHandHint) |
| `styles/hazard.css` | `.hz-*` (HazardHud) |
| `styles/implant.css` | Bottom-centre row geometry `:root { --imp-th, --imp-tw, --imp-bottom, --imp-gap }`, `.imp-*` (ImplantWidget, Reticle grapple chip) |
| `styles/loading.css` | `.ldg-*` (LoadingGauge) |
| `styles/mapquests.css` | `.mq-*` (QuestPanels — quest panels, tooltip and the tutorial objective panel `.mq-tut*`) |
| `styles/messenger.css` | `.ms-*` (Messenger) |
| `styles/music.css` | `.mus-*` (MusicPlayer) |
| `styles/named.css` | `.ns-*` (NamedScanWarning) |
| `styles/netBadge.css` | `.net-badge`, `.nb-*` (NetBadge) |
| `styles/raidHud.css` | Raid HUD: clock, weapon box, quick strip, vitals, `.hud-tut-hidden`, liftoff cinematic (`.hud.cinematic` crosshair/rings instant hide, `#ui-root.hud-cine` / `.hud-cine-out` whole-HUD fade) |
| `styles/results.css` | `.rs-*` (ResultReport) |
| `styles/rover.css` | Map legend swatches, rover destination panel, `.hud.rover-view` hide list, `.rv-*` |
| `styles/shipCall.css` | `.scall` ship-call thumbnail (StratagemPanel); geometry read from `implant.css` variables |
| `styles/social.css` | Invite badge, block-list page, private-chat line states (ChatLog, SocialColumn) |
| `styles/title.css` | Title, character select/create (`.cc-*`, `.cs-*`, `.ts-*`), title warning popup `.tm-*` |
| `styles/wheels.css` | `.cwheel` / `.pwheel` (CommsWheel, PingWheel) |

## Layers and visibility

`HudSystem.init` appends, in order: overlay `.hud` (DamageOverlay, ScopeOverlay, ActionFeedback, hazard edge) →
gameplay `.hud.gameplay` → social `.hud.social` → housing `.hud.housing` (ShipManage, CursorHoldGauge) → direct
`#ui-root` children (ItemTip, MusicPlayer, ItemFavoriteMenu, KeyGuide, RescuePicker, `.screen-fade`, FallVignette,
DeployOverlay, MapScreen, KeybindMenu, SettingsMenu, TitleMenu, NetBadge, PauseMenu, DeathScreen, MissionComplete).

| `ctx.phase` | Shown |
|---|---|
| `menu` | TitleMenu (+ NetBadge) |
| `hub` / `docking` | Social layer (with `.hub`), housing layer, ship-only widgets (Community, HubDot, ShipManageHint, MusicPlayer, NetBadge — hidden during docking/warp cutscenes) |
| `deploying` + gameplay phases | Overlay + gameplay + social layers; a `'menu'` blocker hides both HUD layers |
| gameplay, local player dead, multiplayer | Layers stay up with `.spectating`; SpectateOverlay shows |
| `dead` (solo) | DeathScreen; overlay layer only |
| `complete` | MissionComplete |

`ui:cinematic` (extraction liftoff, every raid kind) hides **all remaining HUD**: `.cinematic` on overlay/gameplay/social
hides the crosshair and crosshair rings at once; `.hud-cine` on `#ui-root` fades the four `.hud` layers plus KeyGuide,
ItemTip, MusicPlayer and NetBadge through `filter: opacity(var(--cine-o))`, stepped by `HudSystem.stepCinematic` over
`EXTRACTION_HUD_FADE_S` (then `.hud-cine-out` = `visibility: hidden`); Detection / ScanReveal / Deployables scale their 3D
materials by the same value. Screen fade, loading gauge, menus (pause, settings, result) and screens stay. tutorial/ hides
its own DOM on the same event. Cleared at once on `ui:cinematic false`, `game:abort`, `game:newMission`, the raid's end
(`game:complete` / `game:over`) or, one frame later as a second defence, when `applyVisibility` sees the phase leave
gameplay. Tutorial gates: widgets ask `ctx.tutorial?.hides('hud', <part>)` (`vitals`, `weapon`,
`stamina`, `implant`, `stratagem`, `extractionTimer`, `shipMarker`, `shipScreenMarker`) and `hides('community')`.

Stacking (CSS `z-index`; `.hud` layers and plain `.menu` have none and follow DOM order):

| z | Element |
|---|---|
| 25 | `.fall-vignette` |
| 30 | resume gate (game/) |
| 40 | `.map-screen`, `.rescue-pick` |
| 46 | `.community-panel` (messenger) |
| 50–80 | inventory window and its sub-layers (inventory/), hub popups 72 (hub/), `.sm-dock` 77, tutorial spotlight 78, `.sm-confirm` 79 |
| 60 | `.mq-` quest tooltip |
| 81 | `.mus-` music player |
| 82 | `.screen-fade` |
| 83 | `.net-badge` |
| 87 | `.ldg` loading gauge (must draw **over** `.screen-fade`, and over the pause menu while the load gate holds) |
| 84 | `.key-guide`, `.title-screen`, `.menu.complete`, `.menu.death` |
| 85 / 86 / 88 | `.menu.pause` / `.menu.settings-menu` / `.menu.keybind-menu` |
| 200 / 210 / 215 | `.item-tip` / `.icm` favorite menu / `.cursor-hold` |
| 300 / 302 | `.sc-menu` / `.sc-confirm` |

## Public API

**System**: `HudSystem` (`name = 'hud'`), registered in `main.ts`. No `ctx` publication.

**Events emitted**

| Event | Emitter |
|---|---|
| `ui:notify` | many widgets (drawn by `Notifications`) |
| `ui:objective {text, subText}` | `HudSystem` per extraction phase (`OBJECTIVE_TEXT`) |
| `ui:mapToggled` · `ui:chatToggled` · `ui:communityToggled` + `ui:messengerToggled` · `ui:settingsToggled` · `ui:keybindsToggled` | MapScreen · ChatLog · Community · SettingsMenu · KeybindMenu |
| `ui:displayChanged` | SettingsMenu (applied by `main.ts` to the Engine) |
| `ui:keyGuide {owner, keys}` | MapScreen `map`, Community `community`, RescuePicker `rescue`, RoverHud `rover` |
| `input:bindingsChanged` | KeybindMenu |
| `hub:enter {ship}` | DeathScreen, MissionComplete, `enterShip` |
| `game:newMission {mode:'tutorial'}` | `enterShip` (sets `missionMode` / `missionPlanet` / `missionIntel` first) |
| `game:paused {paused:false}` · `game:returnToShip` · `game:abort` | PauseMenu |
| `ping:placed` · `ping:placedV2` · **`ping:placedV3 {owner, label?, enemyId?, containerId?}`** · `ping:removed` · `ping:acked` · `ping:wheelChanged` | Pings — V3 is emitted for **every** ping this client places or receives (local `owner: null`, squadmate PeerId, android id); `allies/` reads its commands from it. `label` is a **display string** and never an id: a `'crate'` ping names its target with `containerId` (2026-09-19, `WorldRef.getLootContainers`), relayed as `PingMessage.containerId` |
| `ally:chat` | Pings (the android's own ping callout — ChatLog draws it and never relays it) |
| `comms:sent` · `comms:wheelChanged` | CommsWheel |
| `chat:post` · `chat:message` | Pings/CommsWheel callouts · ChatLog (every line) |
| `rescue:selectTarget {peerId}` | RescuePicker |
| `leader:transferRequested {peerId}` | Community squad row menu |
| `audio:play` | UI clicks, `level_up` (RewardsBlock) |

**Events consumed** — by domain (grep `\.on('` in this folder for the exact list): `game:*` phase/pause/complete/
over/raidFailed/abort/newMission; `ui:notify`, `ui:hitmarker`, `ui:damageIndicator`, `ui:keyGuide`, `ui:screenFade
{opacity, durationS, hold?}`, `ui:cinematic`, `ui:cursorHold`, `ui:tipPinned`, `ui:openMessenger`; `player:*`
(vitals, shield, downed, fell, buffs); `weapon:*` (equip, ammo, reload, charge, scope, aimBlocked); `quick:*`,
`grenade:holdChanged`, `heal:holdChanged`, `gadget:*` (incl. `defibAim`, `placementChanged`); `implant:*`;
`stratagem:*`, `rescue:*`; `extraction:*`; `hazard:*`, `fog:*`, `rogueDrop:incoming`, `rover:*`, `named:*`,
`sandworm:*`, `enemy:shell*`; `drone:*`, `scan:cast`, `detect:*`; `inventory:*`, `durability:*`, `craft:*`,
`meta:*`, `npc:*`, `progress:*`, `housing:*`; `hub:*`; `net:*` (lobby, peers, link, remote downed/died/buffs);
`social:*`, `room:*`; `training:*`; `tutorial:changed`; `input:bindingsChanged`, `input:cursorModeChanged`;
`render:autoAdjusted`; `audio:volumeChanged`; `cheat:moveCheat`; **`ally:*`** (`rosterChanged`, `downed`, `died`,
`deposited` → toasts; `ping` → Pings; `chat` → ChatLog) and `net:androidReturned`; **`raid:loadBegin` /
`raid:loadProgress` / `raid:loadReleased`** (LoadingGauge).

**Wire messages** (via `ctx.net`): `ping`, `pingack` (Pings), `comm` (CommsWheel) — sent to `'others'` and received
with `onMessage`; `chat` sent by ChatLog while in a lobby.

**Refs read / called** (always null-guarded): `ctx.player`, `ctx.inventory`, `ctx.loot`, `ctx.weapons`,
`ctx.implants`, `ctx.gadgets`, `ctx.drones`, `ctx.stratagems`, `ctx.enemies` (incl. `renderPortrait`,
`getRogueDrops`, `getEnemyGrenades`, `getFireZones`), `ctx.world` (`fog`, `hazard`, `rover`, `training`,
`getStructures`…), `ctx.progression` (`derived`), `ctx.meta` (`activeContract`, `getSquadContracts`, `npc`,
`npcTrust`), `ctx.housing` (manage mode, music controls), `ctx.net` (`social`, `rooms`, `lobby`, `link`, `leaveLobby`,
`joinLobby`, `ensureConnected`), `ctx.tutorial` (`hides`, `track`, `skipTrack`, `isTrackDone`), `ctx.audio`
(`setVolume`, `preview`, `settings`), `ctx.escape`, `ctx.uiBlockers`, `ctx.input`.
Types live in `src/shared/events.ts`, `src/shared/types.ts`, `src/shared/net.ts`, `src/shared/social.ts`.

**Screen tokens**

| Surface | `uiBlockers` / cursor token | `ctx.escape` token | Key guide owner |
|---|---|---|---|
| TitleMenu, PauseMenu, DeathScreen, MissionComplete (`MenuBase`) | `'menu'` | — (pause is driven by `game/`) | — |
| MapScreen | `'map'` | `'map'` | `map` |
| ChatLog | `'chat'` | — (own capture handler) | — |
| Community / messenger | `COMMUNITY_BLOCKER` | `COMMUNITY_BLOCKER`; `messenger:pop` (Popover), `community:page` (SocialPages) | `community` |
| RescuePicker | `'rescuePick'` | `'rescuePick'` | `rescue` |
| ShipManage furniture craft modal | `'shipManage:craft'` | `'shipManage:craft'` (Tab also closes it; Enter swallowed) | — |
| ItemFavoriteMenu | — | `ui:itemFavoriteMenu` | — |
| SettingsMenu, KeybindMenu, AskPopup, SocialMenu | none (open over a surface that already holds one; capture-phase keydown) | — | — |

**Smoke / debug hooks** (`window.__game.getSystem('hud')`): read-only getters named after the widget state
(`isMapOpen`, `isChatOpen`, `keyGuideOwner`, `keyGuideEntries`, `screenFadeOpacity` / `screenFadeShown` /
`screenFadeHeld`, `fallVignetteOpacity`, `isCinematic`, `cinematicHudOpacity`, `bowReticle`, `dangerIndicatorCount`, `musicPlayerView`, `netBadgeState`,
`messenger`, `squadRows`, `allyNameplates`, `chatLines`, `toastTexts`, `pingViews`, `loadingGaugeState`, …) and
injectors `debugRemotes`, `debugSocial`, `debugSocialRef`, `debugNpc`, `debugRooms`, `debugLocalBuffs`, `debugAllies`.

## Rules

- **No layout read inside a frame**, and it is **counted** since 2026-09-20: `scripts/smoke-layout-reads.mjs` patches
  every layout-forcing accessor and fails if one is touched while `Engine.frame` is on the stack. A widget that needs
  the screen size reads `hudViewport` (`hud/viewport.ts`), measured once on `resize`. `clientWidth` / `clientHeight` /
  `getBoundingClientRect` after a style write forces the browser to lay the whole UI out again — twelve widgets used
  to do that every frame, and `hud/ChatLog` did it **per chat line** (8.3 ms on the frame three android callouts
  landed, `docs/PERF.md` perf Phase B). — `hud/viewport.ts`, `hud/ChatLog.ts`
- **One exception, and it is a ratchet**: the CSS animation restart
  `classList.remove(c); void el.offsetWidth; classList.add(c)` (hit marker, damage flash, magazine tick, stamina,
  implant / ship-call ready …). Thirteen files are listed in the smoke's `KNOWN_IDIOM`; the list may shrink, never
  grow. A read-free replacement was tried on 2026-09-20 and **retracted** — `getAnimations()` loses an animation that
  finished with no `fill` and never sees one that lives on a descendant (`.imp-hud.rdy-major .imp-ring`), and a
  same-task remove/add coalesces. A style flush is no cheaper than a layout flush either (1.5–2.1 ms vs 0.9–1.9 ms
  inside a dirtied raid frame). **This is an intended limit, decided 2026-09-20** (`## Decisions`): the one
  read-free cure — a twin `@keyframes` per animation with two classes alternating — was weighed and declined, and the
  extra flush on a frame where a flash fires is accepted. The evidence is Phase B's own: S4 re-measured twice with
  `hud/DamageOverlay` forcing a layout on every bite gave the same numbers as without. The ratchet stays, so the idiom
  still cannot spread. The same idiom in other folders' menus (`housing/ui`, `hub/ui`, `inventory/ui/CatalogView`, ten
  sites) runs outside `Engine.frame` and is left alone for the same reason.
- **A widget whose DOM shape first appears mid-raid pays for it then.** A row's first layout costs several times its
  later ones (rules never matched, glyphs never shaped): a chat row measured **5.3 ms** the first time and 0.5 ms
  after. `hud/ChatLog` draws and drops one throwaway row on a timer at `bind`, and `hud/Detection` · `hud/ScanReveal`
  build their pillar pools on `world:ready` (inside the raid-entry hold) instead of on the first corpse.
  — `hud/ChatLog.warmUpSoon`, `hud/Detection.ts`, `hud/ScanReveal.ts`
- Screens pair `ctx.uiBlockers.add(token)` + `ctx.input.setCursorMode(true, token)` + `ctx.escape.push(token, close)`
  and undo all three on close and in `dispose`. Nothing in this folder calls `requestPointerLock`. — `menus/MenuBase.ts`, `map/MapScreen.ts`
- Threat readouts skip `EnemyRef.isEgg`: the detection HUD's arrows / chevrons / radar, the compass ticks and every 「적」 ping
  treat a nest egg as scenery, not as an enemy (a nest holds dozens and the danger HUD is one indicator per hazard).
  — `hud/Detection.ts`, `hud/Compass.ts`, `hud/Pings.ts`
- Escape closes the topmost screen via `ctx.escape` (policy in `game/parts/Phases.escapeKey`); innermost popups
  (chat input, AskPopup, settings, key capture, context menus) swallow Escape in their own capture handler. The pause
  menu closes on Escape only in the desktop shell. — `menus/PauseMenu.ts` (`isDesktopShell`)
- A screen that polls Tab to close must only consume it when it is on top (`ctx.escape.topKey === token`), otherwise
  close order follows system registration order instead of open order. — `map/MapScreen.ts` (`update`)
- Screens announce their keys with `ui:keyGuide`; never list the close entry — `KeyGuide` appends `Tab · Esc 닫기`.
  Owners that are states, not screens (`rover`, `pod`), are in `NO_CLOSE_OWNERS`. Wheels and drone view do not use
  the guide because they do not close with Tab/Esc. — `hud/KeyGuide.ts`
- Every keycap is drawn by `shared/keycap` (`createKeycap`, `paintKeycap`, `renderKeyText`, `createHoldButtonCap`);
  never write `class="keycap"` by hand. Hold keys use `.kc-hold`, never `.hold` (the hold-ring widget class).
  Hold-to-confirm buttons carry `createHoldButtonCap` instead of a "hold N seconds" text line; their `textContent`
  starts with the glyph title (`LMB…`), so read the label span. — `styles/base.css`
- Irreversible confirms need `UI_HOLD_CONFIRM_S` of holding; Enter is swallowed, Escape cancels, focus starts on
  cancel. In the ship `타이틀로` / `게임 종료` are a single tap (`Ask.tap`) because nothing is lost; `파티 떠나기` stays
  a hold. — `menus/askPopup.ts`, `menus/PauseMenu.ts`
- `함선으로 귀환` in a raid emits `game:returnToShip` (death on the spot, handled by `game/`), never `hub:enter`.
  While a tutorial track runs, the same slot is `튜토리얼 건너뛰기` → `ctx.tutorial.skipTrack`. — `menus/PauseMenu.ts`
- All entries into the game go through `enterShip` (remaining raid → back to the title; invite → tutorial raid → personal
  ship), whichever door (card click or post-reload auto-start) was used. — `menus/enterShip.ts`
- While `ctx.raidResume.offer` exists, `게임 시작` never opens character select (switching characters counts as abandoning);
  a raid found late closes select / create and returns to the title. — `menus/TitleMenu.ts` (`startGame`, `onResumeChanged`)
- Toasts: other folders emit events; the toast text lives here (`hud/Notifications`, `hud/RaidAlerts`,
  `hud/MetaToasts`, `hud/ProgressToasts`, `hud/NetBadge` for link transitions). Don't add a toast for an event that
  `world/Fog`'s `TOAST` table already covers (discovery toasts would double). — `hud/RaidAlerts.ts`
- Project to screen (`Vector3.project`) only in `lateUpdate`; `HudSystem.lateUpdate` calls
  `camera.updateMatrixWorld()` first. — `HudSystem.ts` (`lateUpdate`)
- Fades that carry meaning (screen fade, compass / crosshair reveal, fall vignette, liftoff HUD fade) are interpolated in
  `update(dt)`, not CSS transitions: the reduced-motion rule in `base.css` cuts all transitions to 0.01 ms. — `HudSystem.ts`
  (`setScreenFade`, `setCinematic`)
- A whole-layer fade that must not reveal hidden children uses `filter: opacity()`, not `opacity`: it multiplies with the
  element's own opacity (`.hud.hidden`, widget inline opacity) and is in no transition list. — `styles/raidHud.css`
- `.screen-fade` is presentation, not a blocker (no pointer events, no escape entry). It clears when the phase leaves
  gameplay unless `hold` was set; `game:abort` and `hub:entered` always clear it. — `HudSystem.ts` (`applyVisibility`)
- A new overlay that hides with a CSS transition must also drop `pointer-events` while hidden (`.menu.hidden`
  pattern), or the invisible layer eats clicks during the fade. — `styles/base.css`
- CSS class prefixes must be unique across the whole game (stylesheets are global): check `rg "\.<prefix>-" src`
  before choosing one, and never reuse a HUD widget class as a modifier (`.charge` vs `.wc-charge`,
  `.hold` vs `.kc-hold`). — `hud/WeaponChargeGauge.ts` (`KIND_CLASS`)
- Toggle visibility with the `hidden` attribute (`[hidden] { display: none !important }`), not `style.display`.
- Scrollbar colours come from `--sb-track` / `--sb-thumb` / `--sb-thumb-hover` in `styles/base.css` only
  (`inventory/inventory.css` references them with fallbacks).
- Bottom-centre row geometry (implant + ship-call thumbnails) is only the `:root` variables in `styles/implant.css`.
- Map, compass and world markers gate landmarks on `ctx.world.fog.isDiscovered`; live events (pings, danger
  indicators, hazards on the map) are never fog-gated. The active extraction pad is exempt. — `map/MapScreen.ts` (`discovered`)
- **Map angles: canvas x = world X, canvas y = world +Z, never flipped** (`MapScreen.toX` / `toY`). A marker whose
  local +X is the math convention (world `(cos yaw, sin yaw)` — the tram and the rover, `rails/model.ts`) is drawn with
  `c.rotate(yaw)`; a third-person body, whose forward is `(-sin yaw, -cos yaw)`, is converted at the call site
  (`Math.atan2(-Math.cos(yaw), -Math.sin(yaw))`). Mixing the two mirrors the icon across the track (2026-09-18: the
  rover never faced its travel direction; `drawTram` had the same sign but a symmetric shape hid it). — `map/mapIcons.ts`
- Light pillars appear only on corpses (`pillarAllowed`); crates show their opened state instead. — `hud/pillar.ts`
- DangerIndicators draws exactly one element per threat (head on screen, arc off screen); colour = owner (ally amber,
  enemy red), `hot` = imminent. Shell arcs use `shared/ballistics`, never a copied formula. — `hud/DangerIndicators.ts`
- The communication wheel posts `chat:post` only for local sends (ChatLog relays it); remote `comms:sent` becomes a
  toast only, otherwise the line appears twice. — `hud/CommsWheel.ts` (`announce`)
- Social UI shows `PlayerCode` only — a `PeerId` never reaches it. Read social data only through
  `menus/social/socialSource` (and messenger data through `menus/messenger/sources`) so smoke debug refs work.
- Read androids only through `hud/allySource` (same reason). **Bot lobby members are not people**: every
  `lobby.players` reader in this folder filters them with `isBotPlayer` — a bot has no socket, so no
  `RemotePlayerRef`, no 아이디 / level, and it never becomes host. They are drawn from `ctx.allies` instead.
  — `hud/Squad.ts`, `menus/social/SocialColumn.ts`, `hud/Community.ts`, `hud/RescuePicker.ts`
- The loading gauge and anything else that must animate **while the raid-entry load gate holds the engine** reads
  `performance.now()`, never `dt` or `ctx.time`: every system gets `dt 0` during the hold. — `hud/LoadingGauge.ts`
- `ally:chat` (and the android's ping callout) is drawn but **never relayed** — allies/ already emits it on every
  client. Posting it through `chat:post` would double every line. — `hud/ChatLog.ts`
- ui must not import `core/`; display settings reach the Engine through `ui:displayChanged` → `main.ts`. Cross-folder
  imports are `@/shared` plus the `@/items` barrel (`hud/ItemTip`, `hud/WeaponPanel`) and `@/player` barrel
  (`menus/SoldierPreview`).
- Legendary uniques show their own kind (`UNIQUE_WEAPON_LABEL_KO`), never their csv class. — `hud/WeaponPanel.ts` (`weaponTypeLabel`)
- A weapon's numbers and their Korean labels come from `shared/weaponTip` (`weaponTipRows`, `weaponGaugeValues` /
  `weaponGaugeTexts`) — the same function the grid card (`inventory/ui/Tooltip`) draws its gauges from. Never compute
  a weapon stat line here: the 기업 거래 screen shows this card, so a copy makes the same gun read differently in the
  bag and at the trade desk. — `hud/ItemTip.ts` (`weaponRows`)
- Item hover cards anchor bottom-right of the cursor; an element opts into top-left with `data-tip-anchor="left"`
  (`TIP_ANCHOR_ATTR`). ItemTip hides when its chip leaves the DOM or a tooltip is pinned. — `hud/ItemTip.ts`
- The card owns the `.itip-` prefix (`.itip-head` / `-name` / `-sub` / `-desc` / `-stats` / `-value`). It used `.it-`
  until 2026-09-17, when `hub/intel.css` turned out to own the same prefix and its global
  `.it-head { align-items: flex-end }` right-aligned the card's 이름 / 종류 wherever the card was shown; both sides
  were renamed (hub took `.his-`) and `scripts/check-css-prefixes.mjs` now fails the build on a repeat.
- Independently of that, `.item-tip` pins its own text flow (`text-align`, `direction`) and its head's flex axes
  (`align-items: stretch`, `justify-content: flex-start`): the card hangs off `#ui-root`, so it must look the same
  from every screen and cannot rely on a foreign stylesheet to leave it alone. — `styles/base.css`
- XP readouts go through `formatCompactNumber` / `formatCompactSigned` (`shared/numberFormat`), both sides of an
  `x / y` pair; counts, weights, durability, ammo, percentages and times stay exact. — `menus/RewardsBlock.ts`
- UI timing constants (fade holds, typing reveal speed, poll intervals) live in the component; gameplay numbers come
  from `@/shared` constants backed by `data/*.csv`.
- **Intended**: in windowed mode on several monitors the cursor can leave the game window while a screen is open (the price
  of using the real OS cursor). There is no sensitivity setting.
- **Intended widths**: the corp desk hides its right-hand grid below 1240 px, and the ship Tab screen wants 1600 px or more.
- **No voice chat** (2026-09-14 user decision, old A-6). The squadmate volume slider and mute in the friends column
  (`menus/social/SocialColumn.ts`) are UI only (`SQUAD_VOICE_DEFAULT`) and nobody reads them.
- **Intended**: opening the messenger never focuses its text field (`ChatTab.onShow`). The panel is toggled with a
  `Keys.INVITE` tap over the ship HUD, so the field takes focus only from a click or right after a send — an automatic
  focus would swallow the next key press. — `menus/messenger/ChatTab.ts`

## Decisions

Choices made against an alternative that may be proposed again — the choice, then what was rejected and why. Overturned → edit
the line; a choice with nothing left to reject → delete it. Everything else about a change lives in `git log`.

- **The real OS cursor under pointer lock** (Phase 10 rollback). Rejected: a virtual cursor.
- **Hold keycap = chevron inside the top edge.** Rejected: accent border, wobble.
- **Extraction result drops `다시 배치 (같은 시드)`; death result's lost loot = the raid's peak carried value.**
- **In the ship `타이틀로` / `게임 종료` are a tap** (nothing to lose); `파티 떠나기` keeps the hold.
- **No native `<select>`** — the drawn `shared/dropdown.ts`.
- **Numbers abbreviate from 10,000, truncated** (`10.0k`, `1.00m`). Rejected: `k` from 1,000; rounding; abbreviating counts / weights.
- **Liftoff hides every remaining HUD element.** Rejected: hiding from boarding.
- **The squad list never draws my row.** Rejected: keeping it in the raid.
- **Android launch-slot card = the full body.** Rejected: a face-only portrait.
- **Weapon panel dims for anything non-primary in hand; melee does not dim it.** Rejected: T quick use only.
- **Inventory credits as text** (`n C`), not the currency chip.
- **The 창고 upgrade modal is housing's `UpgradeModal`, reached via `HousingRef.openStorageUpgrade()`.** Rejected: a second modal; moving
  the button to ship management.
- **The animation restart idiom is accepted** (see Rules). Rejected: twin `@keyframes` on the hot path or at all 19 sites; a
  `ui/dom.restartAnim` helper (cannot work — see `docs/PERF.md`).
- **Chat height by CSS `calc()` + `column-reverse`.** Rejected: deferring or batching the measurement (a forced layout survives).

## Recent changes

Last 5 only — older: `git log -- src/ui`.
- 2026-09-21 — The crosshair reload ring freezes instead of lying while a reload is **held** (`weapon:reloadPaused` / `Resumed`, `.reload.paused`), and `hud/HealGauge` gained the right-button ally hold plus the `.heal-ally` chip that names the squadmate the button would treat (dim `아군 없음` when nobody is valid).
- 2026-09-20 — Code comments in `*.css` translated to English (`docs/TODO.md` B-65 — the file type §4.1's pass had filtered out; 1,335 lines in 34 stylesheets tree-wide). Korean on-screen labels, csv names and decision headings kept verbatim; no selector, class name, custom property or `content:` string touched, proved by stripping every comment from both sides and comparing the whole text.
- 2026-09-20 — The animation-restart idiom (`remove → void offsetWidth → add`, 19 sites in 13 `hud/` files) is an **intended limit** now, not a to-do: the user declined the twin-`@keyframes` cure and accepted the extra flush on a flash frame (was `docs/TODO.md` B-68 · B-69; `## Rules`, `## Decisions`). No code change — the smoke's `KNOWN_IDIOM` ratchet stays.
- 2026-09-20 — The toast stack stops forcing a layout inside the frame during the tutorial: `hud/Notifications` measured `.tut-controls` with `getBoundingClientRect` **every frame** while that panel was up (§4.2; counted at 180 reads in 180 frames). It now measures from a `ResizeObserver` on the panel plus the window `resize` — both run after layout, outside `Engine.frame` — and `update()` only re-finds the panel. `scripts/smoke-layout-reads.mjs` grew a fourth window (tutorial frames with the panel up) that fails on the old code and passes on the new.
- 2026-09-20 — `docs/PERF.md` perf Phase B: the HUD reads no layout inside a frame, and a smoke counts it. `hud/ChatLog` stopped measuring a row per line (a `column-reverse` scroller pins its own bottom, the closed height is a `calc()`), a chat row's first layout is paid at boot, and `hud/Detection` · `hud/ScanReveal` build their pillar pools on `world:ready` instead of on the first corpse. S4's android first-contact frame: js 17.9 → 15.5 ms, spike frames 1 → 0 (twice). The animation-restart `offsetWidth` idiom was swept into a `dom.restartAnim` helper in the same pass and **reverted the same day** — it cannot replay a finished or a descendant animation; it is a listed exception in the smoke instead (an intended limit — `## Rules` above).